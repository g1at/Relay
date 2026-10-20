'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { listOutputLibrary, nativePath } = require('../src/main/app/output-library');

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-output-library-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const f = value => path.join(root, value);
  async function write(value, content = value) {
    const filename = f(value); await fs.promises.mkdir(path.dirname(filename), { recursive: true });
    await fs.promises.writeFile(filename, content); return filename;
  }
  async function history(id, messages, extra = {}) {
    return write(`history/${id}.json`, JSON.stringify({ id, turns: messages.map(message => typeof message === 'string' ? { output: { final: message } } : message), ...extra }));
  }
  async function log(name, paths, { marker = true, cwd, tool = 'Write' } = {}) {
    const entries = paths.map(file => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: tool, input: { file_path: file } }] } }));
    return write(`projects/project/${name}.jsonl`, (marker ? JSON.stringify({ type: 'user', text: '无交互界面' }) + '\n' : '') + entries.join('\n'));
  }
  const location = (id = 'task', extra = {}) => ({ conversationId: id, cwd: f('workspace'), managed: true, outputDir: f('workspace/outputs'), scratchDir: f('scratch'), previousScratchDirs: [], ...extra });
  const run = extra => listOutputLibrary({ locations: [location()], historyDir: f('history'), projectsDir: f('projects'), typeOf: ext => ext === 'pdf' ? 'pdf' : ext === 'py' ? 'code' : 'document', ...extra });
  return { root, f, write, history, log, location, run };
}
const byName = result => Object.fromEntries(result.items.map(item => [item.name, item]));

test('discovers shell-created outputs and process files without scanning the workspace cwd', async t => {
  const h = await fixture(t);
  await h.write('workspace/outputs/report.pdf'); await h.write('workspace/outputs/assets/table.csv');
  await h.write('scratch/check.py'); await h.write('workspace/unrelated-source.js');
  const result = await h.run(); const items = byName(result);
  assert.equal(result.ok, true); assert.equal(result.truncated, false); assert.deepEqual(result.warnings, []);
  assert.deepEqual(Object.keys(items).sort(), ['check.py', 'report.pdf', 'table.csv']);
  assert.equal(items['report.pdf'].kind, 'output'); assert.equal(items['report.pdf'].type, 'pdf');
  assert.equal(items['check.py'].kind, 'process'); assert.equal(items['check.py'].conversationId, 'task');
  assert.equal(items['table.csv'].dir, h.f('workspace/outputs/assets'));
});

test('registered dedicated outputs are included for forks without scanning a project output root equal to cwd', async t => {
  const h = await fixture(t); await h.write('workspace/outputs/report.pdf'); await h.write('project/source.js');
  const result = await h.run({ locations: [h.location('fork', { managed: false }), h.location('project', { cwd: h.f('project'), outputDir: h.f('project'), scratchDir: null, managed: false })] });
  assert.deepEqual(result.items.map(item => item.name), ['report.pdf']); assert.equal(result.items[0].conversationId, 'fork');
});

test('project and user-directed final links are outputs while drafts and interrupted text are excluded', async t => {
  const h = await fixture(t);
  const delivered = await h.write('project/final.md'); await h.write('project/source.js');
  const specified = await h.write('custom/report.pdf'); const draft = await h.write('project/draft.md');
  await h.history('project-task', [`[report](${delivered}) and [custom](${specified})`, '[source](./source.js:3)',
    { assistant: `[draft](${draft})`, running: true }, { assistant: `[draft](${draft})`, output: { final: '' } }]);
  const result = await h.run({ locations: [h.location('project-task', { cwd: h.f('project'), outputDir: h.f('project'), scratchDir: null, managed: false })] });
  assert.deepEqual(result.items.map(item => item.name).sort(), ['final.md', 'report.pdf', 'source.js']);
  assert.ok(result.items.every(item => item.kind === 'output' && item.conversationId === 'project-task'));
});

