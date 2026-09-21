'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../renderer/activity-stream');
const activity = global.window.RelayActivity;

function ingest(state, event) {
  activity.ingest(state, event);
  return state;
}

test('task transcripts stay out of live activity links while explicit deliverables remain', () => {
  const state = activity.createState();
  ingest(state, { type: 'system', subtype: 'task_notification', task_id: 'background-one', status: 'completed',
    output_file: '/tmp/task.output', resource_links: [
      { uri: '/tmp/task.output', title: 'Raw transcript' },
      { uri: '/project/report.md', title: '交付报告' },
    ] });
  const task = state.items.find(item => item.taskId === 'background-one');
  assert.deepEqual(task.resources.map(resource => resource.uri), ['/project/report.md']);
  assert.match(activity.renderItem(task, false), /交付报告/);
  assert.doesNotMatch(activity.renderItem(task, false), /task\.output|查看任务输出/);
  assert.deepEqual(activity.taskResources({ output_file: '/tmp/task.output' }), []);
});

test('legacy task transcript buttons disappear on history restoration without shifting real resource indexes', () => {
  const resources = [{ uri: '/tmp/old.output', kind: 'file', name: '查看任务输出' },
    { uri: '/project/report.md', kind: 'file', name: '交付报告' }];
  const state = activity.hydrate({ phase: 'complete', items: [{ id: 'task:old', type: 'task', taskId: 'old', status: 'success', resources }] });
  const html = activity.renderItem(state.items[0], false);
  assert.doesNotMatch(html, /查看任务输出|old\.output|data-resource-index="0"/);
  assert.match(html, /data-resource-index="1"/);
  assert.match(html, /交付报告/);
  assert.deepEqual(activity.serialize(state).items[0].resources, resources);
});

test('cold initialization and API retry have distinct progress and repeated retries update one row', () => {
  const state = activity.createState();
  ingest(state, { type: 'system', subtype: 'relay_mcp_status', phase: 'preparing', stage: 'initializing' });
  assert.equal(activity.visibleItems(state)[0].title, '正在准备');
  ingest(state, { type: 'system', subtype: 'relay_mcp_status', phase: 'settled', ok: true });
  for (let attempt = 1; attempt <= 3; attempt++) ingest(state, { type: 'system', subtype: 'api_retry',
    error_status: 429, attempt, max_retries: 5, retry_delay_ms: 1500, error: 'do not render raw credentials' });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].title, '服务商限流，等待重试');
  assert.equal(state.items[0].detail, '约 2 秒后重试 · 第 3/5 次');
  assert.equal(state.phase, 'running');
  assert.equal(state.error, null);
  ingest(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'restored' } } });
  assert.equal(state.items[0].status, 'success');
  assert.equal(state.items[0].title, '服务商已恢复响应');
});

test('task started before its complete tool frame receives its result in the existing row', () => {
  const state = activity.createState();
  ingest(state, { type: 'system', subtype: 'task_started', task_id: 'early-task', tool_use_id: 'agent-call', task_type: 'local_agent', description: '核对结果' });
  const original = state.items[0];
  ingest(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: '已核对，无遗漏。' }] } });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0], original);
  assert.equal(original.result, '已核对，无遗漏。');
  assert.equal(original.status, 'success');
  assert.equal(original.taskId, 'early-task');
});

test('MCP failures stay in one inspectable diagnostic and never become assistant narration', () => {
  const state = activity.createState();
  ingest(state, { type: 'system', subtype: 'relay_mcp_status', phase: 'preparing', items: [] });
  ingest(state, { type: 'system', subtype: 'relay_mcp_status', phase: 'settled', ok: false,
    items: [{ name: 'notes', status: 'connected' }, { name: 'offline', status: 'failed' }] });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].type, 'diagnostic');
  assert.equal(state.items[0].status, 'error');
  assert.match(state.items[0].result, /notes：已连接/);
  assert.match(state.items[0].result, /offline：连接失败/);
  assert.equal(state.items.some(item => item.type === 'narration'), false);
  assert.equal(state.error, null);
});

