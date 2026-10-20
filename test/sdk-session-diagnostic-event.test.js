'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withSessionDiagnostics } = require('../src/main/sdk/sdk-session-diagnostic-event');
const { SdkSessionObserver } = require('../src/main/sdk/sdk-session-observer');
const { normalizeClaudeTaskEvent } = require('../src/main/tasks/task-event-normalizer');
const Activity = require('../renderer/activity-stream');

test('local timing reaches result, task summary and restored UI without a late runtimeInfo response', () => {
  let now = 0;
  const observer = new SdkSessionObserver({ now: () => now });
  observer.observe({ type: 'system', subtype: 'init', session_id: 'session' });
  observer.beginTurn(); observer.preparation({ startupMs: 30, modeMs: 2, mcpMs: 50, totalMs: 83 });
  now = 200;
  observer.observe({ type: 'stream_event', session_id: 'session', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } });
  const raw = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session', result_index: 0 };
  observer.observe(raw);
  const event = withSessionDiagnostics(raw, observer.snapshot());
  assert.equal(raw.relay_diagnostics, undefined);
  assert.deepEqual(event.relay_diagnostics.timing, { hostStartupMs: 30, hostModeMs: 2, hostMcpMs: 50, hostPreparationMs: 83, hostFirstTextMs: 200 });
  assert.equal(event.relay_diagnostics.resultIndex, 0);
  const action = normalizeClaudeTaskEvent(event, { state: 'running', execution: { sessionId: 'session' } });
  assert.equal(action.kind, 'update');
  assert.equal(action.patch.state, 'running', 'Result still waits for authoritative completion');
  assert.equal(action.patch.result.sdk.diagnostics.timing.hostFirstTextMs, 200);
  const state = Activity.createState(); Activity.ingest(state, event);
  Activity.finish(state, null, { type: 'job-done', exitCode: 0, finalResult: event });
  const restored = Activity.hydrate(Activity.serialize(state));
  const rows = restored.items.filter(item => item.id.startsWith('relay-sdk-runtime'));
  assert.equal(rows.length, 1); assert.match(rows[0].result, /本地首正文到达：200 毫秒/);
  assert.match(rows[0].result, /准备总耗时：83 毫秒/);
  assert.equal(restored.phase, 'complete');
});

test('result attachment never borrows diagnostics from another context, child or unrelated event', () => {
  const snapshot = { sessionId: 'new', epoch: 2, diagnostics: { version: 1, timing: { hostFirstTextMs: 10 } } };
  for (const event of [
    { type: 'result', session_id: 'old' },
    { type: 'result', session_id: 'new', context_epoch: 1 },
    { type: 'result', parent_tool_use_id: 'child' },
    { type: 'result', subagent_type: 'reviewer' },
    { type: 'system', subtype: 'status' },
  ]) assert.equal(withSessionDiagnostics(event, snapshot), event);
  const event = { type: 'result', subtype: 'success' };
  assert.equal(withSessionDiagnostics(event, { sessionId: null, epoch: 0, diagnostics: { version: 1 } }), event);
  assert.equal(withSessionDiagnostics(event, null), event);
});

test('current result diagnostic wins and arbitrary snapshot fields cannot leak through', () => {
  const event = { type: 'result', subtype: 'error_during_execution', is_error: true,
    startup_failure_reason: 'proxy_invalid', result_index: 2 };
  const annotated = withSessionDiagnostics(event, { diagnostics: {
    version: 1, startupFailure: { reason: 'cwd_unavailable', message: 'PRIVATE' }, resultIndex: 1,
    timing: { hostFirstTextMs: 30, secret: 'PRIVATE' }, raw: 'PRIVATE',
  } });
  assert.equal(annotated.relay_diagnostics.startupFailure.reason, 'proxy_invalid');
  assert.equal(annotated.relay_diagnostics.resultIndex, 2);
  assert.equal(JSON.stringify(annotated.relay_diagnostics).includes('PRIVATE'), false);
  assert.equal(annotated.subtype, event.subtype); assert.equal(annotated.is_error, true);
});
