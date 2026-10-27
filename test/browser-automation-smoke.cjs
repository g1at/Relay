'use strict';

// Real Chromium acceptance with disposable state and loopback-only pages.
// Run: electron test/browser-automation-smoke.cjs
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { createBrowserAutomationAdapter } = require('../src/main/browser/browser-automation-adapter');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-automation-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const artifactDir = path.join(__dirname, '..', '.codex-tmp', 'browser-automation-smoke');
const startedAt = new Date().toISOString(), checks = [];
let step = 'initialize';
fs.mkdirSync(artifactDir, { recursive: true });
const save = value => fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(value, null, 2));
save({ ok: false, state: 'running', startedAt });
const check = (name, value) => { assert.ok(value, name); checks.push(name); step = name; save({ ok: false, state: 'running', startedAt, step, checks }); console.log('[pass]', name); };
function within(promise, label, timeoutMs = 10000) {
  step = label; save({ ok: false, state: 'running', startedAt, step, checks });
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), timeoutMs); })]).finally(() => clearTimeout(timer));
}
let owner, view, adapter, server;
const timeout = setTimeout(() => { console.error('Browser automation smoke timed out'); save({ ok: false, state: 'timeout', startedAt, step, checks }); app.exit(1); }, 60000);

async function run() {
  const uploads = [];
  server = http.createServer((request, response) => {
    if (request.url === '/upload' && request.method === 'POST') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { uploads.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('received'); }); return;
    }
    if (request.url.startsWith('/diagnostic')) { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('Synthetic service unavailable'); return; }
    if (request.url === '/extended') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Extended automation fixture</title><style>body{font:16px sans-serif;margin:20px}label{display:block;margin:12px}select,input{padding:5px}#status{margin:12px}</style>
        <label><span>Tone</span> <select id="tone"><option value="">Choose</option><option value="blue">Blue</option><option value="red" disabled>Unavailable red</option></select></label>
        <label>Colors <select id="colors" multiple><option value="blue">Blue</option><option value="green">Green</option><option value="red" disabled>Red</option></select></label>
        <label>Report <input id="report" type="file"></label><label>Attachments <input id="attachments" type="file" multiple></label>
        <label>Directory <input id="directory" type="file" webkitdirectory></label><label>Progress <input id="progress" value="pending"></label>
        <p id="status">Waiting</p><script>
          window.selectTrusted = null;
          document.getElementById('tone').addEventListener('change', event => { window.selectTrusted = event.isTrusted; document.getElementById('status').textContent = 'Selected: ' + event.target.value; });
          document.getElementById('report').addEventListener('change', async event => {
            const file = event.target.files[0];
            await fetch('/upload', {method:'POST', body:file});
            document.getElementById('status').textContent = 'Uploaded: ' + file.name;
          });
        </script>`); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') { response.end('<!doctype html><button onclick="document.body.dataset.clicked=1">Embedded frame button</button>'); return; }
    if (request.url === '/next') { response.end('<!doctype html><title>Next fixture</title><h1>Navigation completed</h1>'); return; }
    response.end(`<!doctype html><title>Browser automation fixture</title>
      <style>body{font:16px sans-serif;margin:24px}input,button{margin:8px;padding:6px}#cover{position:fixed;z-index:100;background:#ddd}#space{height:1800px}</style>
      <h1>Relay local fixture</h1><form id="form"><label>Name <input id="name" autocomplete="off"></label>
      <label>Password <input type="password" value="fixture-secret-123"></label><button id="save" type="submit">Save fixture</button></form>
      <p id="status">Not saved</p><div id="shadow"></div><iframe title="Embedded fixture" src="/frame"></iframe>
      <a href="/next">Next fixture</a><div id="space"></div><p>Bottom of page</p>
      <script>
        window.inputTrusted = false; window.submitTrusted = false;
        document.getElementById('name').addEventListener('input', event => { window.inputTrusted = event.isTrusted; });
        document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); window.submitTrusted = event.isTrusted; document.getElementById('status').textContent = 'Saved: ' + document.getElementById('name').value; });
        const root = document.getElementById('shadow').attachShadow({mode:'open'});
        root.innerHTML = '<label>Shadow name <input></label><button>Shadow save</button><span></span>';
        root.querySelector('button').onclick = () => { root.querySelector('span').textContent = root.querySelector('input').value; };
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  const isolatedSession = session.fromPartition('relay-browser-automation-fixture-' + process.pid);
  isolatedSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base + '/') }));
  owner = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await within(owner.loadURL('data:text/html,<title>Automation fixture owner</title>'), 'owner document load');
  view = new WebContentsView({ webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  owner.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1080, height: 790 });
  owner.show(); await within(view.webContents.loadURL(base + '/'), 'automation page load');
  await within(view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'), 'first compositor frame');
  await view.webContents.executeJavaScript('console.warn("pre-adapter-log-must-not-replay")');
  await new Promise(resolve => setTimeout(resolve, 10));
  adapter = createBrowserAutomationAdapter({ webContents: view.webContents });
  let observation = await within(adapter.observe(), 'initial semantic observation');
  const find = name => { const element = observation.elements.find(item => item.name === name); assert.ok(element, 'Missing observed element: ' + name); return element.ref; };
  check('CDP observes semantic elements in the real embedded Chromium view', observation.title === 'Browser automation fixture' && !!find('Name'));
  check('password values are absent from observation', !JSON.stringify(observation).includes('fixture-secret-123'));
  const frameList = await adapter.frames(), embedded = frameList.frames.find(frame => frame.url.endsWith('/frame'));
  check('frame listing probes an actual isolated frame context', !!embedded && embedded.supported === true);
  const childObservation = await adapter.observe({}, { frameId: embedded.id });
  check('same-origin frame semantic observation is explicit', childObservation.frameId === embedded.id && childObservation.elements.some(item => item.name === 'Embedded frame button'));
  await adapter.act({ kind: 'click', observationId: childObservation.observationId, frameId: embedded.id, ref: childObservation.elements.find(item => item.name === 'Embedded frame button').ref });
  check('frame click translates coordinates through the owner', await view.webContents.executeJavaScript('document.querySelector("iframe").contentDocument.body.dataset.clicked') === '1');
  observation = await adapter.observe();
  check('open shadow root controls are observed', !!find('Shadow name'));

  // Main-world scripts cannot replace node-reference storage in the isolated world.
  await view.webContents.executeJavaScript('window.__relayBrowserAutomation = { id: "tampered", nodes: new Map() }');
  let action = await adapter.act({ kind: 'fill', observationId: observation.observationId, ref: find('Name'), text: 'Ada Relay' });
  check('fill executes real trusted input and returns a new observation', action.executed && !!action.observation && await view.webContents.executeJavaScript('window.inputTrusted'));
  observation = action.observation;
  let verified = await adapter.verify({ observationId: observation.observationId, ref: find('Name'), value: 'Ada Relay' });
  check('independent field verification checks the rendered value', verified.verified); assert.equal(verified.requiresObservation, false);
  action = await adapter.act({ kind: 'click', observationId: observation.observationId, ref: find('Save fixture') });
  check('click executes a trusted native submit', action.executed && await view.webContents.executeJavaScript('window.submitTrusted'));
  verified = await adapter.verify({ text: 'Saved: Ada Relay' }); check('business result is checked after the click', verified.verified); assert.equal(verified.requiresObservation, false);
  check('a failed business assertion is not reported as success', !(await adapter.verify({ text: 'This result does not exist' })).verified);

  observation = await adapter.observe();
  action = await adapter.act({ kind: 'fill', observationId: observation.observationId, ref: find('Shadow name'), text: 'Open shadow verified' });
  check('trusted input also reaches open shadow root controls', action.executed && await view.webContents.executeJavaScript('document.getElementById("shadow").shadowRoot.querySelector("input").value === "Open shadow verified"'));

  observation = await adapter.observe();
  const password = observation.elements.find(item => item.type === 'password');
  await assert.rejects(adapter.verify({ observationId: observation.observationId, ref: password.ref, value: 'fixture-secret-123' }), { code: 'BROWSER_PASSWORD_READ_BLOCKED' });
  check('password comparisons are blocked', true);
  await view.webContents.executeJavaScript('document.getElementById("status").textContent = "Waiting for zoom click"');
  view.webContents.setZoomFactor(1.25); await new Promise(resolve => setTimeout(resolve, 50));
  observation = await adapter.observe();
  action = await adapter.act({ kind: 'click', observationId: observation.observationId, ref: find('Save fixture') });
  check('DOM CSS coordinates still target the correct control at 125 percent zoom', action.executed && (await adapter.verify({ text: 'Saved: Ada Relay' })).verified);
  view.webContents.setZoomFactor(1); await new Promise(resolve => setTimeout(resolve, 50));
  observation = await adapter.observe(); const saveRef = find('Save fixture');
  await view.webContents.executeJavaScript(`(() => { const r = document.getElementById('save').getBoundingClientRect(), cover = document.createElement('div'); cover.id='cover'; Object.assign(cover.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'}); document.body.append(cover); })()`);
  await assert.rejects(adapter.act({ kind: 'click', observationId: observation.observationId, ref: saveRef }), { code: 'BROWSER_ELEMENT_OBSCURED' });
  check('an overlay blocks native clicking instead of clicking through', true);
  await view.webContents.executeJavaScript('document.getElementById("cover").remove()');
  observation = await adapter.observe(); const nameRef = find('Name');
  await view.webContents.executeJavaScript('const original = document.getElementById("name"); original.replaceWith(original.cloneNode(true))');
  await assert.rejects(adapter.act({ kind: 'fill', observationId: observation.observationId, ref: nameRef, text: 'Wrong node' }), { code: 'BROWSER_ELEMENT_STALE' });
  check('DOM replacement invalidates the exact node reference', true);
  observation = await adapter.observe(); const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.act({ kind: 'fill', observationId: observation.observationId, ref: find('Name'), text: 'Cancelled edit' }, { signal: controller.signal }), { code: 'BROWSER_CANCELLED' });
  check('cancelled actions leave the field untouched', await view.webContents.executeJavaScript('document.getElementById("name").value !== "Cancelled edit"'));

  const screenshot = await adapter.screenshot(), bytes = Buffer.from(screenshot.data, 'base64');
  check('CDP screenshot contains actual PNG bytes', screenshot.mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length > 1000);
  fs.writeFileSync(path.join(artifactDir, 'browser-automation.png'), bytes);
  await view.webContents.executeJavaScript('window.submitTrusted = false; document.getElementById("status").textContent = "Waiting for Enter"');
  observation = await adapter.observe();
  action = await adapter.act({ kind: 'press', key: 'Enter', observationId: observation.observationId, ref: find('Name') });
  check('a complete Enter keystroke submits without leaving a pending key release', action.executed && !!action.observation && await view.webContents.executeJavaScript('window.submitTrusted && document.getElementById("status").textContent === "Saved: Ada Relay"')); observation = action.observation;
  const old = observation;
  action = await adapter.act({ kind: 'click', observationId: observation.observationId, ref: find('Next fixture') });
  check('one native click gesture completes navigation and observes its result', action.executed && action.observation?.title === 'Next fixture');
  await assert.rejects(adapter.act({ kind: 'click', observationId: old.observationId, ref: 'e1' }), { code: 'BROWSER_OBSERVATION_STALE' });
  check('navigation rejects a previous document observation', true);
  observation = await adapter.observe(); check('a fresh observation recovers on the new document', observation.title === 'Next fixture');
  await view.webContents.loadURL(base + '/extended');
  observation = await adapter.observe();
  check('native select options are included in semantic observations', observation.elements.find(item => item.name === 'Tone').options.some(option => option.value === 'blue'));
  action = await adapter.act({ kind: 'select', observationId: observation.observationId, ref: find('Tone'), values: ['blue'] });
  observation = action.observation;
  verified = await adapter.verify({ observationId: observation.observationId, ref: find('Tone'), value: 'blue' });
  check('native select updates its value with explicitly untrusted DOM change events', action.executed && action.inputMode === 'dom-events' && verified.verified && await view.webContents.executeJavaScript('window.selectTrusted === false'));
  assert.equal(verified.requiresObservation, false);
  action = await adapter.act({ kind: 'select', observationId: observation.observationId, ref: find('Colors'), values: ['blue', 'green'] });
  check('multiple select chooses the requested option set', action.executed && await view.webContents.executeJavaScript('JSON.stringify(Array.from(document.getElementById("colors").selectedOptions, option => option.value)) === JSON.stringify(["blue","green"])'));
  observation = action.observation;
  await assert.rejects(adapter.act({ kind: 'select', observationId: observation.observationId, ref: find('Tone'), values: ['red'] }), { code: 'BROWSER_OPTION_UNAVAILABLE' });
  check('disabled options are rejected without changing the selection', await view.webContents.executeJavaScript('document.getElementById("tone").value === "blue"'));

  await view.webContents.executeJavaScript('setTimeout(() => document.getElementById("status").textContent = "Ready from timer", 150)');
  let waited = await adapter.wait({ text: 'Ready from timer', timeoutMs: 2000, pollIntervalMs: 50 });
  check('bounded wait detects delayed rendered text without clicking', waited.satisfied && !waited.timedOut);
  observation = await adapter.observe();
  await view.webContents.executeJavaScript('setTimeout(() => document.getElementById("progress").value = "done", 150)');
  waited = await adapter.wait({ observationId: observation.observationId, ref: find('Progress'), value: 'done', timeoutMs: 2000, pollIntervalMs: 50 });
  check('field wait retains the original observed node across multiple polls', waited.satisfied && waited.observation === null && !waited.requiresObservation && (await adapter.verify({ observationId: observation.observationId, ref: find('Progress'), value: 'done' })).verified);
  waited = await adapter.wait({ text: 'Will never appear', timeoutMs: 100, pollIntervalMs: 50 });
  check('wait timeout reports an unmet condition instead of successful completion', !waited.satisfied && waited.timedOut);
  const waitingController = new AbortController(), cancelWait = setTimeout(() => waitingController.abort(), 35);
  await assert.rejects(adapter.wait({ text: 'Will never appear', timeoutMs: 2000 }, { signal: waitingController.signal }), { code: 'BROWSER_CANCELLED' }); clearTimeout(cancelWait);
  check('waiting is promptly cancellable', true);

  const uploadFile = path.join(profile, 'synthetic-report.txt'), secondFile = path.join(profile, 'synthetic-second.txt');
  fs.writeFileSync(uploadFile, 'Relay synthetic upload bytes'); fs.writeFileSync(secondFile, 'Second synthetic attachment');
  observation = await adapter.observe();
  action = await adapter.upload({ observationId: observation.observationId, ref: find('Report'), files: [uploadFile] });
  waited = await adapter.wait({ text: 'Uploaded: synthetic-report.txt', timeoutMs: 2000 });
  check('CDP file input uploads actual fixture bytes to the loopback receiver', action.executed && action.fileCount === 1 && waited.satisfied && uploads.length === 1 && uploads[0] === 'Relay synthetic upload bytes');
  check('upload results omit absolute local file paths', !JSON.stringify(action).includes(uploadFile) && !JSON.stringify(action).includes(profile));
  observation = await adapter.observe();
  await assert.rejects(adapter.upload({ observationId: observation.observationId, ref: find('Report'), files: [uploadFile, secondFile] }), { code: 'BROWSER_MULTIPLE_FILES_UNSUPPORTED' });
  check('single-file inputs reject multiple files before changing their file list', await view.webContents.executeJavaScript('document.getElementById("report").files.length === 1'));
  observation = await adapter.observe();
  action = await adapter.upload({ observationId: observation.observationId, ref: find('Attachments'), files: [uploadFile, secondFile] });
  check('multiple file inputs receive both authorized files', action.executed && await view.webContents.executeJavaScript('document.getElementById("attachments").files.length === 2'));
  observation = action.observation;
  await assert.rejects(adapter.upload({ observationId: observation.observationId, ref: find('Directory'), files: [uploadFile] }), { code: 'BROWSER_DIRECTORY_UPLOAD_UNSUPPORTED' });
  check('directory upload inputs are explicitly unsupported', true);
  observation = await adapter.observe(); const staleFileRef = find('Report');
  await view.webContents.executeJavaScript('const oldFile = document.getElementById("report"); oldFile.replaceWith(oldFile.cloneNode(true))');
  await assert.rejects(adapter.upload({ observationId: observation.observationId, ref: staleFileRef, files: [uploadFile] }), { code: 'BROWSER_ELEMENT_STALE' });
  check('upload rejects DOM replacement instead of finding a new matching input', uploads.length === 1);

  await adapter.diagnostics({ kind: 'all' });
  await view.webContents.executeJavaScript('console.warn("Relay diagnostics fixture"); fetch("/diagnostic?token=fixture-must-not-leak").then(() => document.getElementById("status").textContent = "Diagnostics ready")');
  await adapter.wait({ text: 'Diagnostics ready', timeoutMs: 2000 });
  const diagnostic = await adapter.diagnostics({ kind: 'all', limit: 200 });
  check('diagnostics captures real console and HTTP 503 metadata', diagnostic.events.some(event => event.kind === 'console' && event.args?.some(arg => arg.value === 'Relay diagnostics fixture')) && diagnostic.events.some(event => event.kind === 'network' && event.status === 503 && event.httpError));
  check('diagnostics omits sensitive URL query values', !JSON.stringify(diagnostic).includes('fixture-must-not-leak'));
  check('diagnostics excludes console records created before the adapter lease', !JSON.stringify(diagnostic).includes('pre-adapter-log-must-not-replay'));
  observation = await adapter.observe();
  await view.webContents.executeJavaScript('setTimeout(() => location.href = "/next", 100)');
  await assert.rejects(adapter.wait({ observationId: observation.observationId, ref: find('Progress'), value: 'missing', timeoutMs: 2000, pollIntervalMs: 50 }), { code: 'BROWSER_OBSERVATION_STALE' });
  check('a field wait cannot reuse its reference after navigation', true);
  await view.webContents.loadURL(base + '/extended');
  await view.webContents.executeJavaScript('setTimeout(() => location.href = "/next", 100)');
  waited = await adapter.wait({ url: base + '/next', timeoutMs: 2000, pollIntervalMs: 50 });
  check('URL-only wait follows navigation without reusing element references', waited.satisfied && waited.requiresObservation && view.webContents.getTitle() === 'Next fixture');
  adapter.dispose(); adapter = null; check('adapter releases its debugger connection', !view.webContents.debugger.isAttached());
  const result = { ok: true, state: 'complete', startedAt, finishedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform }, checks: checks.length, results: checks };
  save(result); console.log(JSON.stringify(result, null, 2));
}
run().catch(error => {
  console.error(error.stack || error); process.exitCode = 1;
  save({ ok: false, state: 'failed', startedAt, finishedAt: new Date().toISOString(), checks: checks.length, results: checks, error: String(error.stack || error) });
}).finally(async () => {
  clearTimeout(timeout);
  if (adapter) adapter.dispose();
  if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  if (owner && !owner.isDestroyed()) owner.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(process.exitCode || 0);
});
