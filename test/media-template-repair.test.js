'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMediaModels, getMediaCapabilityPreset, mediaRuntimeBinding } = require('../src/main/providers/provider-media');
const { LEGACY_CAPABILITY_PRESETS, TEMPLATE_VERSION } = require('../src/main/providers/media-capability-presets');
const { ProviderStore } = require('../src/main/providers/provider-store');
const { encodeSubmit, validateInput, MediaValidationError } = require('../src/main/media/media-protocols');

const clone = value => JSON.parse(JSON.stringify(value));
const png = 'data:image/png;base64,aGVsbG8=';
function legacy(modelId, presetId, overrides = {}) {
  const preset = LEGACY_CAPABILITY_PRESETS[presetId];
  return { modelId, protocol: preset.protocol, capabilities: clone(preset.capabilities), ...overrides };
}
function normalize(binding) { return normalizeMediaModels([binding], { strict: true })[0]; }
function runtime(binding) { return { ...binding, baseUrl: 'https://fixture.invalid/proxy', auth: { mode: 'bearer' } }; }

test('old fixed Seedance sample becomes adjustable without changing the saved binding or defaults', () => {
  const original = legacy('gateway/doubao-seedance-2.5', 'seedance-video', {
    id: 'existing-seedance', label: 'My video model', ownedBy: 'custom-owner', enabled: false,
    baseUrl: 'https://custom-gateway.invalid/proxy', auth: { mode: 'api-key', headerName: 'x-custom-auth' },
    endpoints: { submit: '/custom/create', poll: '/custom/tasks/{taskId}' },
    routeHeaders: { 'x-route': 'custom' }, aliases: ['legacy-video'], errorProfile: 'mify',
  });
  const snapshot = clone(original), repaired = normalize(original);
  assert.deepEqual(original, snapshot, 'normalization must not mutate the editor draft');
  assert.deepEqual(repaired.capabilities.defaults, original.capabilities.defaults);
  assert.deepEqual(repaired.capabilities.parameters.duration, { min: 4, max: 30, integer: true, specialValues: [-1] });
  assert.deepEqual(repaired.capabilities.parameters.resolution.enum, ['480p', '720p', '1080p']);
  assert.ok(repaired.capabilities.parameters.ratio.enum.includes('16:9'));
  assert.deepEqual(repaired.setup, { source: 'legacy-template', templateId: 'seedance-2.5-video', version: TEMPLATE_VERSION });
  for (const key of ['id', 'modelId', 'label', 'ownedBy', 'enabled', 'baseUrl', 'auth', 'endpoints', 'routeHeaders', 'aliases', 'errorProfile']) {
    assert.deepEqual(repaired[key], original[key], key);
  }
  assert.deepEqual(normalize(repaired), repaired, 'repair is idempotent');
});

test('Seedance versions receive separate duration and resolution limits', () => {
  const v2 = normalize(legacy('doubao-seedance-2-0-260128', 'seedance-video'));
  const v25 = normalize(legacy('dreamina-seedance-2-5-260628', 'seedance-video'));
  assert.equal(v2.setup.templateId, 'seedance-2.0-video');
  assert.equal(v2.capabilities.parameters.duration.max, 15);
  assert.ok(v2.capabilities.parameters.resolution.enum.includes('4k'));
  assert.equal(v25.capabilities.parameters.duration.max, 30);
  assert.equal(v25.capabilities.parameters.resolution.enum.includes('4k'), false);
  const request = encodeSubmit(runtime(v2), { prompt: 'A cube rotates', duration: 15, resolution: '4k', ratio: '9:16' });
  assert.equal(request.body.duration, 15);
  assert.equal(request.body.resolution, '4k');
  assert.equal(validateInput(runtime(v2), { prompt: 'Cube', duration: 16 }).ok, false);
});

