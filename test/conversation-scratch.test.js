'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scratch-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'data', 'conversation-workspaces.json');
  const legacy = path.join(home, 'data', 'conversation-scratch');
  let root = null;
  const options = { homeDir: home, registryPath, getScratchBaseDir: () => root };
  return { home, legacy, registryPath, options, service: createConversationWorkspaces(options),
    setRoot: value => { root = value; }, records: () => JSON.parse(fs.readFileSync(registryPath, 'utf8')).items };
}
function write(dir, file = 'keep.txt') { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), 'fixture'); }

test('changing scratch preference pins allocated paths through workspace saves and restart, including scratch-only allocations', t => {
  const f = fixture(t), first = path.join(f.home, 'first'), second = path.join(f.home, 'second');
  f.setRoot(first);
  const original = f.service.resolveScratch(A);
  write(original);
  f.setRoot(second);
  const afterRestart = createConversationWorkspaces(f.options);
  assert.equal(afterRestart.resolveScratch(A), original);
  const workspace = afterRestart.resolveWorkspace({ conversationId: A });
  assert.equal(workspace.scratchDir, original);
  assert.equal(workspace.cwd, path.join(f.home, 'RelayProjects', A));
  assert.equal(f.records()[A].scratchRoot, first);
  assert.equal(afterRestart.resolveScratch(B), path.join(second, B));
  assert.equal(afterRestart.scratchBase, second);
});

test('legacy default scratch is adopted without moving files when a new root is already configured', async t => {
  const f = fixture(t), old = path.join(f.legacy, A);
  write(old); f.setRoot(path.join(f.home, 'new'));
  assert.equal(f.service.resolveScratch(A), old);
  assert.equal(f.records()[A].scratchDir, old);
  assert.equal(fs.readFileSync(path.join(old, 'keep.txt'), 'utf8'), 'fixture');
  await createConversationWorkspaces(f.options).removeScratch(A);
  assert.equal(fs.existsSync(old), false);
});

test('deletion removes only session scratch, retaining final workspace, sibling scratch and targets of internal links', async t => {
  const f = fixture(t), a = f.service.resolveWorkspace({ conversationId: A }), b = f.service.resolveScratch(B);
  write(a.cwd, 'result.txt'); write(a.scratchDir, 'intermediate.txt'); write(b);
  const target = path.join(f.home, 'external'); write(target);
  fs.symlinkSync(target, path.join(a.scratchDir, 'external-link'), linkType);
  const result = await f.service.removeScratch(A);
  assert.deepEqual(result, { removed: true, path: a.scratchDir });
  assert.equal(fs.existsSync(a.scratchDir), false);
  for (const file of [path.join(a.cwd, 'result.txt'), path.join(b, 'keep.txt'), path.join(target, 'keep.txt')]) assert.equal(fs.readFileSync(file, 'utf8'), 'fixture');
  assert.equal(f.records()[A].scratchDir, undefined);
  assert.equal(f.records()[A].cwd, a.cwd);
});

test('deleting unallocated scratch creates neither root nor registry, and removes unregistered legacy data only by exact session ID', async t => {
  const f = fixture(t);
  assert.equal((await f.service.removeScratch(A)).removed, false);
  assert.equal(fs.existsSync(f.legacy), false); assert.equal(fs.existsSync(f.registryPath), false);
  write(path.join(f.legacy, A)); write(path.join(f.legacy, B));
  assert.equal((await f.service.removeScratch(A)).removed, true);
  assert.equal(fs.existsSync(path.join(f.legacy, A)), false);
  assert.equal(fs.existsSync(path.join(f.legacy, B, 'keep.txt')), true);
});

test('deletion rejects redirected scratch leaf and root, leaving linked files intact', async t => {
  const f = fixture(t), a = f.service.resolveScratch(A), b = f.service.resolveScratch(B);
  write(b); fs.rmdirSync(a); fs.symlinkSync(b, a, linkType);
  await assert.rejects(f.service.removeScratch(A), /链接|其他会话/);
  assert.equal(fs.existsSync(path.join(b, 'keep.txt')), true);
  fs.unlinkSync(a); fs.rmSync(b, { recursive: true }); fs.rmdirSync(f.legacy);
  const outside = path.join(f.home, 'outside'); write(path.join(outside, A));
  fs.symlinkSync(outside, f.legacy, linkType);
  await assert.rejects(f.service.removeScratch(A), /链接/);
  assert.equal(fs.existsSync(path.join(outside, A, 'keep.txt')), true);
});

