'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Output = require('../renderer/assistant-output');
const Timeline = require('../renderer/supplement-timeline');
const { LiveExecutionModes, executionToolPolicy } = require('../src/main/projects/execution-modes');
const { createUsageObserver } = require('../src/main/usage/usage-capture');
const localWindow = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8'))(localWindow);
const Activity = localWindow.RelayActivity;
const assistant = (uuid, id, content, extra = {}) => ({ type: 'assistant', uuid, message: { id, content, stop_reason: 'end_turn' }, ...extra });
const text = value => ({ type: 'text', text: value });
const fallback = ids => ({ type: 'system', subtype: 'model_refusal_fallback', uuid: 'fallback', retracted_message_uuids: ids });
const result = value => ({ type: 'result', subtype: 'success', is_error: false, result: value });

test('wire UUID supersede retires one normalized block, preserves its siblings and persists tombstones', () => {
  let state = Output.createState();
  const first = assistant('old-first', 'same-model-message', [text('retracted')]);
  Output.ingest(state, first);
  Output.ingest(state, assistant('old-second', 'same-model-message', [text('retained sibling')]));
  Output.ingest(state, assistant('replacement', 'fresh', [text('canonical')], { supersedes: ['old-first', 'unknown'] }));
  assert.equal(Output.textFor(state.messages[0]), 'retained sibling');
  assert.deepEqual(state.messages[0].fullFrameIds, ['old-second']);
  assert.equal(Output.preview(state).text, 'canonical');
  Output.ingest(state, fallback(['old-first']));
  state = Output.createState(Output.serialize(state));
  for (let i = 0; i < 1100; i++) Output.ingest(state, { type: 'system', uuid: 'idle-' + i });
  Output.ingest(state, first);
  assert.equal(state.messages.length, 2);
  assert.ok(!Output.processItems(state).some(item => item.result.includes('retracted')));
  assert.deepEqual(state.retractedMessageUuids.sort(), ['old-first', 'unknown']);
});

test('full streamed blocks attach wire provenance before fallback and pending old final is invalidated', () => {
  const state = Output.createState();
  Output.ingest(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  Output.ingest(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'old draft' } } });
  Output.ingest(state, assistant('normalized-old', 'm', [text('old draft')]));
  Output.ingest(state, result('old draft'));
  Output.ingest(state, fallback(['normalized-old']));
  assert.equal(Output.preview(state), null);
  assert.equal(state.lastResult, null);
  assert.equal(Output.finish(state, { exitCode: 0 }), '');
  assert.equal(state.messages.length, 0);
});

test('thinking recovery flag persists as wrapper provenance, never assistant text', () => {
  const state = Output.createState();
  const event = assistant('resumed', 'thinking-continuation', [{ type: 'thinking', thinking: 'continued reasoning', signature: 'signed' }, text('answer')], { resumed_from_incomplete_thinking: true });
  Output.ingest(state, event);
  const restored = Output.createState(Output.serialize(state));
  assert.equal(restored.messages[0].resumed_from_incomplete_thinking, true);
  assert.ok(restored.messages[0].blocks.every(block => block.resumed_from_incomplete_thinking === true));
  assert.equal(Output.preview(restored).text, 'answer');
  const activity = Activity.createState(); Activity.ingest(activity, event);
  assert.equal(Activity.serialize(activity).items[0].resumed_from_incomplete_thinking, true);
});

test('assistant and tool-result retractions survive activity hydration without resurrecting retired calls', () => {
  let state = Activity.createState();
  const call = assistant('call-frame', 'm', [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'old.md' } }]);
  const answer = { type: 'user', uuid: 'result-frame', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'old result' }] } };
  Activity.ingest(state, call); Activity.ingest(state, answer);
  Activity.ingest(state, fallback(['result-frame']));
  assert.equal(state.items[0].result, '');
  assert.equal(state.items[0].status, 'superseded');
  Activity.ingest(state, assistant('replacement', 'new', [text('fixed')], { supersedes: ['call-frame', 'result-frame'] }));
  state = Activity.hydrate(Activity.serialize(state));
  Activity.ingest(state, call); Activity.ingest(state, answer);
  Activity.ingest(state, { type: 'tool_progress', tool_use_id: 'tool', tool_name: 'Read' });
  assert.equal(state.items.length, 0);
});

