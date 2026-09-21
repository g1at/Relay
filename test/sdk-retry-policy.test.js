'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SdkRetryGuard, CONNECTION_FAILURE_MESSAGE, RETRY_ENV, RETRY_CONTROL_FAILURE,
  interruptFailedConnection, closeFailedRetryQuery } = require('../sdk-retry-policy');
const { buildRelayRuntimeEnv } = require('../claude-sdk');
const retry = (attempt, error_status = null) => ({ type: 'system', subtype: 'api_retry', attempt, error_status,
  max_retries: 300, retry_delay_ms: 1000 });

test('retry settings are local to the SDK subprocess and ignore inherited retry policy', () => {
  const previous = process.env.CLAUDE_CODE_RETRY_WATCHDOG;
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '0';
  try {
    const env = buildRelayRuntimeEnv();
    for (const [key, value] of Object.entries(RETRY_ENV)) assert.equal(env[key], value);
    assert.equal(process.env.CLAUDE_CODE_RETRY_WATCHDOG, '0');
    const fixture = buildRelayRuntimeEnv({ claude_code_retry_watchdog: '0', claude_code_max_retries: '0' });
    assert.equal(fixture.CLAUDE_CODE_RETRY_WATCHDOG, '0');
    assert.equal(fixture.CLAUDE_CODE_MAX_RETRIES, '0');
    assert.equal(fixture.claude_code_max_retries, undefined);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_RETRY_WATCHDOG;
    else process.env.CLAUDE_CODE_RETRY_WATCHDOG = previous;
  }
});

test('429, 529, 500, 503 never trigger the connection guard or replay input', async () => {
  let calls = 0;
  const guard = new SdkRetryGuard({ interrupt: () => { calls++; } });
  for (const status of [429, 529, 500, 503]) {
    for (let attempt = 1; attempt <= 25; attempt++) {
      const event = await guard.observe(retry(attempt, status));
      assert.equal(event.relay_retry_policy, 'persistent');
      assert.equal(event.error_status, status);
    }
  }
  assert.equal(calls, 0);
});

test('three distinct consecutive connection failures interrupt once and retain native result ownership', async () => {
  let calls = 0;
  const guard = new SdkRetryGuard({ interrupt: () => { calls++; } });
  for (const attempt of [1, 1, 2, 2]) await guard.observe(retry(attempt));
  assert.equal(calls, 0);
  await guard.observe(retry(3));
  await guard.observe(retry(3));
  assert.equal(calls, 1);
  const result = await guard.observe({ type: 'result', uuid: 'native-result', user_message_uuid: 'original-input',
    terminal_reason: 'aborted_streaming', usage: { input_tokens: 42 } });
  assert.equal(result.terminal_reason, 'api_error');
  assert.equal(result.relay_retry_stopped, 'connection_unavailable');
  assert.equal(result.result, CONNECTION_FAILURE_MESSAGE);
  assert.equal(result.user_message_uuid, 'original-input');
  assert.deepEqual(result.usage, { input_tokens: 42 });
  const next = { type: 'result', subtype: 'success', result: 'continued' };
  assert.equal(await guard.observe(next), next);
});

test('a successful response or HTTP error clears the consecutive no-response count', async () => {
  let calls = 0;
  const guard = new SdkRetryGuard({ interrupt: () => { calls++; } });
  for (const reset of [{ type: 'stream_event', event: { type: 'message_start' } }, retry(3, 429),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }]) {
    await guard.observe(retry(1)); await guard.observe(retry(2));
    await guard.observe(reset);
  }
  assert.equal(calls, 0);
});

test('subagent retries cannot interrupt the parent turn', async () => {
  let calls = 0;
  const guard = new SdkRetryGuard({ interrupt: () => { calls++; } });
  for (let attempt = 1; attempt <= 5; attempt++) await guard.observe({ ...retry(attempt), parent_tool_use_id: 'child' });
  assert.equal(calls, 0);
});

test('user pause wins while the connection guard interrupt is still pending', async () => {
  let release;
  const guard = new SdkRetryGuard({ interrupt: () => new Promise(resolve => { release = resolve; }) });
  await guard.observe(retry(1)); await guard.observe(retry(2));
  const pending = guard.observe(retry(3));
  await Promise.resolve();
  guard.cancel(); release(); await pending;
  const paused = { type: 'result', terminal_reason: 'aborted_streaming' };
  assert.equal(await guard.observe(paused), paused);
});

test('abort clears pending network error and never replaces explicit cancel', async () => {
  const controller = new AbortController();
  const guard = new SdkRetryGuard({ interrupt() {}, signal: controller.signal });
  await guard.observe(retry(1)); await guard.observe(retry(2)); await guard.observe(retry(3));
  controller.abort();
  const event = { type: 'result', terminal_reason: 'aborted_tools' };
  assert.equal(await guard.observe(event), event);
});

test('failed control acknowledgement surfaces a connection error rather than a success', async () => {
  const guard = new SdkRetryGuard({ interrupt() { throw Error('control unavailable'); } });
  await guard.observe(retry(1)); await guard.observe(retry(2));
  await assert.rejects(guard.observe(retry(3)), { message: CONNECTION_FAILURE_MESSAGE });
});

