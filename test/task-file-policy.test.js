'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskFileInstructions, outsideLinks, createTaskFilePolicy } = require('../task-file-policy');
const { _buildOptions: buildOptions } = require('../claude-sdk');

const cwd = 'D:\\Cybersecurity\\SRC';
const scratchDir = 'C:\\Relay Data\\conversation-scratch\\session';
const output = 'C:\\Users\\tester\\Desktop\\安卓报告\\报告 (最终).md';
const answer = `[报告](<${output}>)`;
async function invoke(options, event, input, context = {}) {
  const results = [];
  for (const group of options.hooks[event] || []) for (const hook of group.hooks) {
    results.push(await hook({ hook_event_name: event, ...input }, 'fixture-tool', context));
  }
  return results;
}

test('current project instructions distinguish deliverables, temporary output, sources and user destinations', () => {
  const instructions = taskFileInstructions(cwd, scratchDir);
  assert.ok(instructions.includes(JSON.stringify(cwd)));
  assert.match(instructions, /不要默认保存到桌面/);
  assert.match(instructions, /先复制到交付目录，核实文件存在/);
  assert.match(instructions, /用户明确指定的其他输出位置仍以用户要求为准/);
  assert.match(instructions, /已有输入文件、源码、参考资料无需搬迁或删除/);
  assert.match(instructions, /不是硬沙箱/);
  assert.equal(taskFileInstructions(cwd), '');
});

test('ordinary Agent and legacy Task receive global and file context in one update without losing arguments', async () => {
  const options = buildOptions({ cwd, scratchDir, runtimePolicy: { relayInstructions: 'Use Chinese.' }, permissionMode: 'default' });
  for (const tool_name of ['Agent', 'Task']) {
    const original = { prompt: 'Write the report.', subagent_type: 'general-purpose', run_in_background: true, resume: 'child-session', name: 'writer' };
    const updates = (await invoke(options, 'PreToolUse', { tool_name, tool_input: original })).filter(r => r.hookSpecificOutput?.updatedInput);
    assert.equal(updates.length, 1);
    const updated = updates[0].hookSpecificOutput.updatedInput;
    assert.match(updated.prompt, /Use Chinese/); assert.ok(updated.prompt.includes(JSON.stringify(cwd)));
    assert.equal(updated.prompt.endsWith(original.prompt), true);
    assert.deepEqual({ ...updated, prompt: original.prompt }, original);
    assert.equal((await invoke(options, 'PreToolUse', { tool_name, tool_input: updated })).filter(r => r.hookSpecificOutput?.updatedInput).length, 0);
    assert.equal(original.prompt, 'Write the report.');
  }
  assert.equal((await invoke(options, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'input.txt' } })).filter(r => r.hookSpecificOutput?.updatedInput).length, 0);
  assert.equal(options.permissionMode, 'default');
});

test('subagents receive file locations even with no global preferences or selected native Agent', async () => {
  const options = buildOptions({ cwd, scratchDir });
  const results = await invoke(options, 'PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'Create report' } });
  assert.equal(results.filter(r => r.hookSpecificOutput?.updatedInput?.prompt.includes(JSON.stringify(cwd))).length, 1);
});

test('file context does not weaken existing plan-mode permission denial', async () => {
  const options = buildOptions({ cwd, scratchDir, executionMode: { kind: 'plan' }, permissionMode: 'bypassPermissions' });
  const results = await invoke(options, 'PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'Create report' } });
  assert.ok(results.some(r => r.hookSpecificOutput?.permissionDecision === 'deny'));
  assert.ok(results.every(r => r.hookSpecificOutput?.permissionDecision !== 'allow'));
  assert.equal(options.permissionMode, 'plan');
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer }), [{}]);
});

