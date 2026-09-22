'use strict';

const { version: RELAY_VERSION } = require('../../../package.json');

const MODEL_ENV_KEYS = Object.freeze({
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
});

const AUTH_MODES = Object.freeze({
  API_KEY: 'api-key',
  AUTH_TOKEN: 'auth-token',
});
const AUTH_MODE_VALUES = new Set(Object.values(AUTH_MODES));
const ANTHROPIC_PROTOCOL = 'anthropic';
const MODEL_CATALOG_COMPAT_SUFFIXES = Object.freeze([
  '/api/claudecode',
  '/apps/anthropic',
  '/api/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
]);

// 图像能力只按 Relay 已适配的核心模型名识别。供应商前缀、命名空间和版本后缀
// 都属于远端路由信息，识别时忽略，但调用时必须原样保留完整模型 ID。
const ADAPTED_IMAGE_MODELS = Object.freeze([
  Object.freeze({ adapterId: 'gpt-image-2', match: 'gpt-image-2' }),
  Object.freeze({ adapterId: 'seedream-5.0', match: 'seedream-5.0' }),
  Object.freeze({ adapterId: 'seedream-4.5', match: 'seedream-4.5' }),
]);

function imageModelMatchRank(modelId, core) {
  const value = String(modelId || '').trim().toLocaleLowerCase();
  const target = String(core || '').trim().toLocaleLowerCase();
  if (!value || !target || !value.includes(target)) return Number.POSITIVE_INFINITY;
  if (value === target) return 0;
  const tail = value.split('/').pop() || value;
  if (tail === target) return 1;
  if (tail.startsWith(target)) return 2;
  return 3;
}

function detectAdaptedImageModels(models) {
  const source = Array.isArray(models) ? models : [];
  return ADAPTED_IMAGE_MODELS.map((definition) => {
    const candidates = source
      .map((remoteModelId, index) => ({
        remoteModelId: String(remoteModelId || '').trim(),
        index,
        rank: imageModelMatchRank(remoteModelId, definition.match),
      }))
      .filter((item) => item.remoteModelId && Number.isFinite(item.rank))
      .sort((left, right) => left.rank - right.rank
        || left.remoteModelId.length - right.remoteModelId.length
        || left.index - right.index);
    if (!candidates.length) return null;
    return {
      adapterId: definition.adapterId,
      remoteModelId: candidates[0].remoteModelId,
    };
  }).filter(Boolean);
}

function imageRequestRoute(remoteModelId) {
  const value = String(remoteModelId || '').trim();
  const legacy = value.match(/^(azure_openai|volcengine_maas)\/(.+)$/i);
  return legacy
    ? { requestModel: legacy[2], providerHeader: legacy[1] }
    : { requestModel: value, providerHeader: '' };
}

function providerApiUrl(baseUrl, endpoint) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('网关 URL 必须以 http:// 或 https:// 开头');
  const suffix = String(endpoint || '').startsWith('/') ? endpoint : `/${endpoint}`;
  if (/\/v1$/i.test(base) && /^\/v1(?:\/|$)/i.test(suffix)) return `${base}${suffix.slice(3)}`;
  return `${base}${suffix}`;
}

