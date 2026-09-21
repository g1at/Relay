'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, clone, full, result } = require('./renderer-activity-harness.cjs');
const { forTurn } = require('../renderer/conversation-errors');

test('job-done-only goal preparation failure persists an empty failed turn and exact error', async () => {
  const h = harness('plain');
  const error = '设置目标失败：SDK 控制请求超时\nThe goal command was not acknowledged.';
  h.conv.executionMode = { kind: 'goal' };
  h.conv.turns[0].executionMode = { kind: 'goal' };
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: -1, error });
  const saved = h.persisted.turns[0];
  assert.equal(saved.error, error);
  assert.equal(saved.status, 'error');
  assert.equal(saved.assistant, '');
  assert.equal(saved.output.status, 'error');
  assert.equal(saved.activity.items.length, 0, 'no tool rows are needed to retain a startup error');
  assert.equal(forTurn(saved), error, 'reopening shows the persisted root failure');
  assert.equal(h.context.runs.size, 0);
});

test('a background SDK 429 failure saves to its owning conversation while another conversation is open', async () => {
  const h = harness('plain');
  const foreground = { id: 'different-conversation', turns: [{ user: 'unrelated', assistant: 'untouched' }] };
  h.context.currentConv = clone(foreground);
  const error = 'API Error: 429\nProvider retry limit reached';
  const terminal = result('', { subtype: 'error_during_execution', is_error: true, errors: error.split('\n') });
  h.send(terminal);
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: 0, finalResult: terminal });
  assert.equal(h.persisted.id, 'conv');
  assert.equal(h.persisted.turns[0].error, error);
  assert.equal(h.persisted.turns[0].status, 'error');
  assert.equal(forTurn(h.persisted.turns[0]), error);
  assert.deepEqual(h.context.currentConv, foreground, 'background failure never changes the displayed conversation');
  assert.equal(h.notices.filter(item => item.role === 'error').length, 0, 'no error card leaks into another conversation');
});

test('failure writes the exact older run turn while preserving later answers and their timestamps', async () => {
  const h = harness('plain');
  const later = { runId: 'later-run', user: 'later question', assistant: 'later answer',
    status: 'complete', ts: '2026-09-11T01:00:00Z', assistantTs: '2026-09-11T01:00:02Z' };
  h.conv.turns = [{ runId: 'first-run', user: 'first', assistant: 'first answer', status: 'complete' },
    { runId: 'job', user: 'continue', assistant: '', executionMode: { kind: 'goal' } }, clone(later)];
  const first = clone(h.conv.turns[0]);
  h.run.turnIndex = 1;
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: -1, error: 'goal preparation timeout' });
  assert.deepEqual(h.persisted.turns[0], first);
  assert.deepEqual(h.persisted.turns[2], later);
  assert.equal(h.persisted.turns[1].error, 'goal preparation timeout');
  assert.equal(h.persisted.turns[1].status, 'error');
  assert.equal(h.persisted.turns[1].user, 'continue');
});

test('terminal failure supplied only by job-done finalResult is retained with a logical zero exit code', async () => {
  const h = harness('plain');
  const terminal = result('', { subtype: 'error_during_execution', is_error: true, errors: ['API Error: 429'] });
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: 0, finalResult: terminal });
  assert.equal(h.persisted.turns[0].error, 'API Error: 429');
  assert.equal(h.persisted.turns[0].status, 'error');
  assert.equal(h.persisted.turns[0].assistant, '');
});

test('an explicit pause remains paused after finalization and reopening, without an error card', async () => {
  const h = harness('plain');
  h.run.abortRequested = true;
  h.run.pauseRequested = true;
  h.run.error = 'cancellation race must not become a failure';
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: -1, aborted: true });
  assert.equal(h.persisted.turns[0].error, null);
  assert.equal(h.persisted.turns[0].status, 'paused');
  assert.equal(forTurn(h.persisted.turns[0]), '');
  assert.equal(h.notices.filter(item => item.role === 'error').length, 0);
});

test('successful completion saves a final answer and an explicit non-error terminal state', async () => {
  const h = harness('plain');
  h.send(full('answer', 'synthetic final answer'));
  const terminal = result('synthetic final answer');
  h.send(terminal);
  await h.context.finishRunUnsafe('job', { type: 'job-done', exitCode: 0, finalResult: terminal });
  assert.equal(h.persisted.turns[0].status, 'complete');
  assert.equal(h.persisted.turns[0].error, null);
  assert.equal(h.persisted.turns[0].assistant, 'synthetic final answer');
  assert.equal(forTurn(h.persisted.turns[0]), '');
});
