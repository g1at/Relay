'use strict';

const { createDeliveryRegistry } = require('../tasks/turn-deliverables');
const { TaskClock } = require('../tasks/task-clock');
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);

function matchingTurn(record, runId, turnTs) {
  const matches = (record?.turns || []).filter(turn => turn?.runId === runId);
  return matches.length === 1 && matches[0].ts === turnTs ? matches[0] : null;
}
function validSnapshot(value, conversationId, turn) {
  return value?.version === 1 && value.conversationId === conversationId
    && value.runId === turn?.runId && value.turnTs === turn?.ts && Array.isArray(value.items);
}

// Presentation snapshots cannot erase or forge the host's verified file list.
// Forks do not acquire the source conversation's delivery ownership implicitly.
function protectTurnDeliverables(record, existing) {
  for (const turn of record?.turns || []) {
    if (!turn || typeof turn !== 'object') continue;
    const saved = matchingTurn(existing, turn?.runId, turn?.ts);
    if (validSnapshot(saved?.deliverables, record.id, turn)) turn.deliverables = clone(saved.deliverables);
    else delete turn.deliverables;
  }
}

function resultStatus(result) {
  if (/^aborted_/.test(String(result?.terminal_reason || ''))) return 'canceled';
  if (result?.is_error === true || result?.subtype && result.subtype !== 'success'
    || result?.permission_denials?.length) return 'failed';
  return 'complete';
}

