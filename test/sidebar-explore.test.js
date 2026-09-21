'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURES, STORAGE_KEY, normalizePreferences, setPinnedPreference,
  movePreference, createPreferencesStore, surfacePosition, create,
} = require('../renderer/sidebar-explore');

function memoryStorage(initial = null) {
  let raw = initial; const writes = [];
  return { writes, getItem: () => raw, setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; writes.push(value); } };
}

test('missing/corrupt preferences keep defaults while current-version empty pins stay empty', () => {
  const defaults = normalizePreferences(null);
  assert.deepEqual(defaults.pinned, ['search', 'settings', 'plugins', 'library', 'scheduler']);
  assert.deepEqual(defaults.order, FEATURES.map(item => item.id));
  assert.equal(defaults.version, 4);
  assert.equal(FEATURES.length, 7);
  assert.deepEqual(normalizePreferences({ version: 4, pinned: [] }).pinned, []);
  assert.deepEqual(createPreferencesStore(memoryStorage('not json')).get(), defaults);
  assert.deepEqual(createPreferencesStore(memoryStorage('[]')).get(), defaults);
});

test('stored order is deduplicated and unknown/fixed entry IDs cannot replace known features', () => {
  const result = normalizePreferences({ version: 4, order: ['create', 'create', 'btnNewChat', '__proto__'], pinned: ['create', 'create', 'btnSearch', '<img>'] });
  assert.deepEqual(result.order, ['create', 'search', 'settings', 'plugins', 'library', 'scheduler', 'agent']);
  assert.deepEqual(result.pinned, ['create']);
  assert.deepEqual(setPinnedPreference(result, 'btnNewChat', true), result);
});

test('pin/unpin retains complete custom order and never duplicates a feature', () => {
  let result = movePreference(null, 'agent', 0);
  result = setPinnedPreference(result, 'agent', true);
  result = setPinnedPreference(result, 'library', false);
  result = setPinnedPreference(result, 'agent', true);
  assert.deepEqual(result.pinned, ['agent', 'search', 'settings', 'plugins', 'scheduler']);
  result = setPinnedPreference(result, 'library', true);
  assert.deepEqual(result.pinned, ['agent', 'search', 'settings', 'plugins', 'library', 'scheduler']);
});

test('moves are bounded, immutable and keep pinned entries in the same relative order', () => {
  const original = normalizePreferences(null);
  assert.deepEqual(movePreference(original, 'scheduler', -99).order, ['scheduler', 'search', 'settings', 'plugins', 'library', 'agent', 'create']);
  assert.deepEqual(movePreference(original, 'library', 99).pinned, ['search', 'settings', 'plugins', 'scheduler', 'library']);
  assert.deepEqual(movePreference(original, 'library', NaN), original);
  assert.deepEqual(original.order, FEATURES.map(item => item.id));
});

test('preferences persist across stores and a write refusal preserves the live preview with an error state', () => {
  const storage = memoryStorage(), events = [];
  const store = createPreferencesStore(storage, (value, status) => events.push({ value, status }));
  store.move('agent', 0); store.setPinned('agent', true);
  assert.deepEqual(createPreferencesStore(storage).get(), store.get());
  const snapshot = store.get(); snapshot.pinned.length = 0;
  assert.equal(store.get().pinned.includes('agent'), true);
  const denied = createPreferencesStore({ getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } }, (value, status) => events.push({ value, status }));
  denied.setPinned('create', true);
  assert.equal(denied.get().pinned.includes('create'), true); assert.equal(events.at(-1).status.persisted, false);
  const before = storage.writes.length;
  store.receive({ version: 3, pinned: [], order: [] });
  assert.deepEqual(store.get().pinned, []); assert.equal(storage.writes.length, before);
});

test('popup geometry fits right edge, short windows and the global title bar', () => {
  for (const width of [280, 620, 1200]) for (const height of [220, 800]) {
    for (const top of [0, 150, height - 5]) {
      const placed = surfacePosition({ left: width - 35, right: width - 5, top, bottom: top + 25 }, { width: 300, height: 380 }, { width, height, topInset: 44 });
      assert.ok(placed.left >= 12); assert.ok(placed.left + Math.min(300, width - 24) <= width - 12);
      assert.ok(placed.top >= 44); assert.ok(placed.top + Math.min(380, placed.maxHeight) <= height - 12);
    }
  }
  assert.equal(surfacePosition({ left: 0, right: 100, top: 0, bottom: 20 }, { width: 200, height: 100 }, { width: 800, height: 500 }).top, 12);
});

