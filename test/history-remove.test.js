'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadCommonJs = require('./helpers/load-commonjs.cjs');
const { createConversationDeletion } = require('../src/main/app/conversation-deletion');

const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
function failure(code) { return Object.assign(new Error(`synthetic ${code}`), { code }); }
function fixture(t, overrides = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-history-remove-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { createHistoryStore } = loadCommonJs('src/main/app/history-store.js', {
    modules: { fs: { ...fs, ...overrides } }, globals: { console },
  });
  const store = createHistoryStore({ getUserDataDir: () => userData, recoverLegacyOutput: value => value });
  const records = [ID, OTHER].map(id => ({ id, title: id, turns: [{ runId: `${id}-run`, user: 'synthetic history' }] }));
  const bytes = new Map(records.map(record => [record.id, `${JSON.stringify(record)}\n`]));
  for (const record of records) fs.writeFileSync(store.convFilePath(record.id), bytes.get(record.id));
  fs.writeFileSync(store.historyIndexPath(), JSON.stringify({ version: 2, items: records.map(store.convMeta) }));
  return { store, records, bytes, userData,
    body: id => fs.readFileSync(store.convFilePath(id), 'utf8'),
    ids: () => JSON.parse(fs.readFileSync(store.historyIndexPath(), 'utf8')).items.map(item => item.id) };
}

test('history removal synchronously commits index before removing only its exact body', t => {
  const calls = [];
  const f = fixture(t, {
    renameSync(from, to) { calls.push(['index', to]); return fs.renameSync(from, to); },
    rmSync(file, options) { calls.push(['body', file]); return fs.rmSync(file, options); },
  });
  const removed = f.store.removeConversationRecord(ID);
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), f.records[0]);
  assert.deepEqual(calls, [['index', f.store.historyIndexPath()], ['body', f.store.convFilePath(ID)]]);
  assert.deepEqual(f.ids(), [OTHER]);
  assert.equal(fs.existsSync(f.store.convFilePath(ID)), false);
  assert.equal(f.body(OTHER), f.bytes.get(OTHER));
});

for (const operation of ['writeFileSync', 'renameSync']) {
  test(`history index ${operation} failure preserves both exact history bodies and index`, t => {
    let removes = 0;
    const f = fixture(t, {
      [operation]() { throw failure('ENOSPC'); },
      rmSync(...args) { removes++; return fs.rmSync(...args); },
    });
    assert.throws(() => f.store.removeConversationRecord(ID), { code: 'ENOSPC' });
    assert.equal(removes, 0);
    assert.equal(f.body(ID), f.bytes.get(ID));
    assert.equal(f.body(OTHER), f.bytes.get(OTHER));
    assert.deepEqual(f.ids(), [ID, OTHER]);
  });
}

test('body removal failure restores the original index and permits a successful retry', t => {
  let deny = true;
  const f = fixture(t, { rmSync(file, options) { if (deny) throw failure('EBUSY'); return fs.rmSync(file, options); } });
  const index = fs.readFileSync(f.store.historyIndexPath(), 'utf8');
  assert.throws(() => f.store.removeConversationRecord(ID), { code: 'EBUSY' });
  assert.equal(f.body(ID), f.bytes.get(ID));
  assert.deepEqual(f.ids(), JSON.parse(index).items.map(item => item.id));
  deny = false;
  f.store.removeConversationRecord(ID);
  assert.deepEqual(f.ids(), [OTHER]);
  assert.equal(fs.existsSync(f.store.convFilePath(ID)), false);
});

test('failed index rollback reports both failures while preserving all history bytes', t => {
  let commits = 0;
  const f = fixture(t, {
    renameSync(from, to) { if (++commits === 2) throw failure('ENOSPC'); return fs.renameSync(from, to); },
    rmSync() { throw failure('EACCES'); },
  });
  assert.throws(() => f.store.removeConversationRecord(ID), error => {
    assert.equal(error.code, 'HISTORY_DELETE_ROLLBACK_FAILED');
    assert.equal(error.cause.code, 'EACCES');
    assert.equal(error.rollbackError.code, 'ENOSPC');
    assert.match(error.message, /正文已保留/);
    return true;
  });
  assert.equal(f.body(ID), f.bytes.get(ID));
  assert.equal(f.body(OTHER), f.bytes.get(OTHER));
  f.store.rebuildHistoryIndex();
  assert.deepEqual(f.ids().sort(), [ID, OTHER].sort(), 'unchanged bodies remain recoverable');
});

