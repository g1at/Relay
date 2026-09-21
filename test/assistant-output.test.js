'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const output = require('../renderer/assistant-output');
const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', result: text, ...extra });
const assistant = (id, text, extra = {}) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, ...extra });
const stream = (type, extra = {}, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type, ...extra } });
const protocol = '<tool_call><function=Read><parameter=file_path>example.txt</parameter></function></tool_call>';

test('SDK transport errors do not appear as repeated model answers or progress text', () => {
  const state = output.createState();
  output.ingest(state, assistant('error-one', 'API Error: 429', { error: 'rate_limit' }));
  output.ingest(state, assistant('error-two', 'API Error: 429', { error: 'rate_limit' }));
  assert.equal(state.messages.length, 0);
  output.ingest(state, assistant('genuine', 'The API returned 429; here is the explanation.'));
  assert.equal(state.messages.length, 1, 'normal model-authored error explanations are preserved');
});

test('provisional text remains process-only; only authoritative terminal result becomes the answer', () => {
  const state = output.createState();
  output.ingest(state, assistant('progress', 'working'));
  output.ingest(state, result('waiting'));
  output.ingest(state, assistant('final', 'finished'));
  assert.equal(state.final, '');
  assert.equal(output.finish(state, { exitCode: 0, finalResult: result('finished') }), 'finished');
  assert.deepEqual(output.processItems(state).map((x) => x.result), ['working', 'waiting']);
});

test('stream and per-block full frames sharing a message id reconcile text-thinking-text without duplication', () => {
  const state = output.createState();
  output.ingest(state, stream('message_start', { message: { id: 'm' } }));
  for (const [index, type, text] of [[0, 'text', 'first'], [1, 'thinking', 'hidden'], [2, 'text', 'last']]) {
    output.ingest(state, stream('content_block_start', { index, content_block: { type, text: '' } }));
    if (type === 'text') output.ingest(state, stream('content_block_delta', { index, delta: { type: 'text_delta', text } }));
    output.ingest(state, stream('content_block_stop', { index }));
    output.ingest(state, { type: 'assistant', uuid: 'full-' + index, message: { id: 'm', content: [{ type, text, thinking: text }] } });
  }
  assert.equal(output.textFor(state.messages[0]), 'firstlast');
  assert.equal(output.finish(state, { exitCode: 0, finalResult: result('firstlast') }), 'firstlast');
});

test('cancellation, terminal errors and missing final evidence never promote process text', () => {
  for (const [done, options] of [[{ exitCode: -1 }, {}], [{ exitCode: 0 }, { aborted: true }], [{ exitCode: 0, finalResult: result('working', { is_error: true, permission_denials: [{}] }) }, {}], [{ exitCode: 0 }, {}]]) {
    const state = output.createState(); output.ingest(state, assistant('m', 'working'));
    assert.equal(output.finish(state, done, options), '');
    assert.equal(output.processItems(state)[0].result, 'working');
  }
});

test('later message starts, tool blocks and thinking invalidate earlier intermediate results', () => {
  for (const later of [stream('message_start', { message: { id: 'later' } }), stream('content_block_start', { index: 0, content_block: { type: 'text', text: 'later' } }), { type: 'assistant', message: { id: 'tool', content: [{ type: 'tool_use', id: 't' }] } }, { type: 'assistant', message: { id: 'think', content: [{ type: 'thinking', thinking: 'x' }] } }]) {
    const state = output.createState(); output.ingest(state, result('waiting')); output.ingest(state, later);
    assert.equal(output.finish(state, { exitCode: 0 }), '');
  }
  const state = output.createState(); output.ingest(state, result('queued', { queued_turn_count: 1 }));
  assert.equal(output.finish(state, { exitCode: 0 }), '');
});

test('parent tool id excludes child text even without optional subagent_type', () => {
  const state = output.createState();
  output.ingest(state, assistant('child', 'child reply', { parent_tool_use_id: 'agent-1' }));
  output.ingest(state, stream('message_start', { message: { id: 'child-stream' } }, 'agent-2'));
  output.ingest(state, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'other child' } }, 'agent-2'));
  assert.deepEqual(output.processItems(state), []);
  assert.equal(output.finish(state, { exitCode: 0, finalResult: result(undefined) }), '');
});

