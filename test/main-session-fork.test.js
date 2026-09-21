'use strict';
// Actual main admission/spawn/record protection, real project + workspace
// services and the SDK option builder. All records and SDK callbacks are
// synthetic; directories and instruction fingerprints are isolated in /tmp.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const sdk = require('../claude-sdk');
const execution = require('../execution-modes');
const { createProjectStore } = require('../project-store');
const workspace = require('../conversation-workspaces');
const provenance = require('../sdk-session-provenance');
const { createSessionForkService } = require('../sdk-session-forks');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function declaration(name) {
  const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, name);
  const tail = source.slice(start), end = tail.indexOf('\n}\n');
  assert.ok(end > 0, name + ' has a top-level closing brace');
  return tail.slice(0, end + 2);
}
function fixture(t, { inProject = false, liveAvailable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-main-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, '.claude', 'memory'), base = path.join(root, 'workspaces');
  fs.mkdirSync(memory, { recursive: true }); fs.mkdirSync(base);
  const records = new Map(), liveSessions = new Map(), calls = { live: [], oneShot: [], events: [], native: [], failures: [], pushes: [], kills: [] };
  const settings = { permissionMode: 'default', agentEnvironment: 'native' };
  const runtime = { id: 'fixture-provider', revision: 1, modelId: 'fixture-model', tier: 'haiku', agentEnvironment: 'native', env: {} };
  const projects = createProjectStore({ isBusy: id => !!liveSessions.get(id)?.busy });
  const loadConversation = id => records.has(id) ? clone(records.get(id)) : null;
  const persistConversationRecord = value => records.set(value.id, clone(value));
  const workspaces = workspace.createConversationWorkspaces({ homeDir: root, getBaseDir: () => base, loadConversation, persistConversationRecord });
  let handler, saveHandler;
  const context = { TaskClock: require('../task-clock').TaskClock,
    taskContinuityHost: new (require('../task-continuity-host').TaskContinuityHost)({ loadConversation }),
    ...execution, ...workspace, ...provenance, ...require('../sdk-runtime-contract'), ...require('../sdk-runtime-policy'),
    ...require('../live-async-agent-tracker'), ...require('../sdk-session-observer'), ...require('../sdk-task-resources'),
    ...require('../live-supplement-input'), ...require('../live-mcp-dispatch'),
    ...require('../sdk-user-dialog'), ...require('../sdk-tool-proposals'),
    ...require('../live-prewarm-reuse'),
    ...require('../memory-runtime'), relayMemoryStore: new (require('../memory-store').MemoryStore)({ dir: memory }),
    memoryRequestContexts: new Map(), rebuildMemoryIndex() {}, notifySkillUsageUpdated() {},
    readMemoryUsage: () => ({}), flushMemoryUsage() {},
    getSdkPluginStore: () => ({ runtime: () => ({ plugins: [], settings: { enabledPlugins: {}, pluginConfigs: {} }, fingerprint: 'fixture' }) }),
    LiveTurnRouter: require('../live-turn-router').LiveTurnRouter, createSessionForkService,
    crypto, path, process: { env: { CLAUDE_CONFIG_DIR: path.join(root, '.claude') } }, os: { homedir: () => root },
    fs: { ...fs, existsSync: file => records.has(file) || fs.existsSync(file) },
    convFilePath: id => id, loadConversation, persistConversationRecord, getProjectStore: () => projects,
    getConversationWorkspaces: () => workspaces, readAppSettings: () => settings,
    getSdkRuntimeStorage: () => require('../sdk-runtime-storage').createSdkRuntimeStorage({ dataDir: path.join(root, 'app-data') }),
    normalizePreferences: value => ({ ...value, agentEnvironment: value.agentEnvironment || 'native' }),
    WORKSPACE_UUID: workspace.UUID, toWslPath: value => value, MEMORY_DIR: memory, AGENTS_DIR: path.join(root, 'agents'),
    loadNativeAgent: () => { throw Error('No Agent fixture should be loaded'); },
    activeRelayProviderRuntime: () => runtime, RELAY_MODEL_TIERS: new Set(['haiku', 'sonnet', 'opus']),
    providerStore: { getRoutingView: () => ({ chatRoutes: [{ configured: true, modelId: runtime.modelId, tier: runtime.tier }], defaultModel: runtime.tier }) },
    liveSessions, liveTombstones: new Map(), jobs: new Map(), taskLedger: { get: () => null, list: () => [], update() {} },
    liveTurnControls: { isStopping: () => false }, checkpointManager: null, SNAPSHOT_DELAY_MS: 60000,
    touchIdleTimer() {}, refreshTrayMenu() {}, snapshotMcpChildren() {}, readSupportedModels: async () => [],
    makeSdkDiagnostics: () => ({ recordInstructions() {} }),
    sessionFingerprint: value => JSON.stringify(value), mcpTreeIntact: () => true, evictIfNeeded: () => liveAvailable,
    killLiveSession: sess => { sess.dead = true; liveSessions.delete(sess.convId); calls.kills.push(sess.convId); },
    interactionBroker: { createCanUseTool: () => async () => ({ behavior: 'deny' }), createOnElicitation: () => async () => ({}), rejectTask() {} },
    miniInteractionWindowId: () => null, miniChat: null,
    isConversationPermissionMode: mode => ['default', 'acceptEdits', 'bypassPermissions'].includes(mode),
    readClaudeMcpRegistry: () => ({ ok: true, enabled: {} }), cronMcpFactory: () => null, recordRelayUsage() {},
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    waitForCheckpointUnlock: async () => true, compactText: value => value,
    RUN_STATES: { QUEUED: 'queued', STARTING: 'starting', CANCELED: 'canceled' }, TASK_EVENT_EPOCH: 'fixture',
    createShadowTaskRun() {}, acquireTaskResource: async () => ({ signal: new AbortController().signal, release() {} }),
    finishShadowTaskRun: (_id, _ok, data) => calls.failures.push(data), releaseTaskResource() {},
    listAgentNames: () => [], promptNeedsFeishu: () => false, promptMaybeCron: () => false,
    FEISHU_HINT: '', ASK_HINT: '', IMAGE_HINT: '', buildMemoryHint: () => '',
    journalClaudeEvent() {}, enqueueShadowClaudeEvent() {}, flushShadowTaskEvents() {},
    TITLE_MAX_W: 64, truncateByWidth: value => value,
    executeSessionOperation: async (scope, operation) => {
      calls.native.push(operation);
      if (operation === 'getSessionInfo') return { sessionId: scope.sessionId };
      if (operation === 'getSessionMessages') return [{ uuid: uuid(3), session_id: scope.sessionId }];
      if (operation === 'forkSession') return { sessionId: crypto.randomUUID() };
    },
    claudeSdk: {
      createLiveSession(params) {
        const options = sdk._buildOptions(params); calls.live.push({ params, options });
        return { supportedAgents: async () => [], whenReady: async () => {},
          prepareExecutionMode: async (mode, opts) => ({ executionMode: mode, permissionMode: opts.permissionMode }),
          prepareMcp: async () => ({ ok: true, items: [] }),
          push: (text, meta) => { calls.pushes.push({ text, meta }); return true; },
        };
      },
      runOneShot(params) { calls.oneShot.push({ params, options: sdk._buildOptions(params) }); return { handle: { kill() {} } }; },
    },
    ipcMain: { handle: (name, value) => { if (name === 'history:save') saveHandler = value;
      else { assert.equal(name, 'claude:run'); handler = value; } } },
    console: { log() {}, warn() {}, error() {} },
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context); vm.runInContext('let nativeForkService;', context);
  for (const name of ['providerSessionRoute', 'sessionRouteMatchesProvider', 'relayModelTier', 'sdkProjectContext', 'conversationRuntimeContract',
    'migrateConversationRuntimeContract',
    'projectConversation', 'updateConversationProject', 'resolveExecutionWorkspace', 'resolveLinkWorkspace', 'buildSdkParams', 'spawnLiveSession', 'prespawnSession',
    'runLiveTurn', 'runClaudeJob', 'saveConversation', 'getNativeForkService']) vm.runInContext(declaration(name), context);
  const start = source.indexOf("ipcMain.handle('claude:run',"), end = source.indexOf('// IPC: 丢弃某对话', start);
  vm.runInContext(source.slice(start, end), context);
  const saveStart = source.indexOf("ipcMain.handle('history:save',"), saveEnd = source.indexOf("\nipcMain.handle(", saveStart + 1);
  vm.runInContext(source.slice(saveStart, saveEnd), context);
  const record = { id: uuid(1), title: 'Source', sessionId: uuid(2), projectId: null, workingDir: null,
    model: 'haiku', effort: 'low', mode: 'plain', permissionMode: 'default', executionMode: { kind: 'default' },
    sessionProviderId: runtime.id, sessionProviderRevision: runtime.revision, sessionAgentEnvironment: 'native', sessionRouteTier: 'haiku',
    turns: [{ runId: uuid(4), user: 'before boundary', assistant: 'visible reply', status: 'completed' }] };
  if (inProject) {
    const dir = path.join(root, 'project'); fs.mkdirSync(dir); const project = projects.add(dir, 'Fixture project');
    record.projectId = project.id; record.workingDir = { path: project.path, name: project.name };
  }
  persistConversationRecord(record); projects.adopt(record);
  const resolved = context.resolveExecutionWorkspace({ conversationId: record.id });
  const contract = context.conversationRuntimeContract({ convId: record.id, cwd: resolved.cwd, mode: 'plain', model: runtime.modelId, effort: 'low' });
  const scope = { sessionId: record.sessionId, cwd: resolved.cwd, hostCwd: resolved.cwd, configDir: path.join(root, '.claude'), agentEnvironment: 'native',
    routing: { providerId: runtime.id, providerRevision: runtime.revision, agentEnvironment: 'native', routeTier: 'haiku', model: runtime.modelId,
      effort: 'low', mode: 'plain', projectId: record.projectId, runtimeFingerprint: contract.fingerprint } };
  Object.assign(record, { sdkRuntimeFingerprint: contract.fingerprint, sdkSessionContext: scope });
  Object.assign(record.turns[0], { sdkSessionContext: clone(scope), sdkForkPoint: uuid(3) }); persistConversationRecord(record);
  return { context, records, projects, workspaces, calls, settings, root, record, runtime, save: value => saveHandler({}, value),
    fork: async (selected = true) => { const result = await context.getNativeForkService().create({ conversationId: record.id, ...(selected ? { runId: uuid(4) } : {}) }); return loadConversation(result.conversationId); },
    send: async (branch, overrides = {}) => handler({ sender: { send: (_name, event) => calls.events.push(event) } }, {
      prompt: 'continue branch', convId: branch.id, sourceConvId: branch.id, runId: uuid(9), mode: 'plain', model: 'haiku', effort: 'low',
      sessionId: branch.sessionId, sessionRoute: context.providerSessionRoute(runtime, 'haiku'), workingDir: branch.workingDir, ...overrides }),
  };
}

