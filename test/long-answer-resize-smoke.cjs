'use strict';
// Isolated, synthetic single-answer workload; native mouse input and the real
// run event handler. No user history, provider requests or GPU override.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const label = process.argv.includes('--before') ? 'before' : 'after';
const out = path.join(root, '.codex-tmp/long-answer-resize');
const renderer = label === 'before' ? path.join(out, 'before') : path.join(root, 'renderer');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile-' + label));
const result = { label, step: 'starting', checks: {}, errors: [], consoleErrors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const evaluate = source => win.webContents.executeJavaScript(source);
const save = () => fs.writeFileSync(path.join(out, label + '.json'), JSON.stringify(result, null, 2));
const stage = name => { result.step = name; save(); console.log('stage: ' + name); };
const timeout = setTimeout(() => { result.errors.push('timeout: ' + result.step); save(); app.exit(1); }, 90000);
const waitFor = source => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;function next(){if(${source})return resolve();if(Date.now()>end)return reject(Error('Timed out waiting for '+${JSON.stringify(source)}));setTimeout(next,25)}next()})`);
async function metrics() {
  return Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
}
async function drag(streaming = false) {
  const handle = await evaluate(`(()=>{const r=$('workspaceResizeHandle').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+120)};})()`);
  await evaluate(`if(window.dragLayoutListener)window.removeEventListener('relay:workspace-layout',dragLayoutListener);window.dragMeasure={gaps:[],last:null,active:true,events:0,widths:[]};
    function measure(now){const m=dragMeasure;if(!m.active)return;if(m.last!==null)m.gaps.push(now-m.last);m.last=now;requestAnimationFrame(measure);}requestAnimationFrame(measure);
    window.dragLayoutListener=()=>{dragMeasure.events++;dragMeasure.widths.push(parseFloat(document.querySelector('.app').style.getPropertyValue('--workspace-visible-width')));};window.addEventListener('relay:workspace-layout',dragLayoutListener);`);
  const before = await metrics();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...handle });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...handle, button: 'left', clickCount: 1 });
  for (let i = 0; i < 120; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x - Math.round(Math.sin(i / 15) * 155), y: handle.y, button: 'left', buttons: ['left'] });
    // The live fixture itself emits deltas on a timer; input is delivered by
    // Electron instead of dispatchEvent, including pointer capture/hit testing.
    await sleep(17);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', ...handle, button: 'left', clickCount: 1 });
  await sleep(180);
  const after = await metrics();
  const frames = await evaluate(`(()=>{const m=dragMeasure;m.active=false;const g=m.gaps.toSorted((a,b)=>a-b);return{frames:g.length,p50:g[Math.floor(g.length*.5)],p95:g[Math.floor(g.length*.95)],max:g.at(-1),over50:g.filter(v=>v>50).length,layoutEvents:m.events,widthRange:Math.max(...m.widths)-Math.min(...m.widths)};})()`);
  for (const key of ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']) frames[key] = after[key] - before[key];
  return frames;
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8') + ';window.longAnswerCopies=[];Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>longAnswerCopies.push(text)}});localStorage.setItem("relay.workspace-panel.width.v1","600");localStorage.setItem("relay.sidebar.layout.v2",JSON.stringify({version:2,width:224,collapsed:true}));';
  const page = path.join(out, label + '.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(renderer + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 3) { result.consoleErrors.push({ step: result.step, message, line, source }); save(); }
  });
  stage('renderer-ready');
  await win.loadFile(page); win.showInactive();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  await waitFor('window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate('document.fonts.ready');
  result.environment = { electron: process.versions.electron, chrome: process.versions.chrome, gpu: app.getGPUFeatureStatus(), dpr: await evaluate('devicePixelRatio') };
  stage('long-history-load');
  result.workload = await evaluate(String.raw`(async()=>{
    const fence=String.fromCharCode(96).repeat(3);
    window.longAnswer=Array.from({length:42},(_,section)=>'## 验证步骤 '+(section+1)+'\n\n'+
      '这段合成说明用于测试一条很长的回答，涵盖段落、列表、表格和代码块。'.repeat(12)+'\n\n'+
      '1. 检查输入和输出。\n2. 保存验证结果。\n3. 确认边界条件。\n\n'+
      '| 项目 | 结果 |\n| --- | --- |\n| 合成项目 | 正常 |\n\n'+fence+'js\n'+
      Array.from({length:80},(_,line)=>'const entry'+section+'_'+line+' = { title: "Synthetic line '+line+'", enabled: true };').join('\n')+'\n'+fence+'\n\n').join('')+'最后的验证结论。';
    const conv={id:'single-long-answer',title:'单条长回答拖动验证',mode:'chat',model:'opus',turns:[{user:'检查这份合成报告',assistant:longAnswer,ts:new Date().toISOString()}]};
    await api.history.save(conv);const start=performance.now();await loadConversation(conv.id);
    if(!document.querySelector('.app').classList.contains('sidebar-collapsed'))relaySidebarLayout.toggle();
    $('btnWorkspacePanel').click();
    stickToBottom=true;scrollToBottom(true);await new Promise(r=>setTimeout(r,500));
    return{characters:longAnswer.length,blocks:messagesEl.querySelectorAll('.body > *').length,nodes:messagesEl.querySelectorAll('*').length,loadMs:performance.now()-start};
  })()`);
  stage('long-history-drag');
  result.history = await drag();
  result.checks.nativeDragMoved = result.history.widthRange > 250;
  result.checks.historyIntact = await evaluate('messagesEl.querySelector(".message.assistant").dataset.raw===longAnswer');
  result.checks.noOverflow = await evaluate('document.documentElement.scrollWidth<=innerWidth');
  stage('activity-history-load');
  result.activityWorkload = await evaluate(`(async()=>{
    const state=RelayActivity.createState();state.phase='complete';
    state.items=Array.from({length:305},(_,i)=>({id:'activity-'+i,type:i%3===0?'thinking':'tool',status:'success',title:i%3===0?'思考说明'.repeat(80):'读取合成文件',toolName:i%3===0?null:'Read',toolUseId:'tool-'+i,input:{file_path:'C:/Synthetic/report-'+i+'.txt'},result:'合成结果，保留每项调用的详情。'.repeat(60)}));
    const conv={id:'activity-long-history',title:'大量已完成工具调用',mode:'chat',model:'opus',turns:[{user:'检查合成文件',assistant:longAnswer.slice(0,2400),activity:RelayActivity.serialize(state),ts:new Date().toISOString()}]};
    await api.history.save(conv);await loadConversation(conv.id);scrollToBottom(true);await new Promise(r=>setTimeout(r,350));
    return{items:305,nodes:messagesEl.querySelectorAll('*').length};
  })()`);
  stage('activity-history-drag');
  result.activityHistory = await drag();
  result.checks.collapsedActivityRetained = await evaluate('messagesEl.querySelectorAll(".process-item").length===305');
  await evaluate(`messagesEl.querySelector('.process-summary').click();messagesEl.querySelector('.process-item.is-inspectable').click();`);
  await sleep(300);
  result.checks.activityExpands = await evaluate('getComputedStyle(messagesEl.querySelector(".process-items")).contentVisibility!=="hidden"&&getComputedStyle(messagesEl.querySelector(".is-expanded > .process-inspector")).contentVisibility!=="hidden"');
  // Use the actual run creation + handleClaudeEvent + scheduled output reducer.
  stage('live-run-start');
  await evaluate(`startNewConv();$('input').value='开始合成流式验证';$('btnSend').click();`);
  await waitFor('uiFixture.runId&&runs.size');
  await evaluate(`window.liveExpected=longAnswer;uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'message_start',message:{id:'long-live-answer'}}});
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:longAnswer}}});`);
  await waitFor('messagesEl.querySelector(".conversation-narration")?._narrationText===liveExpected');
  // Live model text stays in the task's process stream until job-done confirms
  // a final answer. The keyed activity row and narration container remain
  // stable; their sanitized Markdown children may legitimately be refreshed.
  result.checks.liveUsesProcessPresentation = await evaluate('!messagesEl.querySelector(".message.assistant")&&messagesEl.querySelectorAll(".conversation-narration pre").length===42');
  if (process.argv.includes('--profile')) {
    await win.webContents.debugger.sendCommand('Profiler.enable');
    await win.webContents.debugger.sendCommand('Profiler.start');
  }
  await evaluate(`window.firstLiveNarration=messagesEl.querySelector('.conversation-narration');window.firstLiveRow=firstLiveNarration.closest('.process-item');
    window.firstLiveCode=firstLiveNarration.querySelector('pre');
    window.initialLiveCodeSources=[...firstLiveNarration.querySelectorAll('pre code')].map(code=>code.textContent);window.liveTicks=0;
    window.liveTimer=setInterval(()=>{const text='继续补充验证结论。';liveExpected+=text;liveTicks++;uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});},35);`);
  stage('live-stream-drag');
  result.streaming = await drag(true);
  if (process.argv.includes('--profile')) {
    const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop');
    fs.writeFileSync(path.join(out, label + '.cpuprofile'), JSON.stringify(profile));
  }
  await evaluate('clearInterval(liveTimer)');
  await waitFor('messagesEl.querySelector(".conversation-narration")?._narrationText===liveExpected');
  result.checks.liveTextIntact = await evaluate('firstLiveNarration._narrationText===liveExpected&&liveTicks>25');
  result.checks.stableLiveProcessNodes = await evaluate('firstLiveNarration===messagesEl.querySelector(".conversation-narration")&&firstLiveRow===firstLiveNarration.closest(".process-item")&&firstLiveRow.isConnected');
  result.checks.stableLiveCodeNode = await evaluate('firstLiveCode===firstLiveNarration.querySelector("pre")&&firstLiveCode.isConnected');
  result.checks.liveCodeIntact = await evaluate('initialLiveCodeSources.length===42&&JSON.stringify([...firstLiveNarration.querySelectorAll("pre code")].map(code=>code.textContent))===JSON.stringify(initialLiveCodeSources)');
  result.checks.liveEndVisible = await evaluate('messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<12');
  result.scroll = await evaluate('({height:messagesEl.scrollHeight,top:messagesEl.scrollTop,viewport:messagesEl.clientHeight,stick:stickToBottom})');
  if (label !== 'before') {
    stage('live-user-reading');
    const point = await evaluate('(()=>{const r=messagesEl.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+80)}})()');
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: 800, deltaX: 0, canScroll: true });
    await sleep(350);
    result.checks.userScrollStopsFollowing = await evaluate('!stickToBottom&&messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight>100');
    await evaluate(`liveExpected+='用户正在阅读上文时继续输出。';uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'用户正在阅读上文时继续输出。'}}});`);
    await waitFor('messagesEl.querySelector(".conversation-narration")?._narrationText===liveExpected');
    result.checks.streamingRespectsReadingPosition = await evaluate('!stickToBottom&&messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight>100');
    await evaluate('scrollToBottom(true)'); await sleep(250);
    result.checks.explicitReturnResumesFollowing = await evaluate('stickToBottom&&messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<12');
    // Finalization changes presentation once. It must produce exactly one
    // complete answer, retain all code, and copy the complete original text.
    stage('live-finalization');
    await evaluate(`uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'message_stop'}});
      uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'assistant',uuid:'long-live-final',message:{id:'long-live-answer',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:liveExpected}]}});
      const final={type:'result',subtype:'success',is_error:false,result:liveExpected};
      uiFixture.emit('onEvent',{jobId:uiFixture.runId,...final});
      uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'job-done',exitCode:0,finalResult:final});`);
    await waitFor('!isRunning&&runs.size===0&&!!messagesEl.querySelector(".assistant-copy")');
    result.checks.finalAnswerIsUniqueAndComplete = await evaluate('messagesEl.querySelectorAll(".message.assistant").length===1&&messagesEl.querySelector(".message.assistant").dataset.raw===liveExpected&&messagesEl.querySelectorAll(".assistant-copy").length===1');
    result.checks.finalCodeIntact = await evaluate('JSON.stringify([...messagesEl.querySelectorAll(".message.assistant pre code")].map(code=>code.textContent))===JSON.stringify(initialLiveCodeSources)&&messagesEl.querySelectorAll(".message.assistant .code-copy").length===42');
    await evaluate('messagesEl.querySelector(".assistant-copy").click()');
    await waitFor('longAnswerCopies.length===1');
    result.checks.finalCopiesCompleteAnswer = await evaluate('longAnswerCopies[0]===liveExpected');
  }
  if (label !== 'before') {
    result.checks.historyResponsive = result.history.p95 < 50;
    result.checks.activityHistoryResponsive = result.activityHistory.p95 < 50;
    result.checks.streamingResponsive = result.streaming.p95 < 50;
  }
  result.errors.push(...await evaluate('uiFixture.errors'));
  fs.writeFileSync(path.join(out, label + '.png'), (await win.webContents.capturePage()).toPNG());
  result.step = 'complete';save(); console.log(JSON.stringify(result)); clearTimeout(timeout);app.exit(result.errors.length || result.consoleErrors.length || Object.values(result.checks).some(v=>!v) ? 1 : 0);
}).catch(async error => {
  result.errors.push(result.step + ': ' + String(error.stack || error));
  if (win && !win.isDestroyed()) try {
    result.diagnostics = await evaluate('({errors:window.uiFixture?.errors||[],liveTicks:window.liveTicks,narrationLength:messagesEl.querySelector(".conversation-narration")?._narrationText?.length,expectedLength:window.liveExpected?.length,finalCount:messagesEl.querySelectorAll(".message.assistant").length,scroll:{height:messagesEl.scrollHeight,top:messagesEl.scrollTop,viewport:messagesEl.clientHeight,stick:stickToBottom}})');
  } catch (_) {}
  console.error(error);save();clearTimeout(timeout);app.exit(1);
});
