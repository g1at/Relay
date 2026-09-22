'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const {
  RUN_STATES,
  RUN_HEALTH,
} = require('../src/main/tasks/task-protocol');
const {
  DEFAULT_RESOURCE_LIMITS,
  TaskOrchestrator,
  inferResource,
} = require('../src/main/tasks/task-orchestrator');

function makeHarness(t, overrides = {}) {
  let rootDir;
  try {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-orchestrator-'));
  } catch (_) {
    const fallback = path.join(__dirname, '.task-orchestrator-tmp');
    fs.mkdirSync(fallback, { recursive: true });
    rootDir = fs.mkdtempSync(path.join(fallback, 'orchestrator-'));
  }
  let clockMs = Date.parse('2026-08-25T00:00:00Z');
  let generated = 0;
  const now = () => new Date(clockMs);
  const ledger = new TaskLedger({
    rootDir,
    now,
    idFactory: () => `generated-${++generated}`,
    logger: { warn() {} },
  });
  const orchestrator = new TaskOrchestrator({
    ledger,
    now,
    healthCheckIntervalMs: 0,
    logger: { warn() {} },
    ...overrides,
  });
  t.after(() => {
    orchestrator.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return {
    ledger,
    orchestrator,
    now,
    advance(ms) { clockMs += ms; },
    setTime(value) { clockMs = Date.parse(value); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('默认资源池分别限制 Claude=2、图片=1、命令=1，并在任务结束后补位', async (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  assert.deepEqual(DEFAULT_RESOURCE_LIMITS, { claude: 2, image: 1, command: 1 });
  assert.equal(inferResource({ kind: 'scheduled_image' }), 'image');
  assert.equal(inferResource({ kind: 'scheduled_command' }), 'command');
  assert.equal(inferResource({ kind: 'agent' }), 'claude');

  const started = { claude: [], image: [], command: [] };
  const pending = new Map();
  for (const resource of Object.keys(started)) {
    orchestrator.registerExecutor(resource, (run) => {
      started[resource].push(run.runId);
      const item = deferred();
      pending.set(run.runId, item);
      return item.promise;
    });
  }
  for (let index = 1; index <= 5; index += 1) {
    orchestrator.enqueue({ runId: `claude-${index}`, kind: 'chat' });
  }
  for (let index = 1; index <= 2; index += 1) {
    orchestrator.enqueue({ runId: `image-${index}`, kind: 'image' });
    orchestrator.enqueue({ runId: `command-${index}`, kind: 'command' });
  }

  orchestrator.start();
  assert.deepEqual(started.claude, ['claude-1', 'claude-2']);
  assert.deepEqual(started.image, ['image-1']);
  assert.deepEqual(started.command, ['command-1']);
  assert.equal(orchestrator.getStats().byResource.claude.active, 2);
  assert.equal(orchestrator.getStats().byResource.claude.queued, 3);
  assert.equal(ledger.get('claude-3').state, RUN_STATES.QUEUED);

  pending.get('claude-1').resolve({ result: { summary: 'done' } });
  pending.get('image-1').resolve();
  pending.get('command-1').resolve();
  await until(() => started.claude.length === 3
    && started.image.length === 2
    && started.command.length === 2);
  assert.equal(ledger.get('claude-1').state, RUN_STATES.SUCCEEDED);
  assert.equal(ledger.get('claude-3').state, RUN_STATES.RUNNING);
  assert.equal(ledger.get('image-2').state, RUN_STATES.RUNNING);
  assert.equal(ledger.get('command-2').state, RUN_STATES.RUNNING);
  assert.equal(orchestrator.getStats().byResource.claude.active, 2);
  assert.equal(orchestrator.getStats().byResource.claude.queued, 2);
  assert.equal(ledger.get('claude-4').state, RUN_STATES.QUEUED);

  pending.get('claude-2').resolve();
  await until(() => started.claude.length === 4);
  assert.equal(ledger.get('claude-4').state, RUN_STATES.RUNNING);
  assert.equal(ledger.get('claude-5').state, RUN_STATES.QUEUED);
  assert.equal(orchestrator.getStats().byResource.claude.active, 2);
});

test('优先级老化让久候低优先任务最终超过新任务', async (t) => {
  const { ledger, orchestrator, advance } = makeHarness(t, {
    poolLimits: { claude: 1 },
    agingIntervalMs: 60 * 1000,
    agingStep: 1,
  });
  const order = [];
  const pending = new Map();
  orchestrator.registerExecutor('claude', (run) => {
    order.push(run.runId);
    const item = deferred();
    pending.set(run.runId, item);
    return item.promise;
  });
  orchestrator.enqueue({ runId: 'blocker', priority: 100 });
  orchestrator.start();
  orchestrator.enqueue({ runId: 'old-low', priority: 50 });
  advance(10 * 60 * 1000);
  orchestrator.enqueue({ runId: 'new-high', priority: 55 });

  pending.get('blocker').resolve();
  await until(() => order.length === 2);
  assert.deepEqual(order, ['blocker', 'old-low']);
  assert.equal(ledger.get('new-high').state, RUN_STATES.QUEUED);
});

test('raising the limit immediately releases waiting leases; lowering it never interrupts running work', async t => {
  const { ledger, orchestrator } = makeHarness(t, { poolLimits: { claude: 1 } });
  orchestrator.start();
  const promises = [];
  for (let index = 0; index < 5; index++) {
    const runId = `dynamic-${index}`;
    ledger.create({ runId, kind: 'chat', state: RUN_STATES.QUEUED });
    promises.push(orchestrator.acquireExisting(runId, { resource: 'claude', conversationKey: runId }));
  }
  const first = await promises[0];
  assert.equal(orchestrator.getStats().active, 1);
  orchestrator.setPoolLimits({ claude: 3 });
  const next = await Promise.all(promises.slice(1, 3));
  assert.equal(orchestrator.getStats().active, 3);
  orchestrator.setPoolLimits({ claude: 1 });
  for (const lease of [first, ...next]) assert.equal(lease.signal.aborted, false);
  const finish = lease => { ledger.terminal(lease.runId, RUN_STATES.SUCCEEDED); lease.release(); };
  finish(first);
  finish(next[0]);
  assert.equal(orchestrator.getStats().active, 1);
  assert.equal(ledger.get('dynamic-3').state, RUN_STATES.QUEUED);
  finish(next[1]);
  const fourth = await promises[3];
  assert.equal(ledger.get('dynamic-4').state, RUN_STATES.QUEUED);
  orchestrator.setPoolLimits({ claude: 0 });
  const fifth = await promises[4];
  assert.equal(JSON.parse(JSON.stringify(orchestrator.getStats())).byResource.claude.limit, 0);
  assert.equal(orchestrator.getStats().byResource.image.limit, 1);
  finish(fourth); finish(fifth);
});

test('unlimited executor dispatch exceeds eight while preserving same-conversation exclusion', async t => {
  const { ledger, orchestrator } = makeHarness(t, { poolLimits: { claude: 1 } });
  const pending = new Map();
  orchestrator.registerExecutor('claude', run => { const job = deferred(); pending.set(run.runId, job); return job.promise; });
  for (let index = 0; index < 12; index++) orchestrator.enqueue({ runId: `unlimited-${index}`, conversationKey: `conversation-${index}` });
  orchestrator.start();
  orchestrator.enqueue({ runId: 'same-conversation', conversationKey: 'conversation-0' });
  orchestrator.setPoolLimits({ claude: 0 });
  assert.equal(pending.size, 12);
  assert.equal(ledger.get('same-conversation').state, RUN_STATES.QUEUED);
  pending.get('unlimited-0').resolve();
  await until(() => pending.has('same-conversation'));
  for (const item of pending.values()) item.resolve();
  await until(() => orchestrator.getStats().active === 0);
});

test('invalid runtime limits are rejected atomically', t => {
  const { orchestrator } = makeHarness(t);
  for (const limit of [Infinity, NaN, null, -1, 1.5, '5']) {
    assert.throws(() => orchestrator.setPoolLimits({ claude: 8, image: limit }), error => error.code === 'INVALID_RESOURCE_LIMIT');
    assert.deepEqual(orchestrator.poolLimits, DEFAULT_RESOURCE_LIMITS);
  }
});

test('同一对话互斥，但不同对话可占用同一资源池的其他槽位', async (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  const started = [];
  const pending = new Map();
  orchestrator.registerExecutor('claude', (run) => {
    started.push(run.runId);
    const item = deferred();
    pending.set(run.runId, item);
    return item.promise;
  });
  orchestrator.enqueue({
    runId: 'conv-a-first',
    source: { type: 'conversation', conversationId: 'conversation-a' },
  });
  orchestrator.enqueue({
    runId: 'conv-a-second',
    source: { type: 'conversation', conversationId: 'conversation-a' },
  });
  orchestrator.enqueue({
    runId: 'conv-b-first',
    source: { type: 'conversation', conversationId: 'conversation-b' },
  });
  orchestrator.start();

  assert.deepEqual(started, ['conv-a-first', 'conv-b-first']);
  assert.equal(ledger.get('conv-a-second').state, RUN_STATES.QUEUED);
  pending.get('conv-a-first').resolve();
  await until(() => started.includes('conv-a-second'));
  assert.equal(ledger.get('conv-a-second').state, RUN_STATES.RUNNING);
});

test('同一定时任务存在非终态实例时去重，终态后允许下一次入队', (t) => {
  const { orchestrator } = makeHarness(t);
  const first = orchestrator.enqueue({
    runId: 'schedule-first',
    kind: 'scheduled_chat',
    source: { type: 'schedule', scheduleId: 'daily-summary' },
  });
  const duplicate = orchestrator.enqueue({
    runId: 'schedule-duplicate',
    kind: 'scheduled_chat',
    source: { type: 'schedule', scheduleId: 'daily-summary' },
  });
  assert.equal(first.enqueued, true);
  assert.equal(duplicate.enqueued, false);
  assert.equal(duplicate.duplicateOf, 'schedule-first');
  assert.equal(duplicate.run.runId, 'schedule-first');

  orchestrator.cancel('schedule-first');
  const next = orchestrator.enqueue({
    runId: 'schedule-next',
    kind: 'scheduled_chat',
    source: { type: 'schedule', scheduleId: 'daily-summary' },
  });
  assert.equal(next.enqueued, true);
  assert.equal(next.run.runId, 'schedule-next');
});

test('排队任务可直接取消且永不进入执行器', (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  let calls = 0;
  orchestrator.registerExecutor('claude', () => { calls += 1; });
  orchestrator.enqueue({ runId: 'cancel-before-start' });

  const canceled = orchestrator.cancel('cancel-before-start', '用户不再需要');
  orchestrator.start();
  assert.equal(canceled.state, RUN_STATES.CANCELED);
  assert.equal(canceled.result.error.code, 'CANCELED_BEFORE_START');
  assert.equal(ledger.get('cancel-before-start').state, RUN_STATES.CANCELED);
  assert.equal(calls, 0);
});

test('existing execution leases share resource limits and queued cancellation resolves without starting', async (t) => {
  const { ledger, orchestrator } = makeHarness(t, { poolLimits: { image: 1 } });
  for (const runId of ['external-image-1', 'external-image-2', 'external-image-cancel']) {
    ledger.create({ runId, kind: 'image', state: RUN_STATES.QUEUED });
  }
  orchestrator.start();
  const firstPromise = orchestrator.acquireExisting('external-image-1', { resource: 'image' });
  await assert.rejects(
    orchestrator.acquireExisting('external-image-1', { resource: 'image' }),
    (error) => error && error.code === 'RUN_ALREADY_ACQUIRING',
  );
  const secondPromise = orchestrator.acquireExisting('external-image-2', { resource: 'image' });
  const canceledPromise = orchestrator.acquireExisting('external-image-cancel', { resource: 'image' });
  const first = await firstPromise;
  assert.equal(first.resource, 'image');
  assert.equal(orchestrator.getStats().active, 1);
  assert.equal(orchestrator.getStats().byResource.image.active, 1);
  assert.equal(ledger.get('external-image-2').state, RUN_STATES.QUEUED);
  orchestrator.cancel('external-image-cancel', 'no longer needed');
  assert.equal(await canceledPromise, null);
  assert.equal(ledger.get('external-image-cancel').state, RUN_STATES.CANCELED);
  ledger.terminal('external-image-1', RUN_STATES.SUCCEEDED);
  first.release();
  const second = await secondPromise;
  assert.equal(second.runId, 'external-image-2');
  ledger.terminal('external-image-2', RUN_STATES.SUCCEEDED);
  second.release();
});

test('运行任务取消会通知 executor handle，Promise 收尾后记为 canceled', async (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  const completion = deferred();
  const cancellations = [];
  orchestrator.registerExecutor('claude', (_run, context) => {
    context.registerHandle({
      cancel(reason) { cancellations.push(reason); },
    });
    return completion.promise;
  });
  orchestrator.enqueue({ runId: 'active-cancel' });
  orchestrator.start();

  const stopping = orchestrator.cancel('active-cancel', '用户点击停止');
  assert.equal(stopping.state, RUN_STATES.STOPPING);
  assert.deepEqual(cancellations, ['用户点击停止']);
  completion.resolve({ ok: true });
  await until(() => ledger.get('active-cancel').state === RUN_STATES.CANCELED);
  assert.equal(ledger.get('active-cancel').result.error.code, 'CANCELED');
});

test('健康检查按真实活动时间写入 silent/stalled，心跳可恢复为 ok', (t) => {
  const { ledger, orchestrator, advance } = makeHarness(t, {
    silentAfterMs: 2 * 60 * 1000,
    stalledAfterMs: 5 * 60 * 1000,
  });
  const completion = deferred();
  orchestrator.registerExecutor('claude', () => completion.promise);
  orchestrator.enqueue({ runId: 'health-run' });
  orchestrator.start();

  advance(2 * 60 * 1000);
  orchestrator.tickHealth();
  assert.equal(ledger.get('health-run').health, RUN_HEALTH.SILENT);
  advance(3 * 60 * 1000);
  orchestrator.tickHealth();
  assert.equal(ledger.get('health-run').health, RUN_HEALTH.STALLED);

  const heartbeat = orchestrator.heartbeat('health-run', {
    progress: { label: '收到新的工具输出' },
  });
  assert.equal(heartbeat.health, RUN_HEALTH.OK);
  assert.equal(heartbeat.progress.label, '收到新的工具输出');
});

test('启动恢复只重新调度 retained queued，不重跑已开始或 interrupted 任务', (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  ledger.create({ runId: 'retained-queued', kind: 'chat' });
  ledger.create({ runId: 'was-starting', kind: 'chat', state: RUN_STATES.STARTING });
  ledger.create({ runId: 'was-running', kind: 'chat', state: RUN_STATES.RUNNING });
  ledger.create({ runId: 'already-interrupted', kind: 'chat', state: RUN_STATES.STARTING });
  ledger.terminal('already-interrupted', RUN_STATES.INTERRUPTED);
  const executed = [];
  const completion = deferred();
  orchestrator.registerExecutor('claude', (run) => {
    executed.push(run.runId);
    return completion.promise;
  });

  const started = orchestrator.start({ reason: 'test restart' });
  assert.deepEqual(started.recovery.retainedQueued.map((run) => run.runId), ['retained-queued']);
  assert.deepEqual(new Set(started.recovery.interrupted.map((run) => run.runId)), new Set([
    'was-starting',
    'was-running',
  ]));
  assert.deepEqual(executed, ['retained-queued']);
  assert.equal(ledger.get('retained-queued').state, RUN_STATES.RUNNING);
  assert.equal(ledger.get('was-starting').state, RUN_STATES.INTERRUPTED);
  assert.equal(ledger.get('was-running').state, RUN_STATES.INTERRUPTED);
  assert.equal(ledger.get('already-interrupted').state, RUN_STATES.INTERRUPTED);
});

test('无执行器的持久队列保持 queued，注册执行器后自动开始', (t) => {
  const { ledger, orchestrator } = makeHarness(t);
  orchestrator.enqueue({ runId: 'wait-for-executor', kind: 'image' });
  orchestrator.start();
  assert.equal(ledger.get('wait-for-executor').state, RUN_STATES.QUEUED);

  const completion = deferred();
  let called = false;
  orchestrator.registerExecutor('image', () => {
    called = true;
    return completion.promise;
  });
  assert.equal(called, true);
  assert.equal(ledger.get('wait-for-executor').state, RUN_STATES.RUNNING);
});
