'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function declaration(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
const sdkAlias = { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Claude Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] };
const remote = { value: 'xiaomi/mimo-x-pro-preview', displayName: 'Mimo', supportsEffort: true, supportedEffortLevels: ['low', 'high'] };
const tiers = [{ value: 'haiku', label: '快速', preferredEffort: 'low' }, { value: 'opus', label: '专家', preferredEffort: 'max' }];
const route = tier => ({ tier, modelId: tier === 'opus' ? remote.value : 'xiaomi/mimo-v2.5-pro', providerId: 'fixture', providerRevision: 1, configured: true, available: true });

function ui() {
  const calls = [], saved = [], notices = [], routes = tiers.map(t => route(t.value));
  const conv = { id: 'history-a', model: 'haiku', sessionId: 'session-a', sessionProviderId: 'fixture', sessionProviderRevision: 1 };
  const context = {
    console, Map, Object,
    currentConv: conv, currentModel: 'haiku', currentEffort: null, currentSessionId: conv.sessionId,
    supportedClaudeModels: [clone(sdkAlias)], supportedClaudeProviderId: 'fixture',
    claudeRuntimeUIRevision: 0, claudeRuntimeReadRevision: 0, pendingClaudeRuntimeSelection: null,
    providerRoutingLoaded: true, contextUsageEnabled: true, contextUsageByConv: new Map(), contextUsageReadRevisions: new Map(),
    btnModelSwitch: { disabled: false }, modelPopup: null,
    EFFORT_LABELS: { low: '低', high: '高', max: '最大' },
    configuredChatRoute: tier => routes.find(item => item.tier === tier) || null,
    currentTier: () => tiers.find(t => t.value === context.currentModel),
    updateModelSwitchUI() {}, rememberModelPopupHome() {}, hideModelPopup() {},
    showToast: text => notices.push(text), isConvRunning: () => false, renderContextUsage() {},
    window: { api: {
      setClaudeRuntime: async (...args) => { calls.push(args); return { ok: true, applied: true, providerId: 'fixture', providerRevision: 1, routeTier: args[1], effort: args[2] }; },
      claudeRuntimeInfo: async () => ({ ok: true, providerId: 'fixture', models: [clone(sdkAlias)], effort: null }),
      history: { save: async value => { saved.push(clone(value)); return value; } },
    } },
  };
  vm.createContext(context);
  for (const name of ['modelCapability', 'runtimeModelForValue', 'effortForTier', 'supportedEffortLevelsForTier', 'refreshClaudeRuntimeInfo', 'selectModelTier', 'selectEffortLevel']) vm.runInContext(declaration(renderer, name), context);
  return { context, conv, routes, calls, saved, notices };
}

test('configured third-party tier never borrows a native alias capability', () => {
  const h = ui();
  assert.equal(h.context.modelCapability('opus'), null);
  assert.equal(h.context.effortForTier(tiers[1]), null);
  assert.deepEqual(clone(h.context.supportedEffortLevelsForTier(tiers[1])), []);
  h.context.supportedClaudeModels = [];
  assert.deepEqual(clone(h.context.supportedEffortLevelsForTier(tiers[1])), []);
});

test('exact remote value or resolvedModel provides its own effort levels before alias rows', () => {
  const h = ui();
  h.context.supportedClaudeModels.push(clone(remote));
  assert.equal(h.context.modelCapability('opus').displayName, 'Mimo');
  assert.equal(h.context.effortForTier(tiers[1]), 'high');
  h.context.supportedClaudeModels = [{ ...clone(remote), value: 'mapped', resolvedModel: remote.value }];
  assert.equal(h.context.modelCapability('opus').value, 'mapped');
  h.context.supportedClaudeProviderId = 'other';
  assert.equal(h.context.modelCapability('opus'), null);
});

