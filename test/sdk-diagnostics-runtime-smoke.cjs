'use strict';

// Opt-in native acceptance for real SDK diagnostics. Uses only fixture files,
// one loopback model and owned processes; never opens Relay or a user profile.
if (!process.argv.includes('--run')) {
  console.log('Opt-in: ELECTRON_RUN_AS_NODE=1 electron test/sdk-diagnostics-runtime-smoke.cjs --run');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

assert.equal(process.platform, 'win32');
assert.ok(process.versions.electron, 'Use installed Electron in Node mode');
assert.notEqual(process.type, 'browser');
const output = path.resolve(__dirname, '../.codex-tmp/sdk-diagnostics-integration-2026-09-28');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'isolated-'));
const home = path.join(root, 'home'), temp = path.join(root, 'temp');
const config = path.join(root, 'config'), roaming = path.join(home, 'AppData/Roaming'), local = path.join(home, 'AppData/Local');
for (const dir of [home, temp, config, roaming, local]) fs.mkdirSync(dir, { recursive: true });
const system = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, system, { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
  TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: config, ELECTRON_RUN_AS_NODE: '1' });

const relay = require('../src/main/sdk/claude-sdk');
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const report = { ok: false, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), electron: process.versions.electron, node: process.versions.node,
  isolation: { cleanHome: true, cleanConfig: true, cleanCwd: true, settingSources: [], strictMcpConfig: true },
  cases: [], checks: [], errors: [], blockedExternalRequests: 0,
  scope: 'Real Windows native plugin/startup diagnostics through production Relay onMessage; no induced worker restart or recovery claim.' };
const states = new Map();
const privateMarker = 'SENSITIVE_DIAGNOSTIC_FIXTURE';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
let active;
function save() { report.elapsedMs = elapsed(); fs.writeFileSync(path.join(output, 'native-result.json'), JSON.stringify(report, null, 2) + '\n'); }
function check(label, value) { assert.ok(value, label); report.checks.push(label); }
async function deadline(promise, label, timeout = 18000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  return deadline((async () => { while (!predicate()) await sleep(20); })(), label);
}
function json(res, body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
const proxy = http.createServer((_req, res) => { report.blockedExternalRequests++; json(res, {}, 403); });
proxy.on('connect', (_req, socket) => { report.blockedExternalRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const state = states.get(req.url.split('/')[1]);
      assert.ok(state, 'Known local fixture only');
      if (req.url.includes('/count_tokens')) { state.tokenCountRequests++; return json(res, { input_tokens: 20 }); }
      if (!req.url.includes('/messages')) return json(res, {}, 404);
      state.modelRequests++;
      assert.equal(state.name, 'invalid-plugin');
      assert.equal(state.modelRequests, 1, 'Only one bounded local model request');
      assert.equal(req.headers['x-api-key'], 'synthetic-diagnostics-key');
      const body = JSON.parse(raw);
      assert.equal(body.model, 'fixture-diagnostics-model');
      const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'DIAGNOSTICS_FIXTURE_OK' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 } };
      if (!body.stream) return json(res, message);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DIAGNOSTICS_FIXTURE_OK' } });
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      emit('message_stop', { type: 'message_stop' }); res.end();
    } catch (error) { report.errors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
});
const listen = srv => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });

function create(name, { plugins, invalidProxy = false } = {}) {
  assert.equal(active, undefined, 'One owned SDK at a time');
  const directory = path.join(root, name), cwd = path.join(directory, 'workspace'), configDir = path.join(directory, 'config');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(configDir); fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');
  const state = { name, modelRequests: 0, tokenCountRequests: 0, events: [], diagnostics: [], stderrBytes: 0 };
  states.set(name, state); report.cases.push(state);
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  const runtimeEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'synthetic-diagnostics-key', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/' + name, ANTHROPIC_MODEL: 'fixture-diagnostics-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
    CLAUDE_CODE_TMPDIR: temp, CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    // Deliberately contradict the host default: production must force-enable
    // structured startup failures even if an inherited environment opts out.
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '0',
  };
  if (invalidProxy) runtimeEnv.HTTPS_PROXY = runtimeEnv.https_proxy = 'fixture-invalid-proxy-' + privateMarker;
  const child = relay.createLiveSession({ cwd, model: 'fixture-diagnostics-model', runtimeEnv, tools: [], mcpServers: {},
    includeRelayInstructions: false, plugins,
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, persistSession: false, maxTurns: 1 } },
    stderr: chunk => { state.stderrBytes += Buffer.byteLength(String(chunk)); },
    onMessage(event) {
      const summary = { type: event.type, ...(event.subtype ? { subtype: event.subtype } : {}) };
      if (event.type === 'system' && event.subtype === 'init') {
        state.init = { pluginErrorCount: event.plugin_errors?.length || 0,
          pluginErrorTypes: (event.plugin_errors || []).map(item => item.type),
          rawContainsPrivateMarker: JSON.stringify(event.plugin_errors || []).includes(privateMarker),
          diagnostic: event.relay_diagnostics || null };
      }
      if (event.type === 'result') {
        state.result = { isError: event.is_error, result: event.result, startupFailureReason: event.startup_failure_reason,
          resultIndex: event.result_index, diagnostic: event.relay_diagnostics || null };
      }
      if (event.relay_diagnostics) state.diagnostics.push(event.relay_diagnostics);
      state.events.push(summary);
    },
    onExit(code) { state.exit = { code }; },
  });
  active = { child, state };
  return active;
}
async function stop() {
  if (!active) return;
  const { child, state } = active;
  state.closed = await deadline(child.kill(), state.name + ' native exit', 10000);
  check(state.name + ': owned native process exit confirmed', state.closed.stopConfirmed && !alive(child.pid));
  active = undefined;
}

