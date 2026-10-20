'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HostStdioMcpServer } = require('../src/main/sdk/host-stdio-mcp');

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const tool = name => ({ name, description: `Read ${name}`, inputSchema: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
} });
const tools = (count = 20) => Array.from({ length: count }, (_, index) => tool(`original_${index}`));
const replyFor = (fixture, id) => fixture.sent.find(message => message.id === id && !message.method);
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function fixture(t, config = {}, options = {}) {
  const sent = [], children = [];
  const endpoint = { start: async () => {}, send: async message => { sent.push(message); } };
  const server = new HostStdioMcpServer('fixture-discovery', { command: 'unused-fixture-command', ...config }, {
    discoveryTimeoutMs: 1000,
    createTransport: () => {
      const child = { sent: [], closed: 0, start: async () => {},
        send: async message => { child.sent.push(message); }, close: async () => { child.closed++; } };
      children.push(child);
      return child;
    }, ...options,
  });
  t.after(() => server.close());
  await server.connect(endpoint);
  return { server, endpoint, sent, children, counter: 0 };
}

async function list(f, entries = tools()) {
  const id = `list-${++f.counter}`;
  await f.server.receive({ jsonrpc: '2.0', id, method: 'tools/list' });
  await f.server.receiveChild({ jsonrpc: '2.0', id, result: { tools: entries } }, f.children.at(-1));
  return replyFor(f, id);
}

test('initial large catalog advertises discovery, initializes list-change support and preserves original calls', async t => {
  const f = await fixture(t);
  await f.server.receive({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} });
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'init', result: { capabilities: { tools: {}, resources: {} } } }, f.children[0]);
  assert.equal(replyFor(f, 'init').result.capabilities.tools.listChanged, true);
  assert.deepEqual(replyFor(f, 'init').result.capabilities.resources, {});
  const originalTools = tools(), initial = await list(f, originalTools);
  assert.deepEqual(initial.result.tools.map(entry => entry.name), ['relay_search_tools']);
  const discovery = f.server.receive(call('discover', 'relay_search_tools', { names: ['original_7'] }));
  await tick();
  assert.equal(replyFor(f, 'discover'), undefined);
  assert.equal(f.sent.at(-1).method, 'notifications/tools/list_changed');
  const refreshed = await list(f, originalTools);
  await discovery;
  const advertised = refreshed.result.tools.find(entry => entry.name === 'original_7');
  assert.equal(advertised.inputSchema, originalTools[7].inputSchema);
  assert.equal(advertised._meta['anthropic/alwaysLoad'], true);
  assert.equal(replyFor(f, 'discover').result.isError, undefined);
  const operation = call('business', 'original_7', { text: 'unchanged original parameters' });
  await f.server.receive(operation);
  assert.equal(f.children[0].sent.filter(message => message.method === 'tools/call').length, 1);
  assert.equal(f.children[0].sent.at(-1), operation);
  const result = { jsonrpc: '2.0', id: 'business', result: { content: [{ type: 'text', text: 'done' }] } };
  await f.server.receiveChild(result, f.children[0]);
  assert.equal(replyFor(f, 'business'), result);
});

test('discovery does not complete until the updated tools/list reply finishes sending', async t => {
  const f = await fixture(t); await list(f);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = f.endpoint.send;
  f.endpoint.send = async message => {
    await send(message);
    if (message.id === 'list-2') await gate;
  };
  const discovering = f.server.receive(call('discover', 'relay_search_tools', { names: ['original_1'] }));
  await tick();
  const refreshing = list(f);
  await tick();
  assert.ok(replyFor(f, 'list-2'));
  assert.equal(replyFor(f, 'discover'), undefined);
  release();
  await Promise.all([refreshing, discovering]);
  assert.ok(replyFor(f, 'discover'));
});

