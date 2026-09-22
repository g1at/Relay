'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UsageStatsService, normalizeUsageRecord, configurationKey } = require('../src/main/usage/usage-stats-service');
const { summarizeConversation, applyUsageRecord, refreshStats, emptyIndex } = require('../src/main/usage/usage-stats-worker');

const NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86400000;
const when = days => new Date(NOW - days * DAY).toISOString();
const counters = (input = 10, output = 4, read = 2, write = 1) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write });
const usage = (patch = {}) => ({ queryId: 'query-one', sessionId: 'session-one', resultId: 'result-one', at: when(0), startedAt: when(0), modelUsage: { 'provider/model-one': counters() }, ...patch });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-'));
  const historyDir = path.join(root, 'history');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(historyDir); fs.mkdirSync(cacheDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, historyDir, cacheDir, configKey: configurationKey(historyDir) };
}
function history(options, id, turns, patch = {}) {
  fs.writeFileSync(path.join(options.historyDir, id + '.json'), JSON.stringify({ id, title: 'PRIVATE_TITLE', turns, ...patch }));
}
function appendUsage(options, ...records) {
  fs.appendFileSync(path.join(options.cacheDir, 'usage-events-v1.jsonl'), records.map(record => JSON.stringify(record) + '\n').join(''));
}

test('only numeric SDK counters and opaque identifiers cross the worker boundary', () => {
  const value = normalizeUsageRecord(usage({ result: 'PRIVATE_ANSWER', message: { content: 'PRIVATE_MESSAGE' }, usage: { input_tokens: 999 }, modelUsage: {
    real: { ...counters(), costUSD: 123, content: 'PRIVATE_CONTENT', webSearchRequests: 20 },
    incomplete: { inputTokens: 1, outputTokens: 2 }, bad: counters(-1),
  } }));
  assert.deepEqual(Object.keys(value.modelUsage), ['real']);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(value).includes('costUSD'), false);
  assert.equal(Object.hasOwn(value, 'usage'), false, 'per-turn main-loop usage is never mixed with cumulative modelUsage');
  assert.equal(normalizeUsageRecord(usage({ modelUsage: {} })), null);
  assert.equal(normalizeUsageRecord(usage({ isError: true, modelUsage: { real: counters(0, 0, 0, 0) } })), null);
});

test('result snapshots are differenced per query/session and only explicit new epochs reset counters', () => {
  const state = emptyIndex('test').usage;
  assert.equal(applyUsageRecord(state, usage()), true);
  assert.equal(applyUsageRecord(state, usage()), false);
  applyUsageRecord(state, usage({ resultId: 'r2', modelUsage: { 'provider/model-one': counters(15, 8, 5, 2), subagent: counters(2, 3, 0, 0) } }));
  applyUsageRecord(state, usage({ queryId: 'query-two', resultId: 'r3', modelUsage: { 'provider/model-one': counters(3, 1, 0, 0) } }));
  applyUsageRecord(state, usage({ sessionId: 'new-session', resultId: 'r4', modelUsage: { 'provider/model-one': counters(2, 1, 0, 0) } }));
  applyUsageRecord(state, usage({ resultId: 'r5', modelUsage: { 'provider/model-one': counters(1, 1, 0, 0) } }));
  const bucket = Object.values(state.days)[0];
  assert.equal(bucket.results, 5);
  assert.deepEqual(bucket.models['provider/model-one'], counters(20, 10, 5, 2));
  assert.deepEqual(bucket.models.subagent, counters(2, 3, 0, 0));
});

