'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Output = require('../../../renderer/assistant-output');
const { isValidEpoch } = require('../tasks/task-event-journal');
const ID = /^[0-9a-f][0-9a-f-]{15,63}$/i;
const copy = value => JSON.parse(JSON.stringify(value));
const MISSING_FINAL_NOTICE = '任务已结束，但未取得最终回复。已保留可恢复的执行过程。';
const UNDELIVERED_NOTICE = '有补充要求尚未处理，请查看补充消息的状态。';

function rootResult(event) {
  return event?.type === 'result'
    && !event.parent_tool_use_id && !event.parentToolUseId && !event.agent_id && !event.subagent_type
    && (event.num_turns == null || Number(event.num_turns) > 0);
}

function rootSuccess(event) {
  return rootResult(event) && event.subtype === 'success' && event.is_error !== true
    && !(Array.isArray(event.permission_denials) && event.permission_denials.length)
    && !/^aborted_(streaming|tools)$/.test(String(event.terminal_reason || ''));
}

// Old versions could emit a confirmed receipt but fail to save it on Windows.
// A result's explicit consumed-input list proves delivery even when execution
// subsequently failed or was stopped. It does not prove the request was finished.
// Terminal task state, user echoes and renderer labels are not receipt evidence.
function recoverSupplementReceipts(turn, events = [turn?.output?.lastResult]) {
  if (!turn?.runId || !Array.isArray(turn.supplements)) return false;
  const consumed = new Set(), explicit = new Set();
  for (const event of events) {
    if (!rootResult(event) || event.jobId !== turn.runId) continue;
    for (const id of Array.isArray(event.user_message_uuids) ? event.user_message_uuids : []) {
      if (typeof id === 'string') { consumed.add(id); explicit.add(id); }
    }
    if (rootSuccess(event) && typeof event.user_message_uuid === 'string') consumed.add(event.user_message_uuid);
  }
  let changed = false;
  for (const input of turn.supplements) {
    if (!input || !consumed.has(input.id) || !(input.status === 'queued'
        || ['canceled', 'rejected'].includes(input.status) && explicit.has(input.id))) continue;
    input.status = 'applied'; changed = true;
  }
  return changed;
}

function canRecoverEmptyFinal(turn) {
  const output = turn?.output, result = output?.lastResult;
  return turn?.status === 'complete' && !turn.error && output?.status === 'complete'
    && !String(turn.assistant || '').trim() && !String(output.final || '').trim()
    && !!turn.runId && result?.jobId === turn.runId && rootSuccess(result)
    && !Number(result.queued_turn_count || 0) && !String(result.result || '').trim()
    // Older writers did not mark partially retracted messages. Their retained
    // blocks cannot prove the last answer is still complete.
    && !(output.retractedMessageUuids || []).length
    && typeof output.revision === 'number' && output.resultRevision === output.revision;
}

// Project the already saved terminal root answer using the same provenance
// checks as live output. This reads no journals and never writes history or
// changes its activity time. In particular, do not invent a missing current
// message pointer or promote an earlier stage after a retraction/reset.
function recoverEmptyFinal(turn) {
  const state = Output.createState(turn.output);
  const answer = Output.finish(state, { exitCode: 0 }, { supplements: turn.supplements });
  if (!answer) return false;
  turn.assistant = answer;
  turn.output = Output.serialize(state);
  return true;
}

