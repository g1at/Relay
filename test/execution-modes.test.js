'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { prepareExecutionRequest, normalizeExecutionMode, executionToolPolicy, LiveExecutionModes } = require('../src/main/projects/execution-modes');

const tick = () => new Promise(setImmediate);
const localResult = result => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, duration_api_ms: 0, result });
function controller(overrides = {}) {
  const calls = { controls: [], inputs: [], stops: 0 };
  const modes = new LiveExecutionModes({
    async control(method, ...args) { calls.controls.push([method, ...args]); return method === 'supportedCommands' ? [{ name: 'goal' }] : undefined; },
    enqueue(text, metadata) { calls.inputs.push({ text, metadata }); return true; },
    stop() { calls.stops++; }, ...overrides,
  });
  return { modes, calls, complete(result) {
    const id = calls.inputs.at(-1).metadata.uuid;
    modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
    modes.observe(localResult(result));
    modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
  } };
}

test('goal uses the native command and keeps all attachment/context text outside the 4000-character condition', () => {
  const context = '附件上下文'.repeat(2000);
  const request = prepareExecutionRequest('/goal 所有用例通过', context, { kind: 'goal' });
  assert.equal(request.prompt, '/goal 所有用例通过');
  assert.equal(request.contextPrompt, context);
  assert.equal(request.goalCondition, '所有用例通过');
  assert.equal(request.goalExplicit, true);
  assert.equal(prepareExecutionRequest('继续', 'full context', { kind: 'goal' }).goalExplicit, false);
  assert.deepEqual(request.executionMode, { kind: 'goal' });
  assert.equal(prepareExecutionRequest('普通文字', 'full context').prompt, 'full context');
  assert.match(prepareExecutionRequest('/goal 不应激活', 'some context', { kind: 'plan' }).prompt, /^当前会话处于只读计划模式/);
});

test('invalid goals and unsupported budgets fail explicitly without truncation or silent mode fallback', () => {
  for (const text of ['', '/goal', 'clear', '/goal cancel']) assert.throws(() => prepareExecutionRequest(text, text, { kind: 'goal' }), { code: 'INVALID_GOAL' });
  assert.throws(() => prepareExecutionRequest('x'.repeat(4001), '', { kind: 'goal' }), { code: 'GOAL_TOO_LONG' });
  assert.throws(() => normalizeExecutionMode({ kind: 'goal', tokenBudget: 1000 }), { code: 'UNSUPPORTED_EXECUTION_MODE_OPTION' });
  assert.throws(() => normalizeExecutionMode({ kind: 'unknown' }), { code: 'INVALID_EXECUTION_MODE' });
});

