'use strict';

const RUN_SCHEMA_VERSION = 1;
const RUN_EVENT_SCHEMA_VERSION = 1;

const RUN_STATES = Object.freeze({
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_USER: 'waiting_user',
  STOPPING: 'stopping',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  INTERRUPTED: 'interrupted',
});

const RUN_HEALTH = Object.freeze({
  OK: 'ok',
  SILENT: 'silent',
  STALLED: 'stalled',
});

const EXECUTOR_STATES = Object.freeze({
  IDLE: 'idle',
  ACTIVE: 'active',
  DRAINING: 'draining',
  STOPPED: 'stopped',
});

const RUN_EVENT_TYPES = Object.freeze({
  UPSERT: 'run.upsert',
});

const TERMINAL_STATES = new Set([
  RUN_STATES.SUCCEEDED,
  RUN_STATES.FAILED,
  RUN_STATES.CANCELED,
  RUN_STATES.INTERRUPTED,
]);

const ALL_STATES = new Set(Object.values(RUN_STATES));
const ALL_HEALTH_STATES = new Set(Object.values(RUN_HEALTH));
const ALL_EXECUTOR_STATES = new Set(Object.values(EXECUTOR_STATES));

// Self transitions are accepted separately. The table only describes actual state changes.
// starting -> succeeded is intentional: some SDK paths emit a terminal event before an init event.
const ALLOWED_TRANSITIONS = Object.freeze({
  [RUN_STATES.QUEUED]: new Set([
    RUN_STATES.STARTING,
    RUN_STATES.FAILED,
    RUN_STATES.CANCELED,
    RUN_STATES.INTERRUPTED,
  ]),
  [RUN_STATES.STARTING]: new Set([
    RUN_STATES.RUNNING,
    RUN_STATES.WAITING_USER,
    RUN_STATES.STOPPING,
    RUN_STATES.SUCCEEDED,
    RUN_STATES.FAILED,
    RUN_STATES.CANCELED,
    RUN_STATES.INTERRUPTED,
  ]),
  [RUN_STATES.RUNNING]: new Set([
    RUN_STATES.WAITING_USER,
    RUN_STATES.STOPPING,
    RUN_STATES.SUCCEEDED,
    RUN_STATES.FAILED,
    RUN_STATES.CANCELED,
    RUN_STATES.INTERRUPTED,
  ]),
  [RUN_STATES.WAITING_USER]: new Set([
    RUN_STATES.RUNNING,
    RUN_STATES.STOPPING,
    RUN_STATES.FAILED,
    RUN_STATES.CANCELED,
    RUN_STATES.INTERRUPTED,
  ]),
  [RUN_STATES.STOPPING]: new Set([
    RUN_STATES.SUCCEEDED,
    RUN_STATES.FAILED,
    RUN_STATES.CANCELED,
    RUN_STATES.INTERRUPTED,
  ]),
  [RUN_STATES.SUCCEEDED]: new Set(),
  [RUN_STATES.FAILED]: new Set(),
  [RUN_STATES.CANCELED]: new Set(),
  [RUN_STATES.INTERRUPTED]: new Set(),
});

class TaskProtocolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskProtocolError';
    this.code = code;
    this.details = details;
  }
}

function isRunState(value) {
  return ALL_STATES.has(value);
}

function isTerminalState(value) {
  return TERMINAL_STATES.has(value);
}

function isValidRunId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function canTransition(from, to) {
  if (!isRunState(from) || !isRunState(to)) return false;
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].has(to);
}

function assertTransition(from, to) {
  if (!isRunState(from)) {
    throw new TaskProtocolError('INVALID_RUN_STATE', `Unknown run state: ${String(from)}`);
  }
  if (!isRunState(to)) {
    throw new TaskProtocolError('INVALID_RUN_STATE', `Unknown run state: ${String(to)}`);
  }
  if (!canTransition(from, to)) {
    throw new TaskProtocolError(
      'INVALID_RUN_TRANSITION',
      `Run cannot transition from ${from} to ${to}`,
      { from, to },
    );
  }
}

// 快照可以截断历史终态，但必须完整保留所有非终态任务。
function selectTaskSnapshotRuns(runs, options = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0
    ? options.limit
    : 200;
  if (options.terminal === true) {
    return list.filter((run) => run && isTerminalState(run.state)).slice(0, limit);
  }
  if (options.terminal === false) {
    return list.filter((run) => run && !isTerminalState(run.state));
  }
  let terminalCount = 0;
  return list.filter((run) => {
    if (!run || !isTerminalState(run.state)) return !!run;
    const include = terminalCount < limit;
    terminalCount += 1;
    return include;
  });
}

function validateRunRecord(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new TaskProtocolError('INVALID_RUN', 'Run must be an object');
  }
  if (run.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new TaskProtocolError(
      'UNSUPPORTED_RUN_SCHEMA',
      `Unsupported run schema version: ${String(run.schemaVersion)}`,
    );
  }
  if (!isValidRunId(run.runId)) {
    throw new TaskProtocolError('INVALID_RUN_ID', `Invalid run id: ${String(run.runId)}`);
  }
  if (!Number.isSafeInteger(run.revision) || run.revision < 1) {
    throw new TaskProtocolError('INVALID_RUN_REVISION', 'Run revision must be a positive safe integer');
  }
  if (!isRunState(run.state)) {
    throw new TaskProtocolError('INVALID_RUN_STATE', `Unknown run state: ${String(run.state)}`);
  }
  if (run.health != null && !ALL_HEALTH_STATES.has(run.health)) {
    throw new TaskProtocolError('INVALID_RUN_HEALTH', `Unknown run health: ${String(run.health)}`);
  }
  if (run.executorState != null && !ALL_EXECUTOR_STATES.has(run.executorState)) {
    throw new TaskProtocolError(
      'INVALID_EXECUTOR_STATE',
      `Unknown executor state: ${String(run.executorState)}`,
    );
  }
  if (typeof run.createdAt !== 'string' || typeof run.updatedAt !== 'string') {
    throw new TaskProtocolError('INVALID_RUN_TIMESTAMP', 'Run timestamps must be ISO strings');
  }
  if (isTerminalState(run.state) && typeof run.endedAt !== 'string') {
    throw new TaskProtocolError('INVALID_RUN_TIMESTAMP', 'A terminal run must have endedAt');
  }
  return run;
}

module.exports = {
  RUN_SCHEMA_VERSION,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_STATES,
  RUN_HEALTH,
  EXECUTOR_STATES,
  RUN_EVENT_TYPES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  TaskProtocolError,
  isRunState,
  isTerminalState,
  isValidRunId,
  canTransition,
  assertTransition,
  selectTaskSnapshotRuns,
  validateRunRecord,
};
