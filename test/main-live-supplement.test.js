'use strict';
// Real main-process admission, stream dispatch and completion with in-memory
// conversations and a synthetic Query. No Electron, filesystem writes or model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { LiveTurnRouter } = require('../src/main/live/live-turn-router');
const { LiveAsyncAgentTracker, LiveBackgroundTaskTracker, liveResultDisposition } = require('../src/main/live/live-async-agent-tracker');
const supplements = require('../src/main/live/live-supplement-input');
const { SdkSessionObserver, backgroundOwnedTask, observeOwnedBackgroundTasks, RouteTimingHistory } = require('../src/main/sdk/sdk-session-observer');
const { resourceEntries, mergeResources } = require('../src/main/sdk/sdk-task-resources');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const ids = { conv: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222', first: '33333333-3333-4333-8333-333333333333', second: '44444444-4444-4444-8444-444444444444', other: '55555555-5555-4555-8555-555555555555' };
function declaration(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  const tail = source.slice(start), end = /\n(?:async )?function \w+\(/.exec(tail);
  return end ? tail.slice(0, end.index) : tail;
}
function harness() {
  const records = new Map([[ids.conv, { id: ids.conv, title: 'Synthetic task', updatedAt: '2026-01-01T00:00:00.000Z', pinned: true, sessionId: 'same-sdk-session', turns: [{ runId: ids.run, user: 'original request', assistant: '' }] }]]);
  const events = [], pushes = [], kills = [], writes = [], rejected = [];
  const liveSessions = new Map(), ledger = new Map(), jobs = new Map();
  const observer = new SdkSessionObserver();
  const sess = { observer, launchSpec: { cwd: '/synthetic' }, convId: ids.conv, jobId: ids.run, busy: true, dead: false,
    onEvent: event => events.push(clone(event)), turnRouter: new LiveTurnRouter(),
    asyncAgentTracker: new LiveAsyncAgentTracker(), backgroundTaskTracker: new LiveBackgroundTaskTracker(),
    supplementInputs: new Map(), checkpointRunIds: new Set(), keepAliveForAsyncAgents: true,
    child: { push(text, metadata) { pushes.push({ text, metadata }); return true; } },
  };
  sess.turnRouter.begin(ids.run);liveSessions.set(ids.conv, sess);
  const context = { TaskClock: require('../src/main/tasks/task-clock').TaskClock, ...supplements, observer, resourceEntries, mergeResources, routeTimingHistory: new RouteTimingHistory(), sess, convId: ids.conv, liveSessions, jobs, liveTombstones: new Map(),
    readAppSettings: () => ({ followUpMode: 'steer' }),
    liveResultDisposition, observeOwnedBackgroundTasks, console: { log() {}, warn() {}, error() {} },
    taskLedger: { get: id => ledger.get(id) || null }, isTerminalState: value => ['succeeded', 'failed', 'canceled'].includes(value),
    liveTurnControls: { isStopping: () => false }, interactionBroker: { rejectTask: (...args) => rejected.push(args) }, checkpointManager: null,
    loadConversation: id => records.has(id) ? clone(records.get(id)) : null,
    persistConversationRecord: value => { records.set(value.id, clone(value)); writes.push(clone(value)); },
    fs: { existsSync: id => records.has(id) }, convFilePath: id => id,
    TITLE_MAX_W: 64, truncateByWidth: text => text,
    touchIdleTimer() {}, refreshTrayMenu() {}, retryMissingOrchestrateAgents() { return false; },
    setTimeout() { return { unref() {} }; }, snapshotMcpChildren() {},
    killLiveSession(value, reason) { kills.push(reason);value.dead=true;liveSessions.delete(value.convId); },
    cancelPendingLiveInput(value) { value.pendingInput=null; },
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context);
  for (const name of ['persistGoalRecovery', 'saveConversation', 'persistLiveSupplementRecord', 'publishLiveSupplement', 'settleLiveSupplements', 'steerLiveTurn', 'finishTurn', 'settleUnsentLiveTurn']) vm.runInContext(declaration(name), context);
  const start = source.indexOf('  const onMessage = (evt) => {', source.indexOf('function spawnLiveSession'));
  const end = source.indexOf('  const canUseTool = ', start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.ingest=onMessage;globalThis.exit=onExit;', context);
  const input = (messageId=ids.first, prompt='supplemental request') => ({ jobId: ids.run, conversationId: ids.conv, messageId, prompt, files: [], skill: null });
  return { context, sess, records, events, pushes, kills, writes, ledger, jobs, liveSessions, input,
    steer: value => context.steerLiveTurn(value || input()), ingest: event => context.ingest(event),
    saved: () => records.get(ids.conv), final: () => events.filter(event => event.type === 'job-done'),
  };
}
const start = id => ({ type: 'stream_event', user_message_uuid: id, event: { type: 'message_start', message: { id: 'reply-' + id } } });
const result = (id=ids.run, extra={}) => ({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: id, queued_turn_count: 0, result: 'final answer', ...extra });
const lifecycle = (id, state) => ({ type: 'command_lifecycle', command_uuid: id, state });

function foregroundTask(h, { toolUseId = 'manual-bash', taskId = 'native-bash', name = 'Bash' } = {}) {
  h.ingest(start(ids.run));
  h.ingest({ type: 'assistant', user_message_uuid: ids.run, message: { content: [{ type: 'tool_use', id: toolUseId, name, input: {} }] } });
  h.ingest({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId,
    task_type: name === 'Bash' ? 'local_bash' : 'local_agent', is_backgrounded: false });
  return { toolUseId, taskId };
}
function backgroundResult(h, task) {
  h.ingest({ type: 'system', subtype: 'task_updated', task_id: task.taskId, patch: { is_backgrounded: true } });
  h.ingest({ type: 'user', tool_use_result: { backgroundTaskId: task.taskId },
    message: { content: [{ type: 'tool_result', tool_use_id: task.toolUseId, content: 'Running in background' }] } });
}
function backgroundRequest(h, task) {
  return backgroundOwnedTask({ session: h.sess, convId: ids.conv, jobId: ids.run, toolUseId: task.toolUseId,
    isCurrent: session => h.liveSessions.get(ids.conv) === session });
}

test('manual background Bash preserves its owning run through native completion and a fresh continuation result', async () => {
  const h = harness(), task = foregroundTask(h); h.sess.child.backgroundTasks = async () => true;
  assert.equal((await backgroundRequest(h, task)).ok, true); backgroundResult(h, task);
  h.ingest(result());
  assert.equal(h.sess.busy, true); assert.equal(h.sess.jobId, ids.run); assert.equal(h.final().length, 0); assert.equal(h.kills.length, 0);
  assert.equal(h.events.find(event => event.type === 'result').relay_pending_background_tasks, 1);
  assert.equal(h.sess.turnRouter.awaitingAgent, true);
  // Native terminal updates precede delivery of the completion notification.
  h.ingest({ type: 'system', subtype: 'task_updated', task_id: task.taskId, patch: { status: 'completed' } });
  h.ingest(result()); assert.equal(h.final().length, 0);
  h.ingest({ type: 'system', subtype: 'task_notification', task_id: task.taskId, tool_use_id: task.toolUseId, status: 'completed' });
  assert.equal(h.final().length, 0, 'a notification does not reuse an older result');
  h.ingest(result(undefined, { user_message_uuid: undefined, origin: { kind: 'task-notification' }, result: 'Actual continuation answer' }));
  assert.equal(h.final().length, 1); assert.equal(h.final()[0].jobId, ids.run);
  assert.equal(h.final()[0].finalResult.result, 'Actual continuation answer'); assert.equal(h.kills.length, 0);
});

test('native events arriving before the background control acknowledgement still preserve the turn', async () => {
  const h = harness(), task = foregroundTask(h); let release;
  h.sess.child.backgroundTasks = () => new Promise(resolve => { release = resolve; });
  const request = backgroundRequest(h, task); await Promise.resolve(); backgroundResult(h, task); h.ingest(result());
  assert.equal(h.final().length, 0); assert.equal(h.sess.jobId, ids.run);
  release(true); assert.equal((await request).ok, true);
  assert.equal(h.final().length, 0); assert.equal(h.kills.length, 0);
});

test('a timed-out background request remains cancelable and its late receipt cannot revive the task', async () => {
  const h = harness(), task = foregroundTask(h); let release;
  h.sess.child.backgroundTasks = () => new Promise(resolve => { release = resolve; });
  const outcome = await backgroundOwnedTask({ session: h.sess, convId: ids.conv, jobId: ids.run,
    toolUseId: task.toolUseId, isCurrent: session => h.liveSessions.get(ids.conv) === session, timeoutMs: 5 });
  assert.equal(outcome.pending, true); backgroundResult(h, task); h.ingest(result()); assert.equal(h.final().length, 0);
  h.sess.turnRouter.interrupt(); h.ingest(result(undefined, { terminal_reason: 'aborted_tools' }));
  assert.equal(h.final().length, 1); assert.equal(h.sess.dead, true); assert.equal(h.kills.length, 1);
  release(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.final().length, 1); assert.equal(h.sess.backgroundRequests.size, 0);
});

test('background ownership survives follow-up input but never postpones real failures or user interruption', async () => {
  for (const mode of ['follow-up', 'error', 'pause']) {
    const h = harness(), task = foregroundTask(h); h.sess.child.backgroundTasks = async () => true;
    await backgroundRequest(h, task); backgroundResult(h, task);
    if (mode === 'follow-up') {
      h.steer(); h.ingest(result()); assert.equal(h.final().length, 0);
      h.ingest({ type: 'system', subtype: 'task_notification', task_id: task.taskId, tool_use_id: task.toolUseId, status: 'completed' });
      h.ingest(result()); assert.equal(h.final().length, 0, 'pending new input still owns completion');
      h.ingest(lifecycle(ids.first, 'started')); h.ingest(result()); assert.equal(h.final().length, 1); assert.equal(h.kills.length, 0);
    } else {
      if (mode === 'pause') h.sess.turnRouter.interrupt();
      h.ingest(result(undefined, mode === 'pause' ? { terminal_reason: 'aborted_tools' } : { is_error: true }));
      assert.equal(h.final().length, 1); assert.equal(h.kills.length, 1); assert.equal(h.sess.dead, true);
    }
  }
});

test('normal background commands and reset-old manual requests cannot claim a new run', async () => {
  const ordinary = harness(), task = foregroundTask(ordinary); backgroundResult(ordinary, task); ordinary.ingest(result());
  assert.equal(ordinary.final().length, 1); assert.equal(ordinary.kills.length, 1, 'legacy unsolicited background cleanup remains bounded');
  const h = harness(); h.ingest({ type: 'system', subtype: 'init', session_id: 'before' });
  const manual = foregroundTask(h); h.sess.child.backgroundTasks = async () => true; await backgroundRequest(h, manual);
  backgroundResult(h, manual);
  h.ingest({ type: 'conversation_reset', session_id: 'before', new_conversation_id: 'after' });
  h.ingest({ ...start(ids.run), session_id: 'after' }); h.ingest(result(ids.run, { session_id: 'after' }));
  assert.equal(h.final().length, 1); assert.equal(h.kills.length, 0); assert.equal(h.sess.backgroundRequests.size, 0);
});

test('acceptance persists to the owning run and uses the same Query without interruption', () => {
  const h = harness(), outcome = h.steer();
  assert.equal(outcome.ok, true);assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].metadata.uuid, ids.first);assert.equal(h.pushes[0].metadata.priority, 'next');
  assert.equal(h.sess.jobId, ids.run);assert.equal(h.sess.busy, true);assert.equal(h.kills.length, 0);
  const saved = h.saved();assert.equal(saved.turns.length, 1);assert.equal(saved.turns[0].supplements[0].text, 'supplemental request');
  assert.equal(saved.pinned, true);assert.equal(saved.sessionId, 'same-sdk-session');assert.notEqual(saved.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(h.events[0].subtype, 'relay_user_input');assert.equal(h.events[0].jobId, ids.run);
});

test('context reset rejects late parent results and retires old child ownership without ending the run', () => {
  const h = harness();
  h.ingest({ type: 'system', subtype: 'init', session_id: 'before' });
  h.ingest({ ...start(ids.run), session_id: 'before' });
  h.ingest({ type: 'assistant', session_id: 'before', user_message_uuid: ids.run,
    message: { content: [{ type: 'tool_use', id: 'old-agent', name: 'Agent', input: {} }] } });
  h.sess.backgroundTaskTracker.tasks.set('old-task', {});
  h.ingest({ type: 'conversation_reset', uuid: 'reset', session_id: 'before', new_conversation_id: 'after' });
  assert.equal(h.sess.sessionId, 'after');
  assert.equal(h.sess.turnRouter.toolIds.size, 0);
  assert.equal(h.sess.backgroundTaskTracker.tasks.size, 0);
  const count = h.events.length;
  h.ingest(result(undefined, { session_id: 'before', user_message_uuid: undefined, result: 'late old result' }));
  h.ingest({ type: 'assistant', session_id: 'before', message: { content: [{ type: 'text', text: 'old text' }] } });
  h.ingest({ type: 'assistant', session_id: 'child', parent_tool_use_id: 'old-agent', message: { content: [{ type: 'text', text: 'old child' }] } });
  assert.equal(h.events.length, count); assert.equal(h.sess.busy, true); assert.equal(h.final().length, 0);
  h.ingest({ ...start(ids.run), session_id: 'after' });
  h.ingest(result(ids.run, { session_id: 'after' }));
  assert.equal(h.final().length, 1); assert.equal(h.sess.busy, false);
  assert.equal(h.saved().sessionId, 'after'); assert.equal(h.saved().pinned, true);
});

test('same-run same-ID retries are durable and idempotent even after job completion', () => {
  const h = harness();h.steer();const acceptedAt = h.saved().updatedAt;
  assert.equal(h.steer().duplicate, true);assert.equal(h.pushes.length, 1);
  h.ingest(lifecycle(ids.first, 'started'));h.ingest(result());
  const writes = h.writes.length, replay = h.steer();
  assert.equal(replay.ok, true);assert.equal(replay.duplicate, true);assert.equal(replay.input.status, 'applied');
  assert.equal(h.writes.length, writes);assert.equal(h.pushes.length, 1);assert.equal(h.saved().updatedAt, acceptedAt);
});

test('conflicting retry, wrong run, missing history and invalid IDs cannot push', () => {
  const h = harness();h.steer();
  assert.equal(h.steer(h.input(ids.first, 'changed content')).code, 'INPUT_CONFLICT');
  assert.equal(h.steer({ ...h.input(ids.second), jobId: ids.other }).code, 'HISTORY_MISSING');
  assert.equal(h.steer({ ...h.input(ids.second), conversationId: ids.other }).code, 'HISTORY_MISSING');
  assert.equal(h.steer({ ...h.input(ids.second), conversationId: '../outside' }).code, 'INVALID_INPUT');
  assert.equal(h.pushes.length, 1);
});

test('one-shot execution is explicitly unsupported and resource admission returns NOT_READY', () => {
  const h = harness();h.liveSessions.clear();h.jobs.set(ids.run, {});
  assert.equal(h.steer().code, 'UNSUPPORTED_EXECUTOR');
  h.jobs.clear();h.ledger.set(ids.run, { state: 'queued', source: { conversationId: ids.conv } });
  assert.equal(h.steer().code, 'NOT_READY');
  h.ledger.get(ids.run).state='succeeded';assert.equal(h.steer().code, 'NOT_RUNNING');
  assert.equal(h.writes.length, 0);assert.equal(h.pushes.length, 0);
});

test('stale or stopping live task cannot accept input for the previous run', () => {
  const h = harness();h.sess.jobId=ids.other;
  assert.equal(h.steer().code, 'NOT_RUNNING');h.sess.jobId=ids.run;
  h.context.liveTurnControls.isStopping=()=>true;assert.equal(h.steer().code, 'TURN_STOPPING');
  assert.equal(h.writes.length, 0);assert.equal(h.pushes.length, 0);
});

test('old result with queued count zero cannot finish pending supplemental input', () => {
  const h = harness();h.ingest(start(ids.run));h.steer();h.ingest(result());
  assert.equal(h.sess.busy, true);assert.equal(h.final().length, 0);
  assert.equal(h.events.find(event => event.type==='result').relay_pending_inputs, 1);
  const timestamp = h.saved().updatedAt;h.ingest(lifecycle(ids.first, 'started'));
  assert.equal(h.final().length, 0, 'consumption does not reuse the earlier result');
  assert.equal(h.saved().turns[0].supplements[0].status, 'applied');assert.equal(h.saved().updatedAt, timestamp);
  h.ingest(result());assert.equal(h.final().length, 1);assert.equal(h.final()[0].finalResult.result, 'final answer');assert.equal(h.kills.length, 0);
});

test('a native started receipt before the old result cannot prematurely finish a revised task', () => {
  const h = harness(); h.ingest(start(ids.run)); h.steer();
  h.ingest(lifecycle(ids.first, 'started'));
  assert.equal(h.saved().turns[0].supplements[0].status, 'applied');
  h.ingest(result(ids.run, { user_message_uuids: [ids.run], result: 'old answer' }));
  assert.equal(h.sess.busy, true); assert.equal(h.sess.jobId, ids.run); assert.equal(h.final().length, 0);
  assert.equal(h.events.find(event => event.type === 'result').relay_pending_inputs, 1);
  h.ingest(start(ids.first));
  assert.equal(h.final().length, 0, 'starting the revised answer cannot reuse the old result');
  h.ingest(result(ids.first, { user_message_uuids: [ids.first], result: 'revised answer' }));
  assert.equal(h.final().length, 1); assert.equal(h.final()[0].finalResult.result, 'revised answer');
  assert.equal(h.final()[0].jobId, ids.run); assert.equal(h.kills.length, 0);
  assert.equal(h.pushes.length, 1, 'the accepted input was never resent');
});

test('a partial native consumed-input list keeps uncovered supplements on the same task', () => {
  const h = harness(); h.ingest(start(ids.run)); h.steer(); h.steer(h.input(ids.second, 'second supplement'));
  h.ingest(lifecycle(ids.first, 'started')); h.ingest(lifecycle(ids.second, 'started'));
  h.ingest(result(ids.run, { user_message_uuids: [ids.run, ids.first] }));
  assert.equal(h.final().length, 0); assert.equal(h.sess.busy, true);
  assert.equal(h.events.find(event => event.type === 'result').relay_pending_inputs, 1);
  h.ingest(result(ids.second, { user_message_uuids: [ids.second], result: 'all requested changes' }));
  assert.equal(h.final().length, 1); assert.equal(h.final()[0].finalResult.result, 'all requested changes');
  assert.equal(h.kills.length, 0); assert.equal(h.pushes.length, 2);
});

test('a native combined result covering the original and folded supplement completes exactly once', () => {
  const h = harness(); h.ingest(start(ids.run)); h.steer(); h.ingest(lifecycle(ids.first, 'started'));
  const final = result(ids.run, { user_message_uuids: [ids.run, ids.first], result: 'combined answer' });
  h.ingest(final); h.ingest(final);
  assert.equal(h.final().length, 1); assert.equal(h.final()[0].finalResult.result, 'combined answer');
  assert.equal(h.kills.length, 0);
});

test('coalesced supplements complete with one new representative result', () => {
  const h = harness();h.ingest(start(ids.run));h.steer();h.steer(h.input(ids.second, 'second supplement'));h.ingest(result());
  h.ingest(lifecycle(ids.first, 'started'));h.ingest(lifecycle(ids.second, 'started'));
  assert.equal(h.final().length, 0);h.ingest(result());
  assert.equal(h.final().length, 1);assert.deepEqual(h.saved().turns[0].supplements.map(x=>x.status), ['applied','applied']);assert.equal(h.kills.length, 0);
});

test('queued/echo receipts do not consume supplements or retire the existing reply owner', () => {
  const h = harness();h.ingest(start(ids.run));h.steer();h.ingest(lifecycle(ids.first, 'queued'));
  h.ingest({ type:'user',uuid:ids.first,isReplay:true,message:{content:'supplemental request'} });
  h.ingest({ type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'still A'}} });
  h.ingest(result());assert.equal(h.sess.turnRouter.replyOwner, ids.run);assert.equal(h.final().length, 0);
  assert.equal(h.saved().turns[0].supplements[0].status, 'queued');assert.ok(h.events.some(e=>e.event&&e.event.delta&&e.event.delta.text==='still A'));
});

