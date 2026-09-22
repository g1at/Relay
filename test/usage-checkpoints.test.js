'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageObserver } = require('../src/main/usage/usage-capture');
const { applyUsageRecord, emptyIndex } = require('../src/main/usage/usage-stats-worker');

const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const counters = (n = 1) => ({ inputTokens: 10 * n, outputTokens: 4 * n, cacheReadInputTokens: 2 * n, cacheCreationInputTokens: n });
const response = (n = 1) => ({ session: { model_usage: { 'provider/model[1m]': counters(n) }, total_cost_usd: 999 }, behaviors: { private: 'PRIVATE' } });
const activity = (session_id = 'session', patch = {}) => ({ type: 'assistant', session_id,
  message: { id: 'message', model: 'different-response-alias', usage: { input_tokens: 999999 }, content: [{ type: 'text', text: 'PRIVATE' }] }, ...patch });
const terminal = (patch = {}) => ({ type: 'result', uuid: 'result', session_id: 'session', subtype: 'success', modelUsage: response().session.model_usage, ...patch });
function setup(t, query, options = {}) {
  const records = [];
  const observe = createUsageObserver(record => records.push(record), { queryId: 'query', checkpointIntervalMs: 15, checkpointTimeoutMs: 100, ...options });
  observe.attach(query); t.after(() => observe.close());
  return { observe, records };
}

test('a Query without a final result preserves authoritative usage without request text or aliases', async t => {
  const requests = [];
  const { observe, records } = setup(t, { [method]: async options => { requests.push(options); return response(); } });
  observe(activity());
  await pause(30);
  observe.close();
  assert.equal(records.length, 1);
  assert.equal(records[0].resultId, 'checkpoint:1');
  assert.equal(records[0].sessionId, 'session');
  assert.deepEqual(JSON.parse(JSON.stringify(records[0].modelUsage)), response().session.model_usage);
  assert.ok(requests.every(options => options.skipBehaviors === true));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|999999|different-response-alias|cost_usd|behaviors/);
});

test('unchanged checkpoints and the final cumulative result cannot charge the same tokens again', async t => {
  let value = response();
  const { observe, records } = setup(t, { [method]: async () => value });
  observe(activity()); await pause(25);
  value = response(2); observe(activity()); await pause(25);
  observe(terminal({ modelUsage: response(2).session.model_usage }));
  observe(terminal({ modelUsage: response(2).session.model_usage }));
  const state = emptyIndex('checkpoint-test').usage;
  for (const record of records) applyUsageRecord(state, record);
  assert.equal(records.length, 3);
  assert.deepEqual(Object.values(state.days)[0].models['provider/model[1m]'], counters(2));
});

test('a hanging optional API permits one request and disables sampling after its timeout', async t => {
  let calls = 0;
  const pending = defer();
  const { observe, records } = setup(t, { [method]: () => { calls++; return pending.promise; } }, { checkpointTimeoutMs: 15 });
  for (let i = 0; i < 10; i++) observe(activity());
  await pause(35);
  for (let i = 0; i < 10; i++) observe(activity());
  await pause(25);
  assert.equal(calls, 1);
  pending.resolve(response(8)); await pause(5);
  assert.equal(records.length, 0, 'a late timed-out response is discarded');
  observe(terminal()); assert.equal(records.length, 1, 'normal result accounting remains available');
});

test('missing, throwing, and rejecting experimental controls leave final accounting intact', async t => {
  for (const query of [{}, { [method]() { throw Error('unavailable'); } }, { [method]: async () => { throw Error('unsupported'); } }]) {
    const { observe, records } = setup(t, query);
    assert.doesNotThrow(() => observe(activity()));
    await pause(20);
    observe(terminal()); observe.close();
    assert.equal(records.length, 1); assert.equal(records[0].resultId, 'result');
  }
});

test('reset rejects an in-flight old snapshot while retaining valid results with a lagging session wrapper', async t => {
  const pending = defer(); let calls = 0;
  const { observe, records } = setup(t, { [method]: () => ++calls === 1 ? pending.promise : Promise.resolve(response(2)) });
  observe(activity()); await pause(5);
  observe({ type: 'conversation_reset', uuid: 'reset', new_conversation_id: 'new-session' });
  observe(activity('new-session'));
  pending.resolve(response(10)); await pause(25);
  observe({ type: 'conversation_reset', uuid: 'reset', new_conversation_id: 'new-session' });
  observe(terminal({ uuid: 'new-result', session_id: 'session', modelUsage: response(2).session.model_usage }));
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.sessionId === 'new-session'));
  assert.ok(records.every(record => record.modelUsage['provider/model[1m]'].inputTokens === 20));
});

test('an old epoch timeout cannot disable the new epoch or start a second hanging request', async t => {
  const pending = defer(); let calls = 0;
  const { observe, records } = setup(t, { [method]: () => ++calls === 1 ? pending.promise : Promise.resolve(response(2)) }, { checkpointTimeoutMs: 15 });
  observe(activity()); await pause(5);
  observe({ type: 'conversation_reset', uuid: 'reset', new_conversation_id: 'new-session' });
  observe(activity('new-session')); await pause(25);
  assert.equal(calls, 1);
  pending.resolve(response(99)); await pause(20);
  assert.ok(calls >= 2); assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, 'new-session'); assert.equal(records[0].modelUsage['provider/model[1m]'].inputTokens, 20);
});

test('a checkpoint resolving after the same final counters does not create another record', async t => {
  const pending = defer();
  const { observe, records } = setup(t, { [method]: () => pending.promise });
  observe(activity()); await pause(5);
  observe(terminal()); pending.resolve(response()); await pause(10);
  assert.equal(records.length, 1); assert.equal(records[0].resultId, 'result');
});

test('stop does not wait for a pending sample and still accepts an abort result', async t => {
  const pending = defer();
  const { observe, records } = setup(t, { [method]: () => pending.promise });
  observe(activity()); await pause(5);
  assert.equal(observe.stop(), undefined);
  pending.resolve(response(3)); await pause(5);
  observe(terminal({ is_error: true, subtype: 'error_during_execution' }));
  assert.equal(records.length, 1); assert.equal(records[0].isError, true);
  observe.close(); observe(activity()); await pause(20);
  assert.equal(records.length, 1);
});

test('child activity only samples whole-query totals, never independently charges child counters', async t => {
  const value = response(); value.session.model_usage.child = counters(2);
  const { observe, records } = setup(t, { [method]: async () => value });
  observe({ type: 'system', subtype: 'init', session_id: 'session' });
  observe(activity('child-session', { parent_tool_use_id: 'agent-tool' }));
  observe(terminal({ parent_tool_use_id: 'agent-tool', modelUsage: { child: counters(99) } }));
  await pause(20);
  observe({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'session' });
  assert.equal(records.length, 1); assert.equal(records[0].sessionId, 'session');
  assert.equal(records[0].modelUsage.child.inputTokens, 20);
});

test('idle, zero, and malformed snapshots never fabricate usage or poll an idle Query', async t => {
  let calls = 0;
  const { observe, records } = setup(t, { [method]: async () => { calls++; return calls === 1 ? {} : response(0); } });
  await pause(20); assert.equal(calls, 0);
  observe({ type: 'stream_event', session_id: 'session', event: { type: 'message_stop' } });
  await pause(35);
  observe({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'session' });
  const idleCalls = calls;
  await pause(30);
  assert.equal(calls, idleCalls); assert.equal(records.length, 0);
});
