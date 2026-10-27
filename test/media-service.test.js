'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const http = require('node:http');
const { MediaService, identifyMedia } = require('../src/main/media/media-service');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
// Container header suffices for the service's format sniffing; codec/decoding is
// deliberately outside these tests and can be injected through verifyMedia.
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const JPEG = Buffer.from([255,216,255,224,0,2,255,217]);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type':'application/json', ...headers } });
const data = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const ASSET = 'https://cdn.example/output?signature=private-output-signature';
function binding(protocol = 'openai-images', changes = {}) {
  const video = protocol.endsWith('video');
  return { routeId:'provider::media::binding', bindingId:'binding', providerId:'provider', providerName:'Test gateway',
    credentialRef:'credential-1', credentialVersion:'version-1', mediaRevision:1,
    protocol, modelId:'future-model-without-adapter', modality:video ? 'video' : 'image',
    baseUrl:'https://gateway.example', auth:{mode:'bearer'}, apiKey:'fixture-key-never-persist',
    capabilities:{operations:[video?'text_to_video':'text_to_image'], references:{max:0}, parameters:{}}, ...changes };
}
async function fixture(t, options = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(),'relay-media-service-'));
  const runtime = options.runtime || binding();
  const calls = [], events = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, ...init});
    return options.fetchImpl ? options.fetchImpl(url, init, calls) : json({data:[{b64_json:PNG.toString('base64')}]});
  };
  const defaults = { userDataDir, resolveRuntime:() => runtime, resolveCredential:() => runtime.apiKey,
    fetchImpl, pollIntervalMs:0, maxPollAttempts:3, onChanged:task => events.push(task) };
  const service = new MediaService({...defaults, ...options, fetchImpl});
  t.after(async () => {
    for (const id of service.running.keys()) await service.stop(id);
    await Promise.all(service.running.values());
    await fs.rm(userDataDir,{recursive:true,force:true});
  });
  return {service,userDataDir,calls,events,runtime,defaults};
}
function submitResponse(protocol) {
  if (protocol === 'openai-images') return {data:[{b64_json:PNG.toString('base64')}], usage:{total_tokens:23}};
  if (protocol === 'ark-images') return {data:[{url:ASSET}]};
  if (protocol === 'dashscope-images') return {output:{choices:[{message:{content:[{image:ASSET}]}}]}};
  if (protocol === 'dashscope-video') return {output:{task_id:'original-remote-job',task_status:'PENDING'}};
  return {id:'original-remote-job'};
}
function pollResponse(protocol) {
  if (protocol === 'dashscope-video') return {request_id:'query-request',output:{task_id:'original-remote-job',task_status:'SUCCEEDED',video_url:ASSET},usage:{video_duration:2}};
  return {id:'original-remote-job',model:'resolved-upstream-model',status:'succeeded',content:{video_url:ASSET},usage:{completion_tokens:42}};
}