test('长命令 heartbeat 始终合并回同一条活动', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'stream_event', uuid: 'wrapper-1',
    event: { type: 'message_start', message: { id: 'message-1' } },
  });
  ingest(state, {
    type: 'stream_event', uuid: 'wrapper-2',
    event: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'call_cmd', name: 'Bash', input: {} },
    },
  });
  ingest(state, {
    type: 'stream_event', uuid: 'wrapper-3',
    event: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"long scan","description":"Scan firmware"}' },
    },
  });
  ingest(state, {
    type: 'stream_event', uuid: 'wrapper-4',
    event: { type: 'content_block_stop', index: 0 },
  });
  ingest(state, {
    type: 'system', subtype: 'task_started', task_id: 'shell-task',
    tool_use_id: 'call_cmd', task_type: 'shell', description: 'Scan firmware',
  });

  for (let index = 0; index < 6; index += 1) {
    ingest(state, {
      type: 'tool_progress', task_id: 'shell-task', tool_name: 'Bash', heartbeat: true,
      tool_use_id: `call_cmd-heartbeat-${index}`, elapsed_time_seconds: (index + 1) * 30,
    });
  }

  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].toolUseId, 'call_cmd');
  assert.equal(state.items[0].taskId, 'shell-task');
  assert.equal(state.items[0].elapsedMs, 180000);

  // 真实故障顺序：长命令超时转后台，模型继续完成；迟到 heartbeat 不能重新点亮命令。
  ingest(state, {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result', tool_use_id: 'call_cmd', is_error: false,
        content: 'Command did not complete within its 120s timeout and was moved to the background.',
      }],
    },
    tool_use_result: { backgroundTaskId: 'shell-task', timedOutAfterMs: 120000 },
  });
  ingest(state, {
    type: 'tool_progress', task_id: 'shell-task', tool_name: 'Bash', heartbeat: true,
    tool_use_id: 'call_cmd-heartbeat-6', elapsed_time_seconds: 210,
  });
  ingest(state, {
    type: 'assistant',
    message: { id: 'final-message', content: [{ type: 'text', text: '任务已完成。' }] },
  });
  ingest(state, { type: 'result', subtype: 'success', is_error: false, duration_ms: 210000 });
  activity.finish(state);

  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, 'success');
  assert.equal(state.phase, 'complete');
});

test('无法关联的 heartbeat 不创建空白命令行', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'tool_progress', task_id: 'unknown-task', tool_name: 'Bash', heartbeat: true,
    tool_use_id: 'call_missing-heartbeat-0', elapsed_time_seconds: 30,
  });
  assert.equal(state.items.length, 0);
});

test('opaque heartbeat 帧不会覆盖 task 已绑定的真实 tool_use_id', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'assistant',
    message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'call_real', name: 'Bash', input: { command: 'scan' } }] },
  });
  ingest(state, {
    type: 'system', subtype: 'task_started', task_id: 'shell-opaque',
    tool_use_id: 'call_real', task_type: 'shell', description: 'Scan',
  });
  ingest(state, {
    type: 'tool_progress', task_id: 'shell-opaque', tool_name: 'Bash', heartbeat: true,
    tool_use_id: 'opaque-progress-frame', elapsed_time_seconds: 30,
  });

  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].toolUseId, 'call_real');
  assert.equal(state.items[0].elapsedMs, 30000);
});

test('恢复历史时移除旧版持久化的 synthetic heartbeat 行', () => {
  const state = activity.hydrate({
    phase: 'complete',
    items: [
      { id: 'call_cmd', type: 'task', status: 'success', toolUseId: 'call_cmd', taskId: 'task-1', title: 'Scan firmware' },
      { id: 'call_cmd-heartbeat-0', type: 'tool', status: 'success', toolUseId: 'call_cmd-heartbeat-0', toolName: 'Bash', title: '运行命令' },
      { id: 'call_cmd-heartbeat-1', type: 'tool', status: 'success', toolUseId: 'call_cmd-heartbeat-1', toolName: 'Bash', title: '运行命令' },
    ],
  });

  assert.deepEqual(state.items.map((item) => item.id), ['call_cmd']);
  assert.equal(activity.serialize(state).version, activity.VERSION);
});

