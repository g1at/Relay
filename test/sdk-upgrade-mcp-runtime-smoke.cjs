'use strict';

// Explicit, finite Windows/Electron acceptance. All model replies and tools are
// local fixtures; no user profile, MCP configuration, or real provider is used.
if (!process.argv.includes('--run')) {
  console.log('Opt-in only: ELECTRON_RUN_AS_NODE=1 electron test/sdk-upgrade-mcp-runtime-smoke.cjs --run');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

assert.equal(process.platform, 'win32');
assert.ok(process.versions.electron, 'Use Relay Electron with ELECTRON_RUN_AS_NODE=1');
assert.notEqual(process.type, 'browser', 'Electron must run in Node mode, not launch an application');
// Keep separate evidence directories when reviewing another SDK release.
const outputArgument = process.argv.find(argument => argument.startsWith('--output-dir='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length))
  : path.resolve(__dirname, '../.codex-tmp/sdk-upgrade-0.3.283-2026-09-28/mcp-runtime');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'isolated-'));
const home = path.join(root, 'home'), config = path.join(root, 'config');
const cwd = path.join(root, 'workspace'), temp = path.join(root, 'temp');
const roaming = path.join(home, 'AppData/Roaming'), local = path.join(home, 'AppData/Local');
for (const dir of [home, config, cwd, temp, roaming, local]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
  CLAUDE_CONFIG_DIR: config, TEMP: temp, TMP: temp, TMPDIR: temp, ELECTRON_RUN_AS_NODE: '1' });

const relay = require('../src/main/sdk/claude-sdk');
const { bridgeMcpServers } = require('../src/main/sdk/host-stdio-mcp');
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const report = { ok: false, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), electron: process.versions.electron, node: process.versions.node,
  isolation: { cleanHome: true, cleanConfig: true, cleanCwd: true, settingSources: [], strictMcpConfig: true },
  modelRequests: [], inlineToolCalls: 0, checks: [], errors: [], lifecycle: [] };
const marker = path.join(root, 'host-protocol.jsonl'), hostScript = path.join(root, 'host-mcp.cjs');
fs.writeFileSync(hostScript, `'use strict';
const fs = require('node:fs'), readline = require('node:readline');
const record = value => fs.appendFileSync(process.env.RELAY_MCP_MARKER, JSON.stringify(value) + '\\n');
record({ type: 'start', pid: process.pid });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); record({ type: 'method', method: message.method || 'response' });
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture-host', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Local acceptance fixture',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (message.method === 'tools/call' && message.params.name === 'echo') {
    record({ type: 'tool', name: 'echo' }); result = { content: [{ type: 'text', text: 'HOST_OK' }] };
  } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }); return; }
  send({ jsonrpc: '2.0', id: message.id, result });
});
`);

const hostServers = bridgeMcpServers({ host: { command: process.execPath, args: [hostScript],
  env: { ...process.env, RELAY_MCP_MARKER: marker }, timeout: 5000 } }, { cwd, connectTimeoutMs: 5000 });
const hostBridge = hostServers.host.instance;
let session, deadline, confirmed = false, hostPid;
let resolveResult, rejectResult;
const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
resultPromise.catch(() => {});
function recordFailure(error) {
  const message = error?.message || String(error);
  if (!report.errors.includes(message)) report.errors.push(message);
  if (error?.stack) report.lastErrorStack = error.stack;
  rejectResult(Error(message));
}
function save() { report.elapsedMs = elapsed(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
function emergencyStop() {
  // Only direct PIDs created by this fixture. No process-name lookup or tree kill.
  if (!confirmed && session?.pid) try { process.kill(session.pid, 'SIGKILL'); } catch (_) {}
  const ownHost = hostBridge.childTransport?.pid || hostPid;
  if (ownHost) try { process.kill(ownHost, 'SIGKILL'); } catch (_) {}
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
const proxy = http.createServer((_request, response) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; response.writeHead(403); response.end(); });
proxy.on('connect', (_request, socket) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (request.url.includes('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":20}'); return; }
      if (!request.url.includes('/messages')) { response.writeHead(404); response.end(); return; }
      const names = (body.tools || []).map(tool => tool.name);
      const allBlocks = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []);
      const completed = allBlocks.filter(block => block.type === 'tool_result');
      report.modelRequests.push({ atMs: elapsed(), model: body.model, names, results: completed.map(block => ({ id: block.tool_use_id, isError: block.is_error === true })) });
      assert.ok(report.modelRequests.length <= 3, 'Model request count exceeds the bounded fixture');
      assert.equal(request.headers['x-api-key'], 'synthetic-mcp-key');
      assert.equal(body.model, 'fixture-mcp-model');
      const done = completed.length > 0;
      if (done) {
        assert.equal(completed.length, 2); assert.ok(completed.every(block => block.is_error !== true));
        assert.ok(JSON.stringify(completed).includes('INLINE_OK')); assert.ok(JSON.stringify(completed).includes('HOST_OK'));
      } else {
        assert.ok(names.includes('mcp__inline__echo')); assert.ok(names.includes('mcp__host__echo'));
      }
      const blocks = done ? [{ type: 'text', text: 'MCP_READY' }] : ['inline', 'host'].map(name => ({
        type: 'tool_use', id: 'tool_' + name, name: 'mcp__' + name + '__echo', input: {},
      }));
      const usage = { input_tokens: 20, output_tokens: 6 };
      const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
        content: blocks, stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null, usage };
      if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      blocks.forEach((block, index) => {
        send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : { ...block, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
          ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: '{}' } });
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
      send('message_stop', { type: 'message_stop' }); response.end();
    } catch (error) { recordFailure(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
});
const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });

async function run() {
  deadline = setTimeout(() => { recordFailure('45-second fixture deadline'); emergencyStop(); save(); process.exit(1); }, 45000);
  try {
    await listen(proxy); await listen(server);
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    const runtimeEnv = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-mcp-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_MODEL: 'fixture-mcp-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', CLAUDE_CODE_TMPDIR: temp,
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    session = relay.createLiveSession({ cwd, model: 'fixture-mcp-model', runtimeEnv, tools: [], includeRelayInstructions: false,
      mcpServers: {}, mcpServersFactory: sdk => ({ ...hostServers, inline: sdk.createSdkMcpServer({ name: 'inline', version: '1.0.0',
        tools: [sdk.tool('echo', 'Local acceptance fixture', {}, async () => {
          report.inlineToolCalls++; return { content: [{ type: 'text', text: 'INLINE_OK' }] };
        })] }) }),
      runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: false, maxTurns: 3 } },
      canUseTool: async (name, input) => ['mcp__inline__echo', 'mcp__host__echo'].includes(name)
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only fixture tools are allowed' },
      onMessage(event) { if (event.type === 'result') resolveResult(event); },
      onExit(exitCode) { report.lifecycle.push({ event: 'relay-onExit', exitCode, atMs: elapsed() }); },
    });
    session.whenClosed().then(value => { confirmed = value.stopConfirmed === true; report.closed = { ...value, error: value.error ? '[fixture error]' : null }; });
    await session.whenReady({ timeoutMs: 12000 });
    assert.equal(session.push('Run the two local fixture tools and report completion.', { uuid: randomUUID() }), true);
    const result = await resultPromise;
    assert.equal(result.is_error, false); assert.equal(result.result, 'MCP_READY');
    assert.equal(report.inlineToolCalls, 1);
    const records = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const starts = records.filter(item => item.type === 'start');
    assert.equal(starts.length, 1); hostPid = starts[0].pid;
    assert.equal(records.filter(item => item.type === 'tool').length, 1);
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']) {
      assert.ok(records.some(item => item.type === 'method' && item.method === method), method);
    }
    report.host = { pid: hostPid, methods: records.filter(item => item.type === 'method').map(item => item.method), toolCalls: 1 };
    report.checks.push('New SDK inline MCP tool and Relay host-stdio bridge each execute exactly once');
    report.checks.push('Host MCP initialize, initialized, list and call all cross the actual SDK transport');
    const statuses = await session.mcpServerStatus();
    for (const name of ['inline', 'host']) assert.ok(statuses.some(item => item.name === name && item.status === 'connected'));
    report.statuses = statuses.map(item => ({ name: item.name, status: item.status, source: item.source }));
    const closed = await session.kill();
    assert.equal(closed.stopConfirmed, true); assert.ok(Number.isInteger(closed.nativeExitCode));
    await hostBridge.close();
    assert.equal(alive(hostPid), false);
    assert.equal(report.lifecycle.filter(item => item.event === 'relay-onExit').length, 1);
    report.checks.push('Relay confirms native CLI exit; owned MCP child is also no longer alive');
    assert.equal(report.modelRequests.length, 2);
    report.checks.push('Only two synthetic loopback model requests with successful results from both tools');
    report.ok = true;
  } catch (error) { recordFailure(error); process.exitCode = 1; }
  finally {
    if (session && !confirmed) { session.kill(); emergencyStop(); await session.whenClosed(); }
    await hostBridge.close();
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    clearTimeout(deadline); save();
    console.log(JSON.stringify({ ok: report.ok, elapsedMs: report.elapsedMs, closed: report.closed,
      checks: report.checks, errors: report.errors }, null, 2));
  }
}
run().catch(error => { recordFailure(error); emergencyStop(); save(); process.exit(1); });
