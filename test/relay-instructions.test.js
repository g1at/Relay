'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { MAX_RELAY_INSTRUCTIONS, normalizeRelayInstructions, validateRelayInstructions, relayInstructionsPrompt } = require('../relay-instructions');
const { normalizePreferences, createGeneralPreferences } = require('../general-preferences');
const { buildRuntimePolicy } = require('../sdk-runtime-policy');
const { contractFingerprints, requiresFreshContract } = require('../sdk-runtime-contract');
const { buildNativeAgent } = require('../native-agent-definition');
const { _buildOptions } = require('../claude-sdk');

test('guidance defaults empty and saves exact multiline text without truncation or external capability probes', async () => {
  const text = '  请用中文。\r\n优先解释结论。\n  ';
  assert.equal(normalizeRelayInstructions(undefined), '');
  assert.equal(normalizePreferences().relayInstructions, '');
  assert.equal(normalizePreferences({ relayInstructions: text }).relayInstructions, text);
  const preferences = createGeneralPreferences({ probeWsl: () => { throw Error('must not probe'); } });
  assert.deepEqual(await preferences.validatePatch({ relayInstructions: text }), { relayInstructions: text });
  assert.equal(validateRelayInstructions('x'.repeat(MAX_RELAY_INSTRUCTIONS)).length, MAX_RELAY_INSTRUCTIONS);
  for (const value of [null, {}, 1, ['hello'], 'x\0y']) await assert.rejects(preferences.validatePatch({ relayInstructions: value }), { code: 'INVALID_RELAY_INSTRUCTIONS' });
  await assert.rejects(preferences.validatePatch({ relayInstructions: 'x'.repeat(MAX_RELAY_INSTRUCTIONS + 1) }), { code: 'RELAY_INSTRUCTIONS_TOO_LONG' });
  assert.equal(relayInstructionsPrompt(' \n'), '');
  assert.match(relayInstructionsPrompt(text), /以当前明确要求为准/);
  assert.ok(relayInstructionsPrompt(text).includes(text));
});

test('guidance changes invalidate runtime contracts while empty defaults and UI-only toggles preserve them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-guidance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = settings => contractFingerprints(buildRuntimePolicy({ settings }), null, { cwd: root, configDir: root, homeDir: root, settingSources: ['user'] });
  const empty = contract({}), initial = contract({ relayInstructions: 'Use concise prose.' });
  assert.equal(empty.fingerprint, contract({ relayInstructions: '' }).fingerprint);
  assert.equal(empty.fingerprint, contract({ relayInstructions: ' \n', showContextUsage: false }).fingerprint);
  const saved = { sessionId: 'fixture-session', sdkRuntimeFingerprint: initial.fingerprint, updatedAt: 'unchanged', turns: [{ user: 'old task', assistant: 'old result' }] };
  const before = JSON.stringify(saved);
  assert.equal(requiresFreshContract(saved, contract({ relayInstructions: 'Use concise prose.' }).fingerprint), false);
  assert.equal(requiresFreshContract(saved, contract({ relayInstructions: 'Give detailed explanations.' }).fingerprint), true);
  assert.equal(requiresFreshContract(saved, empty.fingerprint), true);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(fs.readdirSync(root).length, 0, 'deriving guidance never writes native settings or instructions');
});

test('shared SDK options include guidance for ordinary, plan, goal and selected Agent workloads without granting tools', async () => {
  const settings = { relayInstructions: 'Prefer concise Chinese responses.' };
  const runtimePolicy = buildRuntimePolicy({ settings });
  const agent = buildNativeAgent({ text: '---\nname: reviewer\n---\nReview carefully.' });
  const originalAgent = JSON.stringify(agent);
  for (const executionMode of [{ kind: 'default' }, { kind: 'plan' }, { kind: 'goal' }]) {
    const options = _buildOptions({ cwd: os.tmpdir(), model: 'synthetic', executionMode, runtimePolicy,
      nativeAgent: agent, canUseTool: async () => ({ behavior: 'deny', message: 'fixture policy' }) });
    assert.ok(options.systemPrompt.append.includes(settings.relayInstructions));
    assert.ok(options.agents.reviewer.prompt.includes(settings.relayInstructions));
    assert.ok(options.agents.reviewer.prompt.includes('Review carefully.'));
    assert.equal((await options.canUseTool('Bash', { command: 'anything' })).behavior, 'deny');
    assert.equal(Object.hasOwn(options.settings, 'relayInstructions'), false);
    const delegation = { tool_name: 'Agent', tool_input: { prompt: 'Check the result.', subagent_type: 'reviewer' } };
    const outputs = await Promise.all(options.hooks.PreToolUse.flatMap(entry => entry.hooks).map(hook => hook(delegation, 'fixture', {})));
    const context = outputs.find(value => value.hookSpecificOutput?.updatedInput?.prompt?.includes(settings.relayInstructions));
    assert.ok(context); assert.equal(context.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(context.hookSpecificOutput.updatedInput.subagent_type, 'reviewer');
    assert.equal(delegation.tool_input.prompt, 'Check the result.');
  }
  assert.equal(JSON.stringify(agent), originalAgent);
  const custom = _buildOptions({ runtimePolicy, customSystemPrompt: { static: ['Custom role'], dynamic: ['Custom detail'] } }, { SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'BOUNDARY' });
  assert.ok(custom.systemPrompt.prompt.join('\n').includes(settings.relayInstructions));
});

function sdkHarness() {
  const sdkPath = path.join(__dirname, '../claude-sdk.js'), calls = [];
  const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  const fixtureSdk = { query({ options, prompt }) {
    calls.push({ options, prompt });
    return { close() {}, async initializationResult() { return {}; }, async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'fixture answer' };
    } };
  } };
  const context = vm.createContext({ fixtureSdk, process, AbortController, setTimeout, clearTimeout, console: { warn() {}, error() {} } });
  const factory = new vm.Script(`(function(require,module,exports,__dirname){\n${source}\n})`, { filename: sdkPath }).runInContext(context);
  const loaded = { exports: {} }; factory(createRequire(sdkPath), loaded, loaded.exports, path.dirname(sdkPath));
  return { sdk: loaded.exports, calls };
}

