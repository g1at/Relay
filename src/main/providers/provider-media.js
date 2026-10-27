'use strict';

const crypto = require('crypto');

const MEDIA_SCHEMA_VERSION = 1;
const MEDIA_PROTOCOLS = Object.freeze({
  'openai-images': { modality: 'image', label: 'OpenAI Images', operations: ['text_to_image', 'image_to_image'] },
  'ark-images': { modality: 'image', label: 'Ark Images', operations: ['text_to_image', 'image_to_image'] },
  'dashscope-images': { modality: 'image', label: 'DashScope Images', operations: ['text_to_image', 'image_to_image'] },
  'dashscope-video': { modality: 'video', label: 'DashScope Video', operations: ['text_to_video', 'image_to_video'] },
  'ark-video': { modality: 'video', label: 'Ark Video', operations: ['text_to_video', 'image_to_video'] },
});
const CONNECTION_PRESETS = new Set(['custom', 'mify', 'openai', 'ark', 'dashscope']);
const AUTH_MODES = new Set(['bearer', 'api-key', 'none']);
const SECRET_HEADER = /authorization|cookie|api[-_]?key|token|secret/i;
const FORBIDDEN_HEADER = /^(?:host|content-length|connection|transfer-encoding|proxy-.*)$/i;
const TEXT = value => typeof value === 'string' ? value.trim() : '';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const { CAPABILITY_PRESETS, LEGACY_CAPABILITY_PRESETS, PREVIOUS_CAPABILITY_PRESETS, TEMPLATE_ALIASES, TEMPLATE_VERSION } = require('./media-capability-presets');
const { matchMediaTemplate } = require('../../../renderer/media-template-matching');