// A small DOM double exercises controller ownership and event wiring. Actual
// layout/native pointer drag is covered by the isolated Electron smoke suite.
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = [];
    this.parentElement = null; this.dataset = {}; this.attributes = {}; this.handlers = new Map(); this.style = {};
    this.className = ''; this.hidden = false; this.disabled = false; this.textContent = '';
    this.rectangle = { left: 10, top: 60, right: 220, bottom: 97, width: 210, height: 37 };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const has = this.classList.contains(name); if (force === undefined ? !has : force) this.classList.add(name); else this.classList.remove(name); },
    };
  }
  get isConnected() { return this === this.ownerDocument.body || !!(this.parentElement && this.parentElement.isConnected); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, chr) => chr.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, chr) => chr.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') delete this.id;
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, chr) => chr.toUpperCase())];
  }
  appendChild(child) { if (child.parentElement) child.remove(); this.children.push(child); child.parentElement = this; return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(child => this.appendChild(child)); }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('[')) { const match = selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/); return !!match && (match[2] === undefined ? this.getAttribute(match[1]) !== null : this.getAttribute(match[1]) === match[2]); }
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, handler) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(handler); }
  removeEventListener(name, handler) { this.handlers.get(name)?.delete(handler); }
  emit(name, extra = {}) {
    const event = { type: name, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const callback of this.handlers.get(name) || []) callback(event);
    return event;
  }
  click() { if (!this.disabled) this.emit('click'); }
  focus() { if (!this.closest('[inert]') && !this.disabled && !this.refusesFocus) this.ownerDocument.activeElement = this; }
  setPointerCapture(id) { this.capturedPointer = id; }
  hasPointerCapture(id) { return this.capturedPointer === id; }
  releasePointerCapture(id) { if (this.hasPointerCapture(id)) { delete this.capturedPointer; this.emit('lostpointercapture', { pointerId: id }); } }
  getClientRects() {
    let current = this;
    while (current) { if (current.hidden) return []; current = current.parentElement; }
    return this.isConnected ? [this.getBoundingClientRect()] : [];
  }
  getBoundingClientRect() { return { ...this.rectangle }; }
  cloneNode(deep) {
    const copy = new Element(this.tagName, this.ownerDocument);
    copy.className = this.className; copy.id = this.id; copy.attributes = { ...this.attributes };
    if (deep) this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
}
function dom(storage = memoryStorage(), { settingsWrapper = true } = {}) {
  const doc = { handlers: new Map() };
  doc.body = new Element('body', doc); doc.activeElement = doc.body;
  doc.createElement = tag => new Element(tag, doc);
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  doc.getElementById = id => doc.body.querySelector('#' + id);
  for (const method of ['addEventListener', 'removeEventListener', 'emit']) doc[method] = Element.prototype[method];
  const frames = new Map(); let nextFrame = 1;
  const win = { innerWidth: 1120, innerHeight: 800, localStorage: storage, handlers: new Map(),
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...element.style }) };
  for (const method of ['addEventListener', 'removeEventListener', 'emit']) win[method] = Element.prototype[method];
  doc.defaultView = win;
  const append = (id, parent = doc.body, tag = 'button') => { const element = doc.createElement(tag); element.id = id; parent.appendChild(element); return element; };
  const fixed = [append('btnNewChat')];
  const globalToggle = append('btnToggleSidebar'); globalToggle.setAttribute('data-toggle-sidebar', '');
  const pinned = append('sidebarPinnedFeatures', doc.body, 'div');
  const exploreEntry = append('sidebarExploreEntry', doc.body, 'div'), trigger = append('btnExplore', exploreEntry);
  const featureStore = append('sidebarFeatureStore', doc.body, 'div');
  const opened = [], buttons = {}, entries = {};
  for (const item of FEATURES) {
    const entry = item.containerId && settingsWrapper ? append(item.containerId, featureStore, 'div') : null;
    const button = append(item.buttonId, entry || featureStore); buttons[item.id] = button; entries[item.id] = entry || button;
    const svg = append('original-icon-' + item.id, button, 'svg'); svg.className = 'ni-icon';
    button.addEventListener('click', () => opened.push(item.id));
  }
  const updateButton = append('btnRelayUpdate', settingsWrapper ? entries.settings : exploreEntry);
  const controller = create({ document: doc, window: win, storage });
  const flushFrame = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(); };
  return { doc, win, fixed, globalToggle, pinned, exploreEntry, trigger, featureStore, opened, buttons, entries, updateButton, controller, storage, frames, flushFrame, surface: () => doc.getElementById('sidebarExploreSurface') };
}

