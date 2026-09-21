'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { McpPermissionOverrides, createMcpPermissions, requiresMcpApproval, mcpApprovalHook } = require('../sdk-mcp-permissions');
const { InteractionBroker } = require('../interaction-broker');
const relay = require('../claude-sdk');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function liveFixture({ onOverride = async () => {} } = {}) {
  const calls = [], inputs = [], received = deferred();
  let servers = {};
  const fakeSdk = { query({ prompt, options }) {
    servers = options.mcpServers || {};
    return {
      initializationResult: async () => ({}),
      setMcpPermissionModeOverride: async (name, mode) => { calls.push(['permission', name, mode]); await onOverride(name, mode); return {}; },
      setMcpServers: async next => { servers = next; calls.push(['servers', ...Object.keys(next)]); return {}; },
      mcpServerStatus: async () => Object.keys(servers).map(name => ({ name, status: 'connected', tools: [] })),
      reconnectMcpServer: async name => { calls.push(['reconnect', name]); }, toggleMcpServer: async () => {},
      reloadPlugins: async () => { calls.push(['plugins']); return {}; },
      async *[Symbol.asyncIterator]() { for await (const input of prompt) { inputs.push(input); received.resolve(); yield { type: 'result', subtype: 'success', result: 'fixture', user_message_uuid: input.uuid }; } },
    };
  } };
  const filename = path.join(__dirname, '../claude-sdk.js');
  const source = fs.readFileSync(filename, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fakeSdk);');
  const context = vm.createContext({ fakeSdk, process, console: { error() {}, warn() {} }, AbortController, setTimeout, clearTimeout });
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports,__dirname){${source}\n})`, { filename }).runInContext(context)(createRequire(filename), loaded, loaded.exports, path.dirname(filename));
  return { calls, inputs, received: received.promise, create: params => loaded.exports.createLiveSession({ onMessage() {}, onExit() {}, ...params }) };
}

test('per-server overrides accept tightening or clear only and warn without discarding not-yet-connected names', async () => {
  const calls = [], state = new McpPermissionOverrides({ guarded: 'default', ignored: 'bypassPermissions' });
  const query = { setMcpPermissionModeOverride: async (name, mode) => { calls.push([name, mode]); return { warning: 'internal path and secret must not be displayed' }; } };
  assert.deepEqual(state.snapshot(), { guarded: 'default' });
  assert.deepEqual((await state.apply(query)).warnings, [{ name: 'guarded', code: 'MCP_NOT_CONNECTED' }]);
  await state.apply(query); assert.equal(calls.length, 1);
  state.set('guarded', null); await state.apply(query);
  assert.deepEqual(calls, [['guarded', 'default'], ['guarded', null]]);
  for (const mode of ['auto', 'bypassPermissions', 'acceptEdits', 'deny', undefined]) assert.throws(() => state.set('guarded', mode));
});

test('renamed and deleted servers clear old overrides and reapply after a dynamic registry refresh', async () => {
  const calls = [], state = new McpPermissionOverrides({ old: 'default' });
  const query = { setMcpPermissionModeOverride: async (...args) => { calls.push(args); return {}; } };
  await state.apply(query); state.replace({ renamed: 'default' }); await state.apply(query, { names: ['renamed', 'ordinary'], force: true });
  assert.deepEqual(calls.slice(1), [['renamed', 'default'], ['ordinary', null], ['old', null]]);
  state.replace({}); await state.apply(query);
  assert.deepEqual(calls.at(-1), ['renamed', null]);
  const resumed = new McpPermissionOverrides({}); await resumed.apply(query, { names: ['ordinary'] });
  assert.deepEqual(calls.at(-1), ['ordinary', null]);
  await assert.rejects(new McpPermissionOverrides({ required: 'default' }).apply({}), { code: 'MCP_PERMISSION_UNSUPPORTED' });
});

test('the public approval hook preserves unrelated tools and only asks for the exact configured MCP', async () => {
  let policy = { guarded: 'default' };
  const hook = mcpApprovalHook(() => policy);
  assert.equal((await hook({ tool_name: 'mcp__guarded__write' })).hookSpecificOutput.permissionDecision, 'ask');
  for (const name of ['Write', 'mcp__guarded_other__write', 'mcp__other__write']) assert.deepEqual(await hook({ tool_name: name }), {});
  policy = {}; assert.deepEqual(await hook({ tool_name: 'mcp__guarded__write' }), {});
  assert.equal(requiresMcpApproval('mcp__guarded_server__write', { 'guarded server': 'default' }), true);
});

test('MCP approvals cannot be auto-settled by session bypass or saved as a permanent allow', async t => {
  const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => broker.close());
  const context = { conversationId: 'conv', runId: 'run', permissionReconciliation: {
    conversationId: 'conv', runId: 'run', revision: 3, permissionMode: 'bypassPermissions',
  } };
  const answer = broker.registerToolUse({ toolName: 'mcp__guarded__write', input: {}, context,
    sdkOptions: { relayMcpApprovalRequired: true, suggestions: [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'mcp__guarded__write' }] }] } });
  assert.equal(broker.size, 1);
  assert.equal(broker.reconcilePermissionMode(context.permissionReconciliation), 0);
  const id = broker.list()[0].id;
  assert.throws(() => broker.respond(id, { action: 'allow_session' }), { code: 'MCP_APPROVAL_REQUIRED' });
  broker.respond(id, { action: 'allow_once' }); assert.equal((await answer).behavior, 'allow');
});

test('a policy tightened after a request parked blocks mode reconciliation as well', async t => {
  const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => broker.close());
  let policy = {};
  const answer = broker.registerToolUse({ toolName: 'mcp__guarded__write', input: {}, context: { conversationId: 'conv', runId: 'run' },
    sdkOptions: { relayMcpPermissionOverrides: () => policy } });
  policy = { guarded: 'default' };
  assert.equal(broker.reconcilePermissionMode({ conversationId: 'conv', runId: 'run', permissionMode: 'bypassPermissions' }), 0);
  broker.respond(broker.list()[0].id, { action: 'deny' }); assert.equal((await answer).behavior, 'deny');
});

test('SDK options use public hooks and attach only host-private context to the existing permission broker', async () => {
  let captured;
  const opts = relay._buildOptions({ model: 'fixture', permissionMode: 'acceptEdits', mcpPermissionOverrides: { guarded: 'default' },
    canUseTool: async (_name, _input, options) => { captured = options; return { behavior: 'deny' }; },
  }, {});
  assert.equal(opts.mcpPermissionOverrides, undefined);
  assert.equal(opts.permissionMode, 'acceptEdits');
  const result = await opts.hooks.PreToolUse.at(-1).hooks[0]({ tool_name: 'mcp__guarded__write' });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'ask');
  await opts.canUseTool('mcp__guarded__write', {}, { toolUseID: 'id' });
  assert.equal(captured.relayMcpApprovalRequired, true); assert.equal(captured.toolUseID, 'id');
});

test('host settings survive disabled servers, explicitly transfer renames and remove deleted identities', async () => {
  let settings = { unrelated: true }, names = ['old', 'disabled'], calls = [];
  const service = createMcpPermissions({ readSettings: () => settings, writeSettings: next => { settings = next; }, readServers: () => names,
    listSessions: () => [{ child: { toggleMcpServer: async () => {}, syncMcpPermissionOverrides: async next => { calls.push(next); return { warnings: [] }; } } }] });
  await service.set({ name: 'old', mode: 'default' }); await service.set({ name: 'disabled', mode: 'default' });
  names = ['new', 'disabled']; await service.reconcileRegistry({ renames: { old: 'new' } });
  assert.deepEqual(service.overrides(), { disabled: 'default', new: 'default' });
  names = ['disabled']; await service.reconcileRegistry();
  assert.deepEqual(service.overrides(), { disabled: 'default' });
  assert.equal(settings.unrelated, true); assert.equal(calls.length, 4);
  await assert.rejects(service.set({ name: 'old', mode: 'default' }), { code: 'MCP_NOT_FOUND' });
});

test('tightening reaches every active controller without waiting behind a slow acknowledgement', async () => {
  let settings = {}, release;
  const started = [], pending = new Promise(resolve => { release = resolve; });
  const service = createMcpPermissions({ readSettings: () => settings, writeSettings: next => { settings = next; }, readServers: () => ['guarded'],
    listSessions: () => [0, 1].map(index => ({ child: { syncMcpPermissionOverrides: async () => { started.push(index); if (!index) await pending; return {}; } } })) });
  const update = service.set({ name: 'guarded', mode: 'default' });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.deepEqual(started, [0, 1]); } finally { release(); }
  assert.equal((await update).ok, true);
});

test('a failed runtime tightening stops the unsafe old query while persisting policy for a fresh session', async () => {
  let settings = {}, stopped = 0;
  const service = createMcpPermissions({ readSettings: () => settings, writeSettings: next => { settings = next; }, readServers: () => ['guarded'],
    listSessions: () => [{ child: { syncMcpPermissionOverrides: async () => { throw Error('unsupported method'); } } }], stopSession: async () => { stopped++; } });
  const result = await service.set({ name: 'guarded', mode: 'default' });
  assert.equal(result.ok, false); assert.equal(stopped, 1); assert.deepEqual(service.overrides(), { guarded: 'default' });
  assert.equal(JSON.stringify(result).includes('unsupported method'), false);
  await service.set({ name: 'guarded', mode: null }); assert.equal(stopped, 1);
});

test('a real Relay live adapter waits for native MCP permission acknowledgement before its first input', async t => {
  const started = deferred(), release = deferred();
  const fixture = liveFixture({ onOverride: async (_name, mode) => { if (mode === 'default') { started.resolve(); await release.promise; } } });
  const session = fixture.create({ mcpPermissionOverrides: { guarded: 'default' } });
  t.after(() => { release.resolve(); return session.kill(); });
  session.push('isolated fixture', { uuid: 'run' });
  await started.promise; assert.equal(fixture.inputs.length, 0);
  release.resolve(); await fixture.received;
  assert.equal(fixture.inputs.length, 1);
  assert.deepEqual(fixture.calls[0], ['permission', 'guarded', 'default']);
});

test('the live adapter replays tightening after reconnecting registry changes and plugin refresh, clearing stale restored names', async t => {
  const fixture = liveFixture();
  const session = fixture.create({ sessionId: 'restored-fixture', mcpServers: { ordinary: { type: 'http', url: 'http://fixture.invalid' } } });
  t.after(() => session.kill()); await session.whenReady({ timeoutMs: 2000 });
  assert.deepEqual(fixture.calls[0], ['permission', 'ordinary', null]);
  await session.setMcpPermissionModeOverride('renamed', 'default');
  await session.setMcpServers({ renamed: { type: 'http', url: 'http://fixture.invalid' } });
  const syncIndex = fixture.calls.findIndex(item => item[0] === 'servers');
  assert.ok(fixture.calls.slice(0, syncIndex).some(item => item[1] === 'renamed' && item[2] === 'default'));
  assert.ok(fixture.calls.slice(syncIndex + 1).some(item => item[1] === 'renamed' && item[2] === 'default'));
  await session.reconnectMcpServer('renamed');
  const reconnectIndex = fixture.calls.findIndex(item => item[0] === 'reconnect');
  assert.ok(fixture.calls.slice(reconnectIndex + 1).some(item => item[1] === 'renamed' && item[2] === 'default'));
  await session.reloadPlugins();
  const pluginIndex = fixture.calls.findIndex(item => item[0] === 'plugins');
  assert.ok(fixture.calls.slice(pluginIndex + 1).some(item => item[1] === 'renamed' && item[2] === 'default'));
  await session.syncMcpPermissionOverrides({});
  assert.deepEqual(fixture.calls.at(-1), ['permission', 'renamed', null]);
});
