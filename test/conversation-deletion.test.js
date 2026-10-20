'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationDeletion } = require('../src/main/app/conversation-deletion');
const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-conversation-deletion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new Set([ID, OTHER]), scratch = new Set([ID, OTHER]), calls = [];
  const options = {
    statePath: path.join(root, 'deletions.json'),
    stopConversation: async id => { calls.push(['stop', id]); return { stopConfirmed: true }; },
    removeScratch: async id => { calls.push(['scratch', id]); scratch.delete(id); },
    removeHistory: async id => { calls.push(['history', id]); history.delete(id); },
    afterDelete: async id => { calls.push(['after', id]); },
    ...overrides,
  };
  return { root, options, calls, history, scratch, service: createConversationDeletion(options),
    state: () => JSON.parse(fs.readFileSync(options.statePath, 'utf8')) };
}

test('deletion persists the barrier before shutdown and removes only the selected scratch before history', async t => {
  const stopped = deferred(), f = fixture(t, { stopConversation: () => stopped.promise });
  const deletion = f.service.delete(ID);
  assert.equal(f.service.canWrite(ID), false);
  assert.throws(() => f.service.assertAvailable(ID), { code: 'CONVERSATION_DELETING' });
  assert.equal(f.state().items[ID].status, 'deleting');
  assert.equal(createConversationDeletion(f.options).canWrite(ID), false);
  assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
  assert.equal(f.service.canWrite(OTHER), true);
  stopped.resolve({ stopConfirmed: true });
  assert.deepEqual(await deletion, { ok: true, id: ID, deleted: true });
  assert.deepEqual(f.calls, [['scratch', ID], ['history', ID], ['after', ID]]);
  assert.equal(f.history.has(ID), false); assert.equal(f.scratch.has(ID), false);
  assert.equal(f.history.has(OTHER), true); assert.equal(f.scratch.has(OTHER), true);
  assert.equal(f.state().items[ID].status, 'deleted');
});

test('simultaneous requests for the same conversation share one operation', async t => {
  const stopped = deferred(); let stops = 0;
  const f = fixture(t, { stopConversation: () => { stops++; return stopped.promise; } });
  const first = f.service.delete(ID), second = f.service.delete(ID);
  assert.strictEqual(first, second);
  await Promise.resolve(); assert.equal(stops, 1);
  stopped.resolve({ stopConfirmed: true });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter(([name]) => name === 'scratch').length, 1);
  const repeated = await f.service.delete(ID);
  assert.equal(repeated.alreadyDeleted, true); assert.equal(stops, 1);
});

test('independent conversation deletions preserve both durable tombstones', async t => {
  const stopped = deferred();
  const f = fixture(t, { stopConversation: async id => id === ID ? stopped.promise : { stopConfirmed: true } });
  const first = f.service.delete(ID);
  await f.service.delete(OTHER);
  assert.equal(f.state().items[ID].status, 'deleting');
  assert.equal(f.state().items[OTHER].status, 'deleted');
  stopped.resolve({ stopConfirmed: true }); await first;
  assert.equal(f.state().items[ID].status, 'deleted');
  assert.equal(f.state().items[OTHER].status, 'deleted');
});

test('UUID case aliases share one deletion and cannot revive the same Windows folder', async t => {
  const id = 'abcdef00-abcd-4000-8000-abcdefabcdef', stopped = deferred();
  const f = fixture(t, { stopConversation: () => stopped.promise });
  const first = f.service.delete(id), alias = f.service.delete(id.toUpperCase());
  assert.strictEqual(first, alias);
  assert.equal(f.service.canWrite(id.toUpperCase()), false);
  stopped.resolve({ stopConfirmed: true }); await first;
  assert.throws(() => f.service.assertAvailable(id.toUpperCase()), { code: 'CONVERSATION_DELETED' });
  const restarted = createConversationDeletion(f.options);
  assert.equal(restarted.canWrite(id.toUpperCase()), false);
  assert.equal((await restarted.delete(id.toUpperCase())).alreadyDeleted, true);
  assert.deepEqual(Object.keys(f.state().items), [id]);
});

