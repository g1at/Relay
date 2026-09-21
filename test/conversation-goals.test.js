'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previousConversationGoal, protectGoalRecovery } = require('../conversation-goals');
const goalTurn = (user, phase = 'error') => ({ user, executionMode: { kind: 'goal' }, activity: { phase } });

test('failed legacy goals retain the original condition through repeated continue and ignore the current turn', () => {
  const conversation = { turns: [goalTurn('produce fixture summary'), goalTurn('continue'),
    { ...goalTurn('another follow-up'), runId: 'current' }] };
  assert.equal(previousConversationGoal(conversation, 'current'), 'produce fixture summary');
  conversation.turns.splice(2, 0, goalTurn('/goal a different fixture'));
  assert.equal(previousConversationGoal(conversation, 'current'), 'a different fixture');
});

test('completion, ordinary mode and explicit clearing prevent old goal resurrection', () => {
  assert.equal(previousConversationGoal({ turns: [goalTurn('fixture', 'complete')] }), null);
  assert.equal(previousConversationGoal({ turns: [goalTurn('fixture'), { executionMode: { kind: 'default' }, user: 'hello' }] }), null);
  assert.equal(previousConversationGoal({ goalRecovery: null, turns: [goalTurn('old fixture')] }), null);
  assert.equal(previousConversationGoal({ title: 'never infer from a title', turns: [{ user: 'ordinary' }] }), null);
});

test('late renderer saves cannot erase or resurrect the host recovery condition', () => {
  const incoming = { goalRecovery: { condition: 'stale' }, updatedAt: 'unchanged' };
  protectGoalRecovery(incoming, { goalRecovery: { condition: 'current fixture' } });
  assert.deepEqual(incoming, { goalRecovery: { condition: 'current fixture' }, updatedAt: 'unchanged' });
  protectGoalRecovery(incoming, { goalRecovery: null });
  assert.equal(incoming.goalRecovery, null);
  protectGoalRecovery(incoming, {});
  assert.equal(Object.hasOwn(incoming, 'goalRecovery'), false);
});
