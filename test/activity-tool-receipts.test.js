'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const activity = require('../renderer/activity-stream');
const stream = (state, event) => activity.ingest(state, { type: 'stream_event', event });
const fullTool = (state, id, extra = {}) => activity.ingest(state, { type: 'assistant', uuid: `source-${id}`,
  message: { id: `message-${id}`, content: [{ type: 'tool_use', id, name: 'mcp__fixture__doc_write', input: { markdown: '# Prepared input' } }] }, ...extra });
const receipt = (state, id, content = '', extra = {}) => activity.ingest(state, { type: 'user', uuid: `receipt-${id}`,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra });
function preview(state, id) {
  stream(state, { type: 'message_start', message: { id: `message-${id}` } });
  stream(state, { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id, name: 'mcp__fixture__doc_write', input: { document_id: id } } });
  return state.items.find(item => item.toolUseId === id);
}
const finish = (state, error) => activity.finish(state, error, { relay_task_finished_at: 2000, exitCode: error ? 1 : 0 });

test('parent success leaves streamed previews and complete calls without receipts unconfirmed', () => {
  const state = activity.createState({ startedAt: 1000 });
  const draft = preview(state, 'draft');
  fullTool(state, 'ready');
  activity.ingest(state, { type: 'result', subtype: 'success', result: 'Now prepare the document.' });
  finish(state);
  assert.equal(state.phase, 'complete');
  assert.equal(activity.summaryFor(state).title, '已结束');
  for (const item of state.items) {
    assert.equal(item.status, 'unconfirmed');
    assert.equal(Object.hasOwn(item, 'result'), false);
    assert.equal(Object.hasOwn(item, 'error'), false);
    assert.match(activity.renderItem(item, true), /结果未确认/);
    assert.doesNotMatch(activity.renderItem(item, true), /process-spinner|is-success|is-error/);
  }
  assert.deepEqual(draft.input, { document_id: 'draft' });
  assert.deepEqual(state.items[1].input, { markdown: '# Prepared input' });
});

test('parent error or pause is not a fabricated tool failure receipt', () => {
  for (const error of ['connection closed', '已暂停']) {
    const state = activity.createState();
    preview(state, 'draft');
    finish(state, error);
    assert.equal(state.phase, 'error');
    assert.equal(state.error, error);
    assert.equal(state.items[0].status, 'unconfirmed');
    assert.equal(state.items[0].error, undefined);
  }
});

test('empty string, empty blocks and absent content are genuine tool result receipts after save/load', () => {
  for (const content of ['', [], undefined]) {
    const state = activity.createState();
    fullTool(state, 'empty');
    activity.ingest(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'empty', content }] } });
    finish(state);
    const restored = activity.hydrate(activity.serialize(state));
    assert.equal(restored.items[0].resultConfirmed, true);
    assert.equal(restored.items[0].result, '');
    assert.equal(restored.items[0].status, 'success');
    assert.doesNotMatch(activity.renderItem(restored.items[0]), /结果未确认/);
  }
});

test('late actual receipts settle unconfirmed tools without reopening the parent task', () => {
  for (const isError of [false, true]) {
    const state = activity.createState();
    preview(state, 'late');
    finish(state);
    receipt(state, 'late', '', { message: { content: [{ type: 'tool_result', tool_use_id: 'late', content: '', is_error: isError }] } });
    assert.equal(state.items[0].resultConfirmed, true);
    assert.equal(state.items[0].status, isError ? 'error' : 'success');
    assert.equal(state.phase, 'complete');
    finish(state);
    assert.equal(state.items[0].status, isError ? 'error' : 'success');
  }
});

test('repeat finish, stream block stop/start, heartbeat and retry progress cannot revive terminal tools', () => {
  const state = activity.createState();
  const item = preview(state, 'late-preview');
  finish(state);
  const before = activity.serialize(state).items[0];
  finish(state);
  stream(state, { type: 'content_block_stop', index: 0 });
  stream(state, { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'late-preview', name: 'mcp__fixture__doc_write', input: {} } });
  for (const extra of [{ heartbeat: true }, { subagent_retry: { attempt: 2 } }]) {
    activity.ingest(state, { type: 'tool_progress', tool_use_id: 'late-preview', elapsed_time_seconds: 10, ...extra });
  }
  assert.deepEqual(activity.serialize(state).items[0], before);
  assert.equal(item.status, 'unconfirmed');
  receipt(state, 'late-preview', 'ack');
  stream(state, { type: 'content_block_stop', index: 0 });
  assert.equal(item.status, 'success');
  assert.equal(item.result, 'ack');
});

test('retracted result invalidates its receipt marker and stays superseded at finish', () => {
  const state = activity.createState();
  fullTool(state, 'retracted');
  receipt(state, 'retracted', 'old result');
  activity.ingest(state, { type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: ['receipt-retracted'] });
  assert.equal(state.items[0].resultConfirmed, false);
  assert.equal(state.items[0].status, 'superseded');
  activity.ingest(state, { type: 'tool_progress', tool_use_id: 'retracted', elapsed_time_seconds: 5 });
  receipt(state, 'retracted', 'stale replay');
  finish(state);
  assert.equal(state.items[0].status, 'superseded');
  assert.equal(state.items[0].result, '');
});

