'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'workspace-tabs-browser-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, registry, server;
const report = { results: {}, failures: [] };
const deadline = setTimeout(() => { console.error('Browser renderer smoke timed out'); app.exit(1); }, 115000);
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
  const fixture = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry });
  await win.loadFile(entry); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await click('btnWorkspacePanel');
  await check('first opening shows launcher without a placeholder tab or native browser', 'relayWorkspacePanel.getState().tabs.length===0&&!document.getElementById("workspaceNoTabs").hidden&&document.getElementById("workspaceAdd").hidden');
  await act('document.querySelector("[data-workspace-create=files]").click();');
  await until('document.querySelectorAll(".workspace-file-row").length===2');
  await act('document.querySelector("[data-path=\\"README.md\\"]").click();');
  await until('!!document.querySelector("#workspacePreviewBody table")');
  await click('workspacePreviewBack');
  await act('document.querySelector("[data-path=\\"app.js\\"]").click();');
  await until('document.querySelector("#workspacePreviewBody code")?.textContent.includes("ready")');
  await check('different files open independently in closeable tabs', 'relayWorkspacePanel.getState().tabs.filter(t=>t.kind==="files").length===3&&document.querySelectorAll(".workspace-tab-close").length===3');
  await act('document.querySelectorAll("#workspaceTabs .workspace-tab")[1].click();');
  await check('returning to Markdown restores rendered document', '!!document.querySelector("#workspacePreviewBody table")');
  await click('workspaceMaximize'); await settle();
  await check('expanded reading fills content width below caption controls', 'relayWorkspacePanel.getState().maximized&&document.getElementById("workspacePanel").getBoundingClientRect().width>=innerWidth-1&&document.getElementById("workspacePanel").getBoundingClientRect().top>=35');
  await click('workspaceTreeToggle');
  await capture('files-expanded');
  await click('workspaceMaximize');
  await click('workspaceAdd');
  await check('plus menu lists working tools without side chat', 'document.getElementById("workspaceAddMenu").textContent.includes("浏览器")&&!document.getElementById("workspaceAddMenu").textContent.includes("聊天")&&!document.querySelector("[data-workspace-create=tasks]")&&document.querySelectorAll("#workspaceAddMenu button").length===4');
  await act('Array.from(document.querySelectorAll("#workspaceAddMenu button")).find(b=>b.dataset.workspaceCreate==="browser").click();');
  await until('relayWorkspacePanel.getState().tab==="browser"&&!!document.getElementById("workspaceBrowserAddress")');
  await check('empty browser does not create a conversation', '!currentConv&&!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
  await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(base + '/')};document.getElementById('workspaceBrowserNav').requestSubmit();`);
  await until(async () => (await browserState()).tab?.title === '项目交付预览');
  await until(async () => (await browserState()).visible, 'native browser visible');
  await settle();
  const firstId = (await browserState()).tab.id;
  const firstView = nativeViews().find(view => view.webContents.getURL() === base + '/');
  await check('native browser renders a page that refuses iframe embedding', !!firstView && await firstView.webContents.executeJavaScript('document.querySelector("h1").textContent.includes("项目交付预览")'));
  await check('browser and tabs stay within normal right panel', 'document.documentElement.scrollWidth<=innerWidth&&document.getElementById("workspaceBrowserNav").getBoundingClientRect().width<=document.getElementById("workspacePanel").getBoundingClientRect().width');
  await check('browser address starts at conversation divider with full size controls', '(()=>{const edge=document.querySelector(".chat-header").getBoundingClientRect().bottom,address=document.getElementById("workspaceBrowserAddress").getBoundingClientRect(),back=document.getElementById("workspaceBrowserBack").getBoundingClientRect();return Math.abs(address.top-edge)<1&&address.height>=29&&back.height>=28&&Math.abs(document.getElementById("workspaceBrowserViewport").getBoundingClientRect().top-document.getElementById("workspaceBrowserNav").getBoundingClientRect().bottom)<1})()');
  await capture('browser-docked');
  // Exercise the host bridge with actual native WebContents input, not a DOM
  // event in Relay. Custom bindings must reach the same parent dispatcher.
  async function nativeKey(view, keyCode, modifiers) {
    win.focus(); view.webContents.focus(); await pause(80);
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  await nativeKey(firstView, 'L', ['control']);
  await until('document.activeElement.id==="workspaceBrowserAddress"');
  await check('native browser retains its address shortcut', 'document.activeElement.id==="workspaceBrowserAddress"');
  await nativeKey(firstView, '1', ['control', 'alt']);
  await until('relayWorkspacePanel.getState().tabs.filter(t=>t.kind==="browser").length===2');
  await check('workspace shortcut from a real native page creates a browser tab', (await browserState()).tabs.length === 2);
  await act('document.querySelector("#workspaceTabs .workspace-tab-item.is-active .workspace-tab-close").click();');
  await until(async () => (await browserState()).tabs.length === 1);
  await act('relayWorkspacePanel.open("browser");'); await until(async () => (await browserState()).visible);
  await act('relayKeyboardShortcuts.assign("openFiles",0,"Mod+Alt+9");'); await pause(150);
  await nativeKey(firstView, '2', ['control', 'alt']); await pause(120);
  await check('native browser releases a replaced workspace shortcut', 'relayWorkspacePanel.getState().tab==="browser"');
  await nativeKey(firstView, '9', ['control', 'alt']);
  await until('relayWorkspacePanel.getState().tab==="files"');
  await check('custom workspace shortcut from native content opens files', 'relayWorkspacePanel.getState().tab==="files"');
  await act('relayKeyboardShortcuts.reset("openFiles");relayWorkspacePanel.open("browser");');
  await until(async () => (await browserState()).visible);

  await firstView.webContents.executeJavaScript('document.getElementById("next").click()', true);
  await until(async () => (await browserState()).tab?.canGoBack && (await browserState()).tab?.url.endsWith('/next'));
  await click('workspaceBrowserBack'); await until(async () => (await browserState()).tab?.url === base + '/');
  await check('back and forward buttons follow native navigation', '!document.getElementById("workspaceBrowserForward").disabled');
  await settle();
  win.setSize(1200, 620); await settle();
  await click('workspaceBrowserMore');
  await until(async () => !(await browserState()).visible);
  await check('browser hides native surface underneath its menu', '!document.getElementById("workspaceBrowserMenu").hidden&&!document.getElementById("workspaceBrowserCover").textContent.includes("暂时隐藏")');
  await capture('browser-menu');
  await check('browser menu scrollbar uses Relay size and removes native arrow buttons', '(()=>{const m=document.getElementById("workspaceBrowserMenu"),bar=getComputedStyle(m,"::-webkit-scrollbar"),button=getComputedStyle(m,"::-webkit-scrollbar-button"),thumb=getComputedStyle(m,"::-webkit-scrollbar-thumb");return bar.width==="9px"&&button.display==="none"&&thumb.borderRadius==="999px";})()');
  await act('document.getElementById("workspaceBrowserMenu").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));');
  await check('long browser menu scrolls its last action into view with the keyboard', '(()=>{const m=document.getElementById("workspaceBrowserMenu"),last=m.querySelector(":scope > [role=menuitem]:last-child"),a=last.getBoundingClientRect(),b=m.getBoundingClientRect();return m.scrollHeight>m.clientHeight&&m.scrollTop>0&&document.activeElement===last&&a.bottom<=b.bottom+1&&a.top>=b.top-1;})()');
  await capture('browser-menu-scrollbar');
  win.setSize(1200, 820); await settle();
  await act('Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).find(b=>b.textContent==="在页面中查找").click();');
  await act('document.getElementById("workspaceBrowserFindInput").value="查找示例";document.getElementById("workspaceBrowserFindInput").dispatchEvent(new Event("input",{bubbles:true}));');
  await until('document.getElementById("workspaceBrowserFindCount").textContent.includes("2")', 'find results');
  await check('in-page find receives real Chromium matches', 'document.getElementById("workspaceBrowserFindCount").textContent.includes("2")');
  await click('workspaceBrowserFindClose');
  await act(`window.dragBrowserPane=delta=>{const h=document.getElementById('workspaceResizeHandle'),x=h.getBoundingClientRect().left+4;h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:95,clientX:x,button:0,isPrimary:true,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:95,clientX:x-delta,bubbles:true}));window.dispatchEvent(new PointerEvent('pointerup',{pointerId:95,clientX:x-delta,bubbles:true}));};dragBrowserPane(innerWidth-280-relayWorkspacePanel.getState().width);`); await settle();
  await check('browser snaps to full width when the conversation reaches its limit', 'relayWorkspacePanel.getState().maximized&&Math.abs(document.getElementById("workspacePanel").getBoundingClientRect().left-document.querySelector(".app").getBoundingClientRect().left)<1');
  await until(async () => (await browserState()).visible);
  const expanded = await evaluate('(()=>{const viewport=document.getElementById("workspaceBrowserViewport").getBoundingClientRect(),app=document.querySelector(".app").getBoundingClientRect(),grip=document.getElementById("workspaceResizeHandle"),handle=grip.getBoundingClientRect();return {left:viewport.left,right:viewport.right,appLeft:app.left,appRight:app.right,gripX:handle.left+3,gripY:handle.top+20,headerGrip:document.elementFromPoint(handle.left+3,handle.top+20)===grip,viewportTop:viewport.top};})()');
  const expandedBounds = firstView.getBounds(), browserScale = win.webContents.getZoomFactor();
  report.expandedBrowserGeometry = { viewport: expanded, native: expandedBounds, scale: browserScale };
  await check('expanded browser fills the content width without a left gutter', expanded.left === expanded.appLeft && expanded.right === expanded.appRight && Math.abs(expandedBounds.x - expanded.left * browserScale) < 1 && Math.abs(expandedBounds.width - (expanded.right - expanded.left) * browserScale) < 1);
  await check('expanded browser keeps a resize target above the native page', expanded.headerGrip && expanded.gripY < expandedBounds.y / browserScale);
  await capture('browser-expanded');
  // Hit the actual renderer separator with mouse input. Synthetic events sent
  // directly to the handle would also pass if native content covered it.
  win.focus(); win.webContents.focus();
  const gripX = Math.round(expanded.gripX * browserScale), gripY = Math.round(expanded.gripY * browserScale);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: gripX, y: gripY });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: gripX, y: gripY, button: 'left', clickCount: 1 });
  await until('document.querySelector(".app").classList.contains("is-workspace-resizing")', 'header resize grip captures a real pointer');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: gripX + Math.round(340 * browserScale), y: gripY });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: gripX + Math.round(340 * browserScale), y: gripY, button: 'left', clickCount: 1 });
  await settle();
  await until(async () => (await browserState()).visible);
  await check('native webpage returns to its restored column after the snap animation', !await evaluate('relayWorkspacePanel.getState().maximized')&&Math.abs(firstView.getBounds().x-await evaluate('document.getElementById("workspaceBrowserViewport").getBoundingClientRect().left')*win.webContents.getZoomFactor())<3);
  await click('workspaceMaximize'); await settle();
  await click('workspaceBrowserMore');
  await act('Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).find(button=>button.textContent==="历史记录").click();');
  await until('document.querySelector(".browser-internal-host:not([hidden]) .relay-browser-settings")?.dataset.browserSection==="history"');
  await until(async () => !(await browserState()).visible);
  await check('history menu opens an internal browser tab and preserves chat layout', '(!document.querySelector(".app").dataset.view||document.querySelector(".app").dataset.view==="chat")&&relayWorkspacePanel.getState().maximized&&document.getElementById("workspaceBrowserAddress").value==="relay://browser/history"');
  await act('document.querySelector("#workspaceTabs .workspace-tab-item.is-active .workspace-tab-close").click();');
  await until(async () => (await browserState()).visible);
  await check('closing management returns to the original loaded native browser', (await browserState()).tab.id === firstId && !firstView.webContents.isDestroyed());
  // Settings are still a separate app view; verify releasing native geometry
  // through that explicit route, independently of browser management navigation.
  await act('showAppView("settings");');
  await until(async () => !(await browserState()).visible);
  await check('settings release expanded layout and native overlay', '!relayWorkspacePanel.getState().maximized&&document.querySelector(".app").dataset.view==="settings"');
  await act('showChatView();'); await until(async () => (await browserState()).visible);
  await check('returning to chat preserves the same loaded browser', (await browserState()).tab.id === firstId && !firstView.webContents.isDestroyed());
  await click('btnPermissionMode'); await until(async () => !(await browserState()).visible);
  await check('permission selector remains above browser content', '!!document.querySelector(".rpc-popover.is-open")');
  await click('btnPermissionMode'); await until(async () => (await browserState()).visible);
  await firstView.webContents.executeJavaScript('document.getElementById("popup").click()', true);
  await until('relayWorkspacePanel.getState().tabs.filter(t=>t.kind==="browser").length===2');
  await check('page popup becomes another internal tab', BrowserWindow.getAllWindows().length === 1);
  await act('window.popupTab=relayWorkspacePanel.getState().activeId;relayWorkspacePanel.newTerminal();Array.from(document.querySelectorAll("#workspaceTabs [data-tab-id]")).find(n=>n.dataset.tabId===window.popupTab).querySelector(".workspace-tab").click();');
  await act('document.querySelector("#workspaceTabs .workspace-tab-item.is-active .workspace-tab-close").click();');
  await until(async () => (await browserState()).tabs.length === 1);
  await until(async () => !(await browserState()).visible);
  await check('closing active browser onto terminal cannot expose another webpage', 'relayWorkspacePanel.getState().tab==="terminal"');
  await check('closing browser tab disposes native page without stopping another', !firstView.webContents.isDestroyed());
  await act('relayWorkspacePanel.open("browser");'); await until(async () => (await browserState()).visible);
  await act('document.documentElement.dataset.theme="dark";document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}));');
  await settle();
  await check('minimum width keeps browser toolbar and page in bounds', 'relayWorkspacePanel.getState().width===300&&document.getElementById("workspaceBrowserMore").getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth');
  await capture('browser-dark-narrow');
  await click('workspaceClose'); await until(async () => !(await browserState()).visible);
  await check('closing right panel preserves browser and history stays untouched', !(await browserState()).visible && !(await evaluate('uiFixture.calls.includes("history.save")||uiFixture.calls.includes("runClaude")')));
  await click('btnWorkspacePanel');
  while (await evaluate('relayWorkspacePanel.getState().tabs.length')) {
    const count = await evaluate('relayWorkspacePanel.getState().tabs.length');
    await act('document.querySelector("#workspaceTabs .workspace-tab-close").click();');
    await until(`relayWorkspacePanel.getState().tabs.length<${count}`);
  }
  await until(async () => (await browserState()).tabs.length === 0);
  await check('closing all tabs shows direct tool launchers', '!document.getElementById("workspaceNoTabs").hidden&&document.querySelectorAll("#workspaceNoTabs button:not(:disabled)").length===4&&!document.getElementById("workspaceNoTabs").textContent.includes("点击上方")');
  const launcherCentered = '(()=>{const a=document.getElementById("workspaceLauncherActions").getBoundingClientRect(),b=document.getElementById("workspaceNoTabs").getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<1&&Math.abs(a.y+a.height/2-b.y-b.height/2)<1&&a.left>=b.left&&a.right<=b.right&&document.documentElement.scrollWidth<=innerWidth;})()';
  await settle();
  await check('launcher stays centered at minimum panel width', launcherCentered);
  await act('document.activeElement.blur();');
  await capture('launcher-dark-narrow');
  await act('document.documentElement.dataset.theme="light";document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');
  await capture('launcher-light');
  await click('workspaceMaximize'); await settle();
  await check('launcher stays centered when panel is maximized', launcherCentered);
  await click('workspaceMaximize');
  await click('workspaceClose'); await click('btnWorkspacePanel');
  await check('reopening an empty panel keeps the launcher', '!document.getElementById("workspaceNoTabs").hidden&&relayWorkspacePanel.getState().tabs.length===0');
  await act('document.querySelector("[data-workspace-create=browser]").click();document.querySelector("[data-workspace-create=browser]").click();');
  await until('relayWorkspacePanel.getState().tab==="browser"');
  await check('browser launcher creates one native tab and focuses address', (await browserState()).tabs.length === 1 && await evaluate('document.activeElement.id==="workspaceBrowserAddress"'));
  await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(base + '/')};document.getElementById('workspaceBrowserNav').requestSubmit();`);
  await until(async () => (await browserState()).visible && (await browserState()).tab?.title === '项目交付预览');
  await check('browser opened from launcher renders the real webpage', nativeViews().some(view => view.webContents.getURL() === base + '/'));
  await check('launcher actions leave conversation history untouched', '!currentConv&&!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
}).catch(async error => { report.failures.push(error.stack || error.message); try { report.browser = await browserState(); report.native = nativeViews().map(v=>({url:v.webContents.getURL(),historyLength:v.webContents.navigationHistory.length(),back:v.webContents.navigationHistory.canGoBack()})); report.geometry = await evaluate('({width:innerWidth,app:document.querySelector(".app").getBoundingClientRect().toJSON(),panel:document.getElementById("workspacePanel").getBoundingClientRect().toJSON(),state:relayWorkspacePanel.getState()})'); await capture('failure'); } catch (_) {} }).finally(async () => {
  clearTimeout(deadline);
  if (registry) registry.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.failures.length ? 1 : 0);
});
