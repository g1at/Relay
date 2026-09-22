'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consumeOneShotMessages,
  oneShotTerminalError,
  sanitizeResultPermissionDenials,
} = require('../src/main/sdk/claude-sdk');

test('一次性执行在后台 Bash 后的最终 result 立即停止消费', async () => {
  const emitted = [];
  let iteratorClosed = false;
  async function* messages() {
    try {
      yield { type: 'system', subtype: 'task_started', task_id: 'shell', tool_use_id: 'call_shell', task_type: 'shell' };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '不应再消费' }] } };
    } finally {
      iteratorClosed = true;
    }
  }

  await consumeOneShotMessages(messages(), (event) => emitted.push(event));
  assert.deepEqual(emitted.map((event) => event.type), ['system', 'result']);
  assert.equal(iteratorClosed, true);
});

test('一次性执行等待真实 Agent，归零后的最终 result 才停止', async () => {
  const emitted = [];
  async function* messages() {
    yield {
      type: 'system', subtype: 'task_started', task_id: 'agent',
      tool_use_id: 'call_agent', task_type: 'local_agent', subagent_type: 'analyst',
    };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'waiting' };
    yield { type: 'system', subtype: 'task_notification', task_id: 'agent', tool_use_id: 'call_agent', status: 'completed' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'final' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '不应再消费' }] } };
  }

  const terminal = await consumeOneShotMessages(messages(), (event) => emitted.push(event));
  assert.deepEqual(emitted.map((event) => event.type), ['system', 'result', 'system', 'result']);
  assert.equal(terminal.result, 'final');
});

test('一次性执行遇到错误 result 时不再等待残留 Agent', async () => {
  const emitted = [];
  let iteratorClosed = false;
  async function* messages() {
    try {
      yield {
        type: 'system', subtype: 'task_started', task_id: 'agent-error',
        tool_use_id: 'call_agent_error', task_type: 'local_agent', subagent_type: 'analyst',
      };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true };
      yield { type: 'system', subtype: 'task_notification', task_id: 'agent-error', status: 'completed' };
    } finally {
      iteratorClosed = true;
    }
  }

  await consumeOneShotMessages(messages(), (event) => emitted.push(event));
  assert.deepEqual(emitted.map((event) => event.type), ['system', 'result']);
  assert.equal(iteratorClosed, true);
});

test('一次性执行等待 SDK 明确报告的排队轮次', async () => {
  const emitted = [];
  async function* messages() {
    yield { type: 'result', subtype: 'success', is_error: false, result: 'first', queued_turn_count: 1 };
    yield { type: 'assistant', user_message_uuid: 'queued-turn', message: { content: [{ type: 'text', text: 'next' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'second', queued_turn_count: 0 };
  }

  const terminal = await consumeOneShotMessages(messages(), (event) => emitted.push(event));
  assert.deepEqual(emitted.map((event) => event.type), ['result', 'assistant', 'result']);
  assert.equal(terminal.result, 'second');
});

test('一次性执行按最终 result 语义判错，不能被正常退出掩盖', () => {
  assert.equal(oneShotTerminalError({ type: 'result', subtype: 'success', is_error: false }), null);
  assert.equal(
    oneShotTerminalError({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tool failed',
    }),
    'tool failed',
  );
  assert.equal(oneShotTerminalError(null), 'Claude 未返回最终结果');
});

test('一次性成功执行保留工具拒绝记录且转发前移除工具输入', async () => {
  const secretInput = { document_id: 'sensitive-document', token: 'must-not-persist' };
  const raw = {
    type: 'result', subtype: 'success', is_error: false, result: '已完成可执行的检查并说明限制',
    permission_denials: [
      { tool_name: 'mcp__feishu__doc_read', tool_use_id: 'tool-1', tool_input: secretInput },
      { tool_name: 'Bash', tool_use_id: 'tool-2', tool_input: { command: 'private command' } },
    ],
  };
  const emitted = [];
  async function* messages() { yield raw; }

  const terminal = await consumeOneShotMessages(messages(), (event) => emitted.push(event));

  assert.strictEqual(terminal, raw, '终态判定应继续使用 SDK 原始权威结果');
  assert.equal(oneShotTerminalError(terminal), null);
  assert.deepEqual(emitted[0].permission_denials, [
    { tool_name: 'mcp__feishu__doc_read' },
    { tool_name: 'Bash' },
  ]);
  const persisted = JSON.stringify(emitted[0]);
  assert.doesNotMatch(persisted, /sensitive-document|must-not-persist|private command|tool_input|tool_use_id/);
});

test('成功阶段结果含工具拒绝时等待已运行 Agent，不重发被拒操作', async () => {
  const emitted = [];
  let iteratorClosed = false;
  async function* messages() {
    try {
      yield {
        type: 'system', subtype: 'task_started', task_id: 'agent-denied',
        tool_use_id: 'call_denied', task_type: 'local_agent', subagent_type: 'analyst',
      };
      yield {
        type: 'result', subtype: 'success', is_error: false,
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'private command' } }],
      };
      yield { type: 'system', subtype: 'task_notification', task_id: 'agent-denied', tool_use_id: 'call_denied', status: 'completed' };
      yield { type: 'result', subtype: 'success', is_error: false, result: '最终结论', permission_denials: [{ tool_name: 'Bash' }] };
    } finally {
      iteratorClosed = true;
    }
  }

  const terminal = await consumeOneShotMessages(messages(), (event) => emitted.push(event));

  assert.equal(oneShotTerminalError(terminal), null);
  assert.equal(terminal.result, '最终结论');
  assert.deepEqual(emitted.map((event) => event.type), ['system', 'result', 'system', 'result']);
  assert.equal(iteratorClosed, true);
  assert.doesNotMatch(JSON.stringify(emitted), /private command|tool_input/);
});