test('SDK ambient 维护任务不显示也不阻塞完成', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'system', subtype: 'task_started', task_id: 'live-watcher',
    task_type: 'local_agent', description: 'live update', ambient: true,
  });
  ingest(state, {
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'live-watcher', task_type: 'local_agent', ambient: true }],
  });
  ingest(state, { type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0 });

  assert.equal(state.items.length, 0);
  assert.equal(state.phase, 'running');
  activity.finish(state);
  assert.equal(state.phase, 'complete');
});

test('background_tasks_changed 按快照替换并清除陈旧运行态', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: 'Research' }],
  });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].status, 'running');

  ingest(state, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(state.items[0].status, 'success');
  ingest(state, { type: 'result', subtype: 'success', result: 'done' });
  assert.equal(state.phase, 'running');
  activity.finish(state);
  assert.equal(state.phase, 'complete');
});

test('result 保留新元数据且有排队消息时维持运行态', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'result', subtype: 'success', result: 'first',
    queued_turn_count: 1,
    user_message_uuid: 'turn-1',
    modelUsage: { 'claude-test': { inputTokens: 10, costUSD: 0.1, costBasis: 'managed' } },
  });
  assert.equal(state.phase, 'running');
  assert.equal(state.result.queuedTurnCount, 1);
  assert.equal(state.result.userMessageUuid, 'turn-1');
  assert.equal(state.result.modelUsage['claude-test'].costBasis, 'managed');

  ingest(state, {
    type: 'result', subtype: 'success', result: 'second',
    queued_turn_count: 0, user_message_uuid: 'turn-2',
  });
  assert.equal(state.phase, 'running');
  assert.equal(state.result.userMessageUuid, 'turn-2');
  activity.finish(state);
  assert.equal(state.phase, 'complete');
});

test('success result 保留工具拒绝元数据但不误判整轮失败或保存工具输入', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'result', subtype: 'success', is_error: false,
    permission_denials: [{
      tool_name: 'PowerShell', tool_use_id: 'private-id',
      tool_input: { command: 'private command' },
    }],
  });

  assert.equal(state.phase, 'running');
  assert.equal(state.error, null);
  assert.deepEqual(state.result.permissionDenials, { count: 1, tools: ['PowerShell'] });
  assert.doesNotMatch(JSON.stringify(state), /private-id|private command|tool_input|tool_use_id/);
  activity.finish(state);
  assert.equal(state.phase, 'complete');
});

test('init 与 status 保存能力字段和实时权限模式', () => {
  const state = activity.createState();
  ingest(state, {
    type: 'system', subtype: 'init', session_id: 'session-1', model: 'model-1',
    permissionMode: 'default', effort: 'high', capabilities: ['interrupt_receipt_v1'],
    skills: ['review'], agents: ['worker'], plugins: [{ name: 'local' }],
    slash_commands: ['/help'], terminal_slash_commands: ['/exit'],
    fast_mode_state: 'off',
  });
  ingest(state, { type: 'system', subtype: 'status', status: 'requesting', permissionMode: 'plan' });

  assert.equal(state.session.permissionMode, 'plan');
  assert.equal(state.session.effort, 'high');
  assert.deepEqual(state.session.capabilities, ['interrupt_receipt_v1']);
  assert.deepEqual(state.session.terminalSlashCommands, ['/exit']);
  assert.equal(state.session.fastModeState, 'off');
});