// Directory metadata is advisory data, never a source of credentials or URLs.
// Only contracts understood by the codecs can become an automatic binding.
const CATALOG_DEFINITIONS = Object.fromEntries(require('../media/media-protocols').getProtocolDefinitions().map(item => [item.id, item]));
const BOOLEAN_PARAMETERS = new Set(['audio', 'watermark', 'sequential', 'promptExtend', 'enableThinking', 'layerDecomposition']);
const INTEGER_PARAMETERS = new Set(['n', 'duration', 'seed', 'outputCompression']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const basicCapabilities = protocol => ({ operations: [MEDIA_PROTOCOLS[protocol].operations[0]], parameters: {}, defaults: {}, references: { max: 0 } });
function catalogCapabilities(source, protocol) {
  if (source === undefined) return basicCapabilities(protocol);
  if (!keysWithin(source, ['operations', 'parameters', 'defaults', 'references', 'maxTotalImages'])) return null;
  const def = CATALOG_DEFINITIONS[protocol];
  const operations = source.operations === undefined ? [def.operations[0]] : source.operations;
  if (!Array.isArray(operations) || !operations.length || operations.some(value => !def.operations.includes(value))) return null;
  const parameters = source.parameters === undefined ? {} : source.parameters;
  const defaults = source.defaults === undefined ? {} : source.defaults;
  if (!record(parameters) || !record(defaults)) return null;
  const ruleKeys = ['type', 'integer', 'required', 'enum', 'allowCustom', 'specialValues', 'maxLength', 'min', 'max', 'pattern', 'minPixels', 'maxPixels', 'minEdge', 'maxEdge', 'multipleOf', 'minRatio', 'maxRatio'];
  for (const [key, rule] of Object.entries(parameters)) {
    if (!def.parameters.includes(key)) return null;
    if (rule === false) continue;
    if (!keysWithin(rule, ruleKeys)) return null;
    const type = BOOLEAN_PARAMETERS.has(key) ? 'boolean' : INTEGER_PARAMETERS.has(key) ? 'number' : 'string';
    if (rule.type !== undefined && !(rule.type === type || (type === 'number' && rule.type === 'integer'))) return null;
    for (const flag of ['integer', 'required']) if (rule[flag] !== undefined && typeof rule[flag] !== 'boolean') return null;
    if (rule.integer === true && type !== 'number') return null;
    for (const bound of ['min', 'max', 'minPixels', 'maxPixels', 'minEdge', 'maxEdge', 'multipleOf', 'minRatio', 'maxRatio']) {
      if (rule[bound] !== undefined && !finite(rule[bound])) return null;
      if (rule[bound] !== undefined && (['min', 'max'].includes(bound) ? type !== 'number' : key !== 'size')) return null;
      if (rule[bound] !== undefined && !['min', 'max'].includes(bound) && rule[bound] <= 0) return null;
    }
    for (const [min, max] of [['min', 'max'], ['minPixels', 'maxPixels'], ['minEdge', 'maxEdge'], ['minRatio', 'maxRatio']]) {
      if (rule[min] !== undefined && rule[max] !== undefined && rule[min] > rule[max]) return null;
    }
    const valueMatches = value => typeof value === type && (type !== 'number' || Number.isInteger(value));
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 200 || !rule.enum.every(valueMatches))) return null;
    if (rule.allowCustom !== undefined && (typeof rule.allowCustom !== 'boolean' || type !== 'string' || !rule.enum || !rule.pattern)) return null;
    if (rule.specialValues !== undefined && (type !== 'number' || !Array.isArray(rule.specialValues) || !rule.specialValues.length || rule.specialValues.length > 20 || !rule.specialValues.every(valueMatches))) return null;
    if (rule.maxLength !== undefined && (type !== 'string' || !Number.isSafeInteger(rule.maxLength) || rule.maxLength < 1)) return null;
    if (rule.pattern !== undefined) {
      if (type !== 'string' || typeof rule.pattern !== 'string' || rule.pattern.length > 512) return null;
      try { new RegExp(rule.pattern); } catch (_) { return null; }
    }
    if (own(defaults, key)) {
      const value = defaults[key];
      const presetValue = rule.enum && rule.enum.includes(value);
      const specialValue = rule.specialValues && rule.specialValues.includes(value);
      if (!valueMatches(value) || (rule.enum && !presetValue && !rule.allowCustom)) return null;
      if (type === 'number' && ((!specialValue && ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))) || (key === 'n' && value < 1))) return null;
      if (rule.pattern && !(rule.allowCustom && presetValue) && !new RegExp(rule.pattern).test(value)) return null;
      if (rule.maxLength !== undefined && [...value].length > rule.maxLength) return null;
      if (key === 'size') {
        const dimensions = /^(\d+)[x*](\d+)$/.exec(value);
        if (dimensions) {
          const width = Number(dimensions[1]), height = Number(dimensions[2]), pixels = width * height;
          if (!width || !height || !Number.isSafeInteger(pixels)
            || (rule.minPixels !== undefined && pixels < rule.minPixels) || (rule.maxPixels !== undefined && pixels > rule.maxPixels)
            || (rule.minEdge !== undefined && Math.min(width, height) < rule.minEdge) || (rule.maxEdge !== undefined && Math.max(width, height) > rule.maxEdge)
            || (rule.multipleOf && (width % rule.multipleOf || height % rule.multipleOf))
            || (rule.minRatio !== undefined && width / height < rule.minRatio) || (rule.maxRatio !== undefined && width / height > rule.maxRatio)) return null;
        } else if ((rule.minPixels !== undefined || rule.maxPixels !== undefined) && !(rule.enum && rule.enum.includes(value))) return null;
      }
    }
  }
  if (Object.keys(defaults).some(key => !own(parameters, key) || parameters[key] === false)) return null;
  const references = source.references === undefined ? { max: 0 } : source.references;
  if (!keysWithin(references, ['min', 'max', 'required', 'roles', 'formats', 'dataUrl', 'maxBytes', 'defaultRole', 'maxTotalWithOutputs'])) return null;
  if (!Number.isInteger(references.max) || references.max < 0 || references.max > 200) return null;
  if (references.min !== undefined && (!Number.isInteger(references.min) || references.min < 0 || references.min > references.max)) return null;
  for (const key of ['required', 'dataUrl']) if (references[key] !== undefined && typeof references[key] !== 'boolean') return null;
  if (references.maxBytes !== undefined && (!Number.isSafeInteger(references.maxBytes) || references.maxBytes < 1)) return null;
  if (references.maxTotalWithOutputs !== undefined && (!Number.isSafeInteger(references.maxTotalWithOutputs) || references.maxTotalWithOutputs < 1)) return null;
  const roles = protocol === 'ark-video' ? ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']
    : protocol === 'dashscope-video' ? ['first_frame', 'last_frame', 'driving_audio', 'first_clip'] : [];
  if (references.roles !== undefined && (!Array.isArray(references.roles) || references.roles.some(role => !roles.includes(role)))) return null;
  if (references.defaultRole !== undefined && (!roles.includes(references.defaultRole) || (references.roles && !references.roles.includes(references.defaultRole)))) return null;
  const formatPattern = def.modality === 'image' ? /^(?:image\/)?[a-z0-9.+-]+$/i : /^(?:(?:image|video|audio)\/)?[a-z0-9.+-]+$/i;
  if (references.formats !== undefined && (!Array.isArray(references.formats) || references.formats.some(value => typeof value !== 'string' || !formatPattern.test(value)))) return null;
  if (operations.some(value => value.startsWith('image_to_')) && references.max === 0) return null;
  if ((references.required || references.min > 0) && references.max === 0) return null;
  if (source.maxTotalImages !== undefined && (!Number.isSafeInteger(source.maxTotalImages) || source.maxTotalImages < 1)) return null;
  return { operations: [...new Set(operations)], parameters: clone(parameters), defaults: clone(defaults), references: clone(references),
    ...(source.maxTotalImages === undefined ? {} : { maxTotalImages: source.maxTotalImages }) };
}
function normalizeMediaCatalogMetadata(item) {
  if (!record(item)) return {};
  const modelType = TEXT(item.model_type || item.modelType);
  const modalityFor = value => ['image', 'image_generation', 'text_to_image', 'image_to_image'].includes(TEXT(value).toLowerCase()) ? 'image'
    : ['video', 'video_generation', 'text_to_video', 'image_to_video'].includes(TEXT(value).toLowerCase()) ? 'video' : '';
  const media = record(item.media) ? item.media : {};
  const config = record(item.mediaConfig) ? item.mediaConfig : {};
  const declared = [item.model_type, item.modelType, item.modality, media.modality, config.modality].filter(value => value !== undefined && value !== '');
  let modality = declared.map(modalityFor).find(Boolean) || '';
  const declaredConfig = item.mediaTemplateBlocked === true || [item, media, config].some(value =>
    ['protocol', 'media_protocol', 'mediaProtocol', 'capabilities', 'media_capabilities', 'mediaCapabilities', 'editTransport'].some(key => own(value, key)))
    || (own(item, 'media') && !record(item.media)) || (own(item, 'mediaConfig') && !record(item.mediaConfig));
  const base = { ...(modelType || modality ? { modelType: modelType || modality, model_type: modelType || modality, modality } : {}),
    ...(declaredConfig ? { mediaTemplateBlocked: true } : {}) };
  const unknownType = { modelType: '', model_type: '', modality: '', mediaTemplateBlocked: true };
  if (new Set(declared.map(value => modalityFor(value) || TEXT(value).toLowerCase())).size > 1) return unknownType;
  if ((item.media !== undefined && !record(item.media)) || (item.mediaConfig !== undefined && !record(item.mediaConfig))) return base;
  const protocolValues = [item.media_protocol, item.mediaProtocol, item.protocol, media.protocol, config.protocol].filter(value => value !== undefined);
  if (!protocolValues.length) return base;
  if (protocolValues.some(value => typeof value !== 'string' || !own(MEDIA_PROTOCOLS, value.trim().toLowerCase()))) return base;
  const protocols = [...new Set(protocolValues.map(value => value.trim().toLowerCase()))];
  if (protocols.length !== 1) return new Set(protocols.map(value => MEDIA_PROTOCOLS[value].modality)).size > 1 ? unknownType : base;
  const protocol = protocols[0], expected = MEDIA_PROTOCOLS[protocol].modality;
  if (declared.some(value => modalityFor(value) !== expected)) return unknownType;
  const rawCaps = [item.media_capabilities, item.mediaCapabilities, item.capabilities, media.capabilities, config.capabilities].filter(value => value !== undefined);
  const candidates = (rawCaps.length ? rawCaps : [undefined]).map(value => catalogCapabilities(value, protocol));
  if (candidates.some(value => value === null) || new Set(candidates.map(canonical)).size !== 1) return base;
  const transports = [item.editTransport, media.editTransport, config.editTransport].filter(value => value !== undefined);
  if (transports.some(value => !['multipart', 'json-images', 'json-image-urls', 'legacy-json-image-url'].includes(value)) || new Set(transports).size > 1
    || (transports.length && protocol !== 'openai-images')) return base;
  modality = expected;
  return { modelType: modelType || modality, model_type: modelType || modality, modality,
    mediaConfig: { protocol, capabilities: candidates[0], ...(transports.length ? { editTransport: transports[0] } : {}) } };
}

