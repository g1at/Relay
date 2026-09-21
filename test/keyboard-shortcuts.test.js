'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, STORAGE_KEY, normalizePreferences, chordFromEvent, formatChord, validateChord, createStore } = require('../renderer/keyboard-shortcuts');

function memoryStorage(initial = null) {
  let raw = initial;
  const writes = [];
  return { writes, getItem: () => raw, setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; writes.push(value); } };
}
const event = (overrides = {}) => ({ code: 'KeyK', key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...overrides });

test('defaults contain only supported actions and malformed storage safely restores them', () => {
  const defaults = normalizePreferences(null);
  assert.equal(defaults.version, 1);
  assert.deepEqual(Object.keys(defaults.bindings), ACTIONS.map(action => action.id));
  for (const value of ['broken JSON', '[]', '{}', 'null', '{"bindings":42}']) {
    assert.deepEqual(createStore({ storage: memoryStorage(value) }).get(), defaults);
  }
  assert.deepEqual(createStore({ storage: { getItem() { throw Error('denied'); } } }).get(), defaults);
  assert.ok(Object.isFrozen(ACTIONS[0].defaults));
});

test('normalization preserves explicit empty bindings and fills only missing or malformed actions', () => {
  const result = normalizePreferences({ bindings: { newChat: [], search: [' shift + mod + g '], settings: null } });
  assert.deepEqual(result.bindings.newChat, []);
  assert.deepEqual(result.bindings.search, ['Mod+Shift+G']);
  assert.deepEqual(result.bindings.settings, ['Mod+Comma']);
  assert.deepEqual(result.bindings.toggleSidebar, ['Mod+B']);
});

