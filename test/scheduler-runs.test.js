'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schedulerPath = require.resolve('../src/main/scheduling/scheduler');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate, description = 'expected state') {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixtureTask(id, at, extra = {}) {
  return { id, name: id, enabled: false, schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'fixture only', memory: 'off' },
    delivery: { notify: false, saveToHistory: false }, nextRunAt: null, lastRunAt: at, ...extra };
}

function harness(t, options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scheduler-runs-'));
  const storePath = path.join(userDataDir, 'schedules.json');
  if (options.seed) fs.writeFileSync(storePath, JSON.stringify(options.seed));
  delete require.cache[schedulerPath];
  const scheduler = require(schedulerPath);
  const launches = [], finishes = [], starts = [], releases = [];
  const deps = {
    userDataDir,
    agentDir: path.join(userDataDir, 'agents'),
    buildMemoryHint: () => '',
    loadConversation: () => null,
    saveConversation: () => {},
    getMainWindow: () => null,
    refreshTray: () => {},
    notify: () => {},
    readAppSettings: () => ({}),
    taskRunStart: (args) => { starts.push(args); return args.runId; },
    taskRunFinish: (runId, result) => { finishes.push({ runId, result }); },
    taskRunRelease: (runId) => releases.push(runId),
    runClaudeJob: (args) => {
      launches.push(args);
      return { child: { kill() { queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 })); return true; } } };
    },
    ...(options.deps || {}),
  };
  scheduler.init(deps);
  t.after(async () => {
    scheduler.shutdown();
    await turn();
    await turn();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    delete require.cache[schedulerPath];
  });
  return {
    scheduler, launches, finishes, starts, releases, userDataDir,
    disk: () => JSON.parse(fs.readFileSync(storePath, 'utf8')),
    create(extra = {}) {
      const result = scheduler.create({ name: 'fixture task', enabled: false,
        schedule: { kind: 'every', everyMs: 60000 },
        action: { type: 'chat', prompt: 'fixture only', memory: 'off' },
        delivery: { notify: false, saveToHistory: false }, ...extra });
      assert.equal(result.ok, true, result.error);
      return result.task;
    },
    complete(index = 0, error = null) {
      const args = launches[index];
      assert.ok(args, `launch ${index} exists`);
      args.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture complete' }] } });
      args.onEvent({ type: 'job-done', exitCode: error ? 1 : 0, error });
    },
    setPlannedAt(taskId, scheduledFor) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      store.tasks.find((task) => task.id === taskId).nextRunAt = scheduledFor;
      fs.writeFileSync(storePath, JSON.stringify(store));
    },
  };
}

test('runNow acknowledges a durable queued receipt before resource acquisition and execution', async (t) => {
  const acquisition = deferred();
  const h = harness(t, { deps: { taskRunAcquire: () => acquisition.promise } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 'queued');
  assert.ok(receipt.runId);
  assert.equal(receipt.taskId, task.id);
  assert.equal(h.launches.length, 0);
  const queued = h.disk().runs[0];
  assert.equal(queued.runId, receipt.runId);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.startedAt, null);
  const duplicate = await h.scheduler.runNow(task.id);
  assert.equal(duplicate.status, 'already_running');
  assert.equal(duplicate.runId, receipt.runId);
  assert.equal(h.scheduler.runs(task.id).length, 1);

  acquisition.resolve({ signal: null, release() {} });
  await eventually(() => h.launches.length === 1, 'executor launch');
  assert.equal(h.disk().runs[0].status, 'running');
  assert.equal(h.launches[0].runId, receipt.runId);
  h.complete();
  await eventually(() => !h.scheduler.get(task.id).running, 'terminal lifecycle');
  const history = h.scheduler.runs(task.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].runId, receipt.runId);
  assert.equal(history[0].status, 'ok');
  assert.equal(history[0].queuedAt, queued.queuedAt);
  assert.equal(h.finishes.length, 1);
});

