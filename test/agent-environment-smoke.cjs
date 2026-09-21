'use strict';
// Explicit Windows + installed WSL acceptance. Synthetic resources and an HTTP
// server bound only to WSL loopback; never reads Relay's settings or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createAgentEnvironment, toWslPath } = require('../agent-environment');
const { createRuntimeMcpMapper } = require('../host-stdio-mcp');
const relay = require('../claude-sdk');
const output = path.join(__dirname, '../.codex-tmp/wsl-mcp-bridge-validation');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wsl-smoke-'));
const configDir = path.join(root, 'claude'), cwd = path.join(root, 'workspace');
const checks = [], live = new Set(), mappers = new Set(), handles = new Set(); let server;
const startedAt = new Date().toISOString();
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deadline(promise, label, ms = 25000) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); }
async function main() {
  assert.equal(process.platform, 'win32', 'Run this acceptance with Windows Node and an installed WSL distribution');
  fs.mkdirSync(path.join(configDir, 'skills', 'wsl-fixture'), { recursive: true }); fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'wrong-fixture-key' }, model: 'wrong-model' }));
  fs.writeFileSync(path.join(configDir, 'skills', 'wsl-fixture', 'SKILL.md'), '---\nname: wsl-fixture\ndescription: Synthetic WSL skill\n---\nDo not run real tasks.');
  fs.writeFileSync(path.join(configDir, 'agents', 'wsl-fixture-agent.md'), '---\nname: wsl-fixture-agent\ndescription: Synthetic WSL Agent\ntools: Read\n---\nDo not run real tasks.');
  const mcpFile = path.join(root, 'windows-mcp.cjs'), marker = path.join(root, 'host-calls.jsonl'), startups = path.join(root, 'host-startups.jsonl');
  fs.writeFileSync(mcpFile, `const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.RELAY_MCP_STARTUPS, JSON.stringify({ pid: process.pid, platform: process.platform }) + '\\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 let result;
 if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'host-fixture', version: '1.0.0' } };
 else if (m.method === 'tools/list') result = { tools: [{ name: 'host_echo', description: 'Windows fixture only', inputSchema: { type: 'object', properties: {} } }] };
 else if (m.method === 'resources/list') result = { resources: [] };
 else if (m.method === 'tools/call') { fs.appendFileSync(process.env.RELAY_MCP_MARKER, JSON.stringify({ platform: process.platform, cwd: process.cwd(), tokenPresent: process.env.RELAY_MCP_SECRET === 'synthetic-mcp-secret', revision: process.env.RELAY_MCP_REVISION, pid: process.pid }) + '\\n'); result = { content: [{ type: 'text', text: 'windows-host-tool-ok' }] }; }
 else { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } }); return; }
 send({ jsonrpc: '2.0', id: m.id, result });
});
`);
  const externalConfig = revision => ({ command: 'cmd.exe', args: ['/d', '/c', process.execPath, mcpFile], env: { RELAY_MCP_STARTUPS: startups, RELAY_MCP_MARKER: marker, RELAY_MCP_SECRET: 'synthetic-mcp-secret', RELAY_MCP_REVISION: revision }, timeout: 15000 });
  const serverFile = path.join(root, 'server.py');
  fs.writeFileSync(serverFile, `import http.server,json,uuid,threading,sys\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_POST(self):\n  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')\n  if 'count_tokens' in self.path:\n   self.send_response(200);self.end_headers();self.wfile.write(b'{"input_tokens":20}');return\n  if 'messages' not in self.path:\n   self.send_response(404);self.end_headers();return\n  if self.headers.get('x-api-key')!='wsl-fixture-key' or body.get('model')!='relay-wsl-model':\n   self.send_response(401);self.end_headers();return\n  called=set(c.get('name') for m in body.get('messages',[]) for c in (m.get('content',[]) if isinstance(m.get('content'),list) else []) if c.get('type')=='tool_use')\n  tool=next((t['name'] for t in body.get('tools',[]) if t['name'] in ['mcp__fixture__echo','mcp__windows__host_echo'] and t['name'] not in called),None)\n  blocks=[{'type':'tool_use','id':'tool_'+uuid.uuid4().hex,'name':tool,'input':{}}] if tool else [{'type':'text','text':'wsl-fixture-complete'}]\n  message={'id':'msg_'+uuid.uuid4().hex,'type':'message','role':'assistant','model':body['model'],'content':blocks,'stop_reason':'tool_use' if blocks[0]['type']=='tool_use' else 'end_turn','stop_sequence':None,'usage':{'input_tokens':20,'output_tokens':8}}\n  self.send_response(200);self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json');self.end_headers()\n  if not body.get('stream'): self.wfile.write(json.dumps(message).encode());return\n  def emit(event,data): self.wfile.write(('event: '+event+'\\ndata: '+json.dumps(data)+'\\n\\n').encode())\n  emit('message_start',{'type':'message_start','message':dict(message,content=[],stop_reason=None)})\n  for i,b in enumerate(blocks):\n   emit('content_block_start',{'type':'content_block_start','index':i,'content_block':dict(b,text='') if b['type']=='text' else dict(b,input={})})\n   emit('content_block_delta',{'type':'content_block_delta','index':i,'delta':{'type':'text_delta','text':b['text']} if b['type']=='text' else {'type':'input_json_delta','partial_json':json.dumps(b['input'])}})\n   emit('content_block_stop',{'type':'content_block_stop','index':i})\n  emit('message_delta',{'type':'message_delta','delta':{'stop_reason':message['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':8}});emit('message_stop',{'type':'message_stop'});self.wfile.flush()\ns=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(s.server_port,flush=True)\nthreading.Thread(target=s.serve_forever,daemon=True).start()\nsys.stdin.read()\ns.shutdown()\n`);
  const adapter = createAgentEnvironment({ configDir, getMcpServers: () => ({ windows: externalConfig('A') }) });
  const readiness = await adapter.probe({ refresh: true }); check('installed WSL can execute Relay bundled Linux runtime', readiness.available);
  server = spawn(readiness.wslExecutable, ['--exec', 'python3', '-u', toWslPath(serverFile)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const port = await deadline(new Promise((resolve, reject) => { let text = ''; server.once('error', reject); server.once('exit', code => reject(Error('Fixture server ended: ' + code))); server.stdout.on('data', value => { text += value; if (/^\d+\r?\n/.test(text)) resolve(Number(text.trim())); }); }), 'loopback server');
  check('fixture server is a local ephemeral endpoint', port > 0 && port < 65536);
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  let toolCalls = 0, sid;
  const runtimeEnv = { RELAY_AGENT_ENVIRONMENT: 'wsl', CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'wsl-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: 'relay-wsl-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' };
  async function settledStatus(query) {
    const until = Date.now() + 10000; let statuses;
    do { statuses = await query.mcpServerStatus(); if (!statuses.some(item => item.status === 'pending')) return statuses; await wait(150); } while (Date.now() < until);
    return statuses;
  }
  for (let turn = 0; turn < 2; turn++) {
    let argv; const previousSessionId = sid;
    const options = relay._buildOptions({ cwd, mcpServers: { windows: externalConfig('A') }, model: 'relay-wsl-model', sessionId: sid, permissionMode: 'default', runtimeEnv,
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
      mcpServersFactory: sdk => ({ fixture: sdk.createSdkMcpServer({ name: 'fixture', version: '1.0.0', tools: [sdk.tool('echo', 'Synthetic fixture', {}, async () => { toolCalls++; return { content: [{ type: 'text', text: 'fixture-tool-ok' }] }; })] }) }) }, sdk);
    const prepared = await adapter.prepareOptions(options, { onSpawn: child => { argv = child.spawnargs; } });
    let query;
    // Streaming input is required for in-process SDK MCP servers.
    let release; const gate = new Promise(resolve => { release = resolve; });
    query = sdk.query({ prompt: (async function* () { yield { type: 'user', message: { role: 'user', content: 'Synthetic loopback fixture only.' }, parent_tool_use_id: null, session_id: '' }; await gate; })(), options: prepared }); live.add(query);
    const mapper = createRuntimeMcpMapper(prepared.mcpServers, servers => adapter.prepareMcpServers(servers, { environment: 'wsl', resourceDir: configDir, prepared })); mappers.add(mapper);
    let result;
    let finishResult; const gotResult = new Promise(resolve => { finishResult = resolve; });
    const consuming = (async () => { for await (const event of query) { if (event.type === 'system' && event.subtype === 'init') sid = event.session_id; if (event.type === 'result') { result = event; finishResult(); } } })();
    consuming.catch(() => {});
    await deadline(gotResult, 'WSL synthetic turn');
    check(`turn ${turn + 1} completes through loopback API`, result && !result.is_error && result.result.includes('wsl-fixture-complete'));
    if (previousSessionId) check('second turn resumes the exact first native session', sid === previousSessionId);
    check(`turn ${turn + 1} credentials never enter process arguments`, !JSON.stringify(argv).includes('wsl-fixture-key'));
    check(`turn ${turn + 1} discovers shared user skill`, (await query.supportedCommands()).some(item => item.name === 'wsl-fixture'));
    check(`turn ${turn + 1} discovers shared user Agent`, (await query.supportedAgents()).some(item => item.name === 'wsl-fixture-agent'));
    const statuses = await query.mcpServerStatus();
    check(`turn ${turn + 1} Windows stdio MCP is connected in real WSL SDK`, statuses.some(item => item.name === 'windows' && item.status === 'connected'));
    const originalBridge = prepared.mcpServers.windows.instance;
    await mapper.applyServers(servers => query.setMcpServers(servers), { ...options.mcpServers, windows: externalConfig('B') });
    check(`turn ${turn + 1} hot configuration replacement closes original Windows process`, originalBridge.closed);
    const changedStatuses = await settledStatus(query);
    check(`turn ${turn + 1} replacement MCP reconnects through SDK`, changedStatuses.some(item => item.name === 'windows' && item.status === 'connected'));
    await mapper.applyServers(servers => query.setMcpServers(servers), { ...options.mcpServers, windows: { command: path.join(root, 'missing.exe') } });
    const missing = await settledStatus(query);
    check(`turn ${turn + 1} missing host executable is a per-server failure`, missing.some(item => item.name === 'windows' && item.status === 'failed'));
    check(`turn ${turn + 1} an unrelated SDK MCP remains connected`, missing.some(item => item.name === 'fixture' && item.status === 'connected'));
    release(); query.close(); await mapper.close(); mappers.delete(mapper); live.delete(query); await wait(200);
  }
  check('Windows-hosted SDK MCP executes inside the WSL agent turn', toolCalls > 0);
  const calls = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  check('stdio business tool executes exactly once with no fallback replay', calls.length === 1);
  check('stdio MCP actually executes on Windows with Windows cwd and environment', calls[0].platform === 'win32' && calls[0].cwd === cwd && calls[0].tokenPresent);
  // Exercise Relay's own launch/cleanup adapter as well as the SDK protocol.
  relay.configureRuntimeEnvironment(adapter);
  const callCount = () => fs.readFileSync(marker, 'utf8').trim().split('\n').length;
  for (const kind of ['live', 'one-shot']) {
    const before = callCount(), events = [];
    let complete; const completed = new Promise(resolve => { complete = resolve; });
    const onEvent = event => { events.push(event); if (event.type === 'result') complete(event); };
    const params = { cwd, mcpServers: { windows: externalConfig(kind) }, model: 'relay-wsl-model', runtimeEnv,
      permissionMode: 'default', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) };
    if (kind === 'live') {
      const handle = relay.createLiveSession({ ...params, onMessage: onEvent, onExit() {} }); handles.add(handle);
      await deadline(handle.prepareMcp({ servers: params.mcpServers }), 'Relay live MCP readiness');
      check('Relay live wrapper accepts input after WSL MCP readiness', handle.push('Synthetic Windows MCP only.'));
      const result = await deadline(completed, 'Relay live WSL result');
      check('Relay live wrapper executes Windows MCP exactly once', !result.is_error && callCount() === before + 1);
      await deadline(handle.kill(), 'Relay live cleanup'); handles.delete(handle);
    } else {
      const { handle } = relay.runOneShot({ ...params, prompt: 'Synthetic Windows MCP only.', onEvent }); handles.add(handle);
      await deadline(handle.whenClosed(), 'Relay one-shot WSL result and cleanup'); handles.delete(handle);
      check('Relay one-shot wrapper executes Windows MCP exactly once', events.some(event => event.type === 'result' && !event.is_error) && callCount() === before + 1);
      check('Relay one-shot final event follows MCP cleanup', events.at(-1).type === 'job-done' && events.at(-1).exitCode === 0);
    }
  }
  const pids = fs.readFileSync(startups, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  check('cmd-launched Windows MCP child processes have actually exited after cleanup', pids.length >= 4 && pids.every(pid => !alive(pid)));
  check('WSL native session can resume for a second round', typeof sid === 'string' && sid.length > 0);
}
main().then(() => { fs.writeFileSync(path.join(output, 'wsl-smoke.json'), JSON.stringify({ ok: true, startedAt, checks }, null, 2)); console.log(JSON.stringify({ ok: true, checks: checks.length })); }).catch(error => { fs.writeFileSync(path.join(output, 'wsl-smoke.json'), JSON.stringify({ ok: false, startedAt, checks, error: error.message }, null, 2)); console.error(error.message); process.exitCode = 1; }).finally(async () => {
  for (const query of live) try { query.close(); } catch (_) {}
  await Promise.allSettled([...handles].map(handle => handle.kill()));
  await Promise.allSettled([...mappers].map(mapper => mapper.close()));
  relay.configureRuntimeEnvironment(null);
  if (server) { server.stdin.end(); await wait(300); if (server.exitCode === null) server.kill(); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});
