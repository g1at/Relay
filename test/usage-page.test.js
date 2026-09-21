'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, createController, formatNumber, formatFullNumber, formatPercent, buildActivityHeatmap, buildTrendSeries, buildTrendGeometry, getRecordedTokenPeak } = require('../renderer/usage-page');
function snapshot(days = 30, messages = 5, extra = {}) {
  return { ok: true, available: true, days, generatedAt: '2026-09-09T00:00:00Z', totals: { messages }, daily: Array.from({ length: days }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 9 - days + 1 + index)).toISOString().slice(0, 10), count: index === days - 1 ? messages : 0 })), tokens: { available: true, inputTokens: 100, outputTokens: 30, cacheReadTokens: 50, cacheCreationTokens: 20, byModel: [{ key: 'route/model-one', count: 200 }], coverage: 'partial' }, coverage: { history: 'complete' }, ...extra };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overview) {
  const listeners = new Set(), timers = new Map(); let timerId = 0;
  return { api: { overview, onUpdated(listener) { listeners.add(listener); return () => listeners.delete(listener); } }, listeners, timers, schedule(fn) { timers.set(++timerId, fn); return timerId; }, cancel(id) { timers.delete(id); } };
}
function controller(f, onChange = () => {}) { return createController({ api: f.api, onChange, schedule: f.schedule, cancel: f.cancel }); }

