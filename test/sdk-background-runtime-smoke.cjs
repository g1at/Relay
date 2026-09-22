'use strict';
// Real bundled SDK, synthetic loopback model and bounded tools in a temporary
// workspace. No real provider, user configuration or Relay history is opened.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../src/main/sdk/claude-sdk');
const { SdkSessionObserver, backgroundOwnedTask, observeOwnedBackgroundTasks } = require('../src/main/sdk/sdk-session-observer');
const { LiveBackgroundTaskTracker } = require('../src/main/live/live-async-agent-tracker');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-background-'));
const cwd = path.join(base, 'workspace'), config = path.join(base, 'config');
for (const dir of [cwd, config]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const output = path.join(__dirname, '../.codex-tmp/sdk-background-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { platform: process.platform, checks: [], errors: [], taskEvents: [], requests: [], results: [] };
const events = [], inputs = [], sentTools = new Set(), allowed = new Set();
let wake, ended = false, query, pump, agentRequestStarted = false;
const observer = new SdkSessionObserver();
const session = { convId: 'fixture', jobId: 'first', busy: true, observer, turnRouter: { toolIds: new Set() },
  backgroundTaskTracker: new LiveBackgroundTaskTracker() };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await wait(25); }
}
function check(label, condition) { assert.ok(condition, label); report.checks.push(label); }
function send(text) {
  session.jobId = text; observer.beginTurn(); session.turnRouter.toolIds.clear();
  inputs.push({ type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: text } });
  wake?.(); wake = null;
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const text = JSON.stringify(body.messages || []);
      const child = text.includes('CHILD_HOLD') && !text.includes('FIXTURE_BACKGROUND_AGENT');
      const stage = child ? 'child' : text.includes('FIXTURE_AFTER') ? 'after'
        : text.includes('FIXTURE_BACKGROUND_AGENT') ? 'agent' : 'bash';
      report.requests.push({ stage, model: body.model });
      let blocks;
      if (child) { agentRequestStarted = true; await wait(6000); blocks = [{ type: 'text', text: 'child-done' }]; }
      else if (stage === 'bash' && !sentTools.has(stage)) {
        sentTools.add(stage); blocks = [{ type: 'tool_use', id: 'foreground-shell', name: 'Bash',
          input: { command: 'sleep 12', timeout: 120000, description: 'Bounded temporary foreground fixture' } }];
      } else if (stage === 'agent' && !sentTools.has(stage)) {
        sentTools.add(stage); blocks = [{ type: 'tool_use', id: 'foreground-agent', name: 'Agent',
          input: { subagent_type: 'general-purpose', description: 'Bounded temporary fixture agent', prompt: 'CHILD_HOLD', run_in_background: false } }];
      } else blocks = [{ type: 'text', text: `${stage}-continued` }];
      const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: blocks,
        stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
      emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
      blocks.forEach((block, index) => {
        emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
        emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
          ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        emit('content_block_stop', { type: 'content_block_stop', index });
      });
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
      emit('message_stop', { type: 'message_stop' }); res.end();
    } catch (error) { report.errors.push(error.message); res.destroy(); }
  });
});
const deadline = setTimeout(() => { report.errors.push('Fixture exceeded 100 seconds'); query?.close(); server.closeAllConnections();
  fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); process.exit(1); }, 100000);
