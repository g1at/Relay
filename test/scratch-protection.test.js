'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationScratch } = require('../src/main/projects/conversation-scratch');
const { createConversationDeletion } = require('../src/main/app/conversation-deletion');
const { assertScratchCleanupAllowed, finalFileMessages } = require('../src/main/projects/scratch-protection');
const A = 'conversation-a', B = 'conversation-b';
const link = file => `[交付文件](<${file}>)`;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scratch-protection-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const records = {}, conversations = {}, legacyRoot = path.join(home, 'scratch');
  const options = { legacyRoot, getRoot: () => legacyRoot, folderFor: id => id,
    readRecords: () => records, saveRecords: () => {}, loadConversation: id => conversations[id] || null };
  const scratch = createConversationScratch(options);
  const dir = scratch.resolve(A), file = path.join(dir, 'delivered.txt');
  fs.writeFileSync(file, 'retained result');
  return { home, records, conversations, options, scratch, dir, file };
}
function protectedError(error) {
  return error.code === 'SCRATCH_CLEANUP_PROTECTED' && error.cleanupUnchanged === true;
}

test('all completed final turns protect actual deliverables and moving them out permits cleanup', async t => {
  const f = fixture(t);
  f.conversations[A] = { turns: [{ status: 'complete', output: { final: link(f.file) } }, { status: 'complete', assistant: '后续说明' }] };
  await assert.rejects(f.scratch.remove(A), protectedError);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'retained result');
  assert.equal(f.scratch.resolve(A), f.dir);
  const delivered = path.join(f.home, 'delivered.txt');
  fs.renameSync(f.file, delivered);
  assert.equal((await f.scratch.remove(A)).removed, true);
  assert.equal(fs.readFileSync(delivered, 'utf8'), 'retained result');
});

test('a different registered conversation protects its final file, directory and parent-directory links', async t => {
  const f = fixture(t);
  f.records[B] = { cwd: f.home };
  for (const delivered of [f.file, f.dir, path.dirname(f.dir)]) {
    f.conversations[B] = { turns: [{ assistant: link(delivered) }] };
    await assert.rejects(f.scratch.remove(A), error => protectedError(error) && error.conversationId === B);
    assert.equal(fs.existsSync(f.file), true);
  }
});

test('realpath aliases outside scratch still protect their delivered files', async t => {
  const f = fixture(t), alias = path.join(f.home, 'alias');
  fs.symlinkSync(f.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.conversations[A] = { turns: [{ assistant: link(path.join(alias, 'delivered.txt')) }] };
  await assert.rejects(f.scratch.remove(A), protectedError);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'retained result');
});

test('Windows and WSL spellings protect the same registered output directory', async () => {
  for (const [directory, outputDir] of [['C:\\Relay\\scratch\\a', '/mnt/c/relay/scratch/a/outputs'], ['/mnt/c/Relay/scratch/a', 'c:\\relay\\scratch\\a\\outputs']]) {
    await assert.rejects(() => assertScratchCleanupAllowed({ id: A, directories: [directory],
      records: { [B]: { outputDir } }, loadConversation: () => null }), error => error.code === 'SCRATCH_CLEANUP_PROTECTED' && error.protectionReason === 'output_directory');
  }
});

test('registered output roots are protected even when empty, while containing project roots remain usable', async t => {
  const f = fixture(t);
  f.records[B] = { outputDir: path.join(f.dir, 'outputs') };
  await assert.rejects(f.scratch.remove(A), protectedError);
  f.records[B].outputDir = f.home;
  assert.equal((await f.scratch.remove(A)).removed, true);
});

