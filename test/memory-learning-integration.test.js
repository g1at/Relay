'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { MemoryLearningService } = require('../src/main/memory/memory-learning');
const { createMemoryRetriever } = require('../src/main/memory/memory-retrieval');
const bootstrap = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const from = bootstrap.indexOf('let memoryLearningService = null;');
const to = bootstrap.indexOf('// ─────────────────────────────────────────', from);
assert.ok(from >= 0 && to > from);

test('source navigation follows a stable turn ID after insertion and never jumps to another message after deletion', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = renderer.indexOf('function resolveHistoryJumpIndex(');
  const end = renderer.indexOf('// jumpTo(可选)', start);
  const ctx = vm.createContext({}); vm.runInContext(renderer.slice(start, end), ctx);
  const turns = [{ runId: 'inserted' }, { runId: 'original' }, { id: 'restored' }];
  assert.equal(ctx.resolveHistoryJumpIndex(turns, { turnId: 'original', turnIndex: 0 }), 1);
  assert.equal(ctx.resolveHistoryJumpIndex(turns, { turnId: 'removed', turnIndex: 0 }), null);
  assert.equal(ctx.resolveHistoryJumpIndex(turns, { turnIndex: 0 }), 0);
  assert.equal(ctx.resolveHistoryJumpIndex(turns, { turnIndex: 99 }), null);
  assert.equal(ctx.resolveHistoryJumpIndex([{ runId: 'same' }, { runId: 'same' }], { turnId: 'same', turnIndex: 0 }), null);
});

test('real bootstrap adapter extracts a governed project candidate, exposes it only after approval and resumes incrementally', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-learning-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ dir: path.join(dir, 'memory') });
  const retriever = createMemoryRetriever({ store });
  const at = new Date(Date.now() - 2 * 86400000).toISOString();
  const chat = { id: 'chat-1', title: 'Synthetic formatting preference', updatedAt: at, turns: [
    { runId: 'run-1', ts: at, user: '以后用紫色表格汇总测试结果。', assistant: 'stale ignored',
      output: { status: 'complete', final: '好的，表格中会保留测试结果。' } },
  ] };
  const calls = [], controller = new AbortController();
  let rebuilds = 0;
  const context = vm.createContext({ path, os, MemoryLearningService, relayMemoryStore: store,
    MEMORY_DIR: store.dir, app: { getPath: () => dir }, isMemoryPinned: () => false,
    readHistoryIndex: () => [{ id: chat.id, title: chat.title, updatedAt: at }],
    loadConversation: id => id === chat.id ? chat : null,
    getProjectStore: () => ({ binding: () => 'p1', list: () => [{ id: 'p1' }] }),
    liveSessions: new Map(), taskLedger: { list: () => [] },
    activeRelayProviderRuntime: ({ tier }) => ({ modelId: `synthetic-${tier}`, env: {}, agentEnvironment: 'native' }),
    getSdkRuntimeStorage: () => ({ apply: env => env }), readAppSettings: () => ({}),
    buildRuntimePolicy: () => ({}), toWslPath: value => value, recordRelayUsage() {},
    rebuildMemoryIndex: () => { rebuilds++; },
    claudeSdk: { runStructured: async options => {
      calls.push(options);
      const data = JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n') + 1));
      const evidence = data.evidence.find(item => item.text.includes('紫色表格'));
      // Use the exact success/data validator contract of sdk-structured-output.
      const result = options.validate({ candidates: [{ name: '结果展示偏好', description: '测试报告格式', type: 'feedback',
        body: '以后用紫色表格汇总测试结果。', evidence: [{ id: evidence.id, quote: evidence.text }] }] });
      assert.equal(result.success, true);
      return result.data;
    } },
  });
  vm.runInContext(bootstrap.slice(from, to), context);
  const result = await context.runMemoryMaintenance({ model: 'sonnet', signal: controller.signal });
  assert.equal(result.ok, true, result.error); assert.equal(result.candidates, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].model, 'synthetic-sonnet'); assert.equal(calls[0].maxTurns, 6);
  assert.ok(!calls[0].prompt.includes('stale ignored'));
  const draft = store.list()[0];
  assert.equal(draft.meta.type, 'feedback'); assert.equal(draft.meta.projectId, 'p1');
  assert.equal(draft.meta.status, 'draft'); assert.equal(draft.meta.sources[0].conversationId, chat.id);
  assert.equal(retriever.search('紫色表格', { context: { projectId: 'p1' } }).length, 0);
  store.setStatus(draft.file, 'active', { actor: 'user', expectedRevision: draft.revision });
  const hits = retriever.search('紫色表格', { context: { projectId: 'p1' } });
  assert.equal(hits.length, 1); assert.match(hits[0].snippet, /紫色表格/);
  assert.equal(retriever.search('紫色表格', { context: { projectId: 'other' } }).length, 0);
  assert.equal(retriever.search('紫色表格').length, 0);
  const next = await context.runMemoryMaintenance({ model: 'sonnet' });
  assert.equal(next.processed, 0); assert.equal(calls.length, 1); assert.equal(rebuilds, 2);
  assert.equal(context.getMemoryLearningService().status().lastRun.ok, true);
});