function legacyFixture(h) {
  vm.runInContext(declaration('sessionFingerprint'), h.context);
  fs.writeFileSync(path.join(h.root, '.claude', 'CLAUDE.md'), 'Legacy instruction fixture.');
  const workspace = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const contract = h.context.conversationRuntimeContract({ convId: h.record.id, cwd: workspace.cwd, mode: 'plain',
    model: h.runtime.modelId, effort: 'low', providerRuntime: h.runtime });
  const legacy = contract.legacyFingerprint();
  assert.equal(typeof legacy, 'string'); assert.notEqual(legacy, contract.fingerprint);
  // The base fixture intentionally retires its original home-directory handle
  // when assigning a managed cwd. Model a later valid native session here.
  h.record.sessionId = uuid(20);
  h.record.sdkRuntimeFingerprint = legacy; delete h.record.sdkRuntimeFingerprintVersion;
  for (const scope of [h.record.sdkSessionContext, h.record.turns[0].sdkSessionContext]) {
    scope.sessionId = h.record.sessionId;
    scope.routing.runtimeFingerprint = legacy; delete scope.routing.runtimeFingerprintVersion;
  }
  h.record.updatedAt = '2026-01-01T00:00:00.000Z'; h.record.pinned = true;
  h.context.persistConversationRecord(h.record);
  h.workspaces.markContextCarried(h.record.id);
  return { workspace, contract, legacy };
}