test('true failure reports unapplied input and recycles surviving queued commands before reuse', () => {
  const h = harness();h.ingest(start(ids.run));h.steer();h.ingest(result(ids.run,{is_error:true,result:'real error'}));
  assert.equal(h.final().length, 1);assert.equal(h.kills.length, 1);assert.equal(h.sess.dead, true);
  assert.equal(h.final()[0].relay_unapplied_inputs[0].status, 'rejected');assert.equal(h.saved().turns[0].supplements[0].status, 'rejected');
  assert.ok(h.events.findIndex(e=>e.subtype==='relay_user_input'&&e.input.status==='rejected')<h.events.findIndex(e=>e.type==='job-done'));
  h.context.exit(0);assert.equal(h.final().length, 1);
});

test('manual pause cancels pending supplements while preserving the existing stop path', () => {
  const h = harness();h.ingest(start(ids.run));h.steer();h.sess.turnRouter.interrupt();
  h.ingest(result(ids.run,{terminal_reason:'aborted_tools'}));
  assert.equal(h.final().length, 1);assert.equal(h.kills.length, 1);assert.equal(h.final()[0].relay_unapplied_inputs[0].status, 'canceled');
});

test('a stopped or failed turn keeps folded input delivered even without an earlier started receipt', () => {
  for (const terminal_reason of ['aborted_streaming', 'api_error']) {
    const h = harness(); h.ingest(start(ids.run)); h.steer(); h.ingest(lifecycle(ids.first, 'queued'));
    if (terminal_reason === 'aborted_streaming') h.sess.turnRouter.interrupt();
    h.ingest(result(ids.run, { subtype: 'error_during_execution', is_error: true, num_turns: 3,
      terminal_reason, result: '', user_message_uuids: [ids.run, ids.first] }));
    assert.equal(h.saved().turns[0].supplements[0].status, 'applied');
    assert.equal(h.final().length, 1); assert.equal(h.final()[0].finalResult.is_error, true);
    assert.equal(h.final()[0].finalResult.terminal_reason, terminal_reason);
    assert.equal(h.final()[0].relay_unapplied_inputs, undefined);
    assert.equal(h.final()[0].finalResult.relay_pending_inputs, undefined);
    assert.equal(h.kills.length, 0, 'an absorbed input is not a leftover queue entry');
    assert.equal(h.pushes.length, 1, 'no automatic replay of the delivered supplement');
  }
});

