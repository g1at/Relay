'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const workspaces = require('../src/main/projects/conversation-workspaces');
const { createProjectStore } = require('../src/main/projects/project-store');
const { registerWorkspaceTools } = require('../src/main/workspace/workspace-tools');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const ID = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
function fixture(t, { draft = false, projectless = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browse-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dirs = ['alpha', 'beta', 'native-worktree'].map(name => { const value = path.join(home, name); fs.mkdirSync(value); return value; });
  const registryPath = path.join(home, 'workspace-registry.json'), historyPath = path.join(home, ID + '.json');
  let reads = 0, blocked = false, checks = 0;
  const saved = { id: ID, mode: 'plain', workingDir: projectless ? null : { path: dirs[0] }, turns: [{ user: 'Synthetic fixture' }] };
  if (!draft) fs.writeFileSync(historyPath, JSON.stringify(saved));
  const loadConversation = id => { reads++; return id === ID && fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : null; };
  const assertConversationAvailable = () => { checks++; if (blocked) throw Error('fixture deletion or migration barrier'); };
  const options = { homeDir: home, registryPath, loadConversation, assertConversationAvailable,
    persistConversationRecord: () => { throw Error('Unexpected history write'); }, scratchBaseDir: path.join(home, 'scratch') };
  const service = workspaces.createConversationWorkspaces(options);
  const store = createProjectStore({ filePath: path.join(home, 'projects.json') });
  const projects = dirs.slice(0, 2).map(dir => store.add(dir));
  if (!draft) store.bind(ID, projectless ? null : projects[0].id);
  const liveSessions = new Map();
  const context = { fs, path, ...workspaces, WORKSPACE_UUID: workspaces.UUID, assertConversationAvailable,
    convFilePath: () => historyPath, loadConversation, liveSessions, getProjectStore: () => store,
    getConversationWorkspaces: () => service };
  vm.createContext(context);
  const start = source.indexOf('function resolveExecutionWorkspace('), end = source.indexOf('const workspaceTools =', start);
  vm.runInContext(source.slice(start, end), context);
  return { home, dirs, registryPath, historyPath, options, service, store, projects, liveSessions, context,
    browse: input => context.resolveWorkspaceForTools({ conversationId: ID, ...input }),
    link: input => context.resolveLinkWorkspace({ conversationId: ID, ...input }),
    reset: () => { reads = 0; checks = 0; }, get reads() { return reads; }, get checks() { return checks; },
    block: () => { blocked = true; } };
}

test('actual root plus five expanded directory IPC requests read zero histories and no unrelated ownership paths', async t => {
  const f = fixture(t), first = f.browse();
  const paths = ['', 'one', 'two', 'three', 'four', 'five'];
  for (const name of paths.slice(1)) fs.mkdirSync(path.join(first.root, name));
  f.service.resolveWorkspace({ conversationId: OTHER, workingDir: f.dirs[1], projectId: f.projects[1].id });
  const handlers = new Map(), sender = { isDestroyed: () => false };
  sender.mainFrame = { url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href };
  const instance = registerWorkspaceTools({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindow: () => ({ webContents: sender, isDestroyed: () => false }), resolveWorkspace: f.context.resolveWorkspaceForTools, shell: {} });
  t.after(() => instance.dispose());
  const realpath = fs.realpathSync, touched = [];
  fs.realpathSync = Object.assign(value => { touched.push(String(value)); return realpath(value); }, realpath);
  f.reset();
  try {
    for (const relative of paths) {
      const result = await handlers.get('workspace:list')({ sender, senderFrame: sender.mainFrame }, { context: { conversationId: ID }, path: relative });
      assert.equal(result.ok, true);
    }
  } finally { fs.realpathSync = realpath; }
  assert.equal(f.reads, 0); assert.ok(f.checks >= paths.length);
  assert.ok(touched.length > 0);
  assert.ok(touched.every(value => !value.includes(OTHER) && value !== f.dirs[1]), 'browsing must not scan another workspace owner');
});

test('legacy registrations warm once, survive restart, and keep browsing read-only', t => {
  const f = fixture(t); f.service.resolveWorkspace({ conversationId: ID, workingDir: f.dirs[0] }); f.reset();
  f.browse(); assert.ok(f.reads > 0); f.reset();
  const before = fs.readFileSync(f.registryPath, 'utf8');
  for (let i = 0; i < 6; i++) f.browse();
  assert.equal(f.reads, 0); assert.equal(fs.readFileSync(f.registryPath, 'utf8'), before);
  const restarted = workspaces.createConversationWorkspaces(f.options);
  assert.equal(restarted.resolveBrowseWorkspace({ conversationId: ID, projectId: f.projects[0].id, projectDirectory: f.dirs[0] }).root, f.dirs[0]);
  assert.equal(f.reads, 0);
});

test('draft project changes and saved project rebinding never reuse an obsolete scope', t => {
  const f = fixture(t, { draft: true });
  assert.equal(f.browse({ projectId: f.projects[0].id }).root, f.dirs[0]); f.reset();
  assert.equal(f.browse({ projectId: f.projects[0].id }).root, f.dirs[0]); assert.equal(f.reads, 0);
  assert.equal(f.browse({ projectId: f.projects[1].id }).root, f.dirs[1]);
  f.store.bind(ID, f.projects[0].id); f.reset();
  assert.equal(f.browse({ projectId: f.projects[1].id, workingDir: f.dirs[1] }).root, f.dirs[0]);
  f.reset(); f.browse({ projectId: f.projects[1].id, workingDir: f.dirs[1] }); assert.equal(f.reads, 0);
  f.store.bind(ID, null, { force: true });
  const detached = f.browse({ projectId: f.projects[1].id, workingDir: f.dirs[1] });
  assert.equal(detached.managed, true); assert.notEqual(detached.root, f.dirs[0]); assert.notEqual(detached.root, f.dirs[1]);
});

test('deletion and migration barriers are consulted on every warmed request', t => {
  const f = fixture(t); f.browse(); f.reset(); f.block();
  assert.throws(() => f.browse(), /barrier/); assert.equal(f.reads, 0); assert.equal(f.checks, 1);
});

test('project directory becoming a different canonical target cannot reuse registration', t => {
  const f = fixture(t); f.browse(); f.reset();
  fs.renameSync(f.dirs[0], f.dirs[0] + '-original');
  fs.symlinkSync(f.dirs[1], f.dirs[0], process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.browse(), /位置已改变/); assert.equal(f.reads, 0);
});

test('managed cwd, outputs and scratch links remain rejected without full history reads', t => {
  for (const key of ['cwd', 'outputDir', 'scratchDir', 'scratchRoot']) {
    const f = fixture(t, { projectless: true }), first = f.browse();
    const registry = JSON.parse(fs.readFileSync(f.registryPath, 'utf8')).items[ID];
    const target = registry[key]; assert.ok(target, key);
    fs.renameSync(target, target + '-original');
    fs.symlinkSync(f.dirs[1], target, process.platform === 'win32' ? 'junction' : 'dir');
    f.reset(); assert.throws(() => f.browse(), /链接|真实|改变/); assert.equal(f.reads, 0, key);
  }
});

test('pending scratch migration and malformed owner path fail closed', t => {
  for (const change of [item => { item.scratchMigration = { stage: 'copying' }; }, item => { item.scratchDir = path.join(item.scratchRoot, OTHER); }]) {
    const f = fixture(t); f.browse();
    const registry = JSON.parse(fs.readFileSync(f.registryPath, 'utf8')); change(registry.items[ID]);
    fs.writeFileSync(f.registryPath, JSON.stringify(registry));
    const restarted = workspaces.createConversationWorkspaces(f.options); f.reset();
    assert.throws(() => restarted.resolveBrowseWorkspace({ conversationId: ID, projectId: f.projects[0].id, projectDirectory: f.dirs[0] }), /迁移|不属于/);
    assert.equal(f.reads, 0);
  }
});

test('forks keep shared outputs, separate scratch and invalidation removes an old browsing scope', t => {
  const f = fixture(t, { projectless: true }), original = f.browse();
  const fork = f.service.resolveWorkspace({ conversationId: OTHER, workingDir: original.cwd, projectId: null });
  f.reset(); const resolved = f.service.resolveBrowseWorkspace({ conversationId: OTHER, projectId: null });
  assert.equal(resolved.outputDir, original.outputDir); assert.equal(resolved.scratchDir, fork.scratchDir);
  assert.notEqual(resolved.scratchDir, original.scratchDir); assert.equal(f.reads, 0);
  f.service.invalidateConversationSession(OTHER, 'old-session');
  assert.equal(f.service.resolveBrowseWorkspace({ conversationId: OTHER, projectId: null }), null);
});

test('trusted SDK worktree browsing stays within its current launch binding and pins canonical paths', t => {
  const f = fixture(t); f.browse();
  const live = { dead: false, workspaceRoot: f.dirs[2], launchSpec: { projectId: f.projects[0].id, cwd: f.dirs[0] } };
  f.liveSessions.set(ID, live); f.reset(); assert.equal(f.browse().root, f.dirs[2]); assert.equal(f.reads, 0);
  live.launchSpec.projectId = f.projects[1].id; assert.equal(f.browse().root, f.dirs[0]);
  live.launchSpec.projectId = f.projects[0].id;
  fs.renameSync(f.dirs[2], f.dirs[2] + '-original');
  fs.symlinkSync(f.dirs[1], f.dirs[2], process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.browse(), /真实文件夹/);
});


test('directory-link IPC keeps registered roots and reads zero histories after one metadata lookup', async t => {
  const f = fixture(t); f.browse();
  const saved = JSON.parse(fs.readFileSync(f.historyPath, 'utf8'));
  saved.sdkSessionContext = { wslDistribution: 'Fixture-WSL' }; fs.writeFileSync(f.historyPath, JSON.stringify(saved));
  f.reset(); const initial = f.link(); assert.equal(f.reads, 1); assert.equal(initial.wslDistribution, 'Fixture-WSL');
  const paths = ['', 'one', 'two', 'three', 'four', 'five'];
  for (const name of paths.slice(1)) fs.mkdirSync(path.join(initial.scratchDir, name));
  const handlers = new Map(), sender = { isDestroyed: () => false };
  sender.mainFrame = { url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href };
  const instance = registerWorkspaceTools({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindow: () => ({ webContents: sender, isDestroyed: () => false }), resolveWorkspace: f.context.resolveWorkspaceForTools,
    resolveLinkWorkspace: f.context.resolveLinkWorkspace, shell: {} });
  t.after(() => instance.dispose()); f.reset();
  for (const relative of paths) {
    const result = await handlers.get('workspace:list')({ sender, senderFrame: sender.mainFrame }, {
      context: { conversationId: ID }, path: relative, directoryLink: { href: initial.scratchDir } });
    assert.equal(result.ok, true);
  }
  assert.equal(f.reads, 0);
  assert.deepEqual(Array.from(vm.runInContext('workspaceLinkMetadata.get("' + ID + '") && Object.keys(workspaceLinkMetadata.get("' + ID + '"))', f.context)).sort(), ['distribution', 'signature']);
});

test('directory links never follow runtime cwd and only matching launch scopes supply live WSL distribution', t => {
  const f = fixture(t); f.browse();
  const saved = JSON.parse(fs.readFileSync(f.historyPath, 'utf8'));
  saved.sdkSessionContext = { wslDistribution: 'Saved-WSL' }; fs.writeFileSync(f.historyPath, JSON.stringify(saved));
  const live = { dead: false, workspaceRoot: f.dirs[2], launchSpec: { cwd: f.dirs[0], projectId: f.projects[0].id, wslDistribution: 'Live-WSL' } };
  f.liveSessions.set(ID, live); f.reset();
  assert.equal(f.browse().root, f.dirs[2]);
  const result = f.link({ roots: [f.dirs[2]], workingDir: f.dirs[2] });
  assert.equal(result.root, f.dirs[0]); assert.equal(result.wslDistribution, 'Live-WSL'); assert.equal(f.reads, 0);
  assert.ok(!result.roots.includes(f.dirs[2]));
  live.launchSpec.projectId = f.projects[1].id;
  assert.equal(f.link().wslDistribution, 'Saved-WSL');
  live.launchSpec.projectId = f.projects[0].id; live.launchSpec.cwd = f.dirs[1];
  assert.equal(f.link().wslDistribution, 'Saved-WSL');
});

test('atomic history replacement invalidates only link metadata and corrupt history never reuses it', t => {
  const f = fixture(t); f.browse(); f.link(); f.reset();
  const saved = JSON.parse(fs.readFileSync(f.historyPath, 'utf8'));
  saved.sdkSessionContext = { wslDistribution: 'New-WSL' };
  fs.writeFileSync(f.historyPath + '.tmp', JSON.stringify(saved)); fs.renameSync(f.historyPath + '.tmp', f.historyPath);
  assert.equal(f.link().wslDistribution, 'New-WSL'); assert.equal(f.reads, 1);
  f.reset(); f.link(); assert.equal(f.reads, 0);
  fs.writeFileSync(f.historyPath, 'invalid JSON');
  assert.throws(() => f.link());
  assert.equal(vm.runInContext('workspaceLinkMetadata.has("' + ID + '")', f.context), false);
  fs.writeFileSync(f.historyPath, JSON.stringify(saved)); f.link(); f.reset(); f.block();
  assert.throws(() => f.link(), /barrier/); assert.equal(f.reads, 0);
});

test('completed scratch migration updates read-only browser roots without scanning histories again', async t => {
  const f = fixture(t); const initial = f.browse();
  const moved = await f.service.migrateScratch(ID, path.join(f.home, 'migrated-scratch'));
  assert.equal(moved.migrated, true); f.reset();
  assert.equal(f.browse().scratchDir, moved.path); assert.notEqual(moved.path, initial.scratchDir); assert.equal(f.reads, 0);
});