test('protocol text is retained in diagnostic details; mixed real tool blocks do not change that fact', () => {
  const state = output.createState(); output.ingest(state, assistant('m', protocol));
  output.ingest(state, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'real', name: 'Read' }] } });
  assert.equal(output.finish(state, { exitCode: 0, finalResult: result(protocol) }), '');
  const item = output.processItems(state)[0];
  assert.equal(item.type, 'diagnostic'); assert.equal(item.result, protocol);
  assert.doesNotMatch(item.detail, /未执行|<tool_call>/);
});

test('normal XML, inline, fenced, quoted and introduced code examples are preserved', () => {
  for (const text of ['<example><function>Read</function></example>', '说明 `' + protocol + '`。', '```xml\n' + protocol + '\n```', '示例：\n' + protocol, '> ' + protocol, '    ' + protocol]) {
    assert.equal(output.splitProtocol(text).text, text);
    assert.equal(output.splitProtocol(text).diagnostics.length, 0);
  }
  assert.deepEqual(output.splitProtocol('保留原段落\n\n' + protocol).diagnostics, [protocol]);
});

test('long snapshots bound delta IDs while full-frame and streamed block replay remain idempotent', () => {
  const state = output.createState();
  const full = assistant('m', 'A', { uuid: 'full-original' });
  output.ingest(state, full);
  for (let i = 0; i < 1500; i++) output.ingest(state, { type: 'system', uuid: 'noise-' + i });
  const restored = output.createState(output.serialize(state));
  output.ingest(restored, full);
  assert.equal(output.textFor(restored.messages[0]), 'A');
  assert.ok(output.serialize(restored).seen.length <= 1024);
  const streaming = output.createState();
  const events = [stream('message_start', { message: { id: 's' } }), stream('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'B' } }), assistant('s', 'B', { uuid: 'full-stream' })];
  events.forEach((e) => output.ingest(streaming, e));
  const replay = output.createState(output.serialize(streaming)); events.forEach((e) => output.ingest(replay, e));
  assert.equal(output.textFor(replay.messages[0]), 'B');
});

test('fallback requires explicit end_turn and never promotes text from a tool-use message', () => {
  const state = output.createState();
  output.ingest(state, { type: 'assistant', message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 't' }] } });
  assert.equal(output.finish(state, { exitCode: 0, finalResult: result(undefined) }), '');
});