test('display grouping folds adjacent calls without crossing prose, thinking or agents', () => {
  const tool = (id, toolName = 'Read') => ({ id, type: 'tool', toolName, status: 'success' });
  const items = [tool('a'), tool('b'), { id: 'n', type: 'narration', result: '继续处理' },
    tool('c'), { id: 't', type: 'thinking' }, tool('d'), tool('agent1', 'Agent'), tool('agent2', 'Agent'),
    { id: 'background1', type: 'task', toolName: 'Bash' }, { id: 'background2', type: 'task', toolName: 'Bash' },
    tool('shell1', 'Bash'), tool('shell2', 'PowerShell')];
  assert.deepEqual(activity.groupToolItems(items).map(group => group.items.map(item => item.id)), [
    ['a', 'b'], ['n'], ['c'], ['t'], ['d'], ['agent1'], ['agent2'], ['background1'], ['background2'], ['shell1', 'shell2'],
  ]);
});

test('MCP grouping keeps distinct service tools separate and never groups output-owned records', () => {
  const tool = (id, toolName, extra = {}) => ({ id, type: 'tool', toolName, ...extra });
  const groups = activity.groupToolItems([
    tool('a', 'mcp__notes__read'), tool('b', 'mcp__notes__read'),
    tool('c', 'mcp__files__read'), tool('d', 'mcp__notes__write'),
    tool('e', 'Read', { outputOwned: true }), tool('f', 'Read', { outputOwned: true }),
  ]);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['a', 'b'], ['c'], ['d'], ['e'], ['f']]);
});

test('grouping preserves every call, error and snapshot; the first call anchors a growing group', () => {
  const state = activity.createState();
  for (let index = 0; index < 3; index += 1) {
    ingest(state, { type: 'assistant', message: { id: `message-${index}`, content: [
      { type: 'tool_use', id: `read-${index}`, name: 'Read', input: { file_path: `file-${index}.txt` } },
    ] } });
    ingest(state, { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `read-${index}`, content: index === 1 ? 'ACCESS FAILED' : `result-${index}`, is_error: index === 1 },
    ] } });
  }
  const before = activity.serialize(state);
  const groups = activity.groupToolItems(state.items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, state.items[0].id);
  assert.equal(groups[0].items[1], state.items[1]);
  assert.equal(groups[0].items[1].status, 'error');
  assert.match(groups[0].items[1].result, /ACCESS FAILED/);
  assert.deepEqual(activity.serialize(state), before);
  const restored = activity.hydrate(before);
  assert.deepEqual(activity.groupToolItems(restored.items), activity.groupToolItems(before.items));
  assert.equal(activity.groupToolItems(restored.items.slice(0, 2))[0].id, groups[0].id);
});

test('explicit user pause has a neutral summary and restores consistently without changing tool errors', () => {
  const state = activity.createState({ items: [
    { id: 'failed-tool', type: 'tool', toolName: 'Bash', status: 'error', error: 'Original command interruption', result: 'stderr is retained' },
    { id: 'running-tool', type: 'tool', toolName: 'Read', status: 'running', input: { file_path: 'example.txt' } },
  ] });
  activity.finish(state, '已暂停');
  assert.equal(activity.summaryFor(state).title, '已暂停');
  assert.equal(activity.summaryFor(state).paused, true);
  assert.match(activity.summaryFor(state).meta, /^· 用时 \d+s$/);
  const restored = activity.hydrate(activity.serialize(state));
  assert.deepEqual(activity.summaryFor(restored), activity.summaryFor(state));
  assert.equal(restored.items[0].error, 'Original command interruption');
  assert.equal(restored.items[0].result, 'stderr is retained');
  assert.equal(restored.items[0].status, 'error');
  assert.equal(restored.items[1].status, 'unconfirmed');
});

