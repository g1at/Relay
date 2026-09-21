'use strict';
// Installed SDK/CLI, synthetic credentials and a loopback API. No user Relay
// settings, conversation history, provider calls or Electron process is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { LiveExecutionModes } = require('../execution-modes');
// Optional comparison reproduces the old contract: the local ACK clock starts
// before the SDK initialization barrier. Production and normal checks keep it.
if (process.argv.includes('--legacy-deadline')) {
  const prepareMode = LiveExecutionModes.prototype.prepare;
  LiveExecutionModes.prototype.prepare = function(...args) { this.ready = async () => {}; return prepareMode.apply(this, args); };
}
const observeMode = LiveExecutionModes.prototype.observe;
LiveExecutionModes.prototype.observe = function(event) {
  if (active && this.pending && ['result', 'command_lifecycle'].includes(event.type)) {
    (active.internalAcks ||= []).push({ type: event.type, state: event.state, correlated: (event.command_uuid || event.user_message_uuid) === this.pending.id,
      result: event.result, numTurns: event.num_turns, apiMs: event.duration_api_ms });
  }
  return observeMode.call(this, event);
};
const relay = require('../claude-sdk');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-goal-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const output = path.join(__dirname, '../.codex-tmp/sdk-goal-recovery');
fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform,
  emulatesLegacyStartupDeadline: process.argv.includes('--legacy-deadline'), checks: [], scenarios: [] };
