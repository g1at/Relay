'use strict';
// Real bundled SDK/CLI and native Write; the model is a deterministic loopback
// endpoint. No user config, real credentials, external MCP or business tools.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const { createTurnDeliveryHooks } = require('../src/main/app/turn-delivery-hooks');
const { createTurnDeliveryService } = require('../src/main/app/turn-delivery-service');
const { createDeliveryProgressStore } = require('../src/main/app/turn-delivery-progress');
const out = path.resolve(__dirname, '../.codex-tmp/delivery-latency-audit-2026-10-15');
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-delivery-'));
const projectOutput = process.argv.includes('--project');
const cwd = path.join(root, 'workspace'), outputs = path.join(cwd, projectOutput ? 'reports' : 'outputs'), home = path.join(root, 'home');
const declaredOutputDir = projectOutput ? cwd : outputs;
const config = path.join(home, '.claude'), scratch = path.join(root, 'scratch');
for (const directory of [cwd, outputs, config, scratch]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform,
  projectOutputDirEqualsCwd: projectOutput, outputLayout: { declaredEqualsCwd: declaredOutputDir === cwd, writeSubdir: path.relative(cwd, outputs) },
  isolation: { realCli: true, nativeWrite: true, loopbackOnly: true, syntheticCredentials: true, isolatedHomeConfigCwd: true, mcp: false },
  requests: [], hooks: [], checks: [], errors: [] };
const scope = { conversationId: randomUUID(), runId: randomUUID(), turnTs: new Date().toISOString() };
let record = { id: scope.conversationId, turns: [{ runId: scope.runId, ts: scope.turnTs }] };
const progress = createDeliveryProgressStore({ rootDir: path.join(root, 'progress'), canWrite: id => id === record?.id });
const updates = [], problems = [];
const service = createTurnDeliveryService({ load: id => id === record?.id ? structuredClone(record) : null,
  persist: value => { record = structuredClone(value); return true; }, canWrite: id => id === record?.id,
  progress, emit: value => updates.push(value.snapshot), onError: error => problems.push(error.message) });