test('controller moves each original feature node once and never relocates fixed buttons', () => {
  const h = dom();
  assert.deepEqual(h.pinned.children.map(item => item.id), ['btnSearch', 'sidebarSettingsEntry', 'btnPlugins', 'btnMyWorkChat', 'btnSchedule']);
  assert.equal(h.buttons.library.parentElement, h.pinned); assert.equal(h.buttons.agent.parentElement, h.featureStore);
  assert.ok(h.fixed.every(button => button.parentElement === h.doc.body));
  h.controller.setPinned('agent', true); h.controller.move('agent', 0);
  assert.equal(h.pinned.children[0], h.buttons.agent);
  h.buttons.agent.click(); assert.deepEqual(h.opened, ['agent']);
  assert.equal(create({ document: h.doc, window: h.win }), h.controller);
});

test('search and settings can both be hidden and still invoke their original actions from Explore', () => {
  const h = dom();
  h.controller.openCustomize();
  for (const id of ['search', 'settings']) {
    const row = h.surface().querySelector(`[data-customize-feature="${id}"]`);
    assert.ok(row, `${id} is customizable`);
    const checkbox = row.querySelector('input');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false; checkbox.emit('change');
    assert.equal(h.entries[id].parentElement, h.featureStore);
    assert.equal(h.doc.getElementById(h.buttons[id].id), h.buttons[id]);
  }
  assert.equal(h.surface().querySelector('[data-customize-feature="btnNewChat"]'), null);
  assert.equal(h.fixed[0].parentElement, h.doc.body);
  assert.deepEqual(h.opened, []);
  for (const id of ['search', 'settings']) {
    h.controller.openExplore();
    h.surface().querySelector(`[data-feature="${id}"]`).click();
    assert.equal(h.opened.at(-1), id);
    assert.equal(h.surface(), null);
  }
  const reloaded = dom(h.storage);
  assert.equal(reloaded.entries.search.parentElement, reloaded.featureStore);
  assert.equal(reloaded.entries.settings.parentElement, reloaded.featureStore);
});

test('hiding every optional entry persists while New chat and Explore remain reachable', () => {
  const h = dom();
  for (const item of FEATURES) h.controller.setPinned(item.id, false);
  assert.equal(h.pinned.children.length, 0);
  assert.deepEqual(h.controller.getPreferences().pinned, []);
  const reloaded = dom(h.storage);
  assert.equal(reloaded.pinned.children.length, 0);
  assert.ok(reloaded.fixed[0].getClientRects().length);
  assert.ok(reloaded.trigger.getClientRects().length);
  reloaded.controller.openExplore();
  assert.deepEqual(reloaded.surface().querySelectorAll('[role="menuitem"]').map(row => row.dataset.feature).filter(Boolean), FEATURES.map(item => item.id));
});

test('settings moves as one row and the original update button remains outside hidden navigation', () => {
  const h = dom(), settings = h.entries.settings, update = h.updateButton;
  let updateClicks = 0;
  update.addEventListener('click', () => { updateClicks++; });
  assert.equal(h.buttons.settings.parentElement, settings);
  assert.equal(update.parentElement, settings);
  h.controller.move('settings', h.controller.getPreferences().order.length - 1);
  assert.equal(h.pinned.children.at(-1), settings);
  assert.equal(update.parentElement, settings);
  h.controller.setPinned('settings', false);
  assert.equal(settings.parentElement, h.featureStore);
  assert.equal(update.parentElement, h.exploreEntry);
  assert.ok(update.getClientRects().length);
  update.click(); assert.equal(updateClicks, 1);
  h.controller.setPinned('settings', true);
  assert.equal(settings.parentElement, h.pinned);
  assert.equal(update.parentElement, settings);
  assert.equal(h.doc.querySelectorAll('#btnRelayUpdate').length, 1);
  update.click(); assert.equal(updateClicks, 2);
  assert.deepEqual(h.opened, []);
});

