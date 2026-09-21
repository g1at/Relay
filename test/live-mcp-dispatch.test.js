'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dispatchLiveInput, cancelPendingLiveInput } = require('../live-mcp-dispatch');

// All preparation, input and observer APIs are in-memory doubles. Loading the
// actual dispatch helper and selected main functions never starts Relay/SDK/MCP.
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const preparation = deferred(), statuses = [], failures = [], pushes = [], preparations = [];
  const servers = { fixture: { type: 'http', url: 'https://mcp.example.invalid/synthetic' } };
  const session = {
    convId: 'synthetic-conversation', jobId: 'original-uuid', busy: true, dead: false,
    sessionId: 'preserved-sdk-session',
    child: {
      prepareMcp: options => { preparations.push(options); return preparation.promise; },
      push: (text, metadata) => { pushes.push({ text, metadata }); return true; },
    },
  };
  const sessions = new Map([[session.convId, session]]);
  const dispatch = (overrides = {}) => dispatchLiveInput({
    session, jobId: session.jobId, prompt: 'synthetic user message',
    loadServers: () => servers,
    isSessionCurrent: () => sessions.get(session.convId) === session,
    onStatus: result => statuses.push(copy(result)),
    onFailure: message => failures.push(message),
    ...overrides,
  });
  return { session, sessions, preparation, statuses, failures, pushes, preparations, servers, dispatch };
}
const connected = { ok: true, items: [{ name: 'fixture', status: 'connected' }] };

test('failed MCP reconnect does not hold input, background status updates only the owning run', async () => {
  const h = harness(), background = deferred();
  h.session.child.prepareMcp = async options => {
    h.preparations.push(options);
    return options.reconnect === false
      ? { ok: false, code: 'MCP_NOT_READY', items: [{ name: 'fixture', status: 'failed' }] }
      : background.promise;
  };
  const pending = h.dispatch(); await pending.done;
  assert.equal(h.pushes.length, 1); assert.equal(h.preparations.length, 2);
  assert.equal(h.statuses.at(-1).code, 'MCP_NOT_READY');
  h.session.jobId = 'another-run'; background.resolve(connected);
  await h.session.mcpBackgroundPreparation;
  assert.equal(h.pushes.length, 1); assert.equal(h.statuses.at(-1).code, 'MCP_NOT_READY');
});

test('background MCP completion follows active run without resending its prompt', async () => {
  const h = harness(), background = deferred();
  h.session.child.prepareMcp = async options => options.reconnect === false
    ? { ok: false, code: 'MCP_NOT_READY', items: [] } : background.promise;
  await h.dispatch().done;
  background.resolve(connected); await h.session.mcpBackgroundPreparation;
  assert.equal(h.pushes.length, 1); assert.equal(h.statuses.at(-1).ok, true);
  assert.deepEqual(h.failures, []);
});

for (const stopped of [{ canceled: true }, { stale: true, code: 'MCP_PREPARE_SUPERSEDED' }]) {
  test(`background ${stopped.canceled ? 'cancellation' : 'superseded registry'} cannot overwrite the current tool status`, async () => {
    const h = harness(), background = deferred();
    h.session.child.prepareMcp = async options => options.reconnect === false
      ? { ok: false, code: 'MCP_NOT_READY', items: [] } : background.promise;
    await h.dispatch().done;
    const before = copy(h.statuses);
    background.resolve({ ok: false, items: [{ name: 'removed-tool', status: 'connected' }], ...stopped });
    await h.session.mcpBackgroundPreparation;
    assert.deepEqual(h.statuses, before);
    assert.equal(h.pushes.length, 1);
  });
}

test('a superseded send preparation reloads the registry before delivering its prompt', async () => {
  const h = harness(), replacement = { replacement: { command: 'synthetic-new' } }, seen = [];
  h.session.child.prepareMcp = async options => {
    seen.push(options.servers);
    return seen.length === 1 ? { ok: false, stale: true, items: [] } : connected;
  };
  await h.dispatch({ loadServers: () => seen.length ? replacement : h.servers }).done;
  assert.deepEqual(seen, [h.servers, replacement]);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.statuses.filter(value => value.phase === 'settled').length, 1);
  assert.deepEqual(h.failures, []);
});