test('canonical root pin rejects a replaced ancestor even if its new destination contains a plausible session folder', async t => {
  const f = fixture(t), first = path.join(f.home, 'first'), second = path.join(f.home, 'second'), alias = path.join(f.home, 'alias');
  fs.mkdirSync(first); fs.mkdirSync(second); fs.symlinkSync(first, alias, linkType);
  f.setRoot(path.join(alias, 'scratch'));
  const original = f.service.resolveScratch(A); write(original);
  fs.unlinkSync(alias); fs.symlinkSync(second, alias, linkType);
  write(path.join(second, 'scratch', A));
  await assert.rejects(createConversationWorkspaces(f.options).removeScratch(A), /替换/);
  assert.equal(fs.existsSync(path.join(second, 'scratch', A, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(first, 'scratch', A, 'keep.txt')), true);
});

test('registry tampering cannot redirect deletion to sibling scratch or final output', async t => {
  const f = fixture(t), a = f.service.resolveWorkspace({ conversationId: A }), b = f.service.resolveScratch(B);
  write(a.cwd); write(b);
  let records = f.records(); records[A].scratchDir = b;
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: records }));
  await assert.rejects(createConversationWorkspaces(f.options).removeScratch(A), /不属于/);
  records[A].scratchDir = a.cwd; records[A].scratchRoot = path.dirname(a.cwd); delete records[A].scratchRootReal;
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: records }));
  await assert.rejects(createConversationWorkspaces(f.options).removeScratch(A), /工作目录重合|成果目录/);
  assert.equal(fs.existsSync(path.join(a.cwd, 'keep.txt')), true); assert.equal(fs.existsSync(path.join(b, 'keep.txt')), true);
});

test('scratch cannot use the default final-output folder or claim an occupied unregistered custom root child', t => {
  const f = fixture(t);
  f.setRoot(path.join(f.home, 'RelayProjects'));
  assert.throws(() => f.service.resolveWorkspace({ conversationId: A }), /重合|占用/);
  const chosen = path.join(f.home, 'chosen'); write(path.join(chosen, A)); f.setRoot(chosen);
  assert.throws(() => f.service.resolveScratch(A), /占用/);
  assert.equal(fs.existsSync(path.join(chosen, A, 'keep.txt')), true);
});

test('canonical output aliases and nested conversation allocations cannot share a deletable scratch tree', t => {
  const f = fixture(t), actual = path.join(f.home, 'actual'), alias = path.join(f.home, 'alias');
  fs.mkdirSync(actual); fs.symlinkSync(actual, alias, linkType); write(path.join(actual, A), 'result.txt');
  const service = createConversationWorkspaces({ ...f.options, scratchBaseDir: alias });
  assert.throws(() => service.resolveWorkspace({ conversationId: A, workingDir: path.join(actual, A) }), /工作目录重合/);
  assert.equal(fs.existsSync(path.join(actual, A, 'result.txt')), true);
  const scratch = f.service.resolveScratch(A); f.setRoot(scratch);
  assert.throws(() => f.service.resolveScratch(B), /其他会话/);
  assert.equal(fs.existsSync(path.join(scratch, B)), false);
});

test('concurrent deletion shares one async operation, blocks reallocation and preserves a different conversation update', async t => {
  const f = fixture(t), a = f.service.resolveScratch(A);
  write(a);
  const originalRm = fs.promises.rm.bind(fs.promises);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  t.mock.method(fs.promises, 'rm', async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return originalRm(...args); });
  const first = f.service.removeScratch(A), second = f.service.removeScratch(A);
  assert.equal(first, second); await ready;
  assert.throws(() => f.service.resolveScratch(A), /正在清理/);
  const b = f.service.resolveScratch(B); write(b);
  release(); await first;
  assert.equal(f.records()[B].scratchDir, b); assert.equal(fs.existsSync(path.join(b, 'keep.txt')), true);
});

