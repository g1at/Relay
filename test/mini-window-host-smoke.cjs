'use strict';

// Isolated Windows Electron acceptance fixture. Uses production mini renderers,
// preload and BrowserWindows. Conversation events and cursor drag samples are
// synthetic; no model, user history or main Relay window is opened.
const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createMiniWindowHost } = require('../mini-window-host');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/mini-window-host-validation');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
// Keep the fixture alive long enough to verify destruction and late timers.
app.on('window-all-closed', () => {});
let host, probe, stage = 'startup', settings = {}, chat = { conversation: null, running: false, model: 'sonnet' };
let syntheticCursor = null, mainOpened = 0, settingsWrites = 0;
const checks = {}, errors = [], resizeRequests = [], submissions = [], screenshots = [];
const resizeSignals = [], motionSamples = {}, motionExpectations = {};
const nativeScreens = new EventEmitter();
const brand = { name: 'Relay', logo: null, theme: 'light', enabled: true, shortcut: 'Alt+Space' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => finish(new Error('Timed out at ' + stage)), 45000);
let finished = false;

function snapshot() { return { ...(host?.getState() || {}), ...chat, brand }; }
function publish() {
  if (!host) return;
  for (const win of [host.getPanelWindow(), host.getOrbWindow()]) {
    if (win && !win.isDestroyed()) win.webContents.send('mini:state', snapshot());
  }
}
function save() {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
    stage, checks, errors, settingsWrites, resizeRequests, resizeSignals, motionSamples, motionExpectations, submissions, screenshots,
    evidence: { windows: 'Real Windows Electron transparent BrowserWindows', renderer: 'Production mini.html, floating-orb.html and preload.js',
      conversation: 'Synthetic streamed conversation; no AI invocation', dragging: 'Host consumes controlled OS-cursor samples, real windows move',
      realPointerDragTested: false, userHistoryWritten: false, mainWindowOpened: mainOpened > 0 },
  }, null, 2));
}
function check(name, value) {
  stage = name; checks[name] = !!value; save(); console.log(name + ': ' + checks[name]);
  if (!value) throw Error(name);
}
async function until(predicate, description, timeout = 5000) {
  const started = Date.now();
  while (!await predicate()) { if (Date.now() - started > timeout) throw Error('Timed out: ' + description); await delay(20); }
}
function js(win, code) { return win.webContents.executeJavaScript(code, true); }
async function capture(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG()); screenshots.push(name + '.png'); save();
}
function inside(bounds, area) {
  return bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width
    && bounds.y + bounds.height <= area.y + area.height;
}
async function sampleMotion(win, name, duration) {
  const samples = motionSamples[name] = [];
  const started = Date.now();
  do {
    const geometry = await js(win, `(()=>{const card=document.querySelector('#miniCard'),form=document.querySelector('#miniForm'),transcript=document.querySelector('#miniTranscript'),process=document.querySelector('.mini-process-content');return {viewport:innerHeight,cardHeight:card.getBoundingClientRect().height,cardBottom:card.getBoundingClientRect().bottom,composerBottom:form.getBoundingClientRect().bottom,scrollTop:transcript.scrollTop,processScrollTop:process?.scrollTop,processScrollHeight:process?.scrollHeight,processClientHeight:process?.clientHeight,inlineTranscriptHeight:transcript.style.height}})()`);
    samples.push({ at: Date.now() - started, ...win.getBounds(), target: resizeRequests.at(-1), ...geometry });
    await delay(16);
  } while (Date.now() - started < duration);
  save(); return samples;
}
const sameBounds = (left, right) => ['x', 'y', 'width', 'height'].every(key => left[key] === right[key]);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  if (error) errors.push(error.stack || String(error));
  host?.destroy(); if (probe && !probe.isDestroyed()) probe.destroy();
  save(); app.exit(error || errors.length ? 1 : 0);
}
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!host?.ownsWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted fixture sender');
    return callback(...args);
  });
}

