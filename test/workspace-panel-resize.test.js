'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const sidebarLayout = require('../renderer/sidebar-layout');

// Execute the production sizing/gesture functions with a DOM geometry double.
// Native layout, caption separation and hit testing are covered by the UI smoke.
function fixture({ savedWidth = null, reducedMotion = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
  const sizing = source.slice(source.indexOf('  const MIN_WIDTH ='), source.indexOf('  const tabs ='));
  const maximize = source.slice(source.indexOf('  function setMaximized('), source.indexOf('  function syncFileLayout('));
  const viewHandler = source.split('\n').find(line => line.includes("window.addEventListener('relay:view-changed'"));
  const resizeHandler = source.split('\n').find(line => line.includes("window.addEventListener('resize', () => { endDrag(false)"));
  class Target {
    constructor(id) { this.id = id; this.dataset = {}; this.listeners = new Map(); this.attributes = new Map(); this.inert = false; this.hidden = false; this.classes = new Set(); this.values = new Map();
      this.classList = { contains: value => this.classes.has(value), add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), toggle: (value, force) => { const set = force === undefined ? !this.classes.has(value) : force; if (set) this.classes.add(value); else this.classes.delete(value); return set; } };
      this.style = { setProperty: (key, value) => this.values.set(key, value), getPropertyValue: key => this.values.get(key) || '' };
    }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
    dispatchEvent(event) { for (const callback of this.listeners.get(event.type) || []) callback(event); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    replaceChildren() {}
    querySelector() { return null; }
    contains(node) { return this === node; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; }
  }
  const app = new Target('app'), panel = new Target('workspacePanel'), handle = new Target('workspaceResizeHandle'), toggle = new Target('toggle');
  const sidebar = new Target('sidebarNavigation'), chat = new Target('chat'), maximizeButton = new Target('workspaceMaximize');
  const previewBody = new Target('workspacePreviewBody');
  const leftHandle = new Target('sidebarResizeHandle'), leftToggle = new Target('sidebarToggle');
  chat.classList.add('chat');
  let viewportWidth = 1200, geometryReads = 0, workspaceEvents = 0, sidebarEvents = 0;
  Object.defineProperty(app, 'clientWidth', { get() { geometryReads++; return viewportWidth; }, set(value) { viewportWidth = value; } });
  app.children = [sidebar, chat, panel, handle];
  const reserved = () => parseFloat(app.style.getPropertyValue('--workspace-visible-width')) || 0;
  const actual = () => parseFloat(app.style.getPropertyValue('--workspace-panel-width')) || 0;
  app.getBoundingClientRect = () => ({ left: 0, right: app.clientWidth });
  const sidebarWidth = () => parseFloat(app.style.getPropertyValue('--sidebar-visible-width')) || 0;
  sidebar.getBoundingClientRect = () => ({ left: 0, right: sidebarWidth(), width: sidebarWidth() });
  chat.getBoundingClientRect = () => ({ left: window.innerWidth <= 760 ? 0 : sidebarWidth(), right: app.clientWidth - reserved() });
  Object.defineProperty(panel, 'clientWidth', { get: actual });
  const document = { activeElement: null, querySelectorAll: () => [leftToggle] }, window = new Target('window'); window.innerWidth = 1200;
  let frameId = 0, timerId = 0, now = 0;
  const frames = new Map(), timers = new Map(), writes = new Map(), saved = new Map();
  if (savedWidth != null) saved.set('relay.workspace-panel.width.v1', String(savedWidth));
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); writes.set(key, value); } };
  const requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame = id => frames.delete(id);
  const setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: now + delay }); return timerId; }, clearTimeout = id => timers.delete(id);
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  Object.assign(window, { document, localStorage: storage, requestAnimationFrame, cancelAnimationFrame, CustomEvent,
    matchMedia: query => ({ matches: query.includes('prefers-reduced-motion') ? reducedMotion : window.innerWidth <= 760 }) });
  window.relaySidebarLayout = sidebarLayout.create({ app, sidebar, handle: leftHandle, window, storage });
  const context = vm.createContext({ app, panel, handle, toggle, document, window, bridge: null,
    $: id => id === 'workspaceMaximize' ? maximizeButton : id === 'workspacePreviewBody' ? previewBody : null, icon: () => ({}),
    localStorage: storage, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout,
    fitTerminal() {}, scheduleNative() {}, syncNative() {}, syncInternalPages() {}, disposeHtmlPreview() {}, dispatchTab() {}, CustomEvent,
  });
  vm.runInContext(sizing + '\nconst priorInert = new Map(); let navigationRevision = 0; function closeMenus() {}\n' + maximize + '\n' + viewHandler + '\n' + resizeHandler + `
    globalThis.control = { layout, setMaximized, maxWidth, open(){opened=true;layout()},
      get(){return {width,preferredWidth,maximized,automaticMaximized,restoreWidth,dragging:!!drag,opened,tab}},
      close(){endDrag(false);opened=false;setMaximized(false,{preservePreference:true});layout()} };`, context);
  window.addEventListener('relay:sidebar-changed', event => { sidebarEvents++; context.control.layout(event.detail); });
  window.addEventListener('relay:workspace-layout', () => { workspaceEvents++; });
  const emit = (target, type, values = {}) => target.dispatchEvent({ type, preventDefault() {}, stopImmediatePropagation() {}, pointerId: 1, button: 0, isPrimary: true, ...values });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  return { control: context.control, app, panel, handle, sidebar, chat, maximizeButton, writes, reserved, actual, flush, leftToggle, timers,
    left: window.relaySidebarLayout, sidebarWidth,
    resetMeasurements() { geometryReads = workspaceEvents = sidebarEvents = 0; },
    measurements() { return { geometryReads, workspaceEvents, sidebarEvents }; },
    down: x => emit(handle, 'pointerdown', { clientX: x }), move: x => { emit(window, 'pointermove', { clientX: x }); flush(); },
    up: x => { emit(window, 'pointerup', { clientX: x }); flush(); }, cancel: () => emit(window, 'pointercancel'),
    key: key => emit(handle, 'keydown', { key }),
    event: (type, values) => emit(window, type, values),
    transition(type = 'transitionend', propertyName = 'grid-template-columns') { emit(app, type, { target: app, propertyName }); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    viewport(width) { app.clientWidth = window.innerWidth = width; emit(window, 'resize'); context.control.layout(); },
    view(name) { app.dataset.view = name; emit(window, 'relay:view-changed'); flush(); },
    collapseSidebar() { window.relaySidebarLayout.toggle(); },
  };
}

