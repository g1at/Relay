'use strict';
// Real bundled SDK/CLI, synthetic credentials and loopback API only. All files,
// tools and sessions live in a disposable workspace; no user's Relay is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const { CONNECTION_FAILURE_MESSAGE } = require('../src/main/sdk/sdk-retry-policy');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retry-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const fixture = path.join(cwd, 'fixture.txt'); fs.writeFileSync(fixture, 'Synthetic retry test data');
const output = path.join(__dirname, '../.codex-tmp/sdk-retry-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(),
  checks: [], scenarios: [] };
let active, server, runtimeEnv;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
async function until(test, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(20); }
}
async function deadline(promise, label, timeout = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function reply(res, body, blocks) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index,
      content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
function fail(res, status, type, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0', ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
function create(name, mode) {
  const state = active = { name, mode, requests: [], events: [], results: [], started: Date.now() };
  report.scenarios.push(state);
  Object.defineProperty(state, 'session', { enumerable: false, value: relay.createLiveSession({ cwd, model: 'fixture-model',
    tools: mode === 'tool-retry' ? ['Read'] : [], permissionMode: 'bypassPermissions', runtimeEnv: mode === 'capacity'
      ? { ...runtimeEnv, CLAUDE_CODE_MAX_RETRIES: '1' } : runtimeEnv,
    onMessage(event) {
      const eventRecord = { type: event.type, subtype: event.subtype, error: event.error, attempt: event.attempt,
        command_uuid: event.command_uuid, state: event.state,
        error_status: event.error_status, retry_delay_ms: event.retry_delay_ms, relay_retry_policy: event.relay_retry_policy,
        terminal_reason: event.terminal_reason, at: Date.now() - state.started };
      if (event.type === 'assistant') eventRecord.blocks = event.message?.content;
      state.events.push(eventRecord);
      if (event.type === 'result') state.results.push(event);
    }, onExit(code, error) { state.exit = { code, error }; },
  }) });
  return state;
}
async function send(state, prompt = 'Produce a synthetic fixture answer.') {
  await deadline(state.session.whenReady(), 'SDK ready', 30000);
  check(state.name + ': input accepted', state.session.push(prompt, { uuid: randomUUID() }));
}
async function scenario(name, mode, test) {
  const state = create(name, mode);
  try { await send(state); await test(state); }
  finally { await deadline(state.session.kill(), name + ': close'); }
}
async function oneShot(mode) {
  const state = active = { name: 'one-shot-' + mode, mode, requests: [], events: [], results: [], started: Date.now() };
  report.scenarios.push(state);
  const { handle } = relay.runOneShot({ cwd, model: 'fixture-model', tools: [], runtimeEnv,
    prompt: 'Return a synthetic one-shot fixture answer.', userMessageId: randomUUID(),
    onEvent(event) {
      state.events.push({ type: event.type, subtype: event.subtype, attempt: event.attempt });
      if (event.type === 'result') state.results.push(event);
      if (event.type === 'job-done') state.done = event;
    },
  });
  Object.defineProperty(state, 'session', { enumerable: false, value: handle });
  try {
    await until(() => state.done, 'one-shot ' + mode + ' settled');
    check('one-shot ' + mode + ': settles exactly once', state.events.filter(event => event.type === 'job-done').length === 1);
    if (mode === 'capacity') check('one-shot retries capacity then reports a successful final result', state.requests.length === 4 && state.done.exitCode === 0 && !state.done.aborted);
    else check('one-shot connection guard preserves failure rather than labeling user cancellation', state.done.exitCode !== 0 && state.done.error === CONNECTION_FAILURE_MESSAGE && !state.done.aborted);
  } finally { await deadline(handle.kill(), 'one-shot ' + mode + ': close'); }
}
(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const body = JSON.parse(raw), state = active;
      state.requests.push({ mode: state.mode, at: Date.now() - state.started, model: body.model,
        authorized: req.headers['x-api-key'] === 'synthetic-retry-key',
        toolResults: body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id) : []) });
      const requestNumber = state.requests.filter(request => request.mode === state.mode).length;
      if (state.mode === 'network') { req.socket.destroy(); return; }
      if (state.mode === 'auth') { fail(res, 401, 'authentication_error', 'Synthetic invalid API key'); return; }
      if (state.mode === 'billing') { fail(res, 400, 'billing_error', 'Your credit balance is too low to access the API.'); return; }
      if (state.mode === 'spend') { fail(res, 429, 'rate_limit_error', 'service_spend_limit_reached: synthetic exhausted credits'); return; }
      if (state.mode === 'always-503') { fail(res, 503, 'api_error', 'Synthetic server temporarily unavailable', { 'retry-after': '30' }); return; }
      if (state.mode === 'capacity' && requestNumber <= 3) { fail(res, 429, 'rate_limit_error', 'Synthetic transient capacity'); return; }
      if (state.mode === 'server' && requestNumber <= 3) { fail(res, 503, 'api_error', 'Synthetic transient server error'); return; }
      if (state.mode === 'tool-retry') {
        if (requestNumber === 1) { reply(res, body, [{ type: 'tool_use', id: 'synthetic-read-once', name: 'Read', input: { file_path: fixture } }]); return; }
        if (requestNumber <= 4) { fail(res, 429, 'rate_limit_error', 'Synthetic rate limit after completed Read'); return; }
      }
      reply(res, body, [{ type: 'text', text: 'fixture retry completed' }]);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-retry-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  for (const mode of ['capacity', 'server']) await scenario(mode + '-recovery', mode, async state => {
    await until(() => state.results.length, mode + ' recovered');
    check(mode + ': retries at request level then recovers in the same turn', state.requests.length === 4 && state.results.length === 1 && !state.results[0].is_error);
    check(mode + ': SDK retry progress reaches Relay', state.events.some(event => event.subtype === 'api_retry' && event.attempt >= 3 && event.relay_retry_policy === 'persistent'));
  });
  for (const mode of ['auth', 'billing', 'spend']) await scenario(mode + '-requires-user', mode, async state => {
    await until(() => state.results.length, mode + ' failed');
    check(mode + ': permanent error stops without a retry loop', state.results[0].is_error && state.requests.length <= 2);
    check(mode + ': exact error remains available', (mode === 'auth' ? /invalid api key/i : mode === 'billing' ? /credit balance/i : /spend|credits/i).test(JSON.stringify(state.results[0])));
  });
  await scenario('pause-during-backoff', 'always-503', async state => {
    await until(() => state.events.some(event => event.subtype === 'api_retry'), 'retry waiting');
    const start = Date.now(); await deadline(state.session.interrupt(), 'user pause');
    await until(() => state.results.length, 'paused result');
    check('user pause interrupts backoff promptly', Date.now() - start < 3000);
    check('user pause keeps native abort semantics', /^aborted_/.test(state.results[0].terminal_reason) && !state.results[0].relay_retry_stopped);
    const count = state.requests.length; await sleep(300);
    check('user pause sends no more retries', state.requests.length === count);
    state.mode = 'success'; await send(state, 'Continue the synthetic fixture after manual pause.');
    await until(() => state.results.length === 2, 'continued after pause');
    check('same SDK session remains usable after manual pause', !state.results[1].is_error);
  });
  await scenario('unavailable-connection', 'network', async state => {
    await until(() => state.events.some(event => event.subtype === 'api_retry'), 'network retry started');
    const queued = randomUUID();
    check('queued follow-up accepted during connection retry', state.session.push('Synthetic queued requirement; do not execute after network stop.', { uuid: queued, priority: 'later' }));
    await until(() => state.results.length, 'connection guard stopped', 45000);
    check('repeated no-response failures stop with a durable cause', state.results[0].relay_retry_stopped === 'connection_unavailable' && state.results[0].result === CONNECTION_FAILURE_MESSAGE);
    check('connection guard does not wait for hundreds of retries', state.requests.length <= 4);
    check('connection guard cancels queued follow-up before the turn ends', state.events.some(event => event.type === 'command_lifecycle' && event.command_uuid === queued && event.state === 'cancelled'));
    const count = state.requests.length; await sleep(300); check('connection guard stops subsequent attempts', state.requests.length === count);
    state.mode = 'success'; await sleep(500);
    check('connection recovery never auto-runs the canceled queued requirement', state.requests.length === count);
    await send(state, 'Continue after the synthetic connection recovers.');
    await until(() => state.results.length === 2, 'continued after network');
    check('same SDK session continues after connection recovery', !state.results[1].is_error);
  });
  await scenario('retry-after-completed-tool', 'tool-retry', async state => {
    await until(() => state.results.length, 'tool retry recovered');
    check('tool turn recovers without a new user prompt', !state.results[0].is_error);
    const toolEvents = state.events.flatMap(event => event.blocks || []).filter(block => block.type === 'tool_use');
    check('completed tool appears exactly once across request retries', toolEvents.length === 1 && toolEvents[0].id === 'synthetic-read-once');
    check('every retried request includes the same completed tool result', state.requests.slice(1).every(request => request.toolResults.length === 1 && request.toolResults[0] === 'synthetic-read-once'));
  });
  await oneShot('capacity');
  await oneShot('network');
  check('all model requests were synthetic and used the configured loopback key', report.scenarios.every(state => state.requests.every(request => request.authorized && request.model === 'fixture-model')));
  report.ok = true;
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, scenarios: report.scenarios.length }));
})().catch(error => { report.ok = false; report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; }).finally(async () => {
  if (active?.session) await active.session.kill();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true; break; }
    catch { await sleep(100); }
  }
  if (!report.cleanedUp) { report.ok = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
});
