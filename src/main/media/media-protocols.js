'use strict';

// Protocol codecs are pure: they neither read credentials nor perform requests.
// An endpoint override never changes the codec or implies model capabilities.
const DEFINITIONS = {
  'openai-images': {
    id: 'openai-images', modality: 'image', asynchronous: false,
    operations: ['text_to_image', 'image_to_image'],
    endpoints: { generate: '/v1/images/generations', edit: '/v1/images/edits' },
    parameters: ['n', 'size', 'quality', 'outputFormat', 'outputCompression', 'responseFormat', 'background', 'moderation'],
  },
  'ark-images': {
    id: 'ark-images', modality: 'image', asynchronous: false,
    operations: ['text_to_image', 'image_to_image'],
    endpoints: { generate: '/api/v3/images/generations' },
    parameters: ['n', 'size', 'watermark', 'sequential', 'outputFormat', 'responseFormat', 'seed', 'layerDecomposition', 'promptOptimize'],
  },
  'dashscope-images': {
    id: 'dashscope-images', modality: 'image', asynchronous: false,
    operations: ['text_to_image', 'image_to_image'],
    endpoints: { generate: '/api/v1/services/aigc/multimodal-generation/generation' },
    parameters: ['n', 'size', 'watermark', 'promptExtend', 'negativePrompt', 'seed', 'enableThinking', 'promptExtendMode'],
  },
  'dashscope-video': {
    id: 'dashscope-video', modality: 'video', asynchronous: true,
    operations: ['text_to_video', 'image_to_video'],
    endpoints: { submit: '/api/v1/services/aigc/video-generation/video-synthesis', poll: '/api/v1/tasks/{taskId}' },
    submitHeaders: { 'x-dashscope-async': 'enable' },
    parameters: ['duration', 'resolution', 'ratio', 'audio', 'watermark', 'promptExtend', 'negativePrompt', 'seed'],
  },
  'ark-video': {
    id: 'ark-video', modality: 'video', asynchronous: true,
    operations: ['text_to_video', 'image_to_video'],
    endpoints: { submit: '/api/v3/contents/generations/tasks', poll: '/api/v3/contents/generations/tasks/{taskId}' },
    parameters: ['duration', 'resolution', 'ratio', 'audio', 'watermark', 'seed', 'outputFormat'],
  },
};
const TYPES = {
  n: 'integer', size: 'string', quality: 'string', outputFormat: 'string', responseFormat: 'string',
  background: 'string', seed: 'integer', duration: 'integer', resolution: 'string', ratio: 'string',
  audio: 'boolean', watermark: 'boolean', sequential: 'boolean', promptExtend: 'boolean',
  negativePrompt: 'string', enableThinking: 'boolean', layerDecomposition: 'boolean',
  outputCompression: 'integer', promptOptimize: 'string', promptExtendMode: 'string', moderation: 'string',
};
const FIELD_NAMES = {
  outputFormat: 'output_format', responseFormat: 'response_format', promptExtend: 'prompt_extend',
  negativePrompt: 'negative_prompt', enableThinking: 'enable_thinking', layerDecomposition: 'layer_decomposition',
  outputCompression: 'output_compression', promptExtendMode: 'prompt_extend_mode',
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));

class MediaValidationError extends Error {
  constructor(errors) {
    super(errors.map(item => item.message).join('；'));
    this.name = 'MediaValidationError';
    this.code = 'MEDIA_INPUT_INVALID';
    this.errors = errors;
  }
}

function definition(binding) {
  const protocol = binding && binding.protocol;
  const result = own(DEFINITIONS, protocol) ? DEFINITIONS[protocol] : null;
  if (!result) throw new MediaValidationError([{ field: 'protocol', code: 'unsupported_protocol', message: '媒体协议不受支持' }]);
  return result;
}

function getProtocolDefinitions() { return copy(Object.values(DEFINITIONS)); }

