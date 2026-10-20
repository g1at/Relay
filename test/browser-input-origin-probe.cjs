'use strict';

// Native characterization only: local disposable fixture, no existing windows
// or profiles. Root schedules this separately from other Electron UI tests.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-input-probe-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const artifactDir = path.join(__dirname, '..', '.codex-tmp', 'browser-input-origin-probe');
fs.mkdirSync(artifactDir, { recursive: true });
const save = value => fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(value, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [], events = [];
let owner, view, server, phase = 'setup';
const timer = setTimeout(() => { save({ ok: false, error: 'timeout', cases, events }); app.exit(1); }, 30000);
save({ ok: false, state: 'running' });

async function run() {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Input origin probe</title><input id="field" style="margin:30px"><button id="button">Fixture</button><div style="height:2000px"></div><script>window.probeEvents=[];for(const type of ["keydown","keyup","mousedown","mouseup","click","wheel","input"]){document.addEventListener(type,e=>window.probeEvents.push({type,trusted:e.isTrusted,key:e.key,button:e.button}),true)}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  owner = new BrowserWindow({ width: 700, height: 500, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const isolated = session.fromPartition('relay-input-probe-' + process.pid);
  const base = 'http://127.0.0.1:' + server.address().port;
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base + '/') }));
  view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  owner.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 680, height: 440 });
  const wc = view.webContents;
  for (const channel of ['before-input-event', 'before-mouse-event']) wc.on(channel, (_event, input) => {
    const safe = {};
    for (const key of ['type', 'key', 'code', 'isAutoRepeat', 'shift', 'control', 'alt', 'meta', 'x', 'y', 'button', 'modifiers', 'deltaX', 'deltaY']) if (input[key] !== undefined) safe[key] = input[key];
    events.push({ phase, channel, input: safe });
  });
  await wc.loadURL(base + '/'); owner.show(); wc.focus();
  await pause(150); wc.debugger.attach('1.3');
  const point = await wc.executeJavaScript('(()=>{const r=document.getElementById("button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  async function sample(name, action) {
    await wc.executeJavaScript('window.probeEvents=[];document.getElementById("field").focus()');
    phase = name; const start = events.length;
    await action(); await pause(150);
    cases.push({ name, nativeEvents: events.slice(start), domEvents: await wc.executeJavaScript('window.probeEvents') });
    phase = 'between';
  }
  await sample('cdp-key', async () => {
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  });
  await sample('native-key', async () => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
    wc.sendInputEvent({ type: 'char', keyCode: 'a' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  });
  await sample('cdp-mouse', async () => {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  });
  await sample('native-mouse', async () => {
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
  });
  await sample('cdp-wheel', () => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 50 }));
  await sample('native-wheel', async () => wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(point.x), y: Math.round(point.y), deltaX: 0, deltaY: 50, canScroll: true }));
  await sample('cdp-tap', () => wc.debugger.sendCommand('Input.synthesizeTapGesture', { ...point, gestureSourceType: 'mouse' }));
  await sample('cdp-insert-text', () => wc.debugger.sendCommand('Input.insertText', { text: 'fixture' }));
  save({ ok: true, electron: process.versions.electron, chrome: process.versions.chrome,
    caveat: 'sendInputEvent is a native injection comparator; no physical OS mouse/keyboard was exercised.', cases });
}
run().then(() => { clearTimeout(timer); try { view.webContents.debugger.detach(); view.webContents.close(); owner.destroy(); } catch (_) {} server.close(); app.exit(0); })
  .catch(error => { clearTimeout(timer); save({ ok: false, error: error.stack, cases, events }); try { server?.close(); } catch (_) {} app.exit(1); });
