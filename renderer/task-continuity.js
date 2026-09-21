(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelayTaskContinuity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESUME_PROMPT = '请根据已有上下文继续上次暂停的任务，先核对已经完成的工作。';
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
  const time = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const duration = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const timestamp = value => time(value) ? value : typeof value === 'string' && time(Date.parse(value)) ? Date.parse(value) : null;

  function normalize(value) {
    if (!value || value.version !== 1 || !id(value.taskId)
      || !(value.resumedFromRunId === null || id(value.resumedFromRunId))
      || !time(value.rootStartedAt) || !time(value.segmentStartedAt)
      || value.rootStartedAt > value.segmentStartedAt || !duration(value.elapsedBeforeMs)
      || value.elapsedBeforeMs > value.segmentStartedAt - value.rootStartedAt) return null;
    const result = { version: 1, taskId: value.taskId, resumedFromRunId: value.resumedFromRunId,
      rootStartedAt: value.rootStartedAt, segmentStartedAt: value.segmentStartedAt, elapsedBeforeMs: value.elapsedBeforeMs };
    if (value.segmentFinishedAt != null || value.elapsedMs != null) {
      if (!time(value.segmentFinishedAt) || value.segmentFinishedAt < result.segmentStartedAt
        || !duration(value.elapsedMs) || value.elapsedMs < result.elapsedBeforeMs
        || value.elapsedMs > result.elapsedBeforeMs + value.segmentFinishedAt - result.segmentStartedAt) return null;
      result.segmentFinishedAt = value.segmentFinishedAt;
      result.elapsedMs = value.elapsedMs;
    }
    return result;
  }

  function activeDuration(value, now = Date.now()) {
    const run = normalize(value);
    if (!run) return 0;
    if (run.segmentFinishedAt != null) return run.elapsedMs;
    return run.elapsedBeforeMs + Math.max(0, (time(now) ? now : run.segmentStartedAt) - run.segmentStartedAt);
  }

  function finish(value, { finishedAt = Date.now(), durationMs } = {}) {
    const run = normalize(value);
    if (!run || run.segmentFinishedAt != null) return run;
    const end = Math.max(run.segmentStartedAt, time(finishedAt) ? finishedAt : run.segmentStartedAt);
    const maximum = run.elapsedBeforeMs + end - run.segmentStartedAt;
    return { ...run, segmentFinishedAt: end,
      elapsedMs: duration(durationMs) && durationMs >= run.elapsedBeforeMs && durationMs <= maximum ? durationMs : maximum };
  }

  function isResume(turn) {
    const run = normalize(turn && turn.taskRun);
    return !!run && turn.inputKind === 'resume' && run.resumedFromRunId !== null;
  }

  function latestTurn(turns, taskId) {
    if (!Array.isArray(turns) || !id(taskId)) return null;
    for (let index = turns.length - 1; index >= 0; index--) {
      if (normalize(turns[index] && turns[index].taskRun)?.taskId === taskId) return turns[index];
    }
    return null;
  }

  // The caller passes the saved conversation, before adding the new placeholder.
  // Only the explicit paused pointer can connect old history to a logical task.
  function begin({ runId, startedAt = Date.now(), conversation, resumedFromRunId = null } = {}) {
    if (!id(runId) || !time(startedAt)) return null;
    if (resumedFromRunId === null) return { version: 1, taskId: runId, resumedFromRunId: null,
      rootStartedAt: startedAt, segmentStartedAt: startedAt, elapsedBeforeMs: 0 };
    if (!id(resumedFromRunId) || resumedFromRunId === runId || conversation?.paused?.runId !== resumedFromRunId) return null;
    const previous = Array.isArray(conversation.turns) ? conversation.turns.at(-1) : null;
    const failedResume = previous?.status === 'error' && isResume(previous)
      && normalize(previous.taskRun)?.segmentFinishedAt != null;
    if (!previous || previous.runId !== resumedFromRunId
      || (!failedResume && previous.status !== 'paused' && (previous.status != null || previous.taskRun != null))) return null;
    let prior = normalize(previous.taskRun);
    if (previous.taskRun != null && !prior) return null;
    const endedAt = prior?.segmentFinishedAt ?? timestamp(previous.taskFinishedAt) ?? timestamp(conversation.paused.at);
    if (!endedAt || endedAt > startedAt) return null;
    if (!prior) {
      const rootStartedAt = timestamp(previous.taskStartedAt) ?? timestamp(previous.ts) ?? endedAt;
      if (rootStartedAt > endedAt) return null;
      prior = begin({ runId: previous.runId, startedAt: rootStartedAt });
    }
    prior = finish(prior, { finishedAt: endedAt, durationMs: previous.taskDurationMs });
    if (!prior) return null;
    return { version: 1, taskId: prior.taskId, resumedFromRunId,
      rootStartedAt: prior.rootStartedAt, segmentStartedAt: startedAt, elapsedBeforeMs: prior.elapsedMs };
  }

  return Object.freeze({ RESUME_PROMPT, normalize, begin, finish, activeDuration, isResume, latestTurn });
});