test('timeout reports discovery failure without forwarding a business call or replaying later', async t => {
  const f = await fixture(t, {}, { discoveryTimeoutMs: 15 }); await list(f);
  await Promise.all([f.server.receive(call('discover', 'relay_search_tools', { names: ['original_1'] })), delay(35)]);
  const failed = replyFor(f, 'discover');
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /timed out/i);
  await list(f);
  assert.equal(f.sent.filter(message => message.id === 'discover').length, 1);
  assert.equal(f.children[0].sent.filter(message => message.method === 'tools/call').length, 0);
  assert.equal(f.server.pending.size, 0);
});

test('retry after an unpublished timeout must refresh even if the selected tools are unchanged', async t => {
  const f = await fixture(t, {}, { discoveryTimeoutMs: 30 }); await list(f);
  const args = { names: ['original_2'] };
  await Promise.all([f.server.receive(call('first', 'relay_search_tools', args)), delay(45)]);
  assert.equal(replyFor(f, 'first').result.isError, true);
  const retry = f.server.receive(call('retry', 'relay_search_tools', args));
  await tick();
  assert.equal(replyFor(f, 'retry'), undefined);
  assert.equal(f.sent.filter(message => message.method === 'notifications/tools/list_changed').length, 2);
  await list(f); await retry;
  assert.equal(replyFor(f, 'retry').result.isError, undefined);
  assert.equal(f.children[0].sent.filter(message => message.method === 'tools/call').length, 0);
});

test('client cancellation suppresses discovery response and does not cancel an unrelated upstream call', async t => {
  const f = await fixture(t); await list(f);
  const discovery = f.server.receive(call('discover', 'relay_search_tools', { names: ['original_3'] }));
  await tick();
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'discover' } });
  await discovery;
  await list(f);
  assert.equal(replyFor(f, 'discover'), undefined);
  assert.equal(f.children[0].sent.some(message => message.method === 'notifications/cancelled'), false);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
  assert.equal(f.server.discoveryRequests.size, 0);
});

test('close while discovery waits clears pending work and never forwards a business call', async t => {
  const f = await fixture(t); await list(f);
  const discovery = f.server.receive(call('discover', 'relay_search_tools', { names: ['original_4'] }));
  await tick();
  await f.server.close(); await discovery;
  assert.equal(replyFor(f, 'discover'), undefined);
  assert.equal(f.server.pending.size, 0);
  assert.equal(f.server.discoveryRequests.size, 0);
  assert.equal(f.server.toolCatalog.stats().activeCount, 0);
  assert.equal(f.children[0].closed, 1);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
});

test('paginated upstream catalog is fully collected before discovery is advertised', async t => {
  const f = await fixture(t), entries = tools();
  await f.server.receive({ jsonrpc: '2.0', id: 'paged', method: 'tools/list' });
  const child = f.children[0];
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'paged', result: { tools: entries.slice(0, 7), nextCursor: 'page-2' } }, child);
  assert.equal(replyFor(f, 'paged'), undefined);
  assert.deepEqual(child.sent.at(-1).params, { cursor: 'page-2' });
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'paged', result: { tools: entries.slice(7, 14), nextCursor: 'page-3' } }, child);
  assert.equal(replyFor(f, 'paged'), undefined);
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'paged', result: { tools: entries.slice(14), _meta: { retained: true } } }, child);
  assert.equal(replyFor(f, 'paged').result.nextCursor, undefined);
  assert.deepEqual(replyFor(f, 'paged').result._meta, { retained: true });
  assert.equal(f.server.toolCatalog.stats().totalCount, 20);
  const discovery = f.server.receive(call('find-last', 'relay_search_tools', { names: ['original_19'] }));
  await tick(); await list(f, entries); await discovery;
  assert.equal(replyFor(f, 'find-last').result.isError, undefined);
  assert.ok(f.server.toolCatalog.list().some(entry => entry.name === 'original_19'));
});