for (const gateway of ['native','configured-proxy']) for (const protocol of ['openai-images','ark-images','dashscope-images','dashscope-video','ark-video']) {
  test(`${gateway}: ${protocol} runs an arbitrary model ID using its protocol and explicit routing`, async t => {
    const video = protocol.endsWith('video');
    const runtime = binding(protocol, gateway === 'configured-proxy' ? {
      baseUrl:'https://other-gateway.example/proxy', errorProfile:'mify',
      endpoints:video ? {submit:'/v1/videos/generations',poll:'/v1/videos/generations/{taskId}?model={modelId}'} : {generate:'/v1/images/generations'},
      routeHeaders:{'x-model-provider-id':'explicit-owner','x-dashscope-async':null},
      auth:{mode:'api-key',headerName:'X-Gateway-Key'}
    } : {});
    const f = await fixture(t,{runtime,fetchImpl:async(url,init)=> {
      if (url === ASSET) { assert.equal(init.headers,undefined); return new Response(video?MP4:PNG,{headers:{'content-type':'application/octet-stream'}}); }
      assert.equal(init.headers[runtime.auth.headerName || 'Authorization'],runtime.auth.mode==='bearer'?`Bearer ${runtime.apiKey}`:runtime.apiKey);
      if (init.method === 'POST') return json(submitResponse(protocol),200,{'x-request-id':'submit-request'});
      return json(pollResponse(protocol));
    }});
    const result = await f.service.generate({selection:runtime.routeId,prompt:'A geometric shape',runId:'run-1',conversationId:'conversation-1',turnIndex:0});
    assert.equal(result.ok,true); assert.equal(result.mediaKind,video?'video':'image');
    assert.equal(result.artifacts.length,1); assert.equal(result.artifacts[0].mime,video?'video/mp4':'image/png');
    assert.deepEqual(await fs.readFile(result.paths[0]),video?MP4:PNG);
    const task = await f.service.get('run-1');
    assert.equal(task.state,'completed'); assert.equal(task.snapshot.modelId,'future-model-without-adapter');
    const submit = f.calls.find(call=>call.method==='POST');
    assert.equal(JSON.parse(submit.body).model,runtime.modelId);
    if (gateway === 'configured-proxy') {
      assert.match(submit.url,/^https:\/\/other-gateway\.example\/proxy\/v1\//);
      assert.equal(submit.headers['x-model-provider-id'],'explicit-owner'); assert.equal(submit.headers['x-dashscope-async'],undefined);
      if (video) assert.match(f.calls.find(call=>call.method==='GET'&&call.url!==ASSET).url,/original-remote-job\?model=future-model-without-adapter$/);
    }
    if (video) {
      assert.equal(task.remoteHandle.taskId,'original-remote-job'); assert.equal(task.remoteHandle.modelId,runtime.modelId);
      assert.ok(f.events.some(event=>event.submissionOutcome==='accepted'&&event.remoteHandle?.taskId==='original-remote-job'));
    }
    if (protocol === 'ark-video') { assert.equal(task.remoteMetadata.resolvedModelId,'resolved-upstream-model'); assert.equal(task.remoteMetadata.usage.completion_tokens,42); }
    const raw = await fs.readFile(f.service.store.file('run-1'),'utf8');
    assert.ok(!raw.includes(runtime.apiKey)); assert.ok(!raw.includes('private-output-signature')); assert.ok(!raw.includes('A geometric shape'));
  });
}

test('invalid or unsupported parameters fail before network, and duplicate admission submits only once', async t => {
  const f = await fixture(t,{runtime:binding('openai-images',{capabilities:{operations:['text_to_image'],parameters:{n:{min:1,max:2}},references:{max:0}}})});
  assert.equal((await f.service.generate({prompt:'test',n:3})).code,'MEDIA_INPUT_INVALID');
  assert.equal((await f.service.generate({prompt:'test',duration:2})).code,'MEDIA_INPUT_INVALID');
  assert.equal(f.calls.length,0);
  await Promise.all([f.service.generate({prompt:'test',runId:'duplicate'}),f.service.generate({prompt:'test',runId:'duplicate'})]);
  assert.equal(f.calls.length,1);
});

test('admission validates expected media kind against the actual snapshot after its start queue wait', async t => {
  const f = await fixture(t, { runtime: binding('ark-video') });
  let release;
  f.service.startQueue = new Promise(resolve => { release = resolve; });
  const pending = f.service.generate({ prompt: 'fixture', runId: 'changed-kind', expectedMediaKind: 'video' });
  Object.assign(f.runtime, binding('openai-images'));
  release();
  const result = await pending;
  assert.equal(result.code, 'MEDIA_CONFIGURATION_CHANGED'); assert.equal(f.calls.length, 0);
  assert.equal(await f.service.get('changed-kind'), null, 'no durable submission is created for a mismatched pool');
  assert.equal((await f.service.generate({ prompt: 'fixture', runId: 'same-kind', expectedMediaKind: 'image' })).ok, true);
  assert.equal(JSON.parse(f.calls[0].body).expectedMediaKind, undefined, 'internal admission guard never goes to the provider');
});

test('restart queries the saved original handle and credential snapshot without resolving or submitting a new model', async t => {
  const f = await fixture(t,{runtime:binding('ark-video'),maxPollAttempts:1,fetchImpl:async(_url,init)=>json(init.method==='POST'?{id:'remote-123'}:{status:'running'})});
  const first = await f.service.generate({prompt:'test',runId:'original-run'});
  assert.equal(first.ok,false); assert.equal((await f.service.get(first.taskId)).error.code,'MEDIA_POLL_LIMIT');
  const restoredCalls = [], snapshots = [];
  const restored = new MediaService({...f.defaults, resolveRuntime:()=>{throw Error('new runtime must not be consulted');},
    resolveCredential:snapshot=>{snapshots.push(snapshot);return 'original-credential';},
    fetchImpl:async(url,init)=> {
      restoredCalls.push({url,...init});
      return url===ASSET?new Response(MP4):json({id:'remote-123',model:'resolved-latest',status:'succeeded',content:{video_url:ASSET}});
    }});
  await restored.attachRun(first.taskId,'continued-run');
  assert.equal(restoredCalls.length,0);
  await restored.resume(first.taskId); const completed = await restored.wait(first.taskId);
  assert.equal(completed.state,'completed'); assert.equal(completed.id,'original-run'); assert.equal(completed.runId,'continued-run');
  assert.equal(completed.remoteHandle.taskId,'remote-123'); assert.equal(completed.remoteHandle.modelId,f.runtime.modelId);
  assert.ok(restoredCalls.every(call=>call.method==='GET')); assert.equal(snapshots[0].credentialRef,'credential-1');
  assert.equal(snapshots[0].credentialVersion,'version-1'); assert.equal(snapshots[0].mediaRevision,1);
  assert.equal((await new MediaService(f.defaults).get('original-run')).runId,'continued-run');
  await assert.rejects(restored.attachRun(first.taskId,'../bad'),/ID/);
});

test('uncertain submission survives restart and cannot automatically charge twice', async t => {
  const f = await fixture(t,{fetchImpl:async()=>{throw Error('socket lost after send');}});
  const result = await f.service.generate({prompt:'test',runId:'uncertain'});
  assert.equal(result.code,'MEDIA_SUBMISSION_UNKNOWN'); assert.equal((await f.service.get('uncertain')).state,'submission_unknown');
  const fresh = new MediaService({...f.defaults,fetchImpl:()=>{throw Error('no further request allowed');}});
  await fresh.resume('uncertain');
  assert.equal((await fresh.get('uncertain')).state,'submission_unknown'); assert.equal(f.calls.length,1);
  assert.equal((await fresh.get('uncertain')).error.code,'MEDIA_RESUBMISSION_BLOCKED');
});

test('401 model permission failure is scoped to this task and a second binding can still run', async t => {
  const f = await fixture(t,{runtime:binding('openai-images',{errorProfile:'mify'}),fetchImpl:async(_url,_init,calls)=>calls.length===1
    ?json({error:{type:'invalid_key',message:'该模型不在 Key 的可用模型范围内'}},401)
    :json({data:[{b64_json:PNG.toString('base64')}]})});
  const failed=await f.service.generate({prompt:'test',runId:'denied'});
  assert.equal(failed.code,'model_permission_denied'); assert.equal((await f.service.get('denied')).error.category,'permission');
  assert.equal((await f.service.generate({prompt:'test',runId:'allowed'})).ok,true);
});

test('generic rejection shows concise Chinese text and persists safe HTTP diagnostics for later inspection', async t => {
  const f = await fixture(t, { runtime: binding('ark-video'), fetchImpl: async () => json({
    error: { code: 'InvalidParameter', message: 'Invalid request' },
    echoed_request: { prompt: 'private response payload', apiKey: 'do-not-copy-payload' },
  }, 400, { 'x-request-id': 'request-400-fixture' }) });
  const result = await f.service.generate({ prompt: 'private input prompt', runId: 'diagnostic-rejection' });
  assert.equal(result.ok, false);
  assert.equal(result.error, '服务商拒绝了请求，未返回具体原因\nHTTP 400 · 错误码 InvalidParameter · 请求 ID request-400-fixture');
  assert.equal(f.calls.length, 1, 'diagnostics must not add a second submission');
  const task = await f.service.get(result.taskId);
  assert.deepEqual(task.error, { code: 'invalid_request', category: 'validation', message: result.error,
    status: 400, providerCode: 'InvalidParameter', requestId: 'request-400-fixture' });
  assert.equal(task.remoteMetadata.requestId, 'request-400-fixture');
  const restored = await new MediaService(f.defaults).get(result.taskId);
  assert.deepEqual(restored.error, task.error);
  const disk = await fs.readFile(f.service.store.file(result.taskId), 'utf8');
  for (const secret of [f.runtime.apiKey, 'private input prompt', 'private response payload', 'do-not-copy-payload']) assert.equal(disk.includes(secret), false);
});

test('specific remote failures keep their explanation and the polling request diagnostic identity', async t => {
  const f = await fixture(t, { runtime: binding('ark-video'), fetchImpl: async (_url, init) => init.method === 'POST'
    ? json({ id: 'failed-remote-task' }, 200, { 'x-request-id': 'submit-accepted' })
    : json({ status: 'failed', request_id: 'poll-failure', error: { code: 'InvalidParameter.Duration', message: 'duration must be between 4 and 30 seconds' } }) });
  const result = await f.service.generate({ prompt: 'Cube', runId: 'specific-diagnostic' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'duration must be between 4 and 30 seconds\nHTTP 200 · 错误码 InvalidParameter.Duration · 请求 ID poll-failure');
  const task = await f.service.get(result.taskId);
  assert.equal(task.error.requestId, 'poll-failure'); assert.equal(task.error.providerCode, 'InvalidParameter.Duration');
  assert.equal(task.remoteMetadata.requestId, 'poll-failure');
  assert.equal(task.remoteHandle.taskId, 'failed-remote-task');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('upstream credentials cannot escape through diagnostic fields or persisted error metadata', async t => {
  const runtime = binding('ark-video');
  const f = await fixture(t, { runtime, fetchImpl: async () => json({ request_id: runtime.apiKey,
    error: { code: runtime.apiKey, message: `Rejected credential ${runtime.apiKey}` },
  }, 403) });
  const result = await f.service.generate({ prompt: 'Cube', runId: 'redacted-diagnostics' });
  const task = await f.service.get(result.taskId);
  assert.equal(task.error.status, 403);
  assert.equal(task.error.providerCode, undefined); assert.equal(task.error.requestId, undefined);
  assert.equal(JSON.stringify(task).includes(runtime.apiKey), false); assert.equal(result.error.includes(runtime.apiKey), false);
  assert.equal((await fs.readFile(f.service.store.file(result.taskId), 'utf8')).includes(runtime.apiKey), false);
  const internal = f.service._error({ code: 'fixture', message: 'local failure', status: 0,
    providerCode: 'https://fixture.invalid/?key=sensitive', requestId: 'line\nbreak' });
  assert.deepEqual(internal, { code: 'fixture', message: 'local failure' });
});

test('uncertain HTTP submission retains diagnostics without retrying or declaring it rejected', async t => {
  const f = await fixture(t, { runtime: binding('ark-video'), fetchImpl: async () => json({
    error: { code: 'GatewayTimeout', message: 'upstream acknowledgement unavailable' },
  }, 504, { 'x-request-id': 'timeout-fixture' }) });
  const result = await f.service.generate({ prompt: 'Cube', runId: 'uncertain-diagnostics' });
  const task = await f.service.get(result.taskId);
  assert.equal(task.state, 'submission_unknown'); assert.equal(task.submissionOutcome, 'submission_unknown');
  assert.equal(task.error.status, 504); assert.equal(task.error.providerCode, 'GatewayTimeout'); assert.equal(task.error.requestId, 'timeout-fixture');
  assert.equal(f.calls.length, 1);
  assert.match(result.error, /^upstream acknowledgement unavailable\nHTTP 504/);
});

test('credential changes block recovery and never substitute the current provider key', async t => {
  const f = await fixture(t,{runtime:binding('dashscope-video'),maxPollAttempts:1,fetchImpl:async(_url,init)=>json(init.method==='POST'?{output:{task_id:'remote',task_status:'PENDING'}}:{output:{task_status:'RUNNING'}})});
  await f.service.generate({prompt:'test',runId:'credential-change'});
  let requests=0;
  const fresh=new MediaService({...f.defaults,resolveCredential:snapshot=>{assert.equal(snapshot.credentialVersion,'version-1');throw Error('version changed');},fetchImpl:async()=>{requests++;throw Error('unexpected');}});
  await fresh.resume('credential-change');const task=await fresh.wait('credential-change');
  assert.equal(task.state,'needs_attention');assert.equal(task.error.code,'MEDIA_CREDENTIAL_CHANGED');assert.equal(requests,0);
});

test('anonymous routes validate their saved binding before recovery without sending authorization', async t => {
  let checks = 0;
  const f = await fixture(t, { runtime: binding('ark-video', { auth: { mode: 'none' }, apiKey: '' }), maxPollAttempts: 1,
    resolveCredential(snapshot) { checks++; assert.equal(snapshot.auth.mode, 'none'); return ''; },
    fetchImpl: async (_url, init) => json(init.method === 'POST' ? { id: 'anonymous-job' } : { status: 'running' }) });
  await f.service.generate({ prompt: 'test', runId: 'anonymous-saved' });
  assert.equal(checks, 2);
  assert.ok(f.calls.every(call => !Object.keys(call.headers).some(name => /authorization|api-key/i.test(name))));
  let requests = 0;
  const fresh = new MediaService({ ...f.defaults,
    resolveCredential() { throw Error('anonymous binding removed'); },
    fetchImpl: async () => { requests++; throw Error('unexpected request'); } });
  await fresh.resume('anonymous-saved');
  const task = await fresh.wait('anonymous-saved');
  assert.equal(task.state, 'needs_attention');
  assert.equal(task.error.code, 'MEDIA_CREDENTIAL_CHANGED');
  assert.equal(requests, 0);
});

test('opaque gateway task IDs survive persistence and are encoded only when polling', async t => {
  const opaqueId = 'id/a?b#c=任务';
  const f = await fixture(t, { runtime: binding('ark-video'), maxPollAttempts: 1,
    fetchImpl: async (_url, init) => json(init.method === 'POST' ? { id: opaqueId } : { status: 'running' }) });
  await f.service.generate({ prompt: 'test', runId: 'opaque-task' });
  assert.equal((await f.service.get('opaque-task')).remoteHandle.taskId, opaqueId);
  assert.ok(f.calls[1].url.endsWith('/' + encodeURIComponent(opaqueId)));
  const queries = [];
  const fresh = new MediaService({ ...f.defaults, fetchImpl: async (url, init) => {
    queries.push({ url, method: init.method });
    return url === ASSET ? new Response(MP4) : json({ id: opaqueId, status: 'succeeded', content: { video_url: ASSET } });
  } });
  await fresh.resume('opaque-task');
  assert.equal((await fresh.wait('opaque-task')).state, 'completed');
  assert.equal(queries[0].url, f.calls[1].url);
  assert.ok(queries.every(call => call.method === 'GET'));
  for (const invalid of ['', ' ', 'id\nvalue', 'x'.repeat(513)]) {
    assert.throws(() => f.service._handle({ taskId: invalid }, f.runtime), /有效任务 ID/);
  }
});

test('parallel bindings at one gateway keep their credentials and routing independent', async t => {
  const runtimes={a:binding('ark-video',{routeId:'a::media::video',providerId:'a',credentialRef:'a-key',apiKey:'team-a-key',modelId:'model-a'}),
    b:binding('ark-video',{routeId:'b::media::video',providerId:'b',credentialRef:'b-key',apiKey:'team-b-key',modelId:'model-b'})};
  const f=await fixture(t,{resolveRuntime:selection=>runtimes[selection],resolveCredential:snapshot=>runtimes[snapshot.providerId].apiKey,
    fetchImpl:async(url,init)=> {
      if(url===ASSET)return new Response(MP4);
      if(init.method==='POST'){
        const model=JSON.parse(init.body).model; const id=model.slice(-1);
        assert.equal(init.headers.Authorization,`Bearer ${runtimes[id].apiKey}`);return json({id:`job-${id}`});
      }
      const id=url.slice(-1);assert.equal(init.headers.Authorization,`Bearer ${runtimes[id].apiKey}`);
      return json({id:`job-${id}`,status:'succeeded',content:{video_url:ASSET}});
    }});
  const results=await Promise.all(['a','b'].map(selection=>f.service.generate({selection,prompt:'test',runId:`run-${selection}`})));
  assert.ok(results.every(result=>result.ok));
  for(const id of ['a','b'])assert.equal((await f.service.get(`run-${id}`)).snapshot.credentialRef,`${id}-key`);
});

test('JSON input size is bounded before a potentially billable submission', async t => {
  const f=await fixture(t,{maxInputBytes:100});
  const result=await f.service.generate({prompt:'x'.repeat(150),runId:'large-input'});
  assert.equal(result.code,'MEDIA_INPUT_TOO_LARGE');assert.equal(f.calls.length,0);
  assert.equal((await f.service.get('large-input')).submissionOutcome,'not_sent');
});

test('partial download recovery downloads only the missing output and never regenerates', async t => {
  let allowSecond=false;
  const f=await fixture(t,{fetchImpl:async(url,init)=> {
    if(init.method==='POST')return json({data:[{url:'https://cdn.example/one'},{url:'https://cdn.example/two'}]});
    if(url.endsWith('/two')&&!allowSecond)return new Response('temporary failure',{status:503});
    return new Response(PNG);
  }});
  const result=await f.service.generate({prompt:'test',runId:'partial'});
  assert.equal(result.ok,false);assert.equal(result.paths.length,1);assert.equal((await f.service.get('partial')).remoteState,'succeeded');
  allowSecond=true;await f.service.retryDownload('partial');const final=await f.service.wait('partial');
  assert.equal(final.state,'completed');assert.equal(final.artifacts.length,2);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/one')).length,1);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/two')).length,2);
});

test('lost unencrypted synchronous download references require attention without resubmission', async t => {
  const f=await fixture(t,{fetchImpl:async(_url,init)=>init.method==='POST'?json({data:[{url:ASSET}]}):new Response('failure',{status:503})});
  await f.service.generate({prompt:'private text',runId:'lost-reference'});
  const fresh=new MediaService({...f.defaults,fetchImpl:()=>{throw Error('no network allowed');}});
  await fresh.retryDownload('lost-reference');const final=await fresh.wait('lost-reference');
  assert.equal(final.error.code,'MEDIA_OUTPUT_REFERENCE_UNAVAILABLE');assert.equal(final.state,'needs_attention');
});

test('stop is local only, preserves the remote task, and explicit resume only polls it', async t => {
  let notify;const enteredPoll=new Promise(resolve=>{notify=resolve;});
  let first=true;
  const f=await fixture(t,{runtime:binding('ark-video'),fetchImpl:async(url,init)=> {
    if(init.method==='POST')return json({id:'remote-stopped'});
    if(url===ASSET)return new Response(MP4);
    if(first){first=false;notify();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));}
    return json({id:'remote-stopped',status:'succeeded',content:{video_url:ASSET}});
  }});
  await f.service.start({prompt:'test',runId:'local-stop'});await enteredPoll;await f.service.stop('local-stop');
  const stopped=await f.service.wait('local-stop');assert.equal(stopped.state,'stopped');assert.equal(stopped.remoteHandle.taskId,'remote-stopped');
  assert.ok(f.calls.every(call=>['GET','POST'].includes(call.method)));
  await f.service.resume('local-stop');assert.equal((await f.service.wait('local-stop')).state,'completed');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('stop from the initial queued notification prevents submission before a worker is registered', async t => {
  let stopping;
  const f = await fixture(t, { onChanged: task => {
    // Observers do not wait on actions that can publish another notification.
    if (task.state === 'queued') stopping = f.service.stop(task.id);
  } });
  const result = await f.service.generate({ prompt: 'A blue cube', runId: 'stop-before-launch' });
  await stopping;
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  const stopped = await f.service.get(result.taskId);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.submissionOutcome, 'not_sent');
  assert.equal(f.service.running.has(stopped.id), false);
  assert.equal(f.service.controllers.has(stopped.id), false);
  assert.equal(f.calls.length, 0);
});

