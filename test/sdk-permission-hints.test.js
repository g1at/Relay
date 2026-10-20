'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InteractionBroker } = require('../src/main/tasks/interaction-broker');
const relay = require('../src/main/sdk/claude-sdk');

const suggestions = [{ type: 'addRules', destination: 'userSettings', behavior: 'allow', rules: [{ toolName: 'Bash' }] }];
const context = { conversationId: 'fixture-conversation', runId: 'fixture-run' };
function setup(t, sdkOptions = {}, toolName = 'Bash', relayOptions = {}) {
  const broker = new InteractionBroker({ logger: { warn() {} } });
  t.after(() => broker.close());
  const options = relay._buildOptions({ permissionMode: 'default', ...relayOptions,
    canUseTool: broker.createCanUseTool(context),
  }, {});
  const pending = options.canUseTool(toolName, { command: 'fixture-only' }, {
    toolUseID: 'fixture-tool', ...sdkOptions,
  });
  const dto = broker.list()[0];
  return { broker, pending, dto, id: dto.id };
}

test('SDK permission hints and MCP provenance survive the actual Relay options wrapper and broker DTO', async t => {
  const mcpServer = { name: '<img src=x onerror=alert(1)>', source: 'plugin', arbitrary: 'not for renderer' };
  const h = setup(t, { defaultToNo: true, suppressAlwaysAllowRule: true, mcpServer, suggestions }, 'mcp__relay__write');
  assert.equal(h.dto.permission.defaultToNo, true);
  assert.equal(h.dto.permission.suppressAlwaysAllowRule, true);
  assert.deepEqual(h.dto.permission.mcpServer, { name: mcpServer.name, source: 'plugin' });
  mcpServer.source = 'sdk'; h.dto.permission.mcpServer.source = 'sdk';
  assert.equal(h.broker.get(h.id).permission.mcpServer.source, 'plugin', 'caller and display clones cannot rewrite provenance');
  h.broker.respond(h.id, { action: 'deny' });
  assert.equal((await h.pending).behavior, 'deny');
});

test('suppressed persistent permission grants are rejected by the host even if a renderer fabricates them', async t => {
  const h = setup(t, { suppressAlwaysAllowRule: true, suggestions });
  assert.equal(h.dto.permission.canAllowForSession, false);
  assert.equal(h.dto.permission.canApplySuggestedPermissions, false);
  assert.deepEqual(h.dto.permission.suggestedDestinations, []);
  for (const action of ['allow_session', 'allow_suggested']) {
    assert.throws(() => h.broker.respond(h.id, { action, suppressAlwaysAllowRule: false,
      updatedPermissions: suggestions }), { code: 'PERSISTENT_PERMISSION_SUPPRESSED' });
    assert.equal(h.broker.size, 1, 'invalid answer keeps the original prompt pending');
  }
  h.broker.respond(h.id, { action: 'allow_once', updatedPermissions: suggestions });
  const answer = await h.pending;
  assert.equal(answer.behavior, 'allow');
  assert.equal(answer.decisionClassification, 'user_temporary');
  assert.equal(answer.updatedPermissions, undefined, 'a one-time approval never smuggles in a rule');
});

test('safe-default hints cannot be bypassed by a later conversation-wide mode change', async t => {
  for (const sdkOptions of [{ defaultToNo: true }, { suppressAlwaysAllowRule: true }]) {
    const h = setup(t, sdkOptions);
    assert.equal(h.broker.reconcilePermissionMode({ ...context, permissionMode: 'bypassPermissions' }), 0);
    assert.equal(h.broker.size, 1);
    h.broker.respond(h.id, { action: 'allow_once' });
    assert.equal((await h.pending).behavior, 'allow', 'explicit one-time approval is still supported');
  }
});

test('late SDK callbacks carrying safety hints do not inherit an already acknowledged broader mode', async t => {
  for (const hints of [{ defaultToNo: true }, { suppressAlwaysAllowRule: true }]) {
    const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => broker.close());
    const callback = broker.createCanUseTool({ ...context, permissionReconciliation: {
      ...context, revision: 1, permissionMode: 'bypassPermissions',
    } });
    const pending = callback('Bash', {}, hints);
    assert.equal(broker.size, 1);
    broker.respond(broker.list()[0].id, { action: 'deny' });
    assert.equal((await pending).behavior, 'deny');
  }
});

test('MCP provenance never grants approval or overrides a per-server approval policy', async t => {
  for (const source of ['sdk', 'plugin', 'project', 'future-source']) {
    const h = setup(t, { mcpServer: { name: 'relay', source }, suggestions },
      'mcp__relay__write', { mcpPermissionOverrides: { relay: 'default' } });
    assert.equal(h.broker.size, 1);
    assert.equal(h.broker.reconcilePermissionMode({ ...context, permissionMode: 'bypassPermissions' }), 0);
    assert.throws(() => h.broker.respond(h.id, { action: 'allow_session' }), { code: 'MCP_APPROVAL_REQUIRED' });
    h.broker.respond(h.id, { action: 'deny' });
    assert.equal((await h.pending).behavior, 'deny');
  }
});

test('older SDK callbacks retain ordinary one-time and session permission behavior', async t => {
  const h = setup(t, { suggestions });
  assert.equal(h.dto.permission.defaultToNo, false);
  assert.equal(h.dto.permission.suppressAlwaysAllowRule, false);
  assert.equal(h.dto.permission.mcpServer, null);
  assert.equal(h.dto.permission.canAllowForSession, true);
  h.broker.respond(h.id, { action: 'allow_session' });
  assert.equal((await h.pending).updatedPermissions[0].destination, 'session');
});

test('invalid MCP metadata is discarded rather than exposing arbitrary objects to the renderer', async t => {
  for (const mcpServer of [{ name: 'relay', source: {} }, { name: 'relay\0spoof', source: 'sdk' }, { name: 'x'.repeat(201), source: 'sdk' }]) {
    const h = setup(t, { mcpServer });
    assert.equal(h.dto.permission.mcpServer, null);
    h.broker.respond(h.id, { action: 'deny' }); await h.pending;
  }
});

test('pending and settled request replays preserve one-time restrictions and the original explicit decision', async t => {
  const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => broker.close());
  const sdkOptions = { requestId: 'replayed-permission', toolUseID: 'replayed-tool',
    defaultToNo: true, suppressAlwaysAllowRule: true, suggestions };
  const pending = broker.registerToolUse({ toolName: 'Bash', input: {}, context, sdkOptions });
  const replay = broker.registerToolUse({ toolName: 'Bash', input: {}, context,
    sdkOptions: { requestId: sdkOptions.requestId, toolUseID: sdkOptions.toolUseID } });
  assert.strictEqual(replay, pending, 'a reconnect cannot weaken the original pending hints');
  const dto = JSON.parse(JSON.stringify(broker.list()[0]));
  assert.equal(dto.permission.defaultToNo, true); assert.equal(dto.permission.suppressAlwaysAllowRule, true);
  assert.equal(dto.permission.canAllowForSession, false);
  assert.equal(broker.reconcilePermissionMode({ ...context, permissionMode: 'bypassPermissions' }), 0);
  broker.respond(dto.id, { action: 'allow_once' });
  const result = await pending;
  assert.equal(result.behavior, 'allow'); assert.equal(result.updatedPermissions, undefined);
  const settledReplay = await broker.registerToolUse({ toolName: 'Bash', input: {}, context, sdkOptions });
  assert.strictEqual(settledReplay, result); assert.equal(broker.size, 0);
});
