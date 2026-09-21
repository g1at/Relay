'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LiveTurnRouter } = require('../live-turn-router');
const {
  LiveAsyncAgentTracker, LiveBackgroundTaskTracker, liveResultDisposition,
} = require('../live-async-agent-tracker');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('  const onMessage = (evt) => {', source.indexOf('function spawnLiveSession'));
const stop = source.indexOf('  const onExit = ', start);
const exitStop = source.indexOf('  const canUseTool = ', stop);
const finishStart = source.indexOf('function finishTurn(sess, resultEvt) {');
const finishStop = source.indexOf('// 预启动:', finishStart);
const repairStart = source.indexOf('function orchestrateResultClaimsBackgroundWait(');
const repairStop = source.indexOf('// 起一个常驻会话。', repairStart);

// Run the real main-process dispatch and completion functions without Electron,
// processes, model calls, history writes or timers.
function liveRun(jobId = 'new-user', { keepAlive = true, orchestrate = false } = {}) {
  const events = [], pushes = [];
  const sess = {
    convId: 'test-conversation', jobId, busy: true,
    launchSpec: { cwd: '/fixture' },
    onEvent: (event) => events.push(event), keepAliveForAsyncAgents: keepAlive,
    orchestrateMode: orchestrate, orchRepairAttempts: 0,
    child: { push(text, metadata) { pushes.push({ text, metadata }); return true; } },
    asyncAgentTracker: new LiveAsyncAgentTracker(),
    backgroundTaskTracker: new LiveBackgroundTaskTracker(),
    turnRouter: new LiveTurnRouter(), checkpointRunIds: new Set(),
  };
  sess.turnRouter.begin(jobId);
  const context = { TaskClock: require('../task-clock').TaskClock,
    sess, convId: sess.convId, liveResultDisposition,
    ...require('../sdk-session-observer'),
    observer: new (require('../sdk-session-observer').SdkSessionObserver)(),
    routeTimingHistory: new (require('../sdk-session-observer').RouteTimingHistory)(),
    ...require('../sdk-task-resources'),
    loadConversation: () => null,
    observeSupplement: require('../live-supplement-input').observeSupplement,
    publishLiveSupplement() {}, settleLiveSupplements() { return []; },
    console: { log() {}, warn() {}, error() {} },
    interactionBroker: { rejectTask() {} }, checkpointManager: null,
    liveTombstones: new Map(), liveSessions: new Map(),
    touchIdleTimer() {}, refreshTrayMenu() {}, crypto: require('node:crypto'),
    setTimeout() { return { unref() {} }; }, snapshotMcpChildren() {},
    killLiveSession() {},
  };
  require('./helpers/sdk-provenance-fixture')(context);
  vm.runInNewContext(`${source.slice(repairStart, repairStop)}\n${source.slice(finishStart, finishStop)}\n${source.slice(start, exitStop)}\nglobalThis.ingest = onMessage; globalThis.exit = onExit;`, context);
  return { sess, events, pushes, ingest: context.ingest, exit: context.exit };
}

function streamStart(userMessageId, messageId = 'reply') {
  return {
    type: 'stream_event', ...(userMessageId ? { user_message_uuid: userMessageId } : {}),
    event: { type: 'message_start', message: { id: messageId } },
  };
}

function success(extra = {}) {
  return { type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0, ...extra };
}

function orphanResult(extra = {}) {
  return success({
    origin: { kind: 'task-notification' }, num_turns: 0, duration_api_ms: 0, result: '', ...extra,
  });
}

for (const [label, terminal] of [
  ['permission denial', { permission_denials: [{ tool_name: 'Agent' }] }],
  ['stream abort', { terminal_reason: 'aborted_streaming' }],
  ['tool abort', { terminal_reason: 'aborted_tools' }],
  ['error flag', { is_error: true }],
  ['error subtype', { subtype: 'error_during_execution' }],
  ['missing success subtype', { subtype: undefined }],
]) {
  test(`orchestrate ${label} finishes without sending a repair even when the result claims to wait`, () => {
    const { sess, events, pushes, ingest } = liveRun('new-user', { orchestrate: true });
    ingest(streamStart('new-user'));
    const result = success({ result: '子任务正在等待完成', ...terminal });
    ingest(result);
    assert.equal(sess.busy, false);
    assert.equal(pushes.length, 0);
    assert.equal(events.filter(event => event.type === 'job-done').length, 1);
    assert.strictEqual(events.at(-1).finalResult, result);
  });
}