test('normalization rejects unknown keys, reserved chords, prototypes and repeated bindings', () => {
  const raw = '{"bindings":{"search":["Mod+G","Mod+G","Mod+R","<script>","Mod+H","Mod+I","Mod+J"],"plugins":["Mod+G","Mod+P"],"__proto__":{"polluted":true},"constructor":["Mod+U"]}}';
  const result = normalizePreferences(raw);
  assert.deepEqual(result.bindings.search, ['Mod+G', 'Mod+H', 'Mod+I']);
  assert.deepEqual(result.bindings.plugins, ['Mod+P']);
  assert.equal(Object.hasOwn(result.bindings, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  const inherited = Object.create({ search: [] });
  assert.deepEqual(normalizePreferences({ bindings: inherited }).bindings.search, ['Mod+K']);
});

test('explicit loaded assignments take priority over missing default bindings without ambiguity', () => {
  const result = normalizePreferences({ bindings: { search: ['Mod+N'] } });
  assert.deepEqual(result.bindings.search, ['Mod+N']);
  assert.deepEqual(result.bindings.newChat, ['Mod+Shift+O']);
  const chords = Object.values(result.bindings).flat();
  assert.equal(chords.length, new Set(chords).size);
});

test('rebinding replaces the original and removing defaults survives a fresh store', () => {
  const storage = memoryStorage(), store = createStore({ storage });
  assert.equal(store.assign('search', 0, 'Mod+G').ok, true);
  assert.equal(store.get().bindings.search.includes('Mod+K'), false);
  assert.equal(store.remove('newChat', 1).ok, true);
  assert.equal(store.remove('newChat', 0).ok, true);
  assert.deepEqual(createStore({ storage }).get().bindings.newChat, []);
  assert.deepEqual(createStore({ storage }).get().bindings.search, ['Mod+G']);
});

test('cross-action and same-action conflicts fail without a write or state change', () => {
  const storage = memoryStorage(), store = createStore({ storage });
  const before = store.get();
  assert.equal(store.assign('plugins', 0, 'Mod+K').conflictId, 'search');
  assert.equal(store.assign('newChat', 1, 'Mod+N').conflictId, 'newChat');
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(store.get(), before);
  assert.equal(store.assign('search', 0, 'mod+k').ok, true);
});

test('binding limits and stale indices are checked before changing preferences', () => {
  const storage = memoryStorage(), store = createStore({ storage });
  for (const [index, chord] of ['Mod+G', 'Mod+H', 'Mod+I'].entries()) assert.equal(store.assign('plugins', index, chord).ok, true);
  for (const result of [store.assign('plugins', 3, 'Mod+J'), store.assign('plugins', 1.1, 'Mod+J'), store.assign('library', 1, 'Mod+J'), store.remove('plugins', -1), store.remove('plugins', 3), store.assign('__proto__', 0, 'Mod+J'), store.reset('constructor')]) assert.equal(result.ok, false);
  assert.equal(storage.writes.length, 3);
});

test('failed or unavailable storage keeps applied bindings unchanged and does not notify', () => {
  const changes = [];
  for (const storage of [null, {}, { setItem() { throw Error('quota'); } }]) {
    const store = createStore({ storage, onChange: value => changes.push(value) });
    const before = store.get();
    assert.equal(store.assign('search', 0, 'Mod+G').ok, false);
    assert.equal(store.remove('search', 0).ok, false);
    assert.equal(store.reset().ok, false);
    assert.deepEqual(store.get(), before);
  }
  assert.equal(changes.length, 0);
});

test('receive updates listeners without writing; snapshots and listener mutations stay isolated', () => {
  const storage = memoryStorage(), received = [], store = createStore({ storage, onChange: value => { value.bindings.search.length = 0; } });
  const unsubscribe = store.subscribe(value => received.push(value));
  store.subscribe(() => { throw Error('listener failure'); });
  assert.equal(store.assign('search', 0, 'Mod+G').ok, true);
  assert.deepEqual(received[0].bindings.search, ['Mod+G']);
  received[0].bindings.search.length = 0;
  const ownSnapshot = store.get(); ownSnapshot.bindings.search[0] = 'Mod+H';
  assert.deepEqual(store.get().bindings.search, ['Mod+G']);
  const writes = storage.writes.length;
  store.receive('{"bindings":{"search":[]}}');
  assert.deepEqual(store.get().bindings.search, []);
  assert.equal(storage.writes.length, writes);
  assert.equal(received.length, 2);
  unsubscribe(); store.receive(null);
  assert.equal(received.length, 2);
  assert.deepEqual(store.get().bindings.search, ['Mod+K']);
});

test('resetting one action checks its reused default and reset all restores a consistent map', () => {
  const storage = memoryStorage(), store = createStore({ storage });
  store.remove('search', 0); store.assign('plugins', 0, 'Mod+K');
  const before = storage.writes.length;
  assert.equal(store.reset('search').conflictId, 'plugins');
  assert.equal(storage.writes.length, before);
  assert.equal(store.reset('plugins').ok, true);
  assert.equal(store.reset('search').ok, true);
  store.assign('search', 0, 'Mod+G');
  assert.equal(store.reset().ok, true);
  assert.deepEqual(store.get(), normalizePreferences(null));
});

test('keyboard recording uses physical key codes with stable modifier order', () => {
  assert.equal(chordFromEvent(event({ code: 'KeyZ', key: 'y', shiftKey: true, altKey: true })), 'Mod+Alt+Shift+Z');
  assert.equal(chordFromEvent(event({ code: 'Comma', key: '<', shiftKey: true })), 'Mod+Shift+Comma');
  assert.equal(chordFromEvent(event({ code: 'Digit1', key: '!', shiftKey: true })), 'Mod+Shift+1');
  assert.equal(chordFromEvent(event({ code: '', key: ',' })), 'Mod+Comma');
  assert.equal(chordFromEvent(event({ code: 'F2', key: 'F2', ctrlKey: false })), 'F2');
});

test('keyboard recording skips IME, repeats, AltGraph, modifiers and unsupported Windows Meta', () => {
  for (const overrides of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Process' }, { key: 'Dead' }, { getModifierState: name => name === 'AltGraph' }, { metaKey: true }, { code: 'ControlLeft', key: 'Control' }, { code: 'Escape', key: 'Escape' }, { code: 'Tab', key: 'Tab' }]) {
    assert.equal(chordFromEvent(event(overrides)), null, JSON.stringify(overrides));
  }
});

test('Mac recording keeps Command and Control distinct and formats platform keycaps', () => {
  assert.equal(chordFromEvent(event({ metaKey: true, ctrlKey: false }), true), 'Mod+K');
  assert.equal(chordFromEvent(event({ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), true), 'Mod+Ctrl+Alt+Shift+K');
  assert.equal(chordFromEvent(event(), true), 'Ctrl+K');
  assert.equal(validateChord(chordFromEvent(event(), true)).ok, false);
  assert.deepEqual(formatChord('Mod+Ctrl+Alt+Shift+Comma', true), ['⌘', '⌃', '⌥', '⇧', ',']);
  assert.deepEqual(formatChord('Mod+Shift+ArrowUp'), ['Ctrl', 'Shift', '↑']);
  assert.deepEqual(formatChord('unrecognized'), []);
});

test('reserved editing, sending and window keys cannot replace built-in behavior', () => {
  for (const chord of ['A', 'Space', 'Shift+Enter', 'Escape', 'Tab', 'Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+Shift+V', 'Mod+Enter', 'Mod+Shift+Enter', 'Mod+Q', 'Mod+W', 'Mod+R', 'Mod+Shift+R', 'F5', 'F11', 'F12', 'Mod+F12', 'Alt+F4', 'Alt+Space']) {
    const result = validateChord(chord);
    assert.equal(result.ok, false, chord);
    assert.equal(typeof result.error, 'string');
  }
  for (const chord of ['Mod+G', 'Mod+Shift+X', 'Mod+Comma', 'Mod+Shift+O', 'Mod+Ctrl+P', 'F1', 'F2', 'Alt+F3', 'Mod+F4', 'F10']) assert.equal(validateChord(chord).ok, true, chord);
});

test('chord parsing rejects malformed and oversized input while normalizing valid case/order', () => {
  for (const chord of [null, 1, {}, 'Mod++K', 'Mod+Mod+K', 'Mod+Unknown', 'Mod+F13', 'Ctrl+', 'Mod+K+G', 'Mod+' + 'A'.repeat(200), '__proto__']) assert.equal(validateChord(chord).ok, false);
  assert.deepEqual(validateChord(' shift + mod + g '), { ok: true, chord: 'Mod+Shift+G' });
  assert.deepEqual(validateChord('mod+,'), { ok: true, chord: 'Mod+Comma' });
});

test('workspace defaults are distinct, platform aware, and never take an existing custom binding', () => {
  const ids = ['newBrowser', 'openFiles', 'newTerminal', 'openReview'];
  const defaults = normalizePreferences(null);
  const all = Object.values(defaults.bindings).flat();
  assert.equal(new Set(all).size, all.length);
  for (const [index, id] of ids.entries()) {
    const chord = 'Mod+Alt+' + (index + 1);
    assert.deepEqual(defaults.bindings[id], [chord]);
    assert.equal(validateChord(chord).ok, true);
    assert.equal(chordFromEvent(event({ code: 'Digit' + (index + 1), key: String(index + 1), altKey: true })), chord);
    assert.equal(chordFromEvent(event({ code: 'Digit' + (index + 1), key: String(index + 1), ctrlKey: false, metaKey: true, altKey: true }), true), chord);
  }
  const old = normalizePreferences({ bindings: { search: ['Mod+Alt+3'], newBrowser: [] } });
  assert.deepEqual(old.bindings.search, ['Mod+Alt+3']);
  assert.deepEqual(old.bindings.newTerminal, []);
  assert.deepEqual(old.bindings.newBrowser, []);
  assert.deepEqual(old.bindings.openReview, ['Mod+Alt+4']);
});

test('retired task bindings disappear without assigning their shortcuts to another action', () => {
  const storage = memoryStorage(JSON.stringify({ version: 1, bindings: { openTasks: ['Mod+Alt+5', 'Mod+Alt+9'], newTerminal: ['Mod+Alt+T'] } }));
  const store = createStore({ storage });
  assert.equal(Object.hasOwn(store.get().bindings, 'openTasks'), false);
  assert.equal(Object.values(store.get().bindings).flat().includes('Mod+Alt+5'), false);
  assert.equal(Object.values(store.get().bindings).flat().includes('Mod+Alt+9'), false);
  assert.equal(store.getLabel('openTasks'), '');
  assert.equal(store.getAriaShortcuts('openTasks'), '');
  assert.equal(store.assign('openTasks', 0, 'Mod+Alt+5').ok, false);
  assert.equal(store.getLabel('newTerminal'), 'Ctrl+Alt+T');
  assert.equal(storage.writes.length, 0);
  assert.equal(store.reset().ok, true);
  assert.equal(Object.values(store.get().bindings).flat().includes('Mod+Alt+5'), false);
  // The retired default becomes available only through an explicit new assignment.
  assert.equal(store.assign('openReview', 0, 'Mod+Alt+5').ok, true);
});

test('workspace labels, aria hints, subscriptions and reload follow customization and reset', () => {
  const storage = memoryStorage(), store = createStore({ storage }), updates = [];
  const dispose = store.subscribe(() => updates.push(store.getLabel('newTerminal')));
  assert.equal(store.getLabel('newTerminal'), 'Ctrl+Alt+3');
  assert.equal(store.getLabel('newTerminal', true), '⌘+⌥+3');
  assert.equal(store.getAriaShortcuts('newTerminal', true), 'Meta+Alt+3');
  assert.equal(store.assign('newTerminal', 0, 'Mod+Alt+T').ok, true);
  assert.equal(store.assign('newTerminal', 1, 'Mod+Shift+T').ok, true);
  assert.equal(store.getAriaShortcuts('newTerminal'), 'Control+Alt+T Control+Shift+T');
  assert.equal(createStore({ storage }).getLabel('newTerminal'), 'Ctrl+Alt+T');
  assert.equal(store.assign('openReview', 0, 'Mod+Alt+T').conflictId, 'newTerminal');
  assert.equal(store.remove('newTerminal', 1).ok, true);
  assert.equal(store.remove('newTerminal', 0).ok, true);
  assert.equal(store.getLabel('newTerminal'), '');
  assert.equal(store.getAriaShortcuts('newTerminal'), '');
  assert.equal(store.reset('newTerminal').ok, true);
  assert.deepEqual(updates, ['Ctrl+Alt+T', 'Ctrl+Alt+T', 'Ctrl+Alt+T', '', 'Ctrl+Alt+3']);
  assert.equal(store.getLabel('__proto__'), '');
  assert.equal(store.getAriaShortcuts('missing'), '');
  dispose();
});
