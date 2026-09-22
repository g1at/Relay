'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createBrowserPanelHost, normalizeBrowserUrl, resolveBrowserAddress } = require('../src/main/browser/browser-panel-host');
const { createBrowserProfileStore } = require('../src/main/browser/browser-profile-store');
const tick = () => new Promise(setImmediate);
const { MAX_HTML_BYTES } = require('../src/main/browser/browser-preview-session');
function fixture(options = {}) {
  const partitions = [], views = [], events = [], external = [];
  const owner = new EventEmitter(); owner.closed = false; owner.size = [1000, 700]; owner.webContents = new EventEmitter();
  owner.isDestroyed = () => owner.closed; owner.getContentSize = () => owner.size;
  owner.contentView = { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(item => item !== view); } };
  class View {
    constructor(options) {
      this.options = options; this.visible = true; this.rects = []; views.push(this);
      const wc = this.webContents = new EventEmitter(); wc.destroyed = false; wc.url = ''; wc.zoom = 1; wc.calls = [];
      wc.isDestroyed = () => wc.destroyed; wc.getURL = () => wc.url; wc.getZoomFactor = () => wc.zoom;
      wc.loadURL = async url => { wc.calls.push(['load', url]); wc.url = url; wc.emit('did-start-loading'); };
      wc.setWindowOpenHandler = fn => { wc.popup = fn; };
      wc.navigationHistory = { canGoBack: () => true, canGoForward: () => true,
        goBack: () => wc.calls.push(['back']), goForward: () => wc.calls.push(['forward']) };
      wc.reload = () => wc.calls.push(['reload']); wc.stop = () => wc.calls.push(['stop']); wc.focus = () => wc.calls.push(['focus']);
      wc.setZoomFactor = value => { wc.zoom = value; };
      wc.findInPage = (value, options) => { wc.calls.push(['find', value, options]); return 42; };
      wc.stopFindInPage = action => wc.calls.push(['stopFind', action]);
      wc.close = options => { wc.calls.push(['close', options]); wc.destroyed = true; wc.emit('destroyed'); };
    }
    setBounds(rect) { this.rects.push(rect); }
    setVisible(value) { this.visible = value; }
  }
  let nextId = 0, clock = 1000;
  const makeSession = name => {
    const ses = new EventEmitter(); ses.name = name; partitions.push(ses);
    ses.setPermissionCheckHandler = fn => { ses.check = fn; }; ses.setPermissionRequestHandler = fn => { ses.request = fn; };
    ses.protocol = { handle: (scheme, handler) => { ses.scheme = scheme; ses.protocolHandler = handler; }, unhandle: () => { ses.protocolRemoved = true; } };
    ses.webRequest = { onBeforeRequest: handler => { ses.filterRequest = handler; } };
    ses.clearStorageData = async () => { ses.clearedStorage = true; }; ses.clearCache = async () => { ses.clearedCache = true; }; return ses;
  };
  const host = createBrowserPanelHost({ owner, WebContentsView: View, session: { fromPartition: makeSession, fromPath: makeSession },
    shell: { openExternal: async url => external.push(url), openPath: async value => { external.push(value); return ''; }, showItemInFolder: value => external.push(value) },
    onEvent: value => events.push(value), idFactory: () => 'tab-' + ++nextId, now: () => clock, ...options });
  const create = async (url = 'https://example.test') => { const result = await host.invoke({ action: 'create', url }); await tick(); return result.id; };
  const show = async id => { await host.invoke({ action: 'setBounds', rect: { x: 600, y: 80, width: 400, height: 600 } }); await host.invoke({ action: 'visibility', id, visible: true }); };
  return { host, owner, views, partitions, events, external, create, show, advance: value => { clock += value; } };
}

