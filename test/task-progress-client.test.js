'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { TaskProgressClient } = require('../src/main/tasks/task-progress-client');
const { TaskProgressStore } = require('../src/main/tasks/task-progress-store');
const Output = require('../renderer/assistant-output');

const assistant = (id, text) => ({ type: 'assistant', uuid: `frame-${id}`, message: { id, content: [{ type: 'text', text }] } });
const envelope = (seq, event, runId = 'worker_fixture') => ({ schemaVersion: 1, type: 'run.event', runId,
  epoch: 'worker-epoch', seq, emittedAt: '2026-09-21T00:00:00.000Z', payload: { event } });

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-progress-client-')));
  const rootDir = path.join(root, 'progress'), clients = [], warnings = [];
  const client = extra => {
    const value = new TaskProgressClient({ rootDir, flushIntervalMs: 60000,
      logger: { warn: (...parts) => warnings.push(parts.join(' ')) }, ...extra });
    clients.push(value); return value;
  };
  t.after(async () => {
    await Promise.all(clients.map(value => value.close().catch(() => {})));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, rootDir, client, warnings };
}

function fakeWorkers() {
  const instances = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) { super(); this.file = file; this.options = options; this.sent = []; this.refs = 0; this.unrefs = 0; instances.push(this); }
    postMessage(message) {
      this.sent.push(message);
      if (message.method === 'close') queueMicrotask(() => {
        this.reply(message); this.emit('exit', 0);
      });
    }
    reply(request, value, error = null) {
      this.emit('message', { requestId: request.requestId, ok: !error, ...(error ? { error } : { value }) });
    }
    ref() { this.refs++; }
    unref() { this.unrefs++; }
    terminate() { assert.fail('Progress writes must never be force-terminated'); }
  }
  return { instances, FakeWorker };
}

test('unused clients are lazy and close rejects new operations without starting a worker', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  assert.throws(() => new TaskProgressClient(), /rootDir/);
  assert.throws(() => client.observe(null), /array/);
  assert.equal(client.observe([]), true); assert.equal(fake.instances.length, 0);
  const closing = client.close(); assert.equal(client.close(), closing); await closing;
  assert.equal(client.observe([envelope(1, assistant('late', 'Ignored'))]), false);
  await assert.rejects(client.load('worker_fixture'), { code: 'TASK_PROGRESS_CLOSED' });
  await assert.rejects(client.flush(), { code: 'TASK_PROGRESS_CLOSED' });
  await assert.rejects(client.remove('worker_fixture'), { code: 'TASK_PROGRESS_CLOSED' });
  assert.equal(fake.instances.length, 0); assert.equal(fs.existsSync(h.rootDir), false);
});

test('token observations have no pending promises and subsequent reads/flushes retain transport order', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  for (let index = 1; index <= 2000; index++) client.observe([envelope(index, assistant(`a-${index}`, 'Synthetic'))]);
  const worker = fake.instances[0];
  assert.equal(client.pending.size, 0); assert.equal(client.sequence, 0);
  assert.equal(worker.sent.length, 2000); assert.ok(worker.sent.every(message => message.requestId == null));
  assert.equal(worker.sent[0].envelopes[0].seq, 1); assert.equal(worker.sent[1999].envelopes[0].seq, 2000);
  assert.equal(worker.options.workerData.rootDir, h.rootDir);
  assert.equal(path.basename(worker.file), 'task-progress-worker.js');
  assert.ok(worker.unrefs > 0);
  const read = client.load('worker_fixture'), flush = client.flush();
  assert.equal(client.pending.size, 2);
  assert.deepEqual(worker.sent.slice(-2).map(message => message.method), ['load', 'flush']);
  worker.reply(worker.sent[2000], { seq: 2000 }); worker.reply(worker.sent[2001]);
  assert.deepEqual(await read, { seq: 2000 }); await flush;
  assert.equal(client.pending.size, 0); await client.close();
});

test('real worker barriers load detached progress and close persists all preceding observations', async t => {
  const h = fixture(t), first = h.client();
  assert.equal(await first.load('never_seen'), null);
  first.observe([envelope(1, assistant('first', 'Step one'))]);
  const before = first.load('worker_fixture');
  first.observe([envelope(2, assistant('second', 'Step two'))]);
  const after = first.load('worker_fixture');
  assert.equal((await before).seq, 1);
  const snapshot = await after;
  assert.equal(snapshot.seq, 2); assert.equal(snapshot.output.final, ''); assert.equal(snapshot.displayOnly, true);
  assert.equal(fs.existsSync(h.rootDir), false);
  snapshot.output.messages[0].blocks[0].text = 'Caller mutation';
  assert.equal(Output.textFor((await first.load('worker_fixture')).output.messages[0]), 'Step one');
  first.observe([envelope(3, assistant('third', 'Persist before exit'))]);
  await first.close(); assert.equal(first.worker, null);
  const disk = JSON.parse(fs.readFileSync(path.join(h.rootDir, 'worker_fixture.json'), 'utf8'));
  assert.equal(disk.seq, 3); assert.equal(disk.output.messages.length, 3);
  const restarted = h.client(), saved = await restarted.load('worker_fixture');
  assert.equal(saved.seq, 3); assert.equal(Output.textFor(saved.output.messages.at(-1)), 'Persist before exit');
});

