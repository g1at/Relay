'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Output = require('../renderer/assistant-output');
const Activity = require('../renderer/activity-stream');
const Errors = require('../renderer/conversation-errors');
const { harness } = require('./renderer-activity-harness.cjs');
const { createLegacyOutputRecovery } = require('../legacy-output-recovery');
const clone = value => JSON.parse(JSON.stringify(value));
const ids = { conv: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222' };
const denial = [{ tool_name: 'PowerShell' }];
const deniedError = '工具权限被拒绝（1 次）：PowerShell';
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, result: 'The diagnostic checks finished. Here are the findings.',
  terminal_reason: 'completed', stop_reason: 'end_turn', num_turns: 80, queued_turn_count: 0,
  permission_denials: denial, ...extra });

test('a successful final answer survives an earlier denied tool while the tool failure remains inspectable', async () => {
  const h = harness();
  h.send({ type: 'assistant', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'denied-tool', name: 'PowerShell', input: {} }] } });
  h.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'denied-tool', is_error: true, content: 'Managed memory policy rejected this operation.' }] } });
  h.send(result());
  assert.equal(h.run.error, undefined);
  assert.equal(h.run.turn.assistant, '');
  assert.equal(h.run.activityState.items.find(item => item.toolUseId === 'denied-tool').status, 'error');
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: 0, finalResult: result() });
  assert.equal(h.run.turn.status, 'complete');
  assert.equal(h.run.turn.assistant, result().result);
  assert.match(h.run.turn.outputNotice, /1 次工具请求被拒绝（PowerShell）/);
  assert.equal(h.persisted.turns[0].activity.phase, 'complete');
  assert.equal(h.persisted.turns[0].activity.items.find(item => item.toolUseId === 'denied-tool').status, 'error');
  assert.equal(Errors.forTurn(h.run.turn), '');
});

test('permission history is informational with empty final evidence and cannot manufacture an answer', () => {
  const state = Output.createState();
  Output.ingest(state, result({ result: '' }));
  assert.equal(Output.finish(state, { exitCode: 0 }), '');
  assert.match(state.notice, /未取得最终回复/);
  assert.match(state.notice, /工具请求被拒绝/);
});

test('native aborted result remains canceled without a local pause click even when denials are accumulated', async () => {
  const h = harness();
  const terminal = result({ terminal_reason: 'aborted_tools' });
  h.send(terminal);
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: 0, finalResult: terminal });
  assert.equal(h.run.turn.status, 'canceled');
  assert.equal(h.run.turn.assistant, '');
  assert.equal(h.persisted.turns[0].activity.phase, 'error');
});

