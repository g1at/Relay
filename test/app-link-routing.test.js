'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const windowSource = fs.readFileSync(path.join(__dirname, '../src/main/app/application-windows.js'), 'utf8').replace(/^  /gm, '');
const openSource = windowSource.slice(windowSource.indexOf('async function openConfiguredWebLink('), windowSource.indexOf('// 创建首次设置向导窗口'));
const shellSource = source.slice(source.indexOf("ipcMain.handle('shell:open'"), source.indexOf('// IPC: 文件选择对话框'));
function fixture() {
  const routed = [], routedContexts = [], external = [], warnings = [], handlers = new Map(); let shown = 0, miniConversationId = 'mini-task';
  const main = { webContents: { mainFrame: {}, on() {}, setWindowOpenHandler() {} }, isDestroyed: () => false, relayContentReady: Promise.resolve() };
  const context = vm.createContext({ mainWindow: main, pathToFileURL, Promise, require: require('node:module').createRequire(path.join(__dirname, '../src/main/app/application-windows.js')),
    browserPanelTools: { openLink: async (url, options) => { routed.push(url); routedContexts.push({ ...options }); return { ok: true, tab: { id: 'tab', url } }; } },
    showMainWindow: () => shown++, createMainWindow: () => main,
    shell: { openExternal: async url => external.push(url) }, logger: { warn: (...args) => warnings.push(args) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, miniPanelCaller: event => !!event.mini,
    miniChat: { getConversationId: () => miniConversationId },
  });
  context.browser = { openLink: (url, options) => context.browserPanelTools.openLink(url, options) };
  context.applicationWindows = { get mainWindow() { return context.mainWindow; }, openConfiguredWebLink: (url, options) => context.openConfiguredWebLink(url, options) };
  vm.runInContext(openSource + '\n' + shellSource, context);
  return { context, main, routed, routedContexts, external, warnings, shown: () => shown,
    setMiniConversation: id => { miniConversationId = id; },
    open: (url, event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }, options) => handlers.get('shell:open')(event, url, options) };
}
test('legacy shell calls from main and mini both use saved browser routing', async () => {
  const f = fixture(); await f.open('https://example.test/a', undefined, { conversationId: 'main-task' }); await f.open('http://localhost:3000/', { mini: true });
  assert.deepEqual(f.routed, ['https://example.test/a', 'http://localhost:3000/']);
  assert.deepEqual(f.external, []); assert.equal(f.shown(), 2);
  assert.deepEqual(f.routedContexts, [{ conversationId: 'main-task' }, { conversationId: 'mini-task' }]);
});
test('missing conversation falls back externally without creating a hidden internal tab or restoring a window', async () => {
  const f = fixture();
  await f.open('https://example.test/no-main-context');
  f.context.mainWindow = null; f.setMiniConversation(null);
  f.context.createMainWindow = () => { throw Error('must not restore a window'); };
  await f.open('https://example.test/no-mini-context', { mini: true }, { conversationId: 'forged-task' });
  assert.deepEqual(f.routed, []); assert.equal(f.shown(), 0);
  assert.deepEqual(f.external, ['https://example.test/no-main-context', 'https://example.test/no-mini-context']);
  await assert.rejects(f.context.openConfiguredWebLink('javascript:alert(1)'), /网页链接无效/);
  assert.equal(f.external.length, 2);
});
test('legacy main links retain explicit conversation ownership and mini links use trusted controller context', async () => {
  const f = fixture();
  await f.open('https://example.test/main', undefined, { conversationId: 'main-task', ownerConversationId: 'forged-owner', runId: 'forged-run' });
  await f.open('https://example.test/mini', { mini: true }, { conversationId: 'forged-task' });
  assert.deepEqual(f.routedContexts, [{ conversationId: 'main-task' }, { conversationId: 'mini-task' }]);
  const invalid = await f.open('https://example.test/invalid', undefined, { conversationId: { id: 'bad' } });
  assert.equal(invalid.code, 'INVALID_CONVERSATION'); assert.equal(f.routed.length, 2);
});
test('untrusted and subframe shell calls cannot assign an internal browser conversation', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: f.main.webContents, senderFrame: {} }]) {
    await f.open('https://example.test/untrusted', event, { conversationId: 'main-task' });
  }
  assert.deepEqual(f.routed, []); assert.equal(f.external.length, 2);
});
test('external configured destination does not reveal the main window or duplicate the open', async () => {
  const f = fixture(); f.context.browserPanelTools.openLink = async () => ({ ok: true, external: true });
  await f.open('https://example.test/', undefined, { conversationId: 'main-task' }); assert.equal(f.shown(), 0); assert.deepEqual(f.external, []);
});
test('mail remains a system action and routing failure never silently opens another browser', async () => {
  const f = fixture(); await f.open('mailto:test@example.invalid'); assert.deepEqual(f.external, ['mailto:test@example.invalid']);
  f.context.browserPanelTools.openLink = async () => ({ ok: false, error: 'profile unavailable' });
  await assert.rejects(f.open('https://example.test/', undefined, { conversationId: 'main-task' }), /profile unavailable/); assert.equal(f.external.length, 1);
});
test('mini link waits for the restored main renderer before publishing its browser tab', async () => {
  const f = fixture(); let ready;
  f.main.relayContentReady = new Promise(resolve => { ready = resolve; }); f.context.mainWindow = null;
  const pending = f.open('https://example.test/', { mini: true }); await Promise.resolve(); assert.equal(f.routed.length, 0);
  f.setMiniConversation('different-mini-task');
  ready(); await pending; assert.equal(f.routed.length, 1);
  assert.deepEqual(f.routedContexts, [{ conversationId: 'mini-task' }]);
});
test('window readiness cannot change a link to a subsequently selected conversation', async () => {
  const f = fixture(); let ready;
  f.main.relayContentReady = new Promise(resolve => { ready = resolve; });
  const options = { conversationId: 'original-task' };
  const pending = f.context.openConfiguredWebLink('https://example.test/', options);
  options.conversationId = 'later-task'; ready(); await pending;
  assert.deepEqual(f.routedContexts, [{ conversationId: 'original-task' }]);
});
test('native guards without conversation context open externally and retain the app document', async () => {
  const f = fixture(), events = new Map(); let popup;
  f.main.webContents.on = (name, fn) => events.set(name, fn); f.main.webContents.setWindowOpenHandler = fn => { popup = fn; };
  f.context.attachExternalLinkGuard(f.main, '/fixture/index.html');
  assert.equal(popup({ url: 'https://example.test/popup' }).action, 'deny');
  assert.equal(popup({ url: 'javascript:alert(1)' }).action, 'deny');
  let prevented = 0; events.get('will-navigate')({ preventDefault: () => prevented++ }, 'http://localhost:3000/');
  events.get('will-navigate')({ preventDefault: () => prevented++ }, pathToFileURL('/fixture/index.html').href + '#anchor');
  events.get('will-navigate')({ preventDefault: () => prevented++ }, 'file:///other.md');
  await new Promise(setImmediate); assert.equal(prevented, 2); assert.equal(f.routed.length, 0);
  assert.deepEqual(f.external, ['https://example.test/popup', 'http://localhost:3000/']);
  assert.equal(f.shown(), 0);
});
