'use strict';

// Native SDK acceptance with a local model: persist a real legacy discovery,
// recreate both Query and MCP bridge, reject that old name, then rediscover and
// execute the original tool. The optional real server permits user_info only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

if (process.argv.includes('--mcp-child')) {
  const record = value => fs.appendFileSync(process.env.RELAY_RESUME_MARKER,
    JSON.stringify({ ...value, pid: process.pid }) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  record({ event: 'start' });
  const tools = ['echo', ...Array.from({ length: 19 }, (_, i) => 'fixture_' + i)].map(name => ({
    name, description: 'Isolated resume fixture ' + name,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  }));
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    record({ event: 'method', method: message.method });
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'resume-fixture', version: '1.0.0' } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call' && tools.some(tool => tool.name === message.params.name)) {
      record({ event: 'call', name: message.params.name, input: message.params.arguments });
      result = { content: [{ type: 'text', text: 'RESUME_ECHO ' + message.params.arguments.value }] };
    } else return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
    send({ jsonrpc: '2.0', id: message.id, result });
  }).on('close', () => process.exit(0));
} else if (!process.argv.includes('--run')) {
  console.log('Opt-in: ELECTRON_RUN_AS_NODE=1 electron test/mcp-resume-discovery-runtime-smoke.cjs --run [--output-dir=PATH] [--feishu-config=PATH]');
} else {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  assert.equal(process.platform, 'win32', 'This acceptance requires the native Windows SDK');
  assert.ok(process.versions.electron, 'Use Relay Electron with ELECTRON_RUN_AS_NODE=1');
  assert.notEqual(process.type, 'browser');
  const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
  const output = path.resolve(argument('--output-dir') || path.join(__dirname, '../.codex-tmp/mcp-resume-discovery'));
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'isolated-'));
  const home = path.join(root, 'home'), config = path.join(root, 'config'), cwd = path.join(root, 'workspace'), temp = path.join(root, 'temp');
  const roaming = path.join(home, 'AppData/Roaming'), local = path.join(home, 'AppData/Local');
  for (const dir of [home, config, cwd, temp, roaming, local]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  const originalEnv = { ...process.env };
  // Use an explicit configuration only. The model/SDK never receives real
  // model credentials, user settings, or a real business-write operation.
  const realConfigFile = argument('--feishu-config');
  const realConfig = realConfigFile ? JSON.parse(fs.readFileSync(path.resolve(realConfigFile), 'utf8')) : null;
  const realServer = realConfig && (realConfig.mcpServers?.['feishu-mcp-pro'] || realConfig['feishu-mcp-pro']);
  if (realConfig) assert.ok(realServer?.command && !realServer.url, 'Explicit Feishu config must contain a stdio feishu-mcp-pro server');
  const serverName = realServer ? 'feishu-mcp-pro' : 'host';
  const originalName = realServer ? 'user_info' : 'echo';
  const qualifiedOriginal = 'mcp__' + serverName + '__' + originalName;
  const inherited = Object.fromEntries(Object.entries(originalEnv).filter(([key]) =>
    /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    CLAUDE_CONFIG_DIR: config, TEMP: temp, TMP: temp, TMPDIR: temp, ELECTRON_RUN_AS_NODE: '1' });
  const relay = require('../src/main/sdk/claude-sdk');
  const { createAgentEnvironment } = require('../src/main/sdk/agent-environment');
  const { getHostMcpLoopbackOwner } = require('../src/main/sdk/host-mcp-loopback');
  const { McpToolCatalog } = require('../src/main/sdk/mcp-tool-catalog');
  const { createHostStdioTransport } = require('../src/main/sdk/host-stdio-transport');
  const { dispatchLiveInput } = require('../src/main/live/live-mcp-dispatch');
  const marker = path.join(root, 'protocol.jsonl');
  const legacyName = 'relay_search_tools_' + randomUUID().replace(/-/g, '');
  const qualifiedLegacy = 'mcp__' + serverName + '__' + legacyName;
  const report = { ok: false, createdAt: new Date().toISOString(), platform: process.platform,
    sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(),
    electron: process.versions.electron, scope: realServer ? 'Synthetic model; real Feishu user_info only' : 'Synthetic model and stdio MCP',
    checks: [], rounds: [], errors: [], blockedExternalRequests: 0 };
  let active, hardDeadline;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const records = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const check = (label, condition) => { assert.ok(condition, label); report.checks.push(label); };
  const redact = value => String(value).replace(/(Bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?secret|authorization|password|_authToken)\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1<redacted>');
  const validUserInfo = (value, depth = 0) => {
    if (depth > 5 || value == null) return false;
    if (typeof value === 'string') {
      try { return validUserInfo(JSON.parse(value), depth + 1); } catch (_) { return false; }
    }
    if (Array.isArray(value)) return value.some(item => validUserInfo(item, depth + 1));
    if (typeof value !== 'object') return false;
    return typeof value.open_id === 'string' && /^ou_[a-zA-Z0-9]+$/.test(value.open_id)
      || value.type === 'text' && validUserInfo(value.text, depth + 1);
  };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  async function deadline(promise, label, milliseconds = 20000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  function stream(response, body, blocks) {
    const done = blocks.every(block => block.type !== 'tool_use');
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    send('message_start', { type: 'message_start', message });
    blocks.forEach((block, index) => {
      send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : { ...block, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
        ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } });
    send('message_stop', { type: 'message_stop' }); response.end();
  }
  const proxy = http.createServer((_request, response) => { report.blockedExternalRequests++; response.writeHead(403); response.end(); });
  proxy.on('connect', (_request, socket) => { report.blockedExternalRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const gateway = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 2 * 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      try {
        if (request.url.includes('/count_tokens')) { response.end('{"input_tokens":20}'); return; }
        assert.ok(request.url.includes('/messages'), 'Only local message requests are supported');
        const body = JSON.parse(raw), state = active.state;
        assert.equal(request.headers['x-api-key'], 'synthetic-resume-key');
        assert.equal(body.model, 'fixture-resume-model');
        const names = (body.tools || []).map(tool => tool.name), messages = body.messages || [];
        const serialized = JSON.stringify(messages);
        const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const results = blocks.filter(block => block.type === 'tool_result');
        const discovery = names.find(name => name.startsWith('mcp__' + serverName + '__relay_search_tools'));
        assert.ok(discovery, 'Current discovery endpoint is advertised');
        const index = state.requests.length, rejectionStep = state.index === 1;
        state.requests.push({ names, discovery, originalVisible: names.includes(qualifiedOriginal),
          historyContainsLegacy: serialized.includes(qualifiedLegacy), errorResults: results.filter(block => block.is_error === true).length });
        assert.ok(index < (rejectionStep ? 4 : 3), 'Bounded model requests per Query');
        if (index === 0) {
          assert.ok(!names.includes(qualifiedOriginal), 'Original schema must be rediscovered in each fresh Query');
          assert.equal(discovery, 'mcp__' + serverName + '__' + state.discoveryName);
          state.discovery = discovery;
          if (state.index) {
            state.legacySystemSnapshotPreserved = JSON.stringify(body.system).includes('LEGACY_MCP_SNAPSHOT');
            assert.ok(state.legacySystemSnapshotPreserved, 'Native resume retains the legacy system-prompt snapshot');
            assert.ok(serialized.includes(qualifiedLegacy), 'Actual legacy call survives in SDK history');
            assert.ok(!names.includes(qualifiedLegacy), 'Legacy discovery is not advertised as current');
            const guidanceIndex = messages.findLastIndex(message => {
              const text = JSON.stringify(message.content);
              return text.includes(discovery) && text.includes('[Relay MCP 工具发现]');
            });
            state.currentGuidanceInNewInput = guidanceIndex > messages.findLastIndex(message => message.role === 'assistant');
            assert.ok(state.currentGuidanceInNewInput, 'UserPromptSubmit injects current discovery guidance after the preserved assistant history');
          }
        }
        let step = index;
        if (rejectionStep) {
          if (index === 0) return stream(response, body, [{ type: 'tool_use', id: 'legacy_rejected', name: qualifiedLegacy, input: { names: [originalName] } }]);
          if (index === 1) {
            const rejected = results.find(block => block.tool_use_id === 'legacy_rejected');
            assert.ok(rejected?.is_error, 'Stale discovery fails explicitly before recovery');
            assert.ok(JSON.stringify(rejected.content).includes('No such tool available'), 'Stale name is rejected by SDK tool resolution');
            state.legacyRejected = true;
          }
          step--;
        }
        let answer;
        if (step === 0) answer = [{ type: 'tool_use', id: 'discover_' + state.index, name: discovery, input: { names: [originalName] } }];
        else if (step === 1) {
          const discovered = results.find(block => block.tool_use_id === 'discover_' + state.index);
          if (discovered?.is_error) state.discoveryError = redact(JSON.stringify(discovered.content)).slice(0, 2000);
          assert.ok(discovered && !discovered.is_error, 'Discovery returns a successful tool result');
          assert.ok(names.includes(qualifiedOriginal), 'Rediscovered original schema reaches the next actual model request');
          answer = [{ type: 'tool_use', id: 'original_' + state.index, name: qualifiedOriginal, input: realServer ? {} : { value: 'round_' + state.index } }];
        } else {
          const result = results.find(block => block.tool_use_id === 'original_' + state.index);
          assert.ok(result && !result.is_error, 'Original tool result reaches the resumed model');
          const content = JSON.stringify(result.content);
          if (realServer) assert.ok(validUserInfo(result.content), 'Actual user_info returns a valid user identity');
          else assert.ok(content.includes('RESUME_ECHO round_' + state.index), 'Result came from the actual new upstream process');
          state.originalResultVerified = true;
          answer = [{ type: 'text', text: 'RESUME_DONE_' + state.index }];
        }
        stream(response, body, answer);
      } catch (error) {
        report.errors.push(error.stack || String(error)); active?.reject(error);
        if (!response.headersSent) response.writeHead(500); response.end();
      }
    });
  });
  const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });
  async function stopActive() {
    if (!active) return;
    const current = active;
    const receipt = await deadline(current.child.kill(), 'native Query close');
    await Promise.allSettled(current.owners.map(owner => owner.close()));
    check('round ' + current.state.index + ': owned native Query exits', receipt.stopConfirmed && !alive(current.child.pid));
    const upstream = current.state.upstreamClosures || [];
    check('round ' + current.state.index + ': owned MCP process tree exits', upstream.length > 0
      && upstream.every(item => item.stopConfirmed && item.activeProcesses === 0 && item.pendingExits === 0));
    active = null; relay.configureRuntimeEnvironment(null);
  }
  try {
    hardDeadline = setTimeout(() => { report.errors.push('90-second acceptance deadline'); save(); if (active?.child.pid) try { process.kill(active.child.pid, 'SIGKILL'); } catch (_) {} process.exit(1); }, 90000);
    await listen(proxy); await listen(gateway);
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    const runtimeEnv = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-resume-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + gateway.address().port, ANTHROPIC_MODEL: 'fixture-resume-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true', CLAUDE_CODE_TMPDIR: temp,
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const rawServers = { [serverName]: realServer ? { ...realServer, env: { ...originalEnv, ...realServer.env } }
      : { command: process.execPath, args: [__filename, '--mcp-child'], timeout: 5000, env: { ...runtimeEnv, RELAY_RESUME_MARKER: marker } } };
    let sessionId;
    for (let index = 0; index < 3; index++) {
      const state = { index, legacy: index === 0, requests: [], approvals: [], proposals: [], statuses: [] };
      report.rounds.push(state);
      const owners = [];
      const adapter = createAgentEnvironment({ configDir: config, homeDir: home, getEnvironment: () => 'native' });
      const prepare = adapter.prepareOptions.bind(adapter);
      adapter.prepareOptions = async (...args) => {
        const prepared = await prepare(...args), mapped = prepared.mcpServers[serverName];
        const owner = getHostMcpLoopbackOwner(mapped) || mapped.instance, bridge = owner.instance || owner;
        owners.push(owner);
        state.upstreamClosures = [];
        bridge.options.createTransport = params => {
          const transport = createHostStdioTransport(params);
          transport.stderr?.on('data', chunk => { state.upstreamStderr = redact((state.upstreamStderr || '') + chunk.toString()).slice(-3000); });
          const close = transport.close.bind(transport);
          transport.close = async () => {
            const receipt = await close();
            if (receipt) state.upstreamClosures.push({ stopConfirmed: receipt.stopConfirmed,
              activeProcesses: receipt.activeProcesses, pendingExits: receipt.pendingExits });
            return receipt;
          };
          return transport;
        };
        if (!index) {
          // Produce an actual legacy transcript with this isolated catalog.
          bridge.toolCatalog = new McpToolCatalog({ serverName, lazyToolBytes: 1 });
          bridge.toolCatalog.preferredDiscoveryName = legacyName;
          bridge.discoveryName = legacyName;
          bridge.resetDeferredCatalog();
        }
        state.discoveryName = bridge.discoveryName;
        return prepared;
      };
      relay.configureRuntimeEnvironment(adapter);
      let resolve, reject;
      const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
      completion.catch(() => {});
      const child = relay.createLiveSession({ cwd, sessionId, model: 'fixture-resume-model', runtimeEnv, tools: [],
        appendSystemPrompt: index === 0
          ? 'LEGACY_MCP_SNAPSHOT: synthetic old instruction says missing tools can be called directly and retried unchanged.'
          : 'CURRENT_MCP_SNAPSHOT: use current discovery before calling an unavailable original tool.',
        includeRelayInstructions: false, permissionMode: 'default', mcpServers: rawServers,
        mcpPermissionOverrides: { [serverName]: 'default' },
        runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: true, maxTurns: 6 } },
        onToolProposal: async input => { state.proposals.push(input.tool_name); return {}; },
        canUseTool: async (name, input) => { state.approvals.push(name); return { behavior: 'allow', updatedInput: input }; },
        onMessage(event) { if (event.type === 'result') resolve(event); },
        onExit(code, error) { state.closed = { code, error: error ? String(error) : null }; },
      });
      active = { state, child, owners, reject };
      const host = { child, jobId: randomUUID(), busy: true, dead: false };
      const pending = dispatchLiveInput({ session: host, jobId: host.jobId, prompt: 'RESUME_DISCOVERY_ROUND_' + index + ': discover and call the read-only fixture once.',
        prepareInput: signal => child.prepareExecutionMode({ kind: 'default' }, { permissionMode: 'default', signal }),
        loadServers: () => rawServers, isSessionCurrent: () => !host.dead,
        onStatus: status => state.statuses.push({ phase: status.phase, ok: status.ok }),
        onFailure: (message, detail) => reject(Error(message + ': ' + detail.code)),
      });
      await deadline(pending.done, 'round ' + index + ' dispatch');
      const result = await deadline(completion, 'round ' + index + ' rediscovery and original call', 30000);
      assert.equal(result.is_error, false); assert.equal(result.result, 'RESUME_DONE_' + index);
      assert.match(result.session_id, /^[0-9a-f-]{36}$/i);
      if (sessionId) assert.equal(result.session_id, sessionId, 'Fresh Query resumes the same persisted SDK identity');
      sessionId = result.session_id;
      check('round ' + index + ': rediscovery is followed by an actual original tool result', state.requests.length === (index === 1 ? 4 : 3) && state.originalResultVerified);
      check('round ' + index + ': original tool passes normal proposal and approval', state.approvals.includes(qualifiedOriginal) && state.proposals.includes(qualifiedOriginal));
      await stopActive();
    }
    check('stable discovery survives bridge and Query recreation', report.rounds[1].discovery === report.rounds[2].discovery && report.rounds[1].discovery !== report.rounds[0].discovery);
    check('recovery follows an explicit old-name failure', report.rounds[1].legacyRejected === true);
    if (!realServer) {
      const protocol = records(), starts = protocol.filter(item => item.event === 'start');
      assert.deepEqual(protocol.filter(item => item.event === 'call').map(item => ({ name: item.name, input: item.input })),
        [0, 1, 2].map(index => ({ name: 'echo', input: { value: 'round_' + index } })));
      const until = Date.now() + 5000;
      while (starts.some(item => alive(item.pid)) && Date.now() < until) await sleep(20);
      check('three original calls use fresh upstream processes and every child exits', starts.length === 3 && starts.every(item => !alive(item.pid)));
      report.protocol = protocol;
    }
    report.ok = true;
  } catch (error) {
    report.errors.push(error.stack || String(error)); process.exitCode = 1;
  } finally {
    await stopActive().catch(error => { report.errors.push(error.stack || String(error)); report.ok = false; process.exitCode = 1; });
    gateway.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    clearTimeout(hardDeadline); save();
    console.log(JSON.stringify({ ok: report.ok, rounds: report.rounds.length, checks: report.checks, errors: report.errors }, null, 2));
  }
}
