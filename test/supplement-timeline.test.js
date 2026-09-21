'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Output = require('../renderer/assistant-output');
const Timeline = require('../renderer/supplement-timeline');
const marked = require('../renderer/vendor/marked.umd');
const stream = (state, type, extra = {}) => Output.ingest(state, { type: 'stream_event', event: { type, ...extra } });
const text = (state, value, index = 0) => stream(state, 'content_block_delta', { index, delta: { type: 'text_delta', text: value } });
const input = (state, id) => ({ id, text: 'supplement ' + id, presentation: Timeline.capture(state), status: 'queued' });
const plan = (output, supplements, extra = {}) => Timeline.plan({ output, supplements,
  activityItems: Output.processItems(output, { includeChildren: true }), ...extra });

test('captures a bounded root cursor; untrusted metadata is rejected and copied', () => {
  assert.deepEqual(Timeline.capture(Output.createState()), { version: 1, order: 0, messageId: null, textLength: 0 });
  const valid = { version: 1, order: 3, messageId: 'message', textLength: 6, ignored: 'discard' };
  assert.deepEqual(Timeline.normalize(valid), { version: 1, order: 3, messageId: 'message', textLength: 6 });
  for (const patch of [{ version: 2 }, { order: -1 }, { order: Infinity }, { order: 1.5 },
    { textLength: -1 }, { textLength: 100000001 }, { messageId: '' }, { messageId: 'x\ny' }, { messageId: {} }, { messageId: 'm'.repeat(201) }]) {
    assert.equal(Timeline.normalize({ ...valid, ...patch }), null);
  }
  assert.equal(Timeline.normalize(Object.assign([], valid)), null);
  assert.equal(Timeline.normalize(Object.assign(Object.create({ custom: true }), valid)), null);
  assert.equal(Timeline.normalize(Object.assign(Object.create(null), valid)).messageId, 'message');
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'root' } }); text(state, 'before');
  Output.ingest(state, { type: 'assistant', parent_tool_use_id: 'child-tool', message: { id: 'child', content: [{ type: 'text', text: 'child content' }] } });
  assert.equal(Timeline.capture(state).messageId, 'root');
  assert.equal(Timeline.capture(state).textLength, 6);
});

test('same streamed assistant message splits at send position across repeated supplements', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'answer' } }); text(state, 'before');
  const first = input(state, 'one');
  text(state, ' middle'); const second = input(state, 'two'); text(state, ' after');
  const snapshot = JSON.stringify(Output.serialize(state));
  const sections = plan(state, [first, second]);
  assert.deepEqual(sections.map(section => section.text), ['', '', '']);
  assert.deepEqual(sections.map(section => section.items.map(item => item.result).join('')), ['before', ' middle', ' after']);
  assert.deepEqual(sections.map(section => section.key), ['start', 'after:one', 'after:two']);
  assert.deepEqual(sections.map(section => section.inputAfter && section.inputAfter.id), ['one', 'two', null]);
  assert.deepEqual(sections.map(section => [section.segment, section.isLatest, section.isPrevious]),
    [['previous', false, true], ['previous', false, true], ['current', true, false]]);
  assert.equal(sections.flatMap(section => section.items).length, 3, 'all live text remains in process at its send-time position');
  assert.equal(JSON.stringify(Output.serialize(state)), snapshot, 'presentation does not change output');
});

test('SDK stage closure leaves narration before new work and marks only the last segment current', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'stage' } }); text(state, 'stage body');
  Output.ingest(state, { type: 'result', subtype: 'success', result: 'stage body' });
  const child = { id: 'child', type: 'task', order: state.eventOrder + 1, status: 'running' };
  let sections = plan(state, [], { activityItems: Output.mergeActivityItems([child], Output.processItems(state)) });
  assert.equal(sections[0].text, '');
  assert.deepEqual(sections[0].items.map(item => item.result || item.id), ['stage body', 'child']);
  assert.equal(sections[0].segment, 'current');
  const first = input(state, 'one');
  sections = plan(state, [first], { activityItems: Output.mergeActivityItems([child], Output.processItems(state)) });
  assert.equal(sections[0].items[0].result, 'stage body');
  assert.equal(sections[0].segment, 'previous');
  assert.equal(sections[1].items[0], child);
  assert.equal(sections[1].items[0].status, 'running');
  assert.equal(sections[1].segment, 'current');
  assert.equal(state.status, 'running');
  assert.equal(state.final, '');
});

