'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticsFromEvent, sanitizeDiagnostics, hasDiagnostics, pluginName } = require('../src/main/sdk/sdk-diagnostic-details');
const { annotateError } = require('../src/main/sdk/sdk-error-categories');
const { SdkSessionObserver } = require('../src/main/sdk/sdk-session-observer');
const { normalizeClaudeTaskEvent } = require('../src/main/tasks/task-event-normalizer');

const startupReasons = ['org_pin_api_key_conflict', 'org_verify_failed', 'org_pin_mismatch', 'managed_settings_invalid',
  'remote_settings_required_unavailable', 'gateway_signin_required', 'gateway_access_denied', 'proxy_invalid', 'temp_dir_unusable',
  'cwd_unavailable', 'shell_tool_missing', 'session_held_by_background', 'worktree_resume_refused', 'worktree_unverified', 'cli_version_too_old', 'bypass_root'];
const secret = 'PRIVATE_FIXTURE_CREDENTIAL';
const init = (id = 's') => ({ type: 'system', subtype: 'init', session_id: id });
const result = fields => ({ type: 'result', subtype: 'success', session_id: 's', ...fields });

test('all SDK startup reasons have fixed actionable Chinese text, without producer error text', () => {
  for (const reason of startupReasons) {
    const event = result({ subtype: 'error_during_execution', is_error: true, startup_failure_reason: reason, errors: [secret] });
    const annotated = annotateError(event);
    const details = annotated.relay_diagnostics.startupFailure;
    assert.equal(details.reason, reason);
    for (const field of ['title', 'message', 'suggestion']) assert.match(details[field], /[\u4e00-\u9fff]/);
    assert.equal(annotated.relay_error_category, 'sdk_startup_failure');
    assert.equal(JSON.stringify(details).includes(secret), false);
    assert.equal(annotated.type, event.type); assert.equal(annotated.subtype, event.subtype); assert.equal(annotated.is_error, true);
    assert.equal(event.relay_diagnostics, undefined, 'annotation does not mutate source event');
  }
});

test('unknown startup reason is generic, while absent or malformed ordinary diagnostics add no noise', () => {
  assert.equal(diagnosticsFromEvent(result({ startup_failure_reason: secret })).startupFailure.reason, 'unknown');
  for (const event of [null, {}, init(), result({}), { type: 'system', subtype: 'status' }]) assert.equal(hasDiagnostics(diagnosticsFromEvent(event)), false);
  assert.equal(annotateError(init()).relay_error_category, undefined);
  assert.equal(annotateError(result({ errors: ['429 retry'] })).relay_error_category, 'rate_limit', 'legacy fallback retained');
});

test('plugin failures identify safe plugins but never persist paths, raw errors or credentials', () => {
  const event = { ...init(), plugin_errors: [
    { plugin: 'review@marketplace', type: 'manifest-validation-error', message: secret, path: '/private/' + secret },
    { plugin: 'inline[2]', type: 'dependency-unsatisfied', message: secret },
    { plugin: '/private/' + secret, type: 'future-' + secret, message: secret },
    { plugin: 'sk-PRIVATE-CREDENTIAL', type: 'path-not-found' },
  ] };
  const details = annotateError(event).relay_diagnostics.pluginErrors;
  assert.equal(details.count, 4);
  assert.equal(details.entries[0].plugin, 'review@marketplace');
  assert.equal(details.entries[1].plugin, 'inline[2]');
  assert.equal(details.entries[2].plugin, '未识别插件');
  assert.equal(details.entries[2].type, 'generic-error');
  assert.equal(details.entries[3].plugin, '未识别插件');
  assert.equal(JSON.stringify(details).includes(secret), false);
  assert.equal(Object.hasOwn(details.entries[0], 'path'), false);
  for (const value of ['../bad', 'C:\\secret\\plugin', 'bad\nname', 'token-as-plugin', 'Authorization', 'a'.repeat(130), null]) assert.equal(pluginName(value), '未识别插件');
});

