'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTurnRouter, isNotificationOnlyResult } = require('../src/main/live/live-turn-router');

const receipt = extra => ({ type: 'result', subtype: 'success', is_error: false,
  origin: { kind: 'task-notification' }, result: '', num_turns: 0, queued_turn_count: 0,
  duration_api_ms: 2300, result_index: 4, ...extra });

test('batched task-notification receipts are identified without assuming a zero API duration', () => {
  for (const duration_api_ms of [0, 2300, undefined]) {
    assert.equal(isNotificationOnlyResult(receipt({ duration_api_ms })), true);
  }
});

test('zero-turn user completions, commands, substantive output and explicit terminal outcomes are not receipts', () => {
  for (const extra of [
    { origin: undefined }, { origin: { kind: 'user' } }, { local_command: 'clear' },
    { result: 'completed without a model call' }, { structured_output: { ok: true } },
    { deferred_tool_use: { tool_name: 'fixture' } }, { num_turns: 1 }, { num_turns: undefined },
    { subtype: 'error_during_execution' }, { is_error: true },
    { permission_denials: [{ tool_name: 'Bash' }] },
    ...['aborted_streaming', 'aborted_tools', 'api_error', 'hook_stopped', 'tool_deferred', 'budget_exhausted']
      .map(terminal_reason => ({ terminal_reason })),
  ]) assert.equal(isNotificationOnlyResult(receipt(extra)), false, JSON.stringify(extra));
});

test('live routing waits past a batch receipt after the last agent completed and preserves the final summary', () => {
  const router = new LiveTurnRouter(); router.begin('user-1');
  router.accept({ type: 'assistant', user_message_uuid: 'user-1', message: { content: [
    { type: 'tool_use', id: 'agent-call-1', name: 'Agent' },
    { type: 'tool_use', id: 'agent-call-2', name: 'Agent' },
  ] } });
  for (const index of [1, 2]) router.accept({ type: 'system', subtype: 'task_started',
    task_id: `agent-${index}`, tool_use_id: `agent-call-${index}`, task_type: 'local_agent' });
  router.noteResult('wait', 2);
  for (const index of [1, 2]) assert.ok(router.accept({ type: 'system', subtype: 'task_notification',
    task_id: `agent-${index}`, tool_use_id: `agent-call-${index}`, status: 'completed' }));
  router.accept({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(router.accept(receipt()), null, 'a receipt cannot finish the run just because pending agents reached zero');
  assert.ok(router.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'combined final answer' }] } }));
  const terminal = receipt({ result_index: 5, num_turns: 1, result: 'combined final answer' });
  assert.strictEqual(router.accept(terminal), terminal);
});

test('a cancellation that resembles a batch receipt is still routed as the current turn outcome', () => {
  const router = new LiveTurnRouter(); router.begin('user-1'); router.interrupt();
  const terminal = receipt({ terminal_reason: 'aborted_tools', duration_api_ms: 0 });
  assert.strictEqual(router.accept(terminal), terminal);
});

test('late child replies while idle cannot overwrite the main reply owner or its correlation support', () => {
  for (const child of [{ agent_id: 'worker' }, { parent_tool_use_id: 'tool' }, { parentToolUseId: 'tool' }, { subagent_type: 'worker' }]) {
    const router = new LiveTurnRouter();
    router.accept({ type: 'assistant', user_message_uuid: 'previous-main' });
    assert.equal(router.replyOwner, 'previous-main');
    router.accept({ type: 'assistant', ...child, user_message_uuid: 'child-input' });
    assert.equal(router.replyOwner, 'previous-main');
    router.accept({ type: 'assistant', ...child });
    assert.equal(router.replyOwner, 'previous-main');
    const fresh = new LiveTurnRouter();
    fresh.accept({ type: 'assistant', ...child, user_message_uuid: 'child-input' });
    assert.equal(fresh.seenReplyUuid, false);
    assert.equal(fresh.replyOwner, null);
  }
});

test('task run generations filter late events and preserve current rows in mixed snapshots', () => {
  const router = new LiveTurnRouter(); router.begin('main');
  router.accept({ type: 'assistant', user_message_uuid: 'main', message: { content: [{ type: 'text', text: 'starting' }] } });
  const start = run_id => ({ type: 'system', subtype: 'task_started', task_id: 'agent', run_id, task_type: 'local_agent', description: run_id });
  assert.ok(router.accept(start('001'))); assert.ok(router.accept(start('002')));
  for (const subtype of ['task_started', 'task_progress', 'task_updated', 'task_notification']) {
    assert.equal(router.accept({ ...start('001'), subtype, status: 'failed', patch: { status: 'failed' } }), null);
  }
  const savedNotice = { type: 'user', origin: { kind: 'task-notification', runId: '001' },
    message: { content: '<task-notification><task-id>agent</task-id><status>failed</status></task-notification>' } };
  assert.equal(router.accept(savedNotice), null);
  assert.ok(router.accept({ ...start('003'), subtype: 'task_progress', description: 'Newest progress' }), 'a newer generation may first appear as progress');
  const snapshot = router.accept({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'agent', run_id: '001', task_type: 'local_agent', description: 'old snapshot' },
    { task_id: 'other', run_id: '001', task_type: 'shell', description: 'Other work' },
  ] });
  assert.deepEqual(snapshot.tasks.map(row => [row.task_id, row.run_id, row.description]), [
    ['agent', '003', 'Newest progress'], ['other', '001', 'Other work'],
  ]);
  assert.ok(router.accept({ type: 'system', subtype: 'task_notification', task_id: 'agent', run_id: '003', status: 'completed' }));
  const afterFinish = router.accept({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'agent', run_id: '001' }] });
  assert.deepEqual(afterFinish.tasks, [], 'an old snapshot cannot revive a completed newer run');
  assert.ok(router.accept({ type: 'system', subtype: 'task_notification', task_id: 'agent', status: 'completed' }), 'legacy events without run ID remain accepted');
});

test('task generations reset on a new host turn or native context without losing the current send identity', () => {
  const router = new LiveTurnRouter(); router.begin('main');
  const reply = () => router.accept({ type: 'assistant', user_message_uuid: 'main' });
  const start = run_id => ({ type: 'system', subtype: 'task_started', task_id: 'agent', run_id, task_type: 'local_agent' });
  reply(); router.accept(start('999'));
  router.resetConversation(); reply(); assert.ok(router.accept(start('001')));
  router.end(); assert.equal(router.taskRuns.size, 0);
  router.begin('main'); reply(); assert.ok(router.accept(start('000')));
  assert.ok(router.sentIds.has('main'));
});

test('agent-only user echoes cannot acknowledge a root send or change its reply owner', () => {
  const router = new LiveTurnRouter(); router.begin('main');
  router.accept({ type: 'user', agent_id: 'worker', uuid: 'main', message: { content: 'child input' } });
  assert.equal(router.userAccepted, false); assert.equal(router.replyOwner, null);
  router.accept({ type: 'user', uuid: 'main', message: { content: 'root input' } });
  assert.equal(router.userAccepted, true); assert.equal(router.replyOwner, 'main');
});