test('settings without a wrapper falls back to the existing button and retains its action', () => {
  const h = dom(memoryStorage(), { settingsWrapper: false });
  assert.equal(h.buttons.settings.parentElement, h.pinned);
  h.controller.setPinned('settings', false);
  assert.equal(h.buttons.settings.parentElement, h.featureStore);
  h.controller.openExplore();
  h.surface().querySelector('[data-feature="settings"]').click();
  assert.deepEqual(h.opened, ['settings']);
  h.controller.setPinned('settings', true);
  assert.equal(h.buttons.settings.parentElement, h.pinned);
});

test('explore exposes only unpinned entries, delegates original clicks, and restores trigger focus', () => {
  const h = dom(); h.trigger.click();
  const rows = h.surface().querySelectorAll('[role="menuitem"]');
  assert.deepEqual(rows.map(row => row.dataset.feature).filter(Boolean), ['agent', 'create']);
  assert.equal(h.doc.activeElement, rows[0]);
  assert.equal(rows[0].querySelector('svg').getAttribute('id'), null);
  rows[1].click();
  assert.deepEqual(h.opened, ['create']); assert.equal(h.surface(), null);
  assert.equal(h.doc.activeElement, h.trigger);
  for (const item of FEATURES) h.controller.setPinned(item.id, true);
  h.controller.openExplore();
  assert.equal(h.surface().querySelectorAll('[role="menuitem"]').length, 1);
  assert.equal(h.surface().querySelector('[data-action="customize"]').querySelector('.se-menu-label').textContent, '自定义');
  assert.ok(h.surface().querySelector('.se-empty'));
});

test('left/right explore opening, keyboard menu traversal and Escape leave all functions accessible', () => {
  const h = dom();
  assert.equal(h.trigger.emit('contextmenu').defaultPrevented, true);
  let surface = h.surface(); const rows = surface.querySelectorAll('[role="menuitem"]');
  surface.emit('keydown', { key: 'End' }); assert.equal(h.doc.activeElement, rows.at(-1));
  surface.emit('keydown', { key: 'ArrowDown' }); assert.equal(h.doc.activeElement, rows[0]);
  h.doc.emit('keydown', { key: 'Escape' }); assert.equal(h.surface(), null); assert.equal(h.doc.activeElement, h.trigger);
  h.trigger.emit('keydown', { key: 'ArrowUp' }); surface = h.surface();
  assert.equal(h.doc.activeElement, surface.querySelectorAll('[role="menuitem"]').at(-1));
  h.doc.emit('pointerdown', { target: h.fixed[0] }); assert.equal(h.surface(), null);
});

test('pinned entry context menu can open, remove, or customize without invoking business operations', () => {
  const h = dom();
  h.buttons.library.emit('contextmenu', { clientX: 20, clientY: 100 });
  h.surface().querySelector('[data-action="unpin"]').click();
  assert.equal(h.buttons.library.parentElement, h.featureStore); assert.deepEqual(h.opened, []);
  assert.equal(h.doc.activeElement, h.trigger);
  h.buttons.scheduler.emit('keydown', { key: 'F10', shiftKey: true });
  h.surface().querySelector('[data-action="customize"]').click();
  assert.equal(h.surface().getAttribute('role'), 'dialog');
  assert.equal(h.surface().querySelector('.se-fixed-items'), null);
  assert.equal(h.surface().querySelector('.se-customize-footer'), null);
  h.surface().querySelector('[data-action="done"]').click(); assert.equal(h.surface(), null);
});

test('customizer checkbox previews/persists immediately and Alt-arrow ordering retains focus', () => {
  const h = dom(); h.controller.openCustomize();
  let row = h.surface().querySelector('[data-customize-feature="agent"]');
  const checkbox = row.querySelector('input'); checkbox.checked = true; checkbox.emit('change');
  assert.equal(h.buttons.agent.parentElement, h.pinned);
  row = h.surface().querySelector('[data-customize-feature="agent"]');
  assert.equal(h.doc.activeElement, row.querySelector('input'));
  h.surface().emit('keydown', { target: row.querySelector('input'), key: 'ArrowUp', altKey: true });
  assert.deepEqual(h.pinned.children.map(item => item.id), ['btnSearch', 'sidebarSettingsEntry', 'btnPlugins', 'btnMyWorkChat', 'btnNewAnalysis', 'btnSchedule']);
  assert.equal(h.doc.activeElement.dataset.action, 'drag');
  h.controller.close();
  assert.deepEqual(createPreferencesStore(h.storage).get(), h.controller.getPreferences());
});

