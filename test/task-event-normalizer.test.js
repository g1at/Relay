'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClaudeTaskEvent, summarizeResultText } = require('../task-event-normalizer');

const now = '2026-08-24T10:00:00.000Z';

test('成功 result 只进入 finalizing，等待权威 job-done 收尾', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'result', subtype: 'success', result: 'done' },
    { state: 'running', progress: {}, result: {} }, now,
  );
  assert.equal(action.kind, 'update');
  assert.equal(action.patch.state, 'running');
  assert.equal(action.patch.phase, 'finalizing');
  assert.equal(action.patch.result.summary, 'done');
});

test('中间 result 后若继续输出，执行器从 draining 恢复为 active', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'assistant', message: { content: [] } },
    { state: 'running', phase: 'finalizing', executorState: 'draining', progress: {} }, now,
  );
  assert.equal(action.kind, 'update');
  assert.equal(action.patch.state, 'running');
  assert.equal(action.patch.phase, 'thinking');
  assert.equal(action.patch.executorState, 'active');
});

test('错误 result 立即失败，不能被后续 exitCode 0 翻回成功', () => {
  const failed = normalizeClaudeTaskEvent(
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' },
    { state: 'running', progress: {}, result: {} }, now,
  );
  assert.equal(failed.kind, 'terminal');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.details.executorState, 'stopped');
  assert.equal(failed.details.result.error, 'boom');

  const lateDone = normalizeClaudeTaskEvent(
    { type: 'job-done', exitCode: 0 },
    { state: 'failed', progress: {}, result: failed.details.result }, now,
  );
  assert.equal(lateDone.kind, 'noop');
});

test('成功 subtype 携带工具拒绝时保留摘要和脱敏记录，等待 job-done', () => {
  const result = normalizeClaudeTaskEvent(
    {
      type: 'result', subtype: 'success', is_error: false, result: '无法完成任务',
      permission_denials: [
        {
          tool_name: 'mcp__feishu__doc_read', tool_use_id: 'tool-1',
          tool_input: { document_id: 'sensitive-document', token: 'must-not-persist' },
        },
        {
          tool_name: 'Bash', tool_use_id: 'tool-2',
          tool_input: { command: 'private command' },
        },
      ],
    },
    { state: 'running', progress: {}, result: {} }, now,
  );

  assert.equal(result.kind, 'update');
  assert.equal(result.patch.state, 'running');
  assert.equal(result.patch.result.error, undefined);
  assert.equal(result.patch.result.summary, '无法完成任务');
  assert.deepEqual(result.patch.result.sdk.permissionDenials, {
    count: 2,
    tools: ['mcp__feishu__doc_read', 'Bash'],
  });
  const persisted = JSON.stringify(result);
  assert.doesNotMatch(persisted, /sensitive-document|must-not-persist|private command|tool_input|tool_use_id/);

  const lateDone = normalizeClaudeTaskEvent(
    { type: 'job-done', exitCode: 0 },
    { ...result.patch }, now,
  );
  assert.equal(lateDone.kind, 'terminal');
  assert.equal(lateDone.status, 'succeeded');
  assert.deepEqual(lateDone.details.result.sdk.permissionDenials, result.patch.result.sdk.permissionDenials);
});

test('空正文成功的拒绝记录仍保留，正文不是后端成败分类依据', () => {
  for (const text of ['', '已完成并说明限制']) {
    const action = normalizeClaudeTaskEvent({ type: 'result', subtype: 'success', is_error: false, result: text,
      permission_denials: [{ tool_name: 'PowerShell' }], queued_turn_count: 1 }, { state: 'running' }, now);
    assert.equal(action.kind, 'update'); assert.equal(action.patch.phase, 'running');
    assert.equal(action.patch.result.summary, text);
    assert.equal(action.patch.result.sdk.permissionDenials.count, 1);
  }
});

test('真实异常和中止含拒绝记录仍失败，并优先保留真正故障', () => {
  for (const extra of [{ is_error: true, errors: ['provider offline'] },
    { subtype: 'error_during_execution', errors: ['provider offline'] },
    { terminal_reason: 'aborted_tools' }]) {
    const action = normalizeClaudeTaskEvent({ type: 'result', subtype: 'success', is_error: false,
      permission_denials: [{ tool_name: 'PowerShell' }], ...extra }, { state: 'running' }, now);
    assert.equal(action.kind, 'terminal'); assert.equal(action.status, 'failed');
    assert.equal(action.details.result.sdk.permissionDenials.count, 1);
    assert.equal(action.details.result.error, extra.terminal_reason ? 'Claude 执行已中止' : 'provider offline');
  }
});

test('job-done 唯一终态也尊重 SDK 错误、中止、宿主错误与非零退出', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'answer', permission_denials: [{ tool_name: 'PowerShell' }] };
  for (const extra of [{}, { exitCode: 2 }, { error: 'host failed' }, { finalResult: { ...result, is_error: true, errors: ['sdk failed'] } },
    { finalResult: { ...result, terminal_reason: 'aborted_tools' } }]) {
    const event = { type: 'job-done', exitCode: 0, finalResult: result, ...extra };
    const action = normalizeClaudeTaskEvent(event, { state: 'running' }, now);
    assert.equal(action.status, Object.keys(extra).length ? 'failed' : 'succeeded');
    assert.equal(action.details.result.sdk.permissionDenials.count, 1);
  }
});

