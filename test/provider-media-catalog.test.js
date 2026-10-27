'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMediaCatalogMetadata, normalizeMediaModels, getMediaProtocolPresets, getMediaCapabilityPreset, MEDIA_PROTOCOLS } = require('../src/main/providers/provider-media');
const { normalizeModelCatalog, discoverProviderModels } = require('../src/main/providers/provider-connectivity');
const { ProviderStore } = require('../src/main/providers/provider-store');
const clone = value => JSON.parse(JSON.stringify(value));
const videoCaps = () => ({ operations: ['text_to_video'], parameters: { duration: { type: 'number', min: 3, max: 9, integer: true, enum: [3, 6, 9] }, audio: { type: 'boolean' } }, defaults: { duration: 6, audio: false }, references: { max: 0 } });
const item = patch => ({ id: 'Never-Seen/Model-42', owned_by: 'arbitrary-upstream', model_type: 'video_generation', media_protocol: 'ark-video', media_capabilities: videoCaps(), ...patch });
function config(value) { return normalizeMediaCatalogMetadata(value).mediaConfig; }

for (const [protocol, def] of Object.entries(MEDIA_PROTOCOLS)) {
  test(`explicit ${protocol} metadata recognizes an arbitrary ID without model-specific defaults`, () => {
    const result = normalizeMediaCatalogMetadata({ id: 'unseen-future-id', protocol });
    assert.equal(result.modality, def.modality);
    assert.equal(result.mediaConfig.protocol, protocol);
    assert.deepEqual(result.mediaConfig.capabilities, { operations: [def.operations[0]], parameters: {}, defaults: {}, references: { max: 0 } });
  });
}
test('protocol aliases and nested metadata preserve typed capability values', () => {
  for (const value of [
    item(), { id: 'A', modality: 'video', mediaProtocol: 'ark-video', mediaCapabilities: videoCaps() },
    { id: 'B', media: { protocol: 'ark-video', capabilities: videoCaps() } },
    { id: 'C', protocol: 'ark-video', capabilities: videoCaps() },
    { id: 'D', mediaConfig: { protocol: 'ark-video', capabilities: videoCaps() } },
  ]) {
    assert.deepEqual(config(value), { protocol: 'ark-video', capabilities: videoCaps() });
  }
});
test('equivalent declarations in different property order are accepted', () => {
  const other = videoCaps(); other.parameters = { audio: other.parameters.audio, duration: other.parameters.duration };
  assert.ok(config(item({ protocol: 'ark-video', capabilities: other })));
});
test('familiar model names, routing owners and directory type alone never identify a protocol', () => {
  for (const value of [
    { id: 'gpt-image-2', owned_by: 'azure_openai', model_type: 'image' },
    { id: 'doubao-seedance-2.5', owned_by: 'volcengine_maas', model_type: 'video' },
    { id: 'wan-video', owned_by: 'tongyi', modality: 'video' },
  ]) assert.equal(config(value), undefined);
});
const invalidCases = {
  'unknown protocol': { media_protocol: 'some-future-wire-format' },
  'conflicting protocol': { protocol: 'dashscope-video' },
  'conflicting modality': { modality: 'image' },
  'conflicting directory type aliases': { modelType: 'image' },
  'incompatible directory type': { model_type: 'audio' },
  'malformed directory type': { model_type: 42 },
  'malformed nested media': { media: [] },
  'malformed normalized media': { mediaConfig: null },
  'unsupported operation': { media_capabilities: { operations: ['text_to_image'] } },
  'empty operations': { media_capabilities: { operations: [] } },
  'non-array operations': { media_capabilities: { operations: 'text_to_video' } },
  'array parameters': { media_capabilities: { parameters: [] } },
  'undeclared default': { media_capabilities: { defaults: { duration: 4 } } },
  'protocol-incompatible parameter': { media_capabilities: { parameters: { n: {} } } },
  'parameter type mismatch': { media_capabilities: { parameters: { duration: { type: 'string' } } } },
  'parameter scalar': { media_capabilities: { parameters: { duration: true } } },
  'inverted range': { media_capabilities: { parameters: { duration: { min: 9, max: 3 } } } },
  'numeric bounds for a boolean': { media_capabilities: { parameters: { audio: { min: 3 } } } },
  'image dimensions for a duration': { media_capabilities: { parameters: { duration: { minPixels: 3 } } } },
  'unbounded numeric value': { media_capabilities: { parameters: { duration: { max: Infinity } } } },
  'enum type mismatch': { media_capabilities: { parameters: { duration: { enum: ['4'] } } } },
  'default out of range': { media_capabilities: { parameters: { duration: { min: 2, max: 4 } }, defaults: { duration: 8 } } },
  'default false for numeric parameter': { media_capabilities: { parameters: { duration: {} }, defaults: { duration: false } } },
  'null references': { media_capabilities: { references: null } },
  'negative reference limit': { media_capabilities: { references: { max: -1 } } },
  'reference min exceeds max': { media_capabilities: { references: { min: 3, max: 1 } } },
  'negative combined image limit': { media_capabilities: { maxTotalImages: -1 } },
  'invalid reference combined limit': { media_capabilities: { references: { max: 1, maxTotalWithOutputs: '2' } } },
  'image input missing reference allowance': { media_capabilities: { operations: ['image_to_video'] } },
  'unsupported reference role': { media_capabilities: { operations: ['image_to_video'], references: { max: 1, roles: ['driving_audio'] } } },
  'invalid reference mime': { media_capabilities: { references: { max: 1, formats: ['https://unexpected.invalid'] } } },
  'unknown capability field': { media_capabilities: { headers: { authorization: 'not-imported' } } },
  'conflicting capability sources': { capabilities: { ...videoCaps(), defaults: { duration: 3, audio: false } } },
  'video edit transport': { editTransport: 'multipart' },
};
for (const [name, patch] of Object.entries(invalidCases)) {
  test(`untrusted or unsupported ${name} falls back to manual template selection`, () => {
    assert.equal(config(item(patch)), undefined);
  });
}
test('invalid image patterns and conflicting edit transports do not auto-configure', () => {
  assert.equal(config({ protocol: 'openai-images', capabilities: { parameters: { size: { pattern: '[' } } } }), undefined);
  assert.equal(config({ protocol: 'openai-images', capabilities: { parameters: { size: { pattern: '^\\d+x\\d+$' } }, defaults: { size: 'bogus' } } }), undefined);
  assert.equal(config({ protocol: 'openai-images', capabilities: { parameters: { size: { minPixels: 655360 } }, defaults: { size: '16x16' } } }), undefined);
  assert.equal(config({ protocol: 'openai-images', capabilities: { parameters: { size: { minRatio: 0.5, maxRatio: 2 } }, defaults: { size: '1024x64' } } }), undefined);
  assert.equal(config({ protocol: 'openai-images', capabilities: { parameters: { size: { multipleOf: 16 } }, defaults: { size: '31x31' } } }), undefined);
  assert.ok(config({ protocol: 'openai-images', capabilities: { parameters: { size: { pattern: '^\\d+x\\d+$', minPixels: 655360 } }, defaults: { size: '1024x1024' } } }));
  assert.equal(config({ protocol: 'openai-images', editTransport: 'multipart', media: { editTransport: 'json-images' } }), undefined);
  assert.equal(config({ protocol: 'openai-images', editTransport: 'json-images' }).editTransport, 'json-images');
  assert.equal(config({ protocol: 'openai-images', editTransport: 'json-image-urls' }).editTransport, 'json-image-urls');
});
test('declared reference roles, MIME formats and combined limits retain their runtime keys', () => {
  const caps = { operations: ['image_to_video'], parameters: {}, defaults: {}, references: { max: 2, roles: ['reference_image', 'reference_video', 'reference_audio'], formats: ['image/png', 'video/mp4', 'audio/mpeg'], defaultRole: 'reference_image', maxTotalWithOutputs: 3 }, maxTotalImages: 4 };
  assert.deepEqual(config({ protocol: 'ark-video', capabilities: caps }).capabilities, caps);
  assert.equal(config({ protocol: 'openai-images', capabilities: { references: { max: 1, formats: ['video/mp4'] } } }), undefined);
});
test('transport, auth, endpoint and credential metadata never enter automatic bindings', () => {
  const input = item({ apiKey: 'synthetic-only', baseUrl: 'https://another.invalid', endpoints: { submit: 'https://another.invalid/run' }, auth: { mode: 'none' }, routeHeaders: { authorization: 'synthetic-only' } });
  const result = config(input);
  assert.deepEqual(Object.keys(result).sort(), ['capabilities', 'protocol']);
  assert.equal(JSON.stringify(result).includes('synthetic-only'), false);
  assert.equal(JSON.stringify(result).includes('another.invalid'), false);
});
test('all generic templates are protocol-scoped and declare no unverified model parameters', () => {
  const presets = getMediaProtocolPresets().capabilities;
  for (const [protocol, def] of Object.entries(MEDIA_PROTOCOLS)) {
    const preset = presets.find(value => value.id === `protocol-${protocol}`);
    assert.ok(preset); assert.deepEqual(preset, { id: `protocol-${protocol}`, ...getMediaCapabilityPreset(`protocol-${protocol}`) });
    assert.deepEqual(preset.capabilities.operations, [def.operations[0]]);
    assert.deepEqual(preset.capabilities.parameters, {}); assert.deepEqual(preset.capabilities.defaults, {});
  }
  assert.ok(presets.find(value => value.id === 'seedance-2.5-video'));
});

