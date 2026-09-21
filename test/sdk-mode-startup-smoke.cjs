'use strict';
// Native SDK/CLI regression: the control initialization reply arrives before
// a slow stdio MCP finishes connecting. All configuration and credentials are
// synthetic; only local commands are sent and no model turn is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LiveExecutionModes } = require('../execution-modes');
const relay = require('../claude-sdk');
const output = path.join(__dirname, '../.codex-tmp/sdk-mode-startup');
fs.mkdirSync(output, { recursive: true });
const base = fs.mkdtempSync(path.join(output, 'fixture-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd);
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const fixture = path.join(base, 'mcp.cjs');
fs.writeFileSync(fixture, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  const output = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  if (message.method === 'initialize') setTimeout(() => output({ protocolVersion: message.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'slow-fixture', version: '1' } }), Number(process.argv[2]));
  else if (message.method === 'tools/list') output({ tools: [] });
  else output({});
});
`);
const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-no-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  ANTHROPIC_MODEL: 'fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  CLAUDE_CODE_RETRY_WATCHDOG: '0', CLAUDE_CODE_MAX_RETRIES: '0',
  CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const report = { platform: process.platform, sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), scenarios: [], checks: [] };
let active;
const observe = LiveExecutionModes.prototype.observe;
LiveExecutionModes.prototype.observe = function(event) {
  if (active && event.type === 'command_lifecycle' && this.pending && event.command_uuid === this.pending.id) {
    active.lifecycle.push({ at: Date.now() - active.at, state: event.state });
  }
  if (active && event.type === 'result') active.resultTurns.push(event.num_turns);
  return observe.call(this, event);
};
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
async function scenario(name, delay, sessionId) {
  const state = active = { name, delay, at: Date.now(), lifecycle: [], resultTurns: [] };
  report.scenarios.push(state);
  const mcpServers = { fixture: { command: process.execPath, args: [fixture, String(delay)], timeout: 30000 } };
  const session = relay.createLiveSession({ cwd, tools: [], model: 'fixture-model', runtimeEnv, mcpServers,
    sessionId, executionMode: { kind: 'goal' },
    onMessage(event) { if (event.session_id) state.sessionId = event.session_id; },
    onExit(code, error) { state.exit = { code, error, at: Date.now() - state.at }; } });
  try {
    await session.whenReady(); state.readyMs = Date.now() - state.at;
    const mcp = session.prepareMcp({ servers: mcpServers, timeoutMs: 15000, reconnect: false });
    try {
      state.prepared = await session.prepareExecutionMode({ kind: 'goal' }, {
        contextPrompt: 'Synthetic context only; never sent to model.', goalCondition: 'fixture objective', timeoutMs: 10000 });
      state.preparedMs = Date.now() - state.at;
    } finally { state.mcp = await mcp; }
    check(name + ': local preparation completes', state.prepared.ok);
    check(name + ': no model turn executes', state.resultTurns.length > 0 && state.resultTurns.every(turns => turns === 0));
    check(name + ': MCP connects', state.mcp.ok);
    if (delay) {
      const firstStart = state.lifecycle.find(event => event.state === 'started');
      check(name + ': command waits longer than the ACK deadline after control readiness', firstStart.at - state.readyMs > 10000);
    }
    check(name + ': synthetic session is resumable', typeof state.sessionId === 'string');
    if (sessionId) check(name + ': original native session is preserved', state.sessionId === sessionId);
    return state.sessionId;
  } finally { await session.kill(); }
}
(async () => {
  const sessionId = await scenario('fresh-fast-mcp', 0);
  await scenario('fresh-slow-mcp', 12000);
  await scenario('resume-slow-mcp', 12000, sessionId);
  report.ok = true;
})().catch(error => { report.ok = false; report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  LiveExecutionModes.prototype.observe = observe;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!report.cleanedUp) { report.ok = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, scenarios: report.scenarios.length,
    cleanedUp: report.cleanedUp, error: report.error }));
});
