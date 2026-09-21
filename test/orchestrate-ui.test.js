'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, result, full, notification } = require('./renderer-activity-harness.cjs');

for (const status of ['completed', 'failed', 'running', 'pending', null]) {
  test(`legacy XML notification (${status || 'default status'}) updates only its task in the shared activity stream`, () => {
    const h = harness('orchestrate');
    h.send({ type: 'assistant', message: { id: 'launch', content: [
      { type: 'tool_use', id: 'parent', name: 'Agent', input: { subagent_type: 'analyst', prompt: 'synthetic' } },
    ] } });
    const event = notification(status, 'child result');
    const before = clone(event);
    const normalized = h.context.activityEventsForClaudeEvent(event);
    const running = ['running', 'pending'].includes(status);
    assert.equal(normalized.length, running ? 1 : 2);
    assert.equal(normalized.some((entry) => Object.hasOwn(entry, 'uuid')), false, 'synthetic events must not share a UUID and suppress each other');
    assert.equal(normalized[0].type, 'system');
    assert.equal(normalized[0].subtype, 'task_notification');
    assert.equal(normalized[0].status, status || 'completed');
    h.send(event);
    const task = h.run.activityState.items.find((item) => item.toolUseId === 'parent');
    assert.equal(task.type, 'task');
    assert.equal(task.taskId, 'task-child');
    assert.equal(task.status, running ? 'running' : status === 'failed' ? 'error' : 'success');
    if (!running) assert.equal(task.result, 'child result');
    else assert.notEqual(task.result, 'child result', 'intermediate result payload is not a completed tool result');
    assert.equal(h.run.activityState.phase, 'running', 'child completion does not complete the main activity');
    assert.equal(h.run.turn.assistant, '');
    assert.equal(h.run.error, undefined);
    assert.deepEqual(h.rendered, []);
    assert.deepEqual(h.finalizations, []);
    assert.deepEqual(event, before, 'normalization does not mutate original history/stream envelopes');
  });
}

for (const knownTask of [false, true]) {
  test(`task-id-only legacy notification ${knownTask ? 'reuses the existing task mapping' : 'creates one presentation task'} without orphan tool rows`, () => {
    const h = harness('orchestrate');
    if (knownTask) h.send({ type: 'system', subtype: 'task_started', task_id: 'task-child', tool_use_id: 'parent', description: 'synthetic child' });
    const event = notification('completed', 'child result');
    event.message.content = event.message.content.replace('<tool-use-id>parent</tool-use-id>', '');
    h.send(event);
    const rows = h.run.activityState.items.filter((item) => item.taskId === 'task-child' || item.result === 'child result');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'task');
    assert.equal(rows[0].toolUseId, knownTask ? 'parent' : 'legacy-task:task-child');
    assert.equal(rows[0].result, 'child result');
    assert.equal(rows[0].status, 'success');
    assert.equal(h.run.activityState.phase, 'running');
    assert.equal(h.run.turn.assistant, '');
  });
}

test('XML normalization leaves prose, quoted examples, tool arrays, and unassociated notifications untouched', () => {
  const h = harness();
  const xml = notification().message.content;
  const events = [
    { type: 'user', message: { content: 'ordinary user text' } },
    { type: 'user', message: { content: `example: ${xml}` } },
    { type: 'user', message: { content: '```xml\n' + xml + '\n```' } },
    { type: 'assistant', message: { content: xml } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'parent', content: 'structured' }] } },
    { type: 'user', message: { content: '<task-notification><status>completed</status></task-notification>' } },
  ];
  for (const event of events) {
    const normalized = h.context.activityEventsForClaudeEvent(event);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0], event);
  }
});

test('history preserves a confirmed final verbatim and merges child/process entries without duplicate text', async () => {
  const h = harness('orchestrate');
  h.send(full('planning', 'main planning'));
  h.send(full('child', 'child result', { parent_tool_use_id: 'parent' }));
  h.send(full('final', 'confirmed final'));
  await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('confirmed final') });
  const turn = h.persisted.turns[0];
  turn.chat = [
    { role: 'pm', text: 'main planning' },
    { role: 'agent', agent: 'analyst', toolUseId: 'parent', text: 'child result' },
    { role: 'pm', text: 'confirmed final' },
  ];
  const before = clone(turn);
  const state = h.context.activityStateForTurn(turn);
  assert.equal(h.context.savedAssistantDisplay(turn).text, 'confirmed final');
  for (const text of ['main planning', 'child result']) assert.equal(state.items.filter((item) => item.result === text).length, 1);
  assert.equal(state.items.some((item) => item.result === 'confirmed final'), false);
  assert.deepEqual(turn, before, 'opening history must not migrate or rewrite source records');
});

test('old collaboration transcript remains inspectable without guessing the last PM or aggregate as final', () => {
  const h = harness('orchestrate');
  const turn = {
    user: 'synthetic history', assistant: 'dispatch text\nchild result\nmain planning\nunmatched preserved text',
    chat: [
      { role: 'pm', text: 'dispatch text' },
      { role: 'agent', agent: 'analyst', toolUseId: 'parent', text: 'child result' },
      { role: 'pm', text: 'main planning' },
    ],
  };
  const before = clone(turn);
  assert.equal(h.context.savedAssistantDisplay(turn).text, '');
  const state = h.context.activityStateForTurn(turn);
  assert.equal(state.phase, 'complete');
  assert.equal(state.items.find((item) => item.result === 'main planning').type, 'narration');
  assert.equal(state.items.find((item) => item.result === 'child result').type, 'task');
  assert.equal(state.items.find((item) => item.id === 'legacy-collaboration:transcript').result, turn.assistant);
  assert.deepEqual(turn, before);
  const again = h.context.activityStateForTurn({ ...turn, activity: h.context.window.RelayActivity.serialize(state) });
  assert.equal(again.items.length, state.items.length, 'reopening already-normalized history does not duplicate transcript entries');
});

