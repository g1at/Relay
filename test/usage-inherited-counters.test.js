'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageObserver } = require('../src/main/usage/usage-capture');
const { normalizeUsageRecord } = require('../src/main/usage/usage-stats-service');
const { applyUsageRecord, emptyIndex, buildSnapshot } = require('../src/main/usage/usage-stats-worker');
const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const at = '2026-09-28T00:00:00Z';
const counters = n => ({ inputTokens: n, outputTokens: 2 * n, cacheReadInputTokens: 3 * n, cacheCreationInputTokens: 4 * n });
const snapshot = n => ({ session: { model_usage: { 'fixture/model': counters(n) } } });
const result = (n, patch = {}) => ({ type: 'result', subtype: 'success', uuid: `result-${n}`, session_id: 'session',
  modelUsage: snapshot(n).session.model_usage, ...patch });
const activity = () => ({ type: 'assistant', session_id: 'session', message: {} });
function harness(t, options = {}) {
  const records = [];
  const observer = createUsageObserver(record => records.push(record), { queryId: options.queryId || 'query',
    now: () => at, inheritedCounters: true, checkpointIntervalMs: 10, checkpointTimeoutMs: 100, ...options });
  t.after(() => observer.close());
  return { observer, records };
}
function aggregated(records) {
  const index = emptyIndex('fixture');
  records.forEach(record => applyUsageRecord(index.usage, record));
  return index;
}
function total(index) { return Object.values(index.usage.days).reduce((sum, day) => sum + (day.models['fixture/model']?.inputTokens || 0), 0); }

test('restored and forked Queries exclude inherited tokens while legacy journal records keep their meaning', async t => {
  const old = { queryId: 'legacy-query', sessionId: 'session', resultId: 'old', at, startedAt: at, modelUsage: snapshot(100).session.model_usage };
  const resumed = harness(t, { queryId: 'resumed' });
  const forked = harness(t, { queryId: 'forked' });
  await resumed.observer.prepareBaseline({ [method]: async () => snapshot(100) });
  resumed.observer(result(110));
  await forked.observer.prepareBaseline({ [method]: async () => snapshot(110) });
  forked.observer(result(120, { session_id: 'fork-session' }));
  const index = aggregated([old, ...resumed.records, ...forked.records]);
  assert.equal(total(index), 120);
  assert.equal(Object.keys(index.usage.epochs).length, 3, 'query/session identity is retained');
  assert.equal(resumed.records[0].modelUsage['fixture/model'].inputTokens, 10);
  assert.equal(forked.records[0].modelUsage['fixture/model'].inputTokens, 10);
});

test('cross-version legacy resumes, repeated new resumes and concurrent forks count only newly consumed tokens', async t => {
  const records = [100, 50].map((n, i) => ({ queryId: `old-query-${i}`, sessionId: 'session', resultId: `old-${i}`,
    at, startedAt: at, modelUsage: snapshot(n).session.model_usage }));
  for (const [id, start, finish, session] of [
    ['resume-a', 150, 160, 'session'], ['resume-b', 160, 180, 'session'],
    ['fork-a', 180, 185, 'fork-a'], ['fork-b', 180, 187, 'fork-b'],
  ]) {
    const h = harness(t, { queryId: id });
    await h.observer.prepareBaseline({ [method]: async () => snapshot(start) });
    h.observer(result(finish, { session_id: session })); records.push(...h.records);
  }
  assert.equal(total(aggregated(records)), 192);
});

test('fresh Queries need no baseline control and retain every new token', async t => {
  let calls = 0;
  const h = harness(t, { inheritedCounters: false });
  assert.deepEqual(await h.observer.prepareBaseline({ [method]() { calls++; throw Error('unexpected'); } }), { status: 'ready' });
  h.observer(result(20)); assert.equal(calls, 0); assert.equal(total(aggregated(h.records)), 20);
});

test('simultaneous Query baselines completing in reverse order remain independent', async t => {
  const first = harness(t, { queryId: 'parallel-a' }), second = harness(t, { queryId: 'parallel-b' });
  const a = deferred(), b = deferred();
  const preparedA = first.observer.prepareBaseline({ [method]: () => a.promise });
  const preparedB = second.observer.prepareBaseline({ [method]: () => b.promise });
  b.resolve(snapshot(200)); await preparedB;
  second.observer(result(207, { session_id: 'fork-b' }));
  a.resolve(snapshot(100)); await preparedA;
  first.observer(result(110, { session_id: 'fork-a' }));
  assert.equal(total(aggregated([...first.records, ...second.records])), 17);
});

test('baseline preparation is one shared request and cumulative checkpoints/final result are differenced once', async t => {
  const pending = deferred(); let calls = 0, current = snapshot(100);
  const query = { [method]() { calls++; return calls === 1 ? pending.promise : Promise.resolve(current); } };
  const h = harness(t); h.observer.attach(query);
  const first = h.observer.prepareBaseline(query);
  assert.equal(h.observer.prepareBaseline(query), first);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve(snapshot(100)); await first;
  current = snapshot(110); h.observer(activity()); await pause(25);
  current = snapshot(115); h.observer(activity()); await pause(25);
  h.observer(result(115)); h.observer(result(115));
  assert.equal(total(aggregated(h.records)), 15);
  assert.equal(h.records.filter(record => record.resultId === 'result-115').length, 1);
});

