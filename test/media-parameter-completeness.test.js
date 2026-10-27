'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getMediaCapabilityPreset, normalizeMediaCatalogMetadata, normalizeMediaModels } = require('../src/main/providers/provider-media');
const { CAPABILITY_PRESETS, PREVIOUS_CAPABILITY_PRESETS, TEMPLATE_VERSION } = require('../src/main/providers/media-capability-presets');
const { encodeSubmit, validateInput, MediaValidationError } = require('../src/main/media/media-protocols');
const { ProviderStore } = require('../src/main/providers/provider-store');

const copy = value => JSON.parse(JSON.stringify(value));
const image = 'data:image/png;base64,aGVsbG8=';
const modelIds = {
  'openai-image': 'gpt-image-2', 'gpt-image-2.5': 'gpt-image-2.5-sunburst',
  'seedream-4.0': 'Doubao-Seedream-4.0', 'seedream-classic': 'Doubao-Seedream-4.5',
  'seedream-5-lite': 'Doubao-Seedream-5.0-lite', 'seedream-single': 'Doubao-Seedream-5.0-flash',
  'seedream-5-pro': 'Doubao-Seedream-5.0-pro', qwen: 'qwen-image-2.0-pro', 'qwen-3': 'qwen-image-3.0-pro',
  'wan-2.6-image': 'wan2.6-t2i', 'z-image': 'z-image-turbo',
  'seedance-2.0-video': 'doubao-seedance-2-0-260128', 'seedance-2.5-video': 'dreamina-seedance-2-5-260628',
  'wan-3-video': 'wan3.0-video', 'wan-2.7-video': 'wan2.7-t2v', 'wan-2.7-first-frame': 'wan2.7-i2v',
};
function binding(id, patch = {}) {
  const preset = getMediaCapabilityPreset(id);
  assert.ok(preset, id);
  return { modelId: modelIds[id], protocol: preset.protocol, capabilities: preset.capabilities,
    baseUrl: 'https://gateway.fixture.invalid/proxy/v1', auth: { mode: 'bearer' }, ...patch };
}
function inputFor(id, patch = {}) { return { prompt: 'A simple blue cube', ...(id === 'wan-2.7-first-frame' ? { references: [image] } : {}), ...patch }; }
function request(id, fields = {}) { return encodeSubmit(binding(id), inputFor(id, fields)).body; }
function invalid(id, fields) {
  const input = inputFor(id, fields);
  assert.equal(validateInput(binding(id), input).ok, false, `${id}: ${JSON.stringify(fields)}`);
  assert.throws(() => encodeSubmit(binding(id), input), MediaValidationError);
}

for (const id of Object.keys(modelIds)) {
  test(`${id}: full official template survives directory normalization and encodes a default request`, () => {
    const preset = getMediaCapabilityPreset(id);
    const catalog = normalizeMediaCatalogMetadata({ id: modelIds[id], protocol: preset.protocol, capabilities: preset.capabilities });
    assert.deepEqual(catalog.mediaConfig?.capabilities, preset.capabilities);
    const body = request(id);
    assert.equal(body.model, modelIds[id]);
  });
}

test('Seedream 5 Pro exposes custom dimensions, watermark, response/output formats and prompt optimisation on the wire', () => {
  const body = request('seedream-5-pro', { size: '1536x1024', watermark: false, responseFormat: 'b64_json', outputFormat: 'png', promptOptimize: 'fast' });
  assert.equal(body.size, '1536x1024');
  assert.equal(body.watermark, false);
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.output_format, 'png');
  assert.deepEqual(body.optimize_prompt_options, { mode: 'fast' });
  assert.equal(body.promptOptimize, undefined);
  assert.equal(binding('seedream-5-pro').capabilities.defaults.size, '2K');
  for (const size of ['1K', '1.5K', '2K', '960x960', '2100x2100']) assert.equal(request('seedream-5-pro', { size }).size, size);
  for (const size of ['4K', '959x960', '4096x4096', '4096x200', '1024*1024', '1024x', '0x1000']) invalid('seedream-5-pro', { size });
  for (const fields of [{ n: 2 }, { sequential: true }, { seed: 1 }, { layerDecomposition: true }]) invalid('seedream-5-pro', fields);
});