test('actual HTTP stop waits for delayed abort cleanup before immediate resume of the same remote task', { timeout: 10000 }, async t => {
  const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const enteredPoll = latch(), aborted = latch(), releaseAbort = latch(), stoppedSaved = latch();
  const requests = [];
  let origin, polls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the real request before responding. */ }
    requests.push({ method: req.method, url: req.url });
    if (req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'delayed-remote-task' }));
    } else if (req.url === '/asset') {
      res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(MP4);
    } else if (++polls === 1) {
      enteredPoll.resolve(); // Keep the actual HTTP response open until the caller aborts.
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'delayed-remote-task', status: 'succeeded', content: { video_url: origin + '/asset' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  origin = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture(t, { runtime: binding('ark-video', { baseUrl: origin }), allowHttpDownloads: true,
    onChanged: task => { if (task.state === 'stopped') stoppedSaved.resolve(); },
    fetchImpl: async (url, init) => {
      try { return await fetch(url, init); }
      catch (error) {
        if (init.signal.aborted) { aborted.resolve(); await releaseAbort.promise; }
        throw error;
      }
    },
  });
  // History recovery has no pending renderer generate promise to serialize actions.
  await f.service.start({ prompt: 'A blue cube', runId: 'delayed-local-stop' });
  await enteredPoll.promise;
  let stopReturned = false;
  const stopping = f.service.stop('delayed-local-stop').then(task => { stopReturned = true; return task; });
  try {
    await Promise.all([aborted.promise, stoppedSaved.promise]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.running.has('delayed-local-stop'), true);
    assert.equal(stopReturned, false, 'stop must not return while the aborted worker is still unwinding');
  } finally { releaseAbort.resolve(); }
  const stopped = await stopping;
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.remoteHandle.taskId, 'delayed-remote-task');
  assert.equal(f.service.running.has(stopped.id), false);
  assert.equal(f.service.controllers.has(stopped.id), false);
  await f.service.resume(stopped.id);
  const completed = await f.service.wait(stopped.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.remoteHandle.taskId, 'delayed-remote-task');
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  const remoteQueries = requests.filter(request => request.method === 'GET' && request.url !== '/asset');
  assert.equal(remoteQueries.length, 2);
  assert.equal(remoteQueries[0].url, remoteQueries[1].url);
  assert.match(remoteQueries[1].url, /delayed-remote-task$/);
  assert.ok(requests.every(request => ['GET', 'POST'].includes(request.method)));
});