test('a stopped combined result cancels only supplements absent from its consumed input list', () => {
  const h = harness(); h.ingest(start(ids.run)); h.steer(); h.steer(h.input(ids.second, 'Still queued'));
  h.sess.turnRouter.interrupt();
  h.ingest(result(ids.run, { subtype: 'error_during_execution', is_error: true, num_turns: 2,
    terminal_reason: 'aborted_tools', result: '', user_message_uuids: [ids.run, ids.first] }));
  assert.deepEqual(h.saved().turns[0].supplements.map(input => input.status), ['applied', 'canceled']);
  assert.deepEqual(h.final()[0].relay_unapplied_inputs.map(input => input.id), [ids.second]);
  assert.equal(h.final()[0].finalResult.relay_pending_inputs, 1);
  assert.equal(h.final().length, 1); assert.equal(h.kills.length, 1); assert.equal(h.pushes.length, 2);
});

test('CLI-rejected input is visible in final metadata without replacing the final answer', () => {
  for(const [state,status] of [['refused','rejected'],['discarded','canceled']]) {
    const h=harness();h.ingest(start(ids.run));h.steer();h.ingest(lifecycle(ids.first,state));h.ingest(result());
    assert.equal(h.final().length,1);assert.equal(h.final()[0].finalResult.result,'final answer');
    assert.equal(h.final()[0].relay_unapplied_inputs[0].status,status);assert.equal(h.kills.length,0);
  }
});

