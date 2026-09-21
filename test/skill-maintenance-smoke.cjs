'use strict';

// Actual renderer in an isolated Electron window; all history/API data is
// synthetic, and no Relay main process, model or business MCP is launched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'skill-maintenance-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const checks = {}, failures = [];
let step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Overall timeout at ' + step); save(); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settleUI() {
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect&&a.effect.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} });");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+6000; const tick=()=>{ if(${code})return resolve(); if(Date.now()>end)return reject(new Error('State timeout: '+${JSON.stringify(code)})); setTimeout(tick,25); }; tick(); })`);
}
async function check(name, code) {
  step = name; console.log(name);
  checks[name] = !!await evaluate(code); save();
  if (!checks[name]) throw new Error(name);
}
async function click(selector) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); el.click(); })()`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function capture(name) {
  step = 'capture ' + name;
  await evaluate("document.getAnimations().forEach(a=>{ if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} }); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await win.webContents.capturePage(); await delay(130);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

async function checkTitlebarPixels(theme) {
  const shot = await win.webContents.capturePage(), {width,height} = shot.getSize();
  const pixels = shot.getBitmap(), scale = height / await evaluate('innerHeight');
  const y = Math.floor(33 * scale), expected = theme === 'dark' ? 26 : 250;
  const name = theme + 'ModalShadowCannotShadeCaptionBackground';
  checks[name] = [.4,.7,.95].every(fraction => {
    const offset = (y * width + Math.floor(width * fraction)) * 4;
    return [0,1,2].every(channel => pixels[offset + channel] === expected);
  });
  save(); if (!checks[name]) throw new Error(name);
}


app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const overrides = '(' + (() => {
    const base=window.api;
    window.maintenanceFixture={config:{ok:true,enabled:false,everyTurns:6,autoArchive:false,archiveDays:120},writes:[],staleDays:30,task:null};
    const f=window.maintenanceFixture;
    const methods={
      skills:{
        getReviewConfig:async()=>({...f.config}),
        setReviewConfig:async patch=>{f.writes.push({kind:'review',patch});Object.assign(f.config,patch);return {...f.config};},
        setStaleDays:async days=>{f.writes.push({kind:'stale',days});f.staleDays=days;return {ok:true};},
        overview:async()=>{const r=await base.skills.overview();return {...r,staleDays:f.staleDays};}
      },
      scheduler:{
        list:async()=>({ok:true,items:f.task?[f.task]:[]}),
        create:async body=>{f.writes.push({kind:'schedule',body});f.task={...body,id:'fixture-curator',builtin:'skill-curator'};return {ok:true,task:f.task};},
        toggle:async(id,enabled)=>{f.writes.push({kind:'toggle',enabled});f.task.enabled=enabled;return {ok:true};},
        runNow:async id=>{f.writes.push({kind:'run',id});return {ok:true};}
      }
    };
    window.api=new Proxy(base,{get(target,category){if(!methods[category])return target[category];return new Proxy(target[category],{get(original,method){return methods[category][method]||original[method];}});}});
  }).toString() + ')();';
  const fixture=['ui-api-fixture.js','workspace-api-fixture.js','plugins-api-fixture.js'].map(n=>fs.readFileSync(path.join(__dirname,n),'utf8')).join('\n')+'\n'+overrides;
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+'\nlocalStorage.clear();</script>');
  const page=path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win=new BrowserWindow({width:1320,height:920,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);win.showInactive();
  await waitFor('!!window.relayPluginsPage&&providerRoutingLoaded&&!restoringActiveRuns');
  await click('#btnPlugins');await waitFor('!!document.querySelector("[data-skill-view=maintenance]")&&!document.getElementById("pluginsRefresh").disabled');
  await click('[data-skill-view=maintenance]');await settleUI();
  await check('maintenanceDoesNotAppearInLibrary', 'document.querySelector("#skillSection [data-list]").hidden&&document.querySelector(".plugins-skill-filter").hidden&&!document.querySelector(".skill-maintenance").hidden');
  await check('idleAndArchiveHaveDifferentExplanationsAndUseSavedArchiveDays', 'document.querySelector("#skill-stale-days").closest(".set-row").textContent.includes("只标记")&&document.querySelector("[data-skill-archive-description]").textContent.includes("120 天")&&document.querySelector("[data-skill-auto-archive]").getAttribute("aria-checked")==="false"');
  for(const theme of ['light','dark']){
    await act('document.documentElement.dataset.theme='+JSON.stringify(theme)+';');await settleUI();
    await check(theme+'MaintenanceHasSeparatedGroups', '(()=>{const g=[...document.querySelectorAll(".skill-maintenance-group")];return g.length===3&&g.slice(1).every((e,i)=>e.getBoundingClientRect().top-g[i].getBoundingClientRect().bottom>=20);})()');
    await check(theme+'ControlsUseMonochromeIconsAndBorderlessSwitches', '([...document.querySelectorAll(".skill-maintenance .set-icon")].every(e=>e.querySelector("svg")&&getComputedStyle(e).backgroundColor==="rgba(0, 0, 0, 0)")&&[...document.querySelectorAll(".skill-maintenance button.switch")].every(e=>getComputedStyle(e).borderTopWidth==="0px"&&getComputedStyle(e).boxShadow==="none"))');
    await check(theme+'MaintenanceControlsFitInTheirRows', '([...document.querySelectorAll(".skill-maintenance .set-row")].every(row=>row.scrollWidth<=row.clientWidth+1&&[...row.children].every(e=>e.getBoundingClientRect().right<=row.getBoundingClientRect().right+1)))');
    await capture('maintenance-'+theme);
  }
  await click('[data-review-on]');
  await check('AutoLearningPersistsAndUpdatesSwitch', 'maintenanceFixture.config.enabled&&document.querySelector("[data-review-on]").getAttribute("aria-checked")==="true"');
  await click('[data-skill-auto-archive]');
  await check('AutoArchivePersistsIndependently', 'maintenanceFixture.config.autoArchive&&maintenanceFixture.staleDays===30&&document.querySelector("[data-skill-auto-archive]").getAttribute("aria-checked")==="true"');
  await click('#skill-stale-days .cs-trigger');await click('#skill-stale-days [data-value="60"]');
  await waitFor('document.querySelector("#skill-stale-days").dataset.value==="60"');
  await check('ChangingIdleThresholdKeepsArchivePolicy', 'maintenanceFixture.staleDays===60&&maintenanceFixture.config.archiveDays===120&&maintenanceFixture.config.autoArchive');
  await click('[data-cur-on]');await waitFor('!!maintenanceFixture.task');
  await check('ScheduledCheckStillPersistsAndUpdatesSwitch', 'maintenanceFixture.task.enabled&&document.querySelector("[data-cur-on]").getAttribute("aria-checked")==="true"');
  await click('[data-cur-run]');await waitFor('maintenanceFixture.writes.some(w=>w.kind==="run")');
  await check('CheckNowUsesExistingTask', 'maintenanceFixture.writes.filter(w=>w.kind==="schedule").length===1&&maintenanceFixture.writes.some(w=>w.kind==="run")');
  await act('document.documentElement.dataset.theme="light";');win.setSize(900,760);await waitFor('innerWidth<=900');await settleUI();
  await check('CompactMaintenanceHasNoHorizontalOverflow', '(()=>{const p=document.querySelector(".skill-maintenance");return p.scrollWidth<=p.clientWidth+1&&[...p.querySelectorAll(".set-row")].every(r=>r.scrollWidth<=r.clientWidth+1);})()');
  await check('CompactSwitchesStayBesideTheirLabels', '([...document.querySelectorAll(".skill-maintenance .set-row > button.switch")].every(e=>{const a=e.getBoundingClientRect(),b=e.parentElement.querySelector(".set-label").getBoundingClientRect();return a.top<b.bottom&&a.bottom>b.top&&a.left>b.right;}))');
  await click('#skill-cur-time .cs-trigger');await settleUI();
  await check('CompactTimePopupFitsViewport', '(()=>{const p=document.querySelector("#skill-cur-time .cs-popup"),r=p.getBoundingClientRect();return !p.hidden&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()');
  await capture('maintenance-compact-popup');await key('ESCAPE');
  await act('closeCustomSelect();document.querySelector(".skill-maintenance").scrollIntoView({block:"start"});');await capture('maintenance-compact');
  await check('NoRendererErrorsOrNodeAccess','uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step='completed';save();console.log(JSON.stringify({checks,failures}));clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));console.error(error.stack||error);if(win&&!win.isDestroyed())try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){}save();clearTimeout(deadline);app.exit(1);});