test('width tracks the pointer until the chat boundary then snaps to the full content area', () => {
  const f = fixture(); f.control.open(); const start = f.actual();
  f.down(1200 - start);
  for (const x of [720, 610, 513, 391, 207, 81, 0]) {
    f.move(x); const remaining = x <= 280 ? 0 : x; assert.equal(f.actual(), 1200 - remaining);
    assert.equal(f.reserved(), f.actual(), 'the grid reserves every pixel occupied by the right pane');
    const expectedLeft = Math.min(224, Math.max(0, remaining - 360));
    assert.equal(f.sidebarWidth(), expectedLeft);
    const main = f.chat.getBoundingClientRect();
    assert.equal(main.left, expectedLeft); assert.equal(main.right, remaining);
    assert.equal(expectedLeft + (main.right - main.left) + f.actual(), 1200);
    assert.equal(f.left.getState().preferredWidth, 224);
    assert.equal(f.left.getState().collapsed, false);
  }
  f.up(0); assert.equal(f.control.get().maximized, true); assert.equal(f.handle.hidden, false);
  assert.equal(f.maximizeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(f.sidebar.inert, true); assert.equal(f.chat.inert, true);
  assert.equal(f.writes.size, 1); assert.equal(f.writes.get('relay.workspace-panel.width.v1'), '380');
});

test('full width retains pointer capture until the reverse drag restores readable space', () => {
  const f = fixture(); f.control.open(); f.control.setMaximized(true);
  f.down(0); f.move(277); assert.equal(f.actual(), 1200); assert.equal(f.control.get().maximized, true); assert.equal(f.handle.captured, 1);
  f.move(319); assert.equal(f.actual(), 1200);
  f.move(320); assert.equal(f.actual(), 880); assert.equal(f.control.get().maximized, false);
  f.move(800); f.up(800); assert.equal(f.actual(), 400);
  assert.equal(f.sidebar.inert, false); assert.equal(f.chat.inert, false);
  assert.equal(f.maximizeButton.getAttribute('aria-pressed'), 'false');
});

test('dragging right previews below minimum then collapses without losing capture or the usable width', () => {
  const f = fixture({ savedWidth: 300 }); f.control.open(); f.down(900);
  f.move(920); assert.equal(f.actual(), 280); assert.equal(f.control.get().opened, true);
  f.move(960); assert.equal(f.actual(), 240);
  f.move(961); assert.equal(f.actual(), 0); assert.equal(f.control.get().opened, false);
  assert.equal(f.handle.captured, 1); assert.equal(f.handle.hidden, false); assert.equal(f.panel.inert, true);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  f.up(1000); assert.equal(f.handle.hidden, true); assert.equal(f.handle.captured, null);
  assert.equal(f.control.get().preferredWidth, 300);
  assert.equal(f.writes.get('relay.workspace-panel.width.v1'), '300');
  f.control.open(); assert.equal(f.actual(), 300); assert.equal(f.panel.inert, false);
});

test('one gesture can collapse and reopen with hysteresis before committing', () => {
  const f = fixture(); f.control.open(); f.down(820); f.move(961);
  for (const x of [959, 941, 930, 901]) { f.move(x); assert.equal(f.control.get().opened, false); }
  f.move(900); assert.equal(f.actual(), 300); assert.equal(f.control.get().opened, true);
  f.move(800); f.up(800); assert.equal(f.actual(), 400); assert.equal(f.handle.hidden, false);
});

test('canceling a collapsed drag restores original open state and width without saving', () => {
  for (const event of ['pointercancel', 'blur', 'keydown']) {
    const f = fixture(); f.control.open(); f.down(820); f.move(1000);
    assert.equal(f.control.get().opened, false);
    f.event(event, { key: 'Escape' });
    assert.equal(f.actual(), 380); assert.equal(f.control.get().opened, true);
    assert.equal(f.handle.hidden, false); assert.equal(f.handle.captured, null); assert.equal(f.writes.size, 0);
  }
});

test('releasing before the collapse threshold restores the minimum usable size', () => {
  const f = fixture(); f.control.open(); f.down(820); f.move(950);
  assert.equal(f.actual(), 250); f.up(950);
  assert.equal(f.actual(), 300); assert.equal(f.control.get().opened, true);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
});

test('small columns hide their entire content without changing the left collapse preference', () => {
  const f = fixture(); f.control.open(); f.down(820);
  for (const x of [537, 536, 535, 536, 537]) {
    f.move(x); assert.equal(f.sidebarWidth(), x - 360); assert.equal(f.sidebar.inert, x <= 536);
    assert.equal(f.leftToggle.disabled, x <= 536);
  }
  f.move(535); assert.equal(f.sidebarWidth(), 175); assert.equal(f.sidebar.inert, true);
  assert.equal(f.app.classList.contains('sidebar-constrained'), true); assert.equal(f.leftToggle.disabled, true);
  assert.equal(f.chat.inert, false); assert.equal(f.left.getState().expanded, true);
  f.left.toggle(); assert.equal(f.left.getState().expanded, true); assert.equal(f.writes.size, 0);
  for (const [x, full] of [[281, false], [280, true], [279, true], [280, true], [281, true], [319, true], [320, false], [281, false], [280, true]]) {
    f.move(x); assert.equal(f.control.get().maximized, full);
    assert.equal(f.chat.inert, full);
    assert.equal(f.app.classList.contains('workspace-chat-constrained'), full);
    assert.equal(f.app.style.getPropertyValue('--workspace-chat-opacity'), full ? '0' : '1');
    assert.equal(f.actual(), full ? 1200 : 1200 - x);
    assert.equal(f.handle.captured, 1);
  }
  f.move(279); assert.equal(f.sidebarWidth(), 0); assert.equal(f.chat.inert, true);
  assert.equal(f.app.classList.contains('workspace-chat-constrained'), true);
  f.move(1); assert.equal(f.chat.getBoundingClientRect().right, 0); assert.equal(f.chat.inert, true);
  f.move(820); f.up(820); assert.equal(f.sidebarWidth(), 224); assert.equal(f.chat.inert, false);
  assert.equal(f.sidebar.inert, false); assert.equal(f.leftToggle.disabled, false);
  assert.equal(f.app.classList.contains('sidebar-constrained'), false);
  assert.equal(f.app.classList.contains('workspace-chat-constrained'), false);
  assert.equal(f.writes.has(sidebarLayout.STORAGE_KEY), false); assert.equal(f.writes.has(sidebarLayout.STATE_KEY), false);
});

test('window resizing recomputes the same column budget without overwriting either preference', () => {
  const f = fixture(); f.control.open(); f.down(820); f.up(450);
  assert.equal(f.actual(), 750); assert.equal(f.sidebarWidth(), 90);
  f.viewport(1000); assert.equal(f.actual(), 1000); assert.equal(f.sidebarWidth(), 0); assert.equal(f.chat.inert, true);
  assert.equal(f.control.get().automaticMaximized, true);
  f.viewport(1600); assert.equal(f.actual(), 750); assert.equal(f.sidebarWidth(), 224); assert.equal(f.chat.inert, false);
  assert.equal(f.left.getState().preferredWidth, 224); assert.equal(f.control.get().preferredWidth, 750);
  assert.equal(f.writes.has(sidebarLayout.STATE_KEY), false);
});

test('the right panel occupies its own grid column rather than an absolute layer', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.css'), 'utf8');
  const panelRule = css.match(/^\.workspace-panel\s*\{([^}]+)\}/m)[1];
  assert.match(panelRule, /grid-column:\s*3;/); assert.match(panelRule, /position:\s*relative;/);
  assert.doesNotMatch(panelRule, /position:\s*absolute|grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /workspace-chat-constrained\s*>\s*\.chat,[\s\S]*?visibility:\s*hidden/);
});

