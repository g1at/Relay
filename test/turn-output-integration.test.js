'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeOneShotMessages, sanitizeResultPermissionDenials } = require('../src/main/sdk/claude-sdk');
const output = require('../renderer/assistant-output');

async function consume(events, userMessageId) {
  const state = output.createState();
  const delivered = [];
  async function* source() { yield* events; }
  const terminal = await consumeOneShotMessages(source(), event => {
    delivered.push(event);
    output.ingest(state, event);
    assert.equal(state.final, '', 'a partial SDK result must not publish a final reply');
  }, { userMessageId });
  return { state, terminal, delivered };
}

test('resume notification is excluded before the real reply reaches the presentation layer', async () => {
  const { state, terminal, delivered } = await consume([
    { type: 'system', subtype: 'task_notification', task_id: 'previous-shell', status: 'failed', summary: 'Previous shell completion unavailable' },
    { type: 'result', subtype: 'success', is_error: false, result: '', origin: { kind: 'task-notification' }, num_turns: 0, duration_api_ms: 0, queued_turn_count: 0 },
    { type: 'stream_event', uuid: 'start', user_message_uuid: 'current-send', event: { type: 'message_start', message: { id: 'answer' } } },
    { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', uuid: 'delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The requested summary is ready.' } } },
    { type: 'assistant', uuid: 'full', message: { id: 'answer', content: [{ type: 'text', text: 'The requested summary is ready.' }] } },
    { type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'current-send', result: 'The requested summary is ready.', num_turns: 1, duration_api_ms: 50, queued_turn_count: 0 },
  ], 'current-send');

  assert.equal(delivered.some(event => event.task_id === 'previous-shell'), false);
  assert.equal(delivered.filter(event => event.type === 'result').length, 1);
  assert.equal(output.finish(state, { type: 'job-done', exitCode: 0, finalResult: terminal }), 'The requested summary is ready.');
  assert.equal(output.processItems(state).some(item => item.result === state.final), false);
});

test('owned Agent notification can finish the request while intermediate prose stays in activities', async () => {
  const { state, terminal, delivered } = await consume([
    { type: 'assistant', uuid: 'delegate', user_message_uuid: 'agent-send', message: { id: 'planning', content: [
      { type: 'text', text: 'Checking the supplied example.' },
      { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { description: 'Summarize synthetic data', subagent_type: 'analyst' } },
    ] } },
    { type: 'system', subtype: 'task_started', task_id: 'owned-agent', tool_use_id: 'agent-call', task_type: 'local_agent', subagent_type: 'analyst' },
    { type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'agent-send', result: 'Waiting for the example summary.', queued_turn_count: 0 },
    { type: 'system', subtype: 'task_notification', task_id: 'owned-agent', tool_use_id: 'agent-call', status: 'completed' },
    { type: 'assistant', uuid: 'child', parent_tool_use_id: 'agent-call', message: { id: 'child-message', content: [{ type: 'text', text: 'Internal child detail.' }] } },
    { type: 'assistant', uuid: 'parent-summary', message: { id: 'summary', content: [{ type: 'text', text: 'The example contains three entries.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'The example contains three entries.', origin: { kind: 'task-notification' }, num_turns: 1, duration_api_ms: 30, queued_turn_count: 0 },
  ], 'agent-send');

  assert.equal(delivered.filter(event => event.type === 'result').length, 2);
  assert.equal(output.finish(state, { type: 'job-done', exitCode: 0, finalResult: terminal }), 'The example contains three entries.');
  assert.ok(output.processItems(state).some(item => item.result === 'Checking the supplied example.'));
  assert.equal(output.processItems(state).some(item => item.result === 'Internal child detail.'), false);
  assert.equal(state.final.includes('Waiting'), false);
});

test('permission failure is sanitized and never promotes earlier activity text to the final reply', async () => {
  const { state, terminal } = await consume([
    { type: 'assistant', uuid: 'prepare', user_message_uuid: 'denied-send', message: { id: 'prepare', content: [{ type: 'text', text: 'Preparing the requested update.' }] } },
    { type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'denied-send', result: 'Permission was denied.', permission_denials: [{ tool_name: 'Write', tool_input: { content: 'SYNTHETIC_PRIVATE_INPUT' } }] },
  ], 'denied-send');
  const finalResult = sanitizeResultPermissionDenials(terminal);
  assert.equal(output.finish(state, { type: 'job-done', exitCode: -1, finalResult }), '');
  assert.equal(state.status, 'error');
  assert.doesNotMatch(JSON.stringify(output.serialize(state)), /SYNTHETIC_PRIVATE_INPUT/);
  assert.ok(output.processItems(state).some(item => item.result === 'Preparing the requested update.'));
});
