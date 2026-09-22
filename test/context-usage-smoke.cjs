'use strict';
// Real sandboxed renderer; context results and running conversations are synthetic.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/context-usage-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 75000);
const evaluate = code => win.webContents.executeJavaScript(code), act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function capture(name) { await delay(150); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function seed() {
  localStorage.clear();
  const base = window.api;
  const state = window.contextFixture = { calls: [], percentage: 37, hold: false, pending: [], unknownWindow: false };
  window.api = new Proxy(base, { get(target, key) {
    if (key !== 'claudeRuntimeInfo') return target[key];
    return (id, options = {}) => {
      state.calls.push({ id, options, at: Date.now() });
      const route = configuredChatRoute(currentModel);
      const context = { totalTokens: 31000, maxTokens: state.unknownWindow ? 0 : 100000,
        rawMaxTokens: state.unknownWindow ? 0 : 128000, percentage: state.percentage++, model: route.modelId, estimated: true, source: 'sdk-summary', sampledAt: new Date().toISOString() };
      const result = { ok: true, connected: true, busy: runs.has(id), providerId: route.providerId,
        providerRevision: route.providerRevision, model: route.modelId, routeTier: currentModel, context };
      if (state.hold) return new Promise(resolve => state.pending.push(() => resolve(result)));
      return Promise.resolve(result);
    };
  } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const scripts = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8') + `\n(${seed.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${scripts}</script>`);
  const page = path.join(out, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await act("currentConv={id:'context-a',model:currentModel,turns:[]};runs.set('context-a',{convId:'context-a',jobId:'context-job-a'});setRunning(true);");
  await waitFor("contextFixture.calls.length===1&&contextUsageLabel.textContent==='37%'");
  await check('runningContextUsesSDKPercentageAndRawWindow', "contextUsageTokens.textContent==='已用 31k Token，共 128k'&&contextUsagePercent.textContent==='37% 已用'&&contextUsagePopover.title.includes('SDK 估算')&&contextUsagePopover.title.includes('约每 2 秒')&&contextUsageEl.getAttribute('aria-label').includes('SDK 估算')");
  await waitFor('contextFixture.calls.length>=2');
  await check('lightweightPollingRefreshesWithoutSavingHistory', "contextFixture.calls.every(call=>call.options.contextOnly)&&contextUsageLabel.textContent==='38%'&&!currentConv.contextUsage&&!uiFixture.calls.includes('history.save')");
  await act('showContextUsagePopover();'); await delay(220);
  await check('compactContextCardHasThreeCenteredLinesWithoutModelOrProgress', "contextUsagePopover.children.length===3&&contextUsagePopover.firstElementChild.textContent==='上下文窗口'&&!$('contextUsageModel')&&!$('contextUsageNote')&&!$('contextUsageFill')&&getComputedStyle(contextUsagePopover).textAlign==='center'&&contextUsagePopover.offsetWidth===174&&contextUsagePopover.offsetHeight<=80&&getComputedStyle(contextUsagePopover,'::after').content==='none'");
  await check('sidebarBrandTitleFadesWithoutEllipsis', "(()=>{const name=$('brandName'),text=name.textContent,title=name.title;name.textContent=name.title='Relay 本地助手与日常工作空间的长名称';try{const style=getComputedStyle(name);return name.scrollWidth>name.clientWidth&&style.textOverflow==='clip'&&style.maskImage.includes('linear-gradient')&&style.overflow==='hidden'&&name.title===name.textContent}finally{name.textContent=text;name.title=title}})()");
  await check('contextCardStaysInsideViewport', "(()=>{const card=contextUsagePopover.getBoundingClientRect();return card.left>=11&&card.right<=innerWidth-11&&card.top>=11})()");
  await capture('running-context-summary');
  await act("document.documentElement.dataset.theme='dark';showContextUsagePopover();"); await capture('running-context-summary-dark');
  await act("document.documentElement.dataset.theme='light';hideContextUsagePopover();");
  await act("showAppView('settings');contextFixture.stoppedAt=contextFixture.calls.length;"); await delay(2250);
  await check('leavingChatStopsPolling', 'contextFixture.calls.length===contextFixture.stoppedAt');
  await act("showChatView();"); await waitFor('contextFixture.calls.length>contextFixture.stoppedAt');
  await act("contextFixture.hold=true;contextFixture.stoppedAt=contextFixture.calls.length;");
  await waitFor('contextFixture.pending.length===1'); await delay(2200);
  await check('slowResponsesNeverCreateOverlappingPolls', 'contextFixture.pending.length===1&&contextFixture.calls.length===contextFixture.stoppedAt+1');
  await act("contextFixture.beforeStop=contextUsageByConv.get('context-a').percentage;runs.delete('context-a');setRunning(false);contextFixture.stoppedAt=contextFixture.calls.length;contextFixture.pending.shift()();contextFixture.hold=false;"); await delay(2200);
  await check('stoppingRejectsTheLateResponseAndEndsTheTimer', "contextFixture.calls.length===contextFixture.stoppedAt&&contextUsageByConv.get('context-a').percentage===contextFixture.beforeStop&&!contextUsagePopover.title.includes('运行中')");
  await evaluate("refreshClaudeRuntimeInfo('context-a')");
  await check('idleReadUpdatesSavedConversationSnapshot', "!!currentConv.contextUsage&&contextFixture.calls.at(-1).options.contextOnly===false");
  await act("contextFixture.hold=true;contextFixture.oldRead=refreshClaudeRuntimeInfo('context-a',{contextOnly:true});currentConv={id:'context-b',model:currentModel,turns:[]};renderContextUsage();contextFixture.pending.shift()();contextFixture.hold=false;");
  await evaluate('contextFixture.oldRead');
  await check('switchingConversationCannotDisplayAnOldSnapshot', "contextUsageEl.classList.contains('hidden')&&!currentConv.contextUsage&&!contextUsageByConv.has('context-b')");
  await act("contextFixture.unknownWindow=true;"); await evaluate("refreshClaudeRuntimeInfo('context-b',{contextOnly:true})");
  await check('unknownWindowDoesNotInventALimit', "contextUsageByConv.get('context-b').maxTokens===0&&contextUsageEl.classList.contains('hidden')");
  await check('sandboxedRendererHasNoErrors', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0");
  step = 'completed'; save(); clearTimeout(deadline); app.exit(0);
}).catch(async error => { errors.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) { await capture('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {} clearTimeout(deadline); app.exit(1); });
