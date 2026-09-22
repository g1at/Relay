'use strict';
// Real SDK file APIs against synthetic JSONL only. No model/network/runtime Query.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { executeSessionOperation } = require('../src/main/sdk/sdk-session-history');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-session-history-'));
const cwd = path.join(base, 'workspace'), configDir = path.join(base, 'config'); fs.mkdirSync(cwd); fs.mkdirSync(configDir);
const project = path.join(configDir, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(project, { recursive: true });
const sessionId = randomUUID(), convId = randomUUID(), runId = randomUUID();
const scope = { conversationId: convId, runId, sessionId, cwd, configDir, agentEnvironment: 'native', agentIds: ['agent_one'] };
const output = path.join(__dirname, '../.codex-tmp/sdk-session-history-runtime'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], platform: process.platform, checks: [], errors: [] };
const user = (text, parentUuid = null, side = false) => ({ parentUuid, isSidechain: side, userType: 'external', cwd, sessionId, version: '2.1.266', type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const assistant = (text, parentUuid, side = false) => ({ parentUuid, isSidechain: side, cwd, sessionId, version: '2.1.266', type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } } });
const first = user('Before the fork marker'), answer = assistant('Fixture answer one', first.uuid), second = user('After the fork marker', answer.uuid), final = assistant('Fixture answer two', second.uuid);
const transcript = path.join(project, sessionId + '.jsonl');
const source = [first, answer, second, final].map(entry => JSON.stringify(entry)).join('\n') + '\n'; fs.writeFileSync(transcript, source);
const agentDir = path.join(project, sessionId, 'subagents'); fs.mkdirSync(agentDir, { recursive: true });
for (const agentId of ['agent_one', 'other_run']) {
  const prompt = user('Synthetic child input ' + agentId, null, true), reply = assistant('Synthetic child output ' + agentId, prompt.uuid, true);
  fs.writeFileSync(path.join(agentDir, `agent-${agentId}.jsonl`), [prompt, reply].map(entry => JSON.stringify({ ...entry, agentId })).join('\n') + '\n');
  fs.writeFileSync(path.join(agentDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId: 'tool-' + agentId, parentAgentId: null }));
}
async function check(label, condition) { assert.ok(condition, label); report.checks.push(label); }
async function run() {
  try {
    const info = await executeSessionOperation(scope, 'getSessionInfo');
    await check('native SDK discovers only the explicitly scoped synthetic session', info?.sessionId === sessionId);
    const agents = await executeSessionOperation(scope, 'listSubagents');
    assert.deepEqual(agents.sort(), ['agent_one', 'other_run']); report.checks.push('listSubagents reads real native subagent JSONL directory');
    const child = await executeSessionOperation(scope, 'getSubagentMessages', { agentId: 'agent_one', limit: 1, offset: 1 });
    await check('getSubagentMessages paginates the SDK chain and preserves tool ownership metadata', child.length === 1 && child[0].message.content[0].text.includes('agent_one') && child[0].parent_tool_use_id === 'tool-agent_one');
    const messages = await executeSessionOperation(scope, 'getSessionMessages', { limit: 10 });
    assert.deepEqual(messages.map(message => message.uuid), [first.uuid, answer.uuid, second.uuid, final.uuid]); report.checks.push('getSessionMessages retains chronological parentUuid chain');
    const fork = await executeSessionOperation(scope, 'forkSession', { upToMessageId: answer.uuid, title: 'Synthetic branch' });
    const forkScope = { ...scope, sessionId: fork.sessionId };
    const forkMessages = await executeSessionOperation(forkScope, 'getSessionMessages', { limit: 10 });
    await check('forkSession slices exactly through the requested SDK message', forkMessages.length === 2 && JSON.stringify(forkMessages).includes('Fixture answer one') && !JSON.stringify(forkMessages).includes('After the fork marker'));
    await check('forkSession remaps message and session UUIDs', forkMessages.every(message => message.session_id === fork.sessionId && !messages.some(old => old.uuid === message.uuid)));
    assert.equal(fs.readFileSync(transcript, 'utf8'), source); report.checks.push('fork leaves source transcript bytes unchanged');
    await executeSessionOperation(forkScope, 'deleteSession');
    await check('cleanup only removes the new synthetic fork', !await executeSessionOperation(forkScope, 'getSessionInfo') && fs.readFileSync(transcript, 'utf8') === source);
    fs.unlinkSync(path.join(agentDir, 'agent-agent_one.jsonl'));
    await assert.rejects(executeSessionOperation(scope, 'getSubagentMessages', { agentId: 'agent_one' }), { code: 'SUBAGENT_HISTORY_UNAVAILABLE' });
    report.checks.push('deleted native subagent transcript returns an explicit unavailable error');
    report.ok = true;
  } catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true;
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