test('plan guards both hooks and approval callback, including bypass, MCP and subagent escalation', async () => {
  let mode = { kind: 'plan' }; const approved = [];
  const policy = executionToolPolicy(() => mode, async name => { approved.push(name); return { behavior: 'allow' }; });
  for (const name of ['Bash', 'Write', 'Edit', 'ExitPlanMode', 'Agent', 'Task', 'mcp__service__write', 'NotebookEdit']) {
    assert.equal((await policy.canUseTool(name, {}, {})).behavior, 'deny');
    const hook = await policy.hooks.PreToolUse[0].hooks[0]({ tool_name: name });
    assert.equal(hook.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(approved.length, 0);
  for (const name of ['Read', 'Grep', 'AskUserQuestion']) assert.equal((await policy.canUseTool(name, {}, {})).behavior, 'allow');
  mode = { kind: 'default' };
  assert.equal((await policy.canUseTool('Write', {}, {})).behavior, 'allow');
  assert.deepEqual(await policy.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write' }), {});
});

test('resumed goal is cleared before permission changes; an unrelated uncorrelated result cannot acknowledge the clear', async () => {
  const h = controller({ resumed: true });
  let settled = false;
  const work = h.modes.prepare({ kind: 'plan' }).then(result => { settled = true; return result; });
  await tick();
  assert.equal(h.calls.inputs[0].text, '/goal clear');
  assert.equal(h.modes.observe(localResult('No goal set')).type, 'result');
  assert.equal(settled, false);
  h.modes.observe({ type: 'command_lifecycle', command_uuid: 'foreign', state: 'completed' });
  await tick(); assert.equal(settled, false);
  h.complete('Goal cleared: fixture goal');
  assert.equal((await work).permissionMode, 'plan');
  assert.deepEqual(h.calls.controls, [['supportedCommands'], ['setPermissionMode', 'plan']]);
});

test('goal context is a no-query input; true user push waits for its completed lifecycle', async () => {
  const h = controller(); const ready = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'full synthetic context' });
  await tick();
  assert.equal(h.calls.inputs[0].metadata.shouldQuery, false);
  assert.match(h.calls.inputs[0].text, /full synthetic context/);
  assert.equal(h.modes.beforePush('/goal tests pass', { uuid: 'job' }), false);
  h.complete(''); await ready;
  assert.equal(h.modes.beforePush('/goal tests pass', { uuid: 'job' }), true);
  assert.equal(h.modes.beforePush('supplement', { uuid: 'supplement', priority: 'next' }), true);
  assert.equal(h.calls.inputs.length, 1, 'supplements never recreate/clear the goal');
  const active = { type: 'active_goal', value: { condition: 'tests pass', iterations: 2 } };
  assert.equal(h.modes.observe(active), active);
});

test('completed alone, a nonzero model result, and failed local commands cannot masquerade as preparation', async () => {
  for (const result of [{ ...localResult('No goal set'), num_turns: 1 }, { ...localResult('No goal set'), is_error: true }, localResult('unknown command')]) {
    const h = controller({ resumed: true }); const ready = h.modes.prepare({ kind: 'default' });
    await tick(); const id = h.calls.inputs[0].metadata.uuid;
    h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
    assert.ok(h.modes.pending, 'without started, completed alone is not an ACK');
    h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
    h.modes.observe(result);
    h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
    await assert.rejects(ready, { code: 'MODE_INPUT_FAILED' }); assert.equal(h.calls.stops, 1);
  }
});

test('a canceled or timed-out preparation closes the Query and cannot release a late prompt', async () => {
  for (const cancel of [true, false]) {
    const h = controller(); const signal = new AbortController();
    const ready = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'fixture', signal: signal.signal,
      timeoutMs: cancel ? 1000 : 10, startupTimeoutMs: cancel ? 1000 : 10 });
    await tick(); if (cancel) signal.abort();
    await assert.rejects(ready, { code: cancel ? 'MODE_PREPARE_CANCELED' : 'MODE_INPUT_START_TIMEOUT' });
    assert.equal(h.calls.stops, 1);
    assert.equal(h.modes.beforePush('late prompt', { uuid: 'late-job' }), false);
    assert.equal(h.modes.pending, null);
  }
});

test('first local command can wait for native MCP startup after control initialization', async () => {
  for (const resumed of [false, true]) {
    const h = controller({ resumed, executionMode: { kind: 'goal' } });
    const work = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'fixture context', goalCondition: 'continue',
      timeoutMs: 15, startupTimeoutMs: 1000 });
    await tick();
    const id = h.calls.inputs[0].metadata.uuid;
    h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'queued' });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(h.calls.stops, 0, 'control initialization is earlier than the first native command start');
    assert.equal(h.modes.beforePush('must wait'), false);
    h.complete(resumed ? 'Goal active: original objective (1 turn)' : '');
    const prepared = await work;
    assert.equal(prepared.ok, true);
    assert.equal(h.calls.inputs.length, 1);
    assert.equal(h.calls.stops, 0);
  }
});

test('first command startup remains bounded and unrelated lifecycle events cannot acknowledge it', async () => {
  const h = controller({ resumed: true });
  const work = h.modes.prepare({ kind: 'default' }, { timeoutMs: 5, startupTimeoutMs: 35 });
  const rejected = assert.rejects(work, { code: 'MODE_INPUT_START_TIMEOUT' });
  await tick();
  const id = h.calls.inputs[0].metadata.uuid;
  for (const state of ['started', 'completed']) h.modes.observe({ type: 'command_lifecycle', command_uuid: 'other-input', state });
  h.modes.observe(localResult('No goal set'));
  await rejected;
  h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
  assert.equal(h.modes.beforePush('late prompt'), false);
  assert.equal(h.calls.stops, 1);
});

