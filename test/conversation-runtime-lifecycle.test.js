'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationRuntimeLifecycle } = require('../src/main/app/conversation-runtime-lifecycle');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ID = 'abcdef00-abcd-4000-8000-abcdefabcdef';

test('evicted executors remain owned until an actual native close', async () => {
  const closed = deferred(), warmPool = new Map(); let signals = 0;
  const handle = { kill: () => { signals++; warmPool.delete(ID); return closed.promise; }, whenClosed: () => closed.promise };
  warmPool.set(ID, handle);
  const service = createConversationRuntimeLifecycle({ timeoutMs: 5 }); service.track(ID, handle);
  assert.equal((await service.stop(ID)).stopConfirmed, false);
  assert.equal(warmPool.has(ID), false); assert.equal(service.has(ID), true); assert.equal(signals, 1);
  const retry = service.stop(ID); closed.resolve({ stopConfirmed: true });
  assert.equal((await retry).stopConfirmed, true); assert.equal(service.has(ID), false); assert.equal(signals, 2);
});

test('only the requested conversation is stopped and natural closure releases ownership', async () => {
  const first = deferred(), other = deferred(); let otherSignals = 0;
  const service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  service.track(ID, { kill: () => { first.resolve({ stopConfirmed: true }); }, whenClosed: () => first.promise });
  service.track('another-conversation', { kill: () => { otherSignals++; }, whenClosed: () => other.promise });
  assert.equal((await service.stop(ID)).stopConfirmed, true); assert.equal(otherSignals, 0);
  assert.equal(service.has('another-conversation'), true);
  other.resolve({ stopConfirmed: true }); await Promise.resolve();
  assert.equal(service.has('another-conversation'), false);
});

test('UUID aliases and duplicate tracking do not skip or multiply the same executor', async () => {
  let signals = 0; const closed = deferred(), service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  const handle = { whenClosed: () => closed.promise, kill() { signals++; closed.resolve({ stopConfirmed: true }); return closed.promise; } };
  service.track(ID.toUpperCase(), handle); service.track(ID, handle);
  assert.equal(service.has(ID), true);
  assert.equal((await service.stop(ID)).stopConfirmed, true); assert.equal(signals, 1);
  assert.equal(service.has(ID.toUpperCase()), false);
});

test('a signal receipt without native confirmation never releases ownership', async () => {
  let calls = 0; const service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  service.track(ID, { kill: () => { calls++; return { killed: true }; } });
  assert.equal((await service.stop(ID)).stopConfirmed, false);
  assert.equal((await service.stop(ID)).stopConfirmed, false);
  assert.equal(service.has(ID), true); assert.equal(calls, 2);
});

test('failed native observation is refreshed on retry instead of permanently caching failure', async () => {
  let confirmed = false; const service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  service.track(ID, { whenClosed: () => confirmed ? Promise.resolve({ stopConfirmed: true }) : Promise.reject(Error('temporary close read failure')),
    kill: () => ({ stopConfirmed: confirmed }) });
  assert.equal((await service.stop(ID)).stopConfirmed, false); assert.equal(service.has(ID), true);
  confirmed = true;
  assert.equal((await service.stop(ID)).stopConfirmed, true); assert.equal(service.has(ID), false);
});

test('a newly admitted executor cannot be omitted from an in-flight stop result', async () => {
  const original = deferred(), replacement = deferred(), service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  service.track(ID, { kill: () => original.promise, whenClosed: () => original.promise });
  const stop = service.stop(ID);
  service.track(ID, { kill: () => replacement.promise, whenClosed: () => replacement.promise });
  original.resolve({ stopConfirmed: true });
  assert.equal((await stop).stopConfirmed, false); assert.equal(service.has(ID), true);
  replacement.resolve({ stopConfirmed: true });
  assert.equal((await service.stop(ID)).stopConfirmed, true);
});

test('throwing stop callback retains the executor and can be retried', async () => {
  let stops = 0; const service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  service.track(ID, {}, () => { if (++stops === 1) throw Error('signal failed'); return Promise.resolve({ stopConfirmed: true }); });
  assert.equal((await service.stop(ID)).stopConfirmed, false); assert.equal(service.has(ID), true);
  assert.equal((await service.stop(ID)).stopConfirmed, true); assert.equal(service.has(ID), false);
});

test('a pending observation does not hide a later confirmed stop receipt', async () => {
  const stopped = deferred(), service = createConversationRuntimeLifecycle({ timeoutMs: 100 });
  service.track(ID, { whenClosed: () => ({ stopConfirmed: false, code: 'RUNTIME_RESOURCE_CLEANUP_PENDING' }),
    kill: () => stopped.promise });
  const result = service.stop(ID);
  await Promise.resolve();
  assert.equal(service.has(ID), true);
  stopped.resolve({ stopConfirmed: true });
  assert.equal((await result).stopConfirmed, true);
  assert.equal(service.has(ID), false);
});

test('a hanging observer cannot hide a confirmed stop and an unconfirmed stop retains ownership', async () => {
  const closed = deferred(), service = createConversationRuntimeLifecycle({ timeoutMs: 5 });
  let confirmed = false;
  service.track(ID, { whenClosed: () => closed.promise, kill: () => ({ stopConfirmed: confirmed }) });
  assert.equal((await service.stop(ID)).stopConfirmed, false);
  assert.equal(service.has(ID), true);
  confirmed = true;
  assert.equal((await service.stop(ID)).stopConfirmed, true);
  assert.equal(service.has(ID), false);
});