test('unexpected exit settles unconsumed records before router state is cleared', () => {
  const h=harness();h.steer();h.context.exit(0,'synthetic transport close');
  assert.equal(h.final().length,1);assert.equal(h.final()[0].exitCode,-1);assert.equal(h.final()[0].relay_unapplied_inputs[0].status,'rejected');
  assert.equal(h.saved().turns[0].supplements[0].status,'rejected');
});

test('pre-dispatch pause settles accepted input and a delayed MCP completion never pushes it', async () => {
  const h=harness();let release;const done=new Promise(resolve=>{release=resolve;});h.sess.pendingInput={done};
  assert.equal(h.steer().ok,true);assert.equal(h.pushes.length,0);
  h.context.settleUnsentLiveTurn(h.sess,ids.run,'已暂停',true);release();await done;await Promise.resolve();
  assert.equal(h.pushes.length,0);assert.equal(h.final().length,1);assert.equal(h.final()[0].relay_unapplied_inputs[0].status,'canceled');
  assert.equal(h.kills.length,0);
});

test('canonical supplements survive stale renderer history saves and status writes preserve timestamps', () => {
  const h=harness(), stale=clone(h.saved());h.steer();const accepted=h.saved().updatedAt;
  h.ingest(lifecycle(ids.first,'started'));assert.equal(h.saved().updatedAt,accepted);
  stale.turns[0].assistant='delayed final content';stale.updatedAt=accepted;h.context.saveConversation(stale);
  assert.equal(h.saved().turns[0].assistant,'delayed final content');assert.equal(h.saved().turns[0].supplements[0].status,'applied');
  assert.equal(h.saved().turns[0].supplements[0].text,'supplemental request');assert.equal(h.saved().updatedAt,accepted);
});