test('configured native aliases retain SDK window-suffix compatibility without guessing remote namespaces', () => {
  const h = ui();
  h.routes[1].modelId = 'opus';
  h.context.supportedClaudeModels = [{ ...clone(sdkAlias), value: 'opus[1m]' }];
  assert.equal(h.context.modelCapability('opus').value, 'opus[1m]');
  h.routes[1].modelId = 'provider/claude-opus-5';
  assert.equal(h.context.modelCapability('opus'), null);
});

test('history selection sends the configured tier without fabricated effort and preserves the session', async () => {
  const h = ui();
  h.conv.contextUsage = { totalTokens: 1, maxTokens: 100 };
  h.context.contextUsageByConv.set(h.conv.id, h.conv.contextUsage);
  await h.context.selectModelTier(tiers[1]);
  assert.deepEqual(h.calls, [['history-a', 'opus', null]]);
  assert.equal(h.conv.model, 'opus'); assert.equal(h.conv.sessionModel, 'opus');
  assert.equal(h.conv.sessionId, 'session-a'); assert.equal(h.context.currentSessionId, 'session-a');
  assert.equal(h.conv.contextUsage, undefined); assert.equal(h.context.contextUsageByConv.has(h.conv.id), false);
  assert.equal(h.context.btnModelSwitch.disabled, false); assert.deepEqual(h.notices, []);
});

test('unknown tier is rejected before any runtime call', async () => {
  const h = ui();
  await h.context.selectModelTier({ value: 'sonnet', label: '思考' });
  assert.deepEqual(h.calls, []); assert.match(h.notices[0], /尚未配置/);
});

test('runtime info from a previous conversation cannot pollute the current context or cache', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.claudeRuntimeInfo = () => pending.promise;
  const request = h.context.refreshClaudeRuntimeInfo(h.conv.id);
  h.context.currentConv = { id: 'history-b', effort: 'low' }; h.context.currentEffort = 'low';
  pending.resolve({ providerId: 'other', effort: 'max', models: [remote], context: { totalTokens: 10, maxTokens: 100 } });
  await request;
  assert.equal(h.context.currentEffort, 'low'); assert.equal(h.context.supportedClaudeProviderId, 'fixture');
  assert.equal(h.context.contextUsageByConv.has('history-a'), false);
  assert.equal(h.context.currentConv.contextUsage, undefined);
});

test('route revision changes invalidate an in-flight runtime capability result', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.claudeRuntimeInfo = () => pending.promise;
  const request = h.context.refreshClaudeRuntimeInfo(h.conv.id);
  h.routes[0] = { ...h.routes[0], providerRevision: 2 };
  pending.resolve({ providerId: 'fixture', effort: 'max', models: [remote] });
  await request;
  assert.equal(h.context.currentEffort, null); assert.equal(h.context.supportedClaudeModels[0].value, 'opus');
});

test('only the newest runtime read updates capabilities and empty results clear stale models', async () => {
  const h = ui(), first = deferred(), second = deferred(); let count = 0;
  h.context.window.api.claudeRuntimeInfo = () => (++count === 1 ? first : second).promise;
  const a = h.context.refreshClaudeRuntimeInfo(h.conv.id), b = h.context.refreshClaudeRuntimeInfo(h.conv.id);
  second.resolve({ providerId: 'fixture', effort: null, models: [] }); await b;
  first.resolve({ providerId: 'fixture', effort: 'max', models: [sdkAlias] }); await a;
  assert.deepEqual(clone(h.context.supportedClaudeModels), []); assert.equal(h.context.currentEffort, null);
});

test('runtime effort belongs to its actual model and explicit null clears saved legacy effort', async () => {
  const h = ui(); h.conv.effort = 'max'; h.context.currentEffort = 'max';
  h.context.window.api.claudeRuntimeInfo = async () => ({ providerId: 'fixture', routeTier: 'opus', effort: 'high', models: [remote] });
  await h.context.refreshClaudeRuntimeInfo(h.conv.id);
  assert.equal(h.context.currentEffort, 'max'); assert.equal(h.context.supportedClaudeModels[0].value, 'opus');
  h.context.window.api.claudeRuntimeInfo = async () => ({ providerId: 'fixture', routeTier: 'haiku', effort: null, models: [] });
  await h.context.refreshClaudeRuntimeInfo(h.conv.id);
  assert.equal(h.context.currentEffort, null);
});

