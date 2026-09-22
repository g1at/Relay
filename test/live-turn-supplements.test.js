'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTurnRouter } = require('../src/main/live/live-turn-router');
const start = id => ({ type: 'stream_event', user_message_uuid: id, event: { type: 'message_start', message: { id: 'reply-' + id } } });
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (id, extra = {}) => ({ type: 'result', subtype: 'success', result: 'answer', queued_turn_count: 0, user_message_uuid: id, ...extra });
const lifecycle = (id, state) => ({ type: 'command_lifecycle', command_uuid: id, state, uuid: 'event-' + id + '-' + state, session_id: 'synthetic-session' });
function router() { const value = new LiveTurnRouter(); value.begin('A'); value.accept(start('A')); return value; }

test('registering a supplement preserves the ongoing reply and its unstamped frames', () => {
  const r = router();
  assert.equal(r.registerSupplement('B'), true);
  assert.equal(r.replyOwner, 'A');
  const next = delta('A keeps working');
  assert.equal(r.accept(next), next);
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
  assert.equal(r.pendingSupplementCount, 1);
});

test('queued receipts, user replay echoes and an old zero-queue result do not prove consumption', () => {
  const r = router(); r.registerSupplement('B');
  for (const event of [lifecycle('B', 'queued'), { type: 'user', uuid: 'B', isReplay: true, message: { content: 'supplement' } }, result('A')]) {
    assert.equal(r.accept(event), event);
    assert.deepEqual(r.pendingSupplementIds(), ['B']);
  }
  assert.equal(r.hasPendingSupplements(), true);
});

test('mid-turn absorption clears only the started supplement while the result may still belong to A', () => {
  const r = router(); r.registerSupplement('B'); r.registerSupplement('C');
  r.accept(lifecycle('B', 'started'));
  assert.deepEqual(r.pendingSupplementIds(), ['C']);
  assert.equal(r.replyOwner, 'A');
  assert.ok(r.accept(delta('A includes the supplement')));
  r.accept(lifecycle('C', 'started'));
  assert.equal(r.pendingSupplementCount, 0);
  const final = result('A');
  assert.equal(r.accept(final), final);
});

test('a coalesced batch needs no independent result for each consumed input', () => {
  const r = router();
  for (const id of ['B', 'C', 'D']) r.registerSupplement(id);
  for (const id of ['B', 'C', 'D']) r.accept(lifecycle(id, 'started'));
  assert.ok(r.accept(start('B')));
  assert.ok(r.accept(result('B')));
  assert.equal(r.hasPendingSupplements(), false);
  assert.deepEqual([...r.sentIds], ['A', 'B', 'C', 'D']);
});

test('a stamped reply or successful result consumes only its own known supplement', () => {
  const r = router(); r.registerSupplement('B'); r.registerSupplement('C'); r.registerSupplement('D');
  r.accept(start('B'));
  assert.deepEqual(r.pendingSupplementIds(), ['C', 'D']);
  r.accept(result('C'));
  assert.deepEqual(r.pendingSupplementIds(), ['D']);
  assert.equal(r.accept(result('foreign')), null);
  assert.deepEqual(r.pendingSupplementIds(), ['D']);
});

test('foreign lifecycle and child frames cannot consume a registered main-thread input', () => {
  const r = router(); r.registerSupplement('B');
  assert.equal(r.accept(lifecycle('foreign', 'started')), null);
  assert.equal(r.accept({ ...lifecycle('B', 'started'), parent_tool_use_id: 'foreign-agent' }), null);
  assert.equal(r.accept({ ...start('B'), parent_tool_use_id: 'foreign-agent' }), null);
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
  assert.ok(r.accept(delta('current A reply')));
});

test('missing-start completion acknowledgements and synthetic meta results cannot retire queued input', () => {
  const r = router(); r.registerSupplement('B');
  r.accept(lifecycle('B', 'completed'));
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
  assert.equal(r.accept(result('B', { result: '', origin: { kind: 'task-notification' }, num_turns: 0, duration_api_ms: 0 })), null);
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
});

test('a genuine error finishes through the caller error gate without falsely marking input applied', () => {
  const r = router(); r.registerSupplement('B');
  const failure = result('B', { subtype: 'error_during_execution', is_error: true, errors: ['synthetic delivery failure'] });
  assert.equal(r.accept(failure), failure);
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
  r.interrupt();
  assert.ok(r.accept({ type: 'result', subtype: 'success', terminal_reason: 'aborted_tools', queued_turn_count: 1 }));
  assert.equal(r.hasPendingSupplements(), true);
});