test('new Seedance parameter values reach the existing generic Ark codec and invalid values are rejected', () => {
  const binding = runtime(normalize(legacy('doubao-seedance-2.5', 'seedance-video')));
  const request = encodeSubmit(binding, { prompt: 'A cube rotates', duration: 12, resolution: '1080p', ratio: '16:9', audio: true });
  assert.equal(request.body.model, 'doubao-seedance-2.5');
  assert.equal(request.body.duration, 12);
  assert.equal(request.body.resolution, '1080p');
  assert.equal(request.body.ratio, '16:9');
  assert.equal(request.body.generate_audio, true);
  assert.equal(request.body.audio, undefined);
  for (const fields of [{ duration: 31 }, { duration: 3 }, { duration: 4.5 }, { resolution: '4k' }, { ratio: '2:7' }, { audio: 'true' }]) {
    assert.equal(validateInput(binding, { prompt: 'Cube', ...fields }).ok, false, JSON.stringify(fields));
    assert.throws(() => encodeSubmit(binding, { prompt: 'Cube', ...fields }), MediaValidationError);
  }
});

test('Wan 3 text-to-video no longer inherits the two-second sample limit', () => {
  const binding = runtime(normalize(legacy('wan3.0-video', 'wan-video')));
  assert.deepEqual(binding.capabilities.defaults, LEGACY_CAPABILITY_PRESETS['wan-video'].capabilities.defaults);
  assert.equal(binding.capabilities.parameters.duration.max, 30);
  assert.deepEqual(binding.capabilities.operations, ['text_to_video']);
  assert.deepEqual(binding.capabilities.references, { max: 0 });
  const request = encodeSubmit(binding, { prompt: 'A cube rotates', duration: 20, resolution: '1080P', ratio: '9:16', audio: true });
  assert.equal(request.body.parameters.duration, 20);
  assert.equal(request.body.parameters.resolution, '1080P');
  assert.equal(request.body.parameters.ratio, '9:16');
  assert.equal(request.body.parameters.audio, true);
  assert.equal(validateInput(binding, { prompt: 'Cube', duration: 31 }).ok, false);
  assert.equal(validateInput(binding, { prompt: 'Cube', references: [png] }).ok, false);
});

test('Wan 2.7 first-frame repair retains the required image and exposes only supported video parameters', () => {
  const binding = runtime(normalize(legacy('wan2.7-i2v', 'wan-first-frame')));
  assert.equal(binding.setup.templateId, 'wan-2.7-first-frame');
  assert.deepEqual(binding.capabilities.operations, ['image_to_video']);
  assert.deepEqual(binding.capabilities.references, { max: 1, required: true, roles: ['first_frame'] });
  assert.deepEqual(binding.capabilities.defaults, { duration: 2, resolution: '720P' });
  const request = encodeSubmit(binding, { references: [png], duration: 15, resolution: '1080P' });
  assert.deepEqual(request.body.input.media, [{ type: 'first_frame', url: png }]);
  assert.equal(request.body.parameters.duration, 15);
  assert.equal(request.body.parameters.resolution, '1080P');
  assert.equal(request.body.parameters.audio, undefined);
  for (const fields of [{ references: [] }, { references: [png, png] }, { duration: 16 }, { resolution: '480P' }, { ratio: '1:1' }, { audio: false }]) {
    assert.equal(validateInput(binding, { references: [png], ...fields }).ok, false, JSON.stringify(fields));
  }
});