test('history uses output.final only for a confirmed complete output and keeps protocol text in process details', () => {
  const h = harness();
  for (const status of ['running', 'aborted', 'error']) {
    assert.equal(h.context.savedAssistantDisplay({ output: { status, final: 'unconfirmed' } }).text, '');
  }
  assert.equal(h.context.savedAssistantDisplay({ output: { status: 'complete', final: 'confirmed\n' } }).text, 'confirmed\n');
  assert.equal(h.context.savedAssistantDisplay({ assistant: 'saved answer', output: { status: 'complete', final: 'other' } }).text, 'saved answer');
  const text = '<tool_call><function=Read>example</function></tool_call>';
  const turn = { assistant: text, chat: [{ role: 'pm', text }] };
  const state = h.context.activityStateForTurn(turn);
  assert.equal(state.items[0].type, 'diagnostic');
  assert.equal(state.items[0].result, text);
  assert.equal(h.context.savedAssistantDisplay(turn).text, '');
});

function installReplay(h, task, events) {
  const c = h.context, acknowledgements = [];
  c.runs.clear(); c.jobToConv.clear(); h.conv.kind = 'chat';
  Object.assign(c, {
    activeView: 'settings', pendingConversationViewReloads: new Set(), cvJobs: new Map(),
    restoringActiveRuns: true, restoringTaskLifecycle: true,
    bufferedClaudeEvents: [], bufferedTaskLifecycleEvents: [],
    TERMINAL_LEDGER_STATES: new Set(['completed', 'failed', 'cancelled']),
    handleTaskLifecycleEvent: async () => {},
    registerCreationTask() { throw new Error('synthetic chat cannot be registered as image work'); },
    reconcileRestoredChatTask: async () => {},
    loadConversation: async () => { throw new Error('hidden chat must not steal settings navigation'); },
  });
  c.window.api.tasks = {
    snapshot: async () => ({ ok: true, epoch: 'synthetic-epoch', items: [task] }),
    replayStream: async () => ({ ok: true, events: events.map((event, index) => ({ seq: index + 1, runId: 'job', payload: { event: { jobId: 'job', ...event } } })), hasMore: false }),
    ack: async (value) => { acknowledgements.push(value); },
  };
  for (const name of ['claudeEventFingerprint', 'taskSource', 'taskIsTerminal', 'taskIsCreation', 'taskCanRestoreChat', 'taskTurnHasPersistedOutcome', 'taskHasEmptyInterruptedProgress', 'taskTurnLocation', 'restoreActiveRunsFromLedger']) h.loadFunction(name);
  return acknowledgements;
}

for (const mode of ['agent', 'orchestrate']) {
  test(`${mode}: actual ledger replay restores the same activity/final behavior without rewriting history during restore`, async () => {
    const h = harness(mode);
    const task = { runId: 'job', kind: mode, state: 'running', source: { conversationId: 'conv', mode, turnIndex: 0 } };
    const child = full('child', 'child result', { parent_tool_use_id: 'parent', uuid: 'replayed-child' });
    const events = [child, notification(), full('main', 'main planning')];
    const acks = installReplay(h, task, events);
    h.context.bufferedClaudeEvents.push({ jobId: 'job', ...child });
    const before = clone(h.conv);
    await h.context.restoreActiveRunsFromLedger();
    const run = h.context.runForJob('job');
    assert.ok(run && run.restoredFromLedger);
    assert.equal(run.mode, mode);
    assert.equal(run.turn.assistant, '');
    assert.equal(run.activityState.items.filter((item) => item.result === 'child result').length, 1);
    assert.equal(run.activityState.items.find((item) => item.toolUseId === 'parent').status, 'success');
    assert.equal(run.activityState.phase, 'running');
    assert.equal(h.context.pendingConversationViewReloads.has('chat:conv'), true);
    assert.deepEqual(clone(acks), [], 'per-run recovery must not acknowledge unread global events');
    assert.deepEqual(h.conv, before);
    assert.equal(h.persisted, undefined);
    h.send(full('final', 'recovered final'));
    await h.context.finishRunUnsafe('job', { exitCode: 0, finalResult: result('recovered final') });
    assert.equal(h.persisted.turns[0].assistant, 'recovered final');
    assert.equal(h.persisted.turns[0].activity.items.some((item) => item.result === 'child result'), true);
  });
}

test('completed legacy collaboration is not replayed or saved merely because it lacks an independently confirmed final', async () => {
  const h = harness('orchestrate');
  h.conv.turns[0] = { runId: 'job', assistant: 'preserved aggregate', chat: [{ role: 'pm', text: 'old planning' }] };
  const task = { runId: 'job', kind: 'orchestrate', state: 'completed', source: { conversationId: 'conv', turnIndex: 0 } };
  installReplay(h, task, [full('obsolete', 'must not overwrite')]);
  const before = clone(h.conv);
  await h.context.restoreActiveRunsFromLedger();
  assert.equal(h.context.runs.size, 0);
  assert.equal(h.persisted, undefined);
  assert.deepEqual(h.conv, before);
  assert.deepEqual(h.rendered, []);
});
