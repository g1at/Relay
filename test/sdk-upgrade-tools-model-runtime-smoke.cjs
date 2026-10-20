'use strict';

// Opt-in native-SDK checks. No tool is executed; model traffic stays on a
// loopback fixture. Settings, HOME, workspace and temporary files are isolated.
if (!process.argv.includes('--run')) {
  console.log('Opt-in only: run with Electron in ELECTRON_RUN_AS_NODE=1 mode and --run.');
  process.exit(0);
}
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
assert.equal(process.platform, 'win32');
assert.ok(process.versions.electron); assert.notEqual(process.type, 'browser', 'Electron Node mode is required');
// Keep separate evidence directories when reviewing another SDK release.
const outputArgument = process.argv.find(argument => argument.startsWith('--output-dir='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length))
  : path.resolve(__dirname, '../.codex-tmp/sdk-upgrade-0.3.283-2026-09-28/tools-model-runtime');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'isolated-'));
const home = path.join(root, 'home'), config = path.join(root, 'config'), cwd = path.join(root, 'workspace'), temp = path.join(root, 'temp');
const roaming = path.join(home, 'AppData/Roaming'), local = path.join(home, 'AppData/Local');
for (const directory of [home, config, cwd, temp, roaming, local]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, inherited, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
  CLAUDE_CONFIG_DIR: config, TEMP: temp, TMP: temp, TMPDIR: temp, ELECTRON_RUN_AS_NODE: '1' });
const relay = require('../src/main/sdk/claude-sdk');
const report = { ok: false, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), electron: process.versions.electron, requests: [], checks: [], errors: [], closes: [] };
const modelA = 'relay-upgrade-model-a', modelB = 'relay-upgrade-model-b', missing = 'relay-upgrade-missing-model';
const sessions = new Set();
let pendingFailure;
function failure(error) { const text = error?.message || String(error); report.errors.push(text); pendingFailure?.(error instanceof Error ? error : Error(text)); }
function save() { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
function forceOwned() { for (const session of sessions) if (session.pid) try { process.kill(session.pid, 'SIGKILL'); } catch (_) {} }
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
      const requested = { model: body.model, maxTokens: body.max_tokens,
        prompted: JSON.stringify(body.messages || []).includes('FIXTURE_'), tools: (body.tools || []).map(tool => tool.name) };
      report.requests.push(requested);
      assert.ok(report.requests.length <= 12, 'Bounded request count exceeded');
      assert.equal(request.headers['x-api-key'], 'synthetic-tools-model-key');
      if (body.model === missing) {
        requested.status = 404; response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Synthetic model not found' } })); return;
      }
      assert.ok([modelA, modelB].includes(body.model), 'Unexpected provider model');
      requested.status = 200;
      const usage = { input_tokens: 20, output_tokens: 4 }, text = 'READY:' + body.model;
      const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage };
      if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
      send('message_stop', { type: 'message_stop' }); response.end();
    } catch (error) { failure(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
});
const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });
const deadline = setTimeout(() => { failure('45-second tools/model fixture deadline'); forceOwned(); save(); process.exit(1); }, 45000);
let runtimeEnv;
async function open(tools) {
  const results = [];
  let resolveNext;
  const session = relay.createLiveSession({ cwd, model: modelA, runtimeEnv, ...(tools === undefined ? {} : { tools }),
    mcpServers: {}, includeRelayInstructions: false, canUseTool: async () => ({ behavior: 'deny', message: 'Fixture executes no tools' }),
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: false, maxTurns: 5 } },
    onMessage(event) { if (event.type === 'result') { results.push(event); resolveNext?.(event); resolveNext = null; } }, onExit() {},
  });
  sessions.add(session);
  await session.whenReady({ timeoutMs: 12000 });
  return { session, results,
    async turn(marker) {
      const pending = new Promise((resolve, reject) => { resolveNext = resolve; pendingFailure = reject; });
      assert.equal(session.push(marker, { uuid: randomUUID() }), true);
      const event = await pending; pendingFailure = null;
      assert.equal(event.is_error, false); return event;
    },
    async close() {
      const closed = await session.kill(); assert.equal(closed.stopConfirmed, true); assert.ok(Number.isInteger(closed.nativeExitCode));
      sessions.delete(session); report.closes.push({ pid: closed.pid, stopConfirmed: closed.stopConfirmed, nativeExitCode: closed.nativeExitCode });
    },
  };
}
async function run() {
  try {
    await listen(proxy); await listen(server);
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    runtimeEnv = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-tools-model-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_MODEL: modelA,
      // Declare all three synthetic routes as host-authorized so API validation
      // is exercised separately from Relay's available-model scope restriction.
      ANTHROPIC_SMALL_FAST_MODEL: modelB, ANTHROPIC_DEFAULT_HAIKU_MODEL: missing,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', CLAUDE_CODE_TMPDIR: temp,
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const defaults = await open();
    try {
      assert.equal((await defaults.turn('FIXTURE_BASELINE')).result, 'READY:' + modelA);
      report.defaultTools = report.requests.find(item => item.prompted).tools;
      console.log(JSON.stringify({ defaultTools: report.defaultTools }));
      await defaults.session.setModel(modelB); report.setModelAccepted = true;
      assert.equal((await defaults.turn('FIXTURE_AFTER_VALID_SWITCH')).result, 'READY:' + modelB);
      let rejected;
      try { await defaults.session.setModel(missing); } catch (error) { rejected = error.message; }
      assert.ok(rejected, 'Invalid model switch must reject'); report.setModelRejected = rejected;
      assert.equal((await defaults.turn('FIXTURE_AFTER_REJECTED_SWITCH')).result, 'READY:' + modelB);
      assert.ok(report.requests.some(item => item.model === missing && item.status === 404));
      report.checks.push('Valid model switch succeeds, invalid model validation rejects, and the same session continues using the valid model');
      report.sessionIds = defaults.results.map(item => item.session_id);
      assert.equal(new Set(report.sessionIds).size, 1);
    } finally { await defaults.close(); }
    const requestStart = report.requests.length, restricted = await open(['Read']);
    try {
      assert.equal((await restricted.turn('FIXTURE_RESTRICTED_TOOLS')).result, 'READY:' + modelA);
      report.restrictedTools = report.requests.slice(requestStart).find(item => item.prompted).tools;
      assert.deepEqual(report.restrictedTools, ['Read']);
      report.checks.push('Explicit Read-only tool list stays restricted in the actual native model request');
    } finally { await restricted.close(); }
    report.expectedTaskTools = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'];
    report.todoWriteAvailable = report.defaultTools.includes('TodoWrite');
    report.missingTaskTools = report.expectedTaskTools.filter(name => !report.defaultTools.includes(name));
    assert.deepEqual(report.missingTaskTools, []);
    report.checks.push('Third-party model native default tool schemas contain the four Task tools; legacy TodoWrite availability is recorded separately');
    report.ok = true;
  } catch (error) { failure(error); report.lastErrorStack = error.stack; process.exitCode = 1; }
  finally {
    for (const session of sessions) { session.kill(); forceOwned(); await session.whenClosed(); }
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    clearTimeout(deadline); save(); console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors, closes: report.closes }, null, 2));
  }
}
run().catch(error => { failure(error); forceOwned(); save(); process.exit(1); });
