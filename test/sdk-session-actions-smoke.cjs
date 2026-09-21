'use strict';
// Actual renderer/index.html, synthetic browser-only history/API, isolated
// Electron profile. No production IPC, real history, provider or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/sdk-session-actions-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start'; const report = { renderer: 'renderer/index.html', checks: [], errors: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...report, step }, null, 2));
const deadline = setTimeout(() => { report.ok = false; report.errors.push('UI fixture timeout: ' + step); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
async function waitFor(expression) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const poll=()=>{if(${expression})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(expression)}));setTimeout(poll,20);};poll();})`); }
async function check(name, expression) { step = name; if (!await evaluate(expression)) throw Error(name); report.checks.push(name); save(); }
const seed = `(() => {
  localStorage.clear(); const base=window.api, clone=value=>JSON.parse(JSON.stringify(value));
  const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const state=window.sessionActionsFixture={a:id(101),b:id(102),forks:[],loads:[],details:[],pages:[],hold:false,sequence:200};
  const makeTurn=(n,agent)=>({runId:id(n),ts:'2026-09-11T00:00:00.000Z',user:'合成请求 '+n,assistant:'# 合成回答 '+n+'\\n\\n完成。',status:'complete',
    sdkAgentIds:agent?['synthetic_agent']:[],activity:{version:6,phase:'complete',startedAt:1,endedAt:2,
      items:[{id:'tool_'+n,type:'tool',toolUseId:'tool_'+n,toolName:agent?'Agent':'Read',title:agent?'检查文件的子 Agent':'读取文件',
        input:agent?{description:'合成子 Agent',subagent_type:'general-purpose'}:{file_path:'fixture.txt'},result:'合成工具结果',status:'complete'}]}});
  const docs=new Map([[state.a,{id:state.a,title:'合成源对话',kind:'chat',mode:'plain',model:'opus',effort:'max',turns:[makeTurn(111,false),makeTurn(112,true)]}],
    [state.b,{id:state.b,title:'另一个合成对话',kind:'chat',mode:'plain',model:'opus',effort:'max',turns:[makeTurn(121,false)]}]]);
  state.docs=docs;
  function materialize(input){const source=docs.get(input.conversationId),dest=id(++state.sequence),index=input.runId?source.turns.findIndex(turn=>turn.runId===input.runId):source.turns.length-1;
    docs.set(dest,{...clone(source),id:dest,title:source.title+' · 分支',forkedFrom:{conversationId:source.id,runId:input.runId||null,sharesFiles:true},
      turns:source.turns.slice(0,index+1).map((turn,i)=>({...clone(turn),runId:id(state.sequence*10+i),forkedFromRunId:turn.runId}))});
    state.lastBranch=dest;return{ok:true,conversationId:dest,pendingNativeFork:!!input.runId,sharesFiles:true};}
  const history=new Proxy(base.history,{get(target,key){
    if(key==='list')return async()=>[...docs.values()].map(clone);
    if(key==='load')return async id=>{state.loads.push(id);return clone(docs.get(id)||null);};
    if(key==='save')return async conv=>{docs.set(conv.id,clone(conv));return clone(conv);};
    if(key==='fork')return async input=>{state.forks.push(clone(input));if(state.hold)await new Promise(resolve=>state.releaseFork=resolve);return materialize(input);};
    return target[key];}});
  const sessionHistory={listSubagents:async input=>{state.details.push(clone(input));return{ok:true,items:[{agentId:'synthetic_agent'}]};},
    getSubagentMessages:async input=>{state.pages.push(clone(input));return{ok:true,items:[{uuid:id(999),type:'assistant',message:{content:[{type:'text',text:'原生子 Agent 合成记录'}]}}],nextOffset:1,hasMore:false};}};
  window.api=new Proxy(base,{get(target,key){if(key==='history')return history;if(key==='sessionHistory')return sessionHistory;return target[key];}});
})();`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle&&!!window.relaySubagentHistory');
  await evaluate('refreshHistoryList()');
  await check('main renderer loads the new actions and leaves Agent history lazy', '!!document.querySelector(".history-item[data-id=\\""+sessionActionsFixture.a+"\\"]")&&sessionActionsFixture.details.length===0');

  step='whole-conversation context action';
  await evaluate('document.querySelector(".history-item[data-id=\\""+sessionActionsFixture.a+"\\"]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:160,clientY:300}))');
  await check('history right click no longer opens project or branch popovers', '!document.querySelector(".session-fork-menu")&&!document.querySelector(".composer-add-menu[data-variant=project-picker]")&&sessionActionsFixture.forks.length===0');
  await evaluate('createConversationFork(sessionActionsFixture.a,null,null)');
  await waitFor('sessionActionsFixture.forks.length===1&&currentConv?.id===sessionActionsFixture.lastBranch');
  await check('host whole-conversation fork remains available without a history popup', 'sessionActionsFixture.forks[0].conversationId===sessionActionsFixture.a&&!sessionActionsFixture.forks[0].runId&&currentConv.turns.length===2&&!document.querySelector(".session-fork-menu")');

  step='specific-turn action'; await evaluate('loadConversation(sessionActionsFixture.a)');
  await waitFor('document.querySelectorAll(".assistant-fork").length===4');
  await evaluate('document.querySelector(".message.assistant[data-turn=\\"0\\"] .assistant-fork").click()');
  await waitFor('sessionActionsFixture.forks.length===2&&currentConv?.id===sessionActionsFixture.lastBranch');
  await check('answer action passes the exact source run and opens the bounded branch', 'sessionActionsFixture.forks[1].conversationId===sessionActionsFixture.a&&sessionActionsFixture.forks[1].runId===sessionActionsFixture.docs.get(sessionActionsFixture.a).turns[0].runId&&currentConv.turns.length===1');

  step='navigation race'; await evaluate('loadConversation(sessionActionsFixture.a)');
  await evaluate('sessionActionsFixture.hold=true;document.querySelector(".message.assistant[data-turn=\\"1\\"] .assistant-fork").click()');
  await waitFor('!!sessionActionsFixture.releaseFork');
  await check('pending branch disables its source action to prevent duplicate clicks', 'document.querySelector(".message.assistant[data-turn=\\"1\\"] .assistant-fork").disabled');
  await evaluate('loadConversation(sessionActionsFixture.b)');
  await evaluate('sessionActionsFixture.loadsBeforeRelease=sessionActionsFixture.loads.length;sessionActionsFixture.releaseFork();sessionActionsFixture.hold=false');
  await waitFor('document.querySelector(".history-item[data-id=\\""+sessionActionsFixture.lastBranch+"\\"]")');
  await check('late branch creation refreshes history without stealing the current conversation', 'currentConv.id===sessionActionsFixture.b&&sessionActionsFixture.loads.length===sessionActionsFixture.loadsBeforeRelease&&sessionActionsFixture.forks[2].runId===sessionActionsFixture.docs.get(sessionActionsFixture.a).turns[1].runId');
  await check('ordinary tool activity keeps the Agent history action hidden', '[...document.querySelectorAll(".session-subagents")].length>0&&[...document.querySelectorAll(".session-subagents")].every(button=>getComputedStyle(button).display==="none")&&sessionActionsFixture.details.length===0');

  step='Agent history ownership'; await evaluate('loadConversation(sessionActionsFixture.a)');
  await check('only the actual Agent turn exposes a history entry', '[...document.querySelectorAll(".session-subagents")].filter(button=>getComputedStyle(button).display!=="none").length===1');
  await evaluate('document.querySelector(".process-stream.has-subagents .session-subagents").click()');
  await waitFor('sessionActionsFixture.pages.length===1&&!!document.querySelector(".subagent-history-message")');
  await check('Agent history button passes its actual conversation and run through both APIs', 'sessionActionsFixture.details[0].convId===sessionActionsFixture.a&&sessionActionsFixture.details[0].runId===sessionActionsFixture.docs.get(sessionActionsFixture.a).turns[1].runId&&sessionActionsFixture.pages[0].convId===sessionActionsFixture.a&&sessionActionsFixture.pages[0].runId===sessionActionsFixture.details[0].runId&&sessionActionsFixture.pages[0].agentId==="synthetic_agent"');
  fs.writeFileSync(path.join(out, 'agent-history-main-renderer.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate('loadConversation(sessionActionsFixture.b)');
  await check('navigating away clears the Agent history card immediately', 'document.querySelector(".subagent-history-overlay").hidden&&!document.querySelector(".subagent-history-message")');
  await check('no uncaught renderer errors or real model dispatch', 'uiFixture.errors.length===0&&!uiFixture.calls.includes("runClaude")');
  report.ok = true;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); console.error(error); })
  .finally(() => { clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1); });