function endpointUrl(binding, endpoint, handle = {}) {
  let base;
  try { base = new URL(binding.baseUrl); } catch (_) { throw new Error('媒体网关 URL 无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('媒体网关 URL 必须是无凭据和查询参数的 HTTP(S) 地址');
  }
  const taskId = handle.taskId;
  const modelId = handle.modelId || binding.modelId;
  let path = String(endpoint || '').replace(/\{(taskId|id|modelId)\}/g, (_, key) => {
    const value = key === 'modelId' ? modelId : taskId;
    if (typeof value !== 'string' || !value) throw new Error('任务路由参数缺失');
    return encodeURIComponent(value);
  });
  if (!path || /[{}\r\n]/.test(path) || path.startsWith('//')) throw new Error('媒体操作端点无效');
  let result;
  if (/^https?:\/\//i.test(path)) {
    result = new URL(path);
    if (result.origin !== base.origin) throw new Error('媒体操作端点必须与网关同源');
  } else {
    // Preserve a user-supplied proxy prefix, without duplicating /v1 or /api/v3.
    const split = path.indexOf('?');
    const query = split < 0 ? '' : path.slice(split);
    const suffix = (split < 0 ? path : path.slice(0, split)).split('/').filter(Boolean);
    const prefix = base.pathname.split('/').filter(Boolean);
    let overlap = Math.min(prefix.length, suffix.length);
    while (overlap && prefix.slice(-overlap).join('/') !== suffix.slice(0, overlap).join('/')) overlap -= 1;
    result = new URL(base.origin + '/' + prefix.concat(suffix.slice(overlap)).join('/') + query);
  }
  if (result.username || result.password || result.hash) throw new Error('媒体操作端点不能包含凭据或锚点');
  return result.toString();
}

function requestHeaders(binding, def, submit = false, multipart = false) {
  const headers = { accept: 'application/json', ...(submit ? def.submitHeaders : {}) };
  if (submit && !multipart) headers['content-type'] = 'application/json';
  for (const [rawName, value] of Object.entries(binding.routeHeaders || {})) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_\x60|~-]+$/.test(name) || /^(authorization|proxy-authorization|cookie|host|content-length|connection|transfer-encoding|x-api-key|api-key)$/.test(name)
      || name === String(binding.auth && binding.auth.headerName || '').toLowerCase()) {
      throw new Error('媒体路由请求头无效；凭据由执行器注入');
    }
    if (value === null) { delete headers[name]; continue; }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('媒体路由请求头值无效');
    headers[name] = value;
  }
  if (multipart) delete headers['content-type'];
  return headers;
}

function normalizeReferences(input, errors) {
  const keys = ['references', 'image', 'refs'].filter(key => own(input, key));
  if (keys.length > 1) errors.push({ field: 'references', code: 'ambiguous_references', message: '参考素材只能使用一个输入字段' });
  const source = keys.length ? input[keys[0]] : [];
  const list = Array.isArray(source) ? source : [source];
  return list.map((item, index) => {
    const ref = typeof item === 'string' ? { url: item } : record(item) ? { ...item } : {};
    const field = 'references.' + index;
    if (Object.keys(ref).some(key => !['url', 'role', 'mime'].includes(key))) errors.push({ field, code: 'unknown_reference_field', message: '参考素材包含未支持的字段' });
    if (typeof ref.url !== 'string' || !ref.url.trim()) {
      errors.push({ field, code: 'invalid_reference', message: '参考素材地址不能为空' });
      return ref;
    }
    ref.url = ref.url.trim();
    if (/^data:/i.test(ref.url)) {
      if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(ref.url)) errors.push({ field, code: 'invalid_data_url', message: '参考图片必须使用有效的 Base64 data URL' });
      if (!ref.mime) ref.mime = ref.url.slice(5, ref.url.indexOf(';')).toLowerCase();
    } else {
      try {
        const parsed = new URL(ref.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      } catch (_) { errors.push({ field, code: 'invalid_reference_url', message: '参考素材必须为 HTTP(S) 或图片 data URL' }); }
    }
    if (ref.role !== undefined && (typeof ref.role !== 'string' || !ref.role)) errors.push({ field, code: 'invalid_role', message: '参考素材角色无效' });
    if (ref.mime !== undefined && (typeof ref.mime !== 'string' || !/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(ref.mime))) errors.push({ field, code: 'invalid_mime', message: '参考素材 MIME 无效' });
    return ref;
  });
}