test('an unconfirmed close retains files and retries the original stop callback every time', async t => {
  let stops = 0;
  const f = fixture(t, { stopConversation: async () => ({ stopConfirmed: ++stops === 3 }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.service.delete(ID);
    assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_STOP_UNCONFIRMED');
    assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
    assert.equal(f.service.canWrite(ID), false);
  }
  assert.equal((await f.service.delete(ID)).ok, true); assert.equal(stops, 3);
});

test('missing stop confirmation and thrown shutdown errors never authorize scratch deletion', async t => {
  for (const outcome of [undefined, {}, { stopped: true }]) {
    const f = fixture(t, { stopConversation: async () => outcome });
    assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_STOP_UNCONFIRMED');
    assert.deepEqual(f.calls, []); assert.equal(f.history.has(ID), true);
  }
  const f = fixture(t, { stopConversation: async () => { throw Object.assign(Error('native close failed'), { code: 'EPERM' }); } });
  const result = await f.service.delete(ID);
  assert.equal(result.code, 'CONVERSATION_STOP_FAILED'); assert.equal(result.causeCode, 'EPERM');
  assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
});

test('scratch cleanup failure preserves history and a later retry reconfirms shutdown', async t => {
  let attempts = 0;
  const f = fixture(t, { removeScratch: async () => { if (++attempts === 1) throw Object.assign(Error('locked'), { code: 'EBUSY' }); } });
  const failed = await f.service.delete(ID);
  assert.equal(failed.code, 'CONVERSATION_SCRATCH_DELETE_FAILED'); assert.equal(failed.causeCode, 'EBUSY');
  assert.equal(f.history.has(ID), true); assert.equal(f.service.canWrite(ID), false);
  assert.equal((await f.service.delete(ID)).ok, true);
  assert.equal(f.calls.filter(([name]) => name === 'stop').length, 2);
});

test('history cleanup failure leaves the barrier and retries the idempotent scratch cleanup', async t => {
  let attempts = 0;
  const f = fixture(t, { removeHistory: async id => {
    if (++attempts === 1) throw Object.assign(Error('history read-only'), { code: 'EACCES' });
    f.history.delete(id);
  } });
  assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_HISTORY_DELETE_FAILED');
  assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), false);
  assert.equal(f.state().items[ID].status, 'deleting');
  assert.equal((await f.service.delete(ID)).ok, true);
  assert.equal(f.calls.filter(([name]) => name === 'scratch').length, 2);
});

test('structured callback failures are not mistaken for successful cleanup', async t => {
  for (const stage of ['stopConversation', 'removeScratch', 'removeHistory']) {
    const f = fixture(t, { [stage]: async () => ({ ok: false, error: 'injected failure', code: 'SYNTHETIC_FAILURE' }) });
    const result = await f.service.delete(ID);
    assert.equal(result.ok, false); assert.equal(result.causeCode, 'SYNTHETIC_FAILURE');
    assert.match(result.error, /injected failure/);
    assert.equal(f.history.has(ID), true);
  }
});

test('an interrupted deletion survives restart, blocks late saves and can be retried', async t => {
  const f = fixture(t, { stopConversation: async () => ({ stopConfirmed: false }) });
  await f.service.delete(ID);
  let stops = 0;
  const restarted = createConversationDeletion({ ...f.options,
    stopConversation: async () => { stops++; return { stopConfirmed: true }; } });
  assert.equal(restarted.canWrite(ID), false);
  assert.throws(() => restarted.assertAvailable(ID), { code: 'CONVERSATION_DELETING' });
  assert.equal((await restarted.delete(ID)).ok, true); assert.equal(stops, 1);
  assert.equal(f.history.has(ID), false);
});

test('a successful deletion stays unavailable after restart and does not call shutdown again', async t => {
  const f = fixture(t); await f.service.delete(ID);
  const before = f.calls.length, restarted = createConversationDeletion(f.options);
  assert.equal(restarted.canWrite(ID), false); assert.equal(restarted.canWrite(OTHER), true);
  assert.throws(() => restarted.assertAvailable(ID), { code: 'CONVERSATION_DELETED' });
  assert.equal((await restarted.delete(ID)).alreadyDeleted, true);
  assert.equal(f.calls.length, before);
});

