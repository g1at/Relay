'use strict';
// Real SDK agent selection and structured output with synthetic loopback responses.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../src/main/sdk/claude-sdk');
const { buildNativeAgent } = require('../src/main/sdk/native-agent-definition');
const { collectStructuredOutput } = require('../src/main/sdk/sdk-structured-output');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-capabilities-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const output = path.join(__dirname, '../.codex-tmp/sdk-native-capabilities-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform, checks: [], scenarios: [], errors: [] };
let active, live;
const schema = { type: 'object', properties: { title: { type: 'string' }, approved: { type: 'boolean' }, count: { type: 'integer' } }, required: ['title', 'approved', 'count'], additionalProperties: false };
const expected = { title: 'fixture-title', approved: false, count: 3 };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const toolNames = (body.tools || []).map(tool => tool.name);
    active.requests.push({ model: body.model, tools: toolNames,
      nativeMarker: JSON.stringify(body.system || '').includes('RELAY_NATIVE_AGENT_MARKER'),
      hostMarker: JSON.stringify(body.system || '').includes('RELAY_HOST_RULE_MARKER'),
      structuredFormat: body.output_config?.format || body.output_format || null });
    const structuredTool = (body.tools || []).find(tool => /structured.?output/i.test(tool.name));
    const blocks = active.name === 'structured' && structuredTool
      ? [{ type: 'tool_use', id: 'call_' + randomUUID(), name: structuredTool.name, input: expected }]
      : [{ type: 'text', text: active.name === 'structured' ? JSON.stringify(expected) : 'native-agent-complete' }];
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
      stop_reason: structuredTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
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
const deadline = setTimeout(() => { report.errors.push('Runtime fixture exceeded 100 seconds'); live?.close(); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 100000);
async function run() {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-native-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-selected-model',
      CLAUDE_CODE_SUBAGENT_MODEL: 'must-not-route-here', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const nativeAgent = buildNativeAgent({ text: '---\nname: fixture-selected-agent\ndescription: A local fixture agent\nmodel: haiku\ntools: [Read]\n---\nRELAY_NATIVE_AGENT_MARKER. Answer with no tools.\n',
      selectedModel: 'fixture-selected-model', modelMap: { haiku: 'fixture-selected-model' }, allowedModels: ['fixture-selected-model'], parentInstructions: 'RELAY_HOST_RULE_MARKER. Synthetic local test only.', resourceRoot: cwd });
    for (const name of ['agent', 'structured']) {
      active = { name, requests: [], stderr: [], terminal: null }; report.scenarios.push(active);
      const state = active;
      const options = relay._buildOptions({ cwd, model: 'fixture-selected-model', runtimeEnv, permissionMode: 'default',
        runtimePolicy: { settingSources: [] }, tools: name === 'agent' ? ['Read', 'Write', 'Bash'] : [],
        nativeAgent: name === 'agent' ? nativeAgent : undefined,
        outputFormat: name === 'structured' ? { type: 'json_schema', schema } : undefined,
        canUseTool: async () => ({ behavior: 'deny', message: 'Fixture does not execute filesystem or shell tools' }),
        stderr: value => state.stderr.push(value.slice(0, 1500)),
      }, sdk);
      options.settingSources = []; options.persistSession = false; options.maxTurns = 4;
      live = sdk.query({ prompt: (async function* () { yield { type: 'user', session_id: '', parent_tool_use_id: null,
        message: { role: 'user', content: name === 'agent' ? 'Reply fixture success' : 'Return the requested fixture schema' } }; })(), options });
      try {
        if (name === 'structured') {
          state.parsed = await collectStructuredOutput(live, value => ({ success: JSON.stringify(value) === JSON.stringify(expected), data: value }), event => {
            if (event.type === 'result') state.terminal = { subtype: event.subtype, is_error: event.is_error, structured_output: event.structured_output, result: event.result };
          });
          assert.deepEqual(state.parsed, expected, 'native structured_output is parsed from final SDK result');
          assert.deepEqual(state.terminal.structured_output, expected);
          report.checks.push('structured: outputFormat + real SDK result.structured_output + Relay validator verified');
        } else {
          for await (const event of live) if (event.type === 'result') state.terminal = { subtype: event.subtype, is_error: event.is_error, result: event.result };
          assert.ok(state.requests.length > 0);
          assert.ok(state.requests.every(request => request.nativeMarker && request.hostMarker), 'selected Agent prompt and Relay rules enter system instructions');
          assert.ok(state.requests.every(request => request.tools.includes('Read') && !request.tools.includes('Write') && !request.tools.includes('Bash')), 'selected native Agent tool allowlist is respected');
          assert.equal(state.terminal?.is_error, false, 'native Agent runs successfully');
          report.checks.push('agent: SDK Options.agent selects instructions and tool allowlist without prompt delegation');
        }
        assert.ok(state.requests.every(request => request.model === 'fixture-selected-model'), 'provider-selected model remains authoritative');
        report.checks.push(`${name}: provider-selected model is preserved`);
      } finally { live.close(); live = null; }
    }
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { clearTimeout(deadline); live?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
