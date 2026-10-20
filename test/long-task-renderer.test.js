'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, stream, full, result } = require('./renderer-activity-harness.cjs');
function thinking(h) {
  h.send(stream({ type: 'message_start', message: { id: 'long-task' } }));
  h.send(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
}
const delta = value => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: value } });

test('a long thinking burst ingests every byte and coalesces activity rendering with output rendering', () => {
  const h = harness('plain', { mounted: true });
  thinking(h);
  for (let i = 0; i < 2000; i++) h.send(delta('progress '));
  assert.equal(h.run.activityState.items.find(item => item.type === 'thinking').title, 'progress '.repeat(2000));
  assert.equal(h.updates.length, 0, 'no synchronous transcript walk for each delta');
  assert.equal(h.timers.size, 1, 'one shared presentation timer');
  h.flush();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].force, true);
  assert.equal(h.timers.size, 0);
});

test('offscreen runs preserve events without repeatedly projecting invisible history', () => {
  const h = harness('plain', { mounted: false });
  thinking(h);
  for (let i = 0; i < 500; i++) h.send(delta('background '));
  h.send(full('background-prose', 'Retained background output'));
  assert.equal(h.timers.size, 0);
  assert.equal(h.updates.length, 0);
  h.flush();
  assert.equal(h.run.activityState.items.find(item => item.type === 'thinking').title, 'background '.repeat(500));
  assert.ok(h.run.activityState.items.some(item => item.result === 'Retained background output'));
});

test('queued presentation cannot repaint a switched or replaced conversation', () => {
  const h = harness('plain', { mounted: true });
  thinking(h); h.send(delta('retained'));
  const callback = h.timers.values().next().value;
  h.context.isMountedChatJob = () => false;
  callback();
  assert.equal(h.updates.length, 0);
  h.context.isMountedChatJob = () => true;
  h.flush();
  assert.equal(h.updates.length, 1);
  h.send(delta(' more'));
  const late = [...h.timers.values()].at(-1);
  h.context.runs.delete('conv');
  late();
  assert.equal(h.updates.length, 1);
});

test('a terminal result flushes pending presentation without waiting for the stream timer', () => {
  const h = harness('plain', { mounted: true });
  thinking(h); h.send(delta('complete thought'));
  assert.equal(h.updates.length, 0);
  h.send(result('final answer'));
  assert.equal(h.timers.size, 0);
  assert.equal(h.updates.length, 1);
  assert.equal(h.run.activityState.items.find(item => item.type === 'thinking').title, 'complete thought');
});

test('long output projection indexes child ownership while preserving receipt de-duplication', () => {
  const h = harness();
  const messages = Array.from({ length: 1500 }, (_, index) => ({ id: 'root-' + index, parent: '', blocks: [{ index: 0, type: 'text', text: 'root text ' + index, full: true }], order: index, settled: true }));
  messages.push({ id: 'child:with:colon', parent: 'parent:tool', blocks: [{ index: 3, type: 'text', text: 'child retained text', full: true }], order: 1501, settled: true });
  messages.find = () => { throw Error('quadratic per-row message search'); };
  const output = h.output.createState(); output.messages = messages;
  const receipts = [{ id: 'tool', type: 'tool', toolUseId: 'parent:tool', result: 'receipt child retained text end' }];
  const merged = h.context.activityOutputItems(output, receipts);
  assert.equal(merged.length, 1500);
  assert.equal(merged[0].result, 'root text 0');
  assert.equal(merged.at(-1).result, 'root text 1499');
  assert.equal(h.context.activityOutputItems(output, []).at(-1).result, 'child retained text');
});
