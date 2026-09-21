'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, full, result } = require('./renderer-activity-harness.cjs');

const ledgerTask = (runId, state, turnIndex) => ({
  runId, kind: 'chat', state, source: { conversationId: 'conv', turnIndex },
});
const laterTurn = () => ({
  runId: 'later-job', user: 'synthetic later request', assistant: 'synthetic saved reply', status: 'complete',
});

function recoveryFixture(turns, tasks, events = []) {
  const h = harness('plain'), c = h.context;
  Object.assign(h.conv, { kind: 'chat', updatedAt: 'synthetic-original-order', turns: clone(turns) });
  c.runs.clear(); c.jobToConv.clear(); c.currentConv = null;
  const saved = [], registered = [], warnings = [];
  Object.assign(c, {
    activeView: 'settings', pendingConversationViewReloads: new Set(), cvJobs: new Map(),
    restoringActiveRuns: true, restoringTaskLifecycle: true,
    bufferedClaudeEvents: [], bufferedTaskLifecycleEvents: [],
    TERMINAL_LEDGER_STATES: new Set(['succeeded', 'failed', 'canceled', 'interrupted']),
    handleTaskLifecycleEvent: async () => {},
    console: { ...console, warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  });
  c.window.api.history.save = async (value) => {
    saved.push(clone(value));
    return { updatedAt: `synthetic-save-${saved.length}` };
  };
  c.window.api.tasks = {
    snapshot: async () => ({ ok: true, epoch: 'synthetic-new-instance', items: tasks }),
    replayStream: async () => {
      registered.push(...c.runs.values());
      return { ok: true, hasMore: false, events: events.map((event, index) => ({
        seq: index + 1, runId: event.jobId, payload: { event },
      })) };
    },
  };
  for (const name of ['claudeEventFingerprint', 'taskSource', 'taskIsTerminal', 'taskIsCreation',
    'taskCanRestoreChat', 'taskTurnHasPersistedOutcome', 'taskTurnLocation', 'taskErrorText',
    'finishRun', 'reconcileRestoredChatTask', 'restoreActiveRunsFromLedger']) h.loadFunction(name);
  return {
    ...h, saved, registered,
    async restore() {
      c.restoringActiveRuns = true; c.restoringTaskLifecycle = true;
      await c.restoreActiveRunsFromLedger();
      await Promise.all(registered.map(run => run.finishPromise).filter(Boolean));
      assert.deepEqual(warnings, [], 'production recovery completes without swallowed errors');
    },
  };
}

test('saved empty error in an older turn is not replayed, registered or saved across repeated starts', async () => {
  const h = recoveryFixture([
    { runId: 'old-job', user: 'synthetic old request', assistant: '', status: 'error' },
    { runId: 'middle-job', user: 'synthetic middle request', assistant: 'saved middle reply', status: 'complete' },
    laterTurn(),
  ], [ledgerTask('old-job', 'canceled', 0), ledgerTask('middle-job', 'succeeded', 1), ledgerTask('later-job', 'succeeded', 2)], [
    { jobId: 'old-job', ...full('obsolete', 'obsolete replay must not replace saved error') },
  ]);
  const before = clone(h.conv);
  for (let startup = 0; startup < 3; startup += 1) {
    await h.restore();
    assert.equal(h.context.runs.size, 0);
    assert.equal(h.context.jobToConv.size, 0);
    assert.equal(h.registered.length, 0, 'old terminal never briefly becomes a running sidebar item');
    assert.equal(h.saved.length, 0);
    assert.deepEqual(h.conv, before, 'history contents and updatedAt remain unchanged');
  }
});

test('explicit saved terminal statuses protect empty replies in both legacy turns and structured output', async () => {
  for (const status of ['complete', 'completed', 'succeeded', 'success', 'error', 'failed',
    'canceled', 'cancelled', 'aborted', 'paused', 'interrupted']) {
    for (const field of ['turn', 'output']) {
      const turn = { runId: 'old-job', user: 'synthetic', assistant: '' };
      if (field === 'turn') turn.status = status;
      else turn.output = { status, final: '' };
      const h = recoveryFixture([turn, laterTurn()], [ledgerTask('old-job', 'interrupted', 0)]);
      const before = clone(h.conv);
      await h.restore();
      assert.equal(h.registered.length, 0, `${field}.${status} is already persisted`);
      assert.equal(h.saved.length, 0);
      assert.deepEqual(h.conv, before);
    }
  }
});

test('skipping an old canceled turn allows the actual active later turn to restore', async () => {
  const h = recoveryFixture([
    { runId: 'old-job', user: 'synthetic old request', assistant: '', status: 'error' },
    { runId: 'live-job', user: 'synthetic active request', assistant: '', status: 'running' },
  ], [ledgerTask('old-job', 'canceled', 0), ledgerTask('live-job', 'running', 1)], [
    { jobId: 'live-job', ...full('live-message', 'synthetic live progress') },
  ]);
  const before = clone(h.conv);
  await h.restore();
  assert.deepEqual(h.registered.map(run => run.jobId), ['live-job']);
  assert.equal(h.context.runForJob('live-job').turnIndex, 1);
  assert.equal(h.context.runForJob('live-job').restoredFromLedger, true);
  assert.equal(h.context.runForJob('old-job'), undefined);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.conv, before);
});

