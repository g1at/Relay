'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'browser-internal-pages-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, registry, server;
const report = { results: {}, failures: [] };
const deadline = setTimeout(() => { console.error('Browser renderer smoke timed out'); app.exit(1); }, 175000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source);
const act = source => evaluate(`(()=>{${source}\n})()`);
async function until(predicate, label = 'state') {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await (typeof predicate === 'function' ? predicate() : evaluate(predicate))) return; await pause(30); }
  throw Error('Timed out: ' + label);
}
async function check(name, predicate) { const value = typeof predicate === 'string' ? await evaluate(predicate) : await predicate; report.results[name] = !!value; if (!value) throw Error(name); }
const click = id => act(`document.getElementById(${JSON.stringify(id)}).click();`);
async function settle() { await pause(400); await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function capture(name) {
  await settle();
  const state = await browserState();
  const visiblePage = state.visible && nativeViews().find(view => view.webContents.getURL() === state.tab?.url);
  // Electron captures sibling native views separately. Keep both unmodified
  // images instead of presenting a chrome-only capture as the full browser.
  for (const [surface, suffix] of [[win.webContents, visiblePage ? '-chrome' : ''], ...(visiblePage ? [[visiblePage.webContents, '-page']] : [])]) {
    let captured = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(path.join(out, name + suffix + '.png'), (await surface.capturePage()).toPNG());
        captured = true; break;
      } catch (error) {
        if (!String(error.message).includes('Current display surface not available')) throw error;
        await pause(250);
      }
    }
    // Desktop lock/display changes can temporarily remove a capture surface.
    // Record missing visual evidence; never skip functional/native-view checks.
    if (!captured) (report.captureWarnings ||= []).push(name + suffix + ': display surface unavailable');
  }
}

const browserState = () => evaluate('api.browser.invoke({action:"state"})');
const nativeViews = () => win.contentView.children.filter(view => view.webContents && view.webContents !== win.webContents);


