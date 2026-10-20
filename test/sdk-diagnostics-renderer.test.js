'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const activity = require('../renderer/activity-stream');
const { declaration } = require('./renderer-activity-harness.cjs');
const diagnostics = fields => ({ version: 1, ...fields });
const startup = { reason: 'cwd_unavailable', title: '工作目录暂不可用', message: '当前工作目录无法访问。', suggestion: '检查项目目录是否仍存在，然后重新发送。' };
const emit = (state, detail, extra = {}) => activity.ingest(state, { type: 'system', subtype: 'fixture', relay_diagnostics: diagnostics(detail), ...extra });
const rows = state => state.items.filter(item => item.id.startsWith('relay-sdk-'));

test('missing, older and unknown diagnostic payloads leave the activity view unchanged', () => {
  const state = activity.createState(), before = activity.serialize(state);
  for (const value of [null, {}, { version: 1 }, { version: 2, startupFailure: startup }, diagnostics({ resultIndex: 7 }), diagnostics({ timing: { first_text_post_ms: -1, first_stream_post_queue_wait_ms: Infinity } })]) activity.ingestDiagnostics(state, value);
  assert.deepEqual(activity.serialize(state), before);
  activity.ingest(state, { type: 'system', subtype: 'init', plugin_errors: [{ plugin: 'raw', message: 'secret' }] });
  assert.equal(rows(state).length, 0, 'raw SDK messages are not an alternative diagnostic input');
});

test('startup reason and actionable suggestion remain inspectable without changing task outcome', () => {
  const state = activity.createState(); emit(state, { startupFailure: startup });
  const row = rows(state)[0];
  assert.equal(row.title, startup.title); assert.equal(row.detail, startup.message);
  assert.match(row.result, /建议：检查项目目录/);
  assert.match(activity.renderItem(row, true), /is-inspectable/);
  assert.equal(state.phase, 'running'); assert.equal(state.error, null);
  activity.finish(state, 'native startup failed');
  assert.equal(state.phase, 'error'); assert.equal(state.error, 'native startup failed');
});

test('plugin diagnostics identify the affected plugin and escape all display text', () => {
  const state = activity.createState();
  emit(state, { pluginErrors: { count: 2, truncated: true, entries: [
    { plugin: 'test@market', label: '依赖未满足', message: '插件依赖尚未满足。' },
    { plugin: '<img src=x onerror=alert(1)>', label: '普通错误', message: '<script>not executable</script>' },
  ], path: '/private/path', rawMessage: 'RAW_SECRET' } });
  const row = rows(state)[0], html = activity.renderItem(row, true);
  assert.match(row.result, /test@market.*依赖未满足/); assert.match(row.result, /仅显示部分/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script>|RAW_SECRET|private\/path/);
  assert.equal(state.error, null); assert.equal(state.phase, 'running');
  emit(state, { pluginErrors: { count: 1, categories: [{ label: '依赖未满足', count: 1 }] } });
  assert.equal(rows(state).length, 1); assert.match(rows(state)[0].result, /依赖未满足：1 项/);
});

test('runtime facts merge into one quiet expandable row and preserve known zero durations', () => {
  const state = activity.createState();
  emit(state, { recovery: { reason: 'host_draining', message: 'SDK 报告本轮因工作进程调整而继续。' } });
  emit(state, { timing: { first_text_post_ms: 1234, first_stream_post_queue_wait_ms: 0, first_stream_post_queued_behind: 'none' } });
  emit(state, { workerRestart: { reason: 'worker_restart', message: 'SDK 报告后台任务因工作进程重启而停止。' } });
  for (let i = 0; i < 20; i++) emit(state, { timing: { first_text_post_ms: 1234 } });
  assert.equal(rows(state).length, 1);
  assert.match(rows(state)[0].result, /SDK 首次文本投递：1,234 毫秒/);
  assert.match(rows(state)[0].result, /排队：0 毫秒/); assert.match(rows(state)[0].result, /无等待项/);
  assert.match(rows(state)[0].result, /因工作进程调整/); assert.match(rows(state)[0].result, /重启而停止/);
  assert.equal(state.phase, 'running'); assert.equal(state.error, null);
  assert.match(activity.renderItem(rows(state)[0]), /aria-expanded="false"/);
  emit(state, { timing: { first_stream_post_queued_behind: '<unknown-secret>' } });
  assert.match(rows(state)[0].result, /未明确/); assert.doesNotMatch(rows(state)[0].result, /unknown-secret/);
});

