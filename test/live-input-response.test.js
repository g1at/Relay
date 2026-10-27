'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveInputResponse } = require('../src/main/live/live-input-response');

test('only a matching top-level native response releases an input waiter', async () => {
  const gate = new LiveInputResponse(), controller = new AbortController();
  let completed = false;
  const pending = gate.wait('current', { signal: controller.signal }).then(value => { completed = true; return value; });
  for (const event of [
    { type: 'user', uuid: 'current', user_message_uuid: 'current' },
    { type: 'system', subtype: 'init', user_message_uuid: 'current' },
    { type: 'command_lifecycle', state: 'started', command_uuid: 'current' },
    { type: 'assistant', user_message_uuid: 'previous' },
    { type: 'assistant' },
    { type: 'stream_event', user_message_uuid: 'current', event: { type: 'content_block_delta' } },
    ...['parent_tool_use_id', 'parentToolUseId', 'agent_id', 'subagent_type'].map(key => ({ type: 'assistant', user_message_uuid: 'current', [key]: 'child' })),
  ]) gate.observe(event);
  await Promise.resolve();
  assert.equal(completed, false);
  gate.observe({ type: 'stream_event', user_message_uuid: 'current', event: { type: 'message_start' } });
  assert.equal(await pending, true);
  assert.equal(gate.waiters.size, 0);
});

test('coalesced native response IDs release only the inputs they explicitly identify', async () => {
  const gate = new LiveInputResponse(), controller = new AbortController();
  const first = gate.wait('a'), duplicate = gate.wait('a'), second = gate.wait('b');
  let thirdDone = false;
  const third = gate.wait('c', { signal: controller.signal }).then(value => { thirdDone = true; return value; });
  gate.observe({ type: 'assistant', user_message_uuid: 'foreign', user_message_uuids: ['a', 'b', 'a', null] });
  assert.deepEqual(await Promise.all([first, duplicate, second]), [true, true, true]);
  assert.equal(thirdDone, false);
  controller.abort(); assert.equal(await third, false); assert.equal(gate.waiters.size, 0);
});

test('aborted and timed out waits do not revive after late native responses', async () => {
  const gate = new LiveInputResponse(), controller = new AbortController();
  const aborted = gate.wait('aborted', { signal: controller.signal });
  controller.abort(); assert.equal(await aborted, false);
  assert.equal(await gate.wait('timeout', { timeoutMs: 5 }), false);
  gate.observe({ type: 'result', user_message_uuids: ['aborted', 'timeout'] });
  assert.equal(gate.waiters.size, 0);
  assert.equal(await gate.wait('already-aborted', { signal: controller.signal }), false);
});

test('interrupt cancels pending waits but later inputs can still receive responses', async () => {
  const gate = new LiveInputResponse(), old = gate.wait('old');
  gate.cancel(); assert.equal(await old, false);
  const next = gate.wait('next'); gate.observe({ type: 'result', user_message_uuid: 'next' });
  assert.equal(await next, true);
});

test('closing a native session releases all waits and rejects future waiting without timers', async () => {
  const gate = new LiveInputResponse(), first = gate.wait('a'), second = gate.wait('b');
  gate.close(); assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await gate.wait('next'), false); assert.equal(gate.waiters.size, 0);
});
