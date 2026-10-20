'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createConversationScratch } = require('../src/main/projects/conversation-scratch');
const A = 'chat-a', B = 'chat-b';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-target-delete-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'scratch'), dir = path.join(root, A), outputDir = path.join(home, 'outputs');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(outputDir); fs.writeFileSync(path.join(dir, 'process.txt'), 'temporary');
  fs.writeFileSync(path.join(outputDir, 'deliverable.txt'), 'keep delivery');
  let saves = 0, loads = 0;
  const records = { [A]: { cwd: home, outputDir, scratchRoot: root, scratchDir: dir, scratchRootReal: fs.realpathSync(root) } };
  const options = { legacyRoot: root, getRoot: () => root, folderFor: id => id,
    readRecords: () => records, saveRecords: () => { saves++; },
    loadConversation: () => { loads++; throw new Error('history must not be read'); },
    loadConversationForCleanup: () => { loads++; throw new Error('history must not be scanned'); } };
  return { home, root, dir, outputDir, records, options, scratch: createConversationScratch(options), saves: () => saves, loads: () => loads };
}
function outputRetained(f) { assert.equal(fs.readFileSync(path.join(f.outputDir, 'deliverable.txt'), 'utf8'), 'keep delivery'); }

test('targeted deletion removes current scratch including linked deliverables without reading any history and retains outputs', async t => {
  const f = fixture(t); const result = await f.scratch.removeForHistoryDeletion(A);
  assert.equal(result.removed, true); assert.deepEqual(result.removedPaths, [f.dir]);
  assert.equal(fs.existsSync(f.dir), false); outputRetained(f); assert.equal(f.loads(), 0);
  assert.deepEqual(f.records[A], { cwd: f.home, outputDir: f.outputDir });
});

test('already absent scratch clears its allocation without touching another conversation or reading history', async t => {
  const f = fixture(t); fs.rmSync(f.dir, { recursive: true }); f.records[B] = { cwd: f.home, scratchRoot: f.root, scratchDir: path.join(f.root, B) };
  const otherBefore = JSON.stringify(f.records[B]);
  const result = await f.scratch.removeForHistoryDeletion(A); assert.equal(result.removed, false);
  assert.equal(JSON.stringify(f.records[B]), otherBefore); assert.equal(f.records[A].scratchDir, undefined); assert.equal(f.loads(), 0); outputRetained(f);
});

test('legacy unregistered id-specific scratch is removed using asynchronous path inspection', async t => {
  const f = fixture(t); delete f.records[A];
  const sync = t.mock.method(fs, 'lstatSync', () => { throw new Error('sync path inspection'); });
  assert.equal((await f.scratch.removeForHistoryDeletion(A)).removed, true); sync.mock.restore();
  assert.equal(f.records[A], undefined); assert.equal(fs.existsSync(f.dir), false); outputRetained(f);
});

test('current and previous scratch are both removed while a descendant symlink leaves external content intact', async t => {
  const f = fixture(t), old = path.join(f.home, 'old'), previous = path.join(old, A), external = path.join(f.home, 'input');
  fs.mkdirSync(previous, { recursive: true }); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'input.txt'), 'original input');
  fs.symlinkSync(external, path.join(f.dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  f.records[A].scratchPrevious = [{ root: old, dir: previous, realRoot: fs.realpathSync(old) }];
  const result = await f.scratch.removeForHistoryDeletion(A); assert.equal(result.removedPaths.length, 2);
  assert.equal(fs.existsSync(previous), false); assert.equal(fs.readFileSync(path.join(external, 'input.txt'), 'utf8'), 'original input'); outputRetained(f);
});

function migration(f) {
  const root = path.join(f.home, 'migration'), token = 'a'.repeat(32); fs.mkdirSync(root);
  const stagingDir = path.join(root, '.relay-migrate-' + A + '-' + token), targetDir = path.join(root, A);
  f.records[A].scratchMigration = { token, root, realRoot: fs.realpathSync(root), sourceDir: f.dir, stagingDir, targetDir };
  for (const dir of [stagingDir, targetDir]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, '.relay-migration-' + token + '.json'), JSON.stringify({ conversationId: A, token, source: f.dir, target: targetDir })); }
  return { root, token, stagingDir, targetDir };
}

test('owned migration source and both token-marked copies are removed together', async t => {
  const f = fixture(t), m = migration(f); const result = await f.scratch.removeForHistoryDeletion(A);
  assert.equal(result.removedPaths.length, 3); assert.equal(fs.existsSync(m.stagingDir), false); assert.equal(fs.existsSync(m.targetDir), false);
  assert.equal(f.records[A].scratchMigration, undefined); outputRetained(f);
});

test('missing migration marker blocks every deletion before any source or copy is removed', async t => {
  const f = fixture(t), m = migration(f); fs.unlinkSync(path.join(m.targetDir, '.relay-migration-' + m.token + '.json'));
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === true);
  assert.equal(fs.existsSync(f.dir), true); assert.equal(fs.existsSync(m.stagingDir), true); assert.equal(fs.existsSync(m.targetDir), true); assert.equal(f.saves(), 0);
});

test('another registered cwd, scratch allocation or dedicated output inside the target blocks deletion', async t => {
  const f = fixture(t);
  for (const item of [{ cwd: f.dir }, { scratchDir: path.join(f.dir, 'other') }, { cwd: f.home, outputDir: path.join(f.dir, 'outputs') }, { cwd: f.home, outputDir: f.root }]) {
    f.records[B] = item;
    await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.code === 'CONVERSATION_FILES_NOT_OWNED' && error.cleanupUnchanged);
    assert.equal(fs.existsSync(path.join(f.dir, 'process.txt')), true);
  }
});