test('running checkpoints count before a terminal result and final cumulative totals add only the missing difference', async t => {
  const options = fixture(t);
  appendUsage(options, usage({ resultId: 'usage-checkpoint:0:1', modelUsage: { model: counters(100, 20, 40, 5) } }));
  const running = await refreshStats(options, null, NOW);
  assert.equal(running.snapshot.windows[7].tokens.available, true);
  assert.equal(running.snapshot.windows[7].tokens.totalTokens, 165);
  appendUsage(options,
    usage({ resultId: 'usage-checkpoint:0:1', modelUsage: { model: counters(100, 20, 40, 5) } }),
    usage({ resultId: 'usage-checkpoint:0:2', modelUsage: { model: counters(110, 25, 50, 5) } }),
    usage({ resultId: 'terminal-error', isError: true, modelUsage: { model: counters(120, 30, 60, 5) } }));
  const finished = await refreshStats(options, running.index, NOW);
  assert.equal(finished.snapshot.windows[7].tokens.totalTokens, 215, 'checkpoints and terminal error describe the same cumulative spending');
  assert.equal(finished.snapshot.windows[7].tokens.recordedResults, 3, 'the field counts distinct metric records, not completed tasks');
  assert.equal(finished.snapshot.windows[7].tokens.byModel[0].outputTokens, 30);
});

test('a persisted running checkpoint survives abrupt worker termination without a result or graceful flush', async t => {
  const { Worker } = require('node:worker_threads');
  const options = fixture(t);
  const worker = new Worker(path.join(__dirname, '../src/main/usage/usage-stats-worker.js'), { workerData: options });
  t.after(() => worker.terminate());
  const checkpoint = normalizeUsageRecord(usage({ resultId: 'usage-checkpoint:0:1', modelUsage: { model: counters(80, 15, 20, 0) } }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('checkpoint was not persisted')), 5000);
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.on('message', message => {
      if (message.type !== 'usage-ack' || message.id !== checkpoint.id) return;
      clearTimeout(timer);
      if (message.ok) resolve(); else reject(Error('checkpoint write failed'));
    });
    worker.postMessage({ type: 'usage', record: checkpoint });
  });
  await worker.terminate();
  const recovered = await refreshStats(options, null, NOW);
  assert.equal(recovered.snapshot.windows[7].tokens.totalTokens, 115);
  assert.equal(recovered.snapshot.windows[7].tokens.available, true);
  assert.equal(recovered.snapshot.windows[7].tokens.recordedResults, 1);
});

test('SDK model identifiers cannot mutate prototype or disappear from totals', () => {
  const state = emptyIndex('test').usage;
  const modelUsage = JSON.parse('{"__proto__":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"cacheCreationInputTokens":4}}');
  applyUsageRecord(state, usage({ modelUsage }));
  assert.equal(Object.prototype.inputTokens, undefined);
  assert.equal(Object.values(state.days)[0].models.__proto__.inputTokens, 1);
  assert.match(JSON.stringify(state), /__proto__/);
});

test('history summaries retain dates/counts only, count supplements and never use a renamed updatedAt', () => {
  const summary = summarizeConversation({ id: 'conv', title: 'PRIVATE_TITLE', updatedAt: when(0), turns: [
    { user: 'PRIVATE_PROMPT', assistant: 'PRIVATE_ANSWER', ts: when(2), supplements: [{ id: 'steer1', text: 'PRIVATE_STEER', ts: when(1) }, { id: 'steer1', text: 'duplicate', ts: when(1) }] },
    { user: 'unknown date', ts: 'invalid' }, { assistant: 'only assistant', ts: when(0) },
    { files: [{ path: 'PRIVATE_FILE' }], ts: when(3) },
  ] });
  assert.equal(Object.values(summary.days).reduce((a, b) => a + b, 0), 3);
  assert.equal(summary.unknownTimes, 1);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  assert.equal(Object.keys(summary.days).some(day => day === when(0).slice(0, 10)), false);
});

