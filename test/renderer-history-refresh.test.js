'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer/app.js'),'utf8');
const start=source.indexOf('async function refreshHistoryList()'),code=source.slice(start,source.indexOf('function resolveHistoryJumpIndex',start));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function fixture({load,projects,composer=true}={}) {
 const calls={history:0,projects:0,renders:[],active:'old'};
 const manager={refresh:async()=>{calls.projects++;return projects?projects(calls.projects):[{id:'project-current'}]}};
 const context=vm.createContext({historyRefreshRevision:0,historyRefreshPromise:null,getProjectComposer:()=>composer?manager:null,
 historyEl:{},ensureHistoryDelegation(){},buildHistoryRow(){},updateHistoryRow(){},isConvRunning:id=>id===calls.active,
 window:{api:{history:{list:async()=>{calls.history++;return load?load(calls.history):[{id:'current'}]}}},
 RelaySidebarHistory:{reconcile(host,items,options){calls.renders.push({items,projects:options.projects,active:calls.active});calls.onRender?.();}}}});
 vm.runInContext(code,context);return{calls,refresh:()=>context.refreshHistoryList(),context};
}
test('a same-turn burst shares one history and project read and one sidebar reconciliation',async()=>{
 const h=fixture();await Promise.all(Array.from({length:128},h.refresh));
 assert.equal(h.calls.history,1);assert.equal(h.calls.projects,1);assert.equal(h.calls.renders.length,1);
});
test('invalidations during a read discard the old conversation/project snapshot and await one fresh read',async()=>{
 const first=gate(),second=gate(),h=fixture({load:n=>(n===1?first:second).promise,projects:n=>[{id:'project-'+n}]});
 const pending=[h.refresh()];await tick();h.calls.active='new';
 for(let i=0;i<64;i++)pending.push(h.refresh());
 assert.equal(h.calls.history,1);
 first.resolve([{id:'old'}]);await tick();assert.equal(h.calls.history,2);assert.equal(h.calls.renders.length,0);
 let finished=false;Promise.all(pending).then(()=>finished=true);await tick();assert.equal(finished,false);
 second.resolve([{id:'new'}]);await Promise.all(pending);
 assert.equal(h.calls.projects,2);assert.equal(h.calls.renders.length,1);
 assert.equal(h.calls.renders[0].items[0].id,'new');assert.equal(h.calls.renders[0].projects[0].id,'project-2');assert.equal(h.calls.renders[0].active,'new');
});
test('the newest failure rejects its callers and the next explicit refresh can retry',async()=>{
 let fail=true;const h=fixture({load:()=>{if(fail)throw Error('synthetic unavailable');return[{id:'retry'}]}});
 await assert.rejects(Promise.all(Array.from({length:8},h.refresh)),/synthetic unavailable/);
 assert.equal(h.calls.renders.length,0);fail=false;await h.refresh();
 assert.equal(h.calls.renders.length,1);assert.equal(h.calls.renders[0].items[0].id,'retry');
});
test('an obsolete failure does not drop a newer invalidation',async()=>{
 const old=gate(),h=fixture({load:n=>n===1?old.promise:[{id:'fresh'}]});
 const one=h.refresh();await tick();const two=h.refresh();old.reject(Error('obsolete failure'));
 await Promise.all([one,two]);assert.equal(h.calls.history,2);assert.equal(h.calls.renders.length,1);assert.equal(h.calls.renders[0].items[0].id,'fresh');
});
test('an invalidation during reconciliation is followed by a new snapshot before callers settle',async()=>{
 const h=fixture();let next;h.calls.onRender=()=>{if(h.calls.renders.length===1)next=h.refresh()};
 await h.refresh();await next;assert.equal(h.calls.history,2);assert.equal(h.calls.renders.length,2);
});
test('history still renders without a project composer',async()=>{
 const h=fixture({composer:false});await h.refresh();assert.equal(h.calls.history,1);assert.equal(h.calls.projects,0);assert.equal(h.calls.renders[0].projects.length,0);
});

test('continuous invalidations still publish progress without opening parallel reads',async()=>{
 const reads=[];const h=fixture({load:()=>{const read=gate();reads.push(read);return read.promise}});
 const pending=[h.refresh()];await tick();
 for(let i=0;i<4;i++){
  pending.push(h.refresh());reads[i].resolve([{id:'snapshot-'+i}]);await tick();
  assert.equal(h.calls.history,i+2,'only one sequential follow-up read');
  if(i>=1)assert.ok(h.calls.renders.length>=Math.floor((i+1)/2),'bounded stale reads cannot starve the sidebar');
 }
 reads[4].resolve([{id:'final'}]);await Promise.all(pending);
 assert.equal(h.calls.renders.at(-1).items[0].id,'final');
});
test('an invalidation in the completion microtask window cannot be lost',async()=>{
 const h=fixture();let next;
 h.calls.onRender=()=>{if(h.calls.renders.length===1)queueMicrotask(()=>{next=h.refresh()})};
 await h.refresh();await next;
 assert.equal(h.calls.history,2);assert.equal(h.calls.renders.length,2);
});