test('maximize restores the prior width after gestures and follows subsequent window resizes', () => {
  const f = fixture(); f.control.open(); f.down(820); f.up(347); assert.equal(f.actual(), 853);
  f.control.setMaximized(true); f.viewport(1000); assert.equal(f.actual(), 1000);
  f.control.setMaximized(false); assert.equal(f.actual(), 680); assert.equal(f.chat.inert, false);
  f.down(320); f.up(0); assert.equal(f.control.get().maximized, true);
  f.control.setMaximized(false); assert.equal(f.actual(), 680);
});

test('canceling a gesture restores full-width intent and its original restore size', () => {
  const f = fixture(); f.control.open(); f.control.setMaximized(true);
  f.down(0); f.move(200); f.move(0); f.cancel();
  assert.equal(f.control.get().maximized, true); assert.equal(f.actual(), 1200);
  f.control.setMaximized(false); assert.equal(f.actual(), 380);
  assert.equal(f.writes.size, 0);
});

test('cancel and Escape restore the complete pre-drag state after multiple snap crossings', () => {
  for (const initiallyFull of [false, true]) for (const cancel of ['pointercancel', 'keydown', 'blur']) {
    const f = fixture(); f.control.open(); if (initiallyFull) f.control.setMaximized(true);
    const original = { ...f.control.get() };
    f.down(initiallyFull ? 0 : 820);
    for (const x of [280, 320, 700, 280]) f.move(x);
    assert.equal(f.control.get().maximized, true); assert.equal(f.handle.captured, 1);
    f.event(cancel, { key: 'Escape' });
    assert.deepEqual({ ...f.control.get() }, original);
    assert.equal(f.handle.captured, null); assert.equal(f.writes.size, 0);
    assert.equal(f.app.classList.contains('is-workspace-snapping'), false); assert.equal(f.timers.size, 0);
  }
});