test('continuous registry changes stop preparation without sending an obsolete tool snapshot', async () => {
  const h = harness(); let preparations = 0;
  h.session.child.prepareMcp = async () => { preparations++; return { ok: false, stale: true, items: [] }; };
  await h.dispatch().done;
  assert.equal(preparations, 3);
  assert.deepEqual(h.pushes, []);
  assert.equal(h.failures.length, 1);
  assert.equal(h.session.pendingInput, null);
  assert.equal(h.statuses.some(value => value.phase === 'settled'), false);
});

test('preparation gates all input, then pushes once with the original UUID', async () => {
  const h = harness(), pending = h.dispatch();
  assert.equal(h.session.pendingInput, pending);
  assert.deepEqual(h.pushes, []);
  await Promise.resolve();
  assert.deepEqual(h.statuses, [{ phase: 'preparing', items: [] }]);
  assert.equal(h.preparations.length, 1);
  assert.equal(h.preparations[0].servers, h.servers);
  assert.equal(h.preparations[0].timeoutMs, 15000);
  assert.equal(h.preparations[0].signal, pending.controller.signal);
  assert.deepEqual(h.pushes, []);
  h.preparation.resolve(connected); await pending.done; await pending.done;
  assert.deepEqual(h.pushes, [{ text: 'synthetic user message', metadata: { uuid: 'original-uuid' } }]);
  assert.deepEqual(h.statuses[1], { phase: 'settled', ...connected });
  assert.equal(h.session.pendingInput, null);
  assert.deepEqual(h.failures, []);
});

test('failed MCP servers retain a visible failed state while ordinary input is delivered', async () => {
  const h = harness(), pending = h.dispatch();
  h.preparation.resolve({ ok: false, code: 'unavailable', items: [
    { name: 'fixture', status: 'failed' }, { name: 'other', status: 'connected' },
  ] });
  await pending.done;
  assert.equal(h.pushes.length, 1); assert.deepEqual(h.failures, []);
  assert.equal(h.statuses[1].phase, 'settled'); assert.equal(h.statuses[1].ok, false);
  assert.equal(h.statuses[1].items[0].status, 'failed');
  assert.equal(h.statuses[1].items[1].status, 'connected');
});

test('cancellation before preparation prevents both control work and input delivery', async () => {
  const h = harness(), pending = h.dispatch();
  assert.equal(cancelPendingLiveInput(h.session), true);
  assert.equal(cancelPendingLiveInput(h.session), false);
  assert.equal(cancelPendingLiveInput(null), false);
  assert.equal(pending.controller.signal.aborted, true);
  await pending.done;
  assert.deepEqual(h.preparations, []); assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.statuses, []); assert.deepEqual(h.failures, []);
});

test('a canceled preparation cannot send late or clear a newer pending job', async () => {
  const h = harness(), old = h.dispatch();
  await Promise.resolve();
  cancelPendingLiveInput(h.session);
  const nextReady = deferred();
  h.session.jobId = 'next-uuid';
  h.session.child.prepareMcp = () => nextReady.promise;
  const next = h.dispatch({ prompt: 'next message' });
  await Promise.resolve();
  h.preparation.resolve(connected); await old.done;
  assert.equal(h.session.pendingInput, next); assert.deepEqual(h.pushes, []);
  nextReady.resolve(connected); await next.done;
  assert.deepEqual(h.pushes, [{ text: 'next message', metadata: { uuid: 'next-uuid' } }]);
  assert.equal(h.session.pendingInput, null); assert.deepEqual(h.failures, []);
});