test('failed filesystem cleanup retains its mapping for a later retry after preference change and restart', async t => {
  const f = fixture(t), a = f.service.resolveScratch(A); write(a);
  const mocked = t.mock.method(fs.promises, 'rm', async () => { throw Object.assign(new Error('locked fixture'), { code: 'EBUSY' }); });
  await assert.rejects(f.service.removeScratch(A), /locked/);
  assert.equal(f.records()[A].scratchDir, a); assert.equal(f.service.resolveScratch(A), a);
  mocked.mock.restore(); f.setRoot(path.join(f.home, 'other'));
  assert.equal((await createConversationWorkspaces(f.options).removeScratch(A)).removed, true);
  assert.equal(fs.existsSync(a), false);
});

test('scratch registry write failure is reported and never changes output/session history', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.registryPath)); fs.mkdirSync(f.registryPath + '.tmp');
  assert.throws(() => f.service.resolveScratch(A));
  assert.equal(fs.existsSync(f.registryPath), false);
  fs.rmdirSync(f.registryPath + '.tmp');
  assert.equal(f.service.resolveScratch(A), path.join(f.legacy, A));
  assert.deepEqual(Object.keys(f.records()[A]).sort(), ['scratchDir', 'scratchRoot', 'scratchRootReal']);
});

test('failed allocation in a custom root removes its newly created empty folder so retry is not treated as foreign data', t => {
  const f = fixture(t), root = path.join(f.home, 'custom'); f.setRoot(root);
  fs.mkdirSync(path.dirname(f.registryPath)); fs.mkdirSync(f.registryPath + '.tmp');
  assert.throws(() => f.service.resolveScratch(A)); assert.equal(fs.existsSync(path.join(root, A)), false);
  fs.rmdirSync(f.registryPath + '.tmp');
  assert.equal(f.service.resolveScratch(A), path.join(root, A));
});

test('invalid identifiers and relative scratch roots fail before any deletion', async t => {
  const f = fixture(t);
  for (const id of ['../other', '', 'a/b']) assert.throws(() => f.service.removeScratch(id), /对话标识/);
  f.setRoot('relative'); assert.throws(() => f.service.resolveScratch(A), /绝对路径/);
  await assert.rejects(f.service.removeScratch(A), /绝对路径/);
  assert.equal(fs.existsSync(f.legacy), false);
});

test('availability guard runs before resolver filesystem work and does not block authorized deletion', async t => {
  const f = fixture(t), a = f.service.resolveScratch(A); write(a);
  const blocked = createConversationWorkspaces({ ...f.options, assertConversationAvailable: () => { throw new Error('blocked fixture'); } });
  assert.throws(() => blocked.resolveScratch(A), /blocked/);
  assert.throws(() => blocked.resolveWorkspace({ conversationId: B }), /blocked/);
  assert.equal(fs.existsSync(path.join(f.home, 'RelayProjects', B)), false);
  await blocked.removeScratch(A); assert.equal(fs.existsSync(a), false);
});

test('migration copies and verifies nested files, retains output/session metadata and pins the new path across restart', async t => {
  const f = fixture(t), workspace = f.service.resolveWorkspace({ conversationId: A });
  write(workspace.cwd, 'final.txt'); write(workspace.scratchDir);
  write(path.join(workspace.scratchDir, 'nested'), 'input.txt');
  const destination = path.join(f.home, 'different-root');
  f.service.invalidateConversationSession(A, 'old-session');
  const result = await f.service.migrateScratch(A, destination);
  assert.deepEqual(result, { migrated: true, from: workspace.scratchDir, path: path.join(destination, A) });
  assert.equal(fs.existsSync(workspace.scratchDir), false);
  assert.equal(fs.readFileSync(path.join(result.path, 'nested', 'input.txt'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(workspace.cwd, 'final.txt'), 'utf8'), 'fixture');
  assert.equal(f.records()[A].cwd, workspace.cwd);
  assert.equal(f.records()[A].scratchMigration, undefined); assert.equal(f.records()[A].scratchPrevious, undefined);
  const restarted = createConversationWorkspaces(f.options);
  assert.equal(restarted.resolveScratch(A), result.path); assert.equal(restarted.acceptsSession(A, 'old-session'), false);
  assert.equal(fs.readdirSync(destination).filter(name => name.startsWith('.relay-')).length, 0);
});

test('migration preserves external link targets and rebases absolute links within scratch', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target');
  write(path.join(source, 'nested')); const external = path.join(f.home, 'external'); write(external);
  fs.symlinkSync(path.join(source, 'nested'), path.join(source, 'inside-link'), linkType);
  fs.symlinkSync(external, path.join(source, 'outside-link'), linkType);
  const result = await f.service.migrateScratch(A, target);
  assert.equal(result.migrated, true);
  assert.equal(fs.realpathSync(path.join(result.path, 'inside-link')), path.join(result.path, 'nested'));
  assert.equal(fs.realpathSync(path.join(result.path, 'outside-link')), external);
  await f.service.removeScratch(A); assert.equal(fs.existsSync(path.join(external, 'keep.txt')), true);
});