test('a real current end_turn can supply empty-result fallback even when an earlier tool was denied', () => {
  const state = Output.createState();
  Output.ingest(state, { type: 'assistant', message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Actual final answer' }] } });
  assert.equal(Output.finish(state, { exitCode: 0, finalResult: result({ result: '' }) }), 'Actual final answer');
  assert.match(state.notice, /工具请求被拒绝/);
});

test('a denial cannot override actual SDK errors, cancellation, nonzero exits, child ownership or pending work', () => {
  for (const extra of [{ is_error: true, errors: ['Actual provider failure'] }, { subtype: 'error_max_turns' },
    { terminal_reason: 'aborted_tools' }, { parent_tool_use_id: 'child' }, { queued_turn_count: 1 },
    { relay_pending_inputs: 1 }, { relay_pending_background_tasks: 1 }]) {
    const state = Output.createState();
    assert.equal(Output.finish(state, { exitCode: 0, finalResult: result(extra) }), '');
  }
  for (const [done, options] of [[{ exitCode: 1 }, {}], [{ exitCode: 0, error: 'Host failure' }, {}], [{ exitCode: 0 }, { aborted: true }]]) {
    assert.equal(Output.finish(Output.createState(), { ...done, finalResult: result() }, options), '');
  }
  const activity = Activity.createState();
  Activity.finish(activity, null, { exitCode: 1, finalResult: result({ is_error: true, errors: ['Actual provider failure'] }) });
  assert.equal(activity.error, 'Actual provider failure');
  const terminal = result({ is_error: true, result: 'Actual native execution failure' });
  const h = harness(); h.send(terminal);
  assert.equal(h.run.error, terminal.result);
  assert.equal(h.run.activityState.error, terminal.result);
  Activity.finish(activity, null, { exitCode: 1, finalResult: terminal });
  assert.equal(activity.error, terminal.result);
});

function historyFixture() {
  const terminal = result({ jobId: ids.run, uuid: 'native-result', session_id: 'native-session', user_message_uuid: ids.run });
  const state = Output.createState(); Output.ingest(state, terminal);
  Output.finish(state, { exitCode: 1, error: deniedError, finalResult: terminal });
  const turn = { runId: ids.run, status: 'error', error: deniedError, assistant: '', output: Output.serialize(state),
    activity: { phase: 'error', error: deniedError, items: [{ type: 'tool', status: 'error', error: 'Specific policy denial' }] } };
  const conversation = { id: ids.conv, updatedAt: '2026-09-21T03:10:23Z', turns: [turn] };
  const run = { runId: ids.run, state: 'failed', source: { conversationId: ids.conv }, execution: { sessionId: 'native-session' },
    endedAt: '2026-09-21T03:08:29Z', result: { error: deniedError, sdk: { terminalReason: 'completed', userMessageUuid: ids.run } } };
  const recover = createLegacyOutputRecovery({ fileSystem: { readFileSync: () => JSON.stringify(run) } });
  return { conversation, turn, run, recover: () => recover(conversation, { rootDir: '/synthetic/ledger' }), terminal };
}

test('exact saved denial-only failure is projected read-only from matching completed SDK and ledger evidence', () => {
  const h = historyFixture(), original = clone(h.conversation), projected = h.recover();
  assert.equal(projected.turns[0].assistant, h.terminal.result);
  assert.equal(projected.turns[0].status, 'complete');
  assert.equal(projected.turns[0].output.status, 'complete');
  assert.equal(projected.turns[0].activity.phase, 'complete');
  assert.equal(projected.turns[0].activity.items[0].status, 'error');
  assert.match(projected.turns[0].outputNotice, /工具请求被拒绝/);
  assert.deepEqual(h.conversation, original);
  assert.equal(projected.updatedAt, original.updatedAt);
  assert.equal(createLegacyOutputRecovery()(projected), projected);
});

test('saved unrelated failures, interrupted tasks, stale or unconfirmed results cannot use denial recovery', () => {
  const mutations = [h => h.turn.error = 'Host transport failed', h => h.turn.status = 'paused',
    h => h.turn.output.resultRevision--, h => h.turn.output.lastResult.jobId = 'other',
    h => h.turn.output.lastResult.is_error = true, h => h.turn.output.lastResult.num_turns = 0,
    h => h.turn.output.lastResult.result = '', h => h.turn.output.lastResult.errors = ['Provider failure'],
    h => h.turn.output.lastResult.terminal_reason = 'aborted_tools',
    h => h.turn.output.lastResult.parent_tool_use_id = 'child', h => h.turn.output.lastResult.queued_turn_count = 1,
    h => h.turn.output.lastResult.relay_pending_background_tasks = 1,
    h => h.turn.output.retractedMessageUuids = ['withdrawn'], h => h.run.state = 'running',
    h => h.run.result.error = 'Crash', h => h.run.result.exitCode = 1, h => h.run.execution.sessionId = 'different-session',
    h => h.run.cancelRequestedAt = '2026-09-21T03:08:25Z', h => h.run.source.conversationId = 'other',
  ];
  for (const mutate of mutations) {
    const h = historyFixture(); mutate(h);
    assert.equal(h.recover(), h.conversation, mutate.toString());
  }
});

test('denial recovery removes only its obsolete missing-answer notice and avoids duplicate denial notices', () => {
  const h = historyFixture();
  const notice = Output.permissionNotice(h.terminal);
  h.turn.outputNotice = '任务已结束，但未取得最终回复。已保留可恢复的执行过程。\nKeep this independent notice.\n' + notice;
  assert.equal(h.recover().turns[0].outputNotice, 'Keep this independent notice.\n' + notice);
});