test('Seedream versions keep their distinct dimension ranges and optional fields', () => {
  assert.equal(request('seedream-4.0', { size: '1K', promptOptimize: 'standard' }).size, '1K');
  assert.equal(request('seedream-classic', { size: '1920x1920', sequential: true, n: 2 }).sequential_image_generation_options.max_images, 2);
  assert.equal(request('seedream-5-lite', { size: '3K', outputFormat: 'jpeg' }).output_format, 'jpeg');
  assert.equal(request('seedream-single', { size: '1.5K', outputFormat: 'png', responseFormat: 'url' }).size, '1.5K');
  invalid('seedream-classic', { size: '1024x1024' });
  invalid('seedream-5-lite', { size: '1K' });
  invalid('seedream-single', { promptOptimize: 'fast' });
  invalid('seedream-classic', { outputFormat: 'png' });
  invalid('seedream-classic', { n: 2, sequential: false });
});

for (const id of ['seedream-4.0', 'seedream-classic', 'seedream-5-lite']) {
  test(`${id}: reference images and requested outputs share the official fifteen-image limit`, () => {
    for (const [referenceCount, n] of [[14, 1], [13, 2]]) {
      const body = request(id, { references: Array(referenceCount).fill(image), sequential: true, n });
      assert.equal(body.image.length, referenceCount);
      assert.equal(body.sequential_image_generation_options.max_images, n);
    }
    const fields = { references: Array(14).fill(image), sequential: true, n: 2 };
    const result = validateInput(binding(id), inputFor(id, fields));
    assert.ok(result.errors.some(error => error.code === 'combined_image_limit'));
    invalid(id, fields);
  });
}

for (const id of ['openai-image', 'gpt-image-2.5']) {
  test(`${id}: compression and flexible dimensions are encoded with format dependencies`, () => {
    const body = request(id, { size: 'auto', outputFormat: 'jpeg', outputCompression: 0 });
    assert.equal(body.size, 'auto'); assert.equal(body.output_format, 'jpeg'); assert.equal(body.output_compression, 0);
    assert.equal(body.outputCompression, undefined);
    assert.equal(request(id, { size: '1536x1024', outputFormat: 'webp', outputCompression: 100 }).output_compression, 100);
    for (const fields of [{ size: '1025x1024' }, { size: '4096x1024' }, { size: '2048x512' }, { outputCompression: 101, outputFormat: 'jpeg' }, { outputCompression: -1, outputFormat: 'webp' }, { outputCompression: 10.5, outputFormat: 'jpeg' }, { outputCompression: 80, outputFormat: 'png' }, { outputCompression: 80 }]) invalid(id, fields);
  });
}

test('GPT 2.5 transparency cannot silently request JPEG', () => {
  invalid('gpt-image-2.5', { background: 'transparent', outputFormat: 'jpeg' });
  assert.equal(request('gpt-image-2.5', { background: 'transparent', outputFormat: 'webp', quality: 'xhigh' }).background, 'transparent');
});

for (const id of ['openai-image', 'gpt-image-2.5']) {
  test(`${id}: moderation is encoded and transparent backgrounds require a compatible output format`, () => {
    for (const moderation of ['auto', 'low']) assert.equal(request(id, { moderation }).moderation, moderation);
    for (const moderation of ['high', 'disabled', false]) invalid(id, { moderation });
    invalid(id, { background: 'transparent', outputFormat: 'jpeg' });
    assert.equal(request(id, { background: 'transparent', outputFormat: 'png' }).background, 'transparent');
    assert.equal(request(id, { background: 'opaque', outputFormat: 'jpeg' }).output_format, 'jpeg');
  });
}