test('all metrics use the same 7/30/90-day window and use dates of input/result, not current titles', async t => {
  const options = fixture(t);
  history(options, 'one', [0, 10, 45, 100].map(days => ({ user: 'PRIVATE_BODY', ts: when(days) })));
  history(options, 'two', [{ user: 'PRIVATE_BODY', ts: when(20) }]);
  for (const [i, days] of [0, 10, 45, 100].entries()) appendUsage(options, usage({ queryId: 'q' + i, resultId: 'r' + i, at: when(days), startedAt: when(days), modelUsage: { model: counters(10, 1, 2, 3) } }));
  const result = await refreshStats(options, null, NOW);
  for (const [days, messages, conversations, totalTokens] of [[7, 1, 1, 16], [30, 3, 2, 32], [90, 4, 2, 48]]) {
    const view = result.snapshot.windows[days];
    assert.equal(view.days, days);
    assert.deepEqual(view.totals, { messages, conversations });
    assert.equal(view.daily.length, days);
    assert.equal(view.daily.reduce((sum, item) => sum + item.count, 0), messages);
    assert.equal(view.tokens.totalTokens, totalTokens);
    assert.equal(view.tokens.byModel[0].count, totalTokens);
    assert.equal(view.tokens.coverage, 'partial');
  }
  for (const file of fs.readdirSync(options.cacheDir)) assert.equal(fs.readFileSync(path.join(options.cacheDir, file), 'utf8').includes('PRIVATE'), false);
  assert.ok(fs.statSync(path.join(options.cacheDir, 'usage-snapshot-v1.json')).size < 512 * 1024);
});

test('unchanged history is not reread and JSONL refresh consumes only new complete records', async t => {
  const options = fixture(t);
  history(options, 'one', [{ user: 'old', ts: when(0) }]);
  appendUsage(options, usage());
  const first = await refreshStats(options, null, NOW);
  const second = await refreshStats(options, first.index, NOW);
  assert.equal(second.diagnostics.scannedHistoryFiles, 0);
  assert.equal(second.diagnostics.scannedUsageBytes, 0);
  history(options, 'one', [{ user: 'old', ts: when(0) }, { user: 'new', ts: when(0) }]);
  const row = JSON.stringify(usage({ resultId: 'second', modelUsage: { 'provider/model-one': counters(20, 8, 4, 2) } }));
  const journal = path.join(options.cacheDir, 'usage-events-v1.jsonl');
  fs.appendFileSync(journal, row.slice(0, 50));
  const partial = await refreshStats(options, second.index, NOW);
  assert.equal(partial.snapshot.windows[7].tokens.totalTokens, 17);
  fs.appendFileSync(journal, row.slice(50) + '\n');
  const third = await refreshStats(options, partial.index, NOW);
  assert.equal(third.snapshot.windows[7].tokens.totalTokens, 34);
  assert.equal(third.snapshot.windows[7].totals.messages, 2);
  assert.ok(third.diagnostics.scannedUsageBytes < fs.statSync(journal).size);
});

test('truncation/replacement rebuilds counters instead of keeping stale totals or double counting', async t => {
  const options = fixture(t);
  appendUsage(options, usage());
  const first = await refreshStats(options, null, NOW);
  fs.writeFileSync(path.join(options.cacheDir, 'usage-events-v1.jsonl'), JSON.stringify(usage({ resultId: 'replace', modelUsage: { m: counters(1, 1, 0, 0) } })) + '\n');
  const replaced = await refreshStats(options, first.index, NOW);
  assert.equal(replaced.snapshot.windows[7].tokens.totalTokens, 2);
});

test('history parse/read failure preserves previous known numbers and exposes incomplete coverage', async t => {
  const options = fixture(t);
  history(options, 'one', [{ user: 'valid', ts: when(0) }]);
  const first = await refreshStats(options, null, NOW);
  fs.writeFileSync(path.join(options.historyDir, 'one.json'), '{bad');
  const partial = await refreshStats(options, first.index, NOW);
  assert.equal(partial.snapshot.windows[7].totals.messages, 1);
  assert.equal(partial.snapshot.windows[7].coverage.history, 'partial');
  assert.equal(partial.snapshot.windows[7].tokens.available, false);
  assert.equal(partial.snapshot.windows[7].tokens.totalTokens, null);
  fs.rmSync(path.join(options.historyDir, 'one.json'));
  const empty = await refreshStats(options, partial.index, NOW);
  assert.equal(empty.snapshot.windows[7].totals.messages, 0, 'a successfully scanned empty history has a real zero');
  fs.rmSync(options.historyDir, { recursive: true });
  const missing = await refreshStats(options, null, NOW);
  assert.equal(missing.snapshot.windows[7].totals.messages, null, 'an unreadable initial source is unknown, not zero');
  assert.equal(missing.snapshot.windows[7].coverage.history, 'unknown');
});