test('unavailable snapshots, mismatched ranges and unknown token values never become zero', () => {
  assert.equal(normalizeSnapshot(snapshot(30, 5, { available: false }), 30), null);
  assert.equal(normalizeSnapshot(snapshot(30), 7), null);
  const data = normalizeSnapshot(snapshot(30, 5, { tokens: { available: false, inputTokens: 0 } }), 30);
  assert.equal(data.tokenTotal, null); assert.deepEqual(data.models, []);
  for (const value of [undefined, null, NaN, Infinity, -1, '0']) assert.equal(formatNumber(value), '—');
  assert.equal(formatNumber(0), '0');
});
test('only complete numeric token components are summed and invalid model values are excluded', () => {
  const data = normalizeSnapshot(snapshot(), 30);
  assert.equal(data.tokenTotal, 200); assert.equal(data.activeDays, 1); assert.equal(data.tokenCoverage, 'partial');
  assert.equal(normalizeSnapshot(snapshot(30, 5, { tokens: { available: true, inputTokens: 100 } }), 30).tokenTotal, null);
  const partial = normalizeSnapshot(snapshot(30, 5, { daily: [{ date: '2026-09-09', count: 1 }], tokens: { available: true, totalTokens: 30, byModel: [{ key: 'safe', count: 30 }, { key: 'bad', count: Infinity }, { key: 'unknown', count: null }] } }), 30);
  assert.equal(partial.activeDays, null); assert.deepEqual(partial.models, [{ name: 'safe', count: 30 }]);
});
test('reopening uses an in-memory snapshot before making any request', async () => {
  let calls = 0; const f = fixture(async days => { calls++; return snapshot(days); });
  const first = controller(f); await first.refresh(); first.destroy();
  const frames = [], second = controller(f, state => frames.push(state));
  assert.equal(frames[0].snapshot.messages, 5); assert.equal(calls, 1); assert.equal(f.listeners.size, 1); second.destroy(); assert.equal(f.listeners.size, 0);
});
test('range changes preserve a clearly identified previous snapshot and late responses cannot replace the selected range', async () => {
  const seven = deferred(), ninety = deferred();
  const f = fixture(days => days === 30 ? Promise.resolve(snapshot(30, 30)) : days === 7 ? seven.promise : ninety.promise);
  const c = controller(f); await c.refresh(); c.setRange(7);
  assert.equal(c.getState().days, 7); assert.equal(c.getState().snapshot.days, 30); assert.equal(c.getState().pending, true);
  c.setRange(90); ninety.resolve(snapshot(90, 90)); await ninety.promise; await Promise.resolve();
  seven.resolve(snapshot(7, 7)); await seven.promise; await Promise.resolve();
  assert.equal(c.getState().days, 90); assert.equal(c.getState().snapshot.messages, 90); c.destroy();
});
test('slow, failed and worker refresh responses keep usable data and expose retry without polling', async () => {
  let reply = snapshot(), count = 0; const f = fixture(async () => { count++; if (reply instanceof Error) throw reply; return reply; });
  const c = controller(f); await c.refresh();
  reply = { ...snapshot(), refreshing: true, stale: true }; await c.refresh();
  assert.equal(c.getState().snapshot.messages, 5); assert.equal(c.getState().pending, true);
  for (const run of f.timers.values()) run(); assert.equal(c.getState().slow, true); assert.equal(count, 2);
  reply = new Error('private/path/should/not/render'); await c.refresh();
  assert.equal(c.getState().snapshot.messages, 5); assert.equal(c.getState().error, '暂时无法更新统计'); assert.equal(c.getState().pending, false); c.destroy();
});
test('only explicit refresh asks for a force scan, and destroy ignores events and delayed responses', async () => {
  const pending = deferred(), calls = [];
  const f = fixture((days, options) => { calls.push({ days, options }); return calls.length < 3 ? Promise.resolve(snapshot(days)) : pending.promise; });
  let frames = 0; const c = controller(f, () => frames++);
  await c.refresh(); await c.refresh(true);
  assert.equal(calls[0].options.refresh, false); assert.equal(calls[1].options.refresh, true);
  const late = c.refresh(); const before = frames; c.destroy(); pending.resolve(snapshot(30, 999)); await late;
  assert.equal(frames, before); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
});
test('worker update notifications refresh once without replacing current values with placeholders', async () => {
  let messages = 5, calls = 0; const f = fixture(async days => { calls++; return snapshot(days, messages); });
  const c = controller(f); await c.refresh(); messages = 8;
  for (const listener of f.listeners) listener(); assert.equal(c.getState().snapshot.messages, 5);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.getState().snapshot.messages, 8); assert.equal(calls, 2); c.destroy();
});
test('profile heatmap preserves the selected date range and aligns real days to Monday-based weeks', () => {
  for (const days of [7, 30, 90]) {
    const data = normalizeSnapshot(snapshot(days), days), heatmap = buildActivityHeatmap(data);
    assert.equal(heatmap.cells.length, days); assert.equal(heatmap.state, 'ready');
    assert.equal(heatmap.cells[0].date, data.daily[0].date); assert.equal(heatmap.cells.at(-1).date, '2026-09-09');
    assert.equal(heatmap.leading, (new Date(data.daily[0].date + 'T00:00:00Z').getUTCDay() + 6) % 7);
    assert.equal(heatmap.columns, Math.ceil((heatmap.leading + days) / 7));
    assert.equal(heatmap.cells[0].level, 0); assert.equal(heatmap.cells.at(-1).level, 4);
  }
});
test('profile heatmap never turns missing, duplicate or invalid dates into zero activity', () => {
  const heatmap = buildActivityHeatmap({ days: 7, daily: [
    { date: '2026-09-09', count: 0 }, { date: '2026-09-04', count: 2 },
    { date: '2026-09-04', count: 2 }, { date: '2026-09-07', count: 4 },
    { date: '2026-09-06', count: null }, { date: '2026-09-99', count: 99 },
  ] });
  assert.equal(heatmap.state, 'unknown'); assert.equal(heatmap.cells.length, 7);
  for (const day of ['03', '04', '05', '06', '08']) {
    const cell = heatmap.cells.find(item => item.date === '2026-09-' + day);
    assert.equal(cell.count, null); assert.equal(cell.level, null);
  }
  assert.equal(heatmap.cells.at(-1).count, 0); assert.equal(heatmap.cells.at(-1).level, 0);
  assert.equal(heatmap.peak, 4);
});
test('profile heatmap distinguishes a fully empty period from pending and unavailable activity', () => {
  const empty = buildActivityHeatmap(normalizeSnapshot(snapshot(7, 0), 7));
  assert.equal(empty.state, 'empty'); assert.ok(empty.cells.every(item => item.count === 0 && item.level === 0));
  assert.equal(buildActivityHeatmap(null).state, 'pending');
  assert.deepEqual(buildActivityHeatmap({ days: 30, daily: [] }).cells, []);
  assert.equal(buildActivityHeatmap({ days: 30, daily: [] }).state, 'unknown');
});

