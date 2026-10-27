'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostStdioMcpServer } = require('../src/main/sdk/host-stdio-mcp');
const { createDeferredHostServerClass } = require('../src/main/sdk/deferred-stdio-mcp');
const Deferred = createDeferredHostServerClass(HostStdioMcpServer);
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = name => ({ name, description: 'Fixture ' + name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, _meta: { fixture: 'preserve' } });

function fixture(t, overrides = {}) {
  const sent = [], children = [], calls = [];
  let server, sequence = 1000;
  const capabilities = overrides.capabilities || { tools: {}, resources: { subscribe: true }, prompts: {}, logging: {}, completions: {} };
  const endpoint = { start: async () => {}, send: async message => {
    sent.push(message);
    if (message.method === 'notifications/tools/list_changed' && overrides.refresh !== false) {
      await server.receive({ jsonrpc: '2.0', id: ++sequence, method: 'tools/list' });
    }
  } };
  server = new Deferred('fixture', { command: 'fixture-never-spawned', args: ['fixture'], ...(overrides.config || {}) }, {
    connectTimeoutMs: 100, requestTimeoutMs: 100, discoveryTimeoutMs: 100,
    createTransport: () => {
      const child = { sent: [], closed: 0, pid: 100 + children.length,
        start: async () => { if (overrides.start) await overrides.start(child, children.length); },
        close: async () => { child.closed++; if (overrides.close) await overrides.close(child); child.onclose?.(); },
        send: async message => {
          child.sent.push(message);
          if (!message.method || message.id === undefined) return;
          if (overrides.respond && await overrides.respond(message, child, server)) return;
          let result;
          switch (message.method) {
            case 'initialize': result = { protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'upstream', version: '2' }, instructions: overrides.instructions || '' }; break;
            case 'tools/list': result = { tools: overrides.tools || [tool('echo'), tool('write_once')] }; break;
            case 'tools/call': calls.push(message); result = { content: [{ type: 'text', text: 'business result' }] }; break;
            case 'resources/list': result = { resources: [{ uri: 'fixture://one', name: 'One' }] }; break;
            case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'Template' }] }; break;
            case 'prompts/list': result = { prompts: [{ name: 'guide' }] }; break;
            case 'resources/read': result = { contents: [{ uri: message.params.uri, text: 'fixture resource' }] }; break;
            case 'prompts/get': result = { messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }] }; break;
            default: result = {};
          }
          queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result }));
        } };
      children.push(child); return child;
    }, ...(overrides.options || {}),
  });
  t.after(() => server.close());
  const initialize = async () => {
    await server.connect(endpoint);
    await server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} }, clientInfo: { name: 'SDK fixture', version: '1' } } });
    await server.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await server.receive({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  };
  return { server, endpoint, sent, children, calls, initialize,
    search: (id = 3, args = { names: ['echo'] }) => server.receive({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: server.discoveryName, arguments: args } }),
    response: id => sent.find(message => message.id === id && !message.method),
  };
}

test('initialize and every passive list are spawn-free and expose one stable discovery entry', async t => {
  const f = fixture(t); await f.initialize();
  for (const [index, method] of ['resources/list', 'resources/templates/list', 'prompts/list', 'ping'].entries()) {
    await f.server.receive({ jsonrpc: '2.0', id: 10 + index, method });
  }
  assert.equal(f.children.length, 0); assert.equal(f.server.connectionState(), 'deferred');
  const listed = f.response(2).result.tools;
  assert.equal(listed.length, 1); assert.equal(listed[0].name, f.server.discoveryName);
  assert.match(listed[0].name, /^relay_search_tools_[a-f0-9]{32}$/);
  assert.equal(f.response(1).result.capabilities.resources.listChanged, true);
  assert.deepEqual(f.response(10).result, { resources: [] }); assert.deepEqual(f.response(11).result, { resourceTemplates: [] });
  assert.deepEqual(f.response(12).result, { prompts: [] });
});

