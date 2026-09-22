'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function declaration(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
const snapshot = { totalTokens: 31000, maxTokens: 100000, rawMaxTokens: 128000, percentage: 33, model: 'fixture-model' };
function host() {
  let now = 10000, handler;
  const calls = [], writes = [], timeouts = [];
  const conv = { id: 'chat-a', updatedAt: '2026-01-01T00:00:00Z', turns: [] };
  const sess = { convId: conv.id, jobId: 'job-a', busy: true, dead: false,
    launchSpec: { model: snapshot.model, routeTier: 'haiku', providerId: 'fixture', providerRevision: 1 },
    child: { getContextUsage(options) { calls.push(clone(options)); return Promise.resolve(snapshot); } },
  };
  const context = vm.createContext({
    console, Date: class extends Date { static now() { return now; } }, liveSessions: new Map([[conv.id, sess]]),
    loadConversation: () => clone(conv), convFilePath: id => id,
    writeJsonAtomic(_file, value) { writes.push(clone(value)); },
    withLiveControlTimeout(promise, label, ms) { const timeout = deferred(); timeouts.push({ ...timeout, label, ms }); return Promise.race([promise, timeout.promise]); },
    readSupportedModels: async () => { throw Error('unrelated model catalog unavailable'); },
    ipcMain: { handle(name, fn) { assert.equal(name, 'claude:runtimeInfo'); handler = fn; } },
  });
  for (const name of ['compactContextUsage', 'contextRuntimeKey', 'readLiveContextUsage', 'persistConversationContextUsage']) vm.runInContext(declaration(main, name), context);
  const start = main.indexOf("ipcMain.handle('claude:runtimeInfo'");
  const end = main.indexOf('// IPC:空闲常驻会话原地切换模型和 effort。', start);
  vm.runInContext(main.slice(start, end), context);
  return { context, sess, calls, writes, timeouts, advance(ms = 2000) { now += ms; }, read: options => handler(null, conv.id, options) };
}

test('busy reads use summary, deduplicate and throttle, without persisting each refresh', async () => {
  const h = host(), pending = deferred();
  h.sess.child.getContextUsage = options => { h.calls.push(clone(options)); return pending.promise; };
  const first = h.read({ contextOnly: true }), second = h.read({ contextOnly: true });
  await flush(); assert.equal(h.calls.length, 1);
  pending.resolve(snapshot);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].context.percentage, 33); // SDK percentage, not a recomputed ratio.
  assert.equal(results[1].context.running, true);
  assert.deepEqual(h.calls, [{ detail: 'summary' }]);
  assert.equal(Object.hasOwn(results[0], 'models'), false);
  assert.deepEqual(h.writes, []);
  await h.read({ contextOnly: true }); assert.equal(h.calls.length, 1);
  h.advance(); await h.read({ contextOnly: true }); assert.equal(h.calls.length, 2);
});

test('timeout returns promptly while the underlying pending query stays deduplicated', async () => {
  const h = host(), pending = deferred();
  h.sess.child.getContextUsage = options => { h.calls.push(options); return pending.promise; };
  const read = h.read({ contextOnly: true }); await flush();
  assert.equal(h.timeouts[0].ms, 4000);
  h.timeouts[0].reject(Error('timeout')); assert.equal((await read).context, null);
  h.advance(10000); assert.equal((await h.read({ contextOnly: true })).context, null);
  assert.equal(h.calls.length, 1);
  pending.resolve(snapshot); await flush();
  assert.equal((await h.read({ contextOnly: true })).context.totalTokens, 31000);
  assert.deepEqual(h.writes, []);
});

test('late context results from a replaced session or switched model are discarded', async () => {
  for (const change of ['session', 'model']) {
    const h = host(), pending = deferred(); h.sess.child.getContextUsage = () => pending.promise;
    const read = h.read({ contextOnly: true }); await flush();
    if (change === 'session') h.context.liveSessions.set(h.sess.convId, { ...h.sess });
    else h.sess.launchSpec = { ...h.sess.launchSpec, model: 'new-model' };
    pending.resolve(snapshot);
    assert.equal((await read).stale, true);
    assert.equal(h.sess.contextUsageRead.value, null);
    assert.deepEqual(h.writes, []);
  }
});

test('idle completion bypasses the running cache and writes only context, preserving activity time', async () => {
  const h = host(); await h.read({ contextOnly: true });
  h.sess.busy = false; h.sess.jobId = null;
  const result = await h.read();
  assert.equal(result.context.running, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].updatedAt, '2026-01-01T00:00:00Z');
  await h.read(); assert.equal(h.writes.length, 1);
  h.advance(); await h.read({ includeContext: false }); assert.equal(h.calls.length, 2);
});

