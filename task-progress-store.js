'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isValidRunId } = require('./task-protocol');
const Activity = require('./renderer/activity-stream');
const Output = require('./renderer/assistant-output');

const VERSION = 1;
const copy = value => JSON.parse(JSON.stringify(value));
const validEpoch = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

// Keep this small compatibility mapping aligned with renderer/app.js:
// activityEventsForClaudeEvent. Output always receives the original event.
function activityEventsForClaudeEvent(event, activityState = null) {
  const content = event.type === 'user' && event.message && event.message.content;
  if (typeof content !== 'string' || !/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/i.test(content)) return [event];
  const read = name => {
    const match = content.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return match ? match[1].trim() : '';
  };
  const taskId = read('task-id');
  const knownTask = taskId && activityState && activityState.items.find(item => item.taskId === taskId);
  const toolUseId = read('tool-use-id') || (knownTask && knownTask.toolUseId) || (taskId ? `legacy-task:${taskId}` : '');
  if (!toolUseId) return [event];
  const status = read('status').toLowerCase(), result = read('result');
  const events = [{ type: 'system', subtype: 'task_notification', tool_use_id: toolUseId,
    task_id: taskId || null, status: status || 'completed', summary: read('summary') }];
  if (result && !['running', 'pending'].includes(status)) events.push({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId,
      content: result, is_error: ['failed', 'error', 'killed'].includes(status) }] },
  });
  return events;
}

class TaskProgressStore {
  constructor(options = {}) {
    if (typeof options.rootDir !== 'string' || !options.rootDir) throw new TypeError('TaskProgressStore requires rootDir');
    this.rootDir = path.resolve(options.rootDir);
    this.flushIntervalMs = Number.isFinite(options.flushIntervalMs) && options.flushIntervalMs >= 0 ? options.flushIntervalMs : 2000;
    // Inject the promise-based fs interface for failure/ordering tests.
    this.io = options.fs || fs.promises;
    this.logger = options.logger || console;
    this.entries = new Map();
    this.deleted = new Set();
    this.removing = new Map();
    this.timer = null;
    this.timerDue = 0;
    this.closed = false;
    this.closing = null;
    this.flushing = null;
  }

  _path(runId) {
    if (!isValidRunId(runId)) throw new TypeError('Invalid progress runId');
    return path.join(this.rootDir, `${runId}.json`);
  }

  _warn(error) {
    try { this.logger.warn('[task-progress-store] Progress persistence failed:', error.message); } catch (_) {}
  }

