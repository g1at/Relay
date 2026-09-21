'use strict';

// Execute actual main admission + live dispatch code with an in-memory Query
// and ledger. Do not load Electron, real history, providers, MCP or model APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const execution = require('../execution-modes');
const { dispatchLiveInput, cancelPendingLiveInput } = require('../live-mcp-dispatch');
const { LiveTurnRouter } = require('../live-turn-router');
const { LiveAsyncAgentTracker, LiveBackgroundTaskTracker } = require('../live-async-agent-tracker');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function declaration(name) {
  const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, name);
  const tail = source.slice(start), end = /\n(?:async )?function \w+\(/.exec(tail);
  return end ? tail.slice(0, end.index) : tail;
}
const convId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000001';
function harness({ liveAvailable = true, prepareMode, prepareMcp, clock = { now: Date.now() } } = {}) {
  const calls = { mode: [], mcp: [], pushes: [], oneShot: [], ledger: [], failures: [], releases: 0, events: [], kills: 0 };
  const liveSessions = new Map(); let handler; let lastSession;
  const runtime = { id: 'fixture-provider', revision: 1, modelId: 'vendor/fixture-model', routeRevision: 1 };
  const context = {
    TaskClock: class extends require('../task-clock').TaskClock { constructor(options) { super({ ...options, now: () => clock.now }); } },
    ...execution, crypto, path, dispatchLiveInput, cancelPendingLiveInput,
    ...require('../live-prewarm-reuse'),
    ...require('../conversation-goals'), goalConditionValue: require('../conversation-goals').condition,
    console: { log() {}, warn() {}, error() {} },
    liveSessions, memoryRequestContexts: new Map(), liveTombstones: new Map(), liveTurnControls: { isStopping: () => false }, miniChat: null,
    workspaceKey: value => value, sessionFingerprint: () => 'same-fixture',
    conversationRuntimeContract: () => ({ fingerprint: 'fixture-contract', policy: { settingSources: ['user'], settings: {} } }),
    requiresFreshContract: require('../sdk-runtime-contract').requiresFreshContract,
    relayModelTier: () => 'haiku', activeRelayProviderRuntime: () => runtime,
    providerSessionRoute: () => ({ providerId: runtime.id }), sessionRouteMatchesProvider: () => true,
    getConversationWorkspaces: () => ({ acceptsSession: () => true, markContextCarried() {} }),
    resolveExecutionWorkspace: options => ({ conversationId: options.conversationId, cwd: '/fixture/workspace', validWorkingDir: null, agentProjectRoot: null }),
    waitForCheckpointUnlock: async () => true, conversationContext: require('../conversation-workspaces').conversationContext,
    compactText: value => value, loadConversation: () => null,
    RUN_STATES: { QUEUED: 'queued', STARTING: 'starting', CANCELED: 'canceled' }, TASK_EVENT_EPOCH: 'fixture-epoch',
    taskLedger: { get: () => null, update: (id, data) => calls.ledger.push({ id, ...data }) },
    createShadowTaskRun: data => calls.ledger.push(data),
    acquireTaskResource: async () => ({ signal: new AbortController().signal, release: () => calls.releases++ }),
    finishShadowTaskRun: (id, ok, data) => calls.failures.push({ id, ok, ...data }),
    releaseTaskResource: () => calls.releases++,
    readAppSettings: () => ({ permissionMode: 'bypassPermissions' }),
    readClaudeMcpRegistry: () => ({ ok: true, enabled: { fixture: { type: 'stdio', command: 'never-executed' } } }),
    touchIdleTimer() {}, refreshTrayMenu() {}, checkpointManager: null,
    mcpTreeIntact: () => true, evictIfNeeded: () => liveAvailable,
    killLiveSession: sess => { calls.kills++; sess.dead = true; liveSessions.delete(sess.convId); },
    settleUnsentLiveTurn: (sess, id, message, aborted) => { calls.failures.push({ id, message, aborted }); sess.busy = false; },
    spawnLiveSession(options) {
      const sess = { ...options, sessionId: options.sessionId, fingerprint: 'same-fixture', launchSpec: { cwd: options.cwd, runtimeFingerprint: options.runtimeContract?.fingerprint }, dead: false, busy: false,
        turnRouter: new LiveTurnRouter(), asyncAgentTracker: new LiveAsyncAgentTracker(), backgroundTaskTracker: new LiveBackgroundTaskTracker(),
        checkpointRunIds: new Set(), child: {
          async prepareExecutionMode(mode, opts) { calls.mode.push({ mode: clone(mode), options: opts });
            if (prepareMode) return prepareMode(mode, opts);
            return { ok: true, executionMode: mode, permissionMode: mode.kind === 'plan' ? 'plan' : opts.permissionMode };
          },
          async prepareMcp(opts) { calls.mcp.push(opts); return prepareMcp ? prepareMcp(opts) : { ok: true, items: [] }; },
          push(text, metadata) { calls.pushes.push({ text, metadata }); return true; },
        } };
      liveSessions.set(options.convId, sess); lastSession = sess; return sess;
    },
    runClaudeJob: options => { calls.oneShot.push(options); return { jobId: options.runId, providerId: runtime.id }; },
    fs: { existsSync: () => true, readdirSync: () => [] }, AGENTS_DIR: '/fixture/agents',
    listAgentNames: () => [], promptNeedsFeishu: () => false, promptMaybeCron: () => false,
    FEISHU_HINT: '', ASK_HINT: '\n[synthetic ask hint]', IMAGE_HINT: '\n[synthetic image hint]', buildMemoryHint: () => '\n[synthetic memory hint]',
    journalClaudeEvent() {}, enqueueShadowClaudeEvent() {}, flushShadowTaskEvents() {},
    ipcMain: { handle(name, value) { assert.equal(name, 'claude:run'); handler = value; } },
  };
  const permissions = require('./helpers/conversation-permissions-fixture')(context);
  const record = { id: convId, permissionMode: 'bypassPermissions', permissionRevision: 1, executionMode: { kind: 'default' } };
  context.loadConversation = () => record;
  context.taskContinuityHost = new (require('../task-continuity-host').TaskContinuityHost)({ loadConversation: id => context.loadConversation(id) });
  context.persistConversationRecord = value => Object.assign(record, clone(value));
  vm.createContext(context); vm.runInContext(declaration('persistGoalRecovery'), context); vm.runInContext(declaration('runLiveTurn'), context);
  const start = source.indexOf("ipcMain.handle('claude:run',"); assert.ok(start >= 0);
  // Include the shared main/mini admission function behind the thin IPC wrapper.
  const end = source.indexOf('// IPC: 丢弃某对话', start); assert.ok(end > start);
  vm.runInContext(source.slice(start, end), context);
  return { calls, context, liveSessions, get session() { return lastSession; },
    send: async payload => {
      // UI changes modes through the dedicated host API before sending a turn.
      if (payload && payload.executionMode && ['default', 'plan', 'goal'].includes(payload.executionMode.kind)) {
        await permissions.set({ conversationId: convId, permissionMode: record.permissionMode, executionMode: payload.executionMode });
      }
      return handler({ sender: { send: (_name, event) => calls.events.push(event) } }, { prompt: 'fixture request', convId, runId, mode: 'plain', model: 'haiku', ...payload });
    } };
}

