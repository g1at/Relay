'use strict';
// Real Electron renderer; all provider, media and history calls are synthetic.
// Run: electron test/media-ui-smoke.cjs [output-directory]
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getMediaProtocolPresets } = require('../src/main/providers/provider-media');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '..', 'media-ui-preview'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, layouts = {}, errors = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, layouts, errors, step, evidence: 'Synthetic API fixture in the actual Electron renderer; no paid generation or real user data.' }, null, 2));
const deadline = setTimeout(() => { errors.push(`timeout: ${step}`); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(`${checks[name] ? 'PASS' : 'FAIL'} ${name}`); if (!checks[name]) throw Error(name); }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function fill(selector, value) { await act(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));`); await settle(); }
async function capture(name) {
  await settle();
  await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}})');
  await settle();
  fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function previewViewport(width, theme) {
  win.setContentSize(width,width<=900?650:800);await waitFor(`Math.abs(innerWidth-${width})<3`);
  await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);await settle();
}
async function recordPreview(name, selectors) {
  await evaluate('new Promise(resolve=>setTimeout(resolve,220))');await settle();
  layouts[name]=await evaluate(`(${JSON.stringify(selectors)}).map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,missing:true};const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,textAlign:s.textAlign,justifyContent:s.justifyContent,viewport:{width:innerWidth,height:innerHeight}}})`);save();await capture(name);
}
async function layout(name, selectors) {
  layouts[name] = await evaluate(`(${JSON.stringify(selectors)}).map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return {selector,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight}}})`);
  save();
  await check(`${name}HasNoHorizontalOverflow`, JSON.stringify(layouts[name].every(r => r.scrollWidth <= r.clientWidth + 1 && r.left >= -1 && r.right <= r.viewport.width + 1)));
}
function mediaFixture(presets) {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const image = { id:'synthetic-image', modelId:'unlisted-labs/image-future-42', protocol:'openai-images', modality:'image', enabled:true, capabilities:{operations:['text_to_image'],defaults:{size:'640x640'},parameters:{size:{pattern:'^\\d+x\\d+$'},n:{min:1,max:2,integer:true}},references:{max:0}} };
  const video = { id:'synthetic-video', modelId:'another-owner/video-not-in-any-catalog-99', protocol:'ark-video', modality:'video', enabled:true, capabilities:{operations:['text_to_video','image_to_video'],defaults:{duration:4,resolution:'480p'},parameters:{duration:{enum:[4,6],integer:true},resolution:{enum:['480p','720p']},audio:{type:'boolean'}},references:{max:2,roles:['first_frame','last_frame']}} };
  const numeric = { id:'synthetic-numeric', modelId:'future-provider/video-range',protocol:'dashscope-video',modality:'video',enabled:true,capabilities:{operations:['text_to_video'],defaults:{duration:3},parameters:{duration:{min:2,max:6,integer:true},audio:{type:'boolean'}},references:{max:0}} };
  const state = window.mediaFixture = {
    profile:{id:'fixture',name:'合成媒体服务商',revision:1,baseUrl:'https://models.example.invalid/anthropic',hasCredential:true,credentialHint:'已保存',enabled:true,chatReady:true,chatModelCount:3,activeTiers:['haiku','sonnet','opus'],activeImageAdapters:[],imageModels:[],routed:true,models:{haiku:'saved/fast',sonnet:'saved/medium',opus:'saved/expert'},defaultModel:'opus',mediaConnection:{preset:'custom',authMode:'bearer'},mediaModels:[image,video,numeric]},
    writes:[],requests:[],savedReferences:[],listeners:[],tasks:{},actions:[],nextFailure:null,composerWrites:[],composerSnapshots:new Map(),discoveries:0,
    mediaListeners:[],pendingGenerations:{},pendingActions:{},pendingGets:{},holdGetIds:new Set(),
    holdGenerate:false,holdActions:{},failNextAction:null,stopSettlesGeneration:true,historySequence:0,
    holdNextHistorySave:false,pendingHistorySave:null,holdNextHistoryLoadId:null,pendingHistoryLoad:null,
    deletedHistory:new Set(),historyDeletes:[],holdNextComposerWrite:false,pendingComposerWrite:null,
    png:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  };
  state.emitTask = (id,patch={}) => {
    const task=state.tasks[id]={...state.tasks[id],...clone(patch),id,updatedAt:new Date().toISOString()};
    for(const listener of state.mediaListeners)listener(clone(task));
    return clone(task);
  };
  state.finishGeneration = (id,result) => {
    const resolve=state.pendingGenerations[id];if(!resolve)throw Error('No pending synthetic generation '+id);
    delete state.pendingGenerations[id];resolve(clone(result||{ok:false,taskId:id,mediaKind:state.tasks[id].mediaKind,canceled:true,error:'已停止本地等待',paths:[]}));
  };
  state.releaseAction = method => {const pending=state.pendingActions[method];if(!pending)throw Error('No pending '+method);delete state.pendingActions[method];state.holdActions[method]=false;pending();};
  state.releaseGet = id => {state.holdGetIds.delete(id);for(const release of state.pendingGets[id]||[])release();delete state.pendingGets[id];};
  state.releaseHistorySave = () => {const release=state.pendingHistorySave;if(!release)throw Error('No pending history save');state.pendingHistorySave=null;release();};
  state.releaseHistoryLoad = () => {const release=state.pendingHistoryLoad;if(!release)throw Error('No pending history load');state.pendingHistoryLoad=null;release();};
  state.releaseComposerWrite = () => {const release=state.pendingComposerWrite;if(!release)throw Error('No pending composer write');state.pendingComposerWrite=null;release();};
  state.seedConversation = async (id,task,turn={}) => {
    const mediaTask={mediaKind:'video',conversationId:id,turnIndex:0,submissionOutcome:'accepted',remoteHandle:{taskId:'remote-'+id},state:'needs_attention',...clone(task)};
    state.tasks[mediaTask.id]=mediaTask;
    const conv={id,kind:'create',title:id,titleGenerated:true,turns:[{prompt:'合成状态 '+id,model:'fixture::media::synthetic-numeric',mediaKind:'video',parameters:{duration:5},resultPaths:[],runId:mediaTask.runId||mediaTask.id,mediaTaskId:mediaTask.id,error:'合成待恢复状态',...clone(turn)}]};
    await window.api.history.save(conv);return conv;
  };
  state.completeTask = async (id,paths=['C:/synthetic-media-fixture/background-video.mp4']) => {
    const task=state.tasks[id],conv=await window.api.history.load(task.conversationId);
    const turn=conv?.turns.find(item=>(item.mediaTaskId||item.runId)===id);
    if(turn){turn.resultPaths=[...paths];delete turn.error;await window.api.history.save(conv);}
    return state.emitTask(id,{state:'completed',remoteState:'succeeded',submissionOutcome:'completed',artifacts:paths.map(path=>({path,kind:'video'}))});
  };
  const providers = new Proxy(base.providers, {get(target,key) {
    if(key==='list')return async()=>({ok:true,profiles:[clone(state.profile)],routes:clone(uiFixture.routes)});
    if(key==='mediaPresets')return async()=>({ok:true,...clone(presets)});
    if(key==='onChanged')return fn=>{state.listeners.push(fn);return()=>{};};
    if(key==='discoverModels'||key==='discoverDraftModels')return async()=>{state.discoveries++;return{ok:true,models:[],modelCatalog:[],mediaCatalog:{models:[{rawId:'brand-new-owner/unrecognized-video',owned_by:'brand-new-owner',model_type:'video'}]},imageModels:[],profile:clone(state.profile)};};
    if(key==='update')return async(id,input)=>{state.writes.push(clone({id,input}));state.profile={...state.profile,...clone(input)};delete state.profile.apiKey;return {ok:true,profile:clone(state.profile)};};
    return target[key];
  }});
  const media = {
    getConfig:async()=>({models:state.profile.mediaModels.map(m=>({...clone(m),name:`fixture::media::${m.id}`,label:m.label||m.modelId,ok:true,providerName:state.profile.name}))}),
    generate:async input=>{
      state.requests.push(clone(input));const id=input.runId;
      state.tasks[id]={id,runId:id,conversationId:input.conversationId,turnIndex:input.turnIndex,mediaKind:input.mediaKind,state:'running',remoteState:'running',submissionOutcome:'accepted',remoteHandle:{taskId:'remote-'+id}};
      if(state.holdGenerate){const pending=new Promise(resolve=>{state.pendingGenerations[id]=resolve;});state.emitTask(id);return pending;}
      if(state.nextFailure){state.emitTask(id,{state:'needs_attention',error:{message:state.nextFailure}});return{ok:false,taskId:id,mediaKind:input.mediaKind,error:state.nextFailure,paths:[]};}
      state.emitTask(id,{state:'completed',remoteState:'succeeded',submissionOutcome:'completed'});return {ok:true,taskId:id,mediaKind:input.mediaKind,paths:[input.mediaKind==='video'?'C:/synthetic-media-fixture/generated-video.mp4':'C:/synthetic-media-fixture/generated-image.png']};
    },
    get:async id=>{const value=clone(state.tasks[id]||null);if(state.holdGetIds.has(id))return new Promise(resolve=>{(state.pendingGets[id]||=[]).push(()=>resolve(value));});return value;},
    onChanged:listener=>{state.mediaListeners.push(listener);return()=>{state.mediaListeners=state.mediaListeners.filter(item=>item!==listener);};},
  };
  for(const method of ['resume','stop','retryDownload'])media[method]=async id=>{
    state.actions.push({method,id});if(state.failNextAction===method){state.failNextAction=null;throw Error('合成 IPC 暂时失败，请重试');}
    const commit=()=>{
      if(!state.tasks[id])throw Error('Unknown synthetic task '+id);
      const next=state.emitTask(id,method==='stop'?{state:'stopped',cancelIntent:true}:method==='resume'?{state:'accepted',cancelIntent:false}:{state:'downloading',remoteState:'succeeded',cancelIntent:false});
      if(method==='stop'&&state.stopSettlesGeneration&&state.pendingGenerations[id])state.finishGeneration(id);
      return next;
    };
    if(state.holdActions[method])return new Promise(resolve=>{state.pendingActions[method]=()=>resolve(commit());});
    return commit();
  };
  const imageApi = new Proxy(base.image,{get(target,key){
    if(key==='saveRef')return async dataUrl=>{state.savedReferences.push(dataUrl);return{ok:true,path:`C:/synthetic-media-fixture/reference-${state.savedReferences.length}.png`};};
    return target[key];
  }});
  const historyApi=new Proxy(base.history,{get(target,key){
    const withComposer=conv=>conv&&state.composerSnapshots.has(conv.id)?{...conv,mediaComposer:clone(state.composerSnapshots.get(conv.id))}:conv;
    if(key==='load')return async id=>{
      if(state.deletedHistory.has(id))return null;
      const conv=withComposer(await target.load(id));
      if(state.holdNextHistoryLoadId===id){state.holdNextHistoryLoadId=null;return new Promise(resolve=>{state.pendingHistoryLoad=()=>resolve(conv);});}
      return conv;
    };
    if(key==='list')return async()=> (await target.list()).filter(conv=>!state.deletedHistory.has(conv.id)).map(withComposer);
    if(key==='delete')return async id=>{state.historyDeletes.push(id);state.deletedHistory.add(id);state.composerSnapshots.delete(id);return{ok:true};};
    if(key==='save')return async conv=>{
      const input=clone(conv),id=input.id||'fixture-media-'+(++state.historySequence);
      const commit=async()=>{const previous=withComposer(await target.load(id)),next={...input,id};
        if(state.deletedHistory.has(id))throw Error('Synthetic deleted conversation cannot be recreated');
        if(previous){if(Object.hasOwn(previous,'mediaComposer'))next.mediaComposer=clone(previous.mediaComposer);else delete next.mediaComposer;}
        return target.save(next);
      };
      if(state.holdNextHistorySave){state.holdNextHistorySave=false;return new Promise(resolve=>{state.pendingHistorySave=()=>resolve(commit());});}
      return commit();
    };
    if(key==='updateCreationComposer')return async request=>{
      state.composerWrites.push(clone(request));
      const commit=async()=>{const previous=await target.load(request.id);
        if(state.deletedHistory.has(request.id)||!previous||previous.kind!=='create')return{ok:false,code:'not_found',error:'Synthetic creation conversation not found'};
        const mediaComposer={model:request.mediaComposer.model,parameters:clone(request.mediaComposer.parameters||{})};
        state.composerSnapshots.set(request.id,mediaComposer);return{ok:true,id:request.id,mediaComposer:clone(mediaComposer)};
      };
      if(state.holdNextComposerWrite){state.holdNextComposerWrite=false;return new Promise(resolve=>{state.pendingComposerWrite=()=>resolve(commit());});}
      return commit();
    };
    return target[key];
  }});
  window.api = new Proxy(base,{get(target,key){return key==='providers'?providers:key==='media'?media:key==='image'?imageApi:key==='history'?historyApi:target[key];}});
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const base = pathToFileURL(path.join(root, 'renderer') + path.sep).href;
  const fixture = ['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html = fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',()=>'<head><base href="'+base+'"><script>'+fixture+'\n('+mediaFixture.toString()+')('+JSON.stringify(getMediaProtocolPresets())+');localStorage.clear();</script>');
  const page = path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win = new BrowserWindow({width:1200,height:800,useContentSize:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#fafafa',symbolColor:'#111111',height:40},show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message', (_event, level, message, line, source) => { if (level >= 2) { errors.push(`${message} (${source}:${line})`); save(); } });
  await win.loadFile(page);win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('providers')");
  await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await click('[data-provider-act=edit]');
  await waitFor("document.querySelectorAll('.media-binding').length===3&&!document.querySelector('#providerMediaEditor [data-add]').disabled");
  await check('UnknownModelIdsRemainEditable', "document.querySelector('.media-binding [data-id]').value==='unlisted-labs/image-future-42'&&document.querySelectorAll('.media-binding [data-protocol]')[1].value==='ark-video'");
  await check('GatewayPresetIsExplicit', "document.querySelector('#providerMediaEditor [data-preset]').value==='custom'");
  await check('ProviderNameKeepsOriginalStyle', "(()=>{const e=providerName,s=getComputedStyle(e);return e.classList.contains('provider-edit-name')&&parseFloat(s.fontSize)===28&&Math.abs(e.getBoundingClientRect().height-50)<=1&&['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].every(k=>parseFloat(s[k])===0)&&s.backgroundColor==='rgba(0, 0, 0, 0)'&&e.required&&e.getAttribute('aria-label')==='服务商名称'})()");
  await capture('provider-name-default');
  await act("document.querySelector('#providerMediaEditor').scrollIntoView({block:'center'});");
  await layout('provider1200', ['html','#settingsBody','#settingsModal .set-content','#providerMediaEditor','.media-binding']);
  await check('MediaRowsStartCollapsed', "Array.from(document.querySelectorAll('.media-binding [data-editor]')).every(el=>el.hidden)&&document.querySelector('.media-connection').hidden");
  await capture('provider-media-default');
  await act('mediaFixture.discoveriesBeforeRefresh=mediaFixture.discoveries;');
  await click('#providerDiscover');await waitFor('mediaFixture.discoveries>mediaFixture.discoveriesBeforeRefresh&&!providerDiscover.disabled');
  await click('#providerMediaEditor [data-add]');
  await check('AddMenuOpensBeforeCreatingBinding', "document.querySelector('[data-add-popover]').matches(':popover-open')&&document.querySelectorAll('.media-binding').length===3&&!providerMediaEditor.querySelector('[data-refresh]')&&Array.from(providerMediaEditor.querySelectorAll('.media-catalog-option')).some(row=>row.textContent.includes('brand-new-owner/unrecognized-video'))");
  await click('#providerMediaEditor [data-add-manual]');
  await check('NewBindingRequiresExplicitProtocol', "document.querySelector('.media-binding:last-child [data-protocol]').value===''");
  await fill('.media-binding:last-child [data-id]','synthetic-new-vendor/new-model-2077');
  for(const [width,theme] of [[1200,'light'],[1200,'dark'],[900,'light'],[900,'dark']]){
    await previewViewport(width,theme);
    await act("document.querySelector('.media-binding:last-child [data-template]').nextElementSibling.querySelector('.cs-trigger').scrollIntoView({block:'center',behavior:'instant'});");
    await click('.media-binding:last-child [data-template] + .media-choice .cs-trigger');
    await recordPreview(`provider-template-menu-${theme}-${width}`,['.media-binding:last-child [data-template] + .media-choice .cs-trigger','.media-binding:last-child [data-template] + .media-choice .cs-popup','.media-binding:last-child [data-template] + .media-choice .cs-option']);
    await click('.media-binding:last-child [data-template] + .media-choice .cs-trigger');
  }
  await previewViewport(1200,'light');
  await act("const details=document.querySelector('.media-binding:last-child [data-advanced]');if(!details.open)details.querySelector('summary').click();");
  await click('.media-binding:last-child [data-protocol] + .media-choice .cs-trigger');
  await click('.media-binding:last-child [data-protocol] + .media-choice [data-value="dashscope-video"]');
  await fill('.media-binding:last-child [data-owner]','synthetic-new-vendor');
  await act("mediaFixture.bindingDraft=document.querySelector('.media-binding:last-child [data-json]').value;");
  await click('.media-binding:last-child .media-json-details > summary');
  await fill('.media-binding:last-child [data-json]','{');
  await click('#providerEditorSave');
  await check('MalformedAdvancedConfigKeepsDraftAndBlocksSave', "mediaFixture.writes.length===0&&providerEditorStatus.textContent.includes('JSON 格式不正确')&&document.querySelector('.media-binding:last-child [data-id]').value==='synthetic-new-vendor/new-model-2077'&&uiFixture.errors.length===0");
  await fill('.media-binding:last-child [data-json]', await evaluate('mediaFixture.bindingDraft'));
  await click('#providerMediaEditor [data-connection-toggle]');
  await click('#providerMediaEditor [data-preset] + .media-choice .cs-trigger');
  await click('#providerMediaEditor [data-preset] + .media-choice [data-value=mify]');
  await click('#providerEditorSave');
  await waitFor('mediaFixture.writes.length===1');
  await check('UnknownIdProtocolAndExplicitMifySaved', "(()=>{const v=mediaFixture.writes[0].input,m=v.mediaModels.at(-1);return v.mediaConnection.preset==='mify'&&m.modelId==='synthetic-new-vendor/new-model-2077'&&m.protocol==='dashscope-video'&&m.modality==='video'&&m.ownedBy==='synthetic-new-vendor'&&m.capabilities.operations.join(',')==='text_to_video'&&Object.keys(m.capabilities.defaults).length===0})()");
  await evaluate('closeSettings();showCreateView(true)');
  await waitFor("activeView==='create'&&cvModels.length===4");
  await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(e=>e.textContent.includes('video-not-in-any-catalog-99')).click();");await settle();
  await check('VideoSelectionRendersCapabilityControls', "document.querySelector('#cvMediaParameters [aria-label=\"时长（秒）\"]').tagName==='SELECT'&&document.querySelector('#cvMediaParameters [aria-label=声音]').value===''&&cvCurrentModel().modelId==='another-owner/video-not-in-any-catalog-99'");
  await check('UnsetBooleanIsOmitted', "!Object.hasOwn(cvReadParameters(),'audio')");
  await check('ComposerKeepsParametersInToolbar', "cvMediaParameters.closest('.ib-left')&&!document.querySelector('.media-settings-popover:popover-open')");
  await click('#cvMediaParameters .media-settings-trigger');
  await click('#cvMediaParameters [data-media-parameter=duration] button[data-value="6"]');
  await click('#cvMediaParameters [data-media-parameter=audio] button[data-value=false]');
  await check('NumericEnumAndFalseKeepTypes', "cvReadParameters().duration===6&&cvReadParameters().audio===false");
  await capture('create-video-parameters');
  await click('#cvMediaParameters .media-settings-trigger');
  await act("cvRefImages=[{name:'first.png',dataUrl:mediaFixture.png},{name:'last.png',dataUrl:mediaFixture.png}];cvRenderRef();");
  await check('ReferenceRolesHaveNoImplicitAssignment', "document.querySelectorAll('#cvAttachments select').length===2&&Array.from(document.querySelectorAll('#cvAttachments select')).every(e=>e.value==='')");
  await fill('#cvAttachments [aria-label="参考图 1 角色"]','first_frame');
  await fill('#cvAttachments [aria-label="参考图 2 角色"]','last_frame');
  await fill('#cvPrompt','合成测试：让几何色块轻轻移动。');
  await layout('create1200', ['html','#createView','#cvInputCard','#cvMediaParameters']);
  await capture('create-video-controls');
  await click('#btnGenerate');
  await waitFor('mediaFixture.requests.length===1&&!!document.querySelector("#cvMessages video")&&!cvJobs.size');
  await check('GenerationKeepsIdParametersAndReferenceRoles', "(()=>{const r=mediaFixture.requests[0];return r.model==='fixture::media::synthetic-video'&&r.duration===6&&r.audio===false&&r.references.length===2&&r.references[0].role==='first_frame'&&r.references[1].role==='last_frame'&&r.mediaKind==='video'})()");
  await check('GeneratedVideoHasPlaybackControls', "(()=>{const v=document.querySelector('#cvMessages video');return v.controls&&v.preload==='metadata'&&v.src.endsWith('generated-video.mp4')&&!cvLastResultPath()})()");
  await capture('create-video-result');
  await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(e=>e.textContent.includes('video-range')).click();");await settle();
  await check('NumericRangeUsesNumberInput', "(()=>{const i=document.querySelector('#cvMediaParameters [aria-label=\"时长（秒）\"]');return i.type==='number'&&i.min==='2'&&i.max==='6'&&i.step==='1'})()");
  await click('#cvMediaParameters .media-settings-trigger');
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','99');
  await check('OutOfRangeDurationRejectedLocally', "(()=>{try{cvReadParameters();return false}catch(e){return e.message.includes('时长')}})()");
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','5');
  await check('ValidNumericRangeAndUnsetBooleanPreserved', "cvReadParameters().duration===5&&!Object.hasOwn(cvReadParameters(),'audio')");
  await click('#cvMediaParameters .media-settings-trigger');
  await act("window.sharedMediaErrorCalls=[];const original=RelayActivity.renderError;RelayActivity.renderError=text=>{sharedMediaErrorCalls.push(text);return original(text)};mediaFixture.nextFailure='Invalid request — request_id=fixture-request\\n<script>untrusted text</script>\\n'+Array.from({length:12},(_,index)=>'诊断行 '+index+'：保留服务商返回的完整原因').join('\\n');");
  await fill('#cvPrompt','合成错误与恢复操作检查');await click('#btnGenerate');
  await waitFor("mediaFixture.requests.length===2&&!cvJobs.size&&!!cvMessagesEl.querySelector('.conversation-error-copy')&&btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled");
  await check('CreationFailureReusesConversationErrorComponent',"(()=>{const message=cvMessagesEl.querySelector('.message.error'),error=message.querySelector('.conversation-error'),chat=appendMessage('error',mediaFixture.nextFailure);const same=error.outerHTML===chat.querySelector('.conversation-error').outerHTML;chat.remove();return same&&error.getAttribute('role')==='alert'&&sharedMediaErrorCalls.includes(mediaFixture.nextFailure)&&error.querySelector('.conversation-error-copy').textContent===mediaFixture.nextFailure&&!error.querySelector('script')&&!message.querySelector('.cv-error')})()");
  await check('CreationErrorKeepsOriginalRemoteTaskRecovery',"btnGenerate.dataset.action==='resume'&&btnGenerate.getAttribute('aria-label').includes('继续查询')&&!cvMessagesEl.querySelector('.cv-media-task button')&&!!cvMessagesEl.querySelector('.conversation-error-copy')");
  await click('#btnGenerate');
  await check('ContinueQueriesOriginalTaskWithoutGeneratingAgain',"mediaFixture.actions.length===1&&mediaFixture.actions[0].method==='resume'&&mediaFixture.actions[0].id===mediaFixture.requests[1].runId&&mediaFixture.requests.length===2");
  await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");await click('#btnGenerate');
  await check('StopWaitStillTargetsOriginalTask',"mediaFixture.actions.at(-1).method==='stop'&&mediaFixture.actions.at(-1).id===mediaFixture.requests[1].runId&&mediaFixture.requests.length===2");
  await evaluate("(async()=>{const id=mediaFixture.requests[1].runId;mediaFixture.emitTask(id,{state:'download_failed',remoteState:'succeeded'});const conv=await window.api.history.load(currentCreateConv.id);conv.turns.at(-1).resultPaths=['C:/synthetic-media-fixture/partial-video.mp4'];await window.api.history.save(conv);await loadCreateConv(conv.id,null,{forceReload:true});})()");await settle();
  await waitFor("btnGenerate.dataset.action==='retryDownload'&&!btnGenerate.disabled");
  await check('ReloadKeepsSharedErrorAlongsidePartialMediaAndDownloadAction',"(()=>{const message=cvMessagesEl.querySelector('.message.error');return message.querySelector('.conversation-error-copy').textContent===mediaFixture.nextFailure&&!!message.querySelector('video')&&btnGenerate.dataset.action==='retryDownload'&&!message.querySelector('.cv-media-task button')&&sharedMediaErrorCalls.filter(value=>value===mediaFixture.nextFailure).length>=3})()");
  await click('#btnGenerate');
  await check('DownloadRetryNeverResubmitsGeneration',"mediaFixture.actions.at(-1).method==='retryDownload'&&mediaFixture.actions.at(-1).id===mediaFixture.requests[1].runId&&mediaFixture.requests.length===2");
  // The remote file remains unavailable after this synthetic retry. The host
  // keeps the original diagnostic in history before notifying the renderer.
  await evaluate("(async()=>{mediaFixture.emitTask(mediaFixture.requests[1].runId,{state:'download_failed',remoteState:'succeeded'});await loadCreateConv(currentCreateConv.id,null,{forceReload:true});})()");
  await waitFor("!!cvMessagesEl.querySelector('.conversation-error-copy')&&btnGenerate.dataset.action==='retryDownload'");
  win.setContentSize(900,650);await waitFor('Math.abs(innerWidth-900)<3');await settle();
  await capture('creation-shared-error-light-900');await act("document.documentElement.dataset.theme='dark'");await capture('creation-shared-error-dark-900');
  await check('SharedCreationErrorFitsAndRetainsScrollableDetails',"(()=>{const error=cvMessagesEl.querySelector('.conversation-error'),details=error.querySelector('.conversation-error-copy'),rect=error.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&details.scrollHeight>details.clientHeight&&details.textContent===mediaFixture.nextFailure})()");
  // Exercise the actual composer action button against delayed synthetic IPC.
  win.setContentSize(1200,800);await waitFor('Math.abs(innerWidth-1200)<3');
  await act("document.documentElement.dataset.theme='light';mediaFixture.nextFailure=null;mediaFixture.holdGenerate=true;mediaFixture.stopSettlesGeneration=false;");
  await evaluate('showCreateView(true)');await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes('video-range')).click();");await settle();
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','5');
  await fill('#cvPrompt','合成生成中状态');await click('#btnGenerate');
  await waitFor("mediaFixture.requests.length===3&&btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await act("mediaFixture.controlTaskId=mediaFixture.requests.at(-1).runId;mediaFixture.controlConvId=currentCreateConv.id;mediaFixture.controlRequestCount=mediaFixture.requests.length;");
  await check('GeneratingComposerShowsStopIcon',"btnGenerate.classList.contains('is-stop')&&getComputedStyle(btnGenerate.querySelector('.ico-stop')).display!=='none'&&btnGenerate.getAttribute('aria-label').includes('停止')&&!cvMessagesEl.querySelector('.cv-media-task button')");
  await capture('creation-stop-light-1200');
  await fill('#cvPrompt','运行中保留的新草稿');
  await act("mediaFixture.beforeEnterActions=mediaFixture.actions.length;cvPrompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));");
  await check('RunningDraftKeepsStopAndEnterDoesNotControlTask',"btnGenerate.dataset.action==='stop'&&cvPrompt.value==='运行中保留的新草稿'&&mediaFixture.actions.length===mediaFixture.beforeEnterActions&&mediaFixture.requests.length===mediaFixture.controlRequestCount");
  await act("mediaFixture.holdActions.stop=true;mediaFixture.beforeDoubleStop=mediaFixture.actions.length;btnGenerate.click();btnGenerate.click();");
  await waitFor('!!mediaFixture.pendingActions.stop');
  await check('RepeatedStopClicksAreMutuallyExclusive',"btnGenerate.disabled&&mediaFixture.actions.length===mediaFixture.beforeDoubleStop+1&&mediaFixture.actions.at(-1).method==='stop'&&mediaFixture.actions.at(-1).id===mediaFixture.controlTaskId");
  await act("mediaFixture.releaseAction('stop');");await settle();
  await check('StoppedTaskWaitsForOriginalGenerateToSettle',"mediaFixture.tasks[mediaFixture.controlTaskId].state==='stopped'&&!!mediaFixture.pendingGenerations[mediaFixture.controlTaskId]&&btnGenerate.disabled&&cvPrompt.value==='运行中保留的新草稿'");
  await act("mediaFixture.beforePendingClickActions=mediaFixture.actions.length;btnGenerate.click();cvPrompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));");
  await check('PendingOriginalResponseBlocksResumeAndNewSubmission',"mediaFixture.actions.length===mediaFixture.beforePendingClickActions&&mediaFixture.requests.length===mediaFixture.controlRequestCount");
  await act("mediaFixture.finishGeneration(mediaFixture.controlTaskId);");
  await waitFor("!cvPendingGenerations.has(mediaFixture.controlTaskId)&&!btnGenerate.disabled");
  await check('StoppedDraftBecomesSendWithoutLosingText',"btnGenerate.dataset.action==='generate'&&cvPrompt.value==='运行中保留的新草稿'");
  await fill('#cvPrompt','');await waitFor("btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled");
  win.setContentSize(900,650);await waitFor('Math.abs(innerWidth-900)<3');await act("document.documentElement.dataset.theme='dark'");
  await capture('creation-resume-dark-900');
  await check('EmptyDraftShowsResumeInOriginalSendPosition',"btnGenerate.classList.contains('is-resume')&&getComputedStyle(btnGenerate.querySelector('.ico-resume')).display!=='none'&&btnGenerate.getAttribute('aria-label').includes('继续查询')&&!cvMessagesEl.querySelector('.cv-media-task button')");
  await act("mediaFixture.holdActions.resume=true;mediaFixture.beforeDoubleResume=mediaFixture.actions.length;btnGenerate.click();btnGenerate.click();");
  await waitFor('!!mediaFixture.pendingActions.resume');
  await check('RepeatedResumeClicksAreMutuallyExclusive',"btnGenerate.disabled&&mediaFixture.actions.length===mediaFixture.beforeDoubleResume+1&&mediaFixture.actions.at(-1).method==='resume'&&mediaFixture.actions.at(-1).id===mediaFixture.controlTaskId&&mediaFixture.requests.length===mediaFixture.controlRequestCount");
  await act("mediaFixture.releaseAction('resume');");await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await capture('creation-stop-dark-900');
  await check('ResumingTaskCanBeStoppedAgain',"btnGenerate.classList.contains('is-stop')&&mediaFixture.tasks[mediaFixture.controlTaskId].state==='accepted'&&mediaFixture.requests.length===mediaFixture.controlRequestCount");
  await act("mediaFixture.failNextAction='stop';");await click('#btnGenerate');
  await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await check('StopIpcFailureLeavesButtonRetryable',"mediaFixture.tasks[mediaFixture.controlTaskId].state==='accepted'&&mediaFixture.actions.at(-1).method==='stop'&&mediaFixture.requests.length===mediaFixture.controlRequestCount&&!cvMediaControls.has(mediaFixture.controlTaskId)");
  await click('#btnGenerate');await waitFor("btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled");
  await check('RetryAfterStopIpcFailureUsesOriginalTask',"mediaFixture.actions.at(-1).id===mediaFixture.controlTaskId&&mediaFixture.tasks[mediaFixture.controlTaskId].state==='stopped'&&mediaFixture.requests.length===mediaFixture.controlRequestCount");
  await act("mediaFixture.holdGenerate=false;mediaFixture.stopSettlesGeneration=true;mediaFixture.beforeNewDraftActions=mediaFixture.actions.length;");
  await fill('#cvPrompt','停止后的新请求');await check('NewDraftSelectsSendInsteadOfResume',"btnGenerate.dataset.action==='generate'&&!btnGenerate.disabled");
  await click('#btnGenerate');await waitFor("mediaFixture.requests.length===mediaFixture.controlRequestCount+1&&!cvJobs.has(mediaFixture.controlConvId)");
  await check('NewDraftSubmitsOnceWithoutResumingOldTask',"mediaFixture.actions.length===mediaFixture.beforeNewDraftActions&&mediaFixture.requests.at(-1).runId!==mediaFixture.controlTaskId&&mediaFixture.requests.at(-1).prompt==='停止后的新请求'&&btnGenerate.dataset.action==='generate'");
  // Restored WAITING_USER runs can keep a ledger entry; task state wins.
  await evaluate("(async()=>{await mediaFixture.seedConversation('fixture-other-conv',{id:'stable-media-other',runId:'continuation-run-other'});cvJobs.set('fixture-other-conv',{runId:'continuation-run-other',turnIndex:0,restored:true});await loadCreateConv('fixture-other-conv',null,{forceReload:true});})()");
  await waitFor("btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled");
  await check('WaitingUserLedgerEntryDoesNotForceStop',"mediaFixture.tasks['stable-media-other'].state==='needs_attention'&&btnGenerate.dataset.action==='resume'");
  await act("mediaFixture.emitTask(mediaFixture.controlTaskId,{state:'running'});mediaFixture.beforeOtherResume=mediaFixture.actions.length;");await settle();
  await check('OtherConversationEventDoesNotChangeCurrentAction',"currentCreateConv.id==='fixture-other-conv'&&btnGenerate.dataset.action==='resume'");
  await click('#btnGenerate');await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await check('ContinuationRunControlsStableMediaTaskId',"mediaFixture.actions.length===mediaFixture.beforeOtherResume+1&&mediaFixture.actions.at(-1).method==='resume'&&mediaFixture.actions.at(-1).id==='stable-media-other'");
  await evaluate('showCreateView(true)');await fill('#cvPrompt','');
  await act("mediaFixture.beforeFreshClickActions=mediaFixture.actions.length;mediaFixture.beforeFreshClickRequests=mediaFixture.requests.length;btnGenerate.click();");await settle();
  await check('FreshConversationNeverStopsBackgroundTask',"currentCreateConv.id===null&&btnGenerate.dataset.action==='generate'&&mediaFixture.actions.length===mediaFixture.beforeFreshClickActions&&mediaFixture.requests.length===mediaFixture.beforeFreshClickRequests");
  await evaluate("mediaFixture.completeTask('stable-media-other')");await settle();
  await check('BackgroundCompletionKeepsFreshComposerInSendState',"currentCreateConv.id===null&&btnGenerate.dataset.action==='generate'&&!btnGenerate.classList.contains('is-stop')&&!btnGenerate.classList.contains('is-resume')");
  await evaluate("(async()=>{cvMediaTasks.delete('stable-media-other');await loadCreateConv('fixture-other-conv',null,{forceReload:true});})()");
  await waitFor("btnGenerate.dataset.action==='generate'&&!!cvMessagesEl.querySelector('video')");
  await check('ReloadedCompletedTaskReturnsToSendState',"!btnGenerate.classList.contains('is-stop')&&!btnGenerate.classList.contains('is-resume')&&!cvMessagesEl.querySelector('.cv-media-task button')");
  // Download retry uses the same button, with independent IPC failure recovery.
  await evaluate("(async()=>{await mediaFixture.seedConversation('fixture-download-conv',{id:'stable-download',state:'download_failed',remoteState:'succeeded'},{error:mediaFixture.nextFailure||'合成下载失败',resultPaths:['C:/synthetic-media-fixture/partial-video.mp4']});await loadCreateConv('fixture-download-conv',null,{forceReload:true});})()");
  await waitFor("btnGenerate.dataset.action==='retryDownload'&&!btnGenerate.disabled");
  await act("mediaFixture.failNextAction='retryDownload';mediaFixture.beforeRetryRequests=mediaFixture.requests.length;");await click('#btnGenerate');
  await waitFor("btnGenerate.dataset.action==='retryDownload'&&!btnGenerate.disabled");
  await check('DownloadIpcFailureCanBeRetriedWithoutGeneration',"mediaFixture.tasks['stable-download'].state==='download_failed'&&mediaFixture.requests.length===mediaFixture.beforeRetryRequests&&!cvMediaControls.has('stable-download')");
  await act("mediaFixture.holdActions.retryDownload=true;mediaFixture.beforeDoubleDownload=mediaFixture.actions.length;btnGenerate.click();btnGenerate.click();");
  await waitFor('!!mediaFixture.pendingActions.retryDownload');
  await check('DownloadRetryDoubleClickOnlyInvokesOnce',"btnGenerate.disabled&&mediaFixture.actions.length===mediaFixture.beforeDoubleDownload+1&&mediaFixture.actions.at(-1).method==='retryDownload'&&mediaFixture.actions.at(-1).id==='stable-download'&&mediaFixture.requests.length===mediaFixture.beforeRetryRequests");
  await act("mediaFixture.releaseAction('retryDownload');");await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await check('DownloadInProgressUsesStopPosition',"btnGenerate.classList.contains('is-stop')&&mediaFixture.tasks['stable-download'].state==='downloading'");
  // A ledger run without a media record cannot be sent a fabricated stop call.
  await evaluate("(async()=>{await mediaFixture.seedConversation('fixture-preparing-conv',{id:'not-created-yet',state:'queued'});delete mediaFixture.tasks['not-created-yet'];cvJobs.set('fixture-preparing-conv',{runId:'not-created-yet',turnIndex:0,restored:true});await loadCreateConv('fixture-preparing-conv',null,{forceReload:true});})()");await settle();
  await act("mediaFixture.beforePreparingActions=mediaFixture.actions.length;btnGenerate.click();");
  await check('PreparingLedgerWithoutMediaRecordCannotStop',"btnGenerate.disabled&&mediaFixture.actions.length===mediaFixture.beforePreparingActions");
  // A queued ledger entry is not a remote generation until a media record arrives.
  await evaluate("(async()=>{await mediaFixture.seedConversation('fixture-queued-conv',{id:'queued-media',state:'queued'},{error:''});delete mediaFixture.tasks['queued-media'];registerCreationTask({runId:'queued-media',state:'queued',phase:'queued',kind:'video',source:{type:'creation',conversationId:'fixture-queued-conv',turnIndex:0}});await loadCreateConv('fixture-queued-conv',null,{forceReload:true});})()");await settle();
  await act("mediaFixture.beforeQueuedActions=mediaFixture.actions.length;mediaFixture.beforeQueuedRequests=mediaFixture.requests.length;btnGenerate.click();");
  await check('QueuedLedgerWithoutMediaRecordShowsQueueAndDisablesSend',"(()=>{const label=cvMessagesEl.querySelector('.cv-loading > div:last-child');return !mediaFixture.tasks['queued-media']&&!cvMediaTasks.has('queued-media')&&cvJobs.get('fixture-queued-conv').ledgerState==='queued'&&label?.textContent==='排队中…'&&!cvMessagesEl.textContent.includes('正在生成')&&btnGenerate.disabled&&btnGenerate.getAttribute('aria-label')==='排队中…'&&mediaFixture.actions.length===mediaFixture.beforeQueuedActions&&mediaFixture.requests.length===mediaFixture.beforeQueuedRequests})()");
  await capture('creation-queued-dark-900');
  await act("mediaFixture.emitTask('queued-media',{runId:'queued-media',conversationId:'fixture-queued-conv',turnIndex:0,mediaKind:'video',state:'running',submissionOutcome:'accepted',remoteHandle:{taskId:'queued-remote'}});");
  await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await check('QueuedTaskBecomesStopOnlyAfterMediaRunning',"btnGenerate.classList.contains('is-stop')&&btnGenerate.getAttribute('aria-label')==='停止等待'&&cvMessagesEl.querySelector('.cv-loading > div:last-child')?.textContent==='正在生成视频…'&&mediaFixture.requests.length===mediaFixture.beforeQueuedRequests&&!cvMessagesEl.querySelector('.cv-media-task button')");
  // Unknown submissions never become automatic generation or recovery.
  await evaluate("(async()=>{await mediaFixture.seedConversation('fixture-unknown-conv',{id:'unknown-submission',state:'submission_unknown',submissionOutcome:'submission_unknown',remoteHandle:null},{error:'提交结果未知，请勿重复生成'});await loadCreateConv('fixture-unknown-conv',null,{forceReload:true});})()");await settle();
  await act("mediaFixture.beforeUnknownActions=mediaFixture.actions.length;mediaFixture.beforeUnknownRequests=mediaFixture.requests.length;btnGenerate.click();cvPrompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));");
  await check('UnknownSubmissionNeverResumesOrAutomaticallyGenerates',"btnGenerate.dataset.action!=='resume'&&btnGenerate.dataset.action!=='retryDownload'&&mediaFixture.actions.length===mediaFixture.beforeUnknownActions&&mediaFixture.requests.length===mediaFixture.beforeUnknownRequests&&!cvMessagesEl.querySelector('.cv-media-task button')&&cvMessagesEl.textContent.includes('提交结果未知')");
  // An older history task's late get must not win over the most recent turn.
  await evaluate("(async()=>{const conv=await mediaFixture.seedConversation('fixture-order-conv',{id:'older-media',state:'running'});mediaFixture.tasks['latest-media']={id:'latest-media',runId:'latest-continuation',conversationId:conv.id,turnIndex:1,mediaKind:'video',state:'needs_attention',submissionOutcome:'accepted',remoteHandle:{taskId:'latest-remote'}};conv.turns.push({prompt:'最新待恢复轮',mediaKind:'video',model:'fixture::media::synthetic-numeric',runId:'latest-continuation',mediaTaskId:'latest-media',resultPaths:[],error:'合成最新轮待恢复'});await window.api.history.save(conv);mediaFixture.holdGetIds.add('older-media');await loadCreateConv(conv.id,null,{forceReload:true});})()");
  await waitFor("btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled&&!!mediaFixture.pendingGets['older-media']");
  await act("mediaFixture.releaseGet('older-media');");await settle();
  await check('OlderTaskLookupCannotReplaceLatestTaskAction',"btnGenerate.dataset.action==='resume'&&!btnGenerate.disabled");
  await click('#btnGenerate');await waitFor("btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await check('OutOfOrderHistoryStillTargetsLatestStableTask',"mediaFixture.actions.at(-1).method==='resume'&&mediaFixture.actions.at(-1).id==='latest-media'");
  await check('ComposerControlsNeverReintroduceInlineButtons',"!cvMessagesEl.querySelector('.cv-media-task button')&&btnGenerate.closest('#cvInputCard')!==null");
  // Model, parameter and reference drafts belong to a conversation, not the view.
  await evaluate("(async()=>{mediaFixture.nextFailure=null;const image=mediaFixture.profile.mediaModels.find(model=>model.id==='synthetic-image');image.capabilities.operations=['text_to_image','image_to_image'];image.capabilities.references={max:2};await loadImageModels();await mediaFixture.seedConversation('isolation-video',{id:'isolation-video-old',state:'completed'},{model:'fixture::media::synthetic-video',parameters:{duration:6,resolution:'720p',audio:false},error:'',resultPaths:['C:/synthetic-media-fixture/old-video.mp4']});const imageConv=await mediaFixture.seedConversation('isolation-image',{id:'isolation-image-old',state:'completed',mediaKind:'image'},{model:'fixture::media::synthetic-image',mediaKind:'image',size:'1024x1536',n:2,error:'',resultPaths:['C:/synthetic-media-fixture/old-image.png']});delete imageConv.turns[0].parameters;await window.api.history.save(imageConv);await loadCreateConv('isolation-video',null,{forceReload:true});})()");await settle();
  await check('LegacyVideoHistoryRestoresModelAndParameters',"cvModelValue==='fixture::media::synthetic-video'&&cvReadParameters().duration===6&&cvReadParameters().resolution==='720p'&&cvReadParameters().audio===false");
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','4');
  await fill('#cvPrompt','视频会话独立草稿');
  await act("cvRefImages=[{name:'video-draft.png',dataUrl:mediaFixture.png,role:'first_frame'}];cvRenderRef();");
  await evaluate("loadCreateConv('isolation-image',null,{forceReload:true})");await settle();
  await check('LegacyImageHistoryRestoresLegacySizeParameters',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1024x1536'&&cvReadParameters().n===2&&cvPrompt.value===''&&cvRefImages.length===0");
  await fill('#cvMediaParameters input[aria-label="尺寸"]','1536x1024');
  await fill('#cvPrompt','图片会话独立草稿');
  await act("cvRefImages=[{name:'image-draft.png',dataUrl:mediaFixture.png}];cvRenderRef();");
  await evaluate("loadCreateConv('isolation-video',null,{forceReload:true})");await settle();
  await check('ConversationVideoDraftAndReferencesStayIsolated',"cvModelValue==='fixture::media::synthetic-video'&&cvReadParameters().duration===4&&cvReadParameters().audio===false&&cvPrompt.value==='视频会话独立草稿'&&cvRefImages.length===1&&cvRefImages[0].name==='video-draft.png'&&cvRefImages[0].role==='first_frame'");
  await capture('creation-conversation-video-draft-dark-900');
  await evaluate("loadCreateConv('isolation-image',null,{forceReload:true})");await settle();
  await check('ConversationImageDraftAndReferencesStayIsolated',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1536x1024'&&cvReadParameters().n===2&&cvPrompt.value==='图片会话独立草稿'&&cvRefImages.length===1&&cvRefImages[0].name==='image-draft.png'&&!cvRefImages[0].role");
  await capture('creation-conversation-image-draft-dark-900');
  await waitFor("mediaFixture.composerWrites.some(write=>write.id==='isolation-image'&&write.mediaComposer.parameters.size==='1536x1024')");
  await check('PersistedComposerContainsOnlyModelAndParameters',"(()=>{const writes=mediaFixture.composerWrites.filter(write=>['isolation-video','isolation-image'].includes(write.id));return writes.length>=2&&writes.every(write=>Object.keys(write).every(key=>['id','mediaComposer'].includes(key))&&Object.keys(write.mediaComposer).sort().join(',')==='model,parameters'&&!JSON.stringify(write).includes('data:image')&&!JSON.stringify(write).includes('独立草稿'))})()");
  await evaluate('loadImageModels()');await settle();
  await check('CatalogRefreshPreservesCurrentParameters',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1536x1024'&&cvReadParameters().n===2&&cvPrompt.value==='图片会话独立草稿'&&cvRefImages[0]?.name==='image-draft.png'");
  // Editing next-round inputs must not rewrite the active task's submission snapshot.
  await evaluate("loadCreateConv('isolation-video',null,{forceReload:true})");await settle();
  await act("mediaFixture.holdGenerate=true;mediaFixture.stopSettlesGeneration=true;mediaFixture.isolationRequestStart=mediaFixture.requests.length;mediaFixture.oldVideoSnapshot=JSON.stringify({model:currentCreateConv.turns[0].model,parameters:currentCreateConv.turns[0].parameters});");
  await click('#btnGenerate');await waitFor("mediaFixture.requests.length===mediaFixture.isolationRequestStart+1&&btnGenerate.dataset.action==='stop'&&!btnGenerate.disabled");
  await act("mediaFixture.isolationActiveId=mediaFixture.requests.at(-1).runId;mediaFixture.activeVideoSnapshot=JSON.stringify({model:currentCreateConv.turns.at(-1).model,parameters:currentCreateConv.turns.at(-1).parameters,mediaKind:currentCreateConv.turns.at(-1).mediaKind});");
  await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes('image-future-42')).click();");await settle();
  await fill('#cvMediaParameters input[aria-label="尺寸"]','1792x1024');
  await fill('#cvPrompt','同一会话下一轮改为图片');
  await check('ActiveGenerationSnapshotIsIndependentOfComposerEdits',"cvModelValue==='fixture::media::synthetic-image'&&btnGenerate.dataset.action==='stop'&&mediaFixture.tasks[mediaFixture.isolationActiveId].state==='running'&&JSON.stringify({model:currentCreateConv.turns[0].model,parameters:currentCreateConv.turns[0].parameters})===mediaFixture.oldVideoSnapshot&&JSON.stringify({model:currentCreateConv.turns.at(-1).model,parameters:currentCreateConv.turns.at(-1).parameters,mediaKind:currentCreateConv.turns.at(-1).mediaKind})===mediaFixture.activeVideoSnapshot&&mediaFixture.requests.at(-1).model==='fixture::media::synthetic-video'&&mediaFixture.requests.at(-1).duration===4");
  await evaluate("loadCreateConv('isolation-image',null,{forceReload:true})");await settle();
  await check('BackgroundVideoDoesNotChangeImageConversationDraft',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1536x1024'&&cvPrompt.value==='图片会话独立草稿'&&cvRefImages[0]?.name==='image-draft.png'&&btnGenerate.dataset.action==='generate'");
  await evaluate("loadCreateConv('isolation-video',null,{forceReload:true})");await settle();
  await check('ActiveConversationKeepsNextModelDraftAfterNavigation',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1792x1024'&&cvPrompt.value==='同一会话下一轮改为图片'&&btnGenerate.dataset.action==='stop'");
  await click('#btnGenerate');await waitFor("!cvPendingGenerations.has(mediaFixture.isolationActiveId)&&!btnGenerate.disabled");
  await check('DifferentComposerModelStillStopsOriginalMediaTask',"mediaFixture.actions.at(-1).method==='stop'&&mediaFixture.actions.at(-1).id===mediaFixture.isolationActiveId&&btnGenerate.dataset.action==='generate'&&cvPrompt.value==='同一会话下一轮改为图片'");
  await act('mediaFixture.holdGenerate=false;');await click('#btnGenerate');await waitFor("mediaFixture.requests.length===mediaFixture.isolationRequestStart+2&&!cvJobs.has('isolation-video')");
  await check('NextRoundUsesNewModelWithoutRewritingPreviousRound',"(()=>{const turns=currentCreateConv.turns,request=mediaFixture.requests.at(-1);return request.model==='fixture::media::synthetic-image'&&request.mediaKind==='image'&&request.size==='1792x1024'&&JSON.stringify({model:turns[0].model,parameters:turns[0].parameters})===mediaFixture.oldVideoSnapshot&&JSON.stringify({model:turns[1].model,parameters:turns[1].parameters,mediaKind:turns[1].mediaKind})===mediaFixture.activeVideoSnapshot&&turns[2].model==='fixture::media::synthetic-image'})()");
  // Simulate reopening B without its in-memory text/reference draft.
  await act("cvComposerDrafts.delete('isolation-image');");
  await evaluate("loadCreateConv('isolation-image',null,{forceReload:true})");await settle();
  await check('PersistedComposerRestoresWithoutPersistingPromptOrReferences',"cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1536x1024'&&cvReadParameters().n===2&&cvPrompt.value===''&&cvRefImages.length===0");
  await fill('#cvPrompt','失效模型保持原选择');
  await act("mediaFixture.removedImageModel=mediaFixture.profile.mediaModels.find(model=>model.id==='synthetic-image');mediaFixture.profile.mediaModels=mediaFixture.profile.mediaModels.filter(model=>model.id!=='synthetic-image');mediaFixture.beforeMissingModelRequests=mediaFixture.requests.length;");
  await evaluate('loadImageModels()');await settle();await click('#btnGenerate');
  await check('DeletedModelIsNotSilentlyReplaced',"cvModelValue==='fixture::media::synthetic-image'&&!cvCurrentModel()?.ok&&btnGenerate.disabled&&cvPrompt.value==='失效模型保持原选择'&&mediaFixture.requests.length===mediaFixture.beforeMissingModelRequests");
  await act('mediaFixture.profile.mediaModels.unshift(mediaFixture.removedImageModel);');await evaluate('loadImageModels()');await settle();
  await check('RestoredCatalogRecoversPreservedModelParameters',"cvCurrentModel()?.ok&&cvModelValue==='fixture::media::synthetic-image'&&cvReadParameters().size==='1536x1024'&&cvReadParameters().n===2&&cvPrompt.value==='失效模型保持原选择'");
  // Incomplete custom dimensions stay in memory but must not replace valid saved parameters.
  await fill('#cvMediaParameters [data-media-size-picker]','__custom__');
  await fill('#cvMediaParameters [data-dimension="height"]','');
  await fill('#cvMediaParameters [data-dimension="width"]','1234');
  await evaluate("loadCreateConv('isolation-video',null,{forceReload:true})");await settle();
  await evaluate("loadCreateConv('isolation-image',null,{forceReload:true})");await settle();
  await check('IncompleteSizeDraftSurvivesConversationNavigation',"(()=>{const width=cvMediaParameters.querySelector('[data-dimension=width]'),height=cvMediaParameters.querySelector('[data-dimension=height]');let invalid=false;try{cvReadParameters()}catch(_){invalid=true}return width.value==='1234'&&height.value===''&&!width.parentElement.hidden&&invalid&&mediaFixture.composerSnapshots.get('isolation-image')?.parameters.size==='1536x1024'})()");
  await click('#cvMediaParameters .media-settings-trigger');
  await click('#cvMediaParameters .media-settings-reset');
  await check('RestoredParameterResetUsesProviderDefaults',"cvReadParameters().size==='640x640'&&!Object.hasOwn(cvReadParameters(),'n')");
  await click('#cvMediaParameters .media-settings-trigger');
  // The first save assigns an id after the user has already edited the next draft.
  await evaluate('showCreateView(true)');await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes('image-future-42')).click();");await settle();
  await fill('#cvPrompt','首次保存中的图片请求');
  await act("mediaFixture.holdGenerate=true;mediaFixture.holdNextHistorySave=true;mediaFixture.beforeFirstSaveRace=mediaFixture.requests.length;");
  await click('#btnGenerate');await waitFor('!!mediaFixture.pendingHistorySave');
  await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes('video-not-in-any-catalog-99')).click();");await settle();
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','6');
  await fill('#cvPrompt','保存未完成时新写的视频草稿');
  await act("mediaFixture.releaseHistorySave();");
  await waitFor("mediaFixture.requests.length===mediaFixture.beforeFirstSaveRace+1&&btnGenerate.dataset.action==='stop'");
  await check('FirstHistorySaveCannotOverwriteNewerComposerDraft',"currentCreateConv.id!==null&&cvModelValue==='fixture::media::synthetic-video'&&cvReadParameters().duration===6&&cvPrompt.value==='保存未完成时新写的视频草稿'&&mediaFixture.requests.at(-1).model==='fixture::media::synthetic-image'&&mediaFixture.requests.at(-1).prompt==='首次保存中的图片请求'&&cvComposerDrafts.get(currentCreateConv.id)?.model==='fixture::media::synthetic-video'&&cvComposerDrafts.get(currentCreateConv.id)?.prompt==='保存未完成时新写的视频草稿'");
  await act('mediaFixture.firstSaveRaceId=mediaFixture.requests.at(-1).runId;');
  await click('#btnGenerate');await waitFor('!cvPendingGenerations.has(mediaFixture.firstSaveRaceId)');
  await act('mediaFixture.holdGenerate=false;');
  // A background refresh must apply the current draft, not its earlier history snapshot.
  await evaluate("(async()=>{await mediaFixture.seedConversation('isolation-reload-race',{id:'reload-race-old',state:'completed',mediaKind:'image'},{model:'fixture::media::synthetic-image',mediaKind:'image',parameters:{size:'1024x1024',n:1},error:'',resultPaths:['C:/synthetic-media-fixture/reload-race.png']});await loadCreateConv('isolation-reload-race',null,{forceReload:true});})()");await settle();
  await act("mediaFixture.holdNextHistoryLoadId='isolation-reload-race';window.delayedCreationReload=loadCreateConv('isolation-reload-race',null,{forceReload:true});");
  await waitFor('!!mediaFixture.pendingHistoryLoad');
  await click('#cvModelTrigger');
  await act("Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes('video-not-in-any-catalog-99')).click();");await settle();
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','6');
  await fill('#cvPrompt','历史重载期间新写的草稿');
  await act("mediaFixture.releaseHistoryLoad();");await evaluate('window.delayedCreationReload');await settle();
  await check('DelayedHistoryReloadPreservesNewerComposerSelection',"currentCreateConv.id==='isolation-reload-race'&&cvModelValue==='fixture::media::synthetic-video'&&cvReadParameters().duration===6&&cvPrompt.value==='历史重载期间新写的草稿'&&currentCreateConv.turns[0].model==='fixture::media::synthetic-image'&&currentCreateConv.turns[0].parameters.size==='1024x1024'");
  // Use the real history-row delete action with one metadata IPC in flight and one queued.
  await evaluate("(async()=>{await mediaFixture.seedConversation('isolation-delete-race',{id:'delete-race-old',state:'completed'},{error:'',resultPaths:['C:/synthetic-media-fixture/delete-race.mp4']});await loadCreateConv('isolation-delete-race',null,{forceReload:true});})()");await settle();
  await act('mediaFixture.holdNextComposerWrite=true;');
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','4');await waitFor('!!mediaFixture.pendingComposerWrite');
  await fill('#cvMediaParameters [aria-label="时长（秒）"]','6');await fill('#cvPrompt','待删除的独立草稿');
  await act("mediaFixture.deleteRaceWritePromise=cvComposerWrites.get('isolation-delete-race').promise;mediaFixture.beforeDeleteComposerWrites=mediaFixture.composerWrites.filter(write=>write.id==='isolation-delete-race').length;");
  await evaluate('refreshHistoryList()');await waitFor("!!document.querySelector('.history-item[data-id=\"isolation-delete-race\"] .hi-del')");
  await click('.history-item[data-id="isolation-delete-race"] .hi-del');
  await waitFor("!!document.querySelector('.confirm-overlay .confirm-btn.danger')");await click('.confirm-overlay .confirm-btn.danger');
  await waitFor("mediaFixture.deletedHistory.has('isolation-delete-race')&&!document.querySelector('.history-item[data-id=\"isolation-delete-race\"]')&&currentCreateConv.id===null");
  await check('DeletingCreationConversationClearsComposerDraftAndQueuedWrites',"mediaFixture.historyDeletes.at(-1)==='isolation-delete-race'&&!cvComposerDrafts.has('isolation-delete-race')&&!cvComposerWrites.has('isolation-delete-race')&&cvComposerOwner?.id!=='isolation-delete-race'&&cvPrompt.value===''&&document.getElementById('appToast').textContent==='会话已删除。'");
  await act('mediaFixture.releaseComposerWrite();');await evaluate('mediaFixture.deleteRaceWritePromise');await settle();
  await check('DeletedConversationLateWriteIsSilentAndNeverDispatchesQueuedWrite',"mediaFixture.composerWrites.filter(write=>write.id==='isolation-delete-race').length===mediaFixture.beforeDeleteComposerWrites&&!mediaFixture.composerSnapshots.has('isolation-delete-race')&&!cvComposerWrites.has('isolation-delete-race')&&document.getElementById('appToast').textContent==='会话已删除。'&&!document.querySelector('.history-item[data-id=\"isolation-delete-race\"]')");
  // Preview real capability schemas without submitting any generation request.
  await waitFor("!document.querySelector('#appToast.show')");
  const previewPresets=getMediaProtocolPresets().capabilities;
  for(const [id,label,template,menu] of [['synthetic-image','合成图像参数预览','openai-image','size'],['synthetic-video','合成视频参数预览','seedance-2.5-video','ratio']]){
    const capabilities=previewPresets.find(item=>item.id===template).capabilities;
    await act(`const model=mediaFixture.profile.mediaModels.find(item=>item.id===${JSON.stringify(id)});model.label=${JSON.stringify(label)};model.capabilities=${JSON.stringify(capabilities)};`);
    await evaluate('loadImageModels()');await evaluate('showCreateView(true)');await click('#cvModelTrigger');
    await act(`Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes(${JSON.stringify(label)})).click();`);await settle();
    for(const [width,theme] of [[1200,'light'],[1200,'dark'],[900,'light'],[900,'dark']]){
      await previewViewport(width,theme);await click('#cvMediaParameters .media-settings-trigger');
      await recordPreview(`creation-${menu}-parameters-${theme}-${width}`,['#cvInputCard','#cvMediaParameters .media-settings-popover','#cvMediaParameters .media-parameter-field','#cvMediaParameters .media-parameter-stepper']);
      const trigger=`#cvMediaParameters [data-media-parameter="${menu}"] .media-parameter-select-trigger`;
      await click(trigger);
      await recordPreview(`creation-${menu}-menu-${theme}-${width}`,['#cvMediaParameters .media-settings-popover',trigger,`#cvMediaParameters [data-media-parameter="${menu}"] .cs-popup`,`#cvMediaParameters [data-media-parameter="${menu}"] .cs-option`]);
      await click(trigger);
      if(menu==='size'){
        await fill('#cvMediaParameters [data-media-size-picker]','__custom__');
        await fill('#cvMediaParameters [data-dimension="width"]','2048');await fill('#cvMediaParameters [data-dimension="height"]','1536');
        await recordPreview(`creation-custom-size-${theme}-${width}`,['#cvMediaParameters .media-settings-popover','#cvMediaParameters .media-parameter-dimensions','#cvMediaParameters [data-dimension="width"]','#cvMediaParameters [data-dimension="height"]']);
      }
      await click('#cvMediaParameters .media-settings-reset');await click('#cvMediaParameters .media-settings-trigger');
    }
  }
  await check('ActualRendererHasNoUnhandledErrors','uiFixture.errors.length===0');
  clearTimeout(deadline);step='complete';save();console.log(JSON.stringify({passed:Object.keys(checks).length,output}));app.exit(0);
}).catch(async error=>{clearTimeout(deadline);errors.push(error.stack||String(error));if(win){try{errors.push(await evaluate('JSON.stringify({rendererErrors:window.uiFixture?.errors,viewType:typeof activeView,body:document.body.textContent.slice(0,200)})'));await capture('failure');}catch(_){}}save();console.error(error);app.exit(1);});
