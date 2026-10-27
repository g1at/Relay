'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeMetadataWriter, completeConversationTurn } = require('../src/main/app/conversation-mutations');
const clone = value => JSON.parse(JSON.stringify(value));
const first = { runId: 'run-a', ts: '2026-09-28T07:04:42.155Z', user: 'first', assistant: 'saved answer', status: 'complete' };
const second = { runId: 'run-b', ts: '2026-09-28T09:10:12.672Z', user: 'next', assistant: '' };
function fixture(turns = [first]) {
  let record = { id: 'conversation', model: 'haiku', sessionId: 'old-session', sessionProviderId: 'old', sessionProviderRevision: 1,
    title: 'keep title', pinned: true, updatedAt: '2026-09-28T09:10:12.672Z', turns: clone(turns) };
  let writes = 0;
  const store = { load: () => clone(record), persist: value => { record = clone(value); writes++; } };
  return { store, read: () => clone(record), replace: value => { record = clone(value); }, writes: () => writes };
}
test('runtime settings are a narrow mutation of latest metadata, preserving content and activity time', () => {
  const f = fixture(), writer = createRuntimeMetadataWriter(f.store), token = writer.begin('conversation');
  f.replace({ ...f.read(), title: 'renamed while waiting', pinned: false });
  const r = writer.finish(token, { ok: true, restartRequired: true, providerId: 'new', providerRevision: 2 }, { tier: 'sonnet', effort: 'max' });
  assert.equal(r.stale, undefined); assert.equal(f.read().title, 'renamed while waiting'); assert.equal(f.read().pinned, false);
  assert.deepEqual(f.read().turns, [first]); assert.equal(f.read().updatedAt, '2026-09-28T09:10:12.672Z');
  assert.equal(f.read().sessionId, null); assert.equal(f.read().model, 'sonnet'); assert.equal(f.read().effort, null);
});
test('late runtime response cannot delete a later turn or detach its new session', () => {
  const f = fixture(), writer = createRuntimeMetadataWriter(f.store), token = writer.begin('conversation');
  f.replace({ ...f.read(), sessionId: 'new-session', turns: [first, second] });
  const before = f.read();
  assert.equal(writer.finish(token, { ok: true, restartRequired: true }, { tier: 'sonnet' }).stale, true);
  assert.deepEqual(f.read(), before); assert.equal(f.writes(), 0);
});
test('later request invalidates earlier response even if no message was appended', () => {
  const f = fixture(), writer = createRuntimeMetadataWriter(f.store), old = writer.begin('conversation'), latest = writer.begin('conversation');
  writer.finish(latest, { ok: true, applied: true, providerId: 'old', providerRevision: 1 }, { tier: 'opus' });
  const before = f.read();
  assert.equal(writer.finish(old, { ok: true }, { tier: 'sonnet' }).stale, true); assert.deepEqual(f.read(), before);
});
test('completion rejects a different task or timestamp without touching old output', () => {
  const f = fixture(), before = f.read();
  for (const [runId, ts] of [['run-b', second.ts], ['run-a', second.ts], [null, first.ts]]) {
    assert.throws(() => completeConversationTurn(f.store, 'conversation', runId, ts, { turn: { assistant: 'wrong' } }), /标识|不匹配/);
  }
  assert.deepEqual(f.read(), before); assert.equal(f.writes(), 0);
});
test('completion writes only identified turn and never replaces later turns or their session', () => {
  const f = fixture([first, second]); f.replace({ ...f.read(), sessionId: 'new-session' });
  const outcome = { assistant: 'verified final', status: 'complete', assistantTs: '2026-09-28T09:01:28.211Z' };
  completeConversationTurn(f.store, 'conversation', first.runId, first.ts, { turn: outcome, session: { sessionId: 'old-session' } });
  assert.equal(f.read().turns[0].assistant, outcome.assistant); assert.equal(f.read().turns[0].user, 'first');
  assert.deepEqual(f.read().turns[1], second); assert.equal(f.read().sessionId, 'new-session');
  assert.equal(f.read().updatedAt, '2026-09-28T09:10:12.672Z');
});
test('completion rejects ambiguous duplicate task identity', () => {
  const f = fixture([first, { ...first, ts: second.ts }]);
  assert.throws(() => completeConversationTurn(f.store, 'conversation', first.runId, first.ts, { turn: { assistant: 'wrong' } }), /不匹配/);
  assert.equal(f.writes(), 0);
});
test('retry only removes the exact empty final placeholder', () => {
  const f = fixture([first, second]);
  assert.throws(() => completeConversationTurn(f.store, 'conversation', first.runId, first.ts, { retryWithoutResume: true }), /不能自动重试/);
  const r = completeConversationTurn(f.store, 'conversation', second.runId, second.ts, { retryWithoutResume: true });
  assert.deepEqual(r.conversation.turns, [first]); assert.equal(r.conversation.sessionId, null);
});
test('terminal payload cannot rewrite user text, identifiers, or unrelated metadata', () => {
  const f = fixture([first, second]);
  completeConversationTurn(f.store, 'conversation', second.runId, second.ts, { turn: { assistant: 'second result', status: 'complete',
    user: 'forged', runId: 'run-a', ts: first.ts, title: 'forged', activity: undefined } });
  assert.deepEqual(f.read().turns[0], first); assert.equal(f.read().turns[1].user, 'next');
  assert.equal(f.read().turns[1].runId, 'run-b'); assert.equal(f.read().title, 'keep title');
});

