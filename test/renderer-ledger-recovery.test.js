'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, full, result, stream } = require('./renderer-activity-harness.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskEventJournal } = require('../task-event-journal');
const { TaskProgressStore } = require('../task-progress-store');

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
    'taskCanRestoreChat', 'taskTurnHasPersistedOutcome', 'taskHasEmptyInterruptedProgress', 'taskTurnLocation', 'taskErrorText',
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

const interruptedTask = (runId = 'old-job') => ({
  ...ledgerTask(runId, 'interrupted', 0), execution: { appInstanceId: 'previous-process' },
  result: { error: { code: 'APP_RESTART', message: 'Relay restarted before the task reached a terminal state' } },
});
const processFrames = (jobId = 'old-job') => [
  { jobId, type: 'assistant', uuid: 'process-message', message: { id: 'm1', content: [
    { type: 'thinking', thinking: 'Synthetic already-visible reasoning' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'synthetic.txt' } },
  ] } },
  { jobId, type: 'user', uuid: 'tool-receipt', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'Synthetic file contents' },
  ] } },
  { jobId, ...full('partial', 'Synthetic progress, work still pending', { uuid: 'partial-message' }) },
];

function journalFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crash-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { rootDir: path.join(root, 'events'), logger: { warn() {} } };
  return { root, before: new TaskEventJournal({ ...options, epoch: 'previous-process' }),
    restart: () => new TaskEventJournal({ ...options, epoch: 'new-process' }) };
}

test('a real previous-process journal restores thinking, tool receipts and partial output after a crash', async t => {
  const disk = journalFixture(t);
  disk.before.appendMany(processFrames().map(event => ({ type: 'claude.event', runId: 'old-job', payload: { event } })));
  const journal = disk.restart();
  const h = recoveryFixture([{ runId: 'old-job', user: 'synthetic request', assistant: '' }, laterTurn()], [interruptedTask()]);
  const requests = [];
  h.context.window.api.tasks.replayStream = async request => {
    requests.push(request);
    h.registered.push(...h.context.runs.values());
    return { ok: true, ...journal.replayEpoch(clone(request)) };
  };
  const later = clone(h.conv.turns[1]);
  await h.restore();
  assert.equal(requests[0].epoch, 'previous-process');
  assert.equal(requests[0].runId, 'old-job');
  const turn = h.conv.turns[0];
  assert.equal(turn.status, 'error');
  assert.equal(turn.assistant, '', 'partial narration must never become a final answer');
  assert.ok(turn.activity.items.some(item => item.type === 'thinking'));
  assert.equal(turn.activity.items.find(item => item.toolUseId === 'tool-1').result, 'Synthetic file contents');
  assert.ok(turn.activity.items.some(item => item.result === 'Synthetic progress, work still pending'));
  assert.deepEqual(h.conv.turns[1], later);
  await h.restore();
  assert.equal(h.saved.length, 1, 'completed recovery is idempotent');
});

test('a durable progress snapshot survives missing old journals and repairs an already-saved empty restart error', async t => {
  const disk = journalFixture(t);
  const writer = new TaskProgressStore({ rootDir: path.join(disk.root, 'progress') });
  writer.observe(disk.before.appendMany(processFrames().map(event => ({ type: 'claude.event', runId: 'old-job', payload: { event } }))));
  await writer.close();
  fs.rmSync(disk.before.journalPath);
  const reader = new TaskProgressStore({ rootDir: path.join(disk.root, 'progress') });
  t.after(() => reader.close());
  const h = recoveryFixture([{ runId: 'old-job', user: 'synthetic request', assistant: '', status: 'error',
    error: 'Relay restarted before the task reached a terminal state', activity: { items: [] },
    output: { status: 'error', messages: [] } }], [interruptedTask()]);
  h.context.window.api.tasks.progress = async runId => ({ ok: true, progress: await reader.load(runId) });
  h.context.window.api.tasks.replayStream = async request => {
    h.registered.push(...h.context.runs.values());
    assert.ok(request.sinceSeq > 0);
    return { ok: true, missing: true, resetRequired: true, events: [], hasMore: false };
  };
  await h.restore();
  assert.equal(h.conv.turns[0].assistant, '');
  assert.equal(h.conv.turns[0].status, 'error');
  assert.equal(h.conv.turns[0].activity.items.filter(item => item.type === 'thinking').length, 1);
  assert.ok(h.conv.turns[0].activity.items.some(item => item.toolUseId === 'tool-1'));
  assert.match(h.conv.turns[0].outputNotice, /部分执行过程/);
  await h.restore();
  assert.equal(h.saved.length, 1);
});

test('a blank historical restart error without recoverable evidence stays unchanged', async () => {
  const h = recoveryFixture([{ runId: 'old-job', assistant: '', status: 'error', activity: { items: [] } }], [interruptedTask()]);
  await h.restore();
  assert.equal(h.saved.length, 0);
  assert.equal(h.registered.length, 0);
});

test('snapshot cursor prevents buffered stream deltas from being appended twice', async () => {
  const seed = harness();
  const events = [
    stream({ type: 'message_start', message: { id: 'streaming' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first ' } }),
  ];
  events.forEach(event => seed.send(event));
  const h = recoveryFixture([{ runId: 'live-job', assistant: '' }], [{
    ...ledgerTask('live-job', 'running', 0), execution: { appInstanceId: 'synthetic-new-instance' },
  }]);
  h.context.window.api.tasks.progress = async () => ({ ok: true, progress: {
    runId: 'live-job', epoch: 'synthetic-new-instance', seq: 3,
    output: seed.output.serialize(seed.run.outputState), activity: seed.context.window.RelayActivity.serialize(seed.run.activityState),
  } });
  h.context.bufferedClaudeEvents.push(
    { jobId: 'live-job', ...events[2], relay_stream_epoch: 'synthetic-new-instance', relay_stream_seq: 3 },
    { jobId: 'live-job', ...stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second' } }),
      relay_stream_epoch: 'synthetic-new-instance', relay_stream_seq: 4 },
  );
  await h.restore();
  const output = h.context.runForJob('live-job').outputState;
  assert.equal(h.output.textFor(output.messages[0]), 'first second');
  assert.equal(h.saved.length, 0);
});

test('a checkpoint after the only job-done frame retains its authoritative final result', async t => {
  const disk = journalFixture(t);
  const store = new TaskProgressStore({ rootDir: path.join(disk.root, 'progress') });
  const done = { jobId: 'old-job', type: 'job-done', exitCode: 0, finalResult: result('Synthetic confirmed result') };
  store.observe(disk.before.appendMany([{ type: 'claude.event', runId: 'old-job', payload: { event: done } }]));
  await store.close();
  const task = { ...interruptedTask(), state: 'succeeded', result: {} };
  const h = recoveryFixture([{ runId: 'old-job', assistant: '' }], [task]);
  h.context.window.api.tasks.progress = async runId => ({ ok: true, progress: await store.load(runId) });
  await h.restore();
  assert.equal(h.conv.turns[0].assistant, 'Synthetic confirmed result');
  assert.equal(h.conv.turns[0].status, 'complete');
});

test('a journal read failure is disclosed when settling an interrupted run', async () => {
  const h = recoveryFixture([{ runId: 'old-job', assistant: '' }], [interruptedTask()]);
  h.context.window.api.tasks.replayStream = async () => {
    h.registered.push(...h.context.runs.values());
    return { ok: false, error: 'Synthetic unavailable journal' };
  };
  await h.restore();
  assert.equal(h.conv.turns[0].status, 'error');
  assert.match(h.conv.turns[0].outputNotice, /部分执行过程/);
});
