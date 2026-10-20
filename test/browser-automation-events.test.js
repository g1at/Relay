'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserEventTracker } = require('../src/main/browser/browser-automation-events');

function fixture(options = {}) {
  let now = 1000, id = 0;
  const timers = new Map(), wc = new EventEmitter();
  wc.debugger = new EventEmitter(); wc.isDestroyed = () => false;
  const tracker = createBrowserEventTracker({ webContents: wc, now: () => now,
    setTimer: (callback, ms) => { const key = ++id; timers.set(key, { at: now + ms, callback }); return key; },
    clearTimer: key => timers.delete(key), ...options });
  const send = (method, params, sessionId) => tracker.handleMessage(method, params, sessionId);
  const seed = (extra = {}) => tracker.setMainFrame({ frameId: 'main', loaderId: 'L1', url: 'https://example.test/start', readyState: 'complete', ...extra });
  const commit = (extra = {}, sessionId) => send('Page.frameNavigated', { frame: { id: 'main', loaderId: 'L2', url: 'https://example.test/next', ...extra } }, sessionId);
  const lifecycle = (name, extra = {}, sessionId) => send('Page.lifecycleEvent', { frameId: 'main', loaderId: 'L2', name, ...extra }, sessionId);
  const request = (requestId, extra = {}, sessionId) => send('Network.requestWillBeSent', { requestId, frameId: 'main', loaderId: 'L1', type: 'Fetch', request: { method: 'GET', url: 'https://example.test/api' }, ...extra }, sessionId);
  const response = (requestId, extra = {}, sessionId) => send('Network.responseReceived', { requestId, frameId: 'main', loaderId: 'L1', response: { url: 'https://example.test/api', status: 200 }, ...extra }, sessionId);
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  }
  seed();
  return { tracker, wc, timers, send, seed, commit, lifecycle, request, response, advance };
}

test('navigation arms synchronously and old complete state or duplicate commit cannot satisfy it', async () => {
  const f = fixture();
  const pending = f.tracker.prepare({ event: 'navigation', timeoutMs: 10 });
  f.lifecycle('load', { loaderId: 'L1' });
  assert.equal(f.commit({ loaderId: 'L1' }), false);
  f.advance(10);
  assert.deepEqual(await pending.result, { matched: false, satisfied: false, timedOut: true, event: 'navigation', reason: 'timeout' });
  assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('arm before an immediate commit captures the edge, while a later waiter cannot replay it', async () => {
  const f = fixture(), first = f.tracker.prepare({ event: 'navigation' });
  f.commit();
  const result = await first.result;
  assert.equal(result.satisfied, true); assert.equal(result.loaderId, 'L2'); assert.equal(result.sameDocument, false);
  const second = f.tracker.prepare({ event: 'navigation', timeoutMs: 10 }); f.advance(10);
  assert.equal((await second.result).satisfied, false); f.tracker.dispose();
});

test('navigation waits for matching new-loader lifecycle, ignoring old loaders and child sessions', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', waitUntil: 'load' });
  f.commit();
  assert.equal(f.lifecycle('load', {}, 'oopif-session'), false);
  assert.equal(f.lifecycle('load', { frameId: 'child' }), false);
  f.lifecycle('load', { loaderId: 'L1' });
  assert.equal(f.timers.size, 1);
  f.lifecycle('DOMContentLoaded'); assert.equal(f.timers.size, 1);
  f.lifecycle('load'); assert.equal((await wait.result).satisfied, true); f.tracker.dispose();
});

test('lifecycle can arrive before commit and is correlated to its loader', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', waitUntil: 'domcontentloaded' });
  f.lifecycle('DOMContentLoaded'); assert.equal(f.timers.size, 1);
  f.commit(); assert.equal((await wait.result).loaderId, 'L2'); f.tracker.dispose();
});

test('child frame navigation and OOPIF root-looking navigation never match', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', timeoutMs: 10 });
  assert.equal(f.commit({ id: 'child', parentId: 'main' }), false);
  assert.equal(f.commit({ id: 'child' }, 'child-session'), false);
  f.advance(10); assert.equal((await wait.result).matched, false); f.tracker.dispose();
});

