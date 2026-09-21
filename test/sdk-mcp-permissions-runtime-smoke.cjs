'use strict';
// Real bundled SDK/CLI with an isolated profile and a synthetic loopback provider.
// No real model, registry, credentials or user files are read or modified.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const relay = require('../claude-sdk'), { InteractionBroker } = require('../interaction-broker');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-permissions-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace'); fs.mkdirSync(config); fs.mkdirSync(cwd);
const output = path.join(__dirname, '../.codex-tmp/sdk-mcp-permissions-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], platform: process.platform, checks: [], scenarios: [] };
let active, session, broker, server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) { const deadline = Date.now() + 30000; while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out: ' + label); await sleep(20); } }
function check(label, value) { assert.ok(value, label); report.checks.push(label); }
function send(res, body, blocks) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: blocks.some(item => item.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
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
}
(async () => {
  server = http.createServer((req, res) => { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const body = JSON.parse(raw), state = active;
    state.syntheticOnly &&= body.model === 'fixture-model' && req.headers['x-api-key'] === 'synthetic-mcp-key';
    const blocks = state.requests++ === 0 ? [{ type: 'tool_use', id: 'tool_' + randomUUID(), name: 'mcp__guarded__echo', input: { value: 'fixture' } }] : [{ type: 'text', text: 'fixture completed' }];
    send(res, body, blocks);
  }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ['bypassPermissions', 'acceptEdits', 'default', 'deny-rule']) {
    const state = active = { mode, requests: 0, calls: 0, callbacks: 0, results: [], syntheticOnly: true };
    const context = { conversationId: randomUUID(), runId: randomUUID(), permissionReconciliation: null };
    broker = new InteractionBroker({ logger: { warn() {} } });
    session = relay.createLiveSession({ cwd, model: 'fixture-model', permissionMode: mode === 'deny-rule' ? 'bypassPermissions' : mode, tools: ['Read'],
      runtimePolicy: { settingSources: [], settings: { permissions: { allow: ['mcp__guarded__echo'], ...(mode === 'deny-rule' ? { deny: ['mcp__guarded__echo'] } : {}) } } },
      mcpPermissionOverrides: { guarded: 'default' },
      runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-mcp-key', ANTHROPIC_BASE_URL: url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
        ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
      mcpServersFactory: sdk => ({ guarded: sdk.createSdkMcpServer({ name: 'guarded', version: '1.0.0', tools: [
        sdk.tool('echo', 'Return a synthetic local marker', { value: require('zod').z.string() }, async ({ value }) => { state.calls++; return { content: [{ type: 'text', text: value }] }; }),
      ] }) }),
      canUseTool: (toolName, input, sdkOptions) => { state.callbacks++; return broker.registerToolUse({ toolName, input, sdkOptions, context }); },
      onMessage: event => { if (event.type === 'result') state.results.push(event); }, onExit: (code, error) => { state.exit = { code, error }; },
    });
    try {
      await session.whenReady();
      const unknown = await session.setMcpPermissionModeOverride('not-connected-yet', 'default');
      check(mode + ': public control stores unknown exact server with a warning', unknown.warnings.some(item => item.name === 'not-connected-yet'));
      session.push('Run the local fixture MCP echo once', { uuid: context.runId });
      await until(() => broker.size || state.results.length || state.exit, mode + ' approval');
      if (mode === 'deny-rule') {
        check('explicit deny still blocks the MCP without asking or executing', broker.size === 0 && state.calls === 0 && state.callbacks === 0);
        report.scenarios.push({ mode, calls: state.calls, callbacks: state.callbacks }); continue;
      }
      check(mode + ': tighter MCP policy asks before executing despite allow rules', broker.size === 1 && state.calls === 0);
      await session.setPermissionMode('bypassPermissions');
      context.permissionReconciliation = { ...context, revision: 2, permissionMode: 'bypassPermissions' };
      check(mode + ': mode reconciliation cannot approve guarded MCP', broker.reconcilePermissionMode(context.permissionReconciliation) === 0);
      broker.respond(broker.list()[0].id, { action: 'allow_once' });
      await until(() => state.results.length, mode + ' completion');
      check(mode + ': approved MCP executes exactly once', state.calls === 1 && state.callbacks === 1 && !state.results[0].is_error);
      await session.syncMcpPermissionOverrides({});
      state.requests = 0; session.push('Run the local fixture again after following session', { uuid: randomUUID() });
      await until(() => state.results.length === 2, mode + ' follow session');
      check(mode + ': clearing override follows session without another approval', state.calls === 2 && state.callbacks === 1);
      check(mode + ': only the isolated synthetic provider was used', state.syntheticOnly);
      report.scenarios.push({ mode, calls: state.calls, callbacks: state.callbacks });
    } finally { broker.close(); await session.kill(); session = null; broker = null; }
  }
  report.ok = true;
})().catch(error => { report.ok = false; report.error = String(error.stack || error); report.failed = active; console.error(report.error); process.exitCode = 1; })
  .finally(async () => {
    broker?.close(); if (session) await session.kill();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (let tries = 0; ; tries++) { try { fs.rmSync(base, { recursive: true, force: true }); break; } catch (error) { if (tries >= 20) throw error; await sleep(100); } }
    report.cleanedUp = true; fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, scenarios: report.scenarios }, null, 2));
  });
