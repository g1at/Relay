'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeMcpServers } = require('../src/main/sdk/host-stdio-mcp');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const tool = {
  name: 'write_once', description: 'Write one exact result',
  inputSchema: { type: 'object', properties: { entries: { type: 'array', items: {
    type: 'object', properties: { label: { type: 'string' }, enabled: { type: 'boolean' } },
    required: ['label', 'enabled'], additionalProperties: false,
  } } }, required: ['entries'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { stored: { type: 'boolean' } }, required: ['stored'] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: { fixture: { keep: true } },
};
const initializeParams = {
  protocolVersion: '2025-11-25',
  clientInfo: { name: 'review-client', version: '1.0' },
  capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: { form: {} } },
};

function fixture(t, options = {}) {
  const sent = [], children = [], launchParams = [];
  const tools = options.tools || [tool];
  let refreshId = 0;
  const endpoint = { start: async () => {}, send: async message => {
    sent.push(message);
    if (message.method === 'notifications/tools/list_changed' && options.refresh !== false) {
      queueMicrotask(() => endpoint.onmessage?.({ jsonrpc: '2.0', id: 'review-refresh-' + (++refreshId), method: 'tools/list' }));
    }
  } };
  const config = { command: 'review-fixture-never-executed', args: ['C:\\fixture\\server.js'], ...options.config };
  const server = bridgeMcpServers({ fixture: config }, {
    deferConnect: true, connectTimeoutMs: 500, requestTimeoutMs: 500,
    discoveryTimeoutMs: 500, toolTimeoutMs: 500,
    ...options.bridge,
    createTransport: params => {
      launchParams.push(params);
      const child = {
        sent: [], closed: 0,
        start: async () => { if (options.start) await options.start(child); },
        close: async () => { child.closed++; if (options.close) await options.close(child); },
        send: async message => {
          child.sent.push(message);
          if (options.handle && await options.handle(message, child)) return;
          if (message.id === undefined || typeof message.method !== 'string') return;
          let result;
          if (message.method === 'initialize') result = {
            protocolVersion: '2025-11-25', serverInfo: { name: 'upstream-fixture', version: '1.2.3' },
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } },
            instructions: 'Fixture instructions must survive deferred discovery.',
          };
          else if (message.method === 'tools/list') result = { tools };
          else if (message.method === 'resources/list') result = { resources: [{ uri: 'fixture://saved', name: 'Saved result' }] };
          else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'fixture://{name}', name: 'Saved result by name' }] };
          else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: 'saved-content' }] };
          else if (message.method === 'prompts/list') result = { prompts: [{ name: 'explain', arguments: [{ name: 'topic', required: true }] }] };
          else if (message.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: message.params.arguments.topic } }] };
          else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'stored' }], structuredContent: { stored: true } };
          else result = {};
          queueMicrotask(() => child.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
        },
      };
      children.push(child); return child;
    },
  }).fixture.instance;
  t.after(() => server.close());
  return { server, endpoint, sent, children, launchParams,
    async ready() {
      await server.connect(endpoint);
      await server.receive({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: initializeParams });
      await server.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await tick();
    },
    async request(id, method, params) {
      await server.receive({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      for (let index = 0; index < 100 && !sent.some(message => message.id === id && !message.method); index++) await pause(5);
      const result = sent.find(message => message.id === id && !message.method);
      assert.ok(result, 'Expected response for ' + method + ' / ' + id);
      return result;
    },
    async search(id = 'discover', args = { names: ['write_once'] }) {
      const list = await this.request(id + '-list', 'tools/list');
      const entry = list.result.tools.find(item => /^relay_search_tools_/.test(item.name));
      assert.ok(entry, 'Deferred server exposes its lightweight discovery tool');
      return this.request(id, 'tools/call', { name: entry.name, arguments: args });
    },
  };
}

test('review: initialize, empty capability listings and keepalive never start an unused MCP', async t => {
  const f = fixture(t); await f.ready();
  const init = f.sent.find(message => message.id === 'init').result;
  assert.ok(init.capabilities.tools);
  assert.ok(init.capabilities.resources, 'Later resource reads must remain available');
  assert.ok(init.capabilities.prompts, 'Later prompt retrieval must remain available');
  assert.equal((await f.request('tools', 'tools/list')).result.tools.length, 1);
  assert.deepEqual((await f.request('resources', 'resources/list')).result.resources, []);
  assert.deepEqual((await f.request('templates', 'resources/templates/list')).result.resourceTemplates, []);
  assert.deepEqual((await f.request('prompts', 'prompts/list')).result.prompts, []);
  await f.request('ping', 'ping');
  assert.equal(f.children.length, 0);
  assert.equal(f.server.connectionState(), 'deferred');
});

test('review: discovery activates original declarations without performing the business operation', async t => {
  const f = fixture(t); await f.ready();
  const result = await f.search();
  assert.equal(result.result.isError, undefined);
  assert.equal(f.children.length, 1);
  assert.equal(f.server.connectionState(), 'connected');
  assert.deepEqual(f.children[0].sent.find(message => message.method === 'initialize').params, initializeParams);
  assert.equal(f.children[0].sent.filter(message => message.method === 'notifications/initialized').length, 1);
  assert.equal(f.children[0].sent.filter(message => message.method === 'tools/call').length, 0);
  const published = (await f.request('loaded-list', 'tools/list')).result.tools.find(item => item.name === tool.name);
  assert.ok(published);
  assert.deepEqual(published.inputSchema, tool.inputSchema);
  assert.deepEqual(published.outputSchema, tool.outputSchema);
  assert.deepEqual(published.annotations, tool.annotations);
  assert.deepEqual(published._meta.fixture, tool._meta.fixture);
  const input = { entries: [{ label: '未修改\\n\\u0000', enabled: false }], extra: null };
  const reply = await f.request('business', 'tools/call', { name: 'write_once', arguments: input, _meta: { progressToken: 'keep-progress' } });
  const calls = f.children[0].sent.filter(message => message.method === 'tools/call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { name: 'write_once', arguments: input, _meta: { progressToken: 'keep-progress' } });
  assert.deepEqual(reply.result.structuredContent, { stored: true });
});

test('review: active resources, templates and prompts retain original protocol data', async t => {
  const f = fixture(t); await f.ready(); await f.search();
  assert.deepEqual((await f.request('resources', 'resources/list')).result.resources, [{ uri: 'fixture://saved', name: 'Saved result' }]);
  assert.deepEqual((await f.request('templates', 'resources/templates/list')).result.resourceTemplates,
    [{ uriTemplate: 'fixture://{name}', name: 'Saved result by name' }]);
  assert.deepEqual((await f.request('prompts', 'prompts/list')).result.prompts,
    [{ name: 'explain', arguments: [{ name: 'topic', required: true }] }]);
  const read = await f.request('resource-read', 'resources/read', { uri: 'fixture://saved' });
  assert.equal(read.result.contents[0].text, 'saved-content');
  const prompt = await f.request('prompt-get', 'prompts/get', { name: 'explain', arguments: { topic: 'exact topic' } });
  assert.equal(prompt.result.messages[0].content.text, 'exact topic');
  assert.ok(f.sent.some(message => message.method === 'notifications/resources/list_changed'));
  assert.ok(f.sent.some(message => message.method === 'notifications/prompts/list_changed'));
});

test('review: explicit deferred resource reads and prompt retrieval activate only their owning server', async t => {
  const a = fixture(t), b = fixture(t); await a.ready(); await b.ready();
  assert.equal((await a.request('read', 'resources/read', { uri: 'fixture://saved' })).result.contents[0].text, 'saved-content');
  assert.equal(a.children.length, 1); assert.equal(b.children.length, 0);
  assert.equal((await b.request('get', 'prompts/get', { name: 'explain', arguments: { topic: 'fixture' } })).result.messages[0].content.text, 'fixture');
  assert.equal(b.children.length, 1); assert.notEqual(a.children[0], b.children[0]);
  await a.server.close(); assert.equal(a.children[0].closed, 1); assert.equal(b.children[0].closed, 0);
});

test('review: reverse RPC ids, capability payloads and cancellations remain bidirectional', async t => {
  const f = fixture(t, { handle: async message => message.method === 'tools/call' });
  await f.ready(); await f.search();
  await f.server.receive({ jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'write_once', arguments: { entries: [] } } });
  const child = f.children[0], baseline = f.sent.length;
  const params = { message: 'confirm fixture', requestedSchema: { type: 'object', properties: { allow: { type: 'boolean' } } } };
  child.onmessage({ jsonrpc: '2.0', id: 'same-id', method: 'elicitation/create', params });
  await tick();
  const reverse = f.sent.slice(baseline).find(message => message.method === 'elicitation/create');
  assert.ok(reverse); assert.notEqual(reverse.id, 'same-id'); assert.deepEqual(reverse.params, params);
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'same-id', reason: 'fixture' } });
  await tick();
  assert.equal(f.sent.at(-1).params.requestId, reverse.id);
  await f.server.receive({ jsonrpc: '2.0', id: reverse.id, result: { action: 'decline' } });
  assert.deepEqual(child.sent.at(-1), { jsonrpc: '2.0', id: 'same-id', result: { action: 'decline' } });
  child.onmessage({ jsonrpc: '2.0', id: 'same-id', result: { content: [{ type: 'text', text: 'done' }] } });
  await tick(); assert.equal(f.sent.at(-1).id, 'same-id');
});

