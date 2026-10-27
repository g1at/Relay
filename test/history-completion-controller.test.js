'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../renderer/history-completion');

const item = (conversationId = 'chat-a', runId = 'run-a', status = 'succeeded') => ({
  conversationId, runId, status, completedAt: '2026-10-23T04:00:00.000Z',
});
const snapshot = (revision, ...items) => ({ revision, items });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
function fixture({ visible = null, foreground = false } = {}) {
  const startup = deferred(), reads = [], changes = [];
  const view = { visible, foreground };
  let listener = null, subscriptionCount = 0, unsubscribeCount = 0, snapshotCalls = 0;
  const controller = create({
    api: {
      onCompletionChanged(callback) { subscriptionCount++; listener = callback; return () => { unsubscribeCount++; listener = null; }; },
      completionSnapshot() { snapshotCalls++; return startup.promise; },
      markCompletionRead(id, runId) { const request = { id, runId, ...deferred() }; reads.push(request); return request.promise; },
    },
    getVisibleConversationId: () => view.visible,
    isForeground: () => view.foreground,
    onChange: ids => changes.push([...ids]),
  });
  return { controller, startup, view, reads, changes,
    publish: value => { assert.equal(typeof listener, 'function'); listener(value); },
    counts: () => ({ subscriptionCount, unsubscribeCount, snapshotCalls }),
    async start(value = snapshot(0)) { const started = controller.start(); startup.resolve(value); await started; await drain(); },
  };
}

test('a newer completion push wins over a delayed startup snapshot', async () => {
  const f = fixture();
  const started = f.controller.start();
  f.publish(snapshot(4, item()));
  f.startup.resolve(snapshot(1));
  await started; await drain();
  assert.equal(f.controller.get('chat-a').runId, 'run-a');
  assert.deepEqual(f.changes, [['chat-a']]);
  assert.equal(f.reads.length, 0);
});

test('a delayed acknowledgement cannot clear a newer completion or restore an older one', async () => {
  const f = fixture({ visible: 'chat-a', foreground: true });
  await f.start(snapshot(1, item()));
  assert.equal(f.reads.length, 1);
  f.publish(snapshot(3, item('chat-a', 'run-newer')));
  await drain();
  assert.deepEqual(f.reads.map(read => read.runId), ['run-a', 'run-newer']);
  f.reads[0].resolve({ ok: true, changed: true, ...snapshot(2) });
  await drain();
  assert.equal(f.controller.get('chat-a').runId, 'run-newer');
  f.reads[1].resolve({ ok: true, changed: true, ...snapshot(4) });
  await drain();
  assert.equal(f.controller.get('chat-a'), null);
  f.publish(snapshot(3, item('chat-a', 'run-newer')));
  assert.equal(f.controller.get('chat-a'), null);
});

test('a failed read retains the dot and a later foreground check can retry', async () => {
  const f = fixture({ visible: 'chat-a', foreground: true });
  await f.start(snapshot(1, item()));
  f.reads[0].resolve({ ok: false, changed: false, code: 'COMPLETION_STATE_WRITE_FAILED', ...snapshot(1, item()) });
  await drain();
  assert.equal(f.controller.get('chat-a').runId, 'run-a');
  assert.equal(f.reads.length, 1, 'failure does not cause an unbounded retry loop');
  f.controller.syncVisible(); await drain();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve({ ok: true, changed: true, ...snapshot(2) });
  await drain();
  assert.equal(f.controller.get('chat-a'), null);
});

test('a rejected read keeps unread state and releases the duplicate request guard', async () => {
  const f = fixture({ visible: 'chat-a', foreground: true });
  await f.start(snapshot(1, item()));
  f.reads[0].reject(new Error('renderer IPC temporarily unavailable'));
  await drain();
  assert.equal(f.controller.get('chat-a').runId, 'run-a');
  f.controller.syncVisible(); await drain();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve({ ok: true, ...snapshot(2) }); await drain();
});

test('duplicate notifications and repeated focus checks share one pending acknowledgement', async () => {
  const f = fixture({ visible: 'chat-a', foreground: true });
  await f.start(snapshot(1, item()));
  f.publish(snapshot(1, item()));
  f.publish(snapshot(2, item(), item('chat-b', 'run-b')));
  for (let count = 0; count < 8; count++) f.controller.syncVisible();
  await drain();
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.changes, [['chat-a'], ['chat-b']]);
  f.reads[0].resolve({ ok: true, changed: true, ...snapshot(3, item('chat-b', 'run-b')) });
  await drain();
  assert.equal(f.controller.get('chat-a'), null);
  assert.equal(f.controller.get('chat-b').runId, 'run-b');
});

test('foreground visibility clears only the displayed conversation, never other histories', async () => {
  const f = fixture({ visible: 'chat-a', foreground: false });
  await f.start(snapshot(1, item(), item('chat-b', 'run-b', 'failed')));
  f.controller.syncVisible(); await drain();
  assert.equal(f.reads.length, 0);
  f.view.foreground = true;
  f.view.visible = null;
  f.controller.syncVisible(); await drain();
  assert.equal(f.reads.length, 0, 'a loading or covered view is not read');
  f.view.visible = 'chat-b';
  f.controller.syncVisible(); await drain();
  assert.deepEqual(f.reads.map(read => [read.id, read.runId]), [['chat-b', 'run-b']]);
  f.reads[0].resolve({ ok: true, changed: true, ...snapshot(2, item()) });
  await drain();
  assert.equal(f.controller.get('chat-a').runId, 'run-a');
  assert.equal(f.controller.get('chat-b'), null);
});

test('an existing completion can still be delivered after startup snapshot failure', async () => {
  const f = fixture();
  const started = f.controller.start();
  f.startup.reject(new Error('snapshot unavailable'));
  await started;
  f.publish(snapshot(1, item()));
  assert.equal(f.controller.get('chat-a').runId, 'run-a');
  await f.controller.start();
  assert.deepEqual(f.counts(), { subscriptionCount: 1, unsubscribeCount: 0, snapshotCalls: 1 });
  f.controller.dispose();
  assert.equal(f.counts().unsubscribeCount, 1);
});

test('invalid snapshots cannot erase the last accepted unread state', async () => {
  const f = fixture();
  await f.start(snapshot(3, item()));
  for (const value of [undefined, null, {}, snapshot(-1), snapshot(2), { revision: 4, items: null }, { revision: NaN, items: [] }]) {
    assert.equal(f.controller.applySnapshot(value), false);
    assert.equal(f.controller.get('chat-a').runId, 'run-a');
  }
});
