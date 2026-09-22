'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionForkService } = require('../src/main/sdk/sdk-session-forks');
const { createProjectStore } = require('../src/main/projects/project-store');
const copy = value => JSON.parse(JSON.stringify(value));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const scope = { sessionId: uuid(3), cwd: '/tmp/relay-fork-fixture', hostCwd: '/tmp/relay-fork-fixture', configDir: '/tmp/relay-fork-config', agentEnvironment: 'native' };
  const source = { id: uuid(1), title: 'Source', sessionId: scope.sessionId, sdkSessionContext: scope, pinned: true,
    executionMode: { kind: 'goal', objective: 'old goal' }, goalRecovery: { condition: 'old' }, sdkTaskResources: ['old'], contextUsage: {},
    turns: [1, 2].map(n => ({ runId: uuid(10 + n), status: 'completed', prompt: `prompt ${n}`, answer: `answer ${n}`,
      sdkSessionContext: copy(scope), sdkForkPoint: uuid(20 + n), sdkAgentIds: [`agent_${n}`] })) };
  const store = new Map([[source.id, copy(source)]]), calls = [], persisted = [];
  let next = 100, busy = false;
  const deps = { loadConversation: id => store.has(id) ? copy(store.get(id)) : null,
    persistConversation: record => { persisted.push(copy(record)); store.set(record.id, copy(record)); },
    isBusy: () => busy, now: () => '2026-09-11T00:00:00.000Z', newId: () => uuid(next++),
    execute: async (target, operation, args) => { calls.push({ scope: copy(target), operation, args });
      if (operation === 'getSessionInfo') return { sessionId: target.sessionId };
      if (operation === 'getSessionMessages') return source.turns.map(turn => ({ uuid: turn.sdkForkPoint, session_id: target.sessionId }));
      if (operation === 'forkSession') return { sessionId: uuid(50) };
    } };
  return { source, store, calls, persisted, deps, busy: value => { busy = value; }, service: () => createSessionForkService(deps) };
}
test('whole native branch preserves source and copies readonly history with independent Relay run IDs', async () => {
  const f = fixture(), before = JSON.stringify(f.store.get(f.source.id));
  const result = await f.service().create({ conversationId: f.source.id });
  assert.equal(result.ok, true); assert.equal(result.pendingNativeFork, false);
  assert.equal(JSON.stringify(f.store.get(f.source.id)), before);
  const branch = f.persisted[0];
  assert.equal(branch.sessionId, uuid(50)); assert.equal(branch.sdkSessionContext.sessionId, uuid(50));
  assert.equal(branch.forkedFrom.sessionId, f.source.sessionId); assert.equal(branch.forkedFrom.sharesFiles, true);
  assert.deepEqual(branch.executionMode, { kind: 'default' }); assert.equal(branch.pinned, false);
  for (const field of ['pendingSdkFork', 'goalRecovery', 'contextUsage', 'sdkTaskResources']) assert.equal(field in branch, false);
  branch.turns.forEach((turn, index) => { assert.notEqual(turn.runId, f.source.turns[index].runId);
    assert.equal(turn.forkedFromRunId, f.source.turns[index].runId); assert.deepEqual(turn.sdkSessionContext, f.source.turns[index].sdkSessionContext); });
  assert.equal(new Set(branch.turns.map(turn => turn.runId)).size, 2);
  assert.equal(f.calls.filter(call => call.operation === 'forkSession').length, 1);
});
test('selected-turn branch defers a single native fork and excludes later Relay turns', async () => {
  const f = fixture(), result = await f.service().create({ conversationId: f.source.id, runId: f.source.turns[0].runId });
  const branch = f.persisted[0]; assert.equal(result.pendingNativeFork, true); assert.equal(branch.turns.length, 1);
  assert.equal(branch.sessionId, f.source.sessionId); assert.equal(branch.pendingSdkFork.sourceSessionId, f.source.sessionId);
  assert.equal(branch.pendingSdkFork.messageUuid, f.source.turns[0].sdkForkPoint);
  assert.notEqual(branch.pendingSdkFork.targetSessionId, f.source.sessionId);
  assert.equal(f.calls.some(call => call.operation === 'forkSession'), false);
  assert.equal(f.calls.find(call => call.operation === 'getSessionMessages').scope.runId, f.source.turns[0].runId);
});
test('legacy, unknown-run, unfinished and busy sources cannot fabricate a native fork', async () => {
  for (const [change, request, code] of [
    [record => { delete record.sdkSessionContext; }, {}, 'SDK_HISTORY_UNAVAILABLE'],
    [() => {}, { runId: uuid(999) }, 'RUN_NOT_FOUND'],
    [record => { delete record.turns[0].sdkForkPoint; }, { runId: uuid(11) }, 'FORK_POINT_UNAVAILABLE'],
    [record => { record.pendingSdkFork = {}; }, {}, 'FORK_NOT_STARTED'],
  ]) {
    const f = fixture(); change(f.store.get(f.source.id));
    await assert.rejects(f.service().create({ conversationId: f.source.id, ...request }), { code }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.busy(true);
  await assert.rejects(f.service().create({ conversationId: f.source.id }), { code: 'CONVERSATION_BUSY' });
});
test('deleted or compacted native history is explicit and creates no Relay record', async () => {
  const f = fixture(); f.deps.execute = async () => undefined;
  await assert.rejects(f.service().create({ conversationId: f.source.id }), { code: 'SDK_HISTORY_EXPIRED' });
  f.deps.execute = async (_scope, operation) => operation === 'getSessionInfo' ? {} : [];
  await assert.rejects(f.service().create({ conversationId: f.source.id, runId: f.source.turns[0].runId }), { code: 'FORK_POINT_EXPIRED' });
  assert.equal(f.persisted.length, 0);
});
test('concurrent duplicate clicks create only one branch', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  const execute = f.deps.execute; f.deps.execute = async (...args) => { await gate; return execute(...args); };
  const service = f.service(), first = service.create({ conversationId: f.source.id }), second = service.create({ conversationId: f.source.id });
  release(); assert.deepEqual(await first, await second); assert.equal(f.persisted.length, 1);
});
test('source mutation while locating a boundary rejects the request before native fork', async () => {
  const f = fixture(), execute = f.deps.execute;
  f.deps.execute = async (...args) => { const result = await execute(...args); if (args[1] === 'getSessionInfo') f.store.get(f.source.id).turns.push({ runId: uuid(30) }); return result; };
  await assert.rejects(f.service().create({ conversationId: f.source.id }), { code: 'FORK_SOURCE_CHANGED' });
  assert.equal(f.calls.some(call => call.operation === 'forkSession'), false); assert.equal(f.persisted.length, 0);
});
test('failure persisting a materialized native fork only deletes the newly created session', async () => {
  const f = fixture(); f.deps.persistConversation = () => { throw Error('fixture write failed'); };
  await assert.rejects(f.service().create({ conversationId: f.source.id }), /fixture write failed/);
  const deletion = f.calls.filter(call => call.operation === 'deleteSession'); assert.equal(deletion.length, 1);
  assert.equal(deletion[0].scope.sessionId, uuid(50)); assert.notEqual(deletion[0].scope.sessionId, f.source.sessionId);
  assert.deepEqual(f.store.get(f.source.id), f.source);
});
test('source environment change while SDK fork runs is rejected and rolls back only the new session', async () => {
  const f = fixture(), execute = f.deps.execute;
  f.deps.execute = async (...args) => { const result = await execute(...args);
    if (args[1] === 'forkSession') f.store.get(f.source.id).sdkSessionContext.configDir = '/tmp/different-native-store'; return result; };
  await assert.rejects(f.service().create({ conversationId: f.source.id }), { code: 'FORK_SOURCE_CHANGED' });
  assert.equal(f.persisted.length, 0); assert.equal(f.calls.filter(call => call.operation === 'deleteSession').length, 1);
});
test('selected legacy turn keeps its recorded directory without inventing a replacement project', async () => {
  const f = fixture(), projects = createProjectStore();
  const currentProject = projects.add('/tmp/synthetic-current-project', 'Current project', { legacy: true });
  const record = f.store.get(f.source.id); record.projectId = currentProject.id;
  record.workingDir = { path: currentProject.path, name: currentProject.name };
  record.sessionId = uuid(70); record.sdkSessionContext = { ...record.sdkSessionContext, sessionId: uuid(70), cwd: currentProject.path, hostCwd: currentProject.path };
  record.turns[0].sdkSessionContext.routing = { providerId: 'original-provider', providerRevision: 3, routeTier: 'fast', agentEnvironment: 'native', effort: 'low', runtimeFingerprint: 'original-contract' };
  f.deps.decorate = branch => { projects.adopt(branch); return projects.decorate(branch); };
  await f.service().create({ conversationId: f.source.id, runId: f.source.turns[0].runId });
  assert.equal(f.persisted[0].workingDir.path, f.source.turns[0].sdkSessionContext.hostCwd);
  assert.equal(f.persisted[0].projectId, null);
  assert.equal(f.persisted[0].sdkForkWorkspace.path, f.source.turns[0].sdkSessionContext.hostCwd);
  assert.equal(projects.list().length, 1);
});
test('old turn branch inherits its recorded provider route instead of the latest conversation route', async () => {
  const f = fixture(), record = f.store.get(f.source.id);
  Object.assign(record, { sessionProviderId: 'new-provider', sessionProviderRevision: 7, sessionAgentEnvironment: 'wsl',
    sessionRouteTier: 'expert', model: 'expert', effort: 'high', sdkRuntimeFingerprint: 'new-contract' });
  record.turns[0].sdkSessionContext.routing = { providerId: 'original-provider', providerRevision: 3, routeTier: 'fast', agentEnvironment: 'native', effort: 'low', runtimeFingerprint: 'original-contract' };
  await f.service().create({ conversationId: f.source.id, runId: record.turns[0].runId });
  const branch = f.persisted[0]; assert.equal(branch.sessionProviderId, 'original-provider'); assert.equal(branch.sessionProviderRevision, 3);
  assert.equal(branch.sessionAgentEnvironment, 'native'); assert.equal(branch.sessionRouteTier, 'fast'); assert.equal(branch.model, 'fast');
  assert.equal(branch.effort, 'low'); assert.equal(branch.sdkRuntimeFingerprint, 'original-contract');
});
test('older native session without provider lineage cannot borrow the current route', async () => {
  const f = fixture(), record = f.store.get(f.source.id); record.sdkSessionContext.sessionId = uuid(70); record.sessionId = uuid(70);
  await assert.rejects(f.service().create({ conversationId: f.source.id, runId: record.turns[0].runId }), { code: 'FORK_ROUTE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0); assert.equal(f.persisted.length, 0);
});

test('redo forks before the last human turn and passes its consumed UUID without altering source files or history', async () => {
  const f = fixture(), original = f.store.get(f.source.id);
  original.turns[1].user = 'corrected requirement'; original.turns[1].userMessageId = uuid(90); original.turns[1].files = [{ path: '/tmp/fixture.png' }];
  const before = JSON.stringify(original), result = await f.service().create({ conversationId: f.source.id, runId: original.turns[1].runId, redo: true });
  const branch = f.persisted[0]; assert.equal(branch.turns.length, 1); assert.equal(branch.pendingSdkFork.messageUuid, original.turns[0].sdkForkPoint);
  assert.equal(branch.pendingSdkFork.resumeDropsTurn, uuid(90)); assert.equal(result.prefill, 'corrected requirement'); assert.deepEqual(result.files, original.turns[1].files);
  assert.equal(JSON.stringify(f.store.get(f.source.id)), before);
});
test('redo refuses the first turn and a turn whose preceding runtime context was reset', async () => {
  const f = fixture(); await assert.rejects(f.service().create({ conversationId: f.source.id, runId: f.source.turns[0].runId, redo: true }), { code: 'FORK_REDO_UNAVAILABLE' });
  f.store.get(f.source.id).turns[0].sdkSessionContext.sessionId = uuid(999);
  await assert.rejects(f.service().create({ conversationId: f.source.id, runId: f.source.turns[1].runId, redo: true }), { code: 'FORK_REDO_UNAVAILABLE' }); assert.equal(f.persisted.length, 0);
});
