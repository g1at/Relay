'use strict';
// Real bundled SDK/CLI, isolated profile, deterministic loopback provider.
// The only requested tool is held at a forced permission gate; it never runs.
if (!process.argv.includes('--run')) { console.log('Opt-in only: node test/sdk-usage-checkpoint-runtime-smoke.cjs --run'); process.exit(0); }
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { createUsageObserver } = require('../src/main/usage/usage-capture');
const { applyUsageRecord, emptyIndex } = require('../src/main/usage/usage-stats-worker');
const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const numbers = value => Object.fromEntries(Object.entries(value || {}).map(([model, usage]) => [model, Object.fromEntries(fields.map(field => [field, usage[field]]))]));
const sum = value => Object.values(value || {}).reduce((total, usage) => total + fields.reduce((n, field) => n + (usage[field] || 0), 0), 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-checkpoint-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace'), home = path.join(base, 'home'), temp = path.join(base, 'temp');
for (const dir of [config, cwd, home, temp, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, systemEnv, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: config,
  ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
const relay = require('../src/main/sdk/claude-sdk');
const { withDrainedExit } = require('../src/main/sdk/sdk-process-adapter');
const output = path.join(__dirname, '../.codex-tmp/sdk-usage-checkpoint-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform,
  electron: process.versions.electron || null, isolation: { cleanHome: true, cleanConfig: true, cleanCwd: true, cleanTemp: true, settingSources: [], strictMcpConfig: true },
  limits: { totalMs: 100000, privateBytes: 512 * 1024 * 1024, maxRequests: 12 }, checks: [], requests: [], samples: [], errors: [] };
let current = null, releaseTool = null, toolWaiting = false, monitorBusy = false;
const records = [];
async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await sleep(25); }
}
function check(label, condition) { assert.ok(condition, label); report.checks.push(label); }
const proxy = http.createServer((_req, res) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; res.writeHead(403); res.end(); });
proxy.on('connect', (_req, socket) => { report.blockedExternalRequests = (report.blockedExternalRequests || 0) + 1; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const hold = JSON.stringify(body.messages || []).includes('FIXTURE_HOLD');
    report.requests.push({ model: body.model, hold, syntheticCredential: req.headers['x-api-key'] === 'synthetic-usage-key' });
    if (report.requests.length > report.limits.maxRequests) { report.errors.push('Synthetic request limit exceeded'); current?.forceStop(); res.writeHead(429); res.end('{}'); return; }
    const block = hold ? { type: 'tool_use', id: 'fixture_held_tool', name: 'Bash', input: { command: 'echo synthetic-checkpoint-fixture', description: 'Never executed: held by the fixture permission gate' } }
      : { type: 'text', text: 'SYNTHETIC_USAGE_OK' };
    const usage = { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 };
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [block],
      stop_reason: hold ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: hold ? { ...block, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: hold ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
    emit('message_stop', { type: 'message_stop' }); res.end();
  });
});
async function open(sdk, sessionId, label = 'fresh', forkOptions = {}) {
  assert.equal(current, null, 'only one fixture CLI at a time');
  let ended = false, wake; const input = [], results = [], resets = [], assistants = [], usageRecords = [], startupEvents = [];
  const abortController = new AbortController();
  let child = null, childExit = null, query, hookRawUsage = null;
  const observe = createUsageObserver(record => { records.push(record); usageRecords.push(record); }, { inheritedCounters: !!sessionId, checkpointIntervalMs: 100 });
  const options = relay._buildOptions({ cwd, sessionId, ...forkOptions, model: 'fixture-usage-model', tools: ['Bash'], permissionMode: 'default', abortController,
    onSpawn(value) { child = value; childExit = new Promise(resolve => value.once('exit', resolve)); },
    runtimePolicy: { settingSources: [] }, runtimeEnv: { ...process.env, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-usage-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-usage-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true', CLAUDE_CODE_TMPDIR: temp,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].map(key => [key, `http://127.0.0.1:${proxy.address().port}`])),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    canUseTool: async () => { toolWaiting = true; return new Promise(resolve => { releaseTool = () => resolve({ behavior: 'deny', message: 'Synthetic fixture complete; never execute tools' }); }); },
  }, sdk);
  options.strictMcpConfig = true; options.mcpServers = {}; options.settingSources = []; options.maxTurns = 3;
  options.hooks = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })] }],
    UserPromptSubmit: [{ hooks: [async () => {
      if (sessionId && hookRawUsage === null) {
        hookRawUsage = numbers((await query[method]({ skipBehaviors: true })).session.model_usage);
      }
      return {};
    }] }] };
  const spawnProcess = options.spawnClaudeCodeProcess;
  options.spawnClaudeCodeProcess = value => withDrainedExit(spawnProcess(value), { onStderr: () => {} });
  query = sdk.query({ prompt: (async function* () { while (!ended) { if (input.length) yield input.shift(); else await new Promise(resolve => { wake = resolve; }); } })(), options });
  observe.attach(query);
  const pump = (async () => { for await (const event of query) {
    observe(event);
    if (!input.length && !results.length && event.type === 'system') startupEvents.push({ type: event.type, subtype: event.subtype, state: event.state });
    if (event.type === 'assistant' && !event.parent_tool_use_id) assistants.push({ uuid: event.uuid, text: event.message?.content?.some(block => block.text === 'SYNTHETIC_USAGE_OK') });
    if (event.type === 'result') results.push({ sessionId: event.session_id, isError: event.is_error, modelUsage: numbers(event.modelUsage),
      userMessageId: event.user_message_uuid, numTurns: event.num_turns, apiMs: event.duration_api_ms });
    if (event.type === 'conversation_reset') resets.push({ old: event.old_conversation_id, next: event.new_conversation_id });
  } })(); pump.catch(() => {});
  const handle = { query, results, resets, assistants, usageRecords, label, startupEvents,
    get hookRawUsage() { return hookRawUsage; },
    get pid() { return child?.pid; }, get exited() { return child && (child.exitCode !== null || child.signalCode !== null); },
    forceStop() { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },
    send(text) { input.push({ type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: text } }); wake?.(); wake = null; },
    usage: async () => numbers((await query[method]({ skipBehaviors: true })).session.model_usage),
    async close() {
      observe.stop(); ended = true; wake?.();
      // Let an idle successful session flush its persisted usage before abort.
      if (!toolWaiting) await Promise.race([pump.catch(() => {}), sleep(1500)]);
      abortController.abort();
      // This last scenario deliberately has no terminal result. Terminate
      // only its own fixture CLI before releasing the held permission promise.
      if (toolWaiting) handle.forceStop();
      query.close();
      await Promise.race([pump.catch(() => {}), sleep(2000)]);
      if (childExit) {
        await Promise.race([childExit, sleep(2000)]);
        if (child.exitCode === null && child.signalCode === null) handle.forceStop();
        await Promise.race([childExit, sleep(2000)]);
        assert.ok(handle.exited, 'fixture native CLI must exit before another starts');
      }
      releaseTool?.(); releaseTool = null;
      observe.close();
    },
  };
  current = handle; await query.initializationResult();
  handle.initialRawUsage = await handle.usage();
  await until(() => !monitorBusy, 'previous fixture memory sample', 4000);
  await sampleMemory();
  handle.baseline = await observe.prepareBaseline(query, { signal: abortController.signal });
  assert.equal(handle.baseline.status, 'ready');
  return handle;
}
const deadline = setTimeout(() => { report.errors.push('Fixture exceeded 100 seconds'); current?.forceStop(); releaseTool?.(); server.closeAllConnections(); server.close(); proxy.closeAllConnections(); proxy.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, report.limits.totalMs);
async function sampleMemory() {
  const handle = current;
  if (process.platform !== 'win32' || monitorBusy || !handle?.pid || handle.exited) return;
  monitorBusy = true;
  try {
    const script = `$p=Get-Process -Id ${handle.pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;privateBytes=$p.PrivateMemorySize64}|ConvertTo-Json -Compress`;
    const sample = await new Promise((resolve, reject) => cp.execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 3000, maxBuffer: 4096 },
      (error, stdout) => { if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } }));
    report.samples.push({ label: handle.label, ...sample });
    if (sample.privateBytes > report.limits.privateBytes) { report.errors.push('Fixture CLI exceeded memory limit'); handle.forceStop(); }
  } catch (error) {
    report.memorySampleUnavailable = (report.memorySampleUnavailable || 0) + 1;
    report.memorySampleErrors ||= []; report.memorySampleErrors.push({ label: handle.label, code: String(error.code || error.name || 'UNAVAILABLE'), timedOut: !!error.killed });
  }
  finally { monitorBusy = false; }
}
const monitor = setInterval(() => { void sampleMemory(); }, 750);
(async () => {
  try {
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const first = await open(sdk);
    check('fresh Query get_usage starts at zero', sum(await first.usage()) === 0);
    first.send('FIXTURE_FIRST'); await until(() => first.results.length === 1, 'first result');
    const firstUsage = await first.usage();
    assert.deepEqual(firstUsage, first.results[0].modelUsage); check('get_usage equals first result.modelUsage in all four token fields', sum(firstUsage) > 0);
    first.send('FIXTURE_SECOND'); await until(() => first.results.length === 2, 'second result');
    const secondUsage = await first.usage();
    assert.deepEqual(secondUsage, first.results[1].modelUsage); check('same Query get_usage and result both accumulate across turns', sum(secondUsage) === 2 * sum(firstUsage));
    const originalSession = first.results[0].sessionId;
    const firstAnswer = first.assistants.find(message => message.text)?.uuid;
    assert.ok(firstAnswer, 'first answer UUID is available for a boundary fork');
    report.firstQuery = { first: firstUsage, second: secondUsage };
    await first.close(); current = null;
    const fullFork = await sdk.forkSession(originalSession, { dir: cwd, title: 'Synthetic full fork' });
    const boundaryFork = await sdk.forkSession(originalSession, { dir: cwd, upToMessageId: firstAnswer, title: 'Synthetic boundary fork' });
    report.forks = [];
    for (const [label, sessionId, forkOptions] of [
      ['offline-full-fork', fullFork.sessionId, {}], ['offline-boundary-fork', boundaryFork.sessionId, {}],
      ['native-full-fork', originalSession, { forkSession: true, forkSessionId: randomUUID(), resumeSessionAt: first.assistants.filter(message => message.text).at(-1).uuid }],
      ['native-boundary-fork', originalSession, { forkSession: true, forkSessionId: randomUUID(), resumeSessionAt: firstAnswer }],
    ]) {
      const fork = await open(sdk, sessionId, label, forkOptions);
      report.forks.push({ label, initialRawUsage: fork.initialRawUsage });
      fork.send(`FIXTURE_${label}`); await until(() => fork.results.length === 1, `${label} result`);
      report.forks.at(-1).hookRawUsage = fork.hookRawUsage;
      report.forks.at(-1).finalRawUsage = await fork.usage();
      assert.ok(fork.hookRawUsage !== null, `${label} hook completed before model consumption`);
      assert.deepEqual(fork.hookRawUsage, fork.initialRawUsage, `${label} pre-input baseline already equals the pre-model hook baseline`);
      assert.deepEqual(subtract(report.forks.at(-1).finalRawUsage, fork.hookRawUsage), firstUsage,
        `${label} raw cumulative increment equals the known one-request provider usage`);
      check(`${label} hook baseline yields exactly the known provider increment`, true);
      const local = aggregatedTotal(fork.usageRecords);
      report.forks.at(-1).queryLocalTotal = local;
      check(`${label} observer excludes inherited counters and records only new request`, local === sum(firstUsage));
      await fork.close(); current = null;
    }
    const resumed = await open(sdk, originalSession, 'resume');
    report.resumeInitialUsage = resumed.initialRawUsage;
    resumed.send('FIXTURE_RESUMED'); await until(() => resumed.results.length === 1, 'resumed result');
    report.resumeHookUsage = resumed.hookRawUsage;
    assert.deepEqual(resumed.hookRawUsage, resumed.initialRawUsage);
    const resumedUsage = await resumed.usage();
    assert.deepEqual(resumedUsage, resumed.results[0].modelUsage);
    report.resumeFinalUsage = resumedUsage;
    assert.deepEqual(subtract(resumedUsage, resumed.hookRawUsage), firstUsage);
    check('resumed raw counters minus hook baseline match the known new request', aggregatedTotal(resumed.usageRecords) === sum(firstUsage));
    check('resumed Query preserves the native session ID', resumed.results[0].sessionId === originalSession);
    const beforeClear = resumed.results.length;
    resumed.send('/clear'); await until(() => resumed.resets.length === 1
      && resumed.results.slice(beforeClear).some(value => value.numTurns === 0 && value.apiMs === 0), 'native conversation reset and local command acknowledgement');
    report.reset = resumed.resets[0]; report.afterClearUsage = await resumed.usage();
    check('native /clear resets get_usage counters without a new Query', sum(report.afterClearUsage) === 0);
    const beforeHold = resumed.results.length, beforeRecords = records.length;
    resumed.send('FIXTURE_HOLD'); await until(() => toolWaiting, 'held synthetic tool permission');
    await until(() => records.slice(beforeRecords).some(record => record.resultId.startsWith('checkpoint:') && sum(record.modelUsage) > 0), 'checkpoint before any result', 10000);
    check('positive authoritative checkpoint is durable-input-ready while the turn has no result', resumed.results.length === beforeHold);
    const held = records.slice(beforeRecords).find(record => record.resultId.startsWith('checkpoint:') && sum(record.modelUsage) > 0);
    check('post-clear checkpoint uses the new native session identity', held.sessionId === report.reset.next);
    const heldUsage = await resumed.usage(); assert.deepEqual(numbers(held.modelUsage), heldUsage);
    report.heldCheckpoint = { sessionMatchesReset: true, modelUsage: heldUsage };
    await resumed.close(); current = null;
    await verifyRelayAdapter('live', fullFork.sessionId, sum(firstUsage));
    await verifyRelayAdapter('one-shot', fullFork.sessionId, sum(firstUsage));
    const state = emptyIndex('runtime-fixture').usage;
    for (const record of records) { applyUsageRecord(state, record); applyUsageRecord(state, record); }
    const total = Object.values(state.days).reduce((n, day) => n + sum(day.models), 0);
    report.total = total; report.expectedTotal = sum(secondUsage) + 7 * sum(firstUsage) + sum(heldUsage);
    check('checkpoints, final results, repeated delivery, resume and clear do not double-count', total === report.expectedTotal);
    check('all provider requests use only the synthetic loopback credentials and model', report.requests.every(request => request.syntheticCredential && request.model === 'fixture-usage-model'));
    check('no baseline fallback was needed during real initialize/resume/fork acceptance', records.every(record => !record.usageIncomplete));
    check('successful owned-process memory samples are under 512 MiB', process.platform !== 'win32' || report.samples.length > 0 && report.samples.every(sample => sample.privateBytes <= report.limits.privateBytes));
    report.ok = report.errors.length === 0;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearInterval(monitor); await current?.close(); server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    await until(() => !monitorBusy, 'memory sampler shutdown', 4000);
    clearTimeout(deadline);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); report.cleanedUp = true; }
    catch (error) { report.cleanedUp = false; report.ok = false; process.exitCode = 1; report.errors.push(`Fixture cleanup: ${error.message}`); }
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

function aggregatedTotal(items) {
  const state = emptyIndex('query-fixture').usage;
  for (const record of items) applyUsageRecord(state, record);
  return Object.values(state.days).reduce((total, day) => total + sum(day.models), 0);
}
function subtract(current, previous) {
  return Object.fromEntries(Object.entries(current).map(([model, value]) => [model,
    Object.fromEntries(fields.map(field => [field, value[field] - (previous?.[model]?.[field] || 0)]))]));
}

async function verifyRelayAdapter(kind, sessionId, expected) {
  assert.equal(current, null);
  const ownRecords = [], events = [];
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const options = { cwd, sessionId, model: 'fixture-usage-model', tools: [], mcpServers: {}, includeRelayInstructions: false,
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {}, maxTurns: 2 } },
    runtimeEnv: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-usage-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-usage-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', OTEL_SDK_DISABLED: 'true',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', CLAUDE_CODE_TMPDIR: temp,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      ...Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].map(key => [key, proxyUrl])),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    canUseTool: async () => ({ behavior: 'deny', message: 'Fixture runs no tools' }),
    onUsage(record) { ownRecords.push(record); records.push(record); },
  };
  let child, confirmed = false;
  if (kind === 'live') child = relay.createLiveSession({ ...options, onMessage(event) { events.push(event.type); }, onExit() {} });
  else child = relay.runOneShot({ ...options, prompt: 'FIXTURE_PRODUCT_ONESHOT', onEvent(event) { events.push(event.type); } }).handle;
  child.whenClosed().then(value => { confirmed = value.stopConfirmed; });
  current = { label: `relay-${kind}`, get pid() { return child.pid; }, get exited() { return confirmed; },
    forceStop() { if (!confirmed && Number.isSafeInteger(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} } },
    async close() { await child.kill(); assert.equal((await child.whenClosed()).stopConfirmed, true); },
  };
  if (kind === 'live') {
    await child.whenReady({ timeoutMs: 10000 }); await until(() => !monitorBusy, 'previous fixture memory sample', 4000); await sampleMemory();
    assert.equal(child.push('FIXTURE_PRODUCT_LIVE', { uuid: randomUUID() }), true);
    await until(() => events.includes('result'), 'Relay live result');
  } else await child.whenClosed();
  check(`Relay ${kind} adapter records only the real new request after resume`, aggregatedTotal(ownRecords) === expected);
  check(`Relay ${kind} baseline succeeds without incomplete-coverage fallback`, ownRecords.every(record => !record.usageIncomplete));
  report.adapterResults ||= []; report.adapterResults.push({ kind, queryLocalTotal: aggregatedTotal(ownRecords), records: ownRecords.length });
  await current.close(); current = null;
}
