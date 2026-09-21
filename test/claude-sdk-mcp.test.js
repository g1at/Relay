'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real SDK adapter with only an in-memory Query. No model, child
// process, MCP transport, real registry, or user credential is touched.
const sdkPath = path.join(__dirname, '..', 'claude-sdk.js');
const sdkSource = fs.readFileSync(sdkPath, 'utf8');
const registry = { docs: { type: 'stdio', command: 'fixture-only' } };
const clone = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
function harness(overrides = {}) {
  const created = deferred();
  const received = deferred();
  const calls = { options: null, inputs: [], sync: [], reconnect: [], toggle: [], statuses: 0, factories: 0 };
  let currentStatus = [{ name: 'docs', status: 'connected', tools: [{ name: 'read' }] }];
  const fixtureSdk = {
    query({ prompt, options }) {
      calls.options = options;
      const query = {
        async initializationResult() { return {}; },
        async setMcpServers(servers) { calls.sync.push(servers); return {}; },
        async mcpServerStatus() { calls.statuses += 1; return currentStatus; },
        async reconnectMcpServer(name) { calls.reconnect.push(name); },
        async toggleMcpServer(name, enabled) {
          calls.toggle.push([name, enabled]);
          currentStatus = currentStatus.map((item) => item.name === name
            ? { ...item, status: enabled ? 'connected' : 'disabled' } : item);
        },
        close() {},
        ...overrides,
        async *[Symbol.asyncIterator]() {
          for await (const input of prompt) {
            calls.inputs.push(input);
            received.resolve(input);
            if (typeof overrides.beforeResult === 'function') await overrides.beforeResult(input);
            yield { type: 'result', subtype: 'success', is_error: false, result: 'synthetic answer',
              user_message_uuid: input.uuid, queued_turn_count: 0 };
          }
        },
      };
      created.resolve(query);
      return query;
    },
  };
  const source = sdkSource.replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.__fixtureSdk);');
  assert.notEqual(source, sdkSource, 'inject only the SDK import; keep all adapter functions real');
  const context = vm.createContext({
    __fixtureSdk: fixtureSdk, process, AbortController, console: { warn() {}, error() {} },
    setTimeout, clearTimeout,
  });
  const factory = new vm.Script(`(function(require, module, exports, __dirname) {\n${source}\n})`, { filename: sdkPath })
    .runInContext(context);
  const loaded = { exports: {} };
  factory(createRequire(sdkPath), loaded, loaded.exports, path.dirname(sdkPath));
  return {
    sdk: loaded.exports, calls, created: created.promise, received: received.promise,
    setStatuses(statuses) { currentStatus = statuses; },
    factory() {
      calls.factories += 1;
      return { 'relay-cron': { type: 'sdk', name: 'relay-cron', instance: { synthetic: true } },
        'factory-external': { type: 'stdio', command: 'fixture-factory' } };
    },
  };
}

test('backgroundTasks forwards the exact tool ID and preserves the native boolean result', async () => {
  const ids = [], h = harness({ backgroundTasks: async id => { ids.push(id); return id === 'active'; } });
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  await session.whenReady({ timeoutMs: 2000 });
  assert.equal(await session.backgroundTasks('active'), true);
  assert.equal(await session.backgroundTasks('missing'), false);
  assert.deepEqual(ids, ['active', 'missing']);
  await session.kill();
});

test('a pending background control never serializes or blocks interrupt and targeted stop', async () => {
  const gate = deferred(), calls = [];
  const h = harness({ backgroundTasks: () => gate.promise,
    interrupt: async () => { calls.push('interrupt'); return {}; },
    stopTask: async taskId => { calls.push(taskId); } });
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  await session.whenReady({ timeoutMs: 2000 });
  const background = session.backgroundTasks('active');
  let timer;
  try {
    await Promise.race([Promise.all([session.stopTask('native-task'), session.interrupt()]),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('stop blocked behind background request')), 1000); })]);
    assert.deepEqual(calls.sort(), ['interrupt', 'native-task']);
  } finally { clearTimeout(timer); gate.resolve(false); await background; await session.kill(); }
});