test('late model success persists only the originating conversation and never clears another session', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.setClaudeRuntime = () => pending.promise;
  const request = h.context.selectModelTier(tiers[1]);
  const other = h.context.currentConv = { id: 'history-b', model: 'haiku' };
  h.context.currentModel = 'haiku'; h.context.currentSessionId = 'session-b';
  pending.resolve({ ok: true, restartRequired: true, providerId: 'another', providerRevision: 1 });
  await request;
  assert.equal(h.saved[0].id, 'history-a'); assert.equal(h.saved[0].model, 'opus');
  assert.equal(h.saved[0].carryContextOnNextTurn, 'provider');
  assert.deepEqual(other, { id: 'history-b', model: 'haiku' });
  assert.equal(h.context.currentSessionId, 'session-b'); assert.deepEqual(h.notices, []);
});

test('late model errors cannot roll back another conversation selection', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.setClaudeRuntime = () => pending.promise;
  const request = h.context.selectModelTier(tiers[1]);
  h.context.currentConv = { id: 'history-b' }; h.context.currentModel = 'opus'; h.context.currentEffort = 'low';
  pending.resolve({ ok: false, message: 'actual model rejection' }); await request;
  assert.equal(h.context.currentModel, 'opus'); assert.equal(h.context.currentEffort, 'low');
  assert.deepEqual(h.saved, []); assert.deepEqual(h.notices, []);
});

test('runtime reads during pending selection cannot overwrite effort or leave its button disabled', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.setClaudeRuntime = () => pending.promise;
  const request = h.context.selectModelTier(tiers[1]);
  h.context.window.api.claudeRuntimeInfo = async () => ({ providerId: 'fixture', effort: 'max', models: [sdkAlias] });
  await h.context.refreshClaudeRuntimeInfo(h.conv.id);
  assert.equal(h.context.currentEffort, null);
  pending.resolve({ ok: true, applied: true, providerId: 'fixture', effort: null }); await request;
  assert.equal(h.context.currentEffort, null); assert.equal(h.context.btnModelSwitch.disabled, false);
});

test('effort success after navigation only persists its source conversation', async () => {
  const h = ui(), pending = deferred();
  h.context.currentModel = 'opus'; h.context.supportedClaudeModels = [remote];
  h.context.window.api.setClaudeRuntime = () => pending.promise;
  const request = h.context.selectEffortLevel('high');
  h.context.currentConv = { id: 'history-b', model: 'haiku' }; h.context.currentModel = 'haiku'; h.context.currentEffort = 'low';
  pending.resolve({ ok: true, applied: true, effort: 'high' }); await request;
  assert.equal(h.saved[0].id, 'history-a'); assert.equal(h.saved[0].effort, 'high');
  assert.equal(h.context.currentConv.effort, undefined); assert.equal(h.context.currentEffort, 'low');
});