test('restart recovery pauses the matched turn without moving history order or losing metadata', () => {
  const f = fixture([first, second]);
  const expected = clone(second);
  f.replace({ ...f.read(), title: 'renamed during replay', pinned: false });
  const outcome = { status: 'paused', error: null, activity: { phase: 'error', error: '已暂停' },
    taskRun: { segmentFinishedAt: Date.parse('2026-09-28T09:11:00.000Z') } };
  const paused = { runId: second.runId, at: '2026-09-28T09:11:00.000Z' };
  const result = completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
    recoveryExpectedTurn: expected, recoveryPreserveUpdatedAt: true, turn: outcome, paused,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stale, undefined);
  assert.equal(f.read().turns[1].status, 'paused');
  assert.equal(f.read().turns[1].user, second.user);
  assert.deepEqual(f.read().paused, paused);
  assert.deepEqual(f.read().turns[0], first);
  assert.equal(f.read().title, 'renamed during replay');
  assert.equal(f.read().pinned, false);
  assert.equal(f.read().updatedAt, '2026-09-28T09:10:12.672Z');
});

test('recovery cannot overwrite a result or user edit written while logs replay', () => {
  for (const change of [{ assistant: 'new complete answer', status: 'complete' }, { user: 'edited prompt' },
    { status: 'paused', activity: { phase: 'error', error: '已暂停' } }]) {
    const f = fixture([first, second]), expected = clone(second);
    f.replace({ ...f.read(), turns: [first, { ...second, ...change }] });
    const before = f.read();
    const result = completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
      recoveryExpectedTurn: expected, recoveryPreserveUpdatedAt: true,
      turn: { status: 'paused', assistant: '' }, paused: { runId: second.runId },
    });
    assert.equal(result.ok, true); assert.equal(result.stale, true);
    assert.deepEqual(result.conversation, before);
    assert.deepEqual(f.read(), before); assert.equal(f.writes(), 0);
  }
});

test('recovery of an earlier turn preserves a newly appended task and its continuation pointer', () => {
  const f = fixture([second]), expected = clone(second);
  const later = { runId: 'run-c', ts: '2026-09-28T10:00:00.000Z', user: 'later', status: 'paused' };
  f.replace({ ...f.read(), turns: [second, later], sessionId: 'later-session', paused: { runId: later.runId, at: later.ts } });
  const before = f.read();
  completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
    recoveryExpectedTurn: expected, recoveryPreserveUpdatedAt: true,
    turn: { status: 'paused' }, session: { sessionId: 'old-session' }, paused: { runId: second.runId, at: second.ts },
  });
  assert.equal(f.read().turns[0].status, 'paused'); assert.deepEqual(f.read().turns[1], later);
  assert.equal(f.read().sessionId, before.sessionId); assert.deepEqual(f.read().paused, before.paused);
  assert.equal(f.read().updatedAt, before.updatedAt);
});

test('recovery after deletion cannot recreate the conversation', () => {
  const f = fixture([second]); f.replace(null);
  assert.throws(() => completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
    recoveryExpectedTurn: second, recoveryPreserveUpdatedAt: true,
    turn: { status: 'paused' }, paused: { runId: second.runId },
  }), { code: 'TURN_NOT_FOUND' });
  assert.equal(f.read(), null); assert.equal(f.writes(), 0);
});

test('recovery retains a newly discovered native session only while its execution context matches', () => {
  for (const changed of [false, true]) {
    const f = fixture([second]);
    f.replace({ ...f.read(), sessionId: null, projectId: 'original-project', workingDir: { path: 'D:/original' } });
    const expectedContext = f.read();
    if (changed) f.replace({ ...f.read(), projectId: 'new-project', workingDir: { path: 'D:/new' },
      carryContextOnNextTurn: 'project', sessionProviderId: null });
    completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
      recoveryExpectedTurn: second, recoveryExpectedSession: expectedContext, recoveryPreserveUpdatedAt: true,
      turn: { status: 'paused' }, paused: { runId: second.runId, at: second.ts },
      session: { sessionId: 'recovered-native-session', sessionProviderId: 'old' },
    });
    assert.equal(f.read().turns[0].status, 'paused');
    assert.equal(f.read().paused.runId, second.runId);
    assert.equal(f.read().sessionId, changed ? null : 'recovered-native-session');
    assert.equal(f.read().sessionProviderId, changed ? null : 'old');
    if (changed) {
      assert.equal(f.read().projectId, 'new-project');
      assert.equal(f.read().workingDir.path, 'D:/new');
      assert.equal(f.read().carryContextOnNextTurn, 'project');
    }
  }
});

test('a session reset made before recovery starts cannot be undone by the old task checkpoint', () => {
  const f = fixture([second]);
  f.replace({ ...f.read(), sessionId: null, sessionProviderId: null, carryContextOnNextTurn: 'provider' });
  const before = f.read();
  completeConversationTurn(f.store, 'conversation', second.runId, second.ts, {
    recoveryExpectedTurn: second, recoveryExpectedSession: before, recoveryPreserveUpdatedAt: true,
    turn: { status: 'paused' }, paused: { runId: second.runId, at: second.ts },
    session: { sessionId: 'obsolete-session', sessionProviderId: 'old' },
  });
  assert.equal(f.read().turns[0].status, 'paused');
  assert.equal(f.read().sessionId, null); assert.equal(f.read().sessionProviderId, null);
  assert.equal(f.read().carryContextOnNextTurn, 'provider');
});
