'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveMcpReadiness, McpControlQueue, mcpConfigKey, publicMcpItems } = require('../live-mcp-readiness');

const registry = { docs: { type: 'stdio', command: 'synthetic-mcp', env: { TOKEN: 'fixture-secret' } } };
const connected = (name = 'docs') => ({ name, status: 'connected', tools: [{ name: 'read' }] });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}, options = {}) {
  const calls = { sync: [], status: 0, reconnect: [], toggle: [] };
  const control = {
    async setMcpServers(config) { calls.sync.push(config); return { errors: {} }; },
    async mcpServerStatus() { calls.status += 1; return [connected()]; },
    async reconnectMcpServer(name) { calls.reconnect.push(name); },
    async toggleMcpServer(name, enabled) { calls.toggle.push([name, enabled]); },
    ...overrides,
  };
  return { control, calls, gate: new LiveMcpReadiness(control, { pollIntervalMs: 1, ...options }) };
}

test('send snapshot leaves offline reconnect for a full background preparation', async () => {
  let state = 'failed', reconnects = 0;
  const h = fixture({ mcpServerStatus: async () => [{ name: 'docs', status: state }],
    reconnectMcpServer: async () => { reconnects++; state = 'connected'; } });
  const quick = await h.gate.prepare({ servers: registry, reconnect: false });
  assert.equal(quick.code, 'MCP_NOT_READY'); assert.equal(reconnects, 0);
  const settled = await h.gate.prepare({ servers: registry });
  assert.equal(settled.ok, true); assert.equal(reconnects, 1);
});

test('skipping failed reconnect still disables retired tools before returning', async () => {
  let enabled = true;
  const h = fixture({ mcpServerStatus: async () => [{ name: 'docs', status: enabled ? 'connected' : 'disabled' }],
    toggleMcpServer: async (name, value) => { assert.equal(name, 'docs'); assert.equal(value, false); enabled = value; } },
    { initialServers: registry, initialServersApplied: true });
  const result = await h.gate.prepare({ servers: {}, reconnect: false });
  assert.equal(result.ok, true); assert.equal(enabled, false);
  assert.deepEqual(h.calls.sync, [{}]);
});

test('初始化完成仍须等待实际 pending 状态变为 connected', async () => {
  let reads = 0;
  const { gate } = fixture({ mcpServerStatus: async () => [++reads < 3
    ? { name: 'docs', status: 'pending' } : connected()] });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, true);
  assert.equal(reads, 3);
  assert.deepEqual(result.items, [{ name: 'docs', status: 'connected', toolCount: 1 }]);
});

test('相同配置不随每轮重连，键顺序变化也不重复同步', async () => {
  const { gate, calls } = fixture();
  assert.equal((await gate.prepare({ servers: registry })).synced, true);
  const reordered = { docs: { env: { TOKEN: 'fixture-secret' }, command: 'synthetic-mcp', type: 'stdio' } };
  assert.equal(mcpConfigKey(registry), mcpConfigKey(reordered));
  assert.equal((await gate.prepare({ servers: reordered })).synced, false);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.status, 2);
});

test('failed 只重连一次，并重新读取真实状态', async () => {
  let state = 'failed';
  let reconnects = 0;
  const { gate } = fixture({
    mcpServerStatus: async () => [{ name: 'docs', status: state }],
    reconnectMcpServer: async () => { reconnects += 1; state = 'connected'; },
  });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reconnected, ['docs']);
  assert.equal(reconnects, 1);
});

test('重连响应成功不能替代仍然 failed 的状态，且不无限重试', async () => {
  const { gate, calls } = fixture({ mcpServerStatus: async () => [{ name: 'docs', status: 'failed' }] });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_NOT_READY');
  assert.deepEqual(calls.reconnect, ['docs']);
});

test('缓存过的服务缺失时，最多额外同步一次以修复动态集合', async () => {
  let visible = true;
  let syncs = 0;
  const { gate } = fixture({
    setMcpServers: async () => { syncs += 1; visible = true; return {}; },
    mcpServerStatus: async () => visible ? [connected()] : [],
  });
  await gate.prepare({ servers: registry });
  visible = false;
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, true);
  assert.equal(syncs, 2);
});