test('tool logs, user text, code examples and interrupted drafts are not final delivery references', async t => {
  const f = fixture(t), reference = link(f.file);
  f.conversations[A] = { turns: [
    { status: 'running', assistant: reference }, { status: 'cancelled', output: { final: reference } },
    { status: 'complete', output: { final: '' }, assistant: reference },
    { output: { status: 'running', final: reference } },
    { status: 'complete', user: reference, toolCalls: [{ result: reference }], assistant: '示例：\n```md\n' + reference + '\n```\n`' + reference + '`' },
  ] };
  assert.equal((await f.scratch.remove(A)).removed, true);
});

test('final text selection keeps legacy completed replies without falling back from an empty modern final', () => {
  assert.deepEqual(finalFileMessages({ turns: [{ assistant: 'legacy' }, { status: 'complete', assistant: 'complete' },
    { status: 'running', assistant: 'draft' }, { status: 'complete', assistant: 'draft', output: { final: '' } },
    { status: 'complete', assistant: 'draft', output: { final: 'final' } }] }), ['legacy', 'complete', 'final']);
});

test('delivery checks include links beyond the old eight-link presentation limit', async t => {
  const f = fixture(t);
  f.conversations[A] = { turns: [{ assistant: Array.from({ length: 9 }, (_, index) => link(index === 8 ? f.file : path.join(f.home, 'other-' + index))).join('\n') }] };
  await assert.rejects(f.scratch.remove(A), protectedError);
});

test('oversized final messages and unreadable conversation records fail before deleting any files', async t => {
  const f = fixture(t);
  f.conversations[A] = { turns: [{ assistant: 'x'.repeat(256 * 1024 + 1) }] };
  await assert.rejects(f.scratch.remove(A), error => protectedError(error) && error.cause?.code === 'LOCAL_FILE_LINKS_TOO_LARGE');
  const unreadable = createConversationScratch({ ...f.options, loadConversation: () => { throw Object.assign(new Error('fixture history denied'), { code: 'EACCES' }); } });
  await assert.rejects(unreadable.remove(A), error => protectedError(error) && error.protectionReason === 'check_unavailable');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'retained result');
});

test('an inaccessible known deliverable is retained instead of treated as absent', async t => {
  const f = fixture(t); f.conversations[A] = { turns: [{ assistant: link(f.file) }] };
  const original = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (...args) => { if (args[0] === f.file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return original(...args); });
  await assert.rejects(f.scratch.remove(A), error => protectedError(error) && error.cause?.code === 'EACCES');
  assert.equal(fs.existsSync(f.file), true);
});

test('migration moves registered scratch intact while generic cleanup still protects delivered files', async t => {
  const f = fixture(t); f.conversations[A] = { turns: [{ assistant: link(f.file) }] };
  const moved = await f.scratch.migrate(A, path.join(f.home, 'new-root'));
  assert.equal(moved.migrated, true); assert.equal(moved.cleanupPending, undefined);
  const currentFile = path.join(moved.path, 'delivered.txt');
  assert.equal(fs.readFileSync(currentFile, 'utf8'), 'retained result');
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal(f.records[A].scratchPrevious, undefined);
  f.conversations[A] = { turns: [{ assistant: link(currentFile) }] };
  await assert.rejects(f.scratch.remove(A), protectedError);
  assert.equal(fs.readFileSync(currentFile, 'utf8'), 'retained result');
  fs.renameSync(currentFile, path.join(f.home, 'saved.txt'));
  await f.scratch.remove(A);
  assert.equal(fs.existsSync(moved.path), false);
  assert.equal(fs.readFileSync(path.join(f.home, 'saved.txt'), 'utf8'), 'retained result');
});