test('retracted call ignores late receipts and context reset keeps superseded old tools separate', () => {
  const state = activity.createState();
  fullTool(state, 'removed');
  activity.ingest(state, { type: 'assistant', uuid: 'replacement', supersedes: ['source-removed'], message: { content: [] } });
  receipt(state, 'removed', 'stale');
  assert.equal(state.items.length, 0);
  fullTool(state, 'old-context');
  activity.ingest(state, { type: 'conversation_reset', uuid: 'reset', new_conversation_id: 'new-context' });
  fullTool(state, 'current-context');
  finish(state);
  assert.equal(state.items.find(item => item.toolUseId === 'old-context').status, 'superseded');
  assert.equal(state.items.find(item => item.toolUseId === 'current-context').status, 'unconfirmed');
});

test('background launch receipts and child output retain task completion semantics', () => {
  const state = activity.createState();
  activity.ingest(state, { type: 'assistant', message: { id: 'parent', content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { run_in_background: true } }] } });
  receipt(state, 'agent', '', { tool_use_result: { isAsync: true, agentId: 'child' } });
  assert.equal(state.items[0].type, 'task');
  assert.equal(state.items[0].status, 'running');
  assert.equal(state.items[0].resultConfirmed, true);
  activity.ingest(state, { type: 'assistant', parent_tool_use_id: 'agent', agent_id: 'child', message: { content: [{ type: 'text', text: 'Child output' }] } });
  activity.ingest(state, { type: 'system', subtype: 'task_notification', task_id: 'child', tool_use_id: 'agent', status: 'completed', summary: 'Finished child' });
  finish(state);
  assert.equal(state.items[0].type, 'task');
  assert.equal(state.items[0].status, 'success');
  assert.match(state.items[0].result, /Child output/);
});

function oldPreview(extra = {}) {
  return { id: 'old-write', toolUseId: 'old-write', type: 'tool', toolName: 'mcp__fixture__doc_write',
    title: '调用 fixture 服务', detail: 'doc_write', status: 'success', input: { document_id: 'fixture' },
    sourceMessageId: 'stream-message', startedAt: 1000, endedAt: 2000, ...extra };
}
function savedState(items, extra = {}) {
  return { version: 8, phase: 'complete', startedAt: 1000, endedAt: 2000, items, ...extra };
}

test('v8 history repair is read-only, selective and idempotent for the stream-preview signature', () => {
  const saved = savedState([
    ...Array.from({ length: 3 }, (_, i) => oldPreview({ id: `write-${i}`, toolUseId: `write-${i}` })),
    ...Array.from({ length: 3 }, (_, i) => oldPreview({ id: `read-${i}`, toolName: 'Read', result: i ? 'read text' : '', resultMessageUuids: [`receipt-${i}`] })),
  ]);
  const before = JSON.stringify(saved);
  const state = activity.hydrate(saved);
  assert.deepEqual(state.items.map(item => item.status), ['unconfirmed', 'unconfirmed', 'unconfirmed', 'success', 'success', 'success']);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(state.items[0].input, saved.items[0].input);
  assert.equal(state.phase, 'complete');
  assert.equal(state.endedAt, 2000);
  const snapshot = activity.serialize(state);
  assert.equal(snapshot.version, 9);
  assert.deepEqual(activity.serialize(activity.hydrate(snapshot)), snapshot);
  receipt(state, 'write-0', 'late confirmation');
  assert.equal(state.items[0].status, 'success');
});

test('history repair rejects ambiguous provenance, different finish, old epochs and every receipt field', () => {
  const variants = [
    { sourceMessageId: '' }, { sourceMessageUuids: [] }, { sourceMessageUuids: ['assistant-frame'] },
    { endedAt: 1999 }, { endedAt: null }, { contextEpoch: 1 }, { type: 'task' }, { outputOwned: true },
    { status: 'canceled' }, { status: 'superseded' }, { status: 'error' },
    { result: '' }, { result: 'output' }, { result: null }, { error: '' },
    { structuredResult: {} }, { resultMessageUuids: [] }, { resultMessageUuids: ['receipt'] },
    { resultConfirmed: true }, { resultConfirmed: false },
  ];
  for (const extra of variants) {
    const saved = savedState([oldPreview(extra)]);
    assert.deepEqual(activity.hydrate(saved).items, saved.items, JSON.stringify(extra));
  }
  for (const extra of [{ phase: 'running' }, { phase: 'error' }, { endedAt: null }, { version: 9 }]) {
    const saved = savedState([oldPreview()], extra);
    assert.deepEqual(activity.hydrate(saved).items, saved.items, JSON.stringify(extra));
  }
});

test('legacy genuine receipt fields prevent an active restored tool from becoming unconfirmed', () => {
  for (const evidence of [{ result: '' }, { resultMessageUuids: ['receipt'] }, { structuredResult: {} }, { resultConfirmed: true }]) {
    const state = activity.hydrate(savedState([oldPreview({ status: 'running', ...evidence })], { phase: 'running', endedAt: null }));
    finish(state);
    assert.equal(state.items[0].status, 'success', JSON.stringify(evidence));
  }
});
