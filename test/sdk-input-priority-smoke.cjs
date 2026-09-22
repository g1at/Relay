'use strict';
// Real bundled SDK and CLI; temporary resources, synthetic credentials and loopback only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../src/main/sdk/claude-sdk');
const { LiveTurnRouter } = require('../src/main/live/live-turn-router');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-priority-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const source = path.join(cwd, 'fixture.txt'); fs.writeFileSync(source, 'local fixture only');
const output = path.join(__dirname, '../.codex-tmp/sdk-upgrade-0266'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), checks: [], scenarios: [] };
let active, server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { const end = Date.now() + 30000; while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(20); } }
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
function send(res, body, blocks) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: blocks.some(item => item.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
async function scenario(priority, url) {
  const id = randomUUID(), supplement = randomUUID(), marker = 'RELAY_ADDITIONAL_' + priority;
  const state = active = { priority, requests: [], events: [], results: [], release: null, session: null };
  const router = new LiveTurnRouter(); router.begin(id);
  const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-priority-key', ANTHROPIC_BASE_URL: url,
    ANTHROPIC_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const session = state.session = relay.createLiveSession({ cwd, model: 'fixture-model', runtimeEnv, tools: ['Read'],
    canUseTool: async (name, input) => name === 'Read' && input.file_path === source ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only fixture Read is allowed' },
    onMessage(event) { state.events.push(event); const owned = router.accept(event); if (owned?.type === 'result') state.results.push(owned); },
    onExit(code, error) { state.exit = { code, error }; },
  });
  try {
    check(priority + ': initial input accepted', session.push('Read the fixture then answer ORIGINAL_' + priority, { uuid: id }));
    await until(() => state.release, priority + ' first API request');
    check(priority + ': supplement registered', router.registerSupplement(supplement));
    check(priority + ': supplement accepted', session.push(marker, { uuid: supplement, priority }));
    await until(() => state.events.some(event => event.type === 'command_lifecycle' && event.command_uuid === supplement && event.state === 'queued'), priority + ' queued receipt');
    check(priority + ': queuing preserves pending state', router.hasPendingSupplements());
    state.release();
    await until(() => !router.hasPendingSupplements() && state.results.length >= (priority === 'later' ? 2 : 1), priority + ' all input completed');
    check(priority + ': no abort result', state.results.every(event => !/^aborted_/.test(String(event.terminal_reason || ''))));
    check(priority + ': no pending supplement after final', !router.hasPendingSupplements());
    check(priority + ': both inputs consumed', state.events.some(event => event.type === 'command_lifecycle' && event.command_uuid === supplement && event.state === 'started'));
    check(priority + ': original reply bound correctly', state.results.some(event => event.user_message_uuid === id || event.user_message_uuids?.includes(id)));
    check(priority + ': endpoint and credentials preserved', state.requests.every(item => item.model === 'fixture-model' && item.authorized));
    if (priority === 'next') {
      check('next: supplement folded into the post-tool request', state.requests.length === 2 && state.requests[1].containsMarker);
      check('next: one combined completed turn', state.results.length === 1);
    } else {
      check('later: original post-tool request excludes queued prompt', state.requests.length === 3 && !state.requests[1].containsMarker);
      check('later: queued prompt starts a separate request after original result', state.requests[2].containsMarker && state.requests[2].resultsBefore === 1);
      check('later: both completed turns retain input correlation', state.results.length === 2 && state.results[1].user_message_uuid === supplement);
    }
    report.scenarios.push({ priority, requests: state.requests, results: state.results.map(event => ({ uuid: event.user_message_uuid, uuids: event.user_message_uuids, reason: event.terminal_reason, queued: event.queued_turn_count })), lifecycle: state.events.filter(event => event.type === 'command_lifecycle').map(event => ({ command: event.command_uuid === id ? 'original' : event.command_uuid === supplement ? 'supplement' : 'other', state: event.state })) });
  } finally { if (state.release) state.release(); await session.kill(); }
}
(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const body = JSON.parse(raw), state = active, index = state.requests.length;
      state.requests.push({ model: body.model, authorized: req.headers['x-api-key'] === 'synthetic-priority-key', containsMarker: JSON.stringify(body.messages).includes('RELAY_ADDITIONAL_' + state.priority), resultsBefore: state.results.length });
      if (!index) { let sent = false; state.release = () => { if (sent) return; sent = true; send(res, body, [{ type: 'tool_use', id: 'tool_' + randomUUID(), name: 'Read', input: { file_path: source } }]); }; }
      else send(res, body, [{ type: 'text', text: 'fixture completed ' + index }]);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/anthropic`;
  await scenario('next', url); await scenario('later', url);
  report.ok = true; console.log(JSON.stringify({ ok: true, checks: report.checks.length, sdk: report.sdk, scenarios: report.scenarios.length }));
})().catch(error => { report.ok = false; report.error = String(error.stack || error); if (active) report.failedScenario = { priority: active.priority, requests: active.requests, events: active.events.filter(event => ['result', 'command_lifecycle'].includes(event.type)) }; console.error(report.error); process.exitCode = 1; }).finally(async () => {
  if (active?.session) await active.session.kill(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // Windows can release the native process's cwd handle after its final stream event.
  let cleanupError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleanupError = null; break; }
    catch (error) { cleanupError = error; await sleep(100); }
  }
  report.cleanedUp = !cleanupError;
  if (cleanupError) { report.ok = false; report.cleanupError = String(cleanupError.code || cleanupError.message); process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'input-priority.json'), JSON.stringify(report, null, 2));
});
