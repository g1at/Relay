'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = require('../renderer/assistant-output');
const localWindow = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8'))(localWindow);
const activity = localWindow.RelayActivity;

function runEvents(events) {
  const text = output.createState(), process = activity.createState();
  for (const event of events) {
    output.ingest(text, event);
    activity.ingest(process, { ...event, presentation_order: text.eventOrder });
    process.items = output.mergeActivityItems(process.items, output.processItems(text));
  }
  return { text, process };
}
const full = (id, content) => ({ type: 'assistant', message: { id, content } });
const text = (value) => ({ type: 'text', text: value });
const tool = (id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: 'example.txt' } });

test('prose and real tools interleave by original block order, including one mixed complete message', () => {
  for (const events of [[full('one', [text('first')]), full('two', [tool('read')]), full('three', [text('after')])], [full('mixed', [text('first'), tool('read'), text('after')])]]) {
    const { text: state, process } = runEvents(events);
    assert.deepEqual(process.items.map((item) => item.type), ['narration', 'tool', 'narration']);
    assert.deepEqual(process.items.filter((item) => item.type === 'narration').map((item) => item.result), ['first', 'after']);
    const restored = output.createState(output.serialize(state));
    const restoredActivity = activity.hydrate(activity.serialize(process));
    restoredActivity.items = output.mergeActivityItems(restoredActivity.items, output.processItems(restored));
    assert.deepEqual(restoredActivity.items.map((item) => item.type), ['narration', 'tool', 'narration']);
  }
});

test('narration renders as prose while actual thinking stays behind its compact detail control', () => {
  const narration = activity.renderItem({ id: 'n', type: 'narration', result: 'visible progress' }, false);
  assert.match(narration, /conversation-narration body/);
  assert.match(narration, /visible progress/);
  assert.doesNotMatch(narration, /process-inspector|执行过程/);
  const thinking = activity.renderItem({ id: 't', type: 'thinking', title: 'PRIVATE_THINKING', status: 'running' }, false);
  const [summary, detail] = thinking.split('<div class="process-inspector">');
  assert.match(summary, /正在思考/); assert.doesNotMatch(summary, /PRIVATE_THINKING/);
  assert.match(detail, /PRIVATE_THINKING/); assert.match(summary, /aria-expanded="false"/);
});

test('partial protocol openers do not flash in visible prose, and complete protocol becomes a diagnostic', () => {
  const state = output.createState();
  const delta = (value) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } });
  output.ingest(state, delta('Visible update\n<tool'));
  assert.equal(output.processItems(state)[0].displayText, 'Visible update\n');
  output.ingest(state, delta('_call><function=Read>example</function></tool_call>'));
  const item = output.processItems(state)[0];
  assert.equal(item.type, 'diagnostic');
  const html = activity.renderItem(item, false);
  assert.doesNotMatch(html.split('<div class="process-inspector">')[0], /&lt;tool_call&gt;/);
  assert.match(html, /&lt;tool_call&gt;/);
});

test('promotion removes the final message from the process stream and preserves earlier progress', () => {
  const { text: state, process } = runEvents([full('progress', [text('working')]), full('tool', [tool('read')]), full('final', [text('answer')])]);
  output.finish(state, { exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: 'answer' } });
  process.items = output.mergeActivityItems(process.items, output.processItems(state));
  assert.equal(state.final, 'answer');
  assert.deepEqual(process.items.map((item) => item.type), ['narration', 'tool']);
  assert.equal(process.items[0].result, 'working');
});