test('code preview uses its own ephemeral protocol, memory source and correlated safe snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preview-unit-'));
  const profile = createBrowserProfileStore({ rootDir: path.join(directory, 'browser') });
  const h = fixture({ profile });
  const html = '<!doctype html><title>preview</title><h1>private-source-marker</h1>';
  try {
    await h.create();
    const result = await h.host.invoke({ action: 'createPreview', html, title: '预览', clientRequestId: 'workspace-preview-1' });
    await tick();
    assert.equal(result.ok, true); assert.equal(result.tab.isPreview, true);
    assert.match(result.tab.url, /^relay-preview:\/\/[\da-f-]+\/index\.html$/);
    assert.equal(result.tab.title, '预览');
    const view = h.views[1], partition = view.options.webPreferences.session;
    assert.notEqual(partition, h.views[0].options.webPreferences.session);
    assert.ok(!partition.name.startsWith('persist:'));
    assert.equal(h.events.find(event => event.type === 'created' && event.id === result.id).clientRequestId, 'workspace-preview-1');
    assert.ok(!JSON.stringify([result, h.events]).includes('private-source-marker'));
    assert.equal(await (await partition.protocolHandler({ url: result.tab.url, method: 'GET' })).text(), html);
    assert.equal((await partition.protocolHandler({ url: result.tab.url.replace('index.html', 'secret'), method: 'GET' })).status, 404);
    assert.equal((await partition.protocolHandler({ url: result.tab.url, method: 'POST' })).status, 404);
    view.webContents.emit('did-navigate', {}, result.tab.url);
    view.webContents.emit('page-title-updated', {}, 'preview title');
    assert.equal((await h.host.invoke({ action: 'history.list' })).items.length, 0);
    assert.equal((await h.host.invoke({ action: 'bookmark', id: result.id })).code, 'PREVIEW_PRIVATE');
    assert.equal((await h.host.invoke({ action: 'passwords.fill', id: result.id })).code, 'PREVIEW_PRIVATE');
    const copied = await h.host.invoke({ action: 'duplicatePreview', id: result.id, clientRequestId: 'copy_1' });
    assert.equal(copied.tab.isPreview, true); assert.notEqual(copied.tab.url, result.tab.url);
    const copyPartition = h.views[2].options.webPreferences.session;
    assert.notEqual(copyPartition, partition);
    assert.equal(await (await copyPartition.protocolHandler({ url: copied.tab.url, method: 'GET' })).text(), html);
    assert.equal(h.events.find(event => event.type === 'created' && event.id === copied.id).clientRequestId, 'copy_1');
    await h.host.invoke({ action: 'close', id: result.id }); await tick(); await tick();
    assert.equal(partition.protocolRemoved, true); assert.equal(partition.clearedStorage, true); assert.equal(partition.clearedCache, true);
    assert.equal(await (await copyPartition.protocolHandler({ url: copied.tab.url, method: 'GET' })).text(), html);
  } finally { h.host.destroy(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('preview rejects oversized or missing source without relaxing ordinary URL navigation', async () => {
  const h = fixture();
  try {
    for (const html of [undefined, null, {}, '', '   ', 'a'.repeat(MAX_HTML_BYTES + 1), '界'.repeat(MAX_HTML_BYTES / 2)]) {
      assert.equal((await h.host.invoke({ action: 'createPreview', html })).code, 'INVALID_PREVIEW');
    }
    assert.equal(h.host.state().tabs.length, 0);
    const preview = await h.host.invoke({ action: 'createPreview', html: '<h1>hello</h1>' });
    const normal = await h.create();
    assert.equal((await h.host.invoke({ action: 'navigate', id: normal, url: preview.tab.url })).ok, false);
    assert.equal((await h.host.invoke({ action: 'create', url: preview.tab.url })).ok, false);
    assert.equal((await h.host.invoke({ action: 'duplicatePreview', id: normal })).code, 'NOT_A_PREVIEW');
    for (const url of ['file:///secret', 'data:text/html,evil', 'javascript:alert(1)', 'devtools://x', 'relay-preview://other/index.html']) {
      assert.equal((await h.host.invoke({ action: 'navigate', id: preview.id, url })).ok, false);
    }
  } finally { h.host.destroy(); }
});

test('preview network and navigation guards isolate local resources, permissions, downloads and popup storage', async () => {
  const h = fixture();
  try {
    const preview = await h.host.invoke({ action: 'createPreview', html: '<h1>hello</h1>' }); await tick();
    const wc = h.views[0].webContents, partition = h.partitions[0]; await h.show(preview.id);
    const request = (url, resourceType = 'script') => { let result; partition.filterRequest({ url, resourceType }, value => { result = value; }); return result; };
    for (const url of ['file:///secret', 'chrome://settings', 'devtools://x', 'relay-preview://other/index.html']) assert.equal(request(url).cancel, true);
    for (const url of [preview.tab.url, 'https://cdn.example.test/script.js', 'data:image/png,abc', 'blob:https://example.test/abc']) assert.equal(request(url).cancel, false);
    assert.equal(request('data:text/html,unsafe', 'mainFrame').cancel, true);
    assert.equal(request('blob:https://example.test/abc', 'subFrame').cancel, true);
    const inspectorRequest = requester => { let result; partition.filterRequest({ url: 'devtools://devtools/bundled/devtools_app.html', resourceType: 'mainFrame', webContents: requester }, value => { result = value; }); return result; };
    assert.equal(inspectorRequest({ session: partition, getType: () => 'remote' }).cancel, false);
    assert.equal(inspectorRequest({ session: partition, getType: () => 'window' }).cancel, true);
    assert.equal(inspectorRequest({ session: {}, getType: () => 'remote' }).cancel, true);
    wc.session = partition; wc.getType = () => 'remote';
    assert.equal(inspectorRequest(wc).cancel, true);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      let blocked = false; wc.emit(name, { url: 'file:///secret', preventDefault() { blocked = true; } }); assert.equal(blocked, true);
      blocked = false; wc.emit(name, { url: preview.tab.url, preventDefault() { blocked = true; } }); assert.equal(blocked, false);
    }
    await h.host.invoke({ action: 'navigate', id: preview.id, url: 'https://example.test/normal' }); await tick();
    wc.emit('did-navigate', {}, wc.url); wc.emit('did-stop-loading');
    assert.equal(h.host.state(preview.id).tab.isPreview, false);
    assert.equal((await h.host.invoke({ action: 'history.list' })).items.length, 0);
    assert.equal(partition.check(wc, 'notifications', 'https://example.test'), false);
    let allowed; await partition.request(wc, 'notifications', value => { allowed = value; }, { requestingUrl: wc.url }); assert.equal(allowed, false);
    let downloadBlocked = false;
    partition.emit('will-download', { preventDefault() { downloadBlocked = true; } }, { getURL: () => wc.url, getFilename: () => 'demo.txt', hasUserGesture: () => true }, wc);
    assert.equal(downloadBlocked, true);
    wc.popup({ url: 'https://example.test/popup', disposition: 'foreground-tab' }); await tick();
    const popupWc = h.views[1].webContents; popupWc.emit('did-navigate', {}, popupWc.url); popupWc.emit('did-stop-loading');
    assert.notEqual(h.views[1].options.webPreferences.session, partition);
    assert.equal((await h.host.invoke({ action: 'history.list' })).items.length, 0);
    await h.host.invoke({ action: 'navigate', id: preview.id, url: preview.tab.url }); await tick();
    assert.equal(h.host.state(preview.id).tab.isPreview, true);
    for (const action of ['reload', 'back', 'forward']) assert.equal((await h.host.invoke({ action, id: preview.id })).ok, true);
    assert.equal((await h.host.invoke({ action: 'find', id: preview.id, text: 'hello' })).ok, true);
    assert.equal((await h.host.invoke({ action: 'zoom', id: preview.id, factor: 1.25 })).ok, true);
  } finally { h.host.destroy(); }
});

test('browser URLs normalize web and local development hosts, reject privileged schemes and embedded credentials', () => {
  assert.equal(normalizeBrowserUrl('example.test/path'), 'https://example.test/path');
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/page'), 'http://127.0.0.1:8080/page');
  assert.equal(normalizeBrowserUrl('about:blank'), 'about:blank');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'devtools://x', 'relay://settings', 'https://user:pass@example.test', 'about:config', 'https://example.test\n']) {
    if (url.endsWith('\n')) continue; // Surrounding whitespace is normal address-bar input.
    assert.throws(() => normalizeBrowserUrl(url));
  }
  assert.throws(() => normalizeBrowserUrl('https://exam\nple.test'));
});

test('each tab is an isolated sandboxed WebContentsView without Relay APIs, Node or persistent session', async () => {
  const h = fixture(); const one = await h.create(), two = await h.create();
  assert.notEqual(one, two); assert.notEqual(h.partitions[0].name, h.partitions[1].name);
  assert.ok(h.partitions.every(partition => !partition.name.startsWith('persist:')));
  const preferences = h.views[0].options.webPreferences;
  for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'webviewTag', 'allowRunningInsecureContent']) assert.equal(preferences[key], false);
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true);
  assert.equal(preferences.preload, path.resolve(__dirname, '../browser-page-preload.js')); assert.equal(h.host.ownsWebContents(h.views[0].webContents), true);
  assert.equal(h.host.ownsWebContents({}), false); assert.equal(h.partitions[0].check(), false);
  let approved; h.partitions[0].request(null, 'media', value => { approved = value; }); assert.equal(approved, false);
  h.host.destroy();
});

test('create events correlate renderer requests without persisting or forwarding other metadata', async () => {
  const h = fixture();
  try {
    for (const clientRequestId of ['manager-1_A', 'a'.repeat(128)]) {
      const result = await h.host.invoke({ action: 'create', url: 'https://example.test', clientRequestId,
        requestedActive: true, openerId: 'untrusted', privileged: { method: 'anything' } });
      assert.equal(result.ok, true);
      const event = h.events.find(event => event.type === 'created' && event.id === result.id);
      assert.equal(event.clientRequestId, clientRequestId);
      for (const key of ['requestedActive', 'openerId', 'privileged']) assert.equal(Object.hasOwn(event, key), false);
      assert.equal(Object.hasOwn(result.tab, 'clientRequestId'), false);
      assert.equal(Object.hasOwn(h.host.state(result.id).tab, 'clientRequestId'), false);
      assert.ok(h.events.filter(event => event.id === result.id && event.type !== 'created')
        .every(event => !Object.hasOwn(event, 'clientRequestId')));
    }
  } finally { h.host.destroy(); }
});