test('tool started before input retains its segment when its result arrives afterwards', () => {
  const state = Output.createState(); stream(state, 'message_start', { message: { id: 'm' } });
  const first = input(state, 'one');
  const before = { id: 'read', type: 'tool', order: state.eventOrder + 0.001, status: 'running' };
  stream(state, 'message_stop');
  const after = { id: 'write', type: 'tool', order: state.eventOrder, status: 'success' };
  let sections = plan(state, [first], { activityItems: [before, after] });
  assert.deepEqual(sections.map(section => section.items.map(item => item.id)), [['read'], ['write']]);
  before.status = 'success'; before.result = 'read result';
  sections = plan(state, [first], { activityItems: [before, after] });
  assert.equal(sections[0].items[0].result, 'read result');
  assert.equal(sections[0].items[0], before, 'tool identity and inspector state stay reusable');
});

test('a later tool leaves provisional narration on its original side without changing presentation', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'work' } }); text(state, 'first');
  const first = input(state, 'one'); text(state, ' second');
  stream(state, 'content_block_start', { index: 1, content_block: { type: 'tool_use' } });
  const sections = plan(state, [first]);
  assert.deepEqual(sections.map(section => section.items.map(item => item.result)), [['first'], [' second']]);
  assert.deepEqual(sections.map(section => section.text), ['', '']);
  assert.equal(sections[0].items[0].status, 'success');
  assert.equal(sections[1].items[0].status, 'running');
});

test('per-message offsets span separate text blocks without losing or duplicating bytes', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, 'first', 0); text(state, 'middle', 2);
  const first = input(state, 'one'); text(state, 'last', 2);
  stream(state, 'content_block_start', { index: 3, content_block: { type: 'tool_use' } });
  const sections = plan(state, [first]);
  assert.deepEqual(sections.map(section => section.items.map(item => item.result)), [['first', 'middle'], ['last']]);
  assert.equal(sections.flatMap(section => section.items).map(item => item.result).join(''), 'firstmiddlelast');
});

test('confirmed final answer remains canonical and survives serialization and status updates', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, 'first');
  const first = input(state, 'one'); text(state, 'last');
  Output.finish(state, { exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: 'firstlast' } });
  const saved = Output.serialize(state);
  const live = plan(state, [first]);
  const restored = plan(Output.createState(saved), [{ ...first, status: 'applied' }]);
  assert.deepEqual(live.map(section => section.text), ['first', 'last']);
  assert.deepEqual(restored.map(section => section.text), ['first', 'last']);
  assert.equal(state.final, 'firstlast');
  assert.equal(saved.final, 'firstlast');
  assert.equal(live[0].inputAfter, first);
});

test('new final summary is displayed after supplements without guessing streamed offsets', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, 'work'); const first = input(state, 'one');
  Output.finish(state, { exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: 'different final' } });
  const sections = plan(state, [first]);
  assert.deepEqual(sections.map(section => section.text), ['', 'different final']);
  assert.equal(sections[0].items[0].result, 'work');
});

function answerResult(state, text, ids, extra = {}) {
  const event = { type: 'result', subtype: 'success', result: text, user_message_uuids: ids,
    num_turns: 1, terminal_reason: 'completed', ...extra };
  Output.ingest(state, event);
  return event;
}

test('separate confirmed answers remain on both sides of an in-turn question', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'answer-a' } }); text(state, 'first complete answer');
  const question = input(state, 'question-b');
  answerResult(state, 'first complete answer', ['question-a'], { queued_turn_count: 1 });
  stream(state, 'message_start', { message: { id: 'answer-b' } }); text(state, 'second complete answer');
  const terminal = answerResult(state, 'second complete answer', ['question-b']);
  assert.deepEqual(plan(state, [question]).map(segment => segment.text), ['', ''], 'result stages still never flash as final');
  Output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements: [question] });
  const sections = plan(state, [question]);
  assert.deepEqual(sections.map(segment => segment.text), ['first complete answer', 'second complete answer']);
  assert.deepEqual(sections.flatMap(segment => segment.items), [], 'answers are not duplicated in process');
  const restored = plan(Output.createState(Output.serialize(state)), [{ ...question, status: 'applied' }]);
  assert.deepEqual(restored.map(segment => segment.text), sections.map(segment => segment.text));
});

