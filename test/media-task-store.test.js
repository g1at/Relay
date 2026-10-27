'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { MediaTaskStore } = require('../src/main/media/media-task-store');

async function folder(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(),'relay-media-store-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir; }
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    seal(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm',key,iv); const body = Buffer.concat([c.update(text),c.final()]); return Buffer.concat([iv,c.getAuthTag(),body]); },
    unseal(bytes) { const c = crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12)); c.setAuthTag(bytes.subarray(12,28)); return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString(); }
  };
}
test('private inputs and signed URLs are sealed and survive a fresh store without credential values', async t => {
  const userDataDir = await folder(t), crypt = encryption();
  const store = new MediaTaskStore({userDataDir,...crypt});
  await store.save({id:'task-1',state:'accepted',conversationId:'a',snapshot:{credentialRef:'ref',credentialVersion:'v1',apiKey:'never-persist-this'}},{outputs:[{kind:'url',value:'https://cdn.example/asset?signature=private-signature'}],input:{prompt:'private-prompt'}});
  const raw = await fs.readFile(store.file('task-1'),'utf8');
  assert.ok(!raw.includes('private-signature')); assert.ok(!raw.includes('private-prompt')); assert.ok(!raw.includes('never-persist-this'));
  const restored = await new MediaTaskStore({userDataDir,...crypt}).load('task-1');
  assert.equal(restored.payload.input.prompt,'private-prompt'); assert.equal(restored.sensitiveUnavailable,false);
  assert.equal((await store.list({conversationId:'a'})).length,1); assert.equal((await store.list({conversationId:'b'})).length,0);
});
test('missing or broken encryption never falls back to plaintext private storage', async t => {
  const userDataDir = await folder(t);
  const store = new MediaTaskStore({userDataDir,seal(){throw Error('OS locked');},unseal(){throw Error('OS locked');}});
  await store.save({id:'task-2',state:'downloading'},{outputs:[{value:'sensitive-download-token'}]});
  assert.equal((await store.load('task-2')).payload.outputs[0].value,'sensitive-download-token');
  assert.ok(!(await fs.readFile(store.file('task-2'),'utf8')).includes('sensitive-download-token'));
  const afterRestart = await new MediaTaskStore({userDataDir}).load('task-2');
  assert.equal(afterRestart.payload,null); assert.equal(afterRestart.sensitiveUnavailable,true);
});
test('serialized writes retain the latest state even when encryption is asynchronous', async t => {
  const userDataDir = await folder(t), crypt=encryption();
  let calls=0;
  const store=new MediaTaskStore({userDataDir,...crypt,async seal(text){if(++calls===1)await new Promise(r=>setTimeout(r,20));return crypt.seal(text);}});
  await Promise.all([store.save({id:'ordered',state:'accepted'},{value:1}),store.save({id:'ordered',state:'completed'},{value:2})]);
  const restored=await new MediaTaskStore({userDataDir,...crypt}).load('ordered');
  assert.equal(restored.task.state,'completed'); assert.equal(restored.payload.value,2);
  assert.deepEqual((await fs.readdir(store.directory)).filter(x=>x.endsWith('.tmp')),[]);
});
test('state-only writes preserve encrypted references while the OS key is temporarily unavailable', async t => {
  const userDataDir = await folder(t), crypt = encryption();
  const original = new MediaTaskStore({ userDataDir, ...crypt });
  const payload = { input: { prompt: 'original-private-prompt' }, outputs: [{ kind: 'url', value: 'https://cdn.example/result?signature=original-private-token' }] };
  await original.save({ id: 'locked-key', state: 'downloading', remoteState: 'succeeded' }, payload);
  const before = JSON.parse(await fs.readFile(original.file('locked-key'), 'utf8'));
  const locked = new MediaTaskStore({ userDataDir, ...crypt, unseal() { throw Error('OS key temporarily locked'); } });
  const unavailable = await locked.load('locked-key');
  assert.equal(unavailable.payload, null);
  assert.equal(unavailable.sensitiveUnavailable, true);
  await locked.save({ ...unavailable.task, state: 'needs_attention' });
  const raw = await fs.readFile(locked.file('locked-key'), 'utf8');
  const after = JSON.parse(raw);
  assert.deepEqual(after.protectedPayload, before.protectedPayload);
  assert.equal(after.task.payloadPersistence, 'encrypted');
  assert.ok(!raw.includes('original-private-prompt') && !raw.includes('original-private-token'));
  const restored = await new MediaTaskStore({ userDataDir, ...crypt }).load('locked-key');
  assert.equal(restored.task.state, 'needs_attention');
  assert.deepEqual(restored.payload, payload);
  assert.equal(restored.sensitiveUnavailable, false);
});
test('failed re-encryption retains the previous sealed payload without claiming newer values were persisted', async t => {
  const userDataDir = await folder(t), crypt = encryption();
  const original = new MediaTaskStore({ userDataDir, ...crypt });
  const previousPayload = { outputs: [{ kind: 'url', value: 'https://cdn.example/previous?signature=old-private-token' }] };
  await original.save({ id: 'seal-failure', state: 'downloading' }, previousPayload);
  const before = JSON.parse(await fs.readFile(original.file('seal-failure'), 'utf8'));
  const unavailable = new MediaTaskStore({ userDataDir, ...crypt, seal() { throw Error('OS encryption temporarily unavailable'); } });
  const loaded = await unavailable.load('seal-failure');
  assert.deepEqual(loaded.payload, previousPayload);
  const latestPayload = { outputs: [{ kind: 'url', value: 'https://cdn.example/latest?signature=new-private-token' }] };
  const saved = await unavailable.save({ ...loaded.task, state: 'needs_attention' }, latestPayload);
  assert.equal(saved.payloadPersistence, 'memory_only');
  assert.deepEqual((await unavailable.load('seal-failure')).payload, latestPayload);
  const raw = await fs.readFile(unavailable.file('seal-failure'), 'utf8');
  assert.deepEqual(JSON.parse(raw).protectedPayload, before.protectedPayload);
  assert.ok(!raw.includes('old-private-token') && !raw.includes('new-private-token'));
  const restored = await new MediaTaskStore({ userDataDir, ...crypt }).load('seal-failure');
  assert.equal(restored.task.state, 'needs_attention');
  assert.equal(restored.task.payloadPersistence, 'memory_only');
  assert.deepEqual(restored.payload, previousPayload);
});
test('corrupt records remain visible for attention and task IDs cannot escape the store', async t => {
  const store=new MediaTaskStore({userDataDir:await folder(t)}); await store.ready;
  await fs.writeFile(store.file('broken'),'{incomplete');
  assert.equal((await store.get('broken')).state,'needs_attention');
  await assert.rejects(store.get('../escape'),/Invalid media task ID/);
});
