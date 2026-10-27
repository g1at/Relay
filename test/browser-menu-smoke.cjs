'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const nativeMenu = require('./browser-menu-test-helper.cjs').createBrowserMenuProbe(electron);
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'browser-menu-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.on('window-all-closed', () => {});
let win, registry, server;
const calls=[];
const report = { results: {}, failures: [], metrics: {} };
const save = () => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.failures.push('Browser menu smoke timed out'); save(); app.exit(1); }, 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise) { let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operation timed out')),6000)})]); } finally { clearTimeout(timer); } }
const evaluate = source => bounded(win.webContents.executeJavaScript(source));
const act = source => evaluate(`(()=>{${source}\n})()`);
async function until(predicate, label = 'state') {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await (typeof predicate === 'function' ? predicate() : evaluate(predicate))) return; await pause(30); }
  throw Error('Timed out: ' + label);
}
async function check(name, predicate) { const value = typeof predicate === 'string' ? await evaluate(predicate) : await predicate; report.results[name] = !!value; save(); if (!value) throw Error(name); console.log('[pass]',name); }
const click = id => act(`document.getElementById(${JSON.stringify(id)}).click();`);
const browserState = () => evaluate('api.browser.invoke({action:"state"})');
const nativeViews = () => win.contentView.children.filter(view => view.webContents && view.webContents !== win.webContents);

