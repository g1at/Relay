'use strict';

const { isNotificationOnlyResult } = require('./live-turn-router');

// Claude Agent SDK 的 task_* 事件同时覆盖后台 Bash、子 Agent 与工作流。
// Relay 只需要为会继续产出最终回复的 Agent/工作流保持当前 turn；后台命令不应阻塞收尾。
const AGENT_TASK_TYPE = /^(?:(?:local|remote)_)?(?:agent|workflow)$/i;

function isAgentTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.subagent_type) return true;
  return AGENT_TASK_TYPE.test(String(task.task_type || ''));
}

// Claude Agent SDK 0.3.247 起会显式标记内部维护任务（例如实时更新 watcher）。
// 这类任务不属于用户工作，不能点亮活动状态、阻塞 turn 收尾或触发会话回收。
function isAmbientTask(task) {
  return !!task && typeof task === 'object' && task.ambient === true;
}

function toolResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content
    .filter((part) => part && (typeof part === 'string' || part.type === 'text'))
    .map((part) => typeof part === 'string' ? part : (part.text || ''))
    .join('');
}

function asyncAgentLaunches(event) {
  if (!event || event.type !== 'user' || !event.message || !Array.isArray(event.message.content)) return [];
  const results = event.message.content.filter((item) => item && item.type === 'tool_result' && item.tool_use_id);
  if (!results.length) return [];
  const structured = event.tool_use_result || event.toolUseResult || {};
  return results
    .filter((result) => {
      const structuredAsync = results.length === 1
        && (structured.isAsync === true
          || structured.status === 'async_launched'
          || structured.status === 'remote_launched');
      return structuredAsync || /Async agent launched successfully/i.test(toolResultText(result));
    })
    .map((result) => ({
      toolUseId: result.tool_use_id,
      taskId: results.length === 1
        ? (structured.agentId || structured.taskId || structured.task_id || null)
        : null,
    }));
}

function taskStatusIsRunning(status) {
  const value = String(status || '').toLowerCase();
  return value === 'running' || value === 'pending' || value === 'paused';
}

// SDK 0.3.292+ gives each resumed task a new run_id. Only ordinary string
// ordering is guaranteed; retain the newest id after completion so delayed
// frames cannot bring an older run back. Missing ids keep legacy behavior.
class TaskRunIndex {
  constructor() {
    this.latest = new Map();
    this.tools = new Map();
    this.retiredTools = new Set();
  }

  reset() {
    this.latest.clear();
    this.tools.clear();
    this.retiredTools.clear();
  }

  isStale(taskId, runId) {
    const latest = this.latest.get(taskId);
    return typeof runId === 'string' && runId.length > 0 && !!latest && runId < latest;
  }

  observe(taskId, runId) {
    if (!taskId || typeof runId !== 'string' || !runId) return 'legacy';
    if (this.isStale(taskId, runId)) return 'stale';
    const latest = this.latest.get(taskId);
    this.latest.set(taskId, runId);
    return latest && runId > latest ? 'new' : 'current';
  }

  bind(taskId, toolUseId) {
    if (!taskId || !toolUseId) return;
    this.tools.set(toolUseId, taskId);
    this.retiredTools.delete(toolUseId);
  }

  forgetTask(taskId) {
    for (const [toolUseId, mappedTaskId] of this.tools) {
      if (mappedTaskId !== taskId) continue;
      this.tools.delete(toolUseId);
      this.retiredTools.add(toolUseId);
    }
  }
}

function userTaskNotification(event) {
  const content = event.type === 'user' && event.message && event.message.content;
  if (typeof content !== 'string' || !/<task-notification>/i.test(content)) return null;
  const toolUseId = ((content.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/i) || [])[1] || '').trim();
  const taskId = ((content.match(/<task-id>([\s\S]*?)<\/task-id>/i) || [])[1] || '').trim();
  const status = ((content.match(/<status>([\s\S]*?)<\/status>/i) || [])[1] || '').trim().toLowerCase();
  if (!(toolUseId || taskId) || !status || taskStatusIsRunning(status)) return null;
  return { taskId, toolUseId, status, runId: event.origin && event.origin.runId };
}

// 与 Agent gate 分开保存 SDK 报告的“所有后台任务”。非 Agent 不阻塞最终 result，
// 但若 result 到达时它仍存活，常驻 query 必须回收，否则它稍后的完成通知会自动开启一轮
// assistant continuation，并可能串进下一条用户消息。
class LiveBackgroundTaskTracker {
  constructor() {
    this.tasks = new Map();
    this.runs = new TaskRunIndex();
    this.toolToTask = this.runs.tools;
  }

