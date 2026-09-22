'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { workspaceKey } = require('../src/main/projects/conversation-workspaces');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function declaration(name) {
  const match = new RegExp('function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = /\n(?:async )?function \w+\(/.exec(tail);
  const body = next ? tail.slice(0, next.index) : tail;
  return name === 'resolveWorkspaceForTools' ? body.split('\nconst workspaceTools =')[0] : body;
}
function harness() {
  const liveSessions = new Map(), liveTombstones = new Map(), starts = [], kills = [], sends = [], handlers = new Map();
  const route = { providerId: 'provider', providerRevision: 1, routeTier: 'opus' };
  const runtime = { id: 'provider', revision: 1, modelId: 'runtime-model', tier: 'opus' };
  const rejected = new Set();
  let record = null;
  const context = { TaskClock: require('../src/main/tasks/task-clock').TaskClock,
    ...require('../src/main/live/live-prewarm-reuse'),
    console: { log() {}, warn() {}, error() {} }, liveSessions, liveTombstones, workspaceKey,
    conversationRuntimeContract: () => ({ fingerprint: 'fixture-contract', policy: { settingSources: ['user'], settings: {} } }),
    requiresFreshContract: require('../src/main/sdk/sdk-runtime-contract').requiresFreshContract,
    loadConversation: () => record,
    relayModelTier: () => 'opus', activeRelayProviderRuntime: () => runtime, providerSessionRoute: () => route,
    sessionRouteMatchesProvider: (candidate) => candidate && candidate.providerId === route.providerId,
    getConversationWorkspaces: () => ({ acceptsSession: (_id, sessionId) => !rejected.has(sessionId) }),
    evictIfNeeded: () => true, sessionFingerprint: ({ cwd, model }) => `${cwd}|${model}`,
    mcpTreeIntact: () => true, checkpointManager: null, touchIdleTimer() {}, refreshTrayMenu() {},
    dispatchLiveInput: (value) => sends.push(value), ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    waitForChildClose: async () => {},
    spawnLiveSession(options) {
      starts.push(options);
      const sess = { convId: options.convId, sessionId: options.sessionId, busy: false, dead: false,
        prewarm: context.createPrewarmState(record, { resumed: !!options.sessionId }), observer: { epoch: 0, beginTurn() {} },
        launchSpec: { ...options, model: runtime.modelId, ...route, runtimeFingerprint: options.runtimeContract?.fingerprint || 'fixture-contract' },
        fingerprint: context.sessionFingerprint({ ...options, model: runtime.modelId, providerRuntime: runtime, runtimeFingerprint: options.runtimeContract?.fingerprint || 'fixture-contract' }),
        child: { pid: 1234 }, turnRouter: { begin() {} }, asyncAgentTracker: { reset() {} }, backgroundTaskTracker: { reset() {} },
      };
      liveSessions.set(options.convId, sess); return sess;
    },
    killLiveSession(sess) {
      kills.push(sess); sess.dead = true; liveSessions.delete(sess.convId);
      liveTombstones.set(sess.convId, { ...route, cwd: sess.launchSpec.cwd, sessionId: sess.sessionId, runtimeFingerprint: sess.launchSpec.runtimeFingerprint });
    },
    resolveExecutionWorkspace: ({ conversationId, workingDir }) => ({ cwd: workingDir || 'managed', validWorkingDir: workingDir || 'managed', conversationId }),
  };
  vm.createContext(context);
  for (const name of ['sessionFingerprint', 'prespawnSession', 'runLiveTurn']) vm.runInContext(declaration(name), context);
  for (const name of ['claude:prespawn', 'claude:resetSession']) {
    const start = source.indexOf(`ipcMain.handle('${name}'`), end = source.indexOf('\n});', start);
    assert.ok(start > 0 && end > start); vm.runInContext(source.slice(start, end + 4), context);
  }
  const options = { convId: 'conv', cwd: 'managed', validWorkingDir: 'managed', model: 'opus', effort: null,
    sessionRoute: route, attachCronMcp: true, runId: 'run', prompt: 'synthetic', onEvent() {} };
  return { context, starts, kills, sends, handlers, rejected, route, options, liveSessions, liveTombstones, setRecord: value => { record = value; } };
}

