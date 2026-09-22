'use strict';

// Run with Electron, never with a user's real Relay profile. Loopback-only
// pages exercise Chromium views, isolation, navigation and cleanup offline.
const { app, BrowserWindow, WebContentsView, session, webContents } = require('electron');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-smoke-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  throw Error(message);
}
let window, host, server;
const extraOwners = [], extraHosts = [];
const artifactDir = path.join(__dirname, '..', '.codex-tmp', 'browser-host-smoke');
const results = [], events = [];
const startedAt = new Date().toISOString();
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: false, state: 'running', startedAt, checks: 0 }, null, 2));
function check(name, value) { assert.ok(value, name); results.push(name); console.log('[pass]', name); }
async function run() {
  console.log('[fixture pid]', process.pid);
  server = http.createServer((request, response) => {
    if (request.url === '/escape') { response.writeHead(302, { Location: 'file:///relay-browser-forbidden' }); response.end(); return; }
    if (request.url === '/download') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); response.end('synthetic export'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Fixture ${request.url}</title><h1>Relay browser fixture</h1><p>findable findable</p><a id="next" href="/next">Next</a><a id="popup" target="_blank" href="/popup">Popup</a><a id="download" href="/download">Download</a>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  window = new BrowserWindow({ width: 940, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Host fixture</title><body style="margin:0;background:%23eee">Local Relay fixture</body>');
  host = createBrowserPanelHost({ owner: window, WebContentsView, session, shell: { openExternal: async () => { throw Error('No external browsing in fixture'); } }, onEvent: value => events.push(value) });
  const first = await host.invoke({ action: 'create', url: base + '/first' });
  assert.equal(first.ok, true);
  await host.invoke({ action: 'setBounds', rect: { x: 440, y: 90, width: 460, height: 530 } });
  await host.invoke({ action: 'visibility', id: first.id, visible: true }); window.show();
  await waitFor(() => host.state(first.id).tab.title === 'Fixture /first' && !host.state(first.id).tab.loading, 'First page did not finish');
  const firstContents = webContents.getAllWebContents().find(contents => host.ownsWebContents(contents) && contents.getURL() === base + '/first');
  const capabilities = await firstContents.executeJavaScript('({api:typeof window.api,require:typeof require,process:typeof process})');
  check('remote page has no Relay bridge, require or process', capabilities.api === 'undefined' && capabilities.require === 'undefined' && capabilities.process === 'undefined');
  check('browser session is separate from owner', firstContents.session !== window.webContents.session);
  const preferences = firstContents.getLastWebPreferences();
  check('real Chromium WebContents uses sandbox and isolation', preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
  // Loading completion can precede Chromium's first compositor frame.
  await Promise.race([
    firstContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
    pause(6000).then(() => { throw Error('Visible webpage did not reach its first compositor frame'); }),
  ]);
  const capture = await host.invoke({ action: 'capture', id: first.id });
  assert.ok(capture.ok, JSON.stringify(capture));
  check('visible native webpage capture returns an image', capture.ok && /^data:image\/png;base64,/.test(capture.dataUrl));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'browser-page.png'), Buffer.from(capture.dataUrl.split(',')[1], 'base64'));
  await firstContents.executeJavaScript('document.cookie="fixture_cookie=one"; localStorage.setItem("fixture","one")');
  const second = await host.invoke({ action: 'create', url: base + '/second' });
  await waitFor(() => host.state(second.id).tab.title === 'Fixture /second' && !host.state(second.id).tab.loading, 'Second page did not finish');
  const secondContents = webContents.getAllWebContents().find(contents => host.ownsWebContents(contents) && contents.getURL() === base + '/second');
  const storage = await secondContents.executeJavaScript('({cookie:document.cookie,stored:localStorage.getItem("fixture")})');
  check('same-origin tabs keep independent cookies and local storage', storage.cookie === '' && storage.stored === null);
  await host.invoke({ action: 'navigate', id: first.id, url: base + '/next' });
  await waitFor(() => host.state(first.id).tab.title === 'Fixture /next' && !host.state(first.id).tab.loading, 'Next page did not finish');
  check('real navigation history supports back', host.state(first.id).tab.canGoBack);
  await host.invoke({ action: 'back', id: first.id });
  await waitFor(() => host.state(first.id).tab.url === base + '/first' && !host.state(first.id).tab.loading, 'Back navigation did not finish');
  check('back returns the original real page and exposes forward', host.state(first.id).tab.canGoForward);
  const find = await host.invoke({ action: 'find', id: first.id, text: 'findable' });
  try { await waitFor(() => events.some(event => event.type === 'find' && event.requestId === find.requestId && event.finalUpdate), 'Native find did not finish'); }
  catch (error) { console.error(JSON.stringify({ find, events: events.filter(event => event.type === 'find'), visible: window.isVisible(), minimized: window.isMinimized(), document: await firstContents.executeJavaScript('({state:document.visibilityState,text:document.body.innerText})') })); throw error; }
  check('native find returns both matches', events.some(event => event.type === 'find' && event.requestId === find.requestId && event.matches === 2));
  await host.invoke({ action: 'focus', id: first.id });
  firstContents.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
  firstContents.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] });
  await waitFor(() => events.some(event => event.type === 'shortcut' && event.action === 'address'), 'Native Ctrl+L did not reach toolbar');
  check('native Ctrl+L routes only to browser toolbar', events.some(event => event.type === 'shortcut' && event.id === first.id && event.action === 'address'));
  await host.invoke({ action: 'zoom', id: first.id, factor: 1.25 });
  check('native zoom is applied', firstContents.getZoomFactor() === 1.25);
  await firstContents.executeJavaScript('document.getElementById("popup").click()');
  await waitFor(() => events.some(event => event.type === 'created' && event.openerId === first.id), 'Popup was not redirected into a tab');
  check('popup creates an isolated internal tab', host.state().tabs.length === 3 && BrowserWindow.getAllWindows().length === 1);
  // A programmatic click is deliberately not supplied a synthetic user gesture.
  // It must not produce a native save dialog in this unattended fixture.
  await firstContents.executeJavaScript('document.getElementById("download").click()');
  await waitFor(() => events.some(event => event.type === 'download' && event.status === 'blocked'), 'Drive-by download was not blocked');
  check('script-only download is blocked', !events.some(event => event.type === 'download' && event.status === 'started'));
  await host.invoke({ action: 'navigate', id: first.id, url: base + '/escape' });
  await waitFor(() => !!host.state(first.id).tab.error, 'Forbidden redirect was not reported');
  check('redirect cannot load local files', !firstContents.getURL().startsWith('file:'));
  await host.invoke({ action: 'visibility', visible: false });
  check('hiding preserves loaded tabs', !host.state().visible && !secondContents.isDestroyed());
  await host.invoke({ action: 'close', id: second.id });
  await waitFor(() => secondContents.isDestroyed(), 'Closed tab WebContents leaked');
  check('closing a tab destroys its native contents', !host.state().tabs.some(tab => tab.id === second.id));
  async function lifecyclePair(name, beforeHost) {
    const owner = new BrowserWindow({ show: false, width: 420, height: 320, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    extraOwners.push(owner);
    await owner.loadURL('data:text/html,<title>Lifecycle fixture</title>');
    if (beforeHost) beforeHost(owner);
    const panel = createBrowserPanelHost({ owner, WebContentsView, session }); extraHosts.push(panel);
    const created = await panel.invoke({ action: 'create', url: base + '/' + name });
    await waitFor(() => panel.state(created.id).tab.title === 'Fixture /' + name && !panel.state(created.id).tab.loading, 'Lifecycle page did not finish');
    const children = webContents.getAllWebContents().filter(contents => panel.ownsWebContents(contents));
    return { owner, panel, children };
  }
  // Match Relay's normal before-quit order: its registry disposes all browser
  // views before the main BrowserWindow is torn down.
  const shutdown = await lifecyclePair('shutdown'); shutdown.panel.destroy();
  await waitFor(() => shutdown.children.every(contents => contents.isDestroyed()), 'Explicit host disposal leaked native children');
  shutdown.owner.destroy();
  check('host disposal followed by owner destruction releases all pages', shutdown.owner.isDestroyed() && shutdown.children.every(contents => contents.isDestroyed()));
  let closeToTray = true;
  const closing = await lifecyclePair('closing', owner => owner.on('close', event => { if (closeToTray) { event.preventDefault(); owner.hide(); } }));
  closing.owner.close(); await pause(50);
  check('close-to-tray preserves the browser task', !closing.owner.isDestroyed() && !closing.panel.isDestroyed() && closing.children.every(contents => !contents.isDestroyed()));
  closeToTray = false; closing.owner.close();
  await waitFor(() => closing.owner.isDestroyed() && closing.children.every(contents => contents.isDestroyed()), 'Normal owner close leaked browser renderers');
  check('normal owner close releases its browser children before teardown', closing.panel.isDestroyed());
  const crashed = await lifecyclePair('crashed'); crashed.owner.webContents.forcefullyCrashRenderer();
  await waitFor(() => crashed.panel.isDestroyed() && crashed.children.every(contents => contents.isDestroyed()), 'Owner renderer crash leaked browser renderers');
  check('owner renderer crash releases its browser children', crashed.panel.isDestroyed());
  const retained = webContents.getAllWebContents().filter(contents => host.ownsWebContents(contents));
  host.destroy();
  await waitFor(() => retained.every(contents => contents.isDestroyed()), 'Final host disposal leaked browser renderers');
  check('final disposal leaves no owned browser WebContents', !webContents.getAllWebContents().some(contents => host.ownsWebContents(contents)));
  const result = { ok: true, state: 'complete', startedAt, finishedAt: new Date().toISOString(), checks: results.length, results };
  fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => {
  console.error(error.stack || error); process.exitCode = 1;
  fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: false, state: 'failed', startedAt, finishedAt: new Date().toISOString(), checks: results.length, results, error: String(error.stack || error) }, null, 2));
}).finally(async () => {
  if (host) host.destroy();
  for (const panel of extraHosts) panel.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  for (const owner of extraOwners) if (!owner.isDestroyed()) owner.destroy();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(process.exitCode || 0);
});