test('工具拒绝不改变空正文成功结果，真实异常仍保留原始故障而非拒绝摘要', () => {
  const base = { type: 'result', subtype: 'success', is_error: false, result: '', permission_denials: [{ tool_name: 'PowerShell' }] };
  assert.equal(oneShotTerminalError(base), null);
  assert.equal(oneShotTerminalError({ ...base, is_error: true, errors: ['provider disconnected'] }), 'provider disconnected');
  assert.equal(oneShotTerminalError({ ...base, subtype: 'error_during_execution', result: 'native failure' }), 'native failure');
  assert.equal(oneShotTerminalError({ ...base, terminal_reason: 'aborted_tools' }), 'Claude 执行已中止');
});

test('成功含拒绝的排队阶段不能提前结束一次性消费', async () => {
  const emitted = [];
  const denial = { permission_denials: [{ tool_name: 'PowerShell', tool_input: { command: 'private command' } }] };
  async function* messages() {
    yield { type: 'result', subtype: 'success', is_error: false, queued_turn_count: 1, result: 'first', ...denial };
    yield { type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0, result: 'final', ...denial };
  }
  const terminal = await consumeOneShotMessages(messages(), event => emitted.push(event));
  assert.equal(emitted.length, 2); assert.equal(terminal.result, 'final');
  assert.equal(oneShotTerminalError(terminal), null);
  assert.doesNotMatch(JSON.stringify(emitted), /private command|tool_input/);
});

test('常驻会话共用权限拒绝脱敏边界', () => {
  const sanitized = sanitizeResultPermissionDenials({
    type: 'result', subtype: 'success',
    permission_denials: [{
      tool_name: 'PowerShell', tool_use_id: 'private-id',
      tool_input: { command: 'private command' },
    }],
  });

  assert.deepEqual(sanitized.permission_denials, [{ tool_name: 'PowerShell' }]);
  assert.doesNotMatch(JSON.stringify(sanitized), /private-id|private command|tool_input|tool_use_id/);
});

test('一次性恢复忽略无 UUID 的零轮后台通知结果，等待真正用户结果', async () => {
  const emitted = [];
  async function* messages() {
    yield { type: 'system', subtype: 'task_notification', task_id: 'old-shell', status: 'stopped' };
    yield {
      type: 'result', subtype: 'success', is_error: false, result: '',
      num_turns: 0, duration_api_ms: 0, queued_turn_count: 0,
      origin: { kind: 'task-notification' },
    };
    yield {
      type: 'stream_event', user_message_uuid: 'new-user',
      event: { type: 'message_start', message: { id: 'actual-message' } },
    };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'actual final' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'new-user', result: 'actual final' };
  }
  const terminal = await consumeOneShotMessages(messages(), (event) => emitted.push(event), { userMessageId: 'new-user' });
  assert.equal(terminal.result, 'actual final');
  assert.equal(emitted.some((event) => event.subtype === 'task_notification'), false);
  assert.equal(emitted.filter((event) => event.type === 'result').length, 1);
});