test('app shutdown preserves accepted tasks for automatic restart polling instead of marking them stopped', async t => {
  const lease=new AbortController();let quitting=false,notify;
  const enteredPoll=new Promise(resolve=>{notify=resolve;});
  const f=await fixture(t,{runtime:binding('ark-video'),isShuttingDown:()=>quitting,fetchImpl:async(_url,init)=> {
    if(init.method==='POST')return json({id:'shutdown-job'});
    notify();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
  }});
  await f.service.start({prompt:'test',runId:'shutdown',signal:lease.signal});await enteredPoll;
  quitting=true;lease.abort();const suspended=await f.service.wait('shutdown');
  assert.equal(suspended.state,'accepted');assert.equal(suspended.cancelIntent,false);assert.equal(suspended.remoteHandle.taskId,'shutdown-job');
  const requests=[];
  const fresh=new MediaService({...f.defaults,fetchImpl:async(url,init)=>{
    requests.push({url,...init});return url===ASSET?new Response(MP4):json({id:'shutdown-job',status:'succeeded',content:{video_url:ASSET}});
  }});
  await fresh.resume();assert.equal((await fresh.wait('shutdown')).state,'completed');assert.ok(requests.every(call=>call.method==='GET'));
});

test('shutdown during submission retains uncertainty and restart does not submit again', async t => {
  const lease=new AbortController();let quitting=false,notify;
  const enteredSubmit=new Promise(resolve=>{notify=resolve;});
  const f=await fixture(t,{isShuttingDown:()=>quitting,fetchImpl:async(_url,init)=> {
    notify();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
  }});
  await f.service.start({prompt:'test',runId:'shutdown-unknown',signal:lease.signal});await enteredSubmit;
  quitting=true;lease.abort();const suspended=await f.service.wait('shutdown-unknown');
  assert.equal(suspended.state,'submission_unknown');assert.equal(suspended.cancelIntent,false);
  const fresh=new MediaService({...f.defaults,fetchImpl:()=>{throw Error('no request permitted');}});
  await fresh.resume();assert.equal((await fresh.get('shutdown-unknown')).state,'submission_unknown');assert.equal(f.calls.length,1);
});

