'use strict';

const { normalizeExecutionMode } = require('./execution-modes');
const MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);
const FIELDS = ['permissionMode', 'permissionRevision', 'permissionLegacyPlan', 'executionMode'];
const clone = value => JSON.parse(JSON.stringify(value));
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function legacy(value) {
  return { permissionMode: MODES.has(value) ? value : 'default',
    executionMode: { kind: value === 'plan' ? 'plan' : 'default' }, legacyPlan: value === 'plan' };
}
function validMode(value) {
  if (!MODES.has(value)) throw failure('INVALID_PERMISSION_MODE', '权限模式无效');
  return value;
}

// Only this service owns permission metadata. History writers may merge turns,
// but cannot restore an obsolete permission from a renderer or background job.
function createConversationPermissions({ readSettings, writeSettings, loadConversation, persistConversation,
  applyRuntime = async () => {}, stopRuntime = () => {}, onChanged = () => {} }) {
  const queues = new Map(), resetEpochs = new Map(), resetSessions = new Map();
  function config() {
    const settings = readSettings();
    let saved = settings.conversationPermissions;
    if (!saved || saved.version !== 1 || !saved.legacy || !saved.defaults) {
      const initial = legacy(settings.permissionMode);
      saved = { version: 1, legacy: clone(initial), defaults: { ...clone(initial), revision: 1 } };
      writeSettings({ ...settings, conversationPermissions: saved });
    }
    return saved;
  }
  function metadata(record, { isNew = false } = {}) {
    const cfg = config();
    const baseline = isNew ? cfg.defaults : cfg.legacy;
    const explicit = !isNew && (MODES.has(record.permissionMode) || record.permissionMode === 'plan');
    const mode = explicit ? legacy(record.permissionMode) : baseline;
    const initialized = !isNew && Number.isSafeInteger(record.permissionRevision) && record.permissionRevision > 0;
    const legacyPlan = initialized ? !!record.permissionLegacyPlan : !!mode.legacyPlan;
    let executionMode;
    try { executionMode = normalizeExecutionMode(record.executionMode || mode.executionMode); }
    catch (_) { executionMode = { kind: 'default' }; }
    if (legacyPlan) executionMode = { kind: 'plan' };
    return { permissionMode: mode.permissionMode, permissionRevision: initialized ? record.permissionRevision : 1,
      permissionLegacyPlan: legacyPlan, executionMode };
  }
  function dto(record, conversationId) {
    return { ok: true, conversationId: conversationId || null, permissionMode: record.permissionMode,
      executionMode: clone(record.executionMode), revision: record.permissionRevision,
      ...(record.permissionLegacyPlan ? { legacyPlan: true } : {}) };
  }
  function get(conversationId) {
    if (!conversationId) {
      const defaults = config().defaults;
      return dto({ permissionMode: validMode(defaults.permissionMode), executionMode: normalizeExecutionMode(defaults.executionMode),
        permissionRevision: defaults.revision || 1, permissionLegacyPlan: !!defaults.legacyPlan }, null);
    }
    if (typeof conversationId !== 'string' || !/^[\w-]{1,160}$/.test(conversationId)) throw failure('INVALID_CONVERSATION', '对话标识无效');
    const record = loadConversation(conversationId);
    if (!record) throw failure('CONVERSATION_NOT_FOUND', '这个对话已不存在');
    const fields = metadata(record);
    if (FIELDS.some(key => JSON.stringify(record[key]) !== JSON.stringify(fields[key]))) {
      persistConversation({ ...record, ...fields });
    }
    return dto(fields, conversationId);
  }
  function protectSave(incoming, saved) {
    const fields = metadata(saved || incoming, { isNew: !saved });
    Object.assign(incoming, fields);
    return incoming;
  }
  function serialized(id, action) {
    const key = id || '$defaults';
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }
  // A native reset is already effective in the SDK. Commit its metadata
  // synchronously, outside the mode-control queue, so an awaited old ACK cannot
  // put the discarded goal back. It never changes the user's base permission.
  function resetContext(conversationId, { sessionId, runId } = {}) {
    if (!conversationId || typeof sessionId !== 'string' || !sessionId) return null;
    const record = loadConversation(conversationId);
    if (!record) return null;
    if (resetSessions.get(conversationId) === sessionId) return get(conversationId);
    resetEpochs.set(conversationId, (resetEpochs.get(conversationId) || 0) + 1);
    const fields = metadata(record);
    const next = { ...record, ...fields, sessionId, goalRecovery: null,
      permissionRevision: fields.permissionRevision + 1,
      executionMode: fields.executionMode.kind === 'goal' ? { kind: 'default' } : fields.executionMode };
    delete next.contextUsage;
    if (runId && Array.isArray(next.turns)) next.turns = next.turns.map(turn => {
      if (turn.runId !== runId) return turn;
      const current = { ...turn };
      delete current.contextUsage; delete current.goalRecovery;
      if (current.executionMode?.kind === 'goal') current.executionMode = { kind: 'default' };
      return current;
    });
    persistConversation(next);
    resetSessions.set(conversationId, sessionId);
    const result = dto(next, conversationId);
    try { onChanged(result); } catch (_) {}
    return result;
  }
  function adoptGoal(conversationId, { condition, sessionId } = {}) {
    const record = loadConversation(conversationId);
    if (!record || !sessionId || record.sessionId !== sessionId || typeof condition !== 'string' || !condition.trim() || condition.length > 500) return null;
    const fields = metadata(record);
    if (fields.executionMode.kind === 'plan') return null;
    resetEpochs.set(conversationId, (resetEpochs.get(conversationId) || 0) + 1);
    const next = { ...record, ...fields, executionMode: { kind: 'goal' }, goalRecovery: { condition: condition.trim() }, permissionRevision: fields.permissionRevision + 1 };
    persistConversation(next);
    const result = dto(next, conversationId); try { onChanged(result); } catch (_) {}
    return result;
  }
  async function set(input = {}) {
    const permissionMode = validMode(input.permissionMode);
    const explicitExecution = Object.hasOwn(input, 'executionMode');
    const executionMode = explicitExecution ? normalizeExecutionMode(input.executionMode) : null;
    const id = input.conversationId || null;
    const submittedEpoch = resetEpochs.get(id) || 0;
    const checkReset = () => {
      if ((resetEpochs.get(id) || 0) !== submittedEpoch) {
        throw Object.assign(failure('PERMISSION_CONFLICT', '运行上下文已重置，请确认最新选择后重试'), { contextReset: true, current: get(id) });
      }
    };
    return serialized(id, async () => {
      checkReset();
      const before = get(id);
      if (input.expectedRevision != null && input.expectedRevision !== before.revision) {
        throw Object.assign(failure('PERMISSION_CONFLICT', '权限已在其他窗口中更新，请确认最新选择后重试'), { current: before });
      }
      const next = { ...before, permissionMode, executionMode: executionMode || before.executionMode };
      if (explicitExecution && executionMode.kind !== 'plan') delete next.legacyPlan;
      if (permissionMode === before.permissionMode && JSON.stringify(next.executionMode) === JSON.stringify(before.executionMode)
          && !!next.legacyPlan === !!before.legacyPlan) return before;
      next.revision = before.revision + 1;
      let runtimeAttempted = false, commitRuntime;
      try {
        if (id) { runtimeAttempted = true; commitRuntime = await applyRuntime(id, next, before); }
        checkReset();
        if (id) {
          // Read again after the SDK acknowledgement: a running turn may have
          // saved output or been deleted while its control request was pending.
          const latest = loadConversation(id);
          if (!latest) throw failure('CONVERSATION_NOT_FOUND', '这个对话已不存在');
          persistConversation({ ...latest, permissionMode, permissionRevision: next.revision,
            permissionLegacyPlan: !!next.legacyPlan, executionMode: clone(next.executionMode),
            // Commit clearing together with leaving goal mode, so a late save or
            // a failed second write cannot resurrect the previous objective.
            ...(explicitExecution && executionMode.kind !== 'goal' ? { goalRecovery: null } : {}),
          });
        } else {
          const settings = readSettings(), cfg = config();
          writeSettings({ ...settings, conversationPermissions: { ...cfg, defaults: {
            permissionMode, executionMode: clone(next.executionMode), legacyPlan: !!next.legacyPlan, revision: next.revision,
          } } });
        }
      } catch (error) {
        // If the SDK accepted the mode but saving failed, restore the previous
        // mode before returning the error. Waiting prompts remain untouched.
        // The old snapshot belongs to a discarded SDK context. Rolling it back
        // would resurrect its goal or remove a newer plan guard.
        const wasReset = (resetEpochs.get(id) || 0) !== submittedEpoch;
        if (!wasReset && typeof commitRuntime?.rollback === 'function') {
          try { await commitRuntime.rollback(); error.runtimeUnchanged = true; } catch (_) {}
        }
        // A timed-out SDK command can still arrive later. Retire only an
        // executor whose effective permission could not be confirmed/restored.
        if (runtimeAttempted && !error.runtimeUnchanged) { try { stopRuntime(id, error); } catch (_) {} }
        throw error;
      }
      // A CLI mode ACK does not re-evaluate already parked canUseTool requests.
      // Release eligible requests only after this exact permission is persisted.
      if (typeof commitRuntime === 'function') commitRuntime();
      try { onChanged(next); } catch (_) {}
      return next;
    });
  }
  return { get, set, protectSave, resetContext, adoptGoal, withSnapshot: (id, action) => serialized(id, () => action(get(id))) };
}

module.exports = { createConversationPermissions, isConversationPermissionMode: value => MODES.has(value) };