test('snap animation survives capture and retargeting but ends on grid completion or timeout', () => {
  const f = fixture(); f.control.open(); f.down(820); f.move(280);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  assert.equal(f.app.classList.contains('is-workspace-resizing'), true); assert.equal(f.handle.captured, 1);
  f.advance(200); f.move(279); f.advance(114);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), false, 'same snapped target cannot restart the animation every pointer event');
  f.move(320); assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  f.advance(200); f.transition('transitionrun'); f.advance(200);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  f.transition('transitionend', 'opacity'); assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  f.transition(); assert.equal(f.app.classList.contains('is-workspace-snapping'), false); assert.equal(f.timers.size, 0);
  f.move(280); f.up(280); assert.equal(f.app.classList.contains('is-workspace-snapping'), true);
  assert.equal(f.handle.captured, null); f.event('pagehide'); assert.equal(f.timers.size, 0);
});

test('reduced motion snaps and restores without an animation class or timer', () => {
  const f = fixture({ reducedMotion: true }); f.control.open(); f.down(820);
  f.move(280); assert.equal(f.actual(), 1200); assert.equal(f.handle.captured, 1);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), false); assert.equal(f.timers.size, 0);
  f.move(320); f.up(320); assert.equal(f.actual(), 880); assert.equal(f.chat.inert, false);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), false); assert.equal(f.timers.size, 0);
});

