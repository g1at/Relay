'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, describe, createStore, create } = require('../renderer/sidebar-update');

const snapshot = (state, extra = {}) => ({ state, current: '2.1.0', latest: '', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function updater(initial = snapshot('idle')) {
  let state = initial;
  const listeners = new Set(), calls = [];
  const api = {
    status: async () => { calls.push('status'); return { ...state }; },
    onEvent: (handler) => { calls.push('subscribe'); listeners.add(handler); return () => listeners.delete(handler); },
    check: async () => { calls.push('check'); return { ...state }; },
    download: async () => { calls.push('download'); return { ok: true }; },
    quitAndInstall: async () => { calls.push('install'); return { ok: true }; },
    dismiss: async () => { calls.push('dismiss'); return { ok: true }; },
  };
  return { api, calls, emit(next) { state = next; listeners.forEach(handler => handler({ ...next })); } };
}

test('visibility distinguishes known updates from empty checks, errors and development mode', () => {
  for (const state of ['idle', 'checking', 'error', 'disabled']) assert.equal(describe(snapshot(state)).visible, false, state);
  for (const state of ['available', 'downloading', 'ready', 'checking', 'error']) {
    assert.equal(describe(snapshot(state, { latest: '2.2.0', dismissed: true })).visible, true, state);
  }
  assert.equal(describe(snapshot('disabled', { latest: '2.2.0' })).visible, false);
  assert.equal(describe(snapshot('error', { latest: 'v2.1.0' })).visible, false);
  assert.match(describe(snapshot('idle', { latest: '2.2.0', checkedAt: 123 })).note, /点击重新检查/);
  assert.equal(normalize({ progress: -4 }).progress, 0);
  assert.equal(normalize({ progress: 150 }).progress, 100);
  const check = describe(snapshot('error', { latest: '2.2.0', error: 'offline' }));
  assert.equal(check.action, 'check'); assert.match(check.note, /已知 v2.2.0/); assert.match(check.error, /检查失败/);
  const download = describe(snapshot('available', { latest: '2.2.0', error: 'offline' }));
  assert.equal(download.action, 'download'); assert.equal(download.actionLabel, '重试下载'); assert.match(download.error, /下载失败/);
});

test('one subscription and status events never start checks, downloads or installation', async () => {
  const h = updater(), changes = [];
  const store = createStore(h.api, (st, view) => changes.push({ st, view }));
  await store.start(); await store.start();
  for (const state of ['available', 'downloading', 'ready']) h.emit(snapshot(state, { latest: '2.2.0' }));
  assert.deepEqual(h.calls, ['subscribe', 'status']);
  assert.equal(store.getView().action, 'install');
  store.destroy(); h.emit(snapshot('idle'));
  assert.equal(changes.at(-1).st.state, 'ready');
});

test('late status snapshots and failures cannot overwrite a newer pushed state', async () => {
  for (const fail of [false, true]) {
    const h = updater(), gate = deferred();
    h.api.status = () => gate.promise;
    const store = createStore(h.api); const started = store.start();
    h.emit(snapshot('ready', { latest: '2.2.0' }));
    if (fail) gate.reject(new Error('old status request failed')); else gate.resolve(snapshot('idle'));
    await started;
    assert.equal(store.getState().state, 'ready');
    assert.equal(store.getView().error, '');
  }
});

test('download failures remain reachable and every retry requires an explicit action', async () => {
  const h = updater(snapshot('available', { latest: '2.2.0' }));
  const store = createStore(h.api); await store.start();
  const gate = deferred();
  h.api.download = () => { h.calls.push('download'); h.emit(snapshot('downloading', { latest: '2.2.0', progress: 3 })); return gate.promise; };
  const downloading = store.run('download');
  assert.equal(await store.run('download'), false);
  assert.equal(store.getView().pending, true);
  gate.resolve({ ok: true }); await downloading;
  h.emit(snapshot('available', { latest: '2.2.0', error: 'connection interrupted' }));
  assert.equal(store.getView().visible, true); assert.equal(store.getView().actionLabel, '重试下载');
  assert.equal(h.calls.filter(call => call === 'download').length, 1);
  await store.run('download');
  assert.equal(h.calls.filter(call => call === 'download').length, 2);
});

test('failed checks with known versions offer checking, never an implicit download', async () => {
  const h = updater(snapshot('error', { latest: '2.2.0', error: 'offline' }));
  h.api.check = async () => { h.calls.push('check'); const next = snapshot('available', { latest: '2.3.0' }); h.emit(next); return next; };
  const store = createStore(h.api); await store.start();
  assert.equal(await store.run('download'), false);
  await store.activateFromSettings();
  assert.equal(store.getState().latest, '2.3.0');
  assert.equal(h.calls.includes('download'), false);
  await store.run('download');
  assert.equal(h.calls.filter(call => call === 'download').length, 1);
});

test('IPC refusal and rejection remain visible and retryable; accepted installation cannot duplicate', async () => {
  const h = updater(snapshot('ready', { latest: '2.2.0' }));
  const store = createStore(h.api); await store.start();
  h.api.quitAndInstall = async () => ({ ok: false, error: 'not ready' });
  assert.equal(await store.run('install'), false); assert.match(store.getView().error, /not ready/);
  assert.equal(store.getView().pending, false); assert.equal(store.getView().actionLabel, '重试安装');
  h.api.quitAndInstall = async () => { throw new Error('IPC unavailable'); };
  assert.equal(await store.run('install'), false); assert.match(store.getView().error, /IPC unavailable/);
  h.api.quitAndInstall = async () => undefined;
  assert.equal(await store.run('install'), false); assert.match(store.getView().error, /未收到操作确认/);
  h.api.quitAndInstall = async () => { h.calls.push('install'); return { ok: true }; };
  assert.equal(await store.run('install'), true);
  assert.equal(await store.run('install'), false);
  assert.equal(store.getView().pending, true); assert.equal(h.calls.filter(call => call === 'install').length, 1);
});

test('settings snapshot failure does not fall through into an installation', async () => {
  const h = updater(snapshot('ready', { latest: '2.2.0' }));
  const store = createStore(h.api); await store.start();
  h.api.status = async () => { throw new Error('offline'); };
  assert.equal(await store.activateFromSettings(), false);
  assert.equal(h.calls.includes('install'), false); assert.match(store.getView().note, /读取更新状态失败/);
});

// Small DOM double for actual controller events. Electron covers layout in the UI suite.
function domHarness() {
  const elements = new Map();
  const target = () => ({ listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); } });
  const doc = Object.assign(target(), { activeElement: null, getElementById: id => elements.get(id) });
  doc.defaultView = Object.assign(target(), { innerWidth: 390, innerHeight: 640 });
  function element(id) {
    const classes = new Set();
    const el = Object.assign(target(), { id, ownerDocument: doc, hidden: false, attrs: {}, style: {}, dataset: {}, textContent: '', innerHTML: '',
      classList: { add: c => classes.add(c), toggle(c, yes) { if (yes) classes.add(c); else classes.delete(c); } },
      setAttribute(key, value) { this.attrs[key] = value; }, focus() { doc.activeElement = this; },
      getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; },
      contains(node) { return this === node || (this.id === 'sidebarUpdatePanel' && node && node.isPanelChild); },
      closest(selector) { return this.selectors?.includes(selector) ? this : null; },
      getBoundingClientRect: () => id === 'btnRelayUpdate' ? { left: 15, top: 600, width: 34, height: 36 } : { height: 240 },
    });
    elements.set(id, el); return el;
  }
  const button = element('btnRelayUpdate'), panel = element('sidebarUpdatePanel'), label = element('relayUpdateLabel');
  for (const id of ['btnSettings', 'btnExplore', 'btnToggleSidebar', 'btnNewChat']) element(id);
  const selectors = new Map();
  panel.querySelector = selector => {
    if (!selectors.has(selector)) { const node = element(selector); node.isPanelChild = true; node.selectors = [selector]; selectors.set(selector, node); }
    return selectors.get(selector);
  };
  return { doc, button, panel, label, selectors, clickButton: () => button.listeners.get('click')(), clickPanel: selector => panel.listeners.get('click')({ target: panel.querySelector(selector) }) };
}

