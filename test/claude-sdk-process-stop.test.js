'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const sdkPath = path.join(__dirname, '../src/main/sdk/claude-sdk.js');
const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;',
  'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
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

// Keep the real Relay query adapter, its actual spawn interception, and the
// real supervisor. Only replace the SDK and OS child, without user data/API IO.
function fixture(t, kind, { prepareGate, deferSpawn = false, throwQuery = false, resourceClose } = {}) {
  const state = { queryCalls: 0, prepared: false, spawned: false, closeCalls: 0,
    returnCalls: 0, nextCalls: 0, events: [], exits: [], signals: [], stderr: [] };
  const child = new EventEmitter();
  Object.assign(child, { pid: 31415, exitCode: null, signalCode: null, killed: false,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal) { state.signals.push(signal); child.killed = true; return true; } });
  const queued = [], waiting = [];
  const deliver = item => { const next = waiting.shift(); if (next) next(item); else queued.push(item); };
  state.event = value => deliver({ done: false, value });
  state.end = () => deliver({ done: true });
  state.exit = (code = 0, signal = null) => {
    child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal); child.stderr.end();
  };
  const fixtureSdk = { query({ options }) {
    state.queryCalls++;
    state.spawn = () => {
      if (state.spawned) return;
      state.spawned = true;
      options.spawnClaudeCodeProcess({ command: 'fixture', args: [], env: {} });
    };
    if (!deferSpawn) state.spawn();
    if (throwQuery) throw Error('synthetic SDK query construction error');
    return {
      initializationResult: async () => ({}), interrupt: async () => ({ still_queued: [] }),
      close() { state.closeCalls++; },
      [Symbol.asyncIterator]() { return {
        next() { state.nextCalls++; return queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve)); },
        return() { state.returnCalls++; return Promise.resolve({ done: true }); },
      }; },
    };
  } };
  const loaded = { exports: {} };
  const context = vm.createContext({ fixtureSdk, process, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} } });
  new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath })
    .runInContext(context)(id => {
      const original = createRequire(sdkPath)(id);
      if (id === './sdk-runtime-closure') return { createRuntimeClosure: options => original.createRuntimeClosure({ ...options, timeoutMs: 15 }) };
      if (id === './host-stdio-mcp' && resourceClose) return { createRuntimeMcpMapper: () => Object.assign(servers => servers, { close: resourceClose }) };
      return original;
    }, loaded, loaded.exports, path.dirname(sdkPath));
  loaded.exports.configureRuntimeEnvironment({ ...(resourceClose ? { prepareMcpServers: async x => x } : {}), async prepareOptions(options, { onSpawn }) {
    state.prepared = true;
    if (prepareGate) await prepareGate;
    return { ...options, spawnClaudeCodeProcess() { onSpawn(child); return child; } };
  } });
  const parameters = { onMessage: event => state.events.push(event),
    onExit: (code, error) => state.exits.push({ code, error }), onEvent: event => state.events.push(event),
    stderr: text => state.stderr.push(text), prompt: 'synthetic stop fixture', userMessageId: 'fixture-user' };
  const handle = kind === 'live' ? loaded.exports.createLiveSession(parameters)
    : loaded.exports.runOneShot(parameters).handle;
  t.after(async () => {
    state.end();
    if (state.spawned && child.exitCode == null && child.signalCode == null) state.exit();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await tick();
  });
  return { handle, child, state };
}