test('main goal admission sends the original condition and preserves full built context, after parallel mode and MCP preparation', async () => {
  const ready = deferred(), h = harness({ prepareMode: () => ready.promise });
  const result = await h.send({ prompt: '目标任务', executionMode: { kind: 'goal' }, files: [{ path: '/fixture/' + 'attachment'.repeat(700), name: 'attachment' }] });
  assert.equal(result.jobId, runId);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.mode[0].mode, { kind: 'goal' });
  assert.ok(h.calls.mode[0].options.contextFiles[0].path.length > 4000);
  assert.match(h.calls.mode[0].options.contextPrompt, /synthetic memory hint/);
  assert.equal(h.calls.mcp.length, 1); assert.equal(h.calls.pushes.length, 0);
  const pending = h.session.pendingInput;
  ready.resolve({ ok: true, executionMode: { kind: 'goal' }, permissionMode: 'bypassPermissions' });
  await pending.done;
  assert.equal(h.calls.mcp.length, 1);
  assert.equal(h.calls.pushes[0].text, '/goal 目标任务'); assert.equal(h.calls.pushes[0].metadata.uuid, runId);
  assert.equal(h.calls.oneShot.length, 0);
});

test('main rebuilds resumed task timing from saved history and preserves the durable goal', async () => {
  const clock = { now: 100000 }, h = harness({ clock });
  const Continuity = require('../renderer/task-continuity');
  const record = h.context.loadConversation(convId);
  record.goalRecovery = { condition: 'original completion condition' };
  record.paused = { runId, at: new Date(37000).toISOString() };
  const prior = Continuity.finish(Continuity.begin({ runId, startedAt: 1000 }), { finishedAt: 37000 });
  record.turns = [{ runId, user: '/goal original completion condition', status: 'paused', executionMode: { kind: 'goal' }, taskRun: prior }];
  const nextId = '20000000-0000-4000-8000-000000000002';
  const taskRun = Continuity.begin({ runId: nextId, startedAt: clock.now, conversation: record, resumedFromRunId: runId });
  record.turns.push({ runId: nextId, user: '', inputKind: 'resume', taskRun });
  const result = await h.send({ runId: nextId, taskStartedAt: clock.now, prompt: Continuity.RESUME_PROMPT,
    executionMode: { kind: 'goal' }, taskContext: { inputKind: 'resume', taskRun: { ...taskRun, elapsedBeforeMs: 99000 },
      userPrompt: 'malicious replacement goal', goalExplicit: true } });
  await h.session.pendingInput.done;
  assert.equal(result.relay_task_id, runId);
  assert.equal(result.relay_task_elapsed_before_ms, 36000);
  assert.equal(result.relay_task_segment_started_at, 100000);
  assert.equal(h.calls.mode[0].options.goalCondition, 'original completion condition');
  assert.equal(h.calls.mode[0].options.goalExplicit, false);
  assert.equal(h.calls.pushes[0].text, '/goal original completion condition');
  clock.now = 167000;
  h.session.onEvent({ jobId: nextId, type: 'job-done', parentToolUseId: 'child', exitCode: 0 });
  assert.equal(h.calls.events.at(-1).relay_task_finished_at, undefined);
  h.session.onEvent({ jobId: nextId, type: 'job-done', exitCode: 0 });
  assert.equal(h.calls.events.at(-1).relay_task_duration_ms, 103000);
});