function pointerCustomizer() {
  const h = dom(); h.controller.openCustomize();
  const rows = h.surface().querySelectorAll('[data-customize-feature]');
  rows.forEach((row, index) => { row.rectangle = { left: 100, right: 400, top: 100 + index * 42, bottom: 142 + index * 42, width: 300, height: 42 }; });
  const row = id => rows.find(item => item.dataset.customizeFeature === id);
  const handle = id => row(id).querySelector('[data-action="drag"]');
  const center = id => row(id).rectangle.top + row(id).rectangle.height / 2;
  const afterLast = () => rows.at(-1).rectangle.bottom + 40;
  const pointer = (clientY, extra = {}) => ({ pointerId: 11, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true, clientY, ...extra });
  return { ...h, rows, row, handle, center, afterLast, pointer };
}

test('captured pointer previews with stable DOM and commits exactly once on release', () => {
  const h = pointerCustomizer(), handle = h.handle('library'), original = h.controller.getPreferences();
  assert.notEqual(handle.draggable, true); assert.equal(handle.handlers.has('dragstart'), false);
  assert.equal(h.row('scheduler').handlers.has('drop'), false);
  handle.emit('pointerdown', h.pointer(h.center('library'))); assert.equal(handle.hasPointerCapture(11), true);
  const destination = h.center('create') - 5;
  h.win.emit('pointermove', h.pointer(h.center('agent'))); h.win.emit('pointermove', h.pointer(destination));
  h.flushFrame();
  assert.equal(h.row('create').dataset.drop, 'before');
  assert.equal(h.row('library').classList.contains('is-dragging'), true);
  assert.equal(h.surface().querySelector('[data-customize-feature="library"]'), h.row('library'));
  assert.deepEqual(h.controller.getPreferences(), original); assert.equal(h.storage.writes.length, 0);
  h.win.emit('pointerup', h.pointer(destination, { buttons: 0 }));
  assert.deepEqual(h.controller.getPreferences().order, ['search', 'settings', 'plugins', 'scheduler', 'agent', 'library', 'create']);
  assert.equal(h.storage.writes.length, 1); assert.equal(handle.hasPointerCapture(11), false);
  assert.equal(h.surface().querySelector('[data-drop]'), null);
  assert.equal(h.doc.activeElement.dataset.action, 'drag'); assert.equal(h.frames.size, 0);
  h.win.emit('pointerup', h.pointer(h.afterLast(), { buttons: 0 })); assert.equal(h.storage.writes.length, 1);
});

test('pointer hit testing uses latest clientY and fresh row rectangles on every frame and release', () => {
  const h = pointerCustomizer(); h.handle('create').emit('pointerdown', h.pointer(h.center('create')));
  h.win.emit('pointermove', h.pointer(h.center('agent') - 5)); h.flushFrame();
  assert.equal(h.row('agent').dataset.drop, 'before');
  // Simulate scrolling while the pointer stays still: there is no new move event.
  for (const row of h.rows) { row.rectangle.top -= 60; row.rectangle.bottom -= 60; }
  h.flushFrame(); assert.equal(h.surface().querySelector('[data-drop]'), null, 'current position would be unchanged after scroll');
  h.win.emit('pointermove', h.pointer(h.center('agent')));
  // No animation frame before mouseup; the final pointer location is authoritative.
  h.win.emit('pointerup', h.pointer(h.center('scheduler') - 5, { buttons: 0 }));
  assert.deepEqual(h.controller.getPreferences().order, ['search', 'settings', 'plugins', 'library', 'create', 'scheduler', 'agent']);
  assert.equal(h.storage.writes.length, 1);
});

