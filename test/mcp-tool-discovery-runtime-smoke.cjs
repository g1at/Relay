'use strict';

// Explicit, finite Windows/Electron acceptance. All model replies and tools are
// local fixtures; no user profile, MCP configuration, or real provider is used.
if (!process.argv.includes('--run')) {
  console.log('Opt-in only: ELECTRON_RUN_AS_NODE=1 electron test/mcp-tool-discovery-runtime-smoke.cjs --run');
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
// Keep each acceptance run in an explicit, isolated evidence directory.
const outputArgument = process.argv.find(argument => argument.startsWith('--output-dir='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length))
  : path.resolve(__dirname, '../.codex-tmp/tool-context-2026-10-14/production-runtime');
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
const useWsl = process.argv.includes('--wsl');
const deferredStartup = process.argv.includes('--deferred');
let environmentAdapter;
if (useWsl) {
  const { createAgentEnvironment } = require('../src/main/sdk/agent-environment');
  environmentAdapter = createAgentEnvironment({ configDir: config, homeDir: home, getEnvironment: () => 'wsl' });
  relay.configureRuntimeEnvironment(environmentAdapter);
}
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const report = { ok: false, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), environment: useWsl ? 'wsl' : 'native', electron: process.versions.electron, node: process.versions.node,
  isolation: { cleanHostHome: true, linuxHomeInherited: useWsl, cleanConfig: true, cleanCwd: true, settingSources: [], strictMcpConfig: true },
  modelRequests: [], checks: [], errors: [], lifecycle: [] };
const marker = path.join(root, 'host-protocol.jsonl'), hostScript = path.join(root, 'host-mcp.cjs');
const fixtureTools = ['echo', 'other', 'blocked', ...Array.from({ length: 17 }, (_, i) => 'fixture_' + i)]
  .map(name => ({ name, description: 'Isolated discovery fixture ' + name,
    inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'Original value to return. '.repeat(32) } },
      required: ['value'], additionalProperties: false } }));
report.originalSchemaBytes = Buffer.byteLength(JSON.stringify(fixtureTools));
fs.writeFileSync(hostScript, `'use strict';
const fs = require('node:fs'), readline = require('node:readline');
const record = value => fs.appendFileSync(process.env.RELAY_MCP_MARKER, JSON.stringify(value) + '\\n');
record({ type: 'start', pid: process.pid });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const tools = ${JSON.stringify(fixtureTools)};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); record({ type: 'method', method: message.method || 'response' });
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture-host', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call' && tools.some(tool => tool.name === message.params.name)) {
    record({ type: 'tool', name: message.params.name, input: message.params.arguments });
    result = { content: [{ type: 'text', text: 'OK ' + message.params.name }] };
  } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }); return; }
  send({ jsonrpc: '2.0', id: message.id, result });
});
`);

let hostServers = bridgeMcpServers({ host: { command: process.execPath, args: [hostScript],
  env: { ...process.env, RELAY_MCP_MARKER: marker }, timeout: 5000 } }, { cwd, connectTimeoutMs: 5000, deferConnect: deferredStartup });
