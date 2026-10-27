'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');
const { createMemoryRetriever, tokenizeMemoryQuery, redactMemoryText } = require('../src/main/memory/memory-retrieval');

const doc = (meta, body) => serializeMemoryFrontmatter(meta) + '\n' + body;
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retrieval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ dir });
  return { store, retriever: createMemoryRetriever({ store, ...options }) };
}

test('normalization handles full width Latin, identifiers, Chinese substrings and a bounded bilingual vocabulary', () => {
  assert.ok(tokenizeMemoryQuery('ＲＥＰＯＲＴ').includes('report'));
  assert.ok(tokenizeMemoryQuery('save_report').includes('report'));
  assert.ok(tokenizeMemoryQuery('本周变更报告').includes('变更报'));
  assert.ok(tokenizeMemoryQuery('本周变更报告').includes('报告'));
  const english = tokenizeMemoryQuery('report');
  assert.ok(tokenizeMemoryQuery('报表').some(term => term.startsWith('~') && english.includes(term)));
});

test('body search finds Chinese facts with unrelated titles, and bilingual aliases bridge ordinary wording', t => {
  const { store, retriever } = setup(t);
  store.write('decision.md', doc({ name: '口径约定', description: '日期处理方式' }, '本周变更按功能决策日期所在的自然周统计。'));
  store.write('format.md', doc({ name: '输出格式' }, '报告中的每一行都应包含项目列。'));
  store.write('unrelated.md', doc({ name: '浏览器主题' }, '默认使用浅色。'));
  assert.deepEqual(retriever.search('功能决策日期').map(entry => entry.file), ['decision.md']);
  const result = retriever.search('report');
  assert.deepEqual(result.map(entry => entry.file), ['format.md']);
  assert.ok(result[0].matchedFields.includes('body'));
  assert.match(result[0].snippet, /项目列/);
  assert.equal(Object.hasOwn(result[0], 'content'), false);
});

test('field weighting and deterministic ordering rank a title hit above incidental body repetition', t => {
  const { store, retriever } = setup(t);
  store.write('precise.md', doc({ name: '季度报告' }, '规范列顺序。'));
  store.write('incidental.md', doc({ name: '操作笔记' }, '报告 '.repeat(80)));
  const first = retriever.search('季度报告');
  assert.equal(first[0].file, 'precise.md');
  assert.ok(first[0].score > first[1].score);
  assert.deepEqual(retriever.search('季度报告'), first);
});

test('snippets show the matching summary when body text does not explain the match', t => {
  const { store, retriever } = setup(t);
  store.write('summary.md', doc({ description: 'summaryneedle identifies the relevant document.' }, 'An unrelated detail.'));
  assert.match(retriever.search('summaryneedle')[0].snippet, /summaryneedle/);
});

test('eligibility is checked before indexing and again on read, with no scope, draft or expired text leaking', t => {
  const { store, retriever } = setup(t, { now: () => Date.parse('2026-10-21') });
  for (const [file, meta] of [
    ['a.md', { scope: 'project', projectId: 'a' }],
    ['b.md', { scope: 'project', projectId: 'b' }],
    ['draft.md', { status: 'draft' }],
    ['inferred.md', { confidence: 'inferred' }],
    ['expired.md', { expiresAt: '2026-10-20' }],
    ['superseded.md', { status: 'superseded' }],
  ]) store.write(file, doc(meta, 'Only this item contains recallneedle: ' + file));
  const read = store.read.bind(store), reads = [];
  store.read = (file, options) => { reads.push(file); assert.equal(options.actor, 'model'); return read(file, options); };
  assert.deepEqual(retriever.search('recallneedle', { context: { projectId: 'a' } }).map(entry => entry.file), ['a.md']);
  assert.deepEqual(reads, ['a.md']);
  assert.deepEqual(retriever.search('recallneedle', { context: { projectId: 'b' } }).map(entry => entry.file), ['b.md']);
  assert.deepEqual(reads, ['a.md', 'b.md']);
  assert.deepEqual(retriever.search('recallneedle'), []);
});

test('new revisions, deletion and changed approval immediately invalidate cached search matches', t => {
  const { store, retriever } = setup(t);
  store.write('fact.md', doc({}, 'oldneedle'));
  const originalRead = store.read.bind(store); let reads = 0;
  store.read = (...args) => { reads++; return originalRead(...args); };
  assert.equal(retriever.search('oldneedle').length, 1);
  assert.equal(retriever.search('oldneedle').length, 1);
  assert.equal(reads, 1, 'unchanged revisions reuse the bounded index');
  store.write('fact.md', doc({}, 'newneedle'));
  assert.equal(retriever.search('oldneedle').length, 0);
  assert.equal(retriever.search('newneedle').length, 1);
  assert.equal(reads, 2);
  store.write('fact.md', doc({ status: 'draft' }, 'newneedle'));
  assert.equal(retriever.search('newneedle').length, 0);
  assert.equal(reads, 2, 'draft is filtered before any body read');
  store.write('fact.md', doc({}, 'againneedle'));
  assert.equal(retriever.search('againneedle').length, 1);
  fs.unlinkSync(path.join(store.dir, 'fact.md'));
  assert.equal(retriever.search('againneedle').length, 0);
});

