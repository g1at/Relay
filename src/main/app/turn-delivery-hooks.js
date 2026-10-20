'use strict';

// One observer belongs to one SDK LiveSession. It records evidence only and
// never returns permission decisions, replaces input, or changes tool output.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const MAX_TRACKED_TOOLS = 128;
const TOOL_ID_PREFIX = 'relay-delivery-hook:';
const valid = value => typeof value === 'string' && value.length > 0
  && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
const filePath = input => input?.file_path || input?.notebook_path || input?.path;
const agentOwner = input => input.agent_id == null ? '' : input.agent_id;

function createTurnDeliveryHooks({ observe: publish, isActive } = {}) {
  const tracked = new Map();
  let disposed = false;
  let sessionId = null;

  function active(intent) {
    if (disposed || typeof isActive !== 'function') return false;
    try { return isActive(intent.runId, intent.conversationId) === true; }
    catch (_) { return false; }
  }
  function emit(intent, type) {
    if (typeof publish !== 'function') return;
    const id = TOOL_ID_PREFIX + intent.toolUseId;
    const event = {
      type, jobId: intent.runId, session_id: intent.sessionId,
      ...(intent.owner ? { agent_id: intent.owner } : {}),
      ...(intent.cwd ? { cwd: intent.cwd } : {}),
      message: {
        role: type,
        content: type === 'assistant'
          ? [{ type: 'tool_use', id, name: intent.toolName, input: { file_path: intent.path } }]
          : [{ type: 'tool_result', tool_use_id: id, is_error: false, content: '' }],
      },
    };
    try { Promise.resolve(publish(intent.runId, event)).catch(() => {}); }
    catch (_) { /* Recording must not change native tool behavior. */ }
  }
  function makeRoom() {
    if (tracked.size < MAX_TRACKED_TOOLS) return true;
    for (const [id, intent] of tracked) {
      if (intent.settled || !active(intent)) tracked.delete(id);
      if (tracked.size < MAX_TRACKED_TOOLS) return true;
    }
    return false;
  }
  function observe(input, toolUseId, scope = {}) {
    if (disposed || !input || typeof input !== 'object') return;
    const kind = input.hook_event_name;
    if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(kind)) return;
    const id = toolUseId || input.tool_use_id;
    if (!valid(id) || (input.tool_use_id && input.tool_use_id !== id)) return;
    if (!valid(input.session_id) || (sessionId !== null && sessionId !== input.session_id)) return;
    const owner = agentOwner(input);
    if (owner !== '' && !valid(owner)) return;
    if (!WRITE_TOOLS.has(input.tool_name)) return;

    if (kind === 'PreToolUse') {
      if (!valid(scope?.runId) || !valid(scope?.conversationId)) return;
      const path = filePath(input.tool_input);
      if (!valid(path)) return;
      const prior = tracked.get(id);
      if (prior) {
        // A reused native id cannot move an old pending receipt to a new turn.
        if (prior.runId !== scope.runId || prior.conversationId !== scope.conversationId
          || prior.owner !== owner || prior.toolName !== input.tool_name || prior.path !== path) prior.settled = true;
        return;
      }
      const intent = {
        toolUseId: id, toolName: input.tool_name, path, owner,
        sessionId: input.session_id, runId: scope.runId, conversationId: scope.conversationId,
        cwd: valid(input.cwd) ? input.cwd : '', settled: false,
      };
      if (!active(intent) || !makeRoom()) return;
      sessionId = input.session_id;
      tracked.set(id, intent);
      emit(intent, 'assistant');
      return;
    }

    const intent = tracked.get(id);
    if (!intent || intent.settled || intent.sessionId !== input.session_id
      || intent.owner !== owner || intent.toolName !== input.tool_name) return;
    // The post callback may arrive while another turn is selected or running.
    // Its scope argument is deliberately ignored; only the captured turn owns it.
    const responsePath = filePath(input.tool_input);
    if (responsePath !== intent.path) return;
    intent.settled = true;
    if (kind !== 'PostToolUse' || input.is_error === true
      || input.tool_response?.is_error === true || input.tool_response?.isError === true
      || !active(intent)) return;
    emit(intent, 'user');
  }
  function dispose() { disposed = true; tracked.clear(); sessionId = null; }
  return { observe, dispose };
}

module.exports = { createTurnDeliveryHooks, MAX_TRACKED_TOOLS, TOOL_ID_PREFIX };
