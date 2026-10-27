'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationCompletionState } = require('../src/main/app/conversation-completion-state');

const at = '2026-10-23T04:00:00.000Z';
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-completion-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'metadata', 'completions.json');
  const changes = [], errors = [];
  const options = { filePath, now: () => new Date(at), onChange: value => changes.push(value), onError: value => errors.push(value), ...overrides };
  return { directory, filePath, changes, errors, options, state: createConversationCompletionState(options) };
}
function end(conversationId = 'chat-a', runId = 'run-a', patch = {}, previous = { state: 'running' }) {
  return { previous, run: { runId, state: 'succeeded', source: { type: 'conversation', conversationId }, endedAt: at, ...patch } };
}

test('fresh installs start without backfilling old task completions', t => {
  const f = fixture(t);
  assert.deepEqual(f.state.snapshot(), { revision: 0, items: [] });
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(f.state.observe(end('chat-a', 'old-run', {}, null)), false);
  assert.equal(fs.existsSync(f.filePath), false);
});

test('only successful and failed parent task transitions create completion reminders', t => {
  const f = fixture(t);
  for (const state of ['queued', 'starting', 'running', 'waiting_user', 'stopping', 'canceled', 'interrupted']) {
    assert.equal(f.state.observe(end('chat-a', `run-${state}`, { state })), false);
  }
  for (const state of ['succeeded', 'failed', 'canceled', 'interrupted', 'unknown']) {
    assert.equal(f.state.observe(end('chat-a', `previous-${state}`, {}, { state })), false);
  }
  assert.equal(f.state.observe(end('chat-a', 'child', { lineage: { parentRunId: 'parent' } })), false);
  assert.equal(f.state.observe(end('chat-a', 'internal', { source: { type: 'skill-review', conversationId: 'chat-a' } })), false);
  assert.equal(f.state.observe(end()), true);
  assert.equal(f.state.observe(end('chat-b', 'run-b', { state: 'failed' })), true);
  assert.deepEqual(f.state.snapshot().items.map(item => item.status), ['succeeded', 'failed']);
  assert.equal(f.state.snapshot().revision, 2);
});

test('chat, mini, image and scheduled output conversations share one reminder mechanism', t => {
  const f = fixture(t);
  for (const type of ['conversation', 'mini', 'creation', 'schedule']) {
    assert.equal(f.state.observe(end(type, `run-${type}`, { source: { type, conversationId: type } })), true);
  }
  assert.equal(f.state.snapshot().items.length, 4);
  assert.equal(f.state.observe(end(null, 'schedule-output', {
    source: { type: 'schedule', conversationId: 'workspace' }, result: { conversationId: 'new-output' },
  })), true);
  assert.ok(f.state.snapshot().items.some(item => item.conversationId === 'new-output'));
  assert.ok(!f.state.snapshot().items.some(item => item.conversationId === 'workspace'));
  assert.equal(f.state.observe(end(null, 'no-output', {
    source: { type: 'schedule', conversationId: 'old-output' }, result: { conversationId: null },
  })), false);
});

test('state survives reload; notifications are emitted only after the disk commit', t => {
  const f = fixture(t);
  const state = createConversationCompletionState({ ...f.options, onChange: value => {
    const disk = JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
    assert.equal(disk.revision, value.revision);
    assert.deepEqual(disk.items, value.items);
    f.changes.push(value);
  } });
  state.observe(end());
  const restored = createConversationCompletionState(f.options);
  assert.deepEqual(restored.snapshot(), state.snapshot());
  assert.equal(f.changes.length, 1);
  const read = restored.markRead('chat-a', 'run-a');
  assert.equal(read.ok, true); assert.equal(read.changed, true); assert.equal(read.revision, 2);
  assert.deepEqual(createConversationCompletionState(f.options).snapshot(), { revision: 2, items: [] });
});

test('one conversation has one dot; stale acknowledgements cannot clear its newer completion', t => {
  const f = fixture(t);
  f.state.observe(end());
  assert.equal(f.state.observe(end()), false);
  assert.equal(f.state.snapshot().revision, 1);
  f.state.observe(end('chat-a', 'run-b'));
  const stale = f.state.markRead('chat-a', 'run-a');
  assert.equal(stale.ok, true); assert.equal(stale.changed, false); assert.equal(stale.revision, 2);
  assert.deepEqual(stale.items.map(item => item.runId), ['run-b']);
  assert.equal(f.state.markRead('chat-a', 'run-b').changed, true);
  assert.equal(f.state.markRead('chat-a', 'run-b').changed, false);
  assert.equal(f.state.observe(end('chat-a', 'run-b', {}, { state: 'succeeded' })), false);
  assert.deepEqual(f.state.snapshot(), { revision: 3, items: [] });
});