test('ordinary failures and tool-local pause text cannot be mistaken for an explicit user pause', () => {
  for (const error of ['服务已暂停，请稍后重试', '已暂停连接', 'Request failed', '已暂停 ']) {
    const state = activity.createState({ items: [{ id: 'tool', type: 'tool', status: 'error', error: '已暂停' }] });
    activity.finish(state, error);
    assert.equal(activity.summaryFor(state).title, '处理未完成');
    assert.equal(activity.summaryFor(state).paused, undefined);
    assert.match(activity.summaryFor(state).meta, /^· 用时 \d+s$/);
  }
  const resumed = activity.createState({ phase: 'running', error: '已暂停' });
  assert.notEqual(activity.summaryFor(resumed).title, '已暂停');
});

test('an earlier result cannot complete the activity while a supplemental input still awaits consumption', () => {
  const state = activity.createState();
  ingest(state, { type: 'result', subtype: 'success', result: 'intermediate', queued_turn_count: 0, relay_pending_inputs: 2 });
  assert.equal(state.phase, 'running'); assert.equal(state.endedAt, null);
  ingest(state, { type: 'result', subtype: 'success', result: 'handled requirements', queued_turn_count: 0, relay_pending_inputs: 0 });
  assert.equal(state.phase, 'running');
  activity.finish(state);
  assert.equal(state.phase, 'complete');
});

test('durations use whole hours, minutes and seconds without rolling seconds into decimals', () => {
  for (const [milliseconds, formatted] of [
    [0, '0s'], [999, '0s'], [54400, '54s'], [59999, '59s'], [60000, '1m 0s'],
    [839000, '13m 59s'], [3600000, '1h 0m 0s'], [3723000, '1h 2m 3s'], [90061000, '25h 1m 1s'],
    [-1, ''], [NaN, ''], [Infinity, ''], [null, ''], ['5000', ''],
  ]) assert.equal(activity.formatDuration(milliseconds), formatted);
});

test('completed summary prefers task wall time over SDK round time and drops mixed frame counts', () => {
  const state = activity.createState({ phase: 'complete', startedAt: 1000, endedAt: 999999,
    received: 8021, result: { durationMs: 839000 }, items: [
      { id: 'status', type: 'status', status: 'success' },
      { id: 'thinking', type: 'thinking', status: 'success' },
      { id: 'read', type: 'tool', toolName: 'Read', status: 'success' },
      { id: 'prose', type: 'narration', status: 'success' },
    ],
  });
  const snapshot = activity.serialize(state);
  assert.deepEqual(activity.summaryFor(state), { title: '已结束', meta: '· 用时 16m 38s' });
  state.items.push({ id: 'retry', type: 'status', status: 'success' });
  state.received += 10000;
  assert.deepEqual(activity.summaryFor(state), { title: '已结束', meta: '· 用时 16m 38s' });
  assert.deepEqual(activity.summaryFor(activity.hydrate(snapshot)), activity.summaryFor(state));
});

test('failure without an SDK result uses saved timestamps while legacy unknown time stays unknown', () => {
  const state = activity.createState({ phase: 'error', startedAt: 1000, endedAt: 3724000, error: 'Cannot initialize SDK' });
  assert.deepEqual(activity.summaryFor(state), { title: '处理未完成', meta: '· 用时 1h 2m 3s' });
  assert.deepEqual(activity.summaryFor(activity.hydrate(activity.serialize(state))), activity.summaryFor(state));
  assert.deepEqual(activity.summaryFor(activity.fromLegacy('saved thinking')), { title: '已结束', meta: '' });
});

test('live summaries distinguish retries and queued messages without presenting raw SDK frame counts', () => {
  const state = activity.createState({ startedAt: Date.now() - 61000 });
  ingest(state, { type: 'system', subtype: 'api_retry', error_status: 429, attempt: 2, max_retries: 5, retry_delay_ms: 1500 });
  assert.equal(activity.summaryFor(state).title, '服务商限流，等待重试');
  assert.match(activity.summaryFor(state).meta, /^· 用时 1m \d+s$/);
  ingest(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'resumed' } } });
  assert.doesNotMatch(activity.summaryFor(state).title + activity.summaryFor(state).meta, /事件|项活动|等待重试/);
  state.result = { queuedTurnCount: 2 };
  assert.equal(activity.summaryFor(state).title, '正在处理排队消息');
  assert.match(activity.summaryFor(state).meta, /^· 用时 1m \d+s · 还有 2 条$/);
});