function validateInput(binding, input = {}) {
  const errors = [];
  const fail = (field, code, message) => errors.push({ field, code, message });
  let def;
  try { def = definition(binding); } catch (error) { return { ok: false, errors: error.errors, normalizedInput: {} }; }
  if (!record(input)) return { ok: false, errors: [{ field: 'input', code: 'invalid_input', message: '媒体输入必须是对象' }], normalizedInput: {} };
  if (typeof binding.modelId !== 'string' || !binding.modelId.trim()) fail('modelId', 'missing_model', '请填写模型 ID');
  const caps = binding.capabilities || {};
  const params = caps.parameters || {};
  const normalizedInput = { ...(caps.defaults || {}), ...input };
  delete normalizedInput.image;
  delete normalizedInput.refs;
  normalizedInput.references = normalizeReferences(input, errors);
  normalizedInput.prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const refs = normalizedInput.references;
  normalizedInput.operation = typeof input.operation === 'string' ? input.operation : (refs.length ? 'image_to_' : 'text_to_') + def.modality;
  if (input.operation !== undefined && typeof input.operation !== 'string') fail('operation', 'invalid_type', '生成方式必须是文本');
  const operation = normalizedInput.operation;
  const operations = Array.isArray(caps.operations) ? caps.operations : [def.operations[0]];
  if (!def.operations.includes(operation) || !operations.includes(operation)) fail('operation', 'unsupported_operation', '该绑定未声明支持此生成方式');
  if ((operation.startsWith('text_to_') || def.modality === 'image' || caps.promptRequired) && !normalizedInput.prompt) fail('prompt', 'prompt_required', '请输入提示词');
  if (input.prompt !== undefined && typeof input.prompt !== 'string') fail('prompt', 'invalid_type', '提示词必须是文本');
  if (operation.startsWith('text_to_') && refs.length) fail('references', 'unexpected_references', '文生模式不能携带参考素材');
  if (operation.startsWith('image_to_') && !refs.length) fail('references', 'references_required', '此生成方式需要参考图片');
  const refCaps = caps.references || {};
  const max = Number.isInteger(refCaps.max) ? refCaps.max : 0;
  if (refs.length > max) fail('references', 'reference_limit', '参考素材数量超过已配置上限 ' + max);
  if (refCaps.required && !refs.length) fail('references', 'references_required', '此模型需要参考素材');
  if (Number.isInteger(refCaps.min) && operation.startsWith('image_to_') && refs.length < refCaps.min) fail('references', 'reference_minimum', '参考素材数量不足');
  for (const ref of refs) {
    if (def.modality === 'video' && !ref.role && (refs.length === 1 || refCaps.defaultRole)) ref.role = refCaps.defaultRole || 'first_frame';
    if (ref.role && Array.isArray(refCaps.roles) && !refCaps.roles.includes(ref.role)) fail('references', 'unsupported_role', '参考素材角色未在能力配置中声明');
    if (ref.mime && Array.isArray(refCaps.formats) && !refCaps.formats.includes(ref.mime) && !refCaps.formats.includes(ref.mime.split('/')[1])) fail('references', 'unsupported_format', '参考素材格式不受支持');
    if (refCaps.dataUrl === false && /^data:/i.test(ref.url || '')) fail('references', 'unsupported_data_url', '此绑定不支持 data URL 参考图');
    if (ref.role && def.modality === 'image') fail('references', 'unsupported_role', '图片生成参考图不接受视频角色');
    if (def.modality === 'video' && ref.role) {
      const allowedRoles = def.id === 'ark-video' ? ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'] : ['first_frame', 'last_frame', 'driving_audio', 'first_clip'];
      if (!allowedRoles.includes(ref.role)) fail('references', 'unsupported_role', '当前视频协议不支持此素材角色');
    }
    if (refCaps.maxBytes && /^data:/i.test(ref.url || '')) {
      const encoded = ref.url.slice(ref.url.indexOf(',') + 1).replace(/\s/g, '');
      const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
      if (bytes > refCaps.maxBytes) fail('references', 'reference_size_limit', '参考图片超过已配置大小上限');
    }
  }
  if (def.modality === 'video' && refs.length > 1 && refs.some(ref => !ref.role) && !refCaps.defaultRole) fail('references', 'role_required', '多张视频参考素材需要明确角色');
  if (def.id === 'openai-images' && operation === 'image_to_image') {
    const transport = caps.editTransport || binding.editTransport || 'multipart';
    if (!['multipart', 'json-images', 'json-image-urls', 'legacy-json-image-url'].includes(transport)) fail('references', 'unsupported_edit_transport', '图片编辑传输协议不受支持');
    if (transport === 'legacy-json-image-url' && refs.length > 1) fail('references', 'legacy_single_reference', '旧版图片编辑协议只支持一张参考图');
  }
  const canonical = new Set(['operation', 'prompt', 'references']);
  for (const [key, rule] of Object.entries(params)) if (rule && rule.required && !own(normalizedInput, key)) fail(key, 'parameter_required', '缺少参数 ' + key);
  for (const [key, value] of Object.entries(normalizedInput)) {
    if (canonical.has(key)) continue;
    if (!def.parameters.includes(key) || !own(params, key) || params[key] === false) { fail(key, 'unsupported_parameter', '该绑定未声明支持参数 ' + key); continue; }
    const rule = record(params[key]) ? params[key] : {};
    const type = TYPES[key] || (rule.integer ? 'integer' : rule.type);
    if ((type === 'integer' && !Number.isInteger(value)) || (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) || (['string', 'boolean'].includes(type) && typeof value !== type)) {
      fail(key, 'invalid_type', '参数 ' + key + ' 类型无效'); continue;
    }
    const presetValue = Array.isArray(rule.enum) && rule.enum.includes(value);
    const specialValue = Array.isArray(rule.specialValues) && rule.specialValues.includes(value);
    if (Array.isArray(rule.enum) && !presetValue && !rule.allowCustom) fail(key, 'invalid_enum', '参数 ' + key + ' 不在允许范围内');
    if (typeof value === 'number' && !specialValue && ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))) fail(key, 'out_of_range', '参数 ' + key + ' 超出允许范围');
    if (typeof value === 'string' && rule.pattern && !(rule.allowCustom && presetValue)) {
      try { if (!new RegExp(rule.pattern).test(value)) fail(key, 'invalid_pattern', '参数 ' + key + ' 格式无效'); }
      catch (_) { fail(key, 'invalid_capability', '参数校验配置无效'); }
    }
    if (key === 'n' && value < 1) fail(key, 'out_of_range', '生成数量必须大于零');
    if (typeof value === 'string' && rule.maxLength !== undefined && [...value].length > rule.maxLength) fail(key, 'text_too_long', (key === 'negativePrompt' ? '负面提示词' : key) + '最多 ' + rule.maxLength + ' 个字符');
    if (key === 'size' && typeof value === 'string') {
      const dimensions = /^(\d+)[x*](\d+)$/.exec(value);
      if (dimensions) {
        const width = Number(dimensions[1]); const height = Number(dimensions[2]); const pixels = width * height;
        if (!width || !height || !Number.isSafeInteger(pixels) || (rule.minPixels !== undefined && pixels < rule.minPixels) || (rule.maxPixels !== undefined && pixels > rule.maxPixels)
          || (rule.minEdge !== undefined && Math.min(width, height) < rule.minEdge) || (rule.maxEdge !== undefined && Math.max(width, height) > rule.maxEdge)
          || (rule.multipleOf && (width % rule.multipleOf || height % rule.multipleOf))
          || (rule.minRatio !== undefined && width / height < rule.minRatio) || (rule.maxRatio !== undefined && width / height > rule.maxRatio)) fail(key, 'invalid_dimensions', '图片尺寸不符合已配置范围');
      } else if ((rule.minPixels !== undefined || rule.maxPixels !== undefined) && !(Array.isArray(rule.enum) && rule.enum.includes(value))) fail(key, 'invalid_dimensions', '图片尺寸必须为宽×高');
    }
  }
  const totalMax = refCaps.maxTotalWithOutputs || caps.maxTotalImages;
  if (totalMax && refs.length + (normalizedInput.n || 1) > totalMax) fail('n', 'combined_image_limit', '参考图与输出图总数超过上限');
  if (def.id === 'ark-images' && normalizedInput.n > 1 && normalizedInput.sequential !== true) fail('n', 'group_mode_required', '生成多张图片需要显式启用组图');
  if (def.id === 'openai-images') {
    if (own(normalizedInput, 'outputCompression') && !['jpeg', 'webp'].includes(normalizedInput.outputFormat)) fail('outputCompression', 'format_required', '压缩仅支持 JPEG 或 WebP，请先选择输出格式');
    if (normalizedInput.background === 'transparent' && normalizedInput.outputFormat === 'jpeg') fail('background', 'incompatible_format', '透明背景需要 PNG 或 WebP 格式');
  }
  if (def.id === 'dashscope-images') {
    if ((normalizedInput.enableThinking === true || own(normalizedInput, 'promptExtendMode')) && normalizedInput.promptExtend !== true) fail('promptExtend', 'prompt_extend_required', '思考和扩写方式需要先开启提示词扩写');
    if (normalizedInput.promptExtendMode === 'agent' && operation !== 'text_to_image') fail('promptExtendMode', 'unsupported_operation', '智能体扩写仅支持文生图');
  }
  return { ok: errors.length === 0, errors, normalizedInput };
}

