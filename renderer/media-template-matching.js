(function (root) {
  'use strict';

  // Model-family suggestions select data templates; execution remains protocol based.
  // Keep versions and accepted variants explicit so a future name cannot silently
  // inherit an older model's limits or a different operation's capabilities.
  const FAMILIES = [
    { pattern: /^(?:doubao-seedance-2\.5|dreamina-seedance-2-5-260628)$/i, templateId: 'seedance-2.5-video', family: 'seedance', label: 'Seedance 2.5', modality: 'video' },
    { pattern: /^doubao-seedance-2-0-260128$/i, templateId: 'seedance-2.0-video', family: 'seedance', label: 'Seedance 2.0', modality: 'video' },
    { pattern: /^gpt-image-2$/i, templateId: 'openai-image', family: 'gpt-image', label: 'GPT Image 2', modality: 'image' },
    { pattern: /^gpt-image-2\.5(?:-(?:sunburst|flare))?$/i, templateId: 'gpt-image-2.5', family: 'gpt-image', label: 'GPT Image 2.5', modality: 'image' },
    { pattern: /^wan3\.0(?:-(?:video|t2v))?$/i, templateId: 'wan-3-video', family: 'wan', label: 'Wan 3.0', modality: 'video' },
    { pattern: /^wan2\.7(?:-(?:video|t2v))?$/i, templateId: 'wan-2.7-video', family: 'wan', label: 'Wan 2.7', modality: 'video' },
    { pattern: /^wan2\.7-i2v$/i, templateId: 'wan-2.7-first-frame', family: 'wan', label: 'Wan 2.7 首帧视频', modality: 'video' },
    { pattern: /^wan2\.6-t2i$/i, templateId: 'wan-2.6-image', family: 'wan', label: 'Wan 2.6 图像', modality: 'image' },
    { pattern: /^doubao-seedream-4\.0(?:-20260415)?$/i, templateId: 'seedream-4.0', family: 'seedream', label: 'Seedream 4.0', modality: 'image' },
    { pattern: /^doubao-seedream-4\.5$/i, templateId: 'seedream-classic', family: 'seedream', label: 'Seedream 4.5', modality: 'image' },
    { pattern: /^doubao-seedream-5\.0-flash$/i, templateId: 'seedream-single', family: 'seedream', label: 'Seedream 5.0 Flash', modality: 'image' },
    { pattern: /^doubao-seedream-5\.0-pro$/i, templateId: 'seedream-5-pro', family: 'seedream', label: 'Seedream 5.0 Pro', modality: 'image' },
    { pattern: /^doubao-seedream-5\.0-lite$/i, templateId: 'seedream-5-lite', family: 'seedream', label: 'Seedream 5.0 Lite', modality: 'image' },
    { pattern: /^qwen-image-2\.0(?:-pro)?(?:-2026-06-22)?$/i, templateId: 'qwen', family: 'qwen-image', label: 'Qwen Image 2.0', modality: 'image' },
    { pattern: /^qwen-image-3\.0(?:-pro)?$/i, templateId: 'qwen-3', family: 'qwen-image', label: 'Qwen Image 3.0', modality: 'image' },
    { pattern: /^z-image-turbo$/i, templateId: 'z-image', family: 'z-image', label: 'Z-Image Turbo', modality: 'image' },
  ];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const declarations = ['protocol', 'media_protocol', 'mediaProtocol', 'capabilities', 'media_capabilities', 'mediaCapabilities', 'editTransport'];
  const modalityOf = value => {
    if (typeof value !== 'string') return '';
    const type = value.trim().toLowerCase();
    if (['image', 'image_generation', 'text_to_image', 'image_to_image'].includes(type)) return 'image';
    if (['video', 'video_generation', 'text_to_video', 'image_to_video'].includes(type)) return 'video';
    return '';
  };

  function matchMediaTemplate(item) {
    if (!record(item)) return null;
    if (item.mediaTemplateBlocked === true) return null;
    // Presence matters: even null/empty/invalid declarations belong to the
    // metadata validator and must not be hidden by a successful name match.
    const sources = [item];
    for (const key of ['media', 'mediaConfig']) {
      if (!own(item, key)) continue;
      if (!record(item[key])) return null;
      sources.push(item[key]);
    }
    if (sources.some(source => declarations.some(key => own(source, key)))) return null;

    const id = item.rawId || item.modelId || item.id;
    if (typeof id !== 'string') return null;
    const segments = id.trim().split('/');
    if (!segments.every(segment => /^[a-z0-9][a-z0-9._-]*$/i.test(segment))) return null;
    const family = FAMILIES.find(candidate => candidate.pattern.test(segments.at(-1)));
    if (!family) return null;

    const types = sources.flatMap(source => ['model_type', 'modelType', 'modality']
      .filter(key => own(source, key) && source[key] !== '' && source[key] !== undefined)
      .map(key => source[key]));
    if (types.some(type => modalityOf(type) !== family.modality)) return null;
    return { templateId: family.templateId, family: family.family, label: family.label, source: 'family-template' };
  }

  const api = { matchMediaTemplate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayMediaTemplateMatching = api;
})(typeof window === 'object' ? window : globalThis);