test('persistent API retries show actual attempt and delay without an artificial maximum', () => {
  const state = activity.createState();
  for (const [status, title] of [
    [429, '服务商限流，等待重试'], [529, '服务商暂时繁忙，等待重试'],
    [503, '服务商暂时繁忙，等待重试'], [408, '请求暂时失败，等待重试'],
    [null, '连接暂时中断，等待重试'],
  ]) {
    ingest(state, { type: 'system', subtype: 'api_retry', relay_retry_policy: 'persistent',
      error_status: status, attempt: 8, max_retries: 2147483647, retry_delay_ms: 2500 });
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].title, title);
    assert.equal(state.items[0].detail, '第 8 次 · 约 3 秒后重试');
    assert.equal(activity.summaryFor(state).title, title);
    assert.doesNotMatch(activity.renderItem(state.items[0], false), /2147483647|8\//);
  }
});

test('SDK round results never complete work or retire an active child before job-done', () => {
  const state = activity.createState();
  ingest(state, { type: 'result', subtype: 'success', duration_ms: 500, result: 'phase one' });
  assert.equal(state.phase, 'running');
  assert.equal(state.endedAt, null);
  assert.equal(activity.summaryFor(state).title, '正在处理');
  ingest(state, { type: 'system', subtype: 'task_started', task_id: 'child', description: 'Research' });
  ingest(state, { type: 'result', subtype: 'success', result: 'phase two' });
  assert.equal(state.items[0].status, 'running');
  assert.equal(state.phase, 'running');
  activity.finish(state, null, { exitCode: 0 });
  assert.equal(state.items[0].status, 'success');
  assert.equal(state.phase, 'complete');
});

test('child result aliases cannot replace parent round evidence or freeze its task clock', () => {
  const state = activity.createState();
  ingest(state, { type: 'result', subtype: 'success', result: 'parent', duration_ms: 1000, relay_task_started_at: 1000 });
  for (const child of [{ parent_tool_use_id: 'c' }, { parentToolUseId: 'c' }, { agent_id: 'c' }, { subagent_type: 'worker' }]) {
    ingest(state, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['child failed'],
      duration_ms: 8000, relay_task_started_at: 9000, relay_task_finished_at: 9999, ...child });
    assert.equal(state.result.durationMs, 1000);
    assert.equal(state.error, null);
    assert.equal(state.taskStartedAt, 1000);
    assert.equal(state.taskFinishedAt, null);
    assert.equal(state.phase, 'running');
  }
});

test('an intermediate error remains live and a later successful terminal result clears it', () => {
  const state = activity.createState();
  ingest(state, { type: 'result', subtype: 'error_during_execution', errors: ['retryable'], is_error: true });
  assert.equal(state.phase, 'running');
  assert.equal(state.endedAt, null);
  assert.equal(state.error, 'retryable');
  activity.finish(state, null, { exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: 'recovered' } });
  assert.equal(state.phase, 'complete');
  assert.equal(state.error, null);
});