function mappedParameters(input, omit = []) {
  const result = {};
  for (const key of Object.keys(TYPES)) if (own(input, key) && !omit.includes(key)) result[FIELD_NAMES[key] || key] = input[key];
  return result;
}

function encodeSubmit(binding, input) {
  const checked = validateInput(binding, input);
  if (!checked.ok) throw new MediaValidationError(checked.errors);
  const value = checked.normalizedInput;
  const def = definition(binding);
  const caps = binding.capabilities || {};
  const refs = value.references;
  const editing = value.operation === 'image_to_image';
  let endpoint = def.asynchronous ? 'submit' : 'generate';
  let body;
  let bodyEncoding = 'json';
  if (def.id === 'openai-images') {
    body = { model: binding.modelId, prompt: value.prompt, ...mappedParameters(value) };
    if (editing) {
      endpoint = 'edit';
      const transport = caps.editTransport || binding.editTransport || 'multipart';
      if (transport === 'legacy-json-image-url') body.image_url = refs[0].url;
      else if (transport === 'json-images') body.images = refs.map(ref => ({ image_url: ref.url }));
      else if (transport === 'json-image-urls') body.image_urls = refs.map(ref => ref.url);
      else {
        bodyEncoding = 'multipart';
        body = { fields: body, files: refs.map(ref => ({ field: 'image[]', source: ref.url, ...(ref.mime ? { mime: ref.mime } : {}) })) };
      }
    }
  } else if (def.id === 'ark-images') {
    body = { model: binding.modelId, prompt: value.prompt, ...mappedParameters(value, ['n', 'sequential', 'promptOptimize']) };
    if (refs.length) body.image = refs.length === 1 ? refs[0].url : refs.map(ref => ref.url);
    if (own(value, 'sequential')) body.sequential_image_generation = value.sequential ? 'auto' : 'disabled';
    if (value.sequential) body.sequential_image_generation_options = { max_images: value.n || 1 };
    if (own(value, 'promptOptimize')) body.optimize_prompt_options = { mode: value.promptOptimize };
  } else if (def.id === 'dashscope-images') {
    const parameters = mappedParameters(value, ['negativePrompt']);
    if (typeof parameters.size === 'string') parameters.size = parameters.size.replace(/^(\d+)x(\d+)$/, '$1*$2');
    body = { model: binding.modelId, input: { messages: [{ role: 'user', content: refs.map(ref => ({ image: ref.url })).concat({ text: value.prompt }) }] }, parameters };
    if (own(value, 'negativePrompt')) body.parameters.negative_prompt = value.negativePrompt;
  } else if (def.id === 'dashscope-video') {
    body = { model: binding.modelId, input: {}, parameters: mappedParameters(value, ['negativePrompt']) };
    if (value.prompt) body.input.prompt = value.prompt;
    if (own(value, 'negativePrompt')) body.input.negative_prompt = value.negativePrompt;
    if (refs.length) body.input.media = refs.map(ref => ({ type: ref.role || (caps.references || {}).defaultRole || 'first_frame', url: ref.url }));
  } else {
    const content = value.prompt ? [{ type: 'text', text: value.prompt }] : [];
    for (const ref of refs) {
      const role = ref.role || (caps.references || {}).defaultRole || 'first_frame';
      const type = role === 'reference_video' ? 'video_url' : role === 'reference_audio' ? 'audio_url' : 'image_url';
      content.push({ type, [type]: { url: ref.url }, role });
    }
    body = { model: binding.modelId, content, ...mappedParameters(value, ['audio']) };
    if (own(value, 'audio')) body.generate_audio = value.audio;
  }
  const path = (binding.endpoints || {})[endpoint] || def.endpoints[endpoint];
  return { method: 'POST', url: endpointUrl(binding, path), headers: requestHeaders(binding, def, true, bodyEncoding === 'multipart'), bodyEncoding, body };
}

