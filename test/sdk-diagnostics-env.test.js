'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRelayRuntimeEnv, _buildOptions } = require('../src/main/sdk/claude-sdk');

test('startup diagnostic results use one host-owned environment key without mutating the caller', () => {
  const names = ['CLAUDE_CODE_STARTUP_FAILURE_RESULTS', 'claude_code_startup_failure_results'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env[names[0]] = '0'; process.env[names[1]] = 'false';
    // Windows process.env treats these names as the same key; Unix does not.
    const inherited = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const input = { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '0', claude_code_startup_failure_results: '',
      ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:2', RELAY_TEST_UNRELATED: 'keep' };
    const before = { ...input };
    const env = buildRelayRuntimeEnv(input);
    assert.deepEqual(Object.keys(env).filter(name => name.toUpperCase() === names[0]), [names[0]]);
    assert.equal(env[names[0]], '1');
    assert.equal(env.ANTHROPIC_API_KEY, 'fixture-key');
    assert.equal(env.HTTPS_PROXY, input.HTTPS_PROXY);
    assert.equal(env.RELAY_TEST_UNRELATED, 'keep');
    assert.deepEqual(input, before);
    for (const name of names) assert.equal(process.env[name], inherited[name]);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
  }
});

test('query options enable structured startup failures independently of optional debug logging', () => {
  const options = _buildOptions({ cwd: process.cwd(), model: 'fixture-model', permissionMode: 'default',
    runtimePolicy: { settingSources: [], diagnostics: false }, includeRelayInstructions: false }, {});
  assert.equal(options.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, '1');
  assert.notEqual(options.debug, true);
  assert.deepEqual(options.settingSources, []);
});
