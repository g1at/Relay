'use strict';
// Real locally installed SDK/CLI, synthetic loopback provider, isolated config.
// Exercises the actual main.js admission/dispatch/finish pipeline in a VM; all
// conversations and ledger state are in memory. No real user task or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const relay = require('../claude-sdk');
const { LiveTurnRouter } = require('../live-turn-router');
const { LiveTurnControls } = require('../live-turn-control');
const { LiveAsyncAgentTracker, LiveBackgroundTaskTracker, liveResultDisposition } = require('../live-async-agent-tracker');
const supplements = require('../live-supplement-input');
const { SdkSessionObserver, observeOwnedBackgroundTasks, RouteTimingHistory } = require('../sdk-session-observer');
const { resourceEntries, mergeResources } = require('../sdk-task-resources');

const output = path.join(__dirname, '../.codex-tmp/sdk-stopped-supplement');
fs.mkdirSync(output, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stopped-supplement-'));
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  sdk: require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version,
  checks: [], scenarios: [],
  isolation: { syntheticProvider: true, loopbackOnly: true, isolatedConfigAndWorkspace: true,
    realUserHistoryRead: false, realProviderKeyUsed: false, settingSources: [], strictMcpConfig: true },
  limits: ['Provider responses are deterministic local fixtures, not a real model quality or remote reliability test.',
    'Electron/UI are not launched; real main.js functions run with in-memory persistence and a synthetic window boundary.',
    'The installed SDK can emit started before interrupt. The report records this; result-only missing-receipt fallback is covered separately by unit tests.',
    'The queued negative case uses real LiveTurnControls and strictly fails if later input reaches the provider despite shutdown.',
    'Atomic queued cancellation is checked against the installed 0.3.266 runtime/capability; its declaration may not expose the optional interrupt argument. Older SDK fallback cannot claim the same guarantee.'],
};
let active, server;
const clone = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, condition) { assert.ok(condition, name); report.checks.push(name); }
function declaration(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists in main.js');
  const tail = source.slice(start), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
async function until(state, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (state.fatal) throw state.fatal;
    if (state.exit && !state.events.some(event => event.type === 'job-done')) {
      throw Error(label + ': child exited before final result: ' + JSON.stringify(state.exit));
    }
    if (Date.now() >= deadline) throw Error('Timed out: ' + label);
    await sleep(20);
  }
  if (state.fatal) throw state.fatal;
}