test('invalid IDs never reach lifecycle callbacks or create the state file', async t => {
  const f = fixture(t);
  for (const id of [null, undefined, '', '../history', 'a/b', 'a\\b', 'x'.repeat(129), {}, 123]) {
    const result = await f.service.delete(id);
    assert.equal(result.code, 'INVALID_CONVERSATION_ID'); assert.equal(result.retryable, false);
    assert.equal(f.service.canWrite(id), false);
    assert.throws(() => f.service.assertAvailable(id), { code: 'INVALID_CONVERSATION_ID' });
  }
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.options.statePath), false);
});

test('a failed initial state write does not stop an executor or touch either directory', async t => {
  let failRename = true;
  const io = Object.assign(Object.create(fs), { renameSync(...args) {
    if (failRename) throw Object.assign(Error('disk denied'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } });
  const f = fixture(t, { fileSystem: io });
  const result = await f.service.delete(ID);
  assert.equal(result.code, 'CONVERSATION_DELETION_STATE_WRITE_FAILED');
  assert.deepEqual(f.calls, []); assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
  assert.equal(f.service.canWrite(ID), true);
  assert.deepEqual(fs.readdirSync(f.root), [], 'failed transaction removes only its own temporary file');
  failRename = false; assert.equal((await f.service.delete(ID)).ok, true);
});

test('corrupt or invalid state fails closed without overwriting the evidence', async t => {
  for (const content of ['not json', '{}', '{"version":2,"items":{}}', '{"version":1,"items":{"../bad":{"status":"deleted"}}}', '{"version":1,"items":{"a":{"status":"stopped"}}}']) {
    const f = fixture(t); fs.writeFileSync(f.options.statePath, content);
    assert.equal(f.service.canWrite(ID), false);
    assert.throws(() => f.service.assertAvailable(ID), { code: 'CONVERSATION_DELETION_STATE_UNAVAILABLE' });
    assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_DELETION_STATE_UNAVAILABLE');
    assert.deepEqual(f.calls, []); assert.equal(fs.readFileSync(f.options.statePath, 'utf8'), content);
  }
});

test('post-delete cleanup errors return success with a warning and retain the tombstone', async t => {
  const f = fixture(t, { afterDelete: async () => { throw Error('mini reset failed'); } });
  const result = await f.service.delete(ID);
  assert.equal(result.ok, true); assert.equal(result.deleted, true);
  assert.match(result.cleanupWarning, /mini reset failed/);
  assert.equal(result.warnings[0].code, 'CONVERSATION_DELETE_CLEANUP_FAILED');
  assert.equal(f.history.has(ID), false); assert.equal(f.state().items[ID].status, 'deleted');
  assert.equal(f.service.canWrite(ID), false);
});

test('final state write failure keeps the durable barrier and reports the already completed deletion honestly', async t => {
  let writes = 0;
  const io = Object.assign(Object.create(fs), { renameSync(...args) {
    if (++writes === 2) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    return fs.renameSync(...args);
  } });
  const f = fixture(t, { fileSystem: io }), result = await f.service.delete(ID);
  assert.equal(result.ok, true); assert.match(result.cleanupWarning, /disk full/);
  assert.equal(f.history.has(ID), false); assert.equal(f.service.canWrite(ID), false);
  assert.equal(f.state().items[ID].status, 'deleting');
  const restarted = createConversationDeletion(f.options);
  assert.equal(restarted.canWrite(ID), false);
  assert.equal((await restarted.delete(ID)).ok, true);
  assert.equal(f.state().items[ID].status, 'deleted');
});

test('late presentation saves cannot recreate deleted history when wired through canWrite', async t => {
  const f = fixture(t), oldSnapshot = { id: ID, turns: [{ user: 'synthetic request' }] };
  const lateSave = snapshot => { if (f.service.canWrite(snapshot.id)) f.history.add(snapshot.id); };
  const deletion = f.service.delete(ID);
  lateSave(oldSnapshot);
  await deletion;
  lateSave(oldSnapshot);
  assert.equal(f.history.has(ID), false);
  assert.equal(f.service.canWrite(OTHER), true);
});

test('protection errors release only a fresh, provably unchanged cleanup and preserve partial-deletion retry barriers', async t => {
  const protection = () => Object.assign(new Error('delivered output retained'), { code: 'SCRATCH_CLEANUP_PROTECTED', cleanupUnchanged: true });
  for (const changed of [false, true]) {
    let attempt = 0;
    const f = fixture(t, { removeScratch: async () => {
      if (changed && ++attempt === 1) throw Object.assign(new Error('partial cleanup failure'), { code: 'EBUSY' });
      throw protection();
    } });
    if (changed) await f.service.delete(ID);
    const result = await f.service.delete(ID);
    assert.equal(result.ok, false); assert.equal(f.history.has(ID), true);
    assert.equal(f.service.canWrite(ID), !changed);
    assert.equal(createConversationDeletion(f.options).canWrite(ID), !changed);
    assert.equal(result.conversationAvailable === true, !changed);
  }
});

test('failure to persist protection-barrier release keeps admission blocked', async t => {
  let writes = 0;
  const io = Object.assign(Object.create(fs), { renameSync(...args) {
    if (++writes === 2) throw Object.assign(new Error('release disk full'), { code: 'ENOSPC' });
    return fs.renameSync(...args);
  } });
  const f = fixture(t, { fileSystem: io, removeScratch: async () => { throw Object.assign(new Error('protected'), { code: 'SCRATCH_CLEANUP_PROTECTED', cleanupUnchanged: true }); } });
  const result = await f.service.delete(ID);
  assert.equal(result.code, 'CONVERSATION_DELETION_STATE_WRITE_FAILED');
  assert.equal(f.service.canWrite(ID), false); assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
  assert.equal(createConversationDeletion(f.options).canWrite(ID), false);
});


function unavailableCleanup(overrides = {}) {
  return Object.assign(new Error('reference check unavailable'), {
    code: 'SCRATCH_CLEANUP_PROTECTED', cleanupUnchanged: true,
    protectionReason: 'check_unavailable', conversationId: OTHER,
    cause: { code: 'CLEANUP_HISTORY_TOO_LARGE' }, ...overrides,
  });
}

test('unavailable file cleanup never silently falls back to retaining all scratch', async t => {
  const f = fixture(t, { removeScratch: async () => { throw unavailableCleanup(); } });
  const result = await f.service.delete(ID);
  assert.equal(result.ok, false);
  assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
  assert.equal(result.conversationAvailable, true);
});

test('an interrupted old history-only deletion adopts the requested scratch cleanup on retry', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.options.statePath, JSON.stringify({ version: 1, items: { [ID]: {
    status: 'deleting', scratchRetained: { reason: 'separate_cleanup' },
  } } }));
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.ok, true); assert.equal(result.scratchRetained, undefined);
  assert.equal(f.history.has(ID), false); assert.equal(f.scratch.has(ID), false);
  assert.equal(f.state().items[ID].scratchRetained, undefined);
});

