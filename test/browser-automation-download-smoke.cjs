'use strict';
// Real host + Chromium downloads on loopback, with a disposable browser profile.
const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserAutomationAdapter } = require('../src/main/browser/browser-automation-adapter');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-download-fixture-'));
app.setPath('userData', profile); app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../.codex-tmp/browser-automation-download-smoke'); fs.mkdirSync(out, { recursive: true });
const taskDirectory = fs.mkdtempSync(path.join(out, 'task-'));
const report = { startedAt: new Date().toISOString(), state: 'running', ok: false, checks: [], failures: [], artifacts: [], requests: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); save();
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('[pass]', name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await sleep(25); } throw new Error('Timeout: ' + label); }
const httpBytes = Buffer.from('Relay task export\n编号,A-2026\n', 'utf8'), blobText = 'Relay in-page Blob export\n';
let owner, host, adapter, server; const events = [], timers = new Set();
const timeout = setTimeout(() => { report.state = 'timeout'; report.failures.push('Smoke exceeded 45 seconds'); save(); app.exit(1); }, 45000);
async function run() {
  server = http.createServer((req, res) => {
    report.requests.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/http' }); res.end(); return; }
    if (req.url === '/http') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': httpBytes.length, 'Content-Disposition': 'attachment; filename="report.csv"' }); res.end(httpBytes); return; }
    if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 100 * 1024 * 1024 + 1, 'Content-Disposition': 'attachment; filename="huge.bin"' }); res.write(Buffer.alloc(64)); return; }
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow.bin"' }); res.write(Buffer.alloc(65536, 65));
      const timer = setInterval(() => res.write(Buffer.alloc(65536, 66)), 50); timers.add(timer);
      req.on('close', () => { clearInterval(timer); timers.delete(timer); }); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Task download fixture</title><style>body{font:18px sans-serif;padding:32px}a,button{display:block;margin:20px;padding:12px}</style><h1>Task download fixture</h1>
      <a href="/redirect" download>Download HTTP</a><button id="blob">Download Blob</button><a href="/slow" download>Download slow</a><a href="/huge" download>Download huge</a>
      <script>document.getElementById('blob').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([${JSON.stringify(blobText)}],{type:'text/plain'}));a.download='blob.txt';document.body.append(a);a.click();a.remove();};</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady(); owner = new BrowserWindow({ width: 1050, height: 780, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Download smoke owner</title>'); owner.show();
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, onEvent: event => events.push(event) });
  const created = await host.invoke({ action: 'create', url: base + '/' }); assert.equal(created.ok, true);
  const id = created.tab.id, wc = host.getAutomationTarget(id).webContents;
  await host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: 1020, height: 710 } }); await host.invoke({ action: 'visibility', id, visible: true });
  await until(() => wc.getURL() === base + '/' && !wc.isLoading(), 'fixture initial navigation');
  // Downloads require the same explicit task control as production automation.
  host.setTaskBinding(id, { conversationId: 'download-fixture', state: 'controlled' });
  check('download fixture explicitly acquires task control', host.state(id).tab.recovery.state === 'controlled');
  adapter = createBrowserAutomationAdapter({ webContents: wc });
  check('production host uses one session download listener', wc.session.listenerCount('will-download') === 1);
  const captureClick = async (label, options = {}) => {
    const observation = await adapter.observe(), element = observation.elements.find(item => item.name === label); assert.ok(element, label);
    const capture = host.beginAutomationDownload(id, { directory: taskDirectory, check: () => {}, timeoutMs: 5000, ...options });
    report.lastAction = await adapter.act({ kind: 'click', observationId: observation.observationId, ref: element.ref }, { beforeClick: () => capture.arm() });
    return capture;
  };
  let capture = await captureClick('Download HTTP'); const first = await capture.result; capture.cancel();
  check('real redirected HTTP attachment is saved without a native save dialog', first.state === 'completed' && first.filename === 'report.csv');
  check('filesystem contents, byte count and SHA-256 match the independent fixture', fs.readFileSync(first.path).equals(httpBytes) && first.size === httpBytes.length && first.sha256 === crypto.createHash('sha256').update(httpBytes).digest('hex'));
  report.artifacts.push(first);
  capture = await captureClick('Download HTTP'); const repeat = await capture.result; capture.cancel();
  check('repeating the filename never overwrites the earlier artifact', repeat.path !== first.path && fs.readFileSync(first.path).equals(httpBytes)); report.artifacts.push(repeat);
  capture = await captureClick('Download Blob'); const blob = await capture.result; capture.cancel();
  check('a same-origin Blob exported by the clicked page is captured and verified', blob.filename === 'blob.txt' && fs.readFileSync(blob.path, 'utf8') === blobText && blob.url === base + '/'); report.artifacts.push(blob);
  const unusedDir = path.join(taskDirectory, 'no-download'); capture = host.beginAutomationDownload(id, { directory: unusedDir, check: () => {}, timeoutMs: 50 });
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_TIMEOUT' }); check('an unconsumed expectation times out and removes only its empty operation directory', fs.readdirSync(unusedDir).length === 0);
  capture = await captureClick('Download huge'); await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_TOO_LARGE' }); check('native Content-Length over 100 MB is rejected', true);
  const controller = new AbortController(), cancelDir = path.join(taskDirectory, 'cancelled');
  capture = await captureClick('Download slow', { directory: cancelDir, signal: controller.signal }); await sleep(200); controller.abort();
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_CANCELLED' });
  await until(() => fs.readdirSync(cancelDir).length === 0, 'cancelled partial cleanup'); check('cancellation removes a real in-flight partial without reporting completion', true);
  const before = events.filter(event => event.type === 'download' && event.status === 'blocked').length;
  wc.downloadURL(base + '/http'); await until(() => events.filter(event => event.type === 'download' && event.status === 'blocked').length > before, 'unarmed download rejection');
  check('an unarmed programmatic page download remains blocked', true);
  fs.writeFileSync(path.join(out, 'page.png'), (await wc.capturePage()).toPNG());
  report.runtime = { platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome };
}
run().catch(error => { report.failures.push(error.stack || String(error)); report.events = events.filter(event => event.type === 'download' || event.type === 'navigation-start'); }).finally(async () => {
  clearTimeout(timeout); adapter?.dispose(); host?.destroy(); if (owner && !owner.isDestroyed()) owner.destroy();
  for (const timer of timers) clearInterval(timer);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.state = 'complete'; report.ok = report.failures.length === 0; report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