test('a protected deletion releases its barrier durably so the user can reopen, save and retry', async t => {
  const f = fixture(t); f.conversations[A] = { turns: [{ assistant: link(f.file) }] };
  const options = { statePath: path.join(f.home, 'deletions.json'), stopConversation: async () => ({ stopConfirmed: true }),
    removeScratch: id => f.scratch.remove(id), removeHistory: id => { delete f.conversations[id]; } };
  const deletion = createConversationDeletion(options);
  const result = await deletion.delete(A);
  assert.equal(result.code, 'SCRATCH_CLEANUP_PROTECTED'); assert.equal(result.conversationAvailable, true);
  assert.equal(deletion.canWrite(A), true); assert.ok(f.conversations[A]);
  const restarted = createConversationDeletion(options);
  assert.equal(restarted.canWrite(A), true);
  fs.renameSync(f.file, path.join(f.home, 'result.txt'));
  assert.equal((await restarted.delete(A)).ok, true);
  assert.equal(f.conversations[A], undefined); assert.equal(fs.existsSync(path.join(f.home, 'result.txt')), true);
});

test('pending migration copies are preflighted before the current source or staging is removed', async t => {
  const f = fixture(t), root = path.join(f.home, 'pending-target'), token = 'a'.repeat(32);
  const targetDir = path.join(root, A), stagingDir = path.join(root, '.relay-migrate-' + A + '-' + token);
  fs.mkdirSync(targetDir, { recursive: true }); fs.mkdirSync(stagingDir);
  const delivered = path.join(targetDir, 'delivered.txt'); fs.writeFileSync(delivered, 'published copy');
  for (const candidate of [targetDir, stagingDir]) fs.writeFileSync(path.join(candidate, '.relay-migration-' + token + '.json'), JSON.stringify({ version: 1, conversationId: A, token, source: f.dir, target: targetDir }));
  f.records[A].scratchMigration = { token, root, realRoot: fs.realpathSync(root), sourceDir: f.dir, stagingDir, targetDir };
  f.records[B] = { cwd: f.home };
  f.conversations[B] = { turns: [{ assistant: link(delivered) }] };
  await assert.rejects(f.scratch.remove(A), protectedError);
  assert.equal(fs.existsSync(f.file), true); assert.equal(fs.existsSync(stagingDir), true);
  assert.equal(fs.readFileSync(delivered, 'utf8'), 'published copy');
  assert.ok(f.records[A].scratchMigration);
});

test('strict cleanup history reader distinguishes absence from damaged, invalid, denied and oversized histories', async t => {
  const f = fixture(t), { readConversationForCleanup } = require('../src/main/projects/scratch-protection');
  const file = path.join(f.home, 'history.json');
  assert.equal(await readConversationForCleanup(file), null);
  for (const content of ['{', 'null', '[]', '42', '{"turns":{}}']) {
    fs.writeFileSync(file, content);
    await assert.rejects(readConversationForCleanup(file));
  }
  fs.writeFileSync(file, JSON.stringify({ id: A, turns: [{ assistant: link(f.file) }] }));
  assert.equal((await readConversationForCleanup(file)).id, A);
  await assert.rejects(readConversationForCleanup(file, { maxBytes: 10 }), { code: 'CLEANUP_HISTORY_TOO_LARGE' });
  const open = fs.promises.open.bind(fs.promises);
  const mocked = t.mock.method(fs.promises, 'open', async (...args) => {
    if (args[0] === file) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return open(...args);
  });
  await assert.rejects(readConversationForCleanup(file), { code: 'EACCES' });
  mocked.mock.restore();
  await assert.rejects(readConversationForCleanup(f.home), { code: 'CLEANUP_HISTORY_INVALID' });
});

