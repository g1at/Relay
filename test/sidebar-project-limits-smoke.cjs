'use strict';
// Production renderer, isolated profile and in-memory history/projects. No real
// Relay main, SDK, filesystem content or user history is loaded by this fixture.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.codex-tmp','sidebar-project-limits-smoke');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));app.commandLine.appendSwitch('disable-gpu');
let win,step='starting';const checks={},errors=[],geometry={};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({step,checks,geometry,errors},null,2));
const timeout=setTimeout(()=>{errors.push('Timeout: '+step);save();app.exit(1)},120000);
const evaluate=async code=>{
  const response=await win.webContents.executeJavaScript(`Promise.resolve().then(()=>eval(${JSON.stringify(code)})).then(value=>({ok:true,value}),error=>({ok:false,error:String(error&&error.stack||error)}))`);
  if(!response.ok)throw Error(response.error);return response.value;
};
const act=code=>evaluate(`(()=>{${code}\n})()`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function settle(){await delay(100);await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch{}});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");}
async function waitFor(code){await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+6500;const tick=()=>{if(${code})return resolve();if(Date.now()>until)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`);}
async function check(name,code){step=name;checks[name]=!!await evaluate(code);save();console.log(name+': '+checks[name]);if(!checks[name])throw Error(name);}
async function clickNode(code){
  const point=await evaluate(`(()=>{const e=${code};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});await settle();
  await evaluate(`(()=>{const e=${code},hit=document.elementFromPoint(${point.x},${point.y});if(!e.getClientRects().length||!e.contains(hit))throw Error('Clipped or hidden click target: '+(e.id||e.textContent))})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await settle();
}
async function pin(idCode){
  const point=await evaluate(`(()=>{const e=limitRow(${idCode});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});await settle();await clickNode(`limitRow(${idCode}).querySelector('.hi-pin')`);
}
const click=selector=>clickNode(`document.querySelector(${JSON.stringify(selector)})`);
async function key(keyCode){win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await settle();}
async function setSidebarWidth(width){
  const point=await evaluate("(()=>{const r=document.getElementById('sidebarResizeHandle').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(160,r.height/2)),width:relaySidebarLayout.getState().width}})()");
  const delta=width-point.width;
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
  for(let i=1;i<=8;i++){win.webContents.sendInputEvent({type:'mouseMove',x:point.x+Math.round(delta*i/8),y:point.y,modifiers:['leftButtonDown']});await delay(20);}
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x+delta,y:point.y,button:'left',clickCount:1});await settle();
}
async function capture(name){await settle();fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
const seed=String.raw`(()=>{
  localStorage.clear();const base=window.api,clone=value=>JSON.parse(JSON.stringify(value));
  const projects=Array.from({length:11},(_,i)=>({id:'aaaaaaaa-2222-4222-8222-'+String(i+1).padStart(12,'0'),name:'项目 '+String(i+1).padStart(2,'0')+' · 本地资料与研究',path:'D:\\Synthetic\\Project-'+(i+1)}));
  const records=new Map();let n=0;
  const make=(projectId,index,pinned=false)=>{const id='bbbbbbbb-3333-4333-8333-'+String(++n).padStart(12,'0'),ts=new Date(Date.UTC(2026,8,1,8,index)).toISOString();return{id,projectId,title:(projectId?'项目会话 ':'普通会话 ')+String(index+1).padStart(2,'0')+' · 保留完整标题与历史记录',pinned,model:'opus',mode:'plain',sessionId:null,createdAt:ts,updatedAt:ts,turns:[{user:'整理这份本地资料',assistant:'已有整理结果。',ts}]};};
  const members=projects.map((project,p)=>Array.from({length:8},(_,i)=>{const record=make(project.id,i,p===0&&(i===0||i===2)||p===1&&i===0);Object.assign(record,[{kind:'chat',mode:'plain'},{kind:'create'},{mode:'agent',agent:'fixture-agent'},{mode:'orchestrate',orchestrateAgents:['fixture-agent','fixture-reviewer']},{fromScheduled:true,kind:'create',mode:'orchestrate'}][i%5]);records.set(record.id,record);return record.id;}));
  const globalPins=Array.from({length:2},(_,i)=>{const record=make(null,i,true);record.title='全局置顶 '+(i+1);records.set(record.id,record);return record.id;});
  const recents=Array.from({length:3},(_,i)=>{const record=make(null,i+3);records.set(record.id,record);return record.id;});
  Object.assign(records.get(globalPins[1]),{kind:'create'});Object.assign(records.get(recents[1]),{mode:'agent'});Object.assign(records.get(recents[2]),{fromScheduled:true,mode:'agent'});
  const state=window.sidebarLimitFixture={projects,records,members,globalPins,recents,writes:[],pinWrites:[],initialTimes:[...records].map(([id,c])=>[id,c.updatedAt]),
    timesMatch(){return this.initialTimes.every(([id,ts])=>records.get(id).updatedAt===ts);},
  };
  window.api=new Proxy(base,{get(target,key){
    if(key==='projects')return{list:async()=>({ok:true,projects:clone(projects),workspace:'D:\\Synthetic\\Relay'})};
    if(key==='history')return new Proxy(target.history,{get(original,method){
      if(method==='list')return async()=>clone([...records.values()]);
      if(method==='load')return async id=>clone(records.get(id)||null);
      if(method==='save')return async conv=>{state.writes.push(clone(conv));records.set(conv.id,clone(conv));return clone(conv);};
      if(method==='setPinned')return async(id,pinned)=>{state.pinWrites.push({id,pinned});records.get(id).pinned=pinned;return{ok:true};};
      return original[method];
    }});
    return target[key];
  }});
  window.limitZone=name=>document.querySelector('.history-zone[data-history-zone="'+name+'"]');
  window.limitProject=index=>document.querySelector('.history-project[data-project-id="'+projects[index].id+'"]');
  window.limitRow=id=>document.querySelector('.history-item[data-id="'+id+'"]');
  window.limitProjectMore=index=>limitProject(index).querySelector('.history-show-more');
  window.limitProjectsMore=()=>[...limitZone('projects').querySelectorAll('.history-show-more')].find(e=>!e.closest('.history-project'));
  window.limitVisible=e=>!!e&&e.getClientRects().length>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).display!=='none';
  window.limitRowsVisible=index=>[...limitProject(index).querySelectorAll('.history-item')].filter(e=>!e.hidden).length;
  window.limitNormalProjectsVisible=()=>[...limitZone('projects').querySelectorAll('.history-project')].filter(e=>!e.hidden).length;
})();`;
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const fixture=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+seed+'</script>');
  const page=path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win=new BrowserWindow({width:1200,height:840,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);win.focus();win.webContents.focus();
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&document.querySelectorAll(".history-item").length===93&&limitZone("projects")');
  await act("sidebarLimitFixture.originalRows=new Map([...document.querySelectorAll('.history-item')].map(e=>[e.dataset.id,e]));sidebarLimitFixture.originalProjects=sidebarLimitFixture.projects.map((p,i)=>limitProject(i));sidebarLimitFixture.originalIcons=new Map([...document.querySelectorAll('.history-item')].map(e=>[e.dataset.id,e.querySelector(':scope>.hi-icon')]));");
  await check('zonesPlaceGlobalPinsBeforePinnedProjectsAndNormalProjects',"[...historyEl.querySelectorAll(':scope>.history-zone')].map(e=>e.dataset.historyZone).join(',')==='pinned,projects,recents'&&!!(limitZone('pinned').querySelector('[data-history-group=pinned]').compareDocumentPosition(limitZone('pinned').querySelector('.history-project-list'))&Node.DOCUMENT_POSITION_FOLLOWING)");
  await check('globalPinsStayOutsideProjectGroups',"limitZone('pinned').querySelectorAll('[data-history-group=pinned] .history-item').length===2&&sidebarLimitFixture.globalPins.every(id=>limitRow(id).closest('[data-history-group]').dataset.historyGroup==='pinned')");
  await check('onePinnedConversationMovesItsWholeProjectExactlyOnce',"limitZone('pinned').querySelectorAll('.history-project').length===2&&[0,1].every(i=>limitProject(i).closest('.history-zone')===limitZone('pinned')&&limitProject(i).querySelectorAll('.history-item').length===8)&&document.querySelectorAll('.history-project').length===11");
  await check('normalProjectsShowFiveWhileKeepingAllNineInDom',"limitZone('projects').querySelectorAll('.history-project').length===9&&limitNormalProjectsVisible()===5&&limitProjectsMore().getAttribute('aria-expanded')==='false'&&limitProjectsMore().dataset.expandKey==='projects'");
  await check('eachProjectShowsFiveWhileKeepingAllEightConversations',"sidebarLimitFixture.projects.every((p,i)=>limitRowsVisible(i)===5&&limitProject(i).querySelectorAll('.history-item').length===8&&limitProjectMore(i).dataset.expandKey==='project-'+p.id)");
  await check('initialViewNeitherDuplicatesNorDropsHistory',"document.querySelectorAll('.history-item').length===93&&new Set([...document.querySelectorAll('.history-item')].map(e=>e.dataset.id)).size===93&&[...sidebarLimitFixture.records.keys()].every(id=>limitRow(id))&&sidebarLimitFixture.writes.length===0&&sidebarLimitFixture.pinWrites.length===0&&sidebarLimitFixture.timesMatch()");
  await settle();geometry.initialIcons=await evaluate("sidebarLimitFixture.members[0].slice(0,5).map(id=>{const e=limitRow(id).querySelector(':scope>.hi-icon'),r=e.getBoundingClientRect();return{id,type:e.dataset.historyType,width:r.width,height:r.height,display:getComputedStyle(e).display,hidden:!!e.closest('[hidden]'),body:e.innerHTML}})");
  await check('fiveConversationKindsHaveDistinctVisibleIcons',"(()=>{const icons=sidebarLimitFixture.members[0].slice(0,5).map(id=>limitRow(id).querySelector(':scope>.hi-icon'));return icons.length===5&&icons.every(e=>e&&e.getBoundingClientRect().width===16&&e.getBoundingClientRect().height===16&&getComputedStyle(e).display!=='none')&&new Set(icons.map(e=>e.innerHTML)).size===5})()");
  await check('scheduledOriginTakesPriorityOverImageAndAgentModes',"(()=>{const clock=limitRow(sidebarLimitFixture.members[0][4]).querySelector(':scope>.hi-icon'),other=limitRow(sidebarLimitFixture.recents[2]).querySelector(':scope>.hi-icon');return clock.innerHTML===other.innerHTML&&clock.querySelector('circle')?.getAttribute('r')==='9'&&clock.querySelector('path').getAttribute('d')==='M12 7v5l3 2'})()");
  await check('projectAndPinnedRowsEachContainOnlyOneTypeIcon',"[...document.querySelectorAll('.history-item')].every(row=>row.querySelectorAll(':scope>.hi-icon').length===1&&getComputedStyle(row.querySelector(':scope>.hi-icon')).display!=='none')&&sidebarLimitFixture.globalPins.every(id=>limitRow(id).querySelector(':scope>.hi-icon').getBoundingClientRect().width===16)");
  await check('expandButtonsShowDotsRemainingCountAndChevron',"[limitProjectsMore(),limitProjectMore(0)].every(button=>button.querySelectorAll('.history-more-icon circle').length===3&&button.querySelector('.history-more-label').textContent==='展开显示'&&button.querySelector('.history-more-chevron')&&!button.querySelector('.history-more-count').hidden)&&limitProjectsMore().querySelector('.history-more-count').textContent==='+4'&&limitProjectMore(0).querySelector('.history-more-count').textContent==='+3'");
  await act("sidebarLimitFixture.originalChevron=getComputedStyle(limitProjectsMore().querySelector('.history-more-chevron')).transform;");
  await capture('default-light');
  await clickNode('limitProjectsMore()');
  await check('ordinaryProjectExpansionShowsEveryProject',"limitNormalProjectsVisible()===9&&limitProjectsMore().getAttribute('aria-expanded')==='true'&&limitProjectsMore().textContent.includes('收起')");
  await check('expandedButtonHidesRemainderAndReversesChevron',"limitProjectsMore().querySelector('.history-more-label').textContent==='收起显示'&&limitProjectsMore().querySelector('.history-more-count').hidden&&getComputedStyle(limitProjectsMore().querySelector('.history-more-chevron')).transform!==sidebarLimitFixture.originalChevron");
  await key('Enter');
  await check('keyboardCollapsesProjectListAndRetainsFocus',"limitNormalProjectsVisible()===5&&limitProjectsMore().getAttribute('aria-expanded')==='false'&&document.activeElement===limitProjectsMore()");
  await key('Enter');
  await check('keyboardReopensProjectList',"limitNormalProjectsVisible()===9&&limitProjectsMore().getAttribute('aria-expanded')==='true'");
  await clickNode('limitProjectMore(0)');
  await check('projectConversationExpansionIsIndependent',"limitRowsVisible(0)===8&&limitRowsVisible(1)===5&&limitRowsVisible(2)===5&&limitProjectMore(0).getAttribute('aria-expanded')==='true'");
  await evaluate('refreshHistoryList()');await settle();
  await check('refreshKeepsExpansionAndEveryOriginalNode',"limitRowsVisible(0)===8&&limitNormalProjectsVisible()===9&&[...sidebarLimitFixture.originalRows].every(([id,row])=>limitRow(id)===row)&&sidebarLimitFixture.originalProjects.every((node,i)=>limitProject(i)===node)&&sidebarLimitFixture.writes.length===0&&sidebarLimitFixture.timesMatch()");
  await check('unchangedHistoryRefreshReusesEachTypeIcon',"[...sidebarLimitFixture.originalIcons].every(([id,icon])=>limitRow(id).querySelector(':scope>.hi-icon')===icon)&&[...document.querySelectorAll('.history-item')].every(row=>row.querySelectorAll(':scope>.hi-icon').length===1)");
  await act("sidebarLimitFixture.changedId=sidebarLimitFixture.members[3][7];sidebarLimitFixture.records.get(sidebarLimitFixture.changedId).mode='plain';sidebarLimitFixture.records.get(sidebarLimitFixture.changedId).kind='create';");await evaluate('refreshHistoryList()');await settle();
  await check('changedConversationTypeUpdatesIconWithoutReplacingRow',"limitRow(sidebarLimitFixture.changedId)===sidebarLimitFixture.originalRows.get(sidebarLimitFixture.changedId)&&limitRow(sidebarLimitFixture.changedId).querySelector(':scope>.hi-icon').innerHTML===limitRow(sidebarLimitFixture.globalPins[1]).querySelector(':scope>.hi-icon').innerHTML&&limitRow(sidebarLimitFixture.changedId).querySelectorAll(':scope>.hi-icon').length===1");
  await act("sidebarLimitFixture.records.get(sidebarLimitFixture.changedId).fromScheduled=true;");await evaluate('refreshHistoryList()');await settle();
  await check('scheduledTypeUpgradeReplacesImageIconWithClock',"limitRow(sidebarLimitFixture.changedId).querySelector(':scope>.hi-icon').innerHTML===limitRow(sidebarLimitFixture.recents[2]).querySelector(':scope>.hi-icon').innerHTML&&limitRow(sidebarLimitFixture.changedId).querySelectorAll(':scope>.hi-icon').length===1&&sidebarLimitFixture.timesMatch()&&sidebarLimitFixture.writes.length===0");
  await clickNode("limitRow(sidebarLimitFixture.recents[0]).querySelector('.hi-title')");await waitFor('currentConv?.id===sidebarLimitFixture.recents[0]');
  await check('switchingConversationKeepsIndependentExpandedLists',"limitRowsVisible(0)===8&&limitRowsVisible(1)===5&&limitNormalProjectsVisible()===9&&sidebarLimitFixture.writes.length===0");
  await clickNode('limitProjectMore(0)');
  await check('projectConversationCollapseReturnsToFive',"limitRowsVisible(0)===5&&limitProjectMore(0).getAttribute('aria-expanded')==='false'");
  await clickNode('limitProjectMore(2)');
  await clickNode("limitProject(2).querySelector('.project-chevron')");
  await check('collapsingProjectHeaderHidesItsConversationBody',"limitProject(2).querySelector('.history-group-items').hidden&&limitProject(2).querySelector('.project-chevron').getAttribute('aria-expanded')==='false'&&limitProject(2).querySelector('.project-name > svg').dataset.folderState==='closed'");
  await clickNode("limitProject(2).querySelector('.project-chevron')");
  await check('reopeningProjectHeaderKeepsExpandedConversationLimit',"!limitProject(2).querySelector('.history-group-items').hidden&&limitProject(2).querySelector('.project-name > svg').dataset.folderState==='open'&&limitRowsVisible(2)===8&&limitProjectMore(2).getAttribute('aria-expanded')==='true'");
  await act("sidebarLimitFixture.liveId=sidebarLimitFixture.members[2][0];sidebarLimitFixture.run={jobId:'synthetic-sidebar-running-job'};runs.set(sidebarLimitFixture.liveId,sidebarLimitFixture.run);");await evaluate('refreshHistoryList()');await settle();
  await act("sidebarLimitFixture.spinner=limitRow(sidebarLimitFixture.liveId).querySelector('.hi-spinner');");
  await check('existingRunningIndicatorIsVisibleBeforeMove',"!!sidebarLimitFixture.spinner&&limitRow(sidebarLimitFixture.liveId).classList.contains('running')");
  await pin('sidebarLimitFixture.members[2][0]');
  await check('pinPromotesTheWholeProjectWithoutDuplicatingRows',"limitProject(2).closest('.history-zone')===limitZone('pinned')&&limitZone('pinned').querySelectorAll('.history-project').length===3&&limitZone('projects').querySelectorAll('.history-project').length===8&&limitProject(2).querySelectorAll('.history-item').length===8&&document.querySelectorAll('.history-item').length===93");
  await check('projectMoveKeepsExpandedStateAndRunningDom',"limitRowsVisible(2)===8&&limitProject(2)===sidebarLimitFixture.originalProjects[2]&&limitRow(sidebarLimitFixture.liveId)===sidebarLimitFixture.originalRows.get(sidebarLimitFixture.liveId)&&limitRow(sidebarLimitFixture.liveId).querySelector('.hi-spinner')===sidebarLimitFixture.spinner&&runs.get(sidebarLimitFixture.liveId)===sidebarLimitFixture.run");
  await pin('sidebarLimitFixture.members[2][1]');
  await check('secondPinDoesNotCreateASecondProjectGroup',"limitZone('pinned').querySelectorAll('.history-project').length===3&&document.querySelectorAll('.history-project[data-project-id=\"'+sidebarLimitFixture.projects[2].id+'\"]').length===1");
  await pin('sidebarLimitFixture.members[2][0]');
  await check('projectStaysPinnedUntilItsLastPinIsRemoved',"limitProject(2).closest('.history-zone')===limitZone('pinned')&&!sidebarLimitFixture.records.get(sidebarLimitFixture.members[2][0]).pinned&&sidebarLimitFixture.records.get(sidebarLimitFixture.members[2][1]).pinned");
  await pin('sidebarLimitFixture.members[2][1]');
  await check('removingLastPinReturnsSameProjectToOrdinaryZone',"limitProject(2).closest('.history-zone')===limitZone('projects')&&limitZone('pinned').querySelectorAll('.history-project').length===2&&limitRowsVisible(2)===8&&limitNormalProjectsVisible()===9&&limitProject(2)===sidebarLimitFixture.originalProjects[2]");
  await check('pinChangesWriteOnlyPinMetadataAndKeepActivityTimes',"sidebarLimitFixture.pinWrites.length===4&&sidebarLimitFixture.writes.length===0&&sidebarLimitFixture.timesMatch()&&sidebarLimitFixture.projects.every(p=>!Object.prototype.hasOwnProperty.call(p,'pinned'))");
  await check('runningIndicatorSurvivesBothZoneTransitions',"limitRow(sidebarLimitFixture.liveId).querySelector('.hi-spinner')===sidebarLimitFixture.spinner&&limitRow(sidebarLimitFixture.liveId).classList.contains('running')&&runs.get(sidebarLimitFixture.liveId)===sidebarLimitFixture.run");
  await act("for(const i of [3,4,5,6])sidebarLimitFixture.records.get(sidebarLimitFixture.members[i][0]).pinned=true;");await evaluate('refreshHistoryList()');await settle();
  await check('pinnedProjectListHasItsOwnFiveItemLimit',"limitZone('pinned').querySelectorAll('.history-project').length===6&&[...limitZone('pinned').querySelectorAll('.history-project')].filter(e=>!e.hidden).length===5&&document.querySelector('.history-show-more[data-expand-key=pinned-projects]').getAttribute('aria-expanded')==='false'&&limitNormalProjectsVisible()===5");
  await click('.history-show-more[data-expand-key="pinned-projects"]');
  await check('pinnedProjectExpansionDoesNotChangeConversationLimits',"[...limitZone('pinned').querySelectorAll('.history-project')].filter(e=>!e.hidden).length===6&&limitRowsVisible(0)===5&&limitRowsVisible(2)===8");
  await key('Enter');
  await check('pinnedProjectCollapseIsKeyboardAccessible',"[...limitZone('pinned').querySelectorAll('.history-project')].filter(e=>!e.hidden).length===5&&document.activeElement.dataset.expandKey==='pinned-projects'");
  await act("for(const i of [3,4,5,6])sidebarLimitFixture.records.get(sidebarLimitFixture.members[i][0]).pinned=false;");await evaluate('refreshHistoryList()');await settle();
  await check('projectExpansionPreferenceSurvivesTemporaryListShrink',"limitNormalProjectsVisible()===9&&limitProjectsMore().getAttribute('aria-expanded')==='true'&&limitRowsVisible(2)===8");
  await clickNode('limitProjectsMore()');
  await clickNode('limitProjectMore(2)');
  await act("historyEl.parentElement.scrollTop=0;");
  win.setSize(900,600);await settle();
  geometry.light=await evaluate("(()=>{const s=document.getElementById('sidebarNavigation').getBoundingClientRect(),t=document.querySelector('.hi-title'),r=t.closest('.history-item').getBoundingClientRect(),n=document.getElementById('btnNewChat');return{viewport:[innerWidth,innerHeight],sidebar:{left:s.left,width:s.width},rowHeight:r.height,titleFont:parseFloat(getComputedStyle(t).fontSize),navFont:parseFloat(getComputedStyle(n).fontSize),documentWidth:document.documentElement.scrollWidth,chromeTop:document.getElementById('windowChrome').getBoundingClientRect().top}})()");
  await check('sidebarTypographyUsesLargerTextAndCompactRows',"parseFloat(getComputedStyle(document.getElementById('btnNewChat')).fontSize)===14.5&&parseFloat(getComputedStyle(document.querySelector('.hi-title')).fontSize)===13.5&&parseFloat(getComputedStyle(document.querySelector('.project-name')).fontSize)===14&&document.querySelector('.history-item').getBoundingClientRect().height>=28&&document.querySelector('.history-item').getBoundingClientRect().height<=32");
  await check('narrowLightThemeKeepsSingleColumnAndCompleteTitles',"document.documentElement.scrollWidth<=innerWidth&&document.getElementById('windowChrome').getBoundingClientRect().top===0&&[...document.querySelectorAll('.hi-title')].every(e=>e.title===e.textContent&&e.getAttribute('aria-label')===e.textContent&&getComputedStyle(e).whiteSpace==='nowrap')");
  await capture('sidebar-900-light');
  await act("document.documentElement.dataset.theme='dark';");await settle();
  await check('darkThemeKeepsLimitsAndRowIdentity',"limitNormalProjectsVisible()===5&&sidebarLimitFixture.projects.every((p,i)=>limitRowsVisible(i)===5)&&[...sidebarLimitFixture.originalRows].every(([id,row])=>limitRow(id)===row)&&document.documentElement.scrollWidth<=innerWidth");
  await capture('sidebar-900-dark');
  for(const width of [176,224,440]){
    win.setSize(width===440?1200:900,width===440?840:600);await settle();await setSidebarWidth(width);
    for(const theme of ['light','dark']){
      await act(`document.documentElement.dataset.theme='${theme}';limitProjectMore(0).scrollIntoView({block:'nearest'});`);await settle();
      geometry['icons-'+width+'-'+theme]=await evaluate("(()=>{const row=limitRow(sidebarLimitFixture.members[0][0]),icon=row.querySelector(':scope>.hi-icon').getBoundingClientRect(),title=row.querySelector('.hi-title').getBoundingClientRect(),more=limitProjectMore(0).getBoundingClientRect();return{sidebar:relaySidebarLayout.getState().width,iconWidth:icon.width,titleWidth:title.width,rowWidth:row.getBoundingClientRect().width,moreWidth:more.width}})()");
      await check('iconsAndExpandControlsFit'+width+theme,`(()=>{const sidebar=document.getElementById('sidebarNavigation').getBoundingClientRect(),rows=[...document.querySelectorAll('.history-item')].filter(limitVisible),buttons=[limitProjectMore(0),limitProjectsMore()];return Math.abs(sidebar.width-${width})<=1&&rows.length>5&&rows.every(row=>{const icon=row.querySelector(':scope>.hi-icon').getBoundingClientRect(),title=row.querySelector('.hi-title').getBoundingClientRect(),r=row.getBoundingClientRect();return icon.width===16&&icon.height===16&&icon.left>=r.left&&title.left>=icon.right+7&&title.width>0&&title.right<=r.right})&&buttons.every(button=>{const r=button.getBoundingClientRect(),icon=button.querySelector('.history-more-icon').getBoundingClientRect(),label=button.querySelector('.history-more-label'),l=label.getBoundingClientRect(),count=button.querySelector('.history-more-count'),c=count.getBoundingClientRect(),arrow=button.querySelector('.history-more-chevron').getBoundingClientRect();return r.height===31&&icon.width===16&&arrow.width===12&&l.left>=icon.right&&label.scrollWidth<=label.clientWidth&&count.scrollWidth<=count.clientWidth&&c.left>=l.right&&arrow.left>=c.right&&arrow.right<=r.right&&r.left>=sidebar.left&&r.right<=sidebar.right})&&Math.abs(limitProjectMore(0).getBoundingClientRect().left-limitRow(sidebarLimitFixture.members[0][0]).getBoundingClientRect().left)<=1&&Math.abs(limitProjectMore(0).getBoundingClientRect().width-limitRow(sidebarLimitFixture.members[0][0]).getBoundingClientRect().width)<=1&&document.documentElement.scrollWidth<=innerWidth})()`);
      await capture('icons-expand-'+width+'-'+theme);
    }
  }
  await check('finalViewStillContainsEveryHistoryWithoutPresentationWrites',"document.querySelectorAll('.history-item').length===93&&new Set([...document.querySelectorAll('.history-item')].map(e=>e.dataset.id)).size===93&&sidebarLimitFixture.writes.length===0&&sidebarLimitFixture.pinWrites.length===4&&sidebarLimitFixture.timesMatch()&&uiFixture.errors.length===0");
  save();console.log(JSON.stringify({passed:Object.values(checks).filter(Boolean).length,errors}));clearTimeout(timeout);app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));try{await capture('failure')}catch{}save();console.error(error);clearTimeout(timeout);app.exit(1)});
