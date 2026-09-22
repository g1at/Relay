'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const { ipcMain } = require('electron');
const root = path.resolve(__dirname, '..');
const out = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT) : path.join(root, '.codex-tmp', 'browser-panel-ipc-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { results: {}, failures: [] };
let owner, foreign, registry, server;
const deadline = setTimeout(() => { console.error('Browser IPC smoke timed out'); app.exit(1); }, 75000);
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await predicate()) return; await tick(25); }
  throw new Error('Browser IPC state did not settle');
}
function check(name, condition) { report.results[name] = !!condition; if (!condition) throw new Error(name); }
const evaluate = (source, win = owner) => win.webContents.executeJavaScript(source);
const invoke = input => evaluate(`api.browser.invoke(${JSON.stringify(input)})`);
function createWindow() {
  return new BrowserWindow({ width: 940, height: 700, show: false,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
}
app.whenReady().then(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Relay native browser</title><h1>Local test delivery</h1><p>Independent browser contents.</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const entry = path.join(out, 'fixture.html');
  fs.writeFileSync(entry, '<!doctype html><meta charset="utf-8"><title>Relay browser IPC fixture</title><p>Trusted owner fixture</p>');
  owner = createWindow();
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => owner, entryFile: entry });
  await owner.loadFile(entry); owner.show();
  check('production preload exposes narrow browser bridge without Node', await evaluate('typeof api.browser.invoke === "function" && typeof api.browser.onEvent === "function" && typeof require === "undefined"'));
  await evaluate('window.browserEvents=[];window.unlisten=api.browser.onEvent(e=>browserEvents.push(e));true');
  const first = await invoke({ action: 'create', url });
  check('trusted main document creates a real browser tab', first.ok && !!first.id);
  await until(async () => (await invoke({ action: 'state', id: first.id })).tab?.title === 'Relay native browser');
  check('state events reach production preload listener', await evaluate('browserEvents.some(e=>e.type==="state"&&e.tab.title==="Relay native browser")'));
  owner.webContents.setZoomFactor(1.25);
  const bounds = await invoke({ action: 'setBounds', rect: { x: 100, y: 100, width: 500, height: 350 }, coordinateScale: 9 });
  check('main process uses actual owner zoom for native bounds', bounds.rect.x === 125 && bounds.rect.width === 625 && bounds.rect.y === 125);
  await invoke({ action: 'visibility', id: first.id, visible: true });
  const view = owner.contentView.children.find(child => child.webContents && child.webContents !== owner.webContents);
  check('native page stays inside supplied viewport', view && view.getBounds().x === 125 && view.getBounds().width === 625);
  check('loaded webpage has no Relay or Electron capabilities', await view.webContents.executeJavaScript('typeof api === "undefined" && typeof require === "undefined" && typeof process === "undefined"'));
  check('local filesystem navigation is rejected', !(await invoke({ action: 'navigate', id: first.id, url: 'file:///C:/Windows/win.ini' })).ok);
  foreign = createWindow(); await foreign.loadFile(entry);
  check('foreign window with real preload cannot access browser tabs', (await evaluate('api.browser.invoke({action:"state"})', foreign)).code === 'FORBIDDEN');
  await evaluate('window.frame=document.createElement("iframe");frame.src="about:blank";document.body.append(frame);true');
  await tick(80);
  const childFrame = owner.webContents.mainFrame.frames[0];
  check('child frame receives no browser bridge', childFrame && await childFrame.executeJavaScript('typeof window.api === "undefined"'));
  const remoteContents = view.webContents;
  await owner.loadURL('data:text/html,<title>Untrusted replacement</title>');
  check('same window after navigation cannot use browser IPC', (await evaluate('api.browser.invoke({action:"state"})')).code === 'FORBIDDEN');
  await until(() => remoteContents.isDestroyed());
  check('owner navigation cleans up browser renderers', remoteContents.isDestroyed());
  await owner.loadFile(entry);
  const replacement = await invoke({ action: 'create' });
  check('returning local document creates fresh host', replacement.ok && replacement.id !== first.id);
  await invoke({ action: 'close', id: replacement.id });
  check('closing last browser tab leaves no native child', (await invoke({ action: 'state' })).tabs.length === 0);
}).catch(error => report.failures.push(error.stack || error.message)).finally(async () => {
  clearTimeout(deadline);
  if (registry) registry.dispose();
  if (foreign && !foreign.isDestroyed()) foreign.destroy();
  if (owner && !owner.isDestroyed()) owner.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.failures.length ? 1 : 0);
});