test('child assistant replacement updates its task details without removing the parent task', () => {
  const state = Activity.createState();
  Activity.ingest(state, assistant('child-old', 'child-msg', [text('old child')], { parent_tool_use_id: 'agent-call' }));
  Activity.ingest(state, assistant('child-new', 'child-new', [text('new child')], { parent_tool_use_id: 'agent-call', supersedes: ['child-old'] }));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].result, 'new child');
  const restored = Activity.hydrate(Activity.serialize(state));
  Activity.ingest(restored, fallback(['child-old']));
  assert.equal(restored.items[0].result, 'new child');
  restored.items[0].result = 'final task report';
  Activity.ingest(restored, fallback(['unrelated']));
  assert.equal(restored.items[0].result, 'final task report');
});

test('compacting status updates permission and reuses one row through the boundary', () => {
  const state = Activity.createState({ session: { permissionMode: 'default' } });
  Activity.ingest(state, { type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'acceptEdits', uuid: 'start' });
  Activity.ingest(state, { type: 'system', subtype: 'status', status: 'compacting', uuid: 'still' });
  assert.equal(state.items.length, 1);
  const row = state.items[0]; assert.equal(row.status, 'running');
  assert.equal(state.session.permissionMode, 'acceptEdits');
  Activity.ingest(state, { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 100, post_tokens: 30 }, uuid: 'end' });
  assert.equal(state.items[0], row); assert.equal(row.status, 'success');
  Activity.ingest(state, { type: 'system', subtype: 'status', status: null });
  assert.equal(state.items.length, 1);
});

test('compaction success status and boundary share one row in either order, failures retain diagnostics', () => {
  const start = { type: 'system', subtype: 'status', status: 'compacting', uuid: 'start' };
  const success = { type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: 'success' };
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', compact_metadata: { pre_tokens: 100, post_tokens: 20 } };
  for (const events of [[start, success, boundary], [start, boundary, success], [success, boundary]]) {
    const state = Activity.createState(); events.forEach(event => Activity.ingest(state, event));
    assert.equal(state.items.length, 1); assert.equal(state.items[0].status, 'success');
    assert.match(state.items[0].detail, /100.*20/);
    const restored = Activity.hydrate(Activity.serialize(state));
    Activity.ingest(restored, success); Activity.ingest(restored, boundary);
    assert.equal(restored.items.length, 1);
  }
  const state = Activity.createState(); Activity.ingest(state, start);
  Activity.ingest(state, { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: '<network unavailable>', uuid: 'failed' });
  assert.equal(state.items.length, 1); assert.equal(state.items[0].status, 'error');
  const restored = Activity.hydrate(Activity.serialize(state));
  assert.equal(restored.items[0].detail, '<network unavailable>');
  assert.match(Activity.renderItem(restored.items[0], false), /&lt;network unavailable&gt;/);
  assert.equal(state.phase, 'running', 'a compaction failure alone does not end the entire query');
});

test('conversation reset preserves visible history while clearing runtime output and activity context', () => {
  let output = Output.createState(); let activity = Activity.createState({ session: { id: 'old', cwd: '/project' } });
  const old = assistant('old', 'old-message', [text('old output')]);
  Output.ingest(output, old); Output.ingest(output, result('old final'));
  Activity.ingest(activity, assistant('old-tool', 'old-tool-message', [{ type: 'tool_use', id: 'old-tool', name: 'Read', input: {} }]));
  Activity.ingest(activity, result('old final'));
  const reset = { type: 'conversation_reset', new_conversation_id: 'fresh-runtime', session_id: 'old', uuid: 'reset' };
  Output.ingest(output, reset); Activity.ingest(activity, reset);
  assert.deepEqual(output.messages.map(Output.textFor), ['old output', 'old final']);
  assert.equal(output.lastResult, null); assert.equal(Output.preview(output), null);
  assert.equal(Output.processItems(output)[0].status, 'success');
  assert.equal(Timeline.capture(output).messageId, null);
  assert.equal(activity.session.id, 'fresh-runtime'); assert.equal(activity.session.cwd, '/project');
  assert.equal(activity.result, null); assert.equal(activity.items[0].status, 'superseded');
  output = Output.createState(Output.serialize(output)); activity = Activity.hydrate(Activity.serialize(activity));
  Output.ingest(output, reset); Activity.ingest(activity, reset);
  assert.equal(output.contextEpoch, 1); assert.equal(activity.contextEpoch, 1);
  assert.equal(activity._tools.size, 0);
  Output.ingest(output, assistant('new', 'new-message', [text('new output')]));
  assert.equal(Output.preview(output).text, 'new output');
  assert.equal(Output.finish(output, { exitCode: 0, finalResult: result(undefined) }), 'new output');
  Output.ingest(output, { ...reset, uuid: 'child-reset', parent_tool_use_id: 'child', new_conversation_id: 'child-only' });
  Activity.ingest(activity, { ...reset, uuid: 'child-reset', parent_tool_use_id: 'child', new_conversation_id: 'child-only' });
  Output.ingest(output, { ...reset, uuid: 'agent-reset', agent_id: 'child', new_conversation_id: 'child-only' });
  Activity.ingest(activity, { ...reset, uuid: 'agent-reset', agent_id: 'child', new_conversation_id: 'child-only' });
  assert.equal(output.conversationId, 'fresh-runtime'); assert.equal(activity.session.id, 'fresh-runtime');
});

