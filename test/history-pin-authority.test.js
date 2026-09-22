'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute only the production IPC handlers with an in-memory history store.
// No Electron process, user history, provider, or task is started.
const moduleFile = path.join(__dirname, '../src/main/app/history-ipc.js');
const source = fs.readFileSync(moduleFile, 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const originalTime = '2020-02-01T00:00:00.000Z';
function fixture(initial = []) {
  const records = new Map(initial.map(record => [record.id, clone(record)]));
  const handlers = new Map(), writes = [], indexOverrides = new Map();
  const context = {
    protectSdkMetadata: require('../src/main/sdk/sdk-session-provenance').protectSdkMetadata,
    miniChat: null,
    Date, fs: { existsSync: id => records.has(id) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    convFilePath: id => id, genId: () => 'generated-new-id',
    loadConversation: id => clone(records.get(id) || null),
    saveConversation: value => { writes.push(clone(value)); records.set(value.id, clone(value)); },
    readHistoryIndex: () => [...records.values()].map(value => ({ ...clone(value), ...indexOverrides.get(value.id) })),
    initializeProjectHistory() {},
    getProjectStore: () => ({ binding: () => 'authoritative-project' }),
    projectConversation: value => ({ ...value, projectId: 'authoritative-project', workingDir: { path: '/synthetic/project' } }),
  };
  const loaded = { exports: {} };
  vm.runInNewContext(source, {
    module: loaded, require: name => { assert.equal(name, 'fs'); return context.fs; },
  }, { filename: moduleFile });
  loaded.exports.registerHistoryIpc({
    ipcMain: context.ipcMain,
    history: {
      readHistoryIndex: context.readHistoryIndex, loadConversation: context.loadConversation,
      convFilePath: context.convFilePath, persistConversationRecord: context.saveConversation,
      forEachConversation: visitor => [...records.values()].forEach(visitor),
    },
    projects: {
      initialize: context.initializeProjectHistory, getStore: context.getProjectStore,
      projectConversation: context.projectConversation,
    },
    nativeHistory: {}, isMiniChatActive: () => false,
    saveConversation: context.saveConversation, deleteConversation: id => records.delete(id),
    genId: context.genId, protectSdkMetadata: context.protectSdkMetadata,
  });
  return { records, writes, indexOverrides, call: (name, ...args) => handlers.get('history:' + name)(null, ...args) };
}
function conversation(pinned) {
  return { id: 'existing', title: 'Original title', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: originalTime,
    pinned, sessionId: 'same-session', sessionProviderId: 'same-provider', sessionProviderRevision: 7,
    turns: [{ user: 'Original request', assistant: 'Original answer' }] };
}

for (const before of [true, false]) {
  test(`a stale ${before ? 'pinned' : 'unpinned'} renderer save cannot reverse the latest dedicated pin change`, () => {
    const original = conversation(before), staleRenderer = clone(original), h = fixture([original]);
    const changed = h.call('setPinned', { id: original.id, pinned: !before });
    assert.equal(changed.ok, true); assert.equal(changed.pinned, !before);
    assert.equal(h.records.get(original.id).updatedAt, originalTime, 'pinning is metadata only');
    staleRenderer.turns.push({ user: 'Later request', assistant: 'Later answer' });
    const result = h.call('save', staleRenderer), saved = h.records.get(original.id);
    assert.equal(saved.pinned, !before, 'ordinary saves must retain the current server pin state');
    assert.equal(saved.turns.length, 2); assert.equal(saved.sessionId, original.sessionId);
    assert.equal(saved.sessionProviderId, original.sessionProviderId); assert.equal(saved.sessionProviderRevision, 7);
    assert.equal(saved.createdAt, original.createdAt); assert.notEqual(saved.updatedAt, originalTime);
    assert.equal(result.updatedAt, saved.updatedAt); assert.equal(result.id, original.id);
    assert.equal(saved.projectId, 'authoritative-project'); assert.equal(result.projectId, saved.projectId);
    assert.equal(saved.workingDir.path, '/synthetic/project');
  });
}

test('existing missing or false pin values stay unpinned despite an explicit stale true value', () => {
  for (const pinned of [undefined, false]) {
    const original = conversation(pinned), h = fixture([original]);
    h.call('save', { ...clone(original), pinned: true });
    assert.equal(h.records.get(original.id).pinned, false);
  }
});

test('content saves preserve the body pin state even if the lightweight index still has an older value', () => {
  const original = conversation(false), h = fixture([original]);
  h.indexOverrides.set(original.id, { pinned: true });
  h.call('save', { ...clone(original), pinned: true });
  assert.equal(h.records.get(original.id).pinned, false);
});

test('new histories retain explicit pin initialization and generated IDs without changing content-save semantics', () => {
  for (const pinned of [undefined, false, true]) {
    const h = fixture(), input = { title: 'New request', turns: [], ...(pinned === undefined ? {} : { pinned }) };
    const result = h.call('save', input), saved = h.records.get(result.id);
    assert.equal(result.id, 'generated-new-id'); assert.equal(saved.pinned, pinned);
    assert.equal(saved.createdAt, saved.updatedAt); assert.equal(saved.updatedAt, result.updatedAt);
  }
});

test('pin and unpin preserve activity timestamps while list order remains pinned first then newest activity', () => {
  const old = conversation(false), recent = { ...conversation(false), id: 'recent', updatedAt: '2020-03-01T00:00:00.000Z' };
  const h = fixture([old, recent]);
  assert.deepEqual(Array.from(h.call('list'), row => row.id), ['recent', 'existing']);
  h.call('setPinned', { id: old.id, pinned: true });
  assert.deepEqual(Array.from(h.call('list'), row => row.id), ['existing', 'recent']);
  h.call('setPinned', { id: recent.id, pinned: true });
  assert.deepEqual(Array.from(h.call('list'), row => row.id), ['recent', 'existing']);
  h.call('setPinned', { id: old.id, pinned: false });
  assert.equal(h.records.get(old.id).updatedAt, old.updatedAt); assert.equal(h.records.get(recent.id).updatedAt, recent.updatedAt);
});