function safeObject(value, depth = 0) {
  if (depth > 8) throw new Error('媒体配置嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => safeObject(item, depth + 1));
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (item !== undefined) result[key] = safeObject(item, depth + 1);
  }
  return result;
}

function normalizeHeaders(value) {
  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const key = TEXT(rawKey).toLowerCase();
    const val = TEXT(rawValue);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(val)) throw new Error('媒体请求头不合法');
    if (SECRET_HEADER.test(key) || FORBIDDEN_HEADER.test(key)) throw new Error('认证信息必须使用服务商密钥，不能保存到媒体请求头');
    if (rawValue === null) headers[key] = null;
    else if (val) headers[key] = val;
  }
  return headers;
}

function normalizeMediaBaseUrl(value) {
  const input = TEXT(value).replace(/\/+$/, '');
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch (_) { throw new Error('媒体网关 URL 不合法'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('媒体网关 URL 必须是无认证信息、查询参数或锚点的 HTTP(S) 地址');
  }
  return input;
}

function normalizeAuth(value = {}) {
  const mode = AUTH_MODES.has(value.mode || value.authMode) ? (value.mode || value.authMode) : 'bearer';
  const headerName = TEXT(value.headerName) || 'x-api-key';
  if (mode === 'api-key' && (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(headerName) || FORBIDDEN_HEADER.test(headerName))) {
    throw new Error('媒体认证请求头名称不合法');
  }
  return { mode, ...(mode === 'api-key' ? { headerName } : {}) };
}

function normalizeEndpoints(value) {
  const endpoints = {};
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!['generate', 'submit', 'poll', 'cancel', 'content', 'create', 'status', 'download', 'edit'].includes(key)) continue;
    const endpoint = TEXT(item);
    if (!endpoint) continue;
    if (/[\r\n]/.test(endpoint) || (!endpoint.startsWith('/') && !/^https?:\/\//i.test(endpoint)) || endpoint.startsWith('//')) {
      throw new Error('媒体操作端点必须是 HTTP(S) URL 或以 / 开头的路径');
    }
    if (/^https?:/i.test(endpoint)) {
      const parsed = new URL(endpoint);
      if (parsed.username || parsed.password || parsed.hash) throw new Error('媒体操作端点不能包含账号、密码或锚点');
    }
    endpoints[key] = endpoint;
  }
  return endpoints;
}