test('unknown or nonfinite model windows are never fabricated or serialized as Infinity', async () => {
  const h = host(); h.sess.child.getContextUsage = async () => ({ totalTokens: 1, maxTokens: Infinity, percentage: Infinity });
  const info = await h.read({ contextOnly: true });
  assert.equal(info.context.maxTokens, 0);
  assert.equal(info.context.percentage, 0);
  assert.equal(clone(info.context).maxTokens, 0);
  assert.equal(h.context.compactContextUsage({ percentage: 117 }).percentage, 117);
});

function ui() {
  let nextId = 0;
  const calls = [], timers = new Map(), listeners = new Map();
  const route = { providerId: 'fixture', providerRevision: 1, modelId: 'fixture-model' };
  const context = vm.createContext({
    console, window: { api: { claudeRuntimeInfo: async (id, options) => { calls.push({ id, options }); return { ok: true, busy: true, providerId: 'fixture', providerRevision: 1, model: route.modelId, context: snapshot }; } }, addEventListener(name, fn) { listeners.set(name, fn); } },
    document: { hidden: false, addEventListener(name, fn) { listeners.set(name, fn); } },
    currentConv: { id: 'chat-a' }, currentModel: 'haiku', activeView: 'chat', runs: new Map([['chat-a', { jobId: 'job-a' }]]),
    claudeRuntimeUIRevision: 0, claudeRuntimeReadRevision: 0, pendingClaudeRuntimeSelection: null,
    contextUsageEnabled: true, contextUsageByConv: new Map(), contextUsageReadRevisions: new Map(),
    contextUsagePollTimer: null, contextUsagePollRevision: 0, contextUsagePollKey: '', contextUsagePollInFlight: null,
    configuredChatRoute: () => route,
    renderContextUsage() {}, updateModelSwitchUI() {}, isConvRunning: id => context.runs.has(id),
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  for (const name of ['refreshClaudeRuntimeInfo', 'contextUsagePollingKey', 'syncContextUsagePolling']) vm.runInContext(declaration(renderer, name), context);
  return { context, calls, timers, listeners, route, async tick() { const [id, timer] = [...timers][0]; timers.delete(id); await timer.fn(); } };
}

test('renderer polls only the active running chat, stops on page changes, and resumes when visible', async () => {
  const h = ui(); h.context.syncContextUsagePolling();
  await h.tick(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.contextOnly, true);
  assert.equal([...h.timers.values()][0].ms, 2000);
  assert.equal(h.context.currentConv.contextUsage, undefined);
  h.context.activeView = 'settings'; h.listeners.get('relay:view-changed')();
  assert.equal(h.timers.size, 0);
  h.context.activeView = 'chat'; h.listeners.get('relay:view-changed')(); await h.tick();
  assert.equal(h.calls.length, 2);
  h.context.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal(h.timers.size, 0);
  h.context.document.hidden = false; h.listeners.get('visibilitychange')(); await h.tick();
  h.context.runs.clear(); h.context.syncContextUsagePolling();
  assert.equal(h.timers.size, 0);
});

test('renderer does not overlap slow polls and discards the result after stopping', async () => {
  const h = ui(), pending = deferred();
  h.context.window.api.claudeRuntimeInfo = (...args) => { h.calls.push(args); return pending.promise; };
  h.context.syncContextUsagePolling(); const tick = h.tick(); await flush();
  h.context.syncContextUsagePolling(); assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1);
  h.context.runs.clear(); h.context.syncContextUsagePolling();
  pending.resolve({ providerId: 'fixture', model: 'fixture-model', context: snapshot }); await tick;
  assert.equal(h.context.contextUsageByConv.size, 0);
  assert.equal(h.timers.size, 0);
});

test('renderer rejects context if the provider revision changes during a read', async () => {
  const h = ui(), pending = deferred(); h.context.window.api.claudeRuntimeInfo = () => pending.promise;
  const read = h.context.refreshClaudeRuntimeInfo('chat-a', { contextOnly: true });
  h.route.providerRevision = 2;
  pending.resolve({ providerId: 'fixture', providerRevision: 1, context: snapshot }); await read;
  assert.equal(h.context.contextUsageByConv.size, 0);
});

test('renderer rejects an old context reply when reset changes the SDK session within the same run', async () => {
  const h = ui(), pending = deferred();
  h.context.currentConv.sessionId = 'old'; h.context.window.api.claudeRuntimeInfo = () => pending.promise;
  const read = h.context.refreshClaudeRuntimeInfo('chat-a', { contextOnly: true });
  h.context.currentConv.sessionId = 'new';
  pending.resolve({ providerId: 'fixture', providerRevision: 1, context: snapshot }); await read;
  assert.equal(h.context.contextUsageByConv.size, 0);
});
