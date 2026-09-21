'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, result, full, stream } = require('./renderer-activity-harness.cjs');

test('native reset clears only the owning conversation goal/context even with settings covering the chat', () => {
  for (const kind of ['goal', 'plan']) {
    const h = harness(), refreshed = [];
    Object.assign(h.context, { currentExecutionMode: { kind }, permissionModeEditRevision: 0,
      contextUsageByConv: new Map([['conv', { totalTokens: 99 }], ['other', { totalTokens: 5 }]]),
      contextUsageReadRevisions: new Map([['conv', 10]]),
      refreshComposerPermission: async () => { refreshed.push('permission'); }, getProjectComposer: () => ({ sync() {} }) });
    Object.assign(h.conv, { sessionId: 'old', executionMode: { kind }, goalRecovery: { condition: 'old' }, contextUsage: { totalTokens: 99 } });
    Object.assign(h.conv.turns[0], { runId: 'job', executionMode: { kind }, contextUsage: { totalTokens: 99 } });
    h.run.turn.executionMode = { kind }; h.run.turn.contextUsage = { totalTokens: 99 };
    h.send(full('old', 'history remains'));
    const event = { type: 'conversation_reset', new_conversation_id: 'new', uuid: 'reset', session_id: 'old' };
    h.send(event); h.send(event);
    assert.equal(h.context.currentSessionId, 'new'); assert.equal(h.conv.sessionId, 'new');
    assert.equal(h.context.contextUsageByConv.has('conv'), false); assert.equal(h.context.contextUsageByConv.has('other'), true);
    assert.equal(h.context.contextUsageReadRevisions.get('conv'), 11);
    assert.equal(h.conv.contextUsage, undefined); assert.equal(h.conv.turns[0].contextUsage, undefined);
    const expectedMode = kind === 'goal' ? 'default' : 'plan';
    assert.equal(h.conv.executionMode.kind, expectedMode); assert.equal(h.run.turn.executionMode.kind, expectedMode);
    assert.equal(h.conv.turns[0].executionMode.kind, expectedMode); assert.equal(h.context.currentExecutionMode.kind, expectedMode);
    assert.equal(h.run.outputState.messages[0].blocks[0].text, 'history remains'); assert.equal(refreshed.length, 1);
    h.send({ ...event, uuid: 'child-reset', agent_id: 'child', new_conversation_id: 'child' });
    assert.equal(h.context.currentSessionId, 'new');
  }
});

test('native reset of a background conversation leaves another conversation composer and context untouched', () => {
  const h = harness();
  h.context.currentConv = { id: 'other', executionMode: { kind: 'goal' }, sessionId: 'other-session' };
  Object.assign(h.context, { currentSessionId: 'other-session', currentExecutionMode: { kind: 'goal' },
    contextUsageByConv: new Map([['conv', { totalTokens: 99 }], ['other', { totalTokens: 5 }]]), contextUsageReadRevisions: new Map() });
  h.run.turn.executionMode = { kind: 'goal' };
  h.send({ type: 'conversation_reset', new_conversation_id: 'new', uuid: 'reset' });
  assert.equal(h.context.currentSessionId, 'other-session'); assert.equal(h.context.currentExecutionMode.kind, 'goal');
  assert.equal(h.context.currentConv.executionMode.kind, 'goal'); assert.equal(h.context.contextUsageByConv.get('other').totalTokens, 5);
  assert.equal(h.run.sessionId, 'new'); assert.equal(h.run.turn.executionMode.kind, 'default');
});

