'use strict';
// Production MCP schema -> service -> WebContentsView -> real AG Grid, independent DOM/server assertions.
// A pinned third-party test asset is cached outside source. See prepare-browser-complex.cjs.
const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createBrowserPanelHost}=require('../src/main/browser/browser-panel-host');
const {createBrowserAutomationService}=require('../src/main/browser/browser-automation-service');
const {createBrowserToolFactory}=require('../src/main/browser/browser-tools');
const capabilities=process.env.RELAY_BROWSER_CAPABILITIES==='1';
const background=process.env.RELAY_COMPLEX_BACKGROUND==='1'||process.env.RELAY_COMPOSITOR_MODE==='complex-background';
const output=path.join(__dirname,'../.codex-tmp/'+(capabilities?'browser-capabilities-':'browser-complex-')+(process.env.RELAY_COMPLEX_OOPIF==='1'?'oopif':'components')+(background?'-background':''));fs.mkdirSync(output,{recursive:true});
const asset=process.env.RELAY_COMPLEX_GRID_ASSET || path.join(__dirname,'../.codex-tmp/browser-complex-components/ag-grid-community-33.3.2.min.js');
const expectedHash='644ea4e81bb9d92f515a0fd14160aebcda5a071bfb3392d72f8a370938fea930';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-complex-')); app.setPath('userData',path.join(tmp,'profile'));app.commandLine.appendSwitch('disable-background-networking');
const oopif=process.env.RELAY_COMPLEX_OOPIF==='1';
if(oopif){app.commandLine.appendSwitch('site-per-process');app.commandLine.appendSwitch('host-resolver-rules','MAP relay-frame.test 127.0.0.1');app.commandLine.appendSwitch('no-proxy-server');}
app.on('window-all-closed',()=>{});
let owner,host,service,server,frameServer,wc,id,tools;
const controller=new AbortController(), pause=ms=>new Promise(r=>setTimeout(r,ms)), events=[];
const report={ok:false,library:'AG Grid Community 33.3.2',background,modelDriven:false,checks:[],serverEvents:events,startedAt:new Date().toISOString()};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);console.log('[pass]',name);save();};
const context={conversationId:'component-task',runId:'component-run',workspaceRoot:tmp,signal:controller.signal,isCurrent:()=>!controller.signal.aborted};
async function rawCall(name,args){const result=await tools.find(t=>t.name===name).run(args);const value=JSON.parse(result.content.find(c=>c.type==='text').text);report.lastCalls||=[];report.lastCalls.push({name,args,result:{...value,data:undefined}});report.lastCalls=report.lastCalls.slice(-5);return {value,isError:result.isError===true};}
async function call(name,args){const {value}=await rawCall(name,args);assert.equal(value.ok,true,name+': '+JSON.stringify(value));return value;}
async function act(kind,locator,extra={}){const found=await call('locate',{id,locator,frameId:extra.frameId});assert.equal(found.count,1,'unique '+JSON.stringify(locator));return call('act',{id,kind,observationId:found.observationId,ref:found.matches[0].ref,...extra});}
async function until(predicate){const end=Date.now()+7000;while(Date.now()<end){if(await predicate())return true;await pause(60)}return false;}
const deadline=setTimeout(()=>{report.error='180s deadline';save();app.exit(1)},180000);
app.whenReady().then(async()=>{
  check('test component bytes match the pinned upstream build',crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex')===expectedHash);
  frameServer=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Cross origin email <input aria-label="Cross origin email"></label><button onclick="document.body.dataset.saved=document.querySelector(\'input\').value">Save account</button>')});
  await new Promise(r=>frameServer.listen(0,'127.0.0.1',r));
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/ag-grid.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(asset));return;}
    if(url.pathname==='/embedded'){res.setHeader('Content-Type','text/html');res.end('<label>Embedded email <input aria-label="Embedded email"></label><button>Save embedded account</button>');return;}
    if(['/ready','/event','/approved'].includes(url.pathname)){events.push({url:req.url,method:req.method});res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
    if(url.pathname==='/capability-response'){events.push({url:req.url,method:req.method});res.statusCode=201;res.setHeader('Content-Type','application/json');res.end('{"saved":true}');return;}
    if(url.pathname==='/popup'){res.setHeader('Content-Type','text/html');res.end('<h1>Linked record</h1><label>Record note <input aria-label="Record note"></label>');return;}
    if(url.pathname==='/next'){res.end('<h1>Navigation completed</h1>');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname,'fixtures/browser-complex/operations.html'),'utf8').replace('</iframe>','</iframe><iframe title="Cross origin editor" src="http://'+(oopif?'relay-frame.test':'127.0.0.1')+':'+frameServer.address().port+'/"></iframe>'));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  owner=new BrowserWindow({width:1220,height:1100,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await owner.loadURL('data:text/html,<title>Relay complex component acceptance</title>');owner.show();owner.focus();await pause(100);
  host=createBrowserPanelHost({ BaseWindow,owner,WebContentsView,session,onEvent:e=>{service?.handleHostEvent(e);if(!background&&e.type==='created'&&e.openerId&&e.requestedActive)host.setVisibility(true,e.tab.id)}});
  // This fixture has no workspace renderer. Fulfil only an explicit focus
  // presentation request as the real renderer would, leaving background opens alone.
  service=createBrowserAutomationService({getHost:()=>host,onEvent:e=>{if(e.type==='automation-open'&&e.reveal)host.setVisibility(true,e.tab.id)}});
  tools=createBrowserToolFactory({getContext:()=>context,invoke:(ctx,input)=>service.invoke(ctx,input)})({tool:(name,_d,_s,run)=>({name,run}),createSdkMcpServer:x=>x})['relay-browser'].tools;
  id=(await call('open',{url:base+'/'})).tab.id;await host.invoke({action:'setBounds',rect:{x:0,y:0,width:1190,height:1020}});
  if(!background){await host.invoke({action:'visibility',id,visible:true});await host.invoke({action:'focus',id});}
  wc=host.getAutomationTarget(id).webContents;
  check('real 10000-row grid loaded',await until(()=>wc.executeJavaScript('window.auditApi?.getDisplayedRowCount() === 10000')));
  const initial=await call('observe',{id});report.initialObservation=initial;check('large table observation excludes presentation noise',!initial.elements.some(e=>e.role==='presentation'));
  report.domNodes=await wc.executeJavaScript('document.querySelectorAll("*").length');report.renderedRows=await wc.executeJavaScript('document.querySelectorAll(".ag-row").length');
  if(capabilities) await require('./browser-capabilities-checks.cjs')({call,rawCall,act,wc,id,base,events,check,until,pause,report,service,context});
  await act('click',{role:'button',name:'Status filter'});await act('click',{role:'option',name:'Pending only'});
  check('custom dropdown drives async real grid filter to 5000 rows',await until(()=>wc.executeJavaScript('window.auditApi.getDisplayedRowCount()===5000')));
  await act('click',{role:'button',name:'Open asynchronous approval'});
  check('wait locates asynchronously inserted dialog', (await call('wait',{id,locator:{role:'dialog',name:'Approval dialog'},state:'visible',timeoutMs:6000})).satisfied);
  const modal=await call('observe',{id});check('foreground dialog controls survive dense table and observation limits',modal.elements.some(e=>e.name==='Approval reason')&&modal.elements.some(e=>e.name==='Confirm approval')&&!modal.elements.some(e=>e.name==='Status filter'));
  await act('fill',{role:'textbox',name:'Approval reason'},{text:'Verified complex workflow'});
  const approval=await act('click',{role:'button',name:'Confirm approval'},capabilities?{waitFor:{event:'response',url:base+'/approved',method:'POST',status:200,timeoutMs:6000}}:{});
  if(capabilities) check('atomic response wait captures the real asynchronous approval POST',approval.executed&&approval.waitResult?.satisfied);
  check('approval reached independent server and visible business state',await until(async()=>events.some(e=>e.url==='/approved'&&e.method==='POST')&&await wc.executeJavaScript('audit.approved===true')));
  fs.writeFileSync(path.join(tmp,'input.csv'),'id,name\n1,Complex acceptance\n');
  let located=await call('locate',{id,locator:{css:'#csv'}});await call('upload',{id,observationId:located.observationId,ref:located.matches[0].ref,files:['input.csv']});
  check('hidden file input receives task file and triggers page upload callback',await until(()=>wc.executeJavaScript('audit.uploaded===1')));
  fs.writeFileSync(path.join(tmp,'chooser.csv'),'id,name\n2,Chooser acceptance\n');
  located=await call('locate',{id,locator:{role:'button',name:'Import CSV'}});
  await call('upload',{id,observationId:located.observationId,ref:located.matches[0].ref,chooser:true,files:['chooser.csv']});
  check('file chooser button uploads the intended task file',await until(()=>wc.executeJavaScript('audit.uploadedName==="chooser.csv"')));
  const frames=(await call('frames',{id})).frames;report.frames=frames;
  if(oopif){report.frameTargets=(await wc.debugger.sendCommand('Target.getTargets')).targetInfos.filter(t=>t.type==='iframe').map(t=>({type:t.type,url:t.url}));check('cross-site iframe has a separate Chromium target',report.frameTargets.some(t=>t.url.includes('relay-frame.test')));}
  const embedded=frames.find(f=>f.url.endsWith('/embedded')),cross=frames.find(f=>f.url.includes(':'+frameServer.address().port+'/'));
  check('same-origin and cross-origin frames are discovered',embedded?.supported&&cross?.supported);
  await act('fill',{role:'textbox',name:'Embedded email'},{frameId:embedded.id,text:'same@example.test'});
  check('same-origin iframe changes independently verified',await wc.executeJavaScript('document.querySelector("iframe").contentDocument.querySelector("input").value==="same@example.test"'));
  await act('fill',{role:'textbox',name:'Cross origin email'},{frameId:cross.id,text:'cross@example.test'});
  const crossField=await call('locate',{id,frameId:cross.id,locator:{role:'textbox',name:'Cross origin email'}});
  check('cross-origin field readback confirms input',(await call('verify',{id,frameId:cross.id,observationId:crossField.observationId,ref:crossField.matches[0].ref,value:'cross@example.test'})).verified);
  const crossLocator={role:'textbox',name:'Cross origin email'};
  const actualValueWait=await call('wait',{id,frameId:cross.id,locator:crossLocator,value:'cross@example.test',timeoutMs:2000});
  check('cross-frame locator wait compares and accepts the actual field value',actualValueWait.satisfied&&actualValueWait.checks.some(item=>item.kind==='value'&&item.passed));
  const wrongValueWait=await call('wait',{id,frameId:cross.id,locator:crossLocator,value:'wrong-value@example.test',timeoutMs:300});
  check('visible cross-frame field with the wrong value times out without false success',wrongValueWait.satisfied===false&&wrongValueWait.timedOut===true&&wrongValueWait.checks.some(item=>item.kind==='value'&&item.passed===false));
  // Main-process WebFrameMain reads are independent of the automation adapter's
  // frame resolution and stored element references, including in OOPIF mode.
  const independentFrame=wc.mainFrame.framesInSubtree.find(frame=>frame.url===cross.url);
  assert.ok(independentFrame,'Independent cross-origin WebFrameMain must exist');
  if(capabilities) {
    await wc.executeJavaScript("document.querySelector('iframe[title=\"Cross origin editor\"]').style.opacity='0';true");
    try {
      await act('fill',crossLocator,{frameId:cross.id,text:'transparent-frame@example.test'});
      check('transparent iframe hit regions use the same geometry rules as native controls',await independentFrame.executeJavaScript('document.querySelector("input").value==="transparent-frame@example.test"'));
    } finally { await wc.executeJavaScript("document.querySelector('iframe[title=\"Cross origin editor\"]').style.opacity='';true"); }
  }
  const beforeOverlay=await independentFrame.executeJavaScript('document.querySelector("input").value');
  report.frameNegativeChecks={correctValueWait:{satisfied:actualValueWait.satisfied,checks:actualValueWait.checks},wrongValueWait:{satisfied:wrongValueWait.satisfied,timedOut:wrongValueWait.timedOut,checks:wrongValueWait.checks},beforeOverlay};
  await wc.executeJavaScript(`(()=>{const overlay=document.createElement('div');overlay.id='relay-frame-obstruction';overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(20,25,30,.15);pointer-events:auto';document.body.append(overlay);return document.elementFromPoint(20,20)===overlay})()`).then(covered=>assert.equal(covered,true,'Top-level overlay must receive hits'));
  try {
    const obscured=await call('locate',{id,frameId:cross.id,locator:crossLocator});
    assert.equal(obscured.count,1,'Child field remains readable under its parent overlay');
    // A deliberate rejection must bypass call(), which requires tool ok=true.
    const rejected=await rawCall('act',{id,frameId:cross.id,observationId:obscured.observationId,ref:obscured.matches[0].ref,kind:'fill',text:'must-not-reach-page@example.test',timeoutMs:500});
    report.frameNegativeChecks.rejectedFill={isError:rejected.isError,...rejected.value};
    // The shared 500ms budget may end during the last stable-frame CDP read.
    // Either diagnostic must still prove that no input was dispatched; the
    // independent frame read below checks the actual field remains unchanged.
    check('top-level iframe obstruction rejects child fill before sending input',rejected.isError&&rejected.value.ok===false&&['BROWSER_FRAME_OBSCURED','BROWSER_COMMAND_TIMEOUT'].includes(rejected.value.code)&&rejected.value.outcome==='not-executed');
    report.frameNegativeChecks.afterBlockedFill=await independentFrame.executeJavaScript('document.querySelector("input").value');
    check('independent cross-frame DOM confirms blocked fill did not mutate the field',report.frameNegativeChecks.afterBlockedFill===beforeOverlay);
  } finally { await wc.executeJavaScript('document.querySelector("#relay-frame-obstruction")?.remove()'); }
  await act('fill',crossLocator,{frameId:cross.id,text:'resumed@example.test'});
  report.frameNegativeChecks.afterUncover=await independentFrame.executeJavaScript('document.querySelector("input").value');
  check('removing the parent obstruction permits the cross-frame workflow to continue',report.frameNegativeChecks.afterUncover==='resumed@example.test');
  await act('fill',{label:'Rich text editor'},{text:'Editable content'});
  await act('press',{label:'Rich text editor'},{key:'Control+a'});
  check('contenteditable and modifier key input complete',await wc.executeJavaScript('document.querySelector("[contenteditable]").innerText === "Editable content"'));
  located=await call('locate',{id,locator:{css:'.ag-body-viewport'}});
  const before=await wc.executeJavaScript('document.querySelector(".ag-body-viewport").scrollTop');
  await call('act',{id,observationId:located.observationId,ref:located.matches[0].ref,kind:'scroll',deltaY:600});
  check('real virtual table scrolling moves its internal viewport',await until(async()=>await wc.executeJavaScript('document.querySelector(".ag-body-viewport").scrollTop')>before));
  await act('scrollIntoView',{css:'canvas'});located=await call('locate',{id,locator:{css:'canvas'}});const box=located.matches[0].bounds;
  await call('act',{id,observationId:located.observationId,kind:'drag',x:box.x+20,y:box.y+20,to:{x:box.x+180,y:box.y+40}});
  check('canvas coordinate drag dispatches pointer down and up',await wc.executeJavaScript('!!audit.dragStart && !!audit.dragEnd && audit.dragEnd[0]>audit.dragStart[0]+100'));
  await act('hover',{css:'canvas'});check('canvas hover reaches native pointer events',await wc.executeJavaScript('audit.hovered===true'));
  await act('doubleClick',{css:'canvas'});check('double click reaches the page',await wc.executeJavaScript('audit.doubleClicked===true'));
  await act('rightClick',{css:'canvas'});check('right click reaches custom page context menu',await wc.executeJavaScript('audit.rightClicked===true'));
  const image=await call('screenshot',{id});check('task screenshot persisted as PNG evidence',image.artifact?.sha256&&fs.existsSync(image.artifact.path));fs.copyFileSync(image.artifact.path,path.join(output,'completed.png'));
  check('evidence is discoverable from task history',(await call('evidence',{})).artifacts.some(x=>x.kind==='screenshot'));
  await call('navigate',{id,kind:'goto',url:base+'/next'});check('navigate reuses tab and reaches destination',(await call('wait',{id,text:'Navigation completed',timeoutMs:6000})).satisfied);
  await call('navigate',{id,kind:'back'});check('back restores original business page',(await call('wait',{id,text:'Complex operations desk',timeoutMs:6000})).satisfied);
  const parentId=id;
  const popup=await act('click',{role:'link',name:'Open linked record'},capabilities?{waitFor:{event:'navigation',url:base+'/popup',waitUntil:'load',timeoutMs:2000}}:{});
  check('authorized click binds its new tab and reports it without hidden-opener failure',popup.openedTabs?.length===1&&popup.requiresObservation);
  if(capabilities) check('a popup never masquerades as the requested opener navigation',popup.executed&&popup.waitResult?.satisfied===false);
  id=popup.openedTabs[0].id;wc=host.getAutomationTarget(id).webContents;
  check('popup belongs to the same task',(await call('tabs',{})).tabs.some(t=>t.id===id));
  check('popup reaches loaded state',(await call('wait',{id,text:'Linked record',timeoutMs:6000})).satisfied);
  await act('fill',{label:'Record note'},{text:'Continued in new tab'});
  check('new tab can continue the actual business workflow',await wc.executeJavaScript('document.querySelector("input").value==="Continued in new tab"'));
  if(background)check('complex page and popup complete without presentation or task takeover',!host.getAutomationTarget(id).presented&&!host.getAutomationTarget(parentId).presented&&(await call('tabs',{})).tabs.every(tab=>tab.state!=='paused'));
  await call('close',{id});id=parentId;wc=host.getAutomationTarget(id).webContents;
  await call('focus',{id});await call('close',{id});check('close releases the task tabs',(await call('tabs',{})).tabs.length===0);
  report.ok=true;
}).catch(async error=>{report.error=String(error.stack||error);console.error(report.error); try {report.failureDOM=await wc.executeJavaScript('({audit:window.audit,menuHidden:document.querySelector("#choices")?.hidden,active:document.activeElement?.outerHTML.slice(0,400),body:document.body.innerText.slice(0,8000)})');report.failureVisibility={focused:owner.isFocused(),visible:owner.isVisible(),presented:host.getAutomationTarget(id)?.presented};fs.writeFileSync(path.join(output,'failure.png'),(await wc.capturePage()).toPNG());}catch(e){report.captureError=String(e)} }).finally(async()=>{
  clearTimeout(deadline);controller.abort();service?.dispose();host?.destroy();if(owner&&!owner.isDestroyed())owner.destroy();
  for(const s of [server,frameServer])if(s){s.closeAllConnections();await new Promise(r=>s.close(r))}
  report.runtime={electron:process.versions.electron,chromium:process.versions.chrome};report.finishedAt=new Date().toISOString();save();app.exit(report.ok?0:1);
});
