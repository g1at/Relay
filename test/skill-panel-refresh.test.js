'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('function createSkillPanelRefreshQueue(');
const end = source.indexOf('// 技能 Curator 面板:', start);
assert.ok(start > 0 && end > start);

function fixture() {
  const timers = [], reads = [], renders = [], errors = [];
  const context = { setTimeout: callback => { timers.push(callback); return timers.length; } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  let connected = true;
  const queue = context.createSkillPanelRefreshQueue({
    load: options => new Promise((resolve, reject) => reads.push({ options, resolve, reject })),
    render: result => renders.push(result),
    onError: error => errors.push(error),
    isConnected: () => connected,
  });
  return { queue, reads, renders, errors, timers,
    tick: () => { assert.equal(timers.length, 1); return timers.shift()(); },
    disconnect: () => { connected = false; },
  };
}

test('publish events and action callback merge into one read after its operation releases', async () => {
  const f = fixture(), release = f.queue.hold();
  f.queue.invalidate(); f.queue.invalidate(); const done = f.queue.request();
  assert.equal(f.timers.length, 0); assert.equal(f.reads.length, 0);
  release(); release(); const reading = f.tick();
  assert.equal(f.reads.length, 1); f.reads[0].resolve('published');
  await reading; await done; assert.deepEqual(f.renders, ['published']); assert.equal(f.timers.length, 0);
});

test('an invalidation during a read requires one trailing read and never commits the stale response', async () => {
  const f = fixture(), done = f.queue.request(), first = f.tick();
  f.queue.invalidate(); f.queue.invalidate(); f.reads[0].resolve('stale'); await first;
  assert.deepEqual(f.renders, []); assert.equal(f.reads.length, 1);
  const last = f.tick(); f.reads[1].resolve('latest'); await last; await done;
  assert.deepEqual(f.renders, ['latest']); assert.equal(f.reads.length, 2); assert.equal(f.timers.length, 0);
});

test('a confirmation opened during a read prevents row replacement until it is closed', async () => {
  const f = fixture(), done = f.queue.request(), first = f.tick(), release = f.queue.hold();
  f.reads[0].resolve('before-confirm'); await first;
  assert.deepEqual(f.renders, []); assert.equal(f.timers.length, 0);
  release(); const last = f.tick(); f.reads[1].resolve('after-confirm'); await last; await done;
  assert.deepEqual(f.renders, ['after-confirm']);
});

test('nested row operations keep the refresh paused until every operation ends', async () => {
  const f = fixture(), first = f.queue.hold(), second = f.queue.hold();
  const done = f.queue.request(); first(); assert.equal(f.timers.length, 0);
  second(); const reading = f.tick(); f.reads[0].resolve('all-done'); await reading; await done;
  assert.deepEqual(f.renders, ['all-done']);
});

test('waiting for completion keeps a successful action busy without requesting another read', async () => {
  const f = fixture(), release = f.queue.hold();
  f.queue.invalidate(); release();
  let settled = false; const done = f.queue.whenIdle().then(() => { settled = true; });
  const reading = f.tick(); await Promise.resolve(); assert.equal(settled, false);
  f.reads[0].resolve('replacement'); await reading; await done;
  assert.equal(settled, true); assert.equal(f.reads.length, 1); assert.equal(f.timers.length, 0);
  await f.queue.whenIdle(); assert.equal(f.timers.length, 0);
});

test('explicit refresh is retained within a batch without retriggering it for later worker notifications', async () => {
  const f = fixture(), done = f.queue.request({ refresh: true, throwOnError: true });
  f.queue.invalidate({ refresh: false }); const first = f.tick();
  assert.equal(f.reads[0].options.refresh, true); assert.equal(f.reads[0].options.throwOnError, true);
  f.queue.invalidate({ refresh: false }); f.reads[0].resolve('old'); await first;
  const last = f.tick(); assert.equal(f.reads[1].options.refresh, false);
  f.reads[1].resolve('new'); await last; await done;
});

test('a failed read rejects callers and the next request can recover', async () => {
  const f = fixture(), done = f.queue.request(), rejection = assert.rejects(done, /fixture failure/);
  const first = f.tick(); f.reads[0].reject(new Error('fixture failure')); await first; await rejection;
  assert.equal(f.errors.length, 1);
  const retry = f.queue.request(), last = f.tick(); f.reads[1].resolve('recovered'); await last; await retry;
  assert.deepEqual(f.renders, ['recovered']);
});

test('disconnected panels settle callers without reading or rendering detached DOM', async () => {
  const f = fixture(), done = f.queue.request(); f.disconnect(); await f.tick(); await done;
  assert.equal(f.reads.length, 0); assert.deepEqual(f.renders, []);
  const g = fixture(), pending = g.queue.request(), reading = g.tick(); g.disconnect();
  g.reads[0].resolve('detached'); await reading; await pending; assert.deepEqual(g.renders, []);
});
