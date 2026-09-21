'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createProviderDraftRuntime, discoverProviderModels } = require('../provider-connectivity');
const { ProviderStore } = require('../provider-store');

const catalog = { data: [
  { id: 'allowed-chat', object: 'model', owned_by: 'example', model_type: 'chat' },
  { id: 'other-chat', object: 'model', owned_by: 'example', model_type: 'chat' },
  { id: 'gpt-image-2', object: 'model', owned_by: 'example', model_type: 'image' },
] };
const images = [{ adapterId: 'gpt-image-2', remoteModelId: 'gpt-image-2' }];
const savedRuntime = () => ({
  authMode: 'auth-token',
  models: { haiku: 'allowed-chat' },
  env: {
    ANTHROPIC_BASE_URL: 'https://fixture.invalid/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'fixture-saved-key',
  },
});

for (const fixture of [
  { name: 'blank draft key reuses only the saved credential', key: '', header: 'authorization', value: 'Bearer fixture-saved-key' },
  { name: 'new draft key replaces the saved credential', key: 'fixture-draft-key', header: 'x-api-key', value: 'fixture-draft-key' },
  { name: 'Bearer draft key keeps its requested authentication header', key: 'Bearer fixture-draft-token', header: 'authorization', value: 'Bearer fixture-draft-token' },
]) {
  test(`catalog discovery: ${fixture.name}`, async () => {
    const saved = savedRuntime();
    const before = JSON.stringify(saved);
    const runtime = createProviderDraftRuntime({ apiKey: fixture.key }, saved);
    const requests = [];
    const result = await discoverProviderModels(runtime, {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(catalog), { status: 200 });
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://fixture.invalid/anthropic/v1/models');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.body, undefined);
    assert.equal(requests[0].options.headers[fixture.header], fixture.value);
    assert.equal(requests[0].options.headers[fixture.header === 'authorization' ? 'x-api-key' : 'authorization'], undefined);
    assert.equal(result.ok, true);
    assert.equal(result.accessVerified, false);
    assert.match(result.message, /模型目录.*图像候选.*Key 权限未验证/);
    assert.deepEqual(result.models, ['allowed-chat', 'other-chat', 'gpt-image-2']);
    assert.deepEqual(result.imageModels, images);
    assert.equal(JSON.stringify(result).includes(fixture.value.replace(/^Bearer /, '')), false);
    assert.equal(JSON.stringify(saved), before);
  });
}

test('shared gateway catalog keeps authentication and does not claim model access', async () => {
  const requests = [];
  const result = await discoverProviderModels(savedRuntime(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/anthropic/')) {
        return new Response(JSON.stringify({ error: { message: 'route not found' } }), { status: 404 });
      }
      return new Response(JSON.stringify(catalog), { status: 200 });
    },
  });
  assert.deepEqual(requests.map(item => item.url), [
    'https://fixture.invalid/anthropic/v1/models',
    'https://fixture.invalid/v1/models',
  ]);
  for (const request of requests) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.authorization, 'Bearer fixture-saved-key');
    assert.equal(request.options.headers['x-api-key'], undefined);
  }
  assert.equal(result.gatewayRootFallbackUsed, true);
  assert.equal(result.accessVerified, false);
  assert.match(result.message, /共享模型目录.*Key 权限未验证/);
  assert.deepEqual(result.models, ['allowed-chat', 'other-chat', 'gpt-image-2']);
});

test('empty catalog and missing credentials never claim verified access', async () => {
  const empty = await discoverProviderModels(savedRuntime(), {
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.accessVerified, false);
  assert.match(empty.message, /没有返回模型.*Key 权限未验证/);
  let requested = false;
  const missing = await discoverProviderModels({ env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid' } }, {
    fetchImpl: async () => { requested = true; throw new Error('must not request'); },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.accessVerified, false);
  assert.equal(requested, false);
});

function fixtureStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const store = new ProviderStore({
    userDataDir: dir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    },
    logger: { log() {}, warn() {} },
  });
  const profile = store.createProfile({
    name: 'Discovery fixture', baseUrl: 'https://fixture.invalid/anthropic', apiKey: 'fixture-only-key',
    models: {}, claimUnassignedRoutes: false,
  }).profile;
  return { store, profile };
}

test('catalog discovery cannot claim empty image routes, including a legacy automatic-claim flag', t => {
  const { store, profile } = fixtureStore(t);
  const found = store.setDiscoveredImageModels(profile.id, images, { claimUnassignedRoutes: true });
  assert.equal(found.routeAssignmentsChanged, false);
  assert.deepEqual(found.profile.imageModels, images);
  assert.deepEqual(found.profile.activeImageAdapters, []);
  assert.deepEqual(store.listImageRoutes(), []);
  store.updateProfile(profile.id, { name: 'Renamed discovery fixture' });
  assert.deepEqual(store.listImageRoutes(), [], 'editing metadata cannot claim a catalog candidate');
  store.setImageRoute('gpt-image-2', profile.id);
  assert.equal(store.getImageRuntime().remoteModelId, 'gpt-image-2');
  const refreshed = store.setDiscoveredImageModels(profile.id, [
    { adapterId: 'gpt-image-2', remoteModelId: 'tenant/gpt-image-2-v2' },
    { adapterId: 'seedream-5.0', remoteModelId: 'tenant/seedream-5.0' },
  ]);
  assert.deepEqual(refreshed.profile.activeImageAdapters, ['gpt-image-2']);
  assert.equal(store.getImageRuntime().remoteModelId, 'tenant/gpt-image-2-v2');
  assert.equal(store.listImageRoutes().length, 1);
});