test('once a local command starts its ACK deadline stays short despite duplicate lifecycle frames', async () => {
  const h = controller({ resumed: true });
  const work = h.modes.prepare({ kind: 'default' }, { timeoutMs: 25, startupTimeoutMs: 1000 });
  const rejected = assert.rejects(work, { code: 'MODE_PREPARE_TIMEOUT' });
  await tick();
  const id = h.calls.inputs[0].metadata.uuid;
  const onStarted = h.modes.pending.onStarted;
  let startSignals = 0;
  h.modes.pending.onStarted = () => { startSignals++; onStarted(); };
  h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
  await new Promise(resolve => setTimeout(resolve, 15));
  h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
  await rejected;
  assert.equal(startSignals, 1, 'duplicate starts never renew the ACK clock');
  assert.equal(h.calls.stops, 1);
});

test('a later local command does not regain the startup budget after the native engine started', async () => {
  const h = controller({ resumed: true, executionMode: { kind: 'goal' } });
  const work = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'fixture context', goalCondition: 'fixture objective',
    timeoutMs: 15, startupTimeoutMs: 1000 });
  const rejected = assert.rejects(work, { code: 'MODE_PREPARE_TIMEOUT' });
  await tick();
  h.complete('No goal set. Usage: `/goal <condition>`');
  await tick();
  assert.equal(h.calls.inputs.length, 2);
  await rejected;
  assert.equal(h.calls.stops, 1);
});

test('cold initialization has its own deadline and does not consume the local command deadline', async () => {
  let initialize;
  const h = controller({ ready: () => new Promise(resolve => { initialize = resolve; }) });
  const work = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'fixture context', timeoutMs: 15, startupTimeoutMs: 1000 });
  await tick();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(h.calls.stops, 0);
  assert.equal(h.calls.controls.length, 0, 'no command before initialization');
  initialize(); await tick();
  assert.equal(h.calls.inputs.length, 1);
  h.complete(''); await work;
  assert.equal(h.calls.stops, 0);
});

test('initialization timeout and cancellation close the Query and ignore late readiness', async () => {
  for (const cancel of [true, false]) {
    let initialize; const controllerSignal = new AbortController();
    const h = controller({ ready: () => new Promise(resolve => { initialize = resolve; }) });
    const work = h.modes.prepare({ kind: 'goal' }, { contextPrompt: 'must never send', signal: controllerSignal.signal,
      timeoutMs: 1000, startupTimeoutMs: cancel ? 1000 : 15 });
    await tick(); if (cancel) controllerSignal.abort();
    await assert.rejects(work, { code: cancel ? 'MODE_PREPARE_CANCELED' : 'MODE_INITIALIZATION_TIMEOUT' });
    initialize(); await tick();
    assert.equal(h.calls.stops, 1);
    assert.equal(h.calls.controls.length, 0);
    assert.equal(h.calls.inputs.length, 0);
    assert.equal(h.modes.beforePush('late user input'), false);
  }
});

test('ordinary goal follow-up preserves the native condition and sends attachments with the actual turn', async () => {
  const h = controller();
  h.modes.observe({ type: 'active_goal', value: { condition: 'original completion condition', iterations: 2 } });
  const files = [{ path: '/fixture/screenshot.png' }];
  const prepared = await h.modes.prepare({ kind: 'goal' }, { goalCondition: '继续', contextPrompt: '继续并检查截图', contextFiles: files });
  assert.equal(prepared.prompt, '继续并检查截图');
  assert.equal(prepared.goalCondition, 'original completion condition');
  assert.equal(prepared.files, files);
  assert.equal(h.calls.inputs.length, 0, 'no replacement /goal or separate context append');
});

