'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { sessionContext, observeProvenance, applyProvenance, protectSdkMetadata, resolveStoredScope, pendingForkOptions } = require('../sdk-session-provenance');
const { LiveTurnRouter } = require('../live-turn-router');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const session = { sessionId: uuid(1), convId: uuid(2), jobId: uuid(3), launchSpec: { cwd: 'D:\\project', runtimeCwd: '/mnt/d/project', agentEnvironment: 'wsl', wslDistribution: 'Pinned Linux' } };
  const record = { id: session.convId, sessionId: session.sessionId, turns: [{ runId: session.jobId, status: 'running' }] };
  return { session, record };
}
test('native provenance retains actual runtime directory, host directory and pinned distribution', () => {
  const { session } = fixture(); assert.deepEqual(sessionContext(session, 'C:\\fixture'), { sessionId: session.sessionId,
    cwd: '/mnt/d/project', hostCwd: 'D:\\project', configDir: 'C:\\fixture', agentEnvironment: 'wsl', wslDistribution: 'Pinned Linux' });
  session.sessionId = 'invalid'; assert.equal(sessionContext(session, '/tmp/config'), null);
});
test('runtime source captures provider revision and contract identity without configuration secrets', () => {
  const { session } = fixture(); Object.assign(session.launchSpec, { providerId: 'fixture-provider', providerRevision: 4,
    routeTier: 'expert', model: 'fixture-model', effort: 'high', mode: 'agent', agentName: 'Reviewer', runtimeFingerprint: 'fixture-contract', apiKey: 'never-store-this' });
  const context = sessionContext(session, '/tmp/config');
  assert.deepEqual(context.routing, { providerId: 'fixture-provider', providerRevision: 4, agentEnvironment: 'wsl',
    routeTier: 'expert', model: 'fixture-model', effort: 'high', mode: 'agent', agentName: 'Reviewer', projectId: null, runtimeFingerprint: 'fixture-contract' });
  assert.equal(JSON.stringify(context).includes('never-store-this'), false);
});
test('parent assistant boundary is retained while nested agent messages do not replace it', () => {
  const { session, record } = fixture();
  observeProvenance(session, { type: 'assistant', uuid: uuid(4), message: { content: [{ type: 'tool_use', id: 'tool_parent', name: 'Agent' }] } });
  observeProvenance(session, { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'agent_one', tool_use_id: 'tool_parent' });
  observeProvenance(session, { type: 'assistant', uuid: uuid(5), parent_tool_use_id: 'tool_parent', message: { content: [{ type: 'tool_use', id: 'nested_tool' }] } });
  observeProvenance(session, { type: 'user', uuid: uuid(6), tool_use_result: { agentId: 'agent_one' }, message: { content: [] } });
  observeProvenance(session, { type: 'assistant', uuid: uuid(7), message: { content: [{ type: 'text', text: 'final' }] } });
  applyProvenance(record, session, '/tmp/config'); assert.equal(record.turns[0].sdkForkPoint, undefined);
  applyProvenance(record, session, '/tmp/config', { complete: true });
  assert.equal(record.turns[0].sdkForkPoint, uuid(7)); assert.deepEqual(record.turns[0].sdkAgentIds, ['agent_one']);
  assert.deepEqual(record.turns[0].sdkToolUseIds, ['tool_parent']);
});
test('context reset clears old turn boundary and agent ownership without deleting visible history', () => {
  const { session, record } = fixture(); record.turns[0].answer = 'visible old answer';
  observeProvenance(session, { type: 'assistant', uuid: uuid(4), message: { content: [] } }); applyProvenance(record, session, '/tmp/config', { complete: true });
  session.sessionId = uuid(8); observeProvenance(session, { type: 'conversation_reset' }); applyProvenance(record, session, '/tmp/config');
  assert.equal(record.sessionId, uuid(8)); assert.equal(record.turns[0].sdkForkPoint, undefined); assert.equal(record.turns[0].sdkLastMessageUuid, undefined);
  assert.equal(record.turns[0].answer, 'visible old answer'); assert.deepEqual(record.turns[0].sdkAgentIds, []);
});
test('prewarming init can clear a prepared native fork before the turn router accepts any frames', () => {
  const { session, record } = fixture(); const source = session.sessionId; session.jobId = null; session.sessionId = uuid(8);
  record.pendingSdkFork = { sourceSessionId: source, targetSessionId: session.sessionId, messageUuid: uuid(4) };
  const router = new LiveTurnRouter(); const init = { type: 'system', subtype: 'init', session_id: session.sessionId };
  assert.equal(router.accept(init), null); assert.equal(applyProvenance(record, session, '/tmp/config'), true);
  assert.equal(record.sessionId, session.sessionId); assert.equal(record.pendingSdkFork, undefined);
  assert.equal(record.turns[0].sdkSessionContext, undefined); assert.deepEqual(pendingForkOptions(record, session.sessionId), {});
});
test('renderer saves preserve host metadata and cannot forge native identity or another run lineage', () => {
  const { session, record } = fixture(); observeProvenance(session, { type: 'assistant', uuid: uuid(4), message: { content: [] } });
  applyProvenance(record, session, '/tmp/config', { complete: true }); record.pendingSdkFork = { targetSessionId: uuid(8) };
  const incoming = clone(record); incoming.sessionId = uuid(99); incoming.sdkSessionContext.cwd = '/forged';
  incoming.pendingSdkFork.targetSessionId = uuid(99); incoming.turns[0].sdkForkPoint = uuid(99);
  incoming.turns.push({ runId: uuid(99), sdkSessionContext: clone(record.sdkSessionContext), sdkForkPoint: uuid(99), sdkAgentIds: ['stolen'] });
  protectSdkMetadata(incoming, record); assert.equal(incoming.sessionId, session.sessionId); assert.deepEqual(incoming.sdkSessionContext, record.sdkSessionContext);
  assert.equal(incoming.turns[0].sdkForkPoint, uuid(4)); assert.equal(incoming.pendingSdkFork.targetSessionId, uuid(8));
  assert.equal(incoming.turns[1].sdkSessionContext, undefined); assert.equal(incoming.turns[1].sdkAgentIds, undefined);
});
test('selected run resolves its own original scope even after current conversation changes native session', () => {
  const { session, record } = fixture(); applyProvenance(record, session, '/tmp/config'); record.turns[0].sdkAgentIds = ['owned'];
  record.sdkSessionContext = { ...record.sdkSessionContext, sessionId: uuid(8) }; record.sessionId = uuid(8);
  const selected = resolveStoredScope(record, session.jobId); assert.equal(selected.sessionId, uuid(1)); assert.deepEqual(selected.agentIds, ['owned']);
  assert.equal(resolveStoredScope(record).sessionId, uuid(8));
  assert.throws(() => resolveStoredScope(record, uuid(99)), { code: 'RUN_NOT_FOUND' });
  delete record.turns[0].sdkSessionContext; assert.throws(() => resolveStoredScope(record, session.jobId), { code: 'SDK_HISTORY_UNAVAILABLE' });
  delete record.sdkSessionContext; assert.throws(() => resolveStoredScope(record), { code: 'SDK_HISTORY_UNAVAILABLE' });
});
test('pending fork resume flags bind source, destination and exact message, rejecting route-induced fresh resume', () => {
  const fork = { sourceSessionId: uuid(1), targetSessionId: uuid(8), messageUuid: uuid(4) };
  assert.deepEqual(pendingForkOptions({ pendingSdkFork: fork }, uuid(1)), { forkSession: true, resumeSessionAt: uuid(4), forkSessionId: uuid(8) });
  assert.throws(() => pendingForkOptions({ pendingSdkFork: fork }, null), { code: 'FORK_RESUME_MISMATCH' });
  assert.throws(() => pendingForkOptions({ pendingSdkFork: { ...fork, targetSessionId: 'bad' } }, uuid(1)), { code: 'FORK_RESUME_MISMATCH' });
});