function harness(name, cwd, config) {
  const ids = { conv: randomUUID(), run: randomUUID(), supplement: randomUUID() };
  const records = new Map([[ids.conv, { id: ids.conv, title: 'Synthetic interrupt verification',
    updatedAt: '2026-01-01T00:00:00.000Z', workingDir: { path: cwd, name: 'synthetic' },
    turns: [{ runId: ids.run, user: 'SYNTHETIC_ORIGINAL_' + name, assistant: '' }] }]]);
  const observer = new SdkSessionObserver();
  const state = { name, ids, cwd, config, events: [], raw: [], requests: [], pushes: [], kills: [],
    writes: 0, records, controls: [], openResponses: new Set(), toolReads: 0 };
  const liveSessions = new Map(), ledger = new Map(), jobs = new Map();
  const sess = state.session = { observer, launchSpec: { cwd, runtimeCwd: cwd, agentEnvironment: 'native' },
    convId: ids.conv, jobId: ids.run, busy: true, dead: false, turnStartedAt: Date.now(),
    onEvent: event => state.events.push(clone(event)), turnRouter: new LiveTurnRouter(),
    asyncAgentTracker: new LiveAsyncAgentTracker(), backgroundTaskTracker: new LiveBackgroundTaskTracker(),
    supplementInputs: new Map(), checkpointRunIds: new Set(), keepAliveForAsyncAgents: true };
  sess.turnRouter.begin(ids.run); liveSessions.set(ids.conv, sess);
  const context = {
    TaskClock: require('../task-clock').TaskClock, ...supplements, observer, resourceEntries, mergeResources,
    routeTimingHistory: new RouteTimingHistory(), sess, convId: ids.conv, liveSessions, jobs,
    liveTombstones: new Map(), process: { env: { CLAUDE_CONFIG_DIR: config } },
    path, os: { homedir: () => base },
    readAppSettings: () => ({ followUpMode: 'steer' }), liveResultDisposition, observeOwnedBackgroundTasks,
    console: { log() {}, warn() {}, error(...args) { state.mainWarnings ||= []; state.mainWarnings.push(args.map(String).join(' ')); } },
    taskLedger: { get: id => ledger.get(id) || null },
    isTerminalState: value => ['succeeded', 'failed', 'canceled'].includes(value),
    liveTurnControls: { isStopping: () => sess.turnRouter.interruptRequested },
    interactionBroker: { rejectTask() {} }, checkpointManager: null,
    loadConversation: id => records.has(id) ? clone(records.get(id)) : null,
    persistConversationRecord: record => { records.set(record.id, clone(record)); state.writes++; },
    fs: { existsSync: id => records.has(id) }, convFilePath: id => id,
    TITLE_MAX_W: 64, truncateByWidth: text => text,
    touchIdleTimer() {}, refreshTrayMenu() {}, retryMissingOrchestrateAgents() { return false; },
    setTimeout() { return { unref() {} }; }, clearTimeout() {}, snapshotMcpChildren() {},
    killLiveSession(value, reason) {
      state.kills.push(reason); value.dead = true; liveSessions.delete(value.convId);
      return value.child ? value.child.kill() : Promise.resolve();
    },
    cancelPendingLiveInput(value) { value.pendingInput = null; },
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context);
  for (const name of ['persistGoalRecovery', 'saveConversation', 'persistLiveSupplementRecord',
    'publishLiveSupplement', 'settleLiveSupplements', 'steerLiveTurn', 'finishTurn', 'settleUnsentLiveTurn']) {
    vm.runInContext(declaration(name), context);
  }
  const start = source.indexOf('  const onMessage = (evt) => {', source.indexOf('function spawnLiveSession'));
  const end = source.indexOf('  const canUseTool = ', start);
  assert.ok(start > 0 && end > start, 'current main.js stream handler boundaries found');
  vm.runInContext(source.slice(start, end) + '\nglobalThis.ingest=onMessage;globalThis.exit=onExit;', context);
  const withTimeout = (promise, label, timeoutMs) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs || 5000);
    })]).finally(() => clearTimeout(timer));
  };
  state.hostControls = new LiveTurnControls({
    cancelPendingInput: () => false,
    settleUnsent: (...args) => context.settleUnsentLiveTurn(...args), withTimeout,
    waitForIdle: async (value, jobId) => {
      const deadline = Date.now() + 3000;
      while (value.busy && value.jobId === jobId && Date.now() < deadline) await sleep(10);
      return !value.busy || value.jobId !== jobId;
    },
    killSession: (value, reason) => context.killLiveSession(value, reason),
  });
  context.liveTurnControls = state.hostControls;
  state.ingest = event => {
    state.raw.push(clone(event));
    try { context.ingest(event); } catch (error) { state.fatal = error; }
  };
  state.onExit = (code, error) => {
    state.exit = { code, error: error ? String(error) : null };
    try { context.exit(code, error); } catch (failure) { state.fatal ||= failure; }
  };
  state.steer = followUpMode => context.steerLiveTurn({ conversationId: ids.conv, jobId: ids.run,
    messageId: ids.supplement, prompt: 'SYNTHETIC_REQUIREMENT_' + name, followUpMode, files: [], skill: null });
  state.saved = () => records.get(ids.conv).turns[0].supplements?.find(input => input.id === ids.supplement);
  return state;
}

