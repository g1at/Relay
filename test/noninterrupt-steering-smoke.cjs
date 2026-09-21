'use strict';
// Production renderer in an isolated Electron profile. Model events, workspace
// files and every backend endpoint are synthetic; no Relay main or SDK is run.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mergeSupplementHistory } = require('../live-supplement-input');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/noninterrupt-steering-smoke');
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
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6500;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20);};tick();})`);
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

  await act("$('input').value='检查本地项目并整理报告';$('btnSend').click();");
  await waitFor('steerReview.launches.length===1&&runs.size===1');
  await act("steerReview.origin=currentConv.id;steerReview.originalRun=runs.get(currentConv.id);steerReview.job=steerReview.originalRun.jobId;");
  await check('EmptyBusyComposerOffersManualPause', '!$("btnPause")&&$("btnSend").classList.contains("is-stop")&&$("btnSend").title.includes("暂停")');
  await act("steerReview.emit({jobId:steerReview.job,type:'assistant',message:{id:'work-start',content:[{type:'text',text:'正在检查文件。'},{type:'tool_use',id:'active-read',name:'Read',input:{file_path:'synthetic.md'}}]}});");
  await settle();
  await act("$('input').value='先关注第二个模块';$('input').dispatchEvent(new Event('input',{bubbles:true}));");
  await check('TypingUsesSendOnTheSameBusyButton', '!$("btnSend").classList.contains("is-stop")&&$("btnSend").title.includes("调整方向")');
  await act("$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  await waitFor('steerReview.steers.length===1&&!conversationControls.size&&(currentConv.turns[0].supplements||[]).length===1');
  await check('FirstSupplementNeverInterruptsOrStartsAnotherRun', 'steerReview.pauses.length===0&&steerReview.launches.length===1&&runs.get(steerReview.origin)===steerReview.originalRun&&!steerReview.originalRun.finishing&&currentConv.turns.length===1');
  await check('SteerRequestTargetsTheActiveRun', 'steerReview.steers[0].jobId===steerReview.job&&steerReview.steers[0].conversationId===steerReview.origin&&!!steerReview.steers[0].messageId&&steerReview.steers[0].prompt==="先关注第二个模块"');
  await check('ActiveToolIsNotCanceledBySupplement', 'steerReview.originalRun.activityState.items.some(item=>item.toolUseId==="active-read"&&!item.result)&&!steerReview.originalRun.abortRequested&&!steerReview.originalRun.pauseRequested');
  await check('EventAndReceiptRenderOneSupplement', 'document.querySelectorAll(".message.user[data-supplement-id]").length===1&&document.querySelector(".message.user[data-supplement-id]").dataset.supplementId===steerReview.steers[0].messageId');

  await act("attachedFiles=[{path:'C:/Synthetic/requirements.txt',name:'requirements.txt',ext:'.txt',size:12}];renderAttachments();setSelectedQuickSkill({name:'review',displayName:'审查',callName:'review'});$('input').value='结果请用中文说明';$('input').dispatchEvent(new Event('input',{bubbles:true}));$('btnSend').click();");
  await waitFor('steerReview.steers.length===2&&!conversationControls.size&&(currentConv.turns[0].supplements||[]).length===2');
  await check('ConsecutiveSupplementsKeepOneTurnAndRun', 'steerReview.launches.length===1&&steerReview.pauses.length===0&&currentConv.turns.length===1&&runs.get(steerReview.origin)===steerReview.originalRun&&new Set(steerReview.steers.map(item=>item.messageId)).size===2');
  await check('SupplementIncludesCapturedFilesAndSkill', 'steerReview.steers[1].files[0].path==="C:/Synthetic/requirements.txt"&&steerReview.steers[1].skill.name==="review"&&currentConv.turns[0].supplements[1].files[0].name==="requirements.txt"');
  await act("steerReview.firstApplied={...steerReview.inputs.get(steerReview.steers[0].messageId),status:'applied'};steerReview.inputEvent(steerReview.job,steerReview.firstApplied);steerReview.inputEvent(steerReview.job,steerReview.firstApplied);");
  await waitFor('currentConv.turns[0].supplements[0].status==="applied"');
  await check('StatusChangesAndRepeatedEventsAreIdempotent', 'currentConv.turns[0].supplements.length===2&&document.querySelectorAll(".message.user[data-supplement-id]").length===2');

  await act("steerReview.plans.push({hold:true});$('input').value='把结论放在最前面';$('btnSend').click();");
  await waitFor('steerReview.pending.length===1');
  await act("$('input').value='稍后再发送的草稿';$('input').dispatchEvent(new Event('input',{bubbles:true}));$('btnSend').click();");
  await check('PendingReceiptDoesNotDuplicateSubmission', 'steerReview.steers.length===3&&steerReview.launches.length===1&&steerReview.pauses.length===0&&$("input").value==="稍后再发送的草稿"');
  await evaluate("steerReview.inputEvent(steerReview.job,{...steerReview.inputs.get(steerReview.steers[2].messageId),status:'applied'}).then(()=>steerReview.release())");
  await waitFor('!conversationControls.size&&(currentConv.turns[0].supplements||[]).length===3');
  await check('LateReceiptPreservesNewComposerDraft', '$("input").value==="稍后再发送的草稿"&&document.querySelectorAll(".message.user[data-supplement-id]").length===3&&runs.get(steerReview.origin)===steerReview.originalRun');
  await check('LateQueuedReceiptCannotRegressAppliedStatus', 'currentConv.turns[0].supplements[2].status==="applied"');

  await act("steerReview.plans.push({hold:true,emit:'deferred'});$('input').value='检查边界条件';$('btnSend').click();");
  await waitFor('steerReview.pending.length===1');
  await act("startNewConv();$('input').value='另一个对话的草稿';steerReview.release();");
  await waitFor('!conversationControls.size');
  await check('NavigationDoesNotRedirectAcceptedSupplement', '!currentConv&&$("input").value==="另一个对话的草稿"&&steerReview.launches.length===1&&steerReview.steers[3].conversationId===steerReview.origin&&!document.querySelector("[data-supplement-id]")');
  await evaluate('window.api.history.load(steerReview.origin).then(conv=>steerReview.savedOrigin=conv)');
  await check('NavigationSavesSupplementOnlyToItsOrigin', 'steerReview.savedOrigin.turns.length===1&&steerReview.savedOrigin.turns[0].supplements.length===4&&steerReview.savedOrigin.turns[0].supplements[3].text==="检查边界条件"');
  await evaluate('loadConversation(steerReview.origin)'); await settle();
  await check('ReopeningActiveConversationRestoresSupplements', 'runs.get(steerReview.origin)===steerReview.originalRun&&document.querySelectorAll(".message.user[data-supplement-id]").length===4&&currentConv.turns.length===1');

  await act("steerReview.plans.push({reject:true});$('input').value='失败后保留的补充';$('btnSend').click();");
  await waitFor('!conversationControls.size&&supplementDrafts.has(steerReview.origin)');
  await check('RejectedInputStaysRetryableWithoutInterruptingTask', 'steerReview.launches.length===1&&steerReview.pauses.length===0&&runs.get(steerReview.origin)===steerReview.originalRun&&currentConv.turns[0].supplements.length===4&&supplementDrafts.get(steerReview.origin).prompt==="失败后保留的补充"');
  await act("$('btnSend').click();");
  await waitFor('!conversationControls.size&&!supplementDrafts.has(steerReview.origin)&&currentConv.turns[0].supplements.length===5');
  await check('RetryStillInjectsIntoOriginalRunningTask', 'steerReview.launches.length===1&&steerReview.pauses.length===0&&steerReview.steers.at(-1).jobId===steerReview.job&&currentConv.turns.length===1');

  await act("steerReview.plans.push({hold:true});$('input').value='最终答案补上验证范围';$('btnSend').click();");
  await waitFor('steerReview.pending.length===1');
  await act("steerReview.answer='# 检查完成\\n\\n**验证范围**：第二模块和边界条件。';steerReview.emit({jobId:steerReview.job,type:'user',message:{content:[{type:'tool_result',tool_use_id:'active-read',content:'synthetic file content'}]}});steerReview.stream(steerReview.job,'final-answer',steerReview.answer);steerReview.holdFinalSave=true;steerReview.finish(steerReview.job,steerReview.answer);");
  await waitFor('!!steerReview.releaseFinalSave');
  await act('steerReview.release();'); await settle();
  await check('LateAcceptedReceiptCannotStartWorkWhileFinalSaveWaits', 'steerReview.launches.length===1&&steerReview.pauses.length===0&&steerReview.originalRun.finishing');
  await act('steerReview.releaseFinalSave();');
  await waitFor('runs.size===0&&!conversationControls.size'); await settle();
  await check('OneFinalAnswerAfterAllSupplements', 'currentConv.turns.length===1&&currentConv.turns[0].assistant===steerReview.answer&&currentConv.turns[0].supplements.length===6&&document.querySelectorAll(".message.assistant:not(.thinking-indicator)").length===1&&document.querySelectorAll(".assistant-copy").length===1');
  await evaluate('window.api.history.load(steerReview.origin).then(conv=>steerReview.savedOrigin=conv)');
  await check('LateReceiptCannotOverwriteSavedFinalAnswer', 'steerReview.savedOrigin.turns[0].assistant===steerReview.answer&&steerReview.savedOrigin.turns[0].supplements.length===6&&!steerReview.savedOrigin.paused');
  await check('FinalizedInputStatusesSurviveLateQueuedReceipt', 'steerReview.savedOrigin.turns[0].supplements.every(input=>input.status==="applied")&&currentConv.turns[0].supplements.every(input=>input.status==="applied")');
  await check('SupplementStatusUsesCompactMessageMetadata', '[...document.querySelectorAll(".message.user[data-supplement-id]")].every(message=>{const status=message.querySelector(".supplement-status"),bubble=message.querySelector(".bubble");return status&&status.parentElement.classList.contains("message-meta")&&bubble&&status.parentElement.getBoundingClientRect().top-bubble.getBoundingClientRect().bottom<12})');
  await capture('one-task-supplements-light');
  await evaluate('loadConversation(steerReview.origin,null,{forceReload:true})'); await settle();
  await check('HistoryRestoresOneFinalAndEachSupplementExactlyOnce', 'currentConv.turns.length===1&&document.querySelectorAll(".message.user[data-supplement-id]").length===6&&document.querySelectorAll(".message.assistant").length===1&&document.querySelectorAll(".assistant-copy").length===1');
  await act("document.querySelector('.assistant-copy').click();");
  await waitFor('steerReview.copied.length===1');
  await check('FinalCopyContainsOnlyTheAnswer', 'steerReview.copied[0]===steerReview.answer');

  // A rejection arriving after natural completion must remain a draft; it must
  // never silently become a new model run just because the old run disappeared.
  await act("$('input').value='第二个合成任务';$('btnSend').click();");
  await waitFor('steerReview.launches.length===2&&runs.size===1');
  await act("steerReview.secondJob=runs.get(currentConv.id).jobId;steerReview.plans.push({hold:true,reject:true});$('input').value='结束时仍未接收的补充';$('btnSend').click();");
  await waitFor('steerReview.pending.length===1');
  await act("steerReview.finish(steerReview.secondJob,'第二个任务的完整结果');");
  await waitFor('runs.size===0');
  await act('steerReview.release();'); await waitFor('!conversationControls.size');
  await check('RejectedLateReceiptNeverRelaunchesAfterFinal', 'steerReview.launches.length===2&&steerReview.pauses.length===0&&currentConv.turns.at(-1).assistant==="第二个任务的完整结果"&&supplementDrafts.get(steerReview.origin)?.prompt==="结束时仍未接收的补充"');

  // Explicit blank-composer pause remains a separate, deliberate action.
  await act("supplementDrafts.delete(steerReview.origin);$('input').value='手动暂停验证';$('btnSend').click();");
  await waitFor('steerReview.launches.length===3&&runs.size===1');
  await act("steerReview.beforeUncertain=steerReview.steers.length;steerReview.plans.push({throwAfterAccept:true});$('input').value='回执丢失但已经接收的补充';$('btnSend').click();");
  await waitFor('!conversationControls.size&&steerReview.steers.length===steerReview.beforeUncertain+1');
  await check('AcceptedEventWinsLostInvokeReceiptWithoutResend', 'steerReview.launches.length===3&&steerReview.pauses.length===0&&runs.size===1&&!supplementDrafts.has(steerReview.origin)&&currentConv.turns.at(-1).supplements.length===1&&currentConv.turns.at(-1).supplements[0].text==="回执丢失但已经接收的补充"');
  await act("$('input').value='';$('input').dispatchEvent(new Event('input',{bubbles:true}));$('btnSend').click();");
  await waitFor('runs.size===0&&!conversationControls.size');
  await check('OnlyExplicitBlankButtonInvokesPause', 'steerReview.pauses.length===1&&steerReview.launches.length===3&&!!currentConv.paused&&$("btnSend").classList.contains("is-resume")');
  win.setSize(900, 640); await act("document.documentElement.dataset.theme='dark';"); await settle();
  await check('CompactSupplementHistoryDoesNotOverflow', 'document.documentElement.scrollWidth<=innerWidth&&$("btnSend").getBoundingClientRect().right<=innerWidth');
  await capture('history-dark-compact');

  // Both the original acceptance event and its invoke response are lost. The
  // backend still owns the input; a retry after completion must be a query by
  // the original job and message IDs, never an automatic new model turn.
  await act("startNewConv();$('input').value='回执重试归属验证';$('btnSend').click();");
  await waitFor('runs.size===1');
  await act("steerReview.lostConv=currentConv.id;steerReview.lostJob=runs.get(currentConv.id).jobId;steerReview.plans.push({silentAccept:true,throwAfterAccept:true});$('input').value='不可重复投递的补充要求';$('btnSend').click();");
  await waitFor('!conversationControls.size&&supplementDrafts.has(steerReview.lostConv)');
  await act('steerReview.lostDraft=supplementDrafts.get(steerReview.lostConv);');
  await check('LostEventAndReceiptKeepTheOriginalSubmissionIdentity', 'steerReview.lostDraft.jobId===steerReview.lostJob&&steerReview.inputs.has(steerReview.lostDraft.messageId)&&!(currentConv.turns[0].supplements||[]).length&&!document.querySelector("[data-supplement-id]")');
  await act("steerReview.finish(steerReview.lostJob,'原任务已完成，最终答案必须保留');");
  await waitFor('runs.size===0');
  await check('FinalDoesNotInventAMissingAcceptanceEvent', 'supplementDrafts.get(steerReview.lostConv)===steerReview.lostDraft&&currentConv.turns[0].assistant==="原任务已完成，最终答案必须保留"&&!document.querySelector("[data-supplement-id]")');
  await act("steerReview.beforeLostRetry={steers:steerReview.steers.length,launches:steerReview.launches.length,pauses:steerReview.pauses.length};$('btnSend').click();");
  await waitFor('!conversationControls.size&&!supplementDrafts.has(steerReview.lostConv)');
  await check('LostBothRetryQueriesOldJobWithSameMessageId', 'steerReview.steers.length===steerReview.beforeLostRetry.steers+1&&steerReview.steers.at(-1).jobId===steerReview.lostJob&&steerReview.steers.at(-1).messageId===steerReview.lostDraft.messageId');
  await check('IdempotentLateRetryDoesNotRestartOrPauseAnything', 'steerReview.launches.length===steerReview.beforeLostRetry.launches&&steerReview.pauses.length===steerReview.beforeLostRetry.pauses&&runs.size===0&&currentConv.turns.length===1&&currentConv.turns[0].assistant==="原任务已完成，最终答案必须保留"');
  await evaluate('window.api.history.load(steerReview.lostConv).then(conv=>steerReview.lostSaved=conv)');
  await check('RecoveredAcceptanceHasOneBubbleAndOneSavedRecord', 'document.querySelectorAll(".message.user[data-supplement-id]").length===1&&document.querySelectorAll(".message.assistant").length===1&&steerReview.lostSaved.turns[0].supplements.length===1&&steerReview.lostSaved.turns[0].supplements[0].id===steerReview.lostDraft.messageId');
  await capture('lost-receipt-recovered-dark');

  // Later delivery failures restore an explicit draft, but never replace a
  // different input that the user is already trying to send.
  await act("$('input').value='异步拒绝状态验证';$('btnSend').click();");
  await waitFor('runs.size===1');
  await act("steerReview.statusJob=runs.get(currentConv.id).jobId;$('input').value='取消后需要重试的补充';$('btnSend').click();");
  await waitFor('!conversationControls.size&&currentConv.turns.at(-1).supplements?.length===1');
  await evaluate("steerReview.inputEvent(steerReview.statusJob,{...currentConv.turns.at(-1).supplements[0],status:'canceled'})");
  await check('AsyncCanceledInputRestoresRetryableDraft', '$("input").value==="取消后需要重试的补充"&&!supplementDrafts.has(steerReview.lostConv)&&(!$("conversationControlNote")||$("conversationControlNote").hidden)&&currentConv.turns.at(-1).supplements[0].status==="canceled"');
  await act("$('input').value='';attachedFiles=[];setSelectedQuickSkill(null);autoGrowInput();$('input').value='拒绝后需要重试的补充';$('btnSend').click();");
  await waitFor('!conversationControls.size&&currentConv.turns.at(-1).supplements?.length===2');
  await evaluate("steerReview.inputEvent(steerReview.statusJob,{...currentConv.turns.at(-1).supplements[1],status:'rejected'})");
  await check('AsyncRejectedInputRestoresRetryableDraft', '$("input").value==="拒绝后需要重试的补充"&&!supplementDrafts.has(steerReview.lostConv)&&(!$("conversationControlNote")||$("conversationControlNote").hidden)&&currentConv.turns.at(-1).supplements[1].status==="rejected"');
  await act("$('input').value='';attachedFiles=[];setSelectedQuickSkill(null);autoGrowInput();$('input').value='稍后才被取消的补充';$('btnSend').click();");
  await waitFor('!conversationControls.size&&currentConv.turns.at(-1).supplements?.length===3');
  await act("steerReview.plans.push({reject:true});$('input').value='用户正在重试的另一条草稿';$('btnSend').click();");
  await waitFor('!conversationControls.size&&supplementDrafts.has(steerReview.lostConv)');
  await act('steerReview.otherDraft=supplementDrafts.get(steerReview.lostConv);');
  await evaluate("steerReview.inputEvent(steerReview.statusJob,{...currentConv.turns.at(-1).supplements[2],status:'canceled'})");
  await check('LateDeliveryFailurePreservesAnotherPendingDraft', 'supplementDrafts.get(steerReview.lostConv)===steerReview.otherDraft&&steerReview.otherDraft.prompt==="用户正在重试的另一条草稿"&&steerReview.otherDraft.sendAsNew!==true');
  await act("steerReview.finish(steerReview.statusJob,'异步拒绝状态验证完成');"); await waitFor('runs.size===0');
  // Mid-text interruption: the same assistant message keeps streaming across
  // two send-time cuts. Both live and reloaded views retain chronological order.
  await act("supplementDrafts.clear();startNewConv();$('input').value='请给我安排周末两日游';$('btnSend').click();");
  await waitFor('runs.size===1&&!conversationControls.size');
  await act("steerReview.timelineConv=currentConv.id;steerReview.timelineRun=runs.get(currentConv.id);steerReview.timelineJob=steerReview.timelineRun.jobId;steerReview.prefix='# 周末安排\\n\\n这是插话前已经输出的内容。\\n\\n';steerReview.stream(steerReview.timelineJob,'timeline-answer',steerReview.prefix);");
  await settle();
  await act("$('input').value='改成一天的日程吧';$('btnSend').click();");
  await waitFor('currentConv.turns[0].supplements?.length===1&&!conversationControls.size');
  await check('SendCapturesExactVisibleTextBoundary', 'currentConv.turns[0].supplements[0].presentation.messageId==="timeline-answer"&&currentConv.turns[0].supplements[0].presentation.textLength===steerReview.prefix.length');
  await check('SupplementAppearsAfterAlreadyStreamedText', '(()=>{const p=document.querySelector(".process-item.is-narration"),u=document.querySelector("[data-supplement-id]");return !document.querySelector(".message.assistant")&&p._processItem.result===steerReview.prefix&&!!(p.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING)})()');
  await act("steerReview.prefixNode=document.querySelector('.process-item.is-narration');steerReview.middle='## 一天路线\\n\\n上午逛古镇，下午看展览。\\n\\n';steerReview.emit({jobId:steerReview.timelineJob,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:steerReview.middle}}});");
  await settle();
  await check('SameMessageContinuesBelowTheInterruptionWithoutMovingPrefix', '(()=>{const a=[...document.querySelectorAll(".process-item.is-narration")],u=document.querySelector("[data-supplement-id]");return a.length===2&&a[0]===steerReview.prefixNode&&a[0]._processItem.result===steerReview.prefix&&a[1]._processItem.result===steerReview.middle&&!!(u.compareDocumentPosition(a[1])&Node.DOCUMENT_POSITION_FOLLOWING)})()');
  await act('startNewConv();');
  await evaluate('loadConversation(steerReview.timelineConv,null,{forceReload:true})'); await settle();
  await check('SwitchAwayAndBackKeepsLiveTimelineOrder', '[...document.querySelectorAll(".process-item.is-narration,.message.user[data-supplement-id]")].map(n=>n.classList.contains("is-narration")?n._processItem.result:n.textContent).every((text,index)=>index===0?text===steerReview.prefix:index===1?text.includes("改成一天"):text===steerReview.middle)');
  await act("$('input').value='不要安排购物';$('btnSend').click();");
  await waitFor('currentConv.turns[0].supplements?.length===2&&!conversationControls.size');
  await act("steerReview.suffix='## 调整确认\\n\\n仅一天，不含购物安排。';steerReview.emit({jobId:steerReview.timelineJob,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:steerReview.suffix}}});");
  await settle();
  await check('TwoInterruptionsCreateThreeOrderedTextSegments', '[...document.querySelectorAll(".process-item.is-narration")].map(n=>n._processItem.result).join("|")===[steerReview.prefix,steerReview.middle,steerReview.suffix].join("|")&&!document.querySelector(".message.assistant")&&document.querySelectorAll(".assistant-copy").length===0');
  await act("steerReview.timelineAnswer=steerReview.prefix+steerReview.middle+steerReview.suffix;steerReview.finish(steerReview.timelineJob,steerReview.timelineAnswer);");
  await waitFor('runs.size===0'); await settle();
  await check('FinalKeepsSegmentsAndOffersOneCompleteCopy', 'document.querySelectorAll(".message.assistant").length===3&&document.querySelectorAll(".assistant-copy").length===1&&currentConv.turns[0].assistant===steerReview.timelineAnswer');
  await evaluate('loadConversation(steerReview.timelineConv,null,{forceReload:true})'); await settle();
  await check('SavedTimelineRestoresAtBothSendBoundaries', '[...document.querySelectorAll(".message.assistant,.message.user[data-supplement-id]")].map(n=>n.classList.contains("assistant")?"answer":"input").join(",")==="answer,input,answer,input,answer"&&[...document.querySelectorAll(".message.assistant")].map(n=>n.dataset.raw).join("")===steerReview.timelineAnswer');
  await act("document.querySelector('.assistant-copy').click();"); await settle();
  await check('SegmentedFinalCopiesCanonicalAnswerWithoutLoss', 'steerReview.copied.at(-1)===steerReview.timelineAnswer');
  await capture('midstream-supplement-timeline');
  await act("$('input').value='生成一段代码';$('btnSend').click();");
  await waitFor('runs.size===1');
  await act("steerReview.codeJob=runs.get(currentConv.id).jobId;steerReview.codePrefix='# Code\\n\\n```js\\nconst value = ';steerReview.codeSuffix='42;\\n```\\n\\nDone';steerReview.stream(steerReview.codeJob,'code-stream',steerReview.codePrefix);");
  await settle();
  await act("$('input').value='把数字改成 42';$('btnSend').click();");
  await waitFor('currentConv.turns.at(-1).supplements?.length===1&&!conversationControls.size');
  await act("steerReview.emit({jobId:steerReview.codeJob,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:steerReview.codeSuffix}}});");
  await settle();
  await check('CodeFenceRetainsFormattingAcrossInterruption', '(()=>{const a=[...document.querySelectorAll(".process-item.is-narration")].filter(n=>n.closest(".process-stream").dataset.turn==="1");return a.length===2&&a[0].querySelector("pre code")?.textContent.includes("const value =")&&a[1].querySelector("pre code")?.textContent.includes("42;")&&[...a[1].querySelectorAll(".body p")].some(n=>n.textContent==="Done")})()');
  await act('startNewConv();');
  await evaluate('loadConversation(steerReview.timelineConv,null,{forceReload:true})'); await settle();
  await check('ViewSwitchDoesNotFlushRawSplitFenceSyntax', '(()=>{const a=[...document.querySelectorAll(".process-item.is-narration")].filter(n=>n.closest(".process-stream").dataset.turn==="1");return a.length===2&&a[1].querySelector("pre code")?.textContent.includes("42;")&&[...a[1].querySelectorAll(".body p")].some(n=>n.textContent==="Done")})()');
  await act('steerReview.finish(steerReview.codeJob,steerReview.codePrefix+steerReview.codeSuffix);');
  await waitFor('runs.size===0'); await settle();
  await evaluate('loadConversation(steerReview.timelineConv,null,{forceReload:true})'); await settle();
  await act('[...document.querySelectorAll(".message.assistant .assistant-copy")].at(-1).click();'); await settle();
  await check('CopiedCodeContainsOriginalSingleFencePair', 'steerReview.copied.at(-1)===steerReview.codePrefix+steerReview.codeSuffix');
  // SDK results are round boundaries; retry notices follow the current work.
  await act("startNewConv();$('input').value='合成阶段输出与重试';$('btnSend').click();");
  await waitFor('runs.size===1');
  await act("steerReview.phaseJob=runs.get(currentConv.id).jobId;steerReview.stream(steerReview.phaseJob,'phase-one','第一阶段进度');");
  await settle();
  await act("steerReview.phaseNode=document.querySelector('.process-item.is-narration');steerReview.emit({jobId:steerReview.phaseJob,type:'result',subtype:'success',result:'第一阶段进度'});");
  await settle();
  await check('StageResultKeepsTheSameProcessNodeWithoutFinalFlash', 'runs.size===1&&!document.querySelector(".message.assistant")&&document.querySelector(".process-item.is-narration")===steerReview.phaseNode&&steerReview.phaseNode.textContent.includes("第一阶段进度")');
  await act("steerReview.emit({jobId:steerReview.phaseJob,type:'system',subtype:'api_retry',error_status:429,attempt:1});steerReview.stream(steerReview.phaseJob,'phase-two','第二阶段继续处理');");
  await settle();
  await act("steerReview.emit({jobId:steerReview.phaseJob,type:'system',subtype:'api_retry',error_status:429,attempt:2});");
  await settle();
  await check('RepeatedRetryMovesBehindCurrentStream', '(()=>{const rows=[...document.querySelectorAll(".process-item")];return rows.at(-1).dataset.processId==="relay-api-retry"&&rows.at(-2).textContent.includes("第二阶段继续处理")&&rows.filter(n=>n.dataset.processId==="relay-api-retry").length===1})()');
  await act("$('input').value='补充重试后的要求';$('btnSend').click();");
  await waitFor('currentConv.turns[0].supplements?.length===1&&!conversationControls.size');
  await act("steerReview.emit({jobId:steerReview.phaseJob,type:'system',subtype:'api_retry',error_status:429,attempt:3});");
  await settle();
  await check('RetryMovesToTheCurrentSegmentAfterAnInTurnInput', '(()=>{const row=document.querySelector("[data-process-id=relay-api-retry]"),input=document.querySelector("[data-supplement-id]");return !!(input.compareDocumentPosition(row)&Node.DOCUMENT_POSITION_FOLLOWING)&&row.closest(".process-stream").dataset.segment==="current"&&!document.querySelector(".message.assistant")})()');
  await act("steerReview.finish(steerReview.phaseJob,'任务最终交付');");
  await waitFor('runs.size===0'); await settle();
  await check('OnlyJobDonePromotesTheConfirmedAnswer', 'document.querySelectorAll(".message.assistant").length===1&&document.querySelector(".message.assistant").dataset.raw==="任务最终交付"');
  await check('NoRendererErrorsOrUnsafeRuntimeExposure', 'uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  errors.push(String(error.stack || error)); console.error(error);
  if (win && !win.isDestroyed()) {
    try { console.error(await evaluate('JSON.stringify({errors:uiFixture.errors,steers:steerReview.steers.length,pauses:steerReview.pauses.length,launches:steerReview.launches.length})')); await capture('failure'); } catch (_) {}
  }
  save(); clearTimeout(deadline); app.exit(1);
});