test('scratch cleanup result survives history failure and restart, without skipping shutdown or cleanup', async t => {
  let cleanups = 0, historyWrites = 0;
  const f = fixture(t, {
    removeScratch: async id => { f.scratch.delete(id); return { removedPaths: ++cleanups === 1 ? ['owned-scratch'] : [] }; },
    removeHistory: async id => { if (++historyWrites === 1) throw Error('index locked'); f.history.delete(id); },
  });
  assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_HISTORY_DELETE_FAILED');
  assert.deepEqual(f.state().items[ID].fileCleanup.removedPaths, ['owned-scratch']);
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.ok, true); assert.equal(cleanups, 2);
  assert.deepEqual(result.fileCleanup.removedPaths, ['owned-scratch']);
  assert.equal(f.calls.filter(([name]) => name === 'stop').length, 2);
});

test('a cleanup-result persistence failure keeps history and a durable retry barrier', async t => {
  let writes = 0;
  const io = Object.assign(Object.create(fs), { renameSync(...args) {
    if (++writes === 2) throw Object.assign(new Error('cleanup state disk full'), { code: 'ENOSPC' });
    return fs.renameSync(...args);
  } });
  const f = fixture(t, { fileSystem: io, removeScratch: async id => { f.scratch.delete(id); return { removedPaths: ['owned-scratch'] }; } });
  const result = await f.service.delete(ID);
  assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_DELETION_STATE_WRITE_FAILED');
  assert.equal(f.history.has(ID), true); assert.equal(f.service.canWrite(ID), false);
  assert.equal(f.state().items[ID].status, 'deleting');
});