test('常驻历史 Query 在 MCP 准备前不投递，保留 resume、UUID 与内置 SDK server', async () => {
  const ready = deferred();
  const checked = deferred();
  const h = harness({ mcpServerStatus: async () => { checked.resolve(); return ready.promise; } });
  const session = h.sdk.createLiveSession({ sessionId: 'synthetic-history', mcpServers: registry,
    mcpServersFactory: h.factory, onMessage() {}, onExit() {} });
  const preparation = session.prepareMcp({ servers: registry });
  await checked.promise;
  assert.equal(h.calls.options.resume, 'synthetic-history');
  assert.equal(h.calls.inputs.length, 0);
  ready.resolve([{ name: 'docs', status: 'connected', tools: [{ name: 'read' }] }]);
  assert.equal((await preparation).ok, true);
  assert.equal(session.push('synthetic user message', { uuid: 'synthetic-job-id' }), true);
  assert.equal((await h.received).uuid, 'synthetic-job-id');
  assert.equal(h.calls.factories, 1);
  assert.deepEqual(Object.keys(h.calls.sync[0]).sort(), ['docs', 'relay-cron']);
  assert.equal(h.calls.sync[0]['relay-cron'], h.calls.options.mcpServers['relay-cron']);
  await session.kill();
});

test('常驻公开 interrupt 保留 Query，并在明确的下一次 push 时按新 UUID 续接', async () => {
  let interrupts = 0;
  const receipt = { still_queued: [] };
  const h = harness({ async interrupt(...args) { interrupts++; assert.deepEqual(clone(args), [{ cancelQueued: true }]); return receipt; } });
  const events = [];
  const session = h.sdk.createLiveSession({ sessionId: 'fixture-context', onMessage: event => events.push(event), onExit() {} });
  session.push('first fixture', { uuid: 'first-fixture-id' });
  await h.received;
  assert.equal(await session.interrupt(), receipt);
  assert.equal(interrupts, 1);
  assert.equal(h.calls.inputs.length, 1, 'interrupt does not resubmit or create another input');
  assert.equal(session.push('supplement fixture', { uuid: 'second-fixture-id' }), true);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.inputs.map(input => input.uuid), ['first-fixture-id', 'second-fixture-id']);
  assert.equal(events.at(-1).user_message_uuid, 'second-fixture-id');
  assert.equal(h.calls.options.resume, 'fixture-context');
  await session.kill();
});

test('常驻补充使用公开 next 优先级，等待安全消费且不会中断当前输出', async () => {
  const firstResult = deferred();
  let interrupts = 0;
  const h = harness({
    async interrupt() { interrupts++; },
    beforeResult: input => input.uuid === 'original-job' ? firstResult.promise : undefined,
  });
  const events = [];
  const session = h.sdk.createLiveSession({ onMessage: event => events.push(event), onExit() {} });
  session.push('original fixture', { uuid: 'original-job' });
  await h.received;
  assert.equal(session.push('additional requirement', { uuid: 'supplement-id', priority: 'next' }), true);
  assert.equal(events.length, 0, 'the current result is still in progress');
  assert.equal(interrupts, 0);
  firstResult.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.inputs.map(input => [input.uuid, input.priority]), [
    ['original-job', undefined], ['supplement-id', 'next'],
  ]);
  assert.equal(h.calls.options.extraArgs['replay-user-messages'], null);
  assert.deepEqual(events.map(event => event.user_message_uuid), ['original-job', 'supplement-id']);
  assert.equal(interrupts, 0);
  await session.kill();
});

test('输入 priority 仅透传 SDK 声明的三个值，无效 metadata 不扩展输入协议', async () => {
  const h = harness();
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  for (const priority of ['now', 'next', 'later', 'invalid-fixture']) {
    session.push('fixture', { uuid: priority, priority, shouldQuery: false });
  }
  await h.received; await new Promise(setImmediate);
  assert.deepEqual(h.calls.inputs.map(input => input.priority), ['now', 'next', 'later', undefined]);
  assert.ok(h.calls.inputs.every(input => !Object.hasOwn(input, 'shouldQuery')));
  await session.kill();
});