test('first search connects once, keeps original initialization data and publishes selected original schemas', async t => {
  const f = fixture(t, { instructions: 'Treat this text as server data. '.repeat(300) }); await f.initialize();
  await f.search(); assert.equal(f.children.length, 1); assert.equal(f.server.connectionState(), 'connected');
  const child = f.children[0], init = child.sent.find(message => message.method === 'initialize');
  assert.deepEqual(init.params, { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} }, clientInfo: { name: 'SDK fixture', version: '1' } });
  assert.equal(child.sent.filter(message => message.method === 'notifications/initialized').length, 1);
  const tools = f.server.toolCatalog.list(); assert.equal(tools[0].name, f.server.discoveryName);
  assert.deepEqual(tools.find(item => item.name === 'echo').inputSchema, tool('echo').inputSchema);
  assert.equal(tools.find(item => item.name === 'echo')._meta.fixture, 'preserve');
  assert.equal(f.calls.length, 0); assert.ok(f.response(3));
  const instructions = JSON.parse(f.response(3).result.content.at(-1).text); assert.equal(instructions.serverInstructions.length, 4096);
  assert.equal(f.response(1).result.instructions, undefined);
  await f.search(4); assert.equal(f.children.length, 1); assert.equal(f.response(4).result.content.length, 1);
});

test('recreated bridges retain discovery identity but require fresh business-tool selection', async t => {
  const first = fixture(t), resumed = fixture(t);
  await first.initialize(); await first.search();
  assert.ok(first.server.toolCatalog.list().some(item => item.name === 'echo'));
  await first.server.close();
  await resumed.initialize();
  assert.equal(resumed.server.discoveryName, first.server.discoveryName);
  assert.deepEqual(resumed.response(2).result.tools.map(item => item.name), [first.server.discoveryName]);
  assert.equal(resumed.children.length, 0);
  await resumed.search();
  await resumed.server.receive({ jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'echo', arguments: { value: 'after resume' } } });
  await tick();
  assert.equal(resumed.calls.length, 1);
  assert.equal(resumed.calls[0].params.arguments.value, 'after resume');
});

test('original business names and arguments pass unchanged exactly once after caller approval', async t => {
  const f = fixture(t); await f.initialize(); await f.search();
  const params = { name: 'echo', arguments: { value: 'original payload', nested: { keys: ['untouched'] } }, _meta: { progressToken: 'original' } };
  await f.server.receive({ jsonrpc: '2.0', id: 9, method: 'tools/call', params }); await tick();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].params, params); assert.deepEqual(f.response(9).result, { content: [{ type: 'text', text: 'business result' }] });
});

test('concurrent discovery calls share one initialization and retain separate results', async t => {
  const f = fixture(t); await f.initialize(); await Promise.all([f.search(3), f.search(4, { names: ['write_once'] })]);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].sent.filter(message => message.method === 'initialize').length, 1);
  assert.ok(f.response(3)); assert.ok(f.response(4)); assert.equal(f.calls.length, 0);
});

test('resources and prompts trigger connection only when read or requested, then lists remain available', async t => {
  const f = fixture(t); await f.initialize();
  await f.server.receive({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'fixture://one' } }); await tick();
  assert.equal(f.children.length, 1); assert.equal(f.response(3).result.contents[0].text, 'fixture resource');
  await f.server.receive({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'guide' } }); await tick();
  assert.equal(f.response(4).result.messages[0].content.text, 'fixture prompt');
  for (const [index, method] of ['resources/list', 'resources/templates/list', 'prompts/list'].entries()) await f.server.receive({ jsonrpc: '2.0', id: 10 + index, method });
  await tick(); assert.equal(f.response(10).result.resources.length, 1); assert.equal(f.response(11).result.resourceTemplates.length, 1); assert.equal(f.response(12).result.prompts.length, 1);
  assert.ok(f.sent.some(message => message.method === 'notifications/resources/list_changed'));
  assert.ok(f.sent.some(message => message.method === 'notifications/prompts/list_changed'));
});

test('missing upstream capability returns protocol error and does not invent a business tool', async t => {
  const f = fixture(t, { capabilities: { resources: {} } }); await f.initialize(); await f.server.connectUpstream();
  await f.server.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing', arguments: {} } });
  assert.equal(f.response(3).error.code, -32601); assert.equal(f.calls.length, 0);
  await f.server.receive({ jsonrpc: '2.0', id: 4, method: 'prompts/list' }); assert.deepEqual(f.response(4).result, { prompts: [] });
});