test('Windows receipt rename failure recovers on a later SDK result and survives stale final saves', () => {
  const h = harness(); h.steer(); const accepted = h.saved().updatedAt;
  const persist = h.context.persistConversationRecord; let locked = true;
  h.context.persistConversationRecord = value => {
    if (locked && value.turns[0].supplements?.[0]?.status === 'applied') throw Object.assign(Error('synthetic rename failure'), { code: 'EPERM' });
    return persist(value);
  };
  h.ingest(lifecycle(ids.first, 'started'));
  assert.equal(h.sess.supplementInputs.get(ids.first).status, 'applied');
  assert.equal(h.saved().turns[0].supplements[0].status, 'queued');
  assert.equal(h.events.filter(event => event.subtype === 'relay_user_input').at(-1).input.status, 'applied');
  const stale = clone(h.saved()); locked = false;
  h.ingest(result(ids.first, { user_message_uuids: [ids.first] }));
  assert.equal(h.saved().turns[0].supplements[0].status, 'applied');
  h.context.saveConversation(stale);
  assert.equal(h.saved().turns[0].supplements[0].status, 'applied');
  assert.equal(h.saved().updatedAt, accepted); assert.equal(h.final().length, 1);
});

test('a save after final settlement recovers the live receipt even when all earlier writes were locked', () => {
  const h = harness(); h.steer(); const persist = h.context.persistConversationRecord;
  h.context.persistConversationRecord = () => { throw Object.assign(Error('synthetic lock'), { code: 'EPERM' }); };
  h.ingest(lifecycle(ids.first, 'started'));
  h.ingest(result(ids.first, { user_message_uuids: [ids.first] }));
  assert.equal(h.saved().turns[0].supplements[0].status, 'queued');
  assert.equal(h.sess.jobId, null);
  h.context.persistConversationRecord = persist;
  h.context.saveConversation(clone(h.saved()));
  assert.equal(h.saved().turns[0].supplements[0].status, 'applied');
});

