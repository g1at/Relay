'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { TaskClock } = require('../src/main/tasks/task-clock');

function fixture(events, clock) {
  const file = path.join(__dirname, '../src/main/sdk/claude-sdk.js');
  const localRequire = createRequire(file);
  const fakeSdk = { query({ prompt }) {
    return { initializationResult: async () => ({}), close() {}, async *[Symbol.asyncIterator]() {
      await prompt.next();
      for (const [at, event] of events) { clock.now = at; yield event; }
    } };
  } };
  const source = fs.readFileSync(file, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  const context = vm.createContext({ fixtureSdk: fakeSdk, process, AbortController, console: { warn() {}, error() {} }, setTimeout, clearTimeout });
  const factory = new vm.Script(`(function(require,module,exports,__dirname) {\n${source}\n})`, { filename: file }).runInContext(context);
  const loaded = { exports: {} };
  factory(name => name === '../tasks/task-clock' ? { TaskClock: class extends TaskClock {
    constructor(options) { super({ ...options, now: () => clock.now }); }
  } } : localRequire(name), loaded, loaded.exports, path.dirname(file));
  return loaded.exports;
}

test('SDK one-shot duration covers setup, HTTP retries and intermediate Agent results without changing native durations', async () => {
  const clock = { now: 1000 }, received = [];
  const sdk = fixture([
    [4000, { type: 'system', subtype: 'init' }],
    [6000, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 429, retry_delay_ms: 5000 }],
    [10000, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tool', input: {} }] } }],
    [12000, { type: 'system', subtype: 'task_started', task_id: 'agent', tool_use_id: 'tool', task_type: 'local_agent', subagent_type: 'analyst' }],
    [18000, { type: 'result', subtype: 'success', result: 'waiting', duration_ms: 300 }],
    [21000, { type: 'system', subtype: 'task_notification', task_id: 'agent', tool_use_id: 'tool', status: 'completed' }],
    [30000, { type: 'result', subtype: 'success', result: 'delivered', duration_ms: 500 }],
  ], clock);
  const { handle } = sdk.runOneShot({ prompt: 'synthetic timing task', taskStartedAt: 500,
    runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, onEvent: event => received.push(event) });
  await handle.whenClosed();
  const results = received.filter(event => event.type === 'result');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(event => event.duration_ms), [300, 500]);
  assert.ok(received.slice(0, -1).every(event => event.relay_task_started_at === 500 && event.relay_task_finished_at === undefined));
  assert.equal(received.at(-1).type, 'job-done');
  assert.equal(received.at(-1).relay_task_duration_ms, 29500);
  assert.equal(received.at(-1).finalResult.duration_ms, 500);
});

test('SDK preparation failure and cancellation still emit one final wall-clock duration', async () => {
  for (const canceled of [false, true]) {
    const clock = { now: 1000 }, received = [];
    const sdk = fixture([], clock);
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    sdk.configureRuntimeEnvironment({ async prepareOptions() { entered(); await pending; throw Error('synthetic preparation failure'); } });
    const { handle } = sdk.runOneShot({ prompt: 'fixture', onEvent: event => received.push(event) });
    await ready;
    clock.now = 6000;
    if (canceled) void handle.kill();
    release(); await handle.whenClosed();
    const done = received.filter(event => event.type === 'job-done');
    assert.equal(done.length, 1);
    assert.equal(done[0].relay_task_duration_ms, 5000);
    assert.equal(done[0].exitCode, -1);
    assert.equal(!!done[0].aborted, canceled);
  }
});

test('SDK camel-case child result remains nonterminal through ownership routing and retries', async () => {
  const clock = { now: 1000 }, received = [];
  const sdk = fixture([
    [2000, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Agent', input: {} }] } }],
    [3000, { type: 'system', subtype: 'api_retry', parentToolUseId: 'tool', error_status: null, attempt: 1 }],
    [4000, { type: 'system', subtype: 'api_retry', parentToolUseId: 'tool', error_status: null, attempt: 2 }],
    [5000, { type: 'system', subtype: 'api_retry', parentToolUseId: 'tool', error_status: null, attempt: 3 }],
    [6000, { type: 'result', subtype: 'success', parentToolUseId: 'tool', result: 'child', duration_ms: 5 }],
    [11000, { type: 'result', subtype: 'success', result: 'parent', duration_ms: 50 }],
  ], clock);
  const { handle } = sdk.runOneShot({ prompt: 'fixture', runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, onEvent: event => received.push(event) });
  await handle.whenClosed();
  const child = received.find(event => event.type === 'result' && event.parentToolUseId);
  assert.equal(child.parent_tool_use_id, 'tool');
  assert.equal(child.relay_task_finished_at, undefined);
  assert.equal(received.at(-1).type, 'job-done');
  assert.equal(received.at(-1).finalResult.result, 'parent');
  assert.equal(received.at(-1).relay_task_duration_ms, 10000);
});

test('SDK resumed segment emits cumulative active duration rather than its last attempt duration', async () => {
  const clock = { now: 100000 }, received = [];
  const sdk = fixture([
    [110000, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 429, retry_delay_ms: 5000 }],
    [167000, { type: 'result', subtype: 'success', result: 'resumed result', duration_ms: 67000 }],
  ], clock);
  const { handle } = sdk.runOneShot({ prompt: 'resume fixture', taskRun: {
    version: 1, taskId: 'logical-task', resumedFromRunId: 'previous-run', rootStartedAt: 1000,
    segmentStartedAt: 100000, elapsedBeforeMs: 36000 },
    runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, onEvent: event => received.push(event) });
  await handle.whenClosed();
  assert.equal(received.at(-1).relay_task_duration_ms, 103000);
  assert.equal(received.at(-1).relay_task_segment_started_at, 100000);
  assert.equal(received.at(-1).relay_task_id, 'logical-task');
  assert.equal(received.at(-1).finalResult.duration_ms, 67000);
});
