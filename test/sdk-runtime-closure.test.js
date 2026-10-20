'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeClosure } = require('../src/main/sdk/sdk-runtime-closure');
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(close, timeoutMs = 10) {
  let calls = 0, finishes = 0;
  const mapper = { close() { calls++; return close(); } };
  const closure = createRuntimeClosure({ getMapper: () => mapper, timeoutMs,
    onClosed: native => { finishes++; return { exitCode: native.exitCode }; } });
  return { closure, calls: () => calls, finishes: () => finishes };
}
test('pending MCP cleanup returns a bounded refusal then confirms the same owned cleanup on retry', async () => {
  const gate = deferred(), h = fixture(() => gate.promise);
  const first = h.closure.whenClosed();
  h.closure.finish({ stopConfirmed: true, exitCode: 0 });
  assert.equal(h.closure.whenClosed(), first);
  const pending = await first;
  assert.equal(pending.stopConfirmed, false); assert.equal(pending.code, 'RUNTIME_RESOURCE_CLEANUP_PENDING');
  assert.equal(h.finishes(), 1); assert.equal(h.calls(), 1);
  assert.equal((await h.closure.whenClosed()).stopConfirmed, false); assert.equal(h.calls(), 1);
  gate.resolve(); await tick();
  assert.equal((await h.closure.whenClosed()).stopConfirmed, true);
  assert.equal(h.calls(), 1); assert.equal(h.finishes(), 1);
  assert.equal((await h.closure.whenClosed()).stopConfirmed, true);
});
test('failed MCP close is retried without replaying task completion', async () => {
  let attempts = 0;
  const h = fixture(() => { if (++attempts === 1) throw Error('private process details'); });
  const refused = await h.closure.finish({ stopConfirmed: true, exitCode: 0 });
  assert.deepEqual(refused, { stopConfirmed: false, exitCode: 0, code: 'RUNTIME_RESOURCE_CLEANUP_FAILED' });
  assert.equal((await h.closure.whenClosed()).stopConfirmed, true);
  assert.equal(h.calls(), 2); assert.equal(h.finishes(), 1);
});
test('an explicit unconfirmed close receipt remains a refusal and can later be confirmed', async () => {
  let attempts = 0;
  const h = fixture(() => ({ stopConfirmed: ++attempts > 1 }));
  assert.equal((await h.closure.finish({ stopConfirmed: true })).stopConfirmed, false);
  assert.equal((await h.closure.whenClosed()).stopConfirmed, true);
});
test('observing an idle live session never closes its MCP resources or another conversation', async () => {
  const a = fixture(() => {}), b = fixture(() => {});
  let done = false;
  a.closure.whenClosed().then(() => { done = true; }); await tick();
  assert.equal(done, false); assert.equal(a.calls(), 0);
  assert.equal((await b.closure.finish({ stopConfirmed: true })).stopConfirmed, true);
  assert.equal(a.calls(), 0); assert.equal(a.finishes(), 0);
  await a.closure.finish({ stopConfirmed: true });
});
test('closed resources never turn an unconfirmed native exit into success', async () => {
  const h = fixture(() => {});
  assert.equal((await h.closure.finish({ stopConfirmed: false, code: 'TREE_PENDING' })).stopConfirmed, false);
  assert.equal((await h.closure.finish({ stopConfirmed: true })).stopConfirmed, true);
  assert.equal(h.calls(), 1); assert.equal(h.finishes(), 1);
});
