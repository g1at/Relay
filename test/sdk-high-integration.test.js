'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SdkSessionObserver, stopOwnedTask } = require('../sdk-session-observer');
const { collectStructuredOutput } = require('../sdk-structured-output');
const { resourceEntries, mergeResources, ownedResource, resourceTarget } = require('../sdk-task-resources');
const { instructionFingerprint, runtimeContractFingerprint, requiresFreshContract } = require('../sdk-runtime-contract');
const { _buildOptions } = require('../claude-sdk');

test('initialize and changing SDK state are scoped, advisory and credential-free', () => {
  let now = 100;
  const state = new SdkSessionObserver({ now: () => now });
  now = 130;
  state.initialized({ account: { email: 'SECRET' }, hooks_applied: false, agents: [{ name: 'agent' }], commands: [{ name: 'context' }] });
  state.observe({ type: 'system', subtype: 'init', session_id: 'a', capabilities: ['known', 'future'], tools: ['Read'], plugins: [{ name: 'plugin', path: 'SECRET' }] });
  state.observe({ type: 'system', subtype: 'session_state_changed', session_id: 'a', state: 'requires_action' });
  assert.equal(state.state, 'requires_action');
  assert.equal(state.observe({ type: 'system', subtype: 'session_state_changed', session_id: 'wrong', state: 'idle' }), false);
  state.stderr('MCP authentication token=SECRET');
  assert.ok(!JSON.stringify(state.snapshot()).includes('SECRET'));
  assert.equal(state.snapshot().initialization.hooksApplied, false);
  state.observe({ type: 'conversation_reset', session_id: 'a', new_conversation_id: 'b' });
  assert.equal(state.epoch, 1);
  assert.equal(state.observe({ type: 'conversation_reset', session_id: 'a', new_conversation_id: 'c' }), false);
  assert.equal(state.sessionId, 'b');
});