test('internal absolute links through a configured ancestor alias remain valid after migration', async t => {
  const f = fixture(t), actual = path.join(f.home, 'actual'), alias = path.join(f.home, 'alias');
  fs.mkdirSync(actual); fs.symlinkSync(actual, alias, linkType); f.setRoot(path.join(alias, 'scratch'));
  const source = f.service.resolveScratch(A); write(path.join(source, 'nested'));
  fs.symlinkSync(path.join(source, 'nested'), path.join(source, 'inside-alias'), linkType);
  const moved = await f.service.migrateScratch(A, path.join(f.home, 'target'));
  assert.equal(fs.realpathSync(path.join(moved.path, 'inside-alias')), path.join(moved.path, 'nested'));
  assert.equal(fs.existsSync(source), false);
});

test('migration refuses occupied destinations and nested/redirected roots without touching either set of files', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target'); write(source);
  write(path.join(target, A), 'unrelated.txt');
  await assert.rejects(f.service.migrateScratch(A, target), /占用/);
  await assert.rejects(f.service.migrateScratch(A, path.join(source, 'nested-root')), /原过程目录/);
  const alias = path.join(f.home, 'alias'); fs.symlinkSync(target, alias, linkType);
  await assert.rejects(f.service.migrateScratch(A, alias), /链接/);
  assert.equal(f.service.resolveScratch(A), source);
  assert.equal(fs.existsSync(path.join(source, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(target, A, 'unrelated.txt')), true);
});

test('failed copy keeps the old mapping/source and cleans owned staging so migration can retry', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target'); write(source);
  const mock = t.mock.method(fs.promises, 'copyFile', async () => { throw new Error('copy fixture failed'); });
  await assert.rejects(f.service.migrateScratch(A, target), /copy fixture failed/);
  assert.equal(f.service.resolveScratch(A), source); assert.equal(fs.existsSync(path.join(source, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(target, A)), false); assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(f.records()[A].scratchMigration, undefined);
  mock.mock.restore(); assert.equal((await f.service.migrateScratch(A, target)).migrated, true);
});

test('verification catches copy corruption before switching mappings or removing the source', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target'); write(source);
  const original = fs.promises.copyFile.bind(fs.promises);
  t.mock.method(fs.promises, 'copyFile', async (from, to, flags) => { await original(from, to, flags); await fs.promises.writeFile(to, 'corrupt'); });
  await assert.rejects(f.service.migrateScratch(A, target), /校验失败/);
  assert.equal(f.service.resolveScratch(A), source); assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'fixture');
  assert.equal(fs.existsSync(path.join(target, A)), false);
});

test('post-commit source cleanup failure retains a retry ledger across restart and does not undo the new mapping', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target'); write(source);
  const original = fs.promises.rm.bind(fs.promises);
  const mock = t.mock.method(fs.promises, 'rm', async (file, opts) => {
    if (file === source) throw new Error('source fixture locked');
    return original(file, opts);
  });
  const migrated = await f.service.migrateScratch(A, target);
  assert.equal(migrated.migrated, true); assert.equal(migrated.cleanupPending, true);
  assert.equal(f.records()[A].scratchDir, path.join(target, A));
  assert.equal(f.records()[A].scratchPrevious[0].dir, source);
  assert.equal(fs.existsSync(path.join(source, 'keep.txt')), true);
  mock.mock.restore();
  const restarted = createConversationWorkspaces(f.options);
  await restarted.migrateScratch(A, target);
  assert.equal(fs.existsSync(source), false); assert.equal(f.records()[A].scratchPrevious, undefined);
  assert.equal(restarted.resolveScratch(A), path.join(target, A));
});