for (const change of ['replace-session', 'remove-session', 'mark-dead', 'end-turn', 'change-job']) {
  test(`${change} during preparation prevents stale input delivery`, async () => {
    const h = harness(), pending = h.dispatch();
    await Promise.resolve();
    if (change === 'replace-session') h.sessions.set(h.session.convId, { jobId: 'replacement' });
    if (change === 'remove-session') h.sessions.delete(h.session.convId);
    if (change === 'mark-dead') h.session.dead = true;
    if (change === 'end-turn') h.session.busy = false;
    if (change === 'change-job') h.session.jobId = 'new-job';
    h.preparation.resolve(connected); await pending.done;
    assert.deepEqual(h.pushes, []); assert.deepEqual(h.failures, []);
    assert.deepEqual(h.statuses, [{ phase: 'preparing', items: [] }]);
  });
}

for (const failure of ['configuration', 'control-reject', 'control-throw']) {
  test(`${failure} reports only a generic MCP state and never forwards raw exception text`, async () => {
    const h = harness();
    const unsafe = new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_DO_NOT_DISPLAY');
    const options = failure === 'configuration' ? { loadServers() { throw unsafe; } } : {};
    if (failure === 'control-throw') h.session.child.prepareMcp = () => { throw unsafe; };
    const pending = h.dispatch(options);
    await Promise.resolve();
    if (failure === 'control-reject') h.preparation.reject(unsafe);
    await pending.done;
    assert.deepEqual(h.statuses.at(-1), { phase: 'settled', ok: false, code: 'configuration-or-control', items: [] });
    assert.doesNotMatch(JSON.stringify([h.statuses, h.failures]), /SYNTHETIC_PRIVATE/);
    assert.equal(h.pushes.length, 1); assert.deepEqual(h.failures, []);
  });
}

for (const failure of ['false', 'throw']) {
  test(`push ${failure} reports one generic failure and clears pending input`, async () => {
    const h = harness(); let attempts = 0;
    h.session.child.push = () => { attempts++; if (failure === 'throw') throw Error('SYNTHETIC_PRIVATE_PUSH_DETAIL'); return false; };
    const pending = h.dispatch();
    h.preparation.resolve(connected); await pending.done; await pending.done;
    assert.equal(attempts, 1);
    assert.deepEqual(h.failures, ['输入未能发送，请重试']);
    assert.equal(h.session.pendingInput, null);
    assert.equal(cancelPendingLiveInput(h.session), false);
  });
}

test('status observers cannot make cancellation send input or replace the current pending job', async () => {
  const h = harness();
  const pending = h.dispatch({ onStatus(result) { h.statuses.push(copy(result)); if (result.phase === 'settled') cancelPendingLiveInput(h.session); } });
  h.preparation.resolve(connected); await pending.done;
  assert.deepEqual(h.pushes, []); assert.deepEqual(h.failures, []);
  assert.equal(pending.controller.signal.aborted, true);
});

test('a presentation-only observer failure does not duplicate or drop a prepared send', async () => {
  const h = harness(), pending = h.dispatch({ onStatus() { throw Error('synthetic renderer observer error'); } });
  h.preparation.resolve(connected); await pending.done;
  assert.equal(h.pushes.length, 1); assert.deepEqual(h.failures, []);
});

