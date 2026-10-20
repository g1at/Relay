'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScratchMigration } = require('../src/main/app/scratch-migration');
const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
const { createConversationDeletion } = require('../src/main/app/conversation-deletion');
const { createHistoryStore } = require('../src/main/app/history-store');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scratch-queue-'));
  const source = path.join(dir, 'old'), target = path.join(dir, 'new');
  const service = createConversationWorkspaces({ homeDir: dir, registryPath: path.join(dir, 'workspaces.json'), scratchBaseDir: source });
  const migration = createScratchMigration({ getWorkspaces: () => service, getTargetRoot: () => target, pollMs: 10, ...extra });
  t.after(() => { migration.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, source, target, service, migration };
}
test('changing root moves existing files only after a busy task stops, without moving project output', async t => {
  let busy = true, stops = 0;
  const h = fixture(t, { isBusy: () => busy, stopIdle: async () => { stops++; return { stopConfirmed: true }; } });
  const workspace = h.service.resolveWorkspace({ conversationId: 'busy-task' });
  fs.writeFileSync(path.join(workspace.scratchDir, 'script.py'), 'scratch');
  fs.writeFileSync(path.join(workspace.cwd, 'report.txt'), 'deliverable');
  await h.migration.request();
  assert.equal(stops, 0); assert.equal(h.migration.status().pending, 1);
  assert.equal(fs.existsSync(workspace.scratchDir), true);
  busy = false;
  for (let n = 0; n < 200 && h.migration.status().migrated < 1; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.migration.status().migrated, 1);
  assert.equal(h.migration.status().pending, 0);
  assert.equal(stops, 1);
  const moved = h.service.resolveScratch('busy-task');
  assert.equal(path.dirname(moved), h.target); assert.equal(fs.existsSync(workspace.scratchDir), false);
  assert.equal(fs.readFileSync(path.join(moved, 'script.py'), 'utf8'), 'scratch');
  assert.equal(fs.readFileSync(path.join(workspace.cwd, 'report.txt'), 'utf8'), 'deliverable');
});
test('an unconfirmed process blocks copy and leaves the original directory available for retry', async t => {
  let confirmed = false;
  const h = fixture(t, { stopIdle: async () => ({ stopConfirmed: confirmed }) });
  const original = h.service.resolveScratch('retry'); fs.writeFileSync(path.join(original, 'part.bin'), 'part');
  await h.migration.request();
  assert.equal(h.migration.status().failed, 1); assert.equal(fs.existsSync(original), true);
  assert.equal(fs.existsSync(h.target), false);
  confirmed = true; await h.migration.request();
  assert.equal(h.migration.status().failed, 0); assert.equal(h.migration.status().migrated, 1);
});
test('migration locks admission before waiting for the idle executor, and deletion cancels copying', async t => {
  const close = defer(), entered = defer(); let available = true;
  const h = fixture(t, { canMigrate: () => available, stopIdle: () => { entered.resolve(); return close.promise; } });
  const original = h.service.resolveScratch('cancel-copy');
  const moving = h.migration.request(); await entered.promise;
  assert.throws(() => h.migration.assertAvailable('cancel-copy'), { code: 'SCRATCH_MIGRATING' });
  assert.equal(h.migration.status().pending, 0);
  let settled = false; const wait = h.migration.waitFor('cancel-copy').then(() => { settled = true; });
  await turn(); assert.equal(settled, false);
  available = false; close.resolve({ stopConfirmed: true }); await wait; await moving;
  assert.equal(fs.existsSync(original), true); assert.equal(h.migration.status().migrated, 0);
  h.migration.assertAvailable('cancel-copy');
});
test('one malformed entry does not prevent another conversation from migrating', async t => {
  const h = fixture(t); const actual = h.service.listScratch;
  h.service.resolveScratch('healthy');
  h.service.listScratch = async ids => [{ conversationId: 'corrupt', error: 'invalid ownership' }, ...await actual(ids)];
  await h.migration.request();
  assert.equal(h.migration.status().failed, 1); assert.equal(h.migration.status().migrated, 1);
  assert.equal(path.dirname(h.service.resolveScratch('healthy')), h.target);
});
test('migration status preserves the actionable delivery-protection reason and does not claim a blocked copy completed', async t => {
  const h = fixture(t);
  h.service.resolveScratch('protected');
  const reason = '临时目录仍被交付链接引用，请先处理：/synthetic/final.html';
  h.service.migrateScratch = async () => ({ migrated: false, cleanupPending: true, error: reason });
  await h.migration.request();
  assert.equal(h.migration.status().migrated, 0);
  assert.equal(h.migration.status().failed, 1);
  assert.equal(h.migration.status().error, reason);
  h.service.migrateScratch = async () => ({ migrated: false, cleanupPending: true });
  await h.migration.request();
  assert.doesNotMatch(h.migration.status().error, /已迁移/);
});
test('deletion removes the migrated scratch, keeps outputs, and cannot be revived by a late history save after restart', async t => {
  const h = fixture(t); let deletion;
  const history = createHistoryStore({ getUserDataDir: () => h.dir, canWrite: id => !deletion || deletion.canWrite(id) });
  const options = { statePath: path.join(h.dir, 'deletions.json'), stopConversation: async () => ({ stopConfirmed: true }),
    removeScratch: id => h.service.removeScratch(id), removeHistory: id => fs.promises.rm(history.convFilePath(id)) };
  deletion = createConversationDeletion(options);
  const workspace = h.service.resolveWorkspace({ conversationId: 'with-history' });
  const record = { id: 'with-history', turns: [], workingDir: workspace.cwd };
  history.persistConversationRecord(record);
  fs.writeFileSync(path.join(workspace.cwd, 'output.txt'), 'keep');
  fs.writeFileSync(path.join(workspace.scratchDir, 'temp.txt'), 'remove');
  await h.migration.request(); const moved = h.service.resolveScratch(record.id);
  assert.equal((await deletion.delete(record.id)).ok, true);
  assert.equal(fs.existsSync(moved), false); assert.equal(fs.existsSync(workspace.scratchDir), false);
  assert.equal(fs.readFileSync(path.join(workspace.cwd, 'output.txt'), 'utf8'), 'keep');
  history.persistConversationRecord(record); assert.equal(history.loadConversation(record.id), null);
  deletion = createConversationDeletion(options);
  history.persistConversationRecord(record); assert.equal(history.loadConversation(record.id), null);
});
test('a target change during an in-flight migration is reconciled before the worker finishes', async t => {
  const gate = defer(), entered = defer(); let destination;
  const h = fixture(t, { getTargetRoot: () => destination });
  destination = h.target; h.service.resolveScratch('moving-twice');
  const original = h.service.migrateScratch; let first = true;
  h.service.migrateScratch = async (id, root) => {
    if (first) { first = false; entered.resolve(); await gate.promise; }
    return original(id, root);
  };
  const job = h.migration.request(); await entered.promise;
  destination = path.join(h.dir, 'third'); const updated = h.migration.request();
  gate.resolve(); await job; await updated;
  assert.equal(path.dirname(h.service.resolveScratch('moving-twice')), destination);
  assert.equal(h.migration.status().failed, 0);
});

