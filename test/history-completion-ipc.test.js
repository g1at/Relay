'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerHistoryIpc } = require('../src/main/app/history-ipc');
const { createConversationCompletionState } = require('../src/main/app/conversation-completion-state');

const at = '2026-10-23T04:00:00.000Z';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function ended(conversationId = 'old-chat', runId = 'run-a') {
  return { previous: { state: 'running' }, run: { runId, state: 'succeeded', endedAt: at,
    source: { type: 'conversation', conversationId } } };
}
function fixture(t, { withCompletions = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-completion-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'completion-state.json');
  const records = new Map([
    ['old-chat', { id: 'old-chat', title: 'Older conversation', updatedAt: '2020-01-01T00:00:00.000Z', turns: [] }],
    ['recent-chat', { id: 'recent-chat', title: 'Recent conversation', updatedAt: '2020-03-01T00:00:00.000Z', turns: [] }],
    ['pinned-chat', { id: 'pinned-chat', title: 'Pinned conversation', pinned: true, updatedAt: '2019-01-01T00:00:00.000Z', turns: [] }],
  ]);
  const writes = [], changes = [], errors = [], handlers = new Map();
  const completionState = createConversationCompletionState({ filePath, onChange: value => changes.push(value), onError: value => errors.push(value) });
  const convFilePath = id => path.join(directory, `${id}.json`);
  for (const [id, value] of records) fs.writeFileSync(convFilePath(id), JSON.stringify(value));
  const saveConversation = value => { writes.push(clone(value)); records.set(value.id, clone(value)); };
  registerHistoryIpc({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    history: { readHistoryIndex: () => [...records.values()].map(clone),
      loadConversation: id => clone(records.get(id) || null), convFilePath,
      persistConversationRecord: saveConversation },
    projects: { initialize() {}, getStore: () => ({ binding: () => null }), projectConversation: value => value },
    nativeHistory: {}, isMiniChatActive: () => false,
    saveConversation, deleteConversation: id => ({ ok: records.delete(id) }),
    genId: () => 'new-chat', protectSdkMetadata() {},
    ...(withCompletions ? { completionState } : {}),
  });
  return { directory, filePath, completionState, records, writes, changes, errors,
    call: (name, ...args) => {
      const handler = handlers.get(`history:${name}`);
      assert.equal(typeof handler, 'function', `registered history:${name}`);
      return handler(null, ...args);
    } };
}

test('completion IPC snapshots return durable metadata without sharing mutable state', t => {
  const f = fixture(t);
  assert.deepEqual(f.call('completionSnapshot'), { revision: 0, items: [] });
  f.completionState.observe(ended());
  const snapshot = f.call('completionSnapshot');
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.items[0].conversationId, 'old-chat');
  snapshot.items[0].runId = 'forged'; snapshot.items.length = 0;
  assert.equal(f.call('completionSnapshot').items[0].runId, 'run-a');
  assert.deepEqual(createConversationCompletionState({ filePath: f.filePath }).snapshot(), f.call('completionSnapshot'));
});

test('only an acknowledgement for the latest run clears that conversation', t => {
  const f = fixture(t);
  f.completionState.observe(ended());
  f.completionState.observe(ended('recent-chat', 'run-other'));
  f.completionState.observe(ended('old-chat', 'run-newer'));
  const stale = f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' });
  assert.equal(stale.ok, true); assert.equal(stale.changed, false);
  assert.deepEqual(stale.items.map(item => item.runId), ['run-newer', 'run-other']);
  const wrongConversation = f.call('markCompletionRead', { id: 'recent-chat', runId: 'run-newer' });
  assert.equal(wrongConversation.changed, false);
  const read = f.call('markCompletionRead', { id: 'old-chat', runId: 'run-newer' });
  assert.equal(read.ok, true); assert.equal(read.changed, true); assert.equal(read.revision, 4);
  assert.deepEqual(read.items.map(item => item.conversationId), ['recent-chat']);
  assert.equal(f.call('markCompletionRead', { id: 'old-chat', runId: 'run-newer' }).changed, false);
  assert.equal(f.changes.length, 4);
});

test('completion arrival, history loading and acknowledgement preserve list order and activity times', async t => {
  const f = fixture(t);
  const original = [...f.records.values()].map(clone);
  const before = f.call('list');
  assert.deepEqual(before.map(item => item.id), ['pinned-chat', 'recent-chat', 'old-chat']);
  f.completionState.observe(ended());
  assert.deepEqual(f.call('list'), before, 'arrival cannot reorder history');
  assert.equal((await f.call('load', 'old-chat')).id, 'old-chat');
  assert.equal(f.call('completionSnapshot').items.length, 1, 'loading does not prove content was viewed');
  f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' });
  assert.deepEqual(f.call('list'), before, 'reading cannot reorder history');
  assert.deepEqual([...f.records.values()], original);
  assert.equal(f.writes.length, 0, 'completion IPC does not save conversation content or index metadata');
});