test('multipart edit carries every reference with detected MIME and no preset content-type boundary', async t => {
  const runtime=binding('openai-images',{editTransport:'multipart',capabilities:{operations:['image_to_image'],references:{max:3},parameters:{}}});
  const f=await fixture(t,{runtime,fetchImpl:async(_url,init)=>{
    assert.ok(init.body instanceof FormData);const files=init.body.getAll('image[]');assert.equal(files.length,2);
    assert.equal(files[0].type,'image/png');assert.equal(files[1].type,'image/jpeg');
    assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),PNG);assert.deepEqual(Buffer.from(await files[1].arrayBuffer()),JPEG);
    assert.ok(!Object.keys(init.headers).some(name=>name.toLowerCase()==='content-type'));
    return json({data:[{b64_json:PNG.toString('base64')}]});
  }});
  const result=await f.service.generate({prompt:'combine',references:[data(PNG),data(JPEG)],runId:'edit'});
  assert.equal(result.ok,true);assert.match(f.calls[0].url,/\/v1\/images\/edits$/);
  assert.equal((await f.service.get('edit')).snapshot.editTransport,'multipart');
});

test('output format follows bytes; HTML and wrong media kind never become successful artifacts', async t => {
  const f=await fixture(t,{fetchImpl:async(_url,_init,calls)=>json({data:[{b64_json:(calls.length===1?JPEG:MP4).toString('base64')}],output_format:'png'})});
  const first=await f.service.generate({prompt:'test',runId:'jpeg'});assert.equal(first.ok,true);assert.match(first.paths[0],/\.jpg$/);assert.equal(first.artifacts[0].mime,'image/jpeg');
  const second=await f.service.generate({prompt:'test',runId:'wrong-kind'});assert.equal(second.ok,false);assert.equal(second.code,'MEDIA_KIND_MISMATCH');assert.deepEqual(second.paths,[]);
  assert.throws(()=>identifyMedia(Buffer.from('<html>error</html>')),/不是支持/);
});

