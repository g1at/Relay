'use strict';
const assert=require('node:assert/strict');

// Extra cases run inside the existing 10,000-row AG Grid workflow. All actions
// cross the real MCP schema and service; DOM/server checks are independent.
module.exports=async function({call,rawCall,act,wc,id,base,events,check,until,pause,report,service,context}) {
  const row={within:{role:'grid'},role:'row',has:{role:'gridcell',text:'Company 00002',exact:true}};
  const checkbox={...row,chain:[{role:'checkbox'}]};
  const found=await call('locate',{id,locator:checkbox});
  check('composed locator finds a checkbox inside the matching real virtual grid row',found.count===1);
  await call('act',{id,observationId:found.observationId,locator:checkbox,kind:'click'});
  check('the intended AG Grid record is selected independently',await wc.executeJavaScript('auditApi.getSelectedRows().length===1 && auditApi.getSelectedRows()[0].id===2'));
  check('checkbox assertion reads the real selected row control',(await call('verify',{id,locator:checkbox,checked:true,enabled:true})).verified);
  const count=await wc.executeJavaScript('document.querySelectorAll(".ag-center-cols-container [role=row]").length');
  check('count assertion matches independently rendered virtual rows',(await call('verify',{id,locator:{within:{css:'.ag-center-cols-container'},role:'row'},count})).verified);
  check('wrong count cannot pass through tool transport success',!(await call('verify',{id,locator:{within:{css:'.ag-center-cols-container'},role:'row'},count:count+1})).verified);
  const tree=await call('observe',{id,scope:{role:'grid'},format:'tree',limit:8});
  const nodes=[];const visit=items=>{for(const item of items||[]){nodes.push(item);visit(item.children)}};visit(tree.tree);
  check('real grid semantic tree preserves row containment and paginated ref ownership',tree.treeInfo?.kind==='dom-semantic-tree'&&tree.treeInfo.paginated&&nodes.some(x=>x.role==='grid')&&nodes.some(x=>x.role==='row')&&nodes.filter(x=>x.ref).every(x=>tree.elements.some(e=>e.ref===x.ref)));

  // Keep a production grid alive while exercising controlled replacement and
  // event races. The controls are deliberately isolated from user profiles.
  await wc.executeJavaScript(`(()=>{
    const box=document.createElement('section');box.id='capability-controls';box.style.cssText='position:fixed;top:10px;right:10px;width:290px;background:white;border:2px solid #333;padding:10px;z-index:30';
    box.innerHTML='<button id="replace-target" disabled>Replaceable submit</button><button id="stale-target" disabled>Bound submit</button><button id="moving-target">Moving submit</button><button id="response-target">Save response</button><a id="navigation-target" href="/next">Atomic navigation</a><input aria-label="Capability input" readonly value="draft"><select aria-label="Capability select"><option selected>First</option><option>Second</option></select>';
    document.body.append(box);window.capabilityAudit={replacement:0,stale:0,moving:0,response:0};
    box.addEventListener('click',e=>{const key={'replace-target':'replacement','stale-target':'stale','moving-target':'moving','response-target':'response'}[e.target.id];if(key)capabilityAudit[key]++;if(e.target.id==='response-target')fetch('/capability-response',{method:'POST'});});
    window.replaceCapabilityButton=id=>{const previous=document.getElementById(id),next=previous.cloneNode(true);next.disabled=false;previous.replaceWith(next);};
    return true;
  })()`);
  try {
    const combined={within:{css:'#capability-controls'},role:'button',hasNotText:'submit',and:[{css:'button'}],or:[{role:'link',name:'Atomic navigation'}],visible:true};
    check('intersection, union and text filtering preserve scoped DOM order',(await call('locate',{id,locator:combined})).matches.map(x=>x.name).join('|')==='Save response|Atomic navigation');
    check('readonly and selected assertions read element semantics',(await call('verify',{id,locator:{label:'Capability input'},editable:false,value:'draft',attribute:{name:'readonly',value:''}})).verified && (await call('verify',{id,locator:{role:'option',name:'First'},selected:true})).verified);
    check('missing attributes are distinct from empty attributes',(await call('verify',{id,locator:{label:'Capability input'},attribute:{name:'data-absent',value:null}})).verified && !(await call('verify',{id,locator:{label:'Capability input'},attribute:{name:'readonly',value:null}})).verified);

    let observation=await call('observe',{id});
    await wc.executeJavaScript("setTimeout(()=>replaceCapabilityButton('replace-target'),220);true");
    const replaced=await call('act',{id,observationId:observation.observationId,locator:{role:'button',name:'Replaceable submit'},kind:'click',timeoutMs:2000});
    check('locator action recovers a replaced disabled control before sending input',replaced.executed&&await wc.executeJavaScript('capabilityAudit.replacement===1'));

    const bound=await call('locate',{id,locator:{role:'button',name:'Bound submit'}});
    await wc.executeJavaScript("setTimeout(()=>replaceCapabilityButton('stale-target'),220);true");
    const stale=await rawCall('act',{id,observationId:bound.observationId,ref:bound.matches[0].ref,kind:'click',timeoutMs:1500});
    check('an explicitly bound stale ref never silently targets a replacement',stale.isError&&stale.value.outcome==='not-executed'&&await wc.executeJavaScript('capabilityAudit.stale===0'));

    await wc.executeJavaScript("document.querySelector('#moving-target').animate([{transform:'translateX(-35px)'},{transform:'translateX(35px)'}],{duration:240,iterations:Infinity,direction:'alternate'});true");
    observation=await call('observe',{id});
    const moving=await rawCall('act',{id,observationId:observation.observationId,locator:{role:'button',name:'Moving submit'},kind:'click',timeoutMs:450});
    check('continuous target movement expires without dispatching a click',moving.isError&&moving.value.outcome==='not-executed'&&await wc.executeJavaScript('capabilityAudit.moving===0'));
    await wc.executeJavaScript("document.querySelector('#moving-target').getAnimations().forEach(a=>a.cancel());true");
    await act('click',{role:'button',name:'Moving submit'});
    check('the same target becomes actionable when its animation settles',await wc.executeJavaScript('capabilityAudit.moving===1'));

    const response=await act('click',{role:'button',name:'Save response'},{waitFor:{event:'response',url:base+'/capability-response',method:'POST',status:201,timeoutMs:2000}});
    check('arm-before-click captures a fast response exactly once',response.executed&&response.waitResult?.satisfied&&events.filter(x=>x.url==='/capability-response').length===1&&await wc.executeJavaScript('capabilityAudit.response===1'));
    const mismatch=await act('click',{role:'button',name:'Save response'},{waitFor:{event:'response',url:base+'/capability-response',method:'POST',status:202,timeoutMs:550}});
    check('wrong response status times out while preserving the executed action',mismatch.executed&&mismatch.waitResult?.satisfied===false&&mismatch.waitResult.timedOut&&events.filter(x=>x.url==='/capability-response').length===2&&await wc.executeJavaScript('capabilityAudit.response===2'));
    report.capabilityEventResults={response:response.waitResult,mismatch:mismatch.waitResult};
    const childWait=rawCall('wait',{id,event:'response',url:base+'/capability-response',method:'POST',status:201,timeoutMs:450});
    await pause(100);
    const embedded=wc.mainFrame.framesInSubtree.find(frame=>frame.url===base+'/embedded');assert.ok(embedded);
    await embedded.executeJavaScript("fetch('/capability-response',{method:'POST'}).then(()=>true)");
    const childResult=await childWait;
    check('a matching response from an embedded frame cannot satisfy a main-page wait',childResult.value.satisfied===false&&childResult.value.timedOut&&events.filter(x=>x.url==='/capability-response').length===3);
    const old=await call('wait',{id,event:'navigation',waitUntil:'load',timeoutMs:200});
    check('the already loaded page does not satisfy a new-navigation wait',old.satisfied===false&&old.timedOut);
    check('current-document load wait recognizes the actual loaded document',(await call('wait',{id,event:'load',waitUntil:'load',timeoutMs:1000})).satisfied);
    const cancellationStart=Date.now(),waiting=rawCall('wait',{id,event:'response',url:base+'/never',timeoutMs:10000});
    await pause(100);service.control({action:'pause',id});const cancelled=await waiting;
    check('takeover promptly cancels a pending event wait',cancelled.isError&&cancelled.value.code==='AUTOMATION_PAUSED'&&Date.now()-cancellationStart<2000);
    assert.equal(service.control({action:'resume',id,conversationId:context.conversationId}).ok,true);

    const navigated=await act('click',{role:'link',name:'Atomic navigation'},{waitFor:{event:'navigation',url:base+'/next',waitUntil:'load',timeoutMs:3000}});
    check('atomic navigation waits for the new document and load event',navigated.executed&&navigated.waitResult?.satisfied&&wc.getURL()===base+'/next');
    await call('navigate',{id,kind:'back'});
    check('complex grid is restored after navigation acceptance',await until(()=>wc.executeJavaScript('window.auditApi?.getDisplayedRowCount()===10000')));
  } finally {
    if(wc.getURL()===base+'/') await wc.executeJavaScript("document.querySelector('#capability-controls')?.remove();true");
  }
};
