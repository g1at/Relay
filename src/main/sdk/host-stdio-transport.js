'use strict';

// Local MCPs are owned by this Query, even when the SDK talks to a host
// loopback bridge. Give each Windows stdio root its own pre-created Job so
// stopping one conversation cannot terminate another server or miss orphans.
function createHostStdioTransport(params) {
  const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
  if (process.platform !== 'win32') return new StdioClientTransport(params);
  const { prepareManagedProcessLaunch } = require('./sdk-process-tree');
  const { SdkProcessSupervisor } = require('./sdk-process-supervisor');
  // Preserve the MCP SDK's command resolution, environment, shebang and npm
  // cmd-shim semantics before inserting the Job launcher into the spawn path.
  const env = { ...getDefaultEnvironment(), ...(params.env || {}) };
  const dependencyRequire = require('node:module').createRequire(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const parse = dependencyRequire('cross-spawn')._parse;
  if (typeof parse !== 'function') throw Object.assign(new Error('MCP spawn adapter is unavailable'), { code: 'MCP_SPAWN_ADAPTER_UNAVAILABLE' });
  const parsed = parse(params.command, params.args || [], { env, cwd: params.cwd });
  const launch = prepareManagedProcessLaunch(parsed.command, parsed.args, parsed.options);
  let transport;
  try {
    transport = new StdioClientTransport({ ...params, command: launch.command, args: launch.args,
      env: launch.options.env, cwd: launch.options.cwd });
  } catch (error) { launch.disposeUnspawned(); throw error; }
  const start = transport.start.bind(transport), close = transport.close.bind(transport);
  const supervisor = new SdkProcessSupervisor();
  let child = null, started = false, closed = false, closing = null, ownershipError = null;
  Object.defineProperties(transport, {
    pid: { get: () => child?.sdkPid || null },
    relayProcessTree: { get: () => child?.relayProcessTree || null },
  });
  transport.start = () => {
    if (closed) return Promise.reject(new Error('MCP_HOST_CLOSED'));
    if (started) return Promise.reject(new Error('MCP_HOST_ALREADY_STARTED'));
    started = true;
    let pending;
    try {
      // MCP SDK starts synchronously before returning its promise. Capture its
      // actual ChildProcess immediately; assigning only after spawn would race
      // an MCP that launches detached descendants during initialization.
      pending = start();
      child = transport._process;
      if (!child) throw new Error('MCP_PROCESS_OWNERSHIP_UNAVAILABLE');
      launch.attach(child);
      supervisor.attach(child);
      supervisor.markSpawnSettled();
    } catch (error) {
      ownershipError = error;
      launch.cancel();
      // A missing private process handle is an unconfirmed launch, never a
      // receipt permitting directory cleanup. Keep ownership for process exit.
      Promise.resolve(pending).catch(() => {});
      return Promise.reject(error);
    }
    return Promise.resolve(pending);
  };
  transport.close = () => {
    if (closing) return closing;
    closed = true;
    if (!started) { launch.disposeUnspawned(); return Promise.resolve(); }
    if (ownershipError) return Promise.reject(ownershipError);
    const operation = (async () => {
      const stopped = supervisor.stop();
      await close();
      const receipt = await stopped;
      if (receipt?.stopConfirmed !== true || receipt.activeProcesses !== 0 || receipt.pendingExits !== 0
        || receipt.scopeId !== child.relayProcessTree.scopeId) throw new Error('MCP_PROCESS_TREE_UNCONFIRMED');
      return receipt;
    })();
    closing = operation;
    operation.catch(() => { if (closing === operation) closing = null; });
    return operation;
  };
  return transport;
}

module.exports = { createHostStdioTransport };
