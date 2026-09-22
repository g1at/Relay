'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { HostStdioMcpServer, bridgeMcpServers, createRuntimeMcpMapper } = require('../src/main/sdk/host-stdio-mcp');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('routing-only startup stays lightweight and the first local bridge keeps real SDK identity', () => {
  // A fresh process is essential: other protocol tests intentionally load the
  // exported class, which must remain a genuine SDK McpServer subclass.
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    (async () => {
      const bridge = require('./src/main/sdk/host-stdio-mcp');
      require('./src/main/sdk/agent-environment');
      require('./src/main/sdk/claude-sdk');
      const serverEntry = require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
      const transportEntry = require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
      const remote = { type:'http', url:'https://example.invalid' };
      let unrelatedCloses = 0;
      const builtIn = { type:'sdk', instance:{ close:async () => { unrelatedCloses++; } } };
      const initial = bridge.bridgeMcpServers({ remote, builtIn });
      const mapper = bridge.createRuntimeMcpMapper(initial, value => bridge.bridgeMcpServers(value));
      await mapper.applyServers(async () => {}, { remote, builtIn });
      await mapper.close();
      assert.equal(require.cache[serverEntry], undefined);
      assert.equal(require.cache[transportEntry], undefined);
      assert.equal(unrelatedCloses, 0);
      let applied;
      await mapper.applyServers(async value => { applied = value; }, {
        remote, builtIn, local:{ command:'never-start-this-fixture' }
      });
      const Host = bridge.HostStdioMcpServer;
      const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
      assert.equal(Host, bridge.HostStdioMcpServer);
      assert.ok(applied.local.instance instanceof Host);
      assert.ok(applied.local.instance instanceof McpServer);
      assert.equal(require.cache[transportEntry], undefined);
      let closes = 0;
      applied.local.instance.close = async () => { closes++; };
      await mapper.close();
      assert.equal(closes, 1);
      assert.equal(unrelatedCloses, 0);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.join(__dirname, '..'), stdio: 'pipe', timeout: 15000 });
});