test('token components and dated snapshots stay distinct from conversation counts', () => {
  const raw = snapshot(7); raw.tokens.daily = [{ date: '2026-09-09', totalTokens: 200, inputTokens: 100, outputTokens: 30, cacheReadTokens: 50, cacheCreationTokens: 20 }];
  const data = normalizeSnapshot(raw, 7);
  assert.equal(data.cacheReadTokens, 50); assert.equal(data.cacheCreationTokens, 20);
  const tokens = buildTrendSeries(data, 'tokens'), messages = buildTrendSeries(data, 'messages');
  assert.equal(tokens.at(-1).value, 200); assert.equal(messages.at(-1).value, 5);
  assert.ok(tokens.slice(0, -1).every(day => day.value === null));
  assert.equal(tokens.at(-1).date, messages.at(-1).date);
});
test('old snapshots and unavailable token records cannot imply a zero-token trend', () => {
  const old = normalizeSnapshot(snapshot(7), 7);
  assert.deepEqual(old.tokenDaily, []); assert.ok(buildTrendSeries(old).every(day => day.value === null));
  const raw = snapshot(7, 3, { tokens: { available: false, daily: [{ date: '2026-09-09', totalTokens: 999 }] } });
  assert.ok(buildTrendSeries(normalizeSnapshot(raw, 7)).every(day => day.value === null));
  assert.equal(buildTrendGeometry(buildTrendSeries(old)).known, 0);
});
test('missing and duplicate token dates create real gaps instead of connecting unknown days', () => {
  const raw = snapshot(7); raw.tokens.daily = [
    { date: '2026-09-03', totalTokens: 5 }, { date: '2026-09-04', totalTokens: 10 },
    { date: '2026-09-04', totalTokens: 9 }, { date: '2026-09-06', totalTokens: 0 }, { date: '2026-09-07', totalTokens: 7 },
    { date: '2026-09-09', totalTokens: 12 }, { date: '2026-99-99', totalTokens: 99999 },
  ];
  const series = buildTrendSeries(normalizeSnapshot(raw, 7)), geometry = buildTrendGeometry(series);
  assert.equal(series.length, 7); assert.equal(series[1].value, null); assert.equal(series[3].value, 0);
  assert.equal(geometry.segments.length, 3); assert.equal(geometry.known, 4); assert.equal(geometry.max, 12);
  assert.ok(geometry.segments.every(segment => !/NaN|Infinity/.test(segment.path + segment.area)));
});
test('a known zero trend remains on the baseline and model composition preserves exact counters', () => {
  const raw = snapshot(7); raw.tokens.byModel[0] = { key: 'route/model-one', count: 200, inputTokens: 100, outputTokens: 30, cacheReadTokens: 50, cacheCreationTokens: 20 };
  assert.deepEqual(normalizeSnapshot(raw, 7).models[0].components, [100, 30, 20, 50]);
  const geometry = buildTrendGeometry([{ date: '2026-09-08', value: 0 }, { date: '2026-09-09', value: 0 }]);
  assert.equal(geometry.known, 2); assert.equal(geometry.segments.length, 1); assert.ok(geometry.points.every(point => point.y === 138));
  assert.equal(buildTrendGeometry([]).segments.length, 0);
});