for (const kind of ['live', 'one-shot']) {
  test(`${kind}: actual child exit completes manual stop even when Query never finishes`, async t => {
    const h = fixture(t, kind); await until(() => h.state.nextCalls > 0);
    let settled = false;
    const stopping = h.handle.kill(); stopping.then(() => { settled = true; });
    assert.equal(h.handle.kill(), stopping);
    await tick(); assert.equal(settled, false);
    h.state.exit(null, 'SIGKILL');
    const result = await stopping;
    assert.equal(result.stopConfirmed, true); assert.equal(result.pid, h.child.pid);
    assert.equal(result.exitCode, -1);
    if (kind === 'live') assert.equal(h.state.exits.length, 1);
    else assert.equal(h.state.events.filter(event => event.type === 'job-done').length, 1);
    const count = h.state.events.length;
    h.state.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'late result' }] } });
    h.state.end(); await tick(); await tick();
    assert.equal(h.state.events.length, count, 'late Query events cannot revive the stopped task');
    assert.equal(h.state.exits.length, kind === 'live' ? 1 : 0);
  });

  test(`${kind}: Query completion alone never confirms a still-running native process`, async t => {
    const h = fixture(t, kind); await until(() => h.state.nextCalls > 0);
    let settled = false; h.handle.whenClosed().then(() => { settled = true; });
    h.state.end(); await tick(); await tick();
    assert.equal(settled, false); assert.equal(h.state.exits.length, 0);
    assert.equal(h.state.events.filter(event => event.type === 'job-done').length, 0);
    h.state.exit();
    assert.equal((await h.handle.whenClosed()).stopConfirmed, true);
  });

  test(`${kind}: cancellation during preparation cannot confirm early or launch a late process`, async t => {
    const gate = deferred(); t.after(() => gate.resolve());
    const h = fixture(t, kind, { prepareGate: gate.promise });
    await until(() => h.state.prepared);
    let settled = false; const stopping = h.handle.kill(); stopping.then(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(h.state.spawned, false);
    gate.resolve(); const result = await stopping;
    assert.equal(result.stopConfirmed, true); assert.equal(result.notSpawned, true);
    assert.equal(h.state.queryCalls, 0); assert.equal(h.state.spawned, false);
  });

  test(`${kind}: a deferred SDK spawn remains supervised after cancellation`, async t => {
    const h = fixture(t, kind, { deferSpawn: true }); await until(() => h.state.nextCalls > 0);
    let settled = false; const stopping = h.handle.kill(); stopping.then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    h.state.spawn(); await tick(); assert.equal(settled, false);
    h.state.exit(null, 'SIGTERM');
    assert.equal((await stopping).stopConfirmed, true);
    assert.equal(h.handle.pid, h.child.pid);
  });

  test(`${kind}: an SDK construction error waits for the already spawned native child`, async t => {
    const h = fixture(t, kind, { throwQuery: true }); await until(() => h.state.spawned);
    let settled = false; h.handle.whenClosed().then(() => { settled = true; });
    await tick(); await tick(); assert.equal(settled, false);
    h.state.exit(); const result = await h.handle.whenClosed();
    assert.equal(result.stopConfirmed, true); assert.equal(result.exitCode, -1);
    if (kind === 'live') assert.match(h.state.exits[0].error, /synthetic SDK query construction error/);
    else assert.equal(h.state.events.filter(event => event.type === 'job-done').length, 1);
  });

  test(`${kind}: custom spawn continuously forwards stderr with intact UTF-8 characters once`, async t => {
    const h = fixture(t, kind); await until(() => h.state.nextCalls > 0);
    const bytes = Buffer.from('中');
    h.child.stderr.write(bytes.subarray(0, 1));
    h.child.stderr.write(bytes.subarray(1, 2));
    assert.deepEqual(h.state.stderr, []);
    h.child.stderr.write(bytes.subarray(2));
    assert.deepEqual(h.state.stderr, ['中']);
    assert.equal(h.child.listenerCount('exit'), 2, 'one raw supervisor and one SDK drain facade');
    const stopping = h.handle.kill(); h.state.exit();
    assert.equal((await stopping).stopConfirmed, true);
    assert.deepEqual(h.state.stderr, ['中']);
  });
}

test('a normal live result preserves the native process and supports another turn', async t => {
  const h = fixture(t, 'live'); await until(() => h.state.nextCalls > 0);
  h.state.event({ type: 'result', subtype: 'success', result: 'first completed turn', is_error: false });
  await until(() => h.state.events.length === 1);
  assert.equal(h.state.exits.length, 0); assert.deepEqual(h.state.signals, []);
  assert.equal(h.handle.push('second fixture turn'), true);
  h.state.event({ type: 'result', subtype: 'success', result: 'second completed turn', is_error: false });
  await until(() => h.state.events.length === 2);
  assert.equal(h.state.closeCalls, 0); assert.deepEqual(h.state.signals, []);
  const stopping = h.handle.kill(); h.state.exit(); await stopping;
});

for (const kind of ['live', 'one-shot']) {
  test(`${kind}: native exit with pending MCP cleanup returns refusal and retry confirms without duplicate completion`, async t => {
    const gate = deferred(); let closes = 0;
    t.after(() => gate.resolve());
    const h = fixture(t, kind, { resourceClose: () => { closes++; return gate.promise; } });
    await until(() => h.state.nextCalls > 0);
    const first = h.handle.kill(); h.state.exit();
    const pending = await first;
    assert.equal(pending.stopConfirmed, false); assert.equal(pending.code, 'RUNTIME_RESOURCE_CLEANUP_PENDING');
    const completions = () => kind === 'live' ? h.state.exits.length : h.state.events.filter(event => event.type === 'job-done').length;
    assert.equal(completions(), 1); assert.equal(closes, 1);
    assert.equal((await h.handle.kill()).stopConfirmed, false); assert.equal(closes, 1);
    gate.resolve(); await tick();
    assert.equal((await h.handle.whenClosed()).stopConfirmed, true);
    assert.equal(completions(), 1); assert.equal(closes, 1);
  });
  test(`${kind}: failed MCP cleanup retains the runtime and retries resource release`, async t => {
    let closes = 0;
    const h = fixture(t, kind, { resourceClose: () => { if (++closes === 1) throw Error('synthetic resource failure'); } });
    await until(() => h.state.nextCalls > 0);
    const first = h.handle.kill(); h.state.exit();
    assert.equal((await first).stopConfirmed, false);
    assert.equal((await h.handle.whenClosed()).stopConfirmed, true); assert.equal(closes, 2);
  });
}