test('unchanged legacy metadata upgrades preserve native resume and do not inject a bounded history substitute', async t => {
  const h = fixture(t), { contract } = legacyFixture(h), nativeId = h.record.sessionId;
  const result = await h.send(h.record); assert.equal(result.error, undefined);
  assert.equal(h.calls.live.length, 1); assert.equal(h.calls.live[0].options.resume, nativeId);
  await h.context.liveSessions.get(h.record.id).pendingInput.done;
  assert.doesNotMatch(h.calls.pushes[0].text, /以下是我们之前的对话记录/);
  const saved = h.records.get(h.record.id);
  assert.equal(saved.sessionId, nativeId); assert.equal(saved.updatedAt, h.record.updatedAt); assert.equal(saved.pinned, true);
  assert.equal(saved.sdkRuntimeFingerprint, contract.fingerprint); assert.equal(saved.sdkRuntimeFingerprintVersion, 2);
  assert.equal(saved.turns[0].sdkSessionContext.routing.runtimeFingerprint, contract.fingerprint);
  assert.equal(saved.turns[0].assistant, h.record.turns[0].assistant);
});

test('already prewarmed legacy Query and its tombstone migrate in place without losing native context', async t => {
  const h = fixture(t), { workspace, contract, legacy } = legacyFixture(h);
  const warm = h.context.spawnLiveSession({ convId: h.record.id, ...workspace, mode: 'plain', model: 'haiku', routeTier: 'haiku', effort: 'low',
    sessionId: h.record.sessionId, attachCronMcp: true, runtimeContract: { ...contract, fingerprint: legacy, fingerprintVersion: undefined } });
  h.context.liveTombstones.set(h.record.id, { sessionId: h.record.sessionId, cwd: workspace.cwd, runtimeFingerprint: legacy });
  const result = await h.send(h.record); assert.equal(result.error, undefined);
  assert.equal(h.calls.live.length, 1); assert.equal(h.calls.kills.length, 0); assert.equal(h.context.liveSessions.get(h.record.id), warm);
  assert.equal(warm.launchSpec.runtimeFingerprint, contract.fingerprint); assert.equal(warm.launchSpec.runtimeFingerprintVersion, 2);
  assert.equal(h.context.liveTombstones.get(h.record.id).runtimeFingerprint, contract.fingerprint);
  await warm.pendingInput.done; assert.doesNotMatch(h.calls.pushes[0].text, /以下是我们之前的对话记录/);
  const incoming = clone(h.records.get(h.record.id)); incoming.sdkRuntimeFingerprintVersion = 1;
  await h.save(incoming); assert.equal(h.records.get(h.record.id).sdkRuntimeFingerprintVersion, 2);
});

test('changed legacy instructions still require a fresh runtime and explicit context recovery', async t => {
  const h = fixture(t); legacyFixture(h);
  fs.writeFileSync(path.join(h.root, '.claude', 'CLAUDE.md'), 'New effective instruction');
  const result = await h.send(h.record); assert.equal(result.error, undefined);
  assert.equal(h.calls.live[0].options.resume, undefined);
  await h.context.liveSessions.get(h.record.id).pendingInput.done;
  assert.match(h.calls.pushes[0].text, /以下是我们之前的对话记录/);
});

test('an unchanged selected-turn legacy fork preserves its exact native branch point after hash migration', async t => {
  const h = fixture(t); legacyFixture(h);
  const branch = await h.fork();
  assert.equal(branch.pendingSdkFork.sourceSessionId, h.record.sessionId);
  assert.equal(branch.pendingSdkFork.messageUuid, h.record.turns[0].sdkForkPoint);
  assert.equal(branch.sdkRuntimeFingerprintVersion, 2);
  const result = await h.send(branch); assert.equal(result.error, undefined);
  assert.equal(h.calls.live[0].options.resume, h.record.sessionId);
  assert.equal(h.calls.live[0].options.forkSession, true);
  await h.context.liveSessions.get(branch.id).pendingInput.done;
});

test('real main spawn prewarms an empty replacement once and reserves it before the forced-fresh turn is prepared', async t => {
  const h = fixture(t);
  vm.runInContext(declaration('sessionFingerprint'), h.context);
  const workspace = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const warmed = h.context.prespawnSession({ convId: h.record.id, ...workspace, mode: 'plain', model: 'haiku',
    effort: 'low', sessionId: null, attachCronMcp: true });
  assert.ok(warmed.prewarm); assert.equal(h.calls.live.length, 1);
  assert.equal(h.calls.live[0].options.resume, undefined);
  const sent = await h.send(h.record, { sessionId: null, forceFreshSession: true });
  assert.equal(sent.error, undefined); assert.equal(h.calls.live.length, 1); assert.equal(h.calls.kills.length, 0);
  assert.equal(warmed.prewarm, null); assert.equal(h.context.liveSessions.get(h.record.id), warmed);
  await warmed.pendingInput.done;
  assert.equal(h.calls.pushes.length, 1);
  assert.match(h.calls.pushes[0].text, /visible reply/);
});

test('unprojected selected-turn fork reaches real live SDK options through main admission without creating a project', async t => {
  const h = fixture(t), branch = await h.fork();
  assert.equal(h.projects.list().length, 0); assert.equal(branch.projectId, null);
  assert.equal(branch.sdkForkWorkspace.path, h.record.sdkSessionContext.cwd);
  const result = await h.send(branch); assert.equal(result.error, undefined);
  assert.equal(result.jobId, uuid(9)); assert.equal(h.calls.live.length, 1); assert.equal(h.calls.oneShot.length, 0);
  const options = h.calls.live[0].options;
  assert.equal(options.cwd, h.record.sdkSessionContext.cwd); assert.equal(options.resume, h.record.sessionId);
  assert.equal(options.forkSession, true); assert.equal(options.resumeSessionAt, uuid(3)); assert.equal(options.sessionId, branch.pendingSdkFork.targetSessionId);
  await h.context.liveSessions.get(branch.id).pendingInput.done;
  assert.equal(h.calls.pushes.length, 1); assert.equal(h.projects.list().length, 0);
});

