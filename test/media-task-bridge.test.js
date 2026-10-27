'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const { RUN_STATES } = require('../src/main/tasks/task-protocol');
const { reconcileMediaTask } = require('../src/main/media/media-task-bridge');
function setup(t) {
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-media-bridge-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  const ledger=new TaskLedger({rootDir,logger:{warn(){}}});ledger.create({runId:'media-run',kind:'image'});
  const histories=[], events=[];
  const hooks={ledger,materialize:(task,result)=>histories.push(result),publish:task=>events.push(task),finish:(id,ok,details)=>ledger.terminal(id,ok?RUN_STATES.SUCCEEDED:RUN_STATES.FAILED,{result:{artifactPaths:details.artifactPaths,error:details.error}})};
  const send=patch=>reconcileMediaTask({id:'media-run',runId:'media-run',mediaKind:'video',state:'running',artifacts:[],...patch},hooks);
  return {ledger,rootDir,hooks,send,histories,events};
}
test('local stop stays resumable; completing the same remote job updates history and ledger',t=>{
 const f=setup(t);f.send({state:'accepted',remoteState:'queued'});assert.equal(f.ledger.get('media-run').state,'running');
 f.send({state:'stopped'});assert.equal(f.ledger.get('media-run').state,'waiting_user');
 f.send({state:'accepted'});f.send({state:'completed',artifacts:[{path:'/safe/generated.mp4'}]});
 assert.equal(f.ledger.get('media-run').state,'succeeded');assert.deepEqual(f.histories.at(-1).paths,['/safe/generated.mp4']);assert.equal(f.histories.at(-1).mediaKind,'video');
});
test('download failure keeps partial files and uses a recoverable waiting state',t=>{
 const f=setup(t);f.send({state:'needs_attention',remoteState:'succeeded',artifacts:[{path:'/safe/one.png'}],error:{message:'Download failed'}});
 assert.equal(f.ledger.get('media-run').state,'waiting_user');assert.equal(f.histories.at(-1).ok,false);assert.deepEqual(f.histories.at(-1).paths,['/safe/one.png']);
 f.send({state:'completed',artifacts:[{path:'/safe/one.png'},{path:'/safe/two.png'}]});assert.equal(f.ledger.get('media-run').state,'succeeded');
});
test('submission uncertainty never becomes a successful or failed remote task',t=>{
 const f=setup(t);f.send({state:'submission_unknown',error:{message:'Request timed out'}});
 assert.equal(f.ledger.get('media-run').state,'waiting_user');assert.equal(f.histories.at(-1).ok,false);assert.equal(f.events.at(-1).state,'submission_unknown');
});
test('startup retains externally recoverable runs while interrupting abandoned local work',t=>{
 const f=setup(t);f.send({state:'running'});f.ledger.create({runId:'local-run',kind:'chat'});
 const restored=new TaskLedger({rootDir:f.rootDir,logger:{warn(){}}});restored.recover({retainQueued:false,shouldRetain:run=>run.runId==='media-run'});
 assert.equal(restored.get('media-run').state,'running');assert.equal(restored.get('local-run').state,'interrupted');
});
test('remote completion does not overwrite a terminal cancellation record',t=>{
 const f=setup(t);f.ledger.terminal('media-run','canceled');f.send({state:'completed',artifacts:[{path:'/safe/video.mp4'}]});
 assert.equal(f.ledger.get('media-run').state,'canceled');assert.equal(f.histories.at(-1).ok,true);
});
test('continuation recovery uses mediaTaskId and verifies the stored run owner',t=>{
 const f=setup(t);const {ownsMediaRecovery}=require('../src/main/media/media-task-bridge');const dir=path.join(f.rootDir,'media-tasks');fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'original-media.json'),JSON.stringify({task:{id:'original-media',runId:'continuation'}}));
 assert.equal(ownsMediaRecovery({runId:'continuation',metadata:{mediaTaskId:'original-media'}},f.rootDir),true);
 assert.equal(ownsMediaRecovery({runId:'old-run',metadata:{mediaTaskId:'original-media'}},f.rootDir),false);
 assert.equal(ownsMediaRecovery({runId:'continuation',metadata:{mediaTaskId:'../../escape'}},f.rootDir),false);
});
test('active schedules retain completion ownership until history has been saved',t=>{
 const f=setup(t);let finished=0;
 const task={id:'media-run',runId:'media-run',source:{type:'schedule'},state:'completed',artifacts:[{path:'/safe/video.mp4'}]};
 reconcileMediaTask(task,{...f.hooks,reconcileSchedule:()=>({handled:true,active:true}),finishSchedule:()=>finished++});
 assert.equal(finished,0);assert.equal(f.histories.length,0);assert.notEqual(f.ledger.get('media-run').state,'succeeded');
 reconcileMediaTask(task,{...f.hooks,reconcileSchedule:()=>({handled:true,result:{ok:true,conversationId:'scheduled-history'}}),finishSchedule:(id,result)=>{assert.equal(result.conversationId,'scheduled-history');f.ledger.terminal(id,'succeeded');finished++;}});
 assert.equal(finished,1);assert.equal(f.ledger.get('media-run').state,'succeeded');
});
