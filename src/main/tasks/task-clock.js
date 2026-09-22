'use strict';

// SDK result.duration_ms describes an SDK turn/attempt. A Relay task may span
// retries, queued input and Agent continuations, ending only at job-done.
class TaskClock {
  static isRootEvent(event) {
    return !!event && typeof event === 'object' && !event.parent_tool_use_id
      && !event.parentToolUseId && !event.subagent_type && !event.agent_id;
  }

  static normalizeEvent(event) {
    // Some event adapters expose the camel-case alias. Normalize before SDK
    // routing/retry observers, while preserving the original field for consumers.
    return event && !event.parent_tool_use_id && event.parentToolUseId
      ? { ...event, parent_tool_use_id: event.parentToolUseId } : event;
  }

  constructor({ startedAt, taskRun, taskId = taskRun?.taskId, rootStartedAt = taskRun?.rootStartedAt,
    elapsedBeforeMs = taskRun?.elapsedBeforeMs ?? 0, now = Date.now } = {}) {
    this.now = now;
    const current = this.now();
    startedAt = taskRun?.segmentStartedAt ?? startedAt;
    this.startedAt = typeof startedAt === 'number' && Number.isFinite(startedAt)
      && startedAt > 0 && startedAt <= current ? startedAt : current;
    this.rootStartedAt = typeof rootStartedAt === 'number' && Number.isFinite(rootStartedAt)
      && rootStartedAt > 0 && rootStartedAt <= this.startedAt ? rootStartedAt : this.startedAt;
    this.elapsedBeforeMs = Number.isSafeInteger(elapsedBeforeMs) && elapsedBeforeMs >= 0
      && elapsedBeforeMs <= this.startedAt - this.rootStartedAt ? elapsedBeforeMs : 0;
    this.taskId = typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128 ? taskId : null;
    this.finishedAt = null;
  }

  snapshot() {
    return {
      ...(this.taskId ? { relay_task_id: this.taskId } : {}),
      relay_task_started_at: this.rootStartedAt,
      relay_task_segment_started_at: this.startedAt,
      relay_task_elapsed_before_ms: this.elapsedBeforeMs,
      ...(this.finishedAt === null ? {} : {
        relay_task_finished_at: this.finishedAt,
        relay_task_duration_ms: this.elapsedBeforeMs + this.finishedAt - this.startedAt,
      }),
    };
  }

  finish() {
    if (this.finishedAt === null) this.finishedAt = Math.max(this.startedAt, this.now());
    return this.snapshot();
  }

  stamp(event) {
    if (!event || typeof event !== 'object') return event;
    const { relay_task_id, relay_task_started_at, relay_task_segment_started_at, relay_task_elapsed_before_ms,
      relay_task_finished_at, relay_task_duration_ms, ...message } = event;
    const terminal = event.type === 'job-done' && TaskClock.isRootEvent(event);
    const timing = terminal ? this.finish() : this.snapshot();
    // A child or late SDK result cannot inherit a terminal stamp from this clock.
    if (!terminal) { delete timing.relay_task_finished_at; delete timing.relay_task_duration_ms; }
    return { ...message, ...timing };
  }
}

module.exports = { TaskClock };
