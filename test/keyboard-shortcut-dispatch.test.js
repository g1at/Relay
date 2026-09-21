'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../renderer/keyboard-shortcuts');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const blockStart = source.indexOf('const keyboardActionButtons = {');
assert.notEqual(blockStart, -1, 'application shortcut dispatcher must exist');
const blockEnd = source.indexOf('// Activity actions retain', blockStart);
assert.ok(blockEnd > blockStart, 'shortcut harness must end before unrelated activity action bindings');
const block = source.slice(blockStart, blockEnd);

function harness({ isMac = false, activeView = 'chat' } = {}) {
  const listeners = new Map(), calls = [], dialogs = [];
  const store = core.createStore({ storage: { getItem: () => null, setItem() {} }, isMac });
  const window = {
    RelayKeyboardShortcuts: core,
    relayWorkspacePanel: { create: kind => { calls.push(['create', kind]); return true; } },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); },
  };
  const context = vm.createContext({
    window, document: { querySelectorAll: () => dialogs },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    $: () => null, keyboardShortcutStore: store, keyboardStorage: null, keyboardIsMac: isMac,
    activeView, inputEl: { focus() { calls.push(['focus']); } }, isRunning: false,
    showAppView(view) { calls.push(['view', view]); context.activeView = view; return true; },
    showSearchModal() { calls.push(['search']); }, startNewConv() { calls.push(['newChat']); },
    openSettings() { calls.push(['settings']); }, toggleAppSidebar() {}, abortCurrent() {},
  });
  vm.runInContext(block, context);
  function key(digit, options = {}) {
    const event = {
      code: 'Digit' + digit, key: String(digit), ctrlKey: !isMac, metaKey: isMac, altKey: true,
      shiftKey: false, repeat: false, defaultPrevented: false, target: { closest: () => null },
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options,
    };
    for (const listener of listeners.get('keydown')) listener(event);
    return event;
  }
  return { context, window, calls, dialogs, store, key, listeners };
}

test('all four workspace keyboard actions reach the same actual creation API on Windows and Mac', () => {
  for (const isMac of [false, true]) {
    const h = harness({ isMac });
    for (let i = 1; i <= 4; i++) {
      const event = h.key(i);
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.stopped, true);
    }
    assert.deepEqual(h.calls, ['browser', 'files', 'terminal', 'review'].map(kind => ['create', kind]));
    assert.equal(h.key(5).defaultPrevented, false);
    assert.equal(h.calls.length, 4);
    h.key(3);
    assert.deepEqual(h.calls.at(-1), ['create', 'terminal']);
  }
});

test('workspace shortcuts leave settings by changing view without creating a conversation or saving drafts', () => {
  const h = harness({ activeView: 'settings' });
  h.key(4);
  assert.deepEqual(h.calls, [['view', 'chat'], ['create', 'review']]);
  assert.equal(h.context.activeView, 'chat');
});

test('removed and rebound workspace bindings affect dispatch immediately', () => {
  const h = harness();
  assert.equal(h.store.assign('newTerminal', 0, 'Mod+Alt+T').ok, true);
  assert.equal(h.key(3).defaultPrevented, false);
  const event = h.key('T', { code: 'KeyT', key: 't' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.calls, [['create', 'terminal']]);
  h.store.remove('newTerminal', 0);
  h.key('T', { code: 'KeyT', key: 't' });
  assert.equal(h.calls.length, 1);
  h.store.reset(); h.key(3);
  assert.equal(h.calls.length, 2);
});

test('IME, AltGraph, held keys and inert controls keep their keyboard context', () => {
  const h = harness();
  for (const overrides of [
    { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true },
    { getModifierState: key => key === 'AltGraph' },
    { target: { closest: selector => selector === '[inert]' ? {} : null } },
  ]) h.key(3, overrides);
  assert.deepEqual(h.calls, []);
});

test('focused terminals allow only explicit workspace actions and retain shell editing keys', () => {
  const h = harness(), target = { closest: selector => selector === '.xterm' ? {} : null };
  for (const letter of ['L', 'K', 'N', 'B']) {
    assert.equal(h.key(letter, { code: 'Key' + letter, key: letter.toLowerCase(), altKey: false, target }).defaultPrevented, false);
  }
  const event = h.key(3, { target });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(h.calls, [['create', 'terminal']]);
});

test('native browser workspace shortcut events share the action and modal guards', () => {
  const h = harness();
  const dispatch = action => h.listeners.get('relay:workspace-shortcut')[0]({ detail: { action } });
  dispatch('newTerminal'); dispatch('search'); dispatch('__proto__'); dispatch('openTasks');
  assert.deepEqual(h.calls, [['create', 'terminal']]);
  h.dialogs.push({ closest: () => null, getClientRects: () => [{}] });
  dispatch('openFiles');
  assert.equal(h.calls.length, 1);
});

test('visible dialogs and shortcut recording never execute workspace commands', () => {
  const h = harness();
  h.dialogs.push({ closest: () => null, getClientRects: () => [{}] });
  assert.equal(h.key(1).defaultPrevented, false);
  h.dialogs.length = 0;
  h.window.relayShortcutPage = { handleKeyDown(event) { event.preventDefault(); return true; } };
  assert.equal(h.key(3).defaultPrevented, true);
  assert.deepEqual(h.calls, []);
});

test('unavailable workspace APIs or failed view navigation do not start an action', () => {
  const h = harness({ activeView: 'settings' });
  h.window.relayWorkspacePanel = null;
  assert.equal(h.key(2).defaultPrevented, false);
  assert.deepEqual(h.calls, []);
  h.window.relayWorkspacePanel = { create() { throw Error('must not run'); } };
  h.context.showAppView = () => false;
  assert.equal(h.key(2).defaultPrevented, false);
});