app.whenReady().then(async () => {
  check('nativeWindowsElectronRuntime', process.platform === 'win32');
  nativeScreens.getCursorScreenPoint = () => syntheticCursor || screen.getCursorScreenPoint();
  nativeScreens.getDisplayMatching = rect => screen.getDisplayMatching(rect);
  nativeScreens.getDisplayNearestPoint = point => screen.getDisplayNearestPoint(point);
  host = createMiniWindowHost({ BrowserWindow, screen: nativeScreens, Menu, rootDir: root,
    readSettings: () => ({ ...settings }), writeSettings: next => { settings = { ...next }; settingsWrites++; },
    onStateChange: publish, onOpenMain: () => mainOpened++, onError: error => errors.push(error.message),
  });
  handle('mini:brand', () => brand);
  handle('permissions:get', id => ({ ok: true, conversationId: id || null,
    permissionMode: 'default', executionMode: { kind: 'default' }, revision: 1 }));
  handle('permissions:set', input => ({ ok: true, conversationId: input.conversationId || null,
    permissionMode: input.permissionMode, executionMode: { kind: 'default' }, revision: 2 }));
  handle('providers:list', () => ({ ok: true, routes: { defaultModel: 'sonnet', chatRoutes: [
    { tier: 'haiku', configured: true, available: true, modelId: 'fixture/fast' },
    { tier: 'sonnet', configured: true, available: true, modelId: 'fixture/balanced' },
    { tier: 'opus', configured: true, available: true, modelId: 'fixture/expert' },
  ] } }));
  handle('mini:state', snapshot);
  handle('mini:toggle', () => host.toggle({ source: 'orb' }));
  handle('mini:hide', () => host.hide());
  handle('mini:resize', input => {
    const height = typeof input === 'number' ? input : input.height;
    resizeRequests.push(height);
    const reducedMotion = input?.reducedMotion === true;
    const response = host.resize(height, { reduceMotion: reducedMotion });
    resizeSignals.push({ at: Date.now(), height, reducedMotion, target: response.bounds, actual: host.getPanelWindow()?.getBounds() });
    return response;
  });
  handle('mini:setPinned', value => host.setPinned(value));
  handle('mini:orbDrag', input => host.orbDrag(input));
  handle('mini:orbMenu', () => ({ ok: true }));
  handle('mini:openMain', () => { mainOpened++; return { ok: true }; });
  handle('mini:pause', () => {
    chat.running = false; chat.runId = null;
    if (chat.conversation) chat.conversation.turns.at(-1).status = 'paused';
    publish(); return { ok: true };
  });
  handle('mini:newChat', () => { chat = { conversation: null, running: false, model: 'sonnet' }; publish(); return { ok: true }; });
  handle('mini:submit', input => {
    submissions.push(input);
    const index = submissions.length;
    const turn = { id: 'fixture-turn-' + index, user: input.text, assistant: '', preview: '**正在生成**\n\n快捷对话直接显示回复。',
      status: 'running', activityLabel: '正在回复', ts: new Date().toISOString() };
    chat = { model: input.model, running: true, runId: 'fixture-run-' + index,
      conversation: { id: 'fixture-conversation', model: input.model, turns: [...(chat.conversation?.turns || []), turn] } };
    publish(); return { ok: true, conversationId: 'fixture-conversation', runId: chat.runId };
  });
  handle('interactions:list', () => []);
  handle('interactions:respond', () => ({ ok: true }));
  host.start();
  const orb = host.getOrbWindow();
  orb.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  await until(() => orb.isVisible(), 'orb visible');
  await until(() => js(orb, '!!document.querySelector("#relayOrb") && !!window.api.mini.state'), 'orb document ready');
  check('orbShowsWithoutCreatingChatOrMainWindow', host.getPanelWindow() === null && BrowserWindow.getAllWindows().length === 1 && mainOpened === 0);
  console.log('native orb bounds', JSON.stringify({ topmost: orb.isAlwaysOnTop(), resizable: orb.isResizable(), size: orb.getSize(), bounds: orb.getBounds() }));
  check('orbIsTopmostAndFrameless', orb.isAlwaysOnTop() && !orb.isResizable() && orb.getSize()[0] === 64 && orb.getSize()[1] === 64);
  check('orbProductionRendererHasClickAndDragTarget', await js(orb, 'document.querySelector("#relayOrb").getAttribute("aria-label").includes("快捷对话")'));
  await capture(orb, 'orb');

  await js(orb, 'document.querySelector("#relayOrb").click()');
  await until(() => host.getPanelWindow()?.isVisible(), 'orb opens panel');
  const panel = host.getPanelWindow();
  await until(() => js(panel, '!!document.querySelector("#miniInput") && !!window.api.mini.submit'), 'panel ready');
  panel.webContents.debugger.attach('1.3');
  await panel.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await delay(240);
  check('clickOpensComfortableDefaultInlineConversationWindow', panel.getSize()[0] === 460 && panel.getSize()[1] === 246
    && await js(panel, 'Math.abs(miniCard.getBoundingClientRect().height-214)<=1&&miniInput.getBoundingClientRect().height>=42&&miniSend.getBoundingClientRect().bottom<innerHeight-18'));
  check('miniUsesProductionPreloadAndSecureDocument', await js(panel, 'typeof window.api.mini.submit === "function" && typeof require === "undefined"'));
  check('panelStartsPinned', panel.isAlwaysOnTop());
  await capture(panel, 'compact');
  const beforeMenu = panel.getBounds(), beforeMenuRequests = resizeRequests.length;
  await js(panel, 'miniModelButton.click()');
  await until(() => js(panel, 'miniModelButton.getAttribute("aria-expanded")==="true"'), 'model menu visible');
  const openedMenuSamples = await sampleMotion(panel, 'menu-open', 220);
  check('nativeModelMenuFitsWithoutResizingOrMovingTheWindow', openedMenuSamples.every(row => sameBounds(row, beforeMenu))
    && resizeRequests.slice(beforeMenuRequests).every(height => height === beforeMenu.height)
    && await js(panel, '(()=>{const menu=miniModelMenu.getBoundingClientRect();return menu.top>=miniCard.getBoundingClientRect().top&&menu.bottom<=innerHeight&&Math.abs(miniCard.getBoundingClientRect().height-(innerHeight-32))<=1})()'));
  await capture(panel, 'model-menu');
  await js(panel, 'miniModelButton.click()');
  const closedMenuSamples = await sampleMotion(panel, 'menu-close', 180);
  check('closingTheNativeModelMenuKeepsTheSameBounds', closedMenuSamples.every(row => sameBounds(row, beforeMenu))
    && resizeRequests.slice(beforeMenuRequests).every(height => height === beforeMenu.height));

  // A second isolated blank fixture obtains native OS focus. It is deliberately
  // not Relay's main document and is destroyed immediately after the blur check.
  probe = new BrowserWindow({ width: 160, height: 90, show: false, skipTaskbar: true });
  await probe.loadURL('data:text/html,<title>Relay focus fixture</title>');
  let blurred = false; panel.once('blur', () => { blurred = true; });
  probe.show(); probe.focus(); await delay(220);
  await until(() => blurred, 'native panel blur');
  check('nativeBlurLeavesChatVisible', blurred && panel.isVisible());
  probe.destroy(); probe = null; panel.focus();

  const workArea = screen.getDisplayMatching(panel.getBounds()).workArea;
  const moved = { ...panel.getBounds(), x: workArea.x + 44, y: workArea.y + 60 };
  panel.setBounds(moved); await delay(200);
  host.hide(); host.show(); await delay(80);
  check('hideAndReopenPreserveTheSameNativeWindowAndPosition', host.getPanelWindow() === panel && panel.getBounds().x === moved.x && panel.getBounds().y === moved.y);
  await js(panel, 'document.querySelector("#miniPin").click()');
  await until(() => !panel.isAlwaysOnTop(), 'unpin window');
  check('pinButtonUpdatesNativeAlwaysOnTopAndSavedPreference', settings.miniWindowPinned === false);
  await js(panel, 'document.querySelector("#miniPin").click()');
  await until(() => panel.isAlwaysOnTop(), 'pin window again');

  const compactHeight = panel.getSize()[1];
  await js(panel, `document.querySelector('#miniInput').value = '在小窗里解释这份交付物'; document.querySelector('#miniInput').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#miniSend').click();`);
  await until(() => submissions.length === 1, 'inline submit received');
  await until(() => js(panel, 'document.querySelector(".mini-process[open] .mini-process-entry-body")?.textContent.includes("正在生成")'), 'streaming process visible');
  await until(() => panel.getSize()[1] > compactHeight, 'window naturally expands');
  check('firstPromptStaysInTheMiniWindowAndRendersStreamingProcess', mainOpened === 0 && panel.isVisible()
    && await js(panel, 'document.querySelector(".mini-user").textContent.includes("交付物") && document.querySelector(".mini-answer").hidden && document.querySelector(".mini-process-entry-body").textContent.includes("正在生成")'));
  check('expandedWindowStaysInsideTheRealMonitorWorkArea', inside(panel.getBounds(), workArea));
  await capture(panel, 'streaming');

  await delay(600);
  const streamStartHeight = panel.getSize()[1], streamStartRequests = resizeRequests.length;
  const processSizing = await js(panel, `(()=>{const content=document.querySelector('.mini-process-content'),body=document.querySelector('.mini-process-entry-body');return {height:content.getBoundingClientRect().height,maxHeight:parseFloat(getComputedStyle(content).maxHeight),lineHeight:parseFloat(getComputedStyle(body).lineHeight)}})()`);
  // This fixture streams into the bounded process inspector, not a final answer.
  // Its own height cap can stop window growth before the native monitor limit.
  const growthBudget = Math.max(0, Math.min(processSizing.maxHeight - processSizing.height,
    Math.min(600, workArea.height - 24) - streamStartHeight));
  const expectedGrowth = Math.min(160, growthBudget);
  const minimumRetargets = Math.min(5, Math.max(1, Math.ceil((expectedGrowth - 2) / (processSizing.lineHeight * 2))));
  Object.assign(motionExpectations, { workArea, streamStartHeight, processSizing, growthBudget, expectedGrowth, minimumRetargets });
  const sampler = sampleMotion(panel, 'continuous-stream-growth', 1600);
  for (const length of [2, 4, 6, 8, 10, 12, 14, 18, 22]) {
    chat.conversation.turns[0].preview = '**正在生成**\n\n' + Array.from({ length }, (_, i) => `- 第 ${i + 1} 个实现步骤`).join('\n');
    publish(); await delay(65);
  }
  await until(() => js(panel, 'document.querySelector(".mini-process-entry-body").textContent.includes("第 22 个实现步骤")'), 'long streaming list');
  const growth = await sampler;
  const totalGrowth = panel.getSize()[1] - streamStartHeight;
  const steps = growth.slice(1).map((row, i) => ({ delta: row.height - growth[i].height, elapsed: row.at - growth[i].at }));
  check('continuousStreamRetargetsAcrossMultipleSmoothNativeFrames', expectedGrowth >= 12 && totalGrowth >= expectedGrowth - 2
    && new Set(growth.map(row => row.height)).size >= 7
    && new Set(resizeRequests.slice(streamStartRequests)).size >= minimumRetargets
    && steps.every(step => step.delta >= -2)
    && steps.filter(step => step.elapsed <= 48).every(step => step.delta <= Math.max(80, totalGrowth * .38)));
  check('composerTracksTheActualViewportThroughoutNativeAnimation', growth.every(row => row.inlineTranscriptHeight === ''
    && Math.abs(row.cardHeight - (row.viewport - 32)) <= 1.5
    && row.composerBottom <= row.viewport - 17 && row.composerBottom >= row.viewport - 21));
  const resizeCount = resizeRequests.length;
  const settled = await sampleMotion(panel, 'settled-after-stream', 260);
  check('longReplyExpandsWithinLimitsAndResizeFeedbackSettles', panel.getSize()[0] <= 520 && panel.getSize()[1] <= Math.min(600, workArea.height - 24)
    && resizeRequests.length - resizeCount <= 1 && new Set(settled.map(row => row.height)).size === 1);
  await js(panel, '(()=>{const content=document.querySelector(".mini-process-content");content.scrollTop=0;content.dispatchEvent(new Event("scroll"));})()');
  chat.conversation.turns[0].preview += '\n\n新的输出继续到达。'; publish();
  const reading = await sampleMotion(panel, 'reading-older-output', 300);
  check('nativeResizeAndNewOutputDoNotPullReadersAwayFromEarlierContent', reading.every(row => row.processScrollTop <= 1
    && row.processScrollHeight > row.processClientHeight + 100
    && Math.abs(row.cardHeight - (row.viewport - 32)) <= 1.5
    && row.composerBottom <= row.viewport - 17 && row.composerBottom >= row.viewport - 21));
  const output = '## 已完成\n\n**结果保留在快捷小窗中。**\n\n- 支持连续对话\n- 可以随时收起\n\n```js\nconsole.log("Relay");\n```';
  Object.assign(chat.conversation.turns[0], { assistant: output, preview: '', status: 'complete', activityLabel: '已完成' });
  chat.running = false; chat.runId = null; publish();
  await until(() => js(panel, 'document.querySelector(".mini-answer h2")?.textContent === "已完成"'), 'final Markdown');
  await delay(600);
  check('finalAnswerUsesTheSameMarkdownContainerAndShowsCopyControl', await js(panel,
    'document.querySelectorAll(".mini-turn").length === 1 && !!document.querySelector(".mini-answer pre code") && !![...document.querySelectorAll(".mini-turn button")].find(button=>button.title.includes("复制") || button.getAttribute("aria-label")?.includes("复制"))'));
  await capture(panel, 'final');

  await js(panel, `document.querySelector('#miniInput').value = '继续说明下一步'; document.querySelector('#miniInput').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#miniSend').click();`);
  await until(() => submissions.length === 2, 'second inline prompt');
  await until(() => js(panel, 'document.querySelectorAll(".mini-turn").length === 2'), 'two preserved turns');
  check('followUpKeepsTheSameConversationWithoutMainWindowHandoff', chat.conversation.id === 'fixture-conversation' && mainOpened === 0);
  await js(panel, 'document.querySelector("#miniHide").click()');
  await until(() => !panel.isVisible(), 'hide during synthetic run');
  check('hidingDuringStreamingPreservesRunAndWindow', chat.running && !panel.isDestroyed());
  host.show(); await delay(120);
  check('reopeningRestoresBothTurnsAndCurrentRun', await js(panel, 'document.querySelectorAll(".mini-turn").length === 2 && document.querySelector("#miniSend").classList.contains("is-stop")'));

  await panel.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => js(panel, 'matchMedia("(prefers-reduced-motion: reduce)").matches'), 'reduced motion preference');
  const beforeReduced = resizeSignals.length;
  await js(panel, 'miniSend.click()'); await until(() => !chat.running, 'pause before reduced-motion new chat');
  await js(panel, 'miniNew.click()');
  await until(() => panel.getSize()[1] === 246 && chat.conversation === null, 'reduced-motion collapse');
  await js(panel, `miniInput.value='减少动画时继续对话';miniInput.dispatchEvent(new Event('input',{bubbles:true}));miniSend.click();`);
  await until(() => submissions.length === 3, 'reduced-motion submit');
  chat.conversation.turns[0].preview = '**减少动画**\n\n' + Array.from({ length: 24 }, (_, i) => `- 第 ${i + 1} 项仍然清晰可读`).join('\n');
  publish();
  await until(async () => panel.getSize()[1] > 246 && resizeSignals.length > beforeReduced + 1
    && await js(panel, '(()=>{const content=document.querySelector(".mini-process-content");return content?.textContent.includes("第 24 项")&&content.scrollHeight>content.clientHeight+100})()')
    && sameBounds(panel.getBounds(), resizeSignals.at(-1).target), 'reduced-motion expansion to bounded content');
  await delay(120);
  const reducedSignals = resizeSignals.slice(beforeReduced);
  check('reducedMotionReachesEveryRequestedNativeSizeImmediately', reducedSignals.length >= 2
    && reducedSignals.every(signal => signal.reducedMotion && signal.target && signal.actual && sameBounds(signal.target, signal.actual))
    && await js(panel, 'getComputedStyle(miniCard).animationName==="none"&&getComputedStyle(miniSend).transitionDuration.split(",").every(value=>parseFloat(value)===0)'));
  const reducedCount = resizeRequests.length;
  const reducedSettled = await sampleMotion(panel, 'settled-reduced-motion', 180);
  check('reducedMotionAlsoSettlesWithoutResizeFeedback', resizeRequests.length === reducedCount
    && new Set(reducedSettled.map(row => row.height)).size === 1);
  panel.webContents.debugger.detach();

  const originalOrb = orb.getBounds();
  syntheticCursor = { x: originalOrb.x + 20, y: originalOrb.y + 20 }; host.orbDrag({ phase: 'start' });
  syntheticCursor = { x: originalOrb.x - 50, y: originalOrb.y - 30 }; const dragResult = host.orbDrag({ phase: 'end' });
  await delay(180); syntheticCursor = null;
  check('controlledCursorDragMovesRealOrbAndPersistsPosition', dragResult.moved && orb.getBounds().x !== originalOrb.x
    && settings.floatingOrbPosition.x === orb.getBounds().x);
  panel.setBounds({ ...panel.getBounds(), x: workArea.x - 8000, y: workArea.y - 8000 });
  nativeScreens.emit('display-metrics-changed'); await delay(100);
  check('displayChangeClampsBothRealWindowsIntoAvailableWorkAreas', [panel, orb].every(win => inside(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea)));
  check('onlyTwoRelayMiniWindowsExistAndNoMainWindowOpened', BrowserWindow.getAllWindows().length === 2 && mainOpened === 0);

  const savedOrbPosition = { ...settings.floatingOrbPosition };
  host.hideOrbForSession();
  await until(() => orb.isDestroyed(), 'hidden orb destroyed');
  check('hidingTheOrbReleasesItsWindowAndKeepsTheChat', host.getOrbWindow() === null
    && BrowserWindow.getAllWindows().length === 1 && host.getPanelWindow() === panel && !panel.isDestroyed());
  host.showOrb();
  const recreatedOrb = host.getOrbWindow();
  await until(() => recreatedOrb?.isVisible(), 'orb recreated');
  check('recreatedOrbRetainsItsPositionAndDoesNotRecreateChat', recreatedOrb !== orb
    && recreatedOrb.getBounds().x === savedOrbPosition.x && recreatedOrb.getBounds().y === savedOrbPosition.y
    && host.getPanelWindow() === panel && BrowserWindow.getAllWindows().length === 2);
  settings = { ...settings, quickChatEnabled: false, miniInputEnabled: false, floatingOrbEnabled: false };
  host.syncSettings();
  check('disablingQuickChatReleasesTheOrbButPreservesItsConversationWindow', recreatedOrb.isDestroyed()
    && host.getOrbWindow() === null && host.getPanelWindow() === panel && !panel.isDestroyed() && !panel.isVisible());

  host.destroy(); const writesAfterDestroy = settingsWrites; await delay(250);
  check('quitDestroysBothNativeWindowsAndLeavesNoLatePersistence', panel.isDestroyed() && orb.isDestroyed() && BrowserWindow.getAllWindows().length === 0 && writesAfterDestroy === settingsWrites);
  stage = 'complete'; finish();
}).catch(finish);
