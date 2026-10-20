'use strict';
// Isolated native Chromium visibility checks. No user profile, model, remote
// site or input replay. Hidden task pages remain usable; revoking the task
// lease must still reject input before any native dispatch.
const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserAutomationService } = require('../src/main/browser/browser-automation-service');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-visibility-'));
const out = path.join(__dirname, '..', '.codex-tmp/browser-document-visibility'); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile); app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = { ok: false, checks: [], methods: [], visibilityEvents: [], profileIsolated: true };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); save();
const check = (label, value) => { assert.ok(value, label); report.checks.push(label); save(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { const end = Date.now() + 5000; while (Date.now() < end) { if (await test()) return; await delay(20); } throw Error(label); }
let owner, host, service, server;
const timer = setTimeout(() => { report.error = 'timeout'; save(); app.exit(1); }, 45000);
async function run() {
  await app.whenReady();
  server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Visibility fixture</title><button id="save" style="margin:30px;padding:20px" onclick="window.clicks=(window.clicks||0)+1">Save</button><input aria-label="Name"><script>window.clicks=0</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  owner = new BrowserWindow({ show: false, width: 850, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Visibility fixture owner</title>');
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, onEvent: event => service?.handleHostEvent(event) });
  service = createBrowserAutomationService({ getHost: () => host });
  const ctx = { conversationId: 'visibility-task', runId: 'one', isCurrent: () => true };
  const opened = await service.invoke(ctx, { action: 'open', url: 'http://127.0.0.1:' + server.address().port });
  assert.equal(opened.ok, true); const id = opened.tab.id, wc = host.getAutomationTarget(id).webContents;
  const send = wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand = (method, ...args) => { report.methods.push(method); return send(method, ...args); };
  wc.on('ipc-message', (_event, channel, payload) => {
    if (channel === 'browser:page-event' && ['input-ready', 'input-not-visible'].includes(payload?.type)) report.visibilityEvents.push({ type: payload.type, visible: payload.visible === true, background: payload.background === true });
  });
  host.setBounds({ x: 0, y: 0, width: 800, height: 570 }); host.setVisibility(true, id); owner.show(); wc.focus();
  await until(() => wc.getTitle() === 'Visibility fixture' && !wc.isLoading(), 'fixture load');
  await delay(200);
  const observe = () => service.invoke(ctx, { action: 'observe', id });
  let observation = await observe(); assert.equal(observation.ok, true, JSON.stringify(observation));
  let result = await service.invoke(ctx, { action: 'act', id, observationId: observation.observationId, kind: 'click', locator: { css: '#save' } });
  check('task input works after a hidden create followed by presentation', result.ok && await wc.executeJavaScript('window.clicks') === 1);
  host.setVisibility(false, id);
  check('hiding the native page preserves its task authority', !host.getAutomationTarget(id).presented && host.getAutomationTarget(id).backgroundCapable);
  observation = await observe(); assert.equal(observation.ok, true, JSON.stringify(observation));
  result = await service.invoke(ctx, { action: 'act', id, observationId: observation.observationId, kind: 'click', locator: { css: '#save' } });
  check('authorized background click executes exactly once', result.ok && await wc.executeJavaScript('window.clicks') === 2);
  service.control({ action: 'pause', id });
  const count = report.methods.length;
  result = await service.invoke(ctx, { action: 'act', id, observationId: observation.observationId, kind: 'click', locator: { css: '#save' } });
  check('explicit takeover rejects background input before dispatch', result.code === 'AUTOMATION_PAUSED' && !report.methods.slice(count).some(method => method.startsWith('Input.')));
  check('paused background page was not changed', await wc.executeJavaScript('window.clicks') === 2);
  service.control({ action: 'resume', id, conversationId: ctx.conversationId });
  host.setVisibility(true, id);
  const before = await wc.executeJavaScript('window.clicks');
  observation = await observe(); assert.equal(observation.ok, true, JSON.stringify(observation));
  result = await service.invoke(ctx, { action: 'act', id, observationId: observation.observationId, kind: 'click', locator: { css: '#save' } });
  check('fresh explicit action after visibility restoration succeeds once', result.ok && await wc.executeJavaScript('window.clicks') === before + 1);
  check('task input used the trusted preload acknowledgement', report.visibilityEvents.some(e => e.type === 'input-ready'));
  report.electron = process.versions.electron; report.ok = true;
}
run().catch(error => { report.error = error.stack; }).finally(() => { clearTimeout(timer); save(); service?.dispose(); host?.destroy(); owner?.destroy(); server?.close(); app.exit(report.ok ? 0 : 1); });