test('create ignores malformed request identifiers while still opening the requested page', async () => {
  const h = fixture();
  try {
    for (const clientRequestId of [undefined, null, 1, {}, ['valid'], '', 'a'.repeat(129), 'two words', 'x\ny', '../x', 'x:1', '页面']) {
      const result = await h.host.invoke({ action: 'create', url: 'https://example.test', clientRequestId });
      assert.equal(result.ok, true);
      const event = h.events.find(event => event.type === 'created' && event.id === result.id);
      assert.equal(Object.hasOwn(event, 'clientRequestId'), false);
      await h.host.invoke({ action: 'close', id: result.id });
    }
  } finally { h.host.destroy(); }
});

test('snapshots expose native history position and tolerate unavailable history inspection', async () => {
  const h = fixture();
  try {
    const id = await h.create(), history = h.views[0].webContents.navigationHistory;
    assert.equal(h.host.state(id).tab.historyIndex, null);
    assert.equal(h.host.state(id).tab.historyLength, null);
    let index = 1;
    history.getActiveIndex = () => index; history.length = () => 3;
    assert.equal(h.host.state(id).tab.historyIndex, 1);
    assert.equal(h.host.state(id).tab.historyLength, 3);
    index = 0;
    h.views[0].webContents.emit('did-stop-loading');
    assert.equal(h.events.at(-1).tab.historyIndex, 0);
    assert.equal(h.events.at(-1).tab.historyLength, 3);
    history.getActiveIndex = () => { throw Error('navigation history unavailable'); };
    history.length = () => { throw Error('navigation history unavailable'); };
    assert.equal(h.host.state(id).tab.historyIndex, null);
    assert.equal(h.host.state(id).tab.historyLength, null);
  } finally { h.host.destroy(); }
});

test('only allowed page-initiated main-frame navigation emits logical history branch signals', async () => {
  const h = fixture();
  try {
    const id = await h.create(), wc = h.views[0].webContents;
    wc.navigationHistory.getActiveIndex = () => 2; wc.navigationHistory.length = () => 4;
    const starts = () => h.events.filter(event => event.type === 'navigation-start');
    const event = values => ({ isMainFrame: true, url: 'https://example.test/next', defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...values });
    wc.emit('will-navigate', event());
    assert.equal(starts().length, 1);
    assert.equal(starts()[0].id, id);
    assert.equal(starts()[0].tab.historyIndex, 2);
    assert.equal(starts()[0].tab.url, 'https://example.test/');
    wc.emit('will-navigate', event({ url: undefined, isMainFrame: undefined }), 'https://example.test/legacy', false, true);
    assert.equal(starts().length, 2);
    const blocked = event({ url: 'file:///secret' }); wc.emit('will-navigate', blocked);
    assert.equal(blocked.defaultPrevented, true);
    wc.emit('will-navigate', event({ isMainFrame: false }));
    wc.emit('will-navigate', event({ isMainFrame: undefined }), 'https://example.test/frame', false, false);
    wc.emit('will-navigate', event({ defaultPrevented: true }));
    wc.emit('will-frame-navigate', event()); wc.emit('will-redirect', event());
    await h.host.invoke({ action: 'navigate', id, url: 'https://example.test/typed' });
    await h.host.invoke({ action: 'back', id }); await h.host.invoke({ action: 'forward', id });
    assert.equal(starts().length, 2);
  } finally { h.host.destroy(); }
});

test('navigation returns before network completion and stale load failure cannot replace the newer page', async () => {
  const h = fixture(); const id = await h.create(); const wc = h.views[0].webContents;
  let rejectOld;
  wc.loadURL = url => url.endsWith('/old') ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve();
  const first = await h.host.invoke({ action: 'navigate', id, url: 'https://example.test/old' });
  assert.equal(first.tab.loading, true);
  const second = await h.host.invoke({ action: 'navigate', id, url: 'https://example.test/new' });
  rejectOld(Error('old failed')); await tick(); assert.equal(h.host.state(id).tab.error, null);
  assert.equal(second.tab.url, 'https://example.test/new'); h.host.destroy();
});

test('visibility switches one view, preserves loaded background tabs, scales and clamps bounds on resize', async () => {
  const h = fixture(), a = await h.create(), b = await h.create();
  assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, false);
  await h.host.invoke({ action: 'setBounds', rect: { x: 400, y: 40, width: 300, height: 500 }, coordinateScale: 1.5 });
  await h.host.invoke({ action: 'visibility', id: a, visible: true });
  assert.deepEqual(h.views[0].rects.at(-1), { x: 600, y: 60, width: 400, height: 640 });
  await h.host.invoke({ action: 'visibility', id: b, visible: true }); assert.equal(h.views[0].visible, false); assert.equal(h.views[1].visible, true);
  h.owner.size = [800, 500]; h.owner.emit('resize');
  assert.deepEqual(h.views[1].rects.at(-1), { x: 600, y: 60, width: 200, height: 440 });
  await h.host.invoke({ action: 'visibility', visible: false }); assert.equal(h.views[1].visible, false);
  assert.equal(h.views[1].webContents.destroyed, false); assert.equal((await h.host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: NaN, height: 30 } })).ok, false);
  h.host.destroy();
});

test('page redirects, subframes, webviews and window resizing cannot escape the allowed browser surface', async () => {
  const h = fixture(); await h.create(); const wc = h.views[0].webContents;
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let blocked = false; wc.emit(eventName, { url: 'file:///secret', preventDefault() { blocked = true; } }, 'file:///secret'); assert.equal(blocked, true);
    blocked = false; wc.emit(eventName, { url: 'https://example.test/ok', preventDefault() { blocked = true; } }, 'https://example.test/ok'); assert.equal(blocked, false);
  }
  for (const eventName of ['will-attach-webview', 'content-bounds-updated']) { let blocked = false; wc.emit(eventName, { preventDefault() { blocked = true; } }); assert.equal(blocked, true); }
  h.host.destroy();
});

test('new-window requests become one internal tab event and never launch an external browser or allow an opener', async () => {
  const h = fixture(), id = await h.create(); const wc = h.views[0].webContents;
  const result = wc.popup({ url: 'https://example.test/popup', disposition: 'foreground-tab' }); await tick();
  assert.deepEqual(result, { action: 'deny' }); assert.equal(h.views.length, 2); assert.equal(h.external.length, 0);
  const created = h.events.filter(event => event.type === 'created'); assert.equal(created.length, 2); assert.equal(created[1].openerId, id); assert.equal(created[1].requestedActive, true);
  assert.deepEqual(wc.popup({ url: 'file:///private' }), { action: 'deny' }); assert.equal(h.views.length, 2);
  assert.deepEqual(wc.popup({ url: 'https://example.test/submit', postBody: { data: [] } }), { action: 'deny' }); assert.equal(h.views.length, 2);
  h.host.destroy();
});