function installManagementFixture(base) {
  const previous = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const state = window.internalFixture = {
    calls: [], listeners: new Set(),
    settings: { webLinkTarget: 'external', localLinkTarget: 'internal', searchEngine: 'bing', showFullUrl: false, downloadDirectory: 'C:/Synthetic/Downloads', askDownloadLocation: true },
    history: [{ id:'h-1', title:'项目交付预览', url:base+'/', visitedAt:'2026-09-14T01:00:00Z' }, { id:'h-2', title:'第二个页面',url:base+'/next',visitedAt:'2026-09-14T01:05:00Z'}],
    bookmarks: [{ id:'b-1',title:'项目书签',url:base+'/',createdAt:'2026-09-14T01:00:00Z'}],
    downloads:[{id:'d-1',filename:'synthetic-project-with-a-very-long-name.zip',url:base+'/project.zip',state:'completed',receivedBytes:512,totalBytes:512,path:'C:/Synthetic/Downloads/project.zip'}],
    permissions:[{origin:'https://synthetic-camera-with-a-very-long-hostname.example.invalid',permission:'camera',decision:'allow'}],
    passwords:[{recordId:'p-1',origin:'https://synthetic-login.example.invalid',username:'synthetic-user'}],contacts:[]
  };
  const browser={
    async invoke(input){
      state.calls.push(clone(input));
      if(input.action==='settings.get')return{ok:true,settings:clone(state.settings)};
      if(input.action==='settings.update'){Object.assign(state.settings,input.settings);return{ok:true,settings:clone(state.settings)}};
      if(input.action==='passwords.reveal')return{ok:true,password:'synthetic-revealed-secret'};
      const [kind,action]=input.action.split('.');
      if(action==='list'&&Array.isArray(state[kind])){const rows=state[kind].filter(row=>!input.query||JSON.stringify(row).includes(input.query));return{ok:true,total:rows.length,items:clone(rows.slice(input.offset||0,(input.offset||0)+(input.limit||50)))}};
      return nativeBrowser.invoke(input);
    },
    onEvent(listener){state.listeners.add(listener);const off=nativeBrowser.onEvent(listener);return()=>{state.listeners.delete(listener);off()}}
  };
  window.api=new Proxy(previous,{get(target,key){return key==='browser'?browser:target[key]}});
}

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${request.url === '/next' ? '第二个页面' : '项目交付预览'}</title><style>body{font:16px system-ui;background:#fafafa;color:#242424;padding:32px;line-height:1.8}article{background:white;border:1px solid #e4e4e4;border-radius:18px;padding:26px;max-width:620px}small{color:#777}a{color:#356abc}</style><small>RELAY / LOCAL PREVIEW</small><h1>项目交付预览</h1><article><h2>在这里检查交付物</h2><p>在终端启动项目后，可直接在右侧浏览器预览和调试。</p><p>查找示例 · 查找示例</p><a id="next" href="/next">打开下一个页面</a><br><a id="popup" href="/popup" target="_blank">在新标签中查看</a></article>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && !details.url.startsWith(base + '/') })));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '(' + installManagementFixture.toString() + ')(' + JSON.stringify(base) + ');</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry });
  await win.loadFile(entry); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');

  await click('btnWorkspacePanel');
  await act('document.querySelector("[data-workspace-create=browser]").click()');
  await until('relayWorkspacePanel.getState().tab==="browser"');
  async function address(url) {await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(url)};document.getElementById('workspaceBrowserNav').requestSubmit()`);}
  async function activate(id) {await act(`document.querySelector('[data-tab-id="${id}"] .workspace-tab').click()`);await settle();}
  async function menu(label, site=false) {await click(site?'workspaceBrowserSiteInfo':'workspaceBrowserMore');await act(`Array.from(document.querySelectorAll('#workspaceBrowserMenu button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);await settle();}
  async function section(name) {await act(`document.querySelector('.browser-internal-host:not([hidden]) [data-browser-internal-section="${name}"]').click()`);await settle();}
  const currentSection = name=>`document.querySelector('.browser-internal-host:not([hidden]) .relay-browser-settings')?.dataset.browserSection===${JSON.stringify(name)}`;
  await address(base+'/'); await until(async()=> (await browserState()).visible && (await browserState()).tab?.title==='项目交付预览'); await settle();
  const originalId=await evaluate('relayWorkspacePanel.getState().activeId');
  const firstView=nativeViews().find(view=>view.webContents.getURL()===base+'/');
  await check('ordinary page uses actual Chromium IPC and loopback content',!!firstView&&await firstView.webContents.executeJavaScript('document.querySelector("h1").textContent==="项目交付预览"'));
  const managerIds={};
  for(const [name,label] of [['history','历史记录'],['bookmarks','书签'],['downloads','下载'],['general','浏览器设置'],['permissions','管理网站权限']]) {
    await activate(originalId);await until(async()=> (await browserState()).visible);
    await menu(label,name==='permissions');await until(currentSection(name));await until(async()=> !(await browserState()).visible);
    managerIds[name]=await evaluate('relayWorkspacePanel.getState().activeId');
    await check(name+' menu stays in chat and opens management in a browser tab',`(!document.querySelector('.app').dataset.view||document.querySelector('.app').dataset.view==='chat')&&relayWorkspacePanel.getState().tab==='browser'&&document.getElementById('workspaceBrowserAddress').value==='relay://browser/${name==='general'?'settings':name}'`);
    await check(name+' menu hides the former native view without allocating a new web renderer',(await browserState()).tabs.length===1&&!firstView.webContents.isDestroyed());
  }
  await activate(managerIds.history);await section('downloads');
  await check('management navigation updates address and enables back',`document.getElementById('workspaceBrowserAddress').value==='relay://browser/downloads'&&!document.getElementById('workspaceBrowserBack').disabled`);
  await click('workspaceBrowserBack');await until(currentSection('history'));
  await check('back returns to history and enables forward',`document.getElementById('workspaceBrowserAddress').value==='relay://browser/history'&&!document.getElementById('workspaceBrowserForward').disabled`);
  await click('workspaceBrowserForward');await until(currentSection('downloads'));
  await check('forward returns to downloads',`document.getElementById('workspaceBrowserAddress').value==='relay://browser/downloads'`);
  const beforeRefresh=await evaluate('internalFixture.calls.filter(c=>c.action==="downloads.list").length');await click('workspaceBrowserReload');
  await until(`internalFixture.calls.filter(c=>c.action==='downloads.list').length>${beforeRefresh}`);
  await check('toolbar refresh reloads management data',true);
  await section('history');
  await act(`const q=document.querySelector('.browser-internal-host:not([hidden]) [data-browser-search]');q.value='项目交付';q.dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(`document.querySelectorAll('.browser-internal-host:not([hidden]) [data-browser-record]').length===1`);
  await activate(originalId);await until(async()=> (await browserState()).visible);await activate(managerIds.history);
  await check('switching to the loaded web tab and back preserves history search',`document.querySelector('.browser-internal-host:not([hidden]) [data-browser-search]').value==='项目交付'&&document.querySelectorAll('.browser-internal-host:not([hidden]) [data-browser-record]').length===1`);
  await act(`document.querySelector('.browser-internal-host:not([hidden]) [data-browser-action="open"]').click()`);
  await until(async()=> (await browserState()).visible && await evaluate('relayWorkspacePanel.getState().activeId')!==managerIds.history);
  await check('history open action creates an internal web tab despite external link preference',`(!document.querySelector('.app').dataset.view||document.querySelector('.app').dataset.view==='chat')&&relayWorkspacePanel.getState().tabs.length===7`);
  await check('history open does not create another application window',BrowserWindow.getAllWindows().length===1);
  await activate(managerIds.general);
  const sameId=managerIds.general, countBefore=await evaluate('relayWorkspacePanel.getState().tabs.length');
  await address(base+'/next');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/next');
  await check('address navigation from manager to webpage preserves tab identity and tab count',`relayWorkspacePanel.getState().activeId===${JSON.stringify(sameId)}&&relayWorkspacePanel.getState().tabs.length===${countBefore}`);
  await click('workspaceBrowserBack');await until(currentSection('general'));await until(async()=> !(await browserState()).visible);
  await check('back from first native page restores its local management predecessor',`document.getElementById('workspaceBrowserAddress').value==='relay://browser/settings'&&!document.getElementById('workspaceBrowserForward').disabled`);
  await click('workspaceBrowserForward');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/next');
  await check('forward restores native webpage without duplicate tabs',`relayWorkspacePanel.getState().activeId===${JSON.stringify(sameId)}&&relayWorkspacePanel.getState().tabs.length===${countBefore}`);
  await click('workspaceBrowserBack');await until(currentSection('general'));
  await section('passwords');await until(`!!document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]:not(:disabled)')`);
  await act(`document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="reveal"]').click()`);
  await until(`document.querySelector('.browser-internal-host:not([hidden]) [data-form-secret]').textContent==='synthetic-revealed-secret'`);
  await act(`window.secretNode=document.querySelector('.browser-internal-host:not([hidden]) [data-form-secret]');document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]').click();window.secretField=document.querySelector('.browser-internal-host:not([hidden]) [data-form-field="password"]');secretField.value='synthetic-draft-secret'`);
  await activate(originalId);
  await check('leaving password tab destroys fields and wipes detached draft and revealed values',`!secretField.isConnected&&secretField.value===''&&!secretNode.isConnected&&secretNode.textContent!=='synthetic-revealed-secret'`);
  await activate(sameId);await until(`!!document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]:not(:disabled)')`);
  await check('returning password manager remounts clean controls',`document.querySelector('.browser-internal-host:not([hidden]) [data-form-field="password"]').value===''&&document.querySelector('.browser-internal-host:not([hidden]) .rbf-editor').hidden`);
  await act(`document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]').click();window.secretField=document.querySelector('.browser-internal-host:not([hidden]) [data-form-field="password"]');secretField.value='synthetic-draft-secret'`);
  await address(base+'/');await until(async()=> (await browserState()).visible);
  await check('same-tab address navigation clears sensitive form controls',`!secretField.isConnected&&secretField.value===''`);
  await click('workspaceBrowserBack');await until(currentSection('passwords'));
  for(const leave of ['section','panel','settings']) {
    await section('passwords');await until(`!!document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]:not(:disabled)')`);
    await act(`document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="reveal"]').click()`);
    await until(`document.querySelector('.browser-internal-host:not([hidden]) [data-form-secret]').textContent==='synthetic-revealed-secret'`);
    await act(`window.secretNode=document.querySelector('.browser-internal-host:not([hidden]) [data-form-secret]');document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]').click();window.secretField=document.querySelector('.browser-internal-host:not([hidden]) [data-form-field="password"]');secretField.value='synthetic-draft-secret'`);
    if(leave==='section')await section('history');
    if(leave==='panel')await click('workspaceClose');
    if(leave==='settings')await act('showAppView("settings")');
    await check(leave+' leave clears password fields and detached revealed text',`!secretField.isConnected&&secretField.value===''&&!secretNode.isConnected&&secretNode.textContent!=='synthetic-revealed-secret'`);
    if(leave==='section')await section('passwords');
    if(leave==='panel')await click('btnWorkspacePanel');
    if(leave==='settings')await act('showChatView()');
    await until(`!!document.querySelector('.browser-internal-host:not([hidden]) [data-form-action="add"]:not(:disabled)')`);
    await check(leave+' return remounts clean password controls',`document.querySelector('.browser-internal-host:not([hidden]) [data-form-field="password"]').value===''&&document.querySelector('.browser-internal-host:not([hidden]) .rbf-editor').hidden`);
  }
  await section('history');await activate(managerIds.bookmarks);
  const listenersBefore=await evaluate('internalFixture.listeners.size');
  await act(`document.querySelector('#workspaceTabs .workspace-tab-item.is-active .workspace-tab-close').click()`);
  await until(`!relayWorkspacePanel.getState().tabs.some(t=>t.id===${JSON.stringify(managerIds.bookmarks)})`);
  await check('closing internal tab disposes its management listener',`internalFixture.listeners.size===${listenersBefore-1}`);
  await activate(originalId);await menu('重新打开关闭的标签页');await until(currentSection('bookmarks'));
  await check('reopen closed internal tab restores its page within chat',`(!document.querySelector('.app').dataset.view||document.querySelector('.app').dataset.view==='chat')&&document.getElementById('workspaceBrowserAddress').value==='relay://browser/bookmarks'`);
  await section('general');
  const inBounds=`(()=>{const host=document.querySelector('.browser-internal-host:not([hidden])'),r=host.getBoundingClientRect(),bar=document.getElementById('workspaceBrowserNav').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&host.scrollWidth<=host.clientWidth+1&&bar.right<=innerWidth+1&&r.right<=innerWidth+1})()`;
  await act(`document.getElementById('workspaceResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);await settle();
  for(const name of ['general','history','bookmarks','downloads','permissions','passwords','contacts','clear']){await section(name);await check('300px management '+name+' has no horizontal overflow',inBounds)}
  await section('general');await capture('management-300-general');
  await section('permissions');await capture('management-300-permissions');
  await click('workspaceMaximize');await settle();
  await check('maximized manager fills visible panel without horizontal overflow',`relayWorkspacePanel.getState().maximized&&(${inBounds})`);
  await section('general');await capture('management-maximized');
  await section('history');await capture('management-maximized-history');
  // Traverse alternating native and local navigation segments in one tab.
  await activate(originalId);await address(base+'/');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/');
  await address('relay://browser/history');await until(currentSection('history'));
  await address(base+'/next');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/next');
  await click('workspaceBrowserBack');await until(currentSection('history'));
  await check('mixed A manager B history first back returns to manager',`relayWorkspacePanel.getState().activeId===${JSON.stringify(originalId)}&&document.getElementById('workspaceBrowserAddress').value==='relay://browser/history'`);
  await click('workspaceBrowserBack');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/');
  await check('mixed history second back restores native A',`relayWorkspacePanel.getState().activeId===${JSON.stringify(originalId)}`);
  await click('workspaceBrowserForward');await until(currentSection('history'));
  await check('mixed history first forward restores manager',`document.getElementById('workspaceBrowserAddress').value==='relay://browser/history'`);
  await click('workspaceBrowserForward');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/next');
  await check('mixed history second forward restores native B',`relayWorkspacePanel.getState().activeId===${JSON.stringify(originalId)}`);
  // A new navigation from a restored web segment must discard every old
  // forward segment, including management pages and their separate native views.
  await act(`relayWorkspacePanel.openUrl(${JSON.stringify(base+'/branch-a')})`);
  await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/branch-a');
  const branchId=await evaluate('relayWorkspacePanel.getState().activeId');
  await until(async()=> nativeViews().some(view=>view.webContents.getURL()===base+'/branch-a') && !(await browserState()).tab?.loading,'branch A committed native document');
  const branchAView=nativeViews().find(view=>view.webContents.getURL()===base+'/branch-a');
  await address('relay://browser/history');await until(currentSection('history'));
  await address(base+'/branch-b');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/branch-b');
  const branchBId=(await browserState()).tab.id;
  await click('workspaceBrowserBack');await until(currentSection('history'));
  await click('workspaceBrowserBack');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/branch-a');
  await branchAView.webContents.executeJavaScript('document.getElementById("next").click()',true);
  await until(async()=> (await browserState()).tab?.url===base+'/next' && !(await browserState()).tab?.loading);
  await until(async()=> !(await browserState()).tabs.some(tab=>tab.id===branchBId));
  await check('new in-page navigation after restored A discards old manager and B forward routes',`document.getElementById('workspaceBrowserForward').disabled&&relayWorkspacePanel.getState().activeId===${JSON.stringify(branchId)}`);
  await check('discarded B native renderer is closed',!(await browserState()).tabs.some(tab=>tab.id===branchBId));
  await click('workspaceBrowserBack');await until(async()=> (await browserState()).tab?.url===base+'/branch-a');
  await click('workspaceBrowserForward');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/next');
  await check('new web branch retains normal A to C back and forward',`relayWorkspacePanel.getState().activeId===${JSON.stringify(branchId)}&&document.getElementById('workspaceBrowserForward').disabled`);
  // Opening management from A1 after backing out of A2 must branch Relay's
  // visible history; forward should visit management rather than old A2.
  await act(`relayWorkspacePanel.openUrl(${JSON.stringify(base+'/segment-a1')})`);
  await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/segment-a1');
  const nativeBranchId=await evaluate('relayWorkspacePanel.getState().activeId');
  await until(async()=> nativeViews().some(view=>view.webContents.getURL()===base+'/segment-a1') && !(await browserState()).tab?.loading,'A1 committed native document');
  const a1View=nativeViews().find(view=>view.webContents.getURL()===base+'/segment-a1');
  await a1View.webContents.executeJavaScript('document.getElementById("next").click()',true);
  await until(async()=> (await browserState()).tab?.url===base+'/next' && (await browserState()).tab?.canGoBack);
  await click('workspaceBrowserBack');await until(async()=> (await browserState()).tab?.url===base+'/segment-a1' && (await browserState()).tab?.canGoForward);
  await address('relay://browser/history');await until(currentSection('history'));
  await click('workspaceBrowserBack');await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/segment-a1');
  await check('restored A1 offers forward navigation into its new management branch',`!document.getElementById('workspaceBrowserForward').disabled`);
  await click('workspaceBrowserForward');await until(currentSection('history'));
  await check('forward from restored A1 visits management instead of stale A2',`relayWorkspacePanel.getState().activeId===${JSON.stringify(nativeBranchId)}&&document.getElementById('workspaceBrowserAddress').value==='relay://browser/history'`);
  // Submit without an intervening event-loop tick: both invoke promises are
  // pending, so stale created/navigation replies must not spawn or replace tabs.
  await act(`relayWorkspacePanel.openUrl('relay://browser/settings')`);await until(currentSection('general'));
  const raceId=await evaluate('relayWorkspacePanel.getState().activeId'),raceCount=await evaluate('relayWorkspacePanel.getState().tabs.length');
  await act(`const input=document.getElementById('workspaceBrowserAddress'),form=document.getElementById('workspaceBrowserNav');input.value=${JSON.stringify(base+'/race-first')};form.requestSubmit();input.value=${JSON.stringify(base+'/race-last')};form.requestSubmit()`);
  await until(async()=> (await browserState()).visible && (await browserState()).tab?.url===base+'/race-last');await settle();
  await check('rapid web submissions retain one tab and the last URL',`relayWorkspacePanel.getState().tabs.length===${raceCount}&&relayWorkspacePanel.getState().activeId===${JSON.stringify(raceId)}`);
  await act(`relayWorkspacePanel.openUrl('relay://browser/settings')`);await until(currentSection('general'));
  const localRaceId=await evaluate('relayWorkspacePanel.getState().activeId'),localRaceCount=await evaluate('relayWorkspacePanel.getState().tabs.length');
  await act(`const input=document.getElementById('workspaceBrowserAddress'),form=document.getElementById('workspaceBrowserNav');input.value=${JSON.stringify(base+'/cancelled-intent')};form.requestSubmit();input.value='relay://browser/history';form.requestSubmit()`);
  await until(currentSection('history'));await settle();await until(async()=> !(await browserState()).visible);
  await check('management navigation wins over a pending native create reply',`relayWorkspacePanel.getState().tabs.length===${localRaceCount}&&relayWorkspacePanel.getState().activeId===${JSON.stringify(localRaceId)}&&document.getElementById('workspaceBrowserAddress').value==='relay://browser/history'`);
  await check('all management operations leave conversation history and model untouched',`!currentConv&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')`);
}).catch(async error => { report.failures.push(error.stack || error.message); try { report.chrome = await evaluate('({address:document.getElementById("workspaceBrowserAddress").value,title:document.getElementById("workspaceBrowserAddress").title,active:document.activeElement.id,view:document.querySelector(".app").dataset.view})'); report.browser = await browserState(); report.native = nativeViews().map(v=>({url:v.webContents.getURL(),historyLength:v.webContents.navigationHistory.length(),back:v.webContents.navigationHistory.canGoBack()})); report.geometry = await evaluate('({width:innerWidth,app:document.querySelector(".app").getBoundingClientRect().toJSON(),panel:document.getElementById("workspacePanel").getBoundingClientRect().toJSON(),state:relayWorkspacePanel.getState()})'); await capture('failure'); } catch (_) {} }).finally(async () => {
  clearTimeout(deadline);
  if (registry) registry.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.failures.length ? 1 : 0);
});