(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const sdk = await relay.loadSdk();
    const options = relay._buildOptions({ cwd, model: 'fixture-background-model', tools: ['Bash', 'Agent'], permissionMode: 'default',
      runtimePolicy: { settingSources: [] }, runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-only', ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-background-model',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      canUseTool: async (name, input) => {
        const safe = name === 'Bash' && input.command === 'sleep 12' || name === 'Agent' && input.prompt === 'CHILD_HOLD';
        if (safe) allowed.add(name); return safe ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only fixture tools allowed' };
      },
    }, sdk);
    options.settingSources = []; options.persistSession = false; options.maxTurns = 8; options.perTaskStopAffordance = true;
    query = sdk.query({ options, prompt: (async function* () { while (!ended) { if (inputs.length) yield inputs.shift(); else await new Promise(resolve => { wake = resolve; }); } })() });
    session.child = query;
    pump = (async () => { for await (const event of query) {
      events.push(event); observer.observe(event);
      for (const id of observer.foregroundTools.keys()) session.turnRouter.toolIds.add(id);
      session.backgroundTaskTracker.ingest(event);
      const pendingManualTasks = observeOwnedBackgroundTasks(session, event);
      if (event.type === 'system' && /^task_/.test(event.subtype || '')) report.taskEvents.push(event);
      if (event.type === 'result' && !event.parent_tool_use_id) report.results.push({ result: event.result, sessionId: event.session_id,
        pendingManualTasks, origin: event.origin?.kind || null });
    } })(); pump.catch(error => report.errors.push(error.message));
    await query.initializationResult();
    const invoke = id => backgroundOwnedTask({ session, convId: 'fixture', jobId: session.jobId, toolUseId: id, isCurrent: value => value === session });
    send('FIXTURE_BACKGROUND_BASH');
    // The SDK can approve a harmless sleep without calling canUseTool. Its
    // foreground task_started event is the execution acknowledgement.
    await until(() => report.taskEvents.some(event => event.subtype === 'task_started' && event.tool_use_id === 'foreground-shell' && event.is_backgrounded === false), 'foreground command starts');
    check('targeted Bash background request receives native true', (await invoke('foreground-shell')).ok);
    await until(() => report.results.some(item => item.result === 'bash-continued'), 'foreground turn continues before command finishes');
    const started = report.taskEvents.find(event => event.tool_use_id === 'foreground-shell' && event.task_id);
    check('Bash remains running when the main turn continues', started && !report.taskEvents.some(event => event.task_id === started.task_id && event.subtype === 'task_notification'));
    await until(() => report.taskEvents.some(event => event.task_id === started.task_id && event.subtype === 'task_notification' && event.status === 'completed'), 'Bash completes through real SDK notification');
    check('Bash completion is reported by SDK task_notification', true);
    await until(() => report.results.filter(item => item.result === 'bash-continued').length >= 2, 'SDK continuation after Bash completion');
    check('Bash completion causes a fresh authoritative continuation result', true);
    check('Relay lifecycle waits on the intermediate result and releases only after native completion',
      report.results.filter(item => item.result === 'bash-continued')[0].pendingManualTasks === 1
      && report.results.filter(item => item.result === 'bash-continued').at(-1).pendingManualTasks === 0);
    send('FIXTURE_BACKGROUND_AGENT'); await until(() => agentRequestStarted, 'foreground Agent model request');
    const agentControl = await invoke('foreground-agent'); report.agentControl = agentControl;
    if (agentControl.code === 'ALREADY_BACKGROUND') {
      check('SDK already-background Agent is rejected without a duplicate control', report.taskEvents.some(event => event.tool_use_id === 'foreground-agent' && event.is_backgrounded === true));
    } else check('targeted Agent background request receives native true', agentControl.ok);
    await until(() => report.results.some(item => item.result === 'agent-continued'), 'main turn continues after Agent backgrounding');
    await until(() => report.taskEvents.some(event => event.tool_use_id === 'foreground-agent' && event.subtype === 'task_notification' && event.status === 'completed'), 'Agent completes through real SDK notification');
    check('Agent completion is reported by SDK task_notification', true);
    await until(() => report.results.filter(item => item.result === 'agent-continued').length >= 2, 'SDK continuation after Agent completion');
    if (agentControl.ok) check('Agent lifecycle also waits for the native completion continuation',
      report.results.filter(item => item.result === 'agent-continued')[0].pendingManualTasks === 1
      && report.results.filter(item => item.result === 'agent-continued').at(-1).pendingManualTasks === 0);
    send('FIXTURE_AFTER'); await until(() => report.results.some(item => item.result === 'after-continued'), 'same Query accepts next input');
    check('backgrounding preserves the Query and SDK session for later conversation', new Set(report.results.map(item => item.sessionId)).size === 1);
    check('selected provider model remains in use', report.requests.every(request => request.model === 'fixture-background-model'));
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    clearTimeout(deadline); ended = true; wake?.(); query?.close(); await pump?.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true });
    report.cleanedUp = true; fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2));
  }
})();