test('heatmap mode selects the same daily values as the trend and scales each source independently', () => {
  const raw = snapshot(7); raw.tokens.daily = raw.daily.map((day, index) => ({ date: day.date, totalTokens: [1, 4, 9, 0, 12, 16, 8][index] }));
  const data = normalizeSnapshot(raw, 7), tokens = buildActivityHeatmap(data, 'tokens'), messages = buildActivityHeatmap(data, 'messages');
  assert.deepEqual(tokens.cells.map(day => day.count), buildTrendSeries(data, 'tokens').map(day => day.value));
  assert.deepEqual(messages.cells.map(day => day.count), buildTrendSeries(data, 'messages').map(day => day.value));
  assert.deepEqual(tokens.cells.map(day => day.level), [1, 1, 3, 0, 3, 4, 2]);
  assert.deepEqual(messages.cells.map(day => day.level), [0, 0, 0, 0, 0, 0, 4]);
  assert.deepEqual(tokens.cells.map(day => day.date), messages.cells.map(day => day.date));
  assert.equal(tokens.peak, 16); assert.equal(messages.peak, 5);
});
test('Token heatmaps preserve missing and duplicate days as unknown instead of reusing activity or zero', () => {
  const raw = snapshot(7); raw.tokens.daily = [
    { date: '2026-09-03', totalTokens: 0 }, { date: '2026-09-04', totalTokens: 10 }, { date: '2026-09-04', totalTokens: 12 },
    { date: '2026-09-05', totalTokens: null }, { date: '2026-09-09', totalTokens: 8 },
  ];
  const activity = buildActivityHeatmap(normalizeSnapshot(raw, 7), 'tokens');
  assert.equal(activity.state, 'unknown'); assert.equal(activity.cells.length, 7);
  assert.deepEqual(activity.cells.map(day => day.count), [0, null, null, null, null, null, 8]);
  assert.deepEqual(activity.cells.map(day => day.level), [0, null, null, null, null, null, 4]);
  assert.ok(buildActivityHeatmap(normalizeSnapshot(snapshot(7), 7), 'tokens').cells.every(day => day.count === null));
});
test('heatmap defaults remain compatible and switching modes does not alter the cached snapshot', () => {
  const data = normalizeSnapshot(snapshot(7), 7), saved = JSON.stringify(data);
  const normal = buildActivityHeatmap(data); buildActivityHeatmap(data, 'tokens');
  assert.deepEqual(buildActivityHeatmap(data, 'messages'), normal); assert.equal(JSON.stringify(data), saved);
  assert.equal(buildActivityHeatmap(null, 'tokens').state, 'pending');
});

