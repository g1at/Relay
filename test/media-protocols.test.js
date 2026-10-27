'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeSubmit, encodePoll, parseSubmit, parsePoll, validateInput, getProtocolDefinitions, MediaValidationError } = require('../src/main/media/media-protocols');

const png = 'data:image/png;base64,aGVsbG8=';
function binding(protocol, overrides = {}) {
  return { protocol, modelId: 'unlisted-future-model', baseUrl: 'https://gateway.example/proxy', auth: { mode: 'bearer' }, routeHeaders: {}, endpoints: {}, capabilities: { operations: [protocol.endsWith('video') ? 'text_to_video' : 'text_to_image'], defaults: {}, parameters: {}, references: { max: 0 } }, ...overrides };
}
function withParams(protocol, parameters, defaults = {}) {
  return binding(protocol, { capabilities: { operations: [protocol.endsWith('video') ? 'text_to_video' : 'text_to_image'], parameters, defaults } });
}
const response = (body, status = 200) => ({ status, body, headers: {} });

test('five protocol definitions are detached data and do not contain model allowlists', () => {
  const defs = getProtocolDefinitions();
  assert.equal(defs.length, 5);
  defs[0].endpoints.generate = '/changed';
  assert.equal(getProtocolDefinitions()[0].endpoints.generate, '/v1/images/generations');
  for (const def of defs) assert.equal(encodeSubmit(binding(def.id), { prompt: 'A blue cube' }).body.model, 'unlisted-future-model');
});

test('endpoint and route header overrides are explicit, independent of hostname and model prefix', () => {
  const b = withParams('openai-images', { n: { min: 1, max: 1 }, size: {} }, { n: 1, size: '1024x1024' });
  b.baseUrl = 'https://gateway.example/v1';
  b.modelId = 'azure_openai/custom-model';
  const request = encodeSubmit(b, { prompt: 'Cube' });
  assert.equal(request.url, 'https://gateway.example/v1/images/generations');
  assert.equal(request.body.model, 'azure_openai/custom-model');
  assert.equal(request.headers['x-model-provider-id'], undefined);
  assert.equal(request.headers.authorization, undefined);
  const routed = encodeSubmit({ ...b, modelId: 'custom-model', routeHeaders: { 'X-Model-Provider-Id': 'azure_openai' }, endpoints: { generate: '/alternate/images?version=2' } }, { prompt: 'Cube' });
  assert.equal(routed.headers['x-model-provider-id'], 'azure_openai');
  assert.equal(routed.url, 'https://gateway.example/v1/alternate/images?version=2');
});

test('native Ark endpoint joins an existing api/v3 base once', () => {
  const b = binding('ark-images', { baseUrl: 'https://ark.example/api/v3' });
  assert.equal(encodeSubmit(b, { prompt: 'Cube' }).url, 'https://ark.example/api/v3/images/generations');
});

test('native DashScope async header can be removed for an explicit gateway binding', () => {
  const native = encodeSubmit(binding('dashscope-video'), { prompt: 'Cube' });
  assert.equal(native.headers['x-dashscope-async'], 'enable');
  const mify = encodeSubmit(binding('dashscope-video', { endpoints: { submit: '/v1/videos/generations' }, routeHeaders: { 'x-dashscope-async': null, 'x-model-provider-id': 'tongyi' } }), { prompt: 'Cube' });
  assert.equal(mify.headers['x-dashscope-async'], undefined);
  assert.equal(mify.headers['x-model-provider-id'], 'tongyi');
});

test('codec rejects route credentials and cross-origin endpoint injection', () => {
  assert.throws(() => encodeSubmit(binding('openai-images', { routeHeaders: { Authorization: 'redacted' } }), { prompt: 'Cube' }), /凭据/);
  assert.throws(() => encodeSubmit(binding('openai-images', { endpoints: { generate: 'https://other.example/images' } }), { prompt: 'Cube' }), /同源/);
});

test('Qwen native nested messages and asterisk size use all references', () => {
  const b = binding('dashscope-images', { capabilities: { operations: ['image_to_image'], parameters: { size: { minPixels: 262144, maxPixels: 4194304 }, n: { min: 1, max: 6 }, promptExtend: {} }, defaults: { n: 1, promptExtend: false }, references: { max: 3 } } });
  const request = encodeSubmit(b, { prompt: 'Fuse these', references: [png, 'https://assets.example/two.png'], size: '512x512' });
  assert.deepEqual(request.body.input.messages[0].content, [{ image: png }, { image: 'https://assets.example/two.png' }, { text: 'Fuse these' }]);
  assert.deepEqual(request.body.parameters, { n: 1, size: '512*512', prompt_extend: false });
});

