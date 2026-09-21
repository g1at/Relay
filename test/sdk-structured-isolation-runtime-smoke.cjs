'use strict';
// Explicit real-runtime fixture: isolated user configuration, loopback fake API,
// and a harmless stdio MCP. No actual profile, service, credential or task is used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

async function mcpFixture(marker) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  fs.appendFileSync(marker, 'started\n');
  const server = new McpServer({ name: 'structured-isolation-fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'Return a synthetic marker only', inputSchema: {} }, async () => {
    fs.appendFileSync(marker, 'called\n');
    return { content: [{ type: 'text', text: 'ISOLATED_MCP_RESULT' }] };
  });
  await server.connect(new StdioServerTransport());
}

async function hostFixture() {
  const assert = require('node:assert/strict'), http = require('node:http');
  const { randomUUID } = require('node:crypto');
  const relay = require('../claude-sdk');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-structured-isolation-'));
  const config = path.join(base, 'config'), cwd = path.join(base, 'workspace'), marker = path.join(base, 'mcp-events.txt');
  fs.mkdirSync(config); fs.mkdirSync(cwd);
  const mcpServers = { 'structured-isolation-fixture': { type: 'stdio', command: process.execPath, args: [__filename, '--mcp-fixture', marker] } };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ mcpServers }));
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__structured-isolation-fixture__*'] } }));
  const output = path.join(__dirname, '../.codex-tmp/sdk-structured-isolation-runtime'); fs.mkdirSync(output, { recursive: true });
  const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform,
    checks: [], scenarios: [], errors: [] };
  const expected = { title: 'isolated metadata', approved: false, count: 3 };
  const schema = { type: 'object', properties: { title: { type: 'string' }, approved: { type: 'boolean' }, count: { type: 'integer' } },
    required: ['title', 'approved', 'count'], additionalProperties: false };
  const mcpName = 'mcp__structured-isolation-fixture__echo';
  let active, live;
  const markerLines = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const toolNames = (body.tools || []).map(tool => tool.name);
      const toolResults = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
      active.requests.push({ model: body.model, tools: toolNames });
      active.toolResults = toolResults;
      const blocks = active.name === 'structured'
        ? [{ type: 'tool_use', id: 'call_' + randomUUID(), name: 'StructuredOutput', input: expected }]
        : toolResults.length ? [{ type: 'text', text: 'ordinary-chat-complete' }]
          : [{ type: 'tool_use', id: 'call_' + randomUUID(), name: mcpName, input: {} }];
      const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
        stop_reason: blocks[0].type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
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
  const deadline = setTimeout(() => {
    report.ok = false; report.errors.push('Runtime fixture exceeded 90 seconds'); live?.close();
    server.closeAllConnections(); server.close();
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1);
  }, 90000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-isolation-key', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-selected-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

    // Baseline proves tools:[] alone does not isolate user MCP and that normal
    // conversation option construction still discovers and executes this tool.
    active = { name: 'ordinary', requests: [], stderr: [] }; report.scenarios.push(active);
    const ordinary = active;
    const options = relay._buildOptions({ cwd, model: 'fixture-selected-model', runtimeEnv, runtimePolicy: { settingSources: ['user'] },
      tools: [], canUseTool: async (name, input) => name === mcpName ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Not a fixture tool' }, stderr: text => ordinary.stderr.push(text.slice(0, 1500)) }, sdk);
    assert.notEqual(options.strictMcpConfig, true, 'normal option construction does not enable strict MCP isolation');
    options.persistSession = false; options.maxTurns = 3;
    let release;
    const inputReady = new Promise(resolve => { release = resolve; });
    live = sdk.query({ prompt: (async function* () { await inputReady; yield { type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: 'Call the harmless fixture tool, then finish' } }; })(), options });
    const pump = (async () => { for await (const event of live) if (event.type === 'result') ordinary.terminal = { subtype: event.subtype, is_error: event.is_error }; })();
    await live.initializationResult();
    await live.reconnectMcpServer('structured-isolation-fixture');
    let statuses;
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses = await live.mcpServerStatus();
      if (statuses.some(item => item.name === 'structured-isolation-fixture' && item.status === 'connected')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ordinary.statuses = statuses.map(item => ({ name: item.name, status: item.status }));
    assert.ok(statuses.some(item => item.name === 'structured-isolation-fixture' && item.status === 'connected'), 'temporary user MCP is discovered by normal SDK options');
    release(); await pump; live.close(); live = null;
    assert.equal(ordinary.terminal?.is_error, false);
    assert.ok(ordinary.requests.some(request => request.tools.includes(mcpName)));
    assert.ok(JSON.stringify(ordinary.toolResults).includes('ISOLATED_MCP_RESULT'));
    assert.equal(markerLines().filter(item => item === 'called').length, 1);
    report.checks.push('ordinary chat: user MCP discovery and harmless execution remain enabled with tools:[]');

    const before = markerLines();
    active = { name: 'structured', requests: [] }; report.scenarios.push(active);
    active.parsed = await relay.runStructured({ prompt: 'Return the synthetic schema only', cwd, model: 'fixture-selected-model', runtimeEnv,
      runtimePolicy: { settingSources: ['user'] }, schema, timeoutMs: 30000,
      validate: value => ({ success: JSON.stringify(value) === JSON.stringify(expected), data: value }) });
    assert.deepEqual(active.parsed, expected);
    assert.ok(active.requests.length > 0);
    assert.ok(active.requests.every(request => request.tools.length === 1 && request.tools[0] === 'StructuredOutput'));
    assert.deepEqual(markerLines(), before, 'structured helper neither starts nor invokes the configured user MCP');
    report.checks.push('runStructured: real SDK StructuredOutput succeeds under strict MCP isolation and deny guard');
    report.checks.push('runStructured: user MCP is absent from model tools and no server is started or invoked');
    assert.ok(report.scenarios.every(scenario => scenario.requests.every(request => request.model === 'fixture-selected-model')));
    report.checks.push('both paths preserve the Relay-selected provider model');
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); live?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2));
  }
}
if (process.argv[2] === '--mcp-fixture') mcpFixture(process.argv[3]).catch(error => { console.error(error); process.exit(1); });
else hostFixture().catch(error => { console.error(error); process.exitCode = 1; });
