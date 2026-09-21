'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { create } = require('../renderer/window-chrome');
const repo = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(repo, 'main.js'), 'utf8');
const chromeSource = mainSource.slice(mainSource.indexOf('const MAIN_WINDOW_CHROME_HEIGHT'), mainSource.indexOf('// renderer 的 warning'));
const plain = value => JSON.parse(JSON.stringify(value));

function mainFixture(platform = 'win32', dark = false, release = '10.0.22631') {
  const handlers = new Map();
  class MockWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = { mainFrame: {}, openDevTools() {} };
      this.overlays = [];
      this.backgrounds = [];
      this.backgroundColor = options.backgroundColor;
      this.titleBarOverlay = options.titleBarOverlay;
      this.maximized = false;
      this.fullScreen = false;
      this.destroyed = false;
    }
    loadFile() {}
    setMenuBarVisibility() {}
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    setBackgroundColor(value) { this.backgroundColor = value; this.backgrounds.push(value); }
    setTitleBarOverlay(options) { this.titleBarOverlay = options; this.overlays.push(options); }
    hide() { this.hidden = true; }
  }
  const context = vm.createContext({
    process: { platform }, os: { release: () => release }, path, __dirname: repo, mainWindow: null, currentAppIcon: () => 'fixture-icon',
    BrowserWindow: MockWindow, readAppSettings: () => ({ theme: dark ? 'dark' : 'light' }),
    nativeTheme: { shouldUseDarkColors: dark }, IS_DEV: false,
    ipcMain: { on(name, callback) { assert.equal(handlers.has(name), false); handlers.set(name, callback); } },
    attachExternalLinkGuard() {}, attachRendererConsoleLog() {}, createTray() {},
    taskbarCompletionBadge: { refresh() {} },
    interactionBroker: { rejectWindow() {} }, isQuitting: false, trayBalloonShown: true,
  });
  vm.runInContext(chromeSource, context);
  return { win: context.createMainWindow(), handlers, context };
}

