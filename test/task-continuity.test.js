'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Continuity = require('../renderer/task-continuity');
const { TaskContinuityHost } = require('../src/main/tasks/task-continuity-host');
const { TaskClock } = require('../src/main/tasks/task-clock');

function paused() {
  const taskRun = Continuity.finish(Continuity.begin({ runId: 'first', startedAt: 1000 }), { finishedAt: 37000 });
  return { id: 'conversation', paused: { runId: 'first', at: new Date(37000).toISOString() },
    turns: [{ runId: 'first', user: 'original goal', status: 'paused', ts: new Date(1000).toISOString(), taskRun,
      taskStartedAt: 1000, taskFinishedAt: 37000, taskDurationMs: 36000 }] };
}

test('UMD helper exposes the same browser contract without Node globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/task-continuity.js'), 'utf8'), context);
  assert.equal(context.RelayTaskContinuity.RESUME_PROMPT, Continuity.RESUME_PROMPT);
  assert.equal(context.RelayTaskContinuity.begin({ runId: 'ordinary', startedAt: 1000 }).taskId, 'ordinary');
});

test('explicit pause/resume links accumulate 36 + 67 and remain correct after another pause and reopen', () => {
  const conversation = paused();
  let taskRun = Continuity.begin({ runId: 'second', startedAt: 100000, conversation, resumedFromRunId: 'first' });
  assert.equal(taskRun.elapsedBeforeMs, 36000);
  assert.equal(Continuity.activeDuration(taskRun, 167000), 103000);
  const done = new TaskClock({ taskRun, now: () => 167000 }).stamp({ type: 'job-done' });
  taskRun = Continuity.finish(taskRun, { finishedAt: done.relay_task_finished_at, durationMs: done.relay_task_duration_ms });
  assert.equal(taskRun.elapsedMs, 103000);
  conversation.turns.push({ runId: 'second', user: '', inputKind: 'resume', status: 'paused', taskRun });
  conversation.paused = { runId: 'second', at: new Date(167000).toISOString() };
  const reopened = JSON.parse(JSON.stringify(conversation));
  const third = Continuity.begin({ runId: 'third', startedAt: 200000, conversation: reopened, resumedFromRunId: 'second' });
  assert.equal(third.taskId, 'first');
  assert.equal(third.elapsedBeforeMs, 103000);
  assert.equal(Continuity.activeDuration(third, 210000), 113000);
  assert.equal(Continuity.latestTurn(reopened.turns, 'first').runId, 'second');
  assert.equal(Continuity.isResume(reopened.turns[1]), true);
});

test('old history gets a chain only from its explicit final paused pointer, never from prompt wording', () => {
  const conversation = paused(); delete conversation.turns[0].taskRun;
  assert.equal(Continuity.begin({ runId: 'next', startedAt: 100000, conversation, resumedFromRunId: 'first' }).elapsedBeforeMs, 36000);
  assert.equal(Continuity.isResume({ user: Continuity.RESUME_PROMPT }), false);
  delete conversation.paused;
  assert.equal(Continuity.begin({ runId: 'next', startedAt: 100000, conversation, resumedFromRunId: 'first' }), null);
  const ordinary = Continuity.begin({ runId: 'new-task', startedAt: 100000, conversation });
  assert.equal(ordinary.taskId, 'new-task'); assert.equal(ordinary.elapsedBeforeMs, 0);
});

test('stale, unrelated, unfinished or ordinary failed source turns cannot authorize resume', () => {
  for (const mutate of [
    c => c.turns.push({ runId: 'later', user: 'another task' }),
    c => { c.paused.runId = 'other'; },
    c => { c.turns[0].status = 'complete'; },
    c => { c.turns[0].status = 'error'; },
    c => { c.turns[0].status = 'running'; },
  ]) {
    const conversation = paused(); mutate(conversation);
    assert.equal(Continuity.begin({ runId: 'next', startedAt: 100000, conversation, resumedFromRunId: 'first' }), null);
  }
});

test('a settled failed explicit resume stays resumable through the exact updated paused pointer', () => {
  const conversation = paused();
  const taskRun = Continuity.begin({ runId: 'second', startedAt: 100000, conversation, resumedFromRunId: 'first' });
  conversation.turns.push({ runId: 'second', user: '', inputKind: 'resume', status: 'error', taskRun });
  conversation.paused.runId = 'second';
  assert.equal(Continuity.begin({ runId: 'third', startedAt: 200000, conversation, resumedFromRunId: 'second' }), null);
  conversation.turns[1].taskRun = Continuity.finish(taskRun, { finishedAt: 110000 });
  const next = Continuity.begin({ runId: 'third', startedAt: 200000, conversation, resumedFromRunId: 'second' });
  assert.equal(next.elapsedBeforeMs, 46000);
});

