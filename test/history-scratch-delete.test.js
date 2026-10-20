'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHistoryIpc } = require('../src/main/app/history-ipc');
function handler(deleteConversation) {
  const handlers = new Map();
  registerHistoryIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, history: {}, projects: {}, deleteConversation });
  return id => handlers.get('history:delete')(null, id);
}
test('history deletion IPC remains pending until asynchronous scratch cleanup settles', async () => {
  let release, settled = false, seen;
  const call = handler(id => { seen = id; return new Promise(resolve => { release = resolve; }); });
  const pending = call('synthetic-conversation').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen, 'synthetic-conversation'); assert.equal(settled, false);
  release({ ok: true, cleanupWarning: 'synthetic cleanup warning' });
  assert.deepEqual(await pending, { ok: true, cleanupWarning: 'synthetic cleanup warning' });
});
test('history deletion IPC preserves explicit failure results instead of converting them to success', async () => {
  const failure = { ok: false, code: 'SCRATCH_BUSY', error: 'synthetic files busy' };
  assert.deepEqual(await handler(async () => failure)('synthetic-conversation'), failure);
});
test('history deletion IPC reports asynchronous cleanup rejection as a structured failure', async () => {
  const result = await handler(async () => { await Promise.resolve(); throw Object.assign(new Error('synthetic cleanup denied'), { code: 'EACCES' }); })('synthetic-conversation');
  assert.deepEqual(result, { ok: false, code: 'EACCES', error: 'synthetic cleanup denied' });
});
test('history deletion IPC reports synchronous rejection with a stable fallback code', async () => {
  const result = await handler(() => { throw new Error('synthetic lookup failure'); })('synthetic-conversation');
  assert.deepEqual(result, { ok: false, code: 'CONVERSATION_DELETE_FAILED', error: 'synthetic lookup failure' });
});
