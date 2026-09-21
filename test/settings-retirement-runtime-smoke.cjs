'use strict';
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.codex-tmp/settings-retirement-runtime');fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.commandLine.appendSwitch('disable-gpu');
let win;const report={scope:'Actual Relay renderer; isolated profile; synthetic APIs; no real model or user data',checks:[],errors:[]};
const deadline=setTimeout(()=>{report.errors.push('timeout');finish();},90000);
function finish(){clearTimeout(deadline);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);}
const evaluate=s=>win.webContents.executeJavaScript(s);
async function waitFor(s){await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+7000;const check=()=>{if(${s})return resolve();if(Date.now()>until)return reject(Error(${JSON.stringify(s)}));setTimeout(check,20);};check();})`);}
async function check(label,s){if(!await evaluate(s))throw Error(label);report.checks.push(label);}
function seed(){
 const original=window.api,clone=v=>structuredClone(v),state=window.retirementFixture={calls:[],writes:[],failSave:false,hold:false,release:null,result:{ok:true},saved:{app:{theme:'light',sdkRuntimePreferences:{}},claude:{defaultModel:'opus',routes:clone(uiFixture.routes)}}};
 window.api=new Proxy(original,{get(base,key){
  if(key==='settings')return{read:async()=>{const source=await base.settings.read();return{...source,...clone(state.saved),info:{uiVersion:'fixture'},app:{...source.app,...clone(state.saved.app)},claude:{...source.claude,...clone(state.saved.claude)}};},write:async patch=>{state.writes.push(clone(patch));if(state.failSave)return{ok:false,message:'Synthetic write failure'};state.saved.app={...state.saved.app,...patch.app};state.saved.claude={...state.saved.claude,...patch.claude};return{ok:true,routes:clone(state.saved.claude.routes)};}};
  if(key==='generalPreferences')return{get:async()=>({ok:true,preferences:clone(state.saved.app),capabilities:{}})};
  if(key==='claudeApplyRuntimeFlags')return async id=>{state.calls.push(id);if(state.hold)await new Promise(resolve=>{state.release=()=>{state.release=null;state.hold=false;resolve();};});if(state.result instanceof Error)throw state.result;return clone(state.result);};
  return base[key];
 }});
}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((request,done)=>done({cancel:/^https?:/i.test(request.url)}));
 const fixture=fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8')+'\n('+seed.toString()+')();localStorage.clear();';
 const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+'</script>');
 const file=path.join(out,'fixture.html');fs.writeFileSync(file,html);win=new BrowserWindow({width:1200,height:850,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(file);
 await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
 await evaluate('currentConv={id:"captured-conversation",title:"Synthetic A",turns:[]};openSettings("conversation")');await waitFor('settingsFormLoaded');
 await check('retired maintenance category normalizes to a visible settings page','!document.querySelector("[data-cat=maintenance]")');
 await evaluate('openSettings("maintenance")');
 await check('old category links do not leave a blank content pane','!!document.querySelector(".set-cat.active")&&lastSettingsCat!=="maintenance"');
 await evaluate('openSettings("conversation");document.querySelector("[data-sdk-preference=autoCompact] .cs-trigger").click();document.querySelector("[data-sdk-preference=autoCompact] [data-value=enabled]").click();currentConv={id:"other-conversation",title:"Synthetic B",turns:[]};retirementFixture.hold=true;saveMainSettings()');
 await waitFor('!!retirementFixture.release&&!settingsSaveBusy');
 await check('saving applies hot settings to captured conversation while save finishes before SDK acknowledgement','retirementFixture.calls.length===1&&retirementFixture.calls[0]==="captured-conversation"&&retirementFixture.saved.app.sdkRuntimePreferences.autoCompact==="enabled"&&!document.getElementById("btnSettingsSave").disabled');
 await evaluate('retirementFixture.release()');await new Promise(resolve=>setTimeout(resolve,80));
 await evaluate('saveMainSettings()');await waitFor('!settingsSaveBusy');
 await check('unchanged saved runtime values do not reapply','retirementFixture.calls.length===1');
 await evaluate('document.querySelector("[data-sdk-preference=autoCompact] .cs-trigger").click();document.querySelector("[data-sdk-preference=autoCompact] [data-value=disabled]").click();retirementFixture.failSave=true;saveMainSettings().catch(()=>{})');await waitFor('!settingsSaveBusy');
 await check('failed persistence never changes live SDK options and retains the draft','retirementFixture.calls.length===1&&retirementFixture.saved.app.sdkRuntimePreferences.autoCompact==="enabled"&&generalPreferencesView.getPatch().sdkRuntimePreferences.autoCompact==="disabled"');
 await evaluate('retirementFixture.failSave=false;retirementFixture.result={ok:false,message:"Synthetic session unavailable"};saveMainSettings()');await waitFor('!settingsSaveBusy&&retirementFixture.calls.length===2');await new Promise(resolve=>setTimeout(resolve,80));
 await check('SDK unavailable does not roll back saved settings or leave save blocked','retirementFixture.saved.app.sdkRuntimePreferences.autoCompact==="disabled"&&Object.keys(generalPreferencesView.getPatch()).length===0&&!document.getElementById("btnSettingsSave").disabled');
 await evaluate('document.querySelector("[data-sdk-preference=autoCompact] .cs-trigger").click();document.querySelector("[data-sdk-preference=autoCompact] [data-value=inherit]").click();saveMainSettings()');await waitFor('!settingsSaveBusy');await new Promise(resolve=>setTimeout(resolve,80));
 await check('restoring SDK inheritance is saved and reports deferred application','retirementFixture.calls.length===3&&retirementFixture.saved.app.sdkRuntimePreferences.autoCompact==="inherit"&&document.getElementById("settingsHint").textContent.includes("下次")');
 await evaluate('closeSettings(true);currentConv=null;loadSettingsForm("conversation")');await waitFor('settingsFormLoaded');
 await evaluate('document.querySelector("[data-sdk-preference=autoCompact] .cs-trigger").click();document.querySelector("[data-sdk-preference=autoCompact] [data-value=enabled]").click();saveMainSettings()');await waitFor('!settingsSaveBusy');await new Promise(resolve=>setTimeout(resolve,80));
 await check('settings opened without a conversation save only the new-task defaults','retirementFixture.calls.length===3&&retirementFixture.saved.app.sdkRuntimePreferences.autoCompact==="enabled"');
 await evaluate(`(()=>{
  const f=window.runtimeQueueFixture={calls:0,hold:false,release:null,fail:false,promises:[]};f.mount=document.createElement('div');f.mount.hidden=true;document.body.append(f.mount);
  f.view=RelayGeneralPreferencesPage.create({mount:f.mount,settings:{sdkRuntimePreferences:{}},api:{applyRuntimeFlags:async()=>{f.calls++;if(f.hold)await new Promise(resolve=>{f.release=()=>{f.release=null;f.hold=false;resolve();};});if(f.fail)throw Error('Synthetic disconnected SDK');return{ok:true};}}});
  f.view.saved({terminalShell:'cmd'});f.view.saved({sdkRuntimePreferences:{allowedTools:['Read'],agentProgressSummaries:true}});
 })()`);
 await check('ordinary preferences and startup-only options do not call the live SDK','runtimeQueueFixture.calls===0');
 await evaluate('runtimeQueueFixture.hold=true;runtimeQueueFixture.promises.push(runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"enabled"}}))');await waitFor('!!runtimeQueueFixture.release');
 await evaluate('runtimeQueueFixture.promises.push(runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"disabled"}}));runtimeQueueFixture.promises.push(runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"enabled",showThinkingSummaries:"disabled"}}));runtimeQueueFixture.release();Promise.all(runtimeQueueFixture.promises).then(values=>runtimeQueueFixture.results=values)');await waitFor('!!runtimeQueueFixture.results');
 await check('rapid confirmed saves serialize application and skip superseded revisions','runtimeQueueFixture.calls===2&&runtimeQueueFixture.results[0].skipped&&runtimeQueueFixture.results[1].skipped&&runtimeQueueFixture.results[2].ok');
 await evaluate('runtimeQueueFixture.fail=true;runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"disabled",showThinkingSummaries:"disabled"}}).then(result=>runtimeQueueFixture.failedResult=result)');await waitFor('!!runtimeQueueFixture.failedResult');
 await check('live transport exceptions resolve as deferred without undoing the confirmed save','runtimeQueueFixture.failedResult.deferred===true&&runtimeQueueFixture.failedResult.ok===false');
 await evaluate('runtimeQueueFixture.fail=false;runtimeQueueFixture.hold=true;void runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"enabled"}}).then(result=>runtimeQueueFixture.disposedResult=result)');await waitFor('!!runtimeQueueFixture.release');
 await evaluate('runtimeQueueFixture.view.saved({sdkRuntimePreferences:{autoCompact:"disabled"}}).then(result=>runtimeQueueFixture.queuedDisposedResult=result);runtimeQueueFixture.callsBeforeDispose=runtimeQueueFixture.calls;runtimeQueueFixture.view.destroy();runtimeQueueFixture.release()');await waitFor('!!runtimeQueueFixture.disposedResult&&!!runtimeQueueFixture.queuedDisposedResult');
 await check('closing a settings form discards late results and queued applications','runtimeQueueFixture.disposedResult.skipped&&runtimeQueueFixture.queuedDisposedResult.skipped&&runtimeQueueFixture.calls===runtimeQueueFixture.callsBeforeDispose&&runtimeQueueFixture.mount.childElementCount===0');
 await evaluate('runtimeQueueFixture.mount.remove()');
 await check('no retired native history UI is mounted or SDK model started','!document.querySelector("[data-sdk-history-action],.rgp-diagnostics,[data-general-apply-runtime]")&&!uiFixture.calls.includes("runClaude")&&uiFixture.errors.length===0');
 report.ok=true;
}).catch(async error=>{report.errors.push(error.stack||String(error));if(win&&!win.isDestroyed())report.domError=await evaluate('document.querySelector(".settings-load-error")?.textContent||uiFixture.errors.join(";")');console.error(error,report.domError);}).finally(finish);