test('successful orchestrate false-wait remains eligible for bounded repair within the same run', () => {
  const { sess, events, pushes, ingest } = liveRun('new-user', { orchestrate: true });
  ingest(streamStart('new-user'));
  ingest(success({ result: '子任务正在等待完成' }));
  assert.equal(sess.busy, true);
  assert.equal(sess.jobId, 'new-user');
  assert.equal(pushes.length, 1);
  assert.equal(sess.orchRepairAttempts, 1);
  assert.equal(events.some(event => event.type === 'job-done'), false);
});

test('success with a rejected tool waits for an already-running child and never pushes a repair', () => {
  const { sess, events, pushes, ingest } = liveRun('new-user', { orchestrate: true });
  ingest(streamStart('new-user'));
  ingest({ type: 'system', subtype: 'task_started', task_id: 'already-running', tool_use_id: 'child-call', task_type: 'local_agent' });
  const denial = { permission_denials: [{ tool_name: 'PowerShell' }] };
  ingest(success({ result: '子任务正在等待完成', ...denial }));
  assert.equal(sess.busy, true); assert.equal(pushes.length, 0);
  assert.equal(events.some(event => event.type === 'job-done'), false);
  ingest({ type: 'system', subtype: 'task_notification', task_id: 'already-running', tool_use_id: 'child-call', status: 'completed' });
  ingest(success({ result: 'final answer with limitations', ...denial }));
  assert.equal(sess.busy, false); assert.equal(pushes.length, 0);
  assert.equal(events.at(-1).finalResult.result, 'final answer with limitations');
  assert.equal(events.filter(event => event.type === 'job-done').length, 1);
});

test('success with a rejected tool respects SDK queued turns without injecting a new send', () => {
  const { sess, events, pushes, ingest } = liveRun('new-user', { keepAlive: false });
  ingest(streamStart('new-user'));
  const denial = { permission_denials: [{ tool_name: 'PowerShell' }] };
  ingest(success({ user_message_uuid: 'new-user', result: '', queued_turn_count: 1, ...denial }));
  assert.equal(sess.busy, true); assert.equal(events.some(event => event.type === 'job-done'), false);
  ingest(success({ user_message_uuid: 'new-user', result: 'complete', queued_turn_count: 0, ...denial }));
  assert.equal(sess.busy, false); assert.equal(pushes.length, 0);
});

test('camel-case child result cannot finish its live parent or replace parent timing', () => {
  const { sess, events, ingest } = liveRun();
  ingest(streamStart('new-user'));
  sess.turnRouter.toolIds.add('child-tool');
  ingest(success({ parentToolUseId: 'child-tool', result: 'child output', duration_ms: 5 }));
  assert.equal(sess.busy, true);
  assert.equal(events.filter(event => event.type === 'job-done').length, 0);
  assert.equal(events.at(-1).parent_tool_use_id, 'child-tool');
  ingest(success({ result: 'parent delivered', duration_ms: 300 }));
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).finalResult.result, 'parent delivered');
});

test('resume orphan notification cannot complete the new send before its actual reply', () => {
  const { sess, events, ingest } = liveRun();
  ingest({
    type: 'system', subtype: 'task_notification', task_id: 'previous-shell', status: 'stopped',
    summary: 'No completion record was found for this background shell command from the previous session.',
  });
  // The send acknowledgement can precede the orphan's synthetic result.
  ingest({ type: 'user', uuid: 'new-user', message: { content: 'new request' } });
  ingest(orphanResult());
  assert.equal(sess.busy, true);
  assert.equal(events.some((event) => event.type === 'job-done'), false);
  assert.equal(events.some((event) => event.subtype === 'task_notification'), false);

  ingest(streamStart('new-user'));
  ingest({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'actual reply' } } });
  ingest({ type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'actual reply' }] } });
  const finalResult = success({ user_message_uuid: 'new-user', result: 'actual reply', num_turns: 1 });
  ingest(finalResult);
  assert.equal(sess.busy, false);
  assert.equal(events.filter((event) => event.type === 'job-done').length, 1);
  assert.strictEqual(events.at(-1).finalResult, finalResult);
  assert.equal(events.filter((event) => event.type === 'stream_event').length, 2);
});