test('main rejects stale or cross-conversation resume metadata before dispatch', async () => {
  const h = harness({ clock: { now: 100000 } });
  const result = await h.send({ taskContext: { inputKind: 'resume', taskRun: {
    version: 1, taskId: 'foreign', resumedFromRunId: 'foreign', rootStartedAt: 1000,
    segmentStartedAt: 100000, elapsedBeforeMs: 36000 } } });
  assert.equal(result.code, 'INVALID_TASK_CONTINUITY');
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.calls.oneShot.length, 0);
});

test('plan is session-scoped and a later explicit default run restores the configured permission through preparation', async () => {
  const h = harness(); await h.send({ executionMode: { kind: 'plan' } }); await h.session.pendingInput.done;
  assert.equal(h.session.permissionMode, 'plan');
  assert.equal(h.calls.mode[0].options.permissionMode, 'bypassPermissions');
  assert.match(h.calls.pushes[0].text, /^当前会话处于只读计划模式/);
  const previous = h.session; previous.busy = false; previous.turnRouter.end();
  await h.send({ runId: '20000000-0000-4000-8000-000000000002', executionMode: { kind: 'default' } }); await h.session.pendingInput.done;
  assert.equal(h.session, previous);
  assert.equal(h.calls.mode[1].mode.kind, 'default'); assert.equal(h.session.permissionMode, 'bypassPermissions');
  assert.equal(h.calls.oneShot.length, 0);
});

