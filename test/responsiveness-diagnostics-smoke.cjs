'use strict';

// Isolated real Electron event-loop probe. Does not attach to Relay, load its
// settings/history or start an SDK. The short CPU stall is in this fixture only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { attachResponsivenessDiagnostics } = require('../src/main/app/responsiveness-diagnostics');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-responsiveness-smoke-'));
app.setPath('userData', profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;

app.whenReady().then(async () => {
  const records = [];
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<title>Isolated responsiveness probe</title>');
  const monitor = attachResponsivenessDiagnostics({ win, runningCount: () => 3,
    logger: { warn: (_format, json) => records.push(JSON.parse(json)) },
    intervalMs: 50, thresholdMs: 200,
  });
  await sleep(120);
  const begin = performance.now();
  while (performance.now() - begin < 500) { /* synthetic CPU stall */ }
  await sleep(100);
  const delayed = records.find(record => record.kind === 'main-loop-delay');
  assert.ok(delayed && delayed.delayMs >= 400, 'native main loop records the isolated stall');
  assert.ok(delayed.mainCpuMs >= 100, 'CPU sample distinguishes work from an idle timer');
  assert.equal(delayed.runningTasks, 3);
  monitor.dispose();
  win.destroy();
  const report = { syntheticOnly: true, platform: process.platform, electron: process.versions.electron,
    evidence: 'Real isolated Electron main-loop stall; not the running Relay incident', records };
  console.log(JSON.stringify(report));
  if (process.env.RELAY_RESPONSIVENESS_REPORT) fs.writeFileSync(process.env.RELAY_RESPONSIVENESS_REPORT, JSON.stringify(report, null, 2));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(0);
}).catch(error => {
  console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(1);
});
