'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ProviderStore } = require('../provider-store');
const { isAppPermissionMode } = require('../interaction-broker');
const { createGeneralPreferences, normalizePreferences } = require('../general-preferences');
const { isQuickChatEnabled, normalizeQuickChatPatch } = require('../mini-window-host');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(t, models = { haiku: 'fast', sonnet: 'think', opus: 'expert' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-default-tier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const options = { userDataDir: root,
    randomId: () => `fixture-${++sequence}`, now: () => new Date('2026-09-08T00:00:00Z'),
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from('fixture:' + value),
      decryptString: value => value.toString().slice(8) },
    logger: { log() {}, warn() {} },
  };
  const store = new ProviderStore(options);
  const profile = store.createProfile({ name: 'Primary', apiKey: 'dummy-primary',
    baseUrl: 'https://primary.invalid', models }).profile;
  const read = () => JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8'));
  const write = state => fs.writeFileSync(store.paths().profiles, JSON.stringify(state, null, 2));
  return { root, options, store, profile, read, write };
}

function settingsHarness(store, initial = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const from = source.indexOf("ipcMain.handle('settings:read'");
  const end = source.indexOf('// IPC: Relay 服务商管理', from);
  assert.ok(from > 0 && end > from);
  let appSettings = { permissionMode: 'default', ...initial };
  const handlers = {}, events = [], writes = [];
  const context = vm.createContext({ providerStore: store, Object,
    isQuickChatEnabled, normalizeQuickChatPatch,
    normalizePreferences, generalPreferences: createGeneralPreferences({ getSettings: () => appSettings }),
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    readAppSettings: () => copy(appSettings),
    writeAppSettings: next => { appSettings = copy(next); writes.push(copy(next)); },
    publishProviderChange: (reason, options = {}) => events.push({ reason, options, persisted: store.getRoutingView() }),
    app: { getVersion: () => 'test' }, isAppPermissionMode,
    miniHost: null, miniBrandCache: null, publishMiniState() {},
    applyPermissionModeToLiveSessions: async () => ({ updated: true }),
  });
  vm.runInContext(source.slice(from, end), context);
  return { context, events, writes,
    read: () => handlers['settings:read'](),
    write: payload => handlers['settings:write']({}, payload),
    appSettings: () => copy(appSettings),
  };
}

test('provider create, edit, duplicate, and legacy default inputs cannot change the global new-chat tier', t => {
  const f = fixture(t);
  f.store.setDefaultModel('sonnet');
  const before = f.store.getProfile(f.profile.id);
  const ignored = f.store.updateProfile(f.profile.id, { defaultModel: 'opus' });
  assert.equal(ignored.changed, false);
  assert.deepEqual(ignored.profile, before);
  const second = f.store.createProfile({ name: 'Secondary', apiKey: 'dummy-secondary',
    baseUrl: 'https://secondary.invalid', models: { haiku: 'other-fast', opus: 'other-expert' },
    defaultModel: 'opus' }).profile;
  f.store.duplicateProfile(second.id);
  assert.equal(f.store.getSettingsView().defaultModel, 'sonnet');
  assert.equal(f.store.getActiveRuntime().tier, 'sonnet');
  assert.equal(f.read().defaultModel, 'sonnet');
});

test('invalid general preferences fail before provider default or any other local setting is persisted', async t => {
  const f = fixture(t), h = settingsHarness(f.store, { followUpMode: 'steer' });
  const previous = f.store.getRoutingView().defaultModel;
  const result = await h.write({ claude: { defaultModel: previous === 'opus' ? 'haiku' : 'opus' }, app: { followUpMode: 'stop-without-consent' } });
  assert.equal(result.ok, false); assert.equal(result.code, 'INVALID_PREFERENCE');
  assert.equal(f.store.getRoutingView().defaultModel, previous); assert.equal(h.writes.length, 0); assert.equal(h.events.length, 0);
  const accepted = await h.write({ app: { followUpMode: 'queue' } });
  assert.equal(accepted.ok, true); assert.equal(h.appSettings().followUpMode, 'queue');
  assert.equal(f.store.getRoutingView().defaultModel, previous);
});

