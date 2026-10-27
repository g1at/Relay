'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const { MEMORY_CONSOLIDATION_PROMPT } = require('../src/main/memory/memory-runtime');
const { MEMORY_TYPE_GUIDANCE } = require('../src/main/memory/memory-schema');
const { createMemoryRetriever, redactMemoryText } = require('../src/main/memory/memory-retrieval');
function fn(name, next) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
}
function harness(entries) {
  const exposures = [], contexts = [];
  const records = entries.map(entry => ({ ...entry, revision: entry.file, meta: { name: entry.title, description: entry.desc, scope: 'global', type: 'reference', status: 'active', confidence: 'user_confirmed', ...entry.meta } }));
  const memoryRetriever = createMemoryRetriever({ store: { list: () => records,
    read: file => { const entry = records.find(item => item.file === file); return { ...entry, content: entry.body || '' }; } } });
  const ctx = vm.createContext({ Buffer, MEMORY_CONSOLIDATION_PROMPT, MEMORY_TYPE_GUIDANCE, memoryRetriever, redactMemoryText,
    MEMORY_INDEX_BUDGET: 8192, MEMORY_INDEX_HEAD: 40,
    rebuildMemoryIndex: context => { contexts.push(context); return { entries }; },
    recordMemoryExposures: files => exposures.push(files),
  });
  vm.runInContext(fn('memoryIndexLine', '// ── 索引由') +
    fn('buildMemoryHint', '// 让 Windows 任务栏'), ctx);
  return { build: ctx.buildMemoryHint, exposures, contexts };
}
test('injected index honors both UTF-8 budget and item limit even for all-core libraries', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({ file: 'fact-' + i + '.md', title: '核心记忆' + i, desc: '字'.repeat(240), pinned: true, mtime: i }));
  const { build, exposures } = harness(entries);
  const result = build('full', '', {});
  const lines = result.split('\n').filter(line => line.includes('fact-'));
  assert.ok(lines.length > 0 && lines.length <= 40);
  assert.ok(Buffer.byteLength(lines.join('\n') + '\n', 'utf8') <= 8192);
  assert.equal(exposures[0].length, lines.length);
});

test('injected recall includes body evidence but redacts sensitive metadata and honors its budget', () => {
  const { build } = harness([
    { file: 'workflow.md', title: '工作习惯', desc: '格式规则', body: '请使用紫色表格汇总每周测试结果。', mtime: 1 },
    { file: 'pinned.md', title: '密码：synthetic-password', desc: 'api_key=synthetic-secret', pinned: true, mtime: 2 },
  ]);
  const hint = build('read', '紫色表格');
  assert.match(hint, /workflow\.md.*正文命中：.*紫色表格/);
  assert.ok(!hint.includes('synthetic-password'));
  assert.ok(!hint.includes('synthetic-secret'));
});
test('relevance can surface older matching facts while project context is forwarded and off performs no I/O', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ file: 'fact-' + i + '.md', title: '常规记录' + i, desc: '', pinned: false, mtime: i }));
  entries[0].title = '新能源汽车测试报告';
  const { build, exposures, contexts } = harness(entries), scope = { projectId: 'project-1' };
  const result = build('read', '检查新能源汽车报告', scope);
  assert.equal(contexts[0], scope);
  assert.ok(exposures[0].includes('fact-0.md'));
  assert.match(result, /只读记忆/);
  assert.equal(build('off', 'ignored', {}), '');
  assert.equal(contexts.length, 1);
});

test('generation and maintenance receive explicit content-based type guidance', () => {
  const { build } = harness([]);
  assert.equal(typeof MEMORY_TYPE_GUIDANCE, 'string');
  assert.ok(MEMORY_TYPE_GUIDANCE.length > 0);
  assert.ok(build('full').includes(MEMORY_TYPE_GUIDANCE));
  assert.ok(build('maintenance').includes(MEMORY_TYPE_GUIDANCE));
  assert.ok(!build('read').includes(MEMORY_TYPE_GUIDANCE));
  for (const type of ['user', 'feedback', 'project', 'reference']) assert.ok(MEMORY_TYPE_GUIDANCE.includes(type));
});