test('review: canceling an activated business call forwards once and discards late results', async t => {
  const f = fixture(t, { handle: async message => message.method === 'tools/call' });
  await f.ready(); await f.search();
  const message = { jsonrpc: '2.0', id: 'cancel-business', method: 'tools/call', params: { name: 'write_once', arguments: { entries: [] } } };
  await f.server.receive(message);
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id } });
  const child = f.children[0];
  child.onmessage({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'late' }] } });
  await tick();
  assert.equal(child.sent.filter(item => item.method === 'tools/call').length, 1);
  assert.equal(child.sent.filter(item => item.method === 'notifications/cancelled' && item.params.requestId === message.id).length, 1);
  assert.equal(f.sent.some(item => item.id === message.id && !item.method), false);
});

test('review: closing during upstream startup never resurrects a process or dispatches a queued business call', async t => {
  let release; const starting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { start: () => starting }); await f.ready();
  const pending = f.server.receive({ jsonrpc: '2.0', id: 'queued-write', method: 'tools/call', params: { name: 'write_once', arguments: { entries: [] } } });
  await tick(); assert.equal(f.children.length, 1);
  const closing = f.server.close();
  release(); await Promise.allSettled([pending, closing]); await tick();
  assert.equal(f.children.length, 1);
  assert.ok(f.children[0].closed >= 1);
  assert.equal(f.server.childTransport, null);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
  assert.equal(f.server.closed, true);
});

