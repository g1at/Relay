'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../renderer/message-time');

const now = new Date(2026, 8, 14, 12, 0);

test('message dates use unpadded Chinese month/day and two-digit local 24-hour time', () => {
  assert.equal(time.compact(new Date(2026, 8, 7, 20, 20), now), '9月7日 20:20');
  assert.equal(time.compact(new Date(2026, 0, 1, 0, 5, 59), now), '1月1日 00:05');
  assert.equal(time.compact(new Date(2026, 10, 20, 9, 2), now), '11月20日 09:02');
  assert.equal(time.compact('2026-09-07T20:20:59', now), '9月7日 20:20');
});

test('different local calendar years retain their year, including a future year', () => {
  assert.equal(time.compact(new Date(2025, 11, 31, 23, 59), now), '2025年12月31日 23:59');
  assert.equal(time.compact(new Date(2027, 0, 1, 0, 0), now), '2027年1月1日 00:00');
  assert.equal(time.compact(new Date(2024, 1, 29, 12, 3), now), '2024年2月29日 12:03');
});

test('stored ISO instants and numeric timestamps format in the local calendar', () => {
  const date = new Date(2026, 8, 7, 0, 2, 30);
  assert.equal(time.compact(date.toISOString(), now), '9月7日 00:02');
  assert.equal(time.compact(date.getTime(), now), '9月7日 00:02');
});

test('hover text matches the visible timestamp without mutating stored dates', () => {
  const date = new Date(2025, 11, 31, 23, 59, 58), snapshot = date.getTime();
  assert.equal(time.full(date, now), '2025年12月31日 23:59');
  assert.equal(time.full(new Date(2026, 8, 7, 20, 20), now), '9月7日 20:20');
  assert.equal(date.getTime(), snapshot);
});

test('missing and invalid timestamps render no date and never throw', () => {
  for (const value of [undefined, null, '', ' ', 'invalid', NaN, Infinity, new Date(NaN), true, false, {}, [], Symbol('invalid')]) {
    assert.equal(time.compact(value, now), '');
    assert.equal(time.full(value, now), '');
  }
});
