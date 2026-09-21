'use strict';
// The real renderer in an isolated Electron profile. Projects, installed skills,
// dialogs and task events are synthetic. No Relay main, providers or user data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'composer-menu-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [], geometry = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, geometry, errors }, null, 2));
const timeout = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 150000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { await delay(100); await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch{}});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+6500;const tick=()=>{if(${code})return resolve();if(Date.now()>until)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function clickNode(code) {
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!hit||!e.contains(hit))throw Error('Clipped click target: '+(e.id||e.textContent));return{x,y}})()`);
  for (const type of ['mouseMove','mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  await settle();
}
const click = selector => clickNode(`document.querySelector(${JSON.stringify(selector)})`);
const item = label => clickNode(`Array.from(document.querySelectorAll('.composer-menu-item')).find(e=>menuVisible(e)&&e.querySelector('.composer-menu-label>span')?.textContent===${JSON.stringify(label)})`);
async function key(keyCode, modifiers = []) { for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode,modifiers}); await settle(); }
async function input(selector, value) { await act(`const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));`);await settle(); }
async function hoverScrollbar(selector) {
  const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.right-3),y:Math.round(r.top+Math.min(18,r.height/2))}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});await settle();
}
async function capture(name) { await settle(); fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()); }
async function drag(selector, deltaX) {
  const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+Math.min(200,r.height/2))}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});
  for(let i=1;i<=8;i++){win.webContents.sendInputEvent({type:'mouseMove',x:p.x+Math.round(deltaX*i/8),y:p.y,button:'left'});await delay(15);}
  win.webContents.sendInputEvent({type:'mouseUp',x:p.x+deltaX,y:p.y,button:'left',clickCount:1});await settle();
}
async function menuGeometry(name, sameWidth = true) {
  geometry[name]=await evaluate(`(()=>{const c=inputCard.getBoundingClientRect(),m=document.querySelector('.composer-add-menu').getBoundingClientRect();return{viewport:[innerWidth,innerHeight],card:{left:c.left,right:c.right,top:c.top,bottom:c.bottom,width:c.width},menu:{left:m.left,right:m.right,top:m.top,bottom:m.bottom,width:m.width},scroll:document.documentElement.scrollWidth,scrollY:window.scrollY,rootScrollTop:document.scrollingElement.scrollTop,chromeTop:document.getElementById('windowChrome').getBoundingClientRect().top}})()`);
  await check(name,`(()=>{const c=inputCard.getBoundingClientRect(),m=document.querySelector('.composer-add-menu').getBoundingClientRect();return ${sameWidth?'Math.abs(c.width-m.width)<=1.5&&Math.abs(c.left-m.left)<=1.5&&m.bottom<=c.top-7&&':''}m.top>=36&&m.bottom<=innerHeight-7&&m.left>=7&&m.right<=innerWidth-7&&document.documentElement.scrollWidth<=innerWidth})()`);
}
const seed = String.raw`(() => {
  localStorage.clear();const base=window.api,clone=value=>JSON.parse(JSON.stringify(value));
  const projects=Array.from({length:64},(_,i)=>({id:'aaaaaaaa-1111-4111-8111-'+String(i+1).padStart(12,'0'),name:'项目 '+String(i+1).padStart(2,'0')+' · 用于检查单行名称和长列表边界的本地研究资料',path:'D:\\Synthetic\\Projects\\Project-'+(i+1)}));
  const skills=Array.from({length:48},(_,i)=>({name:'fixture-skill-'+String(i+1).padStart(2,'0'),callName:'fixture-skill-'+String(i+1).padStart(2,'0'),displayName:'技能 '+String(i+1).padStart(2,'0'),desc:'检查长技能列表中的描述、选择和滚动行为。',summary:'检查文档内容并整理可复核的结论',defaultPrompt:'请使用技能 '+String(i+1).padStart(2,'0')+' 检查这份材料。'}));
  const state=window.composerMenuFixture={projects,skills,launches:[],steers:[],pauses:[],skillLoads:0,heldSkills:[],heldProjects:[],dialogs:[],attachmentOptions:[],attachmentResults:[],heldAttachments:[],closed:new Set(),
    finish(jobId,text='合成任务已完成'){this.closed.add(jobId);uiFixture.emit('onEvent',{jobId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',is_error:false,result:text}});},
  };
  window.api=new Proxy(base,{get(target,key){
    if(key==='projects')return{list:async()=>{const snapshot=clone(projects);if(state.holdProjects){state.holdProjects=false;await new Promise(resolve=>state.heldProjects.push(resolve));}return{ok:true,projects:snapshot,workspace:'D:\\Synthetic\\Relay'};},add:async()=>({ok:false,error:'fixture does not add projects'}),assign:async({conversationId,projectId})=>{const conversation=await base.history.load(conversationId);conversation.projectId=projectId;await base.history.save(conversation);return{ok:true,conversation};}};
    if(key==='data')return new Proxy(target.data,{get(original,method){if(method==='listSkills')return async()=>{state.skillLoads++;if(state.failSkills){state.failSkills=false;return{ok:false,error:'合成技能加载失败'};}const snapshot=state.emptySkills?[]:clone(skills);if(state.holdSkills){state.holdSkills=false;await new Promise(resolve=>state.heldSkills.push(resolve));}return{ok:true,items:snapshot};};return original[method];}});
    if(key==='openAttachmentDialog')return async(options={})=>{
      state.dialogs.push('attachments');state.attachmentOptions.push(clone(options));const result=clone(state.attachmentResults.shift()||[]);
      if(state.holdAttachment){state.holdAttachment=false;await new Promise(resolve=>state.heldAttachments.push(resolve));}return result;
    };
    if(key==='skills')return new Proxy(target.skills,{get(original,method){if(method==='backfillMetadata')return async()=>({ok:true,total:0});return original[method];}});
    if(key==='runClaude')return async(...args)=>{state.launches.push(clone(args));return{ok:true,jobId:args[11]};};
    if(key==='steerClaude')return async request=>{state.steers.push(clone(request));const input={id:request.messageId,text:request.prompt,files:request.files||[],skill:request.skill||null,status:'queued',ts:new Date().toISOString()};uiFixture.emit('onEvent',{jobId:request.jobId,type:'system',subtype:'relay_user_input',input});return{ok:true,jobId:request.jobId,messageId:request.messageId,input};};
    if(key==='pauseClaude')return async id=>{state.pauses.push(id);return{ok:false};};
    if(key==='openFolderDialog')return async()=>{state.dialogs.push('folder');return null;};
    if(key==='openFileDialog')return async()=>{state.dialogs.push('file');return[];};
    return target[key];
  }});
  window.composerHomeActions=()=>[...document.querySelectorAll('.composer-add-home .composer-menu-item')].filter(e=>!e.closest('.composer-skills-section'));
  window.menuVisible=e=>!!e&&e.getClientRects().length>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
})();`;
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const fixture=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+seed+'</script>');
  const page=path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win=new BrowserWindow({width:1200,height:800,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);win.focus();win.webContents.focus();
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&document.querySelectorAll(".history-project").length===64');
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await check('plusCombinesFourActionsAndInstalledSkills',"!document.getElementById('btnSkillQuick')&&composerHomeActions().length===4&&document.querySelector('.composer-skill-search')&&document.querySelectorAll('.composer-skill-item').length===48");
  await menuGeometry('plusMatchesInputCardAt1200');
  await check('addFileIsFirstFullWidthActionWithoutFolderEntry',"(()=>{const f=document.querySelector('[data-attachment-kind=files]'),actions=composerHomeActions();if(!f)return false;const a=f.getBoundingClientRect(),b=actions[1].getBoundingClientRect();return document.querySelectorAll('[data-attachment-kind]').length===1&&!document.querySelector('[data-attachment-kind=folders]')&&f===f.parentElement.children[0]&&f.tagName==='BUTTON'&&f.querySelector('.composer-menu-label>span').textContent==='添加文件'&&!actions.some(e=>/添加文件夹|选择文件夹/.test(e.textContent))&&a.bottom<=b.top+1&&Math.abs(a.left-b.left)<1&&Math.abs(a.right-b.right)<1;})()");
  await check('actionDescriptionsShareNameBaseline',"composerHomeActions().filter(e=>e.querySelector('small')).length===4&&composerHomeActions().map(e=>e.querySelector('.composer-menu-label')).every(e=>{const n=e.querySelector('span').getBoundingClientRect(),d=e.querySelector('small').getBoundingClientRect();return Math.abs(n.top-d.top)<=4&&d.left>=n.right+3})");
  await check('skillMenuUsesThinRoundedScrollbarsWithoutNativeArrows',"(()=>{const e=document.querySelector('.composer-skill-list'),c=getComputedStyle(e),bar=getComputedStyle(e,'::-webkit-scrollbar'),thumb=getComputedStyle(e,'::-webkit-scrollbar-thumb'),button=getComputedStyle(e,'::-webkit-scrollbar-button');return c.scrollbarWidth==='auto'&&bar.width==='9px'&&parseFloat(thumb.borderRadius)>=6&&button.display==='none'&&button.height==='0px'})()");
  await check('largeSkillCollectionScrollsInsideMenu',"(()=>{const l=document.querySelector('.composer-skill-list');return l.scrollHeight>l.clientHeight&&l.clientHeight>60&&getComputedStyle(l).overflowY!=='visible'})()");
  await check('skillViewportShowsFourWholeRowsAndRequiresScrollForFifth',"(()=>{const l=document.querySelector('.composer-skill-list'),rows=[...l.querySelectorAll('.composer-skill-item')],b=l.getBoundingClientRect();return rows.length===48&&l.scrollTop===0&&rows.slice(0,4).every(e=>{const r=e.getBoundingClientRect();return r.top>=b.top-1&&r.bottom<=b.bottom+1})&&rows[4].getBoundingClientRect().top>=b.bottom-1&&Math.abs(rows[3].getBoundingClientRect().bottom-b.bottom)<=2&&l.scrollHeight>l.clientHeight;})()");
  await capture('plus-1200-light');
  await click('#btnModelSwitch');
  await check('openingModelClosesPlusMenu',"document.querySelector('#modelSettingsPopup.show')&&!document.querySelector('.composer-add-menu')");
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await check('openingPlusClosesModelMenu',"document.querySelector('.composer-add-menu')&&!document.querySelector('#modelSettingsPopup.show')");
  await key('END');
  await check('keyboardLastSkillScrollsIntoView',"(()=>{const e=document.activeElement,l=document.querySelector('.composer-skill-list'),r=e.getBoundingClientRect(),b=l.getBoundingClientRect();return e.matches('.composer-skill-item')&&l.scrollTop>0&&r.top>=b.top-1&&r.bottom<=b.bottom+1})()");
  await click('.composer-skill-search');await input('.composer-skill-search','技能 47');
  await check('skillSearchFiltersInstalledCollection',"Array.from(document.querySelectorAll('.composer-skill-item')).filter(menuVisible).length===1&&document.querySelector('.composer-skills-section').textContent.includes('技能 47')");
  await key('HOME');
  await check('searchHomePreservesInputFocusAndMovesCaret',"document.activeElement.matches('.composer-skill-search')&&document.activeElement.selectionStart===0");
  await key('END');
  await check('searchEndPreservesInputFocusAndMovesCaret',"document.activeElement.matches('.composer-skill-search')&&document.activeElement.selectionStart===document.activeElement.value.length");
  await input('.composer-skill-search','完全不存在的技能');
  await check('unmatchedSkillSearchHasEmptyState',"!Array.from(document.querySelectorAll('.composer-skill-item')).some(menuVisible)&&/没有|未找到/.test(document.querySelector('.composer-skills-section').textContent)");
  await input('.composer-skill-search','技能 01');await click('.composer-skill-item[data-skill-name="fixture-skill-01"]');
  await check('skillFillsOnlyEmptyDraftAndDisplaysCancelableChip',"selectedQuickSkill?.name==='fixture-skill-01'&&inputEl.value===composerMenuFixture.skills[0].defaultPrompt&&menuVisible(document.getElementById('composerSkillChip'))&&!document.querySelector('.composer-add-menu')");
  await click('#skillQuickClear');
  await check('cancelingSelectedSkillKeepsPromptText',"selectedQuickSkill===null&&!menuVisible(document.getElementById('composerSkillChip'))&&inputEl.value===composerMenuFixture.skills[0].defaultPrompt");
  await input('#input','请保留这份我已经写好的草稿。');await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await input('.composer-skill-search','技能 02');await click('.composer-skill-item[data-skill-name="fixture-skill-02"]');
  await check('skillSelectionDoesNotReplaceExistingDraft',"inputEl.value==='请保留这份我已经写好的草稿。'&&selectedQuickSkill?.name==='fixture-skill-02'");
  await click('#btnSend');await waitFor('composerMenuFixture.launches.length===1');
  await check('firstSendConsumesSelectedSkillExactlyOnce',"currentConv.turns.at(-1).skill?.name==='fixture-skill-02'&&composerMenuFixture.launches[0][0].includes('fixture-skill-02')&&selectedQuickSkill===null&&!menuVisible(document.getElementById('composerSkillChip'))");
  await act("composerMenuFixture.finish(composerMenuFixture.launches[0][11]);");await waitFor('!isRunning');
  await input('#input','下一条普通消息。');await click('#btnSend');await waitFor('composerMenuFixture.launches.length===2');
  await check('nextTurnDoesNotReuseConsumedSkill',"!currentConv.turns.at(-1).skill&&!composerMenuFixture.launches[1][0].startsWith('请先调用 Skill')");
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await input('.composer-skill-search','技能 03');await click('.composer-skill-item[data-skill-name="fixture-skill-03"]');
  await click('#btnSend');await waitFor('composerMenuFixture.steers.length===1&&!conversationControls.size');
  await check('skillSupplementContinuesOriginalTaskWithoutPause',"composerMenuFixture.launches.length===2&&composerMenuFixture.pauses.length===0&&composerMenuFixture.steers[0].jobId===composerMenuFixture.launches[1][11]&&composerMenuFixture.steers[0].skill.name==='fixture-skill-03'&&currentConv.turns.length===2&&currentConv.turns[1].supplements[0].skill.name==='fixture-skill-03'&&selectedQuickSkill===null&&isRunning");
  await act("composerMenuFixture.finish(composerMenuFixture.launches[1][11]);");await waitFor('!isRunning');
  await click('#btnNewChat');await input('#input','等待期间保留的草稿');
  await act('composerMenuFixture.holdSkills=true;');await click('#btnAttach');await waitFor('composerMenuFixture.heldSkills.length===1');
  await key('ESCAPE');await act('composerMenuFixture.heldSkills.shift()();');await settle();
  await check('lateSkillListCannotReopenDismissedMenu',"!document.querySelector('.composer-add-menu')&&inputEl.value==='等待期间保留的草稿'&&selectedQuickSkill===null");
  await act('composerMenuFixture.holdSkills=true;');await click('#btnAttach');await waitFor('composerMenuFixture.heldSkills.length===1');await key('ESCAPE');
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');await input('.composer-skill-search','技能 47');
  await act('composerMenuFixture.heldSkills.shift()();');await settle();
  await check('oldListCannotReplaceReopenedMenuSearchOrFocus',"document.querySelector('.composer-skill-search').value==='技能 47'&&document.activeElement===document.querySelector('.composer-skill-search')&&Array.from(document.querySelectorAll('.composer-skill-item')).filter(menuVisible).length===1");
  await key('ESCAPE');await act('composerMenuFixture.holdSkills=true;');await click('#btnAttach');await waitFor('composerMenuFixture.heldSkills.length===1');
  await click('#btnNewChat');await input('#input','另一个新对话的草稿');await act('composerMenuFixture.heldSkills.shift()();');await settle();
  await check('lateSkillListCannotMutateAnotherConversation',"!currentConv&&!document.querySelector('.composer-add-menu')&&inputEl.value==='另一个新对话的草稿'&&selectedQuickSkill===null");
  await act('composerMenuFixture.failSkills=true;');await click('#btnAttach');
  await waitFor('document.querySelector(".composer-skill-list")?.textContent.includes("合成技能加载失败")');
  await check('failedSkillLoadKeepsRetryAndHomeActions',"Array.from(document.querySelectorAll('.composer-skill-list .composer-menu-item')).some(e=>e.textContent.includes('重试'))&&composerHomeActions().length===4");
  await item('重试');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await check('retryRestoresSkillsWithoutChangingDraft',"document.querySelectorAll('.composer-skill-item').length===48&&inputEl.value==='另一个新对话的草稿'&&selectedQuickSkill===null");
  await key('ESCAPE');await act('composerMenuFixture.emptySkills=true;');await click('#btnAttach');
  await waitFor('document.querySelector(".composer-skill-list")?.textContent.includes("还没有可用技能")');
  await check('emptySkillCollectionExplainsWhereToAddSkills',"document.querySelector('.composer-skill-list').textContent.includes('插件')&&!document.querySelector('.composer-skill-item')&&composerHomeActions().length===4");
  await key('ESCAPE');await act('composerMenuFixture.emptySkills=false;');
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');await input('.composer-skill-search','技能 47');
  await act("window.projectPageMenu=document.querySelector('.composer-add-menu');window.projectPageHome=document.querySelector('.composer-add-home');window.projectPageSkillSearch=document.querySelector('.composer-skill-search');window.projectPageHeight=projectPageMenu.getBoundingClientRect().height;");
  await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');
  await check('projectSubpageReusesOriginalPlusPanel',"document.querySelector('.composer-add-menu')===projectPageMenu&&projectPageMenu.dataset.variant==='composer-add'&&projectPageMenu.dataset.page==='projects'&&Math.abs(projectPageMenu.getBoundingClientRect().height-projectPageHeight)<1&&projectPageHome.hidden&&menuVisible(projectPageMenu.querySelector('.composer-menu-back'))&&document.activeElement===projectPageMenu.querySelector('.project-search')");
  await menuGeometry('projectSubpageMatchesInputCardAt1200');
  await act("window.inlineFixedRects={search:document.querySelector('.project-search').getBoundingClientRect().toJSON(),footer:document.querySelector('.project-picker-footer').getBoundingClientRect().toJSON()};document.querySelector('.project-picker-list').scrollTop=100000;");await settle();
  await check('inlineProjectSearchAndFooterStayFixedWhileListScrolls',"(()=>{const l=document.querySelector('.project-picker-list'),s=document.querySelector('.project-search').getBoundingClientRect(),f=document.querySelector('.project-picker-footer').getBoundingClientRect(),buttons=[...document.querySelectorAll('.project-picker-footer button')];return l.scrollTop>0&&buttons.length===2&&Math.abs(s.top-inlineFixedRects.search.top)<1&&Math.abs(f.top-inlineFixedRects.footer.top)<1&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.top>=36&&r.bottom<=innerHeight-7&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})})()");
  await input('.project-search','项目 47');
  await check('projectSubpageFiltersWithoutLosingFixedActions',"Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).filter(menuVisible).length===1&&document.querySelectorAll('.project-picker-footer button').length===2&&[...document.querySelectorAll('.project-picker-footer button')].every(menuVisible)");
  await click('.composer-menu-back');
  await check('backRestoresOriginalHomeSearchAndProjectActionFocus',"document.querySelector('.composer-add-menu')===projectPageMenu&&projectPageMenu.dataset.page==='home'&&!projectPageHome.hidden&&document.querySelector('.composer-skill-search')===projectPageSkillSearch&&projectPageSkillSearch.value==='技能 47'&&Math.abs(projectPageMenu.getBoundingClientRect().height-projectPageHeight)<1&&document.activeElement.querySelector('.composer-menu-label>span')?.textContent==='在项目中工作'&&inputEl.value==='另一个新对话的草稿'");
  await act('composerMenuFixture.holdProjects=true;');await item('在项目中工作');await waitFor('composerMenuFixture.heldProjects.length===1');
  await click('.composer-menu-back');await act('composerMenuFixture.heldProjects.shift()();');await settle();
  await check('lateProjectListCannotReplaceReturnedHome',"document.querySelector('.composer-add-menu')===projectPageMenu&&projectPageMenu.dataset.page==='home'&&!document.querySelector('.project-search')&&projectPageSkillSearch.value==='技能 47'&&inputEl.value==='另一个新对话的草稿'");
  await act('composerMenuFixture.holdProjects=true;');await item('在项目中工作');await waitFor('composerMenuFixture.heldProjects.length===1');await click('.composer-menu-back');
  await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await input('.project-search','项目 47');
  await act('composerMenuFixture.heldProjects.shift()();');await settle();
  await check('oldProjectLoadCannotOverwriteReenteredPageSearchOrFocus',"document.querySelector('.composer-add-menu')===projectPageMenu&&projectPageMenu.dataset.page==='projects'&&document.querySelector('.project-search').value==='项目 47'&&document.activeElement===document.querySelector('.project-search')&&Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).filter(menuVisible).length===1");
  await click('.composer-menu-back');await act('composerMenuFixture.holdProjects=true;');await item('在项目中工作');await waitFor('composerMenuFixture.heldProjects.length===1');await key('ESCAPE');await act('composerMenuFixture.heldProjects.shift()();');await settle();
  await check('lateProjectSubpageCannotReopenAfterEscape',"!document.querySelector('.composer-add-menu')&&document.activeElement===document.getElementById('btnAttach')&&inputEl.value==='另一个新对话的草稿'");
  await click('#btnProjectContext');await waitFor('document.querySelector(".project-picker-list")');
  await check('projectPickerKeepsSingleLineNamesAndNoVisiblePaths',"document.querySelectorAll('.project-picker-list .composer-menu-item').length===64&&Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).every(e=>!e.querySelector('small')&&e.title.includes('Synthetic')&&getComputedStyle(e.querySelector('.composer-menu-label>span')).whiteSpace==='nowrap')");
  await check('projectPickerUsesSameThinRoundedScrollbars',"(()=>{const e=document.querySelector('.project-picker-list');return getComputedStyle(e).scrollbarWidth==='auto'&&getComputedStyle(e,'::-webkit-scrollbar').width==='9px'&&parseFloat(getComputedStyle(e,'::-webkit-scrollbar-thumb').borderRadius)>=6&&getComputedStyle(e,'::-webkit-scrollbar-button').display==='none'})()");
  await check('projectPickerShowsFiveWholeRowsAndScrollsToTheSixth',"(()=>{const menu=document.querySelector('.composer-add-menu'),list=menu.querySelector('.project-picker-list'),rows=[...list.querySelectorAll('.composer-menu-item')],bounds=list.getBoundingClientRect();return menu.offsetWidth===280&&menu.offsetHeight<=288&&getComputedStyle(menu.querySelector('.project-picker-search')).borderBottomWidth==='0px'&&rows.length===64&&list.scrollTop===0&&rows.slice(0,5).every(row=>{const r=row.getBoundingClientRect();return r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1})&&Math.abs(rows[4].getBoundingClientRect().bottom-bounds.bottom)<=1&&rows[5].getBoundingClientRect().top>=bounds.bottom-1&&list.scrollHeight>list.clientHeight;})()");
  await check('manyProjectsHaveBoundedScrollableList',"(()=>{const l=document.querySelector('.project-picker-list'),m=document.querySelector('.composer-add-menu');return l.scrollHeight>l.clientHeight&&l.clientHeight>60&&m.scrollHeight<=m.clientHeight+1})()");
  await check('everyProjectRemainsReachableThroughFiveRowViewport',"(()=>{const list=document.querySelector('.project-picker-list'),rows=[...list.querySelectorAll('.composer-menu-item')];const reachable=rows.every(row=>{row.scrollIntoView({block:'nearest'});const r=row.getBoundingClientRect(),bounds=list.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.height>0&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1&&hit&&row.contains(hit);});list.scrollTop=0;return rows.length===64&&reachable&&document.scrollingElement.scrollTop===0;})()");
  await act("window.fixedProjectRects={search:document.querySelector('.project-search').getBoundingClientRect().toJSON(),footer:document.querySelector('.project-picker-footer').getBoundingClientRect().toJSON()};document.querySelector('.project-picker-list').scrollTop=100000;");await settle();
  await check('projectSearchAndFooterStayFixedWhileListScrolls',"(()=>{const s=document.querySelector('.project-search').getBoundingClientRect(),f=document.querySelector('.project-picker-footer').getBoundingClientRect(),buttons=[...document.querySelectorAll('.project-picker-footer button')];return buttons.length===2&&Math.abs(s.top-fixedProjectRects.search.top)<1&&Math.abs(f.top-fixedProjectRects.footer.top)<1&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.top>=36&&r.bottom<=innerHeight-7&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})})()");
  await capture('projects-1200-light');
  await click('.project-search');await input('.project-search','项目 47');
  await check('projectSearchFiltersNamesWithFooterIntact',"Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).filter(menuVisible).length===1&&document.querySelector('.project-picker-footer').textContent.includes('新建项目')&&document.querySelector('.project-picker-footer').textContent.includes('不在项目中工作')");
  await input('.project-search','不可能存在的项目');
  await check('projectNoMatchRetainsCreationAndExitActions',"!Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).some(menuVisible)&&/没有|未找到/.test(document.querySelector('.project-picker-list').textContent)&&document.querySelectorAll('.project-picker-footer button').length===2&&Array.from(document.querySelectorAll('.project-picker-footer button')).every(menuVisible)");
  await input('.project-search','');await key('DOWN');await key('END');await key('UP');await key('UP');
  await check('projectKeyboardNavigationRevealsLastRow',"(()=>{const e=document.activeElement,l=document.querySelector('.project-picker-list'),r=e.getBoundingClientRect(),b=l.getBoundingClientRect();return l.contains(e)&&l.scrollTop>0&&r.top>=b.top-1&&r.bottom<=b.bottom+1})()");
  await act("window.sixthProjectSelection={id:document.querySelectorAll('.project-picker-list .composer-menu-item')[5].dataset.projectId,draft:inputEl.value};");
  await clickNode("document.querySelectorAll('.project-picker-list .composer-menu-item')[5]");
  await check('sixthProjectScrollsIntoViewAndAcceptsActualPointerSelection',"currentProjectId===sixthProjectSelection.id&&inputEl.value===sixthProjectSelection.draft&&!document.querySelector('.composer-add-menu')");
  await click('#btnAttach');await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await input('.project-search','项目 01');
  await clickNode("Array.from(document.querySelectorAll('.project-picker-list .composer-menu-item')).find(menuVisible)");
  await check('selectedProjectCanBeExitedFromFixedFooter',"currentProjectId===composerMenuFixture.projects[0].id");
  await click('#btnAttach');await item('添加文件');
  await check('systemAttachmentDialogStartsInSelectedProject',"composerMenuFixture.attachmentOptions.at(-1).kind==='files'&&composerMenuFixture.attachmentOptions.at(-1).defaultPath===composerMenuFixture.projects[0].path&&currentProjectId===composerMenuFixture.projects[0].id&&attachedFiles.length===0&&!document.querySelector('.composer-add-menu')");
  await click('#btnProjectContext');await item('不在项目中工作');
  await check('exitProjectKeepsUnsentDraft',"currentProjectId===null&&inputEl.value==='另一个新对话的草稿'");
  await drag('#sidebarResizeHandle',110);await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await menuGeometry('plusFollowsWiderLeftSidebar');await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await menuGeometry('projectSubpageFollowsWiderLeftSidebar');await key('ESCAPE');
  await act("relayWorkspacePanel.open('tasks');");await settle();await drag('#workspaceResizeHandle',-60);await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await menuGeometry('plusFitsBetweenBothSidebars');await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await menuGeometry('projectSubpageFitsBetweenBothSidebars');await key('ESCAPE');await act('relayWorkspacePanel.close();relaySidebarLayout.reset();');
  win.setSize(900,600);await settle();await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await menuGeometry('plusMatchesInputAt900x600');await hoverScrollbar('.composer-skill-list');await capture('plus-900-light');
  await check('singleFileActionRemainsReachableAt900',"(()=>{const e=document.querySelector('[data-attachment-kind=files]'),r=e.getBoundingClientRect(),m=document.querySelector('.composer-add-menu').getBoundingClientRect();return document.querySelectorAll('[data-attachment-kind]').length===1&&r.left>=m.left&&r.right<=m.right&&r.top>=m.top&&r.bottom<=m.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()");
  await act('window.attachmentCallsBeforeCancel=composerMenuFixture.attachmentOptions.length;');await item('添加文件');
  await check('directActionCallsSystemAttachmentDialogWithoutRendererPicker',"composerMenuFixture.attachmentOptions.length===attachmentCallsBeforeCancel+1&&composerMenuFixture.attachmentOptions.at(-1).kind==='files'&&!composerMenuFixture.attachmentOptions.at(-1).defaultPath&&!document.querySelector('.composer-add-menu,.attachment-picker-overlay')&&attachedFiles.length===0");
  await check('cancelingSystemPickerKeepsUnsentDraft',"inputEl.value==='另一个新对话的草稿'&&currentProjectId===null&&attachedFiles.length===0");
  await act("composerMenuFixture.holdAttachment=true;composerMenuFixture.attachmentResults.push([{path:'D:/Synthetic/late.md',name:'late.md',ext:'md',size:12,isDirectory:false}]);window.lateDialogCallsBefore=composerMenuFixture.attachmentOptions.length;");
  await click('#btnAttach');await click('[data-attachment-kind=files]');await waitFor('composerMenuFixture.heldAttachments.length===1');await click('#btnNewChat');await input('#input','新草稿不接收旧附件');
  await act('composerMenuFixture.heldAttachments.shift()();');await settle();
  await check('lateSystemFileSelectionCannotPolluteAnotherDraft',"currentConv===null&&inputEl.value==='新草稿不接收旧附件'&&attachedFiles.length===0&&!document.querySelector('.composer-add-menu,.attachment-picker-overlay')&&selectedQuickSkill===null&&composerMenuFixture.attachmentOptions.length===lateDialogCallsBefore+1&&composerMenuFixture.attachmentOptions.at(-1).kind==='files'");
  await input('#input','另一个新对话的草稿');
  await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');
  await menuGeometry('projectSubpageMatchesInputAt900x600');await capture('project-subpage-900-light');await click('.composer-menu-back');await waitFor('document.querySelector(".composer-skills-section")');
  await key('ESCAPE');await click('#btnProjectContext');await menuGeometry('projectPickerStaysInside900x600',false);await capture('projects-900-light');
  await key('ESCAPE');await act("document.documentElement.dataset.theme='dark';");await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await menuGeometry('darkPlusKeepsSameBounds');await capture('plus-900-dark');await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await menuGeometry('darkProjectSubpageKeepsSameBounds');await capture('project-subpage-900-dark');
  await key('ESCAPE');await click('#btnProjectContext');await menuGeometry('darkProjectsStayInside900x600',false);await hoverScrollbar('.project-picker-list');await capture('projects-900-dark');
  await key('ESCAPE');await input('#input',Array.from({length:18},(_,i)=>'较长草稿的第 '+(i+1)+' 行，用于检查输入框变高后的菜单上边缘。').join('\n'));await click('#btnAttach');await waitFor('document.querySelectorAll(".composer-skill-item").length===48');
  await menuGeometry('tallDraftKeepsMenuBelowTitlebarAndAboveInput');await capture('plus-tall-draft-900-dark');await item('在项目中工作');await waitFor('document.querySelectorAll(".project-picker-list .composer-menu-item").length===64');await menuGeometry('tallDraftKeepsProjectSubpageWithinSamePanel');await capture('project-subpage-tall-draft-900-dark');
  await key('DOWN');await key('END');
  await check('shortProjectPageScrollsExitActionIntoReach',"(()=>{const e=document.activeElement,m=document.querySelector('.composer-add-menu').getBoundingClientRect(),r=e.getBoundingClientRect();return e.closest('.project-picker-footer')&&e.textContent.includes('不在项目中工作')&&r.top>=m.top&&r.bottom<=m.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()");
  await key('UP');
  await check('shortProjectPageScrollsCreateActionIntoReach',"(()=>{const e=document.activeElement,m=document.querySelector('.composer-add-menu').getBoundingClientRect(),r=e.getBoundingClientRect();return e.closest('.project-picker-footer')&&e.textContent.includes('新建项目')&&r.top>=m.top&&r.bottom<=m.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()");
  await key('UP');
  await check('shortProjectPageScrollsLastProjectIntoReach',"(()=>{const e=document.activeElement,m=document.querySelector('.composer-add-menu').getBoundingClientRect(),r=e.getBoundingClientRect();return e.closest('.project-picker-list')&&e.dataset.projectId===composerMenuFixture.projects[63].id&&r.top>=m.top&&r.bottom<=m.bottom&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()");
  await capture('project-subpage-tall-draft-last-row');await clickNode('document.activeElement');
  await check('shortProjectPageSelectionPreservesTallDraft',"currentProjectId===composerMenuFixture.projects[63].id&&inputEl.value.split('\\n').length===18&&!document.querySelector('.composer-add-menu')");
  await check('longDraftAndMenuKeepWindowChromeAtViewportTop',"document.scrollingElement.scrollTop===0&&document.getElementById('windowChrome').getBoundingClientRect().top===0");
  await check('rendererHasNoErrors',"uiFixture.errors.length===0");
  save();console.log(JSON.stringify({passed:Object.values(checks).filter(Boolean).length,errors}));clearTimeout(timeout);app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));try{await capture('failure')}catch{}save();console.error(error);clearTimeout(timeout);app.exit(1)});