test('scratch classification wins over final links, overlapping output roots, and legacy logs', async t => {
  const h = await fixture(t); const process = await h.write('workspace/outputs/tmp/delivered.md');
  const previous = await h.write('old-scratch/old.md'); const output = await h.write('workspace/outputs/real.md');
  await h.history('task', [`[wrong place](${process}) [old place](${previous}) [real](${output})`]);
  await h.log('writes', [process, previous, output]);
  const result = await h.run({ locations: [h.location('task', { scratchDir: h.f('workspace/outputs/tmp'), previousScratchDirs: [h.f('old-scratch')] })] });
  const items = byName(result);
  assert.equal(result.items.length, 3); assert.equal(items['delivered.md'].kind, 'process');
  assert.equal(items['old.md'].kind, 'process'); assert.equal(items['real.md'].kind, 'output');
});

test('classification retains known scratch boundaries beyond location and root enumeration caps', async t => {
  const h = await fixture(t); await h.write('workspace/outputs/hidden/check.py');
  const locations = [h.location('first', { scratchDir: null }), h.location('later', { outputDir: null, scratchDir: h.f('workspace/outputs/hidden') })];
  for (const limits of [{ maxLocations: 1 }, { maxRoots: 1 }]) {
    const result = await h.run({ locations, limits });
    assert.equal(result.truncated, true); assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'process'); assert.equal(result.items[0].conversationId, 'later');
  }
});

test('large registration sets classify a small real library without filesystem work for every omitted root', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 32; i++) await h.write(`workspace/outputs/file-${i}.md`);
  await h.write('workspace/outputs/process/check.py');
  const locations = [h.location('owner', { scratchDir: null }),
    ...Array.from({ length: 2000 }, (_, i) => ({ conversationId: `old-${i}`, scratchDir: h.f(`omitted/scratch-${i}`) })),
    { conversationId: 'late-process-owner', scratchDir: h.f('workspace/outputs/process') }];
  const started = performance.now();
  const result = await h.run({ locations, limits: { maxLocations: 1 } });
  t.diagnostic(JSON.stringify({ registrations: locations.length, realItems: result.items.length, elapsedMs: Math.round((performance.now() - started) * 100) / 100 }));
  assert.equal(result.items.length, 33); assert.equal(result.truncated, true);
  assert.equal(byName(result)['check.py'].kind, 'process'); assert.equal(byName(result)['check.py'].conversationId, 'late-process-owner');
  assert.equal(result.items.filter(item => item.kind === 'output').length, 32);
});

test('explicit final directory links produce openable directory items without recursively scanning projects', async t => {
  const h = await fixture(t); await h.write('custom/bundle/index.html'); await h.write('custom/bundle/assets/image.png');
  await h.history('project', [`[bundle](${h.f('custom/bundle')})`], { workingDir: h.f('custom') });
  const result = await h.run({ locations: [] });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].path, h.f('custom/bundle'));
  assert.equal(result.items[0].isDirectory, true); assert.equal(result.items[0].kind, 'output');
  assert.equal(result.items[0].size, null); assert.equal(result.items[0].type, 'other');
});

test('legacy Write/Edit/NotebookEdit/MultiEdit discoveries stay accessible without being called outputs', async t => {
  const h = await fixture(t);
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'MultiEdit']) {
    const file = await h.write(`project/${tool}.md`); await h.log(tool, [file], { tool });
  }
  const ignored = await h.write('project/unrelated.md'); await h.log('not-relay', [ignored], { marker: false });
  await h.log('relative-without-cwd', ['unknown.md']);
  const result = await h.run();
  assert.equal(result.items.length, 4); assert.ok(result.items.every(item => item.kind === 'legacy'));
  assert.ok(result.warnings.some(warning => warning.code === 'UNRESOLVED_LOG_PATH'));
});

test('legacy paths resolve relative to recorded cwd instead of Relay application cwd', async t => {
  const h = await fixture(t); await h.write('project/report.md');
  await h.log('relative', ['report.md'], { cwd: h.f('project') });
  const result = await h.run(); assert.equal(result.items[0].path, h.f('project/report.md'));
  assert.equal(result.items[0].kind, 'legacy');
});