// The first response stops only after the test releases its Read boundary. The
// second remains inside a text block so interrupt must target active streaming.
function streamResponse(state, res, body, index) {
  const messageId = 'msg_' + randomUUID();
  state.openResponses.add(res);
  res.once('close', () => state.openResponses.delete(res));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant',
    model: body.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 24, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  if (index === 0) {
    state.firstMessageId = messageId;
    const toolId = 'tool_' + randomUUID(); state.readToolId = toolId;
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: 'Read', input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: state.fixture }) } });
    let released = false;
    state.releaseFirst = () => {
      if (released || res.destroyed || res.writableEnded) return; released = true;
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } });
      emit('message_stop', { type: 'message_stop' }); res.end();
    };
  } else {
    state.secondMessageId = messageId;
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'SYNTHETIC_PROCESSING_AFTER_READ' } });
  }
}

function summarize(state) {
  const relativeId = id => id === state.ids.run ? 'original' : id === state.ids.supplement ? 'supplement' : id ? 'other' : null;
  const results = state.raw.filter(event => event.type === 'result');
  const completed = state.events.filter(event => event.type === 'job-done');
  return { name: state.name, requests: state.requests, pushes: state.pushes,
    controls: state.controls, hostStopOutcome: state.hostStopOutcome, readPermissionCallbacks: state.toolReads,
    observedReadToolIds: [...new Set(state.raw.filter(event => event.type === 'assistant')
      .flatMap(event => (event.message?.content || []).filter(block => block.type === 'tool_use' && block.name === 'Read').map(block => block.id)))],
    savedSupplementStatus: state.saved()?.status,
    statusBeforeInterrupt: state.statusBeforeInterrupt, completionCount: completed.length,
    earlierStartedReceipt: state.startedBeforeInterrupt,
    requestsBeforeInterrupt: state.requestsBeforeInterrupt,
    sdkDrainRequestsAfterInterrupt: state.requests.slice(state.requestsBeforeInterrupt || 0)
      .filter(request => request.containsSupplement).length,
    recycleCountBeforeCleanup: state.kills.length, mainWarnings: state.mainWarnings || [],
    sdkVersion: state.raw.find(event => event.type === 'system' && event.subtype === 'init')?.claude_code_version,
    sdkCapabilities: state.raw.find(event => event.type === 'system' && event.subtype === 'init')?.capabilities || [],
    lifecycle: state.raw.filter(event => event.type === 'command_lifecycle').map(event => ({ command: relativeId(event.command_uuid), state: event.state })),
    nativeResults: results.map(event => ({ type: event.type, subtype: event.subtype, is_error: event.is_error,
      num_turns: event.num_turns, terminal_reason: event.terminal_reason, stop_reason: event.stop_reason,
      user_message_uuid: relativeId(event.user_message_uuid), user_message_uuids: event.user_message_uuids?.map(relativeId),
      queued_turn_count: event.queued_turn_count, resultLength: String(event.result || '').length,
      errors: event.errors || [], relay_pending_inputs: event.relay_pending_inputs })),
    final: completed.map(event => ({ jobId: relativeId(event.jobId), terminal_reason: event.finalResult?.terminal_reason,
      is_error: event.finalResult?.is_error, pendingInputs: event.finalResult?.relay_pending_inputs,
      unappliedStatuses: (event.relay_unapplied_inputs || []).map(input => input.status) })),
    exit: state.exit, fatal: state.fatal ? String(state.fatal.stack || state.fatal) : null };
}

