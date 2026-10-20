'use strict';
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.codex-tmp/idle-stall-2026-10-13');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'history-lazy-profile'));app.commandLine.appendSwitch('disable-gpu');
let win;const result={checks:{},errors:[]};const save=()=>fs.writeFileSync(path.join(out,'activity-history-lazy-smoke.json'),JSON.stringify(result,null,2));
const deadline=setTimeout(()=>{result.errors.push('90-second fixture timeout');save();app.exit(1)},90000);
async function runChecks(){
 const checks=window.historyLazyChecks={};const check=(name,value)=>{checks[name]=!!value;if(!value)throw Error(name)};
 const A=RelayActivity,host=document.createElement('div');document.body.append(host);
 const state=(phase='complete',suffix='')=>A.createState({phase,items:[
  {id:'read'+suffix,type:'tool',toolName:'Read',toolUseId:'read'+suffix,title:'Read synthetic data',status:phase==='running'?'running':'success',input:{file_path:'synthetic.txt'},result:('Exact original result '+suffix+'\n').repeat(200)},
  {id:'note'+suffix,type:'narration',status:'success',result:'Visible synthetic narration '+suffix},
 ]});
 const old=state(),el=A.createElement(old,{collapsed:true,deferCollapsed:true});host.append(el);
 check('completed collapsed history creates summary without rows',el.querySelectorAll('.process-item').length===0&&el._processItemsDeferred);
 check('complete original state retained',el._processState.items[0].result===old.items[0].result&&el._processState.items.length===2);
 const newer=state();newer.items[0].result='Updated result before first expansion';A.updateElement(el,newer);
 check('updates before first expansion remain deferred',el.querySelectorAll('.process-item').length===0);
 el.querySelector('.process-summary').click();
 check('first expansion mounts all items',el.querySelectorAll('.process-item').length===2&&!el._processItemsDeferred);
 const row=el.querySelector('[data-process-id="read"]');row.click();await new Promise(r=>setTimeout(r,320));
 check('inspector keeps exact newest content for selection and copy',row.querySelector('.is-result .process-inspect-code').textContent==='Updated result before first expansion');
 check('inspector is interactive',row.classList.contains('is-expanded')&&row.getAttribute('aria-expanded')==='true'&&!row.querySelector('.process-inspector').inert);
 const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(row.querySelector('.is-result .process-inspect-code'));selection.removeAllRanges();selection.addRange(range);
 check('copy selection retains full detail text',String(selection)==='Updated result before first expansion');selection.removeAllRanges();
 el.querySelector('.process-summary').click();el.querySelector('.process-summary').click();
 check('fold reopen preserves row identity and inspector expansion',row===el.querySelector('[data-process-id="read"]')&&row.classList.contains('is-expanded'));
 const resumed=A.createElement(state(),{collapsed:true,deferCollapsed:true});host.append(resumed);
 const resumedState=state('running');resumedState.items.push({id:'new-live',type:'narration',status:'running',result:'Latest event after resume'});A.updateElement(resumed,resumedState);
 check('resumed live process mounts without waiting for click',resumed.querySelectorAll('.process-item').length===3&&!resumed._processItemsDeferred);
 check('resumed process includes newest event',resumed.textContent.includes('Latest event after resume'));
 const live=A.createElement(state('running'),{collapsed:true,deferCollapsed:true});host.append(live);
 check('active streams never defer their rows',live.querySelectorAll('.process-item').length===2&&!live._processItemsDeferred);
 const noOpt=A.createElement(state(),{collapsed:true});host.append(noOpt);
 check('existing callers keep eager rendering unless explicitly opted in',noOpt.querySelectorAll('.process-item').length===2);
 const groupHost=document.createElement('div');document.body.append(groupHost);
 const p=A.createElement(state('complete','p'),{collapsed:true,deferCollapsed:true,taskKey:'same-task',segment:'previous'}),q=A.createElement(state('complete','q'),{collapsed:true,deferCollapsed:true,taskKey:'same-task'});
 groupHost.append(p);A.syncTaskSummary(p);groupHost.append(q);A.syncTaskSummary(q);
 check('all restored paused segments initially defer',p.querySelectorAll('.process-item').length===0&&q.querySelectorAll('.process-item').length===0);
 p.querySelector('.process-summary').click();
 check('one task header mounts every linked segment on expansion',p.querySelectorAll('.process-item').length===2&&q.querySelectorAll('.process-item').length===2&&!p.classList.contains('is-collapsed')&&!q.classList.contains('is-collapsed'));
 const autoHost=document.createElement('div');document.body.append(autoHost);
 const first=A.createElement(state('complete','first'),{collapsed:true,deferCollapsed:true,taskKey:'auto-task',segment:'previous'}),last=A.createElement(state('complete','last'),{collapsed:true,deferCollapsed:true,taskKey:'auto-task'});
 autoHost.append(first);A.syncTaskSummary(first);autoHost.append(last);A.syncTaskSummary(last);A.updateElement(last,state('running','last'));
 check('automatic resumed group expansion mounts previously deferred segments',first.querySelectorAll('.process-item').length===2&&last.querySelectorAll('.process-item').length===2&&!first.classList.contains('is-collapsed')&&!last.classList.contains('is-collapsed'));
 const saved={id:'lazy-history-search',title:'Synthetic search',model:'opus',turns:[{runId:'saved-run',ts:'2026-10-13T01:00:00Z',user:'Saved user text',assistant:'Saved searchable answer',status:'complete',activity:A.serialize(state())}]};
 await window.api.history.save(saved);await loadConversation(saved.id,{turnIndex:0,side:'assistant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 check('history search still locates final answer',!!messagesEl.querySelector('.message.assistant[data-turn="0"].search-hit'));
 check('history search leaves unrelated process deferred',messagesEl.querySelectorAll('.process-item').length===0);
 check('historical final answer stays visible',messagesEl.textContent.includes('Saved searchable answer'));
 host.remove();groupHost.remove();autoHost.remove();return checks;
}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:/^https?:/i.test(d.url)}));
 const fixture=fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8');
 const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+'</script>');
 const page=path.join(out,'history-lazy-fixture.html');fs.writeFileSync(page,html);
 win=new BrowserWindow({width:1200,height:850,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});await win.loadFile(page);win.showInactive();
 await win.webContents.executeJavaScript("new Promise((resolve,reject)=>{let n=0;const tick=()=>{if(typeof providerRoutingLoaded!=='undefined'&&providerRoutingLoaded&&!restoringActiveRuns)return resolve();if(++n>500)return reject(Error('boot'));setTimeout(tick,20)};tick()})");
 result.checks=await win.webContents.executeJavaScript('('+runChecks.toString()+')()');result.errors=await win.webContents.executeJavaScript('uiFixture.errors');result.ok=!result.errors.length&&Object.values(result.checks).every(Boolean);save();clearTimeout(deadline);win.destroy();app.exit(result.ok?0:1);
}).catch(async e=>{result.errors.push(e.stack);try{result.checks=await win?.webContents.executeJavaScript('window.historyLazyChecks||{}')}catch(_){}save();clearTimeout(deadline);win?.destroy();app.exit(1)});
