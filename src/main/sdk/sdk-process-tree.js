'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function nativePath(name) {
  return path.join(__dirname, 'native', name).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
let binding;
function loadBinding() {
  if (process.arch !== 'x64') throw Object.assign(Error('当前 Windows 架构缺少会话进程树组件'), { code: 'SDK_PROCESS_TREE_UNAVAILABLE' });
  const library = nativePath('win32-x64.node'), launcher = nativePath('sdk-job-launcher-win32-x64.exe');
  if (!fs.existsSync(library) || !fs.existsSync(launcher))
    throw Object.assign(Error('会话进程树组件缺失，请修复 Relay 安装'), { code: 'SDK_PROCESS_TREE_UNAVAILABLE' });
  try { binding ||= require(library); }
  catch (cause) { throw Object.assign(Error('无法加载会话进程树组件', { cause }), { code: 'SDK_PROCESS_TREE_UNAVAILABLE' }); }
  return { native: binding, launcher };
}

// Windows owns a kernel Job handle from before the SDK runs until every child
// has exited. No process-name matching, PID-based termination, shell commands,
// external runtime, or per-spawn build is used.
function prepareManagedProcessLaunch(command, args = [], options = {}) {
  if (process.platform !== 'win32') return { command, args, options, attach: child => child,
    cancel() {}, disposeUnspawned() {} };
  if (options.shell) throw Object.assign(Error('Managed SDK launches cannot use shell expansion'), { code: 'SDK_PROCESS_TREE_UNSUPPORTED' });
  if (options.signal?.aborted) throw Object.assign(Error('SDK launch canceled'), { code: 'ABORT_ERR' });
  const { native, launcher } = loadBinding();
  const scopeId = 'Local\\Relay-SDK-' + randomUUID(), scope = native.create(scopeId);
  let child, closed = false, lastSnapshot = null, rootExited = false, confirming = null;
  const snapshot = () => {
    if (closed) return lastSnapshot;
    return lastSnapshot = native.snapshot(scope);
  };
  const tree = {
    scopeId,
    snapshot,
    stop() {
      if (closed) return true;
      return native.terminate(scope);
    },
    // Caller must first observe launcher exit: an empty Job during suspended
    // launch is not proof that no future process can start.
    confirmStopped({ timeoutMs = 1000 } = {}) {
      if (!rootExited) return Promise.resolve({ stopConfirmed: false, processTree: true, scopeId, reason: 'launcher-running' });
      if (closed) return Promise.resolve({ ...lastSnapshot, processTree: true, scopeId, stopConfirmed: lastSnapshot?.activeProcesses === 0 && lastSnapshot?.pendingExits === 0 });
      if (confirming) return confirming;
      confirming = (async () => {
        tree.stop();
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const state = snapshot();
          if (state.activeProcesses === 0 && state.pendingExits === 0) return { ...state, processTree: true, scopeId, stopConfirmed: true };
          if (Date.now() >= deadline) return { ...state, processTree: true, scopeId, stopConfirmed: false, reason: 'descendants-running' };
          await delay(20);
        }
      })().finally(() => { confirming = null; });
      return confirming;
    },
    closeConfirmed() {
      if (closed) return;
      const state = snapshot();
      if (!rootExited || state.activeProcesses !== 0 || state.pendingExits !== 0) throw Object.assign(Error('Cannot release an unconfirmed SDK Job'), { code: 'SDK_PROCESS_TREE_UNCONFIRMED' });
      native.close(scope); closed = true;
    },
  };
  const { signal, windowsVerbatimArguments, ...spawnOptions } = options;
  const launch = {
    command: launcher,
    args: [scopeId, ...(windowsVerbatimArguments ? ['--relay-verbatim'] : []), command, ...args],
    options: { ...spawnOptions, shell: false, windowsHide: true, windowsVerbatimArguments: false },
    cancel() { return tree.stop(); },
    disposeUnspawned() {
      if (child) throw Error('Spawned SDK Job must be stopped and confirmed before disposal');
      if (!closed) { native.close(scope); closed = true; }
    },
    attach(spawned) {
      if (child === spawned) return child;
      if (child || closed) throw Error('SDK Job launch has already been consumed');
      if (!spawned || typeof spawned.once !== 'function') throw TypeError('A spawned process is required');
      child = spawned;
      rootExited = child.exitCode != null || child.signalCode != null;
      Object.defineProperties(child, {
        relayHostPid: { value: child.pid },
        sdkPid: { get() { try { return snapshot()?.sdkPid || null; } catch (_) { return null; } } },
        relayProcessTree: { value: tree },
      });
      // Do not let AbortSignal / SDK kill() terminate only the launcher. Marking
      // canceled also prevents a not-yet-assigned suspended SDK from later running.
      child.kill = () => {
        if (closed) return false;
        const accepted = tree.stop();
        if (accepted) child.killed = true;
        return accepted;
      };
      const abort = () => { try { child.kill('SIGKILL'); } catch (error) { queueMicrotask(() => child.emit('error', error)); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      child.once('exit', () => { rootExited = true; signal?.removeEventListener('abort', abort); });
      child.once('error', () => {
        if (!child.pid) { rootExited = true; signal?.removeEventListener('abort', abort); }
      });
      return child;
    },
  };
  return launch;
}

function spawnManagedSdkProcess(command, args = [], options = {}) {
  const launch = prepareManagedProcessLaunch(command, args, options);
  let child;
  try { child = spawn(launch.command, launch.args, launch.options); }
  catch (error) { launch.disposeUnspawned(); throw error; }
  try { return launch.attach(child); }
  catch (error) { launch.cancel(); throw error; }
}

module.exports = { spawnManagedSdkProcess, prepareManagedProcessLaunch };
