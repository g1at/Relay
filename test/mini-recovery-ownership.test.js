'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('function taskSource(');
const end = source.indexOf('function taskTurnLocation(', start);
const context = vm.createContext({ TERMINAL_LEDGER_STATES: new Set(['succeeded', 'failed', 'canceled', 'interrupted']) });
vm.runInContext(source.slice(start, end), context);
const task = (state, instance = 'current') => ({ kind: 'chat', state, source: { type: 'mini', conversationId: 'conversation' }, execution: { appInstanceId: instance } });

test('current mini execution keeps its sole writer through pending final history save', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'canceled']) {
    assert.equal(context.taskCanRestoreChat(task(status), 'current'), false, status);
  }
});
test('a previous interrupted mini execution remains recoverable after app restart', () => {
  assert.equal(context.taskCanRestoreChat(task('interrupted', 'previous'), 'current'), true);
  assert.equal(context.taskCanRestoreChat(task('succeeded', 'previous'), 'current'), true);
});
test('ordinary chat recovery remains available and creation tasks remain separate', () => {
  const ordinary = { ...task('running'), source: { type: 'conversation', conversationId: 'conversation' } };
  assert.equal(context.taskCanRestoreChat(ordinary, 'current'), true);
  assert.equal(context.taskCanRestoreChat({ ...ordinary, kind: 'image' }, 'current'), false);
});