test('same-document navigation is a new edge and can use current load state', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', waitUntil: 'load', url: 'https://example.test/start#section' });
  f.send('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.test/start#section' });
  const result = await wait.result; assert.equal(result.sameDocument, true); assert.equal(result.loaderId, 'L1');
  assert.equal(result.url, 'https://example.test/start'); f.tracker.dispose();
});

test('late main-frame seed cannot roll back a newer same-document navigation URL', async () => {
  const f = fixture(); f.send('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.test/new-route' });
  f.seed();
  const wait = f.tracker.prepare({ event: 'load', url: 'https://example.test/new-route' });
  assert.equal((await wait.result).url, 'https://example.test/new-route'); f.tracker.dispose();
});

test('load may satisfy an already loaded current document without inventing a navigation edge', async () => {
  const f = fixture();
  assert.equal((await f.tracker.prepare({ event: 'load' }).result).satisfied, true);
  f.commit();
  const wait = f.tracker.prepare({ event: 'load', waitUntil: 'domcontentloaded' });
  f.lifecycle('DOMContentLoaded'); assert.equal((await wait.result).waitUntil, 'domcontentloaded'); f.tracker.dispose();
});

test('loading started blocks stale old complete state and late seed until new commit completes', async () => {
  const f = fixture(); f.send('Page.frameStartedLoading', { frameId: 'main' });
  const wait = f.tracker.prepare({ event: 'load' });
  f.seed(); f.lifecycle('load', { loaderId: 'L1' }); assert.equal(f.timers.size, 1);
  f.commit(); f.lifecycle('load'); assert.equal((await wait.result).loaderId, 'L2');
  assert.equal(f.seed(), false); f.tracker.dispose();
});

test('new navigation supersedes earlier loader while waiting for load', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', waitUntil: 'load', url: 'https://example.test/final' });
  f.commit(); f.commit({ loaderId: 'L3', url: 'https://example.test/final' });
  f.lifecycle('load'); assert.equal(f.timers.size, 1);
  f.lifecycle('load', { loaderId: 'L3' }); assert.equal((await wait.result).loaderId, 'L3'); f.tracker.dispose();
});

test('responses match url method status and current main frame with no body or headers retained', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'response', url: 'https://example.test/api?token=private', method: 'post', status: 201 });
  f.request('one', { request: { url: 'https://example.test/api?token=private', method: 'POST', headers: { Secret: 'private-header' }, postData: 'private-body' } });
  f.response('one', { response: { url: 'https://example.test/api?token=private', status: 201, headers: { Secret: 'private-response' }, body: 'private-body' } });
  const value = await wait.result;
  assert.equal(value.method, 'POST'); assert.equal(value.status, 201); assert.equal(value.url, 'https://example.test/api');
  assert.doesNotMatch(JSON.stringify(value), /private|token|headers|body/); f.tracker.dispose();
});

test('response can match an in-flight request started before arm but not a response already observed', async () => {
  const f = fixture(); f.request('old'); f.response('old');
  const wait = f.tracker.prepare({ event: 'response' }); assert.equal(f.timers.size, 1);
  f.request('inflight'); const next = f.tracker.prepare({ event: 'response' }); f.response('inflight');
  assert.equal((await wait.result).requestId, 'inflight'); assert.equal((await next.result).requestId, 'inflight'); f.tracker.dispose();
});

test('response needs observed request metadata and rejects child/session/loader mismatches', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'response', timeoutMs: 10 });
  assert.equal(f.response('unknown'), false);
  assert.equal(f.request('child', { frameId: 'child' }), false);
  assert.equal(f.request('oopif', {}, 'oopif-session'), false);
  f.request('real');
  assert.equal(f.response('real', { frameId: 'child' }), false);
  assert.equal(f.response('real', { loaderId: 'wrong' }), false);
  assert.equal(f.response('real', {}, 'oopif-session'), false);
  f.advance(10); assert.equal((await wait.result).satisfied, false); f.tracker.dispose();
});

