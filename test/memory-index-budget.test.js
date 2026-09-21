'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const { MEMORY_CONSOLIDATION_PROMPT } = require('../memory-runtime');
function fn(name, next) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
}
function harness(entries) {
  const exposures = [], contexts = [];
  const ctx = vm.createContext({ Buffer, MEMORY_CONSOLIDATION_PROMPT,
    MEMORY_INDEX_BUDGET: 8192, MEMORY_INDEX_HEAD: 40,
    rebuildMemoryIndex: context => { contexts.push(context); return { entries }; },
    recordMemoryExposures: files => exposures.push(files),
  });
  vm.runInContext(fn('memoryQueryTerms', '// ── 索引由') + fn('memoryIndexLine', 'function memoryQueryTerms') +
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