test('latency measures first actual text and keeps SDK request durations separate', () => {
  let now = 10;
  const state = new SdkSessionObserver({ now: () => now }); state.beginTurn();
  now = 30; state.observe({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(state.timing.firstVisibleMs, undefined);
  now = 60; state.observe({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hello' } } });
  state.observe({ type: 'result', ttft_ms: 12, time_to_request_ms: 24, duration_ms: 90 });
  assert.equal(state.timing.firstVisibleMs, 50);
  assert.equal(state.timing.ttft_ms, 12);
  state.preparation({ startupMs: 8, mcpMs: 4, totalMs: 20, secret: 'hidden' });
  assert.equal(state.timing.startupMs, 8); assert.equal(state.timing.secret, undefined);
});

test('single-task stop is idempotent, rejects cross-turn clicks and does not fake completion', async () => {
  let finish, calls = 0;
  const session = { convId: 'a', jobId: 'run', busy: true, backgroundTaskTracker: { tasks: new Map([['task', {}]]) },
    child: { stopTask: async () => { calls++; await new Promise(r => { finish = r; }); } } };
  const args = { session, convId: 'a', jobId: 'run', taskId: 'task', isCurrent: x => x === session };
  const first = stopOwnedTask(args), duplicate = stopOwnedTask(args);
  assert.equal(calls, 1);
  assert.equal((await stopOwnedTask({ ...args, convId: 'other' })).ok, false);
  finish(); assert.equal((await first).requested, true); assert.equal((await duplicate).ok, true);
  assert.equal(session.backgroundTaskTracker.tasks.has('task'), true);
  assert.equal(session.busy, true);
});

test('a late task-stop acknowledgement cannot affect a new turn', async () => {
  let finish;
  const session = { convId: 'a', jobId: 'r1', busy: true, backgroundTaskTracker: { tasks: new Map([['t', {}]]) }, child: { stopTask: () => new Promise(r => { finish = r; }) } };
  const pending = stopOwnedTask({ session, convId: 'a', jobId: 'r1', taskId: 't', isCurrent: () => true });
  session.jobId = 'r2'; finish(); assert.equal((await pending).stale, true);
});

test('structured helpers trust only successful final SDK structured_output', async () => {
  async function* stream(result) { yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"value":"wrong"}' }] } }; yield result; }
  const validate = value => ({ success: typeof value?.value === 'string', data: value });
  assert.deepEqual(await collectStructuredOutput(stream({ type: 'result', subtype: 'success', structured_output: { value: 'right' } }), validate), { value: 'right' });
  await assert.rejects(collectStructuredOutput(stream({ type: 'result', subtype: 'success', result: '{"value":"wrong"}' }), validate), { code: 'STRUCTURED_OUTPUT_MISSING' });
  await assert.rejects(collectStructuredOutput(stream({ type: 'result', subtype: 'success', is_error: true, structured_output: { value: 'partial' } }), validate), { code: 'STRUCTURED_OUTPUT_FAILED' });
  await assert.rejects(collectStructuredOutput(stream({ type: 'result', subtype: 'success', structured_output: {} }), validate), { code: 'STRUCTURED_OUTPUT_INVALID' });
});

test('SDK options carry native Agent, hooks, elicitation and policy without losing model ownership', async () => {
  const elicitation = () => {}, stderr = () => {}; let instruction;
  const nativeAgent = { agent: 'custom', agents: { custom: { description: 'custom', prompt: 'definition', model: 'inherit', tools: [] } } };
  const result = _buildOptions({ cwd: os.tmpdir(), model: 'provider-model', permissionMode: 'default', nativeAgent,
    runtimePolicy: { settingSources: ['user', 'project'], settings: { autoMemoryEnabled: false, disableAllHooks: true } },
    onElicitation: elicitation, stderr, onInstructionsLoaded: value => { instruction = value; }, perTaskStopAffordance: true }, {});
  assert.equal(result.model, 'provider-model'); assert.deepEqual(result.agents.custom.tools, []);
  assert.equal(result.agents.custom.model, 'inherit'); assert.equal(result.onElicitation, elicitation);
  assert.equal(result.stderr, stderr); assert.equal(result.perTaskStopAffordance, true);
  assert.equal(result.settings.autoMemoryEnabled, false); assert.deepEqual(result.settingSources, ['user', 'project']);
  await result.hooks.InstructionsLoaded[0].hooks[0]({ file_path: 'CLAUDE.md' });
  assert.equal(instruction.file_path, 'CLAUDE.md');
});

test('task output and MCP resources retain owning task across history, reject unowned links', () => {
  const event = { type: 'system', subtype: 'task_notification', task_id: 't', output_file: '/tmp/output.txt', resource_links: [{ uri: 'https://example.test/report', name: 'report' }] };
  const resources = resourceEntries(event, { jobId: 'run', cwd: '/workspace' });
  const saved = JSON.parse(JSON.stringify(mergeResources(resources, resources)));
  assert.equal(saved.length, 2);
  assert.equal(ownedResource(saved, { jobId: 'other', taskId: 't', uri: '/tmp/output.txt' }), null);
  assert.equal(resourceTarget(saved[1]).kind, 'url');
  assert.equal(resourceTarget({ uri: 'javascript:alert(1)' }).kind, 'resource');
  assert.throws(() => resourceTarget({ uri: 'https://user:password@example.test' }));
  assert.equal(resourceTarget({ uri: '/mnt/c/Users/test/out.txt' }, 'win32').path, 'C:\\Users\\test\\out.txt');
});

test('instruction changes invalidate snapshots without rewriting Relay history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-contract-'));
  try {
    const args = { cwd: dir, configDir: dir, settingSources: ['user'] };
    const a = runtimeContractFingerprint({ fingerprint: 'policy' }, null, instructionFingerprint(args));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'new instructions');
    const b = runtimeContractFingerprint({ fingerprint: 'policy' }, null, instructionFingerprint(args));
    assert.notEqual(a, b);
    const saved = { sessionId: 'session', sdkRuntimeFingerprint: a, title: 'manual', pinned: true, updatedAt: 'old', turns: ['visible history'] };
    assert.equal(requiresFreshContract(saved, b), true); assert.equal(saved.updatedAt, 'old');
    assert.deepEqual(saved.turns, ['visible history']); assert.equal(requiresFreshContract({ sessionId: 'old-without-fingerprint' }, a), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plugin reload uses the fresh reload receipt, not supportedAgents initialize cache', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('async function refreshLivePluginCatalog(');
  const end = source.indexOf('\nasync function reloadSkillsInLiveSessions(', start);
  let staleCalls = 0;
  const sess = { convId: 'conv', observer: new SdkSessionObserver(), child: {
    reloadPlugins: async () => ({ agents: [{ name: 'new-agent' }], commands: [{ name: 'new-skill' }], plugins: [], mcpServers: [], error_count: 0 }),
    supportedAgents: async () => { staleCalls++; return [{ name: 'removed-agent' }]; },
  } };
  const context = vm.createContext({ liveSessions: new Map([['conv', sess]]), withLiveControlTimeout: promise => promise, readSupportedModels: async () => [] });
  vm.runInContext(source.slice(start, end), context);
  assert.equal((await context.refreshLivePluginCatalog(sess)).ok, true);
  assert.equal(staleCalls, 0); assert.equal(sess.supportedAgents[0].name, 'new-agent');
  assert.equal(sess.observer.catalog.commands[0], 'new-skill');
});

test('diagnostics inspect the running environment and source policy after preferences change', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const marker = 'getSdkDiagnostics: async input => ';
  const start = source.indexOf(marker), end = source.indexOf('\n  },\n});', start);
  const calls = [];
  const sess = { launchSpec: { agentEnvironment: 'wsl', runtimeCwd: '/home/fixture', wslDistribution: 'Ubuntu', cwd: 'C:\\fixture' },
    runtimeContract: { policy: { settingSources: ['user', 'project'], summary: { trusted: true } } },
    diagnostics: { getInstructions: () => [], inspect: () => { throw Error('wrong host environment'); } },
    observer: new SdkSessionObserver() };
  const context = vm.createContext({ liveSessions: new Map([['conv', sess]]), sdkProjectContext: () => null,
    normalizePreferences: () => ({ agentEnvironment: 'native' }), readAppSettings: () => ({}),
    buildRuntimePolicy: () => { throw Error('running policy was replaced'); },
    agentEnvironmentService: { inspectSettings: async input => { calls.push(input); return { ok: true }; } },
    collectRouteTimings: () => [] });
  vm.runInContext('globalThis.inspect = async input => ' + source.slice(start + marker.length, end + 4), context);
  assert.equal((await context.inspect({ conversationId: 'conv' })).ok, true);
  assert.equal(calls[0].cwd, '/home/fixture'); assert.equal(calls[0].wslDistribution, 'Ubuntu');
  assert.deepEqual([...calls[0].settingSources], ['user', 'project']);
});
