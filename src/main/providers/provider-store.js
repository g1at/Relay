'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROVIDER_SCHEMA_VERSION = 5;
const SECRET_SCHEMA_VERSION = 1;
// Relay 不预设任何服务商。空值只用于“尚未配置”的设置视图，真实配置必须由用户填写。
const DEFAULT_BASE_URL = '';
const DEFAULT_MODELS = Object.freeze({
  opus: '',
  sonnet: '',
  haiku: '',
});
const MODEL_TIER_IDS = Object.freeze(['haiku', 'sonnet', 'opus']);
const MODEL_TIERS = new Set(MODEL_TIER_IDS);
const AUTH_MODES = new Set(['api-key', 'auth-token']);
const IMAGE_ADAPTER_ID_LIST = Object.freeze(['gpt-image-2', 'seedream-5.0', 'seedream-4.5']);
const IMAGE_ADAPTER_IDS = new Set(IMAGE_ADAPTER_ID_LIST);
const IMAGE_DISCOVERY_STATUSES = new Set(['unknown', 'ready', 'none', 'error']);

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function cleanBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  return cleanText(value, fallback).replace(/\/+$/, '');
}

function normalizeAuthMode(value) {
  return AUTH_MODES.has(value) ? value : 'api-key';
}

function validatedBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  const normalized = cleanBaseUrl(value, fallback);
  if (!normalized) throw new Error('请先填写网关 URL');
  let parsed;
  try { parsed = new URL(normalized); }
  catch (_) { throw new Error('网关 URL 不合法'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网关 URL 必须以 http:// 或 https:// 开头');
  if (parsed.username || parsed.password) throw new Error('网关 URL 不能包含账号或密码');
  if (parsed.search || parsed.hash) throw new Error('网关 URL 不能包含查询参数或锚点');
  return normalized;
}

function validatedModels(value) {
  const models = value && typeof value === 'object' ? value : {};
  const normalized = {
    opus: cleanText(models.opus),
    sonnet: cleanText(models.sonnet),
    haiku: cleanText(models.haiku),
  };
  return normalized;
}

function hasAnyChatModel(profileOrModels) {
  const models = profileOrModels && profileOrModels.models
    ? profileOrModels.models
    : profileOrModels;
  return !!(models && MODEL_TIER_IDS.some((tier) => cleanText(models[tier])));
}

function normalizeImageModels(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const adapterId = cleanText(item && item.adapterId).toLocaleLowerCase();
    const remoteModelId = cleanText(item && item.remoteModelId);
    if (!IMAGE_ADAPTER_IDS.has(adapterId) || !remoteModelId || seen.has(adapterId)) continue;
    seen.add(adapterId);
    result.push({ adapterId, remoteModelId });
  }
  return result;
}

function normalizeImageDiscovery(value) {
  const input = value && typeof value === 'object' ? value : {};
  const status = IMAGE_DISCOVERY_STATUSES.has(input.status) ? input.status : 'unknown';
  return {
    status,
    checkedAt: cleanText(input.checkedAt) || null,
    message: cleanText(input.message).slice(0, 240),
    modelCount: Math.max(0, Number(input.modelCount) || 0),
  };
}

function imageRouteId(providerId, adapterId) {
  return `${providerId}::${adapterId}`;
}

function chatRouteId(providerId, tier) {
  return `${providerId}::${tier}`;
}

