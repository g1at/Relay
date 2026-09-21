'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMiniChatController } = require('../mini-chat-controller');

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 50; i++) { if (predicate()) return; await tick(); } assert.fail('Condition did not settle'); };
const success = text => ({ type: 'result', subtype: 'success', result: text, is_error: false });
const toolCall = (id, file, extra = {}) => ({ type: 'assistant', uuid: `call-${id}`, ...extra,
  message: { id: `message-${id}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
const toolResult = (id, text, extra = {}) => ({ type: 'user', uuid: `result-${id}`, ...extra,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function fixture(overrides = {}) {
  const history = new Map(), calls = [], saves = [], states = [], changed = [], pauses = [], steers = [];
  let sequence = 0, time = 0;
  const deps = {
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    now: () => new Date(Date.UTC(2026, 8, 8, 1, 0, time++)).toISOString(),
    getDefaultModel: () => 'sonnet',
    loadConversation: id => copy(history.get(id)),
    saveConversation: record => { saves.push(copy(record)); history.set(record.id, copy(record)); },
    run: (request, emit) => { calls.push({ request, emit }); return { jobId: request.runId, providerId: 'provider-a', providerRevision: 7, routeTier: request.model }; },
    pause: async id => { pauses.push(id); return { paused: true, settled: true }; },
    steer: request => { steers.push(request); return { ok: false, code: 'UNSUPPORTED_EXECUTOR', message: '暂不支持' }; },
    onState: snapshot => states.push(snapshot), onHistoryChanged: id => changed.push(id),
    ...overrides,
  };
  const controller = createMiniChatController(deps);
  const finish = async (text, call = calls.at(-1)) => {
    call.emit({ ...success(text), jobId: call.request.runId });
    call.emit({ type: 'job-done', jobId: call.request.runId, exitCode: 0, finalResult: success(text) });
    await waitFor(() => !controller.isRunning());
  };
  return { controller, deps, history, calls, saves, states, changed, pauses, steers, finish };
}

test('mini persists a completed answer and denial notice without erasing the denied tool receipt', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'Inspect a synthetic local configuration.' });
  const { emit } = f.calls[0];
  emit(toolCall('denied', 'fixture.txt'));
  emit({ type: 'user', uuid: 'denied-result', message: { content: [
    { type: 'tool_result', tool_use_id: 'denied', content: 'Specific policy denial', is_error: true },
  ] } });
  const terminal = { ...success('Completed diagnostic findings.'), permission_denials: [{ tool_name: 'Read' }], terminal_reason: 'completed' };
  emit(terminal);
  assert.equal(f.controller.state().conversation.turns[0].assistant, '');
  emit({ type: 'job-done', exitCode: 0, finalResult: terminal });
  await waitFor(() => !f.controller.isRunning());
  const turn = f.controller.state().conversation.turns[0];
  assert.equal(turn.assistant, terminal.result);
  assert.equal(turn.status, 'complete');
  assert.match(turn.outputNotice, /1 次工具请求被拒绝（Read）/);
  assert.equal(turn.activity.phase, 'complete');
  assert.equal(turn.activity.items.find(item => item.toolUseId === 'denied').status, 'error');
  assert.equal(f.saves.at(-1).turns[0].assistant, terminal.result);
  f.controller.destroy();
});

test('mini snapshots carry preparation and reply waiting until actual SDK thinking, then stop on pause', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'startup fixture' });
  const { emit } = f.calls[0];
  const phase = () => f.controller.state().conversation.turns[0].activity.startupPhase;
  assert.equal(phase(), 'preparing');
  emit({ type: 'system', subtype: 'init', session_id: 'startup-fixture' });
  emit({ type: 'system', subtype: 'relay_mcp_status', phase: 'settled', ok: true });
  assert.equal(phase(), 'waiting');
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'response' } } });
  assert.equal(phase(), 'waiting');
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: '' } } });
  assert.equal(phase(), null);
  await f.controller.pause();
  await waitFor(() => !f.controller.isRunning());
  assert.equal(phase(), null);
  f.controller.destroy();
});

test('mini native abort with accumulated denials cannot become normal completion without a pause click', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'Synthetic abort check.' });
  const { emit } = f.calls[0];
  const terminal = { ...success('Partial response'), terminal_reason: 'aborted_tools', permission_denials: [{ tool_name: 'Read' }] };
  emit(terminal); emit({ type: 'job-done', exitCode: 0, finalResult: terminal });
  await waitFor(() => !f.controller.isRunning());
  const turn = f.controller.state().conversation.turns[0];
  assert.notEqual(turn.status, 'complete');
  assert.equal(turn.assistant, '');
  assert.equal(turn.activity.phase, 'error');
  f.controller.destroy();
});

test('distinct questions added during one mini run retain both confirmed answers after completion and reload', async () => {
  const f = fixture({ steer: request => ({ ok: true, input: { id: request.messageId,
    text: request.prompt, status: 'applied', presentation: request.presentation, followUpMode: 'steer' } }) });
  const sent = await f.controller.submit({ text: 'Describe your available capabilities.' });
  const { emit, request } = f.calls[0];
  const answer = (id, text) => ({ type: 'assistant', message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const first = 'I can inspect files and explain code.', second = 'The synthetic forecast is sunny.';
  emit(answer('capabilities', first));
  const inserted = await f.controller.submit({ text: 'Also describe the synthetic forecast.' });
  assert.equal(inserted.ok, true);
  const inputId = f.controller.state().conversation.turns[0].supplements[0].id;
  emit({ ...success(first), user_message_uuid: request.runId, user_message_uuids: [request.runId], queued_turn_count: 1, terminal_reason: 'completed' });
  assert.equal(f.controller.state().conversation.turns[0].assistant, '');
  assert.equal(f.controller.isRunning(), true);
  emit(answer('forecast', second));
  const final = { ...success(second), user_message_uuid: inputId, user_message_uuids: [inputId], terminal_reason: 'completed' };
  emit(final); emit({ type: 'job-done', exitCode: 0, finalResult: final });
  await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId).turns[0];
  assert.equal(saved.assistant, first + '\n\n' + second);
  assert.equal(saved.output.answers.length, 2);
  const restored = require('../renderer/assistant-output').createState(JSON.parse(JSON.stringify(saved.output)));
  assert.equal(restored.final, saved.assistant);
  assert.equal(require('../renderer/assistant-output').processItems(restored).some(item => [first, second].includes(item.result)), false);
  f.controller.destroy();
});

test('failed mini turns persist real tool discoveries and carry them into a fresh session without final prose', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'Inspect the synthetic artifact' });
  const { emit } = f.calls[0];
  emit(toolCall('read-discovery', '/synthetic/discovery.txt'));
  emit(toolResult('read-discovery', 'DISCOVERED_CONFIGURATION=ready'));
  emit(toolResult('read-discovery', 'DISCOVERED_CONFIGURATION=ready')); // replay overlap
  const live = f.controller.state().conversation.turns[0];
  assert.equal(live.activity.items.filter(item => item.toolUseId === 'read-discovery').length, 1);
  assert.equal(live.activity.items.find(item => item.toolUseId === 'read-discovery').result, 'DISCOVERED_CONFIGURATION=ready');
  emit({ type: 'job-done', exitCode: 1, error: 'synthetic provider connection failure' });
  await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId).turns[0];
  assert.equal(saved.assistant, ''); assert.equal(saved.status, 'error');
  assert.equal(saved.activity.items.find(item => item.toolUseId === 'read-discovery').status, 'success');
  assert.equal(saved.activity.taskDurationMs, saved.taskDurationMs);
  await f.controller.submit({ text: 'Continue from that discovery' });
  assert.equal(f.calls[1].request.sessionId, null);
  assert.match(f.calls[1].request.prompt, /DISCOVERED_CONFIGURATION=ready/);
  assert.match(f.calls[1].request.prompt, /discovery\.txt/);
  assert.match(f.calls[1].request.prompt, /轮次状态：error/);
  await f.finish('Recovered'); f.controller.destroy();
});

test('paused mini tool work retains successful results but never marks unfinished tools successful', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'Check a file and continue analysis' });
  f.calls[0].emit(toolCall('finished-read', '/synthetic/checked.txt'));
  f.calls[0].emit(toolResult('finished-read', 'CHECKED_BEFORE_PAUSE'));
  f.calls[0].emit(toolCall('pending-read', '/synthetic/pending.txt'));
  await f.controller.pause(); await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId).turns[0];
  assert.equal(saved.status, 'paused'); assert.equal(saved.assistant, '');
  assert.equal(saved.activity.items.find(item => item.toolUseId === 'finished-read').status, 'success');
  assert.notEqual(saved.activity.items.find(item => item.toolUseId === 'pending-read').status, 'success');
  await f.controller.submit({ resume: true });
  assert.match(f.calls[1].request.prompt, /CHECKED_BEFORE_PAUSE/);
  assert.match(f.calls[1].request.prompt, /pending\.txt/);
  assert.match(f.calls[1].request.prompt, /轮次状态：paused/);
  await f.finish('Finished'); f.controller.destroy();
});

test('mini tool recovery respects retracted frames and the current context epoch', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'Old request' });
  const { emit } = f.calls[0];
  emit({ type: 'system', subtype: 'init', session_id: 'old-session' });
  emit(toolCall('old-read', '/synthetic/old.txt'));
  emit(toolResult('old-read', 'OLD_CONTEXT_RESULT'));
  emit({ type: 'conversation_reset', uuid: 'reset-tools', session_id: 'old-session', new_conversation_id: 'new-session' });
  emit(toolCall('discarded-read', '/synthetic/discarded.txt', { session_id: 'new-session' }));
  emit(toolResult('discarded-read', 'RETRACTED_RESULT', { session_id: 'new-session' }));
  emit({ type: 'system', subtype: 'model_refusal_fallback', uuid: 'retract-tools', session_id: 'new-session', retracted_message_uuids: ['call-discarded-read'] });
  emit(toolResult('discarded-read', 'LATE_RETRACTED_RESULT', { uuid: 'late-retracted-result', session_id: 'new-session' }));
  emit(toolCall('current-read', '/synthetic/current.txt', { session_id: 'new-session' }));
  emit(toolResult('current-read', 'CURRENT_CONTEXT_RESULT', { session_id: 'new-session' }));
  emit(toolResult('current-read', 'STALE_SESSION_OVERWRITE', { uuid: 'late-old-result', session_id: 'old-session' }));
  emit({ type: 'job-done', exitCode: 1, error: 'synthetic failure', session_id: 'new-session' });
  await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.turns[0].activity.contextEpoch, 1);
  assert.equal(saved.turns[0].activity.items.find(item => item.toolUseId === 'current-read').result, 'CURRENT_CONTEXT_RESULT');
  assert.ok(saved.turns[0].activity.items.some(item => item.toolUseId === 'old-read'), 'visible old history remains on disk');
  assert.ok(!saved.turns[0].activity.items.some(item => item.toolUseId === 'discarded-read'));
  saved.sessionId = null; saved.carryContextOnNextTurn = 'interrupted';
  await f.controller.submit({ text: 'Continue only the new context' });
  assert.match(f.calls[1].request.prompt, /CURRENT_CONTEXT_RESULT/);
  assert.doesNotMatch(f.calls[1].request.prompt, /OLD_CONTEXT_RESULT|RETRACTED_RESULT|STALE_SESSION_OVERWRITE/);
  await f.finish('Recovered'); f.controller.destroy();
});

test('mini child work attaches to its Agent without overwriting root tools, timing or terminal state', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'Inspect with an Agent' });
  const { emit } = f.calls[0];
  emit(toolCall('parent-read', '/synthetic/parent.txt'));
  emit(toolResult('parent-read', 'ROOT_TOOL_RESULT'));
  emit({ type: 'assistant', uuid: 'agent-call', message: { id: 'agent-call', content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent', input: { prompt: 'Check the synthetic input' } }] } });
  emit(toolResult('parent-read', 'CHILD_RESULT_CANNOT_OVERWRITE', { uuid: 'child-nested-result', parent_tool_use_id: 'agent-tool' }));
  emit({ type: 'assistant', uuid: 'child-text', parent_tool_use_id: 'agent-tool', message: { id: 'child-message', content: [{ type: 'text', text: 'AGENT_OBSERVATION' }] } });
  emit({ type: 'conversation_reset', uuid: 'child-context-reset', agent_id: 'agent-tool', new_conversation_id: 'child-session' });
  emit({ type: 'job-done', parent_tool_use_id: 'agent-tool', exitCode: 0, finalResult: success('CHILD_IS_NOT_FINAL') });
  const live = f.controller.state().conversation.turns[0];
  assert.equal(f.controller.isRunning(), true); assert.equal(live.activity.phase, 'running');
  assert.equal(live.activity.contextEpoch, 0); assert.equal(live.activity.taskFinishedAt, null);
  assert.equal(live.activity.items.find(item => item.toolUseId === 'parent-read').result, 'ROOT_TOOL_RESULT');
  assert.match(live.activity.items.find(item => item.toolUseId === 'agent-tool').result, /AGENT_OBSERVATION/);
  await f.finish('PARENT_DELIVERY');
  const saved = f.history.get(sent.conversationId).turns[0];
  assert.equal(saved.assistant, 'PARENT_DELIVERY');
  assert.equal(saved.activity.items.find(item => item.toolUseId === 'parent-read').result, 'ROOT_TOOL_RESULT');
  f.controller.destroy();
});

test('native reset in mini keeps visible output, resets goal/context and resumes the new session after saving', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'original goal', permissionMode: 'default', executionMode: { kind: 'goal' } });
  await waitFor(() => f.calls.length === 1);
  const { emit } = f.calls[0];
  assert.equal(f.calls[0].request.executionMode.kind, 'goal');
  emit({ type: 'system', subtype: 'init', session_id: 'before-reset' });
  emit({ type: 'assistant', uuid: 'old-output', message: { id: 'old-output', stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier visible output' }] } });
  const record = f.history.get(sent.conversationId);
  record.sessionId = 'before-reset'; record.contextUsage = { used: 999 };
  record.goalRecovery = { condition: 'old goal' }; record.turns[0].contextUsage = { used: 999 };
  const reset = { type: 'conversation_reset', new_conversation_id: 'after-reset', session_id: 'before-reset', uuid: 'reset' };
  emit(reset); emit(reset);
  emit({ ...reset, uuid: 'child-reset', agent_id: 'child', new_conversation_id: 'child-only' });
  const live = f.controller.state().conversation;
  assert.equal(live.sessionId, 'after-reset'); assert.equal(live.executionMode.kind, 'default');
  assert.equal(live.turns[0].executionMode.kind, 'default'); assert.equal(live.turns[0].preview, '');
  assert.equal(live.turns[0].output.messages[0].blocks[0].text, 'earlier visible output');
  assert.equal(live.turns[0].output.contextEpoch, 1);
  await f.finish('new final');
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.sessionId, 'after-reset'); assert.equal(saved.executionMode.kind, 'default');
  assert.equal(saved.contextUsage, undefined); assert.equal(saved.goalRecovery, undefined);
  assert.equal(saved.turns[0].contextUsage, undefined); assert.equal(saved.turns[0].output.contextEpoch, 1);
  assert.equal(saved.turns[0].assistant, 'new final'); assert.equal(saved.turns.length, 1);
  await f.controller.submit({ text: 'continue normally' });
  await waitFor(() => f.calls.length === 2);
  assert.equal(f.calls[1].request.sessionId, 'after-reset');
  assert.equal(f.calls[1].request.executionMode.kind, 'default');
  await f.finish('done'); f.controller.destroy();
});

test('mini reset preserves plan and a delayed launch response cannot restore the old session', async () => {
  const launch = deferred(); let emit;
  const f = fixture({ run: (_request, onEvent) => { emit = onEvent; return launch.promise; } });
  const sent = await f.controller.submit({ text: 'read only plan', permissionMode: 'default', executionMode: { kind: 'plan' } });
  await waitFor(() => !!emit);
  emit({ type: 'system', subtype: 'init', session_id: 'old-runtime' });
  emit({ type: 'conversation_reset', new_conversation_id: 'new-runtime', uuid: 'reset' });
  assert.equal(f.controller.state().conversation.executionMode.kind, 'plan');
  assert.equal(f.controller.state().conversation.turns[0].executionMode.kind, 'plan');
  launch.resolve({ sessionId: 'old-runtime', providerId: 'fixture', providerRevision: 1, routeTier: 'sonnet' });
  emit(success('safe plan'));
  emit({ type: 'job-done', exitCode: 0, finalResult: success('safe plan') });
  await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.sessionId, 'new-runtime');
  assert.equal(saved.executionMode.kind, 'plan');
  f.controller.destroy();
});

test('mini finish clears stale goal metadata even when the host already wrote the reset session ID', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'fixture goal', permissionMode: 'default', executionMode: { kind: 'goal' } });
  await waitFor(() => f.calls.length === 1);
  const record = f.history.get(sent.conversationId);
  record.sessionId = 'new-context'; record.contextUsage = { used: 999 }; record.goalRecovery = { condition: 'old' };
  f.calls[0].emit({ type: 'conversation_reset', new_conversation_id: 'new-context', uuid: 'reset' });
  await f.finish('done');
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.executionMode.kind, 'default'); assert.equal(saved.contextUsage, undefined); assert.equal(saved.goalRecovery, undefined);
  f.controller.destroy();
});

test('mini reset cleanup preserves a newer host permission revision in the same new context', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: 'fixture goal', permissionMode: 'default', executionMode: { kind: 'goal' } });
  await waitFor(() => f.calls.length === 1);
  f.calls[0].emit({ type: 'conversation_reset', new_conversation_id: 'new-context', uuid: 'reset' });
  const record = f.history.get(sent.conversationId);
  record.sessionId = 'new-context'; record.permissionRevision = 100;
  record.executionMode = { kind: 'plan' };
  await f.finish('done');
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.executionMode.kind, 'plan'); assert.equal(saved.permissionRevision, 100);
  f.controller.destroy();
});

test('opening, reading, and creating an empty chat do not occupy history or mutate timestamps', async () => {
  const f = fixture();
  assert.deepEqual(f.controller.state(), { conversation: null, model: 'sonnet', running: false, runId: null });
  assert.equal(f.controller.getConversationId(), null);
  assert.equal((await f.controller.submit({ text: '  ' })).code, 'EMPTY_INPUT');
  await f.controller.newChat();
  assert.equal(f.saves.length, 0);
  assert.equal(f.calls.length, 0);
  f.controller.destroy();
});

test('mini forwards one-shot follow-up reversal without pausing or starting another run', async () => {
  const requests = [];
  const f = fixture({ steer: request => {
    requests.push(request);
    return { ok: true, input: { id: request.messageId, text: request.text, status: 'queued' } };
  } });
  await f.controller.submit({ text: 'original task' });
  await f.controller.submit({ text: 'queued follow-up', reverseFollowUp: true });
  await f.controller.submit({ text: 'explicit mode', followUpMode: 'queue' });
  assert.equal(requests[0].reverseFollowUp, true);
  assert.equal(requests[0].followUpMode, undefined);
  assert.equal(requests[1].followUpMode, 'queue');
  assert.equal(requests[1].reverseFollowUp, false);
  assert.equal(f.calls.length, 1); assert.equal(f.pauses.length, 0);
  assert.equal(requests[0].jobId, f.calls[0].request.runId);
  await f.finish('done'); f.controller.destroy();
});

test('a real submit persists the normal user turn before dispatch and uses the shared runner contract', async () => {
  const f = fixture();
  const sent = await f.controller.submit({ text: '  测试快捷对话  ', model: 'opus' });
  assert.equal(sent.ok, true);
  const { request } = f.calls[0];
  const stored = f.history.get(sent.conversationId);
  assert.equal(stored.turns[0].user, '测试快捷对话');
  assert.equal(stored.turns[0].assistant, '');
  assert.equal(stored.mode, 'plain');
  assert.equal(stored.model, 'opus');
  assert.equal(stored.workingDir, null);
  assert.equal(request.convId, stored.id);
  assert.equal(request.sourceConvId, stored.id);
  assert.equal(request.runId, stored.turns[0].runId);
  assert.deepEqual(request.taskContext.turnRef, { index: 0, ts: stored.turns[0].ts });
  assert.deepEqual(request.executionMode, { kind: 'default' });
  assert.deepEqual(request.files, []);
  assert.equal(f.saves.length, 1);
  await f.finish('完成');
  f.controller.destroy();
});

test('stream previews reconcile full frames and duplicates; only the parent job-done confirms final text', async () => {
  const f = fixture();
  await f.controller.submit({ text: '请回复' });
  const { emit } = f.calls[0];
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const delta = { type: 'stream_event', uuid: 'delta1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**你好**' } } };
  emit(delta); emit(delta);
  emit({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '**你好**' }] } });
  emit({ ...success('子任务输出'), parent_tool_use_id: 'child' });
  emit({ type: 'job-done', parent_tool_use_id: 'child', exitCode: 0, finalResult: success('子任务输出') });
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.controller.state().conversation.turns[0].preview, '**你好**');
  assert.equal(f.controller.state().conversation.turns[0].assistant, '');
  emit(success('阶段性回复'));
  assert.equal(f.controller.isRunning(), true);
  await f.finish('**你好**');
  const turn = f.controller.state().conversation.turns[0];
  assert.equal(turn.assistant, '**你好**');
  assert.equal(turn.preview, '');
  assert.equal(turn.status, 'complete');
  // The distinct stage-only result survives in the process timeline; duplicate
  // stream snapshots still reconcile to the single original message.
  assert.deepEqual(turn.output.messages.map(message => message.blocks.filter(block => block.type === 'text').map(block => block.text).join('')), ['**你好**', '阶段性回复']);
  f.controller.destroy();
});

test('tool narration and protocol text never become a confirmed answer', async () => {
  const f = fixture();
  await f.controller.submit({ text: '检查文件' });
  f.calls[0].emit({ type: 'assistant', message: { id: 'tool', stop_reason: 'tool_use', content: [
    { type: 'text', text: '先检查一下文件。' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/test' } },
  ] } });
  assert.equal(f.controller.state().conversation.turns[0].preview, '');
  assert.equal(f.controller.state().conversation.turns[0].activityLabel, '正在读取文件');
  await f.finish('<tool_call><function=Read>{}</function></tool_call>');
  assert.equal(f.controller.state().conversation.turns[0].assistant, '');
  assert.match(f.controller.state().conversation.turns[0].outputNotice, /协议文本/);
  f.controller.destroy();
});

test('final saves preserve concurrent title, pin, project, workdir and supplement changes', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'hello' });
  const id = f.controller.getConversationId();
  const record = f.history.get(id);
  record.title = '用户重命名'; record.pinned = true; record.projectId = 'project-new';
  record.workingDir = { path: 'D:\\Work', name: 'Work' };
  record.turns[0].supplements = [{ id: 'supplement', text: '用中文', status: 'applied', ts: '2026-09-08T01:01:00.000Z' }];
  f.history.set(id, record);
  await f.finish('你好');
  const saved = f.history.get(id);
  assert.equal(saved.title, '用户重命名');
  assert.equal(saved.pinned, true);
  assert.equal(saved.projectId, 'project-new');
  assert.equal(saved.workingDir.path, 'D:\\Work');
  assert.equal(saved.turns[0].supplements[0].status, 'applied');
  const writes = f.saves.length, updated = saved.updatedAt;
  f.controller.state(); f.controller.getConversationId();
  assert.equal(f.saves.length, writes);
  assert.equal(f.history.get(id).updatedAt, updated);
  f.controller.destroy();
});

test('a second turn resumes the session and route learned even before the launch response', async () => {
  const launch = deferred();
  const f = fixture({ run: (request, emit) => {
    f.calls.push({ request, emit });
    emit({ type: 'system', subtype: 'init', session_id: 'native-session' });
    emit({ type: 'job-done', exitCode: 0, finalResult: success('首轮') });
    return launch.promise;
  } });
  const pending = f.controller.submit({ text: 'first' });
  await waitFor(() => f.calls.length === 1);
  launch.resolve({ jobId: f.calls[0].request.runId, providerId: 'configured', providerRevision: 9, routeTier: 'sonnet' });
  await pending;
  await waitFor(() => !f.controller.isRunning());
  assert.equal(f.controller.isRunning(), false);
  assert.equal(f.history.get(f.controller.getConversationId()).sessionProviderId, 'configured');
  await f.controller.submit({ text: 'second' });
  await waitFor(() => !f.controller.isRunning());
  assert.equal(f.calls[1].request.sessionId, 'native-session');
  assert.equal(f.calls[1].request.sessionRoute.providerId, 'configured');
  assert.equal(f.calls[1].request.taskContext.turnRef.index, 1);
  assert.equal(f.calls[1].request.prompt, 'second');
  assert.equal(f.controller.state().conversation.turns.length, 2);
  f.controller.destroy();
});

test('a project move or explicit session invalidation during a run cannot reauthorize the stale native session', async () => {
  for (const mutation of ['workspace', 'mcp']) {
    const f = fixture();
    await f.controller.submit({ text: 'hello' });
    f.calls[0].emit({ type: 'system', subtype: 'init', session_id: 'old-native-session' });
    const record = f.history.get(f.controller.getConversationId());
    record.sessionId = null;
    record.carryContextOnNextTurn = mutation;
    if (mutation === 'workspace') record.workingDir = { path: 'D:\\NewProject', name: 'NewProject' };
    f.history.set(record.id, record);
    await f.finish('still preserve this result');
    const saved = f.history.get(record.id);
    assert.equal(saved.sessionId, null);
    assert.equal(saved.carryContextOnNextTurn, mutation);
    assert.equal(saved.turns[0].assistant, 'still preserve this result');
    f.controller.destroy();
  }
});

test('a managed workspace resolved by the runner preserves first-round session reuse without accepting a later move', async () => {
  for (const moved of [false, true]) {
    const managed = 'C:\\Users\\Fixture\\RelayProjects\\conversation';
    const f = fixture({ run: (request, emit) => {
      f.calls.push({ request, emit });
      const record = f.history.get(request.convId);
      record.workingDir = { path: managed, name: 'conversation' };
      f.history.set(record.id, record);
      emit({ type: 'system', subtype: 'init', session_id: 'managed-native-session' });
      return { jobId: request.runId, workingDir: managed, providerId: 'p', providerRevision: 1, routeTier: request.model };
    } });
    await f.controller.submit({ text: 'first' });
    if (moved) {
      const record = f.history.get(f.controller.getConversationId());
      record.workingDir = { path: 'D:\\Elsewhere', name: 'Elsewhere' };
      f.history.set(record.id, record);
    }
    await f.finish('completed');
    const saved = f.history.get(f.controller.getConversationId());
    assert.equal(saved.sessionId, moved ? null : 'managed-native-session');
    if (!moved) {
      await f.controller.submit({ text: 'second' });
      assert.equal(f.calls[1].request.sessionId, 'managed-native-session');
      assert.equal(f.calls[1].request.workingDir, managed);
      await f.finish('second completed');
    }
    f.controller.destroy();
  }
});

test('finishing a conversation deleted elsewhere does not resurrect it in history', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'hello' });
  const id = f.controller.getConversationId();
  f.history.delete(id);
  await f.finish('finished');
  assert.equal(f.history.has(id), false);
  assert.equal(f.controller.state().conversation.turns[0].assistant, 'finished');
  f.controller.destroy();
});

test('changing model or provider route starts fresh with context, never the old native route', async () => {
  let revision = 1;
  const f = fixture({ getSessionRoute: model => ({ providerId: 'p', providerRevision: revision, routeTier: model }) });
  await f.controller.submit({ text: '记住蓝色', model: 'sonnet' });
  f.calls[0].emit({ type: 'system', subtype: 'init', session_id: 'old-session' });
  await f.finish('好的，蓝色');
  await f.controller.submit({ text: '继续', model: 'opus' });
  assert.equal(f.calls[1].request.sessionId, null);
  assert.equal(f.calls[1].request.forceFreshSession, true);
  assert.match(f.calls[1].request.prompt, /以下是我们之前的对话记录/);
  assert.match(f.calls[1].request.prompt, /好的，蓝色/);
  await f.finish('继续完成');
  revision = 2;
  await f.controller.submit({ text: '再继续', model: 'opus' });
  assert.equal(f.calls[2].request.forceFreshSession, true);
  assert.match(f.calls[2].request.prompt, /继续完成/);
  await f.finish('结束');
  f.controller.destroy();
});

test('live followups use steer and do not pause, create extra turns or double-save accepted inputs', async () => {
  const f = fixture({ steer: request => {
    f.steers.push(request);
    const record = f.history.get(request.conversationId);
    const input = { id: request.messageId, text: request.prompt, status: 'applied', files: [], ts: '2026-09-08T02:00:00.000Z' };
    record.turns[0].supplements = [input];
    f.history.set(record.id, record);
    return { ok: true, input };
  } });
  await f.controller.submit({ text: 'initial' });
  const writes = f.saves.length;
  const result = await f.controller.submit({ text: 'follow-up' });
  assert.equal(result.ok, true);
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.pauses.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.saves.length, writes);
  assert.equal(f.controller.state().conversation.turns.length, 1);
  assert.equal(f.controller.state().conversation.turns[0].supplements[0].text, 'follow-up');
  assert.equal(f.steers[0].jobId, f.calls[0].request.runId);
  await f.finish('已结合新要求');
  assert.equal(f.history.get(f.controller.getConversationId()).turns[0].supplements.length, 1);
  f.controller.destroy();
});

test('a mini follow-up captures the current stream position before the transport awaits', async () => {
  const receipt = deferred();
  const f = fixture({ steer: request => { f.steers.push(copy(request)); return receipt.promise; } });
  await f.controller.submit({ text: '写一个日程' });
  const { emit } = f.calls[0];
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'midstream-itinerary' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先安排上午' } } });
  const sent = f.controller.submit({ text: '改成一天', messageId: '22222222-2222-4222-8222-222222222222' });
  await waitFor(() => f.steers.length === 1);
  const anchor = { version: 1, order: 3, messageId: 'midstream-itinerary', textLength: '先安排上午'.length };
  assert.deepEqual(f.steers[0].presentation, anchor);
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，再安排下午' } } });
  assert.deepEqual(f.steers[0].presentation, anchor, 'later text cannot move the original insertion point');
  receipt.resolve({ ok: true, input: { id: f.steers[0].messageId, text: '改成一天', status: 'queued', presentation: anchor } });
  await sent;
  assert.deepEqual(f.controller.state().conversation.turns[0].supplements[0].presentation, anchor);
  await f.finish('一天日程');
  assert.deepEqual(f.history.get(f.controller.getConversationId()).turns[0].supplements[0].presentation, anchor);
  f.controller.destroy();
});

test('a mini follow-up sent before any output receives the empty stream boundary', async () => {
  const f = fixture({ steer: request => {
    f.steers.push(copy(request));
    return { ok: true, input: { id: request.messageId, text: request.prompt, status: 'queued', presentation: request.presentation } };
  } });
  await f.controller.submit({ text: 'original' });
  await f.controller.submit({ text: 'change before model starts' });
  assert.deepEqual(f.steers[0].presentation, { version: 1, order: 0, messageId: null, textLength: 0 });
  assert.equal(f.controller.state().conversation.turns[0].output.eventOrder, 0);
  await f.finish('done'); f.controller.destroy();
});

test('mini input receipts change delivery state without advancing the assistant output clock', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'original' });
  const { emit } = f.calls[0];
  emit({ type: 'assistant', message: { id: 'receipt-clock', content: [{ type: 'text', text: '正在安排' }] } });
  const before = f.controller.state().conversation.turns[0];
  const input = { id: '22222222-2222-4222-8222-222222222222', text: '改成一天', files: [], status: 'queued',
    presentation: { version: 1, order: before.output.eventOrder, messageId: 'receipt-clock', textLength: '正在安排'.length } };
  for (const status of ['queued', 'applied', 'applied']) {
    emit({ type: 'system', subtype: 'relay_user_input', input: { ...input, status } });
    const turn = f.controller.state().conversation.turns[0];
    assert.equal(turn.output.eventOrder, before.output.eventOrder);
    assert.equal(turn.output.revision, before.output.revision);
    assert.equal(turn.preview, before.preview);
    assert.equal(turn.supplements.length, 1);
    assert.deepEqual(turn.supplements[0].presentation, input.presentation);
    assert.equal(turn.supplements[0].status, status);
  }
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'revised' } } });
  assert.equal(f.controller.state().conversation.turns[0].output.eventOrder, before.output.eventOrder + 1);
  await f.finish('一天日程');
  assert.deepEqual(f.history.get(f.controller.getConversationId()).turns[0].supplements[0].presentation, input.presentation);
  f.controller.destroy();
});

test('terminal mini save retains canonical presentation metadata received during finalization', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'original' });
  const { emit } = f.calls[0], id = f.controller.getConversationId();
  const input = { id: '22222222-2222-4222-8222-222222222222', text: '改成一天', status: 'queued',
    presentation: { version: 1, order: 4, messageId: 'visible-at-send', textLength: 18 } };
  emit({ type: 'system', subtype: 'relay_user_input', input });
  f.history.get(id).turns[0].supplements = [{ ...copy(input), status: 'applied' }];
  await f.finish('一天日程');
  const saved = f.history.get(id).turns[0];
  assert.equal(saved.supplements.length, 1);
  assert.equal(saved.supplements[0].status, 'applied');
  assert.deepEqual(saved.supplements[0].presentation, input.presentation);
  assert.deepEqual(f.controller.state().conversation.turns[0].supplements, saved.supplements);
  f.controller.destroy();
});

test('a stable-ID mini retry after a lost receipt preserves the first accepted insertion point', async () => {
  const { normalizeSupplement } = require('../live-supplement-input');
  let canonical;
  const f = fixture({ steer: request => {
    f.steers.push(copy(request));
    if (!canonical) {
      canonical = normalizeSupplement(request);
      f.history.get(request.conversationId).turns[0].supplements = [copy(canonical)];
      throw Error('synthetic lost receipt after host persistence');
    }
    assert.equal(request.messageId, canonical.id);
    return { ok: true, duplicate: true, input: copy(canonical) };
  } });
  await f.controller.submit({ text: 'original' });
  const { emit } = f.calls[0];
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'retry-stream' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'first' } } });
  const request = { text: '改成一天', messageId: '22222222-2222-4222-8222-222222222222' };
  assert.equal((await f.controller.submit(request)).ok, false);
  const firstAnchor = copy(canonical.presentation);
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' then more text' } } });
  assert.equal((await f.controller.submit(request)).duplicate, true);
  assert.notDeepEqual(f.steers[1].presentation, firstAnchor, 'the stream actually advanced between attempts');
  const turn = f.controller.state().conversation.turns[0];
  assert.equal(turn.supplements.length, 1);
  assert.deepEqual(turn.supplements[0].presentation, firstAnchor, 'the authoritative receipt wins over the recaptured position');
  assert.equal(f.calls.length, 1); assert.equal(f.pauses.length, 0);
  await f.finish('done');
  assert.deepEqual(f.history.get(f.controller.getConversationId()).turns[0].supplements[0].presentation, firstAnchor);
  f.controller.destroy();
});

test('unsupported steering reports failure without losing or prematurely stopping the active turn', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'initial' });
  const result = await f.controller.submit({ text: 'keep this draft' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_EXECUTOR');
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.controller.state().conversation.turns.length, 1);
  await f.finish('done');
  f.controller.destroy();
});

test('pause before the initial save completes never launches the task', async () => {
  const saving = deferred();
  const f = fixture({ saveConversation: async record => {
    f.history.set(record.id, copy(record));
    if (record.turns[0].status === 'running') await saving.promise;
  } });
  const submitting = f.controller.submit({ text: 'pause early' });
  await waitFor(() => f.controller.state().conversation != null);
  assert.equal((await f.controller.pause()).preparing, true);
  saving.resolve();
  await submitting;
  assert.equal(f.calls.length, 0);
  assert.equal(f.pauses.length, 0);
  assert.equal(f.controller.isRunning(), false);
  assert.equal(f.controller.state().conversation.turns[0].status, 'paused');
  f.controller.destroy();
});

test('queued cancellation and late startup rejection cannot terminate the next turn', async () => {
  const launch = deferred();
  const f = fixture({ run: (request, emit) => { f.calls.push({ request, emit }); return f.calls.length === 1 ? launch.promise : { jobId: request.runId }; },
    pause: async id => { launch.resolve({ error: '任务已取消', code: 'TURN_CANCELED' }); return { paused: true, settled: true, jobId: id }; } });
  const submitting = f.controller.submit({ text: 'queued' });
  await waitFor(() => f.calls.length === 1);
  await f.controller.pause(); await submitting;
  assert.equal(f.controller.state().conversation.turns[0].status, 'paused');
  await f.controller.submit({ text: 'next' });
  assert.match(f.calls[1].request.prompt, /用户：queued/, 'the original paused request survives without a native session');
  f.calls[0].emit({ type: 'job-done', exitCode: -1, error: 'late old event' });
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.controller.state().conversation.turns[1].error, null);
  await f.finish('next done');
  f.controller.destroy();
});

test('durable submission acknowledges a queued task before its launch promise resolves so pause stays available', async () => {
  const launch = deferred();
  const f = fixture({ run: (request, emit) => { f.calls.push({ request, emit }); return launch.promise; },
    pause: async () => { launch.resolve({ error: '任务已取消', code: 'TURN_CANCELED' }); return { paused: true, settled: true }; } });
  let receipt;
  const submitted = f.controller.submit({ text: 'wait for capacity' }).then(value => { receipt = value; });
  await waitFor(() => !!receipt);
  assert.equal(receipt.ok, true);
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.history.get(receipt.conversationId).turns[0].user, 'wait for capacity');
  assert.equal((await f.controller.pause()).ok, true);
  await submitted;
  assert.equal(f.controller.isRunning(), false);
  assert.equal(f.controller.state().conversation.turns[0].status, 'paused');
  f.controller.destroy();
});

test('a normal completion racing with pause retains the final answer', async () => {
  const f = fixture({ pause: async () => {
    f.calls[0].emit({ type: 'job-done', exitCode: 0, finalResult: success('already finished') });
    return { paused: false, settled: true, alreadyFinished: true };
  } });
  await f.controller.submit({ text: 'hello' });
  await f.controller.pause();
  assert.equal(f.controller.state().conversation.turns[0].status, 'complete');
  assert.equal(f.controller.state().conversation.turns[0].assistant, 'already finished');
  f.controller.destroy();
});

test('startup and final errors persist as errors, never as assistant answers or usable new sessions', async () => {
  const f = fixture({ run: (request, emit) => {
    f.calls.push({ request, emit });
    emit({ type: 'system', subtype: 'init', session_id: 'bad-session' });
    return { error: 'model is unavailable' };
  } });
  const result = await f.controller.submit({ text: 'hello' });
  assert.equal(result.ok, true, 'the user message was saved and accepted before execution failed');
  await waitFor(() => !f.controller.isRunning());
  assert.equal(f.controller.isRunning(), false);
  const turn = f.controller.state().conversation.turns[0];
  assert.equal(turn.status, 'error');
  assert.equal(turn.assistant, '');
  assert.match(turn.error, /model is unavailable/);
  assert.equal(f.controller.state().conversation.sessionId, null);
  f.controller.destroy();

  const g = fixture();
  await g.controller.submit({ text: 'hello' });
  g.calls[0].emit({ type: 'job-done', exitCode: 0, finalResult: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'provider rejected' } });
  await waitFor(() => !g.controller.isRunning());
  assert.equal(g.controller.state().conversation.turns[0].assistant, '');
  assert.equal(g.controller.state().conversation.turns[0].status, 'error');
  g.controller.destroy();
});

test('history save failures release busy state and keep a retryable empty composer contract', async () => {
  const f = fixture({ saveConversation: () => { throw Error('disk full'); } });
  const result = await f.controller.submit({ text: 'retry me' });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.isRunning(), false);
  assert.equal(f.controller.getConversationId(), null);
  f.controller.destroy();
});

test('a failed terminal history write does not leave the completed task running', async () => {
  const f = fixture({ saveConversation: record => {
    if (record.turns.at(-1).status === 'complete') throw Error('disk full');
    f.history.set(record.id, copy(record));
  } });
  await f.controller.submit({ text: 'hello' });
  await f.finish('answer survives');
  assert.equal(f.controller.isRunning(), false);
  const turn = f.controller.state().conversation.turns[0];
  assert.equal(turn.assistant, 'answer survives');
  assert.match(turn.saveError, /disk full/);
  f.controller.destroy();
});

test('a later submit retries a failed final save before loading history or constructing continuation context', async () => {
  let failOnce = true;
  const f = fixture({ saveConversation: record => {
    if (record.turns.at(-1).status === 'complete' && failOnce) { failOnce = false; throw Error('temporary disk failure'); }
    f.history.set(record.id, copy(record));
  } });
  await f.controller.submit({ text: 'first' });
  await f.finish('only surviving answer');
  assert.equal(f.history.get(f.controller.getConversationId()).turns[0].assistant, '');
  assert.match(f.controller.state().conversation.turns[0].saveError, /temporary disk failure/);
  assert.equal((await f.controller.submit({ text: 'continue' })).ok, true);
  const saved = f.history.get(f.controller.getConversationId());
  assert.equal(saved.turns[0].assistant, 'only surviving answer');
  assert.equal(saved.turns[0].saveError, undefined);
  assert.match(f.calls[1].request.prompt, /only surviving answer/);
  await f.finish('continued');
  f.controller.destroy();
});

test('persistent terminal-save failure rejects submit and newChat while retaining the sole complete answer', async () => {
  const f = fixture({ saveConversation: record => {
    if (record.turns.at(-1).status === 'complete') throw Error('disk still full');
    f.history.set(record.id, copy(record));
  } });
  await f.controller.submit({ text: 'first' });
  await f.finish('keep this answer');
  const id = f.controller.getConversationId();
  const attempted = await f.controller.submit({ text: 'draft should remain' });
  assert.equal(attempted.ok, false);
  assert.match(attempted.error, /上一条回复尚未保存/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.isRunning(), false);
  assert.equal((await f.controller.newChat()).code, 'HISTORY_SAVE_FAILED');
  assert.equal((await f.controller.flush()).code, 'HISTORY_SAVE_FAILED');
  assert.equal(f.controller.getConversationId(), id);
  assert.equal(f.controller.state().conversation.turns.length, 1);
  assert.equal(f.controller.state().conversation.turns[0].assistant, 'keep this answer');
  assert.match(f.controller.state().conversation.turns[0].saveError, /disk still full/);
  f.controller.destroy();
});

test('newChat retries a recoverable terminal save before clearing its in-memory conversation', async () => {
  let failed = false;
  const f = fixture({ saveConversation: record => {
    if (record.turns.at(-1).status === 'complete' && !failed) { failed = true; throw Error('temporarily unavailable'); }
    f.history.set(record.id, copy(record));
  } });
  await f.controller.submit({ text: 'first' });
  await f.finish('saved before clearing');
  const id = f.controller.getConversationId();
  assert.equal((await f.controller.newChat()).ok, true);
  assert.equal(f.controller.getConversationId(), null);
  assert.equal(f.history.get(id).turns[0].assistant, 'saved before clearing');
  assert.equal(f.history.get(id).turns[0].saveError, undefined);
  f.controller.destroy();
});

test('flush retries the unsaved answer before a caller opens its history record', async () => {
  let failed = false;
  const f = fixture({ saveConversation: record => {
    if (record.turns.at(-1).status === 'complete' && !failed) { failed = true; throw Error('temporary write error'); }
    f.history.set(record.id, copy(record));
  } });
  await f.controller.submit({ text: 'first' });
  await f.finish('answer for main window');
  const id = f.controller.getConversationId();
  assert.equal((await f.controller.flush()).ok, true);
  assert.equal(f.controller.getConversationId(), id);
  assert.equal(f.history.get(id).turns[0].assistant, 'answer for main window');
  assert.equal(f.controller.state().conversation.turns[0].saveError, undefined);
  f.controller.destroy();
});

test('new chat is blocked while running; destroying a renderer subscription does not cancel persistence', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'hello' });
  const id = f.controller.getConversationId();
  assert.equal((await f.controller.newChat()).code, 'RUNNING');
  f.controller.destroy();
  const count = f.states.length;
  await f.finish('completed while hidden');
  assert.equal(f.states.length, count);
  assert.equal(f.pauses.length, 0);
  assert.equal(f.history.get(id).turns[0].assistant, 'completed while hidden');
});

test('stream publication is throttled while snapshots stay current and immutable', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'hello' });
  const initial = f.states.length;
  for (let i = 0; i < 100; i++) f.calls[0].emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } });
  assert.equal(f.states.length, initial);
  const snapshot = f.controller.state();
  assert.equal(snapshot.conversation.turns[0].preview.length, 100);
  assert.equal(snapshot.conversation.turns[0].output.messages[0].blocks[0].text.length, 100);
  snapshot.conversation.turns[0].user = 'mutated';
  assert.equal(f.controller.state().conversation.turns[0].user, 'hello');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.states.length, initial + 1);
  await f.finish('done');
  f.controller.destroy();
});

test('idle snapshots expose the configured default model without creating history', () => {
  const f = fixture({ getDefaultModel: () => 'opus' });
  assert.equal(f.controller.state().model, 'opus');
  assert.equal(f.history.size, 0);
  f.controller.destroy();
});

test('changing the global default preserves an existing mini conversation and applies to the next new chat', async () => {
  let defaultModel = 'sonnet';
  const f = fixture({ getDefaultModel: () => defaultModel });
  await f.controller.submit({ text: 'first conversation' });
  assert.equal(f.calls[0].request.model, 'sonnet');
  defaultModel = 'opus';
  assert.equal(f.controller.state().conversation.model, 'sonnet');
  await f.finish('first response');
  await f.controller.submit({ text: 'same conversation' });
  assert.equal(f.calls[1].request.model, 'sonnet');
  await f.finish('second response');
  await f.controller.newChat();
  assert.equal(f.controller.state().model, 'opus');
  await f.controller.submit({ text: 'new conversation' });
  assert.equal(f.calls[2].request.model, 'opus');
  await f.finish('new response');
  f.controller.destroy();
});

test('shutdown persists interrupted output before application cleanup and rejects new submissions', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'long task' });
  f.calls[0].emit({ type: 'system', subtype: 'init', session_id: 'native' });
  f.calls[0].emit({ type: 'assistant', message: { id: 'partial', content: [{ type: 'text', text: 'still working' }] } });
  await f.controller.shutdown();
  const saved = f.history.get(f.controller.getConversationId());
  assert.equal(saved.turns[0].status, 'interrupted');
  assert.equal(saved.turns[0].assistant, '');
  assert.equal(saved.turns[0].output.messages[0].blocks[0].text, 'still working');
  assert.match(saved.turns[0].outputNotice, /已中断/);
  assert.equal(saved.carryContextOnNextTurn, 'interrupted');
  assert.equal(saved.sessionId, null);
  assert.equal(saved.paused, undefined);
  assert.equal(f.controller.isRunning(), false);
  assert.equal((await f.controller.submit({ text: 'after quit' })).code, 'DESTROYED');
  f.calls[0].emit({ type: 'job-done', exitCode: 0, finalResult: success('too late') });
  assert.equal(f.history.get(saved.id).turns[0].status, 'interrupted');
});

test('shutdown while the initial save is pending never dispatches and persists interrupted instead of paused', async () => {
  const saving = deferred();
  const f = fixture({ saveConversation: async record => {
    if (record.turns[0].status === 'running') await saving.promise;
    f.history.set(record.id, copy(record));
  } });
  const submitting = f.controller.submit({ text: 'queued during quit' });
  await waitFor(() => f.controller.state().conversation != null);
  const shuttingDown = f.controller.shutdown();
  saving.resolve();
  await Promise.all([submitting, shuttingDown]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.history.get(f.controller.getConversationId()).turns[0].status, 'interrupted');
});

test('a successful final result winning the pause race survives an aborted wrapper', async () => {
  const f = fixture({ pause: async () => {
    f.calls[0].emit({ type: 'job-done', aborted: true, exitCode: 0, finalResult: success('final answer') });
    return { paused: false, settled: true, alreadyFinished: true };
  } });
  await f.controller.submit({ text: 'hello' });
  await f.controller.pause();
  assert.equal(f.controller.state().conversation.turns[0].assistant, 'final answer');
  assert.equal(f.controller.state().conversation.turns[0].status, 'complete');
  f.controller.destroy();
});

function permissionFixture(initial = {}) {
  const defaults = { permissionMode: 'default', executionMode: { kind: 'default' }, revision: 1, ...initial };
  const updates = [];
  const dto = (record, id = null) => ({ ok: true, conversationId: id,
    permissionMode: record.permissionMode, executionMode: copy(record.executionMode),
    revision: record.permissionRevision || record.revision || 1,
    legacyPlan: !!(record.permissionLegacyPlan || record.legacyPlan) });
  const f = fixture({
    getPermissions: id => id ? (f.history.has(id) ? dto(f.history.get(id), id)
      : { ok: false, code: 'CONVERSATION_NOT_FOUND', error: '对话不存在' }) : dto(defaults),
    setPermissions: input => {
      updates.push(copy(input));
      const record = f.history.get(input.conversationId);
      if (!record) return { ok: false, error: '对话不存在' };
      record.permissionMode = input.permissionMode;
      record.permissionRevision = (record.permissionRevision || 0) + 1;
      if (input.executionMode) record.executionMode = copy(input.executionMode);
      return dto(record, record.id);
    },
  });
  return { ...f, defaults, updates };
}

test('mini preserves a migrated global plan through first send and later default changes', async () => {
  const f = permissionFixture({ executionMode: { kind: 'plan' }, legacyPlan: true });
  await f.controller.submit({ text: '先调查' });
  assert.deepEqual(f.calls[0].request.executionMode, { kind: 'plan' });
  assert.equal(f.controller.state().conversation.permissionLegacyPlan, true);
  assert.deepEqual(f.updates[0].executionMode, { kind: 'plan' }, 'a captured plan never becomes an explicit exit from legacy plan');
  await f.finish('计划');
  f.defaults.permissionMode = 'bypassPermissions'; f.defaults.executionMode = { kind: 'default' }; f.defaults.legacyPlan = false;
  await f.controller.submit({ text: '继续调查', permissionMode: 'bypassPermissions', executionMode: { kind: 'default' } });
  assert.deepEqual(f.calls[1].request.executionMode, { kind: 'plan' });
  assert.equal(f.updates.length, 1, 'continuing history must not apply a new-chat or renderer default');
  await f.finish('仍保持计划'); f.controller.destroy();
});

test('first mini send freezes the visible draft permission before dispatch', async () => {
  const f = permissionFixture({ permissionMode: 'bypassPermissions' });
  await f.controller.submit({ text: '当前草稿仍要求批准', permissionMode: 'acceptEdits', executionMode: { kind: 'default' } });
  const record = f.history.get(f.controller.getConversationId());
  assert.equal(f.updates[0].permissionMode, 'acceptEdits');
  assert.equal(record.permissionMode, 'acceptEdits');
  assert.equal(f.controller.state().conversation.permissionMode, 'acceptEdits');
  await f.finish('完成');
  await f.controller.newChat();
  await f.controller.submit({ text: '新对话读取新默认' });
  assert.equal(f.updates[1].permissionMode, 'bypassPermissions');
  await f.finish('完成'); f.controller.destroy();
});

test('main-window permission changes survive mini final persistence and the next resumed turn', async () => {
  const f = permissionFixture();
  await f.controller.submit({ text: '执行' });
  const record = f.history.get(f.controller.getConversationId());
  record.permissionMode = 'acceptEdits'; record.permissionRevision = 9;
  record.executionMode = { kind: 'plan' }; record.permissionLegacyPlan = true;
  await f.finish('已有输出');
  const final = f.history.get(record.id);
  assert.equal(final.permissionMode, 'acceptEdits'); assert.equal(final.permissionRevision, 9);
  assert.deepEqual(final.executionMode, { kind: 'plan' });
  await f.controller.submit({ text: '后续分析', permissionMode: 'bypassPermissions', executionMode: { kind: 'default' } });
  assert.deepEqual(f.calls[1].request.executionMode, { kind: 'plan' });
  assert.equal(f.controller.state().conversation.permissionMode, 'acceptEdits');
  assert.equal(f.updates.length, 1);
  await f.finish('后续计划'); f.controller.destroy();
});

test('failed initial permission resolution cannot create history or start a mini task', async () => {
  const f = fixture({ getPermissions: async () => ({ ok: false, error: '权限不可用' }) });
  assert.equal((await f.controller.submit({ text: '不要猜测权限' })).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.history.size, 0);
  assert.equal(f.controller.isRunning(), false); f.controller.destroy();
});

test('a failed permission update after first history save settles that turn without dispatch', async () => {
  const f = fixture({
    getPermissions: async id => ({ ok: true, conversationId: id || null, permissionMode: 'default', executionMode: { kind: 'default' }, revision: 1 }),
    setPermissions: async () => ({ ok: false, error: '权限更新失败' }),
  });
  const result = await f.controller.submit({ text: '保留可重试记录', permissionMode: 'acceptEdits' });
  assert.equal(result.ok, false); assert.match(result.error, /权限更新失败/);
  assert.equal(f.calls.length, 0); assert.equal(f.controller.isRunning(), false);
  const record = f.history.get(f.controller.getConversationId());
  assert.equal(record.turns[0].status, 'error'); assert.match(record.turns[0].error, /权限更新失败/);
  f.controller.destroy();
});

test('mini uses first successful turn context for an asynchronous AI title and retains the input fallback until ready', async () => {
  const pending = deferred(), requests = [];
  const f = fixture({ generateTitle: text => { requests.push(text); return pending.promise; } });
  await f.controller.submit({ text: '帮我整理项目交付说明' });
  const id = f.controller.getConversationId();
  assert.equal(f.history.get(id).title, '帮我整理项目交付说明');
  assert.equal(requests.length, 0);
  await f.finish('已整理安装步骤和验证结果');
  assert.deepEqual(requests, ['用户:帮我整理项目交付说明\n助手:已整理安装步骤和验证结果']);
  const updatedAt = f.history.get(id).updatedAt;
  pending.resolve({ title: '项目交付与验证' });
  await waitFor(() => f.history.get(id).titleGenerated);
  assert.equal(f.history.get(id).title, '项目交付与验证');
  assert.equal(f.history.get(id).updatedAt, updatedAt);
  assert.equal(f.controller.state().conversation.title, '项目交付与验证');
  await f.controller.submit({ text: '继续补充' });
  await f.finish('完成补充');
  assert.equal(requests.length, 1);
  f.controller.destroy();
});

test('late mini title preserves a continued turn, pin state and streaming memory', async () => {
  const pending = deferred();
  const f = fixture({ generateTitle: () => pending.promise });
  await f.controller.submit({ text: '首条需求' });
  await f.finish('首条结果');
  const id = f.controller.getConversationId();
  await f.controller.submit({ text: '后续需求' });
  f.history.get(id).pinned = true;
  f.calls[1].emit({ type: 'assistant', message: { id: 'second', content: [{ type: 'text', text: '正在处理' }] } });
  pending.resolve({ title: '主题摘要' });
  await waitFor(() => f.history.get(id).titleGenerated);
  assert.equal(f.history.get(id).turns.length, 2);
  assert.equal(f.history.get(id).pinned, true);
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.controller.state().conversation.turns[1].preview, '正在处理');
  await f.finish('后续结果');
  assert.equal(f.history.get(id).title, '主题摘要');
  f.controller.destroy();
});

test('mini title completion follows its original conversation across newChat', async () => {
  const pending = deferred();
  const f = fixture({ generateTitle: () => pending.promise });
  await f.controller.submit({ text: '原来的问题' }); await f.finish('结果');
  const id = f.controller.getConversationId();
  await f.controller.newChat();
  pending.resolve({ title: '原会话摘要' });
  await waitFor(() => f.history.get(id).titleGenerated);
  assert.equal(f.controller.state().conversation, null);
  assert.equal(f.history.get(id).title, '原会话摘要');
  f.controller.destroy();
});

test('mini never overwrites a manual rename or recreates a deleted conversation after inference', async () => {
  for (const action of ['rename', 'delete']) {
    const pending = deferred();
    const f = fixture({ generateTitle: () => pending.promise });
    await f.controller.submit({ text: '原文' }); await f.finish('结果');
    const id = f.controller.getConversationId();
    if (action === 'rename') Object.assign(f.history.get(id), { title: '手动名称', titleManual: true });
    else f.history.delete(id);
    const count = f.saves.length;
    pending.resolve({ title: '不应写入' }); await tick(); await tick();
    assert.equal(f.saves.length, count);
    assert.equal(f.history.get(id)?.title, action === 'rename' ? '手动名称' : undefined);
    f.controller.destroy();
  }
});

test('failed title generation preserves fallback without generated flag or blocking another turn', async () => {
  const f = fixture({ generateTitle: async () => { throw Error('synthetic title failure'); } });
  await f.controller.submit({ text: '兜底原文' }); await f.finish('结果'); await tick();
  const record = f.history.get(f.controller.getConversationId());
  assert.equal(record.title, '兜底原文'); assert.equal(record.titleGenerated, undefined);
  assert.equal((await f.controller.submit({ text: '仍可继续' })).ok, true);
  await f.finish('结果二'); f.controller.destroy();
});

test('paused and failed first turns do not invoke the title model', async () => {
  for (const event of [{ exitCode: 1, error: 'synthetic failure' }, { exitCode: 1, aborted: true }]) {
    let count = 0;
    const f = fixture({ generateTitle: async () => { count++; return { title: '错误标题' }; } });
    await f.controller.submit({ text: '原文' });
    f.calls[0].emit({ type: 'job-done', ...event });
    await waitFor(() => !f.controller.isRunning()); await tick();
    assert.equal(count, 0); f.controller.destroy();
  }
});


test('mini task duration spans preparation and retries and survives history persistence', async () => {
  const start = Date.UTC(2026, 8, 12, 1, 0, 0);
  let clock = start;
  const f = fixture({ now: () => clock, getSessionRoute: async () => {
    clock += 30000; return { providerId: 'fixture', providerRevision: 1 };
  } });
  const sent = await f.controller.submit({ text: 'Synthetic task clock check' });
  await waitFor(() => f.calls.length === 1);
  const { request, emit } = f.calls[0];
  assert.equal(request.taskStartedAt, start);
  assert.equal(f.history.get(sent.conversationId).turns[0].ts, new Date(start).toISOString());
  emit({ type: 'result', subtype: 'success', result: 'Stage one', duration_ms: 12000 });
  assert.equal(f.controller.isRunning(), true);
  // Child terminal clocks cannot finish or replace the parent task's clock.
  emit({ type: 'job-done', parentToolUseId: 'child', exitCode: 0,
    relay_task_started_at: start + 1000, relay_task_finished_at: start + 3000 });
  assert.equal(f.controller.isRunning(), true);
  clock = start + 4841000;
  const result = { ...success('Final delivery'), duration_ms: 12000 };
  emit(result);
  emit({ type: 'job-done', exitCode: 0, finalResult: result,
    relay_task_started_at: start, relay_task_finished_at: clock, relay_task_duration_ms: 4841000 });
  await waitFor(() => !f.controller.isRunning());
  const turn = f.history.get(sent.conversationId).turns[0];
  assert.equal(turn.taskStartedAt, start);
  assert.equal(turn.taskFinishedAt, clock);
  assert.equal(turn.taskDurationMs, 4841000);
  assert.equal(turn.status, 'complete');
  f.controller.destroy();
});

test('mini failed launch retains authoritative task clock without assistant text', async () => {
  const start = Date.UTC(2026, 8, 12, 2, 0, 0);
  const f = fixture({ now: () => start, run: () => ({ error: 'Synthetic connection failure',
    relay_task_started_at: start, relay_task_finished_at: start + 240000, relay_task_duration_ms: 240000 }) });
  const sent = await f.controller.submit({ text: 'Synthetic failure clock check' });
  await waitFor(() => !f.controller.isRunning());
  const turn = f.history.get(sent.conversationId).turns[0];
  assert.equal(turn.status, 'error');
  assert.equal(turn.assistant, '');
  assert.equal(turn.assistantTs, undefined);
  assert.equal(turn.taskStartedAt, start);
  assert.equal(turn.taskFinishedAt, start + 240000);
  assert.equal(turn.taskDurationMs, 240000);
  f.controller.destroy();
});


test('mini publishes child-only progress after a stage response without another parent event', async () => {
  const f = fixture();
  await f.controller.submit({ text: 'Synthetic background agent task' });
  const { emit } = f.calls[0];
  emit({ type: 'assistant', message: { id: 'stage', content: [{ type: 'text', text: 'Stage complete; agent continues.' }] } });
  emit(success('Stage complete; agent continues.'));
  await new Promise(resolve => setTimeout(resolve, 45));
  const before = f.states.length;
  const parentLabel = f.states.at(-1).conversation.turns[0].activityLabel;
  emit({ type: 'assistant', parentToolUseId: 'child', message: { id: 'child-progress', content: [{ type: 'text', text: 'Background progress' }] } });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(f.states.length > before, 'child-only events must publish a renderer snapshot');
  assert.ok(f.states.at(-1).conversation.turns[0].output.messages.some(message => message.id === 'child-progress'));
  assert.equal(f.states.at(-1).conversation.turns[0].activityLabel, parentLabel);
  assert.equal(f.controller.isRunning(), true);
  assert.equal(f.steers.length, 0);
  await f.finish('Delivery'); f.controller.destroy();
});


test('explicit mini resume accumulates active segments, excludes paused gaps and does not add user speech', async () => {
  const Continuity = require('../renderer/task-continuity');
  let now = Date.UTC(2026, 8, 12, 1), startedAt = now;
  const f = fixture({ now: () => new Date(now).toISOString() });
  const sent = await f.controller.submit({ text: 'deliver the original goal', permissionMode: 'default', executionMode: { kind: 'goal' } });
  await waitFor(() => f.calls.length === 1);
  now += 36000; await f.controller.pause();
  let first = f.history.get(sent.conversationId).turns[0];
  assert.equal(first.taskDurationMs, 36000);
  const rootId = first.runId;
  now += 60 * 60 * 1000;
  await f.controller.submit({ resume: true });
  await waitFor(() => f.calls.length === 2);
  const request = f.calls[1].request;
  assert.ok(request.prompt.endsWith(Continuity.RESUME_PROMPT));
  assert.equal(request.taskContext.userPrompt, 'deliver the original goal');
  assert.equal(request.taskContext.inputKind, 'resume');
  assert.equal(request.taskContext.taskRun.taskId, rootId);
  assert.equal(request.taskContext.taskRun.elapsedBeforeMs, 36000);
  assert.equal(request.executionMode.kind, 'goal');
  now += 34000; await f.controller.pause();
  now += 30 * 60 * 1000;
  await f.controller.submit({ resume: true });
  await waitFor(() => f.calls.length === 3);
  now += 33000; await f.finish('delivered');
  const saved = f.history.get(sent.conversationId);
  assert.equal(saved.turns.length, 3);
  assert.deepEqual(saved.turns.map(t => t.user), ['deliver the original goal', '', '']);
  assert.deepEqual(saved.turns.map(t => t.taskDurationMs), [36000, 70000, 103000]);
  assert.equal(saved.turns[2].taskStartedAt, startedAt);
  assert.equal(Continuity.activeDuration(JSON.parse(JSON.stringify(saved.turns[2].taskRun)), now + 86400000), 103000);
  assert.equal(saved.paused, undefined);
  f.controller.destroy();
});

test('normal mini messages matching the internal resume text remain separate visible tasks', async () => {
  const { RESUME_PROMPT } = require('../renderer/task-continuity');
  let now = Date.UTC(2026, 8, 12, 2);
  const f = fixture({ now: () => new Date(now).toISOString() });
  const sent = await f.controller.submit({ text: 'first request' });
  await waitFor(() => f.calls.length === 1);
  now += 5000; await f.controller.pause(); now += 60000;
  await f.controller.submit({ text: RESUME_PROMPT });
  await waitFor(() => f.calls.length === 2);
  now += 4000; await f.finish('answer');
  const turns = f.history.get(sent.conversationId).turns;
  assert.equal(turns[1].user, RESUME_PROMPT);
  assert.equal(turns[1].inputKind, undefined);
  assert.notEqual(turns[1].taskRun.taskId, turns[0].taskRun.taskId);
  assert.equal(turns[1].taskDurationMs, 4000);
  f.controller.destroy();
});

test('mini resumes from the durable paused record and refuses a stale completed pointer', async () => {
  let now = Date.UTC(2026, 8, 12, 3);
  const f = fixture({ now: () => new Date(now).toISOString() });
  const sent = await f.controller.submit({ text: 'first request' });
  await waitFor(() => f.calls.length === 1);
  now += 5000; await f.controller.pause(); now += 60000;
  const saved = f.history.get(sent.conversationId);
  saved.turns[0].status = 'complete';
  const result = await f.controller.submit({ resume: true });
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.history.get(sent.conversationId).turns.length, 1);
  f.controller.destroy();
});

test('mini pause during resume preparation retains the same task and counts preparation time', async () => {
  let now = Date.UTC(2026, 8, 12, 4);
  const gate = deferred(); let held = false;
  const f = fixture({ now: () => new Date(now).toISOString(),
    getSessionRoute: async () => { if (held) await gate.promise; return null; } });
  const sent = await f.controller.submit({ text: 'deliver this' });
  await waitFor(() => f.calls.length === 1);
  now += 12000; await f.controller.pause(); now += 100000;
  held = true;
  const pending = f.controller.submit({ resume: true });
  await tick();
  now += 8000; await f.controller.pause(); gate.resolve(); await pending;
  await waitFor(() => !f.controller.isRunning());
  const saved = f.history.get(sent.conversationId);
  assert.equal(f.calls.length, 1);
  assert.equal(saved.turns[1].status, 'paused');
  assert.equal(saved.turns[1].taskDurationMs, 20000);
  assert.equal(saved.turns[1].taskRun.taskId, saved.turns[0].runId);
  f.controller.destroy();
});


test('a failed explicit mini resume preserves its error and permits another same-task resume', async () => {
  let now = Date.UTC(2026, 8, 12, 5);
  const f = fixture({ now: () => new Date(now).toISOString() });
  const sent = await f.controller.submit({ text: 'deliver this' });
  await waitFor(() => f.calls.length === 1);
  now += 36000; await f.controller.pause(); now += 100000;
  await f.controller.submit({ resume: true });
  await waitFor(() => f.calls.length === 2);
  now += 3000;
  f.calls[1].emit({ type: 'job-done', exitCode: -1, error: 'provider is offline' });
  await waitFor(() => !f.controller.isRunning());
  let saved = f.history.get(sent.conversationId);
  assert.equal(saved.turns[1].status, 'error');
  assert.equal(saved.turns[1].error, 'provider is offline');
  assert.equal(saved.paused.runId, saved.turns[1].runId);
  now += 200000;
  const retried = await f.controller.submit({ resume: true });
  assert.equal(retried.ok, true);
  await waitFor(() => f.calls.length === 3);
  now += 64000; await f.finish('delivered');
  saved = f.history.get(sent.conversationId);
  assert.equal(saved.turns[2].taskDurationMs, 103000);
  assert.equal(saved.turns[2].taskRun.taskId, saved.turns[0].runId);
  assert.equal(saved.turns[1].error, 'provider is offline');
  assert.equal(saved.paused, undefined);
  f.controller.destroy();
});


test('idle mini refresh adopts main-window completion but cannot replace an active stream', async () => {
  const f = fixture();
  const sent = await f.controller.submit({text:'task'});
  await waitFor(() => f.calls.length === 1);
  await f.controller.refresh();
  assert.equal(f.controller.isRunning(), true);
  await f.controller.pause();
  const saved = f.history.get(sent.conversationId);
  saved.turns[0].status = 'complete'; saved.turns[0].assistant = 'completed in main'; delete saved.paused;
  await f.controller.refresh();
  const current = f.controller.state().conversation;
  assert.equal(current.turns[0].assistant, 'completed in main');
  assert.equal(current.paused, undefined);
  assert.equal((await f.controller.submit({resume:true})).ok, false);
  assert.equal(f.controller.state().conversation.paused, undefined);
  f.controller.destroy();
});


test('mini stores the real host TaskClock cumulative duration when the resumed segment is longer', async () => {
  const { TaskClock } = require('../task-clock');
  let now = Date.UTC(2026, 8, 12, 6);
  const f = fixture({ now: () => new Date(now).toISOString() });
  const sent = await f.controller.submit({text:'original task'});
  await waitFor(() => f.calls.length === 1);
  const first = new TaskClock({ taskRun: f.calls[0].request.taskContext.taskRun, now: () => now });
  now += 36000;
  f.calls[0].emit(first.stamp({type:'job-done',exitCode:-1,aborted:true}));
  await waitFor(() => !f.controller.isRunning());
  now += 86400000;
  await f.controller.submit({resume:true});
  await waitFor(() => f.calls.length === 2);
  const second = new TaskClock({ taskRun: f.calls[1].request.taskContext.taskRun, now: () => now });
  now += 67000;
  const event = second.stamp({type:'job-done',exitCode:0,finalResult:success('complete')});
  assert.equal(event.relay_task_duration_ms, 103000);
  f.calls[1].emit(event);
  await waitFor(() => !f.controller.isRunning());
  assert.equal(f.history.get(sent.conversationId).turns[1].taskDurationMs, 103000);
  f.controller.destroy();
});


test('the first logical mini task still generates its title when completion follows a pause', async () => {
  const titles = []; let now = Date.UTC(2026, 8, 12, 7);
  const f = fixture({ now: () => new Date(now).toISOString(), generateTitle: async text => {
    titles.push(text); return { title: '完成原任务' };
  } });
  const sent = await f.controller.submit({ text: 'original title subject' });
  await waitFor(() => f.calls.length === 1);
  now += 12000; await f.controller.pause();
  assert.equal(titles.length, 0);
  now += 100000; await f.controller.submit({resume:true});
  await waitFor(() => f.calls.length === 2);
  now += 8000; await f.finish('delivered result');
  await waitFor(() => f.history.get(sent.conversationId).titleGenerated);
  assert.equal(titles.length, 1);
  assert.equal(titles[0], '用户:original title subject\n助手:delivered result');
  assert.equal(f.history.get(sent.conversationId).title, '完成原任务');
  f.controller.destroy();
});