function encodePoll(binding, handle) {
  const def = definition(binding);
  if (!def.asynchronous) throw new Error('此协议没有异步查询接口');
  if (!handle || typeof handle.taskId !== 'string' || !handle.taskId || typeof handle.modelId !== 'string' || !handle.modelId) throw new Error('异步任务缺少原请求模型或任务 ID');
  return { method: 'GET', url: endpointUrl(binding, (binding.endpoints || {}).poll || def.endpoints.poll, handle), headers: requestHeaders(binding, def), body: undefined };
}

function responseBody(body) {
  if (record(body)) return body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try { const parsed = JSON.parse(String(body)); return record(parsed) ? parsed : null; } catch (_) { return null; }
  }
  return null;
}

function cleanMessage(value) {
  return String(value || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]').slice(0, 800);
}

function diagnosticToken(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text) && cleanMessage(text) === text ? text : undefined;
}

function responseRequestId(body, headers) {
  const candidates = [body && body.request_id];
  if (headers && typeof headers.get === 'function') candidates.push(headers.get('x-request-id'));
  else for (const [name, value] of Object.entries(headers || {})) if (name.toLowerCase() === 'x-request-id') candidates.push(value);
  return candidates.map(diagnosticToken).find(Boolean);
}

function classifyError(binding, status, body, fallback = '媒体请求失败') {
  const source = record(body && body.error) ? body.error : record(body && body.output) && (body.output.code || body.output.message) ? body.output : body || {};
  let nested = null;
  const param = typeof source.param === 'string' ? source.param.trim() : '';
  let jsonParam = false;
  if (param) {
    try { const parsed = JSON.parse(param); jsonParam = true; if (record(parsed)) nested = parsed; } catch (_) { /* Plain field explanation. */ }
  }
  const detail = !jsonParam && !/^[\[{]/.test(param) ? cleanMessage(param).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500) : '';
  const rawCode = String(nested && nested.code || source.code || source.type || '');
  let message = cleanMessage(nested && nested.message || source.message || detail || fallback);
  if (detail && message !== detail && /^(?:invalid[ _]request(?: error)?|bad[ _]request|param(?:eter)?[ _]incorrect|invalid[ _]parameters?|parameter[ _]error)[.!。]?$/i.test(message.trim())) {
    message = cleanMessage(`${message}：${detail}`);
  }
  let code = 'provider_error'; let category = 'provider';
  if (binding.errorProfile === 'mify' && /未指定供应商/.test(message)) { code = 'provider_required'; category = 'routing'; }
  else if (binding.errorProfile === 'mify' && /不在.*(?:可用模型|模型可用).*范围|模型.*(?:无权限|没有权限)/.test(message)) { code = 'model_permission_denied'; category = 'permission'; }
  else if (/invalid_api_key|authentication_error|incorrect_api_key|invalidaccesskeyid/i.test(rawCode) || /invalid api key|incorrect api key|API\s*Key.*(?:无效|错误|失效)/i.test(message)) { code = 'invalid_credentials'; category = 'authentication'; }
  else if (status === 401) { code = 'unauthorized'; category = 'authentication'; }
  else if (status === 403) { code = 'permission_denied'; category = 'permission'; }
  else if (status === 429) { code = 'rate_limited'; category = 'rate_limit'; }
  else if (/invalidparameter|invalid_request|validation|badrequest/i.test(rawCode) || status === 422 || status === 400) { code = 'invalid_request'; category = 'validation'; }
  else if (status === 404) { code = 'endpoint_not_found'; category = 'routing'; }
  const providerCode = diagnosticToken(rawCode);
  return { code, category, message, status, ...(providerCode ? { providerCode } : {}), retryable: status === 429 || status >= 500, submissionUncertain: !status || status >= 500 };
}

function mimeFor(format) {
  if (!format) return undefined;
  if (String(format).includes('/')) return String(format);
  const known = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };
  return known[String(format).toLowerCase()];
}