test('review: a canceled call waiting for activation cannot execute after handshake completes', async t => {
  let release; const starting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { start: () => starting }); await f.ready();
  const pending = f.server.receive({ jsonrpc: '2.0', id: 'before-ready', method: 'tools/call', params: { name: 'write_once', arguments: { entries: [] } } });
  await tick();
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'before-ready' } });
  release(); await pending; await tick();
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
  assert.equal(f.sent.some(message => message.id === 'before-ready' && !message.method), false);
});

test('review: stale SDK endpoints cannot activate or close the next session attachment', async t => {
  const f = fixture(t); await f.ready(); await f.server.close();
  const newerSent = [], newer = { start: async () => {}, send: async message => { newerSent.push(message); } };
  await f.server.connect(newer);
  await f.server.receive({ jsonrpc: '2.0', id: 'new-init', method: 'initialize', params: initializeParams });
  f.endpoint.onmessage({ jsonrpc: '2.0', id: 'old-call', method: 'tools/call', params: { name: 'write_once' } });
  f.endpoint.onclose(); f.endpoint.onerror(); await tick();
  assert.equal(f.children.length, 0);
  assert.equal(f.server.closed, false);
  assert.equal(f.server.failure, null);
  assert.ok(newerSent.some(message => message.id === 'new-init'));
});

