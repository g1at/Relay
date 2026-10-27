'use strict';
// Declarative capability data; codecs never branch on model names.
// Keep these exact snapshots solely for non-destructive legacy-template repair.
const LEGACY_CAPABILITY_PRESETS = Object.freeze({
  'openai-image': { protocol: 'openai-images', label: 'GPT Image', capabilities: {
    operations: ['text_to_image', 'image_to_image'], defaults: { size: '1024x640', n: 1, quality: 'low' },
    parameters: { size: { pattern: '^\\d+x\\d+$', minPixels: 655360, maxPixels: 8294400 }, n: { min: 1, max: 10, integer: true }, quality: { enum: ['low', 'medium', 'high', 'auto'] } }, references: { max: 16 },
  } },
  'seedream-classic': { protocol: 'ark-images', label: 'Seedream 组图协议', capabilities: {
    operations: ['text_to_image', 'image_to_image'], defaults: { size: '2K', sequential: false },
    parameters: { size: { enum: ['2K', '4K'] }, sequential: { type: 'boolean' }, n: { min: 1, max: 15, integer: true } }, references: { max: 14 },
  } },
  'seedream-single': { protocol: 'ark-images', label: 'Seedream 单图协议', capabilities: {
    operations: ['text_to_image', 'image_to_image'], defaults: { size: '1K' },
    parameters: { size: { enum: ['1K', '1.5K', '2K'] } }, references: { max: 10 },
  } },
  qwen: { protocol: 'dashscope-images', label: 'Qwen Image', capabilities: {
    operations: ['text_to_image', 'image_to_image'], defaults: { size: '512*512', n: 1, promptExtend: false },
    parameters: { size: { pattern: '^\\d+\\*\\d+$', minPixels: 262144, maxPixels: 4194304 }, n: { min: 1, max: 6, integer: true }, promptExtend: { type: 'boolean' } }, references: { max: 3 },
  } },
  'z-image': { protocol: 'dashscope-images', label: 'Z-Image', capabilities: {
    operations: ['text_to_image'], defaults: { size: '512*512', promptExtend: false },
    parameters: { size: { pattern: '^\\d+\\*\\d+$', minPixels: 262144, maxPixels: 4194304 }, promptExtend: { type: 'boolean' } }, references: { max: 0 },
  } },
  'wan-video': { protocol: 'dashscope-video', label: 'Wan Video', capabilities: {
    operations: ['text_to_video'], defaults: { duration: 2, resolution: '480P', ratio: '1:1', audio: false },
    parameters: { duration: { min: 2, max: 2, integer: true }, resolution: { enum: ['480P'] }, ratio: { enum: ['1:1'] }, audio: { type: 'boolean' } }, references: { max: 0 },
  } },
  'wan-first-frame': { protocol: 'dashscope-video', label: 'Wan 首帧视频', capabilities: {
    operations: ['image_to_video'], defaults: { duration: 2, resolution: '720P' },
    parameters: { duration: { min: 2, max: 2, integer: true }, resolution: { enum: ['720P'] } }, references: { max: 1, required: true, roles: ['first_frame'] },
  } },
  'seedance-video': { protocol: 'ark-video', label: 'Seedance Video', capabilities: {
    operations: ['text_to_video'], defaults: { duration: 4, resolution: '480p', ratio: '1:1', audio: false },
    parameters: { duration: { min: 4, max: 4, integer: true }, resolution: { enum: ['480p'] }, ratio: { enum: ['1:1'] }, audio: { type: 'boolean' } }, references: { max: 0 },
  } },
});