test('resource acquisition failure finalizes the same receipt and releases the task', async (t) => {
  const h = harness(t, { deps: { taskRunAcquire: async () => { throw new Error('fixture capacity failure'); } } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  await eventually(() => !h.scheduler.get(task.id).running);
  assert.equal(h.launches.length, 0);
  const rows = h.disk().runs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, receipt.runId);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].error, /fixture capacity failure/);
  assert.equal(rows[0].ms, 0);
  assert.equal(h.scheduler.get(task.id).lastStatus, 'error');
});

test('queued cancellation completes promptly and releases a lease that arrives later', async (t) => {
  const acquisition = deferred();
  let leaseReleases = 0;
  const h = harness(t, { deps: { taskRunAcquire: () => acquisition.promise } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  assert.equal(h.scheduler.cancelRun(receipt.runId), true);
  await eventually(() => !h.scheduler.get(task.id).running, 'queued cancellation');
  assert.equal(h.scheduler.runs(task.id)[0].status, 'canceled');
  assert.equal(h.scheduler.runs(task.id)[0].ms, 0);
  assert.equal(h.finishes.length, 1);
  acquisition.resolve({ signal: null, release() { leaseReleases += 1; } });
  await eventually(() => leaseReleases === 1, 'late lease release');
  assert.equal(h.launches.length, 0);
  assert.equal(h.finishes.length, 1);
  assert.equal(h.scheduler.cancelRun(receipt.runId), false);
});

test('late resource rejection after cancellation is observed without a second outcome', async (t) => {
  const acquisition = deferred();
  const h = harness(t, { deps: { taskRunAcquire: () => acquisition.promise } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  h.scheduler.cancelRun(receipt.runId);
  await eventually(() => !h.scheduler.get(task.id).running);
  acquisition.reject(new Error('late fixture rejection'));
  await turn();
  await turn();
  assert.equal(h.scheduler.runs(task.id)[0].status, 'canceled');
  assert.equal(h.finishes.length, 1);
});

test('optional ledger failure does not remove the scheduler receipt or cancellation handle', async (t) => {
  const h = harness(t, { deps: {
    taskRunStart() { throw new Error('fixture ledger unavailable'); },
    taskRunFinish() { throw new Error('fixture ledger unavailable'); },
  } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  assert.ok(receipt.runId);
  await eventually(() => h.launches.length === 1);
  assert.equal(h.scheduler.cancelRun(receipt.runId), true);
  await eventually(() => !h.scheduler.get(task.id).running);
  assert.equal(h.scheduler.runs(task.id)[0].status, 'canceled');
  assert.equal(h.scheduler.runs(task.id)[0].runId, receipt.runId);
});

test('separate manual executions have distinct IDs and never move the existing schedule', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true });
  const planned = h.scheduler.get(task.id).nextRunAt;
  const first = await h.scheduler.runNow(task.id);
  await eventually(() => h.launches.length === 1);
  h.complete();
  await eventually(() => !h.scheduler.get(task.id).running);
  const second = await h.scheduler.runNow(task.id);
  await eventually(() => h.launches.length === 2);
  assert.notEqual(first.runId, second.runId);
  h.complete(1);
  await eventually(() => !h.scheduler.get(task.id).running);
  assert.equal(h.scheduler.get(task.id).nextRunAt, planned);
  assert.equal(h.scheduler.get(task.id).manualRunCount, 2);
  assert.equal(h.scheduler.runs(task.id).length, 2);
});

test('scheduled overlap records one skip per occurrence and advances its plan without execution', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true });
  await h.scheduler.runNow(task.id);
  await eventually(() => h.launches.length === 1);
  const planned = new Date(Date.now() - 1000).toISOString();
  h.setPlannedAt(task.id, planned);
  const skipped = await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: planned });
  const repeated = await h.scheduler._fireTask(task.id, { trigger: 'catchup', scheduledFor: planned });
  assert.equal(repeated.runId, skipped.runId);
  const rows = h.scheduler.runs(task.id).filter((run) => run.scheduledFor === planned);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].reasonCode, 'SKIPPED_OVERLAP');
  assert.equal(h.scheduler.get(task.id).runCount, 1);
  assert.ok(Date.parse(h.scheduler.get(task.id).nextRunAt) > Date.now());
  assert.equal(h.launches.length, 1);
  h.complete();
  await eventually(() => !h.scheduler.get(task.id).running);
});

