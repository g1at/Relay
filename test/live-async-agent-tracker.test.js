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

test('批量后台完成的零轮回执在Agent归零后仍等待真正结果，不依赖API时长为零', () => {
  const tracker = new LiveAsyncAgentTracker();
  for (const index of [1, 2]) tracker.ingest({ type: 'system', subtype: 'task_started',
    task_id: `batch-agent-${index}`, task_type: 'local_agent', tool_use_id: `batch-call-${index}` });
  for (const index of [1, 2]) tracker.ingest({ type: 'system', subtype: 'task_notification',
    task_id: `batch-agent-${index}`, status: 'completed' });
  assert.equal(tracker.size, 0);
  const receipt = { type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' },
    result: '', num_turns: 0, duration_api_ms: 2400, queued_turn_count: 0, result_index: 2 };
  assert.equal(liveResultDisposition(receipt, tracker), 'wait');
  assert.equal(liveResultDisposition(receipt), 'wait', 'without an agent tracker the receipt is still intermediate');
  assert.equal(liveResultDisposition({ ...receipt, num_turns: 1, result: 'final', result_index: 3 }, tracker), 'finish');
  for (const terminal of [{ origin: undefined }, { local_command: 'clear' }, { structured_output: { ok: true } },
    { terminal_reason: 'aborted_tools' }, { subtype: 'error_during_execution' }, { is_error: true }]) {
    assert.equal(liveResultDisposition({ ...receipt, ...terminal }, tracker), 'finish', JSON.stringify(terminal));
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


function resumedTaskFixture() {
  const agents = new LiveAsyncAgentTracker();
  const allTasks = new LiveBackgroundTaskTracker();
  const send = event => { agents.ingest(event); allTasks.ingest(event); };
  const start = (runId, toolUseId, taskId = 'resumed-agent') => send({
    type: 'system', subtype: 'task_started', task_id: taskId,
    run_id: runId, tool_use_id: toolUseId, task_type: 'local_agent', description: 'current run ' + runId,
  });
  const assertActive = (count = 1) => {
    assert.equal(agents.size, count, 'the current Agent gate must retain exactly the live runs');
    assert.equal(allTasks.size, count, 'session recycle tracking must agree on the live runs');
    assert.equal(liveResultDisposition({ type: 'result', subtype: 'success' }, agents), count ? 'wait' : 'finish');
  };
  return { agents, allTasks, send, start, assertActive };
}

test('恢复同一 task 后，迟到的旧 run 启动、更新和完成不得结束或覆盖新 run', () => {
  const f = resumedTaskFixture();
  f.start('opaque:9', 'old-tool');
  f.start('opaque:a', 'new-tool');
  // Run ids are opaque strings, not numbers, timestamps or UUIDs.
  for (const event of [
    { subtype: 'task_notification', status: 'completed' },
    { subtype: 'task_notification', status: 'failed' },
    { subtype: 'task_notification', status: 'running', ambient: true },
    { subtype: 'task_updated', patch: { status: 'completed', description: 'old summary' } },
    { subtype: 'task_updated', patch: { status: 'paused', description: 'old progress', ambient: true } },
    { subtype: 'task_started', task_type: 'local_agent', description: 'old launch' },
    { subtype: 'task_started', task_type: 'shell', ambient: true },
  ]) {
    f.send({ type: 'system', task_id: 'resumed-agent', run_id: 'opaque:9', tool_use_id: 'old-tool', ...event });
    f.assertActive();
    assert.equal(f.allTasks.tasks.get('resumed-agent').description, 'current run opaque:a');
  }
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'opaque:a', status: 'completed' });
  f.assertActive(0);
});

test('新 run 快照先于 started 时剥离旧工具，迟到的完成及异步启动回执不能操作新任务', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'old-tool');
  f.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'resumed-agent', run_id: 'run-02', task_type: 'local_agent', description: 'resumed snapshot' },
  ] });
  f.assertActive();
  assert.equal(f.allTasks.tasks.get('resumed-agent').run_id, 'run-02');
  assert.equal(f.allTasks.tasks.get('resumed-agent').tool_use_id, undefined);
  assert.equal(f.allTasks.toolToTask.has('old-tool'), false);
  for (const structured of [{}, { isAsync: true, agentId: 'resumed-agent' }, { backgroundTaskId: 'resumed-agent' }]) {
    f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'old result' }] },
      tool_use_result: structured });
    f.assertActive();
  }
  f.start('run-02', 'new-tool');
  f.assertActive();
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-02', status: 'completed' });
  f.assertActive(0);
});

