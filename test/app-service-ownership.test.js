'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHistoryStore } = require('../src/main/app/history-store');
const { createAppSettingsService } = require('../src/main/app/app-settings-service');
const { registerApplicationLifecycle } = require('../src/main/app/application-lifecycle');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Factory operation did not settle');
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-app-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('history stores resolve userData lazily and recover their own index without changing activity times', t => {
  const root = temp(t), original = path.join(root, 'before-configuration'), selected = path.join(root, 'selected');
  let userData = original, resolutions = 0;
  const recoveredRoots = [];
  const store = createHistoryStore({
    getUserDataDir: () => { resolutions++; return userData; },
    recoverLegacyOutput: (record, { rootDir }) => { recoveredRoots.push(rootDir); return record; },
  });
  assert.equal(resolutions, 0);
  assert.equal(fs.existsSync(original), false);
  userData = selected;
  const record = { id: 'saved', title: 'Earlier task', updatedAt: '2020-01-01T00:00:00Z', turns: [{ user: 'u', assistant: 'a' }] };
  store.persistConversationRecord(record);
  assert.equal(fs.existsSync(original), false);
  fs.writeFileSync(store.historyIndexPath(), 'interrupted-index-write');
  const rebuilt = store.readHistoryIndex();
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].updatedAt, record.updatedAt);
  assert.deepEqual(store.loadConversation(record.id), record);
  assert.equal(recoveredRoots.at(-1), path.join(selected, 'task-ledger'));
  const other = createHistoryStore({ getUserDataDir: () => path.join(root, 'other'), recoverLegacyOutput: record => record });
  assert.equal(other.loadConversation(record.id), null);
  assert.equal(store.loadConversation(record.id).id, record.id);
});

test('history migration resumes without overwriting an already persisted conversation and retains the legacy backup', t => {
  const root = temp(t), store = createHistoryStore({ getUserDataDir: () => root, recoverLegacyOutput: record => record });
  const current = { id: 'existing', title: 'newer body', turns: [] };
  store.persistConversationRecord(current);
  const legacy = path.join(root, 'history.json');
  fs.writeFileSync(legacy, JSON.stringify({ conversations: [{ ...current, title: 'stale body' }, { id: 'not-yet-migrated', title: 'old task', turns: [] }] }));
  store.migrateHistoryV1();
  assert.deepEqual(store.loadConversation(current.id), current);
  assert.equal(store.loadConversation('not-yet-migrated').title, 'old task');
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(legacy + '.bak'), true);
  store.migrateHistoryV1();
  assert.equal(store.readHistoryIndex().length, 2);
});

test('settings persistence publishes a fresh cache snapshot to its callback and keeps service instances isolated', t => {
  const root = temp(t), seen = [];
  const defaults = { permissionMode: 'default', providerIsolationSettingsVersion: 1, imageProviderMigrationVersion: 1,
    firstRunSetupVersion: 1, sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false };
  let first;
  first = createAppSettingsService({
    getUserDataDir: () => path.join(root, 'first'), providerStore: {},
    onWrite: () => seen.push(first.readAppSettings()),
  });
  const second = createAppSettingsService({ getUserDataDir: () => path.join(root, 'second'), providerStore: {} });
  first.writeAppSettings({ ...defaults, theme: 'light', nested: { selected: 'first' } });
  second.writeAppSettings({ ...defaults, theme: 'system', nested: { selected: 'second' } });
  const stale = first.readAppSettings();
  stale.nested.selected = 'unsaved edit';
  first.writeAppSettings({ ...defaults, theme: 'dark', nested: { selected: 'persisted' } });
  assert.equal(seen.at(-1).theme, 'dark');
  assert.equal(seen.at(-1).nested.selected, 'persisted');
  assert.equal(first.readAppSettings().nested.selected, 'persisted');
  assert.equal(second.readAppSettings().nested.selected, 'second');
  assert.equal(second.readAppSettings().theme, 'system');
  assert.equal(fs.existsSync(path.join(root, 'first', 'app-settings.json.tmp')), false);
});

test('quit drains late-created services once in order before releasing the existing task maps', async () => {
  const events = [], gates = {};
  const gated = name => { events.push(name); return new Promise(resolve => { gates[name] = resolve; }); };
  const app = new EventEmitter();
  app.whenReady = () => new Promise(() => {});
  app.quit = () => app.emit('before-quit', { preventDefault() {} });
  let quitting = false, draft = null, miniChat = null, usage = null, progress = null;
  const jobs = new Map(), liveSessions = new Map(), resourceLeases = new Map();
  const controller = registerApplicationLifecycle({
    app, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {}, powerMonitor: { removeListener() {} },
    globalShortcut: { unregisterAll() {} },
    windows: {
      markQuitting: () => { quitting = true; }, get isQuitting() { return quitting; },
      destroyTray: () => events.push('tray-disposed'),
    },
    settings: {}, history: {}, scheduler: { shutdown: () => events.push('scheduler-stopped') },
    getSkillDraftService: () => draft, getExistingUsageStatsService: () => usage,
    taskRuntime: {
      jobs, liveSessions, resourceLeases, interactions: { close: () => events.push('interactions-closed') },
      getProgressStore: () => progress, getOrchestrator: () => null,
      getLedger: () => ({ flush: () => events.push('ledger-flushed') }),
      flushStreams: () => events.push('streams-flushed'), flushEvents() {},
      killLiveSession: session => { events.push('session-killed'); liveSessions.delete(session.id); },
      interruptActiveRuns: () => events.push('runs-interrupted'),
    },
    mini: { getChat: () => miniChat, getHost: () => ({ destroy: () => events.push('mini-window-disposed') }) },
    memory: { hasPendingUsage: () => false },
    integrations: { attachmentDialog: { dispose() {} }, browserPanelTools: { dispose() {} }, workspaceTools: { dispose() {} } },
  });
  // Services and task entries are created after registration, as during normal use.
  draft = { close: () => gated('draft') };
  miniChat = { shutdown: () => gated('mini'), destroy: () => events.push('mini-disposed') };
  usage = { destroy: () => gated('usage') };
  progress = { close: () => gated('progress') };
  jobs.set('job', { kill: () => events.push('job-killed') });
  liveSessions.set('session', { id: 'session' });
  resourceLeases.set('lease', { release: () => events.push('lease-released') });
  const quit = () => app.emit('before-quit', { preventDefault() {} });
  quit(); quit();
  assert.equal(quitting, true);
  assert.equal(controller.isUsageClosed(), false);
  assert.deepEqual(events, ['draft']);
  for (const [name, next] of [['draft', 'mini'], ['mini', 'usage'], ['usage', 'progress']]) {
    gates[name]();
    await waitFor(() => !!gates[next]);
    quit();
    assert.equal(events.filter(item => item === next).length, 1);
    assert.equal(events.includes('lease-released'), false);
    assert.equal(events.includes('job-killed'), false);
  }
  assert.equal(controller.isUsageClosed(), true);
  gates.progress();
  await waitFor(() => events.includes('tray-disposed'));
  assert.deepEqual(events.filter(item => ['draft', 'mini', 'usage', 'progress'].includes(item)), ['draft', 'mini', 'usage', 'progress']);
  assert.equal(events.filter(item => item === 'mini-disposed').length, 1);
  assert.equal(events.filter(item => item === 'job-killed').length, 1);
  assert.equal(events.filter(item => item === 'session-killed').length, 1);
  assert.equal(jobs.size, 0);
  assert.equal(liveSessions.size, 0);
  assert.equal(resourceLeases.size, 0);
  assert.ok(events.indexOf('lease-released') > events.indexOf('progress'));
});
