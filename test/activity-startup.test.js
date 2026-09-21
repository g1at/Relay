'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const activity = require('../renderer/activity-stream');
const stream = event => ({ type: 'stream_event', event });
const ready = { type: 'system', subtype: 'relay_mcp_status', phase: 'settled', ok: true };
const preparing = { type: 'system', subtype: 'relay_mcp_status', phase: 'preparing', stage: 'initializing' };
const visible = state => activity.visibleItems(state);
const waiting = state => visible(state).find(item => item.id === 'relay-startup');

test('recorded startup timing retains an animated preparation/ready gap until actual thinking', t => {
  // Sanitized timing from the reported calculator run: preparation 8,023 ms,
  // then 803 ms between settled MCP readiness and its first thinking block.
  let now = 1789372685934;
  t.mock.method(Date, 'now', () => now);
  const state = activity.createState();
  assert.equal(waiting(state).title, '正在准备');
  activity.ingest(state, preparing);
  assert.equal(state.items.length, 0);
  now += 8023;
  activity.ingest(state, { type: 'system', subtype: 'init', session_id: 'fixture' });
  activity.ingest(state, ready);
  for (const delta of [0, 400, 802]) {
    now = 1789372693957 + delta;
    assert.equal(waiting(state).title, '正在等待回复');
    assert.equal(waiting(state).status, 'running');
    assert.match(activity.renderItem(waiting(state)), /process-spinner/);
    assert.equal(state.items.some(item => item.type === 'thinking'), false);
  }
  now = 1789372694760;
  activity.ingest(state, stream({ type: 'message_start', message: { id: 'fixture-response' } }));
  activity.ingest(state, stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
  assert.equal(waiting(state), undefined);
  assert.equal(visible(state).length, 1);
  assert.equal(visible(state)[0].type, 'thinking');
  assert.match(activity.renderItem(visible(state)[0]), /正在思考/);
});

test('an empty text block keeps waiting; first text and complete-message responses retire preparation', () => {
  const state = activity.createState();
  activity.ingest(state, ready);
  activity.ingest(state, stream({ type: 'message_start', message: { id: 'text' } }));
  activity.ingest(state, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  assert.ok(waiting(state));
  activity.ingest(state, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }));
  assert.equal(waiting(state), undefined);
  for (const block of [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'read', name: 'Read', input: {} }]) {
    const direct = activity.createState();
    activity.ingest(direct, { type: 'assistant', message: { id: 'direct', content: [block] } });
    activity.ingest(direct, ready);
    activity.ingest(direct, { type: 'system', subtype: 'init' });
    assert.equal(waiting(direct), undefined, 'late init must not regress an active reply');
  }
});

test('connection problems are expandable diagnostics alongside the reply wait', () => {
  const state = activity.createState();
  activity.ingest(state, { ...ready, ok: false, items: [{ name: '<offline>', status: 'failed' }] });
  const diagnostic = visible(state).find(item => item.id === 'relay-mcp-ready');
  assert.equal(diagnostic.type, 'diagnostic');
  assert.equal(diagnostic.status, 'error');
  assert.match(activity.renderItem(diagnostic), /is-inspectable/);
  assert.match(activity.renderItem(diagnostic), /&lt;offline&gt;：连接失败/);
  assert.equal(waiting(state).title, '正在等待回复');
  assert.equal(state.error, null);
  activity.ingest(state, ready);
  assert.equal(visible(state).length, 1);
});

test('API retry owns the active indicator, then first-response waiting returns without a fake thinking row', () => {
  const state = activity.createState();
  activity.ingest(state, ready);
  activity.ingest(state, { type: 'system', subtype: 'api_retry', error_status: 429, attempt: 1, retry_delay_ms: 1000 });
  assert.equal(waiting(state), undefined);
  assert.equal(visible(state).filter(item => item.status === 'running').length, 1);
  activity.ingest(state, stream({ type: 'message_start', message: { id: 'retry' } }));
  assert.equal(waiting(state).title, '正在等待回复');
  assert.equal(visible(state).filter(item => item.status === 'running').length, 1);
});

test('completion, startup failure and user pause stop all startup animation and never persist a fake step', () => {
  for (const phase of [preparing, ready]) for (const error of [null, '连接失败', '已暂停']) {
    const state = activity.createState();
    activity.ingest(state, phase);
    if (!error) activity.ingest(state, { type: 'result', subtype: 'success', result: 'done' });
    activity.finish(state, error);
    assert.equal(waiting(state), undefined);
    assert.equal(state.startupPhase, null);
    assert.ok(visible(state).every(item => !/running|preparing/.test(item.status)));
    assert.equal(activity.serialize(state).items.length, 0);
    activity.ingest(state, ready);
    assert.equal(waiting(state), undefined, 'late readiness must not restart a stopped indicator');
  }
});

test('restoring a live waiting turn preserves its phase; earlier segments and legacy histories do not replay startup', () => {
  const state = activity.createState();
  activity.ingest(state, ready);
  const saved = activity.serialize(state), restored = activity.hydrate(saved);
  assert.equal(saved.items.length, 0);
  assert.equal(waiting(restored).title, '正在等待回复');
  assert.equal(activity.visibleItems(restored, { segment: 'previous' }).length, 0);
  const legacy = activity.hydrate({ phase: 'complete', items: [
    { id: 'relay-mcp-ready', type: 'status', status: 'success', title: '工具连接已就绪' },
  ] });
  assert.equal(visible(legacy).length, 0);
  const failed = activity.hydrate({ phase: 'error', items: [
    { id: 'relay-mcp-ready', type: 'status', status: 'error', detail: 'offline：连接失败' },
  ] });
  assert.match(activity.renderItem(visible(failed)[0]), /is-inspectable/);
  assert.match(activity.renderItem(visible(failed)[0]), /offline：连接失败/);
});
