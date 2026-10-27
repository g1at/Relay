'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistorySearchCore, makeSnippet, savedAssistant, SEARCH_INDEX_VERSION } = require('../src/main/app/history-search-core');
function fixture(t, options = {}) {
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-search-core-')); t.after(() => fs.rmSync(historyDir, { recursive: true, force: true }));
  const indexFile = path.join(historyDir, 'index.json'); const items = [];
  const index = () => fs.writeFileSync(indexFile, JSON.stringify({ version: 2, items })); index();
  const add = (id, values = {}) => { const document = { id, title: id, updatedAt: '2026-10-14', turns: [], ...values };
    fs.writeFileSync(path.join(historyDir, id + '.json'), JSON.stringify(document)); items.push({ id, title: document.title, updatedAt: document.updatedAt, kind: document.kind }); index(); return document; };
  const write = document => fs.writeFileSync(path.join(historyDir, document.id + '.json'), JSON.stringify(document));
  return { historyDir, indexFile, items, index, add, write, core: createHistorySearchCore({ historyDir, ...options }) };
}

test('per-conversation title priority preserves global updatedAt order and body turn positions', async t => {
  const f = fixture(t); f.add('older', { title: 'needle title', updatedAt: '2026-01-01', turns: [{ user: 'needle body' }] });
  f.add('newer', { title: 'other', updatedAt: '2026-10-01', turns: [{ user: 'nothing' }, { assistant: 'NEEDLE answer' }] });
  const result = await f.core.search({ query: 'needle' }); assert.equal(result.ok, true); assert.deepEqual(result.items.map(item => item.id), ['newer', 'older']);
  assert.deepEqual([result.items[0].matchField, result.items[0].turnIndex, result.items[0].matchSide], ['body', 1, 'assistant']);
  assert.deepEqual([result.items[1].matchField, result.items[1].turnIndex, result.items[1].matchSide], ['title', null, null]);
});

test('literal query metacharacters use real highlight sentinels and retain surrounding context', () => {
  const result = makeSnippet('x'.repeat(40) + 'A+B? A+B?' + 'z'.repeat(40), 'a+b?');
  assert.ok(result.startsWith('…')); assert.ok(result.endsWith('…')); assert.equal(result.split('\x00').length - 1, 2); assert.ok(result.includes('\x00A+B?\x01'));
});

test('modern empty or unfinished final never falls back to a draft and old collaborative aggregates remain hidden', async t => {
  const f = fixture(t); f.add('draft', { turns: [
    { assistant: 'withdrawn-needle', output: { status: 'complete', final: '' } },
    { assistant: 'withdrawn-needle', output: { status: 'canceled', final: 'withdrawn-needle' } },
    { assistant: 'withdrawn-needle', chat: [{ text: 'legacy team' }] },
    { assistant: 'legacy-answer' }, { assistant: 'wrong-draft', output: { status: 'complete', final: 'saved-answer' } },
  ] });
  assert.equal((await f.core.search({ query: 'withdrawn-needle' })).items.length, 0);
  assert.equal((await f.core.search({ query: 'wrong-draft' })).items.length, 0);
  assert.equal((await f.core.search({ query: 'saved-answer' })).items[0].turnIndex, 4);
  assert.equal((await f.core.search({ query: 'legacy-answer' })).items[0].turnIndex, 3);
  assert.equal(savedAssistant({ output: { status: 'complete', final: {} }, assistant: 'no fallback' }), '');
});

test('create prompt and body metadata are authoritative even when old index fields disagree', async t => {
  const f = fixture(t), document = f.add('creation', { title: 'original', turns: [] });
  document.title = 'new-title'; document.kind = 'create'; document.mode = 'agent'; document.fromScheduled = { id: 'schedule-a', name: 'saved schedule' }; document.turns = [{ prompt: 'needle-prompt', user: 'hidden-user' }]; f.write(document);
  const result = await f.core.search({ query: 'needle-prompt' }); assert.equal(result.items[0].kind, 'create'); assert.equal(result.items[0].mode, 'agent'); assert.equal(result.items[0].matchSide, 'prompt'); assert.equal(result.items[0].title, 'new-title');
  assert.equal(result.items[0].fromScheduled.id, 'schedule-a'); assert.equal((await f.core.search({ query: 'hidden-user' })).items.length, 0);
  assert.equal((await f.core.search({ query: 'original' })).items.length, 0);
});