test('an already completed historical record is not expanded into a new filesystem deletion', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.options.statePath, JSON.stringify({ version: 1, items: { [ID]: {
    status: 'deleted', scratchRetained: { reason: 'separate_cleanup' },
  } } }));
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.alreadyDeleted, true); assert.equal(result.scratchRetained, true);
  assert.deepEqual(f.calls, []); assert.equal(f.scratch.has(ID), true);
});

test('a possibly partial deletion never falls back to history-only deletion', async t => {
  let attempts = 0;
  const f = fixture(t, { removeScratch: async () => {
    if (++attempts === 1) throw Object.assign(new Error('partial cleanup failed'), { code: 'EBUSY' });
    throw unavailableCleanup();
  } });
  assert.equal((await f.service.delete(ID)).ok, false);
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_SCRATCH_DELETE_FAILED');
  assert.equal(f.history.has(ID), true); assert.equal(f.state().items[ID].scratchRetained, undefined);
});

test('known references and unproven preflight failures still preserve history as well as files', async t => {
  for (const overrides of [
    { protectionReason: 'final_output_reference' }, { protectionReason: 'output_directory' },
    { cleanupUnchanged: false }, { cleanupUnchanged: undefined },
  ]) {
    const f = fixture(t, { removeScratch: async () => { throw unavailableCleanup(overrides); } });
    assert.equal((await f.service.delete(ID)).ok, false);
    assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
  }
});

test('a fresh directory ownership rejection preserves history and releases its admission barrier', async t => {
  const f = fixture(t, { removeScratch: async () => { throw Object.assign(Error('shared directory'), {
    code: 'CONVERSATION_FILES_NOT_OWNED', cleanupUnchanged: true,
  }); } });
  const result = await f.service.delete(ID);
  assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_FILES_NOT_OWNED');
  assert.equal(result.conversationAvailable, true); assert.equal(f.service.canWrite(ID), true);
  assert.equal(f.history.has(ID), true); assert.equal(f.scratch.has(ID), true);
});

// Running-state policy is a backend guard, independent of when a UI dialog opened.
const RUNNING_DELETE_ERROR = '任务正在运行，请等待完成或手动暂停后再删除。';