function fixture(t, config = {}, options = {}) {
  const sent = [], children = [], params = [];
  const endpoint = { start: async () => {}, send: async message => sent.push(message) };
  const server = new HostStdioMcpServer('fixture', { command: 'cmd.exe', args: ['/c', 'fixture'], ...config }, {
    createTransport: p => {
      params.push(p);
      const child = { sent: [], closed: 0, start: async () => {},
        send: async message => { child.sent.push(message); }, close: async () => { child.closed++; } };
      children.push(child); return child;
    }, ...options,
  });
  t.after(() => server.close());
  return { server, endpoint, children, params, sent };
}
test('host bridge preserves remote and in-process servers and never rewrites Windows paths', () => {
  const sdk = { type: 'sdk', instance: {} }, http = { type: 'http', url: 'https://example.invalid' }, sse = { type: 'sse', url: 'https://example.invalid/events' };
  const mapped = bridgeMcpServers({ sdk, http, sse, local: { command: 'node.exe', args: ['D:\\Tools\\server.js'], env: { SECRET: 'fixture-token' } } });
  assert.equal(mapped.sdk, sdk); assert.equal(mapped.http, http); assert.equal(mapped.sse, sse);
  assert.equal(mapped.local.type, 'sdk'); assert.equal(mapped.local.name, 'local');
  assert.equal(mapped.local.instance.config.args[0], 'D:\\Tools\\server.js');
  assert.equal(mapped.local.instance.config.env.SECRET, 'fixture-token');
});
test('raw initialize, tool results, resources, prompts and notifications survive bidirectional forwarding', async t => {
  const f = fixture(t, { env: { SECRET: 'fixture-token' } }, { env: { PATH: 'C:\\host-node', HTTP_PROXY: 'http://host.invalid' }, cwd: 'D:\\Task' });
  await f.server.connect(f.endpoint);
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} } } };
  await f.server.receive(init); assert.deepEqual(f.children[0].sent[0], init);
  assert.equal(f.params[0].env.PATH, 'C:\\host-node'); assert.equal(f.params[0].env.SECRET, 'fixture-token');
  assert.equal(f.params[0].args.includes('fixture-token'), false); assert.equal(f.params[0].cwd, 'D:\\Task');
  const messages = [
    { jsonrpc: '2.0', id: 1, result: { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } } },
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'fixture://resource' } },
    { jsonrpc: '2.0', id: 'server-request', method: 'sampling/createMessage', params: {} },
  ];
  for (const message of messages) f.children[0].onmessage(message);
  await tick(); assert.deepEqual(f.sent.slice(0, 3), messages.slice(0, 3));
  const reverse = f.sent[3]; assert.match(reverse.id, /^relay-host:/); assert.equal(reverse.method, 'sampling/createMessage');
  await f.server.receive({ jsonrpc: '2.0', id: reverse.id, result: { role: 'assistant', content: { type: 'text', text: 'fixture' } } });
  assert.equal(f.children[0].sent.at(-1).id, 'server-request');
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_once', arguments: { text: 'value' } } };
  await f.server.receive(call);
  const errorResult = { jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'failed' }], structuredContent: { partial: true } } };
  f.children[0].onmessage(errorResult); await tick(); assert.deepEqual(f.sent.at(-1), errorResult);
  assert.equal(f.children[0].sent.filter(m => m.method === 'tools/call').length, 1);
});
test('a timed-out side-effect call is canceled once, never retried, and its late response is discarded', async t => {
  const f = fixture(t, {}, { toolTimeoutMs: 15 }); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].error.message, /TIMEOUT/);
  const child = f.children[0];
  assert.equal(child.sent.filter(m => m.method === 'tools/call').length, 1);
  assert.equal(child.sent.filter(m => m.method === 'notifications/cancelled').length, 1);
  child.onmessage({ jsonrpc: '2.0', id: 4, result: { content: [] } }); await tick(); assert.equal(f.sent.length, 1);
});
test('host launch failure answers initialize with a sanitized per-server error without blocking other servers', async t => {
  const f = fixture(t, {}, { createTransport: () => ({ start: async () => { throw Error('C:\\secret --token fixture-token'); }, close: async () => {} }) });
  await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); await tick();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].error.message, /MCP_HOST_START_FAILED/);
  assert.equal(JSON.stringify(f.sent).includes('fixture-token'), false);
  const working = fixture(t); await working.server.connect(working.endpoint);
  await working.server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize' }); assert.equal(working.children.length, 1);
});
test('SDK transport closure cleans up subprocess and pending requests; explicit initialize reconnect never replays business calls', async t => {
  const f = fixture(t); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write' } });
  const first = f.children[0]; first.onclose(); await tick(); assert.match(f.sent[0].error.message, /MCP_HOST_CLOSED/);
  await f.server.receive({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal(f.children.length, 2); assert.deepEqual(f.children[1].sent.map(m => m.method), ['initialize']);
  assert.equal(first.closed, 1); f.endpoint.onclose(); await tick();
  assert.equal(f.children[1].closed, 1); assert.equal(f.server.pending.size, 0);
});
test('client cancellation forwards once and suppresses the canceled request response', async t => {
  const f = fixture(t); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 'write', method: 'tools/call', params: {} });
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'write' } });
  f.children[0].onmessage({ jsonrpc: '2.0', id: 'write', result: { content: [] } }); await tick();
  assert.equal(f.server.pending.size, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.children[0].sent.length, 2);
});
test('hot replacement removes the old SDK registration before adding its replacement; unchanged instances stay connected', async () => {
  const original = { type: 'sdk', instance: {} }, replacement = { type: 'sdk', instance: {} }, builtIn = { type: 'sdk', instance: {} };
  const initial = { local: original, builtIn }, calls = [];
  const mapper = createRuntimeMcpMapper(initial, async servers => servers);
  await mapper.applyServers(async servers => calls.push(servers), { local: original, builtIn }); assert.equal(calls.length, 1);
  await mapper.applyServers(async servers => calls.push(servers), { local: replacement, builtIn });
  assert.deepEqual(calls[1], { builtIn }); assert.deepEqual(calls[2], { local: replacement, builtIn });
  await mapper.applyServers(async servers => calls.push(servers), { builtIn }); assert.deepEqual(calls.at(-1), { builtIn });
});
test('failed hot replacement tracks removal and allows an explicit retry without closing unrelated servers', async () => {
  const old = { type: 'sdk', instance: {} }, next = { type: 'sdk', instance: {} };
  const mapper = createRuntimeMcpMapper({ local: old }, async servers => servers); const calls = [];
  await assert.rejects(mapper.applyServers(async servers => { calls.push(servers); if (servers.local) throw Error('registration failed'); }, { local: next }));
  await mapper.applyServers(async servers => calls.push(servers), { local: next });
  assert.equal(calls.length, 3); assert.deepEqual(calls[0], {}); assert.equal(calls[2].local, next);
});

