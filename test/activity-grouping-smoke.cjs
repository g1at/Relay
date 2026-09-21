'use strict';
// Real activity renderer and styles in an isolated Electron profile; no main process or user data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/activity-grouping-smoke');
fs.mkdirSync(output, { recursive: true });app.setPath('userData', path.join(output, 'profile'));app.commandLine.appendSwitch('disable-gpu');
let win, step='start';const checks={}, errors=[], timing={};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({step,checks,errors,timing},null,2));
const deadline=setTimeout(()=>{errors.push('timeout at '+step);save();app.exit(1);},90000);
const evaluate=code=>win.webContents.executeJavaScript(code);
const act=code=>evaluate(`(()=>{${code}\n})()`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,code){step=name;checks[name]=!!await evaluate(code);save();console.log(name+': '+checks[name]);if(!checks[name]){console.log(await evaluate('JSON.stringify({active:document.activeElement.outerHTML.slice(0,200),rowSame:row("read-1")===review.firstRow,expanded:review.firstRow?.className,group:review.group?.className||stream.querySelector(".process-tool-group")?.className,inspectorSame:review.firstRow?.querySelector(".is-result pre")===review.firstInspector,oldScroll:review.oldScroll,scroll:review.firstInspector?.scrollTop})'));throw Error(name);}}
async function capture(name){await delay(260);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  win=new BrowserWindow({width:1040,height:800,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="host"></main></body></html>'));
  for(const file of ['styles.css','conversation-stream.css','read-only-markdown.css'])await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer',file),'utf8'));
  await win.webContents.insertCSS('body{display:block;height:100vh;overflow:auto;background:var(--bg)}#host{width:min(740px,calc(100vw - 40px));margin:32px auto;min-width:0}');
  for(const file of ['vendor/marked.umd.js','vendor/highlight.min.js','stream-markdown.js'])await evaluate(fs.readFileSync(path.join(root,'renderer',file),'utf8')+'\nvoid 0;');
  const appSource=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
  await evaluate(appSource.slice(0,appSource.indexOf('const messagesEl ='))+'\nvoid 0;');
  for(const file of ['read-only-markdown.js','task-continuity.js','activity-stream.js'])await evaluate(fs.readFileSync(path.join(root,'renderer',file),'utf8')+'\nvoid 0;');
  await act(`window.review={errors:[],rendererCalls:0};window.addEventListener('error',e=>review.errors.push(e.message));const renderer=relayRenderReadOnlyMarkdown;review.originalRenderer=renderer;window.relayRenderReadOnlyMarkdown=(...args)=>{review.rendererCalls++;renderer(...args);};
    window.call=(id,name='Read',status='success')=>({id,type:'tool',toolName:name,title:name==='Read'?'读取 '+id+'.txt':'运行命令',input:name==='Read'?{file_path:id+'.txt'}:{command:'echo '+id},status,result:Array.from({length:70},(_,i)=>id+' result '+i).join('\\n')});
    window.state=RelayActivity.createState({items:[call('read-1')]});window.stream=RelayActivity.createElement(state);document.getElementById('host').append(stream);
    window.row=id=>stream.querySelector('[data-process-id="'+id+'"]');window.update=()=>RelayActivity.updateElement(stream,state,{collapseOnComplete:false});
  `);win.showInactive();
  await check('OneCallRemainsDirectlyVisible','!stream.querySelector(".process-tool-group")&&row("read-1").parentElement.classList.contains("process-items")');
  await act(`row('read-1').click();row('read-1').focus();review.firstRow=row('read-1');review.firstInspector=review.firstRow.querySelector('.process-inspect-section.is-result pre');review.firstInspector.scrollTop=100;review.oldScroll=review.firstInspector.scrollTop;state.items.push(call('read-2','Read','running'));update();`);
  await delay(260);
  await check('GroupingRetainsOpenedCallFocusNodeAndScroll','row("read-1")===review.firstRow&&document.activeElement===review.firstRow&&review.firstRow.classList.contains("is-expanded")&&stream.querySelector(".process-tool-group").classList.contains("is-expanded")&&review.firstRow.querySelector(".is-result pre")===review.firstInspector&&review.firstInspector.scrollTop===review.oldScroll');
  await act(`review.group=stream.querySelector('.process-tool-group');review.header=review.group.querySelector('button');review.secondRow=row('read-2');row('read-2').click();review.secondInspector=row('read-2').querySelector('.is-result pre');review.secondInspector.scrollTop=90;review.secondScroll=review.secondInspector.scrollTop;row('read-2').focus();state.items[1].result+='\\nnext live output';update();`);
  await check('RunningOutputPatchesExistingCallAndInspector','row("read-2")===review.secondRow&&row("read-2").querySelector(".is-result pre")===review.secondInspector&&review.secondInspector.scrollTop===review.secondScroll&&document.activeElement===review.secondRow&&review.group===stream.querySelector(".process-tool-group")&&review.header===review.group.querySelector("button")');
  await act(`state.items.push({...call('read-3','Read','error'),error:'权限不足，文件不可读'});update();`);
  await check('GroupSummarizesCountRunningAndFailure','review.header.textContent.includes("3 次")&&review.header.textContent.includes("1 进行中")&&review.header.textContent.includes("1 失败")&&row("read-3").textContent.includes("权限不足")');
  await act('review.header.focus();review.header.click();state.items.push(call("read-4","Read","running"));update();');await delay(260);
  await check('CollapsedGroupStaysCollapsedAndInertDuringAppend','!review.group.classList.contains("is-expanded")&&review.header.getAttribute("aria-expanded")==="false"&&review.group.querySelector(".process-tool-group-body").inert&&review.group.querySelector(".process-tool-group-body").getBoundingClientRect().height<1&&document.activeElement===review.header');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await delay(260);
  await check('KeyboardExpandsGroupAndPreservesInnerExpansion','review.header.getAttribute("aria-expanded")==="true"&&!review.group.querySelector(".process-tool-group-body").inert&&row("read-1").classList.contains("is-expanded")&&row("read-2").classList.contains("is-expanded")');
  await act(`row('read-3').focus();`);win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await delay(100);
  await check('KeyboardOpensEachOriginalErrorDetail','row("read-3").getAttribute("aria-expanded")==="true"&&row("read-3").querySelector(".is-error").textContent.includes("权限不足")');
  await act(`state.items.push({id:'prose',type:'narration',status:'running',result:'# 当前进展\\n\\n**已读取**全部文件。\\n\\n- 保留每次结果\\n- 下一步整理\\n\\n[危险](javascript:alert(1))'},call('read-5'),{id:'agent',type:'task',title:'校对 Agent',status:'running',result:'子任务独立输出'},call('shell-1','Bash'),call('shell-2','PowerShell'));update();review.prose=row('prose');review.proseHeading=review.prose.querySelector('h1');review.markdownCalls=review.rendererCalls;`);
  await check('NarrationUsesSafeMarkdownAndBreaksGroups','review.proseHeading&&review.prose.querySelector("strong")&&review.prose.querySelectorAll("li").length===2&&!review.prose.querySelector("[href^=javascript]")&&row("read-5").parentElement.classList.contains("process-items")&&row("agent").parentElement.classList.contains("process-items")&&stream.querySelectorAll(".process-tool-group").length===2');
  await act('state.items[0].elapsedMs=500;update();');
  await check('UnchangedNarrationDoesNotRerenderDuringToolUpdates','review.rendererCalls===review.markdownCalls&&row("prose").querySelector("h1")===review.proseHeading');
  await act(`state.items.find(x=>x.id==='prose').result+='\\n\\n新增进展';update();`);
  await check('ChangedNarrationUpdatesInsideSameRow','row("prose")===review.prose&&review.prose.textContent.includes("新增进展")&&review.rendererCalls===review.markdownCalls+1');
  await act('review.group.querySelector("button").click();');await capture('collapsed-tools-light');
  await act('review.group.querySelector("button").click();');await capture('expanded-tools-light');
  win.setSize(420,680);await delay(260);
  await check('NarrowWindowHasNoHorizontalPageOverflow','document.documentElement.scrollWidth<=innerWidth&&stream.scrollWidth<=stream.clientWidth+1');
  await act('document.documentElement.dataset.theme="dark";');await capture('expanded-tools-narrow-dark');
  await act('window.relayRenderReadOnlyMarkdown=undefined;state.items.find(x=>x.id==="prose").result="# fallback\\n<script>literal</script>";update();');
  await check('UnavailableMarkdownFallsBackToTextWithoutHtmlExecution','row("prose").textContent.includes("<script>literal</script>")&&!row("prose").querySelector("script")&&row("prose").querySelector(".is-plain-text")');
  await act('window.relayRenderReadOnlyMarkdown=()=>{throw Error("synthetic markdown failure")};state.items.find(x=>x.id==="prose").result="**failed parser fallback**";update();');
  await check('MarkdownFailureKeepsReadablePlainText','row("prose").textContent==="**failed parser fallback**"&&row("prose").querySelector(".is-plain-text")');
  await act('RelayActivity.finish(state);RelayActivity.updateElement(stream,state);');
  await check('CompletionHonorsExplicitInspectionAndRetainsFailureSummary','!stream.classList.contains("is-collapsed")&&review.group.classList.contains("is-expanded")&&review.header.textContent.includes("1 失败")&&!review.header.textContent.includes("进行中")&&row("read-2")===review.secondRow');
  await act('const uninspected=RelayActivity.createState({items:[call("last-a"),call("last-b")]});const fresh=RelayActivity.createElement(uninspected);document.getElementById("host").append(fresh);RelayActivity.finish(uninspected);RelayActivity.updateElement(fresh,uninspected);review.autoCollapsed=fresh.classList.contains("is-collapsed")&&fresh.querySelector(".process-items").inert;fresh.remove();');
  await check('UninspectedFinishedActivitiesKeepExistingAutoCollapse','review.autoCollapsed');
  await act(`const before=JSON.stringify(RelayActivity.serialize(state));const restored=RelayActivity.hydrate(JSON.parse(before));review.restored=RelayActivity.createElement(restored,{collapsed:true});document.getElementById('host').append(review.restored);review.savedUnchanged=JSON.stringify(RelayActivity.serialize(state))===before;`);
  await check('HistoryRestoresAllCallsAndCollapsedTreeIsInert','review.savedUnchanged&&review.restored.querySelectorAll(".process-item").length===state.items.length&&review.restored.querySelector(".process-items").inert&&review.restored.querySelectorAll(".process-tool-group").length===2');
  win.setSize(1040,800);
  await act(`document.documentElement.dataset.theme='light';stream.remove();review.restored.remove();window.relayRenderReadOnlyMarkdown=review.originalRenderer;
    review.densityState=RelayActivity.createState({received:9999,items:Array.from({length:6},(_,index)=>[
      {id:'density-think-'+index,type:'thinking',title:'正在比较当前文件内容',status:'success'},
      call('density-tool-'+index),
      {id:'density-prose-'+index,type:'narration',status:'success',result:'已检查当前文件，正在整理需要修改的位置。\\n\\n接下来继续核对相关配置。'}
    ]).flat()});review.density=RelayActivity.createElement(review.densityState);document.getElementById('host').append(review.density);`);
  await delay(260);
  await check('MixedThinkingToolsAndProseFitCompactReadableHeight',`(()=>{const el=review.density;const h=el.getBoundingClientRect().height;const tool=el.querySelector('.is-tool');const paragraph=el.querySelector('.conversation-narration p');return h<840&&h>580&&tool.getBoundingClientRect().height>=25&&tool.getBoundingClientRect().height<=28&&parseFloat(getComputedStyle(paragraph).lineHeight)>=21&&parseFloat(getComputedStyle(paragraph).marginBottom)<=8;})()`);
  await capture('compact-mixed-activity-light');
  // Task wall-clock timing includes retries; the SDK's API duration is only a
  // fallback when task timestamps are unavailable.
  await act(`review.densityState.taskFinishedAt=Date.now();review.densityState.taskStartedAt=review.densityState.taskFinishedAt-3723000;RelayActivity.finish(review.densityState);review.densityState.result={durationMs:1000};RelayActivity.updateElement(review.density,review.densityState);`);
  await check('CompletedSummaryUsesHoursMinutesSecondsWithoutMixedCounters','review.density.querySelector(".process-summary-title").textContent==="已结束"&&review.density.querySelector(".process-summary-meta").textContent==="· 用时 1h 2m 3s"&&!review.density.querySelector(".process-summary").textContent.match(/项活动|个事件|秒/)');
  await act('review.density.querySelector(".process-summary").click();document.documentElement.dataset.theme="dark";');
  win.setSize(420,680);await delay(260);
  await check('CompactActivityAndDurationFitNarrowWindow','document.documentElement.scrollWidth<=innerWidth&&review.density.scrollWidth<=review.density.clientWidth+1');
  await capture('compact-mixed-activity-narrow-dark');
  // No SDK events, reducer calls or explicit renders occur during these waits.
  // Exercise the real DOM clock and the same task grouping used for pause/resume.
  win.setSize(1040,800);
  await act(`
    const host=document.getElementById('host');RelayActivity.clearTaskSummaries(host);host.replaceChildren();
    document.documentElement.dataset.theme='light';
    window.relayRenderReadOnlyMarkdown=(...args)=>{review.rendererCalls++;review.originalRenderer(...args);};
    review.clock={samples:[]};const c=review.clock;
    c.meta=el=>el.querySelector('.process-summary-meta').textContent;
    c.seconds=el=>{const text=c.meta(el);return Number(text.match(/(\\d+)h/)?.[1]||0)*3600+Number(text.match(/(\\d+)m/)?.[1]||0)*60+Number(text.match(/(\\d+)s/)?.[1]||0);};
    c.first=RelayActivity.createState({taskRun:RelayTaskContinuity.begin({runId:'clock-first',startedAt:Date.now()-140000}),items:[call('clock-read','Read','running'),{id:'clock-prose',type:'narration',status:'running',result:'**合成计时测试**：等待工具返回。'}]});
    c.firstEl=RelayActivity.createElement(c.first,{collapseOnComplete:false});host.append(c.firstEl);RelayActivity.syncTaskSummary(c.firstEl);
    c.row=c.firstEl.querySelector('[data-process-id="clock-read"]');c.row.click();c.row.focus();
    c.inspector=c.row.querySelector('.is-result pre');c.inspector.scrollTop=80;c.scroll=c.inspector.scrollTop;
    c.rows=c.firstEl.querySelector('.process-items');c.saved=JSON.stringify(RelayActivity.serialize(c.first));c.markdownCalls=review.rendererCalls;
    c.initial=c.meta(c.firstEl);c.initialSeconds=c.seconds(c.firstEl);
    c.observer=new MutationObserver(()=>c.samples.push({at:Date.now(),text:c.meta(c.firstEl)}));
    c.observer.observe(c.firstEl.querySelector('.process-summary-meta'),{childList:true,subtree:true,characterData:true});
  `);
  await delay(2300);
  timing.quiet=await evaluate('({initial:review.clock.initial,samples:review.clock.samples,final:review.clock.meta(review.clock.firstEl)})');
  await check('QuietSummaryTicksEverySecondWithoutRebuildingRows',`(()=>{const c=review.clock;return c.samples.length>=2&&c.seconds(c.firstEl)>=c.initialSeconds+2&&c.samples.every((sample,i)=>i===0||sample.at-c.samples[i-1].at<1900)&&c.firstEl.querySelector('.process-items')===c.rows&&c.firstEl.querySelector('[data-process-id="clock-read"]')===c.row&&c.row.querySelector('.is-result pre')===c.inspector&&c.inspector.scrollTop===c.scroll&&document.activeElement===c.row&&review.rendererCalls===c.markdownCalls&&JSON.stringify(RelayActivity.serialize(c.first))===c.saved;})()`);
  await capture('live-activity-clock');
  await act(`const c=review.clock;c.observer.disconnect();RelayActivity.finish(c.first,'已暂停');RelayActivity.updateElement(c.firstEl,c.first);c.paused=c.meta(c.firstEl);c.pausedSeconds=c.seconds(c.firstEl);`);
  await delay(1400);
  await check('PausedSummaryStaysFrozenWithoutNewEvents','review.clock.firstEl.querySelector(".process-summary-title").textContent==="已暂停"&&review.clock.meta(review.clock.firstEl)===review.clock.paused');
  await act(`
    const c=review.clock;const taskRun=RelayTaskContinuity.begin({runId:'clock-resumed',startedAt:Date.now(),resumedFromRunId:'clock-first',conversation:{paused:{runId:'clock-first'},turns:[{runId:'clock-first',status:'paused',taskRun:c.first.taskRun}]}});
    c.resumed=RelayActivity.createState({taskRun,items:[call('clock-resumed-read','Read','running')]});
    RelayActivity.updateElement(c.firstEl,c.first,{segment:'previous'});
    c.resumedEl=RelayActivity.createElement(c.resumed,{collapseOnComplete:false});document.getElementById('host').append(c.resumedEl);RelayActivity.syncTaskSummary(c.resumedEl);
    c.resumeInitial=c.meta(c.firstEl);c.resumeInitialSeconds=c.seconds(c.firstEl);c.resumeAt=Date.now();
  `);
  await delay(2300);
  timing.resumed=await evaluate('({paused:review.clock.paused,initial:review.clock.resumeInitial,final:review.clock.meta(review.clock.firstEl),secondHeaderHidden:review.clock.resumedEl.querySelector(".process-summary").hidden})');
  await check('ResumedTaskTicksOnlyItsFirstSummaryAndExcludesPausedTime',`(()=>{const c=review.clock;return c.firstEl.querySelector('.process-summary-title').textContent==='正在处理'&&c.resumedEl.querySelector('.process-summary').hidden&&c.meta(c.resumedEl)===''&&c.resumeInitialSeconds===c.pausedSeconds&&c.seconds(c.firstEl)>=c.resumeInitialSeconds+2&&Math.abs(c.seconds(c.firstEl)-Math.floor(RelayTaskContinuity.activeDuration(c.resumed.taskRun)/1000))<=1;})()`);
  await act(`const c=review.clock;RelayActivity.finish(c.resumed);RelayActivity.updateElement(c.resumedEl,c.resumed);c.completed=c.meta(c.firstEl);`);
  await delay(1400);
  await check('CompletedResumedTaskSummaryStaysFrozen','review.clock.firstEl.querySelector(".process-summary-title").textContent==="已结束"&&review.clock.meta(review.clock.firstEl)===review.clock.completed&&review.clock.resumedEl.querySelector(".process-summary").hidden');
  await act(`
    const host=document.getElementById('host'),c=review.clock;RelayActivity.clearTaskSummaries(host);host.replaceChildren();
    c.away=RelayActivity.createState({taskRun:RelayTaskContinuity.begin({runId:'clock-conversation-a',startedAt:Date.now()-65000}),items:[call('clock-away','Read','running')]});
    c.awayEl=RelayActivity.createElement(c.away);host.append(c.awayEl);RelayActivity.syncTaskSummary(c.awayEl);c.awayMeta=c.meta(c.awayEl);
    RelayActivity.clearTaskSummaries(host);
  `);
  await delay(1400);
  await act(`
    const host=document.getElementById('host'),c=review.clock;c.clearedWhileMounted=c.meta(c.awayEl)===c.awayMeta;
    c.other=RelayActivity.createState({taskRun:RelayTaskContinuity.begin({runId:'clock-conversation-b',startedAt:Date.now()-5000}),items:[call('clock-other','Read','running')]});
    c.otherEl=RelayActivity.createElement(c.other);host.replaceChildren(c.otherEl);RelayActivity.syncTaskSummary(c.otherEl);c.otherInitial=c.seconds(c.otherEl);
  `);
  await delay(1400);
  timing.switched=await evaluate('({old:review.clock.meta(review.clock.awayEl),new:review.clock.meta(review.clock.otherEl),clearedWhileMounted:review.clock.clearedWhileMounted})');
  await check('SwitchingConversationStopsOldClockAndKeepsNewTaskIndependent',`(()=>{const c=review.clock;return c.clearedWhileMounted&&!c.awayEl.isConnected&&c.meta(c.awayEl)===c.awayMeta&&c.seconds(c.otherEl)>c.otherInitial&&c.seconds(c.otherEl)<15;})()`);
  await act(`
    const host=document.getElementById('host'),c=review.clock;RelayActivity.clearTaskSummaries(host);c.otherFrozen=c.meta(c.otherEl);
    c.back=RelayActivity.hydrate(RelayActivity.serialize(c.away));c.backEl=RelayActivity.createElement(c.back);host.replaceChildren(c.backEl);RelayActivity.syncTaskSummary(c.backEl);c.backInitial=c.seconds(c.backEl);
  `);
  await delay(1400);
  await check('ReturningToRunningConversationRestoresItsOwnClock',`(()=>{const c=review.clock;return c.seconds(c.backEl)>c.backInitial&&c.seconds(c.backEl)>=65&&c.meta(c.otherEl)===c.otherFrozen&&!c.otherEl.isConnected;})()`);
  await act('RelayActivity.clearTaskSummaries(document.getElementById("host"));document.getElementById("host").replaceChildren();');
  // A successful turn cannot manufacture receipts for abandoned streaming tools.
  await act(`
    document.documentElement.dataset.theme='light';
    review.receipts=RelayActivity.createState();
    const s=review.receipts,emit=event=>RelayActivity.ingest(s,event);
    emit({type:'assistant',message:{id:'confirmed-read',content:[{type:'tool_use',id:'receipt-read',name:'Read',input:{file_path:'synthetic.txt'}}]}});
    emit({type:'user',uuid:'read-result',message:{content:[{type:'tool_result',tool_use_id:'receipt-read',content:''}]}});
    for(let n=0;n<3;n++) {
      emit({type:'stream_event',event:{type:'message_start',message:{id:'abandoned-'+n}}});
      emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'pending-write-'+n,name:'mcp__fixture__doc_write',input:{}}}});
    }
    RelayActivity.finish(s,null,{exitCode:0,finalResult:{type:'result',subtype:'success',is_error:false,result:'Now I will update the synthetic document.'}});
    review.receiptEl=RelayActivity.createElement(s,{collapseOnComplete:false});document.getElementById('host').append(review.receiptEl);
  `);
  await check('UnreturnedWritePreviewsDoNotAcquireSuccessOnTurnEnd','review.receipts.items.filter(i=>i.toolName==="mcp__fixture__doc_write").every(i=>i.status==="unconfirmed")&&review.receiptEl.querySelectorAll(".is-unconfirmed").length>=3&&review.receiptEl.textContent.includes("结果未确认")');
  await check('EmptyRealResultRemainsSuccessful','review.receipts.items.find(i=>i.id==="receipt-read").status==="success"&&review.receiptEl.querySelector("[data-process-id=receipt-read]").classList.contains("is-success")');
  await check('TurnEndLabelDoesNotClaimTheDocumentWasCompleted','review.receiptEl.querySelector(".process-summary-title").textContent==="已结束"&&!review.receiptEl.querySelector(".process-summary-title").textContent.includes("已完成")');
  await act('for(const button of review.receiptEl.querySelectorAll(".process-tool-group-summary[aria-expanded=false]")) button.click();');
  win.setSize(860,720);await capture('unconfirmed-write-receipts-light');
  await act('document.documentElement.dataset.theme="dark";');win.setSize(420,680);await delay(260);
  await check('UnconfirmedReceiptLabelsFitNarrowWindow','document.documentElement.scrollWidth<=innerWidth&&review.receiptEl.scrollWidth<=review.receiptEl.clientWidth+1');
  await capture('unconfirmed-write-receipts-dark');
  await check('NoRendererErrorsOrNodeExposure','review.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));console.error(error);save();if(win&&!win.isDestroyed())try{await capture('failure');}catch(_){}clearTimeout(deadline);app.exit(1);});