test('a stale conversation content save cannot restore a read dot or clear a newer completion', t => {
  const f = fixture(t);
  const stale = clone(f.records.get('old-chat'));
  f.completionState.observe(ended());
  f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' });
  f.call('save', { ...stale, turns: [{ user: 'Request', assistant: 'First answer' }] });
  assert.deepEqual(f.call('completionSnapshot'), { revision: 2, items: [] });
  f.completionState.observe(ended('old-chat', 'run-newer'));
  f.call('save', { ...stale, turns: [{ user: 'Request', assistant: 'Stale answer' }] });
  assert.equal(f.call('completionSnapshot').items[0].runId, 'run-newer');
  assert.equal(f.call('completionSnapshot').revision, 3);
});

test('IPC rejects malformed acknowledgements without changing the unread state', t => {
  const f = fixture(t);
  f.completionState.observe(ended());
  for (const payload of [undefined, null, {}, { id: 'old-chat' }, { id: '../escape', runId: 'run-a' },
    { id: 'old-chat', runId: {} }, { id: 'index', runId: 'run-a' }]) {
    const result = f.call('markCompletionRead', payload);
    assert.equal(result.ok, false); assert.equal(result.changed, false);
  }
  assert.equal(f.call('completionSnapshot').revision, 1);
  assert.equal(f.changes.length, 1);
});

test('an unsuccessful durable acknowledgement returns failure and leaves its dot visible', t => {
  const f = fixture(t);
  f.completionState.observe(ended());
  const before = f.call('completionSnapshot');
  const saved = fs.readFileSync(f.filePath, 'utf8');
  fs.unlinkSync(f.filePath); fs.mkdirSync(f.filePath);
  const result = f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' });
  assert.equal(result.ok, false); assert.equal(result.changed, false);
  assert.equal(result.code, 'COMPLETION_STATE_WRITE_FAILED');
  assert.deepEqual(f.call('completionSnapshot'), before);
  assert.equal(f.changes.length, 1); assert.equal(f.errors.length, 1);
  fs.rmdirSync(f.filePath); fs.writeFileSync(f.filePath, saved);
  assert.equal(f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' }).changed, true);
  assert.deepEqual(createConversationCompletionState({ filePath: f.filePath }).snapshot(), { revision: 2, items: [] });
});

test('embedders without a completion service expose an empty snapshot and do not invent a successful read', t => {
  const f = fixture(t, { withCompletions: false });
  assert.deepEqual(f.call('completionSnapshot'), { revision: 0, items: [] });
  const result = f.call('markCompletionRead', { id: 'old-chat', runId: 'run-a' });
  assert.equal(result.ok, false); assert.equal(result.changed, false);
  assert.equal(f.writes.length, 0);
});

// Exercise the production bootstrap seams without loading Electron or its
// startup side effects. Dependencies are synthetic; the completion store is real.
const vm = require('node:vm');
const bootstrapFile = path.join(__dirname, '../src/main/bootstrap.js');
const bootstrapSource = fs.readFileSync(bootstrapFile, 'utf8');
function bootstrapFunction(name, nextName) {
  const start = bootstrapSource.indexOf(`function ${name}(`);
  const end = bootstrapSource.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `extract ${name}`);
  return bootstrapSource.slice(start, end);
}
function bootstrapSeams(f, deletion = async id => ({ ok: true, id })) {
  const pendingMiniCompletions = new Map();
  const context = {
    conversationCompletionState: f.completionState, pendingMiniCompletions,
    getConversationDeletion: () => ({ delete: deletion }),
    isTerminalState: state => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(state),
    publicTaskRun: () => null, process: { platform: 'linux' },
    turnDeliveryService: null, flushShadowTaskEvents() {}, taskProgressWriteAt: new Map(),
    RUN_STATES: { SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'canceled' },
    redactTaskText: value => value, scheduleTaskLedgerRetention() {}, console,
    taskLedger: { terminal(runId, state, details) {
      return { runId, state, source: { type: 'schedule', conversationId: 'old-chat', ...details.source }, result: details.result };
    } },
  };
  vm.createContext(context);
  vm.runInContext([
    bootstrapFunction('deleteConversation', 'assertConversationAvailable'),
    bootstrapFunction('broadcastTaskLedgerChange', 'broadcastTaskEnvelope'),
    bootstrapFunction('finishShadowTaskRun', 'requestShadowTaskCancel'),
    bootstrapFunction('finishScheduledShadowRun', 'interruptActiveShadowRuns'),
  ].join('\n'), context, { filename: bootstrapFile });
  const callbackStart = bootstrapSource.indexOf('onFinishedSaved: ');
  const callbackEnd = bootstrapSource.indexOf(',\n    onHistoryChanged:', callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart, 'extract mini persisted-result callback');
  const callbackSource = bootstrapSource.slice(callbackStart + 'onFinishedSaved: '.length, callbackEnd);
  const finishMini = vm.runInContext(`(${callbackSource})`, context, { filename: bootstrapFile });
  return { context, pendingMiniCompletions, finishMini };
}