test('history, zoom, search and external-open actions act on the selected tab with bounded inputs', async () => {
  const h = fixture(), id = await h.create(); const wc = h.views[0].webContents;
  for (const action of ['back', 'forward', 'reload', 'stop']) assert.equal((await h.host.invoke({ action, id })).ok, true);
  assert.equal((await h.host.invoke({ action: 'zoom', id, factor: 1.25 })).tab.zoom, 1.25);
  assert.equal((await h.host.invoke({ action: 'zoom', id, factor: 0 })).code, 'INVALID_ZOOM');
  assert.equal((await h.host.invoke({ action: 'find', id, text: 'hello' })).requestId, 42);
  assert.equal(wc.calls.at(-1)[2].findNext, true, 'Electron requires new_session=true for the initial search');
  await h.host.invoke({ action: 'find', id, text: 'hello', findNext: true });
  assert.equal(wc.calls.at(-1)[2].findNext, false, 'next match must continue the native search');
  wc.emit('found-in-page', {}, { requestId: 42, matches: 3, activeMatchOrdinal: 1, finalUpdate: true });
  assert.equal(h.events.at(-1).type, 'find'); assert.equal(h.events.at(-1).matches, 3);
  await h.host.invoke({ action: 'stopFind', id }); assert.deepEqual(wc.calls.at(-1), ['stopFind', 'clearSelection']);
  await h.host.invoke({ action: 'openExternal', id }); assert.deepEqual(h.external, ['https://example.test/']);
  assert.equal((await h.host.invoke({ action: 'openExternal', id, url: 'file:///private' })).ok, false); h.host.destroy();
});

function download(url, { gesture = false, chain = [url] } = {}) {
  const item = new EventEmitter(); item.cancelled = false; item.getFilename = () => 'result.txt'; item.getURL = () => url;
  item.getURLChain = () => chain; item.hasUserGesture = () => gesture;
  item.setSaveDialogOptions = value => { item.dialog = value; }; item.cancel = () => { item.cancelled = true; };
  return item;
}
test('downloads require a visible owned tab and real user gesture, always keep native save dialog', async () => {
  const h = fixture(), id = await h.create(); await h.show(id);
  const wc = h.views[0].webContents, partition = h.partitions[0];
  const run = (item, contents = wc) => { let blocked = false; partition.emit('will-download', { preventDefault() { blocked = true; } }, item, contents); return blocked; };
  assert.equal(run(download('https://example.test/driveby')), true);
  const accepted = download('https://example.test/export', { gesture: true }); assert.equal(run(accepted), false); assert.ok(accepted.dialog);
  assert.equal(Object.hasOwn(accepted, 'savePath'), false);
  assert.equal(run(download('https://example.test/export', { gesture: true }), {}), true);
  assert.equal(run(download('file:///secret', { gesture: true })), true);
  await h.host.invoke({ action: 'visibility', visible: false }); assert.equal(run(download('https://example.test/export', { gesture: true })), true);
  h.host.destroy(); assert.equal(accepted.cancelled, true);
});

test('typed download addresses authorize only their exact redirect chain and only once', async () => {
  const h = fixture(), id = await h.create('https://example.test/export'); await h.show(id);
  const partition = h.partitions[0], wc = h.views[0].webContents;
  const run = item => { let blocked = false; partition.emit('will-download', { preventDefault() { blocked = true; } }, item, wc); return blocked; };
  assert.equal(run(download('https://cdn.test/file', { chain: ['https://example.test/export', 'https://cdn.test/file'] })), false);
  assert.equal(run(download('https://example.test/export')), true);
  await h.host.invoke({ action: 'navigate', id, url: 'https://example.test/new' }); h.advance(30001);
  assert.equal(run(download('https://example.test/new')), true); h.host.destroy();
});

test('TLS and renderer failure are reported without a bypass and subframe failures leave main content intact', async () => {
  const h = fixture(), id = await h.create(); const wc = h.views[0].webContents;
  wc.emit('did-fail-load', {}, -105, 'subframe failed', 'https://widget.test', false); assert.equal(h.host.state(id).tab.error, null);
  wc.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://example.test/', true);
  assert.equal(h.host.state(id).tab.error, 'ERR_CERT_AUTHORITY_INVALID'); assert.equal(wc.listenerCount('certificate-error'), 0);
  wc.emit('render-process-gone', {}, { reason: 'crashed' }); assert.match(h.host.state(id).tab.error, /crashed/); h.host.destroy();
});

test('closing tabs and destroying the owner closes WebContents and removes session listeners exactly once', async () => {
  const h = fixture(), a = await h.create(), b = await h.create(); await h.show(a);
  const first = await h.host.invoke({ action: 'close', id: a }); assert.equal(first.activeId, b); assert.equal(first.tabs.length, 1); assert.equal(first.visible, false); assert.equal(h.views[1].visible, false);
  assert.equal(h.views[0].webContents.destroyed, true); assert.equal(h.partitions[0].listenerCount('will-download'), 0);
  h.owner.closed = true; h.owner.emit('closed'); h.host.destroy();
  assert.equal(h.views[1].webContents.destroyed, true); assert.equal(h.owner.contentView.children.length, 0);
  assert.equal(h.owner.listenerCount('resize'), 0); assert.equal(h.partitions[1].listenerCount('will-download'), 0);
  assert.equal(h.views[1].webContents.calls.filter(call => call[0] === 'close').length, 1);
  assert.equal((await h.host.invoke({ action: 'create' })).code, 'BROWSER_CLOSED');
});

test('owner hide/minimize suspend native content and downloads without destroying the active tab', async () => {
  const h = fixture(), id = await h.create(); await h.show(id);
  for (const [hide, restore] of [['hide', 'show'], ['minimize', 'restore']]) {
    h.owner.emit(hide); assert.equal(h.views[0].visible, false); assert.equal(h.views[0].webContents.destroyed, false);
    let blocked = false; h.partitions[0].emit('will-download', { preventDefault() { blocked = true; } }, download('https://example.test/file', { gesture: true }), h.views[0].webContents);
    assert.equal(blocked, true);
    h.owner.emit(restore); assert.equal(h.views[0].visible, true);
  }
  h.host.destroy();
});

test('a normal owner close retires children before teardown while a prevented close preserves tabs', async () => {
  const h = fixture(), id = await h.create(); await h.show(id);
  h.owner.emit('close', { defaultPrevented: true });
  assert.equal(h.host.isDestroyed(), false); assert.equal(h.views[0].webContents.destroyed, false);
  h.owner.emit('close', { defaultPrevented: false });
  assert.equal(h.host.isDestroyed(), true); assert.equal(h.views[0].webContents.destroyed, true);
  assert.equal(h.owner.listenerCount('close'), 0); assert.equal(h.partitions[0].listenerCount('will-download'), 0);
});

