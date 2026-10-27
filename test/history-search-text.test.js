'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Text = require('../renderer/history-search-text');

test('saved final output is authoritative and withdrawn drafts never reappear', () => {
  assert.equal(Text.savedAssistant({ assistant: 'old draft', output: { status: 'complete', final: 'saved final' } }), 'saved final');
  for (const status of ['running', 'canceled', 'error']) {
    assert.equal(Text.savedAssistant({ assistant: 'draft', output: { status, final: 'withdrawn' } }), '');
  }
  assert.equal(Text.savedAssistant({ assistant: 'draft', output: { status: 'complete', final: '' } }), '');
  assert.equal(Text.savedAssistant({ assistant: 'aggregate', chat: [{}] }), '');
  assert.equal(Text.savedAssistant({ assistant: 'legacy saved answer' }), 'legacy saved answer');
});

test('literal user inputs and supplements are searchable, without activity/protocol text', () => {
  const fields = Text.fieldsForTurn({ user: 'literal **user**', assistant: 'answer\n<tool_call><function=hidden>{}</function></tool_call>',
    activity: { output: 'private tool log' }, supplements: [{ id: 's1', text: '补充正文' }, { id: 's1', text: 'duplicate' }, { text: 'not rendered' }] });
  assert.deepEqual(fields, [
    { side: 'user', text: 'literal **user**', messageKey: 'user' },
    { side: 'user', text: '补充正文', messageKey: 'supplement:s1' },
    { side: 'assistant', text: 'answer', messageKey: 'assistant' },
  ]);
  assert.deepEqual(Text.fieldsForTurn({ prompt: 'create prompt', user: 'hidden', assistant: 'hidden' }, 'create'), [
    { side: 'prompt', text: 'create prompt', messageKey: 'user' },
  ]);
});

test('timeline search fields preserve exact segment and supplement identity', () => {
  const turn = { user: 'initial', supplements: [{ id: 'input', text: 'follow up', presentation: { version: 1, order: 2, messageId: 'm', textLength: 5 } }],
    output: { status: 'complete', final: 'firstsecond', finalMessageId: 'm', messages: [{ id: 'm', order: 1, blocks: [{ type: 'text', index: 0, text: 'firstsecond' }] }] } };
  assert.deepEqual(Text.fieldsForTurn(turn), [
    { side: 'user', text: 'initial', messageKey: 'user' },
    { side: 'assistant', text: 'first', messageKey: 'assistant:start' },
    { side: 'user', text: 'follow up', messageKey: 'supplement:input' },
    { side: 'assistant', text: 'second', messageKey: 'assistant:after:input' },
  ]);
  turn.output.status = 'canceled';
  assert.equal(Text.fieldsForTurn(turn).some(field => field.side === 'assistant'), false);
});

test('continuation system prompts are excluded exactly when the renderer hides them', () => {
  const turn = { user: 'automatic resume', inputKind: 'resume', taskRun: { version: 1, taskId: 'task', resumedFromRunId: 'r',
    rootStartedAt: 1, segmentStartedAt: 2, elapsedBeforeMs: 1 }, assistant: 'saved answer' };
  assert.deepEqual(Text.fieldsForTurn(turn).map(f => f.text), ['saved answer']);
  delete turn.taskRun;
  assert.deepEqual(Text.fieldsForTurn(turn).map(f => f.text), ['automatic resume', 'saved answer']);
});

test('Markdown formatting is removed while visible punctuation, code and raw HTML stay literal', () => {
  const plain = Text.displayText('## 记忆**架构**\n\n[可见链接](https://hidden.example) 与 `A+B?`\n\n```js\nconst a = "&amp;";\n```\n<b>原始HTML</b>', { markdown: true });
  assert.match(plain, /记忆架构/);
  assert.match(plain, /可见链接 与 A\+B\?/);
  assert.equal(plain.includes('hidden.example'), false);
  assert.match(plain, /const a = "&amp;";/);
  assert.match(plain, /<b>原始HTML<\/b>/);
  assert.equal(Text.displayText('literal **user**'), 'literal **user**');
  assert.equal(Text.snippet(plain, 'A+B?').includes('\0A+B?\x01'), true);
  assert.equal(Text.snippet(plain, 'AB'), null, 'no fuzzy punctuation removal');
});

test('Markdown tables, lists, escapes and common entities match displayed text', () => {
  assert.equal(Text.normalize(Text.displayText('| 标题 | 值 |\n|---|---|\n| A | B |', { markdown: true })), '标题 值 a b');
  assert.equal(Text.normalize(Text.displayText('- alpha\n- **beta**\n\n\\* &amp; &#x1f600; &copy;', { markdown: true })), 'alpha beta * & 😀 ©');
  assert.equal(Text.displayText('`&amp;` 与 &amp;lt;', { markdown: true }), '&amp; 与 &lt;');
});

test('whitespace/case matching retains exact source offsets and Chinese literal matches', () => {
  const value = '  前文 Alpha\n\t beta  后文';
  const range = Text.matchRange(value, 'ALPHA beta');
  assert.equal(value.slice(range.start, range.end), 'Alpha\n\t beta');
  assert.match(Text.snippet(value, 'alpha beta'), /\x00Alpha\n\t beta\x01/);
  assert.equal(Text.snippet('项目架构', '项目  架构'), null);
  assert.equal(Text.matchRange('anything', '  '), null);
});

test('Unicode lowercase expansion, surrogate pairs and context folding keep highlight positions', () => {
  for (const [source, query, expected] of [['İstanbul 😀', 'i\u0307stanbul', 'İstanbul'], ['xx😀后文', '😀后', '😀后'], ['前 ΟΣ 后', 'ος', 'ΟΣ']]) {
    const range = Text.matchRange(source, query);
    assert.equal(source.slice(range.start, range.end), expected);
  }
});