test('successful history deletion clears only that conversation and its deferred mini completion', async t => {
  const f = fixture(t), b = bootstrapSeams(f);
  f.completionState.observe(ended()); f.completionState.observe(ended('recent-chat', 'run-b'));
  const mini = ended('old-chat', 'mini-run'); mini.run.source.type = 'mini';
  const otherMini = ended('recent-chat', 'other-mini'); otherMini.run.source.type = 'mini';
  b.context.broadcastTaskLedgerChange(mini); b.context.broadcastTaskLedgerChange(otherMini);
  const result = await b.context.deleteConversation('old-chat');
  assert.equal(result.ok, true);
  assert.deepEqual(f.completionState.snapshot().items.map(value => value.conversationId), ['recent-chat']);
  assert.deepEqual([...b.pendingMiniCompletions.keys()], ['other-mini']);
  b.finishMini({ runId: 'mini-run' });
  assert.equal(f.completionState.snapshot().items.some(value => value.conversationId === 'old-chat'), false, 'a late save callback cannot revive deleted unread state');
});

test('refused or rejected history deletion leaves durable and deferred reminders intact', async t => {
  const f = fixture(t);
  f.completionState.observe(ended());
  for (const deletion of [async () => ({ ok: false, code: 'CONVERSATION_RUNNING' }), async () => { throw Error('delete failed'); }]) {
    const b = bootstrapSeams(f, deletion);
    const mini = ended('old-chat', 'mini-run'); mini.run.source.type = 'mini';
    b.context.broadcastTaskLedgerChange(mini);
    try { await b.context.deleteConversation('old-chat'); } catch (error) { assert.equal(error.message, 'delete failed'); }
    assert.equal(f.completionState.snapshot().items[0].runId, 'run-a');
    assert.equal(b.pendingMiniCompletions.has('mini-run'), true);
  }
});

test('mini completion is published only after its exact final turn save callback', t => {
  const f = fixture(t), b = bootstrapSeams(f);
  const mini = ended('old-chat', 'mini-run'); mini.run.source.type = 'mini';
  b.context.broadcastTaskLedgerChange(mini);
  assert.deepEqual(f.completionState.snapshot(), { revision: 0, items: [] });
  assert.equal(b.pendingMiniCompletions.has('mini-run'), true);
  b.finishMini({ runId: 'another-run' });
  assert.equal(f.completionState.snapshot().items.length, 0);
  b.finishMini({ runId: 'mini-run' });
  assert.equal(f.completionState.snapshot().items[0].runId, 'mini-run');
  assert.equal(b.pendingMiniCompletions.size, 0);
  b.finishMini({ runId: 'mini-run' });
  b.context.broadcastTaskLedgerChange({ ...mini, previous: { state: 'succeeded' } });
  assert.equal(f.completionState.snapshot().revision, 1, 'terminal replay cannot re-notify');
});

test('scheduled tasks without history cannot attach a completion to their previous workspace conversation', t => {
  const f = fixture(t), b = bootstrapSeams(f);
  const run = b.context.finishScheduledShadowRun('scheduled-command', { ok: true, summary: 'Command finished' });
  assert.equal(run.source.conversationId, 'old-chat');
  assert.equal(Object.hasOwn(run.result, 'conversationId'), true);
  assert.equal(run.result.conversationId, null);
  assert.equal(f.completionState.observe({ run, previous: { state: 'running' } }), false);
  assert.equal(f.completionState.snapshot().items.length, 0);
});

test('scheduled output ownership is preserved and ordinary task results do not invent an output conversation', t => {
  const f = fixture(t), b = bootstrapSeams(f);
  const scheduled = b.context.finishScheduledShadowRun('scheduled-output', { ok: true, conversationId: 'new-output', conversationKind: 'create' });
  assert.equal(scheduled.source.conversationId, 'new-output');
  assert.equal(scheduled.result.conversationId, 'new-output');
  assert.equal(f.completionState.observe({ run: scheduled, previous: { state: 'running' } }), true);
  assert.equal(f.completionState.snapshot().items[0].conversationId, 'new-output');
  const ordinary = b.context.finishShadowTaskRun('ordinary-task', true, { summary: 'Complete' });
  assert.equal(Object.hasOwn(ordinary.result, 'conversationId'), false);
});
