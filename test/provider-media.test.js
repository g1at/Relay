'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderStore } = require('../src/main/providers/provider-store');
const { normalizeMediaModels, getMediaProtocolPresets } = require('../src/main/providers/provider-media');
const { discoverProviderModels, normalizeModelCatalog } = require('../src/main/providers/provider-connectivity');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let count = 0;
  const options = { userDataDir: dir, randomId: () => `media-${++count}`,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    logger: { warn() {} },
  };
  const store = new ProviderStore(options);
  const add = (name, patch = {}) => store.createProfile({ name, baseUrl: 'https://fixture.invalid', apiKey: `fixture-${name}-key`, models: {}, ...patch }).profile;
  return { store, add, options };
}

function binding(patch = {}) {
  return { id: 'image-choice', modelId: 'Exact/brand-new-image', protocol: 'openai-images', modality: 'image', enabled: true,
    capabilities: { operations: ['text_to_image'], defaults: { n: 1 }, parameters: { n: { min: 1, max: 1 } } }, ...patch };
}

test('new models route by stable binding identity across gateways without model-name heuristics', t => {
  const { store, add } = setup(t);
  const a = add('A', { mediaModels: [binding()] });
  const b = add('B', { mediaModels: [binding()] });
  const routes = store.listMediaModels({ modality: 'image' });
  assert.equal(routes.length, 2);
  assert.notEqual(routes[0].routeId, routes[1].routeId);
  assert.equal(store.getMediaRuntime(routes[0].routeId).apiKey, 'fixture-A-key');
  assert.equal(store.getMediaRuntime(routes[1].routeId).apiKey, 'fixture-B-key');
  assert.equal(store.getMediaRuntime('Exact/brand-new-image'), null);
  assert.equal(store.getMediaRuntime('prefix-gpt-image-2'), null);
  assert.equal(store.getMediaRuntime(''), null);
  assert.equal(JSON.stringify(store.listProfiles()).includes('fixture-A-key'), false);
  assert.equal(JSON.stringify(routes).includes('credentialRef'), false);
  assert.deepEqual(store.listMediaModels({ modality: 'video' }), []);
  assert.equal(a.mediaModels[0].id, b.mediaModels[0].id);
});

test('media edits preserve chat revision and invalidate only bound media snapshots', t => {
  const { store, add } = setup(t);
  const profile = add('Bound', { models: { haiku: 'chat-exact' }, mediaModels: [binding()] });
  const route = store.listMediaModels()[0].routeId;
  const snapshot = store.getMediaRuntime(route);
  assert.equal(store.resolveMediaCredential(snapshot), 'fixture-Bound-key');
  store.updateProfile(profile.id, { name: 'Renamed' });
  assert.equal(store.resolveMediaCredential(snapshot), 'fixture-Bound-key', 'cosmetic rename does not invalidate media work');
  const changed = store.updateProfile(profile.id, { mediaModels: [binding({ modelId: 'Exact/new-revision' })] });
  assert.equal(changed.runtimeChanged, false);
  assert.equal(changed.mediaChanged, true);
  assert.equal(changed.profile.revision, profile.revision);
  assert.throws(() => store.resolveMediaCredential(snapshot), /已变更/);
  const newer = store.getMediaRuntime(route);
  store.updateProfile(profile.id, { apiKey: 'fixture-rotated-key' });
  assert.throws(() => store.resolveMediaCredential(newer), /已变更/);
  assert.equal(store.getMediaRuntime(route).apiKey, 'fixture-rotated-key');
});

test('directory refresh preserves selected models, manual endpoints and capability overrides', t => {
  const { store, add } = setup(t);
  const configured = binding({ endpoints: { generate: '/custom/render' }, capabilities: { operations: ['text_to_image'], defaults: { n: 1 }, parameters: { n: { max: 1 } } } });
  const profile = add('Catalog', { mediaModels: [configured] });
  const route = store.listMediaModels()[0].routeId;
  const before = store.getMediaRuntime(route);
  store.setMediaCatalog(profile.id, [{ id: 'another-video', model_type: 'video_generation', modality: 'video', owned_by: 'upstream' }]);
  store.setDiscoveredImageModels(profile.id, []);
  assert.deepEqual(store.getMediaRuntime(route), before);
  assert.deepEqual(store.getProfile(profile.id).mediaModels, profile.mediaModels);
  assert.equal(store.getProfile(profile.id).mediaCatalog[0].ownedBy, 'upstream');
  store.setMediaCatalog(profile.id, []);
  assert.deepEqual(store.getMediaRuntime(route), before);
});

