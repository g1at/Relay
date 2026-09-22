'use strict';
// Real bundled SDK/CLI and Relay dispatch; synthetic prompts, isolated config,
// loopback API only. This verifies delivery and turn ownership, not model quality.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const { LiveTurnRouter } = require('../src/main/live/live-turn-router');
const { LiveAsyncAgentTracker, LiveBackgroundTaskTracker, liveResultDisposition } = require('../src/main/live/live-async-agent-tracker');
const { normalizeSupplement, submitLiveSupplement, observeSupplement } = require('../src/main/live/live-supplement-input');
const { SdkSessionObserver, observeOwnedBackgroundTasks, RouteTimingHistory } = require('../src/main/sdk/sdk-session-observer');
const { resourceEntries, mergeResources } = require('../src/main/sdk/sdk-task-resources');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-steering-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const fixture = path.join(cwd, 'fixture.txt'); fs.writeFileSync(fixture, 'Synthetic itinerary fixture');
const output = path.join(__dirname, '../.codex-tmp/sdk-midstream-steering'); fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const onStart = source.indexOf('  const onMessage = (evt) => {', source.indexOf('function spawnLiveSession'));
const onEnd = source.indexOf('  const onExit = ', onStart);
const finishStart = source.indexOf('function finishTurn(sess, resultEvt) {');
const finishEnd = source.indexOf('// 预启动:', finishStart);
assert.ok(onStart >= 0 && onEnd > onStart && finishStart >= 0 && finishEnd > finishStart, 'current bootstrap stream boundaries exist');
function declaration(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists in bootstrap');
  const tail = source.slice(start), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], checks: [], scenarios: [] };
