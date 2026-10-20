'use strict';
// Real bundled SDK and loopback fake model only. All configuration and cwd are isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const output = path.resolve(__dirname, '../.codex-tmp/subagent-stream-2026-10-14');
fs.mkdirSync(output, { recursive: true });
const base = fs.mkdtempSync(path.join(output, 'isolated-scope-'));
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(),
  platform: process.platform, isolation: { syntheticCredentials: true, loopbackOnly: true, isolatedHomeConfigCwd: true, realMcp: false, businessToolsExecuted: 0 },
  checks: [], scenarios: [], errors: [] };
let active, live;
function send(res, body, blocks) {
  const stop = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of blocks.entries()) {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  }
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const child = JSON.stringify(body.system || '').includes('RELAY_SUBAGENT_SCOPE_MARKER');
    const names = (body.tools || []).map(tool => tool.name);
    active.requests.push({ child, model: body.model, tools: names });
    if (child) { active.childRequests++; send(res, body, [{ type: 'text', text: 'SUBAGENT_SCOPE_COMPLETE' }]); return; }
    active.parentRequests++;
    const blocks = active.parentRequests === 1 ? [{ type: 'tool_use', id: 'call_' + randomUUID(), name: 'Agent', input: {
      subagent_type: active.agentName, description: 'Probe synthetic agent tool scope', prompt: 'Return SUBAGENT_SCOPE_COMPLETE without invoking any tools.',
    } }] : [{ type: 'text', text: 'PARENT_SCOPE_COMPLETE' }];
    send(res, body, blocks);
  });
});
async function until(predicate, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
const watchdog = setTimeout(() => { report.errors.push('Fixture exceeded 120 seconds'); report.ok = false; live?.close(); server.closeAllConnections(); server.close();
  fs.writeFileSync(path.join(output, 'sdk-subagent-tool-scope-' + process.platform + '.json'), JSON.stringify(report, null, 2)); process.exit(1); }, 120000);
async function run() {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sdk = await relay.loadSdk();
    for (const source of ['api', 'yaml']) for (const empty of [true, false]) {
      const name = source + '-' + (empty ? 'empty' : 'inherit');
      active = { name, source, explicitEmptyTools: empty, agentName: 'scope-fixture', parentRequests: 0, childRequests: 0, requests: [], events: [], stderr: [] };
      const state = active; report.scenarios.push(state);
      const cwd = path.join(base, name, 'workspace'), home = path.join(base, name, 'home'), config = path.join(home, '.claude'), temp = path.join(base, name, 'tmp');
      for (const dir of [cwd, home, config, temp]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(config, 'settings.json'), '{}');
      const definition = { description: 'Synthetic scope fixture only', prompt: 'RELAY_SUBAGENT_SCOPE_MARKER. Reply text only without invoking tools.', model: 'inherit', ...(empty ? { tools: [] } : {}) };
      if (source === 'yaml') { fs.mkdirSync(path.join(config, 'agents')); fs.writeFileSync(path.join(config, 'agents/scope-fixture.md'),
        '---\nname: scope-fixture\ndescription: Synthetic scope fixture only\nmodel: inherit\n' + (empty ? 'tools: []\n' : '') + '---\n' + definition.prompt + '\n'); }
      const runtimeEnv = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), TEMP: temp, TMP: temp, TMPDIR: temp,
        CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_API_KEY: 'synthetic-scope-key', ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_MODEL: 'fixture-scope-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
        ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
      const options = relay._buildOptions({ cwd, model: 'fixture-scope-model', tools: ['Agent', 'Read'], runtimeEnv, includeRelayInstructions: false,
        runtimePolicy: { settingSources: source === 'yaml' ? ['user'] : [] }, canUseTool: async (tool, input) => tool === 'Agent'
          ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Scope fixture never executes business tools' },
        stderr: text => state.stderr.push(String(text).slice(0, 500)) }, sdk);
      options.strictMcpConfig = true; options.mcpServers = {}; options.persistSession = false; options.maxTurns = 5;
      if (source === 'api') options.agents = { 'scope-fixture': definition };
      let stopInput; const gate = new Promise(resolve => { stopInput = resolve; });
      live = sdk.query({ prompt: (async function* () { yield { type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
        message: { role: 'user', content: 'Launch the synthetic scope-fixture subagent and finish after its text reply.' } }; await gate; })(), options });
      let pumpError;
      const pump = (async () => { try { for await (const event of live) {
        if (event.type === 'system' && event.subtype === 'task_notification') state.completed = event.status === 'completed';
        if (event.type === 'assistant' && event.agent_id) state.childForwarded = true;
        if (event.type === 'user') for (const block of Array.isArray(event.message?.content) ? event.message.content : []) if (block.type === 'tool_result')
          state.events.push({ type: 'tool_result', isError: !!block.is_error, content: JSON.stringify(block.content).slice(0, 500) });
      } } catch (error) { pumpError = error; } })();
      try { await until(() => state.childRequests > 0 || pumpError, name + ' child request'); if (pumpError) throw pumpError;
        await until(() => state.completed || state.events.some(event => event.content.includes('SUBAGENT_SCOPE_COMPLETE')) || pumpError, name + ' child complete');
        if (pumpError) throw pumpError;
      } finally { stopInput(); live.close(); await pump; live = null; }
      check(name + ': parent received Agent and Read', state.requests.filter(req => !req.child).every(req => req.tools.includes('Agent') && req.tools.includes('Read')));
      check(name + ': child request observed', state.childRequests > 0);
      const childTools = state.requests.filter(req => req.child).map(req => req.tools);
      if (empty) check(name + ': explicit tools [] gives zero child tools', childTools.every(tools => tools.length === 0));
      else check(name + ': omitted tools inherits Read', childTools.every(tools => tools.includes('Read')));
      check(name + ': synthetic child completed without tool errors', state.completed && state.events.every(event => !event.isError));
    }
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { clearTimeout(watchdog); live?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, 'sdk-subagent-tool-scope-' + process.platform + '.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
