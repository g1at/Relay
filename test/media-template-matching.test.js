'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { matchMediaTemplate } = require('../renderer/media-template-matching');

const known = {
  'doubao-seedance-2.5': ['seedance-2.5-video', 'seedance', 'Seedance 2.5'],
  'dreamina-seedance-2-5-260628': ['seedance-2.5-video', 'seedance', 'Seedance 2.5'],
  'doubao-seedance-2-0-260128': ['seedance-2.0-video', 'seedance', 'Seedance 2.0'],
  'gpt-image-2': ['openai-image', 'gpt-image', 'GPT Image 2'],
  'gpt-image-2.5': ['gpt-image-2.5', 'gpt-image', 'GPT Image 2.5'],
  'gpt-image-2.5-sunburst': ['gpt-image-2.5', 'gpt-image', 'GPT Image 2.5'],
  'gpt-image-2.5-flare': ['gpt-image-2.5', 'gpt-image', 'GPT Image 2.5'],
  'wan3.0': ['wan-3-video', 'wan', 'Wan 3.0'],
  'wan3.0-video': ['wan-3-video', 'wan', 'Wan 3.0'],
  'wan3.0-t2v': ['wan-3-video', 'wan', 'Wan 3.0'],
  'wan2.7': ['wan-2.7-video', 'wan', 'Wan 2.7'],
  'wan2.7-video': ['wan-2.7-video', 'wan', 'Wan 2.7'],
  'wan2.7-t2v': ['wan-2.7-video', 'wan', 'Wan 2.7'],
  'wan2.7-i2v': ['wan-2.7-first-frame', 'wan', 'Wan 2.7 首帧视频'],
  'wan2.6-t2i': ['wan-2.6-image', 'wan', 'Wan 2.6 图像'],
  'Doubao-Seedream-4.0': ['seedream-4.0', 'seedream', 'Seedream 4.0'],
  'Doubao-Seedream-4.0-20260415': ['seedream-4.0', 'seedream', 'Seedream 4.0'],
  'Doubao-Seedream-4.5': ['seedream-classic', 'seedream', 'Seedream 4.5'],
  'Doubao-Seedream-5.0-flash': ['seedream-single', 'seedream', 'Seedream 5.0 Flash'],
  'Doubao-Seedream-5.0-pro': ['seedream-5-pro', 'seedream', 'Seedream 5.0 Pro'],
  'Doubao-Seedream-5.0-lite': ['seedream-5-lite', 'seedream', 'Seedream 5.0 Lite'],
  'qwen-image-2.0': ['qwen', 'qwen-image', 'Qwen Image 2.0'],
  'qwen-image-2.0-pro': ['qwen', 'qwen-image', 'Qwen Image 2.0'],
  'qwen-image-2.0-2026-06-22': ['qwen', 'qwen-image', 'Qwen Image 2.0'],
  'qwen-image-2.0-pro-2026-06-22': ['qwen', 'qwen-image', 'Qwen Image 2.0'],
  'qwen-image-3.0': ['qwen-3', 'qwen-image', 'Qwen Image 3.0'],
  'qwen-image-3.0-pro': ['qwen-3', 'qwen-image', 'Qwen Image 3.0'],
  'z-image-turbo': ['z-image', 'z-image', 'Z-Image Turbo'],
};
for (const [id, [templateId, family, label]] of Object.entries(known)) {
  test(`suggests a versioned template for ${id}`, () => {
    assert.deepEqual(matchMediaTemplate({ id }), { templateId, family, label, source: 'family-template' });
  });
}
test('namespace and catalog aliases do not change model ID or owner', () => {
  for (const key of ['id', 'rawId', 'modelId']) {
    const input = { [key]: 'upstream/azure_openai/GPT-IMAGE-2.5-SUNBURST', owned_by: 'gateway-route-b', model_type: 'image' };
    const before = JSON.stringify(input);
    assert.equal(matchMediaTemplate(input).templateId, 'gpt-image-2.5');
    assert.equal(JSON.stringify(input), before);
  }
});
test('owner and gateway labels do not determine a protocol or restrict known families', () => {
  assert.equal(matchMediaTemplate({ id: 'anything-new', owned_by: 'azure_openai' }), null);
  for (const owned_by of ['azure_openai', 'another-gateway', '']) {
    assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5', owned_by }).templateId, 'gpt-image-2.5');
  }
});
test('unknown versions, partial names and operation variants require a template choice', () => {
  for (const id of ['seedance', 'doubao-seedance-2.0', 'doubao-seedance-2.5-fast', 'doubao-seedance-2.50',
    'gpt-image-2.6', 'gpt-image-2.5-new', 'not-gpt-image-2.5', 'prefix-gpt-image-2.5',
    'wan3.1', 'wan3.0-i2v', 'wan3.0-r2v', 'wan3.0-v2v', 'wan2.7-ti2v', 'wan2.7-s2v', 'wan-video',
    'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260128', 'doubao-seedance-2-0-260128-fast',
    'doubao-seedance-2-0-260128-mini', 'qwen-image-3.0-max', 'wan2.6-i2i', 'doubao-seedream-4.0-20990101',
    'doubao-seedream-5.0-new', 'qwen-image-2.0-max', 'qwen-image-2.0-2099-01-01', 'z-image-future', 'image', 'video']) {
    assert.equal(matchMediaTemplate({ id }), null, id);
  }
});
test('every explicit protocol or capability declaration disables family fallback', () => {
  for (const key of ['protocol', 'media_protocol', 'mediaProtocol', 'capabilities', 'media_capabilities', 'mediaCapabilities', 'editTransport']) {
    for (const value of [undefined, null, '', false, 'openai-images', {}, { operations: ['text_to_image'] }]) {
      for (const at of ['root', 'media', 'mediaConfig']) {
        const item = { id: 'gpt-image-2.5' };
        if (at === 'root') item[key] = value;
        else item[at] = { [key]: value };
        assert.equal(matchMediaTemplate(item), null, `${at}.${key}`);
      }
    }
  }
});
test('invalid nested metadata never becomes a family match', () => {
  for (const key of ['media', 'mediaConfig']) for (const value of [null, [], true, 'image', 5]) {
    assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5', [key]: value }), null);
  }
});
test('a rejected directory declaration cannot regain a template after normalization', () => {
  assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5', mediaTemplateBlocked: true }), null);
  assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5', mediaTemplateBlocked: false }).templateId, 'gpt-image-2.5');
});
test('matching type-only metadata is accepted at every supported level', () => {
  for (const at of ['root', 'media', 'mediaConfig']) {
    for (const key of ['model_type', 'modelType', 'modality']) {
      const item = { id: 'doubao-seedance-2.5' };
      if (at === 'root') item[key] = 'video_generation';
      else item[at] = { [key]: 'video_generation' };
      assert.equal(matchMediaTemplate(item).templateId, 'seedance-2.5-video');
    }
  }
});
test('contradictory or invalid type metadata cannot be overridden by the name', () => {
  for (const patch of [{ model_type: 'image' }, { modality: 'text' }, { modality: false }, { modality: null },
    { model_type: 'video', modelType: 'image' }, { model_type: 'video', media: { modality: 'image' } },
    { model_type: 'video', mediaConfig: { modality: 'text' } }]) {
    assert.equal(matchMediaTemplate({ id: 'doubao-seedance-2.5', ...patch }), null);
  }
});
test('raw identities take precedence over derived aliases', () => {
  assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5', rawId: 'unknown-original' }), null);
  assert.equal(matchMediaTemplate({ id: 'rewritten-name', rawId: 'gpt-image-2.5' }).templateId, 'gpt-image-2.5');
});
test('invalid IDs and non-record inputs remain unmatched', () => {
  for (const item of [null, undefined, false, [], 'gpt-image-2.5', {}, { id: 3 }, { id: {} }]) assert.equal(matchMediaTemplate(item), null);
  for (const id of ['https://gateway.test/gpt-image-2.5', '/gpt-image-2.5', 'route//gpt-image-2.5',
    'gpt-image-2.5?model=other', 'gpt-image-2.5#other', 'gpt-image-2.5/other', 'prefix gpt-image-2.5']) {
    assert.equal(matchMediaTemplate({ id }), null, id);
  }
});
test('matches return independent suggestion objects', () => {
  const first = matchMediaTemplate({ id: 'gpt-image-2.5' }); first.templateId = 'changed';
  assert.equal(matchMediaTemplate({ id: 'gpt-image-2.5' }).templateId, 'gpt-image-2.5');
});
test('the renderer loads the same matcher without Node globals', () => {
  const window = {};
  const source = fs.readFileSync(require.resolve('../renderer/media-template-matching'), 'utf8');
  const context = vm.createContext({ window });
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(window.RelayMediaTemplateMatching.matchMediaTemplate({ id: 'gpt-image-2.5-sunburst' }).templateId, 'gpt-image-2.5');
  assert.equal(window.RelayMediaTemplateMatching.matchMediaTemplate({ id: 'gpt-image-2.5', mediaTemplateBlocked: true }), null);
  assert.equal(context.FAMILIES, undefined);
});
test('every suggested template exists in the shared capability data', () => {
  const { CAPABILITY_PRESETS } = require('../src/main/providers/media-capability-presets');
  for (const id of Object.keys(known)) {
    const match = matchMediaTemplate({ id });
    assert.ok(CAPABILITY_PRESETS[match.templateId], `${id}: ${match.templateId}`);
  }
});
