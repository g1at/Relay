'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeMcpServers, createRuntimeMcpMapper, HostStdioMcpServer } = require('../src/main/sdk/host-stdio-mcp');
const { getHostMcpLoopbackOwner: owner } = require('../src/main/sdk/host-mcp-loopback');
const { createAgentEnvironment } = require('../src/main/sdk/agent-environment');

test('runtime only decorates owned SDK connections and leaves policy failures authoritative', async t => {
  const initial = bridgeMcpServers({ docs: { command: 'fixture-only' } }, { deferConnect: true });
  const instance = initial.docs.instance;
  const mapper = createRuntimeMcpMapper(initial, servers => bridgeMcpServers(servers, { deferConnect: true }));
  t.after(() => mapper.close());
  assert.ok(instance instanceof HostStdioMcpServer);
  for (const state of ['deferred', 'pending', 'connected', 'failed']) {
    instance.connectionState = () => state;
    const input = [{ name: 'docs', source: 'sdk', status: 'connected' }, { name: 'docs', source: 'plugin', status: 'connected' },
      ...['disabled', 'needs-auth', 'failed', 'pending'].map(status => ({ name: 'docs', source: 'sdk', status })),
      { name: 'other', source: 'sdk', status: 'connected' }];
    const output = mapper.decorateStatus(input);
    assert.equal(output[0].status, state); assert.equal(input[0].status, 'connected');
    for (let i = 1; i < input.length; i++) assert.equal(output[i], input[i]);
  }
  assert.equal(mapper.decorateStatus(undefined), undefined);
});

test('explicit connection follows the applied instance after replacement and removal', async t => {
  const initial = bridgeMcpServers({ docs: { command: 'fixture-only' } }, { deferConnect: true });
  const old = initial.docs.instance; let oldCalls = 0, newCalls = 0;
  const status = async () => [{ name: 'docs', source: 'sdk', status: 'connected' }];
  old.connectUpstream = async () => { oldCalls++; };
  const mapper = createRuntimeMcpMapper(initial, value => value);
  t.after(() => mapper.close());
  await mapper.connectUpstream('docs', status); assert.equal(oldCalls, 1);
  const next = bridgeMcpServers({ docs: { command: 'new-fixture-only' } }, { deferConnect: true });
  next.docs.instance.connectUpstream = async () => { newCalls++; };
  const applies = [];
  await mapper.applyServers(async value => { applies.push(value); }, next);
  assert.equal(applies.length, 2); assert.equal(applies[0].docs, undefined);
  await mapper.connectUpstream('docs', status); assert.equal(oldCalls, 1); assert.equal(newCalls, 1);
  await mapper.applyServers(async () => {}, {});
  await mapper.connectUpstream('docs', status); assert.equal(newCalls, 1);
});

test('native environment defaults to on-demand, honors alwaysLoad, and preserves session isolation', async t => {
  const env = createAgentEnvironment({ getEnvironment: () => 'native' });
  const input = { mcpServers: { docs: { command: 'fixture-only' }, eager: { command: 'fixture-only', alwaysLoad: true } } };
  const first = await env.prepareOptions(input), second = await env.prepareOptions(input);
  t.after(async () => { for (const item of [first, second]) for (const cfg of Object.values(item.mcpServers)) await owner(cfg).close(); });
  assert.equal(owner(first.mcpServers.docs).instance.connectionState(), 'deferred');
  assert.equal(owner(first.mcpServers.eager).instance.connectionState, undefined);
  assert.equal(first.mcpServers.eager.alwaysLoad, true);
  assert.equal(first.mcpServers.docs.type, 'http');
  assert.notEqual(owner(first.mcpServers.docs).instance, owner(second.mcpServers.docs).instance);
  const reused = await env.prepareMcpServers(input.mcpServers, { environment: 'native', prepared: first });
  assert.equal(owner(reused.docs).instance, owner(first.mcpServers.docs).instance);
  const eagerEnv = createAgentEnvironment({ getEnvironment: () => 'native', deferMcpConnections: false });
  const eager = await eagerEnv.prepareOptions(input);
  t.after(async () => { for (const cfg of Object.values(eager.mcpServers)) await owner(cfg).close(); });
  assert.equal(owner(eager.mcpServers.docs).instance.connectionState, undefined);
});


test('void reconnect acknowledgement cannot bypass SDK source or administrative policy', async t => {
  const initial = bridgeMcpServers({ docs: { command: 'fixture-only' } }, { deferConnect: true });
  let connects = 0; initial.docs.instance.connectUpstream = async () => { connects++; };
  const mapper = createRuntimeMcpMapper(initial, value => value); t.after(() => mapper.close());
  for (const row of [{ name: 'docs', source: 'plugin', status: 'connected' },
    ...['disabled', 'needs-auth', 'failed', 'pending'].map(status => ({ name: 'docs', source: 'sdk', status })),
    { name: 'other', source: 'sdk', status: 'connected' }]) {
    await assert.rejects(mapper.connectUpstream('docs', async () => [row]), /REGISTRATION_NOT_READY/);
  }
  assert.equal(connects, 0);
  let release; const ready = new Promise(resolve => { release = resolve; });
  const oldRequest = mapper.connectUpstream('docs', () => ready);
  await mapper.applyServers(async () => {}, {});
  release([{ name: 'docs', source: 'sdk', status: 'connected' }]);
  await assert.rejects(oldRequest, /REGISTRATION_NOT_READY/); assert.equal(connects, 0);
});