test('GPT Image 2.5 basic bindings gain image parameters while retaining gateway transport settings', () => {
  const basic = getMediaCapabilityPreset('protocol-openai-images');
  const original = { modelId: 'gpt-image-2.5-sunburst', protocol: basic.protocol, capabilities: basic.capabilities,
    editTransport: 'json-images', endpoints: { generate: '/custom/images' } };
  const binding = runtime(normalize(original));
  assert.equal(binding.setup.templateId, 'gpt-image-2.5');
  assert.equal(binding.editTransport, 'json-images');
  assert.deepEqual(binding.endpoints, original.endpoints);
  const request = encodeSubmit(binding, { prompt: 'A cube', size: '1536x1024', n: 2, quality: 'max', outputFormat: 'webp', background: 'transparent' });
  assert.equal(request.body.quality, 'max');
  assert.equal(request.body.size, '1536x1024');
  assert.equal(request.body.n, 2);
  assert.equal(request.body.output_format, 'webp');
  assert.equal(request.body.background, 'transparent');
  for (const fields of [{ size: '1025x1024' }, { size: '4096x1024' }, { n: 11 }, { quality: 'unknown' }]) {
    assert.equal(validateInput(binding, { prompt: 'Cube', ...fields }).ok, false, JSON.stringify(fields));
  }
});

test('equivalent legacy properties in a different order still repair', () => {
  const original = legacy('doubao-seedance-2.5', 'seedance-video');
  original.capabilities = Object.fromEntries(Object.entries(original.capabilities).reverse());
  original.capabilities.parameters = Object.fromEntries(Object.entries(original.capabilities.parameters).reverse());
  assert.equal(normalize(original).capabilities.parameters.duration.max, 30);
});

test('custom bounds and custom defaults are never overwritten by the name-based legacy repair', () => {
  for (const customize of [
    caps => { caps.parameters.duration.max = 8; },
    caps => { caps.defaults.audio = true; },
    caps => { caps.parameters.seed = { min: 1, max: 42, integer: true }; },
  ]) {
    const original = legacy('doubao-seedance-2.5', 'seedance-video');
    customize(original.capabilities);
    const binding = normalize(original);
    assert.deepEqual(binding.capabilities, original.capabilities);
    assert.equal(binding.setup, undefined);
  }
});

test('explicit manual and directory setup metadata protect even exact old-looking capabilities', () => {
  for (const source of ['manual', 'manual-template', 'directory', 'family-template']) {
    const original = legacy('doubao-seedance-2.5', 'seedance-video', {
      setup: { source, templateId: 'seedance-video', version: 1 },
    });
    const binding = normalize(original);
    assert.deepEqual(binding.capabilities, original.capabilities, source);
    assert.deepEqual(binding.setup, original.setup, source);
  }
});

test('unknown models, future versions and protocol mismatches retain their saved capabilities', () => {
  for (const original of [
    legacy('unknown-video-model', 'seedance-video'),
    legacy('doubao-seedance-9.0', 'seedance-video'),
    legacy('doubao-seedance-2.5-fast', 'seedance-video'),
    legacy('doubao-seedance-2.5', 'wan-video'),
  ]) {
    const binding = normalize(original);
    assert.deepEqual(binding.capabilities, original.capabilities, original.modelId);
    assert.equal(binding.setup, undefined, original.modelId);
  }
});

test('a repair that would invalidate saved defaults leaves the original binding intact', () => {
  const original = legacy('wan2.6-t2i', 'z-image');
  const binding = normalize(original);
  assert.deepEqual(binding.capabilities, original.capabilities);
  assert.equal(binding.setup, undefined, 'the old 512*512 default is below Wan 2.6 minimum pixels');
});

test('directory declarations prevent legacy repair only for the exact model and owner', () => {
  const original = legacy('doubao-seedance-2.5', 'seedance-video', { ownedBy: 'gateway-owner' });
  for (const metadata of [
    { mediaConfig: { protocol: 'ark-video', capabilities: clone(original.capabilities) } },
    { mediaTemplateBlocked: true },
  ]) {
    const catalog = [{ id: original.modelId, ownedBy: original.ownedBy, ...metadata }];
    const result = normalizeMediaModels([original], { strict: true, catalog })[0];
    assert.deepEqual(result.capabilities, original.capabilities);
    assert.equal(result.setup, undefined);
    const otherOwner = normalizeMediaModels([{ ...original, ownedBy: 'another-owner' }], { strict: true, catalog })[0];
    assert.equal(otherOwner.capabilities.parameters.duration.max, 30);
  }
});