  get size() {
    return this.tasks.size;
  }

  get nonAgentSize() {
    let count = 0;
    for (const task of this.tasks.values()) if (!isAgentTask(task)) count += 1;
    return count;
  }

  hasNonAgentTasks() {
    return this.nonAgentSize > 0;
  }

  reset() {
    this.tasks.clear();
    this.runs.reset();
  }

  acceptRun(taskId, runId) {
    const state = this.runs.observe(taskId, runId);
    if (state === 'stale') return false;
    if (state === 'new') this.clearTask(taskId);
    return true;
  }

  setTask(task) {
    if (!task || !task.task_id || !this.acceptRun(task.task_id, task.run_id)) return;
    if (!task.run_id && this.runs.retiredTools.has(task.tool_use_id)) return;
    if (isAmbientTask(task)) {
      this.clearTask(task.task_id);
      return;
    }
    const previous = this.tasks.get(task.task_id) || {};
    const next = { ...previous, ...task };
    const runId = this.runs.latest.get(task.task_id);
    if (runId) next.run_id = runId;
    if (previous.tool_use_id && next.tool_use_id !== previous.tool_use_id) this.runs.forgetTask(task.task_id);
    this.tasks.set(task.task_id, next);
    if (next.tool_use_id) this.runs.bind(task.task_id, next.tool_use_id);
  }

  clearTask(taskId) {
    if (!taskId) return;
    this.tasks.delete(taskId);
    this.runs.forgetTask(taskId);
  }

  deleteTask(taskId, runId) {
    if (!this.acceptRun(taskId, runId)) return;
    this.clearTask(taskId);
  }

  snapshot(tasks) {
    const next = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task || !task.task_id) continue;
      // An entry for an older run is not evidence that the newer run ended.
      // Omitted task ids still follow the SDK's full-set replacement contract.
      if (!this.runs.isStale(task.task_id, task.run_id)) this.setTask(task);
      const current = this.tasks.get(task.task_id);
      if (current) next.set(task.task_id, current);
    }
    for (const taskId of this.tasks.keys()) if (!next.has(taskId)) this.clearTask(taskId);
    this.tasks = next;
  }

  ingest(event) {
    if (!event) return;

    if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
      this.snapshot(event.tasks);
      return;
    }
    if (event.type === 'system' && event.subtype === 'task_started') {
      this.setTask(event);
      return;
    }
    if (event.type === 'system' && event.subtype === 'task_notification') {
      if (!event.run_id && this.runs.retiredTools.has(event.tool_use_id)) return;
      const taskId = event.task_id || this.toolToTask.get(event.tool_use_id);
      if (isAmbientTask(event) || !taskStatusIsRunning(event.status)) this.deleteTask(taskId, event.run_id);
      else this.setTask({ ...event, task_id: taskId });
      return;
    }
    if (event.type === 'system' && (event.subtype === 'task_updated' || event.subtype === 'task_progress')) {
      if (!event.run_id && this.runs.retiredTools.has(event.tool_use_id)) return;
      const previous = this.tasks.get(event.task_id);
      if (!this.acceptRun(event.task_id, event.run_id)) return;
      const agentProgress = event.subtype === 'task_progress' && isAgentTask(event) && !isAmbientTask(event);
      if (!previous && !agentProgress) return;
      // New-run updates can precede task_started. Keep task classification but
      // never carry a prior run's tool id, status or output into the resumed run.
      // A progress frame may also explicitly identify a new Agent; unknown
      // task types still wait for a start or a typed background snapshot.
      const classification = previous || event;
      const base = this.tasks.get(event.task_id) || {
        task_type: classification.task_type, subagent_type: classification.subagent_type,
      };
      const patch = event.subtype === 'task_progress'
        ? { description: event.description, ...(event.tool_use_id ? { tool_use_id: event.tool_use_id } : {}) }
        : (event.patch || {});
      const next = { ...base, ...patch, task_id: event.task_id };
      const runId = this.runs.latest.get(event.task_id);
      if (runId) next.run_id = runId;
      if (taskStatusIsRunning(next.status) || !next.status) this.setTask(next);
      else this.deleteTask(event.task_id, event.run_id);
      return;
    }

    const notification = userTaskNotification(event);
    if (notification) {
      if (!notification.runId && this.runs.retiredTools.has(notification.toolUseId)) return;
      const taskId = notification.taskId || this.toolToTask.get(notification.toolUseId);
      this.deleteTask(taskId, notification.runId);
      return;
    }
    if (event.type !== 'user' || !event.message || !Array.isArray(event.message.content)) return;
    const results = event.message.content.filter((item) => item && item.type === 'tool_result' && item.tool_use_id);
    if (!results.length) return;
    const structured = event.tool_use_result || event.toolUseResult || {};
    const backgroundTaskId = structured.backgroundTaskId || structured.background_task_id || null;
    const asyncToolUseIds = new Set(asyncAgentLaunches(event).map((launch) => launch.toolUseId));

    for (const result of results) {
      if (this.runs.retiredTools.has(result.tool_use_id)) continue;
      const mappedTaskId = this.toolToTask.get(result.tool_use_id);
      if (results.length === 1 && backgroundTaskId) {
        if (mappedTaskId && mappedTaskId !== backgroundTaskId) this.deleteTask(mappedTaskId);
        this.setTask({
          ...(this.tasks.get(backgroundTaskId) || {}),
          task_id: backgroundTaskId,
          tool_use_id: result.tool_use_id,
          task_type: (this.tasks.get(backgroundTaskId) || {}).task_type || 'shell',
        });
      } else if (!asyncToolUseIds.has(result.tool_use_id)) {
        this.deleteTask(mappedTaskId);
      }
    }
  }
}