test('Ark groups map to max_images without sending unsupported n', () => {
  const b = binding('ark-images', { capabilities: { operations: ['image_to_image'], parameters: { n: { min: 1, max: 15 }, sequential: {}, watermark: {} }, defaults: { sequential: true, watermark: false }, references: { max: 14, maxTotalWithOutputs: 15 } } });
  const req = encodeSubmit(b, { prompt: 'Variations', references: [png, png], n: 3 });
  assert.deepEqual(req.body.image, [png, png]);
  assert.equal(req.body.n, undefined);
  assert.equal(req.body.sequential_image_generation, 'auto');
  assert.deepEqual(req.body.sequential_image_generation_options, { max_images: 3 });
  assert.equal(validateInput(b, { prompt: 'Variants', references: Array(14).fill(png), n: 2 }).ok, false);
  assert.equal(validateInput(b, { prompt: 'Variants', references: [png], sequential: false, n: 2 }).ok, false);
});

test('OpenAI edit JSON and multipart preserve multiple references; legacy transport rejects truncation', () => {
  const b = binding('openai-images', { capabilities: { operations: ['image_to_image'], parameters: {}, references: { max: 16 } } });
  const input = { prompt: 'Combine', references: [png, 'https://assets.example/two.png'] };
  const multi = encodeSubmit(b, input);
  assert.equal(multi.bodyEncoding, 'multipart');
  assert.equal(multi.headers['content-type'], undefined);
  assert.equal(multi.body.files.length, 2);
  assert.deepEqual(multi.body.files.map(item => item.field), ['image[]', 'image[]']);
  const json = encodeSubmit({ ...b, capabilities: { ...b.capabilities, editTransport: 'json-images' } }, input);
  assert.deepEqual(json.body.images, input.references.map(image_url => ({ image_url })));
  const urls = encodeSubmit({ ...b, editTransport: 'json-image-urls' }, input);
  assert.equal(urls.bodyEncoding, 'json');
  assert.deepEqual(urls.body.image_urls, input.references);
  assert.equal(urls.body.images, undefined);
  const legacy = { ...b, capabilities: { ...b.capabilities, editTransport: 'legacy-json-image-url' } };
  assert.throws(() => encodeSubmit(legacy, input), MediaValidationError);
  assert.equal(encodeSubmit(legacy, { ...input, references: [png] }).body.image_url, png);
});

test('Wan image-to-video uses input.media and Ark uses content with native parameter names', () => {
  const caps = { operations: ['image_to_video'], defaults: { duration: 2, resolution: '720P', promptExtend: false }, parameters: { duration: { min: 2, max: 15 }, resolution: { enum: ['720P', '1080P'] }, promptExtend: {} }, references: { max: 1, roles: ['first_frame'], dataUrl: true } };
  const wan = encodeSubmit(binding('dashscope-video', { capabilities: caps }), { references: [png] });
  assert.deepEqual(wan.body.input.media, [{ type: 'first_frame', url: png }]);
  assert.equal(wan.body.parameters.duration, 2);
  assert.equal(wan.body.parameters.n, undefined);
  assert.equal(validateInput(binding('dashscope-video', { capabilities: caps }), { references: [png], resolution: '480P' }).ok, false);
  assert.equal(validateInput(binding('dashscope-video', { capabilities: caps }), { references: [png], audio: false }).ok, false);
  const ark = encodeSubmit(binding('ark-video', { capabilities: { operations: ['text_to_video'], defaults: { duration: 4, resolution: '480p', audio: false }, parameters: { duration: { min: 4, max: 30 }, resolution: { enum: ['480p', '720p'] }, audio: {} } } }), { prompt: 'Cube' });
  assert.deepEqual(ark.body.content, [{ type: 'text', text: 'Cube' }]);
  assert.equal(ark.body.generate_audio, false);
  assert.equal(ark.body.audio, undefined);
});

test('validation rejects unknown fields, undeclared defaults, bounds, booleans and absent reference capabilities', () => {
  const b = withParams('openai-images', { n: { min: 1, max: 2 }, size: { minPixels: 262144, maxPixels: 4194304, multipleOf: 16 } });
  for (const extra of [{ n: 3 }, { n: '1' }, { size: '300x300' }, { quality: 'low' }, { imaginary: true }, { references: [png] }, { operation: 3 }]) assert.equal(validateInput(b, { prompt: 'Cube', ...extra }).ok, false);
  assert.equal(validateInput({ ...b, capabilities: { ...b.capabilities, defaults: { quality: 'low' } } }, { prompt: 'Cube' }).ok, false);
  assert.equal(validateInput(b, { prompt: 'Cube', size: '512x512', n: 1 }).ok, true);
  assert.equal(validateInput(withParams('ark-images', { watermark: {} }), { prompt: 'Cube', watermark: 'false' }).ok, false);
});