test('an unknown old notification blocks its untagged meta reply until the current send replies', () => {
  const { sess, events, ingest } = liveRun();
  ingest({ type: 'user', message: { content: '<task-notification><task-id>old-shell</task-id></task-notification>' } });
  ingest(streamStart(null, 'old-meta'));
  ingest({ type: 'assistant', message: { content: [{ type: 'text', text: 'old task output' }] } });
  ingest(orphanResult());
  assert.equal(events.length, 0);
  assert.equal(sess.busy, true);
  ingest(streamStart('new-user', 'current'));
  ingest(success({ user_message_uuid: 'new-user', result: 'current reply' }));
  assert.equal(events.at(-1).type, 'job-done');
});

test('foreign first-frame UUID rejects following untagged text and old success/error results', () => {
  const { sess, events, ingest } = liveRun();
  ingest(streamStart('old-user'));
  ingest({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'old' } } });
  ingest(success({ user_message_uuid: 'old-user', result: 'old reply' }));
  ingest({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: { kind: 'task-notification' } });
  assert.equal(sess.busy, true);
  assert.equal(events.length, 0);
  ingest(streamStart('new-user'));
  ingest(success({ user_message_uuid: 'new-user', result: 'new reply' }));
  assert.equal(events.at(-1).finalResult.result, 'new reply');
});

test('idle traffic and a previous completed stream cannot attach themselves to a new run', () => {
  const router = new LiveTurnRouter();
  router.begin('old-user');
  assert.ok(router.accept(streamStart('old-user')));
  router.end();
  assert.equal(router.accept(success({ result: 'idle result' })), null);
  router.begin('new-user');
  assert.equal(router.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'late old text' }] } }), null);
  assert.ok(router.accept(streamStart('new-user')));
  assert.ok(router.accept({ type: 'stream_event', event: { type: 'message_stop' } }));
});

test('an orphan notification seen during prewarm keeps its foreign boundary across the next send', () => {
  const router = new LiveTurnRouter();
  assert.equal(router.accept({ type: 'system', subtype: 'task_notification', task_id: 'old-task', status: 'stopped' }), null);
  router.begin('new-user');
  assert.equal(router.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'old meta reply' }] } }), null);
  assert.equal(router.accept(orphanResult()), null);
  assert.ok(router.accept(streamStart('new-user')));
  assert.ok(router.accept(success({ user_message_uuid: 'new-user', result: 'current' })));
});

test('an unrelated meta error without any reply cannot fail the pending user send', () => {
  const { sess, events, ingest } = liveRun();
  ingest({ type: 'result', subtype: 'error_during_execution', is_error: true, origin: { kind: 'task-notification' } });
  assert.equal(sess.busy, true);
  assert.equal(events.length, 0);
});

test('real Agent notification continuation is preserved and only its final result completes the run', () => {
  const { sess, events, ingest } = liveRun();
  ingest(streamStart('new-user'));
  ingest({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent' }] } });
  ingest({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'agent-1', task_type: 'local_agent' }] });
  ingest({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'agent-call', task_type: 'local_agent' });
  ingest(success({ user_message_uuid: 'new-user', result: 'waiting' }));
  assert.equal(sess.busy, true);
  ingest({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', tool_use_id: 'agent-call', status: 'completed' });
  ingest({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  ingest(orphanResult());
  assert.equal(sess.busy, true, 'even an owned notification-only result is not the final summary');
  ingest(streamStart(null, 'agent-summary'));
  ingest({ type: 'assistant', message: { id: 'agent-summary', content: [{ type: 'text', text: 'complete summary' }] } });
  const finalResult = success({ origin: { kind: 'task-notification' }, num_turns: 1, duration_api_ms: 20, result: 'complete summary' });
  ingest(finalResult);
  assert.equal(sess.busy, false);
  assert.equal(events.filter((event) => event.type === 'job-done').length, 1);
  assert.strictEqual(events.at(-1).finalResult, finalResult);
});

test('startup/session failures without UUID still settle a waiting run', () => {
  const { sess, events, ingest } = liveRun();
  ingest({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['startup failed'] });
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).finalResult.is_error, true);
});

test('a zero process exit without a real terminal result is an incomplete run, never success', () => {
  const { sess, events, ingest, exit } = liveRun();
  ingest(orphanResult());
  exit(0);
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).type, 'job-done');
  assert.equal(events.at(-1).exitCode, -1);
  assert.match(events.at(-1).error, /最终结果/);
  assert.equal(events.at(-1).finalResult, undefined);
});

