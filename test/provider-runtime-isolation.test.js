'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sdkPath = path.join(__dirname, '..', 'claude-sdk.js');
const sdkSource = fs.readFileSync(sdkPath, 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

// Run the actual adapter against an in-memory Query and isolated environment.
// Real child routing, resource loading and reload are covered by the native SDK
// regression; these tests never read a user config or launch a model process.
function harness(inheritedEnv = {}) {
  const calls = [];
  const fixtureSdk = {
    query({ prompt, options }) {
      calls.push(options);
      return {
        async initializationResult() { return {}; },
        close() {},
        async *[Symbol.asyncIterator]() {
          if (typeof prompt === 'string') {
            yield { type: 'result', subtype: 'success', result: 'fixture answer', is_error: false };
            return;
          }
          for await (const input of prompt) {
            yield { type: 'result', subtype: 'success', result: 'fixture answer', is_error: false,
              user_message_uuid: input.uuid, queued_turn_count: 0 };
            return;
          }
        },
      };
    },
  };
  const source = sdkSource.replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  assert.notEqual(source, sdkSource, 'replace only the SDK import');
  const inherited = { ...inheritedEnv };
  const context = vm.createContext({
    fixtureSdk, process: { ...process, env: inherited }, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} },
  });
  const factory = new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath }).runInContext(context);
  const loaded = { exports: {} };
  factory(createRequire(sdkPath), loaded, loaded.exports, path.dirname(sdkPath));
  return { sdk: loaded.exports, calls, inherited };
}

const relayRoute = {
  ANTHROPIC_BASE_URL: 'https://relay.example/anthropic',
  ANTHROPIC_API_KEY: 'fixture-relay-key',
  ANTHROPIC_MODEL: 'vendor/model',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor/model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/model',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor/model',
};

test('host ownership cannot be disabled by inherited or caller environment settings', () => {
  const h = harness({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0', ANTHROPIC_AUTH_TOKEN: 'fixture-other-token' });
  const input = { ...relayRoute, claude_code_provider_managed_by_host: 'false' };
  const env = h.sdk.buildRelayRuntimeEnv(input);
  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
  assert.equal(env.claude_code_provider_managed_by_host, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, relayRoute.ANTHROPIC_API_KEY);
  assert.equal(input.claude_code_provider_managed_by_host, 'false');
  assert.equal(h.inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '0');
});

test('native SDK memory stays disabled despite conflicting inherited and caller environment aliases', () => {
  const inherited = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', claude_code_disable_auto_memory: 'false',
    Claude_Code_Disable_Auto_Memory: '0', UNRELATED_FIXTURE: 'preserved' };
  const h = harness(inherited);
  for (const value of ['0', 'false', '', null, undefined, false, 0, true, 'enabled']) {
    const input = { claude_code_disable_auto_memory: value, Claude_Code_Disable_Auto_Memory: '0' };
    const snapshot = clone(input), env = h.sdk.buildRelayRuntimeEnv(input);
    assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.UNRELATED_FIXTURE, 'preserved');
    assert.deepEqual(clone(input), snapshot);
  }
  assert.deepEqual(h.inherited, inherited);
});

test('inherited transports, credential handles and backend selectors cannot redirect a route', () => {
  const unrelated = {
    ANTHROPIC_API_KEY: 'fixture-other-key', ANTHROPIC_AUTH_TOKEN: 'fixture-other-token',
    ANTHROPIC_BASE_URL: 'https://other.example', ANTHROPIC_UNIX_SOCKET: '/fixture/other.sock',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-other-token',
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '17',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '18', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture/other-auth.json',
    CLAUDE_CODE_HOST_CREDS_FILE: '/fixture/other-host-creds.json',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS: '1000',
    CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
    ANTHROPIC_SMALL_FAST_MODEL: 'other/fast', CLAUDE_CODE_SUBAGENT_MODEL: 'other/agent',
    CLAUDE_CODE_AUTO_MODE_MODEL: 'other/auto', CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'other/classifier',
    CLAUDE_CONTEXT_COLLAPSE_MODEL: 'other/compact',
  };
  const h = harness(unrelated);
  const env = h.sdk.buildRelayRuntimeEnv(relayRoute);
  for (const key of Object.keys(unrelated)) assert.equal(env[key], relayRoute[key], key);
  assert.deepEqual(h.inherited, unrelated, 'never rewrite the application environment');
});

