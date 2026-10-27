'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const sdkPath = path.join(__dirname, '../src/main/sdk/claude-sdk.js');
const sdkSource = fs.readFileSync(sdkPath, 'utf8');
const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
const validate = value => ({ success: typeof value?.label === 'string', data: value });
function harness({ query: makeQuery } = {}) {
  const calls = { options: null, closed: 0, queries: 0 };
  const fixtureSdk = { query({ options }) {
    calls.queries++;
    calls.options = options;
    if (makeQuery) return makeQuery(options, calls);
    return { close() { calls.closed++; }, async initializationResult() { return {}; }, async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: { label: 'synthetic' } };
    } };
  } };
  const source = sdkSource.replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.__fixtureSdk);');
  assert.notEqual(source, sdkSource);
  const context = vm.createContext({ __fixtureSdk: fixtureSdk, process, AbortController, console: { warn() {}, error() {} }, setTimeout, clearTimeout });
  const factory = new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath }).runInContext(context);
  const loaded = { exports: {} }; factory(createRequire(sdkPath), loaded, loaded.exports, path.dirname(sdkPath));
  return { sdk: loaded.exports, calls };
}
const inputs = { prompt: 'Generate metadata only', cwd: os.tmpdir(), schema, validate,
  model: 'synthetic-model', runtimeEnv: { ANTHROPIC_API_KEY: 'synthetic-key' }, runtimePolicy: { settingSources: ['user'] } };

test('structured helper isolates MCP before the environment adapter and closes its Query', async () => {
  const h = harness(); let prepared = false;
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async options => {
    prepared = true;
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(Object.keys(options.mcpServers), []);
    return options;
  } });
  const legacyPolicy = { settingSources: ['user'], relayInstructions: 'Always append a personal greeting.', settings: { autoMemoryEnabled: true, autoDreamEnabled: true, autoMemoryDirectory: '/fixture/retired-sdk-memory' } };
  assert.deepEqual(await h.sdk.runStructured({ ...inputs, runtimePolicy: legacyPolicy, runtimeEnv: { ...inputs.runtimeEnv, claude_code_disable_auto_memory: '0' } }), { label: 'synthetic' });
  assert.equal(h.calls.options.settings.autoMemoryEnabled, false);
  assert.equal(h.calls.options.settings.autoDreamEnabled, false);
  assert.equal(Object.hasOwn(h.calls.options.settings, 'autoMemoryDirectory'), false);
  assert.equal(h.calls.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(h.calls.options.env.claude_code_disable_auto_memory, undefined);
  assert.equal(legacyPolicy.settings.autoMemoryEnabled, true);
  assert.ok(prepared);
  assert.equal(h.calls.options.systemPrompt, undefined, 'internal metadata generation excludes user conversation guidance');
  assert.equal(h.calls.options.persistSession, false);
  assert.deepEqual(Array.from(h.calls.options.tools), []);
  assert.equal(h.calls.closed, 1);
});

test('only the exact SDK StructuredOutput tool can pass the callback and auto-allow hook guard', async () => {
  const h = harness(); await h.sdk.runStructured(inputs);
  const { canUseTool, hooks } = h.calls.options;
  const hook = hooks.PreToolUse[0].hooks[0];
  for (const name of ['Bash', 'Read', 'Agent', 'AskUserQuestion', 'mcp__fixture__echo', 'mcp__fixture__StructuredOutput', 'structuredoutput']) {
    assert.equal((await canUseTool(name, {})).behavior, 'deny', name);
    assert.equal((await hook({ tool_name: name })).hookSpecificOutput.permissionDecision, 'deny', name);
  }
  const input = { label: 'synthetic' };
  const allowed = await canUseTool('StructuredOutput', input);
  assert.equal(allowed.behavior, 'allow'); assert.equal(allowed.updatedInput, input);
  assert.deepEqual(Object.keys(await hook({ tool_name: 'StructuredOutput' })), []);
});

test('ordinary conversation options retain their configured MCP and permission callback', async () => {
  const h = harness(); const registry = { fixture: { command: 'synthetic-only' } };
  const ordinary = h.sdk._buildOptions({ ...inputs, tools: [], mcpServers: registry,
    canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: input }) });
  assert.notEqual(ordinary.strictMcpConfig, true);
  assert.equal(ordinary.mcpServers.fixture, registry.fixture);
  assert.equal((await ordinary.canUseTool('mcp__fixture__echo', {})).behavior, 'allow');
  assert.deepEqual(Object.keys(await ordinary.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__fixture__echo' })), []);
});