test('clearing the last image route remains empty when configuration is read again', t => {
  const { store, profile } = fixtureStore(t);
  store.setDiscoveredImageModels(profile.id, images, { imageRouteAdapters: ['gpt-image-2'] });
  store.setImageRoute('gpt-image-2', null);
  assert.deepEqual(store.getRoutingView().imageRoutes, []);
  assert.deepEqual(store.getProfile(profile.id).activeImageAdapters, []);
  assert.deepEqual(store.listImageRoutes(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8')).imageRoutes, {});
});

test('v3 image capability migration runs once and retains later empty route choices', t => {
  const { store, profile } = fixtureStore(t);
  store.setDiscoveredImageModels(profile.id, images);
  const state = JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8'));
  state.schemaVersion = 3;
  delete state.imageRoutes;
  fs.writeFileSync(store.paths().profiles, JSON.stringify(state));
  assert.equal(store.listImageRoutes()[0].providerId, profile.id);
  assert.equal(JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8')).schemaVersion, 5);
  store.setImageRoute('gpt-image-2', null);
  assert.deepEqual(store.listImageRoutes(), []);
});

test('an explicit image adapter selection still assigns its discovered route', t => {
  const { store, profile } = fixtureStore(t);
  const found = store.setDiscoveredImageModels(profile.id, images, { imageRouteAdapters: ['gpt-image-2'] });
  assert.equal(found.routesChanged, true);
  assert.deepEqual(found.profile.activeImageAdapters, ['gpt-image-2']);
  assert.equal(store.listImageRoutes()[0].providerId, profile.id);
});

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function savedDiscoveryHandler(store, discover) {
  let handler;
  const mutations = [];
  const publishes = [];
  for (const name of ['setAuthMode', 'setDiscoveredImageModels']) {
    const original = store[name].bind(store);
    store[name] = (...args) => { mutations.push(name); return original(...args); };
  }
  const context = {
    ipcMain: { handle(name, callback) { assert.equal(name, 'providers:discoverModels'); handler = callback; } },
    providerStore: store,
    discoverProviderModels: discover,
    publishProviderChange: (...args) => publishes.push(args),
  };
  const start = main.indexOf("ipcMain.handle('providers:discoverModels',");
  assert.ok(start > 0);
  const end = main.indexOf('\n});', start) + '\n});'.length;
  vm.runInNewContext(main.slice(start, end), context);
  return { handler, mutations, publishes };
}
const discovered = (patch = {}) => ({
  ok: true, accessVerified: false, authMode: 'auth-token',
  models: ['gpt-image-2'], modelCatalog: [{ id: 'gpt-image-2', value: 'gpt-image-2' }],
  imageModels: images, totalModels: 1, message: '模型目录 · Key 权限未验证', ...patch,
});

for (const change of ['key', 'URL', 'removed']) {
  test(`saved discovery discards a pending result after the profile ${change} changes`, async t => {
    const { store, profile } = fixtureStore(t);
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const h = savedDiscoveryHandler(store, async () => pending);
    const request = h.handler({}, profile.id);
    if (change === 'removed') store.removeProfile(profile.id);
    else store.updateProfile(profile.id, change === 'key'
      ? { apiKey: 'fixture-replacement-key' }
      : { baseUrl: 'https://different.invalid/anthropic' });
    const current = store.getProfile(profile.id);
    resolve(discovered());
    const result = await request;
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.equal(result.models.length, 0);
    assert.equal(result.modelCatalog.length, 0);
    assert.equal(result.imageModels.length, 0);
    assert.equal(result.totalModels, 0);
    assert.deepEqual(h.mutations, []);
    assert.deepEqual(h.publishes, []);
    assert.deepEqual(store.getProfile(profile.id), current);
  });
}

test('current saved discovery returns the final auth revision without auto-assigning routes', async t => {
  const { store, profile } = fixtureStore(t);
  const h = savedDiscoveryHandler(store, async () => discovered());
  const result = await h.handler({}, profile.id);
  assert.equal(result.ok, true);
  assert.equal(result.accessVerified, false);
  assert.equal(result.profile.revision, profile.revision + 1);
  assert.equal(result.profile.authMode, 'auth-token');
  assert.deepEqual(result.profile.imageModels, images);
  assert.deepEqual(result.profile.activeImageAdapters, []);
  assert.deepEqual(store.listImageRoutes(), []);
  assert.deepEqual(h.mutations, ['setAuthMode', 'setDiscoveredImageModels']);
});

test('shared catalog authentication does not rewrite saved messages authentication', async t => {
  const { store, profile } = fixtureStore(t);
  const h = savedDiscoveryHandler(store, async () => discovered({ gatewayRootFallbackUsed: true }));
  const result = await h.handler({}, profile.id);
  assert.equal(result.ok, true);
  assert.equal(result.profile.revision, profile.revision);
  assert.equal(result.profile.authMode, 'api-key');
  assert.deepEqual(h.mutations, ['setDiscoveredImageModels']);
  assert.deepEqual(store.listImageRoutes(), []);
});
