'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveBackgroundTaskTracker,
  LiveAsyncAgentTracker,
  isAmbientTask,
  isAgentTask,
  liveResultDisposition,
} = require('../src/main/live/live-async-agent-tracker');

test('后台 Bash 不会被误计为后台 Agent', () => {
  const tracker = new LiveAsyncAgentTracker();

  for (const task of [
    { task_type: 'shell' },
    { task_type: 'local_bash' },
    { task_type: 'bash' },
    {},
  ]) assert.equal(isAgentTask(task), false);
  assert.deepEqual(tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'shell-1',
    tool_use_id: 'call_shell', task_type: 'shell', description: '长命令',
  }), []);
  tracker.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: '长命令' }],
  });
  tracker.ingest({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result', tool_use_id: 'call_shell', is_error: false,
        content: 'Command timed out and was moved to the background.',
      }],
    },
    tool_use_result: { backgroundTaskId: 'shell-1', timedOutAfterMs: 120000 },
  });

  assert.equal(tracker.size, 0);
  assert.equal(liveResultDisposition({ type: 'result', subtype: 'success' }, tracker), 'finish');
});

test('真正的后台 Agent 在最终汇总前保持 turn，快照归零后释放', () => {
  const tracker = new LiveAsyncAgentTracker();

  tracker.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: '分析' }],
  });
  assert.equal(tracker.size, 1);

  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-1',
    tool_use_id: 'call_agent', task_type: 'local_agent', subagent_type: 'analyst',
  });
  tracker.ingest({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_agent', content: 'Async agent launched successfully' }] },
    tool_use_result: { isAsync: true, status: 'async_launched' },
  });
  assert.equal(tracker.size, 1, '快照、started 与启动回执不得重复计数');
  assert.equal(liveResultDisposition({ type: 'result', subtype: 'success' }, tracker), 'wait');

  tracker.ingest({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(tracker.size, 0);
  tracker.ingest({
    type: 'system', subtype: 'task_notification', task_id: 'agent-1',
    tool_use_id: 'call_agent', status: 'completed',
  });
  assert.equal(tracker.size, 0, '迟到的完成 bookend 不得重新引入任务');
  assert.equal(liveResultDisposition({ type: 'result', subtype: 'success' }, tracker), 'finish');
});

test('Agent 的 edge-first 顺序与 notification-first 完成顺序不会重复或残留', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-order',
    tool_use_id: 'call_order', task_type: 'local_agent', subagent_type: 'analyst',
  });
  tracker.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'agent-order', task_type: 'local_agent', description: '分析' }],
  });
  assert.equal(tracker.size, 1);

  tracker.ingest({
    type: 'system', subtype: 'task_notification', task_id: 'agent-order',
    tool_use_id: 'call_order', status: 'completed',
  });
  tracker.ingest({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(tracker.size, 0);
});

test('background_tasks_changed 使用替换语义清除遗漏 bookend 的陈旧任务', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-stale',
    tool_use_id: 'call_stale', task_type: 'local_agent', subagent_type: 'researcher',
  });
  assert.equal(tracker.size, 1);

  const [transition] = tracker.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'shell-only', task_type: 'shell', description: '后台 Bash' }],
  });
  assert.equal(transition.kind, 'snapshot');
  assert.equal(transition.changed, true);
  assert.equal(tracker.size, 0);
});

test('SDK ambient 维护任务不进入活动集合也不阻塞 result', () => {
  const agents = new LiveAsyncAgentTracker();
  const allTasks = new LiveBackgroundTaskTracker();
  const ambient = {
    type: 'system', subtype: 'task_started', task_id: 'watcher-1',
    task_type: 'local_agent', subagent_type: 'live-update', ambient: true,
  };

  assert.equal(isAmbientTask(ambient), true);
  agents.ingest(ambient);
  allTasks.ingest(ambient);
  agents.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'watcher-1', task_type: 'local_agent', description: 'watch', ambient: true }],
  });
  allTasks.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'watcher-1', task_type: 'local_agent', description: 'watch', ambient: true }],
  });

  assert.equal(agents.size, 0);
  assert.equal(allTasks.size, 0);
  assert.equal(liveResultDisposition({ type: 'result', subtype: 'success' }, agents), 'finish');
});

test('task_updated 的终态可以清除缺失 notification 的 Agent', () => {
  const agents = new LiveAsyncAgentTracker();
  const allTasks = new LiveBackgroundTaskTracker();
  const started = {
    type: 'system', subtype: 'task_started', task_id: 'agent-patched',
    tool_use_id: 'call_patched', task_type: 'local_agent', subagent_type: 'analyst',
  };
  agents.ingest(started);
  allTasks.ingest(started);
  assert.equal(agents.size, 1);
  assert.equal(allTasks.size, 1);

  const updated = {
    type: 'system', subtype: 'task_updated', task_id: 'agent-patched',
    patch: { status: 'completed', is_backgrounded: true },
  };
  agents.ingest(updated);
  allTasks.ingest(updated);
  assert.equal(agents.size, 0);
  assert.equal(allTasks.size, 0);
});

