'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDeliveryProgressStore, MAX_BYTES, MAX_RUNS, MAX_ITEMS, MAX_RUN_TOMBSTONES } = require('../src/main/app/turn-delivery-progress');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = (id = 'file-a') => ({ id, path: '/project/outputs/' + id + '.md', name: id + '.md', size: 1, mtimeMs: 1, source: 'write-tool', toolUseId: 'tool-' + id });
const snapshot = (runId = 'run-a', extra = {}) => ({ version: 1, conversationId: 'conversation-a', runId, turnTs: '2026-10-15T00:00:00Z', status: 'running', items: [item()], complete: true, warnings: [], ...extra });
async function fixture(t, extra = {}) {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-progress-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const rootDir = path.join(temp, 'progress');
  return { temp, rootDir, store: createDeliveryProgressStore({ rootDir, ...extra }), file: id => path.join(rootDir, (id || 'conversation-a') + '.json') };
}

test('read is local to one conversation and does not create missing directories', async t => {
  let listed = 0; const f = await fixture(t, { fileSystem: { ...fs.promises, readdir: async () => { listed++; throw Error('must not scan'); } } });
  assert.deepEqual(await f.store.read('conversation-a'), []); assert.equal(fs.existsSync(f.rootDir), false); assert.equal(listed, 0);
});
test('confirmed running and finishing snapshots survive store recreation', async t => {
  const f = await fixture(t); await f.store.save(snapshot()); await f.store.save(snapshot('run-b', { status: 'finishing' }));
  const restored = await createDeliveryProgressStore({ rootDir: f.rootDir }).read('conversation-a');
  assert.deepEqual(restored.map(s => s.status), ['running', 'finishing']);
  assert.equal(fs.existsSync(restored[0].items[0].path), false, 'store never opens or creates delivery files');
  assert.deepEqual((await fs.promises.readdir(f.rootDir)), ['conversation-a.json']);
});
test('parallel runs in one conversation merge without overwriting each other', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: MAX_RUNS }, (_, i) => f.store.save(snapshot('run-' + i))));
  assert.equal((await f.store.read('conversation-a')).length, MAX_RUNS);
});
test('same-run bursts coalesce to the latest snapshot and snapshot mutation is isolated', async t => {
  let renames = 0; const f = await fixture(t, { fileSystem: { ...fs.promises, rename: async (...args) => { renames++; return fs.promises.rename(...args); } } });
  const last = snapshot('run-a', { items: [item('last')] });
  const writes = [f.store.save(snapshot()), f.store.save(snapshot('run-a', { items: [item('middle')] })), f.store.save(last)];
  last.items[0].name = 'changed.md'; await Promise.all(writes);
  assert.equal(renames, 1); const data = await f.store.read('conversation-a'); assert.equal(data[0].items[0].name, 'last.md');
  data[0].items[0].name = 'changed again'; assert.equal((await f.store.read('conversation-a'))[0].items[0].name, 'last.md');
});
test('read waits for prior queued saves and remains conversation specific', async t => {
  const f = await fixture(t); const write = f.store.save(snapshot()); const read = f.store.read('conversation-a');
  await write; assert.equal((await read).length, 1); assert.deepEqual(await f.store.read('conversation-b'), []);
});
test('independent conversations can progress while one rename is held', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { fileSystem: { ...fs.promises, rename: async (from, to) => {
    if (to.endsWith('conversation-a.json')) { entered.resolve(); await release.promise; } return fs.promises.rename(from, to);
  } } });
  const a = f.store.save(snapshot()); await entered.promise;
  await f.store.save(snapshot('run-b', { conversationId: 'conversation-b' }));
  assert.equal((await f.store.read('conversation-b')).length, 1); release.resolve(); await a;
});
test('atomic rename failure leaves the previous JSON intact and cleans temporary data', async t => {
  let fail = false; const f = await fixture(t, { fileSystem: { ...fs.promises, rename: async (...args) => {
    if (fail) throw Object.assign(Error('fixture rename failure'), { code: 'EIO' }); return fs.promises.rename(...args);
  } } });
  await f.store.save(snapshot()); const before = await fs.promises.readFile(f.file(), 'utf8'); fail = true;
  await assert.rejects(f.store.save(snapshot('run-b')), { code: 'EIO' });
  assert.equal(await fs.promises.readFile(f.file(), 'utf8'), before);
  assert.deepEqual(await fs.promises.readdir(f.rootDir), ['conversation-a.json']);
});
test('readers see a valid prior file while a replacement waits for rename', async t => {
  const entered = deferred(), release = deferred(); let hold = false;
  const f = await fixture(t, { fileSystem: { ...fs.promises, rename: async (...args) => { if (hold) { entered.resolve(); await release.promise; } return fs.promises.rename(...args); } } });
  await f.store.save(snapshot()); hold = true; const update = f.store.save(snapshot('run-a', { items: [item('new')] }));
  await entered.promise; assert.equal(JSON.parse(await fs.promises.readFile(f.file(), 'utf8')).items['run-a'].items[0].name, 'file-a.md');
  release.resolve(); await update; assert.equal((await f.store.read('conversation-a'))[0].items[0].name, 'new.md');
});
test('conversation deletion waits for an in-flight commit and rejects late save', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { fileSystem: { ...fs.promises, rename: async (...args) => { entered.resolve(); await release.promise; return fs.promises.rename(...args); } } });
  const writing = f.store.save(snapshot()); await entered.promise;
  const deletion = f.store.removeConversation('conversation-a');
  await assert.rejects(f.store.save(snapshot('run-b')), { code: 'DELIVERY_CONVERSATION_DELETED' });
  release.resolve(); await writing; await deletion; assert.equal(fs.existsSync(f.file()), false); assert.deepEqual(await f.store.read('conversation-a'), []);
});
test('deletion while canWrite is pending cancels commit without recreating the sidecar', async t => {
  const entered = deferred(), release = deferred(); const f = await fixture(t, { canWrite: async () => { entered.resolve(); await release.promise; return true; } });
  const writing = f.store.save(snapshot()); const rejected = assert.rejects(writing, { code: 'DELIVERY_CONVERSATION_DELETED' }); await entered.promise;
  const deletion = f.store.removeConversation('conversation-a'); release.resolve(); await rejected; await deletion; assert.equal(fs.existsSync(f.file()), false);
});
test('deleting one conversation leaves other sidecars and delivery files untouched', async t => {
  const f = await fixture(t); await f.store.save(snapshot()); await f.store.save(snapshot('run-b', { conversationId: 'conversation-b' }));
  const delivery = path.join(f.temp, 'report.md'); await fs.promises.writeFile(delivery, 'keep');
  await Promise.all([f.store.removeConversation('conversation-a'), f.store.removeConversation('conversation-a')]);
  assert.equal((await f.store.read('conversation-b')).length, 1); assert.equal(await fs.promises.readFile(delivery, 'utf8'), 'keep');
});
test('completed run removal preserves peers and blocks late progress for that run', async t => {
  const f = await fixture(t); await Promise.all([f.store.save(snapshot()), f.store.save(snapshot('run-b'))]);
  await f.store.removeRun('conversation-a', 'run-a'); assert.deepEqual((await f.store.read('conversation-a')).map(s => s.runId), ['run-b']);
  await assert.rejects(f.store.save(snapshot()), { code: 'DELIVERY_RUN_REMOVED' });
  await f.store.removeRun('conversation-a', 'run-b'); assert.equal(fs.existsSync(f.file()), false);
});
test('removing a queued run does not drop another run in the coalesced batch', async t => {
  const f = await fixture(t); const a = f.store.save(snapshot()); const rejected = assert.rejects(a, { code: 'DELIVERY_RUN_REMOVED' });
  const b = f.store.save(snapshot('run-b')); const removal = f.store.removeRun('conversation-a', 'run-a');
  await Promise.all([rejected, b, removal]); assert.deepEqual((await f.store.read('conversation-a')).map(s => s.runId), ['run-b']);
});
test('canWrite denial never overwrites existing progress but still allows cleanup', async t => {
  let allowed = true; const f = await fixture(t, { canWrite: id => id === 'conversation-a' && allowed });
  await f.store.save(snapshot()); const before = await fs.promises.readFile(f.file(), 'utf8'); allowed = false;
  await assert.rejects(f.store.save(snapshot('run-b')), { code: 'DELIVERY_PROGRESS_NOT_WRITABLE' });
  assert.equal(await fs.promises.readFile(f.file(), 'utf8'), before); await f.store.removeRun('conversation-a', 'run-a'); assert.equal(fs.existsSync(f.file()), false);
});
test('the pre-rename canWrite check prevents committing an obsolete conversation', async t => {
  let checks = 0; const f = await fixture(t, { canWrite: () => ++checks === 1 });
  await assert.rejects(f.store.save(snapshot()), { code: 'DELIVERY_PROGRESS_NOT_WRITABLE' });
  assert.equal(fs.existsSync(f.file()), false); assert.deepEqual(await fs.promises.readdir(f.rootDir), []);
});
test('strict ids reject traversal separators reserved names and case aliases', async t => {
  const f = await fixture(t);
  for (const id of ['../other', '/tmp/file', 'a/b', 'a\\b', '..', 'x.json', 'con', 'nul', 'LPT1', 'Conversation-a', '', 'x'.repeat(129)]) {
    await assert.rejects(f.store.read(id), { code: 'INVALID_DELIVERY_ID' });
    await assert.rejects(f.store.save(snapshot('run-a', { conversationId: id })), { code: 'INVALID_DELIVERY_ID' });
    await assert.rejects(f.store.removeConversation(id), { code: 'INVALID_DELIVERY_ID' });
  }
  assert.equal(fs.existsSync(f.rootDir), false);
});
test('eight persisted unfinished runs are kept and a ninth is rejected without eviction', async t => {
  const f = await fixture(t); for (let i = 0; i < MAX_RUNS; i++) await f.store.save(snapshot('run-' + i));
  await assert.rejects(f.store.save(snapshot('run-extra')), { code: 'DELIVERY_PROGRESS_RUN_LIMIT' });
  assert.equal((await f.store.read('conversation-a')).length, MAX_RUNS);
});
test('queued run capacity and per-snapshot item capacity reject oversized inputs', async t => {
  const f = await fixture(t); const writes = Array.from({ length: MAX_RUNS }, (_, i) => f.store.save(snapshot('run-' + i)));
  const rejected = assert.rejects(f.store.save(snapshot('run-extra')), { code: 'DELIVERY_PROGRESS_RUN_LIMIT' }); await Promise.all([...writes, rejected]);
  await assert.rejects(f.store.save(snapshot('another', { items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item('f-' + i)) })), { code: 'INVALID_DELIVERY_SNAPSHOT' });
});
test('merged JSON exceeding one MiB is rejected without altering the existing sidecar', async t => {
  const f = await fixture(t); const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({ ...item('f-' + i), path: '/' + 'a'.repeat(4000), name: 'n'.repeat(500) }));
  await f.store.save(snapshot('run-a', { items })); const before = await fs.promises.readFile(f.file());
  assert.ok(before.length < MAX_BYTES); await assert.rejects(f.store.save(snapshot('run-b', { items })), { code: 'DELIVERY_PROGRESS_TOO_LARGE' });
  assert.deepEqual(await fs.promises.readFile(f.file()), before);
});
test('oversized or malformed stored JSON is rejected without scanning or overwriting it', async t => {
  const f = await fixture(t); await fs.promises.mkdir(f.rootDir);
  await fs.promises.writeFile(f.file(), Buffer.alloc(MAX_BYTES + 1)); await assert.rejects(f.store.read('conversation-a'), { code: 'DELIVERY_PROGRESS_TOO_LARGE' });
  await fs.promises.writeFile(f.file(), '{broken'); await assert.rejects(f.store.save(snapshot()), { code: 'INVALID_DELIVERY_PROGRESS_JSON' });
  assert.equal(await fs.promises.readFile(f.file(), 'utf8'), '{broken');
});
test('stored snapshot identities cannot cross conversations or run keys', async t => {
  const f = await fixture(t); await fs.promises.mkdir(f.rootDir);
  for (const value of [{ version: 1, items: { 'run-a': snapshot('run-a', { conversationId: 'conversation-b' }) } },
    { version: 1, items: { 'run-b': snapshot() } }, { version: 1, items: Array(2) }]) {
    await fs.promises.writeFile(f.file(), JSON.stringify(value)); await assert.rejects(f.store.read('conversation-a'));
  }
});
test('directory sidecars are rejected and cleanup is never recursive', async t => {
  const f = await fixture(t); await fs.promises.mkdir(f.file(), { recursive: true });
  const keep = path.join(f.file(), 'keep.txt'); await fs.promises.writeFile(keep, 'keep');
  await assert.rejects(f.store.read('conversation-a'), { code: 'INVALID_DELIVERY_FILE' }); await assert.rejects(f.store.removeConversation('conversation-a'));
  assert.equal(await fs.promises.readFile(keep, 'utf8'), 'keep');
});
test('bounded run tombstones permit fresh work after old completion ids age out', async t => {
  const f = await fixture(t); for (let i = 0; i <= MAX_RUN_TOMBSTONES; i++) await f.store.removeRun('conversation-a', 'run-' + i);
  await f.store.save(snapshot('run-0')); await assert.rejects(f.store.save(snapshot('run-' + MAX_RUN_TOMBSTONES)), { code: 'DELIVERY_RUN_REMOVED' });
  assert.equal((await f.store.read('conversation-a')).length, 1);
});