function assertFreshDeletionUntouched(f) {
  assert.deepEqual(f.calls, []);
  assert.equal(f.history.has(ID), true);
  assert.equal(f.scratch.has(ID), true);
  assert.equal(f.service.canWrite(ID), true);
  assert.doesNotThrow(() => f.service.assertAvailable(ID));
  assert.equal(fs.existsSync(f.options.statePath), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
}

test('running conversations reject deletion without releasing an executor, writing a tombstone or touching files', async t => {
  const checked = [];
  const f = fixture(t, { isRunning: id => { checked.push(id); return true; } });
  const result = await f.service.delete(ID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONVERSATION_RUNNING');
  assert.equal(result.error, RUNNING_DELETE_ERROR);
  assert.equal(result.retryable, false);
  assert.deepEqual(checked, [ID]);
  assertFreshDeletionUntouched(f);
});

test('a conversation can be deleted normally after completion or an explicit pause', async t => {
  for (const nextState of ['completed', 'paused']) {
    let state = 'running';
    const f = fixture(t, { isRunning: () => state === 'running' });
    assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_RUNNING');
    assertFreshDeletionUntouched(f);
    state = nextState;
    assert.deepEqual(await f.service.delete(ID), { ok: true, id: ID, deleted: true });
    assert.deepEqual(f.calls, [['stop', ID], ['scratch', ID], ['history', ID], ['after', ID]]);
    assert.equal(f.history.has(ID), false);
    assert.equal(f.scratch.has(ID), false);
    assert.equal(f.state().items[ID].status, 'deleted');
  }
});

test('an old delete dialog cannot delete a task that started after the dialog opened', async t => {
  let running = false, checks = 0;
  const f = fixture(t, { isRunning: () => { checks++; return running; } });
  // Availability when opening a dialog is not authorization for a later delete.
  f.service.assertAvailable(ID);
  assert.equal(f.service.canWrite(ID), true);
  running = true;
  const result = await f.service.delete(ID);
  assert.equal(result.code, 'CONVERSATION_RUNNING');
  assert.equal(result.retryable, false);
  assert.equal(checks, 1, 'delete reads current backend state');
  assertFreshDeletionUntouched(f);
});

test('idle deletion installs its admission barrier synchronously before executor release can yield', async t => {
  const released = deferred();
  let checks = 0, releases = 0;
  const f = fixture(t, {
    isRunning: () => { checks++; return false; },
    stopConversation: () => {
      releases++;
      assert.equal(f.service.canWrite(ID), false);
      assert.throws(() => f.service.assertAvailable(ID), { code: 'CONVERSATION_DELETING' });
      return released.promise;
    },
  });
  const deletion = f.service.delete(ID);
  assert.equal(checks, 1);
  assert.equal(f.service.canWrite(ID), false);
  assert.throws(() => f.service.assertAvailable(ID), { code: 'CONVERSATION_DELETING' });
  assert.equal(f.state().items[ID].status, 'deleting');
  await Promise.resolve();
  assert.equal(releases, 1);
  let started = false;
  const attemptStart = () => { f.service.assertAvailable(ID); started = true; };
  assert.throws(attemptStart, { code: 'CONVERSATION_DELETING' });
  assert.equal(started, false);
  assert.equal(f.history.has(ID), true);
  assert.equal(f.scratch.has(ID), true);
  released.resolve({ stopConfirmed: true });
  assert.equal((await deletion).ok, true);
});

test('an already deleted conversation stays idempotent even when running-state checks are unavailable', async t => {
  const f = fixture(t);
  await f.service.delete(ID);
  const saved = fs.readFileSync(f.options.statePath, 'utf8'), beforeCalls = [...f.calls];
  let checks = 0;
  const reopened = createConversationDeletion({
    ...f.options,
    isRunning: () => { checks++; throw Error('runtime state unavailable'); },
  });
  const result = await reopened.delete(ID);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDeleted, true);
  assert.equal(checks, 0);
  assert.deepEqual(f.calls, beforeCalls);
  assert.equal(fs.readFileSync(f.options.statePath, 'utf8'), saved);
});

test('a failing synchronous running-state check fails closed without creating a deletion barrier', async t => {
  for (const error of [Error('runtime state unavailable'), Object.assign(Error('busy registry unavailable'), { code: 'EIO' })]) {
    const f = fixture(t, { isRunning: () => { throw error; } });
    const result = await f.service.delete(ID);
    assert.equal(result.ok, false);
    assertFreshDeletionUntouched(f);
  }
});

test('async running-state callbacks fail closed even when their eventual answer would be idle', async t => {
  for (const callback of [async () => false, async () => true, () => Promise.resolve(false)]) {
    const f = fixture(t, { isRunning: callback });
    const result = await f.service.delete(ID);
    assert.equal(result.ok, false);
    assertFreshDeletionUntouched(f);
  }
});

test('running-state checks use the canonical conversation ID for Windows UUID aliases', async t => {
  const id = 'abcdef00-abcd-4000-8000-abcdefabcdef', checked = [];
  const f = fixture(t, { isRunning: candidate => { checked.push(candidate); return true; } });
  assert.equal((await f.service.delete(id.toUpperCase())).code, 'CONVERSATION_RUNNING');
  assert.deepEqual(checked, [id]);
  assert.equal(f.service.canWrite(id), true);
  assert.equal(fs.existsSync(f.options.statePath), false);
  assert.deepEqual(f.calls, []);
});

test('a busy retry preserves an earlier deletion barrier without rewriting or invoking cleanup', async t => {
  const f = fixture(t, { isRunning: () => true });
  const record = { version: 1, items: { [ID]: {
    status: 'deleting', startedAt: '2026-10-01T00:00:00.000Z', fileCleanup: { removedPaths: ['owned-scratch'] },
  } } };
  const saved = JSON.stringify(record);
  fs.writeFileSync(f.options.statePath, saved);
  const reopened = createConversationDeletion(f.options);
  const result = await reopened.delete(ID);
  assert.equal(result.code, 'CONVERSATION_RUNNING');
  assert.equal(result.retryable, false);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.options.statePath, 'utf8'), saved);
  assert.equal(reopened.canWrite(ID), false);
  assert.equal(f.history.has(ID), true);
  assert.equal(f.scratch.has(ID), true);
});

