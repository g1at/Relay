'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProviderStore}=require('../src/main/providers/provider-store');
test('anonymous media-only gateways require no dummy credentials and cannot enable unauthenticated chat',t=>{
 const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-noauth-'));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
 const store=new ProviderStore({userDataDir,safeStorage:{isEncryptionAvailable:()=>false},logger:{warn(){}}});
 const input={name:'Local media',baseUrl:'http://localhost:9000',models:{},mediaConnection:{authMode:'none'},mediaModels:[{id:'custom',modelId:'arbitrary-new-model',protocol:'openai-images',modality:'image',capabilities:{operations:['text_to_image']}}]};
 const created=store.createProfile(input);assert.equal(created.profile.hasCredential,false);
 const route=store.listMediaModels()[0];assert.equal(route.available,true);assert.equal(store.getMediaRuntime(route.routeId).apiKey,'');
 assert.throws(()=>store.createProfile({...input,models:{haiku:'chat-model'}}),/API Key/);
 assert.throws(()=>store.createProfile({...input,mediaConnection:{authMode:'bearer'}}),/API Key/);
 assert.throws(()=>store.createProfile({...input,mediaModels:[{...input.mediaModels[0],auth:{mode:'api-key'}}]}),/API Key/);
});

test('anonymous media gateways can be edited and duplicated without introducing dummy keys',t=>{
 const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-noauth-edit-'));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
 const store=new ProviderStore({userDataDir,safeStorage:{isEncryptionAvailable:()=>false},logger:{warn(){}}});
 const model={id:'custom',modelId:'arbitrary-new-model',protocol:'openai-images',capabilities:{operations:['text_to_image']}};
 const created=store.createProfile({name:'Local media',baseUrl:'http://localhost:9000',models:{},mediaConnection:{authMode:'none'},mediaModels:[model]}).profile;
 const renamed=store.updateProfile(created.id,{name:'Renamed local media'}).profile;
 assert.equal(renamed.name,'Renamed local media');assert.equal(renamed.hasCredential,false);
 store.updateProfile(created.id,{baseUrl:'http://localhost:9001',mediaModels:[{...model,modelId:'another-model'}]});
 const duplicate=store.duplicateProfile(created.id).profile;
 assert.notEqual(duplicate.id,created.id);assert.equal(duplicate.hasCredential,false);
 assert.equal(duplicate.mediaModels[0].modelId,'another-model');
 for(const route of store.listMediaModels()){
  assert.equal(route.available,true);
  const runtime=store.getMediaRuntime(route.routeId);assert.equal(runtime.apiKey,'');assert.equal(runtime.baseUrl,'http://localhost:9001');
  assert.equal(store.resolveMediaCredential(runtime),'');
 }
 const restored=new ProviderStore({userDataDir,safeStorage:{isEncryptionAvailable:()=>false},logger:{warn(){}}});
 assert.equal(restored.listMediaModels().filter(route=>route.available).length,2);
});

test('editing an anonymous gateway cannot enable authenticated models without a key',t=>{
 const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-noauth-transition-'));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
 const store=new ProviderStore({userDataDir,safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},logger:{warn(){}}});
 const model={id:'custom',modelId:'arbitrary-model',protocol:'openai-images',capabilities:{operations:['text_to_image']}};
 const created=store.createProfile({name:'Local media',baseUrl:'http://localhost:9000',models:{},mediaConnection:{authMode:'none'},mediaModels:[model]}).profile;
 for(const patch of [{models:{haiku:'chat-model'}},{mediaConnection:{authMode:'bearer'}},{mediaModels:[{...model,auth:{mode:'api-key'}}]},{mediaModels:[]}]){
  assert.throws(()=>store.updateProfile(created.id,patch),/API Key/);
  assert.deepEqual(store.getProfile(created.id),created,'failed edits leave the profile unchanged');
 }
 const changed=store.updateProfile(created.id,{apiKey:'fixture-auth-transition',mediaConnection:{authMode:'bearer'}}).profile;
 assert.equal(changed.hasCredential,true);
 assert.equal(store.getMediaRuntime(store.listMediaModels()[0].routeId).apiKey,'fixture-auth-transition');
});
