'use strict';
// Full production renderer with isolated synthetic memory. No Relay main process or model calls.
const {app, BrowserWindow, session}=require('electron');
const fs=require('node:fs'), path=require('node:path'), {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'), output=path.join(root,'.codex-tmp/settings-direct-sections-memory');
fs.mkdirSync(output,{recursive:true}); app.setPath('userData',path.join(output,'profile')); app.commandLine.appendSwitch('disable-gpu');
let win,step='starting'; const checks={},failures=[],diagnostics={};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({step,checks,failures,diagnostics},null,2));
const timeout=setTimeout(()=>{failures.push('Timeout: '+step);save();app.exit(1);},120000);
const evaluate=code=>win.webContents.executeJavaScript(code), act=code=>evaluate(`(()=>{${code}\n})()`);
async function settle(){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function finish(){await act("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});");await settle();}
async function waitFor(code){await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(next,20)}next()})`);}
async function click(selector){await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`);await settle();}
async function check(name,code){step=name;checks[name]=!!await evaluate(code);save();if(!checks[name])throw Error(name);}
async function capture(name){await finish();fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function checkMaintenanceGeometry(label,screenshot){
 const previousScroll=await evaluate("$('setContent').scrollTop");
 await act("document.querySelector('#memorySection .memory-maintenance').scrollIntoView({block:'end',behavior:'instant'});");await finish();
 await act(`memoryFixture.maintenanceGeometry=(()=>{
  const list=document.querySelector('#memorySection [data-list]'),maintenance=document.querySelector('#memorySection .memory-maintenance'),heading=maintenance.querySelector('.mem-auto-heading'),panel=maintenance.querySelector('[data-mem-auto-panel]'),content=$('setContent');
  const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const a=rect(list),b=rect(maintenance),h=rect(heading),p=rect(panel),c=rect(content),rows=[...panel.querySelectorAll('.set-row')].map(rect);
  const labels=[...panel.querySelectorAll('.set-row > .set-label')].map(node=>{const range=document.createRange();range.selectNodeContents(node);const lines=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);return {...rect(node),text:node.textContent.trim(),lineCount:new Set(lines.map(r=>Math.round(r.top*100)/100)).size};});
  const controls=[...panel.querySelectorAll('.memory-maintenance-controls')].map(rect);
  return {viewport:{width:innerWidth,height:innerHeight},itemCount:list.querySelectorAll('.dp-item').length,list:a,maintenance:b,heading:h,panel:p,content:c,rows,labels,controls,listToMaintenance:b.top-a.bottom,listToHeading:h.top-a.bottom,headingToPanel:p.top-h.bottom,headingText:heading.textContent.trim(),maintenanceOverflow:maintenance.scrollWidth-maintenance.clientWidth,siblingOrder:list.nextElementSibling===maintenance,headingInsideMaintenance:heading.parentElement===maintenance,panelInsideMaintenance:panel.parentElement===maintenance};
 })();`);
 diagnostics.maintenanceLayout||={};diagnostics.maintenanceLayout[label]=await evaluate('memoryFixture.maintenanceGeometry');save();
 await check(label+'MaintenanceIsSeparatedFromTheListByAtLeast24Pixels',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.siblingOrder&&g.headingInsideMaintenance&&g.panelInsideMaintenance&&g.listToMaintenance>=24&&g.listToHeading>=24&&g.listToHeading<=48})()");
 await check(label+'MaintenanceHeadingAndPanelHaveClearNonoverlappingSpacing',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.headingText==='自动整理与维护'&&g.heading.height>=14&&g.heading.height<=48&&g.headingToPanel>=8&&g.headingToPanel<=20&&Math.abs(g.heading.left-g.panel.left)<=4&&g.rows.length===2&&g.rows.every(r=>r.height>=32&&r.top>=g.panel.top-1&&r.bottom<=g.panel.bottom+1)&&g.rows[1].top>=g.rows[0].bottom-1})()");
 await check(label+'MaintenanceContentFitsTheSettingsColumnAndIsVisible',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.maintenanceOverflow<=1&&g.panel.left>=g.content.left-1&&g.panel.right<=g.content.right+1&&g.maintenance.top>=g.content.top-1&&g.maintenance.bottom<=g.content.bottom+1&&g.maintenance.bottom<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth})()");
 await check(label+'MaintenanceLabelsUseAtMostTwoReadableLines',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.labels.length===2&&g.labels.every(label=>label.width>=28&&label.lineCount>=1&&label.lineCount<=2)})()");
 await check(label+'MaintenanceControlsReflowBelowNarrowLabels',"(()=>{const g=memoryFixture.maintenanceGeometry;return g.controls.length===2&&g.controls.every((control,i)=>control.width>0&&control.left>=g.panel.left-1&&control.right<=g.panel.right+1&&control.top>=g.rows[i].top-1&&control.bottom<=g.rows[i].bottom+1&&(g.panel.width<=620?control.top>=g.labels[i].bottom-1:control.top<g.labels[i].bottom&&control.bottom>g.labels[i].top))})()");
 await capture(screenshot);
 await act(`$('setContent').scrollTop=${previousScroll};`);await settle();
}
function installFixture(){
 const base=window.api,state=window.memoryFixture={reads:[],writes:[],pendingReads:[],pendingWrites:[],holdRead:false,holdWrite:false,failRead:false,failWrite:false,files:{},reveals:[],revisions:{},initialRevisions:{},readRevisions:{},historyCalls:[],restoreCalls:[],pendingHistories:[],pendingRestores:[],pendingArchived:[],holdHistory:false,holdRestore:false,holdArchived:false};
 let revision=0;const bump=file=>(state.revisions[file]=(++revision).toString(16).padStart(64,'0'));
 state.items=Array.from({length:24},(_,i)=>({file:`note-${i}.md`,name:`项目研究记录 ${i+1}`,description:'用于验证记忆列表、详情和编辑之间的连续切换。',type:i%2?'project':'reference',scope:'global',status:'active'}));
 for(const item of state.items){state.files[item.file]='---\nname: '+item.name+'\ntype: reference\n---\n# '+item.name+'\n\n本地资料中的研究结论。\n\n'+Array.from({length:16},(_,i)=>`## 记录 ${i+1}\n\n记忆正文应该只在右侧内容区阅读，并保留完整的设置导航。`).join('\n\n')+'\n\n<img src=x onerror="window.__memoryXss=1">\n\n```js\nconst source = "安全展示源码";\n```';bump(item.file);}
 state.files['MEMORY.md']='# 记忆索引\n\n'+state.items.map(x=>`- ${x.name}：${x.file}`).join('\n');bump('MEMORY.md');state.initialRevisions={...state.revisions};
 state.archivedItems=[{file:'deleted-note.md',meta:{name:'已移除的研究记录',description:'可恢复的合成归档'},versionId:'archive-deleted-v1',createdAt:'2026-09-12T01:00:00Z'},{file:'note-0.md',meta:{name:'同名冲突样本',description:'已有同名记忆时必须拒绝恢复'},versionId:'archive-conflict-v1',createdAt:'2026-09-12T02:00:00Z'}];
 const readResult=file=>{state.readRevisions[file]=state.revisions[file];return {ok:true,content:state.files[file]||'',revision:state.revisions[file]};};
 const writeResult=entry=>{if(entry.revision!==state.revisions[entry.file])return {ok:false,message:'合成修订冲突'};state.files[entry.file]=entry.content;return {ok:true,revision:bump(entry.file)};};
 const historyResult=file=>({ok:true,items:[{file,versionId:'history-'+file+'-v1',createdAt:'2026-09-11T01:00:00Z',operation:'write'},{file,versionId:'history-'+file+'-created',createdAt:'2026-09-10T01:00:00Z',operation:'create'}]});
 const restoreResult=entry=>{if(entry.revision===null&&Object.hasOwn(state.files,entry.file))return {ok:false,message:'已有同名记忆，未覆盖'};if(entry.revision!==null&&entry.revision!==state.revisions[entry.file])return {ok:false,message:'合成修订冲突'};state.files[entry.file]='# 恢复的合成版本 '+entry.file;state.archivedItems=state.archivedItems.filter(item=>item.file!==entry.file);if(!state.items.some(item=>item.file===entry.file))state.items.push({file:entry.file,name:'已恢复的归档记忆',description:'恢复后的合成资料',scope:'global',status:'active'});return {ok:true,revision:bump(entry.file)};};
 state.resolveRead=()=>{state.holdRead=false;for(const p of state.pendingReads.splice(0))p.resolve(readResult(p.file));};
 state.resolveWrite=()=>{state.holdWrite=false;for(const p of state.pendingWrites.splice(0))p.resolve(writeResult(p));};
 state.resolveHistory=()=>{state.holdHistory=false;for(const p of state.pendingHistories.splice(0))p.resolve(historyResult(p.file));};
 state.resolveRestore=()=>{state.holdRestore=false;for(const p of state.pendingRestores.splice(0))p.resolve(restoreResult(p));};
 state.resolveArchived=()=>{state.holdArchived=false;for(const p of state.pendingArchived.splice(0))p.resolve({ok:true,items:structuredClone(state.archivedItems)});};
 const memory={
  list:async()=>({ok:true,items:state.items.map(item=>({...item,revision:state.revisions[item.file]}))}),
  read:async file=>{state.reads.push(file);if(state.failRead)throw Error('合成读取失败');if(state.holdRead)return new Promise(resolve=>state.pendingReads.push({file,resolve}));return readResult(file);},
  write:async(file,content,revision)=>{const entry={file,content,revision};state.writes.push(entry);if(state.failWrite)return {ok:false,message:'合成保存失败'};if(state.holdWrite)return new Promise(resolve=>state.pendingWrites.push({...entry,resolve}));return writeResult(entry);},
  archived:async()=>state.holdArchived?new Promise(resolve=>state.pendingArchived.push({resolve})):{ok:true,items:structuredClone(state.archivedItems)},
  history:async file=>{state.historyCalls.push(file);return state.holdHistory?new Promise(resolve=>state.pendingHistories.push({file,resolve})):historyResult(file);},
  restore:async(file,versionId,revision)=>{const entry={file,versionId,revision};state.restoreCalls.push(entry);return state.holdRestore?new Promise(resolve=>state.pendingRestores.push({...entry,resolve})):restoreResult(entry);},
  revealFile:async file=>{state.reveals.push(file);return {ok:true};},
 };
 window.api=new Proxy(base,{get(target,key){return key==='memory'?memory:target[key];}});
}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
 const fixture=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n')+`\n(${installFixture.toString()})();`;
 const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',`<head><base href="${pathToFileURL(path.join(root,'renderer')+path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
 const file=path.join(output,'fixture.html');fs.writeFileSync(file,html);
 win=new BrowserWindow({width:1200,height:860,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 await win.loadFile(file);win.showInactive();await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
 await evaluate("openSettings('general')");await act("$('set-theme').dataset.value='dark';$('set-theme').dispatchEvent(new Event('input',{bubbles:true}));memoryFixture.brandNode=$('set-theme');inputEl.value='保留对话草稿';");
 await click('.set-nav-item[data-cat=memory]');await waitFor("document.querySelectorAll('#memorySection .dp-item').length===24");await finish();
 await check('MemoryAutoOrganizationIsDirectWithoutExpandAction',"!!document.querySelector('h3.mem-auto-heading')&&!document.querySelector('[data-mem-auto-toggle]')&&!document.querySelector('[data-mem-auto-panel]').hidden&&document.querySelector('[data-mem-auto-panel]').getClientRects().length>0");
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
  await check("memoryDetailPreservesGeneralDraftWithoutNativeMemoryControls","$('set-theme').dataset.value==='dark'&&!document.querySelector('[data-general-row=sdkMemoryMode],[data-general-row=sdkAutoDreamEnabled]')&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkMemoryMode')");
 await check('readModeOffersALocalBackAndEditWithoutGlobalSaveFooter',"!!document.querySelector('[data-memory-back]')&&!!$('memViewToggle')&&getComputedStyle(settingsFooterEl).display==='none'");
 await capture('memory-detail');
 await click('#memOpenLocal');await check('localOpenTargetsTheViewedMemory','memoryFixture.reveals.at(-1)===\'note-6.md\'');
 await click('#memViewToggle');await act("$('dpEditor').value='# 编辑后的记忆\\n\\n只保留确认后的内容';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));");await settle();
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

  await click('[data-memory-history]');await waitFor("document.querySelectorAll('[data-memory-history-list] .set-row').length===2");
  await check('historyRendersVersionLabelsAndAccessibleExpandedState',"document.querySelector('[data-memory-history]').getAttribute('aria-expanded')==='true'&&document.querySelector('[data-memory-history-list]').textContent.includes('编辑留档')&&document.querySelector('[data-memory-history-list]').textContent.includes('创建留档')&&memoryFixture.historyCalls.at(-1)==='note-1.md'");
  await capture('memory-history-dark-narrow');
  await click('[data-memory-history-list] .set-row button');await waitFor("!!document.querySelector('.confirm-dialog')");await click('.confirm-btn.cancel');
  await check('cancelingHistoryRestoreDoesNotWrite',"memoryFixture.restoreCalls.length===0&&$('dpMemoryPreview').textContent.includes('项目研究记录 2')");
  await act("memoryFixture.beforeHistoricalRevision=memoryFixture.revisions['note-1.md'];");
  await click('[data-memory-history-list] .set-row button');await waitFor("!!document.querySelector('.confirm-dialog')");await click('.confirm-btn.primary');
  await waitFor("$('dpMemoryPreview').textContent.includes('恢复的合成版本 note-1.md')");
  await check('historyRestorePassesViewedRevisionAndRefreshesTheConfirmedContent',"(()=>{const call=memoryFixture.restoreCalls.at(-1);return call.file==='note-1.md'&&call.versionId==='history-note-1.md-v1'&&call.revision===memoryFixture.beforeHistoricalRevision&&document.querySelector('[data-memory-history-list]').hidden&&memoryFixture.revisions['note-1.md']!==memoryFixture.beforeHistoricalRevision;})()");
  await click('#memViewToggle');await act("$('dpEditor').value='# 恢复后继续编辑';$('dpEditor').dispatchEvent(new Event('input',{bubbles:true}));memoryFixture.beforePostRestoreWrite=memoryFixture.readRevisions['note-1.md'];");await click('[data-memory-save]');await waitFor("$('dpMemorySource').classList.contains('hidden')");
  await check('editingAfterRestoreUsesTheNewReadRevision',"memoryFixture.writes.at(-1).revision===memoryFixture.beforePostRestoreWrite&&memoryFixture.files['note-1.md']==='# 恢复后继续编辑'");
  await click('[data-memory-back]');await act("void renderMemoryEditor('note-4.md','异步历史来源');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 5')");
  await act('memoryFixture.holdHistory=true;');await click('[data-memory-history]');await waitFor('memoryFixture.pendingHistories.length===1');
  await click('[data-memory-back]');await act("void renderMemoryEditor('note-5.md','另一条记忆');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 6')");await act('memoryFixture.resolveHistory();');await settle();
  await check('lateHistoryCannotPopulateAReplacementMemoryDetail',"$('dpMemoryPreview').textContent.includes('项目研究记录 6')&&document.querySelector('[data-memory-history-list]').hidden&&document.querySelector('[data-memory-history-list]').childElementCount===0");
  await click('[data-memory-back]');await act("void renderMemoryEditor('note-4.md','异步恢复来源');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 5')");await click('[data-memory-history]');await waitFor("document.querySelectorAll('[data-memory-history-list] .set-row').length===2");
  await act('memoryFixture.holdRestore=true;');await click('[data-memory-history-list] .set-row button');await waitFor("!!document.querySelector('.confirm-dialog')");await click('.confirm-btn.primary');await waitFor('memoryFixture.pendingRestores.length===1');
  await click('[data-memory-back]');await act("void renderMemoryEditor('note-5.md','保留当前详情');");await waitFor("$('dpMemoryPreview').textContent.includes('项目研究记录 6')");await act('memoryFixture.resolveRestore();');await settle();
  await check('lateRestoreUpdatesItsFileWithoutReplacingCurrentDetailOrSettingsDraft',"memoryFixture.files['note-4.md'].includes('恢复的合成版本 note-4.md')&&$('dpMemoryPreview').textContent.includes('项目研究记录 6')&&document.querySelector('.memory-detail-title h2').textContent==='保留当前详情'&&$('set-theme').dataset.value==='dark'");
  await click('[data-memory-back]');await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===2");
  await check('archiveToggleShowsRemovedMemoriesAndAReturnAction',"document.querySelector('[data-mem-archived]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-mem-archived]').textContent==='返回记忆'&&document.querySelector('#memorySection [data-list]').textContent.includes('已移除的研究记录')");
  await capture('memory-archived-dark-narrow');
  await click('#memorySection [data-list] .dp-item button');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===1");
  await check('archiveRestoreRequiresAnAbsentDestinationAndRemovesTheRestoredEntry',"(()=>{const call=memoryFixture.restoreCalls.at(-1);return call.file==='deleted-note.md'&&call.versionId==='archive-deleted-v1'&&call.revision===null&&memoryFixture.files['deleted-note.md'].includes('恢复的合成版本')&&document.querySelector('#memorySection [data-list]').textContent.includes('同名冲突样本');})()");
  await act("memoryFixture.beforeConflict=memoryFixture.files['note-0.md'];");await click('#memorySection [data-list] .dp-item button');await waitFor("$('appToast')?.textContent.includes('已有同名记忆')");
  await check('archiveConflictPreservesExistingMemoryAndRetryableArchiveRow',"memoryFixture.files['note-0.md']===memoryFixture.beforeConflict&&memoryFixture.restoreCalls.at(-1).revision===null&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===1&&!document.querySelector('#memorySection [data-list] .dp-item button').disabled");
  await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
  await check('returnFromArchiveIncludesTheRestoredMemoryWithoutNativeSdkPreferences',"document.querySelector('[data-mem-archived]').getAttribute('aria-pressed')==='false'&&document.querySelector('#memorySection [data-list]').textContent.includes('已恢复的归档记忆')&&!document.querySelector('#general-sdkMemoryMode,[data-general-row=sdkAutoDreamEnabled]')");
  await act('memoryFixture.holdArchived=true;');await click('[data-mem-archived]');await waitFor('memoryFixture.pendingArchived.length===1');await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
  await click('.set-nav-item[data-cat=general]');await act('memoryFixture.resolveArchived();');await settle();
  await check('lateArchiveReadCannotReplaceActiveListOrSelectedSettingsCategory',"document.querySelector('.set-cat.active').dataset.cat==='general'&&document.querySelectorAll('#memorySection [data-list] .dp-item').length===25&&document.querySelector('[data-mem-archived]').getAttribute('aria-pressed')==='false'&&$('set-theme').dataset.value==='dark'");

 // The separation also survives an empty library, where first-child rules used to collapse the heading margin.
 await click('.set-nav-item[data-cat=memory]');await finish();
 await act('memoryFixture.savedLayoutItems=memoryFixture.items;memoryFixture.items=[];');
 await click('[data-mem-archived]');await click('[data-mem-archived]');await waitFor("!!document.querySelector('#memorySection [data-list] .dp-empty')");
 await checkMaintenanceGeometry('NarrowEmptyList','memory-maintenance-empty-narrow');
 win.setSize(1200,860);await waitFor('innerWidth>=1100');await finish();
 await checkMaintenanceGeometry('DesktopEmptyList','memory-maintenance-empty-desktop');
 await act('memoryFixture.items=memoryFixture.savedLayoutItems;delete memoryFixture.savedLayoutItems;');
 await click('[data-mem-archived]');await click('[data-mem-archived]');await waitFor("document.querySelectorAll('#memorySection [data-list] .dp-item').length===25");
 await check('allActivityRemainsLocalAndRendererHasNoErrors',"uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'&&workspaceFixture.settingsWrites.length===0&&workspaceFixture.brandWrites.length===0&&inputEl.value==='保留对话草稿'");
 step='completed';save();clearTimeout(timeout);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));try{if(win&&!win.isDestroyed()){diagnostics.errors=await evaluate('uiFixture.errors');await capture('failure');}}catch(_){}save();console.error(error.stack);clearTimeout(timeout);app.exit(1);});