test('review: explicit connect performs real initialization without invoking business tools', async t => {
  const f = fixture(t); await f.ready();
  assert.equal(f.children.length, 0);
  await f.server.connectUpstream();
  assert.equal(f.children.length, 1);
  assert.equal(f.server.connectionState(), 'connected');
  assert.equal(f.children[0].sent.filter(message => message.method === 'initialize').length, 1);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
});

test('review: upstream startup failures stay local, redact launch details and never retry business calls', async t => {
  const failed = fixture(t, { start: async () => { throw Error('C:\\secret --token fixture-secret-token'); } });
  const working = fixture(t); await failed.ready(); await working.ready();
  const result = await failed.search();
  assert.ok(result.error || result.result?.isError);
  assert.equal(JSON.stringify(failed.sent).includes('fixture-secret-token'), false);
  assert.equal(failed.children.length, 1);
  assert.equal(failed.children[0].sent.some(message => message.method === 'tools/call'), false);
  assert.equal(working.children.length, 0);
  await working.search(); assert.equal(working.server.connectionState(), 'connected');
});


test('review: catalog changes during an in-flight refresh are not lost', async t => {
  let intercepted = false, heldList = null;
  const replacement = { ...tool, description: 'New catalog revision after the first refresh snapshot' };
  let revision = [tool];
  const f = fixture(t, { handle: async (message, child) => {
    if (message.method !== 'tools/list' || !intercepted) return false;
    if (!heldList) { heldList = { message, child }; return true; }
    queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { tools: revision } }));
    return true;
  } });
  await f.ready(); await f.search();
  const child = f.children[0];
  intercepted = true;
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await tick(); assert.ok(heldList);
  revision = [replacement];
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  heldList.child.onmessage({ jsonrpc: '2.0', id: heldList.message.id, result: { tools: [tool] } });
  for (let index = 0; index < 10; index++) await tick();
  const listed = await f.request('latest-revision', 'tools/list');
  assert.equal(listed.result.tools.find(item => item.name === tool.name).description, replacement.description);
});


test('review: initialization delivered during endpoint start is retained for later activation', async t => {
  const f = fixture(t);
  f.endpoint.start = async () => {
    f.endpoint.onmessage({ jsonrpc: '2.0', id: 'early-init', method: 'initialize', params: initializeParams });
    await tick();
  };
  await f.server.connect(f.endpoint);
  assert.ok(f.sent.some(message => message.id === 'early-init' && message.result));
  await f.server.connectUpstream();
  assert.equal(f.server.connectionState(), 'connected');
  assert.deepEqual(f.children[0].sent.find(message => message.method === 'initialize').params, initializeParams);
});


test('review: catalog changes while publishing a refresh notification are not lost', async t => {
  let revision = [tool];
  const replacement = { ...tool, description: 'Latest revision during SDK notification delivery' };
  const f = fixture(t, { handle: async (message, child) => {
    if (message.method !== 'tools/list') return false;
    queueMicrotask(() => child.onmessage({ jsonrpc: '2.0', id: message.id, result: { tools: revision } }));
    return true;
  } });
  await f.ready(); await f.search();
  const child = f.children[0], originalSend = f.endpoint.send;
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.endpoint.send = async message => {
    await originalSend(message);
    if (!held && message.method === 'notifications/tools/list_changed') { held = true; await gate; }
  };
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await tick(); assert.equal(held, true);
  revision = [replacement];
  child.onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  release();
  for (let index = 0; index < 10; index++) await tick();
  const listed = await f.request('after-notification', 'tools/list');
  assert.equal(listed.result.tools.find(item => item.name === tool.name).description, replacement.description);
});
