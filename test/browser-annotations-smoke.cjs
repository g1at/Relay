'use strict';
// Real renderer, browser IPC/host, sandbox preload and native input. Model and
// saved conversations are isolated fixtures; no user profile or remote service.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/browser-annotations-smoke');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-annotations-')), taskRoot = path.join(profile, 'task-files');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(taskRoot, { recursive: true }); app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
let win, server, registry, step = 'starting'; const report = { ok: false, results: [], failures: [], profileIsolated: true };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...report, step }, null, 2)); save();
const timeout = setTimeout(() => { report.failures.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ev = code => win.webContents.executeJavaScript(code);
async function until(predicate, label) { step = label; save(); const end = Date.now() + 10000; while (Date.now() < end) { if (await (typeof predicate === 'function' ? predicate() : ev(predicate))) return; await delay(30); } throw Error('Timed out: ' + label); }
function check(label, value) { assert.ok(value, label); report.results.push(label); save(); }
const click = id => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
const state = () => ev('api.browser.invoke({action:"state"})');
async function choose(mode) {
  await ev('window.browserInvokeResults=[]');
  await click('workspaceBrowserAnnotate');
  await ev(`Array.from(document.querySelectorAll('#workspaceBrowserMenu button')).find(b=>b.textContent.includes(${JSON.stringify(mode === 'element' ? '选择页面元素' : '框选页面区域')})).click()`);
  await until('browserInvokeResults.some(call=>call.input.action==="annotation.start"&&call.input.mode===' + JSON.stringify(mode) + '&&call.result?.ok)', 'annotation picker starts for ' + mode);
  await until(async () => (await state()).visible, 'native page is visible for picking');
  const started = await ev('browserInvokeResults.find(call=>call.input.action==="annotation.start"&&call.result?.ok).result');
  const ready = report.pageAnnotationSignals.find(signal => signal.type === 'annotation-ready' && signal.requestId === started.requestId);
  assert.ok(ready, 'annotation start returned before the page acknowledged readiness');
  assert.deepEqual(started.viewport, ready.viewport, 'host and preload must agree on the exact viewport');
}
function input(wc, type, x, y) { const zoom = wc.getZoomFactor(); wc.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1 }); }
async function select(native, mode) {
  native.webContents.focus();
  if (mode === 'element') {
    const rect = await native.webContents.executeJavaScript('document.getElementById("save").getBoundingClientRect().toJSON()');
    input(native.webContents, 'mouseMove', rect.x + 10, rect.y + 10); input(native.webContents, 'mouseDown', rect.x + 10, rect.y + 10); input(native.webContents, 'mouseUp', rect.x + 10, rect.y + 10);
  } else { input(native.webContents, 'mouseMove', 20, 20); input(native.webContents, 'mouseDown', 20, 20); input(native.webContents, 'mouseMove', 200, 130); input(native.webContents, 'mouseUp', 200, 130); }
  await until('!!document.querySelector(".browser-feedback-dialog[open] .browser-feedback-comment")', 'host capture reaches feedback editor for ' + mode);
  await until('document.querySelector(".browser-feedback-image")?.naturalWidth>0', 'captured screenshot renders');
}
app.whenReady().then(async () => {
  server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); response.end('<!doctype html><title>Annotation fixture</title><style>body{font:18px system-ui;padding:25px}button{padding:15px;font:inherit}</style><h1>检查设置页面</h1><p>请选择按钮，页面应保持原状。</p><button id="save" onclick="window.saved=true">保存设置</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && !details.url.startsWith(url) })));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const original=window.api;window.browserInvokeResults=[];const browser={invoke:async input=>{const result=await nativeBrowser.invoke(input);browserInvokeResults.push({time:performance.now(),input,result:result&&result.dataUrl?{...result,dataUrl:'[image omitted]'}:result});return result;},onEvent:handler=>nativeBrowser.onEvent(handler)};window.submissionStates=[];window.submissionArguments=[];const submissionState=async()=>{const s=await nativeBrowser.invoke({action:'state'});return nativeBrowser.invoke({action:'automation',command:'state',id:s.tab?.id});};window.api=new Proxy(original,{get(o,k){if(k==='browser')return browser;if(k==='runClaude')return async(...args)=>{submissionStates.push(await submissionState());submissionArguments.push(args);return o.runClaude(...args);};if(k==='steerClaude')return async input=>{submissionStates.push(await submissionState());submissionArguments.push(input);return{ok:true,input:{id:input.messageId,text:input.prompt,files:input.files,status:'applied',ts:new Date().toISOString(),followUpMode:input.followUpMode,presentation:input.presentation}};};return o[k];}});window.annotationEvents=[];nativeBrowser.onEvent(event=>{if(event.type.startsWith('annotation'))annotationEvents.push({...event,receivedAt:performance.now()});});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1220, height: 850, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getConversationContext: async id => id === 'task-a' || id === 'task-b' ? { cwd: taskRoot } : null });
  await win.loadFile(entry); win.show(); await until('providerRoutingLoaded&&!restoringActiveRuns&&!!relayWorkspacePanel', 'renderer ready');
  await ev(`Promise.all(['task-a','task-b'].map(id=>api.history.save({id,title:id,mode:'plain',model:'opus',turns:[]})))`);
  await ev('loadConversation("task-a")'); await ev(`relayWorkspacePanel.openUrl(${JSON.stringify(url)})`);
  await until(async () => (await state()).visible && (await state()).tab?.title === 'Annotation fixture', 'page ready');
  await click('workspaceBrowserAutomationControl'); await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'task ownership claimed');
  const id = (await state()).tab.id, native = win.contentView.children.find(view => view.webContents?.getURL() === url); assert.ok(native);
  report.pageAnnotationSignals = [];
  native.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel === 'browser:page-event' && ['annotation', 'annotation-cancel', 'annotation-ready'].includes(payload?.type)) report.pageAnnotationSignals.push({ time: Date.now(), type: payload.type, requestId: payload.requestId, reason: payload.reason, revision: payload.revision, viewport: payload.viewport });
  });
  const context = { conversationId: 'task-a', runId: 'run-a', workspaceRoot: taskRoot, isCurrent: () => true };
  await ev('inputEl.value="原有草稿";inputEl.dispatchEvent(new Event("input",{bubbles:true}));window.baselineRunCalls=uiFixture.calls.filter(c=>c==="runClaude").length;');
  // Exercise the last-pixel panel animation that previously raced annotation.start.
  // The real renderer must wait for this animation and native geometry ACK; the
  // test does not wait for it or change the product's selection timing.
  await ev('(()=>{const v=document.getElementById("workspaceBrowserViewport"),w=v.getBoundingClientRect().width;window.annotationGeometryMotion=v.animate([{width:(w-1)+"px"},{width:w+"px"}],{duration:220});})()');
  await choose('element');
  check('annotation start waits for live parent geometry motion and exact native readiness', await ev('annotationGeometryMotion.playState==="finished"'));
  await select(native, 'element');
  const elementEvent = await ev('annotationEvents.find(e=>e.type==="annotation")');
  check('real host captures selected element and saves PNG under task directory', elementEvent.selection.selector === '#save' && fs.existsSync(elementEvent.screenshot.path) && path.resolve(elementEvent.screenshot.path).startsWith(taskRoot + path.sep) && fs.readFileSync(elementEvent.screenshot.path).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  check('picking an element does not activate the underlying page action', !(await native.webContents.executeJavaScript('Boolean(window.saved)')));
  await ev('document.querySelector(".browser-feedback-comment").value="检查保存按钮的遮挡";document.querySelector(".browser-feedback-primary").click();');
  check('element feedback appends to current draft and includes real screenshot attachment', await ev('inputEl.value.startsWith("原有草稿")&&inputEl.value.includes("#save")&&inputEl.value.includes("检查保存按钮的遮挡")&&attachedFiles.length===1&&attachedFiles[0].path===annotationEvents.find(e=>e.type==="annotation").screenshot.path'));
  check('feedback remains a draft with no automatic model submission', await ev('uiFixture.calls.filter(c=>c==="runClaude").length===baselineRunCalls'));
  await until(async () => (await state()).visible, 'page returns after dialog');
  await choose('region');
  check('feedback confirmation and subsequent selection keep the native viewport unchanged', await ev('!document.getElementById("workspaceBrowserNotice").textContent&&browserInvokeResults.filter(c=>c.input.action==="setBounds").every(c=>c.input.rect.height===' + elementEvent.selection.viewport.height + ')'));
  await select(native, 'region');
  check('region picker reports viewport geometry', await ev('annotationEvents.filter(e=>e.type==="annotation").at(-1).selection.kind==="region"&&annotationEvents.filter(e=>e.type==="annotation").at(-1).selection.rect.width>=170'));
  await ev('document.querySelector(".browser-feedback-comment").value="这块区域需要检查";');
  await ev('loadConversation("task-b")');
  await ev('document.querySelector(".browser-feedback-primary").click();');
  check('switching tasks blocks feedback from crossing into the new composer', await ev('!inputEl.value&&!attachedFiles.length&&document.querySelector(".browser-feedback-status").textContent.includes("已切换对话")'));
  await ev('document.querySelector(".browser-feedback-actions button").click();'); await ev('loadConversation("task-a")');
  check('original task draft survives the task switch', await ev('inputEl.value.includes("检查保存按钮的遮挡")&&attachedFiles.length===1'));
  await until(async () => (await state()).visible, 'original page visible');
  await choose('region'); await select(native, 'region');
  await ev('document.querySelector(".browser-feedback-comment").value="检查区域布局";document.querySelector(".browser-feedback-primary").click();');
  check('region feedback follows the same complete draft and attachment path', await ev('inputEl.value.includes("框选区域")&&inputEl.value.includes("检查区域布局")&&attachedFiles.length===2&&uiFixture.calls.filter(c=>c==="runClaude").length===baselineRunCalls'));
  await until(async () => (await state()).visible, 'page visible after second feedback');
  check('feedback added while previously paused cannot grant resume authority', !await ev('readComposerDraft().browserFeedbackResumes.some(item=>item.text.includes("检查区域布局"))'));
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'explicitly resume a page paused by task switching');
  const verified = await registry.automationInvoke(context, { action: 'verify', id, text: 'THIS RESULT DOES NOT EXIST' });
  assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.verified, false);
  await ev(`(()=>{const s=RelayActivity.createState();RelayActivity.ingest(s,{type:'assistant',message:{content:[{type:'tool_use',id:'real-verify',name:'mcp__relay-browser__verify',input:{}}]}});RelayActivity.ingest(s,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'real-verify',content:${JSON.stringify(JSON.stringify(verified))}}]}});const holder=document.createElement('div');holder.id='real-browser-verdict';holder.append(RelayActivity.createElement(s,{collapseOnComplete:false}));document.getElementById('messages').append(holder);window.realBrowserVerdict=s;})()`);
  check('real verify false renders a failed business verdict despite successful tool transport', await ev('realBrowserVerdict.items[0].status==="error"&&document.querySelector("#real-browser-verdict .process-browser-result.is-error").textContent.includes("未通过核验")'));
  fs.writeFileSync(path.join(out, 'annotation-draft-and-verdict.png'), (await win.webContents.capturePage()).toPNG());
  check('browser annotation page has no exposed bridge', await native.webContents.executeJavaScript('typeof window.api==="undefined"&&typeof window.nativeBrowser==="undefined"&&typeof window.require==="undefined"'));
  const errors = await ev('uiFixture.errors'); check('renderer did not emit uncaught errors', errors.length === 0);
  // Use the actual composer send and steering paths. The model itself remains
  // a fixture, while authority, native page, renderer, IPC and captures are real.
  await choose('element'); await select(native, 'element');
  check('AI-controlled selection clearly offers resume on sending the feedback', await ev('document.querySelector(".browser-feedback-resume input")?.checked===true'));
  await ev('document.querySelector(".browser-feedback-comment").value="发送后检查保存按钮";document.querySelector(".browser-feedback-primary").click()');
  check('adding feedback alone keeps real automation paused', (await registry.automationInvoke(context, { action: 'observe', id })).code === 'AUTOMATION_PAUSED');
  const sentFeedback = await ev('send()'); assert.equal(sentFeedback.ok, true, JSON.stringify(sentFeedback));
  check('real composer send resumes its exact page before the model request', await ev('submissionStates.length===1&&submissionStates[0].state==="controlled"'));
  await until(async () => (await state()).visible, 'page visible after feedback submission');
  const afterFeedback = await registry.automationInvoke(context, { action: 'observe', id }); assert.equal(afterFeedback.ok, true, JSON.stringify(afterFeedback));
  check('fresh real observation works after sending feedback without a manual resume call', !!afterFeedback.observationId);
  await choose('region'); await select(native, 'region');
  await ev('document.querySelector(".browser-feedback-comment").value="执行过程中补充此区域";document.querySelector(".browser-feedback-primary").click()');
  const steeredFeedback = await ev('send()'); assert.equal(steeredFeedback.ok, true, JSON.stringify(steeredFeedback));
  check('running-task feedback resumes before steering the same model run', await ev('submissionStates.length===2&&submissionStates[1].state==="controlled"&&uiFixture.calls.filter(c=>c==="runClaude").length===baselineRunCalls+1'));
  check('feedback authority remains outside model arguments and saved user history', await ev('!JSON.stringify(submissionArguments).includes("controlRevision")&&!JSON.stringify(submissionArguments).includes("browserResume")&&!JSON.stringify(currentConv.turns).includes("browserFeedbackResumes")'));
  await ev('uiFixture.emit("onEvent",{jobId:uiFixture.runId,type:"job-done",exitCode:0,finalResult:{type:"result",subtype:"success",result:"合成模型已接收反馈"}})');
  await until('!isConvRunning("task-a")', 'fixture model submission completes');
  for (const factor of [1.25, 1.5]) {
    const zoomed = await ev(`api.browser.invoke({action:'zoom',id:${JSON.stringify(id)},factor:${factor}})`); assert.equal(zoomed.ok, true, JSON.stringify(zoomed));
    await choose('element'); await select(native, 'element');
    const viewport = await native.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    const selected = await ev('annotationEvents.filter(event=>event.type==="annotation").at(-1)');
    check(`annotation readiness and real element capture work at ${Math.round(factor * 100)}% page zoom`, selected.selection.selector === '#save' && JSON.stringify(selected.selection.viewport) === JSON.stringify(viewport) && fs.existsSync(selected.screenshot.path));
    await ev('document.querySelector(".browser-feedback-actions button").click()');
    await until(async () => (await state()).visible, 'page returns after zoom feedback');
  }
  const resetZoom = await ev(`api.browser.invoke({action:'zoom',id:${JSON.stringify(id)},factor:1})`); assert.equal(resetZoom.ok, true);
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'explicitly resume after manual zoom');
  report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome }; report.evidencePaths = await ev('annotationEvents.filter(e=>e.type==="annotation").map(e=>e.screenshot.path)');
  const beforeRestart = await registry.automationInvoke(context, { action: 'observe', id }); assert.equal(beforeRestart.ok, true, JSON.stringify(beforeRestart));
  registry.dispose(); win.destroy(); registry = null; win = null;
  win = new BrowserWindow({ width: 1220, height: 850, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getConversationContext: async conversationId => conversationId === 'task-a' ? { cwd: taskRoot } : null });
  await win.loadFile(entry); win.show(); await until('providerRoutingLoaded&&!restoringActiveRuns&&!!relayWorkspacePanel', 'new renderer ready');
  await ev(`api.history.save({id:'task-a',title:'task-a',mode:'plain',model:'opus',turns:[]})`); await ev('loadConversation("task-a")');
  await ev('relayWorkspacePanel.openUrl("about:blank")'); await click('workspaceBrowserMore');
  await ev('Array.from(document.querySelectorAll("#workspaceBrowserMenu button")).find(b=>b.textContent.includes("恢复此任务的网页")).click()');
  await until('!!document.querySelector(".browser-feedback-pages li")&&!!document.querySelector(".browser-feedback-primary")', 'persisted task pages appear in recovery dialog');
  check('a fresh renderer and browser service read saved task pages from disk', await ev('document.querySelector(".browser-feedback-pages").textContent.includes("Annotation fixture")'));
  await ev('document.querySelector(".browser-feedback-primary").click()');
  await until(async () => { const s = await state(); return s.visible && s.tab?.url === url && !s.tab.loading; }, 'restored task page loads');
  const recoveredId = (await state()).tab.id;
  check('recovery rebuilds a distinct page and keeps real automation paused', recoveredId !== id && (await registry.automationInvoke(context, { action: 'observe', id: recoveredId })).code === 'AUTOMATION_PAUSED');
  check('restored page visibly requires permission to continue', await ev('document.getElementById("workspaceBrowserAutomationControl").textContent==="允许继续"'));
  await click('workspaceBrowserAutomationControl'); await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'recovered page resumed');
  const stale = await registry.automationInvoke(context, { action: 'act', id: recoveredId, kind: 'click', observationId: beforeRestart.observationId, locator: { css: '#save' } });
  check('restoring and resuming never revives a pre-restart observation', !stale.ok && stale.code === 'BROWSER_OBSERVATION_STALE');
  const afterRestart = await registry.automationInvoke(context, { action: 'observe', id: recoveredId });
  check('a fresh observation is available after explicit user resume', afterRestart.ok && afterRestart.observationId !== beforeRestart.observationId);

}).catch(async error => {
  report.failures.push(error.stack || error.message);
  try { report.diagnostics = await ev(`(async()=>({notice:document.getElementById('workspaceBrowserNotice')?.textContent,context:relayConversationWorkspace(),browser:await api.browser.invoke({action:'state'}),calls:browserInvokeResults.slice(-40),events:annotationEvents.map(({screenshot,...rest})=>({...rest,screenshot:screenshot&&{path:screenshot.path,bytes:screenshot.bytes}})),uiErrors:uiFixture.errors}))()`); } catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
  try { report.pageGeometry = await Promise.all(win.contentView.children.filter(view => !view.webContents?.isDestroyed()).map(async view => ({ bounds: view.getBounds(), zoom: view.webContents.getZoomFactor(), viewport: await view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,visible:document.visibilityState})') }))); } catch (error) { report.pageGeometryError = error.message; }
  try { fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
}).finally(async () => {
  clearTimeout(timeout); registry?.dispose(); if (win && !win.isDestroyed()) win.destroy(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.ok = report.failures.length === 0; step = 'complete'; save(); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