test('two answers in the same post-input segment append instead of replacing the first one', () => {
  const state = Output.createState(), question = input(state, 'question-b');
  stream(state, 'message_start', { message: { id: 'answer-a' } }); text(state, 'first answer');
  answerResult(state, 'first answer', ['question-a']);
  stream(state, 'message_start', { message: { id: 'answer-b' } }); text(state, 'second answer');
  const terminal = answerResult(state, 'second answer', ['question-b']);
  Output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements: [question] });
  assert.deepEqual(plan(state, [question]).map(segment => segment.text), ['', 'first answer\n\nsecond answer']);
  assert.equal(state.final, 'first answer\n\nsecond answer');
});

test('a question inside the first answer preserves every byte and balances both code slices before the second answer', () => {
  const state = Output.createState(), prefix = '```js\nconst first = 1;\n', suffix = 'const last = 2;\n```\n';
  stream(state, 'message_start', { message: { id: 'answer-a' } }); text(state, prefix);
  const question = input(state, 'question-b'); text(state, suffix);
  answerResult(state, prefix + suffix, ['question-a']);
  stream(state, 'message_start', { message: { id: 'answer-b' } }); text(state, '第二题回答');
  const terminal = answerResult(state, '第二题回答', ['question-b']);
  Output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements: [question] });
  const sections = plan(state, [question]);
  assert.deepEqual(sections.map(segment => segment.text), [prefix, suffix + '\n\n第二题回答']);
  assert.equal(sections.map(segment => segment.text).join(''), state.final);
  assert.equal(sections[0].displayText, prefix + '```');
  assert.equal(sections[1].displayText, '```js\n' + suffix + '\n\n第二题回答');
  assert.deepEqual(sections.flatMap(segment => segment.items), []);
});

test('legacy markers preserve compatibility, duplicate receipts do not create sections', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, 'answer');
  const first = { id: 'old', text: 'old input' };
  const sections = plan(state, [first, { ...first, status: 'applied' }, null]);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(section => section.text), ['', '']);
  assert.deepEqual(sections.map(section => section.items.map(item => item.result).join('')), ['', 'answer']);
});

test('diagnostic protocol stays isolated and child process data is never promoted to root output', () => {
  const state = Output.createState();
  const protocol = '<tool_call><function=Read><parameter=file_path>example.txt</parameter></function></tool_call>';
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, protocol.slice(0, 30));
  const first = input(state, 'one'); text(state, protocol.slice(30));
  Output.ingest(state, { type: 'assistant', parent_tool_use_id: 'tool', message: { id: 'child', content: [{ type: 'text', text: 'private child process' }] } });
  const sections = plan(state, [first]);
  assert.deepEqual(sections.map(section => section.text), ['', '']);
  assert.equal(sections[0].items[0].type, 'diagnostic');
  assert.equal(sections[0].items[0].result, protocol);
  assert.equal(sections[1].items[0].result, 'private child process');
});

test('later full-frame corrections and old boundary lengths cannot duplicate text', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'm' } }); text(state, 'long first');
  const first = input(state, 'one'); text(state, ' middle'); const second = input(state, 'two');
  Output.ingest(state, { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'short' }] } });
  const sections = plan(state, [first, second]);
  assert.equal(sections.flatMap(section => section.items).map(item => item.result).join(''), 'short');
});

function splitDocument(document, cuts, process = false) {
  const state = Output.createState({ eventOrder: 10, messages: [{ id: 'document', parent: '', order: 1,
    blocks: [{ index: 0, type: 'text', text: document, full: process }, ...(process ? [{ index: 1, type: 'tool_use' }] : [])] }] });
  const inputs = cuts.map((cut, index) => ({ id: String(index), presentation: {
    version: 1, order: 2 + index, messageId: 'document', textLength: cut,
  } }));
  if (!process) Output.finish(state, { exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: document } });
  return plan(state, inputs);
}

