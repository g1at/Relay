'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateError, errorCategory } = require('../src/main/sdk/sdk-error-categories');

test('compaction breaker uses actionable context diagnosis for SDK assistant failures', () => {
  const event = { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request',
    message: { content: [{ type: 'text', text: 'Autocompact is thrashing: the context refilled to the limit within 3 turns.' }] } };
  const result = annotateError(event);
  assert.equal(result.relay_error_category, 'context_compaction_loop');
  assert.match(result.relay_error_description, /工具定义/);
  assert.match(result.relay_error_suggestion, /保留历史/);
  assert.doesNotMatch(result.relay_error_suggestion, /clear|清空|删除/);
  assert.equal(result.message, event.message);
});

test('terminal reason identifies the breaker even when result text is missing', () => {
  const result = annotateError({ type: 'result', subtype: 'error_during_execution', is_error: true,
    terminal_reason: 'rapid_refill_breaker' });
  assert.equal(result.relay_error_category, 'context_compaction_loop');
  assert.equal(errorCategory('autocompact_thrashing'), 'context_compaction_loop');
});

test('successful explanations and status notices never become compaction errors', () => {
  for (const event of [
    { type: 'result', subtype: 'success', is_error: false, result: 'Autocompact is thrashing was fixed.' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Autocompact is thrashing means repeated compression.' }] } },
    { type: 'system', subtype: 'compact_boundary', error: 'rapid_refill_breaker' },
  ]) assert.equal(annotateError(event).relay_error_category, undefined);
});

test('ordinary context pressure is not misclassified as repeated compression', () => {
  assert.equal(errorCategory('context length exceeded'), null);
  assert.equal(errorCategory('compacting context'), null);
});
