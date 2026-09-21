'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./renderer-activity-harness.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

test('renderer terminal cleanup survives history persistence rejection', () => {
  assert.match(source, /async function finishRunUnsafe\(jobId, doneEvt\)/);
  assert.match(source, /async function finishRun\(jobId, doneEvt\)[\s\S]*?await finishRunUnsafe\(jobId, doneEvt\);[\s\S]*?catch \(error\)/);
  assert.match(source, /if \(runs\.get\(convId\) === run\) runs\.delete\(convId\)/);
  assert.match(source, /if \(jobToConv\.get\(jobId\) === convId\) jobToConv\.delete\(jobId\)/);
  assert.match(source, /if \(currentConv && currentConv\.id === convId && !replacement\)[\s\S]*?setRunning\(false\)/);
  assert.match(source, /if \(evt\.type === 'job-done'\)[\s\S]*?void finishRun\(jobId, evt\)/);
});

test('renderer preserves a successful final after a denied tool and still reports actual SDK failures', async () => {
  const terminal = { type: 'result', subtype: 'success', is_error: false,
    result: 'Completed diagnostic findings.', terminal_reason: 'completed', stop_reason: 'end_turn',
    permission_denials: [{ tool_name: 'PowerShell' }] };
  const successful = harness();
  successful.send(terminal);
  assert.equal(successful.run.error, undefined);
  await successful.context.finishRunUnsafe('job', { exitCode: 0, finalResult: terminal });
  assert.equal(successful.persisted.turns[0].status, 'complete');
  assert.equal(successful.persisted.turns[0].assistant, terminal.result);
  assert.match(successful.persisted.turns[0].outputNotice, /工具请求被拒绝（PowerShell）/);

  const failed = harness();
  failed.send({ ...terminal, subtype: 'error_during_execution', is_error: true,
    result: '', errors: ['Actual provider failure'] });
  assert.equal(failed.run.error, 'Actual provider failure');

  const denied = harness();
  denied.send({ ...terminal, subtype: 'error_during_execution', is_error: true, result: '' });
  assert.match(denied.run.error, /工具权限被拒绝（1 次）：PowerShell/);
});
