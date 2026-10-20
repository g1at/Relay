'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistorySearchCore, makeSnippet, savedAssistant } = require('../src/main/app/history-search-core');
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