test('old widths in the unreadable zone temporarily maximize and preserve the saved preference', () => {
  for (const savedWidth of [920, 950, 1600]) {
    const f = fixture({ savedWidth }); f.control.open();
    assert.equal(f.actual(), 1200); assert.equal(f.control.get().automaticMaximized, true);
    assert.equal(f.control.get().preferredWidth, savedWidth); assert.equal(f.writes.size, 0);
    f.view('settings'); assert.equal(f.actual(), 0); assert.equal(f.control.get().preferredWidth, savedWidth);
    f.view('chat'); assert.equal(f.actual(), 1200);
    f.control.close(); assert.equal(f.timers.size, 0); assert.equal(f.control.get().preferredWidth, savedWidth);
    f.control.open(); assert.equal(f.actual(), 1200);
    f.viewport(savedWidth + 319); assert.equal(f.actual(), savedWidth + 319);
    f.viewport(savedWidth + 320); assert.equal(f.actual(), savedWidth); assert.equal(f.control.get().automaticMaximized, false);
    assert.equal(f.chat.inert, false); assert.equal(f.writes.size, 0);
  }
});

test('explicit restore and a keyboard step escape temporary full width to a readable split', () => {
  for (const method of ['button', 'keyboard']) {
    const f = fixture({ savedWidth: 950 }); f.control.open();
    if (method === 'button') f.control.setMaximized(false); else f.key('ArrowRight');
    assert.equal(f.actual(), 880); assert.equal(f.chat.inert, false);
    assert.equal(f.control.get().maximized, false); assert.equal(f.control.get().automaticMaximized, false);
    f.control.layout(); assert.equal(f.actual(), 880);
  }
});

