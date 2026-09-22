'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ProviderStore } = require('../src/main/providers/provider-store');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`synthetic-vault:${value}`, 'utf8'),
  decryptString: value => value.toString('utf8').replace(/^synthetic-vault:/, ''),
};

function setup(t, schemaVersion = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let nextId = 0;
  const options = {
    userDataDir: dir, safeStorage, logger: { log() {}, warn() {} },
    now: () => new Date('2026-08-01T09:00:00.000Z'),
    randomId: () => `migration-${++nextId}`,
  };
  const store = new ProviderStore(options);
  const first = store.createProfile({
    name: 'Fast', apiKey: 'dummy-fast-key', baseUrl: 'https://fast.invalid/anthropic',
    models: { haiku: 'fast-model', sonnet: 'balanced-model' },
    imageModels: [{ adapterId: 'gpt-image-2', remoteModelId: 'image-model' }],
  }).profile;
  const second = store.createProfile({
    name: 'Expert', apiKey: 'dummy-expert-token', authMode: 'auth-token',
    baseUrl: 'https://expert.invalid', models: { opus: 'expert-model' },
  }).profile;
  const paths = store.paths();
  const before = JSON.parse(fs.readFileSync(paths.profiles, 'utf8'));
  before.schemaVersion = schemaVersion;
  before.profiles[0].revision = 4;
  before.profiles[1].revision = 9;
  fs.writeFileSync(paths.profiles, JSON.stringify(before, null, 2));
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir);
  const conversation = {
    id: 'existing-chat', title: 'Preserve my history', pinned: true,
    projectId: 'existing-project', workingDir: 'C:/RelayProjects/example',
    updatedAt: '2026-08-10T00:00:00.000Z',
    sessionId: 'legacy-native-session', sessionProviderId: first.id,
    sessionProviderRevision: 4, sessionRouteTier: 'haiku',
    turns: [{ user: 'previous question', assistant: 'previous answer' }],
  };
  const history = path.join(historyDir, 'existing-chat.json');
  fs.writeFileSync(history, JSON.stringify(conversation, null, 2));
  const index = path.join(historyDir, 'index.json');
  fs.writeFileSync(index, JSON.stringify([{ id: conversation.id, updatedAt: conversation.updatedAt, pinned: true }]));
  return { dir, options, store, first, second, paths, before, history, index };
}

test('v4 migration changes only schema and existing runtime revisions, preserving all configuration and history', t => {
  const f = setup(t);
  const secrets = fs.readFileSync(f.paths.secrets);
  const history = fs.readFileSync(f.history);
  const index = fs.readFileSync(f.index);
  const migrated = new ProviderStore(f.options);
  const routes = migrated.getRoutingView();
  const written = JSON.parse(fs.readFileSync(f.paths.profiles, 'utf8'));
  const expected = JSON.parse(JSON.stringify(f.before));
  expected.schemaVersion = 5;
  expected.profiles.forEach(profile => { profile.revision += 1; });
  assert.deepEqual(written, expected);
  assert.deepEqual(fs.readFileSync(f.paths.secrets), secrets);
  assert.deepEqual(fs.readFileSync(f.history), history);
  assert.deepEqual(fs.readFileSync(f.index), index);
  assert.deepEqual(routes.chatRoutes.map(route => [route.tier, route.providerRevision]), [
    ['haiku', 5], ['sonnet', 5], ['opus', 10],
  ]);
  assert.equal(routes.imageRoutes[0].providerRevision, 5);
  assert.equal(migrated.getChatRuntime('haiku').env.ANTHROPIC_API_KEY, 'dummy-fast-key');
  assert.equal(migrated.getChatRuntime('opus').env.ANTHROPIC_AUTH_TOKEN, 'dummy-expert-token');
  assert.equal(migrated.getChatRuntime('opus').modelId, 'expert-model');
});

test('the existing main resume guard rejects pre-isolation sessions and accepts newly recorded routes', t => {
  const f = setup(t);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
  const start = main.indexOf('function sessionRouteMatchesProvider(');
  const end = main.indexOf('\nfunction publishProviderChange(', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ RELAY_MODEL_TIERS: new Set(['haiku', 'sonnet', 'opus']) });
  vm.runInContext(main.slice(start, end), context);
  const target = new ProviderStore(f.options).getRoutingView().chatRoutes.find(route => route.tier === 'haiku');
  const current = { providerId: target.providerId, providerRevision: target.providerRevision, routeTier: 'haiku' };
  const legacy = { ...current, providerRevision: 4 };
  assert.equal(context.sessionRouteMatchesProvider(legacy, current), false);
  assert.equal(context.sessionRouteMatchesProvider(current, current), true);
});

test('normalization, repeated initialization, and restart never increment v5 revisions again', t => {
  const f = setup(t);
  assert.equal(f.store.readState().profiles[0].revision, 5);
  assert.equal(f.store.readState().profiles[0].revision, 5);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.profiles, 'utf8')).schemaVersion, 4,
    'read-only normalization must not write the migration');
  const migrated = new ProviderStore(f.options);
  assert.equal(migrated.getChatRuntime('haiku').revision, 5);
  const persisted = fs.readFileSync(f.paths.profiles);
  assert.equal(migrated.getChatRuntime('haiku').revision, 5);
  assert.equal(new ProviderStore(f.options).getChatRuntime('haiku').revision, 5);
  assert.deepEqual(fs.readFileSync(f.paths.profiles), persisted);
});

test('failed migration persistence prevents runtime publication and a retry increments exactly once', t => {
  const f = setup(t);
  const original = fs.readFileSync(f.paths.profiles);
  const migrated = new ProviderStore(f.options);
  const writeState = migrated.writeState;
  migrated.writeState = () => { throw new Error('synthetic disk failure'); };
  assert.throws(() => migrated.getChatRuntime('haiku'), /synthetic disk failure/);
  assert.deepEqual(fs.readFileSync(f.paths.profiles), original);
  migrated.writeState = writeState;
  assert.equal(migrated.getChatRuntime('haiku').revision, 5);
  assert.equal(new ProviderStore(f.options).getChatRuntime('haiku').revision, 5);
});

test('backup recovery migrates the recovered old runtime version before use', t => {
  const f = setup(t);
  fs.copyFileSync(f.paths.profiles, `${f.paths.profiles}.bak`);
  fs.writeFileSync(f.paths.profiles, '{broken');
  const migrated = new ProviderStore(f.options);
  assert.equal(migrated.getChatRuntime('haiku').revision, 5);
  assert.equal(migrated.getChatRuntime('opus').revision, 10);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.profiles, 'utf8')).schemaVersion, 5);
});

test('profiles created after isolation still start at revision one', t => {
  const f = setup(t, 5);
  const current = new ProviderStore(f.options);
  assert.equal(current.getChatRuntime('haiku').revision, 4, 'current schema must keep its saved revision');
  const fresh = current.createProfile({
    name: 'New', apiKey: 'dummy-new-key', baseUrl: 'https://new.invalid',
    models: { haiku: 'new-model' }, claimUnassignedRoutes: false,
  }).profile;
  assert.equal(fresh.revision, 1);
  assert.equal(new ProviderStore(f.options).getProfile(fresh.id).revision, 1);
});