test('host memory tools close at turn completion or cancellation and reopen for the next admitted turn', async t => {
  const h = fixture(t), branch = await h.fork();
  await h.send(branch);
  const session = h.context.liveSessions.get(branch.id), params = h.calls.live[0].params;
  await session.pendingInput.done;
  params.onMessage({ type: 'system', subtype: 'init', session_id: branch.pendingSdkFork.targetSessionId });
  const servers = params.mcpServersFactory({
    createSdkMcpServer: configuration => ({ type: 'sdk', configuration }),
    tool: (name, _description, _schema, handler) => ({ name, handler }),
  });
  const list = servers['relay-memory'].configuration.tools.find(tool => tool.name === 'list').handler;
  const proposalInput = { tool_name: 'mcp__relay-memory__propose', tool_input: {} };
  assert.notEqual((await list({})).isError, true, 'the actual factory reads during an admitted turn');
  assert.deepEqual(clone(await params.onMemoryTool(proposalInput)), {});
  for (const [busy, jobId] of [[false, uuid(9)], [true, null], [false, null]]) {
    Object.assign(session, { busy, jobId });
    assert.equal((await list({})).isError, true, 'the tool handler independently refuses an inactive turn');
    assert.equal((await params.onMemoryTool(proposalInput)).hookSpecificOutput.permissionDecision, 'deny');
  }
  session.turnRouter.end();
  const resumed = await h.send(h.records.get(branch.id), { runId: uuid(10) });
  assert.equal(resumed.error, undefined);
  assert.equal(h.calls.live.length, 1, 'the following real admission reuses the same protected MCP instance');
  assert.equal(h.context.liveSessions.get(branch.id), session);
  await session.pendingInput.done;
  assert.equal(session.jobId, uuid(10)); assert.equal(session.busy, true);
  assert.notEqual((await list({})).isError, true);
  assert.deepEqual(clone(await params.onMemoryTool(proposalInput)), {});
});

test('whole-session fork keeps the already materialized native session through main admission', async t => {
  const h = fixture(t), branch = await h.fork(false), result = await h.send(branch);
  assert.equal(result.error, undefined); assert.equal(h.projects.list().length, 0);
  assert.notEqual(branch.sessionId, h.record.sessionId);
  assert.equal(h.calls.live[0].options.resume, branch.sessionId); assert.equal(h.calls.live[0].options.forkSession, undefined);
});

test('prewarm initialization consumes a pending fork once and renderer saves cannot revive its source ID', async t => {
  const h = fixture(t), branch = await h.fork(), stale = clone(branch);
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: branch.id });
  h.context.prespawnSession({ convId: branch.id, ...resolved, mode: 'plain', model: 'haiku', effort: 'low', attachCronMcp: true, sessionId: branch.sessionId,
    sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  const destination = branch.pendingSdkFork.targetSessionId;
  h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: destination });
  assert.equal(h.records.get(branch.id).sessionId, destination); assert.equal(h.records.get(branch.id).pendingSdkFork, undefined);
  h.context.saveConversation(stale); assert.equal(h.records.get(branch.id).sessionId, destination); assert.equal(h.records.get(branch.id).pendingSdkFork, undefined);
  assert.equal(h.records.get(branch.id).sdkForkWorkspace.path, h.record.sdkSessionContext.cwd);
  const result = await h.send(h.records.get(branch.id)); assert.equal(result.error, undefined); assert.equal(h.calls.live.length, 1, 'ready native fork is reused');
});

test('recycled prewarm and stale renderer IDs always resume the materialized branch rather than the source', async t => {
  const h = fixture(t), branch = await h.fork(), resolved = h.context.resolveExecutionWorkspace({ conversationId: branch.id });
  const opts = { convId: branch.id, ...resolved, mode: 'plain', model: 'haiku', effort: 'low', attachCronMcp: true,
    sessionId: branch.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') };
  h.context.prespawnSession(opts);
  const destination = branch.pendingSdkFork.targetSessionId;
  h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: destination });
  h.context.killLiveSession(h.context.liveSessions.get(branch.id));
  // A stale UI can still contain the source session from before idle init.
  const result = await h.send(branch); assert.equal(result.error, undefined);
  assert.equal(h.calls.live[1].options.resume, destination); assert.equal(h.calls.live[1].options.forkSession, undefined);
  h.context.killLiveSession(h.context.liveSessions.get(branch.id));
  h.context.prespawnSession(opts); assert.equal(h.calls.live[2].options.resume, destination);
  const contract = h.context.conversationRuntimeContract({ convId: branch.id, cwd: resolved.cwd, mode: 'plain', model: h.runtime.modelId, effort: 'low' });
  h.context.runClaudeJob({ ...resolved, conversationId: branch.id, sessionId: branch.sessionId,
    sessionRoute: opts.sessionRoute, model: 'haiku', effort: 'low', runtimeContract: contract, prompt: 'branch', onEvent() {} });
  assert.equal(h.calls.oneShot[0].options.resume, destination); assert.equal(h.calls.oneShot[0].options.forkSession, undefined);
});