test('already missing history bodies still remove stale index entries and retries stay idempotent', t => {
  const f = fixture(t);
  fs.unlinkSync(f.store.convFilePath(ID));
  assert.equal(f.store.removeConversationRecord(ID), null);
  assert.deepEqual(f.ids(), [OTHER]);
  assert.equal(f.store.removeConversationRecord(ID), null);
  assert.deepEqual(f.ids(), [OTHER]);
});

test('history removal validates ids and cannot target the history index itself', t => {
  const f = fixture(t);
  for (const id of [null, '', '../index', 'index', 'INDEX', 'with space']) {
    assert.throws(() => f.store.removeConversationRecord(id), { code: 'INVALID_CONVERSATION_ID' });
  }
  assert.deepEqual(f.ids(), [ID, OTHER]);
  assert.equal(f.body(ID), f.bytes.get(ID));
});

test('UUID aliases are removed from history metadata together', t => {
  const f = fixture(t);
  const id = 'abcdef00-abcd-4000-8000-abcdefabcdef';
  const record = { id, turns: [] };
  fs.writeFileSync(f.store.convFilePath(id), JSON.stringify(record));
  fs.writeFileSync(f.store.historyIndexPath(), JSON.stringify({ version: 2, items: [
    { id }, { id: id.toUpperCase() }, { id: OTHER },
  ] }));
  f.store.removeConversationRecord(id);
  assert.deepEqual(f.ids(), [OTHER]);
});

test('coordinator propagates real index failure with intact history and retries after restart', async t => {
  let deny = true;
  const f = fixture(t, {
    renameSync(from, to) { if (deny && to.endsWith('index.json')) throw failure('ENOSPC'); return fs.renameSync(from, to); },
  });
  const options = { statePath: path.join(f.userData, 'deletions.json'),
    stopConversation: async () => ({ stopConfirmed: true }), removeScratch: async () => {},
    removeHistory: id => f.store.removeConversationRecord(id) };
  const service = createConversationDeletion(options);
  const rejected = await service.delete(ID);
  assert.equal(rejected.code, 'CONVERSATION_HISTORY_DELETE_FAILED');
  assert.equal(rejected.causeCode, 'ENOSPC');
  assert.equal(f.body(ID), f.bytes.get(ID));
  assert.deepEqual(f.ids(), [ID, OTHER]);
  const restarted = createConversationDeletion(options);
  assert.equal(restarted.canWrite(ID), false);
  deny = false;
  assert.equal((await restarted.delete(ID)).ok, true);
  assert.deepEqual(f.ids(), [OTHER]);
  assert.equal(fs.existsSync(f.store.convFilePath(ID)), false);
});


test('history-only removal reads just the index and never hydrates a transcript', t => {
  const reads = [];
  const f = fixture(t, { readFileSync(file, ...args) {
    reads.push(String(file));
    assert.equal(path.basename(String(file)), 'index.json', 'deletion must not read any conversation body');
    return fs.readFileSync(file, ...args);
  } });
  assert.equal(f.store.removeConversationRecord(ID, { loadRecord: false }), null);
  assert.deepEqual(reads, [f.store.historyIndexPath()]);
  assert.equal(fs.existsSync(f.store.convFilePath(ID)), false);
  assert.equal(f.body(OTHER), f.bytes.get(OTHER));
  assert.deepEqual(f.ids(), [OTHER]);
});

test('a damaged index never triggers cross-conversation rebuilding during deletion', t => {
  const reads = [];
  const f = fixture(t, { readFileSync(file, ...args) {
    reads.push(String(file));
    return fs.readFileSync(file, ...args);
  } });
  fs.writeFileSync(f.store.historyIndexPath(), 'broken index');
  assert.throws(() => f.store.removeConversationRecord(ID, { loadRecord: false }), { code: 'HISTORY_INDEX_UNAVAILABLE' });
  assert.deepEqual(reads, [f.store.historyIndexPath()]);
  assert.equal(f.body(ID), f.bytes.get(ID));
  assert.equal(f.body(OTHER), f.bytes.get(OTHER));
  assert.equal(fs.readFileSync(f.store.historyIndexPath(), 'utf8'), 'broken index');
});