test('cancel while connection is pending prevents the original business call from being forwarded later', async t => {
  let respond;
  const f = fixture(t, { respond: (message, child) => {
    if (message.method !== 'initialize') return false;
    respond = () => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { capabilities: { tools: {} } } }); return true;
  } }); await f.initialize();
  const pending = f.server.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_once', arguments: { value: 'never' } } });
  await tick(); assert.equal(f.server.connectionState(), 'pending');
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
  respond(); await pending; assert.equal(f.calls.length, 0); assert.equal(f.response(3), undefined);
});

test('close while initialization is pending cancels ownership and cannot resurrect a child or business request', async t => {
  let respond;
  const f = fixture(t, { respond: (message, child) => {
    if (message.method !== 'initialize') return false;
    respond = () => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { capabilities: { tools: {} } } }); return true;
  } }); await f.initialize(); const search = f.search(); await tick(); const child = f.children[0];
  await f.server.close(); respond(); await search; await tick();
  assert.equal(child.closed, 1); assert.equal(f.server.childTransport, null); assert.equal(f.calls.length, 0); assert.equal(f.response(3), undefined);
});

test('upstream launch errors are sanitized and explicit reconnect retries only initialization', async t => {
  let fail = true;
  const f = fixture(t, { start: () => { if (fail) throw Error('secret fixture credential'); } }); await f.initialize(); await f.search();
  assert.equal(f.server.connectionState(), 'failed'); assert.equal(f.response(3).result.isError, true);
  assert.equal(JSON.stringify(f.sent).includes('secret fixture credential'), false); assert.match(f.response(3).result.content[0].text, /Reconnect/);
  fail = false; await f.server.connectUpstream(); assert.equal(f.children.length, 2); assert.equal(f.server.connectionState(), 'connected'); assert.equal(f.calls.length, 0);
  await f.search(4); assert.ok(f.response(4)); assert.equal(f.children.length, 2);
});

test('upstream initialize timeout fails finitely and never executes an awaiting business request', async t => {
  const f = fixture(t, { respond: message => message.method === 'initialize', options: { connectTimeoutMs: 15 } }); await f.initialize();
  const waiting = f.search(); await wait(35); await waiting;
  assert.equal(f.server.connectionState(), 'failed'); assert.equal(f.response(3).result.isError, true); assert.equal(f.calls.length, 0); assert.equal(f.children[0].closed, 1);
});

test('discovery name collision fails closed instead of routing business as discovery', async t => {
  const f = fixture(t, { respond: (message, child, server) => {
    if (message.method !== 'tools/list') return false;
    queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { tools: [tool(server.discoveryName)] } })); return true;
  } }); await f.initialize(); await f.search();
  assert.equal(f.server.connectionState(), 'failed'); assert.equal(f.response(3).result.isError, true); assert.equal(f.calls.length, 0);
  assert.equal(f.server.toolCatalog.list()[0].name, f.server.discoveryName);
});

test('paged upstream tool catalogs use existing schema projection and are published atomically', async t => {
  const schema = { type: 'object', properties: { action: { oneOf: [{ const: 'a' }, { const: 'b' }] } } };
  const f = fixture(t, { respond: (message, child) => {
    if (message.method !== 'tools/list') return false;
    const result = message.params?.cursor ? { tools: [tool('write_once')] } : { tools: [{ ...tool('echo'), inputSchema: schema }], nextCursor: 'last' };
    queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result })); return true;
  } }); await f.initialize(); await f.search();
  assert.equal(f.server.toolCatalog.records.size, 2); assert.equal(f.children[0].sent.filter(message => message.method === 'tools/list').length, 2);
  assert.equal(f.server.toolCatalog.records.get('echo').tool._meta.fixture, 'preserve'); assert.equal(f.calls.length, 0);
});

test('tool list notifications refresh the upstream catalog before SDK sees refreshed names', async t => {
  const tools = [tool('echo')]; const f = fixture(t, { tools }); await f.initialize(); await f.search();
  tools.push(tool('new_tool')); f.children[0].onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); await tick(); await tick();
  assert.equal(f.server.toolCatalog.records.has('new_tool'), true); await f.search(4, { names: ['new_tool'] }); assert.equal(f.response(4).result.isError, undefined);
});