test('compact cache excludes large activity logs and repeated queries perform zero additional body reads', async t => {
  const f = fixture(t); f.add('large', { turns: [{ user: 'needle', assistant: 'answer', activity: { items: [{ text: 'tool-only-secret' + 'x'.repeat(4 * 1024 * 1024) }] } }] });
  await f.core.search({ query: 'needle' }); const first = f.core.diagnostics(); assert.equal(first.bodyReads, 1); assert.ok(first.cacheBytes < 4096);
  assert.equal((await f.core.search({ query: 'tool-only-secret' })).items.length, 0); assert.equal(f.core.diagnostics().bodyReads, 1);
  assert.equal((await f.core.search({ query: 'large' })).items[0].matchField, 'title'); assert.equal(f.core.diagnostics().bodyReads, 1);
});

test('same updatedAt edits, rename, append and same-size atomic replacement invalidate projected text', async t => {
  const f = fixture(t), d = f.add('editable', { title: 'original', turns: [{ assistant: 'aaaa' }] });
  await f.core.search({ query: 'aaaa' }); d.title = 'renamed'; d.turns.push({ user: 'new-prompt' }); f.write(d);
  assert.equal((await f.core.search({ query: 'renamed' })).items.length, 1); assert.equal((await f.core.search({ query: 'original' })).items.length, 0);
  assert.equal((await f.core.search({ query: 'new-prompt' })).items[0].turnIndex, 1);
  const file = path.join(f.historyDir, 'editable.json'), prior = fs.statSync(file), replacement = file + '.tmp'; d.turns[0].assistant = 'bbbb';
  fs.writeFileSync(replacement, JSON.stringify(d)); fs.utimesSync(replacement, prior.atime, prior.mtime); fs.renameSync(replacement, file);
  assert.equal((await f.core.search({ query: 'aaaa' })).items.length, 0); assert.equal((await f.core.search({ query: 'bbbb' })).items.length, 1);
});

test('byte LRU never retains tool JSON or projections exceeding its budget', async t => {
  const f = fixture(t, { cacheMaxBytes: 3000 }); for (let index = 0; index < 4; index++) f.add('entry-' + index, { turns: [{ user: 'needle-' + index }] });
  await f.core.search({ query: 'no-hit' }); const stats = f.core.diagnostics(); assert.ok(stats.cacheBytes <= 3000); assert.equal(stats.cacheEntries, 1); assert.equal(stats.evictions, 3);
  f.add('oversized-text', { turns: [{ user: 'x'.repeat(4000) }] }); await f.core.search({ query: 'no-hit' }); assert.ok(f.core.diagnostics().cacheBytes <= 3000);
});

test('bad individual histories yield partial results while bad indexes fail explicitly without rebuilding', async t => {
  const f = fixture(t); f.add('good', { turns: [{ user: 'needle' }] }); f.add('broken'); fs.writeFileSync(path.join(f.historyDir, 'broken.json'), '{');
  f.items.push({ id: '../outside', title: 'needle' }); f.index();
  let result = await f.core.search({ query: 'needle' }); assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.items.length, 1);
  fs.writeFileSync(f.indexFile, '{'); result = await f.core.search({ query: 'needle' }); assert.equal(result.ok, false); assert.equal(result.code, 'HISTORY_SEARCH_INDEX_UNAVAILABLE'); assert.equal(fs.readFileSync(f.indexFile, 'utf8'), '{');
});

test('index membership changes during a query remove deleted matches and prune cache', async t => {
  const f = fixture(t); f.add('deleted', { turns: [{ user: 'needle' }] }); f.add('kept', { turns: [{ user: 'needle' }] });
  let altered = false; const io = { promises: { ...fs.promises, readFile: async (file, ...args) => {
    const result = await fs.promises.readFile(file, ...args);
    if (!altered && path.basename(file) === 'kept.json') { altered = true; f.items.splice(f.items.findIndex(item => item.id === 'deleted'), 1); f.index(); }
    return result;
  } } };
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem: io });
  const result = await core.search({ query: 'needle' }); assert.deepEqual(result.items.map(item => item.id), ['kept']); assert.equal(core.diagnostics().cacheEntries, 1);
});

