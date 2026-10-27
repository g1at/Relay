'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { nextCronAfter, normalizeTimeZone, zonedMinute } = require('../src/main/scheduling/cron-time');
const scheduler = require('../src/main/scheduling/scheduler');

function next(expression, after, zone) {
  const value = nextCronAfter(scheduler._parseCron(expression), new Date(after), zone);
  return value && value.toISOString();
}

test('the same daily cron resolves differently in its fixed IANA timezone', () => {
  const after = '2026-01-05T00:00:00.000Z';
  assert.equal(next('0 9 * * *', after, 'Asia/Singapore'), '2026-01-05T01:00:00.000Z');
  assert.equal(next('0 9 * * *', after, 'America/New_York'), '2026-01-05T14:00:00.000Z');
  assert.equal(next('0 9 * * *', after, 'UTC'), '2026-01-05T09:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-07-05T00:00:00Z', 'America/New_York'), '2026-07-05T13:00:00.000Z');
});

test('fractional offsets and timezone date boundaries retain the requested calendar fields', () => {
  assert.equal(next('0 9 * * *', '2026-01-05T00:00:00Z', 'Asia/Kathmandu'), '2026-01-05T03:15:00.000Z');
  assert.equal(next('0 0 * * 1', '2026-01-04T00:00:00Z', 'Pacific/Kiritimati'), '2026-01-04T10:00:00.000Z');
  assert.equal(next('0 23 31 12 *', '2026-12-31T00:00:00Z', 'Pacific/Pago_Pago'), '2027-01-01T10:00:00.000Z');
});

test('missing and local timezone follow the host while fixed zones ignore the host timezone', () => {
  const helperPath = require.resolve('../src/main/scheduling/cron-time');
  const schedulerPath = require.resolve('../src/main/scheduling/scheduler');
  const script = `
    const { nextCronAfter } = require(${JSON.stringify(helperPath)});
    const { _parseCron } = require(${JSON.stringify(schedulerPath)});
    const c = _parseCron('0 9 * * *');
    const after = new Date('2026-01-05T00:00:00Z');
    process.stdout.write(JSON.stringify([
      nextCronAfter(c, after).toISOString(),
      nextCronAfter(c, after, 'local').toISOString(),
      nextCronAfter(c, after, 'Asia/Singapore').toISOString()
    ]));
  `;
  for (const [hostZone, localExpected] of [
    ['UTC', '2026-01-05T09:00:00.000Z'],
    ['America/New_York', '2026-01-05T14:00:00.000Z'],
  ]) {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: hostZone },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [localExpected, localExpected, '2026-01-05T01:00:00.000Z']);
  }
});