test('nonmatching response url method or status cannot resolve the waiter', async () => {
  const f = fixture(), input = { event: 'response', url: 'https://example.test/expected', method: 'POST', status: 201, timeoutMs: 10 };
  const wait = f.tracker.prepare(input); input.url = 'https://example.test/changed';
  f.request('get', { request: { url: 'https://example.test/expected', method: 'GET' } });
  f.response('get', { response: { url: 'https://example.test/expected', status: 201 } });
  f.request('wrong-status', { request: { url: 'https://example.test/expected', method: 'POST' } });
  f.response('wrong-status', { response: { url: 'https://example.test/expected', status: 500 } });
  f.request('wrong-url', { request: { url: 'https://example.test/changed', method: 'POST' } });
  f.response('wrong-url', { response: { url: 'https://example.test/changed', status: 201 } });
  assert.equal(f.timers.size, 1);
  f.request('match', { request: { url: 'https://example.test/expected', method: 'POST' } });
  f.response('match', { response: { url: 'https://example.test/expected', status: 201 } });
  assert.equal((await wait.result).requestId, 'match'); f.tracker.dispose();
});

test('response from previous page is ignored after navigation even if request ID is known', async () => {
  const f = fixture(); f.request('old');
  const wait = f.tracker.prepare({ event: 'response', timeoutMs: 10 }); f.commit();
  assert.equal(f.response('old'), false); f.advance(10); assert.equal((await wait.result).satisfied, false); f.tracker.dispose();
});

test('main document response before commit waits for that loader to become current', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'response', status: 200 });
  f.request('document', { loaderId: 'L2', type: 'Document' }); f.response('document', { loaderId: 'L2' });
  f.send('Network.loadingFinished', { requestId: 'document' }); assert.equal(f.timers.size, 1);
  f.commit(); assert.equal((await wait.result).loaderId, 'L2'); f.tracker.dispose();
});

test('redirected request IDs update request method and never expose intermediate stale metadata', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'response', method: 'GET', url: 'https://example.test/final' });
  f.request('same', { request: { url: 'https://example.test/start', method: 'POST' } });
  f.request('same', { request: { url: 'https://example.test/final', method: 'GET' }, redirectResponse: { status: 302, url: 'https://example.test/start' } });
  f.response('same', { response: { url: 'https://example.test/final', status: 200 } });
  assert.equal((await wait.result).method, 'GET'); f.tracker.dispose();
});

test('safe glob has literal regex metacharacters, star path boundaries, and double-star recursion', async () => {
  const f = fixture();
  const one = f.tracker.prepare({ event: 'response', urlGlob: 'https://example.test/api/*?q=(x)', timeoutMs: 10 });
  const all = f.tracker.prepare({ event: 'response', urlGlob: 'https://example.test/api/**?q=(x)' });
  f.request('one'); f.response('one', { response: { url: 'https://example.test/api/a/b?q=(x)', status: 200 } });
  assert.equal((await all.result).satisfied, true); f.advance(10); assert.equal((await one.result).satisfied, false); f.tracker.dispose();
});