test('malformed usage rows expose incomplete coverage without erasing good counters', async t => {
  const options = fixture(t);
  appendUsage(options, usage());
  fs.appendFileSync(path.join(options.cacheDir, 'usage-events-v1.jsonl'), '{bad}\n');
  const result = await refreshStats(options, null, NOW);
  assert.equal(result.snapshot.windows[7].tokens.totalTokens, 17);
  assert.ok(result.snapshot.windows[7].coverage.warningCodes.includes('USAGE_RECORDS_PARTIAL'));
});

test('real worker persists metric-only events, flushes, and restores an immediate small snapshot', async t => {
  const options = fixture(t);
  history(options, 'one', [{ user: 'PRIVATE_HISTORY', ts: when(0) }]);
  const service = new UsageStatsService({ ...options, now: () => NOW });
  t.after(() => service.destroy());
  const cold = service.overview({ days: 7 });
  assert.equal(cold.available, false);
  assert.equal(cold.totals.messages, null);
  assert.equal(cold.refreshing, true);
  assert.equal(service.recordUsage(usage({ result: 'PRIVATE_RESULT' })).ok, true);
  assert.equal((await service.flush()).ok, true);
  assert.equal((await service.refresh({ force: true })).ok, true);
  const warm = service.overview({ days: 7 });
  assert.equal(warm.totals.messages, 1);
  assert.equal(warm.tokens.totalTokens, 17);
  assert.equal(await service.destroy().then(value => value.ok), true);
  const restored = new UsageStatsService({ ...options, now: () => NOW });
  t.after(() => restored.destroy());
  const cached = restored.overview({ days: 7 });
  assert.equal(cached.available, true);
  assert.equal(cached.tokens.totalTokens, 17);
  for (const file of fs.readdirSync(options.cacheDir)) assert.equal(fs.readFileSync(path.join(options.cacheDir, file), 'utf8').includes('PRIVATE'), false);
});

class ControlledWorker extends EventEmitter {
  static instances = [];
  constructor() { super(); this.messages = []; ControlledWorker.instances.push(this); }
  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'flush') queueMicrotask(() => this.emit('message', { requestId: message.requestId, ok: true }));
  }
  unref() {}
  terminate() { return Promise.resolve(0); }
}

test('overview returns cached values while refresh is single-flight; failed refresh never supplies false zeros', async t => {
  const options = fixture(t);
  history(options, 'one', [{ user: 'known', ts: when(0) }]);
  await refreshStats(options, null, NOW);
  const notifications = [];
  const service = new UsageStatsService({ ...options, now: () => NOW, WorkerClass: ControlledWorker, onUpdated: value => notifications.push(value) });
  const one = service.overview({ days: 7, force: true });
  const two = service.overview({ days: 30, force: true });
  assert.equal(one.totals.messages, 1); assert.equal(two.totals.messages, 1);
  const worker = ControlledWorker.instances.at(-1);
  assert.equal(worker.messages.filter(message => message.type === 'refresh').length, 1);
  worker.emit('error', new Error('PRIVATE_ERROR_DETAILS'));
  const failed = await service.refreshPromise;
  assert.equal(failed.ok, false);
  const state = service.overview({ days: 7 });
  assert.equal(state.totals.messages, 1);
  assert.equal(state.stale, true);
  assert.ok(state.error);
  assert.equal(JSON.stringify(state).includes('PRIVATE_ERROR_DETAILS'), false);
  assert.ok(notifications.length);
  await service.destroy();
});