test('preload and distribution include the steer IPC and its production helper', () => {
  const preload=fs.readFileSync(path.join(__dirname, '../preload.js'),'utf8');let exposed;
  const calls=[];vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld(_key,value){exposed=value;}},ipcRenderer:{invoke:(...args)=>calls.push(args),on(){},removeListener(){}},webUtils:{}}),process:{platform:'win32',argv:[]}});
  const payload={jobId:ids.run,conversationId:ids.conv,messageId:ids.first,prompt:'extra'};exposed.steerClaude(payload);
  assert.equal(calls[0][0],'claude:steer');assert.equal(calls[0][1],payload);
  const pkg=JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'),'utf8'));
  assert.ok(pkg.build.files.includes('src/main/**/*.js') && fs.existsSync(path.join(__dirname, '../src/main/live/live-supplement-input.js')));assert.match(pkg.scripts['test:noninterrupt-steering'],/noninterrupt-steering-smoke/);
});


test('host defaults to queued follow-up and reverses only the requested input without pausing', () => {
  const h = harness(); h.context.readAppSettings = () => ({ followUpMode: 'queue' });
  assert.equal(h.steer().ok, true);
  assert.equal(h.pushes[0].metadata.priority, 'later');
  assert.equal(h.saved().turns[0].supplements[0].followUpMode, 'queue');
  assert.equal(h.steer({ ...h.input(ids.second), reverseFollowUp: true }).ok, true);
  assert.equal(h.pushes[1].metadata.priority, 'next');
  assert.equal(h.saved().turns[0].supplements[1].followUpMode, 'steer');
  assert.equal(h.context.readAppSettings().followUpMode, 'queue');
  assert.equal(h.kills.length, 0); assert.equal(h.sess.busy, true);
});