test('timeout and deadline are bounded, with zero or expired deadlines never capturing an action', async () => {
  const f = fixture();
  const zero = f.tracker.prepare({ event: 'navigation', timeoutMs: 0 }); f.commit(); f.advance(0);
  assert.equal((await zero.result).satisfied, false);
  const bounded = f.tracker.prepare({ event: 'navigation', timeoutMs: 5000 }, { deadline: 1010 }); f.advance(10);
  assert.equal((await bounded.result).timedOut, true); assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('abort and explicit disposal reject and release each timer and abort listener', async () => {
  const f = fixture(), controller = new AbortController();
  let adds = 0, removes = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { adds++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const wait = f.tracker.prepare({ event: 'navigation' }, { signal: controller.signal }); controller.abort();
  await assert.rejects(wait.result, { code: 'BROWSER_CANCELLED' }); assert.equal(adds, removes); assert.equal(f.timers.size, 0);
  const second = f.tracker.prepare({ event: 'navigation' }); second.dispose(); second.dispose();
  await assert.rejects(second.result, { code: 'BROWSER_CANCELLED' }); f.tracker.dispose();
});

test('destroy and debugger detach reject active waits and release owned lifecycle listeners', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation' }); f.wc.debugger.emit('detach');
  await assert.rejects(wait.result, { code: 'BROWSER_CONNECTION_LOST' }); assert.equal(f.timers.size, 0);
  assert.throws(() => f.tracker.prepare({ event: 'load' }), { code: 'BROWSER_EVENT_NOT_READY' });
  f.seed(); const next = f.tracker.prepare({ event: 'navigation' }); f.wc.emit('destroyed');
  await assert.rejects(next.result, { code: 'BROWSER_TARGET_CLOSED' });
  assert.equal(f.wc.listenerCount('destroyed'), 0); assert.equal(f.wc.debugger.listenerCount('detach'), 0);
  assert.equal(f.timers.size, 0); assert.equal(f.commit(), false);
});

test('ownership check rejection cannot produce a satisfied result', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation' }, { check: async () => { throw Object.assign(Error('Taken over'), { code: 'CONTROL_REVOKED' }); } });
  f.commit(); await assert.rejects(wait.result, { code: 'CONTROL_REVOKED' }); assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('cancellation wins over an asynchronous matched-event ownership check', async () => {
  const f = fixture(), controller = new AbortController(); let release;
  const check = new Promise(resolve => { release = resolve; });
  const wait = f.tracker.prepare({ event: 'navigation' }, { signal: controller.signal, check: () => check });
  f.commit(); controller.abort(); release();
  await assert.rejects(wait.result, { code: 'BROWSER_CANCELLED' }); assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('an indefinitely pending ownership check cannot defeat event timeout', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', timeoutMs: 10 }, { check: () => new Promise(() => {}) });
  f.commit(); f.advance(10); await assert.rejects(wait.result, { code: 'BROWSER_EVENT_CHECK_TIMEOUT' });
  assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('bounded request cache and waiter capacity do not turn missing correlations into success', async () => {
  const f = fixture({ maxRequests: 1, maxWaiters: 1 }), wait = f.tracker.prepare({ event: 'response', timeoutMs: 10 });
  assert.throws(() => f.tracker.prepare({ event: 'navigation' }), { code: 'BROWSER_EVENT_WAIT_LIMIT' });
  f.request('evicted'); f.request('current'); assert.equal(f.response('evicted'), false);
  f.advance(10); assert.equal((await wait.result).satisfied, false); f.tracker.dispose();
});

test('invalid and unsupported conditions fail before registering listeners or timers', () => {
  const f = fixture();
  for (const input of [null, {}, { event: 'download' }, { event: 'load', method: 'GET' }, { event: 'response', waitUntil: 'load' },
    { event: 'load', timeoutMs: 30001 }, { event: 'load', timeoutMs: -1 }, { event: 'response', status: 99 },
    { event: 'response', method: 'GET\nPOST' }, { event: 'response', url: 'x', urlGlob: '*' }, { event: 'navigation', urlGlob: '*x'.repeat(33) },
    { event: 'navigation', waitUntil: 'toString' }]) {
    assert.throws(() => f.tracker.prepare(input), { code: 'BROWSER_INVALID_EVENT_WAIT' });
  }
  assert.throws(() => f.tracker.prepare({ event: 'response', frameId: 'child' }), { code: 'BROWSER_EVENT_FRAME_UNSUPPORTED' });
  assert.equal(f.timers.size, 0); f.tracker.dispose();
});

test('unscoped Page load events and malformed or irrelevant messages cannot satisfy waits', async () => {
  const f = fixture(), wait = f.tracker.prepare({ event: 'navigation', waitUntil: 'load', timeoutMs: 10 }); f.commit();
  assert.equal(f.send('Page.loadEventFired', { timestamp: 123 }), false);
  assert.equal(f.send('Page.domContentEventFired', { timestamp: 123 }), false);
  for (const value of [null, [], false]) assert.equal(f.send('Page.lifecycleEvent', value), false);
  f.advance(10); assert.equal((await wait.result).satisfied, false); f.tracker.dispose();
});