test('other gateway hosts require explicit Mify routing and operation/header overrides win', t => {
  const { store, add } = setup(t);
  const video = binding({ protocol: 'dashscope-video', modality: 'video', modelId: 'Exact/video', ownedBy: 'tongyi', capabilities: { operations: ['text_to_video'] }, routeHeaders: { 'X-DashScope-Async': null } });
  const profile = add('Gateway', { mediaModels: [video] });
  const route = store.listMediaModels()[0].routeId;
  assert.equal(store.getMediaRuntime(route).routeHeaders['x-model-provider-id'], undefined);
  store.updateProfile(profile.id, { mediaConnection: { preset: 'mify', baseUrl: 'https://media.invalid/v1' } });
  const mify = store.getMediaRuntime(route);
  assert.equal(mify.modelId, 'Exact/video');
  assert.equal(mify.routeHeaders['x-model-provider-id'], 'tongyi');
  assert.equal(mify.routeHeaders['x-dashscope-async'], null);
  assert.equal(mify.endpoints.submit, '/v1/videos/generations');
  assert.equal(mify.endpoints.poll, '/v1/videos/generations/{taskId}?model={modelId}');
  store.updateProfile(profile.id, { mediaModels: [{ ...video, endpoints: { poll: '/tenant/jobs/{taskId}' }, routeHeaders: { 'x-model-provider-id': null } }] });
  assert.equal(store.getMediaRuntime(route).endpoints.poll, '/tenant/jobs/{taskId}');
  assert.equal(store.getMediaRuntime(route).routeHeaders['x-model-provider-id'], null);
});

test('legacy image routes migrate once with exact aliases and preserve their recorded model', t => {
  const { store, add, options } = setup(t);
  const profile = add('Legacy', { imageModels: [{ adapterId: 'gpt-image-2', remoteModelId: 'azure_openai/gpt-image-2' }] });
  const data = JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8'));
  for (const item of data.profiles) { delete item.mediaSchemaVersion; delete item.mediaModels; }
  fs.writeFileSync(store.paths().profiles, JSON.stringify(data));
  const restored = new ProviderStore(options);
  const runtime = restored.getMediaRuntime(`${profile.id}::gpt-image-2`);
  assert.ok(runtime.routeId.includes('::media::'));
  assert.equal(runtime.modelId, 'gpt-image-2');
  assert.equal(runtime.routeHeaders['x-model-provider-id'], 'azure_openai');
  assert.equal(runtime.editTransport, 'legacy-json-image-url');
  assert.equal(runtime.capabilities.defaults.quality, 'medium');
  assert.equal(runtime.capabilities.references.max, 1);
  assert.equal(restored.getMediaRuntime('gpt-image-2').routeId, runtime.routeId);
  restored.setDiscoveredImageModels(profile.id, [{ adapterId: 'gpt-image-2', remoteModelId: 'different-gpt-image-2' }]);
  assert.equal(restored.getMediaRuntime(runtime.routeId).modelId, 'gpt-image-2');
  assert.equal(new ProviderStore(options).listMediaModels().length, 1);
  restored.setImageRoute('gpt-image-2', null);
  assert.equal(restored.getMediaRuntime(runtime.routeId), null);
});

test('inherited Mify chat connections resolve media endpoints without changing saved configuration', t => {
  const { store, add } = setup(t);
  const video = binding({ protocol: 'ark-video', modality: 'video', ownedBy: 'volcengine_maas', capabilities: { operations: ['text_to_video'] } });
  add('Mify default', { baseUrl: 'https://api.llm.mioffice.cn/anthropic', mediaModels: [video] });
  const route = store.listMediaModels()[0].routeId;
  const before = fs.readFileSync(store.paths().profiles, 'utf8');
  const runtime = store.getMediaRuntime(route);
  const request = require('../src/main/media/media-protocols').encodeSubmit(runtime, { prompt: 'a red cube' });
  assert.equal(request.url, 'https://api.llm.mioffice.cn/v1/videos/generations');
  assert.equal(request.headers['x-model-provider-id'], 'volcengine_maas');
  assert.equal(runtime.errorProfile, 'mify');
  assert.equal(fs.readFileSync(store.paths().profiles, 'utf8'), before);
});