async function run() {
  const hardDeadline = setTimeout(() => {
    report.errors.push('60-second native diagnostics deadline');
    if (active?.child.pid) try { process.kill(active.child.pid); } catch (_) {}
    save(); process.exit(1);
  }, 60000);
  try {
    await listen(proxy); await listen(server);
    const badPlugin = path.join(root, privateMarker, 'bad-plugin');
    fs.mkdirSync(path.join(badPlugin, '.claude-plugin'), { recursive: true });
    // Real local plugin manifest schema error; no executable hook/component.
    fs.writeFileSync(path.join(badPlugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 17, description: privateMarker }));
    let fixture = create('invalid-plugin', { plugins: [{ type: 'local', path: badPlugin }] });
    await fixture.child.whenReady({ timeoutMs: 15000 });
    check('plugin fixture accepts its sole input', fixture.child.push('Reply with the local diagnostics fixture marker.', { uuid: randomUUID() }));
    await until(() => fixture.state.result || fixture.state.exit, 'plugin result');
    check('plugin manifest really yields native init plugin_errors', fixture.state.init?.pluginErrorCount > 0);
    check('raw plugin error contains the artificial private path marker', fixture.state.init.rawContainsPrivateMarker === true);
    check('plugin error does not prevent independent successful conversation', fixture.state.result?.isError === false
      && fixture.state.result?.result === 'DIAGNOSTICS_FIXTURE_OK' && fixture.state.modelRequests === 1);
    check('plugin error is mapped by production Relay to safe diagnostic', fixture.state.init.diagnostic?.pluginErrors?.count > 0);
    check('plugin diagnostic withholds fixture path and raw marker', !JSON.stringify(fixture.state.init.diagnostic).includes(privateMarker)
      && !JSON.stringify(fixture.state.init.diagnostic).includes(root));
    check('successful native result sequence reaches safe diagnostics', fixture.state.result.resultIndex === 0
      && fixture.state.result.diagnostic?.resultIndex === fixture.state.result.resultIndex);
    await stop();

    fixture = create('invalid-proxy', { invalidProxy: true });
    try { await fixture.child.whenReady({ timeoutMs: 15000 }); fixture.state.ready = true; }
    catch (error) { fixture.state.ready = false; fixture.state.readyError = 'Initialization rejected'; }
    await until(() => fixture.state.result || fixture.state.exit, 'startup refusal');
    check('invalid proxy really yields native startup failure result', fixture.state.result?.startupFailureReason === 'proxy_invalid'
      && fixture.state.result?.isError === true);
    check('startup refusal diagnostic reaches Relay onMessage', fixture.state.result?.diagnostic?.startupFailure?.reason === 'proxy_invalid');
    check('native startup result sequence reaches safe diagnostics', fixture.state.result.resultIndex === 0
      && fixture.state.result.diagnostic?.resultIndex === fixture.state.result.resultIndex);
    check('startup diagnostic withholds the invalid proxy raw text', !JSON.stringify(fixture.state.result.diagnostic).includes(privateMarker));
    check('startup refusal makes no model or token count request', fixture.state.modelRequests === 0 && fixture.state.tokenCountRequests === 0);
    await stop();
    check('no external requests attempted by isolated scenarios', report.blockedExternalRequests === 0);
    report.ok = report.errors.length === 0;
  } catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    try { await stop(); } catch (error) { report.errors.push(error.message); if (active?.child.pid) try { process.kill(active.child.pid); } catch (_) {} }
    clearTimeout(hardDeadline);
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    report.ok = report.ok && report.errors.length === 0; save();
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, cases: report.cases.map(s => ({ name: s.name,
      modelRequests: s.modelRequests, init: s.init, result: s.result, closed: s.closed })), errors: report.errors, output: path.join(output, 'native-result.json') }, null, 2));
  }
}
run().catch(error => { report.errors.push(error.message); if (active?.child.pid) try { process.kill(active.child.pid); } catch (_) {} save(); process.exit(1); });
