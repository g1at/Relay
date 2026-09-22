'use strict';
const { NativeEventState } = require('./sdk-native-events');

// Diagnostics deliberately retain names, booleans and durations, never account,
// environment, prompts, tool arguments, hook bodies or raw stderr.
const list = value => Array.isArray(value) ? value.filter(x => typeof x === 'string').slice(0, 512) : [];
const names = value => Array.isArray(value) ? value.map(x => typeof x === 'string' ? x : x?.name).filter(x => typeof x === 'string').slice(0, 512) : [];
const TIMING_KEYS = ['ttft_ms', 'ttft_stream_ms', 'time_to_request_ms', 'time_to_request_from_spawn_ms',
  'duration_ms', 'duration_api_ms', 'first_content_frame_ms', 'first_stream_post_ms', 'first_stream_post_ack_ms'];
class SdkSessionObserver {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.startedAt = now();
    this.epoch = 0;
    this.sessionId = null;
    this.state = 'starting';
    this.initialization = {};
    this.catalog = { commands: [], agents: [], skills: [], tools: [], plugins: [], mcpServers: [] };
    this.capabilities = [];
    this.stderrCounts = {};
    this.timing = {};
    this.foregroundTools = new Map();
    this.finishedToolIds = new Set();
    this.native = new NativeEventState();
  }
  initialized(result = {}) {
    this.initialization = {
      readyMs: Math.max(0, this.now() - this.startedAt),
      hooksApplied: typeof result.hooks_applied === 'boolean' ? result.hooks_applied : null,
      pluginsApplied: typeof result.plugins_applied === 'boolean' ? result.plugins_applied : null,
    };
    this.catalog.commands = names(result.commands);
    this.catalog.agents = names(result.agents);
    return this.snapshot();
  }
  beginTurn() { this.turnStartedAt = this.now(); this.timing = {}; this.foregroundTools.clear(); this.finishedToolIds.clear(); }
  preparation(value = {}) {
    for (const key of ['startupMs', 'modeMs', 'mcpMs', 'totalMs']) {
      if (Number.isFinite(value[key]) && value[key] >= 0) this.timing[key] = value[key];
    }
  }
  stderr(chunk) {
    const text = String(chunk || '').slice(0, 65536);
    const category = /ECONN|ENOTFOUND|ETIMEDOUT|network|connection/i.test(text) ? 'connection'
      : /MCP|server.*connect/i.test(text) ? 'mcp'
      : /settings|config|hook/i.test(text) ? 'configuration'
      : /429|rate.limit|overload/i.test(text) ? 'rateLimit'
      : /auth|401|403|credential/i.test(text) ? 'authentication' : 'other';
    if (text) this.stderrCounts[category] = (this.stderrCounts[category] || 0) + 1;
  }
  observe(event) {
    if (!event || event.parent_tool_use_id || event.parentToolUseId || event.agent_id) return false;
    if (event.type === 'conversation_reset') {
      if (!event.new_conversation_id || (this.sessionId && event.session_id !== this.sessionId)) return false;
      this.sessionId = event.new_conversation_id;
      this.epoch++;
      this.timing = {};
      this.foregroundTools.clear();
      this.finishedToolIds.clear();
      this.state = 'idle';
      return true;
    }
    if (this.sessionId && event.session_id && event.session_id !== this.sessionId) return false;
    this.native.observe(event);
    const blocks = event.type === 'assistant' ? event.message?.content
      : event.type === 'stream_event' && event.event?.type === 'content_block_start' ? [event.event.content_block] : [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === 'tool_use' && block.id && /^(?:Bash|Agent|Task)$/.test(block.name || '')
          && !this.foregroundTools.has(block.id) && !this.finishedToolIds.has(block.id)) {
        this.foregroundTools.set(block.id, { toolUseId: block.id, toolName: block.name, status: 'running', isBackgrounded: false });
      }
    }
    if (event.type === 'user') for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type === 'tool_result') { this.foregroundTools.delete(block.tool_use_id); this.finishedToolIds.add(block.tool_use_id); }
    }
    if (event.type === 'system' && /^task_/.test(event.subtype || '')) {
      const tool = this.foregroundTools.get(event.tool_use_id)
        || [...this.foregroundTools.values()].find(item => item.taskId && item.taskId === event.task_id);
      if (tool) {
        if (event.task_id) tool.taskId = event.task_id;
        if (event.is_backgrounded === true || event.patch?.is_backgrounded === true) tool.isBackgrounded = true;
        if (event.subtype === 'task_notification' && !['running', 'pending', 'paused'].includes(event.status)
            || event.patch?.status && ['completed', 'failed', 'stopped', 'killed'].includes(event.patch.status)) {
          this.foregroundTools.delete(tool.toolUseId); this.finishedToolIds.add(tool.toolUseId);
        }
      }
    }
    if (event.type === 'result') { for (const id of this.foregroundTools.keys()) this.finishedToolIds.add(id); this.foregroundTools.clear(); }
    if (event.type === 'system' && event.subtype === 'init') {
      this.sessionId = event.session_id || this.sessionId;
      this.capabilities = list(event.capabilities);
      this.catalog = { ...this.catalog, commands: list(event.slash_commands), agents: names(event.agents),
        skills: list(event.skills), tools: list(event.tools), plugins: names(event.plugins),
        mcpServers: (event.mcp_servers || []).map(x => ({ name: String(x.name || ''), status: String(x.status || '') })).slice(0, 256) };
    }
    if (event.type === 'system' && event.subtype === 'session_state_changed'
        && ['idle', 'running', 'requires_action'].includes(event.state)) this.state = event.state;
    // State is advisory. An idle update never fabricates result/job-done.
    if (event.type === 'system' && event.subtype === 'commands_changed') this.catalog.commands = names(event.commands);
    if (event.type === 'result' || event.type === 'stream_event') {
      for (const key of TIMING_KEYS) if (Number.isFinite(event[key]) && event[key] >= 0) this.timing[key] = event[key];
    }
    const delta = event.event?.delta;
    const content = event.type === 'assistant' && event.message?.content?.some(x => x.type === 'text' && x.text);
    if (this.turnStartedAt != null && this.timing.firstVisibleMs == null
        && (content || delta?.type === 'text_delta' && delta.text)) {
      this.timing.firstVisibleMs = Math.max(0, this.now() - this.turnStartedAt);
    }
    return true;
  }
  snapshot() {
    return JSON.parse(JSON.stringify({ sessionId: this.sessionId, epoch: this.epoch, sessionState: this.state,
      initialization: this.initialization, catalog: this.catalog, capabilities: this.capabilities,
      timing: this.timing, stderrCounts: this.stderrCounts, native: this.native.snapshot() }));
  }
}