test('automatic media gateway defaults do not rewrite other gateways or explicit Mify connections', t => {
  const { store, add } = setup(t);
  const profiles = [
    add('Other', { baseUrl: 'https://another.example/anthropic', mediaModels: [binding()] }),
    add('Lookalike', { baseUrl: 'https://api.llm.mioffice.cn.example/anthropic', mediaModels: [binding()] }),
    add('Proxy prefix', { baseUrl: 'https://api.llm.mioffice.cn/tenant/proxy', mediaModels: [binding()] }),
    add('Explicit address', { baseUrl: 'https://api.llm.mioffice.cn/anthropic', mediaConnection: { baseUrl: 'https://media.example/tenant' }, mediaModels: [binding()] }),
    add('Explicit endpoints', { baseUrl: 'https://api.llm.mioffice.cn/anthropic', mediaConnection: { endpoints: { generate: '/special' } }, mediaModels: [binding()] }),
  ];
  for (const profile of profiles) {
    const runtime = store.getMediaRuntime(`${profile.id}::media::image-choice`);
    assert.equal(runtime.errorProfile, 'generic');
    assert.equal(runtime.routeHeaders['x-model-provider-id'], undefined);
    assert.equal(runtime.baseUrl, profile.mediaConnection.baseUrl || profile.baseUrl);
  }
});

test('Mify image edits default to JSON references while explicit transports and other gateways retain their contracts', t => {
  const { store, add } = setup(t);
  const { encodeSubmit } = require('../src/main/media/media-protocols');
  const editable = binding({ capabilities: { operations: ['text_to_image', 'image_to_image'], references: { max: 2 } } });
  const input = { prompt: 'combine both reference images', references: ['https://fixture.invalid/first.png', 'https://fixture.invalid/second.png'] };
  const cases = [
    { name: 'Inherited Mify', baseUrl: 'https://api.llm.mioffice.cn/anthropic', expected: 'json-image-urls' },
    { name: 'Explicit Mify', mediaConnection: { preset: 'mify' }, expected: 'json-image-urls' },
    { name: 'Unrelated gateway', expected: 'multipart' },
    { name: 'Binding override', mediaConnection: { preset: 'mify' }, editTransport: 'multipart', expected: 'multipart' },
    { name: 'Capability override', mediaConnection: { preset: 'mify' }, capabilitiesTransport: 'json-images', expected: 'json-images' },
    { name: 'Explicit JSON list', editTransport: 'json-image-urls', expected: 'json-image-urls' },
  ];
  for (const item of cases) {
    const mediaBinding = { ...editable,
      ...(item.editTransport ? { editTransport: item.editTransport } : {}),
      capabilities: { ...editable.capabilities, ...(item.capabilitiesTransport ? { editTransport: item.capabilitiesTransport } : {}) } };
    const profile = add(item.name, { ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
      ...(item.mediaConnection ? { mediaConnection: item.mediaConnection } : {}), mediaModels: [mediaBinding] });
    const before = fs.readFileSync(store.paths().profiles, 'utf8');
    const runtime = store.getMediaRuntime(`${profile.id}::media::image-choice`);
    const request = encodeSubmit(runtime, input);
    assert.equal((request.body.fields || request.body).model, editable.modelId, item.name);
    assert.equal(request.bodyEncoding, item.expected === 'multipart' ? 'multipart' : 'json', item.name);
    if (item.expected === 'json-image-urls') {
      assert.deepEqual(request.body.image_urls, input.references, item.name);
      assert.equal(request.body.images, undefined, item.name);
    } else if (item.expected === 'json-images') {
      assert.deepEqual(request.body.images, input.references.map(image_url => ({ image_url })), item.name);
      assert.equal(request.body.image_urls, undefined, item.name);
    } else {
      assert.equal(request.body.image_urls, undefined, item.name);
      assert.equal(request.body.files.length, 2, item.name);
    }
    assert.equal(fs.readFileSync(store.paths().profiles, 'utf8'), before, item.name);
  }
});