test('migration and interrupted-copy recovery do not inspect unrelated large history bodies', async t => {
  const { createConversationScratch } = require('../src/main/projects/conversation-scratch');
  const { MAX_CLEANUP_HISTORY_BYTES, readConversationForCleanup } = require('../src/main/projects/scratch-protection');
  const h = fixture(t), records = {}, target = path.join(h.dir, 'raw-target');
  const id = 'retry-with-large-history', other = 'unrelated';
  const unrelated = path.join(h.dir, 'unrelated.json');
  fs.writeFileSync(unrelated, JSON.stringify({ turns: [{ toolCalls: [{ result: 'x'.repeat(MAX_CLEANUP_HISTORY_BYTES) }] }] }));
  assert.ok(fs.statSync(unrelated).size > MAX_CLEANUP_HISTORY_BYTES);
  let reads = 0;
  const scratch = createConversationScratch({ legacyRoot: h.source, getRoot: () => h.source, folderFor: value => value,
    readRecords: () => records, saveRecords: () => {}, loadConversation: () => null,
    loadConversationForCleanup: () => { reads++; return readConversationForCleanup(unrelated); } });
  const source = scratch.resolve(id), token = 'b'.repeat(32);
  fs.writeFileSync(path.join(source, 'script.txt'), 'complete source');
  records[other] = { cwd: h.dir, outputDir: path.join(h.dir, 'outputs') };
  fs.mkdirSync(records[other].outputDir);
  fs.writeFileSync(path.join(records[other].outputDir, 'report.txt'), 'keep output');
  const targetDir = path.join(target, id), stagingDir = path.join(target, '.relay-migrate-' + id + '-' + token);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(stagingDir, '.relay-migration-' + token + '.json'),
    JSON.stringify({ version: 1, conversationId: id, token, source, target: targetDir }));
  fs.writeFileSync(path.join(stagingDir, 'script.txt'), 'partial copy');
  records[id].scratchMigration = { token, root: target, realRoot: fs.realpathSync(target), sourceDir: source, stagingDir, targetDir };
  const result = await scratch.migrate(id, target);
  assert.equal(result.migrated, true); assert.equal(result.cleanupPending, undefined); assert.equal(reads, 0);
  assert.equal(fs.readFileSync(path.join(result.path, 'script.txt'), 'utf8'), 'complete source');
  assert.equal(fs.existsSync(stagingDir), false); assert.equal(fs.existsSync(source), false);
  assert.equal(records[id].scratchMigration, undefined); assert.equal(records[id].scratchPrevious, undefined);
  assert.equal(fs.readFileSync(path.join(records[other].outputDir, 'report.txt'), 'utf8'), 'keep output');
  assert.ok(fs.statSync(unrelated).size > MAX_CLEANUP_HISTORY_BYTES);
});
test('migration still rejects registered output overlap without reading any final messages', async t => {
  const { createConversationScratch } = require('../src/main/projects/conversation-scratch');
  const h = fixture(t), records = {};
  const scratch = createConversationScratch({ legacyRoot: h.source, getRoot: () => h.source, folderFor: value => value,
    readRecords: () => records, saveRecords: () => {}, loadConversation: () => null,
    loadConversationForCleanup: () => { throw Error('History must not be read'); } });
  const source = scratch.resolve('protected-output');
  fs.writeFileSync(path.join(source, 'keep.txt'), 'retained');
  records.other = { cwd: h.dir, outputDir: path.join(source, 'outputs') };
  await assert.rejects(scratch.migrate('protected-output', h.target), { code: 'CONVERSATION_FILES_NOT_OWNED' });
  assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'retained');
  assert.equal(records['protected-output'].scratchDir, source);
});
