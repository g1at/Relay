'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const openSource = source.slice(source.indexOf('async function openConfiguredWebLink('), source.indexOf('// 创建首次设置向导窗口'));
const shellSource = source.slice(source.indexOf("ipcMain.handle('shell:open'"), source.indexOf('// IPC: 文件选择对话框'));
function fixture() {
  const routed = [], external = [], warnings = [], handlers = new Map(); let shown = 0;
  const main = { webContents: { mainFrame: {}, on() {}, setWindowOpenHandler() {} }, isDestroyed: () => false, relayContentReady: Promise.resolve() };
  const context = vm.createContext({ mainWindow: main, pathToFileURL, Promise, require: require('node:module').createRequire(path.join(__dirname, '../main.js')),
    browserPanelTools: { openLink: async url => { routed.push(url); return { ok: true, tab: { id: 'tab', url } }; } },
    showMainWindow: () => shown++, createMainWindow: () => main,
    shell: { openExternal: async url => external.push(url) }, logger: { warn: (...args) => warnings.push(args) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, miniPanelCaller: event => !!event.mini,
  });
  vm.runInContext(openSource + '\n' + shellSource, context);
  return { context, main, routed, external, warnings, shown: () => shown,
    open: (url, event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }) => handlers.get('shell:open')(event, url) };
}
test('legacy shell calls from main and mini both use saved browser routing', async () => {
  const f = fixture(); await f.open('https://example.test/a'); await f.open('http://localhost:3000/', { mini: true });
  assert.deepEqual(f.routed, ['https://example.test/a', 'http://localhost:3000/']);
  assert.deepEqual(f.external, []); assert.equal(f.shown(), 2);
});
test('external configured destination does not reveal the main window or duplicate the open', async () => {
  const f = fixture(); f.context.browserPanelTools.openLink = async () => ({ ok: true, external: true });
  await f.open('https://example.test/'); assert.equal(f.shown(), 0); assert.deepEqual(f.external, []);
});
test('mail remains a system action and routing failure never silently opens another browser', async () => {
  const f = fixture(); await f.open('mailto:test@example.invalid'); assert.deepEqual(f.external, ['mailto:test@example.invalid']);
  f.context.browserPanelTools.openLink = async () => ({ ok: false, error: 'profile unavailable' });
  await assert.rejects(f.open('https://example.test/'), /profile unavailable/); assert.equal(f.external.length, 1);
});
test('mini link waits for the restored main renderer before publishing its browser tab', async () => {
  const f = fixture(); let ready;
  f.main.relayContentReady = new Promise(resolve => { ready = resolve; }); f.context.mainWindow = null;
  const pending = f.open('https://example.test/', { mini: true }); await Promise.resolve(); assert.equal(f.routed.length, 0);
  ready(); await pending; assert.equal(f.routed.length, 1);
});
test('native new-window and navigation guards route through preferences and retain the app document', async () => {
  const f = fixture(), events = new Map(); let popup;
  f.main.webContents.on = (name, fn) => events.set(name, fn); f.main.webContents.setWindowOpenHandler = fn => { popup = fn; };
  f.context.attachExternalLinkGuard(f.main, '/fixture/index.html');
  assert.equal(popup({ url: 'https://example.test/popup' }).action, 'deny');
  let prevented = 0; events.get('will-navigate')({ preventDefault: () => prevented++ }, 'http://localhost:3000/');
  events.get('will-navigate')({ preventDefault: () => prevented++ }, pathToFileURL('/fixture/index.html').href + '#anchor');
  events.get('will-navigate')({ preventDefault: () => prevented++ }, 'file:///other.md');
  await new Promise(setImmediate); assert.equal(prevented, 2); assert.equal(f.routed.length, 2); assert.equal(f.external.length, 0);
});
