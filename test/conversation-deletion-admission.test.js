'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unavailable = () => Object.assign(Error('Conversation is being deleted'), { code: 'CONVERSATION_DELETING' });

function imageFixture({ blocked = false, lease = null } = {}) {
  const counters = { created: 0, acquired: 0, released: 0, generated: 0, finished: 0 };
  const state = { blocked };
  let handler;
  const begin = source.indexOf("ipcMain.handle('image:generate',");
  const end = source.indexOf('// IPC: 删除"我的创作"', begin);
  assert.ok(begin >= 0 && end > begin, 'real image handler source must be present');
  vm.runInNewContext(source.slice(begin, end), {
    ipcMain: { handle(name, callback) { assert.equal(name, 'image:generate'); handler = callback; } },
    crypto: { randomUUID: () => 'generated-run' },
    resolveMediaRequest: opts => ({ model: opts.model || 'fixture-image', mediaKind: 'image' }),
    assertConversationAvailable(id) { assert.equal(id, 'conversation'); if (state.blocked) throw unavailable(); },
    createShadowTaskRun() { counters.created++; return { runId: 'image-run' }; },
    taskLedger: null, TASK_EVENT_EPOCH: 'synthetic-epoch', RUN_STATES: { QUEUED: 'queued' }, compactText: text => text,
    async acquireTaskResource() { counters.acquired++; return lease ? lease.promise : { signal: null }; },
    releaseTaskResource() { counters.released++; },
    updateScheduledShadowPhase() {},
    async generateImageCore() { counters.generated++; return { ok: true, paths: [] }; },
    materializeCreationTaskResult() {},
    finishShadowTaskRun() { counters.finished++; },
    console,
  });
  return { state, counters, run: () => handler({}, { conversationId: 'conversation', prompt: 'synthetic' }) };
}

function scheduledFixture({ blocked = false, lease = null, checkpoint = null } = {}) {
  const counters = { acquired: 0, released: 0, checked: 0 };
  const state = { blocked };
  const begin = source.indexOf('      taskRunAcquire: async (runId, actionType) => {');
  const end = source.indexOf('      taskRunRelease:', begin);
  assert.ok(begin >= 0 && end > begin, 'real scheduler admission source must be present');
  const callbacks = vm.runInNewContext('({' + source.slice(begin, end) + '})', {
    taskLedger: { get: () => ({ source: { conversationId: 'conversation' }, metadata: { workingDir: 'synthetic' } }) },
    assertConversationAvailable(id) { assert.equal(id, 'conversation'); if (state.blocked) throw unavailable(); },
    async waitForCheckpointUnlock() {
      counters.checked++;
      return checkpoint && counters.checked === 2 ? checkpoint.promise : true;
    },
    async acquireTaskResource() { counters.acquired++; return lease ? lease.promise : { signal: null }; },
    releaseTaskResource() { counters.released++; },
  });
  return { state, counters, run: type => callbacks.taskRunAcquire('scheduled-run', type) };
}

test('image requests for deleting chats fail before task creation or provider execution', async () => {
  const f = imageFixture({ blocked: true });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_DELETING');
  assert.deepEqual(f.counters, { created: 0, acquired: 0, released: 0, generated: 0, finished: 0 });
});

test('image requests recheck deletion after awaiting a resource and release the unused lease', async () => {
  const lease = deferred(), f = imageFixture({ lease });
  const pending = f.run();
  assert.equal(f.counters.acquired, 1);
  f.state.blocked = true; lease.resolve({ signal: null });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.code, 'CONVERSATION_DELETING');
  assert.equal(f.counters.generated, 0); assert.equal(f.counters.released, 1);
  assert.equal(f.counters.finished, 1);
});

test('available image requests still execute and release their resource', async () => {
  const f = imageFixture();
  assert.equal((await f.run()).ok, true);
  assert.equal(f.counters.generated, 1); assert.equal(f.counters.released, 1);
});

test('scheduled chat, image and command admission rejects deleting chats before waiting for resources', async () => {
  for (const type of ['chat', 'image', 'command']) {
    const f = scheduledFixture({ blocked: true });
    await assert.rejects(f.run(type), { code: 'CONVERSATION_DELETING' });
    assert.equal(f.counters.acquired, 0); assert.equal(f.counters.released, 0);
  }
});

test('scheduled admission rechecks after resource wait and releases its unused lease', async () => {
  const lease = deferred(), f = scheduledFixture({ lease });
  const pending = f.run('command');
  for (let i = 0; i < 8 && f.counters.acquired < 1; i++) await Promise.resolve();
  assert.equal(f.counters.acquired, 1);
  f.state.blocked = true; lease.resolve({ signal: null });
  await assert.rejects(pending, { code: 'CONVERSATION_DELETING' });
  assert.equal(f.counters.released, 1);
});

test('scheduled admission rechecks after checkpoint wait and releases its unused lease', async () => {
  const checkpoint = deferred(), f = scheduledFixture({ checkpoint });
  const pending = f.run('image');
  for (let i = 0; i < 8 && f.counters.checked < 2; i++) await Promise.resolve();
  assert.equal(f.counters.checked, 2);
  f.state.blocked = true; checkpoint.resolve(true);
  await assert.rejects(pending, { code: 'CONVERSATION_DELETING' });
  assert.equal(f.counters.released, 1);
});

test('available scheduled requests retain their lease for the scheduler to release', async () => {
  const f = scheduledFixture();
  assert.ok(await f.run('chat'));
  assert.equal(f.counters.acquired, 1); assert.equal(f.counters.released, 0);
});