function mainHarness() {
  const h = harness(), events = [], rejected = [], unavailable = [], calls = [];
  const session = h.session;
  session.onEvent = event => events.push(copy(event));
  session.turnRouter = { end: () => calls.push('router.end'), interrupt: () => calls.push('router.interrupt') };
  session.asyncAgentTracker = { reset: () => calls.push('agent.reset') };
  session.backgroundTaskTracker = { reset: () => calls.push('background.reset') };
  session.keepAliveForAsyncAgents = true; session.orchestrateMode = true;
  session.child.interrupt = async () => { calls.push('sdk.interrupt'); return {}; };
  const context = {
    settleLiveSupplements() { return []; },
    cancelPendingLiveInput,
    interactionBroker: { rejectTask: (id, options) => rejected.push({ id, ...copy(options) }) },
    checkpointManager: {}, markCheckpointUnavailable: (id, reason) => unavailable.push({ id, reason }),
    touchIdleTimer: () => calls.push('idle'), refreshTrayMenu: () => calls.push('tray'),
    console: { log() {}, warn() {} }, withLiveControlTimeout: promise => promise,
    waitForLiveTurnIdle: async () => true,
    killLiveSession: () => calls.push('kill'),
  };
  const start = main.indexOf('function settleUnsentLiveTurn(');
  const end = main.indexOf('// IPC: 中止任务', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(main.slice(start, end), context);
  context.liveTurnControls = new (require('../live-turn-control').LiveTurnControls)({
    cancelPendingInput: cancelPendingLiveInput, settleUnsent: context.settleUnsentLiveTurn,
    withTimeout: context.withLiveControlTimeout, waitForIdle: context.waitForLiveTurnIdle, killSession: context.killLiveSession,
  });
  return { ...h, context, events, rejected, unavailable, calls };
}

test('real preparation stop produces one terminal, preserves the session, and never calls SDK interrupt', async () => {
  const h = mainHarness(), pending = h.dispatch();
  await Promise.resolve();
  const result = await h.context.interruptLiveTurn(h.session);
  assert.deepEqual(copy(result), { aborted: true, settled: true, preservedSession: true, preparingMcp: true });
  assert.equal(pending.controller.signal.aborted, true);
  assert.equal(h.session.busy, false); assert.equal(h.session.jobId, null); assert.equal(h.session.onEvent, null);
  assert.equal(h.session.sessionId, 'preserved-sdk-session'); assert.equal(h.session.dead, false);
  assert.equal(h.sessions.get(h.session.convId), h.session);
  assert.equal(h.session.keepAliveForAsyncAgents, false); assert.equal(h.session.orchestrateMode, false);
  assert.deepEqual(h.events, [{ jobId: 'original-uuid', type: 'job-done', exitCode: -1, error: '已停止，本轮输入尚未发送', aborted: true }]);
  assert.deepEqual(h.rejected, [{ id: 'original-uuid', message: '已停止，本轮输入尚未发送', interrupt: false }]);
  assert.deepEqual(h.unavailable, [{ id: 'original-uuid', reason: '本轮输入尚未发送' }]);
  assert.deepEqual(h.calls, ['router.end', 'agent.reset', 'background.reset', 'idle', 'tray']);
  h.preparation.resolve(connected); await pending.done;
  assert.equal(h.context.settleUnsentLiveTurn(h.session, 'original-uuid', 'duplicate', true), false);
  assert.equal(h.events.length, 1); assert.deepEqual(h.pushes, []); assert.deepEqual(h.failures, []);
});

test('an old unsent-turn settlement cannot terminate the next job or cancel its preparation', async () => {
  const h = mainHarness(), old = h.dispatch();
  await Promise.resolve(); await h.context.interruptLiveTurn(h.session);
  h.session.busy = true; h.session.jobId = 'next-uuid';
  h.session.onEvent = event => h.events.push(copy(event));
  const ready = deferred(); h.session.child.prepareMcp = () => ready.promise;
  const next = h.dispatch({ prompt: 'next user message' });
  await Promise.resolve();
  assert.equal(h.context.settleUnsentLiveTurn(h.session, 'original-uuid', 'late failure', false), false);
  assert.equal(h.session.pendingInput, next); assert.equal(next.controller.signal.aborted, false);
  h.preparation.reject(Error('late private control failure')); await old.done;
  assert.equal(h.session.busy, true); assert.equal(h.session.jobId, 'next-uuid');
  assert.equal(h.events.length, 1); assert.deepEqual(h.failures, []);
  ready.resolve(connected); await next.done;
  assert.deepEqual(h.pushes, [{ text: 'next user message', metadata: { uuid: 'next-uuid' } }]);
});

test('real unsent failure settlement emits exactly one failed terminal after a rejected push', async () => {
  const h = mainHarness();
  h.session.child.push = () => false;
  const pending = h.dispatch({ onFailure: message => h.context.settleUnsentLiveTurn(h.session, 'original-uuid', message, false) });
  h.preparation.resolve(connected); await pending.done;
  assert.equal(h.events.length, 1); assert.equal(h.events[0].aborted, false);
  assert.equal(h.events[0].error, '输入未能发送，请重试');
  assert.equal(h.context.settleUnsentLiveTurn(h.session, 'original-uuid', 'duplicate', false), false);
  assert.equal(h.events.length, 1); assert.equal(h.session.busy, false);
  assert.equal(h.calls.includes('sdk.interrupt'), false);
});

test('pausing a pending mode command waits for Query close before admitting continuation', async () => {
  const h = mainHarness(), mode = deferred(), closed = deferred();
  h.context.liveTurnControls.killSession = () => { h.calls.push('kill'); return closed.promise; };
  const pending = h.dispatch({ prepareInput: () => mode.promise });
  await new Promise(setImmediate);
  assert.equal(pending.modePreparationPending, true);
  const stopping = h.context.interruptLiveTurn(h.session);
  await new Promise(setImmediate);
  assert.equal(pending.controller.signal.aborted, true);
  assert.equal(h.context.liveTurnControls.isStopping(h.session.convId), true);
  assert.equal(h.calls.filter(call => call === 'kill').length, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].aborted, true);
  mode.resolve(); h.preparation.resolve(connected);
  await pending.done;
  assert.equal(h.pushes.length, 0);
  assert.equal(h.context.liveTurnControls.isStopping(h.session.convId), true);
  closed.resolve({ exitCode: -1, stopConfirmed: true });
  const result = await stopping;
  assert.equal(result.settled, true);
  assert.equal(result.preservedSession, false);
  assert.equal(h.context.liveTurnControls.isStopping(h.session.convId), false);
  assert.equal(h.events.length, 1);
});

