'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPrewarmState, canReuseFreshPrewarm } = require('../live-prewarm-reuse');
function fixture() {
  const record = { id: 'conversation', turns: [{ runId: 'earlier', user: 'earlier input' }] };
  const session = { convId: record.id, fingerprint: 'full-runtime-fingerprint', observer: { epoch: 0 },
    prewarm: createPrewarmState(record), sessionId: 'learned-after-init' };
  const options = { conversationId: record.id, fingerprint: session.fingerprint, record, routeMatches: true, workspaceAccepts: true };
  return { record, session, options, reusable: () => canReuseFreshPrewarm(session, options) };
}

test('a newly initialized empty Query can replace the renderer stale native handle', () => {
  const h = fixture();
  assert.equal(h.reusable(), true);
  h.record.sessionId = h.session.sessionId;
  h.record.carryContextOnNextTurn = 'provider';
  h.record.turns.push({ runId: 'new-placeholder', user: 'current request' });
  assert.equal(h.reusable(), true, 'placeholder and init persistence do not change the clear boundary');
});

test('resumed and forked Queries are never certified empty', () => {
  for (const options of [{ resumed: true }, { forked: true }]) assert.equal(createPrewarmState({}, options), null);
  assert.equal(createPrewarmState({ pendingSdkFork: { targetSessionId: 'fork' } }), null);
  const h = fixture(); h.record.pendingSdkFork = { targetSessionId: 'fork' };
  assert.equal(h.reusable(), false);
});

test('completed, queued, busy, dead, foreign and untracked Queries cannot bypass a fresh request', () => {
  for (const change of [{ prewarm: null }, { pendingInput: {} }, { busy: true }, { dead: true },
    { convId: 'other' }, { fingerprint: 'changed-config' }]) {
    const h = fixture(); Object.assign(h.session, change); assert.equal(h.reusable(), false);
  }
  for (const change of [{ routeMatches: false }, { workspaceAccepts: false }, { conversationId: 'other' }]) {
    const h = fixture(); Object.assign(h.options, change); assert.equal(h.reusable(), false);
  }
});

test('idle clear, native reset and persisted in-turn reset invalidate the earlier prewarm generation', () => {
  for (const update of [
    h => { h.record.sdkContextBoundary = { turnIndex: 1, afterRunId: 'earlier' }; },
    h => { h.session.observer.epoch = 1; },
    h => { h.record.turns[0].output = { contextEpoch: 1, resets: [{ uuid: 'reset', conversationId: 'new-sdk', contextEpoch: 1 }] }; },
  ]) { const h = fixture(); update(h); assert.equal(h.reusable(), false); }
});

test('a replacement created after an explicit clear uses that boundary and remains reusable', () => {
  const h = fixture(); h.record.sdkContextBoundary = { turnIndex: 1, afterRunId: 'earlier' };
  h.session.prewarm = createPrewarmState(h.record);
  assert.equal(h.reusable(), true);
  h.record.sdkContextBoundary.afterRunId = 'another-run';
  assert.equal(h.reusable(), false);
});
