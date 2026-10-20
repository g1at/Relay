'use strict';

// Production renderer in a fresh Electron profile. Browser events, workspace
// files and shell transport are memory fixtures: no user history or processes.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT)
  : path.join(root, '.codex-tmp/panel-isolation-2026-10-11/session-ui');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const panelSource = process.env.RELAY_SMOKE_WORKSPACE_PANEL_SOURCE ? path.resolve(process.env.RELAY_SMOKE_WORKSPACE_PANEL_SOURCE)
  : path.join(root, 'renderer/workspace-panel.js');
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');
let win, step = 'boot';
const report = { ok: false, profileIsolated: true, startedAt: new Date().toISOString(), electron: process.versions.electron,
  panelSource, panelSourceSha256: createHash('sha256').update(fs.readFileSync(panelSource)).digest('hex'), checks: {}, errors: [], step };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...report, step }, null, 2));
const deadline = setTimeout(() => { report.errors.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = source => win.webContents.executeJavaScript(source);
const act = source => evaluate(`(() => { ${source}\n })()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  await pause(360);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function until(source) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;const tick=()=>{if(${source})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(source)}));setTimeout(tick,20);};tick();})`);
}
async function check(name, source) {
  step = name; report.checks[name] = !!await evaluate(source); save();
  console.log(name + ': ' + report.checks[name]);
  if (!report.checks[name]) throw Error(name);
}
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function switchTo(id, patch = {}) {
  await act(`panelFixture.setContext(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
  await settle();
}
const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(() => {
    localStorage.clear(); const base=window.api;
    const state=window.panelFixture={context:null,browserCalls:[],resolves:[],lists:[],starts:[],closes:[],browserTabs:new Map(),browserHandler:null,terminalHandler:null,holdCreate:false,releaseCreate:null,holdList:false,releaseList:null};
    const rootFor=context=>'C:/Synthetic/PanelIsolation/'+context.conversationId;
    state.setContext=(id,patch={})=>{state.context=id?{conversationId:id,title:'合成会话 '+id,workingDir:rootFor({conversationId:id}),...patch}:null;window.dispatchEvent(new Event('relay:conversation-changed'));};
    state.browserEvent=event=>state.browserHandler?.(event);
    state.automationOpen=(owner,id,reveal=false)=>{
      const tab={id,ownerConversationId:owner,url:'https://fixture.invalid/'+id,title:'合成网页 '+id,loading:false,zoom:1,canGoBack:false,canGoForward:false};
      state.browserTabs.set(id,tab);
      state.browserEvent({type:'automation-state',id,conversationId:owner,state:'controlled',revision:1});
      state.browserEvent({type:'automation-open',conversationId:owner,revision:1,tab,reveal});
    };
    const browser={onEvent:fn=>{state.browserHandler=fn;return()=>{};},invoke:async request=>{
      state.browserCalls.push({...request});
      if(request.action==='settings.get')return{ok:true,settings:{}};
      if(request.action==='automation')return{ok:true,id:request.id,conversationId:state.browserTabs.get(request.id)?.ownerConversationId,state:'controlled',revision:1};
      if(request.action==='create'){
        const tab={id:'manual-'+(state.browserTabs.size+1),ownerConversationId:request.conversationId,url:request.url,title:'延迟创建的网页',loading:false,zoom:1};
        if(state.holdCreate){state.holdCreate=false;await new Promise(resolve=>state.releaseCreate=resolve);}
        state.browserTabs.set(tab.id,tab);return{ok:true,id:tab.id,tab};
      }
      return{ok:true};
    }};
    const workspace={
      resolve:async context=>{state.resolves.push(context);return{ok:true,root:rootFor(context),conversationId:context.conversationId,managed:false};},
      list:async request=>{state.lists.push(request);if(state.holdList){state.holdList=false;await new Promise(resolve=>state.releaseList=resolve);}return{ok:true,entries:[{name:'notes.md',path:'notes.md',type:'file',size:64}]};},
      read:async({path})=>({ok:true,path,content:'# 合成文件'}),
      open:async()=>({ok:true}),
      terminalStart:async({context})=>{const id='synthetic-terminal-'+(state.starts.length+1);state.starts.push({id,context});return{ok:true,id,root:rootFor(context)};},
      terminalInput:async()=>({ok:true}),terminalResize:async()=>({ok:true}),
      terminalClose:async value=>{state.closes.push(value);return{ok:true};},
      onTerminalEvent:fn=>{state.terminalHandler=fn;return()=>{};},onRuntimeChanged:()=>()=>{}
    };
    window.api=new Proxy(base,{get(target,key){return key==='browser'?browser:key==='workspace'?workspace:target[key];}});
  })();`;
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>')
    .replace('<script src="workspace-panel.js"></script>', '<script src="' + pathToFileURL(panelSource).href + '"></script>'));
  win = new BrowserWindow({ width: 1260, height: 850, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act('window.relayConversationWorkspace=()=>panelFixture.context;');
  await switchTo('session-a');
  await check('unopenedConversationStartsCollapsed', '!relayWorkspacePanel.getState().open');
  await act("panelFixture.automationOpen('session-a','browser-a');");
  await until('relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tab==="browser"');
  await act('panelFixture.aBrowserId=relayWorkspacePanel.getState().activeId;panelFixture.aWidth=relayWorkspacePanel.getState().preferredWidth;');
  await check('activeConversationBrowserAutomaticallyOpensItsOwnPanel', 'relayWorkspacePanel.getState().tabs.find(tab=>tab.id===relayWorkspacePanel.getState().activeId)?.browserId==="browser-a"');
  await switchTo('session-b');
  await check('switchToUnopenedConversationCollapsesSidebar', '!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().width===0&&document.getElementById("workspacePanel").inert');
  await check('otherConversationHasNoBrowserFromA', '!relayWorkspacePanel.getState().tabs.some(tab=>tab.browserId==="browser-a")');
  await capture('b-collapsed-after-a-browser');
  await act('relayWorkspacePanel.open("files");');
  await until('relayWorkspacePanel.getState().tab==="files"&&document.querySelector(".workspace-file-row")');
  await act('panelFixture.bFileId=relayWorkspacePanel.getState().activeId;document.getElementById("workspaceMaximize").click();');
  await settle();
  await check('bCanIndependentlyOpenAndMaximizeFiles', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().tab==="files"');
  await switchTo('session-a');
  await check('aRestoresBrowserOpenAndSplitStateAfterBFileMaximize', 'relayWorkspacePanel.getState().open&&!relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId===panelFixture.aBrowserId&&relayWorkspacePanel.getState().preferredWidth===panelFixture.aWidth');
  await switchTo('session-b');
  await check('bRestoresItsFileSelectionAndMaximizedState', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId===panelFixture.bFileId');
  await switchTo('session-a');
  await act('document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));panelFixture.sharedSplitWidth=relayWorkspacePanel.getState().preferredWidth;');
  await check('keyboardResizeUpdatesSharedSplitWidth', 'panelFixture.sharedSplitWidth===panelFixture.aWidth+8');
  await switchTo('session-b');
  await check('sharedSplitResizeKeepsBMaximized', 'relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId===panelFixture.bFileId');
  await act('document.getElementById("workspaceMaximize").click();');
  await settle();
  await check('restoringBUsesTheSharedSplitWidthChosenInA', '!relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().width===panelFixture.sharedSplitWidth');
  await act('document.getElementById("workspaceMaximize").click();');
  await act('relayWorkspacePanel.newTerminal();');
  await until('relayWorkspacePanel.getState().tab==="terminal"&&relayWorkspacePanel.getState().tabs.find(tab=>tab.id===relayWorkspacePanel.getState().activeId)?.sessionId');
  await act('panelFixture.bTerminalId=relayWorkspacePanel.getState().activeId;panelFixture.bTerminalSession=relayWorkspacePanel.getState().tabs.find(tab=>tab.id===panelFixture.bTerminalId).sessionId;');
  await switchTo('session-a');
  await check('aBrowserSelectionSurvivesBTerminal', 'relayWorkspacePanel.getState().activeId===panelFixture.aBrowserId&&relayWorkspacePanel.getState().tab==="browser"&&!relayWorkspacePanel.getState().maximized');
  await act('relayWorkspacePanel.close();');
  await switchTo('session-b');
  await check('aDismissalDoesNotCloseBTerminalPanel', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId===panelFixture.bTerminalId');
  await check('switchingDoesNotRestartOrStopTheExistingShell', 'panelFixture.starts.length===1&&panelFixture.closes.length===0&&relayWorkspacePanel.getState().tabs.find(tab=>tab.id===panelFixture.bTerminalId)?.sessionId===panelFixture.bTerminalSession');
  await switchTo('session-a');
  await check('aManualDismissalSurvivesConversationRoundTrip', '!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().activeId===panelFixture.aBrowserId');
  await act("panelFixture.automationOpen('session-a','browser-a-background');");
  await settle();
  await check('newBackgroundPageRespectsOnlyADismissal', '!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.some(tab=>tab.browserId==="browser-a-background")');
  await switchTo('session-b');
  await check('aBackgroundPageDoesNotReplaceBTerminalSelection', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().activeId===panelFixture.bTerminalId&&relayWorkspacePanel.getState().maximized');
  await act('panelFixture.sameIdBefore=relayWorkspacePanel.getState();');
  await switchTo('session-b', { title: '同一会话的新标题', isDraft: false });
  await check('sameIdentityMetadataUpdatePreservesPanelState', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().activeId===panelFixture.sameIdBefore.activeId&&relayWorkspacePanel.getState().maximized===panelFixture.sameIdBefore.maximized');
  await switchTo(null);
  await check('nullConversationDoesNotInheritPreviousOpenOrFullState', '!relayWorkspacePanel.getState().open&&!relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId!==panelFixture.bTerminalId');
  await switchTo('session-b');
  await check('bRemainsRestorableAfterNullContext', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().maximized&&relayWorkspacePanel.getState().activeId===panelFixture.bTerminalId');

  // Invalidate an in-flight file request while loading history, then simulate
  // failure returning to the same conversation. Its file refresh must restart.
  await switchTo('session-files');
  await act('panelFixture.holdList=true;relayWorkspacePanel.open("files");');
  await until('!!panelFixture.releaseList');
  await act('panelFixture.listCountBeforeLoading=panelFixture.lists.length;window.dispatchEvent(new CustomEvent("relay:conversation-changed",{detail:{conversationId:null,loading:true}}));panelFixture.releaseList();');
  await settle();
  await check('stalePendingFileReplyCannotRenderDuringHistoryLoad', 'document.getElementById("workspacePanel").inert&&panelFixture.lists.length===panelFixture.listCountBeforeLoading');
  await act('window.dispatchEvent(new CustomEvent("relay:conversation-changed",{detail:{conversationId:"session-files",loading:false}}));');
  await until('panelFixture.lists.length>panelFixture.listCountBeforeLoading&&!!document.querySelector(".workspace-file-row[data-path=\\"notes.md\\"]")');
  await check('historyLoadFailureRestartsInterruptedFilesRefresh', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tab==="files"&&!document.getElementById("workspacePanel").inert');
  await switchTo('session-toggle');
  await act('panelFixture.tabsBeforeGenericOpen=relayWorkspacePanel.getState().tabs.map(tab=>tab.id);document.getElementById("btnWorkspacePanel").click();');
  await settle();
  await check('genericToggleReusesExistingToolTabsWithoutDuplicates', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===panelFixture.tabsBeforeGenericOpen.length&&new Set(relayWorkspacePanel.getState().tabs.map(tab=>tab.id)).size===relayWorkspacePanel.getState().tabs.length');

  // Renderer replies from old navigation remain owned by their original chat.
  await switchTo('session-a');
  await act("panelFixture.holdCreate=true;panelFixture.pendingBrowser=relayWorkspacePanel.openUrl('https://fixture.invalid/delayed');");
  await until('!!panelFixture.releaseCreate');
  await switchTo('session-c');
  await check('rapidNavigationStartsNewConversationCollapsed', '!relayWorkspacePanel.getState().open');
  await act('panelFixture.releaseCreate();');
  await evaluate('panelFixture.pendingBrowser');
  await act("panelFixture.automationOpen('session-a','browser-a-late',true);panelFixture.browserEvent({type:'state',tab:{id:'browser-a',ownerConversationId:'session-a',title:'旧会话晚到状态'}});");
  await settle();
  await check('lateBrowserReplyAndExplicitBackgroundRevealCannotOpenC', '!relayWorkspacePanel.getState().open&&!relayWorkspacePanel.getState().tabs.some(tab=>tab.ownerConversationId==="session-a")');

  // A pending history load is a navigation barrier, even if the old context ID
  // remains available for displaying a loading view. A failed load restores it.
  await switchTo('session-a');
  await act('relayWorkspacePanel.open("browser");panelFixture.beforeLoading=relayWorkspacePanel.getState();');
  await act('window.dispatchEvent(new CustomEvent("relay:conversation-changed",{detail:{conversationId:null,loading:true}}));');
  await act("panelFixture.automationOpen('session-a','browser-during-history-load',true);");
  await settle();
  await check('pendingHistoryLoadHidesPanelAndRejectsAutoPresentation', 'document.getElementById("workspacePanel").inert&&document.getElementById("btnWorkspacePanel").getAttribute("aria-expanded")==="false"');
  await check('historyLoadingDisablesSidebarToggle', 'document.getElementById("btnWorkspacePanel").disabled');
  await act('document.getElementById("btnWorkspacePanel").click();relayWorkspacePanel.close();');
  await act('window.dispatchEvent(new CustomEvent("relay:conversation-changed",{detail:{conversationId:"session-a",loading:false}}));');
  await settle();
  await check('failedHistoryLoadRestoresPreviousASelectionAndOpenState', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().activeId===panelFixture.beforeLoading.activeId&&!relayWorkspacePanel.getState().maximized');

  // Cancel the outgoing native pointer gesture before restoring the next chat.
  await act('document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));panelFixture.beforeDrag=relayWorkspacePanel.getState().preferredWidth;');
  await settle();
  const grip = await evaluate('(()=>{const r=document.getElementById("workspaceResizeHandle").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+Math.min(160,r.height/2)};})()');
  mouse('mouseMove', grip.x, grip.y); mouse('mouseDown', grip.x, grip.y); mouse('mouseMove', grip.x - 60, grip.y);
  await pause(90);
  await check('nativeDragIsActiveBeforeConversationSwitch', 'document.querySelector(".app").classList.contains("is-workspace-resizing")');
  await switchTo('session-c');
  mouse('mouseUp', grip.x - 60, grip.y); await settle();
  await check('switchCancelsCapturedDragWithoutOpeningNewConversation', '!relayWorkspacePanel.getState().open&&!document.querySelector(".app").classList.contains("is-workspace-resizing")');
  await switchTo('session-a');
  await check('outgoingConversationRestoresPreDragWidthAfterCancelledSwitch', 'relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().preferredWidth===panelFixture.beforeDrag');
  await check('switchesNeverRequestUserTakeoverOrBrowserClosure', '!panelFixture.browserCalls.some(call=>call.action==="close"||call.action==="automation"&&call.command==="pause")');
  await check('fixtureNeverCreatesHistoryOrCallsModel', '!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
  await check('noRendererRuntimeErrors', 'uiFixture.errors.length===0');
  await capture('a-restored');
  report.ok = true; save(); clearTimeout(deadline); console.log(JSON.stringify(report)); app.exit(0);
}).catch(async error => {
  report.errors.push(String(error.stack || error));
  if (win && !win.isDestroyed()) {
    try { report.renderer = await evaluate('({panel:relayWorkspacePanel?.getState(),context:panelFixture.context,errors:uiFixture.errors})'); } catch (_) {}
    try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
  }
  save(); clearTimeout(deadline); console.error(error); app.exit(1);
});
