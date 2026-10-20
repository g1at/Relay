'use strict';

// Explicit finite benchmark of Relay's existing known-project prespawn path.
// Real Electron/SDK/native CLI/stdio MCP; deterministic local model, isolated
// configuration, no user sessions or credentials. Run sequentially only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--mcp-child')) {
  const marker = process.env.RELAY_BENCH_MCP_MARKER;
  const record = event => fs.appendFileSync(marker, JSON.stringify({ ...event, time: Date.now(), pid: process.pid }) + '\n');
  record({ event: 'spawn' });
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', async line => {
    const message = JSON.parse(line);
    record({ event: 'request', method: message.method });
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') {
      await sleep(Number(process.env.RELAY_BENCH_MCP_DELAY || 0));
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'relay-prewarm-fixture', version: '1.0.0' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: 'Return the local benchmark marker',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    } else if (message.method === 'tools/call' && message.params.name === 'echo') {
      record({ event: 'tool' }); result = { content: [{ type: 'text', text: 'PREWARM_TOOL_OK' }] };
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture method unavailable' } }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    record({ event: 'responded', method: message.method });
  });
  input.on('close', () => process.exit(0));
} else if (!process.argv.includes('--run')) {
  console.log('Opt-in: ELECTRON_RUN_AS_NODE=1 electron test/relay-prewarm-benchmark.cjs --run');
} else {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  assert.equal(process.platform, 'win32', 'Measure the native Windows desktop runtime');
  assert.ok(process.versions.electron, 'Use the installed Electron executable in Node mode');
  assert.notEqual(process.type, 'browser');
  const output = path.resolve(__dirname, '../.codex-tmp/relay-prewarm-benchmark-2026-09-28');
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'run-'));
  const home = path.join(root, 'home'), temp = path.join(root, 'temp'), config = path.join(root, 'config');
  for (const dir of [home, temp, config, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, system, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: temp, TMP: temp, TMPDIR: temp,
    CLAUDE_CONFIG_DIR: config, ELECTRON_RUN_AS_NODE: '1' });
  const relay = require('../src/main/sdk/claude-sdk');
  const { dispatchLiveInput } = require('../src/main/live/live-mcp-dispatch');
  const report = { ok: false, startedAt: new Date().toISOString(), root, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
    cli: relay.bundledClaudeVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform,
    scope: 'Production createLiveSession + prepareExecutionMode + dispatchLiveInput; excludes renderer, bootstrap registry and live pool selection; real native stdio MCP, loopback deterministic model.',
    modelReplyDelayMs: 100, warmLeadMs: 3000, repeatsPerArm: 3, cases: [], memory: [], checks: [], errors: [], blockedExternalRequests: 0 };
  const states = new Map();
  let active = null;
  const now = () => performance.now();
  const round = n => Math.round(n * 10) / 10;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const records = state => fs.existsSync(state.marker) ? fs.readFileSync(state.marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const check = (label, condition) => { assert.ok(condition, label); report.checks.push(label); };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  async function deadline(promise, label, ms = 25000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(test, label, ms = 25000) {
    const start = now();
    while (!test()) { if (now() - start > ms) throw new Error('Timed out: ' + label); await sleep(10); }
  }
  function json(res, value, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }
  function stream(res, body, blocks) {
    const stop = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } };
    if (!body.stream) return json(res, { ...message, content: blocks, stop_reason: stop, usage: { input_tokens: 20, output_tokens: 8 } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    emit('message_start', { type: 'message_start', message });
    blocks.forEach((block, index) => {
      emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
        ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: '{}' } });
      emit('content_block_stop', { type: 'content_block_stop', index });
    });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  }
  const proxy = http.createServer((_req, res) => { report.blockedExternalRequests++; json(res, {}, 403); });
  proxy.on('connect', (_req, socket) => { report.blockedExternalRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      try {
        const state = states.get(req.url.split('/')[1]);
        assert.ok(state, 'Known fixture only');
        if (req.url.includes('/count_tokens')) { state.tokenCountRequests++; return json(res, { input_tokens: 20 }); }
        if (!req.url.includes('/messages')) return json(res, {}, 404);
        const body = JSON.parse(raw);
        assert.equal(req.headers['x-api-key'], 'synthetic-prewarm-key');
        assert.equal(body.model, 'fixture-prewarm-model');
        state.requests.push(now());
        assert.ok(state.requests.length <= 2, 'At most two model requests per isolated session');
        if (state.requests.length === 1) assert.ok((body.tools || []).some(item => item.name === 'mcp__bench__echo'), 'MCP schema available in the first model request');
        else assert.ok(JSON.stringify(body.messages).includes('PREWARM_TOOL_OK'), 'Real MCP result reaches model');
        await sleep(report.modelReplyDelayMs);
        stream(res, body, state.requests.length === 1 ? [
          { type: 'text', text: 'PREWARM_BEGIN' },
          { type: 'tool_use', id: 'tool_' + randomUUID(), name: 'mcp__bench__echo', input: {} },
        ] : [{ type: 'text', text: 'PREWARM_DONE' }]);
      } catch (error) { report.errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
  });
  const listen = srv => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  async function stop() {
    if (!active) return;
    const { child, state, host } = active;
    host.dead = true;
    try { state.closed = await deadline(child.kill(), 'native shutdown', 10000); }
    finally {
      const mcpPids = [...new Set(records(state).filter(item => item.event === 'spawn').map(item => item.pid))];
      state.mcpPids = mcpPids;
      for (const pid of mcpPids) {
        for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
        if (alive(pid)) { state.mcpCleanupForced = true; process.kill(pid); }
      }
      check(state.name + ': native and MCP exited', state.closed?.stopConfirmed && !alive(child.pid) && mcpPids.every(pid => !alive(pid)));
      active = null;
    }
  }
  function create(name, delayMs) {
    assert.equal(active, null, 'One fixture CLI at a time');
    const dir = path.join(root, name), cwd = path.join(dir, 'workspace'), configDir = path.join(dir, 'config');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(configDir); fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');
    const state = { name, delayMs, marker: path.join(dir, 'mcp.jsonl'), createdAt: now(), createdWall: Date.now(), requests: [], tokenCountRequests: 0,
      firstTextAt: null, results: [], failures: [], statuses: [] };
    states.set(name, state);
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    const runtimeEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-prewarm-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/' + name, ANTHROPIC_MODEL: 'fixture-prewarm-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_TMPDIR: temp, CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const servers = { bench: { command: process.execPath, args: [__filename, '--mcp-child'],
      env: { ...runtimeEnv, RELAY_BENCH_MCP_MARKER: state.marker, RELAY_BENCH_MCP_DELAY: String(delayMs) } } };
    const child = relay.createLiveSession({ cwd, model: 'fixture-prewarm-model', permissionMode: 'default',
      tools: [], mcpServers: servers, runtimeEnv, includeRelayInstructions: false,
      runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: false, maxTurns: 3 } },
      canUseTool: async (name, input) => name === 'mcp__bench__echo'
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the local fixture echo is allowed' },
      onInitialized() { state.initializedAt = now(); },
      onMessage(event) {
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') state.firstTextAt ??= now();
        if (event.type === 'result') state.results.push({ at: now(), error: event.is_error, result: event.result });
      },
      onExit(code, error) { state.exit = { code, error }; },
    });
    const host = { child, busy: true, dead: false, jobId: randomUUID() };
    active = { child, state, host, servers };
    return active;
  }
  async function sample(name, delayMs, leadMs, included = true) {
    const clickAt = leadMs === 0 ? now() : null;
    const { state, child, host, servers } = create(name, delayMs);
    state.leadMs = leadMs; state.included = included;
    report.cases.push(state);
    try {
      if (leadMs) await sleep(Math.max(0, leadMs - (now() - state.createdAt)));
      state.sendAt = clickAt ?? now(); state.sendWall = Date.now();
      state.requestsBeforeSend = state.requests.length; state.tokenCountBeforeSend = state.tokenCountRequests;
      state.mcpBeforeSend = records(state).filter(item => item.event === 'responded').map(item => item.method);
      state.pidAtSend = child.pid;
      check(name + ': no model or token count request before user input', state.requestsBeforeSend === 0 && state.tokenCountBeforeSend === 0);
      const dispatch = dispatchLiveInput({ session: host, jobId: host.jobId, prompt: 'Call the benchmark echo once and report completion.',
        prepareInput: signal => child.prepareExecutionMode({ kind: 'default' }, { permissionMode: 'default', signal }),
        loadServers: () => servers, isSessionCurrent: () => !host.dead,
        onStatus: value => state.statuses.push({ phase: value.phase, ok: value.ok, items: value.items?.map(item => ({ name: item.name, status: item.status })) }),
        onTiming: value => { state.dispatchTiming = value; },
        onFailure: (message, detail) => { state.failures.push({ message, detail }); },
      });
      await deadline(dispatch.done, name + ' dispatch');
      assert.equal(state.failures.length, 0, 'Production dispatch succeeds');
      await until(() => state.results.length || state.exit, name + ' completion');
      assert.equal(state.results[0]?.error, false, 'Successful SDK turn');
      assert.equal(state.results[0].result, 'PREWARM_DONE');
      const trace = records(state);
      check(name + ': MCP starts once, lists before first request, and executes once',
        trace.filter(item => item.event === 'spawn').length === 1 && trace.filter(item => item.event === 'tool').length === 1 && state.requests.length === 2);
      check(name + ': warm native PID reused', leadMs === 0 || state.pidAtSend === child.pid);
      check(name + ': first text stream measured', state.firstTextAt !== null);
      state.measurements = { actualLeadMs: round(state.sendAt - state.createdAt),
        initializationMs: round(state.initializedAt - state.createdAt), sendToApiMs: round(state.requests[0] - state.sendAt),
        sendToFirstTextMs: round(state.firstTextAt - state.sendAt), sendToResultMs: round(state.results[0].at - state.sendAt),
        createToFirstTextMs: round(state.firstTextAt - state.createdAt), mcpReadyBeforeSend: state.mcpBeforeSend.includes('tools/list') };
      console.log(JSON.stringify({ scenario: name, ...state.measurements }));
    } finally { await stop(); save(); }
  }
  async function memorySample(label, fixture) {
    const mcpPid = records(fixture.state).find(item => item.event === 'spawn')?.pid;
    assert.ok(mcpPid && fixture.child.pid);
    const script = '$ids=@(' + [fixture.child.pid, mcpPid].join(',') + '); @(Get-Process -Id $ids -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=$_.Id;privateBytes=$_.PrivateMemorySize64;workingSetBytes=$_.WorkingSet64;cpuSeconds=$_.CPU} }) | ConvertTo-Json -Compress';
    const stdout = await new Promise((resolve, reject) => cp.execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 8192 },
      (error, data) => error ? reject(error) : resolve(data)));
    const processes = JSON.parse(stdout);
    report.memory.push({ label, at: now(), cliPid: fixture.child.pid, mcpPid, processes, hostMemory: process.memoryUsage() });
    check(label + ': fixture process memory stays within 768 MiB', processes.every(item => item.privateBytes < 768 * 1024 * 1024));
  }
  const hardDeadline = setTimeout(() => {
    report.errors.push('240-second benchmark deadline');
    if (active) {
      const owned = [active.child.pid, ...records(active.state).filter(item => item.event === 'spawn').map(item => item.pid)].filter(Number.isInteger);
      for (const pid of new Set(owned)) { try { process.kill(pid); } catch (_) {} }
    }
    save(); process.exit(1);
  }, 240000);
  try {
    await listen(proxy); await listen(server);
    await sample('calibration-excluded', 0, 0, false);
    for (const delay of [0, 1500]) for (let repeat = 0; repeat < 3; repeat++) {
      const order = repeat % 2 ? [3000, 0] : [0, 3000];
      for (const lead of order) await sample('delay-' + delay + '-repeat-' + repeat + '-lead-' + lead, delay, lead);
    }
    for (let repeat = 0; repeat < 2; repeat++) await sample('partial-lead-repeat-' + repeat, 1500, 500, false);
    const fixture = create('idle-memory', 1500);
    await fixture.child.whenReady({ timeoutMs: 20000 });
    const ready = await fixture.child.prepareMcp({ servers: fixture.servers, reconnect: false, timeoutMs: 15000 });
    check('idle MCP connected without sending a model prompt', ready.ok && fixture.state.requests.length === 0);
    await memorySample('idle-ready', fixture); await sleep(5000); await memorySample('idle-after-5s', fixture);
    check('idle wait does not call the model or MCP tool', fixture.state.requests.length === 0 && !records(fixture.state).some(item => item.event === 'tool'));
    report.idle = { requests: fixture.state.requests.length, tokenCountRequests: fixture.state.tokenCountRequests, closed: null };
    await stop(); report.idle.closed = fixture.state.closed;
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
    report.summary = [0, 1500].map(delayMs => {
      const group = report.cases.filter(item => item.included && item.delayMs === delayMs);
      const arms = [0, 3000].map(leadMs => {
        const items = group.filter(item => item.leadMs === leadMs);
        return { leadMs, count: items.length, mcpReadyBeforeSend: items.filter(item => item.measurements.mcpReadyBeforeSend).length,
          ...Object.fromEntries(['sendToApiMs', 'sendToFirstTextMs', 'sendToResultMs', 'createToFirstTextMs'].map(key =>
            [key, { median: median(items.map(item => item.measurements[key])), min: Math.min(...items.map(item => item.measurements[key])), max: Math.max(...items.map(item => item.measurements[key])) }])) };
      });
      return { delayMs, arms, savedFirstTextMs: round(arms[0].sendToFirstTextMs.median - arms[1].sendToFirstTextMs.median) };
    });
    report.ok = report.errors.length === 0;
  } catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    try { await stop(); } catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
    clearTimeout(hardDeadline);
    for (const srv of [server, proxy]) { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); }
    report.ok = report.ok && report.errors.length === 0;
    report.completedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ ok: report.ok, summary: report.summary, checks: report.checks.length, errors: report.errors, result: path.join(output, 'result.json') }, null, 2));
  }
}
