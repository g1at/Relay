'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function harness() {
  const start = source.indexOf('const TITLE_MAX_W =');
  const end = source.indexOf('// IPC: 用最快档位', start);
  const saveStart = source.indexOf('function saveConversation(conv) {');
  const saveEnd = source.indexOf('// 上下文占用', saveStart);
  const records = [];
  const context = vm.createContext({ Intl, liveSessions: new Map(), fs: { existsSync: () => false }, convFilePath: id => id,
    mergeSupplementHistory: require('../live-supplement-input').mergeSupplementHistory,
    persistConversationRecord: conv => records.push(structuredClone(conv)) });
  require('./helpers/conversation-permissions-fixture')(context);
  vm.runInContext(source.slice(start, end) + source.slice(saveStart, saveEnd)
    + '\nglobalThis.limit = TITLE_MAX_W;', context);
  return { ...context, records };
}
test('longer titles keep 32 Chinese characters without depending on sidebar pixels', () => {
  const h = harness();
  const title = '历史会话的模型切换与工具加载故障排查和侧边栏宽度调整记录';
  assert.equal(h.limit, 64);
  assert.equal(h.truncateByWidth(title, h.limit), title.slice(0, 32));
  assert.ok(h.truncateByWidth(title, h.limit).length > 13);
});
test('wider titles retain whole words and Unicode graphemes', () => {
  const h = harness();
  assert.equal(h.truncateByWidth('历史会话 modelselection regression', 24), '历史会话 modelselection ');
  const family = '👨‍👩‍👧‍👦';
  assert.equal(h.truncateByWidth('界'.repeat(31) + family + '尾', h.limit), '界'.repeat(31) + family);
});
test('saving longer titles preserves timestamps, pinning and unrelated history', () => {
  const h = harness();
  const conv = { id: 'fixture', title: '界'.repeat(40), updatedAt: '2026-01-01T00:00:00Z', pinned: true, turns: [{ user: 'fixture' }], sessionId: 'same-session' };
  h.saveConversation(conv);
  assert.deepEqual(h.records[0], { ...conv, title: '界'.repeat(32) });
  assert.equal(h.records[0].updatedAt, '2026-01-01T00:00:00Z');
  const old = { ...conv, title: '旧标题' };
  h.saveConversation(old);
  assert.equal(h.records[1].title, '旧标题');
});