test('UserPromptSubmit refreshes file context on resumed and repeated live turns', async () => {
  const options = buildOptions({ cwd, scratchDir, sessionId: 'existing-session' });
  assert.equal(options.resume, 'existing-session');
  for (const prompt of ['Continue', 'Create another report']) {
    const results = await invoke(options, 'UserPromptSubmit', { prompt });
    assert.equal(results.length, 1);
    assert.ok(results[0].hookSpecificOutput.additionalContext.includes(JSON.stringify(cwd)));
    assert.equal(results[0].hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  }
});

test('completion uses Markdown links including references and Chinese parenthesized paths, excluding code and URLs', () => {
  const message = `${answer}\n\n[引用][result]\n\n[result]: <C:/outside/源 文件.md>\n\n` +
    '`[sample](C:/outside/sample.md)`\n\n```md\n[code](C:/outside/code.md)\n```\n\n[web](https://example.test/file.md)';
  assert.deepEqual(outsideLinks(message, cwd, scratchDir), [output, 'C:/outside/源 文件.md']);
  assert.deepEqual(outsideLinks('[报告](<D:/Cybersecurity/SRC/report.md>)\n[scratch](<C:/Relay Data/conversation-scratch/session/input.txt>)', cwd, scratchDir), []);
});

test('Windows and WSL drive paths resolve to the same selected project without sibling-prefix leaks', () => {
  const message = '[a](<d:/CYBERSECURITY/src/报告.md>) [b](/mnt/d/Cybersecurity/SRC/a.md) [c](./报告.md)';
  assert.deepEqual(outsideLinks(message, cwd, scratchDir), []);
  assert.deepEqual(outsideLinks(message, '/mnt/d/Cybersecurity/SRC', '/mnt/c/Relay Data/conversation-scratch/session'), []);
  assert.deepEqual(outsideLinks('[sibling](D:/Cybersecurity/SRC-old/a.md) [parent](../outside.md)', cwd, scratchDir), ['D:/Cybersecurity/SRC-old/a.md', '../outside.md']);
});

test('completion review blocks once per prompt and preserves explicit user and source exemptions in feedback', async () => {
  const options = buildOptions({ cwd, scratchDir });
  const input = { prompt_id: 'turn-one', stop_hook_active: false, last_assistant_message: answer };
  const [first] = await invoke(options, 'Stop', input);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /本轮新生成/); assert.match(first.reason, /核实副本存在后更新最终链接/);
  assert.match(first.reason, /用户已明确要求保存到该外部位置，保留原链接即可/);
  assert.match(first.reason, /已有源码、输入文件或参考资料/);
  assert.match(first.reason, /不移动或删除原件/);
  assert.deepEqual(await invoke(options, 'Stop', input), [{}]);
  assert.deepEqual(await invoke(options, 'Stop', { ...input, prompt_id: 'turn-two', stop_hook_active: true }), [{}]);
  assert.equal((await invoke(options, 'Stop', { ...input, prompt_id: 'turn-two' }))[0].decision, 'block');
});

test('scratch output receives the same conditional review before it is used as a final deliverable', async () => {
  const options = buildOptions({ cwd, scratchDir });
  const [result] = await invoke(options, 'Stop', { last_assistant_message: `[report](<${scratchDir}\\report.md>)` });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /scratch 仅是过程文件目录/);
});

test('fallback turn bound resets only for a root user or SDK prompt and skips child completion', async () => {
  const options = buildOptions({ cwd, scratchDir });
  assert.equal((await invoke(options, 'Stop', { last_assistant_message: answer }))[0].decision, 'block');
  await invoke(options, 'UserPromptSubmit', { prompt: 'subagent', agent_id: 'child' });
  await invoke(options, 'UserPromptSubmit', { prompt: 'notification', source: 'system' });
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer }), [{}]);
  await invoke(options, 'UserPromptSubmit', { prompt: 'next turn', source: 'sdk' });
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer, agent_id: 'child' }), [{}]);
  assert.equal((await invoke(options, 'Stop', { last_assistant_message: answer }))[0].decision, 'block');
});

test('plan changes and abort signals suppress completion repair', async () => {
  let mode = { kind: 'default' };
  const controller = new AbortController();
  const options = buildOptions({ cwd, scratchDir, executionModeState: () => mode, abortController: controller });
  mode = { kind: 'plan' };
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer }), [{}]);
  mode = { kind: 'default' };
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer, permission_mode: 'plan' }), [{}]);
  const hookAbort = new AbortController(); hookAbort.abort();
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer }, { signal: hookAbort.signal }), [{}]);
  controller.abort();
  assert.deepEqual(await invoke(options, 'Stop', { last_assistant_message: answer }), [{}]);
  assert.deepEqual(await invoke(options, 'UserPromptSubmit', { prompt: 'next turn' }), [{}]);
});

test('prepared WSL location remains authoritative even after a tool reports a different cwd', async () => {
  const policy = createTaskFilePolicy({ cwd, scratchDir });
  policy.prepare({ cwd: '/mnt/d/Cybersecurity/SRC', scratchDir: '/mnt/c/Relay Data/conversation-scratch/session' });
  const delegated = await policy.delegate({ cwd: '/home/user', tool_name: 'Agent', tool_input: { prompt: 'Create file' } });
  assert.match(delegated.hookSpecificOutput.updatedInput.prompt, /\/mnt\/d\/Cybersecurity\/SRC/);
  assert.equal(delegated.hookSpecificOutput.updatedInput.prompt.includes(JSON.stringify(cwd)), false);
  const submitted = await policy.submit({ cwd: '/home/user', prompt: 'Continue' });
  assert.match(submitted.hookSpecificOutput.additionalContext, /\/mnt\/c\/Relay Data/);
  assert.deepEqual(await policy.stop({ cwd: '/home/user', last_assistant_message: '[file](D:/Cybersecurity/SRC/file.md)' }), {});
  assert.equal((await policy.stop({ cwd: '/home/user', last_assistant_message: answer })).decision, 'block');
});

test('completion review is bounded and does nothing for a response without local deliverable links', async () => {
  assert.equal(outsideLinks(Array.from({ length: 20 }, (_, i) => `[file](/outside/${i}.md)`).join('\n'), '/project', '/scratch').length, 8);
  assert.deepEqual(outsideLinks('x'.repeat(256 * 1024 + 1) + answer, cwd, scratchDir), []);
  const policy = createTaskFilePolicy({ cwd, scratchDir });
  assert.deepEqual(await policy.stop({ last_assistant_message: 'Done.' }), {});
  assert.deepEqual(await policy.stop({ last_assistant_message: '[file](D:/Cybersecurity/SRC/file.md)' }), {});
});
