'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const file = path.join(__dirname, '../src/main/sdk/host-stdio-transport.js');
const source = fs.readFileSync(file, 'utf8');
function fixture({ parseMissing = false, missingProcess = false, constructorFailure = false } = {}) {
  const calls = { prepared: 0, spawned: 0, disposed: 0, canceled: 0, attached: 0, closed: 0 };
  const module = { exports: {} }, dependencyPath = '/fixture/mcp-sdk/client/stdio.js';
  const child = { sdkPid: 21, relayProcessTree: { scopeId: 'fixture-job' } };
  class Transport {
    constructor() { if (constructorFailure) throw Error('synthetic constructor failure'); }
    start() { calls.spawned++; if (!missingProcess) this._process = child; return Promise.resolve(); }
    close() { calls.closed++; return Promise.resolve(); }
  }
  const descriptor = { command: 'fixture-launcher', args: [], options: {},
    attach(value) { assert.equal(value, child); calls.attached++; },
    cancel() { calls.canceled++; }, disposeUnspawned() { calls.disposed++; },
  };
  class Supervisor {
    attach(value) { assert.equal(value, child); }
    markSpawnSettled() {}
    stop() { return Promise.resolve({ stopConfirmed: true, scopeId: 'fixture-job', activeProcesses: 0, pendingExits: 0 }); }
  }
  const localRequire = id => {
    if (id === '@modelcontextprotocol/sdk/client/stdio.js') return { StdioClientTransport: Transport, getDefaultEnvironment: () => ({ PATH: 'fixture' }) };
    if (id === 'node:module') return { createRequire(location) {
      assert.equal(location, dependencyPath);
      return dependency => { assert.equal(dependency, 'cross-spawn'); return parseMissing ? {} : { _parse: (command, args, options) => ({ command, args, options }) }; };
    } };
    if (id === './sdk-process-tree') return { prepareManagedProcessLaunch() { calls.prepared++; return descriptor; } };
    if (id === './sdk-process-supervisor') return { SdkProcessSupervisor: Supervisor };
    throw Error('Unexpected or undeclared dependency: ' + id);
  };
  localRequire.resolve = id => { assert.equal(id, '@modelcontextprotocol/sdk/client/stdio.js'); return dependencyPath; };
  vm.runInNewContext(`(function(require,module){${source}\n})`, { process: { platform: 'win32' } }, { filename: file })(localRequire, module);
  return { create: () => module.exports.createHostStdioTransport({ command: 'fixture-mcp', args: [] }), calls };
}
test('host adapter resolves cross-spawn from the MCP SDK dependency scope and closes only its Job', async () => {
  const f = fixture(), transport = f.create();
  await transport.start(); await transport.close();
  assert.equal(transport.pid, 21); assert.equal(f.calls.prepared, 1); assert.equal(f.calls.attached, 1); assert.equal(f.calls.closed, 1);
});
test('missing command parser fails before any Job or process is created', () => {
  const f = fixture({ parseMissing: true });
  assert.throws(f.create, error => error.code === 'MCP_SPAWN_ADAPTER_UNAVAILABLE');
  assert.equal(f.calls.prepared, 0); assert.equal(f.calls.spawned, 0);
});
test('missing SDK process handle cancels its Job and never confirms a successful close', async () => {
  const f = fixture({ missingProcess: true }), transport = f.create();
  await assert.rejects(transport.start(), /MCP_PROCESS_OWNERSHIP_UNAVAILABLE/);
  await assert.rejects(transport.close(), /MCP_PROCESS_OWNERSHIP_UNAVAILABLE/);
  assert.equal(f.calls.canceled, 1); assert.equal(f.calls.disposed, 0);
});
test('close before start disposes only an unspawned Job and prevents later spawn', async () => {
  const f = fixture(), transport = f.create();
  await transport.close(); await assert.rejects(transport.start(), /MCP_HOST_CLOSED/);
  assert.equal(f.calls.disposed, 1); assert.equal(f.calls.spawned, 0);
});
test('transport construction failure releases its unspawned Job', () => {
  const f = fixture({ constructorFailure: true });
  assert.throws(f.create, /synthetic constructor failure/);
  assert.equal(f.calls.disposed, 1); assert.equal(f.calls.spawned, 0);
});
