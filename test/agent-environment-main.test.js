'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function declaration(name) {
  const from = source.indexOf('function ' + name + '('); assert.ok(from >= 0);
  const rest = source.slice(from), next = /\n(?:async )?function \w+\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
function fixture() {
  const settings = { agentEnvironment: 'native' };
  const context = { readAppSettings: () => ({ ...settings }), relayModelTier: () => 'haiku',
    RELAY_MODEL_TIERS: new Set(['haiku', 'sonnet', 'opus']), relayGitBashPath: () => '',
    providerStore: { getChatRuntime: () => ({ id: 'provider', revision: 3, tier: 'haiku', modelId: 'configured-model', env: { ANTHROPIC_API_KEY: 'dummy', RELAY_AGENT_ENVIRONMENT: 'foreign' } }) },
  };
  vm.createContext(context);
  for (const name of ['activeRelayProviderRuntime', 'providerSessionRoute', 'sessionRouteMatchesProvider', 'sessionFingerprint']) vm.runInContext(declaration(name), context);
  return { context, settings };
}
test('real provider launch snapshot pins host-selected environment despite subsequent setting changes', () => {
  const f = fixture(), native = f.context.activeRelayProviderRuntime();
  assert.equal(native.env.RELAY_AGENT_ENVIRONMENT, 'native');
  f.settings.agentEnvironment = 'wsl'; const wsl = f.context.activeRelayProviderRuntime();
  assert.equal(native.agentEnvironment, 'native'); assert.equal(native.env.RELAY_AGENT_ENVIRONMENT, 'native');
  assert.equal(wsl.env.RELAY_AGENT_ENVIRONMENT, 'wsl');
  assert.notEqual(f.context.sessionFingerprint({ providerRuntime: native }), f.context.sessionFingerprint({ providerRuntime: wsl }));
});
test('real session route only resumes the matching runtime; legacy unmarked history is native', () => {
  const f = fixture(), native = f.context.providerSessionRoute(f.context.activeRelayProviderRuntime());
  const legacy = { providerId: 'provider', providerRevision: 3, routeTier: 'haiku' };
  assert.equal(f.context.sessionRouteMatchesProvider(legacy, native), true);
  f.settings.agentEnvironment = 'wsl'; const wsl = f.context.providerSessionRoute(f.context.activeRelayProviderRuntime());
  assert.equal(f.context.sessionRouteMatchesProvider(legacy, wsl), false);
  assert.equal(f.context.sessionRouteMatchesProvider(native, wsl), false);
  assert.equal(f.context.sessionRouteMatchesProvider(wsl, { ...wsl }), true);
});
