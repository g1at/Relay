'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBrowserChromeMenu } = require('../src/main/browser/browser-chrome-menu');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const entryFile = path.resolve(__dirname, '../renderer/index.html'), url = pathToFileURL(entryFile).href;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url }, getURL: () => url, getZoomFactor: () => 1.25, isDestroyed: () => false,
  });
  const owner = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    getContentBounds: () => ({ x: 300, y: 200, width: 1000, height: 700 }),
  });
  let window = owner;
  const menus = [];
  const electron = { Menu: { buildFromTemplate(template) {
    const menu = { template, closed: 0, popup(options) { this.options = options; },
      closePopup(target) { assert.equal(target, owner); this.closed++; this.options?.callback(); } };
    menus.push(menu); return menu;
  } } };
  const getWindow = () => window, getElectron = () => electron;
  const bridge = createBrowserChromeMenu({ getWindow, getElectron });
  const input = { requestId: 'menu-1', x: 450, y: 120, items: [{ id: 'new', label: '新建标签页' }, { type: 'separator' },
    { label: '缩放', submenu: [{ id: 'reset', label: '恢复为 100%' }] }, { id: 'disabled', label: '不可用', enabled: false }] };
  return { bridge, owner, contents, menus, input, electron, getWindow, getElectron, entryFile,
    setWindow(value) { window = value; }, popup(overrides = {}) { return bridge.popup({ ...input, ...overrides }); } };
}
function listenerCount(f) {
  return [...f.owner.eventNames()].reduce((n, event) => n + f.owner.listenerCount(event), 0)
    + [...f.contents.eventNames()].reduce((n, event) => n + f.contents.listenerCount(event), 0);
}