const probe = process.argv.includes('--probe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let active, server, runtimeEnv;
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
async function deadline(promise, label, timeout = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(20); }
}
function send(res, body, text) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
function create(name, extra = {}) {
  const state = active = { name, started: Date.now(), requests: [], events: [], results: [], sessionId: null, rejectRequests: false };
  report.scenarios.push(state);
  Object.defineProperty(state, 'session', { enumerable: false, value: relay.createLiveSession({ cwd, model: 'fixture-model', tools: [], runtimeEnv,
    ...extra,
    onMessage(event) {
      if (event.session_id) state.sessionId = event.session_id;
      const item = { at: Date.now() - state.started, type: event.type, subtype: event.subtype,
        uuid: event.user_message_uuid || event.command_uuid, state: event.state, error: event.is_error,
        reason: event.terminal_reason, numTurns: event.num_turns, apiMs: event.duration_api_ms };
      if (event.type === 'result') { item.text = event.result; state.results.push(event); }
      if (event.type === 'active_goal') item.hasGoal = !!event.value;
      if (event.type === 'assistant') item.text = event.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('');
      state.events.push(item);
    },
    onExit(code, error) { state.exit = { at: Date.now() - state.started, code, error }; },
  }) });
  return state;
}
async function prepare(state, options = {}) {
  const started = Date.now();
  try {
    const result = await state.session.prepareExecutionMode({ kind: 'goal' }, { contextPrompt: 'Produce a fixture summary. This is synthetic local test data only.',
      goalCondition: 'produce fixture summary', timeoutMs: 10000, ...options });
    state.preparations = [...(state.preparations || []), { ok: true, durationMs: Date.now() - started, ...result }]; return result;
  } catch (error) {
    state.preparations = [...(state.preparations || []), { ok: false, durationMs: Date.now() - started, code: error.code, message: error.message }];
    if (!probe) throw error;
    return false;
  }
}
async function goal429() {
  let state = create('cold-goal-context');
  if (!await prepare(state)) {
    await deadline(state.session.kill(), 'failed cold preparation close');
    state = create('429-without-internal-context');
    if (!await prepare(state, { contextPrompt: undefined })) return;
  }
  check('goal preparation makes no model API call', state.requests.length === 0);
  state.rejectRequests = true;
  const original = randomUUID();
  check('initial synthetic goal accepted', state.session.push('/goal produce fixture summary', { uuid: original }));
  await until(() => state.results.some(event => event.is_error), '429 terminal result');
  check('terminal API error is reported', state.results.some(event => event.is_error && /429/.test(event.result || '')));
  await until(() => state.events.some(event => event.type === 'command_lifecycle' && event.uuid === original && ['completed', 'cancelled'].includes(event.state)), '429 command settled');
  state.rejectRequests = false;
  check('control channel responds after API error', !!await deadline(state.session.getContextUsage({ detail: 'summary' }), 'control after 429', 8000));
  const statusId = randomUUID(), statusBefore = state.results.length;
  check('goal status command accepted after 429', state.session.push('/goal', { uuid: statusId }));
  await until(() => state.results.length > statusBefore, 'native goal status after 429');
  state.nativeGoalStatus = state.results.at(-1).result;
  check('native goal remains active after a retryable 429', /^Goal active: produce fixture summary/.test(state.nativeGoalStatus));
  const nativeId = state.sessionId;
  check('goal conversation has a resumable SDK session', typeof nativeId === 'string' && nativeId.length > 0);
  await deadline(state.session.kill(), '429 session recycle');
  state = create('resume-after-429', { sessionId: nativeId, executionMode: { kind: 'goal' } });
  const ready = await prepare(state, { contextPrompt: 'Continue producing the original fixture summary.', goalCondition: 'continue', previousGoal: 'produce fixture summary' });
  if (!ready) return;
  check('resumed continuation retains original completion condition', ready.goalCondition === 'produce fixture summary');
  check('resumed continuation does not replace the goal with continue', ready.prompt !== '/goal continue');
  const continued = randomUUID(), before = state.results.length;
  check('continued goal accepted after 429', state.session.push(ready.prompt || '/goal produce fixture summary', { uuid: continued, files: ready.files }));
  await until(() => state.results.slice(before).some(event => !event.is_error && event.num_turns > 0), 'continued goal result');
  check('continued goal completes model output', state.results.slice(before).some(event => !event.is_error && /fixture summary complete/.test(event.result || '')));
  check('internal context cannot leak into application events', !state.events.some(event => event.text?.includes('以下是本次目标的任务上下文')));
  const afterComplete = state.results.length;
  check('goal status remains queryable after completion', state.session.push('/goal', { uuid: randomUUID() }));
  await until(() => state.results.length > afterComplete, 'native goal status after completion');
  state.completedGoalStatus = state.results.at(-1).result;
  check('the native goal evaluator completes and clears its condition', /^No goal set/.test(state.completedGoalStatus));
  const next = await prepare(state, { goalCondition: 'produce second fixture summary', contextPrompt: 'A new independent fixture goal.', previousGoal: null });
  if (next) check('a completed goal is not resurrected for a new request', next.prompt === '/goal produce second fixture summary' && next.goalCondition === 'produce second fixture summary');
  await deadline(state.session.kill(), 'goal session close');
}
async function startupAndCancellation() {
  relay.configureRuntimeEnvironment({ async prepareOptions(options) { await sleep(600); return options; } });
  let state = create('delayed-cold-preparation');
  try {
    const ready = await prepare(state, { timeoutMs: 300, startupTimeoutMs: 8000 });
    if (ready) {
      check('SDK startup does not consume the local command ACK deadline', state.preparations.at(-1).durationMs > 600);
      check('cold preparation requires no model request', state.requests.length === 0);
    }
    await deadline(state.session.kill(), 'delayed startup close');
    state = create('cancel-during-startup');
    const aborter = new AbortController(), started = Date.now();
    const pending = state.session.prepareExecutionMode({ kind: 'goal' }, {
      contextPrompt: 'This canceled fixture input must never be delivered.', goalCondition: 'produce fixture summary', signal: aborter.signal,
      timeoutMs: 300, startupTimeoutMs: 8000,
    });
    setTimeout(() => aborter.abort(), 50);
    await assert.rejects(pending, { code: 'MODE_PREPARE_CANCELED' });
    check('canceling initialization rejects promptly', Date.now() - started < 500);
    check('canceled initialization cannot enqueue a late prompt', state.session.push('must not run', { uuid: randomUUID() }) === false);
    await deadline(state.session.kill(), 'canceled startup close');
    check('canceled startup makes no API request', state.requests.length === 0);
  } finally { await state.session.kill(); relay.configureRuntimeEnvironment(null); }
}
async function coldMcp(legacyReapply = false) {
  const fixture = path.join(base, 'mcp-fixture.cjs');
  const log = path.join(base, legacyReapply ? 'mcp-legacy.log' : 'mcp-adopted.log');
  fs.writeFileSync(fixture, `'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.argv[2];
fs.appendFileSync(log, JSON.stringify({ event: 'start', pid: process.pid }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch (_) { return; }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  let result = {};
  if (message.method === 'initialize') {
    fs.appendFileSync(log, JSON.stringify({ event: 'initialize', pid: process.pid }) + '\\n');
    result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'relay-fixture', version: '1.0' } };
  } else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: 'Synthetic local read-only echo', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'synthetic fixture echo' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`);
  const servers = { fixture: { command: process.execPath, args: [fixture, log] } };
  const state = create(legacyReapply ? 'cold-mcp-legacy-reapply' : 'cold-mcp-adopted', { mcpServers: servers });
  try {
    await state.session.whenReady({ timeoutMs: 10000 });
    state.readyMs = Date.now() - state.started;
    const prepStart = Date.now();
    if (legacyReapply) await state.session.setMcpServers(servers);
    state.mcp = await state.session.prepareMcp({ servers, timeoutMs: 10000 });
    state.preparationMs = Date.now() - prepStart;
    check(state.name + ': original configured MCP connects before first prompt', state.mcp.ok && state.mcp.items.some(item => item.name === 'fixture' && item.status === 'connected'));
    check(state.name + ': startup and MCP preparation make no model request', state.requests.length === 0);
    const sentAt = Date.now();
    check(state.name + ': first hello accepted', state.session.push('Hello from the synthetic MCP fixture.', { uuid: randomUUID() }));
    await until(() => state.results.some(event => !event.is_error), state.name + ' hello result');
    state.firstOutputMs = state.events.find(event => event.type === 'assistant' && event.text?.includes('fixture summary complete'))?.at - (sentAt - state.started);
    const secondPrep = Date.now();
    check(state.name + ': unchanged MCP is ready on the next turn', (await state.session.prepareMcp({ servers, timeoutMs: 10000 })).ok);
    state.warmPreparationMs = Date.now() - secondPrep;
    state.transports = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (!legacyReapply) {
      check('adopting initial MCP creates one transport only', state.transports.filter(event => event.event === 'start').length === 1);
      check('adopting initial MCP performs one initialize handshake only', state.transports.filter(event => event.event === 'initialize').length === 1);
      check('adopting initial MCP does not resend its configuration', state.mcp.synced === false);
    }
  } finally { await deadline(state.session.kill(), state.name + ' close'); }
}
(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const body = JSON.parse(raw), state = active;
      state.requests.push({ at: Date.now() - state.started, authorized: req.headers['x-api-key'] === 'synthetic-goal-key', model: body.model,
        stream: body.stream, rejected: state.rejectRequests, maxTokens: body.max_tokens });
      if (state.rejectRequests) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic fixture rate limit (429)' } })); return; }
      // The first successful request is the main turn; the following request
      // is the native /goal Stop-hook evaluator, which expects an OK verdict.
      send(res, body, state.requests.filter(request => !request.rejected).length === 1 ? 'fixture summary complete' : '{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-goal-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_RETRY_WATCHDOG: '0', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  if (!process.argv.includes('--mcp-only')) { await startupAndCancellation(); await goal429(); }
  await coldMcp(false); await coldMcp(true);
  report.ok = true; console.log(JSON.stringify({ ok: true, probe, checks: report.checks.length, scenarios: report.scenarios.length }));
})().catch(error => { report.ok = false; report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; }).finally(async () => {
  if (active?.session) await active.session.kill();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  let cleanupError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleanupError = null; break; }
    catch (error) { cleanupError = error; await sleep(100); }
  }
  report.cleanedUp = !cleanupError;
  if (cleanupError) { report.ok = false; report.cleanupError = cleanupError.code; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, report.emulatesLegacyStartupDeadline ? 'legacy-deadline.json' : probe ? 'probe.json' : 'result.json'), JSON.stringify(report, null, 2));
});