test('旧 run 快照保留当前新 run，同时仍移除快照遗漏的无关任务', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'old-tool');
  f.start('run-02', 'new-tool');
  f.start('another-run', 'independent-tool', 'independent-task');
  f.assertActive(2);
  f.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'resumed-agent', run_id: 'run-01', task_type: 'shell', ambient: true, description: 'obsolete' },
  ] });
  f.assertActive();
  assert.equal(f.allTasks.tasks.get('resumed-agent').run_id, 'run-02');
  assert.equal(f.allTasks.tasks.get('resumed-agent').tool_use_id, 'new-tool');
  assert.equal(f.allTasks.tasks.has('independent-task'), false);
  f.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  f.assertActive(0);
});

test('新 run 完成后保留代际记录，旧 started、running 和快照不能复活它', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'old-tool');
  f.start('run-02', 'new-tool');
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-02', status: 'completed' });
  f.assertActive(0);
  f.start('run-01', 'old-tool');
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-01', status: 'running' });
  f.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'resumed-agent', run_id: 'run-01', task_type: 'local_agent' },
  ] });
  f.assertActive(0);
  f.start('run-03', 'third-tool');
  f.assertActive();
});

test('新 run 的非终态更新先到时保留 Agent gate，但不继承旧工具关联', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'old-tool');
  f.send({ type: 'system', subtype: 'task_updated', task_id: 'resumed-agent', run_id: 'run-02',
    patch: { status: 'paused', description: 'new paused task' } });
  f.assertActive();
  assert.equal(f.allTasks.tasks.get('resumed-agent').run_id, 'run-02');
  assert.equal(f.allTasks.tasks.get('resumed-agent').tool_use_id, undefined);
  f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'done' }] } });
  f.send({ type: 'system', subtype: 'task_updated', task_id: 'resumed-agent', run_id: 'run-01', patch: { status: 'completed' } });
  f.assertActive();
  f.send({ type: 'system', subtype: 'task_updated', task_id: 'resumed-agent', run_id: 'run-02', patch: { status: 'completed' } });
  f.assertActive(0);
});

test('保存的 user task-notification 按 origin.runId 区分旧完成与当前完成', () => {
  for (const idField of ['<task-id>resumed-agent</task-id>', '<tool-use-id>new-tool</tool-use-id>']) {
    const f = resumedTaskFixture();
    f.start('run-01', 'old-tool');
    f.start('run-02', 'new-tool');
    const text = '<task-notification>' + idField + '<status>completed</status></task-notification>';
    f.send({ type: 'user', origin: { kind: 'task-notification', runId: 'run-01' }, message: { content: text } });
    f.assertActive();
    f.send({ type: 'user', origin: { kind: 'task-notification', runId: 'run-02' }, message: { content: text } });
    f.assertActive(0);
  }
});

test('无 run_id 的旧协议快照和完成保持兼容，已知 run 不因无字段快照丢失', () => {
  const f = resumedTaskFixture();
  f.start('run-02', 'new-tool');
  f.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'resumed-agent', task_type: 'local_agent', description: 'legacy snapshot' },
  ] });
  assert.equal(f.allTasks.tasks.get('resumed-agent').run_id, 'run-02');
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-01', status: 'completed' });
  f.assertActive();
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', status: 'completed' });
  f.assertActive(0);
  f.start(undefined, 'legacy-tool', 'legacy-task');
  f.send({ type: 'system', subtype: 'task_updated', task_id: 'legacy-task', patch: { status: 'completed' } });
  f.assertActive(0);
});

test('reset 清除代际与旧工具记忆，新 CLI 可重新使用较早 run 和同工具标识', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'reused-tool');
  f.start('run-02', 'new-tool');
  f.agents.reset();
  f.allTasks.reset();
  f.assertActive(0);
  f.start('run-01', 'reused-tool');
  f.assertActive();
  f.send({ type: 'user', tool_use_result: { isAsync: true, agentId: 'resumed-agent' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'reused-tool', content: 'async launch' }] } });
  f.assertActive();
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-01', status: 'completed' });
  f.assertActive(0);
});

