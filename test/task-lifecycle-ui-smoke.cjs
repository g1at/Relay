'use strict';
// Production renderer in an isolated Electron profile. Model events, workspace
// files and every backend endpoint are synthetic; no Relay main or SDK is run.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mergeSupplementHistory } = require('../live-supplement-input');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/task-lifecycle-ui-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(180); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+6500;const tick=()=>{if(${code})return resolve();if(performance.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20);};tick();})`);
}
async function check(name, code) {
  step = name; checks[name] = !!await evaluate(code); save();
  console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name);
}
async function capture(name) {
  if (name !== 'failure') await waitFor('!document.querySelector(".app-toast.show")');
  await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const seed = String.raw`(() => {
    localStorage.clear(); const base = window.api;
    const clone = value => JSON.parse(JSON.stringify(value));
    const mergeHistory = ${mergeSupplementHistory.toString()};
    const state = window.steerReview = {
      launches: [], steers: [], pauses: [], saves: [], copied: [], plans: [], pending: [], inputs: new Map(),
      conversations: new Map(), inputWrites: new Map(), inputJobs: new Map(), silentInputs: new Set(), closedJobs: new Set(),
      emit(event) { uiFixture.emit('onEvent', clone(event)); },
      inputEvent(jobId, input, {silent=false}={}) {
        const conversationId=this.conversations.get(jobId);
        const previous=this.inputWrites.get(conversationId)||Promise.resolve();
        const writing=previous.then(async()=>{
          // Production main persists each accepted/status event before delivery.
          const conv=await base.history.load(conversationId);
          const turn=conv?.turns.find(item=>item.runId===jobId);
          if(!turn)throw Error('Synthetic accepted input lost its owning turn');
          turn.supplements=turn.supplements||[];
          const index=turn.supplements.findIndex(item=>item.id===input.id);
          const old=index<0?null:turn.supplements[index];
          const rank={queued:0,canceled:1,rejected:1,applied:2};
          const merged={...old,...clone(input)};
          if(old&&(rank[old.status]||0)>(rank[input.status]||0))merged.status=old.status;
          if(index<0)turn.supplements.push(merged);else turn.supplements[index]=merged;
          await base.history.save(conv);
          this.inputs.set(input.id,merged);
          this.inputJobs.set(input.id,jobId);
          if(!silent)this.emit({jobId,type:'system',subtype:'relay_user_input',input:merged});
          return merged;
        });
        this.inputWrites.set(conversationId,writing);
        return writing;
      },
      release() { const pending=this.pending.shift(); if(!pending)throw Error('No held steering receipt');pending.release(); },
      async finish(jobId, text) {
        // Simulate SDK consuming accepted inputs before its final response.
        for(const input of this.inputs.values())if(this.inputJobs.get(input.id)===jobId&&input.status==='queued'&&!this.silentInputs.has(input.id)){
          await this.inputEvent(jobId,{...input,status:'applied'});
        }
        this.closedJobs.add(jobId);
        this.emit({jobId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:text}});
      },
      stream(jobId,id,text) {
        this.emit({jobId,type:'stream_event',event:{type:'message_start',message:{id}}});
        this.emit({jobId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
      }
    };
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>state.copied.push(text)}});
    window.api = new Proxy(base, { get(target,key) {
      if(key==='runClaude')return async (...args)=>{
        state.launches.push(clone(args));
        state.conversations.set(args[11],args[12]||args[9]);
        if(state.failNextLaunch){state.failNextLaunch=false;state.now+=5000;return {error:'合成继续启动失败'};}
        const result=await target.runClaude(...args);
        return {...result,sessionId:'synthetic-live-session'};
      };
      if(key==='pauseClaude')return async jobId=>{
        state.pauses.push(jobId);
        state.closedJobs.add(jobId);
        state.emit({jobId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',terminal_reason:'aborted_streaming'}});
        return {paused:true,settled:true,preservedSession:true,jobId};
      };
      if(key==='steerClaude')return async request=>{
        request=clone(request);state.steers.push(request);
        const plan=state.plans.shift()||{};
        if(state.inputs.has(request.messageId))return {ok:true,duplicate:true,jobId:request.jobId,messageId:request.messageId,input:clone(state.inputs.get(request.messageId))};
        if(state.closedJobs.has(request.jobId))return {ok:false,jobId:request.jobId,messageId:request.messageId,code:'NOT_RUNNING',message:'原任务已结束且未接收这条补充'};
        const input=state.inputs.get(request.messageId)||{
          id:request.messageId,text:request.prompt,files:request.files||[],skill:request.skill||null,
          ts:new Date().toISOString(),status:'queued',presentation:request.presentation,followUpMode:request.followUpMode
        };
        if(plan.silentAccept)state.silentInputs.add(input.id);
        const accepted=()=>state.inputEvent(request.jobId,input,{silent:state.silentInputs.has(input.id)});
        if(!plan.reject && plan.emit!=='deferred')await accepted();
        if(plan.hold)await new Promise(resolve=>state.pending.push({request,input,release:resolve}));
        if(plan.reject)return {ok:false,jobId:request.jobId,messageId:request.messageId,code:'STEER_REJECTED',error:'合成补充发送失败'};
        if(plan.emit==='deferred')await accepted();
        if(plan.throwAfterAccept)throw Error('合成回执连接中断');
        return {ok:true,jobId:request.jobId,messageId:request.messageId,input:clone(input)};
      };
      if(key==='history')return new Proxy(target.history,{get(original,method){
        if(method==='save')return async conv=>{
          // IPC structured-clones an argument immediately, before async work.
          const snapshot=clone(conv);state.saves.push(snapshot);
          if(state.holdFinalSave&&snapshot.turns.at(-1)?.output?.status==='complete'){
            state.holdFinalSave=false;await new Promise(resolve=>state.releaseFinalSave=resolve);
          }
          // The production history writer preserves backend-owned supplements.
          mergeHistory(snapshot,await original.load(snapshot.id));
          return original.save(snapshot);
        };
        return original[method];
      }});
      return target[key];
    }});
  })();`;
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
  await check('FixtureIsIsolatedAndIdle', 'typeof require==="undefined"&&typeof process==="undefined"&&steerReview.launches.length===0&&steerReview.pauses.length===0');


  await act("$('input').value='检查合成项目并交付报告';$('btnSend').click();");
  await waitFor('steerReview.launches.length===1&&runs.size===1');
  await act("steerReview.origin=currentConv.id;steerReview.originalRun=runs.get(currentConv.id);steerReview.job=steerReview.originalRun.jobId;steerReview.clockStart=Date.now()-4841000;window.emitTask=e=>steerReview.emit({jobId:steerReview.job,relay_task_id:steerReview.originalRun.taskRun.taskId,relay_task_started_at:steerReview.clockStart,relay_task_segment_started_at:steerReview.clockStart,relay_task_elapsed_before_ms:0,...e});");
  await check('LaunchCarriesOriginalTaskStart','Number.isFinite(steerReview.launches[0][13].taskStartedAt)&&steerReview.launches[0][13].taskStartedAt===Date.parse(currentConv.turns[0].ts)');
  await act("emitTask({type:'system',subtype:'init',session_id:'synthetic-live-session'});emitTask({type:'assistant',message:{id:'delegate',content:[{type:'text',text:'开始核对合成项目。'},{type:'tool_use',id:'active-agent',name:'Agent',input:{description:'核对文件',subagent_type:'reviewer'}}]}});emitTask({type:'system',subtype:'task_started',task_id:'synthetic-agent',tool_use_id:'active-agent',task_type:'local_agent',is_backgrounded:true,description:'核对文件'});emitTask({type:'assistant',message:{id:'stage-one',content:[{type:'text',text:'# 阶段进展\\n\\n第一部分已核对，子任务仍在执行。'}]}});emitTask({type:'result',subtype:'success',result:'# 阶段进展\\n\\n第一部分已核对，子任务仍在执行。',duration_ms:84000,relay_pending_async_agents:1});");
  await settle();
  await check('StageResultKeepsTaskRunningAndProcessExpanded','runs.get(steerReview.origin)===steerReview.originalRun&&steerReview.originalRun.activityState.phase==="running"&&!document.querySelector(".process-stream").classList.contains("is-collapsed")&&!document.querySelector(".process-summary-title").textContent.includes("已完成")');
  await check('StageTextStaysInChronologicalWorkStream','!document.querySelector(".message.assistant")&&document.querySelector(".process-items").textContent.includes("第一部分已核对")');
  await check('LiveClockIncludesPreviousWaitAndRetryTime','document.querySelector(".process-summary-meta").textContent.includes("1h 20m")');
  await act("emitTask({type:'system',subtype:'task_progress',task_id:'synthetic-agent',tool_use_id:'active-agent',description:'核对第二部分',summary:'已继续处理第二部分'});emitTask({type:'assistant',parent_tool_use_id:'active-agent',message:{id:'child-progress',content:[{type:'text',text:'子任务已读取下一组文件。'}]}});emitTask({type:'assistant',message:{id:'more-tools',content:[{type:'tool_use',id:'next-read',name:'Read',input:{file_path:'synthetic-report.md'}}]}});");
  await settle();
  await check('SubagentAndNewToolUpdateWithoutAnyUserInput','document.querySelector(".process-items").textContent.includes("核对第二部分")&&document.querySelector(".process-items").textContent.includes("synthetic-report.md")&&steerReview.steers.length===0');
  await capture('stage-continues');
  await act("$('input').value='同时检查边界情况';$('btnSend').click();");
  await waitFor('steerReview.steers.length===1&&!conversationControls.size');
  await check('SupplementIsSameTaskAndPreviousProcessIsNeutral','currentConv.turns.length===1&&steerReview.launches.length===1&&steerReview.pauses.length===0&&[...document.querySelectorAll(".process-summary-title")].some(e=>e.textContent==="此前过程")&&[...document.querySelectorAll(".process-summary-title")].every(e=>!e.textContent.includes("已完成")&&!e.textContent.includes("准备"))');
  await check('TaskTimerAppearsOnlyOnceAcrossSegments','[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1');
  await act("emitTask({type:'system',subtype:'init',session_id:'synthetic-live-session'});emitTask({type:'system',subtype:'relay_mcp_status',phase:'preparing',stage:'initializing'});");await settle();
  await check('RepeatedRuntimeInitDoesNotResetTaskOrShowPreparation','steerReview.originalRun.activityState.taskStartedAt===steerReview.clockStart&&[...document.querySelectorAll(".process-summary-title")].every(e=>!e.textContent.includes("准备"))');
  await act("emitTask({type:'assistant',message:{id:'follow-up-work',content:[{type:'text',text:'正在把边界情况加入同一份报告。'},{type:'tool_use',id:'follow-read',name:'Read',input:{file_path:'boundaries.md'}}]}});$('input').value='再补充验证范围';$('btnSend').click();");
  await waitFor('steerReview.steers.length===2&&!conversationControls.size');
  await check('RepeatedSupplementsNeverAddCompletedLabels','document.querySelectorAll(".message.user[data-supplement-id]").length===2&&[...document.querySelectorAll(".process-summary-title")].every(e=>!e.textContent.includes("已完成"))&&[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1');
  await act('startNewConv();');
  await check('SwitchingConversationHidesOriginalProcess','!document.querySelector(".process-stream")&&runs.size===1');
  await evaluate('loadConversation(steerReview.origin)');await settle();
  await check('ReopenRunningTaskKeepsOneClockAndLiveProcess','runs.get(steerReview.origin)===steerReview.originalRun&&[...document.querySelectorAll(".process-summary-title")].every(e=>!e.textContent.includes("已完成")&&!e.textContent.includes("准备"))&&[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1');
  await capture('same-task-supplements');
  await act("emitTask({type:'system',subtype:'task_notification',task_id:'synthetic-agent',tool_use_id:'active-agent',status:'completed',summary:'子任务完成'});steerReview.answer='# 报告交付\\n\\n包含边界情况与验证范围。';emitTask({type:'assistant',message:{id:'final-report',content:[{type:'text',text:steerReview.answer}]}});emitTask({type:'result',subtype:'success',result:steerReview.answer,duration_ms:12000});");await settle();
  await check('EvenLastSdkResultAwaitsActualTaskDelivery','runs.size===1&&steerReview.originalRun.activityState.phase==="running"&&document.querySelectorAll(".assistant-copy").length===0');
  await act("emitTask({type:'job-done',exitCode:0,relay_task_finished_at:steerReview.clockStart+4841000,relay_task_duration_ms:4841000,finalResult:{type:'result',subtype:'success',result:steerReview.answer,duration_ms:12000}});");
  await waitFor('runs.size===0');await settle();
  await check('OnlyFinalDeliveryProducesOneCompletionAndFullDuration','[...document.querySelectorAll(".process-summary-title")].filter(e=>e.textContent==="已完成").length===1&&[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1&&[...document.querySelectorAll(".process-summary-meta")].some(e=>e.textContent.includes("1h 20m 41s"))');
  await check('FinalAnswerAndCopyAppearOnce','currentConv.turns.length===1&&currentConv.turns[0].assistant===steerReview.answer&&document.querySelectorAll(".assistant-copy").length===1');
  await evaluate('loadConversation(steerReview.origin,null,{forceReload:true})');await settle();
  await check('HistoryRetainsFullTaskDurationWithoutSegmentCompletions','[...document.querySelectorAll(".process-summary-title")].filter(e=>e.textContent==="已完成").length===1&&[...document.querySelectorAll(".process-summary-meta")].some(e=>e.textContent.includes("1h 20m 41s"))&&currentConv.turns[0].assistant===steerReview.answer');
  await capture('task-delivered');
  await evaluate('(async()=>{const legacy=await window.api.history.load(steerReview.origin);legacy.id="legacy-clock-conversation";const turn=legacy.turns[0];turn.ts="2026-09-01T01:00:00.000Z";turn.assistantTs="2026-09-01T03:05:06.000Z";delete turn.taskRun;for(const key of ["taskStartedAt","taskFinishedAt","taskDurationMs","taskRun"])delete turn.activity[key];turn.activity.startedAt=Date.parse(turn.ts);turn.activity.endedAt=Date.parse(turn.ts)+30000;turn.activity.result={...(turn.activity.result||{}),durationMs:12000};await window.api.history.save(legacy);await loadConversation(legacy.id);})()');await settle();
  await check('LegacyHistoryUsesSavedDeliveryTimeInsteadOfLastSdkAttempt','[...document.querySelectorAll(".process-summary-meta")].some(e=>e.textContent.includes("2h 5m 6s"))');

  step='mini-history-clock';
  await evaluate('(async()=>{const saved=await window.api.history.load(steerReview.origin);saved.id="fixture-mini-clock";saved.title="Mini task history clock";const turn=saved.turns[0];delete turn.activity;delete turn.taskRun;turn.taskStartedAt=Date.parse("2026-09-01T01:00:00.000Z");turn.taskFinishedAt=turn.taskStartedAt+4841000;turn.taskDurationMs=4841000;turn.ts="2026-09-01T01:00:30.000Z";turn.assistantTs="2026-09-01T01:00:42.000Z";await window.api.history.save(saved);await loadConversation(saved.id);})()');await settle();
  await check('MiniHistoryKeepsWholeTaskClock','[...document.querySelectorAll(".process-summary-meta")].some(e=>e.textContent.includes("1h 20m 41s"))');


  step='pause-resume-continuity';
  await act("startNewConv();steerReview.launchBase=steerReview.launches.length;steerReview.realNow=Date.now;steerReview.now=Date.UTC(2026,8,10,1,0,0);Date.now=()=>steerReview.now;$('input').value='完成合成项目审查';$('btnSend').click();");
  await waitFor('steerReview.launches.length===steerReview.launchBase+1&&runs.size===1');
  await act("steerReview.continuityId=currentConv.id;steerReview.continuityTask=runs.get(currentConv.id).taskRun.taskId;");
  for (const [index, seconds] of [36,34,33].entries()) {
    await act(`steerReview.stream(runs.get(currentConv.id).jobId,'continuity-${index}','第 ${index+1} 段合成工作记录');steerReview.now+=${seconds*1000};`);
    await settle();
    await act("$('btnSend').click();");
    await waitFor('runs.size===0&&!conversationControls.size&&currentConv.paused');
    await check('Pause'+(index+1)+'StoresCumulativeActiveTime', `currentConv.turns.at(-1).status==='paused'&&currentConv.turns.at(-1).taskRun.elapsedMs===${[36000,70000,103000][index]}&&$('btnSend').classList.contains('is-resume')`);
    await check('Pause'+(index+1)+'HasOnlyLatestStatusAndClock', `[...document.querySelectorAll('.process-summary-title')].filter(e=>e.textContent==='已暂停').length===1&&[...document.querySelectorAll('.process-summary-meta')].filter(e=>e.textContent.includes('用时')).length===1&&[...document.querySelectorAll('.process-summary-title')].filter(e=>e.textContent==='此前过程').length===${index}`);
    await act('steerReview.now+=3600000;'); await settle();
    await check('Pause'+(index+1)+'DoesNotCountAnHourWaiting', `RelayTaskContinuity.activeDuration(currentConv.turns.at(-1).taskRun)===${[36000,70000,103000][index]}`);
    if (index<2) {
      await act("$('btnSend').click();");
      await waitFor(`runs.size===1&&steerReview.launches.length===steerReview.launchBase+${index+2}`);
      await check('Resume'+(index+1)+'KeepsTaskAndHidesInternalPrompt', `currentConv.turns.at(-1).user===''&&RelayTaskContinuity.isResume(currentConv.turns.at(-1))&&currentConv.turns.at(-1).taskRun.taskId===steerReview.continuityTask&&steerReview.launches.at(-1)[0].includes(RelayTaskContinuity.RESUME_PROMPT)&&steerReview.launches.at(-1)[13].inputKind==='resume'&&steerReview.launches.at(-1)[13].taskRun.elapsedBeforeMs===${[36000,70000][index]}&&document.querySelectorAll('.message.user').length===1`);
    }
  }
  await check('AllThreeWorkLogsRemainOrdered','[...document.querySelectorAll(".process-items")].map(e=>e.textContent).join("|").match(/第 1 段.*第 2 段.*第 3 段/s)');
  await check('PauseStatusNoteIsRemoved','!document.getElementById("conversationControlNote")&&!document.body.textContent.includes("正在暂停，保留当前上下文")');
  await act('startNewConv();');
  await evaluate('loadConversation(steerReview.continuityId)');await settle();
  await check('HistoryReopenKeepsOneCumulativeClock','currentConv.turns.length===3&&document.querySelectorAll(".message.user").length===1&&[...document.querySelectorAll(".process-summary-title")].filter(e=>e.textContent==="已暂停").length===1&&[...document.querySelectorAll(".process-summary-title")].filter(e=>e.textContent==="此前过程").length===2&&[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1&&[...document.querySelectorAll(".process-summary-meta")].some(e=>e.textContent.includes("1m 43s"))');
  await capture('pause-resume-cumulative');
  await act("steerReview.failNextLaunch=true;$('btnSend').click();");
  await waitFor('runs.size===0&&steerReview.launches.length===steerReview.launchBase+4&&currentConv.turns.at(-1).status==="error"');
  await check('FailedExplicitResumeRemainsRecoverable','currentConv.paused.runId===currentConv.turns.at(-1).runId&&currentConv.turns.at(-1).taskRun.elapsedMs===108000&&RelayTaskContinuity.isResume(currentConv.turns.at(-1))&&document.querySelectorAll(".message.user").length===1&&document.querySelector(".message.error")');
  await act("steerReview.now+=3600000;$('btnSend').click();");
  await waitFor('runs.size===1&&steerReview.launches.length===steerReview.launchBase+5');
  await check('RetryFailedResumeExcludesPauseAndKeepsTask','runs.get(currentConv.id).taskRun.taskId===steerReview.continuityTask&&runs.get(currentConv.id).taskRun.elapsedBeforeMs===108000');
  await act('steerReview.retrySource=runs.get(currentConv.id);steerReview.now+=2000;steerReview.emit({jobId:steerReview.retrySource.jobId,type:"stderr",text:"No conversation found with session ID synthetic-live-session"});steerReview.emit({jobId:steerReview.retrySource.jobId,type:"job-done",exitCode:1});');
  await waitFor('runs.size===1&&steerReview.launches.length===steerReview.launchBase+6&&runs.get(currentConv.id).autoRetried');
  await check('LostSessionRetryReusesSameActiveSegment','steerReview.launches.at(-1)[13].inputKind==="resume"&&steerReview.launches.at(-1)[13].retryOfRunId===steerReview.retrySource.jobId&&runs.get(currentConv.id).taskRun.taskId===steerReview.continuityTask&&runs.get(currentConv.id).taskRun.segmentStartedAt===steerReview.retrySource.taskRun.segmentStartedAt&&runs.get(currentConv.id).taskRun.elapsedBeforeMs===108000&&currentConv.turns.at(-1).user===""&&RelayTaskContinuity.isResume(currentConv.turns.at(-1))');
  await act('steerReview.now+=3000;steerReview.finish(runs.get(currentConv.id).jobId,"累计任务交付");');await waitFor('runs.size===0');
  await check('RetryTimeIsIncludedOnceInDelivery','currentConv.turns.at(-1).taskRun.elapsedMs===113000&&[...document.querySelectorAll(".process-summary-meta")].filter(e=>e.textContent.includes("用时")).length===1');
  await act("$('input').value=RelayTaskContinuity.RESUME_PROMPT;$('btnSend').click();");
  await waitFor('runs.size===1&&steerReview.launches.length===steerReview.launchBase+7');
  await check('ManuallyTypedSamePromptStartsIndependentVisibleTask','currentConv.turns.at(-1).user===RelayTaskContinuity.RESUME_PROMPT&&!RelayTaskContinuity.isResume(currentConv.turns.at(-1))&&currentConv.turns.at(-1).taskRun.taskId!==steerReview.continuityTask&&currentConv.turns.at(-1).taskRun.elapsedBeforeMs===0&&document.querySelectorAll(".message.user").length===2');
  await act('steerReview.now+=1000;steerReview.finish(runs.get(currentConv.id).jobId,"独立请求的合成回复");');await waitFor('runs.size===0');
  await evaluate('loadConversation(steerReview.continuityId,null,{forceReload:true})');await settle();
  await check('OrdinarySameTextRemainsVisibleAfterReopen','document.querySelectorAll(".message.user").length===2&&[...document.querySelectorAll(".message.user")].some(e=>e.textContent.includes(RelayTaskContinuity.RESUME_PROMPT))');
  await act('Date.now=steerReview.realNow;');

  await check('NoRendererErrorsOrUnsafeRuntimeExposure','uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));console.error(error);if(win&&!win.isDestroyed())try{console.error(await evaluate('JSON.stringify({errors:uiFixture.errors,turns:currentConv?.turns.map(t=>({runId:t.runId,status:t.status,taskRun:t.taskRun})),paused:currentConv?.paused,launchCount:steerReview.launches.length,active:[...runs.values()].map(r=>({jobId:r.jobId,error:r.error,stderr:r.stderrBuf,taskRun:r.taskRun,finishError:String(r.finishError||"")}))})'));await capture('failure');}catch(_){}save();clearTimeout(deadline);app.exit(1);});
