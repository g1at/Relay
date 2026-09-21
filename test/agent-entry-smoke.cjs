'use strict';
// Native renderer with isolated in-memory APIs; never loads Relay's main process.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'agent-entry-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [], geometry = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, geometry, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name); if (!checks[name]) throw Error(name); }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(70); }
async function input(selector, value) { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`); }
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(80); }
async function settle() { await delay(100); await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch{}});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"); }
async function pointerClick(selector) {
  const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Clipped target');return{x,y}})()`);
  for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await settle();
}
async function capture(name) { await delay(200); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const picker = '.agent-selection-dialog';
const row = name => `[data-agent="${name}"] input`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const custom = `(() => {
    const base=window.api;
    window.agentFixture={agents:[{name:'planner',displayName:'任务规划',desc:'拆解需求，梳理执行步骤。'},{name:'writer',displayName:'内容写作',desc:'撰写清晰、自然的内容。'},{name:'reviewer',displayName:'质量审查',desc:'核对细节，检查结果。'}],mode:'ok',pending:null,runs:[],history:new Map(),writes:0,pmCalls:0};
    const f=agentFixture;
    const data=new Proxy(base.data,{get(t,k){if(k==='listAgents')return async()=>{if(f.mode==='fail')throw Error('Synthetic failure');if(f.mode==='hold')return new Promise(r=>f.pending=r);return {ok:true,items:f.mode==='empty'?[]:f.agents}};return t[k]}});
    const history=new Proxy(base.history,{get(t,k){if(k==='save')return async conv=>{f.writes++;const next=JSON.parse(JSON.stringify({...conv,id:conv.id||'agent-history-'+f.writes}));f.history.set(next.id,next);return next};if(k==='load')return async id=>JSON.parse(JSON.stringify(f.history.get(id)||null));if(k==='list')return async()=>[...f.history.values()];return t[k]}});
    window.api=new Proxy(base,{get(t,k){if(k==='data')return data;if(k==='history')return history;if(k==='pm')return new Proxy(t.pm,{get(p,n){return (...a)=>{f.pmCalls++;return p[n](...a)}}});if(k==='runClaude')return async(...a)=>{f.runs.push(a);return base.runClaude(...a)};return t[k]}});
    localStorage.setItem('relay.sidebar.features.v1',JSON.stringify({version:3,order:['search','settings','orchestrate','agent','plugins','library','scheduler','create'],pinned:['search','settings','orchestrate']}));
  })();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + custom + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1140, height: 800, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); await waitFor('!!window.relayKeyboardShortcuts && providerRoutingLoaded && !restoringActiveRuns');
  await check('legacyPinnedCollaborationUsesSingleAgentEntry', "!document.getElementById('btnTeam') && document.querySelectorAll('#btnNewAnalysis').length===1 && relaySidebarExplore.getPreferences().pinned.includes('agent') && !relaySidebarExplore.getPreferences().order.includes('orchestrate')");
  await act("inputEl.value='保留的对话草稿';document.getElementById('btnNewAnalysis').focus();"); await click('#btnNewAnalysis');
  await waitFor("document.querySelectorAll('[data-agent]').length===3");
  await check('selectionStartsEmptyAndIsAccessible', "document.querySelector('.agent-selection-start').disabled && document.querySelector('[role=dialog][aria-modal=true]') && document.activeElement.matches('.agent-selection-search input')");
  await click('.agent-selection-start');
  await check('emptySelectionNeverDispatchesImplicitTeam', "agentFixture.runs.length===0 && currentMode==='plain'");
  await click(row('writer'));
  await check('singleSelectionExplainsDirectConversation', "!document.querySelector('.agent-selection-start').disabled && document.querySelector('.agent-selection-start').textContent==='开始对话' && document.querySelector('.agent-selection-status').textContent.includes('内容写作')");
  await input('.agent-selection-search input', '审查');
  await check('searchFiltersWithoutLosingSelection', "document.querySelectorAll('[data-agent]').length===1 && document.querySelector('.agent-selection-status').textContent.includes('内容写作')");
  await click(row('reviewer'));
  await check('multipleSelectionExplainsCollaboration', "document.querySelector('.agent-selection-start').textContent==='开始协奏 · 2'");
  await input('.agent-selection-search input', 'missing agent');
  await check('noMatchesKeepsSelectedTeam', "document.querySelector('.agent-selection-empty').textContent.includes('没有找到') && !document.querySelector('.agent-selection-start').disabled");
  await input('.agent-selection-search input', ''); await capture('agent-selection-light');
  await act("document.querySelector('.agent-selection-start').focus()"); await key('TAB');
  await check('dialogTrapsForwardFocus', "document.activeElement.matches('.agent-selection-close')");
  await key('TAB', ['shift']);
  await check('dialogTrapsBackwardFocus', "document.activeElement.matches('.agent-selection-start')");
  await key('ESCAPE');
  await check('cancelPreservesDraftAndMode', "!document.querySelector('.agent-selection-dialog') && currentMode==='plain' && inputEl.value==='保留的对话草稿' && document.activeElement.id==='btnNewAnalysis'");
  await click('#btnNewAnalysis'); await waitFor("document.querySelectorAll('[data-agent]').length===3"); await click(row('writer')); await click('.agent-selection-start');
  await check('singleAgentRoutesThroughExistingChat', "currentMode==='agent' && currentAgent==='writer' && currentOrchestrateAgents===null && chatTitle.textContent==='内容写作' && inputEl.value==='保留的对话草稿'");
  await input('#input', '单个 Agent 验证'); await evaluate('send()'); await waitFor('agentFixture.runs.length===1');
  await check('singleAgentSendUsesExactIdentity', "agentFixture.runs[0][2]==='agent' && agentFixture.runs[0][6]==='writer' && agentFixture.runs[0][8]===null");
  await act("handleClaudeEvent({jobId:uiFixture.runId,type:'result',subtype:'success',result:'单个 Agent 完成'});handleClaudeEvent({jobId:uiFixture.runId,type:'job-done',code:0});");
  await waitFor('!runForJob(uiFixture.runId)');
  await click('#btnNewAnalysis'); await waitFor("document.querySelectorAll('[data-agent]').length===3"); await click(row('planner')); await click(row('reviewer')); await click('.agent-selection-start');
  await check('multipleAgentsUseSharedChatSurface', "currentMode==='orchestrate' && currentAgent===null && currentOrchestrateAgents.join(',')==='planner,reviewer' && !document.querySelector('.chat-msg, .chat-user-row, .chat-avatar')");
  await input('#input', '协作验证'); await evaluate('send()'); await waitFor('agentFixture.runs.length===2');
  await check('collaborationSendUsesOnlySelectedAgents', "agentFixture.runs[1][2]==='orchestrate' && agentFixture.runs[1][6]===null && agentFixture.runs[1][8].join(',')==='planner,reviewer'");
  await act(`window.multiJob=uiFixture.runId; handleClaudeEvent({jobId:multiJob,type:'system',subtype:'init',session_id:'parent-session'});
    handleClaudeEvent({jobId:multiJob,type:'assistant',message:{id:'main-plan',content:[{type:'text',text:'正在分配与检查任务'},{type:'tool_use',id:'child-task',name:'Agent',input:{subagent_type:'reviewer',description:'核对执行结果',prompt:'检查结果'}}]}});
    handleClaudeEvent({jobId:multiJob,type:'assistant',parent_tool_use_id:'child-task',message:{id:'child-msg',content:[{type:'text',text:'子任务检查结果'}]}});
    handleClaudeEvent({jobId:multiJob,type:'result',parent_tool_use_id:'child-task',session_id:'child-session',subtype:'success',result:'子任务检查结果'});
    handleClaudeEvent({jobId:multiJob,type:'job-done',parent_tool_use_id:'child-task',code:0});`);
  await check('childCompletionCannotFinishParentOrBecomeAnswer', "!!runForJob(multiJob) && currentSessionId==='parent-session' && ![...document.querySelectorAll('.message.assistant .body')].some(e=>e.textContent.includes('子任务检查结果')) && !!document.querySelector('.conversation-stream') && !document.querySelector('.chat-msg, .chat-user-row, .chat-avatar')");
  await act(`handleClaudeEvent({jobId:multiJob,type:'user',message:{content:'<task-notification><tool-use-id>child-task</tool-use-id><task-id>task-1</task-id><status>completed</status><summary>已检查</summary><result>子任务检查结果</result></task-notification>'}});
    handleClaudeEvent({jobId:multiJob,type:'result',subtype:'success',result:'协作任务已完成，结果已经核对。'});
    handleClaudeEvent({jobId:multiJob,type:'job-done',code:0});`);
  await waitFor('!runForJob(multiJob)');
  await check('collaborationCompletesWithOneFinalAndCollapsedActivities', "[...document.querySelectorAll('.message.assistant .body')].filter(e=>e.textContent.includes('协作任务已完成')).length===1 && document.querySelector('.conversation-stream').classList.contains('is-collapsed') && currentConv.turns.at(-1).activity.items.some(i=>i.type==='task' && i.result==='子任务检查结果') && !document.querySelector('.chat-msg, .chat-user-row, .chat-avatar')");
  await capture('agent-collaboration-complete');
  await act("window.savedTeamId=currentConv.id;window.beforeReadWrites=agentFixture.writes;"); await evaluate('loadConversation(savedTeamId)');
  await check('savedCollaborationReloadPreservesModeAndDoesNotWrite', "currentMode==='orchestrate' && currentOrchestrateAgents.join(',')==='planner,reviewer' && agentFixture.writes===beforeReadWrites && [...document.querySelectorAll('.message.assistant .body')].filter(e=>e.textContent.includes('协作任务已完成')).length===1 && !document.querySelector('.chat-msg, .chat-user-row, .chat-avatar')");
  await act("agentFixture.history.set('legacy-team',{id:'legacy-team',title:'旧版协作',mode:'orchestrate',orchestrateAgents:['planner','reviewer'],turns:[{user:'历史任务',assistant:'历史最终结论',chat:[{role:'pm',text:'历史执行规划'},{role:'agent',agent:'reviewer',text:'历史子任务结果'},{role:'pm',text:'历史最终结论'}]}]});");
  await evaluate("loadConversation('legacy-team')");
  await check('legacyGroupHistoryIsPreservedInActivitiesWithoutRewrite', "agentFixture.writes===beforeReadWrites && !document.querySelector('.chat-msg, .chat-user-row, .chat-avatar') && ![...document.querySelectorAll('.message.assistant .body')].some(e=>e.textContent.includes('历史最终结论')) && activityStateForTurn(currentConv.turns[0]).items.some(i=>i.result.includes('历史最终结论')) && document.querySelector('.conversation-stream') && JSON.stringify(agentFixture.history.get('legacy-team')).includes('历史执行规划')");
  await capture('agent-legacy-history');
  await evaluate("openSettings('profile')");
  await click('#profileEdit');
  await check('pmCustomizationIsRemovedAndBrandLimitExpanded', "!document.querySelector('#set-pmName') && !document.querySelector('#set-pmLogo') && !document.getElementById('settingsBody').textContent.includes('PM 头像') && document.getElementById('set-brandNameCount').textContent.includes('/40') && agentFixture.pmCalls===0");
  await input('#set-brandName', '本地智能协作研究助手工作台');
  await click('#profileSave'); await waitFor('workspaceFixture.brandWrites.length>0');
  await check('longerBrandNameSavesWithoutPmWrites', "workspaceFixture.brandWrites.at(-1)==='本地智能协作研究助手工作台' && workspaceFixture.pmWrites.length===0 && agentFixture.pmCalls===0");
  await act("showAppView('chat');agentFixture.mode='fail'"); await click('#btnNewAnalysis');
  await waitFor("document.querySelector('.agent-selection-empty')?.textContent.includes('加载失败')");
  await check('loadFailureHasRetryAndCannotStart', "document.querySelector('.agent-selection-empty button') && document.querySelector('.agent-selection-start').disabled");
  await input('.agent-selection-search input', '暂存搜索');
  await check('searchDoesNotEraseLoadFailureOrRetry', "document.querySelector('.agent-selection-empty').textContent.includes('加载失败') && !!document.querySelector('.agent-selection-empty button')");
  await input('.agent-selection-search input', '');
  await act("agentFixture.mode='empty'"); await click('.agent-selection-empty button');
  await waitFor("document.querySelector('.agent-selection-empty')?.textContent.includes('还没有安装')");
  await click('.agent-selection-manage');
  await check('emptyStateManageOpensAgentPlugins', "activeView==='plugins' && !document.querySelector('.agent-selection-dialog')");
  await act("agentFixture.mode='hold';openAgentPicker()"); await waitFor('!!agentFixture.pending'); await key('ESCAPE');
  await act("agentFixture.pending({ok:true,items:agentFixture.agents})"); await delay(50);
  await check('lateLoadCannotReopenClosedPicker', "!document.querySelector('.agent-selection-dialog')");
  await act("window.originalAgentFixtures=agentFixture.agents;agentFixture.agents=[...originalAgentFixtures,...Array.from({length:21},(_,i)=>({name:'fixture-agent-'+String(i+1).padStart(2,'0'),displayName:'本地研究助手 '+String(i+1).padStart(2,'0')}))].map(a=>({...a,desc:'分析需求与执行结果，核对本地文档中的依据，整理可复核的结论。保留必要背景和详细步骤，说明待确认的问题以及下一步行动。'}));agentFixture.mode='ok';showAppView('chat');openAgentPicker();");
  await waitFor("document.querySelectorAll('[data-agent]').length===24");await settle();
  for(const [width,height] of [[1140,800],[900,600]]) {
    win.setSize(width,height);await settle();
    for(const theme of ['light','dark']) {
      await act(`document.body.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.agent-selection-list').scrollTop=0;`);await settle();
      const label=width+'-'+theme;
      geometry[label]=await evaluate("(()=>{const d=document.querySelector('.agent-selection-dialog'),l=document.querySelector('.agent-selection-list'),rows=[...l.querySelectorAll('[data-agent]')],r=d.getBoundingClientRect();return{viewport:[innerWidth,innerHeight],dialog:{width:r.width,height:r.height,top:r.top,bottom:r.bottom},list:{height:l.clientHeight,scrollHeight:l.scrollHeight},rows:rows.slice(0,3).map(e=>{const r=e.getBoundingClientRect();return{height:r.height,top:r.top,bottom:r.bottom}})};})()");
      await check('compactAgentProportions'+label,"(()=>{const d=document.querySelector('.agent-selection-dialog'),r=d.getBoundingClientRect(),l=document.querySelector('.agent-selection-list'),rows=[...l.querySelectorAll('[data-agent]')];return Math.abs(r.width-560)<1&&r.height<=560&&r.height/r.width<=1.01&&r.top>=36&&r.bottom<=innerHeight&&l.clientHeight<=312&&l.scrollHeight>l.clientHeight&&d.scrollHeight<=d.clientHeight+1&&document.documentElement.scrollWidth<=innerWidth&&rows.slice(0,3).every((e,i)=>{const a=e.getBoundingClientRect(),b=rows[i+1].getBoundingClientRect();return a.height<=74&&b.top-a.bottom<=3;});})()");
      await act("window.agentFixedBounds={search:document.querySelector('.agent-selection-search').getBoundingClientRect().toJSON(),footer:document.querySelector('.agent-selection-footer').getBoundingClientRect().toJSON()};document.querySelector('.agent-selection-list').scrollTop=100000;");await settle();
      await check('agentListScrollKeepsSearchAndFooterFixed'+label,"(()=>{const l=document.querySelector('.agent-selection-list'),s=document.querySelector('.agent-selection-search').getBoundingClientRect(),f=document.querySelector('.agent-selection-footer').getBoundingClientRect(),buttons=[...document.querySelectorAll('.agent-selection-footer button')];return l.scrollTop>0&&Math.abs(s.top-agentFixedBounds.search.top)<1&&Math.abs(f.top-agentFixedBounds.footer.top)<1&&buttons.length===2&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.top>=36&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});})()");
      await act("document.querySelector('.agent-selection-list').scrollTop=0;");await capture('agent-list-'+label);
    }
  }
  await pointerClick('[data-agent=planner]');await pointerClick('[data-agent=reviewer]');
  await check('compactRowsStillSupportActualPointerMultiselect',"document.querySelector('[data-agent=planner] input').checked&&document.querySelector('[data-agent=reviewer] input').checked&&document.querySelector('.agent-selection-start').textContent==='开始协奏 · 2'");
  await key('ESCAPE');await act("agentFixture.agents=originalAgentFixtures;");
  await act("agentFixture.mode='ok';showAppView('chat');document.body.dataset.theme='dark';document.documentElement.dataset.theme='dark';openAgentPicker()");
  await waitFor("document.querySelectorAll('[data-agent]').length===3"); await click(row('planner')); await click(row('reviewer')); await capture('agent-selection-dark');
  win.setSize(420, 520); await delay(200);
  await check('pickerFitsNarrowShortWindowWithoutHorizontalScroll', "(()=>{const d=document.querySelector('.agent-selection-dialog'),r=d.getBoundingClientRect(),b=document.querySelector('.agent-selection-start').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=36&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&b.bottom<=innerHeight})()");
  await check('agentListUsesRelayScrollbar', "(()=>{const e=document.querySelector('.agent-selection-list');return getComputedStyle(e,'::-webkit-scrollbar').width==='6px'&&getComputedStyle(e,'::-webkit-scrollbar-button').display==='none'})()");
  await capture('agent-selection-narrow');
  await act("document.querySelector('[data-agent=reviewer] input').focus()"); await key('SPACE');
  await check('keyboardCanSwitchTeamBackToSingleAgent', "!document.querySelector('[data-agent=reviewer] input').checked && document.querySelector('.agent-selection-start').textContent==='开始对话'");
  await key('ESCAPE');
  await check('closingInNarrowWindowRestoresVisibleFocus', "!document.querySelector('.agent-selection-dialog') && document.activeElement!==document.body && !document.activeElement.closest('[inert],[hidden]') && document.activeElement.getClientRects().length>0");
  await check('noRendererErrorsOrPmCalls', "uiFixture.errors.length===0 && agentFixture.pmCalls===0");
  clearTimeout(deadline); save(); console.log(JSON.stringify({ passed: Object.keys(checks).length, output })); app.exit(0);
}).catch(error => { failures.push(error.stack || String(error)); save(); console.error(error); clearTimeout(deadline); app.exit(1); });