// A stop click is scoped to an extant task of this exact running turn. A delayed
// response cannot acknowledge or mutate a replacement session/turn.
async function stopOwnedTask({ session, convId, jobId, taskId, isCurrent, timeoutMs = 10000 }) {
  if (!session || session.dead || !session.busy || session.convId !== convId || session.jobId !== jobId
      || typeof taskId !== 'string' || !session.backgroundTaskTracker?.tasks?.has(taskId)) {
    return { ok: false, code: 'TASK_NOT_ACTIVE', message: '这个子任务已结束或不属于当前轮次' };
  }
  if (session.stoppingTasks?.has(taskId)) return session.stoppingTasks.get(taskId);
  if (!session.stoppingTasks) session.stoppingTasks = new Map();
  const contextEpoch = session.observer?.epoch;
  const operation = (async () => {
    let timer;
    try {
      await Promise.race([session.child.stopTask(taskId), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('停止请求尚未确认，请查看任务状态')), timeoutMs);
      })]);
      if (!isCurrent(session) || session.jobId !== jobId || session.observer?.epoch !== contextEpoch) return { ok: false, stale: true };
      return { ok: true, requested: true }; // task_notification remains authoritative
    } catch (error) { return { ok: false, message: error.message }; }
    finally { clearTimeout(timer); session.stoppingTasks.delete(taskId); }
  })();
  session.stoppingTasks.set(taskId, operation);
  return operation;
}

