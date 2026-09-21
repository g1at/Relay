'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createUsageObserver } = require('../usage-capture');
const plain = value => JSON.parse(JSON.stringify(value));
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false,
  session_id: 'fixture-session', uuid: 'fixture-result', num_turns: 1,
  modelUsage: { 'vendor/model': { inputTokens: 100, outputTokens: 12, cacheReadInputTokens: 30, cacheCreationInputTokens: 4, costUSD: 99 } },
  usage: { input_tokens: 90, output_tokens: 10 }, result: 'PRIVATE SYNTHETIC OUTPUT', ...extra });

test('usage collection only forwards numeric metrics and opaque identity, never text or costs', () => {
  const collected = [];
  const observe = createUsageObserver(value => collected.push(value), { queryId: 'query', now: () => '2026-09-09T01:00:00Z' });
  observe({ type: 'assistant', message: { id: 'repeated-block', usage: { output_tokens: 1 } } });
  observe({ type: 'result' });
  observe(result({ parent_tool_use_id: 'parent' }));
  const event = result({ permission_denials: [{ tool_input: { token: 'private-input' } }], total_cost_usd: 99 });
  const before = JSON.stringify(event); observe(event);
  assert.equal(collected.length, 1);
  assert.equal(JSON.stringify(event), before);
  assert.equal(collected[0].startedAt, '2026-09-09T01:00:00Z');
  assert.deepEqual(plain(collected[0].modelUsage['vendor/model']), { inputTokens: 100, outputTokens: 12, cacheReadInputTokens: 30, cacheCreationInputTokens: 4 });
  assert.doesNotMatch(JSON.stringify(collected), /PRIVATE|private-input|costUSD|total_cost/);
});

test('resuming one session uses a fresh query identity while results retain session reset identity', () => {
  const records = [];
  const first = createUsageObserver(value => records.push(value));
  const resumed = createUsageObserver(value => records.push(value));
  first(result()); first(result({ session_id: 'after-clear', uuid: 'after-clear-result' })); resumed(result());
  assert.equal(records[0].queryId, records[1].queryId);
  assert.notEqual(records[0].queryId, records[2].queryId);
  assert.equal(records[1].sessionId, 'after-clear');
});

test('invalid numbers remain absent and collector failures cannot break execution', async () => {
  const records = [];
  createUsageObserver(value => records.push(value))(result({ modelUsage: { custom: { inputTokens: NaN, outputTokens: -4, cacheReadInputTokens: '20', cacheCreationInputTokens: 0 } }, usage: null }));
  assert.deepEqual(plain(records[0].modelUsage.custom), { cacheCreationInputTokens: 0 });
  assert.doesNotThrow(() => createUsageObserver(() => { throw Error('collector'); })(result()));
  createUsageObserver(() => Promise.reject(Error('collector async')))(result());
  await new Promise(setImmediate);
});

function sdkFixture(queryFactory) {
  const file = path.join(__dirname, '../claude-sdk.js');
  const original = fs.readFileSync(file, 'utf8');
  const source = original.replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  assert.notEqual(source, original);
  const fixtureSdk = { query: queryFactory || function ({ prompt }) {
    return { close() {}, async initializationResult() { return {}; }, async *[Symbol.asyncIterator]() {
      let input;
      if (typeof prompt !== 'string') {
        input = (await prompt[Symbol.asyncIterator]().next()).value;
        yield { ...input, isReplay: true };
      }
      yield result({ user_message_uuid: input?.uuid, queued_turn_count: 0 });
    } };
  } };
  const context = vm.createContext({ fixtureSdk, process, AbortController, setTimeout, clearTimeout, console: { warn() {}, error() {} } });
  const factory = new vm.Script(`(function(require,module,exports,__dirname){${source}\n})`, { filename: file }).runInContext(context);
  const loaded = { exports: {} };
  factory(createRequire(file), loaded, loaded.exports, path.dirname(file));
  return loaded.exports;
}

