'use strict';
// Real bundled SDK/CLI, isolated profile, deterministic loopback provider.
// The only requested tool is held at a forced permission gate; it never runs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../claude-sdk');
const { createUsageObserver } = require('../usage-capture');
const { applyUsageRecord, emptyIndex } = require('../usage-stats-worker');
const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const numbers = value => Object.fromEntries(Object.entries(value || {}).map(([model, usage]) => [model, Object.fromEntries(fields.map(field => [field, usage[field]]))]));
const sum = value => Object.values(value || {}).reduce((total, usage) => total + fields.reduce((n, field) => n + (usage[field] || 0), 0), 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-checkpoint-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const output = path.join(__dirname, '../.codex-tmp/sdk-usage-checkpoint-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform, checks: [], requests: [], errors: [] };
let current = null, releaseTool = null, toolWaiting = false;
const records = [];
async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await sleep(25); }
}
function check(label, condition) { assert.ok(condition, label); report.checks.push(label); }
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const hold = JSON.stringify(body.messages || []).includes('FIXTURE_HOLD');
    report.requests.push({ model: body.model, hold, syntheticCredential: req.headers['x-api-key'] === 'synthetic-usage-key' });
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
async function open(sdk, sessionId) {
  let ended = false, wake; const input = [], results = [], resets = [];
  const abortController = new AbortController();
  let child = null, childExit = null;
  const observe = createUsageObserver(record => records.push(record));
  const options = relay._buildOptions({ cwd, sessionId, model: 'fixture-usage-model', tools: ['Bash'], permissionMode: 'default', abortController,
    onSpawn(value) { child = value; childExit = new Promise(resolve => value.once('exit', resolve)); },
    runtimePolicy: { settingSources: [] }, runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-usage-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-usage-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
    canUseTool: async () => { toolWaiting = true; return new Promise(resolve => { releaseTool = () => resolve({ behavior: 'deny', message: 'Synthetic fixture complete; never execute tools' }); }); },
  }, sdk);
  options.strictMcpConfig = true; options.mcpServers = {}; options.settingSources = []; options.maxTurns = 3;
  options.hooks = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })] }] };
  const query = sdk.query({ prompt: (async function* () { while (!ended) { if (input.length) yield input.shift(); else await new Promise(resolve => { wake = resolve; }); } })(), options });
  observe.attach(query);
  const pump = (async () => { for await (const event of query) {
    observe(event);
    if (event.type === 'result') results.push({ sessionId: event.session_id, isError: event.is_error, modelUsage: numbers(event.modelUsage) });
    if (event.type === 'conversation_reset') resets.push({ old: event.old_conversation_id, next: event.new_conversation_id });
  } })(); pump.catch(() => {});
  const handle = { query, results, resets,
    send(text) { input.push({ type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: text } }); wake?.(); wake = null; },
    usage: async () => numbers((await query[method]({ skipBehaviors: true })).session.model_usage),
    async close() {
      observe.stop(); ended = true; wake?.(); abortController.abort();
      // This last scenario deliberately has no terminal result. Terminate
      // only its own fixture CLI before releasing the held permission promise.
      if (toolWaiting) child?.kill();
      query.close();
      await pump.catch(() => {});
      if (childExit) {
        await Promise.race([childExit, sleep(2000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.race([childExit, sleep(2000)]);
      }
      releaseTool?.(); releaseTool = null;
      observe.close();
    },
  };
  current = handle; await query.initializationResult(); return handle;
}
const deadline = setTimeout(() => { report.errors.push('Fixture exceeded 100 seconds'); current?.query.close(); releaseTool?.(); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 100000);
(async () => {
  try {
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
    report.firstQuery = { first: firstUsage, second: secondUsage };
    await first.close(); current = null;
    const resumed = await open(sdk, originalSession);
    report.resumeInitialUsage = await resumed.usage();
    check('resuming the same native session starts new Query counters at zero', sum(report.resumeInitialUsage) === 0);
    resumed.send('FIXTURE_RESUMED'); await until(() => resumed.results.length === 1, 'resumed result');
    const resumedUsage = await resumed.usage();
    assert.deepEqual(resumedUsage, resumed.results[0].modelUsage); assert.deepEqual(resumedUsage, firstUsage);
    check('resumed Query counts only its new request and preserves the native session ID', resumed.results[0].sessionId === originalSession);
    resumed.send('/clear'); await until(() => resumed.resets.length === 1, 'native conversation reset');
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
    const state = emptyIndex('runtime-fixture').usage;
    for (const record of records) { applyUsageRecord(state, record); applyUsageRecord(state, record); }
    const total = Object.values(state.days).reduce((n, day) => n + sum(day.models), 0);
    report.total = total; report.expectedTotal = sum(secondUsage) + sum(resumedUsage) + sum(heldUsage);
    check('checkpoints, final results, repeated delivery, resume and clear do not double-count', total === report.expectedTotal);
    check('all provider requests use only the synthetic loopback credentials and model', report.requests.every(request => request.syntheticCredential && request.model === 'fixture-usage-model'));
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); await current?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); report.cleanedUp = true; }
    catch (error) { report.cleanedUp = false; report.ok = false; process.exitCode = 1; report.errors.push(`Fixture cleanup: ${error.message}`); }
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