class LiveAsyncAgentTracker {
  constructor() {
    this.pending = new Set();
    this.taskToTracking = new Map();
    this.runs = new TaskRunIndex();
  }

  get size() {
    return this.pending.size;
  }

  reset() {
    this.pending.clear();
    this.taskToTracking.clear();
    this.runs.reset();
  }

  clearTask(taskId) {
    if (!taskId) return;
    const mappedId = this.taskToTracking.get(taskId);
    if (mappedId) this.pending.delete(mappedId);
    this.pending.delete('task:' + taskId);
    this.taskToTracking.delete(taskId);
    this.runs.forgetTask(taskId);
  }

  acceptRun(taskId, runId) {
    const state = this.runs.observe(taskId, runId);
    if (state === 'stale') return false;
    if (state === 'new') this.clearTask(taskId);
    return true;
  }

  snapshot(tasks) {
    const previous = new Set(this.pending);
    const nextPending = new Set();
    const nextMap = new Map();

    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task || !task.task_id) continue;
      if (!this.runs.isStale(task.task_id, task.run_id)) {
        if (isAmbientTask(task) || !isAgentTask(task)) {
          if (this.acceptRun(task.task_id, task.run_id)) this.clearTask(task.task_id);
        } else this.launch({ taskId: task.task_id, toolUseId: task.tool_use_id, runId: task.run_id });
      }
      const trackingId = this.taskToTracking.get(task.task_id);
      if (trackingId) {
        nextPending.add(trackingId);
        nextMap.set(task.task_id, trackingId);
      }
    }

    for (const taskId of this.taskToTracking.keys()) if (!nextMap.has(taskId)) this.clearTask(taskId);
    for (const id of this.pending) if (!nextPending.has(id)) this.runs.retiredTools.add(id);
    this.pending = nextPending;
    this.taskToTracking = nextMap;
    const changed = previous.size !== nextPending.size
      || [...previous].some((id) => !nextPending.has(id));
    return { kind: 'snapshot', changed, pending: this.size };
  }

  launch({ taskId, toolUseId, runId } = {}) {
    if (!this.acceptRun(taskId, runId)) return null;
    if (toolUseId && this.runs.retiredTools.has(toolUseId) && !runId) return null;
    const mappedId = taskId ? this.taskToTracking.get(taskId) : null;
    const trackingId = toolUseId || mappedId || (taskId ? 'task:' + taskId : null);
    if (!trackingId) return null;
    if (mappedId && mappedId !== trackingId) {
      this.pending.delete(mappedId);
      this.runs.forgetTask(taskId);
    }
    const changed = !this.pending.has(trackingId);
    this.pending.add(trackingId);
    if (taskId) this.taskToTracking.set(taskId, trackingId);
    if (toolUseId) this.runs.bind(taskId, toolUseId);
    return { kind: 'launched', changed, taskId: taskId || null, toolUseId: toolUseId || null, trackingId, pending: this.size };
  }

  finish({ taskId, toolUseId, runId, status } = {}) {
    taskId = taskId || this.runs.tools.get(toolUseId);
    const previousSize = this.size;
    const previousTrackingId = taskId ? this.taskToTracking.get(taskId) : null;
    if (!this.acceptRun(taskId, runId)) return null;
    if (toolUseId && this.runs.retiredTools.has(toolUseId) && !runId) return null;
    const mappedId = taskId ? this.taskToTracking.get(taskId) : null;
    const candidates = new Set([
      mappedId,
      toolUseId || null,
      taskId ? 'task:' + taskId : null,
    ].filter(Boolean));
    let changed = this.size !== previousSize;
    for (const id of candidates) changed = this.pending.delete(id) || changed;
    if (taskId) {
      this.taskToTracking.delete(taskId);
      this.runs.forgetTask(taskId);
    }
    if (toolUseId) this.runs.retiredTools.add(toolUseId);
    if (!changed) return null;
    return {
      kind: 'finished', changed, taskId: taskId || null, toolUseId: toolUseId || null,
      trackingId: mappedId || previousTrackingId || toolUseId || (taskId ? 'task:' + taskId : null),
      status: status || 'completed', pending: this.size,
    };
  }

  ingest(event) {
    if (!event) return [];

    if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
      return [this.snapshot(event.tasks)];
    }

    if (event.type === 'system' && event.subtype === 'task_started') {
      if (isAmbientTask(event) || !isAgentTask(event)) {
        if (this.acceptRun(event.task_id, event.run_id)) this.clearTask(event.task_id);
        return [];
      }
      const transition = this.launch({ taskId: event.task_id, toolUseId: event.tool_use_id, runId: event.run_id });
      return transition ? [transition] : [];
    }

    if (event.type === 'system' && event.subtype === 'task_notification') {
      const status = String(event.status || '').toLowerCase();
      if (isAmbientTask(event) || !taskStatusIsRunning(status)) {
        const transition = this.finish({
          taskId: event.task_id, toolUseId: event.tool_use_id, runId: event.run_id,
          status: isAmbientTask(event) ? 'ambient' : (status || 'completed'),
        });
        return transition ? [transition] : [];
      }
      const tracked = this.taskToTracking.has(event.task_id);
      if (!this.acceptRun(event.task_id, event.run_id)) return [];
      if (tracked && !this.taskToTracking.has(event.task_id)) {
        const transition = this.launch({ taskId: event.task_id, runId: event.run_id, toolUseId: event.tool_use_id });
        return transition ? [transition] : [];
      }
      return [];
    }

    if (event.type === 'system' && (event.subtype === 'task_updated' || event.subtype === 'task_progress')) {
      const patch = event.subtype === 'task_progress' ? {} : (event.patch || {});
      const status = String(patch.status || '').toLowerCase();
      if (status && !taskStatusIsRunning(status)) {
        const transition = this.finish({ taskId: event.task_id, runId: event.run_id, status });
        return transition ? [transition] : [];
      }
      const tracked = this.taskToTracking.has(event.task_id);
      if (!this.acceptRun(event.task_id, event.run_id)) return [];
      const agentProgress = event.subtype === 'task_progress' && isAgentTask(event) && !isAmbientTask(event);
      if (patch.ambient === true) this.clearTask(event.task_id);
      else if ((tracked || agentProgress) && (!this.taskToTracking.has(event.task_id)
          || (event.subtype === 'task_progress' && event.tool_use_id))) {
        const transition = this.launch({ taskId: event.task_id, runId: event.run_id,
          ...(event.subtype === 'task_progress' ? { toolUseId: event.tool_use_id } : {}) });
        return transition ? [transition] : [];
      }
      return [];
    }

    // Saved notifications carry the run identity outside the model-visible text.
    const notification = userTaskNotification(event);
    if (notification) {
      const transition = this.finish(notification);
      return transition ? [transition] : [];
    }

    const launched = [];
    for (const launch of asyncAgentLaunches(event)) {
      const transition = this.launch(launch);
      if (transition) launched.push(transition);
    }
    return launched;
  }
}

function liveResultDisposition(event, tracker) {
  if (!event || event.type !== 'result') return null;
  // SDK interrupt can return subtype=success with an explicit aborted reason.
  // It terminates the current turn even when queued input or Agents remain.
  if (/^aborted_/.test(String(event.terminal_reason || ''))) return 'finish';
  // Rejected tools remain recorded in permission_denials, but do not turn an
  // otherwise successful stage into a fatal result or cancel existing work.
  if (event.is_error === true || event.subtype !== 'success') return 'finish';
  // One-shot callers may not have a turn router. A batch receipt is not the
  // shared model call's final result, even after the last Agent has finished.
  if (isNotificationOnlyResult(event)) return 'wait';
  if (Number(event.queued_turn_count || 0) > 0) return 'wait';
  return tracker && tracker.size > 0 ? 'wait' : 'finish';
}

module.exports = {
  LiveBackgroundTaskTracker,
  LiveAsyncAgentTracker,
  isAmbientTask,
  isAgentTask,
  liveResultDisposition,
};