test('unrelated pin session and turn-count index writes do not erase stable hits or repeat scanning', async t => {
  const f = fixture(t); f.add('stable', { turns: [{ user: 'unique-needle' }] }); let writes = 0;
  const io = { promises: { ...fs.promises, lstat: async (file, ...args) => {
    if (path.basename(file) === 'stable.json') { f.items[0].pinned = !!(++writes % 2); f.items[0].sessionId = 'session-' + writes; f.items[0].turnCount = writes; f.index(); }
    return fs.promises.lstat(file, ...args);
  } } };
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem: io });
  const result = await core.search({ query: 'unique-needle' }); assert.equal(result.items.length, 1); assert.equal(result.partial, undefined); assert.equal(core.diagnostics().bodyReads, 1);
});

test('cancellation returns no stale results on cold and warm scans', async t => {
  const f = fixture(t); for (let i = 0; i < 20; i++) f.add('entry-' + i, { turns: [{ user: 'needle' }] });
  for (let round = 0; round < 2; round++) {
    await f.core.search({ query: 'needle' }); let canceled = false; setImmediate(() => { canceled = true; });
    assert.deepEqual(await f.core.search({ query: 'needle', isCanceled: () => canceled }), { ok: true, items: [], canceled: true });
  }
});

test('query limits and metadata prevent oversized response payloads', async t => {
  const f = fixture(t); f.add('bounded', { title: 'needle' + 'z'.repeat(10000), fromScheduled: { name: 'n'.repeat(10000), privateDump: 'x'.repeat(10000) }, turns: [] });
  let result = await f.core.search({ query: 'needle', limit: -1 }); assert.equal(result.items.length, 1); assert.equal(result.items[0].title.length, 256); assert.equal(result.items[0].fromScheduled.name.length, 256); assert.equal(result.items[0].fromScheduled.privateDump, undefined);
  result = await f.core.search({ query: 'x'.repeat(513) }); assert.equal(result.code, 'HISTORY_SEARCH_QUERY_TOO_LONG');
  assert.deepEqual(await f.core.search({ query: '  ' }), { ok: true, items: [] });
});

test('visible Markdown and saved supplemental input are searchable with stable message identities', async t => {
  const f = fixture(t);
  f.add('visible', { turns: [{ runId: 'run-1', user: 'Keep **literal** input.',
    output: { status: 'complete', final: '记忆**架构**\nAlpha\n\tBeta &amp; details.' },
    supplements: [{ id: 'input-1', text: 'Supplement A+B? exact', status: 'applied' }] }] });
  const supplement = (await f.core.search({ query: 'supplement a+b?' })).items[0];
  assert.equal(supplement.turnIndex, 0); assert.equal(supplement.turnId, 'run-1');
  assert.equal(supplement.matchSide, 'user'); assert.equal(supplement.messageKey, 'supplement:input-1');
  const markdown = (await f.core.search({ query: '记忆架构' })).items[0];
  assert.equal(markdown.matchSide, 'assistant'); assert.equal(markdown.messageKey, 'assistant');
  assert.match(markdown.snippet, /\x00记忆架构\x01/);
  assert.equal((await f.core.search({ query: 'ALPHA beta & details' })).items.length, 1);
  assert.equal((await f.core.search({ query: 'Keep literal input' })).items.length, 0, 'user text is not interpreted as Markdown');
  assert.equal((await f.core.search({ query: 'Keep **literal** input' })).items.length, 1);
});

test('pagination makes older exact matches reachable without changing conversation order', async t => {
  const f = fixture(t);
  for (let i = 0; i < 61; i++) f.add('match-' + i, { title: i === 60 ? 'needle' : 'recent ' + i,
    updatedAt: new Date(Date.UTC(2026, 9, 22, 0, 61 - i)).toISOString(), turns: [{ user: 'needle' }, { assistant: 'needle again' }] });
  const first = await f.core.search({ query: 'needle', limit: 50 });
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 50);
  const second = await f.core.search({ query: 'needle', limit: 50, offset: first.nextOffset });
  assert.equal(second.items.length, 11); assert.equal(second.hasMore, false); assert.equal(second.nextOffset, null);
  assert.equal(second.items.at(-1).id, 'match-60'); assert.equal(second.items.at(-1).matchField, 'title');
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 61);
  assert.equal((await f.core.search({ query: 'needle', offset: 61 })).items.length, 0);
  assert.equal((await f.core.search({ query: 'needle', limit: 1, offset: -1 })).items[0].id, 'match-0');
});

