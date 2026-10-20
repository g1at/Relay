'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistorySearchDispatcher } = require('../src/main/app/history-search-worker');
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

test('newest request coalesces per client while other clients retain their queue position', async () => {
  const replies = [], started = []; let release;
  const core = { search: async ({ query, isCanceled }) => {
    started.push(query); if (query === 'active-a') await new Promise(resolve => { release = resolve; });
    return isCanceled() ? { ok: true, items: [], canceled: true } : { ok: true, items: [{ id: query }] };
  } };
  const dispatcher = createHistorySearchDispatcher({ core, send: reply => replies.push(reply) });
  dispatcher.handle({ type: 'search', requestId: 1, clientId: 'a', query: 'active-a' });
  dispatcher.handle({ type: 'search', requestId: 2, clientId: 'b', query: 'waiting-b' });
  dispatcher.handle({ type: 'search', requestId: 3, clientId: 'a', query: 'obsolete-a' });
  dispatcher.handle({ type: 'search', requestId: 4, clientId: 'a', query: 'latest-a' });
  assert.deepEqual(replies.map(reply => [reply.requestId, reply.result.canceled]), [[1, true], [3, true]]);
  release(); await yieldTurn();
  assert.deepEqual(started, ['active-a', 'waiting-b', 'latest-a']); assert.equal(replies.length, 4);
  assert.deepEqual(replies.slice(2).map(reply => reply.requestId), [2, 4]);
});

test('canceling one client resolves only its current and queued jobs and never replies twice', async () => {
  const replies = []; let release;
  const core = { search: async ({ query, isCanceled }) => {
    if (query === 'slow') await new Promise(resolve => { release = resolve; });
    return { ok: true, items: isCanceled() ? [] : [{ id: query }] };
  } };
  const dispatcher = createHistorySearchDispatcher({ core, send: reply => replies.push(reply) });
  dispatcher.handle({ type: 'search', requestId: 1, clientId: 'a', query: 'slow' });
  dispatcher.handle({ type: 'search', requestId: 2, clientId: 'b', query: 'canceled-before-start' });
  dispatcher.handle({ type: 'cancel', clientId: 'b' });
  dispatcher.handle({ type: 'search', requestId: 3, clientId: 'b', query: 'fresh-b' });
  dispatcher.handle({ type: 'cancel', clientId: 'a' });
  release(); await yieldTurn();
  assert.equal(replies.length, 3); assert.equal(new Set(replies.map(reply => reply.requestId)).size, 3);
  assert.equal(replies.find(reply => reply.requestId === 1).result.canceled, true);
  assert.equal(replies.find(reply => reply.requestId === 2).result.canceled, true);
  assert.deepEqual(replies.find(reply => reply.requestId === 3).result.items, [{ id: 'fresh-b' }]);
});