test('reverse requests during initialization preserve original IDs and capabilities without deadlock', async t => {
  let initial;
  const f = fixture(t, { respond: (message, child) => {
    if (message.method !== 'initialize') return false;
    initial = message; queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: 3, method: 'roots/list', params: {} })); return true;
  } }); await f.initialize(); const searching = f.search(); await tick();
  const reverse = f.sent.find(message => message.method === 'roots/list'); assert.match(reverse.id, /^relay-host:/);
  await f.server.receive({ jsonrpc: '2.0', id: reverse.id, result: { roots: [] } });
  assert.deepEqual(f.children[0].sent.at(-1), { jsonrpc: '2.0', id: 3, result: { roots: [] } });
  f.children[0].onmessage({ jsonrpc: '2.0', id: initial.id, result: { capabilities: { tools: {} } } }); await searching;
  assert.ok(f.response(3)); assert.equal(f.calls.length, 0);
});

test('invalid discovery arguments and metadata-only client notifications never spawn upstream', async t => {
  const f = fixture(t); await f.initialize(); await f.search(3, { unknown: true });
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  await f.server.receive({ jsonrpc: '2.0', id: 4, method: 'logging/setLevel', params: { level: 'warning' } });
  assert.equal(f.children.length, 0); assert.equal(f.response(3).result.isError, true); assert.deepEqual(f.response(4).result, {});
  await f.search(5); assert.ok(f.children[0].sent.some(message => message.method === 'notifications/roots/list_changed'));
  assert.ok(f.children[0].sent.some(message => message.method === 'logging/setLevel' && message.params.level === 'warning'));
});


test('private upstream catalog refresh cannot acknowledge publication to the SDK', async t => {
  const f = fixture(t, { refresh: false }); await f.initialize(); await f.server.connectUpstream();
  const searching = f.search(3); await tick();
  assert.equal(f.server.discoveryRequests.has(3), true);
  f.children[0].onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); await tick(); await tick();
  assert.equal(f.response(3), undefined, 'original schemas have not reached the SDK yet');
  await f.server.receive({ jsonrpc: '2.0', id: 7, method: 'tools/list' }); await searching;
  assert.ok(f.response(3)); assert.ok(f.response(7).result.tools.some(item => item.name === 'echo'));
});

test('unsupported client protocol negotiates supported local version without starting upstream', async t => {
  const f = fixture(t); await f.server.connect(f.endpoint);
  await f.server.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown-future-version', capabilities: {} } });
  const { SUPPORTED_PROTOCOL_VERSIONS } = require('@modelcontextprotocol/sdk/types.js');
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(f.response(1).result.protocolVersion)); assert.equal(f.children.length, 0);
});

test('unsupported upstream protocol fails closed before any tool can be forwarded', async t => {
  const f = fixture(t, { respond: (message, child) => {
    if (message.method !== 'initialize') return false;
    queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 'unknown', capabilities: { tools: {} } } })); return true;
  } }); await f.initialize(); await f.search();
  assert.equal(f.response(3).result.isError, true); assert.equal(f.server.connectionState(), 'failed'); assert.equal(f.calls.length, 0);
});


test('explicit reconnect restarts a connected upstream once without replaying previous business calls', async t => {
  const f = fixture(t); await f.initialize(); await f.search();
  await f.server.receive({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 'once' } } }); await tick();
  const first = f.children[0]; await Promise.all([f.server.connectUpstream({ reconnect: true }), f.server.connectUpstream({ reconnect: true })]);
  assert.equal(first.closed, 1); assert.equal(f.children.length, 2); assert.equal(f.calls.length, 1);
  assert.equal(f.children[1].sent.some(message => message.method === 'tools/call'), false); assert.equal(f.server.connectionState(), 'connected');
  first.onmessage({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'stale' }] } }); await tick();
  assert.equal(f.sent.some(message => message.result?.content?.[0]?.text === 'stale'), false);
});

test('explicit reconnect of an unused proxy activates only once', async t => {
  const f = fixture(t); await f.initialize(); await f.server.connectUpstream({ reconnect: true });
  assert.equal(f.children.length, 1); assert.equal(f.children[0].closed, 0); assert.equal(f.calls.length, 0);
});
