'use strict';

const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const tailKey = record => JSON.stringify((record?.turns || []).map(turn => [turn?.runId || null, turn?.ts || null]));
const outcomeKeys = ['assistant', 'output', 'error', 'status', 'taskRun', 'inputKind', 'outputNotice', 'assistantTs', 'thinking', 'activity', 'chat', 'supplements'];
const sessionKeys = ['sessionId', 'sessionProviderId', 'sessionProviderRevision', 'sessionRouteTier', 'sessionAgentEnvironment'];

// Runtime controls may await an old process for minutes. Never retain a whole
// conversation across that await, and never let its response undo a newer turn.
function createRuntimeMetadataWriter({ load, persist }) {
  const requests = new Map();
  const controls = new Map();
  function begin(id) {
    const record = load(id);
    const token = { id, sessionId: record?.sessionId || null, turns: tailKey(record) };
    requests.set(id, token);
    return token;
  }
  function current(token) {
    if (requests.get(token.id) !== token) return false;
    const record = load(token.id);
    return !!record && (record.sessionId || null) === token.sessionId && tailKey(record) === token.turns;
  }
  function finish(token, result, { tier, effort, agentEnvironment = 'native' }) {
    if (!result?.ok || !current(token)) return result?.ok ? { ...result, stale: true } : result;
    const record = load(token.id);
    const changedProvider = !!(record.sessionProviderId && result.providerId
      && (record.sessionProviderId !== result.providerId
        || Number(record.sessionProviderRevision || 0) !== Number(result.providerRevision || 0)));
    const reset = result.restartRequired || changedProvider;
    const patch = { model: tier, effort: reset ? null : (Object.hasOwn(result, 'effort') ? result.effort || null : effort || null) };
    if (reset) Object.assign(patch, { sessionId: null, sessionModel: null, carryContextOnNextTurn: 'provider',
      sessionProviderId: null, sessionProviderRevision: null, sessionRouteTier: null, sessionAgentEnvironment: null });
    else if (result.applied) Object.assign(patch, { sessionModel: tier,
      sessionProviderId: result.providerId || record.sessionProviderId || null,
      sessionProviderRevision: result.providerRevision ?? record.sessionProviderRevision ?? 0,
      sessionRouteTier: result.routeTier || tier, sessionAgentEnvironment: result.agentEnvironment || agentEnvironment });
    if (record.model !== tier || reset) patch.contextUsage = null;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null && !['model', 'effort', 'sessionId', 'sessionModel'].includes(key)) delete record[key];
      else record[key] = value;
    }
    persist(record); // Intentionally preserve updatedAt: this is metadata only.
    return { ...result, effort: patch.effort, runtimePatch: patch };
  }
  function run(token, operation) {
    const previous = controls.get(token.id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => current(token) ? operation() : { ok: true, stale: true });
    controls.set(token.id, pending);
    const cleanup = () => { if (controls.get(token.id) === pending) controls.delete(token.id); };
    pending.then(cleanup, cleanup);
    return pending;
  }
  return { begin, current, finish, run };
}

// A final answer is a mutation of one identified turn, never a renderer snapshot
// replacement. All reads and the write are synchronous in the main process.
function completeConversationTurn({ load, persist }, id, runId, turnTs, payload = {}) {
  const record = load(id);
  if (!record || !Array.isArray(record.turns)) throw fail('TURN_NOT_FOUND', '找不到这条会话的原始消息，回复尚未写回。');
  if (!runId || !turnTs) throw fail('TURN_IDENTITY_REQUIRED', '回复缺少原始任务标识或消息时间。');
  const matches = record.turns.map((turn, index) => ({ turn, index })).filter(({ turn }) => turn?.runId === runId);
  if (matches.length !== 1 || matches[0].turn.ts !== turnTs) throw fail('TURN_IDENTITY_MISMATCH', '回复与历史消息不匹配，已阻止覆盖其他轮次。');
  const { turn, index } = matches[0];
  if (payload.retryWithoutResume) {
    if (turn.assistant || turn.status === 'complete' || index !== record.turns.length - 1) {
      throw fail('TURN_RETRY_CONFLICT', '这条消息已有回复或后续消息，不能自动重试覆盖。');
    }
    record.turns.splice(index, 1);
    record.sessionId = null;
  } else {
    if (!payload.turn || typeof payload.turn !== 'object') throw fail('TURN_OUTCOME_REQUIRED', '没有可保存的回复。');
    for (const key of outcomeKeys) if (Object.hasOwn(payload.turn, key) && payload.turn[key] !== undefined) turn[key] = clone(payload.turn[key]);
    // A recovered old result must not restore an old session over a newer turn.
    if (index === record.turns.length - 1) {
      for (const key of sessionKeys) if (Object.hasOwn(payload.session || {}, key)) record[key] = payload.session[key];
      if (payload.paused) record.paused = clone(payload.paused);
      if (payload.clearPausedRunId && record.paused?.runId === payload.clearPausedRunId) delete record.paused;
      if (payload.clearCarryContextReason && record.carryContextOnNextTurn === payload.clearCarryContextReason) delete record.carryContextOnNextTurn;
    }
    const finished = turn.assistantTs || (Number.isFinite(turn.taskRun?.segmentFinishedAt) ? new Date(turn.taskRun.segmentFinishedAt).toISOString() : null);
    if (finished && (!record.updatedAt || finished > record.updatedAt)) record.updatedAt = finished;
  }
  persist(record);
  return { ok: true, id: record.id, updatedAt: record.updatedAt, conversation: record };
}

module.exports = { createRuntimeMetadataWriter, completeConversationTurn };