function gatewayRootApiUrl(baseUrl, endpoint) {
  const parsed = new URL(String(baseUrl || '').trim());
  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = String(segments[segments.length - 1] || '').toLocaleLowerCase();
  const previous = String(segments[segments.length - 2] || '').toLocaleLowerCase();
  let anthropicIndex = -1;
  if (last === 'anthropic') anthropicIndex = segments.length - 1;
  else if (last === 'v1' && previous === 'anthropic') anthropicIndex = segments.length - 2;
  if (anthropicIndex < 0) return '';
  const suffix = String(endpoint || '').split('?')[0].split('/').filter(Boolean);
  parsed.pathname = `/${segments.slice(0, anthropicIndex).concat(suffix).join('/')}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function providerModelCatalogRoot(baseUrl) {
  const parsed = new URL(String(baseUrl || '').trim());
  let pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  pathname = pathname.replace(/\/v\d+$/i, '') || '/';
  const lowerPath = pathname.toLocaleLowerCase();
  const suffix = MODEL_CATALOG_COMPAT_SUFFIXES.find((item) => lowerPath.endsWith(item));
  if (!suffix) return '';
  parsed.pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, '') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

// Claude Messages 的 Base URL 经常带 /anthropic、/api/coding 等协议前缀，
// 但模型目录通常仍采用 OpenAI 风格的 /v1/models，甚至位于同域根路径。
// 候选顺序保持稳定：先尊重用户填写的 Base URL，再探测兼容前缀的根目录。
function providerModelApiCandidates(baseUrl) {
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const parsedBase = new URL(normalizedBase);
  const basePath = parsedBase.pathname.replace(/\/+$/, '') || '/';
  const versionMatch = basePath.match(/\/v(\d+)$/i);

  // 与 OpenAI 兼容目录的常见约定保持一致：Base URL 已经带版本段时，
  // 模型端点应直接拼 /models，不能再得到 .../v4/v1/models。
  if (versionMatch) {
    add(`${normalizedBase}/models`);
    // 非 v1 网关仍保留历史拼法作为次级兜底，兼容少数自定义路由。
    if (versionMatch[1] !== '1') add(`${normalizedBase}/v1/models`);
  } else {
    add(providerApiUrl(normalizedBase, '/v1/models'));
  }

  const catalogRoot = providerModelCatalogRoot(normalizedBase);
  if (catalogRoot) {
    add(providerApiUrl(catalogRoot, '/v1/models'));
    add(providerApiUrl(catalogRoot, '/models'));
    return candidates;
  }

  if (!versionMatch) add(providerApiUrl(normalizedBase, '/models'));
  return candidates;
}

function providerApiCandidates(baseUrl, endpoint, { gatewayRootFallback = false } = {}) {
  if (gatewayRootFallback && /^\/v1\/models(?:\?|$)/i.test(String(endpoint || ''))) {
    return providerModelApiCandidates(baseUrl);
  }
  const candidates = [providerApiUrl(baseUrl, endpoint)];
  if (gatewayRootFallback) {
    const fallback = gatewayRootApiUrl(baseUrl, endpoint);
    if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
  }
  return candidates;
}

function runtimeModel(runtime) {
  const explicit = String(runtime && runtime.modelId || '').trim();
  if (explicit) return explicit;
  const tier = runtime && MODEL_ENV_KEYS[runtime.defaultModel] ? runtime.defaultModel : 'haiku';
  return String(runtime && runtime.env && runtime.env[MODEL_ENV_KEYS[tier]] || '').trim();
}

// Build a throwaway probe from the editor. Never mutate the stored connection,
// inherit its old model environment, or write a detected authentication mode.
function createProviderDraftRuntime(draft = {}, existing = null, { requireModel = false } = {}) {
  const input = draft && typeof draft === 'object' ? draft : {};
  const savedEnv = existing && existing.env || {};
  const baseUrl = String(Object.hasOwn(input, 'baseUrl') ? input.baseUrl : savedEnv.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先填写 Base URL 和 API Key');
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch (_) { throw new Error('网关 URL 不合法'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网关 URL 必须以 http:// 或 https:// 开头');
  if (parsed.username || parsed.password) throw new Error('网关 URL 不能包含账号或密码');
  if (parsed.search || parsed.hash) throw new Error('网关 URL 不能包含查询参数或锚点');
  const sourceModels = input.models && typeof input.models === 'object' ? input.models : existing && existing.models || {};
  const models = Object.fromEntries(Object.keys(MODEL_ENV_KEYS).map(tier => [tier, String(sourceModels[tier] || '').trim()]));
  const preferred = String(input.tier || input.defaultModel || existing && existing.defaultModel || 'haiku');
  const tier = Object.hasOwn(MODEL_ENV_KEYS, preferred) && models[preferred]
    ? preferred : Object.keys(MODEL_ENV_KEYS).find(value => models[value]) || 'haiku';
  const modelId = models[tier] || '';
  if (requireModel && !modelId) throw new Error('请先为至少一个对话档位填写模型');
  const suppliedKey = String(input.apiKey || '').trim();
  const savedKey = String(savedEnv.ANTHROPIC_API_KEY || savedEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  const rawKey = suppliedKey || savedKey;
  const credential = rawKey.replace(/^Bearer\s+/i, '').trim();
  if (!credential) throw new Error('请先填写 Base URL 和 API Key');
  const authMode = suppliedKey
    ? (/^Bearer\s+/i.test(suppliedKey) ? AUTH_MODES.AUTH_TOKEN : AUTH_MODES.API_KEY)
    : preferredAuthMode(existing);
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    [authMode === AUTH_MODES.AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: credential,
  };
  for (const [key, variable] of Object.entries(MODEL_ENV_KEYS)) if (models[key]) env[variable] = models[key];
  if (modelId) env.ANTHROPIC_MODEL = modelId;
  return { authMode, env, models, defaultModel: tier, tier, modelId };
}

function normalizeAuthMode(value, fallback = AUTH_MODES.API_KEY) {
  return AUTH_MODE_VALUES.has(value) ? value : fallback;
}

function runtimeCredential(runtime) {
  const env = runtime && runtime.env && typeof runtime.env === 'object' ? runtime.env : {};
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const raw = apiKey || authToken;
  const value = raw.replace(/^Bearer\s+/i, '').trim();
  if (!value) throw new Error('该服务商没有可用的 API Key');
  return { raw, value };
}

function preferredAuthMode(runtime) {
  if (runtime && AUTH_MODE_VALUES.has(runtime.authMode)) return runtime.authMode;
  const env = runtime && runtime.env && typeof runtime.env === 'object' ? runtime.env : {};
  return env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY
    ? AUTH_MODES.AUTH_TOKEN
    : AUTH_MODES.API_KEY;
}

function authModeCandidates(runtime) {
  const preferred = preferredAuthMode(runtime);
  const alternate = preferred === AUTH_MODES.AUTH_TOKEN ? AUTH_MODES.API_KEY : AUTH_MODES.AUTH_TOKEN;
  return [preferred, alternate];
}

function anthropicRequestHeaders(runtime, authMode, { hasBody = false } = {}) {
  const credential = runtimeCredential(runtime).value;
  const headers = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': `Relay/${RELAY_VERSION}`,
  };
  if (hasBody) headers['content-type'] = 'application/json';
  if (normalizeAuthMode(authMode) === AUTH_MODES.AUTH_TOKEN) headers.authorization = `Bearer ${credential}`;
  else headers['x-api-key'] = credential;
  return headers;
}

function sanitizedMessage(value, ...secrets) {
  let message = '';
  if (value && typeof value === 'object') {
    message = value.error && typeof value.error === 'object' ? value.error.message : '';
    message = message || value.message || value.error || '';
  } else if (typeof value === 'string') message = value;
  message = String(message || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('••••');
  return message;
}

function runtimeSecrets(runtime) {
  try {
    const credential = runtimeCredential(runtime);
    return [...new Set([credential.raw, credential.value].filter(Boolean))];
  } catch (_) {
    return [];
  }
}

function responseDetail(payload, runtime) {
  return sanitizedMessage(payload, ...runtimeSecrets(runtime));
}

function responseDiagnosticText(payload, runtime) {
  const error = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
    ? payload.error
    : {};
  return sanitizedMessage([
    responseDetail(payload, runtime),
    error.param,
    error.code,
    error.type,
    payload && payload.param,
    payload && payload.code,
    payload && payload.type,
  ].filter(Boolean).join(' '), ...runtimeSecrets(runtime));
}

function isModelAccessDenied(payload, runtime) {
  return /(model.{0,40}(not.{0,20}(available|allowed|enabled)|access|permission|scope)|模型.{0,30}(不在|无权|未授权|未开通|不可用|权限|范围))/i
    .test(responseDiagnosticText(payload, runtime));
}

function shouldRetryAuth(response, payload, runtime) {
  if (!response) return false;
  if (isModelAccessDenied(payload, runtime)) return false;
  if (response.status === 401) return true;
  if (![400, 403].includes(response.status)) return false;
  return /(auth|api[-_\s]?key|x-api-key|authorization|bearer|token|credential|unauthori[sz]ed|forbidden|认证|鉴权|密钥|令牌|凭证)/i
    .test(responseDiagnosticText(payload, runtime));
}

function shouldRetryGatewayRoot(response, payload, runtime) {
  if (!response) return false;
  if ([404, 405, 501].includes(response.status)) return true;
  if (response.status !== 400) return false;
  return /(404|not[_\s-]?found|route.{0,20}(missing|unknown|not)|endpoint.{0,20}(missing|unknown|not)|不存在|未找到)/i
    .test(responseDiagnosticText(payload, runtime));
}

function endpointPath(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return String(value || '');
  }
}

async function requestWithTimeout(fetchImpl, url, options, timeoutMs, maxBytes = 1024 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 12000));
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const payload = await readPayload(response, maxBytes);
    return { response, payload };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('连接超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readPayload(response, maxBytes = 1024 * 1024) {
  let text = '';
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('服务响应过大，已停止读取');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('服务响应过大，已停止读取');
  }
  if (!text) return null;
  try { return JSON.parse(text); }
  catch (_) { return text.slice(0, 1000); }
}

async function requestAnthropic(runtime, {
  fetchImpl,
  endpoint,
  method,
  body,
  timeoutMs,
  maxBytes,
  gatewayRootFallback = true,
} = {}) {
  runtimeCredential(runtime);
  const baseUrl = runtime && runtime.env && runtime.env.ANTHROPIC_BASE_URL;
  const urls = providerApiCandidates(baseUrl, endpoint, { gatewayRootFallback });
  const modelCatalogRequest = /^\/v1\/models(?:\?|$)/i.test(String(endpoint || ''));
  const authModes = authModeCandidates(runtime);
  const started = Date.now();
  let last = null;

  for (let urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
    const url = urls[urlIndex];
    let responseForEndpoint = null;
    let payloadForEndpoint = null;
    for (let authIndex = 0; authIndex < authModes.length; authIndex += 1) {
      const authMode = authModes[authIndex];
      try {
        const options = {
          method,
          headers: anthropicRequestHeaders(runtime, authMode, { hasBody: body !== undefined }),
        };
        if (body !== undefined) options.body = JSON.stringify(body);
        const requested = await requestWithTimeout(fetchImpl, url, options, timeoutMs, maxBytes);
        responseForEndpoint = requested.response;
        payloadForEndpoint = requested.payload;
        last = {
          response: requested.response,
          payload: requested.payload,
          authMode,
          endpoint: endpointPath(url),
          gatewayRootFallbackUsed: urlIndex > 0,
          error: null,
        };
        if (requested.response.ok) {
          return {
            ...last,
            latencyMs: Math.max(1, Date.now() - started),
          };
        }
        if (authIndex === 0 && shouldRetryAuth(requested.response, requested.payload, runtime)) continue;
        break;
      } catch (error) {
        last = {
          response: null,
          payload: null,
          authMode,
          endpoint: endpointPath(url),
          gatewayRootFallbackUsed: urlIndex > 0,
          error,
        };
        break;
      }
    }
    const canTryNextModelCandidate = modelCatalogRequest
      && responseForEndpoint
      && responseForEndpoint.status >= 400
      && responseForEndpoint.status < 500
      && ![408, 429].includes(responseForEndpoint.status);
    if (urlIndex < urls.length - 1
      && (shouldRetryGatewayRoot(responseForEndpoint, payloadForEndpoint, runtime)
        || canTryNextModelCandidate)) continue;
    break;
  }

  return {
    ...(last || {}),
    latencyMs: Math.max(1, Date.now() - started),
  };
}

async function testProviderConnection(runtime, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络检测');
  const model = runtimeModel(runtime);
  if (!model) throw new Error('请先配置默认模型映射');
  try {
    const result = await requestAnthropic(runtime, {
      fetchImpl,
      endpoint: '/v1/messages',
      method: 'POST',
      body: {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'OK' }],
      },
      timeoutMs,
      gatewayRootFallback: false,
    });
    if (!result.response || !result.response.ok) {
      const detail = result.error
        ? sanitizedMessage(result.error.message, ...runtimeSecrets(runtime))
        : responseDetail(result.payload, runtime);
      const errorKind = result.response && isModelAccessDenied(result.payload, runtime)
        ? 'model_not_allowed'
        : (result.response && [401, 403].includes(result.response.status) ? 'authentication' : 'request_failed');
      return {
        ok: false,
        protocol: ANTHROPIC_PROTOCOL,
        reachable: !!result.response,
        errorKind,
        status: result.response ? result.response.status : 0,
        latencyMs: result.latencyMs,
        model,
        endpoint: result.endpoint || '',
        message: errorKind === 'model_not_allowed'
          ? `Anthropic 网关可达，但最小探测请求被拒绝；这不代表 Relay 实际对话不可用（${model}）`
          : (detail || (result.response ? `Anthropic 服务返回 HTTP ${result.response.status}` : '连接失败')),
      };
    }
    return {
      ok: true,
      protocol: ANTHROPIC_PROTOCOL,
      authMode: result.authMode,
      status: result.response.status,
      latencyMs: result.latencyMs,
      model,
      endpoint: result.endpoint,
      gatewayRootFallbackUsed: !!result.gatewayRootFallbackUsed,
      message: 'Anthropic Messages 连接可用',
    };
  } catch (error) {
    return {
      ok: false,
      protocol: ANTHROPIC_PROTOCOL,
      status: 0,
      latencyMs: 0,
      model,
      endpoint: '',
      message: sanitizedMessage(error && error.message, ...runtimeSecrets(runtime)) || '连接失败',
    };
  }
}

function modelCatalogSource(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.models)) return payload.models;
  if (payload && payload.models && typeof payload.models === 'object') {
    return Object.entries(payload.models).map(([fallbackId, entry]) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return fallbackId;
      return { ...entry, __relayFallbackId: fallbackId };
    });
  }
  return [];
}

function modelCatalogId(item) {
  return String(typeof item === 'string'
    ? item
    : (item && (item.id || item.slug || item.name || item.model || item.__relayFallbackId)) || '').trim();
}

function modelCatalogOwner(item) {
  if (!item || typeof item !== 'object') return '';
  const owner = String(item.owned_by || item.ownedBy || item.owner || item.provider || item.vendor || item.category || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return owner && !/\s/.test(owner) ? owner : '';
}

function normalizeConfiguredModelId(value) {
  return String(value || '').trim().replace(/\[1m\]$/i, '').trim();
}

function configuredModelValues(runtime) {
  const values = [];
  const add = (value) => {
    const normalized = normalizeConfiguredModelId(value);
    if (normalized && !values.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      values.push(normalized);
    }
  };
  const models = runtime && runtime.models && typeof runtime.models === 'object' ? runtime.models : {};
  Object.values(models).forEach(add);
  const env = runtime && runtime.env && typeof runtime.env === 'object' ? runtime.env : {};
  Object.values(MODEL_ENV_KEYS).forEach((key) => add(env[key]));
  return values;
}

function ownerQualifiedModelId(id, owner) {
  const rawId = String(id || '').trim();
  const rawOwner = String(owner || '').trim().replace(/^\/+|\/+$/g, '');
  if (!rawId || !rawOwner || rawId.toLocaleLowerCase().startsWith(`${rawOwner.toLocaleLowerCase()}/`)) {
    return rawId;
  }
  return `${rawOwner}/${rawId.replace(/^\/+/, '')}`;
}

// 模型目录中的 id 是服务端原始事实，owned_by 只是元数据，不能直接覆盖 id。
// 对 Mify 这类共享目录，Relay 另行计算可调用的路由 ID：优先沿用用户当前已验证
// 的模型写法；没有既有证据时，只在同一短 ID 对应多个 owner 的目录中启用命名空间。
function normalizeModelCatalog(payload, {
  configuredModels = [],
  limit = 1000,
} = {}) {
  const source = modelCatalogSource(payload);
  const records = [];
  const seenRecords = new Set();
  for (const item of source) {
    const id = modelCatalogId(item);
    const ownedBy = modelCatalogOwner(item);
    const recordKey = `${ownedBy.toLocaleLowerCase()}\u0000${id.toLocaleLowerCase()}`;
    if (!id || seenRecords.has(recordKey)) continue;
    seenRecords.add(recordKey);
    records.push({ id, ownedBy });
  }

  const configured = [];
  for (const value of configuredModels) {
    const normalized = normalizeConfiguredModelId(value);
    const key = normalized.toLocaleLowerCase();
    if (normalized && !configured.some((item) => item.toLocaleLowerCase() === key)) configured.push(normalized);
  }
  const configuredSet = new Set(configured.map((item) => item.toLocaleLowerCase()));

  const ownersById = new Map();
  for (const record of records) {
    const idKey = record.id.toLocaleLowerCase();
    if (!ownersById.has(idKey)) ownersById.set(idKey, new Set());
    if (record.ownedBy) ownersById.get(idKey).add(record.ownedBy.toLocaleLowerCase());
  }
  const hasOwnerCollision = [...ownersById.values()].some((owners) => owners.size > 1);

  let rawMatches = 0;
  let qualifiedMatches = 0;
  const ownerEvidence = new Map();
  const noteOwnerEvidence = (owner, kind) => {
    if (!owner) return;
    const key = owner.toLocaleLowerCase();
    if (!ownerEvidence.has(key)) ownerEvidence.set(key, { raw: 0, qualified: 0 });
    ownerEvidence.get(key)[kind] += 1;
  };
  for (const record of records) {
    const rawKey = record.id.toLocaleLowerCase();
    const qualifiedId = ownerQualifiedModelId(record.id, record.ownedBy);
    const qualifiedKey = qualifiedId.toLocaleLowerCase();
    if (configuredSet.has(rawKey)) {
      rawMatches += 1;
      noteOwnerEvidence(record.ownedBy, 'raw');
    }
    if (qualifiedId !== record.id && configuredSet.has(qualifiedKey)) {
      qualifiedMatches += 1;
      noteOwnerEvidence(record.ownedBy, 'qualified');
    }
  }

  let idStrategy = 'raw';
  let strategyEvidence = 'server-id';
  if (qualifiedMatches && rawMatches) {
    idStrategy = 'mixed';
    strategyEvidence = 'configured-models';
  } else if (qualifiedMatches) {
    idStrategy = 'owner-qualified';
    strategyEvidence = 'configured-models';
  } else if (rawMatches) {
    idStrategy = 'raw';
    strategyEvidence = 'configured-models';
  } else if (hasOwnerCollision) {
    idStrategy = 'owner-qualified';
    strategyEvidence = 'owner-collision';
  }

  const catalog = [];
  const seenValues = new Set();
  const maxItems = Number.isFinite(Number(limit))
    ? Math.max(1, Number(limit) || 1000)
    : Number.POSITIVE_INFINITY;
  for (const record of records) {
    const qualifiedId = ownerQualifiedModelId(record.id, record.ownedBy);
    const evidence = ownerEvidence.get(record.ownedBy.toLocaleLowerCase());
    let useQualified = false;
    let inference = 'server-id';
    if (qualifiedId !== record.id) {
      // 同一 owner 同时出现新旧两种已保存写法时，显式命名空间是更强证据：
      // 裸 ID 可能正是旧版自动发现留下的错误值，不能让它反向覆盖已验证路由。
      if (evidence && evidence.qualified) {
        useQualified = true;
        inference = 'configured-owner';
      } else if (evidence && evidence.raw) {
        inference = 'configured-owner';
      } else if (idStrategy === 'owner-qualified' || (idStrategy === 'mixed' && hasOwnerCollision)) {
        useQualified = true;
        inference = idStrategy === 'mixed' ? 'owner-collision' : strategyEvidence;
      }
    }
    const value = useQualified ? qualifiedId : record.id;
    const valueKey = value.toLocaleLowerCase();
    if (seenValues.has(valueKey)) continue;
    seenValues.add(valueKey);
    catalog.push({
      id: record.id,
      value,
      ownedBy: record.ownedBy,
      alternateId: qualifiedId === record.id ? '' : (useQualified ? record.id : qualifiedId),
      idKind: useQualified ? 'owner-qualified' : 'raw',
      inference,
    });
    if (catalog.length >= maxItems) break;
  }

  return {
    catalog,
    idStrategy,
    strategyEvidence,
    hasOwnerCollision,
    rawCount: new Set(records.map((record) => record.id.toLocaleLowerCase())).size,
    recordCount: records.length,
  };
}

function normalizeModelList(payload, limit = 1000) {
  const normalized = normalizeModelCatalog(payload, { limit });
  const seen = new Set();
  const result = [];
  for (const item of normalized.catalog) {
    const key = item.id.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item.id);
  }
  return result;
}

async function discoverProviderModels(runtime, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持模型发现');
  try {
    const result = await requestAnthropic(runtime, {
      fetchImpl,
      endpoint: '/v1/models',
      method: 'GET',
      timeoutMs,
      maxBytes: 2 * 1024 * 1024,
    });
    if (!result.response || !result.response.ok) {
      const detail = result.error
        ? sanitizedMessage(result.error.message, ...runtimeSecrets(runtime))
        : responseDetail(result.payload, runtime);
      return {
        ok: false,
        accessVerified: false,
        protocol: ANTHROPIC_PROTOCOL,
        status: result.response ? result.response.status : 0,
        latencyMs: result.latencyMs,
        endpoint: result.endpoint || '',
        models: [],
        totalModels: 0,
        imageModels: [],
        message: detail || (result.response ? `Anthropic 模型接口返回 HTTP ${result.response.status}` : '模型发现失败'),
      };
    }
    const normalized = normalizeModelCatalog(result.payload, {
      configuredModels: configuredModelValues(runtime),
      limit: Number.POSITIVE_INFINITY,
    });
    const modelCatalog = normalized.catalog.slice(0, 1000);
    const allModels = normalized.catalog.map((item) => item.value);
    const models = allModels.slice(0, 1000);
    const imageModels = detectAdaptedImageModels(allModels);
    // A credential-protected catalog can still list every gateway model. Reading
    // it does not establish this key's permission to invoke any listed model.
    const catalogLabel = result.gatewayRootFallbackUsed ? '共享模型目录' : '模型目录';
    return allModels.length
      ? {
        ok: true,
        accessVerified: false,
        protocol: ANTHROPIC_PROTOCOL,
        authMode: result.authMode,
        status: result.response.status,
        latencyMs: result.latencyMs,
        endpoint: result.endpoint,
        gatewayRootFallbackUsed: !!result.gatewayRootFallbackUsed,
        models,
        modelCatalog,
        modelIdStrategy: normalized.idStrategy,
        modelIdStrategyEvidence: normalized.strategyEvidence,
        totalModels: normalized.recordCount,
        imageModels,
        catalogSource: result.gatewayRootFallbackUsed ? 'gateway-root' : 'anthropic',
        message: `${catalogLabel} · ${allModels.length} 个模型${imageModels.length ? ` · ${imageModels.length} 个图像候选` : ''} · Key 权限未验证`,
      }
      : {
        ok: false,
        accessVerified: false,
        protocol: ANTHROPIC_PROTOCOL,
        authMode: result.authMode,
        status: result.response.status,
        latencyMs: result.latencyMs,
        endpoint: result.endpoint,
        gatewayRootFallbackUsed: !!result.gatewayRootFallbackUsed,
        models: [],
        totalModels: 0,
        imageModels: [],
        catalogSource: result.gatewayRootFallbackUsed ? 'gateway-root' : 'anthropic',
        message: `${catalogLabel}可访问，但没有返回模型 · Key 权限未验证`,
      };
  } catch (error) {
    return {
      ok: false,
      accessVerified: false,
      protocol: ANTHROPIC_PROTOCOL,
      status: 0,
      latencyMs: 0,
      endpoint: '',
      models: [],
      totalModels: 0,
      imageModels: [],
      message: sanitizedMessage(error && error.message, ...runtimeSecrets(runtime)) || '模型发现失败',
    };
  }
}

module.exports = {
  ADAPTED_IMAGE_MODELS,
  AUTH_MODES,
  providerApiUrl,
  providerApiCandidates,
  providerModelApiCandidates,
  runtimeModel,
  createProviderDraftRuntime,
  anthropicRequestHeaders,
  normalizeModelCatalog,
  normalizeModelList,
  detectAdaptedImageModels,
  imageRequestRoute,
  testProviderConnection,
  discoverProviderModels,
};
