'use strict';
// Actual main project IPC/resolver/history functions with isolated temp files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createProjectStore } = require('../project-store');
const workspaces = require('../conversation-workspaces');
const { mergeSupplementHistory } = require('../live-supplement-input');
const { createAgentEnvironment } = require('../agent-environment');
const { createGeneralPreferences, registerGeneralPreferencesIpc, normalizePreferences } = require('../general-preferences');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
function declaration(name) { const start=source.indexOf('function '+name+'(');assert.ok(start>=0);const tail=source.slice(start);const next=/\n(?:async )?function \w+\(/.exec(tail);return next?tail.slice(0,next.index):tail; }
function ipc(name) { const start=source.indexOf(`ipcMain.handle('${name}'`);assert.ok(start>=0);const tail=source.slice(start);const end=/\r?\n\}\);/.exec(tail);assert.ok(end);return tail.slice(0,end.index+end[0].length); }
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-project-main-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const folders=['alpha','beta'].map(name=>{const folder=path.join(root,name);fs.mkdirSync(folder);return folder;});
  const records=new Map(),writes=[],handlers=new Map(),liveSessions=new Map(),liveTombstones=new Map(),ledger=[],kills=[];
  const file=id=>path.join(root,id+'.json');
  const persist=value=>{records.set(value.id,clone(value));writes.push(clone(value));fs.writeFileSync(file(value.id),JSON.stringify(value));};
  const context={miniChat:null,fs,path,createProjectStore,...workspaces,WORKSPACE_UUID:workspaces.UUID,
    createAgentEnvironment, registerGeneralPreferencesIpc, normalizePreferences, dialog:{},mainWindow:null,
    createGeneralPreferences:options=>createGeneralPreferences({...options,homeDir:root}),claudeSdk:{configureRuntimeEnvironment(){}},
    createConversationWorkspaces:options=>workspaces.createConversationWorkspaces({...options,homeDir:root}),
    app:{getPath:()=>root},convFilePath:file,loadConversation:id=>records.has(id)?clone(records.get(id)):null,
    persistConversationRecord:persist,readHistoryIndex:()=>[...records.values()].map(clone),readAppSettings:()=>({}),
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},shell:{openPath:async()=>''},liveSessions,liveTombstones,
    taskLedger:{list:()=>ledger},RUN_STATES:{QUEUED:'queued'},killLiveSession:(sess,reason)=>{kills.push(reason);liveSessions.delete(sess.convId);},
    mergeSupplementHistory,TITLE_MAX_W:64,truncateByWidth:value=>value,genId:()=>ids[0],
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context);
  vm.runInContext(declaration('sdkProjectContext'),context);
  const start=source.indexOf('let projectStore = null;'),end=source.indexOf('const workspaceTools =',start);assert.ok(start>0&&end>start);
  vm.runInContext(source.slice(start,end),context);
  vm.runInContext(declaration('saveConversation'),context);
  for(const name of ['history:list','history:load','history:save'])vm.runInContext(ipc(name),context);
  return {root,folders,context,records,writes,handlers,liveSessions,liveTombstones,ledger,kills,persist,
    store:context.getProjectStore(),save:value=>handlers.get('history:save')({},clone(value)),
    conversation:(id=ids[0],folder=folders[0])=>({id,title:'Original title',createdAt:'2020-01-01',updatedAt:'2020-02-01',pinned:true,mode:'plain',sessionId:'old-session',workingDir:folder?{path:folder,name:'Original folder'}:null,turns:[{user:'Original request',assistant:'Original answer'}]})};
}
test('main startup migration groups legacy paths without writing or reordering history',t=>{
  const h=fixture(t);h.persist(h.conversation());h.persist(h.conversation(ids[1]));const before=clone([...h.records.values()]),writes=h.writes.length;
  const list=h.handlers.get('history:list')();assert.equal(h.store.list().length,1);assert.equal(list[0].projectId,list[1].projectId);
  assert.equal(h.writes.length,writes);assert.deepEqual([...h.records.values()],before);
  h.handlers.get('history:list')();assert.equal(h.store.list().length,1);assert.equal(h.writes.length,writes);
});
test('main assignment preserves conversation content/timestamps and invalidates the old live process',t=>{
  const h=fixture(t),original=h.conversation();h.persist(original);h.context.projectConversation(original);const b=h.store.add(h.folders[1]);
  h.liveSessions.set(ids[0],{convId:ids[0],busy:false});h.liveTombstones.set(ids[0],{sessionId:'old-session'});
  const result=h.handlers.get('projects:assign')({},{conversationId:ids[0],projectId:b.id});
  assert.equal(result.ok,true);const saved=h.records.get(ids[0]);assert.equal(saved.projectId,b.id);assert.equal(saved.workingDir.path,b.path);
  assert.equal(saved.updatedAt,original.updatedAt);assert.deepEqual(saved.turns,original.turns);assert.equal(saved.pinned,true);assert.equal(saved.sessionId,null);
  assert.equal(h.kills.length,1);assert.equal(h.liveTombstones.has(ids[0]),false);
});
test('both live and one-shot queued tasks prevent project changes and removal',t=>{
  for(const sourceType of ['live','ledger']){
    const h=fixture(t);h.persist(h.conversation());const a=h.context.projectConversation(h.conversation()).projectId,b=h.store.add(h.folders[1]);
    if(sourceType==='live')h.liveSessions.set(ids[0],{busy:true});else h.ledger.push({state:'queued',source:{conversationId:ids[0]}});
    assert.equal(h.handlers.get('projects:assign')({},{conversationId:ids[0],projectId:b.id}).ok,false);
    assert.equal(h.handlers.get('projects:remove')({},a).ok,false);assert.equal(h.store.binding(ids[0]),a);assert.equal(h.kills.length,0);
  }
});
test('file tools and model execution use the same authoritative project despite stale context',t=>{
  const h=fixture(t);h.persist(h.conversation());h.context.projectConversation(h.conversation());const b=h.store.add(h.folders[1]);h.context.updateConversationProject(ids[0],b.id);
  const file=h.context.resolveWorkspaceForTools({conversationId:ids[0],workingDir:h.folders[0],projectId:'stale-project'});
  const model=h.context.resolveExecutionWorkspace({conversationId:ids[0],workingDir:h.folders[0]});
  assert.equal(file.root,b.path);assert.equal(model.cwd,b.path);assert.equal(file.projectId,b.id);assert.equal(model.managed,false);
});
test('late renderer save cannot restore removed project membership or old directory',t=>{
  const h=fixture(t),stale=h.conversation();h.persist(stale);const a=h.context.projectConversation(stale).projectId;
  const file=path.join(h.folders[0],'user-report.md');fs.writeFileSync(file,'keep exactly');
  assert.equal(h.handlers.get('projects:remove')({},a).ok,true);h.save({...stale,projectId:a});
  assert.equal(h.records.get(ids[0]).projectId,null);assert.equal(h.records.get(ids[0]).workingDir,null);
  assert.deepEqual(h.records.get(ids[0]).turns,stale.turns);assert.equal(fs.readFileSync(file,'utf8'),'keep exactly');
  const resolved=h.context.resolveWorkspaceForTools({conversationId:ids[0],workingDir:h.folders[0],projectId:a});
  assert.equal(resolved.managed,true);assert.equal(resolved.root,path.join(h.root,'RelayProjects',ids[0]));
});
test('late renderer save cannot re-authorize the prior project SDK session before first workspace resolve',t=>{
  const h=fixture(t),stale=h.conversation();h.persist(stale);h.context.projectConversation(stale);const b=h.store.add(h.folders[1]);
  h.context.updateConversationProject(ids[0],b.id);h.save(stale);
  const next=h.context.resolveExecutionWorkspace({conversationId:ids[0]});assert.equal(next.cwd,b.path);
  assert.equal(h.context.getConversationWorkspaces().acceptsSession(ids[0],'old-session'),false);
  assert.equal(h.records.get(ids[0]).sessionId,null);
});
test('new draft workspace project choice resolves without silently binding or moving other conversations',t=>{
  const h=fixture(t),a=h.store.add(h.folders[0]),b=h.store.add(h.folders[1]);
  const first=h.context.resolveWorkspaceForTools({conversationId:ids[0],projectId:a.id});const second=h.context.resolveWorkspaceForTools({conversationId:ids[1],projectId:b.id});
  assert.equal(first.root,a.path);assert.equal(second.root,b.path);assert.equal(h.records.size,0);assert.equal(h.store.binding(ids[0]),undefined);
});
test('first late history save adopts authoritative legacy directory from disk before renderer snapshot',t=>{
  const h=fixture(t),onDisk=h.conversation(ids[0],h.folders[1]),stale={...h.conversation(),updatedAt:'older-time'};h.persist(onDisk);
  h.save(stale);
  assert.equal(h.store.resolve(ids[0]).path,h.folders[1]);assert.equal(h.records.get(ids[0]).workingDir.path,h.folders[1]);
});
test('project removal rejects every prior SDK session before stale history can restore it',t=>{
  const h=fixture(t),one=h.conversation(),two={...h.conversation(ids[1]),sessionId:'second-session'};h.persist(one);h.persist(two);
  h.context.initializeProjectHistory();const projectId=h.store.binding(ids[0]);
  assert.equal(h.handlers.get('projects:remove')({},projectId).ok,true);
  assert.equal(h.records.get(ids[0]).updatedAt,one.updatedAt);assert.equal(h.records.get(ids[1]).updatedAt,two.updatedAt);
  h.save(one);h.save(two);
  for(const original of [one,two]){
    const root=h.context.resolveExecutionWorkspace({conversationId:original.id});assert.equal(root.managed,true);
    assert.equal(h.context.getConversationWorkspaces().acceptsSession(original.id,original.sessionId),false);
    assert.equal(h.records.get(original.id).sessionId,null);
  }
});
test('session registry failure blocks project binding or removal before authority changes',t=>{
  const h=fixture(t),original=h.conversation();h.persist(original);h.context.projectConversation(original);const a=h.store.binding(ids[0]),b=h.store.add(h.folders[1]);
  h.context.getConversationWorkspaces().invalidateConversationSession=()=>{throw Error('isolated registry unavailable');};
  assert.equal(h.handlers.get('projects:assign')({},{conversationId:ids[0],projectId:b.id}).ok,false);
  assert.equal(h.store.binding(ids[0]),a);assert.deepEqual(h.records.get(ids[0]),original);
  assert.equal(h.handlers.get('projects:remove')({},a).ok,false);assert.equal(h.store.binding(ids[0]),a);assert.ok(h.store.get(a));
});
test('project changes preserve pending history context even without an SDK session and after late save',t=>{
  const h=fixture(t),stale={...h.conversation(),sessionId:null};h.persist(stale);h.context.projectConversation(stale);const b=h.store.add(h.folders[1]);
  h.context.updateConversationProject(ids[0],b.id);h.save(stale);
  const next=h.context.resolveExecutionWorkspace({conversationId:ids[0]});assert.equal(next.cwd,b.path);assert.equal(next.needsContext,true);
  assert.match(workspaces.conversationContext(next.conversation),/Original answer/);
});
test('scheduled explicit directories bypass project selection without mutating project membership',t=>{
  const h=fixture(t),original=h.conversation();h.persist(original);const projectId=h.context.projectConversation(original).projectId;
  const scheduled=h.context.resolveExecutionWorkspace({conversationId:ids[0],workingDir:h.folders[1],ignoreProjects:true});
  assert.equal(scheduled.cwd,h.folders[1]);assert.equal(h.store.binding(ids[0]),projectId);
  const tools=h.context.resolveWorkspaceForTools({conversationId:ids[0],workingDir:h.folders[1]});assert.equal(tools.cwd,h.folders[0]);
});
