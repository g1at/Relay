'use strict';

// Cron calendar arithmetic is independent of the Electron process timezone.
// Missing / "local" zones follow the system; explicit IANA zones remain fixed.
const DAY_MS = 86400000;
const formatters = new Map();

function normalizeTimeZone(value) {
  if (value == null || value === '' || value === 'local') return 'local';
  if (typeof value !== 'string' || !value.trim() || /^[+-]/.test(value.trim())) {
    throw new Error('时区无效：请使用 local 或 IANA 时区名称');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch (_) {
    throw new Error(`时区无效：${value}`);
  }
}

function formatterFor(value) {
  const normalized = normalizeTimeZone(value);
  // Resolve on each calculation so "local" follows a system timezone change.
  const timeZone = normalized === 'local'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : normalized;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // User-entered zones must not create an unbounded process-global cache.
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
  formatters.set(timeZone, formatter);
  return formatter;
}

function wallTime(formatter, ms) {
  const result = {};
  for (const part of formatter.formatToParts(ms)) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function civilUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function offsetAt(formatter, ms) {
  const fields = wallTime(formatter, ms);
  return civilUtc(fields.year, fields.month, fields.day,
    fields.hour, fields.minute, fields.second) - ms;
}

function dayOffsets(formatter, dayMs) {
  const offsets = new Set();
  // Include both sides of timezone transitions, including half-hour changes
  // and a skipped calendar day. Sample per date, never per elapsed minute.
  for (let hours = -36; hours <= 60; hours += 12) {
    offsets.add(offsetAt(formatter, dayMs + hours * 3600000));
  }
  return [...offsets];
}

function firstInstant(formatter, nominalMs, offsets, expected) {
  let earliest = null;
  for (const offset of offsets) {
    const candidate = nominalMs - offset;
    const actual = wallTime(formatter, candidate);
    if (actual.year !== expected.year || actual.month !== expected.month
        || actual.day !== expected.day || actual.hour !== expected.hour
        || actual.minute !== expected.minute || actual.second !== 0) continue;
    if (earliest === null || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

function values(set, min, max) {
  return set === null
    ? Array.from({ length: max - min + 1 }, (_, index) => min + index)
    : [...set].sort((a, b) => a - b);
}

// DST policy matches Relay's previous local Date implementation:
// - nonexistent wall-clock minutes are skipped;
// - repeated wall-clock minutes fire once, at the first occurrence.
// Calendar-day jumps keep sparse / leap-day cron expressions inexpensive.
function nextCronAfter(cron, after, timeZone = 'local') {
  const afterMs = after instanceof Date ? after.getTime() : Number(after);
  if (!Number.isFinite(afterMs)) throw new Error('cron 计算基准时间无效');
  const formatter = formatterFor(timeZone);
  const start = wallTime(formatter, afterMs);
  const firstDay = civilUtc(start.year, start.month, start.day);
  const hours = values(cron.hour, 0, 23);
  const minutes = values(cron.minute, 0, 59);

  // Eight years also cover the leap-day gap across a non-leap century.
  for (let dayIndex = 0; dayIndex <= 8 * 366; dayIndex += 1) {
    const dayMs = firstDay + dayIndex * DAY_MS;
    const day = new Date(dayMs);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dom = day.getUTCDate();
    const dow = day.getUTCDay();
    if (cron.month !== null && !cron.month.has(month)) continue;
    const domHit = cron.dom === null || cron.dom.has(dom);
    const dowHit = cron.dow === null || cron.dow.has(dow);
    if (cron.dom !== null && cron.dow !== null ? !domHit && !dowHit : !domHit || !dowHit) continue;

    const offsets = dayOffsets(formatter, dayMs);
    const minOffset = Math.min(...offsets);
    for (const hour of hours) {
      for (const minute of minutes) {
        const nominalMs = dayMs + hour * 3600000 + minute * 60000;
        if (nominalMs - minOffset <= afterMs) continue;
        const next = firstInstant(formatter, nominalMs, offsets,
          { year, month, day: dom, hour, minute });
        if (next !== null && next > afterMs) return new Date(next);
      }
    }
  }
  return null;
}

function zonedMinute(ms, timeZone = 'local') {
  return wallTime(formatterFor(timeZone), ms).minute;
}

module.exports = { normalizeTimeZone, nextCronAfter, zonedMinute };