test('discovery and persisted catalogs retain metadata, exact IDs and distinct owners without activating models', async t => {
  const payload = { data: [
    item({ id: 'Same', owned_by: 'first' }),
    item({ id: 'Same', owned_by: 'second', media_protocol: 'dashscope-video' }),
    { id: 'same', owned_by: 'first', protocol: 'openai-images' },
    { id: 'LegacyUnknown', model_type: 'image_generation', owned_by: 'other' },
  ] };
  const records = normalizeModelCatalog(payload).catalog;
  assert.deepEqual(records.map(row => [row.id, row.ownedBy]), [['Same', 'first'], ['Same', 'second'], ['same', 'first'], ['LegacyUnknown', 'other']]);
  assert.equal(records[0].mediaConfig.protocol, 'ark-video');
  assert.equal(records[1].mediaConfig.protocol, 'dashscope-video');
  assert.equal(records[2].modality, 'image'); assert.equal(records[3].mediaConfig, undefined);
  const result = await discoverProviderModels({ env: { ANTHROPIC_BASE_URL: 'https://custom-gateway.invalid/proxy', ANTHROPIC_API_KEY: 'synthetic-directory-key' } }, {
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.equal(result.accessVerified, false);
  assert.deepEqual(result.mediaModels.map(row => row.mediaConfig), records.map(row => row.mediaConfig));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-catalog-metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { userDataDir: dir, logger: { warn() {} }, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } };
  const store = new ProviderStore(options);
  const profile = store.createProfile({ name: 'Any gateway', baseUrl: 'https://custom-gateway.invalid/proxy', apiKey: 'synthetic-directory-key',
    models: { sonnet: 'synthetic-chat' }, mediaModels: [{ modelId: 'HandConfigured', protocol: 'openai-images', endpoints: { generate: '/proxy/custom-images' }, capabilities: { operations: ['text_to_image'], defaults: { n: 1 }, parameters: { n: { min: 1, max: 1 } }, references: { max: 0 } } }],
  }).profile;
  store.setMediaCatalog(profile.id, result.mediaModels);
  const restart = new ProviderStore(options), saved = restart.getProfile(profile.id);
  assert.deepEqual(saved.mediaCatalog.map(row => row.mediaConfig), records.map(row => row.mediaConfig));
  assert.deepEqual(saved.mediaModels, profile.mediaModels);
  assert.equal(saved.mediaConnection.preset, 'custom');
  assert.equal(restart.listMediaModels().length, 1);
  assert.equal(JSON.stringify(saved.mediaCatalog).includes('synthetic-directory-key'), false);
  const unrecognized = clone(result.mediaModels); unrecognized[0].mediaConfig.capabilities.defaults.duration = 900;
  restart.setMediaCatalog(profile.id, unrecognized);
  assert.equal(restart.getProfile(profile.id).mediaCatalog[0].mediaConfig, undefined);
  assert.deepEqual(restart.getProfile(profile.id).mediaModels, profile.mediaModels);
});

test('same protocol/model with different owners gets independent new bindings, existing IDs remain unchanged', () => {
  const base = { modelId: 'same-model', protocol: 'ark-video', capabilities: videoCaps() };
  const values = normalizeMediaModels([{ ...base, ownedBy: 'one' }, { ...base, ownedBy: 'two' }], { strict: true });
  assert.equal(values.length, 2); assert.notEqual(values[0].id, values[1].id);
  const saved = normalizeMediaModels([{ ...base, ownedBy: 'one', id: 'existing-binding' }], { strict: true });
  assert.equal(saved[0].id, 'existing-binding');
  assert.deepEqual(normalizeMediaModels(values, { strict: true }), values);
  const catalog = normalizeModelCatalog({ data: [item({ id: 'CaseSensitive', owned_by: 'Owner' }), item({ id: 'CaseSensitive', owned_by: 'owner' })] }).catalog;
  assert.deepEqual(catalog.map(row => row.ownedBy), ['Owner', 'owner']);
});

test('untyped media candidates preserve exact raw IDs and owners independently of configured chat deduplication', async t => {
  const payload = { data: [
    { id: 'Same', owned_by: 'first' }, { id: 'Same', owned_by: 'second' },
    { id: 'Same', owned_by: 'First' }, { id: 'same', owned_by: 'first' },
    { id: 'Same', owned_by: 'first' },
    { id: 'Chat', model_type: 'text' }, { id: 'Voice', modality: 'audio' }, { id: 'Vectors', model_type: 'embedding' },
    { id: 'KnownImage', protocol: 'openai-images' }, { id: 'KnownVideo', model_type: 'video' },
  ] };
  const expected = [['Same', 'first'], ['Same', 'second'], ['Same', 'First'], ['same', 'first'], ['KnownImage', ''], ['KnownVideo', '']];
  const normalized = normalizeModelCatalog(payload, { configuredModels: ['Same'] });
  assert.equal(normalized.catalog.filter(row => row.value.toLowerCase() === 'same').length, 1, 'chat keeps its existing configured route deduplication');
  assert.deepEqual(normalized.mediaCandidates.map(row => [row.id, row.ownedBy]), expected);
  assert.equal(normalized.mediaCandidates[0].modality, '');
  assert.equal(normalized.mediaCandidates[0].mediaConfig, undefined);
  const discovered = await discoverProviderModels({ models: { sonnet: 'Same' }, env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_API_KEY: 'synthetic-only' } }, {
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.deepEqual(discovered.mediaCandidates.map(row => [row.id, row.ownedBy]), expected);
  assert.deepEqual(discovered.mediaModels.map(row => row.id), ['KnownImage', 'KnownVideo']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-untyped-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { userDataDir: dir, logger: { warn() {} }, safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } };
  const store = new ProviderStore(options);
  const profile = store.createProfile({ name: 'Untyped directory', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only', models: { sonnet: 'Same' } }).profile;
  store.setMediaCatalog(profile.id, discovered.mediaCandidates);
  assert.deepEqual(new ProviderStore(options).getProfile(profile.id).mediaCatalog.map(row => [row.id, row.ownedBy]), expected);
  assert.equal(store.listMediaModels().length, 0);
});

test('contradictory media types stay as untyped candidates so all templates remain available', () => {
  for (const value of [
    { id: 'Conflict', model_type: 'image', modality: 'video', protocol: 'ark-video' },
    { id: 'Conflict', model_type: 'image', modality: 'video' },
    { id: 'Conflict', model_type: 'image', protocol: 'ark-video' },
  ]) {
    const metadata = normalizeMediaCatalogMetadata(value);
    assert.deepEqual(metadata, { modelType: '', model_type: '', modality: '', mediaTemplateBlocked: true });
    const candidates = normalizeModelCatalog({ data: [value] }).mediaCandidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].modality, ''); assert.equal(candidates[0].modelType, '');
    assert.equal(candidates[0].mediaConfig, undefined);
  }
  assert.equal(normalizeModelCatalog({ data: [{ id: 'Image', model_type: 'image' }] }).mediaCandidates[0].modality, 'image');
});

test('nested type-only metadata remains a media candidate without guessing a protocol', () => {
  for (const key of ['media', 'mediaConfig']) {
    for (const modality of ['image', 'video']) {
      const value = { id: 'Nested', [key]: { modality } };
      assert.deepEqual(normalizeMediaCatalogMetadata(value), { modelType: modality, model_type: modality, modality });
      const normalized = normalizeModelCatalog({ data: [value] });
      assert.equal(normalized.catalog[0].modality, modality);
      assert.equal(normalized.mediaCandidates[0].modality, modality);
      assert.equal(normalized.mediaCandidates[0].mediaConfig, undefined);
    }
    assert.equal(normalizeModelCatalog({ data: [{ id: 'Chat', [key]: { modality: 'text' } }] }).mediaCandidates.length, 0);
  }
});