function createTurnDeliveryService({ load, persist, canWrite = () => true, emit = () => {},
  onError = () => {}, registry, progress = null, terminalStatus = () => null } = {}) {
  const active = new Map();
  registry ||= createDeliveryRegistry({ onUpdate: value => {
    const state = active.get(value?.runId);
    if (!state || !['running', 'finishing'].includes(value.status)
      || !validSnapshot(value, state.conversationId, { runId: state.runId, ts: state.turnTs })
      || !canWrite(state.conversationId)) return;
    state.snapshot = clone(value);
    // Small, per-conversation progress records survive a crash without rewriting
    // an entire transcript on each tool receipt. The store serializes updates.
    if (progress) void progress.save(value).catch(onError);
    emit({ conversationId: state.conversationId, runId: state.runId, snapshot: clone(value) });
  } });
  async function begin(input) {
    if (!validId(input?.conversationId) || !validId(input?.runId) || !input.turnTs) return null;
    if (active.has(input.runId)) return null;
    const record = load(input.conversationId);
    const turn = matchingTurn(record, input.runId, input.turnTs);
    if (!turn || !canWrite(input.conversationId)) return null;
    const state = { ...input, finalText: '', pending: null, snapshot: null };
    active.set(input.runId, state);
    try {
      const latest = progress ? await hydrate(record) : record;
      if (active.get(input.runId) !== state || !canWrite(input.conversationId)
        || !matchingTurn(latest, input.runId, input.turnTs)) {
        if (active.get(input.runId) === state) active.delete(input.runId);
        return null;
      }
      await registry.begin(input); return state;
    }
    catch (error) { active.delete(input.runId); registry.forget(input.runId); onError(error); return null; }
  }
  async function commit(state, value) {
    if (active.get(state.runId) !== state || !canWrite(state.conversationId)) return null;
    if (!validSnapshot(value, state.conversationId, { runId: state.runId, ts: state.turnTs })) return null;
    if (progress) await progress.save(value).catch(onError);
    if (active.get(state.runId) !== state || !canWrite(state.conversationId)) return null;
    // No await between reading the latest transcript and the narrow write.
    const record = load(state.conversationId), turn = matchingTurn(record, state.runId, state.turnTs);
    if (!turn || !validSnapshot(value, state.conversationId, turn)) return null;
    turn.deliverables = clone(value);
    if (persist(record) === false) return null;
    state.snapshot = value;
    emit({ conversationId: state.conversationId, runId: state.runId, snapshot: clone(value) });
    if (progress) await progress.removeRun(state.conversationId, state.runId).catch(onError);
    return value;
  }
  function finish(runId, status = 'complete') {
    const state = active.get(runId);
    if (!state) return Promise.resolve(null);
    if (state.pending) return state.pending;
    if (status === 'complete') status = resultStatus(state.lastResult);
    state.pending = registry.finish({ runId, status, finalText: state.finalText })
      .then(value => commit(state, value)).catch(error => { onError(error); return null; })
      .finally(() => { if (active.get(runId) === state) active.delete(runId); registry.forget(runId); });
    return state.pending;
  }
  function observe(runId, event) {
    const state = active.get(runId);
    if (!state || state.pending || event?.jobId && event.jobId !== runId) return;
    registry.observe({ runId, event });
    if (!TaskClock.isRootEvent(event)) return;
    if (event.type === 'assistant') {
      const text = (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
      if (text) state.finalText = text;
    }
    if (event.type === 'result') {
      state.lastResult = event;
      if (typeof event.result === 'string' && event.result) state.finalText = event.result;
    }
    if (event.type === 'job-done') {
      if (event.finalResult && TaskClock.isRootEvent(event.finalResult)) {
        state.lastResult = event.finalResult;
        if (typeof event.finalResult.result === 'string' && event.finalResult.result) state.finalText = event.finalResult.result;
      }
      void finish(runId, event.aborted || event.canceled ? 'canceled'
        : event.error || event.exitCode && event.exitCode !== 0 ? 'failed' : 'complete');
    }
  }
  async function hydrate(record) {
    if (!record || !validId(record.id) || !canWrite(record.id)) return record;
    const snapshots = progress ? await progress.read(record.id).catch(error => { onError(error); return []; }) : [];
    if (!canWrite(record.id)) return null;
    // Only the host task ledger can declare a recovered run terminal. A missing
    // local registry entry alone is not proof that its executor has stopped.
    const recovered = snapshots.flatMap(value => {
      if (active.has(value.runId)) return [];
      let status;
      try { status = terminalStatus(record.id, value.runId); }
      catch (error) { onError(error); return []; }
      return ['complete', 'failed', 'canceled', 'interrupted'].includes(status) ? [{ ...value, status }] : [];
    });
    if (recovered.length) try {
      const latest = load(record.id), archived = [];
      if (!latest) return null;
      let changed = false;
      for (const value of recovered) {
        const turn = matchingTurn(latest, value.runId, value.turnTs);
        if (!turn || !validSnapshot(value, record.id, turn)) continue;
        if (!validSnapshot(turn.deliverables, record.id, turn) || ['running', 'finishing'].includes(turn.deliverables.status)) {
          turn.deliverables = { ...clone(value), complete: false,
            warnings: [...new Set([...value.warnings, 'RECOVERED_WITHOUT_FINAL_SCAN'])] };
          changed = true;
        }
        archived.push(value.runId);
      }
      // One narrow write for this conversation, independent of its file count.
      if (canWrite(record.id) && (!changed || persist(latest) !== false)) {
        record = latest || record;
        await Promise.all(archived.map(runId => progress.removeRun(record.id, runId).catch(onError)));
      }
      if (!canWrite(record.id)) return null;
    } catch (error) { onError(error); }
    for (const state of active.values()) if (state.conversationId === record.id && state.snapshot) snapshots.push(state.snapshot);
    for (const value of snapshots) {
      const turn = matchingTurn(record, value?.runId, value?.turnTs);
      if (!turn || !validSnapshot(value, record.id, turn)) continue;
      if (validSnapshot(turn.deliverables, record.id, turn)
        && !['running', 'finishing'].includes(turn.deliverables.status)) continue;
      turn.deliverables = clone(value);
    }
    return record;
  }
  async function get({ conversationId, runId } = {}) {
    if (!validId(conversationId) || !validId(runId) || !canWrite(conversationId)) return { ok: false, snapshot: null };
    const state = active.get(runId);
    if (state?.conversationId === conversationId && state.pending) await state.pending;
    const record = await hydrate(load(conversationId)), matches = (record?.turns || []).filter(turn => turn?.runId === runId);
    if (matches.length !== 1 || !validSnapshot(matches[0].deliverables, conversationId, matches[0])) return { ok: true, snapshot: null };
    return { ok: true, snapshot: clone(matches[0].deliverables) };
  }
  async function forgetConversation(conversationId) {
    for (const [runId, state] of active) if (state.conversationId === conversationId) {
      active.delete(runId); registry.forget(runId);
    }
    if (progress) await progress.removeConversation(conversationId);
  }
  const isActive = (runId, conversationId) => {
    const state = active.get(runId);
    return !!state && state.conversationId === conversationId && !state.pending && canWrite(conversationId);
  };
  return { begin, observe, finish, get, hydrate, forgetConversation, isActive };
}

module.exports = { createTurnDeliveryService, protectTurnDeliverables, matchingTurn, validSnapshot };