test('spring-forward skips a nonexistent wall-clock minute instead of shifting it', () => {
  assert.equal(next('30 2 * * *', '2026-03-08T00:00:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('15 2 * * *', '2026-10-03T14:00:00Z', 'Australia/Lord_Howe'), '2026-10-04T15:15:00.000Z');
});

test('fall-back fires a repeated wall-clock minute once, at its first occurrence', () => {
  assert.equal(next('30 1 * * *', '2026-11-01T00:00:00Z', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T06:15:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('45 1 * * *', '2026-04-04T00:00:00Z', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z');
  assert.equal(next('45 1 * * *', '2026-04-04T14:50:00Z', 'Australia/Lord_Howe'), '2026-04-05T15:15:00.000Z');
});

test('frequent cron stays ordered through a fold and does not replay the repeated hour', () => {
  const zone = 'America/New_York';
  assert.equal(next('* * * * *', '2026-11-01T05:58:00Z', zone), '2026-11-01T05:59:00.000Z');
  assert.equal(next('* * * * *', '2026-11-01T05:59:00Z', zone), '2026-11-01T07:00:00.000Z');
  assert.equal(next('* * * * *', '2026-11-01T06:15:00Z', zone), '2026-11-01T07:00:00.000Z');
  assert.equal(next('* * * * *', '2026-11-01T07:00:00Z', zone), '2026-11-01T07:01:00.000Z');
  assert.equal(next('* * * * *', '2026-03-08T06:59:00Z', zone), '2026-03-08T07:00:00.000Z');
});

test('a skipped calendar day is not normalized into a duplicate next-day run', () => {
  assert.equal(next('0 9 * * *', '2011-12-29T20:00:00Z', 'Pacific/Apia'), '2011-12-30T19:00:00.000Z');
});

test('cron retains Unix day-of-month / weekday OR and strictly-after semantics', () => {
  assert.equal(next('0 9 15 * 1', '2026-01-05T14:00:00Z', 'America/New_York'), '2026-01-12T14:00:00.000Z');
  assert.equal(next('0 9 15 * 1', '2026-01-13T00:00:00Z', 'America/New_York'), '2026-01-15T14:00:00.000Z');
  assert.equal(next('*/15 9-10 * * *', '2026-01-05T09:00:00Z', 'UTC'), '2026-01-05T09:15:00.000Z');
  assert.equal(next('*/15 9-10 * * *', '2026-01-05T08:59:59.999Z', 'UTC'), '2026-01-05T09:00:00.000Z');
});

test('sparse cron remains bounded across leap years, centuries, and impossible dates', () => {
  const started = performance.now();
  assert.equal(next('17 4 29 2 *', '2025-03-01T00:00:00Z', 'America/New_York'), '2028-02-29T09:17:00.000Z');
  assert.equal(next('0 0 29 2 *', '2096-03-01T00:00:00Z', 'UTC'), '2104-02-29T00:00:00.000Z');
  assert.equal(next('0 0 31 2 *', '2026-01-01T00:00:00Z', 'UTC'), null);
  assert.ok(performance.now() - started < 1000, 'sparse cron must not scan elapsed minutes');
});

test('timezone validation rejects an explicit invalid zone instead of silently using local', () => {
  assert.equal(normalizeTimeZone(), 'local');
  assert.equal(normalizeTimeZone('local'), 'local');
  assert.equal(normalizeTimeZone(' UTC '), 'UTC');
  for (const zone of ['Mars/Olympus', '+08:00', {}, 8]) {
    assert.throws(() => normalizeTimeZone(zone), /时区无效/);
    assert.throws(() => next('0 9 * * *', '2026-01-05T00:00:00Z', zone), /时区无效/);
  }
});

test('jitter checks the task wall-clock minute, including quarter-hour timezone offsets', () => {
  assert.equal(zonedMinute(Date.parse('2026-01-05T03:15:00Z'), 'Asia/Kathmandu'), 0);
  assert.equal(zonedMinute(Date.parse('2026-01-05T03:30:00Z'), 'Asia/Kathmandu'), 15);
});

test('scheduler computation and validation use the declared cron timezone', () => {
  const at = Date.parse('2026-01-05T00:00:00Z');
  const task = { schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'America/New_York', exact: true } };
  assert.equal(scheduler._computeNextRun(task, at), Date.parse('2026-01-05T14:00:00Z'));
  const invalid = { schedule: { ...task.schedule, tz: 'Mars/Olympus' } };
  assert.equal(scheduler._computeNextRun(invalid, at), null);
  assert.match(invalid.lastError, /时区无效/);
  assert.match(scheduler._scheduleConfigurationError(invalid.schedule, { now: at }), /时区无效/);
  assert.equal(scheduler._normalizeTask({ schedule: { kind: 'cron' } }).schedule.tz, 'local');
});

test('scheduler applies jitter only at the requested zone whole or half hour', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const at = Date.parse('2026-01-05T00:00:00Z');
  assert.equal(scheduler._computeNextRun({
    schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'Asia/Kathmandu', jitterSec: 20 },
  }, at), Date.parse('2026-01-05T03:15:10Z'));
  assert.equal(scheduler._computeNextRun({
    schedule: { kind: 'cron', cron: '15 9 * * *', tz: 'Asia/Kathmandu', jitterSec: 20 },
  }, at), Date.parse('2026-01-05T03:30:00Z'));
});

test('schedule previews use the same timezone calculator as real execution', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-05T00:00:00Z'));
  assert.deepEqual(scheduler.preview({ kind: 'cron', cron: '0 9 * * *', tz: 'America/New_York', exact: true }, 2), [
    '2026-01-05T14:00:00.000Z', '2026-01-06T14:00:00.000Z',
  ]);
});

test('resume after a system timezone change re-arms local cron but preserves fixed zones and intervals', (t) => {
  const priorZone = process.env.TZ;
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, 'relay-timezone-resume-'));
  t.after(() => {
    scheduler.shutdown();
    if (priorZone === undefined) delete process.env.TZ;
    else process.env.TZ = priorZone;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  process.env.TZ = 'UTC';
  t.mock.method(Date, 'now', () => Date.parse('2026-01-05T00:00:00Z'));
  let jitterDraw = 0.25;
  t.mock.method(Math, 'random', () => jitterDraw);
  const tasks = [
    { id: 'explicit-local', schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'local', exact: true }, nextRunAt: '2026-01-05T09:00:00.000Z' },
    { id: 'legacy-local', schedule: { kind: 'cron', cron: '0 9 * * *', exact: true }, nextRunAt: '2026-01-05T09:00:00.000Z' },
    { id: 'fixed-zone', schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'America/New_York', jitterSec: 20 }, nextRunAt: '2026-01-05T14:00:00.000Z' },
    { id: 'interval', schedule: { kind: 'every', everyMs: 60000 }, nextRunAt: '2026-01-05T00:30:00.000Z' },
  ].map((task) => ({ ...task, name: task.id, enabled: true, action: { type: 'chat', prompt: 'never execute' } }));
  fs.writeFileSync(path.join(userDataDir, 'schedules.json'), JSON.stringify({ version: 1, tasks, runs: [] }));
  scheduler.init({
    userDataDir,
    runClaudeJob() { throw new Error('timezone resume test must not execute a model'); },
  });
  assert.equal(scheduler.get('explicit-local').nextRunAt, '2026-01-05T09:00:00.000Z');
  assert.equal(scheduler.get('legacy-local').nextRunAt, '2026-01-05T09:00:00.000Z');
  assert.equal(scheduler.get('fixed-zone').nextRunAt, '2026-01-05T14:00:05.000Z');

  process.env.TZ = 'Asia/Singapore';
  jitterDraw = 0.75; // Recomputing a fixed-zone task would incorrectly change its planned jitter.
  scheduler.onResume();

  assert.equal(scheduler.get('explicit-local').nextRunAt, '2026-01-05T01:00:00.000Z');
  assert.equal(scheduler.get('legacy-local').nextRunAt, '2026-01-05T01:00:00.000Z');
  assert.equal(scheduler.get('fixed-zone').nextRunAt, '2026-01-05T14:00:05.000Z');
  assert.equal(scheduler.get('interval').nextRunAt, '2026-01-05T00:30:00.000Z');
  assert.deepEqual(scheduler.runs(), []);
});
