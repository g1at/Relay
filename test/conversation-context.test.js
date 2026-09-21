'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../renderer/conversation-context');
const message = (value, extra = {}) => ({ parent: '', order: 10, blocks: [{ type: 'text', text: value }], ...extra });
function failedTurn() {
  return { user: 'Rename the installed component', assistant: '', status: 'error', output: { status: 'error', messages: [
    message('I will inspect the current names', { order: 1 }),
    message('The component has been renamed; configuration references were updated', { stopReason: 'end_turn' }),
  ] }, activity: { items: [{ type: 'tool', toolName: 'Edit', order: 4, detail: '/fixture/SKILL.md', result: 'File updated successfully', status: 'success' },
    { type: 'tool', toolName: 'Grep', order: 5, result: 'Permission denied', status: 'error' }] } };
}
test('failed final field does not erase assistant work or successful tool results on the next turn', () => {
  const turn = failedTurn(), before = JSON.stringify(turn);
  const result = Context.build({ turns: [{ user: 'install', assistant: 'installed' }, turn, { user: 'continue' }] }, { turnIndex: 2 });
  assert.match(result, /用户：install\n助手：installed/);
  assert.match(result, /component has been renamed/);
  assert.match(result, /工具记录（成功）Edit：[\s\S]*SKILL.md[\s\S]*File updated successfully/);
  assert.match(result, /工具记录（失败）Grep：[\s\S]*Permission denied/);
  assert.match(result, /轮次状态：error/);
  assert.doesNotMatch(result, /用户：continue/);
  assert.equal(JSON.stringify(turn), before);
});
test('paused turns retain partial text without injecting thinking, child-only output or retracted blocks', () => {
  const turn = failedTurn(); turn.status = 'paused';
  turn.output.messages.push(message('PRIVATE_THINKING', { blocks: [{ type: 'thinking', text: 'PRIVATE_THINKING' }] }),
    message('CHILD_ONLY', { parent: 'child-tool' }), message('RETRACTED', { fullFrameIds: ['retired'] }),
    message('', { blocks: [{ type: 'text', text: 'OLD_BLOCK', wireUuids: ['retired'] }, { type: 'text', text: 'active replacement', wireUuids: ['current'] }] }));
  turn.output.retractedMessageUuids = ['retired'];
  turn.activity.retractedToolIds = ['old-tool']; turn.activity.items.push({ type: 'tool', toolUseId: 'old-tool', detail: 'OLD_TOOL_RESULT', status: 'success' });
  const result = Context.build({ turns: [turn] }, { turnIndex: 1 });
  assert.match(result, /renamed/); assert.match(result, /active replacement/); assert.match(result, /轮次状态：paused/);
  assert.doesNotMatch(result, /PRIVATE_THINKING|CHILD_ONLY|RETRACTED|OLD_BLOCK|OLD_TOOL_RESULT/);
});
test('explicit reset cuts older turns and only carries work in the surviving context epoch', () => {
  const reset = { user: 'PRE_CLEAR_USER', assistant: '', output: { contextEpoch: 1, resets: [{ contextEpoch: 1 }], messages: [
    message('PRE_CLEAR_ASSISTANT', { contextEpoch: 0 }), message('surviving context', { contextEpoch: 1 }),
  ] }, activity: { contextEpoch: 1, items: [{ type: 'tool', contextEpoch: 0, result: 'PRE_CLEAR_TOOL' }] } };
  const result = Context.build({ turns: [{ user: 'OLDER_USER', assistant: 'OLDER_ANSWER' }, reset] }, { turnIndex: 2 });
  assert.match(result, /surviving context/); assert.doesNotMatch(result, /PRE_CLEAR|OLDER/);
});
test('final answer appears once while earlier intermediate progress remains labeled as process', () => {
  const turn = { user: 'inspect', assistant: 'final reply', status: 'complete', output: { status: 'complete', final: 'final reply', messages: [message('progress'), message('final reply')] } };
  const result = Context.build({ turns: [turn] });
  assert.equal(result.split('final reply').length - 1, 1); assert.match(result, /助手（执行过程）：progress/);
});
test('multiple confirmed answers enter history recovery once without duplicating them as process', () => {
  const first = 'CAPABILITIES_ANSWER', second = 'FORECAST_ANSWER';
  const turn = { user: 'question one', assistant: first + '\n\n' + second,
    supplements: [{ id: 'second-input', text: 'question two', status: 'applied' }],
    output: { status: 'complete', contextEpoch: 1, final: first + '\n\n' + second,
      answers: [{ messageId: 'first', contextEpoch: 1, text: first }, { messageId: 'second', contextEpoch: 1, text: second }],
      messages: [message('progress', { id: 'process', contextEpoch: 1 }),
        message(first, { id: 'first', contextEpoch: 1 }), message(second, { id: 'second', contextEpoch: 1 })] } };
  const rendered = Context.build({ turns: [turn] });
  assert.equal(rendered.split(first).length - 1, 1);
  assert.equal(rendered.split(second).length - 1, 1);
  assert.match(rendered, /助手（执行过程）：progress/);
});
test('supplements and attachments survive recovery with unhandled state intact', () => {
  const result = Context.build({ turns: [{ ...failedTurn(), files: [{ path: '/fixture/source.png' }], supplements: [
    { text: 'new scope', status: 'applied' }, { text: 'unhandled change', status: 'canceled', files: [{ path: '/fixture/change.md' }] },
  ] }] }, { turnIndex: 1 });
  assert.match(result, /source.png/); assert.match(result, /补充：new scope/);
  assert.match(result, /尚未处理.*unhandled change/); assert.match(result, /change.md/);
});
test('large histories have a bounded budget and preserve newest outcome with omission disclosed', () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({ user: `request ${index}`, assistant: 'x'.repeat(9000) + ` latest outcome ${index}` }));
  const result = Context.build({ turns }, { maxChars: 900 });
  assert.ok(result.length < 1100); assert.match(result, /latest outcome 29/); assert.match(result, /已省略/);
  assert.doesNotMatch(result, /request 0\b/); assert.equal(Context.build({ turns }, { maxChars: 0 }), '');
});
test('old workspace and new canonical history headers are recognized', () => {
  assert.equal(Context.hasContext('[Relay 工作目录迁移]\nold bridge'), true);
  assert.equal(Context.hasContext(Context.build({ turns: [{ user: 'q', assistant: 'a' }] })), true);
  assert.equal(Context.hasContext('new input'), false);
});