test('saved diagnostics survive serialize/hydrate and a later update without duplicate rows', () => {
  const state = activity.createState(); emit(state, { startupFailure: startup, recovery: { message: 'SDK 报告本轮因中断而继续。' } });
  const saved = activity.serialize(state), restored = activity.hydrate(saved);
  assert.deepEqual(rows(restored), rows(state));
  emit(restored, { timing: { first_text_post_ms: 0 } });
  assert.equal(rows(restored).length, 2); assert.match(rows(restored)[1].result, /中断而继续.*\nSDK 首次文本投递：0 毫秒/);
  assert.deepEqual(saved.items, rows(state), 'updating the restored view cannot mutate saved history');
});

test('local preparation and first-text durations stay distinct from SDK delivery and wall timestamps', () => {
  const state = activity.createState();
  emit(state, { timing: { hostStartupMs: 100, hostModeMs: 500, hostMcpMs: 600, hostPreparationMs: 710,
    hostFirstTextMs: 1850, first_text_post_wall_ms: 9999999999999 } });
  const result = rows(state)[0].result;
  assert.match(result, /会话启动准备：100 毫秒/); assert.match(result, /模式准备：500 毫秒/);
  assert.match(result, /工具连接准备：600 毫秒/); assert.match(result, /准备总耗时：710 毫秒/);
  assert.match(result, /本地首正文到达：1,850 毫秒/); assert.match(result, /耗时不相加/);
  assert.doesNotMatch(result, /1,100|999999|SDK 首次文本投递/);
});

test('context resets keep previous facts in their epoch and reject late old-session or child diagnostics', () => {
  const state = activity.createState(); activity.ingest(state, { type: 'system', subtype: 'init', session_id: 'old' });
  emit(state, { recovery: { message: 'old recovery' } }, { session_id: 'old' });
  activity.ingest(state, { type: 'conversation_reset', session_id: 'old', new_conversation_id: 'new', uuid: 'reset' });
  emit(state, { startupFailure: startup }, { session_id: 'old' });
  emit(state, { startupFailure: startup }, { session_id: 'new', parent_tool_use_id: 'child' });
  emit(state, { timing: { first_text_post_ms: 25 } }, { session_id: 'new' });
  assert.equal(rows(state).length, 2);
  assert.equal(rows(state)[0].contextEpoch, 0); assert.equal(rows(state)[1].contextEpoch, 1);
  assert.doesNotMatch(rows(state)[1].result, /old recovery/);
  assert.equal(rows(state).some(row => row.id.includes('startup')), false);
});

test('job-done-only and final-result diagnostics are displayed without fabricating failure', () => {
  const state = activity.createState();
  activity.finish(state, null, { type: 'job-done', exitCode: 0, relay_diagnostics: diagnostics({ recovery: { message: '恢复说明' } }),
    finalResult: { type: 'result', subtype: 'success', result: '', relay_diagnostics: diagnostics({ timing: { first_text_post_ms: 5 } }) } });
  assert.equal(state.phase, 'complete'); assert.equal(state.error, null);
  assert.match(rows(state)[0].result, /恢复说明\nSDK 首次文本投递：5 毫秒/);
});

