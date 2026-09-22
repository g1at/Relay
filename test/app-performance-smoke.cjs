'use strict';

// Actual Relay startup with synthetic history and an isolated home/userData.
// No credentials, model calls, tasks, OS shortcut or tray registration.
const started = performance.now();
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const label = process.argv.find(value => value.startsWith('--sample='))?.slice(9) || 'sample';
if (!/^[\w-]+$/.test(label)) throw new Error('Invalid sample name');
const output = path.join(root, '.codex-tmp', 'app-performance', label);
const userData = path.join(output, 'profile');
const home = path.join(output, 'home');
fs.mkdirSync(userData, { recursive: true });
for (const name of ['agents', 'skills', 'relay-memory']) fs.mkdirSync(path.join(home, '.claude', name), { recursive: true });
os.homedir = () => home;
app.setPath('userData', userData);
app.setPath('home', home);
fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({
  firstRunSetupVersion: 1, providerIsolationSettingsVersion: 1, imageProviderMigrationVersion: 1,
  sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false, theme: 'light', permissionMode: 'default',
  quickChatEnabled: true, miniInputEnabled: true, floatingOrbEnabled: true,
}));
const historyDir = path.join(userData, 'history');
fs.mkdirSync(historyDir, { recursive: true });
const items = [];
for (let index = 0; index < 200; index++) {
  const id = randomUUID();
  const at = new Date(Date.now() - index * 3600000).toISOString();
  const record = { id, title: '性能测试对话 ' + index, createdAt: at, updatedAt: at, kind: 'chat', mode: 'plain',
    turns: [{ ts: at, user: '合成测试消息', assistant: '已完成测试。\n'.repeat(600), status: 'completed' }] };
  items.push({ id, title: record.title, createdAt: at, updatedAt: at, kind: 'chat', mode: 'plain' });
  fs.writeFileSync(path.join(historyDir, id + '.json'), JSON.stringify(record));
}
fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify({ version: 2, items }));
const marks = {};
const loads = [];
const reads = new Map();
const ipcCalls = new Map();
const errors = [];
const windows = [];
const originalRead = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && file.startsWith(userData)) {
    const key = path.relative(userData, file).replace(/[a-f0-9-]{36}/g, '<id>');
    reads.set(key, (reads.get(key) || 0) + 1);
  }
  return originalRead.call(this, file, ...args);
};
class FixtureTray extends EventEmitter {
  setImage() {} setContextMenu() {} setToolTip() {} displayBalloon() {}
  isDestroyed() { return false; } destroy() { this.removeAllListeners(); }
}
const electron = require('electron');
const originalLoad = Module._load;
const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (channel, handler) => originalHandle(channel, (event, ...args) => {
  ipcCalls.set(channel, (ipcCalls.get(channel) || 0) + 1);
  return handler(event, ...args);
});
const benchmarkElectron = new Proxy(electron, { get(target, name) {
  if (name === 'Tray') return FixtureTray;
  if (name === 'globalShortcut') return { register: () => true, unregister() {}, unregisterAll() {} };
  return target[name];
} });
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return benchmarkElectron;
  const start = performance.now();
  try { return originalLoad.apply(this, arguments); }
  finally {
    if (parent?.filename === path.join(root, 'src/main/bootstrap.js')) loads.push({ request, ms: performance.now() - start });
  }
};
app.on('browser-window-created', (_event, win) => {
  windows.push(win);
  if (!marks.windowCreated) marks.windowCreated = performance.now();
  // Avoid taking the user's keyboard focus; still paint the real windows.
  win.focus = () => {};
  win.show = win.showInactive.bind(win);
  win.once('ready-to-show', () => { if (!marks.firstFrame) marks.firstFrame = performance.now(); });
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().endsWith('/renderer/index.html')) return;
    marks.loaded = performance.now();
    await new Promise(resolve => setTimeout(resolve, 6000));
    try {
      const mainMetrics = app.getAppMetrics();
      const rendering = await win.webContents.executeJavaScript(`({
        heap: performance.memory?.usedJSHeapSize, nodes: document.querySelectorAll('*').length,
        scripts: [...document.scripts].map(s=>s.src.split('/').pop()),
        paints: performance.getEntriesByType('paint').map(e=>({name:e.name,ms:e.startTime})),
        inputReady: !!document.querySelector('#msgInput, #input'),
      })`);
      const result = {
        label, syntheticConversations: items.length,
        timingMs: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, +(value - marks.requireStart).toFixed(2)])),
        harnessSetupMs: +(marks.requireStart - started).toFixed(2),
        processMemory: process.memoryUsage(), renderer: rendering,
        processes: mainMetrics.map(value => ({type: value.type, memory: value.memory, cpu: value.cpu})),
        workingSetKB: mainMetrics.reduce((sum, value) => sum + value.memory.workingSetSize, 0),
        windowCount: BrowserWindow.getAllWindows().length,
        reads: Object.fromEntries(reads), ipcCalls: Object.fromEntries(ipcCalls),
        mainImports: loads.sort((a,b)=>b.ms-a.ms), errors,
      };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log('[benchmark]', JSON.stringify({label,timingMs:result.timingMs,workingSetKB:result.workingSetKB,windows:result.windowCount}));
      clearTimeout(deadline);
      if (errors.length) throw new Error('Startup produced renderer errors; inspect result.json');
      app.quit();
    } catch (error) { fail(error); }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(String(message).slice(0, 400));
  });
});
const deadline = setTimeout(() => fail(new Error('Startup benchmark timed out')), 30000);
function fail(error) {
  fs.writeFileSync(path.join(output, 'error.txt'), String(error.stack || error));
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(1);
}
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) })));
marks.requireStart = performance.now();
try { require(path.join(root, 'main.js')); marks.mainLoaded = performance.now(); }
catch (error) { fail(error); }
