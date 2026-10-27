'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertRun, trimRuns, recoverInterruptedRuns } = require('../src/main/scheduling/run-history');

const EARLY = '2026-10-22T01:00:00.000Z';
const LATER = '2026-10-22T02:00:00.000Z';
const NOW = '2026-10-23T01:00:00.000Z';

function queued(overrides = {}) {
  return { runId: 'run-1', taskId: 'task-1', at: EARLY, queuedAt: EARLY, startedAt: null,
    status: 'queued', summary: '', error: null, ...overrides };
}

function ledger(overrides = {}) {
  return { runId: 'run-1', state: 'interrupted', title: 'daily task', trigger: 'timer',
    source: { type: 'schedule', scheduleId: 'task-1', scheduledFor: EARLY },
    queuedAt: EARLY, createdAt: EARLY, startedAt: EARLY, endedAt: NOW,
    recovery: { lastActiveAt: '2026-10-22T01:00:05.000Z' },
    result: { error: { code: 'APP_RESTART', message: 'Interrupted by restart' } }, ...overrides };
}

test('one receipt follows queued, running and terminal without losing context', () => {
  const store = { runs: [] };
  upsertRun(store, queued({ scheduledFor: EARLY, trigger: 'timer', taskName: 'daily task' }));
  upsertRun(store, { runId: 'run-1', status: 'running', startedAt: LATER });
  const finished = upsertRun(store, { runId: 'run-1', status: 'ok', summary: 'done', endedAt: NOW });
  assert.equal(store.runs.length, 1);
  assert.strictEqual(store.runs[0], finished);
  assert.equal(finished.taskId, 'task-1');
  assert.equal(finished.at, EARLY);
  assert.equal(finished.scheduledFor, EARLY);
  assert.equal(finished.startedAt, LATER);
  assert.equal(finished.summary, 'done');
});

test('terminal duplicates and late active callbacks preserve result and webhook state', () => {
  const original = queued({ status: 'ok', summary: 'original', delivery: { webhook: { status: 'pending' } } });
  const store = { runs: [original] };
  for (const status of ['ok', 'error', 'queued', 'running']) {
    assert.strictEqual(upsertRun(store, { runId: 'run-1', status, summary: 'late', delivery: null }), original);
  }
  assert.deepEqual(store.runs, [original]);
  assert.equal(original.delivery.webhook.status, 'pending');
});

test('late queued updates cannot regress running state or move an ID between tasks', () => {
  const original = queued({ status: 'running', startedAt: EARLY });
  const store = { runs: [original] };
  upsertRun(store, { runId: 'run-1', status: 'queued' });
  upsertRun(store, { runId: 'run-1', taskId: 'different-task', status: 'error' });
  assert.strictEqual(store.runs[0], original);
});

test('undefined patches preserve fields and legacy records without IDs remain separate', () => {
  const store = { runs: [] };
  upsertRun(store, queued());
  upsertRun(store, { runId: 'run-1', status: 'running', at: undefined });
  upsertRun(store, { taskId: 'task-1', runId: null, status: 'skipped', at: LATER });
  upsertRun(store, { taskId: 'task-1', runId: null, status: 'skipped', at: NOW });
  assert.equal(store.runs.length, 3);
  assert.equal(store.runs.find((run) => run.runId === 'run-1').at, EARLY);
});

test('history retention keeps newest 200 terminal rows and every active receipt', () => {
  const terminal = Array.from({ length: 205 }, (_, i) => queued({
    runId: `finished-${i}`, status: 'ok', at: new Date(Date.parse(EARLY) + i * 1000).toISOString(),
  }));
  const active = [queued({ runId: 'old-queued', at: '2025-01-01T00:00:00Z' }),
    queued({ runId: 'old-running', status: 'running', at: '2025-01-01T00:00:00Z' })];
  const store = { runs: [...terminal, ...active] };
  assert.equal(trimRuns(store), 5);
  assert.equal(store.runs.length, 202);
  assert.ok(active.every((run) => store.runs.includes(run)));
  assert.equal(store.runs.some((run) => run.runId === 'finished-0'), false);
  assert.equal(store.runs.some((run) => run.runId === 'finished-204'), true);
  assert.equal(trimRuns(store), 0);
});

