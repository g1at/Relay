'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { registerHistoryIpc } = require('../src/main/app/history-ipc');
const { createHistoryStore } = require('../src/main/app/history-store');

const clone = value => JSON.parse(JSON.stringify(value));
const originalTime = '2026-01-01T00:00:00.000Z';
const composer = (model = 'unknown-gateway::media::future-model') => ({
  model, parameters: { duration: 0, audio: false, negativePrompt: '', seed: -1, customParameter: null },
});
function conversation(id, changes = {}) {
  return { id, kind: 'create', title: `Title ${id}`, createdAt: originalTime, updatedAt: originalTime,
    pinned: true, turns: [{ runId: `run-${id}`, prompt: 'Original request', resultPaths: ['fixture.png'] }], ...changes };
}
function fixture(t, records = [conversation('create-a'), conversation('create-b')]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-creation-composer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = createHistoryStore({ getUserDataDir: () => directory, recoverLegacyOutput: value => value });
  history.writeHistoryIndex([]);
  for (const record of records) history.persistConversationRecord(clone(record));
  const handlers = new Map(), blocked = new Set(), checks = [], writes = [];
  let writeFailure = null;
  registerHistoryIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    history: { ...history, persistConversationRecord: value => {
      if (writeFailure === 'throw') throw new Error('fixture write failed');
      if (writeFailure === 'deny') return false;
      writes.push({ type: 'metadata', value: clone(value) });
      return history.persistConversationRecord(value);
    } },
    projects: { initialize() {}, getStore: () => ({ binding: () => null }), projectConversation: value => value },
    nativeHistory: {}, isMiniChatActive: () => false,
    saveConversation: value => { writes.push({ type: 'content', value: clone(value) }); return history.persistConversationRecord(value); },
    deleteConversation() {}, genId: () => 'new-create', protectSdkMetadata() {},
    assertConversationAvailable: id => {
      checks.push(id);
      if (blocked.has(id)) throw Object.assign(new Error('会话正在删除'), { code: 'CONVERSATION_DELETING' });
    },
  });
  return { directory, history, blocked, checks, writes,
    failWrites: mode => { writeFailure = mode; },
    call: (name, value) => handlers.get(`history:${name}`)(null, value),
  };
}

test('creation composer update preserves latest content and activity order while isolating conversations and values', t => {
  const f = fixture(t), beforeA = f.history.loadConversation('create-a'), beforeB = f.history.loadConversation('create-b');
  const beforeList = f.call('list');
  const request = { id: 'create-a', mediaComposer: composer(), title: 'Must not rename', turns: [], updatedAt: '2099-01-01' };
  const result = f.call('updateCreationComposer', request);
  assert.equal(result.ok, true); assert.equal(result.id, 'create-a');
  assert.deepEqual(result.mediaComposer, composer());
  assert.deepEqual(f.history.loadConversation('create-a'), { ...beforeA, mediaComposer: composer() });
  assert.deepEqual(f.history.loadConversation('create-b'), beforeB);
  assert.deepEqual(f.call('list'), beforeList, 'metadata-only updates must not reorder history');
  assert.deepEqual(f.checks, ['create-a']);
  request.mediaComposer.parameters.duration = 20;
  result.mediaComposer.parameters.audio = true;
  assert.deepEqual(f.history.loadConversation('create-a').mediaComposer, composer(), 'input and returned objects must not alias saved state');

  const latest = f.history.loadConversation('create-a');
  latest.turns.push({ prompt: 'Background result', resultPaths: ['new-result.png'] });
  latest.title = 'Latest title'; latest.updatedAt = '2026-02-01T00:00:00.000Z';
  f.history.persistConversationRecord(latest);
  const second = composer('another-gateway::media::unlisted-image-model');
  second.parameters = { unknownOption: 'keep this', count: 0, enabled: false, text: '' };
  assert.equal(f.call('updateCreationComposer', { id: 'create-a', mediaComposer: second }).ok, true);
  assert.deepEqual(f.history.loadConversation('create-a'), { ...latest, mediaComposer: second });
  assert.equal(f.call('updateCreationComposer', { id: 'create-b', mediaComposer: composer('independent::media::video') }).ok, true);
  assert.deepEqual(f.history.loadConversation('create-a').mediaComposer, second);
  assert.equal(f.history.loadConversation('create-b').mediaComposer.model, 'independent::media::video');
});

test('ordinary saves cannot restore a stale composer or remove the latest dedicated update', t => {
  const original = conversation('create-a', { mediaComposer: composer('old::media::image') });
  const f = fixture(t, [original]);
  const current = composer('new::media::video');
  current.parameters = { duration: 6, audio: false };
  f.call('updateCreationComposer', { id: original.id, mediaComposer: current });
  for (const staleValue of [undefined, composer('old::media::image'), { model: 'forged', parameters: { duration: 99 } }]) {
    const stale = clone(original);
    if (staleValue === undefined) delete stale.mediaComposer; else stale.mediaComposer = staleValue;
    stale.turns.push({ prompt: 'Finished in the background', resultPaths: ['finished.png'] });
    const result = f.call('save', stale);
    assert.equal(result.id, original.id);
    const saved = f.history.loadConversation(original.id);
    assert.deepEqual(saved.mediaComposer, current);
    assert.equal(saved.turns.length, 2);
    assert.notEqual(saved.updatedAt, original.updatedAt, 'ordinary content saves keep their existing activity semantics');
  }
});

