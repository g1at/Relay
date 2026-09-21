'use strict';
// Production renderer + real xterm in an isolated Electron profile. All workspace
// files, terminal transport and model calls here are synthetic in-memory fixtures.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/workspace-panel-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start';
const checks = {}, errors = [], terminalRequests = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout at ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(360); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25);};tick();})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (/\/vendor\/xterm(?:-addon-fit)?\.js$/.test(details.url)) terminalRequests.push(details.url);
    done({ cancel: /^https?:/i.test(details.url) });
  });
  const baseFixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(() => {
    localStorage.clear(); const base=window.api;
    const state=window.workspaceReview={resolves:[],lists:[],reads:[],opens:[],starts:[],inputs:[],resizes:[],closes:[],events:null,holdRead:null};
    state.activeTerminal=()=>{const panel=window.relayWorkspacePanel.getState();return panel.tabs.find(tab=>tab.id===panel.activeId)?.sessionId;};
    state.selectTerminal=id=>{const tab=window.relayWorkspacePanel.getState().tabs.find(tab=>tab.sessionId===id);document.querySelector('[data-tab-id="'+tab.id+'"] .workspace-tab').click();};
    const ws={
      resolve:async context=>{state.resolves.push(context);if(state.holdResolve){state.holdResolve=false;await new Promise(resolve=>state.releaseResolve=resolve);}return{ok:true,root:context.workingDir||'C:\\\\Synthetic\\\\RelayProjects\\\\'+context.conversationId,conversationId:context.conversationId,managed:!context.workingDir};},
      list:async({context,path})=>{state.lists.push({context,path});return{ok:true,entries:path==='notes'?[{name:'progress.md',path:'notes/progress.md',type:'file',size:500}]:[{name:'notes',path:'notes',type:'directory'},{name:'README.md',path:'README.md',type:'file',size:700},{name:'main.js',path:'main.js',type:'file',size:50},{name:'pending.md',path:'pending.md',type:'file',size:100}]};},
      read:async({context,path})=>{state.reads.push({context,path});if(path==='pending.md')return new Promise(resolve=>state.holdRead=resolve);return{ok:true,path,content:path.endsWith('.js')?'const answer = 42;':'# 项目进展\\n\\n**已完成** 本地文件整理。\\n\\n| 文件 | 状态 |\\n| --- | --- |\\n| README.md | 完成 |\\n\\n- [x] 归档记录\\n- [ ] 下一步计划\\n\\n\\\x60\\\x60\\\x60js\\nconsole.log("Relay");\\n\\\x60\\\x60\\\x60\\n\\n[危险](javascript:alert(1))\\n![远程图片](https://invalid.example/a.png)'};},
      open:async value=>{state.opens.push(value);return{ok:true};},
      terminalStart:async({context,cols,rows})=>{if(state.failStart)return{ok:false,error:'合成终端启动失败'};const id='terminal-'+(state.starts.length+1);state.starts.push({context,id,cols,rows});state.events({id,type:'data',data:'\\x1b[32mRelay workspace terminal\\x1b[0m\\r\\nPS C:\\\\Synthetic> '});if(state.holdStart){state.holdStart=false;await new Promise(resolve=>state.releaseStart=resolve);}return{ok:true,id,root:context.workingDir||'C:\\\\Synthetic\\\\RelayProjects\\\\'+context.conversationId};},
      terminalInput:async value=>{state.inputs.push(value);state.events({id:value.id,type:'data',data:value.data});return{ok:true};},
      terminalResize:async value=>{state.resizes.push(value);if(state.failResize){state.failResize=false;return{ok:false,error:'合成尺寸暂时失败'};}return{ok:true};},
      terminalClose:async value=>{state.closes.push(value);state.events({id:value.id,type:'exit',exitCode:0});return{ok:true};},
      onTerminalEvent:fn=>{state.events=fn;return()=>{};}
    };
    window.api=new Proxy(base,{get(target,key){if(key==='workspace')return ws;if(key==='projects')return{list:async()=>({ok:true,projects:[{id:'93000000-0000-4000-8000-000000000001',name:'草稿终端项目',path:'C:/Synthetic/TerminalProject'}]})};if(key==='history')return new Proxy(target.history,{get(original,method){if(method==='save')return value=>{if(state.holdSave){state.holdSave=false;return new Promise((resolve,reject)=>{state.releaseSave=()=>original.save(value).then(resolve,reject);state.rejectSave=reject;});}return original.save(value);};return original[method];}});if(key==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return target[key];}});
  })();`;
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + baseFixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 800, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 36 }, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await check('NoDirectoriesOrShellUntilUserOpensPanel', 'workspaceReview.resolves.length===0&&workspaceReview.starts.length===0&&!relayWorkspacePanel.getState().open');
  await act("$('btnWorkspacePanel').click();"); await settle();
  await check('FirstOpenShowsLauncherWithoutCreatingAToolOrDirectory', '!$("workspaceNoTabs").hidden&&relayWorkspacePanel.getState().tabs.length===0&&relayWorkspacePanel.getState().tab===null&&workspaceReview.resolves.length===0&&workspaceReview.starts.length===0');
  await check('EmptyLauncherHidesTheTabAddButtonAndFileTreeToggle', 'getComputedStyle($("workspaceAdd")).display==="none"&&getComputedStyle($("workspaceTabs")).display==="none"&&$("workspaceTreeToggle").hidden');
  await capture('first-open-launcher');
  await act('$("workspaceNoTabs").querySelector("[data-workspace-create=files]").click();');
  await check('CreatingFirstToolRevealsTheTabAddButton', 'getComputedStyle($("workspaceAdd")).display!=="none"&&relayWorkspacePanel.getState().tabs.length===1');
  await waitFor("document.querySelectorAll('.workspace-file-row').length===4"); await settle();
  await check('OpeningFilesDoesNotCreateHistoryOrStartModel', 'workspaceReview.resolves.length>0&&!currentConv&&!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
  await check('FilesAndChatDoNotLoadTerminalLibraries', 'typeof Terminal==="undefined"&&typeof FitAddon==="undefined"');
  await act('workspaceReview.draftContext=relayConversationWorkspace();');
  await check('DraftFolderIdentityIsStable', 'relayConversationWorkspace().conversationId===workspaceReview.draftContext.conversationId&&/^[0-9a-f-]{36}$/.test(workspaceReview.draftContext.conversationId)');
  await check('DefaultPanelKeepsMainReadable', 'Math.round($\x28"workspacePanel"\x29.getBoundingClientRect().width)===380&&document.querySelector(".chat").getBoundingClientRect().width>=360');
  await check('PanelStartsBelowChromeAndCaptionButtonsStaySeparate', '$("workspacePanel").getBoundingClientRect().top>=36&&$("btnWorkspacePanel").getBoundingClientRect().right<=innerWidth-144&&!document.querySelector(".task-center-edge-trigger")');
  await check('RightPanelDividerMeetsConversationHeader', 'Math.abs(document.querySelector(".workspace-panel-header").getBoundingClientRect().bottom-document.querySelector(".chat-header").getBoundingClientRect().bottom)<1');
  await check('FilePickerStartsAtConversationDividerWithoutRestoringTopFrame', '(()=>{const edge=document.querySelector(".chat-header").getBoundingClientRect().bottom,root=document.querySelector(".workspace-root").getBoundingClientRect();return Math.abs(root.top-edge)<1&&getComputedStyle(document.querySelector(".workspace-panel-header")).borderBottomWidth==="0px"})()');
  await check('NoScrimOrPageOverflow', 'document.documentElement.scrollWidth<=innerWidth&&!document.querySelector(".task-center-scrim")');
  await act("document.querySelector('.workspace-file-row[data-path=notes]').click();");
  await waitFor("!!document.querySelector('[data-path=\"notes/progress.md\"]')");
  await check('FolderExpandsWithHierarchy', 'document.querySelectorAll(".workspace-file-row")[1].style.getPropertyValue("--file-depth")==="1"');
  await act("document.querySelector('.workspace-file-row[data-path=\"README.md\"]').click();");
  await waitFor("!!$('workspacePreviewBody').querySelector('table')");
  await check('MarkdownFileUsesStructuredReadOnlyPreview', '$("workspacePreviewBody").querySelector("h1")&&$("workspacePreviewBody").querySelector("strong")&&$("workspacePreviewBody").querySelector("pre code")&&$("workspacePreviewBody").querySelector("input:disabled")');
  await check('MarkdownCannotNavigateOrLoadRemoteImages', '!$("workspacePreviewBody").querySelector("img,[href^=javascript],script,iframe")');
  await check('FileActionsStartAtConversationDividerAndKeepTheirHitArea', '(()=>{const button=$("workspacePreviewBack").getBoundingClientRect(),edge=document.querySelector(".chat-header").getBoundingClientRect().bottom;return Math.abs(button.top-edge)<1&&button.height>=28&&parseFloat(getComputedStyle($("workspacePreviewBody")).paddingTop)<=12})()');
  await capture('files-markdown-light');
  await act("$('workspacePreviewMode').click();");
  await check('MarkdownSourceToggle', '$("workspacePreviewBody").querySelector("pre.workspace-source").textContent.startsWith("# 项目进展")');
  await act("$('workspacePreviewOpen').click();"); await settle();
  await check('SystemOpenUsesWorkspaceContextAndRelativePath', 'workspaceReview.opens.at(-1).path==="README.md"&&workspaceReview.opens.at(-1).context.conversationId===workspaceReview.draftContext.conversationId');
  await act("$('workspacePreviewBack').click();document.querySelector('[data-path=\"pending.md\"]').click();");
  await waitFor('!!workspaceReview.holdRead');
  await act("startNewConv();workspaceReview.holdRead({ok:true,content:'STALE PREVIEW',path:'pending.md'});"); await settle();
  await check('SwitchingConversationDropsStaleFileResponse', '!$("workspacePreviewBody").textContent.includes("STALE PREVIEW")&&$("workspacePreview").hidden&&relayConversationWorkspace().conversationId!==workspaceReview.draftContext.conversationId');
  await act("workspaceReview.terminals=[];Object.defineProperty(window,'Terminal',{configurable:true,get:()=>undefined,set(OriginalTerminal){Object.defineProperty(window,'Terminal',{configurable:true,writable:true,value:class extends OriginalTerminal{constructor(...args){super(...args);workspaceReview.terminals.push(this);}}});}});workspaceReview.draftContext=relayConversationWorkspace();workspaceReview.failResize=true;relayWorkspacePanel.open('terminal',{startTerminal:true});");
  await waitFor("document.querySelectorAll('.workspace-terminal-surface .xterm').length===1&&workspaceReview.resizes.length>0"); await settle();
  await waitFor('workspaceReview.resizes.length>=2');
  await check('RejectedTerminalResizeRetriesSameDimensions', 'workspaceReview.resizes[0].cols===workspaceReview.resizes[1].cols&&workspaceReview.resizes[0].rows===workspaceReview.resizes[1].rows');
  await check('TerminalDraftDoesNotCreateHistoryOrChangeChatTitle', '!currentConv&&relayConversationWorkspace().conversationId===workspaceReview.draftContext.conversationId&&!uiFixture.calls.includes("history.save")&&$("chatTitle").textContent==="新对话"');
  await check('RealXtermMountedAndBackendResized', 'workspaceReview.starts.length===1&&workspaceReview.resizes.at(-1).cols>=10&&workspaceReview.resizes.at(-1).rows>=5');
  await check('TerminalLibrariesLoadOnceOnFirstOpen', `typeof Terminal==="function"&&typeof FitAddon.FitAddon==="function"&&${terminalRequests.length}===2`);
  await check('TerminalFirstRowStartsAtConversationDivider', 'Math.abs(document.querySelector(".workspace-terminal-surface:not([hidden]) .xterm-screen").getBoundingClientRect().top-document.querySelector(".chat-header").getBoundingClientRect().bottom)<1');
  await act("showAppView('settings');showChatView();relayWorkspacePanel.open('terminal',{startTerminal:true});"); await settle();
  await check('TerminalSurvivesPageNavigationWithoutHistory', 'workspaceReview.starts.length===1&&workspaceReview.closes.length===0&&!currentConv&&relayConversationWorkspace().conversationId===workspaceReview.draftContext.conversationId&&workspaceReview.activeTerminal()==="terminal-1"&&!uiFixture.calls.includes("history.save")');
  await act("workspaceReview.slider=()=>document.querySelector('.workspace-terminal-surface:not([hidden]) .scrollbar.vertical > .slider');workspaceReview.expectedColor=name=>{const span=document.createElement('span');span.style.color=getComputedStyle($('workspacePanel')).getPropertyValue(name);$('workspacePanel').append(span);const color=getComputedStyle(span).color;span.remove();return color;};");
  await check('XtermUsesRelayRoundedScrollbar', 'workspaceReview.slider().getBoundingClientRect().width===9&&getComputedStyle(workspaceReview.slider()).borderRadius==="999px"&&getComputedStyle(workspaceReview.slider()).backgroundClip==="padding-box"&&workspaceReview.terminals[0].options.overviewRuler.width===9');
  await check('LegacyViewportDoesNotDrawNativeScrollbarOrBlackBackground', 'getComputedStyle(document.querySelector(".xterm-viewport")).overflowY==="hidden"&&getComputedStyle(document.querySelector(".xterm-viewport")).backgroundColor==="rgba(0, 0, 0, 0)"');
  await check('TerminalCanvasAndScrollbarStayInsidePadding', '(()=>{const host=document.querySelector(".workspace-terminal-surface:not([hidden])"),canvas=host.querySelector(".xterm-screen").getBoundingClientRect(),scroll=workspaceReview.slider().parentElement.getBoundingClientRect(),box=host.getBoundingClientRect();return canvas.right<=scroll.left+1&&scroll.right<=box.right-5&&canvas.bottom<=box.bottom-7;})()');
  await act("workspaceReview.events({id:workspaceReview.starts[0].id,type:'data',data:Array.from({length:240},(_,i)=>'本地合成输出 '+i+'\\r\\n').join('')});");
  await waitFor('workspaceReview.terminals[0].buffer.active.baseY>150'); await settle();
  const terminalPoint = await evaluate('(()=>{const r=document.querySelector(".workspace-terminal-surface:not([hidden]) .xterm-screen").getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+40)};})()');
  await act('workspaceReview.viewportBeforeWheel=workspaceReview.terminals[0].buffer.active.viewportY;workspaceReview.inputsBeforeWheel=workspaceReview.inputs.length;');
  win.webContents.sendInputEvent({ type: 'mouseMove', ...terminalPoint });
  win.webContents.sendInputEvent({ type: 'mouseWheel', ...terminalPoint, deltaY: 220, wheelTicksY: 2, canScroll: true });
  await waitFor('workspaceReview.terminals[0].buffer.active.viewportY<workspaceReview.viewportBeforeWheel');
  await check('CustomTerminalScrollbarPreservesWheelAndTransport', 'workspaceReview.inputs.length===workspaceReview.inputsBeforeWheel&&workspaceReview.slider().parentElement.classList.contains("visible")');
  await act('workspaceReview.terminals[0].scrollToLine(Math.floor(workspaceReview.terminals[0].buffer.active.baseY/2));'); await settle();
  const sliderPoint = await evaluate('(()=>{const r=workspaceReview.slider().getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  await act('workspaceReview.viewportBeforeDrag=workspaceReview.terminals[0].buffer.active.viewportY;');
  win.webContents.sendInputEvent({ type: 'mouseMove', ...sliderPoint });
  await waitFor('getComputedStyle(workspaceReview.slider()).backgroundColor===workspaceReview.expectedColor("--text-muted")');
  await check('ScrollbarHoverUsesRelayThemeColor', 'getComputedStyle(workspaceReview.slider()).backgroundColor===workspaceReview.expectedColor("--text-muted")');
  // Electron's synthetic mouseDown needs the held-button modifier too; xterm
  // compares PointerEvent.buttons throughout a native drag.
  win.webContents.sendInputEvent({ type: 'mouseDown', ...sliderPoint, button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] });
  await waitFor('workspaceReview.slider().classList.contains("active")');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: sliderPoint.x, y: sliderPoint.y-30, movementY: -30, modifiers: ['leftButtonDown'] });
  await waitFor('workspaceReview.terminals[0].buffer.active.viewportY<workspaceReview.viewportBeforeDrag');
  win.webContents.sendInputEvent({ type: 'mouseUp', x: sliderPoint.x, y: sliderPoint.y-30, button: 'left', clickCount: 1 });
  await check('ThinScrollbarRemainsDraggable', 'workspaceReview.inputs.length===workspaceReview.inputsBeforeWheel');
  await act('document.documentElement.dataset.theme="dark";'); await settle();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...terminalPoint }); await settle();
  await check('TerminalScrollbarTracksDarkTheme', 'getComputedStyle(workspaceReview.slider()).backgroundColor===workspaceReview.expectedColor("--border-strong")&&workspaceReview.terminals[0].options.theme.scrollbarSliderHoverBackground===getComputedStyle($("workspacePanel")).getPropertyValue("--text-muted").trim()');
  await check('TerminalRulerAddsNoBrightOutline', '(()=>{const canvas=document.querySelector(".xterm-decoration-overview-ruler"),pixels=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;return pixels.every((value,index)=>index%4!==3||value===0);})()');
  await capture('terminal-scrollbar-dark');
  await act('document.documentElement.dataset.theme="light";workspaceReview.terminals[0].scrollToBottom();'); await settle();
  await act("document.querySelector('.xterm-helper-textarea').focus();");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' }); win.webContents.sendInputEvent({ type: 'char', keyCode: 'a' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  await waitFor('workspaceReview.inputs.length>0');
  await check('TerminalKeyboardUsesOwningSession', 'workspaceReview.inputs.at(-1).id===workspaceReview.starts[0].id');
  for (const key of ['L','N','B','K']) { win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:['control']}); }
  await settle();
  await check('ShellControlKeysBypassGlobalChatShortcuts', 'workspaceReview.inputs.some(e=>e.data===String.fromCharCode(12))&&workspaceReview.inputs.some(e=>e.data===String.fromCharCode(14))&&relayConversationWorkspace().conversationId===workspaceReview.draftContext.conversationId&&!currentConv&&document.activeElement.classList.contains("xterm-helper-textarea")');
  await capture('terminal-light');
  await act("relayWorkspacePanel.create('terminal');"); await waitFor('workspaceReview.starts.length===2&&document.querySelectorAll(".workspace-terminal-surface").length===2');
  await check('EachTerminalHasItsOwnTopLevelTab', 'relayWorkspacePanel.getState().tabs.filter(tab=>tab.kind==="terminal").length===2&&!$("workspaceTerminalSelect")&&new Set([...document.querySelectorAll("[data-workspace-tab=terminal]")].map(node=>node.id)).size===2');
  await capture('independent-terminal-tabs');
  await act('workspaceReview.selectTerminal("terminal-1");');
  await check('ClickingTerminalTabRestoresItsOutput', 'workspaceReview.activeTerminal()==="terminal-1"&&workspaceReview.terminals[0].buffer.active.baseY>150');
  await act('workspaceReview.selectTerminal("terminal-2");');
  await act("$('workspaceTabs').querySelector('.workspace-tab-item.is-active .workspace-tab-close').click();"); await settle();
  await check('ClosingTerminalStopsOnlySelectedProcess', 'workspaceReview.closes.length===1&&workspaceReview.closes[0].id==="terminal-2"&&workspaceReview.activeTerminal()==="terminal-1"');
  await act("relayWorkspacePanel.open('files');$('input').value='合成工作目录测试';$('btnSend').click();");
  await waitFor('!!currentConv&&!!currentConv.id');
  await waitFor('uiFixture.calls.includes("runClaude")');
  await check('FileHeaderTracksSameConversationTitle', '$("workspaceRootTitle").textContent===currentConv.title');
  await check('FirstMessageAdoptsDraftFolderIdentity', 'currentConv.id===workspaceReview.draftContext.conversationId&&relayConversationWorkspace().conversationId===workspaceReview.draftContext.conversationId');
  await check('FirstMessageCreatesOnlyTheRealConversation', 'uiFixture.calls.filter(call=>call==="history.save").length===1&&currentConv.turns.length===1&&currentConv.title==="合成工作目录测试"&&!currentConv.terminalWorkspaceOnly&&workspaceReview.starts.length===2');
  await act('workspaceReview.savedId=currentConv.id;startNewConv();'); await settle();
  await check('ChangingConversationRetainsBackgroundTerminalWithoutStartingOne', 'workspaceReview.starts.length===2&&workspaceReview.closes.length===1&&document.querySelectorAll(".workspace-terminal-surface").length===1');
  await act("loadConversation(workspaceReview.savedId);"); await waitFor('currentConv&&currentConv.id===workspaceReview.savedId');
  await act("relayWorkspacePanel.open('terminal',{startTerminal:true});"); await settle();
  await check('ReturningToConversationRestoresTerminal', 'workspaceReview.starts.length===2&&workspaceReview.activeTerminal()==="terminal-1"&&!$("workspaceTerminalEmpty").hidden===false');
  await act("relayWorkspacePanel.open('files');"); await settle();
  await check('FilesRemainDockedAndNonModal', 'relayWorkspacePanel.isActive("files")&&!$("workspaceFiles").hidden&&!$("workspaceFiles").hasAttribute("aria-modal")');
  await act("$('input').focus();");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' }); await settle();
  await check('DockedFilesDoNotTrapConversationFocus', '!$("workspaceFiles").contains(document.activeElement)');
  await capture('docked-files-light');
  await act("relayWorkspacePanel.open('files');$('workspaceResizeHandle').focus();");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'HOME' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'HOME' }); await settle();
  await check('KeyboardResizesToHardMinimum', 'relayWorkspacePanel.getState().width===300&&$("workspacePanel").getBoundingClientRect().width===300');
  await act("window.workspaceReviewDrag=(delta,type='pointerup')=>{const h=$('workspaceResizeHandle'),r=h.getBoundingClientRect(),x=r.x+4;h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:91,clientX:x,button:0,bubbles:true,isPrimary:true}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:91,clientX:x-delta,bubbles:true}));window.dispatchEvent(new PointerEvent(type,{pointerId:91,clientX:x-delta,bubbles:true}));};workspaceReviewDrag(73);"); await settle();
  await check('PointerWidthIsContinuousAndPersisted', 'relayWorkspacePanel.getState().width===373&&Number(localStorage.getItem("relay.workspace-panel.width.v1"))===373');
  await act('workspaceReview.leftBeforeFull={...relaySidebarLayout.getState(),saved:localStorage.getItem("relay.sidebar.layout.v2")};workspaceReviewDrag(370);'); await settle();
  await check('PanelReflowsChatAndSidebarBeyondTheOldMaximum', 'relayWorkspacePanel.getState().width===743&&Math.abs($("workspacePanel").getBoundingClientRect().width-743)<1&&!document.querySelector(".chat").inert&&relaySidebarLayout.getState().width<workspaceReview.leftBeforeFull.width&&relaySidebarLayout.getState().preferredWidth===workspaceReview.leftBeforeFull.preferredWidth&&document.documentElement.scrollWidth<=innerWidth');
  await capture('reflow-intermediate');
  await act(`workspaceReview.geometry=[];window.checkWorkspaceGeometry=()=>{const app=document.querySelector('.app').getBoundingClientRect(),side=$('sidebarNavigation').getBoundingClientRect(),chat=document.querySelector('.chat').getBoundingClientRect(),panel=$('workspacePanel').getBoundingClientRect();workspaceReview.geometry.push({side:side.toJSON(),chat:chat.toJSON(),panel:panel.toJSON()});return side.right<=chat.left+1&&chat.right<=panel.left+1&&Math.abs(panel.right-app.right)<1&&Math.abs(side.width+chat.width+panel.width-app.width)<2;};`);
  for (const target of [744, 799, 823, 824, 825, 900, 919, 920, 921, 1000, 1199, 1200, 1000, 825, 743]) {
    await act('workspaceReviewDrag('+target+'-relayWorkspacePanel.getState().width);'); await settle();
    await check('ColumnsNeverOverlapAtWidth'+target+'Step'+Object.keys(checks).length, 'checkWorkspaceGeometry()&&localStorage.getItem("relay.sidebar.layout.v2")===workspaceReview.leftBeforeFull.saved');
  }
  await evaluate(`(async()=>{
    const h=$('workspaceResizeHandle'),r=h.getBoundingClientRect(),x=r.x+4,start=relayWorkspacePanel.getState().width;
    const move=w=>window.dispatchEvent(new PointerEvent('pointermove',{pointerId:92,clientX:x+start-w,bubbles:true}));
    const collect=()=>new Promise(resolve=>{const values=[],began=performance.now();const tick=now=>{const p=$('workspacePanel').getBoundingClientRect();values.push({ms:now-began,width:p.width,left:p.left,aligned:checkWorkspaceGeometry()});if(now-began>=360)resolve(values);else requestAnimationFrame(tick);};requestAnimationFrame(tick);});
    h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:92,clientX:x,button:0,bubbles:true,isPrimary:true}));
    move(innerWidth-281);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    workspaceReview.beforeSnap={width:relayWorkspacePanel.getState().width,opacity:document.querySelector('.app').style.getPropertyValue('--workspace-chat-opacity')};
    move(innerWidth-280);workspaceReview.snapFrames=await collect();
    workspaceReview.snapped=relayWorkspacePanel.getState().maximized&&Math.abs($('workspacePanel').getBoundingClientRect().left-document.querySelector('.app').getBoundingClientRect().left)<1;
    workspaceReview.captureRetained=document.querySelector('.app').classList.contains('is-workspace-resizing');
    for(const remaining of [281,279,319,281]){move(innerWidth-remaining);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(!relayWorkspacePanel.getState().maximized)workspaceReview.snapFlickered=true;}
    move(innerWidth-320);workspaceReview.restoreFrames=await collect();
    workspaceReview.sameGestureRestored=!relayWorkspacePanel.getState().maximized&&!document.querySelector('.chat').inert&&Math.abs(relayWorkspacePanel.getState().width-(innerWidth-320))<1;
    window.dispatchEvent(new PointerEvent('pointerup',{pointerId:92,clientX:x+start-(innerWidth-320),bubbles:true}));
  })()`);
  await check('ThresholdAutomaticallyFillsTheEntireContentArea', 'workspaceReview.beforeSnap.width===innerWidth-281&&workspaceReview.beforeSnap.opacity==="1"&&workspaceReview.snapped&&workspaceReview.captureRetained');
  await check('SnappingAndRestoringAnimateThroughRealIntermediateWidths', 'workspaceReview.snapFrames.some(f=>f.width>innerWidth-280&&f.width<innerWidth-2)&&workspaceReview.restoreFrames.some(f=>f.width>innerWidth-320+2&&f.width<innerWidth-2)&&[...workspaceReview.snapFrames,...workspaceReview.restoreFrames].every(f=>f.aligned)');
  await check('ThresholdHysteresisKeepsTheSameGestureStableAndReversible', '!workspaceReview.snapFlickered&&workspaceReview.sameGestureRestored&&!document.querySelector(".app").classList.contains("is-workspace-resizing")&&localStorage.getItem("relay.sidebar.layout.v2")===workspaceReview.leftBeforeFull.saved');
  await act('workspaceReviewDrag(innerWidth-relayWorkspacePanel.getState().width);'); await settle();
  await check('DraggingReachesFullContentWidthWithoutCoveringCaptionControls', '(()=>{const panel=$("workspacePanel").getBoundingClientRect(),app=document.querySelector(".app").getBoundingClientRect();return relayWorkspacePanel.getState().maximized&&Math.abs(panel.width-app.width)<1&&Math.abs(panel.left-app.left)<1&&panel.top>=36&&$("workspaceMaximize").getAttribute("aria-pressed")==="true"&&!$("workspaceResizeHandle").hidden&&document.querySelector(".chat").inert&&$("sidebarNavigation").inert})()');
  await check('FullWidthKeepsAnAccessibleResizeStripAtTheLeftEdge', '(()=>{const h=$("workspaceResizeHandle"),r=h.getBoundingClientRect();return r.left>=0&&r.width>=8&&document.elementFromPoint(r.left+3,r.top+20)===h})()');
  await capture('full-width-resize');
  await act('workspaceReviewDrag(-340);'); await settle();
  await check('FullWidthCanBeDraggedBackWithoutUsingTheMaximizeButton', 'relayWorkspacePanel.getState().width===innerWidth-340&&!relayWorkspacePanel.getState().maximized&&$("workspaceMaximize").getAttribute("aria-pressed")==="false"');
  await act('workspaceReviewDrag(743-relayWorkspacePanel.getState().width);$("workspaceMaximize").click();'); await settle();
  await act('$("workspaceMaximize").click();'); await settle();
  await check('MaximizeButtonRestoresTheLastManuallySelectedWidth', 'relayWorkspacePanel.getState().width===743&&!relayWorkspacePanel.getState().maximized&&Math.abs($("workspacePanel").getBoundingClientRect().width-743)<1');
  await act('workspaceReviewDrag(373-relayWorkspacePanel.getState().width);'); await settle();
  await check('ShrinkingBackRestoresSidebarAndConversationWithoutChangingSidebarPreferences', '!document.querySelector(".chat").inert&&!$("sidebarNavigation").inert&&relaySidebarLayout.getState().width===workspaceReview.leftBeforeFull.width&&relaySidebarLayout.getState().preferredWidth===workspaceReview.leftBeforeFull.preferredWidth&&localStorage.getItem("relay.sidebar.layout.v2")===workspaceReview.leftBeforeFull.saved');
  await act('workspaceReview.tabsBeforeCollapse=relayWorkspacePanel.getState().tabs.map(t=>t.id).join();workspaceReviewDrag(-1000);'); await settle();
  await check('DraggingPastMinimumClosesWithoutDisposingTabs', '!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().width===0&&$("workspacePanel").inert&&$("workspaceResizeHandle").hidden&&relayWorkspacePanel.getState().tabs.map(t=>t.id).join()===workspaceReview.tabsBeforeCollapse');
  await act('$("btnWorkspacePanel").click();'); await settle();
  await check('ReopeningAfterDragCollapseRestoresTheUsablePaneAndTabs', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().width>=300&&relayWorkspacePanel.getState().tabs.map(t=>t.id).join()===workspaceReview.tabsBeforeCollapse');
  await act('$("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}));'); await settle();
  await act("workspaceReviewDrag(59,'pointercancel');"); await settle();
  await check('CancelledDragRestoresWidth', 'relayWorkspacePanel.getState().width===300&&!document.querySelector(".is-workspace-resizing")');
  win.setSize(900, 600); await settle();
  await check('MinimumWindowBothSidebarsFit', 'document.documentElement.scrollWidth<=innerWidth&&$("workspacePanel").getBoundingClientRect().width>=300&&document.querySelector(".chat").getBoundingClientRect().width>=360');
  await check('HeaderDividersStayAlignedAtMinimumWindow', 'Math.abs(document.querySelector(".workspace-panel-header").getBoundingClientRect().bottom-document.querySelector(".chat-header").getBoundingClientRect().bottom)<1');
  await act("$('sidebarResizeHandle').focus();"); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'END' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'END' }); await settle();
  await check('LeftResizerRespectsRightPanelAndMainMinimum', 'Math.round(relaySidebarLayout.getState().width+relayWorkspacePanel.getState().width+document.querySelector(".chat").getBoundingClientRect().width)<=innerWidth&&document.querySelector(".chat").getBoundingClientRect().width>=360');
  await act("document.documentElement.dataset.theme='dark';relayWorkspacePanel.open('files');"); await capture('minimum-dark-files');
  await check('MinimumFilesPanelDoesNotOverflow', '$("workspaceFiles").scrollWidth<=$("workspaceFiles").clientWidth&&$("workspacePanel").scrollWidth<=$("workspacePanel").clientWidth');
  await act("$('btnWorkspacePanel').click();"); await settle();
  await check('CollapseRestoresConversationSpaceAndMakesPanelInert', '!relayWorkspacePanel.getState().open&&$("workspacePanel").inert&&document.querySelector(".chat").getBoundingClientRect().width>=480');
  await act("$('btnWorkspacePanel').click();"); await settle();
  await check('PanelToggleRestoresExistingFileTab', 'relayWorkspacePanel.isActive("files")&&!$("workspaceFiles").hidden&&!document.querySelector("#taskCenterMount,#workspaceTasks")');
  await act("startNewConv();workspaceReview.holdSave=true;$('input').value='延迟保存会话';workspaceReview.pendingSend=send();");
  await waitFor('!!workspaceReview.releaseSave');
  await act("workspaceReview.savingId=currentConv.id;workspaceReview.doubleSend=send({explicit:true,prompt:'不得重复投递'});");
  await check('PendingSaveBlocksDuplicateSend', 'currentConv.turns.length===1');
  await act("startNewConv();workspaceReview.newDraftId=relayConversationWorkspace().conversationId;workspaceReview.releaseSave();");
  await evaluate('workspaceReview.pendingSend'); await settle();
  await check('LateSaveKeepsNewDraftAndDispatchesOriginalConversation', 'currentConv===null&&relayConversationWorkspace().conversationId===workspaceReview.newDraftId&&runs.has(workspaceReview.savingId)&&!isRunning&&$("chatTitle").textContent==="新对话"');
  await act("workspaceReview.failStart=true;relayWorkspacePanel.open('terminal',{startTerminal:true});");
  await waitFor('$("workspaceTerminalError").textContent.includes("合成终端启动失败")');
  await act('startNewConv();workspaceReview.failStart=false;relayWorkspacePanel.newTerminal();'); await settle();
  await check('TerminalFailureBelongsOnlyToItsOwnTab', '$("workspaceTerminalError").textContent===""');
  await act('workspaceReview.savesBeforeProject=uiFixture.calls.filter(call=>call==="history.save").length;');
  await evaluate("selectConversationProject('93000000-0000-4000-8000-000000000001')");
  await act("workspaceReview.projectDraft=relayConversationWorkspace();relayWorkspacePanel.open('terminal',{startTerminal:true});");
  await waitFor('workspaceReview.starts.some(item=>item.context.conversationId===workspaceReview.projectDraft.conversationId)'); await settle();
  await check('ProjectTerminalStartsWithoutHistoryInSelectedFolder', 'currentConv===null&&workspaceReview.projectDraft.workingDir==="C:/Synthetic/TerminalProject"&&uiFixture.calls.filter(call=>call==="history.save").length===workspaceReview.savesBeforeProject&&$("workspaceTerminalStatus").textContent==="C:/Synthetic/TerminalProject"');
  await act('workspaceReview.projectTerminalId=workspaceReview.activeTerminal();workspaceReview.startsBeforeReturn=workspaceReview.starts.length;');
  await evaluate('selectConversationProject(null)'); await settle();
  await check('SwitchingProjectChangesDirectoryWithoutCreatingHistory', 'relayConversationWorkspace().workingDir===null&&!currentConv&&uiFixture.calls.filter(call=>call==="history.save").length===workspaceReview.savesBeforeProject');
  await evaluate("selectConversationProject('93000000-0000-4000-8000-000000000001')");
  await act("relayWorkspacePanel.open('terminal',{startTerminal:true});"); await settle();
  await check('ReturningToUnsentProjectRestoresItsExistingTerminal', 'currentConv===null&&relayConversationWorkspace().conversationId===workspaceReview.projectDraft.conversationId&&workspaceReview.activeTerminal()===workspaceReview.projectTerminalId&&workspaceReview.starts.length===workspaceReview.startsBeforeReturn&&uiFixture.calls.filter(call=>call==="history.save").length===workspaceReview.savesBeforeProject');
  await act("startNewConv();relayWorkspacePanel.open('terminal',{startTerminal:true});"); await settle();
  await check('NewConversationInSameProjectReusesDirectoryTerminal', 'currentConv===null&&relayConversationWorkspace().conversationId!==workspaceReview.projectDraft.conversationId&&workspaceReview.activeTerminal()===workspaceReview.projectTerminalId&&workspaceReview.starts.length===workspaceReview.startsBeforeReturn&&uiFixture.calls.filter(call=>call==="history.save").length===workspaceReview.savesBeforeProject');
  await evaluate('selectConversationProject(null)'); await settle();
  await act('workspaceReview.selectTerminal(workspaceReview.projectTerminalId);');
  await check('ExistingTerminalsRemainReachableWithoutHistoryPlaceholders', 'currentConv===null&&currentProjectId===null&&$("workspaceTerminalStatus").textContent==="C:/Synthetic/TerminalProject"&&workspaceReview.activeTerminal()===workspaceReview.projectTerminalId&&workspaceReview.starts.length===workspaceReview.startsBeforeReturn');
  await act("relayWorkspacePanel.open('terminal');"); await settle();
  await check('AutomaticWorkspaceEntryDoesNotReuseManuallySelectedForeignDirectory', 'workspaceReview.activeTerminal()!==workspaceReview.projectTerminalId&&$("workspaceTerminalStatus").textContent!=="C:/Synthetic/TerminalProject"&&workspaceReview.starts.length===workspaceReview.startsBeforeReturn+1');
  await act("workspaceReview.holdResolve=true;relayWorkspacePanel.open('terminal');"); await waitFor('!!workspaceReview.releaseResolve');
  await act('workspaceReview.selectTerminal(workspaceReview.projectTerminalId);workspaceReview.releaseResolve();'); await settle();
  await check('DelayedWorkspaceResolutionPreservesNewManualTerminalSelection', 'workspaceReview.activeTerminal()===workspaceReview.projectTerminalId&&$("workspaceTerminalStatus").textContent==="C:/Synthetic/TerminalProject"');


  await act(`workspaceReview.tabsBeforePending=relayWorkspacePanel.getState().tabs.length;workspaceReview.holdStart=true;workspaceReview.closedPendingTab=relayWorkspacePanel.newTerminal();`);
  await waitFor('!!workspaceReview.releaseStart');
  await act(`workspaceReview.pendingSessionId=workspaceReview.starts.at(-1).id;$("workspaceTabs").querySelector('.workspace-tab-item.is-active .workspace-tab-close').click();`);
  await waitFor('!relayWorkspacePanel.getState().tabs.some(tab=>tab.id===workspaceReview.closedPendingTab)');
  await act('workspaceReview.releaseStart();');
  await waitFor('workspaceReview.closes.some(item=>item.id===workspaceReview.pendingSessionId)');
  await check('ClosingStartingTerminalEndsItsLateProcessWithoutRecreatingTab', `relayWorkspacePanel.getState().tabs.length===workspaceReview.tabsBeforePending&&![...document.querySelectorAll('[data-terminal-id]')].some(node=>node.dataset.terminalId===workspaceReview.pendingSessionId)`);

  // The launcher opens tools directly and remains a launcher when the user
  // hides and reopens an empty panel. No chat is created to host these tools.
  await act(`
    startNewConv();
    workspaceReview.launcherContext=relayConversationWorkspace();
    workspaceReview.launcherSaves=uiFixture.calls.filter(call=>call==='history.save').length;
    workspaceReview.launcherRuns=uiFixture.calls.filter(call=>call==='runClaude').length;
    workspaceReview.launcherStarts=workspaceReview.starts.length;
    workspaceReview.launcherCloses=workspaceReview.closes.length;
    workspaceReview.launcherSessionCount=relayWorkspacePanel.getState().tabs.filter(tab=>tab.kind==='terminal'&&tab.sessionId).length;
  `);
  await evaluate("(async()=>{for(let i=0;i<30&&relayWorkspacePanel.getState().tabs.length;i++){ $('workspaceTabs').querySelector('.workspace-tab-close').click();await new Promise(r=>setTimeout(r,10));}})()");
  await waitFor('relayWorkspacePanel.getState().tabs.length===0&&!$("workspaceNoTabs").hidden'); await settle();
  await check('ClosingAllTabsShowsDirectToolLauncher', `(()=>{const buttons=[...$('workspaceNoTabs').querySelectorAll('.workspace-launcher-action[data-workspace-create]')];return buttons.length===4&&['files','terminal','review'].every(kind=>buttons.some(button=>button.dataset.workspaceCreate===kind&&!button.disabled))&&buttons.some(button=>button.dataset.workspaceCreate==='browser')&&workspaceReview.closes.length===workspaceReview.launcherCloses+workspaceReview.launcherSessionCount;})()`);
  await check('EmptyLauncherHidesAddAgainAfterClosingLastTool', '$("workspaceAdd").hidden&&$("workspaceTabs").hidden');
  await check('EmptyLauncherHasNoActiveTool', `relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().activeId===null&&relayWorkspacePanel.getState().tab===null&&['files','browser','terminal','review'].every(kind=>!relayWorkspacePanel.isActive(kind))`);
  await check('EmptyLauncherFocusesFirstAvailableAction', `document.activeElement===$('workspaceNoTabs').querySelector('.workspace-launcher-action:not(:disabled)')`);
  await act(`workspaceReview.launcherResolves=workspaceReview.resolves.length;$('btnWorkspacePanel').click();`); await settle();
  await check('EmptyLauncherCanCollapse', `!relayWorkspacePanel.getState().open&&$('workspacePanel').inert`);
  await act(`$('btnWorkspacePanel').click();`); await settle();
  await check('ReopeningEmptySidebarPreservesLauncher', `relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===0&&!$('workspaceNoTabs').hidden&&workspaceReview.resolves.length===workspaceReview.launcherResolves`);
  await act(`$('workspaceNoTabs').querySelector('[data-workspace-create="files"]').click();`);
  await waitFor('relayWorkspacePanel.isActive("files")&&document.querySelectorAll(".workspace-file-row").length===4');
  await check('LauncherFilesOpensCurrentWorkspaceDirectly', `$('workspaceNoTabs').hidden&&!$('workspaceFiles').hidden&&relayWorkspacePanel.getState().tabs.length===1&&workspaceReview.resolves.at(-1).conversationId===workspaceReview.launcherContext.conversationId`);
  await act(`$('workspaceTabs').querySelector('.workspace-tab-close').click();$('workspaceNoTabs').querySelector('[data-workspace-create="files"]').click();`); await settle();
  await check('LauncherFilesRestoresNonModalFileList', `relayWorkspacePanel.isActive('files')&&$('workspaceNoTabs').hidden&&!$('workspaceFiles').hidden&&!$('workspaceFiles').hasAttribute('aria-modal')`);
  await act(`$('workspaceTabs').querySelector('.workspace-tab-close').click();$('workspaceNoTabs').querySelector('[data-workspace-create="terminal"]').click();`);
  await waitFor('workspaceReview.starts.length===workspaceReview.launcherStarts+1&&!!document.querySelector(".workspace-terminal-surface:not([hidden]) .xterm")'); await settle();
  await check('LauncherTerminalStartsInDraftDirectoryDirectly', `relayWorkspacePanel.isActive('terminal')&&$('workspaceNoTabs').hidden&&workspaceReview.starts.at(-1).context.conversationId===workspaceReview.launcherContext.conversationId&&workspaceReview.activeTerminal()===workspaceReview.starts.at(-1).id`);
  await check('LauncherToolsCreateNoHistoryOrModelRun', `currentConv===null&&relayConversationWorkspace().conversationId===workspaceReview.launcherContext.conversationId&&uiFixture.calls.filter(call=>call==='history.save').length===workspaceReview.launcherSaves&&uiFixture.calls.filter(call=>call==='runClaude').length===workspaceReview.launcherRuns`);

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await act('workspaceReviewDrag(innerWidth-280-relayWorkspacePanel.getState().width);');
  await check('ReducedMotionSnapsDirectlyWithoutLeavingAnAnimationClass', 'relayWorkspacePanel.getState().maximized&&!document.querySelector(".app").classList.contains("is-workspace-snapping")&&getComputedStyle(document.querySelector(".app")).transitionDuration==="0s"');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  await check('NoRendererErrorsOrNodeExposure', 'uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { errors.push(String(error.stack || error)); console.error(error); if (win && !win.isDestroyed()) { try { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); await capture('failure'); } catch (_) {} } save(); clearTimeout(deadline); app.exit(1); });