test('explicit /goal replaces an existing condition, while API failure can re-arm its durable condition', async () => {
  const original = 'all fixture checks pass';
  const h = controller();
  h.modes.observe({ type: 'active_goal', value: { condition: original, iterations: 2 } });
  const failed = { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Request rejected (429)', num_turns: 1, duration_api_ms: 20 };
  assert.equal(h.modes.observe(failed), failed);
  h.modes.observe({ type: 'active_goal', value: null });
  const retry = h.modes.prepare({ kind: 'goal' }, { goalCondition: '继续', contextPrompt: '继续', previousGoal: original });
  await tick(); h.complete('');
  const restored = await retry;
  assert.equal(restored.prompt, '/goal ' + original);
  assert.equal(restored.goalCondition, original);
  assert.deepEqual(restored.files, []);
  h.modes.beforePush(restored.prompt, { uuid: 'restored-job' });
  const replacement = h.modes.prepare({ kind: 'goal' }, { goalCondition: 'new explicit goal', goalExplicit: true,
    contextPrompt: 'new explicit goal', previousGoal: original });
  await tick(); h.complete('');
  assert.equal((await replacement).prompt, '/goal new explicit goal');
});

test('resumed goal state is inspected and its actual condition wins over stale UI state', async () => {
  const h = controller({ resumed: true, executionMode: { kind: 'goal' } });
  const work = h.modes.prepare({ kind: 'goal' }, { goalCondition: 'continue', contextPrompt: 'continue with context' });
  await tick(); assert.equal(h.calls.inputs[0].text, '/goal');
  h.complete('Goal active: first line\nsecond line (3 turns)\nLast check: still incomplete');
  const ready = await work;
  assert.equal(ready.prompt, 'continue with context');
  assert.equal(ready.goalCondition, 'first line\nsecond line');
  assert.equal(h.calls.inputs.length, 1);
  await h.modes.prepare({ kind: 'goal' }, { goalCondition: 'follow up', contextPrompt: 'follow up' });
  assert.equal(h.calls.inputs.length, 1, 'known live status needs no repeated local probe');
});

test('resumed SDK-cleared goal restores durable condition and unknown status cannot authorize goal execution', async () => {
  const h = controller({ resumed: true, executionMode: { kind: 'goal' } });
  const work = h.modes.prepare({ kind: 'goal' }, { goalCondition: '继续', previousGoal: 'original goal', contextPrompt: 'retry context' });
  await tick(); h.complete('No goal set. Usage: `/goal <condition>`');
  await tick(); assert.equal(h.calls.inputs.length, 2);
  assert.equal(h.calls.inputs[1].metadata.shouldQuery, false);
  h.complete('');
  assert.equal((await work).prompt, '/goal original goal');
  const unknown = controller({ resumed: true, executionMode: { kind: 'goal' } });
  const rejected = unknown.modes.prepare({ kind: 'goal' }, { goalCondition: 'continue' });
  await tick(); unknown.complete('Unexpected goal status');
  await assert.rejects(rejected, { code: 'MODE_INPUT_FAILED' });
  assert.equal(unknown.calls.stops, 1);
  assert.equal(unknown.modes.beforePush('/goal unsafe late replacement'), false);
});

test('successful goal completion without active_goal notification cannot resurrect a finished objective', async () => {
  const h = controller({ executionMode: { kind: 'goal' } });
  h.modes.observe({ type: 'active_goal', value: { condition: 'finished fixture objective', iterations: 1 } });
  h.modes.observe({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, duration_api_ms: 10 });
  assert.equal(h.modes.goalStateKnown, false);
  // The host clears recovery on a successful turn. A native local probe still
  // decides whether that objective remains active or a new one should start.
  const next = h.modes.prepare({ kind: 'goal' }, { goalCondition: 'new fixture objective', contextPrompt: 'new fixture objective', previousGoal: null });
  await tick(); assert.equal(h.calls.inputs[0].text, '/goal');
  h.complete('No goal set. Usage: `/goal <condition>`');
  await tick(); h.complete('');
  assert.equal((await next).prompt, '/goal new fixture objective');
});

test('post-turn state refresh preserves a still-active native objective even without durable recovery', async () => {
  const h = controller({ executionMode: { kind: 'goal' } });
  h.modes.observe({ type: 'active_goal', value: { condition: 'unfinished fixture objective', iterations: 1 } });
  h.modes.observe({ type: 'result', subtype: 'success', is_error: false, result: 'partial fixture answer', num_turns: 1, duration_api_ms: 10 });
  const next = h.modes.prepare({ kind: 'goal' }, { goalCondition: 'continue', contextPrompt: 'continue with context', previousGoal: null });
  await tick(); h.complete('Goal active: unfinished fixture objective (1 turn)');
  const ready = await next;
  assert.equal(ready.prompt, 'continue with context');
  assert.equal(ready.goalCondition, 'unfinished fixture objective');
  assert.equal(h.calls.inputs.length, 1);
});

test('unsupported native command and hooks-policy rejection are exposed as errors, never normal goal completion', async () => {
  const unavailable = controller({ async control() { return []; } });
  await assert.rejects(unavailable.modes.prepare({ kind: 'goal' }), { code: 'GOAL_UNAVAILABLE' });
  assert.equal(unavailable.calls.inputs.length, 0);
  const h = controller(); await h.modes.prepare({ kind: 'goal' });
  h.modes.beforePush('/goal fixture', { uuid: 'job' });
  const orphan = localResult('old background completion');
  assert.equal(h.modes.observe(orphan), orphan, 'resume-era orphan result cannot become a new goal error');
  assert.equal(h.modes.goalInputId, 'job');
  h.modes.observe({ type: 'command_lifecycle', command_uuid: 'job', state: 'started' });
  const result = h.modes.observe(localResult("/goal can't run while hooks are restricted"));
  assert.equal(result.is_error, true); assert.match(result.result, /^目标未启动：/);
  assert.equal(h.modes.goalStateKnown, false, 'a rejected local goal command must be rechecked before an ordinary follow-up');
});

test('manual /goal status and clear commands remain valid local commands rather than failed goal attempts', () => {
  for (const text of ['/goal', '/goal clear', '/goal cancel']) {
    const h = controller(); assert.equal(h.modes.beforePush(text, { uuid: 'job' }), true);
    h.modes.observe({ type: 'command_lifecycle', command_uuid: 'job', state: 'started' });
    const result = localResult('No goal set');
    assert.equal(h.modes.observe(result), result);
  }
});

test('ordinary history can resume without goal capability, while a known goal cannot silently remain active', async () => {
  for (const kind of ['default', 'plan']) {
    const h = controller({ resumed: true, async control() { return []; } });
    assert.equal((await h.modes.prepare({ kind })).ok, true);
    assert.equal(h.calls.inputs.length, 0);
  }
  const known = controller({ resumed: true, async control() { return []; } });
  known.modes.observe({ type: 'active_goal', value: { condition: 'restored fixture', iterations: 2 } });
  await assert.rejects(known.modes.prepare({ kind: 'default' }), { code: 'GOAL_UNAVAILABLE' });
});

test('public permission updates serialize behind preparation and cannot undo plan guards', async () => {
  const h = controller({ resumed: true });
  const plan = h.modes.prepare({ kind: 'plan' }); await tick();
  const settings = h.modes.setPermissionMode('bypassPermissions'); await tick();
  assert.deepEqual(h.calls.controls, [['supportedCommands']]);
  h.complete('No goal set'); await plan; await settings;
  assert.deepEqual(h.calls.controls.slice(1), [['setPermissionMode', 'plan'], ['setPermissionMode', 'plan']]);
  assert.equal(h.modes.mode.kind, 'plan');
  await h.modes.prepare({ kind: 'default' });
  assert.equal(h.calls.controls.at(-1)[1], 'bypassPermissions');
});

test('rejected or closed permission control cannot commit a new base permission', async () => {
  const failed = controller({ permissionMode: 'acceptEdits', control: async () => { throw Error('denied by SDK'); } });
  await assert.rejects(failed.modes.setPermissionMode('bypassPermissions'), /denied by SDK/);
  assert.equal(failed.modes.permissionMode, 'acceptEdits'); assert.equal(failed.modes.appliedPermission, 'acceptEdits');
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const late = controller({ permissionMode: 'default', control: () => pending });
  const update = late.modes.setPermissionMode('bypassPermissions'); await tick();
  late.modes.close(); resolve(); await assert.rejects(update, { code: 'MODE_PREPARE_CANCELED' });
  assert.equal(late.modes.permissionMode, 'default'); assert.equal(late.modes.appliedPermission, 'default');
});

test('future local ACKs with UUIDs remain compatible, and SDK-origin permission changes are reapplied next turn', async () => {
  const h = controller({ resumed: true });
  const prep = h.modes.prepare({ kind: 'default' }); await tick();
  const id = h.calls.inputs[0].metadata.uuid;
  h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
  assert.equal(h.modes.observe({ ...localResult('No goal set'), user_message_uuid: id }), null);
  h.modes.observe({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
  await prep;
  h.modes.observe({ type: 'system', subtype: 'status', permissionMode: 'plan' });
  await h.modes.prepare({ kind: 'default' });
  assert.deepEqual(h.calls.controls.at(-1), ['setPermissionMode', 'default']);
});

function sdkHarness({ commands = [{ name: 'goal' }] } = {}) {
  const sdkPath = path.join(__dirname, '../src/main/sdk/claude-sdk.js');
  const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixture);');
  const calls = { inputs: [], permission: [], options: null, events: [] };
  const fixture = { query({ prompt, options }) {
    calls.options = options;
    return {
      async initializationResult() { return {}; },
      async supportedCommands() { return commands; },
      async setPermissionMode(mode) { calls.permission.push(mode); },
      async *[Symbol.asyncIterator]() {
        for await (const input of prompt) {
          calls.inputs.push(input);
          yield { type: 'command_lifecycle', command_uuid: input.uuid, state: 'started' };
          if (input.shouldQuery === false || input.message.content[0].text === '/goal clear') {
            yield { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'internal local output' }] } };
            yield localResult(input.shouldQuery === false ? '' : 'No goal set');
          } else yield { type: 'result', subtype: 'success', result: 'real fixture answer', user_message_uuid: input.uuid, num_turns: 1, duration_api_ms: 10 };
          yield { type: 'command_lifecycle', command_uuid: input.uuid, state: 'completed' };
        }
      },
    };
  } };
  const context = vm.createContext({ fixture, process, AbortController, setTimeout, clearTimeout, console: { warn() {}, error() {} } });
  const fn = new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`).runInContext(context);
  const mod = { exports: {} }; fn(createRequire(sdkPath), mod, mod.exports, path.dirname(sdkPath));
  return { sdk: mod.exports, calls };
}

test('real SDK adapter isolates native local ACK frames, preserves resume and supplement UUIDs, and restores explicit execution', async () => {
  const h = sdkHarness();
  const session = h.sdk.createLiveSession({ sessionId: 'fixture-session', permissionMode: 'bypassPermissions', canUseTool: async () => ({ behavior: 'allow' }), onMessage: e => h.calls.events.push(e), onExit() {} });
  await session.prepareExecutionMode({ kind: 'plan' });
  assert.equal(h.calls.options.resume, 'fixture-session');
  assert.equal(h.calls.events.length, 0, 'internal zero-turn result never reaches Relay job routing');
  await session.setPermissionMode('bypassPermissions');
  assert.equal(h.calls.permission.at(-1), 'plan');
  assert.equal((await h.calls.options.canUseTool('ExitPlanMode', {}, {})).behavior, 'deny');
  await session.prepareExecutionMode({ kind: 'goal' }, { contextPrompt: 'full context', permissionMode: 'default' });
  assert.equal(h.calls.permission.at(-1), 'default');
  session.push('/goal fixture condition', { uuid: 'goal-job' });
  session.push('additional requirement', { uuid: 'supplement-id', priority: 'next' });
  await tick();
  assert.deepEqual(h.calls.inputs.slice(-2).map(e => [e.uuid, e.priority]), [['goal-job', undefined], ['supplement-id', 'next']]);
  assert.deepEqual(h.calls.events.filter(e => e.type === 'result').map(e => e.user_message_uuid), ['goal-job', 'supplement-id']);
  await session.prepareExecutionMode({ kind: 'default' }, { permissionMode: 'acceptEdits' });
  assert.equal(h.calls.inputs.at(-1).message.content[0].text, '/goal clear');
  assert.equal((await h.calls.options.canUseTool('Write', {}, {})).behavior, 'allow');
  await session.kill();
});

test('SDK mode-preparation failure preserves its exact reason even when Query exit beats the dispatch catch', async () => {
  const h = sdkHarness({ commands: [] }); let exit;
  const session = h.sdk.createLiveSession({ onMessage() {}, onExit: (code, error) => { exit = { code, error }; } });
  await assert.rejects(session.prepareExecutionMode({ kind: 'goal' }), { code: 'GOAL_UNAVAILABLE' });
  await session.whenClosed();
  assert.equal(exit.code, -1);
  assert.match(exit.error, /不支持 \/goal/);
  assert.equal(h.calls.inputs.length, 0);
});

test('goal image attachments enter local context before the short goal command without leaking image data', async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'relay-goal-image-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.png');
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const h = sdkHarness();
  const session = h.sdk.createLiveSession({ runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' },
    onMessage: e => h.calls.events.push(e), onExit() {} });
  t.after(() => session.kill());
  await session.prepareExecutionMode({ kind: 'goal' }, { contextPrompt: '截图上下文', contextFiles: [{ path: file }] });
  const context = h.calls.inputs[0];
  assert.equal(context.shouldQuery, false);
  assert.equal(context.message.content.find(block => block.type === 'image').source.data, data);
  session.push('/goal 修复截图问题', { uuid: 'goal-image-job' });
  await tick();
  assert.equal(h.calls.inputs[1].message.content.length, 1);
  assert.equal(h.calls.inputs[1].message.content[0].text, '/goal 修复截图问题');
  assert.equal(JSON.stringify(h.calls.events).includes(data), false);
  await session.kill();
});
