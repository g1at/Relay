'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, full, stream } = require('./renderer-activity-harness.cjs');
const activity = require('../renderer/activity-stream');
const xml = '先激活工具。<tool_call><function=Read><parameter=file_path>fixture</parameter></function></tool_call>';
function launch(h, tool, task, generation) {
  h.send({ type: 'assistant', message: { id: 'launch-' + tool, content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { description: task } }] } });
  h.send({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tool, run_id: generation, description: task });
}

test('four children remain in their own task inspectors after SendMessage resumes and history reload', () => {
  const h = harness('orchestrate', { mounted: true });
  for (let i = 0; i < 4; i++) {
    const tool = 'agent-call-' + i, task = 'agent-' + i;
    launch(h, tool, task, 'generation-1');
    h.send(full('child-first-' + i, xml + i, { parent_tool_use_id: tool, agent_id: task, uuid: 'first-' + i }));
    h.send({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: tool, run_id: 'generation-1', status: 'completed' });
    h.send({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: 'send-message-' + i, run_id: 'generation-2', description: task });
    h.send(full('child-second-' + i, '继续。' + xml + i, { parent_tool_use_id: tool, agent_id: task, uuid: 'second-' + i }));
    h.send({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: 'send-message-' + i, run_id: 'generation-2', status: 'completed' });
  }
  h.send(full('root', '主任务进度'));
  h.flush();
  const tasks = h.run.activityState.items.filter(item => item.type === 'task');
  assert.equal(tasks.length, 4);
  assert.equal(h.run.activityState.items.filter(item => item.type === 'narration').length, 1);
  assert.equal(h.run.activityState.items.find(item => item.type === 'narration').result, '主任务进度');
  for (let i = 0; i < 4; i++) {
    const item = tasks.find(item => item.taskId === 'agent-' + i);
    assert.ok(item.taskToolUseIds.includes('agent-call-' + i));
    assert.ok(item.taskToolUseIds.includes('send-message-' + i));
    assert.match(item.result, /<tool_call>/);
    const html = activity.renderItem(item, false);
    assert.doesNotMatch(html.split('<div class="process-inspector">')[0], /&lt;tool_call&gt;/);
    assert.match(html, /&lt;tool_call&gt;/);
  }
  const turn = { activity: activity.serialize(h.run.activityState), output: h.output.serialize(h.run.outputState) };
  const before = clone(turn), restored = h.context.activityStateForTurn(turn);
  assert.deepEqual(clone(turn), before);
  assert.equal(restored.items.filter(item => item.type === 'task').length, 4);
  assert.equal(restored.items.filter(item => item.type === 'narration').length, 1);
});

test('streamed child prose updates the known task inspector before a completed frame, without forging a tool receipt', () => {
  const h = harness('orchestrate', { mounted: true });
  launch(h, 'agent-call', 'agent', 'one');
  h.send(stream({ type: 'message_start', message: { id: 'child' } }, { parent_tool_use_id: 'agent-call' }));
  h.send(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'live child prose' } }, { parent_tool_use_id: 'agent-call' }));
  h.flush();
  const tasks = h.run.activityState.items.filter(item => item.type === 'task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].childOutput, 'live child prose');
  assert.equal(tasks[0].resultConfirmed, undefined);
  assert.equal(h.run.activityState.items.some(item => item.type === 'narration'), false);
  assert.match(activity.renderItem(tasks[0], false), /子 Agent 输出/);
  assert.equal(activity.serialize(h.run.activityState).items[0].childOutput, undefined, 'presentation text is recomputed, not duplicated in activity snapshots');
  h.send(full('child', 'live child prose', { parent_tool_use_id: 'agent-call', agent_id: 'agent' }));
  h.flush();
  assert.equal(tasks[0].childOutput, undefined);
  assert.equal(tasks[0].result, 'live child prose');
});

test('legacy lifecycle placeholders coalesce with Agent rows and original owner aliases survive hydration', () => {
  const saved = { items: [
    { id: 'original', type: 'task', toolName: 'Agent', taskId: 'a', toolUseId: 'resumed', title: 'Agent work', status: 'success', result: 'first body', childResults: [{ uuid: 'body', text: 'first body' }] },
    { id: 'task:a', type: 'task', taskId: 'a', toolUseId: 'original', title: 'Agent work', status: 'success', result: 'additional evidence' },
  ] };
  const before = clone(saved), state = activity.hydrate(saved);
  assert.deepEqual(saved, before);
  assert.equal(state.items.length, 1);
  assert.deepEqual(new Set(state.items[0].taskToolUseIds), new Set(['original', 'resumed']));
  assert.match(state.items[0].result, /additional evidence/);
  activity.ingest(state, full('new-child', 'after reload', { parent_tool_use_id: 'original' }));
  assert.equal(state.items.length, 1);
  assert.match(state.items[0].result, /after reload/);
});

test('late completion from an older native task run cannot stop or relabel a resumed task', () => {
  const h = harness();
  launch(h, 'initial', 'a', 'one');
  h.send({ type: 'system', subtype: 'task_started', task_id: 'a', tool_use_id: 'resumed', run_id: 'two', description: 'current' });
  for (const subtype of ['task_notification', 'task_updated', 'task_started']) h.send({ type: 'system', subtype, task_id: 'a', tool_use_id: 'initial', run_id: 'one', status: 'completed', description: 'old', patch: { status: 'completed' } });
  const task = h.run.activityState.items.find(item => item.taskId === 'a');
  assert.equal(task.status, 'running'); assert.equal(task.title, 'current'); assert.equal(task.sdkTaskRunId, 'two');
  h.send({ type: 'system', subtype: 'task_notification', task_id: 'a', tool_use_id: 'resumed', run_id: 'two', status: 'completed' });
  assert.equal(task.status, 'success');
});