test('a process exit after a completed run does not emit a second terminal event', () => {
  const { events, ingest, exit } = liveRun();
  ingest(streamStart('new-user'));
  ingest(success({ user_message_uuid: 'new-user', result: 'final' }));
  exit(0);
  assert.equal(events.filter((event) => event.type === 'job-done').length, 1);
});

test('interrupt result without UUID completes even while an old reply was being ignored', () => {
  const { sess, events, ingest } = liveRun();
  ingest(streamStart('old-user'));
  sess.turnRouter.interrupt();
  ingest({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'interrupted' });
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).type, 'job-done');
  sess.turnRouter.begin('next-user');
  assert.ok(sess.turnRouter.accept(streamStart('next-user')));
});

test('a success-shaped aborted result can settle a pre-reply interrupt despite queued input', () => {
  const { sess, events, ingest } = liveRun();
  ingest(streamStart('old-user'));
  sess.turnRouter.interrupt();
  ingest(success({ terminal_reason: 'aborted_streaming', result: '', queued_turn_count: 1 }));
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).finalResult.terminal_reason, 'aborted_streaming');
});

test('interrupt receipt with surviving queued sends recycles before reporting a preserved session', async () => {
  const interruptStart = source.indexOf('async function interruptLiveTurn(sess) {');
  const interruptStop = source.indexOf('// IPC: 中止任务', interruptStart);
  let killed = false;
  const router = new LiveTurnRouter();
  router.begin('new-user');
  const context = { TaskClock: require('../task-clock').TaskClock,
    console: { log() {}, warn() {} },
    cancelPendingLiveInput: require('../live-mcp-dispatch').cancelPendingLiveInput,
    withLiveControlTimeout: (promise) => promise,
    waitForLiveTurnIdle() { throw new Error('must not reuse a session with surviving input'); },
    killLiveSession() { killed = true; },
  };
  context.liveTurnControls = new (require('../live-turn-control').LiveTurnControls)({
    cancelPendingInput: context.cancelPendingLiveInput, settleUnsent() {},
    withTimeout: context.withLiveControlTimeout, waitForIdle: context.waitForLiveTurnIdle, killSession: context.killLiveSession,
  });
  vm.runInNewContext(`${source.slice(interruptStart, interruptStop)}\nglobalThis.interrupt = interruptLiveTurn;`, context);
  const outcome = await context.interrupt({
    jobId: 'new-user', convId: 'conversation', turnRouter: router,
    child: { async interrupt() { return { still_queued: ['new-user'] }; } },
  });
  assert.equal(killed, true);
  assert.equal(outcome.preservedSession, false);
  assert.equal(outcome.fallback, true);
});

test('queued sends prevent completion even when Agent keep-alive is disabled', () => {
  const { sess, events, ingest } = liveRun('new-user', { keepAlive: false });
  ingest(streamStart('new-user'));
  ingest(success({ user_message_uuid: 'new-user', result: 'first', queued_turn_count: 1 }));
  assert.equal(sess.busy, true);
  sess.turnRouter.addSend('next-send');
  ingest(streamStart('next-send'));
  ingest(success({ user_message_uuid: 'next-send', result: 'second' }));
  assert.equal(events.filter((event) => event.type === 'job-done').length, 1);
  assert.equal(events.at(-1).finalResult.result, 'second');
});

test('internal repair send shares the Relay run but receives its own SDK reply UUID', () => {
  const router = new LiveTurnRouter();
  router.begin('original');
  assert.ok(router.accept(streamStart('original')));
  router.addSend('repair');
  assert.ok(router.accept(streamStart('repair')));
  assert.ok(router.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'repaired' }] } }));
  assert.ok(router.accept(success({ user_message_uuid: 'repair', result: 'repaired' })));
  assert.equal(router.accept(success({ user_message_uuid: 'unrelated', result: 'foreign' })), null);
});

test('legacy SDK replies without UUID still complete and missing fields do not make orphan results final', () => {
  const { sess, events, ingest } = liveRun();
  ingest({ type: 'assistant', message: { content: [{ type: 'text', text: 'legacy reply' }] } });
  ingest(success({ result: 'legacy reply' }));
  assert.equal(sess.busy, false);
  assert.equal(events.at(-1).finalResult.result, 'legacy reply');
});
