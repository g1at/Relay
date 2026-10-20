'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isConversationRunning } = require('../src/main/app/conversation-running');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const { RUN_STATES } = require('../src/main/tasks/task-protocol');
const { LiveTurnControls } = require('../src/main/live/live-turn-control');

function ledgerFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-conversation-running-'));
  const taskLedger = new TaskLedger({ rootDir, logger: { warn() {} } });
  t.after(() => {
    taskLedger.flush();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return taskLedger;
}

test('warm SDK handles and saved goal mode do not mark an idle conversation running', () => {
  const session = {
    busy: false, dead: false, child: { pid: 123 },
    executionMode: { kind: 'goal' }, goalRecovery: { condition: 'unfinished goal' },
    asyncAgentTracker: { size: 0 }, backgroundTaskTracker: { size: 0 },
  };
  assert.equal(isConversationRunning('idle', { liveSessions: new Map([['idle', session]]) }), false);
  assert.equal(isConversationRunning('missing', { liveSessions: new Map([['idle', session]]) }), false);
});

test('live work and residual child tasks block only their owning conversation', () => {
  for (const session of [
    { busy: true },
    { busy: false, asyncAgentTracker: { size: 1 } },
    { busy: false, backgroundTaskTracker: { size: 1 } },
  ]) {
    const liveSessions = new Map([['active', session]]);
    assert.equal(isConversationRunning('active', { liveSessions }), true);
    assert.equal(isConversationRunning('other', { liveSessions }), false);
  }
});

test('all nonterminal ledger states block deletion, including queued, waiting and stopping', t => {
  const taskLedger = ledgerFixture(t);
  for (const state of [
    RUN_STATES.QUEUED, RUN_STATES.STARTING, RUN_STATES.RUNNING,
    RUN_STATES.WAITING_USER, RUN_STATES.STOPPING,
  ]) {
    const id = 'conversation-' + state, runId = 'run-' + state;
    taskLedger.create({ runId, state, source: { type: 'conversation', conversationId: id } });
    assert.equal(isConversationRunning(id, { taskLedger }), true, state);
  }
  assert.equal(isConversationRunning('unrelated', { taskLedger }), false);
});

test('completed, failed, manually canceled and interrupted tasks do not block idle deletion', t => {
  const taskLedger = ledgerFixture(t);
  for (const state of [
    RUN_STATES.SUCCEEDED, RUN_STATES.FAILED, RUN_STATES.CANCELED, RUN_STATES.INTERRUPTED,
  ]) {
    const id = 'conversation-' + state, runId = 'run-' + state;
    taskLedger.create({ runId, state: RUN_STATES.STARTING, source: { type: 'conversation', conversationId: id } });
    taskLedger.terminal(runId, state);
    assert.equal(isConversationRunning(id, { taskLedger }), false, state);
  }
});

test('queued scheduled and image runs remain active for their conversation before an executor exists', t => {
  const taskLedger = ledgerFixture(t);
  for (const type of ['schedule', 'creation']) {
    taskLedger.create({ runId: 'queued-' + type, state: RUN_STATES.QUEUED,
      source: { type, conversationId: 'owner-' + type } });
    assert.equal(isConversationRunning('owner-' + type, { taskLedger, liveSessions: new Map() }), true);
  }
});

test('mini chat preparation and finishing block deletion until the controller settles', () => {
  let running = true;
  const miniChat = { getConversationId: () => 'mini', isRunning: () => running };
  assert.equal(isConversationRunning('mini', { miniChat }), true);
  assert.equal(isConversationRunning('other', { miniChat }), false);
  running = false;
  assert.equal(isConversationRunning('mini', { miniChat }), false);
});

test('a pending native stop remains busy after the visible turn has settled', async () => {
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const liveTurnControls = new LiveTurnControls({
    withTimeout: promise => promise,
    cancelPendingInput: () => false,
    settleUnsent: () => {},
    waitForIdle: async () => true,
    killSession: () => closed,
  });
  const child = { kill: () => closed, whenClosed: () => closed };
  const stopping = liveTurnControls.stopOneShot(child, 'run-stop', 'stopping');
  assert.equal(isConversationRunning('stopping', { liveTurnControls, liveSessions: new Map() }), true);
  assert.equal(isConversationRunning('other', { liveTurnControls }), false);
  release({ stopConfirmed: true });
  assert.equal((await stopping).settled, true);
  assert.equal(isConversationRunning('stopping', { liveTurnControls }), false);
});

test('unavailable authoritative task state cannot be interpreted as an idle conversation', () => {
  const taskLedger = { list() { throw Object.assign(Error('fixture ledger unavailable'), { code: 'EACCES' }); } };
  assert.throws(() => isConversationRunning('uncertain', { taskLedger }), { code: 'EACCES' });
});