test('new usage remains dirty even if acknowledged before an older refresh snapshot arrives', async t => {
  const options = fixture(t);
  const existing = await refreshStats(options, null, NOW);
  const service = new UsageStatsService({ ...options, now: () => NOW, WorkerClass: ControlledWorker });
  const pendingRefresh = service.refresh({ force: true });
  const worker = ControlledWorker.instances.at(-1);
  service.recordUsage(usage());
  const event = worker.messages.find(message => message.type === 'usage');
  worker.emit('message', { type: 'usage-ack', id: event.record.id, ok: true });
  assert.equal(service.pending.size, 0);
  const request = worker.messages.find(message => message.type === 'refresh');
  worker.emit('message', { requestId: request.requestId, ok: true, snapshot: existing.snapshot });
  await pendingRefresh;
  const view = service.overview({ days: 7 });
  assert.equal(view.stale, true);
  assert.equal(service.dirty, true);
  await service.destroy();
});

test('worker timeouts keep cached values and pending metrics; shutdown has a bounded wait', async t => {
  const options = fixture(t);
  class HangingWorker extends ControlledWorker { postMessage(message) { this.messages.push(message); } }
  const service = new UsageStatsService({ ...options, now: () => NOW, WorkerClass: HangingWorker, refreshTimeoutMs: 25, flushTimeoutMs: 25 });
  service.recordUsage(usage());
  const refreshed = await service.refresh({ force: true });
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.error.code, 'STATS_TIMEOUT');
  assert.equal(service.pending.size, 1);
  const start = Date.now();
  const stopped = await service.destroy();
  assert.equal(stopped.ok, false);
  assert.equal(service.pending.size, 1, 'unacknowledged data is not silently declared durable');
  assert.ok(Date.now() - start < 1000);
});

test('a crashed trailing journal row cannot swallow the next valid metric record', async t => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.cacheDir, 'usage-events-v1.jsonl'), '{"queryId":"unfinished');
  const service = new UsageStatsService({ ...options, now: () => NOW });
  t.after(() => service.destroy());
  service.recordUsage(usage());
  assert.equal((await service.flush()).ok, true);
  await service.refresh({ force: true });
  const view = service.overview({ days: 7 });
  assert.equal(view.tokens.totalTokens, 17);
  assert.ok(view.coverage.warningCodes.includes('USAGE_RECORDS_PARTIAL'));
});

test('cross-day streaming results attribute only the new cumulative delta to the selected period', async t => {
  const options = fixture(t);
  appendUsage(options,
    usage({ resultId: 'old', at: when(45), modelUsage: { model: counters(100, 40, 20, 10) } }),
    usage({ resultId: 'new', at: when(0), modelUsage: { model: counters(150, 60, 25, 12) } }),
  );
  const result = await refreshStats(options, null, NOW);
  assert.equal(result.snapshot.windows[7].tokens.totalTokens, 77);
  assert.equal(result.snapshot.windows[90].tokens.totalTokens, 247);
});

test('a malformed derived index is rebuilt from source records instead of publishing invented counters', async t => {
  const options = fixture(t);
  history(options, 'one', [{ user: 'real input', ts: when(0) }]);
  appendUsage(options, usage());
  const first = await refreshStats(options, null, NOW);
  const corrupt = JSON.parse(JSON.stringify(first.index));
  corrupt.usage.days[when(0).slice(0, 10)].models['provider/model-one'].inputTokens = -100;
  const rebuilt = await refreshStats(options, corrupt, NOW);
  assert.equal(rebuilt.snapshot.windows[7].tokens.totalTokens, 17);
  assert.equal(rebuilt.snapshot.windows[7].totals.messages, 1);
  assert.equal(rebuilt.diagnostics.scannedHistoryFiles, 1);
});

