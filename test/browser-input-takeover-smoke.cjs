'use strict';

const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserAutomationService } = require('../src/main/browser/browser-automation-service');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-takeover-'));
app.setPath('userData', profile); app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const artifactDir = path.join(__dirname, '..', '.codex-tmp', 'browser-input-takeover'); fs.mkdirSync(artifactDir, { recursive: true });
const checks = [], events = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = value => fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(value, null, 2));
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
let owner, host, service, server;
const timeout = setTimeout(() => { save({ ok: false, error: 'timeout', checks, events }); app.exit(1); }, 45000);
save({ ok: false, state: 'running' });
async function until(test, message) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (await test()) return; await pause(30); } throw Error(message); }
async function run() {
  server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Takeover fixture</title><style>body{margin:30px}input,button{padding:10px;margin:8px}#space{height:2000px}</style><label>Name <input id="name"></label><button id="press">Press fixture</button><p id="status">Waiting</p><div id="space"></div><script>window.fixtureClicks=0;window.fixtureInputs=[];document.getElementById("press").onclick=()=>{window.fixtureClicks++;document.getElementById("status").textContent="Clicked"};for(const type of ["pointerdown","wheel"])document.addEventListener(type,e=>window.fixtureInputs.push({type,x:e.clientX,y:e.clientY,deltaX:e.deltaX,deltaY:e.deltaY}),true)</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  await app.whenReady();
  owner = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Isolated takeover fixture</title>');
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, onEvent(event) {
    if (event.type === 'manual-action') { events.push({ type: event.type, action: event.action }); service?.control({ action: 'pause', id: event.id }); }
    service?.handleHostEvent(event);
  } });
  // Mirror the production renderer's presentation acknowledgement. Opening
  // while the owner is hidden and showing only after open returns cannot
  // satisfy the service's layout handshake and can leave Chromium occluded.
  owner.show(); host.setBounds({ x: 0, y: 0, width: 870, height: 630 });
  service = createBrowserAutomationService({ getHost: () => host, onEvent(event) {
    if (event.type === 'automation-open') host.setVisibility(true, event.tab.id);
  } });
  const context = { conversationId: 'takeover-fixture', runId: 'run-one', cwd: profile, isCurrent: () => true };
  const opened = await service.invoke(context, { action: 'open', url: base + '/' }); assert.ok(opened.ok, JSON.stringify(opened));
  assert.equal(opened.tab.presented, true, 'open waits for the fixture presentation handshake');
  const id = opened.tab.id, wc = host.getAutomationTarget(id).webContents;
  const sendCommand = wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand = (method, ...args) => {
    const record = { type: 'cdp-command', method, startedAt: Date.now() }; events.push(record);
    return sendCommand(method, ...args).then(result => { record.elapsedMs = Date.now() - record.startedAt; record.completed = true; return result; },
      error => { record.elapsedMs = Date.now() - record.startedAt; record.error = error.code || error.name; throw error; });
  };
  wc.on('ipc-message', (event, channel, payload) => {
    if (channel === 'browser:page-event' && ['input-ready', 'input-consumed', 'manual-pointer'].includes(payload?.type))
      events.push({ type: payload.type, mainFrame: event.senderFrame === wc.mainFrame });
  });
  wc.on('preload-error', () => events.push({ type: 'preload-error' }));
  const send = wc.send.bind(wc);
  wc.send = (channel, payload) => { if (channel === 'relay:browser-input-prepare') events.push({ type: 'input-intent', expected: payload.expected }); return send(channel, payload); };
  host.setBounds({ x: 0, y: 0, width: 870, height: 630 }); host.setVisibility(true, id); owner.show(); wc.focus();
  await until(() => wc.getTitle() === 'Takeover fixture' && !wc.isLoading(), 'Fixture did not load');
  await pause(200);
  async function observe() { const result = await service.invoke(context, { action: 'observe', id }); assert.ok(result.ok, JSON.stringify(result)); return result.observation || result; }
  let observation = await observe();
  const find = name => { const item = observation.elements.find(element => element.name === name); assert.ok(item, 'Observed ' + name); return item.ref; };
  let action = await service.invoke(context, { action: 'act', id, kind: 'click', observationId: observation.observationId, ref: find('Press fixture') });
  if (!action.ok) {
    events.push({ type: 'failure-window-state', visible: owner.isVisible(), minimized: owner.isMinimized(), focused: owner.isFocused(),
      pageFocused: wc.isFocused(), page: await wc.executeJavaScript('({visible:document.visibilityState,clicks:window.fixtureClicks,inputs:window.fixtureInputs.length})') });
    throw Error('Initial model click: ' + JSON.stringify(action));
  }
  check('model click completes its preload handshake without self-pausing', action.ok && service.control({ action: 'state', id }).state !== 'paused');
  check('model click changed the page', await wc.executeJavaScript('document.getElementById("status").textContent') === 'Clicked');
  observation = await observe();
  action = await service.invoke(context, { action: 'act', id, kind: 'fill', observationId: observation.observationId, ref: find('Name'), text: 'Model input' });
  if (!action.ok) throw Error('Initial model fill: ' + JSON.stringify(action));
  check('CDP model typing does not trigger native keyboard takeover', action.ok && service.control({ action: 'state', id }).state !== 'paused');
  observation = await observe();
  action = await service.invoke(context, { action: 'act', id, kind: 'scroll', observationId: observation.observationId, x: 500, y: 300, deltaY: 80, deltaX: 0 });
  check('model wheel completes its exact-event handshake without self-pausing', action.ok && service.control({ action: 'state', id }).state !== 'paused');
  for (const zoom of [1.25, 1.5]) {
    await host.invoke({ action: 'zoom', id, factor: zoom });
    await wc.executeJavaScript('scrollTo(0,0)'); await pause(100);
    observation = await observe();
    const beforeClicks = await wc.executeJavaScript('window.fixtureClicks');
    action = await service.invoke(context, { action: 'act', id, kind: 'click', observationId: observation.observationId, ref: find('Press fixture') });
    if (!action.ok) throw Error('Zoom click ' + zoom + ': ' + JSON.stringify(action));
    check('zoom ' + zoom + ' model click reaches the selected DOM control without takeover',
      service.control({ action: 'state', id }).state !== 'paused' && await wc.executeJavaScript('window.fixtureClicks') === beforeClicks + 1);
    observation = await observe();
    const text = 'Model zoom ' + zoom;
    action = await service.invoke(context, { action: 'act', id, kind: 'fill', observationId: observation.observationId, ref: find('Name'), text });
    if (!action.ok) throw Error('Zoom fill ' + zoom + ': ' + JSON.stringify(action));
    check('zoom ' + zoom + ' model fill changes the intended value without takeover',
      service.control({ action: 'state', id }).state !== 'paused' && await wc.executeJavaScript('document.getElementById("name").value') === text);
    observation = await observe();
    const viewport = await wc.executeJavaScript('({width:innerWidth,height:innerHeight,scrollY})');
    action = await service.invoke(context, { action: 'act', id, kind: 'scroll', observationId: observation.observationId,
      x: Math.floor(viewport.width * 0.8), y: Math.floor(viewport.height * 0.65), deltaY: 80, deltaX: 0 });
    events.push({ type: 'zoom-fixture-events', zoom, events: await wc.executeJavaScript('window.fixtureInputs') });
    if (!action.ok) throw Error('Zoom wheel ' + zoom + ': ' + JSON.stringify(action));
    check('zoom ' + zoom + ' model wheel changes scroll position without takeover',
      service.control({ action: 'state', id }).state !== 'paused' && await wc.executeJavaScript('scrollY') > viewport.scrollY);
  }
  await host.invoke({ action: 'zoom', id, factor: 1 });
  await wc.executeJavaScript('scrollTo(0,0)'); await pause(100);
  const point = await wc.executeJavaScript('(()=>{const r=document.getElementById("press").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await until(() => service.control({ action: 'state', id }).state === 'paused', 'Native comparator mouse did not take over');
  check('unmatched trusted mouse input pauses the task', events.some(event => event.action === 'pointer'));
  service.control({ action: 'resume', id, conversationId: context.conversationId });
  wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'A' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  await until(() => service.control({ action: 'state', id }).state === 'paused', 'Native key did not take over');
  check('native keyboard input pauses the task', events.some(event => event.action === 'keyboard'));
  save({ ok: true, electron: process.versions.electron, checks, events,
    limitations: ['Native input uses sendInputEvent comparator, not a physical OS device.', 'Pointer takeover currently covers the main frame; cross-origin iframe pointer signals are not installed.'] });
}
run().then(() => { clearTimeout(timeout); service?.dispose(); host?.destroy(); owner?.destroy(); server?.close(); app.exit(0); })
  .catch(error => { clearTimeout(timeout); save({ ok: false, error: error.stack, checks, events }); try { service?.dispose(); host?.destroy(); owner?.destroy(); server?.close(); } catch (_) {} app.exit(1); });