async function openMenu(){await click('workspaceBrowserMore');await until(()=>nativeMenu.isOpen(),'native popup');}
async function closed(){await until(()=>!nativeMenu.isOpen(),'native close');await until('document.getElementById("workspaceBrowserMore").getAttribute("aria-expanded")==="false"','renderer close');}
async function select(label){nativeMenu.select(label);await closed();}
app.whenReady().then(async()=>{
  server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><title>菜单刷新回归</title><style>body{margin:0;padding:44px;background:#f4f7fb;color:#17233a;font:18px system-ui;line-height:1.8}article{background:white;border:1px solid #dbe3ee;border-radius:16px;padding:28px;max-width:820px}small{color:#4a6283}#bar{height:12px;width:70px;background:#3576de;border-radius:6px;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(420px)}}</style><small>RELAY / NATIVE MENU CHECK</small><h1>菜单展开时，网页继续刷新</h1><article><p>高分辨率文字保持清晰，页面不再被静态截图替换。</p><code>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</code><p>实时绘制帧数：<strong id="frames">0</strong></p><div id="bar"></div></article><script>window.framesRendered=0;function frame(){document.getElementById('frames').textContent=++framesRendered;requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>`)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  app.on('session-created',ses=>ses.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)&&!details.url.startsWith(base+'/')})));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.setItem('relay.workspace-panel.width.v1','720');const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1440, height: 960, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  const observedIpc={handle(channel,handler){ipcMain.handle(channel,(event,input)=>{calls.push({action:input?.action,visible:input?.visible});return handler(event,input)})},removeHandler:channel=>ipcMain.removeHandler(channel)};
  registry = registerBrowserPanelIpc({ ipcMain: observedIpc, getWindow: () => win, entryFile: entry, getElectron: nativeMenu.getElectron });
  await win.loadFile(entry); win.setAlwaysOnTop(true); win.show(); win.focus();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await click('btnWorkspacePanel');await act('document.querySelector("[data-workspace-create=browser]").click()');
  await until('relayWorkspacePanel.getState().tab==="browser"');
  await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(base+'/')};document.getElementById('workspaceBrowserNav').requestSubmit()`);
  await until(async()=>(await browserState()).visible&&(await browserState()).tab?.title==='菜单刷新回归','live page');
  await click('workspaceMaximize');await pause(800);
  const view=nativeViews().find(v=>v.webContents.getURL()===base+'/'),page=view.webContents;
  const baseline=await bounded(page.executeJavaScript('framesRendered'));
  await until(async()=>await bounded(page.executeJavaScript('framesRendered'))>baseline+5,'fixture animation before menu');
  const before=await bounded(page.capturePage());
  await check('high DPI fixture exceeds old 1600px snapshot limit',Math.max(before.getSize().width,before.getSize().height)>1600);
  fs.writeFileSync(path.join(out,'page-before-menu.png'),before.toPNG());
  const firstCall=calls.length,started=Date.now();await openMenu();report.metrics.menuOpenMs=Date.now()-started;
  await check('real native popup exposes browser actions and zoom commands',['新建标签页','书签','浏览器设置','缩小','放大'].every(label=>nativeMenu.has(label)));
  await check('More preserves native page without showing snapshot cover',(await browserState()).visible&&win.contentView.children.includes(view)&&await evaluate('document.getElementById("workspaceBrowserMenu").hidden&&document.getElementById("workspaceBrowserCover").hidden'));
  const framesBefore=await bounded(page.executeJavaScript('framesRendered'));await pause(450);const framesAfter=await bounded(page.executeJavaScript('framesRendered'));
  report.metrics.framesWhileMenuOpen=framesAfter-framesBefore;report.metrics.menuStillOpen=nativeMenu.isOpen();report.metrics.pageVisibility=await bounded(page.executeJavaScript('document.visibilityState'));
  await check('page animation continues while OS menu is open',nativeMenu.isOpen()&&framesAfter-framesBefore>=5);
  await check('opening menu sends no hide or screenshot requests',calls.slice(firstCall).every(call=>call.action!=='capture'&&!(call.action==='visibility'&&call.visible===false)));
  const during=await bounded(page.capturePage());report.metrics.pagePixels=during.getSize();
  await check('menu preserves full pixel dimensions',JSON.stringify(before.getSize())===JSON.stringify(during.getSize()));
  fs.writeFileSync(path.join(out,'page-during-menu.png'),during.toPNG());
  // Electron captures sibling native views and OS menus separately; this is
  // chrome-only evidence. The full-resolution page image above is unmodified.
  fs.writeFileSync(path.join(out,'chrome-during-menu.png'),(await bounded(win.capturePage())).toPNG());
  await select('放大');await until(async()=>(await browserState()).tab.zoom>1,'native zoom');
  await check('native zoom dispatch reaches original action',(await browserState()).tab.zoom===1.1&&(await browserState()).visible);
  await openMenu();await select('恢复为 100%');await until(async()=>(await browserState()).tab.zoom===1,'zoom reset');
  await check('native reset command works',(await browserState()).tab.zoom===1);
  for(let n=0;n<4;n++){await openMenu();nativeMenu.close();await closed()}
  await check('repeated opening and dismissal preserves live page',(await browserState()).visible&&await evaluate('document.getElementById("workspaceBrowserCover").hidden'));
  await openMenu();await select('收藏此页');await until(async()=>(await browserState()).tab.bookmarked,'bookmark');
  await check('native bookmark dispatch works',(await browserState()).tab.bookmarked);
  await openMenu();await page.loadURL(base+'/next');await closed();
  await check('navigation dismisses stale menu',!nativeMenu.isOpen());
  await until(async()=>(await browserState()).visible,'navigated page');
  await openMenu();await select('书签');await until('document.getElementById("workspaceBrowserAddress").value==="relay://browser/bookmarks"','internal bookmarks');
  await check('native menu opens internal management pages',!(await browserState()).visible);
  await openMenu();await select('新建标签页');await until('document.getElementById("workspaceBrowserAddress").value===""','empty page');
  await check('native menu works on internal pages',!nativeMenu.isOpen());
  await act('for(const node of document.querySelectorAll(".workspace-tab-item:not(.is-active) .workspace-tab-close"))node.click()');
  await until('document.querySelectorAll(".workspace-tab-item").length===1','last browser tab');
  await openMenu();await act('document.querySelector(".workspace-tab-close").click()');await closed();
  await check('closing the last tab dismisses its native menu',!nativeMenu.isOpen()&&await evaluate('document.querySelectorAll(".workspace-tab-item").length===0'));
  await check('renderer has no unexpected errors',await evaluate('uiFixture.errors.length===0')&&report.failures.length===0);
}).catch(error=>{report.failures.push(error.stack||String(error));console.error(error);save()}).finally(async()=>{
  clearTimeout(deadline);nativeMenu.close();registry?.dispose();if(win&&!win.isDestroyed())win.destroy();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  save();app.exit(report.failures.length?1:0);
});