test('current realpath of another cwd remains protected even if its persisted pin is stale', async t => {
  const f = fixture(t), alias = path.join(f.home, 'alias'); fs.symlinkSync(f.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.records[B] = { cwd: alias, browseScope: { realCwd: path.join(f.home, 'obsolete-cwd') } };
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === true);
  assert.equal(fs.existsSync(path.join(f.dir, 'process.txt')), true);
});

test('permission errors and inaccessible volumes retain history-cleanup ownership for a retry', async t => {
  const f = fixture(t), original = fs.promises.lstat.bind(fs.promises), snapshot = JSON.stringify(f.records);
  const mock = t.mock.method(fs.promises, 'lstat', async file => { if (file === f.root) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return original(file); });
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), { code: 'EACCES' }); mock.mock.restore();
  assert.equal(JSON.stringify(f.records), snapshot); assert.equal(fs.existsSync(f.dir), true);
  fs.rmSync(f.root, { recursive: true }); t.mock.method(fs.promises, 'access', async () => { throw Object.assign(new Error('volume offline'), { code: 'ENOENT' }); });
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), { code: 'ENOENT' }); assert.equal(JSON.stringify(f.records), snapshot);
});

test('physical root changes and a top-level symlink are rejected before removing any files', async t => {
  const f = fixture(t); f.records[A].scratchRootReal = path.join(f.home, 'different-root');
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === true);
  f.records[A].scratchRootReal = fs.realpathSync(f.root); const moved = path.join(f.home, 'actual'); fs.renameSync(f.dir, moved); fs.symlinkSync(moved, f.dir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === true);
  assert.equal(fs.readFileSync(path.join(moved, 'process.txt'), 'utf8'), 'temporary');
});

test('unrelated runtime metadata changes do not invalidate scratch ownership', async t => {
  const f = fixture(t), original = fs.promises.realpath.bind(fs.promises);
  f.records[A].browseScope = { realCwd: f.home, realOutput: f.outputDir, projectId: 'before' };
  t.mock.method(fs.promises, 'realpath', async file => { f.records[A].browseScope.projectId = 'after'; f.records[A].needsContext = true; return original(file); });
  assert.equal((await f.scratch.removeForHistoryDeletion(A)).removed, true); assert.equal(f.records[A].needsContext, true);
});

test('changed ownership during inspection blocks cleanup before removing files', async t => {
  const f = fixture(t), original = fs.promises.realpath.bind(fs.promises);
  t.mock.method(fs.promises, 'realpath', async file => { f.records[A].scratchPrevious = [{ root: f.root, dir: f.dir }]; return original(file); });
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === true);
  assert.equal(fs.existsSync(f.dir), true); assert.equal(f.saves(), 0);
});

test('partial removal failures keep all allocation metadata and retries remove only remaining owned paths', async t => {
  const f = fixture(t), old = path.join(f.home, 'old'), previous = path.join(old, A); fs.mkdirSync(previous, { recursive: true });
  f.records[A].scratchPrevious = [{ root: old, dir: previous, realRoot: fs.realpathSync(old) }]; const snapshot = JSON.stringify(f.records);
  const rm = fs.promises.rm.bind(fs.promises), mock = t.mock.method(fs.promises, 'rm', async (file, options) => { if (file === previous) throw Object.assign(new Error('fixture lock'), { code: 'EBUSY' }); return rm(file, options); });
  await assert.rejects(f.scratch.removeForHistoryDeletion(A), error => error.cleanupUnchanged === false && error.removedPaths.length === 1);
  mock.mock.restore(); assert.equal(fs.existsSync(f.dir), false); assert.equal(fs.existsSync(previous), true); assert.equal(JSON.stringify(f.records), snapshot);
  assert.equal((await f.scratch.removeForHistoryDeletion(A)).removed, true); assert.equal(fs.existsSync(previous), false); outputRetained(f);
});

test('registry write failure after cleanup remains retryable without claiming files were retained', async t => {
  const f = fixture(t), snapshot = JSON.stringify(f.records); let denied = true;
  const scratch = createConversationScratch({ ...f.options, saveRecords: () => { if (denied) throw Object.assign(new Error('fixture registry write'), { code: 'ENOSPC' }); } });
  await assert.rejects(scratch.removeForHistoryDeletion(A), error => error.code === 'ENOSPC' && error.cleanupUnchanged === false);
  assert.equal(fs.existsSync(f.dir), false); assert.equal(JSON.stringify(f.records), snapshot); denied = false;
  assert.equal((await scratch.removeForHistoryDeletion(A)).removed, false); assert.equal(f.records[A].scratchDir, undefined); outputRetained(f);
});


test('two independent conversations clean their scratch concurrently without treating unrelated registry updates as conflicts', async t => {
  const f = fixture(t), second = path.join(f.root, B); fs.mkdirSync(second); fs.writeFileSync(path.join(second, 'process.txt'), 'other temporary');
  f.records[B] = { cwd: f.home, outputDir: f.outputDir, scratchRoot: f.root, scratchDir: second, scratchRootReal: fs.realpathSync(f.root) };
  const results = await Promise.all([f.scratch.removeForHistoryDeletion(A), f.scratch.removeForHistoryDeletion(B)]);
  assert.ok(results.every(result => result.removed)); assert.equal(fs.existsSync(f.dir), false); assert.equal(fs.existsSync(second), false);
  assert.equal(f.records[A].scratchDir, undefined); assert.equal(f.records[B].scratchDir, undefined); assert.equal(f.loads(), 0); outputRetained(f);
});
