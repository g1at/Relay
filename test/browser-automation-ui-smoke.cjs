'use strict';

// Real Relay renderer, IPC, automation service and Chromium. The SDK/model and
// other app services are fixtures; this never reads a real browser profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
const { createBrowserMenuProbe } = require('./browser-menu-test-helper.cjs');
const nativeMenu = createBrowserMenuProbe(require('electron'));
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/browser-automation-ui-smoke');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-automation-ui-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, registry, server;
const report = { ok: false, state: 'running', startedAt: new Date().toISOString(), results: [], failures: [], profileIsolated: true };
const resultFile = path.join(out, 'result.json');
fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
const timeout = setTimeout(() => { report.failures.push('Timed out'); fs.writeFileSync(resultFile, JSON.stringify(report, null, 2)); app.exit(1); }, 60000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source);
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const state = () => evaluate('api.browser.invoke({action:"state"})');
async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await (typeof predicate === 'function' ? predicate() : evaluate(predicate))) return; await pause(30); }
  throw Error('Timed out: ' + label);
}
function check(label, value) { assert.ok(value, label); report.results.push(label); }
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="ui-report.csv"' });
      response.end('name,value\nui-fixture,1\n'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end('<!doctype html><title>Automation UI fixture</title><style>body{font:18px system-ui;padding:30px}input,button{font:inherit;padding:8px}</style><h1>订单查询</h1><label>编号<input id="number"></label><button onclick="document.querySelector(\'#result\').textContent=\'查询结果：\'+document.querySelector(\'#number\').value">查询</button><p id="result">等待查询</p><a href="/download">下载报表</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && !details.url.startsWith(url) })));
  const entry = path.join(out, 'fixture.html'), preload = path.join(out, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{const original=window.api;window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push(message); });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getElectron: nativeMenu.getElectron });
  await win.loadFile(entry); win.show();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns', 'renderer ready');
  await evaluate(`window.browserFixtureTask='task-a';window.browserFixtureDraft=true;window.relayConversationWorkspace=()=>({conversationId:window.browserFixtureTask,title:'浏览器验收',isDraft:window.browserFixtureDraft});window.dispatchEvent(new Event('relay:workdir-changed'));relayWorkspacePanel.openUrl(${JSON.stringify(url)});`);
  await until(async () => (await state()).visible && (await state()).tab?.title === 'Automation UI fixture', 'visible page');
  check('a reserved draft identity does not display task automation controls', await evaluate('document.getElementById("workspaceBrowserAutomation").hidden'));
  await evaluate('window.browserFixtureDraft=false;window.dispatchEvent(new Event("relay:conversation-changed"));');
  await until('!document.getElementById("workspaceBrowserAutomation").hidden', 'automation controls');
  check('creating the task reveals controls without changing its reserved identity', true);
  const id = (await state()).tab.id;
  const workspaceRoot = path.join(profile, 'task-files'); fs.mkdirSync(workspaceRoot);
  const controller = new AbortController();
  const context = { conversationId: 'task-a', runId: 'run-a', signal: controller.signal, workspaceRoot, isCurrent: () => true };
  check('unclaimed user page is not visible to the task tools', (await registry.automationInvoke(context, { action: 'list' })).tabs.length === 0);
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'page claimed');
  check('trusted toolbar binds the existing page to the current task', (await registry.automationInvoke(context, { action: 'list' })).tabs[0]?.id === id);
  let observation = await registry.automationInvoke(context, { action: 'observe', id });
  assert.equal(observation.ok, true, JSON.stringify(observation));
  const field = observation.elements.find(item => item.name === '编号');
  assert.ok(field);
  const filled = await registry.automationInvoke(context, { action: 'act', id, kind: 'fill', observationId: observation.observationId, ref: field.ref, text: 'A-2026' });
  assert.equal(filled.ok, true, JSON.stringify(filled));
  check('service through production IPC-owned host fills the real webpage', filled.observation.elements.some(item => item.name === '编号' && item.value === 'A-2026'));
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="允许继续"', 'takeover');
  const blocked = await registry.automationInvoke(context, { action: 'act', id, kind: 'fill', observationId: filled.observation.observationId, ref: field.ref, text: 'WRONG' });
  check('toolbar takeover stops further AI input', !blocked.ok && blocked.code === 'AUTOMATION_PAUSED');
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'resumed');
  const stale = await registry.automationInvoke(context, { action: 'act', id, kind: 'fill', observationId: filled.observation.observationId, ref: field.ref, text: 'WRONG' });
  check('resuming does not revive old observations', !stale.ok && stale.code === 'BROWSER_OBSERVATION_STALE');
  await until('document.getElementById("workspaceBrowserAutomation").dataset.state==="error"', 'recoverable error');
  check('a recoverable error still offers immediate human takeover', await evaluate('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"'));
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="允许继续"', 'takeover after error');
  check('takeover from error revokes subsequent tool access', (await registry.automationInvoke(context, { action: 'observe', id })).code === 'AUTOMATION_PAUSED');
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'resumed after error');
  observation = await registry.automationInvoke(context, { action: 'observe', id });
  const button = observation.elements.find(item => item.role === 'button' && item.name === '查询');
  const submitted = await registry.automationInvoke(context, { action: 'act', id, kind: 'click', observationId: observation.observationId, ref: button.ref });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const verified = await registry.automationInvoke(context, { action: 'verify', id, text: '查询结果：A-2026' });
  check('resumed workflow verifies its rendered business result', verified.ok && verified.verified);
  await evaluate('document.getElementById("workspaceBrowserAddress").value="relay://browser/history";document.getElementById("workspaceBrowserNav").requestSubmit();');
  await until('document.getElementById("workspaceBrowserAutomation").hidden && document.getElementById("workspaceBrowserAddress").value==="relay://browser/history"', 'internal route');
  await click('workspaceBrowserBack');
  await until('!document.getElementById("workspaceBrowserAutomation").hidden && document.getElementById("workspaceBrowserAutomationControl").textContent==="允许继续"', 'return to paused native page');
  check('manual navigation through an internal page pauses the original webpage', (await registry.automationInvoke(context, { action: 'observe', id })).code === 'AUTOMATION_PAUSED');
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'resume after manual navigation');
  await evaluate(`window.browserFixtureTask='task-b';window.dispatchEvent(new Event('relay:workdir-changed'));`);
  await until('relayWorkspacePanel.getState().tabs.every(tab=>tab.kind!=="browser") && !document.getElementById("workspaceNoTabs").hidden', 'task page isolated');
  await until(async () => !(await state()).visible, 'previous native page hidden');
  check('another task sees neither the previous browser content nor its tab',
    await evaluate('document.getElementById("workspaceBrowser").hidden')
      && (await registry.automationInvoke({ ...context, conversationId: 'task-b' }, { action: 'list' })).tabs.length === 0);
  const backgroundObservation = await registry.automationInvoke(context, { action: 'observe', id });
  check('switching conversations keeps the original task browser running', backgroundObservation.ok && !await evaluate('relayWorkspacePanel.getState().tabs.some(tab=>tab.kind==="browser")'));
  await evaluate(`window.browserFixtureTask='task-a';window.dispatchEvent(new Event('relay:workdir-changed'));`);
  await until('relayWorkspacePanel.getState().tab==="browser" && document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'own task page restored without pause');
  await until(async () => (await state()).visible && (await state()).tab.id === id, 'own native page restored');
  await evaluate('relayWorkspacePanel.close()');
  await until(async () => !(await state()).visible, 'panel collapsed');
  const collapsedObservation = await registry.automationInvoke(context, { action: 'observe', id });
  check('collapsing the sidebar does not become human takeover or reopen the panel', collapsedObservation.ok && !await evaluate('relayWorkspacePanel.getState().open'));
  const hiddenOpen = await registry.automationInvoke(context, { action: 'open', url: url + '?while-collapsed=1' });
  assert.equal(hiddenOpen.ok, true, JSON.stringify(hiddenOpen));
  await until('relayWorkspacePanel.getState().tabs.some(tab=>tab.browserId===' + JSON.stringify(hiddenOpen.tab.id) + ')', 'new background task page registered');
  check('a new AI page respects the same conversation sidebar dismissal', !await evaluate('relayWorkspacePanel.getState().open') && !(await state()).visible);
  const focusedHidden = await registry.automationInvoke(context, { action: 'focus', id: hiddenOpen.tab.id });
  assert.equal(focusedHidden.ok, true, JSON.stringify(focusedHidden));
  await until(async () => (await state()).visible && (await state()).activeId === hiddenOpen.tab.id, 'explicit focus reveals new page');
  check('explicit focus reveals a task page after deliberate sidebar dismissal', await evaluate('relayWorkspacePanel.getState().open'));
  assert.equal((await registry.automationInvoke(context, { action: 'close', id: hiddenOpen.tab.id })).ok, true);
  // The service reply and renderer closed event use different IPC paths. Do
  // not let the just-closed page's old "接管" label satisfy the next step.
  await until('!relayWorkspacePanel.getState().tabs.some(tab=>tab.browserId===' + JSON.stringify(hiddenOpen.tab.id) + ')', 'focused temporary page removed from renderer');
  await evaluate('relayWorkspacePanel.open("browser")');
  await until(async () => {
    const native = await state();
    return native.visible && native.activeId === id && await evaluate(`(() => {
      const panel = relayWorkspacePanel.getState(), active = panel.tabs.find(tab => tab.id === panel.activeId);
      return active?.browserId === ${JSON.stringify(id)} && document.getElementById('workspaceBrowserAutomationControl').textContent === '接管';
    })()`);
  }, 'original task page restored before release');
  await click('workspaceBrowserMore');
  await until(() => nativeMenu.isOpen(), 'native release menu');
  nativeMenu.select('解除与此任务的关联');
  try {
    await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="交给此任务"', 'release');
  } catch (error) {
    report.releaseDiagnostic = { expectedId: id, native: await state(), renderer: await evaluate(`({
      panel: relayWorkspacePanel.getState(), control: document.getElementById('workspaceBrowserAutomationControl').textContent,
      notice: document.getElementById('workspaceBrowserNotice').textContent,
      status: document.getElementById('workspaceBrowserAutomationStatus').textContent
    })`), taskTabs: (await registry.automationInvoke(context, { action: 'list' })).tabs };
    throw error;
  }
  check('release removes the task page capability and updates toolbar', (await registry.automationInvoke(context, { action: 'list' })).tabs.length === 0);
  const createdUrl = url + '?ai=1';
  const opened = await registry.automationInvoke(context, { action: 'open', url: createdUrl });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await until(async () => (await state()).visible && (await state()).activeId === opened.tab.id && !(await state()).tab.loading, 'AI opened tab shown');
  check('AI-created page is revealed inside the current task panel', await evaluate('relayWorkspacePanel.getState().tab==="browser"'));
  const native = win.contentView.children.find(view => view.webContents?.getURL() === createdUrl);
  const geometry = await evaluate('document.getElementById("workspaceBrowserViewport").getBoundingClientRect().toJSON()');
  const bounds = native.getBounds(), scale = win.webContents.getZoomFactor();
  check('native page geometry follows the new toolbar', Math.abs(bounds.y - geometry.y * scale) <= 1 && Math.abs(bounds.height - geometry.height * scale) <= 1);
  check('task controls stay inside the browser toolbar above the page', await evaluate(`(() => {
    const nav = document.getElementById('workspaceBrowserNav'), group = document.getElementById('workspaceBrowserAutomation');
    const viewport = document.getElementById('workspaceBrowserViewport');
    const bounds = nav.getBoundingClientRect(), controls = group.getBoundingClientRect();
    return group.parentElement === nav && controls.top >= bounds.top && controls.bottom <= bounds.bottom
      && Math.abs(viewport.getBoundingClientRect().top - nav.getBoundingClientRect().bottom) <= 1;
  })()`));
  check('icon buttons retain accessible labels and tooltips', await evaluate(`['workspaceBrowserAutomationControl','workspaceBrowserAnnotate'].every(id => {
    const button = document.getElementById(id);
    return (button.getAttribute('aria-label') || button.textContent).trim() && button.title;
  })`));
  report.toolbarLayouts = [];
  for (const [key, label] of [['Home', 'minimum'], ['Enter', 'default'], ['End', 'maximized']]) {
    await evaluate(`document.getElementById('workspaceResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));`);
    await pause(250);
    const layout = await evaluate(`(() => {
      const nav = document.getElementById('workspaceBrowserNav'), rect = nav.getBoundingClientRect();
      const address = document.getElementById('workspaceBrowserAddress').getBoundingClientRect();
      const buttons = ['workspaceBrowserAutomationControl','workspaceBrowserAnnotate','workspaceBrowserMore'].map(id => {
        const button = document.getElementById(id), bounds = button.getBoundingClientRect();
        return { id, x:bounds.x, right:bounds.right, top:bounds.top, bottom:bounds.bottom, width:bounds.width, height:bounds.height,
          hittable:button.contains(document.elementFromPoint(bounds.x + bounds.width/2,bounds.y + bounds.height/2)) };
      });
      return {width:rect.width, height:rect.height, addressWidth:address.width, overflow:nav.scrollWidth-nav.clientWidth,
        fits:buttons.every(button => button.x >= rect.x && button.right <= rect.right && button.top >= rect.top && button.bottom <= rect.bottom && button.width >= 28 && button.height >= 28 && button.hittable),buttons};
    })()`);
    report.toolbarLayouts.push({ label, ...layout });
    check(label + ' panel keeps the address and task buttons visible without overflow', layout.fits && layout.overflow <= 1 && layout.addressWidth >= 50);
    if (label !== 'maximized') {
      fs.writeFileSync(path.join(out, 'toolbar-' + label + '.png'), (await win.webContents.capturePage()).toPNG());
      const header = await evaluate(`(() => {
        const panel = document.getElementById('workspacePanel').getBoundingClientRect();
        const nav = document.getElementById('workspaceBrowserNav').getBoundingClientRect();
        return { x:Math.floor(panel.x), y:Math.floor(panel.y), width:Math.ceil(panel.width), height:Math.ceil(nav.bottom-panel.y) };
      })()`);
      fs.writeFileSync(path.join(out, 'toolbar-' + label + '-detail.png'), (await win.webContents.capturePage(header)).toPNG());
    }
  }
  await evaluate("document.getElementById('workspaceResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  await pause(250);
  fs.writeFileSync(path.join(out, 'controls.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'page.png'), (await native.webContents.capturePage()).toPNG());
  win.webContents.send('browser:event', { type:'task-state-error', id:opened.tab.id, error:'测试磁盘暂不可写', code:'BROWSER_TASK_STATE_WRITE_FAILED' });
  await until('document.getElementById("workspaceBrowserMore").dataset.noticeKind==="persistence-error"', 'persistence notice');
  check('compact controls visibly mark persistence failures and expose their explanation', await evaluate(`(() => {
    const more = document.getElementById('workspaceBrowserMore'), css = getComputedStyle(more,'::after');
    return css.content !== 'none' && css.width === '4px' && css.height === '4px'
      && more.title.includes('网页恢复记录未保存') && more.title.includes('测试磁盘暂不可写')
      && document.getElementById('workspaceBrowserAutomationControl').title.includes('网页恢复记录未保存');
  })()`));
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="允许继续"', 'paused with notice');
  check('pause remains primary while the recovery failure stays discoverable', await evaluate(`document.getElementById('workspaceBrowserAutomationStatus').textContent === '已暂停 · 由你控制'
    && document.getElementById('workspaceBrowserMore').dataset.noticeKind === 'persistence-error'
    && document.getElementById('workspaceBrowserAutomationControl').title.includes('网页恢复记录未保存')`));
  await click('workspaceBrowserMore');
  await until(() => nativeMenu.isOpen(), 'native notice menu');
  check('more menu exposes the failure detail without restoring a toolbar row', nativeMenu.labels().some(label => label.includes('测试磁盘暂不可写')));
  // capturePage records the toolbar, not the separate OS popup.
  fs.writeFileSync(path.join(out, 'toolbar-notice-menu.png'), (await win.webContents.capturePage()).toPNG());
  nativeMenu.close();
  await until('document.getElementById("workspaceBrowserMore").getAttribute("aria-expanded")==="false"', 'native notice menu closed');
  win.webContents.send('browser:event', { type:'task-state-saved', id:opened.tab.id });
  await until('document.getElementById("workspaceBrowserMore").dataset.noticeKind===""', 'persistence notice cleared');
  await click('workspaceBrowserAutomationControl');
  await until('document.getElementById("workspaceBrowserAutomationControl").textContent==="接管"', 'resumed after notice');
  const exportObservation = await registry.automationInvoke(context, { action: 'observe', id: opened.tab.id });
  const exportLink = exportObservation.elements.find(item => item.name === '下载报表');
  assert.ok(exportLink);
  const exported = await registry.automationInvoke(context, { action: 'download', id: opened.tab.id,
    ref: exportLink.ref, observationId: exportObservation.observationId, timeoutMs: 5000 });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  await until('document.getElementById("workspaceBrowserAutomationStatus").textContent.includes("任务目录")', 'task artifact notice');
  check('completed task downloads identify their real storage location in the UI',
    fs.readFileSync(exported.download.path, 'utf8') === 'name,value\nui-fixture,1\n'
      && await evaluate('document.getElementById("workspaceBrowserAutomationStatus").title===' + JSON.stringify(exported.download.path)));
  await registry.automationInvoke(context, { action: 'observe', id: opened.tab.id });
  check('download evidence notice survives later browser state refresh', await evaluate('document.getElementById("workspaceBrowserAutomationStatus").textContent.includes("任务目录")'));
  controller.abort();
  check('aborted task cannot perform new observations', !(await registry.automationInvoke(context, { action: 'observe', id: opened.tab.id })).ok);
  report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform };
}).catch(error => report.failures.push(error.stack || error.message)).finally(async () => {
  clearTimeout(timeout);
  registry?.dispose(); if (win && !win.isDestroyed()) win.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.ok = report.failures.length === 0; report.state = 'complete'; report.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