test('invalid goal or unsupported mode is rejected before workspace creation and resource admission', async () => {
  const h = harness(); let workspaceCalls = 0;
  h.context.resolveExecutionWorkspace = () => { workspaceCalls++; throw Error('should not resolve'); };
  assert.equal((await h.send({ executionMode: { kind: 'goal' }, prompt: 'x'.repeat(4001) })).code, 'GOAL_TOO_LONG');
  assert.equal((await h.send({ executionMode: { kind: 'fake' } })).code, 'INVALID_EXECUTION_MODE');
  assert.equal(workspaceCalls, 0); assert.equal(h.calls.ledger.length, 0);
});

test('mode preparation failure ends the original job with its reason and never degrades into normal execution', async () => {
  const h = harness({ prepareMode: async () => { throw Error('目标被策略禁用'); } });
  await h.send({ executionMode: { kind: 'goal' } }); const pending = h.session.pendingInput; if (pending) await pending.done;
  assert.equal(h.calls.failures[0].message, '目标被策略禁用');
  assert.equal(h.calls.mcp.length, 1); assert.equal(h.calls.pushes.length, 0); assert.equal(h.calls.oneShot.length, 0);
  assert.equal(h.calls.kills, 1);
});

test('canceling pending mode preparation cannot send the old prompt when its control finishes late', async () => {
  const ready = deferred(), h = harness({ prepareMode: () => ready.promise });
  await h.send({ executionMode: { kind: 'plan' } }); const pending = h.session.pendingInput;
  await new Promise(setImmediate);
  cancelPendingLiveInput(h.session);
  assert.equal(h.calls.mode[0].options.signal.aborted, true);
  ready.resolve({ ok: true, executionMode: { kind: 'plan' }, permissionMode: 'plan' }); await pending.done;
  assert.equal(h.calls.pushes.length, 0); assert.equal(h.calls.mcp.length, 1);
});

for (const kind of ['goal', 'plan']) {
  test(`${kind} cannot silently fall back to a one-shot executor when live capacity is unavailable`, async () => {
    const h = harness({ liveAvailable: false }); const result = await h.send({ executionMode: { kind } });
    assert.equal(result.code, 'MODE_REQUIRES_LIVE_SESSION');
    assert.equal(h.calls.oneShot.length, 0); assert.equal(h.calls.releases, 1);
    assert.equal(h.calls.failures.at(-1).ok, false);
  });
}

test('ordinary fresh conversation keeps the existing one-shot fallback', async () => {
  const h = harness({ liveAvailable: false }); const result = await h.send({ executionMode: { kind: 'default' } });
  assert.equal(result.jobId, runId); assert.equal(h.calls.oneShot.length, 1);
  assert.match(h.calls.oneShot[0].prompt, /^fixture request/);
});

test('ordinary resumed conversation cannot bypass the handshake that clears a previous native goal', async () => {
  const h = harness({ liveAvailable: false });
  const result = await h.send({ executionMode: { kind: 'default' }, sessionId: 'synthetic-session-with-possibly-active-goal', sessionRoute: { providerId: 'fixture-provider' } });
  assert.equal(result.code, 'MODE_REQUIRES_LIVE_SESSION');
  assert.equal(h.calls.oneShot.length, 0, 'resuming without goal cleanup could continue the old goal');
  assert.equal(h.calls.releases, 1); assert.equal(h.calls.failures.at(-1).ok, false);
});