test('upstream list-change notification reaches SDK and a refreshed catalog replaces removed tools', async t => {
  const f = await fixture(t); await list(f);
  let discovering = f.server.receive(call('find-old', 'relay_search_tools', { names: ['original_0'] }));
  await tick(); await list(f); await discovering;
  const notification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
  await f.server.receiveChild(notification, f.children[0]);
  assert.equal(f.sent.at(-1), notification);
  const updated = [...tools().slice(1), tool('new_original')];
  await list(f, updated);
  assert.equal(f.server.toolCatalog.list().some(entry => entry.name === 'original_0'), false);
  discovering = f.server.receive(call('find-new', 'relay_search_tools', { names: ['new_original'] }));
  await tick(); await list(f, updated); await discovering;
  assert.equal(replyFor(f, 'find-new').result.isError, undefined);
  assert.equal(f.server.toolCatalog.stats().totalCount, 20);
});

test('repeated pagination cursors fail boundedly without poisoning a subsequent listing', async t => {
  const f = await fixture(t);
  await f.server.receive({ jsonrpc: '2.0', id: 'loop', method: 'tools/list' });
  const child = f.children[0];
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'loop', result: { tools: [tool('first')], nextCursor: 'same' } }, child);
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'loop', result: { tools: [tool('second')], nextCursor: 'same' } }, child);
  assert.match(replyFor(f, 'loop').error.message, /repeated page cursor/);
  assert.equal(child.sent.filter(message => message.method === 'tools/list' && message.id === 'loop').length, 2);
  assert.equal(f.server.pending.size, 0);
  assert.equal(f.server.toolListPages.size, 0);
  assert.equal(f.server.failure, null);
  assert.ok((await list(f)).result.tools[0].name.startsWith('relay_search_tools'));
});

test('invalid or duplicate definitions fail their request and keep the transport usable', async t => {
  const f = await fixture(t);
  for (const entries of [[null], [tool('same'), tool('same')], [{ name: '' }]]) {
    const response = await list(f, entries);
    assert.match(response.error.message, /invalid or duplicate definitions/);
    assert.equal(f.server.failure, null);
    assert.equal(f.server.pending.size, 0);
  }
  assert.ok((await list(f)).result.tools[0].name.startsWith('relay_search_tools'));
});

test('small catalogs and explicit alwaysLoad retain their direct original tool interface', async t => {
  for (const [config, count] of [[{}, 3], [{ alwaysLoad: true }, 20]]) {
    const f = await fixture(t, config), entries = tools(count), result = await list(f, entries);
    assert.deepEqual(result.result.tools.map(entry => entry.name), entries.map(entry => entry.name));
    assert.equal(f.server.toolCatalog.discoveryName, null);
    for (let index = 0; index < count; index++) assert.equal(result.result.tools[index].inputSchema, entries[index].inputSchema);
    if (config.alwaysLoad) assert.ok(result.result.tools.every(entry => entry._meta['anthropic/alwaysLoad'] === true));
    const originalCall = call('direct', 'original_0', { text: 'original' });
    await f.server.receive(originalCall);
    assert.equal(f.children[0].sent.at(-1), originalCall);
  }
});

test('null and false discovery arguments are rejected instead of silently becoming browse requests', async t => {
  const f = await fixture(t); await list(f);
  for (const [id, args] of [['null', null], ['false', false], ['zero', 0], ['empty-string', '']]) {
    await f.server.receive(call(id, 'relay_search_tools', args));
    assert.equal(replyFor(f, id).result.isError, true);
  }
  assert.equal(f.server.toolCatalog.stats().activeCount, 0);
  assert.equal(f.sent.some(message => message.method === 'notifications/tools/list_changed'), false);
});

test('same-instance reconnect resets catalog and ignores the old endpoint and subprocess', async t => {
  const f = await fixture(t); await list(f);
  const discovery = f.server.receive(call('first-discovery', 'relay_search_tools', { names: ['original_5'] }));
  await tick(); await list(f); await discovery;
  await f.server.close();
  assert.equal(f.server.toolCatalog.discoveryName, null);
  const newSent = [], endpoint = { start: async () => {}, send: async message => { newSent.push(message); } };
  await f.server.connect(endpoint);
  f.endpoint.onmessage(call('old-endpoint', 'original_5', { text: 'must not run' }));
  f.children[0].onmessage({ jsonrpc: '2.0', id: 'old-reply', result: { tools: tools() } });
  await tick();
  assert.deepEqual(newSent, []);
  await f.server.receive({ jsonrpc: '2.0', id: 'new-list', method: 'tools/list' });
  await f.server.receiveChild({ jsonrpc: '2.0', id: 'new-list', result: { tools: tools() } }, f.children[1]);
  assert.deepEqual(newSent.at(-1).result.tools.map(entry => entry.name), ['relay_search_tools']);
  assert.equal(f.server.toolCatalog.stats().activeCount, 0);
  assert.equal(f.children[1].sent.some(message => message.method === 'tools/call'), false);
});