for (const mode of ['plain', 'agent', 'orchestrate']) {
  test(`${mode}: actual handlers persist only confirmed final and retain process metadata`, async () => {
    const h = harness(mode);
    const answer = '完整答案\n\n```js\nconst answer = 42;\n```\n';
    h.send(full('progress', 'still working'));
    h.send(full('final', answer));
    h.send(result(answer));
    assert.equal(h.run.turn.assistant, '');
    assert.deepEqual(h.rendered, []);
    assert.deepEqual(h.finalizations, [], 'a result alone does not finalize the job');
    await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result(answer) });
    const saved = h.persisted.turns[0];
    assert.equal(saved.assistant, answer);
    assert.deepEqual(h.rendered, [answer]);
    assert.equal(saved.activity.items.find((item) => item.result === 'still working').type, 'narration');
    assert.equal(saved.output.final, answer);
    assert.equal(saved.activity.items.some((item) => item.result === answer), false, 'final is not duplicated in process');
    assert.equal(saved.chat, undefined, 'new runs do not create a separate collaboration transcript');
    assert.equal(h.context.runs.size, 0);
  });

  test(`${mode}: stop or executor error cannot publish provisional text`, async () => {
    for (const abort of [false, true]) {
      const h = harness(mode);
      h.send(full('progress', 'working'));
      h.send(result('provisional result'));
      h.run.abortRequested = abort;
      await h.context.finishRunUnsafe('job', { exitCode: -1, error: abort ? undefined : 'synthetic failure' });
      assert.equal(h.persisted.turns[0].assistant, '');
      assert.deepEqual(h.rendered, []);
      assert.equal(h.persisted.turns[0].output.messages[0].blocks[0].text, 'working');
    }
  });

  test(`${mode}: child stream/full reconciles once in ActivityStream without main output contamination`, () => {
    const h = harness(mode);
    h.send(stream({ type: 'message_start', message: { id: 'child' } }, { parent_tool_use_id: 'parent' }));
    h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child text' } }, { parent_tool_use_id: 'parent' }));
    h.flush();
    assert.equal(h.run.activityState.items.filter((item) => item.result === 'child text').length, 1, 'child progress is visible before full frame');
    const childFull = full('child', 'child text', { parent_tool_use_id: 'parent', uuid: 'child-full' });
    h.send(childFull); h.send(childFull);
    h.send(full('main', 'main planning'));
    const child = h.run.outputState.messages.filter((message) => message.parent === 'parent');
    assert.equal(child.length, 1);
    assert.equal(h.output.textFor(child[0]), 'child text');
    const childRows = h.run.activityState.items.filter((item) => item.result === 'child text');
    assert.equal(childRows.length, 1, 'stream/full and replay overlap retain only one visible child result');
    assert.equal(childRows[0].type, 'task');
    assert.equal(childRows[0].toolUseId, 'parent');
    assert.equal(h.run.activityState.items.filter((item) => item.result === 'main planning').length, 1);
    assert.equal(h.run.turn.assistant, '');
    assert.deepEqual(h.run.turn.chat, []);
    assert.deepEqual(h.rendered, []);
  });
}

test('delta bursts schedule one bounded process render; terminal flush cancels it', () => {
  const h = harness();
  for (let i = 0; i < 500; i++) h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }));
  assert.equal(h.timers.size, 1);
  assert.equal(h.updates.length, 500);
  assert.equal(h.updates.some((update) => update.force), false, 'text deltas do not force activity DOM updates');
  h.send(result('done'));
  assert.equal(h.timers.size, 0);
  assert.equal(h.run.activityState.items[0].result.length, 500);
});

test('child message_start cannot rebind the main assistant tool input stream', () => {
  const h = harness('orchestrate');
  h.send(stream({ type: 'message_start', message: { id: 'main' } }));
  h.send(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'main-read', name: 'Read', input: {} } }));
  h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_' } }));
  h.send(stream({ type: 'message_start', message: { id: 'child' } }, { parent_tool_use_id: 'parent' }));
  h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child text' } }, { parent_tool_use_id: 'parent' }));
  h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'path":"synthetic.txt"}' } }));
  h.send(stream({ type: 'content_block_stop', index: 0 }));
  const tool = h.run.activityState.items.find((item) => item.toolUseId === 'main-read');
  assert.deepEqual(clone(tool.input), { file_path: 'synthetic.txt' });
  assert.equal(tool.inputParseError, undefined);
  assert.equal(h.run.activityState._currentMessageId, 'main');
});

test('child lifecycle cannot terminate main run, replace session, or display raw output as final', () => {
  for (const owner of [{ parent_tool_use_id: 'parent' }, { subagent_type: 'analyst' }]) {
    const h = harness('orchestrate', { mounted: true });
    h.send({ type: 'system', subtype: 'init', session_id: 'main-session' });
    const stateBefore = clone(h.context.window.RelayActivity.serialize(h.run.activityState));
    for (const event of [
      result('child result', { is_error: true, session_id: 'child-session' }),
      { type: 'job-done', exitCode: 1, error: 'child failure' },
      { type: 'system', subtype: 'init', session_id: 'child-session' },
      { type: 'stderr', text: 'child stderr' }, { type: 'raw', text: 'child raw' },
    ]) h.send({ ...event, ...owner });
    assert.deepEqual(clone(h.context.window.RelayActivity.serialize(h.run.activityState)), stateBefore);
    assert.equal(h.run.sessionId, 'main-session');
    assert.equal(h.context.currentSessionId, 'main-session');
    assert.equal(h.run.error, undefined);
    assert.equal(h.run.stderrBuf, '');
    assert.deepEqual(h.finalizations, []);
    assert.deepEqual(h.notices, []);
    assert.equal(h.context.runs.get('conv'), h.run);
    h.send({ type: 'job-done', exitCode: 0, finalResult: result('main answer') });
    assert.equal(h.finalizations.length, 1);
    assert.equal(h.finalizations[0].event.finalResult.result, 'main answer');
  }
});

