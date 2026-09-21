'use strict';
// Real bundled SDK fork-on-resume against synthetic JSONL and a loopback API.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../claude-sdk');
const { executeSessionOperation } = require('../sdk-session-history');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fork-resume-'));
const cwd = path.join(base, 'workspace'), config = path.join(base, 'config'); fs.mkdirSync(cwd); fs.mkdirSync(config);
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const sourceId = randomUUID(), destinationId = randomUUID();
const project = path.join(config, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(project, { recursive: true });
const output = path.join(__dirname, '../.codex-tmp/sdk-fork-resume-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform, checks: [], requests: [], errors: [] };
const user = (text, parentUuid = null) => ({ type: 'user', parentUuid, uuid: randomUUID(), sessionId: sourceId, cwd, isSidechain: false, userType: 'external', version: '2.1.266', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const assistant = (text, parentUuid) => ({ type: 'assistant', parentUuid, uuid: randomUUID(), sessionId: sourceId, cwd, isSidechain: false, version: '2.1.266', timestamp: new Date().toISOString(), message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 4 } } });
const first = user('FORK_BEFORE_MARKER'), boundary = assistant('FORK_BOUNDARY_MARKER', first.uuid), later = user('FORK_AFTER_MARKER', boundary.uuid), tail = assistant('FORK_EXCLUDED_ANSWER', later.uuid);
const source = [first, boundary, later, tail].map(entry => JSON.stringify(entry)).join('\n') + '\n';
const sourceFile = path.join(project, sourceId + '.jsonl'); fs.writeFileSync(sourceFile, source);
let query;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    const history = JSON.stringify(body.messages || []);
    report.requests.push({ model: body.model, before: history.includes('FORK_BEFORE_MARKER'), boundary: history.includes('FORK_BOUNDARY_MARKER'),
      excluded: history.includes('FORK_AFTER_MARKER') || history.includes('FORK_EXCLUDED_ANSWER'), followup: history.includes('FORK_NEW_REQUEST') });
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'FORK_FINAL_RESULT' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FORK_FINAL_RESULT' } });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  });
});
const deadline = setTimeout(() => { report.ok = false; report.errors.push('Fork fixture exceeded 90 seconds'); query?.close(); server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 90000);
async function run() {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const options = relay._buildOptions({ cwd, sessionId: sourceId, model: 'fixture-model', tools: [], runtimePolicy: { settingSources: [] },
      runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-fork-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ANTHROPIC_MODEL: 'fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
        ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    }, sdk);
    options.forkSession = true; options.sessionId = destinationId; options.resumeSessionAt = boundary.uuid;
    options.strictMcpConfig = true; options.mcpServers = {}; options.maxTurns = 2;
    query = sdk.query({ prompt: 'FORK_NEW_REQUEST', options });
    for await (const event of query) {
      if (event.type === 'system' && event.subtype === 'init') report.initUsesDestination = event.session_id === destinationId;
      if (event.type === 'result') report.result = { subtype: event.subtype, is_error: event.is_error, destination: event.session_id === destinationId };
    }
    query.close(); query = null;
    assert.ok(report.requests.length > 0);
    assert.ok(report.requests.every(request => request.before && request.boundary && request.followup && !request.excluded));
    report.checks.push('real API request includes selected-boundary history and new input, excludes later source turns');
    assert.ok(report.initUsesDestination && report.result.destination && !report.result.is_error); report.checks.push('SDK init and result use the preallocated destination session ID');
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), source); report.checks.push('fork-on-resume leaves source transcript bytes unchanged');
    const stored = await executeSessionOperation({ sessionId: destinationId, cwd, configDir: config, agentEnvironment: 'native' }, 'getSessionMessages', { limit: 20 });
    assert.ok(JSON.stringify(stored).includes('FORK_FINAL_RESULT') && !JSON.stringify(stored).includes('FORK_AFTER_MARKER')); report.checks.push('destination native transcript contains only the branch and its new result');
    assert.equal(fs.readdirSync(project).filter(name => name.endsWith('.jsonl')).length, 2); report.checks.push('exactly source and preallocated branch exist, no double fork');
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { clearTimeout(deadline); query?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
