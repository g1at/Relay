'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizePreferences } = require('../general-preferences');

// Exercise the actual host pool helpers with synthetic sessions; never load Electron.
function hostPool(initialLimit, sessions) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('function evictIfNeeded(');
  const end = source.indexOf('// Claude Code ', start);
  const killed = [], limits = [], pending = [], liveSessions = new Map(sessions.map(sess => [sess.convId, sess]));
  const context = vm.createContext({ maxParallelTasks: initialLimit, liveSessions, normalizePreferences,
    killLiveSession(sess) { killed.push(sess.convId); liveSessions.delete(sess.convId); },
    taskOrchestrator: { setPoolLimits(patch) { limits.push(patch.claude); } },
    LIVE_IDLE_MS: 1800000, setTimeout() { return { unref() {} }; }, clearTimeout() {},
    setImmediate(callback) { pending.push(callback); return { unref() {} }; },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, killed, limits, liveSessions, pending };
}

test('lowering concurrency evicts idle LRU sessions but retains every busy session', () => {
  const f = hostPool(8, [
    { convId: 'busy-a', busy: true, lastUsedAt: 0 },
    { convId: 'idle-recent', busy: false, lastUsedAt: 3 },
    { convId: 'idle-old', busy: false, lastUsedAt: 1 },
    { convId: 'busy-b', busy: true, lastUsedAt: 0 },
  ]);
  f.context.applyParallelTaskLimit(2);
  assert.deepEqual(f.killed, ['idle-old', 'idle-recent']);
  assert.deepEqual([...f.liveSessions.keys()], ['busy-a', 'busy-b']);
  assert.deepEqual(f.limits, [2]);
  assert.equal(f.context.evictIfNeeded(), false);
});

test('unlimited sessions do not encounter a hidden three-slot cap and increasing the limit frees room', () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({ convId: `busy-${index}`, busy: true, lastUsedAt: index }));
  const f = hostPool(8, sessions);
  assert.equal(f.context.evictIfNeeded(), false);
  f.context.applyParallelTaskLimit(9);
  assert.equal(f.context.evictIfNeeded(), true);
  f.context.applyParallelTaskLimit(0);
  assert.equal(f.context.evictIfNeeded(), true);
  assert.deepEqual(f.killed, []);
  assert.deepEqual(f.limits, [9, 0]);
});

test('reserving a live session after a reduction reclaims enough idle slots', () => {
  const f = hostPool(2, Array.from({ length: 5 }, (_, index) => ({ convId: `idle-${index}`, busy: false, lastUsedAt: index })));
  assert.equal(f.context.evictIfNeeded(), true);
  assert.deepEqual(f.killed, ['idle-0', 'idle-1', 'idle-2', 'idle-3']);
  assert.equal(f.liveSessions.size, 1);
});

test('busy sessions above a reduced limit are reclaimed when idle and rechecked before eviction', () => {
  const sessions = Array.from({ length: 3 }, (_, index) => ({ convId: `busy-${index}`, busy: true, lastUsedAt: index }));
  const f = hostPool(3, sessions);
  f.context.applyParallelTaskLimit(2);
  assert.deepEqual(f.killed, []);
  sessions[0].busy = false;
  f.context.touchIdleTimer(sessions[0]);
  sessions[0].busy = true; // A follow-up resumes before the deferred trim.
  f.pending.shift()();
  assert.deepEqual(f.killed, []);
  sessions[1].busy = false;
  f.context.touchIdleTimer(sessions[1]);
  f.pending.shift()();
  assert.deepEqual(f.killed, ['busy-1']);
});
