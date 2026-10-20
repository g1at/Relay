'use strict';
// Opt-in Windows/Electron acceptance of Relay.createLiveSession and its actual
// native-process completion contract. No user settings, MCP, tools or provider.
// ELECTRON_RUN_AS_NODE=1 electron test/sdk-process-lifecycle-runtime.cjs --run
if (!process.argv.includes('--run')) {
  console.log('Opt-in only: run with Electron in ELECTRON_RUN_AS_NODE=1 mode and --run.');
  process.exit(0);
}
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
assert.equal(process.platform, 'win32', 'This acceptance targets the Windows native SDK.');
assert.ok(process.versions.electron?.startsWith('32.'), 'Run under Relay Electron 32 with ELECTRON_RUN_AS_NODE=1.');
assert.notEqual(process.type, 'browser', 'Set ELECTRON_RUN_AS_NODE inside Windows before launching this fixture.');
const limits = { totalMs: 30000, privateBytes: 512 * 1024 * 1024, sampleMs: 700, maxRequests: 4 };
// Keep separate evidence directories when reviewing another SDK release.
const outputArgument = process.argv.find(argument => argument.startsWith('--output-dir='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length))
  : path.resolve(__dirname, '../.codex-tmp/sdk-process-lifecycle-runtime');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'isolated-'));
