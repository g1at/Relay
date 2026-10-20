'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, full, result } = require('./renderer-activity-harness.cjs');

const priorTs = '2026-09-28T07:04:42.155Z';
const currentTs = '2026-09-28T09:10:12.672Z';
const prior = () => ({ runId: 'prior', ts: priorTs, user: 'Earlier request',
  assistant: 'Preserved earlier answer', assistantTs: '2026-09-28T09:01:28.211Z', status: 'complete' });
const task = () => ({ runId: 'job', kind: 'chat', state: 'running',
  source: { conversationId: 'conv', mode: 'plain' }, metadata: { turnIndex: 1, turnTs: currentTs } });
const original = () => ({ runId: 'job', ts: currentTs,
  user: 'Original request\n第二行内容', files: [{ path: '/synthetic/input.txt', name: 'input.txt' }],
  skill: { name: 'synthetic-skill' }, assistant: '' });

function restoreHarness(turns, recoverTurn) {
  const h = harness();
  h.conv.kind = 'chat'; h.conv.turns = clone(turns);
  const c = h.context;
  c.runs.clear(); c.jobToConv.clear();
  Object.assign(c, {
    activeView: 'settings', pendingConversationViewReloads: new Set(), cvJobs: new Map(),
    restoringActiveRuns: true, restoringTaskLifecycle: true,
    bufferedClaudeEvents: [], bufferedTaskLifecycleEvents: [],
    TERMINAL_LEDGER_STATES: new Set(['succeeded', 'failed', 'canceled', 'interrupted']),
    handleTaskLifecycleEvent: async () => {}, reconcileRestoredChatTask: async () => {},
    loadConversation: async () => { throw Error('Recovery must preserve current navigation'); },
    console: { ...console, warn() {} },
  });
  c.window.api.history.recoverTurn = recoverTurn;
  c.window.api.tasks = {
    snapshot: async () => ({ ok: true, epoch: 'synthetic-epoch', items: [task()] }),
    replayStream: async () => ({ ok: true, events: [], hasMore: false }),
  };
  for (const name of ['claudeEventFingerprint', 'taskIsTerminal', 'taskIsCreation', 'taskCanRestoreChat',
    'taskTurnHasPersistedOutcome', 'taskHasEmptyInterruptedProgress', 'restoreActiveRunsFromLedger']) h.loadFunction(name);
  return h;
}

test('a missing ledger turn never falls back to the previous completed answer', () => {
  const h = harness();
  const conv = { id: 'conv', turns: [prior()] };
  assert.equal(h.context.taskTurnLocation(conv, task(), { allowLastFallback: true }), null);
  assert.deepEqual(conv.turns, [prior()]);
});

test('turn identity survives shifted indices and rejects conflicting timestamps or position-only matches', () => {
  const h = harness();
  const conv = { id: 'conv', turns: [prior(), { runId: 'other', ts: '2026-09-28T09:05:00Z' }, original()] };
  assert.equal(h.context.taskTurnLocation(conv, task()).index, 2);
  const wrongTs = task(); wrongTs.metadata.turnTs = priorTs;
  assert.equal(h.context.taskTurnLocation(conv, wrongTs), null);
  assert.equal(h.context.taskTurnLocation({ id: 'conv', turns: [{ user: 'no identity' }] },
    { runId: 'job', metadata: { turnIndex: 0 } }), null);
  assert.equal(h.context.taskTurnLocation({ id: 'other-conversation', turns: [original()] }, task()), null);
  const legacy = original(); delete legacy.runId;
  assert.equal(h.context.taskTurnLocation({ id: 'conv', turns: [legacy] }, task()).index, 0);
});

test('ledger recovery obtains a separate original turn and preserves its text, files, skill and time', async () => {
  const calls = [];
  const recovered = { id: 'conv', kind: 'chat', turns: [prior(), original()] };
  const h = restoreHarness([prior()], async (...args) => { calls.push(args); return { ok: true, conversation: clone(recovered) }; });
  await h.context.restoreActiveRunsFromLedger();
  assert.deepEqual(calls, [['conv', 'job']]);
  const restored = h.context.runForJob('job');
  assert.equal(restored.turnIndex, 1);
  assert.equal(restored.turn.user, original().user);
  assert.equal(restored.turn.ts, currentTs);
  assert.deepEqual(clone(restored.turn.files), original().files);
  assert.deepEqual(clone(restored.turn.skill), original().skill);
  assert.deepEqual(h.conv.turns, [prior()], 'renderer must not rewrite a stale history object');
  assert.equal(h.persisted, undefined);
});

test('unrecoverable or incorrectly identified source input cannot hide an old answer', async () => {
  for (const response of [{ ok: false }, { ok: true, conversation: { id: 'conv', turns: [prior()] } }]) {
    const h = restoreHarness([prior()], async () => clone(response));
    await h.context.restoreActiveRunsFromLedger();
    assert.equal(h.context.runs.size, 0);
    assert.deepEqual(h.conv.turns, [prior()]);
    assert.equal(h.persisted, undefined);
  }
});

