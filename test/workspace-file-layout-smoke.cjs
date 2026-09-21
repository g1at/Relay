'use strict';
// Real renderer, Chromium pointer capture and production layout. All file/model
// operations are synthetic; no terminal, user directory or network is opened.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/workspace-file-layout-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start', pointer;
const checks = {}, errors = [], samples = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors, samples }, null, 2));
const deadline = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function frame() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function settle() { await delay(330); await frame(); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function beginDrag() {
  pointer = await evaluate("(()=>{const r=$('workspaceTreeResizeHandle').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+80)}})()");
  win.webContents.sendInputEvent({ type: 'mouseMove', ...pointer });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...pointer, button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] });
  await waitFor('relayWorkspaceFileLayout.getState().dragging');
}
async function move(width) {
  const x = await evaluate(`Math.round($('workspaceFileBody').getBoundingClientRect().right-${width})`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y: pointer.y, movementX: x - pointer.x, modifiers: ['leftButtonDown'] });
  pointer.x = x; await frame();
}
async function endDrag() { win.webContents.sendInputEvent({ type: 'mouseUp', ...pointer, button: 'left', clickCount: 1 }); await settle(); }
async function sampleDrag(name, widths) {
  await beginDrag(); samples[name] = [];
  for (const width of widths) {
    await move(width);
    samples[name].push(await evaluate(`(()=>{const state=relayWorkspaceFileLayout.getState(),tree=$('workspaceTreePane').getBoundingClientRect(),body=$('workspaceFileBody').getBoundingClientRect();return{requested:${width},logical:state.width,actual:tree.width,rightGap:body.right-tree.right,transition:getComputedStyle($('workspaceTreePane')).transitionDuration}})()`));
  }
  save(); await endDrag();
}
async function sampleMotion(name) {
  samples[name] = await evaluate("new Promise(resolve=>{const values=[],start=performance.now();function tick(){const tree=$('workspaceTreePane').getBoundingClientRect(),body=$('workspaceFileBody').getBoundingClientRect();values.push({at:performance.now()-start,width:tree.width,rightGap:body.right-tree.right});if(performance.now()-start>=290)resolve(values);else requestAnimationFrame(tick)}tick()})");
  save();
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const base = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.clear();const base=window.api;const workspace={
    resolve:async context=>({ok:true,root:'C:/Synthetic/FileLayout',conversationId:context.conversationId}),
    list:async()=>({ok:true,entries:[{name:'README.md',path:'README.md',type:'file',size:300},{name:'main.js',path:'main.js',type:'file',size:100},...Array.from({length:20},(_,i)=>({name:'example-'+i+'.md',path:'example-'+i+'.md',type:'file',size:30}))]}),
    read:async({path})=>({ok:true,path,content:path.endsWith('.js')?'const answer = 42;':'# 项目交付说明\\n\\n本页使用合成内容验证目录宽度。\\n\\n## 已完成\\n\\n- 连续调整目录\\n- 保留阅读空间\\n- 保存个人布局'}),
    onTerminalEvent:()=>()=>{}};window.api=new Proxy(base,{get(target,key){return key==='workspace'?workspace:target[key]}});})();`;
  const file = path.join(output, 'fixture.html');
  fs.writeFileSync(file, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${base}\n${seed}</script>`));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(file); win.showInactive(); await waitFor('!!window.relayWorkspaceFileLayout&&!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act("relayWorkspacePanel.open('files');$('workspaceMaximize').click()"); await waitFor("!!document.querySelector('[data-path=\"README.md\"]')"); await settle();
  await check('WidePickerKeepsCentralEmptyStateAndResizableDirectory', "$('workspacePreview').hidden&&getComputedStyle($('workspaceFileEmpty')).display!=='none'&&!$('workspaceTreeResizeHandle').hidden&&Math.abs($('workspaceTreePane').getBoundingClientRect().width-230)<1");
  await sampleDrag('wideContinuous', [231, 278, 340, 310]);
  await check('WideTreeTracksPointerWithoutTrailingAnimation', `(${JSON.stringify(samples.wideContinuous)}).every(s=>Math.abs(s.actual-s.requested)<=1&&Math.abs(s.logical-s.requested)<=1&&Math.abs(s.rightGap)<=1&&s.transition==='0s')`);
  await check('InnerDividerNeverChangesOuterPanelWidth', 'relayWorkspacePanel.getState().width===document.querySelector(".app").clientWidth&&relayWorkspacePanel.getState().maximized');
  await capture('wide-picker');
  await act("document.querySelector('[data-path=\"README.md\"]').click()"); await waitFor("!!$('workspacePreviewBody').querySelector('h1')"); await settle();
  await check('OpeningFilePreservesTheChosenDirectoryWidth', "relayWorkspaceFileLayout.getState().preferredWidth===310&&Math.abs($('workspaceTreePane').getBoundingClientRect().width-310)<1");
  await beginDrag(); await move(127);
  await check('CollapsedGestureKeepsNativePointerCaptureAndMovesToRightEdge', "relayWorkspaceFileLayout.getState().collapsed&&relayWorkspaceFileLayout.getState().dragging&&!$('workspaceTreeResizeHandle').hidden&&$('workspaceTreePane').inert&&$('workspaceFileBody').classList.contains('is-file-tree-snapping')");
  await sampleMotion('collapseFrames');
  await check('CollapseAnimatesThroughIntermediateWidthsAlongTheRightEdge', `(()=>{const a=${JSON.stringify(samples.collapseFrames)};return new Set(a.map(s=>Math.round(s.width))).size>=3&&a.some(s=>s.width>0&&s.width<310)&&a.every((s,i)=>Math.abs(s.rightGap)<=1&&(!i||s.width<=a[i-1].width+1))})()`);
  await settle(); await check('SettledCollapseLeavesNoDirectoryGap', "$('workspaceTreePane').getBoundingClientRect().width===0&&Math.abs($('workspacePreview').getBoundingClientRect().right-$('workspaceFileBody').getBoundingClientRect().right)<1");
  await move(159); await check('HysteresisRetainsCollapsedState', 'relayWorkspaceFileLayout.getState().width===0');
  await move(160); await sampleMotion('reopenFrames');
  await check('ReverseGestureAnimatesContinuouslyBackIntoTheFileLayout', `(()=>{const a=${JSON.stringify(samples.reopenFrames)};return new Set(a.map(s=>Math.round(s.width))).size>=3&&a.some(s=>s.width>0&&s.width<160)&&a.every((s,i)=>Math.abs(s.rightGap)<=1&&(!i||s.width>=a[i-1].width-1))})()`);
  await check('SameCapturedGestureCanReopenTheTree', "relayWorkspaceFileLayout.getState().width===160&&!$('workspaceTreePane').inert&&relayWorkspaceFileLayout.getState().dragging");
  await move(127); await endDrag(); await check('CollapsedPreferenceRetainsLastUsefulWidth', "JSON.parse(localStorage.getItem('relay.workspace-file-layout.v1')).width===310&&JSON.parse(localStorage.getItem('relay.workspace-file-layout.v1')).collapsed&&$('workspaceTreeResizeHandle').hidden");
  await act("$('workspaceTreeToggle').click()"); await settle(); await check('HeaderToggleRestoresPriorWidth', 'relayWorkspaceFileLayout.getState().width===310');
  await beginDrag(); await move(127);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
  await waitFor('!relayWorkspaceFileLayout.getState().dragging'); await endDrag();
  await check('NativeEscapeRestoresExpandedWidthAndPreference', "relayWorkspaceFileLayout.getState().width===310&&!relayWorkspaceFileLayout.getState().collapsed&&!JSON.parse(localStorage.getItem('relay.workspace-file-layout.v1')).collapsed");
  await capture('wide-preview');
  await act("$('workspaceMaximize').click()"); await settle();
  await check('NarrowPreviewTemporarilyClosesDirectoryWithoutChangingPreference', "relayWorkspaceFileLayout.getState().narrow&&relayWorkspaceFileLayout.getState().width===0&&!relayWorkspaceFileLayout.getState().collapsed&&relayWorkspaceFileLayout.getState().preferredWidth===310");
  await act("$('workspaceTreeToggle').click()"); await settle();
  await sampleDrag('narrowContinuous', [250, 221, 200, 260]);
  await check('NarrowDrawerTracksPointerWithoutCssLag', `(${JSON.stringify(samples.narrowContinuous)}).every(s=>Math.abs(s.actual-s.requested)<=1&&Math.abs(s.logical-s.requested)<=1&&Math.abs(s.rightGap)<=1&&s.transition==='0s')`);
  await check('NarrowDrawerStaysInsidePanelAndPreventsHiddenPreviewFocus', "$('workspacePreview').inert&&$('workspaceTreePane').getBoundingClientRect().left>=$('workspaceFileBody').getBoundingClientRect().left+23&&$('workspaceTreeResizeHandle').getBoundingClientRect().left>=$('workspaceFileBody').getBoundingClientRect().left");
  await capture('narrow-directory');
  await act("$('workspaceTreeToggle').click()"); await settle(); await check('ClosingDrawerRestoresPreviewKeyboardAccess', "!$('workspacePreview').inert&&$('workspaceTreePane').inert");
  await act("$('workspacePreviewBack').click()"); await settle();
  await check('NarrowPickerStillExposesFilesDespiteSavedCollapse', "getComputedStyle($('workspaceFileEmpty')).display==='none'&&!$('workspaceTreePane').inert&&Math.abs($('workspaceTreePane').getBoundingClientRect().width-$('workspaceFileBody').clientWidth)<1&&$('workspaceTreeResizeHandle').hidden");
  await act("document.querySelector('[data-path=\"main.js\"]').click();$('workspaceMaximize').click()"); await waitFor("!!$('workspacePreviewBody').querySelector('pre')"); await settle();
  await check('DifferentFileAndWideRestoreRespectSavedCollapse', 'relayWorkspaceFileLayout.getState().collapsed&&relayWorkspaceFileLayout.getState().width===0');
  await act("$('workspaceTreeToggle').click();$('workspaceTreeResizeHandle').focus()"); await settle();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'HOME' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'HOME' }); await settle();
  await check('NativeKeyboardCanSetMinimumWidth', 'relayWorkspaceFileLayout.getState().width===160');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' }); await settle();
  await check('KeyboardCollapseMovesFocusToTheVisibleTreeToggle', "relayWorkspaceFileLayout.getState().collapsed&&document.activeElement===$('workspaceTreeToggle')");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await settle();
  await check('NativeEnterReopensDirectoryAfterKeyboardCollapse', 'relayWorkspaceFileLayout.getState().width===160&&!relayWorkspaceFileLayout.getState().collapsed');
  await act("document.documentElement.dataset.theme='dark'"); await capture('dark-directory');
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await act("$('workspaceTreeToggle').click()"); await frame();
  await check('ReducedMotionCollapsesWithoutTransitionOrAnimationClass', "$('workspaceTreePane').getBoundingClientRect().width===0&&!$('workspaceFileBody').classList.contains('is-file-tree-snapping')&&getComputedStyle($('workspaceTreePane')).transitionDuration==='0s'");
  await check('RendererRemainsSandboxedAndOffline', "typeof require==='undefined'&&typeof process==='undefined'&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')");
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { errors.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {} clearTimeout(deadline); app.exit(1); });