test('switching away during a snap cancels capture and restores the prior split on return', () => {
  const f = fixture(); f.control.open(); f.down(820); f.move(280); f.view('settings');
  assert.equal(f.actual(), 0); assert.equal(f.handle.captured, null); assert.equal(f.control.get().dragging, false);
  assert.equal(f.app.classList.contains('is-workspace-snapping'), false); assert.equal(f.timers.size, 0);
  assert.equal(f.control.get().preferredWidth, 380); assert.equal(f.writes.size, 0);
  f.view('chat'); assert.equal(f.actual(), 380); assert.equal(f.chat.inert, false);
});

test('keyboard resizing retains the hard minimum and the full-width handle stays usable', () => {
  const f = fixture(); f.control.open(); f.key('Home'); assert.equal(f.actual(), 300);
  f.key('End'); assert.equal(f.actual(), 1200); assert.equal(f.handle.hidden, false);
  f.key('ArrowRight'); assert.equal(f.actual(), 300); assert.equal(f.control.get().maximized, false); assert.equal(f.chat.inert, false);
  f.key('Home'); f.key('ArrowRight'); assert.equal(f.actual(), 300);
  f.key('Enter'); assert.equal(f.actual(), 380);
});

test('closing the panel restores the conversation and respects the saved sidebar collapse choice', () => {
  const f = fixture(); f.collapseSidebar(); f.control.open(); f.control.setMaximized(true);
  f.control.close(); assert.equal(f.actual(), 0); assert.equal(f.reserved(), 0);
  assert.equal(f.sidebar.inert, true); assert.equal(f.chat.inert, false); assert.equal(f.panel.inert, true);
  f.control.open(); assert.equal(f.actual(), 380); assert.equal(f.control.get().maximized, false);
});

test('management pages use all content width while keeping the open panel preference for chat', () => {
  const f = fixture(); f.control.open(); f.down(820); f.up(700); assert.equal(f.actual(), 500);
  for (const view of ['settings', 'plugins', 'library', 'scheduler']) {
    f.view(view); assert.equal(f.actual(), 0); assert.equal(f.reserved(), 0);
    assert.equal(f.app.classList.contains('workspace-open'), false); assert.equal(f.panel.inert, true);
    assert.equal(f.panel.getAttribute('aria-hidden'), 'true'); assert.equal(f.handle.hidden, true);
    assert.equal(f.control.get().opened, true); assert.equal(f.control.get().tab, null); assert.equal(f.control.get().preferredWidth, 500);
    f.view('chat'); assert.equal(f.actual(), 500); assert.equal(f.panel.inert, false); assert.equal(f.handle.hidden, false);
  }
});

test('leaving maximized reading for settings releases inert content and restores the prior width on return', () => {
  const f = fixture(); f.control.open(); f.control.setMaximized(true); f.view('settings');
  assert.equal(f.actual(), 0); assert.equal(f.control.get().maximized, false);
  assert.equal(f.sidebar.inert, false); assert.equal(f.chat.inert, false);
  f.view('chat'); assert.equal(f.actual(), 380); assert.equal(f.control.get().maximized, false);
});


test('right-pane layout reads viewport once and does not echo through the left sidebar', () => {
  const f = fixture(); f.resetMeasurements(); f.control.open();
  assert.deepEqual(f.measurements(), { geometryReads: 1, workspaceEvents: 1, sidebarEvents: 0 });
  f.down(820); f.resetMeasurements(); f.move(710);
  assert.deepEqual(f.measurements(), { geometryReads: 1, workspaceEvents: 1, sidebarEvents: 0 });
  assert.equal(f.actual(), 490); assert.equal(f.sidebarWidth(), 224);
  f.up(710);
});

test('left-sidebar changes still notify the right pane without returning a second notification', () => {
  const f = fixture(); f.control.open(); f.resetMeasurements(); f.collapseSidebar();
  assert.equal(f.measurements().sidebarEvents, 1);
  assert.equal(f.sidebarWidth(), 0); assert.equal(f.chat.inert, false); assert.equal(f.actual(), 380);
});