test('terminal output patches its run by identity and preserves a concurrently appended turn', async () => {
  const h = harness();
  h.run.turnIndex = 0; // Deliberately stale index: current disk position is 1.
  h.conv.turns = [prior()]; // Deliberately stale renderer object.
  let disk = { id: 'conv', kind: 'chat', turns: [prior(), original()] };
  const calls = [];
  h.context.window.api.history.load = async () => clone(disk);
  h.context.window.api.history.save = async () => { throw Error('Full history writes are forbidden on finalization'); };
  h.context.window.api.history.completeTurn = async (id, runId, ts, payload) => {
    calls.push({ id, runId, ts, payload: clone(payload) });
    disk.turns.push({ runId: 'later', ts: '2026-09-28T11:00:00.000Z', user: 'Later request', assistant: '' });
    const target = disk.turns.find(turn => turn.runId === runId && turn.ts === ts);
    assert.ok(target);
    Object.assign(target, clone(payload.turn));
    return { id, updatedAt: 'synthetic-time', conversation: clone(disk) };
  };
  h.send(full('final', 'Current confirmed answer'));
  const finishedAt = Date.parse('2026-09-28T10:00:00.000Z');
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('Current confirmed answer'), relay_task_finished_at: finishedAt });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'job'); assert.equal(calls[0].ts, currentTs);
  assert.equal(calls[0].payload.turn.assistantTs, '2026-09-28T10:00:00.000Z');
  assert.equal(Object.hasOwn(calls[0].payload, 'turns'), false);
  assert.deepEqual(disk.turns[0], prior());
  assert.equal(disk.turns[1].user, original().user);
  assert.deepEqual(disk.turns[1].files, original().files);
  assert.equal(disk.turns[1].assistant, 'Current confirmed answer');
  assert.equal(disk.turns[2].user, 'Later request');
  assert.equal(h.context.currentConv.turns.length, 3);
});

test('finalization recovers missing input from the host before submitting the outcome', async () => {
  const h = harness();
  h.context.activeView = 'settings'; h.context.pendingConversationViewReloads = new Set();
  h.conv.turns = [prior()];
  let disk = clone(h.conv), recovered = false;
  h.context.window.api.history.load = async () => clone(disk);
  h.context.window.api.history.recoverTurn = async (id, runId) => {
    assert.equal(id, 'conv'); assert.equal(runId, 'job');
    disk.turns.push(original()); recovered = true;
    return { ok: true, conversation: clone(disk) };
  };
  h.context.window.api.history.completeTurn = async (id, runId, ts, payload) => {
    assert.equal(recovered, true);
    Object.assign(disk.turns.find(turn => turn.runId === runId && turn.ts === ts), clone(payload.turn));
    return { id, conversation: clone(disk) };
  };
  h.send(full('final', 'Recovered answer'));
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('Recovered answer') });
  assert.deepEqual(disk.turns[0], prior());
  assert.equal(disk.turns[1].user, original().user);
  assert.equal(disk.turns[1].assistant, 'Recovered answer');
  assert.equal(h.context.pendingConversationViewReloads.has('chat:conv'), true);
});

test('finalization refuses an unmatched turn when trusted recovery is unavailable', async () => {
  const h = harness();
  h.conv.turns = [prior()];
  h.context.window.api.history.completeTurn = async () => { throw Error('must not complete another turn'); };
  h.send(full('final', 'Answer retained by task progress'));
  await assert.rejects(h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('Answer retained by task progress') }), /无法确认本轮原始消息/);
  assert.deepEqual(h.conv.turns, [prior()]);
  assert.equal(h.persisted, undefined);
});

test('a recovered terminal keeps its task clock finish time when the replay event lacks it', async () => {
  const h = harness();
  const startedAt = Date.parse(currentTs), finishedAt = startedAt + 60000;
  h.run.turn.taskRun = { version: 1, taskId: 'job', resumedFromRunId: null, rootStartedAt: startedAt,
    segmentStartedAt: startedAt, elapsedBeforeMs: 0, segmentFinishedAt: finishedAt, elapsedMs: 60000 };
  h.send(full('final', 'Stored completion time'));
  await h.context.finishRunUnsafe('job', { exitCode: 0, relay_task_finished_at: Number.MAX_VALUE,
    finalResult: result('Stored completion time') });
  assert.equal(h.persisted.turns[0].assistantTs, new Date(finishedAt).toISOString());
});

test('automatic session retry removes only its own placeholder through the narrow API', async () => {
  const h = harness();
  h.run.sessionId = 'expired-session';
  h.run.stderrBuf = 'No conversation found with session ID';
  h.run.turn.user = original().user;
  h.run.turn.files = original().files;
  h.run.turn.skill = original().skill;
  h.conv.turns = [prior(), original(), { runId: 'later', ts: '2026-09-28T11:00:00Z', user: 'Keep later request' }];
  let disk = clone(h.conv), retryArgs;
  h.context.window.api.history.load = async () => clone(disk);
  h.context.window.api.history.save = async () => { throw Error('retry must not save a whole conversation'); };
  h.context.window.api.history.completeTurn = async (id, runId, ts, payload) => {
    assert.deepEqual(clone(payload), { retryWithoutResume: true });
    const index = disk.turns.findIndex(turn => turn.runId === runId && turn.ts === ts);
    assert.equal(index, 1); disk.turns.splice(index, 1); disk.sessionId = null;
    return { id, conversation: clone(disk) };
  };
  h.context.relaunchWithoutResume = async (...args) => { retryArgs = args; };
  await h.context.finishRunUnsafe('job', { exitCode: 1, error: 'No conversation found with session ID' });
  assert.deepEqual(disk.turns[0], prior());
  assert.equal(disk.turns[1].user, 'Keep later request');
  assert.equal(retryArgs[1], original().user);
  assert.deepEqual(clone(retryArgs[2]), original().files);
  assert.deepEqual(clone(retryArgs[3]), original().skill);
});