function normalizeMediaConnection(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const auth = normalizeAuth(source);
  return {
    preset: CONNECTION_PRESETS.has(source.preset) ? source.preset : 'custom',
    baseUrl: normalizeMediaBaseUrl(source.baseUrl),
    authMode: auth.mode,
    ...(auth.headerName ? { headerName: auth.headerName } : {}),
    headers: normalizeHeaders(source.headers),
    endpoints: normalizeEndpoints(source.endpoints),
  };
}

function normalizeMediaCapabilities(value, protocol) {
  const source = value && typeof value === 'object' ? safeObject(value) : {};
  const allowed = MEDIA_PROTOCOLS[protocol].operations;
  const operations = Array.isArray(source.operations) ? [...new Set(source.operations.filter(item => allowed.includes(item)))] : [allowed[0]];
  return { ...source, operations, defaults: safeObject(source.defaults || {}), parameters: safeObject(source.parameters || {}), references: safeObject(source.references || { max: 0 }) };
}

function normalizeMediaModels(value, { strict = false, catalog = [] } = {}) {
  const models = [];
  const seen = new Set();
  for (let source of Array.isArray(value) ? value : []) {
    try {
      source = repairLegacyMediaTemplate(source, catalog);
      const modelId = TEXT(source && source.modelId);
      const protocol = TEXT(source && source.protocol);
      if (!modelId || !MEDIA_PROTOCOLS[protocol]) throw new Error('请填写媒体模型 ID 并选择支持的协议');
      const modality = source.modality || MEDIA_PROTOCOLS[protocol].modality;
      if (modality !== MEDIA_PROTOCOLS[protocol].modality) throw new Error('媒体模型类型与协议不匹配');
      const owner = TEXT(source.ownedBy || source.owned_by);
      const identity = [modality, protocol, modelId, ...(owner ? [owner] : [])];
      const id = TEXT(source.id) || `binding-${digest(identity).slice(0, 20)}`;
      if (!/^[a-z0-9._-]{1,100}$/i.test(id) || seen.has(id)) throw new Error('媒体绑定 ID 无效或重复');
      const endpoints = normalizeEndpoints(source.endpoints);
      const routeHeaders = normalizeHeaders(source.routeHeaders);
      const item = {
        id, modelId, label: TEXT(source.label) || modelId, modality, protocol,
        enabled: source.enabled !== false, endpoints, routeHeaders,
        capabilities: normalizeMediaCapabilities(source.capabilities, protocol),
        ...(normalizeMediaSetup(source.setup) ? { setup: normalizeMediaSetup(source.setup) } : {}),
        ...(['multipart', 'json-images', 'json-image-urls', 'legacy-json-image-url'].includes(source.editTransport) ? { editTransport: source.editTransport } : {}),
        ...(source.baseUrl ? { baseUrl: normalizeMediaBaseUrl(source.baseUrl) } : {}),
        ...(source.auth ? { auth: normalizeAuth(source.auth) } : {}),
        ...(source.errorProfile === 'mify' ? { errorProfile: 'mify' } : {}),
        ...(TEXT(source.ownedBy || source.owned_by) ? { ownedBy: TEXT(source.ownedBy || source.owned_by) } : {}),
        ...(TEXT(source.legacyAdapterId) ? { legacyAdapterId: TEXT(source.legacyAdapterId) } : {}),
        ...(Array.isArray(source.aliases) ? { aliases: [...new Set(source.aliases.map(TEXT).filter(item => item && !item.includes('::media::')))] } : {}),
      };
      seen.add(id);
      models.push(item);
    } catch (error) { if (strict) throw error; }
  }
  return models;
}