test('remove is ordered after observations/flush and tombstones later observations in that worker', async t => {
  const h = fixture(t), client = h.client();
  client.observe([envelope(1, assistant('old', 'Delete this run'))]);
  const flushing = client.flush(), removing = client.remove('worker_fixture');
  client.observe([envelope(2, assistant('late', 'Must not recreate'))]);
  await flushing; await removing;
  assert.equal(await client.load('worker_fixture'), null);
  await client.close(); assert.equal(fs.existsSync(path.join(h.rootDir, 'worker_fixture.json')), false);
});

test('job-done-only terminal receipt and its finalResult survive worker transport without promoting an answer', async t => {
  const h = fixture(t), client = h.client();
  const done = { type: 'job-done', exitCode: 0, relay_stream_seq: 9,
    finalResult: { type: 'result', subtype: 'success', result: 'Actual SDK conclusion', is_error: false, num_turns: 1 } };
  client.observe([envelope(1, done)]); await client.flush();
  const saved = await client.load('worker_fixture');
  assert.equal(saved.terminal, true); assert.equal(saved.deliverySeq, 9);
  assert.equal(saved.output.final, ''); assert.equal(saved.activity.phase, 'complete');
  assert.deepEqual(saved.terminalEvent, done);
});

test('RPC validation and disk failures reject explicitly without replaying or disabling unrelated valid reads', async t => {
  const h = fixture(t), client = h.client();
  await assert.rejects(client.load('../escape'), /runId/);
  await assert.rejects(client._request('unknownMethod'), /Invalid task progress request/);
  fs.mkdirSync(h.rootDir);
  fs.writeFileSync(path.join(h.rootDir, 'corrupt.json'), '{ damaged');
  await assert.rejects(client.load('corrupt'), { name: 'SyntaxError' });
  assert.equal(await client.load('absent'), null);
  assert.equal(client.failed, null); assert.ok(h.warnings.length >= 3);
});

test('store background write errors are reported and a later explicit barrier retries retained progress', async t => {
  const h = fixture(t), observed = [], client = h.client({ onError: error => observed.push(error) });
  fs.writeFileSync(h.rootDir, 'Synthetic filesystem obstruction');
  client.observe([envelope(1, assistant('blocked', 'Retained until storage recovers'))]);
  await assert.rejects(client.flush(), /Task progress flush failed/);
  assert.ok(observed.length > 0); assert.ok(h.warnings.length > 0);
  fs.rmSync(h.rootDir);
  await client.flush();
  assert.equal((await client.load('worker_fixture')).seq, 1);
});

test('worker failure rejects all pending barriers, logs degradation, and never silently respawns/replays', async t => {
  const h = fixture(t), fake = fakeWorkers(), errors = [], client = h.client({ WorkerClass: fake.FakeWorker, onError: error => errors.push(error) });
  client.observe([envelope(1, assistant('unconfirmed', 'Receipt may be missing'))]);
  const loading = assert.rejects(client.load('worker_fixture'), { code: 'TASK_PROGRESS_WORKER_FAILED' });
  const flushing = assert.rejects(client.flush(), { code: 'TASK_PROGRESS_WORKER_FAILED' });
  const worker = fake.instances[0]; worker.emit('error', new Error('Synthetic crash')); worker.emit('exit', 1);
  await loading; await flushing;
  assert.equal(client.pending.size, 0); assert.equal(errors.length, 1); assert.equal(h.warnings.length, 1);
  assert.equal(client.observe([envelope(2, assistant('later', 'Not silently accepted'))]), false);
  await assert.rejects(client.load('worker_fixture'), { code: 'TASK_PROGRESS_WORKER_FAILED' });
  await assert.rejects(client.close(), { code: 'TASK_PROGRESS_WORKER_FAILED' });
  assert.equal(fake.instances.length, 1); assert.equal(worker.sent.length, 3);
});

test('startup failure and unexpected clean worker exit are both explicit degraded states', async t => {
  const h = fixture(t);
  class BrokenWorker { constructor() { throw new Error('Synthetic worker startup failure'); } }
  const broken = h.client({ WorkerClass: BrokenWorker });
  assert.equal(broken.observe([envelope(1, assistant('one', 'Unavailable'))]), false);
  await assert.rejects(broken.load('worker_fixture'), /startup failure/);
  const fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  const read = assert.rejects(client.load('worker_fixture'), /exited \(0\)/);
  fake.instances[0].emit('exit', 0); await read;
  assert.equal(client.failed.code, 'TASK_PROGRESS_WORKER_FAILED');
});