test('Qwen 2 and Wan 2.6 image optional controls reach DashScope parameter fields', () => {
  for (const id of ['qwen', 'wan-2.6-image']) {
    const body = request(id, { negativePrompt: 'blur', watermark: true, seed: 0, promptExtend: true });
    assert.equal(body.parameters.negative_prompt, 'blur'); assert.equal(body.parameters.watermark, true);
    assert.equal(body.parameters.seed, 0); assert.equal(body.parameters.prompt_extend, true);
    assert.equal(body.input.negative_prompt, undefined);
    assert.equal(request(id, { seed: 2147483647 }).parameters.seed, 2147483647);
    invalid(id, { seed: -1 }); invalid(id, { seed: 2147483648 }); invalid(id, { negativePrompt: 'x'.repeat(501) });
  }
});

test('Qwen 3 thinking and agent rewriting require enabled prompt extension and valid operation', () => {
  const body = request('qwen-3', { promptExtend: true, enableThinking: true, promptExtendMode: 'agent' });
  assert.equal(body.parameters.prompt_extend, true); assert.equal(body.parameters.enable_thinking, true);
  assert.equal(body.parameters.prompt_extend_mode, 'agent');
  assert.equal(body.parameters.promptExtendMode, undefined);
  invalid('qwen-3', { promptExtend: false, enableThinking: true });
  invalid('qwen-3', { promptExtend: false, promptExtendMode: 'direct' });
  invalid('qwen-3', { references: [image], promptExtend: true, promptExtendMode: 'agent' });
  const edit = request('qwen-3', { references: [image], promptExtend: true, promptExtendMode: 'direct' });
  assert.equal(edit.parameters.prompt_extend_mode, 'direct');
  assert.deepEqual(edit.input.messages[0].content[0], { image });
});

test('Z Image seed is usable while unsupported quantity and watermark remain absent', () => {
  assert.equal(request('z-image', { seed: 2147483647 }).parameters.seed, 2147483647);
  for (const fields of [{ seed: -1 }, { n: 2 }, { watermark: true }, { negativePrompt: 'blur' }]) invalid('z-image', fields);
});

for (const [id, min, max] of [['seedance-2.0-video', 4, 15], ['seedance-2.5-video', 4, 30], ['wan-3-video', 2, 30]]) {
  test(`${id}: automatic duration is a discrete value, not an expanded continuous range`, () => {
    for (const duration of [-1, min, max]) {
      const body = request(id, { duration, watermark: true });
      assert.equal((body.parameters || body).duration, duration);
      assert.equal((body.parameters || body).watermark, true);
    }
    for (const duration of [-2, 0, 1, min - 1, max + 1, min + 0.5, '-1']) invalid(id, { duration });
  });
}

test('Seedance 2.5 format and audio use Ark field names without borrowing unsupported 1.0 controls', () => {
  const body = request('seedance-2.5-video', { outputFormat: 'mov', audio: true });
  assert.equal(body.output_format, 'mov'); assert.equal(body.generate_audio, true); assert.equal(body.audio, undefined);
  invalid('seedance-2.0-video', { outputFormat: 'mov' });
  for (const id of ['seedance-2.0-video', 'seedance-2.5-video']) invalid(id, { seed: 1 });
});

test('Wan 3 keeps audio and random-seed support without inheriting a Wan 2.7 negative prompt', () => {
  const body = request('wan-3-video', { promptExtend: false, audio: true, seed: -1, watermark: false });
  assert.deepEqual({ audio: body.parameters.audio, seed: body.parameters.seed, watermark: body.parameters.watermark, prompt_extend: body.parameters.prompt_extend },
    { audio: true, seed: -1, watermark: false, prompt_extend: false });
  invalid('wan-3-video', { negativePrompt: 'blur' }); invalid('wan-3-video', { seed: -2 });
});

for (const id of ['wan-2.7-video', 'wan-2.7-first-frame']) {
  test(`${id}: supported extra fields are encoded and invalid audio/automatic duration are rejected`, () => {
    const body = request(id, { negativePrompt: 'blur', promptExtend: true, watermark: true, seed: 2147483647, duration: 15 });
    assert.equal(body.input.negative_prompt, 'blur'); assert.equal(body.parameters.negative_prompt, undefined);
    assert.equal(body.parameters.seed, 2147483647); assert.equal(body.parameters.prompt_extend, true);
    assert.equal(body.parameters.watermark, true); assert.equal(body.parameters.audio, undefined);
    for (const fields of [{ audio: false }, { duration: -1 }, { seed: -1 }, { negativePrompt: 'x'.repeat(501) }]) invalid(id, fields);
  });
}

