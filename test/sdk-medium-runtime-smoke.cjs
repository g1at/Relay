'use strict';
// Real bundled SDK/CLI with an isolated config and a synthetic loopback model.
// No user profile, credentials, browser, cron or remote access is involved.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const relay = require('../claude-sdk'), { buildRuntimePolicy } = require('../sdk-runtime-policy'), { createPluginStore } = require('../sdk-plugin-store');
const { executeSessionOperation } = require('../sdk-session-history'), { createHistoryManagement } = require('../sdk-history-management');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-medium-runtime-'));
const config = path.join(root, 'config'), cwd = path.join(root, 'workspace'); fs.mkdirSync(config); fs.mkdirSync(cwd);
fs.writeFileSync(path.join(config, 'settings.json'), '{}'); fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'SDK_READ_FILE_MARKER');
const out = path.join(__dirname, '../.codex-tmp/sdk-medium-runtime'); fs.mkdirSync(out, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), platform: process.platform, checks: [], requests: [], nativeTools: [], hooks: [], errors: [] };
let toolStep = 0;
let live, active = 'fixture', terminal, failures = [], waiting = [];
const events = [];
function notify(event) { events.push(event); for (const wake of waiting.splice(0)) wake(); if (event.type === 'result') terminal = event; }
async function until(predicate, timeout = 20000) { const start = Date.now(); while (!predicate()) { if (failures.length) throw Error(failures.join('; ')); if (Date.now() - start > timeout) throw Error('Timed out: ' + predicate.toString()); await Promise.race([new Promise(resolve => waiting.push(resolve)), new Promise(resolve => setTimeout(resolve, 100))]); } }
const server = http.createServer((req, res) => { let raw = ''; req.on('data', x => raw += x); req.on('end', () => {
  const body = JSON.parse(raw || '{}'); if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":24}'); return; }
  if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
  report.requests.push({ scenario: active, model: body.model, thinking: body.thinking, customPrompt: JSON.stringify(body.system || '').includes('MEDIUM_STATIC_MARKER'), dynamicPrompt: JSON.stringify(body.system || '').includes('MEDIUM_DYNAMIC_MARKER') });
  report.nativeTools = [...new Set([...report.nativeTools, ...(body.tools || []).map(x => x.name)])];
  const tool = active === 'tools' ? ['Read', 'ReportFindings', 'EnterWorktree', 'ExitWorktree'][toolStep++] : null;
  const input = tool === 'EnterWorktree' ? {name:'medium-fixture'} : tool === 'ExitWorktree' ? {action:'keep'} : tool === 'Read' ? { file_path: path.join(cwd, 'fixture.txt') } : { findings: [{file:'fixture.txt',line:1,summary:'Synthetic finding',failure_scenario:'Fixture only',verdict:'CONFIRMED'}] };
  const content = tool ? [{type:'tool_use',id:'tool_'+randomUUID(),name:tool,input}] : [{type:'text',text:'medium-runtime-complete'}];
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 24, output_tokens: 5 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  for (let index=0;index<content.length;index++) {
    const block=content[index];
    emit('content_block_start', {type:'content_block_start',index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});
    emit('content_block_delta', {type:'content_block_delta',index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});
    emit('content_block_stop', {type:'content_block_stop',index});
  }
  emit('message_delta', {type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:5}});emit('message_stop',{type:'message_stop'}); res.end();
}); });
const deadline = setTimeout(() => { failures.push('Fixture deadline'); live?.kill(); server.closeAllConnections(); report.errors.push('Fixture deadline'); save(false); process.exit(1); }, 110000);
function save(ok) { report.ok = ok; fs.writeFileSync(path.join(out, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2)); }
(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const {spawnSync}=require('node:child_process');
    for(const args of [['init','-q'],['config','user.name','Relay Synthetic Fixture'],['config','user.email','fixture@example.invalid'],['add','fixture.txt'],['commit','-qm','synthetic fixture']]){
      const git=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(git.status,0,git.stderr||git.error?.message);
    }
    const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-medium-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: 'fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*', ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}) };
    const plugin = path.join(root, 'fixture-plugin'); fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true }); fs.mkdirSync(path.join(plugin, 'skills', 'fixture-skill'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'relay-medium-fixture', userConfig: { label: { type: 'string', title: 'Fixture label', description: 'Synthetic option', default: 'fixture' } } }));
    fs.writeFileSync(path.join(plugin, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: Synthetic test skill\n---\nReply fixture only.');
    const store = createPluginStore({ file: path.join(root, 'plugins.json') }), item = store.add(plugin); store.update(item.id, { enabled: true }); const plugins = store.runtime();
    const policy = buildRuntimePolicy({ settings: { sdkRuntimePreferences: { thinking: 'disabled', outputBudget: 'compact', skillBudget: 'compact', disableSkillShellExecution: true, customSystemPrompt: { static: ['MEDIUM_STATIC_MARKER. Answer the synthetic fixture.'], dynamic: ['MEDIUM_DYNAMIC_MARKER'] } } }, cwd });
    policy.settingSources = []; Object.assign(policy.settings, plugins.settings, { worktree: { baseRef: 'head' } }); policy.options.maxTurns = 6; policy.diagnostics = true;
    live = relay.createLiveSession({ cwd, model: 'fixture-model', runtimeEnv, runtimePolicy: policy, plugins: plugins.plugins, permissionMode: 'default',
      canUseTool: async (name, input) => ['Read', 'ReportFindings', 'EnterWorktree', 'ExitWorktree'].includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Synthetic fixture permits read only' },
      onNativeHook: input => { report.hooks.push(input.hook_event_name);const changed=require('../sdk-native-events').nativeWorkingDirectory(input);if(changed){report.cwdChanges||=[];report.cwdChanges.push(changed);} if(input.hook_event_name==='PostToolUse'){report.postTools||=[];report.postTools.push(input.tool_name);if(input.tool_name==='ReportFindings')report.findings=require('../sdk-native-events').safeFindings(input.tool_input);} return input.hook_event_name === 'SessionStart' ? { watchPaths: [cwd] } : undefined; },
      onMessage: notify, onExit: (code, error) => { if (code && error) failures.push(String(error)); }, stderr: () => {} });
    await live.whenReady();
    const reload = await live.reloadPlugins(); report.reload = { commands: reload.commands?.map(x=>x.name), agents: reload.agents?.map(x=>x.name), plugins: reload.plugins?.map(x=>x.name), errors: reload.errors };
    const commands = await live.supportedCommands(); report.commands = commands.map(x => x.name); assert.ok(commands.some(x => x.name.includes('fixture-skill')), 'enabled plugin appears in SDK discovered commands'); report.checks.push('plugins/options: real SDK discovers isolated inline skill');
    const file = await live.readFile(path.join(cwd, 'fixture.txt'), { maxBytes: 8, encoding: 'base64' }); assert.equal(Buffer.from(file.contents, 'base64').toString(), 'SDK_READ'); assert.equal(file.truncated, true); report.checks.push('readFile: native permission-aware read + truncation + base64');
    await live.applyFlagSettings({ autoCompactEnabled: false, showThinkingSummaries: false, bashOutputMaxChars: 8000 }); report.checks.push('applyFlagSettings: actual SDK acknowledgement');
    live.push('Reply fixture success', { uuid: randomUUID() }); await until(() => terminal); assert.equal(terminal.is_error, false); assert.equal(terminal.result, 'medium-runtime-complete');
    assert.ok(report.requests.every(x => x.model === 'fixture-model' && x.customPrompt && x.dynamicPrompt)); report.checks.push('custom prompt: static/dynamic boundary reaches actual provider without rerouting');
    const initialized = await live.initializationResult(); report.hooksApplied = initialized.hooks_applied;
    const sessionId = terminal.session_id;
    const scope = { cwd, configDir: config, sessionId, agentEnvironment: 'native' };
    const messages = await executeSessionOperation(scope, 'getSessionMessages', { limit: 100 }); assert.ok(messages.some(x => x.type === 'assistant'));
    await executeSessionOperation(scope, 'renameSession', { title: 'Fixture native title' }); assert.equal((await executeSessionOperation(scope, 'getSessionInfo')).customTitle, 'Fixture native title');
    const listed = await executeSessionOperation(scope, 'listSessions', { limit: 10 }); assert.ok(listed.some(x => x.sessionId === sessionId)); report.checks.push('listSessions/getSessionInfo/renameSession: actual scoped transcript');
    const records = new Map(); const history = createHistoryManagement({ resolveWorkspaceScope: async () => ({ cwd, configDir: config, agentEnvironment: 'native' }), load: async id => records.get(id), list: async () => [...records.values()], save: async value => records.set(value.id, structuredClone(value)), isBusy: () => false });
    const imported = await history.import({ sessionId }); assert.equal(imported.turns, 1); const record = records.get(imported.id); assert.equal(record.turns[0].assistant, 'medium-runtime-complete');
    assert.equal((await history.repair(imported.id)).added, 0); assert.equal((await history.import({ sessionId })).reused, true); report.checks.push('native history: real import/repair UUID dedup without replacing Relay index');
    active='tools';terminal=null;live.push('Read the fixture file and record the synthetic finding', {uuid:randomUUID()});await until(()=>terminal);
    assert.equal(terminal.is_error,false);assert.ok(report.postTools?.includes('Read'));assert.ok(report.postTools?.includes('ReportFindings'));assert.equal(report.findings[0].summary,'Synthetic finding');
    assert.ok(report.postTools.includes('EnterWorktree'));assert.ok(report.postTools.includes('ExitWorktree'));assert.equal(path.resolve(report.cwdChanges.at(-1)),path.resolve(cwd));assert.ok(report.cwdChanges.some(p=>p.includes('medium-fixture')));assert.equal(fs.readFileSync(path.join(cwd,'fixture.txt'),'utf8'),'SDK_READ_FILE_MARKER');
    report.checks.push('EnterWorktree/ExitWorktree: temporary Git repository switches workspace and returns through successful native tool output (CwdChanged hook absent on this build) without changing source files');
    report.checks.push('ReportFindings/Read: actual SDK PostToolUse hooks deliver structured findings and successful tool execution');
    await live.prepareExecutionMode({ kind: 'plan' }, { permissionMode: 'default' }); await live.clearContext(); await until(() => events.some(e => e.type === 'conversation_reset')); report.sessionStartObserved = report.hooks.includes('SessionStart'); report.checks.push('plan acceptance: /clear produces native conversation_reset acknowledgement');
    await live.kill(); live = null;
    await history.deleteNative(imported.id); assert.equal(await executeSessionOperation(scope, 'getSessionInfo'), undefined); assert.ok(records.has(imported.id)); report.checks.push('native deletion: actual SDK cleanup retains imported Relay record');
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { clearTimeout(deadline); await live?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save(report.ok); try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); report.cleanedUp = true; } catch (e) { report.cleanupError = e.message; report.ok = false; process.exitCode = 1; } save(report.ok); console.log(JSON.stringify({ ok: report.ok, checks: report.checks, errors: report.errors }, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
