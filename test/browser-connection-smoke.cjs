'use strict';

// Production IPC and real Chromium; isolated profile, loopback fixtures only.
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..');
const restartCheck = process.argv.includes('--restart-check');
const output = path.resolve(process.env.RELAY_SMOKE_OUTPUT || path.join(root, '.codex-tmp', 'browser-connection-smoke'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('no-proxy-server');
app.on('window-all-closed', () => {});
const report = { ok: false, startedAt: new Date().toISOString(), checks: [], errors: [] }, servers = [];
let owner, foreign, registry, finishing = false;
const timeout = setTimeout(() => finish(new Error('Browser connection smoke timed out')), 80000);
async function until(predicate, description) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(description);
}
function check(name, condition) { assert.ok(condition, name); report.checks.push(name); console.log('[pass]', name); }
const evaluate = (source, window = owner) => window.webContents.executeJavaScript(source);
const invoke = input => evaluate(`api.browser.invoke(${JSON.stringify(input)})`);
const readTab = async id => (await invoke({ action: 'state', id })).tab;
const page = url => webContents.getAllWebContents().find(contents => contents !== owner?.webContents && contents.getURL() === url);
async function listen(server, port = 0) { servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address().port; }
function createWindow() { return new BrowserWindow({ show: false, width: 1000, height: 720,
  webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } }); }