test('one-shot host launcher preserves the exact fork options and consumes native init authoritatively', async t => {
  const h = fixture(t), branch = await h.fork(), resolved = h.context.resolveExecutionWorkspace({ conversationId: branch.id });
  const contract = h.context.conversationRuntimeContract({ convId: branch.id, cwd: resolved.cwd, mode: 'plain', model: h.runtime.modelId, effort: 'low' });
  h.context.runClaudeJob({ ...resolved, conversationId: branch.id, sessionId: branch.sessionId,
    sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku'), model: 'haiku', effort: 'low', runtimeContract: contract, prompt: 'branch', onEvent() {} });
  const { options, params } = h.calls.oneShot[0];
  assert.equal(options.cwd, resolved.cwd); assert.equal(options.resume, h.record.sessionId); assert.equal(options.forkSession, true);
  assert.equal(options.sessionId, branch.pendingSdkFork.targetSessionId); assert.equal(options.resumeSessionAt, uuid(3));
  params.onEvent({ type: 'system', subtype: 'init', session_id: options.sessionId });
  assert.equal(h.records.get(branch.id).sessionId, options.sessionId); assert.equal(h.records.get(branch.id).pendingSdkFork, undefined);
});

test('one-shot host ignores camel-case child completion before releasing the parent executor', t => {
  const h = fixture(t), events = [];
  const launched = h.context.runClaudeJob({ prompt: 'fixture', ...h.context.resolveExecutionWorkspace({ conversationId: h.record.id }),
    onEvent: event => events.push(event), taskStartedAt: 1000 });
  const emit = h.calls.oneShot.at(-1).params.onEvent;
  emit({ type: 'job-done', parentToolUseId: 'child', exitCode: 0 });
  assert.equal(h.context.jobs.has(launched.jobId), true);
  assert.equal(events.at(-1).relay_task_finished_at, undefined);
  emit({ type: 'job-done', exitCode: 0 });
  assert.equal(h.context.jobs.has(launched.jobId), false);
  assert.ok(events.at(-1).relay_task_finished_at >= events.at(-1).relay_task_started_at);
});

test('busy live capacity never silently falls back to a non-native fork', async t => {
  const h = fixture(t, { liveAvailable: false }), branch = await h.fork(), result = await h.send(branch);
  assert.equal(result.code, 'MODE_REQUIRES_LIVE_SESSION'); assert.equal(h.calls.oneShot.length, 0);
  assert.deepEqual(h.records.get(branch.id).pendingSdkFork, branch.pendingSdkFork);
});

test('explicit project/default-workspace switches remove only the host-owned shared directory and pending fork', async t => {
  for (const chooseProject of [false, true]) {
    const h = fixture(t), branch = await h.fork(), stale = clone(branch);
    let target = null;
    if (chooseProject) { const dir = path.join(h.root, 'chosen'); fs.mkdirSync(dir); target = h.projects.add(dir, 'Chosen').id; }
    const changed = h.context.updateConversationProject(branch.id, target);
    assert.equal(changed.sdkForkWorkspace, undefined); assert.equal(changed.pendingSdkFork, undefined); assert.equal(changed.sessionId, null);
    h.context.saveConversation(stale); const saved = h.records.get(branch.id);
    assert.equal(saved.sdkForkWorkspace, undefined); assert.equal(saved.pendingSdkFork, undefined);
    const next = h.context.resolveExecutionWorkspace({ conversationId: branch.id });
    assert.notEqual(next.cwd, h.record.sdkSessionContext.cwd);
    assert.equal(next.cwd, target ? h.projects.get(target).path : path.join(h.root, 'workspaces', branch.id));
  }
});

test('running shared-workspace branches cannot use the same null project binding to evade directory locks', async t => {
  const h = fixture(t), branch = await h.fork(); h.context.liveSessions.set(branch.id, { busy: true });
  assert.throws(() => h.context.updateConversationProject(branch.id, null), /正在运行/);
  assert.deepEqual(h.records.get(branch.id).sdkForkWorkspace, branch.sdkForkWorkspace);
});

test('history-save protects shared workspace before project decoration and rejects forged fork fields', async t => {
  const h = fixture(t), branch = await h.fork();
  const stale = clone(branch); delete stale.sdkForkWorkspace; stale.workingDir = null;
  h.save(stale); assert.equal(h.records.get(branch.id).workingDir.path, branch.sdkForkWorkspace.path);
  assert.equal(h.records.get(branch.id).sdkForkWorkspace.path, branch.sdkForkWorkspace.path); assert.equal(h.projects.list().length, 0);
  h.save({ id: uuid(99), title: 'New fixture', sdkForkWorkspace: { path: '/forged-directory' }, turns: [] });
  assert.equal(h.records.get(uuid(99)).sdkForkWorkspace, undefined); assert.equal(h.projects.list().length, 0);
});

test('recorded original project is restored after source moves, and removed projects fail before native mutation', async t => {
  const h = fixture(t, { inProject: true }), original = h.projects.get(h.record.projectId);
  const dir = path.join(h.root, 'later'); fs.mkdirSync(dir); const later = h.projects.add(dir, 'Later');
  h.context.updateConversationProject(h.record.id, later.id);
  const branch = await h.fork(); assert.equal(branch.projectId, original.id); assert.equal(branch.sdkForkWorkspace, undefined);
  const result = await h.send(branch); assert.equal(result.error, undefined); assert.equal(h.calls.live[0].options.cwd, original.path);
  h.context.liveSessions.clear(); h.projects.remove(original.id);
  await assert.rejects(h.fork(), { code: 'FORK_PROJECT_UNAVAILABLE' });
});

test('changed effective SDK policy is rejected before creating a branch', async t => {
  const h = fixture(t); h.settings.sdkRuntimePreferences = { autoCompact: 'enabled' };
  await assert.rejects(h.fork(), { code: 'FORK_RUNTIME_CHANGED' }); assert.deepEqual(h.calls.native, []);
});


test('actual main admission supplies per-conversation scratch and SDK runtime storage for project and archive tasks', async t => {
  for (const inProject of [false, true]) for (const liveAvailable of [false, true]) {
    const h = fixture(t, { inProject, liveAvailable }), branch = await h.fork();
    const result = liveAvailable ? await h.send(branch) : h.context.runClaudeJob({
      prompt: 'synthetic one-shot task', conversationId: branch.id, cwd: h.record.sdkSessionContext.cwd,
      validWorkingDir: h.record.sdkSessionContext.cwd, model: 'haiku', onEvent() {},
      sessionId: branch.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime),
    });
    assert.equal(result.error, undefined);
    const call = [...h.calls.live, ...h.calls.oneShot][0], scratchDir = h.workspaces.resolveScratch(branch.id);
    assert.equal(call.params.scratchDir, scratchDir); assert.equal(call.options.env.TEMP, scratchDir);
    assert.equal(call.options.cwd, h.record.sdkSessionContext.cwd);
    assert.notEqual(scratchDir, h.workspaces.resolveScratch(h.record.id), 'a fork has independent intermediates even when cwd is shared');
    assert.equal(call.options.env.CLAUDE_CODE_TMPDIR, path.join(h.root, 'app-data', 'sdk-runtime', 'tmp'));
    assert.equal(call.options.env.XDG_CACHE_HOME, path.join(h.root, 'app-data', 'sdk-runtime', 'cache'));
    assert.ok(call.options.systemPrompt.append.includes(JSON.stringify(call.options.cwd)));
    assert.ok(call.options.systemPrompt.append.includes(JSON.stringify(scratchDir)));
  }
});

test('guidance changes replace an idle resident on the next send and preserve previous conversation content', async t => {
  const h = fixture(t, { inProject: true });
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const old = h.context.prespawnSession({ ...resolved, convId: h.record.id, model: 'haiku', effort: 'low',
    sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  assert.ok(old); assert.equal(h.calls.live.length, 1);
  h.settings.relayInstructions = 'Prefer concise Chinese responses.';
  const result = await h.send(h.record);
  await new Promise(setImmediate);
  assert.equal(result.error, undefined); assert.equal(old.dead, true);
  assert.equal(h.calls.live.length, 2);
  const options = h.calls.live[1].options;
  assert.ok(options.systemPrompt.append.includes(h.settings.relayInstructions));
  assert.equal(options.resume, undefined);
  assert.match(h.calls.pushes.at(-1).text, /before boundary/);
  assert.match(h.calls.pushes.at(-1).text, /visible reply/);
  assert.match(h.calls.pushes.at(-1).text, /continue branch/);
});

test('upgrading the file delivery contract replaces a previously resumable session without changing history order', async t => {
  const h = fixture(t, { inProject: true });
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const currentContract = h.context.conversationRuntimeContract;
  const currentSource = declaration('conversationRuntimeContract');
  const previousSource = currentSource.replace('file-locations-v2', 'file-locations-v1');
  assert.notEqual(previousSource, currentSource, 'construct the actual prior file delivery contract');
  vm.runInContext(previousSource, h.context);
  const input = { convId: h.record.id, cwd: resolved.cwd, mode: 'plain', model: h.runtime.modelId,
    effort: 'low', providerRuntime: h.runtime };
  const previous = h.context.conversationRuntimeContract(input);
  Object.assign(h.record, { sdkRuntimeFingerprint: previous.fingerprint,
    sdkRuntimeFingerprintVersion: previous.fingerprintVersion, updatedAt: '2026-01-01T00:00:00.000Z', pinned: true });
  for (const scope of [h.record.sdkSessionContext, h.record.turns[0].sdkSessionContext]) {
    scope.routing.runtimeFingerprint = previous.fingerprint;
    scope.routing.runtimeFingerprintVersion = previous.fingerprintVersion;
  }
  h.context.persistConversationRecord(h.record); h.workspaces.markContextCarried(h.record.id);
  const before = clone(h.records.get(h.record.id));
  const old = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
    sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  assert.ok(old); assert.equal(h.calls.live[0].options.resume, h.record.sessionId, 'the saved session was valid before the contract update');

  h.context.conversationRuntimeContract = currentContract;
  const current = currentContract(input);
  assert.notEqual(current.fingerprint, previous.fingerprint);
  const result = await h.send(h.record);
  assert.equal(result.error, undefined);
  const replacement = h.context.liveSessions.get(h.record.id);
  await replacement.pendingInput.done;
  assert.equal(old.dead, true); assert.notEqual(replacement, old);
  assert.equal(h.calls.live.length, 2); assert.equal(h.calls.live[1].options.resume, undefined);
  assert.equal(replacement.launchSpec.runtimeFingerprint, current.fingerprint);
  assert.ok(h.calls.live[1].options.systemPrompt.append.includes(JSON.stringify(resolved.cwd)));
  for (const text of ['before boundary', 'visible reply', 'continue branch']) assert.ok(h.calls.pushes.at(-1).text.includes(text));
  const saved = h.records.get(h.record.id);
  assert.equal(saved.updatedAt, before.updatedAt); assert.equal(saved.pinned, before.pinned);
  assert.equal(saved.title, before.title); assert.deepEqual(saved.turns, before.turns);
});

for (const initialized of [false, true]) {
  test(`replacement prewarm ${initialized ? 'with an initialized identity' : 'before init'} carries prior context after renderer saves a follow-up`, async t => {
    const h = fixture(t, { inProject: true });
    h.record.turns[0].user = 'Fill change numbers in https://fixture.invalid/sheets/synthetic-table';
    h.record.turns[0].assistant = 'Filled synthetic change numbers; 14 rows remain blank in synthetic-table.';
    h.context.persistConversationRecord(h.record); h.workspaces.markContextCarried(h.record.id);
    const staleRenderer = clone(h.record);
    const priorFingerprint = h.record.sdkRuntimeFingerprint;
    h.settings.relayInstructions = 'Updated file delivery fixture policy.';
    const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
    const warm = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
      attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
    assert.ok(warm?.prewarm);
    assert.equal(h.calls.live[0].options.resume, undefined);
    if (initialized) h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: uuid(80) });
    staleRenderer.turns.push({ runId: uuid(9), user: 'Fill the remaining 14 rows.', assistant: '' });
    await h.save(staleRenderer);
    const result = await h.send(staleRenderer, { prompt: 'Fill the remaining 14 rows.',
      taskContext: { userPrompt: 'Fill the remaining 14 rows.', turnRef: { index: 1 } } });
    assert.equal(result.error, undefined);
    const running = h.context.liveSessions.get(h.record.id);
    await running.pendingInput.done;
    assert.equal(running, warm, 'reuse the prepared replacement instead of restarting MCP');
    assert.equal(h.calls.live.length, 1);
    const sent = h.calls.pushes.at(-1).text;
    assert.match(sent, /https:\/\/fixture.invalid\/sheets\/synthetic-table/);
    assert.match(sent, /Filled synthetic change numbers; 14 rows remain blank/);
    assert.equal(sent.split('Fill the remaining 14 rows.').length - 1, 1);
    assert.equal(sent.split('以下是我们之前的对话记录，供你参考延续：').length - 1, 1);
    if (!initialized) assert.equal(h.records.get(h.record.id).sdkRuntimeFingerprint, priorFingerprint,
      'a fresh executor cannot relabel the old persisted native handle');
  });
}

test('a matching resumed prewarm continues natively without duplicating visible history after a renderer save', async t => {
  const h = fixture(t, { inProject: true });
  h.workspaces.markContextCarried(h.record.id);
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const warm = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
    attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  assert.equal(warm.prewarm, null);
  assert.equal(h.calls.live[0].options.resume, h.record.sessionId);
  const incoming = clone(h.record);
  incoming.turns.push({ runId: uuid(9), user: 'Follow up natively.', assistant: '' });
  await h.save(incoming);
  await h.send(incoming, { prompt: 'Follow up natively.', taskContext: { turnRef: { index: 1 } } });
  await warm.pendingInput.done;
  assert.equal(h.context.liveSessions.get(h.record.id), warm);
  assert.equal(h.calls.pushes.at(-1).text, 'Follow up natively.');
});

for (const restart of [false, true]) {
  test(`an unused fresh init cannot replace durable context across ${restart ? 'app restart' : 'idle recycle'}`, async t => {
    const h = fixture(t, { inProject: true });
    h.workspaces.markContextCarried(h.record.id);
    h.settings.relayInstructions = 'Updated runtime before follow-up.';
    const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
    const options = { ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
      attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') };
    const oldId = h.record.sessionId, oldFingerprint = h.record.sdkRuntimeFingerprint;
    const warm = h.context.prespawnSession(options);
    h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: uuid(82) });
    assert.equal(warm.sessionId, uuid(82), 'the live engine may learn its empty identity');
    assert.equal(h.records.get(h.record.id).sessionId, oldId, 'idle init must preserve the history-bearing handle');
    assert.equal(h.records.get(h.record.id).sdkRuntimeFingerprint, oldFingerprint);
    vm.runInContext(declaration('killLiveSession'), h.context);
    await h.context.killLiveSession(warm, 'synthetic idle recycle');
    assert.equal(h.context.liveTombstones.has(h.record.id), false, 'kill cannot publish an empty replacement tombstone');
    h.calls.live[0].params.onExit(0);
    assert.equal(h.context.liveTombstones.has(h.record.id), false, 'native close cannot publish it either');
    if (restart) { h.context.liveSessions.clear(); h.context.liveTombstones.clear(); }
    const next = h.context.prespawnSession(options);
    assert.equal(h.calls.live[1].options.resume, undefined);
    const incoming = clone(h.record);
    incoming.turns.push({ runId: uuid(9), user: 'Continue after recycle.', assistant: '' });
    await h.save(incoming);
    await h.send(incoming, { prompt: 'Continue after recycle.', taskContext: { turnRef: { index: 1 } } });
    await next.pendingInput.done;
    assert.equal(h.context.liveSessions.get(h.record.id), next);
    assert.match(h.calls.pushes.at(-1).text, /before boundary/);
    assert.match(h.calls.pushes.at(-1).text, /visible reply/);
  });
}

