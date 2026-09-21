'use strict';

// Run with Electron directly. The real renderer uses only in-memory API mocks,
// an isolated profile, and blocked HTTP(S); Relay's main process is never loaded.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'sidebar-layout-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const checks = {}, failures = [];
const started = Date.now();
let currentStep = 'starting';
function checkpoint(step) {
  currentStep = step;
  const line = `${Date.now() - started}ms ${step}`;
  console.log(line); fs.appendFileSync(path.join(output, 'progress.log'), line + '\n');
}
const saveResults = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, currentStep, elapsedMs:Date.now() - started }, null, 2));
fs.writeFileSync(path.join(output, 'progress.log'), '');
// A hidden Windows window can deliver rAF at 1 Hz even with backgroundThrottling
// disabled. The per-operation limit still detects a stalled renderer promptly.
const deadline = setTimeout(() => { failures.push('Overall timeout at ' + currentStep); saveResults(); console.error(failures.at(-1)); app.exit(1); }, 200000);
async function bounded(promise, label, timeoutMs = 7000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label + ' at ' + currentStep)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const evaluate = source => bounded(win.webContents.executeJavaScript(source), source.slice(0, 90));
const act = source => evaluate(`(() => { ${source}\n })()`);
async function settle() {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect && animation.effect.getComputedTiming().iterations !== Infinity) { try { animation.finish(); } catch (_) {} } });");
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function waitFor(source) {
  await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const tick = () => { if (${source}) return resolve(true); if (Date.now() > end) return reject(new Error('UI state timeout: ' + ${JSON.stringify(source)})); setTimeout(tick, 20); }; tick(); })`);
}
async function check(name, source) {
  checkpoint('checking ' + name);
  checks[name] = !!await evaluate(source);
  if (!checks[name]) throw new Error(name + ' failed');
  saveResults();
}
async function capture(name) {
  checkpoint('capturing ' + name);
  await settle();
  await bounded(win.webContents.capturePage(), 'discard first capture');
  await new Promise(resolve => setTimeout(resolve, 130));
  await settle();
  fs.writeFileSync(path.join(output, name + '.png'), (await bounded(win.webContents.capturePage(), 'capture ' + name)).toPNG());
}
async function beginDrag() {
  await settle();
  const point = await evaluate("(() => { const r = document.getElementById('sidebarResizeHandle').getBoundingClientRect(); return { x:Math.round(r.left + r.width / 2), y:Math.round(Math.min(r.bottom - 20, 380)) }; })()");
  win.webContents.sendInputEvent({ type:'mouseMove', ...point });
  win.webContents.sendInputEvent({ type:'mouseDown', ...point, button:'left', clickCount:1 });
  await waitFor('relaySidebarLayout.getState().dragging');
  return point;
}
async function moveDrag(point, x) {
  win.webContents.sendInputEvent({ type:'mouseMove', x, y:point.y, modifiers:['leftButtonDown'] });
  await settle();
}
async function finishDrag(point, x) {
  win.webContents.sendInputEvent({ type:'mouseUp', x, y:point.y, button:'left', clickCount:1 });
  await waitFor('!relaySidebarLayout.getState().dragging');
  await settle();
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type:'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type:'keyUp', keyCode, modifiers });
  await settle();
}

app.whenReady().then(async () => {
  checkpoint('Electron ready');
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel:/^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const helpers = `window.sidebarVisible = el => { if (!el) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && s.display !== 'none'; };`;
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '\n' + helpers + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width:1220, height:920, show:false, webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:true, backgroundThrottling:false } });
  await bounded(win.loadFile(page), 'initial renderer load');
  checkpoint('renderer loaded');
  await waitFor("typeof activeView !== 'undefined' && providerRoutingLoaded && !restoringActiveRuns && !!window.relaySidebarLayout");
  await act(`relaySidebarLayout.reset(); document.querySelector('.app').classList.remove('sidebar-collapsed', 'sidebar-mobile-open'); relaySidebarLayout.sync();
    window.sidebarProbe = { input:inputEl, history:document.getElementById('historyList'), toggle:document.querySelector('#windowChrome [data-toggle-sidebar]') };
    inputEl.value = '拖动侧栏后保留的未发送草稿';
    const item = document.createElement('div'); item.className = 'history-item';
    const title = document.createElement('span'); title.className = 'hi-title'; title.textContent = '合成历史标题：侧栏拉宽后自然显示更多内容，无需重建当前对话或输入草稿';
    item.append(title); sidebarProbe.history.append(item); sidebarProbe.title = title;
  `);
  await settle();
  await act('sidebarProbe.initialTitleWidth = sidebarProbe.title.getBoundingClientRect().width;');
  await check('oneGlobalTitlebarToggleWithoutPageDuplicates', "sidebarVisible(sidebarProbe.toggle) && document.querySelectorAll('[data-toggle-sidebar]').length === 1 && !document.querySelector('main [data-toggle-sidebar]') && !document.getElementById('btnSidebarCollapse')");
  await check('titlebarAndSidebarFitWithoutBottomOverflow', "document.getElementById('windowChrome').getBoundingClientRect().top === 0 && document.querySelector('.app').getBoundingClientRect().top >= 32 && document.getElementById('sidebarNavigation').getBoundingClientRect().bottom <= innerHeight + 1 && document.getElementById('btnSettings').getBoundingClientRect().bottom <= innerHeight + 1");
  await check('separatorAtSidebarEdge', "(() => { const r = document.getElementById('sidebarResizeHandle').getBoundingClientRect(), s = document.getElementById('sidebarNavigation').getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - s.right) <= 1 && r.top >= 32; })()");

  let point = await beginDrag(); await moveDrag(point, point.x + 136);
  await check('pointerDragIsContinuousWithoutTransitionLag', "relaySidebarLayout.getState().width === 360 && Math.abs(document.getElementById('sidebarNavigation').getBoundingClientRect().width - 360) <= 1 && getComputedStyle(document.querySelector('.app')).transitionDuration === '0s' && relaySidebarLayout.getState().dragging");
  await finishDrag(point, point.x + 136);
  await check('releasePreservesDraftAndNaturallyShowsMoreTitle', "relaySidebarLayout.getState().width === 360 && JSON.parse(localStorage.getItem('relay.sidebar.layout.v2')).width === 360 && inputEl === sidebarProbe.input && inputEl.value === '拖动侧栏后保留的未发送草稿' && document.getElementById('historyList') === sidebarProbe.history && sidebarProbe.title.getBoundingClientRect().width > sidebarProbe.initialTitleWidth + 100");
  await capture('wide');

  point = await beginDrag(); await moveDrag(point, 150);
  await check('dragCanApproachCollapseThresholdContinuously', "relaySidebarLayout.getState().width === 150 && Math.abs(document.getElementById('sidebarNavigation').getBoundingClientRect().width - 150) <= 1 && getComputedStyle(document.querySelector('.app')).transitionDuration === '0s'");
  await moveDrag(point, 143);
  await check('thresholdCollapseKeepsCaptureAndEnablesShortTransition', "relaySidebarLayout.getState().width === 0 && relaySidebarLayout.getState().dragging && !document.getElementById('sidebarResizeHandle').hidden && document.querySelector('.app').classList.contains('is-sidebar-snapping') && getComputedStyle(document.querySelector('.app')).transitionDuration === '0.2s' && document.getElementById('sidebarNavigation').inert");
  await moveDrag(point, 165);
  await check('thresholdHysteresisPreventsFlicker', 'relaySidebarLayout.getState().width === 0 && relaySidebarLayout.getState().dragging');
  await moveDrag(point, 190);
  await check('sameCapturedGestureCanPullSidebarOpenAgain', "relaySidebarLayout.getState().width === 190 && !document.querySelector('.app').classList.contains('is-sidebar-snapping') && getComputedStyle(document.querySelector('.app')).transitionDuration === '0s'");
  await moveDrag(point, 100); await key('ESC');
  win.webContents.sendInputEvent({ type:'mouseUp', x:100, y:point.y, button:'left', clickCount:1 }); await settle();
  await check('escapeUndoesThresholdCollapseAndRestoresPriorWidth', "!relaySidebarLayout.getState().dragging && relaySidebarLayout.getState().width === 360 && JSON.parse(localStorage.getItem('relay.sidebar.layout.v2')).width === 360 && !document.querySelector('.app').classList.contains('is-sidebar-resizing')");

  point = await beginDrag(); await moveDrag(point, 100); await finishDrag(point, 100);
  await check('committedCollapseUsesZeroColumnAndKeepsGlobalToggleReachable', "relaySidebarLayout.getState().width === 0 && document.querySelector('main:not(.hidden)').getBoundingClientRect().left <= 1 && getComputedStyle(document.getElementById('sidebarNavigation')).opacity === '0' && sidebarVisible(sidebarProbe.toggle) && sidebarProbe.toggle.getAttribute('aria-expanded') === 'false' && JSON.parse(localStorage.getItem('relay.sidebar.layout.v2')).collapsed === true");
  await capture('collapsed');
  await check('initialRendererHasNoErrors', 'uiFixture.errors.length === 0');
  checkpoint('reloading collapsed renderer'); await bounded(win.loadFile(page), 'collapsed renderer reload');
  await waitFor("typeof activeView !== 'undefined' && providerRoutingLoaded && !restoringActiveRuns && !!window.relaySidebarLayout"); await settle();
  await check('freshRendererRestoresCollapseAndLastExpandedWidth', "relaySidebarLayout.getState().width === 0 && relaySidebarLayout.getState().preferredWidth === 360 && sidebarVisible(document.querySelector('#windowChrome [data-toggle-sidebar]'))");
  await act("document.querySelector('#windowChrome [data-toggle-sidebar]').click();"); await settle();
  await check('globalToggleRestoresUserWidth', 'relaySidebarLayout.getState().width === 360 && relaySidebarLayout.getState().expanded');

  point = await beginDrag(); await moveDrag(point, 1100); await finishDrag(point, 1100);
  await check('maximumUsesAvailableViewportInsteadOfFixed440', "relaySidebarLayout.getState().width === relaySidebarLayout.getState().max && relaySidebarLayout.getState().width > 440 && document.querySelector('main:not(.hidden)').getBoundingClientRect().width >= 479 && document.documentElement.scrollWidth <= innerWidth + 1");
  await act("document.getElementById('sidebarResizeHandle').focus();");
  await key('Home'); await key('Right'); await key('Right', ['shift']);
  await check('keyboardFineAndCoarseAdjustmentWorks', 'relaySidebarLayout.getState().width === 216');
  await key('Enter'); await check('keyboardResetRestoresDefault', 'relaySidebarLayout.getState().width === 224');
  point = await beginDrag(); await moveDrag(point, 150); await finishDrag(point, 150);
  await check('releaseAboveThresholdSettlesAtNormalMinimum', "relaySidebarLayout.getState().width === 176 && getComputedStyle(document.querySelector('.app')).transitionDuration === '0.2s'");
  point = await beginDrag(); await moveDrag(point, 360); await finishDrag(point, 360);

  await check('sameGlobalToggleWorksAcrossEveryPage', `(() => { const button = document.querySelector('#windowChrome [data-toggle-sidebar]'); for (const view of ['library','scheduler','settings','create','chat']) { showAppView(view); if (!sidebarVisible(button) || document.querySelectorAll('[data-toggle-sidebar]').length !== 1) return false; button.click(); if (relaySidebarLayout.getState().expanded || button.getAttribute('aria-expanded') !== 'false') return false; button.click(); if (!relaySidebarLayout.getState().expanded || button.getAttribute('aria-expanded') !== 'true') return false; } return document.querySelector('#windowChrome [data-toggle-sidebar]') === button; })()`); await settle();
  checkpoint('resizing to 820'); win.setSize(820, 920); await waitFor('innerWidth <= 820'); await settle();
  await check('windowResizeClampsWithoutSavingNarrowerWidth', "relaySidebarLayout.getState().preferredWidth === 360 && relaySidebarLayout.getState().width <= innerWidth - 480 && document.querySelector('main:not(.hidden)').getBoundingClientRect().width >= 479 && JSON.parse(localStorage.getItem('relay.sidebar.layout.v2')).width === 360");
  checkpoint('resizing to 520'); win.setSize(520, 860); await waitFor('innerWidth <= 520'); await settle();
  await check('narrowViewportHidesSidebarWithoutReservingRail', "relaySidebarLayout.getState().narrow && relaySidebarLayout.getState().width === 0 && !sidebarVisible(document.getElementById('sidebarNavigation')) && document.querySelector('main:not(.hidden)').getBoundingClientRect().left <= 1 && !sidebarVisible(document.getElementById('sidebarResizeHandle')) && document.documentElement.scrollWidth <= innerWidth + 1");
  await capture('narrow');
  await act("document.querySelector('#windowChrome [data-toggle-sidebar]').click();"); await settle();
  await check('narrowOverlayLeavesMainWidthAndGlobalToggleIntact', "relaySidebarLayout.getState().expanded && sidebarVisible(document.getElementById('sidebarNavigation')) && sidebarVisible(document.querySelector('#windowChrome [data-toggle-sidebar]')) && document.querySelector('main:not(.hidden)').getBoundingClientRect().width >= innerWidth - 1 && document.documentElement.scrollWidth <= innerWidth + 1");
  await capture('narrow-open');
  await act("showAppView('library');"); await settle();
  await check('narrowNavigationClosesOverlayAndKeepsDesktopPreference', "!relaySidebarLayout.getState().expanded && document.querySelector('#windowChrome [data-toggle-sidebar]').getAttribute('aria-expanded') === 'false' && JSON.parse(localStorage.getItem('relay.sidebar.layout.v2')).collapsed === false");
  checkpoint('resizing to desktop'); win.setSize(1220, 920); await waitFor('innerWidth > 1000'); await settle();
  await check('desktopWidthReturnsAfterNarrowNavigation', 'relaySidebarLayout.getState().width === 360 && relaySidebarLayout.getState().preferredWidth === 360');
  await act("showAppView('chat'); document.documentElement.dataset.theme = 'dark';"); await capture('dark');
  await check('themeAndTitlebarGeometryStayAligned', "document.documentElement.dataset.windowChromeTheme === 'dark' && document.getElementById('sidebarNavigation').getBoundingClientRect().top === document.getElementById('windowChrome').getBoundingClientRect().bottom && document.documentElement.scrollWidth <= innerWidth + 1");
  checkpoint('emulating reduced motion'); win.webContents.debugger.attach('1.3');
  await bounded(win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] }), 'reduced motion emulation');
  await settle();
  await check('reducedMotionDisablesSidebarTransitions', "matchMedia('(prefers-reduced-motion: reduce)').matches && [document.querySelector('.app'), document.getElementById('sidebarNavigation'), document.getElementById('sidebarResizeHandle')].every(el => getComputedStyle(el).transitionDuration === '0s')");
  await bounded(win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[] }), 'reset motion emulation'); win.webContents.debugger.detach();
  await check('noRendererErrorsOrNodeAccess', 'uiFixture.errors.length === 0 && !window.require');
  checkpoint('completed'); saveResults();
  console.log(JSON.stringify({ checks, failures })); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error)); saveResults(); console.error(error.stack || error);
  if (win && !win.isDestroyed()) {
    try { console.error(await evaluate('JSON.stringify({errors:uiFixture.errors,state:window.relaySidebarLayout?.getState(),width:innerWidth})')); await capture('failure'); } catch (_) {}
  }
  saveResults(); clearTimeout(deadline); app.exit(1);
});