test('pointer release supports both ends and unchanged positions without redundant writes', () => {
  for (const source of ['library', 'create', 'agent']) {
    const h = pointerCustomizer(), original = h.controller.getPreferences();
    const endY = source === 'library' ? h.afterLast() : source === 'create' ? h.rows[0].rectangle.top - 40 : h.center(source) + 8;
    const expectedIndex = source === 'library' ? h.rows.length - 1 : source === 'create' ? 0 : original.order.indexOf(source);
    h.handle(source).emit('pointerdown', h.pointer(h.center(source)));
    h.win.emit('pointermove', h.pointer(endY)); h.flushFrame();
    h.win.emit('pointerup', h.pointer(endY, { buttons: 0 }));
    assert.equal(h.controller.getPreferences().order.indexOf(source), expectedIndex);
    assert.equal(h.storage.writes.length, source === 'agent' ? 0 : 1);
    if (source === 'agent') assert.deepEqual(h.controller.getPreferences(), original);
  }
});

test('Escape, blur, pointercancel and lost capture discard pointer preview without saving', () => {
  for (const reason of ['escape', 'blur', 'cancel', 'lost-capture']) {
    const h = pointerCustomizer(), original = h.controller.getPreferences(), handle = h.handle('library');
    handle.emit('pointerdown', h.pointer(h.center('library'))); h.win.emit('pointermove', h.pointer(h.afterLast())); h.flushFrame();
    assert.ok(h.surface().querySelector('[data-drop]'));
    if (reason === 'escape') h.doc.emit('keydown', { key: 'Escape' });
    if (reason === 'blur') h.win.emit('blur');
    if (reason === 'cancel') h.win.emit('pointercancel', h.pointer(h.afterLast()));
    if (reason === 'lost-capture') handle.releasePointerCapture(11);
    assert.deepEqual(h.controller.getPreferences(), original); assert.equal(h.storage.writes.length, 0);
    assert.equal(handle.hasPointerCapture(11), false); assert.equal(h.frames.size, 0);
    assert.ok(h.surface()); assert.equal(h.surface().querySelector('[data-drop]'), null);
    assert.equal(h.row('library').classList.contains('is-dragging'), false);
    h.win.emit('pointerup', h.pointer(h.afterLast(), { buttons: 0 })); assert.equal(h.storage.writes.length, 0);
    if (reason === 'escape') { assert.equal(h.doc.activeElement, handle); h.doc.emit('keydown', { key: 'Escape' }); assert.equal(h.surface(), null); }
  }
});

test('pointer ownership ignores secondary buttons and unrelated pointers and supports touch capture', () => {
  const h = pointerCustomizer(), handle = h.handle('library');
  for (const extra of [{ button: 2 }, { isPrimary: false }]) {
    handle.emit('pointerdown', h.pointer(h.center('library'), extra)); assert.equal(handle.hasPointerCapture(11), false);
  }
  handle.emit('pointerdown', h.pointer(h.center('library'), { pointerType: 'touch' }));
  h.win.emit('pointermove', h.pointer(h.afterLast(), { pointerId: 12 })); h.flushFrame();
  h.win.emit('pointercancel', h.pointer(h.afterLast(), { pointerId: 12 }));
  h.win.emit('pointerup', h.pointer(h.afterLast(), { pointerId: 12 }));
  assert.equal(handle.hasPointerCapture(11), true); assert.equal(h.storage.writes.length, 0);
  h.win.emit('pointermove', h.pointer(h.afterLast(), { pointerType: 'touch', buttons: 0 })); h.flushFrame();
  h.win.emit('pointerup', h.pointer(h.afterLast(), { pointerType: 'touch', buttons: 0 }));
  assert.equal(h.controller.getPreferences().order.at(-1), 'library'); assert.equal(h.storage.writes.length, 1);
});

test('closing, remote preference changes and disposal release capture without late pointer commits', () => {
  for (const reason of ['close', 'storage', 'destroy']) {
    const h = pointerCustomizer(), handle = h.handle('library');
    handle.emit('pointerdown', h.pointer(h.center('library'))); h.win.emit('pointermove', h.pointer(h.afterLast())); h.flushFrame();
    if (reason === 'close') h.controller.close();
    if (reason === 'storage') h.win.emit('storage', { key: STORAGE_KEY, newValue: JSON.stringify({ version: 3, pinned: [], order: [] }) });
    if (reason === 'destroy') h.controller.destroy();
    assert.equal(handle.hasPointerCapture(11), false); assert.equal(h.frames.size, 0);
    h.win.emit('pointerup', h.pointer(h.afterLast(), { buttons: 0 }));
    assert.equal(h.storage.writes.length, 0); assert.equal(h.controller.getPreferences().order[0], 'search');
  }
});

