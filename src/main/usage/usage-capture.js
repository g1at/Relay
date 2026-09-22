'use strict';

const { randomUUID } = require('node:crypto');
const MODEL_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests'];
const TURN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const TOKEN_FIELDS = MODEL_FIELDS.slice(0, 4);
const CHECKPOINT_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

function numericUsage(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of fields) {
    if (typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0) result[field] = value[field];
  }
  return Object.keys(result).length ? result : null;
}

// One observer per query() invocation. A resumed SDK session starts a new
// query; cumulative modelUsage must never be keyed by session_id alone.
// Only numbers and opaque identifiers cross this boundary, never transcript
// text, tool arguments, credentials, or SDK-computed dollar estimates.
function createUsageObserver(onUsage, { queryId = randomUUID(), now = () => new Date().toISOString(),
  checkpointIntervalMs = 5000, checkpointTimeoutMs = 2000, clock = Date.now } = {}) {
  const startedAt = now();
  let resetSessionId = null;
  let sessionId = null;
  let query = null;
  let closed = false;
  let disabled = false;
  let active = false;
  let generation = 0;
  let sequence = 0;
  let timer = null;
  let inFlight = null;
  let lastRequestedAt = -Infinity;
  let checkpointHighWater = Object.create(null);
  const retiredSessions = new Set();
  const resetIds = new Set();
  const resultIds = new Set();
  const interval = Math.max(1, Number(checkpointIntervalMs) || 5000);
  const timeout = Math.max(1, Number(checkpointTimeoutMs) || 2000);
  const publish = record => {
    // Statistics must never change chat completion, cancellation, or failures.
    try { Promise.resolve(onUsage(record)).catch(() => {}); } catch (_) {}
  };
  const modelsFor = (value, complete = false) => {
    const models = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return models;
    for (const [model, usage] of Object.entries(value)) {
      if (!model || model.length > 256 || model === '<synthetic>') continue;
      const fields = numericUsage(usage, MODEL_FIELDS);
      if (complete && !TOKEN_FIELDS.every(field => Number.isSafeInteger(fields?.[field]))) continue;
      if (fields) models[model] = fields;
    }
    return models;
  };
  const remember = models => {
    let changed = false;
    for (const [model, value] of Object.entries(models)) {
      if (!TOKEN_FIELDS.every(field => Number.isSafeInteger(value[field]))) continue;
      const previous = checkpointHighWater[model] || Object.create(null);
      for (const field of TOKEN_FIELDS) {
        if (value[field] > (previous[field] || 0)) changed = true;
        previous[field] = Math.max(previous[field] || 0, value[field]);
      }
      checkpointHighWater[model] = previous;
    }
    return changed;
  };
  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const schedule = () => {
    if (closed || disabled || !active || !query || !sessionId || timer || inFlight) return;
    timer = setTimeout(sample, Math.max(0, interval - (clock() - lastRequestedAt)));
    timer.unref?.();
  };
  const sample = () => {
    timer = null;
    if (closed || disabled || !active || !query || !sessionId || inFlight) return;
    const token = { generation, sessionId, timer: null };
    inFlight = token;
    lastRequestedAt = clock();
    // A control request that never settles must not create an accumulating
    // queue of requests. Disable this optional sampler after any failure;
    // terminal result collection remains enabled for the Query.
    token.timer = setTimeout(() => {
      if (inFlight !== token) return;
      // Keep the old in-flight barrier until that actual request settles: a
      // reset must not create concurrent hanging requests or disable its new
      // epoch merely because the previous epoch's response took too long.
      if (token.generation !== generation) return;
      disabled = true; inFlight = null; clearTimer();
    }, timeout);
    token.timer.unref?.();
    Promise.resolve().then(() => {
      if (closed || disabled || token.generation !== generation) return null;
      return query[CHECKPOINT_METHOD]({ skipBehaviors: true });
    }).then(value => {
      if (closed || disabled || inFlight !== token || token.generation !== generation || token.sessionId !== sessionId) return;
      const modelUsage = modelsFor(value?.session?.model_usage, true);
      if (!remember(modelUsage)) return;
      publish({ queryId, startedAt, sessionId: token.sessionId, resultId: `checkpoint:${++sequence}`,
        at: now(), modelUsage, usage: null, isError: false });
    }).catch(() => { if (!closed && token.generation === generation) disabled = true; }).finally(() => {
      clearTimeout(token.timer);
      if (inFlight === token) inFlight = null;
      schedule();
    });
  };
  const observe = event => {
    if (closed || typeof onUsage !== 'function' || !event) return;
    const child = event.parent_tool_use_id || event.parentToolUseId || event.agent_id;
    // Child activity can request a checkpoint of the whole Query, but child
    // result/request counters are never charged separately from modelUsage.
    if (child) {
      if (event.type === 'assistant' || event.type === 'stream_event') { active = true; schedule(); }
      return;
    }
    if (event.type === 'conversation_reset' && typeof event.new_conversation_id === 'string' && event.new_conversation_id) {
      if (event.uuid && resetIds.has(event.uuid)) return;
      if (event.uuid) resetIds.add(event.uuid);
      if (sessionId && sessionId !== event.new_conversation_id) retiredSessions.add(sessionId);
      generation++;
      clearTimer();
      active = false;
      checkpointHighWater = Object.create(null);
      lastRequestedAt = -Infinity;
      // The result wrapper can lag behind a reset. Attribute new cumulative
      // counters to its authoritative conversation ID; keep query identity and
      // every previously collected usage record intact.
      resetSessionId = event.new_conversation_id.slice(0, 256);
      sessionId = resetSessionId;
      return;
    }
    const eventSessionId = typeof event.session_id === 'string' ? event.session_id.slice(0, 256) : null;
    // Results may legitimately retain the old session wrapper after /clear;
    // the reset event is authoritative for their epoch. UUID deduplication
    // below still rejects already observed pre-reset results. Old activity
    // frames cannot start a sampler for the new conversation.
    if (event.type !== 'result' && eventSessionId && retiredSessions.has(eventSessionId)) return;
    if (!sessionId && eventSessionId) sessionId = eventSessionId;
    if (event.type === 'assistant' || event.type === 'user' || event.type === 'stream_event'
        || event.type === 'system' && (event.subtype === 'task_started' || event.subtype === 'task_progress'
          || event.subtype === 'status' && ['requesting', 'compacting'].includes(event.status)
          || event.subtype === 'session_state_changed' && event.state === 'running')) {
      active = true;
      schedule();
    }
    if (event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'idle') {
      active = false; clearTimer();
    }
    if (event.type !== 'result') return;
    const resultId = typeof event.uuid === 'string' ? event.uuid.slice(0, 256) : null;
    if (resultId && resultIds.has(resultId)) return;
    active = Number(event.queued_turn_count) > 0;
    if (!active) clearTimer();
    const modelUsage = modelsFor(event.modelUsage);
    const usage = numericUsage(event.usage, TURN_FIELDS);
    if (!Object.keys(modelUsage).length && !usage) return;
    if (resultId) resultIds.add(resultId);
    remember(modelUsage);
    const record = {
      queryId, startedAt,
      isError: event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error')),
      sessionId: resetSessionId || (typeof event.session_id === 'string' ? event.session_id.slice(0, 256) : null),
      resultId,
      at: now(), modelUsage, usage,
    };
    publish(record);
  };
  observe.attach = value => {
    if (closed || query || typeof onUsage !== 'function') return;
    if (!value || typeof value[CHECKPOINT_METHOD] !== 'function') { disabled = true; return; }
    query = value;
    schedule();
  };
  observe.stop = () => {
    disabled = true; active = false; generation++;
    clearTimer();
    if (inFlight) clearTimeout(inFlight.timer);
    inFlight = null; query = null;
  };
  observe.close = () => { observe.stop(); closed = true; };
  return observe;
}

module.exports = { createUsageObserver };
