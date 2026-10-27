'use strict';
// Actual Electron renderer, isolated synthetic gateways and no network calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getMediaProtocolPresets } = require('../src/main/providers/provider-media');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.codex-tmp/media-setup-simplification/ui'));
fs.mkdirSync(output, { recursive: true });app.setPath('userData', path.join(output, 'profile'));app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [], layouts = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, layouts, step }, null, 2));
const deadline = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const waitFor = code => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`);
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function fill(selector, value) { await act(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));`); await settle(); }
async function selectParameter(selector,value) { await fill(selector,value);await act(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}));`);await settle(); }
async function key(code) { code=({ArrowDown:'Down',ArrowUp:'Up'})[code]||code;win.webContents.sendInputEvent({type:'keyDown',keyCode:code});if(code==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:code});win.webContents.sendInputEvent({type:'keyUp',keyCode:code});await settle(); }
async function check(name, expression) { step=name;checks[name]=!!await evaluate(expression);save();console.log(`${checks[name]?'PASS':'FAIL'} ${name}`);if(!checks[name])throw Error(name); }
async function capture(name) { await settle();await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}})');await evaluate('new Promise(resolve=>setTimeout(resolve,250))');await settle();fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()); }
function fixture(presets) {
  const base=window.api, clone=value=>JSON.parse(JSON.stringify(value));
  const saved={id:'saved-manual',modelId:'saved/custom-image',label:'已配置的图片',protocol:'openai-images',modality:'image',enabled:true,
    endpoints:{generate:'/custom/images'},routeHeaders:{'x-custom-route':'keep'},editTransport:'json-images',
    capabilities:{operations:['text_to_image'],parameters:{size:{enum:['777x777']}},defaults:{size:'777x777'},references:{max:0}}};
  const imageConfig={protocol:'openai-images',capabilities:{operations:['text_to_image'],parameters:{size:{enum:['640x640','1024x1024']},n:{min:1,max:2,integer:true}},defaults:{size:'640x640',n:1},references:{max:0}}};
  const videoConfig={protocol:'ark-video',capabilities:{operations:['text_to_video'],parameters:{duration:{enum:[3,7],integer:true},audio:{type:'boolean'}},defaults:{duration:3,audio:false},references:{max:0}}};
  const catalog=[
    {id:'future/image',ownedBy:'gateway-a',modality:'image',modelType:'image',mediaConfig:imageConfig},
    {id:'shared/video',ownedBy:'gateway-a',modality:'video',modelType:'video',mediaConfig:videoConfig},
    {id:'shared/video',ownedBy:'gateway-b',modality:'video',modelType:'video',mediaConfig:{...clone(videoConfig),capabilities:{...clone(videoConfig.capabilities),defaults:{duration:7,audio:false}}}},
    {id:'unrecognized/image',ownedBy:'gateway-z',modality:'image',modelType:'image'},
    {id:'doubao-seedance-name-is-not-proof',ownedBy:'gateway-z',modality:'video',modelType:'video'},
    {id:'saved/custom-image',ownedBy:'',modality:'image',modelType:'image',mediaConfig:imageConfig},
  ];
  const state=window.mediaSetupFixture={catalog,untypedCatalog:[{id:'plain-model',ownedBy:'generic-gateway'}],mediaCandidates:[{id:'plain-model',ownedBy:'generic-gateway'},{id:'plain-model',ownedBy:'alternate-gateway'}],holdPresets:false,holdSave:false,releasePresets:null,releaseSave:null,original:clone(saved),savedCount:0,discoveries:[],writes:[],failSave:false,listeners:[],
    profile:{id:'fixture',name:'多网关媒体',revision:1,baseUrl:'https://gateway.example.invalid/anthropic',hasCredential:true,credentialHint:'已保存',enabled:true,chatReady:true,activeTiers:['haiku','sonnet','opus'],activeImageAdapters:[],imageModels:[],models:{haiku:'chat/fast',sonnet:'chat/balanced',opus:'chat/expert'},defaultModel:'opus',routed:true,mediaConnection:{preset:'custom',baseUrl:'https://gateway.example.invalid/media',headers:{'x-tenant-id':'existing-tenant'}},mediaModels:[clone(saved)]},
  };
  const providers=new Proxy(base.providers,{get(target,key){
    if(key==='list')return async()=>({ok:true,profiles:[clone(state.profile)],routes:clone(uiFixture.routes)});
    if(key==='mediaPresets')return async()=>{if(state.holdPresets)await new Promise(resolve=>{state.releasePresets=()=>{state.releasePresets=null;resolve();};});return{ok:true,...clone(presets)};};
    if(key==='onChanged')return callback=>{state.listeners.push(callback);return()=>{};};
    if(key==='discoverModels'||key==='discoverDraftModels')return async request=>{state.discoveries.push(clone({key,request}));return {ok:true,models:['chat/fast'],modelCatalog:clone(state.untypedCatalog),mediaCandidates:clone(state.mediaCandidates),mediaModels:clone(state.catalog),imageModels:[],profile:clone(state.profile)};};
    if(key==='update')return async(id,input)=>{state.writes.push(clone(input));if(state.holdSave)await new Promise(resolve=>{state.releaseSave=()=>{state.releaseSave=null;resolve();};});if(state.failSave)return{ok:false,code:'PROVIDER_STORAGE_WRITE_FAILED',message:'配置文件暂时无法替换，请重试。'};state.profile={...state.profile,...clone(input),revision:state.profile.revision+1};delete state.profile.apiKey;state.savedCount++;return{ok:true,profile:clone(state.profile)};};
    return target[key];
  }});
  window.api=new Proxy(base,{get:(target,key)=>key==='providers'?providers:target[key]});
}
async function catalogCheck(id, owner, keyboard=false) {
  const value=JSON.stringify([id,owner]);
  await act(`const input=Array.from(providerMediaEditor.querySelectorAll('[data-catalog-check]')).find(el=>el.value===${JSON.stringify(value)});if(!input)throw Error('Missing catalog row');input.scrollIntoView({block:'nearest'});${keyboard?'input.focus();':'input.click();'}`);
  if(keyboard)await key('Space');else await settle();
}
async function chooseTemplate(index, value) {
  await act(`const row=providerMediaEditor.querySelectorAll('.media-binding')[${index}];if(row.querySelector('[data-editor]').hidden)row.querySelector('[data-edit]').click();`);await settle();
  const prefix=`#providerMediaEditor .media-binding:nth-child(${index+1})`;
  await click(prefix+' [data-template] + .media-choice .cs-trigger');
  await click(prefix+` [data-template] + .media-choice [data-value="${value}"]`);
}
async function layout(name,width,theme,menu=false) {
  win.setContentSize(width,width<=900?650:800);await waitFor(`Math.abs(innerWidth-${width})<=2`);
  await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};closeCustomSelect();providerMediaEditor.scrollIntoView({block:'center',behavior:'instant'});`);await settle();
  if(menu&&!await evaluate("providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')"))await click('#providerMediaEditor [data-add]');
  layouts[name]=await evaluate(`(()=>{const elements=[providerMediaEditor,...providerMediaEditor.querySelectorAll('.media-binding-summary')];const menu=providerMediaEditor.querySelector('[data-add-popover]');if(menu.matches(':popover-open'))elements.push(menu);return elements.map(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,menu:el===menu}})})()`);save();
  await check(name+'FitsViewport',JSON.stringify(layouts[name].every(r=>r.left>=-1&&r.right<=width+1&&r.scrollWidth<=r.clientWidth+1&&(!r.menu||(r.top>=0&&r.bottom<=(width<=900?650:800)+1)))));
  await capture(name);
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const base=pathToFileURL(path.join(root,'renderer')+path.sep).href;
  const fixtures=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',()=>'<head><base href="'+base+'"><script>'+fixtures+'\n('+fixture.toString()+')('+JSON.stringify(getMediaProtocolPresets())+');localStorage.clear();</script>');
  const file=path.join(output,'fixture.html');fs.writeFileSync(file,html);
  win=new BrowserWindow({width:1200,height:800,useContentSize:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#fafafa',symbolColor:'#111111',height:40},show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(file);win.showInactive();win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns');await evaluate("openSettings('providers')");await waitFor("!!document.querySelector('[data-provider-act=edit]')");await click('[data-provider-act=edit]');
  await waitFor("!providerMediaEditor.querySelector('[data-refresh]')&&!providerDiscover.disabled&&!providerMediaEditor.querySelector('[data-add]').disabled");
  await check('SingleRefreshEntryIsAvailableWithoutDuplicateMediaButton',"!!providerDiscover&&!providerDiscover.disabled&&!providerMediaEditor.querySelector('[data-refresh]')");
  await act("window.setupRows=()=>Array.from(providerMediaEditor.querySelectorAll('.media-binding'),row=>JSON.parse(row.querySelector('[data-json]').value));mediaSetupFixture.beforeRefresh=mediaSetupFixture.discoveries.length;");
  await click('#providerDiscover');await waitFor('!providerDiscover.disabled');
  await check('MediaRefreshLoadsCandidatesWithoutEditingSavedBinding',"mediaSetupFixture.discoveries.length===mediaSetupFixture.beforeRefresh+1&&setupRows().length===1&&JSON.stringify(setupRows()[0].capabilities)===JSON.stringify(mediaSetupFixture.original.capabilities)&&setupRows()[0].endpoints.generate==='/custom/images'&&mediaSetupFixture.writes.length===0");
  await check('GatewayConfigIsInheritedWithoutGuessingFromNames',"providerMediaEditor.querySelector('[data-preset]').value==='custom'&&JSON.parse(providerMediaEditor.querySelector('[data-connection]').value).headers['x-tenant-id']==='existing-tenant'");
  await click('#providerMediaEditor [data-add]');
  await check('CatalogStartsWithCheckboxesAndNoAutomaticInsert',"providerMediaEditor.querySelectorAll('[data-catalog-check]').length===8&&setupRows().length===1&&providerMediaEditor.querySelector('[data-add-selected]').disabled");
  await catalogCheck('future/image','gateway-a',true);await fill('#providerMediaEditor [data-search]','shared/video');
  await catalogCheck('shared/video','gateway-a');await catalogCheck('shared/video','gateway-b');await fill('#providerMediaEditor [data-search]','');
  await check('SearchKeepsSelectionsAcrossFiltersAndSeparateOwners',"providerMediaEditor.querySelectorAll('[data-catalog-check]:checked:not(:disabled)').length===3&&setupRows().length===1&&!providerMediaEditor.querySelector('[data-add-selected]').disabled");
  await layout('batch-add-light-1200',1200,'light',true);
  await click('#providerMediaEditor [data-add-selected]');
  await check('BatchAddUsesDeclaredProtocolsAndCapabilities',"(()=>{const rows=setupRows(),a=rows.find(x=>x.modelId==='future/image'),videos=rows.filter(x=>x.modelId==='shared/video');return rows.length===4&&a.protocol==='openai-images'&&a.capabilities.defaults.size==='640x640'&&videos.length===2&&videos.every(x=>x.protocol==='ark-video'&&x.capabilities.defaults.audio===false)&&videos.find(x=>x.ownedBy==='gateway-a').capabilities.defaults.duration===3&&videos.find(x=>x.ownedBy==='gateway-b').capabilities.defaults.duration===7})()");
  await check('RecognizedRowsNeedNoTemplateConfirmation',"Array.from(providerMediaEditor.querySelectorAll('.media-binding [data-editor]')).every(el=>el.hidden)&&mediaSetupFixture.writes.length===0");
  await click('#providerMediaEditor .media-binding:nth-child(2) [data-edit]');
  await check('AutomaticSetupKeepsProtocolAndJsonUnderAdvanced',"(()=>{const row=providerMediaEditor.querySelector('.media-binding:nth-child(2)');return row.querySelector('[data-template]').selectedOptions[0].textContent==='自动识别'&&!row.querySelector('[data-advanced]').open&&row.querySelector('[data-advanced]').contains(row.querySelector('[data-protocol]'))&&row.querySelector('[data-defaults] [data-media-parameter=n]').checkVisibility()})()");
  await click('#providerMediaEditor .media-binding:nth-child(2) [aria-label="增加数量"]');
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-edit]');
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-media-parameter=duration] [data-value="7"]');
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-media-parameter=audio] [data-value="true"]');
  await check('CommonControlsUpdateTypedDefaultsWithoutChangingAnotherOwner',"setupRows()[1].capabilities.defaults.n===2&&setupRows()[2].capabilities.defaults.duration===7&&setupRows()[2].capabilities.defaults.audio===true&&setupRows()[3].capabilities.defaults.duration===7&&setupRows()[3].capabilities.defaults.audio===false");
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-media-parameter=duration] [data-value="3"]');
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-media-parameter=audio] [data-value="false"]');
  await click('#providerMediaEditor .media-binding:nth-child(3) [data-done]');
  await click('#providerMediaEditor [data-add]');
  await check('AlreadyAddedIdentitiesAreDisabledWithoutDroppingDifferentOwner',"providerMediaEditor.querySelectorAll('[data-catalog-check]:disabled').length===4&&providerMediaEditor.querySelector('[data-add-selected]').disabled");
  await catalogCheck('unrecognized/image','gateway-z');await catalogCheck('doubao-seedance-name-is-not-proof','gateway-z');await click('#providerMediaEditor [data-add-selected]');
  await check('UnknownModelsRemainUnconfiguredEvenWithRecognizableNames',"setupRows().length===6&&setupRows().slice(-2).every(x=>!x.protocol)&&Array.from(providerMediaEditor.querySelectorAll('[data-editor]')).filter(x=>!x.hidden).length===1");
  await click('#providerEditorSave');
  await check('UnknownModelRequiresOneTemplateBeforeSave',"mediaSetupFixture.writes.length===0&&providerEditorStatus.textContent.includes('模板')&&setupRows().length===6");
  await chooseTemplate(4,'protocol-openai-images');
  await check('OneTemplateChoiceFillsProtocolAndConservativeCapabilities',"setupRows()[4].protocol==='openai-images'&&setupRows()[4].capabilities.operations.join(',')==='text_to_image'&&Object.keys(setupRows()[4].capabilities.defaults).length===0&&setupRows()[4].modelId==='unrecognized/image'");
  await chooseTemplate(5,'seedance-2.5-video');
  await check('OneVideoTemplateChoiceFillsProtocolWithoutOwnerRewrite',"setupRows()[5].protocol==='ark-video'&&setupRows()[5].ownedBy==='gateway-z'&&setupRows()[5].capabilities.defaults.duration===4");
  await layout('template-light-900',900,'light');await layout('template-dark-900',900,'dark');
  await click('#providerMediaEditor [data-add]');await catalogCheck('plain-model','generic-gateway');await catalogCheck('plain-model','alternate-gateway');await click('#providerMediaEditor [data-add-selected]');
  await check('UntypedStandardGatewayCatalogOffersImageAndVideoTemplates',"(()=>{const row=providerMediaEditor.querySelector('.media-binding:last-child'),options=Array.from(row.querySelector('[data-template]').options,option=>option.value);return setupRows().length===8&&!setupRows()[6].protocol&&!setupRows()[6].modality&&options.includes('protocol-openai-images')&&options.includes('protocol-ark-video')})()");
  await chooseTemplate(6,'protocol-ark-video');
  await check('UntypedGatewayCanBecomeVideoWithOneTemplateSelection',"setupRows()[6].modelId==='plain-model'&&setupRows()[6].ownedBy==='generic-gateway'&&setupRows()[6].protocol==='ark-video'&&setupRows()[6].modality==='video'&&setupRows()[6].capabilities.operations.join(',')==='text_to_video'");
  await chooseTemplate(7,'protocol-openai-images');
  await check('ExactMediaCandidatesPreserveOwnersCollapsedByChatCatalog',"mediaSetupFixture.untypedCatalog.length===1&&setupRows().filter(row=>row.modelId==='plain-model').length===2&&setupRows()[6].ownedBy==='generic-gateway'&&setupRows()[6].protocol==='ark-video'&&setupRows()[7].ownedBy==='alternate-gateway'&&setupRows()[7].protocol==='openai-images'");
  await act("mediaSetupFixture.beforeRefreshBindings=JSON.stringify(setupRows());mediaSetupFixture.catalog[0].mediaConfig.capabilities.defaults.size='1024x1024';");await click('#providerDiscover');await waitFor('!providerDiscover.disabled');
  await check('RefreshNeverOverwritesExistingOrNewDraftCapabilities',"JSON.stringify(setupRows())===mediaSetupFixture.beforeRefreshBindings&&setupRows()[0].routeHeaders['x-custom-route']==='keep'&&setupRows()[0].editTransport==='json-images'&&setupRows()[1].capabilities.defaults.size==='640x640'");
  await click('#providerMediaEditor .media-binding:last-child [data-done]');
  await check('CollapseLabelDoesNotPretendToSave',"providerMediaEditor.querySelector('[data-done]').textContent.trim()==='收起'&&mediaSetupFixture.writes.length===0");
  await layout('configured-light-1200',1200,'light');await layout('configured-light-900',900,'light');await layout('configured-dark-900',900,'dark');
  await layout('batch-add-dark-900',900,'dark',true);
  await key('Escape');
  await check('BatchPickerEscapeRestoresFocus',"!providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')&&document.activeElement===providerMediaEditor.querySelector('[data-add]')");
  await act('mediaSetupFixture.failSave=true;mediaSetupFixture.draftBeforeSave=JSON.stringify(setupRows());');
  await click('#providerEditorSave');await waitFor('!providerEditorSave.disabled');
  await check('FailedSaveKeepsAllBatchDraftsAndAdvancedConfig',"mediaSetupFixture.savedCount===0&&setupRows().length===8&&JSON.stringify(setupRows())===mediaSetupFixture.draftBeforeSave&&providerEditorStatus.textContent.includes('当前填写内容已保留')&&JSON.parse(providerMediaEditor.querySelector('[data-connection]').value).baseUrl==='https://gateway.example.invalid/media'");
  await act('mediaSetupFixture.failSave=false;');await click('#providerEditorSave');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await check('SaveCommitsAllSelectedModelsOnceAcrossGateways',"mediaSetupFixture.savedCount===1&&mediaSetupFixture.profile.mediaModels.length===8&&mediaSetupFixture.writes.length===2&&JSON.stringify(mediaSetupFixture.writes[0])===JSON.stringify(mediaSetupFixture.writes[1])&&mediaSetupFixture.profile.mediaConnection.preset==='custom'&&mediaSetupFixture.profile.mediaConnection.headers['x-tenant-id']==='existing-tenant'");
  await check('SameModelOwnersHaveIndependentPreservedConfiguration',"(()=>{const rows=mediaSetupFixture.profile.mediaModels.filter(x=>x.modelId==='shared/video');return rows.length===2&&rows.find(x=>x.ownedBy==='gateway-a').capabilities.defaults.duration===3&&rows.find(x=>x.ownedBy==='gateway-b').capabilities.defaults.duration===7})()");
  await act('mediaSetupFixture.beforeCachedReopen=mediaSetupFixture.discoveries.length;');
  await click('[data-provider-act=edit]');await waitFor("!providerMediaEditor.querySelector('[data-add]').disabled&&!providerDiscover.disabled");
  await click('#providerMediaEditor [data-add]');
  await check('CachedReopenRetainsBothMediaCandidateOwnersWithoutDiscovery',"(()=>{const entries=Array.from(providerMediaEditor.querySelectorAll('[data-catalog-check]')).filter(input=>JSON.parse(input.value)[0]==='plain-model');return mediaSetupFixture.discoveries.length===mediaSetupFixture.beforeCachedReopen&&entries.length===2&&entries.every(input=>input.disabled&&input.checked)&&entries.some(input=>JSON.parse(input.value)[1]==='generic-gateway')&&entries.some(input=>JSON.parse(input.value)[1]==='alternate-gateway')&&mediaSetupFixture.profile.mediaModels.filter(row=>row.modelId==='plain-model').length===2})()");
  await key('Escape');
  await check('ReopeningPreservesAllBindingsWithoutReapplyingCatalogDefaults',"setupRows().length===8&&setupRows()[7].protocol==='openai-images'&&setupRows()[7].ownedBy==='alternate-gateway'&&setupRows()[6].protocol==='ark-video'&&setupRows()[0].capabilities.defaults.size==='777x777'&&setupRows()[1].capabilities.defaults.size==='640x640'&&setupRows()[1].capabilities.defaults.n===2&&setupRows()[4].protocol==='openai-images'&&setupRows()[5].protocol==='ark-video'");
  // Exercise the app's save wiring while a separate async template load is held.
  // An empty media list is valid to save before templates arrive.
  await act("const f=mediaSetupFixture;f.profile={...f.profile,revision:f.profile.revision+1,mediaModels:[]};f.holdPresets=true;f.holdSave=true;f.failSave=true;renderProviderEditor(document.querySelector('.provider-editor').parentElement,JSON.parse(JSON.stringify(f.profile)),uiFixture.routes);");
  await waitFor('!!mediaSetupFixture.releasePresets&&!providerDiscover.disabled');
  await fill('#providerName','模板加载时保存的草稿');await fill('#providerApiKey','synthetic-delayed-template-key');
  await act("mediaSetupFixture.delayedBefore=JSON.stringify({connection:JSON.parse(providerMediaEditor.querySelector('[data-connection]').value),saved:mediaSetupFixture.profile});");
  await check('EmptyMediaListCanSaveWhileTemplatesAreLoading',"setupRows().length===0&&providerMediaEditor.querySelector('[data-add]').disabled&&!providerEditorSave.disabled");
  await click('#providerEditorSave');await waitFor('!!mediaSetupFixture.releaseSave');
  await act('mediaSetupFixture.releasePresets();');await settle();
  await check('LateTemplateResponseCannotUnlockControlsDuringAppSave',"providerEditorSave.disabled&&Array.from(providerMediaEditor.querySelectorAll('input,button,select,textarea')).every(node=>node.disabled)&&setupRows().length===0");
  await act("providerMediaEditor.querySelector('[data-add]').click();providerMediaEditor.querySelector('[data-add-manual]').click();providerDiscover.click();");
  await check('LateTemplateResponseCannotInsertBindingIntoSavingSnapshot',"setupRows().length===0&&!providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')&&mediaSetupFixture.writes.at(-1).mediaModels.length===0");
  await act('mediaSetupFixture.releaseSave();');await waitFor('!providerEditorSave.disabled');
  await check('FailedSaveUnlocksLoadedTemplatesAndKeepsEmptyMediaDraft',"!providerMediaEditor.querySelector('[data-add]').disabled&&!providerMediaEditor.querySelector('[data-add-manual]').disabled&&!providerDiscover.disabled&&providerMediaEditor.querySelector('[data-add-selected]').disabled&&setupRows().length===0&&providerName.value==='模板加载时保存的草稿'&&providerApiKey.value==='synthetic-delayed-template-key'&&providerEditorStatus.textContent.includes('当前填写内容已保留')&&JSON.stringify({connection:JSON.parse(providerMediaEditor.querySelector('[data-connection]').value),saved:mediaSetupFixture.profile})===mediaSetupFixture.delayedBefore");
  await act('mediaSetupFixture.holdSave=false;mediaSetupFixture.failSave=false;');await click('#providerEditorSave');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await check('DelayedTemplateSaveCanRetryUnchangedSnapshot',"mediaSetupFixture.savedCount===2&&mediaSetupFixture.writes.length===4&&JSON.stringify(mediaSetupFixture.writes[2])===JSON.stringify(mediaSetupFixture.writes[3])&&mediaSetupFixture.profile.name==='模板加载时保存的草稿'&&mediaSetupFixture.profile.mediaModels.length===0");

  // Model-family suggestions use real shared templates while explicit gateway
  // metadata and rejected declarations retain their own authority.
  await act(`const f=mediaSetupFixture;f.holdPresets=false;f.holdSave=false;f.failSave=false;f.untypedCatalog=[];f.mediaCandidates=[];f.catalog=[
    {id:'gpt-image-2.5-sunburst',ownedBy:'azure_openai',model_type:'image'},
    {id:'doubao-seedance-2.5',ownedBy:'volcengine_maas',model_type:'video'},
    {id:'gpt-image-2.5-sunburst',ownedBy:'another-gateway',model_type:'image'},
    {id:'gpt-image-2.5-sunburst',ownedBy:'explicit-gateway',model_type:'image',mediaConfig:{protocol:'ark-images',capabilities:{operations:['text_to_image'],parameters:{size:{enum:['2K','4K']}},defaults:{size:'2K'},references:{max:0}}}},
    {id:'gpt-image-2.5-sunburst',ownedBy:'blocked-gateway',model_type:'image',mediaTemplateBlocked:true}
  ];f.mediaCandidates=JSON.parse(JSON.stringify(f.catalog));`);
  await click('[data-provider-act=edit]');await waitFor("!providerMediaEditor.querySelector('[data-add]').disabled&&!providerDiscover.disabled");
  await click('#providerDiscover');await waitFor('!providerDiscover.disabled');
  await click('#providerMediaEditor [data-add]');
  await check('FamilySuggestionsAreDistinctFromDirectoryAndBlockedCandidates',"(()=>{const row=owner=>Array.from(providerMediaEditor.querySelectorAll('[data-catalog-check]')).find(input=>JSON.parse(input.value)[1]===owner).closest('label').textContent;return row('azure_openai').includes('已匹配模板')&&row('volcengine_maas').includes('已匹配模板')&&row('explicit-gateway').includes('自动配置')&&row('blocked-gateway').includes('需选模板')})()");
  for(const [id,owner] of [['gpt-image-2.5-sunburst','azure_openai'],['doubao-seedance-2.5','volcengine_maas'],['gpt-image-2.5-sunburst','another-gateway'],['gpt-image-2.5-sunburst','explicit-gateway']])await catalogCheck(id,owner);
  await click('#providerMediaEditor [data-add-selected]');
  await check('ScreenshotModelsConfigureImmediatelyWithoutTemplateChoice',"(()=>{const rows=setupRows();return rows.length===4&&rows.every(row=>!!row.protocol)&&Array.from(providerMediaEditor.querySelectorAll('[data-editor]')).every(editor=>editor.hidden)&&rows[0].protocol==='openai-images'&&rows[0].setup.source==='family-template'&&rows[0].setup.templateId==='gpt-image-2.5'&&rows[1].protocol==='ark-video'&&rows[1].setup.templateId==='seedance-2.5-video'&&rows[0].setup.version>0&&rows[1].setup.version===rows[0].setup.version})()");
  await check('MatchedTemplatesExposeRealAdjustableParameters',"(()=>{const rows=setupRows(),video=rows[1].capabilities.parameters,image=rows[0].capabilities.parameters;return video.duration.min===4&&video.duration.max===30&&video.resolution.enum.includes('720p')&&video.resolution.enum.includes('1080p')&&video.ratio.enum.includes('16:9')&&image.quality.enum.includes('xhigh')&&image.quality.enum.includes('max')&&image.outputFormat.enum.includes('webp')})()");
  await check('ExplicitGatewayMetadataOverridesFamiliarModelFamily',"setupRows()[3].setup.source==='directory'&&setupRows()[3].protocol==='ark-images'&&setupRows()[3].capabilities.defaults.size==='2K'&&!setupRows()[3].capabilities.parameters.quality&&setupRows()[3].ownedBy==='explicit-gateway'");
  await layout('automatic-models-light-1200',1200,'light');
  await click('#providerMediaEditor .media-binding:nth-child(2) [data-edit]');
  await click('#providerMediaEditor .media-binding:nth-child(2) [aria-label="增加时长（秒）"]');
  await click('#providerMediaEditor .media-binding:nth-child(2) [data-media-parameter=resolution] [data-value="720p"]');
  await selectParameter('#providerMediaEditor .media-binding:nth-child(2) select[data-media-parameter=ratio]','16:9');
  await click('#providerMediaEditor .media-binding:nth-child(2) [data-media-parameter=audio] [data-value="true"]');
  await check('SeedanceDurationResolutionRatioAndAudioControlsChangeValues',"(()=>{const row=setupRows()[1],d=row.capabilities.defaults;return d.duration===5&&d.resolution==='720p'&&d.ratio==='16:9'&&d.audio===true&&row.setup.source==='family-template'&&row.ownedBy==='volcengine_maas'})()");
  await layout('seedance-parameters-light-900',900,'light');await layout('seedance-parameters-dark-900',900,'dark');
  await click('#providerMediaEditor .media-binding:nth-child(1) [data-edit]');
  await selectParameter('#providerMediaEditor .media-binding:nth-child(1) select[data-media-parameter=quality]','max');
  await click('#providerMediaEditor .media-binding:nth-child(1) [data-media-parameter=outputFormat] [data-value="webp"]');
  await click('#providerMediaEditor .media-binding:nth-child(1) [aria-label="增加数量"]');
  await check('GptImageControlsChangeValuesWithoutTouchingAnotherOwner',"setupRows()[0].capabilities.defaults.quality==='max'&&setupRows()[0].capabilities.defaults.outputFormat==='webp'&&setupRows()[0].capabilities.defaults.n===2&&setupRows()[2].capabilities.defaults.quality==='low'&&setupRows()[2].capabilities.defaults.n===1&&!setupRows()[2].capabilities.defaults.outputFormat");
  await chooseTemplate(2,'protocol-ark-images');
  await check('UserCanOverrideFamilyTemplateAndRetainManualProvenance',"setupRows()[2].protocol==='ark-images'&&setupRows()[2].setup.source==='manual-template'&&setupRows()[2].setup.templateId==='protocol-ark-images'&&setupRows()[2].ownedBy==='another-gateway'&&setupRows()[2].modelId==='gpt-image-2.5-sunburst'&&Object.keys(setupRows()[2].capabilities.defaults).length===0");
  await act('mediaSetupFixture.familyDraft=JSON.stringify(setupRows());');await click('#providerDiscover');await waitFor('!providerDiscover.disabled');
  await check('RefreshingNeverReappliesFamilyDefaultsOrOverridesManualTemplate',"JSON.stringify(setupRows())===mediaSetupFixture.familyDraft");
  await click('#providerEditorSave');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await check('AutomaticAndManualSetupSourcesReachSavePayload',"mediaSetupFixture.savedCount===3&&mediaSetupFixture.profile.mediaModels.length===4&&JSON.stringify(mediaSetupFixture.writes.at(-1).mediaModels)===mediaSetupFixture.familyDraft");
  await click('[data-provider-act=edit]');await waitFor("!providerMediaEditor.querySelector('[data-add]').disabled&&!providerDiscover.disabled");
  await check('SavedFamilySourcesAndEditedValuesSurviveReopening',"(()=>{const rows=setupRows(),titles=Array.from(providerMediaEditor.querySelectorAll('[data-subtitle]'),node=>node.textContent);return JSON.stringify(rows)===mediaSetupFixture.familyDraft&&rows[0].setup.source==='family-template'&&rows[0].capabilities.defaults.quality==='max'&&rows[1].capabilities.defaults.duration===5&&rows[1].capabilities.defaults.audio===true&&rows[2].setup.source==='manual-template'&&rows[3].setup.source==='directory'&&titles[0].includes('已匹配')&&titles[1].includes('已匹配')&&!titles[2].includes('已匹配')&&titles[3].includes('已自动配置')})()");
  await click('#providerMediaEditor [data-add]');await catalogCheck('gpt-image-2.5-sunburst','blocked-gateway');await click('#providerMediaEditor [data-add-selected]');
  await act('mediaSetupFixture.beforeBlockedSave=mediaSetupFixture.writes.length;');await click('#providerEditorSave');
  await check('RejectedMetadataCannotBeBypassedByRecognizableFamilyName',"setupRows().length===5&&!setupRows()[4].protocol&&mediaSetupFixture.writes.length===mediaSetupFixture.beforeBlockedSave&&providerEditorStatus.textContent.includes('模板')");
  await chooseTemplate(4,'protocol-openai-images');
  await check('BlockedModelCanStillUseAnExplicitUserTemplate',"setupRows()[4].setup.source==='manual-template'&&setupRows()[4].protocol==='openai-images'&&setupRows()[4].ownedBy==='blocked-gateway'");
  await check('NoUnhandledRendererErrors','uiFixture.errors.length===0');
  clearTimeout(deadline);step='complete';save();console.log(JSON.stringify({passed:Object.keys(checks).length,output}));app.exit(0);
}).catch(async error=>{clearTimeout(deadline);errors.push(error.stack||String(error));if(win)try{errors.push(await evaluate('JSON.stringify({errors:uiFixture.errors,status:document.getElementById("providerEditorStatus")?.textContent,body:document.getElementById("providerMediaEditor")?.innerText})'));await capture('failure')}catch(_){}save();console.error(error);app.exit(1);});