test('live and scheduled SDK launches carry current guidance; internal title generation stays neutral', async () => {
  const h = sdkHarness();
  const params = { cwd: os.tmpdir(), model: 'synthetic', runtimePolicy: buildRuntimePolicy({ settings: { relayInstructions: 'Old preference.' } }) };
  const live = h.sdk.createLiveSession({ ...params, onMessage() {}, onExit() {} });
  await live.whenClosed();
  assert.ok(h.calls[0].options.systemPrompt.append.includes('Old preference.'));
  params.runtimePolicy = buildRuntimePolicy({ settings: { relayInstructions: 'New preference.' } });
  await new Promise(resolve => h.sdk.runOneShot({ ...params, prompt: 'Scheduled user task', onEvent: event => { if (event.type === 'job-done') resolve(); } }));
  assert.ok(h.calls[1].options.systemPrompt.append.includes('New preference.'));
  assert.ok(!h.calls[1].options.systemPrompt.append.includes('Old preference.'));
  assert.equal(await h.sdk.runText({ ...params, prompt: 'Generate a title', timeoutMs: 1000 }), 'fixture answer');
  assert.equal(h.calls[2].options.systemPrompt, undefined);
});

test('the scheduled main-process resume boundary keeps history but retires a session after guidance edits or removal', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('function runClaudeJob({'), end = main.indexOf('  const nativeFork =', start);
  assert.ok(start > 0 && end > start);
  let settings = { relayInstructions: 'Original preference' }, builds = 0;
  const fingerprint = () => buildRuntimePolicy({ settings }).fingerprint;
  const record = { sessionId: 'saved-session', sdkRuntimeFingerprint: fingerprint(), turns: [{ user: 'Earlier request', assistant: 'Earlier answer' }] };
  const context = vm.createContext({ TaskClock: class {}, crypto: { randomUUID: () => 'fixture-run' },
    loadConversation: () => record, activeRelayProviderRuntime: () => ({ modelId: 'synthetic', tier: 'haiku' }),
    conversationRuntimeContract: () => { builds++; return { fingerprint: fingerprint() }; },
    providerSessionRoute: () => ({}), sessionRouteMatchesProvider: () => true, requiresFreshContract,
    conversationContext: () => '以下是我们之前的对话记录，供你参考延续：\nEarlier request\nEarlier answer' });
  vm.runInContext(main.slice(start, end) + 'return { prompt, safeSessionId, resumeAccepted, runtimeContract };\n}', context);
  const run = prompt => context.runClaudeJob({ conversationId: 'fixture-conversation', sessionId: 'saved-session', prompt, cwd: '/fixture' });
  assert.equal(run('New request').safeSessionId, 'saved-session');
  settings = { relayInstructions: 'Revised preference' };
  const updated = run('New request');
  assert.equal(updated.resumeAccepted, false); assert.equal(updated.safeSessionId, null);
  assert.match(updated.prompt, /Earlier request\nEarlier answer\n\nNew request/);
  assert.equal(run(updated.prompt).prompt, updated.prompt, 'history is not duplicated when a caller already restored it');
  settings = { relayInstructions: '' };
  assert.equal(run('New request').safeSessionId, null);
  assert.equal(builds, 4, 'read current guidance on every one-shot launch');
  assert.equal(record.sessionId, 'saved-session', 'launch does not rewrite the stored conversation prematurely');
});