// This targets one active SDK tool call, never every task or another Relay
// conversation. Only native task/tool-result events change its displayed state.
async function backgroundOwnedTask({ session, convId, jobId, toolUseId, isCurrent, timeoutMs = 10000 }) {
  const tool = session?.observer?.foregroundTools?.get(toolUseId);
  if (!session || session.dead || !session.busy || session.convId !== convId || session.jobId !== jobId
      || typeof toolUseId !== 'string' || !toolUseId || !session.turnRouter?.toolIds?.has(toolUseId)
      || !tool || tool.status !== 'running' || !/^(?:Bash|Agent|Task)$/.test(tool.toolName)) {
    return { ok: false, code: 'TASK_NOT_ACTIVE', message: '这个命令或 Agent 已结束，或不属于当前轮次' };
  }
  if (tool.isBackgrounded) return { ok: false, code: 'ALREADY_BACKGROUND', message: '这个任务已经在后台运行' };
  if (typeof session.child?.backgroundTasks !== 'function') return { ok: false, code: 'BACKGROUND_UNAVAILABLE', message: '当前执行器不支持转到后台' };
  const contextEpoch = session.observer.epoch;
  const requests = session.backgroundRequests || (session.backgroundRequests = new Map());
  for (const [id, request] of requests) if (request.jobId !== jobId || request.contextEpoch !== contextEpoch) requests.delete(id);
  if (requests.has(toolUseId)) return requests.get(toolUseId).promise;
  const request = { jobId, contextEpoch, taskId: tool.taskId || null };
  const current = () => isCurrent(session) && !session.dead && session.jobId === jobId && session.observer.epoch === contextEpoch;
  const operation = Promise.resolve().then(() => {
    if (!current()) return { ok: false, stale: true };
    return session.child.backgroundTasks(toolUseId).then(backgrounded => {
      if (!current()) return { ok: false, stale: true };
      return backgrounded === true ? { ok: true, requested: true }
        : { ok: false, code: 'NO_FOREGROUND_TASK', message: '未找到可转到后台的前台任务，它可能已经结束' };
    });
  }).catch(error => current() ? ({ ok: false, code: 'BACKGROUND_UNAVAILABLE', message: error?.message || '当前会话不支持转到后台' })
    : ({ ok: false, stale: true }));
  let timer;
  request.promise = Promise.race([operation, new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, pending: true, code: 'BACKGROUND_PENDING', message: '转后台请求尚未确认，请查看任务状态' }), timeoutMs);
  })]);
  requests.set(toolUseId, request);
  operation.then(result => {
    clearTimeout(timer);
    if (requests.get(toolUseId) !== request) return;
    if (result.ok) { request.backgrounded = true; request.promise = Promise.resolve(result); }
    else requests.delete(toolUseId);
  });
  return request.promise;
}

// A manually backgrounded task belongs to this turn until the SDK delivers its
// completion notification. A terminal task_updated can precede that delivery;
// an intervening result must not close the Query and kill its continuation.
function observeOwnedBackgroundTasks(session, event) {
  const requests = session.backgroundRequests;
  if (!requests?.size) return 0;
  for (const [toolUseId, request] of requests) {
    if (request.jobId !== session.jobId || request.contextEpoch !== session.observer?.epoch) {
      requests.delete(toolUseId); continue;
    }
    const task = session.backgroundTaskTracker?.tasks?.get(request.taskId || session.backgroundTaskTracker?.toolToTask?.get(toolUseId));
    if (task) {
      request.taskId = task.task_id;
      if (task.is_backgrounded) request.backgrounded = true;
    }
    const belongs = event?.tool_use_id === toolUseId || request.taskId && event?.task_id === request.taskId;
    if (belongs && event.type === 'system') {
      if (event.task_id) request.taskId = event.task_id;
      if (event.is_backgrounded === true || event.patch?.is_backgrounded === true) request.backgrounded = true;
      if (event.subtype === 'task_notification' && ['completed', 'failed', 'stopped', 'killed'].includes(event.status)) request.settled = true;
    }
    const structured = event?.tool_use_result || event?.toolUseResult || {};
    const taskId = structured.backgroundTaskId || structured.background_task_id || structured.agentId || structured.taskId;
    if (event?.type === 'user' && taskId && Array.isArray(event.message?.content)
        && event.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)) {
      request.taskId = taskId; request.backgrounded = true;
    }
  }
  return [...requests.entries()].filter(([toolUseId, request]) => !request.settled && (request.backgrounded
    || session.backgroundTaskTracker?.toolToTask?.has(toolUseId))).length;
}
class RouteTimingHistory {
  constructor(limit = 100) { this.limit = limit; this.samples = []; }
  add(route, timing) {
    if (!timing || !Number.isFinite(timing.firstVisibleMs)) return;
    this.samples.push({ key: JSON.stringify([route.providerId, route.providerRevision, route.model, route.agentEnvironment]),
      routeTier: route.routeTier, firstVisibleMs: timing.firstVisibleMs,
      requestMs: Number.isFinite(timing.time_to_request_ms) ? timing.time_to_request_ms : null });
    this.samples = this.samples.slice(-this.limit);
  }
  snapshot() {
    const groups = new Map();
    for (const sample of this.samples) {
      const group = groups.get(sample.key) || { routeTier: sample.routeTier, values: [], requests: [] };
      group.values.push(sample.firstVisibleMs);
      if (sample.requestMs != null) group.requests.push(sample.requestMs);
      groups.set(sample.key, group);
    }
    const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    return [...groups.values()].map(g => ({ routeTier: g.routeTier, samples: g.values.length,
      averageFirstVisibleMs: mean(g.values), averageRequestMs: mean(g.requests) }));
  }
}
module.exports = { SdkSessionObserver, stopOwnedTask, backgroundOwnedTask, observeOwnedBackgroundTasks, RouteTimingHistory };