test('pausing MCP preparation after mode commands settle still preserves the Query', async () => {
  const h = mainHarness();
  const pending = h.dispatch({ prepareInput: async () => ({ ok: true }) });
  await new Promise(setImmediate);
  assert.equal(pending.modePreparationPending, false);
  const result = await h.context.interruptLiveTurn(h.session);
  assert.equal(result.preservedSession, true);
  assert.equal(h.calls.includes('kill'), false);
  h.preparation.resolve(connected); await pending.done;
  assert.equal(h.pushes.length, 0);
});

for (const first of ['mode', 'mcp']) {
  test(`mode and MCP preparations overlap, but neither can send alone (${first} first)`, async () => {
    const h = harness(), mode = deferred();
    let modeCalls = 0;
    const pending = h.dispatch({ prepareInput: () => { modeCalls++; return mode.promise; } });
    await new Promise(setImmediate);
    assert.equal(modeCalls, 1);
    assert.equal(h.preparations.length, 1);
    if (first === 'mode') mode.resolve(); else h.preparation.resolve(connected);
    await new Promise(setImmediate);
    assert.equal(h.pushes.length, 0);
    if (first === 'mode') h.preparation.resolve(connected); else mode.resolve();
    await pending.done;
    assert.equal(h.pushes.length, 1);
  });
}

test('failed mode immediately aborts concurrent MCP work and never sends a late result', async () => {
  const h = harness(), mode = deferred();
  const pending = h.dispatch({ prepareInput: () => mode.promise });
  await new Promise(setImmediate);
  mode.reject(Error('目标暂不可用'));
  await pending.done;
  assert.equal(pending.controller.signal.aborted, true);
  assert.equal(h.session.pendingInput, null);
  assert.deepEqual(h.failures, ['目标暂不可用']);
  assert.equal(h.pushes.length, 0);
  h.preparation.reject(Error('late MCP failure'));
  await new Promise(setImmediate);
  assert.equal(h.statuses.length, 1);
  assert.deepEqual(h.failures, ['目标暂不可用']);
});

