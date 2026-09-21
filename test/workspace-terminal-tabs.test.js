'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Exercise the production terminal lifecycle with deferred transport responses.
// Real xterm layout/input and the tab strip are covered by workspace-panel-smoke.
function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
  const terminal = source.slice(source.indexOf('  function terminalDirectoryKey('), source.indexOf('  let fitFrame ='));
  const close = source.slice(source.indexOf('  async function closeTab('), source.indexOf('  function setMaximized('));
  const nodes = new Map(), starts = [], closes = [], inputs = [], terminals = [];
  const node = () => ({ hidden: false, textContent: '', disabled: false, dataset: {}, children: [], append(child) { this.children.push(child); }, remove() { this.removed = true; }, setAttribute(key, value) { this[key] = value; }, querySelector: () => ({ focus() {} }) });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let eventHandler, resolveHeld = null, closeFailure = false;
  const bridge = {
    resolve: ctx => resolveHeld ? new Promise(resolve => { resolveHeld.resolve = resolve; }) : Promise.resolve({ ok: true, root: ctx.workingDir || 'C:/RelayProjects/' + ctx.conversationId }),
    terminalStart: input => new Promise(resolve => { starts.push({ ...input, resolve }); }),
    terminalClose: async ({ id }) => { closes.push(id); return closeFailure ? { ok: false, error: 'close failed' } : { ok: true }; },
    terminalInput: async input => { inputs.push(input); return { ok: true }; },
    onTerminalEvent: fn => { eventHandler = fn; },
  };
  class Terminal {
    constructor() { this.output = ''; terminals.push(this); }
    loadAddon() {} open() {} onData(fn) { this.input = fn; }
    write(text) { this.output += text; } focus() { this.focused = true; } dispose() { this.disposed = true; }
  }
  const sandbox = { $, bridge, document: { createElement: node }, window: { Terminal, FitAddon: { FitAddon: class {} } }, panel: { querySelectorAll: () => [] }, app: { dataset: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }), fitTerminal() {}, renderTabs() {}, savePreviewScroll() {}, disposeHtmlPreview() {}, closeMenus() {}, layout() {}, dispatchTab() {}, syncNative() {}, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(`
    const sessions = new Map(), pendingTerminals = new Set(), earlyEvents = new Map(), tabs = [];
    let termNumber = 0, disposed = false, context = {conversationId:'draft-a',workingDir:'C:/Project A'}, contextKey = 'draft-a', navigationRevision = 0, activeId = null, tab = null, opened = true, preview = null, previewRevision = 0;
    const activeTab = () => tabs.find(item => item.id === activeId);
    function syncContext() {}
    function activate(id) { navigationRevision++; activeId = id; tab = activeTab()?.kind; opened = true; renderTerminals(); }
    function assertResult(value) { if (!value || value.ok === false) throw Error(value?.error || 'failed'); return value; }
    ${terminal}
    ${close}
    globalThis.control = { newTerminal, openTerminal, closeTab, activate, currentTerminal, retry:()=>startTerminalSession(),
      get:()=>({tabs,activeId,sessions,pendingTerminals}),
      context(id,root){ context={conversationId:id,workingDir:root};contextKey=id; },
      navigate(){navigationRevision++;activeId=null;tab='files';renderTerminals();},
      hide(){opened=false;navigationRevision++;}, dispose(){disposed=true;} };
  `, sandbox);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const complete = async (index, response = {}) => {
    // Library readiness is asynchronous even when both test constructors are
    // already present. Only settle transport after the production loader yields.
    await flush();
    const start = starts[index];
    assert.ok(start, `terminal transport request ${index} started`);
    start.resolve({ ok: true, id: 'pty-' + index, root: start.context.workingDir, ...response });
    await flush();
  };
  return { c: sandbox.control, starts, closes, inputs, terminals, $, flush, complete, event: value => eventHandler(value), holdResolve() { resolveHeld = {}; return resolveHeld; }, failClose(value) { closeFailure = value; } };
}

test('each new terminal gets an independent tab immediately and out-of-order startup never steals selection', async () => {
  const f = fixture(), first = f.c.newTerminal(), second = f.c.newTerminal();
  assert.notEqual(first, second); assert.equal(f.c.get().tabs.length, 2);
  await f.flush(); assert.equal(f.starts.length, 2);
  await f.complete(1); await f.complete(0);
  assert.equal(f.c.get().activeId, second); assert.equal(f.c.currentTerminal().id, 'pty-1');
  f.c.activate(first); assert.equal(f.c.currentTerminal().id, 'pty-0');
  assert.equal(f.c.get().sessions.get('pty-1').host.hidden, true);
});

test('output and keyboard input stay with the owning tab, including early output', async () => {
  const f = fixture(), first = f.c.newTerminal(); f.event({ id: 'pty-0', type: 'data', data: 'early A' });
  await f.complete(0); const second = f.c.newTerminal(); await f.complete(1);
  f.event({ id: 'pty-0', type: 'data', data: ' background A' }); f.event({ id: 'pty-1', type: 'data', data: 'B' });
  assert.equal(f.terminals[0].output, 'early A background A'); assert.equal(f.terminals[1].output, 'B');
  f.c.activate(first); f.c.currentTerminal().terminal.input('echo A'); await f.flush();
  assert.equal(f.inputs[0].id, 'pty-0'); assert.notEqual(first, second);
});

