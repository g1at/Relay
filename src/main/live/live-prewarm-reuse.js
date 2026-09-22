'use strict';

// A renderer can still request a fresh context after the host has already
// prewarmed that exact replacement. Only an unused, non-resumed Query can
// satisfy that request; an idle Query with earlier input is never equivalent.
function contextBoundaryKey(record) {
  const boundary = record?.sdkContextBoundary;
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  let reset = null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index], output = turn?.output;
    const last = Array.isArray(output?.resets) ? output.resets.at(-1) : null;
    if (Number(output?.contextEpoch || 0) > 0 || last) {
      reset = [turn.runId || index, Number(output.contextEpoch || 0),
        last?.uuid || null, last?.conversationId || null, last?.contextEpoch ?? null];
      break;
    }
  }
  return JSON.stringify([boundary ? [boundary.turnIndex ?? null, boundary.afterRunId || null] : null, reset]);
}

function createPrewarmState(record, { resumed = false, forked = false, epoch = 0 } = {}) {
  if (resumed || forked || record?.pendingSdkFork) return null;
  return { boundary: contextBoundaryKey(record), epoch };
}

function canReuseFreshPrewarm(session, { conversationId, fingerprint, record, routeMatches = false, workspaceAccepts = false } = {}) {
  return !!session && !session.dead && !session.busy && !session.pendingInput
    && session.convId === conversationId && !!session.prewarm
    && session.fingerprint === fingerprint && routeMatches && workspaceAccepts
    && !record?.pendingSdkFork
    && session.prewarm.boundary === contextBoundaryKey(record)
    && session.prewarm.epoch === Number(session.observer?.epoch || 0);
}

module.exports = { contextBoundaryKey, createPrewarmState, canReuseFreshPrewarm };
