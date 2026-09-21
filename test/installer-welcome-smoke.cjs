'use strict';
// Loads the real welcome page with an isolated profile and an in-memory host.
// Never loads Relay's preload or invokes the production wizard:complete IPC.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp', 'installer-welcome-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
const preload = path.join(out, 'mock-preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
if(!process.argv.includes('--welcome-no-bridge'))contextBridge.exposeInMainWorld('api',{installer:{complete:()=>ipcRenderer.invoke('welcome-smoke:complete')}});`);
const result = { checks: {}, metrics: {}, errors: [] };
let win, step = 'start', calls = 0, pending;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, ...result }, null, 2));
const deadline = setTimeout(() => { result.errors.push('timeout: ' + step); save(); app.exit(1); }, 60000);
const ev = code => win.webContents.executeJavaScript(code);
const settle = () => new Promise(resolve => setTimeout(resolve, 130));
const check = async (name, code) => {
  step = name;
  result.checks[name] = typeof code === 'string' ? !!await ev(code) : !!code;
  save();
  console.log(name + ': ' + result.checks[name]);
  if (!result.checks[name]) throw new Error(name);
};
const waitFor = async code => ev(`new Promise((resolve,reject)=>{const end=performance.now()+4000;const poll=()=>{if(${code})return resolve();if(performance.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(poll,10);};poll();})`);
const key = keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
const capture = async name => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
async function open(noBridge = false) {
  win = new BrowserWindow({ width: 720, height: 520, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, show: false, backgroundColor: '#fafafa',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: noBridge ? ['--welcome-no-bridge'] : [], backgroundThrottling: false } });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message); });
  win.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await win.loadFile(path.join(root, 'installer', 'wizard.html'));
  win.showInactive();
  await ev('document.fonts.ready');
}
ipcMain.handle('welcome-smoke:complete', () => { calls++; return new Promise((resolve, reject) => { pending = { resolve, reject }; }); });
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  await open();
  await check('SingleBrandAndUsefulNextStep', 'document.querySelectorAll("img").length===1&&document.body.textContent.includes("设置 → 服务商")');
  await check('NoFakeReadyOrInstallationPercentage', '!document.body.textContent.includes("已就绪")&&!document.querySelector("progress,[role=progressbar]")&&!document.body.textContent.includes("SDK")');
  await check('AccessibleLabelsAndAnnouncements', 'document.querySelector("main").getAttribute("aria-labelledby")==="welcomeTitle"&&document.getElementById("errorText").getAttribute("role")==="alert"&&document.getElementById("statusText").getAttribute("aria-live")==="polite"');
  await check('NoNodeInRenderer', 'typeof process==="undefined"&&typeof require==="undefined"');
  for (const zoom of [1, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    await settle();
    result.metrics[zoom] = await ev(`(()=>{const c=document.querySelector('.welcome-content');return {width:innerWidth,height:innerHeight,content:c.clientHeight,scroll:c.scrollHeight}})()`);
    await check('FooterReachableAtZoom' + zoom, `(()=>{const b=document.getElementById('btnEnter').getBoundingClientRect(),s=document.querySelector('.welcome-status').getBoundingClientRect(),f=document.querySelector('.welcome-footer').getBoundingClientRect();return b.width>100&&b.left>=0&&b.right<=innerWidth&&b.top>=f.top&&b.bottom<=innerHeight&&s.right<b.left&&document.documentElement.scrollWidth<=innerWidth;})()`);
    await check('ContentFitsOrCanScrollAtZoom' + zoom, `(()=>{const c=document.querySelector('.welcome-content'),last=c.lastElementChild.getBoundingClientRect();return c.clientHeight>80&&(last.bottom<=c.getBoundingClientRect().bottom+1||getComputedStyle(c).overflowY==='auto');})()`);
    await capture('welcome-' + zoom);
  }
  win.webContents.setZoomFactor(1.25);
  await ev('document.querySelector(".welcome-content").focus()');
  win.webContents.focus();
  key('Tab');
  await waitFor('document.activeElement.id==="btnEnter"');
  await check('KeyboardTabFindsPrimaryAction', 'document.activeElement.id==="btnEnter"');
  key('Enter');
  await waitFor('document.getElementById("btnEnter").disabled');
  await check('KeyboardEnterCallsHostOnce', calls === 1);
  await check('PendingIsHonestAndAnnounced', 'document.getElementById("btnEnter").getAttribute("aria-busy")==="true"&&document.getElementById("statusText").textContent==="正在打开主界面"&&!document.querySelector("progress")');
  await ev('document.getElementById("btnEnter").dispatchEvent(new MouseEvent("click",{bubbles:true}));document.getElementById("btnEnter").dispatchEvent(new MouseEvent("click",{bubbles:true}));');
  key('Enter');
  await settle();
  await check('PendingBlocksDuplicateRequests', calls === 1);
  await capture('welcome-opening');
  pending.resolve({ ok: false, message: '暂时无法打开主界面，请重试。' });
  await waitFor('!document.getElementById("btnEnter").disabled');
  await check('FailedHandoffCanRetryAndKeepsFocus', 'document.getElementById("enterLabel").textContent==="重试"&&!document.getElementById("errorText").hidden&&document.getElementById("statusText").hidden&&document.activeElement.id==="btnEnter"&&!document.getElementById("btnEnter").hasAttribute("aria-busy")');
  await capture('welcome-retry');
  key('Enter');
  await waitFor('document.getElementById("btnEnter").disabled');
  await check('RetryClearsPreviousError', 'document.getElementById("errorText").hidden&&document.getElementById("errorText").textContent===""');
  await settle();
  await check('RetryCallsHostExactlyOnce', calls === 2);
  pending.reject(new Error('测试错误 <img src=x onerror=alert(1)> ' + '目录暂不可写，请稍后重试。'.repeat(18)));
  await waitFor('!document.getElementById("btnEnter").disabled');
  await check('ThrownErrorIsLiteralTextAndBounded', 'document.getElementById("errorText").textContent.includes("<img")&&!document.getElementById("errorText").querySelector("img")&&document.getElementById("errorText").getBoundingClientRect().height<75&&document.getElementById("btnEnter").getBoundingClientRect().bottom<=innerHeight');
  await ev('document.getElementById("btnEnter").click()');
  await settle();
  pending.resolve(undefined);
  await waitFor('!document.getElementById("btnEnter").disabled');
  await check('MissingAcknowledgmentIsNotSuccess', 'document.getElementById("enterLabel").textContent==="重试"&&!document.getElementById("errorText").hidden');
  await ev('document.getElementById("btnEnter").click()');
  await settle();
  pending.resolve({ ok: true });
  await waitFor('document.getElementById("statusText").textContent==="正在切换到 Relay"');
  await ev('document.getElementById("btnEnter").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
  await settle();
  await check('SuccessfulHandoffStaysSingleSubmission', calls === 4);
  await check('SuccessDoesNotReenableEnter', 'document.getElementById("btnEnter").disabled&&document.getElementById("errorText").hidden');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await check('ReducedMotionStopsSpinner', 'getComputedStyle(document.querySelector(".enter-spinner")).animationName==="none"');
  win.webContents.debugger.detach();
  win.destroy();
  await open(true);
  await ev('document.getElementById("btnEnter").click()');
  await waitFor('!document.getElementById("errorText").hidden');
  await check('MissingBridgeExplainsRecovery', 'document.getElementById("errorText").textContent.includes("重新打开 Relay")&&!document.getElementById("btnEnter").disabled');
  await check('NoRealHostOrRendererErrors', calls === 4 && result.errors.length === 0);
  step = 'complete'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { result.errors.push(String(error.stack || error)); console.error(error); if (win && !win.isDestroyed()) try { await capture('failure'); } catch (_) {} save(); clearTimeout(deadline); app.exit(1); });