test('plugin summaries remain bounded for oversized and malformed producer arrays', () => {
  const raw = Array.from({ length: 11000 }, (_, index) => ({ plugin: 'plugin-' + index, type: index % 2 ? 'hook-load-failed' : 'new-type', message: secret }));
  const info = diagnosticsFromEvent({ ...init(), plugin_errors: raw }).pluginErrors;
  assert.equal(info.count, 10000); assert.equal(info.entries.length, 12); assert.equal(info.truncated, true);
  assert.equal(info.categories.reduce((sum, item) => sum + item.count, 0), 256);
  assert.equal(JSON.stringify(info).includes(secret), false);
  assert.equal(diagnosticsFromEvent({ ...init(), plugin_errors: {} }).pluginErrors, undefined);
  assert.equal(diagnosticsFromEvent({ ...init(), plugin_errors: [null, 1, { type: { toString() { throw Error('not text'); } } }] }).pluginErrors.count, 3);
  assert.equal(diagnosticsFromEvent({ ...init(), plugin_errors: [] }).pluginErrors.count, 0);
});

test('replayed DTOs are sanitized again instead of trusting injected labels and summaries', () => {
  const safe = sanitizeDiagnostics({ startupFailure: { reason: 'cwd_unavailable', message: secret, suggestion: secret },
    recovery: { reason: secret, message: secret }, pluginErrors: { count: 1, categories: [{ type: secret, count: 1, label: secret }],
      entries: [{ plugin: 'inline[0]', type: 'generic-error', message: secret }] }, token: secret });
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.equal(safe.recovery.reason, 'unknown');
  assert.equal(safe.startupFailure.reason, 'cwd_unavailable');
});

test('first-text and queue delay accept zero, reject timestamps and nonfinite values, whitelist queue cause', () => {
  const details = diagnosticsFromEvent(result({ first_text_post_ms: 0, first_stream_post_queue_wait_ms: 8.5,
    first_stream_post_queued_behind: 'hold', first_text_post_wall_ms: 1790000000000, result_index: 0 }));
  assert.deepEqual(details.timing, { first_text_post_ms: 0, first_stream_post_queue_wait_ms: 8.5, first_stream_post_queued_behind: 'hold' });
  assert.equal(details.resultIndex, 0);
  for (const invalid of [-1, NaN, Infinity, '42', 1790000000000]) assert.equal(diagnosticsFromEvent(result({ first_text_post_ms: invalid })).timing, undefined);
  assert.equal(diagnosticsFromEvent(result({ first_stream_post_queued_behind: secret })).timing.first_stream_post_queued_behind, 'unknown');
  assert.equal(diagnosticsFromEvent(result({ result_index: -1 })).resultIndex, undefined);
});

test('recovery, delivery indices and orphaned worker notifications stay advisory', () => {
  for (const [reason, expected] of [['checkpoint_restore', 'checkpoint_restore'], [secret, 'unknown']]) {
    const event = annotateError(result({ resume_reason: reason, result_index: 10, num_turns: 0 }));
    assert.equal(event.relay_diagnostics.recovery.reason, expected);
    assert.equal(event.relay_error_category, undefined);
    const action = normalizeClaudeTaskEvent(event, { state: 'running', execution: { sessionId: 's' } });
    assert.equal(action.kind, 'update'); assert.equal(action.patch.state, 'running');
    assert.equal(action.patch.execution.diagnostics.resultIndex, 10);
  }
  const event = annotateError({ ...init(), subtype: 'task_notification', status: 'stopped', reason: 'worker_restart' });
  assert.equal(event.relay_error_category, undefined);
  const action = normalizeClaudeTaskEvent(event, { state: 'running', execution: { sessionId: 's' } });
  assert.equal(action.kind, 'update'); assert.equal(action.patch.state, 'running');
  assert.equal(action.patch.execution.diagnostics.workerRestart.reason, 'worker_restart');
  assert.equal(diagnosticsFromEvent({ ...event, status: 'completed', relay_diagnostics: undefined }).workerRestart, undefined);
});

test('observer preserves plugin diagnosis across turns, clears other details and isolates reset epochs', () => {
  const state = new SdkSessionObserver(); state.observe({ ...init(), plugin_errors: [{ plugin: 'inline[0]', type: 'generic-error' }] });
  state.observe(result({ resume_reason: 'host_draining', result_index: 3, first_text_post_ms: 9 }));
  assert.equal(state.snapshot().diagnostics.recovery.reason, 'host_draining');
  state.beginTurn();
  assert.deepEqual(Object.keys(state.snapshot().diagnostics).sort(), ['pluginErrors', 'version']);
  state.observe({ type: 'conversation_reset', session_id: 's', new_conversation_id: 'new' });
  assert.deepEqual(state.snapshot().diagnostics, { version: 1 });
  assert.equal(state.observe(result({ resume_reason: 'host_draining' })), false);
  assert.equal(state.observe(result({ session_id: 'new', context_epoch: 0, first_text_post_ms: 5 })), false);
  assert.equal(state.observe({ ...init('new'), agent_id: 'child', plugin_errors: [{ plugin: 'bad' }] }), false);
  assert.equal(state.observe({ type: 'conversation_reset', session_id: 'new', new_conversation_id: 'new' }), false);
  state.observe(result({ session_id: 'new', context_epoch: 1, first_text_post_ms: 11 }));
  assert.equal(state.snapshot().diagnostics.timing.first_text_post_ms, 11);
  const copy = state.snapshot(); copy.diagnostics.timing.first_text_post_ms = 999;
  assert.equal(state.snapshot().diagnostics.timing.first_text_post_ms, 11);
});

