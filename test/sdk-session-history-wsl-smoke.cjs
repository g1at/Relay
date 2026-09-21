'use strict';
// Windows host -> explicitly pinned WSL public SDK history operations. All
// transcripts are synthetic, and no Query, provider or real profile is opened.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { executeSessionOperation } = require('../sdk-session-history');
const distribution = process.argv[2];
if (process.platform !== 'win32' || !distribution || /[\x00-\x1f]/.test(distribution)) throw Error('Run with Windows Node and an explicit fixture WSL distribution');
const output = path.join(__dirname, '../.codex-tmp/sdk-session-history-runtime'); fs.mkdirSync(output, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-wsl-history-'));
const hostCwd = path.join(base, 'workspace'), hostConfig = path.join(base, 'config'); fs.mkdirSync(hostCwd); fs.mkdirSync(hostConfig);
const linuxPath = value => '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/');
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], platform: process.platform,
  transport: 'Windows Node -> wsl.exe --distribution -> Linux Node -> public SDK exports', distribution, checks: [], errors: [] };
let sourceFile, source, forkScope;
async function run() {
  try {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
    const probe = spawnSync(executable, ['--distribution', distribution, '--exec', 'node', '-e',
      'process.stdout.write(JSON.stringify({cwd:require("fs").realpathSync(process.argv[1]),node:process.version}))', linuxPath(hostCwd)],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
    assert.equal(probe.status, 0, 'fixture WSL Node probe must succeed');
    const info = JSON.parse(probe.stdout); report.wslNode = info.node;
    const cwd = info.cwd, sessionId = randomUUID();
    const scope = { conversationId: randomUUID(), runId: randomUUID(), sessionId, cwd,
      configDir: hostConfig, hostCwd, agentEnvironment: 'wsl', wslDistribution: distribution, agentIds: ['agent_fixture'] };
    const project = path.join(hostConfig, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(project, { recursive: true });
    const message = (type, text, parentUuid = null, side = false) => ({ type, uuid: randomUUID(), parentUuid, isSidechain: side,
      sessionId, cwd, userType: 'external', timestamp: new Date().toISOString(), version: '2.1.266',
      message: { role: type, ...(type === 'assistant' ? { id: 'msg_fixture', type: 'message', model: 'fixture-model' } : {}),
        content: type === 'user' ? text : [{ type: 'text', text }] } });
    const first = message('user', 'Windows WSL fixture'), answer = message('assistant', 'WSL fixture answer', first.uuid);
    source = [first, answer].map(value => JSON.stringify(value)).join('\n') + '\n';
    sourceFile = path.join(project, sessionId + '.jsonl'); fs.writeFileSync(sourceFile, source);
    const agentDir = path.join(project, sessionId, 'subagents'); fs.mkdirSync(agentDir, { recursive: true });
    const task = message('user', 'WSL child fixture', null, true), response = message('assistant', 'Child result', task.uuid, true);
    fs.writeFileSync(path.join(agentDir, 'agent-agent_fixture.jsonl'), [task, response].map(value => JSON.stringify({ ...value, agentId: 'agent_fixture' })).join('\n') + '\n');
    fs.writeFileSync(path.join(agentDir, 'agent-agent_fixture.meta.json'), JSON.stringify({ toolUseId: 'tool_fixture' }));
    assert.equal((await executeSessionOperation(scope, 'getSessionInfo')).sessionId, sessionId);
    report.checks.push('Windows host discovers the synthetic Linux session in its explicitly pinned WSL distribution');
    assert.deepEqual(await executeSessionOperation(scope, 'listSubagents'), ['agent_fixture']);
    const child = await executeSessionOperation(scope, 'getSubagentMessages', { agentId: 'agent_fixture', offset: 1, limit: 1 });
    assert.equal(child[0].parent_tool_use_id, 'tool_fixture'); assert.equal(child[0].message.content[0].text, 'Child result');
    report.checks.push('real WSL listSubagents/getSubagentMessages retain pagination and tool ownership');
    const fork = await executeSessionOperation(scope, 'forkSession', { upToMessageId: answer.uuid, title: 'Synthetic WSL fork' });
    forkScope = { ...scope, sessionId: fork.sessionId };
    const history = await executeSessionOperation(forkScope, 'getSessionMessages', { limit: 10 });
    assert.equal(history.length, 2); assert.ok(history.every(item => item.session_id === fork.sessionId && ![first.uuid, answer.uuid].includes(item.uuid)));
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    report.checks.push('real WSL forkSession remaps UUIDs and leaves the original synthetic transcript byte-identical');
    await executeSessionOperation(forkScope, 'deleteSession');
    assert.equal(await executeSessionOperation(forkScope, 'getSessionInfo'), undefined); forkScope = null;
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    report.checks.push('Windows-to-WSL cleanup deletes only the newly created synthetic branch'); report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { if (forkScope) await executeSessionOperation(forkScope, 'deleteSession').catch(() => {});
    fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, 'runtime-win32-wsl.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
