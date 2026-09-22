'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { SkillDraftClient } = require('../src/main/skills/skill-draft-client');
const { SkillDraftService } = require('../src/main/skills/skill-draft-service');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-draft-client-')));
  const options = { skillsDir: path.join(root, 'skills'), draftsDir: path.join(root, 'state'), stagingRoot: path.join(root, 'proposals') };
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); fs.rmSync(root, { recursive: true, force: true }); });
  const client = extra => { const result = new SkillDraftClient({ ...options, ...extra }); clients.push(result); return result; };
  function write(directory, body = 'Original instructions', name = 'guide') {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic fixture only\n---\n${body}\n`);
    return directory;
  }
  return { root, options, client, write };
}

function fakeWorkers({ closeAutomatically = false } = {}) {
  const instances = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) { super(); this.file = file; this.options = options; this.sent = []; this.refs = 0; this.unrefs = 0; instances.push(this); }
    postMessage(message) {
      this.sent.push(message);
      if (closeAutomatically && message.type === 'close') queueMicrotask(() => this.emit('exit', 0));
    }
    ref() { this.refs++; }
    unref() { this.unrefs++; }
    terminate() { throw new Error('Active drafts must never be force-terminated'); }
    reply(value = {}) { const request = this.sent.at(-1); this.emit('message', { requestId: request.requestId, ok: true, value }); }
  }
  return { instances, FakeWorker };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('host writes share the worker FIFO and close waits for asynchronous exclusive callbacks', async t => {
  const h = fixture(t), fake = fakeWorkers({ closeAutomatically: true }), client = h.client({ WorkerClass: fake.FakeWorker });
  const read = client.list(), entered = deferred(), release = deferred();
  const worker = fake.instances[0], order = [];
  const firstWrite = client.runExclusive(async () => {
    order.push('write-start'); entered.resolve();
    await release.promise;
    order.push('write-end'); return 17;
  });
  const secondWrite = client.runExclusive(() => { order.push('second-write'); return 18; });
  const afterWrite = client.get('after-write');
  assert.deepEqual(order, []);
  assert.deepEqual(worker.sent.map(item => item.method), ['list']);
  worker.reply([]); await read; await entered.promise;
  assert.deepEqual(worker.sent.map(item => item.method), ['list']);
  const closing = client.close(); let closed = false;
  closing.then(() => { closed = true; });
  await assert.rejects(client.runExclusive(() => assert.fail('must not run')), { code: 'SKILL_DRAFT_CLOSED' });
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await firstWrite, 17); assert.equal(await secondWrite, 18);
  assert.deepEqual(order, ['write-start', 'write-end', 'second-write']);
  assert.deepEqual(worker.sent.map(item => item.method), ['list', 'get']);
  worker.reply({ id: 'after-write' });
  assert.deepEqual(await afterWrite, { id: 'after-write' }); await closing;
  assert.deepEqual(worker.sent.at(-1), { type: 'close' });
});

test('exclusive callback failures release the queue and preserve falsey rejection reasons', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  await assert.rejects(client.runExclusive(null), TypeError);
  const failed = assert.rejects(client.runExclusive(() => { throw new Error('Synthetic host write failure'); }), /Synthetic host write failure/);
  const after = client.runExclusive(() => 'after failure');
  await failed; assert.equal(await after, 'after failure');
  for (const reason of [null, undefined, false, 0, '']) {
    await client.runExclusive(() => Promise.reject(reason)).then(
      () => assert.fail('A callback rejection must not become a successful write'),
      actual => assert.equal(actual, reason),
    );
  }
  assert.equal(await client.runExclusive(() => 42), 42);
  await client.close();
  assert.equal(fake.instances.length, 0, 'Host-only edits need no background worker');
});

test('same-client nested queue calls reject instead of deadlocking, including after await', async t => {
  const h = fixture(t), client = h.client();
  const descendant = deferred();
  const value = await client.runExclusive(async () => {
    await Promise.resolve();
    await assert.rejects(client.list(), { code: 'SKILL_DRAFT_REENTRANT' });
    await assert.rejects(client.runExclusive(() => assert.fail('nested write')), { code: 'SKILL_DRAFT_REENTRANT' });
    await assert.rejects(client.close(), { code: 'SKILL_DRAFT_REENTRANT' });
    setImmediate(() => descendant.resolve(client.runExclusive(() => 'later write')));
    return 'first write';
  });
  assert.equal(value, 'first write');
  assert.equal(await descendant.promise, 'later write', 'Completed callbacks must not poison later asynchronous descendants');
});

test('idle worker failure cannot finish close or overlap an active host write', async t => {
  const h = fixture(t), fake = fakeWorkers({ closeAutomatically: true }), client = h.client({ WorkerClass: fake.FakeWorker });
  const warm = client.list(), worker = fake.instances[0]; worker.reply([]); await warm;
  const entered = deferred(), release = deferred();
  const writing = client.runExclusive(async () => { entered.resolve(); await release.promise; return 'saved'; });
  await entered.promise;
  const queued = assert.rejects(client.list(), { code: 'SKILL_DRAFT_WORKER_FAILED' });
  const closing = client.close(); let closed = false;
  closing.then(() => { closed = true; });
  worker.emit('error', new Error('Synthetic idle worker crash')); worker.emit('exit', 1);
  await queued;
  assert.equal(closed, false, 'Worker exit does not finish the host-side write');
  assert.equal(fake.instances.length, 1);
  release.resolve();
  assert.equal(await writing, 'saved'); await closing;
  assert.equal(fake.instances.length, 1, 'Close must not restart a failed worker');
});

test('publication and rollback commit host metadata before the next queued edit', async t => {
  const h = fixture(t), fake = fakeWorkers({ closeAutomatically: true }), client = h.client({ WorkerClass: fake.FakeWorker });
  for (const method of ['publish', 'rollback']) {
    const order = [];
    const onCommitted = result => { assert.equal(result.committed, method); order.push('active'); };
    const operation = method === 'publish' ? client.publish('candidate', onCommitted)
      : client.rollback('guide', 'version', { reason: 'Synthetic' }, onCommitted);
    const edit = client.runExclusive(() => { order.push('archived'); });
    const worker = fake.instances[0], request = worker.sent.at(-1);
    assert.equal(request.method, method);
    assert.deepEqual(request.args, method === 'publish' ? ['candidate'] : ['guide', 'version', { reason: 'Synthetic' }]);
    worker.reply({ committed: method });
    assert.deepEqual(order, ['active'], 'Completion hook must run inside the receipt, before promise continuations');
    await operation; await edit;
    assert.deepEqual(order, ['active', 'archived']);
  }
});

test('completion hooks require synchronous callbacks and never replay a committed mutation', async t => {
  const h = fixture(t), fake = fakeWorkers({ closeAutomatically: true }), client = h.client({ WorkerClass: fake.FakeWorker });
  await assert.rejects(client.publish('one', 'invalid'), /must be synchronous/);
  await assert.rejects(client.publish('one', async () => {}), /must be synchronous/);
  assert.equal(fake.instances.length, 0, 'Invalid hook must fail before dispatch');
  const nested = [];
  const failed = assert.rejects(client.publish('one', () => {
    nested.push(assert.rejects(client.list(), { code: 'SKILL_DRAFT_REENTRANT' }));
    throw new Error('Synthetic metadata failure');
  }), error => error.code === 'SKILL_DRAFT_COMMIT_HOOK_FAILED' && error.committed === true
    && error.cause.message === 'Synthetic metadata failure');
  const after = client.runExclusive(() => 'next edit');
  const worker = fake.instances[0]; worker.reply({ published: true });
  await failed; await Promise.all(nested); assert.equal(await after, 'next edit');
  assert.deepEqual(worker.sent.map(request => request.method), ['publish']);
  const asynchronous = assert.rejects(client.publish('two', () => Promise.resolve()), error =>
    error.code === 'SKILL_DRAFT_COMMIT_HOOK_FAILED' && error.committed === true && /must be synchronous/.test(error.cause.message));
  worker.reply({ published: true }); await asynchronous;
  assert.deepEqual(worker.sent.map(request => request.method), ['publish', 'publish']);
});

test('failed worker operations do not invoke the successful commit hook', async t => {
  const h = fixture(t), fake = fakeWorkers({ closeAutomatically: true }), client = h.client({ WorkerClass: fake.FakeWorker });
  const failed = assert.rejects(client.publish('one', () => assert.fail('No commit occurred')), { code: 'BASE_CONFLICT' });
  const worker = fake.instances[0];
  worker.emit('message', { requestId: worker.sent[0].requestId, ok: false, error: { code: 'BASE_CONFLICT', message: 'Synthetic conflict' } });
  await failed;
  assert.equal(await client.runExclusive(() => 'next edit'), 'next edit');
});

test('client is lazy and closing an unused client creates no worker or directories', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  assert.equal(fake.instances.length, 0);
  assert.equal(fs.existsSync(h.options.draftsDir), false);
  await client.close();
  assert.equal(fake.instances.length, 0);
  await assert.rejects(client.list(), { code: 'SKILL_DRAFT_CLOSED' });
});

test('requests dispatch one at a time and close drains queued writes before graceful exit', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  const first = client.publish('one'), second = client.reject('two', 'Synthetic');
  const worker = fake.instances[0];
  assert.equal(worker.sent.length, 1); assert.equal(worker.sent[0].method, 'publish');
  const closing = client.close();
  assert.equal(client.close(), closing);
  await assert.rejects(client.list(), { code: 'SKILL_DRAFT_CLOSED' });
  assert.equal(worker.sent.length, 1, 'close must not interrupt the in-flight write');
  worker.reply({ published: true });
  assert.deepEqual(await first, { published: true });
  assert.equal(worker.sent.length, 2); assert.equal(worker.sent[1].method, 'reject');
  worker.reply({ rejected: true });
  assert.deepEqual(await second, { rejected: true });
  assert.deepEqual(worker.sent[2], { type: 'close' });
  worker.emit('exit', 0); await closing;
  assert(worker.refs >= 3); assert(worker.unrefs >= 1);
});

test('worker failure rejects active and queued requests without replaying a mutation', async t => {
  const h = fixture(t), fake = fakeWorkers(), client = h.client({ WorkerClass: fake.FakeWorker });
  const mutation = assert.rejects(client.publish('one'), { code: 'SKILL_DRAFT_RESULT_UNCONFIRMED' });
  const queued = assert.rejects(client.list(), { code: 'SKILL_DRAFT_WORKER_FAILED' });
  const worker = fake.instances[0];
  worker.emit('error', new Error('Synthetic crash'));
  await Promise.all([mutation, queued]);
  assert.equal(worker.sent.length, 1); assert.equal(fake.instances.length, 1);
  await assert.rejects(client.list(), { code: 'SKILL_DRAFT_WORKER_FAILED' });
  worker.emit('exit', 1);
  const explicitRead = client.list();
  const replacement = fake.instances[1];
  assert.deepEqual(replacement.sent.map(item => item.method), ['list']);
  replacement.reply([]); assert.deepEqual(await explicitRead, []);
  const closing = client.close(); replacement.emit('exit', 0); await closing;
});

test('real worker preserves list, diff, validation and rejection without publishing', async t => {
  const h = fixture(t), client = h.client();
  h.write(path.join(h.options.skillsDir, 'guide'));
  const staging = h.write(path.join(h.root, 'staging'), 'Candidate instructions');
  const draft = await client.createDraft({ skillName: 'guide', stagingDir: staging });
  assert.equal(draft.canPublish, true);
  assert.equal((await client.list()).length, 1);
  assert.match((await client.diff(draft.id)).text, /Candidate instructions/);
  assert.equal((await client.validate(draft.id)).ok, true);
  assert.equal((await client.get(draft.id)).id, draft.id);
  await assert.rejects(client._request('constructor', []), /Unknown skill draft operation/);
  const rejected = await client.reject(draft.id, 'Not needed');
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.canPublish, false);
  assert.match(fs.readFileSync(path.join(h.options.skillsDir, 'guide/SKILL.md'), 'utf8'), /Original instructions/);
});

test('concurrent publications serialize, retain the stale guard, and close preserves the committed write', async t => {
  const h = fixture(t), client = h.client();
  h.write(path.join(h.options.skillsDir, 'guide'));
  const one = await client.createDraft({ skillName: 'guide', stagingDir: h.write(path.join(h.root, 'one'), 'First candidate') });
  const two = await client.createDraft({ skillName: 'guide', stagingDir: h.write(path.join(h.root, 'two'), 'Second candidate') });
  const published = client.publish(one.id);
  const rejected = assert.rejects(client.publish(two.id), { code: 'BASE_CONFLICT' });
  const closing = client.close();
  const result = await published; await rejected; await closing;
  assert.equal(result.draft.status, 'published');
  assert.match(fs.readFileSync(path.join(h.options.skillsDir, 'guide/SKILL.md'), 'utf8'), /First candidate/);
  const persisted = new SkillDraftService(h.options);
  assert.equal(persisted.get(one.id).status, 'published');
  assert.equal(persisted.get(two.id).status, 'draft');
  assert.equal(persisted.listHistory('guide').length, 1);
});

test('host save queued after final publication check cannot be overwritten by the live swap', async t => {
  const h = fixture(t), barrier = new Int32Array(new SharedArrayBuffer(4));
  const { Worker } = require('node:worker_threads');
  class BarrierWorker extends Worker {
    constructor(file, options) {
      super(`const fs=require('node:fs'),path=require('node:path'),{workerData,parentPort}=require('node:worker_threads');
        const original=fs.renameSync;
        fs.renameSync=function(from,to,...args){
          if(from===path.join(workerData.skillsDir,'guide')&&path.basename(to).startsWith('.relay-previous-guide-')){
            parentPort.postMessage({probe:'checked-before-swap'});
            const result=Atomics.wait(new Int32Array(workerData.barrier),0,0,10000);
            if(result==='timed-out')throw new Error('Publication test barrier timed out');
          }
          return original.call(this,from,to,...args);
        };
        require(${JSON.stringify(file)});`, { ...options, eval: true, workerData: { ...options.workerData, barrier: barrier.buffer } });
    }
  }
  const client = h.client({ WorkerClass: BarrierWorker });
  h.write(path.join(h.options.skillsDir, 'guide'));
  const draft = await client.createDraft({ skillName: 'guide', stagingDir: h.write(path.join(h.root, 'candidate'), 'Published candidate') });
  const live = path.join(h.options.skillsDir, 'guide', 'SKILL.md');
  const userEdit = fs.readFileSync(live, 'utf8') + '\nUser saved new instructions\n';
  const checked = new Promise(resolve => client.worker.on('message', message => {
    if (message.probe === 'checked-before-swap') resolve();
  }));
  const publication = client.publish(draft.id);
  try {
    await checked;
    let saved = false;
    const save = client.runExclusive(() => {
      const temporary = `${live}.edit.tmp`;
      fs.writeFileSync(temporary, userEdit, 'utf8');
      fs.renameSync(temporary, live);
      saved = true;
      return { saved: true };
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved, false, 'Host save must wait while the worker is between manifest check and live swap');
    Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
    const published = await publication;
    assert.equal(published.draft.status, 'published');
    assert.deepEqual(await save, { saved: true });
    assert.equal(fs.readFileSync(live, 'utf8'), userEdit, 'Successful user save must survive publication');
    const history = path.join(h.options.draftsDir, 'history', 'guide', published.history.id, 'package', 'SKILL.md');
    assert.match(fs.readFileSync(history, 'utf8'), /Original instructions/);
    assert.doesNotMatch(fs.readFileSync(history, 'utf8'), /User saved new instructions/);
  } finally {
    Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
    await publication.catch(() => {});
  }
});

test('host save queued before publication preserves the stale base conflict guard', async t => {
  const h = fixture(t), client = h.client();
  h.write(path.join(h.options.skillsDir, 'guide'));
  const draft = await client.createDraft({ skillName: 'guide', stagingDir: h.write(path.join(h.root, 'candidate'), 'Candidate') });
  const live = path.join(h.options.skillsDir, 'guide', 'SKILL.md');
  const save = client.runExclusive(() => fs.appendFileSync(live, '\nUser edit before publication\n'));
  const publication = assert.rejects(client.publish(draft.id), { code: 'BASE_CONFLICT' });
  await save; await publication;
  assert.match(fs.readFileSync(live, 'utf8'), /User edit before publication/);
  assert.equal((await client.get(draft.id)).status, 'draft');
  assert.deepEqual(await client.listHistory('guide'), []);
});

test('real worker refuses tampered stored proposals and reports complete validation details', async t => {
  const h = fixture(t), client = h.client();
  h.write(path.join(h.options.skillsDir, 'guide'));
  const draft = await client.createDraft({ skillName: 'guide', stagingDir: h.write(path.join(h.root, 'one'), 'Candidate') });
  fs.appendFileSync(path.join(h.options.draftsDir, 'drafts', draft.id, 'proposed/SKILL.md'), 'Tampered');
  await assert.rejects(client.publish(draft.id), error => error.code === 'DRAFT_INVALID'
    && error.details.some(item => item.code === 'DRAFT_PACKAGE_CHANGED'));
  assert.equal((await client.list())[0].readiness, 'invalid');
  assert.match(fs.readFileSync(path.join(h.options.skillsDir, 'guide/SKILL.md'), 'utf8'), /Original instructions/);
});

test('SDK proposal partial failure carries already saved drafts and preserves staging cleanup', async t => {
  const h = fixture(t), client = h.client();
  let partial;
  await assert.rejects(client.stageProposals({ proposals: [
    { kind: 'new', name: 'guide', description: 'Synthetic', skillMd: '# Candidate' },
    { kind: 'new', name: '../unsafe', description: 'Synthetic', skillMd: '# Never saved' },
  ] }, { sourceRef: { type: 'sdk-proposal', runId: 'synthetic-run' } }), error => {
    partial = error.drafts;
    return partial?.length === 1 && partial[0].skillName === 'guide';
  });
  const listed = await client.list();
  assert.equal(listed.length, 1); assert.equal(listed[0].id, partial[0].id);
  assert.equal(listed[0].sourceRef.runId, 'synthetic-run');
  assert.equal(fs.existsSync(path.join(h.options.skillsDir, 'guide')), false);
  assert.deepEqual(fs.readdirSync(h.options.stagingRoot), []);
});

test('main-thread heartbeat continues during real package reads after worker startup', async t => {
  const h = fixture(t);
  h.write(path.join(h.options.skillsDir, 'guide'));
  const staging = h.write(path.join(h.root, 'staging'), 'Candidate');
  const service = new SkillDraftService(h.options);
  const draft = service.createDraft({ skillName: 'guide', stagingDir: staging });
  const workerFile = path.join(h.root, 'instrumented-worker.cjs');
  fs.writeFileSync(workerFile, `const fs=require('node:fs'),{parentPort}=require('node:worker_threads');
    let enabled=false,delayed=false;
    parentPort.on('message',r=>{enabled=r.method==='list';delayed=false;});
    const read=fs.readFileSync;
    fs.readFileSync=function(file,...args){
      if(enabled&&!delayed&&String(file).includes('proposed')){delayed=true;parentPort.postMessage({probe:'package-read'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);}
      return read.call(this,file,...args);
    };
    require(${JSON.stringify(path.resolve(__dirname, '../src/main/skills/skill-draft-worker.js'))});`);
  const client = h.client({ workerFile });
  await client.get(draft.id); // Startup has finished before heartbeat measurement.
  const beganReading = new Promise(resolve => client.worker.on('message', message => { if (message.probe === 'package-read') resolve(); }));
  const listed = client.list();
  await beganReading;
  let beats = 0;
  const interval = setInterval(() => beats++, 20);
  try { assert.equal((await listed)[0].canPublish, true); } finally { clearInterval(interval); }
  assert(beats >= 3, `Expected heartbeat during package read, observed ${beats}`);
});