test('case variants, model metadata and dynamically named host credentials do not survive', () => {
  const h = harness({
    anthropic_api_key: 'fixture-lower-key',
    Anthropic_Auth_Token: 'fixture-mixed-token',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'external/fable',
    ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: 'external-metadata',
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: 'external-capabilities',
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'EXTERNAL_HOST_TOKEN',
    external_host_token: 'fixture-host-secret',
  });
  const env = h.sdk.buildRelayRuntimeEnv({ anthropic_api_key: 'fixture-route-key' });
  assert.equal(env.ANTHROPIC_API_KEY, 'fixture-route-key');
  for (const key of Object.keys(h.inherited)) assert.equal(env[key], undefined, key);
  assert.equal(env.CLAUDE_CODE_HOST_AUTH_ENV_VAR, undefined);
});

test('proxy and certificate launch settings and local resource paths are preserved', () => {
  const inherited = {
    HTTPS_PROXY: 'http://127.0.0.1:8888', HTTP_PROXY: 'http://127.0.0.1:8888', NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/fixture/corporate-ca.pem', CLAUDE_CODE_CERT_STORE: 'system',
    CLAUDE_CODE_CLIENT_CERT: '/fixture/client.pem', CLAUDE_CODE_CLIENT_KEY: '/fixture/client-key.pem',
    HOME: '/fixture/home', USERPROFILE: '/fixture/home', CLAUDE_CONFIG_DIR: '/fixture/claude',
    CLAUDE_CODE_PLUGIN_SEED_DIR: '/fixture/plugins', CLAUDE_CODE_GIT_BASH_PATH: '/fixture/bash',
    PATH: '/fixture/bin', TOOL_ACCESS_TOKEN: 'fixture-mcp-token',
  };
  const h = harness(inherited);
  const env = h.sdk.buildRelayRuntimeEnv(relayRoute);
  for (const [key, value] of Object.entries(inherited)) assert.equal(env[key], value, key);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, 'do not introduce a certificate-check bypass');
});