function safeJsonRead(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch (_) {}
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function credentialHint(secret) {
  const value = cleanText(secret);
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

class SecretVault {
  constructor({ file, safeStorage, logger = console } = {}) {
    if (!file) throw new Error('SecretVault 缺少存储路径');
    this.file = file;
    this.safeStorage = safeStorage;
    this.logger = logger;
  }

  encryptionAvailable() {
    try {
      return !!(this.safeStorage
        && typeof this.safeStorage.isEncryptionAvailable === 'function'
        && this.safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  readState() {
    const fallback = `${this.file}.bak`;
    const parsed = fs.existsSync(this.file) ? safeJsonRead(this.file) : null;
    const recovered = parsed || (fs.existsSync(fallback) ? safeJsonRead(fallback) : null);
    const records = recovered && recovered.records && typeof recovered.records === 'object'
      ? recovered.records
      : {};
    return { schemaVersion: SECRET_SCHEMA_VERSION, records: { ...records } };
  }

  writeState(state) {
    atomicWriteJson(this.file, {
      schemaVersion: SECRET_SCHEMA_VERSION,
      records: state && state.records && typeof state.records === 'object' ? state.records : {},
    });
  }

  set(name, secret) {
    const key = cleanText(name);
    if (!/^[a-z0-9._:-]{1,180}$/i.test(key)) throw new Error('密钥引用不合法');
    const value = typeof secret === 'string' ? secret.trim() : '';
    if (!value) return this.delete(key);
    if (!this.encryptionAvailable()) {
      throw new Error('系统安全存储不可用，Relay 拒绝以明文保存 API Key');
    }
    const encrypted = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('API Key 加密失败');
    const state = this.readState();
    state.records[key] = {
      scheme: 'electron-safe-storage',
      value: encrypted.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    this.writeState(state);
    return true;
  }

  get(name) {
    const key = cleanText(name);
    if (!key || !this.encryptionAvailable()) return '';
    const record = this.readState().records[key];
    if (!record || record.scheme !== 'electron-safe-storage' || !record.value) return '';
    try {
      return cleanText(this.safeStorage.decryptString(Buffer.from(record.value, 'base64')));
    } catch (error) {
      try { this.logger.warn('[provider] 密钥解密失败 ref=%s: %s', key, error.message); } catch (_) {}
      return '';
    }
  }

  has(name) {
    const key = cleanText(name);
    if (!key) return false;
    const record = this.readState().records[key];
    return !!(record && record.value);
  }

  delete(name) {
    const key = cleanText(name);
    if (!key) return false;
    const state = this.readState();
    if (!Object.prototype.hasOwnProperty.call(state.records, key)) return false;
    delete state.records[key];
    this.writeState(state);
    return true;
  }
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanText(raw.id);
  if (!id) return null;
  const models = raw.models && typeof raw.models === 'object' ? raw.models : {};
  return {
    id,
    name: cleanText(raw.name, 'Relay 默认服务'),
    protocol: 'anthropic',
    authMode: normalizeAuthMode(raw.authMode),
    baseUrl: cleanBaseUrl(raw.baseUrl),
    credentialRef: cleanText(raw.credentialRef),
    models: {
      opus: cleanText(models.opus, DEFAULT_MODELS.opus),
      sonnet: cleanText(models.sonnet, DEFAULT_MODELS.sonnet),
      haiku: cleanText(models.haiku, DEFAULT_MODELS.haiku),
    },
    imageModels: normalizeImageModels(raw.imageModels),
    imageDiscovery: normalizeImageDiscovery(raw.imageDiscovery),
    // 旧字段仅供旧版迁移和连接探测兼容；新对话统一使用 state.defaultModel。
    defaultModel: MODEL_TIERS.has(raw.defaultModel) ? raw.defaultModel : 'haiku',
    enabled: raw.enabled !== false,
    revision: Math.max(1, Number(raw.revision) || 1),
    createdAt: cleanText(raw.createdAt, new Date().toISOString()),
    updatedAt: cleanText(raw.updatedAt, new Date().toISOString()),
    importedFrom: raw.importedFrom === 'claude-user-settings' ? raw.importedFrom : undefined,
  };
}

function normalizedChatRoutes(rawRoutes, profiles, legacyActiveProviderId = null) {
  const source = rawRoutes && typeof rawRoutes === 'object' ? rawRoutes : {};
  const routes = {};
  for (const tier of MODEL_TIER_IDS) {
    const raw = source[tier] && typeof source[tier] === 'object' ? source[tier] : {};
    const providerId = cleanText(raw.providerId);
    const profile = profiles.find((item) => item.id === providerId);
    const modelId = cleanText(raw.modelId, profile && profile.models[tier]);
    if (profile && modelId) routes[tier] = { providerId: profile.id, modelId };
  }

  // v3 只有一个 activeProviderId。升级时先完整迁移当前服务商，再由其它服务商补齐空档位。
  if (!Object.keys(routes).length) {
    const preferred = profiles.find((item) => item.id === legacyActiveProviderId) || null;
    const candidates = preferred
      ? [preferred, ...profiles.filter((item) => item.id !== preferred.id)]
      : profiles;
    for (const tier of MODEL_TIER_IDS) {
      const profile = candidates.find((item) => cleanText(item.models[tier]));
      if (profile) routes[tier] = { providerId: profile.id, modelId: profile.models[tier] };
    }
  }
  return routes;
}

function normalizedImageRoutes(rawRoutes, profiles, legacyActiveProviderId = null, migrateLegacy = false) {
  const source = rawRoutes && typeof rawRoutes === 'object' ? rawRoutes : {};
  const routes = {};
  for (const adapterId of IMAGE_ADAPTER_ID_LIST) {
    const raw = source[adapterId] && typeof source[adapterId] === 'object' ? source[adapterId] : {};
    const providerId = cleanText(raw.providerId);
    const profile = profiles.find((item) => item.id === providerId);
    const detected = profile && profile.imageModels.find((item) => item.adapterId === adapterId);
    const remoteModelId = cleanText(raw.remoteModelId, detected && detected.remoteModelId);
    if (profile && detected && remoteModelId) routes[adapterId] = { providerId: profile.id, remoteModelId };
  }

  // Only v3 needs capability-to-route migration. In newer configurations an
  // empty map is an explicit lack of assignment, including after discovery.
  if (migrateLegacy && !Object.keys(routes).length) {
    const preferred = profiles.find((item) => item.id === legacyActiveProviderId) || null;
    const candidates = preferred
      ? [preferred, ...profiles.filter((item) => item.id !== preferred.id)]
      : profiles;
    for (const adapterId of IMAGE_ADAPTER_ID_LIST) {
      for (const profile of candidates) {
        const detected = profile.imageModels.find((item) => item.adapterId === adapterId);
        if (!detected) continue;
        routes[adapterId] = { providerId: profile.id, remoteModelId: detected.remoteModelId };
        break;
      }
    }
  }
  return routes;
}

function firstConfiguredTier(chatRoutes, preferred = 'haiku') {
  if (MODEL_TIERS.has(preferred) && chatRoutes[preferred]) return preferred;
  return MODEL_TIER_IDS.find((tier) => chatRoutes[tier]) || 'haiku';
}

function publicProfile(profile, vault, state = null) {
  if (!profile) return null;
  const secret = profile.credentialRef ? vault.get(profile.credentialRef) : '';
  const chatReady = !!(profile.enabled && profile.baseUrl && secret && hasAnyChatModel(profile));
  const imageReady = !!(profile.enabled && profile.baseUrl && secret && profile.imageModels.length);
  const activeTiers = state ? MODEL_TIER_IDS.filter((tier) => state.chatRoutes
    && state.chatRoutes[tier] && state.chatRoutes[tier].providerId === profile.id) : [];
  const activeImageAdapters = state ? IMAGE_ADAPTER_ID_LIST.filter((adapterId) => state.imageRoutes
    && state.imageRoutes[adapterId] && state.imageRoutes[adapterId].providerId === profile.id) : [];
  const defaultRoute = state && state.chatRoutes && state.chatRoutes[state.defaultModel];
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    authMode: profile.authMode,
    baseUrl: profile.baseUrl,
    models: { ...profile.models },
    imageModels: profile.imageModels.map((item) => ({ ...item })),
    imageDiscovery: { ...profile.imageDiscovery },
    defaultModel: profile.defaultModel,
    enabled: profile.enabled,
    revision: profile.revision,
    hasCredential: !!secret,
    credentialHint: credentialHint(secret),
    chatReady,
    chatModelCount: MODEL_TIER_IDS.filter((tier) => cleanText(profile.models[tier])).length,
    imageReady,
    activeTiers,
    activeImageAdapters,
    routed: !!(activeTiers.length || activeImageAdapters.length),
    active: !!(defaultRoute && defaultRoute.providerId === profile.id),
    importedFrom: profile.importedFrom || null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

class ProviderStore {
  constructor({ userDataDir, safeStorage, logger = console, now, randomId } = {}) {
    if (!userDataDir) throw new Error('ProviderStore 缺少 userDataDir');
    this.file = path.join(userDataDir, 'provider-profiles.json');
    this.logger = logger;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.randomId = typeof randomId === 'function' ? randomId : () => crypto.randomUUID();
    this.vault = new SecretVault({
      file: path.join(userDataDir, 'relay-secrets.json'),
      safeStorage,
      logger,
    });
  }

  paths() {
    return { profiles: this.file, secrets: this.vault.file };
  }

  defaultState() {
    return {
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      defaultModel: 'haiku',
      activeProviderId: null,
      chatRoutes: {},
      imageRoutes: {},
      profiles: [],
      migration: {
        legacyClaudeSettings: { completed: false, imported: false, at: null },
      },
    };
  }

  readState() {
    const fallback = `${this.file}.bak`;
    const parsed = fs.existsSync(this.file) ? safeJsonRead(this.file) : null;
    const recovered = parsed || (fs.existsSync(fallback) ? safeJsonRead(fallback) : null);
    const state = recovered || this.defaultState();
    const profiles = (Array.isArray(state.profiles) ? state.profiles : []).map(normalizeProfile).filter(Boolean);
    // v5 开始由 Relay 独占 SDK 的服务商配置。旧 session 只记录了预期路由，实际
    // 可能被外部 Claude 设置覆盖；提升一次运行版本，让既有续接保护重建这些 session。
    // 不改配置时间、路由或密钥，也不重写历史；ensureInitialized 原子落盘后才使用新版本。
    if ((Number(state.schemaVersion) || 0) < 5) {
      for (const profile of profiles) profile.revision += 1;
    }
    const chatRoutes = normalizedChatRoutes(state.chatRoutes, profiles, state.activeProviderId);
    const imageRoutes = normalizedImageRoutes(
      state.imageRoutes, profiles, state.activeProviderId, (Number(state.schemaVersion) || 0) < 4,
    );
    const preferredDefault = MODEL_TIERS.has(state.defaultModel)
      ? state.defaultModel
      : ((profiles.find((item) => item.id === state.activeProviderId) || {}).defaultModel || 'haiku');
    const defaultModel = this.defaultTierForState({ chatRoutes, profiles }, preferredDefault);
    const activeProviderId = chatRoutes[defaultModel] ? chatRoutes[defaultModel].providerId : null;
    const normalized = {
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      defaultModel,
      activeProviderId,
      chatRoutes,
      imageRoutes,
      profiles,
      migration: {
        legacyClaudeSettings: {
          completed: !!(state.migration && state.migration.legacyClaudeSettings && state.migration.legacyClaudeSettings.completed),
          imported: !!(state.migration && state.migration.legacyClaudeSettings && state.migration.legacyClaudeSettings.imported),
          at: state.migration && state.migration.legacyClaudeSettings
            ? state.migration.legacyClaudeSettings.at || null
            : null,
        },
      },
    };
    Object.defineProperty(normalized, '_needsWrite', {
      value: Number(state.schemaVersion) !== PROVIDER_SCHEMA_VERSION
        || !state.chatRoutes || !state.imageRoutes || !state.defaultModel
        || state.defaultModel !== defaultModel || state.activeProviderId !== activeProviderId,
      enumerable: false,
    });
    return normalized;
  }

  writeState(state) {
    atomicWriteJson(this.file, state);
  }

  ensureInitialized() {
    const state = this.readState();
    const marker = state.migration.legacyClaudeSettings;
    if (!marker.completed) {
      // 旧版本曾从 ~/.claude/settings.json 自动导入认证信息。现在明确退休该迁移：
      // 首次安装保持空白，也不会读取、复制或推断其他 AI 应用的配置。
      state.migration.legacyClaudeSettings = {
        completed: true,
        imported: false,
        at: this.now().toISOString(),
      };
    }
    if (!marker.completed || state._needsWrite) this.writeState(state);
    return state;
  }

  activeProfile(state = this.ensureInitialized()) {
    const route = state.chatRoutes[state.defaultModel];
    return route ? state.profiles.find((profile) => profile.id === route.providerId) || null : null;
  }

  hasUsableProvider() {
    const state = this.ensureInitialized();
    return MODEL_TIER_IDS.some((tier) => !!this.chatRuntimeFromState(state, tier));
  }

  getSettingsView() {
    const state = this.ensureInitialized();
    const profile = this.activeProfile(state);
    const view = publicProfile(profile, this.vault, state);
    const models = Object.fromEntries(MODEL_TIER_IDS.map((tier) => [tier,
      state.chatRoutes[tier] ? state.chatRoutes[tier].modelId : '']));
    const routing = this.getRoutingView(state);
    return {
      ...(view || {
        id: null,
        name: '尚未配置',
        protocol: 'anthropic',
        authMode: 'api-key',
        baseUrl: DEFAULT_BASE_URL,
        enabled: true,
        revision: 0,
        hasCredential: false,
        credentialHint: '',
        chatReady: false,
        chatModelCount: 0,
        imageReady: false,
        activeTiers: [],
        activeImageAdapters: [],
        routed: false,
        active: false,
        importedFrom: null,
      }),
      models,
      imageModels: routing.imageRoutes.map((route) => ({
        adapterId: route.adapterId,
        remoteModelId: route.remoteModelId,
      })),
      imageDiscovery: view ? view.imageDiscovery : normalizeImageDiscovery(),
      defaultModel: state.defaultModel,
      routes: routing,
    };
  }

  getRoutingView(providedState = null) {
    const state = providedState || this.ensureInitialized();
    const chatRoutes = MODEL_TIER_IDS.map((tier) => {
      const route = state.chatRoutes[tier];
      if (!route) return { tier, configured: false, providerId: null, providerName: '', modelId: '' };
      const profile = state.profiles.find((item) => item.id === route.providerId);
      const available = !!this.runtimeForProfile(profile, tier, route.modelId);
      return {
        tier,
        configured: true,
        available,
        providerId: route.providerId,
        providerName: profile ? profile.name : '',
        providerRevision: profile ? profile.revision : 0,
        modelId: route.modelId,
      };
    });
    const imageRoutes = IMAGE_ADAPTER_ID_LIST.map((adapterId) => {
      const route = state.imageRoutes[adapterId];
      if (!route) return null;
      const profile = state.profiles.find((item) => item.id === route.providerId);
      const available = !!this.connectionRuntimeForProfile(profile);
      return {
        adapterId,
        configured: true,
        available,
        routeId: imageRouteId(route.providerId, adapterId),
        providerId: route.providerId,
        providerName: profile ? profile.name : '',
        providerRevision: profile ? profile.revision : 0,
        remoteModelId: route.remoteModelId,
      };
    }).filter(Boolean);
    return { defaultModel: state.defaultModel, chatRoutes, imageRoutes };
  }

  listProfiles() {
    const state = this.ensureInitialized();
    return state.profiles.map((profile) => ({
      ...publicProfile(profile, this.vault, state),
    }));
  }

  getProfile(id) {
    const key = cleanText(id);
    if (!key) return null;
    const state = this.ensureInitialized();
    const profile = state.profiles.find((item) => item.id === key);
    return profile ? publicProfile(profile, this.vault, state) : null;
  }

  getActiveRuntime(tier = '') {
    const state = this.ensureInitialized();
    return this.chatRuntimeFromState(state, MODEL_TIERS.has(tier) ? tier : state.defaultModel);
  }

  getRuntime(id, tier = '') {
    const key = cleanText(id);
    if (!key) return null;
    const state = this.ensureInitialized();
    return this.runtimeForProfile(state.profiles.find((profile) => profile.id === key), tier);
  }

  getChatRuntime(tier) {
    const normalizedTier = MODEL_TIERS.has(tier) ? tier : '';
    if (!normalizedTier) return null;
    return this.chatRuntimeFromState(this.ensureInitialized(), normalizedTier);
  }

  chatRuntimeFromState(state, tier) {
    const route = state && state.chatRoutes && state.chatRoutes[tier];
    if (!route) return null;
    const profile = state.profiles.find((item) => item.id === route.providerId);
    return this.runtimeForProfile(profile, tier, route.modelId);
  }

  getConnectionRuntime(id) {
    const key = cleanText(id);
    if (!key) return null;
    const state = this.ensureInitialized();
    return this.connectionRuntimeForProfile(
      state.profiles.find((profile) => profile.id === key),
      { allowDisabled: true },
    );
  }

  connectionRuntimeForProfile(profile, { allowDisabled = false } = {}) {
    if (!profile || (!allowDisabled && !profile.enabled) || !profile.credentialRef || !profile.baseUrl) return null;
    const credential = this.vault.get(profile.credentialRef);
    if (!credential) return null;
    const runtimeCredential = credential.replace(/^Bearer\s+/i, '').trim();
    if (!runtimeCredential) return null;
    const authMode = normalizeAuthMode(profile.authMode);
    return {
      id: profile.id,
      revision: profile.revision,
      name: profile.name,
      protocol: profile.protocol,
      authMode,
      defaultModel: profile.defaultModel,
      // 模型目录探测只用这些值判断网关既有的模型 ID 写法；不包含任何密钥。
      models: { ...profile.models },
      env: {
        ...(authMode === 'auth-token'
          ? { ANTHROPIC_AUTH_TOKEN: runtimeCredential }
          : { ANTHROPIC_API_KEY: runtimeCredential }),
        ANTHROPIC_BASE_URL: profile.baseUrl,
      },
    };
  }

  runtimeForProfile(profile, tier = '', explicitModelId = '') {
    const connection = this.connectionRuntimeForProfile(profile);
    if (!connection) return null;
    const selectedTier = MODEL_TIERS.has(tier) && cleanText(explicitModelId, profile.models[tier])
      ? tier
      : firstConfiguredTier(Object.fromEntries(MODEL_TIER_IDS
        .filter((item) => cleanText(profile.models[item]))
        .map((item) => [item, { providerId: profile.id, modelId: profile.models[item] }])), profile.defaultModel);
    const modelId = cleanText(explicitModelId, profile.models[selectedTier]);
    if (!modelId) return null;
    const env = {
      ...connection.env,
      // 一条 SDK Query 只能携带一个服务商连接。缺失档位全部回落到本路由模型，
      // 防止 Claude Code 内部子任务因别名未映射而意外访问其它默认上游。
      ANTHROPIC_MODEL: modelId,
      ANTHROPIC_DEFAULT_OPUS_MODEL: profile.models.opus || modelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: profile.models.sonnet || modelId,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.models.haiku || modelId,
    };
    return {
      ...connection,
      tier: selectedTier,
      modelId,
      routeId: chatRouteId(profile.id, selectedTier),
      routeRevision: `${profile.id}:${profile.revision}:${selectedTier}:${modelId}`,
      defaultModel: selectedTier,
      env,
    };
  }

  listImageRoutes() {
    const state = this.ensureInitialized();
    const routes = [];
    for (const adapterId of IMAGE_ADAPTER_ID_LIST) {
      const selected = state.imageRoutes[adapterId];
      if (!selected) continue;
      const profile = state.profiles.find((item) => item.id === selected.providerId);
      if (!this.connectionRuntimeForProfile(profile)) continue;
      const model = profile.imageModels.find((item) => item.adapterId === adapterId);
      if (!model) continue;
      routes.push({
        routeId: imageRouteId(profile.id, adapterId),
        providerId: profile.id,
        providerName: profile.name,
        providerRevision: profile.revision,
        activeProvider: state.chatRoutes[state.defaultModel]
          && profile.id === state.chatRoutes[state.defaultModel].providerId,
        adapterId,
        remoteModelId: selected.remoteModelId || model.remoteModelId,
      });
    }
    return routes;
  }

  getImageRuntime(selection = '') {
    const routes = this.listImageRoutes();
    if (!routes.length) return null;
    const requested = cleanText(selection);
    let route = routes.find((item) => item.routeId === requested)
      || routes.find((item) => item.remoteModelId === requested);
    if (!route && requested) {
      const lowered = requested.toLocaleLowerCase();
      route = routes.find((item) => lowered.includes(item.adapterId));
    }
    if (requested && !route) return null;
    route = route || routes[0];
    const connection = this.getConnectionRuntime(route.providerId);
    if (!connection) return null;
    return {
      ...route,
      baseUrl: connection.env.ANTHROPIC_BASE_URL,
      apiKey: connection.env.ANTHROPIC_API_KEY || connection.env.ANTHROPIC_AUTH_TOKEN,
      authMode: connection.authMode,
    };
  }

  uniqueName(state, preferred, excludedId = '') {
    const base = cleanText(preferred, '自定义服务');
    const used = new Set(state.profiles
      .filter((item) => item.id !== excludedId)
      .map((item) => item.name.toLocaleLowerCase()));
    if (!used.has(base.toLocaleLowerCase())) return base;
    let index = 2;
    while (used.has(`${base} ${index}`.toLocaleLowerCase())) index += 1;
    return `${base} ${index}`;
  }

  normalizeRouteTierSelection(value) {
    if (Array.isArray(value)) return new Set(value.filter((tier) => MODEL_TIERS.has(tier)));
    if (value && typeof value === 'object') {
      return new Set(MODEL_TIER_IDS.filter((tier) => value[tier] === true));
    }
    return null;
  }

  normalizeImageRouteSelection(value) {
    if (Array.isArray(value)) return new Set(value.filter((adapterId) => IMAGE_ADAPTER_IDS.has(adapterId)));
    if (value && typeof value === 'object') {
      return new Set(IMAGE_ADAPTER_ID_LIST.filter((adapterId) => value[adapterId] === true));
    }
    return null;
  }

  defaultTierForState(state, preferred = state.defaultModel) {
    const candidates = [preferred, ...MODEL_TIER_IDS.filter(tier => tier !== preferred)];
    return candidates.find(tier => MODEL_TIERS.has(tier) && this.chatRuntimeFromState(state, tier))
      || firstConfiguredTier(state.chatRoutes, preferred);
  }

  refreshRouteDefaults(state, preferred = state.defaultModel) {
    state.defaultModel = this.defaultTierForState(state, preferred);
    state.activeProviderId = state.chatRoutes[state.defaultModel]
      ? state.chatRoutes[state.defaultModel].providerId
      : null;
  }

  applyChatRoutesForProfile(state, profile, selectionValue, { claimUnassigned = true } = {}) {
    const selection = this.normalizeRouteTierSelection(selectionValue);
    let changed = false;
    for (const tier of MODEL_TIER_IDS) {
      const modelId = cleanText(profile.models[tier]);
      const current = state.chatRoutes[tier] || null;
      if (selection) {
        if (selection.has(tier) && modelId) {
          const next = { providerId: profile.id, modelId };
          if (JSON.stringify(current) !== JSON.stringify(next)) {
            state.chatRoutes[tier] = next;
            changed = true;
          }
        } else if (current && current.providerId === profile.id) {
          delete state.chatRoutes[tier];
          changed = true;
        }
        continue;
      }

      if (current && current.providerId === profile.id) {
        if (modelId) {
          if (current.modelId !== modelId) {
            state.chatRoutes[tier] = { providerId: profile.id, modelId };
            changed = true;
          }
        } else {
          delete state.chatRoutes[tier];
          changed = true;
        }
      } else if (!current && modelId && claimUnassigned) {
        state.chatRoutes[tier] = { providerId: profile.id, modelId };
        changed = true;
      }
    }
    this.refreshRouteDefaults(state);
    return changed;
  }

  applyImageRoutesForProfile(state, profile, selectionValue, { claimUnassigned = true } = {}) {
    const selection = this.normalizeImageRouteSelection(selectionValue);
    let changed = false;
    for (const adapterId of IMAGE_ADAPTER_ID_LIST) {
      const detected = profile.imageModels.find((item) => item.adapterId === adapterId) || null;
      const current = state.imageRoutes[adapterId] || null;
      if (selection) {
        if (selection.has(adapterId) && detected) {
          const next = { providerId: profile.id, remoteModelId: detected.remoteModelId };
          if (JSON.stringify(current) !== JSON.stringify(next)) {
            state.imageRoutes[adapterId] = next;
            changed = true;
          }
        } else if (current && current.providerId === profile.id) {
          delete state.imageRoutes[adapterId];
          changed = true;
        }
        continue;
      }

      if (current && current.providerId === profile.id) {
        if (detected) {
          if (current.remoteModelId !== detected.remoteModelId) {
            state.imageRoutes[adapterId] = { providerId: profile.id, remoteModelId: detected.remoteModelId };
            changed = true;
          }
        } else {
          delete state.imageRoutes[adapterId];
          changed = true;
        }
      } else if (!current && detected && claimUnassigned) {
        state.imageRoutes[adapterId] = { providerId: profile.id, remoteModelId: detected.remoteModelId };
        changed = true;
      }
    }
    return changed;
  }

  createProfile(input = {}) {
    const state = this.ensureInitialized();
    const now = this.now().toISOString();
    const id = `provider-${this.randomId()}`;
    const apiKey = cleanText(input.apiKey);
    if (!apiKey) throw new Error('请先填写 API Key');
    const baseUrl = validatedBaseUrl(input.baseUrl);
    const models = validatedModels(input.models);
    const imageModels = normalizeImageModels(input.imageModels);
    const credentialRef = `provider:${id}:${this.randomId()}`;
    this.vault.set(credentialRef, apiKey);
    const profile = normalizeProfile({
      id,
      name: this.uniqueName(state, input.name),
      baseUrl,
      credentialRef,
      authMode: normalizeAuthMode(input.authMode),
      models,
      imageModels,
      imageDiscovery: imageModels.length ? (input.imageDiscovery || {
        status: 'ready',
        checkedAt: now,
        message: '已保存图像能力',
        modelCount: imageModels.length,
      }) : undefined,
      enabled: input.enabled !== false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    state.profiles.push(profile);
    const claimUnassigned = input.claimUnassignedRoutes !== false;
    const chatRoutesChanged = this.applyChatRoutesForProfile(state, profile, input.routeTiers, { claimUnassigned });
    const imageRoutesChanged = this.applyImageRoutesForProfile(state, profile, input.imageRouteAdapters, { claimUnassigned });
    try {
      this.writeState(state);
    } catch (error) {
      try { this.vault.delete(credentialRef); } catch (_) {}
      throw error;
    }
    return {
      changed: true,
      routesChanged: chatRoutesChanged || imageRoutesChanged,
      chatRoutesChanged,
      imageRoutesChanged,
      profile: publicProfile(profile, this.vault, state),
      routes: this.getRoutingView(state),
    };
  }

  updateProfile(id, input = {}) {
    const key = cleanText(id);
    const state = this.ensureInitialized();
    const index = state.profiles.findIndex((item) => item.id === key);
    if (index < 0) throw new Error('服务商不存在');
    const profile = state.profiles[index];
    const profileIsRouted = MODEL_TIER_IDS.some((tier) => state.chatRoutes[tier]
      && state.chatRoutes[tier].providerId === profile.id)
      || IMAGE_ADAPTER_ID_LIST.some((adapterId) => state.imageRoutes[adapterId]
        && state.imageRoutes[adapterId].providerId === profile.id);
    if (input.enabled === false && profileIsRouted) {
      throw new Error('该服务商仍承担模型路由，请先切换对应档位');
    }
    const now = this.now().toISOString();
    const oldCredentialRef = profile.credentialRef;
    const oldSecret = oldCredentialRef ? this.vault.get(oldCredentialRef) : '';
    const models = input.models && typeof input.models === 'object' ? input.models : {};
    const nextBaseUrl = Object.prototype.hasOwnProperty.call(input, 'baseUrl')
      ? validatedBaseUrl(input.baseUrl)
      : profile.baseUrl;
    const nextModels = validatedModels({
      opus: Object.prototype.hasOwnProperty.call(models, 'opus') ? models.opus : profile.models.opus,
      sonnet: Object.prototype.hasOwnProperty.call(models, 'sonnet') ? models.sonnet : profile.models.sonnet,
      haiku: Object.prototype.hasOwnProperty.call(models, 'haiku') ? models.haiku : profile.models.haiku,
    });
    const suppliedKey = Object.prototype.hasOwnProperty.call(input, 'apiKey') ? cleanText(input.apiKey) : '';
    const keyChanged = !!suppliedKey && suppliedKey !== oldSecret;
    let newCredentialRef = oldCredentialRef;
    if (keyChanged) {
      newCredentialRef = `provider:${profile.id}:${this.randomId()}`;
      this.vault.set(newCredentialRef, suppliedKey);
    }
    if (!newCredentialRef || !this.vault.get(newCredentialRef)) {
      if (keyChanged) this.vault.delete(newCredentialRef);
      throw new Error('请先填写 API Key');
    }
    const connectionChanged = nextBaseUrl !== profile.baseUrl || keyChanged;
    const nextAuthMode = Object.prototype.hasOwnProperty.call(input, 'authMode')
      ? normalizeAuthMode(input.authMode)
      : profile.authMode;
    const next = normalizeProfile({
      ...profile,
      name: Object.prototype.hasOwnProperty.call(input, 'name')
        ? this.uniqueName(state, input.name, profile.id)
        : profile.name,
      baseUrl: nextBaseUrl,
      credentialRef: newCredentialRef,
      authMode: nextAuthMode,
      models: nextModels,
      imageModels: connectionChanged ? [] : profile.imageModels,
      imageDiscovery: connectionChanged ? {
        status: 'unknown',
        checkedAt: null,
        message: '连接信息已变更，请重新获取模型',
        modelCount: 0,
      } : profile.imageDiscovery,
      enabled: input.enabled === undefined ? profile.enabled : input.enabled !== false,
      updatedAt: now,
    });
    const comparable = (item) => JSON.stringify({
      name: item.name,
      baseUrl: item.baseUrl,
      credentialRef: item.credentialRef,
      authMode: item.authMode,
      models: item.models,
      imageModels: item.imageModels,
      imageDiscovery: item.imageDiscovery,
      enabled: item.enabled,
    });
    const profileChanged = comparable(next) !== comparable(profile);
    const runtimeComparable = (item) => JSON.stringify({
      baseUrl: item.baseUrl,
      credentialRef: item.credentialRef,
      authMode: item.authMode,
      models: item.models,
      enabled: item.enabled,
    });
    const runtimeChanged = runtimeComparable(next) !== runtimeComparable(profile);
    next.revision = runtimeChanged ? profile.revision + 1 : profile.revision;
    next.createdAt = profile.createdAt;
    next.updatedAt = profileChanged ? now : profile.updatedAt;
    state.profiles[index] = next;
    const beforeRoutes = JSON.stringify({ chat: state.chatRoutes, image: state.imageRoutes, defaultModel: state.defaultModel });
    const chatRoutesChanged = this.applyChatRoutesForProfile(state, next, input.routeTiers);
    const imageRoutesChanged = this.applyImageRoutesForProfile(state, next, input.imageRouteAdapters, { claimUnassigned: false });
    if (connectionChanged) {
      // Base URL 或密钥变化后，旧图像能力已经不可验证；路由必须随能力一起失效。
      for (const adapterId of IMAGE_ADAPTER_ID_LIST) {
        if (state.imageRoutes[adapterId] && state.imageRoutes[adapterId].providerId === next.id) {
          delete state.imageRoutes[adapterId];
        }
      }
    }
    this.refreshRouteDefaults(state, state.defaultModel);
    const routesChanged = chatRoutesChanged || imageRoutesChanged
      || beforeRoutes !== JSON.stringify({ chat: state.chatRoutes, image: state.imageRoutes, defaultModel: state.defaultModel });
    const changed = profileChanged || routesChanged;
    try {
      this.writeState(state);
    } catch (error) {
      if (keyChanged) {
        try { this.vault.delete(newCredentialRef); } catch (_) {}
      }
      throw error;
    }
    if (keyChanged && oldCredentialRef && oldCredentialRef !== newCredentialRef) {
      try { this.vault.delete(oldCredentialRef); } catch (_) {}
    }
    return {
      changed,
      profileChanged,
      runtimeChanged,
      routesChanged,
      chatRoutesChanged,
      imageRoutesChanged,
      profile: publicProfile(next, this.vault, state),
      routes: this.getRoutingView(state),
    };
  }

  duplicateProfile(id) {
    const key = cleanText(id);
    const state = this.ensureInitialized();
    const source = state.profiles.find((item) => item.id === key);
    if (!source) throw new Error('服务商不存在');
    const apiKey = source.credentialRef ? this.vault.get(source.credentialRef) : '';
    if (!apiKey) throw new Error('原服务商没有可复制的 API Key');
    return this.createProfile({
      name: `${source.name} 副本`,
      baseUrl: source.baseUrl,
      apiKey,
      authMode: source.authMode,
      models: source.models,
      imageModels: source.imageModels,
      imageDiscovery: source.imageDiscovery,
      enabled: source.enabled,
      claimUnassignedRoutes: false,
      routeTiers: [],
      imageRouteAdapters: [],
    });
  }

  setImageRoute(adapterId, id = null) {
    if (!IMAGE_ADAPTER_IDS.has(adapterId)) throw new Error('图像模型不受支持');
    const state = this.ensureInitialized();
    const previous = state.imageRoutes[adapterId] || null;
    if (!id) delete state.imageRoutes[adapterId];
    else {
      const profile = state.profiles.find((item) => item.id === cleanText(id));
      if (!profile || !this.connectionRuntimeForProfile(profile)) throw new Error('服务商连接不可用');
      const detected = profile.imageModels.find((item) => item.adapterId === adapterId);
      if (!detected) throw new Error('该服务商没有识别出这个图像模型');
      state.imageRoutes[adapterId] = { providerId: profile.id, remoteModelId: detected.remoteModelId };
    }
    const changed = JSON.stringify(previous) !== JSON.stringify(state.imageRoutes[adapterId] || null);
    if (changed) this.writeState(state);
    return { changed, routesChanged: changed, routes: this.getRoutingView(state) };
  }

  setDefaultModel(tier) {
    if (!MODEL_TIERS.has(tier)) throw new Error('默认档位不受支持');
    const state = this.ensureInitialized();
    if (!state.chatRoutes[tier] || !this.chatRuntimeFromState(state, tier)) throw new Error('该档位尚未配置可用模型');
    const changed = state.defaultModel !== tier;
    state.defaultModel = tier;
    this.refreshRouteDefaults(state, tier);
    if (changed) this.writeState(state);
    return { changed, routesChanged: changed, routes: this.getRoutingView(state) };
  }

  setAuthMode(id, authMode) {
    const key = cleanText(id);
    const normalized = normalizeAuthMode(authMode);
    if (!AUTH_MODES.has(authMode)) throw new Error('服务商认证方式不受支持');
    const state = this.ensureInitialized();
    const index = state.profiles.findIndex((item) => item.id === key);
    if (index < 0) throw new Error('服务商不存在');
    const profile = state.profiles[index];
    if (profile.authMode === normalized) {
      return {
        changed: false,
        profile: publicProfile(profile, this.vault, state),
      };
    }
    const now = this.now().toISOString();
    const next = normalizeProfile({
      ...profile,
      authMode: normalized,
      revision: profile.revision + 1,
      updatedAt: now,
    });
    state.profiles[index] = next;
    this.writeState(state);
    return {
      changed: true,
      profile: publicProfile(next, this.vault, state),
    };
  }

  setDiscoveredImageModels(id, imageModels, meta = {}) {
    const key = cleanText(id);
    const state = this.ensureInitialized();
    const index = state.profiles.findIndex((item) => item.id === key);
    if (index < 0) throw new Error('服务商不存在');
    const profile = state.profiles[index];
    const now = this.now().toISOString();
    const nextImageModels = Array.isArray(imageModels)
      ? normalizeImageModels(imageModels)
      : profile.imageModels;
    const requestedStatus = cleanText(meta.status);
    const status = IMAGE_DISCOVERY_STATUSES.has(requestedStatus)
      ? requestedStatus
      : (nextImageModels.length ? 'ready' : 'none');
    const nextDiscovery = normalizeImageDiscovery({
      status,
      checkedAt: now,
      message: meta.message,
      modelCount: Object.prototype.hasOwnProperty.call(meta, 'modelCount')
        ? meta.modelCount
        : nextImageModels.length,
    });
    const capabilitiesChanged = JSON.stringify(nextImageModels) !== JSON.stringify(profile.imageModels);
    const discoveryChanged = JSON.stringify(nextDiscovery) !== JSON.stringify(profile.imageDiscovery);
    if (!capabilitiesChanged && !discoveryChanged) {
      return {
        changed: false,
        routesChanged: false,
        profile: publicProfile(profile, this.vault, state),
        routes: this.getRoutingView(state),
      };
    }
    const next = normalizeProfile({
      ...profile,
      imageModels: nextImageModels,
      imageDiscovery: nextDiscovery,
      // 图像能力不参与 Claude 对话会话指纹；刷新图像目录不能让现有对话被迫重启。
      revision: profile.revision,
      updatedAt: capabilitiesChanged ? now : profile.updatedAt,
    });
    state.profiles[index] = next;
    const routeAssignmentsChanged = this.applyImageRoutesForProfile(
      state,
      next,
      meta.imageRouteAdapters,
      // Catalog membership is not proof of key access. Keep explicit choices
      // and existing routes, but never assign an empty route from discovery.
      { claimUnassigned: false },
    );
    this.writeState(state);
    return {
      changed: true,
      routesChanged: capabilitiesChanged || routeAssignmentsChanged,
      capabilitiesChanged,
      routeAssignmentsChanged,
      profile: publicProfile(next, this.vault, state),
      routes: this.getRoutingView(state),
    };
  }

  migrateLegacyImageProvider({ baseUrl, apiKey, imageModels } = {}) {
    const secret = cleanText(apiKey);
    if (!cleanText(baseUrl) || !secret) return { changed: false, migrated: false, profile: null };
    const normalizedBaseUrl = validatedBaseUrl(baseUrl);
    const normalizedImages = normalizeImageModels(imageModels);
    if (!normalizedImages.length) return { changed: false, migrated: false, profile: null };
    const state = this.ensureInitialized();
    const existing = state.profiles.find((profile) => profile.baseUrl.toLocaleLowerCase() === normalizedBaseUrl.toLocaleLowerCase()
      && profile.credentialRef && this.vault.get(profile.credentialRef) === secret);
    if (existing) {
      const result = this.setDiscoveredImageModels(existing.id, normalizedImages, {
        status: 'ready',
        message: '已迁移旧版图像配置',
        modelCount: normalizedImages.length,
        // Legacy settings are an existing user configuration, not a fresh
        // catalog. Restore its selections without replacing another route.
        imageRouteAdapters: normalizedImages
          .filter(item => !state.imageRoutes[item.adapterId]
            || state.imageRoutes[item.adapterId].providerId === existing.id)
          .map(item => item.adapterId),
      });
      return { ...result, migrated: true };
    }
    const result = this.createProfile({
      name: '图像服务（已迁移）',
      baseUrl: normalizedBaseUrl,
      apiKey: secret,
      models: {},
      imageModels: normalizedImages,
      imageDiscovery: {
        status: 'ready',
        checkedAt: this.now().toISOString(),
        message: '已迁移旧版图像配置',
        modelCount: normalizedImages.length,
      },
      enabled: true,
    });
    return { ...result, migrated: true };
  }

  removeProfile(id) {
    const key = cleanText(id);
    const state = this.ensureInitialized();
    const index = state.profiles.findIndex((item) => item.id === key);
    if (index < 0) throw new Error('服务商不存在');
    const profile = state.profiles[index];
    const chatRoles = MODEL_TIER_IDS.filter((tier) => state.chatRoutes[tier]
      && state.chatRoutes[tier].providerId === profile.id);
    const imageRoles = IMAGE_ADAPTER_ID_LIST.filter((adapterId) => state.imageRoutes[adapterId]
      && state.imageRoutes[adapterId].providerId === profile.id);
    if (chatRoles.length || imageRoles.length) throw new Error('当前承担模型路由的服务商不能删除，请先切换对应档位');
    state.profiles.splice(index, 1);
    this.writeState(state);
    if (profile.credentialRef) {
      try { this.vault.delete(profile.credentialRef); } catch (_) {}
    }
    return { changed: true, id: profile.id };
  }

  updateActiveProfile(input = {}) {
    const state = this.ensureInitialized();
    const profile = this.activeProfile(state);
    if (!profile) {
      return this.createProfile({
        name: cleanText(input.name, 'Relay 默认服务'),
        baseUrl: Object.prototype.hasOwnProperty.call(input, 'baseUrl') ? input.baseUrl : '',
        apiKey: input.apiKey,
        authMode: input.authMode,
        models: input.models || {},
      });
    }
    return this.updateProfile(profile.id, input);
  }

  getAppSecret(name) {
    return this.vault.get(`app:${cleanText(name)}`);
  }

  setAppSecret(name, secret) {
    return this.vault.set(`app:${cleanText(name)}`, secret);
  }

  deleteAppSecret(name) {
    return this.vault.delete(`app:${cleanText(name)}`);
  }
}

module.exports = {
  ProviderStore,
  SecretVault,
  DEFAULT_BASE_URL,
  DEFAULT_MODELS,
  MODEL_TIER_IDS,
  IMAGE_ADAPTER_IDS,
  IMAGE_ADAPTER_ID_LIST,
  chatRouteId,
  imageRouteId,
  credentialHint,
};