test('compact disk indexes survive worker restarts and memory evictions without reading full tool logs again', async t => {
  const f = fixture(t, { cacheMaxBytes: 3000 });
  for (let i = 0; i < 5; i++) f.add('persisted-' + i, { turns: [{ user: 'needle ' + i, assistant: 'answer',
    activity: { items: [{ text: 'excluded-tool-log-' + 'x'.repeat(128 * 1024) }] } }] });
  await f.core.search({ query: 'no-hit' });
  assert.equal(f.core.diagnostics().bodyReads, 5); assert.ok(f.core.diagnostics().cacheEntries <= 1);
  const indexes = fs.readdirSync(path.join(f.historyDir, '.search-index'));
  assert.equal(indexes.length, 5);
  const stored = fs.readFileSync(path.join(f.historyDir, '.search-index', 'persisted-0.json'), 'utf8');
  assert.doesNotMatch(stored, /excluded-tool-log/); assert.ok(stored.length < 4096);
  await f.core.search({ query: 'another-no-hit' });
  assert.equal(f.core.diagnostics().bodyReads, 5, 'eviction reloads only the compact index');
  const restarted = createHistorySearchCore({ historyDir: f.historyDir, cacheMaxBytes: 0 });
  assert.equal((await restarted.search({ query: 'needle' })).items.length, 5);
  assert.equal(restarted.diagnostics().bodyReads, 0); assert.equal(restarted.diagnostics().indexHits, 5);
});

test('invalid, outdated and stale disk projections rebuild automatically from authoritative history', async t => {
  const f = fixture(t); const document = f.add('editable', { turns: [{ assistant: 'before' }] });
  await f.core.search({ query: 'before' });
  const cacheFile = path.join(f.historyDir, '.search-index', 'editable.json');
  for (const corrupt of ['{', JSON.stringify({ version: -1 }), JSON.stringify({ version: SEARCH_INDEX_VERSION, id: 'editable', projection: {} })]) {
    fs.writeFileSync(cacheFile, corrupt);
    const core = createHistorySearchCore({ historyDir: f.historyDir });
    assert.equal((await core.search({ query: 'before' })).items.length, 1);
    assert.equal(core.diagnostics().bodyReads, 1);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version, SEARCH_INDEX_VERSION);
  }
  document.turns[0].assistant = 'after'; f.write(document);
  const restarted = createHistorySearchCore({ historyDir: f.historyDir });
  assert.equal((await restarted.search({ query: 'before' })).items.length, 0);
  assert.equal((await restarted.search({ query: 'after' })).items.length, 1);
  assert.equal(restarted.diagnostics().bodyReads, 1);
});

test('a derived-index write failure never hides valid matches or changes the history body', async t => {
  const f = fixture(t); f.add('readable', { turns: [{ user: 'needle' }] });
  const bodyFile = path.join(f.historyDir, 'readable.json'), before = fs.readFileSync(bodyFile, 'utf8');
  const fileSystem = { promises: { ...fs.promises, writeFile: async file => {
    assert.equal(path.dirname(file), path.join(f.historyDir, '.search-index'));
    throw Object.assign(Error('synthetic disk is read-only'), { code: 'EACCES' });
  } } };
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem });
  const result = await core.search({ query: 'needle' });
  assert.equal(result.items.length, 1); assert.equal(result.partial, undefined);
  assert.equal(core.diagnostics().indexWriteFailures, 1);
  assert.equal(fs.readFileSync(bodyFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(f.historyDir, '.search-index')), []);
});

test('deleting a conversation during index installation leaves neither hits nor orphaned projections', async t => {
  const f = fixture(t); f.add('deleted', { turns: [{ user: 'needle' }] });
  let deleted = false;
  const fileSystem = { promises: { ...fs.promises, rename: async (from, to) => {
    await fs.promises.rename(from, to);
    if (!deleted && path.basename(to) === 'deleted.json') {
      deleted = true; f.items.length = 0; f.index(); fs.unlinkSync(path.join(f.historyDir, 'deleted.json'));
    }
  } } };
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem });
  assert.deepEqual((await core.search({ query: 'needle' })).items, []);
  assert.equal(fs.existsSync(path.join(f.historyDir, '.search-index', 'deleted.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.historyDir, '.search-index')), []);
});

test('cold reads are concurrent but bounded and cancellation stops subsequent batches', { timeout: 5000 }, async t => {
  const f = fixture(t); for (let i = 0; i < 8; i++) f.add('parallel-' + i, { turns: [{ user: 'needle' }] });
  let reads = 0, active = 0, peak = 0, canceled = false; const gates = [];
  const fileSystem = { promises: { ...fs.promises, readFile: async (file, ...args) => {
    if (path.dirname(file) !== f.historyDir || path.basename(file) === 'index.json') return fs.promises.readFile(file, ...args);
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => { gates.push(resolve); if (gates.length === 4) { canceled = true; gates.splice(0).forEach(release => release()); } });
    try { return await fs.promises.readFile(file, ...args); } finally { active--; }
  } } };
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem });
  assert.deepEqual(await core.search({ query: 'needle', isCanceled: () => canceled }), { ok: true, items: [], canceled: true });
  assert.equal(peak, 4); assert.equal(reads, 4); assert.equal(active, 0);
});

