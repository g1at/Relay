'use strict';
// Production renderer and reducers, isolated profile and in-memory APIs only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), baseline = process.argv.includes('--baseline');
const mode = baseline ? 'baseline' : 'after';
const out = path.join(root, '.codex-tmp/long-task-renderer');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + mode));
let win, step = 'startup';
const sourceHashes = Object.fromEntries(['app.js', 'activity-stream.js', 'stream-markdown.js', 'assistant-output.js'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(baseline ? path.join(out, 'baseline') : path.join(root, 'renderer'), file))).digest('hex')]));
const report = { mode, runtime: process.versions, sourceHashes, checks: {}, metrics: {}, errors: [] };
const save = () => fs.writeFileSync(path.join(out, mode + '-result.json'), JSON.stringify(report, null, 2));
const timeout = setTimeout(() => { report.errors.push('Timeout: ' + step); save(); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate('(async()=>{' + code + '\n})()');
async function wait(code) {
  await evaluate('new Promise((resolve,reject)=>{const end=Date.now()+12000;function tick(){if(' + code + ')return resolve();if(Date.now()>end)return reject(Error(' + JSON.stringify(code) + '));setTimeout(tick,25)}tick()})');
}
async function check(name, code) { step = name; report.checks[name] = !!await evaluate(code); save(); if (!report.checks[name]) throw Error(name); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const api = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  let html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + api + '</script>');
  if (baseline) for (const file of ['app.js', 'activity-stream.js', 'stream-markdown.js', 'assistant-output.js']) {
    const snapshot = path.join(out, 'baseline', file);
    if (!fs.existsSync(snapshot)) throw Error('Missing pre-change snapshot: ' + file);
    html = html.replace('src="' + file + '"', 'src="' + pathToFileURL(snapshot).href + '"');
  }
  const page = path.join(out, mode + '.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 850, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await wait('providerRoutingLoaded&&!restoringActiveRuns&&window.RelayActivity');
  step = 'seed long goal'; save();
  await act(
    "inputEl.value='Synthetic long goal performance verification';await send();" +
    "window.longPerf={id:currentConv.id,jobId:uiFixture.runId,updates:0,projectionCalls:0,heartbeatGaps:[],maxPaintMs:0};" +
    "const run=runs.get(longPerf.id),count=1000;longPerf.run=run;" +
    "run.activityState=RelayActivity.createState({phase:'running',items:Array.from({length:count},(_,i)=>({id:'seed-tool-'+i,type:i%4===1?'task':i%4===2?'thinking':'tool',toolName:'Read',title:'Synthetic activity '+i,status:'success',input:{file_path:'fixture/'+i,context:'x'.repeat(1024)},result:'Synthetic receipt '+i+' '+ 'r'.repeat(2048),order:i*2+1}))});" +
    "run.outputState=RelayAssistantOutput.createState({status:'running',eventOrder:3000,messages:Array.from({length:count},(_,i)=>({id:'seed-message-'+i,parent:'',settled:true,stopReason:'end_turn',order:i*2+2,blocks:[{index:0,type:'text',text:'Synthetic progress '+i+'\\n\\n'+'completed detail '.repeat(30),full:true,stopped:true,order:i*2+2}]}))});" +
    "syncRunOutputActivity(run,true);longPerf.seedRows=document.querySelectorAll('.process-item').length;" +
    "const update=RelayActivity.updateElement;RelayActivity.updateElement=function(...args){const start=performance.now();longPerf.updates++;try{return update(...args)}finally{longPerf.maxPaintMs=Math.max(longPerf.maxPaintMs,performance.now()-start)}};" +
    "const project=RelayAssistantOutput.processItems;RelayAssistantOutput.processItems=function(...args){longPerf.projectionCalls++;return project(...args)};" +
    "longPerf.emit=event=>uiFixture.emit('onEvent',{jobId:longPerf.jobId,...event});" +
    "longPerf.emit({type:'stream_event',event:{type:'message_start',message:{id:'live-thinking'}}});" +
    "longPerf.emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});" +
    "await new Promise(r=>setTimeout(r,160));longPerf.updates=0;longPerf.projectionCalls=0;longPerf.maxPaintMs=0;"
  );
  await check('twoThousandHistoricalRowsRetained', 'longPerf.seedRows===2000');
  step = 'thinking token stream'; save();
  report.metrics = await act(
    "let last=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();longPerf.heartbeatGaps.push(now-last);last=now},16);" +
    "let inputAt=0,inputHandled=0;const inputStart=performance.now();" +
    "setTimeout(()=>{inputAt=performance.now();inputEl.value='Keep this user draft while the goal runs';inputEl.dispatchEvent(new Event('input',{bubbles:true}));inputHandled=performance.now()},40);" +
    "const started=performance.now(),deltas=240;" +
    "for(let i=0;i<deltas;i++){" +
      "longPerf.emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'goal progress '+i+'; '}}});" +
      "longPerf.emit({type:'system',subtype:'thinking_tokens',estimated_tokens:i+1});" +
      "if(i%12===11)await new Promise(r=>setTimeout(r,16));" +
    "}" +
    "await new Promise(r=>setTimeout(r,180));clearInterval(heartbeat);" +
    "const elapsed=performance.now()-started,gaps=longPerf.heartbeatGaps.slice().sort((a,b)=>a-b);" +
    "return {historicalRows:longPerf.seedRows,deltas,events:deltas*2,elapsedMs:elapsed,activityUpdates:longPerf.updates,projectionCalls:longPerf.projectionCalls,maxPaintMs:longPerf.maxPaintMs,maxHeartbeatGapMs:Math.max(0,...gaps),p95HeartbeatGapMs:gaps[Math.floor(gaps.length*0.95)]||0,inputTimerDelayMs:inputAt-inputStart-40,inputHandlerMs:inputHandled-inputAt,heapBytes:performance.memory?.usedJSHeapSize,nodes:document.querySelectorAll('*').length};"
  );
  save();
  await check('everyThinkingDeltaRetained', "longPerf.run.activityState.items.find(i=>i.id.includes('live-thinking')&&i.type==='thinking')?.title===Array.from({length:240},(_,i)=>'goal progress '+i+'; ').join('')");
  await check('composerRemainsEditableAndDraftSurvives', "inputEl.value==='Keep this user draft while the goal runs'&&!inputEl.disabled");
  await check('historyAndLiveToolRowsRemainAvailable', "document.querySelectorAll('.process-item').length===2001&&longPerf.run.outputState.messages.length===1001");
  if (!baseline) await check('highFrequencyEventsUseBoundedPaints', 'longPerf.updates<60&&longPerf.projectionCalls<60');

  step = 'background and navigation'; save();
  await act("longPerf.updates=0;startNewConv();for(let i=0;i<200;i++)longPerf.emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'background; '}}});await new Promise(r=>setTimeout(r,180));");
  await check('backgroundRunKeepsDataWithoutDetachedDom', "longPerf.run.activityState.items.find(i=>i.type==='thinking'&&i.id.includes('live-thinking')).title.endsWith('background; '.repeat(200))&&!longPerf.run.activityEl&&!messagesEl.querySelector('.process-stream')");
  await act("await loadConversation(longPerf.id);");
  await check('navigationRestoresLatestProcess', "longPerf.run.activityEl?.isConnected&&longPerf.run.activityState.items.length===2001&&messagesEl.querySelectorAll('.process-item').length===2001");

  step = 'terminal persistence'; save();
  await act("const final={type:'result',subtype:'success',result:'Synthetic long goal complete'};longPerf.emit(final);longPerf.emit({type:'job-done',exitCode:0,finalResult:final});");
  await wait('!runs.has(longPerf.id)');
  await check('terminalPersistsAllActivityAndFinalAnswer', "(async()=>{const c=await api.history.load(longPerf.id),t=c.turns.at(-1);return t.assistant==='Synthetic long goal complete'&&t.activity.items.length===2001&&t.activity.items.some(i=>i.type==='thinking'&&i.title.endsWith('background; '.repeat(200)))})()");
  await check('rendererHasNoErrors', 'uiFixture.errors.length===0');
  step = 'complete'; save(); console.log(JSON.stringify(report.metrics)); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error => { report.errors.push(String(error.stack||error)); save(); console.error(error); clearTimeout(timeout); if(win&&!win.isDestroyed())win.destroy(); app.exit(1); });