test('a zero terminal cap still retains queued and running rows', () => {
  const store = { runs: [queued(), queued({ runId: 'done', status: 'ok' })] };
  assert.equal(trimRuns(store, 0), 1);
  assert.equal(store.runs[0].status, 'queued');
});

test('startup interrupts scheduler receipts even without the optional ledger', () => {
  const store = { tasks: [{ id: 'task-1', lastRunAt: EARLY }], runs: [queued()] };
  assert.deepEqual(recoverInterruptedRuns(store, [], NOW), { changed: true, recovered: 1 });
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].status, 'interrupted');
  assert.equal(store.runs[0].endedAt, NOW);
  assert.equal(store.runs[0].ms, 0);
  assert.equal(store.tasks[0].lastStatus, 'interrupted');
  assert.match(store.tasks[0].lastError, /中断/);
  const snapshot = JSON.stringify(store);
  assert.deepEqual(recoverInterruptedRuns(store, [], NOW), { changed: false, recovered: 0 });
  assert.equal(JSON.stringify(store), snapshot);
});

test('unknown running duration does not include a day spent offline', () => {
  const store = { tasks: [], runs: [queued({ status: 'running', startedAt: EARLY })] };
  recoverInterruptedRuns(store, [], NOW);
  assert.equal(store.runs[0].ms, null);
});

test('ledger recovery retains actual last activity rather than detection time as duration', () => {
  const store = { tasks: [], runs: [queued({ status: 'running', startedAt: EARLY })] };
  recoverInterruptedRuns(store, [ledger()], NOW);
  assert.equal(store.runs[0].ms, 5000);
  assert.equal(store.runs[0].endedAt, NOW);
  assert.equal(store.runs[0].error, 'Interrupted by restart');
});

test('never-started ledger queue is interrupted with zero execution duration', () => {
  const store = { tasks: [], runs: [queued()] };
  recoverInterruptedRuns(store, [ledger({ startedAt: null })], NOW);
  assert.equal(store.runs[0].ms, 0);
  assert.equal(store.runs[0].startedAt, null);
});

test('pending receipts reconcile all ledger terminal outcomes and retain delivery metadata', async (t) => {
  for (const [state, expected] of [['succeeded', 'ok'], ['failed', 'error'], ['canceled', 'canceled'], ['interrupted', 'interrupted']]) {
    await t.test(state, () => {
      const store = { tasks: [], runs: [queued({ delivery: { webhook: { status: 'pending', eventId: 'delivery-1' } } })] };
      recoverInterruptedRuns(store, [ledger({ state, result: { summary: 'ledger summary', error: 'ledger error' },
        source: { type: 'schedule', scheduleId: 'task-1', conversationId: 'conversation-1', conversationKind: 'chat' } })], NOW);
      const row = store.runs[0];
      assert.equal(row.status, expected);
      assert.equal(row.summary, 'ledger summary');
      assert.equal(row.error, state === 'succeeded' ? null : 'ledger error');
      assert.equal(row.conversationId, 'conversation-1');
      assert.equal(row.delivery.webhook.eventId, 'delivery-1');
    });
  }
});

test('already terminal scheduler outcomes and delivery state are authoritative', () => {
  const row = queued({ status: 'ok', summary: 'completed before exit', delivery: { webhook: { status: 'failed' } } });
  const task = { id: 'task-1', lastStatus: 'ok', lastError: null };
  const store = { tasks: [task], runs: [row] };
  const before = JSON.stringify(store);
  assert.deepEqual(recoverInterruptedRuns(store, [ledger()], NOW), { changed: false, recovered: 0 });
  assert.equal(JSON.stringify(store), before);
});