test('normalizer persists safe startup guidance and keeps existing cancellation/terminal decisions', () => {
  const event = annotateError(result({ subtype: 'error_during_execution', is_error: true, startup_failure_reason: 'cwd_unavailable', errors: [secret] }));
  const action = normalizeClaudeTaskEvent(event, { state: 'running' });
  assert.equal(action.kind, 'terminal'); assert.equal(action.status, 'failed');
  assert.equal(action.details.execution.diagnostics.startupFailure.reason, 'cwd_unavailable');
  assert.equal(action.details.result.sdk.diagnostics.startupFailure.reason, 'cwd_unavailable');
  assert.equal(action.details.result.error.includes(secret), false);
  assert.equal(normalizeClaudeTaskEvent(event, { state: 'stopping' }).status, 'canceled');
  assert.equal(normalizeClaudeTaskEvent(event, { state: 'succeeded' }).kind, 'noop');
});

test('normalizer merges init and result summaries, rejects stale epochs and clears on reset', () => {
  let execution = normalizeClaudeTaskEvent({ ...init(), plugin_errors: [{ plugin: 'demo@marketplace', type: 'hook-load-failed' }] }, { state: 'running' }).patch.execution;
  const action = normalizeClaudeTaskEvent(result({ resume_reason: 'interrupted_turn', first_text_post_ms: 10 }), { state: 'running', execution });
  execution = action.patch.execution;
  assert.equal(execution.diagnostics.pluginErrors.count, 1);
  assert.equal(execution.diagnostics.recovery.reason, 'interrupted_turn');
  execution = normalizeClaudeTaskEvent({ type: 'conversation_reset', session_id: 's', new_conversation_id: 'new' }, { state: 'running', execution }).patch.execution;
  assert.deepEqual(execution.diagnostics, { version: 1 }); assert.equal(execution.diagnosticEpoch, 1);
  assert.equal(normalizeClaudeTaskEvent(result({ startup_failure_reason: 'proxy_invalid' }), { state: 'running', execution }).kind, 'noop');
  assert.equal(normalizeClaudeTaskEvent(result({ session_id: 'new', context_epoch: 0, result_index: 1 }), { state: 'running', execution }).kind, 'noop');
});

test('job-done diagnostics recover from finalResult while terminal state still comes from existing outcome', () => {
  const failed = result({ subtype: 'error_during_execution', is_error: true, startup_failure_reason: 'proxy_invalid' });
  assert.equal(annotateError({ type: 'job-done', finalResult: failed }).relay_diagnostics.startupFailure.reason, 'proxy_invalid');
  assert.equal(normalizeClaudeTaskEvent({ type: 'job-done', exitCode: 0, finalResult: failed }, { state: 'running' }).status, 'failed');
  const advice = { version: 1, recovery: { reason: 'host_draining' } };
  assert.equal(annotateError({ type: 'job-done', relay_diagnostics: advice }).relay_error_category, undefined);
  assert.equal(normalizeClaudeTaskEvent({ type: 'job-done', exitCode: 0, relay_diagnostics: advice }, { state: 'running' }).status, 'succeeded');
});

test('diagnostics preserve fresh init metadata and allow native init to replace a prefilled resume source', () => {
  const before = { sessionId: 'resume-source', model: 'old-model', effort: 'low', permissionMode: 'default', resource: 'claude' };
  const first = normalizeClaudeTaskEvent({ ...init('native-fork'), model: 'new-model', effort: 'high', permissionMode: 'plan' }, { state: 'running', execution: before });
  assert.equal(first.patch.execution.sessionId, 'native-fork');
  assert.equal(first.patch.execution.diagnosticSessionId, 'native-fork');
  assert.equal(first.patch.execution.model, 'new-model');
  assert.equal(first.patch.execution.effort, 'high');
  assert.equal(first.patch.execution.permissionMode, 'plan');
  assert.equal(first.patch.execution.resource, 'claude');
  const repeated = normalizeClaudeTaskEvent({ ...init('native-fork'), model: 'latest-model', effort: 'max', plugin_errors: [{ plugin: 'demo', type: 'hook-load-failed' }] },
    { state: 'running', execution: first.patch.execution });
  assert.equal(repeated.patch.execution.model, 'latest-model');
  assert.equal(repeated.patch.execution.effort, 'max');
  assert.equal(repeated.patch.execution.diagnostics.pluginErrors.count, 1);
  assert.equal(normalizeClaudeTaskEvent(init('resume-source'), { state: 'running', execution: repeated.patch.execution }).kind, 'noop');
});

