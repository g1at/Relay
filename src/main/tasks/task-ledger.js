'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  RUN_SCHEMA_VERSION,
  RUN_STATES,
  RUN_HEALTH,
  EXECUTOR_STATES,
  RUN_EVENT_TYPES,
  isRunState,
  isTerminalState,
  isValidRunId,
  assertTransition,
  validateRunRecord,
} = require('./task-protocol');

const INDEX_SCHEMA_VERSION = 1;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class TaskLedgerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskLedgerError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(base, patch) {
  if (!isPlainObject(patch)) return jsonClone(patch);
  const output = isPlainObject(base) ? jsonClone(base) : {};
  for (const key of Object.keys(patch)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    output[key] = isPlainObject(value) && isPlainObject(output[key])
      ? mergeObjects(output[key], value)
      : jsonClone(value);
  }
  return output;
}

function stableJson(value) {
  return JSON.stringify(value);
}

// The temporary file lives beside the destination, so rename remains an atomic same-volume move.
// Unique names avoid collisions between a stale crash file and a new Relay process on Windows.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = crypto.randomBytes(6).toString('hex');
  const temporary = `${file}.${process.pid}.${suffix}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function runMeta(run) {
  return {
    runId: run.runId,
    revision: run.revision,
    kind: run.kind,
    title: run.title,
    state: run.state,
    health: run.health,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
  };
}

function compareRunsNewestFirst(left, right) {
  const leftAt = left.updatedAt || left.createdAt || '';
  const rightAt = right.updatedAt || right.createdAt || '';
  const byTime = rightAt.localeCompare(leftAt);
  if (byTime !== 0) return byTime;
  return right.runId.localeCompare(left.runId);
}

class TaskLedger {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || typeof options.rootDir !== 'string') {
      throw new TaskLedgerError('INVALID_LEDGER_OPTIONS', 'TaskLedger requires a rootDir');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.runsDir = path.join(this.rootDir, 'runs');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => crypto.randomUUID();
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.logger = options.logger || console;
    fs.mkdirSync(this.runsDir, { recursive: true });
    // 正常运行只读内存中的权威快照；磁盘 run 文件仍是崩溃恢复来源。
    // 旧实现每次 list() 都同步解析全部文件、每次进展都重写完整 index，长任务会阻塞主进程。
    this._runs = new Map();
    this._indexSignature = null;
    this._indexWriteTimer = null;
    this._indexDirty = false;
    this._bootstrapCache();
  }

  _timestamp(explicit) {
    const value = explicit === undefined ? this.now() : explicit;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TaskLedgerError('INVALID_TIMESTAMP', `Invalid timestamp: ${String(value)}`);
    }
    return date.toISOString();
  }

  _runPath(runId) {
    if (!isValidRunId(runId)) {
      throw new TaskLedgerError('INVALID_RUN_ID', `Invalid run id: ${String(runId)}`);
    }
    return path.join(this.runsDir, `${runId}.json`);
  }

  _warn(message, error) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[task-ledger] ${message}${error ? `: ${error.message}` : ''}`);
      }
    } catch (_) {}
  }

  _emit(run, previous) {
    if (!this.onChange) return;
    const event = {
      type: RUN_EVENT_TYPES.UPSERT,
      run: jsonClone(run),
      previous: previous ? jsonClone(previous) : null,
    };
    try {
      const pending = this.onChange(event);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => this._warn('onChange rejected', error));
      }
    } catch (error) {
      this._warn('onChange failed', error);
    }
  }

  _readRunFile(file) {
    let run;
    try {
      run = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateRunRecord(run);
    } catch (error) {
      throw new TaskLedgerError(
        'CORRUPT_RUN',
        `Could not read run file ${path.basename(file)}: ${error.message}`,
        { file },
      );
    }
    return run;
  }

  _scanRuns() {
    const runs = [];
    let names = [];
    try {
      names = fs.readdirSync(this.runsDir);
    } catch (error) {
      this._warn('could not scan runs directory', error);
      return runs;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        runs.push(this._readRunFile(path.join(this.runsDir, name)));
      } catch (error) {
        this._warn(`skipping ${name}`, error);
      }
    }
    return runs;
  }

  _statIndex() {
    try {
      const stat = fs.statSync(this.indexPath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch (_) { return null; }
  }

  _bootstrapCache() {
    const runs = this._scanRuns();
    this._runs = new Map(runs.map((run) => [run.runId, run]));
    this._repairIndexIfNeeded(runs);
    this._indexSignature = this._statIndex();
  }

  _refreshCacheIfIndexChanged() {
    const signature = this._statIndex();
    if (signature === this._indexSignature) return;
    // 只有外部修改/损坏 index 才走全盘恢复；Relay 自己的每次运行更新不会触发扫描。
    const runs = this._scanRuns();
    this._runs = new Map(runs.map((run) => [run.runId, run]));
    this._repairIndexIfNeeded(runs);
    this._indexSignature = this._statIndex();
  }

  _writeIndex(runs) {
    const items = [...runs].sort(compareRunsNewestFirst).map(runMeta);
    this._writeIndexItems(items);
    return items;
  }

  _writeIndexItems(items) {
    writeJsonAtomic(this.indexPath, {
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt: this._timestamp(),
      items,
    });
    this._indexSignature = this._statIndex();
  }

  _updateIndex(run) {
    this._runs.set(run.runId, jsonClone(run));
    this._indexDirty = true;
  }

  _flushIndex() {
    if (this._indexWriteTimer) {
      clearTimeout(this._indexWriteTimer);
      this._indexWriteTimer = null;
    }
    if (!this._indexDirty) return;
    this._writeIndex([...this._runs.values()]);
    this._indexDirty = false;
  }

  _scheduleIndexWrite() {
    if (this._indexWriteTimer) return;
    this._indexWriteTimer = setTimeout(() => {
      this._indexWriteTimer = null;
      if (!fs.existsSync(this.rootDir)) return;
      try { this._flushIndex(); }
      catch (error) { this._warn('could not flush index', error); }
    }, 250);
    if (this._indexWriteTimer.unref) this._indexWriteTimer.unref();
  }

  _repairIndexIfNeeded(runs) {
    const expected = [...runs].sort(compareRunsNewestFirst).map(runMeta);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (parsed && parsed.schemaVersion === INDEX_SCHEMA_VERSION
        && Array.isArray(parsed.items)
        && stableJson(parsed.items) === stableJson(expected)) return;
    } catch (_) {}
    try { this._writeIndex(runs); } catch (error) { this._warn('could not rebuild index', error); }
  }

  _persist(run, previous) {
    validateRunRecord(run);
    writeJsonAtomic(this._runPath(run.runId), run);
    // The run file is authoritative. A failed cache update must not turn a committed run write
    // into an apparent failure; list()/rebuildIndex() repairs it later.
    try {
      this._updateIndex(run);
      // 新任务必须立即出现在可恢复索引；终态必须在返回成功前稳定落盘。
      // 高频中间进展合并到 250ms 窗口，避免多任务每秒反复重写完整 index。
      if (!previous || isTerminalState(run.state)) this._flushIndex();
      else this._scheduleIndexWrite();
    } catch (error) {
      this._warn('could not update index', error);
    }
    this._emit(run, previous);
    return jsonClone(run);
  }

  create(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TaskLedgerError('INVALID_RUN', 'Run input must be an object');
    }
    const at = this._timestamp(input.createdAt);
    const runId = input.runId == null ? String(this.idFactory()) : String(input.runId);
    const state = input.state || RUN_STATES.QUEUED;
    if (!isRunState(state)) {
      throw new TaskLedgerError('INVALID_RUN_STATE', `Unknown run state: ${String(state)}`);
    }
    if (isTerminalState(state)) {
      throw new TaskLedgerError('USE_TERMINAL_API', 'A run cannot be created in a terminal state');
    }
    const file = this._runPath(runId);
    if (fs.existsSync(file)) {
      throw new TaskLedgerError('RUN_EXISTS', `Run already exists: ${runId}`);
    }

    const supplied = jsonClone(input);
    delete supplied.schemaVersion;
    delete supplied.revision;
    delete supplied.runId;
    const hasStarted = state !== RUN_STATES.QUEUED;
    const run = {
      ...supplied,
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      revision: 1,
      kind: input.kind || 'chat',
      trigger: input.trigger || 'user',
      title: input.title == null ? '' : String(input.title),
      priority: Number.isFinite(input.priority) ? input.priority : 50,
      state,
      phase: input.phase || state,
      health: input.health || RUN_HEALTH.OK,
      executorState: input.executorState
        || (hasStarted ? EXECUTOR_STATES.ACTIVE : EXECUTOR_STATES.IDLE),
      createdAt: at,
      queuedAt: input.queuedAt ? this._timestamp(input.queuedAt) : at,
      startedAt: input.startedAt
        ? this._timestamp(input.startedAt)
        : (hasStarted ? at : null),
      updatedAt: at,
      lastEventAt: input.lastEventAt ? this._timestamp(input.lastEventAt) : at,
      endedAt: null,
      progress: mergeObjects({ label: '', detail: null, lastEventAt: at }, input.progress || {}),
      waiting: input.waiting == null ? null : jsonClone(input.waiting),
      result: input.result == null ? null : jsonClone(input.result),
      recovery: mergeObjects({
        retryOf: null,
        continuationOf: null,
        sessionId: null,
        userMessageId: null,
        recoveryCount: 0,
      }, input.recovery || {}),
      metadata: isPlainObject(input.metadata) ? jsonClone(input.metadata) : {},
    };
    return this._persist(run, null);
  }

  get(runId) {
    this._runPath(runId); // validate before looking up the in-memory map
    const cached = this._runs.get(runId);
    if (cached) return jsonClone(cached);
    const file = this._runPath(runId);
    if (!fs.existsSync(file)) return null;
    const run = this._readRunFile(file);
    this._runs.set(run.runId, run);
    return jsonClone(run);
  }

  list(filters = {}) {
    this._refreshCacheIfIndexChanged();
    let runs = [...this._runs.values()];
    const requestedStates = filters.states || filters.state;
    if (requestedStates != null) {
      const states = new Set(Array.isArray(requestedStates) ? requestedStates : [requestedStates]);
      runs = runs.filter((run) => states.has(run.state));
    }
    if (filters.terminal === true) runs = runs.filter((run) => isTerminalState(run.state));
    if (filters.terminal === false) runs = runs.filter((run) => !isTerminalState(run.state));
    if (filters.kind != null) runs = runs.filter((run) => run.kind === filters.kind);
    runs = [...runs].sort(compareRunsNewestFirst);
    if (Number.isSafeInteger(filters.limit) && filters.limit >= 0) {
      runs = runs.slice(0, filters.limit);
    }
    return jsonClone(runs);
  }

  update(runId, patchOrUpdater, options = {}) {
    const current = this.get(runId);
    if (!current) throw new TaskLedgerError('RUN_NOT_FOUND', `Run not found: ${runId}`);
    if (isTerminalState(current.state)) {
      throw new TaskLedgerError('RUN_TERMINAL', `Run is already terminal: ${runId}`);
    }
    if (options.expectedRevision != null && options.expectedRevision !== current.revision) {
      throw new TaskLedgerError(
        'REVISION_CONFLICT',
        `Expected revision ${options.expectedRevision}, found ${current.revision}`,
        { expected: options.expectedRevision, actual: current.revision },
      );
    }

    let patch;
    if (typeof patchOrUpdater === 'function') {
      const draft = jsonClone(current);
      const returned = patchOrUpdater(draft);
      patch = returned === undefined ? draft : returned;
    } else {
      patch = patchOrUpdater;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TaskLedgerError('INVALID_RUN_PATCH', 'Run update must produce an object');
    }

    const next = mergeObjects(current, patch);
    next.schemaVersion = RUN_SCHEMA_VERSION;
    next.runId = current.runId;
    next.revision = current.revision;
    next.createdAt = current.createdAt;
    next.endedAt = null;
    if (!isRunState(next.state)) {
      throw new TaskLedgerError('INVALID_RUN_STATE', `Unknown run state: ${String(next.state)}`);
    }
    if (isTerminalState(next.state)) {
      throw new TaskLedgerError('USE_TERMINAL_API', 'Use terminal() to enter a terminal state');
    }
    assertTransition(current.state, next.state);

    // Do not create revisions and renderer events for an empty/idempotent update.
    if (stableJson(next) === stableJson(current)) return current;

    const at = this._timestamp(options.at);
    next.revision = current.revision + 1;
    next.updatedAt = at;
    next.lastEventAt = at;
    next.progress = mergeObjects(next.progress || {}, { lastEventAt: at });
    if (current.state === RUN_STATES.QUEUED && next.state !== RUN_STATES.QUEUED && !next.startedAt) {
      next.startedAt = at;
    }
    if (next.executorState === EXECUTOR_STATES.IDLE
      && [RUN_STATES.STARTING, RUN_STATES.RUNNING, RUN_STATES.WAITING_USER].includes(next.state)) {
      next.executorState = EXECUTOR_STATES.ACTIVE;
    }
    if (next.state === RUN_STATES.STOPPING && next.executorState === EXECUTOR_STATES.ACTIVE) {
      next.executorState = EXECUTOR_STATES.DRAINING;
    }
    if (next.state !== RUN_STATES.WAITING_USER) next.waiting = null;
    return this._persist(next, current);
  }

  terminal(runId, terminalState, details = {}, options = {}) {
    if (!isTerminalState(terminalState)) {
      throw new TaskLedgerError(
        'INVALID_TERMINAL_STATE',
        `Not a terminal run state: ${String(terminalState)}`,
      );
    }
    const current = this.get(runId);
    if (!current) throw new TaskLedgerError('RUN_NOT_FOUND', `Run not found: ${runId}`);

    // First terminal write wins. This is deliberately checked before optimistic concurrency,
    // so retrying an uncertain terminal write is safe and returns the committed record.
    if (isTerminalState(current.state)) return current;
    if (options.expectedRevision != null && options.expectedRevision !== current.revision) {
      throw new TaskLedgerError(
        'REVISION_CONFLICT',
        `Expected revision ${options.expectedRevision}, found ${current.revision}`,
        { expected: options.expectedRevision, actual: current.revision },
      );
    }
    assertTransition(current.state, terminalState);
    const supplied = isPlainObject(details) ? details : {};
    const next = mergeObjects(current, supplied);
    const at = this._timestamp(options.at || supplied.endedAt);
    next.schemaVersion = RUN_SCHEMA_VERSION;
    next.runId = current.runId;
    next.revision = current.revision + 1;
    next.state = terminalState;
    next.phase = supplied.phase || 'terminal';
    next.executorState = supplied.executorState || EXECUTOR_STATES.STOPPED;
    next.createdAt = current.createdAt;
    next.updatedAt = at;
    next.lastEventAt = at;
    next.endedAt = at;
    next.waiting = null;
    next.progress = mergeObjects(next.progress || {}, { lastEventAt: at });
    next.result = mergeObjects(current.result || {}, supplied.result || {});
    next.result.status = terminalState;
    return this._persist(next, current);
  }

  recover(options = {}) {
    const reason = options.reason == null ? 'Relay restarted' : String(options.reason);
    const retainQueued = options.retainQueued !== false;
    const at = this._timestamp(options.at);
    const result = {
      retainedQueued: [],
      interrupted: [],
      unchangedTerminal: [],
    };
    // Startup only consumes recovered active runs. Avoid copying completed
    // result bodies into an unused recovery response; preserve the public
    // default for callers which inspect unchangedTerminal.
    const runs = this.list(options.includeTerminal === false ? { terminal: false } : {});
    for (const run of runs) {
      if (isTerminalState(run.state)) {
        result.unchangedTerminal.push(run);
        continue;
      }
      const neverStarted = run.state === RUN_STATES.QUEUED
        && !run.startedAt
        && (!run.executorState || run.executorState === EXECUTOR_STATES.IDLE);
      if (neverStarted && retainQueued) {
        result.retainedQueued.push(run);
        continue;
      }
      const interrupted = this.terminal(run.runId, RUN_STATES.INTERRUPTED, {
        recovery: mergeObjects(run.recovery || {}, {
          recoveryCount: Number(run.recovery && run.recovery.recoveryCount || 0) + 1,
          lastRecoveredAt: at,
          lastRecoveryReason: reason,
        }),
        result: {
          error: {
            code: 'APP_RESTART',
            message: reason,
          },
        },
      }, { at });
      result.interrupted.push(interrupted);
    }
    return jsonClone(result);
  }

  // 任务账本是可观察性缓存，不是用户内容的唯一副本。保留所有非终态任务，
  // 终态按时间和数量淘汰，避免每次同步 index 写入随使用年限无界增长。
  prune(options = {}) {
    const maxTerminalRuns = Number.isSafeInteger(options.maxTerminalRuns)
      && options.maxTerminalRuns >= 0
      ? options.maxTerminalRuns
      : 1000;
    const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : (90 * 24 * 60 * 60 * 1000);
    const nowMs = new Date(this._timestamp(options.at)).getTime();
    this._refreshCacheIfIndexChanged();
    const runs = [...this._runs.values()].sort(compareRunsNewestFirst);
    const retained = [];
    const removed = [];
    let retainedTerminal = 0;

    for (const run of runs) {
      if (!isTerminalState(run.state)) {
        retained.push(run);
        continue;
      }
      const endedMs = Date.parse(run.endedAt || run.updatedAt || run.createdAt);
      const expired = Number.isFinite(endedMs) && nowMs - endedMs > maxAgeMs;
      const overLimit = retainedTerminal >= maxTerminalRuns;
      if (!expired && !overLimit) {
        retained.push(run);
        retainedTerminal += 1;
        continue;
      }
      try {
        fs.unlinkSync(this._runPath(run.runId));
        this._runs.delete(run.runId);
        removed.push(run.runId);
      } catch (error) {
        // 删除失败时继续保留权威文件，不能让 index 假装它已不存在。
        retained.push(run);
        retainedTerminal += 1;
        this._warn(`could not prune ${run.runId}`, error);
      }
    }

    try {
      if (removed.length) {
        this._runs = new Map(retained.map((run) => [run.runId, run]));
        this._indexDirty = true;
      }
      // No retention changes means the durable index remains valid. Still
      // flush a pending progress update if retention was called mid-task.
      if (this._indexDirty) this._flushIndex();
    }
    catch (error) { this._warn('could not update index after prune', error); }
    return jsonClone({ removed, retained: retained.length });
  }

  rebuildIndex() {
    const runs = this._scanRuns();
    this._runs = new Map(runs.map((run) => [run.runId, run]));
    this._indexDirty = true;
    this._flushIndex();
    return jsonClone([...runs].sort(compareRunsNewestFirst).map(runMeta));
  }

  flush() {
    try { this._flushIndex(); return true; }
    catch (error) { this._warn('could not flush index', error); return false; }
  }
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  TaskLedger,
  TaskLedgerError,
  writeJsonAtomic,
};