test('reference roles and counts do not disappear silently', () => {
  const b = binding('ark-video', { capabilities: { operations: ['image_to_video'], references: { max: 2, roles: ['first_frame', 'last_frame'] } } });
  assert.equal(validateInput(b, { references: [png, png] }).ok, false);
  const req = encodeSubmit(b, { references: [{ url: png, role: 'first_frame' }, { url: png, role: 'last_frame' }] });
  assert.deepEqual(req.body.content.map(item => item.role), ['first_frame', 'last_frame']);
  assert.equal(validateInput(b, { references: [{ url: png, role: 'imaginary' }] }).ok, false);
  assert.equal(validateInput(b, { references: [png], image: png }).ok, false);
});

test('image response codecs parse independent response envelopes and retain actual output format', () => {
  const openai = parseSubmit(binding('openai-images'), response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }], output_format: 'jpeg', usage: { total_tokens: 1 } })));
  assert.equal(openai.kind, 'completed');
  assert.deepEqual(openai.outputs, [{ kind: 'base64', value: 'aGVsbG8=', mime: 'image/jpeg' }]);
  const ark = parseSubmit(binding('ark-images'), response({ model: 'native-resolved-model', data: [{ url: 'https://asset.example/result.jpg' }] }));
  assert.equal(ark.resolvedModelId, 'native-resolved-model');
  assert.equal(ark.outputs[0].kind, 'url');
  const dashscope = parseSubmit(binding('dashscope-images'), response({ output: { choices: [{ message: { content: [{ text: 'ignored explanation' }, { image: 'https://asset.example/a.png' }, { image: 'https://asset.example/b.png' }] } }] } }));
  assert.equal(dashscope.outputs.length, 2);
});

test('two video response codecs at one gateway retain original alias for polling', () => {
  const endpoints = { submit: '/v1/videos/generations', poll: '/v1/videos/generations/{taskId}?model={modelId}' };
  const wan = binding('dashscope-video', { endpoints, modelId: 'wan3.0-video' });
  const submitted = parseSubmit(wan, response({ output: { task_id: 'id/a?b', task_status: 'PENDING' } }, 202));
  assert.equal(submitted.kind, 'accepted');
  assert.equal(submitted.state, 'queued');
  assert.deepEqual(submitted.handle, { taskId: 'id/a?b', modelId: 'wan3.0-video' });
  const poll = encodePoll({ ...wan, modelId: 'new-config-model' }, submitted.handle);
  assert.equal(poll.url, 'https://gateway.example/proxy/v1/videos/generations/id%2Fa%3Fb?model=wan3.0-video');
  const done = parsePoll(wan, response({ output: { task_status: 'SUCCEEDED', video_url: 'https://asset.example/wan.mp4' }, usage: { duration: 2, SR: 480 } }));
  assert.equal(done.state, 'succeeded');
  assert.equal(done.usage.SR, 480);
  const ark = binding('ark-video', { endpoints, modelId: 'doubao-seedance-2.5' });
  const accepted = parseSubmit(ark, response({ id: 'cgt-1' }));
  assert.equal(accepted.kind, 'accepted');
  assert.deepEqual(accepted.handle, { taskId: 'cgt-1', modelId: 'doubao-seedance-2.5' });
  const arkDone = parsePoll(ark, response({ id: 'cgt-1', model: 'doubao-seedance-2-5-260628', status: 'succeeded', content: { video_url: 'https://asset.example/ark.mp4' } }));
  assert.equal(arkDone.resolvedModelId, 'doubao-seedance-2-5-260628');
  assert.equal(arkDone.outputs[0].value, 'https://asset.example/ark.mp4');
  assert.match(encodePoll(ark, accepted.handle).url, /model=doubao-seedance-2.5$/);
});

test('Mify 401 routing and per-model permissions are not invalid credentials; generic bindings do not use Mify classification', () => {
  const b = binding('openai-images', { errorProfile: 'mify' });
  const missing = response({ error: { message: '该模型未指定供应商', param: 'Please provide valid API Key', code: '401', type: 'invalid_key' } }, 401);
  assert.equal(parseSubmit(b, missing).error.code, 'provider_required');
  assert.equal(parseSubmit(binding('openai-images'), missing).error.code, 'unauthorized');
  const permission = response({ error: { message: '该模型不在Key的可用模型范围内', type: 'invalid_key' } }, 401);
  assert.equal(parseSubmit(b, permission).error.category, 'permission');
  assert.equal(parseSubmit(b, permission).error.code, 'model_permission_denied');
  const invalid = response({ error: { code: 'invalid_api_key', message: 'Incorrect API key' } }, 401);
  assert.equal(parseSubmit(b, invalid).error.code, 'invalid_credentials');
});