test('snapshot includes bounded local preparation and first visible text timing without summing parallel work', () => {
  let now = 100;
  const state = new SdkSessionObserver({ now: () => now }); state.beginTurn();
  state.preparation({ startupMs: 5, modeMs: 8, mcpMs: 10, totalMs: 16 });
  now = 135; state.observe({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'visible' } } });
  assert.deepEqual(state.snapshot().diagnostics.timing, { hostStartupMs: 5, hostModeMs: 8, hostMcpMs: 10, hostPreparationMs: 16, hostFirstTextMs: 35 });
  assert.equal(state.timing.totalMs, 16);
  assert.equal(sanitizeDiagnostics({ timing: { hostStartupMs: Infinity, hostMcpMs: -1, hostFirstTextMs: 0 } }).timing.hostFirstTextMs, 0);
  state.beginTurn(); assert.equal(state.snapshot().diagnostics.timing, undefined);
});

test('native timing coexists with already attached host timing through annotation and persistence', () => {
  const event = result({ first_text_post_ms: 50, first_stream_post_queue_wait_ms: 0,
    relay_diagnostics: { version: 1, timing: { hostFirstTextMs: 75, hostPreparationMs: 10, first_text_post_ms: 99 } } });
  const expected = { hostFirstTextMs: 75, hostPreparationMs: 10, first_text_post_ms: 50, first_stream_post_queue_wait_ms: 0 };
  assert.deepEqual(diagnosticsFromEvent(event).timing, expected);
  const annotated = annotateError(event);
  assert.deepEqual(annotated.relay_diagnostics.timing, expected);
  const action = normalizeClaudeTaskEvent(annotated, { state: 'running', execution: { sessionId: 's' } });
  assert.deepEqual(action.patch.execution.diagnostics.timing, expected);
  assert.deepEqual(action.patch.result.sdk.diagnostics.timing, expected);
});

test('job-done cannot import another session or epoch through its nested finalResult', () => {
  const run = { state: 'running', execution: { sessionId: 'new', diagnosticSessionId: 'new', diagnosticEpoch: 1 } };
  for (const finalResult of [
    result({ session_id: 'old', context_epoch: 0 }), result({ session_id: 'new', context_epoch: 0 }),
    result({ session_id: 'new', context_epoch: 1, agent_id: 'child' }),
  ]) {
    const nested = { ...finalResult, subtype: 'error_during_execution', is_error: true, startup_failure_reason: 'proxy_invalid' };
    const event = { type: 'job-done', exitCode: 0, finalResult: nested, relay_diagnostics: diagnosticsFromEvent(nested) };
    const action = normalizeClaudeTaskEvent(event, run);
    assert.equal(action.kind, 'terminal'); assert.equal(action.status, 'succeeded', 'own job-done outcome retained');
    assert.equal(action.details.result.sdk, undefined, 'foreign result and its diagnostics do not persist');
    assert.equal(action.details.execution, undefined);
    assert.equal(normalizeClaudeTaskEvent({ ...event, error: 'own executor failed' }, run).status, 'failed');
    assert.equal(event.finalResult, nested, 'source wrapper is not mutated');
  }
  const current = result({ session_id: 'new', context_epoch: 1, subtype: 'error_during_execution', startup_failure_reason: 'proxy_invalid' });
  const valid = normalizeClaudeTaskEvent({ type: 'job-done', exitCode: 0, finalResult: current }, run);
  assert.equal(valid.status, 'failed'); assert.equal(valid.details.execution.diagnostics.startupFailure.reason, 'proxy_invalid');
  assert.equal(hasDiagnostics(diagnosticsFromEvent({ type: 'job-done', session_id: 'new', context_epoch: 1,
    finalResult: { ...current, session_id: 'old' }, relay_diagnostics: { version: 1, recovery: { reason: 'host_draining' } } })), false);
});