test('Windows 原生按钮叠层留出底部分隔线并保留窗口及托盘行为', () => {
  const { win } = mainFixture('win32', true);
  assert.equal(win.options.title, 'Relay');
  assert.equal(win.options.icon, 'fixture-icon');
  assert.equal(win.options.titleBarStyle, 'hidden');
  assert.deepEqual(plain(win.options.titleBarOverlay), { color: '#1a1a1a', symbolColor: '#e4e4e7', height: 35 });
  assert.notEqual(win.options.frame, false);
  assert.notEqual(win.options.minimizable, false);
  assert.notEqual(win.options.maximizable, false);
  assert.notEqual(win.options.closable, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.ok(win.options.webPreferences.additionalArguments.includes('--relay-window-chrome-overlay'));
  let prevented = false;
  win.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(win.hidden, true, '原有关闭到托盘行为不变');
});


test('Windows 11 首帧提供实体主题底色，不依赖 DWM 透明材质', () => {
  const { win } = mainFixture();
  assert.equal(win.options.backgroundMaterial, undefined);
  assert.equal(win.options.backgroundColor, '#fafafa');
  assert.equal(win.options.titleBarOverlay.color, '#fafafa');
  assert.notEqual(win.options.transparent, true);
  assert.ok(!win.options.webPreferences.additionalArguments.some(value => value.startsWith('--relay-window-chrome-material=')));
});

for (const release of ['10.0.19045', '10.0.22631']) {
for (const theme of ['light', 'dark']) {
  test(`Windows ${release} 的 ${theme} 顶栏不依赖跨屏及窗口状态重刷，托盘返回保留预览色`, () => {
    // Saved/native theme deliberately differs from the renderer's preview.
    const { win, handlers } = mainFixture('win32', theme === 'light', release);
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const update = (value, search = false) => handlers.get('window-chrome:theme')(event, value, search);
    const solid = theme === 'dark' ? '#1a1a1a' : '#fafafa';
    update(theme);
    for (const searchOpen of [false, true]) {
      update(theme, searchOpen);
      const overlayColor = searchOpen ? theme === 'dark' ? '#0f0f0f' : '#919191' : solid;
      const writes = [win.backgrounds.length, win.overlays.length];
      for (const [eventName, state] of [
        ['move', { displayId: 2, scaleFactor: 1.5 }],
        ['resize', {}],
        ['maximize', { maximized: true }],
        ['enter-full-screen', { fullScreen: true }],
        ['leave-full-screen', { fullScreen: false }],
        ['unmaximize', { maximized: false }],
        ['move', { displayId: 1, scaleFactor: 1 }],
        ['restore', {}],
      ]) {
        Object.assign(win, state);
        win.emit(eventName);
        assert.equal(win.backgroundColor, solid, eventName);
        assert.equal(win.titleBarOverlay.color, overlayColor, eventName);
      }
      assert.deepEqual([win.backgrounds.length, win.overlays.length], writes,
        '拖动、DPI 和窗口状态事件无需高频背景重绘也有稳定底色');
      win.emit('show');
      assert.equal(win.backgroundColor, solid, '托盘返回不能把预览主题切回已保存主题');
      assert.equal(win.titleBarOverlay.color, overlayColor);
    }
    update(theme === 'dark' ? 'light' : 'dark');
    assert.equal(win.backgroundColor, theme === 'dark' ? '#fafafa' : '#1a1a1a');
    update(theme);
    assert.equal(win.backgroundColor, solid, '取消预览恢复当前 UI 色');
    assert.ok(win.backgrounds.every(value => value === '#fafafa' || value === '#1a1a1a'));
  });
}
}

for (const release of ['10.0.19045', '10.0.22000']) {
  test(`旧版 Windows ${release} 使用实体背景回退`, () => {
    const { win, handlers } = mainFixture('win32', false, release);
    assert.equal(win.options.backgroundMaterial, undefined);
    assert.equal(win.options.backgroundColor, '#fafafa');
    assert.equal(win.options.titleBarOverlay.color, '#fafafa');
    assert.ok(!win.options.webPreferences.additionalArguments.includes('--relay-window-chrome-material=acrylic'));
    handlers.get('window-chrome:theme')({sender:win.webContents,senderFrame:win.webContents.mainFrame}, 'dark', true);
    assert.equal(win.overlays.at(-1).color, '#0f0f0f');
  });
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} 保留原生标题栏，不启用 Windows overlay`, () => {
    const { win } = mainFixture(platform);
    assert.equal(win.options.titleBarStyle, undefined);
    assert.equal(win.options.titleBarOverlay, undefined);
    assert.deepEqual(plain(win.options.webPreferences.additionalArguments), []);
  });
}

test('主题 IPC 只允许主窗口的主 frame 发送 light/dark', () => {
  const { win, handlers } = mainFixture();
  const handler = handlers.get('window-chrome:theme');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(handler(event, 'dark'), true);
  assert.equal(win.overlays[0].color, '#1a1a1a');
  for (const theme of [null, 'system', '#ff0000', { color: '#ff0000', height: 600 }]) assert.equal(handler(event, theme), false);
  assert.equal(handler({ sender: {}, senderFrame: win.webContents.mainFrame }, 'light'), false);
  assert.equal(handler({ sender: win.webContents, senderFrame: {} }, 'light'), false);
  win.destroyed = true;
  assert.equal(handler(event, 'light'), false);
  assert.equal(win.overlays.length, 1);
});

test('搜索暗化 IPC 仅接受布尔标志，关闭搜索恢复当前主题', () => {
  const { win, handlers } = mainFixture();
  const handler = handlers.get('window-chrome:theme');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(handler(event, 'light', true), true);
  assert.equal(win.overlays.at(-1).color, '#919191');
  assert.equal(win.overlays.at(-1).symbolColor, '#1e1e1f');
  assert.equal(handler(event, 'dark', true), true);
  assert.equal(win.overlays.at(-1).color, '#0f0f0f');
  assert.equal(win.overlays.at(-1).symbolColor, '#848486');
  for (const value of ['true', 1, null, { color: '#fff' }]) assert.equal(handler(event, 'light', value), false);
  assert.equal(handler({ ...event, senderFrame: {} }, 'dark', true), false);
  assert.equal(handler(event, 'dark', false), true);
  assert.equal(win.overlays.at(-1).color, '#1a1a1a');
  assert.equal(win.overlays.at(-1).symbolColor, '#e4e4e7');
  assert.equal(win.overlays.length, 3);
});

test('preload 仅暴露标题栏展示元数据和受限主题同步', () => {
  let api;
  const sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'preload.js'), 'utf8'), {
    process: { platform: 'win32', argv: ['--relay-window-chrome-overlay', '--relay-window-chrome-theme=dark'] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'api'); api = value; } },
        ipcRenderer: { send(...args) { sent.push(args); } }, webUtils: {} };
    },
  });
  assert.deepEqual(Object.keys(api.windowChrome).sort(), ['initialTheme', 'overlay', 'setTheme']);
  assert.equal(api.windowChrome.overlay, true);
  assert.equal(api.windowChrome.initialTheme, 'dark');
  api.windowChrome.setTheme('dark');
  api.windowChrome.setTheme({ height: 600 });
  assert.deepEqual(sent, [['window-chrome:theme', 'dark']]);
  api.windowChrome.setTheme('dark', true);
  api.windowChrome.setTheme('light', 'true');
  api.windowChrome.setTheme('light', false);
  assert.deepEqual(sent, [['window-chrome:theme', 'dark'], ['window-chrome:theme', 'dark', true], ['window-chrome:theme', 'light']]);
});

function rendererFixture(overlay = true) {
  class Target extends EventTarget {}
  const attrs = new Map();
  const observers = new Set();
  const style = new Map();
  const root = {
    setAttribute(name, value) {
      if (attrs.get(name) === value) return;
      attrs.set(name, value);
      for (const observer of observers) if (observer.filter.includes(name)) observer.callback();
    },
    getAttribute: name => attrs.get(name) || null,
  };
  const host = { style: { setProperty(name, value) { style.set(name, value); } } };
  const controls = Object.assign(new Target(), { visible: true, rect: { x: 0, width: 1062 },
    getTitlebarAreaRect() { return this.rect; } });
  const themes = [], appearances = [];
  const win = Object.assign(new Target(), {
    innerWidth: 1200, document: { documentElement: root }, navigator: { windowControlsOverlay: controls },
    api: { windowChrome: { overlay, initialTheme: 'dark', setTheme(value, dimmed) { themes.push(value); appearances.push([value, dimmed]); } } },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { this.filter = options.attributeFilter; observers.add(this); }
      disconnect() { observers.delete(this); }
    },
  });
  return { win, host, root, style, controls, themes, appearances, observers };
}

test('标题栏跟随 UI 即时预览和取消，重复初始化不重复订阅', () => {
  const f = rendererFixture();
  const instance = create({ window: f.win, host: f.host });
  assert.equal(create({ window: f.win, host: f.host }), instance);
  assert.equal(f.observers.size, 1);
  assert.equal(f.root.getAttribute('data-window-chrome-material'), null);
  assert.deepEqual(f.themes, ['dark']);
  f.root.setAttribute('data-theme', 'light');
  f.root.setAttribute('data-theme', 'light');
  f.root.setAttribute('data-theme', 'dark');
  assert.deepEqual(f.themes, ['dark', 'light', 'dark']);
  instance.dispose();
  f.root.setAttribute('data-theme', 'light');
  assert.equal(f.themes.length, 3);
  assert.equal(f.observers.size, 0);
});

test('系统按钮区域随 overlay geometrychange 更新，避免按钮与原生控件重叠', () => {
  const f = rendererFixture();
  const instance = create({ window: f.win, host: f.host });
  assert.equal(f.style.get('--relay-window-controls-right'), '138px');
  f.win.innerWidth = 900;
  f.controls.rect = { x: 0, width: 762 };
  f.controls.dispatchEvent(new Event('geometrychange'));
  assert.equal(f.style.get('--relay-window-controls-right'), '138px');
  f.controls.visible = false;
  f.controls.dispatchEvent(new Event('geometrychange'));
  assert.equal(f.style.get('--relay-window-controls-right'), '0px');
  instance.dispose();
});

test('搜索打开与主题预览同步原生标题栏，关闭和销毁恢复且不添加观察器', () => {
  const f = rendererFixture();
  const instance = create({ window: f.win, host: f.host });
  instance.setSearchOpen(true);
  instance.setSearchOpen(true);
  assert.equal(f.root.getAttribute('data-window-chrome-dimmed'), 'true');
  f.root.setAttribute('data-theme', 'light');
  instance.setSearchOpen(false);
  assert.equal(f.root.getAttribute('data-window-chrome-dimmed'), 'false');
  assert.deepEqual(f.appearances, [['dark', false], ['dark', true], ['light', true], ['light', false]]);
  assert.equal(f.observers.size, 1);
  assert.equal(f.root.getAttribute('data-window-chrome-material'), null);
  instance.setSearchOpen(true);
  instance.dispose();
  assert.deepEqual(f.appearances.at(-1), ['light', false]);
  assert.equal(f.observers.size, 0);
});

test('非 overlay 平台保留紧凑入口，主题改变不发送原生控件 IPC', () => {
  const f = rendererFixture(false);
  const instance = create({ window: f.win, host: f.host });
  assert.equal(f.root.getAttribute('data-window-chrome'), 'native');
  assert.equal(f.style.get('--relay-window-controls-right'), '0px');
  f.root.setAttribute('data-theme', 'light');
  assert.deepEqual(f.themes, []);
  instance.dispose();
});