async function scenario(name, url) {
  const location = path.join(base, name), config = path.join(location, 'config'), cwd = path.join(location, 'workspace');
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(config, 'settings.json'), '{}');
  const state = active = harness(name, cwd, config);
  state.fixture = path.join(cwd, 'fixture.txt'); fs.writeFileSync(state.fixture, 'SYNTHETIC_READ_BOUNDARY_FIXTURE');
  const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-stopped-supplement-key',
    ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: 'fixture-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-model', CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}) };
  const child = state.session.child = relay.createLiveSession({ cwd, model: 'fixture-model', tools: ['Read'],
    includeRelayInstructions: false, runtimeEnv, mcpServers: {},
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {}, persistSession: false, maxTurns: 4 } },
    canUseTool: async (toolName, input) => {
      if (toolName === 'Read' && path.resolve(input.file_path) === path.resolve(state.fixture)) {
        state.toolReads++; return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: 'Only the isolated synthetic Read fixture is allowed' };
    }, onMessage: state.ingest, onExit: state.onExit,
  });
  const originalPush = child.push.bind(child);
  child.push = (text, metadata = {}) => {
    state.pushes.push({ command: metadata.uuid === state.ids.run ? 'original' : metadata.uuid === state.ids.supplement ? 'supplement' : 'other',
      priority: metadata.priority || null, textSha256: createHash('sha256').update(text).digest('hex') });
    return originalPush(text, metadata);
  };
  const originalInterrupt = child.interrupt.bind(child);
  child.interrupt = async () => {
    state.controls.push({ type: 'sdk.interrupt.request', at: new Date().toISOString() });
    const receipt = await originalInterrupt();
    state.controls.push({ type: 'sdk.interrupt.receipt', at: new Date().toISOString(), acknowledged: receipt !== false,
      canceledQueued: receipt?.cancelled?.includes(state.ids.supplement) || false,
      stillQueued: receipt?.still_queued?.includes(state.ids.supplement) || false });
    return receipt;
  };
  const routerInterrupt = state.session.turnRouter.interrupt.bind(state.session.turnRouter);
  state.session.turnRouter.interrupt = () => {
    state.controls.push({ type: 'router.interrupt', at: new Date().toISOString() }); return routerInterrupt();
  };
  try {
    check(name + ': typed original accepted', child.push('SYNTHETIC_ORIGINAL_' + name, { uuid: state.ids.run }));
    await until(state, () => state.releaseFirst && state.raw.some(event => event.type === 'stream_event'
      && event.event?.type === 'content_block_delta'), name + ': first stream');
    const mode = name === 'absorbed-steer' ? 'steer' : 'queue';
    const accepted = state.steer(mode);
    check(name + ': main admission accepts supplement', accepted.ok);
    check(name + ': typed follow-up has expected priority', state.pushes.at(-1).priority === (mode === 'steer' ? 'next' : 'later'));
    await until(state, () => state.raw.some(event => event.type === 'command_lifecycle'
      && event.command_uuid === state.ids.supplement && event.state === 'queued'), name + ': native queued receipt');
    check(name + ': queue acknowledgement is not consumption', state.saved()?.status === 'queued');
    if (mode === 'steer') {
      state.releaseFirst();
      await until(state, () => state.requests.length === 2 && state.raw.some(event => event.type === 'stream_event'
        && event.event?.delta?.text === 'SYNTHETIC_PROCESSING_AFTER_READ'), name + ': post-Read request streaming');
      check(name + ': later provider request contains supplement', state.requests[1].containsSupplement);
      check(name + ': actual fixture Read reached provider context', state.requests[1].containsReadFixture);
    }
    state.statusBeforeInterrupt = state.saved()?.status;
    state.startedBeforeInterrupt = state.raw.some(event => event.type === 'command_lifecycle'
      && event.command_uuid === state.ids.supplement && event.state === 'started');
    state.requestsBeforeInterrupt = state.requests.length;
    if (mode === 'steer') { state.session.turnRouter.interrupt(); await child.interrupt(); }
    else state.hostStopOutcome = await state.hostControls.interrupt(state.session);
    await until(state, () => state.events.some(event => event.type === 'job-done'), name + ': main terminal completion');
    const final = state.events.find(event => event.type === 'job-done');
    const native = state.raw.find(event => event.type === 'result');
    check(name + ': real SDK reports interrupted error', native?.is_error === true
      && native.subtype === 'error_during_execution' && native.terminal_reason === 'aborted_streaming');
    check(name + ': one job-done belongs to original run', state.events.filter(event => event.type === 'job-done').length === 1 && final.jobId === state.ids.run);
    check(name + ': supplement was pushed once without replay', state.pushes.filter(push => push.command === 'supplement').length === 1);
    check(name + ': native API model and authorization stayed synthetic', state.requests.every(request => request.model === 'fixture-model' && request.syntheticAuthorization));
    if (mode === 'steer') {
      check(name + ': real error explicitly covers original and absorbed supplement', native.user_message_uuids?.includes(state.ids.run)
        && native.user_message_uuids?.includes(state.ids.supplement));
      check(name + ': main persistence records applied', state.saved()?.status === 'applied');
      check(name + ': final result has no pending or unapplied input', !final.finalResult.relay_pending_inputs
        && !final.relay_unapplied_inputs?.length && !final.finalResult.relay_unapplied_inputs?.length);
      check(name + ': no unnecessary session recycle for consumed input', state.kills.length === 0);
      check(name + ': exactly two model requests before cleanup', state.requests.length === 2);
    } else {
      check(name + ': queued input had not entered provider request at interrupt', state.requestsBeforeInterrupt === 1
        && !state.requests[0].containsSupplement && !state.startedBeforeInterrupt);
      check(name + ': real host stop prevents queued input reaching provider', state.requests.length === 1
        && state.requests.every(request => !request.containsSupplement));
      check(name + ': real error never claims unconsumed supplement', !native?.user_message_uuids?.includes(state.ids.supplement));
      check(name + ': main preserves canceled state for unconsumed input', state.saved()?.status === 'canceled');
      check(name + ': final reports only queued supplement unapplied', final.relay_unapplied_inputs?.length === 1
        && final.relay_unapplied_inputs[0].id === state.ids.supplement && final.relay_unapplied_inputs[0].status === 'canceled');
      check(name + ': SDK atomically cancels queued supplement', state.controls.some(control => control.type === 'sdk.interrupt.receipt'
        && control.canceledQueued === true && control.stillQueued === false));
      check(name + ': host stop settles without fallback recycle', state.kills.length === 0
        && state.hostStopOutcome?.settled === true && state.hostStopOutcome?.preservedSession === true);
    }
  } finally {
    // Do not finish a held SSE after interrupt: its socket may already be closed.
    await child.kill();
    for (const res of state.openResponses) res.destroy();
    await sleep(20);
    report.scenarios.push(summarize(state));
    check(name + ': child exit does not duplicate logical completion', state.events.filter(event => event.type === 'job-done').length === 1);
  }
}