test('each query gets an independent auth and model environment', () => {
  const h = harness({ ANTHROPIC_API_KEY: 'fixture-shell-key' });
  const first = h.sdk.buildRelayRuntimeEnv(relayRoute);
  const second = h.sdk.buildRelayRuntimeEnv({
    ANTHROPIC_BASE_URL: 'https://second.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'fixture-second-token',
    ANTHROPIC_MODEL: 'second/model',
  });
  assert.equal(second.ANTHROPIC_API_KEY, undefined);
  assert.equal(second.ANTHROPIC_AUTH_TOKEN, 'fixture-second-token');
  assert.equal(second.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(first.ANTHROPIC_BASE_URL, relayRoute.ANTHROPIC_BASE_URL);
  assert.equal(first.ANTHROPIC_MODEL, relayRoute.ANTHROPIC_MODEL);
});

test('provider protection keeps user resources, MCP, permission policy and resume options', () => {
  const h = harness({ CLAUDE_CONFIG_DIR: '/fixture/user-config' });
  const servers = { docs: { command: 'fixture-mcp', args: ['--stdio'] } };
  const options = h.sdk._buildOptions({
    cwd: '/fixture/project', memoryDir: '/fixture/memory', validWorkingDir: '/fixture/other',
    model: relayRoute.ANTHROPIC_MODEL, sessionId: 'fixture-existing-history', runtimeEnv: relayRoute,
    mcpServers: servers, permissionMode: 'default', tools: ['Read'],
  }, {});
  assert.deepEqual(clone(options.settingSources), ['user']);
  assert.deepEqual(clone(options.mcpServers), servers);
  assert.equal(options.resume, 'fixture-existing-history');
  assert.equal(options.cwd, '/fixture/project');
  assert.deepEqual(clone(options.additionalDirectories), ['/fixture/memory', '/fixture/other']);
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(clone(options.tools), ['Read']);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/fixture/user-config');
  assert.equal(options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
  assert.deepEqual(clone(options.settings), {
    enforceAvailableModels: false, fallbackModel: [], availableModels: ['vendor/model'],
    modelOverrides: { 'vendor/model': 'vendor/model' },
    autoMemoryEnabled: false, autoDreamEnabled: false,
  });
  assert.equal(JSON.stringify(options.settings).includes(relayRoute.ANTHROPIC_API_KEY), false);
});

test('live, one-shot and lightweight generation reject stale SDK memory options and preserve model policy', async () => {
  const h = harness({ ANTHROPIC_AUTH_TOKEN: 'fixture-unrelated-token', CLAUDE_CODE_USE_GATEWAY: '1' });
  const runtimePolicy = { settings: { autoMemoryEnabled: true, autoDreamEnabled: true, autoMemoryDirectory: '/fixture/retired-sdk-memory', alwaysThinkingEnabled: true } };
  const snapshot = clone(runtimePolicy);
  const parameters = { cwd: '/fixture/project', model: relayRoute.ANTHROPIC_MODEL, runtimeEnv: { ...relayRoute, claude_code_disable_auto_memory: '0' }, runtimePolicy };
  assert.equal(await h.sdk.runText({ ...parameters, prompt: 'fixture input', tools: [] }), 'fixture answer');
  const oneShotDone = new Promise(resolve => h.sdk.runOneShot({
    ...parameters, prompt: 'fixture input', onEvent: event => { if (event.type === 'job-done') resolve(event); },
  }));
  assert.equal((await oneShotDone).exitCode, 0);
  let session;
  const liveDone = new Promise(resolve => {
    session = h.sdk.createLiveSession({ ...parameters, sessionId: 'fixture-existing-history', onMessage() {}, onExit: resolve });
  });
  session.push('fixture input', { uuid: 'fixture-user-input' });
  assert.equal(await liveDone, 0);
  assert.equal(h.calls.length, 3);
  for (const options of h.calls) {
    assert.equal(options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
    assert.equal(options.env.ANTHROPIC_BASE_URL, relayRoute.ANTHROPIC_BASE_URL);
    assert.equal(options.env.ANTHROPIC_API_KEY, relayRoute.ANTHROPIC_API_KEY);
    assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(options.env.CLAUDE_CODE_USE_GATEWAY, undefined);
    assert.deepEqual(clone(options.settings), { ...clone(h.sdk.buildRelayModelSettings(parameters.model, relayRoute)), alwaysThinkingEnabled: true, autoMemoryEnabled: false, autoDreamEnabled: false });
    assert.equal(Object.hasOwn(options.settings, 'autoMemoryDirectory'), false);
    assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(options.env.claude_code_disable_auto_memory, undefined);
    assert.deepEqual(runtimePolicy, snapshot);
    assert.deepEqual(clone(options.settingSources), ['user']);
    const { env, ...nonEnvironmentOptions } = options;
    assert.equal(JSON.stringify(nonEnvironmentOptions).includes(relayRoute.ANTHROPIC_API_KEY), false);
  }
});

test('lightweight text defaults to no built-in tools while preserving the explicit review whitelist and guard', async () => {
  const h = harness(), parameters = { cwd: '/fixture/project', prompt: 'fixture title', runtimeEnv: relayRoute };
  let prepared = 0;
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async options => {
    prepared++;
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(Object.keys(options.mcpServers), []);
    return options;
  } });
  await h.sdk.runText(parameters);
  assert.deepEqual(clone(h.calls[0].tools), []);
  const reviewTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  const guard = async () => ({ behavior: 'deny', message: 'fixture outside staging' });
  await h.sdk.runText({ ...parameters, tools: reviewTools, canUseTool: guard });
  assert.deepEqual(clone(h.calls[1].tools), reviewTools);
  assert.equal(h.calls[1].canUseTool, guard);
  assert.equal(prepared, 2);
  for (const options of h.calls) {
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(Object.keys(options.mcpServers), []);
  }
  assert.equal(h.calls[0].settings.autoMemoryEnabled, false);
  assert.equal(h.calls[1].settings.autoMemoryEnabled, false);
});

test('model settings preserve all route IDs, namespaces and context suffixes without copying credentials', () => {
  const h = harness({ ANTHROPIC_MODEL: 'unrelated/inherited-model' });
  const route = {
    anthropic_model: ' vendor/model[1m] ', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/model[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast/model',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'special/model', ANTHROPIC_SMALL_FAST_MODEL: 'small/model',
    ANTHROPIC_API_KEY: 'fixture-secret', ANTHROPIC_AUTH_TOKEN: 'fixture-bearer',
    ANTHROPIC_BASE_URL: 'https://fixture.example', ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: 'fixture-metadata',
  };
  const settings = clone(h.sdk.buildRelayModelSettings(' primary/model ', route));
  assert.deepEqual(settings.availableModels, ['primary/model', 'vendor/model[1m]', 'claude-opus-4-6[1m]', 'fast/model', 'special/model', 'small/model']);
  for (const id of settings.availableModels) assert.equal(settings.modelOverrides[id], id);
  assert.equal(settings.modelOverrides['vendor/model'], 'vendor/model');
  assert.equal(settings.modelOverrides['claude-opus-4-6'], 'claude-opus-4-6');
  assert.equal(settings.enforceAvailableModels, false);
  assert.deepEqual(settings.fallbackModel, []);
  const encoded = JSON.stringify(settings);
  for (const hidden of ['fixture-secret', 'fixture-bearer', 'https://fixture.example', 'fixture-metadata', 'unrelated/inherited-model']) assert.equal(encoded.includes(hidden), false);
  assert.equal(route.anthropic_model, ' vendor/model[1m] ', 'never mutate the provider snapshot');
});

test('an unspecified model does not create an empty model allowlist', () => {
  const h = harness();
  assert.deepEqual(clone(h.sdk.buildRelayModelSettings(undefined)), { enforceAvailableModels: false, fallbackModel: [] });
});