test('list finds registered and legacy UUID/known hashed directories without allocating missing ones', async t => {
  const f = fixture(t), a = f.service.resolveScratch(A); write(a);
  write(path.join(f.legacy, B));
  const legacyId = 'legacy-fixture', hash = require('node:crypto').createHash('sha256').update(legacyId).digest('hex').slice(0, 32);
  write(path.join(f.legacy, 'conversation-' + hash)); write(path.join(f.legacy, 'unrelated'));
  const found = await f.service.listScratch([legacyId]);
  assert.deepEqual(found.map(item => item.conversationId).sort(), [A, B, legacyId].sort());
  assert.equal(found.find(item => item.conversationId === A).registered, true);
  assert.equal(found.find(item => item.conversationId === B).registered, false);
  assert.equal(Object.keys(f.records()).length, 1);
});

test('registry commit failure after target installation rolls back the owned copy and leaves the source usable', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), target = path.join(f.home, 'target'); write(source);
  const rename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.registryPath && JSON.parse(fs.readFileSync(from, 'utf8')).items[A]?.scratchRoot === target) throw new Error('registry fixture full');
    return rename(from, to);
  });
  await assert.rejects(f.service.migrateScratch(A, target), /registry fixture full/);
  assert.equal(f.service.resolveScratch(A), source);
  assert.equal(fs.readFileSync(path.join(source, 'keep.txt'), 'utf8'), 'fixture');
  assert.equal(fs.existsSync(path.join(target, A)), false);
  assert.equal(f.records()[A].scratchMigration, undefined);
});

test('a restarted migration removes only token-owned unfinished copies before retrying', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), root = path.join(f.home, 'target'); write(source); fs.mkdirSync(root);
  const token = 'a'.repeat(32), stagingDir = path.join(root, '.relay-migrate-' + A + '-' + token), targetDir = path.join(root, A);
  write(stagingDir, 'partial.txt');
  fs.writeFileSync(path.join(stagingDir, '.relay-migration-' + token + '.json'), JSON.stringify({ version: 1, conversationId: A, token, source, target: targetDir }));
  const records = f.records(); records[A].scratchMigration = { token, root, realRoot: root, sourceDir: source, stagingDir, targetDir };
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: records }));
  const restarted = createConversationWorkspaces(f.options);
  const listed = await restarted.listScratch();
  assert.equal(listed.find(item => item.conversationId === A).migrationPending, true);
  assert.equal(listed.find(item => item.conversationId === A).cleanupPending, true);
  assert.equal((await restarted.migrateScratch(A, root)).migrated, true);
  assert.equal(fs.existsSync(stagingDir), false); assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(targetDir, 'keep.txt'), 'utf8'), 'fixture');
  assert.equal(fs.existsSync(path.join(targetDir, 'partial.txt')), false);
});

test('unfinished migration recovery leaves unowned target data and a missing-source copy intact', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), root = path.join(f.home, 'target'); write(source); fs.mkdirSync(root);
  const token = 'b'.repeat(32), stagingDir = path.join(root, '.relay-migrate-' + A + '-' + token), targetDir = path.join(root, A);
  write(targetDir, 'unknown.txt');
  let records = f.records(); records[A].scratchMigration = { token, root, realRoot: root, sourceDir: source, stagingDir, targetDir };
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: records }));
  await assert.rejects(createConversationWorkspaces(f.options).migrateScratch(A, root), /所有权标记/);
  assert.equal(fs.existsSync(path.join(targetDir, 'unknown.txt')), true);
  fs.writeFileSync(path.join(targetDir, '.relay-migration-' + token + '.json'), JSON.stringify({ version: 1, conversationId: A, token, source, target: targetDir }));
  fs.rmSync(source, { recursive: true });
  await assert.rejects(createConversationWorkspaces(f.options).migrateScratch(A, root), /原目录已不可用/);
  assert.equal(fs.existsSync(path.join(targetDir, 'unknown.txt')), true);
});