test('a running conversation does not prevent deleting a different idle conversation', async t => {
  const f = fixture(t, { isRunning: id => id === ID });
  assert.equal((await f.service.delete(ID)).code, 'CONVERSATION_RUNNING');
  assert.equal((await f.service.delete(OTHER)).ok, true);
  assert.equal(f.service.canWrite(ID), true);
  assert.equal(f.history.has(ID), true);
  assert.equal(f.scratch.has(ID), true);
  assert.equal(f.history.has(OTHER), false);
  assert.equal(f.scratch.has(OTHER), false);
  assert.deepEqual(f.calls, [['stop', OTHER], ['scratch', OTHER], ['history', OTHER], ['after', OTHER]]);
  assert.deepEqual(Object.keys(f.state().items), [OTHER]);
});


test('a task becoming active while migration settles is never stopped or deleted and releases only a fresh barrier', async t => {
  for (const hadEarlierBarrier of [false, true]) {
    const migration = deferred();
    let running = false, waitingForMigration = false, actualExecutorReleases = 0;
    const f = fixture(t, {
      isRunning: () => running,
      stopConversation: async id => {
        waitingForMigration = true;
        await migration.promise;
        f.service.assertIdle(id);
        actualExecutorReleases++;
        return { stopConfirmed: true };
      },
    });
    if (hadEarlierBarrier) fs.writeFileSync(f.options.statePath, JSON.stringify({
      version: 1, items: { [ID]: { status: 'deleting', startedAt: '2026-10-01T00:00:00.000Z' } },
    }));
    const deletion = f.service.delete(ID);
    assert.equal(f.service.canWrite(ID), false);
    await Promise.resolve();
    assert.equal(waitingForMigration, true);
    running = true;
    migration.resolve();
    const result = await deletion;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONVERSATION_RUNNING');
    assert.equal(result.error, RUNNING_DELETE_ERROR);
    assert.equal(result.retryable, false);
    assert.equal(actualExecutorReleases, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(f.history.has(ID), true);
    assert.equal(f.scratch.has(ID), true);
    assert.equal(f.service.canWrite(ID), !hadEarlierBarrier);
    assert.equal(createConversationDeletion(f.options).canWrite(ID), !hadEarlierBarrier);
    if (hadEarlierBarrier) assert.equal(f.state().items[ID].status, 'deleting');
    else assert.equal(f.state().items[ID], undefined);
  }
});

test('a task becoming active before the deletion microtask runs preserves files and releases its fresh barrier', async t => {
  let running = false, checks = 0;
  const f = fixture(t, { isRunning: () => { checks++; return running; } });
  const deletion = f.service.delete(ID);
  assert.equal(checks, 1, 'initial admission check runs synchronously');
  assert.equal(f.service.canWrite(ID), false);
  running = true;
  const result = await deletion;
  assert.equal(result.code, 'CONVERSATION_RUNNING');
  assert.equal(result.retryable, false);
  assert.equal(checks, 2, 'perform rechecks before attempting idle-executor release');
  assert.deepEqual(f.calls, []);
  assert.equal(f.history.has(ID), true);
  assert.equal(f.scratch.has(ID), true);
  assert.equal(f.state().items[ID], undefined);
  assert.equal(f.service.canWrite(ID), true);
  assert.equal(createConversationDeletion(f.options).canWrite(ID), true);
});