test('main-window admission cannot launch a second owner for the active mini conversation', async () => {
  const h = harness();
  h.context.miniChat = { isRunning: () => true, getConversationId: () => convId };
  const result = await h.send({ prompt: 'main duplicate' });
  assert.equal(result.code, 'MINI_TURN_ACTIVE');
  assert.equal(h.calls.ledger.length, 0);
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.calls.oneShot.length, 0);
});

test('mini conversations use the same preparation and durable turn reference through their own event observer', async () => {
  const h = harness();
  h.context.miniChat = { isRunning: () => true, getConversationId: () => convId };
  const events = [];
  const payload = { prompt: 'mini request', convId, sourceConvId: convId, runId, mode: 'plain', model: 'haiku',
    taskContext: { turnRef: { index: 2, ts: '2026-09-08T01:00:00.000Z' }, userPrompt: 'mini request' } };
  const result = await h.context.runClaudeRequest({ miniChat: true, sender: { send: (_channel, event) => events.push(event) } }, payload);
  assert.equal(result.jobId, runId);
  await h.session.pendingInput.done;
  assert.equal(h.calls.ledger[0].source.type, 'mini');
  assert.equal(h.calls.ledger[0].source.conversationId, convId);
  assert.equal(h.calls.ledger[0].metadata.turnIndex, 2);
  assert.equal(h.calls.ledger[0].metadata.turnTs, payload.taskContext.turnRef.ts);
  assert.equal(h.calls.mode[0].mode.kind, 'default');
  assert.equal(h.calls.mcp.length, 1);
  assert.match(h.calls.pushes[0].text, /^mini request/);
  h.session.onEvent({ type: 'job-done', jobId: runId, exitCode: 0 });
  assert.equal(events.at(-1).jobId, runId);
  assert.equal(h.calls.events.length, 0, 'the main-window observer is not involved');
});


test('main preserves host goal condition across a retry and sends the prepared follow-up exactly once', async () => {
  const h = harness({ prepareMode: async (mode, options) => ({ ok: true, executionMode: mode,
    permissionMode: options.permissionMode, prompt: 'prepared continuation', files: [], goalCondition: options.previousGoal || options.goalCondition }) });
  await h.send({ prompt: 'original fixture objective', executionMode: { kind: 'goal' } });
  await h.session.pendingInput.done;
  const stored = h.context.loadConversation(convId);
  assert.equal(stored.goalRecovery.condition, 'original fixture objective');
  h.session.busy = false; h.session.turnRouter.end();
  await h.send({ prompt: 'continue', executionMode: { kind: 'goal' }, runId: '20000000-0000-4000-8000-000000000003' });
  await h.session.pendingInput.done;
  assert.equal(h.calls.mode[1].options.previousGoal, 'original fixture objective');
  assert.equal(h.calls.pushes[1].text, 'prepared continuation');
  assert.equal(h.calls.pushes.length, 2);
  assert.equal(stored.goalRecovery.condition, 'original fixture objective');
});

test('explicit goal replacement survives renderer slash-command stripping', async () => {
  const h = harness();
  await h.send({ prompt: 'new fixture', taskContext: { userPrompt: 'new fixture', goalExplicit: true }, executionMode: { kind: 'goal' } });
  await h.session.pendingInput.done;
  assert.equal(h.calls.mode[0].options.goalExplicit, true);
  assert.equal(h.calls.mode[0].options.goalCondition, 'new fixture');
});

