'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { LiveTurnControls } = require('../live-turn-control');

// Exercise the real adapter with an in-memory Query and synthetic attachment
// preparation. No model, native process, provider, or real history is opened.
const sdkPath = path.join(__dirname, '../claude-sdk.js');
const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;',
  'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture progress timed out'); await tick(); }
}
function fixture(t, { initialization, beforeResult, prepareContent, capabilities = ['interrupt_cancel_queued_v1'], receipt } = {}) {
  const inputs = [], events = [], interrupts = [], exits = [];
  let initializing = false;
  const fixtureSdk = { query({ prompt }) {
    return {
      async initializationResult() { initializing = true; if (initialization) await initialization; return {}; },
      async interrupt(...args) {
        interrupts.push(clone(args));
        return receipt || { cancelled: ['native-queued'], still_queued: [] };
      },
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', ...(capabilities == null ? {} : { capabilities }) };
        for await (const input of prompt) {
          inputs.push(input);
          if (beforeResult) await beforeResult(input);
          yield { type: 'result', subtype: 'success', is_error: false, result: 'synthetic response', user_message_uuid: input.uuid };
        }
      },
    };
  } };
  const localRequire = createRequire(sdkPath), loaded = { exports: {} };
  const context = vm.createContext({ fixtureSdk, process, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} } });
  new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath }).runInContext(context)(
    name => name === './attachment-input' ? { ...localRequire(name),
      prepareAttachmentContent: prepareContent || (async text => [{ type: 'text', text }]) } : localRequire(name),
    loaded, loaded.exports, path.dirname(sdkPath));
  const session = loaded.exports.createLiveSession({ onMessage: event => events.push(event),
    onExit: (code, error) => exits.push({ code, error }) });
  t.after(() => session.kill());
  return { session, inputs, events, interrupts, exits, initializing: () => initializing };
}

test('manual stop withdraws all local next/later inputs before the current reply drains', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = fixture(t, { beforeResult: input => input.uuid === 'original' ? gate.promise : undefined });
  h.session.push('original', { uuid: 'original' }); await until(() => h.inputs.length === 1);
  h.session.push('must not reach SDK', { uuid: 'next', priority: 'next' });
  h.session.push('must not reach SDK either', { uuid: 'later', priority: 'later' });
  const stopped = h.session.interrupt();
  gate.resolve(); await stopped; await tick();
  assert.deepEqual(h.inputs.map(input => input.uuid), ['original']);
  assert.deepEqual(h.interrupts, [[{ cancelQueued: true }]]);
  assert.equal(h.exits.length, 0, 'manual stop preserves the reusable Query');
  h.session.push('explicit new turn', { uuid: 'resumed' }); await until(() => h.inputs.length === 2);
  assert.deepEqual(h.inputs.map(input => input.uuid), ['original', 'resumed']);
});

for (const outcome of ['resolve', 'reject']) {
  test(`manual stop prevents a late attachment ${outcome} from sending input or closing the reusable Query`, async t => {
    const gate = deferred(); let reading = false; t.after(() => gate.resolve());
    const h = fixture(t, { prepareContent: async text => {
      if (text === 'stale attachment') { reading = true; await gate.promise; }
      return [{ type: 'text', text }];
    } });
    h.session.push('stale attachment', { uuid: 'stale', files: [{ path: '/synthetic/image.png' }] });
    await until(() => reading);
    await h.session.interrupt();
    assert.equal(h.inputs.length, 0, 'stop does not await attachment completion');
    h.session.push('new explicit turn', { uuid: 'new' });
    if (outcome === 'reject') gate.reject(Error('synthetic late attachment error')); else gate.resolve();
    await until(() => h.inputs.length === 1);
    assert.deepEqual(h.inputs.map(input => input.uuid), ['new']);
    assert.equal(h.exits.length, 0);
  });
}

test('stop during initialization clears the queued item without destructuring an empty queue', async t => {
  const ready = deferred(); t.after(() => ready.resolve());
  const h = fixture(t, { initialization: ready.promise });
  h.session.push('canceled before ready', { uuid: 'stale' });
  await until(h.initializing);
  const stopped = h.session.interrupt();
  ready.resolve(); await stopped; await tick();
  assert.deepEqual(h.inputs, []); assert.deepEqual(h.exits, []);
  h.session.push('explicit after stop', { uuid: 'new' }); await until(() => h.inputs.length === 1);
  assert.equal(h.inputs[0].uuid, 'new');
});

test('manual stop always requests atomic queue cancellation even before an init capability is known', async t => {
  for (const capabilities of [null, [], ['interrupt_cancel_queued_v1']]) {
    const h = fixture(t, { capabilities });
    const receipt = await h.session.interrupt();
    assert.deepEqual(h.interrupts, [[{ cancelQueued: true }]]);
    assert.deepEqual(receipt, { cancelled: ['native-queued'], still_queued: [] });
    await h.session.kill();
  }
});

test('a legacy CLI surviving-queue receipt remains visible to the host recycle guard', async t => {
  const receipt = { still_queued: ['legacy-native-queued'] }, killed = [];
  const h = fixture(t, { capabilities: [], receipt });
  const session = { jobId: 'run', convId: 'conversation', busy: true, child: h.session, turnRouter: { interrupt() {} } };
  const controls = new LiveTurnControls({ cancelPendingInput: () => false,
    withTimeout: promise => promise,
    waitForIdle() { assert.fail('surviving input must recycle before treating the turn as idle'); },
    killSession(value, reason) { assert.equal(value, session); killed.push(reason); return h.session.kill(); },
  });
  const result = await controls.interrupt(session);
  assert.deepEqual(h.interrupts, [[{ cancelQueued: true }]]);
  assert.deepEqual(receipt.still_queued, ['legacy-native-queued'], 'do not pretend an old CLI honored the new option');
  assert.equal(killed.length, 1); assert.equal(result.fallback, true);
  assert.equal(result.preservedSession, false); assert.equal(result.settled, true);
});

test('an attachment failure that was not canceled still reports an adapter failure', async t => {
  const h = fixture(t, { prepareContent: async () => { throw Error('synthetic uncanceled attachment error'); } });
  h.session.push('fixture', { uuid: 'not-canceled' });
  await h.session.whenClosed();
  assert.equal(h.inputs.length, 0); assert.equal(h.exits[0].code, -1);
  assert.match(h.exits[0].error, /uncanceled attachment error/);
});