function installRegistry(entry) { registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => owner, entryFile: entry }); }
async function loaded(id, title) {
  await until(async () => { const tab = await readTab(id); return tab && !tab.loading && !tab.error && tab.title === title; }, `Page did not load: ${title}`);
}
async function blocked(id) {
  await until(async () => { const tab = await readTab(id); return tab && !tab.loading && tab.connection?.state === 'certificate-error'; }, 'Certificate failure did not reach owner');
  return (await readTab(id)).connection;
}
async function run() {
  await app.whenReady();
  const handler = (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><title>Connection ${request.url}</title><h1 id="result">Local connection succeeded</h1>`);
  };
  const httpPort = await listen(http.createServer(handler));
  const tls = { cert: fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost.pem')), key: fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost.key')) };
  const previousPorts = restartCheck ? JSON.parse(fs.readFileSync(path.join(output, 'ports.json'), 'utf8')) : {};
  const httpsPort = await listen(https.createServer(tls, handler), previousPorts.httpsPort || 0), otherPort = await listen(https.createServer(tls, handler));
  if (!restartCheck) fs.writeFileSync(path.join(output, 'ports.json'), JSON.stringify({ httpsPort }));
  const plain = `http://127.0.0.1:${httpPort}`, secure = `https://127.0.0.1:${httpsPort}`, other = `https://127.0.0.1:${otherPort}`;
  const entry = path.join(output, 'owner.html');
  fs.writeFileSync(entry, '<!doctype html><title>Connection checks</title><p>Isolated local owner</p>');
  owner = createWindow(); installRegistry(entry); await owner.loadFile(entry);
  if (restartCheck) {
    const fresh = await invoke({ action: 'create', url: secure + '/after-app-restart' }); await blocked(fresh.id);
    check('app restart on same profile and origin requires fresh certificate confirmation', (await readTab(fresh.id)).connection.state === 'certificate-error');
    return;
  }
  const first = await invoke({ action: 'create', url: plain + '/http' });
  check('production IPC creates an explicit HTTP tab', first.ok); await loaded(first.id, 'Connection /http');
  check('HTTP page executes in real Chromium', await page(plain + '/http').executeJavaScript('document.getElementById("result").textContent') === 'Local connection succeeded');
  check('HTTP is reported as unencrypted', (await readTab(first.id)).connection?.state === 'http');
  const local = await invoke({ action: 'resolve', text: `127.0.0.1:${httpPort}/bare` });
  check('scheme-less loopback keeps HTTP', local.ok && local.url === plain + '/bare');
  const privateAddress = await invoke({ action: 'resolve', text: '10.42.0.8/internal' });
  check('private IPv4 resolves to HTTP without contacting it', privateAddress.ok && privateAddress.url === 'http://10.42.0.8/internal');
  await invoke({ action: 'navigate', id: first.id, url: local.url }); await loaded(first.id, 'Connection /bare');
  const tlsTab = await invoke({ action: 'create', url: secure + '/tls' }), failure = await blocked(tlsTab.id);
  check('self-signed HTTPS is initially blocked', failure.canContinue && !!failure.challengeId && /CERT/.test((await readTab(tlsTab.id)).error));
  check('failure identifies the origin and certificate', failure.origin === secure && !!failure.certificate?.fingerprint);
  check('invented confirmation is rejected', !(await invoke({ action: 'security.continue', id: tlsTab.id, challengeId: 'invalid' })).ok);
  foreign = createWindow(); await foreign.loadFile(entry);
  check('foreign renderer cannot approve a certificate', (await evaluate(`api.browser.invoke(${JSON.stringify({ action: 'security.continue', id: tlsTab.id, challengeId: failure.challengeId })})`, foreign)).code === 'FORBIDDEN');
  check('owner can explicitly continue the failed site', (await invoke({ action: 'security.continue', id: tlsTab.id, challengeId: failure.challengeId })).ok);
  await loaded(tlsTab.id, 'Connection /tls');
  check('approved page renders actual content', await page(secure + '/tls').executeJavaScript('document.getElementById("result").textContent') === 'Local connection succeeded');
  check('approved certificate remains visibly exceptional', (await readTab(tlsTab.id)).connection?.state === 'certificate-exception');
  check('confirmation cannot be replayed', !(await invoke({ action: 'security.continue', id: tlsTab.id, challengeId: failure.challengeId })).ok);
  await invoke({ action: 'navigate', id: tlsTab.id, url: secure + '/same-origin' }); await loaded(tlsTab.id, 'Connection /same-origin');
  check('same tab can navigate within approved site', (await readTab(tlsTab.id)).connection?.state === 'certificate-exception');
  const sibling = await invoke({ action: 'create', url: secure + '/sibling' }); await loaded(sibling.id, 'Connection /sibling');
  check('same-session sibling reflects temporary site approval', (await readTab(sibling.id)).connection.state === 'certificate-exception');
  await invoke({ action: 'navigate', id: tlsTab.id, url: other + '/other-origin' }); await blocked(tlsTab.id);
  check('same certificate on another origin still needs approval', (await readTab(tlsTab.id)).connection.origin === other);
  const oldChallenge = (await readTab(tlsTab.id)).connection.challengeId;
  await invoke({ action: 'navigate', id: tlsTab.id, url: plain + '/left' }); await loaded(tlsTab.id, 'Connection /left');
  check('navigation invalidates old confirmation', !(await invoke({ action: 'security.continue', id: tlsTab.id, challengeId: oldChallenge })).ok);
  await invoke({ action: 'navigate', id: tlsTab.id, url: `https://127.0.0.1:${httpPort}/http-only` });
  await until(async () => !!(await readTab(tlsTab.id)).error, 'HTTPS to HTTP-only server did not fail');
  check('explicit HTTPS is not silently downgraded', (await readTab(tlsTab.id)).url.startsWith('https:'));
  check('user can switch failed HTTPS to HTTP', (await invoke({ action: 'security.useHttp', id: tlsTab.id })).ok);
  await loaded(tlsTab.id, 'Connection /http-only');
  check('HTTP fallback reaches actual HTTP-only server', (await readTab(tlsTab.id)).url === plain + '/http-only');
  await invoke({ action: 'close', id: sibling.id }); await invoke({ action: 'close', id: tlsTab.id });
  const reopened = await invoke({ action: 'create', url: secure + '/reopened' }); await loaded(reopened.id, 'Connection /reopened');
  check('reopened tab accurately labels same-session site exception', (await readTab(reopened.id)).connection.state === 'certificate-exception');
  registry.dispose(); installRegistry(entry);
  const restored = await invoke({ action: 'create', url: secure + '/new-host' }); await loaded(restored.id, 'Connection /new-host');
  check('host recreation preserves connection label for session cache', (await readTab(restored.id)).connection.state === 'certificate-exception');
  servers[1].closeAllConnections(); await new Promise(resolve => servers[1].close(resolve));
  await listen(https.createServer({ ...tls, cert: fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost-rotated.pem')) }, handler), httpsPort);
  await invoke({ action: 'navigate', id: restored.id, url: secure + '/changed-certificate' }); await blocked(restored.id);
  check('changed certificate at the approved origin requires fresh confirmation', (await readTab(restored.id)).connection.certificate.fingerprint !== failure.certificate.fingerprint);
}
async function finish(error) {
  if (finishing) return; finishing = true; clearTimeout(timeout);
  if (error) report.errors.push(String(error.stack || error));
  registry?.dispose();
  if (foreign && !foreign.isDestroyed()) foreign.destroy();
  if (owner && !owner.isDestroyed()) owner.destroy();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.finishedAt = new Date().toISOString(); report.ok = !report.errors.length;
  fs.writeFileSync(path.join(output, restartCheck ? 'restart-result.json' : 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
}
run().then(() => finish(), finish);