test('missing SDK interrupt acknowledgement has a bounded failure and keeps the connection cause', async () => {
  const guard = new SdkRetryGuard({ interrupt: () => new Promise(() => {}), interruptTimeoutMs: 10 });
  await guard.observe(retry(1)); await guard.observe(retry(2));
  await assert.rejects(guard.observe(retry(3)), error => error.code === RETRY_CONTROL_FAILURE
    && error.message === CONNECTION_FAILURE_MESSAGE && /timed out/.test(error.cause?.message));
  assert.equal(guard.cancelWait, null);
});

test('manual cancellation releases an unacknowledged guard interrupt immediately', async () => {
  const guard = new SdkRetryGuard({ interrupt: () => new Promise(() => {}), interruptTimeoutMs: 30000 });
  await guard.observe(retry(1)); await guard.observe(retry(2));
  const pending = guard.observe(retry(3));
  guard.cancel();
  await pending;
  assert.equal(guard.pendingError, null);
  assert.equal(guard.cancelWait, null);
});

test('a completed response queued before the interrupt keeps its delivered answer', async () => {
  const guard = new SdkRetryGuard({ interrupt() {} });
  await guard.observe(retry(1)); await guard.observe(retry(2)); await guard.observe(retry(3));
  await guard.observe({ type: 'stream_event', event: { type: 'message_start' } });
  const success = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'delivered answer' };
  assert.equal(await guard.observe(success), success);
  assert.equal(guard.pendingError, null);
});

test('a precise permanent SDK error wins over a pending connection interruption', async () => {
  const guard = new SdkRetryGuard({ interrupt() {} });
  await guard.observe(retry(1)); await guard.observe(retry(2)); await guard.observe(retry(3));
  const denied = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Invalid API key', api_error_status: 401 };
  assert.equal(await guard.observe(denied), denied);
});

test('network stop atomically cancels queued commands using the verified public SDK option', async () => {
  const receipt = { still_queued: [], cancelled: ['queued-supplement'] };
  const calls = [];
  assert.equal(await interruptFailedConnection({ interrupt: async options => { calls.push(options); return receipt; } },
    ['interrupt_cancel_queued_v1']), receipt);
  assert.deepEqual(calls, [{ cancelQueued: true }]);
});

test('legacy capabilities, missing receipts and surviving inputs require session cleanup', async () => {
  let calls = 0;
  await assert.rejects(interruptFailedConnection({ interrupt() { calls++; } }, []));
  assert.equal(calls, 0, 'do not start a racy legacy interrupt');
  for (const receipt of [undefined, { still_queued: [] }, { still_queued: ['pending'], cancelled: [] }]) {
    await assert.rejects(interruptFailedConnection({ interrupt: async () => receipt }, ['interrupt_cancel_queued_v1']));
  }
});

test('fallback cleanup closes the SDK transport and waits for public generator disposal', async () => {
  let complete, disposed = false;
  const calls = [];
  const closing = closeFailedRetryQuery({ close() { calls.push('close'); },
    return() { calls.push('return'); return new Promise(resolve => { complete = () => { disposed = true; resolve({ done: true }); }; }); } });
  assert.deepEqual(calls, ['close', 'return']);
  assert.equal(disposed, false);
  complete(); await closing;
  assert.equal(disposed, true);
});

test('live adapter waits for failed retry Query cleanup before announcing exit', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const sdkPath = path.join(__dirname, '../claude-sdk.js');
  const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  const originalRequire = require('node:module').createRequire(sdkPath);
  const calls = [];
  let releaseDispose, signal, exited = false;
  const fixtureSdk = { query({ options }) {
    signal = options.abortController.signal;
    return {
      interrupt() { calls.push('interrupt'); return new Promise(() => {}); },
      close() { calls.push('close'); },
      return() { calls.push('return'); return new Promise(resolve => { releaseDispose = resolve; }); },
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', capabilities: ['interrupt_cancel_queued_v1'] };
        yield retry(1); yield retry(2); yield retry(3);
      },
    };
  } };
  const context = vm.createContext({ fixtureSdk, process, AbortController, setTimeout, clearTimeout, console: { warn() {}, error() {} } });
  const factory = new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath }).runInContext(context);
  const loaded = { exports: {} };
  factory(name => name === './sdk-retry-policy' ? { ...originalRequire(name), SdkRetryGuard: class extends SdkRetryGuard {
    constructor(options) { super({ ...options, interruptTimeoutMs: 5 }); }
  } } : originalRequire(name), loaded, loaded.exports, path.dirname(sdkPath));
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const session = loaded.exports.createLiveSession({ cwd: process.cwd(), onMessage() {}, onExit(code, error) {
    exited = true; resolveExit({ code, error });
  } });
  const end = Date.now() + 2000;
  while (!releaseDispose) { assert.ok(Date.now() < end, 'cleanup entered'); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.deepEqual(calls, ['interrupt', 'close', 'return']);
  assert.equal(signal.aborted, true);
  assert.equal(exited, false, 'do not claim a stalled worker has stopped before cleanup');
  releaseDispose({ done: true });
  assert.deepEqual(await exit, { code: -1, error: CONNECTION_FAILURE_MESSAGE });
  await session.whenClosed();
});
