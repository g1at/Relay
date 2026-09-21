'use strict';
// Actual renderer with isolated history and synthetic execution events only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/conversation-error-history-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const timer = setTimeout(() => { failures.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function start(prompt) { await act(`$('input').value=${JSON.stringify(prompt)};$('btnSend').click();`); }
async function capture(name) { await delay(150); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function seed() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const f = window.failureFixture = { launches: 0, saves: 0, launchError: null };
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'runClaude') return async (...args) => { f.launches++; const result = await target.runClaude(...args);
      if (f.launchError) { const error = f.launchError; f.launchError = null; return { error }; }
      return result;
    };
    if (key === 'history') return new Proxy(target.history, { get(original, method) {
      if (method === 'save') return async value => { f.saves++; return original.save(clone(value)); };
      return original[method];
    } });
    return target[key];
  } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${seed.toString()})();localStorage.clear();`;
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
  await start('/goal 整理一份合成测试报告'); await waitFor('runs.size===1');
  await act(`failureFixture.origin=currentConv.id;failureFixture.job=runs.get(currentConv.id).jobId;failureFixture.error='API Error: Request rejected (429) · Too many requests';failureFixture.result={type:'result',subtype:'error_during_execution',is_error:true,errors:[failureFixture.error]};handleClaudeEvent({jobId:failureFixture.job,...failureFixture.result});handleClaudeEvent({jobId:failureFixture.job,type:'job-done',exitCode:1,finalResult:failureFixture.result});`);
  await waitFor('runs.size===0');
  await check('GoalFailureStoresItsOwnErrorAndTerminalStatus', 'currentConv.turns[0].error===failureFixture.error&&currentConv.turns[0].status==="error"&&currentConv.turns[0].output.status==="error"');
  await check('ResultAndDoneShowOneReadableErrorCard', 'document.querySelectorAll(".message.error").length===1&&document.querySelector(".message.error").dataset.raw===failureFixture.error');
  await act('failureFixture.beforeReloadSaves=failureFixture.saves;failureFixture.beforeReloadTime=currentConv.updatedAt;startNewConv();');
  await evaluate('loadConversation(failureFixture.origin,null,{forceReload:true})');
  await check('ReopeningPreservesErrorWithoutReorderingHistory', 'document.querySelectorAll(".message.error").length===1&&document.querySelector(".message.error").dataset.raw===failureFixture.error&&currentConv.updatedAt===failureFixture.beforeReloadTime&&failureFixture.saves===failureFixture.beforeReloadSaves');

  await start('继续'); await waitFor('runs.size===1');
  await act(`failureFixture.job=runs.get(currentConv.id).jobId;handleClaudeEvent({jobId:failureFixture.job,type:'job-done',exitCode:1,error:'目标设置未能完成，请重试'});`); await waitFor('runs.size===0');
  await evaluate('loadConversation(failureFixture.origin,null,{forceReload:true})');
  await check('PreparationFailureWithoutModelOutputSurvivesReload', 'currentConv.turns.length===2&&currentConv.turns[1].error==="目标设置未能完成，请重试"&&document.querySelectorAll(".message.error").length===2&&document.querySelectorAll(".message.assistant").length===0');
  await check('EachFailedContinuationHasAnErrorUnderItsOwnUserMessage', '[...document.querySelectorAll(".message")].map(node=>node.classList.contains("user")?"user":node.classList.contains("error")?"error":"other").join(",")==="user,error,user,error"');

  await start('再次继续'); await waitFor('runs.size===1');
  await act(`failureFixture.job=runs.get(currentConv.id).jobId;startNewConv();handleClaudeEvent({jobId:failureFixture.job,type:'job-done',exitCode:1,error:'后台任务连接超时'});`); await waitFor('runs.size===0');
  await check('BackgroundFailureDoesNotLeakIntoAnotherConversation', '!currentConv&&document.querySelectorAll(".message.error").length===0');
  await evaluate('loadConversation(failureFixture.origin,null,{forceReload:true})');
  await check('BackgroundFailureIsSavedInItsOriginalTurn', 'currentConv.turns[2].error==="后台任务连接超时"&&document.querySelectorAll(".message.error").length===3');

  await act(`failureFixture.launchError='启动失败：合成运行时不可用';`); await start('启动测试');
  await waitFor('!runs.size&&currentConv.turns.length===4');
  await evaluate('loadConversation(failureFixture.origin,null,{forceReload:true})');
  await check('LaunchRejectionAlsoPersistsItsError', 'currentConv.turns[3].error==="启动失败：合成运行时不可用"&&currentConv.turns[3].status==="error"&&document.querySelectorAll(".message.error").length===4');
  await start('现在继续'); await waitFor('runs.size===1');
  await act(`failureFixture.job=runs.get(currentConv.id).jobId;handleClaudeEvent({jobId:failureFixture.job,type:'assistant',message:{id:'good-final',content:[{type:'text',text:'合成报告已完成'}]}});handleClaudeEvent({jobId:failureFixture.job,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'合成报告已完成'}});`); await waitFor('runs.size===0');
  await evaluate('loadConversation(failureFixture.origin,null,{forceReload:true})');
  await check('SuccessfulRetryKeepsEarlierErrorsAndItsOwnFinalAnswer', 'currentConv.turns[4].error===null&&currentConv.turns[4].assistant==="合成报告已完成"&&document.querySelectorAll(".message.error").length===4&&document.querySelectorAll(".message.assistant").length===1');

  // Legacy records retain the exact failure in an empty activity snapshot.
  await evaluate(`window.api.history.save({id:'legacy-error-fixture',title:'历史失败兼容测试',mode:'plain',turns:[
    {user:'旧版目标任务',output:{status:'error',messages:[]},activity:{phase:'error',items:[],error:'Goal timeout: synthetic legacy failure'}},
    {user:'继续',output:{status:'error',messages:[]},activity:{phase:'error',items:[],error:'API 429: synthetic legacy retry'}},
    {user:'旧版手动暂停',output:{status:'canceled',messages:[]},activity:{phase:'error',items:[],error:'已暂停'}},
    {user:'小窗失败记录',status:'error',error:'小窗保存的失败原因',assistant:''},
    {user:'旧版错误结果',output:{status:'error',lastResult:{type:'result',is_error:true,errors:['<img src=x onerror=alert(1)> synthetic error']}}}
  ]})`);
  await evaluate('loadConversation("legacy-error-fixture",null,{forceReload:true})');
  await check('LegacyEmptyActivitiesRestoreExactFailureReasons', 'document.querySelectorAll(".message.error").length===4&&[...document.querySelectorAll(".message.error")].slice(0,2).map(n=>n.dataset.raw).join("|")==="Goal timeout: synthetic legacy failure|API 429: synthetic legacy retry"');
  await check('PausedTurnsStayDistinctFromFailures', '![...document.querySelectorAll(".message.error")].some(n=>n.dataset.turn==="2")');
  await check('MiniChatSavedErrorsAlsoShowInMainHistory', '[...document.querySelectorAll(".message.error")].some(n=>n.dataset.turn==="3"&&n.dataset.raw==="小窗保存的失败原因")');
  await check('ErrorDetailsStayTextAndNeverExecuteHTML', '!document.querySelector(".message.error img")&&document.querySelectorAll(".message.error")[3].textContent.includes("<img src=x onerror=alert(1)>")');
  await capture('legacy-errors-light');
  await act(`document.documentElement.dataset.theme='dark';document.body.dataset.theme='dark';`); win.setSize(900, 680); await delay(180);
  await check('ErrorHistoryFitsCompactDarkLayout', 'document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".message.error")].every(n=>n.getBoundingClientRect().right<=innerWidth)');
  await capture('legacy-errors-dark');
  await check('RendererRemainsIsolatedAndErrorFree', 'uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step = 'completed'; save(); clearTimeout(timer); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); console.error(error); if (win&&!win.isDestroyed()) { try { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); await capture('failure'); } catch (_) {} } save(); clearTimeout(timer); app.exit(1); });
