'use strict';
// Production renderer layout/state functions + actual Electron views. This test
// exercises UI presentation lifecycles, not model-driven website completion.
const { BaseWindow, app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserProfileStore } = require('../src/main/browser/browser-profile-store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-presentation-'));
const output = path.join(__dirname, '../.codex-tmp/browser-presentation-lifecycle'); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(tmp, 'user-data')); app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let owner, host, server;
const report = { ok: false, modelDriven: false, checks: [] };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('[pass]', name); save(); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { report.error = '60s deadline'; save(); app.exit(1); }, 60000);
function slice(source, begin, end) { const start = source.indexOf(begin), finish = source.indexOf(end, start); assert.ok(start >= 0 && finish > start); return source.slice(start, finish); }
app.whenReady().then(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Native page ' + req.url + '</title><h1>Page ' + req.url + '</h1><input aria-label="Record note"><button>Save</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  owner = new BrowserWindow({ width: 1240, height: 900, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  // Only this isolated local test owner has Node enabled; production remote tabs
  // use the unmodified sandboxed host implementation.
  await owner.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>
    body{margin:0;font:16px system-ui;background:#eef1f5}#workspaceBrowserViewport{position:absolute;left:650px;top:100px;width:540px;height:650px;background:white}
    #chatMenu{position:absolute;left:80px;top:140px;width:180px;height:150px;background:#ddd;z-index:10}
    #modal{position:absolute;left:50px;top:100px;width:300px;height:200px;background:#fff;z-index:20}
    [hidden]{display:none!important}
    </style><div class="app" data-view="chat"><h2>Conversation panel</h2><div id="workspaceBrowserViewport"></div><div id="workspaceBrowserCover" hidden></div>
    <div id="workspaceBrowserAutomation"><span id="workspaceBrowserAutomationStatus"></span><button id="workspaceBrowserAutomationControl"></button><button id="workspaceBrowserAnnotate"></button></div><button id="workspaceBrowserMore">More</button>
    <div id="chatMenu" role="menu" hidden>Chat menu</div><div id="modal" role="dialog" aria-modal="true" hidden>Real modal</div></div>`));
  owner.show(); owner.focus();
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, profile: createBrowserProfileStore({ rootDir: path.join(tmp, 'browser-profile') }) });
  const a = (await host.invoke({ action: 'create', url: base + '/a', conversationId: 'task-a' })).tab;
  const b = (await host.invoke({ action: 'create', url: base + '/b', conversationId: 'task-b' })).tab;
  const c = (await host.invoke({ action: 'create', url: base + '/c', conversationId: 'task-a' })).tab;
  ipcMain.handle('test:presentation', (event, input) => { assert.equal(event.sender, owner.webContents); return host.invoke(input); });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
  const production = slice(source, '  function renderBrowserAutomation()', '  async function browserAutomationControl(')
    + slice(source, '  function visibleElement(', '  function renderBrowserSnapshot(');
  const evalUi = code => owner.webContents.executeJavaScript(code);
  await evalUi(`(() => {
    const $ = id => document.getElementById(id), app = document.querySelector('.app');
    const browserBridge = {invoke: input => require('electron').ipcRenderer.invoke('test:presentation', input)};
    const browserAutomationStates = new Map(), browserAutomationRequested = new Set(), closedBrowserIds = new Set();
    const browserPresentationDismissed = new Set();
    const browserTabStatus = {get: () => ({label:'Old feedback notice',detail:'Old feedback detail',kind:'feedback'})};
    let context = {conversationId:'task-a'}, item = null, activeId = null, opened = true, tab = 'browser', disposed = false, contextLoading = false;
    let nativeActiveId = null, nativeSignature = '', nativeEpoch = 0, nativeChain = Promise.resolve();
    const obscured = new Set(), activeTab = () => item, pages = new Map();
    const errors = []; const assertResult = result => { if (!result?.ok) throw Error(result?.error || 'Failed'); return result; };
    function browserNotice(error) { errors.push(error); }
    function scheduleCapture() {} function renderBrowserSnapshot() {} function scheduleNative() { syncNative(); }
    function browserTab(id) { return pages.get(id); }
    function tabInContext(value) { return value.browserConversationId === context.conversationId; }
    function renderTabs() {}
    function reconcileBrowserTabs() { if(item && !tabInContext(item)){item=null;activeId=null;} syncNative(); }
    function applyBrowserState(state, conversationId) {
      let entry=pages.get(state.id);
      if(!entry){entry={id:state.id,kind:'browser',browserId:state.id};pages.set(state.id,entry);}
      entry.browser=state; entry.browserConversationId=state.ownerConversationId ?? conversationId ?? entry.browserConversationId;
      return entry;
    }
    function showBrowserTab(state) { const entry=applyBrowserState(state); if(!tabInContext(entry))return; item=entry;activeId=entry.id; opened=true; tab='browser'; syncNative(); }
    ${production}
    window.testUi = {
      async flush() { syncNative(); await nativeChain; if(errors.length) throw Error(errors.join(';')); },
      async present(event) { const result=presentAutomationTab(event); await nativeChain; return result; },
      overlay(id, visible, left) { const el=$(id); el.hidden=!visible; if(left!==undefined)el.style.left=left+'px'; overlayCandidates=null; },
      merge:mergeBrowserAutomationState,
      status() { renderBrowserAutomation(); return {state:browserAutomationStates.get(item?.browserId),label:$('workspaceBrowserAutomationStatus').textContent,button:$('workspaceBrowserAutomationControl').textContent}; },
      active:()=>item?.browserId, view(name){app.dataset.view=name;}, close(id){closedBrowserIds.add(id);browserAutomationStates.delete(id);},
      collapse(){opened=false;browserPresentationDismissed.add(context.conversationId);},
      async captureStatus(){return {desired:nativeDesired(),active:nativeActiveId,errors}},
    };
  })()`);
  const ui = async code => { const result = await evalUi(code); await evalUi('testUi.flush()'); return result; };
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', tab: { ...a, revision: 1 } }) + ')');
  check('current task presentation reaches real native page', host.getAutomationTarget(a.id).presented);
  await ui('testUi.overlay("chatMenu",true,80)');
  check('opening a chat-only menu leaves real native page presented', host.getAutomationTarget(a.id).presented);
  await ui('testUi.overlay("chatMenu",true,600)');
  check('moving the menu across the browser edge hides the native view', !host.getAutomationTarget(a.id).presented);
  await ui('testUi.overlay("chatMenu",false)');
  check('closing overlapping menu restores native view without model retry', host.getAutomationTarget(a.id).presented);
  await ui('testUi.overlay("modal",true)');
  check('actual modal blocks native view even when its box is in chat', !host.getAutomationTarget(a.id).presented);
  await ui('testUi.overlay("modal",false)');
  check('closing actual modal restores native view', host.getAutomationTarget(a.id).presented);
  await ui('testUi.collapse()');
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', tab: { ...a, revision: 1 } }) + ')');
  check('ordinary repeat presentation leaves a deliberately collapsed sidebar closed', !host.getAutomationTarget(a.id).presented);
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', reveal: true, tab: { ...a, revision: 1 } }) + ')');
  check('explicit task focus can reveal the collapsed sidebar', host.getAutomationTarget(a.id).presented);
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-b', tab: { ...b, revision: 2 } }) + ')');
  check('background task request cannot replace visible native tab', host.getAutomationTarget(a.id).presented && !host.getAutomationTarget(b.id).presented && await evalUi('testUi.active()') === a.id);
  await ui('testUi.view("settings")');
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', reveal: true, tab: { ...c, revision: 3 } }) + ')');
  check('same-task request cannot switch settings back to chat', await evalUi('document.querySelector(".app").dataset.view') === 'settings' && await evalUi('testUi.active()') === a.id && !host.getAutomationTarget(c.id).presented);
  await ui('testUi.view("chat")');
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', reveal: true, tab: { ...c, revision: 3 } }) + ')');
  check('same-task focus switches renderer and native page together', !host.getAutomationTarget(a.id).presented && host.getAutomationTarget(c.id).presented && await evalUi('testUi.active()') === c.id);
  const state = { id: c.id, conversationId: 'task-a' };
  await evalUi('testUi.merge(' + JSON.stringify({ ...state, state: 'controlled', revision: 10 }) + ')');
  await evalUi('testUi.merge(' + JSON.stringify({ ...state, state: 'paused', reason: 'Human takeover', revision: 12 }) + ')');
  await evalUi('testUi.merge(' + JSON.stringify({ ...state, state: 'controlled', revision: 11 }) + ')');
  const status = await evalUi('testUi.status()');
  check('late resume reply cannot overwrite real rendered pause state or button', status.state.state === 'paused' && status.label === '已暂停 · 由你控制' && status.button === '允许继续');
  await ui('testUi.present(' + JSON.stringify({ conversationId: 'task-a', tab: { ...c, revision: 11 } }) + ')');
  check('stale presentation request preserves takeover state', (await evalUi('testUi.status()')).state.state === 'paused');
  const image = await owner.webContents.capturePage(); fs.writeFileSync(path.join(output, 'final.png'), image.toPNG());
  report.ok = true; save();
}).catch(error => { report.error = error.stack || String(error); save(); console.error(error); }).finally(async () => {
  clearTimeout(deadline); ipcMain.removeHandler('test:presentation'); host?.destroy(); owner?.destroy();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await pause(100); app.exit(report.ok ? 0 : 1);
});
