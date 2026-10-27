'use strict';
// Actual Electron renderer with in-memory scheduler/provider fixtures only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.codex-tmp', 'scheduler-media-ui'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const errors = [], checks = {};
const timeout = setTimeout(() => app.exit(2), 60000);
let win;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><body><div class="app"></div></body></html>'));
  win.showInactive();
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  await win.webContents.executeJavaScript(`(()=>{const t=document.createElement('template');t.innerHTML=${JSON.stringify(html)};document.querySelector('.app').append(t.content.querySelector('#scheduleModal'));})()`);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const file = path.join(root, 'renderer', match[1]);
    if (fs.existsSync(file)) await win.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
  }
  await win.webContents.insertCSS('.app{display:block!important;overflow:hidden;width:100%;height:100vh}');
  await win.webContents.executeJavaScript(`
    window.$=id=>document.getElementById(id);window.bindTransientScrollbar=()=>{};window.closeProviderModelPickers=()=>{};
    window.rendererErrors=[];window.addEventListener('error',event=>rendererErrors.push(event.message));window.addEventListener('unhandledrejection',event=>rendererErrors.push(String(event.reason)));
    window.showToast=value=>fixture.toasts.push(value);window.showAppView=()=>$('scheduleModal').classList.remove('hidden');window.returnToConversationView=()=>{};window.refreshHistoryList=()=>{};
    window.fixture={updates:[],creates:[],toasts:[],items:[
      {id:'unknown',name:'原有视频',enabled:true,schedule:{kind:'cron',cron:'0 9 * * *',tz:'UTC'},action:{type:'video',prompt:'  原有提示词  ',mediaModel:'retired::media::unknown',parameters:{duration:7,unlistedField:'keep'},references:[{url:'https://assets.invalid/one.png',role:'first_frame',mime:'image/png'}],workingDir:'preserve'}},
      {id:'known',name:'已配置视频',enabled:true,schedule:{kind:'cron',cron:'0 9 * * *'},action:{type:'video',prompt:'视频内容',mediaModel:'A::media::video',parameters:{duration:4,unlistedField:'keep'},references:[{url:'https://assets.invalid/one.png',role:'first_frame',mime:'image/png'}]}},
      {id:'legacy',name:'旧图片',enabled:true,schedule:{kind:'cron',cron:'0 9 * * *'},action:{type:'image',prompt:'图片内容',imageModel:'old-image-alias',size:'2048x1024',n:3,parameters:{special:'keep'},references:['https://assets.invalid/reference.png']}},
      {id:'empty-prompt',name:'仅首帧',enabled:true,schedule:{kind:'cron',cron:'0 9 * * *'},action:{type:'video',prompt:'',mediaModel:'missing-video',references:[{url:'https://assets.invalid/frame.png',role:'first_frame'}]}}
    ]};
    fixture.models=[
      {routeId:'A::media::video',modelId:'unlisted/video',label:'未来视频',providerName:'A',protocol:'ark-video',modality:'video',available:true,capabilities:{operations:['text_to_video','image_to_video'],defaults:{duration:4},parameters:{duration:{enum:[4,6],integer:true},audio:{type:'boolean'}},references:{max:2,roles:['first_frame','last_frame']}}},
      {routeId:'B::media::video',modelId:'unlisted/video',label:'未来视频',providerName:'B',protocol:'dashscope-video',modality:'video',available:true,capabilities:{operations:['text_to_video','image_to_video'],defaults:{duration:6},parameters:{duration:{enum:[4,6],integer:true}},references:{max:2,roles:['first_frame','last_frame']}}},
      {routeId:'A::media::image',modelId:'unlisted/image',label:'未来图片',providerName:'A',modality:'image',available:true,capabilities:{operations:['text_to_image'],defaults:{size:'640x640',n:1},parameters:{size:{enum:['640x640','1024x1024']},n:{min:1,max:2,integer:true}},references:{max:0}}}
    ];
    window.api={providers:{listMediaModels:async()=>fixture.failMedia?{ok:false}:{ok:true,models:structuredClone(fixture.models)}},scheduler:{
      list:async()=>({ok:true,items:structuredClone(fixture.items)}),preview:async()=>({ok:true,times:['2099-01-01T00:00:00Z']}),
      update:async(id,payload)=>{fixture.updates.push({id,payload:structuredClone(payload)});const task=fixture.items.find(item=>item.id===id);Object.assign(task,structuredClone(payload));return{ok:true,task:structuredClone(task)};},
      create:async payload=>{const task={id:'created-'+fixture.creates.length,...structuredClone(payload)};fixture.creates.push(task);fixture.items.push(task);return{ok:true,task};},
      onUpdate:handler=>{fixture.push=handler;},runs:async()=>({ok:true,items:[]})
    }};void 0;
  `);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer/media-parameters.js'), 'utf8'));
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer/media-ui.js'), 'utf8'));
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const helpers = source.slice(source.indexOf('function buildSettingsSegmented('), source.indexOf('// 替换浏览器原生 confirm'));
  const escaping = source.slice(source.indexOf('function escapeHtml('), source.indexOf('// ── 给 markdown'));
  const start = source.indexOf('(function initScheduleView()');
  const end = source.indexOf('\n})();', start) + '\n})();'.length;
  await win.webContents.executeJavaScript(escaping + helpers + source.slice(start, end));
  Object.assign(checks, await win.webContents.executeJavaScript(`(async()=>{
    const result={},check=(name,value)=>{result[name]=!!value;if(!value)throw Error(name);};
    const settle=()=>new Promise(resolve=>setTimeout(resolve,35));
    const input=(id,value)=>{const el=$(id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
    const select=async id=>{$('svList').querySelector('[data-task-id="'+id+'"] .sv-card-select').click();await settle();};
    const option=async(id,value)=>{$(id).querySelector('.cs-option[data-value="'+value+'"]').click();await settle();};
    const media=async value=>{$('svEditMediaModel').value=value;$('svEditMediaModel').dispatchEvent(new Event('change',{bubbles:true}));await settle();};
    const save=async()=>{$('svEditorSave').click();await settle();};
    window.openScheduleModal();await settle();
    check('videoTypeAndCardLabel',$('svEditType').dataset.value==='video'&&document.querySelector('[data-task-id="unknown"] .sv-card-meta').textContent.includes('视频生成'));
    check('unknownMediaSelectionPreserved',$('svEditMediaModel').value==='retired::media::unknown'&&$('svEditMediaStatus').textContent.includes('保留'));
    const original=JSON.stringify(fixture.items[0].action);input('svEditName','原有视频改名');await save();
    check('renameDoesNotRewriteUnknownAction',JSON.stringify(fixture.updates.at(-1).payload.action)===original);
    await option('svEditTime','10:00');await save();
    check('timeEditDoesNotRewriteUnknownAction',JSON.stringify(fixture.updates.at(-1).payload.action)===original&&fixture.updates.at(-1).payload.schedule.cron==='0 10 * * *');
    await select('legacy');const legacy=JSON.stringify(fixture.items.find(item=>item.id==='legacy').action);input('svEditName','旧图片改名');await save();
    check('legacyImageParametersAndReferencesPreserved',JSON.stringify(fixture.updates.at(-1).payload.action)===legacy);
    await select('known');check('onlyMatchingModalityChoices',[...$('svEditMediaModel').options].every(item=>!item.value||item.value.includes('video')));
    const duration=$('svEditMediaParameters').querySelector('[aria-label="时长（秒）"]');check('capabilityParameterLoadsExistingValue',duration.value==='4');
    duration.value='6';duration.dispatchEvent(new Event('change',{bubbles:true}));await save();
    check('typedParameterEditPreservesOtherInputs',fixture.updates.at(-1).payload.action.parameters.duration===6&&fixture.updates.at(-1).payload.action.parameters.unlistedField==='keep'&&fixture.updates.at(-1).payload.action.references[0].mime==='image/png');
    $('svEditMediaAddReference').click();const refs=$('svEditMediaReferences');const second=refs.children[1];second.querySelector('input').value='https://assets.invalid/two.png';second.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));second.querySelector('select').value='last_frame';second.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));await save();
    check('explicitVideoReferencesSaveWithRoles',fixture.updates.at(-1).payload.action.references.length===2&&fixture.updates.at(-1).payload.action.references[1].role==='last_frame');
    await media('B::media::video');await save();
    check('explicitProtocolSwitchResetsUnsupportedParameters',fixture.updates.at(-1).payload.action.mediaModel==='B::media::video'&&JSON.stringify(fixture.updates.at(-1).payload.action.parameters)===JSON.stringify({duration:6})&&fixture.updates.at(-1).payload.action.references.length===2);
    input('svEditName','保留媒体草稿');await select('unknown');await select('known');check('mediaDraftSurvivesTaskSwitch',$('svEditName').value==='保留媒体草稿'&&$('svEditMediaModel').value==='B::media::video');
    $('svModalAdd').click();await settle();input('svEditName','新视频');input('svEditPrompt','新视频内容');await option('svEditType','video');await media('B::media::video');await save();
    check('newVideoUsesExactGatewayBinding',fixture.creates.at(-1).action.type==='video'&&fixture.creates.at(-1).action.mediaModel==='B::media::video');
    check('newVideoDoesNotSendImageCount',fixture.creates.at(-1).action.parameters.duration===6&&!Object.hasOwn(fixture.creates.at(-1).action.parameters,'n'));
    $('svModalAdd').click();await settle();input('svEditName','新图片');input('svEditPrompt','新图片内容');await option('svEditType','image');await media('A::media::image');await save();
    check('newImageUsesCapabilityDefaults',fixture.creates.at(-1).action.type==='image'&&fixture.creates.at(-1).action.parameters.n===1&&fixture.creates.at(-1).action.parameters.size==='640x640');
    fixture.failMedia=true;await select('empty-prompt');const before=JSON.stringify(fixture.items.find(item=>item.id==='empty-prompt').action);input('svEditName','首帧任务改名');await save();
    check('referenceOnlyVideoCanRenameDuringCatalogFailure',fixture.updates.at(-1).id==='empty-prompt'&&JSON.stringify(fixture.updates.at(-1).payload.action)===before);
    fixture.failMedia=false;
    $('svModalAdd').click();await settle();input('svEditName','缺少模型');input('svEditPrompt','内容');await option('svEditType','video');const count=fixture.creates.length;await save();
    check('newVideoRequiresConfiguredBinding',fixture.creates.length===count&&$('svEditorHint').textContent.includes('媒体模型'));
    return result;
  })()`));
  errors.push(...await win.webContents.executeJavaScript('rendererErrors'));
  checks.noRendererErrors = errors.length === 0;
  if (!checks.noRendererErrors) throw Error(JSON.stringify(errors));
  await win.webContents.executeJavaScript("$('svList').querySelector('[data-task-id=known] .sv-card-select').click();$('svEditMediaReferences').closest('details').open=true;");
  for (const width of [1200, 620]) {
    win.setContentSize(width, 800);
    await new Promise(resolve => setTimeout(resolve, 180));
    checks['mediaControlsFit' + width] = await win.webContents.executeJavaScript("(()=>{const model=$('svEditMediaModel'),host=$('svEditMediaReferences'),row=model.closest('.sv-edit-row');return model.checkVisibility()&&model.getBoundingClientRect().right<=row.getBoundingClientRect().right+1&&host.scrollWidth<=host.clientWidth+1&&$('scheduleModal').scrollWidth<=innerWidth+1;})()");
    if (!checks['mediaControlsFit' + width]) throw Error('mediaControlsFit' + width);
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  await win.webContents.executeJavaScript("$('svEditMediaModel').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(output, 'scheduler-media.png'), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, count: Object.keys(checks).length }));
  clearTimeout(timeout);win.destroy();app.exit(0);
}).catch(error => { fs.writeFileSync(path.join(output, 'errors.json'), JSON.stringify([...errors,error.stack],null,2));console.error(error.stack);clearTimeout(timeout);app.exit(1); });