test('owner renderer destruction, crash or new document retires every native browser tab', async () => {
  for (const name of ['destroyed', 'render-process-gone', 'will-navigate', 'did-start-navigation']) {
    const h = fixture(); await h.create(); await h.create();
    h.owner.webContents.emit(name, { isMainFrame: true, isSameDocument: false }, 'file:///fixture/index.html', false, true);
    assert.equal(h.host.isDestroyed(), true, name); await tick(); assert.ok(h.views.every(view => view.webContents.destroyed));
    assert.equal(h.owner.webContents.listenerCount('render-process-gone'), 0); assert.equal(h.owner.listenerCount('restore'), 0);
  }
  const h = fixture(); await h.create();
  h.owner.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  h.owner.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(h.host.isDestroyed(), false); h.host.destroy();
});

test('browser modifier shortcuts reach its toolbar only; ordinary text and composition remain webpage input', async () => {
  const h = fixture(), id = await h.create(); await h.show(id); const wc = h.views[0].webContents;
  for (const [key, action] of [['l', 'address'], ['t', 'newTab'], ['w', 'closeTab'], ['f', 'find'], ['Tab', 'nextTab']]) {
    let prevented = false; wc.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', control: true, key });
    assert.equal(prevented, true); assert.equal(h.events.at(-1).type, 'shortcut'); assert.equal(h.events.at(-1).action, action);
  }
  const before = h.events.length;
  for (const input of [{ key: 'hello' }, { control: true, key: 'f', isComposing: true }, { control: true, alt: true, key: 'l' }]) {
    let prevented = false; wc.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', ...input }); assert.equal(prevented, false);
  }
  assert.equal(h.events.length, before); h.host.destroy();
});

function nativeKey(h, input, viewIndex = 0) {
  const before = h.events.length;
  let prevented = false;
  h.views[viewIndex].webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', ...input });
  return { prevented, shortcuts: h.events.slice(before).filter(event => event.type === 'shortcut') };
}

test('native browser forwards all default workspace shortcuts, then honors replacements and explicit removal', async () => {
  const h = fixture({ platform: 'win32' }), id = await h.create(); await h.show(id);
  const actions = ['newBrowser', 'openFiles', 'newTerminal', 'openReview'];
  assert.equal((await h.host.invoke({ action: 'shortcuts.set', bindings: Object.fromEntries(actions.map((action, i) => [action, ['Mod+Alt+' + (i + 1)]])) })).ok, true);
  for (const [index, action] of actions.entries()) {
    const input = nativeKey(h, { key: String(index + 1), code: 'Digit' + (index + 1), control: true, alt: true });
    assert.equal(input.prevented, true); assert.equal(input.shortcuts.length, 1); assert.equal(input.shortcuts[0].action, 'workspace');
    assert.equal(input.shortcuts[0].workspaceAction, action); assert.equal(input.shortcuts[0].id, id);
  }
  assert.equal(nativeKey(h, { key: '5', code: 'Digit5', control: true, alt: true }).prevented, false);
  assert.equal((await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Shift+8', 'F2'] } })).ok, true);
  assert.equal(nativeKey(h, { key: '3', control: true, alt: true }).prevented, false);
  assert.equal(nativeKey(h, { key: '*', code: 'Digit8', control: true, shift: true }).shortcuts[0].workspaceAction, 'newTerminal');
  assert.equal(nativeKey(h, { key: 'F2' }).shortcuts[0].workspaceAction, 'newTerminal');
  await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: [] } });
  assert.equal(nativeKey(h, { key: 'F2' }).prevented, false);
  assert.equal(nativeKey(h, { key: '8', control: true, shift: true }).prevented, false);
  h.host.destroy();
});

test('invalid or duplicate native workspace configurations are rejected atomically', async () => {
  const h = fixture({ platform: 'win32' }), id = await h.create(); await h.show(id);
  await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Alt+3'] } });
  const invalid = [null, [], { newChat: ['Mod+Alt+1'] }, { openTasks: ['Mod+Alt+5'] }, { newTerminal: 'F2' }, { newTerminal: ['F1', 'F2', 'F3', 'F4'] },
    { newTerminal: ['Mod+K', 'invalid'] }, { newTerminal: ['Mod+K'], openReview: ['mod+k'] },
    { newTerminal: ['Mod+K', ' Mod + K '] }, { newTerminal: ['A'] }, { newTerminal: ['Mod+V'] }, { newTerminal: ['Alt+F4'] }];
  for (const bindings of invalid) {
    const result = await h.host.invoke({ action: 'shortcuts.set', bindings });
    assert.equal(result.ok, false); assert.equal(result.code, 'INVALID_SHORTCUTS');
    assert.equal(nativeKey(h, { key: '3', control: true, alt: true }).shortcuts[0].workspaceAction, 'newTerminal');
    assert.equal(nativeKey(h, { key: 'k', control: true }).prevented, false);
  }
  await h.host.invoke({ action: 'shortcuts.set', bindings: {} });
  assert.equal(nativeKey(h, { key: '3', control: true, alt: true }).prevented, false); h.host.destroy();
});

test('native shortcuts preserve composition, repeat and AltGraph text input including fallback browser keys', async () => {
  const h = fixture({ platform: 'win32' }), id = await h.create(); await h.show(id);
  await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Alt+3', 'Mod+L'] } });
  for (const input of [
    { key: '3', control: true, alt: true, isComposing: true },
    { key: '3', control: true, alt: true, isAutoRepeat: true },
    { key: '3', control: true, alt: true, modifiers: ['altGraph'] },
    { key: '3', control: true, alt: true, modifiers: ['altgr'] },
    { key: 'l', control: true, isAutoRepeat: true },
    { key: 't', control: true, isAutoRepeat: true },
    { key: 'l', control: true, keyCode: 229 },
    { key: 'Process', control: true }, { key: 'Dead', control: true },
    { key: '3', control: true, alt: true, type: 'keyUp' },
  ]) { const result = nativeKey(h, input); assert.equal(result.prevented, false); assert.equal(result.shortcuts.length, 0); }
  assert.equal(nativeKey(h, { key: '3', control: true, alt: true }).shortcuts[0].workspaceAction, 'newTerminal'); h.host.destroy();
});

test('right Alt state protects actual AltGraph sequences and clears on keyup, blur and hidden views', async () => {
  const h = fixture({ platform: 'win32' }), id = await h.create(); await h.show(id);
  await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Alt+3'] } });
  const letter = { key: '#', code: 'Digit3', control: true, alt: true };
  nativeKey(h, { key: 'AltGraph', code: 'AltRight', control: true, alt: true });
  assert.equal(nativeKey(h, letter).prevented, false);
  nativeKey(h, { type: 'keyUp', key: 'AltGraph', code: 'AltRight' });
  assert.equal(nativeKey(h, letter).shortcuts[0].workspaceAction, 'newTerminal');
  nativeKey(h, { key: 'Alt', code: 'AltRight', control: true, alt: true });
  assert.equal(nativeKey(h, letter).prevented, false);
  h.views[0].webContents.emit('blur'); assert.equal(nativeKey(h, letter).prevented, true);
  nativeKey(h, { key: 'Alt', code: 'AltRight', control: true, alt: true });
  await h.host.invoke({ action: 'visibility', visible: false }); await h.show(id);
  assert.equal(nativeKey(h, letter).prevented, true); h.host.destroy();
});