test('one authoritative task clock includes retries, reset and subsequent SDK rounds', () => {
  const originalNow = Date.now;
  let now = 10000;
  Date.now = () => now;
  try {
    const state = activity.createState();
    ingest(state, { type: 'system', subtype: 'init', relay_task_started_at: 1000 });
    assert.equal(activity.summaryFor(state).meta, '· 用时 9s');
    now = 61000;
    ingest(state, { type: 'result', subtype: 'success', duration_ms: 500, relay_task_finished_at: 5000, relay_task_duration_ms: 4000 });
    assert.equal(activity.summaryFor(state).meta, '· 用时 1m 0s');
    assert.equal(state.taskFinishedAt, null);
    ingest(state, { type: 'system', subtype: 'api_retry', retry_delay_ms: 5000 });
    ingest(state, { type: 'conversation_reset', new_conversation_id: 'continued' });
    now = 126000;
    ingest(state, { type: 'result', subtype: 'success', duration_ms: 1000 });
    assert.equal(activity.summaryFor(state).meta, '· 用时 2m 5s');
    activity.finish(state, null, { relay_task_started_at: 1000, relay_task_finished_at: 131000,
      relay_task_duration_ms: 130000, exitCode: 0 });
    now = 999999;
    assert.equal(activity.summaryFor(state).meta, '· 用时 2m 10s');
    const restored = activity.hydrate(activity.serialize(state));
    assert.deepEqual(activity.summaryFor(restored), activity.summaryFor(state));
    assert.equal(restored.taskStartedAt, 1000);
    assert.equal(restored.taskFinishedAt, 131000);
    assert.equal(restored.taskDurationMs, 130000);
  } finally { Date.now = originalNow; }
});

test('legacy durations remain usable only when saved wall timestamps are missing', () => {
  const state = activity.hydrate({ phase: 'complete', result: { durationMs: 839000 } });
  assert.equal(state.startedAt, null);
  assert.equal(activity.summaryFor(state).meta, '· 用时 13m 59s');
  assert.equal(activity.summaryFor(activity.hydrate(activity.serialize(state))).meta, '· 用时 13m 59s');
  assert.equal(activity.summaryFor(activity.hydrate({ phase: 'complete', taskDurationMs: 90000,
    result: { durationMs: 1000 } })).meta, '· 用时 1m 30s');
});

test('previous presentation segments remain neutral while an empty current segment retains work state', () => {
  const state = activity.createState();
  assert.equal(activity.summaryFor(state).title, '正在准备');
  ingest(state, { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'phase one' }] } });
  const next = { ...state, items: [], result: null };
  assert.equal(activity.summaryFor(next).title, '正在处理');
  assert.deepEqual(activity.summaryFor(next, { segment: 'previous' }), { title: '此前过程', meta: '' });
  assert.equal(activity.hydrate(activity.serialize(state)).hasWork, true);
  activity.finish(state);
  assert.deepEqual(activity.summaryFor(state, { segment: 'previous' }), { title: '此前过程', meta: '' });
  assert.equal(activity.summaryFor(state, { segment: 'current' }).title, '已结束');
});

test('later API retry updates its event position after intervening work and survives history restore', () => {
  const state = activity.createState();
  ingest(state, { type: 'system', subtype: 'api_retry', error_status: 429, attempt: 1, presentation_order: 1 });
  const retry = state.items[0];
  ingest(state, { type: 'assistant', presentation_order: 2, message: { id: 'work', content: [
    { type: 'tool_use', id: 'read-retry-position', name: 'Read', input: { file_path: 'fixture.txt' } },
  ] } });
  state.items.push({ id: 'later-prose', outputOwned: true, type: 'narration', status: 'running', result: 'New work', order: 3 });
  assert.equal(retry.status, 'success');
  ingest(state, { type: 'system', subtype: 'api_retry', error_status: 429, attempt: 2, presentation_order: 5 });
  assert.equal(state.items.at(-1), retry, 'one aggregated live row moves behind newer work');
  assert.equal(retry.order, 5);
  assert.equal(state.items.filter(item => item.id === retry.id).length, 1);
  ingest(state, { type: 'system', subtype: 'api_retry', error_status: 503, attempt: 3, presentation_order: 6 });
  assert.equal(state.items.at(-1), retry);
  assert.equal(retry.order, 6);
  const restored = activity.hydrate(activity.serialize(state));
  assert.equal(restored.items.at(-1).id, retry.id);
  assert.equal(restored.items.at(-1).order, 6);
  ingest(restored, { type: 'stream_event', event: { type: 'message_start', message: { id: 'back' } } });
  assert.equal(restored.items.at(-1).title, '服务商已恢复响应');
});
