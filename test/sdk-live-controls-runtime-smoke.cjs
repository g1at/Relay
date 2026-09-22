'use strict';
// One real bundled SDK Query, one temporary plugin, synthetic loopback API.
// The only executed model tool is a bounded background sleep in a temp directory.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../src/main/sdk/claude-sdk');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-live-controls-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace'), plugin = path.join(base, 'fixture-plugin');
for (const dir of [config, cwd, path.join(plugin, '.claude-plugin')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'relay-live-fixture', version: '1.0.0', description: 'Temporary control-channel test plugin' }));
const output = path.join(__dirname, '../.codex-tmp/sdk-live-controls-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform,
  checks: [], requests: [], taskEvents: [], results: [], starts: [], stderr: [], errors: [] };
let query, pump, stopToolSent = false, ended = false, wake;
const inputQueue = [], allEvents = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await sleep(30); }
}
function check(label, condition) { assert.ok(condition, label); report.checks.push(label); }
function send(text) {
  inputQueue.push({ type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: text } });
  if (wake) { wake(); wake = null; }
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const text = JSON.stringify(body.messages || []);
    const stage = text.includes('FIXTURE_AFTER_STOP') ? 'after-stop' : text.includes('FIXTURE_STOP_START') ? 'stop-start'
      : text.includes('FIXTURE_AFTER_RELOAD') ? 'after-reload' : 'baseline';
    report.requests.push({ stage, model: body.model, tools: (body.tools || []).map(tool => tool.name) });
    const blocks = stage === 'stop-start' && !stopToolSent ? [{ type: 'tool_use', id: 'fixture_background_sleep', name: 'Bash',
      input: { command: 'sleep 60', description: 'Wait in a temporary fixture only', run_in_background: true } }]
      : [{ type: 'text', text: `${stage}-ok` }];
    if (blocks[0].type === 'tool_use') stopToolSent = true;
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
      stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    blocks.forEach((block, index) => {
      emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      emit('content_block_stop', { type: 'content_block_stop', index });
    });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  });
});
const deadline = setTimeout(() => { report.errors.push('Control fixture exceeded 120 seconds'); query?.close(); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 120000);
async function run() {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const options = relay._buildOptions({ cwd, model: 'fixture-live-model', tools: ['Bash', 'Skill', 'Agent', 'Read'], permissionMode: 'default',
      runtimePolicy: { settingSources: [] }, runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-live-control-key', ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-live-model',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      canUseTool: async (name, input) => name === 'Bash' && input.command === 'sleep 60' && input.run_in_background === true
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the bounded fixture sleep is allowed' },
      onSpawn: child => report.starts.push(child.pid), stderr: value => report.stderr.push(value.slice(0, 1500)),
    }, sdk);
    options.settingSources = []; options.persistSession = false; options.maxTurns = 8;
    options.plugins = [{ type: 'local', path: plugin }];
    options.perTaskStopAffordance = true;
    query = sdk.query({ prompt: (async function* () { while (!ended) { if (inputQueue.length) yield inputQueue.shift(); else await new Promise(resolve => { wake = resolve; }); } })(), options });
    const originalQuery = query;
    pump = (async () => { for await (const event of query) {
      allEvents.push(event);
      if (event.type === 'system' && event.subtype?.startsWith('task_')) report.taskEvents.push(event);
      if (event.type === 'result') report.results.push({ subtype: event.subtype, is_error: event.is_error, result: event.result, session_id: event.session_id });
    } })(); pump.catch(error => { report.pumpError = error.message; });
    const initial = await query.initializationResult();
    report.initial = { agents: initial.agents, commands: initial.commands };
    send('FIXTURE_BASELINE'); await until(() => report.results.some(result => result.result === 'baseline-ok'), 'initial turn');
    fs.mkdirSync(path.join(plugin, 'agents')); fs.mkdirSync(path.join(plugin, 'skills', 'hot-added'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'agents', 'hot-worker.md'), '---\nname: hot-worker\ndescription: Dynamically added fixture worker\ntools: Read\n---\nFixture worker; do not execute tools.');
    fs.writeFileSync(path.join(plugin, 'skills', 'hot-added', 'SKILL.md'), '---\nname: hot-added\ndescription: Dynamically added fixture skill\n---\nReply with fixture-only content.');
    report.reload = await query.reloadPlugins();
    check('reloadPlugins returns refreshed commands, agents and MCP status arrays', ['commands', 'agents', 'mcpServers'].every(key => Array.isArray(report.reload[key])));
    check('reloadPlugins sees a skill added after Query startup', JSON.stringify(report.reload.commands).includes('hot-added'));
    check('reloadPlugins sees an Agent added after Query startup', JSON.stringify(report.reload.agents).includes('hot-worker'));
    check('reloadPlugins returns the local plugin and no errors', report.reload.plugins.some(item => item.name === 'relay-live-fixture') && report.reload.error_count === 0);
    send('FIXTURE_AFTER_RELOAD'); await until(() => report.results.some(result => result.result === 'after-reload-ok'), 'turn after reload');
    check('reloadPlugins preserves the Query and child process', originalQuery === query && report.starts.length === 1);
    send('FIXTURE_STOP_START');
    await until(() => report.taskEvents.some(event => event.subtype === 'task_started' && event.task_id), 'background task id');
    const task = report.taskEvents.find(event => event.subtype === 'task_started' && event.task_id);
    report.stoppedTaskId = task.task_id;
    await query.stopTask(task.task_id);
    await until(() => report.taskEvents.some(event => event.subtype === 'task_notification' && event.task_id === task.task_id && event.status === 'stopped'), 'matching stopped notification');
    check('stopTask emits stopped for the exact native background task', true);
    await until(() => report.results.some(result => result.result === 'stop-start-ok'), 'background-start turn completion');
    send('FIXTURE_AFTER_STOP'); await until(() => report.results.some(result => result.result === 'after-stop-ok'), 'main Query continues after stopping task');
    check('stopping a task preserves the main Query and next input', originalQuery === query && report.starts.length === 1);
    check('all user turns share the same SDK session', new Set(report.results.map(result => result.session_id)).size === 1);
    check('all model requests use the selected provider model', report.requests.every(request => request.model === 'fixture-live-model'));
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); ended = true; if (wake) wake(); query?.close(); await pump?.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