test('task resource links persist, are bounded and render escaped click targets, never arbitrary executable hrefs', () => {
  const state = Activity.createState();
  Activity.ingest(state, { type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'call', status: 'completed',
    output_file: 'C:\\RelayProjects\\task.log', resource_links: [
      { uri: 'file:///C:/RelayProjects/report.pdf', title: '<img onerror=1>', name: 'report' },
      { uri: 'https://example.com/report', name: 'Online report' },
      { uri: 'mcp://server/report', name: 'MCP reference' },
      { uri: 'javascript:alert(1)', name: 'bad' }, { uri: 'https://user:secret@example.com', name: 'private' },
      { uri: 'file:///C:/RelayProjects/report.pdf', name: 'duplicate' }, { uri: 'broken\nuri', name: 'broken' },
    ], summary: 'done' });
  const restored = Activity.hydrate(Activity.serialize(state));
  const item = restored.items[0]; assert.equal(item.resources.length, 3);
  assert.deepEqual(item.resources.map(resource => resource.kind), ['file', 'url', 'resource']);
  const html = Activity.renderItem(item, false);
  // SDK transcripts belong to the host registry; only explicit delivery
  // resources enter the activity UI.
  assert.equal((html.match(/class="process-task-resource"/g) || []).length, 3);
  assert.deepEqual([...html.matchAll(/data-resource-index="(\d+)"/g)].map(match => Number(match[1])), [0, 1, 2]);
  assert.doesNotMatch(html, /task\.log|查看任务输出/);
  assert.match(html, /&lt;img onerror=1&gt;/);
  assert.doesNotMatch(html, /href=|<img|javascript:|user:secret|process-task-stop/);
  assert.equal(Activity.taskResources({ resource_links: Array.from({ length: 100 }, (_, i) => ({ uri: 'mcp://report/' + i })) }).length, 50);
});

test('individual task stop is available only for an identified active background task', () => {
  const item = { id: 'task', type: 'task', taskId: 'real', status: 'running', title: 'Check' };
  assert.match(Activity.renderItem(item, false), /process-task-stop/);
  for (const extra of [{ taskId: null }, { status: 'success' }, { status: 'error' }, { type: 'tool' }]) {
    assert.doesNotMatch(Activity.renderItem({ ...item, ...extra }, false), /process-task-stop/);
  }
});

test('completed output projections are reused while a later message streams and invalidate on text changes', () => {
  const state = Output.createState();
  Output.ingest(state, assistant('long', 'long', [text('first\n'.repeat(10000))]));
  const initial = Output.processItems(state)[0];
  Output.ingest(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'live' } } });
  Output.ingest(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'later' } } });
  assert.equal(Output.processItems(state)[0], initial);
  state.messages[0].blocks[0].text = 'changed';
  assert.notEqual(Output.processItems(state)[0], initial);
  assert.equal(Output.processItems(state)[0].result, 'changed');
});

