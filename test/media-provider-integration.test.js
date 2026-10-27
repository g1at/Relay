'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProviderStore}=require('../src/main/providers/provider-store');
const {MediaService}=require('../src/main/media/media-service');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=';
for(const gateway of ['mify','custom'])test(`real provider bindings drive protocol execution through ${gateway} without model adapters`,async t=>{
 const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-media-integration-'));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
 const store=new ProviderStore({userDataDir,safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},logger:{warn(){}}});
 store.createProfile({name:'Synthetic gateway',baseUrl:gateway==='mify'?'https://gateway.invalid/anthropic':'https://gateway.invalid/proxy/v1',apiKey:'synthetic-only',models:{},mediaConnection:{preset:gateway},mediaModels:[{id:'new-image',modelId:'unlisted-2028-image',modality:'image',protocol:'openai-images',ownedBy:'arbitrary-owner',capabilities:{operations:['text_to_image'],defaults:{n:1},parameters:{n:{min:1,max:1}}}}]});
 const route=store.listMediaModels()[0];let count=0;
 const service=new MediaService({userDataDir,resolveRuntime:id=>store.getMediaRuntime(id),resolveCredential:snapshot=>store.resolveMediaCredential(snapshot),fetchImpl:async(url,request)=>{
  count++;assert.equal(url,gateway==='mify'?'https://gateway.invalid/v1/images/generations':'https://gateway.invalid/proxy/v1/images/generations');
  const headers=new Headers(request.headers);assert.equal(headers.get('authorization'),'Bearer synthetic-only');assert.equal(headers.get('x-model-provider-id'),gateway==='mify'?'arbitrary-owner':null);
  assert.equal(JSON.parse(request.body).model,'unlisted-2028-image');return new Response(JSON.stringify({data:[{b64_json:png}]}));
 }});
 const result=await service.generate({model:route.routeId,prompt:'A synthetic blue square',runId:'integration-job'});
 assert.equal(result.ok,true,result.error);assert.equal(result.paths.length,1);assert.equal(fs.readFileSync(result.paths[0]).toString('base64'),png);
 assert.equal((await service.generate({model:route.routeId,prompt:'same run',runId:'integration-job'})).ok,true);assert.equal(count,1);
 const durable=fs.readFileSync(path.join(userDataDir,'media-tasks','integration-job.json'),'utf8');assert.ok(!durable.includes('synthetic-only'));assert.ok(!durable.includes(png));
});
