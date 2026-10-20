'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { SdkProcessSupervisor } = require('../src/main/sdk/sdk-process-supervisor');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(setImmediate);
function fixture(options = {}) {
  const calls = [], events = [], exits = [];
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, killed: false, exitCode: null, signalCode: null,
    kill(signal) { calls.push(signal); child.killed = true; return true; } });
  const supervisor = new SdkProcessSupervisor({ graceMs: 10, retryMs: 0,
    onLifecycle: event => events.push(event), onExit: result => exits.push(result), ...options });
  return { supervisor, child, calls, events, exits };
}

test('an active process is not killed without an explicit stop request', async () => {
  const h = fixture(); h.supervisor.attach(h.child); h.supervisor.markSpawnSettled();
  await delay(25); assert.deepEqual(h.calls, []);
  h.child.emit('exit', 0, null);
  assert.equal((await h.supervisor.whenExited()).forced, false);
});

test('successful kill and killed=true do not confirm exit or suppress escalation', async () => {
  const h = fixture(); h.child.killed = true; h.supervisor.attach(h.child);
  let finished = false;
  const closed = h.supervisor.stop(); closed.then(() => { finished = true; });
  assert.equal(h.supervisor.stop(), closed);
  await delay(25); assert.deepEqual(h.calls, ['SIGKILL']); assert.equal(finished, false);
  h.child.emit('exit', null, 'SIGKILL');
  const result = await closed;
  assert.equal(result.stopConfirmed, true); assert.equal(result.forced, true);
  assert.equal(result.signal, 'SIGKILL'); assert.equal(h.exits.length, 1);
  h.supervisor.stop(); h.child.emit('exit', null, 'SIGKILL');
  assert.equal(h.exits.length, 1); assert.equal(h.calls.length, 1);
});

test('graceful exit cancels the independent force timer', async () => {
  const h = fixture(); h.supervisor.attach(h.child); h.supervisor.stop();
  h.child.emit('exit', 0, null);
  assert.equal((await h.supervisor.whenExited()).forced, false);
  await delay(25); assert.deepEqual(h.calls, []);
});

test('failed signal stays unconfirmed and an explicit retry can recover', async () => {
  const h = fixture(); let attempts = 0;
  h.child.kill = signal => { h.calls.push(signal); if (++attempts === 1) throw Object.assign(Error('synthetic'), { code: 'EPERM' }); return true; };
  h.supervisor.attach(h.child); let finished = false;
  h.supervisor.stop().then(() => { finished = true; });
  await delay(25); assert.equal(h.supervisor.snapshot().lastErrorCode, 'EPERM'); assert.equal(finished, false);
  h.supervisor.stop(); await delay(10); assert.equal(h.calls.length, 2); assert.equal(finished, false);
  h.child.emit('exit', null, 'SIGKILL'); await h.supervisor.whenExited();
});

test('stop before asynchronous spawn waits and supervises the late child', async () => {
  const h = fixture(); let finished = false;
  h.supervisor.stop().then(() => { finished = true; });
  await delay(25); assert.equal(finished, false); assert.deepEqual(h.calls, []);
  h.supervisor.attach(h.child); await delay(10);
  assert.deepEqual(h.calls, ['SIGKILL']); assert.equal(finished, false);
  h.child.emit('exit', null, 'SIGKILL'); await h.supervisor.whenExited();
});

test('a completed launch without a child confirms no process was created', async () => {
  const h = fixture(); h.supervisor.stop(); h.supervisor.markSpawnSettled();
  const result = await h.supervisor.whenExited();
  assert.equal(result.notSpawned, true); assert.equal(result.stopConfirmed, true);
  assert.throws(() => h.supervisor.attach(h.child), /spawn has settled/);
});

test('spawn failure confirms absence but an error with a live PID does not', async () => {
  const failed = fixture(); failed.child.pid = undefined; failed.supervisor.attach(failed.child);
  failed.child.emit('error', Object.assign(Error('synthetic'), { code: 'ENOENT' }));
  assert.equal((await failed.supervisor.whenExited()).spawnFailed, true);
  const alive = fixture(); alive.supervisor.attach(alive.child); let finished = false;
  alive.supervisor.whenExited().then(() => { finished = true; });
  alive.child.emit('error', Object.assign(Error('synthetic'), { code: 'EPERM' }));
  await tick(); assert.equal(finished, false);
  alive.child.emit('exit', 1, null); await alive.supervisor.whenExited();
});

test('native exit observed before attach is confirmed, without sending any signal', async () => {
  const h = fixture(); h.child.exitCode = 0; h.supervisor.attach(h.child);
  assert.equal((await h.supervisor.stop()).exitCode, 0); assert.deepEqual(h.calls, []);
});

test('real isolated child ignoring graceful shutdown is terminated by the host deadline', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);process.stdout.write('ready');"], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
  const supervisor = new SdkProcessSupervisor({ graceMs: 30 });
  supervisor.attach(child);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  child.stdin.end();
  const result = await supervisor.stop();
  assert.equal(result.stopConfirmed, true); assert.equal(result.forced, true);
  assert.ok(child.exitCode != null || child.signalCode != null);
});
