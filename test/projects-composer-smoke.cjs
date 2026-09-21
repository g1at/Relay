'use strict';
// Isolated production renderer. All projects, dialogs, history and model events
// are synthetic in-memory data; no real main process, folders or provider calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'projects-composer-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 150000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(120); await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch{}});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+7000;const tick=()=>{if(${code})return resolve();if(Date.now()>until)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function pointerClick(code,button='left') {
  const point = await evaluate(`(() => { const e=${code};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);const hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!hit||!e.contains(hit))throw Error('Target is clipped or covered: '+(e.id||e.textContent));return{x,y};})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',button,clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button,clickCount:1,...point});
  await settle();
}
async function click(selector) { await pointerClick(`document.querySelector(${JSON.stringify(selector)})`); }
async function menuItem(label) { await pointerClick(`Array.from(document.querySelectorAll('.composer-add-menu [role="menuitem"],.composer-add-menu [role="menuitemradio"],.composer-add-menu [role="menuitemcheckbox"]')).find(e=>projectVisible(e)&&e.querySelector('.composer-menu-label>span')?.textContent===${JSON.stringify(label)})`); }
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await settle(); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }

const seed = String.raw`(() => {
  localStorage.clear(); const base = window.api;
  const clone = value => JSON.parse(JSON.stringify(value));
  const ids = { alpha:'aaaaaaaa-1111-4111-8111-111111111111', beta:'bbbbbbbb-2222-4222-8222-222222222222', loose:'cccccccc-3333-4333-8333-333333333333', member:'dddddddd-4444-4444-8444-444444444444' };
  const projects = [
    { id:ids.alpha, name:'研究项目', path:'D:\\Synthetic\\Research' },
    { id:ids.beta, name:'文档项目', path:'D:\\Synthetic\\Documents' },
  ];
  const histories = new Map([
    [ids.loose,{id:ids.loose,title:'普通历史对话',projectId:null,workingDir:null,model:'opus',mode:'plain',sessionId:null,createdAt:'2026-08-01T08:00:00.000Z',updatedAt:'2026-08-02T08:00:00.000Z',turns:[{user:'旧任务',assistant:'旧答复'}]}],
    [ids.member,{id:ids.member,title:'研究项目中的旧对话',projectId:ids.alpha,workingDir:{path:projects[0].path,name:projects[0].name},model:'opus',mode:'plain',sessionId:null,createdAt:'2026-08-01T09:00:00.000Z',updatedAt:'2026-08-03T09:00:00.000Z',turns:[{user:'项目旧任务',assistant:'项目旧答复'}]}],
  ]);
  const state = window.projectsFixture = {
    ids, projects, histories, launches:[], saves:[], assignments:[], added:[], renamed:[], removed:[], opened:[], folders:[], files:[], attachmentResults:[], attachmentOptions:[], dialogCalls:[], busy:new Set(), failures:[],
    emit(event) { uiFixture.emit('onEvent',clone(event)); },
    finish(jobId,text='项目任务完成') {
      const launch=this.launches.find(args=>args[11]===jobId);if(launch)this.busy.delete(launch[12]||launch[9]);
      this.emit({jobId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',is_error:false,result:text}});
    },
  };
  const decorate = conversation => {
    if(!conversation)return null;const next=clone(conversation),project=projects.find(p=>p.id===next.projectId);
    next.projectId=project?.id||null;next.workingDir=project?{path:project.path,name:project.name}:null;return next;
  };
  const projectApi = {
    list:async()=>{if(state.holdNextProjectList){state.holdNextProjectList=false;await new Promise(resolve=>state.releaseProjectList=resolve);}return{ok:true,projects:clone(projects),workspace:'D:\\Synthetic\\RelayProjects'};},
    add:async input=>{
      state.added.push(clone(input));const previous=projects.find(p=>p.path===input.path);if(previous)return{ok:true,project:clone(previous)};
      const project={id:crypto.randomUUID(),name:input.name||String(input.path).split(/[\\/]/).filter(Boolean).pop(),path:input.path};projects.push(project);return{ok:true,project:clone(project)};
    },
    rename:async({id,name})=>{state.renamed.push({id,name});const project=projects.find(p=>p.id===id);if(!project)return{ok:false,error:'项目不存在'};project.name=name;return{ok:true,project:clone(project)};},
    assign:async({conversationId,projectId})=>{
      state.assignments.push({conversationId,projectId});if(state.busy.has(conversationId))return{ok:false,error:'当前对话正在运行，请结束任务后再切换项目'};
      const conversation=histories.get(conversationId);if(!conversation)return{ok:false,error:'对话不存在'};
      if(projectId&&!projects.some(p=>p.id===projectId))return{ok:false,error:'项目不存在'};
      conversation.projectId=projectId||null;conversation.sessionId=null;const canonical=decorate(conversation);histories.set(conversationId,canonical);return{ok:true,conversation:clone(canonical)};
    },
    remove:async id=>{
      const affected=[...histories.values()].filter(c=>c.projectId===id).map(c=>c.id);if(affected.some(id=>state.busy.has(id)))return{ok:false,error:'项目内有任务正在运行'};
      state.removed.push(id);const index=projects.findIndex(p=>p.id===id);if(index>=0)projects.splice(index,1);
      for(const id of affected){const conv=histories.get(id);conv.projectId=null;conv.workingDir=null;conv.sessionId=null;}return{ok:true,affected};
    },
    open:async id=>{state.opened.push(id);return{ok:true};},
  };
  window.api = new Proxy(base,{get(target,key){
    if(key==='projects')return projectApi;
    if(key==='openAttachmentDialog')return async(options={})=>{state.dialogCalls.push('attachments');state.attachmentOptions.push(clone(options));return clone(state.attachmentResults.shift()||[]);};
    if(key==='openFolderDialog')return async()=>{state.dialogCalls.push('folder');return clone(state.folders.shift()||null);};
    if(key==='openFileDialog')return async()=>{state.dialogCalls.push('file');return clone(state.files.shift()||[]);};
    if(key==='runClaude')return async(...args)=>{state.launches.push(clone(args));state.busy.add(args[12]||args[9]);return{ok:true,jobId:args[11],sessionId:'synthetic-session'};};
    if(key==='history')return new Proxy(target.history,{get(original,method){
      if(method==='list')return async()=>[...histories.values()].map(decorate);
      if(method==='load')return async id=>decorate(histories.get(id));
      if(method==='save')return async value=>{
        const conv=clone(value);state.saves.push(clone(conv));if(!conv.id)conv.id=crypto.randomUUID();
        const previous=histories.get(conv.id);if(previous)conv.projectId=previous.projectId;
        conv.createdAt=conv.createdAt||new Date().toISOString();conv.updatedAt=new Date().toISOString();
        const canonical=decorate(conv);histories.set(conv.id,canonical);return{id:conv.id,updatedAt:conv.updatedAt};
      };
      return original[method];
    }});
    return target[key];
  }});
  window.composerHomeActions=()=>[...document.querySelectorAll('.composer-add-home .composer-menu-item')].filter(e=>!e.closest('.composer-skills-section'));
  window.projectVisible=e=>!!e&&e.getClientRects().length>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
})();`;

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html = fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+seed+'</script>');
  const page = path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win = new BrowserWindow({width:1200,height:800,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);
  await waitFor('providerRoutingLoaded && !restoringActiveRuns && document.getElementById("btnProjectContext")');
  await waitFor('document.querySelectorAll(".history-project").length===2');
  await check('projectsGroupHistoryWithoutDroppingUnassignedConversation',"document.querySelector('[data-project-id=\"'+projectsFixture.ids.alpha+'\"] .history-item[data-id=\"'+projectsFixture.ids.member+'\"]')&&document.querySelector('.history-item[data-id=\"'+projectsFixture.ids.loose+'\"]')");
  await check('inputCardAndControlsHaveUsableGeometry',"(()=>{const r=inputCard.getBoundingClientRect(),t=inputEl.getBoundingClientRect(),s=document.getElementById('btnSend').getBoundingClientRect();return r.width>350&&r.height>=65&&t.width>250&&s.width>=25&&s.left>=r.left&&s.right<=r.right})()");
  await check('projectContextLivesOutsideInputCard',"projectVisible(document.getElementById('btnProjectContext'))&&!document.getElementById('inputCard').contains(document.getElementById('btnProjectContext'))");
  await click('#btnAttach');
  await check('plusMenuExposesGroupedActionsAndIntegratedSkills',"document.querySelector('.composer-add-menu[role=menu]')&&composerHomeActions().length===4&&document.querySelector('.composer-skill-search')&&document.querySelector('.composer-skill-list')&&['添加文件','在项目中工作','目标','计划模式'].every(label=>Array.from(document.querySelectorAll('.composer-menu-item')).some(e=>e.textContent.includes(label)&&e.querySelector('svg')))&&projectsFixture.dialogCalls.length===0");
  await capture('add-menu-light');
  await act('window.projectFirstFocus=document.activeElement;');await key('DOWN');
  await check('arrowKeyMovesWithinMenu',"document.activeElement!==projectFirstFocus&&document.activeElement.closest('[role=menu]')");
  await key('END');
  await check('endKeyReachesIntegratedSkillSearch',"document.activeElement.classList.contains('composer-skill-search')");
  await key('ESCAPE');
  await check('escapeClosesMenuAndRestoresAnchorFocus',"!document.querySelector('.composer-add-menu')&&document.activeElement===document.getElementById('btnAttach')");
  await click('#btnAttach');await act("window.inlineProjectMenu=document.querySelector('.composer-add-menu');window.inlineProjectHeight=inlineProjectMenu.getBoundingClientRect().height;");await menuItem('在项目中工作');
  await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===2');
  await check('plusProjectPageKeepsSamePanelAndInputWidth',"(()=>{const m=document.querySelector('.composer-add-menu'),r=m.getBoundingClientRect(),c=inputCard.getBoundingClientRect();return m===inlineProjectMenu&&m.dataset.variant==='composer-add'&&m.dataset.page==='projects'&&Math.abs(r.height-inlineProjectHeight)<1&&Math.abs(r.left-c.left)<1&&Math.abs(r.right-c.right)<1&&Math.abs(c.top-r.bottom-8)<1&&m.querySelector('.composer-menu-back')&&m.querySelector('.project-search')&&m.querySelectorAll('.project-picker-footer button').length===2;})()");
  await click('.composer-menu-back');
  await check('projectBackRestoresHomeWithoutChangingDraftOrProject',"document.querySelector('.composer-add-menu')===inlineProjectMenu&&inlineProjectMenu.dataset.page==='home'&&projectVisible(document.querySelector('.composer-add-home'))&&document.activeElement.querySelector('.composer-menu-label>span')?.textContent==='在项目中工作'&&currentProjectId==null&&projectsFixture.assignments.length===0");
  await key('ESCAPE');
  await click('#btnAttach');await menuItem('添加文件');
  await check('singleFileActionCallsSystemDialogWithoutSubmenu',"!document.querySelector('.composer-add-menu,.attachment-picker-overlay')&&projectsFixture.dialogCalls.join(',')==='attachments'&&projectsFixture.attachmentOptions.length===1&&projectsFixture.attachmentOptions[0].kind==='files'");
  await check('canceledFileDialogPreservesDraftAndProject',"attachedFiles.length===0&&currentProjectId==null&&!projectsFixture.attachmentOptions[0].defaultPath");
  await act("window.attachmentCallsBeforeFile=projectsFixture.attachmentOptions.length;projectsFixture.attachmentResults.push([{path:'D:/Synthetic/spec.md',name:'spec.md',ext:'md',size:12,isDirectory:false}]);");
  await click('#btnAttach');await menuItem('添加文件');
  await check('filePickerAddsOneAttachment',"projectsFixture.attachmentOptions.length===attachmentCallsBeforeFile+1&&projectsFixture.attachmentOptions.at(-1).kind==='files'&&attachedFiles.length===1&&attachedFiles[0].name==='spec.md'&&document.querySelectorAll('#attachments .ac-del').length===1");
  // Existing or dropped directory context still survives project assignment and send.
  await act("window.attachmentCallsBeforeExistingFolder=projectsFixture.attachmentOptions.length;addFiles([{path:'D:/Synthetic/References',name:'参考资料',ext:'folder',size:0,isDirectory:true}]);");
  await check('existingDirectoryContextDoesNotInvokeFileDialogOrChangeProject',"projectsFixture.attachmentOptions.length===attachmentCallsBeforeExistingFolder&&attachedFiles.length===2&&attachedFiles[1].isDirectory===true&&attachedFiles[1].ext==='folder'&&document.getElementById('attachments').textContent.includes('参考资料')&&currentProjectId==null&&projectsFixture.added.length===0");
  await capture('folder-attachment');
  await click('#attachments .ac-del');
  await check('attachmentRemovalKeepsFolderContext',"attachedFiles.length===1&&attachedFiles[0].isDirectory===true");
  await act("window.projectReservedDraft=relayConversationWorkspace();window.projectHistoryBeforeDraft=projectsFixture.histories.size;");
  await click('#btnProjectContext');
  await act("const e=document.querySelector('.project-search');e.value='文档';e.dispatchEvent(new Event('input',{bubbles:true}));");await settle();
  await check('projectSearchFiltersNamesAndRetainsCreationAction',"Array.from(document.querySelectorAll('.composer-menu-item')).filter(projectVisible).some(e=>e.textContent.includes('文档项目'))&&!Array.from(document.querySelectorAll('.composer-menu-item')).filter(projectVisible).some(e=>e.textContent.includes('研究项目'))&&projectVisible(document.querySelector('.project-picker-footer .composer-menu-item'))&&document.querySelector('.project-picker-footer').textContent.includes('新建项目')&&document.querySelector('.project-picker-footer').textContent.includes('不在项目中工作')");
  await key('ESCAPE');
  await click('#btnProjectContext');await menuItem('研究项目');
  await check('newDraftSelectsProjectAndPreservesAttachments',"currentProjectId===projectsFixture.ids.alpha&&document.getElementById('btnProjectContext').textContent.includes('研究项目')&&attachedFiles.length===1");
  await click('#btnAttach');await menuItem('添加文件');
  await check('selectedProjectPathReachesSystemAttachmentDialog',"projectsFixture.attachmentOptions.at(-1).kind==='files'&&projectsFixture.attachmentOptions.at(-1).defaultPath===projectsFixture.projects.find(p=>p.id===projectsFixture.ids.alpha).path&&currentProjectId===projectsFixture.ids.alpha&&attachedFiles.length===1");
  await check('projectSelectionUsesStableDraftAndCorrectDirectoryWithoutEmptyHistory',"(()=>{const selected=relayConversationWorkspace(),again=relayConversationWorkspace();return selected.conversationId===again.conversationId&&workspaceDraftId===selected.conversationId&&selected.projectId===projectsFixture.ids.alpha&&selected.workingDir===projectsFixture.projects.find(p=>p.id===projectsFixture.ids.alpha).path&&currentConv==null&&projectsFixture.histories.size===projectHistoryBeforeDraft&&projectsFixture.assignments.length===0&&currentProjectId===projectsFixture.ids.alpha;})()");
  await act("inputEl.value='项目中的首个任务';inputEl.dispatchEvent(new Event('input',{bubbles:true}));");await click('#btnSend');
  await waitFor('projectsFixture.launches.length===1');
  await check('firstSendPersistsProjectAndNormalExecutionMode',"currentConv.projectId===projectsFixture.ids.alpha&&projectsFixture.histories.get(currentConv.id).projectId===projectsFixture.ids.alpha&&(projectsFixture.launches[0][15]||{kind:'default'}).kind==='default'&&projectsFixture.launches[0][3].some(file=>file.ext==='folder'&&file.isDirectory===true)&&currentConv.turns[0].files.some(file=>file.isDirectory===true)");
  await check('runningConversationDisablesProjectAndModeChanges',"document.getElementById('btnProjectContext').disabled&&currentProjectId===projectsFixture.ids.alpha");
  await click('#btnAttach');
  await check('runningMenuKeepsFileContextButDisablesProjectGoalAndPlan',"(()=>{const blocked=Array.from(document.querySelectorAll('.composer-add-home>.composer-menu-item')).filter(e=>['在项目中工作','目标','计划模式'].includes(e.querySelector('.composer-menu-label>span').textContent));return blocked.length===3&&blocked.every(e=>e.disabled)&&document.querySelectorAll('[data-attachment-kind]').length===1&&!document.querySelector('[data-attachment-kind=files]').disabled&&!document.querySelector('[data-attachment-kind=folders]');})()");
  await key('ESCAPE');await act("projectsFixture.finish(projectsFixture.launches[0][11]);");await waitFor('!isRunning');
  await check('taskCompletionRestoresProjectControls',"!document.getElementById('btnProjectContext').disabled");
  await evaluate('loadConversation(projectsFixture.ids.loose)');await settle();
  await check('openingLegacyConversationResetsProjectAndMode',"currentConv.id===projectsFixture.ids.loose&&currentProjectId==null&&(currentExecutionMode||{kind:'default'}).kind==='default'");
  await act("window.projectOldTimestamp=projectsFixture.histories.get(projectsFixture.ids.loose).updatedAt;window.projectSavesBeforeMove=projectsFixture.saves.length;");
  await click('#btnProjectContext');await menuItem('文档项目');
  await check('movingExistingConversationUsesMetadataApiWithoutRefreshingActivity',"currentConv.projectId===projectsFixture.ids.beta&&projectsFixture.assignments.at(-1).conversationId===projectsFixture.ids.loose&&projectsFixture.histories.get(projectsFixture.ids.loose).updatedAt===projectOldTimestamp&&projectsFixture.saves.length===projectSavesBeforeMove");
  await check('movedConversationAppearsUnderSelectedProject',"document.querySelector('[data-project-id=\"'+projectsFixture.ids.beta+'\"] .history-item[data-id=\"'+projectsFixture.ids.loose+'\"]')");
  await click('[data-project-id="bbbbbbbb-2222-4222-8222-222222222222"] .project-chevron');
  await check('collapseHidesOnlyProjectChildrenAndPersistsChoice',"document.querySelector('[data-project-id=\"'+projectsFixture.ids.beta+'\"] .history-group-items').hidden&&JSON.parse(localStorage.getItem('relay.projects.collapsed')).includes(projectsFixture.ids.beta)");
  await click('[data-project-id="bbbbbbbb-2222-4222-8222-222222222222"] .project-chevron');
  await click('[data-project-id="bbbbbbbb-2222-4222-8222-222222222222"] .project-more');await menuItem('打开文件夹');
  await check('projectOpenCallsOnlySelectedProject',"projectsFixture.opened.at(-1)===projectsFixture.ids.beta");
  await act("window.projectMemberTimestamp=projectsFixture.histories.get(projectsFixture.ids.member).updatedAt;document.querySelector('.history-item[data-id=\"'+projectsFixture.ids.member+'\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));");await settle();
  await check('historyRightClickDoesNotOpenProjectOrForkPopovers',"!document.querySelector('.composer-add-menu[data-variant=project-picker]')&&!document.querySelector('.session-fork-menu')&&currentConv.id===projectsFixture.ids.loose&&currentProjectId===projectsFixture.ids.beta&&projectsFixture.histories.get(projectsFixture.ids.member).projectId===projectsFixture.ids.alpha");
  await evaluate('loadConversation(projectsFixture.ids.member)');await settle();
  await click('#btnProjectContext');await menuItem('不在项目中工作');
  await check('normalProjectControlCanRemoveMembershipWithoutChangingActivityTime',"currentConv.id===projectsFixture.ids.member&&currentProjectId==null&&projectsFixture.histories.get(projectsFixture.ids.member).projectId==null&&projectsFixture.histories.get(projectsFixture.ids.member).updatedAt===projectMemberTimestamp");
  await evaluate('loadConversation(projectsFixture.ids.loose)');await settle();
  await click('[data-project-id="bbbbbbbb-2222-4222-8222-222222222222"] .project-more');await menuItem('重命名');
  await act("document.querySelector('.confirm-input').value='未确认的新名称';");await click('.confirm-btn.cancel');
  await check('cancelingRenameDoesNotWriteProject',"projectsFixture.renamed.length===0&&projectsFixture.projects.find(p=>p.id===projectsFixture.ids.beta).name==='文档项目'");
  await click('[data-project-id="bbbbbbbb-2222-4222-8222-222222222222"] .project-more');await menuItem('重命名');
  await act("document.querySelector('.confirm-input').value='文档项目（已改名）';");await click('.confirm-btn.primary');
  await check('renameUpdatesProjectAndContextWithoutReorderingHistory',"projectsFixture.renamed.at(-1).id===projectsFixture.ids.beta&&document.getElementById('btnProjectContext').textContent.includes('文档项目（已改名）')&&projectsFixture.histories.get(projectsFixture.ids.loose).updatedAt===projectOldTimestamp");
  await act("window.projectRowsBeforeCancel=projectsFixture.projects.length;projectsFixture.folders.push(null);");await click('#btnAddProject');
  await check('cancelingProjectFolderSelectionDoesNotCreateOrNavigate',"projectsFixture.projects.length===projectRowsBeforeCancel&&currentConv.id===projectsFixture.ids.loose");
  await act("projectsFixture.folders.push({path:'D:\\\\Synthetic\\\\NewProject',name:'新增项目'});");await click('#btnAddProject');
  await check('sidebarAddCreatesProjectAndStartsItsDraft',"projectsFixture.added.at(-1).name==='新增项目'&&currentProjectId===projectsFixture.projects.at(-1).id&&currentConv==null&&document.getElementById('btnProjectContext').textContent.includes('新增项目')");
  await click('#btnAttach');await menuItem('计划模式');
  await check('planSelectionShowsCancelableModeChip',"currentExecutionMode.kind==='plan'&&projectVisible(document.getElementById('btnExecutionMode'))&&document.getElementById('btnExecutionMode').textContent.includes('计划模式')");
  await click('#btnExecutionMode');
  await check('modeChipCancelsPlanWithoutSendingAnything',"currentExecutionMode.kind==='default'&&document.getElementById('btnExecutionMode').hidden&&projectsFixture.launches.length===1");
  await click('#btnAttach');await menuItem('计划模式');
  await act("inputEl.value='先调查并给出计划';inputEl.dispatchEvent(new Event('input',{bubbles:true}));");await click('#btnSend');
  await waitFor('projectsFixture.launches.length===2');
  await check('planModeReachesBackendAndOwningConversation',"projectsFixture.launches[1][15].kind==='plan'&&currentConv.executionMode.kind==='plan'");
  await act("projectsFixture.finish(projectsFixture.launches[1][11],'这是只读计划');");await waitFor('!isRunning');
  await act("window.planConversationId=currentConv.id;startNewConv();");await settle();
  await check('newConversationDoesNotInheritPreviousPlan',"currentExecutionMode.kind==='default'&&currentProjectId===projectsFixture.projects.at(-1).id");
  await evaluate('loadConversation(planConversationId)');await settle();
  await check('openingPlanHistoryRestoresMode',"currentExecutionMode.kind==='plan'&&document.getElementById('btnExecutionMode').textContent.includes('计划模式')");
  await act('startNewConv();');await settle();await click('#btnAttach');await menuItem('目标');
  await check('goalSelectionShowsModeWithoutLaunchingTask',"currentExecutionMode.kind==='goal'&&document.getElementById('btnExecutionMode').textContent.includes('目标')&&projectsFixture.launches.length===2");
  await click('#btnExecutionMode');
  await check('goalCanBeCanceledBeforeSend',"currentExecutionMode.kind==='default'&&projectsFixture.launches.length===2");
  await click('#btnAttach');await menuItem('目标');
  await act("inputEl.value='完成目标：所有检查通过';inputEl.dispatchEvent(new Event('input',{bubbles:true}));");await click('#btnSend');
  await waitFor('projectsFixture.launches.length===3');
  await check('goalConditionAndModeReachBackendUnchanged',"projectsFixture.launches[2][0]==='完成目标：所有检查通过'&&projectsFixture.launches[2][15].kind==='goal'&&currentConv.executionMode.kind==='goal'");
  await act("projectsFixture.finish(projectsFixture.launches[2][11],'目标已完成');");await waitFor('!isRunning');
  await act("startNewConv();inputEl.value='/plan 调查目录并给出方案';inputEl.dispatchEvent(new Event('input',{bubbles:true}));");await click('#btnSend');
  await waitFor('projectsFixture.launches.length===4');
  await check('slashPlanSelectsRealPlanModeAndStripsCommand',"projectsFixture.launches[3][15].kind==='plan'&&projectsFixture.launches[3][0]==='调查目录并给出方案'&&currentExecutionMode.kind==='plan'");
  await act("projectsFixture.finish(projectsFixture.launches[3][11]);");await waitFor('!isRunning');
  await act("startNewConv();inputEl.value='/goal 检查全部通过';inputEl.dispatchEvent(new Event('input',{bubbles:true}));");await click('#btnSend');
  await waitFor('projectsFixture.launches.length===5');
  await check('slashGoalSelectsRealGoalModeAndPreservesCondition',"projectsFixture.launches[4][15].kind==='goal'&&projectsFixture.launches[4][0]==='检查全部通过'&&currentExecutionMode.kind==='goal'");
  await act("projectsFixture.finish(projectsFixture.launches[4][11]);");await waitFor('!isRunning');
  await act("window.removingProject=currentProjectId;window.conversationsBeforeRemove=[...projectsFixture.histories.values()].map(c=>({id:c.id,updatedAt:c.updatedAt}));document.querySelector('[data-project-id=\"'+removingProject+'\"] .project-more').click();");await settle();await menuItem('移除项目');
  await click('.confirm-btn.cancel');
  await check('cancelingProjectRemovalKeepsFilesAndMembership',"projectsFixture.removed.length===0&&currentProjectId===removingProject&&projectsFixture.projects.some(p=>p.id===removingProject)");
  await act("document.querySelector('[data-project-id=\"'+removingProject+'\"] .project-more').click();");await settle();await menuItem('移除项目');await click('.confirm-btn.primary');
  await check('removingProjectPreservesEveryConversationAndTimestamp',"projectsFixture.removed.at(-1)===removingProject&&currentProjectId==null&&!projectsFixture.projects.some(p=>p.id===removingProject)&&conversationsBeforeRemove.every(c=>projectsFixture.histories.has(c.id)&&projectsFixture.histories.get(c.id).updatedAt===c.updatedAt)&&!document.querySelector('[data-project-id=\"'+removingProject+'\"]')");
  await act("projectsFixture.holdNextProjectList=true;document.getElementById('btnProjectContext').click();");
  await waitFor('!!projectsFixture.releaseProjectList');
  await evaluate("openSettings('general')");await settle();
  await act('projectsFixture.releaseProjectList();projectsFixture.releaseProjectList=null;');await settle();
  await check('lateProjectPickerCannotReappearOverSettings',"activeView==='settings'&&!document.querySelector('.composer-add-menu')");
  await act("showAppView('chat');");await settle();
  win.setSize(900,600);await settle();
  for(const theme of ['light','dark']) {
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);await click('#btnAttach');
    await check('defaultSizeMenuFits'+theme,"(()=>{const r=document.querySelector('.composer-add-menu').getBoundingClientRect();return r.left>=0&&r.top>=36&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth})()");
    await capture('add-menu-900-'+theme);await key('ESCAPE');
    await click('#btnProjectContext');
    await check('defaultSizeProjectPickerFits'+theme,"(()=>{const r=document.querySelector('.composer-add-menu').getBoundingClientRect();return r.left>=0&&r.top>=36&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.querySelector('.project-search')})()");
    await capture('projects-900-'+theme);await key('ESCAPE');
  }

  // At the normal sidebar width, short project names remain fully opaque.
  // At its minimum width, even a short name may overflow; fading must follow
  // the measured text width while every project remains reachable.
  win.setSize(1200,800);await settle();
  await act("projectsFixture.projects.unshift({id:'visual-huawei',name:'HUAWEI',path:'D:/Synthetic/HUAWEI'},{id:'visual-twcup',name:'twcup',path:'D:/Synthetic/twcup'},{id:'visual-long',name:'silent-motion-context-pack',path:'D:/Synthetic/silent-motion-context-pack'});if(!relaySidebarLayout.getState().expanded)relaySidebarLayout.toggle();");
  await evaluate('refreshHistoryList()');await settle();
  await act("document.getElementById('sidebarResizeHandle').focus();");await key('ENTER');
  await waitFor("document.querySelector('[data-project-id=visual-long] .project-name span').classList.contains('is-overflowing')");
  for(const theme of ['light','dark']) {
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-project-id=visual-huawei]').scrollIntoView({block:'nearest'});`);await settle();
    await check('shortProjectNamesStayOpaqueAndHitTestable'+theme,"['visual-huawei','visual-twcup'].every(id=>{const button=document.querySelector('[data-project-id='+id+'] .project-name'),name=button.querySelector('span'),glyph=document.createRange();glyph.setStart(name.firstChild,name.textContent.length-1);glyph.setEnd(name.firstChild,name.textContent.length);const r=glyph.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return name.scrollWidth<=name.clientWidth+1&&!name.classList.contains('is-overflowing')&&getComputedStyle(name).maskImage==='none'&&getComputedStyle(button.querySelector('svg')).maskImage==='none'&&name.title===name.textContent&&button.title.includes(name.textContent)&&hit&&button.contains(hit);})");
    await check('onlyOverflowingProjectNameHasEdgeFade'+theme,"(()=>{const name=document.querySelector('[data-project-id=visual-long] .project-name span');return name.scrollWidth>name.clientWidth+1&&name.classList.contains('is-overflowing')&&getComputedStyle(name).maskImage.includes('linear-gradient')&&getComputedStyle(name).textOverflow==='clip'&&name.title==='silent-motion-context-pack';})()");
    await capture('project-name-edges-'+theme);
  }
  await act("document.getElementById('sidebarResizeHandle').focus();");await key('END');
  await waitFor("!document.querySelector('[data-project-id=visual-long] .project-name span').classList.contains('is-overflowing')");
  await check('wideningSidebarRemovesFadeWhenWholeNameFits',"(()=>{const name=document.querySelector('[data-project-id=visual-long] .project-name span');return name.scrollWidth<=name.clientWidth+1&&getComputedStyle(name).maskImage==='none';})()");
  await key('HOME');
  await waitFor("document.querySelector('[data-project-id=visual-long] .project-name span').classList.contains('is-overflowing')");
  await check('narrowingSidebarRestoresOnlyActualOverflowFade',"['visual-huawei','visual-twcup','visual-long'].every(id=>{const button=document.querySelector('[data-project-id='+id+'] .project-name'),name=button.querySelector('span');button.scrollIntoView({block:'nearest'});const overflow=name.scrollWidth>name.clientWidth+1,mask=getComputedStyle(name).maskImage,r=name.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return name.clientWidth>0&&name.classList.contains('is-overflowing')===overflow&&(overflow?mask.includes('linear-gradient'):mask==='none')&&getComputedStyle(button.querySelector('svg')).maskImage==='none'&&name.title===name.textContent&&hit&&button.contains(hit);})");
  await key('ENTER');
  const hoverPoint=await evaluate("(()=>{const e=document.querySelector('[data-project-id=visual-huawei] .project-name');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  win.webContents.sendInputEvent({type:'mouseMove',...hoverPoint});await settle();
  await check('projectHoverActionsRemainVisibleAndUncovered',"[...document.querySelectorAll('[data-project-id=visual-huawei] .project-new-chat,[data-project-id=visual-huawei] .project-more')].every(button=>{const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return getComputedStyle(button).opacity==='1'&&hit&&button.contains(hit);})");
  await pointerClick("document.querySelector('[data-project-id=visual-huawei] .project-name')",'right');
  await check('rightClickProjectActionsUseCompactCardOnly',"(()=>{const menu=document.querySelector('.composer-add-menu'),r=menu.getBoundingClientRect();return menu.dataset.variant==='project-actions'&&Math.abs(r.width-220)<1&&r.left>=0&&r.right<=innerWidth&&r.top>=36&&r.bottom<=innerHeight&&menu.querySelectorAll('.composer-menu-item').length===4&&menu.querySelector('.composer-menu-heading').title==='HUAWEI'&&getComputedStyle(menu.querySelector('.composer-menu-heading')).maskImage==='none';})()");
  await capture('project-actions-compact');await menuItem('打开文件夹');
  await check('compactActionCardRoutesActualPointerClickToItsProject',"projectsFixture.opened.at(-1)==='visual-huawei'&&!document.querySelector('.composer-add-menu')");
  await click('#btnAttach');
  await check('addMenuMatchesInputCardWidthAndSitsDirectlyAbove',"(()=>{const menu=document.querySelector('.composer-add-menu'),r=menu.getBoundingClientRect(),c=inputCard.getBoundingClientRect();return menu.dataset.variant==='composer-add'&&getComputedStyle(menu).borderWidth==='1px'&&getComputedStyle(menu.querySelector('.composer-skills-section')).borderTopWidth==='0px'&&Math.abs(r.left-c.left)<1&&Math.abs(r.right-c.right)<1&&Math.abs(c.top-r.bottom-8)<1&&r.height<=440;})()");await key('ESCAPE');
  await click('#btnProjectContext');
  await check('projectPickerUsesCompactSearchListAndFixedActions',"(()=>{const menu=document.querySelector('.composer-add-menu');return menu.offsetWidth===280&&menu.offsetHeight<=288&&menu.dataset.variant==='project-picker'&&menu.querySelector('.project-picker-search svg')&&menu.querySelector('.project-search')&&menu.querySelector('.project-picker-footer')&&getComputedStyle(menu.querySelector('.project-picker-search')).borderBottomWidth==='0px'&&menu.querySelector('.project-picker-list').clientHeight<=160&&!menu.querySelector('.project-picker-list small')&&[...menu.querySelectorAll('.project-picker-list .composer-menu-item')].every(row=>row.title&&row.querySelector('.composer-menu-label>span'));})()");await key('ESCAPE');
  await check('noUnexpectedRendererErrors',"uiFixture.errors.length===0");
  save();console.log(JSON.stringify({passed:Object.values(checks).filter(Boolean).length,errors}));clearTimeout(deadline);app.exit(0);
}).catch(async error=>{errors.push(error.stack||String(error));try{if(win&&!win.isDestroyed()){fs.writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify(await evaluate('({geometry:[inputCard,inputEl,document.getElementById("btnSend")].map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON()})),currentConv,currentProjectId,currentExecutionMode,isRunning,attachedFiles,launches:projectsFixture.launches,saves:projectsFixture.saves,assignments:projectsFixture.assignments,errors:uiFixture.errors})'),null,2));await capture('failure');}}catch{}save();clearTimeout(deadline);app.exit(1);});