test('a successful display refresh cannot hide an unpersisted metric; the next refresh retries it', async t => {
  const options = fixture(t);
  const baseline = await refreshStats(options, null, NOW);
  const service = new UsageStatsService({ ...options, now: () => NOW, WorkerClass: ControlledWorker });
  service.recordUsage(usage());
  const worker = ControlledWorker.instances.at(-1);
  const record = worker.messages.find(message => message.type === 'usage').record;
  worker.emit('message', { type: 'usage-ack', id: record.id, ok: false });
  const first = service.refresh({ force: true });
  const request = worker.messages.filter(message => message.type === 'refresh').at(-1);
  worker.emit('message', { requestId: request.requestId, ok: true, snapshot: baseline.snapshot });
  await first;
  const failed = service.overview({ days: 7 });
  assert.equal(failed.error.code, 'USAGE_WRITE_FAILED');
  assert.equal(failed.stale, true);
  const sent = worker.messages.filter(message => message.type === 'usage').length;
  const second = service.refresh({ force: true });
  assert.equal(worker.messages.filter(message => message.type === 'usage').length, sent + 1);
  worker.emit('message', { type: 'usage-ack', id: record.id, ok: true });
  const next = worker.messages.filter(message => message.type === 'refresh').at(-1);
  worker.emit('message', { requestId: next.requestId, ok: true, snapshot: baseline.snapshot });
  await second;
  assert.equal(service.overview({ days: 7 }).error, null);
  assert.equal(service.dirty, false);
  await service.destroy();
});

test('daily Token totals reuse exact journal buckets with no additional history scan', () => {
  const { tokenDailyView } = require('../src/main/usage/usage-stats-worker');
  const data = { recordingStartedAt: '2026-09-07T00:00:00', days: { '2026-09-07': { results: 1, models: { one: counters(10, 4, 2, 1) } }, '2026-09-09': { results: 1, models: { two: counters(20, 8, 4, 2) } } } };
  const daily = tokenDailyView(['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'], data, true);
  assert.deepEqual(daily.map(day => day.totalTokens), [null, 17, 0, 34]);
  assert.deepEqual(daily[1], { date: '2026-09-07', inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 1, totalTokens: 17 });
  assert.equal(tokenDailyView(['2026-09-08'], data, false)[0].totalTokens, null);
  assert.equal(tokenDailyView(['2026-09-07'], data, false)[0].totalTokens, 17);
});
test('new daily Token fields preserve additive range totals and never invent records before recording began', () => {
  const { buildSnapshot } = require('../src/main/usage/usage-stats-worker');
  const index = emptyIndex('synthetic'); applyUsageRecord(index.usage, usage());
  const result = buildSnapshot(index, { available: true, complete: true, warnings: [] }, true, NOW);
  for (const days of [7, 30, 90]) {
    const tokens = result.windows[String(days)].tokens;
    assert.equal(tokens.daily.length, days); assert.equal(tokens.daily.at(-1).totalTokens, tokens.totalTokens);
    assert.ok(tokens.daily.slice(0, -1).every(day => day.totalTokens === null));
    assert.equal(tokens.daily.reduce((total, day) => total + (day.totalTokens ?? 0), 0), tokens.totalTokens);
  }
  const empty = buildSnapshot(emptyIndex('empty'), { available: true, complete: true, warnings: [] }, true, NOW);
  assert.equal(empty.windows['7'].tokens.available, false); assert.deepEqual(empty.windows['7'].tokens.daily, []);
});

test('late and mixed cumulative snapshots retain per-field maxima without resetting other models', () => {
  const state = emptyIndex('test').usage;
  applyUsageRecord(state, usage({ resultId: 'latest', modelUsage: { main: counters(100, 40, 80, 10), child: counters(20, 5, 30, 2) } }));
  applyUsageRecord(state, usage({ resultId: 'late', modelUsage: { main: counters(50, 20, 40, 5) } }));
  applyUsageRecord(state, usage({ resultId: 'mixed', modelUsage: { main: counters(90, 45, 85, 9) } }));
  applyUsageRecord(state, usage({ resultId: 'next', modelUsage: { main: counters(110, 50, 90, 12), child: counters(22, 7, 35, 3) } }));
  const models = Object.values(state.days)[0].models;
  assert.deepEqual(models.main, counters(110, 50, 90, 12));
  assert.deepEqual(models.child, counters(22, 7, 35, 3));
});