test('invalid follow-up mode cannot bypass validation through reversal', () => {
  const h = harness();
  const response = h.steer({ ...h.input(), followUpMode: 'invalid', reverseFollowUp: true });
  assert.equal(response.ok, false); assert.equal(response.code, 'INVALID_INPUT');
  assert.equal(h.pushes.length, 0); assert.equal(h.writes.length, 0);
});


test('a failed goal remains recoverable while successful goal output clears only recovery metadata', () => {
  for (const failed of [false, true]) {
    const h = harness();
    h.sess.executionMode = { kind: 'goal' };
    h.saved().goalRecovery = { condition: 'fixture objective' };
    h.ingest(lifecycle(ids.run, 'started'));
    h.ingest(result(ids.run, { is_error: failed, terminal_reason: failed ? 'api_error' : 'completed' }));
    assert.deepEqual(h.saved().goalRecovery, failed ? { condition: 'fixture objective' } : null);
    assert.equal(h.saved().updatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(h.saved().pinned, true);
    assert.equal(h.final().length, 1);
  }
});

test('successful goal with a denied tool keeps recovery metadata without adding a continuation', () => {
  const h = harness();
  h.sess.executionMode = { kind: 'goal' };
  h.saved().goalRecovery = { condition: 'fixture objective' };
  h.ingest(lifecycle(ids.run, 'started'));
  h.ingest(result(ids.run, { terminal_reason: 'completed', permission_denials: [{ tool_name: 'PowerShell' }] }));
  assert.deepEqual(h.saved().goalRecovery, { condition: 'fixture objective' });
  assert.equal(h.final().length, 1); assert.equal(h.pushes.length, 0);
  assert.equal(h.final()[0].finalResult.is_error, false);
});

test('success with a denied tool waits for a user-backgrounded task already in progress', async () => {
  const h = harness(), task = foregroundTask(h); h.sess.child.backgroundTasks = async () => true;
  assert.equal((await backgroundRequest(h, task)).ok, true); backgroundResult(h, task);
  const denial = { permission_denials: [{ tool_name: 'PowerShell' }] };
  h.ingest(result(ids.run, denial));
  assert.equal(h.sess.busy, true); assert.equal(h.final().length, 0);
  assert.equal(h.kills.length, 0); assert.equal(h.pushes.length, 0);
  h.ingest({ type: 'system', subtype: 'task_notification', task_id: task.taskId, tool_use_id: task.toolUseId, status: 'completed' });
  h.ingest(result(undefined, { ...denial, user_message_uuid: undefined, origin: { kind: 'task-notification' }, result: 'completed reply' }));
  assert.equal(h.final().length, 1); assert.equal(h.pushes.length, 0);
});
