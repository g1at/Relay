'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _buildOptions } = require('../src/main/sdk/claude-sdk');

test('ordinary host-routed models retain task tools without adding permission allow rules', () => {
  const options = _buildOptions({ model: 'third-party-model', permissionMode: 'default', runtimeEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: undefined } }, {});
  assert.equal(options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1');
  assert.equal(options.tools, undefined);
  assert.equal(options.allowedTools, undefined);
  assert.equal(options.permissionMode, 'default');
});

test('explicit tool restrictions and task-tool environment opt-out survive the upgrade', () => {
  for (const tools of [[], ['Read']]) {
    const options = _buildOptions({ tools, runtimeEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: undefined } }, {});
    assert.deepEqual(options.tools, tools);
    assert.equal(options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, undefined);
  }
  const restricted = _buildOptions({ runtimePolicy: { options: { tools: [] } }, runtimeEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: undefined } }, {});
  assert.deepEqual(restricted.tools, []);
  assert.equal(restricted.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, undefined);
  const optedOut = _buildOptions({ runtimeEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' } }, {});
  assert.equal(optedOut.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '0');
});
