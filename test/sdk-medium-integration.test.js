'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const prefs = require('../sdk-runtime-preferences'), { buildRuntimePolicy, summarizeResolvedSettings } = require('../sdk-runtime-policy');
const { createPluginStore } = require('../sdk-plugin-store');
const { createUserDialogHandler } = require('../sdk-user-dialog'), { createToolProposalHook } = require('../sdk-tool-proposals');
const { NativeEventState, sanitizeNativeEvent, safeFindings, stageSkillProposals } = require('../sdk-native-events');
const { createHistoryManagement, mergeNativeHistory } = require('../sdk-history-management');
const { withDrainedExit } = require('../sdk-process-adapter'), { createDiagnosticLog } = require('../sdk-diagnostics-log');
const { configureSdkErrorCategories, errorCategory, annotateError } = require('../sdk-error-categories');
const { buildNativeAgent } = require('../native-agent-definition'), { resourceEntries } = require('../sdk-task-resources');
const { createConversationPermissions } = require('../conversation-permissions');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-medium-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('advanced defaults preserve SDK defaults and strict validation rejects unsafe overrides', () => {
  const defaults = prefs.sdkPreferenceOptions({}); assert.deepEqual(defaults.options, {}); assert.deepEqual(defaults.settings, {});
  for (const value of [{ permissions: { defaultMode: 'bypassPermissions' } }, { thinking: 'fake' }, { skillOverrides: { test: 'fake' } }, { customSystemPrompt: { static: [] } }]) assert.throws(() => prefs.normalizeSdkPreferences(value, { strict: true }), { code: 'INVALID_SDK_PREFERENCE' });
  assert.deepEqual(prefs.sdkPreferenceOptions({ skills: [] }).options.skills, []);
  assert.equal(prefs.sdkPreferenceOptions({ skills: null }).options.skills, undefined);
  assert.deepEqual(prefs.sdkPreferenceOptions({ thinking: 'enabled', thinkingBudget: 8192, thinkingDisplay: 'omitted', maxTurns: 9 }).options, { thinking: { type: 'enabled', budgetTokens: 8192, display: 'omitted' } });
});
test('context and thinking summary tri-states retain SDK inheritance without changing model reasoning', () => {
  const values = ['inherit', 'enabled', 'disabled'];
  for (const autoCompact of values) for (const showThinkingSummaries of values) {
    const saved = { autoCompact, showThinkingSummaries }, snapshot = structuredClone(saved);
    const normalized = prefs.normalizeSdkPreferences(saved, { strict: true });
    assert.equal(normalized.autoCompact, autoCompact); assert.equal(normalized.showThinkingSummaries, showThinkingSummaries);
    const actual = prefs.sdkPreferenceOptions(saved), expected = {};
    if (autoCompact !== 'inherit') expected.autoCompactEnabled = autoCompact === 'enabled';
    if (showThinkingSummaries !== 'inherit') expected.showThinkingSummaries = showThinkingSummaries === 'enabled';
    assert.deepEqual(actual.settings, expected); assert.deepEqual(actual.options, {});
    assert.deepEqual(saved, snapshot);
    const legacy = prefs.sdkPreferenceOptions({ ...saved, thinking: 'enabled', thinkingBudget: 8192, thinkingDisplay: 'omitted' });
    assert.deepEqual(legacy.options.thinking, { type: 'enabled', budgetTokens: 8192, display: 'omitted' });
    assert.deepEqual(legacy.settings, expected);
  }
});
test('retired settings from older Relay versions stop affecting sessions without destroying unrelated preferences', () => {
  const legacy = { maxTurns: 4, diagnostics: true, claudeMdExcludes: ['private/**'], worktree: { baseRef: 'head', sparsePaths: ['src'] }, allowedTools: ['Read'], disallowedTools: ['Write'], autoCompact: 'enabled', skills: ['review'], customSystemPrompt: { static: ['keep'], dynamic: [] } };
  const before = structuredClone(legacy);
  for (const strict of [false, true]) {
    const normalized = prefs.normalizeSdkPreferences(legacy, { strict });
    assert.equal(normalized.maxTurns, null); assert.equal(normalized.diagnostics, false); assert.deepEqual(normalized.claudeMdExcludes, []); assert.deepEqual(normalized.worktree, {});
    assert.deepEqual(normalized.allowedTools, ['Read']); assert.deepEqual(normalized.disallowedTools, ['Write']); assert.equal(normalized.autoCompact, 'enabled'); assert.deepEqual(normalized.customSystemPrompt, legacy.customSystemPrompt);
    assert.deepEqual(prefs.normalizeSdkPreferences(normalized, { strict }), normalized);
  }
  const runtime = prefs.sdkPreferenceOptions(legacy);
  assert.equal(Object.hasOwn(runtime.options, 'maxTurns'), false); assert.equal(Object.hasOwn(runtime.settings, 'worktree'), false); assert.equal(Object.hasOwn(runtime.settings, 'claudeMdExcludes'), false);
  assert.deepEqual(legacy, before);
  assert.doesNotThrow(() => prefs.normalizeSdkPreferences({ maxTurns: 0, diagnostics: 'old', worktree: { sparsePaths: ['../outside'] }, claudeMdExcludes: 'old' }, { strict: true }));
});
test('trusted project MCP rules do not leak to other projects and native policy wins', () => {
  const settings = { sdkSettingSources: 'project', sdkTrustedProjectIds: ['one'], sdkRuntimePreferences: { projectMcpApprovals: { one: { all: false, enabled: ['ok', 'no'], disabled: ['no'] } }, skillBudget: 'compact', outputBudget: 'balanced', disableSkillShellExecution: true } };
  const a = buildRuntimePolicy({ settings, projectId: 'one', projectRoot: '/fixture', cwd: '/fixture' });
  assert.deepEqual(a.settings.enabledMcpjsonServers, ['ok']); assert.deepEqual(a.settings.disabledMcpjsonServers, ['no']);
  assert.equal(a.settings.bashOutputMaxChars, 48000); assert.equal(a.settings.skillListingMaxDescChars, 384); assert.equal(a.settings.plansDirectory, path.join('/fixture', '.relay', 'plans'));
  const b = buildRuntimePolicy({ settings, projectId: 'two', projectRoot: '/other', cwd: '/other' }); assert.equal(b.settings.enableAllProjectMcpServers, undefined); assert.notEqual(a.fingerprint, b.fingerprint);
  const policy = summarizeResolvedSettings({}, { strictPluginOnlyCustomization: ['skills', 'mcp'], deniedMcpServers: [{ serverName: 'private' }], allowedMcpServers: [{ serverCommand: ['test'] }], requiredMinimumVersion: '2.1.266' });
  assert.deepEqual(policy.restrictions.pluginOnlyKinds, ['skills', 'mcp']); assert.equal(policy.restrictions.mcpCommandRules, 1); assert.equal(policy.restrictions.minVersion, '2.1.266');
});
test('live flag settings cannot overwrite permissions, routing or nested configuration', () => {
  for (const value of [{ permissions: {} }, { env: {} }, { model: 'other-provider' }, { pluginConfigs: {} }, { effortLevel: 'fake' }, { autoCompactEnabled: 'false' }]) assert.throws(() => prefs.validateFlagSettings(value));
  assert.deepEqual(prefs.validateFlagSettings({ effortLevel: 'high', autoCompactEnabled: false }), { effortLevel: 'high', autoCompactEnabled: false });
  assert.deepEqual(prefs.customPrompt(['static'], ['dynamic'], { SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'BOUNDARY' }), { type: 'custom', prompt: ['static', 'BOUNDARY', 'dynamic'], snapshot: true });
  assert.throws(() => prefs.customPrompt(['static'], ['dynamic'], {}));
});
test('Agent models and MCP names remain within the captured provider and registry', () => {
  const text = '---\nname: reviewer\nmodel: haiku\neffort: low\nbackground: true\nmcpServers: [local]\nskills: [review]\nmaxTurns: 6\ndisallowedTools: [Write]\n---\nReview.';
  const options = { text, selectedModel: 'configured-main', modelMap: { haiku: 'configured-fast' }, allowedModels: ['configured-main', 'configured-fast'], mcpServerNames: ['local'], inheritedDisallowedTools: ['AskUserQuestion'] };
  const agent = buildNativeAgent(options).agents.reviewer;
  assert.equal(agent.model, 'configured-fast'); assert.equal(agent.background, true); assert.equal(agent.effort, 'low'); assert.deepEqual(agent.mcpServers, ['local']);
  assert.deepEqual(agent.disallowedTools, ['Write', 'AskUserQuestion']); assert.equal(agent.maxTurns, 6);
  assert.throws(() => buildNativeAgent({ ...options, text: text.replace('model: haiku', 'model: unauthorized') }));
  assert.throws(() => buildNativeAgent({ ...options, mcpServerNames: [] }));
});
test('refusal dialog registers only a known kind, preserves session ownership and prohibits cross-provider fallback', async () => {
  const scope = { conversationId: 'conv', runId: 'run', windowId: 1, allowedModels: ['fast'] }, calls = [], resolved = [];
  let answer = '使用备用模型重试'; const broker = { registerToolUse: async input => { calls.push(input); return { behavior: 'allow', updatedInput: { answers: { [input.input.questions[0].question]: answer } } }; } };
  const handler = createUserDialogHandler({ broker, context: () => scope, onResolved: x => resolved.push(x) });
  const request = { dialogKind: 'refusal_fallback_prompt', payload: { originalModel: 'main', fallbackModel: 'fast', retractedMessageUuids: [randomUUID()] } };
  assert.equal((await handler(request, { requestId: 'native', signal: new AbortController().signal })).result, 'retry_fallback');
  assert.equal(calls[0].context.runId, 'run'); assert.match(calls[0].sdkOptions.requestId, /native/); assert.equal(resolved.length, 1);
  request.payload.fallbackModel = 'other-provider'; assert.equal((await handler(request)).result, 'cancelled'); assert.equal(calls.at(-1).input.questions[0].options.length, 2);
  await assert.rejects(handler({ dialogKind: 'unknown' }), /Unsupported/);
  const ac = new AbortController(); ac.abort(); assert.equal((await handler(request, { signal: ac.signal })).behavior, 'cancelled'); assert.equal(calls.length, 2);
});
test('goal/worktree proposals always require human confirmation and reject plan/background calls', async () => {
  const scope = { conversationId: 'conv', runId: 'run', windowId: 1, executionMode: { kind: 'default' } }; let count = 0;
  const broker = { registerToolUse: async input => { count++; return { behavior: 'allow', updatedInput: { answers: { [input.input.questions[0].question]: input.input.questions[0].options[0].label } } }; } };
  const hook = createToolProposalHook({ broker, context: () => scope });
  const goal = { tool_name: 'ProposeGoal', tool_input: { condition: 'finish', ask_user: false } };
  const result = await hook(goal, 'tool', { signal: new AbortController().signal }); assert.equal(result.hookSpecificOutput.permissionDecision, 'allow'); assert.equal(result.hookSpecificOutput.updatedInput.ask_user, false); assert.equal(count, 1);
  scope.executionMode.kind = 'plan'; assert.equal((await hook(goal, 'tool')).hookSpecificOutput.permissionDecision, 'deny'); assert.equal(count, 1);
  scope.executionMode.kind = 'default'; scope.background = true; assert.equal((await hook({ tool_name: 'ExitWorktree', tool_input: { action: 'remove', discard_changes: true } }, 'tool')).hookSpecificOutput.permissionDecision, 'deny');
});
test('native diagnostics are bounded and never expose raw hook text; findings reject out-of-workspace paths', () => {
  const safe = sanitizeNativeEvent({ type: 'system', subtype: 'hook_response', stdout: 'secret', stderr: 'credential', output: 'prompt' });
  assert.equal(safe.stdout, ''); assert.ok(safe.relay_output_bytes > 0); assert.equal(JSON.stringify(safe).includes('secret'), false);
  const state = new NativeEventState(4); for (let i = 0; i < 10; i++) state.observe({ type: 'system', subtype: 'hook_response', hook_id: String(i), ...safe }); assert.equal(state.snapshot().records.length, 4);
  state.observe({type:'system',subtype:'thinking_tokens',estimated_tokens:3,estimated_tokens_delta:1});assert.equal(state.snapshot().records.find(x=>x.kind==='thinking_tokens').estimatedTokens,3);
  state.hook({ hook_event_name: 'ConfigChange' }); assert.equal(state.revision, 1);
  assert.deepEqual(safeFindings({ findings: [{ file: '../outside', summary: 'no' }, { file: '/abs', summary: 'no' }, { file: 'src/app.js', line: 9, summary: 'yes', verdict: 'CONFIRMED' }] }).map(x => x.file), ['src/app.js']);
});
test('SDK skill proposals enter review without touching the live skill and reject linked files before any write', t => {
  const root = tmp(t), skillsDir = path.join(root, 'skills'), stagingRoot = path.join(root, 'staging'); fs.mkdirSync(skillsDir); fs.mkdirSync(stagingRoot);
  const existing = path.join(skillsDir, 'review'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'SKILL.md'), 'old'); fs.writeFileSync(path.join(existing, 'helper.txt'), 'resource');
  let captured; const service = { createDraft: value => { captured = { ...value, body: fs.readFileSync(path.join(value.stagingDir, 'SKILL.md'), 'utf8'), resource: fs.readFileSync(path.join(value.stagingDir, 'helper.txt'), 'utf8') }; return { id: 'draft' }; } };
  stageSkillProposals({ proposals: [{ name: 'review', target: 'review', kind: 'improvement', description: 'desc', skillMd: 'new body' }] }, { skillsDir, stagingRoot, service });
  assert.match(captured.body, /new body/); assert.equal(captured.resource, 'resource'); assert.equal(fs.readFileSync(path.join(existing, 'SKILL.md'), 'utf8'), 'old'); assert.deepEqual(fs.readdirSync(stagingRoot), []);
  if (process.platform !== 'win32') { const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'untouched'); fs.unlinkSync(path.join(existing, 'SKILL.md')); fs.symlinkSync(outside, path.join(existing, 'SKILL.md'));
    assert.throws(() => stageSkillProposals({ proposals: [{ name: 'review', target: 'review', kind: 'improvement', description: 'desc', skillMd: 'bad' }] }, { skillsDir, stagingRoot, service })); assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched'); }
});
test('plugin source is disabled on import, options are typed, sensitive config is never persisted', t => {
  const root = tmp(t), plugin = path.join(root, 'plugin'), file = path.join(root, 'store.json'); fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', userConfig: { number: { type: 'number', title: 'Number', description: '', min: 1, max: 9, default: 3 }, enabled: { type: 'boolean', title: 'Enabled', description: '' }, token: { type: 'string', title: 'Token', description: '', sensitive: true } } }));
  const store = createPluginStore({ file }), item = store.add(plugin); assert.equal(item.enabled, false); assert.equal(store.runtime().plugins.length, 0);
  assert.throws(() => store.update(item.id, { options: { token: 'SECRET' } })); assert.throws(() => store.update(item.id, { options: { number: 10 } }));
  store.update(item.id, { enabled: true, options: { number: 5, enabled: false } }); assert.equal(store.runtime().plugins[0].path, fs.realpathSync(plugin));
  assert.deepEqual(store.runtime().settings.pluginConfigs['fixture@inline'].options, { number: 5, enabled: false }); assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false);
  store.remove(item.id); assert.equal(fs.existsSync(path.join(plugin, '.claude-plugin/plugin.json')), true);
});
const nativeMessages = () => { const user = randomUUID(); return [{ type: 'user', uuid: user, message: { content: 'question' } }, { type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: 'answer' }] } }]; };
test('native repair deduplicates Relay run UUIDs and preserves errors/title/order/attachments', () => {
  const messages = nativeMessages(), record = { id: 'local', title: 'edited', updatedAt: 'old', pinned: true, turns: [{ runId: messages[0].uuid, user: 'question', assistant: '', error: '429 persisted', files: [{ name: 'attachment' }] }] };
  const result = mergeNativeHistory(record, messages); assert.equal(result.added, 0); assert.equal(result.record.turns.length, 1); assert.equal(result.record.turns[0].assistant, ''); assert.equal(result.record.turns[0].error, '429 persisted'); assert.equal(result.record.updatedAt, 'old'); assert.equal(result.record.title, 'edited'); assert.equal(result.record.pinned, true); assert.deepEqual(result.record.turns[0].files, record.turns[0].files);
  assert.equal(mergeNativeHistory(result.record, messages).added, 0);
});
test('native title writes serialize and repair aborts if local history changes while reading', async () => {
  const scope = { sessionId: randomUUID(), cwd: '/fixture', configDir: '/config', agentEnvironment: 'native' }, messages = nativeMessages();
  let record = { id: 'local', title: 'edited', sdkSessionContext: scope, turns: [] }, mutate = true; const titles = [];
  const service = createHistoryManagement({ load: async () => structuredClone(record), list: async () => [{ id: 'local' }], save: async next => { record = next; }, isBusy: () => false,
    execute: async (_scope, op, input) => { if (op === 'getSessionMessages') { if (mutate) record.title = 'new edit'; return messages; } if (op === 'renameSession') { await new Promise(resolve => setTimeout(resolve, input.title === 'first' ? 20 : 0)); titles.push(input.title); } } });
  await assert.rejects(service.repair('local'), { code: 'SESSION_HISTORY_STALE' }); assert.equal(record.turns.length, 0); mutate = false;
  assert.equal((await service.repair('local')).added, 1); assert.equal(record.title, 'new edit');
  await Promise.all([service.rename('local', 'first'), service.rename('local', 'second')]); assert.deepEqual(titles, ['first', 'second']);
});
test('native delete refuses shared records and never removes Relay history', async () => {
  const scope = { sessionId: randomUUID(), cwd: '/fixture', configDir: '/config', agentEnvironment: 'native' }; let shared = true, deleted = 0;
  const service = createHistoryManagement({ load: async id => ({ id, sdkSessionContext: scope, turns: [] }), list: async () => shared ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'one' }], save: () => assert.fail('delete must not save local records'), isBusy: () => false, execute: async (_scope, op) => { if (op === 'deleteSession') deleted++; } });
  await assert.rejects(service.deleteNative('one'), { code: 'SESSION_SHARED' }); assert.equal(deleted, 0); shared = false;
  assert.equal((await service.deleteNative('one')).localHistoryRetained, true); assert.equal(deleted, 1);
});
test('spawn facade waits for stderr close, supports removal and preserves host process identity', async () => {
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.pid = 123; child.kill = () => true;
  const facade = withDrainedExit(child, { graceMs: 100 }), calls = []; const listener = () => assert.fail('removed'); facade.on('exit', listener); facade.off('exit', listener);
  facade.once('exit', code => calls.push(code)); child.emit('exit', 7, null); assert.deepEqual(calls, []); child.stderr.destroy(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [7]); assert.equal(facade.pid, 123); assert.equal(facade.stdin, child.stdin);
});
test('diagnostic logs are bounded, aggregate-only and removed after close', t => {
  const root = tmp(t), log = createDiagnosticLog({ root, interval: 100000 }); fs.writeFileSync(log.file, 'network SECRET_PROMPT\nhook SECRET_CREDENTIAL\n'); log.flush();
  assert.deepEqual(log.summary().counts, { connection: 1, configuration: 1, tool: 0, other: 0 }); assert.equal(JSON.stringify(log.summary()).includes('SECRET'), false);
  fs.appendFileSync(log.file, 'x'.repeat(1100000)); log.flush(); assert.ok(fs.statSync(log.file).size < 1024 * 1024); log.close(); assert.equal(fs.existsSync(log.file), false);
});
test('SDK error prefixes augment third-party detection without confusing 429 with permanent policy/credit failures', () => {
  configureSdkErrorCategories({ ORG_POLICY_LIMIT_PREFIXES: ['ORG_LOCK'], USAGE_LIMIT_ERROR_PREFIXES: ['USAGE_LOCK'] });
  assert.equal(errorCategory('ORG_LOCK custom'), 'organization_policy'); assert.equal(errorCategory('USAGE_LOCK custom'), 'usage_exhausted'); assert.equal(errorCategory('429 retry'), 'rate_limit'); assert.equal(errorCategory('insufficient_quota'), 'usage_exhausted');
  assert.equal(annotateError({ type: 'result', errors: ['Resume rejected by --resume-drops-turn: changed'] }).relay_error_category, 'resume_guard_rejected'); assert.doesNotThrow(() => annotateError({ type: 'assistant', isApiErrorMessage: true, message: { content: 'text' }, errors: 'text' }));
});
test('full output artifacts use the exact task owner and ambiguous multi-tool results do not forge resources', () => {
  const e = { type: 'user', tool_use_result: { persistedOutputPath: '/fixture/log.txt' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-one' }] } };
  const links = resourceEntries(e, { jobId: 'run-one', cwd: '/fixture', agentEnvironment: 'wsl', wslDistribution: 'Fixture' }); assert.equal(links[0].taskId, 'tool-one'); assert.equal(links[0].jobId, 'run-one'); assert.equal(links[0].wslDistribution, 'Fixture');
  e.message.content.push({ type: 'tool_result', tool_use_id: 'tool-two' }); assert.deepEqual(resourceEntries(e, { jobId: 'run-one' }), []);
});
test('accepted native goals update only current host-owned execution metadata and do not change activity time', () => {
  let settings = {}, record = { id: 'one', sessionId: 'native', permissionMode: 'default', executionMode: { kind: 'default' }, updatedAt: 'unchanged' }; const updates = [];
  const service = createConversationPermissions({ readSettings: () => settings, writeSettings: x => { settings = x; }, loadConversation: () => record, persistConversation: x => { record = x; }, onChanged: x => updates.push(x) });
  assert.equal(service.adoptGoal('one', { condition: 'goal', sessionId: 'stale' }), null);
  assert.equal(service.adoptGoal('one', { condition: 'goal', sessionId: 'native' }).executionMode.kind, 'goal'); assert.equal(record.goalRecovery.condition, 'goal'); assert.equal(record.updatedAt, 'unchanged'); assert.equal(updates.length, 1);
});

test('imported native history never invents tool success or leaves a live spinner', () => {
  const { nativeTurns } = require('../sdk-history-management');
  const turns = nativeTurns([{type:'user',uuid:randomUUID(),message:{content:'test'}},
    {type:'assistant',uuid:randomUUID(),message:{content:[{type:'tool_use',id:'missing-result',name:'Read',input:{file_path:'fixture'}}]}}]);
  assert.equal(turns[0].activity.phase,'paused');
  assert.ok(turns[0].activity.items.every(row=>!['running','preparing','success'].includes(row.status)));
  assert.equal(turns[0].activity.startedAt,null);
});
test('error descriptions preserve the original SDK failure and context diagnostics allowlist fields', () => {
  const { forTurn } = require('../renderer/conversation-errors');
  const event=annotateError({type:'result',is_error:true,errors:['ORG_LOCK exact original']});
  const display=forTurn({output:{lastResult:event}});assert.match(display,/组织策略/);assert.match(display,/ORG_LOCK exact original/);
  const state=new NativeEventState();state.observe({type:'assistant',context_usage:{total_tokens:5,raw_max_tokens:100,percentage:5,secret:'MUST_NOT_LEAK',categories:[{name:'Messages',tokens:5,kind:'used',raw:'SECRET'}]}});
  assert.equal(state.snapshot().context.total_tokens,5);assert.equal(JSON.stringify(state.snapshot()).includes('SECRET'),false);assert.equal(JSON.stringify(state.snapshot()).includes('MUST_NOT_LEAK'),false);
});
test('real subprocess stderr tail is delivered before the SDK exit listener', async () => {
  const { spawn } = require('node:child_process');
  const child=spawn(process.execPath,['-e',"require('fs').writeSync(2,'LAST_STDERR_MARKER');process.exit(7)"],{stdio:['pipe','pipe','pipe']});
  const sdkChild=withDrainedExit(child),chunks=[];sdkChild.stderr.on('data',chunk=>chunks.push(chunk.toString()));
  await new Promise((resolve,reject)=>{sdkChild.once('exit',code=>{try{assert.equal(code,7);assert.match(chunks.join(''),/LAST_STDERR_MARKER/);resolve();}catch(error){reject(error);}});child.once('error',reject);});
});

test('worktree success output updates cwd when this SDK omits CwdChanged, never from child agents', () => {
  const {nativeWorkingDirectory}=require('../sdk-native-events');
  const enter={hook_event_name:'PostToolUse',tool_name:'EnterWorktree',tool_response:{worktreePath:'/fixture/worktree'}};
  assert.equal(nativeWorkingDirectory(enter),'/fixture/worktree');assert.equal(nativeWorkingDirectory({...enter,agent_id:'child'}),null);
  assert.equal(nativeWorkingDirectory({...enter,tool_response:{worktreePath:'relative'}}),null);
  assert.equal(nativeWorkingDirectory({hook_event_name:'PostToolUse',tool_name:'ExitWorktree',tool_response:{originalCwd:'/fixture'}}),'/fixture');
});

test('native Agent effort validates known capabilities and preserves SDK handling for unknown providers', () => {
  const base={text:'---\nname: test\neffort: max\n---\nTask',selectedModel:'fixture'};
  assert.throws(()=>buildNativeAgent({...base,modelCapabilities:[{value:'fixture',supportsEffort:true,supportedEffortLevels:['low','high']}]}),{code:'AGENT_EFFORT_UNSUPPORTED'});
  assert.equal(buildNativeAgent(base).agents.test.effort,'max');
  assert.equal(buildNativeAgent({...base,text:'---\nname: test\n---\nTask',effort:'high',modelCapabilities:[{value:'fixture',supportsEffort:false}]}).agents.test.effort,undefined);
});

test('thinking progress reuses a single row and remains an estimate separate from billed usage', () => {
  const activity=require('../renderer/activity-stream'), state=activity.createState();
  for(let i=1;i<=100;i++)activity.ingest(state,{type:'system',subtype:'thinking_tokens',estimated_tokens:i,estimated_tokens_delta:1});
  assert.equal(state.items.length,1);assert.match(state.items[0].detail,/约 100/);assert.equal(state.result,null);
  activity.ingest(state,{type:'assistant',message:{id:'answer',content:[{type:'text',text:'done'}]}});assert.equal(state.items.find(x=>x.id==='sdk-thinking-progress').status,'success');
});
