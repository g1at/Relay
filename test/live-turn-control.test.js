'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LiveTurnControls } = require('../src/main/live/live-turn-control');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);
function harness(overrides = {}) {
  const receipt = deferred(), idle = deferred(), close = deferred();
  const calls = { interrupt: 0, kill: 0, route: 0, unsent: 0 };
  const session = {
    jobId: 'old-job', convId: 'conversation', busy: true, dead: false,
    turnRouter: { interrupt() { calls.route++; } },
    child: { interrupt() { calls.interrupt++; return receipt.promise; } },
  };
  const controls = new LiveTurnControls({
    cancelPendingInput: () => false,
    settleUnsent: () => { calls.unsent++; session.busy = false; session.jobId = null; },
    withTimeout: promise => promise,
    waitForIdle: () => idle.promise,
    killSession: () => { calls.kill++; session.dead = true; return close.promise; },
    ...overrides,
  });
  return { controls, session, receipt, idle, close, calls };
}

test('duplicate pauses issue one SDK interrupt and reserve the conversation until the terminal result', async () => {
  const h = harness();
  const first = h.controls.interrupt(h.session), second = h.controls.interrupt(h.session);
  assert.equal(first, second);
  assert.equal(h.controls.pendingResult('old-job'), first);
  assert.equal(h.controls.isStopping('conversation'), true);
  await tick();
  assert.equal(h.calls.interrupt, 1);
  h.receipt.resolve({ still_queued: [] });
  await tick();
  assert.equal(h.controls.isStopping('conversation'), true);
  h.session.busy = false; h.session.jobId = null; h.idle.resolve(true);
  assert.deepEqual(await first, { aborted: true, settled: true, preservedSession: true, receipt: { still_queued: [] } });
  assert.equal(h.controls.isStopping('conversation'), false);
  assert.equal(h.calls.kill, 0);
});

test('terminal-before-receipt does not release the pause gate or submit another interrupt', async () => {
  const h = harness(), first = h.controls.interrupt(h.session);
  await tick();
  h.session.busy = false; h.session.jobId = null; h.idle.resolve(true);
  assert.equal(h.controls.interrupt(h.session), first);
  assert.equal(h.controls.isStopping('conversation'), true);
  h.receipt.resolve(undefined); // Older supported SDK has no receipt body.
  assert.equal((await first).settled, true);
  assert.equal(h.calls.interrupt, 1);
});

test('preparation-only pause cancels locally without sending a control request', async () => {
  const h = harness({ cancelPendingInput: () => true });
  assert.deepEqual(await h.controls.interrupt(h.session), {
    aborted: true, settled: true, preservedSession: true, preparingMcp: true,
  });
  assert.equal(h.calls.unsent, 1);
  assert.equal(h.calls.interrupt, 0);
});

test('natural completion before the interrupt starts never interrupts an idle query', async () => {
  const h = harness(), pending = h.controls.interrupt(h.session);
  h.session.busy = false; h.session.jobId = null;
  assert.equal((await pending).alreadyFinished, true);
  assert.equal(h.calls.interrupt, 0); assert.equal(h.calls.kill, 0);
  assert.equal(h.controls.isStopping('conversation'), false);
});

for (const cause of ['surviving-queue', 'unsupported-control', 'missing-terminal']) {
  test(`${cause} recycles but does not report settled before confirmed close`, async () => {
    const h = harness(), pending = h.controls.interrupt(h.session);
    if (cause === 'surviving-queue') h.receipt.resolve({ still_queued: ['queued-input'] });
    if (cause === 'unsupported-control') h.receipt.reject(Error('unsupported SDK control'));
    if (cause === 'missing-terminal') { h.receipt.resolve({}); h.idle.resolve(false); }
    await tick();
    assert.equal(h.calls.kill, 1);
    assert.equal(h.controls.isStopping('conversation'), true);
    let returned = false; pending.then(() => { returned = true; });
    await tick(); assert.equal(returned, false);
    h.close.resolve({ stopConfirmed: true });
    const result = await pending;
    assert.equal(result.aborted, true); assert.equal(result.settled, true);
    assert.equal(result.preservedSession, false);
    assert.equal(h.controls.isStopping('conversation'), false);
  });
}

test('bounded close timeout reports failure and keeps admission blocked until late actual close', async () => {
  const h = harness({ withTimeout: (promise, label) => label === '等待执行停止' ? Promise.reject(Error('synthetic timeout')) : promise });
  const pending = h.controls.interrupt(h.session);
  h.receipt.reject(Error('synthetic interrupt timeout'));
  const result = await pending;
  assert.equal(result.settled, false); assert.equal(result.aborted, false);
  assert.equal(h.controls.isStopping('conversation'), true);
  h.close.resolve({ stopConfirmed: true }); await tick();
  assert.equal(h.controls.isStopping('conversation'), false);
});

for (const receipt of ['reject', 'queued']) {
  test(`a late ${receipt} from an old pause cannot kill a newer run`, async () => {
    const h = harness(), pending = h.controls.interrupt(h.session);
    await tick();
    // Defense against an old caller bypassing the main admission gate.
    h.session.jobId = 'new-job'; h.session.busy = true;
    if (receipt === 'reject') h.receipt.reject(Error('old timeout'));
    else h.receipt.resolve({ still_queued: ['old-queued-input'] });
    assert.equal((await pending).alreadyFinished, true);
    assert.equal(h.calls.kill, 0); assert.equal(h.session.jobId, 'new-job');
  });
}