test('storage failure is visible, remote preferences reapply, and disposal removes listeners', () => {
  const h = dom({ getItem() { return null; }, setItem() { throw Error('full'); } });
  h.controller.openCustomize(); h.controller.setPinned('create', true);
  assert.equal(h.surface().querySelector('.se-customize-footer').dataset.persisted, 'false');
  h.win.emit('storage', { key: STORAGE_KEY, newValue: JSON.stringify({ version: 3, pinned: [], order: [] }) });
  assert.equal(h.pinned.children.length, 0);
  assert.equal(h.surface().querySelector('.se-customize-footer'), null);
  h.controller.destroy(); h.trigger.click(); assert.equal(h.surface(), null);
  assert.equal(h.trigger.handlers.get('click').size, 0);
});

function sidebarWrapper(h) {
  const sidebar = h.doc.createElement('aside'); h.doc.body.appendChild(sidebar);
  for (const child of [h.pinned, h.exploreEntry, h.featureStore]) sidebar.appendChild(child);
  return sidebar;
}

for (const event of ['resize', 'relay:sidebar-changed']) {
  test(`inert sidebar closes exploration on ${event} and focuses the global toggle`, () => {
    const h = dom(), sidebar = sidebarWrapper(h);
    h.controller.openExplore(); assert.ok(h.surface());
    sidebar.setAttribute('inert', ''); h.win.innerWidth = 520;
    assert.equal(h.trigger.getClientRects().length, 1, 'inert retains a positive geometric rectangle');
    h.win.emit(event);
    assert.equal(h.surface(), null); assert.equal(h.doc.activeElement, h.globalToggle);
    assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
  });
}

test('Escape never reports focus success on an inert or nonfocusable return target', () => {
  for (const rejected of ['inert', 'focus-refused']) {
    const h = dom(), sidebar = sidebarWrapper(h);
    h.controller.openCustomize();
    if (rejected === 'inert') sidebar.setAttribute('inert', ''); else h.trigger.refusesFocus = true;
    h.doc.emit('keydown', { key: 'Escape' });
    assert.equal(h.surface(), null); assert.equal(h.doc.activeElement, h.globalToggle);
  }
});

test('CSS-hidden sidebar cannot receive focus even when its button rectangle stays positive', () => {
  for (const style of [{ visibility: 'hidden' }, { pointerEvents: 'none' }, { opacity: '0' }]) {
    const h = dom(), sidebar = sidebarWrapper(h);
    h.buttons.library.emit('contextmenu', { clientX: 30, clientY: 80 });
    Object.assign(sidebar.style, style);
    h.win.emit('relay:sidebar-changed');
    assert.equal(h.surface(), null); assert.equal(h.doc.activeElement, h.globalToggle);
  }
});


test('v1 preferences gain new entries once without resetting existing choices; hiding them survives restart', () => {
  const legacy = { version: 1, order: ['create','library','scheduler','agent','orchestrate'], pinned: ['create'] };
  const migrated = normalizePreferences(legacy);
  assert.deepEqual(migrated.order, ['search','settings','plugins','create','library','scheduler','agent']);
  assert.deepEqual(migrated.pinned, ['search','settings','plugins','create']);
  assert.equal(migrated.version, 4);
  let hidden = migrated;
  for (const id of ['search', 'settings', 'plugins']) hidden = setPinnedPreference(hidden, id, false);
  assert.deepEqual(normalizePreferences(JSON.parse(JSON.stringify(hidden))).pinned, ['create']);
  assert.deepEqual(legacy.pinned, ['create']);
});