// Old versions turned any accumulated permission denial into a terminal error,
// even after a completed SDK answer. Recover only that exact saved mismatch;
// never infer success from tool output or overwrite a different failure.
function deniedFinalCandidate(turn) {
  const output = turn?.output, result = output?.lastResult;
  const denials = result?.permission_denials;
  if (!['error', 'failed'].includes(turn?.status) || output?.status !== 'error'
      || !ID.test(turn.runId || '') || result?.jobId !== turn.runId
      || !rootResult(result) || result.subtype !== 'success' || result.is_error !== false
      || result.terminal_reason !== 'completed' || result.stop_reason !== 'end_turn'
      || !(Number(result.num_turns) > 0) || !result.uuid
      || !Array.isArray(denials) || !denials.length
      || (result.errors || []).length || result.error || result.aborted
      || Number(result.queued_turn_count || 0) || Number(result.relay_pending_inputs || 0)
      || Number(result.relay_pending_background_tasks || 0)
      || typeof output.revision !== 'number' || output.resultRevision !== output.revision
      || (output.retractedMessageUuids || []).length
      || String(turn.assistant || output.final || '').trim()
      || typeof result.result !== 'string' || !result.result.trim()
      || Output.splitProtocol(result.result).diagnostics.length) return false;
  const names = [...new Set(denials.map(item => String(item?.tool_name || item?.toolName || '')
    .replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 12).map(name => name.slice(0, 120));
  const error = `工具权限被拒绝（${denials.length} 次）${names.length ? `：${names.join('、')}` : ''}`;
  return turn.error === error && (!turn.activity?.error || turn.activity.error === error);
}

function createLegacyOutputRecovery({ fileSystem = fs, now = Date.now } = {}) {
  // Store only matching results, never a whole journal or conversation. Positive
  // entries are immutable after job-done; misses expire so delayed flushes recover.
  const cache = new Map();
  let cacheBytes = 0;
  function recoverDeniedFinal(turn, conversationId, rootDir) {
    if (!rootDir || !ID.test(conversationId || '') || !deniedFinalCandidate(turn)) return false;
    try {
      const run = JSON.parse(fileSystem.readFileSync(path.join(rootDir, 'runs', `${turn.runId}.json`), 'utf8'));
      const result = turn.output.lastResult;
      if (run.runId !== turn.runId || run.source?.conversationId !== conversationId
          || run.state !== 'failed' || run.result?.error !== turn.error
          || run.result?.sdk?.terminalReason !== 'completed'
          || run.result.exitCode != null && Number(run.result.exitCode) !== 0
          || run.result.sdk.userMessageUuid !== result.user_message_uuid
          || run.execution?.sessionId !== result.session_id
          || !run.endedAt || run.cancelRequestedAt) return false;
      const state = Output.createState(turn.output);
      const answer = Output.finish(state, { exitCode: 0, finalResult: result }, { supplements: turn.supplements });
      if (!answer) return false;
      turn.assistant = answer; turn.output = Output.serialize(state);
      turn.error = null; turn.status = 'complete';
      const notices = String(turn.outputNotice || '').split('\n').filter(line => line.trim()
        && line.trim() !== MISSING_FINAL_NOTICE && line.trim() !== state.notice);
      turn.outputNotice = [...notices, state.notice].filter(Boolean).join('\n');
      if (turn.activity) { turn.activity.error = null; turn.activity.phase = 'complete'; }
      return true;
    } catch (_) { return false; }
  }
  function remember(key, events, settled) {
    const bytes = Buffer.byteLength(JSON.stringify(events));
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    if (bytes > 4 * 1024 * 1024) return;
    while (cache.size >= 64 || cacheBytes + bytes > 4 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    cache.set(key, { events, bytes, expires: settled ? Infinity : now() + 30000 });
    cacheBytes += bytes;
  }
  function resultsFor(rootDir, conversationId, turn) {
    if (!ID.test(conversationId) || !ID.test(turn.runId)) return [];
    const key = JSON.stringify([rootDir, conversationId, turn.runId, turn.output?.contextEpoch, turn.output?.lastResult?.uuid]);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.events;
    let events = [], settled = false;
    try {
      const run = JSON.parse(fileSystem.readFileSync(path.join(rootDir, 'runs', `${turn.runId}.json`), 'utf8'));
      const epoch = run?.execution?.appInstanceId;
      if (run.runId !== turn.runId || run.source?.conversationId !== conversationId
          || run.state !== 'succeeded' || !isValidEpoch(epoch)) throw Error('unavailable run');
      const file = path.join(rootDir, 'stream-events', 'epochs', `${epoch}.jsonl`);
      const size = fileSystem.statSync(file).size;
      if (size > 64 * 1024 * 1024) throw Error('oversized journal');
      const acceptedIds = new Set([turn.runId, ...turn.supplements.map(input => input?.id).filter(Boolean)]);
      const activeSessionId = turn.output?.lastResult?.session_id;
      for (const line of fileSystem.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes(turn.runId)) continue;
        let envelope;
        try { envelope = JSON.parse(line); } catch (_) { throw Error('invalid run journal'); }
        if (envelope.epoch !== epoch || envelope.runId !== turn.runId || envelope.type !== 'claude.event') continue;
        const event = envelope.payload?.event;
        if (!event || event.jobId && event.jobId !== turn.runId) continue;
        if (event.type === 'conversation_reset') { events = []; continue; }
        if (event.type === 'job-done') {
          settled = event.exitCode === 0 && !event.error && !event.finalResult?.is_error
            && (!turn.output?.lastResult?.uuid || !event.finalResult?.uuid || event.finalResult.uuid === turn.output.lastResult.uuid);
          break;
        }
        if (!rootSuccess(event) || typeof event.result !== 'string') continue;
        if (activeSessionId && event.session_id && event.session_id !== activeSessionId) continue;
        const ids = [...new Set([event.user_message_uuid, ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])])];
        if (!ids.some(id => acceptedIds.has(id))) continue;
        const group = JSON.stringify((Array.isArray(event.user_message_uuids)
          ? [...new Set(event.user_message_uuids)] : [event.user_message_uuid]).filter(id => typeof id === 'string').sort());
        events = events.filter(previous => previous.group !== group);
        // The result API validates protocol text/retractions and exact matching
        // output messages. Keep only its inputs and the scope/receipt evidence.
        events.push({ type: 'result', subtype: 'success', jobId: turn.runId, group,
          uuid: event.uuid, session_id: event.session_id, result: event.result,
          user_message_uuid: event.user_message_uuid,
          ...(Array.isArray(event.user_message_uuids) ? { user_message_uuids: event.user_message_uuids } : {}),
          terminal_reason: event.terminal_reason, stop_reason: event.stop_reason,
          queued_turn_count: event.queued_turn_count, num_turns: event.num_turns, origin: event.origin,
        });
        if (events.length > 201) events.shift();
      }
    } catch (_) { events = []; settled = false; }
    // A truncated stream cannot prove the full set of answers was delivered.
    if (!settled) events = [];
    remember(key, events, settled);
    return events;
  }

  return function recover(conversation, { rootDir } = {}) {
    if (!conversation || !Array.isArray(conversation.turns)) return conversation;
    let recovered = conversation;
    for (let index = 0; index < conversation.turns.length; index++) {
      const original = conversation.turns[index];
      if (!['complete', 'error', 'failed', 'canceled', 'paused', 'interrupted'].includes(original?.status)) continue;
      const emptyFinal = canRecoverEmptyFinal(original);
      const deniedFinal = deniedFinalCandidate(original);
      const legacySupplements = original.status === 'complete' && original.supplements?.length && Number(original.output?.version || 0) < 5;
      const missingReceipts = original.supplements?.some(input => ['queued', 'canceled', 'rejected'].includes(input?.status));
      if (!emptyFinal && !legacySupplements && !missingReceipts && !deniedFinal) continue;
      const turn = copy(original);
      let changed = recoverDeniedFinal(turn, conversation.id, rootDir);
      changed = recoverSupplementReceipts(turn) || changed;
      if (legacySupplements && turn.output && Number(turn.output.version || 0) < 5 && rootDir && typeof Output.recordResultEvidence === 'function') {
        const events = resultsFor(rootDir, conversation.id, turn);
        changed = recoverSupplementReceipts(turn, events) || changed;
        if (events.length && (String(turn.output.lastResult?.result || '').trim() || emptyFinal)) {
          const state = Output.createState(turn.output);
          for (const event of events) {
            const matches = state.messages.filter(message => !message.parent && !message.aborted
              && Number(message.contextEpoch || 0) === state.contextEpoch && Output.textFor(message) === event.result);
            // v4 did not preserve input ownership on every message. Equal prose
            // in different replies is insufficient evidence to guess its owner;
            // likewise do not resurrect prose removed by a recorded retraction.
            if (matches.length > 1 || !matches.length && state.retractedMessageUuids.length) continue;
            Output.recordResultEvidence(state, event);
          }
          const answer = Output.finish(state, { exitCode: 0, finalResult: turn.output.lastResult }, { supplements: turn.supplements });
          if (answer) {
            turn.assistant = answer;
            turn.output = Output.serialize(state);
            changed = true;
          }
        }
      }
      if (emptyFinal && !String(turn.assistant || '').trim()) changed = recoverEmptyFinal(turn) || changed;
      if (!changed) continue;
      if (turn.supplements?.length && turn.supplements.every(input => input?.status === 'applied') && typeof turn.outputNotice === 'string') {
        turn.outputNotice = turn.outputNotice.split('\n').filter(line => line.trim() !== UNDELIVERED_NOTICE).join('\n');
      }
      if (original.status === 'complete' && String(turn.assistant || '').trim() && typeof turn.outputNotice === 'string') {
        turn.outputNotice = turn.outputNotice.split('\n').filter(line => line.trim() !== MISSING_FINAL_NOTICE).join('\n');
      }
      if (recovered === conversation) recovered = { ...conversation, turns: [...conversation.turns] };
      recovered.turns[index] = turn;
    }
    return recovered;
  };
}

module.exports = { createLegacyOutputRecovery, recoverSupplementReceipts };
