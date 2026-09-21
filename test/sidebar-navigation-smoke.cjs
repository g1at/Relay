'use strict';

// Actual renderer in an isolated Electron window; all history/API data is
// synthetic, and no Relay main process, model or business MCP is launched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'sidebar-navigation-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const checks = {}, failures = [];
let step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Overall timeout at ' + step); save(); app.exit(1); }, 160000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settleUI() {
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect&&a.effect.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} });");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+6000; const tick=()=>{ if(${code})return resolve(); if(Date.now()>end)return reject(new Error('State timeout: '+${JSON.stringify(code)})); setTimeout(tick,25); }; tick(); })`);
}
async function check(name, code) {
  step = name; console.log(name);
  checks[name] = !!await evaluate(code); save();
  if (!checks[name]) throw new Error(name);
}
async function click(selector) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); el.click(); })()`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function rightClick(selector) {
  const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2) }; })()`);
  win.webContents.sendInputEvent({ type:'mouseMove', ...point });
  win.webContents.sendInputEvent({ type:'mouseDown', ...point, button:'right', clickCount:1 });
  win.webContents.sendInputEvent({ type:'mouseUp', ...point, button:'right', clickCount:1 });
  await waitFor("!!document.getElementById('sidebarExploreSurface')");
}
async function capture(name) {
  step = 'capture ' + name;
  await evaluate("document.getAnimations().forEach(a=>{ if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} }); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await win.webContents.capturePage(); await delay(130);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel:/^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(() => {
    if(!sessionStorage.getItem('navigation-fixture-started')) { localStorage.removeItem('relay.sidebar.width.v1'); localStorage.removeItem('relay.sidebar.layout.v2'); localStorage.removeItem('relay.sidebar.features.v1'); sessionStorage.setItem('navigation-fixture-started','1'); }
    const now = new Date(), previous = new Date(now); previous.setDate(previous.getDate()-1);
    const make = (id,title,updatedAt,pinned=false) => ({ id,title,updatedAt,pinned,model:'opus',mode:'plain',sessionId:null,turns:[{user:'请整理本地项目的工作计划。',assistant:'已整理好主要事项，下一步可以继续完善。',ts:updatedAt}] });
    const records = new Map([
      make('pinned-one','功能变更管理质量审核与后续事项整理',new Date(2026,0,1).toISOString(),true),
      make('pinned-two','信息的搜集与复用',new Date(2026,0,2).toISOString(),true),
      make('today-long','整理本地项目资料与历史会话中的决策记录并生成阶段总结',now.toISOString()),
      make('today-short','准备一周工作计划',now.toISOString()),
      make('yesterday-one','讨论侧边栏布局与常用功能入口',previous.toISOString()),
    ].map(item=>[item.id,item]));
    const clone=value=>JSON.parse(JSON.stringify(value));
    window.navigationFixture={records,writes:[],fullTitle:records.get('today-long').title};
    const original=window.api;
    const history={
      list:async()=>clone([...records.values()]), load:async id=>clone(records.get(id)||null),
      save:async conv=>{ navigationFixture.writes.push('save'); records.set(conv.id,clone(conv)); return clone(conv); },
      setPinned:async(id,pinned)=>{ navigationFixture.writes.push('pin'); records.get(id).pinned=pinned; return {ok:true}; },
      rename:async(id,title)=>{ navigationFixture.writes.push('rename'); records.get(id).title=title; return {ok:true,title}; },
    };
    window.api=new Proxy(original,{get(target,key){ return key==='history'?history:target[key]; }});
  })();`;
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
    .replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width:1140, height:860, show:false, webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false} });
  await win.loadFile(page);
  await waitFor("!!window.relaySidebarExplore && providerRoutingLoaded && !restoringActiveRuns && document.querySelectorAll('.history-item').length===5");
  await act(`window.navVisible = selector => { const el=document.querySelector(selector); if(!el)return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'&&!el.closest('[inert],[hidden]'); };
    window.navFits = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return r.width>0&&r.left>=0&&r.top>=36&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1; };
    navigationFixture.draftNode=inputEl; inputEl.value='导航调整后仍保留的未发送草稿';
    navigationFixture.originalButtons = Object.fromEntries(['btnSearch','btnSettings','btnMyWorkChat','btnSchedule','btnNewAnalysis','btnCreate'].map(id=>[id,document.getElementById(id)]));
    navigationFixture.originalRows = Object.fromEntries([...document.querySelectorAll('.history-item')].map(row=>[row.dataset.id,row]));
    navigationFixture.originalTimes=[...navigationFixture.records.values()].map(item=>item.updatedAt);
  `);
  await act(`navigationFixture.defaultFeatures = relaySidebarExplore.getPreferences();
    window.dispatchEvent(new StorageEvent('storage', {key:'relay.sidebar.features.v1', newValue:JSON.stringify({
      version:3, order:['orchestrate','library','agent','settings','search','plugins','scheduler','create'], pinned:['orchestrate','library']
    })}));`);
  await check('legacyCollaborationPinsMergeIntoAgentWithoutRestoringHiddenEntries', "relaySidebarExplore.getPreferences().version===4&&relaySidebarExplore.getPreferences().order.join(',')==='agent,library,settings,search,plugins,scheduler,create'&&[...document.getElementById('sidebarPinnedFeatures').children].map(el=>el.id).join(',')==='btnNewAnalysis,btnMyWorkChat'&&!navVisible('#btnSearch')&&!navVisible('#btnSettings')&&!document.getElementById('btnTeam')&&document.getElementById('btnRelayUpdate').parentElement.id==='sidebarExploreEntry'");
  await act("window.dispatchEvent(new StorageEvent('storage', {key:'relay.sidebar.features.v1',newValue:JSON.stringify(navigationFixture.defaultFeatures)}));");
  await check('oneToggleBesideLogoInWindowTitlebar', "document.querySelectorAll('[data-toggle-sidebar]').length===1 && document.getElementById('btnToggleSidebar').parentElement.id==='windowChrome' && document.querySelectorAll('main [data-toggle-sidebar]').length===0 && document.getElementById('windowChrome').getBoundingClientRect().top===0 && document.getElementById('windowChrome').getBoundingClientRect().height===36");
  await check('historyHasPinnedAndDateHierarchy', "document.getElementById('history-group-pinned').textContent==='置顶'&&['pinned','today','yesterday'].every(id=>document.querySelector('[data-history-group='+id+']')) && parseFloat(getComputedStyle(document.querySelector('.hi-title')).fontSize)<parseFloat(getComputedStyle(document.getElementById('btnNewChat')).fontSize)");
  await check('longTitlesUseFadeAndRetainFullAccessibleText', "(()=>{const el=document.querySelector('[data-id=today-long] .hi-title'); return el.textContent===navigationFixture.fullTitle&&el.title===navigationFixture.fullTitle&&el.getAttribute('aria-label')===navigationFixture.fullTitle&&getComputedStyle(el).textOverflow==='clip'&&getComputedStyle(el).maskImage!=='none'&&el.scrollWidth>el.clientWidth;})()");
  await settleUI();
  await check('historyShowsOneTypeIconAndKeepsPinActionsQuiet', "Array.from(document.querySelectorAll('.history-item')).every(row=>{const icons=row.querySelectorAll(':scope>.hi-icon');return icons.length===1&&getComputedStyle(icons[0]).display!=='none'&&icons[0].getBoundingClientRect().width===16})&&getComputedStyle(document.querySelector('.history-item.pinned .hi-pin')).display==='none'");
  await capture('sidebar-history');
  await act('refreshHistoryList();'); await delay(80);
  await check('historyRefreshReusesRowsAndKeepsTimestamps', "Object.entries(navigationFixture.originalRows).every(([id,row])=>document.querySelector('[data-id='+id+']')===row)&&JSON.stringify(navigationFixture.originalTimes)===JSON.stringify([...navigationFixture.records.values()].map(item=>item.updatedAt))&&navigationFixture.writes.length===0");

  await click('#btnExplore');
  await check('leftClickExploreShowsUnpinnedFeatures', "navVisible('#sidebarExploreSurface') && [...document.querySelectorAll('#sidebarExploreSurface [data-feature]')].map(el=>el.dataset.feature).join(',')==='agent,create'");
  await check('exploreIsCompactAndCustomizeHasIcon', "document.getElementById('sidebarExploreSurface').getBoundingClientRect().width<=210&&!!document.querySelector('[data-action=customize] svg')");
  await key('END');
  await check('menuKeyboardReachesCustomizer', "document.activeElement.dataset.action==='customize'");
  await key('ESC');
  await check('escapeClosesMenuAndReturnsFocus', "!document.getElementById('sidebarExploreSurface')&&document.activeElement.id==='btnExplore'");
  await rightClick('#btnExplore');
  await check('nativeRightClickAlsoOpensExplore', "document.getElementById('sidebarExploreSurface').classList.contains('se-explore')");
  await capture('explore');
  await click('#sidebarExploreSurface [data-action=customize]');
  await check('customizerHasSevenOptionalChoicesAndOnlyNewChatIsRequired', "document.querySelectorAll('[data-customize-feature] input[type=checkbox]').length===7 && !document.querySelector('[data-customize-feature=newChat]') && !document.querySelector('[data-customize-feature=btnNewChat]') && document.querySelector('[data-customize-feature=search] input').checked && document.querySelector('[data-customize-feature=settings] input').checked && document.querySelector('[data-customize-feature=library] input').checked && !document.querySelector('[data-customize-feature=create] input').checked");
  await settleUI();
  await check('customizerOverlaysTopLeftNavigation', "(()=>{const r=document.getElementById('sidebarExploreSurface').getBoundingClientRect(),n=document.querySelector('.sidebar .nav-list').getBoundingClientRect(),s=document.querySelector('.sidebar').getBoundingClientRect();return r.left>=s.left&&r.right<=s.right&&Math.abs(r.top-n.top)<2;})()");
  await click('[data-customize-feature=create] input');
  await check('selectionMovesOriginalButtonAndSavesPreference', "document.getElementById('btnCreate')===navigationFixture.originalButtons.btnCreate&&document.getElementById('btnCreate').parentElement.id==='sidebarPinnedFeatures'&&JSON.parse(localStorage.getItem('relay.sidebar.features.v1')).pinned.includes('create')");
  await act("document.querySelector('[data-customize-feature=create] [data-action=drag]').focus();"); await key('UP', ['alt']);
  await check('keyboardReordersCustomFeatures', "relaySidebarExplore.getPreferences().order.join(',')==='search,settings,plugins,library,scheduler,create,agent'");

  // Real pointer input exercises capture, insertion preview and the single
  // commit on release; this local reorder does not enter native OS drag loops.
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const points = await evaluate("(()=>{const a=document.querySelector('[data-customize-feature=create] [data-action=drag]').getBoundingClientRect(),b=document.querySelector('[data-customize-feature=search]').getBoundingClientRect();return {start:{x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2)},end:{x:Math.round(b.left+b.width/2),y:Math.round(b.top+6)}}})()");
  win.webContents.sendInputEvent({type:'mouseMove',...points.start});
  win.webContents.sendInputEvent({type:'mouseDown',...points.start,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:points.start.x,y:points.start.y-8,modifiers:['leftButtonDown']});
  await waitFor("!!document.querySelector('[data-customize-feature=create].is-dragging')");
  for(let i=1;i<=8;i++) {
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(points.start.x+(points.end.x-points.start.x)*i/8),y:Math.round(points.start.y+(points.end.y-points.start.y)*i/8),modifiers:['leftButtonDown']});
    await delay(35);
  }
  await waitFor("!!document.querySelector('[data-drop]')");
  await check('pointerDragOnlyPreviewsUntilRelease', "relaySidebarExplore.getPreferences().order[0]==='search'&&!!document.querySelector('[data-drop]')");
  win.webContents.sendInputEvent({type:'mouseUp',...points.end,button:'left',clickCount:1});
  await waitFor("relaySidebarExplore.getPreferences().order[0]==='create'");
  await check('nativePointerReordersFeaturesAndPinnedNavigation', "document.querySelector('#sidebarPinnedFeatures > :first-child').id==='btnCreate' && document.activeElement.closest('[data-customize-feature]')?.dataset.customizeFeature==='create'");
  await capture('customize');
  await click('[data-customize-feature=library] input'); await click('[data-action=done]');
  await check('hiddenFeatureStaysAvailableFromExplore', "document.getElementById('btnMyWorkChat').parentElement.id==='sidebarFeatureStore' && document.getElementById('btnMyWorkChat')===navigationFixture.originalButtons.btnMyWorkChat");
  await click('#btnExplore'); await click('#sidebarExploreSurface [data-feature=library]');
  await waitFor("activeView==='library'");
  await check('exploreActivatesExistingMainPage', "navVisible('#libraryPage')&&!document.getElementById('sidebarExploreSurface')&&document.getElementById('btnExplore').classList.contains('has-active-feature')");
  await rightClick('#btnCreate');
  await check('pinnedFeatureHasWorkingContextMenu', "document.querySelector('#sidebarExploreSurface [data-action=unpin]').dataset.feature==='create'");
  await click('#sidebarExploreSurface [data-feature=create]:not([data-action])'); await waitFor("activeView==='create'");
  await check('contextMenuOpensOriginalFeature', "navVisible('#createView')&&navFits('#createView')&&document.getElementById('btnCreate')===navigationFixture.originalButtons.btnCreate");
  await rightClick('#btnCreate'); await click('#sidebarExploreSurface [data-action=unpin]');
  await check('contextRemovalPreservesFeatureAndFocus', "document.getElementById('btnCreate').parentElement.id==='sidebarFeatureStore'&&document.activeElement.id==='btnExplore'");
  await act("showAppView('chat'); relaySidebarExplore.openCustomize();");
  await click('[data-customize-feature=scheduler] input'); await click('[data-customize-feature=plugins] input'); await click('[data-customize-feature=search] input'); await click('[data-customize-feature=settings] input'); await click('[data-action=done]');
  await check('allOptionalFeaturesCanMoveIntoExplore', "document.getElementById('sidebarPinnedFeatures').children.length===0&&navVisible('#btnNewChat')&&!navVisible('#btnSearch')&&!navVisible('#btnSettings')&&navVisible('#btnExplore')");
  await click('#btnExplore');
  await check('emptyPinnedListLosesNoFunctions', "document.querySelectorAll('#sidebarExploreSurface [data-feature]').length===7");
  await click('#sidebarExploreSurface [data-feature=search]');
  await waitFor("document.activeElement.classList.contains('search-input')");
  await check('hiddenSearchStillOpensOriginalSearchDialog', "navVisible('.search-overlay.show')&&document.activeElement.classList.contains('search-input')&&document.getElementById('btnSearch')===navigationFixture.originalButtons.btnSearch");
  await key('ESC'); await key('K',['control']);
  await waitFor("document.activeElement.classList.contains('search-input')&&navVisible('.search-overlay.show')");
  await check('hiddenSearchKeepsControlKShortcut', "navVisible('.search-overlay.show')&&document.activeElement.classList.contains('search-input')");
  await key('ESC');
  await click('#btnExplore'); await click('#sidebarExploreSurface [data-feature=settings]');
  await waitFor("activeView==='settings'");
  await check('hiddenSettingsOpensOriginalPageAndMarksExploreActive', "navVisible('#settingsModal')&&document.getElementById('btnExplore').classList.contains('has-active-feature')&&document.getElementById('btnSettings')===navigationFixture.originalButtons.btnSettings&&document.getElementById('sidebarSettingsEntry').parentElement.id==='sidebarFeatureStore'");
  await act("showAppView('chat'); relayUpdateUI.receive({state:'available',current:'2.1.0',latest:'2.2.0'});");
  await check('hiddenSettingsKeepsUpdatesBesideExplore', "navVisible('#btnRelayUpdate')&&document.getElementById('btnRelayUpdate').parentElement.id==='sidebarExploreEntry'");
  await click('#btnRelayUpdate');
  await act("relayUpdateUI.receive({state:'idle'});");
  await check('updateDisappearanceReturnsFocusToVisibleExplore', "!navVisible('#sidebarUpdatePanel')&&!navVisible('#btnRelayUpdate')&&document.activeElement.id==='btnExplore'");
  await act("navigationFixture.beforeInvalidChange=JSON.stringify(relaySidebarExplore.getPreferences()); relaySidebarExplore.setPinned('btnNewChat',false);");
  await check('newChatCannotBeHiddenByPreferences', "navVisible('#btnNewChat')&&JSON.stringify(relaySidebarExplore.getPreferences())===navigationFixture.beforeInvalidChange");
  await capture('only-new-chat-and-explore');
  await act("relaySidebarExplore.openCustomize(); for(const id of ['search','settings','plugins','library','scheduler','agent','create']) relaySidebarExplore.setPinned(id,true);");
  await click('[data-action=done]');
  await check('allPinnedFeaturesKeepCustomizerReachable', "document.getElementById('sidebarPinnedFeatures').children.length===7&&navVisible('#btnExplore')");
  await rightClick('#btnSettings'); await click('#sidebarExploreSurface [data-action=unpin]');
  await check('settingsWrapperSupportsContextRemovalWithoutLeavingAnEmptyRow', "!navVisible('#btnSettings')&&document.getElementById('sidebarSettingsEntry').parentElement.id==='sidebarFeatureStore'&&document.getElementById('btnRelayUpdate').parentElement.id==='sidebarExploreEntry'&&document.activeElement.id==='btnExplore'");
  await act("relaySidebarExplore.setPinned('settings',true);");
  await check('restoringSettingsBringsUpdateButtonBackBesideIt', "navVisible('#btnSettings')&&document.getElementById('btnRelayUpdate').parentElement.id==='sidebarSettingsEntry'");
  await click('#btnExplore'); await click('[data-action=customize]');
  await check('customizationDoesNotWriteHistoryOrDropDraft', "navigationFixture.writes.length===0&&inputEl===navigationFixture.draftNode&&inputEl.value==='导航调整后仍保留的未发送草稿'");
  await act("document.documentElement.dataset.theme='dark';"); await capture('customize-dark');
  await click('[data-action=done]');
  await click('#btnExplore');
  win.setSize(520, 640); await delay(350);
  await check('shrinkingWindowClosesExploreAndRestoresGlobalFocus', "!document.getElementById('sidebarExploreSurface')&&document.activeElement.id==='btnToggleSidebar'");
  await click('#btnToggleSidebar'); await settleUI();
  await click('#btnExplore'); await click('[data-action=customize]');
  await check('narrowCustomizerFitsBelowWindowTitlebar', "navFits('#sidebarExploreSurface')&&document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById('btnToggleSidebar').getBoundingClientRect().top<36");
  await capture('customize-narrow');
  await key('ESC');
  await click('#btnToggleSidebar'); await settleUI();
  await check('collapseClosesPopupsAndLeavesGlobalToggleReachable', "!document.getElementById('sidebarExploreSurface')&&!relaySidebarLayout.getState().expanded&&document.querySelector('.sidebar').inert&&navVisible('#btnToggleSidebar')");
  await check('noRendererErrorsOrNodeExposure', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  await act("relaySidebarExplore.setPinned('search',false); relaySidebarExplore.setPinned('settings',false);");
  const savedPreferences=await evaluate('JSON.stringify(relaySidebarExplore.getPreferences())');
  win.setSize(1140,860); await delay(300);
  await win.loadFile(page);
  await waitFor("!!window.relaySidebarExplore&&providerRoutingLoaded&&!restoringActiveRuns");
  await check('freshRendererRestoresFeatureOrderAndVisibility', 'JSON.stringify(relaySidebarExplore.getPreferences())==='+JSON.stringify(savedPreferences)+'&&document.getElementById("sidebarPinnedFeatures").children.length===5&&document.getElementById("btnSearch").getClientRects().length===0&&document.getElementById("btnSettings").getClientRects().length===0');
  await check('reloadedRendererHasNoErrors', 'uiFixture.errors.length===0');
  step='completed'; save(); console.log(JSON.stringify({checks,failures}));
  clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack||error)); console.error(error.stack||error);
  if(win&&!win.isDestroyed()){try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){} }
  save(); clearTimeout(deadline); app.exit(1);
});
