'use strict';
// Real bundled Claude SDK + a local synthetic Anthropic endpoint + stdio MCP.
// Explicit runtime fixture, excluded from *.test.js; never contacts a provider.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

async function runMcpFixture() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');
  const server = new McpServer({ name: 'relay-elicitation-fixture', version: '1.0.0' });
  server.registerTool('request', { description: 'Collect synthetic fixture input only', inputSchema: { mode: z.enum(['form', 'cancel', 'url']) } }, async ({ mode }) => {
    const request = mode === 'url' ? { mode: 'url', message: 'Synthetic URL only',
      url: 'https://fixture.invalid/authorize', elicitationId: 'fixture-url-completion' }
      : { mode: 'form', message: 'Synthetic form only', requestedSchema: { type: 'object', properties: {
        name: { type: 'string', minLength: 2 }, enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', enum: ['one', 'two'] } },
      }, required: ['name', 'enabled'] } };
    const result = await server.server.elicitInput(request);
    if (mode === 'url' && result.action === 'accept') await server.server.notification({ method: 'notifications/elicitation/complete', params: { elicitationId: 'fixture-url-completion' } });
    return { content: [{ type: 'text', text: JSON.stringify({ fixtureResult: result }) }] };
  });
  await server.connect(new StdioServerTransport());
}

async function runHostFixture() {
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const { randomUUID } = require('node:crypto');
  const relay = require('../claude-sdk');
  const { InteractionBroker } = require('../interaction-broker');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-elicitation-'));
  const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
  fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
  const output = path.join(__dirname, '../.codex-tmp/sdk-elicitation-runtime'); fs.mkdirSync(output, { recursive: true });
  const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform, scenarios: [], checks: [], errors: [], limitations: [] };
  let active, live;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      active.requests++;
      active.availableTools = (body.tools || []).map(tool => tool.name);
      const toolResults = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
      active.toolResults = toolResults;
      const blocks = toolResults.length ? [{ type: 'text', text: 'fixture-complete' }] : [{ type: 'tool_use', id: 'call_' + randomUUID(), name: 'mcp__relay-elicitation-fixture__request', input: { mode: active.mode } }];
      const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
        stop_reason: toolResults.length ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
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
  const deadline = setTimeout(() => { report.errors.push('Runtime fixture exceeded 120 seconds'); live?.close(); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 120000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['form', 'cancel', 'url']) {
      const state = active = { mode, requests: 0, callbackCount: 0, events: [], toolResults: [], stderr: [] };
      report.scenarios.push(state);
      const context = { runId: randomUUID(), conversationId: randomUUID(), windowId: 1 };
      const broker = new InteractionBroker({ onChange: event => state.events.push({ type: event.type, resolution: event.resolution }) });
      const callback = broker.createOnElicitation(context);
      const options = relay._buildOptions({ cwd, model: 'fixture-model', permissionMode: 'default', tools: [],
        runtimePolicy: { settingSources: [] }, runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-elicitation-key',
          ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: 'fixture-model',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
          ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        mcpServers: { 'relay-elicitation-fixture': { command: process.execPath, args: [__filename, '--mcp-fixture'] } },
        canUseTool: async (name, input) => name === 'mcp__relay-elicitation-fixture__request' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not a fixture tool' },
        onElicitation: (request, callbackOptions) => {
          state.callbackCount++; state.callbackMode = request.mode || 'form'; state.hasRequestId = typeof callbackOptions.requestId === 'string';
          const pending = callback(request, callbackOptions);
          const item = broker.list({ conversationId: context.conversationId })[0];
          assert.ok(item, 'SDK elicitation must become a scoped Relay interaction');
          assert.ok(!item.elicitation.unsupported, item.elicitation.unsupported);
          broker.respond(item.id, mode === 'cancel' ? { action: 'cancel' } : mode === 'url' ? { action: 'accept' }
            : { action: 'accept', content: { name: 'fixture', enabled: false, tags: ['one'] } });
          return pending;
        }, stderr: value => state.stderr.push(value.slice(0, 1500)),
      }, sdk);
      options.settingSources = []; options.persistSession = false; options.maxTurns = 4;
      let releaseInput;
      const ready = new Promise(resolve => { releaseInput = resolve; });
      live = sdk.query({ prompt: (async function* () { await ready; yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'RUN_SYNTHETIC_ELICITATION ' + mode } }; })(), options });
      try {
        const pump = (async () => { for await (const event of live) {
          if (event.type === 'system' && event.subtype === 'elicitation_complete') {
            state.completeEvent = event;
            state.completeMatched = broker.completeElicitation(event, context);
          }
          if (event.type === 'result') { state.terminal = { subtype: event.subtype, is_error: event.is_error, result: event.result, errors: event.errors }; }
        } })();
        pump.catch(() => {});
        await live.initializationResult();
        await live.reconnectMcpServer('relay-elicitation-fixture');
        state.mcpStatus = await live.mcpServerStatus();
        assert.ok(state.mcpStatus.some(item => item.name === 'relay-elicitation-fixture' && item.status === 'connected'), 'fixture MCP connected before the model tool call');
        releaseInput();
        await pump;
        if (mode === 'url' && state.callbackCount === 0 && JSON.stringify(state.toolResults).includes('Client does not support url elicitation.')) {
          state.supportedByRuntime = false;
          report.limitations.push('SDK 0.3.266 / CLI 2.1.266 advertises form elicitation only. URL callback/completion UI is prepared, but real MCP URL elicitation remains unavailable upstream.');
          report.checks.push('url: verified upstream capability boundary; no private protocol workaround');
          continue;
        }
        assert.equal(state.callbackCount, 1, `${mode}: real SDK callback count`);
        assert.equal(state.hasRequestId, true, `${mode}: callback carries request ID`);
        assert.equal(state.terminal?.is_error, false, `${mode}: SDK run completed`);
        const resultText = JSON.stringify(state.toolResults);
        assert.ok(resultText.includes('fixtureResult'), `${mode}: MCP receives elicitation result`);
        assert.ok(resultText.includes(mode === 'cancel' ? 'cancel' : 'accept'), `${mode}: MCP receives matching action`);
        if (mode === 'form') assert.ok(resultText.includes('false') && resultText.includes('fixture'), 'form content retains primitive types');
        if (mode === 'url') assert.equal(state.completeMatched, true, 'native SDK URL completion event matches Relay request');
        report.checks.push(`${mode}: real MCP → bundled SDK → Relay broker → MCP result verified`);
      } finally { releaseInput(); live.close(); live = null; broker.close(); }
    }
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); live?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2));
  }
}

if (process.argv.includes('--mcp-fixture')) runMcpFixture().catch(error => { console.error(error); process.exitCode = 1; });
else runHostFixture().catch(error => { console.error(error); process.exitCode = 1; });
