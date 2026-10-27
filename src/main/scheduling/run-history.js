'use strict';

// schedules.json is the scheduler's durable receipt. The task ledger enriches
// recovery, but is optional and must not be the only place a run is recorded.
const RUNS_CAP = 200;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const LEDGER_TERMINAL = new Map([
  ['succeeded', 'ok'], ['failed', 'error'], ['canceled', 'canceled'], ['interrupted', 'interrupted'],
]);
const INTERRUPTED_ERROR = 'Relay 在任务完成前退出，执行已中断';

function timestamp(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(value, fallback = null) {
  const ms = timestamp(value);
  return ms == null ? fallback : new Date(ms).toISOString();
}

function runTime(run) {
  return timestamp(run && (run.at || run.queuedAt || run.startedAt)) || 0;
}

function isActive(run) {
  return !!run && ACTIVE_STATUSES.has(run.status);
}

// Cap only finished records. An old long-running or queued receipt must survive
// unrelated completions so that cancellation and restart recovery still work.
function trimRuns(store, cap = RUNS_CAP) {
  const runs = store.runs || (store.runs = []);
  const limit = Number.isSafeInteger(cap) && cap >= 0 ? cap : RUNS_CAP;
  const terminal = runs.map((run, index) => ({ run, index }))
    .filter(({ run }) => !isActive(run))
    .sort((left, right) => runTime(right.run) - runTime(left.run) || left.index - right.index);
  const keep = new Set(terminal.slice(0, limit).map(({ index }) => index));
  const retained = runs.filter((run, index) => isActive(run) || keep.has(index));
  const removed = runs.length - retained.length;
  if (removed) store.runs = retained;
  return removed;
}

// One stable runId follows acceptance, acquisition and completion. Legacy
// records without a runId remain independent history entries.
function upsertRun(store, record) {
  const runs = store.runs || (store.runs = []);
  const index = record.runId ? runs.findIndex((run) => run.runId === record.runId) : -1;
  if (index >= 0) {
    const current = runs[index];
    // Terminal completion is immutable here; webhook delivery has its own
    // update path. Late callbacks must not resurrect or replace the outcome.
    if (!isActive(current) || (current.status === 'running' && record.status === 'queued')
        || (current.taskId && record.taskId && current.taskId !== record.taskId)) return current;
    const patch = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
    runs[index] = { ...current, ...patch };
    trimRuns(store);
    return runs[index];
  }
  const row = { ...record };
  runs.unshift(row);
  trimRuns(store);
  return row;
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return error && typeof error.message === 'string' ? error.message : null;
}

function ledgerRecord(run, previous, now) {
  const status = LEDGER_TERMINAL.get(run.state) || 'interrupted';
  const at = previous && previous.at
    || iso(run.queuedAt, iso(run.createdAt, iso(run.startedAt, now)));
  const queuedAt = previous && previous.queuedAt || iso(run.queuedAt, at);
  const startedAt = iso(run.startedAt, previous && previous.startedAt || null);
  const endedAt = iso(run.endedAt, now);
  const result = run.result || {};
  const activeEnd = status === 'interrupted' ? iso(run.recovery && run.recovery.lastActiveAt) : endedAt;
  // A restart may be detected days later. Do not present that offline interval
  // as execution time; unknown duration remains unknown.
  let ms = previous && Number.isFinite(previous.ms) ? previous.ms : null;
  if (!startedAt) ms = 0;
  else if (activeEnd) ms = Math.max(0, timestamp(activeEnd) - timestamp(startedAt));
  return {
    taskId: run.source.scheduleId,
    taskName: previous && previous.taskName || run.title || null,
    runId: run.runId,
    at,
    queuedAt,
    startedAt,
    endedAt,
    trigger: run.trigger || previous && previous.trigger || 'timer',
    scheduledFor: run.source.scheduledFor || previous && previous.scheduledFor || null,
    status,
    ms,
    summary: typeof result.summary === 'string' ? result.summary : previous && previous.summary || '',
    error: status === 'ok' ? null : errorText(result.error)
      || (status === 'interrupted' ? INTERRUPTED_ERROR : status === 'canceled' ? '任务已取消' : '执行失败'),
    conversationId: result.conversationId || run.source.conversationId || previous && previous.conversationId || null,
    conversationKind: result.conversationKind || run.source.conversationKind || previous && previous.conversationKind || null,
    recoveredAt: now,
  };
}

function canBackfill(store, record) {
  const terminal = (store.runs || []).filter((run) => !isActive(run));
  return terminal.length < RUNS_CAP || terminal.some((run) => runTime(run) < runTime(record));
}

// Called only on process startup, after task-ledger recovery. No execution or
// automatic retry happens here, including for a queued follow-up occurrence.
function recoverInterruptedRuns(store, ledgerRuns = [], now = Date.now()) {
  const recoveredAt = iso(now, new Date().toISOString());
  const recoveredRows = new Set();
  let changed = false;
  const ledger = new Map();
  for (const run of Array.isArray(ledgerRuns) ? ledgerRuns : []) {
    if (run && run.runId && run.source && run.source.type === 'schedule' && run.source.scheduleId) {
      ledger.set(run.runId, run);
    }
  }

  for (const row of [...(store.runs || [])]) {
    if (!isActive(row)) continue;
    const candidate = row.runId && ledger.get(row.runId);
    const match = candidate && candidate.source.scheduleId === row.taskId ? candidate : null;
    const patch = match ? ledgerRecord(match, row, recoveredAt) : {
      ...row,
      status: 'interrupted',
      endedAt: recoveredAt,
      recoveredAt,
      ms: row.status === 'queued' ? 0 : (Number.isFinite(row.ms) ? row.ms : null),
      error: INTERRUPTED_ERROR,
    };
    // Old active records without an ID cannot use the ID-based upsert path.
    if (row.runId) recoveredRows.add(upsertRun(store, patch));
    else { Object.assign(row, patch); recoveredRows.add(row); }
    changed = true;
  }

  // Prior versions only wrote scheduler history on completion. Backfill their
  // interrupted ledger entries, not every historical successful execution.
  const missing = [...ledger.values()]
    .filter((run) => run.state === 'interrupted' && !(store.runs || []).some((row) => row.runId === run.runId))
    .map((run) => ledgerRecord(run, null, recoveredAt))
    .sort((left, right) => runTime(right) - runTime(left));
  for (const row of missing) {
    if (!canBackfill(store, row)) continue;
    recoveredRows.add(upsertRun(store, row));
    changed = true;
  }

  // Only the latest known run may set the task's latest outcome. An older
  // interrupted run must not erase a more recent success or skip decision.
  const latest = new Map();
  for (const row of store.runs || []) {
    const previous = latest.get(row.taskId);
    if (!previous || runTime(row) > runTime(previous)) latest.set(row.taskId, row);
  }
  for (const task of store.tasks || []) {
    const row = latest.get(task.id);
    // An overlap occurrence is accepted before the preceding execution ends.
    // Its task.lastRunAt advances only when it is admitted to the executor.
    const admittedAt = Math.max(runTime(row), timestamp(row && row.admittedAt) || 0,
      timestamp(row && row.startedAt) || 0);
    if (!row || !recoveredRows.has(row) || admittedAt < (timestamp(task.lastRunAt) || 0)) continue;
    if (task.lastStatus !== row.status || task.lastError !== row.error) {
      task.lastStatus = row.status;
      task.lastError = row.error || null;
      changed = true;
    }
  }
  if (trimRuns(store)) changed = true;
  return { changed, recovered: recoveredRows.size };
}

module.exports = { upsertRun, trimRuns, recoverInterruptedRuns };