test('new capability rules round-trip from any gateway without importing its transport or secrets', () => {
  for (const [id, defaults] of [['seedream-5-pro', { size: '1536x1024' }], ['seedance-2.5-video', { duration: -1 }]]) {
    const preset = getMediaCapabilityPreset(id);
    Object.assign(preset.capabilities.defaults, defaults);
    const result = normalizeMediaCatalogMetadata({ id: 'Vendor/unknown-new-model', protocol: preset.protocol, capabilities: preset.capabilities,
      baseUrl: 'https://untrusted.invalid', apiKey: 'synthetic-key', endpoints: { generate: '/wrong' } });
    assert.deepEqual(result.mediaConfig, { protocol: preset.protocol, capabilities: preset.capabilities });
    assert.equal(JSON.stringify(result.mediaConfig).includes('synthetic-key'), false);
  }
});

test('invalid allowCustom and specialValues declarations cannot become automatic capabilities', () => {
  const samples = [
    ['ark-images', { size: { enum: ['2K'], allowCustom: true } }],
    ['ark-images', { size: { pattern: '^\\d+x\\d+$', allowCustom: true } }],
    ['ark-images', { size: { enum: ['2K'], pattern: '^\\d+x\\d+$', allowCustom: 'yes' } }],
    ['ark-video', { duration: { min: 4, max: 30, specialValues: ['-1'] } }],
    ['ark-video', { duration: { min: 4, max: 30, specialValues: [-1.5] } }],
    ['ark-video', { duration: { min: 4, max: 30, specialValues: [] } }],
    ['ark-video', { resolution: { specialValues: [-1] } }],
  ];
  for (const [protocol, parameters] of samples) {
    const result = normalizeMediaCatalogMetadata({ id: 'unknown', protocol, capabilities: { parameters } });
    assert.equal(result.mediaConfig, undefined, JSON.stringify(parameters)); assert.equal(result.mediaTemplateBlocked, true);
  }
});

function oldBinding(id, patch = {}) {
  const oldId = id === 'seedream-5-pro' ? 'seedream-single' : id;
  const preset = PREVIOUS_CAPABILITY_PRESETS[oldId];
  return { id: `existing-${id}`, modelId: modelIds[id], protocol: preset.protocol, capabilities: copy(preset.capabilities),
    setup: { source: 'family-template', templateId: oldId, version: 2 }, ...patch };
}
function normalize(value, catalog = []) { return normalizeMediaModels([value], { strict: true, catalog })[0]; }

test('v2 snapshots retain the old contracts used for non-destructive migrations', () => {
  assert.deepEqual(PREVIOUS_CAPABILITY_PRESETS['seedream-single'].capabilities.parameters, { size: { enum: ['1K', '1.5K', '2K'] } });
  assert.equal(PREVIOUS_CAPABILITY_PRESETS['seedream-single'].capabilities.defaults.size, '1K');
  assert.equal(PREVIOUS_CAPABILITY_PRESETS['wan-2.7-video'].capabilities.defaults.audio, false);
  assert.deepEqual(PREVIOUS_CAPABILITY_PRESETS['seedance-2.5-video'].capabilities.parameters.duration, { min: 4, max: 30, integer: true });
});

for (const id of Object.keys(modelIds)) {
  test(`${id}: a pristine v2 template upgrades once and retains valid saved defaults`, () => {
    const source = oldBinding(id), before = copy(source), result = normalize(source);
    assert.deepEqual(source, before, 'draft object is never mutated');
    assert.equal(result.setup.version, TEMPLATE_VERSION); assert.equal(result.setup.templateId, id);
    assert.deepEqual(result.capabilities.parameters, CAPABILITY_PRESETS[id].capabilities.parameters);
    for (const [key, value] of Object.entries(source.capabilities.defaults)) {
      if (id === 'wan-2.7-video' && key === 'audio') assert.equal(result.capabilities.defaults.audio, undefined);
      else assert.deepEqual(result.capabilities.defaults[key], value, key);
    }
    assert.deepEqual(normalize(result), result);
  });
}

