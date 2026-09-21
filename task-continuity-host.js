'use strict';

const Continuity = require('./renderer/task-continuity');

function invalid() {
  return Object.assign(new Error('无法确认暂停任务的来源，请重新打开对话后继续。'), { code: 'INVALID_TASK_CONTINUITY' });
}

// Client timestamps/elapsed totals never authorize a continuation. The saved
// paused pointer authorizes a new segment; a host-observed lost-session failure
// authorizes one automatic retry of an already accepted segment.
class TaskContinuityHost {
  constructor({ loadConversation, limit = 256 } = {}) {
    this.loadConversation = loadConversation || (() => null);
    this.limit = limit;
    this.runs = new Map();
    this.latest = new Map();
  }

  resolve({ runId, conversationId, executionConversationId = conversationId, startedAt, taskContext = {}, originalPrompt = '' }) {
    const supplied = taskContext.taskRun;
    const claim = supplied == null ? null : Continuity.normalize(supplied);
    if (supplied != null && !claim) throw invalid();
    const wantsResume = taskContext.inputKind === 'resume';
    const retryOf = taskContext.retryOfRunId;
    if ((wantsResume || retryOf != null) && executionConversationId !== conversationId) throw invalid();
    let taskRun, logicalPrompt = originalPrompt, saved = null;
    if (retryOf != null) {
      const previous = this.runs.get(retryOf);
      if (!previous || previous.conversationId !== conversationId || !previous.finished || !previous.retryable
        || previous.retryUsed || this.latest.get(conversationId) !== retryOf || !claim
        || claim.taskId !== previous.taskRun.taskId || wantsResume !== previous.resumed) throw invalid();
      // A failed attempt is still part of this active segment. Keep its original
      // start and pre-pause total; do not add the failed attempt's duration again.
      taskRun = { ...previous.taskRun };
      logicalPrompt = previous.logicalPrompt;
      previous.retryUsed = true;
    } else {
      if (wantsResume) {
        if (!conversationId || !claim?.resumedFromRunId) throw invalid();
        saved = this.loadConversation(conversationId);
        if (!saved || saved.id !== conversationId) throw invalid();
        const turns = Array.isArray(saved.turns) ? [...saved.turns] : [];
        const index = turns.findIndex(turn => turn?.runId === runId);
        if (index >= 0) {
          if (index !== turns.length - 1 || turns[index].inputKind !== 'resume'
            || String(turns[index].user || '') !== '' || !Continuity.isResume(turns[index])) throw invalid();
          turns.pop();
        }
        taskRun = Continuity.begin({ runId, startedAt, conversation: { ...saved, turns }, resumedFromRunId: claim.resumedFromRunId });
        if (!taskRun) throw invalid();
        const root = turns.find(turn => turn?.runId === taskRun.taskId
          || Continuity.normalize(turn?.taskRun)?.taskId === taskRun.taskId && !Continuity.isResume(turn));
        logicalPrompt = typeof root?.user === 'string' ? root.user : '';
      } else {
        if (claim && (claim.taskId !== runId || claim.resumedFromRunId !== null)) throw invalid();
        taskRun = Continuity.begin({ runId, startedAt });
      }
    }
    if (!taskRun) throw invalid();
    const record = { conversationId, taskRun, logicalPrompt, resumed: wantsResume,
      finished: false, retryable: false, retryUsed: !!retryOf, sessionGone: false };
    this.runs.set(runId, record);
    if (conversationId) this.latest.set(conversationId, runId);
    while (this.runs.size > this.limit) {
      const first = this.runs.keys().next().value, old = this.runs.get(first);
      this.runs.delete(first);
      if (this.latest.get(old.conversationId) === first) this.latest.delete(old.conversationId);
    }
    return { taskRun: { ...taskRun }, logicalPrompt, resumed: wantsResume, retrying: !!retryOf, conversation: saved };
  }

  observe(runId, event) {
    const record = this.runs.get(runId);
    if (!record || !event || event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type) return;
    if (['stderr', 'result', 'job-done'].includes(event.type)) {
      const text = [event.type === 'stderr' ? event.text || event.data || event.content : '', event.error,
        ...(Array.isArray(event.errors) ? event.errors : [])].filter(value => typeof value === 'string').join('\n');
      if (/No conversation found with session ID/i.test(text)) record.sessionGone = true;
    }
    if (event.type !== 'job-done' || record.finished) return;
    record.finished = true;
    const result = event.finalResult;
    const failed = typeof event.exitCode === 'number' && event.exitCode !== 0 || event.error
      || result?.is_error || result?.subtype && result.subtype !== 'success';
    record.retryable = !!failed && record.sessionGone && !event.aborted
      && !(result?.permission_denials || []).length && !/^aborted_/.test(result?.terminal_reason || '');
  }
}

module.exports = { TaskContinuityHost };