const home = path.join(root, 'home'), config = path.join(root, 'config'), cwd = path.join(root, 'workspace'), temp = path.join(root, 'temp');
for (const dir of [home, config, cwd, temp, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
// Clear inherited credentials/config before importing Relay: its environment
// builder intentionally starts with the host environment.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, systemEnv, { HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: config, ELECTRON_RUN_AS_NODE: '1' });
const relay = require('../src/main/sdk/claude-sdk');
const started = performance.now();
const report = { ok: false, platform: process.platform, electron: process.versions.electron, node: process.versions.node,
  sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(),
  limits, isolation: { cleanHome: true, cleanConfig: true, cleanCwd: true, cleanTemp: true, settingSources: [], strictMcpConfig: true, tools: [] },
  requests: [], events: {}, samples: [], lifecycle: [], checks: [], errors: [] };
let session, ownedPid, confirmed = false, sampleBusy = false, monitor, deadline;
let resultResolve, resultReject;
const resultPromise = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
resultPromise.catch(() => {});
const elapsed = () => Math.round(performance.now() - started);
function save() { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
function fail(message) { if (!report.errors.includes(message)) report.errors.push(message); resultReject(Error(message)); }
function ownPid() {
  const pid = session?.pid;
  if (pid != null) { assert.ok(Number.isSafeInteger(pid) && pid > 0); if (ownedPid != null) assert.equal(pid, ownedPid); ownedPid = pid; }
  return ownedPid;
}
function emergencyStop() {
  const pid = ownPid();
  if (!pid || confirmed) return;
  // Never discover processes by name, enumerate user sessions, or kill a tree.
  try { process.kill(pid, 'SIGKILL'); report.emergencyStop = { pid, requested: true }; }
  catch (error) { report.emergencyStop = { pid, requested: false, code: error.code }; }
}
async function sample() {
  if (sampleBusy || confirmed || !ownPid()) return;
  sampleBusy = true;
  const pid = ownedPid;
  try {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;privateBytes=$p.PrivateMemorySize64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds}|ConvertTo-Json -Compress`;
    const entry = await new Promise((resolve, reject) => cp.execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: process.env, windowsHide: true, timeout: 3000, maxBuffer: 4096 },
      (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } }));
    assert.equal(entry.pid, ownedPid);
    report.samples.push({ atMs: elapsed(), ...entry });
    if (entry.privateBytes > limits.privateBytes) { fail('Owned SDK exceeded the 512 MiB private-memory limit'); session.kill(); emergencyStop(); }
  } catch (_) { if (!confirmed) report.sampleUnavailableCount = (report.sampleUnavailableCount || 0) + 1; }
  finally { sampleBusy = false; }
}
const proxy = http.createServer((_req, res) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; res.writeHead(403); res.end(); });
proxy.on('connect', (_req, socket) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let body; try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400); res.end(); return; }
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end(); return; }
    report.requests.push({ atMs: elapsed(), model: body.model, toolCount: body.tools?.length || 0,
      syntheticCredential: req.headers['x-api-key'] === 'synthetic-lifecycle-key' });
    if (report.requests.length > limits.maxRequests) { fail('Loopback request limit'); res.writeHead(429); res.end(); return; }
    const usage = { input_tokens: 20, output_tokens: 2 }, message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'READY' }], stop_reason: 'end_turn', stop_sequence: null, usage };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
    send('message_stop', { type: 'message_stop' }); res.end();
  });
});
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
async function run() {
  deadline = setTimeout(() => { fail('30-second fixture deadline'); emergencyStop(); report.elapsedMs = elapsed(); save(); process.exit(1); }, limits.totalMs);
  try {
    await listen(proxy); await listen(server);
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const runtimeEnv = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-lifecycle-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-lifecycle-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', OTEL_SDK_DISABLED: 'true', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', CLAUDE_CODE_TMPDIR: temp,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    session = relay.createLiveSession({ cwd, model: 'fixture-lifecycle-model', runtimeEnv, tools: [], mcpServers: {}, includeRelayInstructions: false,
      runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {}, persistSession: false, maxTurns: 2 } },
      canUseTool: async () => ({ behavior: 'deny', message: 'Fixture executes no tools' }),
      onMessage(event) {
        report.events[event.type] = (report.events[event.type] || 0) + 1;
        if (event.type === 'result') { report.result = { atMs: elapsed(), subtype: event.subtype, isError: event.is_error, readyText: event.result === 'READY' }; resultResolve(event); }
      },
      onExit(exitCode) { report.lifecycle.push({ event: 'relay-onExit', atMs: elapsed(), exitCode }); },
    });
    session.whenClosed().then(value => { confirmed = value.stopConfirmed === true; report.closed = { ...value, error: value.error ? '[fixture error]' : null, atMs: elapsed() }; });
    await session.whenReady({ timeoutMs: 10000 }); ownPid(); await sample();
    monitor = setInterval(() => { void sample(); }, limits.sampleMs);
    assert.equal(session.push('Reply exactly READY.', { uuid: randomUUID() }), true);
    const result = await resultPromise;
    assert.equal(result.is_error, false); assert.equal(result.result, 'READY');
    report.checks.push('Real native SDK produced the synthetic READY result through Relay.createLiveSession');
    report.lifecycle.push({ event: 'kill-request', atMs: elapsed(), pid: ownPid() });
    const firstKill = session.kill(), closed = await session.whenClosed();
    assert.equal(closed.stopConfirmed, true); assert.ok(Number.isInteger(closed.nativeExitCode), 'Native numeric exit code is present');
    assert.equal(await firstKill, closed); report.checks.push('kill/whenClosed confirm native exit and expose nativeExitCode');
    const repeatedKill = session.kill(); assert.equal(repeatedKill, firstKill); assert.equal(await repeatedKill, closed);
    assert.equal(report.lifecycle.filter(e => e.event === 'relay-onExit').length, 1);
    report.checks.push('kill after confirmed exit is idempotent and onExit fires once');
    assert.ok(report.requests.length > 0 && report.requests.every(r => r.syntheticCredential && r.model === 'fixture-lifecycle-model' && r.toolCount === 0));
    assert.ok(report.samples.length > 0 && report.samples.every(s => s.privateBytes <= limits.privateBytes));
    report.checks.push('Only loopback synthetic requests, no tools, and sampled private memory below 512 MiB');
    report.ok = report.errors.length === 0;
  } catch (error) { fail(error.message); process.exitCode = 1; }
  finally {
    clearInterval(monitor);
    if (session && !confirmed) { session.kill(); emergencyStop(); await session.whenClosed(); }
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    clearTimeout(deadline); report.elapsedMs = elapsed(); save();
    console.log(JSON.stringify({ ok: report.ok, electron: report.electron, node: report.node, pid: ownedPid,
      elapsedMs: report.elapsedMs, closed: report.closed, checks: report.checks, errors: report.errors }, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
run().catch(error => { fail(error.message); emergencyStop(); save(); process.exit(1); });