test('actual HTTP download redirects omit gateway credentials and enforce response size limits', async t => {
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    if(req.url==='/redirect'){res.writeHead(302,{location:'/image'});res.end();}
    else if(req.url==='/large'){res.writeHead(200,{'content-length':10000});res.end(Buffer.alloc(10000));}
    else{res.writeHead(200,{'content-type':'image/jpeg'});res.end(PNG);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let large=false;
  const f=await fixture(t,{allowHttpDownloads:true,maxDownloadBytes:100,fetchImpl:(url,init)=>init.method==='POST'?Promise.resolve(json({data:[{url:origin+(large?'/large':'/redirect')}]})):fetch(url,init)});
  assert.equal((await f.service.generate({prompt:'test',runId:'http-download'})).ok,true);
  assert.equal(requests.length,2);assert.ok(requests.every(req=>!req.headers.authorization&&!req.headers['x-api-key']&&!req.headers.cookie));
  large=true;assert.equal((await f.service.generate({prompt:'test',runId:'too-large'})).code,'MEDIA_RESPONSE_TOO_LARGE');
});

async function requestServer(t, protocol) {
  const requests = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
    if (req.url === '/asset') {
      res.writeHead(200, { 'content-type': protocol.endsWith('video') ? 'video/mp4' : 'image/png' });
      res.end(protocol.endsWith('video') ? MP4 : PNG);
      return;
    }
    const payload = req.method === 'POST' ? submitResponse(protocol) : pollResponse(protocol);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload).replaceAll(ASSET, origin + '/asset'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, origin };
}