test('terminally rejected unconsumed inputs leave pending with a visible failure state', () => {
  for (const state of ['cancelled', 'discarded', 'refused']) {
    const r = router(); r.registerSupplement('B');
    const event = lifecycle('B', state);
    assert.equal(r.accept(event), event);
    assert.equal(r.hasPendingSupplements(), false);
    assert.deepEqual([...r.supplementFailures], [['B', state]]);
    r.accept(event);
    r.accept(lifecycle('B', 'queued'));
    assert.equal(r.supplementFailures.size, 1);
    assert.equal(r.hasPendingSupplements(), false);
    r.accept(lifecycle('B', 'started'));
    assert.equal(r.supplementFailures.size, 0, 'a later authoritative start proves actual consumption');
    const older = result('A', { user_message_uuids: ['A'] });
    r.accept(older);
    assert.equal(r.resultPendingSupplementCount(older), 1, 'corrected consumption still awaits its own terminal result');
    const final = result('B', { user_message_uuids: ['B'] });
    r.accept(final);
    assert.equal(r.resultPendingSupplementCount(final), 0);
  }
});

test('terminal repeats cannot relabel an already consumed supplement as unapplied', () => {
  const r = router(); r.registerSupplement('B'); r.accept(lifecycle('B', 'started'));
  for (const state of ['completed', 'cancelled', 'discarded', 'refused']) r.accept(lifecycle('B', state));
  assert.equal(r.supplementFailures.size, 0);
  assert.equal(r.hasPendingSupplements(), false);
});

test('registration is idempotent and rollback cannot forget a consumed send or the original input', () => {
  const r = router();
  assert.equal(r.registerSupplement('A'), false);
  assert.equal(r.registerSupplement(''), false);
  assert.equal(r.registerSupplement('B'), true);
  assert.equal(r.registerSupplement('B'), false);
  assert.equal(r.unregisterSupplement('A'), false);
  assert.equal(r.unregisterSupplement('B'), true);
  assert.equal(r.accept(start('B')), null);
  assert.ok(r.accept(start('A')));
  r.registerSupplement('C'); r.accept(lifecycle('C', 'started'));
  assert.equal(r.unregisterSupplement('C'), false);
  assert.ok(r.sentIds.has('C'));
});

test('ending a run clears pending/failures; internal repair keeps its existing turn-boundary behavior', () => {
  const r = router(); r.registerSupplement('B'); r.registerSupplement('C'); r.accept(lifecycle('C', 'refused'));
  r.end();
  assert.equal(r.registerSupplement('D'), false);
  assert.deepEqual(r.pendingSupplementIds(), []);
  assert.equal(r.supplementFailures.size, 0);
  r.begin('next'); r.accept(start('next')); r.addSend('repair');
  assert.equal(r.replyOwner, null);
  assert.equal(r.hasPendingSupplements(), false);
  assert.ok(r.accept(start('repair')));
});

test('SDK merged-message arrays retire every consumed own input even without started receipts', () => {
  const r = router(); for (const id of ['B', 'C', 'D']) r.registerSupplement(id);
  const frame = { ...start('C'), user_message_uuids: ['A', 'B', 'C'] };
  assert.equal(r.accept(frame), frame); assert.deepEqual(r.pendingSupplementIds(), ['D']);
  const final = result('D', { user_message_uuids: ['C', 'D'] });
  assert.equal(r.accept(final), final); assert.equal(r.hasPendingSupplements(), false);
});
test('merged replies can name another client last while still answering a known Relay input', () => {
  const r = router(); r.registerSupplement('B');
  const frame = { ...start('other-client'), user_message_uuids: ['B', 'other-client'] };
  assert.equal(r.accept(frame), frame); assert.equal(r.replyOwner, 'B');
  assert.equal(r.pendingSupplementCount, 0); assert.ok(r.accept(delta('shared reply')));
  assert.ok(r.accept(result('other-client', { user_message_uuids: ['B', 'other-client'] })));
});
test('foreign and child merged frames cannot falsely consume pending inputs', () => {
  const r = router(); r.registerSupplement('B');
  assert.equal(r.accept({ ...start('other-client'), user_message_uuids: ['unowned'] }), null);
  assert.equal(r.accept({ ...start('B'), user_message_uuids: ['B'], parent_tool_use_id: 'foreign-tool' }), null);
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
});

test('a queued input starting before an older result still needs a result that covers it', () => {
  const r = router(); r.registerSupplement('B');
  r.accept(lifecycle('B', 'started'));
  assert.equal(r.pendingSupplementCount, 0, 'SDK has absorbed the input');
  const oldResult = result('A', { user_message_uuids: ['A'] });
  assert.equal(r.accept(oldResult), oldResult);
  assert.equal(r.resultPendingSupplementCount(oldResult), 1, 'old answer must not finish the Relay task');
  r.accept(start('B'));
  assert.equal(r.resultPendingSupplementCount(oldResult), 1, 'first reply is not a terminal answer');
  const revised = result('B', { user_message_uuids: ['B'] });
  assert.equal(r.accept(revised), revised);
  assert.equal(r.resultPendingSupplementCount(revised), 0);
});

