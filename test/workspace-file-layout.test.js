'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Layout = require('../renderer/workspace-file-layout');

function fixture({ size = 1000, preference, preview = true, reduced = false, blockedStorage = false } = {}) {
  const doc = { activeElement: null }, frames = new Map(), timers = new Map(), writes = [], storage = new Map();
  let active = true, frameId = 0, timerId = 0, now = 0, resizeObserver;
  if (preference !== undefined) storage.set(Layout.STORAGE_KEY, typeof preference === 'string' ? preference : JSON.stringify(preference));
  class Target {
    constructor(id) {
      this.id = id; this.listeners = new Map(); this.attrs = new Map(); this.styles = new Map(); this.classes = new Set(); this.inert = false;
      this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name), toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); } };
      this.style = { setProperty: (key, value) => this.styles.set(key, value), getPropertyValue: key => this.styles.get(key) || '' };
    }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
    dispatchEvent(event) { for (const fn of [...this.listeners.get(event.type) || []]) fn(event); }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key); }
    contains(node) { return node === this; }
    focus() { doc.activeElement = this; }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture(id) { if (this.capture === id) this.capture = null; }
  }
  const win = new Target('window'), body = new Target('body'), tree = new Target('tree'), handle = new Target('handle'), toggle = new Target('toggle'), previewNode = new Target('preview');
  body.clientWidth = size; body.querySelector = () => previewNode;
  const media = new Target('media'); media.matches = reduced;
  Object.assign(win, { document: doc, matchMedia: () => media,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout(fn, ms) { timers.set(++timerId, { fn, at: now + ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    ResizeObserver: class { constructor(fn) { this.callback = fn; resizeObserver = this; } observe() {} disconnect() { this.disconnected = true; } },
  });
  const store = { getItem(key) { if (blockedStorage) throw new Error('blocked'); return storage.get(key) || null; }, setItem(key, value) { if (blockedStorage) throw new Error('blocked'); writes.push([key, value]); storage.set(key, value); } };
  const controller = Layout.create({ body, tree, handle, toggle, window: win, storage: store, getActive: () => active });
  controller.sync({ preview, key: 'one' });
  const emit = (target, type, extra = {}) => { const event = { type, target, pointerId: 1, button: 0, isPrimary: true, clientX: 0, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra }; target.dispatchEvent(event); return event; };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { win, body, tree, handle, toggle, previewNode, controller, frames, timers, writes, media, doc, emit, flush,
    state: () => controller.getState(), saved: () => JSON.parse(storage.get(Layout.STORAGE_KEY)),
    down(x = size - controller.getState().width, extra) { emit(handle, 'pointerdown', { clientX: x, ...extra }); },
    move(x, extra) { emit(win, 'pointermove', { clientX: x, ...extra }); flush(); },
    up(x) { emit(win, 'pointerup', { clientX: x }); flush(); },
    key(key, extra) { emit(handle, 'keydown', { key, ...extra }); },
    resize(value) { body.clientWidth = value; resizeObserver.callback(); },
    active(value) { active = value; emit(win, 'relay:workspace-tab'); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    get observer() { return resizeObserver; },
  };
}

test('wide picker keeps the central empty area and an adjustable right directory', () => {
  const f = fixture({ preview: false });
  assert.equal(f.state().width, 230); assert.equal(f.handle.hidden, false); assert.equal(f.toggle.disabled, false);
  assert.equal(f.body.classList.contains('is-file-tree-picker'), false);
  f.down(770); f.move(650); f.up(650);
  assert.deepEqual(f.saved(), { version: 1, width: 350, collapsed: false });
  f.controller.sync({ preview: true, key: 'file' }); assert.equal(f.state().width, 350);
});

test('revealing a linked folder from a narrow picker keeps the tree open after the panel expands', () => {
  const f = fixture({ size: 380, preview: false, preference: { version: 1, width: 230, collapsed: true } });
  assert.equal(f.state().expanded, true);
  assert.equal(f.state().collapsed, true);
  f.controller.show();
  f.resize(1000);
  assert.equal(f.state().collapsed, false);
  assert.equal(f.state().expanded, true);
  assert.equal(f.tree.inert, false);
  assert.equal(f.state().width, 230);
  assert.equal(f.saved().collapsed, false);
});

test('dragging follows every pixel and commits a single width after release', () => {
  const f = fixture(); f.down(770); assert.equal(f.handle.capture, 1);
  for (const x of [769, 730, 603, 500, 240]) { f.move(x); assert.equal(f.state().width, 1000 - x); }
  assert.equal(f.state().preferredWidth, 230); assert.equal(f.writes.length, 0);
  f.up(450); assert.equal(f.state().width, 550); assert.equal(f.writes.length, 1); assert.equal(f.handle.capture, null);
});

test('collapse threshold preserves capture and hysteresis permits reversing the same gesture', () => {
  const f = fixture(); f.down(770);
  f.move(872); assert.equal(f.state().width, 128); assert.equal(f.state().collapsed, false);
  f.move(873); assert.equal(f.state().width, 0); assert.equal(f.state().collapsed, true);
  assert.equal(f.handle.capture, 1); assert.equal(f.handle.hidden, false); assert.equal(f.tree.inert, true);
  assert.equal(f.body.classList.contains('is-file-tree-snapping'), true);
  for (const x of [900, 873, 872, 850, 841]) { f.move(x); assert.equal(f.state().width, 0); }
  f.move(840); assert.equal(f.state().width, 160); assert.equal(f.tree.inert, false);
  f.move(873); f.up(900); assert.equal(f.handle.hidden, true);
  assert.deepEqual(f.saved(), { version: 1, width: 230, collapsed: true });
  f.controller.toggle(); assert.equal(f.state().width, 230); assert.equal(f.tree.inert, false);
});

test('width and collapse survive remount and reading other files', () => {
  const f = fixture(); f.down(770); f.up(630); f.controller.toggle();
  f.controller.sync({ preview: true, key: 'two' }); assert.equal(f.state().width, 0); assert.equal(f.state().preferredWidth, 370);
  const restored = fixture({ preference: f.saved() });
  assert.equal(restored.state().width, 0); assert.equal(restored.state().collapsed, true);
  restored.controller.toggle(); assert.equal(restored.state().width, 370);
  assert.equal(restored.writes.length, 1);
});

test('Escape, pointer cancel, blur and lost capture restore the whole gesture snapshot', () => {
  for (const kind of ['keydown', 'pointercancel', 'blur', 'lostpointercapture']) {
    const f = fixture({ preference: { version: 1, width: 380, collapsed: false } }); const original = f.state();
    f.down(620); f.move(873); assert.equal(f.state().collapsed, true);
    f.emit(kind === 'lostpointercapture' ? f.handle : f.win, kind, { key: 'Escape' });
    assert.deepEqual(f.state(), original, kind); assert.equal(f.writes.length, 0); assert.equal(f.handle.capture, null);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  }
});

test('pointerup uses the release location even without a painted move frame', () => {
  const f = fixture(); f.down(770); f.emit(f.win, 'pointermove', { clientX: 900 });
  f.up(600); assert.equal(f.state().width, 400); assert.equal(f.saved().collapsed, false); assert.equal(f.frames.size, 0);
});

test('keyboard resize has fine and coarse steps, limits, reset and a reversible collapse', () => {
  const f = fixture(); f.key('ArrowLeft'); assert.equal(f.state().width, 238);
  f.key('ArrowLeft', { shiftKey: true }); assert.equal(f.state().width, 270);
  f.key('End'); assert.equal(f.state().width, 760); f.key('Home'); assert.equal(f.state().width, 160);
  f.handle.focus();
  f.key('ArrowRight'); assert.equal(f.state().collapsed, true); assert.equal(f.tree.inert, true);
  assert.equal(f.doc.activeElement, f.toggle);
  f.emit(f.toggle, 'click'); assert.equal(f.state().width, 160);
  f.key('Enter'); assert.equal(f.state().width, 230);
  f.key('End'); f.emit(f.handle, 'dblclick'); assert.equal(f.state().width, 230);
});

test('narrow preview uses a temporary closed drawer without overwriting wide preferences', () => {
  const f = fixture({ preference: { version: 1, width: 350, collapsed: false } });
  f.resize(380); assert.equal(f.state().width, 0); assert.equal(f.state().collapsed, false); assert.equal(f.writes.length, 0);
  f.controller.toggle(); assert.equal(f.state().width, 350); assert.equal(f.previewNode.inert, true);
  f.down(30); f.move(100); f.up(100); assert.equal(f.state().preferredWidth, 280);
  f.controller.sync({ preview: true, key: 'another' }); assert.equal(f.state().width, 280); assert.equal(f.state().collapsed, false);
  f.resize(1000); assert.equal(f.state().width, 280); assert.equal(f.previewNode.inert, false);
});

test('narrow picker remains usable without erasing a saved collapse or writing temporary widths', () => {
  const f = fixture({ size: 380, preview: false, preference: { version: 1, width: 350, collapsed: true } });
  assert.equal(f.state().width, 380); assert.equal(f.tree.inert, false); assert.equal(f.handle.hidden, true); assert.equal(f.toggle.disabled, true);
  f.controller.toggle(); assert.equal(f.writes.length, 0);
  f.controller.sync({ preview: true }); assert.equal(f.state().width, 0);
  f.resize(1000); assert.equal(f.state().width, 0); assert.equal(f.state().preferredWidth, 350);
  assert.equal(f.writes.length, 0);
});

test('viewport clamps are temporary and resize cancels captured changes', () => {
  const f = fixture({ preference: { version: 1, width: 700, collapsed: false } });
  f.resize(650); assert.equal(f.state().width, 410); assert.equal(f.state().preferredWidth, 700);
  f.down(240); f.move(350); f.resize(600); assert.equal(f.state().dragging, false); assert.equal(f.handle.capture, null);
  assert.equal(f.state().preferredWidth, 700); assert.equal(f.writes.length, 0);
  f.resize(1200); assert.equal(f.state().width, 700);
});

test('switching tools or files cancels pending gestures and disables hidden controls', () => {
  for (const action of ['inactive', 'file']) {
    const f = fixture(); f.down(770); f.move(900);
    if (action === 'inactive') f.active(false); else f.controller.sync({ preview: true, key: 'other' });
    assert.equal(f.state().dragging, false); assert.equal(f.state().preferredWidth, 230); assert.equal(f.state().collapsed, false);
    assert.equal(f.writes.length, 0);
    if (action === 'inactive') { assert.equal(f.handle.hidden, true); assert.equal(f.tree.inert, true); f.active(true); assert.equal(f.handle.hidden, false); }
  }
});

test('non-primary pointers cannot start or interfere with a directory drag', () => {
  const f = fixture(); f.down(770, { button: 2 }); assert.equal(f.state().dragging, false);
  f.down(770, { isPrimary: false }); assert.equal(f.state().dragging, false);
  f.down(770); f.move(100, { pointerId: 2 }); assert.equal(f.state().width, 230);
  f.emit(f.win, 'pointercancel', { pointerId: 2 }); assert.equal(f.state().dragging, true);
  f.emit(f.win, 'pointercancel'); assert.equal(f.state().dragging, false);
});

test('animation cleans up on completion and destruction, while reduced motion skips it', () => {
  const f = fixture(); f.controller.toggle(); assert.equal(f.timers.size, 1);
  f.emit(f.body, 'transitionend', { propertyName: 'grid-template-columns' }); assert.equal(f.timers.size, 0);
  f.controller.toggle(); f.advance(274); assert.equal(f.timers.size, 0);
  f.down(770); f.move(900); f.controller.destroy();
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.observer.disconnected, true);
  const reduced = fixture({ reduced: true }); reduced.controller.toggle(); assert.equal(reduced.timers.size, 0);
  assert.equal(reduced.body.classList.contains('is-file-tree-snapping'), false);
});

test('invalid preferences and blocked storage do not prevent directory controls', () => {
  for (const preference of ['broken', { version: 1, width: 3, collapsed: true }, { version: 2, width: 300, collapsed: true }]) {
    const f = fixture({ preference }); assert.equal(f.state().width, 230);
  }
  const f = fixture({ blockedStorage: true }); assert.doesNotThrow(() => { f.key('ArrowLeft'); f.controller.toggle(); f.controller.toggle(); });
});

test('HTML loads the independent file layout after panel CSS and before panel behavior', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('href="workspace-file-layout.css"') > html.indexOf('href="workspace-panel.css"'));
  assert.ok(html.indexOf('src="workspace-file-layout.js"') < html.indexOf('src="workspace-panel.js"'));
  assert.equal((html.match(/id="workspaceTreeResizeHandle"/g) || []).length, 1);
});