test('legacy template aliases stay readable without listing duplicate templates', () => {
  for (const [oldId, newId] of [['seedance-video', 'seedance-2.5-video'], ['wan-video', 'wan-3-video'], ['wan-first-frame', 'wan-2.7-first-frame']]) {
    assert.deepEqual(getMediaCapabilityPreset(oldId), getMediaCapabilityPreset(newId));
  }
});

function storeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-template-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let count = 0;
  const options = { userDataDir: dir, randomId: () => `repair-fixture-${++count}`, logger: { warn() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } };
  const store = new ProviderStore(options);
  const profile = store.createProfile({ name: 'Custom fixture gateway', baseUrl: 'https://fixture.invalid/proxy', apiKey: 'synthetic-fixture-secret',
    models: { opus: 'fixture-opus', sonnet: 'fixture-sonnet', haiku: 'fixture-haiku' }, mediaConnection: { preset: 'custom' } }).profile;
  const disk = JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8'));
  const saved = disk.profiles.find(item => item.id === profile.id);
  return { options, store, disk, saved, profile };
}

test('persisted legacy bindings migrate once, increment media revision once and leave chat settings and secrets untouched', t => {
  const { options, store, disk, saved, profile } = storeFixture(t);
  saved.mediaRevision = 7;
  saved.mediaModels = [
    legacy('doubao-seedance-2.5', 'seedance-video', { id: 'seedance-binding' }),
    legacy('wan2.7-i2v', 'wan-first-frame', { id: 'wan-binding' }),
    { modelId: 'gpt-image-2.5-sunburst', protocol: 'openai-images', id: 'image-binding', capabilities: getMediaCapabilityPreset('protocol-openai-images').capabilities },
  ];
  const originalProfile = clone(saved), originalRoutes = clone(disk.chatRoutes);
  const oldRuntime = mediaRuntimeBinding(saved, normalize({ ...saved.mediaModels[0], setup: { source: 'manual' } }));
  fs.writeFileSync(store.paths().profiles, JSON.stringify(disk, null, 2));
  const secretBefore = fs.readFileSync(store.paths().secrets);
  const restarted = new ProviderStore(options);
  let writes = 0;
  const writeState = restarted.writeState.bind(restarted);
  restarted.writeState = state => { writes += 1; writeState(state); };
  const repaired = restarted.getProfile(profile.id);
  assert.equal(writes, 1);
  assert.equal(repaired.mediaRevision, 8, 'several repaired models increment the profile once');
  assert.ok(repaired.mediaModels.every(item => item.setup.source === 'legacy-template' && item.setup.version === TEMPLATE_VERSION));
  for (const key of ['revision', 'models', 'baseUrl', 'credentialRef', 'createdAt', 'updatedAt', 'mediaConnection']) {
    assert.deepEqual(restarted.readState().profiles[0][key], originalProfile[key], key);
  }
  assert.deepEqual(restarted.readState().chatRoutes, originalRoutes);
  assert.deepEqual(fs.readFileSync(store.paths().secrets), secretBefore);
  assert.equal(restarted.getMediaRuntime(`${profile.id}::media::seedance-binding`).apiKey, 'synthetic-fixture-secret');
  assert.throws(() => restarted.resolveMediaCredential(oldRuntime), /配置或密钥已变更/);
  assert.equal(restarted.readState()._needsWrite, false);
  const persistedOnce = fs.readFileSync(store.paths().profiles);
  restarted.getProfile(profile.id);
  assert.equal(writes, 1);
  const reopened = new ProviderStore(options);
  reopened.writeState = () => assert.fail('reopening an upgraded store must not write it again');
  assert.equal(reopened.getProfile(profile.id).mediaRevision, 8);
  assert.deepEqual(fs.readFileSync(store.paths().profiles), persistedOnce);
  assert.deepEqual(fs.readFileSync(store.paths().secrets), secretBefore);
});