test('a delayed overlap callback cannot overwrite a schedule edited to a newer occurrence', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true });
  await h.scheduler.runNow(task.id);
  const planned = h.scheduler.get(task.id).nextRunAt;
  await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: new Date(Date.now() - 60000).toISOString() });
  assert.equal(h.scheduler.get(task.id).nextRunAt, planned);
  h.complete();
  await eventually(() => !h.scheduler.get(task.id).running);
});

test('queueLatest merges pending occurrences and drains once with the same accepted runId', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true, overlapPolicy: 'queueLatest' });
  await h.scheduler.runNow(task.id);
  await eventually(() => h.launches.length === 1);
  const firstAt = new Date(Date.now() - 120000).toISOString();
  const latestAt = new Date(Date.now() - 60000).toISOString();
  h.setPlannedAt(task.id, firstAt);
  const earlier = await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: firstAt });
  h.setPlannedAt(task.id, latestAt);
  const latest = await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: latestAt });
  const acceptedRow = h.scheduler.runs(task.id).find((run) => run.runId === latest.runId);
  assert.equal(latest.status, 'queued');
  assert.equal(h.scheduler.runs(task.id).find((run) => run.runId === earlier.runId).reasonCode, 'SUPERSEDED');
  assert.equal(h.scheduler.runs(task.id).filter((run) => run.status === 'queued').length, 1);
  const nextPlan = h.scheduler.get(task.id).nextRunAt;
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.complete();
  await eventually(() => h.launches.length === 2, 'queued overlap drain');
  assert.equal(h.launches[1].runId, latest.runId);
  h.complete(1);
  await eventually(() => !h.scheduler.get(task.id).running);
  assert.equal(h.launches.length, 2);
  assert.equal(h.scheduler.get(task.id).runCount, 2);
  assert.equal(h.scheduler.get(task.id).nextRunAt, nextPlan);
  const rows = h.scheduler.runs(task.id).filter((run) => run.runId === latest.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].at, acceptedRow.at);
  assert.equal(rows[0].queuedAt, acceptedRow.queuedAt);
});

test('disabling or deleting a task cancels its pending overlap without replay', async (t) => {
  for (const action of ['disable', 'delete']) await t.test(action, async (t) => {
    const h = harness(t);
    const task = h.create({ enabled: true, overlapPolicy: 'queueLatest' });
    await h.scheduler.runNow(task.id);
    await eventually(() => h.launches.length === 1);
    const planned = new Date(Date.now() - 1000).toISOString();
    h.setPlannedAt(task.id, planned);
    const pending = await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: planned });
    if (action === 'disable') h.scheduler.toggle(task.id, false);
    else h.scheduler.remove(task.id);
    assert.equal(h.scheduler.runs(task.id).find((run) => run.runId === pending.runId).status, 'canceled');
    h.complete();
    await eventually(() => h.finishes.length === 1);
    await turn();
    assert.equal(h.launches.length, 1);
    assert.equal(h.scheduler.runs(task.id).find((run) => run.runId === pending.runId).status, 'canceled');
  });
});

test('an older delayed catchup cannot replace the latest pending overlap', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true, overlapPolicy: 'queueLatest' });
  await h.scheduler.runNow(task.id);
  await eventually(() => h.launches.length === 1);
  const latestAt = new Date(Date.now() - 1000).toISOString();
  const olderAt = new Date(Date.now() - 61000).toISOString();
  h.setPlannedAt(task.id, latestAt);
  const latest = await h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: latestAt });
  const older = await h.scheduler._fireTask(task.id, { trigger: 'catchup', scheduledFor: olderAt });
  const rows = h.scheduler.runs(task.id);
  assert.equal(rows.find((run) => run.runId === latest.runId).status, 'queued');
  assert.equal(rows.find((run) => run.runId === older.runId).status, 'skipped');
  assert.equal(rows.find((run) => run.runId === older.runId).reasonCode, 'SUPERSEDED');
  h.complete();
  await eventually(() => h.launches.length === 2);
  assert.equal(h.launches[1].runId, latest.runId);
  h.complete(1);
  await eventually(() => !h.scheduler.get(task.id).running);
  assert.equal(h.launches.length, 2);
});