test('one-shot pause waits for its actual terminal and shares duplicate requests', async () => {
  const h = harness(), close = deferred(); let stops = 0;
  const child = { kill() { stops++; return close.promise; }, whenClosed: () => close.promise };
  const first = h.controls.stopOneShot(child, 'fallback-job', 'conversation');
  assert.equal(first, h.controls.stopOneShot(child, 'fallback-job', 'conversation'));
  await tick(); assert.equal(stops, 1); assert.equal(h.controls.isStopping('conversation'), true);
  close.resolve({ exitCode: -1 });
  assert.equal((await first).settled, true);
  assert.equal(h.controls.isStopping('conversation'), false);
});

const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function pauseIpc({ session = null, run = null, child = null, controlResult = null } = {}) {
  const handlers = {}, calls = [];
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    flushShadowTaskEvents() {}, taskLedger: { get: () => run },
    publicTaskRun: run => ({ state: run.state, result: run.result || null }),
    isTerminalState: state => ['succeeded', 'canceled', 'failed'].includes(state),
    RUN_STATES: { QUEUED: 'queued', STARTING: 'starting' },
    liveSessions: new Map(session ? [['conversation', session]] : []),
    jobs: new Map(child ? [['job', child]] : []),
    liveTurnControls: { pendingResult: () => controlResult,
      stopOneShot: async () => ({ aborted: true, settled: true, preservedSession: false }) },
    interruptLiveTurn: async () => { calls.push('interrupt'); return { aborted: true, settled: true, preservedSession: true }; },
    requestShadowTaskCancel: id => calls.push(['cancel', id]),
    taskOrchestrator: { cancel: id => calls.push(['queued-cancel', id]) },
    interactionBroker: { rejectTask() {} },
  };
  const start = source.indexOf("ipcMain.handle('claude:pause'");
  const end = source.indexOf("ipcMain.handle('tasks:snapshot'", start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  return { invoke: id => handlers['claude:pause']({}, id), calls };
}

test('pause IPC requires a job id and never turns missing executors into successful pause', async () => {
  const h = pauseIpc();
  assert.equal((await h.invoke(null)).settled, false);
  const missing = await h.invoke('job');
  assert.equal(missing.settled, false);
  assert.equal(missing.code, 'NOT_REGISTERED');
  const orphaned = await pauseIpc({ run: { state: 'running' } }).invoke('job');
  assert.equal(orphaned.settled, false);
  assert.equal(orphaned.code, 'STOP_NOT_CONFIRMED');
  assert.deepEqual(h.calls, []);
});

test('pause IPC returns the explicit settled/preserved contract for a live turn', async () => {
  const h = pauseIpc({ session: { busy: true, jobId: 'job' } });
  const result = await h.invoke('job');
  assert.equal(result.paused, true); assert.equal(result.settled, true);
  assert.equal(result.preservedSession, true); assert.equal(result.jobId, 'job');
  assert.deepEqual(h.calls, [['cancel', 'job'], 'interrupt']);
});

test('pause IPC waits pending control even when its ledger run already became terminal', async () => {
  const result = deferred();
  const h = pauseIpc({ run: { state: 'succeeded' }, controlResult: result.promise });
  let returned = false;
  const pending = h.invoke('job').then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false);
  result.resolve({ aborted: false, settled: false });
  assert.equal((await pending).paused, false);
});

test('queued/starting pause cancels admission and naturally completed runs remain complete', async () => {
  for (const state of ['queued', 'starting']) {
    const h = pauseIpc({ run: { state } });
    assert.equal((await h.invoke('job')).paused, true);
    assert.deepEqual(h.calls, [['queued-cancel', 'job']]);
  }
  const h = pauseIpc({ run: { state: 'succeeded' } });
  const terminal = await h.invoke('job');
  assert.equal(terminal.alreadyFinished, true);
  assert.equal(terminal.task.state, 'succeeded');
  assert.deepEqual(h.calls, []);
});

test('main rechecks stop/cancel after resource admission and never converts same-session busy into fallback', () => {
  const run = source.slice(source.indexOf("ipcMain.handle('claude:run'"), source.indexOf('// IPC: 丢弃某对话'));
  assert.equal((run.match(/liveTurnControls\.isStopping\(taskConversationId\)/g) || []).length, 2);
  assert.ok(run.indexOf('resourceLease.signal && resourceLease.signal.aborted') > run.indexOf('await acquireTaskResource'));
  const live = source.slice(source.indexOf('function runLiveTurn('), source.indexOf('// IPC: 启动一次 claude 对话'));
  const busy = live.match(/if \(sess && !sess\.dead && sess\.busy\) \{([\s\S]*?)\n  \}/);
  assert.ok(busy); assert.match(busy[1], /code: 'CONVERSATION_BUSY'/); assert.doesNotMatch(busy[1], /return null/);
});

test('queued run is registered before resource wait and canceled admission returns an explicit late-launch code', async () => {
  const run = source.slice(source.indexOf("ipcMain.handle('claude:run'"), source.indexOf('// IPC: 丢弃某对话'));
  const registration = run.indexOf('  createShadowTaskRun({');
  const admission = run.indexOf('  const resourceLease = await acquireTaskResource(');
  assert.ok(registration >= 0 && admission > registration);
  assert.doesNotMatch(run.slice(registration, admission), /\bawait\b/);
  const end = run.indexOf('  const releaseStartSlot =', admission);
  assert.ok(end > admission);
  const wait = deferred();
  const context = { acquireTaskResource: () => wait.promise, runId: 'queued-old-job', taskConversationId: 'old-conversation',
    taskClock: new (require('../src/main/tasks/task-clock').TaskClock)({ startedAt: 1000, now: () => 1200 }) };
  const pending = vm.runInNewContext(`(async () => { ${run.slice(admission, end)} })()`, context);
  wait.resolve(null);
  const result = await pending;
  assert.equal(result.code, 'TURN_CANCELED');
  assert.equal(result.error, '任务已取消');
  assert.equal(result.jobId, undefined, 'a canceled admission never reports a launched job');
});