test('background, hidden, minimized and closed native views never forward workspace shortcuts', async () => {
  const h = fixture({ platform: 'win32' }), one = await h.create(), two = await h.create(); await h.show(one);
  await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Alt+3'] } });
  const input = { key: '3', code: 'Digit3', control: true, alt: true };
  assert.equal(nativeKey(h, input, 1).prevented, false); assert.equal(nativeKey(h, input, 0).prevented, true);
  await h.show(two); assert.equal(nativeKey(h, input, 0).prevented, false);
  await h.host.invoke({ action: 'visibility', visible: false }); assert.equal(nativeKey(h, input, 1).prevented, false);
  await h.show(two); h.owner.emit('minimize'); assert.equal(nativeKey(h, input, 1).prevented, false);
  h.owner.emit('restore'); assert.equal(nativeKey(h, input, 1).prevented, true);
  await h.host.invoke({ action: 'close', id: two }); assert.equal(nativeKey(h, input, 1).prevented, false);
  h.host.destroy(); assert.equal(nativeKey(h, input, 0).prevented, false);
});

test('native platform modifier mapping matches the renderer and preserves the original address shortcut', async () => {
  for (const platform of ['win32', 'darwin']) {
    const h = fixture({ platform }), id = await h.create(); await h.show(id);
    await h.host.invoke({ action: 'shortcuts.set', bindings: { newTerminal: ['Mod+Alt+3'], openReview: ['Mod+Ctrl+F2'] } });
    const primary = platform === 'darwin' ? { meta: true } : { control: true };
    const wrong = platform === 'darwin' ? { control: true } : { meta: true };
    assert.equal(nativeKey(h, { key: '3', code: 'Digit3', alt: true, ...primary }).shortcuts[0].workspaceAction, 'newTerminal');
    assert.equal(nativeKey(h, { key: '3', code: 'Digit3', alt: true, ...wrong }).prevented, false);
    assert.equal(nativeKey(h, { key: 'l', ...primary }).shortcuts[0].action, 'address');
    assert.equal(nativeKey(h, { key: 'l', ...wrong }).prevented, false);
    const doublePrimary = nativeKey(h, { key: 'F2', meta: true, control: true });
    assert.equal(doublePrimary.prevented, platform === 'darwin');
    if (platform === 'darwin') assert.equal(doublePrimary.shortcuts[0].workspaceAction, 'openReview');
    await h.host.invoke({ action: 'shortcuts.set', bindings: {} });
    assert.equal(nativeKey(h, { key: 'l', ...primary }).shortcuts[0].action, 'address'); h.host.destroy();
  }
});

test('capture only reads the active presented page, caps image size and rejects a late hidden-page capture', async () => {
  const h = fixture(), id = await h.create(); const wc = h.views[0].webContents; let size;
  const screenshot = { isEmpty: () => false, getSize: () => ({ width: 2400, height: 1200 }),
    resize: value => { size = value; return { toDataURL: () => 'data:image/png;base64,fixture' }; } };
  wc.capturePage = async () => screenshot;
  assert.equal((await h.host.invoke({ action: 'capture', id })).code, 'BROWSER_NOT_VISIBLE');
  await h.show(id); const result = await h.host.invoke({ action: 'capture', id });
  assert.equal(result.dataUrl, 'data:image/png;base64,fixture'); assert.deepEqual(size, { width: 1600, height: 800 });
  let resolve; wc.capturePage = () => new Promise(yes => { resolve = yes; });
  const pending = h.host.invoke({ action: 'capture', id }); await h.host.invoke({ action: 'visibility', visible: false }); resolve(screenshot);
  assert.equal((await pending).code, 'BROWSER_CAPTURE_STALE'); h.host.destroy();
});

function temporaryProfile(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-host-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return createBrowserProfileStore({ rootDir, downloadDirectory: rootDir });
}

test('a production browser profile shares one dedicated session and preserves it when tabs or owner close', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile });
  const a = await h.create(), b = await h.create();
  assert.equal(h.partitions.length, 1); assert.equal(h.views[0].options.webPreferences.session, h.views[1].options.webPreferences.session);
  assert.equal(h.partitions[0].name, profile.sessionPath); assert.equal(h.partitions[0].listenerCount('will-download'), 1);
  await h.host.invoke({ action: 'close', id: a }); await tick();
  assert.equal(h.partitions[0].clearedStorage, undefined); assert.equal(h.partitions[0].listenerCount('will-download'), 1);
  assert.equal(h.views[1].webContents.destroyed, false);
  h.host.destroy(); await tick();
  assert.equal(h.partitions[0].clearedStorage, undefined); assert.equal(h.partitions[0].clearedCache, undefined);
  assert.equal(h.partitions[0].listenerCount('will-download'), 0); assert.equal(h.views[1].webContents.destroyed, true);
});

test('search uses the selected engine and link routing distinguishes local development from ordinary websites', async () => {
  assert.equal(resolveBrowserAddress('help me test', 'duckduckgo'), 'https://duckduckgo.com/?q=help%20me%20test');
  assert.equal(resolveBrowserAddress('localhost:8000/a'), 'http://localhost:8000/a');
  assert.throws(() => resolveBrowserAddress('javascript:alert(1)'));
  const h = fixture();
  await h.host.invoke({ action: 'settings.update', settings: { webLinkTarget: 'external', localLinkTarget: 'internal', searchEngine: 'google' } });
  assert.match((await h.host.invoke({ action: 'resolve', text: 'Relay help' })).url, /^https:\/\/www.google.com\/search/);
  assert.equal((await h.host.invoke({ action: 'openLink', url: 'https://example.test' })).external, true);
  const local = await h.host.invoke({ action: 'openLink', url: 'http://127.0.0.1:8080/' });
  assert.equal(local.tab.url, 'http://127.0.0.1:8080/'); assert.equal(h.views.length, 1); assert.equal(h.external.length, 1);
  h.host.destroy();
});

test('visited pages and bookmarks are real stored data; clearing history is not undone by a late page title', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }), id = await h.create(); const wc = h.views[0].webContents;
  wc.emit('did-navigate', {}, 'https://example.test/'); wc.emit('page-title-updated', {}, 'A real title');
  assert.equal((await h.host.invoke({ action: 'history.list' })).items[0].title, 'A real title');
  assert.equal((await h.host.invoke({ action: 'bookmark', id, toggle: true })).bookmarked, true);
  assert.equal(h.host.state(id).tab.bookmarked, true);
  await h.host.invoke({ action: 'history.clear' }); wc.emit('page-title-updated', {}, 'Later title');
  assert.equal((await h.host.invoke({ action: 'history.list' })).total, 0); assert.equal((await h.host.invoke({ action: 'bookmarks.list' })).total, 1);
  assert.equal((await h.host.invoke({ action: 'bookmark', id, toggle: true })).bookmarked, false); h.host.destroy();
});