test('Relay instructions and context display validate atomically before any settings or provider change', async t => {
  const f = fixture(t), h = settingsHarness(f.store);
  assert.equal(h.read().app.relayInstructions, '');
  assert.equal(h.read().app.showContextUsage, true);
  const previousModel = f.store.getRoutingView().defaultModel;
  for (const patch of [{ relayInstructions: 'x'.repeat(10001) }, { relayInstructions: null },
    { relayInstructions: {} }, { showContextUsage: 'false' }, { showContextUsage: null }]) {
    const result = await h.write({ app: { conversationIndex: false, ...patch }, claude: { defaultModel: 'opus' } });
    assert.equal(result.ok, false);
    assert.equal(h.writes.length, 0); assert.equal(f.store.getRoutingView().defaultModel, previousModel);
  }
  const guidance = '回答简洁。\n默认使用中文。';
  assert.equal((await h.write({ app: { relayInstructions: guidance, showContextUsage: false } })).ok, true);
  assert.equal(h.read().app.relayInstructions, guidance); assert.equal(h.read().app.showContextUsage, false);
  assert.equal((await h.write({ app: { relayInstructions: '' } })).ok, true);
  assert.equal(h.read().app.relayInstructions, ''); assert.equal(h.read().app.showContextUsage, false);
});

test('global setter accepts only usable assigned tiers and does not mutate provider versions or secrets', t => {
  const f = fixture(t, { haiku: 'fast', sonnet: 'think' });
  const before = f.read();
  const secrets = fs.readFileSync(f.store.paths().secrets);
  for (const tier of ['opus', '', 'constructor', 'deepseek/model']) {
    assert.throws(() => f.store.setDefaultModel(tier), /档位/);
    assert.deepEqual(f.read(), before);
  }
  assert.equal(f.store.setDefaultModel('sonnet').changed, true);
  assert.deepEqual(f.read().profiles, before.profiles);
  assert.deepEqual(fs.readFileSync(f.store.paths().secrets), secrets);
  const persisted = fs.readFileSync(f.store.paths().profiles);
  assert.equal(f.store.setDefaultModel('sonnet').changed, false);
  assert.deepEqual(fs.readFileSync(f.store.paths().profiles), persisted);
});

test('first configured tier and removal of the selected route choose a remaining available tier', t => {
  const f = fixture(t, { sonnet: 'think', opus: 'expert' });
  assert.equal(f.store.getRoutingView().defaultModel, 'sonnet');
  f.store.setDefaultModel('opus');
  f.store.updateProfile(f.profile.id, { models: { opus: '' }, defaultModel: 'opus' });
  assert.equal(f.store.getRoutingView().defaultModel, 'sonnet');
  assert.equal(new ProviderStore(f.options).getActiveRuntime().modelId, 'think');
});

test('old unusable default routes fall back without changing provider revisions or timestamps', t => {
  const f = fixture(t, { haiku: 'fast' });
  const other = f.store.createProfile({ name: 'Other', apiKey: 'dummy-other',
    baseUrl: 'https://other.invalid', models: { opus: 'expert' } }).profile;
  const state = f.read();
  state.profiles.find(profile => profile.id === f.profile.id).enabled = false;
  f.write(state);
  const reopened = new ProviderStore(f.options);
  assert.equal(reopened.getRoutingView().defaultModel, 'opus');
  assert.equal(reopened.getActiveRuntime().id, other.id);
  assert.deepEqual(f.read().profiles, state.profiles);
  assert.throws(() => reopened.setDefaultModel('haiku'), /可用模型/);
});

