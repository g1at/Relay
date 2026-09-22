'use strict';
// Real Relay renderer, browser profile/IPC and Chromium; synthetic conversation
// and a loopback-only page. Native system-browser calls are recorded, not run.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), output = process.env.RELAY_SMOKE_OUTPUT || path.join(root, '.codex-tmp/app-link-routing-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = { checks: {}, errors: [], external: [] };
let win, mini, registry, server, context;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const timer = setTimeout(() => { report.errors.push('timeout'); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await (typeof code === 'function' ? code() : evaluate(code))) return; await pause(30); }
  throw Error('Timed out: ' + code);
}
async function check(name, condition) { report.checks[name] = !!await (typeof condition === 'string' ? evaluate(condition) : condition); save(); if (!report.checks[name]) throw Error(name); }
const invoke = input => evaluate(`api.browser.invoke(${JSON.stringify(input)})`);
async function link(url, action = 'click') {
  await act(`const a=document.getElementById('testLink');a.href=${JSON.stringify(url)};${action === 'middle' ? "a.dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}))" : 'a.click()'};`);
}
async function currentUrl() { return (await invoke({ action: 'state' })).tab?.url; }
app.whenReady().then(async () => {
  server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Relay link fixture</title><h1>Local preview</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const entry = path.join(output, 'fixture.html'), preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),open:url=>ipcRenderer.invoke('shell:open',url),onEvent:fn=>{const h=(_e,p)=>fn(p);ipcRenderer.on('browser:event',h);return()=>ipcRenderer.removeListener('browser:event',h)}});`);
  const fixture = ['ui-api-fixture.js','workspace-api-fixture.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const seed = `(()=>{const original=window.api;window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='openExternal')return nativeBrowser.open;return o[k]}})})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root,'renderer')+path.sep).href}"><script>${fixture}\n${seed}</script>`));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const shell = { ...electron.shell, openExternal: async url => report.external.push(url) };
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getElectron: () => ({ ...electron, shell }) });
  const source = fs.readFileSync(path.join(root, 'src/main/bootstrap.js'), 'utf8');
  const windowSource = fs.readFileSync(path.join(root, 'src/main/app/application-windows.js'), 'utf8').replace(/^  /gm, '');
  context = vm.createContext({ mainWindow: win, pathToFileURL, Promise, require: require('node:module').createRequire(path.join(root, 'src/main/app/application-windows.js')), browserPanelTools: registry,
    showMainWindow: () => win.showInactive(), shell, logger: { warn: (...args) => report.errors.push(args.join(' ')) },
    ipcMain, miniPanelCaller: event => mini && event.sender === mini.webContents && event.senderFrame === event.sender.mainFrame,
  });
  context.browser = { openLink: url => registry.openLink(url) };
  context.applicationWindows = { get mainWindow() { return context.mainWindow; }, openConfiguredWebLink: url => context.openConfiguredWebLink(url) };
  vm.runInContext(windowSource.slice(windowSource.indexOf('async function openConfiguredWebLink('),windowSource.indexOf('// 创建首次设置向导窗口'))+'\n'+source.slice(source.indexOf("ipcMain.handle('shell:open'"),source.indexOf('// IPC: 文件选择对话框')), context);
  context.attachExternalLinkGuard(win, entry);
  win.relayContentReady = win.loadFile(entry); await win.relayContentReady; win.showInactive();
  await until('!!relayWorkspacePanel && providerRoutingLoaded && !restoringActiveRuns');
  await act("const a=document.createElement('a');a.id='testLink';a.textContent='测试网页';a.target='_blank';document.getElementById('messages').append(a);inputEl.value='保留的草稿';");
  await invoke({ action: 'settings.update', settings: { webLinkTarget: 'internal', localLinkTarget: 'internal' } });
  await link(base+'/primary'); await until(async () => await currentUrl() === base+'/primary');
  await check('OrdinaryClickOpensInternalTabAndPreservesConversation', "relayWorkspacePanel.getState().tab==='browser'&&inputEl.value==='保留的草稿'&&!currentConv&&!uiFixture.calls.includes('runClaude')");
  const before = await evaluate('relayWorkspacePanel.getState().tabs.length');
  await link(base+'/middle','middle'); await until(async () => await currentUrl() === base+'/middle');
  await check('MiddleClickOpensExactlyOneInternalTab', `relayWorkspacePanel.getState().tabs.length===${before+1}`);
  await act(`window.open(${JSON.stringify(base+'/native-popup')},'_blank');`); await until(async () => await currentUrl() === base+'/native-popup');
  await check('NativePopupFallbackRevealsInternalTab', "relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tab==='browser'");
  await act(`location.href=${JSON.stringify(base+'/navigation')};`); await until(async () => await currentUrl() === base+'/navigation');
  await check('NativeNavigationFallbackPreservesAppDocument', "location.protocol==='file:'&&!!document.getElementById('input')");
  // Save through the real settings UI, then immediately exercise its destination.
  await evaluate("openSettings('browser')"); await until("document.querySelector('[data-browser-setting=webLinkTarget]')?.disabled===false");
  await act("document.querySelector('[data-browser-setting=webLinkTarget]').click();document.querySelector('.rbs-dropdown:has([data-browser-setting=webLinkTarget]) [data-value=external]').click();");
  await until("document.querySelector('[data-browser-setting=webLinkTarget]').value==='external'&&!document.querySelector('[data-browser-setting=webLinkTarget]').disabled");
  await link('https://example.invalid/configured'); await until(() => report.external.includes('https://example.invalid/configured'));
  await check('SavedWebPreferenceIsAppliedImmediately', report.external.filter(x=>x==='https://example.invalid/configured').length===1);
  await link(base+'/local-independent'); await until(async () => await currentUrl() === base+'/local-independent');
  await check('LocalPreferenceRemainsIndependentFromWebPreference', !report.external.includes(base+'/local-independent'));
  await invoke({ action: 'settings.update', settings: { localLinkTarget: 'external' } });
  await link(base+'/local-external'); await until(() => report.external.includes(base+'/local-external'));
  await invoke({ action: 'settings.update', settings: { localLinkTarget: 'internal', webLinkTarget: 'internal' } });
  // Mini uses production read-only Markdown and the same legacy preload API.
  mini = new BrowserWindow({ width: 500, height: 300, show: false, webPreferences: { preload, sandbox:true,contextIsolation:true,nodeIntegration:false } });
  const miniEntry=path.join(output,'mini.html');fs.writeFileSync(miniEntry,'<!doctype html><meta charset="utf-8"><div id="answer"></div>');await mini.loadFile(miniEntry);
  await mini.webContents.executeJavaScript("window.api={openExternal:nativeBrowser.open};window.relayRenderMarkdown=()=>'<a href=\"'+"+JSON.stringify(base+'/mini')+"+'\">小窗链接</a>';"+fs.readFileSync(path.join(root,'renderer/read-only-markdown.js'),'utf8')+";relayRenderReadOnlyMarkdown(document.getElementById('answer'),'fixture');document.querySelector('a').click();");
  await until(async()=>await currentUrl()===base+'/mini');
  await check('MiniMarkdownLinkUsesMainInternalBrowser', "relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tab==='browser'");
  await invoke({action:'openExternal'}); await check('ExplicitSystemBrowserActionRemainsAvailable',report.external.at(-1)===base+'/mini');
  await until(async()=> (await invoke({action:'state'})).tab?.title==='Relay link fixture');
  await check('RealChromiumLoadedTheLocalPage',win.contentView.children.some(view=>view.webContents?.getURL()===base+'/mini'));
  await check('NoRendererErrors', 'uiFixture.errors.length===0');
  save();
}).catch(error=>{report.errors.push(error.stack);save();process.exitCode=1;}).finally(()=>{
  clearTimeout(timer);registry?.dispose();mini?.destroy();win?.destroy();server?.close();app.exit(process.exitCode||0);
});