test('controller never auto-opens, keeps later updates accessible, and renders release content as text', async () => {
  const h = updater(snapshot('available', { latest: '2.2.0', dismissed: true, releaseNotes: '<b>untrusted notes</b>' }));
  const dom = domHarness();
  const ui = create({ api: h.api, ...dom }); await ui.start();
  assert.equal(dom.button.hidden, false); assert.equal(dom.panel.hidden, true);
  assert.equal(dom.panel.querySelector('.sidebar-update-notes p').textContent, '<b>untrusted notes</b>');
  assert.equal(dom.panel.innerHTML.includes('untrusted notes'), false);
  dom.clickButton(); assert.equal(dom.panel.hidden, false); assert.equal(dom.button.attrs['aria-expanded'], 'true');
  assert.equal(dom.panel.style.width, '350px'); assert.equal(dom.panel.style.left, '15px');
  dom.clickPanel('[data-update-close]'); assert.equal(dom.panel.hidden, true); assert.equal(dom.button.hidden, false);
  assert.equal(h.calls.includes('dismiss'), false); assert.equal(docHasFocus(dom, dom.button), true);
  h.emit(snapshot('ready', { latest: '2.2.0' })); assert.equal(dom.panel.hidden, true);
  dom.clickButton();
  dom.doc.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(dom.panel.hidden, true); assert.equal(docHasFocus(dom, dom.button), true);
  dom.clickButton(); dom.doc.listeners.get('pointerdown')({ target: {} }); assert.equal(dom.panel.hidden, true);
  dom.clickButton(); h.emit(snapshot('idle')); assert.equal(dom.panel.hidden, true); assert.equal(dom.button.hidden, true);
  assert.equal(dom.doc.activeElement.id, 'btnSettings');
  ui.destroy(); assert.equal(dom.doc.listeners.size, 0);
});

function docHasFocus(dom, element) { return dom.doc.activeElement === element; }

test('update dismissal skips hidden Settings and collapsed navigation when restoring focus', async () => {
  const h = updater(snapshot('available', { latest: '2.2.0' }));
  const dom = domHarness(), ui = create({ api: h.api, ...dom }); await ui.start();
  // The button remains mounted while its navigation wrapper is hidden.
  dom.doc.getElementById('btnSettings').getClientRects = () => [];
  dom.clickButton(); h.emit(snapshot('idle'));
  assert.equal(dom.doc.activeElement.id, 'btnExplore');
  h.emit(snapshot('available', { latest: '2.2.0' })); dom.clickButton();
  dom.doc.getElementById('btnExplore').closest = selector => selector.includes('[inert]') ? {} : null;
  h.emit(snapshot('idle'));
  assert.equal(dom.doc.activeElement.id, 'btnToggleSidebar');
  ui.destroy();
});