test('real live, one-shot and background SDK adapters each capture results once without changing completion', async () => {
  const sdk = sdkFixture(), captured = [], events = [];
  const options = { cwd: '/fixture', model: 'vendor/model', tools: [], onUsage: value => captured.push(value) };
  assert.equal(await sdk.runText({ ...options, prompt: 'synthetic', timeoutMs: 1000 }), 'PRIVATE SYNTHETIC OUTPUT');
  const oneShot = sdk.runOneShot({ ...options, prompt: 'synthetic', onEvent: event => events.push(event) });
  await oneShot.handle.whenClosed();
  assert.equal(events.at(-1).type, 'job-done'); assert.equal(events.at(-1).exitCode, 0);
  let live;
  await new Promise(resolve => {
    live = sdk.createLiveSession({ ...options, onMessage() {}, onExit: code => { assert.equal(code, 0); resolve(); } });
    live.push('synthetic', { uuid: 'live-input' });
  });
  assert.equal(captured.length, 3);
  assert.equal(new Set(captured.map(value => value.queryId)).size, 3);
  assert.ok(captured.every(value => value.modelUsage['vendor/model'].outputTokens === 12));
});

test('duplicate results remain deduplicated across an explicit conversation reset', () => {
  const records = [];
  const observe = createUsageObserver(record => records.push(record), { queryId: 'one-query' });
  observe(result({ uuid: 'before-reset' }));
  observe(result({ uuid: 'before-reset' }));
  observe({ type: 'conversation_reset', uuid: 'reset-event', new_conversation_id: 'reset-session' });
  observe(result({ uuid: 'before-reset' })); // Lagging replay keeps its old wrapper.
  observe(result({ uuid: 'after-reset', session_id: 'fixture-session',
    modelUsage: { main: { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
  assert.equal(records.length, 2);
  assert.equal(records[1].sessionId, 'reset-session');
  assert.equal(records[1].modelUsage.main.outputTokens, 4);
});

test('live, one-shot, text and structured adapters retain checkpoints when their Query throws before result', async () => {
  const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
  const captured = [];
  const sdk = sdkFixture(({ prompt }) => ({ close() {}, async initializationResult() { return {}; },
    async [method](options) { assert.equal(options.skipBehaviors, true); return { session: { model_usage: result().modelUsage } }; },
    async *[Symbol.asyncIterator]() {
      let input;
      if (typeof prompt !== 'string') { input = (await prompt[Symbol.asyncIterator]().next()).value; yield { ...input, isReplay: true }; }
      yield { type: 'system', subtype: 'init', session_id: 'fixture-session' };
      yield { type: 'assistant', session_id: 'fixture-session', user_message_uuid: input?.uuid,
        message: { id: 'request', model: 'vendor/model', content: [{ type: 'text', text: 'SYNTHETIC' }] } };
      await new Promise(resolve => setTimeout(resolve, 30));
      throw Error('synthetic exit without result');
    },
  }));
  const options = { cwd: '/fixture', model: 'vendor/model', tools: [], onUsage: record => captured.push(record) };
  await sdk.runText({ ...options, prompt: 'synthetic', timeoutMs: 1000 });
  const events = [];
  const oneShot = sdk.runOneShot({ ...options, prompt: 'synthetic', onEvent: event => events.push(event) });
  await oneShot.handle.whenClosed(); assert.equal(events.at(-1).exitCode, -1);
  await new Promise(resolve => {
    const live = sdk.createLiveSession({ ...options, onMessage() {}, onExit(code) { assert.equal(code, -1); resolve(); } });
    live.push('synthetic', { uuid: 'input' });
  });
  await assert.rejects(sdk.runStructured({ ...options, prompt: 'synthetic', schema: { type: 'object' }, validate: () => ({ success: true }), timeoutMs: 1000 }), /synthetic exit/);
  assert.equal(captured.length, 4);
  assert.equal(new Set(captured.map(record => record.queryId)).size, 4);
  assert.ok(captured.every(record => record.resultId === 'checkpoint:1'));
});