test('v2 and unversioned preferences retain old order and visibility when gaining optional Search and Settings', () => {
  for (const version of [2, undefined]) {
    const legacy = { order: ['orchestrate', 'scheduler', 'library', 'plugins', 'create', 'agent'], pinned: ['orchestrate', 'library'] };
    if (version !== undefined) legacy.version = version;
    const original = JSON.parse(JSON.stringify(legacy));
    const migrated = normalizePreferences(legacy);
    assert.deepEqual(migrated.order, ['search', 'settings', 'agent', 'scheduler', 'library', 'plugins', 'create']);
    assert.deepEqual(migrated.pinned, ['search', 'settings', 'agent', 'library']);
    assert.equal(migrated.version, 4);
    assert.deepEqual(legacy, original);
    assert.deepEqual(normalizePreferences(migrated), migrated);
    const emptyLegacy = normalizePreferences({ ...legacy, pinned: [] });
    assert.deepEqual(emptyLegacy.pinned, ['search', 'settings']);
  }
});

test('legacy preferences that already know Search and Settings preserve their deliberate hiding and order', () => {
  const legacy = { version: 2, order: ['library', 'settings', 'plugins', 'search', 'scheduler', 'agent', 'create', 'orchestrate'], pinned: ['library'] };
  const migrated = normalizePreferences(legacy);
  assert.deepEqual(migrated.order, legacy.order.filter(id => id !== 'orchestrate'));
  assert.deepEqual(migrated.pinned, ['library']);
  assert.equal(migrated.version, 4);
});

test('v3 collaboration migrates into the first Agent position without restoring hidden Search or Settings', () => {
  for (const order of [
    ['create', 'orchestrate', 'library', 'agent', 'settings', 'search', 'plugins', 'scheduler'],
    ['create', 'agent', 'library', 'orchestrate', 'settings', 'search', 'plugins', 'scheduler'],
  ]) {
    for (const pinned of [['orchestrate', 'library'], ['agent', 'library'], ['agent', 'orchestrate', 'library'], ['library'], []]) {
      const legacy = { version: 3, order, pinned };
      const original = JSON.parse(JSON.stringify(legacy));
      const migrated = normalizePreferences(legacy);
      assert.deepEqual(migrated.order, ['create', 'agent', 'library', 'settings', 'search', 'plugins', 'scheduler']);
      assert.equal(migrated.pinned.includes('agent'), pinned.includes('agent') || pinned.includes('orchestrate'));
      assert.equal(migrated.pinned.includes('search'), false);
      assert.equal(migrated.pinned.includes('settings'), false);
      assert.equal(migrated.order.length, 7);
      assert.equal(migrated.version, 4);
      assert.equal(migrated.pinned.includes('orchestrate'), false);
      assert.deepEqual(normalizePreferences(migrated), migrated);
      assert.deepEqual(legacy, original);
    }
  }
});

test('migrated collaboration exposes only the original Agent action and persists edits in v4', () => {
  const storage = memoryStorage(JSON.stringify({
    version: 3, order: ['orchestrate', 'library', 'agent', 'settings', 'search', 'plugins', 'scheduler', 'create'],
    pinned: ['orchestrate', 'library'],
  }));
  const h = dom(storage);
  assert.deepEqual(h.pinned.children.map(item => item.id), ['btnNewAnalysis', 'btnMyWorkChat']);
  h.buttons.agent.click(); assert.deepEqual(h.opened, ['agent']);
  h.controller.openCustomize();
  assert.equal(h.surface().querySelectorAll('[data-customize-feature]').length, 7);
  assert.equal(h.surface().querySelector('[data-customize-feature="orchestrate"]'), null);
  h.controller.setPinned('agent', false);
  const saved = JSON.parse(storage.writes.at(-1));
  assert.equal(saved.version, 4);
  assert.deepEqual(saved.pinned, ['library']);
  const reloaded = dom(storage);
  assert.deepEqual(reloaded.controller.getPreferences(), h.controller.getPreferences());
  assert.equal(reloaded.entries.settings.parentElement, reloaded.featureStore);
  assert.equal(reloaded.entries.search.parentElement, reloaded.featureStore);
  reloaded.controller.openExplore();
  reloaded.surface().querySelector('[data-feature="agent"]').click();
  assert.deepEqual(reloaded.opened, ['agent']);
});

test('v3 snapshots without explicit Search or Settings order still respect an empty pinned list', () => {
  const migrated = normalizePreferences({ version: 3, order: ['orchestrate', 'agent'], pinned: [] });
  assert.deepEqual(migrated.pinned, []);
  assert.deepEqual(migrated.order, ['agent', 'search', 'settings', 'plugins', 'library', 'scheduler', 'create']);
  assert.equal(migrated.version, 4);
});
