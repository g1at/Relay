'use strict';
// Full production renderer with isolated synthetic memory. No Relay main process or model calls.
const {app, BrowserWindow, session}=require('electron');
const fs=require('node:fs'), path=require('node:path'), {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'), output=path.join(root,'.codex-tmp/settings-direct-sections-memory');
fs.mkdirSync(output,{recursive:true}); app.setPath('userData',path.join(output,'profile')); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('force-device-scale-factor','1');
let win,step='starting'; const checks={},failures=[],diagnostics={};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({step,checks,failures,diagnostics},null,2));
const timeout=setTimeout(()=>{failures.push('Timeout: '+step);save();app.exit(1);},180000);
const evaluate=code=>win.webContents.executeJavaScript(code), act=code=>evaluate(`(()=>{${code}\n})()`);
async function settle(){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function finish(){await act("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});");await settle();}
async function waitFor(code){await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(next,20)}next()})`);}
async function click(selector){await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`);await settle();}
async function check(name,code){step=name;checks[name]=!!await evaluate(code);save();if(!checks[name])throw Error(name);}
async function capture(name){await finish();fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function pointerClick(selector,{scroll=true}={}){
 if(scroll)await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing pointer target');const host=node.closest('.set-content'),r=node.getBoundingClientRect();if(host){const h=host.getBoundingClientRect();if(r.top<h.top+8||r.bottom>h.bottom-8)host.scrollTop+=r.top-h.top-Math.min(180,h.height/3)}})()`);
 await finish();
 const point=await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(!node.contains(hit))throw Error('Pointer target is not hit-testable: '+${JSON.stringify(selector)});return {x,y}})()`);
 win.webContents.sendInputEvent({type:'mouseMove',...point});win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await settle();
}
async function checkMemoryPointerMenu(label='desktop',{full=true}={}){
 const row='.dp-item[data-memory-file="note-0.md"]';
 await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(row)}),host=node.closest('.set-content');host.scrollTop+=node.getBoundingClientRect().top-host.getBoundingClientRect().top-70})()`);await finish();
 await pointerClick(row+' .dp-more');await finish();
 const geometry=await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(row)}),anchor=row.querySelector('.dp-more'),menu=row.querySelector('.dp-menu'),overview=row.closest('.mem-overview'),content=row.closest('.set-content');const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const a=rect(anchor),m=rect(menu),o=rect(overview),style=getComputedStyle(menu),action=menu.querySelector('[data-action=detail]'),r=action.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {viewport:{width:innerWidth,height:innerHeight},anchor:a,menu:m,overview:o,content:rect(content),style:{left:menu.style.left,top:menu.style.top,position:style.position,display:style.display,visibility:style.visibility,transform:style.transform,overviewContainerType:getComputedStyle(overview).containerType},expanded:anchor.getAttribute('aria-expanded'),open:menu.classList.contains('open'),detailHit:action.contains(hit),withinViewport:m.left>=0&&m.right<=innerWidth&&m.top>=0&&m.bottom<=innerHeight,aligned:Math.abs(m.right-a.right)<=2&&(Math.abs(m.top-a.bottom-6)<=2||Math.abs(m.bottom-a.top+6)<=2)}})()`);
 diagnostics.pointerMenus||={};diagnostics.pointerMenus[label]=geometry;save();
 await capture('memory-menu-'+label);
 if(!geometry.withinViewport||!geometry.aligned||!geometry.detailHit){fs.writeFileSync(path.join(output,'memory-menu-failure.json'),JSON.stringify(geometry,null,2));fs.copyFileSync(path.join(output,'memory-menu-'+label+'.png'),path.join(output,'memory-menu-failure.png'));}
 await check(label+'PointerMenuIsVisibleAnchoredAndHitTestable',`(()=>{const g=${JSON.stringify(geometry)};return g.open&&g.expanded==='true'&&g.withinViewport&&g.aligned&&g.detailHit})()`);
 await pointerClick(row+' .dp-menu [data-action=detail]',{scroll:false});await waitFor("document.querySelector('.memory-detail:not([hidden])')?.dataset.memoryFile==='note-0.md'");
 await check(label+'PointerMenuDetailOpensTheTargetMemory',"document.querySelector('.memory-detail-title h2').textContent==='项目研究记录 1'&&$('dpMemoryPreview').textContent.includes('项目研究记录 1')&&!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')");
 await pointerClick('[data-memory-back]');await finish();
 await pointerClick(row+' .dp-more');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});await finish();
 await check(label+'PointerMenuEscapeClosesAndReturnsFocus',`!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')&&document.activeElement===document.querySelector(${JSON.stringify(row+' .dp-more')})`);
 if(!full)return;
 await pointerClick(row+' .dp-more');await pointerClick(row+' .dp-more',{scroll:false});
 await check('pointerMenuSecondClickClosesTheSameMenu',`!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')&&document.querySelector(${JSON.stringify(row+' .dp-more')}).getAttribute('aria-expanded')==='false'`);
 await pointerClick(row+' .dp-more');await pointerClick('#settingsModal .modal-title',{scroll:false});
 await check('pointerMenuOutsideClickClosesWithoutChangingTheSettingsPage',"!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')&&document.querySelector('.set-cat.active').dataset.cat==='memory'");
 await pointerClick(row+' .dp-more');await pointerClick('.dp-item[data-memory-file="note-3.md"] .dp-more',{scroll:false});
 await check('pointerMenuSwitchingRowsKeepsOnlyTheNewMenuOpen',"document.querySelectorAll('.dp-menu.open').length===1&&document.querySelectorAll('.dp-menu:popover-open').length===1&&document.querySelector('.dp-item[data-memory-file=\"note-3.md\"] .dp-more').getAttribute('aria-expanded')==='true'&&document.querySelector('.dp-item[data-memory-file=\"note-0.md\"] .dp-more').getAttribute('aria-expanded')==='false'");
 await pointerClick('#settingsModal .modal-title',{scroll:false});await pointerClick(row+' .dp-more');await pointerClick(row+' .dp-menu [data-action=delete]',{scroll:false});await waitFor("!!document.querySelector('.confirm-dialog')");
 await check('pointerMenuRemoveActionTargetsTheCorrectMemory',"document.querySelector('.confirm-message').textContent.includes('项目研究记录 1')&&!document.querySelector('.dp-menu:popover-open')");
 await pointerClick('.confirm-btn.cancel',{scroll:false});
 await check('cancelingPointerMenuRemovalDoesNotChangeTheMemory',"!document.querySelector('.confirm-dialog')&&memoryFixture.removeCalls.length===0&&memoryFixture.items.some(item=>item.file==='note-0.md')&&memoryFixture.files['note-0.md'].includes('项目研究记录 1')");
 await pointerClick(row+' .dp-more');
 const wheel=await evaluate("(()=>{const r=$('setContent').getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+r.height/2)}})()");
 win.webContents.sendInputEvent({type:'mouseMove',...wheel});win.webContents.sendInputEvent({type:'mouseWheel',...wheel,deltaY:-80,deltaX:0});await settle();
 await waitFor("!document.querySelector('.dp-menu.open')");
 await check('pointerMenuClosesWhenItsSettingsContentScrolls',"!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')");
 await pointerClick(row+' .dp-more');await refreshLibrary();await finish();
 await check('pointerMenuDoesNotRemainInTheTopLayerAfterListRefresh',"!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')&&!document.querySelector('#memorySection .dp-more[aria-expanded=true]')");
 await pointerClick(row+' .dp-more');await pointerClick('.set-nav-item[data-cat=general]',{scroll:false});await finish();
 await check('pointerMenuClosesWhenSwitchingSettingsCategories',"document.querySelector('.set-cat.active').dataset.cat==='general'&&!document.querySelector('.dp-menu.open')&&!document.querySelector('.dp-menu:popover-open')");
 await pointerClick('.set-nav-item[data-cat=memory]',{scroll:false});await finish();
}

