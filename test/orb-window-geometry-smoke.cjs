'use strict';

// Real Windows windows, production orb renderer/preload, isolated profile and
// settings. Cursor samples are synthetic; this does not control the user's mouse.
const { app, BrowserWindow, screen, Menu, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createMiniWindowHost } = require('../src/main/app/mini-window-host');

const root = path.resolve(__dirname, '..');
const out = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT)
  : path.join(root, '.codex-tmp/orb-window-geometry-validation');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
let host, finished = false;
const report = { versions: process.versions, runs: [], errors: [],
  evidence: { nativeWindows: true, syntheticCursor: true, realPointerCapture: false, realUserProfile: false,
    desktopCompositeCaptured: false, pageImagesCaptured: true } };
const brand = { name: 'Relay', theme: 'light', logo: null };
ipcMain.handle('mini:brand', () => brand);
ipcMain.handle('mini:state', () => ({ ...host.getState(), brand, running: false }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => finish(Error('Orb geometry fixture timed out')), 55000);

function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  if (error) report.errors.push(error.stack || String(error));
  report.gpu = app.getGPUFeatureStatus(); host?.destroy();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, runs: report.runs.map(run => ({ display: run.display,
    snapshots: run.snapshots.length, dimensions: run.snapshots.map(s => [s.label, s.bounds.width, s.bounds.height]) })), errors: report.errors }));
  app.exit(report.errors.length ? 1 : 0);
}

async function ready(win) {
  const started = Date.now();
  while (!win.isVisible()) {
    if (Date.now() - started > 5000) throw Error('Orb did not become visible');
    await delay(20);
  }
  await delay(100);
}

async function snapshot(win, label, run) {
  const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const dom = await win.webContents.executeJavaScript(`({ innerWidth, innerHeight, devicePixelRatio,
    orb: document.getElementById('relayOrb').getBoundingClientRect().toJSON() })`);
  const row = { label, bounds, content: win.getContentBounds(), dom };
  run.snapshots.push(row);
  // Windows can enclose a fractional-DPI rect by an extra pixel at either edge;
  // constructor positioning can add a third DIP. This allowance is absolute,
  // not relative to the previous native size, so repeated growth still fails.
  assert.ok(bounds.width >= 64 && bounds.width <= 67, `${label}: orb width grew: ${bounds.width}`);
  assert.ok(bounds.height >= 64 && bounds.height <= 67, `${label}: orb height grew: ${bounds.height}`);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y
    && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height,
  `${label}: orb escaped work area`);
  assert.equal(dom.orb.width, 48); assert.equal(dom.orb.height, 48);
  assert.ok(dom.orb.left >= 0 && dom.orb.top >= 0 && dom.orb.right <= dom.innerWidth && dom.orb.bottom <= dom.innerHeight,
    `${label}: button is outside the renderer viewport`);
  const image = await win.webContents.capturePage();
  row.captureSize = image.getSize();
  fs.writeFileSync(path.join(out, label + '.png'), image.toPNG());
  // A solid central horizontal span of the circular button must be present.
  // This detects clipping in page capture, not Windows' final desktop surface.
  const bitmap = image.toBitmap(), width = image.getSize().width;
  const y = Math.round((dom.orb.top + 24) * dom.devicePixelRatio);
  const left = Math.ceil((dom.orb.left + 2) * dom.devicePixelRatio);
  const right = Math.floor((dom.orb.right - 2) * dom.devicePixelRatio);
  for (let x = left; x < right; x++) assert.ok(bitmap[(y * width + x) * 4 + 3] >= 200, `${label}: captured circle is cut off at ${x}`);
}

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'This smoke test requires Windows Electron');
  const displays = screen.getAllDisplays();
  report.displays = displays.map(d => ({ id: d.id, scaleFactor: d.scaleFactor, bounds: d.bounds, workArea: d.workArea }));
  for (const [index, display] of displays.entries()) {
    const area = display.workArea;
    let cursor = { x: area.x + 100, y: area.y + 100 };
    let settings = { quickChatEnabled: true, floatingOrbPosition: { ...cursor } };
    const adapter = new EventEmitter();
    adapter.getCursorScreenPoint = () => ({ ...cursor });
    adapter.getDisplayMatching = rect => screen.getDisplayMatching(rect);
    adapter.getDisplayNearestPoint = point => screen.getDisplayNearestPoint(point);
    host = createMiniWindowHost({ BrowserWindow, screen: adapter, Menu, rootDir: root,
      readSettings: () => settings, writeSettings: next => { settings = next; }, onError: error => report.errors.push(error.message) });
    host.start(); let orb = host.getOrbWindow(); await ready(orb);
    const run = { display: report.displays[index], snapshots: [] }; report.runs.push(run);
    await snapshot(orb, index + '-initial', run);
    for (let i = 0; i < 60; i++) {
      host.orbDrag({ phase: 'start' });
      await orb.webContents.executeJavaScript("relayOrb.classList.add('is-dragging')");
      cursor.x += 5; cursor.y += 7;
      host.orbDrag({ phase: 'move' }); host.orbDrag({ phase: i % 2 ? 'end' : 'cancel' });
      await orb.webContents.executeJavaScript("relayOrb.classList.remove('is-dragging')");
      await delay(5);
      const bounds = orb.getBounds();
      assert.ok(bounds.width <= 67 && bounds.height <= 67, `drag ${i}: dimensions accumulated`);
    }
    await delay(350); await snapshot(orb, index + '-60-drags', run);
    const other = displays[(index + 1) % displays.length];
    for (let i = 0; i < 4; i++) {
      const destination = i % 2 ? display : other, current = orb.getBounds();
      host.orbDrag({ phase: 'start' });
      cursor.x += destination.workArea.x + 100 - current.x;
      cursor.y += destination.workArea.y + 100 - current.y;
      host.orbDrag({ phase: 'end' }); await delay(100);
      await snapshot(orb, index + '-cross-' + i, run);
    }
    // Simulate an already-inflated window surviving a display topology change.
    orb.setBounds({ ...orb.getBounds(), width: 144, height: 146 });
    adapter.emit('display-metrics-changed'); await delay(100);
    await snapshot(orb, index + '-display-reset', run);
    host.hideOrbForSession(); host.showOrb(); orb = host.getOrbWindow(); await ready(orb);
    await snapshot(orb, index + '-reopened', run);
    assert.equal(host.getPanelWindow(), null, 'geometry validation must not create a chat');
    host.destroy(); host = null;
  }
  finish();
}).catch(finish);
