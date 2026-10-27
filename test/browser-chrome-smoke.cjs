'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'browser-chrome-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, registry, server, secureServer;
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
  secureServer = https.createServer({key:fs.readFileSync(path.join(__dirname,'fixtures/browser-tls/localhost.key')),cert:fs.readFileSync(path.join(__dirname,'fixtures/browser-tls/localhost.pem'))},(_request,response)=>{response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end('<!doctype html><title>证书验收页面</title><h1>证书验收页面</h1>');});
  await new Promise(resolve=>secureServer.listen(0,'127.0.0.1',resolve));
  const secureBase=`https://127.0.0.1:${secureServer.address().port}`;
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && !details.url.startsWith(base + '/') && !details.url.startsWith(secureBase + '/') && !details.url.startsWith(base.replace('http:','https:') + '/') })));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.setItem('relay.workspace-panel.width.v1','720');const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1440, height: 960, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerBrowserPanelIpc({ createHost(options) {
    try {
      const host = createBrowserPanelHost(options), invoke = host.invoke;
      host.invoke = async input => {
        try { return await invoke(input); }
        catch (error) { (report.hostDiagnostics ||= []).push({ action: input.action, error: error.stack || String(error) }); throw error; }
      };
      return host;
    } catch (error) { (report.hostDiagnostics ||= []).push({ phase: 'initialize', error: error.stack || String(error) }); throw error; }
  }, ipcMain, getWindow: () => win, entryFile: entry });
  await win.loadFile(entry); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  const inBounds = `(()=>{const panel=document.getElementById('workspacePanel').getBoundingClientRect(),nav=document.getElementById('workspaceBrowserNav').getBoundingClientRect(),viewport=document.getElementById('workspaceBrowserViewport').getBoundingClientRect();return [...document.querySelectorAll('#workspaceBrowserNav button:not([hidden]),#workspaceBrowserAddress')].filter(node=>node.getBoundingClientRect().width>0).every(node=>{const r=node.getBoundingClientRect();return r.left>=panel.left&&r.right<=panel.right&&r.top>=nav.top&&r.bottom<=nav.bottom})&&viewport.top>=nav.bottom-1&&document.documentElement.scrollWidth<=innerWidth})()`;
  await click('btnWorkspacePanel');await act('document.querySelector("[data-workspace-create=browser]").click()');
  await until('relayWorkspacePanel.getState().tab==="browser"');
  await check('browser page is owned by the current conversation', "relayWorkspacePanel.getState().tabs.filter(t=>t.kind==='browser').every(t=>t.ownerConversationId===relayConversationWorkspace().conversationId)");
  await settle();
  report.geometry = await evaluate("(()=>{const rect=e=>e.getBoundingClientRect().toJSON();return{panel:rect(document.getElementById('workspacePanel')),nav:rect(document.getElementById('workspaceBrowserNav')),viewport:rect(document.getElementById('workspaceBrowserViewport')),controls:[...document.querySelectorAll('#workspaceBrowserNav button:not([hidden]),#workspaceBrowserAddress')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({id:e.id,...rect(e)})),windowWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth}})()");
  await check('navigation pill and rounded address stay above the full-width page',inBounds);
  await check('blank page has no false lock indicator',`document.getElementById('workspaceBrowserSiteInfo').dataset.connection==='none'&&document.getElementById('workspaceBrowserSiteInfo').disabled`);
  await act('document.activeElement.blur()');await capture('browser-empty-light');
  await act('document.documentElement.dataset.theme="dark"');await capture('browser-empty-dark');
  await act('document.documentElement.dataset.theme="light"');
  async function navigate(url){await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(url)};document.getElementById('workspaceBrowserNav').requestSubmit()`);}
  await navigate(base+'/');
  await until(async()=> (await browserState()).visible&&(await browserState()).tab?.title==='项目交付预览');
  await check('HTTP connection shows unencrypted information rather than a secure lock',`document.getElementById('workspaceBrowserSiteInfo').dataset.connection==='http'&&document.getElementById('workspaceBrowserSiteInfo').title.includes('未加密')`);
  await click('workspaceBrowserSiteInfo');
  await check('site information explains HTTP connection',`document.getElementById('workspaceBrowserMenu').textContent.includes('HTTP，连接未加密')`);
  await click('workspaceBrowserSiteInfo');
  await act(`document.getElementById('workspaceBrowserAddress').focus();document.getElementById('workspaceBrowserAddress').blur()`);
  await navigate(secureBase+'/');
  await until(async()=> (await browserState()).tab?.connection?.state==='certificate-error','real TLS failure reaches renderer');
  await until(`!document.getElementById('workspaceBrowserError').hidden&&!document.getElementById('workspaceBrowserCertificateContinue').hidden`,'certificate controls');
  await until(async()=> !(await browserState()).visible,'native view hidden under connection card');
  await check('real certificate failure has an explanation and explicit continue control',`document.getElementById('workspaceBrowserErrorTitle').textContent.includes('证书无法验证')&&document.getElementById('workspaceBrowserErrorConsent').textContent.includes('本次浏览会话')`);
  await check('certificate controls remain above the hidden native page',inBounds);await capture('browser-certificate-light');
  await act('document.documentElement.dataset.theme="dark";document.getElementById("workspaceResizeHandle").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');await settle();
  await check('minimum width keeps address and connection actions inside the panel',inBounds+`&&(()=>{const e=document.getElementById('workspaceBrowserError'),r=e.getBoundingClientRect();return [...e.querySelectorAll('button:not([hidden])')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right})})()`);
  await capture('browser-certificate-dark-narrow');await click('workspaceBrowserCertificateContinue');
  await until(async()=> (await browserState()).visible&&(await browserState()).tab?.title==='证书验收页面','explicit certificate consent loads native page');
  await check('approved certificate retains its exception indicator',`document.getElementById('workspaceBrowserSiteInfo').dataset.connection==='certificate-exception'&&document.getElementById('workspaceBrowserError').hidden`);
  await capture('browser-exception-dark-narrow');
  await navigate(base.replace('http:','https:')+'/');
  await until(`!document.getElementById('workspaceBrowserError').hidden&&!document.getElementById('workspaceBrowserUseHttp').hidden`,'HTTPS to plaintext site fails without downgrade');
  await check('HTTP fallback requires an explicit unencrypted action',`document.getElementById('workspaceBrowserUseHttp').textContent.includes('未加密')`);await click('workspaceBrowserUseHttp');
  await until(async()=> (await browserState()).visible&&(await browserState()).tab?.url===base+'/','explicit HTTP navigation');
  await check('HTTP recovery restores page and correct connection state',`document.getElementById('workspaceBrowserError').hidden&&document.getElementById('workspaceBrowserSiteInfo').dataset.connection==='http'`);
  await check('renderer has no unexpected errors','uiFixture.errors.length===0');
}).catch(async error=>{report.failures.push(error.stack||String(error));try{await capture('failure');report.browser=await browserState();}catch(_){}}).finally(async()=>{
  clearTimeout(deadline);registry?.dispose();if(win&&!win.isDestroyed())win.destroy();
  for(const listener of [server,secureServer])if(listener){listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.failures.length?1:0);
});