test('legacy display isolates protocol-shaped ranges without rewriting unrelated history', () => {
  const h = harness();
  const text = '原有历史叙述\n\n<tool_call><function=Read>example</function></tool_call>';
  const turn = { assistant: text };
  const display = h.context.savedAssistantDisplay(turn);
  assert.equal(display.text, '原有历史叙述');
  assert.equal(display.diagnostics.length, 1);
  assert.equal(turn.assistant, text);
  const notice = { assistant: '（任务已完成，但刷新前的最终回复没有保存在可恢复的本地事件中。请在任务中心查看详情或重新执行。）' };
  assert.match(h.context.savedAssistantDisplay(notice).text, /任务已结束，但未取得可恢复的最终回复/);
  assert.doesNotMatch(h.context.savedAssistantDisplay(notice).text, /任务中心/);
  assert.doesNotMatch(h.context.savedAssistantDisplay({ assistant: '（任务已结束，但未取得可恢复的最终回复。请在任务中心查看详情或重新执行。）' }).text, /任务中心/);
  assert.match(notice.assistant, /任务已完成/);
});

test('a natural final answer winning a pause race is retained and never marked paused', async () => {
  const h = harness(); h.send(full('final', 'authoritative answer'));
  h.run.pauseRequested = true; h.run.abortRequested = true;
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('authoritative answer') });
  assert.equal(h.persisted.turns[0].assistant, 'authoritative answer');
  assert.equal(h.persisted.paused, undefined);
});

test('fast continuation completion consumes only its prior pause and context markers', async () => {
  const h = harness(); h.conv.paused = { runId: 'old-pause' }; h.conv.carryContextOnNextTurn = 'mcp';
  h.run.resumedPauseId = 'old-pause'; h.run.carryContextReason = 'mcp';
  h.send(full('final', 'continued answer'));
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('continued answer') });
  assert.equal(h.persisted.paused, undefined); assert.equal(h.persisted.carryContextOnNextTurn, undefined);
});

test('mounted main renderer never creates an answer bubble for provisional or SDK-stage text', async () => {
  const h = harness('plain', { mounted: true }), bubbles = [];
  Object.assign(h.context, {
    detachStreamRenderTarget() { h.context.currentAssistantBubble = null; },
    streamMarkdownRenderer: { release() {} },
    appendMessage(role, text) {
      assert.equal(role, 'assistant');
      const bubble = { isConnected: true, dataset: {}, remove() { this.isConnected = false; } };
      bubbles.push({ text, bubble }); return bubble;
    },
    renderStreamBubble() {}, flushStreamRender() {}, scrollToBottom() {},
  });
  h.loadFunction('renderRunOutput');
  h.send(stream({ type: 'message_start', message: { id: 'stage' } }));
  h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Stage progress' } }));
  h.flush();
  const narration = h.run.activityState.items.find(item => item.result === 'Stage progress');
  assert.ok(narration);
  assert.equal(bubbles.length, 0);
  h.send(result('Stage progress'));
  assert.equal(h.run.activityState.items.find(item => item.result === 'Stage progress').id, narration.id);
  h.send({ type: 'system', subtype: 'api_retry', error_status: 429, attempt: 1 });
  h.send(full('child', 'Agent progress', { parent_tool_use_id: 'agent' }));
  h.send(full('next', 'More work'));
  h.send(full('answer', '# Confirmed answer'));
  h.send(result('# Confirmed answer'));
  assert.equal(bubbles.length, 0, 'result is an SDK round boundary, not Relay task completion');
  assert.equal(h.run.turn.assistant, '');
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('# Confirmed answer') });
  assert.deepEqual(bubbles.map(item => item.text), ['# Confirmed answer']);
  assert.equal(h.persisted.turns[0].assistant, '# Confirmed answer');
  assert.ok(h.persisted.turns[0].activity.items.some(item => item.result === 'Stage progress'));
  assert.equal(h.persisted.turns[0].activity.items.some(item => item.result === '# Confirmed answer'), false);
});
