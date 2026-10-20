'use strict';

// Production tool schemas, service, file policy, host and Chromium together.
// Only model generation is replaced by deterministic tool calls. Loopback only.
const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserAutomationService } = require('../src/main/browser/browser-automation-service');
const { createBrowserToolFactory } = require('../src/main/browser/browser-tools');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-workflow-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const out = path.join(__dirname, '..', '.codex-tmp/browser-automation-workflow-smoke'); fs.mkdirSync(out, { recursive: true });
const report = { ok: false, state: 'running', startedAt: new Date().toISOString(), results: [], failures: [], profileIsolated: true };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); save();
const check = (name, value) => { assert.ok(value, name); report.results.push(name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner, host, service, server, uploaded = '', requests = 0;
const deadline = setTimeout(() => { report.state = 'timeout'; report.failures.push('fixture timed out'); save(); app.exit(1); }, 60000);
async function run() {
  const csv = 'name,value\nalpha,1\nbeta,2\n', workspaceRoot = path.join(temporary, 'task'); fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'input.csv'), csv);
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    if (pathname === '/upload') {
      requests++; request.setEncoding('utf8'); let body = '';
      request.on('data', data => { body += data; }); request.on('end', () => { uploaded = body; response.end('Imported 2 records'); }); return;
    }
    if (pathname === '/failure') { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('fixture unavailable'); return; }
    if (pathname === '/export') { response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' }); response.end(uploaded); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Relay workflow fixture</title><style>body{font:16px system-ui;padding:20px}label,button,a{display:block;margin:12px}input,select,button{font:inherit}</style><h1>Import and export</h1>
      <label>Stage <select id="stage"><option value="draft">Draft</option><option value="approved">Approved</option></select></label>
      <label>CSV file <input id="file" type="file" accept=".csv"></label><button id="send">Import</button><p id="status">Ready</p><a href="/export">Export report</a><button>Do nothing</button>
      <script>document.getElementById('send').onclick=()=>{document.getElementById('status').textContent='Importing';setTimeout(async()=>{const file=document.getElementById('file').files[0];if(!file||document.getElementById('stage').value!=='approved')return;const response=await fetch('/upload',{method:'POST',body:await file.text()});document.getElementById('status').textContent=await response.text();console.info('import complete');await fetch('/failure?token=fixture-query-secret');},180);};</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  app.on('session-created', partition => partition.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && !details.url.startsWith(base + '/') })));
  owner = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Isolated workflow test</title>');
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, onEvent: event => service?.handleHostEvent(event) });
  service = createBrowserAutomationService({ getHost: () => host });
  const controller = new AbortController(), context = { conversationId: 'workflow-task', runId: 'workflow-run', workspaceRoot, signal: controller.signal, isCurrent: () => true };
  const sdk = { tool: (name, _description, _schema, run) => ({ name, run }), createSdkMcpServer: value => value };
  const tools = createBrowserToolFactory({ getContext: () => context, invoke: (ctx, input) => service.invoke(ctx, input) })(sdk)['relay-browser'].tools;
  async function call(name, args) { const output = await tools.find(tool => tool.name === name).run(args); assert.ok(!output.isError, JSON.stringify(output)); return JSON.parse(output.content[0].text); }
  const opened = await call('open', { url: base + '/' }), id = opened.tab.id;
  await host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: 970, height: 710 } });
  await host.invoke({ action: 'visibility', id, visible: true }); owner.show();
  assert.ok((await call('wait', { id, text: 'Import and export', timeoutMs: 5000 })).satisfied);
  let observation = await call('observe', { id });
  const ref = name => { const found = observation.elements.find(item => item.name === name); assert.ok(found, name); return found.ref; };
  observation = (await call('act', { id, observationId: observation.observationId, ref: ref('Stage'), kind: 'select', values: ['approved'] })).observation;
  check('native select is set through the task tool schema and verified independently', (await call('verify', { id, observationId: observation.observationId, ref: ref('Stage'), value: 'approved' })).verified);
  observation = await call('observe', { id });
  const upload = await call('upload', { id, observationId: observation.observationId, ref: ref('CSV file'), files: ['input.csv'] });
  check('upload resolves a task-relative file into the real Chromium input', upload.fileCount === 1 && requests === 0);
  observation = upload.observation;
  await call('diagnostics', { id });
  await call('act', { id, observationId: observation.observationId, ref: ref('Import'), kind: 'click' });
  const waited = await call('wait', { id, text: 'Imported 2 records', timeoutMs: 5000 });
  check('bounded waiting verifies the delayed server response without resubmitting', waited.satisfied && requests === 1 && uploaded === csv);
  let diagnostics;
  for (let attempt = 0; attempt < 40; attempt++) {
    diagnostics = await call('diagnostics', { id });
    if (diagnostics.events.some(event => event.kind === 'network' && event.type === 'response' && event.status === 503)) break;
    await pause(25);
  }
  check('developer diagnostics distinguish an HTTP error from transport failure', diagnostics.events.some(event => event.type === 'response' && event.status === 503 && event.httpError));
  check('developer diagnostics include console output but remove URL query secrets', diagnostics.events.some(event => event.kind === 'console' && JSON.stringify(event).includes('import complete')) && !JSON.stringify(diagnostics).includes('fixture-query-secret'));
  observation = await call('observe', { id });
  const exported = await call('download', { id, observationId: observation.observationId, ref: ref('Export report'), timeoutMs: 5000 });
  const file = fs.readFileSync(exported.download.path), digest = crypto.createHash('sha256').update(file).digest('hex');
  check('task download completes on disk with an independently matching digest and CSV content', exported.download.state === 'completed' && file.toString() === csv && exported.download.sha256 === digest);
  check('task download stays in the task workspace without a save dialog', exported.download.path.startsWith(path.join(workspaceRoot, 'browser-downloads') + path.sep));
  check('completed artifacts can be found by this task', (await call('downloads', {})).downloads.some(item => item.sha256 === digest));
  check('another task cannot discover this task download record', (await service.invoke({ ...context, conversationId: 'other-task' }, { action: 'downloads' })).downloads.length === 0);
  check('readonly planning rejects upload and download', (await service.invoke({ ...context, readOnly: true }, { action: 'upload', id, files: ['input.csv'] })).code === 'PLAN_MODE_READ_ONLY' && (await service.invoke({ ...context, readOnly: true }, { action: 'download', id })).code === 'PLAN_MODE_READ_ONLY');
  observation = await call('observe', { id });
  check('path traversal is rejected before any page upload', (await service.invoke(context, { action: 'upload', id, ref: ref('CSV file'), observationId: observation.observationId, files: ['../outside.csv'] })).code === 'BROWSER_UPLOAD_OUTSIDE_WORKSPACE');
  const pending = service.invoke(context, { action: 'wait', id, text: 'never exists', timeoutMs: 5000 });
  await pause(100); service.control({ action: 'pause', id });
  check('human takeover immediately cancels a condition wait', (await pending).code === 'AUTOMATION_PAUSED');
  service.control({ action: 'resume', id, conversationId: context.conversationId });
  const result = await call('wait', { id, text: 'never exists', timeoutMs: 100 });
  check('timeout is an unmet condition, never a successful assertion', result.satisfied === false && result.timedOut === true);
  report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform };
  report.artifact = { filename: exported.download.filename, size: file.length, sha256: digest, csvRows: file.toString().trim().split('\n').length - 1 };
}
run().catch(error => report.failures.push(error.stack || String(error))).finally(async () => {
  clearTimeout(deadline); service?.dispose(); host?.destroy(); if (owner && !owner.isDestroyed()) owner.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.state = 'complete'; report.ok = !report.failures.length; report.finishedAt = new Date().toISOString(); save();
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) {}
  app.exit(report.ok ? 0 : 1);
});