test('overview formatting preserves complete values while Token breakdowns retain compact notation', () => {
  for (const [value, full, compact] of [[0, '0', '0'], [75000, '75,000', '75K'], [1800000, '1,800,000', '1.8M'], [12345678901234, '12,345,678,901,234', '12346B']]) {
    assert.equal(formatFullNumber(value), full); assert.equal(formatNumber(value), compact);
  }
  assert.equal(formatFullNumber(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991');
  for (const invalid of [undefined, null, NaN, Infinity, -1, '0']) assert.equal(formatFullNumber(invalid), '—');
});
test('recorded daily peak uses only the selected 7, 30 or 90 day range and real Token counters', () => {
  const values = [{ date: '2026-09-09', totalTokens: 12345 }, { date: '2026-08-20', totalTokens: 23456 }, { date: '2026-07-01', totalTokens: 34567 }, { date: '2026-06-01', totalTokens: 999999 }];
  for (const [days, value, date, recordedDays] of [[7, 12345, '2026-09-09', 1], [30, 23456, '2026-08-20', 2], [90, 34567, '2026-07-01', 3]]) {
    const raw = snapshot(days, 99999); raw.tokens.daily = values;
    const data = normalizeSnapshot(raw, days), saved = JSON.stringify(data);
    assert.deepEqual(getRecordedTokenPeak(data), { value, date, recordedDays, days });
    assert.equal(JSON.stringify(data), saved);
  }
});
test('a partial peak reports known days without interpreting missing, duplicate or invalid dates as zero', () => {
  const raw = snapshot(7); raw.tokens.daily = [
    { date: '2026-09-04', totalTokens: 999 }, { date: '2026-09-04', totalTokens: 999 },
    { date: '2026-09-05', totalTokens: null }, { date: '2026-09-06', totalTokens: 7 },
    { date: '2026-09-07', totalTokens: 7 }, { date: '2026-09-09', totalTokens: 0 }, { date: '2026-09-99', totalTokens: 10000 },
  ];
  assert.deepEqual(getRecordedTokenPeak(normalizeSnapshot(raw, 7)), { value: 7, date: '2026-09-07', recordedDays: 3, days: 7 });
  assert.equal(getRecordedTokenPeak(normalizeSnapshot(snapshot(7), 7)).value, null);
  assert.equal(getRecordedTokenPeak(null).value, null);
  raw.tokens.available = false;
  assert.equal(getRecordedTokenPeak(normalizeSnapshot(raw, 7)).value, null);
});
test('an accurately recorded zero peak remains zero even if other dates are unknown', () => {
  const raw = snapshot(7); raw.tokens.daily = [{ date: '2026-09-09', totalTokens: 0 }];
  assert.deepEqual(getRecordedTokenPeak(normalizeSnapshot(raw, 7)), { value: 0, date: '2026-09-09', recordedDays: 1, days: 7 });
  raw.tokens.daily = raw.daily.map(day => ({ date: day.date, totalTokens: 0 }));
  assert.deepEqual(getRecordedTokenPeak(normalizeSnapshot(raw, 7)), { value: 0, date: '2026-09-09', recordedDays: 7, days: 7 });
});

test('cache hit rate uses all input tokens including writes, excluding output tokens', () => {
  const raw = snapshot(7), data = normalizeSnapshot(raw, 7);
  assert.equal(data.cacheHitRate, 50 / (100 + 50 + 20));
  assert.equal(formatPercent(data.cacheHitRate), '29.4%');
  raw.tokens.outputTokens = 1000000;
  assert.equal(normalizeSnapshot(raw, 7).cacheHitRate, data.cacheHitRate);
  assert.equal(normalizeSnapshot(raw, 7).cacheCreationTokens, 20);
});
test('cache reads remain measurable when no writes are reported and unchanged by scaling the period', () => {
  const raw = snapshot(7); Object.assign(raw.tokens, { inputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 0 });
  assert.equal(formatPercent(normalizeSnapshot(raw, 7).cacheHitRate), '90%');
  Object.assign(raw.tokens, { inputTokens: 1000, cacheReadTokens: 9000 });
  assert.equal(formatPercent(normalizeSnapshot(raw, 7).cacheHitRate), '90%');
  raw.tokens.cacheReadTokens = 0;
  assert.equal(formatPercent(normalizeSnapshot(raw, 7).cacheHitRate), '0%');
  raw.tokens.inputTokens = 0; raw.tokens.cacheReadTokens = 20;
  assert.equal(formatPercent(normalizeSnapshot(raw, 7).cacheHitRate), '100%');
});
test('empty input and missing counters keep cache hit rate unknown rather than claiming zero', () => {
  for (const patch of [ { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { cacheReadTokens: null }, { cacheReadTokens: undefined }, { cacheCreationTokens: null },
    { inputTokens: null }, { available: false } ]) {
    const raw = snapshot(7); Object.assign(raw.tokens, patch);
    assert.equal(normalizeSnapshot(raw, 7).cacheHitRate, null);
    assert.equal(formatPercent(normalizeSnapshot(raw, 7).cacheHitRate), '—');
  }
  for (const value of [null, undefined, NaN, Infinity, -1, 1.1, '0']) assert.equal(formatPercent(value), '—');
});

test('the reported screenshot totals show cache-inclusive input while composition remains disjoint', () => {
  const data = normalizeSnapshot(snapshot(30, 1, { tokens: {
    available: true, inputTokens: 14004572, outputTokens: 3376993,
    cacheReadTokens: 361773440, cacheCreationTokens: 0, totalTokens: 379155005,
  } }), 30);
  assert.equal(data.inputTotalTokens, 375778012);
  assert.equal(data.inputTokens, 14004572);
  assert.equal(data.inputTotalTokens + data.outputTokens, 379155005);
  assert.equal(data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens, data.tokenTotal);
  assert.equal(formatPercent(data.cacheHitRate), '96.3%');
  assert.equal(normalizeSnapshot(snapshot(30, 1, { tokens: {
    available: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheCreationTokens: 0,
  } }), 30).inputTotalTokens, null);
});
