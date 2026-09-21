'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { forTurn } = require('../renderer/conversation-errors');
const failedResult = (extra = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true,
  errors: ['API Error: 429', 'Retry limit reached'], ...extra });

test('saved explicit failure retains original multiline details and wins over weaker evidence', () => {
  const error = '启动失败\nSDK control channel did not become ready';
  assert.equal(forTurn({ error, activity: { phase: 'error', error: 'older error' },
    output: { status: 'error', lastResult: failedResult() } }), error);
  assert.equal(forTurn({ error: { message: error } }), error);
});

test('legacy empty goal-preparation failure remains visible without activity rows', () => {
  const turn = { user: 'continue', assistant: '', activity: { phase: 'error', items: [], error: '运行失败：目标设置超时' },
    output: { status: 'error', messages: [], lastResult: null } };
  const before = JSON.stringify(turn);
  assert.equal(forTurn(turn), '运行失败：目标设置超时');
  assert.equal(JSON.stringify(turn), before, 'derivation neither migrates history nor changes ordering metadata');
});

test('root SDK 429 error can recover from the persisted output result', () => {
  assert.equal(forTurn({ output: { status: 'error', revision: 2, resultRevision: 2, lastResult: failedResult() } }),
    'API Error: 429\nRetry limit reached');
  assert.equal(forTurn({ output: { lastResult: failedResult({ errors: [], result: 'model unavailable' }) } }), 'model unavailable');
});

test('authoritative successful final suppresses stale intermediate failures', () => {
  for (const turn of [
    { output: { status: 'complete', final: 'final answer', lastResult: failedResult() }, error: 'obsolete' },
    { status: 'complete', assistant: 'final answer', activity: { phase: 'error', error: 'obsolete' } },
  ]) assert.equal(forTurn(turn), '');
});

test('a result from before later model work cannot supply the terminal error', () => {
  assert.equal(forTurn({ output: { status: 'running', revision: 3, resultRevision: 2, lastResult: failedResult() } }), '');
  assert.equal(forTurn({ output: { status: 'error', revision: 3, resultRevision: 2, lastResult: failedResult() } }), '任务执行失败');
});

test('paused and canceled turns do not become failures after reopening', () => {
  for (const status of ['paused', 'canceled', 'cancelled', 'aborted']) {
    assert.equal(forTurn({ status, error: 'obsolete', output: { lastResult: failedResult() } }), '');
    assert.equal(forTurn({ output: { status, lastResult: failedResult() } }), '');
  }
  assert.equal(forTurn({ activity: { phase: 'error', error: '已暂停' } }), '');
  assert.equal(forTurn({ output: { lastResult: failedResult({ terminal_reason: 'aborted_streaming' }) } }), '');
});

test('failed child tasks and tools do not become a whole-conversation error', () => {
  for (const parent of [{ parent_tool_use_id: 'agent-tool' }, { subagent_type: 'worker' }, { parent: 'agent' }]) {
    assert.equal(forTurn({ output: { lastResult: failedResult(parent) } }), '');
    assert.equal(forTurn({ activity: { phase: 'error', error: 'child only', ...parent } }), '');
  }
  assert.equal(forTurn({ activity: { phase: 'complete', error: 'obsolete',
    items: [{ type: 'tool', status: 'error', result: 'file not found' }] } }), '');
});

test('malformed metadata is ignored without exposing object coercions', () => {
  for (const turn of [null, false, [], '', { error: {} }, { output: [] }, { activity: 'broken' },
    { output: { lastResult: { type: 'assistant', is_error: true, errors: ['not a root result'] } } }]) {
    assert.equal(forTurn(turn), '');
  }
  assert.equal(forTurn({ output: { status: 'error', lastResult: failedResult({ errors: [null, {}, 0, ''] }) } }), '任务执行失败');
});

test('failure without saved details keeps an honest generic marker', () => {
  assert.equal(forTurn({ status: 'failed' }), '任务执行失败');
  assert.equal(forTurn({ output: { status: 'error' } }), '任务执行失败');
  assert.equal(forTurn({ assistant: '', output: { status: 'complete', lastResult: null } }), '');
});

test('browser entry exposes the same pure helper on both chat pages', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/conversation-errors.js'), 'utf8'), context);
  assert.equal(context.RelayConversationErrors.forTurn({ error: 'startup failed' }), 'startup failed');
  for (const page of ['index.html', 'mini.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../renderer', page), 'utf8');
    assert.ok(html.indexOf('conversation-errors.js') > html.indexOf('assistant-output.js'));
  }
});