function mediaRouteId(providerId, bindingId) { return `${providerId}::media::${bindingId}`; }

function migrateLegacyMediaModels(profile, imageRoutes = {}) {
  const models = [...(profile.mediaModels || [])];
  for (const legacy of profile.imageModels || []) {
    const selected = imageRoutes[legacy.adapterId];
    if (!selected || selected.providerId !== profile.id) continue;
    const alias = `${profile.id}::${legacy.adapterId}`;
    if (models.some(item => (item.aliases || []).includes(alias))) continue;
    const protocol = legacy.adapterId === 'gpt-image-2' ? 'openai-images' : 'ark-images';
    // Preserve the exact legacy routing transformation once, as explicit data.
    // It is never applied to newly added models or arbitrary gateways.
    const originalId = TEXT(selected.remoteModelId || legacy.remoteModelId);
    const owner = /^(azure_openai|volcengine_maas)\/(.+)$/i.exec(originalId);
    const capabilities = getMediaCapabilityPreset(protocol === 'openai-images' ? 'openai-image' : 'seedream-classic').capabilities;
    if (protocol === 'openai-images') {
      capabilities.defaults.quality = 'medium';
      capabilities.references.max = 1;
    }
    models.push({
      id: `legacy-${legacy.adapterId}`, modelId: owner ? owner[2] : originalId,
      label: originalId, modality: 'image', protocol, enabled: true,
      legacyAdapterId: legacy.adapterId, aliases: [...new Set([alias, originalId, owner ? owner[2] : originalId, legacy.adapterId])],
      endpoints: { generate: '/v1/images/generations', ...(protocol === 'openai-images' ? { edit: '/v1/images/edits' } : {}) },
      ...(protocol === 'openai-images' ? { editTransport: 'legacy-json-image-url' } : {}),
      routeHeaders: owner ? { 'x-model-provider-id': owner[1] } : {},
      capabilities,
    });
  }
  return normalizeMediaModels(models);
}