test('fenced code split in the middle retains language and body formatting on both sides', () => {
  const document = 'Intro\n\n```js\nconst a=1;\n```\nDone';
  const sections = splitDocument(document, [document.indexOf('1;')]);
  assert.equal(sections.map(section => section.text).join(''), document);
  const before = marked.lexer(sections[0].displayText);
  const after = marked.lexer(sections[1].displayText);
  assert.equal(before.find(token => token.type === 'code').text, 'const a=');
  assert.equal(after.find(token => token.type === 'code').text, '1;');
  assert.equal(after.find(token => token.type === 'code').lang, 'js');
  assert.equal(after.find(token => token.type === 'paragraph').text, 'Done');
});

test('tilde and longer backtick fences preserve shorter, escaped and nonclosing markers inside code', () => {
  for (const marker of ['~~~~', '`````']) {
    const body = 'one\n```\n\\' + marker + '\n' + marker + ' still code\ntwo\n';
    const document = marker + 'text\n' + body + marker + '\nDone';
    const sections = splitDocument(document, [document.indexOf('two')]);
    const before = marked.lexer(sections[0].displayText).find(token => token.type === 'code');
    const after = marked.lexer(sections[1].displayText);
    assert.ok(before.text.includes('```'));
    assert.ok(before.text.includes('\\' + marker));
    assert.ok(before.text.includes(marker + ' still code'));
    assert.equal(after.find(token => token.type === 'code').text, 'two');
    assert.equal(after.find(token => token.type === 'paragraph').text, 'Done');
    assert.equal(sections.map(section => section.text).join(''), document);
  }
});

test('splitting opener or closer syntax never turns the following prose into code', () => {
  const document = '```javascript\ncode();\n```\nDone';
  for (const cut of [5, document.lastIndexOf('```') + 1, document.lastIndexOf('```')]) {
    const sections = splitDocument(document, [cut]);
    assert.equal(sections.map(section => section.text).join(''), document);
    const tokens = sections.flatMap(section => marked.lexer(section.displayText));
    assert.equal(tokens.filter(token => token.type === 'paragraph').at(-1).text, 'Done');
    assert.equal(tokens.filter(token => token.type === 'code').map(token => token.text).join(''), 'code();');
  }
});

test('already closed, escaped, indented and inline fences do not get a synthetic opening', () => {
  for (const prefix of ['```js\nclosed\n```\n', '\\```js\nplain\n', '    ```js\nplain\n', 'Inline ```js\nplain\n']) {
    const sections = splitDocument(prefix + 'after', [prefix.length]);
    assert.equal(sections[1].displayText, 'after');
    assert.equal(marked.lexer(sections[1].displayText)[0].type, 'paragraph');
  }
});

test('narration uses balanced display code while preserving raw process and legitimate protocol examples', () => {
  const document = '~~~python\nfirst\nsecond\n~~~\nDone';
  const sections = splitDocument(document, [document.indexOf('second')], true);
  const parts = sections.flatMap(section => section.items);
  assert.equal(parts.map(part => part.result).join(''), document);
  const last = marked.lexer(parts[1].displayText);
  assert.equal(last.find(token => token.type === 'code').text, 'second');
  assert.equal(last.find(token => token.type === 'code').lang, 'python');
  assert.equal(last.find(token => token.type === 'paragraph').text, 'Done');
  const example = 'Example:\n<tool_call><function=Read><parameter=file_path>example.txt</parameter></function></tool_call>';
  const exampleParts = splitDocument(example, [9], true).flatMap(section => section.items);
  assert.equal(exampleParts.map(part => part.displayText).join(''), example,
    'splitting an introduced example does not reclassify its suffix as transport protocol');
});

test('a stale preview cannot promote live narration, and current retries follow an in-turn input', () => {
  const state = Output.createState();
  stream(state, 'message_start', { message: { id: 'stage' } }); text(state, 'already visible');
  const first = input(state, 'steer');
  stream(state, 'message_stop');
  const retry = { id: 'relay-api-retry', type: 'status', status: 'running', order: state.eventOrder + 1 };
  const sections = plan(state, [first], {
    preview: { messageId: 'stage', text: 'already visible' },
    activityItems: Output.mergeActivityItems([retry], Output.processItems(state)),
  });
  assert.deepEqual(sections.map(section => section.text), ['', '']);
  assert.equal(sections[0].items[0].result, 'already visible');
  assert.equal(sections[1].items.at(-1), retry);
  assert.equal(state.final, '');
});
