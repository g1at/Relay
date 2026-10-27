'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'browser-tabs-icons-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, registry, server, secureServer;
const report = { results: {}, failures: [] };
const deadline = setTimeout(() => { console.error('Browser renderer smoke timed out'); app.exit(1); }, 115000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(work, label, timeoutMs = 8000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
const evaluate = source => bounded(win.webContents.executeJavaScript(source), 'renderer evaluation');
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
        fs.writeFileSync(path.join(out, name + suffix + '.png'), (await bounded(surface.capturePage(), 'capture ' + name + suffix, 5000)).toPNG());
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
  const icon = (red, green, blue) => { const bitmap=Buffer.alloc(16*16*4);for(let n=0;n<bitmap.length;n+=4){bitmap[n]=blue;bitmap[n+1]=green;bitmap[n+2]=red;bitmap[n+3]=255;}return nativeImage.createFromBitmap(bitmap,{width:16,height:16}).toPNG(); };
  const red = icon(210,50,60), blue = icon(40,100,210), requests=[];
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
  icoHeader[6] = 16; icoHeader[7] = 16;
  icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(red.length, 14); icoHeader.writeUInt32LE(22, 18);
  const ico = Buffer.concat([icoHeader, red]);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#20a56b"/></svg>';
  const handler = (request,response)=>{
    const pathname=new URL(request.url,'http://fixture.local').pathname;
    if(pathname.endsWith('.png')||pathname.endsWith('.svg')||pathname==='/real.ico'||pathname==='/png-icon.ico'){
      requests.push({url:pathname,cookie:request.headers.cookie||''});
      if(!String(request.headers.cookie||'').includes('favicon_session=browser')){response.writeHead(401);response.end();return;}
      const send=()=>{response.writeHead(200,{'Content-Type':pathname.endsWith('.svg')?'image/svg+xml':pathname.endsWith('.ico')?'image/x-icon':'image/png','Cache-Control':'no-store'});response.end(pathname.endsWith('.svg')?svg:pathname==='/real.ico'?ico:pathname==='/blue.png'?blue:red);};
      if(pathname==='/slow.png')setTimeout(send,700);else send();return;
    }
    if(pathname.endsWith('.ico')){response.writeHead(404);response.end();return;}
    const image=pathname==='/empty'?'/missing.ico':pathname==='/slow'?'/slow.png':pathname==='/svg'?'/icon.svg':'/red.png';
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end('<!doctype html><meta charset="utf-8"><script>document.cookie="favicon_session=browser; SameSite=Lax"</script><link id="favicon" rel="icon" href="'+image+'"><title>网页标题非常长时也应当保持与文件终端审查标签相同的宽度</title><h1>本地网页图标测试</h1>');
  };
  server = http.createServer(handler);
  await bounded(new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)), 'start HTTP fixture');
  const base=`http://127.0.0.1:${server.address().port}`;
  secureServer=https.createServer({key:fs.readFileSync(path.join(__dirname,'fixtures/browser-tls/localhost.key')),cert:fs.readFileSync(path.join(__dirname,'fixtures/browser-tls/localhost.pem'))},handler);
  await bounded(new Promise(resolve=>secureServer.listen(0,'127.0.0.1',resolve)), 'start HTTPS fixture');
  const secureBase=`https://127.0.0.1:${secureServer.address().port}`;
  app.on('session-created',session=>session.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)&&!details.url.startsWith(base+'/')&&!details.url.startsWith(secureBase+'/')})));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.setItem('relay.workspace-panel.width.v1','720');const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1440, height: 960, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry });
  await bounded(win.loadFile(entry), 'load renderer', 15000); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');

  await click('btnWorkspacePanel');await act('relayWorkspacePanel.create("browser")');
  await until('relayWorkspacePanel.getState().tab==="browser"');
  await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(base+'/red')};document.getElementById('workspaceBrowserNav').requestSubmit()`);
  await until(async()=>!!(await browserState()).tab?.favicon,'native favicon reaches owner');
  const first=(await browserState()).tab, browserId=first.id;
  const browserItem=await evaluate('relayWorkspacePanel.getState().activeId');
  const loadedIcon=`(()=>{const i=document.querySelector('#workspaceTabs [data-workspace-tab="browser"] img');return !!i&&i.complete&&i.naturalWidth>0})()`;
  await until(loadedIcon,'favicon decodes in actual browser tab');
  await check('real favicon is transported as image data and displayed',/^data:image\//.test(first.favicon)&&await evaluate(loadedIcon));
  await check('favicon request uses browser session credentials',requests.some(r=>r.url==='/red.png'&&r.cookie.includes('favicon_session=browser')));
  const contents=nativeViews().find(view=>view.webContents.getURL()===base+'/red').webContents;
  await bounded(contents.executeJavaScript('document.getElementById("favicon").href="/blue.png"'), 'switch dynamic favicon');
  await until(async()=>{const t=(await browserState()).tab;return !!t?.favicon&&t.favicon!==first.favicon;},'dynamic icon update');
  const changed=(await browserState()).tab.favicon;
  await until(`document.querySelector('#workspaceTabs [data-workspace-tab="browser"] img')?.src===${JSON.stringify(changed)}`,'dynamic favicon paints without title change');
  await check('favicon updates even when page title stays unchanged',(await browserState()).tab.title===first.title);
  await bounded(contents.executeJavaScript('document.getElementById("favicon").href="/real.ico"'), 'switch to ICO');
  await until(async()=> (await browserState()).tab?.favicon === 'data:image/x-icon;base64,' + ico.toString('base64'), 'real ICO reaches owner');
  await until(loadedIcon, 'real ICO decodes in browser tab');
  await check('real ICO favicon is normalized and decoded by Chromium',
    (await browserState()).tab.favicon === 'data:image/x-icon;base64,' + ico.toString('base64') && await evaluate(loadedIcon));
  await capture('tabs-icons-real-ico');

  await bounded(contents.executeJavaScript('document.getElementById("favicon").href="/png-icon.ico"'), 'switch to mislabeled PNG');
  await until(async()=> (await browserState()).tab?.favicon === 'data:image/png;base64,' + red.toString('base64'), 'mislabeled PNG reaches owner');
  await until(loadedIcon, 'mislabeled PNG decodes in browser tab');
  await check('PNG served as image/x-icon is normalized and decoded by Chromium',
    (await browserState()).tab.favicon === 'data:image/png;base64,' + red.toString('base64') && await evaluate(loadedIcon));

  await act('relayWorkspacePanel.create("files");relayWorkspacePanel.create("terminal");relayWorkspacePanel.create("review")');
  await until('new Set(relayWorkspacePanel.getState().tabs.map(t=>t.kind)).size===4');
  const widths=()=>evaluate('Array.from(document.querySelectorAll("#workspaceTabs .workspace-tab-item")).map(n=>n.getBoundingClientRect().width)');
  const initialWidths=await widths();
  await check('all four tool kinds have one fixed tab width',initialWidths.length===4&&initialWidths.every(w=>Math.abs(w-initialWidths[0])<.5));
  await act(`document.querySelector('[data-tab-id="${browserItem}"] .workspace-tab').click()`);await settle();
  await check('switching active tool keeps identical widths',(await widths()).every(w=>Math.abs(w-initialWidths[0])<.5));
  await check('long page title is ellipsized inside its fixed tab',`(()=>{const l=document.querySelector('[data-tab-id="${browserItem}"] .workspace-tab-label');return l.scrollWidth>l.clientWidth&&getComputedStyle(l).textOverflow==='ellipsis'})()`);
  await click('workspaceMaximize');await capture('tabs-icons-expanded');
  await act('document.documentElement.dataset.theme="dark";document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');await settle();
  await check('narrow panel scrolls fixed tabs without overflowing the window',`(()=>{const t=document.getElementById('workspaceTabs');return t.scrollWidth>t.clientWidth&&document.documentElement.scrollWidth<=innerWidth})()`);
  await check('narrow panel preserves all tab widths',(await widths()).every(w=>Math.abs(w-initialWidths[0])<.5));
  await capture('tabs-icons-dark-narrow');
  const next=await evaluate(`api.browser.invoke(${JSON.stringify({action:'navigate',id:browserId,url:base+'/empty'})})`);
  await check('navigation immediately drops the previous site icon',next.tab.favicon===null);
  await until(async()=>{const t=(await browserState()).tab;return !t.loading&&t.url===base+'/empty';});await pause(850);
  await check('missing favicon falls back to the normal browser icon',!(await browserState()).tab.favicon&&await evaluate(`!document.querySelector('[data-tab-id="${browserItem}"] img')`));
  await evaluate(`api.browser.invoke(${JSON.stringify({action:'navigate',id:browserId,url:base+'/slow'})})`);
  await until(()=>requests.some(r=>r.url==='/slow.png'),'slow old icon request started');
  await evaluate(`api.browser.invoke(${JSON.stringify({action:'navigate',id:browserId,url:base+'/svg'})})`);
  await until(async()=> (await browserState()).tab?.favicon?.startsWith('data:image/svg+xml'),'SVG favicon supported');
  await until(loadedIcon,'SVG decodes as an image');const latest=(await browserState()).tab.favicon;
  await pause(1000);
  await check('late old-page icon cannot replace current SVG favicon',(await browserState()).tab.favicon===latest);
  await evaluate(`api.browser.invoke(${JSON.stringify({action:'navigate',id:browserId,url:secureBase+'/red'})})`);
  await until(async()=> (await browserState()).tab?.connection?.state==='certificate-error','TLS confirmation');
  const warning=(await browserState()).tab;
  await evaluate(`api.browser.invoke(${JSON.stringify({action:'security.continue',id:browserId,challengeId:warning.connection.challengeId})})`);
  await until(async()=>!!(await browserState()).tab?.favicon,'favicon in explicitly accepted HTTPS page');
  await until(loadedIcon,'HTTPS favicon decoding');
  await check('accepted HTTPS site loads its icon through the same browser session',(await browserState()).tab.connection.state==='certificate-exception');
  await check('favicon remains isolated from Relay page capabilities',await bounded(contents.executeJavaScript('typeof api==="undefined"&&typeof require==="undefined"'), 'page isolation'));
  await check('renderer has no unexpected errors','uiFixture.errors.length===0');
}).catch(async error=>{report.failures.push(error.stack||String(error));try{await capture('failure');report.browser=await browserState();}catch(_){}}).finally(async()=>{
  clearTimeout(deadline);registry?.dispose();if(win&&!win.isDestroyed())win.destroy();
  for(const listener of [server,secureServer])if(listener){listener.closeAllConnections();await bounded(new Promise(resolve=>listener.close(resolve)), 'close fixture');}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.failures.length?1:0);
});