test('a final result covering a folded batch answers every absorbed supplement once', () => {
  const r = router(); r.registerSupplement('B'); r.registerSupplement('C');
  r.accept(lifecycle('B', 'started')); r.accept(lifecycle('C', 'started'));
  const final = result('A', { user_message_uuids: ['A', 'B', 'C'] });
  r.accept(final);
  assert.equal(r.resultPendingSupplementCount(final), 0);
  r.accept(final);
  assert.equal(r.resultPendingSupplementCount(final), 0);
});

test('root consumed lists acknowledge delivery on failed turns without changing their outcome', () => {
  for (const extra of [{ is_error: true }, { subtype: 'error_during_execution', is_error: true },
    { terminal_reason: 'aborted_streaming', is_error: true }, { terminal_reason: 'aborted_tools' },
    { permission_denials: [{ tool_name: 'fixture' }] }]) {
    const r = router(); r.registerSupplement('B'); r.registerSupplement('C');
    const event = result('A', { user_message_uuids: ['A', 'B'], num_turns: 3, ...extra });
    const original = structuredClone(event);
    assert.equal(r.accept(event), event);
    assert.deepEqual(event, original, 'delivery proof must not rewrite failure into success');
    assert.deepEqual(r.pendingSupplementIds(), ['C']);
    assert.equal(r.resultPendingSupplementCount(event), 1);
    assert.deepEqual([...r.awaitingSupplementResults], ['C']);
    r.accept(event);
    assert.equal(r.resultPendingSupplementCount(event), 1, 'duplicate receipts are idempotent');
  }
});

test('a final error can correct a canceled receipt for only its explicitly consumed inputs', () => {
  const r = router(); r.registerSupplement('B'); r.registerSupplement('C');
  r.accept(lifecycle('B', 'cancelled')); r.accept(lifecycle('C', 'refused'));
  const event = result('C', { user_message_uuids: ['A', 'B'], is_error: true, terminal_reason: 'aborted_streaming' });
  assert.equal(r.accept(event), event);
  assert.deepEqual([...r.supplementFailures], [['C', 'refused']]);
  assert.equal(r.resultPendingSupplementCount(event), 0);
  for (const state of ['cancelled', 'discarded', 'refused']) r.accept(lifecycle('B', state));
  assert.deepEqual([...r.supplementFailures], [['C', 'refused']]);
});

test('singular errors and aborted results cannot prove consumption or satisfy reply coverage', () => {
  for (const extra of [{ is_error: true }, { subtype: 'error_during_execution' },
    { terminal_reason: 'aborted_streaming' }, { terminal_reason: 'aborted_tools' },
    { permission_denials: [{ tool_name: 'fixture' }] }]) {
    const r = router(); r.registerSupplement('B');
    const event = result('B', extra);
    assert.equal(r.accept(event), event);
    assert.deepEqual(r.pendingSupplementIds(), ['B']);
    assert.deepEqual([...r.awaitingSupplementResults], ['B']);
  }
});

test('child, zero-turn and unowned results cannot satisfy outstanding reply coverage', () => {
  const r = router(); r.registerSupplement('B'); r.accept(lifecycle('B', 'started'));
  for (const extra of [{ num_turns: 0 }, { num_turns: 0, is_error: true },
    { parent_tool_use_id: 'foreign-tool' }, { parentToolUseId: 'foreign-tool' },
    { agent_id: 'foreign-agent' }, { subagent_type: 'fixture' }]) {
    const event = result('B', { user_message_uuids: ['B'], ...extra });
    r.accept(event);
    assert.equal(r.resultPendingSupplementCount(event), 1);
  }
  const foreign = result('foreign', { user_message_uuids: ['foreign'] });
  assert.equal(r.accept(foreign), null);
  assert.equal(r.resultPendingSupplementCount(foreign), 1);
});

test('a zero-turn consumed list cannot promote an unacknowledged supplement', () => {
  const r = router(); r.registerSupplement('B');
  r.accept(result('B', { num_turns: 0, user_message_uuids: ['A', 'B'], is_error: true }));
  assert.deepEqual(r.pendingSupplementIds(), ['B']);
});

test('rejected input and a later run cannot retain reply waits from an earlier run', () => {
  const r = router(); r.registerSupplement('B'); r.accept(lifecycle('B', 'refused'));
  const final = result('A', { user_message_uuids: ['A'] });
  r.accept(final);
  assert.equal(r.resultPendingSupplementCount(final), 0);
  r.registerSupplement('C'); r.accept(lifecycle('C', 'started'));
  r.begin('next');
  assert.equal(r.resultPendingSupplementCount(result('next', { user_message_uuids: ['next'] })), 0);
});

test('older results without a consumed-input list retain the lifecycle fallback', () => {
  const r = router(); r.registerSupplement('B');
  assert.equal(r.resultPendingSupplementCount(result('A')), 1);
  r.accept(lifecycle('B', 'started'));
  const final = result('A'); r.accept(final);
  assert.equal(r.resultPendingSupplementCount(final), 0);
});