const observer = createTurnDeliveryHooks({ observe: (runId, event) => { report.bridgeEvents ||= []; report.bridgeEvents.push({ type: event.type, agentId: event.agent_id || null, toolId: event.message.content[0].id || event.message.content[0].tool_use_id }); service.observe(runId, event); }, isActive: service.isActive });
let query, parentRequests = 0, childRequests = 0, finalResult, pumpError;
function send(res, body, content) {
  const stop = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 24, output_tokens: 10 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, value) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n');
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of content.entries()) {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  }
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":24}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const child = JSON.stringify(body.system || '').includes('RELAY_DELIVERY_CHILD_MARKER');
      report.requests.push({ child, model: body.model, tools: (body.tools || []).map(tool => tool.name) });
      let content;
      if (child) content = ++childRequests === 1
        ? [{ type: 'tool_use', id: 'toolu_child_write', name: 'Write', input: { file_path: path.join(outputs, 'child.md'), content: 'Synthetic child delivery.\n' } }]
        : [{ type: 'text', text: 'CHILD_DELIVERY_COMPLETE' }];
      else {
        parentRequests++;
        content = parentRequests === 1
          ? [{ type: 'tool_use', id: 'toolu_parent_write', name: 'Write', input: { file_path: path.join(outputs, 'parent.md'), content: 'Synthetic parent delivery.\n' } }]
          : parentRequests === 2 ? [{ type: 'tool_use', id: 'toolu_child_agent', name: 'Agent', input: { subagent_type: 'delivery-fixture', description: 'Write isolated child fixture', prompt: 'Write the synthetic child delivery and then finish.' } }]
          : [{ type: 'text', text: 'PARENT_DELIVERY_COMPLETE' }];
      }
      send(res, body, content);
    } catch (error) { report.errors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
});
function check(name, condition) { assert.ok(condition, name); report.checks.push(name); }
async function until(predicate, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (pumpError) throw pumpError; if (Date.now() > end) throw Error('Timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function save() { fs.writeFileSync(path.join(out, 'sdk-delivery-hooks-' + (projectOutput ? 'project-' : '') + process.platform + '.json'), JSON.stringify(report, null, 2) + '\n'); }
const deadline = setTimeout(() => { report.errors.push('Native fixture exceeded 100 seconds'); report.ok = false; save(); query?.close(); server.closeAllConnections(); process.exit(1); }, 100000);
(async () => {
  let release, pump;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const runtimeEnv = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'),
      TEMP: scratch, TMP: scratch, TMPDIR: scratch, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-delivery-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, ANTHROPIC_MODEL: 'fixture-delivery-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}) };
    const sdk = await relay.loadSdk();
    const options = relay._buildOptions({ cwd, scratchDir: scratch, outputDir: declaredOutputDir, model: 'fixture-delivery-model', tools: ['Agent', 'Write'],
      includeRelayInstructions: false, runtimeEnv, runtimePolicy: { settingSources: [] },
      canUseTool: async (name, input) => name === 'Agent' && input.subagent_type === 'delivery-fixture'
        || name === 'Write' && [path.join(outputs, 'parent.md'), path.join(outputs, 'child.md')].includes(input.file_path)
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Fixture permits only two isolated writes and its fixture agent' },
      onNativeHook: (input, toolUseId) => {
        if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(input.hook_event_name)) report.hooks.push({ event: input.hook_event_name,
          tool: input.tool_name, sessionId: input.session_id, agentId: input.agent_id || null, callbackToolUseId: toolUseId || null, inputToolUseId: input.tool_use_id || null,
          file: input.tool_input?.file_path ? path.basename(input.tool_input.file_path) : null, filePath: input.tool_input?.file_path, cwd: input.cwd, active: service.isActive(scope.runId, scope.conversationId) });
        observer.observe(input, toolUseId, scope);
      }, stderr: text => { report.stderr ||= []; if (report.stderr.length < 8) report.stderr.push(String(text).slice(0, 300)); } }, sdk);
    options.strictMcpConfig = true; options.mcpServers = {}; options.persistSession = false; options.maxTurns = 8;
    options.agents = { 'delivery-fixture': { description: 'Synthetic delivery fixture', prompt: 'RELAY_DELIVERY_CHILD_MARKER. Write only the synthetic fixture.', tools: ['Write'], model: 'inherit' } };
    await service.begin({ ...scope, cwd, outputDir: declaredOutputDir, scratchDir: scratch });
    const gate = new Promise(resolve => { release = resolve; });
    query = sdk.query({ prompt: (async function* () { yield { type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: 'user', content: 'Write the synthetic parent fixture, delegate the child fixture, and finish.' } }; await gate; })(), options });
    pump = (async () => { try { for await (const event of query) {
      // Observe actual SDK intent/text, but intentionally omit native tool_result
      // to prove successful hook receipts alone can recover child deliveries.
      if (event.type !== 'user') service.observe(scope.runId, { ...event, jobId: scope.runId });
      if (event.type === 'result' && !event.parent_tool_use_id) finalResult = event;
    } } catch (error) { pumpError = error; } })();
    await until(() => report.hooks.filter(h => h.event === 'PostToolUse' && h.tool === 'Write').length === 2 && finalResult, 'two real writes and final root result');
    const writes = report.hooks.filter(h => h.tool === 'Write');
    check('real CLI emits PreToolUse and PostToolUse for parent and child Write', writes.length === 4);
    check('callback toolUseId agrees with input.tool_use_id', writes.every(h => h.callbackToolUseId === h.inputToolUseId));
    const parent = writes.find(h => h.file === 'parent.md'), child = writes.find(h => h.file === 'child.md');
    report.identity = { rootHookSessionId: parent.sessionId, childHookSessionId: child.sessionId, childAgentId: child.agentId, sameHookSession: parent.sessionId === child.sessionId };
    check('child write hook has agent_id while parent has none', !!child.agentId && !parent.agentId);
    check('real fixture files exist with exact synthetic content', fs.readFileSync(path.join(outputs, 'parent.md'), 'utf8') === 'Synthetic parent delivery.\n'
      && fs.readFileSync(path.join(outputs, 'child.md'), 'utf8') === 'Synthetic child delivery.\n');
    await until(() => updates.some(value => value.items.length === 2), 'both hook deliveries visible before finalization', 3000);
    const recovery = await progress.read(scope.conversationId); check('confirmed parent and child deliveries persist before full history commit', recovery.some(value => value.items.length === 2));
    const finished = await service.finish(scope.runId); check('service finishes with two hook-verified deliveries', finished?.items.length === 2 && finished.items.every(i => i.source === 'write-tool'));
    check('final history has two deliveries and no residual progress sidecar', record.turns[0].deliverables.items.length === 2 && (await progress.read(scope.conversationId)).length === 0);
    check('no storage or registry errors', problems.length === 0); report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); release?.(); query?.close(); if (pump) await pump; observer.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); report.cleanedUp = true; }
    catch (error) { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; }
    report.serviceErrors = problems; report.updateSummary = updates.map(value => ({ status: value.status, names: value.items.map(item => item.name), warnings: value.warnings })); save(); console.log(JSON.stringify({ ok: report.ok, identity: report.identity, checks: report.checks, errors: report.errors, serviceErrors: problems }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