test('production workspace getter uses the strict cleanup reader even when ordinary history loading swallows JSON errors', async t => {
  const f = fixture(t), vm = require('node:vm');
  const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
  const start = bootstrap.indexOf('function getConversationWorkspaces() {');
  const end = bootstrap.indexOf('function resolveExecutionWorkspace(', start);
  assert.ok(start >= 0 && end > start);
  const historyFile = path.join(f.home, 'broken-history.json');
  fs.writeFileSync(historyFile, '{');
  let legacyLoads = 0;
  const context = {
    conversationWorkspaceService: null, createConversationWorkspaces, path, fs,
    app: { getPath: () => f.home }, generalPreferences: { scratchRoot: () => path.join(f.home, 'production-scratch'), workspaceRoot: () => path.join(f.home, 'workspaces') },
    assertConversationAvailable: () => {}, convFilePath: () => historyFile,
    loadConversation: () => { legacyLoads++; return null; }, persistConversationRecord: () => {},
    liveSessions: new Map(), taskLedger: null, readAppSettings: () => ({}),
    require: name => { assert.equal(name, './projects/scratch-protection'); return require('../src/main/projects/scratch-protection'); },
  };
  vm.runInNewContext(bootstrap.slice(start, end), context);
  const service = context.getConversationWorkspaces();
  const scratch = service.resolveScratch(A), delivered = path.join(scratch, 'deliverable.txt');
  fs.writeFileSync(delivered, 'keep');
  await assert.rejects(service.removeScratch(A), error => protectedError(error) && error.protectionReason === 'check_unavailable');
  assert.equal(fs.readFileSync(delivered, 'utf8'), 'keep');
  fs.writeFileSync(historyFile, JSON.stringify({ id: A, turns: [{ assistant: link(delivered) }] }));
  await assert.rejects(service.removeScratch(A), error => protectedError(error) && error.protectionReason === 'final_output_reference');
  assert.equal(legacyLoads, 1, 'only the allocation reads ordinary history; cleanup uses strict reads');
});

test('registry protection yields between conversation batches while retaining every completed reference', async t => {
  const f = fixture(t), records = {};
  for (let index = 0; index < 40; index++) records['fixture-' + index] = {};
  let yielded = false;
  setImmediate(() => { yielded = true; });
  await assert.rejects(assertScratchCleanupAllowed({ id: A, directories: [f.dir], records,
    loadConversation: id => id === 'fixture-39' ? { turns: [{ assistant: link(f.file) }] } : { turns: [] } }),
  error => error.code === 'SCRATCH_CLEANUP_PROTECTED');
  assert.equal(yielded, true);
  assert.equal(fs.existsSync(f.file), true);
});


test('one oversized unrelated history cannot prevent deleting the selected chat and its scratch', async t => {
  const f = fixture(t), { readConversationForCleanup, MAX_CLEANUP_HISTORY_BYTES } = require('../src/main/projects/scratch-protection');
  const historyRoot = path.join(f.home, 'history'); fs.mkdirSync(historyRoot);
  const large = path.join(historyRoot, B + '.json'), small = path.join(historyRoot, A + '.json');
  fs.writeFileSync(small, JSON.stringify({ id: A, turns: [{ user: '你好', status: 'failed' }] }));
  fs.writeFileSync(large, JSON.stringify({ id: B, turns: [{ toolCalls: [{ result: 'x'.repeat(MAX_CLEANUP_HISTORY_BYTES) }], assistant: link(f.file) }] }));
  f.records[B] = { cwd: f.home };
  let historyReads = 0;
  const scratch = createConversationScratch({ ...f.options,
    loadConversation: () => { historyReads++; throw Error('No body read during deletion'); },
    loadConversationForCleanup: () => { historyReads++; throw Error('No unrelated history inspection'); } });
  const deletion = createConversationDeletion({ statePath: path.join(f.home, 'deletions.json'),
    stopConversation: async () => ({ stopConfirmed: true }), removeScratch: id => scratch.removeForHistoryDeletion(id),
    removeHistory: id => fs.unlinkSync(path.join(historyRoot, id + '.json')) });
  const result = await deletion.delete(A);
  assert.equal(result.ok, true); assert.equal(result.scratchRetained, undefined);
  assert.equal(result.cleanupWarning, undefined); assert.equal(historyReads, 0);
  assert.equal(fs.existsSync(small), false); assert.equal(fs.existsSync(large), true);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.records[A]?.scratchDir, undefined);
  assert.equal(fs.statSync(large).size > MAX_CLEANUP_HISTORY_BYTES, true);
});