test('stores containing only unknown and explicitly configured bindings do not change revision or write on open', t => {
  const { options, store, disk, saved, profile } = storeFixture(t);
  saved.mediaRevision = 11;
  saved.mediaModels = [
    legacy('unknown-video-model', 'seedance-video', { id: 'unknown-binding' }),
    legacy('doubao-seedance-2.5', 'seedance-video', { id: 'manual-binding', setup: { source: 'manual' } }),
    legacy('dreamina-seedance-2-5-260628', 'seedance-video', { id: 'directory-binding', setup: { source: 'directory' } }),
  ];
  fs.writeFileSync(store.paths().profiles, JSON.stringify(disk, null, 2));
  const before = fs.readFileSync(store.paths().profiles);
  const reopened = new ProviderStore(options);
  reopened.writeState = () => assert.fail('non-migrating profiles must not be rewritten');
  const result = reopened.getProfile(profile.id);
  assert.equal(result.mediaRevision, 11);
  assert.deepEqual(result.mediaModels.map(item => item.capabilities), saved.mediaModels.map(item => item.capabilities));
  assert.deepEqual(fs.readFileSync(store.paths().profiles), before);
});

test('gateway-declared fixed capabilities survive opening and saving without setup metadata', t => {
  const { options, store, disk, saved, profile } = storeFixture(t);
  const binding = legacy('doubao-seedance-2.5', 'seedance-video', { id: 'gateway-fixed', ownedBy: 'gateway-owner' });
  saved.mediaRevision = 9;
  saved.mediaModels = [binding];
  saved.mediaCatalog = [{ id: binding.modelId, ownedBy: binding.ownedBy,
    mediaConfig: { protocol: binding.protocol, capabilities: clone(binding.capabilities) } }];
  fs.writeFileSync(store.paths().profiles, JSON.stringify(disk, null, 2));
  const before = fs.readFileSync(store.paths().profiles);
  const reopened = new ProviderStore(options);
  const result = reopened.getProfile(profile.id);
  assert.equal(result.mediaRevision, 9);
  assert.deepEqual(result.mediaModels[0].capabilities, binding.capabilities);
  assert.equal(result.mediaModels[0].setup, undefined);
  assert.deepEqual(fs.readFileSync(store.paths().profiles), before);
  const updated = reopened.updateProfile(profile.id, { name: 'Renamed fixture', mediaModels: result.mediaModels }).profile;
  assert.deepEqual(updated.mediaModels[0].capabilities, binding.capabilities);
  assert.equal(updated.mediaModels[0].setup, undefined);
  assert.equal(updated.mediaRevision, 9, 'editing the provider name does not alter declared media capabilities');
  assert.deepEqual(new ProviderStore(options).getProfile(profile.id).mediaModels[0].capabilities, binding.capabilities);
});

test('new profiles retain explicit gateway declarations through every normalization pass', t => {
  const { store } = storeFixture(t);
  const binding = legacy('doubao-seedance-2.5', 'seedance-video', { id: 'gateway-fixed', ownedBy: 'gateway-owner' });
  const profile = store.createProfile({ name: 'Declared gateway', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-second-secret',
    models: {}, mediaModels: [binding], mediaCatalog: [{ id: binding.modelId, ownedBy: binding.ownedBy,
      mediaConfig: { protocol: binding.protocol, capabilities: clone(binding.capabilities) } }] }).profile;
  assert.deepEqual(profile.mediaModels[0].capabilities, binding.capabilities);
  assert.equal(profile.mediaModels[0].setup, undefined);
  assert.equal(profile.mediaCatalog[0].mediaConfig.protocol, binding.protocol);
  assert.deepEqual(store.getProfile(profile.id).mediaModels[0].capabilities, binding.capabilities);
});
