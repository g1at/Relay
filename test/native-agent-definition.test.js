'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAgentDocument, buildNativeAgent, loadNativeAgent } = require('../native-agent-definition');

const text = `---
name: test-agent
description: >-
  Review the code
  and report findings.
tools: [Read, "Bash(git diff:*)"]
disallowedTools:
  - Write
skills: [code-review]
maxTurns: 20
model: inherit
permissionMode: bypassPermissions
memory: user
hooks: { SessionStart: dangerous-command }
initialPrompt: /dangerous-command
---
You review the user's code.
`;
test('YAML supports folded descriptions, quoted arrays and block lists without losing the body', () => {
  const parsed = parseAgentDocument('\uFEFF' + text.replace(/\n/g, '\r\n'));
  assert.equal(parsed.description, 'Review the code and report findings.');
  assert.deepEqual(parsed.metadata.tools, ['Read', 'Bash(git diff:*)']);
  assert.equal(parsed.prompt, "You review the user's code.");
});
test('native Agent uses the selected provider model and preserves host policy/resource instructions', () => {
  const result = buildNativeAgent({ text, selectedModel: 'configured/model', effort: 'high', resourceRoot: '/fixture/agent-resources', parentInstructions: 'Respect Relay plan and memory rules.', inheritedDisallowedTools: ['AskUserQuestion'] });
  const agent = result.agents[result.agent];
  assert.equal(result.agent, 'test-agent');
  assert.equal(agent.model, 'inherit');
  assert.equal(agent.effort, 'high');
  assert.deepEqual(agent.disallowedTools, ['Write', 'AskUserQuestion']);
  assert.match(agent.prompt, /Respect Relay plan and memory rules/);
  assert.match(agent.prompt, /\/fixture\/agent-resources/);
  for (const field of ['permissionMode', 'memory', 'hooks', 'initialPrompt']) {
    assert.equal(Object.hasOwn(agent, field), false);
    assert.equal(result.ignoredFields.includes(field), true);
  }
  assert.notEqual(result.fingerprint, buildNativeAgent({ text, selectedModel: 'other/model' }).fingerprint);
});
test('agent content and route fingerprints prevent unsafe reuse after import changes', () => {
  const first = buildNativeAgent({ text, selectedModel: 'selected/model' });
  assert.equal(first.fingerprint, buildNativeAgent({ text, selectedModel: 'selected/model' }).fingerprint);
  assert.notEqual(first.fingerprint, buildNativeAgent({ text: text + '\nAdditional instruction', selectedModel: 'selected/model' }).fingerprint);
});
test('legacy comma tool lists, plain markdown and prompt frontmatter are supported', () => {
  const agent = buildNativeAgent({ text: '---\nname: legacy\ntools: Read, Bash(git diff:*), Grep\nprompt: "Do the task."\n---\n' });
  assert.deepEqual(agent.agents.legacy.tools, ['Read', 'Bash(git diff:*)', 'Grep']);
  assert.equal(agent.agents.legacy.prompt, 'Do the task.');
  assert.equal(parseAgentDocument('Only instructions.', 'filename').name, 'filename');
});
test('malformed and dangerous YAML forms report actionable errors instead of silently changing execution', () => {
  for (const front of ['name: bad\nname: duplicate', 'name: !!js/function function(){}', '- array\n- root']) {
    assert.throws(() => parseAgentDocument('---\n' + front + '\n---\nDo work', 'fallback'), error => error.code === 'INVALID_AGENT_FRONTMATTER');
  }
  assert.throws(() => parseAgentDocument('---\nname: missing close'), /分隔线/);
  assert.throws(() => parseAgentDocument('---\nname: __proto__\n---\nBody'), /名称/);
  assert.throws(() => buildNativeAgent({ text: '---\nname: wrong\ntools: { exec: bad }\n---\nBody' }), /名称列表/);
});
test('loading resolves frontmatter names rather than assuming filenames and rejects ambiguous duplicates', t => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-policy-'));
  t.after(() => fs.rmSync(agentsDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentsDir, 'different-file.md'), text);
  assert.equal(loadNativeAgent({ agentsDir, agentName: 'test-agent', selectedModel: 'selected/model' }).agent, 'test-agent');
  assert.equal(loadNativeAgent({ agentsDir, agentName: 'different-file', selectedModel: 'selected/model' }).agent, 'test-agent');
  assert.throws(() => loadNativeAgent({ agentsDir, agentName: '../outside' }), /找不到/);
  fs.writeFileSync(path.join(agentsDir, 'duplicate.md'), text);
  assert.throws(() => loadNativeAgent({ agentsDir, agentName: 'test-agent' }), error => error.code === 'DUPLICATE_AGENT_NAME');
});