test('回收尚未消费的常驻输入时，迟到初始化不能将已停止输入送出', async () => {
  const h = harness();
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  assert.equal(session.push('never send after close', { uuid: 'stopped-fixture-id' }), true);
  const closed = session.kill();
  assert.equal(session.push('late fixture', { uuid: 'late-fixture-id' }), false);
  await closed;
  assert.deepEqual(h.calls.inputs, []);
});

test('环境预检在三条 SDK 启动路径统一应用且不会覆盖服务商环境', async () => {
  for (const kind of ['live', 'one-shot', 'text']) {
    const h = harness(); const prepared = [];
    h.sdk.configureRuntimeEnvironment({ async prepareOptions(options, context) {
      prepared.push({ options, context });
      return { ...options, cwd: '/synthetic/prepared-workspace' };
    } });
    const params = { cwd: '/synthetic/original-workspace', tools: [], runtimeEnv: { ANTHROPIC_BASE_URL: 'https://synthetic.invalid', ANTHROPIC_API_KEY: 'synthetic-key' } };
    if (kind === 'live') {
      const session = h.sdk.createLiveSession({ ...params, onMessage() {}, onExit() {} });
      session.push('fixture', { uuid: 'prepared-fixture' }); await h.received; await session.kill();
    } else if (kind === 'one-shot') {
      await h.sdk.runOneShot({ ...params, prompt: 'fixture', onEvent() {} }).handle.whenClosed();
    } else await h.sdk.runText({ ...params, prompt: 'fixture' });
    assert.equal(prepared.length, 1); assert.equal(h.calls.options.cwd, '/synthetic/prepared-workspace');
    assert.equal(h.calls.options.env.ANTHROPIC_API_KEY, 'synthetic-key');
    assert.equal(h.calls.options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
    assert.equal(typeof prepared[0].context.onSpawn, kind === 'text' ? 'undefined' : 'function');
  }
});

test('预检期间取消会话不因迟到环境结果启动 Query', async () => {
  const h = harness(), ready = deferred(), entered = deferred();
  h.sdk.configureRuntimeEnvironment({ async prepareOptions(options) { entered.resolve(); await ready.promise; return options; } });
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  session.push('never sent', { uuid: 'canceled-preparation' }); await entered.promise;
  const closed = session.kill(); ready.resolve(); await closed;
  assert.equal(h.calls.options, null); assert.equal(h.calls.inputs.length, 0);
});

test('上下文默认使用新版 SDK summary 并允许明确请求完整详情', async () => {
  const requests = [], h = harness({ async getContextUsage(options) { requests.push(options); return { total_tokens: 42 }; } });
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit() {} });
  assert.deepEqual(await session.getContextUsage(), { total_tokens: 42 });
  await session.getContextUsage({ detail: 'full' });
  assert.deepEqual(clone(requests), [{ detail: 'summary' }, { detail: 'full' }]);
  await session.kill();
});

test('MCP 后续同步沿用会话启动环境，偏好切换不把 Windows 命令注入已启动的 WSL', async () => {
  const h = harness(), environments = [];
  h.sdk.configureRuntimeEnvironment({
    async prepareOptions(options) { return { ...options, env: { ...options.env, RELAY_AGENT_ENVIRONMENT: 'wsl' } }; },
    async prepareMcpServers(servers, { environment }) {
      environments.push(environment);
      return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.type === 'sdk' ? server : { ...server, command: 'mapped-' + server.command }]));
    },
  });
  const session = h.sdk.createLiveSession({ mcpServersFactory: h.factory, onMessage() {}, onExit() {} });
  await h.created;
  h.sdk.configureRuntimeEnvironment({ async prepareOptions(options) { return options; }, async prepareMcpServers() { throw Error('must not use changed preference'); } });
  await session.setMcpServers(registry);
  assert.deepEqual(environments, ['wsl']); assert.equal(h.calls.sync[0].docs.command, 'mapped-fixture-only');
  assert.equal(h.calls.sync[0]['relay-cron'].type, 'sdk'); await session.kill();
});