for (const stage of ['initialization', 'mode', 'input']) {
  test(`${stage} failure records its stage without logging private error details`, async () => {
    const h = harness(), diagnostics = [];
    const error = Object.assign(Error('SYNTHETIC_PRIVATE_DETAIL'), {
      code: stage === 'mode' ? 'MODE_PREPARE_TIMEOUT' : 'SYNTHETIC_PRIVATE_CODE',
      prompt: 'SYNTHETIC_PRIVATE_PROMPT',
    });
    const options = { onFailure: (_message, diagnostic) => diagnostics.push(diagnostic) };
    if (stage === 'initialization') h.session.child.whenReady = async () => { throw error; };
    if (stage === 'mode') options.prepareInput = async () => { throw error; };
    if (stage === 'input') h.session.child.push = () => { throw error; };
    h.preparation.resolve(connected);
    await h.dispatch(options).done;
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, stage);
    assert.equal(diagnostics[0].code, stage === 'mode' ? 'MODE_PREPARE_TIMEOUT' : 'INPUT_PREPARATION_FAILED');
    assert.ok(diagnostics[0].elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC_PRIVATE/);
    assert.equal(h.pushes.length, 0);
  });
}

test('cold Query initialization does not consume the bounded MCP preparation window', async () => {
  const h = harness(), initialized = deferred(), mode = deferred();
  let modeCalls = 0;
  h.session.child.whenReady = ({ signal }) => {
    assert.equal(signal.aborted, false);
    return initialized.promise;
  };
  const pending = h.dispatch({ prepareInput: () => { modeCalls++; return mode.promise; } });
  await new Promise(setImmediate);
  assert.deepEqual(h.statuses, [{ phase: 'preparing', stage: 'initializing', items: [] }]);
  assert.equal(modeCalls, 0);
  assert.equal(h.preparations.length, 0);
  initialized.resolve();
  await new Promise(setImmediate);
  assert.equal(modeCalls, 1);
  assert.equal(h.preparations.length, 1);
  assert.equal(h.preparations[0].timeoutMs, 15000);
  assert.equal(h.pushes.length, 0);
  mode.resolve(); h.preparation.resolve(connected);
  await pending.done;
  assert.equal(h.pushes.length, 1);
});

for (const action of ['cancel', 'reject']) {
  test(`${action} during cold initialization prevents subsequent MCP/mode work`, async () => {
    const h = harness(), initialized = deferred();
    let modeCalls = 0;
    h.session.child.whenReady = () => initialized.promise;
    const pending = h.dispatch({ prepareInput: () => { modeCalls++; } });
    await new Promise(setImmediate);
    if (action === 'cancel') {
      cancelPendingLiveInput(h.session);
      initialized.resolve();
    } else initialized.reject(Error('会话初始化失败'));
    await pending.done;
    assert.equal(modeCalls, 0);
    assert.equal(h.preparations.length, 0);
    assert.equal(h.pushes.length, 0);
    assert.deepEqual(h.failures, action === 'cancel' ? [] : ['会话初始化失败']);
  });
}

test('mode preparation can return a resumed goal prompt and replace attachment ownership', async () => {
  const h = harness();
  const pending = h.dispatch({ files: [{ path: '/fixture/original.png', name: 'original.png' }],
    prepareInput: async () => ({ prompt: '继续完成原目标', files: [] }) });
  h.preparation.resolve(connected);
  await pending.done;
  assert.deepEqual(h.pushes, [{ text: '继续完成原目标', metadata: { uuid: 'original-uuid' } }]);
});


for (const withInitialization of [false, true]) {
  test(`preparation observer cancellation starts no subsequent controls (initialization=${withInitialization})`, async () => {
    const h = harness(); let started = 0;
    if (withInitialization) h.session.child.whenReady = async () => { started++; };
    const pending = h.dispatch({ prepareInput: async () => { started++; },
      onStatus() { cancelPendingLiveInput(h.session); } });
    await pending.done;
    assert.equal(started, 0);
    assert.equal(h.preparations.length, 0);
    assert.equal(h.pushes.length, 0);
    assert.deepEqual(h.failures, []);
  });
}