test('/clear removes inherited baseline and late old-session checkpoints cannot alter new counters', async t => {
  const pending = deferred(); let calls = 0;
  const query = { [method]() { return ++calls === 1 ? Promise.resolve(snapshot(100)) : pending.promise; } };
  const h = harness(t); h.observer.attach(query); await h.observer.prepareBaseline(query);
  h.observer(result(110)); h.observer(activity()); await pause(5);
  h.observer({ type: 'conversation_reset', uuid: 'clear', new_conversation_id: 'cleared' });
  pending.resolve(snapshot(999)); await pause(5);
  h.observer(result(3, { uuid: 'after-clear', session_id: 'session' }));
  assert.equal(total(aggregated(h.records)), 13);
  assert.equal(h.records.at(-1).sessionId, 'cleared');
  assert.equal(h.records.at(-1).modelUsage['fixture/model'].inputTokens, 3);
});

test('unknown baseline records incomplete coverage and first complete snapshot cannot charge inherited history', async t => {
  for (const query of [{}, { [method]() { throw Error('private failure'); } },
    { [method]: async () => ({ session: { model_usage: { broken: { inputTokens: 500 } } } }) }]) {
    const h = harness(t);
    assert.deepEqual(await h.observer.prepareBaseline(query), { status: 'unavailable' });
    h.observer(result(0, { modelUsage: {} })); // Empty local ACK must not establish zero.
    h.observer(result(100));
    const unknown = aggregated(h.records);
    const view = buildSnapshot(unknown, { available: true, complete: true, warnings: [] }, true, Date.parse(at)).windows[7];
    assert.equal(view.tokens.available, false);
    assert.ok(view.coverage.warningCodes.includes('USAGE_BASELINE_UNAVAILABLE'));
    h.observer(result(110));
    assert.equal(total(aggregated(h.records)), 10);
    assert.doesNotMatch(JSON.stringify(h.records), /private failure/);
  }
});

test('a timed-out baseline never queues repeated controls or accepts a late historical response', async t => {
  const pending = deferred(); let calls = 0;
  const query = { [method]() { calls++; return pending.promise; } };
  const h = harness(t); h.observer.attach(query);
  assert.deepEqual(await h.observer.prepareBaseline(query, { timeoutMs: 10 }), { status: 'unavailable' });
  h.observer(activity()); await pause(20); assert.equal(calls, 1);
  h.observer(result(100)); pending.resolve(snapshot(999)); await pause(5);
  h.observer(result(110)); assert.equal(total(aggregated(h.records)), 10);
});

test('an uncounted fallback baseline result cannot replay as new spending after /clear', async t => {
  const h = harness(t); await h.observer.prepareBaseline({});
  h.observer(result(100));
  h.observer({ type: 'conversation_reset', uuid: 'clear', new_conversation_id: 'cleared' });
  h.observer(result(100));
  h.observer(result(3, { uuid: 'cleared-result', session_id: 'cleared' }));
  assert.equal(total(aggregated(h.records)), 3);
});

test('cancellation settles preparation immediately and late responses cannot publish usage after close', async t => {
  const pending = deferred(), controller = new AbortController();
  const h = harness(t);
  const preparation = h.observer.prepareBaseline({ [method]: () => pending.promise }, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  assert.deepEqual(await preparation, { status: 'canceled' });
  h.observer.close(); const before = h.records.length;
  pending.resolve(snapshot(999)); await pause(5); h.observer(result(1000));
  assert.equal(h.records.length, before);
});

test('partial and lower snapshots cannot erase a historical model baseline or duplicate other models', async t => {
  const h = harness(t);
  await h.observer.prepareBaseline({ [method]: async () => ({ session: { model_usage: {
    'fixture/model': counters(100), child: counters(50),
  } } }) });
  h.observer(result(110));
  h.observer(result(105, { uuid: 'late', modelUsage: { 'fixture/model': counters(105), child: counters(55), fresh: counters(3) } }));
  h.observer(result(115, { uuid: 'next', modelUsage: { 'fixture/model': counters(115), child: counters(57), fresh: counters(5) } }));
  const index = aggregated(h.records), models = Object.values(index.usage.days)[0].models;
  assert.equal(models['fixture/model'].inputTokens, 15); assert.equal(models.child.inputTokens, 7); assert.equal(models.fresh.inputTokens, 5);
});

test('coverage markers survive the worker boundary without transcript or inherited usage data', () => {
  const normalized = normalizeUsageRecord({ queryId: 'query', resultId: 'baseline-unavailable:0', at, startedAt: at,
    modelUsage: {}, usageIncomplete: true, inheritedTokens: 999, privateText: 'SECRET' });
  assert.equal(normalized.usageIncomplete, true);
  assert.deepEqual(Object.keys(normalized.modelUsage), []);
  assert.doesNotMatch(JSON.stringify(normalized), /SECRET|999|inheritedTokens/);
});
