'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { createMcpPermissions } = require('../src/main/sdk/sdk-mcp-permissions');
const main = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-host-')), file = path.join(dir, 'claude.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = { otherSetting: 'preserved' };
  const handlers = new Map(), calls = [], jobs = new Map(), liveSessions = new Map();
  const registry = { mcpServers: { guarded: { type: 'http', url: 'https://fixture.invalid' } }, mcpServersDisabled: { disabled: { command: 'fixture-disabled' } } };
  const saveRegistry = next => fs.writeFileSync(file, JSON.stringify(next)); saveRegistry(registry);
  const context = vm.createContext({ fs, path, crypto, Buffer, createMcpPermissions, setTimeout, clearTimeout,
    console: { warn() {} }, liveSessions, jobs, claudeJsonPath: () => file,
    readAppSettings: () => settings, writeAppSettings: next => { settings = structuredClone(next); calls.push(['saved']); },
    permissionCaller: event => event?.trusted === true,
    interactionBroker: { rejectTask: id => { calls.push(['reject', id]); } },
    killLiveSession: async session => { calls.push(['stop-live', session.convId]); session.dead = true; await session.child.kill?.(); },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  });
  const start = main.indexOf("const MCP_DISABLED_KEY ="), end = main.indexOf("\nipcMain.handle('data:listAgents'", start);
  assert.ok(start > 0 && end > start);
  new vm.Script(main.slice(start, end)).runInContext(context);
  const addLive = () => {
    const child = { syncMcpPermissionOverrides: async value => { calls.push(['permissions', structuredClone(value)]); return { warnings: [] }; },
      toggleMcpServer: async (name, enabled) => { calls.push(['toggle', name, enabled]); },
      setMcpServers: async value => { calls.push(['servers', Object.keys(value)]); return {}; },
      mcpServerStatus: async () => [], kill: async () => {} };
    const session = { convId: 'conversation', jobId: 'run-live', busy: false, child };
    liveSessions.set(session.convId, session); return session;
  };
  return { context, calls, registry, saveRegistry, addLive, jobs, liveSessions, settings: () => settings,
    invoke: (name, input, event = { trusted: true }) => handlers.get(name)(event, input) };
}

test('the production MCP IPC validates callers and persists tightening for enabled and disabled entries', async t => {
  const h = fixture(t), live = h.addLive(); live.busy = true;
  assert.equal((await h.invoke('mcp:permission:set', { name: 'guarded', mode: 'default' }, {})).code, 'FORBIDDEN');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.invoke('mcp:permission:set', { name: 'guarded', mode: 'bypassPermissions' })).code, 'INVALID_MCP_PERMISSION');
  assert.equal((await h.invoke('mcp:permission:set', { name: 'missing', mode: 'default' })).code, 'MCP_NOT_FOUND');
  assert.equal((await h.invoke('mcp:permission:set', { name: 'disabled', mode: 'default' })).ok, true);
  assert.equal(h.settings().mcpPermissionOverrides.disabled, 'default'); assert.equal(h.settings().otherSetting, 'preserved');
  assert.equal(h.calls[0][0], 'saved'); assert.equal(h.calls[1][0], 'permissions');
  const list = await h.invoke('mcp:list');
  assert.equal(list.items.find(item => item.name === 'disabled').permissionModeOverride, 'default');
  assert.equal(list.items.find(item => item.name === 'guarded').permissionModeOverride, null);
});

test('production tightening updates live Queries and safely stops an active one-shot job lacking runtime control', async t => {
  const h = fixture(t); h.addLive();
  h.jobs.set('run-once', { kill: async () => { h.calls.push(['stop-one-shot']); } });
  const result = await h.invoke('mcp:permission:set', { name: 'guarded', mode: 'default' });
  assert.equal(result.ok, false); assert.equal(result.items.find(item => item.name === 'guarded').mode, 'default');
  assert.ok(h.calls.some(item => item[0] === 'permissions'));
  assert.ok(h.calls.some(item => item[0] === 'reject' && item[1] === 'run-once'));
  assert.ok(h.calls.some(item => item[0] === 'stop-one-shot'));
  const count = h.calls.length;
  await h.invoke('mcp:permission:set', { name: 'guarded', mode: 'default' });
  assert.equal(h.calls.length, count, 'an unchanged policy does not restart already-protected tasks');
});

test('production registry sync carries a unique exact rename, and delete disables before clearing the old approval', async t => {
  const h = fixture(t); h.addLive();
  await h.invoke('mcp:permission:set', { name: 'guarded', mode: 'default' });
  h.registry.mcpServers.renamed = h.registry.mcpServers.guarded; delete h.registry.mcpServers.guarded; h.saveRegistry(h.registry);
  assert.equal((await h.invoke('mcp:sync', { convId: 'conversation' })).ok, true);
  assert.deepEqual(h.settings().mcpPermissionOverrides, { renamed: 'default' });
  const start = h.calls.length;
  assert.equal((await h.invoke('mcp:delete', { name: 'renamed', convId: 'conversation' })).ok, true);
  assert.deepEqual(h.settings().mcpPermissionOverrides, {});
  const changes = h.calls.slice(start), toggle = changes.findIndex(item => item[0] === 'toggle' && item[1] === 'renamed');
  const clear = changes.findIndex(item => item[0] === 'permissions');
  assert.ok(toggle >= 0 && clear > toggle, 'a deleted guarded server is disabled before clearing its override');
});

test('MCP preload, production row UI and launch parameters share the implemented approval contract', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(preload, /setPermission:\s*\(name, mode\)\s*=> ipcRenderer\.invoke\('mcp:permission:set', \{ name, mode \}\)/);
  assert.match(ui, /RelayMcpPermissionControls\.create\(\{/); assert.match(ui, /mode: it\.permissionModeOverride/);
  assert.match(html, /src="mcp-permission-controls.js"/); assert.match(html, /href="mcp-permission-controls.css"/);
  const options = main.slice(main.indexOf('function buildSdkParams('), main.indexOf('function runRelayText('));
  assert.match(options, /mcpPermissionOverrides:.*readAppSettings\(\)\.mcpPermissionOverrides/);
});