function getMediaCapabilityPreset(id) {
  id = TEMPLATE_ALIASES[id] || id;
  if (CAPABILITY_PRESETS[id]) return clone(CAPABILITY_PRESETS[id]);
  const protocol = typeof id === 'string' && id.startsWith('protocol-') ? id.slice(9) : '';
  return own(MEDIA_PROTOCOLS, protocol) ? { protocol, label: `${MEDIA_PROTOCOLS[protocol].label} · 基础`, capabilities: basicCapabilities(protocol) } : null;
}

function normalizeMediaSetup(value) {
  if (!record(value) || !['directory', 'family-template', 'manual-template', 'manual', 'legacy-template'].includes(value.source)) return null;
  const templateId = TEXT(value.templateId);
  return { source: value.source, ...(getMediaCapabilityPreset(templateId) ? { templateId } : {}),
    ...(Number.isInteger(value.version) && value.version > 0 ? { version: value.version } : {}) };
}

function repairLegacyMediaTemplate(source, catalog = []) {
  if (!record(source) || !record(source.capabilities)) return source;
  if (catalog.some(item => (item.modelId || item.id) === source.modelId
    && TEXT(item.ownedBy || item.owned_by) === TEXT(source.ownedBy || source.owned_by)
    && (item.mediaConfig || item.mediaTemplateBlocked))) return source;
  const match = matchMediaTemplate({ modelId: source.modelId, modality: source.modality });
  const preset = match && getMediaCapabilityPreset(match.templateId);
  if (!preset || preset.protocol !== source.protocol) return source;
  // Refresh a known v2 template only when its contract is still untouched.
  // Defaults may have been edited independently; valid user choices survive.
  if (source.setup) {
    const setup = source.setup;
    const previousId = match.templateId === 'seedream-5-pro' ? 'seedream-single' : match.templateId;
    if (setup.version !== 2 || !['family-template', 'legacy-template', 'manual-template'].includes(setup.source)
      || (TEMPLATE_ALIASES[setup.templateId] || setup.templateId) !== previousId) return source;
    const old = PREVIOUS_CAPABILITY_PRESETS[previousId];
    const contract = caps => { const value = clone(caps); delete value.defaults; return canonical(value); };
    if (!old || contract(old.capabilities) !== contract(source.capabilities)) return source;
    const capabilities = clone(preset.capabilities);
    capabilities.defaults = {};
    for (const [key, value] of Object.entries(source.capabilities.defaults || {})) {
      if (own(capabilities.parameters, key)) capabilities.defaults[key] = value;
      // Remove a mistaken old template default only if it was never changed.
      else if (canonical(value) !== canonical(old.capabilities.defaults[key])) return source;
    }
    if (!catalogCapabilities(capabilities, preset.protocol)) return source;
    return { ...source, capabilities, setup: { ...setup, templateId: match.templateId, version: TEMPLATE_VERSION } };
  }
  const candidates = Object.values(LEGACY_CAPABILITY_PRESETS).filter(item => item.protocol === source.protocol).map(item => item.capabilities);
  candidates.push(...Object.values(PREVIOUS_CAPABILITY_PRESETS).filter(item => item.protocol === source.protocol).map(item => item.capabilities));
  candidates.push(basicCapabilities(source.protocol));
  if (!candidates.some(caps => canonical(caps) === canonical(source.capabilities))) return source;
  const capabilities = clone(preset.capabilities);
  // An exact known snapshot proves these are template defaults, including an
  // obsolete unsupported field. Preserve omission as well as explicit values.
  capabilities.defaults = Object.fromEntries(Object.entries(source.capabilities.defaults || {})
    .filter(([key]) => own(capabilities.parameters, key)));
  if (!catalogCapabilities(capabilities, preset.protocol)) return source;
  return { ...source, capabilities, setup: { source: 'legacy-template', templateId: match.templateId, version: TEMPLATE_VERSION } };
}

