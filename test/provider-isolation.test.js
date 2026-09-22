'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProviderStore } = require('../src/main/providers/provider-store');
const { buildRelayRuntimeEnv, RELAY_PROVIDER_ENV_KEYS } = require('../src/main/sdk/claude-sdk');
const {
  providerApiUrl,
  providerModelApiCandidates,
  normalizeModelCatalog,
  normalizeModelList,
  detectAdaptedImageModels,
  imageRequestRoute,
  testProviderConnection,
  discoverProviderModels,
} = require('../src/main/providers/provider-connectivity');

test('模型目录候选兼容 Claude 网关前缀且始终限制在同域', () => {
  assert.deepEqual(providerModelApiCandidates('https://gateway.example/team/anthropic/v1'), [
    'https://gateway.example/team/anthropic/v1/models',
    'https://gateway.example/team/v1/models',
    'https://gateway.example/team/models',
  ]);
  assert.deepEqual(providerModelApiCandidates('https://gateway.example/api/claudecode'), [
    'https://gateway.example/api/claudecode/v1/models',
    'https://gateway.example/v1/models',
    'https://gateway.example/models',
  ]);
  assert.deepEqual(providerModelApiCandidates('https://gateway.example/v1'), [
    'https://gateway.example/v1/models',
  ]);
  assert.deepEqual(providerModelApiCandidates('https://open.bigmodel.cn/api/coding/paas/v4'), [
    'https://open.bigmodel.cn/api/coding/paas/v4/models',
    'https://open.bigmodel.cn/api/coding/paas/v4/v1/models',
  ]);
});