test('site permission requests show the actual origin, remember only explicit always-allow and fail closed across navigation', async t => {
  const profile = temporaryProfile(t), prompts = []; let answer = { response: 2 };
  const h = fixture({ profile, dialog: { showMessageBox: async (_owner, options) => { prompts.push(options); return await answer; } } });
  const id = await h.create(); await h.show(id); const wc = h.views[0].webContents, ses = h.partitions[0];
  let allowed;
  await ses.request(wc, 'media', value => { allowed = value; }, { requestingUrl: 'https://example.test/form', mediaTypes: ['video'] });
  assert.equal(allowed, true); assert.equal(prompts[0].detail, 'https://example.test'); assert.equal(profile.permission('https://example.test', 'camera'), 'allow');
  assert.equal(ses.check(wc, 'media', 'https://example.test', { mediaType: 'video' }), true);
  await h.host.invoke({ action: 'permissions.set', origin: 'https://example.test', permission: 'camera', decision: 'block' });
  await ses.request(wc, 'media', value => { allowed = value; }, { mediaTypes: ['video'] }); assert.equal(allowed, false); assert.equal(prompts.length, 1);
  let resolve; answer = new Promise(yes => { resolve = yes; });
  const pending = ses.request(wc, 'geolocation', value => { allowed = value; }, { requestingUrl: 'https://example.test/form' });
  await h.host.invoke({ action: 'navigate', id, url: 'https://different.test/' }); resolve({ response: 2 }); await pending;
  assert.equal(allowed, false); assert.equal(profile.permission('https://example.test', 'location'), 'ask'); h.host.destroy();
});

test('clearing browser cookies/cache touches only the dedicated browser session and retains saved bookmarks and downloads', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }); await h.create();
  profile.bookmark({ url: 'https://example.test' }); profile.download({ id: 'saved', url: 'https://example.test/file', state: 'completed' });
  assert.equal((await h.host.invoke({ action: 'data.clear' })).code, 'INVALID_CLEAR_OPTIONS');
  assert.equal((await h.host.invoke({ action: 'data.clear', cookies: true, cache: true })).ok, true);
  assert.equal(h.partitions[0].clearedStorage, true); assert.equal(h.partitions[0].clearedCache, true);
  assert.equal(profile.list('bookmarks').total, 1); assert.equal(profile.list('downloads').total, 1); h.host.destroy();
});

test('downloads expose actual progress/control, keep collision-free paths and records without deleting delivered files', async t => {
  const profile = temporaryProfile(t); profile.updateSettings({ askDownloadLocation: false });
  fs.writeFileSync(path.join(profile.rootDir, 'result.txt'), 'existing');
  const h = fixture({ profile }), id = await h.create(); await h.show(id);
  const item = download('https://example.test/file', { gesture: true }); let paused = false, bytes = 12;
  item.setSavePath = value => { item.file = value; }; item.getSavePath = () => item.file; item.getReceivedBytes = () => bytes; item.getTotalBytes = () => 30;
  item.isPaused = () => paused; item.canResume = () => true; item.getState = () => 'progressing';
  item.pause = () => { paused = true; }; item.resume = () => { paused = false; };
  h.partitions[0].emit('will-download', { preventDefault() { assert.fail('explicit download was blocked'); } }, item, h.views[0].webContents);
  assert.equal(path.basename(item.file), 'result (1).txt');
  const saved = (await h.host.invoke({ action: 'downloads.list' })).items[0]; assert.equal(saved.receivedBytes, 12);
  assert.equal((await h.host.invoke({ action: 'downloads.delete', recordId: saved.id })).code, 'DOWNLOAD_ACTIVE');
  await h.host.invoke({ action: 'downloads.pause', recordId: saved.id }); assert.equal((await h.host.invoke({ action: 'downloads.list' })).items[0].state, 'paused');
  await h.host.invoke({ action: 'downloads.resume', recordId: saved.id }); assert.equal(paused, false);
  await h.host.invoke({ action: 'close', id }); assert.equal(item.cancelled, false, 'download survives closing its source tab');
  bytes = 30; fs.writeFileSync(item.file, 'delivered'); item.emit('done', {}, 'completed');
  assert.equal((await h.host.invoke({ action: 'downloads.list' })).items[0].state, 'completed');
  assert.equal((await h.host.invoke({ action: 'downloads.open', recordId: saved.id })).ok, true); assert.equal(h.external.at(-1), item.file);
  await h.host.invoke({ action: 'downloads.delete', recordId: saved.id }); assert.equal(fs.readFileSync(item.file, 'utf8'), 'delivered'); h.host.destroy();
});

test('completed downloads ignore late progress and detach native item listeners', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }); t.after(() => h.host.destroy());
  const id = await h.create(); await h.show(id);
  const item = download('https://example.test/file', { gesture: true });
  item.getState = () => 'progressing';
  h.partitions[0].emit('will-download', { preventDefault() { assert.fail('download was blocked'); } }, item, h.views[0].webContents);
  const saved = profile.list('downloads').items[0];
  item.emit('done', {}, 'completed');
  const completed = profile.getDownload(saved.id), events = h.events.length;
  h.advance(2000); item.emit('updated', {}, 'progressing'); item.emit('done', {}, 'cancelled');
  assert.deepEqual(profile.getDownload(saved.id), completed);
  assert.equal(h.events.length, events);
  assert.equal(item.listenerCount('updated'), 0); assert.equal(item.listenerCount('done'), 0);
});

test('owner teardown settles downloads once before late cancellation events can change history', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }); t.after(() => h.host.destroy());
  const id = await h.create(); await h.show(id);
  const item = download('https://example.test/file', { gesture: true });
  h.partitions[0].emit('will-download', { preventDefault() { assert.fail('download was blocked'); } }, item, h.views[0].webContents);
  const saved = profile.list('downloads').items[0];
  item.cancel = () => { item.cancelled = true; item.emit('done', {}, 'cancelled'); };
  h.host.destroy();
  const interrupted = profile.getDownload(saved.id), events = h.events.length;
  assert.equal(interrupted.state, 'interrupted'); assert.equal(item.cancelled, true);
  h.advance(2000); item.emit('updated', {}, 'progressing'); item.emit('done', {}, 'cancelled');
  assert.deepEqual(profile.getDownload(saved.id), interrupted);
  assert.equal(h.events.length, events);
  assert.equal(item.listenerCount('updated'), 0); assert.equal(item.listenerCount('done'), 0);
});

test('native cancellation failure cannot leave an orphaned progressing download after owner teardown', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }); t.after(() => h.host.destroy());
  const id = await h.create(); await h.show(id);
  const item = download('https://example.test/file', { gesture: true });
  h.partitions[0].emit('will-download', { preventDefault() { assert.fail('download was blocked'); } }, item, h.views[0].webContents);
  const saved = profile.list('downloads').items[0];
  item.cancel = () => { throw Error('native item already unavailable'); };
  assert.doesNotThrow(() => h.host.destroy());
  assert.equal(profile.getDownload(saved.id).state, 'interrupted');
  assert.equal(item.listenerCount('updated'), 0); assert.equal(item.listenerCount('done'), 0);
});