test('synchronous cancellation cannot spawn an unowned MCP and close waits for child shutdown', async t => {
  let releaseClose; const closing = new Promise(resolve => { releaseClose = resolve; });
  const events = [];
  const f = fixture(t, {}, { createTransport: () => ({ start: async () => { events.push('start'); }, close: async () => { events.push('close'); await closing; }, send: async () => {} }) });
  await f.server.connect(f.endpoint);
  const receive = f.server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const firstClose = f.server.close(); assert.equal(firstClose, f.server.close());
  let done = false; firstClose.then(() => { done = true; }); await tick();
  assert.equal(done, false); assert.equal(events[0], 'start');
  releaseClose(); await Promise.all([receive, firstClose]); assert.equal(f.server.childTransport, null); assert.equal(done, true);
});
test('opposite-direction identical request ids do not resolve each other and cancellation ids are mapped', async t => {
  const f = fixture(t); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
  const child = f.children[0];
  child.onmessage({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage', params: { _meta: { progressToken: 'progress-1' } } });
  await tick(); const reverse = f.sent[0]; assert.notEqual(reverse.id, 1); assert.equal(f.server.pending.has(1), true);
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await tick(); assert.equal(f.sent[1].params.requestId, reverse.id);
  await f.server.receive({ jsonrpc: '2.0', id: reverse.id, error: { code: -32601, message: 'Unsupported capability' } });
  assert.equal(child.sent.at(-1).id, 1);
  child.onmessage({ jsonrpc: '2.0', id: 1, result: { content: [] } }); await tick();
  assert.equal(f.sent.at(-1).id, 1); assert.equal(f.server.pending.size, 0);
});

test('old SDK endpoints cannot close or forward into a reconnected host server', async t => {
  const f = fixture(t); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await f.server.close();
  const newer = { start: async () => {}, send: async () => {} };
  await f.server.connect(newer);
  f.endpoint.onmessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} });
  f.endpoint.onclose(); f.endpoint.onerror(); await tick();
  assert.equal(f.server.closed, false); assert.equal(f.server.failure, null);
  await f.server.receive({ jsonrpc: '2.0', id: 2, method: 'initialize' });
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[1].sent.map(item => item.id), [2]);
});
test('combined replacement and removal wait for both Windows MCPs before installing the next host', async t => {
  const a = fixture(t), b = fixture(t), next = fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const closed = []; a.server.close = async () => { closed.push('a'); await gate; };
  b.server.close = async () => { closed.push('b'); await gate; };
  const calls = [], mapper = createRuntimeMcpMapper({a:{type:'sdk',instance:a.server},b:{type:'sdk',instance:b.server}}, async v => v);
  const applying = mapper.applyServers(async value => { calls.push(value); }, {a:{type:'sdk',instance:next.server}});
  await tick(); assert.deepEqual(closed.sort(), ['a','b']); assert.equal(calls.length, 1);
  release(); await applying; assert.equal(calls.length, 2); await mapper.close();
});