function getMediaProtocolPresets() {
  return {
    templateVersion: TEMPLATE_VERSION,
    protocols: Object.entries(MEDIA_PROTOCOLS).map(([id, item]) => ({ id, ...clone(item) })),
    capabilities: [
      ...Object.entries(MEDIA_PROTOCOLS).map(([protocol]) => ({ id: `protocol-${protocol}`, ...getMediaCapabilityPreset(`protocol-${protocol}`) })),
      ...Object.entries(CAPABILITY_PRESETS).map(([id, item]) => ({ id, ...clone(item) })),
    ],
    connections: [...CONNECTION_PRESETS],
  };
}

function mediaRuntimeBinding(profile, binding) {
  const connection = normalizeMediaConnection(profile.mediaConnection);
  // Recognize an untouched connection inherited from this documented gateway.
  // Explicit media addresses, auth, headers and endpoints remain authoritative.
  if (connection.preset === 'custom' && !binding.baseUrl && !binding.auth && !connection.baseUrl
    && connection.authMode === 'bearer' && !Object.keys(connection.headers).length
    && !Object.keys(connection.endpoints).length) {
    try {
      const inherited = new URL(profile.baseUrl);
      if (inherited.hostname === 'api.llm.mioffice.cn'
        && /^\/(?:anthropic(?:\/v1)?|v1)?\/?$/i.test(inherited.pathname)) connection.preset = 'mify';
    } catch (_) { /* Invalid addresses are rejected by provider validation. */ }
  }
  let baseUrl = binding.baseUrl || connection.baseUrl || profile.baseUrl;
  if (connection.preset === 'mify' && !binding.baseUrl && !connection.baseUrl) {
    baseUrl = baseUrl.replace(/\/anthropic(?:\/v1)?$/i, '');
  }
  const mifyEndpoints = connection.preset === 'mify'
    ? (binding.modality === 'image' ? { generate: '/v1/images/generations' }
      : { submit: '/v1/videos/generations', poll: '/v1/videos/generations/{taskId}?model={modelId}' }) : {};
  const endpoints = { ...mifyEndpoints, ...connection.endpoints, ...binding.endpoints };
  const routeHeaders = { ...connection.headers, ...binding.routeHeaders };
  const auth = binding.auth || normalizeAuth(connection);
  const editTransport = binding.editTransport
    || (connection.preset === 'mify' && binding.protocol === 'openai-images' ? 'json-image-urls' : undefined);
  // The selected owner comes from catalog metadata, never a model-name guess.
  if (connection.preset === 'mify' && binding.ownedBy && !own(routeHeaders, 'x-model-provider-id')) routeHeaders['x-model-provider-id'] = binding.ownedBy;
  const result = {
    routeId: mediaRouteId(profile.id, binding.id), bindingId: binding.id,
    providerId: profile.id, providerName: profile.name, providerRevision: profile.revision,
    mediaRevision: profile.mediaRevision || 1, credentialRef: profile.credentialRef,
    credentialSource: 'provider', protocol: binding.protocol, modelId: binding.modelId,
    modality: binding.modality, label: binding.label, baseUrl, auth, routeHeaders, endpoints,
    capabilities: clone(binding.capabilities),
    ...(editTransport ? { editTransport } : {}),
    errorProfile: binding.errorProfile || (connection.preset === 'mify' ? 'mify' : 'generic'),
  };
  result.credentialVersion = digest([result.credentialRef, result.providerRevision, result.mediaRevision]).slice(0, 24);
  const { providerName, label, ...versioned } = result;
  result.version = digest(versioned).slice(0, 32);
  return result;
}

module.exports = {
  MEDIA_SCHEMA_VERSION, MEDIA_PROTOCOLS, mediaRouteId, normalizeMediaConnection,
  normalizeMediaModels, normalizeMediaCapabilities, normalizeMediaCatalogMetadata, normalizeHeaders,
  getMediaCapabilityPreset, getMediaProtocolPresets, migrateLegacyMediaModels, mediaRuntimeBinding,
};
