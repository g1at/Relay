'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const LIMIT = 1024 * 1024;

function removeAbandonedLogs(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name), ownerFile = path.join(dir, 'owner.json');
    try {
      if (fs.lstatSync(ownerFile).isSymbolicLink()) continue;
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (owner.kind !== 'relay-sdk-diagnostics' || !Number.isSafeInteger(owner.pid) || owner.pid < 1) continue;
      try { process.kill(owner.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {} // Another Relay process can clean the same abandoned run.
  }
}

// Raw SDK debug output is temporary, private and never returned to a renderer.
// Only allowlisted aggregate categories are retained; this avoids pretending a
// regex redactor can recognize arbitrary third-party credentials in a prompt.
function createDiagnosticLog({ root = path.join(os.tmpdir(), 'relay-sdk-diagnostics'), onSummary = () => {}, interval = 2000 } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  removeAbandonedLogs(root);
  const dir = fs.mkdtempSync(path.join(root, 'run-')); fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({kind:'relay-sdk-diagnostics',pid:process.pid}), {mode:0o600});
  const file = path.join(dir, 'sdk.log'); fs.writeFileSync(file, '', { mode: 0o600 });
  let cursor = 0, closed = false;
  const counts = { connection: 0, configuration: 0, tool: 0, other: 0 }, summary = () => ({ id, counts: { ...counts }, rawRetained: false });
  const id = crypto.randomUUID();
  function flush() {
    if (closed) return;
    try {
      const stat = fs.statSync(file); if (stat.size < cursor) cursor = 0;
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(LIMIT, Math.max(0, stat.size - cursor)));
        const got = fs.readSync(handle, buffer, 0, buffer.length, Math.max(cursor, stat.size - LIMIT));
        for (const line of buffer.subarray(0, got).toString('utf8').split('\n').filter(Boolean)) {
          const category = /retry|network|connect|ECONN|ENOTFOUND/i.test(line) ? 'connection'
            : /settings|policy|plugin|hook/i.test(line) ? 'configuration' : /tool|mcp/i.test(line) ? 'tool' : 'other';
          counts[category]++;
        }
      } finally { fs.closeSync(handle); }
      cursor = stat.size;
      if (stat.size >= LIMIT) { fs.truncateSync(file, 0); cursor = 0; }
      onSummary(summary());
    } catch (_) {}
  }
  const timer = setInterval(flush, interval); timer.unref?.();
  return { file, flush, summary, close() { if (closed) return; clearInterval(timer); flush(); closed = true; try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} return summary(); } };
}
module.exports = { createDiagnosticLog };
