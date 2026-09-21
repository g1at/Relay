'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { MemoryStore } = require('../memory-store');
const { memoryEligibility, serializeMemoryFrontmatter } = require('../memory-schema');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section is present: ${start}`);
  return source.slice(from, to);
}

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ dir });
  const handlers = new Map(), usage = {}, revealed = [];
  const context = vm.createContext({
    fs, path, Buffer, console,
    MEMORY_DIR: dir, MEMORY_INDEX: path.join(dir, 'MEMORY.md'), relayMemoryStore: store,
    readMemoryUsage: () => usage, memoryReadStats: () => ({ readCount: 2, lastReadAt: '2026-01-01T00:00:00Z' }),
    memoryEligibility, refreshSkillUsageInBackground: () => Promise.resolve(), flushMemoryUsage: () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: (file) => revealed.push(file) },
  });
  const indexLine = between(mainSource, 'function memoryIndexLine(', 'function memoryQueryTerms(');
  const index = between(mainSource, 'function rebuildMemoryIndex(', '// 注入预算上限(#2)');
  const ipc = between(mainSource, '// IPC: 长期记忆库管理', '// IPC: 探测环境');
  vm.runInContext(`${indexLine}\n${index}\n${ipc}`, context, { filename: 'main-memory-ipc-extract.js' });
  const memoryStart = preloadSource.indexOf('  memory: {');
  const memoryEnd = preloadSource.indexOf('\n  },', memoryStart) + '\n  },'.length;
  assert.ok(memoryStart >= 0 && memoryEnd > memoryStart);
  const exposed = vm.runInNewContext(`({${preloadSource.slice(memoryStart, memoryEnd)}})`, {
    ipcRenderer: { invoke: async (name, ...args) => {
      assert.ok(handlers.has(name), `IPC is registered: ${name}`);
      return handlers.get(name)({}, ...args);
    } },
  });
  return { dir, store, usage, revealed, api: exposed.memory, context, handlers };
}

test('real preload and memory IPC preserve revisions and reject stale saves', async (t) => {
  const { api } = harness(t);
  const created = await api.write('fact.md', 'first version', null);
  assert.equal(created.ok, true);
  assert.match(created.revision, /^[a-f0-9]{64}$/);
  const read = await api.read('fact.md');
  assert.equal(read.content, 'first version');
  assert.equal(read.revision, created.revision);
  const saved = await api.write('fact.md', 'second version', read.revision);
  assert.equal(saved.ok, true);
  const stale = await api.write('fact.md', 'stale overwrite', read.revision);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'MEMORY_CONFLICT');
  assert.equal((await api.read('fact.md')).content, 'second version');
  const listed = await api.list();
  assert.equal(listed.items[0].revision, saved.revision);
  assert.equal(listed.items[0].status, 'active');
});

test('removed memory has a UI-visible restorable history and retains its pin metadata', async (t) => {
  const { api, handlers, usage } = harness(t);
  const created = await api.write('removed.md', 'recoverable', null);
  await api.setPinned('removed.md', true);
  const removed = await api.remove('removed.md', created.revision);
  assert.equal(removed.ok, true);
  assert.equal(removed.archived, true);
  assert.equal((await api.list()).items.length, 0);
  assert.equal(usage['removed.md'].pinned, true);
  const archived = await api.archived();
  assert.equal(archived.items[0].file, 'removed.md');
  assert.equal(archived.items[0].meta.status, 'active');
  assert.equal(archived.items[0].versionId, removed.versionId);
  const archivedRows = await api.list({ archived: true });
  assert.equal(archivedRows.items[0].status, 'archived');
  assert.equal(archivedRows.items[0].archived, true);
  const history = await api.history('removed.md');
  assert.ok(history.items.some((item) => item.versionId === removed.versionId && item.archived));
  assert.equal((await api.restore('removed.md', removed.versionId, null)).ok, true);
  assert.equal((await api.archived()).items.length, 0);
  assert.equal((await api.list()).items[0].pinned, true);
  // Existing callers that send a filename to the IPC directly remain supported.
  assert.equal(handlers.get('memory:remove')({}, 'removed.md').ok, true);
});

test('restoring removed and edited versions never overwrites an unexpected current revision', async (t) => {
  const { api } = harness(t);
  await api.write('item.md', 'v1');
  const edited = await api.write('item.md', 'v2');
  const archived = await api.remove('item.md');
  const recreated = await api.write('item.md', 'new live content', null);
  const conflict = await api.restore('item.md', archived.versionId, null);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'MEMORY_CONFLICT');
  assert.equal((await api.read('item.md')).content, 'new live content');
  assert.equal((await api.restore('item.md', edited.versionId, recreated.revision)).ok, true);
  assert.equal((await api.read('item.md')).content, 'v1');
});

test('approval IPC enforces proposal revision validation and retires the confirmed original', async (t) => {
  const { api, store } = harness(t);
  await api.write('original.md', 'original');
  const proposal = store.write('original.md', 'new candidate', { actor: 'model' });
  assert.equal((await api.setStatus(proposal.file, 'active', 'stale')).code, 'MEMORY_CONFLICT');
  const approved = await api.setStatus(proposal.file, 'active', proposal.revision);
  assert.equal(approved.ok, true);
  assert.equal((await api.read('original.md')).meta.status, 'superseded');
  assert.equal((await api.read(proposal.file)).meta.status, 'active');
});

test('index uses governed YAML metadata and caller project scope while legacy memories remain visible', async (t) => {
  const { api, store, dir, context } = harness(t);
  await api.write('legacy.md', 'legacy fact');
  await api.write('a.md', `${serializeMemoryFrontmatter({ scope: 'project', projectId: 'a', name: 'project-a' })}\nA`);
  await api.write('b.md', `${serializeMemoryFrontmatter({ scope: 'project', projectId: 'b', name: 'project-b' })}\nB`);
  await api.write('inferred.md', '---\nstatus: active\nconfidence: inferred\n---\ninferred');
  fs.writeFileSync(path.join(dir, 'malformed.md'), '---\nstatus: active\nstatus: draft\n---\ninvalid');
  const scoped = context.rebuildMemoryIndex({ projectId: 'a' });
  assert.equal(scoped.entries.length, 2);
  assert.ok(scoped.entries.some((item) => item.file === 'a.md'));
  assert.ok(scoped.entries.some((item) => item.file === 'legacy.md'));
  const generated = await api.read('MEMORY.md');
  assert.equal(generated.ok, true);
  assert.equal(generated.generated, true);
  assert.match(generated.content, /project-a/);
  assert.match(generated.content, /project-b/);
  assert.doesNotMatch(generated.content, /inferred|malformed/);
  assert.throws(() => store.read('MEMORY.md', { actor: 'model' }), (error) => error.code === 'MEMORY_INDEX');
  assert.equal((await api.write('MEMORY.md', 'forged')).code, 'MEMORY_INDEX');
});

test('all filename-based UI actions reject path traversal instead of silently using its basename', async (t) => {
  const { api, revealed } = harness(t);
  await api.write('fact.md', 'protected');
  for (const action of [() => api.read('../fact.md'), () => api.write('../fact.md', 'bad'),
    () => api.remove('../fact.md'), () => api.setPinned('../fact.md', true),
    () => api.history('../fact.md'), () => api.revealFile('../fact.md')]) {
    const result = await action();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MEMORY_PATH');
  }
  assert.equal(revealed.length, 0);
  assert.equal((await api.read('fact.md')).content, 'protected');
});