test('native reset clears the live goal controller without issuing a synthetic goal command', async () => {
  const inputs = [], controls = [];
  const modes = new LiveExecutionModes({ executionMode: { kind: 'goal' }, resumed: true,
    control: async (...args) => controls.push(args), enqueue: (...args) => inputs.push(args), stop() {} });
  modes.beforePush('/goal old condition', { uuid: 'old-goal' });
  const reset = { type: 'conversation_reset', new_conversation_id: 'new', uuid: 'reset' };
  assert.equal(modes.observe(reset), reset);
  assert.equal(modes.knownGoal, false); assert.equal(modes.goalMayExist, false);
  assert.equal(modes.goalStateKnown, true); assert.equal(modes.goalCondition, null);
  assert.equal(modes.goalInputId, null); assert.equal(modes.mode.kind, 'default');
  await modes.prepare({ kind: 'default' });
  assert.equal(inputs.length, 0); assert.equal(controls.length, 0);
  modes.observe(reset); assert.equal(modes.contextEpoch, 1);
  modes.observe({ ...reset, uuid: 'child', agent_id: 'a', new_conversation_id: 'child' });
  assert.equal(modes.contextEpoch, 1);
});

test('a pending internal command fails on reset and its late ACK stays hidden; plan stays read-only', async () => {
  const modes = new LiveExecutionModes({ executionMode: { kind: 'plan' }, permissionMode: 'bypassPermissions',
    control: async () => {}, enqueue: () => true, stop() {} });
  const pending = modes.localInput('/goal clear');
  const pendingId = modes.pending.id;
  const rejected = assert.rejects(pending, { code: 'MODE_CONTEXT_RESET' });
  modes.observe({ type: 'conversation_reset', new_conversation_id: 'new', uuid: 'reset' });
  await rejected;
  assert.equal(modes.observe({ type: 'command_lifecycle', command_uuid: pendingId, state: 'completed' }), null);
  assert.equal(modes.observe({ type: 'user', uuid: pendingId }), null);
  assert.equal(modes.mode.kind, 'plan'); assert.equal(modes.appliedPermission, 'plan');
  const policy = executionToolPolicy(() => modes.mode, async () => ({ behavior: 'allow' }));
  assert.equal((await policy.canUseTool('Write', {}, {})).behavior, 'deny');
});

test('reset cancels an outstanding prepare before a stale continuation can reapply the old goal', async () => {
  let finishReady;
  const inputs = []; let stopped = 0;
  const modes = new LiveExecutionModes({ executionMode: { kind: 'goal' },
    ready: () => new Promise(resolve => { finishReady = resolve; }),
    control: async () => [{ name: 'goal' }], enqueue: (...args) => inputs.push(args), stop() { stopped++; } });
  const work = modes.prepare({ kind: 'goal' }, { contextPrompt: 'old context', goalCondition: 'old goal' });
  const rejected = assert.rejects(work, { code: 'MODE_CONTEXT_RESET' });
  await new Promise(setImmediate);
  modes.observe({ type: 'conversation_reset', new_conversation_id: 'new', uuid: 'reset' });
  finishReady(); await rejected;
  assert.equal(inputs.length, 0); assert.equal(stopped, 1);
});

test('usage reset starts a fresh session epoch while retaining query identity and previous records', () => {
  const records = []; const observe = createUsageObserver(record => records.push(record), { queryId: 'same-query' });
  const usageResult = { ...result('ignored text'), session_id: 'old', uuid: 'old-result', modelUsage: { model: { inputTokens: 100, outputTokens: 20 } } };
  observe(usageResult);
  const reset = { type: 'conversation_reset', new_conversation_id: 'fresh-context', session_id: 'old', uuid: 'reset' };
  observe(reset); observe(reset);
  observe({ ...reset, new_conversation_id: 'child', uuid: 'child-reset', agent_id: 'child' });
  observe({ ...usageResult, uuid: 'next-result', modelUsage: { model: { inputTokens: 10, outputTokens: 2 } } });
  observe({ ...usageResult, uuid: 'child-result', agent_id: 'child' });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.queryId), ['same-query', 'same-query']);
  assert.deepEqual(records.map(record => record.sessionId), ['old', 'fresh-context']);
  assert.deepEqual(records.map(record => record.modelUsage.model.inputTokens), [100, 10]);
  assert.doesNotMatch(JSON.stringify(records), /ignored text/);
});
