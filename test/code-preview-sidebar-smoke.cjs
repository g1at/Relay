'use strict';

// Real production renderer + real browser IPC/Chromium; other Relay services
// use memory fixtures. All web content is served from this process's loopback.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'code-preview-sidebar-smoke');
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
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const original=window.api;const files={'README.md':'# 项目交付说明\\n\\n**已完成**：文件、终端和浏览器。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 页面预览 | 可用 |','app.js':'const ready = true;'};const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/RelayProject',conversationId:c.conversationId}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:200}))}),read:async({path})=>({ok:true,path,content:files[path]}),open:async()=>({ok:true}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return {...nativeBrowser,invoke:async input=>{const result=await nativeBrowser.invoke(input);if(window.delayCodePreview&&input.action==='createPreview'){window.previewPending=true;await new Promise(resolve=>window.releaseCodePreview=resolve);}return result;}};if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry });
  await win.loadFile(entry); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');

  const source = `<!doctype html><meta charset="utf-8"><title>计算器预览</title><style>body{font:16px system-ui;background:#fafafa;padding:24px}button{padding:12px;border:0;border-radius:12px;background:#242424;color:white}article{border:1px solid #eee;border-radius:18px;padding:24px;background:white}p{margin:18px 0}</style><article><h1>计算器</h1><p>查看运行结果 · 查找示例</p><button id="sum" onclick="document.getElementById('result').textContent=21+21">21 + 21</button><p id="result">等待计算</p></article>`;
  const markdown = '完整代码：\n\n```html\n' + source + '\n```';
  await act(`appendMessage('user','直接输出一个计算器');appendMessage('assistant',${JSON.stringify(markdown)});`);
  await check('assistant HTML exposes Relay run and copy chrome', '!!document.querySelector(".message.assistant .code-run")&&!!document.querySelector(".message.assistant .code-copy")');
  await act('document.querySelector(".message.assistant .code-run").click();');
  await until(async () => (await browserState()).tab?.isPreview && (await browserState()).visible, 'native code preview');
  const firstId = (await browserState()).tab.id;
  await until(() => nativeViews().some(item => item.webContents.getURL().startsWith('relay-preview:')), 'native preview navigation');
  let view = nativeViews().find(item => item.webContents.getURL().startsWith('relay-preview:'));
  await until(async () => await view.webContents.executeJavaScript('!!document.getElementById("sum")'));
  await check('run opens one right-sidebar browser instead of an overlay or new window', await evaluate('relayWorkspacePanel.getState().tab==="browser"&&relayWorkspacePanel.getState().tabs.length===1&&!document.querySelector(".code-preview-overlay")') && BrowserWindow.getAllWindows().length === 1);
  await check('HTML executes inside native Chromium', await view.webContents.executeJavaScript('document.getElementById("sum").click();document.getElementById("result").textContent==="42"'));
  await check('preview has no Relay or Node API', await view.webContents.executeJavaScript('typeof window.api==="undefined"&&typeof window.require==="undefined"&&typeof window.process==="undefined"'));
  await until('document.getElementById("workspaceBrowserAddress").value==="代码预览"');
  await check('preview address is concise and bookmark is disabled', 'document.getElementById("workspaceBrowserBookmark").disabled&&document.getElementById("workspaceBrowserAddress").value==="代码预览"');
  win.focus(); win.webContents.focus(); await pause(120);
  await act('document.getElementById("workspaceBrowserAddress").focus();');
  report.addressFocus = await evaluate('({active:document.activeElement.id,value:document.getElementById("workspaceBrowserAddress").value})');
  await check('focusing preview address permits navigation without exposing internal source', 'document.getElementById("workspaceBrowserAddress").value===""');
  await act('document.getElementById("workspaceBrowserAddress").blur();');
  await capture('preview-browser');
  await act('document.querySelector(".message.assistant .code-run").click();');
  await pause(150);
  await check('repeating Run reuses the original preview', (await browserState()).tabs.length === 1 && (await browserState()).tab.id === firstId);
  await until(async () => !(await browserState()).tab.loading);
  await click('workspaceBrowserReload');
  await until(async () => await view.webContents.executeJavaScript('document.getElementById("result")?.textContent==="等待计算"'));
  await check('reload reruns the same in-memory source', (await browserState()).tab.id === firstId);
  await click('workspaceBrowserMore');
  await check('preview disables meaningless URL actions', 'Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).filter(b=>["复制网址","在默认浏览器中打开","收藏此页"].includes(b.textContent)).every(b=>b.disabled)');
  await act('Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).find(b=>b.textContent==="复制标签页").click();');
  await until(async () => (await browserState()).tabs.length === 2 && (await browserState()).tab?.id !== firstId);
  const duplicateId = (await browserState()).tab.id;
  await until(() => nativeViews().some(item => item.webContents !== view.webContents && item.webContents.getURL().startsWith('relay-preview:')), 'duplicate preview navigation');
  const duplicate = nativeViews().find(item => item.webContents !== view.webContents && item.webContents.getURL().startsWith('relay-preview:'));
  await check('duplicate opens the source in another isolated preview', !!duplicate && duplicate.webContents.session !== view.webContents.session);
  await act('document.querySelector("#workspaceTabs .workspace-tab-item.is-active .workspace-tab-close").click();');
  await until(async () => (await browserState()).tabs.length === 1);
  await check('closing duplicate preserves the original', (await browserState()).tab.id === firstId && !view.webContents.isDestroyed());
  await click('workspaceBrowserMore');
  await act('Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).find(b=>b.textContent==="在页面中查找").click();');
  await act('document.getElementById("workspaceBrowserFindInput").value="查找示例";document.getElementById("workspaceBrowserFindInput").dispatchEvent(new Event("input",{bubbles:true}));');
  await until('document.getElementById("workspaceBrowserFindCount").textContent.includes("1")');
  await check('native browser find works for generated HTML', true);
  await click('workspaceBrowserFindClose');
  await click('workspaceMaximize'); await settle();
  await until(async () => (await browserState()).visible);
  await check('preview expands inside the workspace below window chrome', await evaluate('relayWorkspacePanel.getState().maximized&&document.getElementById("workspaceBrowserViewport").getBoundingClientRect().top>=35') && view.getBounds().x >= 0 && view.getBounds().width > 900);
  await capture('preview-expanded');
  await click('workspaceMaximize');
  // Generated code may navigate to a normal webpage; Back must recover the
  // original source instead of leaking an internal URI into the search engine.
  await act(`document.getElementById('workspaceBrowserAddress').value=${JSON.stringify(base + '/')};document.getElementById('workspaceBrowserNav').requestSubmit();`);
  await until(async () => (await browserState()).tab?.url === base + '/' && !(await browserState()).tab?.loading);
  await check('address navigation becomes a normal webpage', !(await browserState()).tab.isPreview);
  await click('workspaceBrowserBack');
  await until(async () => (await browserState()).tab.isPreview && !(await browserState()).tab.loading);
  await check('back restores the generated HTML', await view.webContents.executeJavaScript('!!document.getElementById("sum")'));
  await act('showAppView("settings");');
  await until(async () => !(await browserState()).visible);
  await check('settings hide the native preview surface', !(await browserState()).visible);
  await act('showChatView();');
  await until(async () => (await browserState()).visible);
  await click('workspaceClose');
  await until(async () => !(await browserState()).visible);
  await check('closing panel preserves a reusable preview without history writes', '!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
  await act('document.querySelector(".message.assistant .code-run").click();');
  await until(async () => (await browserState()).visible);
  await check('Run reopens the same tab after closing panel', (await browserState()).tab.id === firstId);
  // Delay only the IPC response while the native created event is live. Closing
  // the panel must win; that late response must not reopen an abandoned preview.
  await act('window.delayCodePreview=true;window.latePreview=relayWorkspacePanel.openCodePreview("<!doctype html><title>late</title><p>late</p>");');
  await until('window.previewPending===true');
  await click('workspaceClose');
  await act('window.delayCodePreview=false;window.releaseCodePreview();');
  await until(async () => (await browserState()).tabs.length === 1);
  await check('late native creation cannot reopen a closed panel', '(async()=>!(await window.latePreview).error&&!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===1)()');

  await act('window.previewPending=false;window.delayCodePreview=true;window.oldContextPreview=relayWorkspacePanel.openCodePreview("<title>跨会话预览</title><p>new context</p>");');
  await until('window.previewPending===true');
  await act('currentConv={id:"preview-other-conversation",title:"另一个会话",turns:[]};emitConversationChanged(currentConv.id);window.delayCodePreview=false;');
  const newContextPreview = await evaluate('relayWorkspacePanel.openCodePreview("<title>跨会话预览</title><p>new context</p>")');
  await act('window.releaseCodePreview();');
  const canceledContextPreview = await evaluate('window.oldContextPreview');
  await until(async () => (await browserState()).tabs.length === 2);
  await check('same code in a new conversation is not tied to an abandoned pending request', newContextPreview.ok && !newContextPreview.canceled && canceledContextPreview.canceled && (await browserState()).tab.id === newContextPreview.id);
  await check('abandoned conversation preview leaves no extra renderer tab', 'relayWorkspacePanel.getState().tabs.filter(t=>t.kind==="browser").length===2');
  await check('preview session and native source do not enter browser history', await (async()=>{const result=await evaluate('api.browser.invoke({action:"history.list"})');return result.ok && result.items.length===0;})());
}).catch(async error => { report.failures.push(error.stack || error.message); try { report.browser = await browserState(); report.native = nativeViews().map(v=>({url:v.webContents.getURL(),historyLength:v.webContents.navigationHistory.length(),back:v.webContents.navigationHistory.canGoBack()})); report.geometry = await evaluate('({width:innerWidth,app:document.querySelector(".app").getBoundingClientRect().toJSON(),panel:document.getElementById("workspacePanel").getBoundingClientRect().toJSON(),state:relayWorkspacePanel.getState()})'); await capture('failure'); } catch (_) {} }).finally(async () => {
  clearTimeout(deadline);
  if (registry) registry.dispose();
  if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.failures.length ? 1 : 0);
});