test('prespawn replaces an idle home process and never resumes its cwd-mismatched tombstone', () => {
  const h = harness();
  h.context.spawnLiveSession({ ...h.options, cwd: 'old-home', sessionId: 'old-session' });
  const fresh = h.context.prespawnSession({ ...h.options, workspaceChanged: true, sessionId: 'old-session' });
  assert.equal(h.kills.length, 1); assert.equal(fresh.launchSpec.cwd, 'managed'); assert.equal(fresh.sessionId, null);
  assert.equal(h.liveTombstones.has('conv'), false);
});

test('prespawn and send reuse the same actual cwd and process', () => {
  const h = harness();
  const warmed = h.context.prespawnSession(h.options);
  const launched = h.context.runLiveTurn(h.options);
  assert.equal(h.starts.length, 1); assert.equal(h.kills.length, 0);
  assert.equal(h.sends[0].session, warmed); assert.equal(launched.jobId, 'run');
});

test('forced fresh send keeps the matching new prewarm and sends once without reviving an old tombstone', () => {
  const h = harness();
  const warmed = h.context.prespawnSession(h.options);
  warmed.sessionId = 'newly-initialized';
  h.liveTombstones.set('conv', { ...h.route, cwd: 'managed', sessionId: 'discarded-old', runtimeFingerprint: 'fixture-contract' });
  const launched = h.context.runLiveTurn({ ...h.options, sessionId: 'stale-renderer-id', forceFreshSession: true });
  assert.equal(h.starts.length, 1); assert.equal(h.kills.length, 0); assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].session, warmed); assert.equal(launched.sessionId, 'newly-initialized');
  assert.equal(h.liveTombstones.has('conv'), false); assert.equal(warmed.prewarm, null);
  // Admission consumes eligibility even before asynchronous preparation pushes.
  warmed.busy = false;
  h.context.runLiveTurn({ ...h.options, forceFreshSession: true });
  assert.equal(h.starts.length, 2); assert.equal(h.kills.length, 1);
});

test('fresh requests replace resumed Queries and prewarms with changed model, effort, cwd, contract or clear generation', () => {
  for (const change of ['resumed', 'model', 'effort', 'cwd', 'contract', 'clear', 'native-reset', 'rejected']) {
    const h = harness();
    const warmed = h.context.prespawnSession({ ...h.options, ...(change === 'resumed' ? { sessionId: 'existing-native' } : {}) });
    const next = { ...h.options, forceFreshSession: true };
    if (change === 'model') warmed.fingerprint += ':other-model';
    if (change === 'effort') next.effort = 'high';
    if (change === 'cwd') next.cwd = 'other-project';
    if (change === 'contract') next.runtimeContract = { fingerprint: 'new-contract' };
    if (change === 'clear') h.setRecord({ sdkContextBoundary: { turnIndex: 3, afterRunId: 'cleared' } });
    if (change === 'native-reset') warmed.observer.epoch++;
    if (change === 'rejected') { warmed.sessionId = 'old-workspace'; h.rejected.add(warmed.sessionId); }
    h.context.runLiveTurn(next);
    assert.equal(h.starts.length, 2, change); assert.equal(h.kills.length, 1, change);
    assert.equal(h.starts[1].sessionId, null, change);
  }
});

test('late cwd-mismatched tombstones are ignored while a matching cwd session remains resumable', () => {
  for (const sameCwd of [false, true]) {
    const h = harness();
    h.liveTombstones.set('conv', { ...h.route, cwd: sameCwd ? 'managed' : 'old-home', sessionId: 'tomb-session', runtimeFingerprint: 'fixture-contract' });
    h.context.runLiveTurn(h.options);
    assert.equal(h.starts[0].sessionId, sameCwd ? 'tomb-session' : null);
  }
});

test('dead process or stale renderer session cannot bypass a forced workspace migration', () => {
  const h = harness();
  const old = h.context.spawnLiveSession({ ...h.options, cwd: 'old-home', sessionId: 'old-session' }); old.dead = true;
  h.rejected.add('old-session');
  h.context.runLiveTurn({ ...h.options, sessionId: 'old-session', forceFreshSession: true });
  assert.equal(h.starts.at(-1).sessionId, null);
  assert.equal(h.starts.at(-1).cwd, 'managed');
});

