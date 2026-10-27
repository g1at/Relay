'use strict';

const { version: installedVersion } = require('node-pty/package.json');
const released = new WeakSet();

// node-pty 1.1.0 on Windows closes the shell/output socket on natural exit,
// but leaves its ConoutConnection worker and input stream alive. Its public
// kill() also probes/falls back to the old PID, so it must not be used here.
// Keep this compatibility cleanup restricted to the observed 1.1.0 shape;
// a different backend/version owns its own cleanup until separately verified.
function releaseExitedPtyResources(pty, event, { platform = process.platform, version = installedVersion } = {}) {
  if (platform !== 'win32' || version !== '1.1.0' || !pty || typeof pty !== 'object'
    || !Number.isInteger(event?.exitCode)) return false;
  const agent = pty._agent, connection = agent?._conoutSocketWorker;
  if (!agent || agent._useConpty !== true || agent._useConptyDll !== false
    || agent._exitCode !== event.exitCode || !connection || connection._useConptyDll !== false
    || typeof connection._isDisposed !== 'boolean' || typeof connection.dispose !== 'function'
    || typeof connection._worker?.terminate !== 'function'
    || typeof agent._inSocket?.destroy !== 'function' || typeof agent._outSocket?.destroy !== 'function') return false;
  if (released.has(pty)) return true;
  released.add(pty);
  // Work only on handles belonging to this already-exited instance. In
  // particular, never invoke pty.kill()/destroy() or process.kill(oldPid).
  try { connection.dispose(); } catch (_) {}
  try { agent._inSocket.destroy(); } catch (_) {}
  try { agent._outSocket.destroy(); } catch (_) {}
  return true;
}

module.exports = { releaseExitedPtyResources };