test('一次性 MCP 就绪控制重新同步时仍通过已准备环境的转换器', async () => {
  const h = harness(), environments = [];
  h.sdk.configureRuntimeEnvironment({ async prepareOptions(options) { return { ...options, env: { ...options.env, RELAY_AGENT_ENVIRONMENT: 'wsl' } }; },
    async prepareMcpServers(servers, { environment }) { environments.push(environment); return { ...servers, docs: { ...servers.docs, command: 'mapped-fixture-only' } }; },
  });
  await h.sdk.runOneShot({ prompt: 'fixture', mcpServers: registry, onEvent() {} }).handle.whenClosed();
  assert.deepEqual(environments, ['wsl']); assert.equal(h.calls.sync[0].docs.command, 'mapped-fixture-only');
});

test('MCP 重载固定原始配置目录，不使用转换后的路径或后续偏好', async () => {
  for (const kind of ['live', 'one-shot']) {
    const h = harness(), contexts = [];
    const originalDirectory = 'D:\\Synthetic Relay\\isolated-config';
    let sourceOptions;
    h.sdk.configureRuntimeEnvironment({
      async prepareOptions(options) {
        sourceOptions = options;
        // Exercise an adapter that mutates its input while preparing Linux paths.
        options.env.CLAUDE_CONFIG_DIR = '/mnt/d/Synthetic Relay/isolated-config';
        return { ...options, env: { ...options.env, RELAY_AGENT_ENVIRONMENT: 'wsl' } };
      },
      async prepareMcpServers(servers, context) { contexts.push({ environment: context.environment, resourceDir: context.resourceDir }); assert.ok(context.prepared); return servers; },
    });
    const params = { runtimeEnv: { CLAUDE_CONFIG_DIR: originalDirectory }, mcpServers: registry };
    if (kind === 'live') {
      const session = h.sdk.createLiveSession({ ...params, onMessage() {}, onExit() {} });
      await h.created;
      sourceOptions.env.CLAUDE_CONFIG_DIR = 'C:\\Synthetic\\different-profile';
      await session.setMcpServers(registry);
      await session.kill();
    } else await h.sdk.runOneShot({ ...params, prompt: 'fixture', onEvent() {} }).handle.whenClosed();
    assert.deepEqual(contexts, [{ environment: 'wsl', resourceDir: originalDirectory }]);
  }
});

test('一次性暂停的 whenClosed 仅在终态转发后完成，并保留 aborted 语义', async () => {
  const ready = deferred(), checked = deferred();
  const h = harness({ mcpServerStatus: async () => { checked.resolve(); return ready.promise; } });
  const events = [];
  const { handle } = h.sdk.runOneShot({ prompt: 'one-shot pause fixture', mcpServers: registry,
    onEvent: event => events.push(event) });
  await checked.promise;
  const closed = handle.kill();
  assert.equal(closed, handle.whenClosed());
  await closed;
  assert.equal(events.at(-1).type, 'job-done');
  assert.equal(events.at(-1).aborted, true);
  assert.equal(events.at(-1).exitCode, -1);
  assert.deepEqual(h.calls.inputs, []);
  ready.resolve([{ name: 'docs', status: 'connected' }]);
});

test('运行中移除用户 MCP 不会由初始 base 补回，并禁用 settings 副本', async () => {
  const h = harness();
  const session = h.sdk.createLiveSession({ mcpServers: registry, mcpServersFactory: h.factory,
    onMessage() {}, onExit() {} });
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  assert.equal((await session.prepareMcp({ servers: {} })).ok, true);
  assert.deepEqual(Object.keys(h.calls.sync[1]), ['relay-cron']);
  assert.deepEqual(h.calls.toggle, [['docs', false]]);
  await session.setMcpServers({});
  assert.deepEqual(Object.keys(h.calls.sync[2]), ['relay-cron']);
  await session.kill();
});