test('acknowledgement and deletion affect only the named conversation', t => {
  const f = fixture(t);
  f.state.observe(end()); f.state.observe(end('chat-b', 'run-b'));
  assert.equal(f.state.markRead('chat-b', 'run-a').changed, false);
  assert.equal(f.state.remove('chat-a'), true);
  assert.equal(f.state.remove('chat-a'), false);
  assert.deepEqual(f.state.snapshot().items.map(item => item.conversationId), ['chat-b']);
  assert.deepEqual(createConversationCompletionState(f.options).snapshot(), f.state.snapshot());
});

test('invalid identifiers and missing owners never mutate durable reminders', t => {
  const f = fixture(t);
  f.state.observe(end());
  for (const value of [null, undefined, '', '../escape', 'index', 'a'.repeat(129), {}, 12]) {
    assert.equal(f.state.observe(end('unused', 'other-run', { source: { type: 'conversation', conversationId: value } })), false);
    assert.equal(f.state.observe(end('chat-b', 'unused', { runId: value })), false);
    assert.equal(f.state.markRead(value, 'run-a').ok, false);
    assert.equal(f.state.markRead('chat-a', value).ok, false);
    assert.equal(f.state.remove(value), false);
  }
  assert.equal(f.state.snapshot().revision, 1);
});

test('snapshot callers cannot mutate store state', t => {
  const f = fixture(t);
  f.state.observe(end());
  const snapshot = f.state.snapshot(); snapshot.items[0].runId = 'forged'; snapshot.items.length = 0;
  assert.equal(f.state.snapshot().items[0].runId, 'run-a');
  const acknowledgement = f.state.markRead('chat-a', 'stale'); acknowledgement.items[0].runId = 'forged';
  assert.equal(f.state.snapshot().items[0].runId, 'run-a');
});

test('completion metadata writes never touch conversation history or activity timestamps', t => {
  const f = fixture(t);
  const history = path.join(f.directory, 'history'); fs.mkdirSync(history);
  const body = path.join(history, 'chat-a.json'), index = path.join(history, 'index.json');
  const record = JSON.stringify({ id: 'chat-a', updatedAt: '2020-01-01T00:00:00.000Z', turns: [] });
  fs.writeFileSync(body, record); fs.writeFileSync(index, record);
  const bodyTime = fs.statSync(body).mtimeMs, indexTime = fs.statSync(index).mtimeMs;
  f.state.observe(end()); f.state.markRead('chat-a', 'run-a');
  assert.equal(fs.readFileSync(body, 'utf8'), record); assert.equal(fs.readFileSync(index, 'utf8'), record);
  assert.equal(fs.statSync(body).mtimeMs, bodyTime); assert.equal(fs.statSync(index).mtimeMs, indexTime);
});

test('disk write failures retain the previous snapshot and do not broadcast success', t => {
  const f = fixture(t);
  f.state.observe(end());
  const previous = f.state.snapshot(), original = fs.readFileSync(f.filePath, 'utf8');
  fs.rmSync(f.filePath); fs.mkdirSync(f.filePath);
  assert.equal(f.state.observe(end('chat-b', 'run-b')), false);
  const result = f.state.markRead('chat-a', 'run-a');
  assert.equal(result.ok, false); assert.equal(result.code, 'COMPLETION_STATE_WRITE_FAILED');
  assert.deepEqual(f.state.snapshot(), previous); assert.equal(f.changes.length, 1);
  assert.equal(f.errors.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(f.filePath)), ['completions.json']);
  fs.rmdirSync(f.filePath); fs.writeFileSync(f.filePath, original);
  assert.equal(f.state.markRead('chat-a', 'run-a').ok, true);
});

test('corrupt metadata and throwing listeners cannot break authoritative task completion', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.filePath)); fs.writeFileSync(f.filePath, '{bad json');
  const state = createConversationCompletionState({ ...f.options, onChange: () => { throw Error('renderer closed'); } });
  assert.deepEqual(state.snapshot(), { revision: 0, items: [] });
  assert.equal(state.observe(end()), true);
  assert.equal(f.errors.length, 2);
  assert.equal(createConversationCompletionState(f.options).snapshot().items[0].runId, 'run-a');
});

test('load validates entries and completion timestamps fall back to authoritative update time', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.filePath));
  fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, revision: 9, items: [
    { conversationId: 'valid', runId: 'run-valid', status: 'succeeded', completedAt: at },
    { conversationId: '../bad', runId: 'bad', status: 'succeeded', completedAt: at },
    { conversationId: 'bad-time', runId: 'bad-time', status: 'succeeded', completedAt: 'invalid' },
  ] }));
  const state = createConversationCompletionState(f.options);
  assert.deepEqual(state.snapshot().items.map(item => item.conversationId), ['valid']);
  state.observe(end('other', 'run-other', { endedAt: 'invalid', updatedAt: '2026-10-23T05:00:00.000Z' }));
  assert.equal(state.snapshot().revision, 10);
  assert.equal(state.snapshot().items[1].completedAt, '2026-10-23T05:00:00.000Z');
  state.observe(end('last', 'run-last', { endedAt: null }));
  assert.equal(state.snapshot().items[2].completedAt, at);
});