function backend() {
  const calls = [], routes = tiers.map(t => route(t.value));
  const sess = { convId: 'history-a', busy: false, dead: false,
    launchSpec: { model: routes[0].modelId, routeTier: 'haiku', providerId: 'fixture', providerRevision: 1, effort: null },
    child: { supportedModels: async () => [clone(sdkAlias)], setModel: async value => calls.push(['model', value]), applyFlagSettings: async value => calls.push(['effort', clone(value)]) },
  };
  let handler;
  const context = {
    Map, Set, JSON, Number, String, Array, Promise,
    console: { warn() {} }, RELAY_MODEL_TIERS: new Set(['haiku', 'sonnet', 'opus']), SDK_EFFORT_LEVELS: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    liveSessions: new Map([[sess.convId, sess]]), liveTombstones: new Map([[sess.convId, { sessionId: 'old-session' }]]), supportedModelsCache: new Map(),
    withLiveControlTimeout: promise => promise, relayGitBashPath: () => '', readAppSettings: () => ({}),
    providerStore: {
      getRoutingView: () => ({ chatRoutes: routes, defaultModel: 'haiku' }),
      getChatRuntime: tier => { const found = routes.find(r => r.tier === tier && r.configured && r.available); return found ? { id: found.providerId, revision: found.providerRevision, modelId: found.modelId, env: {} } : null; },
    },
    killLiveSession: async (value, reason) => { calls.push(['kill', reason]); value.dead = true; context.liveSessions.delete(value.convId); },
    ipcMain: { handle(name, fn) { assert.equal(name, 'claude:setRuntime'); handler = fn; } },
  };
  vm.createContext(context);
  for (const name of ['relayModelTier', 'activeRelayProviderRuntime', 'publicModelInfo', 'readSupportedModels', 'sessionFingerprint']) vm.runInContext(declaration(main, name), context);
  const start = main.indexOf("ipcMain.handle('claude:setRuntime'");
  const end = main.indexOf('\nasync function waitForLiveTurnIdle(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(main.slice(start, end), context);
  return { context, sess, calls, routes, run: options => handler(null, { convId: sess.convId, model: 'opus', ...options }) };
}

test('real main handler switches a restored same-provider custom model absent from SDK aliases', async () => {
  const h = backend(); const result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.applied, true);
  assert.deepEqual(h.calls, [['model', remote.value]]); assert.equal(h.sess.launchSpec.model, remote.value);
});

test('real main handler does not turn a model-directory error into a model rejection', async () => {
  const h = backend(); h.sess.child.supportedModels = async () => { throw Error('directory unavailable'); };
  assert.equal((await h.run()).ok, true); assert.deepEqual(h.calls, [['model', remote.value]]);
});

test('real model-switch failures still reach the caller and do not commit new metadata', async () => {
  const h = backend(); h.sess.child.setModel = async () => { throw Error('gateway rejected configured model'); };
  const result = await h.run();
  assert.equal(result.ok, false); assert.match(result.message, /gateway rejected/);
  assert.equal(h.sess.launchSpec.model, h.routes[0].modelId);
});

test('real main handler rejects an unconfigured target tier and a busy session', async () => {
  const h = backend();
  assert.equal((await h.run({ model: 'sonnet' })).ok, false); assert.deepEqual(h.calls, []);
  h.sess.busy = true; assert.equal((await h.run()).busy, true); assert.deepEqual(h.calls, []);
});

test('same custom model may change effort without requiring its presence in SDK directory', async () => {
  const h = backend(); h.sess.launchSpec.model = remote.value;
  assert.equal((await h.run({ effort: 'high' })).ok, true);
  assert.deepEqual(h.calls, [['effort', { effortLevel: 'high' }]]);
});

test('exact model effort restrictions remain enforced by the real handler', async () => {
  const h = backend(); h.sess.child.supportedModels = async () => [remote];
  const result = await h.run({ effort: 'max' });
  assert.equal(result.ok, false); assert.match(result.message, /不支持 max/); assert.deepEqual(h.calls, []);
});

test('cross-provider switches still recycle the old session and defer using a fresh route', async () => {
  const h = backend(); h.routes[1].providerId = 'other';
  const result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.restartRequired, true); assert.equal(result.applied, false);
  assert.equal(result.providerId, 'other'); assert.equal(h.context.liveTombstones.has(h.sess.convId), false);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'kill');
});

test('no live session uses the same configured target while an old instance cannot win a capability-read race', async () => {
  const h = backend(); h.context.liveSessions.clear();
  const result = await h.run(); assert.equal(result.deferred, true); assert.equal(result.model, remote.value);
  assert.equal(h.context.liveTombstones.size, 0); assert.deepEqual(h.calls, []);
  h.context.liveSessions.set(h.sess.convId, h.sess);
  h.sess.child.supportedModels = async () => { h.context.liveSessions.set(h.sess.convId, { dead: false }); return [sdkAlias]; };
  assert.equal((await h.run()).ok, false); assert.deepEqual(h.calls, []);
});
