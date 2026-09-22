'use strict';
// Actual bundled SDK/CLI, one connected loopback HTTP MCP, one offline MCP
// whose reconnect is slow, and a deterministic loopback model. No real keys,
// Relay profile or user files. A pending cold connection is deliberately NOT
// treated like a failed server: the SDK waits for cold MCP startup itself.
// Run scenarios sequentially: cold-start timings would be misleading in parallel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const { dispatchLiveInput, cancelPendingLiveInput } = require('../src/main/live/live-mcp-dispatch');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-startup-'));
const output = path.join(__dirname, '../.codex-tmp/sdk-mcp-startup-performance');
fs.mkdirSync(output, { recursive: true });
const RECONNECT_DELAY_MS = 3000;
const MARKER = 'RELAY_SYNTHETIC_SLOW_MCP_RESULT_7f9278';
const MCP_TOOL = 'mcp__slow__echo';
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), platform: process.platform,
  reconnectDelayMs: RECONNECT_DELAY_MS, checks: [], scenarios: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, currentSession;
const states = new Map();
function check(label, value) { assert.ok(value, label); report.checks.push(label); }
async function until(predicate, label, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= end) throw Error('Timed out: ' + label); await sleep(20); }
}
async function deadline(promise, label, timeoutMs = 25000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function replyJson(res, body, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}
function send(res, body, blocks) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) return replyJson(res, message);
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
function tool(name, input) { return { type: 'tool_use', id: 'tool_' + randomUUID(), name, input }; }
async function serveMcp(state, req, res, body) {
  if (req.method === 'GET') return replyJson(res, {}, 405);
  if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') return replyJson(res, {}, 405);
  state.mcpEvents.push({ method: body.method, at: Date.now() - state.started });
  if (!Object.hasOwn(body, 'id')) { res.writeHead(202); res.end(); return; }
  let result = {};
  if (body.method === 'initialize') {
    state.initializeStartedAt ??= Date.now();
    state.initializeFinishedAt = Date.now();
    result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'relay-slow-synthetic', version: '1.0.0' } };
  } else if (body.method === 'tools/list') {
    state.toolsListedAt = Date.now();
    result = { tools: [{ name: 'echo', description: 'Return the synthetic slow MCP fixture marker.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }] };
  } else if (body.method === 'tools/call') {
    state.calls.push({ name: body.params.name, arguments: body.params.arguments, at: Date.now() - state.started });
    result = { content: [{ type: 'text', text: MARKER }] };
  }
  replyJson(res, { jsonrpc: '2.0', id: body.id, result });
}
async function serveOfflineMcp(state, req, res, body) {
  state.offlineEvents.push({ method: body.method || req.method, at: Date.now() - state.started });
  if (body.method === 'initialize') {
    if (state.delayReconnect) {
      state.reconnectStartedAt = Date.now();
      await sleep(RECONNECT_DELAY_MS);
      state.reconnectFinishedAt = Date.now();
    }
    // A JSON-RPC error settles as failed without introducing a real DNS or
    // transport dependency. Reconnecting repeats this precise local failure.
    return replyJson(res, { jsonrpc: '2.0', id: body.id,
      error: { code: -32603, message: 'Synthetic offline MCP fixture.' } });
  }
  return replyJson(res, {}, 405);
}
function serveApi(state, req, res, body) {
  const tools = (body.tools || []).map(item => item.name);
  const toolResults = (body.messages || []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result') : []);
  state.firstApiAt ??= Date.now();
  state.requests.push({ at: Date.now() - state.started, phase: state.phase, tools,
    toolResults, correctCredential: req.headers['x-api-key'] === `synthetic-mcp-startup-${state.name}`,
    model: body.model });
  if (state.phase === 'denied') {
    if (state.phaseRequests++ === 0) return send(res, body, [tool(MCP_TOOL, { value: 'denied fixture' })]);
    return send(res, body, [{ type: 'text', text: 'The denied synthetic operation was not performed.' }]);
  }
  const index = state.phaseRequests++;
  if (index === 0) {
    state.toolSearchAvailable = tools.includes('ToolSearch');
    state.directMcpAvailable = tools.includes(MCP_TOOL);
    return send(res, body, [state.toolSearchAvailable
      ? tool('ToolSearch', { query: 'select:' + MCP_TOOL, max_results: 1 })
      : tool(MCP_TOOL, { value: 'approved fixture' })]);
  }
  if (index === 1 && state.toolSearchAvailable) {
    state.searchResult = toolResults.at(-1);
    return send(res, body, [tool(MCP_TOOL, { value: 'approved fixture' })]);
  }
  state.modelSawMarker = toolResults.some(block => JSON.stringify(block).includes(MARKER));
  send(res, body, [{ type: 'text', text: state.modelSawMarker ? 'Synthetic MCP fixture completed.' : 'Synthetic MCP marker missing.' }]);
}
function create(name) {
  const root = path.join(base, name), cwd = path.join(root, 'workspace'), config = path.join(root, 'config');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(config); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
  const state = { name, started: Date.now(), phase: 'allowed', phaseRequests: 0,
    requests: [], mcpEvents: [], offlineEvents: [], calls: [], permissions: [], statuses: [], failures: [], results: [] };
  states.set(name, state); report.scenarios.push(state);
  const url = `http://127.0.0.1:${server.address().port}`;
  const servers = { slow: { type: 'http', url: `${url}/mcp/${name}` }, offline: { type: 'http', url: `${url}/offline/${name}` } };
  const approval = deferred();
  const child = currentSession = relay.createLiveSession({ cwd, model: 'claude-sonnet-4-6', permissionMode: 'default',
    tools: ['Read', 'ToolSearch'], mcpServers: servers, mcpPermissionOverrides: { slow: 'default' },
    runtimePolicy: { settingSources: [], settings: { permissions: { allow: ['mcp__slow__echo'] } } },
    runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: `synthetic-mcp-startup-${name}`,
      ANTHROPIC_BASE_URL: `${url}/api/${name}`, ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      CLAUDE_CODE_RETRY_WATCHDOG: '0', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      ENABLE_TOOL_SEARCH: '',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    canUseTool: async (toolName, input) => {
      state.permissions.push({ toolName, phase: state.phase, at: Date.now() - state.started });
      if (toolName !== MCP_TOOL) return { behavior: 'allow', updatedInput: input };
      if (state.phase === 'denied') return { behavior: 'deny', message: 'Synthetic user rejected this operation.' };
      await approval.promise;
      return { behavior: 'allow', updatedInput: input };
    },
    onMessage: event => { if (event.type === 'result') state.results.push({ is_error: event.is_error, result: event.result, at: Date.now() - state.started }); },
    onExit: (code, error) => { state.exit = { code, error }; },
  });
  const host = { child, busy: true, dead: false, jobId: randomUUID() };
  const dispatch = (extra = {}) => dispatchLiveInput({ session: host, jobId: host.jobId,
    prompt: 'Use ToolSearch to discover slow echo and call it once with the synthetic fixture value.',
    loadServers: () => servers, isSessionCurrent: () => !host.dead,
    onStatus: value => state.statuses.push({ ...value, at: Date.now() - state.started }),
    onFailure: value => state.failures.push(value), onTiming: value => { state.timing = value; }, ...extra });
  return { state, child, host, servers, approval, dispatch };
}
async function exercise(label, legacy) {
  const fixture = create(label), { state, child, host, servers, approval, dispatch } = fixture;
  try {
    await deadline(child.whenReady(), label + ' startup');
    state.initial = await child.prepareMcp({ servers, reconnect: false, timeoutMs: 10000 });
    check(label + ': genuine cold startup settles one connected and one failed MCP',
      state.initial.items.some(item => item.name === 'slow' && item.status === 'connected')
      && state.initial.items.some(item => item.name === 'offline' && item.status === 'failed'));
    check(label + ': initial readiness does not reconnect a failed server', state.offlineEvents.filter(item => item.method === 'initialize').length === 1);
    state.delayReconnect = true;
    state.sdkReadyAt = Date.now();
    if (legacy) {
      const start = Date.now();
      state.prepared = await child.prepareMcp({ servers, reconnect: true, timeoutMs: 10000 });
      state.sendPreparationMs = Date.now() - start;
      check(label + ': old readiness attempts to reconnect the failed MCP before input',
        state.offlineEvents.filter(item => item.method === 'initialize').length === 2 && state.reconnectFinishedAt);
      check(label + ': foreground reconnect delays input by the three-second failure', state.sendPreparationMs >= 2800);
      child.push('Search for the synthetic slow MCP and execute once.', { uuid: host.jobId });
    } else {
      const start = Date.now();
      await deadline(dispatch().done, label + ' dispatch');
      state.sendPreparationMs = Date.now() - start;
      check(label + ': dispatch promptly releases the composer', host.pendingInput === null && !state.failures.length);
    }
    await until(() => state.permissions.some(item => item.toolName === MCP_TOOL) || state.results.length || state.exit, label + ' MCP approval');
    if (state.toolSearchAvailable) check(label + ': ToolSearch discovers the slow MCP rather than returning an unknown tool',
      state.searchResult && !state.searchResult.is_error && JSON.stringify(state.searchResult).includes(MCP_TOOL));
    else check(label + ': first request contains the real slow MCP schema when ToolSearch is unavailable', state.directMcpAvailable);
    check(label + ': guarded MCP waits for explicit approval despite an allow rule',
      state.permissions.some(item => item.toolName === MCP_TOOL) && state.calls.length === 0 && state.results.length === 0);
    if (legacy) check(label + ': first API starts after the offline reconnect settles', state.firstApiAt >= state.reconnectFinishedAt);
    else {
      check(label + ': first API does not wait for the offline reconnect',
        !state.reconnectFinishedAt || state.firstApiAt < state.reconnectFinishedAt);
      check(label + ': failed MCP remains visible alongside the connected MCP',
        state.statuses.some(value => value.code === 'MCP_NOT_READY' && value.items.some(item => item.name === 'offline' && item.status === 'failed')
          && value.items.some(item => item.name === 'slow' && item.status === 'connected')));
    }
    approval.resolve();
    await until(() => state.results.length, label + ' synthetic result');
    check(label + ': real HTTP MCP executes once and returns its marker to the model', state.calls.length === 1 && state.modelSawMarker);
    check(label + ': tool-enabled turn completes without an SDK error', !state.results[0].is_error && /fixture completed/.test(state.results[0].result));
    if (host.mcpBackgroundPreparation) await deadline(host.mcpBackgroundPreparation, label + ' background completion');
    if (!legacy) {
      check(label + ': background reconnect settles without losing the connected MCP',
        state.reconnectFinishedAt && state.statuses.filter(value => value.phase === 'settled').length >= 2
        && state.statuses.at(-1).items.some(item => item.name === 'slow' && item.status === 'connected'));
      check(label + ': first API saves a material part of the offline reconnect delay', state.reconnectFinishedAt - state.firstApiAt >= 1500);
      state.phase = 'denied'; state.phaseRequests = 0; host.jobId = randomUUID();
      await dispatch().done;
      await until(() => state.results.length === 2, label + ' rejected operation');
      check(label + ': subsequent explicit denial cannot execute the MCP', state.calls.length === 1 && state.permissions.some(item => item.phase === 'denied'));
      check(label + ': denied tool result is returned to the model', state.requests.some(item => item.phase === 'denied' && item.toolResults.some(block => block.is_error)));
    }
    check(label + ': every model call uses only the synthetic loopback identity', state.requests.every(item => item.correctCredential && item.model === 'claude-sonnet-4-6'));
    check(label + ': background monitoring does not restart its MCP transport', state.mcpEvents.filter(item => item.method === 'initialize').length === 1);
  } finally { host.dead = true; approval.resolve(); await deadline(child.kill(), label + ' close'); currentSession = null; }
}
async function cancellation() {
  const { state, child, host, dispatch } = create('cancel-before-send');
  try {
    await child.whenReady();
    const modeGate = deferred();
    const pending = dispatch({ prepareInput: async () => modeGate.promise });
    await until(() => state.initializeStartedAt, 'canceled MCP initialize began');
    check('cancellation: input remains pending while execution mode is preparing', host.pendingInput === pending);
    check('cancellation: cancel succeeds before sending', cancelPendingLiveInput(host));
    modeGate.resolve(); await pending.done;
    await until(() => state.initializeFinishedAt, 'canceled slow initialization settles');
    await sleep(200);
    check('cancellation: a late MCP connection cannot deliver canceled input', state.requests.length === 0 && state.calls.length === 0);
    check('cancellation: no background readiness is installed for a canceled input', !host.mcpBackgroundPreparation);
  } finally { host.dead = true; await deadline(child.kill(), 'canceled close'); currentSession = null; }
}
(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const parts = req.url.split('/'), state = states.get(parts[2]);
      if (!state) return replyJson(res, {}, 404);
      let body; try { body = JSON.parse(raw || '{}'); } catch (_) { return replyJson(res, {}, 400); }
      if (parts[1] === 'mcp') { serveMcp(state, req, res, body).catch(error => { state.serverError = String(error); replyJson(res, {}, 500); }); return; }
      if (parts[1] === 'offline') { serveOfflineMcp(state, req, res, body).catch(error => { state.serverError = String(error); replyJson(res, {}, 500); }); return; }
      if (req.url.includes('/count_tokens')) return replyJson(res, { input_tokens: 20 });
      if (parts[1] === 'api' && req.url.includes('/messages')) return serveApi(state, req, res, body);
      replyJson(res, {}, 404);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await exercise('legacy-foreground-reconnect', true);
  await exercise('background-reconnect-dispatch', false);
  await cancellation();
  const [legacy, quick] = report.scenarios;
  report.comparison = { legacyPreparationMs: legacy.sendPreparationMs, quickPreparationMs: quick.sendPreparationMs,
    savedPreparationMs: legacy.sendPreparationMs - quick.sendPreparationMs,
    firstApiBeforeOfflineReconnectSettlesMs: quick.reconnectFinishedAt - quick.firstApiAt };
  check('background reconnect eliminates avoidable input delay from an already-failed MCP', report.comparison.savedPreparationMs >= 1500);
  report.ok = true;
})().catch(error => { report.ok = false; report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; })
  .finally(async () => {
    if (currentSession) await currentSession.kill();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    let cleanupError;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); cleanupError = null; break; }
      catch (error) { cleanupError = error; await sleep(100); }
    }
    report.cleanedUp = !cleanupError;
    if (cleanupError) { report.ok = false; report.cleanupError = cleanupError.code; process.exitCode = 1; }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, comparison: report.comparison, error: report.error }, null, 2));
  });