  async _read(runId) {
    let saved;
    try { saved = JSON.parse(await this.io.readFile(this._path(runId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (saved?.version !== VERSION || saved.runId !== runId || !validEpoch(saved.epoch)
        || !Number.isSafeInteger(saved.seq) || saved.seq < 0 || !saved.activity || !saved.output) {
      throw new Error('Invalid task progress snapshot');
    }
    return saved;
  }

  _entry(runId) {
    let entry = this.entries.get(runId);
    if (!entry) {
      entry = { runId, loaded: false, queue: [], processing: null, writing: null,
        epoch: null, seq: 0, deliverySeq: 0, revision: 0, dirty: false, terminal: false, terminalEvent: null, retiredEpochs: new Set() };
      this.entries.set(runId, entry);
    }
    return entry;
  }

  async _hydrate(entry) {
    if (entry.loaded) return;
    const saved = await this._read(entry.runId);
    const startedAt = Date.parse(entry.queue[0]?.emittedAt);
    entry.activity = Activity.hydrate(saved?.activity || (Number.isFinite(startedAt) ? { startedAt } : undefined));
    entry.output = Output.createState(saved?.output);
    // Progress is never a second authority for the final answer.
    entry.output.final = ''; entry.output.finalMessageId = null; entry.output.answers = [];
    entry.epoch = saved?.epoch || null; entry.seq = saved?.seq || 0;
    entry.deliverySeq = Number.isSafeInteger(saved?.deliverySeq) ? saved.deliverySeq : entry.seq;
    entry.terminal = saved?.terminal === true || /^(complete|error)$/.test(saved?.activity?.phase || '');
    entry.terminalEvent = saved?.terminalEvent?.type === 'job-done' && !Output.owner(saved.terminalEvent) ? saved.terminalEvent : null;
    entry.retiredEpochs = new Set((saved?.retiredEpochs || []).filter(validEpoch));
    entry.loaded = true;
  }

  _apply(entry, envelope) {
    if (entry.epoch === envelope.epoch && envelope.seq <= entry.seq || entry.retiredEpochs.has(envelope.epoch)) return;
    if (entry.epoch !== envelope.epoch) {
      if (entry.epoch) entry.retiredEpochs.add(entry.epoch);
      entry.epoch = envelope.epoch;
    }
    entry.seq = envelope.seq; entry.revision++; entry.dirty = true;
    entry.deliverySeq = Number.isSafeInteger(envelope.payload.event.relay_stream_seq)
      ? envelope.payload.event.relay_stream_seq : envelope.seq;
    // A late child notification cannot reopen a finished root run.
    if (entry.terminal) return;
    const event = envelope.payload.event;
    if (event.type === 'system' && event.subtype === 'relay_user_input') return;
    const previousOrder = entry.output.eventOrder;
    Output.ingest(entry.output, event);
    if (entry.output.eventOrder === previousOrder) return;
    const child = !!Output.owner(event);
    if (child && (['result', 'job-done', 'stderr', 'raw'].includes(event.type)
        || event.type === 'system' && event.subtype === 'init')) return;
    if (!(child && event.type === 'stream_event')) {
      for (const [index, activityEvent] of activityEventsForClaudeEvent(event, entry.activity).entries()) {
        Activity.ingest(entry.activity, { ...activityEvent, presentation_order: entry.output.eventOrder + index / 1000 });
      }
    }
    if (event.type === 'job-done') {
      Activity.finish(entry.activity, event.error || null, event);
      entry.output.status = entry.activity.phase === 'error' ? 'error' : 'complete';
      entry.terminal = true;
      // A terminal event may be the only carrier of its finalResult. Preserve
      // that receipt for ledger-confirmed recovery, without promoting it here.
      entry.terminalEvent = copy(event);
    }
  }

  _process(entry) {
    if (entry.processing) return entry.processing;
    const processing = (async () => {
      if (entry.deleted) return;
      await this._hydrate(entry);
      while (!entry.deleted && entry.queue.length) {
        // Remove only after successful reduction; a read failure must retain its batch.
        this._apply(entry, entry.queue[0]); entry.queue.shift();
      }
    })();
    entry.processing = processing;
    return processing.finally(() => {
      if (entry.processing === processing) entry.processing = null;
      if (!entry.deleted && (entry.dirty || entry.queue.length)) this._schedule(entry.terminal ? 0 : this.flushIntervalMs);
    });
  }

  observe(envelopes) {
    if (this.closed) return false;
    if (!Array.isArray(envelopes)) throw new TypeError('Progress envelopes must be an array');
    const touched = new Set();
    for (const envelope of envelopes) {
      if (!isValidRunId(envelope?.runId) || !validEpoch(envelope.epoch) || !Number.isSafeInteger(envelope.seq)
          || envelope.seq < 1 || !envelope.payload?.event || typeof envelope.payload.event.type !== 'string') continue;
      if (this.deleted.has(envelope.runId)) continue;
      const entry = this._entry(envelope.runId);
      entry.queue.push(copy(envelope)); touched.add(entry);
    }
    for (const entry of touched) void this._process(entry).catch(error => this._warn(error));
    return true;
  }

  _snapshot(entry) {
    return { version: VERSION, displayOnly: true, runId: entry.runId, epoch: entry.epoch, seq: entry.seq,
      deliverySeq: entry.deliverySeq, terminal: entry.terminal, terminalEvent: copy(entry.terminalEvent), retiredEpochs: [...entry.retiredEpochs],
      activity: Activity.serialize(entry.activity), output: Output.serialize(entry.output) };
  }

  async load(runId) {
    this._path(runId);
    if (this.deleted.has(runId)) return null;
    const entry = this.entries.get(runId);
    if (entry) {
      await this._process(entry);
      if (this.deleted.has(runId)) return null;
      return entry.epoch ? copy(this._snapshot(entry)) : null;
    }
    const saved = await this._read(runId);
    if (!saved || this.deleted.has(runId)) return null;
    // Hydrate old reducer versions without caching every historical run in memory.
    const restored = { ...saved, activity: Activity.serialize(Activity.hydrate(saved.activity)), output: Output.serialize(Output.createState(saved.output)),
      displayOnly: true, deliverySeq: Number.isSafeInteger(saved.deliverySeq) ? saved.deliverySeq : saved.seq };
    restored.output.final = ''; restored.output.finalMessageId = null; restored.output.answers = [];
    return restored;
  }

  _schedule(delay) {
    if (this.closed || this.flushing) return;
    const due = Date.now() + delay;
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._flushOnce().catch(error => this._warn(error));
    }, delay);
    this.timer.unref?.();
  }

  async _atomicWrite(file, content) {
    await this.io.mkdir(this.rootDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await this.io.rename(temporary, file);
    } catch (error) {
      if (handle) { try { await handle.close(); } catch (_) {} }
      try { await this.io.rm(temporary, { force: true }); } catch (_) {}
      throw error;
    }
  }

  async _write(entry) {
    if (entry.writing) return entry.writing;
    if (entry.deleted || !entry.dirty) return;
    const revision = entry.revision;
    // The journal already sanitized individual events. Sanitizing this cumulative
    // snapshot would truncate long tasks to 1,000 items and lose earlier progress.
    const content = `${JSON.stringify(this._snapshot(entry))}\n`;
    const writing = (async () => {
      await this._atomicWrite(this._path(entry.runId), content);
      entry.dirty = entry.revision !== revision;
      if (entry.terminal && !entry.dirty && !entry.queue.length && this.entries.get(entry.runId) === entry) {
        this.entries.delete(entry.runId);
      }
    })();
    entry.writing = writing;
    try { await writing; }
    finally { if (entry.writing === writing) entry.writing = null; }
  }

  _flushOnce() {
    if (this.flushing) return this.flushing;
    const operation = (async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(async entry => {
        await this._process(entry); await this._write(entry);
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Task progress flush failed');
    })();
    let failed = false;
    this.flushing = operation.catch(error => { failed = true; throw error; }).finally(() => {
      this.flushing = null;
      const pending = [...this.entries.values()].filter(entry => entry.dirty || entry.queue.length);
      if (pending.length) this._schedule(!failed && pending.some(entry => entry.terminal) ? 0 : this.flushIntervalMs);
    });
    return this.flushing;
  }

  async flush() {
    do {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this._flushOnce();
    } while ([...this.entries.values()].some(entry => entry.dirty || entry.queue.length));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  remove(runId) {
    const file = this._path(runId);
    this.deleted.add(runId);
    if (this.removing.has(runId)) return this.removing.get(runId);
    const entry = this.entries.get(runId);
    if (entry) { entry.deleted = true; entry.queue.length = 0; this.entries.delete(runId); }
    const operation = (async () => {
      // Admission is tombstoned before awaiting either operation, so no new write
      // can start between waiting for the old rename and unlinking the final file.
      if (entry?.processing) await entry.processing.catch(() => {});
      if (entry?.writing) await entry.writing.catch(() => {});
      await this.io.rm(file, { force: true });
    })();
    const removing = operation.finally(() => this.removing.delete(runId));
    this.removing.set(runId, removing);
    return removing;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.closing) this.closing = Promise.all([this.flush(), ...this.removing.values()]).then(() => undefined)
      .catch(error => { this.closing = null; throw error; });
    return this.closing;
  }
}

module.exports = { TaskProgressStore, TASK_PROGRESS_VERSION: VERSION, activityEventsForClaudeEvent };