test('v2 migration preserves manual defaults and all non-capability gateway settings', () => {
  for (const sourceName of ['family-template', 'legacy-template', 'manual-template']) {
    const source = oldBinding('seedance-2.5-video', {
      modelId: 'other-vendor/dreamina-seedance-2-5-260628', ownedBy: 'custom-upstream', enabled: false, label: 'Custom label',
      setup: { source: sourceName, templateId: 'seedance-2.5-video', version: 2 },
      baseUrl: 'https://another-gateway.invalid/root', auth: { mode: 'api-key', headerName: 'x-client-key' },
      endpoints: { submit: '/custom/create', poll: '/custom/{taskId}' }, routeHeaders: { 'x-owner': 'custom-upstream' },
    });
    source.capabilities.defaults = { duration: 12, resolution: '1080p', ratio: '9:16', audio: true };
    const result = normalize(source);
    assert.equal(result.setup.version, TEMPLATE_VERSION); assert.equal(result.setup.source, sourceName);
    assert.deepEqual(result.capabilities.defaults, source.capabilities.defaults);
    for (const key of ['modelId', 'ownedBy', 'enabled', 'label', 'baseUrl', 'auth', 'endpoints', 'routeHeaders']) assert.deepEqual(result[key], source[key]);
    const wire = encodeSubmit({ ...result, auth: { ...result.auth, apiKey: 'synthetic-only' } }, { prompt: 'Cube', duration: -1 });
    assert.equal(wire.url, 'https://another-gateway.invalid/root/custom/create'); assert.equal(wire.body.model, source.modelId);
    assert.equal(wire.body.duration, -1); assert.equal(wire.headers['x-owner'], 'custom-upstream');
  }
});

test('v2 migration protects explicitly configured or edited contracts and invalid saved defaults', () => {
  const cases = [
    item => { item.setup.source = 'manual'; }, item => { item.setup.source = 'directory'; },
    item => { item.setup.version = 1; }, item => { item.setup.version = 99; },
    item => { item.setup.templateId = 'seedance-2.0-video'; }, item => { item.modelId = 'unseen-model'; },
    item => { item.capabilities.parameters.duration.max = 8; }, item => { item.capabilities.references.max = 1; },
    item => { item.capabilities.defaults.duration = 33; },
  ];
  for (const mutate of cases) {
    const source = oldBinding('seedance-2.5-video'); mutate(source);
    const result = normalize(source);
    assert.deepEqual(result.capabilities, source.capabilities); assert.deepEqual(result.setup, source.setup);
  }
  const wan = oldBinding('wan-2.7-video'); wan.capabilities.defaults.audio = true;
  assert.deepEqual(normalize(wan).capabilities, wan.capabilities, 'user-modified removed field must not be silently discarded');
});

test('v2 migration preserves explicitly omitted defaults instead of restoring new template defaults', () => {
  for (const defaults of [{}, { duration: 12 }]) {
    const source = oldBinding('seedance-2.5-video'); source.capabilities.defaults = defaults;
    const result = normalize(source);
    assert.equal(result.setup.version, TEMPLATE_VERSION);
    assert.deepEqual(result.capabilities.defaults, defaults);
    assert.deepEqual(normalize(result).capabilities.defaults, defaults);
  }
  const source = oldBinding('seedream-5-pro'); source.capabilities.defaults = {};
  const result = normalize(source);
  assert.equal(result.setup.templateId, 'seedream-5-pro');
  assert.deepEqual(result.capabilities.defaults, {});
});

test('unmarked exact v2 Wan 2.7 template sheds only its mistaken audio default during repair', () => {
  const source = oldBinding('wan-2.7-video'); delete source.setup;
  const result = normalize(source);
  assert.equal(result.setup.version, TEMPLATE_VERSION);
  assert.equal(result.setup.source, 'legacy-template');
  assert.equal(result.capabilities.parameters.audio, undefined);
  assert.equal(result.capabilities.defaults.audio, undefined);
  assert.deepEqual(result.capabilities.defaults, { duration: 2, resolution: '720P', ratio: '1:1' });
  const edited = copy(source); edited.capabilities.defaults.audio = true;
  assert.deepEqual(normalize(edited).capabilities, edited.capabilities);
  assert.equal(normalize(edited).setup, undefined);
});