test('close waits for its flush receipt and worker exit, and never terminates a write in progress', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  client.observe([envelope(1, assistant('one', 'Before close'))]);
  const worker = fake.instances[0]; worker.postMessage = function (message) { this.sent.push(message); };
  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  const closeRequest = worker.sent.at(-1);
  assert.equal(closeRequest.method, 'close'); assert.equal(client.observe([]), false);
  await Promise.resolve(); assert.equal(closed, false);
  worker.reply(closeRequest); await Promise.resolve(); assert.equal(closed, false);
  worker.emit('exit', 0); await closing; assert.equal(closed, true);
});

test('close flush failures reject instead of claiming durable progress was saved', async t => {
  const h = fixture(t), client = h.client();
  fs.writeFileSync(h.rootDir, 'Synthetic filesystem obstruction');
  client.observe([envelope(1, assistant('unsaved', 'Cannot persist'))]);
  await assert.rejects(client.close(), /Task progress flush failed/);
  if (client.worker) await once(client.worker, 'exit');
  assert.equal(fs.statSync(h.rootDir).isFile(), true);
});

test('16 MiB snapshots are reduced and serialized off-thread while the host heartbeat continues', { timeout: 30000 }, async t => {
  const h = fixture(t);
  const frames = Array.from({ length: 2048 }, (_, index) => envelope(index + 1, assistant(`large-${index}`, 'x'.repeat(8192))));
  // Compare against the former in-process path with identical reducers and no
  // disk latency. Timings are diagnostics, not machine-dependent pass thresholds.
  const direct = new TaskProgressStore({ rootDir: path.join(h.root, 'baseline'), flushIntervalMs: 60000 });
  let baselineBytes = 0;
  direct._atomicWrite = async (_file, content) => { baselineBytes = Buffer.byteLength(content); };
  direct.observe(frames); await direct.load('worker_fixture');
  let baselineDelay;
  const directStart = performance.now();
  const directTimer = new Promise(resolve => setTimeout(() => { baselineDelay = performance.now() - directStart; resolve(); }, 0));
  await direct.flush(); await directTimer; await direct.close();

  const normal = h.client();
  let normalTicks = 0, normalMaxDelay = 0, previous = performance.now();
  const normalTimer = setInterval(() => {
    const now = performance.now(); normalTicks++; normalMaxDelay = Math.max(normalMaxDelay, now - previous); previous = now;
  }, 5);
  try { normal.observe(frames); await normal.flush(); } finally { clearInterval(normalTimer); }
  assert.equal(fs.statSync(path.join(h.rootDir, 'worker_fixture.json')).size, baselineBytes);
  await normal.close();

  class ObservedWorker extends Worker {
    constructor(file, options) {
      super(`const { parentPort, workerData } = require('node:worker_threads');
        const { TaskProgressStore } = require(workerData.storeFile);
        const snapshot = TaskProgressStore.prototype._snapshot;
        TaskProgressStore.prototype._snapshot = function(entry) {
          parentPort.postMessage({ type: 'serialization-started' });
          // A deterministic busy interval proves host ticks are not merely
          // running during worker startup or while a filesystem write awaits.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          return snapshot.call(this, entry);
        };
        require(workerData.implementation);`, { eval: true, workerData: { ...options.workerData,
          implementation: file, storeFile: require.resolve('../src/main/tasks/task-progress-store') } });
    }
  }
  const client = h.client({ rootDir: path.join(h.root, 'instrumented'), WorkerClass: ObservedWorker });
  client.observe(frames);
  let started = false, ticks = 0, maxDelay = 0, lastTick;
  client.worker.on('message', message => {
    if (message.type === 'serialization-started') { started = true; lastTick = performance.now(); }
  });
  const timer = setInterval(() => {
    if (!started) return;
    const now = performance.now(); ticks++; maxDelay = Math.max(maxDelay, now - lastTick); lastTick = now;
  }, 5);
  try { await client.flush(); } finally { clearInterval(timer); }
  const snapshotBytes = fs.statSync(path.join(h.root, 'instrumented', 'worker_fixture.json')).size;
  assert.ok(started); assert.ok(ticks >= 3, `Host heartbeat must continue during worker serialization; ticks=${ticks}`);
  assert.ok(snapshotBytes > 16 * 1024 * 1024); assert.equal(snapshotBytes, baselineBytes);
  t.diagnostic(JSON.stringify({ snapshotBytes, baselineHostTimerDelayMs: Math.round(baselineDelay),
    normalWorkerHostTicks: normalTicks, normalWorkerMaxHostTimerDelayMs: Math.round(normalMaxDelay),
    instrumentedWorkerHostTicks: ticks, instrumentedWorkerMaxHostTimerDelayMs: Math.round(maxDelay), workerProbeBusyMs: 100 }));
});