for (const recycle of [false, true]) {
  test(`fresh init during input preparation preserves history after a pause ${recycle ? 'and recycle' : 'that keeps the Query'}`, async t => {
    const h = fixture(t, { inProject: true });
    h.workspaces.markContextCarried(h.record.id);
    h.settings.relayInstructions = 'Changed runtime awaiting user history.';
    const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
    const warm = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
      attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
    let releaseMcp, prepared;
    const preparing = new Promise(resolve => { prepared = resolve; });
    warm.child.prepareMcp = () => { prepared(); return new Promise(resolve => { releaseMcp = resolve; }); };
    const incoming = clone(h.record);
    incoming.turns.push({ runId: uuid(9), user: 'Continue when prepared.', assistant: '' });
    await h.save(incoming);
    await h.send(incoming, { prompt: 'Continue when prepared.', taskContext: { turnRef: { index: 1 } } });
    const pending = warm.pendingInput;
    await preparing;
    assert.equal(warm.prewarm, null, 'reservation already consumed the prewarm reuse certificate');
    h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: uuid(83) });
    assert.equal(h.calls.pushes.length, 0, 'MCP preparation still holds the history-bearing input');
    assert.equal(h.records.get(h.record.id).sessionId, h.record.sessionId,
      'init during preparation cannot certify an empty transcript as history-bearing');
    assert.equal(h.records.get(h.record.id).sdkRuntimeFingerprint, h.record.sdkRuntimeFingerprint);
    vm.runInContext(declaration('settleLiveSupplements'), h.context);
    vm.runInContext(declaration('settleUnsentLiveTurn'), h.context);
    h.context.settleUnsentLiveTurn(warm, uuid(9), 'Synthetic preparation pause.', true);
    releaseMcp({ ok: true, items: [] }); await pending.done;
    assert.equal(h.calls.pushes.length, 0);
    vm.runInContext(declaration('killLiveSession'), h.context);
    if (recycle) {
      await h.context.killLiveSession(warm, 'Synthetic paused recycle');
      h.calls.live[0].params.onExit(0);
      assert.equal(h.context.liveTombstones.has(h.record.id), false);
    }
    incoming.turns[1].status = 'paused';
    incoming.turns.push({ runId: uuid(10), user: 'Continue explicitly after pause.', assistant: '' });
    await h.save(incoming);
    await h.send(incoming, { runId: uuid(10), prompt: 'Continue explicitly after pause.', taskContext: { turnRef: { index: 2 } } });
    await h.context.liveSessions.get(h.record.id).pendingInput.done;
    assert.equal(h.calls.live[1].options.resume, undefined);
    assert.match(h.calls.pushes.at(-1).text, /before boundary/);
    assert.match(h.calls.pushes.at(-1).text, /visible reply/);
  });
}