test('missing model counters stay unknown and cannot erase a previous baseline', () => {
  const state = emptyIndex('test').usage;
  applyUsageRecord(state, usage({ resultId: 'first', modelUsage: { main: counters(100, 40, 80, 10), child: counters(20, 5, 30, 2) } }));
  applyUsageRecord(state, usage({ resultId: 'partial', modelUsage: { main: { inputTokens: 105, outputTokens: 43 }, child: counters(21, 6, 31, 3) } }));
  applyUsageRecord(state, usage({ resultId: 'complete', modelUsage: { main: counters(110, 45, 90, 12), child: counters(22, 7, 35, 4) } }));
  const models = Object.values(state.days)[0].models;
  assert.deepEqual(models.main, counters(110, 45, 90, 12));
  assert.deepEqual(models.child, counters(22, 7, 35, 4));
});

test('a replayed result UUID cannot charge again under a new session wrapper', () => {
  const state = emptyIndex('test').usage;
  applyUsageRecord(state, usage());
  assert.equal(applyUsageRecord(state, usage({ sessionId: 'after-reset' })), false);
  applyUsageRecord(state, usage({ sessionId: 'after-reset', resultId: 'reset-result',
    modelUsage: { 'provider/model-one': counters(1, 2, 0, 0) } }));
  applyUsageRecord(state, usage({ queryId: 'resumed-query', modelUsage: { 'provider/model-one': counters(3, 4, 0, 0) } }));
  assert.deepEqual(Object.values(state.days)[0].models['provider/model-one'], counters(14, 10, 2, 1));
});

test('old aggregation indexes rebuild in the worker while their display snapshot remains immediately usable', async t => {
  const options = fixture(t);
  history(options, 'fixture', [{ user: 'synthetic', ts: when(0) }]);
  appendUsage(options, usage({ resultId: 'latest', modelUsage: { main: counters(100, 40, 80, 10) } }),
    usage({ resultId: 'late', modelUsage: { main: counters(50, 20, 40, 5) } }));
  const first = await refreshStats(options, null, NOW);
  const old = JSON.parse(JSON.stringify(first.index));
  delete old.usage.aggregationVersion;
  Object.values(old.usage.days)[0].models.main = counters(150, 60, 120, 15);
  const oldSnapshot = JSON.parse(JSON.stringify(first.snapshot));
  for (const value of Object.values(oldSnapshot.windows)) Object.assign(value.tokens, {
    inputTokens: 150, outputTokens: 60, cacheReadTokens: 120, cacheCreationTokens: 15, totalTokens: 345,
  });
  fs.writeFileSync(path.join(options.cacheDir, 'usage-index-v1.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(options.cacheDir, 'usage-snapshot-v1.json'), JSON.stringify(oldSnapshot));
  const service = new UsageStatsService({ ...options, now: () => NOW, refreshIntervalMs: 60000 });
  t.after(() => service.destroy());
  const immediate = service.overview({ days: 7 });
  assert.equal(immediate.tokens.totalTokens, 345, 'warm display appears before background replay');
  assert.equal(immediate.refreshing, true);
  await service.refresh({ force: true });
  assert.equal(service.snapshot.windows[7].tokens.totalTokens, 230, 'worker must replace the old inflated aggregation');
  const rebuiltIndex = JSON.parse(fs.readFileSync(path.join(options.cacheDir, 'usage-index-v1.json'), 'utf8'));
  assert.equal(rebuiltIndex.usage.aggregationVersion, 2);
  assert.deepEqual(Object.values(rebuiltIndex.usage.days)[0].models.main, counters(100, 40, 80, 10));

});
