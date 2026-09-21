'use strict';

// Isolated native renderer, synthetic settings/history, and no model or main process.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'keyboard-shortcuts-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} }); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`);
}
async function check(name, code) {
  step = name; checks[name] = !!await evaluate(code); save(); console.log(name);
  if (!checks[name]) throw Error(name);
}
async function click(selector) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});e.click()})()`);
  await settle();
}
async function input(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(100);
}
async function capture(name) {
  await settle(); await win.webContents.capturePage(); await delay(90);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
const searchRow = '[data-shortcut-action="search"]';
const editSearch = searchRow + ' [data-shortcut-edit="0"]';
const rows = '#keyboardShortcutsSection [data-shortcut-action]';
const miniRow = '[data-shortcut-global="miniWindow"]';

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const miniFixture = `(() => {
    const base = window.api;
    const state = window.miniShortcutFixture = { value: { enabled: true, shortcut: 'Alt+Space' }, reads: 0, fail: false, hold: false, release: null };
    const mini = { brand: async () => {
      state.reads++;
      if (state.fail) throw Error('Synthetic shortcut status failure');
      const value = { ...state.value };
      if (state.hold) return new Promise(resolve => { state.release = () => { state.release = null; resolve(value); }; });
      return value;
    } };
    const tools = window.shortcutTools = { starts: [], inputs: [], resolves: [], browserCreates: [], reviewReads: 0, terminalEvent: null };
    const workspace = {
      resolve: async context => { tools.resolves.push(context); return {ok:true,root:'C:/Synthetic/KeyboardProject',conversationId:context.conversationId}; },
      list: async () => ({ok:true,entries:[{name:'README.md',path:'README.md',type:'file',size:100}]}),
      review: async () => { tools.reviewReads++; return {ok:true,kind:'ready',root:'C:/Synthetic/KeyboardProject',branch:'main',files:[]}; },
      terminalStart: async value => {const id='keyboard-terminal-'+(tools.starts.length+1);tools.starts.push({...value,id});return{ok:true,id,root:'C:/Synthetic/KeyboardProject'};},
      terminalInput: async value => {tools.inputs.push(value);return{ok:true};},
      terminalResize: async () => ({ok:true}),
      terminalClose: async ({id}) => {tools.terminalEvent?.({id,type:'exit',exitCode:0});return{ok:true};},
      onTerminalEvent: fn => {tools.terminalEvent=fn;return()=>{};},
    };
    const browser = {
      invoke: async request => {
        if(request.action==='create'){const tab={id:'keyboard-browser-'+(tools.browserCreates.length+1),title:'新标签页',url:'about:blank',zoom:1,loading:false};tools.browserCreates.push(tab);return{ok:true,id:tab.id,tab};}
        if(request.action==='settings.get')return{ok:true,settings:{showFullUrl:false}};
        return{ok:true};
      },
      onEvent: fn => {tools.browserEvent=fn;return()=>{};},
    };
    window.api = new Proxy(base, { get(target, key) { return key === 'mini' ? mini : key === 'workspace' ? workspace : key === 'browser' ? browser : target[key]; } });
  })();`;
  const seed = `if(!sessionStorage.getItem('shortcut-fixture')){for(const key of ['relay.keyboard.shortcuts.v1','relay.sidebar.features.v1','relay.sidebar.layout.v2'])localStorage.removeItem(key);sessionStorage.setItem('shortcut-fixture','1')}`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + miniFixture + seed + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor('!!window.relayKeyboardShortcuts && providerRoutingLoaded && !restoringActiveRuns');
  await act("window.shortcutFixture={};window.shortcutVisible=selector=>{const e=document.querySelector(selector);return !!e&&e.getClientRects().length>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).opacity!=='0'};");
  await evaluate("openSettings('general')");

  await click('#set-theme button[data-value=dark]');
  await act("shortcutFixture.nameNode=document.getElementById('set-theme');inputEl.value='录制时保留的对话草稿';");
  await click('.set-nav-item[data-cat="shortcuts"]');
  await check('settingsContainsShortcutCategoryAndFourteenRealActions', `shortcutVisible('#keyboardShortcutsSection')&&document.querySelectorAll('${rows}').length===14&&document.querySelector('.set-nav-item[data-cat=shortcuts] svg')`);
  await check('workspaceActionsExposeFourEditableDefaults', "['newBrowser','openFiles','newTerminal','openReview'].every((id,i)=>{const row=document.querySelector('[data-shortcut-action='+id+']');return row?.querySelector('[data-shortcut-edit]')&&relayKeyboardShortcuts.get().bindings[id][0]==='Mod+Alt+'+(i+1);})&&!document.querySelector('[data-shortcut-action=openTasks]')");
  await check('shortcutPageHasNoUnrelatedSaveFooter', "!shortcutVisible('#btnSettingsSave')&&!shortcutVisible('#btnSettingsCancel')&&document.getElementById('keyboardShortcutsSection').textContent.includes('发送')");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='active'`);
  await check('globalMiniWindowShowsActualAltSpaceWithoutEditControls', `document.querySelector('${miniRow}').textContent.includes('快捷小窗')&&[...document.querySelectorAll('${miniRow} kbd')].map(e=>e.textContent).join('+')==='Alt+Space'&&!document.querySelector('${miniRow} button')&&relayKeyboardShortcuts.get().bindings.miniWindow===undefined`);
  await capture('shortcuts-light');
  await input('[data-shortcut-search]', '迷你输入框');
  await check('globalMiniWindowSearchesByNameAndAlias', `!!document.querySelector('${miniRow}')&&document.querySelectorAll('${rows}').length===0&&!document.querySelector('[data-shortcut-empty]')`);
  await input('[data-shortcut-search]', 'Alt Space');
  await check('globalMiniWindowSearchesByDefaultCombination', `!!document.querySelector('${miniRow}')&&!document.querySelector('[data-shortcut-empty]')`);
  await act("miniShortcutFixture.value={enabled:true,shortcut:'Control+Alt+Space'};window.dispatchEvent(new Event('focus'));");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='fallback'`);
  await check('occupiedDefaultShowsOnlyActualFallbackKeycaps', `[...document.querySelectorAll('${miniRow} kbd')].map(e=>e.textContent).join('+')==='Ctrl+Alt+Space'&&document.querySelector('${miniRow}').textContent.includes('备用')`);
  await input('[data-shortcut-search]', 'Ctrl Alt Space');
  await check('globalMiniWindowSearchesByFallbackCombination', `!!document.querySelector('${miniRow}')&&!document.querySelector('[data-shortcut-empty]')`);
  await act("miniShortcutFixture.value={enabled:true,shortcut:'Control+Shift+Space'};window.dispatchEvent(new Event('focus'));");
  await waitFor(`[...document.querySelectorAll('${miniRow} kbd')].map(e=>e.textContent).join('+')==='Ctrl+Shift+Space'`);
  await click('[data-shortcut-search-record]');
  await act("window.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));");
  await check('globalFallbackWorksWithRecordedCombinationSearch', `document.querySelector('[data-shortcut-search]').value==='Ctrl+Shift+Space'&&[...document.querySelectorAll('${miniRow} kbd')].map(e=>e.textContent).join('+')==='Ctrl+Shift+Space'&&localStorage.getItem('relay.keyboard.shortcuts.v1')===null`);
  await input('[data-shortcut-search]', '');
  await act("miniShortcutFixture.value={enabled:false,shortcut:null};window.dispatchEvent(new Event('focus'));");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='disabled'`);
  await check('disabledMiniWindowExplainsEnableLocationWithoutClaimingRegisteredKey', `document.querySelector('${miniRow}').textContent.includes('设置 → 常规')&&document.querySelector('${miniRow}').textContent.includes('Alt+Space')&&!document.querySelector('${miniRow} kbd')`);
  await act("miniShortcutFixture.value={enabled:true,shortcut:null};window.dispatchEvent(new Event('focus'));");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='unavailable'`);
  await check('unregisteredMiniWindowShowsTrayFallbackWithoutActiveKeycaps', `document.querySelector('${miniRow}').textContent.includes('托盘')&&document.querySelector('${miniRow}').textContent.includes('未注册')&&!document.querySelector('${miniRow} kbd')`);
  await act("miniShortcutFixture.fail=true;window.dispatchEvent(new Event('focus'));");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='error'`);
  await check('statusReadFailureLeavesEditableLocalShortcutsUsable', `!!document.querySelector('${editSearch}')&&document.querySelector('${miniRow}').textContent.includes('暂时无法读取')&&uiFixture.errors.length===0`);
  await act("miniShortcutFixture.fail=false;miniShortcutFixture.value={enabled:true,shortcut:'Alt+Space'};");
  await click('.set-nav-item[data-cat="general"]');
  await click('.set-nav-item[data-cat="shortcuts"]');
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='active'`);
  await check('reenteringShortcutCategoryRefreshesGlobalStatusWithoutSavingDraft', "document.getElementById('set-theme')===shortcutFixture.nameNode&&shortcutFixture.nameNode.dataset.value==='dark'&&workspaceFixture.settingsWrites.length===0");
  await act("miniShortcutFixture.value={enabled:true,shortcut:'Control+Alt+Space'};miniShortcutFixture.hold=true;window.dispatchEvent(new Event('focus'));");
  await waitFor('!!miniShortcutFixture.release');
  await click(editSearch);
  await act('miniShortcutFixture.hold=false;miniShortcutFixture.release();');
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='fallback'`);
  await check('lateGlobalStatusResponsePreservesLocalRecordingAndFocus', "document.activeElement===document.querySelector('[data-shortcut-record-input]')&&relayKeyboardShortcuts.get().bindings.search[0]==='Mod+K'&&localStorage.getItem('relay.keyboard.shortcuts.v1')===null");
  await key('ESCAPE');
  await act("miniShortcutFixture.value={enabled:true,shortcut:'Alt+Space'};window.dispatchEvent(new Event('focus'));");
  await waitFor(`document.querySelector('${miniRow}')?.dataset.shortcutState==='active'`);
  await input('[data-shortcut-search]', '侧边栏');
  await check('searchFindsActionNames', `!!document.querySelector('[data-shortcut-action=toggleSidebar]')&&!document.querySelector('${searchRow}')`);
  await input('[data-shortcut-search]', 'Ctrl K');
  await check('searchFindsFormattedKeys', `!!document.querySelector('${searchRow}')`);
  await click('[data-shortcut-search-record]'); await key('N', ['control']);
  await check('recordedKeySearchFiltersWithoutExecutingOrSaving', "!!document.querySelector('[data-shortcut-action=newChat]')&&!document.querySelector('[data-shortcut-action=search]')&&inputEl.value==='录制时保留的对话草稿'&&localStorage.getItem('relay.keyboard.shortcuts.v1')===null");
  await input('[data-shortcut-search]', 'no-such-shortcut');
  await check('emptySearchHasClearFeedback', `document.querySelectorAll('${rows}').length===0&&document.getElementById('keyboardShortcutsSection').textContent.includes('没有')`);
  await input('[data-shortcut-search]', '');
  await click(editSearch); await capture('shortcuts-recording');
  await key('K', ['control', 'alt']);
  await check('recordingSavesNewChordWithoutExecutingIt', "relayKeyboardShortcuts.get().bindings.search.join(',')==='Mod+Alt+K'&&!shortcutVisible('.search-overlay.show')&&inputEl.value==='录制时保留的对话草稿'&&!document.querySelector('[data-shortcut-recording]')");
  await check('buttonHintsFollowReboundKey', "document.getElementById('btnSearch').title.includes('Ctrl+Alt+K')&&document.getElementById('btnSearch').getAttribute('aria-keyshortcuts')==='Control+Alt+K'");
  await click(editSearch);
  await act("shortcutFixture.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('Synthetic storage refusal')};");
  await key('G', ['control','alt']);
  await check('storageRefusalPreservesBindingAndReportsFailure', "relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'&&!!document.querySelector('[data-shortcut-recording]')&&document.getElementById('keyboardShortcutsSection').textContent.includes('保存失败')&&JSON.parse(localStorage.getItem('relay.keyboard.shortcuts.v1')).bindings.search[0]==='Mod+Alt+K'");
  await act('Storage.prototype.setItem=shortcutFixture.storageSet;'); await key('K',['control','alt']);
  await check('retryAfterStorageFailureCompletesRecording', "!document.querySelector('[data-shortcut-recording]')&&relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'");
  await click(editSearch); await key('N', ['control']);
  await check('conflictsKeepOriginalBindingAndRecordingFocus', "relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'&&!!document.querySelector('[data-shortcut-recording]')&&document.getElementById('keyboardShortcutsSection').textContent.includes('新对话')&&inputEl.value==='录制时保留的对话草稿'");
  await capture('shortcuts-conflict');
  await key('C', ['control']);
  await check('editingKeysCannotBeOverridden', "relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'&&!!document.querySelector('[data-shortcut-recording]')&&document.getElementById('keyboardShortcutsSection').textContent.includes('文本编辑')");
  await key('ESCAPE');
  await check('escapeCancelsOnlyRecording', "activeView==='settings'&&!document.querySelector('[data-shortcut-recording]')&&relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'");
  await click(editSearch); await key('TAB');
  await check('tabCancelsRecordingAndMovesFocus', "!document.querySelector('[data-shortcut-recording]')&&document.activeElement!==document.body");
  await click(editSearch); await click('.set-nav-item[data-cat="general"]');
  await key('P', ['control', 'alt']);
  await check('leavingCategoryCancelsRecordingAndRetainsSettingsDraft', "!document.querySelector('[data-shortcut-recording]')&&relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+K'&&document.getElementById('set-theme')===shortcutFixture.nameNode&&shortcutFixture.nameNode.dataset.value==='dark'&&workspaceFixture.settingsWrites.length===0");
  await act("showAppView('chat');inputEl.focus();");
  await key('K', ['control']);
  await check('oldSearchKeyNoLongerTriggers', "!shortcutVisible('.search-overlay.show')");
  await key('K', ['control', 'alt']); await waitFor("document.activeElement.classList.contains('search-input')");
  await check('newSearchKeyWorks', "shortcutVisible('.search-overlay.show')");
  await key('ESCAPE');
  await act("inputEl.value='受保护的草稿';inputEl.focus();inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,isComposing:true,cancelable:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,repeat:true,cancelable:true}));");
  await check('imeAndRepeatedKeysDoNotSendOrNavigate', "inputEl.value==='受保护的草稿'&&!uiFixture.calls.includes('runClaude')");
  await act("shortcutFixture.confirmation=customConfirm({title:'测试确认',message:'合成弹窗',confirmText:'确认'});");
  await settle(); await key('N', ['control']);
  await check('modalKeepsFocusAndBlocksGlobalNavigation', "shortcutVisible('.confirm-overlay')&&inputEl.value==='受保护的草稿'");
  await key('ESCAPE');
  await act("openImageViewer(['data:image/svg+xml,'+encodeURIComponent('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><rect width=\"40\" height=\"40\" fill=\"gray\"/></svg>')]);");
  await settle(); await key('K',['control','alt']);
  await check('imageViewerRetainsItsKeyboardContext', "shortcutVisible('.cv-viewer')&&!shortcutVisible('.search-overlay.show')");
  await key('ESCAPE');
  await act("relaySidebarExplore.setPinned('settings',false);relaySidebarExplore.setPinned('search',false);");
  await key(',', ['control']); await waitFor("activeView==='settings'");
  await check('settingsShortcutWorksWhenSidebarEntryIsHidden', "!shortcutVisible('#btnSettings')&&shortcutVisible('#settingsModal')");
  await key('K', ['control', 'shift']);
  await waitFor("shortcutVisible('#keyboardShortcutsSection')");
  await click(searchRow + ' [data-shortcut-remove="0"]');
  await check('removeLeavesExplicitUnassignedBinding', "relayKeyboardShortcuts.get().bindings.search.length===0&&document.getElementById('keyboardShortcutsSection').textContent.includes('未分配')&&!document.getElementById('btnSearch').hasAttribute('aria-keyshortcuts')");
  await act("showAppView('chat');"); await key('K', ['control', 'alt']);
  await check('removedKeyStopsWorking', "!shortcutVisible('.search-overlay.show')");
  await evaluate("openSettings('shortcuts')");
  await click(searchRow + ' [data-shortcut-add]'); await key('J', ['control', 'alt']);
  await check('unassignedActionCanBeRebound', "relayKeyboardShortcuts.get().bindings.search[0]==='Mod+Alt+J'");
  await click(searchRow + ' [data-shortcut-add]'); await key('K', ['control', 'alt']);
  await check('secondBindingCanBeAdded', "relayKeyboardShortcuts.get().bindings.search.join(',')==='Mod+Alt+J,Mod+Alt+K'");
  await click('[data-shortcut-reset]');
  await check('restoreDefaultsUpdatesRuntimeAndPage', "relayKeyboardShortcuts.get().bindings.search[0]==='Mod+K'&&relayKeyboardShortcuts.get().bindings.newChat.length===2&&document.getElementById('btnSearch').title.includes('Ctrl+K')");
  await act('shortcutFixture.expanded=relaySidebarLayout.getState().expanded;');
  await key('B',['control']); await settle();
  await check('sidebarShortcutTogglesOriginalController', 'relaySidebarLayout.getState().expanded!==shortcutFixture.expanded');
  await key('B',['control']); await settle(); await key('N',['control']);
  await check('newChatShortcutInvokesExistingConversationAction', "activeView==='chat'&&inputEl.value==='受保护的草稿'&&currentConv===null&&document.getElementById('chatTitle').textContent==='新对话'");
  await act("document.getElementById('btnExplore').focus();"); await key('L',['control']);
  await check('focusShortcutTargetsCurrentComposer', 'document.activeElement===inputEl');
  await act("inputEl.value='停止快捷键不能发送这条草稿';"); await key('X',['control','shift']);
  await check('idleStopShortcutCannotSendADraft', "!uiFixture.calls.includes('runClaude')&&inputEl.value==='停止快捷键不能发送这条草稿'");

  await evaluate("openSettings('shortcuts')");
  await act("shortcutFixture.workspaceDraft=document.getElementById('set-theme');relayWorkspacePanel.close();");
  await key('1', ['control','alt']);
  await waitFor("relayWorkspacePanel.getState().tab==='browser'&&shortcutTools.browserCreates.length===1");
  await check('browserShortcutOpensClosedPanelAndPreservesSettingsDraft', "activeView==='chat'&&relayWorkspacePanel.getState().open&&document.getElementById('set-theme')===shortcutFixture.workspaceDraft&&workspaceFixture.settingsWrites.length===0&&!currentConv");
  await act('inputEl.focus();'); await key('2', ['control','alt']);
  await waitFor("relayWorkspacePanel.getState().tab==='files'&&document.querySelector('.workspace-file-row[data-path=\"README.md\"]')");
  await check('filesShortcutLoadsTheCurrentWorkspace', "shortcutTools.resolves.length>0&&document.querySelector('.workspace-file-row').textContent.includes('README.md')");
  await act('inputEl.focus();'); await key('3', ['control','alt']);
  await waitFor("shortcutTools.starts.length===1&&document.querySelector('.workspace-terminal-surface:not([hidden]) .xterm-helper-textarea')");
  await act("document.querySelector('.workspace-terminal-surface:not([hidden]) .xterm-helper-textarea').focus();");
  await key('L',['control']);
  await waitFor('shortcutTools.inputs.some(item=>item.data===String.fromCharCode(12))');
  await act('shortcutFixture.ptyInputs=shortcutTools.inputs.length;');
  await key('3',['control','alt']);
  await waitFor("shortcutTools.starts.length===2&&relayWorkspacePanel.getState().tabs.filter(item=>item.kind==='terminal').length===2");
  await check('terminalShortcutCreatesIndependentTabWithoutSendingChordToShell', 'shortcutTools.inputs.length===shortcutFixture.ptyInputs&&new Set(shortcutTools.starts.map(item=>item.id)).size===2&&!currentConv');
  await key('4',['control','alt']);
  await waitFor("relayWorkspacePanel.getState().tab==='review'&&shortcutTools.reviewReads>0");
  await check('reviewShortcutOpensRealReviewController', "shortcutVisible('.wrev-page')&&document.querySelector('[data-review-summary]').textContent==='main · 0 个改动'&&shortcutTools.reviewReads>0");
  await act("inputEl.focus();shortcutFixture.beforeRetiredKey=JSON.stringify(relayWorkspacePanel.getState());"); await key('5',['control','alt']);
  await check('retiredTaskShortcutHasNoActionOrIndependentSurface', "JSON.stringify(relayWorkspacePanel.getState())===shortcutFixture.beforeRetiredKey&&!document.querySelector('#taskCenterDrawer,.task-center-edge-trigger')&&!relayWorkspacePanel.getState().tabs.some(item=>item.kind==='tasks')");
  await click('#workspaceAdd');
  await check('toolMenuHasAllFourLiveKeyboardHints', "document.querySelectorAll('#workspaceAddMenu [data-workspace-create]').length===4&&[...document.querySelectorAll('#workspaceAddMenu [data-workspace-create]')].every((node,i)=>node.querySelector('kbd').textContent==='Ctrl+Alt+'+(i+1)&&node.getAttribute('aria-keyshortcuts')==='Control+Alt+'+(i+1))");
  await key('ESCAPE');
  await evaluate("openSettings('shortcuts')");
  await click('[data-shortcut-action=newTerminal] [data-shortcut-edit="0"]');
  await act('shortcutFixture.countBeforeRecord=shortcutTools.starts.length;');
  await key('T',['control','alt']);
  await check('recordingNewTerminalChordDoesNotExecuteIt', "relayKeyboardShortcuts.getLabel('newTerminal')==='Ctrl+Alt+T'&&shortcutTools.starts.length===shortcutFixture.countBeforeRecord");
  await act("showAppView('chat');inputEl.focus();"); await click('#workspaceAdd');
  await check('toolMenuHintsFollowCustomBindingWithoutReopeningSettings', "document.querySelector('#workspaceAddMenu [data-workspace-create=terminal] kbd').textContent==='Ctrl+Alt+T'&&document.querySelector('#workspaceAddMenu [data-workspace-create=terminal]').getAttribute('aria-keyshortcuts')==='Control+Alt+T'");
  await key('ESCAPE'); await act('inputEl.focus();'); await key('3',['control','alt']);
  await check('oldTerminalChordStopsWorking', 'shortcutTools.starts.length===shortcutFixture.countBeforeRecord');
  await key('T',['control','alt']);
  await waitFor('shortcutTools.starts.length===shortcutFixture.countBeforeRecord+1');
  await check('customTerminalChordCreatesANewRealTerminal', 'relayWorkspacePanel.getState().tabs.filter(item=>item.kind==="terminal").length===3');
  await act("inputEl.focus();shortcutFixture.beforeIme=shortcutTools.starts.length;inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'t',code:'KeyT',ctrlKey:true,altKey:true,isComposing:true,bubbles:true}));");
  await check('composingWorkspaceChordDoesNotStartTerminal', 'shortcutTools.starts.length===shortcutFixture.beforeIme');
  await act("shortcutFixture.workspaceConfirm=customConfirm({title:'保留当前操作',message:'合成验证',confirmText:'确认'});");
  await key('T',['control','alt']);
  await check('modalBlocksCustomWorkspaceShortcut', "shortcutVisible('.confirm-overlay')&&shortcutTools.starts.length===shortcutFixture.beforeIme");
  await key('ESCAPE');
  await evaluate("openSettings('shortcuts')"); await click('[data-shortcut-reset]');
  await check('workspaceResetRestoresDefaultsAndHintsTogether', "relayKeyboardShortcuts.getLabel('newTerminal')==='Ctrl+Alt+3'&&document.querySelector('#workspaceAddMenu [data-workspace-create=terminal] kbd').textContent==='Ctrl+Alt+3'");
  await act("relayWorkspacePanel.close();");
  await evaluate("openSettings('shortcuts')");
  await act("document.documentElement.dataset.theme='dark';"); await capture('shortcuts-dark');
  for (const [width, height] of [[1200,800],[900,600],[620,700]]) {
    win.setSize(width,height); await delay(120); await settle();
    await check(`layoutFits_${width}_${height}`, "document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById('setContent').scrollWidth<=document.getElementById('setContent').clientWidth+1&&document.querySelector('[data-shortcut-search]').getBoundingClientRect().right<=innerWidth");
    await capture('shortcuts-' + width);
  }
  win.setSize(1200,800); await settle();
  await click(editSearch); await key('K', ['control', 'alt']);
  const saved = await evaluate('JSON.stringify(relayKeyboardShortcuts.get())');
  await check('shortcutChangesNeverWriteUnrelatedSettingsOrRunModels', "workspaceFixture.settingsWrites.length===0&&workspaceFixture.providerWrites.length===0&&!uiFixture.calls.includes('runClaude')&&uiFixture.errors.length===0");
  await win.loadFile(page); await waitFor('!!window.relayKeyboardShortcuts&&providerRoutingLoaded&&!restoringActiveRuns');
  await check('freshRendererRestoresCustomBindings', 'JSON.stringify(relayKeyboardShortcuts.get())==='+JSON.stringify(saved));
  await act("const legacy=relayKeyboardShortcuts.get();legacy.bindings.openTasks=['Mod+Alt+5'];relayKeyboardShortcuts.receive(legacy);");
  await check('legacyTaskBindingIsDiscardedWithoutReassigningItsKey', "!Object.prototype.hasOwnProperty.call(relayKeyboardShortcuts.get().bindings,'openTasks')&&!Object.values(relayKeyboardShortcuts.get().bindings).flat().includes('Mod+Alt+5')&&relayKeyboardShortcuts.getLabel('openTasks')===''");
  await key('5',['control','alt']);
  await check('retiredTaskKeyCannotReopenRemovedViewAfterLoadingOldPreferences', "!relayWorkspacePanel.getState().open&&!document.querySelector('#taskCenterDrawer,.task-center-edge-trigger')");
  await key('K',['control','alt']); await waitFor("!!document.querySelector('.search-overlay.show')");
  await check('restoredBindingWorksWithoutOpeningSettingsFirst', "document.querySelector('.search-overlay').classList.contains('show')&&uiFixture.errors.length===0&&typeof require==='undefined'");
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error)); console.error(error.stack || error);
  if (win && !win.isDestroyed()) { try { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); await capture('failure'); } catch (_) {} }
  save(); clearTimeout(deadline); app.exit(1);
});
