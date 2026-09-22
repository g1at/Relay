'use strict';
// Actual main/mini renderers and the mini controller. SDK events are synthetic,
// histories are in-memory, and the isolated Electron session blocks the network.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMiniChatController } = require('../src/main/app/mini-chat-controller');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/supplement-answers-ui-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const checks = {}, errors = [], miniHistory = new Map(), miniRuns = [];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const Q1 = '介绍你的能力', Q2 = '再告诉我合成天气';
const A = '## 能力介绍\n\nANSWER_A：我可以分析项目文件并解释代码。';
const B = '## 合成天气\n\nANSWER_B：今天晴朗，适合测试。';
const combined = A + '\n\n' + B;
let win, mini, step = 'starting';
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const timeout = setTimeout(() => { errors.push('Timed out: ' + step); save(); app.exit(1); }, 90000);
const ev = code => win.webContents.executeJavaScript(code);
const act = code => ev(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(160); await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function until(test, label) { const end = Date.now() + 6000; while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await delay(20); } }
async function waitFor(code) { await ev(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const poll=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(poll,20);};poll();})`); }
async function check(name, code) { step = name; checks[name] = !!await ev(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
function hostCheck(name, value) { step = name; checks[name] = !!value; save(); console.log(name + ': ' + checks[name]); if (!value) throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function watchFinalRendering(selector) {
  await act(`answerReview.finalFlashes=[];answerReview.allowFinal=false;
    new MutationObserver(()=>{if(answerReview.allowFinal)return;
      for(const node of document.querySelectorAll(${JSON.stringify(selector)}))if(/ANSWER_A|ANSWER_B/.test(node.textContent)&&node.getClientRects().length&&getComputedStyle(node).display!=='none')answerReview.finalFlashes.push(node.textContent);
    }).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class']});`);
}
function assistant(id, text, extra = {}) { return { type: 'assistant', uuid: 'frame-' + id, ...extra,
  message: { id, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }; }
function result(text, inputId, queued = 0) { return { type: 'result', subtype: 'success', is_error: false,
  result: text, user_message_uuid: inputId, user_message_uuids: [inputId], queued_turn_count: queued, terminal_reason: 'completed' }; }
const toolStage = { type: 'assistant', uuid: 'stage-frame', message: { id: 'stage-message', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'text', text: 'STAGE_ONLY：正在检查资料。' }, { type: 'tool_use', id: 'synthetic-read', name: 'Read', input: { file_path: 'D:/synthetic/report.txt' } }] } };
const toolResult = { type: 'user', uuid: 'tool-result-frame', message: { role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'synthetic-read', content: 'SOURCE_ONLY：工具返回的合成资料。' }] } };
const child = assistant('child-answer', 'CHILD_ONLY：子智能体阶段结果。', { parent_tool_use_id: 'synthetic-agent' });
const browserFixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
function page(name, source, seed) {
  const file = path.join(out, name + '.html');
  fs.writeFileSync(file, fs.readFileSync(path.join(root, 'renderer', source), 'utf8').replace('<head>',
    '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + browserFixture + seed + '</script>'));
  return file;
}
const windowOptions = { show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } };
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const mainSeed = `(()=>{localStorage.clear();const base=window.api;const copy=value=>JSON.parse(JSON.stringify(value));
    const review=window.answerReview={calls:[],steers:[],copied:[],emit:event=>uiFixture.emit('onEvent',event)};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>review.copied.push(value)}});
    window.api=new Proxy(base,{get(target,key){
      if(key==='runClaude')return async(...args)=>{review.calls.push(copy(args));return{...await target.runClaude(...args),sessionId:'synthetic-answer-session'};};
      if(key==='steerClaude')return async request=>{review.steers.push(copy(request));
        const input={id:request.messageId,text:request.prompt,status:'applied',ts:new Date().toISOString(),presentation:request.presentation,followUpMode:'steer'};
        const saved=await target.history.load(request.conversationId),turn=saved.turns.find(item=>item.runId===request.jobId);
        (turn.supplements||=([])).push(copy(input));await target.history.save(saved);
        review.emit({jobId:request.jobId,type:'system',subtype:'relay_user_input',input});
        return{ok:true,jobId:request.jobId,messageId:request.messageId,input};};
      return target[key];}});
  })();`;
  win = new BrowserWindow({ ...windowOptions, width: 1180, height: 840 });
  await win.loadFile(page('main-fixture', 'index.html', mainSeed)); win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
  await watchFinalRendering('.message.assistant:not(.thinking-indicator) .body');
  await act(`$('input').value=${JSON.stringify(Q1)};$('btnSend').click();`);
  await waitFor('answerReview.calls.length===1&&runs.size===1');
  const mainJob = await ev('runs.get(currentConv.id).jobId');
  const mainId = await ev('currentConv.id');
  const emitMain = async event => { await act(`answerReview.emit(${JSON.stringify({ jobId: mainJob, ...event })});`); };
  await emitMain(toolStage); await emitMain(toolResult); await emitMain(assistant('answer-a', A)); await settle();
  await check('MainProvisionalAnswerIsProcessUntilTaskCompletion', 'currentConv.turns[0].assistant===""&&!document.querySelector(".assistant-copy")&&!document.querySelector(".message.assistant:not(.thinking-indicator) .body")');
  await act(`window.taskHeader=()=>[...document.querySelectorAll('.process-summary')].filter(node=>!node.hidden);
    window.taskHeaderAtStart=()=>{const header=taskHeader()[0],user=document.querySelector('.message.user:not([data-supplement-id])'),items=document.querySelector('.process-items');return taskHeader().length===1&&header.checkVisibility()&&!!(user.compareDocumentPosition(header)&4)&&!!(header.compareDocumentPosition(items)&4)&&[...document.querySelectorAll('.message.user[data-supplement-id]')].every(input=>!!(header.compareDocumentPosition(input)&4));};
    window.originalTaskHeader=taskHeader()[0];`);
  await check('MainTaskHeaderStartsAboveAllProcessContent', 'taskHeaderAtStart()&&originalTaskHeader.textContent.includes("用时")');
  await act(`$('input').value=${JSON.stringify(Q2)};$('input').dispatchEvent(new Event('input',{bubbles:true}));$('btnSend').click();`);
  await waitFor('answerReview.steers.length===1&&!conversationControls.size&&currentConv.turns[0].supplements?.length===1');
  const mainInput = await ev('currentConv.turns[0].supplements[0].id');
  await check('MainSupplementKeepsTheSameTaskHeaderBeforeTheInput', 'taskHeaderAtStart()&&taskHeader()[0]===originalTaskHeader');
  await emitMain(result(A, mainJob, 1)); await settle();
  await check('MainFirstNativeResultDoesNotFinishOrFlashFinal', 'runs.size===1&&currentConv.turns.length===1&&currentConv.turns[0].assistant===""&&!document.querySelector(".assistant-copy")&&!document.querySelector(".message.assistant:not(.thinking-indicator) .body")');
  await emitMain(child); await emitMain(assistant('answer-b', B)); await settle();
  await check('MainSecondAnswerStillUsesProcessWhileRunning', 'runs.size===1&&!document.querySelector(".assistant-copy")&&!document.querySelector(".message.assistant:not(.thinking-indicator) .body")');
  await check('MainNoIntermediateMutationFlashesAFinalAnswer', 'answerReview.finalFlashes.length===0');
  await check('MainOngoingTaskStillHasOneHeaderAtTheOriginalPosition', 'taskHeaderAtStart()&&taskHeader()[0]===originalTaskHeader&&[...document.querySelectorAll(".process-summary-meta")].filter(node=>node.textContent).length===1');
  await capture('main-running-no-final-flash');
  const mainFinal = { ...result(B, mainInput), permission_denials: [{ tool_name: 'PowerShell' }] };
  await emitMain(mainFinal); await act('answerReview.allowFinal=true;');
  await emitMain({ type: 'job-done', exitCode: 0, finalResult: mainFinal });
  await waitFor('runs.size===0'); await settle();
  await check('MainBothConfirmedAnswersArePersisted', `currentConv.turns.length===1&&currentConv.turns[0].assistant===${JSON.stringify(combined)}&&currentConv.turns[0].output.answers.length===2`);
  await check('MainCompletionUpdatesTheOriginalTaskHeader', 'taskHeaderAtStart()&&taskHeader()[0]===originalTaskHeader&&taskHeader()[0].textContent.includes("已结束")');
  await check('MainDeniedToolDoesNotReplaceFinalAnswersWithAnError', 'currentConv.turns[0].status==="complete"&&!currentConv.turns[0].error&&currentConv.turns[0].outputNotice.includes("1 次工具请求被拒绝（PowerShell）")&&document.querySelector("#messages").textContent.includes("具体原因见执行过程")&&!document.querySelector(".message.error")');
  await act('taskHeader()[0].click();'); await settle();
  await check('MainTopHeaderExpandsEveryProcessSegment', '[...document.querySelectorAll(".conversation-stream")].every(node=>!node.classList.contains("is-collapsed")&&!node.querySelector(".process-items").inert)');
  await act('taskHeader()[0].click();'); await settle();
  await check('MainTopHeaderCollapsesEveryProcessSegment', '[...document.querySelectorAll(".conversation-stream")].every(node=>node.classList.contains("is-collapsed")&&node.querySelector(".process-items").inert)');
  await check('MainBothAnswersAreVisibleOutsideCollapsedProcess', '(()=>{const text=[...document.querySelectorAll(".message.assistant .body")].map(node=>node.innerText).join("\\n");return text.split("ANSWER_A").length===2&&text.split("ANSWER_B").length===2&&!/STAGE_ONLY|SOURCE_ONLY|CHILD_ONLY/.test(text);})()');
  await check('MainConfirmedAnswersAreNotDuplicatedInProcessDetails', '![...document.querySelectorAll(".conversation-stream")].some(node=>/ANSWER_A|ANSWER_B/.test(node.textContent))');
  await check('MainSupplementRemainsBetweenItsTwoAnswers', '(()=>{const blocks=[...document.querySelectorAll(".message.assistant .body")],a=blocks.find(node=>node.textContent.includes("ANSWER_A")),b=blocks.find(node=>node.textContent.includes("ANSWER_B")),input=document.querySelector(".message.user[data-supplement-id]");return a&&b&&a!==b&&!!(a.compareDocumentPosition(input)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(input.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);})()');
  await act('document.querySelector(".assistant-copy").click();');
  await waitFor('answerReview.copied.length===1');
  await check('MainCopyIncludesBothAnswersAndNoProcess', `answerReview.copied[0]===${JSON.stringify(combined)}`);
  await capture('main-two-confirmed-answers');
  await act('startNewConv();'); await ev(`loadConversation(${JSON.stringify(mainId)},null,{forceReload:true})`); await settle();
  await check('MainReloadKeepsBothConfirmedAnswers', `currentConv.turns[0].assistant===${JSON.stringify(combined)}&&[...document.querySelectorAll('.message.assistant .body')].map(node=>node.innerText).join('').includes('ANSWER_A')&&[...document.querySelectorAll('.message.assistant .body')].map(node=>node.innerText).join('').includes('ANSWER_B')`);
  await check('MainFixtureHasNoRendererErrors', 'uiFixture.errors.length===0&&typeof require==="undefined"');
  await check('MainHistoryRestoresOneTaskHeaderAboveTheSupplement', 'taskHeaderAtStart()&&taskHeader()[0].textContent.includes("已结束")');
  await check('MainReloadRetainsTheDenialNoticeBesideAnswers', 'document.querySelector("#messages").textContent.includes("1 次工具请求被拒绝（PowerShell）")&&!document.querySelector(".message.error")');

  // The quick window receives state from its actual host controller, not a
  // fabricated final string. Its accepted input is persisted by the fake host.
  mini = createMiniChatController({
    loadConversation: id => clone(miniHistory.get(id)),
    saveConversation: record => { miniHistory.set(record.id, clone(record)); return clone(record); },
    run: (request, emit) => { miniRuns.push({ request, emit }); return { jobId: request.runId }; },
    steer: request => {
      const input = { id: request.messageId, text: request.prompt, status: 'applied', presentation: request.presentation, followUpMode: 'steer' };
      const saved = clone(miniHistory.get(request.conversationId));
      const turn = saved.turns.find(item => item.runId === request.jobId);
      (turn.supplements ||= []).push(clone(input)); miniHistory.set(saved.id, saved);
      return { ok: true, input };
    },
    onState: snapshot => { if (win && !win.isDestroyed()) win.webContents.send('fixture-mini:state', snapshot); },
  });
  ipcMain.handle('fixture-mini:state', () => mini.state());
  ipcMain.handle('fixture-mini:submit', (_event, request) => mini.submit(request));
  const preload = path.join(out, 'mini-preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureMiniBridge',{
    state:()=>ipcRenderer.invoke('fixture-mini:state'),submit:request=>ipcRenderer.invoke('fixture-mini:submit',request),
    onState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('fixture-mini:state',listener);return()=>ipcRenderer.removeListener('fixture-mini:state',listener);}});`);
  const miniSeed = `(()=>{localStorage.clear();const base=window.api;window.answerReview={copied:[]};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>answerReview.copied.push(value)}});
    const decorate=state=>({...state,pinned:true,brand:{name:'Relay',theme:'light'}});
    const mini={state:async()=>decorate(await fixtureMiniBridge.state()),submit:request=>fixtureMiniBridge.submit(request),
      brand:async()=>({name:'Relay',theme:'light'}),onState:callback=>fixtureMiniBridge.onState(state=>callback(decorate(state))),onFocus:()=>()=>{},resize:async()=>({ok:true})};
    window.api=new Proxy(base,{get(target,key){
      if(key==='mini')return mini;
      if(key==='providers')return new Proxy(target.providers,{get(original,method){return method==='list'?async()=>({ok:true,routes:uiFixture.routes}):original[method];}});
      return target[key];}});
  })();`;
  const previous = win;
  win = new BrowserWindow({ ...windowOptions, width: 560, height: 700, useContentSize: true,
    webPreferences: { ...windowOptions.webPreferences, preload } });
  previous.destroy();
  const miniFile = page('mini-fixture', 'mini.html', miniSeed);
  await win.loadFile(miniFile); win.webContents.setZoomFactor(1); win.showInactive();
  await waitFor('document.getElementById("miniInput")&&!document.getElementById("miniInput").disabled');
  await watchFinalRendering('.mini-answer:not([hidden])');
  await act(`miniInput.value=${JSON.stringify(Q1)};miniInput.dispatchEvent(new Event('input',{bubbles:true}));`);
  await waitFor('!document.getElementById("miniSend").disabled');
  await act("document.getElementById('miniSend').click();");
  await until(() => miniRuns.length === 1, 'mini initial run');
  const miniJob = miniRuns[0].request.runId;
  const emitMini = event => miniRuns[0].emit({ jobId: miniJob, ...event });
  emitMini(toolStage); emitMini(toolResult); emitMini(assistant('answer-a', A)); await settle();
  await check('MiniProvisionalAnswerIsProcessUntilTaskCompletion', '!document.querySelector(".mini-answer:not([hidden])")&&!document.querySelector(".mini-answer-actions:not([hidden])")');
  await act(`window.miniHeader=()=>[...document.querySelectorAll('.mini-process>summary')].filter(node=>!node.hidden);
    window.miniHeaderAtStart=()=>{const header=miniHeader()[0],user=document.querySelector('.mini-turn>.mini-user');return miniHeader().length===1&&header.checkVisibility()&&!!(user.compareDocumentPosition(header)&4)&&[...document.querySelectorAll('.mini-supplement')].every(input=>input.hidden||!!(header.compareDocumentPosition(input)&4));};
    window.originalMiniTaskHeader=miniHeader()[0];`);
  await check('MiniTaskHeaderStartsAtTheFirstUserInput', 'miniHeaderAtStart()&&originalMiniTaskHeader.querySelector(".mini-task-time").textContent.length>0');
  await act(`miniInput.value=${JSON.stringify(Q2)};miniInput.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('miniSend').click();`);
  await until(() => mini.state().conversation?.turns[0].supplements?.length === 1, 'mini supplement');
  const miniInputId = mini.state().conversation.turns[0].supplements[0].id;
  emitMini(result(A, miniJob, 1)); emitMini(child); emitMini(assistant('answer-b', B)); await settle();
  hostCheck('MiniFirstResultKeepsOneTaskRunning', mini.isRunning() && mini.state().conversation.turns.length === 1 && mini.state().conversation.turns[0].assistant === '');
  await check('MiniSecondAnswerDoesNotFlashAsFinalWhileRunning', '!document.querySelector(".mini-answer:not([hidden])")&&!document.querySelector(".mini-answer-actions:not([hidden])")');
  await check('MiniNoIntermediateMutationFlashesAFinalAnswer', 'answerReview.finalFlashes.length===0');
  await check('MiniSupplementPreservesOneOriginalHeaderAndClock', 'miniHeaderAtStart()&&miniHeader()[0]===originalMiniTaskHeader&&[...document.querySelectorAll(".mini-task-time")].filter(node=>!node.hidden).length===1');
  await capture('mini-running-no-final-flash');
  const miniFinal = { ...result(B, miniInputId), permission_denials: [{ tool_name: 'PowerShell' }] };
  await act('answerReview.allowFinal=true;');
  emitMini(miniFinal); emitMini({ type: 'job-done', exitCode: 0, finalResult: miniFinal });
  await until(() => !mini.isRunning(), 'mini task complete'); await settle();
  const savedMini = miniHistory.get(mini.getConversationId());
  hostCheck('MiniControllerPersistsBothConfirmedAnswers', savedMini.turns[0].assistant === combined && savedMini.turns[0].output.answers.length === 2);
  await check('MiniCompletionLeavesTaskTimeAtTheFirstInput', 'miniHeaderAtStart()&&miniHeader()[0]===originalMiniTaskHeader&&miniHeader()[0].textContent.includes("已结束")');
  await check('MiniDeniedToolNoticeKeepsBothFinalAnswers', '[...document.querySelectorAll(".mini-turn-status")].some(node=>node.checkVisibility()&&node.textContent.includes("1 次工具请求被拒绝（PowerShell）"))&&!document.querySelector(".mini-error:not([hidden])")');
  await check('MiniBothAnswersAreVisibleOutsideCollapsedProcess', '(()=>{const text=[...document.querySelectorAll(".mini-answer:not([hidden])")].map(node=>node.innerText).join("\\n");return text.split("ANSWER_A").length===2&&text.split("ANSWER_B").length===2&&!/STAGE_ONLY|SOURCE_ONLY|CHILD_ONLY/.test(text);})()');
  await check('MiniConfirmedAnswersAreNotDuplicatedInProcessDetails', '![...document.querySelectorAll(".mini-process-entry-body")].some(node=>!node.closest("[hidden]")&&/ANSWER_A|ANSWER_B/.test(node.textContent))');
  await act('document.querySelector(".mini-copy").click();'); await waitFor('answerReview.copied.length===1');
  await check('MiniCopyIncludesBothAnswersAndNoProcess', `answerReview.copied[0]===${JSON.stringify(combined)}`);
  await capture('mini-two-confirmed-answers');
  await mini.refresh(); await win.loadFile(miniFile); await settle();
  await check('MiniWindowRecreationKeepsBothSavedAnswers', '[...document.querySelectorAll(".mini-answer:not([hidden])")].map(node=>node.innerText).join("").includes("ANSWER_A")&&[...document.querySelectorAll(".mini-answer:not([hidden])")].map(node=>node.innerText).join("").includes("ANSWER_B")');
  await check('MiniFixtureHasNoRendererErrors', 'uiFixture.errors.length===0&&typeof require==="undefined"');
  step = 'complete'; save(); clearTimeout(timeout); mini.destroy(); win.destroy(); app.exit(0);
}).catch(async error => {
  errors.push(String(error.stack || error)); console.error(error);
  if (win && !win.isDestroyed()) { try { console.error(await ev('JSON.stringify({errors:uiFixture.errors,main:document.querySelector("#messages")?.textContent,mini:document.querySelector(".mini-turns")?.textContent})')); await capture('failure'); } catch (_) {} }
  save(); clearTimeout(timeout); mini?.destroy(); app.exit(1);
});