test('nested gateway validation errors are interpreted without discarding field-specific messages', () => {
  const r = parseSubmit(binding('dashscope-images'), response({ error: { param: JSON.stringify({ code: 'InvalidParameter', message: 'Field required input.messages' }) } }, 400));
  assert.equal(r.kind, 'rejected');
  assert.equal(r.error.category, 'validation');
  assert.match(r.error.message, /input.messages/);
});

test('generic gateway messages retain the plain param explanation without exposing JSON or credentials', () => {
  const b = binding('openai-images');
  const detail = 'at least one image_url or image_urls is required';
  for (const message of ['Param Incorrect', 'Invalid request', 'Bad request', 'Invalid parameters']) {
    const result = parseSubmit(b, response({ error: { code: '400', message, param: detail } }, 400));
    assert.equal(result.error.message, `${message}：${detail}`);
    assert.equal(result.error.category, 'validation');
  }
  for (const param of ['{"input":"private payload"}', '["private payload"]', '"private payload"', '{"broken":"private payload"']) {
    const result = parseSubmit(b, response({ error: { message: 'Param Incorrect', param } }, 400));
    assert.equal(result.error.message, 'Param Incorrect');
  }
  const redacted = parseSubmit(b, response({ error: { message: 'Invalid request', param: 'Rejected token sk-fixture-secret' } }, 400));
  assert.match(redacted.error.message, /Rejected token \[redacted\]/);
  assert.equal(redacted.error.message.includes('sk-fixture-secret'), false);
});

test('specific and permission-denied messages stay authoritative over misleading plain param text', () => {
  const b = binding('openai-images', { errorProfile: 'mify' });
  const message = '该模型不在Key的可用模型范围内';
  const denied = parseSubmit(b, response({ error: { type: 'invalid_key', message, param: 'Please provide valid API Key' } }, 401));
  assert.equal(denied.error.message, message);
  assert.equal(denied.error.code, 'model_permission_denied');
  const specific = 'size must be a multiple of 16';
  assert.equal(parseSubmit(b, response({ error: { message: specific, param: 'Please provide valid API Key' } }, 400)).error.message, specific);
});

test('rejected submissions retain safe HTTP diagnostics without copying response payloads', () => {
  const result = parseSubmit(binding('ark-video'), {
    status: 400, headers: { 'X-REQUEST-ID': 'header-request-42' },
    body: { request_id: 'body-request-41', error: { code: 'InvalidParameter', message: 'Invalid request' },
      echoed_request: { prompt: 'private payload text', authorization: 'not-copied' }, usage: { raw_payload: 'not-copied' } },
  });
  assert.equal(result.kind, 'rejected');
  assert.equal(result.requestId, 'body-request-41');
  assert.deepEqual({ status: result.error.status, providerCode: result.error.providerCode, requestId: result.error.requestId },
    { status: 400, providerCode: 'InvalidParameter', requestId: 'body-request-41' });
  assert.equal(result.error.message, 'Invalid request');
  assert.equal(JSON.stringify(result).includes('private payload text'), false);
  assert.equal(JSON.stringify(result).includes('not-copied'), false);
  assert.equal(result.usage, undefined);
});

test('error request IDs use case-insensitive headers and survive uncertain or malformed responses', () => {
  for (const headers of [{ 'X-ReQuEsT-Id': 'request-header-1' }, new Headers({ 'x-request-id': 'request-header-1' })]) {
    for (const [status, body] of [[422, { error: { message: 'invalid size', code: 'BadRequest.Size' } }], [503, { error: { message: 'gateway unavailable' } }], [200, '<html>not JSON</html>']]) {
      const result = parseSubmit(binding('ark-video'), { status, body, headers });
      assert.equal(result.requestId, 'request-header-1');
      assert.equal(result.error.requestId, 'request-header-1');
      assert.equal(result.error.status, status);
      if (status === 422) assert.equal(result.error.message, 'invalid size');
      else { assert.equal(result.kind, 'submission_unknown'); assert.equal(result.error.retryable, false); }
    }
  }
});

