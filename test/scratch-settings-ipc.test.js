'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSettingsIpc } = require('../src/main/app/settings-ipc');
const { createGeneralPreferences } = require('../src/main/app/general-preferences');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, initial = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scratch-settings-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const target = path.join(root, 'alternate scratch'); fs.mkdirSync(target);
  let state = { ...initial }, persist = true;
  const handlers = new Map(), changes = [], writes = [];
  const service = options.service || createGeneralPreferences({ userDataDir: root, getSettings: () => state });
  registerSettingsIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app: {},
    providerStore: { getSettingsView: () => ({}) }, generalPreferences: service,
    readAppSettings: () => ({ ...state }),
    writeAppSettings: value => { if (!persist) throw Error('synthetic disk failure'); state = { ...value }; writes.push(state); options.onWrite?.(state); },
    windows: { applyTheme() {}, updateNativeBrandTheme() {} },
    applyParallelTaskLimit() {}, publishProviderChange() {}, onEnvironmentChanged() {}, onQuickChatChanged() {}, refreshMiniBrand() {},
    onScratchRootChanged: change => { changes.push({ ...change, persisted: { ...state } }); return options.onChange?.(change); },
  });
  return { root, target, service, changes, writes, write: patch => handlers.get('settings:write')({}, { app: patch }),
    failWrites: () => { persist = false; }, state: () => ({ ...state }) };
}

test('scratch migration starts only after a successful settings save and never waits for completion', async t => {
  let release;
  const migrating = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, { workspaceRoot: '/unrelated/outputs' }, { onChange: () => migrating });
  const original = f.service.scratchRoot();
  assert.equal((await f.write({ scratchRoot: f.target })).ok, true);
  assert.equal(f.changes.length, 0, 'the save response does not await or invoke migration');
  assert.equal(f.state().scratchRoot, f.target);
  await tick();
  assert.equal(f.changes.length, 1);
  assert.deepEqual(f.changes[0], { previousRoot: original, root: f.target,
    persisted: { workspaceRoot: '/unrelated/outputs', scratchRoot: f.target } });
  assert.equal((await f.write({ scratchRoot: '' })).ok, true);
  await tick();
  assert.equal(f.changes[1].root, original);
  assert.equal(f.changes[1].previousRoot, f.target);
});

test('unchanged effective scratch paths and unrelated changes do not start migration', async t => {
  const f = fixture(t);
  const original = f.service.scratchRoot(); fs.mkdirSync(original);
  await f.write({ scratchRoot: original });
  await f.write({ scratchRoot: '' });
  await f.write({ maxParallelTasks: 6 });
  await f.write({ workspaceRoot: f.target });
  await tick();
  assert.equal(f.changes.length, 0);
  assert.equal(f.state().workspaceRoot, f.target);
});

test('validation and persistence failures leave the original scratch root and never migrate', async t => {
  const f = fixture(t);
  assert.equal((await f.write({ scratchRoot: path.join(f.root, 'missing') })).ok, false);
  assert.equal(f.writes.length, 0);
  f.failWrites();
  const failed = await f.write({ scratchRoot: f.target });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /synthetic disk failure/);
  await tick();
  assert.equal(f.changes.length, 0);
  assert.equal(f.state().scratchRoot, undefined);
});

test('Windows equivalent casing and separators do not trigger a redundant migration', async t => {
  let root = 'D:\\Relay Scratch';
  const service = { validatePatch: async patch => patch, scratchRoot: () => root };
  const f = fixture(t, {}, { service, onWrite: state => { root = state.scratchRoot; } });
  await f.write({ scratchRoot: 'd:/relay scratch/' });
  await tick();
  assert.equal(f.changes.length, 0);
  await f.write({ scratchRoot: 'E:\\Another Root' });
  await tick();
  assert.equal(f.changes.length, 1);
});

test('a failing migration callback does not undo saved settings or become an unhandled rejection', async t => {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = previous; });
  const f = fixture(t, {}, { onChange: () => Promise.reject(Error('synthetic migration failure')) });
  assert.equal((await f.write({ scratchRoot: f.target })).ok, true);
  await tick(); await tick();
  assert.equal(f.state().scratchRoot, f.target);
  assert.equal(f.changes.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /synthetic migration failure/);
});
