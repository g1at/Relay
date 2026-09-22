'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRuntimePolicy, buildRuntimePolicy, createRuntimeDiagnostics, summarizeInstructionsLoaded } = require('../src/main/sdk/sdk-runtime-policy');

test('defaults explicitly retain Relay memory without automatic SDK writes or project settings', () => {
  const input = { model: 'provider-secret-model', alwaysThinking: false, updatedAt: 'unchanged' };
  const snapshot = JSON.stringify(input);
  const policy = buildRuntimePolicy({ settings: input, memoryDir: '/fixture/.claude/relay-memory' });
  assert.deepEqual(policy.settingSources, ['user']);
  assert.deepEqual(policy.settings, { autoMemoryEnabled: false, autoDreamEnabled: false });
  assert.equal(policy.summary.relayHistoryRetained, true);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(Object.hasOwn(policy.settings, 'model'), false);
  assert.equal(Object.hasOwn(policy.settings, 'alwaysThinkingEnabled'), false);
});
test('project and local settings require explicit trust and a valid project root', () => {
  const settings = { sdkSettingSources: 'local', sdkTrustedProjectIds: ['p1'] };
  for (const args of [{}, { projectId: 'p2', projectRoot: '/fixture' }, { projectId: 'p1', projectRoot: 'relative' }]) {
    assert.deepEqual(buildRuntimePolicy({ settings, ...args }).settingSources, ['user']);
  }
  const args = { settings, projectId: 'p1', projectRoot: '/fixture' };
  assert.deepEqual(buildRuntimePolicy(args).settingSources, ['user', 'project', 'local']);
  assert.deepEqual(buildRuntimePolicy({ ...args, settings: { ...settings, sdkSettingSources: 'project' } }).settingSources, ['user', 'project']);
  assert.notEqual(buildRuntimePolicy(args).fingerprint, buildRuntimePolicy({ ...args, settings: { ...settings, sdkTrustedProjectIds: [] } }).fingerprint);
  assert.equal(buildRuntimePolicy(args).fingerprint, buildRuntimePolicy(JSON.parse(JSON.stringify(args))).fingerprint);
});
test('legacy and malformed SDK memory preferences cannot restore native memory in native or WSL sessions', () => {
  const legacyValues = ['isolated-sdk', 'enabled', 'relay', 'unknown', true, false, null, 1, {}, []];
  const dreamValues = [true, false, 'enabled', 'true', null, 1, {}, []];
  for (const environment of ['native', 'wsl']) {
    const args = { projectId: 'p1', projectRoot: 'D:/Work', memoryDir: 'C:/Users/fixture/.claude/relay-memory', environment,
      mapPath: () => { throw Error('Retired SDK memory must never request path mapping'); } };
    const baseline = buildRuntimePolicy(args);
    for (const sdkMemoryMode of legacyValues) for (const sdkAutoDreamEnabled of dreamValues) {
      const settings = { sdkMemoryMode, sdkAutoDreamEnabled }, snapshot = JSON.stringify(settings);
      const policy = buildRuntimePolicy({ ...args, settings });
      assert.deepEqual(policy.settings, { autoMemoryEnabled: false, autoDreamEnabled: false });
      assert.equal(Object.hasOwn(policy.settings, 'autoMemoryDirectory'), false);
      assert.equal(policy.summary.memoryMode, 'relay');
      assert.equal(policy.summary.autoDreamEnabled, false);
      assert.equal(policy.fingerprint, baseline.fingerprint);
      assert.equal(JSON.stringify(settings), snapshot);
    }
    assert.deepEqual(buildRuntimePolicy({ ...args, mapPath: undefined, settings: { sdkMemoryMode: 'isolated-sdk', sdkAutoDreamEnabled: true } }).settings,
      { autoMemoryEnabled: false, autoDreamEnabled: false });
  }
});
test('policy normalization retires retention and native memory while retaining project trust', () => {
  assert.equal(normalizeRuntimePolicy({ sdkCleanupPeriodDays: 0 }).sdkCleanupPeriodDays, null);
  assert.equal(normalizeRuntimePolicy({ sdkCleanupPeriodDays: 365 }).sdkCleanupPeriodDays, null);
  assert.equal(normalizeRuntimePolicy({ sdkAutoDreamEnabled: true }).sdkAutoDreamEnabled, false);
  assert.equal(normalizeRuntimePolicy({ sdkMemoryMode: 'isolated-sdk', sdkAutoDreamEnabled: true }).sdkMemoryMode, 'relay');
  assert.deepEqual(normalizeRuntimePolicy({ sdkTrustedProjectIds: ['p1', 'p1', '../../bad', null] }).sdkTrustedProjectIds, ['p1']);
});
test('diagnostics use SDK trust filtering but never expose credentials, commands, paths or arbitrary values', async () => {
  let requested;
  const secret = 'SECRET_fixture_key';
  const raw = { effective: { model: secret, env: { TOKEN: secret }, disableAllHooks: true, policyHelper: 'execute ' + secret, permissions: { defaultMode: 'bypassPermissions', allow: [secret] } },
    provenance: { model: { source: 'user' } }, sources: [{ source: 'project', path: 'C:\\Users\\' + secret + '\\settings.json', settings: { env: { TOKEN: secret }, permissions: { defaultMode: 'bypassPermissions' }, unknownSecretKey: secret } }] };
  const service = createRuntimeDiagnostics({ resolveSettings: async args => { requested = args; return raw; }, filterEscalatingDefaultMode: value => { assert.equal(value, raw); return { model: secret, env: value.effective.env, disableAllHooks: true, permissions: {} }; } });
  service.recordInstructions({ file_path: '/secret/customer/file-' + secret, memory_type: 'Project', load_reason: 'include', parent_file_path: secret, globs: [secret] });
  const result = await service.inspect({ cwd: '/fixture', settingSources: ['user', 'project'], injectedEnv: secret });
  assert.equal(result.ok, true);
  assert.equal(result.filteredProjectEscalation, true);
  assert.equal(result.policyHelperDetected, true);
  assert.equal(result.hooksDisabled, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(requested, { cwd: '/fixture', settingSources: ['user', 'project'] });
  assert.equal(raw.effective.permissions.defaultMode, 'bypassPermissions');
});
test('WSL diagnostics refuse to substitute the Windows host sources', async () => {
  let calls = 0;
  const service = createRuntimeDiagnostics({ resolveSettings: async () => { calls++; return {}; }, filterEscalatingDefaultMode: () => ({}) });
  assert.equal((await service.inspect({ environment: 'wsl' })).code, 'DIAGNOSTICS_ENVIRONMENT_UNAVAILABLE');
  assert.equal(calls, 0);
});
test('instruction summaries are bounded, deduplicated, and sanitize unexpected metadata', () => {
  const service = createRuntimeDiagnostics({ maxInstructions: 2 });
  for (let i = 0; i < 4; i++) service.recordInstructions({ file_path: '/private/CLAUDE.md', memory_type: 'User', load_reason: 'include' });
  assert.equal(service.getInstructions().length, 1);
  assert.deepEqual(summarizeInstructionsLoaded({ file_path: '/customer/secret.md', memory_type: 'private', load_reason: 'secret' }), { file: '其他文件', source: 'Unknown', reason: 'unknown', hasPathFilter: false, hasParent: false });
});