test('negative-prompt limits count Unicode characters and survive directory validation', () => {
  for (const id of ['qwen', 'wan-2.6-image', 'wan-2.7-video', 'wan-2.7-first-frame']) {
    const negativePrompt = '🌙'.repeat(500);
    assert.equal(validateInput(binding(id), inputFor(id, { negativePrompt })).ok, true, id);
    invalid(id, { negativePrompt: negativePrompt + '月' });
    const preset = getMediaCapabilityPreset(id); preset.capabilities.defaults.negativePrompt = negativePrompt;
    const result = normalizeMediaCatalogMetadata({ protocol: preset.protocol, capabilities: preset.capabilities });
    assert.equal(result.mediaConfig?.capabilities.defaults.negativePrompt, negativePrompt);
  }
});

test('v2 migration respects directory declarations and owner boundaries', () => {
  const source = oldBinding('seedance-2.5-video', { ownedBy: 'route-one' });
  for (const extra of [{ mediaTemplateBlocked: true }, { mediaConfig: { protocol: source.protocol, capabilities: source.capabilities } }]) {
    const catalog = [{ id: source.modelId, ownedBy: 'route-one', ...extra }];
    assert.deepEqual(normalize(source, catalog).capabilities, source.capabilities);
    assert.equal(normalize({ ...source, ownedBy: 'route-two' }, catalog).setup.version, TEMPLATE_VERSION);
  }
});

test('persisted v2 templates upgrade atomically once without touching credentials, chat routes or custom bindings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-v3-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { userDataDir: dir, logger: { warn() {} }, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  } };
  const store = new ProviderStore(options);
  const profile = store.createProfile({ name: 'Any gateway', baseUrl: 'https://custom.invalid/proxy', apiKey: 'fixture-secret-only', models: { sonnet: 'my-chat' }, mediaConnection: { preset: 'custom' } }).profile;
  const disk = JSON.parse(fs.readFileSync(store.paths().profiles, 'utf8')), saved = disk.profiles.find(row => row.id === profile.id);
  const manual = oldBinding('wan-3-video', { setup: { source: 'manual' }, id: 'manual' });
  saved.mediaRevision = 17; saved.mediaModels = [oldBinding('seedream-5-pro'), oldBinding('seedance-2.5-video'), manual];
  const oldProfile = copy(saved), oldRoutes = copy(disk.chatRoutes), secrets = fs.readFileSync(store.paths().secrets);
  fs.writeFileSync(store.paths().profiles, JSON.stringify(disk, null, 2));
  const reopened = new ProviderStore(options); let writes = 0;
  const write = reopened.writeState.bind(reopened); reopened.writeState = state => { writes += 1; write(state); };
  const upgraded = reopened.getProfile(profile.id);
  assert.equal(writes, 1); assert.equal(upgraded.mediaRevision, 18);
  assert.equal(upgraded.mediaModels[0].setup.templateId, 'seedream-5-pro');
  assert.ok(upgraded.mediaModels.slice(0, 2).every(row => row.setup.version === TEMPLATE_VERSION));
  assert.deepEqual(upgraded.mediaModels[2].capabilities, manual.capabilities);
  for (const key of ['revision', 'models', 'baseUrl', 'credentialRef', 'createdAt', 'updatedAt', 'mediaConnection']) assert.deepEqual(reopened.readState().profiles[0][key], oldProfile[key], key);
  assert.deepEqual(reopened.readState().chatRoutes, oldRoutes); assert.deepEqual(fs.readFileSync(store.paths().secrets), secrets);
  const once = fs.readFileSync(store.paths().profiles); const again = new ProviderStore(options);
  again.writeState = () => assert.fail('migration must not write on subsequent opens');
  assert.equal(again.getProfile(profile.id).mediaRevision, 18);
  assert.deepEqual(fs.readFileSync(store.paths().profiles), once);
});
