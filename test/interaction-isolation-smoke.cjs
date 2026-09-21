'use strict';
// Production renderer with synthetic conversations, held loads and decisions.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'interaction-isolation-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`); }
async function check(name, code) { step=name;checks[name]=!!await evaluate(code);save();if(!checks[name])throw Error(name); }
function seed() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const records = new Map(['A','B'].map(id => [id, { id, kind:'chat', title:'Synthetic '+id, model:'opus', turns:[], updatedAt:'2026-09-10T00:00:00.000Z' }]));
  const initial = [
    { id:'A-permission', conversationId:'A', kind:'permission', state:'pending', createdAt:'2026-09-10T00:00:00Z', toolName:'Read', permission:{ input:{file_path:'synthetic.txt'}, description:'读取合成文件', canAllowForSession:true } },
    { id:'B-permission', conversationId:'B', kind:'permission', state:'pending', createdAt:'2026-09-10T00:00:01Z', toolName:'Bash', permission:{ input:{command:'synthetic-command'}, description:'检查合成项目', canAllowForSession:true } },
  ];
  const f=window.isolationFixture={records, items:new Map(initial.map(item=>[item.id,item])), decisions:[], heldDecisions:new Map(), holdDecision:false, heldLoads:[], holdLoads:false, failLoad:false, loads:[], saves:0,
    emit(item,type='interaction.pending') { if(type.endsWith('resolved'))this.items.delete(item.id);else this.items.set(item.id,item);uiFixture.emit('interactions.onEvent',{type,interaction:clone(item)}); },
    add(id,conversationId,kind='permission') { const item={...clone(initial[0]),id,conversationId,kind,createdAt:'2026-09-10T00:01:00Z'};if(kind==='question')item.question={questions:[{question:'如何展示合成结果？',multiSelect:true,options:[{label:'简洁',description:'保留重点'},{label:'详细',description:'展示过程'}]}]};this.emit(item); },
  };
  const history={
    list:async()=>[...records.values()].map(clone),
    load:async id=>{f.loads.push(id);if(f.failLoad)throw Error('synthetic load failure');if(f.holdLoads)return new Promise(resolve=>f.heldLoads.push({id,resolve:()=>resolve(clone(records.get(id)||null))}));return clone(records.get(id)||null);},
    save:async value=>{f.saves++;records.set(value.id,clone(value));return clone(value);},
  };
  const interactions={
    list:async()=>({ok:true,items:[...f.items.values()].map(clone)}),onEvent:callback=>base.interactions.onEvent(callback),
    respond:async(id,decision)=>{f.decisions.push({id,...clone(decision)});if(f.holdDecision)return new Promise(resolve=>f.heldDecisions.set(id,resolve));f.items.delete(id);return{ok:true};},
  };
  window.api=new Proxy(base,{get(target,key){if(key==='history')return history;if(key==='interactions')return interactions;return target[key];}});
  localStorage.clear();
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const fixture=fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8')+`\n(${seed.toString()})();`;
  const page=path.join(output,'fixture.html');
  fs.writeFileSync(page,fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',`<head><base href="${pathToFileURL(path.join(root,'renderer')+path.sep).href}"><script>${fixture}</script>`));
  win=new BrowserWindow({width:1180,height:920,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(page);win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns');await settle();
  await check('blankStartupDoesNotShowPendingRequestsFromOtherConversations','interactionSurfaceMount.hidden&&isolationFixture.decisions.length===0');
  await evaluate("loadConversation('A')");await waitFor("!interactionSurfaceMount.hidden&&document.querySelector('.interaction-title').textContent.includes('读取')");
  await check('onlyCurrentConversationHasVisibleRequestAndPager',"document.querySelector('.interaction-pager').hidden&&document.querySelector('[data-action=allow_once]')&&!document.querySelector('.interaction-source:not([hidden])')");
  await act("window.oldDecisionTitle=interactionSurfaceTitle;startNewConv();");
  await check('newConversationSynchronouslyHidesPreviousApproval','interactionSurfaceMount.hidden&&currentConv===null');
  await act("oldDecisionTitle.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));isolationFixture.add('A-late','A');");await settle();
  await check('backgroundRequestsCannotApproveOrReopenAnEmptyConversation','interactionSurfaceMount.hidden&&isolationFixture.decisions.length===0&&currentConv===null');
  await evaluate("loadConversation('B')");await settle();
  await check('switchingHistoryShowsOnlyItsOwnRequest',"!interactionSurfaceMount.hidden&&document.querySelector('.interaction-title').textContent.includes('终端命令')&&document.querySelector('.interaction-pager').hidden");
  await act("isolationFixture.holdLoads=true;window.delayedNavigation=loadConversation('A');");
  await check('oldApprovalHidesDuringDeferredHistoryLoad','interactionSurfaceMount.hidden');
  await act("isolationFixture.add('B-late','B');");await settle();
  await check('pendingEventsCannotReopenApprovalDuringNavigation','interactionSurfaceMount.hidden');
  await act("startNewConv();isolationFixture.holdLoads=false;isolationFixture.heldLoads.splice(0).forEach(load=>load.resolve());");await evaluate('delayedNavigation');await settle();
  await check('staleHistoryResponseCannotRestoreItsApproval','currentConv===null&&interactionSurfaceMount.hidden');
  await evaluate("loadConversation('B')");await settle();
  await act("isolationFixture.failLoad=true;window.failedNavigation=loadConversation('A').catch(()=>false);");await evaluate('failedNavigation');await settle();
  await check('failedNavigationRestoresStillCurrentConversation',"currentConv.id==='B'&&!interactionSurfaceMount.hidden&&document.querySelector('.interaction-title').textContent.includes('终端命令')");
  await act("isolationFixture.failLoad=false;showAppView('settings');");
  await check('managementPagesHideInteractionImmediately','interactionSurfaceMount.hidden');
  await act("isolationFixture.add('A-unrelated','A');showChatView();");await settle();
  await check('returningToChatKeepsConversationAndItsOwnQueue',"currentConv.id==='B'&&!interactionSurfaceMount.hidden&&document.querySelector('.interaction-position').textContent.includes('/ 2')");
  await evaluate("loadConversation('A')");await settle();
  await act("isolationFixture.holdDecision=true;document.querySelector('[data-action=allow_once]').click();");
  await check('submittingBelongsToOriginalRequest',"isolationFixture.decisions.length===1&&isolationFixture.decisions[0].id==='A-permission'");
  await evaluate("loadConversation('B')");await settle();
  await check('inflightOtherConversationDoesNotDisableCurrentDecision',"!document.querySelector('[data-action=deny]').disabled&&document.querySelector('.interaction-title').textContent.includes('终端命令')");
  await act("isolationFixture.holdDecision=false;document.querySelector('[data-action=deny]').click();");await settle();
  await check('anotherConversationCanRespondWithoutChangingOriginalDecision',"isolationFixture.decisions.length===2&&isolationFixture.decisions[1].id==='B-permission'&&isolationFixture.decisions[1].action==='deny'");
  await act("isolationFixture.heldDecisions.get('A-permission')({ok:false,error:'synthetic A approval failure'});");await settle();
  await check('lateErrorCannotReplaceAnotherConversationOrStealItsFocus',"currentConv.id==='B'&&!document.querySelector('.interaction-live-status').textContent.includes('synthetic A')");
  await evaluate("loadConversation('A')");await settle();
  await check('returningToSourceRetainsItsFailedApprovalForRetry',"document.querySelector('.interaction-live-status').textContent.includes('synthetic A')&&!document.querySelector('[data-action=allow_once]').disabled");
  await act("for(const item of [...isolationFixture.items.values()])if(item.conversationId==='A')isolationFixture.emit({...item,state:'resolved'},'interaction.resolved');isolationFixture.add('A-question','A','question');");await settle();
  await act("document.querySelector('.interaction-option input').click();const input=document.querySelector('.interaction-other-input');input.value='仅此会话草稿';input.dispatchEvent(new Event('input',{bubbles:true}));");
  await evaluate("loadConversation('B')");await settle();
  await check('questionDraftAndControlsDoNotLeakToAnotherConversation',"!document.querySelector('.interaction-question-form')&&!interactionSurfaceMount.textContent.includes('仅此会话草稿')");
  await evaluate("loadConversation('A')");await settle();
  await check('returningToQuestionRestoresSelectionAndFreeText',"document.querySelector('.interaction-option input').checked&&document.querySelector('.interaction-other-input').value==='仅此会话草稿'");
  await check('permissionAndQuestionUseExactlyTheComposerWidth',"(()=>{const c=document.querySelector('.interaction-surface').getBoundingClientRect(),i=inputCard.getBoundingClientRect();return Math.abs(c.left-i.left)<1&&Math.abs(c.right-i.right)<1})()");
  await act("isolationFixture.holdLoads=true;window.dispatchEvent(new CustomEvent('relay:focus-interaction',{detail:{conversationId:'B',interactionId:'B-late'}}));startNewConv();isolationFixture.holdLoads=false;isolationFixture.heldLoads.splice(0).forEach(load=>load.resolve());");await settle();await settle();
  await check('lateFocusRequestCannotReopenCardAfterNewConversation','currentConv===null&&interactionSurfaceMount.hidden');
  await check('noCrossConversationSideEffectsOrRendererErrors',"isolationFixture.saves===0&&uiFixture.errors.length===0&&!uiFixture.calls.includes('runClaude')&&typeof require==='undefined'");
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(error.stack||String(error));console.error(error.stack||error);if(win&&!win.isDestroyed())try{fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch(_){}save();clearTimeout(deadline);app.exit(1);});