test('Agent task_started 映射为 Agent 阶段', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'system', subtype: 'task_started', task_type: 'local_agent' },
    { state: 'running', progress: {} }, now,
  );
  assert.equal(action.kind, 'update');
  assert.equal(action.patch.phase, 'agent');
  assert.equal(action.patch.progress.label, '正在等待 Agent');
});

test('被取消的任务以 canceled 收尾', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'job-done', exitCode: -1 },
    { state: 'stopping', progress: {}, result: {} }, now,
  );
  assert.equal(action.kind, 'terminal');
  assert.equal(action.status, 'canceled');
  assert.equal(action.details.phase, 'terminal');
  assert.equal(action.details.executorState, 'stopped');
});

test('job-done 将完成任务归一为 terminal 阶段', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'job-done', exitCode: 0 },
    { state: 'running', phase: 'finalizing', progress: {}, result: { summary: 'done' } }, now,
  );
  assert.equal(action.kind, 'terminal');
  assert.equal(action.status, 'succeeded');
  assert.equal(action.details.phase, 'terminal');
});

test('结果摘要移除 Markdown 链接、URL 和表格标记', () => {
  const summary = summarizeResultText([
    '总报告已重新审查并写入：[飞书文档](https://example.com/report)',
    '## 与首次审查相比的变化',
    '- 文档已经补齐关键结论。',
    '| 项目 | 状态 |',
    '| --- | --- |',
  ].join('\n'));
  assert.match(summary, /总报告已重新审查并写入：飞书文档/);
  assert.match(summary, /与首次审查相比的变化/);
  assert.doesNotMatch(summary, /https?:\/\//);
  assert.doesNotMatch(summary, /##|\|\s*---/);
  assert.doesNotMatch(summary, /项目\s*·\s*状态/);
  assert.ok(summary.length <= 240);
});

test('ambient 维护任务不污染任务中心进度', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'system', subtype: 'task_started', task_id: 'watcher', ambient: true },
    { state: 'running', progress: {} }, now,
  );
  assert.equal(action.kind, 'noop');
});

test('后台任务快照过滤 ambient 并使用替换后的数量', () => {
  const action = normalizeClaudeTaskEvent({
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'watcher', task_type: 'local_agent', ambient: true },
      { task_id: 'real-agent', task_type: 'local_agent', description: 'Research' },
    ],
  }, { state: 'running', progress: {} }, now);
  assert.equal(action.kind, 'update');
  assert.equal(action.patch.phase, 'agent');
  assert.equal(action.patch.progress.backgroundTaskCount, 1);
});

test('result 持久化排队、关联、成本口径和快速模式字段', () => {
  const action = normalizeClaudeTaskEvent({
    type: 'result', subtype: 'success', result: 'done',
    queued_turn_count: 1,
    user_message_uuid: 'turn-uuid',
    terminal_reason: 'end_turn',
    total_cost_usd: 0.25,
    modelUsage: { model: { inputTokens: 12, costUSD: 0.2, costBasis: 'managed' } },
    fast_mode_state: 'on',
  }, { state: 'running', progress: {}, result: {} }, now);

  assert.equal(action.kind, 'update');
  assert.equal(action.patch.phase, 'running');
  assert.equal(action.patch.progress.label, '正在处理排队消息');
  assert.equal(action.patch.result.sdk.userMessageUuid, 'turn-uuid');
  assert.equal(action.patch.result.sdk.queuedTurnCount, 1);
  assert.equal(action.patch.result.sdk.totalCostUsd, 0.25);
  assert.equal(action.patch.result.sdk.modelUsage.model.costBasis, 'managed');
  assert.equal(action.patch.result.sdk.fastModeState, 'on');
});

test('init 将 SDK 能力与实际权限设置写入任务诊断', () => {
  const action = normalizeClaudeTaskEvent({
    type: 'system', subtype: 'init', session_id: 'session-1',
    model: 'provider/model', claude_code_version: '2.1.250',
    permissionMode: 'acceptEdits', effort: 'xhigh', capabilities: ['interrupt_receipt_v1'],
  }, { state: 'queued', progress: {}, execution: {} }, now);

  assert.equal(action.kind, 'update');
  assert.equal(action.patch.execution.model, 'provider/model');
  assert.equal(action.patch.execution.claudeCodeVersion, '2.1.250');
  assert.equal(action.patch.execution.permissionMode, 'acceptEdits');
  assert.equal(action.patch.execution.effort, 'xhigh');
  assert.deepEqual(action.patch.execution.capabilities, ['interrupt_receipt_v1']);
});

test('Relay pending supplemental input keeps the task active despite an earlier zero SDK queue count', () => {
  const action = normalizeClaudeTaskEvent(
    { type: 'result', subtype: 'success', result: 'intermediate', queued_turn_count: 0, relay_pending_inputs: 1 },
    { state: 'running', progress: {}, result: {} }, now,
  );
  assert.equal(action.kind, 'update'); assert.equal(action.patch.state, 'running');
  assert.equal(action.patch.executorState, 'active'); assert.equal(action.patch.phase, 'running');
  assert.equal(action.patch.progress.label, '正在处理排队消息');
});