test('模型目录保留服务端原始 ID，并用既有配置推断共享网关路由 ID', () => {
  const payload = {
    data: [
      { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
      { id: 'mimo-v2.5-pro', owned_by: 'xiaomi' },
      { id: 'deepseek-v4-flash', owned_by: 'tongyi' },
      { id: 'pa/claude-opus-4-8', owned_by: 'ppio' },
      { id: 'xiaomi/already-qualified', owned_by: 'xiaomi' },
    ],
  };

  // 与 CC Switch 一致：通用解析永远不改写接口返回的 id。
  assert.deepEqual(normalizeModelList(payload), [
    'deepseek-v4-flash',
    'mimo-v2.5-pro',
    'pa/claude-opus-4-8',
    'xiaomi/already-qualified',
  ]);

  // 已保存且实际可用的 Relay 映射是最强证据；[1m] 只表示上下文，不属于模型 ID。
  const mifyCatalog = normalizeModelCatalog(payload, {
    configuredModels: ['xiaomi/mimo-v2.5-pro[1m]', 'ppio/pa/claude-opus-4-8'],
  });
  assert.equal(mifyCatalog.idStrategy, 'owner-qualified');
  assert.equal(mifyCatalog.strategyEvidence, 'configured-models');
  assert.deepEqual(mifyCatalog.catalog.map((item) => item.value), [
    'deepseek/deepseek-v4-flash',
    'xiaomi/mimo-v2.5-pro',
    'tongyi/deepseek-v4-flash',
    'ppio/pa/claude-opus-4-8',
    'xiaomi/already-qualified',
  ]);
  assert.deepEqual(mifyCatalog.catalog.find((item) => item.value === 'xiaomi/mimo-v2.5-pro'), {
    id: 'mimo-v2.5-pro',
    value: 'xiaomi/mimo-v2.5-pro',
    ownedBy: 'xiaomi',
    alternateId: 'mimo-v2.5-pro',
    idKind: 'owner-qualified',
    inference: 'configured-owner',
  });

  // 旧裸名与正确命名空间值并存时，不能让旧值污染同一 owner 的下拉结果。
  const mixedLegacyCatalog = normalizeModelCatalog(payload, {
    configuredModels: ['mimo-v2.5-pro', 'xiaomi/mimo-v2.5-pro[1m]', 'ppio/pa/claude-opus-4-8'],
  });
  assert.equal(mixedLegacyCatalog.idStrategy, 'mixed');
  assert.equal(mixedLegacyCatalog.catalog.some((item) => item.value === 'xiaomi/mimo-v2.5-pro'), true);
  assert.equal(mixedLegacyCatalog.catalog.some((item) => item.value === 'mimo-v2.5-pro'), false);

  // 单一服务商目录里的 owned_by 仅用于展示，不能擅自拼进模型名。
  const openAiCatalog = normalizeModelCatalog({
    data: [
      { id: 'gpt-4.1', owned_by: 'openai' },
      { id: 'gpt-4.1-mini', owned_by: 'openai' },
    ],
  });
  assert.equal(openAiCatalog.idStrategy, 'raw');
  assert.deepEqual(openAiCatalog.catalog.map((item) => item.value), ['gpt-4.1', 'gpt-4.1-mini']);

  // 如果当前已验证配置使用原始 ID，即使目录有 owner 冲突也继续尊重原值。
  const rawConfigured = normalizeModelCatalog(payload, { configuredModels: ['mimo-v2.5-pro'] });
  assert.equal(rawConfigured.idStrategy, 'raw');
  assert.deepEqual(rawConfigured.catalog.map((item) => item.value), [
    'deepseek-v4-flash',
    'mimo-v2.5-pro',
    'pa/claude-opus-4-8',
    'xiaomi/already-qualified',
  ]);
});

test('模型目录兼容对象映射，并保留 owner 作为元数据', () => {
  const result = normalizeModelCatalog({
    models: {
      'model-a': { ownedBy: 'vendor-a' },
      'model-b': { slug: 'vendor-b/model-b', vendor: 'vendor-b' },
      'model-c': 'model-c-live',
    },
  });
  assert.deepEqual(result.catalog.map((item) => ({ id: item.id, value: item.value, ownedBy: item.ownedBy })), [
    { id: 'model-a', value: 'model-a', ownedBy: 'vendor-a' },
    { id: 'vendor-b/model-b', value: 'vendor-b/model-b', ownedBy: 'vendor-b' },
    { id: 'model-c-live', value: 'model-c-live', ownedBy: '' },
  ]);
});

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`vault:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (value) => {
      const encoded = value.toString('utf8').replace(/^vault:/, '');
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('首次初始化不导入旧 Claude API 配置，Relay 服务商保持空白', (t) => {
  const root = tempDir(t);
  const legacyPath = path.join(root, 'external-claude-settings.json');
  const secret = 'sk-relay-private-123456';
  const legacyRaw = JSON.stringify({
    env: {
      ANTHROPIC_API_KEY: secret,
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic/',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor/fast',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/think',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor/expert',
    },
    model: 'sonnet',
  }, null, 2);
  fs.writeFileSync(legacyPath, legacyRaw, 'utf8');

  const store = new ProviderStore({
    userDataDir: path.join(root, 'relay-user-data'),
    safeStorage: fakeSafeStorage(),
    legacySettingsPath: legacyPath,
    now: () => new Date('2026-08-27T00:00:00.000Z'),
    randomId: () => 'fixed-id',
    logger: { log() {}, warn() {} },
  });

  assert.equal(store.hasUsableProvider(), false);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyRaw, '外部配置必须字节级不变');

  const view = store.getSettingsView();
  assert.equal(view.baseUrl, '');
  assert.deepEqual(view.models, { opus: '', sonnet: '', haiku: '' });
  assert.equal(view.defaultModel, 'haiku');
  assert.equal(view.hasCredential, false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'apiKey'), false);
  assert.equal(store.listProfiles().length, 0);
  assert.equal(store.getActiveRuntime(), null);

  const paths = store.paths();
  const state = JSON.parse(fs.readFileSync(paths.profiles, 'utf8'));
  assert.equal(state.migration.legacyClaudeSettings.completed, true);
  assert.equal(state.migration.legacyClaudeSettings.imported, false);
  assert.equal(fs.readFileSync(paths.profiles, 'utf8').includes(secret), false);
  assert.equal(fs.existsSync(paths.secrets), false);
});

test('更新供应商时留空保留密钥，替换密钥与配置版本原子切换', (t) => {
  const root = tempDir(t);
  const store = new ProviderStore({
    userDataDir: root,
    safeStorage: fakeSafeStorage(),
    now: () => new Date('2026-08-27T01:00:00.000Z'),
    randomId: (() => { let i = 0; return () => `id-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });

  const first = store.updateActiveProfile({
    apiKey: 'sk-first-secret',
    baseUrl: 'https://one.example',
    models: { haiku: 'one/fast', sonnet: 'one/think', opus: 'one/expert' },
    defaultModel: 'haiku',
  });
  assert.equal(first.changed, true);
  assert.equal(first.profile.revision, 1);

  const preserved = store.updateActiveProfile({
    apiKey: '',
    baseUrl: 'https://two.example',
    models: first.profile.models,
    defaultModel: 'haiku',
  });
  assert.equal(preserved.profile.revision, 2);
  assert.equal(store.getActiveRuntime().env.ANTHROPIC_API_KEY, 'sk-first-secret');

  const replaced = store.updateActiveProfile({ apiKey: 'sk-second-secret', baseUrl: 'https://two.example' });
  assert.equal(replaced.profile.revision, 3);
  assert.equal(store.getActiveRuntime().env.ANTHROPIC_API_KEY, 'sk-second-secret');
  const records = JSON.parse(fs.readFileSync(store.paths().secrets, 'utf8')).records;
  assert.equal(Object.keys(records).filter((key) => key.startsWith('provider:')).length, 1);
});

test('系统加密不可用时拒绝明文落盘', (t) => {
  const root = tempDir(t);
  const store = new ProviderStore({ userDataDir: root, safeStorage: fakeSafeStorage(false) });
  assert.throws(
    () => store.updateActiveProfile({
      apiKey: 'must-not-persist',
      baseUrl: 'https://provider.example',
      models: { haiku: 'model/fast', sonnet: 'model/think', opus: 'model/expert' },
    }),
    /拒绝以明文保存/,
  );
  for (const file of fs.readdirSync(root)) {
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8').includes('must-not-persist'), false);
  }
});