test('先收到新代终态也记录代际，其他 task 的低序 run 不受影响', () => {
  const f = resumedTaskFixture();
  f.send({ type: 'system', subtype: 'task_updated', task_id: 'resumed-agent', run_id: 'z-run', patch: { status: 'completed' } });
  f.start('a-run', 'old-tool');
  f.assertActive(0);
  f.start('a-run', 'independent-tool', 'independent-task');
  f.assertActive();
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'independent-task', run_id: 'a-run', status: 'completed' });
  f.assertActive(0);
});


test('新代终态早于启动到达，关闭旧 gate 时仍报告 finished 转移', () => {
  for (const ending of [
    { subtype: 'task_notification', status: 'completed' },
    { subtype: 'task_updated', patch: { status: 'failed' } },
  ]) {
    const tracker = new LiveAsyncAgentTracker();
    tracker.ingest({ type: 'system', subtype: 'task_started', task_id: 'resumed-agent',
      run_id: 'run-01', tool_use_id: 'old-tool', task_type: 'local_agent' });
    const [transition] = tracker.ingest({ type: 'system', task_id: 'resumed-agent', run_id: 'run-02', ...ending });
    assert.equal(tracker.size, 0);
    assert.equal(transition.kind, 'finished');
    assert.equal(transition.changed, true);
    assert.equal(transition.trackingId, 'old-tool');
    assert.equal(transition.pending, 0);
  }
});


test('新 run progress 先于 started 时换代，旧终态和工具回执不能清掉仍运行的任务', () => {
  const f = resumedTaskFixture();
  f.start('run-01', 'old-tool');
  f.send({ type: 'system', subtype: 'task_progress', task_id: 'resumed-agent', run_id: 'run-02',
    tool_use_id: 'new-tool', description: 'new progress', subagent_type: 'analyst' });
  f.assertActive();
  assert.equal(f.allTasks.tasks.get('resumed-agent').run_id, 'run-02');
  assert.equal(f.allTasks.tasks.get('resumed-agent').tool_use_id, 'new-tool');
  f.send({ type: 'system', subtype: 'task_progress', task_id: 'resumed-agent', run_id: 'run-01',
    tool_use_id: 'old-tool', description: 'old progress', subagent_type: 'analyst' });
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-01', status: 'completed' });
  f.send({ type: 'user', tool_use_result: { isAsync: true, agentId: 'resumed-agent' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'late old launch' }] } });
  f.assertActive();
  assert.equal(f.allTasks.tasks.get('resumed-agent').description, 'new progress');
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: 'run-02', status: 'completed' });
  f.assertActive(0);
});


test('无 run 字段但有已退役工具身份的启动与两类完成通知仍是旧运行', () => {
  for (const completion of [
    { type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', tool_use_id: 'old-tool', status: 'completed' },
    { type: 'user', message: { content: '<task-notification><task-id>resumed-agent</task-id>'
      + '<tool-use-id>old-tool</tool-use-id><status>completed</status></task-notification>' } },
  ]) {
    const f = resumedTaskFixture();
    f.start('run-01', 'old-tool');
    f.start('run-02', 'new-tool');
    f.start(undefined, 'old-tool');
    f.send({ type: 'system', subtype: 'task_progress', task_id: 'resumed-agent',
      tool_use_id: 'old-tool', description: 'late legacy progress' });
    f.send(completion);
    f.assertActive();
    assert.equal(f.allTasks.tasks.get('resumed-agent').tool_use_id, 'new-tool');
    f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', tool_use_id: 'new-tool', status: 'completed' });
    f.assertActive(0);
  }
});


test('类型明确的 Agent progress 可先建新任务或恢复已结束任务，未知类型不猜测', () => {
  const f = resumedTaskFixture();
  f.send({ type: 'system', subtype: 'task_progress', task_id: 'unknown-task', run_id: 'run-01', description: 'unknown' });
  f.assertActive(0);
  for (const [runId, type] of [['run-01', { subagent_type: 'analyst' }], ['run-02', { task_type: 'local_agent' }]]) {
    f.send({ type: 'system', subtype: 'task_progress', task_id: 'resumed-agent', run_id: runId,
      tool_use_id: runId + '-tool', description: 'typed running agent', ...type });
    f.assertActive();
    f.send({ type: 'system', subtype: 'task_notification', task_id: 'resumed-agent', run_id: runId, status: 'completed' });
    f.assertActive(0);
  }
});
