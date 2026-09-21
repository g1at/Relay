'use strict';

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

// 与 Agent gate 分开保存 SDK 报告的“所有后台任务”。非 Agent 不阻塞最终 result，
// 但若 result 到达时它仍存活，常驻 query 必须回收，否则它稍后的完成通知会自动开启一轮
// assistant continuation，并可能串进下一条用户消息。
class LiveBackgroundTaskTracker {
  constructor() {
    this.tasks = new Map();
    this.toolToTask = new Map();
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
    this.toolToTask.clear();
  }

  setTask(task) {
    if (!task || !task.task_id) return;
    if (isAmbientTask(task)) {
      this.deleteTask(task.task_id);
      return;
    }
    const previous = this.tasks.get(task.task_id) || {};
    const next = { ...previous, ...task };
    this.tasks.set(task.task_id, next);
    if (next.tool_use_id) this.toolToTask.set(next.tool_use_id, task.task_id);
  }

  deleteTask(taskId) {
    if (!taskId) return;
    this.tasks.delete(taskId);
    for (const [toolUseId, mappedTaskId] of this.toolToTask) {
      if (mappedTaskId === taskId) this.toolToTask.delete(toolUseId);
    }
  }

  snapshot(tasks) {
    const next = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (task && task.task_id && !isAmbientTask(task)) next.set(task.task_id, { ...task });
    }
    this.tasks = next;
    for (const [toolUseId, taskId] of this.toolToTask) {
      if (!next.has(taskId)) this.toolToTask.delete(toolUseId);
    }
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
      if (isAmbientTask(event)) this.deleteTask(event.task_id || this.toolToTask.get(event.tool_use_id));
      else if (taskStatusIsRunning(event.status)) this.setTask(event);
      else this.deleteTask(event.task_id || this.toolToTask.get(event.tool_use_id));
      return;
    }
    if (event.type === 'system' && event.subtype === 'task_updated') {
      const previous = this.tasks.get(event.task_id);
      if (!previous) return;
      const next = { ...previous, ...(event.patch || {}) };
      if (taskStatusIsRunning(next.status) || !next.status) this.setTask(next);
      else this.deleteTask(event.task_id);
      return;
    }

    if (event.type !== 'user' || !event.message || !Array.isArray(event.message.content)) return;
    const results = event.message.content.filter((item) => item && item.type === 'tool_result' && item.tool_use_id);
    if (!results.length) return;
    const structured = event.tool_use_result || event.toolUseResult || {};
    const backgroundTaskId = structured.backgroundTaskId || structured.background_task_id || null;
    const asyncToolUseIds = new Set(asyncAgentLaunches(event).map((launch) => launch.toolUseId));

    for (const result of results) {
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
  }

  get size() {
    return this.pending.size;
  }

  reset() {
    this.pending.clear();
    this.taskToTracking.clear();
  }

  snapshot(tasks) {
    const previous = new Set(this.pending);
    const previousMap = this.taskToTracking;
    const nextPending = new Set();
    const nextMap = new Map();

    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (isAmbientTask(task) || !isAgentTask(task) || !task.task_id) continue;
      const trackingId = previousMap.get(task.task_id) || `task:${task.task_id}`;
      nextPending.add(trackingId);
      nextMap.set(task.task_id, trackingId);
    }

    this.pending = nextPending;
    this.taskToTracking = nextMap;
    const changed = previous.size !== nextPending.size
      || [...previous].some((id) => !nextPending.has(id));
    return { kind: 'snapshot', changed, pending: this.size };
  }

  launch({ taskId, toolUseId } = {}) {
    const mappedId = taskId ? this.taskToTracking.get(taskId) : null;
    const trackingId = toolUseId || mappedId || (taskId ? `task:${taskId}` : null);
    if (!trackingId) return null;
    if (mappedId && mappedId !== trackingId) this.pending.delete(mappedId);
    const changed = !this.pending.has(trackingId);
    this.pending.add(trackingId);
    if (taskId) this.taskToTracking.set(taskId, trackingId);
    return { kind: 'launched', changed, taskId: taskId || null, toolUseId: toolUseId || null, trackingId, pending: this.size };
  }

  finish({ taskId, toolUseId, status } = {}) {
    const mappedId = taskId ? this.taskToTracking.get(taskId) : null;
    const candidates = new Set([
      mappedId,
      toolUseId || null,
      taskId ? `task:${taskId}` : null,
    ].filter(Boolean));
    let changed = false;
    for (const id of candidates) changed = this.pending.delete(id) || changed;
    if (taskId) this.taskToTracking.delete(taskId);
    if (!changed) return null;
    return {
      kind: 'finished', changed, taskId: taskId || null, toolUseId: toolUseId || null,
      trackingId: mappedId || toolUseId || (taskId ? `task:${taskId}` : null),
      status: status || 'completed', pending: this.size,
    };
  }

  ingest(event) {
    if (!event) return [];

    if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
      return [this.snapshot(event.tasks)];
    }

    if (event.type === 'system' && event.subtype === 'task_started'
        && !isAmbientTask(event) && isAgentTask(event)) {
      const transition = this.launch({ taskId: event.task_id, toolUseId: event.tool_use_id });
      return transition ? [transition] : [];
    }

    if (event.type === 'system' && event.subtype === 'task_notification') {
      if (isAmbientTask(event)) {
        const transition = this.finish({ taskId: event.task_id, toolUseId: event.tool_use_id, status: 'ambient' });
        return transition ? [transition] : [];
      }
      const status = String(event.status || '').toLowerCase();
      if (!taskStatusIsRunning(status)) {
        const transition = this.finish({
          taskId: event.task_id,
          toolUseId: event.tool_use_id,
          status: status || 'completed',
        });
        return transition ? [transition] : [];
      }
      return [];
    }

    if (event.type === 'system' && event.subtype === 'task_updated') {
      const status = String(event.patch && event.patch.status || '').toLowerCase();
      if (status && !taskStatusIsRunning(status)) {
        const transition = this.finish({ taskId: event.task_id, status });
        return transition ? [transition] : [];
      }
      return [];
    }

    // 兼容只把完成通知包在 user 文本中的旧版 CLI transcript。
    const userContent = event.type === 'user' && event.message && event.message.content;
    if (typeof userContent === 'string' && /<task-notification>/i.test(userContent)) {
      const toolUseId = ((userContent.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/i) || [])[1] || '').trim();
      const taskId = ((userContent.match(/<task-id>([\s\S]*?)<\/task-id>/i) || [])[1] || '').trim();
      const status = ((userContent.match(/<status>([\s\S]*?)<\/status>/i) || [])[1] || '').trim().toLowerCase();
      if ((toolUseId || taskId) && status && !taskStatusIsRunning(status)) {
        const transition = this.finish({ taskId, toolUseId, status });
        return transition ? [transition] : [];
      }
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