test('empty, whitespace and absent successful result text use the latest completed root answer', () => {
  for (const text of ['', ' \n\t ', undefined]) {
    const state = output.createState();
    output.ingest(state, { type: 'assistant', message: { id: 'earlier', stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier stage' }] } });
    output.ingest(state, { type: 'assistant', uuid: 'final-frame', message: { id: 'final', stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'confirmed answer' },
    ] } });
    output.ingest(state, assistant('child', 'child answer', { parent_tool_use_id: 'agent-tool' }));
    const terminal = result(text, { num_turns: 10, terminal_reason: 'completed', origin: { kind: 'task-notification' } });
    output.ingest(state, terminal);
    assert.equal(output.finish(state, { exitCode: 0, finalResult: terminal }), 'confirmed answer');
    assert.equal(state.finalMessageId, 'final');
    assert.equal(state.notice, '');
    assert.deepEqual(output.processItems(state).map(item => item.result).filter(text => text.trim()), ['earlier stage']);
  }
});

test('a long task notification continuation recovers its empty terminal result after save and replay', () => {
  const state = output.createState();
  for (let index = 0; index < 1500; index++) output.ingest(state, { type: 'system', uuid: 'long-task-' + index });
  const frames = Array.from({ length: 3 }, (_, index) => ({ type: 'assistant', uuid: 'final-frame-' + index,
    message: { id: 'final-' + index, stop_reason: 'end_turn', content: [{ type: 'text', text: 'verified final summary' }] } }));
  frames.forEach(frame => output.ingest(state, frame));
  const terminal = result('', { uuid: 'terminal', num_turns: 10, stop_reason: 'end_turn', terminal_reason: 'completed',
    permission_denials: [], queued_turn_count: 0, origin: { kind: 'task-notification' }, user_message_uuid: 'goal-run' });
  output.ingest(state, terminal);
  const saved = output.serialize(state);
  saved.status = 'complete'; saved.final = ''; saved.notice = 'old missing answer notice';
  for (const replay of [false, true]) {
    const restored = output.createState(saved);
    if (replay) [...frames, terminal].forEach(event => output.ingest(restored, event));
    assert.equal(output.finish(restored, { exitCode: 0 }), 'verified final summary');
    assert.equal(restored.finalMessageId, 'final-2');
    assert.equal(restored.answers.length, 1);
    assert.equal(restored.notice, '');
    assert.equal(output.finish(restored, { exitCode: 0, finalResult: terminal }), 'verified final summary');
    assert.equal(restored.answers.length, 1, 'repeated completion is idempotent');
  }
});

test('empty result fallback never searches past a later unfinished, tool-bearing or aborted root', () => {
  for (const later of [
    { type: 'assistant', message: { id: 'later', content: [{ type: 'text', text: 'unfinished' }] } },
    { type: 'assistant', message: { id: 'later', stop_reason: 'end_turn', content: [{ type: 'text', text: 'tool preface' }, { type: 'tool_use', id: 'read', name: 'Read' }] } },
    { type: 'assistant', message: { id: 'later', stop_reason: 'end_turn', content: [{ type: 'text', text: 'server tool preface' }, { type: 'server_tool_use', id: 'search', name: 'web_search' }] } },
    { type: 'assistant', message: { id: 'later', stop_reason: 'end_turn', content: [{ type: 'text', text: 'tool result preface' }, { type: 'tool_result', tool_use_id: 'read', content: 'tool output' }] } },
    { type: 'assistant', aborted: true, message: { id: 'later', stop_reason: 'end_turn', content: [{ type: 'text', text: 'aborted' }] } },
    { type: 'assistant', message: { id: 'later', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'unfinished reasoning' }] } },
  ]) {
    const state = output.createState();
    output.ingest(state, { type: 'assistant', message: { id: 'earlier', stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier answer' }] } });
    output.ingest(state, later);
    assert.equal(output.finish(state, { exitCode: 0, finalResult: result('', { num_turns: 1 }) }), '');
  }
});

test('empty result fallback requires a real current root in the same context, not child or result-only text', () => {
  for (const setup of [
    state => output.ingest(state, { type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'child', stop_reason: 'end_turn', content: [{ type: 'text', text: 'child answer' }] } }),
    state => output.ingest(state, result('result-only stage', { num_turns: 1 })),
    state => {
      output.ingest(state, { type: 'assistant', message: { id: 'old-root', stop_reason: 'end_turn', content: [{ type: 'text', text: 'previous context' }] } });
      output.ingest(state, { type: 'conversation_reset', new_conversation_id: 'new-context' });
    },
  ]) {
    const state = output.createState(); setup(state);
    assert.equal(output.finish(state, { exitCode: 0, finalResult: result('', { num_turns: 1 }) }), '');
  }
});

test('empty result fallback preserves result rejection and zero-model-turn boundaries', () => {
  for (const extra of [{ num_turns: 0 }, { queued_turn_count: 1 }, { relay_pending_inputs: 1 }, { relay_pending_background_tasks: 1 },
    { terminal_reason: 'aborted_streaming' }, { terminal_reason: 'aborted_tools' }, { is_error: true },
    { subtype: 'error_during_execution' }, { parent_tool_use_id: 'agent' }]) {
    const state = output.createState();
    output.ingest(state, { type: 'assistant', message: { id: 'root', stop_reason: 'end_turn', content: [{ type: 'text', text: 'complete-looking text' }] } });
    assert.equal(output.finish(state, { exitCode: 0, finalResult: result('', { num_turns: 1, ...extra }) }), '');
  }
});

test('empty result fallback cannot revive a fully or partially retracted latest answer', () => {
  for (const partial of [false, true]) {
    const state = output.createState();
    output.ingest(state, { type: 'assistant', uuid: 'earlier-frame', message: { id: 'earlier', stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier stage' }] } });
    if (partial) output.ingest(state, { type: 'assistant', uuid: 'retained-frame', message: { id: 'latest', content: [{ type: 'text', text: 'retained fragment' }] } });
    output.ingest(state, { type: 'assistant', uuid: 'withdrawn-frame', message: { id: 'latest', stop_reason: 'end_turn', content: [{ type: 'text', text: 'withdrawn answer' }] } });
    output.ingest(state, { type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: ['withdrawn-frame'] });
    const restored = output.createState(output.serialize(state));
    assert.equal(output.finish(restored, { exitCode: 0, finalResult: result('', { num_turns: 1 }) }), '');
    assert.ok(output.processItems(restored).some(item => item.result === 'earlier stage'));
    assert.ok(output.processItems(restored).every(item => !item.result.includes('withdrawn answer')));
  }
});

test('same-text independent blocks retain multiplicity while whole-frame replay stays idempotent', () => {
  for (const uuid of ['two-blocks', undefined]) {
    const state = output.createState();
    const event = { type: 'assistant', uuid, message: { id: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'repeat' }, { type: 'text', text: 'repeat' }] } };
    output.ingest(state, event); output.ingest(state, event);
    assert.equal(output.textFor(state.messages[0]), 'repeatrepeat');
    assert.equal(output.finish(state, { exitCode: 0, finalResult: result(undefined) }), 'repeatrepeat');
  }
});

test('SDK aborted terminal reasons never promote partial success text without a renderer abort flag', () => {
  for (const terminal_reason of ['aborted_streaming', 'aborted_tools']) {
    const state = output.createState(); output.ingest(state, assistant('m', 'partial'));
    assert.equal(output.finish(state, { exitCode: 0, finalResult: result('partial', { terminal_reason }) }), '');
    assert.equal(output.processItems(state)[0].result, 'partial');
  }
});

test('live preview streams the latest main text without committing or duplicating it in process', () => {
  const state = output.createState();
  output.ingest(state, stream('message_start', { message: { id: 'live' } }));
  output.ingest(state, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '# 正在生成\n\n**实时**' } }));
  const preview = output.preview(state);
  assert.deepEqual(preview, { messageId: 'live', text: '# 正在生成\n\n**实时**' });
  assert.equal(state.final, '');
  assert.equal(output.processItems(state, { previewMessageId: preview.messageId }).length, 0);
  assert.equal(output.serialize(state).final, '', 'a visible draft is never saved as final');
  output.ingest(state, stream('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'read', name: 'Read' } }));
  assert.equal(output.preview(state), null);
  assert.equal(output.processItems(state)[0].result, preview.text, 'tool-bearing text goes back into process');
});

test('preview excludes child output, aborted text and protocol, and reconciles final-only snapshots', () => {
  const state = output.createState();
  output.ingest(state, assistant('main', 'main draft'));
  output.ingest(state, assistant('child', 'child answer', { parent_tool_use_id: 'tool' }));
  assert.equal(output.preview(state).text, 'main draft');
  output.ingest(state, assistant('aborted', 'aborted text', { aborted: true }));
  assert.equal(output.preview(state), null);
  output.ingest(state, assistant('protocol', protocol));
  assert.equal(output.preview(state), null);
  output.ingest(state, assistant('final', 'final answer'));
  output.finish(state, { exitCode: 0, finalResult: result('final answer') });
  assert.equal(output.preview(state), null);
  assert.equal(output.processItems(state).some(item => item.result === 'final answer'), false);
  const restored = output.createState(output.serialize(state));
  assert.equal(restored.final, 'final answer');
  assert.equal(output.preview(restored), null);
});

test('a settled SDK stage moves preview back to narration before later work without committing an answer', () => {
  const state = output.createState();
  output.ingest(state, stream('message_start', { message: { id: 'phase' } }));
  output.ingest(state, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'phase body' } }));
  assert.equal(output.preview(state).text, 'phase body');
  output.ingest(state, result('phase body'));
  assert.equal(output.preview(state), null);
  assert.equal(state.status, 'running');
  assert.equal(state.final, '');
  assert.deepEqual(output.processItems(state).map(item => [item.result, item.status]), [['phase body', 'success']]);
  output.ingest(state, assistant('child', 'child detail', { parent_tool_use_id: 'child' }));
  assert.equal(output.preview(state), null, 'child messages cannot revive the settled main preview');
  const restored = output.createState(output.serialize(state));
  assert.equal(output.preview(restored), null);
  output.ingest(restored, stream('message_start', { message: { id: 'next' } }));
  output.ingest(restored, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'next draft' } }));
  const preview = output.preview(restored);
  assert.equal(preview.text, 'next draft');
  assert.deepEqual(output.processItems(restored, { previewMessageId: preview.messageId }).map(item => item.result), ['phase body']);
  output.ingest(restored, result('next draft'));
  assert.equal(output.finish(restored, { exitCode: 0 }), 'next draft');
  assert.deepEqual(output.processItems(restored).map(item => item.result), ['phase body']);
});

