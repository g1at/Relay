'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { registerMemoryIpc } = require('../src/main/memory/memory-ipc');
const { memoryEligibility, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');
const { redactMemoryText } = require('../src/main/memory/memory-retrieval');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section is present: ${start}`);
  return source.slice(from, to);
}

function harness(t, { getProjects, getLearningStatus, flushMemoryUsage = () => {}, invalidateMemory, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ dir, now });
  const handlers = new Map(), usage = {}, revealed = [];
  const context = vm.createContext({
    fs, path, Buffer, console, redactMemoryText, getLearningStatus, invalidateMemory,
    MEMORY_DIR: dir, MEMORY_INDEX: path.join(dir, 'MEMORY.md'), relayMemoryStore: store,
    readMemoryUsage: () => usage, memoryReadStats: () => ({ readCount: 2, lastReadAt: '2026-01-01T00:00:00Z' }),
    memoryEligibility, getProjects, refreshSkillUsageInBackground: () => Promise.resolve(), flushMemoryUsage,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: (file) => revealed.push(file) },
  });
  const indexLine = between(mainSource, 'function memoryIndexLine(', '// ── 索引由');
  const index = between(mainSource, 'function rebuildMemoryIndex(', '// 注入预算上限(#2)');
  vm.runInContext(`${indexLine}\n${index}`, context, { filename: 'main-memory-index-extract.js' });
  registerMemoryIpc(context);
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

test('preload and IPC expose bounded recovery actions without arbitrary version history or rollback', async t => {
  const { api, handlers } = harness(t);
  assert.equal(api.history, undefined);
  assert.equal(api.restore, undefined);
  assert.equal(handlers.has('memory:history'), false);
  assert.equal(handlers.has('memory:restore'), false);
  assert.equal(typeof api.undo, 'function');
  assert.equal(typeof api.restoreArchived, 'function');
});

test('bounded recovery IPC forwards only the authorized action parameters', async t => {
  const { api, handlers, store } = harness(t);
  const calls = [];
  store.undo = (file, undoId, options) => {
    calls.push({ action: 'undo', file, undoId, options });
    return { file, revision: 'after-undo' };
  };
  store.restoreArchived = (file, archiveId, options) => {
    calls.push({ action: 'restoreArchived', file, archiveId, options });
    return { file, revision: 'after-restore' };
  };
  store.purgeArchived = (file, options) => {
    calls.push({ action: 'purge', file, options });
    return { file, permanent: true };
  };
  assert.equal((await api.undo('candidate.md', 'approval-token', 'approval-revision')).revision, 'after-undo');
  assert.equal((await api.restoreArchived('removed.md', 'archive-token')).revision, 'after-restore');
  assert.equal((await api.purge('removed.md', 'archive-token')).permanent, true);
  assert.deepEqual(calls, [
    { action: 'undo', file: 'candidate.md', undoId: 'approval-token', options: { actor: 'user', expectedRevision: 'approval-revision' } },
    { action: 'restoreArchived', file: 'removed.md', archiveId: 'archive-token', options: { actor: 'user', expectedRevision: null } },
    { action: 'purge', file: 'removed.md', options: { actor: 'user', expectedArchiveId: 'archive-token' } },
  ]);
  handlers.get('memory:restoreArchived')({}, { file: 'removed.md', archiveId: 'archive-token', actor: 'model', expectedRevision: 'caller-override' });
  assert.deepEqual(calls.at(-1).options, { actor: 'user', expectedRevision: null });
});

test('management IPC exposes source evidence, merge targets and summary-only learning progress', async t => {
  const status = { running: false, lastRun: { ok: true, candidates: 1, processed: 1, summary: '新增 1 条候选' } };
  const { api, store } = harness(t, { getLearningStatus: () => status });
  const source = { kind: 'conversation', conversationId: 'synthetic-chat', turnId: 'run-1', turnIndex: 0,
    role: 'user', quote: 'Use concise summaries.', at: '2026-10-20T01:00:00Z', revision: 'a'.repeat(64) };
  const draft = store.proposeLearning({ file: 'learned.md', name: 'Summary preference', description: 'Summary format',
    type: 'feedback', body: 'Use concise summaries.', sources: [source] });
  const listed = await api.list();
  assert.equal(listed.items[0].status, 'draft');
  assert.equal(listed.items[0].sources[0].conversationId, source.conversationId);
  assert.equal((await api.read(draft.file)).meta.sources[0].quote, source.quote);
  assert.deepEqual(await api.learningStatus(), { ok: true, ...status });
});

test('real preload and memory IPC preserve revisions and reject stale saves', async (t) => {
  const { api } = harness(t);
  const created = await api.write('fact.md', 'first version', null);
  assert.equal(created.ok, true);
  assert.equal(Object.hasOwn(created, 'versionId'), false);
  assert.equal(Object.hasOwn(created, 'undoId'), false);
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

test('removed memory exposes one archive and retains its pin metadata through archive restore', async (t) => {
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
  assert.equal(archived.items[0].archiveId, removed.archiveId);
  const archivedRows = await api.list({ archived: true });
  assert.equal(archivedRows.items[0].status, 'archived');
  assert.equal(archivedRows.items[0].archived, true);
  const archivedCheck = await api.check({ archived: true });
  assert.equal(archivedCheck.archived, true);
  assert.equal(archivedCheck.summary.inactive, 1);
  assert.equal(archivedCheck.items[0].health.label, '已归档');
  assert.equal(archivedRows.items[0].archiveId, removed.archiveId);
  assert.equal(Object.hasOwn(archivedRows.items[0], 'versionId'), false);
  assert.equal((await api.restoreArchived('removed.md', removed.archiveId)).ok, true);
  assert.equal((await api.archived()).items.length, 0);
  assert.equal((await api.list()).items[0].pinned, true);
  // Existing callers that send a filename to the IPC directly remain supported.
  assert.equal(handlers.get('memory:remove')({}, 'removed.md').ok, true);
});

test('permanent removal through the real preload erases only the archived memory, leaving the chat intact', async t => {
  let flushes = 0; const invalidated = [];
  const { api, dir, usage } = harness(t, { flushMemoryUsage: () => { flushes++; }, invalidateMemory: file => invalidated.push(file) });
  const chatPath = path.join(dir, 'original-conversation.json');
  const chat = JSON.stringify({ id: 'source-chat', turns: [{ user: 'Keep this original conversation.' }] });
  fs.writeFileSync(chatPath, chat);
  const first = await api.write('forget.md', 'old memory', null);
  const second = await api.write('forget.md', 'new memory', first.revision);
  const other = await api.write('keep.md', 'unrelated memory', null);
  usage['forget.md'] = { pinned: true, exposureCount: 3 };
  usage['keep.md'] = { pinned: false, exposureCount: 7 };
  const archived = await api.remove('forget.md', second.revision);
  assert.equal((await api.archived()).items.length, 1);
  const purged = await api.purge('forget.md', archived.archiveId);
  assert.equal(purged.ok, true); assert.equal(purged.permanent, true);
  assert.equal((await api.archived()).items.length, 0);
  assert.equal(fs.existsSync(path.join(dir, '.history')), false);
  assert.equal((await api.read('forget.md')).ok, false);
  assert.equal((await api.restoreArchived('forget.md', archived.archiveId)).ok, false);
  assert.equal(Object.hasOwn(usage, 'forget.md'), false); assert.equal(flushes, 1);
  assert.deepEqual(invalidated, ['forget.md']);
  assert.equal(usage['keep.md'].exposureCount, 7);
  assert.equal((await api.read('keep.md')).revision, other.revision);
  assert.equal((await api.read('keep.md')).content, 'unrelated memory');
  assert.equal(fs.readFileSync(chatPath, 'utf8'), chat);
});

test('permanent removal refuses a restored memory, stale or missing archive ID and unsafe filename', async t => {
  const { api, usage } = harness(t);
  const made = await api.write('fact.md', 'original', null);
  const first = await api.remove('fact.md', made.revision);
  usage['fact.md'] = { pinned: true };
  const restored = await api.restoreArchived('fact.md', first.archiveId);
  assert.equal((await api.purge('fact.md', first.archiveId)).ok, false);
  assert.equal((await api.read('fact.md')).content, 'original');
  const second = await api.remove('fact.md', restored.revision);
  for (const archiveId of [undefined, first.archiveId, 'invented']) {
    const result = await api.purge('fact.md', archiveId);
    assert.equal(result.ok, false); assert.equal(result.code, 'MEMORY_CONFLICT');
  }
  assert.equal((await api.purge('../fact.md', second.archiveId)).ok, false);
  assert.equal((await api.purge('MEMORY.md', second.archiveId)).ok, false);
  assert.equal(usage['fact.md'].pinned, true);
  assert.equal((await api.archived()).items[0].archiveId, second.archiveId);
  assert.equal((await api.purge('fact.md', second.archiveId)).ok, true);
});

test('a statistics refresh error cannot misreport a completed irreversible purge as a failed deletion', async t => {
  const { api } = harness(t, { flushMemoryUsage: () => { throw Error('synthetic unavailable statistics'); } });
  const made = await api.write('fact.md', 'content', null);
  const archived = await api.remove('fact.md', made.revision);
  const result = await api.purge('fact.md', archived.archiveId);
  assert.equal(result.ok, true); assert.match(result.warning, /已永久删除/);
  assert.equal((await api.archived()).items.length, 0);
  assert.equal((await api.read('fact.md')).ok, false);
});

test('real bootstrap metadata writers surface strict purge refresh failures instead of swallowing them', async t => {
  const context = vm.createContext({ _memoryUsageFlushTimer: null, clearTimeout,
    MEMORY_DIR: '/synthetic', console: { warn() {} }, fs: { mkdirSync() { throw Error('synthetic disk failure'); } } });
  vm.runInContext(between(mainSource, 'function flushMemoryUsage(', 'function scheduleMemoryUsageFlush('), context);
  assert.doesNotThrow(() => context.flushMemoryUsage());
  assert.throws(() => context.flushMemoryUsage({ strict: true }), /synthetic disk failure/);
  const { api, store } = harness(t);
  const made = await api.write('fact.md', 'content', null);
  const archived = await api.remove('fact.md', made.revision);
  store.writeIndex = () => { throw Error('synthetic index failure'); };
  const result = await api.purge('fact.md', archived.archiveId);
  assert.equal(result.ok, true); assert.match(result.warning, /索引刷新失败/);
  assert.equal((await api.archived()).items.length, 0);
  assert.equal((await api.read('fact.md')).ok, false);
});

test('archive restore cannot overwrite an existing memory or accept caller revision overrides', async (t) => {
  const { api, handlers } = harness(t);
  await api.write('item.md', 'v1');
  await api.write('item.md', 'v2');
  const archived = await api.remove('item.md');
  const recreated = await api.write('item.md', 'new live content', null);
  const conflict = await api.restoreArchived('item.md', archived.archiveId);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'MEMORY_CONFLICT');
  const forged = handlers.get('memory:restoreArchived')({}, { file: 'item.md', archiveId: archived.archiveId, expectedRevision: recreated.revision });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'MEMORY_CONFLICT');
  assert.equal((await api.read('item.md')).content, 'new live content');
});

test('approval IPC enforces proposal revision validation and retires the confirmed original', async (t) => {
  const { api, store } = harness(t);
  await api.write('original.md', 'original');
  const proposal = store.write('original.md', 'new candidate', { actor: 'model', memoryType: 'reference' });
  assert.equal((await api.setStatus(proposal.file, 'active', 'stale')).code, 'MEMORY_CONFLICT');
  const approved = await api.setStatus(proposal.file, 'active', proposal.revision);
  assert.equal(approved.ok, true);
  assert.equal(typeof approved.undoId, 'string');
  assert.ok(approved.undoId.length > 0);
  assert.ok(Number.isFinite(Date.parse(approved.undoExpiresAt)));
  assert.equal(Object.hasOwn(approved, 'versionId'), false);
  assert.equal((await api.read('original.md')).meta.status, 'superseded');
  assert.equal((await api.read(proposal.file)).meta.status, 'active');
  const undone = await api.undo(proposal.file, approved.undoId, approved.revision);
  assert.equal(undone.ok, true);
  assert.equal((await api.read('original.md')).meta.status, 'active');
  assert.equal((await api.read('original.md')).content, 'original');
  assert.equal((await api.read(proposal.file)).meta.status, 'draft');
  assert.equal((await api.undo(proposal.file, approved.undoId, approved.revision)).code, 'MEMORY_UNDO_EXPIRED', 'undo tokens are consumed once');
});

test('only the most recent approval or dismissal is undoable and the token expires after five minutes', async t => {
  let clock = Date.parse('2026-10-22T01:00:00Z');
  const { api } = harness(t, { now: () => clock });
  const content = file => `${serializeMemoryFrontmatter({ name: file, status: 'draft', confidence: 'inferred' })}\nCandidate ${file}.\n`;
  const first = await api.write('first.md', content('first'), null);
  const second = await api.write('second.md', content('second'), null);
  const approved = await api.setStatus('first.md', 'active', first.revision);
  const dismissed = await api.setStatus('second.md', 'expired', second.revision);
  assert.equal(approved.ok, true);
  assert.equal(dismissed.ok, true);
  assert.equal(Date.parse(dismissed.undoExpiresAt), clock + 5 * 60 * 1000);
  assert.equal((await api.undo('first.md', approved.undoId, approved.revision)).code, 'MEMORY_CONFLICT', 'a later review replaces the previous undo');
  assert.equal((await api.undo('second.md', dismissed.undoId, dismissed.revision)).ok, true);
  assert.equal((await api.read('second.md')).meta.status, 'draft');
  const fresh = await api.read('second.md');
  const dismissedAgain = await api.setStatus('second.md', 'expired', fresh.revision);
  clock += 5 * 60 * 1000 + 1;
  assert.equal((await api.undo('second.md', dismissedAgain.undoId, dismissedAgain.revision)).code, 'MEMORY_UNDO_EXPIRED', 'expired undo cannot change the memory');
  assert.equal((await api.read('first.md')).meta.status, 'active');
  assert.equal((await api.read('second.md')).meta.status, 'expired');
});

test('undo cannot overwrite a memory edited after review or undo another memory', async t => {
  const { api } = harness(t);
  const draft = `${serializeMemoryFrontmatter({ status: 'draft', confidence: 'inferred' })}\nCandidate.\n`;
  const created = await api.write('candidate.md', draft, null);
  await api.write('other.md', 'Unrelated memory.', null);
  const approved = await api.setStatus('candidate.md', 'active', created.revision);
  assert.equal((await api.undo('other.md', approved.undoId, approved.revision)).code, 'MEMORY_CONFLICT');
  assert.equal((await api.undo('candidate.md', approved.undoId, 'stale')).code, 'MEMORY_CONFLICT');
  const edited = await api.write('candidate.md', 'Newer user edit.', approved.revision);
  assert.equal(edited.ok, true);
  assert.equal((await api.undo('candidate.md', approved.undoId, approved.revision)).code, 'MEMORY_UNDO_EXPIRED');
  assert.equal((await api.read('candidate.md')).revision, edited.revision);
  assert.equal((await api.read('candidate.md')).content, 'Newer user edit.');
  assert.equal((await api.read('other.md')).content, 'Unrelated memory.');
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
    () => api.undo('../fact.md', 'invalid', 'stale'), () => api.restoreArchived('../fact.md', 'invalid'),
    () => api.purge('../fact.md', 'invalid'), () => api.revealFile('../fact.md')]) {
    const result = await action();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MEMORY_PATH');
  }
  assert.equal(revealed.length, 0);
  assert.equal((await api.read('fact.md')).content, 'protected');
});

test('list, check and detail expose old-data problems without changing source files or approvals', async (t) => {
  const { api, store, dir, handlers } = harness(t, { getProjects: () => [{ id: 'known' }] });
  const source = {
    'legacy.md': '---\nname: old format\n---\nLegacy body.\n',
    'malformed.md': '---\ndescription: "overview" means a summary\nscope: project\n---\nBroken metadata.\n',
    'missing-project.md': '---\nscope: project\n---\nMissing project ID.\n',
    'orphan.md': `${serializeMemoryFrontmatter({ scope: 'project', projectId: 'removed' })}\nOrphan.\n`,
    'project.md': `${serializeMemoryFrontmatter({ scope: 'project', projectId: 'known' })}\nKnown project.\n`,
    'draft.md': `${serializeMemoryFrontmatter({ status: 'draft', confidence: 'inferred' })}\nCandidate.\n`,
    'expired.md': `${serializeMemoryFrontmatter({ expiresAt: '2000-01-01T00:00:00Z' })}\nExpired.\n`,
    'superseded.md': `${serializeMemoryFrontmatter({ status: 'superseded' })}\nOld.\n`,
  };
  for (const [file, content] of Object.entries(source)) fs.writeFileSync(path.join(dir, file), content);
  const before = Object.fromEntries(Object.keys(source).map((file) => [file, store.read(file).revision]));
  const listed = await api.list();
  const checked = handlers.get('memory:check')({}, {});
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.summary, { total: 8, active: 2, draft: 1, inactive: 2, invalid: 3, legacy: 2 });
  assert.deepEqual(listed.summary, checked.summary);
  assert.ok(Number.isFinite(Date.parse(checked.checkedAt)));
  assert.equal(checked.projectCheck.available, true);
  const byFile = Object.fromEntries(checked.items.map((item) => [item.file, item]));
  assert.equal(byFile['project.md'].eligible, true, 'management pages do not need a current project');
  assert.equal(byFile['legacy.md'].health.legacy, true);
  assert.equal(byFile['malformed.md'].health.issues[0].code, 'invalid_frontmatter');
  assert.equal(byFile['missing-project.md'].health.issues[0].code, 'missing_project_id');
  assert.equal(byFile['orphan.md'].health.issues[0].code, 'unknown_project');
  for (const [file, content] of Object.entries(source)) {
    const detail = await api.read(file);
    assert.deepEqual(detail.health, byFile[file].health, file);
    assert.equal(detail.content, content, file);
    assert.equal(detail.revision, before[file], file);
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), content, file);
    assert.equal(fs.existsSync(path.join(dir, '.history')), false, 'checking does not create a version store');
  }
  const scoped = await api.list({ projectId: 'other' });
  assert.equal(scoped.items.find((item) => item.file === 'project.md').health.state, 'inactive');
});

test('unavailable project catalogs are reported without declaring project memories invalid', async (t) => {
  for (const getProjects of [() => { throw new Error('unavailable'); }, () => null, () => [{}]]) {
    const { api, handlers } = harness(t, { getProjects });
    await api.write('project.md', `${serializeMemoryFrontmatter({ scope: 'project', projectId: 'known' })}\nBody.\n`);
    const checked = handlers.get('memory:check')({});
    assert.equal(checked.ok, true);
    assert.equal(checked.projectCheck.available, false);
    assert.match(checked.projectCheck.reason, /尚未检查项目归属/);
    assert.equal(checked.items[0].health.state, 'active');
    assert.equal(checked.summary.invalid, 0);
    const detail = await api.read('project.md');
    assert.equal(detail.projectCheck.available, false);
    assert.equal(detail.health.issues.some((issue) => issue.code === 'unknown_project'), false);
  }
  const { api } = harness(t);
  const listed = await api.list();
  assert.equal(listed.projectCheck.skipped, true);
});

test('check forwards read-only mode and reports pending recovery without modifying files', async (t) => {
  const { api, store, dir } = harness(t);
  fs.writeFileSync(path.join(dir, 'pending.md'), 'interrupted content');
  let checks = 0;
  const rejectPending = options => {
    assert.equal(options.readOnly, true);
    checks++;
    throw Object.assign(new Error('存在未完成的记忆更新'), { code: 'MEMORY_RECOVERY_REQUIRED' });
  };
  store.list = (_context, options) => rejectPending(options);
  store.archived = options => rejectPending(options);
  for (const options of [{}, { archived: true }]) {
    const checked = await api.check(options);
    assert.equal(checked.ok, false);
    assert.equal(checked.code, 'MEMORY_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(path.join(dir, 'pending.md'), 'utf8'), 'interrupted content');
  }
  assert.equal(checks, 2);
});
