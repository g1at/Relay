'use strict';

// Opt-in finite native acceptance: actual Electron + SDK, synthetic stdio MCPs
// and a loopback model. This measures first response separately from tool work.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--mcp-child')) {
  const marker = process.env.RELAY_STARTUP_MARKER;
  const record = value => fs.appendFileSync(marker, JSON.stringify({ ...value, at: Date.now(), pid: process.pid }) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const tools = ['echo', 'blocked', ...Array.from({ length: 18 }, (_, index) => 'fixture_' + index)].map(name => ({
    name, description: 'Local startup fixture ' + name,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  }));
  record({ event: 'spawn' });
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    const message = JSON.parse(line);
    record({ event: 'request', method: message.method });
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') {
      await sleep(Number(process.env.RELAY_STARTUP_DELAY_MS || 0));
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'relay-startup-fixture', version: '1.0.0' } };
    } else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call' && tools.some(tool => tool.name === message.params.name)) {
      record({ event: 'tool', name: message.params.name, input: message.params.arguments });
      result = { content: [{ type: 'text', text: 'STARTUP_ECHO ' + message.params.arguments.value }] };
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
    record({ event: 'responded', method: message.method });
  }).on('close', () => process.exit(0));
} else if (!process.argv.includes('--run')) {
  console.log('Opt-in: ELECTRON_RUN_AS_NODE=1 electron test/sdk-deferred-mcp-startup-smoke.cjs --run [--output-dir=PATH] [--case=NAME]');
} else {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.versions.electron, 'Run the actual Relay Electron executable in Node mode');
  assert.notEqual(process.type, 'browser');
  const caseArgument = process.argv.find(argument => argument.startsWith('--case='));
  const selectedCase = caseArgument ? caseArgument.slice('--case='.length) : null;
  const outputArgument = process.argv.find(argument => argument.startsWith('--output-dir='));
  const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length))
    : path.resolve(__dirname, '../.codex-tmp/startup-latency-2026-10-14/final-native');
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'isolated-'));
  const home = path.join(root, 'home'), temp = path.join(root, 'temp'), config = path.join(root, 'config');
  for (const dir of [home, temp, config, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: config, ELECTRON_RUN_AS_NODE: '1' });

  const relay = require('../src/main/sdk/claude-sdk');
  const { createAgentEnvironment } = require('../src/main/sdk/agent-environment');
  const { dispatchLiveInput } = require('../src/main/live/live-mcp-dispatch');
  const report = { ok: false, createdAt: new Date().toISOString(), sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
    cli: relay.bundledClaudeVersion(), electron: process.versions.electron, node: process.versions.node,
    environment: 'native', modelReplyDelayMs: 50, checks: [], cases: [], errors: [], blockedExternalRequests: 0,
    scope: 'Production createAgentEnvironment, createLiveSession and dispatchLiveInput; only synthetic model/MCP, isolated configuration. First response and tool completion are separate measurements.' };
  const states = new Map();
  let active = null, hardDeadline;
  const now = () => performance.now();
  const round = value => Math.round(value * 10) / 10;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const records = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const check = (label, value) => { assert.ok(value, label); report.checks.push(label); };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  async function deadline(promise, label, timeoutMs = 20000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, timeoutMs = 20000) {
    const end = now() + timeoutMs;
    while (!predicate()) { if (now() >= end) throw Error('Timed out: ' + label); await sleep(10); }
  }
  function json(response, value, status = 200) {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  }
  function stream(response, body, blocks) {
    const stop = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: 20, output_tokens: 8 };
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
      content: blocks, stop_reason: stop, stop_sequence: null, usage };
    if (!body.stream) return json(response, message);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    blocks.forEach((block, index) => {
      send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text'
        ? { type: 'text', text: '' } : { ...block, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
        ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage });
    send('message_stop', { type: 'message_stop' }); response.end();
  }
  const proxy = http.createServer((_request, response) => { report.blockedExternalRequests++; json(response, {}, 403); });
  proxy.on('connect', (_request, socket) => { report.blockedExternalRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) request.destroy(); });
    request.on('end', async () => {
      try {
        const state = states.get(request.url.split('/')[1]);
        assert.ok(state, 'Known fixture route');
        if (request.url.includes('/count_tokens')) { state.tokenCountRequests++; return json(response, { input_tokens: 20 }); }
        if (!request.url.includes('/messages')) return json(response, {}, 404);
        const body = JSON.parse(raw);
        assert.equal(request.headers['x-api-key'], 'synthetic-startup-key');
        assert.equal(body.model, 'fixture-startup-model');
        const names = (body.tools || []).map(tool => tool.name);
        const results = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
        const index = state.requests.length;
        state.requests.push({ at: now(), tools: names, schemaBytes: Buffer.byteLength(JSON.stringify(body.tools || [])) });
        assert.ok(index < 3, 'At most three model requests per fixture');
        let blocks;
        if (index === 0) {
          const discovery = names.find(name => /^mcp__used__relay_search_tools(?:_[a-f0-9]+)?$/.test(name));
          assert.ok(discovery, 'Discovery tool is available on the first actual request');
          assert.ok(!names.includes('mcp__used__echo'), 'Unused original definitions stay deferred');
          state.firstApiUpstreamStarts = ['used', 'unused'].flatMap(name => records(state.markers[name]).filter(item => item.event === 'spawn').map(item => ({ name, pid: item.pid })));
          if (state.deferred) assert.equal(state.firstApiUpstreamStarts.length, 0, 'No upstream MCP spawned before first API');
          state.discovery = discovery;
          blocks = [{ type: 'text', text: 'STARTUP_BEGIN' },
            { type: 'tool_use', id: 'discover_' + state.name, name: discovery, input: { names: [state.denied ? 'blocked' : 'echo'] } }];
        } else if (state.canceled) {
          // The native SDK can issue one final model request while processing
          // teardown. Record it explicitly; never request a business action.
          state.postCancelModelRequests = (state.postCancelModelRequests || 0) + 1;
          blocks = [{ type: 'text', text: 'STARTUP_CANCELED' }];
        } else if (index === 1) {
          const name = state.denied ? 'blocked' : 'echo';
          assert.ok(names.includes('mcp__used__' + name), 'Original selected schema appears before the next API request');
          assert.ok(results.length && results.at(-1).is_error !== true, 'Discovery succeeds');
          blocks = [{ type: 'tool_use', id: 'business_' + state.name, name: 'mcp__used__' + name, input: { value: state.name } }];
        } else {
          if (state.denied) assert.equal(results.at(-1)?.is_error, true, 'Denied original tool returns an error to the model');
          else assert.ok(JSON.stringify(results).includes('STARTUP_ECHO ' + state.name), 'Real original MCP result reaches model');
          blocks = [{ type: 'text', text: 'STARTUP_DONE' }];
        }
        await sleep(report.modelReplyDelayMs);
        if (!response.destroyed) stream(response, body, blocks);
      } catch (error) {
        report.errors.push(error.stack || String(error));
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
  });
  const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });
  function create(name, { deferred = true, unusedDelayMs = 0, usedDelayMs = 0, denied = false, canceled = false, reconnect = false } = {}) {
    assert.equal(active, null, 'Only one native scenario at a time');
    const dir = path.join(root, name), cwd = path.join(dir, 'workspace'), configDir = path.join(dir, 'config');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(configDir); fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');
    const state = { name, deferred, unusedDelayMs, usedDelayMs, denied, canceled, reconnect, createdAt: now(), createdWall: Date.now(),
      markers: { used: path.join(dir, 'used.jsonl'), unused: path.join(dir, 'unused.jsonl') },
      requests: [], tokenCountRequests: 0, results: [], approvals: [], hooks: [], statuses: [], failures: [], lifecycle: [] };
    states.set(name, state); report.cases.push(state);
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    const runtimeEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-startup-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/' + name, ANTHROPIC_MODEL: 'fixture-startup-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_TMPDIR: temp, CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const rawServers = Object.fromEntries(['used', 'unused'].map(name => [name, {
      command: process.execPath, args: [__filename, '--mcp-child'], timeout: 10000,
      env: { ...runtimeEnv, RELAY_STARTUP_MARKER: state.markers[name],
        RELAY_STARTUP_DELAY_MS: String(name === 'used' ? usedDelayMs : unusedDelayMs) },
    }]));
    if (process.argv.includes('--user-registry')) {
      fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ mcpServers: rawServers }));
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: rawServers }));
    }
    let bridges = {};
    const adapter = createAgentEnvironment({ configDir, homeDir: home, getEnvironment: () => 'native', deferMcpConnections: deferred });
    const rawPrepare = adapter.prepareOptions.bind(adapter);
    adapter.prepareOptions = async (...args) => {
      const prepared = await rawPrepare(...args);
      bridges = Object.fromEntries(Object.entries(prepared.mcpServers || {}).map(([name, value]) => [name, require('../src/main/sdk/host-mcp-loopback').getHostMcpLoopbackOwner(value)?.instance || value.instance]).filter(([, value]) => value));
      return prepared;
    };
    relay.configureRuntimeEnvironment(adapter);
    // Eager is the previous bridge behavior, kept as the independent baseline.
    // Deferred uses the production environment adapter's new default.
    const child = relay.createLiveSession({ cwd, model: 'fixture-startup-model', runtimeEnv, tools: [], includeRelayInstructions: false,
      permissionMode: 'default', mcpPermissionOverrides: { used: 'default', unused: 'default' },
      mcpServers: rawServers,
      runtimePolicy: { settingSources: process.argv.includes('--user-registry') ? ['user'] : [], options: { strictMcpConfig: !process.argv.includes('--user-registry'), persistSession: false, maxTurns: 4 } },
      onToolProposal: async input => { state.hooks.push({ name: input.tool_name, input: input.tool_input }); return {}; },
      canUseTool: async (name, input) => {
        state.approvals.push({ name, input });
        return name === 'mcp__used__blocked' ? { behavior: 'deny', message: 'Synthetic explicit denial' } : { behavior: 'allow', updatedInput: input };
      },
      onInitialized() { state.sdkReadyAt = now(); },
      onMessage(event) {
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') state.firstTextAt ??= now();
        if (event.type === 'result') state.results.push({ at: now(), isError: event.is_error, result: event.result });
      },
      onExit(code, error) { state.lifecycle.push({ code, error: error ? String(error) : null, at: now() }); },
    });
    const originalPush = child.push.bind(child);
    child.push = (...args) => { state.pushedAt = now(); return originalPush(...args); };
    const host = { child, busy: true, dead: false, jobId: randomUUID() };
    active = { state, child, host, bridges: () => bridges, loadServers: () => rawServers };
    return active;
  }
  async function stop() {
    if (!active) return;
    const fixture = active, { child, host, state } = fixture;
    host.dead = true;
    const closed = await deadline(child.kill(), state.name + ' close', 10000);
    state.closed = { stopConfirmed: closed.stopConfirmed, exitCode: closed.exitCode, nativeExitCode: closed.nativeExitCode };
    await Promise.allSettled(Object.values(fixture.bridges()).map(bridge => bridge.close()));
    const pids = [...new Set(Object.values(state.markers).flatMap(file => records(file)).filter(item => item.event === 'spawn').map(item => item.pid))];
    for (const pid of pids) await until(() => !alive(pid), state.name + ' MCP cleanup', 5000);
    check(state.name + ': owned native and MCP processes exit', closed.stopConfirmed && !alive(child.pid) && pids.every(pid => !alive(pid)));
    state.upstreamPids = pids;
    active = null;
    relay.configureRuntimeEnvironment(null);
  }
  async function sample(name, options, leadMs = 0) {
    if (selectedCase && selectedCase !== name) return;
    const fixture = create(name, options), { child, host, state, loadServers } = fixture;
    try {
      if (leadMs) await sleep(leadMs);
      state.sendAt = now();
      state.requestsBeforeSend = state.requests.length;
      check(name + ': no model or token request before user input', !state.requestsBeforeSend && !state.tokenCountRequests);
      if (state.deferred && leadMs) check(name + ': prespawn does not launch unused MCPs', Object.values(state.markers).every(file => records(file).length === 0));
      const pending = dispatchLiveInput({ session: host, jobId: host.jobId, prompt: 'Discover the local fixture and call it once.',
        prepareInput: signal => child.prepareExecutionMode({ kind: 'default' }, { permissionMode: 'default', signal }),
        loadServers, isSessionCurrent: () => !host.dead,
        onStatus: status => state.statuses.push(status), onFailure: (message, detail) => state.failures.push({ message, detail }),
        onTiming: timing => { state.dispatchTiming = timing; } });
      await deadline(pending.done, name + ' dispatch');
      check(name + ': production input dispatch succeeds', state.failures.length === 0);
      if (state.canceled) {
        await until(() => records(state.markers.used).some(item => item.event === 'request' && item.method === 'initialize'), name + ' connection started');
        state.cancelAt = now();
        await stop();
        const protocol = records(state.markers.used);
        check(name + ': stop during connection cannot execute an original tool', !protocol.some(item => item.event === 'tool'));
        check(name + ': canceled discovery cannot reach original tool approval', !state.approvals.some(item => item.name === 'mcp__used__echo'));
        state.postCancelModelRequests = state.requests.filter(item => item.at >= state.cancelAt).length;
        check(name + ': unused MCP remains unstarted after cancellation', records(state.markers.unused).length === 0);
        state.measurements = { firstApiMs: round(state.requests[0].at - state.createdAt), cancelToClosedMs: round(now() - state.cancelAt) };
        return;
      }
      await until(() => state.results.length || state.lifecycle.length || report.errors.length, name + ' completion');
      assert.equal(report.errors.length, 0, report.errors.join('\n'));
      assert.equal(state.results[0]?.isError, false);
      assert.equal(state.results[0]?.result, 'STARTUP_DONE');
      const used = records(state.markers.used), unused = records(state.markers.unused);
      const calls = used.filter(item => item.event === 'tool');
      const originalName = 'mcp__used__' + (state.denied ? 'blocked' : 'echo');
      check(name + ': original name and input reach approval and proposal', [state.hooks, state.approvals].every(items =>
        items.some(item => item.name === originalName && item.input.value === name)));
      check(name + ': original MCP executes exactly once or respects explicit denial', state.denied
        ? calls.length === 0 : calls.length === 1 && calls[0].name === 'echo' && calls[0].input.value === name);
      check(name + ': upstream MCP initializes once', used.filter(item => item.event === 'spawn').length === 1);
      if (state.deferred) {
        check(name + ': first API arrives before either upstream MCP starts', state.firstApiUpstreamStarts.length === 0);
        check(name + ': unused MCP never launches', unused.length === 0);
      }
      state.measurements = { sdkReadyMs: round(state.sdkReadyAt - state.createdAt), promptPushedMs: round(state.pushedAt - state.createdAt),
        firstApiMs: round(state.requests[0].at - state.createdAt), firstTextMs: round(state.firstTextAt - state.createdAt),
        sendToFirstApiMs: round(state.requests[0].at - state.sendAt), sendToFirstTextMs: round(state.firstTextAt - state.sendAt),
        completeMs: round(state.results[0].at - state.createdAt),
        usedConnectAtMs: used.find(item => item.event === 'spawn').at - state.createdWall,
        unusedConnectAtMs: unused.find(item => item.event === 'spawn')?.at - state.createdWall,
        schemaBytes: state.requests[0].schemaBytes };
      if (state.reconnect) {
        state.reconnectStartedAt = now();
        await deadline(child.reconnectMcpServer('used'), name + ' manual reconnect');
        await until(() => records(state.markers.used).filter(item => item.event === 'responded' && item.method === 'initialize').length === 2,
          name + ' second upstream initialize', 5000);
        const reconnected = records(state.markers.used);
        check(name + ': manual reconnect restarts the active upstream transport', reconnected.filter(item => item.event === 'spawn').length === 2);
        check(name + ': manual reconnect performs no business call or model request', reconnected.filter(item => item.event === 'tool').length === 1 && state.requests.length === 3);
        check(name + ': manual reconnect leaves unused MCP deferred', records(state.markers.unused).length === 0);
        state.reconnectMs = round(now() - state.reconnectStartedAt);
      }
      state.upstreamRecords = { used: records(state.markers.used), unused: records(state.markers.unused) };
      console.log(JSON.stringify({ scenario: name, ...state.measurements }));
    } finally { await stop(); save(); }
  }
  hardDeadline = setTimeout(() => {
    report.errors.push('180-second fixture deadline');
    if (active) {
      const pids = [active.child.pid, ...Object.values(active.state.markers).flatMap(file => records(file)).filter(item => item.event === 'spawn').map(item => item.pid)];
      for (const pid of new Set(pids.filter(Number.isInteger))) try { process.kill(pid); } catch (_) {}
    }
    save(); process.exit(1);
  }, 180000);
  try {
    await listen(proxy); await listen(server);
    await sample('calibration', { deferred: true });
    for (let repeat = 0; repeat < 2; repeat++) for (const unusedDelayMs of [0, 3000]) {
      for (const deferred of repeat % 2 ? [true, false] : [false, true]) {
        await sample((deferred ? 'deferred' : 'eager') + '-' + unusedDelayMs + '-' + repeat, { deferred, unusedDelayMs });
      }
    }
    await sample('denied-original', { deferred: true, unusedDelayMs: 3000, denied: true });
    await sample('stop-during-connection', { deferred: true, usedDelayMs: 5000, unusedDelayMs: 3000, canceled: true });
    await sample('manual-reconnect', { deferred: true, unusedDelayMs: 3000, reconnect: true });
    await sample('warm-800ms', { deferred: true, unusedDelayMs: 3000 }, 800);
    assert.ok(report.cases.length, 'Requested scenario exists');
    if (!selectedCase) {
      const mean = values => round(values.reduce((sum, value) => sum + value, 0) / values.length);
      report.comparison = [0, 3000].map(unusedDelayMs => {
        const groups = [false, true].map(deferred => {
          const cases = report.cases.filter(item => item.name.startsWith((deferred ? 'deferred' : 'eager') + '-' + unusedDelayMs + '-'));
          return { deferred, count: cases.length, firstApiMs: mean(cases.map(item => item.measurements.firstApiMs)),
            firstTextMs: mean(cases.map(item => item.measurements.firstTextMs)), completeMs: mean(cases.map(item => item.measurements.completeMs)) };
        });
        return { unusedDelayMs, groups, savedFirstTextMs: round(groups[0].firstTextMs - groups[1].firstTextMs) };
      });
      check('An unused three-second MCP no longer blocks first text', report.comparison.find(item => item.unusedDelayMs === 3000).savedFirstTextMs > 1500);
    }
    report.ok = true;
  } catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    try { await stop(); } catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
    clearTimeout(hardDeadline);
    for (const target of [server, proxy]) { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
    report.ok = report.ok && !report.errors.length;
    report.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, comparison: report.comparison, errors: report.errors, result: path.join(output, 'result.json') }, null, 2));
  }
}