test('result-only stage text retains its position and is promoted exactly once at job-done', () => {
  const state = output.createState();
  output.ingest(state, assistant('streamed', 'streamed explanation'));
  output.ingest(state, result('separate stage summary'));
  output.ingest(state, result('separate stage summary'));
  assert.equal(output.preview(state), null);
  assert.deepEqual(output.processItems(state).map(item => item.result), ['streamed explanation', 'separate stage summary']);
  assert.equal(output.processItems(state)[1].order, 2);
  assert.equal(state.current[''], 'streamed');
  const restored = output.createState(output.serialize(state));
  output.finish(restored, { exitCode: 0, finalResult: result('separate stage summary') });
  assert.equal(restored.final, 'separate stage summary');
  assert.deepEqual(output.processItems(restored).map(item => item.result), ['streamed explanation']);
});

test('new text in the same message after a stage result resumes preview without appending to result-only prose', () => {
  const state = output.createState();
  output.ingest(state, stream('message_start', { message: { id: 'same' } }));
  output.ingest(state, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'one' } }));
  output.ingest(state, result('stage summary'));
  output.ingest(state, stream('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' two' } }));
  assert.equal(output.preview(state).text, 'one two');
  assert.equal(state.messages.find(message => message.resultOnly).blocks[0].text, 'stage summary');
});