test('safe empty-final snapshot recovery matches history load without reading journals or changing saved bytes', async t => {
  const { createHistoryStore } = require('../src/main/app/history-store');
  const { createLegacyOutputRecovery } = require('../src/main/projects/legacy-output-recovery');
  const Output = require('../renderer/assistant-output');
  const Text = require('../renderer/history-search-text');
  const f = fixture(t), id = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222';
  const state = Output.createState();
  Output.ingest(state, { type: 'assistant', uuid: 'final-frame', message: { id: 'final-message',
    content: [{ type: 'thinking', thinking: 'excluded-private-thought' }, { type: 'text', text: 'Recovered exact final answer.' }], stop_reason: 'end_turn' } });
  Output.ingest(state, { type: 'result', subtype: 'success', uuid: 'result', jobId: runId, session_id: 'fixture',
    user_message_uuid: runId, user_message_uuids: [runId], num_turns: 1, result: '', terminal_reason: 'completed', queued_turn_count: 0 });
  const output = Output.serialize(state);
  Object.assign(output, { status: 'complete', final: '', finalMessageId: null, answers: [] });
  const record = f.add(id, { turns: [{ runId, user: 'question', status: 'complete', assistant: '', output }] });
  const file = path.join(f.historyDir, id + '.json'), before = fs.readFileSync(file, 'utf8');
  const noJournalReads = { readFileSync() { assert.fail('search recovery must not read journals'); },
    statSync() { assert.fail('search recovery must not stat journals'); }, promises: fs.promises };
  // Real loadConversation always resolves <userData>/history; point its body read
  // at this fixture through the store's public path without invoking bootstrap.
  const userData = path.join(f.historyDir, 'load-fixture');
  const store = createHistoryStore({ getUserDataDir: () => userData,
    recoverLegacyOutput: createLegacyOutputRecovery({ fileSystem: noJournalReads }) });
  fs.mkdirSync(store.getHistoryDir(), { recursive: true });
  fs.writeFileSync(store.convFilePath(id), before);
  const loaded = store.loadConversation(id);
  assert.equal(Text.savedAssistant(loaded.turns[0]), 'Recovered exact final answer.');
  const core = createHistorySearchCore({ historyDir: f.historyDir, fileSystem: noJournalReads });
  assert.equal((await core.search({ query: 'Recovered exact final answer.' })).items[0].turnId, runId);
  assert.equal((await core.search({ query: 'excluded-private-thought' })).items.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(store.convFilePath(id), 'utf8'), before);
  record.turns[0].output.retractedMessageUuids = ['withdrawn-frame']; f.write(record);
  assert.equal((await core.search({ query: 'Recovered exact final answer.' })).items.length, 0, 'retraction still forbids recovery');
});

test('membership pruning removes crashed temporary copies only for absent conversations', async t => {
  const f = fixture(t); f.add('kept', { turns: [{ user: 'needle' }] });
  const directory = path.join(f.historyDir, '.search-index'); fs.mkdirSync(directory);
  const uuid = '00000000-0000-4000-8000-000000000000';
  const deleted = path.join(directory, `.deleted.${uuid}.tmp`), active = path.join(directory, `.kept.${uuid}.tmp`);
  const unrelated = path.join(directory, 'unrelated.tmp');
  for (const file of [deleted, active, unrelated]) fs.writeFileSync(file, 'synthetic cached text');
  assert.equal((await f.core.search({ query: 'needle' })).items.length, 1);
  assert.equal(fs.existsSync(deleted), false);
  assert.equal(fs.existsSync(active), true, 'a current writer is not pruned');
  assert.equal(fs.existsSync(unrelated), true, 'unrelated files are untouched');
});