test('empty query pages through all entries without indexing bodies and cannot return full content', () => {
  const entries = Array.from({ length: 205 }, (_, i) => ({ file: `entry-${i}.md`, meta: { name: String(i) }, revision: String(i), mtime: i, content: 'must not forward' }));
  const store = { list: () => entries, read: () => assert.fail('empty query must not read bodies') };
  const retriever = createMemoryRetriever({ store });
  const first = retriever.search('', { limit: 1000 });
  const second = retriever.search('', { offset: 100, limit: 100 });
  const third = retriever.search('', { offset: 200, limit: 100 });
  assert.deepEqual([first.length, second.length, third.length], [100, 100, 5]);
  assert.equal(new Set([...first, ...second, ...third].map(entry => entry.file)).size, 205);
  assert.equal(JSON.stringify(first).includes('must not forward'), false);
  assert.deepEqual(retriever.search('', { offset: 205 }), []);
});

test('list metadata excludes source quotes and unknown fields while retaining a provenance count', () => {
  const entry = { file: 'provenance.md', revision: 'one', meta: {
    name: 'Useful fact', description: 'Short description', scope: 'global',
    sources: [{ conversationId: 'source-chat', quote: 'fixture-password-value' }],
    sourceRef: 'private-source-text', unrelated: 'raw-conversation-content',
  } };
  const retriever = createMemoryRetriever({ store: { list: () => [entry], read: () => assert.fail('empty query') } });
  const [listed] = retriever.search('');
  assert.equal(listed.meta.sourceCount, 1);
  assert.equal(listed.meta.name, 'Useful fact');
  assert.equal(listed.meta.sources, undefined);
  assert.equal(listed.meta.sourceRef, undefined);
  assert.equal(listed.meta.unrelated, undefined);
  assert.equal(JSON.stringify(listed).includes('fixture-password-value'), false);
});

test('query results support stable offset pagination and optional omission of core entries', t => {
  const { store, retriever } = setup(t);
  for (const [file, core] of [['first.md', true], ['second.md', false], ['third.md', false]]) store.write(file, doc({ core }, 'paginationneedle'));
  const all = retriever.search('paginationneedle');
  assert.deepEqual(retriever.search('paginationneedle', { limit: 1, offset: 1 }), all.slice(1, 2));
  assert.equal(retriever.search('paginationneedle', { includeCore: false }).length, 2);
  assert.equal(retriever.search('', { includeCore: false }).length, 2);
});

test('automatic search snippets and summaries redact sensitive lines, following value blocks and private keys', t => {
  const { store, retriever } = setup(t);
  store.write('environment.md', doc({ name: 'Environment', description: 'Password: desc-fixture-value' }, [
    'ordinaryneedle: Use the local shell.', '', 'password:', 'fixture-password-value', '',
    'API_KEY: fixture-api-value', '', '-----BEGIN PRIVATE KEY-----', 'fixture-private-key-value', '-----END PRIVATE KEY-----', '',
    'ordinaryneedle: Check the environment paths.',
  ].join('\n')));
  const results = retriever.search('ordinaryneedle');
  assert.equal(results.length, 1);
  const output = JSON.stringify(results);
  for (const sensitive of ['desc-fixture-value', 'fixture-password-value', 'fixture-api-value', 'fixture-private-key-value']) {
    assert.equal(output.includes(sensitive), false, sensitive);
    assert.deepEqual(retriever.search(sensitive), [], sensitive + ' must not remain indexed');
  }
  assert.match(results[0].snippet, /ordinaryneedle/);
  assert.ok(results[0].snippet.length <= 200);
  assert.match(results[0].meta.description, /已隐藏/);
  assert.equal(redactMemoryText('https://user:fixture@server.local').includes('fixture'), false);
  for (const key of ['access_token', 'accessToken', 'my_password', 'apiKey', 'credentials']) {
    assert.equal(redactMemoryText(key + ': fixture-sensitive-value').includes('fixture-sensitive-value'), false, key);
  }
});

test('long bodies produce bounded snippets around the match and never return the full document', t => {
  const { store, retriever } = setup(t);
  const body = 'begin '.repeat(200) + 'uniqueneedle the useful detail ' + 'ending '.repeat(200);
  store.write('large.md', doc({}, body));
  const [result] = retriever.search('uniqueneedle');
  assert.ok(result.snippet.length <= 200);
  assert.match(result.snippet, /uniqueneedle the useful detail/);
  assert.equal(JSON.stringify(result).includes(body), false);
});

test('a changed access check or missing file is skipped while unexpected failures remain visible', () => {
  const entry = { file: 'changing.md', meta: {}, revision: 'one' };
  let code = 'MEMORY_SCOPE';
  const store = { list: () => [entry], read: () => { const error = new Error('read failed'); error.code = code; throw error; } };
  const retriever = createMemoryRetriever({ store });
  assert.deepEqual(retriever.search('query'), []);
  code = 'MEMORY_NOT_FOUND';
  assert.deepEqual(retriever.search('query'), []);
  code = 'MEMORY_BUSY';
  assert.throws(() => retriever.search('query'), /read failed/);
});

test('cache limits and explicit invalidation force fresh reads without changing ranking', t => {
  const { store } = setup(t);
  store.write('one.md', doc({}, 'cachequery'));
  store.write('two.md', doc({}, 'cachequery'));
  const originalRead = store.read.bind(store); let reads = 0;
  store.read = (...args) => { reads++; return originalRead(...args); };
  const retriever = createMemoryRetriever({ store, maxCacheEntries: 1 });
  const first = retriever.search('cachequery');
  assert.equal(reads, 2);
  assert.deepEqual(retriever.search('cachequery'), first);
  assert.ok(reads > 2);
  retriever.invalidate();
  const before = reads;
  assert.deepEqual(retriever.search('cachequery'), first);
  assert.equal(reads, before + 2);
});