test('legacy per-provider default migrates once only when no global preference was saved', t => {
  const f = fixture(t);
  const legacy = f.read();
  legacy.schemaVersion = 3;
  legacy.profiles[0].defaultModel = 'opus';
  delete legacy.defaultModel;
  delete legacy.chatRoutes;
  delete legacy.imageRoutes;
  f.write(legacy);
  const upgraded = new ProviderStore(f.options);
  assert.equal(upgraded.getSettingsView().defaultModel, 'opus');
  assert.equal(f.read().schemaVersion, 5);
  upgraded.setDefaultModel('sonnet');
  assert.equal(new ProviderStore(f.options).getSettingsView().defaultModel, 'sonnet');
  assert.equal(f.read().profiles[0].defaultModel, 'opus', 'legacy compatibility metadata has no authority over global preference');
});

test('behavior settings IPC persists the global field, returns authoritative routes, and broadcasts without runtime restart', async t => {
  const f = fixture(t);
  const h = settingsHarness(f.store);
  assert.equal(h.read().claude.defaultModel, 'haiku');
  const before = f.read().profiles;
  const result = await h.write({ claude: { defaultModel: 'opus' }, app: { conversationIndex: false } });
  assert.equal(result.ok, true);
  assert.equal(result.routes.defaultModel, 'opus');
  assert.equal(h.read().claude.defaultModel, 'opus');
  assert.equal(h.read().claude.routes.defaultModel, 'opus');
  assert.equal(Object.hasOwn(h.appSettings(), 'defaultModel'), false);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].persisted.defaultModel, 'opus');
  assert.notEqual(h.events[0].options.runtimeChanged, true);
  assert.deepEqual(f.read().profiles, before);
  await h.write({ claude: { defaultModel: 'opus' } });
  assert.equal(h.events.length, 1, 'same default does not emit a second change');
});

test('invalid permission or unavailable default rejects behavior save before changing either store', async t => {
  const f = fixture(t, { haiku: 'fast' });
  const h = settingsHarness(f.store);
  const before = f.read();
  const permission = await h.write({ claude: { defaultModel: 'haiku' }, app: { permissionMode: 'invalid' } });
  assert.equal(permission.ok, false);
  const missing = await h.write({ claude: { defaultModel: 'opus', alwaysThinking: true }, app: { conversationIndex: false } });
  assert.equal(missing.ok, false);
  assert.deepEqual(f.read(), before);
  assert.equal(h.writes.length, 0);
  assert.equal(h.events.length, 0);
});

test('provider persistence failure returns an error before app persistence and change notification', async t => {
  const f = fixture(t);
  const h = settingsHarness(f.store);
  f.store.writeState = () => { throw new Error('synthetic provider disk failure'); };
  const result = await h.write({ claude: { defaultModel: 'opus' }, app: { conversationIndex: false } });
  assert.equal(result.ok, false);
  assert.match(result.message, /provider disk failure/);
  assert.equal(f.read().defaultModel, 'haiku');
  assert.equal(h.writes.length, 0);
  assert.equal(h.events.length, 0);
});

test('app persistence failure explains that the default was saved and does not report success', async t => {
  const f = fixture(t);
  const h = settingsHarness(f.store);
  h.context.writeAppSettings = () => { throw new Error('synthetic app disk failure'); };
  const result = await h.write({ claude: { defaultModel: 'opus' }, app: { conversationIndex: false } });
  assert.equal(result.ok, false);
  assert.match(result.message, /默认档位已保存.*app disk failure/);
  assert.equal(f.read().defaultModel, 'opus');
  assert.equal(h.events.length, 0);
});

test('ordinary behavior saves never overwrite the default and cannot create a duplicate app default field', async t => {
  const f = fixture(t);
  f.store.setDefaultModel('opus');
  const h = settingsHarness(f.store, { defaultModel: 'haiku', alwaysThinking: true });
  f.store.setDefaultModel = () => { assert.fail('no explicit global-default update was submitted'); };
  const result = await h.write({ claude: {}, app: { conversationIndex: false, defaultModel: 'sonnet' } });
  assert.equal(result.ok, true);
  assert.equal(f.read().defaultModel, 'opus');
  assert.equal(h.events.length, 0);
  assert.equal(Object.hasOwn(h.appSettings(), 'defaultModel'), false);
  assert.equal(h.appSettings().alwaysThinking, true, 'ordinary saves retain the unused legacy preference');
});
