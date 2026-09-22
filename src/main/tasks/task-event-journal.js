'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RUN_EVENT_SCHEMA_VERSION, isValidRunId } = require('./task-protocol');

const JOURNAL_META_SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EPOCHS = 8;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_ARRAY_ITEMS = 1000;
const MAX_OBJECT_KEYS = 1000;
const MAX_VALUE_DEPTH = 16;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_ARCHIVE_CACHE_EPOCHS = 2;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|password|passwd|passphrase|secret|token|session[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|x[-_]api[-_]?key|apikey|private[-_]?key|client[-_]?secret|cookie|set[-_]?cookie|credential|credentials)$/i;

class TaskEventJournalError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskEventJournalError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidEpoch(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function redactText(value) {
  let text = String(value);
  if (text.length > MAX_STRING_LENGTH) text = `${text.slice(0, MAX_STRING_LENGTH - 1)}…`;
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/(authorization\s*[:=]?\s*(?:bearer|basic)\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|api_key|apikey|token|key|secret)=)[^&\s#]+/ig, '$1[REDACTED]')
    .replace(/((?:^|\s)(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|CLIENT_SECRET)\s*=\s*)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(--(?:password|token|api-key|secret)(?:=|\s+))[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED CREDENTIAL]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED CREDENTIAL]');
}

function sanitizeEventValue(value, options = {}, state = null) {
  const current = state || { depth: 0, seen: new WeakSet(), key: '' };
  const key = String(current.key || '');
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || value == null || typeof value !== 'number' ? value : String(value);
  }
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return `[Binary ${value.byteLength} bytes]`;
  }
  if (value instanceof Error) {
    const output = {
      name: redactText(value.name || 'Error'),
      message: redactText(value.message || ''),
    };
    if (value.code != null) output.code = redactText(value.code);
    return output;
  }
  if (current.depth >= (options.maxDepth || MAX_VALUE_DEPTH)) return '[Truncated]';
  if (current.seen.has(value)) return '[Circular]';
  current.seen.add(value);

  let output;
  if (Array.isArray(value)) {
    output = [];
    const limit = Math.min(value.length, options.maxArrayItems || MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      const item = sanitizeEventValue(value[index], options, {
        depth: current.depth + 1,
        seen: current.seen,
        key: '',
      });
      output.push(item === undefined ? null : item);
    }
    if (value.length > limit) output.push(`[Truncated ${value.length - limit} items]`);
  } else {
    output = {};
    const keys = Object.keys(value).slice(0, options.maxObjectKeys || MAX_OBJECT_KEYS);
    for (const objectKey of keys) {
      if (UNSAFE_OBJECT_KEYS.has(objectKey)) continue;
      const item = sanitizeEventValue(value[objectKey], options, {
        depth: current.depth + 1,
        seen: current.seen,
        key: objectKey,
      });
      if (item !== undefined) output[objectKey] = item;
    }
    if (Object.keys(value).length > keys.length) output._truncatedKeys = true;
  }
  current.seen.delete(value);
  return output;
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = crypto.randomBytes(6).toString('hex');
  const temporary = `${file}.${process.pid}.${suffix}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function eventLine(event) {
  return `${JSON.stringify(event)}\n`;
}

function positiveLimit(value, fallback, allowInfinity = false) {
  if (allowInfinity && value === Infinity) return Infinity;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

class TaskEventJournal {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || typeof options.rootDir !== 'string') {
      throw new TaskEventJournalError(
        'INVALID_JOURNAL_OPTIONS',
        'TaskEventJournal requires a rootDir',
      );
    }
    const epoch = options.epoch == null ? crypto.randomUUID() : String(options.epoch);
    if (!isValidEpoch(epoch)) {
      throw new TaskEventJournalError('INVALID_EPOCH', `Invalid task event epoch: ${epoch}`);
    }

    this.rootDir = path.resolve(options.rootDir);
    this.epochsDir = path.join(this.rootDir, 'epochs');
    this.epoch = epoch;
    this.journalPath = path.join(this.epochsDir, `${epoch}.jsonl`);
    this.metaPath = path.join(this.epochsDir, `${epoch}.meta.json`);
    this.maxEvents = positiveLimit(options.maxEvents, DEFAULT_MAX_EVENTS);
    this.maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEpochs = positiveLimit(options.maxEpochs, DEFAULT_MAX_EPOCHS);
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.logger = options.logger || console;
    this._lastSeq = 0;
    this._ackSeq = 0;
    this._compactedThroughSeq = 0;
    this._eventCount = 0;
    this._byteLength = 0;
    this._updatedAt = null;
    this._events = [];
    this._archiveCache = new Map();
    this._archiveCacheBytes = 0;

    fs.mkdirSync(this.epochsDir, { recursive: true });
    this._load();
    this.pruneEpochs({ maxEpochs: this.maxEpochs });
  }

  get lastSeq() { return this._lastSeq; }
  get ackSeq() { return this._ackSeq; }
  get compactedThroughSeq() { return this._compactedThroughSeq; }
  get eventCount() { return this._eventCount; }

  _warn(message, error) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[task-event-journal] ${message}${error ? `: ${error.message}` : ''}`);
      }
    } catch (_) {}
  }

  _timestamp(explicit) {
    const value = explicit === undefined ? this.now() : explicit;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TaskEventJournalError('INVALID_TIMESTAMP', `Invalid timestamp: ${String(value)}`);
    }
    return date.toISOString();
  }

  _readMeta() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (!meta || meta.schemaVersion !== JOURNAL_META_SCHEMA_VERSION || meta.epoch !== this.epoch) {
        throw new Error('unsupported or mismatched metadata');
      }
      return meta;
    } catch (error) {
      if (error && error.code !== 'ENOENT') this._warn('ignoring corrupt metadata', error);
      return null;
    }
  }

  _parseJournal(options = {}) {
    let content;
    try {
      content = fs.readFileSync(this.journalPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { events: [], content: '', damagedTail: false, missingFinalNewline: false };
      }
      throw error;
    }
    if (!content) return { events: [], content: '', damagedTail: false, missingFinalNewline: false };

    const events = [];
    const lines = content.split('\n');
    let damagedTail = false;
    let previousSeq = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
        this._validateStoredEvent(event);
        if (previousSeq != null && event.seq !== previousSeq + 1) {
          throw new Error(`non-contiguous sequence ${event.seq} after ${previousSeq}`);
        }
      } catch (error) {
        damagedTail = true;
        if (options.warn !== false) this._warn(`discarding damaged journal tail at line ${index + 1}`, error);
        break;
      }
      events.push(event);
      previousSeq = event.seq;
    }
    return {
      events,
      content,
      damagedTail,
      // A complete JSON record may still be missing its final newline after a crash. Repair it
      // before the next append, otherwise two valid objects would be concatenated into one line.
      missingFinalNewline: !content.endsWith('\n'),
    };
  }

  _validateStoredEvent(event, epoch = this.epoch) {
    if (!isPlainObject(event)) throw new Error('event is not an object');
    if (event.schemaVersion !== RUN_EVENT_SCHEMA_VERSION) throw new Error('unsupported event schema');
    if (event.epoch !== epoch) throw new Error('event epoch mismatch');
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error('invalid event sequence');
    if (typeof event.type !== 'string' || !event.type || event.type.length > MAX_EVENT_TYPE_LENGTH) {
      throw new Error('invalid event type');
    }
    if (typeof event.emittedAt !== 'string' || !Number.isFinite(Date.parse(event.emittedAt))) {
      throw new Error('invalid event timestamp');
    }
  }

  _load() {
    const meta = this._readMeta();
    const parsed = this._parseJournal();
    const events = parsed.events;
    this._events = events;
    if (parsed.damagedTail || parsed.missingFinalNewline) {
      writeFileAtomic(this.journalPath, events.map(eventLine).join(''));
    }

    const firstSeq = events.length ? events[0].seq : null;
    const eventLastSeq = events.length ? events[events.length - 1].seq : 0;
    // With retained records, JSONL is authoritative. A metadata value ahead of its last line is
    // stale/corrupt and must not create a sequence gap. An empty journal legitimately relies on
    // metadata after compaction removed every acknowledged record.
    this._lastSeq = events.length
      ? eventLastSeq
      : Math.max(0, Number.isSafeInteger(meta && meta.lastSeq) ? meta.lastSeq : 0);
    this._ackSeq = Math.min(
      this._lastSeq,
      Math.max(0, Number.isSafeInteger(meta && meta.ackSeq) ? meta.ackSeq : 0),
    );
    this._compactedThroughSeq = firstSeq == null
      ? this._lastSeq
      : Math.max(0, firstSeq - 1);
    this._eventCount = events.length;
    this._byteLength = Buffer.byteLength(events.map(eventLine).join(''));
    this._updatedAt = meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : null;
    this._writeMeta();
  }

  _metadata() {
    return {
      schemaVersion: JOURNAL_META_SCHEMA_VERSION,
      epoch: this.epoch,
      lastSeq: this._lastSeq,
      ackSeq: this._ackSeq,
      compactedThroughSeq: this._compactedThroughSeq,
      eventCount: this._eventCount,
      byteLength: this._byteLength,
      updatedAt: this._updatedAt,
    };
  }

  _writeMeta() {
    this._updatedAt = this._timestamp();
    writeJsonAtomic(this.metaPath, this._metadata());
  }

  metadata() {
    return JSON.parse(JSON.stringify(this._metadata()));
  }

  _prepare(input, options, seq) {
    if (!isPlainObject(input)) {
      throw new TaskEventJournalError('INVALID_EVENT', 'Task event must be an object');
    }
    if (typeof input.type !== 'string' || !input.type.trim()
      || input.type.length > MAX_EVENT_TYPE_LENGTH) {
      throw new TaskEventJournalError('INVALID_EVENT_TYPE', 'Task event type is invalid');
    }
    if (input.runId != null && !isValidRunId(input.runId)) {
      throw new TaskEventJournalError('INVALID_RUN_ID', `Invalid run id: ${String(input.runId)}`);
    }
    if (input.revision != null
      && (!Number.isSafeInteger(input.revision) || input.revision < 1)) {
      throw new TaskEventJournalError('INVALID_RUN_REVISION', 'Run revision must be positive');
    }

    const sanitized = sanitizeEventValue(input);
    delete sanitized.schemaVersion;
    delete sanitized.epoch;
    delete sanitized.seq;
    delete sanitized.emittedAt;
    const envelope = {
      ...sanitized,
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      epoch: this.epoch,
      seq,
      type: input.type.trim(),
      emittedAt: this._timestamp(options.at),
    };
    // Stable envelope fields remain first on disk, which also makes manual diagnostics easier.
    const stored = {
      schemaVersion: envelope.schemaVersion,
      epoch: envelope.epoch,
      seq: envelope.seq,
      type: envelope.type,
      ...(envelope.runId == null ? {} : { runId: envelope.runId }),
      ...(envelope.revision == null ? {} : { revision: envelope.revision }),
      emittedAt: envelope.emittedAt,
      ...Object.fromEntries(Object.entries(envelope).filter(([key]) => ![
        'schemaVersion', 'epoch', 'seq', 'type', 'runId', 'revision', 'emittedAt',
      ].includes(key))),
    };
    return stored;
  }

  _commit(storedEvents) {
    if (!storedEvents.length) return [];
    const content = storedEvents.map(eventLine).join('');
    let descriptor = null;
    try {
      descriptor = fs.openSync(this.journalPath, 'a');
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch (_) {}
      }
      throw new TaskEventJournalError('JOURNAL_APPEND_FAILED', error.message);
    }

    this._lastSeq = storedEvents[storedEvents.length - 1].seq;
    this._events.push(...storedEvents);
    this._eventCount += storedEvents.length;
    this._byteLength += Buffer.byteLength(content);
    try { this._writeMeta(); }
    catch (error) { this._warn('metadata update failed after committed append', error); }

    if (this._eventCount > this.maxEvents || this._byteLength > this.maxBytes) {
      // 高水位触发后一次降到 75% 低水位，避免达到上限后每个 token 都同步重写整本 JSONL。
      try {
        this.compact({
          dropAcknowledged: false,
          maxEvents: Math.max(1, Math.floor(this.maxEvents * 0.75)),
          maxBytes: Math.max(1024, Math.floor(this.maxBytes * 0.75)),
        });
      }
      catch (error) { this._warn('automatic retention failed after committed append', error); }
    }
    return JSON.parse(JSON.stringify(storedEvents));
  }

  append(input = {}, options = {}) {
    return this._commit([this._prepare(input, options, this._lastSeq + 1)])[0];
  }

  // 流式事件以小批次一次写入/一次 fsync；崩溃时仍只有“整批存在或尾部被恢复”的语义，
  // 同时避免 Windows 主进程为每个 token 同步刷盘两次。
  appendMany(inputs = [], options = {}) {
    if (!Array.isArray(inputs)) {
      throw new TaskEventJournalError('INVALID_EVENT_BATCH', 'Task event batch must be an array');
    }
    const stored = inputs.map((input, index) => this._prepare(
      input,
      options,
      this._lastSeq + index + 1,
    ));
    return this._commit(stored);
  }

  replay(input = {}) {
    const options = Number.isSafeInteger(input) ? { sinceSeq: input } : (input || {});
    if (!isPlainObject(options)) {
      throw new TaskEventJournalError('INVALID_REPLAY_OPTIONS', 'Replay options must be an object');
    }
    const requestedEpoch = options.epoch == null ? this.epoch : String(options.epoch);
    const sinceSeq = options.sinceSeq == null ? 0 : options.sinceSeq;
    if (!isValidEpoch(requestedEpoch)) {
      throw new TaskEventJournalError('INVALID_EPOCH', `Invalid task event epoch: ${requestedEpoch}`);
    }
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
      throw new TaskEventJournalError('INVALID_SEQUENCE', 'sinceSeq must be a non-negative integer');
    }
    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0
      ? options.limit
      : DEFAULT_MAX_EVENTS;
    if (requestedEpoch !== this.epoch) {
      return {
        epoch: this.epoch,
        sinceSeq,
        lastSeq: this._lastSeq,
        ackSeq: this._ackSeq,
        compactedThroughSeq: this._compactedThroughSeq,
        resetRequired: true,
        hasMore: false,
        events: [],
      };
    }

    const available = this._events.filter((event) => (
      event.seq > sinceSeq && (!options.runId || event.runId === options.runId)
    ));
    const events = available.slice(0, limit);
    return {
      epoch: this.epoch,
      sinceSeq,
      lastSeq: this._lastSeq,
      ackSeq: this._ackSeq,
      compactedThroughSeq: this._compactedThroughSeq,
      resetRequired: sinceSeq < this._compactedThroughSeq || sinceSeq > this._lastSeq,
      hasMore: available.length > events.length,
      events: JSON.parse(JSON.stringify(events)),
    };
  }

  // Archived epochs must never be reopened as writable journals: construction
  // repairs tails, updates metadata and prunes other epochs. Keep a bounded
  // read-only line index instead. Pagination parses only the selected page.
  _readArchivedEpoch(epoch) {
    const file = path.join(this.epochsDir, `${epoch}.jsonl`);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TaskEventJournalError('INVALID_ARCHIVED_JOURNAL', 'Archived event journal must be a regular file');
    }
    if (stat.size > MAX_ARCHIVE_BYTES) {
      throw new TaskEventJournalError('ARCHIVED_JOURNAL_TOO_LARGE', 'Archived event journal exceeds the recovery size limit');
    }
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this._archiveCache.get(epoch);
    if (cached?.signature === signature) {
      this._archiveCache.delete(epoch); this._archiveCache.set(epoch, cached);
      return cached;
    }
    if (cached) {
      this._archiveCacheBytes -= cached.bytes;
      this._archiveCache.delete(epoch);
    }
    const content = fs.readFileSync(file);
    if (content.length > MAX_ARCHIVE_BYTES) {
      throw new TaskEventJournalError('ARCHIVED_JOURNAL_TOO_LARGE', 'Archived event journal exceeds the recovery size limit');
    }
    const byRun = new Map();
    let firstSeq = null, lastSeq = 0, count = 0, damagedTail = false;
    for (let start = 0; start < content.length;) {
      const newline = content.indexOf(10, start);
      const end = newline < 0 ? content.length : newline;
      const text = content.toString('utf8', start, end);
      if (text.trim()) {
        let event;
        try {
          event = JSON.parse(text);
          this._validateStoredEvent(event, epoch);
          if (event.runId != null && !isValidRunId(event.runId)) throw new Error('invalid event run id');
          if (count && event.seq !== lastSeq + 1) throw new Error('non-contiguous event sequence');
        } catch (_) { damagedTail = true; break; }
        if (firstSeq == null) firstSeq = event.seq;
        lastSeq = event.seq; count++;
        if (event.runId) {
          if (!byRun.has(event.runId)) byRun.set(event.runId, []);
          byRun.get(event.runId).push({ seq: event.seq, start, end });
        }
      }
      start = end + 1;
    }
    const entry = { signature, content, byRun, firstSeq, lastSeq, damagedTail, bytes: content.length + count * 64 };
    while (this._archiveCache.size && (this._archiveCache.size >= MAX_ARCHIVE_CACHE_EPOCHS
        || this._archiveCacheBytes + entry.bytes > MAX_ARCHIVE_CACHE_BYTES)) {
      const oldest = this._archiveCache.keys().next().value;
      this._archiveCacheBytes -= this._archiveCache.get(oldest).bytes;
      this._archiveCache.delete(oldest);
    }
    if (entry.bytes <= MAX_ARCHIVE_CACHE_BYTES) {
      this._archiveCache.set(epoch, entry); this._archiveCacheBytes += entry.bytes;
    }
    return entry;
  }

  replayEpoch(options = {}) {
    if (!isPlainObject(options)) throw new TaskEventJournalError('INVALID_REPLAY_OPTIONS', 'Replay options must be an object');
    const epoch = options.epoch == null ? this.epoch : String(options.epoch);
    if (!isValidEpoch(epoch)) throw new TaskEventJournalError('INVALID_EPOCH', 'Invalid archived event epoch');
    if (epoch === this.epoch) return this.replay(options);
    if (!isValidRunId(options.runId)) throw new TaskEventJournalError('INVALID_RUN_ID', 'Archived replay requires a valid run id');
    const sinceSeq = options.sinceSeq == null ? 0 : options.sinceSeq;
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new TaskEventJournalError('INVALID_SEQUENCE', 'sinceSeq must be a non-negative integer');
    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : DEFAULT_MAX_EVENTS;
    const archived = this._readArchivedEpoch(epoch);
    if (!archived) return { epoch, sinceSeq, lastSeq: 0, ackSeq: 0, compactedThroughSeq: 0,
      resetRequired: true, missing: true, hasMore: false, events: [] };
    let meta = null;
    try {
      const file = path.join(this.epochsDir, `${epoch}.meta.json`);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed?.schemaVersion === JOURNAL_META_SCHEMA_VERSION && parsed.epoch === epoch) meta = parsed;
      }
    } catch (_) {} // Surviving JSONL records, not optional metadata, own their sequence.
    const lastSeq = archived.firstSeq == null && !archived.damagedTail
      ? Math.max(0, Number.isSafeInteger(meta?.lastSeq) ? meta.lastSeq : 0) : archived.lastSeq;
    const ackSeq = Math.min(lastSeq, Math.max(0, Number.isSafeInteger(meta?.ackSeq) ? meta.ackSeq : 0));
    const compactedThroughSeq = archived.firstSeq == null ? lastSeq : archived.firstSeq - 1;
    const entries = archived.byRun.get(options.runId) || [];
    let low = 0, high = entries.length;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (entries[middle].seq <= sinceSeq) low = middle + 1; else high = middle; }
    const page = entries.slice(low, low + limit);
    return { epoch, sinceSeq, lastSeq, ackSeq, compactedThroughSeq,
      resetRequired: archived.damagedTail || sinceSeq < compactedThroughSeq || sinceSeq > lastSeq,
      missing: false, damagedTail: archived.damagedTail,
      hasMore: low + page.length < entries.length,
      events: page.map(entry => JSON.parse(archived.content.toString('utf8', entry.start, entry.end))) };
  }

  ack(input, options = {}) {
    const seq = isPlainObject(input) ? input.seq : input;
    const epoch = isPlainObject(input) ? input.epoch : options.epoch;
    if (epoch != null && epoch !== this.epoch) {
      throw new TaskEventJournalError('EPOCH_MISMATCH', 'Cannot acknowledge a different epoch');
    }
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TaskEventJournalError('INVALID_SEQUENCE', 'Ack sequence must be non-negative');
    }
    const acknowledged = Math.min(seq, this._lastSeq);
    if (acknowledged > this._ackSeq) {
      this._ackSeq = acknowledged;
      this._writeMeta();
    }
    if ((isPlainObject(input) && input.compact === true) || options.compact === true) {
      this.compact();
    }
    return this.metadata();
  }

  compact(options = {}) {
    if (!isPlainObject(options)) {
      throw new TaskEventJournalError('INVALID_COMPACT_OPTIONS', 'Compact options must be an object');
    }
    const maxEvents = positiveLimit(options.maxEvents, this.maxEvents);
    const maxBytes = positiveLimit(options.maxBytes, this.maxBytes);
    const dropAcknowledged = options.dropAcknowledged !== false;
    let retained = this._events;
    if (dropAcknowledged && this._ackSeq > 0) {
      retained = retained.filter((event) => event.seq > this._ackSeq);
    }
    if (retained.length > maxEvents) retained = retained.slice(retained.length - maxEvents);

    let byteLength = retained.reduce((total, event) => total + Buffer.byteLength(eventLine(event)), 0);
    while (retained.length && byteLength > maxBytes) {
      byteLength -= Buffer.byteLength(eventLine(retained[0]));
      retained.shift();
    }

    const firstRetainedSeq = retained.length ? retained[0].seq : this._lastSeq + 1;
    this._compactedThroughSeq = Math.max(
      this._compactedThroughSeq,
      Math.min(this._lastSeq, firstRetainedSeq - 1),
    );
    const content = retained.map(eventLine).join('');
    writeFileAtomic(this.journalPath, content);
    this._events = retained;
    this._eventCount = retained.length;
    this._byteLength = Buffer.byteLength(content);
    this._writeMeta();
    return {
      epoch: this.epoch,
      lastSeq: this._lastSeq,
      ackSeq: this._ackSeq,
      compactedThroughSeq: this._compactedThroughSeq,
      retained: this._eventCount,
    };
  }

  pruneEpochs(options = {}) {
    const maxEpochs = positiveLimit(options.maxEpochs, this.maxEpochs);
    let entries = [];
    try {
      entries = fs.readdirSync(this.epochsDir, { withFileTypes: true });
    } catch (error) {
      this._warn('could not scan epoch journals', error);
      return { removed: [] };
    }
    const epochMap = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const suffix = entry.name.endsWith('.meta.json')
        ? '.meta.json'
        : (entry.name.endsWith('.jsonl') ? '.jsonl' : null);
      if (!suffix) continue;
      const epoch = entry.name.slice(0, -suffix.length);
      if (!isValidEpoch(epoch)) continue;
      const file = path.join(this.epochsDir, entry.name);
      const previous = epochMap.get(epoch) || { epoch, updatedAt: 0 };
      let updatedAt = previous.updatedAt;
      if (suffix === '.meta.json') {
        try {
          const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
          updatedAt = Math.max(updatedAt, Date.parse(meta.updatedAt) || fs.statSync(file).mtimeMs);
        } catch (_) {
          try { updatedAt = Math.max(updatedAt, fs.statSync(file).mtimeMs); } catch (_) {}
        }
      } else {
        try { updatedAt = Math.max(updatedAt, fs.statSync(file).mtimeMs); } catch (_) {}
      }
      epochMap.set(epoch, { epoch, updatedAt });
    }
    const epochs = [...epochMap.values()];
    epochs.sort((left, right) => right.updatedAt - left.updatedAt || right.epoch.localeCompare(left.epoch));
    // The active epoch always consumes one retention slot, even before its first JSONL append.
    const retained = new Set([this.epoch]);
    for (const entry of epochs) {
      if (retained.size >= maxEpochs) break;
      retained.add(entry.epoch);
    }
    const removed = [];
    for (const entry of epochs) {
      if (retained.has(entry.epoch)) continue;
      for (const suffix of ['.jsonl', '.meta.json']) {
        try { fs.rmSync(path.join(this.epochsDir, `${entry.epoch}${suffix}`), { force: true }); }
        catch (error) { this._warn(`could not prune epoch ${entry.epoch}`, error); }
      }
      removed.push(entry.epoch);
    }
    return { removed };
  }
}

module.exports = {
  JOURNAL_META_SCHEMA_VERSION,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EPOCHS,
  TaskEventJournal,
  TaskEventJournalError,
  isValidEpoch,
  redactText,
  sanitizeEventValue,
};