test('缺失或 pending 在总期限内结束，不能把从未连接报告为成功', async () => {
  for (const statuses of [[], [{ name: 'docs', status: 'pending' }]]) {
    const { gate, calls } = fixture({ mcpServerStatus: async () => statuses });
    const result = await gate.prepare({ servers: registry, timeoutMs: 25 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(calls.sync.length, 1);
  }
});

test('needs-auth 不自动认证；无关离线 MCP 不使已启用目标失效', async () => {
  const { gate, calls } = fixture({ mcpServerStatus: async () => [
    { name: 'docs', status: 'needs-auth' }, { name: 'plugin-offline', status: 'failed' },
  ] });
  assert.equal((await gate.prepare({ servers: registry })).code, 'MCP_NOT_READY');
  assert.deepEqual(calls.reconnect, []);
  gate.control.mcpServerStatus = async () => [connected(), { name: 'plugin-offline', status: 'failed' }];
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
});

test('删除已托管配置时禁用 settings-owned 副本，再启用会恢复连接', async () => {
  let state = 'connected';
  const { gate, calls } = fixture({
    mcpServerStatus: async () => [{ name: 'docs', status: state }],
    toggleMcpServer: async (name, enabled) => { calls.toggle.push([name, enabled]); state = enabled ? 'connected' : 'disabled'; },
  }, { initialServers: registry });
  await gate.prepare({ servers: registry });
  const removed = await gate.prepare({ servers: {} });
  assert.equal(removed.ok, true);
  assert.equal(removed.items[0].status, 'disabled');
  const enabled = await gate.prepare({ servers: registry });
  assert.equal(enabled.ok, true);
  assert.deepEqual(calls.toggle, [['docs', false], ['docs', true]]);
  assert.deepEqual(calls.sync.map(Object.keys), [['docs'], [], ['docs']]);
});

test('禁用失败返回实际存活状态，不因所需集合为空误报成功', async () => {
  const { gate, calls } = fixture({}, { initialServers: registry });
  const result = await gate.prepare({ servers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_NOT_READY');
  assert.equal(result.items[0].status, 'connected');
  assert.deepEqual(calls.toggle, [['docs', false]]);
});

test('预先取消或同步开始前取消都不发出控制请求', async () => {
  for (const abortFirst of [true, false]) {
    const { gate, calls } = fixture();
    const controller = new AbortController();
    if (abortFirst) controller.abort();
    const pending = gate.prepare({ servers: registry, signal: controller.signal });
    if (!abortFirst) controller.abort();
    assert.equal((await pending).canceled, true);
    assert.equal(calls.sync.length, 0);
    assert.equal(calls.status, 0);
  }
});

test('等待状态时可取消，下一轮仍然可以检查连接', async () => {
  const started = deferred();
  const hung = deferred();
  const { gate } = fixture({ mcpServerStatus: () => { started.resolve(); return hung.promise; } });
  const controller = new AbortController();
  const pending = gate.prepare({ servers: registry, signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal((await pending).canceled, true);
  gate.control.mcpServerStatus = async () => [connected()];
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
  hung.resolve([]);
});

test('同步超时返回 unknown，迟到同步可恢复且不会被竞争替换', async () => {
  const hung = deferred();
  const calls = [];
  const { gate } = fixture({
    setMcpServers: (config) => { calls.push(config); return calls.length === 1 ? hung.promise : Promise.resolve({}); },
    mcpServerStatus: async () => [connected(), connected('next')],
  });
  const first = await gate.prepare({ servers: registry, timeoutMs: 20 });
  assert.equal(first.timedOut, true);
  assert.equal(first.items[0].status, 'unknown');
  const nextRegistry = { ...registry, next: { command: 'next-fixture' } };
  const second = await gate.prepare({ servers: nextRegistry, timeoutMs: 20 });
  assert.equal(second.timedOut, true);
  assert.equal(calls.length, 1);
  hung.resolve({});
  assert.equal((await gate.prepare({ servers: nextRegistry })).ok, true);
  assert.equal(calls.length, 2);
});

test('同步抛错可在下一轮恢复，响应不暴露配置或原始错误', async () => {
  const { gate } = fixture({ setMcpServers: async () => { throw new Error('https://fixture?token=fixture-secret'); } });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.code, 'MCP_SYNC_FAILED');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  gate.control.setMcpServers = async () => ({});
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
});

test('未完成旧 toggle 必须先落稳，新轮才判断相反的启用状态', async () => {
  const started = deferred();
  const oldToggle = deferred();
  let state = 'connected';
  const { gate } = fixture({
    mcpServerStatus: async () => [{ name: 'docs', status: state }],
    toggleMcpServer: async (name, enabled) => {
      if (!enabled) { started.resolve(); await oldToggle.promise; }
      state = enabled ? 'connected' : 'disabled';
    },
  }, { initialServers: registry });
  const controller = new AbortController();
  const first = gate.prepare({ servers: {}, signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal((await first).canceled, true);
  let finished = false;
  const second = gate.prepare({ servers: registry }).then((value) => { finished = true; return value; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  oldToggle.resolve();
  assert.equal((await second).ok, true);
  assert.equal(state, 'connected');
});

test('状态投影仅包含名称、真实连接状态及工具数量', () => {
  const items = publicMcpItems([{ ...connected(), config: registry.docs, error: 'fixture-secret',
    tools: [{ name: 'read', description: 'fixture-secret' }] }], ['missing']);
  assert.deepEqual(items, [
    { name: 'docs', status: 'connected', toolCount: 1 },
    { name: 'missing', status: 'missing', toolCount: null },
  ]);
  assert.equal(JSON.stringify(items).includes('fixture-secret'), false);
});


test('SDK 已应用的初始配置先读真实状态，不重复替换已连接服务', async () => {
  const { gate, calls } = fixture({}, { initialServers: registry, initialServersApplied: true });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, true);
  assert.equal(result.synced, false);
  assert.equal(calls.status, 1);
  assert.deepEqual(calls.sync, []);
});

test('初始配置已应用仍须等 pending，缺失时只补同步一次', async () => {
  let reads = 0;
  const { gate, calls } = fixture({
    mcpServerStatus: async () => {
      reads += 1;
      return reads === 1 ? [] : reads === 2 ? [{ name: 'docs', status: 'pending' }] : [connected()];
    },
  }, { initialServers: registry, initialServersApplied: true });
  const result = await gate.prepare({ servers: registry });
  assert.equal(result.ok, true);
  assert.equal(result.synced, true);
  assert.equal(reads, 3);
  assert.deepEqual(calls.sync, [registry]);
});

test('初始配置已应用不跳过配置变更、停用副本或显式失效', async () => {
  let state = 'connected';
  const { gate, calls } = fixture({
    mcpServerStatus: async () => [{ name: 'docs', status: state }],
    toggleMcpServer: async (name, enabled) => { calls.toggle.push([name, enabled]); state = enabled ? 'connected' : 'disabled'; },
  }, { initialServers: registry, initialServersApplied: true });
  assert.equal((await gate.prepare({ servers: {} })).ok, true);
  assert.deepEqual(calls.sync, [{}]);
  assert.deepEqual(calls.toggle, [['docs', false]]);
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
  gate.invalidate(registry);
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
  assert.deepEqual(calls.sync, [{}, registry, registry]);
});

test('异步构造 Query 可采用初始注册表，显式配置写入后不能覆盖它', async () => {
  const { gate, calls } = fixture();
  assert.equal(gate.adoptInitialServers(registry), true);
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
  assert.equal(calls.sync.length, 0);
  gate.invalidate(registry);
  assert.equal(gate.adoptInitialServers(registry), false);
  assert.equal((await gate.prepare({ servers: registry })).ok, true);
  assert.equal(calls.sync.length, 1);
});

test('慢连接自动重试有冷却，实时恢复会立即清除冷却', async () => {
  let state = 'failed';
  const { gate, calls } = fixture({ mcpServerStatus: async () => [{ name: 'docs', status: state }] },
    { initialServers: registry, initialServersApplied: true });
  assert.equal((await gate.prepare({ servers: registry })).code, 'MCP_NOT_READY');
  assert.deepEqual(calls.reconnect, ['docs']);
  assert.equal((await gate.prepare({ servers: registry })).code, 'MCP_NOT_READY');
  assert.deepEqual(calls.reconnect, ['docs'], '连续发送不能重复等待同一个离线服务重连');
  state = 'connected';
  assert.equal((await gate.prepare({ servers: registry })).ok, true, '冷却期仍查询真实状态');
  state = 'failed';
  assert.equal((await gate.prepare({ servers: registry })).code, 'MCP_NOT_READY');
  assert.deepEqual(calls.reconnect, ['docs', 'docs']);
  gate.invalidate(registry);
  await gate.prepare({ servers: registry });
  assert.deepEqual(calls.reconnect, ['docs', 'docs', 'docs'], '修改配置立即允许重新连接');
});

test('离线服务冷却结束后可以自动重试', async () => {
  const { gate, calls } = fixture({ mcpServerStatus: async () => [{ name: 'docs', status: 'failed' }] },
    { initialServers: registry, initialServersApplied: true, reconnectCooldownMs: 30 });
  await gate.prepare({ servers: registry });
  await new Promise(resolve => setTimeout(resolve, 40));
  await gate.prepare({ servers: registry });
  assert.deepEqual(calls.reconnect, ['docs', 'docs']);
});

function reconnectRace() {
  const queue = new McpControlQueue(), started = deferred(), finish = deferred(), writes = [];
  let current = registry, status = 'failed';
  const control = {
    whenIdle: () => queue.whenIdle(),
    mcpServerStatus: () => queue.read(async () => Object.keys(current).map(name => ({ name, status }))),
    setMcpServers: config => queue.run(async () => { current = config; writes.push(config); return {}; }),
    reconnectMcpServer: () => queue.run(async () => { started.resolve(); await finish.promise; status = 'connected'; }),
    toggleMcpServer: () => queue.run(async () => { throw Error('No retired tools should be restored'); }),
  };
  const gate = new LiveMcpReadiness(control, { initialServers: registry, initialServersApplied: true, pollIntervalMs: 1 });
  return { gate, control, started, finish, writes, names: () => Object.keys(current) };
}

for (const replacement of [{}, { replacement: { type: 'http', url: 'http://fixture.invalid/new' } }]) {
  test(`a settings ${Object.keys(replacement).length ? 'replacement' : 'removal'} during reconnect cannot be undone by its old snapshot`, async () => {
    const h = reconnectRace();
    const old = h.gate.prepare({ servers: registry });
    await h.started.promise;
    h.gate.invalidate(replacement);
    const update = h.control.setMcpServers(replacement);
    h.finish.resolve(); await update;
    const obsolete = await old;
    assert.equal(obsolete.stale, true); assert.equal(obsolete.ok, false);
    assert.equal(obsolete.code, 'MCP_PREPARE_SUPERSEDED');
    assert.deepEqual(h.writes, [replacement]);
    assert.deepEqual(h.names(), Object.keys(replacement), 'old missing-server recovery must not resurrect the removed tool');
    assert.equal((await h.gate.prepare({ servers: replacement, reconnect: false })).ok, true);
  });
}

test('a newer registry preparation supersedes old reconnect work even without an explicit invalidate', async () => {
  const h = reconnectRace(), replacement = { newer: { command: 'newer-fixture' } };
  const old = h.gate.prepare({ servers: registry }); await h.started.promise;
  const next = h.gate.prepare({ servers: replacement, reconnect: false });
  h.finish.resolve();
  assert.equal((await old).stale, true);
  assert.equal((await next).ok, true);
  assert.deepEqual(h.writes, [replacement]);
  assert.deepEqual(h.names(), ['newer']);
});

test('same-registry foreground preparation shares a reconnect without falsely superseding it', async () => {
  const h = reconnectRace();
  const background = h.gate.prepare({ servers: registry }); await h.started.promise;
  const foreground = h.gate.prepare({ servers: JSON.parse(JSON.stringify(registry)), reconnect: false });
  h.finish.resolve();
  assert.equal((await background).ok, true);
  assert.equal((await foreground).ok, true);
  assert.deepEqual(h.writes, []);
});

test('superseded configuration stays stale even if its old SDK status request never returns', async () => {
  const started = deferred(), hung = deferred();
  const { gate } = fixture({ mcpServerStatus: () => { started.resolve(); return hung.promise; } });
  const old = gate.prepare({ servers: registry, timeoutMs: 20 });
  await started.promise;
  gate.invalidate({});
  const result = await old;
  assert.equal(result.stale, true);
  assert.equal(result.code, 'MCP_PREPARE_SUPERSEDED');
  assert.equal(result.timedOut, false);
  hung.resolve([]);
});