test('host rebuilds elapsed/identity from saved history, allowing only the current resume placeholder', () => {
  const conversation = paused();
  const taskRun = Continuity.begin({ runId: 'second', startedAt: 100000, conversation, resumedFromRunId: 'first' });
  const forged = { ...taskRun, taskId: 'forged-id', elapsedBeforeMs: 99000 };
  conversation.turns.push({ runId: 'second', user: '', inputKind: 'resume', taskRun: forged });
  const host = new TaskContinuityHost({ loadConversation: () => conversation });
  const result = host.resolve({ runId: 'second', conversationId: 'conversation', startedAt: 100000,
    taskContext: { inputKind: 'resume', taskRun: forged } });
  assert.equal(result.taskRun.taskId, 'first'); assert.equal(result.taskRun.elapsedBeforeMs, 36000);
  assert.equal(result.logicalPrompt, 'original goal');
  assert.throws(() => host.resolve({ runId: 'bad', conversationId: 'another-conversation', startedAt: 100000,
    taskContext: { inputKind: 'resume', taskRun } }), { code: 'INVALID_TASK_CONTINUITY' });
  assert.throws(() => host.resolve({ runId: 'bad', conversationId: 'conversation', executionConversationId: 'another-conversation', startedAt: 100000,
    taskContext: { inputKind: 'resume', taskRun } }), { code: 'INVALID_TASK_CONTINUITY' });
});

test('host requires explicit resume intent and rejects an arbitrary cross-task client chain', () => {
  const host = new TaskContinuityHost({ loadConversation: paused });
  const taskRun = Continuity.begin({ runId: 'second', startedAt: 100000, conversation: paused(), resumedFromRunId: 'first' });
  assert.throws(() => host.resolve({ runId: 'second', conversationId: 'conversation', startedAt: 100000,
    taskContext: { taskRun } }), { code: 'INVALID_TASK_CONTINUITY' });
  assert.throws(() => host.resolve({ runId: 'new', conversationId: 'conversation', startedAt: 100000,
    taskContext: { taskRun: { ...taskRun, resumedFromRunId: null } } }), { code: 'INVALID_TASK_CONTINUITY' });
});

test('only a host-observed root lost-session failure authorizes one retry of the same segment', () => {
  const host = new TaskContinuityHost({ loadConversation: paused });
  const claim = Continuity.begin({ runId: 'second', startedAt: 100000, conversation: paused(), resumedFromRunId: 'first' });
  const original = host.resolve({ runId: 'second', conversationId: 'conversation', startedAt: 100000,
    taskContext: { inputKind: 'resume', taskRun: claim } });
  const retry = { runId: 'retry', conversationId: 'conversation', startedAt: 120000,
    taskContext: { inputKind: 'resume', retryOfRunId: 'second', taskRun: claim } };
  host.observe('second', { type: 'stderr', data: 'No conversation found with session ID fixture' });
  host.observe('second', { type: 'job-done', exitCode: 1, parentToolUseId: 'child' });
  assert.throws(() => host.resolve(retry), { code: 'INVALID_TASK_CONTINUITY' });
  host.observe('second', { type: 'job-done', exitCode: 1 });
  assert.throws(() => host.resolve({ ...retry, conversationId: 'other' }), { code: 'INVALID_TASK_CONTINUITY' });
  const result = host.resolve(retry);
  assert.deepEqual(result.taskRun, original.taskRun);
  assert.equal(new TaskClock({ taskRun: result.taskRun, now: () => 167000 }).finish().relay_task_duration_ms, 103000);
  assert.throws(() => host.resolve({ ...retry, runId: 'again' }), { code: 'INVALID_TASK_CONTINUITY' });
});

test('permission failure or cancellation cannot become an automatic continuation', () => {
  for (const terminal of [{ exitCode: -1, aborted: true }, { exitCode: 1, finalResult: { permission_denials: [{}] } }]) {
    const host = new TaskContinuityHost();
    const result = host.resolve({ runId: 'first', conversationId: 'conversation', startedAt: 1000 });
    host.observe('first', { type: 'stderr', data: 'No conversation found with session ID fixture' });
    host.observe('first', { type: 'job-done', ...terminal });
    assert.throws(() => host.resolve({ runId: 'retry', conversationId: 'conversation', startedAt: 2000,
      taskContext: { retryOfRunId: 'first', taskRun: result.taskRun } }), { code: 'INVALID_TASK_CONTINUITY' });
  }
});
