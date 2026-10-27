'use strict';
// Isolated real activity DOM: synthetic tools, network denied, no Relay main.
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),mode=process.argv.includes('--baseline')?'baseline':'optimized';
const out=path.join(root,'.codex-tmp/v3.1.0-audit/renderer'),result={mode,checks:{},metrics:{},errors:[]};
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'activity-profile-'+mode));app.commandLine.appendSwitch('disable-gpu');
let win;const save=()=>fs.writeFileSync(path.join(out,'activity-'+mode+'.json'),JSON.stringify(result,null,2));
const timer=setTimeout(()=>{result.errors.push('timeout');save();app.exit(1)},60000);
function exercise(){
 const checks={},check=(name,value)=>{checks[name]=!!value},A=RelayActivity,host=document.getElementById('host');
 const state=A.createState({phase:'running',items:Array.from({length:1200},(_,i)=>({id:'read-'+i,type:'tool',toolName:'Read',title:'Synthetic read '+i,status:i===1199?'running':'success',input:{file_path:'synthetic/'+i},result:('original '+i+'\n').repeat(100)}))});
 const el=A.createElement(state,{collapseOnComplete:true});host.append(el);
 el.querySelector('.process-tool-group-summary').click();
 const row=el.querySelector('[data-process-id="read-0"]');row.click();
 const pre=row.querySelector('.is-result pre');pre.scrollTop=80;
 const initialScroll=pre.scrollTop;check('expandedInspectorHasScrollableResult',initialScroll>0);
 el.querySelector('.process-summary').click();
 const body=el.querySelector('.process-items'),query=body.querySelectorAll.bind(body);
 let rowScans=0,rowsVisited=0;
 body.querySelectorAll=function(selector){const found=query(selector);if(selector==='.process-item[data-process-id]'){rowScans++;rowsVisited+=found.length;}return found};
 const started=performance.now();
 for(let i=0;i<80;i++){
   state.items[1199].result='Newest tool result '+i;
   if(i%20===0)state.items.push({id:'extra-'+i,type:'status',title:'Later activity '+i,status:'success'});
   A.updateElement(el,state);
 }
 const durationMs=+(performance.now()-started).toFixed(2),collapsedScans=rowScans,collapsedRowsVisited=rowsVisited;
 check('collapsedLiveUpdatesNeverScanOldRows',rowScans===0);
 check('collapsedLiveUpdatesKeepExistingDomFrozen',query('.process-item').length===1200&&el._processItemsDeferred===true);
 check('collapsedStateRetainsEveryNewActivity',el._processState.items.length===1204&&state.items[1199].result==='Newest tool result 79');
 A.finish(state);A.updateElement(el,state);
 check('terminalSummaryUpdatesWithoutMountingHiddenRows',el.dataset.phase==='complete'&&!el.classList.contains('is-running')&&rowScans===0);
 const expandStart=performance.now(),beforeExpandScans=rowScans;el.querySelector('.process-summary').click();
 const expandMs=+(performance.now()-expandStart).toFixed(2);
 check('expansionCatchesUpExactlyOnce',rowScans===beforeExpandScans+1&&!el._processItemsDeferred&&query('.process-item').length===1204);
 check('expandedOutputIncludesLatestToolResult',el.querySelector('[data-process-id="read-1199"]').textContent.includes('Newest tool result 79'));
 check('unmodifiedInspectorRetainsNodeAndExpansion',el.querySelector('[data-process-id="read-0"]')===row&&row.classList.contains('is-expanded')&&row.querySelector('.is-result pre')===pre);
 check('reopeningRestoresInspectorScroll',pre.scrollTop===initialScroll);
 check('originalActivityOrderAndContentRemainIntact',state.items[0].result===('original 0\n').repeat(100)&&[...query('.process-item')].at(-1).dataset.processId==='extra-60');
 return{checks,metrics:{initialRows:1200,updates:80,rowsAfter:1204,collapsedScans,collapsedRowsVisited,durationMs,expandMs,initialScroll,finalScroll:pre.scrollTop}};
}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:/^https?:/i.test(d.url)}));
 win=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="host"></main></body></html>'));
 for(const file of ['styles.css','conversation-stream.css'])await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer',file),'utf8'));
 await win.webContents.insertCSS('body{display:block;height:100vh;overflow:auto}#host{width:740px;margin:32px auto}*,*::before,*::after{transition:none!important;animation:none!important}');
 await win.webContents.executeJavaScript(fs.readFileSync(mode==='baseline'?path.join(out,'activity-stream.baseline.js'):path.join(root,'renderer/activity-stream.js'),'utf8')+'\nvoid 0;');
 Object.assign(result,await win.webContents.executeJavaScript('('+exercise.toString()+')()'));
 result.ok=Object.values(result.checks).every(Boolean);save();console.log(JSON.stringify(result));clearTimeout(timer);win.destroy();app.exit(result.ok||mode==='baseline'?0:1);
}).catch(error=>{result.errors.push(String(error.stack||error));save();console.error(error);clearTimeout(timer);win?.destroy();app.exit(1)});