test('closing a background tab kills only its process and retains active output', async () => {
  const f = fixture(), first = f.c.newTerminal(); await f.complete(0); const second = f.c.newTerminal(); await f.complete(1);
  await f.c.closeTab(first); assert.deepEqual(f.closes, ['pty-0']); assert.equal(f.c.get().activeId, second);
  assert.equal(f.terminals[0].disposed, true); assert.notEqual(f.terminals[1].disposed, true);
});

test('closing a pending tab discards its late process without recreating the tab', async () => {
  const f = fixture(), id = f.c.newTerminal(); await f.flush();
  assert.equal(f.starts.length, 1, 'transport is pending before the tab closes');
  await f.c.closeTab(id); assert.equal(f.c.get().tabs.length, 0);
  await f.complete(0); assert.deepEqual(f.closes, ['pty-0']); assert.equal(f.c.get().sessions.size, 0); assert.equal(f.terminals.length, 0);
});

test('failed launch can retry the same tab with its original project snapshot', async () => {
  const f = fixture(), id = f.c.newTerminal(); await f.complete(0, { ok: false, error: 'launch failed' });
  assert.equal(f.$('workspaceTerminalError').textContent, 'launch failed');
  f.c.context('draft-b', 'C:/Project B'); f.c.retry(); await f.flush(); assert.equal(f.starts[1].context.workingDir, 'C:/Project A');
  await f.complete(1); assert.equal(f.c.get().tabs.length, 1); assert.equal(f.c.get().tabs[0].id, id); assert.equal(f.$('workspaceTerminalError').textContent, '');
});

test('new project terminals bind independently and existing tabs never silently change root', async () => {
  const f = fixture(), first = f.c.newTerminal(); f.c.context('draft-b', 'C:/Project B'); const second = f.c.newTerminal();
  await f.complete(0); await f.complete(1); f.c.activate(first);
  assert.equal(f.c.currentTerminal().root, 'C:/Project A'); await f.c.openTerminal(); assert.equal(f.c.get().activeId, second); assert.equal(f.starts.length, 2);
});

test('late directory resolution cannot override an explicit tab selection or reopen a hidden panel', async () => {
  const f = fixture(), first = f.c.newTerminal(); await f.complete(0); const second = f.c.newTerminal(); await f.complete(1);
  f.c.context('managed', null); const held = f.holdResolve(), pending = f.c.openTerminal();
  f.c.activate(first); held.resolve({ ok: true, root: 'C:/Project A' }); await pending;
  assert.equal(f.c.get().activeId, first); assert.notEqual(first, second);
  const again = f.c.openTerminal(); f.c.hide(); held.resolve({ ok: true, root: 'C:/Other' }); await again; assert.equal(f.starts.length, 2);
});

test('natural exit preserves its output tab and stops forwarding input', async () => {
  const f = fixture(); f.c.newTerminal(); await f.complete(0);
  f.event({ id: 'pty-0', type: 'exit', exitCode: 0 }); f.event({ id: 'pty-0', type: 'exit', exitCode: 0 });
  assert.equal(f.c.get().tabs.length, 1); assert.match(f.c.get().tabs[0].title, /已结束/);
  assert.equal(f.terminals[0].output.match(/进程已退出/g).length, 1); f.terminals[0].input('ignored'); assert.equal(f.inputs.length, 0);
});

test('failed close keeps its tab available and a repeated close can succeed', async () => {
  const f = fixture(), id = f.c.newTerminal(); await f.complete(0); f.failClose(true); await f.c.closeTab(id);
  assert.equal(f.c.get().tabs.length, 1); assert.equal(f.$('workspaceTerminalError').textContent, 'close failed');
  f.failClose(false); await f.c.closeTab(id); assert.equal(f.c.get().tabs.length, 0);
});

test('renderer disposal closes a late startup without opening xterm', async () => {
  const f = fixture(); f.c.newTerminal(); await f.flush();
  assert.equal(f.starts.length, 1, 'transport is pending before renderer disposal');
  f.c.dispose(); await f.complete(0); assert.deepEqual(f.closes, ['pty-0']); assert.equal(f.terminals.length, 0);
});

test('closing a tab before library readiness avoids creating a process altogether', async () => {
  const f = fixture(), id = f.c.newTerminal();
  assert.equal(f.c.get().tabs.length, 1, 'the tab is available immediately');
  await f.c.closeTab(id); await f.flush();
  assert.equal(f.starts.length, 0); assert.deepEqual(f.closes, []);
  assert.equal(f.c.get().tabs.length, 0); assert.equal(f.c.get().pendingTerminals.size, 0);
});

test('renderer disposal before library readiness avoids creating a process altogether', async () => {
  const f = fixture(); f.c.newTerminal(); f.c.dispose(); await f.flush();
  assert.equal(f.starts.length, 0); assert.deepEqual(f.closes, []);
  assert.equal(f.terminals.length, 0); assert.equal(f.c.get().pendingTerminals.size, 0);
});