test('queued_turn_count 大于零时等待下一轮 result', () => {
  const tracker = new LiveAsyncAgentTracker();
  assert.equal(liveResultDisposition({
    type: 'result', subtype: 'success', queued_turn_count: 1,
  }, tracker), 'wait');
  assert.equal(liveResultDisposition({
    type: 'result', subtype: 'success', queued_turn_count: 0,
  }, tracker), 'finish');
});

test('旧版文本 task-notification 仍能结束由 Agent 回执跟踪的任务', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_legacy', content: 'Async agent launched successfully' }] },
  });
  assert.equal(tracker.size, 1);

  tracker.ingest({
    type: 'user',
    message: { content: '<task-notification><tool-use-id>call_legacy</tool-use-id><status>completed</status></task-notification>' },
  });
  assert.equal(tracker.size, 0);
});

test('Agent 启动回执里的 agentId 可由旧版 task-id-only 通知结束', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'agent-from-result', task_type: 'local_agent', description: 'legacy' }],
  });
  tracker.ingest({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_agent_id', content: 'Async agent launched successfully' }] },
    tool_use_result: { status: 'async_launched', agentId: 'agent-from-result' },
  });
  assert.equal(tracker.size, 1, 'snapshot 与带 agentId 的启动回执不得重复计数');

  tracker.ingest({
    type: 'user',
    message: { content: '<task-notification><task-id>agent-from-result</task-id><status>completed</status></task-notification>' },
  });
  assert.equal(tracker.size, 0);
});

test('错误 result 即使还有 Agent 也必须结束，不能永久等待', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-error',
    tool_use_id: 'call_error', task_type: 'local_agent', subagent_type: 'analyst',
  });
  assert.equal(liveResultDisposition({
    type: 'result', subtype: 'error_during_execution', is_error: true,
  }, tracker), 'finish');
  assert.equal(liveResultDisposition({ type: 'result' }, tracker), 'finish', '畸形 result 也应 fail closed');
});

test('成功结果的拒绝记录不能提前结束实际 Agent 或 SDK 排队轮次', () => {
  const tracker = new LiveAsyncAgentTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-denied',
    tool_use_id: 'call_denied', task_type: 'local_agent', subagent_type: 'analyst',
  });

  assert.equal(tracker.size, 1);
  const result = {
    type: 'result', subtype: 'success', is_error: false,
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'private' } }],
  };
  assert.equal(liveResultDisposition(result, tracker), 'wait');
  tracker.ingest({ type: 'system', subtype: 'task_notification', task_id: 'agent-denied', tool_use_id: 'call_denied', status: 'completed' });
  assert.equal(liveResultDisposition({ ...result, queued_turn_count: 1 }, tracker), 'wait');
  assert.equal(liveResultDisposition({ ...result, queued_turn_count: 0 }, tracker), 'finish');
  for (const failure of [{ is_error: true }, { subtype: 'error_during_execution' }, { terminal_reason: 'aborted_streaming' }]) {
    assert.equal(liveResultDisposition({ ...result, queued_turn_count: 1, ...failure }, tracker), 'finish');
  }
});

test('所有后台任务单独跟踪：普通完成清除，转后台 Bash 保留供 session 回收', () => {
  const tracker = new LiveBackgroundTaskTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'shell-normal',
    tool_use_id: 'call_normal', task_type: 'shell',
  });
  tracker.ingest({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_normal', content: 'done' }] },
  });
  assert.equal(tracker.size, 0);

  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'shell-background',
    tool_use_id: 'call_background', task_type: 'shell',
  });
  tracker.ingest({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call_background', content: 'moved to background' }] },
    tool_use_result: { backgroundTaskId: 'shell-background', timedOutAfterMs: 120000 },
  });
  assert.equal(tracker.nonAgentSize, 1);
  assert.equal(tracker.hasNonAgentTasks(), true);
  tracker.ingest({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(tracker.size, 0);
});

test('错误 result 对应的残留 Agent 也保留在后台任务集合，供 finishTurn 回收 session', () => {
  const tracker = new LiveBackgroundTaskTracker();
  tracker.ingest({
    type: 'system', subtype: 'task_started', task_id: 'agent-on-error',
    tool_use_id: 'call_agent_error', task_type: 'local_agent', subagent_type: 'analyst',
  });
  assert.equal(tracker.size, 1);
  assert.equal(tracker.nonAgentSize, 0);
});
