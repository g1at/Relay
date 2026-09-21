'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const layout = require('../renderer/sidebar-layout');

function target() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(candidate => candidate !== fn)); },
    dispatchEvent(event) { for (const fn of [...listeners.get(event.type) || []]) fn(event); },
  };
}
function classes() {
  const state = new Set();
  return { add: (...values) => values.forEach(value => state.add(value)), remove: (...values) => values.forEach(value => state.delete(value)), contains: value => state.has(value), toggle(value, on = !state.has(value)) { if (on) state.add(value); else state.delete(value); } };
}
function harness({ width = 1200, stored = null, storedState = null, unavailableStorage = false } = {}) {
  const records = [], values = new Map(), frames = new Map(), props = {}, attrs = {}, sidebarAttrs = {};
  if (stored != null) values.set(layout.STORAGE_KEY, String(stored));
  if (storedState != null) values.set(layout.STATE_KEY, typeof storedState === 'string' ? storedState : JSON.stringify(storedState));
  let frameId = 0, capture = null;
  const store = { getItem(key) { if (unavailableStorage) throw new Error('disabled'); return values.get(key) || null; }, setItem(key, value) { if (unavailableStorage) throw new Error('disabled'); values.set(key, value); records.push({ key, value }); } };
  const buttonAttrs = {};
  const button = { setAttribute(key, value) { buttonAttrs[key] = value; } };
  const win = Object.assign(target(), { innerWidth: width, document: { querySelectorAll: () => [button] }, matchMedia: () => ({ matches: win.innerWidth <= 760 }), requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id), CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  const app = { clientWidth: width, classList: classes(), style: { setProperty(key, value) { props[key] = value; }, getPropertyValue(key) { return props[key] || ''; } } };
  const sidebar = { id: 'sidebarNavigation', children: [{ textContent: 'retained history' }], setAttribute(key, value) { sidebarAttrs[key] = value; }, getBoundingClientRect: () => ({ width: Number.parseFloat(props['--sidebar-visible-width']) || 0 }) };
  const handle = Object.assign(target(), { setAttribute(key, value) { attrs[key] = value; }, focus() {}, setPointerCapture(id) { capture = id; }, hasPointerCapture: id => capture === id, releasePointerCapture(id) { if (capture === id) capture = null; } });
  const controller = layout.create({ app, sidebar, handle, window: win, storage: store });
  const event = (type, extra = {}) => ({ type, pointerId: 1, button: 0, isPrimary: true, clientX: 224, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra });
  return { win, app, sidebar, handle, controller, records, values, frames, attrs, sidebarAttrs, button, buttonAttrs, props,
    get capture() { return capture; },
    get savedState() { return JSON.parse(values.get(layout.STATE_KEY)); },
    send(on, type, extra) { const e = event(type, extra); on.dispatchEvent(e); return e; },
    flush() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    resize(value) { win.innerWidth = app.clientWidth = value; win.dispatchEvent({ type: 'resize' }); },
  };
}

test('sidebar maximum follows the viewport and leaves the main page 480 pixels', () => {
  assert.deepEqual(layout.boundsForWidth(1200), { min: 176, max: 720 });
  assert.deepEqual(layout.boundsForWidth(1920), { min: 176, max: 1440 });
  assert.deepEqual(layout.boundsForWidth(820), { min: 176, max: 340 });
  assert.deepEqual(layout.boundsForWidth(761), { min: 176, max: 281 });
  assert.equal(layout.normalizePreference(720), 720);
  for (const value of [null, '', 'invalid', Infinity, -1, 1e30]) assert.equal(layout.normalizePreference(value), 224);
});

test('an open right panel reserves its width while preserving the saved left width', () => {
  const h = harness({ width: 1200, stored: 640 });
  h.app.style.setProperty('--workspace-visible-width', '380px');
  h.send(h.win, 'relay:workspace-layout');
  assert.equal(h.controller.getState().width, 460);
  assert.equal(h.controller.getState().preferredWidth, 640);
  assert.equal(h.records.length, 0);
  h.app.style.setProperty('--workspace-visible-width', '0px');
  h.send(h.win, 'relay:workspace-layout');
  assert.equal(h.controller.getState().width, 640);
});

test('right-pane compression can use less than the manual minimum and restore without persistence', () => {
  const h = harness({ stored: 400 });
  for (const remaining of [700, 560, 537, 536, 535, 520, 400, 360, 200, 0, 200, 360, 520, 535, 536, 537, 560, 700]) {
    h.app.style.setProperty('--workspace-visible-width', `${1200 - remaining}px`);
    h.send(h.win, 'relay:workspace-layout');
    assert.equal(h.controller.getState().width, Math.min(400, Math.max(0, remaining - 360)));
    const constrained = remaining - 360 <= 176;
    assert.equal(h.controller.getState().constrained, constrained);
    assert.equal(h.app.classList.contains('sidebar-constrained'), constrained);
    assert.equal(h.sidebar.inert, constrained); assert.equal(h.button.disabled, constrained);
    assert.equal(h.controller.getState().expanded, true); assert.equal(h.controller.getState().preferredWidth, 400);
    if (constrained) { h.controller.toggle(); h.send(h.handle, 'pointerdown'); assert.equal(h.controller.getState().dragging, false); }
    assert.equal(h.records.length, 0);
  }
  h.app.style.setProperty('--workspace-visible-width', '0px'); h.send(h.win, 'relay:workspace-layout');
  assert.equal(h.controller.getState().width, 400); assert.equal(h.sidebar.inert, false);
  assert.equal(h.buttonAttrs['aria-disabled'], 'false'); assert.equal(h.records.length, 0);
});

test('temporary compression preserves a manually collapsed sidebar across viewport and workspace changes', () => {
  const h = harness({ storedState: { version: 2, width: 500, collapsed: true } });
  for (const right of [380, 800, 1200, 800, 380, 0]) {
    h.app.style.setProperty('--workspace-visible-width', `${right}px`); h.send(h.win, 'relay:workspace-layout');
    assert.equal(h.controller.getState().width, 0); assert.equal(h.controller.getState().collapsed, true);
    assert.equal(h.sidebar.inert, true); assert.equal(h.records.length, 0);
  }
  h.controller.toggle(); assert.equal(h.controller.getState().width, 500);
});

test('a right-pane squeeze cancels a pending left gesture without persisting its preview', () => {
  const h = harness({ stored: 300 }); h.send(h.handle, 'pointerdown', { clientX: 300 });
  h.send(h.win, 'pointermove', { clientX: 400 }); h.flush();
  h.app.style.setProperty('--workspace-visible-width', '900px'); h.send(h.win, 'relay:workspace-layout');
  assert.equal(h.controller.getState().dragging, false); assert.equal(h.capture, null);
  assert.equal(h.controller.getState().preferredWidth, 300); assert.equal(h.controller.getState().width, 0);
  assert.equal(h.records.length, 0);
});

test('mount restores the old width without writing or replacing the history DOM', () => {
  const h = harness({ stored: 352 }); const history = h.sidebar.children[0];
  assert.equal(h.props['--sidebar-visible-width'], '352px'); assert.equal(h.attrs['aria-valuenow'], '352');
  assert.equal(layout.create({ app: h.app, sidebar: h.sidebar, handle: h.handle, window: h.win }), h.controller);
  assert.equal(h.records.length, 0); assert.equal(h.sidebar.children[0], history);
});

test('v2 persists the collapsed state and restores the last width on expansion', () => {
  const h = harness({ stored: 352 }); h.controller.toggle();
  assert.equal(h.controller.getState().width, 0); assert.equal(h.props['--sidebar-visible-width'], '0px');
  assert.deepEqual(h.savedState, { version: 2, width: 352, collapsed: true });
  assert.equal(h.values.get(layout.STORAGE_KEY), '352');
  const restored = harness({ stored: 224, storedState: h.savedState });
  assert.equal(restored.controller.getState().width, 0); assert.equal(restored.controller.getState().preferredWidth, 352);
  restored.controller.toggle(); assert.equal(restored.controller.getState().width, 352);
  assert.deepEqual(restored.savedState, { version: 2, width: 352, collapsed: false });
});

test('corrupt or unsupported state falls back to the legacy width', () => {
  for (const state of ['{broken', { version: 1, width: 520, collapsed: true }, { version: 2, width: -1, collapsed: true }, { version: 2, width: 400, collapsed: 'false' }]) {
    const h = harness({ stored: 360, storedState: state });
    assert.equal(h.controller.getState().width, 360); assert.equal(h.controller.getState().expanded, true);
  }
});

test('pointer dragging batches updates, keeps the saved preference, and commits release once', () => {
  const h = harness(); h.send(h.handle, 'pointerdown'); assert.equal(h.capture, 1);
  h.send(h.win, 'pointermove', { clientX: 300 }); h.send(h.win, 'pointermove', { clientX: 350 });
  assert.equal(h.frames.size, 1); h.flush(); assert.equal(h.controller.getState().width, 350);
  assert.equal(h.controller.getState().preferredWidth, 224); assert.equal(h.records.length, 0);
  h.send(h.win, 'pointerup', { clientX: 568 });
  assert.equal(h.controller.getState().width, 568); assert.equal(h.capture, null);
  assert.equal(h.records.filter(record => record.key === layout.STATE_KEY).length, 1);
  assert.deepEqual(h.savedState, { version: 2, width: 568, collapsed: false });
  assert.equal(h.app.classList.contains('is-sidebar-resizing'), false);
});

test('drag width follows every preview pixel below the normal minimum then settles on release', () => {
  const h = harness({ stored: 400 }); h.send(h.handle, 'pointerdown', { clientX: 400 });
  for (const x of [399, 330, 210, 190, 176, 166, 150, 144]) {
    h.send(h.win, 'pointermove', { clientX: x }); h.flush();
    assert.equal(h.controller.getState().width, x); assert.equal(h.controller.getState().expanded, true);
    assert.equal(h.app.classList.contains('is-sidebar-snapping'), false);
  }
  h.send(h.win, 'pointerup', { clientX: 160 });
  assert.equal(h.controller.getState().width, 176); assert.equal(h.savedState.width, 176);
});

test('crossing the threshold collapses with capture retained and hysteresis prevents flicker', () => {
  const h = harness({ stored: 400 }); h.send(h.handle, 'pointerdown', { clientX: 400 });
  h.send(h.win, 'pointermove', { clientX: 143 }); h.flush();
  assert.equal(h.controller.getState().width, 0); assert.equal(h.capture, 1); assert.equal(h.handle.hidden, false);
  assert.equal(h.app.classList.contains('is-sidebar-snapping'), true); assert.equal(h.sidebar.inert, true);
  for (const x of [140, 144, 145, 160, 175]) {
    h.send(h.win, 'pointermove', { clientX: x }); h.flush(); assert.equal(h.controller.getState().width, 0);
  }
  h.send(h.win, 'pointermove', { clientX: 176 }); h.flush();
  assert.equal(h.controller.getState().width, 176); assert.equal(h.app.classList.contains('is-sidebar-snapping'), false);
  h.send(h.win, 'pointermove', { clientX: 143 }); h.flush(); h.send(h.win, 'pointerup', { clientX: 100 });
  assert.equal(h.handle.hidden, true); assert.equal(h.capture, null); assert.deepEqual(h.savedState, { version: 2, width: 400, collapsed: true });
  h.controller.toggle(); assert.equal(h.controller.getState().width, 400);
});

test('release location wins even if its preceding collapsed preview was not painted', () => {
  const h = harness(); h.send(h.handle, 'pointerdown'); h.send(h.win, 'pointermove', { clientX: 100 });
  h.send(h.win, 'pointerup', { clientX: 500 });
  assert.equal(h.controller.getState().width, 500); assert.equal(h.frames.size, 0); assert.equal(h.savedState.collapsed, false);
});

test('unrelated pointers and non-primary buttons cannot start or control a drag', () => {
  const h = harness(); h.send(h.handle, 'pointerdown', { button: 2 }); assert.equal(h.controller.getState().dragging, false);
  h.send(h.handle, 'pointerdown', { isPrimary: false }); assert.equal(h.controller.getState().dragging, false);
  h.send(h.handle, 'pointerdown'); h.send(h.win, 'pointermove', { pointerId: 9, clientX: 100 }); h.flush();
  assert.equal(h.controller.getState().width, 224); h.send(h.win, 'pointercancel');
});

test('cancel, lost capture, Escape and blur undo even a threshold-triggered collapse', () => {
  for (const kind of ['pointercancel', 'lostpointercapture', 'keydown', 'blur']) {
    const h = harness({ stored: 300 }); h.send(h.handle, 'pointerdown', { clientX: 300 }); h.send(h.win, 'pointermove', { clientX: 100 }); h.flush();
    assert.equal(h.controller.getState().width, 0);
    h.send(kind === 'lostpointercapture' ? h.handle : h.win, kind, { key: 'Escape' });
    assert.equal(h.controller.getState().width, 300, kind); assert.equal(h.controller.getState().dragging, false, kind);
    assert.equal(h.controller.getState().expanded, true, kind); assert.equal(h.records.length, 0, kind);
    assert.equal(h.frames.size, 0, kind); assert.equal(h.sidebar.inert, false, kind);
  }
});

test('keyboard supports fine/coarse changes, viewport maximum, minimum and reset', () => {
  const h = harness(); h.send(h.handle, 'keydown', { key: 'ArrowRight' }); assert.equal(h.controller.getState().width, 232);
  h.send(h.handle, 'keydown', { key: 'ArrowRight', shiftKey: true }); assert.equal(h.controller.getState().width, 264);
  h.send(h.handle, 'keydown', { key: 'Home' }); assert.equal(h.controller.getState().width, 176);
  h.send(h.handle, 'keydown', { key: 'ArrowLeft' }); assert.equal(h.controller.getState().width, 176);
  h.send(h.handle, 'keydown', { key: 'End' }); assert.equal(h.controller.getState().width, 720);
  h.send(h.handle, 'keydown', { key: 'Enter' }); assert.equal(h.controller.getState().width, 224);
  h.send(h.handle, 'keydown', { key: 'End' }); h.send(h.handle, 'dblclick'); assert.equal(h.controller.getState().width, 224);
});

test('viewport clamping and temporary narrow expansion preserve desktop preference', () => {
  const h = harness({ stored: 500 }); h.resize(820);
  assert.equal(h.controller.getState().width, 340); assert.equal(h.controller.getState().preferredWidth, 500);
  h.resize(640); assert.equal(h.controller.getState().width, 0); assert.equal(h.handle.hidden, true); assert.equal(h.handle.tabIndex, -1);
  h.controller.toggle(); assert.equal(h.app.classList.contains('sidebar-mobile-open'), true); assert.equal(h.controller.getState().width, 500);
  h.send(h.handle, 'keydown', { key: 'End' }); assert.equal(h.controller.getState().preferredWidth, 500);
  h.resize(1200); assert.equal(h.controller.getState().width, 500); assert.equal(h.app.classList.contains('sidebar-mobile-open'), false);
  assert.equal(h.handle.hidden, false); assert.equal(h.records.length, 0);
});

test('narrow navigation cannot overwrite a saved desktop collapse', () => {
  const h = harness({ storedState: { version: 2, width: 500, collapsed: true } }); h.resize(520);
  h.controller.toggle(); assert.equal(h.controller.getState().width, 472); assert.equal(h.controller.getState().preferredWidth, 500);
  h.app.classList.remove('sidebar-mobile-open'); h.controller.sync(); assert.equal(h.controller.getState().width, 0);
  h.resize(1200); assert.equal(h.controller.getState().width, 0); assert.equal(h.records.length, 0);
  h.controller.toggle(); assert.equal(h.controller.getState().width, 500);
});

test('a resize during dragging cancels the gesture without saving its temporary width', () => {
  const h = harness({ stored: 300 }); h.send(h.handle, 'pointerdown', { clientX: 300 }); h.send(h.win, 'pointermove', { clientX: 430 }); h.flush();
  h.resize(600); assert.equal(h.controller.getState().dragging, false); assert.equal(h.capture, null); assert.equal(h.records.length, 0);
  h.resize(1200); assert.equal(h.controller.getState().width, 300);
});

test('hidden navigation is inert while the persistent topbar toggle exposes its state', () => {
  const h = harness(); h.controller.toggle();
  assert.equal(h.handle.hidden, true); assert.equal(h.buttonAttrs['aria-expanded'], 'false'); assert.equal(h.buttonAttrs['aria-label'], '展开侧边栏');
  assert.equal(h.sidebarAttrs['aria-hidden'], 'true'); assert.equal(h.sidebar.inert, true);
  h.controller.toggle(); assert.equal(h.buttonAttrs['aria-controls'], 'sidebarNavigation'); assert.equal(h.sidebar.inert, false);
});

test('blocked storage cannot break resize, collapse, expansion or reset', () => {
  const h = harness({ unavailableStorage: true }); h.send(h.handle, 'keydown', { key: 'ArrowRight' });
  assert.equal(h.controller.getState().width, 232); assert.doesNotThrow(() => { h.controller.toggle(); h.controller.toggle(); h.controller.reset(); });
});

test('one global titlebar toggle replaces page-level duplicates and keeps renderer hooks', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.doesNotMatch(html, /btnSidebarCollapse/);
  assert.equal((html.match(/data-toggle-sidebar/g) || []).length, 1);
  for (const page of html.match(/<main\b[\s\S]*?<\/main>/g)) assert.doesNotMatch(page, /data-toggle-sidebar/);
  assert.equal((html.match(/id="sidebarResizeHandle"/g) || []).length, 1);
  assert.match(html, /src="sidebar-layout\.js"/);
});


