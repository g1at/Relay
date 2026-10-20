'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HistorySearchClient } = require('../src/main/app/history-search-client');
const { registerHistoryIpc } = require('../src/main/app/history-ipc');
class FakeWorker extends EventEmitter {
  constructor() { super(); this.sent = []; this.terminated = false; }
  postMessage(message) { this.sent.push(message); }
  ref() { this.referenced = true; }
  unref() { this.referenced = false; }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  reply(requestId, items = []) { this.emit('message', { requestId, result: { ok: true, items } }); }
}
function fixture(t, extra = {}) {
  const client = new HistorySearchClient({ historyDir: path.resolve('synthetic/history'), WorkerClass: FakeWorker, ...extra });
  t.after(() => client.close()); return client;
}
test('new input cancels its earlier request immediately while another window remains independent', async t => {
  const c = fixture(t), first = c.search('earlier', 50, 'window-a'), worker = c.worker;
  const secondWindow = c.search('independent', 50, 'window-b');
  const latest = c.search('latest', 50, 'window-a');
  assert.equal((await first).canceled, true);
  worker.reply(1, [{ id: 'stale' }]);
  worker.reply(2, [{ id: 'b' }]); worker.reply(3, [{ id: 'a' }]);
  assert.deepEqual((await secondWindow).items, [{ id: 'b' }]);
  assert.deepEqual((await latest).items, [{ id: 'a' }]);
  assert.equal(c.pending.size, 0); assert.equal(worker.referenced, false);
});
test('worker crash settles all requests and the next search creates a new worker', async t => {
  const c = fixture(t), first = c.search('one', 50, 'a'), second = c.search('two', 50, 'b'), old = c.worker;
  old.emit('error', Error('simulated worker crash'));
  for (const result of await Promise.all([first, second])) assert.equal(result.code, 'HISTORY_SEARCH_WORKER_FAILED');
  const next = c.search('retry'); assert.notEqual(c.worker, old);
  old.reply(3, [{ id: 'wrong worker' }]); c.worker.reply(3, [{ id: 'new' }]);
  assert.equal((await next).items[0].id, 'new'); assert.equal(old.terminated, true);
});
test('worker startup failure and malformed response are explicit errors', async t => {
  const failed = fixture(t, { WorkerClass: class { constructor() { throw Error('not found'); } } });
  assert.equal((await failed.search('one')).ok, false);
  const c = fixture(t), pending = c.search('text'); c.worker.emit('message', { requestId: 1, result: {} });
  assert.equal((await pending).code, 'HISTORY_SEARCH_INVALID_RESPONSE');
});
test('timeout clears pending promises, terminates the stuck worker and permits retry', async t => {
  const c = fixture(t, { timeoutMs: 20 }), pending = c.search('blocked'), worker = c.worker;
  assert.equal((await pending).code, 'HISTORY_SEARCH_TIMEOUT'); assert.equal(worker.terminated, true);
  const retry = c.search('retry'); c.worker.reply(2); assert.equal((await retry).ok, true);
});
test('closing cancels requests and never starts another worker', async t => {
  const c = fixture(t), pending = c.search('pending'), worker = c.worker;
  await c.close(); assert.equal((await pending).canceled, true); assert.equal(worker.terminated, true);
  assert.equal(c.pending.size, 0); assert.equal((await c.search('after close')).code, 'HISTORY_SEARCH_CLOSED');
});
test('empty and overlong queries never start the worker', async t => {
  const c = fixture(t); assert.deepEqual(await c.search('   '), { ok: true, items: [] });
  assert.equal((await c.search('x'.repeat(513))).code, 'HISTORY_SEARCH_QUERY_TOO_LONG'); assert.equal(c.worker, null);
});
function ipcFixture(service, assertConversationAvailable) {
  const handlers = new Map();
  const registered = registerHistoryIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    history: { forEachConversation() { throw Error('Synchronous history traversal is forbidden'); },
      loadConversation() { throw Error('Main-thread body reads are forbidden'); } },
    searchService: service, assertConversationAvailable });
  return { registered, call: (name, event, value) => handlers.get('history:' + name)(event, value) };
}
test('production IPC delegates search without hydrating history and filters newly deleting conversations', async () => {
  const calls = [], sender = new EventEmitter(); sender.id = 7;
  const service = { search: async (...args) => { calls.push(args); return { ok: true, items: [{ id: 'keep' }, { id: 'deleted' }] }; },
    cancel: id => { calls.push(['cancel', id]); return true; }, close: async () => calls.push(['close']) };
  const f = ipcFixture(service, id => { if (id === 'deleted') throw Object.assign(Error('deleted'), { code: 'CONVERSATION_DELETED' }); });
  const result = await f.call('search', { sender }, { query: '关键词', limit: 50 });
  assert.deepEqual(result.items, [{ id: 'keep' }]); assert.deepEqual(calls[0], ['关键词', 50, '7']);
  f.call('search:cancel', { sender }); sender.emit('destroyed'); await f.registered.close();
  assert.deepEqual(calls.slice(1), [['cancel', '7'], ['cancel', '7'], ['close']]);
});
test('unavailable deletion state and worker failures cannot masquerade as no matches', async () => {
  const f = ipcFixture({ search: async () => ({ ok: true, items: [{ id: 'one' }] }) },
    () => { throw Object.assign(Error('invalid state'), { code: 'CONVERSATION_DELETION_STATE_UNAVAILABLE' }); });
  assert.equal((await f.call('search', {}, { query: 'text' })).ok, false);
  const g = ipcFixture({ search: async () => { throw Error('worker failed'); } });
  assert.equal((await g.call('search', {}, { query: 'text' })).ok, false);
});
