'use strict';

// Actual renderer in an isolated Electron window; all history/API data is
// synthetic, and no Relay main process, model or business MCP is launched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'responsive-layout-smoke');
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
  if(keyCode.toLowerCase()==='enter')win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter', modifiers });
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

async function beginPointerDrag(id) {
  const point = await evaluate(`(()=>{const r=document.querySelector('[data-customize-feature=${id}] [data-action=drag]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...point});
  win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  return point;
}
async function movePointer(point) {
  win.webContents.sendInputEvent({type:'mouseMove',...point,modifiers:['leftButtonDown']});
  await delay(25);
  await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:/^https?:/i.test(details.url)}));
  const fixture = ['ui-api-fixture.js','workspace-api-fixture.js','plugins-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const stress = `(() => {
    const base=window.api;
    window.responsiveFixture={images:[
      {adapterId:'gpt-image-2',remoteModelId:'synthetic-provider/gpt-image-2'},
      {adapterId:'seedream-5.0',remoteModelId:'synthetic-provider/long-model-name-for-responsive-layout-validation-v5.0'},
      {adapterId:'seedream-4.5',remoteModelId:'synthetic-provider/seedream-v4.5'}
    ]};
    window.api=new Proxy(base,{get(target,category){
      if(category==='data')return new Proxy(target.data,{get(original,method){
        if(method==='readItem')return async(...args)=>{const r=await original.readItem(...args);return{...r,content:'# 工作资料整理\\n\\n用于检查详情阅读区域，所有内容均为合成数据。\\n\\n'+Array.from({length:28},(_,i)=>'## 第 '+(i+1)+' 项\\n\\n说明、操作步骤和验收结果。\\n\\n| 内容 | 状态 |\\n| --- | --- |\\n| 本地文档 | 已整理 |\\n').join('\\n')};};
        return original[method];
      }});
      if(category==='providers')return new Proxy(target.providers,{get(original,method){
        if(method==='list')return async()=>{const r=await original.list();return{...r,profiles:r.profiles.map(p=>({...p,hasCredential:true,chatReady:true,imageReady:true,imageModels:responsiveFixture.images,activeImageAdapters:['gpt-image-2']}))};};
        if(method==='discoverModels'||method==='discoverDraftModels')return async()=>({ok:true,models:['synthetic-provider/example-chat-model'],modelCatalog:[{value:'synthetic-provider/example-chat-model'}],imageModels:responsiveFixture.images});
        return original[method];
      }});
      return target[category];
    }});
  })();`;
  const page=path.join(output,'fixture.html');
  fs.writeFileSync(page,fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+stress+'\nlocalStorage.clear();</script>'));
  win=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);win.showInactive();
  await waitFor('!!window.relaySidebarExplore&&!!window.relayPluginsPage&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`window.visible=s=>!!document.querySelector(s)?.getClientRects().length;
    window.fits=s=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.top>=36&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;};
    window.readableDetail=id=>{const p=document.getElementById('plugin-'+id+'-dpMemoryPreview'),footer=document.querySelector('#pluginsCategory-'+id+' .plugins-detail-footer'),r=p.getBoundingClientRect(),f=footer.getBoundingClientRect();return r.height>innerHeight*.55&&f.top-r.bottom<=14&&innerHeight-f.bottom<=2&&p.scrollHeight>p.clientHeight&&fits('#plugin-'+id+'-dpMemoryPreview');};
    window.providerFits=()=>{const c=document.getElementById('setContent');return document.documentElement.scrollWidth<=innerWidth+1&&c.scrollWidth<=c.clientWidth+1&&[...document.querySelectorAll('.provider-edit-row,.provider-editor-actions')].every(e=>{const r=e.getBoundingClientRect(),p=c.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1;});};
    inputEl.value='调整布局时保留的对话草稿';`);
  await act('relaySidebarExplore.openCustomize();');await settleUI();
  await check('customizerRetainsLeftNavigationPositionAndKeyboardFocus',"fits('#sidebarExploreSurface')&&document.activeElement.type==='checkbox'&&Math.abs(document.getElementById('sidebarExploreSurface').getBoundingClientRect().top-document.querySelector('.sidebar .nav-list').getBoundingClientRect().top)<2");
  await capture('customizer-light');
  await act("responsiveFixture.original=JSON.stringify(relaySidebarExplore.getPreferences());responsiveFixture.originalY=document.querySelector('[data-customize-feature=create]').getBoundingClientRect().top;");
  const crop=await evaluate("(()=>{const r=document.getElementById('sidebarExploreSurface').getBoundingClientRect();return{x:Math.max(0,Math.floor(r.left)-6),y:Math.floor(r.top)-6,width:Math.ceil(r.width)+12,height:Math.ceil(r.height)+12};})()");
  const frames=path.join(output,'drag-frames');fs.mkdirSync(frames,{recursive:true});
  let frameIndex=0;
  const dragFrame=async()=>fs.writeFileSync(path.join(frames,String(frameIndex++).padStart(3,'0')+'.png'),(await win.webContents.capturePage(crop)).toPNG());
  await dragFrame();
  let point=await beginPointerDrag('create');
  const endY=await evaluate("Math.round(document.querySelector('[data-customize-feature=search]').getBoundingClientRect().top+9)");
  for(let i=1;i<=14;i++){await movePointer({x:point.x,y:Math.round(point.y+(endY-point.y)*i/14)});await dragFrame();}
  await check('draggedRowFollowsPointerAndNeighborsMakeRoom',"document.querySelector('[data-customize-feature=create]').getBoundingClientRect().top<responsiveFixture.originalY-90&&[...document.querySelectorAll('.se-customize-row:not(.is-dragging)')].some(e=>Math.abs(new DOMMatrix(getComputedStyle(e).transform).m42)>15)");
  await check('reorderPreviewDoesNotPersistUntilPointerRelease',"JSON.stringify(relaySidebarExplore.getPreferences())===responsiveFixture.original&&!!document.querySelector('[data-drop]')");
  await act("responsiveFixture.dropTarget=document.querySelector('[data-drop]').dataset.customizeFeature;");
  await delay(280);
  await check('stationaryPointerKeepsStableDestinationDuringNeighborAnimation',"document.querySelector('[data-drop]').dataset.customizeFeature===responsiveFixture.dropTarget");
  win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:endY,button:'left',clickCount:1});
  await waitFor("relaySidebarExplore.getPreferences().order[0]==='create'");
  await check('dropAnimatesIntoPlaceAndPersistsNewOrder',"JSON.parse(localStorage.getItem('relay.sidebar.features.v1')).order[0]==='create'&&document.querySelector('[data-customize-feature=create]').getAnimations().some(a=>a.playState==='running')");
  for(let i=0;i<7;i++){await delay(35);await dragFrame();}
  await settleUI();
  await act('responsiveFixture.afterDrop=JSON.stringify(relaySidebarExplore.getPreferences());');
  point=await beginPointerDrag('create');await movePointer({x:point.x,y:point.y+140});await key('ESCAPE');await settleUI();
  await check('escapeRestoresRowsWithoutSavingOrClosingCustomizer',"!!document.getElementById('sidebarExploreSurface')&&JSON.stringify(relaySidebarExplore.getPreferences())===responsiveFixture.afterDrop&&![...document.querySelectorAll('.se-customize-row')].some(e=>Math.abs(new DOMMatrix(getComputedStyle(e).transform).m42)>.5)");
  await key('DOWN',['alt']);
  await check('keyboardReorderAlsoAnimatesAndKeepsFocus',"relaySidebarExplore.getPreferences().order[1]==='create'&&document.activeElement.dataset.action==='drag'&&document.querySelector('[data-customize-feature=create]').getAnimations().some(a=>a.playState==='running')");
  await settleUI();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  point=await beginPointerDrag('create');await movePointer({x:point.x,y:point.y+130});
  await check('reducedMotionKeepsSortingWithoutDecorativeAnimation',"document.querySelectorAll('.is-dragging').length===1&&[...document.querySelectorAll('.se-customize-row')].every(e=>e.getAnimations().length===0)");
  await key('ESCAPE');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  await act("document.documentElement.dataset.theme='dark';");await capture('customizer-dark');await click('[data-action=done]');

  win.setSize(1500,1000);await settleUI();await click('#btnPlugins');
  for(const category of ['skill','agent']){
    await click('[data-plugin-tab='+category+']');await waitFor(`!!document.querySelector('#${category}Section > [data-list] > .dp-item .dp-more')`);
    await click('#'+category+'Section .dp-more');await click('#'+category+'Section [data-action=detail]');
    await waitFor(`!!document.getElementById('plugin-${category}-dpMemoryPreview')?.textContent.includes('第 28 项')`);await settleUI();
    await check(category+'ReadingFillsLargeWindowToBottomActions',`readableDetail('${category}')`);
    await act(`document.getElementById('plugin-${category}-dpMemoryPreview').scrollTop=999999;`);
    await check(category+'LastContentAndBackStayReachable',`(()=>{const p=document.getElementById('plugin-${category}-dpMemoryPreview');return p.scrollHeight-p.scrollTop-p.clientHeight<=1&&fits('#pluginsCategory-${category} [data-detail-back]');})()`);
    await act(`document.getElementById('plugin-${category}-dpMemoryPreview').scrollTop=0;`);await capture(category+'-detail-large');
    await click('#plugin-'+category+'-memViewToggle');await settleUI();
    await check(category+'EditorAndPreviewFillAvailableHeight',`(()=>{const s=document.getElementById('plugin-${category}-dpMemorySource'),r=s.getBoundingClientRect(),e=document.getElementById('plugin-${category}-dpEditor').getBoundingClientRect();return r.height>innerHeight*.55&&r.bottom-e.bottom<=2&&fits('#pluginsCategory-${category} [data-detail-save]');})()`);
    await act(`const e=document.getElementById('plugin-${category}-dpEditor');responsiveFixture['${category}Editor']=e;e.value='# 保留的 ${category} 草稿';e.dispatchEvent(new Event('input',{bubbles:true}));`);
    win.setSize(900,600);await settleUI();
    await check(category+'EditorReflowsAtMinimumWindowWithoutLosingDraft',`document.getElementById('plugin-${category}-dpEditor')===responsiveFixture['${category}Editor']&&responsiveFixture['${category}Editor'].value==='# 保留的 ${category} 草稿'&&fits('#plugin-${category}-dpMemorySource')&&fits('#pluginsCategory-${category} [data-detail-save]')&&getComputedStyle(document.getElementById('plugin-${category}-dpMemorySource')).gridTemplateColumns.split(' ').length===1`);
    await capture(category+'-editor-compact');
    await click('#pluginsCategory-'+category+' [data-detail-back]');await click('#pluginsCategory-'+category+' [data-detail-back]');
    win.setSize(1500,1000);await settleUI();
  }
  await click('#btnSettings');await waitFor("!!document.querySelector('.set-nav-item[data-cat=providers]')");
  await click('.set-nav-item[data-cat=providers]');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act(`window.providerActionsVisible=()=>{
    const row=document.querySelector('.provider-row'),buttons=[...row.querySelectorAll('.provider-row-action')],r=row.getBoundingClientRect(),c=document.getElementById('setContent');
    return buttons.length===4&&!row.matches(':hover')&&!row.matches(':focus-within')&&c.scrollWidth<=c.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1&&buttons.every(button=>{
      const b=button.getBoundingClientRect(),style=getComputedStyle(button),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2),opacity=Number(style.opacity);
      return b.width>=28&&b.height>=28&&b.left>=r.left&&b.right<=r.right+1&&b.top>=r.top&&b.bottom<=r.bottom+1&&b.bottom<=innerHeight&&hit&&button.contains(hit)&&style.visibility==='visible'&&(button.disabled?opacity>.2&&opacity<.6:opacity===1)&&button.getAttribute('aria-label')&&button.title;
    });
  };`);
  for(const theme of ['light','dark']){
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    for(const [width,height] of [[1200,800],[900,600],[620,700]]){
      win.setSize(width,height);await settleUI();
      win.webContents.sendInputEvent({type:'mouseMove',x:10,y:44});
      await act("document.querySelector('.set-nav-item[data-cat=providers]').focus();document.getElementById('setContent').scrollTop=0;");await settleUI();
      await check('providerActionsStayVisibleWithoutHover_'+theme+'_'+width,'providerActionsVisible()');
      if(width===1200||width===620)await capture('provider-list-actions-'+theme+'-'+width);
    }
  }
  win.setSize(1200,800);win.focus();win.webContents.focus();await settleUI();
  await act("document.documentElement.dataset.theme='light';document.querySelector('[data-provider-act=test]').focus();");
  await key('TAB');
  const keyboardFocus=await evaluate("(()=>{const button=document.querySelector('[data-provider-act=edit]'),style=getComputedStyle(button),r=button.getBoundingClientRect();return{documentFocused:document.hasFocus(),active:document.activeElement.outerHTML,focused:document.activeElement===button,focusVisible:button.matches(':focus-visible'),opacity:style.opacity,outlineWidth:style.outlineWidth,outlineStyle:style.outlineStyle,bounds:r.toJSON(),fits:fits('[data-provider-act=edit]'),testDisabled:document.querySelector('[data-provider-act=test]').disabled};})()");
  fs.writeFileSync(path.join(output,'provider-keyboard-focus.json'),JSON.stringify(keyboardFocus,null,2));
  console.log('provider keyboard focus',keyboardFocus);
  await check('providerActionKeyboardFocusIsVisible',"(()=>{const button=document.querySelector('[data-provider-act=edit]'),style=getComputedStyle(button);return document.activeElement===button&&button.matches(':focus-visible')&&Number(style.opacity)===1&&parseFloat(style.outlineWidth)>=2&&fits('[data-provider-act=edit]');})()");
  await key('ENTER');await waitFor("!!document.getElementById('providerModelOpus')");
  await check('providerEditActionWorksFromKeyboard',"!!document.getElementById('providerModelOpus')&&workspaceFixture.providerWrites.length===0");
  await act("responsiveFixture.providerModel=document.getElementById('providerModelOpus');responsiveFixture.providerModel.value='synthetic-provider/unsaved-long-model-name-for-layout-validation';document.getElementById('providerEditorStatus').textContent='合成的连接状态，仅检查布局';");
  for(const [width,height] of [[1200,800],[1000,700],[900,600],[620,700],[1500,1000]]){
    win.setSize(width,height);await settleUI();
    await act("const c=document.getElementById('setContent');c.scrollTop=c.scrollHeight;");await settleUI();
    await check(`provider_${width}_${height}_fitsWithoutHorizontalScroll`,"providerFits()&&fits('#providerEditorSave')&&fits('#providerEditorCancel')");
    await check(`provider_${width}_${height}_keepsFullFormAndDraft`,"document.querySelectorAll('.provider-image-capability').length===3&&document.getElementById('providerModelOpus')===responsiveFixture.providerModel&&responsiveFixture.providerModel.value==='synthetic-provider/unsaved-long-model-name-for-layout-validation'");
    if([1200,900,620].includes(width))await capture('provider-'+width);
  }
  win.setSize(1200,800);await settleUI();
  await act("document.getElementById('sidebarResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));");await settleUI();
  await act("document.getElementById('setContent').scrollTop=999999;");
  await check('providerAdaptsToWideSidebarWithinDefaultWindow',"providerFits()&&fits('#providerEditorSave')&&getComputedStyle(document.querySelector('.provider-edit-row')).gridTemplateColumns.split(' ').length===1");
  await capture('provider-wide-sidebar');
  await act("relaySidebarLayout.reset();document.documentElement.dataset.theme='light';");await settleUI();
  await click('#providerDiscover');await waitFor("!document.getElementById('providerDiscover').disabled");
  await click('#providerModelOpus + .provider-model-toggle');await waitFor("!!document.querySelector('.provider-model-picker.is-open')");await settleUI();
  await check('providerModelPickerRemainsReachableWithoutPageOverflow',"providerFits()&&fits('#providerModelOpusOptions')");
  await check('providerPopupAlignsWithItsModelInput',"(()=>{const a=document.getElementById('providerModelOpus').getBoundingClientRect(),p=document.getElementById('providerModelOpusOptions').getBoundingClientRect();return Math.abs(a.left-p.left)<=1&&Math.abs(a.width-p.width)<=1;})()");
  await key('ESCAPE');await capture('provider-light');
  await click('#btnNewChat');
  await check('layoutChangesDoNotWriteProviderOrPluginData',"workspaceFixture.providerWrites.length===0&&workspaceFixture.settingsWrites.length===0&&pluginsFixture.writes.length===0");
  await check('noRendererErrorsOrNodeAccess',"uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  step='completed';save();console.log(JSON.stringify({checks,failures}));clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{
  failures.push(String(error.stack||error));console.error(error.stack||error);
  if(win&&!win.isDestroyed()){try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){} }
  save();clearTimeout(deadline);app.exit(1);
});
