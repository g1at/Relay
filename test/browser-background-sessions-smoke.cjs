'use strict';
// Production renderer + IPC + native Chromium, with three concurrent task
// contexts and local reactive pages. No model, real profile or external site.
const { app, BaseWindow, BrowserWindow, webContents, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/browser-background-sessions');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-background-'));
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
let win, registry, server, step = 'startup';
const requests = [], report = { ok: false, checks: [], failures: [], profileIsolated: true, modelDriven: false };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...report, step }, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ev = code => win.webContents.executeJavaScript(code);
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); save(); };
const call = async (ctx, action, input = {}) => {
  step = ctx.conversationId + ':' + action; save();
  const result = await registry.automationInvoke(ctx, { action, ...input });
  assert.equal(result.ok, true, step + ' ' + JSON.stringify({ code: result.code, error: result.error, outcome: result.outcome }));
  return result;
};
async function until(predicate, label) {
  step = label; save(); const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(30); }
  throw Error('Timed out: ' + label);
}
const state = () => ev('api.browser.invoke({action:"state"})');
const panel = () => ev('relayWorkspacePanel.getState()');
const choose = task => ev(`loadConversation(${JSON.stringify(task)})`);
const clickUi = id => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
const timer = setTimeout(() => { report.failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
save();
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    const u = new URL(request.url, 'http://fixture'), task = u.searchParams.get('task') || 'unknown';
    if (u.pathname === '/save') {
      let body = ''; request.on('data', bytes => body += bytes); request.on('end', () => {
        requests.push({ task, body }); setTimeout(() => { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value: body })); }, 120);
      }); return;
    }
    if (u.pathname === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="' + task + '.csv"' });
      response.end('task,value\n' + task + ',background\n'); return;
    }
    if (u.pathname === '/frame') {
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      response.end('<!doctype html><label>Frame field<input id="frame-input"></label><button onclick="document.body.dataset.clicked=1">Frame save</button>'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Workspace ${task}</title><style>
      body{margin:0;background:${({a:'#f0f3f8',b:'#fff2f0',c:'#eff9f2'})[task]||'#f0f3f8'};font:16px system-ui;color:#24324a}header{padding:22px;background:#274887;color:white}
      main{padding:20px}input,button,select{font:inherit;padding:9px;margin:5px}#scroller{height:170px;overflow:auto;background:white}
      .row{padding:14px;border-bottom:1px solid #ddd}iframe{width:90%;height:120px;border:1px solid #aac}dialog{padding:30px}canvas{width:180px;height:70px}
      </style><header>Workspace ${task} <span id="heartbeat"></span></header><main>
      <form id="editor"><label>Record<input id="record"></label><button id="save" type="submit">Save record</button></form>
      <p id="result">Waiting</p><button id="modal" onclick="document.querySelector('dialog').showModal()">Open details</button>
      <dialog><label>Comment<input id="comment"></label><button onclick="window.comment=document.querySelector('#comment').value;this.closest('dialog').close()">Confirm details</button></dialog>
      <label>Attachment<input id="file" type="file" onchange="window.fileName=this.files[0]?.name"></label>
      <a id="download" href="/download?task=${task}">Download report</a>
      <button id="popup" onclick="window.open('/popup?task=${task}','_blank')">Open child</button>
      <div id="scroller">${Array.from({length:120},(_,i)=>'<div class="row">Reactive row '+i+'</div>').join('')}</div>
      <iframe src="/frame?task=${task}" title="Embedded form"></iframe><canvas width="180" height="70"></canvas></main>
      <script>window.audit={saves:0,frames:0};setInterval(()=>document.querySelector('#heartbeat').textContent=String(Date.now()),100);
      (function frame(){audit.frames++;requestAnimationFrame(frame)})();const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#ca5541';c.fillRect(0,0,90,70);c.fillStyle='#54a389';c.fillRect(90,0,90,70);
      document.querySelector('#editor').addEventListener('submit',async e=>{e.preventDefault();audit.saves++;const value=document.querySelector('#record').value;
        const r=await fetch('/save?task=${task}',{method:'POST',body:value});document.querySelector('#result').textContent='Saved: '+(await r.json()).value;
        const old=document.querySelector('#record'),next=old.cloneNode(true);next.value=value;old.replaceWith(next);});</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(base + '/') })));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const fn=(_e,p)=>handler(p);ipcRenderer.on('browser:event',fn);return()=>ipcRenderer.removeListener('browser:event',fn);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const previous=api;window.api=new Proxy(previous,{get(o,k){return k==='browser'?nativeBrowser:o[k]}});window.browserEvents=[];nativeBrowser.onEvent(e=>browserEvents.push(e));})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1260, height: 940, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const getElectron = () => require('electron');
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getElectron });
  await win.loadFile(entry); win.show();
  await until(() => ev('providerRoutingLoaded&&!restoringActiveRuns&&!!relayWorkspacePanel'), 'renderer ready');
  const contexts = {};
  for (const task of ['a','b','c']) {
    const workspaceRoot = path.join(profile, task); fs.mkdirSync(workspaceRoot); fs.writeFileSync(path.join(workspaceRoot, 'attachment.txt'), task);
    contexts[task] = { conversationId: 'task-' + task, runId: 'run-' + task, workspaceRoot, isCurrent: () => true };
  }
  await ev(`Promise.all(['a','b','c'].map(t=>api.history.save({id:'task-'+t,title:'Workspace '+t,mode:'plain',model:'opus',turns:[]})))`);
  const pages = {}, wc = {};
  async function open(task) {
    const previous = new Set(webContents.getAllWebContents());
    const opened = await call(contexts[task], 'open', { url: base + '/?task=' + task }); pages[task] = opened.tab.id;
    const created = webContents.getAllWebContents().filter(contents => !previous.has(contents));
    assert.equal(created.length, 1); wc[task] = created[0];
    const send = wc[task].debugger.sendCommand.bind(wc[task].debugger);
    wc[task].debugger.sendCommand = (method, params, sessionId) => {
      const record = { task, method, type: params?.type, startedAt: Date.now() };
      (report.commands ||= []).push(record);
      return send(method, params, sessionId).then(result => { record.elapsedMs = Date.now() - record.startedAt; record.completed = true; return result; }, error => { record.error = error.message; throw error; });
    };
    await until(async () => await wc[task].executeJavaScript('document.title === ' + JSON.stringify('Workspace '+task)
      + ' && document.readyState === "complete" && !!document.querySelector("#record")'), task + ' loaded');
    return opened;
  }
  async function act(task, kind, locator, extra = {}) {
    const observation = await call(contexts[task], 'observe', { id: pages[task] });
    return call(contexts[task], 'act', { id: pages[task], kind, locator, observationId: observation.observationId, ...extra });
  }
  await choose('task-a'); await open('a');
  await until(async () => (await state()).visible && (await state()).activeId === pages.a, 'a presented');
  await until(async () => {
    const bounds=win.contentView.children.find(view=>view.webContents===wc.a).getBounds();
    const size=await wc.a.executeJavaScript('({width:innerWidth,height:innerHeight})');
    return bounds.width===size.width&&bounds.height===size.height&&bounds.width<800;
  }, 'a viewport applied');
  const originalA = await wc.a.executeJavaScript('({width:innerWidth,height:innerHeight})');
  await choose('task-b');
  await until(async () => !(await state()).visible, 'a hidden after switching task');
  check('switching conversation hides foreign page and tab strip without pausing its task', !(await panel()).tabs.some(tab => tab.browserId === pages.a)
    && (await call(contexts.a, 'list')).tabs[0].state === 'controlled');
  await open('b'); await until(async () => (await state()).visible && (await state()).activeId === pages.b, 'b presented');
  await open('c');
  check('a never-presented background task gets its own usable page without taking over b', (await state()).activeId === pages.b && !(await panel()).tabs.some(tab => tab.browserId === pages.c)
    && (await call(contexts.c, 'list')).tabs[0].presented === false);
  await call(contexts.c,'observe',{id:pages.c});
  check('background native pages have transparent nonfocusable hosts separate from the sidebar', ['a','c'].every(task=>{
    const background=BaseWindow.getAllWindows().find(window=>window.contentView.children.some(view=>view.webContents===wc[task]));
    return background && background!==win && background.getOpacity()===0 && !background.isFocusable() && !background.isFocused()
      && !win.contentView.children.some(view=>view.webContents===wc[task]);
  }));
  check('background render hosts do not become application interface windows', BrowserWindow.getAllWindows().length===1 && BrowserWindow.getAllWindows()[0]===win);
  const sizes = await Promise.all(['a','b','c'].map(task => wc[task].executeJavaScript('({width:innerWidth,height:innerHeight})')));
  report.viewportSizes={originalA,sizes};
  check('hidden pages retain independent viewports including a new default background viewport', sizes[0].width === originalA.width && sizes[0].height === originalA.height && sizes[2].width >= 800 && sizes[2].height >= 600);
  await ev('inputEl.focus();inputEl.value="UNRELATED DRAFT"');
  async function saveRecord(task) {
    await act(task, 'fill', { label:'Record' }, { text:'Value-' + task });
    const saved = await act(task, 'press', { label:'Record' }, { key:'Enter', waitFor:{event:'response',url:base+'/save?task='+task,method:'POST',status:201,timeoutMs:4000} });
    assert.ok(saved.waitResult?.satisfied, task + ' response wait');
    await call(contexts[task], 'wait', { id:pages[task], text:'Saved: Value-'+task, timeoutMs:4000 });
    return wc[task].executeJavaScript('({value:document.querySelector("#record").value,saves:audit.saves})');
  }
  const saved = await Promise.all(['a','b','c'].map(saveRecord));
  check('three conversations can fill and submit reactive forms concurrently exactly once', saved.every((value,index)=>value.value==='Value-'+['a','b','c'][index]&&value.saves===1) && requests.length===3);
  check('background input leaves the foreground conversation and composer untouched', (await state()).activeId===pages.b && await ev('inputEl.value==="UNRELATED DRAFT"&&document.activeElement===inputEl'));
  check('tools reject a foreign page even when its ID is known', (await registry.automationInvoke(contexts.b,{action:'observe',id:pages.a})).code==='TAB_NOT_OWNED');
  await ev('relayWorkspacePanel.close()'); await until(async () => !(await state()).visible, 'panel closed');
  await act('a','click',{css:'#modal'});
  await act('a','fill',{label:'Comment'},{text:'Background modal'});
  await act('a','click',{role:'button',name:'Confirm details'});
  check('hidden page can open fill and confirm a real modal without reopening the panel', await wc.a.executeJavaScript('window.comment==="Background modal"&&!document.querySelector("dialog").open') && !(await panel()).open);
  await act('a','scroll',{css:'#scroller'},{deltaY:500});
  check('background wheel scroll reaches the intended nested scroll container', await wc.a.executeJavaScript('document.querySelector("#scroller").scrollTop>100'));
  const frames = await call(contexts.a,'frames',{id:pages.a});
  const embedded = frames.frames.find(frame => frame.url?.includes('/frame?'));
  assert.ok(embedded, JSON.stringify(frames));
  const observedFrame = await call(contexts.a,'observe',{id:pages.a,frameId:embedded.frameId||embedded.id});
  await call(contexts.a,'act',{id:pages.a,frameId:embedded.frameId||embedded.id,observationId:observedFrame.observationId,kind:'fill',locator:{label:'Frame field'},text:'Inside hidden frame'});
  check('hidden iframe input updates only its own frame', await wc.a.mainFrame.framesInSubtree.find(frame=>frame.url.includes('/frame?')).executeJavaScript('document.querySelector("input").value==="Inside hidden frame"'));
  let observation = await call(contexts.a,'observe',{id:pages.a});
  await call(contexts.a,'upload',{id:pages.a,observationId:observation.observationId,locator:{css:'#file'},files:['attachment.txt']});
  check('task-scoped file upload works with the panel closed', await wc.a.executeJavaScript('window.fileName==="attachment.txt"'));
  observation = await call(contexts.a,'observe',{id:pages.a});
  const downloaded = await call(contexts.a,'download',{id:pages.a,observationId:observation.observationId,locator:{css:'#download'},timeoutMs:4000});
  check('background download is attributed to its originating task', fs.readFileSync(downloaded.download.path,'utf8').includes('a,background') && downloaded.download.path.startsWith(contexts.a.workspaceRoot + path.sep));
  for (const task of ['a','c']) {
    const screenshot = await call(contexts[task],'screenshot',{id:pages[task]});
    const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data,'base64')), bitmap=image.toBitmap(), colors=new Set();
    const ownColor=task==='a'?0xfff0f3f8:0xffeff9f2; let ownPixels=0;
    for(let i=0;i<bitmap.length;i+=4*23) { const color=bitmap.readUInt32LE(i); colors.add(color); if(color===ownColor)ownPixels++; }
    check('background screenshot contains the correct task page for '+task, !image.isEmpty()&&image.getSize().width>200&&colors.size>30&&ownPixels>500);
    fs.writeFileSync(path.join(out,'background-'+task+'.png'),image.toPNG());
  }
  const popup = await act('c','click',{css:'#popup'});
  check('background popup inherits task ownership without taking over foreground UI', popup.openedTabs?.length===1 && popup.openedTabs[0].conversationId===contexts.c.conversationId && !(await panel()).open);
  await choose('task-a'); await ev('relayWorkspacePanel.open()');
  await until(async () => (await state()).visible && (await state()).activeId===pages.a,'a restored in its conversation');
  check('returning to a conversation restores only its own tabs and page state', (await panel()).tabs.filter(tab=>tab.kind==='browser').every(tab=>tab.ownerConversationId==='task-a') && await wc.a.executeJavaScript('document.querySelector("#result").textContent==="Saved: Value-a"'));
  await clickUi('workspaceBrowserAutomationControl');
  check('explicit human takeover still blocks the matching task', (await registry.automationInvoke(contexts.a,{action:'observe',id:pages.a})).code==='AUTOMATION_PAUSED');
  await choose('task-b'); await act('b','fill',{label:'Record'},{text:'Other task continues'});
  check('a paused conversation cannot pause another task or auto-resume after switching', (await registry.automationInvoke(contexts.a,{action:'observe',id:pages.a})).code==='AUTOMATION_PAUSED' && await wc.b.executeJavaScript('document.querySelector("#record").value==="Other task continues"'));
  const failedHost=BaseWindow.getAllWindows().find(window=>window.contentView.children.some(view=>view.webContents===wc.c));
  assert.ok(failedHost && failedHost!==win); failedHost.destroy();
  const interrupted=await registry.automationInvoke(contexts.c,{action:'observe',id:pages.c});
  check('unexpected background host loss pauses its task without claiming human takeover',interrupted.code==='AUTOMATION_PAUSED' && /渲染环境已中断/.test(interrupted.error) && !wc.c.isDestroyed());
  const resumed=await ev(`api.browser.invoke({action:'automation',command:'resume',id:${JSON.stringify(pages.c)},conversationId:'task-c'})`);
  assert.equal(resumed.ok,true,JSON.stringify(resumed));
  await call(contexts.c,'observe',{id:pages.c});
  await act('c','fill',{label:'Record'},{text:'Recovered original page'});
  check('explicit recovery reuses the original page without reloading or replaying its submission',await wc.c.executeJavaScript('document.querySelector("#record").value==="Recovered original page"&&audit.saves===1'));
  // B was deliberately closed before visiting A. Its selected browser belongs
  // to B, but the native host keeps the last presented ID while it is hidden.
  const bPanelAfterRecovery = await panel(), bSelectedAfterRecovery = bPanelAfterRecovery.tabs.find(tab => tab.id === bPanelAfterRecovery.activeId);
  check('recovering a background task preserves the returning conversation sidebar dismissal', !bPanelAfterRecovery.open && !(await state()).visible
    && bSelectedAfterRecovery?.ownerConversationId === 'task-b' && bSelectedAfterRecovery.browserId === pages.b);
  await ev('relayWorkspacePanel.open()');
  await until(async () => (await state()).visible && (await state()).activeId===pages.b, 'b explicitly reopened before minimizing');
  win.minimize(); await until(()=>win.isMinimized(),'owner minimized');
  await act('b','fill',{label:'Record'},{text:'Minimized input'});
  check('active task input continues when the owner window is minimized', await wc.b.executeJavaScript('document.querySelector("#record").value==="Minimized input"'));
  win.restore();
  check('renderer emitted no uncaught errors', (await ev('uiFixture.errors')).length===0);
  report.runtime={electron:process.versions.electron,chromium:process.versions.chrome}; report.requests=requests; report.ok=true;
}).catch(async error=>{
  report.failures.push(error.stack||String(error));
  if(win&&!win.isDestroyed()) {
    report.debug=await Promise.all(BaseWindow.getAllWindows().flatMap(window=>window.contentView.children).filter(view=>view.webContents).map(async view=>({url:view.webContents.getURL(),title:view.webContents.getTitle(),loading:view.webContents.isLoading(),bounds:view.getBounds(),page:await view.webContents.executeJavaScript('({ready:document.readyState,visibility:document.visibilityState,title:document.title,modal:document.querySelector("dialog")?.open,frames:window.audit?.frames,text:document.body?.innerText.slice(0,300)})').catch(()=>null)})));
    report.ui=await ev('({panel:relayWorkspacePanel.getState(),errors:uiFixture.errors,events:browserEvents.slice(-10)})').catch(()=>null);
  }
}).finally(async()=>{
  clearTimeout(timer); registry?.dispose(); if(win&&!win.isDestroyed())win.destroy();
  report.remainingNativeWindows=BaseWindow.getAllWindows().length;
  if(report.remainingNativeWindows!==0){report.ok=false;report.failures.push('background native windows leaked after disposal');}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  step='complete';save();console.log(JSON.stringify(report));app.exit(report.ok?0:1);
});