function delivered(state, id, text, ids, extra = {}) {
  output.ingest(state, { type: 'assistant', uuid: 'frame-' + id,
    message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const event = result(text, { uuid: 'result-' + id, user_message_uuids: ids, num_turns: 1, terminal_reason: 'completed', ...extra });
  output.ingest(state, event);
  return event;
}
const supplements = [{ id: 'question-b', status: 'applied' }];

test('separate input results become complete answers only at job-done and survive history serialization', () => {
  const state = output.createState();
  delivered(state, 'answer-a', '第一题的完整回答', ['question-a'], { queued_turn_count: 1 });
  const terminal = delivered(state, 'answer-b', '第二题的完整回答', ['question-b']);
  assert.equal(state.final, '');
  assert.deepEqual(state.answers, []);
  assert.deepEqual(output.processItems(state).map(item => item.result), ['第一题的完整回答', '第二题的完整回答']);
  assert.equal(output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements }), '第一题的完整回答\n\n第二题的完整回答');
  assert.deepEqual(state.answers.map(answer => answer.userMessageIds), [['question-a'], ['question-b']]);
  assert.deepEqual(output.processItems(state), []);
  const restored = output.createState(output.serialize(state));
  assert.equal(restored.version, 5);
  assert.deepEqual(restored.answers, state.answers);
  assert.equal(restored.final, state.final);
});

test('without a known user supplement ordinary runs retain their single final answer', () => {
  const state = output.createState();
  delivered(state, 'answer-a', 'earlier result', ['question-a']);
  const terminal = delivered(state, 'answer-b', 'last result', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal });
  assert.equal(state.final, 'last result');
  assert.equal(state.answers.length, 1);
  assert.deepEqual(output.processItems(state).map(item => item.result), ['earlier result']);
});