const copy = value => JSON.parse(JSON.stringify(value));
const make = (id, label) => ({ ...copy(LEGACY_CAPABILITY_PRESETS[id]), label });
const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];
const video = (protocol, label, min, max, resolutions, allowedRatios) => ({ protocol, label, capabilities: {
  operations: ['text_to_video'], defaults: { duration: min, resolution: resolutions[0], ratio: '1:1', audio: false },
  parameters: { duration: { min, max, integer: true }, resolution: { enum: resolutions }, ratio: { enum: allowedRatios }, audio: { type: 'boolean' } }, references: { max: 0 },
} });
const CAPABILITY_PRESETS = {
  'openai-image': make('openai-image', 'GPT Image 2'),
  'gpt-image-2.5': make('openai-image', 'GPT Image 2.5'),
  'seedream-4.0': make('seedream-classic', 'Seedream 4.0'),
  'seedream-classic': make('seedream-classic', 'Seedream 4.5'),
  'seedream-single': make('seedream-single', 'Seedream 5.0 Pro / Flash'),
  'seedream-5-lite': make('seedream-classic', 'Seedream 5.0 Lite'),
  qwen: make('qwen', 'Qwen Image 2.0 / 2.1'),
  'qwen-3': make('qwen', 'Qwen Image 3.0'),
  'wan-2.6-image': make('z-image', 'Wan 2.6 图片'),
  'z-image': make('z-image', 'Z-Image'),
  'seedance-2.0-video': video('ark-video', 'Seedance 2.0', 4, 15, ['480p', '720p', '1080p', '4k'], ratios),
  'seedance-2.5-video': video('ark-video', 'Seedance 2.5', 4, 30, ['480p', '720p', '1080p'], ratios),
  'wan-3-video': video('dashscope-video', 'Wan 3.0', 2, 30, ['480P', '720P', '1080P'], ratios),
  'wan-2.7-video': video('dashscope-video', 'Wan 2.7 文生视频', 2, 15, ['720P', '1080P'], ['16:9', '9:16', '1:1', '4:3', '3:4']),
  'wan-2.7-first-frame': make('wan-first-frame', 'Wan 2.7 首帧视频'),
};
Object.assign(CAPABILITY_PRESETS['gpt-image-2.5'].capabilities.parameters, {
  size: { pattern: '^\\d+x\\d+$', minPixels: 655360, maxPixels: 8294400, multipleOf: 16, minRatio: 1 / 3, maxRatio: 3, maxEdge: 3840 },
  quality: { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] },
  outputFormat: { enum: ['png', 'jpeg', 'webp'] },
  background: { enum: ['auto', 'transparent', 'opaque'] },
});
CAPABILITY_PRESETS['seedream-4.0'].capabilities.parameters.size.enum = ['1K', '2K', '4K'];
CAPABILITY_PRESETS['seedream-5-lite'].capabilities.parameters.size.enum = ['2K', '3K', '4K'];
Object.assign(CAPABILITY_PRESETS['qwen-3'].capabilities.parameters, {
  size: { pattern: '^\\d+\\*\\d+$', minPixels: 262144, maxPixels: 4194304, minRatio: 1 / 8, maxRatio: 8 },
  watermark: { type: 'boolean' }, negativePrompt: {}, seed: { min: 0, max: 2147483647, integer: true },
});
CAPABILITY_PRESETS['wan-2.6-image'].capabilities.defaults = { size: '1280*1280', n: 1, promptExtend: false };
Object.assign(CAPABILITY_PRESETS['wan-2.6-image'].capabilities.parameters, {
  size: { pattern: '^\\d+\\*\\d+$', minPixels: 1638400, maxPixels: 2073600, minRatio: 1 / 4, maxRatio: 4 },
  n: { min: 1, max: 4, integer: true }, watermark: { type: 'boolean' },
});
CAPABILITY_PRESETS['wan-2.7-first-frame'].capabilities.parameters.duration = { min: 2, max: 15, integer: true };
CAPABILITY_PRESETS['wan-2.7-first-frame'].capabilities.parameters.resolution.enum = ['720P', '1080P'];
// Exact v2 snapshot used to upgrade only untouched template contracts.
const PREVIOUS_CAPABILITY_PRESETS = copy(CAPABILITY_PRESETS);