let active, server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
async function until(test, label) {
  const deadline = Date.now() + 30000;
  while (!test()) { if (active?.fatal) throw active.fatal; if (Date.now() > deadline) throw Error('Timed out: ' + label); await sleep(20); }
}
function reply(res, body, blocks, hold = false) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
    content: blocks, stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  assert.equal(body.stream, true, 'fixture expects SDK streaming requests');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  let released = false;
  const release = () => {
    if (released) return; released = true;
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  };
  if (hold) active.release = release; else release();
}
function harness(name) {
  const original = randomUUID(), supplement = randomUUID();
  const state = active = { name, original, supplement, events: [], raw: [], requests: [], results: [] };
  const observer = new SdkSessionObserver(), liveSessions = new Map(), records = new Map();
  const sess = state.session = { convId: randomUUID(), jobId: original, busy: true,
    observer, launchSpec: { cwd, runtimeCwd: cwd, agentEnvironment: 'native' },
    onEvent: event => { state.events.push(event); if (event.type === 'result') state.results.push(event); },
    keepAliveForAsyncAgents: true, asyncAgentTracker: new LiveAsyncAgentTracker(),
    backgroundTaskTracker: new LiveBackgroundTaskTracker(), turnRouter: new LiveTurnRouter(),
    checkpointRunIds: new Set(), supplementInputs: new Map(), turnStartedAt: Date.now() };
  sess.turnRouter.begin(original); liveSessions.set(sess.convId, sess);
  records.set(sess.convId, { id: sess.convId, title: 'Synthetic steering fixture', turns: [{ runId: original, user: 'original', assistant: '' }] });
  const context = { TaskClock: require('../src/main/tasks/task-clock').TaskClock, sess, convId: sess.convId, liveResultDisposition, observeSupplement,
    observer, liveSessions, liveTombstones: new Map(), nativeFork: null,
    routeTimingHistory: new RouteTimingHistory(), observeOwnedBackgroundTasks, resourceEntries, mergeResources,
    process: { env: { CLAUDE_CONFIG_DIR: config } }, path, os: { homedir: () => base },
    loadConversation: id => records.has(id) ? structuredClone(records.get(id)) : null,
    persistConversationRecord: record => records.set(record.id, structuredClone(record)),
    applicationWindows: { mainWindow: null },
    publishLiveSupplement() {}, settleLiveSupplements() { return []; },
    console: { log() {}, warn() {}, error() {} }, interactionBroker: { rejectTask() {} }, checkpointManager: null,
    touchIdleTimer() {}, refreshTrayMenu() {}, retryMissingOrchestrateAgents() { return false; },
    setTimeout() { return { unref() {} }; }, snapshotMcpChildren() {}, killLiveSession() { throw Error('Unexpected session recycle'); } };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.runInNewContext(`${declaration('compactContextUsage')}\n${declaration('contextRuntimeKey')}\n${source.slice(finishStart, finishEnd)}\n${source.slice(onStart, onEnd)}\nglobalThis.ingest = onMessage;`, context);
  state.ingest = event => { state.raw.push(event); try { context.ingest(event); } catch (error) { state.fatal = error; throw error; } };
  return state;
}
async function scenario(name, url) {
  const state = harness(name), { session, original, supplement } = state;
  const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-steering-key', ANTHROPIC_BASE_URL: url,
    ANTHROPIC_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const child = session.child = relay.createLiveSession({ cwd, model: 'fixture-model', runtimeEnv, tools: ['Read'],
    includeRelayInstructions: false, mcpServers: {},
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {}, persistSession: false, maxTurns: 4 } },
    canUseTool: async (name, input) => name === 'Read' && input.file_path === fixture
      ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only fixture Read is allowed' },
    onMessage: state.ingest, onExit(code, error) { state.exit = { code, error }; },
  });
  try {
    check(name + ': original accepted', child.push('Produce a synthetic two-day itinerary.', { uuid: original }));
    await until(() => state.release && state.raw.some(event => event.type === 'stream_event' && event.event?.type === 'content_block_delta'), name + ': first streamed block');
    const input = normalizeSupplement({ messageId: supplement, prompt: '改成一天的日程吧', followUpMode: name === 'queue' ? 'queue' : 'steer' });
    const sent = submitLiveSupplement({ session, jobId: original, input, persist() {}, emit() {} });
    check(name + ': supplement accepted while original stream is open', sent.ok);
    await until(() => state.raw.some(event => event.type === 'command_lifecycle' && event.command_uuid === supplement && event.state === 'queued'), name + ': SDK queued receipt');
    check(name + ': queued receipt is not model consumption', input.status === 'queued' && session.turnRouter.hasPendingSupplements());
    state.release();
    await until(() => state.events.some(event => event.type === 'job-done'), name + ': Relay completion');
    check(name + ': updated requirement reaches a subsequent model request', state.requests.some(item => item.containsSupplement));
    check(name + ': model receives the correct immediate-or-queued requirement semantics', state.requests.filter(item => item.containsSupplement)
      .every(item => name === 'queue' ? item.queued && !item.overridesEarlierRequirement : item.overridesEarlierRequirement && !item.queued));
    check(name + ': final result is the revised one-day itinerary', state.events.at(-1).finalResult?.result === 'UPDATED_ONE_DAY_ITINERARY');
    check(name + ': Relay emits one terminal completion only', state.events.filter(event => event.type === 'job-done').length === 1);
    check(name + ': no synthetic interrupt or process restart', state.results.every(event => !/^aborted_/.test(String(event.terminal_reason || ''))) && !state.exit);
    check(name + ': supplement has consumption evidence', input.status === 'applied');
    check(name + ': all frames remain assigned to original Relay run', state.events.every(event => event.jobId === original));
    check(name + ': endpoint and model remain isolated', state.requests.every(item => item.authorized && item.model === 'fixture-model'));
    if (name === 'tool-boundary') check(name + ': supplement folds before post-tool request', state.requests.length === 2 && state.results.length === 1);
    else check(name + ': old answer does not end the run before revised answer', state.results.length === 2 && state.results[0].relay_pending_inputs === 1);
  } finally {
    if (state.release) state.release(); await child.kill();
    report.scenarios.push({ name, requests: state.requests,
      results: state.results.map(event => ({ text: event.result, uuid: event.user_message_uuid, uuids: event.user_message_uuids, pending: event.relay_pending_inputs, reason: event.terminal_reason })),
      lifecycle: state.raw.filter(event => event.type === 'command_lifecycle').map(event => ({ command: event.command_uuid === original ? 'original' : event.command_uuid === supplement ? 'supplement' : 'other', state: event.state })) });
  }
}
(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (req.url.includes('/count_tokens')) { res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      try {
        const body = JSON.parse(raw), index = active.requests.length;
        const messages = JSON.stringify(body.messages);
        const containsSupplement = messages.includes('改成一天的日程吧');
        active.requests.push({ model: body.model, authorized: req.headers['x-api-key'] === 'synthetic-steering-key', containsSupplement,
          overridesEarlierRequirement: messages.includes('覆盖之前冲突的用户要求'), queued: messages.includes('当前工作已完成后'), resultsBefore: active.results.length });
        const blocks = !index && active.name === 'tool-boundary'
          ? [{ type: 'tool_use', id: 'tool_' + randomUUID(), name: 'Read', input: { file_path: fixture } }]
          : [{ type: 'text', text: containsSupplement ? 'UPDATED_ONE_DAY_ITINERARY' : 'OLD_TWO_DAY_ITINERARY' }];
        reply(res, body, blocks, index === 0);
      } catch (error) { res.destroy(error); report.serverError = String(error); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/anthropic`;
  for (const name of ['text-final', 'tool-boundary', 'queue']) await scenario(name, url);
  report.ok = true;
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, scenarios: report.scenarios.length }));
})().catch(error => { report.ok = false; report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; })
  .finally(async () => {
    if (active?.session?.child) await active.session.child.kill();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (let attempt = 0; attempt < 30; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true; break; }
      catch (_) { await sleep(100); }
    }
    if (!report.cleanedUp) { report.ok = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  });