test('migration blocks a new resolver and competing removal while allowing other conversations to continue', async t => {
  const f = fixture(t), source = f.service.resolveScratch(A), root = path.join(f.home, 'target'); write(source);
  const original = fs.promises.copyFile.bind(fs.promises);
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  t.mock.method(fs.promises, 'copyFile', async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return original(...args); });
  const migration = f.service.migrateScratch(A, root); await ready;
  assert.throws(() => f.service.resolveScratch(A), /迁移/);
  await assert.rejects(f.service.removeScratch(A), /迁移/);
  assert.equal(f.service.migrateScratch(A, root), migration);
  const b = f.service.resolveScratch(B); assert.equal(fs.existsSync(b), true);
  release(); await migration;
  assert.equal(f.records()[B].scratchDir, b);
});

test('Windows native migration crosses C and D volumes without blocking the event loop', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), source = f.service.resolveScratch(A);
  const base = path.resolve(__dirname, '../.codex-tmp/scratch-lifecycle-2026-10-11'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'cross-volume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (path.parse(source).root.toLowerCase() === path.parse(root).root.toLowerCase()) { t.skip('fixture does not span different volumes'); return; }
  fs.writeFileSync(path.join(source, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 37));
  let ticks = 0; const interval = setInterval(() => { ticks++; }, 1); t.after(() => clearInterval(interval));
  const result = await f.service.migrateScratch(A, root); clearInterval(interval);
  assert.equal(result.migrated, true); assert.ok(ticks > 0, 'copy and verification yield to the main event loop');
  assert.equal(fs.statSync(path.join(result.path, 'large.bin')).size, 8 * 1024 * 1024);
  assert.equal(fs.existsSync(source), false);
});

test('UUID case variants reuse persisted custom-root mappings and share the same deletion lock', async t => {
  const f = fixture(t), lower = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', upper = lower.toUpperCase();
  const root = path.join(f.home, 'custom'), original = path.join(root, lower); write(original);
  fs.mkdirSync(path.dirname(f.registryPath), { recursive: true });
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: { [upper]: { scratchRoot: root, scratchDir: original, scratchRootReal: root } } }));
  f.setRoot(path.join(f.home, 'other'));
  const restarted = createConversationWorkspaces(f.options);
  assert.equal(restarted.resolveScratch(lower), original); assert.equal(restarted.resolveScratch(upper), original);
  const first = restarted.removeScratch(upper), second = restarted.removeScratch(lower);
  assert.equal(first, second); await first;
  assert.equal(fs.existsSync(original), false); assert.equal(f.records()[upper], undefined);
});

test('conflicting UUID case variants fail closed instead of losing a custom-root mapping', t => {
  const f = fixture(t), lower = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  fs.mkdirSync(path.dirname(f.registryPath), { recursive: true });
  const first = { scratchRoot: path.join(f.home, 'one'), scratchDir: path.join(f.home, 'one', lower) };
  const second = { scratchRoot: path.join(f.home, 'two'), scratchDir: path.join(f.home, 'two', lower) };
  fs.writeFileSync(f.registryPath, JSON.stringify({ version: 1, items: { [lower]: first, [lower.toUpperCase()]: second } }));
  assert.throws(() => f.service.resolveScratch(lower), /索引存在冲突/);
  assert.throws(() => f.service.resolveScratch(lower), /索引存在冲突/);
});

test('a registered but absent source moves its empty allocation to the new root instead of recreating the old one', async t => {
  const f = fixture(t), old = f.service.resolveScratch(A), root = path.join(f.home, 'new');
  fs.rmdirSync(old); f.setRoot(root);
  const migrated = await f.service.migrateScratch(A);
  assert.equal(migrated.migrated, true); assert.equal(migrated.missing, true);
  assert.equal(migrated.path, path.join(root, A)); assert.equal(fs.existsSync(old), false);
  assert.equal(createConversationWorkspaces(f.options).resolveScratch(A), path.join(root, A));
});
