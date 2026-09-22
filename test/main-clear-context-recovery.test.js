'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Context = require('../renderer/conversation-context');
const { protectSdkMetadata } = require('../src/main/sdk/sdk-session-provenance');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('claude:clearContext'");
const end = source.indexOf('\n});', start) + 4;
function harness() {
  let handler; const record = { id: 'fixture', updatedAt: 'unchanged', turns: [{ runId: 'old', user: 'old input', assistant: 'old answer' }] };
  const sess = { busy: false, executionMode: { kind: 'plan' }, observer: { epoch: 0 }, sessionId: 'before', child: {} };
  const sessions = new Map([['fixture', sess]]), writes = [];
  sess.child.clearContext = async () => { sess.observer.epoch++; sess.sessionId = 'after'; return { ok: true }; };
  const context = { liveSessions: sessions, ipcMain: { handle: (_, fn) => { handler = fn; } },
    loadConversation: () => structuredClone(record), persistConversationRecord: value => { writes.push(value); Object.assign(record, value); } };
  vm.runInNewContext(source.slice(start, end), context);
  return { record, sess, sessions, writes, clear: () => handler({}, { conversationId: 'fixture' }) };
}
test('idle native clear persists a recovery boundary without deleting visible history or changing activity time', async () => {
  const h = harness(), before = JSON.stringify(h.record.turns), result = await h.clear();
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'after');
  assert.equal(result.sdkContextBoundary.afterRunId, 'old'); assert.equal(h.record.updatedAt, 'unchanged');
  assert.equal(JSON.stringify(h.record.turns), before);
  assert.equal(Context.build(h.record), '');
  h.record.turns.push({ runId: 'new', user: 'new input', assistant: 'new answer' });
  const recovered = Context.build(h.record); assert.match(recovered, /new answer/); assert.doesNotMatch(recovered, /old input|old answer/);
});
test('failed or superseded clear cannot authorize a history boundary', async () => {
  for (const mode of ['failed', 'superseded', 'unchanged-epoch']) {
    const h = harness();
    h.sess.child.clearContext = async () => {
      if (mode === 'superseded') { h.sess.observer.epoch++; h.sessions.delete('fixture'); }
      return { ok: mode !== 'failed' };
    };
    assert.equal((await h.clear()).ok, false); assert.equal(h.writes.length, 0);
    assert.match(Context.build(h.record), /old answer/);
  }
});
test('renderer snapshots cannot remove, move or fabricate the host clear boundary', async () => {
  const h = harness(); await h.clear();
  for (const boundary of [undefined, { turnIndex: 0 }, { turnIndex: 999 }]) {
    const incoming = { id: 'fixture', turns: h.record.turns, sdkContextBoundary: boundary };
    protectSdkMetadata(incoming, h.record);
    assert.deepEqual(incoming.sdkContextBoundary, structuredClone(h.record.sdkContextBoundary));
    assert.equal(Context.build(incoming), '');
  }
  const forged = { sdkContextBoundary: { turnIndex: 4 } }; protectSdkMetadata(forged, null);
  assert.equal(forged.sdkContextBoundary, undefined);
});
