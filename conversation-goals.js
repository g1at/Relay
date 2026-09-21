'use strict';

function condition(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 4000 ? text : null;
}

// The host owns this recovery metadata. A late renderer history save cannot
// forget a failed goal or resurrect one the user explicitly cleared.
function protectGoalRecovery(incoming, saved) {
  if (saved && Object.hasOwn(saved, 'goalRecovery')) {
    const value = condition(saved.goalRecovery?.condition);
    incoming.goalRecovery = value ? { condition: value } : null;
  } else delete incoming.goalRecovery;
}

function previousConversationGoal(conversation, runId) {
  if (!conversation) return null;
  if (Object.hasOwn(conversation, 'goalRecovery')) return condition(conversation.goalRecovery?.condition);
  // Older Relay versions stored the mode per turn but no separate condition.
  // Recover only a contiguous, unfinished goal sequence; never guess from a
  // title or from an ordinary conversation. Exclude the newly appended turn.
  let candidate = null;
  for (const turn of conversation.turns || []) {
    if (runId && turn.runId === runId) break;
    if (turn.executionMode?.kind !== 'goal') { candidate = null; continue; }
    const explicit = /^\s*\/goal\s+/i.test(turn.user || '');
    const input = condition(String(turn.user || '').replace(/^\s*\/goal\s+/i, ''));
    if (!candidate || explicit) candidate = input;
    if (turn.activity?.phase === 'complete' && !turn.activity?.error) candidate = null;
  }
  return candidate;
}

module.exports = { condition, protectGoalRecovery, previousConversationGoal };