test('live task clock survives preparation, retry, supplement and repair turns until actual finishTurn', async () => {
  const clock = { now: 10000 }, h = harness({ clock });
  const response = await h.send({ taskContext: { taskStartedAt: 1000 } });
  await h.session.pendingInput.done;
  assert.equal(response.relay_task_started_at, 1000);
  assert.equal(h.session.turnStartedAt, 1000);
  clock.now = 12000;
  h.session.onEvent({ type: 'system', subtype: 'api_retry', retry_delay_ms: 3000, jobId: runId });
  h.session.turnRouter.registerSupplement('supplement');
  clock.now = 18000;
  h.session.onEvent({ type: 'result', duration_ms: 100, queued_turn_count: 1, jobId: runId });
  h.session.turnRouter.consumeSupplement('supplement');
  h.session.turnRouter.addSend('repair'); h.session.turnRouter.resetConversation();
  assert.equal(h.calls.events.at(-1).relay_task_finished_at, undefined);
  assert.equal(h.calls.events.at(-1).duration_ms, 100);
  clock.now = 24000;
  Object.assign(h.context, {
    routeTimingHistory: { add() {} }, settleLiveSupplements: () => [], interactionBroker: { rejectTask() {} },
    os: { homedir: () => '/fixture' }, process: { env: {} }, applyProvenance: () => false,
    setTimeout: () => ({ unref() {} }), snapshotMcpChildren() {},
  });
  vm.runInContext(declaration('finishTurn'), h.context);
  const final = { type: 'result', subtype: 'success', duration_ms: 200 };
  assert.equal(h.context.finishTurn(h.session, final), true);
  const done = h.calls.events.at(-1);
  assert.equal(done.type, 'job-done');
  assert.equal(done.relay_task_started_at, 1000);
  assert.equal(done.relay_task_finished_at, 24000);
  assert.equal(done.relay_task_duration_ms, 23000);
  assert.equal(done.finalResult.duration_ms, 200);
  assert.equal(h.calls.releases, 1);
});

test('fallback and renderer relaunch preserve original task start while SDK child completion does not release the task', async () => {
  const clock = { now: 30000 }, h = harness({ clock, liveAvailable: false });
  const response = await h.send({ taskStartedAt: 1000 });
  assert.equal(response.relay_task_started_at, 1000);
  assert.equal(h.calls.oneShot[0].taskStartedAt, 1000);
  const emit = h.calls.oneShot[0].onEvent;
  clock.now = 32000; emit({ type: 'job-done', agent_id: 'child', jobId: runId });
  emit({ type: 'job-done', parentToolUseId: 'child-alias', jobId: runId });
  assert.equal(h.calls.releases, 0);
  assert.equal(h.calls.events.at(-1).relay_task_finished_at, undefined);
  clock.now = 40000; emit({ type: 'job-done', exitCode: -1, jobId: runId });
  assert.equal(h.calls.events.at(-1).relay_task_duration_ms, 39000);
  const retried = await h.send({ runId: '20000000-0000-4000-8000-000000000002', taskStartedAt: 1000 });
  assert.equal(retried.relay_task_started_at, 1000);
  clock.now = 45000; h.calls.oneShot[1].onEvent({ type: 'job-done', exitCode: 0 });
  assert.equal(h.calls.events.at(-1).relay_task_duration_ms, 44000);
});

test('pre-admission failure reports elapsed wall clock through the error response', async () => {
  const clock = { now: 9000 }, h = harness({ clock });
  h.context.resolveExecutionWorkspace = () => { clock.now = 11000; throw Error('synthetic preparation failure'); };
  const result = await h.send({ taskContext: { taskStartedAt: 1000 } });
  assert.equal(result.error, 'synthetic preparation failure');
  assert.equal(result.relay_task_started_at, 1000);
  assert.equal(result.relay_task_finished_at, 11000);
  assert.equal(result.relay_task_duration_ms, 10000);
  assert.equal(h.calls.events.length, 0);
});