test('a delayed old discovery send cannot delete the gate of a reused id after reconnect', async t => {
  const f = await fixture(t); await list(f);
  let release;
  const oldSend = new Promise(resolve => { release = resolve; });
  const send = f.endpoint.send;
  f.endpoint.send = async message => {
    await send(message);
    if (message.method === 'notifications/tools/list_changed') await oldSend;
  };
  const oldDiscovery = f.server.receive(call('shared-id', 'relay_search_tools', { names: ['original_1'] }));
  await tick();
  await f.server.close();
  const nextEndpoint = { start: async () => {}, send: async message => { f.sent.push(message); } };
  await f.server.connect(nextEndpoint);
  await list(f);
  const newDiscovery = f.server.receive(call('shared-id', 'relay_search_tools', { names: ['original_2'] }));
  await tick();
  assert.equal(f.server.discoveryRequests.has('shared-id'), true);
  release(); await oldDiscovery;
  assert.equal(f.server.discoveryRequests.has('shared-id'), true);
  await list(f); await newDiscovery;
  assert.deepEqual(JSON.parse(replyFor(f, 'shared-id').result.content[0].text).activated, ['original_2']);
  assert.equal(f.sent.filter(message => message.id === 'shared-id').length, 1);
  assert.equal(f.children.flatMap(child => child.sent).some(message => message.method === 'tools/call'), false);
});

test('two host instances keep catalog and discovery activation ownership separate', async t => {
  const first = await fixture(t), second = await fixture(t);
  await Promise.all([list(first), list(second)]);
  const discovery = first.server.receive(call('discover', 'relay_search_tools', { names: ['original_6'] }));
  await tick(); await list(first); await discovery;
  assert.equal(first.server.toolCatalog.stats().activeCount, 1);
  assert.equal(second.server.toolCatalog.stats().activeCount, 0);
  assert.deepEqual(second.server.toolCatalog.list().map(entry => entry.name), ['relay_search_tools']);
  assert.equal(second.sent.some(message => message.method === 'notifications/tools/list_changed'), false);
});

test('canceled queued discovery cannot consume a reused request id and activate old arguments', async t => {
  const f = await fixture(t); await list(f);
  const first = f.server.receive(call('first', 'relay_search_tools', { names: ['original_1'] }));
  const canceled = f.server.receive(call('reused', 'relay_search_tools', { names: ['original_2'] }));
  await tick();
  await f.server.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'reused' } });
  const current = f.server.receive(call('reused', 'relay_search_tools', { names: ['original_3'] }));
  await list(f); await first; await tick();
  assert.equal(f.server.toolCatalog.list().some(entry => entry.name === 'original_2'), false);
  await list(f); await Promise.all([canceled, current]);
  const response = replyFor(f, 'reused');
  assert.deepEqual(JSON.parse(response.result.content[0].text).activated, ['original_3']);
  assert.equal(f.sent.filter(message => message.id === 'reused').length, 1);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
});

test('upstream removal during discovery refresh cannot claim the removed original tool is available', async t => {
  const f = await fixture(t); await list(f);
  const discovery = f.server.receive(call('removed', 'relay_search_tools', { names: ['original_0'] }));
  await tick();
  await list(f, [...tools().slice(1), tool('replacement')]);
  await discovery;
  assert.equal(replyFor(f, 'removed').result.isError, true);
  assert.equal(f.server.toolCatalog.list().some(entry => entry.name === 'original_0'), false);
  assert.equal(f.children[0].sent.some(message => message.method === 'tools/call'), false);
});
