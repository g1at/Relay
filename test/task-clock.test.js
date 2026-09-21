'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskClock } = require('../task-clock');

test('task clock includes retry backoff, Agent and supplement waiting until final delivery', () => {
  let now = 1000;
  const clock = new TaskClock({ now: () => now });
  for (const [at, event] of [
    [2000, { type: 'system', subtype: 'init' }],
    [3000, { type: 'system', subtype: 'api_retry', retry_delay_ms: 5000 }],
    [8000, { type: 'result', duration_ms: 70, relay_pending_inputs: 1 }],
    [10000, { type: 'system', subtype: 'relay_user_input' }],
    [12000, { type: 'result', duration_ms: 200, queued_turn_count: 1 }],
  ]) {
    now = at;
    const stamped = clock.stamp(event);
    assert.equal(stamped.relay_task_started_at, 1000);
    assert.equal(stamped.relay_task_finished_at, undefined);
    assert.equal(stamped.relay_task_duration_ms, undefined);
    assert.equal(stamped.duration_ms, event.duration_ms);
  }
  now = 15000;
  const done = clock.stamp({ type: 'job-done', finalResult: { duration_ms: 300 } });
  assert.equal(done.relay_task_duration_ms, 14000);
  assert.equal(done.relay_task_finished_at, 15000);
  assert.equal(done.finalResult.duration_ms, 300);
  now = 25000;
  assert.equal(clock.stamp({ type: 'job-done' }).relay_task_finished_at, 15000);
});

test('only a top-level job-done can close a task clock', () => {
  let now = 1000;
  const clock = new TaskClock({ now: () => now });
  now = 2000;
  for (const event of [
    { type: 'result', relay_task_finished_at: 1500, relay_task_duration_ms: 500 },
    { type: 'job-done', parent_tool_use_id: 'child' },
    { type: 'job-done', parentToolUseId: 'child' },
    { type: 'job-done', agent_id: 'agent' },
    { type: 'job-done', subagent_type: 'analyst' },
  ]) assert.equal(clock.stamp(event).relay_task_finished_at, undefined);
  now = 9000;
  assert.equal(clock.stamp({ type: 'job-done', aborted: true }).relay_task_duration_ms, 8000);
});

test('camel-case ownership normalizes before runtime routing and never changes a native frame', () => {
  const child = { type: 'result', parentToolUseId: 'tool' };
  assert.deepEqual(TaskClock.normalizeEvent(child), { ...child, parent_tool_use_id: 'tool' });
  assert.equal(TaskClock.isRootEvent(child), false);
  assert.equal(child.parent_tool_use_id, undefined);
  const native = { type: 'result', parent_tool_use_id: 'native-tool' };
  assert.equal(TaskClock.normalizeEvent(native), native);
  assert.equal(TaskClock.isRootEvent({ type: 'result' }), true);
});

test('relaunch inherits original start, new tasks start independently, invalid/future starts are rejected', () => {
  const original = new TaskClock({ now: () => 1000 });
  const retry = new TaskClock({ startedAt: original.startedAt, now: () => 10000 });
  assert.equal(retry.finish().relay_task_duration_ms, 9000);
  for (const startedAt of [undefined, null, '1000', NaN, Infinity, -1, 0, 11000]) {
    assert.equal(new TaskClock({ startedAt, now: () => 10000 }).startedAt, 10000);
  }
  let now = 1000;
  const backward = new TaskClock({ now: () => now }); now = 500;
  assert.equal(backward.finish().relay_task_duration_ms, 0);
});

test('two active segments total 36 + 67 seconds and exclude the pause gap', () => {
  let now = 1000;
  const first = new TaskClock({ taskId: 'logical-task', now: () => now });
  now = 37000;
  assert.equal(first.finish().relay_task_duration_ms, 36000);
  now = 100000;
  const second = new TaskClock({ startedAt: now, rootStartedAt: 1000, elapsedBeforeMs: 36000,
    taskId: 'logical-task', now: () => now });
  now = 167000;
  const result = second.stamp({ type: 'result', duration_ms: 67000 });
  assert.equal(result.relay_task_duration_ms, undefined);
  assert.equal(result.duration_ms, 67000);
  assert.equal(result.relay_task_started_at, 1000);
  assert.equal(result.relay_task_segment_started_at, 100000);
  assert.equal(result.relay_task_elapsed_before_ms, 36000);
  const done = second.stamp({ type: 'job-done', exitCode: 0 });
  assert.equal(done.relay_task_id, 'logical-task');
  assert.equal(done.relay_task_duration_ms, 103000);
  now = 200000;
  assert.equal(second.finish().relay_task_duration_ms, 103000);
  assert.equal(second.stamp({ type: 'job-done', parentToolUseId: 'child' }).relay_task_finished_at, undefined);
});

test('recreating a retry clock within the same segment never counts the failed attempt twice', () => {
  const taskRun = { taskId: 'logical-task', rootStartedAt: 1000, segmentStartedAt: 100000, elapsedBeforeMs: 36000 };
  const failed = new TaskClock({ taskRun, now: () => 110000 });
  assert.equal(failed.finish().relay_task_duration_ms, 46000);
  const retried = new TaskClock({ taskRun, now: () => 167000 });
  assert.equal(retried.finish().relay_task_duration_ms, 103000);
});