test('canceling an unsent live task preserves its total preparation time in job-done', async () => {
  const ready = deferred(), clock = { now: 10000 }, h = harness({ clock, prepareMode: () => ready.promise });
  await h.send({ taskStartedAt: 1000 });
  const pending = h.session.pendingInput;
  Object.assign(h.context, { settleLiveSupplements: () => [], interactionBroker: { rejectTask() {} } });
  vm.runInContext(declaration('settleUnsentLiveTurn'), h.context);
  clock.now = 17000;
  assert.equal(h.context.settleUnsentLiveTurn(h.session, runId, 'synthetic canceled', true), true);
  assert.equal(h.calls.events.at(-1).relay_task_duration_ms, 16000);
  assert.equal(h.calls.events.at(-1).aborted, true);
  ready.resolve({ ok: true, executionMode: { kind: 'default' }, permissionMode: 'bypassPermissions' });
  await pending.done;
});

function seedFailedHistory(h, { fingerprint = 'fixture-contract', providerId = 'fixture-provider' } = {}) {
  const record = h.context.loadConversation(convId);
  Object.assign(record, { sessionId: 'durable-native-session', sdkRuntimeFingerprint: fingerprint,
    sdkSessionContext: { sessionId: 'durable-native-session', hostCwd: '/fixture/workspace', routing: { providerId } },
    turns: [{ runId: 'prior-run', user: 'rename component', assistant: '', status: 'error',
      output: { status: 'error', messages: [{ parent: '', blocks: [{ type: 'text', text: 'Component was renamed and references updated' }] }] },
      activity: { items: [{ type: 'tool', toolName: 'Edit', status: 'success', detail: '/fixture/component.md', result: 'File updated' }] } },
      { runId, user: 'continue fixture', assistant: '', status: 'running' }] });
  return record;
}
for (const reason of ['contract-change', 'provider-change', 'missing-handle']) {
  test(`main ${reason} retains failed-turn assistant and tool facts when rebuilding context`, async () => {
    const h = harness(); const record = seedFailedHistory(h, { fingerprint: reason === 'contract-change' ? 'old-contract' : 'fixture-contract',
      providerId: reason === 'provider-change' ? 'old-provider' : 'fixture-provider' });
    h.context.sessionRouteMatchesProvider = (a, b) => !!a && a.providerId === b.providerId;
    if (reason === 'missing-handle') { record.sessionId = null; delete record.sdkSessionContext; }
    const result = await h.send({ prompt: 'continue fixture', sessionId: record.sessionId,
      sessionRoute: record.sdkSessionContext?.routing, taskContext: { userPrompt: 'continue fixture', turnRef: { index: 1 } } });
    assert.equal(result.jobId, runId); await h.session.pendingInput.done;
    const sent = h.calls.pushes[0].text;
    assert.match(sent, /Component was renamed and references updated/);
    assert.match(sent, /工具记录（成功）Edit：[\s\S]*File updated/);
    assert.match(sent, /轮次状态：error/);
    assert.equal(sent.split('continue fixture').length - 1, 1);
    assert.equal(h.session.sessionId, null);
    assert.equal(sent.split('以下是我们之前的对话记录，供你参考延续：').length - 1, 1);
  });
}

test('missing renderer handle uses matching durable SDK identity instead of restarting a conversation', async () => {
  const h = harness(); seedFailedHistory(h);
  await h.send({ prompt: 'continue fixture', sessionId: null, taskContext: { turnRef: { index: 1 } } });
  await h.session.pendingInput.done;
  assert.equal(h.session.sessionId, 'durable-native-session');
  assert.doesNotMatch(h.calls.pushes[0].text, /以下是我们之前的对话记录/);
});

test('durable SDK handle from another directory is not adopted and recovery honors cleared history', async () => {
  const h = harness(); const record = seedFailedHistory(h);
  record.sdkSessionContext.hostCwd = '/fixture/other-project';
  record.sdkContextBoundary = { turnIndex: 1, afterRunId: 'prior-run' };
  await h.send({ prompt: 'continue fixture', sessionId: null, taskContext: { turnRef: { index: 1 } } });
  await h.session.pendingInput.done;
  assert.equal(h.session.sessionId, null);
  assert.doesNotMatch(h.calls.pushes[0].text, /Component was renamed|File updated/);
});
