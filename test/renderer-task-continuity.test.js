'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const continuity = require('../renderer/task-continuity');
const activity = require('../renderer/activity-stream');
const { harness, declaration, clone } = require('./renderer-activity-harness.cjs');
const base = Date.UTC(2026, 8, 1, 1);
function resumed() {
  const first = continuity.finish(continuity.begin({ runId: 'first', startedAt: base }), { finishedAt: base + 36000 });
  return continuity.begin({ runId: 'second', startedAt: base + 3636000,
    resumedFromRunId: 'first', conversation: { paused: { runId: 'first' }, turns: [{ runId: 'first', status: 'paused', taskRun: first }] } });
}
test('activity uses cumulative active intervals, persists them, and hides only preceding summaries', t => {
  const taskRun = resumed(), now = taskRun.segmentStartedAt + 34000;
  t.mock.method(Date, 'now', () => now);
  const state = activity.createState({ taskRun, hasWork: true });
  assert.match(activity.summaryFor(state).meta, /1m 10s/);
  assert.deepEqual(activity.summaryFor(state, { segment: 'previous' }), { title: '此前过程', meta: '' });
  activity.finish(state, '已暂停', { relay_task_finished_at: now, relay_task_duration_ms: 70000 });
  const restored = activity.hydrate(activity.serialize(state));
  assert.equal(restored.taskRun.elapsedMs, 70000);
  t.mock.method(Date, 'now', () => now + 86400000);
  assert.match(activity.summaryFor(restored).meta, /1m 10s/);
  assert.equal(activity.summaryFor(restored).title, '已暂停');
});
test('host timing corrections keep the trusted task identity and ignore child clock data', () => {
  const taskRun = resumed(), state = activity.createState({ taskRun });
  activity.ingest(state, { type: 'system', subtype: 'init', relay_task_id: taskRun.taskId,
    relay_task_started_at: base, relay_task_segment_started_at: taskRun.segmentStartedAt + 25,
    relay_task_elapsed_before_ms: 36000 });
  assert.equal(state.taskRun.segmentStartedAt, taskRun.segmentStartedAt + 25);
  activity.ingest(state, { type: 'result', parent_tool_use_id: 'child', relay_task_id: taskRun.taskId,
    relay_task_segment_started_at: base + 9999999, relay_task_duration_ms: 5 });
  assert.equal(state.taskRun.segmentStartedAt, taskRun.segmentStartedAt + 25);
  assert.equal(state.taskRun.segmentFinishedAt, undefined);
});
test('only validated resume metadata links prior history and ordinary same-text turns stay separate', () => {
  const first = { runId: 'first', user: continuity.RESUME_PROMPT };
  const second = { runId: 'second', user: '', inputKind: 'resume', taskRun: resumed() };
  const third = { runId: 'third', user: continuity.RESUME_PROMPT, taskRun: continuity.begin({ runId: 'third', startedAt: base + 9999999 }) };
  const context = vm.createContext({ window: { RelayTaskContinuity: continuity }, currentConv: { turns: [first, second, third] } });
  vm.runInContext(declaration('taskSegmentForTurn'), context);
  vm.runInContext(declaration('taskSummaryKeyForTurn'), context);
  assert.equal(context.taskSegmentForTurn(first), 'previous', 'explicit current resume can link an old source without metadata');
  assert.equal(context.taskSegmentForTurn(second), 'current');
  assert.equal(context.taskSegmentForTurn(third), 'current');
  assert.equal(continuity.isResume(first), false);
  assert.equal(continuity.isResume(second), true);
  assert.equal(continuity.isResume(third), false);
  assert.equal(context.taskSegmentForTurn(first, [first, { ...second, inputKind: undefined }]), 'current');
  assert.equal(context.taskSummaryKeyForTurn(first), context.taskSummaryKeyForTurn(second));
  assert.notEqual(context.taskSummaryKeyForTurn(third), context.taskSummaryKeyForTurn(second));
});
test('main finalization stores active elapsed time and explicit paused state for history reopen', async () => {
  const h = harness(), taskRun = resumed();
  h.run.taskRun = taskRun; h.run.turn.taskRun = clone(taskRun); h.run.turn.inputKind = 'resume';
  h.run.turn.ts = new Date(taskRun.segmentStartedAt).toISOString();
  h.run.activityState.taskRun = clone(taskRun); h.run.abortRequested = true; h.run.pauseRequested = true;
  await h.context.finishRunUnsafe('job', { exitCode: 0, relay_task_finished_at: taskRun.segmentStartedAt + 34000,
    relay_task_duration_ms: 70000, finalResult: { type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming' } });
  assert.equal(h.persisted.turns[0].status, 'paused');
  assert.equal(h.persisted.turns[0].taskRun.elapsedMs, 70000);
  assert.equal(h.persisted.turns[0].activity.taskRun.elapsedMs, 70000);
  assert.equal(h.persisted.paused.runId, 'job');
});
test('failed explicit resume remains resumable but a normal task error never creates a pause link', async () => {
  for (const isResume of [true, false]) {
    const h = harness(), taskRun = isResume ? resumed() : continuity.begin({ runId: 'job', startedAt: base });
    h.run.taskRun = taskRun; h.run.turn.taskRun = clone(taskRun); h.run.activityState.taskRun = clone(taskRun);
    if (isResume) h.run.turn.inputKind = 'resume';
    await h.context.finishRunUnsafe('job', { exitCode: 1, error: 'synthetic startup error',
      relay_task_finished_at: taskRun.segmentStartedAt + 5000, relay_task_duration_ms: taskRun.elapsedBeforeMs + 5000 });
    assert.equal(h.persisted.turns[0].status, 'error');
    assert.equal(h.persisted.turns[0].taskRun.elapsedMs, taskRun.elapsedBeforeMs + 5000);
    assert.equal(h.persisted.paused?.runId, isResume ? 'job' : undefined);
  }
});
test('lost-session automatic retry passes the original active interval and retry source', async () => {
  const h = harness(), taskRun = resumed(); let retry;
  h.run.taskRun = taskRun; h.run.turn.taskRun = clone(taskRun); h.run.activityState.taskRun = clone(taskRun);
  h.run.turn.inputKind = 'resume'; h.run.turn.ts = new Date(taskRun.segmentStartedAt).toISOString();
  h.run.sessionId = 'synthetic-session'; h.run.stderrBuf = 'No conversation found with session ID synthetic-session';
  h.conv.turns[0] = { user: '', runId: 'job', taskRun: clone(taskRun), inputKind: 'resume' };
  h.context.relaunchWithoutResume = async (...args) => { retry = args; };
  await h.context.finishRunUnsafe('job', { exitCode: 1, relay_task_finished_at: taskRun.segmentStartedAt + 2000,
    relay_task_duration_ms: taskRun.elapsedBeforeMs + 2000 });
  assert.equal(retry[4], taskRun.segmentStartedAt);
  assert.deepEqual(clone(retry[5].taskRun), taskRun);
  assert.equal(retry[5].taskRun.segmentFinishedAt, undefined);
  assert.equal(retry[5].retryOfRunId, 'job');
  assert.equal(retry[5].inputKind, 'resume');
});
test('first logical task title uses the original request and final resumed answer', async () => {
  const first = { runId: 'first', user: 'Original project review', assistant: 'unfinished stage', status: 'paused' };
  const second = { runId: 'second', user: '', inputKind: 'resume', taskRun: resumed(), assistant: 'Delivered project review', status: 'complete' };
  const conv = { id: 'synthetic', turns: [first, second] }; let material;
  const context = vm.createContext({ window: { RelayTaskContinuity: continuity, api: { summarizeTitle: async text => { material = text; return null; } } } });
  for (const name of ['isFirstLogicalTask', 'maybeGenerateTitle', 'buildTitleMaterial']) vm.runInContext(declaration(name).split('\nwindow.api.onEvent(')[0], context);
  assert.equal(context.isFirstLogicalTask(conv), true);
  await context.maybeGenerateTitle(conv);
  assert.match(material, /Original project review/);
  assert.match(material, /Delivered project review/);
  assert.doesNotMatch(material, /unfinished stage/);
  assert.match(context.buildTitleMaterial(conv), /Delivered project review/);
  assert.equal(context.isFirstLogicalTask({ turns: [...conv.turns, { runId: 'ordinary', user: continuity.RESUME_PROMPT,
    taskRun: continuity.begin({ runId: 'ordinary', startedAt: base + 9999999 }) }] }), false);
  assert.equal(context.isFirstLogicalTask({ turns: [{ user: 'legacy first' }, { user: continuity.RESUME_PROMPT }] }), false);
});