test('bounded recovery retains an earlier user table link alongside the latest outcome', () => {
  const url = 'https://tables.example.invalid/base/synthetic?table=fixture-table&view=fixture-view';
  const turns = [{ user: `Use this table: ${url}`, assistant: 'Table inspected' },
    ...Array.from({ length: 20 }, (_, i) => ({ user: `Fill new rows ${i}`, assistant: 'x'.repeat(8000) + ` latest outcome ${i}` }))];
  const recovered = Context.build({ turns }, { maxChars: 900 });
  assert.ok(recovered.length < 1100);
  assert.ok(recovered.includes(url), 'the task locator survives when its old turn is omitted');
  assert.match(recovered, /latest outcome 19/);
  assert.doesNotMatch(recovered, /Table inspected/);
});

test('earlier links obey explicit and in-turn reset boundaries and exclude the current input', () => {
  const old = 'https://tables.example.invalid/cleared-table';
  const kept = 'https://tables.example.invalid/current-table';
  const future = 'https://tables.example.invalid/not-sent-yet';
  const later = Array.from({ length: 18 }, (_, i) => ({ user: `follow-up ${i}`, assistant: 'x'.repeat(8000) + ' latest outcome' }));
  for (const resetInsideTurn of [false, true]) {
    const turns = [{ runId: 'before', user: old, assistant: 'old response',
      ...(resetInsideTurn ? { output: { contextEpoch: 1, resets: [{ contextEpoch: 1 }] } } : {}) },
      { user: kept, assistant: 'new scope' }, ...later, { user: future }];
    const recovered = Context.build({ turns,
      ...(!resetInsideTurn ? { sdkContextBoundary: { turnIndex: 1, afterRunId: 'before' } } : {}) },
    { turnIndex: turns.length - 1, maxChars: 900 });
    assert.ok(recovered.includes(kept));
    assert.ok(!recovered.includes(old)); assert.ok(!recovered.includes(future));
  }
});

test('idle context boundary survives history recovery without reviving cleared turns', () => {
  const turns = [{ runId: 'before', user: 'CLEARED_USER', assistant: 'CLEARED_ASSISTANT' },
    { runId: 'after', user: 'new scope', assistant: 'new response' }];
  const result = Context.build({ turns, sdkContextBoundary: { turnIndex: 1, afterRunId: 'before' } });
  assert.doesNotMatch(result, /CLEARED/); assert.match(result, /new response/);
});

test('reset ignores stale legacy final and retains only supplementary requests sent after reset', () => {
  const turn = { user: 'OLD_INPUT', assistant: 'OLD_FINAL', output: { contextEpoch: 1,
    resets: [{ order: 8, contextEpoch: 1 }], messages: [message('current process', { contextEpoch: 1 })] },
    supplements: [{ text: 'OLD_SUPPLEMENT', status: 'applied', presentation: { order: 3 } },
      { text: 'current requirement', status: 'applied', presentation: { order: 9 } }] };
  const result = Context.build({ turns: [turn] }, { turnIndex: 1 });
  assert.doesNotMatch(result, /OLD_/); assert.match(result, /current process/); assert.match(result, /current requirement/);
});