let hostBridge = hostServers.host.instance;
let session, deadline, confirmed = false, hostPid, wslForwarder;
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
  if (wslForwarder && wslForwarder.exitCode === null) try { wslForwarder.kill(); } catch (_) {}
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
      report.modelRequests.push({ atMs: elapsed(), model: body.model, names, schemaBytes: Buffer.byteLength(JSON.stringify(body.tools || [])), results: completed.map(block => ({ id: block.tool_use_id, isError: block.is_error === true })) });
      assert.ok(report.modelRequests.length <= 8, 'Model request count exceeds the bounded fixture');
      assert.ok(!(body.tools || []).some(tool => tool.type?.includes('tool_search')));
      assert.ok(!allBlocks.some(block => JSON.stringify(block).includes('tool_reference')));
      assert.equal(request.headers['x-api-key'], 'synthetic-mcp-key');
      assert.equal(body.model, 'fixture-mcp-model');
      const index = report.modelRequests.length, done = index >= 7;
      const discovery = names.find(name => name.startsWith('mcp__host__relay_search_tools'));
      assert.ok(discovery, 'Discovery endpoint remains visible');
      let blocks;
      const discover = (name, id) => [{ type: 'tool_use', id, name: discovery, input: { names: [name] } }];
      const call = (name, value) => [{ type: 'tool_use', id: 'tool_' + name, name: 'mcp__host__' + name, input: { value } }];
      if (index === 1) {
        assert.deepEqual(deferredStartup ? names.filter(name => name.startsWith('mcp__host__')) : names, [discovery]);
        if (deferredStartup) assert.equal(fs.existsSync(marker), false, 'First API arrives before any upstream process starts');
        assert.ok(report.modelRequests[0].schemaBytes < report.originalSchemaBytes / 4);
        blocks = discover('echo', 'discover_echo');
      } else if (index === 2) {
        assert.ok(names.includes('mcp__host__echo'), 'New schema must be visible before the next model request');
        blocks = call('echo', 'one');
      } else if (index === 3) blocks = discover('other', 'discover_other');
      else if (index === 4) {
        assert.ok(names.includes('mcp__host__other')); blocks = call('other', 'two');
      } else if (index === 5) blocks = discover('blocked', 'discover_blocked');
      else if (index === 6) {
        assert.ok(names.includes('mcp__host__blocked')); blocks = call('blocked', 'must not execute');
      } else {
        if (index === 7) {
          assert.equal(completed.length, 6); assert.equal(completed.filter(item => item.is_error).length, 1);
          assert.equal(completed.find(item => item.tool_use_id === 'tool_blocked')?.is_error, true);
        } else {
          assert.deepEqual(deferredStartup ? names.filter(name => name.startsWith('mcp__host__')) : names, [discovery], 'Fresh Query resumes history without rehydrating omitted schemas');
          report.resumedHistoryMessages = (body.messages || []).length;
          assert.ok(report.resumedHistoryMessages > 2);
        }
        blocks = [{ type: 'text', text: 'MCP_READY' }];
      }
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
          ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
      send('message_stop', { type: 'message_stop' }); response.end();
    } catch (error) { recordFailure(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
});
// WSL NAT does not expose a Windows loopback listener as Linux 127.0.0.1.
// Keep both listeners on loopback and carry this fixture's HTTP messages over
// one owned stdio process, so no LAN port or real gateway is involved.
async function startWslLoopbackGateway(targetPort) {
  const { spawn } = require('node:child_process');
  const { toWslPath } = require('../src/main/sdk/agent-environment');
  const info = await environmentAdapter.probe({ runtimeOnly: true });
  assert.equal(info.available, true, info.reason);
  const file = path.join(root, 'wsl-loopback-gateway.py');
  fs.writeFileSync(file, `import base64,http.server,json,queue,sys,threading
responses=queue.Queue()
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_CONNECT(self):
  self.send_response(403);self.end_headers()
 def do_POST(self):
  raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
  print(json.dumps({'url':self.path,'headers':{'content-type':self.headers.get('content-type','application/json'),'x-api-key':self.headers.get('x-api-key','')},'body':base64.b64encode(raw).decode()}),flush=True)
  answer=responses.get(timeout=15)
  self.send_response(answer['status']);self.send_header('Content-Type',answer['contentType']);self.end_headers()
  self.wfile.write(base64.b64decode(answer['body']));self.wfile.flush()
s=http.server.HTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'port':s.server_port}),flush=True)
threading.Thread(target=s.serve_forever,daemon=True).start()
for line in sys.stdin:
 responses.put(json.loads(line))
s.shutdown()
`);
  wslForwarder = spawn(info.wslExecutable, ['--distribution', info.wslDistribution, '--exec', 'python3', '-u', toWslPath(file)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  wslForwarder.stderr.on('data', chunk => { report.wslGatewayStderr = (report.wslGatewayStderr || '') + chunk.toString(); });
  return new Promise((resolve, reject) => {
    let pending = '', ready = false;
    const timer = setTimeout(() => reject(Error('WSL fixture gateway startup timed out')), 10000);
    wslForwarder.once('error', reject);
    wslForwarder.once('exit', code => { if (!ready) reject(Error('WSL fixture gateway stopped: ' + code)); });
    wslForwarder.stdout.on('data', chunk => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch (error) { recordFailure(error); continue; }
        if (message.port) { clearTimeout(timer); ready = true; resolve('http://127.0.0.1:' + message.port); continue; }
        const request = http.request({ hostname: '127.0.0.1', port: targetPort, path: message.url, method: 'POST', headers: message.headers }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => { if (!wslForwarder.stdin.destroyed) wslForwarder.stdin.write(JSON.stringify({ status: response.statusCode,
            contentType: response.headers['content-type'] || 'application/json', body: Buffer.concat(chunks).toString('base64') }) + '\n'); });
        });
        request.on('error', recordFailure); request.end(Buffer.from(message.body, 'base64'));
      }
    });
  });
}