test('an unmarked historical placeholder recovers its final journal reply without changing later turns', async () => {
  const h = recoveryFixture([
    { runId: 'old-job', user: 'synthetic unsaved request', assistant: '' }, laterTurn(),
  ], [ledgerTask('old-job', 'succeeded', 0), ledgerTask('later-job', 'succeeded', 1)], [
    { jobId: 'old-job', ...full('recovered-message', 'synthetic recovered final') },
    { jobId: 'old-job', ...result('synthetic recovered final') },
    { jobId: 'old-job', type: 'job-done', exitCode: 0, finalResult: result('synthetic recovered final') },
  ]);
  const laterBefore = clone(h.conv.turns[1]);
  await h.restore();
  assert.deepEqual(h.registered.map(run => run.jobId), ['old-job']);
  assert.equal(h.saved.length, 1);
  assert.equal(h.conv.turns[0].assistant, 'synthetic recovered final');
  assert.equal(h.conv.turns[0].output.status, 'complete');
  assert.equal(h.conv.updatedAt, 'synthetic-save-1');
  assert.deepEqual(h.conv.turns[1], laterBefore);
  assert.equal(h.context.runs.size, 0);
  const savedBeforeRestart = clone(h.conv);
  await h.restore();
  assert.equal(h.saved.length, 1, 'recovered final is not saved again on the next startup');
  assert.deepEqual(clone(h.conv), savedBeforeRestart);
});

test('terminal ledger without a saved turn outcome still settles an interrupted placeholder', async () => {
  const h = recoveryFixture([
    { runId: 'old-job', user: 'synthetic interrupted request', assistant: '' }, laterTurn(),
  ], [ledgerTask('old-job', 'interrupted', 0)]);
  await h.restore();
  assert.equal(h.registered.length, 1);
  assert.equal(h.saved.length, 1);
  assert.equal(h.conv.turns[0].output.status, 'error');
  assert.equal(h.context.runs.size, 0);
  await h.restore();
  assert.equal(h.saved.length, 1);
});

test('live authoritative ledger remains recoverable even with a stale saved output status', async () => {
  const h = recoveryFixture([
    { runId: 'live-job', user: 'synthetic active request', assistant: '', output: { status: 'error', final: '' } },
  ], [ledgerTask('live-job', 'running', 0)]);
  await h.restore();
  assert.equal(h.context.runForJob('live-job').restoredFromLedger, true);
  assert.equal(h.saved.length, 0);
});


test('recovering a WSL placeholder retains its original session environment and provider route', async () => {
  const h = recoveryFixture([{ runId: 'wsl-job', user: 'synthetic pending', assistant: '' }],
    [ledgerTask('wsl-job', 'succeeded', 0)], [
      { jobId: 'wsl-job', ...full('wsl-final', 'recovered WSL reply') },
      { jobId: 'wsl-job', ...result('recovered WSL reply') },
      { jobId: 'wsl-job', type: 'job-done', exitCode: 0, finalResult: result('recovered WSL reply') },
    ]);
  Object.assign(h.conv, { sessionId: 'synthetic-wsl-session', sessionAgentEnvironment: 'wsl',
    sessionProviderId: 'synthetic-provider', sessionProviderRevision: 3, sessionRouteTier: 'haiku' });
  await h.restore();
  assert.equal(h.saved.length, 1);
  assert.equal(h.registered[0].sessionAgentEnvironment, 'wsl');
  assert.equal(h.saved[0].sessionAgentEnvironment, 'wsl');
  assert.equal(h.saved[0].sessionProviderId, 'synthetic-provider');
  assert.equal(h.saved[0].sessionProviderRevision, 3);
  assert.equal(h.saved[0].sessionRouteTier, 'haiku');
});