test('only absorbed user input advances a fresh Query durable identity and permits native resume', async t => {
  const h = fixture(t, { inProject: true });
  h.workspaces.markContextCarried(h.record.id);
  h.settings.relayInstructions = 'Changed runtime awaiting native consumption.';
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const warm = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
    attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  const incoming = clone(h.record);
  incoming.turns.push({ runId: uuid(9), user: 'Continue after startup.', assistant: '' });
  await h.save(incoming);
  await h.send(incoming, { prompt: 'Continue after startup.', taskContext: { turnRef: { index: 1 } } });
  await warm.pendingInput.done;
  const emit = h.calls.live[0].params.onMessage;
  emit({ type: 'system', subtype: 'init', session_id: uuid(84) });
  emit({ type: 'command_lifecycle', state: 'queued', command_uuid: uuid(9) });
  emit({ type: 'command_lifecycle', state: 'started', command_uuid: uuid(85) });
  emit({ type: 'command_lifecycle', state: 'started', command_uuid: uuid(9), parent_tool_use_id: 'synthetic-child' });
  assert.equal(h.records.get(h.record.id).sessionId, h.record.sessionId,
    'init, queue acknowledgement, internal commands and child input do not prove history consumption');
  emit({ type: 'command_lifecycle', state: 'started', command_uuid: uuid(9) });
  const saved = h.records.get(h.record.id);
  assert.equal(saved.sessionId, uuid(84));
  assert.equal(saved.sdkRuntimeFingerprint, warm.launchSpec.runtimeFingerprint);
  assert.equal(saved.turns[1].sdkSessionContext.sessionId, uuid(84));
  vm.runInContext(declaration('settleLiveSupplements'), h.context);
  vm.runInContext(declaration('settleUnsentLiveTurn'), h.context);
  h.context.settleUnsentLiveTurn(warm, uuid(9), 'Synthetic pause after absorption.', true);
  vm.runInContext(declaration('killLiveSession'), h.context);
  await h.context.killLiveSession(warm, 'Synthetic resumed recycle');
  assert.equal(h.context.liveTombstones.get(h.record.id).sessionId, uuid(84));
  const next = clone(saved);
  next.turns[1].status = 'paused';
  next.turns.push({ runId: uuid(10), user: 'Follow up natively again.', assistant: '' });
  await h.save(next);
  await h.send(next, { runId: uuid(10), prompt: 'Follow up natively again.', taskContext: { turnRef: { index: 2 } } });
  await h.context.liveSessions.get(h.record.id).pendingInput.done;
  assert.equal(h.calls.live[1].options.resume, uuid(84));
  assert.equal(h.calls.pushes.at(-1).text, 'Follow up natively again.');
});