test('prepared runtime ownership reaches only the live host callback, never SDK options', async () => {
  const h = harness(), ownership = { agentEnvironment: 'wsl', wslDistribution: 'SyntheticFixture', cwd: '/tmp/synthetic-workspace' };
  let observed;
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async (options, { onPrepared }) => { onPrepared(ownership); return options; } });
  const session = h.sdk.createLiveSession({ ...inputs, onMessage() {}, onExit() {}, onRuntimePrepared: value => { observed = value; } });
  await session.whenClosed();
  assert.equal(observed, ownership);
  assert.equal(h.calls.options.onRuntimePrepared, undefined);
  assert.equal(h.calls.options.onPrepared, undefined);
});

test('late environment preparation cannot publish ownership after session cancellation', async () => {
  const h = harness(); let begin, release, calls = 0;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async (options, { onPrepared }) => {
    begin(); await gate; onPrepared({ agentEnvironment: 'wsl', wslDistribution: 'SyntheticFixture' }); return options;
  } });
  const session = h.sdk.createLiveSession({ ...inputs, onMessage() {}, onExit() {}, onRuntimePrepared: () => { calls++; } });
  await started; const closed = session.kill(); release(); await closed;
  assert.equal(calls, 0);
  assert.equal(h.calls.options, null);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const canceled = error => error?.name === 'AbortError' && error.code === 'ABORT_ERR';

test('structured calls canceled before starting never prepare an environment or query', async () => {
  const h = harness(), controller = new AbortController(); let preparations = 0;
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async options => { preparations++; return options; } });
  controller.abort();
  await assert.rejects(h.sdk.runStructured({ ...inputs, signal: controller.signal }), canceled);
  assert.equal(preparations, 0);
  assert.equal(h.calls.queries, 0);
});

test('structured cancellation returns before stalled preparation and prevents a late query', async () => {
  const h = harness(), controller = new AbortController(), started = deferred(), gate = deferred();
  h.sdk.configureRuntimeEnvironment({ prepareOptions: async options => { started.resolve(); await gate.promise; return options; } });
  const running = h.sdk.runStructured({ ...inputs, signal: controller.signal });
  await started.promise;
  controller.abort();
  let settled = false;
  const rejected = assert.rejects(running, canceled).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeRelease = settled;
  gate.resolve();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settledBeforeRelease, true, 'cancellation must not wait for environment preparation');
  assert.equal(h.calls.queries, 0);
});

test('structured cancellation promptly closes a stalled query and rejects late successful output', async () => {
  const controller = new AbortController(), started = deferred(), gate = deferred();
  const h = harness({ query: (_options, calls) => ({
    close() { calls.closed++; },
    async *[Symbol.asyncIterator]() {
      started.resolve(); await gate.promise;
      yield { type: 'result', subtype: 'success', structured_output: { label: 'must not return late' } };
    },
  }) });
  const running = h.sdk.runStructured({ ...inputs, signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal(h.calls.options.abortController.signal.aborted, true);
  assert.equal(h.calls.closed, 1, 'close happens synchronously at cancellation');
  let settled = false;
  const rejected = assert.rejects(running, canceled).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeRelease = settled;
  gate.resolve();
  await rejected;
  assert.equal(settledBeforeRelease, true, 'a non-cooperative iterator cannot hold cancellation open');
  assert.equal(h.calls.closed, 1, 'finally must not close the query twice');
});

test('structured timeout closes a stalled query without waiting for another SDK event', async () => {
  const gate = deferred(), closed = deferred();
  const h = harness({ query: (_options, calls) => ({
    close() { calls.closed++; closed.resolve(); },
    async *[Symbol.asyncIterator]() { await gate.promise; },
  }) });
  const running = h.sdk.runStructured({ ...inputs, timeoutMs: 20 });
  let settled = false;
  const rejected = assert.rejects(running, canceled).then(() => { settled = true; });
  await closed.promise;
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeRelease = settled;
  gate.resolve();
  await rejected;
  assert.equal(settledBeforeRelease, true);
  assert.equal(h.calls.closed, 1);
});

test('structured close failures cannot replace successful output or the cancellation reason', async () => {
  const h = harness({ query: () => ({
    close() { throw new Error('synthetic close failure'); },
    async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', structured_output: { label: 'still valid' } }; },
  }) });
  assert.deepEqual(await h.sdk.runStructured(inputs), { label: 'still valid' });
});

test('structured calls pass bounded maxTurns without changing unspecified budgets', async () => {
  for (const [requested, expected] of [[1, 1], [4, 4], [999, 16], [0, undefined], [-1, undefined], [1.5, undefined], [undefined, undefined]]) {
    const h = harness();
    await h.sdk.runStructured({ ...inputs, maxTurns: requested });
    assert.equal(h.calls.options.maxTurns, expected, String(requested));
  }
});