test('多服务商支持新增、复制、槽位切换、编辑与安全删除', (t) => {
  const root = tempDir(t);
  const store = new ProviderStore({
    userDataDir: root,
    safeStorage: fakeSafeStorage(),
    randomId: (() => { let i = 0; return () => `multi-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });
  const first = store.createProfile({
    name: '主服务',
    apiKey: 'sk-main-provider',
    baseUrl: 'https://main.example',
    models: { haiku: 'main/fast', sonnet: 'main/think', opus: 'main/expert' },
    defaultModel: 'haiku',
  }).profile;
  const second = store.createProfile({
    name: '备用服务',
    apiKey: 'sk-backup-provider',
    baseUrl: 'https://backup.example',
    models: { haiku: 'backup/fast', sonnet: 'backup/think', opus: 'backup/expert' },
    defaultModel: 'sonnet',
  }).profile;

  assert.equal(store.listProfiles().length, 2);
  assert.equal(store.getProfile(first.id).active, true);
  assert.throws(() => store.removeProfile(first.id), /不能删除/);
  assert.throws(() => store.updateProfile(second.id, { baseUrl: 'file:///tmp/provider' }), /http:\/\//);

  const activated = store.updateProfile(second.id, {
    routeTiers: ['haiku', 'sonnet', 'opus'],
    defaultModel: 'sonnet',
  });
  assert.equal(activated.routesChanged, true);
  assert.equal(store.getActiveRuntime().env.ANTHROPIC_API_KEY, 'sk-backup-provider');
  const edited = store.updateProfile(second.id, { name: '备用服务 A', apiKey: '', defaultModel: 'opus' });
  assert.equal(edited.profile.name, '备用服务 A');
  assert.equal(store.getActiveRuntime().env.ANTHROPIC_API_KEY, 'sk-backup-provider');

  const duplicate = store.duplicateProfile(second.id).profile;
  assert.match(duplicate.name, /副本/);
  assert.equal(duplicate.active, false);
  store.removeProfile(first.id);
  assert.equal(store.listProfiles().length, 2);

  const disk = fs.readFileSync(store.paths().profiles, 'utf8') + fs.readFileSync(store.paths().secrets, 'utf8');
  assert.equal(disk.includes('sk-main-provider'), false);
  assert.equal(disk.includes('sk-backup-provider'), false);
});

test('六个能力槽位可分别由不同服务商提供，且不会串用模型或密钥', (t) => {
  const store = new ProviderStore({
    userDataDir: tempDir(t),
    safeStorage: fakeSafeStorage(),
    randomId: (() => { let i = 0; return () => `route-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });

  const fast = store.createProfile({
    name: '快速网关',
    apiKey: 'sk-fast-only',
    baseUrl: 'https://fast.example/anthropic',
    models: { haiku: 'xiaomi/mimo-v2.5-pro', sonnet: '', opus: '' },
    routeTiers: ['haiku'],
    claimUnassignedRoutes: false,
  }).profile;
  const thinker = store.createProfile({
    name: '思考网关',
    apiKey: 'sk-think-only',
    baseUrl: 'https://think.example/v1',
    models: { haiku: '', sonnet: 'deepseek/deepseek-v4', opus: '' },
    routeTiers: ['sonnet'],
    claimUnassignedRoutes: false,
  }).profile;
  const expert = store.createProfile({
    name: '专家与图像网关',
    apiKey: 'sk-expert-image',
    baseUrl: 'https://expert.example',
    models: { haiku: '', sonnet: '', opus: 'ppio/claude-opus-4-8' },
    imageModels: [
      { adapterId: 'gpt-image-2', remoteModelId: 'tenant/gpt-image-2-preview' },
      { adapterId: 'seedream-5.0', remoteModelId: 'tenant/seedream-5.0' },
    ],
    routeTiers: ['opus'],
    imageRouteAdapters: ['gpt-image-2'],
    claimUnassignedRoutes: false,
  }).profile;
  const imageBackup = store.createProfile({
    name: '图像补充网关',
    apiKey: 'sk-image-backup',
    baseUrl: 'https://image.example/v1',
    models: { haiku: '', sonnet: '', opus: '' },
    imageModels: [
      { adapterId: 'seedream-5.0', remoteModelId: 'other/seedream-5.0' },
      { adapterId: 'seedream-4.5', remoteModelId: 'other/seedream-4.5' },
    ],
    imageRouteAdapters: ['seedream-5.0', 'seedream-4.5'],
    claimUnassignedRoutes: false,
  }).profile;

  const routing = store.getRoutingView();
  assert.deepEqual(routing.chatRoutes.map((route) => [route.tier, route.providerId, route.modelId]), [
    ['haiku', fast.id, 'xiaomi/mimo-v2.5-pro'],
    ['sonnet', thinker.id, 'deepseek/deepseek-v4'],
    ['opus', expert.id, 'ppio/claude-opus-4-8'],
  ]);
  assert.deepEqual(routing.imageRoutes.map((route) => [route.adapterId, route.providerId]), [
    ['gpt-image-2', expert.id],
    ['seedream-5.0', imageBackup.id],
    ['seedream-4.5', imageBackup.id],
  ]);

  const fastRuntime = store.getChatRuntime('haiku');
  const thinkRuntime = store.getChatRuntime('sonnet');
  assert.equal(fastRuntime.modelId, 'xiaomi/mimo-v2.5-pro');
  assert.equal(fastRuntime.env.ANTHROPIC_BASE_URL, 'https://fast.example/anthropic');
  assert.equal(fastRuntime.env.ANTHROPIC_API_KEY, 'sk-fast-only');
  assert.equal(thinkRuntime.modelId, 'deepseek/deepseek-v4');
  assert.equal(thinkRuntime.env.ANTHROPIC_API_KEY, 'sk-think-only');
  assert.equal(thinkRuntime.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek/deepseek-v4');

  const duplicate = store.duplicateProfile(fast.id).profile;
  assert.deepEqual(duplicate.activeTiers, []);
  assert.equal(store.getChatRuntime('haiku').id, fast.id);

  const beforeImageDiscoveryRevision = store.getProfile(expert.id).revision;
  store.setDiscoveredImageModels(expert.id, [
    { adapterId: 'gpt-image-2', remoteModelId: 'tenant/gpt-image-2-v2' },
  ]);
  assert.equal(store.getProfile(expert.id).revision, beforeImageDiscoveryRevision,
    '刷新图像能力不能让 Claude 对话会话指纹变化');
  assert.throws(() => store.removeProfile(imageBackup.id), /不能删除/);
});

test('旧版单一当前服务商会无损迁移为槽位路由', (t) => {
  const root = tempDir(t);
  const safeStorage = fakeSafeStorage();
  const store = new ProviderStore({
    userDataDir: root,
    safeStorage,
    randomId: (() => { let i = 0; return () => `legacy-route-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });
  store.createProfile({
    name: '旧备用', apiKey: 'sk-old-backup', baseUrl: 'https://old-backup.example',
    models: { haiku: 'backup-fast', sonnet: '', opus: '' },
  });
  const legacyActive = store.createProfile({
    name: '旧当前', apiKey: 'sk-old-active', baseUrl: 'https://old-active.example',
    models: { haiku: 'active-fast', sonnet: 'active-think', opus: 'active-expert' },
    imageModels: [{ adapterId: 'gpt-image-2', remoteModelId: 'legacy/gpt-image-2' }],
  }).profile;
  const statePath = store.paths().profiles;
  const legacyState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  legacyState.schemaVersion = 3;
  legacyState.activeProviderId = legacyActive.id;
  delete legacyState.defaultModel;
  delete legacyState.chatRoutes;
  delete legacyState.imageRoutes;
  fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2), 'utf8');

  const migrated = new ProviderStore({ userDataDir: root, safeStorage, logger: { log() {}, warn() {} } });
  const routes = migrated.getRoutingView();
  assert.deepEqual(routes.chatRoutes.map((route) => route.providerId), [
    legacyActive.id, legacyActive.id, legacyActive.id,
  ]);
  assert.equal(routes.imageRoutes[0].providerId, legacyActive.id);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 5);
});

test('Claude 子进程环境清除外部认证并仅注入 Relay 快照', () => {
  const saved = {};
  for (const key of RELAY_PROVIDER_ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = `external-${key}`;
  }
  try {
    const runtime = buildRelayRuntimeEnv({
      ANTHROPIC_API_KEY: 'relay-key',
      ANTHROPIC_BASE_URL: 'https://relay.example',
    });
    assert.equal(runtime.ANTHROPIC_API_KEY, 'relay-key');
    assert.equal(runtime.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(runtime.ANTHROPIC_BASE_URL, 'https://relay.example');
    assert.equal(runtime.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'external-ANTHROPIC_API_KEY');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('连接检测和模型发现只返回脱敏结果', async () => {
  const runtime = {
    defaultModel: 'haiku',
    env: {
      ANTHROPIC_API_KEY: 'sk-never-return-this',
      ANTHROPIC_BASE_URL: 'https://relay.example/v1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor/fast',
    },
  };
  assert.equal(providerApiUrl(runtime.env.ANTHROPIC_BASE_URL, '/v1/messages'), 'https://relay.example/v1/messages');
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [
        { id: 'vendor/fast' },
        { id: 'vendor/expert' },
        { id: 'vendor-a/gpt-image-2-preview' },
        { id: 'vendor-b/Doubao-Seedream-5.0-lite' },
        { id: 'custom/seedream-4.5' },
      ] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const probe = await testProviderConnection(runtime, { fetchImpl: fakeFetch });
  assert.equal(probe.ok, true);
  assert.equal(probe.protocol, 'anthropic');
  assert.equal(probe.authMode, 'api-key');
  assert.equal(JSON.stringify(probe).includes('sk-never-return-this'), false);
  const discovery = await discoverProviderModels(runtime, { fetchImpl: fakeFetch });
  assert.deepEqual(discovery.imageModels, [
    { adapterId: 'gpt-image-2', remoteModelId: 'vendor-a/gpt-image-2-preview' },
    { adapterId: 'seedream-5.0', remoteModelId: 'vendor-b/Doubao-Seedream-5.0-lite' },
    { adapterId: 'seedream-4.5', remoteModelId: 'custom/seedream-4.5' },
  ]);
  assert.equal(JSON.stringify(discovery).includes('sk-never-return-this'), false);
  assert.equal(requests[0].options.headers['x-api-key'], 'sk-never-return-this');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[0].options.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(requests[0].options.body).messages, [{ role: 'user', content: 'OK' }]);
  assert.deepEqual(normalizeModelList({ models: ['a', { name: 'b' }, { id: 'a' }] }), ['a', 'b']);
});

test('Anthropic 对话检测自动切换 Bearer 认证且不混发认证头', async () => {
  const runtime = {
    authMode: 'api-key',
    defaultModel: 'haiku',
    env: {
      ANTHROPIC_API_KEY: 'relay-anthropic-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-compatible',
    },
  };
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.headers['x-api-key']) {
      return new Response(JSON.stringify({ error: { message: 'Authorization bearer token required' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await testProviderConnection(runtime, { fetchImpl: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 'anthropic');
  assert.equal(result.authMode, 'auth-token');
  assert.equal(result.endpoint, '/anthropic/v1/messages');
  assert.equal(result.gatewayRootFallbackUsed, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://gateway.example/anthropic/v1/messages');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[1].options.headers['x-api-key'], undefined);
  assert.equal(requests[1].options.headers.authorization, 'Bearer relay-anthropic-token');
  assert.equal(JSON.stringify(result).includes('relay-anthropic-token'), false);
});

test('模型授权失败不误判认证头，并明确区分网关可达与模型无权限', async () => {
  const runtime = {
    authMode: 'api-key',
    defaultModel: 'haiku',
    env: {
      ANTHROPIC_API_KEY: 'relay-model-scope-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor/restricted-model',
    },
  };
  const requests = [];
  const result = await testProviderConnection(runtime, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({
        error: {
          message: '该模型不在 Key 的可用模型范围内',
          param: 'Please provide valid API Key',
          type: 'invalid_key',
        },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reachable, true);
  assert.equal(result.errorKind, 'model_not_allowed');
  assert.match(result.message, /网关可达/);
  assert.equal(requests.length, 1, '模型权限错误不应再用另一种认证头重复请求');
  assert.equal(requests[0].options.headers['x-api-key'], 'relay-model-scope-key');
});

test('Anthropic 模型发现兼容网关前缀并在同域回退模型目录', async () => {
  const runtime = {
    authMode: 'auth-token',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'relay-model-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example/team/anthropic/v1',
    },
  };
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/anthropic/')) {
      return new Response(JSON.stringify({ error: { message: 'Invalid request', param: '404 NOT_FOUND', code: '400' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      data: [
        { type: 'model', id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        { type: 'model', id: 'tenant/gpt-image-2' },
      ],
      has_more: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await discoverProviderModels(runtime, { fetchImpl: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(result.authMode, 'auth-token');
  assert.equal(result.endpoint, '/team/v1/models');
  assert.equal(result.gatewayRootFallbackUsed, true);
  assert.equal(result.catalogSource, 'gateway-root');
  assert.match(result.message, /共享模型目录/);
  assert.deepEqual(result.models, ['claude-sonnet-4-20250514', 'tenant/gpt-image-2']);
  assert.deepEqual(result.imageModels, [{ adapterId: 'gpt-image-2', remoteModelId: 'tenant/gpt-image-2' }]);
  assert.deepEqual(requests.map((item) => item.url), [
    'https://gateway.example/team/anthropic/v1/models',
    'https://gateway.example/team/v1/models',
  ]);
  for (const request of requests) {
    assert.equal(request.options.headers.authorization, 'Bearer relay-model-token');
    assert.equal(request.options.headers['x-api-key'], undefined);
    assert.equal(request.options.headers['content-type'], undefined);
  }
  assert.equal(JSON.stringify(result).includes('relay-model-token'), false);
});

test('模型发现会继续探测根目录 models 端点并发送常规 User-Agent', async () => {
  const runtime = {
    env: {
      ANTHROPIC_API_KEY: 'relay-catalog-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
    },
  };
  const requests = [];
  const result = await discoverProviderModels(runtime, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/models') && !String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ models: ['xiaomi/mimo-v2.5-pro[1m]', 'vendor/claude-opus'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const routeMiss = String(url).includes('/anthropic/');
      return new Response(JSON.stringify({ error: routeMiss
        ? { message: 'Invalid request', param: '404 NOT_FOUND' }
        : { message: 'Invalid request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.endpoint, '/models');
  assert.deepEqual(result.models, ['xiaomi/mimo-v2.5-pro[1m]', 'vendor/claude-opus']);
  assert.deepEqual(requests.map((item) => item.url), [
    'https://gateway.example/anthropic/v1/models',
    'https://gateway.example/v1/models',
    'https://gateway.example/models',
  ]);
  requests.forEach((request) => assert.equal(request.options.headers['user-agent'], `Relay/${require('../package.json').version}`));
});

test('Anthropic 对话检测不把模型目录的根路径回退误判为可运行 Base URL', async () => {
  const runtime = {
    defaultModel: 'haiku',
    env: {
      ANTHROPIC_API_KEY: 'relay-route-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-model',
    },
  };
  const requests = [];
  const result = await testProviderConnection(runtime, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ error: { message: 'route not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(requests, ['https://gateway.example/anthropic/v1/messages']);
});

test('检测到的 Anthropic 认证方式写入服务商并用于 Claude SDK 快照', (t) => {
  const store = new ProviderStore({
    userDataDir: tempDir(t),
    safeStorage: fakeSafeStorage(),
    randomId: (() => { let i = 0; return () => `auth-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });
  const created = store.createProfile({
    name: 'Anthropic 网关',
    apiKey: 'Bearer relay-runtime-token',
    baseUrl: 'https://gateway.example/anthropic',
    models: { haiku: 'fast', sonnet: 'think', opus: 'expert' },
  }).profile;

  const apiKeyRuntime = store.getRuntime(created.id);
  assert.equal(apiKeyRuntime.authMode, 'api-key');
  assert.equal(apiKeyRuntime.env.ANTHROPIC_API_KEY, 'relay-runtime-token');
  assert.equal(apiKeyRuntime.env.ANTHROPIC_AUTH_TOKEN, undefined);

  const updated = store.setAuthMode(created.id, 'auth-token');
  assert.equal(updated.changed, true);
  assert.equal(updated.profile.authMode, 'auth-token');
  const tokenRuntime = store.getRuntime(created.id);
  assert.equal(tokenRuntime.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(tokenRuntime.env.ANTHROPIC_AUTH_TOKEN, 'relay-runtime-token');
  assert.deepEqual(tokenRuntime.models, { haiku: 'fast', sonnet: 'think', opus: 'expert' });
  const sdkEnvironment = buildRelayRuntimeEnv(tokenRuntime.env);
  assert.equal(sdkEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(sdkEnvironment.ANTHROPIC_AUTH_TOKEN, 'relay-runtime-token');
  assert.equal(store.setAuthMode(created.id, 'auth-token').changed, false);
  assert.throws(() => store.setAuthMode(created.id, 'openai'), /不受支持/);

  const duplicate = store.duplicateProfile(created.id).profile;
  assert.equal(duplicate.authMode, 'auth-token');
  assert.equal(store.getRuntime(duplicate.id).env.ANTHROPIC_AUTH_TOKEN, 'relay-runtime-token');
  assert.equal(fs.readFileSync(store.paths().profiles, 'utf8').includes('relay-runtime-token'), false);
});

test('图像模型按核心名模糊识别并保留完整远端 ID', () => {
  assert.deepEqual(detectAdaptedImageModels([
    'namespace/gpt-image-2-beta',
    'gpt-image-2',
    'another/DOUBAO-SEEDREAM-5.0-lite',
    'region/team/seedream-4.5-202608',
    'unrelated-image-model',
  ]), [
    { adapterId: 'gpt-image-2', remoteModelId: 'gpt-image-2' },
    { adapterId: 'seedream-5.0', remoteModelId: 'another/DOUBAO-SEEDREAM-5.0-lite' },
    { adapterId: 'seedream-4.5', remoteModelId: 'region/team/seedream-4.5-202608' },
  ]);
  assert.deepEqual(imageRequestRoute('vendor/custom/gpt-image-2'), {
    requestModel: 'vendor/custom/gpt-image-2',
    providerHeader: '',
  });
  assert.deepEqual(imageRequestRoute('azure_openai/gpt-image-2'), {
    requestModel: 'gpt-image-2',
    providerHeader: 'azure_openai',
  });
});

test('纯图像服务商可保存，路由随连接变更自动失效', (t) => {
  const store = new ProviderStore({
    userDataDir: tempDir(t),
    safeStorage: fakeSafeStorage(),
    randomId: (() => { let i = 0; return () => `image-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });
  const created = store.createProfile({
    name: '图像服务',
    apiKey: 'sk-image-only',
    baseUrl: 'https://images.example/v1',
    models: {},
  }).profile;
  assert.equal(created.active, false);
  assert.equal(created.chatReady, false);
  assert.equal(store.getRuntime(created.id), null);
  assert.equal(store.getConnectionRuntime(created.id).env.ANTHROPIC_API_KEY, 'sk-image-only');
  assert.equal(store.getRoutingView().chatRoutes.some((route) => route.configured), false);

  const detected = store.setDiscoveredImageModels(created.id, [
    { adapterId: 'gpt-image-2', remoteModelId: 'tenant/gpt-image-2' },
    { adapterId: 'seedream-5.0', remoteModelId: 'tenant/seedream-5.0-lite' },
  ], { status: 'ready', message: '发现 8 个模型', modelCount: 8 });
  assert.equal(detected.routeAssignmentsChanged, false);
  assert.equal(store.listImageRoutes().length, 0, '目录发现不能替用户分配图像路由');
  store.setImageRoute('gpt-image-2', created.id);
  store.setImageRoute('seedream-5.0', created.id);
  assert.equal(store.listImageRoutes().length, 2);
  const runtime = store.getImageRuntime(`${created.id}::gpt-image-2`);
  assert.equal(runtime.remoteModelId, 'tenant/gpt-image-2');
  assert.equal(runtime.apiKey, 'sk-image-only');

  const changed = store.updateProfile(created.id, { baseUrl: 'https://images-2.example/v1' });
  assert.deepEqual(changed.profile.imageModels, []);
  assert.equal(changed.profile.imageDiscovery.status, 'unknown');
  assert.equal(store.listImageRoutes().length, 0);
});

test('旧版独立图像配置迁移到同连接服务商且不复制明文密钥', (t) => {
  const store = new ProviderStore({
    userDataDir: tempDir(t),
    safeStorage: fakeSafeStorage(),
    randomId: (() => { let i = 0; return () => `migration-${++i}`; })(),
    logger: { log() {}, warn() {} },
  });
  const chat = store.createProfile({
    name: '统一服务',
    apiKey: 'sk-shared-provider',
    baseUrl: 'https://unified.example/v1',
    models: { haiku: 'fast', sonnet: 'think', opus: 'expert' },
  }).profile;
  const migrated = store.migrateLegacyImageProvider({
    baseUrl: 'https://unified.example/v1/',
    apiKey: 'sk-shared-provider',
    imageModels: [{ adapterId: 'gpt-image-2', remoteModelId: 'prefix/gpt-image-2' }],
  });
  assert.equal(migrated.migrated, true);
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.getProfile(chat.id).imageReady, true);
  assert.equal(store.getImageRuntime('prefix/gpt-image-2').providerId, chat.id);
  assert.equal(fs.readFileSync(store.paths().profiles, 'utf8').includes('sk-shared-provider'), false);
});

test('Relay 主进程不再写外部 Claude API / 模型配置', () => {
  const root = path.resolve(__dirname, '..');
  const main = ['src/main/bootstrap.js', 'src/main/providers/provider-ipc.js',
    'src/main/app/app-settings-service.js', 'src/main/app/application-windows.js']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const wizard = fs.readFileSync(path.join(root, 'installer', 'wizard.html'), 'utf8');
  const wizardScript = fs.readFileSync(path.join(root, 'installer', 'wizard.js'), 'utf8');
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const providerStore = fs.readFileSync(path.join(root, 'src/main/providers/provider-store.js'), 'utf8');
  assert.doesNotMatch(main, /function\s+writeSettings\s*\(/);
  assert.match(main, /function\s+readLegacyClaudeSettings\s*\(/);
  assert.match(main, /providerStore\.createProfile\s*\(/);
  assert.doesNotMatch(main, /providers:activate|providers:setChatRoute|providers:setDefaultModel/);
  assert.doesNotMatch(main, /legacySettingsPath|model\.mify|api\.llm\.mioffice/);
  assert.match(main, /firstRunSetupVersion/);
  const imageModelsBlock = main.match(/const IMAGE_MODELS = \[([\s\S]*?)\n\];/);
  assert.ok(imageModelsBlock);
  assert.equal((imageModelsBlock[1].match(/\{ adapterId:/g) || []).length, 3);
  assert.doesNotMatch(renderer, /外部 Claude 设置/);
  assert.doesNotMatch(renderer, /claudeSettings/);
  assert.doesNotMatch(renderer, /Claude Code 服务商|与 Claude 服务商/);
  assert.match(renderer, /Relay 服务商/);
  assert.match(renderer, /provider-edit-panel/);
  assert.match(renderer, /providerModelPickerMarkup/);
  assert.match(renderer, /discoverDraftModels/);
  assert.doesNotMatch(renderer, /providerModelResults|provider-model-results/);
  assert.match(renderer, /provider-toolbar/);
  assert.doesNotMatch(renderer, /provider-page-title|provider-section-heading/);
  assert.doesNotMatch(renderer, /provider-image-panel|providerImageBaseUrl|providerImageApiKey/);
  assert.match(renderer, /<strong>图像候选<\/strong>/);
  assert.doesNotMatch(renderer, /provider-page-desc|providerSearch|provider-filter-row|provider-search/);
  assert.doesNotMatch(renderer, /统一管理 Relay 的对话与图像 API|同一连接可同时提供对话/);
  assert.doesNotMatch(renderer, /这份配置仅供 Relay 使用|支持 Anthropic 兼容接口|由系统安全存储加密保存/);
  assert.doesNotMatch(renderer, /读取列表并自动识别三个已适配图像模型|仅按核心模型名模糊匹配|三档可全部留空/);
  assert.doesNotMatch(renderer, /保存后获取模型|可重新获取模型|未发现 Relay 已适配的图像模型/);
  assert.doesNotMatch(renderer, /Sonnet 档|Opus 档|对话中仍可随时切换|停用后不会出现在快捷切换中/);
  assert.match(renderer, /baseUrl: '',/);
  assert.doesNotMatch(renderer, /api\.anthropic\.com/);
  const providersNav = renderer.match(/<button\b[^>]*data-cat="providers"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(providersNav, 'settings must retain a dedicated providers navigation button');
  assert.match(providersNav[0], /class="sn-ico"/);
  assert.match(providersNav[0], /<svg\b[^>]*aria-hidden="true"/);
  assert.match(providersNav[0], /<span>服务商<\/span>/);
  assert.doesNotMatch(renderer, /data-cat="image"|set-imgBaseUrl|set-imgKey/);
  assert.match(renderer, /const isRouted = editing && !!seed\.routed/);
  assert.match(renderer, /providerChatRouteControlMarkup/);
  assert.doesNotMatch(renderer, /providerRouteBoardMarkup|provider-route-board|data-route-provider/);
  assert.match(renderer, /routeTiers: \[\]/);
  assert.match(renderer, /sessionProviderId/);
  // Provider changes commit in their own editor, so the generic footer must stay hidden.
  const footerFunction = renderer.match(/function updateMainSettingsFooter\([^]*?\n}/);
  assert.ok(footerFunction, 'settings retain their category-aware footer');
  const footerContext = { lastSettingsCat: 'providers', $: () => null,
    btnSettingsSaveEl: { style: {} }, settingsFooterEl: { style: {} } };
  require('node:vm').runInNewContext(footerFunction[0] + '\nupdateMainSettingsFooter();', footerContext);
  assert.equal(footerContext.btnSettingsSaveEl.style.display, 'none');
  assert.equal(footerContext.settingsFooterEl.style.display, 'none');
  assert.doesNotMatch(main, /ipcMain\.handle\('data:read'/);
  assert.doesNotMatch(main, /installer:(?:probe|run|abort|log)|getInstallerResourcesDir|installerChild/);
  assert.match(preload, /providers:\s*\{/);
  assert.match(preload, /providers:discoverDraftModels/);
  assert.doesNotMatch(preload, /activate:\s*\(|setChatRoute|setDefaultModel/);
  assert.match(preload, /setImageRoute/);
  assert.match(preload, /prespawnClaude:[\s\S]*sessionRoute/);
  assert.match(main, /restartRequired: true/);
  assert.match(main, /const resumeAccepted = !!sessionId && !contractChanged && sessionRouteMatchesProvider/);
  const suppliedSessionGate = main.match(/const suppliedSessionId = ([^;]+);/);
  assert.ok(suppliedSessionGate, 'prespawn session acceptance expression must exist');
  assert.equal(suppliedSessionGate[1].replace(/\s+/g, ' ').trim(),
    'contractMatches && opts.sessionId && getConversationWorkspaces().acceptsSession(opts.convId, opts.sessionId) && !opts.workspaceChanged && sessionRouteMatchesProvider(opts.sessionRoute, targetRoute) ? opts.sessionId : null');
  assert.match(renderer, /if \(!conv \|\| !conv\.sessionProviderId \|\| !route \|\| !route\.providerId\) return false/);
  assert.doesNotMatch(preload, /image:setConfig/);
  assert.doesNotMatch(main, /ipcMain\.handle\('image:setConfig'/);
  assert.doesNotMatch(preload, /openMifyKey/);
  assert.doesNotMatch(preload, /installer:(?:probe|run|abort|log)/);
  assert.doesNotMatch(packageJson, /extra-resources/);
  assert.equal(fs.existsSync(path.join(root, 'extra-resources', 'install.ps1')), false);
  assert.doesNotMatch(wizard, /mify|id=["']apiKey|name=["']apiKey|data-key=["']api/i);
  assert.match(wizard, /设置 → 服务商/);
  assert.match(wizard, /在插件中添加技能和工具/);
  assert.doesNotMatch(wizard, /配置环境|正在安装|probeList|installSteps/);
  assert.doesNotMatch(wizardScript, /probe\(|installer\.run|installer\.abort|onLog/);
  assert.doesNotMatch(providerStore, /legacySettingsPath|model\.mify|ppio\/pa\/claude|xiaomi\/mimo/);
});