test('an explicitly cleared conversation does not regain old history from a replacement prewarm', async t => {
  const h = fixture(t, { inProject: true });
  h.record.sdkContextBoundary = { turnIndex: 1, afterRunId: h.record.turns[0].runId };
  h.context.persistConversationRecord(h.record); h.workspaces.markContextCarried(h.record.id);
  h.settings.relayInstructions = 'Updated synthetic runtime instructions.';
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const warm = h.context.prespawnSession({ ...resolved, convId: h.record.id, mode: 'plain', model: 'haiku', effort: 'low',
    attachCronMcp: true, sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku') });
  h.calls.live[0].params.onMessage({ type: 'system', subtype: 'init', session_id: uuid(81) });
  const incoming = clone(h.record);
  incoming.turns.push({ runId: uuid(9), user: 'A new task after clear.', assistant: '' });
  await h.save(incoming);
  await h.send(incoming, { prompt: 'A new task after clear.', taskContext: { turnRef: { index: 1 } } });
  await warm.pendingInput.done;
  assert.equal(h.context.liveSessions.get(h.record.id), warm);
  assert.equal(h.calls.pushes.at(-1).text, 'A new task after clear.');
});

test('saved context-recovery markers survive stale renderer saves and wait for an explicit next send', async t => {
  const h = fixture(t, { inProject: true });
  h.workspaces.markContextCarried(h.record.id);
  const staleRenderer = clone(h.record);
  const repaired = { ...clone(h.record), sessionId: null, sdkResumeRejected: true, carryContextOnNextTurn: 'context-recovery' };
  h.context.persistConversationRecord(repaired);
  await h.save(staleRenderer);
  const saved = h.records.get(h.record.id);
  assert.equal(saved.sessionId, null);
  assert.equal(saved.sdkResumeRejected, true);
  assert.equal(saved.carryContextOnNextTurn, 'context-recovery');
  assert.deepEqual(saved.sdkSessionContext, repaired.sdkSessionContext);
  assert.deepEqual(saved.turns, repaired.turns);
  assert.equal(h.calls.live.length, 0, 'saving a recovery marker cannot start work');
  assert.equal(h.calls.pushes.length, 0);
  const incoming = clone(saved);
  incoming.turns.push({ runId: uuid(9), user: 'Continue explicitly.', assistant: '' });
  await h.save(incoming);
  await h.send(incoming, { sessionId: null, prompt: 'Continue explicitly.', taskContext: { turnRef: { index: 1 } } });
  await h.context.liveSessions.get(h.record.id).pendingInput.done;
  assert.equal(h.calls.live[0].options.resume, undefined);
  assert.match(h.calls.pushes[0].text, /before boundary/);
  assert.match(h.calls.pushes[0].text, /visible reply/);
  assert.equal(h.calls.pushes[0].text.split('Continue explicitly.').length - 1, 1);
});

test('one-shot admission rebuilds its own current guidance contract and never silently resumes stale instructions', t => {
  const h = fixture(t, { inProject: true });
  h.settings.relayInstructions = 'Always explain the result first.';
  const resolved = h.context.resolveExecutionWorkspace({ conversationId: h.record.id });
  const result = h.context.runClaudeJob({ ...resolved, conversationId: h.record.id, model: 'haiku', effort: 'low',
    sessionId: h.record.sessionId, sessionRoute: h.context.providerSessionRoute(h.runtime, 'haiku'), prompt: 'Scheduled follow-up', onEvent() {} });
  assert.equal(result.resumeAccepted, false);
  const call = h.calls.oneShot.at(-1);
  assert.equal(call.options.resume, undefined);
  assert.ok(call.options.systemPrompt.append.includes(h.settings.relayInstructions));
  assert.match(call.params.prompt, /before boundary/);
  assert.match(call.params.prompt, /Scheduled follow-up/);
});

test('local delivery link roots use saved project membership and only the selected conversation scratch', t => {
  const h = fixture(t, { inProject: true });
  const alien = path.join(h.root, 'unrelated-project'); fs.mkdirSync(alien);
  h.records.set(h.record.id, { ...h.record, sdkSessionContext: { ...h.record.sdkSessionContext, wslDistribution: 'Saved-Fixture-Distro' } });
  h.context.liveSessions.set(h.record.id, { workspaceRoot: alien, launchSpec: { cwd: h.record.workingDir.path }, busy: false });
  const resolved = h.context.resolveLinkWorkspace({ conversationId: h.record.id, workingDir: alien, roots: [alien], projectId: 'forged' });
  assert.equal(resolved.root, h.record.workingDir.path);
  assert.deepEqual(clone(resolved.roots), [h.record.workingDir.path, h.workspaces.resolveScratch(h.record.id)]);
  assert.equal(resolved.wslDistribution, 'Saved-Fixture-Distro');
  assert.equal(resolved.roots.includes(h.workspaces.resolveScratch(uuid(99))), false);
  assert.throws(() => h.context.resolveLinkWorkspace({ conversationId: '../other' }), /对话/);
});