test('same-input Agent or Goal stages replace their candidate without erasing process evidence', () => {
  const state = output.createState();
  for (let i = 0; i < 60; i++) delivered(state, 'stage-' + i, 'intermediate stage ' + i, ['question-a']);
  delivered(state, 'answer-a', 'confirmed first answer', ['question-a']);
  assert.equal(state.resultCandidates.length, 1, 'long continuations do not accumulate another copy of every stage');
  const terminal = delivered(state, 'answer-b', 'confirmed second answer', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
  assert.equal(state.final, 'confirmed first answer\n\nconfirmed second answer');
  assert.equal(output.processItems(state).length, 60);
});

test('later merged consumed-input UUIDs supersede old answers rather than duplicating them', () => {
  const state = output.createState();
  delivered(state, 'answer-a', 'old answer to A', ['question-a']);
  const terminal = delivered(state, 'merged', 'updated answer for A and B', ['question-a', 'question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
  assert.deepEqual(state.answers.map(answer => answer.text), ['updated answer for A and B']);
  assert.deepEqual(output.processItems(state).map(item => item.result), ['old answer to A']);
});

test('answer selection uses input UUIDs, never substring containment or equal prose', () => {
  for (const second of ['same reply', 'prefix same reply suffix']) {
    const state = output.createState();
    delivered(state, 'answer-a', 'same reply', ['question-a']);
    const terminal = delivered(state, 'answer-b', second, ['question-b']);
    output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
    assert.deepEqual(state.answers.map(answer => answer.messageId), ['answer-a', 'answer-b']);
    assert.equal(state.final, 'same reply\n\n' + second);
  }
});

test('a later B-only reply cannot erase A from an earlier merged A/B answer', () => {
  const state = output.createState();
  delivered(state, 'answer-a', 'first A', ['question-a']);
  delivered(state, 'merged', 'complete A and B', ['question-a', 'question-b']);
  const terminal = delivered(state, 'revised-b', 'revised B', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
  assert.deepEqual(state.answers.map(answer => answer.text), ['complete A and B', 'revised B']);
  assert.equal(state.final, 'complete A and B\n\nrevised B');
});

test('a context reset excludes earlier epoch candidates from an interrupted run', () => {
  const state = output.createState();
  delivered(state, 'old-answer', 'discarded epoch answer', ['question-a']);
  output.ingest(state, { type: 'conversation_reset', uuid: 'reset', new_conversation_id: 'new-context' });
  const terminal = delivered(state, 'answer-b', 'new epoch answer', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
  assert.equal(state.final, 'new epoch answer');
  assert.deepEqual(state.answers.map(answer => answer.contextEpoch), [1]);
});

test('retracted assistant frames also invalidate their confirmed-result candidates', () => {
  const state = output.createState();
  delivered(state, 'answer-a', 'retracted reply', ['question-a']);
  output.ingest(state, { type: 'system', subtype: 'model_refusal_fallback', uuid: 'retract', retracted_message_uuids: ['frame-answer-a'] });
  assert.equal(state.resultCandidates.length, 0);
  const terminal = delivered(state, 'answer-b', 'retained reply', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
  assert.equal(state.final, 'retained reply');
});

test('duplicate result delivery and repeated finish do not duplicate confirmed answers', () => {
  const state = output.createState();
  const first = delivered(state, 'answer-a', 'A', ['question-a']);
  output.ingest(state, { ...first, uuid: 'duplicate-first' });
  const terminal = delivered(state, 'answer-b', 'B', ['question-b']);
  output.ingest(state, { ...terminal, uuid: 'duplicate-second' });
  for (let i = 0; i < 2; i++) assert.equal(output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements }), 'A\n\nB');
  assert.equal(state.answers.length, 2);
  assert.equal(state.resultCandidates.length, 2);
});

test('child, failed, paused, diagnostic and zero-model-turn results never become extra deliveries', () => {
  for (const extra of [{ parent_tool_use_id: 'agent' }, { is_error: true },
    { terminal_reason: 'aborted_streaming' }, { num_turns: 0 }]) {
    const state = output.createState();
    delivered(state, 'invalid', 'not a delivered answer', ['question-a'], extra);
    const terminal = delivered(state, 'answer-b', 'B', ['question-b']);
    output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements });
    assert.equal(state.final, 'B');
  }
  const state = output.createState();
  delivered(state, 'protocol', protocol, ['question-a']);
  const terminal = delivered(state, 'answer-b', 'B', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal }, { supplements, aborted: true });
  assert.equal(state.final, '');
  assert.deepEqual(state.answers, []);
});

test('a child-owned result cannot become the task final even when passed directly in job-done', () => {
  const state = output.createState();
  delivered(state, 'answer-a', 'root answer', ['question-a']);
  output.finish(state, { exitCode: 0, finalResult: result('child answer', { parent_tool_use_id: 'child-tool' }) }, { supplements });
  assert.equal(state.final, '');
  assert.deepEqual(state.answers, []);
});

test('journal result recovery changes evidence only and does not replay into persisted messages', () => {
  const state = output.createState();
  const first = delivered(state, 'answer-a', 'A', ['question-a']);
  const terminal = delivered(state, 'answer-b', 'B', ['question-b']);
  output.finish(state, { exitCode: 0, finalResult: terminal });
  const legacy = output.serialize(state); delete legacy.resultCandidates; delete legacy.answers; legacy.version = 4;
  const restored = output.createState(legacy), messages = JSON.stringify(restored.messages);
  const before = { eventOrder: restored.eventOrder, revision: restored.revision, current: JSON.stringify(restored.current), lastResult: JSON.stringify(restored.lastResult) };
  output.recordResultEvidence(restored, first);
  output.recordResultEvidence(restored, terminal);
  assert.equal(JSON.stringify(restored.messages), messages);
  assert.deepEqual({ eventOrder: restored.eventOrder, revision: restored.revision, current: JSON.stringify(restored.current), lastResult: JSON.stringify(restored.lastResult) }, before);
  assert.equal(output.finish(restored, { exitCode: 0, finalResult: terminal }, { supplements }), 'A\n\nB');
});