test('legacy interrupted ledger runs are backfilled once, without retrying one-shot tasks', () => {
  const task = { id: 'task-1', enabled: false, nextRunAt: null, lastRunAt: EARLY, runCount: 1,
    schedule: { kind: 'at', at: EARLY } };
  const store = { tasks: [task], runs: [] };
  assert.deepEqual(recoverInterruptedRuns(store, [ledger()], NOW), { changed: true, recovered: 1 });
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].scheduledFor, EARLY);
  assert.equal(store.runs[0].taskName, 'daily task');
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);
  assert.equal(task.runCount, 1);
  assert.deepEqual(recoverInterruptedRuns(store, [ledger()], NOW), { changed: false, recovered: 0 });
});

test('recovery does not invent executions from lastRunAt or unrelated ledger entries', () => {
  const store = { tasks: [{ id: 'task-1', lastRunAt: EARLY, lastStatus: 'ok' }], runs: [] };
  const unrelated = ledger({ source: { type: 'chat', scheduleId: 'task-1' } });
  assert.deepEqual(recoverInterruptedRuns(store, [unrelated, ledger({ state: 'succeeded' })], NOW),
    { changed: false, recovered: 0 });
  assert.deepEqual(store.runs, []);
  assert.equal(store.tasks[0].lastStatus, 'ok');
});

test('a different task sharing a malformed ledger ID cannot supply an outcome', () => {
  const store = { tasks: [], runs: [queued()] };
  recoverInterruptedRuns(store, [ledger({ state: 'succeeded', source: { type: 'schedule', scheduleId: 'different-task' } })], NOW);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].taskId, 'task-1');
  assert.equal(store.runs[0].status, 'interrupted');
});

test('older recovered interruptions cannot erase a newer successful outcome', () => {
  const task = { id: 'task-1', lastStatus: 'ok', lastError: null, lastRunAt: LATER };
  const store = { tasks: [task], runs: [queued({ runId: 'newer', status: 'ok', at: LATER }), queued()] };
  recoverInterruptedRuns(store, [ledger()], NOW);
  assert.equal(task.lastStatus, 'ok');
  assert.equal(task.lastError, null);
});

test('a newer task lastRunAt also prevents stale recovery when its history was trimmed', () => {
  const task = { id: 'task-1', lastStatus: 'ok', lastError: null, lastRunAt: LATER };
  const store = { tasks: [task], runs: [queued()] };
  recoverInterruptedRuns(store, [], NOW);
  assert.equal(task.lastStatus, 'ok');
});

test('a drained overlap updates its latest task outcome using admission time', () => {
  for (const status of ['queued', 'running']) {
    const task = { id: 'task-1', lastStatus: 'ok', lastError: null, lastRunAt: LATER };
    const store = { tasks: [task], runs: [queued({ status, admittedAt: LATER,
      startedAt: status === 'running' ? LATER : null })] };
    recoverInterruptedRuns(store, [], NOW);
    assert.equal(task.lastStatus, 'interrupted');
    assert.equal(store.runs[0].at, EARLY, 'original occurrence acceptance is preserved');
  }
});

test('legacy queued records without runId are repaired in place without duplicates', () => {
  const store = { tasks: [], runs: [queued({ runId: null })] };
  recoverInterruptedRuns(store, [], NOW);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].status, 'interrupted');
});

test('large legacy recovery respects retention and does not re-add expired rows next startup', () => {
  const entries = Array.from({ length: 205 }, (_, i) => ledger({ runId: `legacy-${i}`,
    queuedAt: new Date(Date.parse(EARLY) + i * 1000).toISOString() }));
  const store = { tasks: [], runs: [] };
  const result = recoverInterruptedRuns(store, entries, NOW);
  assert.equal(result.recovered, 200);
  assert.equal(store.runs.length, 200);
  assert.ok(store.runs.some((run) => run.runId === 'legacy-204'));
  assert.equal(store.runs.some((run) => run.runId === 'legacy-0'), false);
  assert.deepEqual(recoverInterruptedRuns(store, entries, NOW), { changed: false, recovered: 0 });
});