test('unsafe diagnostic tokens and nested raw error payloads are omitted', () => {
  for (const value of ['https://fixture.invalid/?key=private', 'Bearer secret-token', 'sk-fake-secret-value', '{"payload":"private"}', 'line\nheader', 'x'.repeat(201)]) {
    const result = parseSubmit(binding('openai-images'), { status: 400, headers: { 'x-request-id': 'safe-header-id' },
      body: { request_id: value, error: { code: value, message: 'Invalid request' } } });
    assert.equal(result.requestId, 'safe-header-id');
    assert.equal(result.error.providerCode, undefined);
    assert.equal(JSON.stringify(result).includes(value), false);
  }
  const result = parseSubmit(binding('openai-images'), response({ error: {
    param: JSON.stringify({ input: { prompt: 'private-input-text' }, authorization: 'private-key' }),
  } }, 400));
  assert.equal(result.error.message, '媒体请求失败');
  assert.equal(JSON.stringify(result).includes('private-input-text'), false);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('poll errors and immediately failed task receipts retain their own request IDs', () => {
  const b = binding('ark-video');
  const denied = parsePoll(b, { status: 403, headers: { 'x-request-id': 'poll-denied' }, body: { error: { code: 'PermissionDenied', message: 'Access denied to this task' } } });
  assert.equal(denied.error.status, 403); assert.equal(denied.error.providerCode, 'PermissionDenied');
  assert.equal(denied.requestId, 'poll-denied'); assert.equal(denied.error.requestId, 'poll-denied');
  assert.equal(denied.error.submissionUncertain, false);
  const failure = { id: 'failed-task', status: 'failed', request_id: 'terminal-request', error: { code: 'InvalidParameter', message: 'duration out of range' } };
  for (const parsed of [parseSubmit(b, response(failure)), parsePoll(b, response(failure))]) {
    assert.equal(parsed.error.status, 200); assert.equal(parsed.error.providerCode, 'InvalidParameter');
    assert.equal(parsed.error.requestId, 'terminal-request'); assert.equal(parsed.error.message, 'duration out of range');
  }
});

test('ambiguous submit failures never recommend automatic resubmission', () => {
  for (const r of [response('bad gateway', 502), response('', 0), response('', 408), response('', 499), response('<html>ok</html>', 200), response({ id: 'unrecognized' }, 202)]) {
    const parsed = parseSubmit(binding('openai-images'), r);
    assert.equal(parsed.kind, 'submission_unknown');
    assert.equal(parsed.error.submissionUncertain, true);
    assert.equal(parsed.error.retryable, false);
  }
  const noTask = parseSubmit(binding('ark-video'), response({ status: 'running' }, 202));
  assert.equal(noTask.kind, 'submission_unknown');
});

test('poll request failure does not mean remote failure; terminal errors and missing downloads remain distinct', () => {
  const b = binding('ark-video');
  assert.equal(parsePoll(b, response({ error: { message: 'temporary failure' } }, 503)).state, 'unknown');
  const failed = parsePoll(b, response({ id: 'cgt-1', status: 'failed', error: { code: 'InvalidParameter', message: 'invalid content' } }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.category, 'validation');
  const succeeded = parsePoll(b, response({ status: 'succeeded', content: {} }));
  assert.equal(succeeded.state, 'succeeded');
  assert.equal(succeeded.error.code, 'unexpected_response');
  for (const state of ['cancelled', 'expired', 'running']) assert.equal(parsePoll(b, response({ status: state })).state, state);
});

test('immediate failed task retains its remote handle for records', () => {
  const r = parseSubmit(binding('ark-video'), response({ id: 'task-failed', status: 'failed', error: { code: 'InvalidParameter', message: 'Missing input' } }));
  assert.equal(r.kind, 'accepted');
  assert.equal(r.state, 'failed');
  assert.equal(r.handle.taskId, 'task-failed');
});

test('a declared default reference role is honored and incompatible inferred roles are rejected', () => {
  const b = binding('ark-video', { capabilities: { operations: ['image_to_video'], references: { max: 2, roles: ['reference_image'], defaultRole: 'reference_image' } } });
  const req = encodeSubmit(b, { references: [png, png] });
  assert.deepEqual(req.body.content.map(part => part.role), ['reference_image', 'reference_image']);
  const unsupportedDefault = { ...b, capabilities: { ...b.capabilities, references: { max: 1, roles: ['last_frame'] } } };
  assert.equal(validateInput(unsupportedDefault, { references: [png] }).ok, false);
});

test('migration can explicitly retain legacy JSON edit encoding on the binding', () => {
  const b = binding('openai-images', { editTransport: 'legacy-json-image-url', capabilities: { operations: ['image_to_image'], references: { max: 1 } } });
  assert.equal(encodeSubmit(b, { prompt: 'Edit', references: [png] }).body.image_url, png);
});