test('workspace-driven sizing reuses its viewport snapshot and emits no sidebar echo', () => {
  const h = harness({ width: 1200, stored: 640 });
  let notifications = 0;
  h.win.addEventListener('relay:sidebar-changed', () => notifications++);
  h.app.style.setProperty('--workspace-visible-width', '380px');
  Object.defineProperty(h.app, 'clientWidth', { get() { throw new Error('layout measurement after workspace writes'); } });
  h.send(h.win, 'relay:workspace-layout', { detail: { viewportWidth: 1200 } });
  assert.equal(h.props['--sidebar-visible-width'], '460px');
  assert.equal(h.controller.getState({ viewportWidth: 1200 }).width, 460);
  assert.equal(notifications, 0);
});

test('workspace compression cancels a left drag without echoing a layout notification', () => {
  const h = harness({ stored: 300 }); h.send(h.handle, 'pointerdown', { clientX: 300 });
  h.send(h.win, 'pointermove', { clientX: 350 }); h.flush();
  let notifications = 0; h.win.addEventListener('relay:sidebar-changed', () => notifications++);
  h.app.style.setProperty('--workspace-visible-width', '900px');
  h.send(h.win, 'relay:workspace-layout', { detail: { viewportWidth: 1200 } });
  assert.equal(h.controller.getState().dragging, false); assert.equal(h.capture, null);
  assert.equal(notifications, 0); assert.equal(h.records.length, 0);
});
