'use strict';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const HOST_FIELDS = ['sdkSessionContext', 'sdkLastMessageUuid', 'sdkForkPoint', 'sdkAgentIds', 'sdkToolUseIds', 'forkedFromRunId', 'sdkUserMessageId', 'nativeMessageUuids'];
function sessionContext(session, configDir) {
  if (!UUID.test(session?.sessionId || '')) return null;
  const spec = session.launchSpec || {};
  return { sessionId: session.sessionId, cwd: spec.runtimeCwd || spec.cwd, hostCwd: spec.cwd,
    configDir, agentEnvironment: spec.agentEnvironment || 'native', wslDistribution: spec.wslDistribution || null,
    ...(spec.providerId ? { routing: { providerId: spec.providerId, providerRevision: spec.providerRevision,
      agentEnvironment: spec.agentEnvironment || 'native', routeTier: spec.routeTier,
      model: spec.model, effort: spec.effort, mode: spec.mode, agentName: spec.agentName,
      projectId: spec.projectId || null,
      runtimeFingerprint: spec.runtimeFingerprint,
      ...(spec.runtimeFingerprintVersion ? { runtimeFingerprintVersion: spec.runtimeFingerprintVersion } : {}) } } : {}) };
}
function observeProvenance(session, event) {
  const child = event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type;
  if (!session.sdkProvenance || event.type === 'conversation_reset') session.sdkProvenance = { agentIds: new Set(), toolUseIds: new Set(), lastMessageUuid: null };
  const state = session.sdkProvenance;
  if (!child && ['assistant', 'user'].includes(event.type) && UUID.test(event.uuid || '')) state.lastMessageUuid = event.uuid;
  if (!child && event.type === 'assistant') for (const block of event.message?.content || []) {
    if (block.type === 'tool_use' && block.id) state.toolUseIds.add(block.id);
  }
  const toolResult = event.type === 'user' && (event.tool_use_result || event.toolUseResult);
  const agentId = toolResult?.agentId || (event.subtype === 'task_started' && /agent/i.test(event.task_type || '') ? event.task_id : null);
  if (agentId && /^[\w-]{1,160}$/.test(agentId)) state.agentIds.add(agentId);
}
function applyProvenance(record, session, configDir, { complete = false } = {}) {
  // A fresh live Query can initialize while its user/history input is still
  // blocked on mode or MCP preparation. Only native consumption certifies it.
  if (session?.nativeContextReady === false) return false;
  const scope = sessionContext(session, configDir);
  if (!record || !scope) return false;
  delete record.sdkResumeRejected;
  record.sdkSessionContext = scope;
  record.sessionId = scope.sessionId;
  if (scope.routing?.runtimeFingerprint && scope.routing.runtimeFingerprintVersion) {
    record.sdkRuntimeFingerprint = scope.routing.runtimeFingerprint;
    record.sdkRuntimeFingerprintVersion = scope.routing.runtimeFingerprintVersion;
  }
  if (record.pendingSdkFork && record.pendingSdkFork.targetSessionId === scope.sessionId) delete record.pendingSdkFork;
  const turn = record.turns?.find(item => item.runId === session.jobId);
  if (turn) {
    turn.sdkSessionContext = clone(scope);
    turn.sdkAgentIds = [...(session.sdkProvenance?.agentIds || [])];
    turn.sdkToolUseIds = [...(session.sdkProvenance?.toolUseIds || [])];
    if (session.sdkProvenance?.lastMessageUuid) turn.sdkLastMessageUuid = session.sdkProvenance.lastMessageUuid;
    else { delete turn.sdkLastMessageUuid; delete turn.sdkForkPoint; }
    if (complete && turn.sdkLastMessageUuid) turn.sdkForkPoint = turn.sdkLastMessageUuid;
  }
  return true;
}
function protectSdkMetadata(incoming, saved) {
  // Renderer history saves own presentation, never native transcript identity.
  for (const field of ['sdkSessionContext', 'sdkContextBoundary', 'pendingSdkFork', 'forkedFrom', 'sdkForkWorkspace', 'sdkReviewFindings', 'sdkTitleSync', 'sdkImported']) {
    if (saved && Object.hasOwn(saved, field)) incoming[field] = clone(saved[field]); else delete incoming[field];
  }
  if (saved?.sdkSessionContext?.sessionId || saved?.sdkResumeRejected) incoming.sessionId = saved.sessionId;
  if (saved?.sdkResumeRejected) { incoming.sdkResumeRejected = true; incoming.carryContextOnNextTurn = saved.carryContextOnNextTurn; }
  const turns = new Map((saved?.turns || []).map(turn => [turn.runId, turn]));
  for (const turn of incoming.turns || []) for (const field of HOST_FIELDS) {
    const previous = turns.get(turn.runId);
    if (previous && Object.hasOwn(previous, field)) turn[field] = clone(previous[field]); else delete turn[field];
  }
  return incoming;
}
function resolveStoredScope(record, runId) {
  if (!record) throw Object.assign(Error('对话已不存在'), { code: 'CONVERSATION_NOT_FOUND' });
  const turn = runId ? record.turns?.find(item => item.runId === runId) : null;
  if (runId && !turn) throw Object.assign(Error('这条任务不属于当前对话'), { code: 'RUN_NOT_FOUND' });
  const scope = turn?.sdkSessionContext || (!runId ? record.sdkSessionContext : null);
  if (!scope || !UUID.test(scope.sessionId || '')) throw Object.assign(Error('这条历史尚未记录可追溯的原生会话，请在后续运行中查看'), { code: 'SDK_HISTORY_UNAVAILABLE' });
  return { ...clone(scope), conversationId: record.id, runId: runId || null,
    ...(turn ? { agentIds: [...(turn.sdkAgentIds || [])], toolUseIds: [...(turn.sdkToolUseIds || [])] } : {}) };
}
function pendingForkOptions(record, resumeId) {
  const fork = record?.pendingSdkFork;
  if (!fork) return {};
  if (!UUID.test(fork.targetSessionId || '') || !UUID.test(fork.sourceSessionId || '') || !UUID.test(fork.messageUuid || '') || resumeId !== fork.sourceSessionId || fork.targetSessionId === fork.sourceSessionId) {
    throw Object.assign(Error('分支的原生续接点已失效，请重新创建分支'), { code: 'FORK_RESUME_MISMATCH' });
  }
  if (fork.resumeDropsTurn !== undefined && !UUID.test(fork.resumeDropsTurn)) throw Object.assign(Error('重试轮次保护标识无效'), { code: 'FORK_RESUME_MISMATCH' });
  return { forkSession: true, resumeSessionAt: fork.messageUuid, forkSessionId: fork.targetSessionId,
    ...(fork.resumeDropsTurn ? { resumeDropsTurn: fork.resumeDropsTurn } : {}) };
}
module.exports = { UUID, sessionContext, observeProvenance, applyProvenance, protectSdkMetadata, resolveStoredScope, pendingForkOptions };