function extractOutputs(def, body) {
  const output = [];
  const add = (kind, value, mime) => { if (typeof value === 'string' && value) output.push({ kind, value, ...(mime ? { mime } : {}) }); };
  if (def.id === 'dashscope-images') {
    for (const choice of body.output && Array.isArray(body.output.choices) ? body.output.choices : []) {
      for (const part of choice && choice.message && Array.isArray(choice.message.content) ? choice.message.content : []) {
        if (part && typeof part.image === 'string') add('url', part.image, mimeFor(part.mime_type, 'image'));
      }
    }
  } else if (def.modality === 'image') {
    for (const item of Array.isArray(body.data) ? body.data : []) {
      if (!item) continue;
      const mime = mimeFor(item.mime_type || item.output_format || body.output_format, 'image');
      if (item.b64_json) add('base64', item.b64_json, mime);
      else if (item.url) add('url', item.url, mime);
    }
  } else {
    const value = def.id === 'ark-video' ? body.content : body.output;
    if (value) add('url', value.video_url, mimeFor(value.mime_type || body.output_format, 'video'));
  }
  return output;
}

function normalizeState(raw) {
  const states = { pending: 'queued', queued: 'queued', running: 'running', in_progress: 'running', processing: 'running', succeeded: 'succeeded', success: 'succeeded', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', expired: 'expired', unknown: 'unknown' };
  return states[String(raw || '').toLowerCase()] || 'unknown';
}

function responseMetadata(body, headers) {
  const metadata = {};
  if (typeof body.model === 'string') metadata.resolvedModelId = body.model;
  if (record(body.usage)) metadata.usage = copy(body.usage);
  const requestId = responseRequestId(body, headers);
  if (requestId) metadata.requestId = requestId;
  return metadata;
}

function protocolError(message, uncertain = false, status = 200) {
  return { code: 'unexpected_response', category: 'protocol', message, status, retryable: false, submissionUncertain: uncertain };
}

function parseSubmit(binding, response = {}) {
  const def = definition(binding);
  const status = Number(response.status) || 0;
  const body = responseBody(response.body);
  const requestId = responseRequestId(body, response.headers);
  const diagnostics = requestId ? { requestId } : {};
  const withContext = error => ({ ...error, ...diagnostics });
  if (!status || status >= 500 || status === 408 || status === 499) return { kind: 'submission_unknown', state: 'unknown', outputs: [], ...diagnostics, error: withContext({ ...classifyError(binding, status, body, '提交结果未确认，请勿自动重复提交'), retryable: false, submissionUncertain: true }) };
  const hasTask = body && def.asynchronous && (def.id === 'ark-video' ? body.id : body.output && body.output.task_id);
  if (status < 200 || status >= 300 || body && !hasTask && (body.error || body.code && !body.output)) return { kind: 'rejected', state: 'failed', outputs: [], ...diagnostics, error: withContext(classifyError(binding, status, body)) };
  if (!body) return { kind: 'submission_unknown', state: 'unknown', outputs: [], ...diagnostics, error: withContext(protocolError('提交回执不是有效 JSON，远端结果未确认', true, status)) };
  const outputs = extractOutputs(def, body);
  const metadata = responseMetadata(body, response.headers);
  if (!def.asynchronous) {
    if (outputs.length) return { kind: 'completed', state: 'succeeded', outputs, ...metadata };
    return { kind: 'submission_unknown', state: 'unknown', outputs: [], error: withContext(protocolError('响应缺少可识别图片，远端结果未确认', true, status)), ...metadata };
  }
  const remote = def.id === 'ark-video' ? body : body.output || {};
  const taskId = def.id === 'ark-video' ? remote.id : remote.task_id;
  const state = normalizeState(def.id === 'ark-video' ? remote.status : remote.task_status);
  if (typeof taskId !== 'string' || !taskId) return { kind: 'submission_unknown', state: 'unknown', outputs: [], error: withContext(protocolError('提交回执缺少任务 ID，不能安全重试', true, status)), ...metadata };
  const handle = { taskId, modelId: binding.modelId };
  const result = { kind: state === 'succeeded' && outputs.length ? 'completed' : 'accepted', state, outputs, handle, ...metadata };
  if (state === 'failed') result.error = withContext(classifyError(binding, status, body, '远端任务失败'));
  return result;
}

function parsePoll(binding, response = {}) {
  const def = definition(binding);
  if (!def.asynchronous) throw new Error('此协议没有异步查询接口');
  const status = Number(response.status) || 0;
  const body = responseBody(response.body);
  const requestId = responseRequestId(body, response.headers);
  const diagnostics = requestId ? { requestId } : {};
  const withContext = error => ({ ...error, ...diagnostics });
  if (status < 200 || status >= 300) return { state: 'unknown', outputs: [], ...diagnostics, error: withContext({ ...classifyError(binding, status, body, '任务查询失败'), submissionUncertain: false }) };
  if (!body) return { state: 'unknown', outputs: [], ...diagnostics, error: withContext(protocolError('任务查询未返回有效 JSON', false, status)) };
  const remote = def.id === 'ark-video' ? body : body.output || {};
  const rawState = def.id === 'ark-video' ? remote.status : remote.task_status;
  const state = normalizeState(rawState);
  const outputs = extractOutputs(def, body);
  const result = { state, outputs, ...responseMetadata(body, response.headers) };
  if (state === 'failed') result.error = withContext(classifyError(binding, status, body, '远端任务失败'));
  else if (state === 'unknown') result.error = withContext(protocolError('任务状态缺失或尚未支持', false, status));
  else if (state === 'succeeded' && !outputs.length) result.error = withContext(protocolError('远端任务已成功，但尚无可下载输出', false, status));
  return result;
}

module.exports = { encodeSubmit, encodePoll, parseSubmit, parsePoll, validateInput, getProtocolDefinitions, MediaValidationError };