test('常驻初始化尚未完成时回收，不在迟到初始化后执行 MCP 同步', async () => {
  const initial = deferred();
  const began = deferred();
  const h = harness({ initializationResult: async () => { began.resolve(); return initial.promise; } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  const preparation = session.prepareMcp({ servers: registry });
  await began.promise;
  const closed = session.kill();
  assert.equal((await preparation).canceled, true);
  initial.resolve({});
  await closed;
  await new Promise(setImmediate);
  assert.equal(h.calls.sync.length, 0);
  assert.equal(h.calls.inputs.length, 0);
});

test('用户配置与工厂 SDK server 同名时，移除用户项也保留工厂实例', async () => {
  const h = harness();
  const collidingRegistry = { 'relay-cron': { command: 'fixture-collision' } };
  h.setStatuses([{ name: 'relay-cron', status: 'connected', tools: [] }]);
  const session = h.sdk.createLiveSession({ mcpServers: collidingRegistry, mcpServersFactory: h.factory,
    onMessage() {}, onExit() {} });
  assert.equal((await session.prepareMcp({ servers: {} })).ok, true);
  assert.equal(h.calls.sync[0]['relay-cron'].type, 'sdk');
  assert.deepEqual(h.calls.toggle, []);
  await session.kill();
});

test('一次性历史 fallback 等实际 MCP 状态后才发送第一条输入', async () => {
  const ready = deferred();
  const checked = deferred();
  const done = deferred();
  const events = [];
  const h = harness({ mcpServerStatus: async () => { checked.resolve(); return ready.promise; } });
  h.sdk.runOneShot({ prompt: 'synthetic fallback', userMessageId: 'fallback-job', sessionId: 'synthetic-resume',
    mcpServers: registry, mcpServersFactory: h.factory,
    onEvent: (event) => { events.push(event); if (event.type === 'job-done') done.resolve(event); } });
  await checked.promise;
  assert.equal(h.calls.inputs.length, 0);
  assert.equal(h.calls.options.resume, 'synthetic-resume');
  ready.resolve([{ name: 'docs', status: 'connected', tools: [] }]);
  assert.equal((await done.promise).exitCode, 0);
  assert.equal(h.calls.inputs[0].uuid, 'fallback-job');
  assert.equal(h.calls.inputs[0].message.content[0].text, 'synthetic fallback');
  const statusIndex = events.findIndex((event) => event.subtype === 'relay_mcp_status' && event.phase === 'settled');
  assert.equal(events[statusIndex].ok, true);
  assert.ok(statusIndex < events.findIndex((event) => event.type === 'result'));
  assert.deepEqual(Object.keys(h.calls.sync[0]).sort(), ['docs', 'relay-cron']);
});

test('一次性准备时中止不会迟到投递用户输入', async () => {
  const ready = deferred();
  const checked = deferred();
  const done = deferred();
  const h = harness({ mcpServerStatus: async () => { checked.resolve(); return ready.promise; } });
  const { handle } = h.sdk.runOneShot({ prompt: 'must not send', mcpServers: registry,
    onEvent: (event) => { if (event.type === 'job-done') done.resolve(event); } });
  await checked.promise;
  handle.kill();
  assert.equal((await done.promise).exitCode, -1);
  ready.resolve([{ name: 'docs', status: 'connected' }]);
  await new Promise(setImmediate);
  assert.equal(h.calls.inputs.length, 0);
});

test('MCP 失败仍发送普通对话，过程只暴露准确状态及数量', async () => {
  const done = deferred();
  const events = [];
  const h = harness({ mcpServerStatus: async () => [{ name: 'docs', status: 'failed',
    config: { env: { TOKEN: 'synthetic-private' } }, error: 'synthetic-private' }] });
  h.sdk.runOneShot({ prompt: 'ordinary question', mcpServers: registry,
    onEvent: (event) => { events.push(event); if (event.type === 'job-done') done.resolve(event); } });
  assert.equal((await done.promise).exitCode, 0);
  assert.equal(h.calls.inputs.length, 1);
  assert.deepEqual(h.calls.reconnect, ['docs']);
  const status = events.find((event) => event.phase === 'settled');
  assert.equal(status.ok, false);
  assert.deepEqual(clone(status.items), [{ name: 'docs', status: 'failed', toolCount: null }]);
  assert.equal(JSON.stringify(status).includes('synthetic-private'), false);
});

test('tools: [] 的一次性纯文本调用跳过 MCP 就绪控制', async () => {
  const done = deferred();
  const h = harness({ initializationResult: async () => { throw new Error('must not inspect MCP'); } });
  h.sdk.runOneShot({ prompt: 'text only', tools: [], mcpServers: registry,
    onEvent: (event) => { if (event.type === 'job-done') done.resolve(event); } });
  assert.equal((await done.promise).exitCode, 0);
  assert.deepEqual(clone(h.calls.options.tools), []);
  assert.equal(h.calls.sync.length, 0);
  assert.equal(h.calls.statuses, 0);
});

test('手动 setMcpServers 未完成时，发送前准备不能并行同步或提前 ready', async () => {
  const started = deferred();
  const release = deferred();
  let syncs = 0;
  const h = harness({ setMcpServers: async () => {
    if (++syncs === 1) { started.resolve(); await release.promise; }
    return { added: ['docs'], removed: [], errors: {} };
  } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  const manual = session.setMcpServers({ older: { command: 'old-fixture' } });
  await started.promise;
  let prepared = false;
  const pending = session.prepareMcp({ servers: registry }).then((result) => { prepared = true; return result; });
  await new Promise(setImmediate);
  assert.equal(prepared, false);
  assert.equal(syncs, 1);
  assert.equal(h.calls.statuses, 0);
  release.resolve();
  assert.deepEqual(await manual, { added: ['docs'], removed: [], errors: {} });
  assert.equal((await pending).ok, true);
  assert.equal(syncs, 2);
  await session.kill();
});

test('缓存配置也必须等待公开 reconnect 落稳，不能凭旧 connected 提前完成', async () => {
  const started = deferred();
  const release = deferred();
  const h = harness({ reconnectMcpServer: async () => { started.resolve(); await release.promise; } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  await session.prepareMcp({ servers: registry });
  const previousReads = h.calls.statuses;
  const manual = session.reconnectMcpServer('docs');
  await started.promise;
  let prepared = false;
  const pending = session.prepareMcp({ servers: registry }).then((result) => { prepared = true; return result; });
  await new Promise(setImmediate);
  assert.equal(prepared, false);
  assert.equal(h.calls.statuses, previousReads);
  release.resolve();
  await manual;
  assert.equal((await pending).ok, true);
  assert.equal(h.calls.sync.length, 0, 'Query 已提供同一注册表，不重复同步');
  await session.kill();
});

test('公开 toggle 停用落稳后才判断新启用配置，最终状态不被迟到停用覆盖', async () => {
  const started = deferred();
  const release = deferred();
  const toggles = [];
  const h = harness({ toggleMcpServer: async (name, enabled) => {
    toggles.push([name, enabled]);
    if (!enabled) { started.resolve(); await release.promise; }
    h.setStatuses([{ name, status: enabled ? 'connected' : 'disabled' }]);
  } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  await session.prepareMcp({ servers: registry });
  const manual = session.toggleMcpServer('docs', false);
  await started.promise;
  let prepared = false;
  const pending = session.prepareMcp({ servers: registry }).then((result) => { prepared = true; return result; });
  await new Promise(setImmediate);
  assert.equal(prepared, false);
  release.resolve();
  await manual;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.items[0].status, 'connected');
  assert.deepEqual(toggles, [['docs', false], ['docs', true]]);
  await session.kill();
});

test('公开控制挂起使准备有限超时，迟到失败不会毒化后续控制序列', async () => {
  const started = deferred();
  const release = deferred();
  let syncs = 0;
  const h = harness({ setMcpServers: async () => {
    if (++syncs === 1) {
      started.resolve();
      await release.promise;
      throw new Error('synthetic-control-error');
    }
    return {};
  } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  const manualFailure = session.setMcpServers(registry).then(() => null, (error) => error.message);
  await started.promise;
  const timedOut = await session.prepareMcp({ servers: registry, timeoutMs: 20 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(syncs, 1, '超时期间不能在旧控制后继续堆积新配置写入');
  release.resolve();
  assert.equal(await manualFailure, 'synthetic-control-error');
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  assert.equal(syncs, 2);
  await session.kill();
});

for (const firstRead of ['canceled-prepare', 'timed-out-prepare', 'public-status']) {
  test(`只读状态请求挂起后仍可在下一轮恢复（${firstRead}）`, async () => {
    const started = deferred();
    const stuckRead = deferred();
    let reads = 0;
    const h = harness({ mcpServerStatus: async () => {
      if (++reads === 1) { started.resolve(); return stuckRead.promise; }
      return [{ name: 'docs', status: 'connected', tools: [] }];
    } });
    const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
    const controller = new AbortController();
    const first = firstRead === 'public-status' ? session.mcpServerStatus()
      : session.prepareMcp({ servers: registry, timeoutMs: 20, signal: controller.signal });
    await started.promise;
    if (firstRead === 'canceled-prepare') {
      controller.abort();
      assert.equal((await first).canceled, true);
    } else if (firstRead === 'timed-out-prepare') {
      assert.equal((await first).timedOut, true);
    }
    const recovered = await session.prepareMcp({ servers: registry, timeoutMs: 100 });
    assert.equal(recovered.ok, true, '首个只读请求未返回，也应能重新查询真实状态');
    assert.equal(reads, 2);
    assert.equal(h.calls.sync.length, 0, '初始配置不因旧读取超时重复写入');
    stuckRead.resolve([{ name: 'docs', status: 'failed' }]);
    await first;
    await session.kill();
  });
}


test('冷启动沿用 Query 配置，热启动仍查询状态，初始化只等待一次', async () => {
  let initialized = 0;
  const h = harness({ initializationResult: async () => { initialized++; return {}; } });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  await session.whenReady();
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  await session.whenReady();
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  assert.equal(initialized, 1);
  assert.equal(h.calls.statuses, 2);
  assert.equal(h.calls.sync.length, 0);
  assert.equal(h.calls.options.mcpServers.docs.command, 'fixture-only');
  await session.kill();
});

test('初始配置优化不会保留复用注册表对象的新工厂别名', async () => {
  const h = harness();
  const session = h.sdk.createLiveSession({ mcpServers: registry,
    mcpServersFactory: () => ({ alias: registry.docs }), onMessage() {}, onExit() {} });
  await session.whenReady();
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  assert.deepEqual(Object.keys(h.calls.options.mcpServers), ['docs', 'alias']);
  assert.equal(h.calls.sync.length, 1, '工厂新增的外部别名仍须按注册表移除');
  assert.deepEqual(Object.keys(h.calls.sync[0]), ['docs']);
  await session.kill();
});

test('初始化超时可以取消等待；迟到初始化仍按相同 Query 完成', async () => {
  const initialized = deferred();
  const h = harness({ initializationResult: () => initialized.promise });
  const session = h.sdk.createLiveSession({ mcpServers: registry, onMessage() {}, onExit() {} });
  await assert.rejects(session.whenReady({ timeoutMs: 20 }), error => error.code === 'SESSION_START_TIMEOUT');
  assert.equal(h.calls.statuses, 0);
  initialized.resolve({});
  await session.whenReady();
  assert.equal((await session.prepareMcp({ servers: registry })).ok, true);
  assert.equal(h.calls.sync.length, 0);
  await session.kill();
});


test('one-shot and live SDK launches share output instructions and scratch defaults without changing permission mode', async () => {
  const cwd = path.resolve('Synthetic Project'), scratchDir = path.resolve('Synthetic Relay Data', 'conversation-scratch', 'session');
  for (const kind of ['live', 'one-shot']) {
    const h = harness(), params = { cwd, validWorkingDir: cwd, scratchDir, permissionMode: 'default',
      runtimeEnv: { CLAUDE_CODE_TMPDIR: path.resolve('Synthetic SDK Data', 'tmp') },
      appendSystemPrompt: 'Preserve existing instruction.',
      nativeAgent: { agent: 'writer', agents: { writer: { description: 'fixture', prompt: 'Original Agent instruction.' } } } };
    const before = JSON.stringify(params);
    if (kind === 'live') { const session = h.sdk.createLiveSession({ ...params, onMessage() {}, onExit() {} }); await h.created; await session.kill(); }
    else await h.sdk.runOneShot({ ...params, prompt: 'fixture', onEvent() {} }).handle.whenClosed();
    const options = h.calls.options;
    assert.equal(options.cwd, cwd); assert.equal(options.permissionMode, 'default');
    assert.ok(options.additionalDirectories.includes(scratchDir));
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'RELAY_SCRATCH_DIR']) assert.equal(options.env[key], scratchDir);
    assert.equal(options.env.CLAUDE_CODE_TMPDIR, params.runtimeEnv.CLAUDE_CODE_TMPDIR);
    assert.match(options.systemPrompt.append, /Preserve existing instruction/);
    assert.match(options.systemPrompt.append, /最终回答用本地 Markdown 链接/);
    assert.ok(options.systemPrompt.append.includes(JSON.stringify(scratchDir)));
    assert.match(options.agents.writer.prompt, /Original Agent instruction/);
    assert.ok(options.agents.writer.prompt.includes(JSON.stringify(scratchDir)));
    assert.equal(JSON.stringify(params), before, 'provider and Agent snapshots remain immutable');
  }
});

test('one-shot and live runtime preparation map file hook locations before a WSL query starts', async () => {
  const cwd = 'D:\\Cybersecurity\\项目', scratchDir = 'C:\\Relay Data\\scratch\\session';
  const runtimeCwd = '/mnt/d/Cybersecurity/项目', runtimeScratch = '/mnt/c/Relay Data/scratch/session';
  for (const kind of ['one-shot', 'live']) {
    const h = harness();
    h.sdk.configureRuntimeEnvironment({ prepareOptions: async options => ({ ...options,
      cwd: runtimeCwd, env: { ...options.env, RELAY_SCRATCH_DIR: runtimeScratch, RELAY_AGENT_ENVIRONMENT: 'wsl' } }) });
    let session;
    if (kind === 'live') {
      session = h.sdk.createLiveSession({ cwd, scratchDir, onMessage() {}, onExit() {} });
      await h.created;
    } else await h.sdk.runOneShot({ cwd, scratchDir, prompt: 'fixture', onEvent() {} }).handle.whenClosed();
    const hooks = h.calls.options.hooks;
    const submitted = await hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'Continue', cwd: '/home/tester' });
    assert.ok(submitted.hookSpecificOutput.additionalContext.includes(JSON.stringify(runtimeCwd)));
    assert.ok(submitted.hookSpecificOutput.additionalContext.includes(JSON.stringify(runtimeScratch)));
    assert.equal(submitted.hookSpecificOutput.additionalContext.includes(JSON.stringify(cwd)), false);
    const updates = [];
    for (const group of hooks.PreToolUse) for (const hook of group.hooks) {
      const result = await hook({ hook_event_name: 'PreToolUse', cwd: '/home/tester', tool_name: 'Agent', tool_input: { prompt: 'Write report', name: 'writer' } });
      if (result.hookSpecificOutput?.updatedInput) updates.push(result.hookSpecificOutput.updatedInput);
    }
    assert.equal(updates.length, 1); assert.equal(updates[0].name, 'writer');
    assert.ok(updates[0].prompt.includes(JSON.stringify(runtimeCwd)));
    assert.equal(updates[0].prompt.includes(JSON.stringify(cwd)), false);
    const completed = await hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', cwd: '/home/tester', last_assistant_message: '[报告](./report.md)' });
    assert.deepEqual(clone(completed), {});
    if (session) await session.kill();
  }
});
test('explicit managed runtime paths replace case variants inherited from the host only when configured', () => {
  const sdk = require('../claude-sdk');
  const names = ['CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'XDG_CACHE_HOME', 'TMPDIR', 'TEMP', 'TMP', 'RELAY_SCRATCH_DIR'];
  const before = Object.fromEntries(Object.entries(process.env).filter(([key]) => names.includes(key.toUpperCase())));
  try {
    for (const key of Object.keys(process.env)) if (names.includes(key.toUpperCase())) delete process.env[key];
    for (const name of names) process.env[name.toLowerCase()] = 'synthetic-host-path';
    const configured = Object.fromEntries(names.map(name => [name, 'synthetic-owned-' + name]));
    const env = sdk.buildRelayRuntimeEnv(configured);
    for (const name of names) {
      assert.equal(env[name], configured[name]);
      assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === name), [name]);
    }
    assert.equal(Object.entries(sdk.buildRelayRuntimeEnv()).find(([key]) => key.toUpperCase() === 'TMPDIR')[1], 'synthetic-host-path');
  } finally {
    for (const key of Object.keys(process.env)) if (names.includes(key.toUpperCase())) delete process.env[key];
    Object.assign(process.env, before);
  }
});
