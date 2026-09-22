'use strict';
// Real bundled SDK process; isolated configuration; synthetic image and
// credentials; loopback fixture endpoint only. Does not launch Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-images-smoke-'));
const config = path.join(root, 'config'); fs.mkdirSync(config);
const imagePath = path.join(root, 'synthetic.png'); fs.writeFileSync(imagePath, PNG);
const observations = [], events = [];
let handle, activeCase, responseRelease, requestArrived, contextDuringResponse;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body; try { body = JSON.parse(raw || '{}'); } catch (_) { res.writeHead(400); res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.end('{"input_tokens":25}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const images = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
    observations.push({ case: activeCase, imageCount: images.length,
      exactPng: images.some(image => image.source && image.source.media_type === 'image/png' && image.source.data === PNG.toString('base64')) });
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'image-fixture-complete' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 5 } };
    const respond = () => {
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'image-fixture-complete' } });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
    };
    if (activeCase === 'live-first' && requestArrived) {
      responseRelease = respond; const notify = requestArrived; requestArrived = null; notify();
    } else respond();
  });
});
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic image smoke timed out')), 45000); })]); }
  finally { clearTimeout(timer); }
}
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-image-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_MODEL: 'image-fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const params = { cwd: root, model: 'image-fixture-model', tools: [], runtimeEnv };
  activeCase = 'one-shot';
  ({ handle } = relay.runOneShot({ ...params, prompt: 'Synthetic screenshot fixture.', files: [{ path: imagePath }], onEvent: event => events.push(event) }));
  await deadline(handle.whenClosed());
  assert.ok(events.some(event => event.type === 'result' && !event.is_error && event.result === 'image-fixture-complete'));
  assert.equal(events.at(-1).exitCode, 0); handle = null;
  let finish;
  activeCase = 'live';
  handle = relay.createLiveSession({ ...params, onMessage: event => { events.push(event); if (event.type === 'result') finish(event); }, onExit() {} });
  for (const priority of [undefined, 'next', 'later']) {
    activeCase = 'live-' + (priority || 'first');
    const done = new Promise(resolve => { finish = resolve; });
    const arrived = priority === undefined ? new Promise(resolve => { requestArrived = resolve; }) : null;
    assert.equal(handle.push('Synthetic screenshot fixture.', { uuid: randomUUID(), files: [{ path: imagePath }], priority }), true);
    if (arrived) {
      await deadline(arrived);
      const started = Date.now(); let timer;
      try {
        const usage = await Promise.race([handle.getContextUsage({ detail: 'summary' }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('context timeout')), 8000); })]);
        contextDuringResponse = { ok: true, durationMs: Date.now() - started,
          totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage, fieldNames: Object.keys(usage) };
      } catch (error) { contextDuringResponse = { ok: false, durationMs: Date.now() - started, error: error.message }; }
      finally { clearTimeout(timer); responseRelease(); responseRelease = null; }
    }
    const result = await deadline(done);
    assert.equal(result.is_error, false); assert.equal(result.result, 'image-fixture-complete');
  }
  await deadline(handle.kill()); handle = null;
  for (const name of ['one-shot', 'live-first', 'live-next', 'live-later']) assert.ok(observations.some(item => item.case === name && item.exactPng), name);
  assert.equal(JSON.stringify(events).includes(PNG.toString('base64')), false);
  console.log(JSON.stringify({ ok: true, platform: process.platform, cases: observations, eventImageDataStripped: true, contextDuringResponse }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (handle) await handle.kill();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
