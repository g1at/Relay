'use strict';
// Use the actual shipped capability templates, never widened fixture ranges.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getMediaProtocolPresets } = require('../src/main/providers/provider-media');
const { validateInput, encodeSubmit } = require('../src/main/media/media-protocols');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.codex-tmp/media-controls-audit/templates'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const presets = getMediaProtocolPresets();
const templates = presets.capabilities.filter(item => Object.keys(item.capabilities.parameters || {}).length);
const checks = {}, errors = [], edits = {}; let win, step = 'start';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, edits, step }, null, 2));
const deadline = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const waitFor = code => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25)};tick()})`);
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
function check(name, value) { step=name; checks[name]=!!value; save(); console.log(`${value?'PASS':'FAIL'} ${name}`); if(!value) throw Error(name); }
function fixture(presets) {
  const base=window.api;
  const models=presets.capabilities.filter(item=>Object.keys(item.capabilities.parameters||{}).length).map(item=>({
    ...item, id:item.id, name:'fixture::media::'+item.id, label:'模板 '+item.id, modelId:'fixture/'+item.id,
    modality:presets.protocols.find(protocol=>protocol.id===item.protocol).modality, ok:true, providerName:'合成网关',
  }));
  const state=window.capabilityFixture={models,requests:[],png:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};
  const media={getConfig:async()=>({models}),generate:async input=>{state.requests.push(structuredClone(input));return{ok:true,taskId:input.runId,paths:['C:/synthetic-media/result.'+(input.mediaKind==='video'?'mp4':'png')]};},get:async id=>({id,state:'completed'}),onChanged:()=>()=>{}};
  const image=new Proxy(base.image,{get:(target,key)=>key==='saveRef'?async()=>({ok:true,path:'C:/synthetic-media/reference.png'}):key==='toDataUrl'?async()=>({ok:false}):target[key]});
  window.api=new Proxy(base,{get:(target,key)=>key==='media'?media:key==='image'?image:target[key]});
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const base=pathToFileURL(path.join(root,'renderer')+path.sep).href;
  const apiFixtures=['ui-api-fixture.js','workspace-api-fixture.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>',()=>'<head><base href="'+base+'"><script>'+apiFixtures+'\n('+fixture.toString()+')('+JSON.stringify(presets)+');localStorage.clear();</script>');
  const file=path.join(output,'fixture.html');fs.writeFileSync(file,html);
  win=new BrowserWindow({width:1200,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(file);win.showInactive();await waitFor('providerRoutingLoaded&&!restoringActiveRuns');await evaluate('showCreateView(true)');
  await waitFor(`cvModels.length===${templates.length}`);
  for (const template of templates) {
    const dimensions=['2048x1024','1920x1080','1024x1024','1536x1024','2048x2048','1280x1280'];
    const originalSize=template.capabilities.defaults?.size || '';
    const alternateSize=dimensions.map(value=>originalSize.includes('*')?value.replace('x','*'):value).find(size=>size!==originalSize&&validateInput({...template,modelId:'fixture/'+template.id},{prompt:'合成参数检查',...template.capabilities.defaults,size}).ok);
    step=template.id; await evaluate('showCreateView(true)'); await click('#cvModelTrigger');
    await act(`Array.from(document.querySelectorAll('.model-popup.show .mp-row')).find(row=>row.textContent.includes(${JSON.stringify('模板 '+template.id)})).click();`);await settle();
    await click('.media-settings-trigger');
    if(template.capabilities.parameters.size) {
      const options=await act("return Array.from(cvMediaParameters.querySelector('[data-media-size-picker]').options).filter(option=>!option.disabled&&option.value!==''&&option.value!=='__custom__').map(option=>option.value);");
      check(template.id+'SizePresetsFollowDeclaredProtocolRules',options.length>0&&options.every(size=>validateInput({...template,modelId:'fixture/'+template.id},{prompt:'尺寸预设校验',...template.capabilities.defaults,size}).ok));
      if(template.id==='openai-image'||template.id==='gpt-image-2.5')check(template.id+'OffersSquareLandscapePortraitAndCurrentSize',['1024x1024','1536x1024','1024x1536',originalSize].every(size=>options.includes(size)));
    }
    edits[template.id]=await act(`
      const result=[],rules=cvCurrentModel().capabilities.parameters;
      const advanced=cvMediaParameters.querySelector('details');if(advanced)advanced.open=true;
      for(const [key,rule] of Object.entries(rules)){
        if(rule===false)continue;
        const field=cvMediaParameters.querySelector('.media-parameter-field[data-media-parameter="'+key+'"]');if(!field)throw Error('Missing '+key);
        const input=field.querySelector('[data-media-parameter="'+key+'"]'),before=input.value;
        if(key==='size'&&field.querySelector('[data-media-size-picker]')){
          const picker=field.querySelector('[data-media-size-picker]'),size=${JSON.stringify(alternateSize || '')};
          picker.value='__custom__';picker.dispatchEvent(new Event('change',{bubbles:true}));
          const parts=size.split(/[x*]/);
          for(const [index,dimension] of ['width','height'].entries()){const part=field.querySelector('[data-dimension="'+dimension+'"]');part.value=parts[index];part.dispatchEvent(new Event('input',{bubbles:true}));part.dispatchEvent(new Event('change',{bubbles:true}));}
        }else if(input.tagName==='SELECT'){
          const preferred=key==='outputFormat'&&rules.outputCompression?'jpeg':null;
          const choice=Array.from(input.options).find(option=>!option.disabled&&option.value!==before&&option.value!==''&&(!preferred||option.value===preferred));
          if(choice){input.value=choice.value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
        }else if(input.type==='number'){
          const buttons=field.querySelectorAll('button');
          if(buttons.length){const button=buttons[buttons.length-1].disabled?buttons[0]:buttons[buttons.length-1];button.click();}
          else {input.value=String(Number(before||rule.min||0)+1);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
        }else{
          input.value=key==='size'?${JSON.stringify(alternateSize || '')}:'fixture';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
        }
        result.push({key,before,after:input.value,changed:before!==input.value,type:typeof cvReadParameters()[key]});
      }
      capabilityFixture.expected=cvReadParameters();return result;
    `);
    check(template.id+'AllDeclaredControlsCanChange', edits[template.id].every(item=>item.changed));
    const parameters=await evaluate('capabilityFixture.expected');
    const refs=template.capabilities.references?.required?[{url:await evaluate('capabilityFixture.png'),role:'first_frame'}]:[];
    const binding={...template,modelId:'fixture/'+template.id,baseUrl:'https://synthetic.invalid',auth:{mode:'none'},modality:presets.protocols.find(item=>item.id===template.protocol).modality};
    const request={...parameters,prompt:'合成参数检查',references:refs};
    const validation=validateInput(binding,request);
    if(!validation.ok)console.error(JSON.stringify({template:template.id,errors:validation.errors,parameters}));
    check(template.id+'EditsPassProtocolValidation',validation.ok);
    const encoded=encodeSubmit(binding,request);
    check(template.id+'EditsEncodeWithoutModelSpecificAdapter',!!encoded.url);
    if(parameters.size)check(template.id+'CustomWidthHeightKeepWireSize',(encoded.body.parameters?.size||encoded.body.size)===(binding.protocol==='dashscope-images'?parameters.size.replace('x','*'):parameters.size));
    if(['openai-image','gpt-image-2.5','seedance-2.5-video','seedream-5-pro'].includes(template.id)) {
      await act("const advanced=cvMediaParameters.querySelector('details');if(advanced)advanced.open=false;");
      for(const [width,height,theme] of [[1200,800,'light'],[1200,800,'dark'],[900,650,'light'],[900,650,'dark'],[620,650,'light'],[620,650,'dark']]) {
        win.setContentSize(width,height);await waitFor(`Math.abs(innerWidth-${width})<3`);await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.app').classList.toggle('sidebar-collapsed',${width<800});`);await settle();
        const name=`${template.id}-${theme}-${width}`;
        await evaluate('document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}})');await evaluate('new Promise(resolve=>setTimeout(resolve,250))');await settle();
        check(name+'FitsViewport',await evaluate("(()=>{const panel=document.querySelector('.media-settings-popover:popover-open'),rect=panel.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth+1})()"));
        check(name+'PrimaryControlsStayOnOneLine',await evaluate("Array.from(document.querySelector('.media-settings-popover:popover-open').querySelectorAll('.media-settings-fields > .media-parameter-field')).every(field=>field.getBoundingClientRect().height<=42&&field.scrollWidth<=field.clientWidth+1)"));
        fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
        const menuKey=template.id==='seedance-2.5-video'?'ratio':template.id==='gpt-image-2.5'?'quality':'size';
        await act(`cvMediaParameters.querySelector('.media-parameter-field[data-media-parameter="${menuKey}"] .cs-trigger').click();`);
        await waitFor("!!cvMediaParameters.querySelector('.cs-popup:popover-open')");await settle();
        await evaluate('document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}})');await settle();
        check(name+'RelayMenuFitsViewportAndPreservesParent',await evaluate("(()=>{const parent=cvMediaParameters.querySelector('.media-settings-popover:popover-open'),menu=cvMediaParameters.querySelector('.cs-popup:popover-open');if(!parent||!menu)return false;const rect=menu.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&menu.scrollWidth<=menu.clientWidth+1&&Array.from(menu.querySelectorAll('.cs-option')).every(option=>option.getBoundingClientRect().height<=34)})()"));
        fs.writeFileSync(path.join(output,name+'-'+menuKey+'-menu-open.png'),(await win.webContents.capturePage()).toPNG());
        await act('closeCustomSelect()');await settle();
        await act("const advanced=cvMediaParameters.querySelector('details');if(advanced)advanced.open=true;");await settle();
        await evaluate('new Promise(resolve=>setTimeout(resolve,250))');await settle();
        check(name+'ExpandedFitsViewport',await evaluate("(()=>{const panel=document.querySelector('.media-settings-popover:popover-open'),rect=panel.getBoundingClientRect(),advanced=panel.querySelector('details');return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth+1&&advanced.open&&advanced.querySelector('.media-parameter-field').checkVisibility({visibilityProperty:true})})()"));
        fs.writeFileSync(path.join(output,name+'-expanded.png'),(await win.webContents.capturePage()).toPNG());
        await act("const advanced=cvMediaParameters.querySelector('details');if(advanced)advanced.open=false;");await settle();
      }
      win.setContentSize(1200,800);await act("document.documentElement.dataset.theme='light';document.querySelector('.app').classList.remove('sidebar-collapsed')");await settle();
    }
    await act(`document.querySelector('.media-settings-popover').hidePopover();cvRefImages=${refs.length?"[{name:'frame.png',dataUrl:capabilityFixture.png,role:'first_frame'}]":'[]'};cvRenderRef();cvPrompt.value='合成参数检查';cvPrompt.dispatchEvent(new Event('input',{bubbles:true}));`);
    const before=await evaluate('capabilityFixture.requests.length');await click('#btnGenerate');await waitFor(`capabilityFixture.requests.length===${before+1}&&!cvJobs.size`);
    check(template.id+'GenerationCarriesEditedTypedParameters',await evaluate(`Object.entries(capabilityFixture.expected).every(([key,value])=>capabilityFixture.requests.at(-1)[key]===value)`));
    if(binding.modality==='video')check(template.id+'VideoOmitsImageOnlyParameters',await evaluate("!Object.hasOwn(capabilityFixture.requests.at(-1),'n')&&!Object.hasOwn(capabilityFixture.requests.at(-1),'size')"));
  }
  check('NoUnhandledRendererErrors',await evaluate('uiFixture.errors.length===0'));
  clearTimeout(deadline);step='complete';save();console.log(JSON.stringify({passed:Object.keys(checks).length,templates:templates.length,output}));app.exit(0);
}).catch(async error=>{clearTimeout(deadline);errors.push(error.stack||String(error));if(win)try{fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch(_){}save();console.error(error);app.exit(1)});