test('current-session diagnostics from a stale epoch cannot enter the new context through events or completion', () => {
  for (const source of ['event', 'job-done', 'final-result']) {
    const state = activity.createState();
    activity.ingest(state, { type: 'system', subtype: 'init', session_id: 'old' });
    activity.ingest(state, { type: 'conversation_reset', session_id: 'old', new_conversation_id: 'new', uuid: 'reset' });
    const stale = { session_id: 'new', context_epoch: 0, relay_diagnostics: diagnostics({ startupFailure: startup }) };
    if (source === 'event') activity.ingest(state, { type: 'system', subtype: 'fixture', ...stale });
    else activity.finish(state, null, source === 'job-done'
      ? { type: 'job-done', exitCode: 0, ...stale }
      : { type: 'job-done', exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: '', ...stale } });
    assert.equal(rows(state).length, 0, `${source}: matching session cannot override epoch isolation`);
    emit(state, { timing: { hostFirstTextMs: 75 } }, { session_id: 'new', context_epoch: 1 });
    assert.equal(rows(state).length, 1, `${source}: current epoch remains usable`);
    assert.match(rows(state)[0].result, /本地首正文到达：75 毫秒/);
  }
});

test('completion diagnostic identity checks also reject old sessions and child final results', () => {
  for (const identity of [{ session_id: 'old' }, { session_id: 'new', parent_tool_use_id: 'child' }]) {
    const state = activity.createState();
    activity.ingest(state, { type: 'system', subtype: 'init', session_id: 'new' });
    activity.finish(state, null, { type: 'job-done', exitCode: 0, finalResult: {
      type: 'result', subtype: 'success', result: '', ...identity, relay_diagnostics: diagnostics({ startupFailure: startup }),
    } });
    assert.equal(rows(state).length, 0);
  }
});

function runtimeHarness() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  const route = { providerId: 'fixture', providerRevision: 1 }, run = { jobId: 'job', sessionId: 'session', activityState: activity.createState() };
  const context = { window: { api: { claudeRuntimeInfo: () => promise }, RelayActivity: activity },
    currentConv: { id: 'conv', sessionId: 'session' }, currentModel: 'model', contextUsageEnabled: true,
    claudeRuntimeUIRevision: 1, claudeRuntimeReadRevision: 0, pendingClaudeRuntimeSelection: null,
    contextUsageReadRevisions: new Map(), runs: new Map([['conv', run]]),
    configuredChatRoute: () => route, isMountedChatJob: () => true, rendered: [],
    scheduleRunOutputActivity: current => context.rendered.push(current),
  };
  vm.createContext(context); vm.runInContext(declaration('refreshClaudeRuntimeInfo'), context);
  return { context, run, resolve: (extra = {}) => resolve({ providerId: 'fixture', providerRevision: 1, routeTier: 'model',
    diagnostics: { sessionId: 'session', diagnostics: diagnostics({ startupFailure: startup }) }, ...extra }) };
}
test('runtime snapshot fallback updates only the original current run and matching session', async () => {
  for (const scenario of ['current', 'replaced-run', 'replaced-state', 'reset-context', 'old-session', 'switched-conversation']) {
    const h = runtimeHarness(), request = h.context.refreshClaudeRuntimeInfo('conv', { includeContext: false });
    if (scenario === 'replaced-run') h.context.runs.set('conv', { jobId: 'replacement', activityState: activity.createState() });
    if (scenario === 'replaced-state') h.run.activityState = activity.createState();
    if (scenario === 'reset-context') activity.ingest(h.run.activityState, { type: 'conversation_reset', new_conversation_id: 'new-session', uuid: 'reset' });
    if (scenario === 'switched-conversation') h.context.currentConv = { id: 'another' };
    h.resolve(scenario === 'old-session' ? { diagnostics: { sessionId: 'old', diagnostics: diagnostics({ startupFailure: startup }) } } : {});
    await request;
    assert.equal(rows(h.run.activityState).length, scenario === 'current' ? 1 : 0, scenario);
    assert.equal(h.context.rendered.length, scenario === 'current' ? 1 : 0, scenario);
  }
});
