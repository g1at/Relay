'use strict';
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.codex-tmp/parallel-stall-2026-10-13'),stage=process.argv[2]||'after';
fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile-smoke-'+stage)); app.commandLine.appendSwitch('disable-gpu');
let win;const report={scope:'Production Electron renderer; synthetic live turns near observed 59/119, 13/43 and 229/496 message/activity counts. Two saved text turns bring the largest conversation to 3.25 MB; only live-turn DOM is mounted during measured streaming. No real user data, backend or model calls.',cases:[],checks:[],errors:[]};
const scriptNames=['app.js','activity-stream.js','assistant-output.js','stream-markdown.js'];
const snapshots=Object.fromEntries(scriptNames.map(name=>{const data=fs.readFileSync(stage==='before'?path.join(out,'before-'+name):path.join(root,'renderer',name));const target=path.join(out,'snapshot-'+stage+'-'+name);fs.writeFileSync(target,data);return[name,{target,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')}]}));
report.sourceHashes=Object.fromEntries(scriptNames.map(name=>['renderer/'+name,snapshots[name].sha256]));
report.fixtureHash=require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const save=()=>fs.writeFileSync(path.join(out,'renderer-parallel-smoke-'+stage+'.json'),JSON.stringify(report,null,2));
const assert=require('node:assert/strict');
const deadline=setTimeout(()=>{report.errors.push('timeout');save();app.exit(1)},120000);
const evaluate=code=>win.webContents.executeJavaScript(code);
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:/^https?:/i.test(d.url)}));
 const fixture=fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8');
 let html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+'</script>');
 for(const name of scriptNames)html=html.replace('src=\"'+name+'\"','src=\"'+pathToFileURL(snapshots[name].target).href+'\"');
 fs.writeFileSync(path.join(out,'fixture.html'),html);
 win=new BrowserWindow({width:1200,height:850,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 await win.loadFile(path.join(out,'fixture.html'));
 win.showInactive();
 await evaluate("new Promise((resolve,reject)=>{let n=0;const tick=()=>{if(typeof providerRoutingLoaded!=='undefined'&&providerRoutingLoaded&&!restoringActiveRuns)return resolve();if(++n>600)return reject(Error('boot'));setTimeout(tick,20)};tick()})");
 await evaluate(`(()=>{
 window.parallelAudit={metrics:{},longTasks:[]};
 const bench=parallelAudit;
 new PerformanceObserver(list=>bench.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
 function measured(label,fn){return function(...args){const started=performance.now();try{return fn.apply(this,args)}finally{const item=bench.metrics[label]||(bench.metrics[label]={count:0,ms:0,max:0});const time=performance.now()-started;item.count++;item.ms+=time;item.max=Math.max(item.max,time)}};}
 for(const [object,method] of [[RelayAssistantOutput,'ingest'],[RelayAssistantOutput,'processItems'],[RelayAssistantOutput,'mergeActivityItems'],[RelayAssistantOutput,'serialize'],[RelayActivity,'ingest'],[RelayActivity,'updateElement'],[RelayActivity,'serialize'],[RelaySidebarHistory,'reconcile']])object[method]=measured((object===RelayAssistantOutput?'output.':object===RelayActivity?'activity.':'sidebar.')+method,object[method]);
 syncRunOutputActivity=measured('syncRunOutputActivity',syncRunOutputActivity);
 const originalSet=Storage.prototype.setItem;Storage.prototype.setItem=measured('localStorage.setItem',originalSet);
 bench.seed=(oldMessages,toolCount,view,reorder=false)=>{
  clearConversationMessages();for(const run of runs.values())if(run.outputRenderTimer)clearTimeout(run.outputRenderTimer);runs.clear();jobToConv.clear();
  const started=performance.now();
  for(let j=0;j<3;j++){
   const convId='parallel-'+j,jobId='job-'+j,turn={runId:jobId,user:'Synthetic long goal',ts:new Date().toISOString(),supplements:[]};
   const output=RelayAssistantOutput.createState(); const messageCount=j===0?oldMessages:j===1?58:12; const tools=j===0?toolCount:j===1?60:30;
   output.messages=Array.from({length:messageCount},(_,i)=>({id:'old-'+i,parent:'',contextEpoch:0,settled:true,order:i*2,blocks:[{index:0,type:'text',text:'Completed analysis '+i+'\\n\\n'+'detail '.repeat(184),full:true,stopped:true,order:i*2}]}));
   output.messages.push({id:'live',parent:'',contextEpoch:0,order:(reorder?oldMessages:Math.max(messageCount,tools))*2+2,blocks:[{index:0,type:'text',text:'Current response ',streamed:true,order:(reorder?oldMessages:Math.max(messageCount,tools))*2+2}]});output.current={'':'live'};output.eventOrder=(reorder?oldMessages:Math.max(messageCount,tools))*2+3;
   const activity=RelayActivity.createState({phase:'running',items:Array.from({length:tools},(_,i)=>({id:'tool-'+i,type:'tool',toolName:'Read',toolUseId:'tool-'+i,title:'Read file '+i,status:'success',input:{file_path:'synthetic/'+i},result:'tool result '.repeat(72),order:i*2+1}))});
   const run={convId,jobId,turn,turnIndex:0,activityState:activity,outputState:output,activityEl:null,outputBubble:null,errorEl:null,supplementTimeline:null};runs.set(convId,run);jobToConv.set(jobId,convId);
  }
  currentConv={id:'parallel-0',title:'Synthetic',turns:[runs.get('parallel-0').turn]};currentJobId='job-0';
  showAppView('chat'); syncRunOutputActivity(runs.get('parallel-0'),true); const live = runs.get('parallel-0'); const serializedTurn={output:RelayAssistantOutput.serialize(live.outputState),activity:RelayActivity.serialize(live.activityState)}; currentConv.turns=[{user:'Historical synthetic turn',assistant:'Historical text '.repeat(62500)},{user:'Second historical synthetic turn',assistant:'Historical text '.repeat(62500)},live.turn]; const conversationBytes=JSON.stringify({...currentConv,turns:[...currentConv.turns.slice(0,2),serializedTurn]}).length;
  if(view==='library')showAppView('library');
  if(view==='other-chat'){currentConv={id:'unrelated',title:'Unrelated',turns:[]};currentJobId=null;clearConversationMessages();}
  return {conversationBytes,turnBytes:JSON.stringify(serializedTurn).length,messageCounts:[...runs.values()].map(r=>r.outputState.messages.length),activityCounts:[...runs.values()].map(r=>r.activityState.items.length),setupMs:performance.now()-started,nodes:document.querySelectorAll('*').length,processRows:document.querySelectorAll('.process-item').length,onView:isMountedChatJob('job-0'),activeView};
 };
 bench.run=async({oldMessages,toolCount,view,burst=false,full=false,reorder=false})=>{
  const setup=bench.seed(oldMessages,toolCount,view,reorder);await new Promise(r=>setTimeout(r,300));
  bench.metrics={};bench.longTasks=[];const callsBefore=uiFixture.calls.length;const started=performance.now();let drift=[],last=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();drift.push(Math.max(0,now-last-20));last=now;},20);
  let sequence=0;const event=j=>full?({jobId:'job-'+j,type:'assistant',uuid:'full-'+(++sequence),message:{id:'frame-'+sequence,content:[{type:'text',text:'Complete assistant frame '+sequence+' x'}]}}):({jobId:'job-'+j,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:' x'}}});
  const batches=burst?1:30,perBatch=burst?1000:full?1:5;
  for(let batch=0;batch<batches;batch++){for(let n=0;n<perBatch;n++)for(let j=0;j<3;j++)handleClaudeEvent(event(j));if(!burst)await new Promise(r=>setTimeout(r,20));}
  await new Promise(r=>setTimeout(r,220));clearInterval(heartbeat);
  const terminal=performance.now();drift.sort((a,b)=>a-b);
  return {oldMessages,toolCount,view,full,reorder,startedAt:started,events:batches*perBatch*3,elapsedMs:terminal-started,setup,metrics:bench.metrics,longTasks:bench.longTasks.filter(task=>task.start>=started),heartbeatMaxMs:Math.max(0,...drift),heartbeatP95Ms:drift[Math.floor(drift.length*.95)]||0,historyCalls:uiFixture.calls.slice(callsBefore).filter(name=>name.startsWith('history.')),nodes:document.querySelectorAll('*').length,heapBytes:performance.memory?.usedJSHeapSize,allStreamsRetained:[...runs.values()].every(run=>run.outputState.messages.at(-1).blocks[0].text.endsWith(' x'))};
 };
})()`);
 for(const config of [
  {oldMessages:58,toolCount:60,view:'chat'},
  {oldMessages:228,toolCount:267,view:'chat'},
  {oldMessages:228,toolCount:267,view:'library'},
  {oldMessages:228,toolCount:267,view:'chat',full:true},
  {oldMessages:228,toolCount:267,view:'other-chat',burst:true},
  {oldMessages:228,toolCount:267,view:'chat',full:true,reorder:true},
 ]){const result=await evaluate('parallelAudit.run('+JSON.stringify(config)+')');report.cases.push(result);save();}
 if(stage!=='before'){
  const check=(name,value)=>{report.checks.push({name,pass:!!value});save();assert.ok(value,name)};
  check('all parallel streams retained',report.cases.every(item=>item.allStreamsRetained));
  const covered=report.cases.find(item=>item.view==='library');
  check('covered chat does no process projection',!covered.metrics['activity.updateElement']&&!covered.metrics['output.processItems']);
  const complete=report.cases.find(item=>item.full&&!item.reorder);
  check('complete frames share a bounded presentation timer',complete.metrics['activity.updateElement'].count<complete.events/3);
  const behavior=await evaluate(`(async()=>{
   const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
   const bench=parallelAudit, findings={}; window.parallelDiagnostics=[];
   bench.seed(58,60,'library');await sleep(100);bench.metrics={};
   const send=text=>handleClaudeEvent({jobId:'job-0',type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
   const run=runs.get('parallel-0');
   for(let n=0;n<100;n++)send(' hidden-marker');
   await sleep(150);
   findings.hiddenNoProjection=!bench.metrics['activity.updateElement']&&!bench.metrics['output.processItems'];
   findings.hiddenRetainsAll=run.outputState.messages.at(-1).blocks[0].text==='Current response '+' hidden-marker'.repeat(100);
   showAppView('chat');await sleep(100);
   parallelDiagnostics.push({stage:'return',activeView,dirty:run.outputPresentationDirty,metrics:JSON.parse(JSON.stringify(bench.metrics)),hidden:document.hidden,onView:isMountedChatJob(run.jobId),navigation:pageNavigationVersion});
   findings.returnProjectsOnce=bench.metrics['activity.updateElement']?.count===1&&!run.outputPresentationDirty;
   findings.returnContainsLatest=run.activityEl.textContent.includes('hidden-marker');
   showAppView('settings');showAppView('chat');await sleep(80);
   findings.cleanReturnDoesNotProject=bench.metrics['activity.updateElement']?.count===1;
   showAppView('settings');send(' task-A-only');const owning=currentConv;
   showAppView('chat');currentConv={id:'unrelated',turns:[]};await sleep(80);
   findings.navigationNeverProjectsPrevious=bench.metrics['activity.updateElement']?.count===1&&run.outputPresentationDirty;
   currentConv=owning;flushVisibleRunPresentation();
   findings.previousTaskCanCatchUp=bench.metrics['activity.updateElement']?.count===2&&!run.outputPresentationDirty;
   bench.seed(12,30,'library');await sleep(100);bench.metrics={};
   const completing=runs.get('parallel-0');Object.assign(completing.turn,{thinkingList:[],files:[],chat:[]});
   currentConv.kind='create';await window.api.history.save(currentConv);
   const terminal={type:'result',subtype:'success',result:'hidden completion marker',stop_reason:'end_turn'};
   handleClaudeEvent({jobId:'job-0',type:'assistant',message:{id:'final',content:[{type:'text',text:terminal.result}]}});
   await finishRun('job-0',{type:'job-done',exitCode:0,finalResult:terminal});
   const saved=await window.api.history.load('parallel-0');
   findings.hiddenFinalSaved=saved.turns.at(-1).assistant===terminal.result;
   findings.hiddenTerminalNoDOM=!bench.metrics['activity.updateElement'];
   findings.hiddenTerminalPending=pendingConversationViewReloads.has('chat:parallel-0');
   returnToConversationView();
   for(let n=0;n<100&&(activeView!=='chat'||pendingConversationViewReloads.has('chat:parallel-0'));n++)await sleep(20);
   findings.completedReturnShowsAnswer=activeView==='chat'&&!pendingConversationViewReloads.has('chat:parallel-0')&&messagesEl.textContent.includes(terminal.result);
   bench.seed(12,30,'settings'); showAppView('settings'); await sleep(100);
   const failed=runs.get('parallel-0');Object.assign(failed.turn,{thinkingList:[],files:[],chat:[]});
   currentConv.kind='create';await window.api.history.save(currentConv);
   const api=window.api;
   window.api=new Proxy(api,{get(target,key){if(key!=='history')return target[key];return new Proxy(target.history,{get(history,key){return key==='completeTurn'?async()=>{throw Error('synthetic disk full')}:history[key]}})}});
   const unsaved={type:'result',subtype:'success',result:'unsaved answer marker',stop_reason:'end_turn'};
   handleClaudeEvent({jobId:'job-0',type:'assistant',message:{id:'unsaved',content:[{type:'text',text:unsaved.result}]}});
   try{await finishRun('job-0',{type:'job-done',exitCode:0,finalResult:unsaved})}finally{window.api=api}
   findings.hiddenSaveFailurePreservesAnswer=messagesEl.textContent.includes(unsaved.result)&&messagesEl.textContent.includes('synthetic disk full');
   findings.hiddenSaveFailureReleasesRun=!runs.has('parallel-0')&&!jobToConv.has('job-0');
   findings.hiddenSaveFailureAvoidsStaleReload=!pendingConversationViewReloads.has('chat:parallel-0');
   returnToConversationView();await sleep(100);
   findings.failedSaveReturnShowsAnswer=activeView==='chat'&&messagesEl.textContent.includes(unsaved.result)&&messagesEl.textContent.includes('synthetic disk full');
   return findings;
  })()`);
  report.behavior=behavior;report.behaviorDiagnostics=await evaluate('parallelDiagnostics');save();for(const [name,value]of Object.entries(behavior))check(name,value);
 }
 report.rendererErrors=await evaluate('uiFixture.errors');
 assert.deepEqual(report.rendererErrors,[],'production renderer has no errors');
 if(stage!=='before')fs.writeFileSync(path.join(out,'parallel-stream-return.png'),(await win.webContents.capturePage()).toPNG());save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(error=>{report.errors.push(String(error.stack||error));save();console.error(error);clearTimeout(deadline);app.exit(1)});
