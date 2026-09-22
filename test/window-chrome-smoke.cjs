'use strict';

// Isolated native Electron window: reuse the real constructor options, preload,
// chrome markup/module/styles, and theme IPC guard without loading Relay's main.
const { app, BrowserWindow, ipcMain, session, screen, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');
const output = process.env.RELAY_SMOKE_OUTPUT || path.join(repo, '.codex-tmp', 'window-chrome-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
// Keep GPU composition enabled and exercise physical display transitions.
app.on('window-all-closed', () => {});
const checks = {};
const errors = [];
const themes = [];
const backingSamples = [];
const displayChecks = [];
const nativeCaptures = [];
let win;
const timeout = setTimeout(() => finish(new Error('Isolated chrome test timed out')), 60000);
const source = fs.readFileSync(path.join(repo, 'src/main/app/application-windows.js'), 'utf8').replace(/^  /gm, '');
const mainStart = source.indexOf('function createMainWindow(');
const constructorStart = source.indexOf('  const win = new BrowserWindow({', mainStart);
const constructorEnd = source.indexOf('\n  });', constructorStart) + '\n  });'.length;
const context = vm.createContext({
  process: { platform: process.platform }, os: require('node:os'), mainWindow: null, path, appRoot: repo,
  nativeTheme: { shouldUseDarkColors: false }, bgColor: '#fafafa', currentAppIcon: () => undefined,
  BrowserWindow: class { constructor(options) { this.options = options; } },
  ipcMain: { on(channel, handler) {
    ipcMain.on(channel, (event, theme, dimmed) => { themes.push({ theme, dimmed: dimmed === true, accepted: handler(event, theme, dimmed) }); });
  } },
});
vm.runInContext(source.slice(source.indexOf('const MAIN_WINDOW_CHROME_HEIGHT'), mainStart), context);
const options = vm.runInContext(`(() => { ${source.slice(constructorStart, constructorEnd)} return win.options; })()`, context);
const index = fs.readFileSync(path.join(repo, 'renderer', 'index.html'), 'utf8');
const headerStart = index.indexOf('<header id="windowChrome"');
if (headerStart < 0) throw new Error('Real window chrome markup missing');
const header = index.slice(headerStart, index.indexOf('</header>', headerStart) + '</header>'.length);
const styles = fs.readFileSync(path.join(repo, 'renderer', 'styles.css'), 'utf8');
const searchStyles = styles.slice(styles.indexOf('.search-overlay {'), styles.indexOf('.search-results {'));
const page = path.join(output, 'fixture.html');
fs.writeFileSync(page, `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">
<base href="${pathToFileURL(path.join(repo, 'renderer') + path.sep).href}">
<link rel="stylesheet" href="window-chrome.css">
<link rel="stylesheet" href="subagent-history.css">
<style>*{box-sizing:border-box}:root{--bg-panel:#fff;--text:#242424;--text-muted:#777;--text-dim:#555;--border:#e5e5e5}html[data-theme=dark]{--bg-panel:#222;--text:#eee;--text-muted:#aaa;--text-dim:#ccc;--border:#444}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Segoe UI,sans-serif}body{display:flex;flex-direction:column;background:#fafafa}main{flex:1;padding:30px;color:#555;background:var(--bg-panel)}html[data-theme=dark] body{background:#1a1a1a}html[data-theme=dark] main{color:#ddd}${searchStyles}</style>
</head><body>${header}<main>独立标题栏验证窗口<br>所有操作均为本地界面测试</main>
<script>window.chromeClicks=0;document.getElementById('btnToggleSidebar').addEventListener('click',()=>{window.chromeClicks++;});window.addEventListener('error',event=>{window.chromeError=event.message;});</script>
<div class="search-overlay"><div class="search-box"><div class="search-head"><input class="search-input" placeholder="搜索历史对话…"><button class="search-close" onclick="toggleSearch(false)">×</button></div><div style="padding:30px;text-align:center;color:var(--text-muted)">输入关键词搜索你的历史对话</div></div></div>
<script src="window-chrome.js"></script><script>function toggleSearch(open){document.querySelector('.search-overlay').classList.toggle('show',open);relayWindowChrome.setSearchOpen(open)}</script><script src="subagent-history.js"></script>
<script>relaySubagentHistory.destroy();window.relaySubagentHistory=RelaySubagentHistory.create({api:{listSubagents:async()=>({ok:true,items:[{agentId:'fixture-agent',title:'验证 Agent'}]}),getSubagentMessages:async()=>({ok:true,items:Array.from({length:12},(_,index)=>({uuid:String(index),type:'assistant',message:{content:[{type:'text',text:'合成工作记录 '+index}]}}))})}});</script></body></html>`);

const evaluate = code => win.webContents.executeJavaScript(code);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function check(name, code) {
  checks[name] = !!await evaluate(code);
  if (!checks[name]) throw new Error(name);
}
async function waitFor(code) {
  const deadline = Date.now() + 5000;
  while (!await evaluate(code)) {
    if (Date.now() >= deadline) throw new Error('State timeout: ' + code);
    await delay(30);
  }
}
async function capture(name) {
  await delay(100);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function waitNative(predicate, name) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(name + ' timed out');
    await delay(30);
  }
  await delay(200);
}
async function checkBacking(name, theme) {
  // Check both native backing and actual pixel alpha. A transparent screenshot
  // cannot prove DWM has supplied a healthy backdrop on another display.
  const expected = theme === 'dark' ? '#1a1a1a' : '#fafafa';
  const actual = win.getBackgroundColor().toLowerCase();
  checks[name + 'Backing'] = actual === expected || actual === '#ff' + expected.slice(1);
  if (!checks[name + 'Backing']) throw new Error(name + ' backing: ' + actual);
  const img = await win.webContents.capturePage({ x: 180, y: 16, width: 1, height: 1 });
  const pixel = [...img.toBitmap().subarray(0, 4)]; // Chromium BGRA
  backingSamples.push({ name, actual, pixel });
  checks[name + 'RenderedColor'] = pixel[3] === 255 && pixel.slice(0, 3).every(value => theme === 'light' ? value >= 235 : value >= 20 && value < 50);
  if (!checks[name + 'RenderedColor']) throw new Error(name + ' composited pixel: ' + pixel);
}
async function captureNativeWindow(name) {
  const bounds = win.getBounds();
  const scale = screen.getDisplayMatching(bounds).scaleFactor;
  // Retain only this isolated test window, never the user's desktop/apps.
  const sourceId = win.getMediaSourceId();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: {
    width: Math.ceil(bounds.width * scale), height: Math.ceil(bounds.height * scale),
  } });
  const own = sources.find(source => source.id === sourceId
    || source.id.split(':').slice(0, 2).join(':') === sourceId.split(':').slice(0, 2).join(':'));
  const available = !!own && !own.thumbnail.isEmpty();
  nativeCaptures.push({ name, available });
  // Desktop Capturer may be unavailable in a remote/isolated Windows session.
  // Keep its coverage explicit; Chromium pixel checks above remain mandatory.
  if (!available) { await capture(name + '-renderer-only'); return; }
  fs.writeFileSync(path.join(output, name + '.png'), own.thumbnail.toPNG());
}
function finish(error) {
  if (error) errors.push(String(error.stack || error));
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ platform: process.platform, checks, themes, backingSamples, displayChecks, nativeCaptures, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(errors.length ? 1 : 0);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ ...options, width: 960, height: 420, minWidth: 250, minHeight: 180,
    webPreferences: { ...options.webPreferences, sandbox: true, backgroundThrottling: false } });
  context.mainWindow = win;
  await win.loadFile(page);
  win.showInactive();
  await waitFor('!!window.relayWindowChrome');
  await check('realPreloadHasNoWindowManagementApi', "Object.keys(api.windowChrome).sort().join(',')==='initialTheme,overlay,setTheme' && !window.require");
  await check('headerHasOpaqueFallbackWithoutNativeBackdrop', "!document.documentElement.hasAttribute('data-window-chrome-material')&&getComputedStyle(windowChrome).backgroundColor==='rgb(250, 250, 250)'&&getComputedStyle(windowChrome).backgroundImage!=='none'&&getComputedStyle(document.querySelector('main')).backgroundColor==='rgb(255, 255, 255)'");
  await check('headerIs36pxAtContentTop', "(()=>{const r=document.getElementById('windowChrome').getBoundingClientRect();return r.y===0&&r.height===36;})()");
  await check('oneToggleAtFarLeftBeforeEmptyDragSpace', "(()=>{const b=document.getElementById('btnToggleSidebar').getBoundingClientRect(),space=document.querySelector('.window-chrome-drag-space').getBoundingClientRect();return document.querySelectorAll('[data-toggle-sidebar]').length===1&&!document.querySelector('.window-chrome-brand, .window-chrome-logo, .window-chrome-title')&&b.right<=space.left&&space.left-b.right<=10&&b.left<=12&&b.top>=0&&b.bottom<=36;})()");
  await check('toggleDoesNotDragWindow', "getComputedStyle(document.getElementById('btnToggleSidebar')).getPropertyValue('-webkit-app-region')==='no-drag'");
  if (process.platform === 'win32') {
    await waitFor('navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible');
    await check('actualWindowsOverlayVisible', "document.documentElement.dataset.windowChrome==='overlay'&&navigator.windowControlsOverlay.visible");
    await check('remainingHeaderDragsWindow', "getComputedStyle(document.getElementById('windowChrome')).getPropertyValue('-webkit-app-region')==='drag'");
    await check('nativeButtonsHaveReservedSpace', "(()=>{const a=navigator.windowControlsOverlay.getTitlebarAreaRect(),b=document.getElementById('btnToggleSidebar').getBoundingClientRect(),h=document.getElementById('windowChrome');return a.width<innerWidth&&b.right<a.x+a.width&&parseFloat(h.style.getPropertyValue('--relay-window-controls-right'))>=innerWidth-a.width-a.x;})()");
    await check('dividerContinuesBelowNativeButtons', "(()=>{const a=navigator.windowControlsOverlay.getTitlebarAreaRect(),h=document.getElementById('windowChrome'),r=h.getBoundingClientRect();return a.height===35&&a.bottom===r.bottom-1&&r.width===innerWidth&&getComputedStyle(h).borderBottomWidth==='1px';})()");
  }
  const point = await evaluate("(()=>{const r=document.getElementById('btnToggleSidebar').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await waitFor('chromeClicks===1');
  checks.mouseClickReachesToggle = true;
  win.focus();
  win.webContents.focus();
  await evaluate("document.getElementById('btnToggleSidebar').focus()");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor('chromeClicks===2');
  checks.keyboardReachesToggle = true;
  await capture('light');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme='${theme}';toggleSearch(true)`);
    await waitFor("document.documentElement.dataset.windowChromeDimmed==='true'");
    await delay(100);
    await check(theme+'SearchShadesChromeWithoutBlockingItsHitRegion', `(()=>{const h=document.getElementById('windowChrome'),s=getComputedStyle(h,'::after');return s.backgroundColor==='rgba(0, 0, 0, 0.42)'&&s.pointerEvents==='none'&&document.elementFromPoint(100,18).closest('.window-chrome')&&document.querySelector('.search-overlay').getBoundingClientRect().top===h.getBoundingClientRect().bottom})()`);
    checks[theme+'SearchNativeCaptionShadeAccepted'] = themes.some(item => item.theme===theme&&item.dimmed&&item.accepted);
    if (!checks[theme+'SearchNativeCaptionShadeAccepted']) throw new Error('Native search shade was not accepted');
    await capture('search-'+theme);
  }
  win.minimize();
  const minimizedBy = Date.now() + 3000;
  while (!win.isMinimized() && Date.now() < minimizedBy) await delay(30);
  checks.minimizeWorksWhileSearchOpen = win.isMinimized();
  if (!checks.minimizeWorksWhileSearchOpen) throw new Error('Search blocks native minimize');
  win.restore();await delay(150);
  await evaluate('toggleSearch(false)');
  await waitFor("document.documentElement.dataset.windowChromeDimmed==='false'");
  await delay(100);
  await check('closingSearchRestoresDarkChromeAndHidesItsShade', "getComputedStyle(windowChrome).backgroundColor==='rgb(26, 26, 26)'&&getComputedStyle(windowChrome,'::after').content==='none'");
  checks.closingSearchRestoresNativeCaption = themes.at(-1).theme==='dark'&&!themes.at(-1).dimmed&&themes.at(-1).accepted;
  if (!checks.closingSearchRestoresNativeCaption) throw new Error('Search close did not restore native caption');
  await capture('search-closed-dark');
  await evaluate("document.documentElement.dataset.theme='light'");
  await waitFor("document.documentElement.dataset.windowChromeTheme==='light'");
  await evaluate('relaySubagentHistory.open({convId:"fixture-conversation",runId:"fixture-run"})');
  await delay(220);
  await check('subagentOverlayStartsBelowTheWholeTitlebar', '(()=>{const overlay=document.querySelector(".subagent-history-overlay").getBoundingClientRect(),chrome=windowChrome.getBoundingClientRect();return overlay.top===chrome.bottom&&overlay.bottom===innerHeight&&document.elementFromPoint(100,18).closest(".window-chrome");})()');
  await check('subagentDialogAndScrollAreaFitBelowChrome', '(()=>{const dialog=document.querySelector(".subagent-history-dialog").getBoundingClientRect(),body=document.querySelector(".subagent-history-body");return dialog.top>=36+28&&dialog.bottom<=innerHeight-28&&body.scrollHeight>body.clientHeight;})()');
  await capture('subagent-light');
  await evaluate("document.documentElement.dataset.theme='dark'");
  await waitFor("document.documentElement.dataset.windowChromeTheme==='dark'");
  await check('darkThemeColorsMatchCaptionPalette', "getComputedStyle(document.getElementById('windowChrome')).backgroundColor==='rgb(26, 26, 26)'");
  if (process.platform === 'win32') {
    await delay(50);
    checks.realThemeIpcAccepted = themes.some(item => item.theme === 'dark' && item.accepted);
    if (!checks.realThemeIpcAccepted) throw new Error('Native caption theme IPC rejected');
  }
  await capture('dark');
  await check('subagentOverlayAlsoKeepsDarkCaptionRegionClear', 'document.elementFromPoint(100,18).closest(".window-chrome")&&document.querySelector(".subagent-history-overlay").getBoundingClientRect().top===36');
  await capture('subagent-dark');
  await evaluate('document.querySelector(".subagent-history-close").click()');
  if (process.platform === 'win32') {
    const primary = screen.getPrimaryDisplay();
    const displays = [primary, ...screen.getAllDisplays().filter(display => display.id !== primary.id)];
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await waitFor(`document.documentElement.dataset.windowChromeTheme==='${theme}'`);
      // Return to the first screen too: transitions must work in both directions.
      for (const [index, display] of [...displays, primary].entries()) {
        const area = display.workArea;
        win.setBounds({ x: area.x + 40, y: area.y + 40,
          width: Math.min(880, area.width - 80), height: Math.min(460, area.height - 80) });
        await waitNative(() => screen.getDisplayMatching(win.getBounds()).id === display.id, 'move to display ' + index);
        const name = theme + 'Display' + index;
        await checkBacking(name + 'Floating', theme);
        await check(name + 'CaptionGeometry', '(()=>{const a=navigator.windowControlsOverlay.getTitlebarAreaRect(),b=btnToggleSidebar.getBoundingClientRect();return a.width>0&&a.width<innerWidth&&b.right<a.x+a.width&&windowChrome.getBoundingClientRect().height===36})()');
        displayChecks.push({ theme, displayId: display.id, scaleFactor: display.scaleFactor,
          workArea: area, windowBounds: win.getBounds(), rendererDpr: await evaluate('devicePixelRatio') });
        if (theme === 'light') await captureNativeWindow('native-' + name + '-floating');
        win.maximize();
        await waitNative(() => win.isMaximized(), 'display maximize');
        await checkBacking(name + 'Maximized', theme);
        win.unmaximize();
        await waitNative(() => !win.isMaximized(), 'display restore');
        await checkBacking(name + 'Restored', theme);
      }
    }
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await waitFor(`document.documentElement.dataset.windowChromeTheme==='${theme}'`);
      await delay(100);
      win.maximize();
      await waitNative(() => win.isMaximized(), 'maximize ' + theme);
      await checkBacking(theme + 'Maximized', theme);
      await capture(theme + '-maximized');
      win.setFullScreen(true);
      await waitNative(() => win.isFullScreen(), 'fullscreen ' + theme);
      await checkBacking(theme + 'FullScreen', theme);
      win.setFullScreen(false);
      await waitNative(() => !win.isFullScreen(), 'leave fullscreen ' + theme);
      await checkBacking(theme + 'AfterFullScreen', theme);
      win.unmaximize();
      await waitNative(() => !win.isMaximized(), 'unmaximize ' + theme);
      await checkBacking(theme + 'Restored', theme);
    }
    // A live theme preview must repaint the maximized backing without a resize.
    win.maximize();
    await waitNative(() => win.isMaximized(), 'preview maximize');
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await waitFor(`document.documentElement.dataset.windowChromeTheme==='${theme}'`);
      await delay(100);
      await checkBacking(theme + 'MaximizedPreview', theme);
    }
    await evaluate('toggleSearch(true)');
    await delay(150);
    checks.searchKeepsMaximizedBackingSolid = win.getBackgroundColor().toLowerCase().endsWith('1a1a1a');
    if (!checks.searchKeepsMaximizedBackingSolid) throw new Error('Search reset backing: ' + win.getBackgroundColor());
    await capture('dark-maximized-search');
    await evaluate('toggleSearch(false)');
    win.unmaximize();
    await waitNative(() => !win.isMaximized(), 'preview restore');
  }
  await evaluate('relaySubagentHistory.open({convId:"fixture-conversation",runId:"fixture-run"})');
  await delay(220);
  checks.nativeMinimizeMaximizeRemainEnabled = win.isMinimizable() && win.isMaximizable() && win.isClosable();
  if (!checks.nativeMinimizeMaximizeRemainEnabled) throw new Error('Native controls disabled');
  for (const [action, state] of [['maximize', 'isMaximized'], ['minimize', 'isMinimized']]) {
    win[action]();
    const end = Date.now() + 3000;
    while (!win[state]() && Date.now() < end) await delay(30);
    checks[action + 'WorksWithCaptionOverlay'] = win[state]();
    if (!checks[action + 'WorksWithCaptionOverlay']) throw new Error(action + ' failed');
    if (action === 'maximize') win.unmaximize(); else win.restore();
    await delay(150);
  }
  win.setSize(340, 260);
  await waitFor('innerWidth<=340');
  await check('narrowHeaderAndToggleStayInsideAvailableArea', "(()=>{const b=document.getElementById('btnToggleSidebar').getBoundingClientRect(),a=navigator.windowControlsOverlay?.getTitlebarAreaRect();return document.documentElement.scrollWidth<=innerWidth&&b.right<=(a?.width||innerWidth);})()");
  await check('smallSubagentDialogNeverClipsIntoCaptionOrWindowBottom', '(()=>{const r=document.querySelector(".subagent-history-dialog").getBoundingClientRect();return r.top>=48&&r.bottom<=innerHeight-12&&r.left>=12&&r.right<=innerWidth-12;})()');
  await capture('narrow');
  await evaluate('document.querySelector(".subagent-history-close").click()');
  await check('subagentCloseStillDismissesOnlyItsOwnDialog', 'document.querySelector(".subagent-history-overlay").hidden&&!!window.relayWindowChrome');
  win.close();
  const closeDeadline = Date.now() + 3000;
  while (!win.isDestroyed() && Date.now() < closeDeadline) await delay(20);
  checks.nativeCloseWorksAfterSubagentDialog = win.isDestroyed();
  if (!checks.nativeCloseWorksAfterSubagentDialog) throw new Error('Native close failed');
  const nativeOptions = { ...options, width: 720, height: 300, minWidth: 250, minHeight: 180,
    webPreferences: { ...options.webPreferences, additionalArguments: [], sandbox: true, backgroundThrottling: false } };
  delete nativeOptions.titleBarStyle;
  delete nativeOptions.titleBarOverlay;
  win = new BrowserWindow(nativeOptions);
  context.mainWindow = win;
  await win.loadFile(page);
  win.showInactive();
  await waitFor('!!window.relayWindowChrome');
  await check('nativeTitlebarFallbackKeepsCompactSingleToggle', "document.documentElement.dataset.windowChrome==='native'&&document.querySelectorAll('[data-toggle-sidebar]').length===1&&getComputedStyle(document.getElementById('windowChrome')).getPropertyValue('-webkit-app-region')==='no-drag'&&document.getElementById('windowChrome').style.getPropertyValue('--relay-window-controls-right')==='0px'");
  await check('noRendererErrors', '!window.chromeError');
  finish();
}).catch(finish);