test('PDF and screenshot export use a native save choice even while menus hide the view; a navigated target never writes', async t => {
  const profile = temporaryProfile(t); let destination = path.join(profile.rootDir, 'page.pdf'), choose = null;
  const h = fixture({ profile, dialog: { showSaveDialog: async () => choose ? await choose : { canceled: false, filePath: destination } } });
  const id = await h.create(), wc = h.views[0].webContents;
  wc.printToPDF = async () => Buffer.from('synthetic PDF'); wc.capturePage = async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('synthetic PNG') });
  assert.equal((await h.host.invoke({ action: 'savePdf', id })).ok, true); assert.equal(fs.readFileSync(destination, 'utf8'), 'synthetic PDF');
  destination = path.join(profile.rootDir, 'page.png'); assert.equal((await h.host.invoke({ action: 'saveScreenshot', id })).ok, true); assert.equal(fs.readFileSync(destination, 'utf8'), 'synthetic PNG');
  let resolve; choose = new Promise(yes => { resolve = yes; }); const pending = h.host.invoke({ action: 'savePdf', id }); await tick();
  await h.host.invoke({ action: 'navigate', id, url: 'https://other.test' }); const wrong = path.join(profile.rootDir, 'wrong.pdf'); resolve({ filePath: wrong });
  assert.equal((await pending).code, 'BROWSER_CAPTURE_STALE'); assert.equal(fs.existsSync(wrong), false); h.host.destroy();
});

test('native menus expose editing and catch a tab limit; shifted Ctrl-plus remains browser zoom', async () => {
  let template; const h = fixture({ maxTabs: 1, Menu: { buildFromTemplate: items => { template = items; return { popup() {} }; } } });
  const id = await h.create(); await h.show(id); const wc = h.views[0].webContents;
  wc.emit('context-menu', {}, { linkURL: 'https://example.test/linked', isEditable: true, editFlags: { canCopy: true, canPaste: true } }); await tick();
  assert.ok(template.some(item => item.label === '粘贴')); template.find(item => item.label === '在新标签页打开链接').click(); await tick();
  assert.match(h.host.state(id).tab.error, /关闭部分标签/);
  let prevented = false; wc.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', control: true, shift: true, key: '+' });
  assert.equal(prevented, true); assert.equal(h.events.at(-1).action, 'zoomIn'); h.host.destroy();
});

test('manual password fill requires a matching HTTPS origin and rechecks the page after retrieving the saved account', async () => {
  let release, delayed = false; const calls = [];
  const formStore = { invoke: async input => { calls.push(input); if (delayed) await new Promise(yes => { release = yes; }); return { ok: true, origin: input.origin, username: 'synthetic-user', password: 'synthetic-password' }; } };
  const h = fixture({ formStore }), id = await h.create(), wc = h.views[0].webContents; let scripts = 0; await h.show(id);
  wc.executeJavaScript = async (script, gesture) => { scripts++; assert.match(script, /document.visibilityState !== 'visible'/); assert.match(script, /location.origin !== request.origin/); assert.match(script, /location.href !== request.url/); assert.equal(gesture, true); assert.doesNotMatch(script, /\.submit\(/); return { filled: 2 }; };
  assert.equal((await h.host.invoke({ action: 'passwords.fill', id, recordId: 'account' })).filled, 2);
  assert.equal(calls[0].origin, 'https://example.test');
  delayed = true; const pending = h.host.invoke({ action: 'passwords.fill', id, recordId: 'account' }); await tick();
  await h.host.invoke({ action: 'navigate', id, url: 'https://elsewhere.test' }); release();
  assert.equal((await pending).code, 'FORM_PAGE_CHANGED'); assert.equal(scripts, 1);
  await h.host.invoke({ action: 'navigate', id, url: 'http://localhost:8080' });
  assert.equal((await h.host.invoke({ action: 'passwords.fill', id, recordId: 'account' })).code, 'INSECURE_FORM'); h.host.destroy();
});

test('manual form fill never reads saved secrets for hidden tabs and never injects after a pending fill loses visibility', async () => {
  let calls = 0, release, scripts = 0;
  const formStore = { invoke: async input => { calls++; await new Promise(yes => { release = yes; }); return { ok: true, origin: input.origin, username: 'synthetic', password: 'synthetic' }; } };
  const h = fixture({ formStore }), id = await h.create(), other = await h.create('https://other.test');
  h.views[0].webContents.executeJavaScript = async () => { scripts++; return { filled: 2 }; };
  assert.equal((await h.host.invoke({ action: 'passwords.fill', id, recordId: 'account' })).code, 'BROWSER_NOT_VISIBLE');
  assert.equal((await h.host.invoke({ action: 'contacts.fill', id, recordId: 'contact' })).code, 'BROWSER_NOT_VISIBLE'); assert.equal(calls, 0);
  await h.show(id); const pending = h.host.invoke({ action: 'passwords.fill', id, recordId: 'account' }); await tick();
  await h.show(other); release();
  assert.equal((await pending).code, 'FORM_PAGE_CHANGED'); assert.equal(scripts, 0); h.host.destroy();
});

test('Blob exports require the current page origin plus a real gesture and record their durable source page', async t => {
  const profile = temporaryProfile(t), h = fixture({ profile }), id = await h.create(); await h.show(id);
  const wc = h.views[0].webContents, ses = h.partitions[0];
  const start = item => { let blocked = false; ses.emit('will-download', { preventDefault() { blocked = true; } }, item, wc); return blocked; };
  assert.equal(start(download('blob:https://other.test/file', { gesture: true })), true);
  assert.equal(start(download('blob:null/file', { gesture: true })), true);
  assert.equal(start(download('blob:https://example.test/file', { gesture: false })), true);
  assert.equal(start(download('blob:https://example.test/file', { gesture: true })), false);
  const saved = (await h.host.invoke({ action: 'downloads.list' })).items[0]; assert.equal(saved.url, 'https://example.test/');
  assert.equal(profile.list('downloads').total, 1); h.host.destroy();
});

test('explicit native image save authorizes only its own same-origin Blob once', async () => {
  let template; const h = fixture({ Menu: { buildFromTemplate: items => { template = items; return { popup() {} }; } } });
  const id = await h.create(); await h.show(id); const wc = h.views[0].webContents, ses = h.partitions[0];
  let blocked;
  wc.downloadURL = url => { blocked = false; ses.emit('will-download', { preventDefault() { blocked = true; } }, download(url), wc); };
  wc.emit('context-menu', {}, { mediaType: 'image', srcURL: 'blob:https://other.test/image', x: 1, y: 1 }); await tick();
  assert.equal(template.some(item => item.label === '图片另存为…'), false);
  wc.emit('context-menu', {}, { mediaType: 'image', srcURL: 'blob:https://example.test/image', x: 1, y: 1 }); await tick();
  template.find(item => item.label === '图片另存为…').click(); await tick(); assert.equal(blocked, false);
  wc.downloadURL('blob:https://example.test/image'); assert.equal(blocked, true); h.host.destroy();
});