test('ambiguous bare legacy aliases never choose the first provider', t => {
  const { store, add } = setup(t);
  add('One', { mediaModels: [binding({ aliases: ['old-image'] })] });
  add('Two', { mediaModels: [binding({ aliases: ['old-image'] })] });
  assert.equal(store.getMediaRuntime('old-image'), null);
  assert.equal(store.listMediaModels().filter(item => item.available).length, 2);
});

test('media catalog preserves all exact raw image/video IDs and owners', async () => {
  const payload = { data: [
    { id: 'Same', owned_by: 'one', model_type: 'image_generation' },
    { id: 'Same', owned_by: 'two', model_type: 'video_generation' },
    { id: 'same', owned_by: 'one', model_type: 'image_generation' },
    { id: 'future-unknown', owned_by: 'one', model_type: 'audio' },
  ] };
  const catalog = normalizeModelCatalog(payload).catalog;
  assert.equal(catalog.length, 4);
  const result = await discoverProviderModels({ env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_API_KEY: 'fixture-only' } }, {
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.deepEqual(result.mediaModels.map(item => [item.id, item.ownedBy, item.modality]), [['Same', 'one', 'image'], ['Same', 'two', 'video'], ['same', 'one', 'image']]);
  assert.equal(result.accessVerified, false);
});

test('model scope denial is not classified or retried as an invalid API key', async () => {
  let count = 0;
  const result = await discoverProviderModels({ env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_API_KEY: 'fixture-only' } }, {
    fetchImpl: async () => { count += 1; return new Response(JSON.stringify({ error: { code: 'insufficient_scope', message: 'forbidden' } }), { status: 403 }); },
  });
  assert.equal(count, 1);
  assert.equal(result.errorKind, 'model_not_allowed');
});

test('configuration rejects credential headers and invalid bindings; presets declare every default', () => {
  assert.throws(() => normalizeMediaModels([binding({ routeHeaders: { authorization: 'Bearer secret' } })], { strict: true }), /认证信息/);
  assert.throws(() => normalizeMediaModels([binding({ protocol: 'future-unknown' })], { strict: true }), /协议/);
  assert.throws(() => normalizeMediaModels([binding(), binding()], { strict: true }), /重复/);
  assert.throws(() => normalizeMediaModels([binding({ baseUrl: 'https://user:password@example.invalid' })], { strict: true }), /认证信息/);
  for (const preset of getMediaProtocolPresets().capabilities) {
    for (const key of Object.keys(preset.capabilities.defaults)) assert.ok(preset.capabilities.parameters[key], `${preset.id}.${key}`);
  }
  for (const id of ['z-image', 'wan-3-video', 'wan-2.7-first-frame', 'seedance-2.5-video']) {
    const preset = getMediaProtocolPresets().capabilities.find(item => item.id === id);
    assert.equal(preset.capabilities.defaults.n, undefined);
    assert.equal(preset.capabilities.parameters.n, undefined);
  }
});


test('unknown gateway hosts retain their prefixes unless Mify routing is explicitly selected', t => {
  const { store, add } = setup(t);
  for (const suffix of ['/anthropic', '/anthropic/v1']) {
    const profile = add('Prefix' + suffix, { baseUrl: 'https://fixture.invalid/proxy' + suffix,
      imageModels: [{ adapterId: 'gpt-image-2', remoteModelId: 'azure_openai/gpt-image-2' }] });
    store.setImageRoute('gpt-image-2', profile.id);
    const alias = `${profile.id}::gpt-image-2`;
    assert.equal(store.getMediaRuntime(alias).baseUrl, 'https://fixture.invalid/proxy' + suffix);
    store.updateProfile(profile.id, { mediaConnection: { preset: 'mify' } });
    assert.equal(store.getMediaRuntime(alias).baseUrl, 'https://fixture.invalid/proxy');
    assert.equal(store.getMediaRuntime(alias).endpoints.generate, '/v1/images/generations');
    store.updateProfile(profile.id, { mediaConnection: { preset: 'mify', baseUrl: 'https://media.invalid/anthropic' } });
    assert.equal(store.getMediaRuntime(alias).baseUrl, 'https://media.invalid/anthropic', 'explicit media URL always wins');
  }
});
