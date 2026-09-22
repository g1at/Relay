'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const loadCommonJs = require('./helpers/load-commonjs.cjs');
const { createProviderDraftRuntime, runtimeModel } = require('../src/main/providers/provider-connectivity');
const { ProviderStore } = require('../src/main/providers/provider-store');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const saved = () => ({ id: 'synthetic', revision: 1, defaultModel: 'haiku', authMode: 'auth-token',
  models: { haiku: 'saved-fast', sonnet: 'saved-medium', opus: 'saved-expert' },
  env: { ANTHROPIC_BASE_URL: 'https://saved.invalid/anthropic', ANTHROPIC_AUTH_TOKEN: 'synthetic-saved-key', ANTHROPIC_MODEL: 'must-not-leak' } });
const draft = () => ({ id: 'synthetic', baseUrl: 'https://draft.invalid/anthropic', apiKey: '',
  defaultModel: 'opus', models: { haiku: '', sonnet: 'draft-medium', opus: 'owner/draft-expert' } });

test('draft probe uses current URL/model and blank key reuses saved credential without mutation', () => {
  const existing = saved(), before = clone(existing);
  const runtime = createProviderDraftRuntime(draft(), existing, { requireModel: true });
  assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'https://draft.invalid/anthropic');
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-saved-key');
  assert.equal(runtime.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(runtimeModel(runtime), 'owner/draft-expert');
  assert.equal(runtime.tier, 'opus');
  assert.equal(runtime.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.deepEqual(existing, before);
});
test('new draft credentials and Bearer prefix replace the saved auth environment', () => {
  const plain = createProviderDraftRuntime({ ...draft(), apiKey: 'synthetic-new-key' }, saved());
  assert.equal(plain.env.ANTHROPIC_API_KEY, 'synthetic-new-key');
  assert.equal(plain.env.ANTHROPIC_AUTH_TOKEN, undefined);
  const bearer = createProviderDraftRuntime({ ...draft(), apiKey: 'Bearer synthetic-bearer' }, saved());
  assert.equal(bearer.authMode, 'auth-token');
  assert.equal(bearer.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-bearer');
});
test('empty explicit URL/model cannot silently test old saved values', () => {
  assert.throws(() => createProviderDraftRuntime({ ...draft(), baseUrl: '' }, saved()), /填写/);
  assert.throws(() => createProviderDraftRuntime({ ...draft(), models: {} }, saved(), { requireModel: true }), /至少一个/);
  assert.throws(() => createProviderDraftRuntime({ ...draft(), apiKey: '' }, null), /填写/);
  assert.throws(() => createProviderDraftRuntime({ ...draft(), baseUrl: 'file:///tmp/nope' }, saved()), /http/);
});
test('probe fallback selects first filled draft tier while discovery allows no model yet', () => {
  const value = { ...draft(), defaultModel: 'opus', models: { haiku: '', sonnet: 'custom-only', opus: '' } };
  const runtime = createProviderDraftRuntime(value, saved(), { requireModel: true });
  assert.equal(runtime.tier, 'sonnet'); assert.equal(runtimeModel(runtime), 'custom-only');
  assert.equal(createProviderDraftRuntime({ ...draft(), models: {} }, saved()).modelId, '');
});
test('draft tier selection never accepts inherited object property names', () => {
  for (const tier of ['constructor', 'toString', '__proto__']) {
    const runtime = createProviderDraftRuntime({ ...draft(), tier }, saved(), { requireModel: true });
    assert.equal(runtime.tier, 'sonnet'); assert.equal(runtimeModel(runtime), 'draft-medium');
  }
});
test('draft URL validation matches saved configuration restrictions', () => {
  for (const baseUrl of ['https://name:password@example.invalid', 'https://example.invalid/?key=value', 'https://example.invalid/#anchor', 'not a url']) {
    assert.throws(() => createProviderDraftRuntime({ ...draft(), baseUrl }, saved()), /URL/);
  }
  assert.equal(createProviderDraftRuntime({ ...draft(), baseUrl: 'https://draft.invalid/anthropic///' }, saved()).env.ANTHROPIC_BASE_URL, 'https://draft.invalid/anthropic');
});

function handlerContext() {
  const handlers = {}, probes = [], discovery = [], mutations = [];
  const state = { profile: { id: 'synthetic', revision: 1, activeTiers: ['haiku'] }, runtime: saved(), defer: null };
  const context = { Object, Number, String, createProviderDraftRuntime,
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    providerStore: {
      getRuntime: () => clone(state.runtime), getConnectionRuntime: () => clone(state.runtime),
      getProfile: () => state.profile && clone(state.profile),
      setAuthMode(id, authMode) { mutations.push({ id, authMode }); return { changed: false, profile: clone(state.profile) }; },
    },
    testProviderConnection: async runtime => { probes.push(clone(runtime)); if (state.defer) await state.defer; return { ok: true, authMode: 'api-key', model: runtimeModel(runtime), latencyMs: 2 }; },
    discoverProviderModels: async runtime => { discovery.push(clone(runtime)); return { ok: true, models: [] }; },
    publishProviderChange: () => mutations.push('publish'),
  };
  const { registerProviderIpc } = loadCommonJs('src/main/providers/provider-ipc.js', {
    modules: { './provider-connectivity': {
      createProviderDraftRuntime, testProviderConnection: context.testProviderConnection,
      discoverProviderModels: context.discoverProviderModels,
    } },
  });
  registerProviderIpc(context);
  return { handlers, probes, discovery, mutations, state };
}
test('actual draft test IPC is read-only including auth discovery', async () => {
  const h = handlerContext();
  const result = await h.handlers['providers:testDraft']({}, draft());
  assert.equal(result.ok, true); assert.equal(result.scope, 'draft'); assert.equal(result.tier, 'opus');
  assert.equal(h.probes[0].env.ANTHROPIC_BASE_URL, draft().baseUrl);
  assert.deepEqual(h.mutations, []);
  assert.equal(JSON.stringify(result).includes('synthetic-saved-key'), false);
});
test('draft directory IPC shares the same isolated credential construction', async () => {
  const h = handlerContext();
  const result = await h.handlers['providers:discoverDraftModels']({}, { ...draft(), apiKey: 'new-draft-only' });
  assert.equal(result.ok, true); assert.equal(h.discovery[0].env.ANTHROPIC_API_KEY, 'new-draft-only');
  assert.equal(h.discovery[0].env.ANTHROPIC_AUTH_TOKEN, undefined); assert.deepEqual(h.mutations, []);
});
test('legacy saved test keeps its signature but rejects config changes before auth writes', async () => {
  const h = handlerContext();
  const valid = await h.handlers['providers:test']({}, 'synthetic');
  assert.equal(valid.ok, true); assert.equal(valid.scope, 'saved'); assert.equal(h.mutations.length, 1);
  let resolve; h.state.defer = new Promise(done => { resolve = done; });
  const pending = h.handlers['providers:test']({}, 'synthetic');
  h.state.profile.revision = 2; resolve();
  const stale = await pending;
  assert.equal(stale.ok, false); assert.equal(stale.stale, true); assert.equal(h.mutations.length, 1);
});
test('removed profile cannot receive an old saved probe auth result', async () => {
  const h = handlerContext();
  let resolve; h.state.defer = new Promise(done => { resolve = done; });
  const pending = h.handlers['providers:test']({}, 'synthetic');
  h.state.profile = null; resolve();
  assert.equal((await pending).stale, true); assert.deepEqual(h.mutations, []);
});
test('invalid draft becomes structured error before any network or mutation', async () => {
  const h = handlerContext();
  const result = await h.handlers['providers:testDraft']({}, { ...draft(), models: {} });
  assert.equal(result.ok, false); assert.equal(result.scope, 'draft');
  assert.deepEqual(h.probes, []); assert.deepEqual(h.mutations, []);
});
test('explicitly saved verified Bearer mode becomes the actual provider runtime auth', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-draft-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProviderStore({ userDataDir: dir, logger: { log() {}, warn() {} }, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  } });
  const result = store.createProfile({ ...draft(), name: 'Synthetic Bearer', apiKey: 'synthetic-bearer-key', authMode: 'auth-token', routeTiers: ['opus'], claimUnassignedRoutes: false });
  const runtime = store.getRuntime(result.profile.id, 'opus');
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-bearer-key');
  assert.equal(runtime.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(runtime.modelId, 'owner/draft-expert');
});

function declaration(name) {
  const start = renderer.indexOf('function ' + name + '(');
  const tail = renderer.slice(start);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
test('health cache follows profile revision and clears removed configurations', () => {
  const context = { providerHealth: new Map(), providerHealthProfiles: new Map(), providerModelCatalog: new Map() };
  vm.createContext(context);
  vm.runInContext(declaration('providerHealthProfileKey') + declaration('syncProviderHealth'), context);
  const profile = { id: 'synthetic', revision: 1, baseUrl: 'https://saved.invalid', models: { haiku: 'first' } };
  const entry = { profileKey: context.providerHealthProfileKey(profile), ok: true };
  context.providerHealth.set(profile.id, entry);
  context.syncProviderHealth([clone(profile)]); assert.equal(context.providerHealth.get(profile.id), entry);
  context.syncProviderHealth([{ ...profile, revision: 2 }]); assert.equal(context.providerHealth.has(profile.id), false);
  context.providerHealth.set(profile.id, entry);
  context.syncProviderHealth([]); assert.equal(context.providerHealth.size, 0);
});