test('an older delayed catchup is not queued behind a newer scheduled execution already running', async (t) => {
  const h = harness(t);
  const task = h.create({ enabled: true, overlapPolicy: 'queueLatest' });
  const latestAt = new Date(Date.now() - 1000).toISOString();
  const olderAt = new Date(Date.now() - 61000).toISOString();
  h.setPlannedAt(task.id, latestAt);
  const current = h.scheduler._fireTask(task.id, { trigger: 'timer', scheduledFor: latestAt });
  await eventually(() => h.launches.length === 1);
  const older = await h.scheduler._fireTask(task.id, { trigger: 'catchup', scheduledFor: olderAt });
  assert.equal(h.scheduler.runs(task.id).find((run) => run.runId === older.runId).status, 'skipped');
  assert.equal(h.scheduler.runs(task.id).filter((run) => run.queueReason === 'overlap' && run.status === 'queued').length, 0);
  h.complete();
  await current;
  await turn();
  assert.equal(h.launches.length, 1);
});

test('pausing or rescheduling cancels a catchup collected before the user edit', async (t) => {
  for (const action of ['pause', 'reschedule']) await t.test(action, async (t) => {
    const h = harness(t);
    const task = h.create({ enabled: true });
    h.setPlannedAt(task.id, new Date(Date.now() - 1000).toISOString());
    h.scheduler.onResume();
    if (action === 'pause') h.scheduler.toggle(task.id, false);
    else h.scheduler.update(task.id, { schedule: { kind: 'every', everyMs: 120000 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.launches.length, 0);
    assert.equal(h.scheduler.runs(task.id).length, 0);
  });
});

test('startup repairs queued, running and legacy ledger records without replaying any execution', async (t) => {
  const at = '2026-01-01T00:00:00.000Z';
  const seed = { version: 1, tasks: ['queued', 'running', 'legacy'].map((id) => fixtureTask(id, at)), runs: [
    { runId: 'queued-run', taskId: 'queued', status: 'queued', at, queueReason: 'overlap' },
    { runId: 'running-run', taskId: 'running', status: 'running', at, startedAt: at },
  ] };
  const h = harness(t, { seed, deps: { taskRunHistory: () => [{
    runId: 'legacy-run', state: 'interrupted', title: 'legacy task', queuedAt: at, startedAt: at,
    source: { type: 'schedule', scheduleId: 'legacy' },
    result: { error: { code: 'APP_RESTART', message: 'fixture restart' } },
  }] } });
  await turn();
  assert.equal(h.launches.length, 0);
  assert.equal(h.disk().runs.length, 3);
  assert.ok(h.disk().runs.every((run) => run.status === 'interrupted'));
  assert.ok(h.scheduler.list().every((task) => task.lastStatus === 'interrupted' && !task.running && !task.enabled));
});

test('startup reconciles a completed ledger run instead of falsely reporting interruption', (t) => {
  const at = '2026-01-01T00:00:00.000Z';
  const h = harness(t, {
    seed: { version: 1, tasks: [fixtureTask('task-1', at)], runs: [{ runId: 'run-1', taskId: 'task-1', status: 'running', at }] },
    deps: { taskRunHistory: () => [{ runId: 'run-1', state: 'succeeded', startedAt: at,
      endedAt: '2026-01-01T00:00:01.000Z', source: { type: 'schedule', scheduleId: 'task-1' }, result: { summary: 'durable completion' } }] },
  });
  assert.equal(h.disk().runs[0].status, 'ok');
  assert.equal(h.disk().runs[0].summary, 'durable completion');
  assert.equal(h.scheduler.get('task-1').lastStatus, 'ok');
  assert.equal(h.launches.length, 0);
});
