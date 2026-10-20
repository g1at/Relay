'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');

function fixture({ createAutomation, getConversationContext } = {}) {
  const entryFile = path.resolve(__dirname, '../renderer/index.html');
  const url = pathToFileURL(entryFile).href;
  const handlers = new Map(), created = [], sent = [];
  const contents = { mainFrame: { url }, getURL: () => url, getZoomFactor: () => 1.25,
    isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const owner = { webContents: contents, isDestroyed: () => false };
  let current = owner;
  const registry = registerBrowserPanelIpc({ entryFile, getWindow: () => current,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getElectron: () => ({}), createAutomation, getConversationContext,
    createHost: options => {
      const calls = [];
      const host = { options, calls, destroyed: false, isDestroyed() { return this.destroyed; },
        destroy() { this.destroyed = true; }, cancelAnnotation: () => ({ ok: true }), captureAnnotationTarget: () => () => true,
        invoke: async request => { calls.push(request); return { ok: true }; } };
      created.push(host); return host;
    },
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { registry, handlers, created, contents, owner, event, sent, setOwner: value => { current = value; },
    invoke: (input, caller = event) => handlers.get('browser:invoke')(caller, input) };
}

test('browser creation is lazy and requires the exact main document and main frame', async () => {
  const f = fixture();
  assert.equal(f.created.length, 0);
  for (const caller of [null, { sender: {}, senderFrame: {} }, { sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } }]) {
    assert.equal((await f.invoke({ action: 'create' }, caller)).code, 'FORBIDDEN');
  }
  const allowedUrl = f.contents.mainFrame.url;
  f.contents.mainFrame.url = 'https://example.com/';
  assert.equal((await f.invoke({ action: 'create' })).code, 'FORBIDDEN');
  f.contents.mainFrame.url = allowedUrl;
  f.contents.getURL = () => 'file:///other/index.html';
  assert.equal((await f.invoke({ action: 'create' })).code, 'FORBIDDEN');
  assert.equal(f.created.length, 0);
  f.contents.getURL = () => allowedUrl;
  assert.equal((await f.invoke({ action: 'create' })).ok, true);
  assert.equal(f.created.length, 1);
});

test('browser bounds use Electron owner zoom instead of a forged renderer scale', async () => {
  const f = fixture();
  const rect = { x: 300, y: 140, width: 480, height: 560 };
  await f.invoke({ action: 'setBounds', rect, coordinateScale: 9 });
  assert.deepEqual(f.created[0].calls[0], { action: 'setBounds', rect, coordinateScale: 1.25 });
});

test('main-process link entry honors host routing and reveals only a returned internal tab', async () => {
  const f = fixture(); await f.invoke({ action: 'state' });
  const calls = [], tab = { id: 'linked-tab', url: 'https://example.test/' };
  f.created[0].invoke = async input => { calls.push(input); return { ok: true, tab }; };
  assert.deepEqual(await f.registry.openLink(tab.url), { ok: true, tab });
  assert.deepEqual(calls, [{ action: 'openLink', url: tab.url }]);
  assert.deepEqual(f.sent, [{ channel: 'browser:event', payload: { type: 'open-link', tab } }]);
  f.created[0].invoke = async () => ({ ok: true, external: true });
  await f.registry.openLink(tab.url); assert.equal(f.sent.length, 1);
  f.created[0].invoke = async () => ({ ok: false, error: 'failed' });
  assert.equal((await f.registry.openLink(tab.url)).ok, false); assert.equal(f.sent.length, 1);
  f.registry.dispose(); assert.equal((await f.registry.openLink(tab.url)).ok, false);
});

test('a replaced owner does not receive a delayed previous-window link request', async () => {
  const f = fixture(); await f.invoke({ action: 'state' });
  let finish;
  f.created[0].invoke = () => new Promise(resolve => { finish = resolve; });
  const opening = f.registry.openLink('https://example.test/');
  f.setOwner({ isDestroyed: () => false, webContents: { ...f.contents } });
  finish({ ok: true, tab: { id: 'stale' } }); await opening;
  assert.equal(f.sent.length, 0);
});

test('main-process link entry forwards conversation ownership without accepting task control metadata', async () => {
  const f = fixture(); await f.invoke({ action: 'state' });
  await f.registry.openLink('https://example.test/', { conversationId: 'origin-task', ownerConversationId: 'forged-owner', runId: 'forged-run', taskBinding: { conversationId: 'forged-task' } });
  assert.deepEqual(f.created[0].calls.at(-1), { action: 'openLink', url: 'https://example.test/', conversationId: 'origin-task' });
  await f.registry.openLink('https://example.test/unknown', { conversationId: null });
  assert.deepEqual(f.created[0].calls.at(-1), { action: 'openLink', url: 'https://example.test/unknown' });
});

test('reloaded or replaced owner gets a fresh host and old events are dropped', async () => {
  const f = fixture();
  await f.invoke({ action: 'create' });
  const first = f.created[0]; first.destroy();
  await f.invoke({ action: 'state' });
  assert.equal(f.created.length, 2);
  f.created[1].options.onEvent({ type: 'state' });
  assert.equal(f.sent.length, 1);
  const nextContents = { ...f.contents, mainFrame: { ...f.contents.mainFrame } };
  f.setOwner({ webContents: nextContents, isDestroyed: () => false });
  assert.equal((await f.invoke({ action: 'state' })).code, 'FORBIDDEN');
  await f.invoke({ action: 'create' }, { sender: nextContents, senderFrame: nextContents.mainFrame });
  assert.equal(f.created.length, 3);
  f.created[1].options.onEvent({ type: 'state' });
  assert.equal(f.sent.length, 1);
});

test('invalid requests and host failure return readable errors without native detail', async () => {
  const f = fixture();
  for (const value of [null, [], 'create']) assert.equal((await f.invoke(value)).code, 'INVALID_ACTION');
  await f.invoke({ action: 'state' });
  f.created[0].invoke = async () => { throw new Error('/private/path/internal'); };
  const result = await f.invoke({ action: 'create' });
  assert.equal(result.code, 'BROWSER_FAILED');
  assert.doesNotMatch(result.error, /private/);
});

test('disposing closes owned views and unregisters the browser bridge', async () => {
  const f = fixture();
  await f.invoke({ action: 'create' });
  const handler = f.handlers.get('browser:invoke');
  f.registry.dispose(); f.registry.dispose();
  assert.equal(f.created[0].destroyed, true);
  assert.equal(f.handlers.has('browser:invoke'), false);
  assert.equal((await handler(f.event, { action: 'create' })).code, 'FORBIDDEN');
  f.created[0].options.onEvent({ type: 'state' });
  assert.equal(f.sent.length, 0);
});

test('known profile corruption and save errors retain actionable safe messages without exposing native paths', async () => {
  const f = fixture(); await f.invoke({ action: 'state' });
  for (const code of ['BROWSER_PROFILE_INVALID', 'BROWSER_PROFILE_WRITE_FAILED']) {
    f.created[0].invoke = async () => { throw Object.assign(new Error('/private/user/profile/path'), { code }); };
    const result = await f.invoke({ action: 'settings.get' });
    assert.equal(result.code, code); assert.doesNotMatch(result.error, /private/);
    assert.match(result.error, code === 'BROWSER_PROFILE_INVALID' ? /原文件已保留/ : /磁盘空间/);
  }
  f.created[0].invoke = async () => { throw Object.assign(new Error('/private/path'), { code: 'EACCES' }); };
  const generic = await f.invoke({ action: 'state' }); assert.equal(generic.code, 'BROWSER_FAILED'); assert.doesNotMatch(generic.error, /private/);
});

test('automation control requires trusted UI and manual navigation revokes before navigation', async () => {
  const actions = [], events = [];
  const f = fixture({ createAutomation: options => {
    events.push(options);
    return { control: input => { actions.push(['control', input]); return { ok: true }; },
      dispose() { actions.push(['dispose']); }, pauseConversation: (...args) => actions.push(['pauseConversation', ...args]) };
  } });
  const hostile = { sender: {}, senderFrame: {} };
  assert.equal((await f.invoke({ action: 'automation', command: 'claim', id: 'tab', conversationId: 'task' }, hostile)).code, 'FORBIDDEN');
  assert.equal(events.length, 0);
  assert.equal((await f.invoke({ action: 'automation', command: 'claim', id: 'tab', conversationId: 'task' })).ok, true);
  f.created[0].invoke = async input => { actions.push(['navigate', input]); return { ok: true }; };
  await f.invoke({ action: 'navigate', id: 'tab', url: 'https://example.test/' });
  assert.equal(actions[1][0], 'control'); assert.equal(actions[1][1].action, 'pause');
  assert.equal(actions[2][0], 'navigate');
  events[0].onEvent({ type: 'automation-state', id: 'tab', state: 'paused' });
  assert.equal(f.sent.at(-1).payload.state, 'paused');
  f.registry.dispose();
  const count = f.sent.length;
  events[0].onEvent({ type: 'automation-state', id: 'tab', state: 'controlled' });
  assert.equal(f.sent.length, count);
  assert.equal(actions.at(-1)[0], 'dispose');
});

test('AI automation context stays in main process and stale host capabilities are disposed', async () => {
  const services = [];
  const f = fixture({ createAutomation: options => {
    const service = { disposed: false, invoke: async (context, input) => ({ ok: true, context, input }),
      dispose() { this.disposed = true; }, options };
    services.push(service); return service;
  } });
  const context = { conversationId: 'task', runId: 'run', isCurrent: () => true };
  const input = { action: 'list' };
  const result = await f.registry.automationInvoke(context, input);
  assert.equal(result.context, context); assert.equal(result.input, input);
  assert.equal(services[0].disposed, false);
  f.created[0].destroy();
  await f.registry.automationInvoke(context, input);
  assert.equal(services[0].disposed, true); assert.equal(services.length, 2);
  f.registry.dispose();
  assert.equal((await f.registry.automationInvoke(context, input)).code, 'BROWSER_CLOSED');
});

test('native menu events synchronously revoke automation and stale host events cannot revoke a replacement', async () => {
  const actions = [];
  const f = fixture({ createAutomation: () => ({ control(input) { actions.push(['pause', input]); return { ok: true }; },
    handleHostEvent(event) { actions.push(['event', event.type]); }, dispose() {} }) });
  await f.invoke({ action: 'automation', command: 'state', id: 'tab' });
  actions.length = 0;
  const old = f.created[0];
  old.options.onEvent({ type: 'manual-action', id: 'tab', action: 'paste' });
  actions.push(['native-edit']);
  assert.deepEqual(actions.map(item => item[0]), ['pause', 'event', 'native-edit']);
  assert.deepEqual(actions[0][1], { action: 'pause', id: 'tab', reason: '你已操作浏览器' });
  old.destroy(); await f.invoke({ action: 'automation', command: 'state', id: 'tab-new' });
  actions.length = 0; const count = f.sent.length;
  old.options.onEvent({ type: 'manual-action', id: 'tab-new', action: 'reload' });
  assert.deepEqual(actions, []); assert.equal(f.sent.length, count);
});

test('trusted manual form fill revokes automation before invoking the host', async () => {
  const actions = [];
  const f = fixture({ createAutomation: () => ({ control(input) { actions.push(['control', input.action]); return { ok: true }; }, dispose() {} }) });
  await f.invoke({ action: 'automation', command: 'state', id: 'tab' });
  f.created[0].invoke = async input => { actions.push(['host', input.action]); return { ok: true }; };
  for (const action of ['passwords.fill', 'contacts.fill', 'print', 'devTools']) {
    actions.length = 0; await f.invoke({ action, id: 'tab' });
    assert.deepEqual(actions, [['control', 'pause'], ['host', action]]);
  }
});

test('task restoration initializes automation before dispatching paused restoration events', async () => {
  const order = [];
  const f = fixture({ createAutomation: () => { order.push('service'); return { dispose() {}, handleHostEvent(event) { order.push(event.type); } }; } });
  await f.invoke({ action: 'state' });
  f.created[0].restoreTaskTabs = conversationId => {
    order.push('restore'); f.created[0].options.onEvent({ type: 'task-restored', id: 'new-tab', conversationId });
    return { ok: true, tabs: [{ id: 'new-tab' }] };
  };
  const result = await f.invoke({ action: 'restoreTaskTabs', conversationId: 'task-a' });
  assert.equal(result.tabs[0].id, 'new-tab'); assert.deepEqual(order, ['service', 'restore', 'task-restored']);
});

test('annotation resolves its directory from trusted task context and pauses before opening the selector', async () => {
  const order = [], root = path.resolve(__dirname, '../trusted-fixture-root');
  const f = fixture({ getConversationContext: id => { order.push(['context', id]); return { cwd: root }; },
    createAutomation: () => ({ dispose() {}, control(input) { order.push(['control', input.action, input.conversationId]); return { ok: true }; } }) });
  await f.invoke({ action: 'state' });
  f.created[0].startAnnotation = (id, options) => { order.push(['host', id, options]); return { ok: true, requestId: 'nonce' }; };
  const result = await f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a', mode: 'region', contextRoot: '/untrusted/path' });
  assert.equal(result.requestId, 'nonce');
  assert.equal(typeof order.at(-1)[2].onPaused, 'function');
  delete order.at(-1)[2].onPaused;
  assert.deepEqual(order, [['control', 'state', undefined], ['context', 'task-a'], ['control', 'state', undefined], ['control', 'pause', 'task-a'], ['host', 'tab', { conversationId: 'task-a', mode: 'region', contextRoot: root }]]);
});

test('a delayed annotation context lookup cannot target a replacement host', async () => {
  let resolveContext, called = false;
  const f = fixture({ getConversationContext: () => new Promise(resolve => { resolveContext = resolve; }),
    createAutomation: () => ({ dispose() {}, control() { return { ok: true }; } }) });
  await f.invoke({ action: 'state' });
  f.created[0].startAnnotation = () => { called = true; return { ok: true }; };
  const pending = f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
  f.created[0].destroy(); await f.invoke({ action: 'state' }); resolveContext({ cwd: path.resolve(__dirname) });
  assert.equal((await pending).code, 'STALE_TARGET'); assert.equal(called, false);
});

test('annotation refuses an unavailable task context instead of accepting a renderer path', async () => {
  const f = fixture({ createAutomation: () => ({ dispose() {}, control() { throw Error('should not grant control'); } }) });
  const result = await f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a', cwd: path.resolve(__dirname) });
  assert.equal(result.code, 'INVALID_CONTEXT');
});

test('cancellation and task changes retire a pending annotation context lookup before it can start a picker', async () => {
  for (const invalidation of ['cancel', 'task', 'all', 'hide', 'navigation', 'native']) {
    let resolveContext, starts = 0;
    const f = fixture({ getConversationContext: () => new Promise(resolve => { resolveContext = resolve; }),
      createAutomation: () => ({ dispose() {}, pauseAll() {}, pauseConversation() {}, control: () => ({ ok: true }) }) });
    await f.invoke({ action: 'state' });
    f.created[0].startAnnotation = () => { starts++; return { ok: true }; };
    const work = f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
    if (invalidation === 'cancel') await f.invoke({ action: 'annotation.cancel', id: 'tab' });
    if (invalidation === 'task') await f.invoke({ action: 'automationPauseConversation', conversationId: 'task-a' });
    if (invalidation === 'all') f.registry.automationPauseAll('task changed');
    if (invalidation === 'hide') await f.invoke({ action: 'visibility', id: 'tab', visible: false });
    if (invalidation === 'navigation') await f.invoke({ action: 'reload', id: 'tab' });
    if (invalidation === 'native') f.created[0].options.onEvent({ type: 'navigation-start', id: 'tab' });
    // The result must settle without requiring the old lookup to complete.
    assert.equal((await work).code, 'ANNOTATION_CANCELLED', invalidation);
    resolveContext({ cwd: path.resolve(__dirname) }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 0, invalidation); f.registry.dispose();
  }
});

test('a newer annotation lookup supersedes an older lookup even if the older directory resolves last', async () => {
  const lookups = []; let starts = 0;
  const f = fixture({ getConversationContext: () => new Promise(resolve => lookups.push(resolve)),
    createAutomation: () => ({ dispose() {}, control: () => ({ ok: true }) }) });
  await f.invoke({ action: 'state' });
  f.created[0].startAnnotation = () => { starts++; return { ok: true }; };
  const old = f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
  const next = f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
  assert.equal((await old).code, 'ANNOTATION_CANCELLED');
  lookups[1]({ cwd: path.resolve(__dirname) }); assert.equal((await next).ok, true);
  lookups[0]({ cwd: path.resolve(__dirname) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1); f.registry.dispose();
});

test('annotation lookup rechecks the native page identity before pausing or starting selection', async () => {
  let resolveContext, current = true, starts = 0;
  const f = fixture({ getConversationContext: () => new Promise(resolve => { resolveContext = resolve; }),
    createAutomation: () => ({ dispose() {}, control(input) { if (input.action === 'state') return { ok: true }; throw Error('stale page must not pause'); } }) });
  await f.invoke({ action: 'state' });
  f.created[0].captureAnnotationTarget = () => () => current;
  f.created[0].startAnnotation = () => { starts++; return { ok: true }; };
  const work = f.invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
  current = false; resolveContext({ cwd: path.resolve(__dirname) });
  assert.equal((await work).code, 'ANNOTATION_CANCELLED'); assert.equal(starts, 0); f.registry.dispose();
});