(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      if (req.url.includes('/count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":24}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const state = active;
      try {
        const body = JSON.parse(raw), index = state.requests.length, messages = JSON.stringify(body.messages);
        assert.equal(body.stream, true, 'local fixture requires real SDK SSE');
        assert.ok(index < 2, 'unexpected extra model request; possible automatic replay');
        state.requests.push({ index, model: body.model, streaming: body.stream,
          syntheticAuthorization: req.headers['x-api-key'] === 'synthetic-stopped-supplement-key',
          containsOriginal: messages.includes('SYNTHETIC_ORIGINAL_' + state.name),
          containsSupplement: messages.includes('SYNTHETIC_REQUIREMENT_' + state.name),
          containsReadFixture: messages.includes('SYNTHETIC_READ_BOUNDARY_FIXTURE'),
          at: new Date().toISOString() });
        streamResponse(state, res, body, index);
      } catch (error) { state.fatal = error; res.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['absorbed-steer', 'unconsumed-queue']) await scenario(name, url);
  report.ok = true;
})().catch(error => { report.ok = false; report.error = String(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    if (active?.session?.child) await active.session.child.kill();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (let attempt = 0; attempt < 30; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true; break; }
      catch (_) { await sleep(100); }
    }
    if (!report.cleanedUp) { report.ok = false; report.cleanupFailed = true; process.exitCode = 1; }
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, scenarios: report.scenarios.length,
      cleanedUp: report.cleanedUp, error: report.error, report: path.join(output, 'result.json') }));
  });
