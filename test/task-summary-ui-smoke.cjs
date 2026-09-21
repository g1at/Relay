'use strict';
// Actual main renderer with in-memory history and synthetic SDK events. Never
// opens Relay's user profile, starts a model, or accesses the network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/task-summary-ui-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const checks = {}, errors = []; let win, step = 'start';
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const timer = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 65000);
const ev = code => win.webContents.executeJavaScript(code);
const act = code => ev(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(180); await ev('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function waitFor(code) { await ev(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const poll=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(poll,20)};poll()})`); }
async function check(name, code) { step = name; checks[name] = !!await ev(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.clear();const base=window.api,copy=value=>JSON.parse(JSON.stringify(value));
    const review=window.summaryReview={calls:[],emit:event=>uiFixture.emit('onEvent',{jobId:uiFixture.runId,...event})};
    window.api=new Proxy(base,{get(target,key){
      if(key==='runClaude')return async(...args)=>{review.calls.push(copy(args));return {...await target.runClaude(...args),sessionId:'summary-fixture-session'}};
      if(key==='pauseClaude')return async jobId=>{review.emit({jobId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',terminal_reason:'aborted_streaming'}});return {paused:true,settled:true,preservedSession:true,jobId}};
      if(key==='steerClaude')return async request=>{const input={id:request.messageId,text:request.prompt,status:'applied',ts:new Date().toISOString(),presentation:request.presentation,followUpMode:'steer'};
        const conv=await target.history.load(request.conversationId),turn=conv.turns.find(item=>item.runId===request.jobId);(turn.supplements||=[]).push(copy(input));await target.history.save(conv);
        review.emit({jobId:request.jobId,type:'system',subtype:'relay_user_input',input});return {ok:true,jobId:request.jobId,messageId:request.messageId,input}};
      return target[key]}})})();`;
  const file = path.join(out, 'fixture.html');
  fs.writeFileSync(file, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>',
    '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1120, height: 790, show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  await win.loadFile(file); win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
  await act(`window.headers=()=>[...document.querySelectorAll('.process-summary')].filter(node=>!node.hidden);
    window.headerAtStart=()=>{const firstUser=document.querySelector('.message.user:not([data-supplement-id])'),header=headers()[0];return headers().length===1&&header.checkVisibility()&&!!(firstUser.compareDocumentPosition(header)&4)&&[...document.querySelectorAll('.process-items,.message.user[data-supplement-id]')].every(node=>!!(header.compareDocumentPosition(node)&4))};
    $('input').value='检查这个项目并交付报告';$('btnSend').click();`);
  await waitFor('summaryReview.calls.length===1&&runs.size===1');
  await act(`summaryReview.initialHeader=headers()[0];summaryReview.id=currentConv.id;summaryReview.taskId=currentConv.turns[0].taskRun.taskId;`);
  await check('InitialTaskHeaderFollowsOnlyItsOriginalQuestion', 'headerAtStart()&&headers()[0].textContent.includes("用时")');
  await act(`$('input').value='报告补充兼容性说明';$('input').dispatchEvent(new Event('input',{bubbles:true}));$('btnSend').click();`);
  await waitFor('currentConv.turns[0].supplements?.length===1&&!conversationControls.size');
  await check('InterjectionBeforeAnyModelOutputRetainsTheOriginalHeader', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader');
  await act(`summaryReview.emit({type:'assistant',message:{id:'first-stage',content:[{type:'tool_use',id:'read-config',name:'Read',input:{file_path:'D:/fixture/package.json'}}]}});`); await settle();
  await check('ProcessAfterEarlyInterjectionStillFollowsTheOneTaskHeader', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader&&document.querySelector("[data-process-id]")');
  await act(`$('btnSend').click();`); await waitFor('runs.size===0&&!conversationControls.size&&!!currentConv.paused');
  await check('PauseUpdatesTheSameHeaderWithoutMovingIt', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader&&headers()[0].textContent.includes("已暂停")');
  await capture('paused-at-task-start');
  await act(`$('btnSend').click();`); await waitFor('summaryReview.calls.length===2&&runs.size===1'); await settle();
  await check('ContinueHasOneTaskIdAndNoNewUserQuestion', 'currentConv.turns[1].taskRun.taskId===summaryReview.taskId&&currentConv.turns[1].inputKind==="resume"&&document.querySelectorAll(".message.user:not([data-supplement-id])").length===1');
  await check('ContinueRefreshesTheOriginalHeaderBeforeAllSegments', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader&&!headers()[0].textContent.includes("已暂停")');
  await act(`summaryReview.emit({type:'assistant',message:{id:'resumed-stage',content:[{type:'tool_use',id:'read-readme',name:'Read',input:{file_path:'D:/fixture/README.md'}}]}});`); await settle();
  await check('ResumedToolsRemainBelowTheEarlierInterjection', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader&&!!(document.querySelector(".message.user[data-supplement-id]").compareDocumentPosition(document.querySelector("[data-process-id=read-readme]"))&4)');
  await capture('resumed-header-at-task-start');
  await act(`summaryReview.emit({type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'## 检查报告\\n\\n已完成兼容性检查。'}});`); await waitFor('runs.size===0'); await settle();
  await check('ResumedCompletionKeepsOneOriginalHeader', 'headerAtStart()&&headers()[0]===summaryReview.initialHeader&&headers()[0].textContent.includes("已完成")');
  await ev('loadConversation(summaryReview.id,null,{forceReload:true})'); await settle();
  await check('RestoredResumeHistoryHasOneHeaderAtTheFirstQuestion', 'headerAtStart()&&headers()[0].textContent.includes("已完成")&&document.querySelectorAll(".message.user:not([data-supplement-id])").length===1');
  await act(`$('input').value='开始下一项独立任务';$('btnSend').click();`); await waitFor('summaryReview.calls.length===3&&runs.size===1');
  await check('IndependentTaskKeepsItsOwnHeaderAndClock', 'headers().length===2&&currentConv.turns.at(-1).taskRun.taskId!==summaryReview.taskId&&headers()[0].textContent.includes("已完成")&&headers()[1].textContent.includes("用时")');
  await act(`summaryReview.emit({type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'独立任务已交付。'}});`); await waitFor('runs.size===0');
  // Older paused runs can lack activity/task metadata. A validated explicit
  // resume still supplies an initial presentation anchor without changing data.
  await act(`const now=Date.now(),C=RelayTaskContinuity;
    const first={runId:'legacy-first',user:'恢复旧版任务',assistant:'',status:'paused',ts:new Date(now-100000).toISOString(),taskStartedAt:now-100000,taskFinishedAt:now-64000};
    const conv={id:'legacy-summary-fixture',title:'旧版任务',mode:'plain',model:'opus',turns:[first],paused:{runId:first.runId,at:new Date(now-64000).toISOString()}};
    const taskRun=C.finish(C.begin({runId:'legacy-resumed',startedAt:now-34000,conversation:conv,resumedFromRunId:first.runId}),{finishedAt:now});
    conv.turns.push({runId:'legacy-resumed',inputKind:'resume',user:'',assistant:'已交付。',status:'complete',taskRun,ts:new Date(now-34000).toISOString(),assistantTs:new Date(now).toISOString()});delete conv.paused;window.legacySummary=conv;`);
  await ev('api.history.save(legacySummary)'); await ev('loadConversation(legacySummary.id,null,{forceReload:true})'); await settle();
  await check('LegacyResumeWithoutFirstActivityStillAnchorsOneCumulativeClock', 'headerAtStart()&&headers()[0].textContent.includes("1m 10s")&&document.querySelectorAll(".message.user").length===1');
  await check('DisplayMigrationDoesNotWriteActivityOrTaskMetadataToOldTurn', '!currentConv.turns[0].activity&&!currentConv.turns[0].taskRun');
  await act(`document.documentElement.dataset.theme='dark';document.body.dataset.theme='dark';`); win.setSize(860, 640); await settle();
  await check('CompactHeaderFitsAndHasNoRendererErrors', 'uiFixture.errors.length===0&&headers()[0].getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth');
  await capture('legacy-restored-dark');
  step='complete'; save(); clearTimeout(timer); win.destroy(); app.exit(0);
}).catch(async error => { errors.push(String(error.stack || error)); console.error(error); if (win&&!win.isDestroyed()) { try { await capture('failure'); console.error(await ev('JSON.stringify({errors:uiFixture.errors,content:document.querySelector("#messages")?.textContent})')); } catch (_) {} } save(); clearTimeout(timer); app.exit(1); });