test('only a new create record can initialize a composer through ordinary history save', t => {
  const f = fixture(t);
  const result = f.call('save', { kind: 'create', title: 'New', turns: [], mediaComposer: composer() });
  assert.equal(result.id, 'new-create');
  assert.deepEqual(f.history.loadConversation(result.id).mediaComposer, composer());
  const old = f.history.loadConversation('create-a');
  f.call('save', { ...old, mediaComposer: composer('stale::media::value') });
  assert.equal(Object.hasOwn(f.history.loadConversation('create-a'), 'mediaComposer'), false);
  const malformed = f.call('save', { id: 'invalid-new', kind: 'create', turns: [], mediaComposer: { model: 'x', parameters: { nested: {} } } });
  assert.equal(malformed.ok, false); assert.equal(malformed.code, 'INVALID_CREATION_COMPOSER');
  assert.equal(fs.existsSync(f.history.convFilePath('invalid-new')), false);
  const chat = f.call('save', { id: 'new-chat', kind: 'chat', turns: [], mediaComposer: composer() });
  assert.equal(chat.ok, false); assert.equal(chat.code, 'NOT_CREATION_CONVERSATION');
  assert.equal(fs.existsSync(f.history.convFilePath('new-chat')), false);
});

test('composer metadata cannot create, resurrect or modify non-creation conversations', t => {
  const f = fixture(t, [conversation('create-a'), conversation('chat-a', { kind: 'chat' })]);
  f.blocked.add('create-a');
  for (const [id, code] of [['missing', 'CONVERSATION_NOT_FOUND'], ['create-a', 'CONVERSATION_DELETING'], ['chat-a', 'NOT_CREATION_CONVERSATION'],
    [undefined, 'INVALID_CONVERSATION_ID'], ['../escape', 'INVALID_CONVERSATION_ID'], ['index', 'INVALID_CONVERSATION_ID']]) {
    const result = f.call('updateCreationComposer', { id, mediaComposer: composer() });
    assert.equal(result.ok, false); assert.equal(result.code, code);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(f.history.convFilePath('missing')), false);
  assert.deepEqual(f.history.loadConversation('create-a'), conversation('create-a'));
  assert.deepEqual(f.history.loadConversation('chat-a'), conversation('chat-a', { kind: 'chat' }));
});

test('composer validation rejects nonserializable, nested, reference and credential payloads without writing', t => {
  const f = fixture(t);
  const invalid = [null, [], {}, { model: '', parameters: {} }, { model: 'x'.repeat(1025), parameters: {} },
    { model: 'bad\nmodel', parameters: {} }, { ...composer(), references: [] },
    { model: 'valid', parameters: [] }, { model: 'valid', parameters: null }];
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => {}, [], {}, new Date()]) {
    invalid.push({ model: 'valid', parameters: { option: value } });
  }
  for (const key of ['apiKey', 'api_key', 'authorization', 'token', 'credentials', 'references', 'image_urls', 'refPaths', 'base64', '__proto__', 'constructor']) {
    invalid.push({ model: 'valid', parameters: Object.fromEntries([[key, 'fixture value']]) });
  }
  invalid.push({ model: 'valid', parameters: { option: 'data:image/png;base64,fixture' } },
    { model: 'valid', parameters: { ['x'.repeat(129)]: 1 } },
    { model: 'valid', parameters: { option: 'x'.repeat(4097) } },
    { model: 'valid', parameters: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`option${i}`, i])) },
    { model: 'valid', parameters: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`option${i}`, 'x'.repeat(1024)])) });
  for (const mediaComposer of invalid) {
    const result = f.call('updateCreationComposer', { id: 'create-a', mediaComposer });
    assert.equal(result.ok, false); assert.equal(result.code, 'INVALID_CREATION_COMPOSER');
  }
  assert.equal(f.writes.length, 0);
  assert.equal(Object.hasOwn(f.history.loadConversation('create-a'), 'mediaComposer'), false);
});

test('failed composer persistence reports failure and preserves the original disk record', t => {
  const original = conversation('create-a', { mediaComposer: composer('original::media::model') });
  const f = fixture(t, [original]);
  for (const mode of ['deny', 'throw']) {
    f.failWrites(mode);
    const result = f.call('updateCreationComposer', { id: original.id, mediaComposer: composer('changed::media::model') });
    assert.equal(result.ok, false); assert.equal(result.code, 'CREATION_COMPOSER_SAVE_FAILED');
    assert.deepEqual(f.history.loadConversation(original.id), original);
  }
});

test('preload exposes creation composer updates through the dedicated metadata IPC', async () => {
  let api;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'api'); api = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } }, webUtils: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return electron; }, process: { platform: 'win32', argv: [] },
  });
  const input = { id: 'create-a', mediaComposer: composer() };
  assert.deepEqual(await api.history.updateCreationComposer(input), { ok: true });
  assert.deepEqual(calls, [['history:updateCreationComposer', input]]);
});
