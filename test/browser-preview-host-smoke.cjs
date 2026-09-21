'use strict';

// Native Chromium regression with synthetic HTML/profile and loopback assets.
// No real Relay settings, providers, history or browser session are loaded.
const { app, BrowserWindow, WebContentsView, session, webContents } = require('electron');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createBrowserPanelHost } = require('../browser-panel-host');
const { createBrowserProfileStore } = require('../browser-profile-store');
const out = path.resolve(__dirname, '../.codex-tmp/browser-preview-host-smoke');
const runDir = path.join(out, 'profile-' + Date.now());
fs.mkdirSync(runDir, { recursive: true }); app.setPath('userData', path.join(runDir, 'electron'));
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const results = [], events = [], requests = [];
let owner, host, server, deadline;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message) {
  const until = Date.now() + 9000;
  while (Date.now() < until) { if (await fn()) return; await pause(25); }
  throw Error(message);
}
function check(name, value) { assert.ok(value, name); results.push(name); console.log('[pass]', name); }
function contentsFor(id) {
  const target = host.state(id).tab.url;
  return webContents.getAllWebContents().find(wc => host.ownsWebContents(wc) && wc.getURL() === target);
}
async function loaded(id, title) { await waitFor(() => host.state(id).tab.title === title && !host.state(id).tab.loading, 'Page did not load: ' + title + ' ' + JSON.stringify(host.state(id))); }
async function run() {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/script.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.externalAssetLoaded = true'); return; }
    if (req.url === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('body { background: #f5f5f7; color: #202124; font: 16px system-ui; margin: 32px; } button { padding: 12px 24px; border: 1px solid #ddd; border-radius: 10px; background: white; }'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Normal site</title><h1>Normal site</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  await app.whenReady();
  owner = new BrowserWindow({ width: 1000, height: 740, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Isolated preview test</title><body style="background:%23eee">Relay preview fixture</body>');
  const profile = createBrowserProfileStore({ rootDir: path.join(runDir, 'browser') });
  host = createBrowserPanelHost({ owner, WebContentsView, session, profile, onEvent: e => events.push(e), shell: { openExternal: async () => { throw Error('External browser forbidden in fixture'); } } });
  const normal = await host.invoke({ action: 'create', url: base + '/normal' }); assert.equal(normal.ok, true); await loaded(normal.id, 'Normal site');
  const normalContents = contentsFor(normal.id);
  await normalContents.executeJavaScript('document.cookie="saved_browser_cookie=secret"; localStorage.setItem("saved","secret")');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Interactive code preview</title><link rel="stylesheet" href="${base}/theme.css"><script src="${base}/script.js"></script></head><body><h1>Interactive code preview</h1><p>findable preview-marker</p><button id="counter">Count 0</button><a href="${base}/popup" target="_blank" id="popup">Open site</a><div style="height:1300px">Scroll content</div><script>window.count=0;counter.onclick=()=>counter.textContent='Count '+(++window.count);</script></body></html>`;
  const preview = await host.invoke({ action: 'createPreview', html, title: 'Code', clientRequestId: 'preview-native-1' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await host.invoke({ action: 'setBounds', rect: { x: 300, y: 80, width: 650, height: 570 } });
  await host.invoke({ action: 'visibility', id: preview.id, visible: true }); owner.show();
  await loaded(preview.id, 'Interactive code preview');
  const wc = contentsFor(preview.id), partition = wc.session;
  check('actual preview loads memory HTML through its scoped URL', host.state(preview.id).tab.isPreview && wc.getURL() === preview.tab.url && /^relay-preview:/.test(wc.getURL()));
  check('created event matches the renderer request', events.some(e => e.type === 'created' && e.id === preview.id && e.clientRequestId === 'preview-native-1'));
  check('preview uses an independent non-persistent session', partition !== normalContents.session && partition !== owner.webContents.session && !partition.isPersistent());
  const probe = await wc.executeJavaScript('({ api:typeof window.api, require:typeof require, process:typeof process, external:window.externalAssetLoaded, width:getComputedStyle(document.documentElement,"::-webkit-scrollbar").width })');
  check('preview has no Node or Relay bridge', probe.api === 'undefined' && probe.require === 'undefined' && probe.process === 'undefined');
  check('HTTP static assets execute inside the isolated preview', probe.external === true && requests.some(r => r.url === '/theme.css'));
  check('static dependencies do not receive saved browser cookies', requests.filter(r => ['/script.js', '/theme.css'].includes(r.url)).every(r => r.cookie === ''));
  check('preview uses Relay scrollbar styling', probe.width === '9px');
  await wc.executeJavaScript('counter.click()');
  check('inline JavaScript and DOM interactions work', await wc.executeJavaScript('counter.textContent') === 'Count 1');
  const find = await host.invoke({ action: 'find', id: preview.id, text: 'findable' });
  await waitFor(() => events.some(e => e.type === 'find' && e.requestId === find.requestId && e.finalUpdate), 'Find did not finish');
  check('native find reports preview matches', events.some(e => e.type === 'find' && e.requestId === find.requestId && e.matches === 1));
  await host.invoke({ action: 'zoom', id: preview.id, factor: 1.25 }); check('native preview zoom works', wc.getZoomFactor() === 1.25);
  await host.invoke({ action: 'zoom', id: preview.id, factor: 1 });
  await host.invoke({ action: 'devTools', id: preview.id, open: true });
  await waitFor(() => wc.isDevToolsOpened(), 'Preview devtools failed'); check('preview developer tools can open', wc.isDevToolsOpened());
  await host.invoke({ action: 'devTools', id: preview.id, open: false });
  const capture = await host.invoke({ action: 'capture', id: preview.id }); assert.equal(capture.ok, true, JSON.stringify(capture));
  fs.writeFileSync(path.join(out, 'preview-native.png'), Buffer.from(capture.dataUrl.split(',')[1], 'base64'));
  check('preview screenshots capture the actual web view', capture.dataUrl.startsWith('data:image/png;'));
  const pdf = await wc.printToPDF({ printBackground: true }); check('preview can render PDF without a local HTML file', pdf.length > 1000 && pdf.subarray(0, 4).toString() === '%PDF');
  await host.invoke({ action: 'reload', id: preview.id }); await loaded(preview.id, 'Interactive code preview');
  await waitFor(async () => await wc.executeJavaScript('window.count') === 0, 'Reload did not reset the page');
  check('reload rereads the same memory document', await wc.executeJavaScript('counter.textContent') === 'Count 0');
  const copied = await host.invoke({ action: 'duplicatePreview', id: preview.id, clientRequestId: 'duplicate-native' }); assert.equal(copied.ok, true); await loaded(copied.id, 'Interactive code preview');
  const copiedContents = contentsFor(copied.id);
  check('duplicate retains memory source with a new URL and independent session', copied.tab.isPreview && copied.tab.url !== preview.tab.url && copiedContents.session !== partition && await copiedContents.executeJavaScript('window.count') === 0);
  check('preview source never appears in public state or events', !JSON.stringify([host.state(), events]).includes('window.count=0'));
  check('bookmark keyboard fallback is rejected by the backend', (await host.invoke({ action: 'bookmark', id: preview.id })).code === 'PREVIEW_PRIVATE');
  for (const url of ['file:///C:/Windows/win.ini', 'data:text/html,evil', 'javascript:alert(1)', copied.tab.url]) {
    assert.equal((await host.invoke({ action: 'navigate', id: preview.id, url })).ok, false);
  }
  check('preview cannot navigate to native files, data documents or another preview', wc.getURL() === preview.tab.url);
  await wc.executeJavaScript('window.fileProbe="waiting"; const s=document.createElement("script");s.src="file:///C:/Windows/win.ini";s.onload=()=>window.fileProbe="loaded";s.onerror=()=>window.fileProbe="blocked";document.head.append(s)');
  await waitFor(async () => await wc.executeJavaScript('window.fileProbe') === 'blocked', 'Local resource was not blocked');
  check('local file subresources are blocked in native Chromium', await wc.executeJavaScript('window.fileProbe') === 'blocked');
  await wc.executeJavaScript('popup.click()'); await waitFor(() => events.some(e => e.type === 'created' && e.openerId === preview.id), 'Preview popup failed');
  const popup = events.find(e => e.type === 'created' && e.openerId === preview.id); await loaded(popup.id, 'Normal site');
  const popupContents = contentsFor(popup.id);
  check('web popups remain isolated from saved browser session', popupContents.session !== normalContents.session && await popupContents.executeJavaScript('document.cookie') === '');
  await host.invoke({ action: 'navigate', id: preview.id, url: base + '/from-preview' }); await loaded(preview.id, 'Normal site');
  check('typing a website uses the same tab with normal URL state', host.state(preview.id).tab.isPreview === false && wc.getURL() === base + '/from-preview');
  check('web navigation retains cookie and storage isolation', await wc.executeJavaScript('document.cookie') === '' && await wc.executeJavaScript('localStorage.getItem("saved")') === null);
  await host.invoke({ action: 'back', id: preview.id }); await loaded(preview.id, 'Interactive code preview');
  check('back restores the interactive memory preview', host.state(preview.id).tab.isPreview && wc.getURL() === preview.tab.url);
  await host.invoke({ action: 'forward', id: preview.id }); await loaded(preview.id, 'Normal site');
  check('forward returns to the manually entered website', !host.state(preview.id).tab.isPreview && wc.getURL() === base + '/from-preview');
  const history = await host.invoke({ action: 'history.list' });
  check('preview and its temporary browsing do not enter persistent history', history.items.length === 1 && history.items[0].url === base + '/normal');
  await host.invoke({ action: 'close', id: preview.id }); await waitFor(() => wc.isDestroyed(), 'Preview did not close');
  check('closing the preview unregisters the memory protocol', !(await partition.protocol.isProtocolHandled('relay-preview')));
  await host.invoke({ action: 'reload', id: copied.id }); await loaded(copied.id, 'Interactive code preview');
  check('closing the original does not destroy its independent duplicate', !copiedContents.isDestroyed() && await copiedContents.executeJavaScript('window.externalAssetLoaded') === true);
  host.destroy(); await waitFor(() => copiedContents.isDestroyed() && normalContents.isDestroyed() && popupContents.isDestroyed(), 'Owned views leaked');
  check('host disposal closes every browser and preview view', host.isDestroyed());
}
deadline = setTimeout(() => { console.error('Preview smoke deadline exceeded'); app.exit(1); }, 95000);
run().then(() => {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks: results.length, results, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: results.length }));
}).catch(error => {
  console.error(error.stack); process.exitCode = 1;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, checks: results.length, results, error: String(error.stack), events, requests }, null, 2));
}).finally(async () => {
  clearTimeout(deadline); host?.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (owner && !owner.isDestroyed()) owner.destroy();
  app.exit(process.exitCode || 0);
});
