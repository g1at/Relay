'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../browser-panel-ipc');

function fixture() {
  const entryFile = path.resolve(__dirname, '../renderer/index.html');
  const url = pathToFileURL(entryFile).href;
  const handlers = new Map(), created = [], sent = [];
  const contents = { mainFrame: { url }, getURL: () => url, getZoomFactor: () => 1.25,
    isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const owner = { webContents: contents, isDestroyed: () => false };
  let current = owner;
  const registry = registerBrowserPanelIpc({ entryFile, getWindow: () => current,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getElectron: () => ({}),
    createHost: options => {
      const calls = [];
      const host = { options, calls, destroyed: false, isDestroyed() { return this.destroyed; },
        destroy() { this.destroyed = true; }, invoke: async request => { calls.push(request); return { ok: true }; } };
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
