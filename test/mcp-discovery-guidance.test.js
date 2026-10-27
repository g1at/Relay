'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeMcpServers, createRuntimeMcpMapper, getMcpDiscoveryTools } = require('../src/main/sdk/host-stdio-mcp');
const { exposeHostMcpLoopback, getHostMcpLoopbackOwner } = require('../src/main/sdk/host-mcp-loopback');
const { createMcpDiscoveryHook } = require('../src/main/sdk/mcp-discovery-guidance');

const submit = hook => hook({ hook_event_name: 'UserPromptSubmit', source: 'sdk', prompt: 'Continue the preserved conversation.' });
const contextText = result => result.hookSpecificOutput?.additionalContext || '';

function fixture() {
  let launches = 0;
  return {
    bridges(servers) {
      return bridgeMcpServers(servers, { deferConnect: true, createTransport() {
        launches++;
        throw Error('Discovery guidance must not start an upstream process.');
      } });
    },
    assertIdle(servers) {
      assert.equal(launches, 0);
      for (const config of Object.values(servers)) {
        const instance = getHostMcpLoopbackOwner(config)?.instance || config.instance;
        if (!instance?.connectionState) continue;
        assert.equal(instance.connectionState(), 'deferred');
        assert.equal(instance.childTransport, null);
        assert.equal(instance.pending.size, 0);
      }
    },
  };
}

test('guidance uses only real host-owned discovery entries and keeps server namespaces separate', async t => {
  const f = fixture();
  const bridges = f.bridges({ 'feishu-mcp-pro': { command: 'fixture-never-executed' },
    docs: { command: 'other-fixture-never-executed' }, eager: { command: 'eager-fixture', alwaysLoad: true } });
  t.after(() => Promise.all(Object.values(bridges).map(config => config.instance.close())));
  const servers = { ...bridges, remote: { type: 'http', url: 'https://fixture.invalid/mcp' },
    ordinary: { type: 'sdk', instance: { toolCatalog: { discoveryName: 'spoof', toolPrefix: 'mcp__spoof__' } } },
    raw: { command: 'unprepared-config' }, missing: null };
  const entries = getMcpDiscoveryTools(servers);
  assert.deepEqual(entries.map(entry => entry.server), ['feishu-mcp-pro', 'docs']);
  assert.equal(entries[0].name, 'mcp__feishu-mcp-pro__' + bridges['feishu-mcp-pro'].instance.discoveryName);
  assert.equal(entries[1].name, 'mcp__docs__' + bridges.docs.instance.discoveryName);
  assert.notEqual(entries[0].name, entries[1].name);
  assert.deepEqual(getMcpDiscoveryTools({ 'factory alias': bridges.docs }), [{ server: 'factory alias',
    name: 'mcp__factory_alias__' + bridges.docs.instance.discoveryName }], 'factory alias follows the actual SDK registration namespace');
  const hook = createMcpDiscoveryHook(() => getMcpDiscoveryTools(servers));
  const text = contextText(await submit(hook));
  for (const entry of entries) assert.ok(text.includes(entry.name));
  assert.equal(text.includes('mcp__spoof__'), false);
  assert.equal(text.includes('fixture.invalid'), false);
  assert.equal(text.includes('fixture-never-executed'), false);
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse' }), {});
  f.assertIdle(bridges);
});

test('loopback host registrations retain their actual discovery entry without connecting upstream', async t => {
  const f = fixture(), bridges = f.bridges({ docs: { command: 'loopback-fixture-never-executed' } });
  const config = await exposeHostMcpLoopback('docs', bridges.docs);
  t.after(() => getHostMcpLoopbackOwner(config).close());
  assert.equal(config.type, 'http');
  const entries = getMcpDiscoveryTools({ docs: config });
  assert.deepEqual(entries, getMcpDiscoveryTools(bridges));
  const text = contextText(await submit(createMcpDiscoveryHook(() => entries)));
  assert.ok(text.includes(entries[0].name));
  assert.equal(text.includes(config.headers.Authorization), false);
  assert.equal(text.includes(config.url), false);
  f.assertIdle({ docs: config });
});

test('live mapper guidance follows replacement, rename and removal instead of an initial snapshot', async t => {
  const f = fixture(), first = f.bridges({ docs: { command: 'first-fixture' } });
  const mapper = createRuntimeMcpMapper(first, servers => servers);
  t.after(() => mapper.close());
  const hook = createMcpDiscoveryHook(() => mapper.discoveryTools());
  const original = mapper.discoveryTools()[0].name;
  assert.ok(contextText(await submit(hook)).includes(original));
  const replacement = f.bridges({ docs: { command: 'replacement-fixture' } });
  await mapper.applyServers(async () => {}, replacement);
  assert.equal(mapper.discoveryTools()[0].name, original, 'recreated same-named bridge has a stable discovery entry');
  const renamed = f.bridges({ renamed: { command: 'renamed-fixture' } });
  await mapper.applyServers(async () => {}, renamed);
  const current = mapper.discoveryTools()[0].name;
  assert.notEqual(current, original);
  const changed = contextText(await submit(hook));
  assert.ok(changed.includes(current));
  assert.equal(changed.includes(original), false);
  f.assertIdle(renamed);
  await mapper.applyServers(async () => {}, {});
  assert.deepEqual(await submit(hook), {});
  await mapper.close();
  assert.deepEqual(mapper.discoveryTools(), []);
});

test('an initially empty mapper can publish a later host discovery entry without loading business schemas', async t => {
  const f = fixture(), mapper = createRuntimeMcpMapper({}, servers => servers);
  t.after(() => mapper.close());
  const hook = createMcpDiscoveryHook(() => mapper.discoveryTools());
  assert.deepEqual(await submit(hook), {});
  const added = f.bridges({ docs: { command: 'late-fixture' } });
  await mapper.applyServers(async () => {}, added);
  const text = contextText(await submit(hook));
  assert.ok(text.includes(mapper.discoveryTools()[0].name));
  assert.deepEqual(added.docs.instance.toolCatalog.list().map(tool => tool.name), [added.docs.instance.discoveryName]);
  f.assertIdle(added);
});