for (const protocol of ['openai-images', 'ark-images', 'dashscope-images', 'dashscope-video', 'ark-video']) {
  test(`actual HTTP ${protocol} submission has one JSON Content-Type without comma-joined duplicates`, async t => {
    const server = await requestServer(t, protocol);
    const runtime = binding(protocol, { baseUrl: server.origin });
    const f = await fixture(t, { runtime, allowHttpDownloads: true, fetchImpl: (url, init) => fetch(url, init) });
    const result = await f.service.generate({ prompt: 'A blue cube', runId: 'http-content-type' });
    assert.equal(result.ok, true);
    const submit = server.requests.find(request => request.method === 'POST');
    assert.equal(submit.headers['content-type'], 'application/json');
    assert.equal(submit.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-type').length, 1);
    assert.equal(JSON.parse(submit.body).model, runtime.modelId);
    assert.equal(server.requests.filter(request => request.method === 'POST').length, 1);
  });
}

test('actual HTTP JSON requests preserve caller Content-Type regardless of header casing and add it only when absent', async t => {
  const server = await requestServer(t, 'openai-images');
  const runtime = binding('openai-images', { baseUrl: server.origin });
  const codecs = require('../src/main/media/media-protocols');
  const cases = [
    { name: 'content-type', value: 'application/json; charset=utf-8' },
    { name: 'cOnTeNt-TyPe', value: 'application/vnd.fixture+json' },
    { name: null, value: 'application/json' },
  ];
  for (const [index, header] of cases.entries()) {
    const protocols = { ...codecs, encodeSubmit(snapshot, input) {
      const descriptor = codecs.encodeSubmit(snapshot, input);
      for (const name of Object.keys(descriptor.headers)) if (name.toLowerCase() === 'content-type') delete descriptor.headers[name];
      if (header.name) descriptor.headers[header.name] = header.value;
      return descriptor;
    } };
    const f = await fixture(t, { runtime, protocols, fetchImpl: (url, init) => fetch(url, init) });
    assert.equal((await f.service.generate({ prompt: 'A cube', runId: `caller-content-type-${index}` })).ok, true);
    const received = server.requests[index];
    assert.equal(received.headers['content-type'], header.value);
    assert.equal(received.rawHeaders.filter((value, offset) => offset % 2 === 0 && value.toLowerCase() === 'content-type').length, 1);
  }
});

test('actual HTTP multipart edits retain a Fetch-generated boundary matching the uploaded body', async t => {
  const server = await requestServer(t, 'openai-images');
  const runtime = binding('openai-images', { baseUrl: server.origin, editTransport: 'multipart',
    routeHeaders: { 'Content-Type': 'application/json' },
    capabilities: { operations: ['image_to_image'], references: { max: 2 }, parameters: {} } });
  const f = await fixture(t, { runtime, fetchImpl: (url, init) => fetch(url, init) });
  const result = await f.service.generate({ prompt: 'Combine these shapes', references: [data(PNG), data(JPEG)], runId: 'http-multipart' });
  assert.equal(result.ok, true);
  const received = server.requests[0];
  const contentType = received.headers['content-type'];
  assert.match(contentType, /^multipart\/form-data; boundary=[^,;]+$/);
  const boundary = contentType.slice(contentType.indexOf('boundary=') + 9);
  const body = received.body.toString('latin1');
  assert.ok(body.startsWith(`--${boundary}\r\n`));
  assert.match(body, /name="model"/);
  assert.equal((body.match(/name="image\[\]"/g) || []).length, 2);
  assert.ok(body.endsWith(`--${boundary}--\r\n`) || body.endsWith(`--${boundary}--`));
  assert.equal(received.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-type').length, 1);
});