test('prewarming another cwd does not interrupt a busy process', () => {
  const h = harness();
  const busy = h.context.spawnLiveSession({ ...h.options, cwd: 'old-home', sessionId: 'old-session' }); busy.busy = true;
  assert.equal(h.context.prespawnSession(h.options), busy);
  assert.equal(h.kills.length, 0); assert.equal(h.starts.length, 1);
  assert.equal(h.context.runLiveTurn(h.options).code, 'CONVERSATION_BUSY');
  assert.equal(h.kills.length, 0);
});

test('actual prespawn and both reset IPC paths use the shared resolved conversation cwd', async () => {
  const h = harness(), chosen = path.resolve('synthetic-selected');
  await h.handlers.get('claude:prespawn')({}, { convId: 'conv', model: 'opus', workingDir: chosen });
  assert.equal(h.starts.at(-1).cwd, chosen);
  await h.handlers.get('claude:resetSession')({}, { convId: 'conv', model: 'opus', workingDir: chosen });
  assert.equal(h.starts.at(-1).cwd, chosen); assert.equal(h.starts.at(-1).sessionId, null);
  h.liveSessions.clear();
  await h.handlers.get('claude:resetSession')({}, { convId: 'conv', model: 'opus', workingDir: null });
  assert.equal(h.starts.at(-1).cwd, 'managed');
});

test('workspace IPC registration and shutdown use the owned main-window bridge', () => {
  assert.match(source, /registerWorkspaceTools\(\{\s*ipcMain, getWindow: \(\) => applicationWindows\.mainWindow, resolveWorkspace: resolveWorkspaceForTools, resolveLinkWorkspace, shell/);
  const lifecycle = fs.readFileSync(path.join(__dirname, '../src/main/app/application-lifecycle.js'), 'utf8');
  assert.match(lifecycle, /app\.on\('before-quit',[\s\S]*?integrations\.workspaceTools\.dispose\(\)/);
  assert.match(source, /integrations: \{ attachmentDialog, browserPanelTools, workspaceTools \}/);
});

test('file/terminal resolver honors explicit selected path, explicit default, and history only when omitted', () => {
  const { UUID, directoryValue } = require('../src/main/projects/conversation-workspaces');
  const id = '10000000-0000-4000-8000-000000000001', calls = [];
  const context = { TaskClock: require('../src/main/tasks/task-clock').TaskClock,
    liveSessions: new Map(), WORKSPACE_UUID: UUID, directoryValue, fs: { existsSync: () => true }, convFilePath: () => 'synthetic',
    loadConversation: () => ({ id, workingDir: { path: 'saved-path' }, mode: 'agent', agent: 'writer' }),
    resolveExecutionWorkspace: (options) => { calls.push(options); return options; },
  };
  vm.createContext(context); vm.runInContext(declaration('resolveWorkspaceForTools'), context);
  context.resolveWorkspaceForTools({ conversationId: id, workingDir: 'selected-path' });
  context.resolveWorkspaceForTools({ conversationId: id, workingDir: null });
  context.resolveWorkspaceForTools({ conversationId: id });
  assert.deepEqual(calls.map((item) => item.workingDir), ['selected-path', null, 'saved-path']);
  assert.equal(calls[0].agentName, 'writer');
});

test('main workspace service rejects a cwd change while a one-shot ledger task is active', (t) => {
  const os = require('node:os');
  const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-main-workspace-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = '10000000-0000-4000-8000-000000000001';
  let writes = 0;
  const context = { TaskClock: require('../src/main/tasks/task-clock').TaskClock,
    conversationWorkspaceService: null, path, fs, workspaceKey,
    generalPreferences: { workspaceRoot: () => path.join(home, 'RelayProjects') },
    createConversationWorkspaces: (options) => createConversationWorkspaces({ ...options, homeDir: home }),
    app: { getPath: () => home }, convFilePath: () => path.join(home, 'no-history.json'),
    loadConversation: () => null, persistConversationRecord: () => writes++, readAppSettings: () => ({}),
    liveSessions: new Map(), RUN_STATES: { QUEUED: 'queued' },
    taskLedger: { list: () => [{ state: 'running', source: { conversationId: id }, metadata: { workingDir: home } }] },
  };
  vm.createContext(context); vm.runInContext(declaration('getConversationWorkspaces'), context);
  assert.throws(() => context.getConversationWorkspaces().resolveWorkspace({ conversationId: id }), /正在运行/);
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(home, 'conversation-workspaces.json')), false);
});