test('symlink directory and file entries do not escape registered output or history roots', async t => {
  const h = await fixture(t); const outside = await h.write('outside/private.md');
  await fs.promises.mkdir(h.f('workspace/outputs'), { recursive: true });
  await fs.promises.mkdir(h.f('history'), { recursive: true });
  await h.write('outside/history.json', JSON.stringify({ turns: [{ assistant: `[private](${outside})` }] }));
  try {
    await fs.promises.symlink(h.f('outside'), h.f('workspace/outputs/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.promises.symlink(outside, h.f('workspace/outputs/link.md'), 'file');
    await fs.promises.symlink(h.f('outside/history.json'), h.f('history/linked.json'), 'file');
  } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit synthetic file symlinks'); return; } throw error; }
  const result = await h.run(); assert.equal(result.items.length, 0);
  assert.ok(result.warnings.some(warning => warning.code === 'SYMLINK_SKIPPED'));
});

test('Windows junctions and directory symlinks cannot contribute files through nested or registered roots', async t => {
  const h = await fixture(t); await h.write('outside/private.md');
  await fs.promises.mkdir(h.f('workspace/outputs'), { recursive: true });
  try { await fs.promises.symlink(h.f('outside'), h.f('workspace/outputs/escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit synthetic directory links'); return; } throw error; }
  const nested = await h.run(); assert.equal(nested.items.length, 0); assert.ok(nested.warnings.some(w => w.code === 'SYMLINK_SKIPPED'));
  const registered = await h.run({ locations: [h.location('task', { outputDir: h.f('workspace/outputs/escape') })] });
  assert.equal(registered.items.length, 0); assert.ok(registered.warnings.some(w => w.code === 'SYMLINK_SKIPPED'));
});

test('file, depth, directory and entry limits report partial discovery', async t => {
  const h = await fixture(t);
  await h.write('workspace/outputs/one.md'); await h.write('workspace/outputs/two.md'); await h.write('workspace/outputs/deep/three.md');
  const limited = await h.run({ limits: { maxFiles: 1 } }); assert.equal(limited.items.length, 1); assert.equal(limited.truncated, true);
  const shallow = await h.run({ limits: { maxDepth: 0 } }); assert.equal(shallow.items.length, 2); assert.ok(shallow.warnings.some(w => w.code === 'DEPTH_LIMIT'));
  const entries = await h.run({ limits: { maxEntries: 0 } }); assert.equal(entries.items.length, 0); assert.ok(entries.warnings.some(w => w.code === 'ENTRY_LIMIT'));
  const directories = await h.run({ limits: { maxDirectories: 0 } }); assert.equal(directories.items.length, 0); assert.ok(directories.warnings.some(w => w.code === 'DIRECTORY_LIMIT'));
});

test('history and SDK candidates are read newest first within their file caps', async t => {
  const h = await fixture(t);
  const old = await h.write('custom/old.md'), fresh = await h.write('custom/fresh.md');
  const oldHistory = await h.history('old', [`[old](${old})`]), newHistory = await h.history('new', [`[new](${fresh})`]);
  await fs.promises.utimes(oldHistory, 100, 100); await fs.promises.utimes(newHistory, 200, 200);
  await h.write('history/index.json', JSON.stringify({ version: 2, items: [{ id: 'new' }] }));
  const result = await h.run({ limits: { maxHistoryFiles: 1 } });
  assert.deepEqual(result.items.map(item => item.name), ['fresh.md']); assert.equal(result.truncated, true);
  const oldLog = await h.log('old', [old]), newLog = await h.log('new', [fresh]);
  await fs.promises.utimes(oldLog, 100, 100); await fs.promises.utimes(newLog, 200, 200);
  const logs = await h.run({ historyDir: null, limits: { maxLogFiles: 1 } });
  assert.deepEqual(logs.items.map(item => item.name), ['fresh.md']); assert.equal(logs.items[0].kind, 'legacy');
});

test('oversized and aggregate byte-limited sources do not block small existing output discovery', async t => {
  const h = await fixture(t); await h.write('workspace/outputs/keep.pdf');
  const log = await h.log('huge', [await h.write('custom/hidden.md')]);
  await fs.promises.appendFile(log, '\n' + 'x'.repeat(2000));
  const result = await h.run({ limits: { maxFileBytes: 1024 } });
  assert.deepEqual(result.items.map(item => item.name), ['keep.pdf']);
  assert.equal(result.truncated, true); assert.ok(result.warnings.some(w => w.code === 'SOURCE_TOO_LARGE'));
  const aggregate = await h.run({ limits: { maxReadBytes: 10 } });
  assert.deepEqual(aggregate.items.map(item => item.name), ['keep.pdf']); assert.ok(aggregate.warnings.some(w => w.code === 'TOTAL_BYTE_LIMIT'));
});

test('malformed history reports incomplete reading while absent directories are normal', async t => {
  const h = await fixture(t); const absent = await h.run();
  assert.deepEqual(absent, { ok: true, items: [], truncated: false, warnings: [] });
  await h.write('history/broken.json', '{'); const malformed = await h.run();
  assert.ok(malformed.warnings.some(w => w.code === 'INVALID_HISTORY'));
});

test('history without a known cwd retains absolute outputs but never guesses relative link locations', async t => {
  const h = await fixture(t); const delivered = await h.write('custom/absolute.md');
  await h.history('unregistered', [`[relative](./report.md) [absolute](${delivered})`]);
  const result = await h.run({ locations: [] });
  assert.deepEqual(result.items.map(item => item.path), [delivered]);
  assert.ok(result.warnings.some(w => w.code === 'FINAL_LINK_WITHOUT_CWD'));
});

test('only drive mounts are mapped between Windows and WSL paths', () => {
  if (process.platform === 'win32') {
    assert.equal(nativePath('/mnt/d/folder/report.pdf'), 'd:\\folder\\report.pdf');
    assert.equal(nativePath('/home/some-distro/report.pdf'), null);
  } else {
    assert.equal(nativePath('D:\\folder\\report.pdf'), '/mnt/d/folder/report.pdf');
    assert.equal(nativePath('//unknown-share/file'), null);
  }
  assert.equal(nativePath('relative/file'), null); assert.equal(nativePath('bad\0path'), null);
});

function libraryIpc(h, locations) {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
  const start = bootstrap.indexOf("ipcMain.handle('library:listFiles'");
  const end = bootstrap.indexOf('// IPC: 用系统默认程序打开文件', start);
  assert.ok(start >= 0 && end > start, 'production library IPC is present');
  let handler, reads = 0;
  const context = {
    ipcMain: { handle: (name, callback) => { assert.equal(name, 'library:listFiles'); handler = callback; } },
    require: name => { assert.equal(name, './app/output-library'); return { listOutputLibrary }; },
    getConversationWorkspaces: () => ({ listFileLocations: () => { reads++; return locations; },
      resolveWorkspace: () => { throw Error('Library listing must not allocate a workspace'); },
      resolveScratch: () => { throw Error('Library listing must not allocate scratch'); } }),
    getHistoryDir: () => h.f('history'), path, os: { homedir: () => h.f('synthetic-sdk-home') },
    libTypeOf: ext => ext === 'pdf' ? 'pdf' : 'other',
  };
  vm.runInNewContext(bootstrap.slice(start, end), context);
  return { run: () => handler(), reads: () => reads };
}

test('production IPC uses registered locations and real async discovery for shell-created output', async t => {
  const h = await fixture(t); const delivered = await h.write('workspace/outputs/shell-report.pdf');
  await h.write('project/do-not-enumerate.txt');
  const ipc = libraryIpc(h, [h.location()]);
  const result = await ipc.run();
  assert.equal(ipc.reads(), 1); assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(item => item.path), [delivered]);
  assert.equal(result.items[0].type, 'pdf'); assert.equal(result.items[0].kind, 'output');
});

test('production IPC does not allocate workspaces or discover an unregistered cwd when records are absent', async t => {
  const h = await fixture(t); await h.write('workspace/outputs/unregistered.pdf');
  const before = await fs.promises.readdir(h.root);
  const ipc = libraryIpc(h, []); const result = await ipc.run();
  assert.equal(result.ok, true); assert.deepEqual(result.items, []); assert.equal(ipc.reads(), 1);
  assert.deepEqual(await fs.promises.readdir(h.root), before);
});