// v3: official parameter contracts. Gateway-provided contracts still take
// precedence; model names never select an execution codec branch.
const integerSeed = { min: 0, max: 2147483647, integer: true };
const imageSize = (values, minPixels, maxPixels) => ({
  enum: values, allowCustom: true, pattern: '^\\d+x\\d+$', minPixels, maxPixels, minRatio: 1 / 16, maxRatio: 16,
});
for (const id of ['openai-image', 'gpt-image-2.5']) {
  Object.assign(CAPABILITY_PRESETS[id].capabilities.parameters, {
    size: { enum: ['auto'], allowCustom: true, pattern: '^\\d+x\\d+$', minPixels: 655360, maxPixels: 8294400, multipleOf: 16, minRatio: 1 / 3, maxRatio: 3, maxEdge: 3840 },
    outputFormat: { enum: ['png', 'jpeg', 'webp'] },
    outputCompression: { min: 0, max: 100, integer: true },
    background: { enum: ['auto', 'opaque', 'transparent'] },
    moderation: { enum: ['auto', 'low'] },
  });
}
for (const [id, values, minPixels, maxPixels] of [
  ['seedream-4.0', ['1K', '2K', '4K'], 921600, 16777216],
  ['seedream-classic', ['2K', '4K'], 3686400, 16777216],
  ['seedream-5-lite', ['2K', '3K', '4K'], 3686400, 16777216],
  ['seedream-single', ['1K', '1.5K', '2K'], 921600, 4624220],
]) {
  Object.assign(CAPABILITY_PRESETS[id].capabilities.parameters, {
    size: imageSize(values, minPixels, maxPixels),
    watermark: { type: 'boolean' }, responseFormat: { enum: ['url', 'b64_json'] },
  });
}
for (const id of ['seedream-single', 'seedream-5-lite']) {
  CAPABILITY_PRESETS[id].capabilities.parameters.outputFormat = { enum: ['jpeg', 'png'] };
}
for (const id of ['seedream-4.0', 'seedream-classic', 'seedream-5-lite']) {
  CAPABILITY_PRESETS[id].capabilities.references.maxTotalWithOutputs = 15;
}
CAPABILITY_PRESETS['seedream-single'].capabilities.defaults.size = '2K';
// Pro and Flash share sizes but differ in prompt optimisation. Keep this
// template conservative; Pro receives its own declarative contract below.
CAPABILITY_PRESETS['seedream-single'].label = 'Seedream 5.0 Flash';
CAPABILITY_PRESETS['seedream-5-pro'] = copy(CAPABILITY_PRESETS['seedream-single']);
CAPABILITY_PRESETS['seedream-5-pro'].label = 'Seedream 5.0 Pro';
for (const id of ['seedream-5-pro', 'seedream-4.0']) {
  CAPABILITY_PRESETS[id].capabilities.parameters.promptOptimize = { enum: ['standard', 'fast'] };
}
CAPABILITY_PRESETS.qwen.label = 'Qwen Image 2.0';
Object.assign(CAPABILITY_PRESETS.qwen.capabilities.parameters, {
  negativePrompt: { maxLength: 500 }, watermark: { type: 'boolean' }, seed: copy(integerSeed),
});
Object.assign(CAPABILITY_PRESETS['qwen-3'].capabilities.parameters, {
  enableThinking: { type: 'boolean' }, promptExtendMode: { enum: ['direct', 'agent'] },
});
Object.assign(CAPABILITY_PRESETS['wan-2.6-image'].capabilities.parameters, {
  negativePrompt: { maxLength: 500 }, seed: copy(integerSeed),
});
CAPABILITY_PRESETS['z-image'].capabilities.parameters.seed = copy(integerSeed);
for (const id of ['seedance-2.0-video', 'seedance-2.5-video', 'wan-3-video']) {
  CAPABILITY_PRESETS[id].capabilities.parameters.duration.specialValues = [-1];
}
for (const id of ['seedance-2.0-video', 'seedance-2.5-video']) {
  CAPABILITY_PRESETS[id].capabilities.parameters.watermark = { type: 'boolean' };
}
CAPABILITY_PRESETS['seedance-2.5-video'].capabilities.parameters.outputFormat = { enum: ['mp4', 'mov'] };
for (const id of ['wan-3-video', 'wan-2.7-video', 'wan-2.7-first-frame']) {
  Object.assign(CAPABILITY_PRESETS[id].capabilities.parameters, {
    promptExtend: { type: 'boolean' }, watermark: { type: 'boolean' }, seed: copy(integerSeed),
  });
}
CAPABILITY_PRESETS['wan-3-video'].capabilities.parameters.seed.min = -1;
for (const id of ['wan-2.7-video', 'wan-2.7-first-frame']) {
  CAPABILITY_PRESETS[id].capabilities.parameters.negativePrompt = { maxLength: 500 };
}
delete CAPABILITY_PRESETS['wan-2.7-video'].capabilities.parameters.audio;
delete CAPABILITY_PRESETS['wan-2.7-video'].capabilities.defaults.audio;

const TEMPLATE_ALIASES = Object.freeze({ 'seedance-video': 'seedance-2.5-video', 'wan-video': 'wan-3-video', 'wan-first-frame': 'wan-2.7-first-frame' });
module.exports = { CAPABILITY_PRESETS: Object.freeze(CAPABILITY_PRESETS), LEGACY_CAPABILITY_PRESETS, PREVIOUS_CAPABILITY_PRESETS, TEMPLATE_ALIASES, TEMPLATE_VERSION: 3 };