async function expandLibrary(){
 const button='[data-memory-show-all]';
 if(await evaluate(`(()=>{const b=document.querySelector('${button}');return b&&!b.hidden&&!/收起/.test(b.textContent)&&b.getClientRects().length>0})()`))await click(button);
 await settle();
}
async function selectMemoryTab(tab,{expand=true}={}){
 await click(`[data-memory-tab="${tab}"]`);
 if(expand)await expandLibrary();
}
async function refreshLibrary(){await evaluate("$('memorySection')._memoryPage.refreshList()");await settle();}
async function checkMaintenanceGeometry(label,screenshot){
 const previousScroll=await evaluate("$('setContent').scrollTop");
 await click('[data-memory-maintenance]');await finish();
 await act(`memoryFixture.maintenanceGeometry=(()=>{
  const maintenance=document.querySelector('#memorySection .mem-maintenance-page'),panel=maintenance.querySelector('[data-mem-auto-panel]'),content=$('setContent');
  const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const b=rect(maintenance),p=rect(panel),c=rect(content),rows=[...panel.querySelectorAll('.set-row')].map(rect);
  const labels=[...panel.querySelectorAll('.set-row > .set-label')].map(node=>{const range=document.createRange();range.selectNodeContents(node);const lines=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);return {...rect(node),text:node.textContent.trim(),lineCount:new Set(lines.map(r=>Math.round(r.top*100)/100)).size};});
  const controls=[...panel.querySelectorAll('.memory-maintenance-controls')].map(rect);
  return {viewport:{width:innerWidth,height:innerHeight},maintenance:b,panel:p,content:c,rows,labels,controls,maintenanceOverflow:maintenance.scrollWidth-maintenance.clientWidth};
 })();`);
 diagnostics.maintenanceLayout||={};diagnostics.maintenanceLayout[label]=await evaluate('memoryFixture.maintenanceGeometry');save();
 await check(label+'MaintenanceOpensInsideTheOriginalSettingsColumn',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.maintenance.left>=g.content.left-1&&g.maintenance.right<=g.content.right+1&&g.maintenance.top>=g.content.top-1&&!!document.querySelector('[data-memory-maintenance-back]')&&document.querySelector('.set-cat.active').dataset.cat==='memory'})()");
 await check(label+'MaintenanceUsesExistingCustomSelectsAndModelSegments',"!!document.querySelector('.mem-maintenance-page #mem-auto-dow.custom-select .cs-trigger')&&!!document.querySelector('.mem-maintenance-page #mem-auto-time.custom-select .cs-trigger')&&!!document.querySelector('.mem-maintenance-page #mem-auto-model.settings-segmented')&&!document.querySelector('.mem-maintenance-page select')&&!!document.querySelector('.mem-maintenance-page [data-auto-run]')");
 await check(label+'MaintenancePreservesTheGuidanceDraftWithoutShowingItsInput',"!document.querySelector('#relayInstructionsSection textarea').getClientRects().length&&document.querySelector('#relayInstructionsSection textarea')===memoryFixture.guidanceNode&&document.querySelector('#relayInstructionsSection textarea').value==='保留 Relay 说明草稿'&&workspaceFixture.settingsWrites.length===0");
 await check(label+'MaintenanceContentFitsTheSettingsColumn',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.maintenanceOverflow<=1&&g.panel.left>=g.content.left-1&&g.panel.right<=g.content.right+1&&g.rows.length===2&&g.rows.every(r=>r.height>=32&&r.top>=g.panel.top-1&&r.bottom<=g.panel.bottom+1)&&g.rows[1].top>=g.rows[0].bottom-1&&document.documentElement.scrollWidth<=innerWidth})()");
 await check(label+'MaintenanceLabelsRemainReadable',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.labels.length===2&&g.labels.every(label=>label.width>=28&&label.lineCount>=1&&label.lineCount<=3)})()");
 await check(label+'MaintenanceControlsFitTheirRows',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.controls.length===2&&g.controls.every((control,i)=>control.width>0&&control.left>=g.panel.left-1&&control.right<=g.panel.right+1&&control.top>=g.rows[i].top-1&&control.bottom<=g.rows[i].bottom+1)})()");
 await click('#mem-auto-time .cs-trigger');await finish();
 await check(label+'MaintenanceTimeMenuUsesRelayPopoverAndFitsTheWindow',"(()=>{const popup=document.querySelector('#mem-auto-time .cs-popup'),r=popup.getBoundingClientRect();return popup.matches(':popover-open')&&!popup.hidden&&popup.querySelectorAll('.cs-option').length===48&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(document.querySelector('#mem-auto-time .cs-trigger')).borderRadius==='8px'})()");
 await click('#mem-auto-time .cs-option[data-value="10:30"]');
 await check(label+'MaintenanceTimeSelectionClosesTheExistingPopover',"document.querySelector('#mem-auto-time').dataset.value==='10:30'&&document.querySelector('#mem-auto-time .cs-popup').hidden");
 await capture(screenshot);
 await click('[data-memory-maintenance-back]');await finish();
 await check(label+'ReturningFromMaintenanceKeepsTheGuidanceAndSettingsDrafts',"document.querySelector('#relayInstructionsSection textarea')===memoryFixture.guidanceNode&&document.querySelector('#relayInstructionsSection textarea').value==='保留 Relay 说明草稿'&&$('set-theme')===memoryFixture.brandNode&&$('set-theme').dataset.value==='dark'");
 await act(`$('setContent').scrollTop=${previousScroll};`);await settle();
}
function installFixture(){
 const base=window.api,state=window.memoryFixture={reads:[],writes:[],pendingReads:[],pendingWrites:[],holdRead:false,holdWrite:false,failRead:false,failWrite:false,files:{},reveals:[],revisions:{},initialRevisions:{},readRevisions:{},undoCalls:[],undoRecords:{},pendingUndos:[],holdUndo:false,failUndo:false,restoreArchivedCalls:[],pendingArchiveRestores:[],holdRestoreArchived:false,failRestoreArchived:false,pendingArchived:[],holdArchived:false,checkCalls:0,pendingChecks:[],holdCheck:false,statusCalls:[],purgeCalls:[],pendingPurges:[],holdPurge:false,failPurge:false,holdStatus:false,pendingStatuses:[],removeCalls:[]};
 const draftHealth=()=>({state:'draft',reason:'等待用户确认，尚未用于回答。',issues:[],legacy:false});
 const activeHealth=()=>({state:'active',label:'可用',reason:null,issues:[],legacy:false});
 let revision=0;const bump=file=>(state.revisions[file]=(++revision).toString(16).padStart(64,'0'));
 state.items=Array.from({length:24},(_,i)=>({file:`note-${i}.md`,name:`项目研究记录 ${i+1}`,description:'用于验证记忆列表、详情和编辑之间的连续切换。',type:i%2?'project':'reference',scope:'global',status:'active',health:activeHealth()}));
 for(const item of state.items){state.files[item.file]='---\nname: '+item.name+'\ntype: reference\n---\n# '+item.name+'\n\n本地资料中的研究结论。\n\n'+Array.from({length:16},(_,i)=>`## 记录 ${i+1}\n\n记忆正文应该只在右侧内容区阅读，并保留完整的设置导航。`).join('\n\n')+'\n\n<img src=x onerror="window.__memoryXss=1">\n\n```js\nconst source = "安全展示源码";\n```';bump(item.file);}
 state.projects=[{id:'project-relay',name:'Relay',path:'D:\\AI\\Relay'},{id:'project-research',name:'研究资料',path:'D:\\SyntheticResearch'}];
 state.items[0].scope='project';state.items[0].projectId='project-relay';state.items[4].scope='project';state.items[4].projectId='project-research';
 const source=(title,quote)=>({kind:'conversation',conversationId:'missing-source-chat',turnIndex:2,turnId:'turn-2',role:'user',title,quote,at:'2026-10-20T02:00:00Z',revision:'a'.repeat(64)});
 state.items.push(
  {file:'candidate-new.md',name:'先给结论，再提供验证依据',description:'回答顺序与证据偏好。',type:'feedback',scope:'project',projectId:'project-relay',status:'draft',confidence:'inferred',health:draftHealth(),sources:[source('偏好来源 <img src=x>','请先说明结论。<img src=x onerror="window.__candidateSourceXss=1">')]},
  {file:'candidate-global.md',name:'默认使用中文',description:'用户语言偏好。',type:'user',scope:'global',status:'draft',confidence:'inferred',health:draftHealth(),sources:[source('语言偏好','后续默认用中文。')]},
  {file:'candidate-merge.md',name:'资料应附原始出处和验证结论',description:'合并重复的研究资料要求。',type:'reference',scope:'global',status:'draft',confidence:'inferred',health:draftHealth(),sources:[source('研究约定','资料应同时保留出处和验证结果。')],replaces:[{file:'note-22.md',revision:state.revisions['note-22.md']},{file:'note-23.md',revision:state.revisions['note-23.md']}]}
 );
 for(const item of state.items.filter(item=>item.status==='draft')){state.files[item.file]='---\nname: '+item.name+'\ntype: '+item.type+'\nscope: '+item.scope+'\nstatus: draft\nconfidence: inferred\n---\n# '+item.name+'\n\n'+item.description;bump(item.file);}
 state.files['MEMORY.md']='# 记忆索引\n\n'+state.items.map(x=>`- ${x.name}：${x.file}`).join('\n');bump('MEMORY.md');state.initialRevisions={...state.revisions};
 state.archivedItems=[{file:'deleted-note.md',meta:{name:'已移除的研究记录',description:'可恢复的合成归档'},archiveId:'archive-deleted-1',createdAt:'2026-09-12T01:00:00Z'},{file:'note-0.md',meta:{name:'同名冲突样本',description:'已有同名记忆时必须拒绝恢复'},archiveId:'archive-conflict-1',createdAt:'2026-09-12T02:00:00Z'}];
 state.items[6].sources=[{kind:'conversation',conversationId:'missing-source-chat',turnIndex:2,role:'user',title:'原始偏好 <img src=x>',quote:'请保留验证结果。<img src=x onerror="window.__memorySourceXss=1">',at:'2026-10-20T02:00:00Z',revision:'a'.repeat(64)},{kind:'memory',file:'note-2.md',revision:'b'.repeat(64)}];
 const readResult=file=>{state.readRevisions[file]=state.revisions[file];const item=state.items.find(item=>item.file===file);return {ok:true,content:state.files[file]||'',revision:state.revisions[file],health:structuredClone(item?.health),meta:structuredClone({...item,sources:item?.sources||[],replaces:item?.replaces||[],status:item?.status}),body:(state.files[file]||'').replace(/^---\n[\s\S]*?\n---\n/,'')};};
 const writeResult=entry=>{if(entry.revision!==state.revisions[entry.file])return {ok:false,message:'合成修订冲突'};state.files[entry.file]=entry.content;const item=state.items.find(item=>item.file===entry.file);if(item)item.health=item.status==='draft'||item.confidence==='inferred'?draftHealth():activeHealth();return {ok:true,revision:bump(entry.file)};};
 const listResult=()=>({ok:true,items:state.items.map(item=>({...structuredClone(item),revision:state.revisions[item.file]})),summary:state.items.reduce((summary,item)=>{summary.total++;summary[item.health?.state||'active']++;if(item.health?.legacy)summary.legacy++;return summary;},{total:0,active:0,draft:0,inactive:0,invalid:0,legacy:0}),checkedAt:'2026-10-21T02:00:00Z',projectCheck:state.projectCheck});
 const restoreArchivedResult=entry=>{
  if(Object.hasOwn(state.files,entry.file))return {ok:false,code:'MEMORY_CONFLICT',message:'已有同名记忆，未覆盖'};
  if(!state.archivedItems.some(item=>item.file===entry.file&&item.archiveId===entry.archiveId))return {ok:false,code:'MEMORY_CONFLICT',message:'归档状态已变化'};
  if(state.failRestoreArchived)return {ok:false,message:'合成归档恢复失败'};
  state.files[entry.file]='# 恢复的合成归档 '+entry.file;
  state.archivedItems=state.archivedItems.filter(item=>item.file!==entry.file);
  if(!state.items.some(item=>item.file===entry.file))state.items.push({file:entry.file,name:'已恢复的归档记忆',description:'恢复后的合成资料',scope:'global',status:'active',health:activeHealth()});
  return {ok:true,file:entry.file,revision:bump(entry.file)};
 };
 const statusResult=entry=>{
  const item=state.items.find(item=>item.file===entry.file);
  if(!item||entry.revision!==state.revisions[entry.file])return {ok:false,code:'MEMORY_CONFLICT',message:'合成修订冲突'};
  if(item.health?.state==='invalid')return {ok:false,message:'请先修复记忆'};
  const affected=[entry.file,...(entry.status==='active'?item.replaces||[]:[]).map(target=>target.file)];
  const before=affected.map(file=>({file,item:structuredClone(state.items.find(x=>x.file===file)),content:state.files[file],revision:state.revisions[file]}));
  if(entry.status==='active'){
   for(const target of item.replaces||[]){if(state.revisions[target.file]!==target.revision)return {ok:false,code:'MEMORY_CONFLICT',message:'原记忆已变化，请重新审核候选内容。'};}
   for(const target of item.replaces||[]){const old=state.items.find(x=>x.file===target.file);if(old){old.status='superseded';old.health={state:'inactive',reason:'记忆已被替代，未用于回答。',issues:[],legacy:false};bump(old.file);}}
  }
  item.status=entry.status;if(entry.status==='active')item.confidence='user_confirmed';
  item.health=entry.status==='active'?activeHealth():{state:'inactive',reason:'记忆已过期，未用于回答。',issues:[],legacy:false};
  const revision=bump(entry.file),undoId='undo-'+entry.file+'-'+revision,undoExpiresAt=new Date(Date.now()+300000).toISOString();
  state.undoRecords[undoId]={file:entry.file,before,after:Object.fromEntries(affected.map(file=>[file,state.revisions[file]])),undoExpiresAt};
  return state.lastStatusResult={ok:true,file:entry.file,status:entry.status,revision,undoId,undoExpiresAt};
 };
 const undoResult=entry=>{
  const record=state.undoRecords[entry.undoId];
  if(!record||record.file!==entry.file||Date.parse(record.undoExpiresAt)<=Date.now())return {ok:false,code:'MEMORY_UNDO_EXPIRED',message:'撤销已过期'};
  if(state.failUndo)return {ok:false,message:'合成撤销失败'};
  if(entry.revision!==state.revisions[entry.file]||Object.entries(record.after).some(([file,revision])=>state.revisions[file]!==revision))return {ok:false,code:'MEMORY_CONFLICT',message:'记忆已变化，不能撤销'};
  for(const snapshot of record.before){const index=state.items.findIndex(item=>item.file===snapshot.file);state.items[index]=structuredClone(snapshot.item);state.files[snapshot.file]=snapshot.content;state.revisions[snapshot.file]=snapshot.revision;}
  delete state.undoRecords[entry.undoId];
  return {ok:true,file:entry.file,revision:state.revisions[entry.file],restoredFiles:record.before.map(item=>item.file)};
 };
 state.resolveStatus=()=>{state.holdStatus=false;for(const p of state.pendingStatuses.splice(0))p.resolve(statusResult(p));};
 const purgeResult=entry=>{if(Object.hasOwn(state.files,entry.file)||!state.archivedItems.some(item=>item.file===entry.file&&item.archiveId===entry.archiveId))return {ok:false,message:'归档状态已变化'};if(state.failPurge)return {ok:false,message:'合成删除失败'};state.archivedItems=state.archivedItems.filter(item=>item.file!==entry.file);return {ok:true,file:entry.file,permanent:true};};
 state.resolveRead=()=>{state.holdRead=false;for(const p of state.pendingReads.splice(0))p.resolve(readResult(p.file));};
 state.resolveWrite=()=>{state.holdWrite=false;for(const p of state.pendingWrites.splice(0))p.resolve(writeResult(p));};
 state.resolveUndo=()=>{state.holdUndo=false;for(const p of state.pendingUndos.splice(0))p.resolve(undoResult(p));};
 state.resolveRestoreArchived=()=>{state.holdRestoreArchived=false;for(const p of state.pendingArchiveRestores.splice(0))p.resolve(restoreArchivedResult(p));};
 state.resolveArchived=()=>{state.holdArchived=false;for(const p of state.pendingArchived.splice(0))p.resolve({ok:true,items:structuredClone(state.archivedItems)});};
 state.resolveCheck=()=>{state.holdCheck=false;for(const p of state.pendingChecks.splice(0))p.resolve(listResult());};
 state.resolvePurge=()=>{state.holdPurge=false;for(const p of state.pendingPurges.splice(0))p.resolve(purgeResult(p));};
 const memory={
  remove:async(...args)=>{state.removeCalls.push(args);return {ok:false,message:'未预期的测试移除请求'};},
  learningStatus:async()=>({ok:true,running:false,lastRun:null}),
  list:async()=>listResult(),
  check:async()=>{state.checkCalls++;return state.holdCheck?new Promise(resolve=>state.pendingChecks.push({resolve})):listResult();},
  setStatus:async(file,status,revision)=>{const entry={file,status,revision};state.statusCalls.push(entry);return state.holdStatus?new Promise(resolve=>state.pendingStatuses.push({...entry,resolve})):statusResult(entry);},
  read:async file=>{state.reads.push(file);if(state.missingReads?.includes(file))return {ok:false,code:'MEMORY_NOT_FOUND',message:'记忆文件不存在'};if(state.failRead)throw Error('合成读取失败');if(state.holdRead)return new Promise(resolve=>state.pendingReads.push({file,resolve}));return readResult(file);},
  write:async(file,content,revision)=>{const entry={file,content,revision};state.writes.push(entry);if(state.failWrite)return {ok:false,message:'合成保存失败'};if(state.holdWrite)return new Promise(resolve=>state.pendingWrites.push({...entry,resolve}));return writeResult(entry);},
  archived:async()=>state.holdArchived?new Promise(resolve=>state.pendingArchived.push({resolve})):{ok:true,items:structuredClone(state.archivedItems)},
  undo:async(file,undoId,revision)=>{const entry={file,undoId,revision};state.undoCalls.push(entry);return state.holdUndo?new Promise(resolve=>state.pendingUndos.push({...entry,resolve})):undoResult(entry);},
  restoreArchived:async(file,archiveId)=>{const entry={file,archiveId};state.restoreArchivedCalls.push(entry);return state.holdRestoreArchived?new Promise(resolve=>state.pendingArchiveRestores.push({...entry,resolve})):restoreArchivedResult(entry);},
  purge:async(file,archiveId)=>{const entry={file,archiveId};state.purgeCalls.push(entry);return state.holdPurge?new Promise(resolve=>state.pendingPurges.push({...entry,resolve})):purgeResult(entry);},
  revealFile:async file=>{state.reveals.push(file);return {ok:true};},
 };
 window.api=new Proxy(base,{get(target,key){if(key==='memory')return memory;if(key==='projects')return new Proxy(base.projects||{},{get(target,method){return method==='list'?async()=>({ok:true,projects:structuredClone(state.projects)}):target[method];}});if(key==='history')return new Proxy(base.history,{get(history,method){return method==='load'?async id=>{if(id==='missing-source-chat'){state.sourceLoads=(state.sourceLoads||0)+1;return null;}return history.load(id);}:history[method];}});return target[key];}});
}
async function reviewCandidate(file){
 const row=`.mem-candidate[data-memory-file=\"${file}\"]`;
 if(!await evaluate(`(()=>{const b=document.querySelector('${row} [data-memory-approve]');return b&&b.getClientRects().length>0})()`))await click(`${row} [data-memory-review]`);
 await waitFor(`!!document.querySelector('${row} [data-memory-approve]')`);
 await settle();
}
async function checkUndoPreservesDraft(file,label){
 await act(`memoryFixture.beforeUndoCalls=memoryFixture.undoCalls.length;memoryFixture.beforeUndoStatus=memoryFixture.items.find(item=>item.file===${JSON.stringify(file)}).status;void renderMemoryEditor(${JSON.stringify(file)},'验证撤销保护',{edit:true});`);
 await waitFor("document.querySelector('.memory-detail').dataset.memoryEditing==='true'");
 await act("$('dpEditor').value='# 未保存的编辑不能被撤销覆盖';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await click('[data-memory-back]');
 await waitFor("!!document.querySelector('[data-memory-undo]')");await click('[data-memory-undo]');await waitFor("document.querySelector('.memory-detail').dataset.memoryEditing==='true'");
 await check(label+'UndoProtectsUnsavedDraftWithoutCallingHost',`memoryFixture.undoCalls.length===memoryFixture.beforeUndoCalls&&$('dpEditor').value==='# 未保存的编辑不能被撤销覆盖'&&document.querySelector('.memory-detail').dataset.memoryFile===${JSON.stringify(file)}&&memoryFixture.items.find(item=>item.file===${JSON.stringify(file)}).status===memoryFixture.beforeUndoStatus`);
 await click('[data-memory-cancel]');await click('[data-memory-back]');
}
async function checkCandidateOverview(){
 await act("memoryFixture.initialState=structuredClone({items:memoryFixture.items,files:memoryFixture.files,revisions:memoryFixture.revisions});memoryFixture.guidanceNode=document.querySelector('#relayInstructionsSection textarea');memoryFixture.guidanceNode.value='保留 Relay 说明草稿';memoryFixture.guidanceNode.dispatchEvent(new Event('input',{bubbles:true}));memoryFixture.nav=document.querySelector('.set-nav');");
 await check('guidanceKeepsOriginal132PixelInputAndDraft',"(()=>{const t=memoryFixture.guidanceNode;return t.getBoundingClientRect().height===132&&getComputedStyle(t).resize==='none'&&t.value==='保留 Relay 说明草稿'})()");
 await check('pendingCandidatesAreSeparateFromTheCompactLibrary',"document.querySelectorAll('.mem-candidate').length===3&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===4&&!document.querySelector('#memorySection [data-list] .mem-candidate')&&!!document.querySelector('[data-memory-show-all]')");
 await check('pendingCandidateActionsAreVisibleInTheInitialWindow',"[...document.querySelectorAll('.mem-candidate [data-memory-review]')].every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight})");
 await check('scopeLabelsDistinguishAllConversationsFromActualRelayProject',"document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"]').textContent.includes('项目：Relay')&&document.querySelector('.mem-candidate[data-memory-file=\"candidate-global.md\"]').textContent.includes('所有对话')");
 await capture('memory-overview-v3-dark');await act("document.documentElement.dataset.theme='light';");await capture('memory-overview-v3');await act("document.documentElement.dataset.theme='dark';");
 await click('[data-memory-show-all]');await check('libraryExpandsWithoutMixingInCandidates',"document.querySelectorAll('#memorySection [data-list] .dp-item').length===24");
 await check('differentProjectMemoriesDisplayTheirOwnActualProjectNames',"document.querySelector('.dp-item[data-memory-file=\"note-0.md\"]').textContent.includes('项目：Relay')&&document.querySelector('.dp-item[data-memory-file=\"note-4.md\"]').textContent.includes('项目：研究资料')&&!document.querySelector('.dp-item[data-memory-file=\"note-4.md\"]').textContent.includes('项目：Relay')");await click('[data-memory-show-all]');
 await check('libraryCanReturnToItsCompactFourRows',"document.querySelectorAll('#memorySection [data-list] .dp-item').length===4");
 await selectMemoryTab('active',{expand:false});await refreshLibrary();
 await check('asyncLibraryRefreshPreservesFocusedTab',"document.activeElement?.dataset.memoryTab==='active'");
 await act("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");await refreshLibrary();
 await check('tabArrowNavigationStillWorksAfterAsyncRefresh',"document.activeElement?.dataset.memoryTab==='inactive'&&document.querySelector('[data-memory-tab=inactive]').getAttribute('aria-selected')==='true'");
 await act("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");await refreshLibrary();
 await check('repeatedTabArrowNavigationSurvivesSuccessiveRefreshes',"document.activeElement?.dataset.memoryTab==='invalid'&&document.querySelector('[data-memory-tab=invalid]').getAttribute('aria-selected')==='true'");await selectMemoryTab('active',{expand:false});
 await click('[data-memory-search-toggle]');
 await check('memoryFiltersReuseRelayCustomSelects',"!!document.querySelector('#memory-type-filter.custom-select .cs-trigger')&&!!document.querySelector('#memory-scope-filter.custom-select .cs-trigger')&&!document.querySelector('#memorySection select')");
 await act("const input=document.querySelector('[data-memory-search]');input.value='项目研究记录 1';input.dispatchEvent(new Event('input',{bubbles:true}));");await settle();
 await check('memorySearchFiltersTheDisplayedLibrary',"document.querySelectorAll('#memorySection [data-list] .dp-item').length>0&&[...document.querySelectorAll('#memorySection [data-list] .dp-item')].every(row=>row.textContent.includes('项目研究记录 1'))");
 await click('#memory-type-filter .cs-trigger');await click('#memory-type-filter .cs-option[data-value=project]');
 await check('typeFilterAppliesAlongsideSearch',"document.querySelectorAll('#memorySection [data-list] .dp-item').length>0&&[...document.querySelectorAll('#memorySection [data-list] .dp-item')].every(row=>row.querySelector('.mem-badge').textContent==='项目')");
 await click('[data-memory-search-toggle]');await check('closingSearchClearsHiddenConditions',"document.querySelectorAll('#memorySection [data-list] .dp-item').length===4&&document.querySelector('.dp-item[data-memory-file=\"note-0.md\"]')");
 await click('[data-memory-search-toggle]');await click('#memory-scope-filter .cs-trigger');
 await act("[...document.querySelectorAll('#memory-scope-filter .cs-option')].find(node=>node.textContent.includes('Relay')).click();");await settle();
 await check('scopeFilterUsesTheActualProjectCatalog',"document.querySelectorAll('#memorySection [data-list] .dp-item').length===1&&!!document.querySelector('.dp-item[data-memory-file=\"note-0.md\"]')");
 await click('#memory-scope-filter .cs-trigger');await act("[...document.querySelectorAll('#memory-scope-filter .cs-option')].find(node=>node.textContent.includes('研究资料')).click();");await settle();
 await check('scopeFilterSeparatesDifferentProjectsInsteadOfCombiningThem',"document.querySelectorAll('#memorySection [data-list] .dp-item').length===1&&!!document.querySelector('.dp-item[data-memory-file=\"note-4.md\"]')&&!document.querySelector('.dp-item[data-memory-file=\"note-0.md\"]')");await click('[data-memory-search-toggle]');
 await act('memoryFixture.holdRead=true;');await click('.mem-candidate[data-memory-file="candidate-merge.md"] [data-memory-review]');await waitFor('memoryFixture.pendingReads.length>0');
 await act('preserveSettingsView();memoryFixture.resolveRead();');await settle();await act('restoreSettingsView();');
 await waitFor("!!document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"] [data-memory-approve]')");
 await check('candidateReadCompletesWhileSettingsArePreservedInAFragment',"(()=>{const row=document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]');return row.querySelector('.mem-review-body').textContent.includes('合并重复的研究资料要求')&&!row.querySelector('[data-memory-approve]').disabled&&!settingsViewSnapshot&&document.querySelector('.set-nav')===memoryFixture.nav&&document.querySelector('#relayInstructionsSection textarea')===memoryFixture.guidanceNode&&memoryFixture.guidanceNode.value==='保留 Relay 说明草稿'&&$('set-theme')===memoryFixture.brandNode&&$('set-theme').dataset.value==='dark'&&inputEl.value==='保留对话草稿'})()");
 await act('memoryFixture.holdRead=true;');await click('.mem-candidate[data-memory-file="candidate-global.md"] [data-memory-review]');await waitFor('memoryFixture.pendingReads.length>0');
 await act('memoryFixture.holdRead=false;');await reviewCandidate('candidate-new.md');await act('memoryFixture.resolveRead();');await settle();
 await check('lateCandidateReadCannotReplaceTheCurrentReview',"(()=>{const current=document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-approve]'),old=document.querySelector('.mem-candidate[data-memory-file=\"candidate-global.md\"] [data-memory-approve]');return !!current?.getClientRects().length&&!old?.getClientRects().length})()");
 await check('candidateReviewKeepsSettingsAndGuidanceMounted',"document.querySelector('.set-nav')===memoryFixture.nav&&document.querySelector('#relayInstructionsSection textarea')===memoryFixture.guidanceNode&&memoryFixture.guidanceNode.value==='保留 Relay 说明草稿'&&!document.querySelector('.memory-detail:not([hidden])')");
 await check('candidateSourceQuotesCannotExecuteHtml',"document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"]').textContent.includes('请先说明结论。<img')&&!document.querySelector('.mem-candidate img')&&window.__candidateSourceXss===undefined");
 await capture('memory-candidate-review');
 await click('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-edit]');await waitFor("document.querySelector('.memory-detail').dataset.memoryEditing==='true'");
 await act("$('dpEditor').value=memoryFixture.files['candidate-new.md'].replace('回答顺序与证据偏好。','编辑后仍需确认。');$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await click('[data-memory-save]');await waitFor("$('dpMemorySource').classList.contains('hidden')");
 await check('savingCandidateEditsDoesNotApproveIt',"memoryFixture.items.find(item=>item.file==='candidate-new.md').status==='draft'&&memoryFixture.statusCalls.length===0&&memoryFixture.files['candidate-new.md'].includes('编辑后仍需确认。')");
 await click('[data-memory-back]');await reviewCandidate('candidate-new.md');await act("memoryFixture.candidateSavedRevision=memoryFixture.revisions['candidate-new.md'];memoryFixture.holdStatus=true;");await click('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-approve]');await waitFor('memoryFixture.pendingStatuses.length===1');
 await check('candidateApprovalDisablesRepeatSubmission',"document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-approve]').disabled");await click('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-approve]');
 await check('repeatedCandidateApprovalDoesNotWriteTwice','memoryFixture.statusCalls.length===1');
 await act("memoryFixture.beforeBusyRead=memoryFixture.reads.length;void renderMemoryEditor('candidate-new.md','从其他来源打开忙碌条目',{edit:true});");await settle();
 await check('pendingMutationBlocksExternalEditorEntryForTheSameMemory',"!document.querySelector('.memory-detail:not([hidden])')&&memoryFixture.reads.length===memoryFixture.beforeBusyRead&&document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"] [data-memory-approve]').disabled");
 await act('memoryFixture.resolveStatus();');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"]')");
 await check('candidateApprovalUsesTheLatestSavedRevision',"memoryFixture.statusCalls[0].revision===memoryFixture.candidateSavedRevision&&memoryFixture.candidateSavedRevision!==memoryFixture.initialRevisions['candidate-new.md']");
 await checkUndoPreservesDraft('candidate-new.md','approval');
 await check('approvalOffersABoundedImmediateUndoInsteadOfAVersionId',"(()=>{const result=memoryFixture.lastStatusResult,remaining=Date.parse(result.undoExpiresAt)-Date.now();return !!result.undoId&&!Object.hasOwn(result,'versionId')&&remaining>240000&&remaining<=300000&&!!document.querySelector('[data-memory-undo]')})()");
 await act('memoryFixture.failUndo=true;');await click('[data-memory-undo]');await waitFor("$('appToast').textContent==='合成撤销失败'");
 await check('temporaryUndoFailurePreservesTheConfirmedMemoryAndRetryAction',"memoryFixture.items.find(item=>item.file==='candidate-new.md').status==='active'&&!document.querySelector('[data-memory-undo]').disabled");
 await act('memoryFixture.failUndo=false;memoryFixture.holdUndo=true;memoryFixture.expectedUndo=structuredClone(memoryFixture.lastStatusResult);');await click('[data-memory-undo]');await waitFor('memoryFixture.pendingUndos.length===1');
 await check('pendingUndoDisablesDuplicateSubmission',"document.querySelector('[data-memory-undo]').disabled");await click('[data-memory-undo]');await check('pendingUndoUsesASingleHostRequest','memoryFixture.undoCalls.length===2');
 await act("void renderMemoryEditor('note-20.md','撤销期间保留当前详情');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 21')");await act('memoryFixture.resolveUndo();');await settle();
 await check('lateImmediateUndoRestoresItsCandidateWithoutReplacingAnotherDetail',"memoryFixture.items.find(item=>item.file==='candidate-new.md').status==='draft'&&$('dpMemoryPreview').textContent.includes('项目研究记录 21')&&document.querySelector('.memory-detail-title h2').textContent==='撤销期间保留当前详情'&&$('set-theme').dataset.value==='dark'");
 await check('immediateUndoPassesTokenAndPostApprovalRevisionAndConsumesIt',"(()=>{const call=memoryFixture.undoCalls.at(-1),expected=memoryFixture.expectedUndo;return call.file===expected.file&&call.undoId===expected.undoId&&call.revision===expected.revision&&!memoryFixture.undoRecords[call.undoId]&&!document.querySelector('[data-memory-undo]')})()");
 await click('[data-memory-back]');await reviewCandidate('candidate-new.md');await click('.mem-candidate[data-memory-file="candidate-new.md"] [data-memory-approve]');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-new.md\"]')");
 await act("memoryFixture.undoRecords[memoryFixture.lastStatusResult.undoId].undoExpiresAt='2000-01-01T00:00:00Z';");await click('[data-memory-undo]');await waitFor("$('appToast').textContent==='撤销已过期'");
 await check('expiredUndoKeepsTheMemoryAndRemovesTheStaleAction',"memoryFixture.items.find(item=>item.file==='candidate-new.md').status==='active'&&!document.querySelector('[data-memory-undo]')");
 await reviewCandidate('candidate-global.md');await click('.mem-candidate[data-memory-file=\"candidate-global.md\"] [data-memory-dismiss]');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-global.md\"]')");
 await checkUndoPreservesDraft('candidate-global.md','dismissal');
 await click('[data-memory-undo]');await waitFor("!!document.querySelector('.mem-candidate[data-memory-file=\"candidate-global.md\"]')");
 await check('dismissalCanBeUndoneWithoutAHistoryApi',"memoryFixture.items.find(item=>item.file==='candidate-global.md').status==='draft'&&memoryFixture.undoCalls.at(-1).file==='candidate-global.md'&&!document.querySelector('[data-memory-undo]')");
 await reviewCandidate('candidate-global.md');await click('.mem-candidate[data-memory-file="candidate-global.md"] [data-memory-dismiss]');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-global.md\"]')");
 await selectMemoryTab('inactive');
 await check('ignoredCandidatesRemainInInactiveInsteadOfArchives',"!!document.querySelector('#memorySection [data-list] .dp-item[data-memory-file=\"candidate-global.md\"]')&&!memoryFixture.archivedItems.some(item=>item.file==='candidate-global.md')");await selectMemoryTab('active');
 await reviewCandidate('candidate-merge.md');
 await check('mergeReviewShowsBothOriginalMemoriesBeforeApproval',"(()=>{const r=document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]');return r.textContent.includes('项目研究记录 23')&&r.textContent.includes('项目研究记录 24')&&r.querySelector('[data-memory-approve]').textContent.includes('2')})()");
 await capture('memory-candidate-merge');
 await act("memoryFixture.originalTargetRevision=memoryFixture.revisions['note-22.md'];memoryFixture.revisions['note-22.md']='concurrent-update';");await click('.mem-candidate[data-memory-file=\"candidate-merge.md\"] [data-memory-approve]');await settle();
 await check('mergeConflictLeavesTheCandidateAndOriginalsUnchanged',"memoryFixture.items.find(x=>x.file==='candidate-merge.md').status==='draft'&&memoryFixture.items.find(x=>x.file==='note-22.md').status==='active'&&memoryFixture.items.find(x=>x.file==='note-23.md').status==='active'&&!!document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]')");
 await act("memoryFixture.revisions['note-22.md']=memoryFixture.originalTargetRevision;");
 await click('.mem-candidate[data-memory-file=\"candidate-merge.md\"] [data-memory-review]');await reviewCandidate('candidate-merge.md');await click('.mem-candidate[data-memory-file=\"candidate-merge.md\"] [data-memory-approve]');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]')");
 await selectMemoryTab('inactive');await check('approvedMergeLeavesSupersededSourcesInInactive',"['note-22.md','note-23.md'].every(file=>!!document.querySelector('.dp-item[data-memory-file=\"'+file+'\"]'))&&!memoryFixture.archivedItems.some(x=>x.file==='note-22.md'||x.file==='note-23.md')");
 await click('[data-memory-undo]');await waitFor("!!document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]')");
 await check('mergeImmediateUndoRestoresAllTargetsAndTheCandidateTogether',"memoryFixture.items.find(item=>item.file==='candidate-merge.md').status==='draft'&&['note-22.md','note-23.md'].every(file=>memoryFixture.items.find(item=>item.file===file).status==='active')&&!document.querySelector('[data-memory-undo]')");
 await reviewCandidate('candidate-merge.md');await click('.mem-candidate[data-memory-file="candidate-merge.md"] [data-memory-approve]');await waitFor("!document.querySelector('.mem-candidate[data-memory-file=\"candidate-merge.md\"]')");
 await act("Object.assign(memoryFixture,structuredClone(memoryFixture.initialState));memoryFixture.writes=[];memoryFixture.statusCalls=[];memoryFixture.reads=[];memoryFixture.sourceLoads=0;");await selectMemoryTab('active');await refreshLibrary();await expandLibrary();
 await check('candidateTestRestoresTheSyntheticBaseline',"document.querySelectorAll('.mem-candidate').length===3&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===24&&memoryFixture.writes.length===0&&memoryFixture.statusCalls.length===0");
}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
 const fixture=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n')+`\n(${installFixture.toString()})();`;
 const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',`<head><base href="${pathToFileURL(path.join(root,'renderer')+path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
 const file=path.join(output,'fixture.html');fs.writeFileSync(file,html);
 win=new BrowserWindow({width:1200,height:860,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 await win.loadFile(file);win.showInactive();await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
 await evaluate("openSettings('general')");await act("$('set-theme').dataset.value='dark';$('set-theme').dispatchEvent(new Event('input',{bubbles:true}));memoryFixture.brandNode=$('set-theme');inputEl.value='保留对话草稿';");
 await click('.set-nav-item[data-cat=memory]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===4&&document.querySelectorAll('.mem-candidate').length===3");await finish();
 await checkCandidateOverview();
 await checkMemoryPointerMenu();
 win.setSize(780,720);await waitFor('innerWidth<=780');await finish();await checkMemoryPointerMenu('narrow',{full:false});
 win.setSize(1200,860);await waitFor('innerWidth>=1100');await finish();
 await check('MemoryMaintenanceStartsAsAnEntryInTheOverview',"!!document.querySelector('[data-memory-maintenance]')&&!document.querySelector('.mem-maintenance-page:not([hidden])')");
 await check('healthyMemoryListHasNoPersistentCheckCopyOrHealthRows',"document.querySelector('[data-mem-check-summary]').hidden&&document.querySelector('[data-mem-check-summary]').textContent===''&&!document.querySelector('#memorySection .memory-item-health')&&document.querySelector('.dp-item[data-memory-file=\"note-0.md\"] .mem-badge').textContent==='参考'&&document.querySelector('.dp-item[data-memory-file=\"note-1.md\"] .mem-badge').textContent==='项目'");
 await click('[data-mem-check]');await waitFor("$('appToast')?.textContent==='检查完成，未发现异常'");
 await check('healthyManualCheckUsesOnlyAShortToast',"memoryFixture.checkCalls===1&&document.querySelector('[data-mem-check-summary]').hidden&&document.querySelector('[data-mem-check-summary]').textContent===''&&!document.querySelector('#memorySection .memory-item-health')");
 await act("memoryFixture.nav=document.querySelector('.set-nav');memoryFixture.list=$('memorySection').querySelector('[data-list]');memoryFixture.content=$('setContent');memoryFixture.bounds=(()=>{const r=$('memorySection').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top}})();");
  await check("relayMemoryListHasNoRetiredSdkControls","!document.querySelector('[data-general-row=sdkMemoryMode],[data-general-row=sdkAutoDreamEnabled],#general-sdkMemoryMode')&&!!document.querySelector('[data-mem-index]')&&document.querySelectorAll('#memorySection .dp-item').length===24");
  await check("openingMemoryPreservesGeneralDraftsWithoutWritingOrAddingNativeMemoryPreferences","$('set-theme')===memoryFixture.brandNode&&$('set-theme').dataset.value==='dark'&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkMemoryMode')&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkAutoDreamEnabled')&&workspaceFixture.settingsWrites.length===0");
 await checkMaintenanceGeometry('DesktopLongList','memory-maintenance-desktop');
 await capture('memory-list');
 await act("$('setContent').scrollTop=220;memoryFixture.scroll=$('setContent').scrollTop;void renderMemoryEditor('note-6.md','项目研究记录 7');");
 await waitFor("document.querySelector('#dpMemoryPreview h1')?.textContent==='项目研究记录 7'");
 await check('detailKeepsTheSettingsNavigationAndOriginalForm',"document.querySelector('.set-nav')===memoryFixture.nav&&$('set-theme')===memoryFixture.brandNode&&$('set-theme').dataset.value==='dark'&&document.querySelector('.set-cat.active').dataset.cat==='memory'&&!settingsViewSnapshot");
 await check('detailEntersWithALocalTransition',"matchMedia('(prefers-reduced-motion: reduce)').matches||document.getAnimations().some(a=>a.effect?.target?.closest('#memorySection'))");
 await finish();
 await check('detailStaysInsideTheOriginalRightContentColumn',"(()=>{const d=document.querySelector('.memory-detail').getBoundingClientRect(),c=$('setContent').getBoundingClientRect(),n=memoryFixture.nav.getBoundingClientRect();return d.left>=c.left-1&&d.right<=c.right+1&&d.left>n.right&&d.top>=c.top-1&&document.documentElement.scrollWidth<=innerWidth})()");
 await check('detailRendersMarkdownWithoutExecutingHtmlOrShowingFrontmatter',"!!document.querySelector('#dpMemoryPreview h1')&&!!document.querySelector('#dpMemoryPreview pre code')&&!document.querySelector('#dpMemoryPreview img')&&window.__memoryXss===undefined&&!$('dpMemoryPreview').textContent.includes('type: reference')");
 await check('healthyDetailHasNoHealthBanner',"document.querySelector('[data-memory-detail-health]').hidden&&document.querySelector('[data-memory-detail-health]').textContent===''");
 await check('sourceEvidenceIsCollapsedAndRenderedAsText',"!document.querySelector('[data-memory-sources]').hidden&&!document.querySelector('[data-memory-sources]').open&&document.querySelector('[data-memory-sources] summary').textContent==='来源（2）'&&document.querySelector('[data-memory-source-items]').textContent.includes('请保留验证结果。<img')&&!document.querySelector('[data-memory-source-items] img')&&window.__memorySourceXss===undefined");
 await click('[data-memory-sources] summary');await click('[data-memory-source-items] button');await waitFor("$('appToast').textContent.includes('原对话已不存在')");
 await check('deletedSourceKeepsItsEvidenceAndDetail',"memoryFixture.sourceLoads===1&&document.querySelector('.memory-detail').dataset.memoryFile==='note-6.md'&&document.querySelector('[data-memory-source-items]').textContent.includes('请保留验证结果')");
 await capture('memory-provenance');await click('[data-memory-sources] summary');
  await check("memoryDetailPreservesGeneralDraftWithoutNativeMemoryControls","$('set-theme').dataset.value==='dark'&&!document.querySelector('[data-general-row=sdkMemoryMode],[data-general-row=sdkAutoDreamEnabled]')&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkMemoryMode')");
 await check('readModeOffersALocalBackAndEditWithoutGlobalSaveFooter',"!!document.querySelector('[data-memory-back]')&&!!$('memViewToggle')&&getComputedStyle(settingsFooterEl).display==='none'");
 await capture('memory-detail');
 await click('#memOpenLocal');await check('localOpenTargetsTheViewedMemory','memoryFixture.reveals.at(-1)===\'note-6.md\'');
 await click('#memViewToggle');await act("$('dpEditor').value='# 编辑后的记忆\\n\\n只保留确认后的内容';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await settle();
 await check('sourceNavigationIsHiddenWhileEditing',"document.querySelector('[data-memory-sources]').hidden");
 await check('editingUsesTheSameColumnWithLivePreview',"document.querySelector('#dpMemoryLivePreview h1')?.textContent==='编辑后的记忆'&&!!document.querySelector('[data-memory-save]')&&getComputedStyle(settingsFooterEl).display==='none'&&memoryFixture.writes.length===0");
 await click('[data-memory-cancel]');
 await check('cancelEditRestoresSavedContentWithoutWriting',"$('dpMemorySource').classList.contains('hidden')&&$('dpMemoryPreview').textContent.includes('项目研究记录 7')&&!$('dpMemoryPreview').textContent.includes('编辑后的记忆')&&memoryFixture.writes.length===0");
 await click('#memViewToggle');await act("$('dpEditor').value='# 保存后的记忆';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));memoryFixture.failWrite=true;");
 await click('[data-memory-save]');await waitFor("document.querySelector('[data-memory-status]')?.textContent.includes('合成保存失败')");
 await check('failedSaveKeepsAnEditableDraftAndAllowsRetry',"!$('dpMemorySource').classList.contains('hidden')&&$('dpEditor').value==='# 保存后的记忆'&&!document.querySelector('[data-memory-save]').disabled");
 await act('memoryFixture.failWrite=false;');await click('[data-memory-save]');await waitFor("$('dpMemorySource').classList.contains('hidden')");
 await check('successfulSaveRefreshesOnlyTheViewedMemory',"memoryFixture.files['note-6.md']==='# 保存后的记忆'&&$('dpMemoryPreview').textContent.includes('保存后的记忆')&&workspaceFixture.settingsWrites.length===0&&workspaceFixture.brandWrites.length===0");
  await check('editingPassesTheReadRevisionAndReceivesANewConfirmedRevision',"memoryFixture.writes.filter(entry=>entry.file==='note-6.md').every(entry=>entry.revision===memoryFixture.initialRevisions['note-6.md'])&&memoryFixture.revisions['note-6.md']!==memoryFixture.initialRevisions['note-6.md']");
 await click('[data-memory-back]');await finish();
  await check("returnRestoresRelayMemoryListAndPreservesGeneralDraft","document.querySelectorAll('#memorySection .dp-item').length===24&&$('set-theme').dataset.value==='dark'&&!document.querySelector('[data-general-row=sdkMemoryMode],[data-general-row=sdkAutoDreamEnabled]')&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkMemoryMode')");
 await check('returnRestoresOriginalListAndItsScrollPosition',"$('memorySection').querySelector('[data-list]')===memoryFixture.list&&Math.abs($('setContent').scrollTop-memoryFixture.scroll)<=2&&!document.querySelector('.memory-detail:not([hidden])')");
 await click('[data-mem-index]');await waitFor("$('dpMemoryPreview').textContent.includes('记忆索引')");await finish();
 await check('indexUsesTheSameLocalReadOnlySurface',"document.querySelector('.set-nav')===memoryFixture.nav&&!!document.querySelector('.memory-detail')&&!$('memViewToggle')&&$('dpEditor').readOnly&&!document.querySelector('[data-memory-save]:not([hidden])')&&getComputedStyle(settingsFooterEl).display==='none'");
 await capture('memory-index');await click('[data-memory-back]');await finish();
 await act("memoryFixture.files['MEMORY.md']='# 更新后的索引';");await click('[data-mem-index]');await waitFor("$('dpMemoryPreview').textContent.includes('更新后的索引')");
 await check('reopenedIndexReadsTheLatestDerivedContent',"$('dpMemoryPreview').textContent.includes('更新后的索引')");await click('[data-memory-back]');await finish();
 await act("memoryFixture.files['note-6.md']='# 本地编辑后的记忆';void renderMemoryEditor('note-6.md','项目研究记录 7');");await waitFor("$('dpMemoryPreview').textContent.includes('本地编辑后的记忆')");
 await check('reopenedMemoryReflectsEditsMadeOutsideRelay',"$('dpMemoryPreview').textContent.includes('本地编辑后的记忆')");await click('[data-memory-back]');await finish();

 // A previous read must never publish into a replacement detail or another settings category.
 await act("memoryFixture.holdRead=true;void renderMemoryEditor('note-2.md','迟到的旧详情');");await waitFor('memoryFixture.pendingReads.length===1');
 await click('[data-memory-back]');await finish();await act("memoryFixture.holdRead=false;void renderMemoryEditor('note-3.md','当前详情');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 4')");
 await act('memoryFixture.resolveRead();');await finish();
 await check('lateReadCannotReplaceTheNewDetail',"$('dpMemoryPreview').textContent.includes('项目研究记录 4')&&!$('dpMemoryPreview').textContent.includes('项目研究记录 3')");
 await click('#memViewToggle');await act("$('dpEditor').value='# 暂存的编辑草稿';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");
 await click('.set-nav-item[data-cat=general]');await check('otherSettingsRemainUsableWhileMemoryIsOpen',"document.querySelector('.set-cat.active').dataset.cat==='general'&&!!$('set-theme')&&getComputedStyle(settingsFooterEl).display!=='none'");
 await click('.set-nav-item[data-cat=memory]');await check('returningToMemoryKeepsItsUnsavedEditor',"$('dpEditor').value==='# 暂存的编辑草稿'&&!$('dpMemorySource').classList.contains('hidden')&&getComputedStyle(settingsFooterEl).display==='none'");
 await act("memoryFixture.holdWrite=true;document.querySelector('[data-memory-save]').click();");await waitFor('memoryFixture.pendingWrites.length===1');
 await check('pendingSavePreventsDuplicateSubmissions',"document.querySelector('[data-memory-save]').disabled");
 await click('.set-nav-item[data-cat=general]');await act('memoryFixture.resolveWrite();');await settle();
 await check('lateSaveDoesNotReplaceTheSelectedSettingsPage',"document.querySelector('.set-cat.active').dataset.cat==='general'&&getComputedStyle(settingsFooterEl).display!=='none'&&$('set-theme').dataset.value==='dark'");
 await click('.set-nav-item[data-cat=memory]');await waitFor("$('dpMemorySource').classList.contains('hidden')");
 await check('savedHiddenMemoryIsReadyOnReturn',"$('dpMemoryPreview').textContent.includes('暂存的编辑草稿')&&memoryFixture.files['note-3.md']==='# 暂存的编辑草稿'");
 await click('[data-memory-back]');await finish();await act("memoryFixture.failRead=true;void renderMemoryEditor('note-8.md','项目研究记录 9');");
 await waitFor("document.querySelector('.memory-detail').textContent.includes('合成读取失败')");
 await check('readFailureLeavesNavigationAndRetryAvailable',"!!document.querySelector('[data-memory-back]')&&!!document.querySelector('[data-memory-retry]')&&document.querySelector('.set-nav')===memoryFixture.nav");
 await act('memoryFixture.failRead=false;');await click('[data-memory-retry]');await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 9')");
 await check('retryReadsTheRequestedMemory','memoryFixture.reads.at(-1)===\'note-8.md\'');
 win.setSize(780,720);await waitFor('innerWidth<=780');await act("document.documentElement.dataset.theme='dark';");await finish();
 await check('narrowDarkReadingHasNoHorizontalOverflow',"(()=>{const d=document.querySelector('.memory-detail'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()");await capture('memory-dark-narrow');
 await click('#memViewToggle');await finish();await check('narrowEditingStacksWithoutOverflow',"document.documentElement.scrollWidth<=innerWidth&&$('dpEditor').getBoundingClientRect().right<=innerWidth&&document.querySelector('[data-memory-save]').getBoundingClientRect().right<=innerWidth&&document.querySelector('[data-memory-save]').getBoundingClientRect().bottom<=innerHeight&&document.querySelector('[data-memory-cancel]').getBoundingClientRect().bottom<=innerHeight");await check('darkSaveButtonKeepsReadableTextContrast',"(()=>{const style=getComputedStyle(document.querySelector('[data-memory-save]'));const l=color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};const a=l(style.color),b=l(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5})()");await capture('memory-editor-dark-narrow');
 await click('[data-memory-cancel]');await click('[data-memory-back]');await finish();
 await checkMaintenanceGeometry('NarrowLongList','memory-maintenance-dark-narrow');
 await win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await act("void renderMemoryEditor('note-1.md','减少动态效果');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 2')");
 await check('reducedMotionRemovesThePageTransition',"matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.getAnimations().some(a=>a.effect?.target?.closest('#memorySection')&&a.playState==='running')");
 win.webContents.debugger.detach();

  await check('memoryHasNoVersionHistoryApiEntryOrPanel',"typeof window.api.memory.history==='undefined'&&typeof window.api.memory.restore==='undefined'&&!document.querySelector('[data-memory-history],[data-memory-history-list]')&&!document.querySelector('.memory-detail').textContent.includes('修改记录')");
  await capture('memory-detail-without-history');
  await click('[data-memory-back]');await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===2");
  await check('archiveTabShowsRemovedMemoriesWithoutChangingItsLabel',"document.querySelector('[data-mem-archived]').getAttribute('aria-selected')==='true'&&document.querySelector('[data-mem-archived]').textContent.includes('已移除')&&!document.querySelector('[data-mem-archived]').textContent.includes('返回记忆')&&document.querySelector('#memorySection [data-list]').textContent.includes('已移除的研究记录')");
  await capture('memory-archived-dark-narrow');
  await act('memoryFixture.failRestoreArchived=true;');await click('.dp-item[data-memory-file="deleted-note.md"] [data-memory-restore]');await waitFor("$('appToast').textContent==='合成归档恢复失败'");
  await check('failedArchiveRestorePreservesTheArchiveAndRetryActions',"!Object.hasOwn(memoryFixture.files,'deleted-note.md')&&memoryFixture.archivedItems.some(item=>item.file==='deleted-note.md')&&[...document.querySelectorAll('.dp-item[data-memory-file=\"deleted-note.md\"] button')].every(button=>!button.disabled)");
  await act('memoryFixture.failRestoreArchived=false;memoryFixture.holdRestoreArchived=true;');await click('.dp-item[data-memory-file="deleted-note.md"] [data-memory-restore]');await waitFor('memoryFixture.pendingArchiveRestores.length===1');
  await check('pendingArchiveRestoreDisablesBothActions',"[...document.querySelectorAll('.dp-item[data-memory-file=\"deleted-note.md\"] button')].every(button=>button.disabled)");
  await click('.dp-item[data-memory-file="deleted-note.md"] [data-memory-restore]');await check('pendingArchiveRestoreCannotBeSubmittedTwice','memoryFixture.restoreArchivedCalls.length===2');
  await selectMemoryTab('active');await act("void renderMemoryEditor('note-5.md','归档恢复期间保留当前详情');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 6')");await act('memoryFixture.resolveRestoreArchived();');await settle();
  await check('lateArchiveRestoreKeepsTheCurrentDetailAndSettingsDraft',"memoryFixture.files['deleted-note.md'].includes('恢复的合成归档')&&$('dpMemoryPreview').textContent.includes('项目研究记录 6')&&document.querySelector('.memory-detail-title h2').textContent==='归档恢复期间保留当前详情'&&$('set-theme').dataset.value==='dark'");
  await click('[data-memory-back]');await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===1");
  await check('archiveRestoreUsesOnlyTheCurrentArchiveIdAndRemovesTheRestoredEntry',"(()=>{const call=memoryFixture.restoreArchivedCalls.at(-1);return call.file==='deleted-note.md'&&call.archiveId==='archive-deleted-1'&&Object.keys(call).length===2&&memoryFixture.files['deleted-note.md'].includes('恢复的合成归档')&&document.querySelector('#memorySection [data-list]').textContent.includes('同名冲突样本');})()");
  await act("memoryFixture.beforeConflict=memoryFixture.files['note-0.md'];");await click('#memorySection [data-list] .dp-item button');await waitFor("$('appToast')?.textContent.includes('已有同名记忆')");
  await check('archiveConflictPreservesExistingMemoryAndRetryableArchiveRow',"memoryFixture.files['note-0.md']===memoryFixture.beforeConflict&&memoryFixture.restoreArchivedCalls.at(-1).archiveId==='archive-conflict-1'&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===1&&!document.querySelector('#memorySection [data-list] .dp-item button').disabled");
  await selectMemoryTab('active');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
  await check('returnFromArchiveIncludesTheRestoredMemoryWithoutNativeSdkPreferences',"document.querySelector('[data-mem-archived]').getAttribute('aria-selected')==='false'&&document.querySelector('#memorySection [data-list]').textContent.includes('已恢复的归档记忆')&&!document.querySelector('#general-sdkMemoryMode,[data-general-row=sdkAutoDreamEnabled]')");
  await act('memoryFixture.holdArchived=true;');await click('[data-mem-archived]');await waitFor('memoryFixture.pendingArchived.length===1');await selectMemoryTab('active');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
  await click('.set-nav-item[data-cat=general]');await act('memoryFixture.resolveArchived();');await settle();
  await check('lateArchiveReadCannotReplaceActiveListOrSelectedSettingsCategory',"document.querySelector('.set-cat.active').dataset.cat==='general'&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===25&&document.querySelector('[data-mem-archived]').getAttribute('aria-selected')==='false'&&$('set-theme').dataset.value==='dark'");

 // Maintenance remains accessible with no memories and at both supported window sizes.
 await click('.set-nav-item[data-cat=memory]');await finish();
 await act('memoryFixture.savedLayoutItems=memoryFixture.items;memoryFixture.items=[];');
 await refreshLibrary();await expandLibrary();await waitFor("!!document.querySelector('#memorySection [data-list] .dp-empty')");
 await checkMaintenanceGeometry('NarrowEmptyList','memory-maintenance-empty-narrow');
 win.setSize(1200,860);await waitFor('innerWidth>=1100');await finish();
 await checkMaintenanceGeometry('DesktopEmptyList','memory-maintenance-empty-desktop');
 await act('memoryFixture.items=memoryFixture.savedLayoutItems;delete memoryFixture.savedLayoutItems;');
 await click('[data-mem-archived]');await selectMemoryTab('active');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");

 // Health is supplied by the main process; renderer checks cover state presentation,
 // safe reason rendering, read-only rescans, and the existing editor repair path.
 await act(`memoryFixture.savedHealthItems=memoryFixture.items;
  memoryFixture.items=[
   {file:'health-yaml.md',name:'旧 YAML 格式错误',scope:'global',status:'active',health:{state:'invalid',reason:'元数据格式错误：description 引号不完整 <img src=x onerror="window.__memoryHealthXss=1">',issues:[{code:'frontmatter_invalid',message:'元数据格式错误'}],legacy:true}},
   {file:'health-project-missing.md',name:'缺少项目归属',scope:'project',status:'draft',health:{state:'invalid',reason:'项目记忆缺少 project_id，无法确定所属项目。',issues:[{code:'project_id_required',message:'缺少项目 ID'}],legacy:true}},
   {file:'health-project-valid.md',name:'合法项目记忆',type:'project',scope:'project',projectId:'project-relay',status:'active',eligible:false,health:{state:'active',reason:null,issues:[],legacy:false}},
   {file:'health-expired.md',name:'过期记忆',scope:'global',status:'expired',health:{state:'inactive',reason:'这条记忆已过期，不再参与召回。',issues:[],legacy:false}},
   {file:'health-superseded.md',name:'已替代的旧记忆',scope:'global',status:'superseded',health:{state:'inactive',reason:'这条记忆已被替代，不再参与召回。',issues:[],legacy:false}},
   {file:'health-expired-draft.md',name:'已经过期的候选',scope:'global',status:'draft',confidence:'inferred',expiresAt:'2000-01-01T00:00:00Z',health:{state:'inactive',reason:'候选已过期，不再参与召回。',issues:[],legacy:false}},
   {file:'health-retired-draft.md',name:'旧作用域的候选',scope:'retired',status:'draft',confidence:'inferred',health:{state:'inactive',reason:'旧作用域已停用。',issues:[],legacy:false}},
   {file:'health-legacy.md',name:'兼容的旧记忆',type:null,scope:'global',status:'active',health:{state:'active',reason:null,issues:[{code:'legacy_fields',message:'沿用旧格式'}],legacy:true}},
   {file:'health-inferred.md',name:'推断尚未确认',scope:'global',status:'active',confidence:'inferred',health:{state:'draft',reason:'尚未确认的推断，需要用户确认后才能使用。',issues:[],legacy:false}},
   {file:'health-type-invalid.md',name:'未知分类记忆',type:'invented',scope:'global',status:'active',health:{state:'invalid',reason:'type 必须是 user、feedback、project 或 reference。',issues:[{code:'invalid_type',message:'未知记忆类型'}],legacy:false}}
  ];
  for(const item of memoryFixture.items){memoryFixture.files[item.file]='---\\nname: '+item.name+'\\n---\\n# '+item.name;memoryFixture.revisions[item.file]='health-'+item.file;}
  memoryFixture.healthBeforeCheck={files:JSON.stringify(memoryFixture.files),items:JSON.stringify(memoryFixture.items),writes:memoryFixture.writes.length,restores:memoryFixture.restoreArchivedCalls.length,statuses:memoryFixture.statusCalls.length};`);
 await click('[data-mem-check]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===2&&document.querySelectorAll('.mem-candidate').length===1");
 await check('healthCountsSeparateUsableDraftInactiveAndInvalidMemories',"(()=>{const count=tab=>document.querySelector('[data-memory-tab='+tab+']').textContent;return /2/.test(document.querySelector('[data-count]').textContent)&&/2/.test(count('active'))&&/4/.test(count('inactive'))&&/3/.test(count('invalid'))&&document.querySelectorAll('.mem-candidate').length===1})()");
 await check('rescanReportsOnlyRepairCountWithoutWritingOrConfirmingMemories',"(()=>{const before=memoryFixture.healthBeforeCheck,summary=document.querySelector('[data-mem-check-summary]');return memoryFixture.checkCalls===2&&JSON.stringify(memoryFixture.files)===before.files&&JSON.stringify(memoryFixture.items)===before.items&&memoryFixture.writes.length===before.writes&&memoryFixture.restoreArchivedCalls.length===before.restores&&memoryFixture.statusCalls.length===before.statuses&&!summary.hidden&&summary.textContent==='3 条需修复';})()");
 await check('validProjectMemoryRemainsCompactWithoutCurrentProjectContext',"(()=>{const row=document.querySelector('.dp-item[data-memory-file=\"health-project-valid.md\"]');return row.dataset.memoryHealth==='active'&&!row.querySelector('.memory-item-health')&&!row.querySelector('[data-action=repair]')&&row.querySelector('.mem-badge').textContent==='项目'&&row.textContent.includes('项目：Relay');})()");
 await check('legacyCompatibleMemoryStaysCompactAndUnclassifiedWithoutNewApproval',"(()=>{const row=document.querySelector('.dp-item[data-memory-file=\"health-legacy.md\"]');return row.dataset.memoryHealth==='active'&&!row.querySelector('.memory-item-health')&&!row.textContent.includes('旧格式兼容')&&!row.querySelector('[data-action=approve]')&&row.querySelector('.mem-badge').textContent==='未分类';})()");
 await selectMemoryTab('inactive');
 await check('inactiveDraftsRemainInInactiveLibraryAndDoNotInflatePendingCount',"['health-expired-draft.md','health-retired-draft.md'].every(file=>!!document.querySelector('.dp-item[data-memory-file=\"'+file+'\"]')&&!document.querySelector('.mem-candidate[data-memory-file=\"'+file+'\"]'))&&document.querySelectorAll('.mem-candidate').length===1&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===4&&document.querySelector('[data-memory-tab=inactive] .mem-count').textContent==='4'");
 await check('expiredAndSupersededMemoriesShowInactiveReasons',"['health-expired.md','health-superseded.md'].every(file=>{const row=document.querySelector('.dp-item[data-memory-file=\"'+file+'\"]');return row.dataset.memoryHealth==='inactive'&&row.textContent.includes(file.includes('superseded')?'已替代':'过期');})");
 await selectMemoryTab('invalid');
 await check('invalidRowsShowBothYamlAndMissingProjectReasonsSafely',"(()=>{const yaml=document.querySelector('.dp-item[data-memory-file=\"health-yaml.md\"]'),missing=document.querySelector('.dp-item[data-memory-file=\"health-project-missing.md\"]');return yaml.dataset.memoryHealth==='invalid'&&yaml.textContent.includes('description 引号不完整')&&yaml.textContent.includes('<img')&&!yaml.querySelector('img')&&window.__memoryHealthXss===undefined&&missing.textContent.includes('缺少 project_id')&&!!yaml.querySelector('[data-action=repair]')&&!!missing.querySelector('[data-action=repair]');})()");
 await check('unknownTypeStillShowsItsRepairReason',"(()=>{const row=document.querySelector('.dp-item[data-memory-file=\"health-type-invalid.md\"]');return row.dataset.memoryHealth==='invalid'&&row.textContent.includes('type 必须是')&&!!row.querySelector('[data-action=repair]')&&row.querySelector('.mem-badge').textContent==='未分类';})()");
 await act("void renderMemoryEditor('health-legacy.md','兼容的旧记忆');");await waitFor("document.querySelector('.memory-detail').dataset.memoryFile==='health-legacy.md'&&document.querySelector('.memory-detail').getAttribute('aria-busy')==='false'");
 await check('legacyCompatibleDetailHasNoHealthBanner',"document.querySelector('[data-memory-detail-health]').hidden&&document.querySelector('[data-memory-detail-health]').textContent===''");
 await click('[data-memory-back]');await finish();
 await check('invalidDraftStaysInRepairListWithoutApprovalAction',"(()=>{const row=document.querySelector('.dp-item[data-memory-file=\"health-project-missing.md\"]');return !!row?.querySelector('[data-action=repair]')&&!row.querySelector('[data-memory-approve],[data-action=approve]')&&!document.querySelector('.mem-candidate[data-memory-file=\"health-project-missing.md\"]')})()");
 await reviewCandidate('health-inferred.md');
 await check('inferredActiveCanBeReviewedButRemainsUnconfirmed',"!document.querySelector('.mem-candidate[data-memory-file=\"health-inferred.md\"] [data-memory-approve]').disabled&&memoryFixture.statusCalls.length===memoryFixture.healthBeforeCheck.statuses");
 await capture('memory-health-check');
 await click('.dp-item[data-memory-file=\"health-yaml.md\"] [data-action=repair]');await waitFor("document.querySelector('.memory-detail').dataset.memoryEditing==='true'");
 await check('repairOpensExistingMarkdownEditorWithSafeFailureReason',"document.querySelector('.memory-detail').dataset.memoryFile==='health-yaml.md'&&!$('dpMemorySource').classList.contains('hidden')&&$('dpEditor').value===memoryFixture.files['health-yaml.md']&&document.querySelector('[data-memory-detail-health]').textContent.includes('description 引号不完整')&&!document.querySelector('[data-memory-detail-health] img')&&window.__memoryHealthXss===undefined");
 await act("$('dpEditor').value='# 已修复的记忆';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await click('[data-memory-save]');await waitFor("$('dpMemorySource').classList.contains('hidden')&&!document.querySelector('.memory-detail').getAttribute('aria-busy').includes('true')");
 await check('savedRepairRefreshesHealthAndRemovesTheDetailBanner',"document.querySelector('[data-memory-detail-health]').dataset.memoryHealth==='active'&&document.querySelector('[data-memory-detail-health]').hidden&&document.querySelector('[data-memory-detail-health]').textContent===''&&memoryFixture.reads.filter(file=>file==='health-yaml.md').length===2");
 await click('[data-memory-back]');await finish();
 await check('savedRepairRemovesTheListHealthRowAndRefreshesTheCount',"document.querySelector('[data-mem-check-summary]').textContent==='2 条需修复'&&!document.querySelector('.dp-item[data-memory-file=\"health-yaml.md\"] .memory-item-health')");
 await act("memoryFixture.projectCheck={available:false,reason:'项目列表暂不可用，项目归属检查尚未完成。'};");await click('[data-mem-check]');
 await check('unavailableProjectCatalogUsesAShortCheckSummary',"document.querySelector('[data-mem-check-summary]').textContent==='2 条需修复 · 项目归属检查未完成，请重试'&&document.querySelector('[data-mem-check-summary]').dataset.warning==='true'");
 await act('memoryFixture.holdCheck=true;');await click('[data-mem-check]');await waitFor('memoryFixture.pendingChecks.length===1');
 await check('pendingCheckCannotBeSubmittedTwice',"document.querySelector('[data-mem-check]').disabled");
 await click('[data-mem-archived]');await waitFor("document.querySelector('[data-mem-archived]').getAttribute('aria-selected')==='true'");await act('memoryFixture.resolveCheck();');await settle();
 await check('lateCheckCannotReplaceTheArchiveView',"document.querySelector('[data-mem-archived]').getAttribute('aria-selected')==='true'&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===1&&document.querySelector('[data-mem-check-summary]').hidden");
 await act('memoryFixture.items=memoryFixture.savedHealthItems;delete memoryFixture.savedHealthItems;delete memoryFixture.projectCheck;');await selectMemoryTab('active');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
 await act("const item=memoryFixture.items[8];item.status='draft';item.confidence='inferred';item.health={state:'draft',reason:'等待用户确认',issues:[]};item.replaces=[{file:'note-1.md',revision:memoryFixture.revisions['note-1.md']},{file:'note-2.md',revision:memoryFixture.revisions['note-2.md']}];");
 await click('[data-mem-check]');await waitFor("!!document.querySelector('.mem-candidate[data-memory-file=\"note-8.md\"] [data-memory-review]')");
 await reviewCandidate('note-8.md');
 await check('mergeApprovalNamesTheNumberOfReplacedMemories',"document.querySelector('.mem-candidate[data-memory-file=\"note-8.md\"] [data-memory-approve]').textContent.includes('2')");
 await act("void renderMemoryEditor('note-8.md','合成归并候选');");await waitFor("document.querySelector('.memory-detail').dataset.memoryFile==='note-8.md'&&document.querySelector('.memory-detail').getAttribute('aria-busy')==='false'");
 await check('mergeDetailShowsTargetsBeforeApproval',"!document.querySelector('[data-memory-replaces]').hidden&&document.querySelector('[data-memory-replaces]').textContent==='确认后将替代：note-1.md、note-2.md'");
 await click('[data-memory-back]');await reviewCandidate('note-8.md');await act("memoryFixture.beforeMergeApproval=memoryFixture.revisions['note-8.md'];");await click('.mem-candidate[data-memory-file=\"note-8.md\"] [data-memory-approve]');
 await check('mergeApprovalUsesTheCandidateRevision',"memoryFixture.statusCalls.at(-1).file==='note-8.md'&&memoryFixture.statusCalls.at(-1).revision===memoryFixture.beforeMergeApproval");
 // Keep the original library size for the remaining archive/cache isolation checks.
 await act("for(const file of ['note-1.md','note-2.md']){const item=memoryFixture.items.find(item=>item.file===file);item.status='active';item.health={state:'active',reason:null,issues:[]};}");await refreshLibrary();await expandLibrary();
 await act("memoryFixture.archivedItems.push({file:'purge-note.md',meta:{name:'删除样本 <img src=x onerror=window.__purgeXss=1>',description:'待永久删除的合成记忆'},archiveId:'purge-archive-1'});");
 await click('[data-mem-archived]');await waitFor("!!document.querySelector('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]')");
 await check('archiveOffersRestoreAndPermanentDelete',"document.querySelectorAll('.dp-item[data-memory-file=\"purge-note.md\"] button').length===2&&!document.querySelector('.dp-item[data-memory-file=\"purge-note.md\"] img')");
 await click('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]');await waitFor("!!document.querySelector('.confirm-dialog')");
 await check('permanentDeleteExplainsScopeAndKeepsUntrustedNamesAsText',"document.querySelector('.confirm-message').textContent.includes('恢复数据')&&!document.querySelector('.confirm-message').textContent.includes('版本')&&document.querySelector('.confirm-message').textContent.includes('无法恢复')&&document.querySelector('.confirm-message').textContent.includes('原始聊天记录会保留')&&!document.querySelector('.confirm-dialog img')&&window.__purgeXss===undefined");
 await click('.confirm-btn.cancel');await check('cancelPermanentDeleteDoesNotCallHost',"memoryFixture.purgeCalls.length===0&&!document.querySelector('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]').disabled");
 await act('memoryFixture.failPurge=true;');await click('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]');await click('.confirm-btn.danger');await waitFor("$('appToast').textContent==='合成删除失败'");
 await check('failedPermanentDeletePreservesARetryableArchiveEntry',"memoryFixture.archivedItems.some(item=>item.file==='purge-note.md')&&[...document.querySelectorAll('.dp-item[data-memory-file=\"purge-note.md\"] button')].every(button=>!button.disabled)");
 await act('memoryFixture.failPurge=false;memoryFixture.holdPurge=true;');await click('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]');await click('.confirm-btn.danger');await waitFor('memoryFixture.pendingPurges.length===1');
 await check('pendingPermanentDeleteDisablesRestoreAndDuplicateSubmission',"[...document.querySelectorAll('.dp-item[data-memory-file=\"purge-note.md\"] button')].every(button=>button.disabled)&&memoryFixture.purgeCalls.length===2");
 await click('.dp-item[data-memory-file=\"purge-note.md\"] [data-memory-purge]');await check('disabledDeleteDoesNotRepeatTheRequest','memoryFixture.purgeCalls.length===2');
 await act('memoryFixture.resolvePurge();');await waitFor("!document.querySelector('.dp-item[data-memory-file=\"purge-note.md\"]')");
 await check('successfulPermanentDeleteUsesArchiveIdAndRefreshesOnlyItsRow',"memoryFixture.purgeCalls.at(-1).archiveId==='purge-archive-1'&&memoryFixture.purgeCalls.at(-1).file==='purge-note.md'&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===1");
 await selectMemoryTab('active');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
 await act("void renderMemoryEditor('note-5.md','验证已删除缓存');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 6')");
 await click('[data-memory-back]');await act("memoryFixture.missingReads=['note-5.md'];void renderMemoryEditor('note-5.md','验证已删除缓存');");await waitFor("document.querySelector('[data-memory-status]').textContent==='记忆文件不存在'");
 await check('missingMemoryClearsOldBodyAndSourcesInsteadOfShowingCachedText',"!$('dpMemoryPreview').textContent.includes('项目研究记录 6')&&$('dpEditor').value===''&&$('memViewToggle').disabled&&document.querySelector('[data-memory-sources]').hidden");
 await click('[data-memory-back]');await act('memoryFixture.missingReads=[];');
 if(await evaluate("/^Win/i.test(navigator.platform||'')")){
  await act("memoryFixture.files['CACHE.MD']='# 即将永久删除';memoryFixture.revisions['CACHE.MD']='cache-revision';void renderMemoryEditor('CACHE.MD','大小写别名');");await waitFor("$('dpMemoryPreview').textContent.includes('即将永久删除')");
  await click('#memViewToggle');await act("$('dpEditor').value='# 不能在删除后保留的草稿';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await click('[data-memory-back]');
  await act("delete memoryFixture.files['CACHE.MD'];memoryFixture.missingReads=['CACHE.MD'];memoryFixture.archivedItems.push({file:'cache.md',meta:{name:'大小写别名'},archiveId:'cache-archive'});");
  await click('[data-mem-archived]');await waitFor("!!document.querySelector('.dp-item[data-memory-file=\"cache.md\"]')");await click('.dp-item[data-memory-file=\"cache.md\"] [data-memory-purge]');await click('.confirm-btn.danger');await waitFor("!document.querySelector('.dp-item[data-memory-file=\"cache.md\"]')");
  await selectMemoryTab('active');await act("void renderMemoryEditor('CACHE.MD','删除后的别名');");await waitFor("document.querySelector('[data-memory-status]').textContent==='记忆文件不存在'");
  await check('permanentDeleteForgetsWindowsAliasesAndTheirUnsavedCachedDraft',"memoryFixture.reads.filter(file=>file==='CACHE.MD').length===2&&$('dpEditor').value===''&&!$('dpMemoryPreview').textContent.includes('不能在删除后保留的草稿')&&$('memViewToggle').disabled");
  await click('[data-memory-back]');await act('memoryFixture.missingReads=[];');
 }
 await check('allActivityRemainsLocalAndRendererHasNoErrors',"uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'&&workspaceFixture.settingsWrites.length===0&&workspaceFixture.brandWrites.length===0&&inputEl.value==='保留对话草稿'");
 step='completed';save();clearTimeout(timeout);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));try{if(win&&!win.isDestroyed()){diagnostics.errors=await evaluate('uiFixture.errors');await capture('failure');}}catch(_){}save();console.error(error.stack);clearTimeout(timeout);app.exit(1);});