test('native popup waits for close, returns selection, and uses owner zoom in content coordinates', async () => {
  const f = fixture(); let settled = false;
  const result = f.popup().then(value => { settled = true; return value; }), menu = f.menus[0];
  assert.equal(menu.options.window, f.owner);
  assert.equal(menu.options.x, 563); assert.equal(menu.options.y, 150);
  menu.template[0].click(); await turn(); assert.equal(settled, false);
  menu.options.callback();
  assert.deepEqual(await result, { ok: true, requestId: 'menu-1', selectedId: 'new' });
  assert.equal(listenerCount(f), 0);
});
test('a closure callback before click still delivers the final selection', async () => {
  const f = fixture(), result = f.popup(), menu = f.menus[0];
  menu.options.callback(); menu.template[2].submenu[0].click(); menu.options.callback();
  assert.deepEqual(await result, { ok: true, requestId: 'menu-1', selectedId: 'reset' });
  assert.equal(listenerCount(f), 0);
});
test('dismissal resolves without selection and disabled commands cannot be chosen', async () => {
  const f = fixture(), result = f.popup(), menu = f.menus[0];
  menu.template[3].click(); menu.options.callback();
  assert.equal((await result).selectedId, null);
  const next = f.popup({ items: [{ label: 'disabled parent', enabled: false, submenu: [{ id: 'child', label: 'child' }] }] });
  f.menus[1].template[0].submenu[0].click(); f.menus[1].options.callback();
  assert.equal((await next).selectedId, null);
});
test('close matches the request and late native callbacks cannot select a cancelled menu', async () => {
  const f = fixture(); let settled = false;
  const result = f.popup().then(value => { settled = true; return value; }), menu = f.menus[0];
  assert.deepEqual(f.bridge.close('stale-id'), { ok: true }); await turn();
  assert.equal(settled, false); assert.equal(menu.closed, 0);
  f.bridge.close('menu-1'); menu.template[0].click(); menu.options.callback();
  assert.equal((await result).selectedId, null); assert.equal(menu.closed, 1);
  assert.equal(listenerCount(f), 0);
});
test('replacing a popup cancels its predecessor without allowing stale callbacks to affect the replacement', async () => {
  const f = fixture(), first = f.popup(), old = f.menus[0], second = f.popup({ requestId: 'menu-2' });
  assert.deepEqual(await first, { ok: true, requestId: 'menu-1', selectedId: null });
  f.bridge.close('menu-1'); old.template[0].click(); old.options.callback();
  assert.equal(f.menus[1].closed, 0);
  f.menus[1].template[0].click(); f.menus[1].options.callback();
  assert.deepEqual(await second, { ok: true, requestId: 'menu-2', selectedId: 'new' });
  assert.equal(listenerCount(f), 0);
});
for (const [target, event] of [['owner', 'hide'], ['owner', 'minimize'], ['owner', 'close'], ['owner', 'closed'],
  ['contents', 'destroyed'], ['contents', 'render-process-gone'], ['contents', 'did-start-navigation']]) {
  test(`owner lifecycle ${event} cancels the popup and cleans its listeners`, async () => {
    const f = fixture(), result = f.popup(), menu = f.menus[0];
    f[target].emit(event, {}, 'file:///replacement.html', false, true);
    menu.template[0].click(); menu.options.callback();
    assert.equal((await result).selectedId, null); assert.equal(menu.closed, 1);
    assert.equal(listenerCount(f), 0);
  });
}
test('subframe navigation does not dismiss the owner menu', async () => {
  const f = fixture(), result = f.popup();
  f.contents.emit('did-start-navigation', {}, 'https://subframe.test/', false, false);
  assert.equal(f.menus[0].closed, 0);
  f.menus[0].template[0].click(); f.menus[0].options.callback();
  assert.equal((await result).selectedId, 'new');
});
test('a replaced, hidden, minimized or destroyed owner cannot receive a delayed selection', async () => {
  for (const change of [f => f.setWindow({ ...f.owner }), f => { f.owner.isVisible = () => false; },
    f => { f.owner.isMinimized = () => true; }, f => { f.contents.isDestroyed = () => true; }]) {
    const f = fixture(), result = f.popup();
    change(f); f.menus[0].template[0].click(); f.menus[0].options.callback();
    assert.equal((await result).selectedId, null); assert.equal(listenerCount(f), 0);
  }
});
test('disposal cancels open menus and prevents a later popup', async () => {
  const f = fixture(), result = f.popup(), menu = f.menus[0];
  f.bridge.dispose(); f.bridge.dispose(); menu.template[0].click();
  assert.equal((await result).selectedId, null); assert.equal(menu.closed, 1);
  assert.equal((await f.popup()).code, 'BROWSER_CLOSED'); assert.equal(listenerCount(f), 0);
});
test('coordinates clamp to content bounds and ignore forged request scale', async () => {
  const f = fixture(), result = f.popup({ x: -300, y: 1e10, coordinateScale: 9 });
  assert.equal(f.menus[0].options.x, 0); assert.equal(f.menus[0].options.y, 699);
  f.bridge.close('menu-1'); await result;
});
test('only labels, enabled state, separators and bridge callbacks reach Electron', async () => {
  const f = fixture(), result = f.popup({ items: [
    { id: 'delete', label: '可选命令', role: 'quit', accelerator: 'Ctrl+Q', click: 'arbitrary' },
    { label: '说明', role: 'reload', accelerator: 'F5' }, { type: 'separator', role: 'quit', click: 'arbitrary' },
  ] });
  const template = f.menus[0].template;
  assert.deepEqual(Object.keys(template[0]).sort(), ['click', 'enabled', 'label']);
  assert.deepEqual(template[1], { label: '说明', enabled: false });
  assert.deepEqual(template[2], { type: 'separator' });
  f.bridge.close('menu-1'); await result;
});
test('malformed and unbounded requests are rejected before replacing an existing popup', async () => {
  const f = fixture(), active = f.popup();
  const deep = { label: 'one', submenu: [{ label: 'two', submenu: [{ label: 'three', submenu: [{ id: 'four', label: 'four' }] }] }] };
  for (const change of [{ requestId: '' }, { requestId: 'x'.repeat(129) }, { x: NaN }, { y: Infinity },
    { items: [] }, { items: [null] }, { items: [{ id: 'one', label: '' }] }, { items: [{ id: 'one', label: 'x'.repeat(257) }] },
    { items: [{ id: 'one', label: 'line\nbreak' }] }, { items: [{ id: 'one', label: 'ok', enabled: 'yes' }] },
    { items: [{ id: 'one', label: 'ok', type: 'checkbox' }] }, { items: [{ id: 'same', label: 'a' }, { id: 'same', label: 'b' }] },
    { items: [deep] }, { items: Array.from({ length: 81 }, (_, i) => ({ id: String(i), label: 'entry' })) }]) {
    assert.equal((await f.popup(change)).code, 'INVALID_MENU');
  }
  assert.equal(f.menus.length, 1); assert.equal(f.menus[0].closed, 0);
  f.bridge.close('menu-1'); await active;
});
test('trusted IPC dispatches menus without creating a browser host or automation service', async () => {
  const f = fixture(), handlers = new Map();
  const registry = registerBrowserPanelIpc({ entryFile: f.entryFile, getWindow: f.getWindow, getElectron: f.getElectron,
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } },
    createHost() { assert.fail('menu must not create a browser host'); },
    createAutomation() { assert.fail('menu must not create automation'); },
  });
  const call = handlers.get('browser:invoke'), event = { sender: f.contents, senderFrame: f.contents.mainFrame };
  assert.equal((await call({ sender: {}, senderFrame: {} }, { action: 'menu.popup', ...f.input })).code, 'FORBIDDEN');
  assert.equal(f.menus.length, 0);
  const result = call(event, { action: 'menu.popup', ...f.input }); assert.equal(f.menus.length, 1);
  assert.deepEqual(await call(event, { action: 'menu.close', requestId: 'stale-id' }), { ok: true });
  assert.equal(f.menus[0].closed, 0);
  await call(event, { action: 'menu.close', requestId: 'menu-1' }); assert.equal((await result).selectedId, null);
  const pending = call(event, { action: 'menu.popup', ...f.input, requestId: 'menu-2' });
  registry.dispose();
  assert.equal((await pending).selectedId, null); assert.equal(listenerCount(f), 0);
  assert.equal(handlers.has('browser:invoke'), false);
});

test('native menu construction and popup failures return readable errors and remove listeners', async () => {
  const f = fixture();
  f.electron.Menu.buildFromTemplate = () => { throw new Error('/private/native/detail'); };
  assert.deepEqual(await f.popup(), { ok: false, code: 'MENU_UNAVAILABLE', error: '浏览器菜单暂不可用' });
  let closed = 0;
  f.electron.Menu.buildFromTemplate = () => ({ popup() { throw new Error('/private/native/detail'); }, closePopup() { closed++; } });
  assert.deepEqual(await f.popup(), { ok: false, code: 'MENU_UNAVAILABLE', error: '浏览器菜单暂不可用' });
  assert.equal(closed, 1); assert.equal(listenerCount(f), 0);
});
