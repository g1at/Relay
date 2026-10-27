'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RUN_STATES, isTerminalState } = require('../tasks/task-protocol');
const attentionStates = new Set(['needs_attention', 'submission_unknown', 'stopped', 'download_failed']);
function reconcileMediaTask(task, { ledger, materialize, finish, publish, reconcileSchedule, finishSchedule } = {}) {
  const completed = task.state === 'completed', failed = task.state === 'failed';
  const paths = (task.artifacts || []).map(item => item.path).filter(Boolean);
  const scheduled = task.source?.type === 'schedule' || (task.runId && ledger?.get(task.runId)?.source?.type === 'schedule');
  const scheduleResult = scheduled ? reconcileSchedule?.(task) : null;
  if (!scheduled && (completed || failed || attentionStates.has(task.state) || paths.length)) {
    materialize?.(task, { ok: completed, paths, error: task.error?.message || task.error || (task.state === 'stopped' ? '已停止本地等待' : undefined), mediaKind: task.mediaKind, taskId: task.id });
  }
  let run = task.runId && ledger?.get(task.runId);
  if (run && !isTerminalState(run.state)) {
    // External polling can recover without a resource lease. Respect the same
    // state transitions as a fresh executor and preserve explicit stop intents.
    if (run.state === RUN_STATES.QUEUED) run = ledger.update(task.runId, { state: RUN_STATES.STARTING });
    if ((completed || failed) && !scheduleResult?.active && (!scheduled || scheduleResult?.handled)) {
      if (completed && run.state === RUN_STATES.WAITING_USER) ledger.update(task.runId, { state: RUN_STATES.RUNNING });
      if (scheduled && scheduleResult?.result) finishSchedule?.(task.runId, scheduleResult.result);
      else if (!scheduled) finish?.(task.runId, completed, { artifactPaths: paths, error: failed ? task.error?.message || task.error : null, summary: completed ? `已生成 ${paths.length} 个文件` : '' });
    } else if (!completed && !failed && run.state !== RUN_STATES.STOPPING) {
      ledger.update(task.runId, { state: attentionStates.has(task.state) ? RUN_STATES.WAITING_USER : RUN_STATES.RUNNING,
        phase: task.state, progress: { label: attentionStates.has(task.state) ? task.error?.message || '媒体任务等待处理' : task.remoteState ? `生成任务：${task.remoteState}` : '正在处理媒体任务' } });
    }
  }
  publish?.(task);
}
function ownsMediaRecovery(run, userDataDir) {
  const id = run?.metadata?.mediaTaskId || run?.runId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) return false;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(userDataDir, 'media-tasks', `${id}.json`), 'utf8'));
    return record.task?.id === id && record.task?.runId === run.runId;
  } catch (_) { return false; }
}
module.exports = { reconcileMediaTask, ownsMediaRecovery };
