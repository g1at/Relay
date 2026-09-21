'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSessionHistoryService, invokeSessionOperation, executeSessionOperation } = require('../sdk-session-history');
const ids = { conversationId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333' };
const scope = { ...ids, cwd: '/tmp/synthetic-workspace', configDir: '/tmp/synthetic-config', agentEnvironment: 'native', agentIds: ['agent_one'] };
const input = { convId: ids.conversationId, runId: ids.runId };
function fixtureSdk() {
  const calls = [];
  return { calls, getSessionInfo: async (id, options) => { calls.push(['getSessionInfo', id, options]); return { sessionId: id }; },
    listSubagents: async (id, options) => { calls.push(['listSubagents', id, options]); return ['agent_one', 'other_run']; },
    getSubagentMessages: async (id, agent, options) => { calls.push(['getSubagentMessages', id, agent, options]); return [{ type: 'assistant', session_id: id, uuid: 'x', message: { content: 'synthetic' } }]; } };
}
test('subagent history calls native SDK with explicit project and verifies parent session', async () => {
  const sdk = fixtureSdk(); const result = await invokeSessionOperation(sdk, scope, 'getSubagentMessages', { agentId: 'agent_one', offset: 30, limit: 31 });
  assert.equal(result[0].session_id, ids.sessionId);
  assert.deepEqual(sdk.calls.at(-1), ['getSubagentMessages', ids.sessionId, 'agent_one', { dir: scope.cwd, limit: 31, offset: 30 }]);
  sdk.getSubagentMessages = async () => [{ session_id: 'foreign-session' }];
  await assert.rejects(invokeSessionOperation(sdk, scope, 'getSubagentMessages', { agentId: 'agent_one' }), { code: 'SUBAGENT_SCOPE_MISMATCH' });
});
test('missing parent and deleted subagent records are explicit, not fabricated empty success', async () => {
  const sdk = fixtureSdk(); sdk.getSessionInfo = async () => undefined;
  await assert.rejects(invokeSessionOperation(sdk, scope, 'listSubagents'), { code: 'SESSION_HISTORY_UNAVAILABLE' });
  sdk.listSubagents = async () => [];
  await assert.rejects(invokeSessionOperation(sdk, scope, 'getSubagentMessages', { agentId: 'agent_one' }), { code: 'SUBAGENT_HISTORY_UNAVAILABLE' });
});
test('service filters sibling-turn agents, rejects cross-conversation and deduplicates requests', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createSessionHistoryService({ resolveScope: async () => scope,
    execute: async () => { calls++; await gate; return ['agent_one', 'other_run']; } });
  const first = service.listSubagents(input), second = service.listSubagents(input);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); assert.deepEqual((await first).items, [{ agentId: 'agent_one' }]); await second;
  assert.equal((await service.listSubagents({ ...input, convId: ids.sessionId })).code, 'SESSION_SCOPE_INVALID');
  assert.equal((await service.getSubagentMessages({ ...input, agentId: 'other_run' })).code, 'SUBAGENT_SCOPE_MISMATCH');
  assert.equal(calls, 1);
});
test('late result after deletion or session reset is discarded', async () => {
  let release, current = { ...scope };
  const gate = new Promise(resolve => { release = resolve; });
  const service = createSessionHistoryService({ resolveScope: async () => current, execute: async () => { await gate; return ['agent_one']; } });
  const pending = service.listSubagents(input); await new Promise(resolve => setImmediate(resolve));
  current.sessionId = '44444444-4444-4444-8444-444444444444'; release();
  assert.equal((await pending).code, 'SESSION_HISTORY_STALE');
});
test('pagination is bounded and no lineage means no reads', async () => {
  let argumentsSeen, reads = 0;
  const service = createSessionHistoryService({ resolveScope: async () => scope,
    execute: async (_scope, _op, args) => { reads++; argumentsSeen = args; return Array.from({ length: 51 }, (_, index) => ({ uuid: String(index) })); } });
  const result = await service.getSubagentMessages({ ...input, agentId: 'agent_one', offset: 100, limit: 500 });
  assert.equal(argumentsSeen.limit, 51); assert.equal(result.items.length, 50); assert.equal(result.nextOffset, 150); assert.equal(result.hasMore, true);
  const unknown = createSessionHistoryService({ resolveScope: async () => ({ ...scope, agentIds: [] }), execute: async () => { reads++; } });
  assert.equal((await unknown.listSubagents(input)).code, 'SUBAGENT_OWNERSHIP_UNAVAILABLE'); assert.equal(reads, 1);
});
test('WSL bridge pins recorded distribution, sends JSON on stdin and handles missing runtime', async () => {
  let spawnArgs, payload;
  const spawn = (file, args, options) => {
    spawnArgs = { file, args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin = new EventEmitter(); child.stdin.end = text => { payload = JSON.parse(text); setImmediate(() => { child.stdout.emit('data', JSON.stringify({ ok: true, value: ['agent_one'] })); child.emit('close', 0); }); };
    return child;
  };
  const wsl = { ...scope, agentEnvironment: 'wsl', wslDistribution: 'Fixture Linux', cwd: 'D:\\work', configDir: 'C:\\fixture\\claude' };
  const result = await executeSessionOperation(wsl, 'listSubagents', {}, { platform: 'win32', spawn, workerPath: 'D:\\Relay\\sdk-session-history-worker.cjs', sdkPath: 'D:\\Relay\\sdk.mjs' });
  assert.deepEqual(result, ['agent_one']); assert.deepEqual(spawnArgs.args.slice(0, 5), ['--distribution', 'Fixture Linux', '--cd', '/mnt/d/work', '--exec']);
  assert.equal(payload.scope.configDir, '/mnt/c/fixture/claude'); assert.equal(spawnArgs.options.shell, false);
  assert.throws(() => executeSessionOperation({ ...wsl, wslDistribution: null }, 'listSubagents'), { code: 'SESSION_ENVIRONMENT_UNAVAILABLE' });
});

test('rapid detail navigation runs at most two native history readers concurrently', async () => {
  let active = 0, maximum = 0; const releases = [];
  const service = createSessionHistoryService({ resolveScope: async () => scope, execute: async () => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => releases.push(resolve)); active--; return [];
  } });
  const requests = Array.from({ length: 4 }, (_, offset) => service.getSubagentMessages({ ...input, agentId: 'agent_one', offset }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(active, 2);
  releases.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(resolve => resolve()); await Promise.all(requests); assert.equal(maximum, 2);
});
