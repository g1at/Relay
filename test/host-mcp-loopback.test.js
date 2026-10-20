'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const { bridgeMcpServers, createRuntimeMcpMapper } = require('../src/main/sdk/host-stdio-mcp');
const { exposeHostMcpLoopback, getHostMcpLoopbackOwner } = require('../src/main/sdk/host-mcp-loopback');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const children = [], calls = [];
  const sdk = bridgeMcpServers({ fixture: { command: 'fixture-only', timeout: 12345, ...(options.config || {}) } }, {
    deferConnect: true,
    createTransport: () => {
      const child = { closed: 0, start: async () => {}, close: async () => { child.closed++; }, send: async message => {
        if (message.id === undefined || !message.method) return;
        let result;
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] };
        else { calls.push(message); result = { content: [{ type: 'text', text: 'original result' }] }; }
        queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result }));
      } };
      children.push(child); return child;
    },
  }).fixture;
  const config = await exposeHostMcpLoopback('fixture', sdk, options);
  const owner = getHostMcpLoopbackOwner(config);
  t.after(() => owner.close());
  let visibleTools = [], readerCalls = 0;
  const status = () => ({ name: 'fixture', source: 'dynamic', status: 'connected', config, tools: visibleTools });
  owner.setStatusReader(async () => { readerCalls++; return [status()]; });
  async function connect() {
    const client = new Client({ name: 'fixture-client', version: '1' }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      const result = await client.listTools(); visibleTools = result.tools;
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, reconnectionOptions: { maxRetries: 0 } });
    await client.connect(transport); t.after(() => client.close());
    return { client, transport };
  }
  return { config, owner, sdk, children, calls, connect, status, readers: () => readerCalls };
}

test('loopback rejects missing/wrong credentials, foreign origins/hosts, and malformed probes without starting upstream', async t => {
  const f = await fixture(t);
  assert.equal(f.config.type, 'http'); assert.equal(f.config.timeout, 12345);
  assert.equal(new URL(f.config.url).hostname, '127.0.0.1');
  for (const headers of [{}, { Authorization: 'Bearer bad' }]) assert.equal((await fetch(f.config.url, { headers })).status, 401);
  for (const headers of [{ Origin: 'https://example.invalid' }, { Host: 'example.invalid' }]) {
    const status = await new Promise((resolve, reject) => { const request = require('node:http').get(f.config.url, { headers: { ...f.config.headers, ...headers } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(status, 403);
  }
  assert.equal((await fetch(f.config.url, { method: 'POST', headers: f.config.headers, body: 'invalid' })).status, 400);
  assert.equal((await fetch(f.config.url, { method: 'POST', headers: { ...f.config.headers, 'content-type': 'application/json' }, body: '{}' })).status, 406);
  const { client } = await f.connect();
  const tools = await client.listTools(); assert.equal(tools.tools.length, 1);
  assert.equal(f.sdk.instance.failure, null); assert.equal(f.children.length, 0);
});

test('HTTP discovery waits for confirmed client visibility and forwards original business arguments exactly once', async t => {
  const f = await fixture(t), { client } = await f.connect();
  const discovery = (await client.listTools()).tools[0].name;
  const found = await client.callTool({ name: discovery, arguments: { names: ['echo'] } });
  assert.equal(found.isError, undefined); assert.ok(f.readers() > 0);
  assert.ok(f.status().tools.some(tool => tool.name === 'echo')); assert.equal(f.children.length, 1); assert.equal(f.calls.length, 0);
  const result = await client.callTool({ name: 'echo', arguments: { value: 'unchanged' } });
  assert.equal(result.content[0].text, 'original result'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params.arguments, { value: 'unchanged' });
  await f.owner.close(); assert.equal(f.children[0].closed, 1);
  await assert.rejects(fetch(f.config.url, { headers: f.config.headers }));
});

test('status decoration and manual upstream reconnect require the exact owned dynamic endpoint', async t => {
  const f = await fixture(t); await f.connect();
  const mapper = createRuntimeMcpMapper({ fixture: f.config }, async servers => servers);
  t.after(() => mapper.close());
  const valid = f.status();
  assert.equal(mapper.decorateStatus([valid])[0].status, 'deferred');
  for (const wrong of [{ ...valid, source: 'user' }, { ...valid, config: { type: 'http', url: f.config.url + '-other' } }]) {
    assert.equal(mapper.decorateStatus([wrong])[0].status, 'connected');
    await assert.rejects(mapper.connectUpstream('fixture', async () => [wrong]), /REGISTRATION_NOT_READY/);
  }
  assert.equal(f.children.length, 0);
  await mapper.connectUpstream('fixture', async () => [valid]);
  assert.equal(f.children.length, 1); assert.equal(f.calls.length, 0);
  await mapper.connectUpstream('fixture', async () => [valid]);
  assert.equal(f.children.length, 2); assert.equal(f.children[0].closed, 1);
});

test('cancel closes a pending catalog visibility wait and its listener without executing a business tool', async t => {
  const f = await fixture(t), { client } = await f.connect();
  let entered; const pending = new Promise(resolve => { entered = resolve; });
  f.owner.setStatusReader(() => { entered(); return new Promise(() => {}); });
  const discovery = (await client.listTools()).tools[0].name;
  const call = client.callTool({ name: discovery, arguments: { names: ['echo'] } }).catch(error => error);
  await pending;
  await f.owner.close(); await call;
  assert.equal(f.calls.length, 0); assert.equal(f.children[0].closed, 1);
  assert.equal(f.sdk.instance.pending.size, 0);
});

test('separate query endpoints have separate tokens and replacing a registration closes only the retired owner', async t => {
  const first = await fixture(t), second = await fixture(t);
  assert.notEqual(first.config.url, second.config.url); assert.notEqual(first.config.headers.Authorization, second.config.headers.Authorization);
  assert.equal((await fetch(first.config.url, { headers: second.config.headers })).status, 401);
  const mapper = createRuntimeMcpMapper({ fixture: first.config }, async servers => servers);
  t.after(() => mapper.close());
  await mapper.applyServers(async () => ({}), { fixture: second.config });
  await assert.rejects(fetch(first.config.url, { headers: first.config.headers }));
  const { client } = await second.connect(); assert.equal((await client.listTools()).tools.length, 1);
  await mapper.close(); await tick();
  await assert.rejects(fetch(second.config.url, { headers: second.config.headers }));
});

test('closing during async mapping retires the late owner without applying it to a closed query', async t => {
  let release;
  const mapped = new Promise(resolve => { release = resolve; });
  const mapper = createRuntimeMcpMapper({}, () => mapped);
  const pending = mapper.applyServers(async () => { assert.fail('closed query must not apply a late registration'); }, {});
  const rejected = assert.rejects(pending, /MCP_MAPPER_CLOSED/);
  const closing = mapper.close();
  const late = await fixture(t);
  release({ fixture: late.config });
  await Promise.all([closing, rejected]);
  await assert.rejects(fetch(late.config.url, { headers: late.config.headers }));
  assert.equal(mapper.close(), closing);
});