async function stopWslLoopbackGateway() {
  if (!wslForwarder || wslForwarder.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { wslForwarder.kill(); resolve(); }, 2000);
    wslForwarder.once('exit', () => { clearTimeout(timer); resolve(); });
    wslForwarder.stdin.end();
  });
}

const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });

async function run() {
  deadline = setTimeout(() => { recordFailure('45-second fixture deadline'); emergencyStop(); save(); process.exit(1); }, 45000);
  try {
    await listen(proxy); await listen(server);
    const fixtureBaseUrl = useWsl ? await startWslLoopbackGateway(server.address().port) : 'http://127.0.0.1:' + server.address().port;
    const proxyUrl = useWsl ? fixtureBaseUrl : 'http://127.0.0.1:' + proxy.address().port;
    const runtimeEnv = { ...process.env, ...(useWsl ? { RELAY_AGENT_ENVIRONMENT: 'wsl' } : {}), ANTHROPIC_API_KEY: 'synthetic-mcp-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: fixtureBaseUrl, ANTHROPIC_MODEL: 'fixture-mcp-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', CLAUDE_CODE_TMPDIR: temp,
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const sessionParams = { cwd, model: 'fixture-mcp-model', runtimeEnv, tools: [], includeRelayInstructions: false,
      mcpServers: {}, mcpServersFactory: () => hostServers,
      runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: true, maxTurns: 10 } },
      mcpPermissionOverrides: { host: 'default' },
      onToolProposal: async input => { (report.hooks ||= []).push({ name: input.tool_name, input: input.tool_input }); return {}; },
      canUseTool: async (name, input) => {
        (report.approvals ||= []).push({ name, input });
        return name === 'mcp__host__blocked' ? { behavior: 'deny', message: 'Synthetic denial' }
          : { behavior: 'allow', updatedInput: input };
      },
      onMessage(event) { if (event.type === 'result') { report.lastResult = { isError: event.is_error, result: event.result }; resolveResult(event); } },
      onExit(exitCode) { report.lifecycle.push({ event: 'relay-onExit', exitCode, atMs: elapsed() }); },
    };
    session = relay.createLiveSession(sessionParams);
    session.whenClosed().then(value => { confirmed = value.stopConfirmed === true; report.closed = { ...value, error: value.error ? '[fixture error]' : null }; });
    await session.whenReady({ timeoutMs: 12000 });
    assert.equal(session.push('Discover and call only the local fixture tools.', { uuid: randomUUID() }), true);
    const result = await resultPromise;
    assert.equal(result.is_error, false); assert.equal(result.result, 'MCP_READY');
    assert.match(result.session_id, /^[0-9a-f-]{36}$/i);
    for (const [name, value] of [['echo', 'one'], ['other', 'two'], ['blocked', 'must not execute']]) {
      assert.ok(report.hooks.some(item => item.name === 'mcp__host__' + name && item.input.value === value));
      assert.ok(report.approvals.some(item => item.name === 'mcp__host__' + name && item.input.value === value));
    }
    const records = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    hostPid = records.find(item => item.type === 'start').pid;
    assert.deepEqual(records.filter(item => item.type === 'tool').map(item => ({ name: item.name, input: item.input })),
      [{ name: 'echo', input: { value: 'one' } }, { name: 'other', input: { value: 'two' } }]);
    report.checks.push('Twenty original schemas initially collapse to one discovery tool; each selection is available in the next actual request');
    report.checks.push('Original input/name reach PreToolUse and canUseTool; denied original call never reaches upstream MCP');
    report.checks.push('Local Anthropic-compatible gateway uses ordinary tools only, without tool_reference or native tool-search types');
    const firstClosed = await session.kill(); assert.equal(firstClosed.stopConfirmed, true); await hostBridge.close();
    assert.equal(alive(hostPid), false);
    confirmed = false; hostPid = null;
    hostServers = bridgeMcpServers({ host: { command: process.execPath, args: [hostScript],
      env: { ...process.env, RELAY_MCP_MARKER: marker }, timeout: 5000 } }, { cwd, connectTimeoutMs: 5000, deferConnect: deferredStartup });
    hostBridge = hostServers.host.instance;
    const resumedResult = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    resumedResult.catch(() => {});
    session = relay.createLiveSession({ ...sessionParams, sessionId: result.session_id });
    session.whenClosed().then(value => { confirmed = value.stopConfirmed === true; report.resumedClosed = value; });
    await session.whenReady({ timeoutMs: 12000 });
    session.push('Continue the preserved isolated history.', { uuid: randomUUID() });
    const resumed = await resumedResult;
    assert.equal(resumed.is_error, false); assert.equal(resumed.result, 'MCP_READY'); assert.equal(resumed.session_id, result.session_id);
    const statuses = await session.mcpServerStatus();
    report.statuses = statuses.map(item => ({ name: item.name, status: item.status, tools: item.tools?.map(tool => tool.name) }));
    assert.ok(statuses.some(item => item.name === 'host' && item.status === (deferredStartup ? 'deferred' : 'connected')));
    const allRecords = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const starts = allRecords.filter(item => item.type === 'start'); assert.equal(starts.length, deferredStartup ? 1 : 2); hostPid = starts.at(-1).pid;
    const closed = await session.kill(); assert.equal(closed.stopConfirmed, true); await hostBridge.close();
    assert.ok(starts.every(item => !alive(item.pid)));
    assert.equal(report.lifecycle.filter(item => item.event === 'relay-onExit').length, 2);
    report.checks.push('Fresh native Query resumes the same persisted session/history with only discovery advertised again');
    assert.equal(report.modelRequests.length, 8);
    report.checks.push('Both owned native processes and MCP children stop; no real provider, profile or user MCP is used');
    if (deferredStartup) report.checks.push('Deferred MCP does not spawn before the first model request or on a plain-text resumed turn');
    report.deferredStartup = deferredStartup;
    report.ok = true;
  } catch (error) { recordFailure(error); process.exitCode = 1; }
  finally {
    if (session && !confirmed) { session.kill(); emergencyStop(); await session.whenClosed(); }
    await hostBridge.close();
    await stopWslLoopbackGateway();
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    relay.configureRuntimeEnvironment(null);
    clearTimeout(deadline); save();
    console.log(JSON.stringify({ ok: report.ok, elapsedMs: report.elapsedMs, closed: report.closed,
      checks: report.checks, errors: report.errors }, null, 2));
  }
}
run().catch(error => { recordFailure(error); emergencyStop(); save(); process.exit(1); });
