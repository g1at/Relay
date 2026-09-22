'use strict';
const crypto = require('node:crypto');
const { UUID, resolveStoredScope } = require('./sdk-session-provenance');
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => Object.assign(Error(message), { code });
function createSessionForkService({ loadConversation, persistConversation, execute, isBusy = () => false, validateSource = () => {},
  decorate = value => value, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }) {
  const pending = new Map();
  async function create(input = {}) {
    if (typeof input.conversationId !== 'string' || !/^[\w-]{1,160}$/.test(input.conversationId)) throw fail('INVALID_CONVERSATION', '对话标识无效');
    const key = JSON.stringify([input.conversationId, input.runId || null, input.redo === true]);
    if (pending.has(key)) return pending.get(key);
    const operation = createFork(input).finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  }
  async function createFork({ conversationId, runId, redo = false } = {}) {
    const source = loadConversation(conversationId);
    if (!source || source.kind === 'create') throw fail('CONVERSATION_NOT_FOUND', '这个对话无法创建原生分支');
    if (isBusy(conversationId)) throw fail('CONVERSATION_BUSY', '请等待当前对话完成或暂停后创建分支');
    if (source.pendingSdkFork) throw fail('FORK_NOT_STARTED', '请先运行这个分支，再从中创建分支');
    const scope = resolveStoredScope(source, runId);
    if (!scope.routing && scope.sessionId !== source.sdkSessionContext?.sessionId) throw fail('FORK_ROUTE_UNAVAILABLE', '这一轮未记录原服务商路由，无法安全创建精确分支');
    await validateSource(scope);
    const turns = source.turns || [];
    const selectedIndex = runId ? turns.findIndex(turn => turn.runId === runId) : turns.length - 1;
    if (redo && (!runId || selectedIndex < 1 || selectedIndex !== turns.length - 1)) throw fail('FORK_REDO_UNAVAILABLE', '仅能从有完整前一轮记录的最后一轮创建重试分支');
    const index = redo ? selectedIndex - 1 : selectedIndex;
    const point = runId ? turns[index]?.sdkForkPoint : null;
    const dropsTurn = redo ? turns[selectedIndex]?.userMessageId || turns[selectedIndex]?.sdkUserMessageId || turns[selectedIndex]?.runId : null;
    if (redo && (!UUID.test(dropsTurn || '') || turns[index]?.sdkSessionContext?.sessionId !== scope.sessionId)) throw fail('FORK_REDO_UNAVAILABLE', '这轮之前的运行上下文已改变，无法安全重试');
    if (runId && (!point || !UUID.test(point))) throw fail('FORK_POINT_UNAVAILABLE', '该轮尚未记录完整的原生续接点');
    const info = await execute(scope, 'getSessionInfo', {});
    if (!info) throw fail('SDK_HISTORY_EXPIRED', '原生会话记录已过期或已删除，无法创建精确分支');
    if (point) {
      let found = false;
      for (let offset = 0; offset < 10000; offset += 100) {
        const messages = await execute(scope, 'getSessionMessages', { offset, limit: 100 });
        if (messages.some(message => message.uuid === point && message.session_id === scope.sessionId)) { found = true; break; }
        if (messages.length < 100) break;
      }
      if (!found) throw fail('FORK_POINT_EXPIRED', '原生消息已被压缩或删除，无法从这一轮精确续接');
    }
    const latest = loadConversation(conversationId);
    if (!latest || isBusy(conversationId) || JSON.stringify(resolveStoredScope(latest, runId)) !== JSON.stringify(scope)
        || latest.turns?.length !== turns.length) throw fail('FORK_SOURCE_CHANGED', '原会话已发生变化，请重新创建分支');
    const id = newId(), createdAt = now();
    const title = `${String(latest.title || '对话').slice(0, 72)} · 分支`;
    let nativeId, materialized = false;
    if (point) nativeId = newId();
    else { const fork = await execute(scope, 'forkSession', { title }); nativeId = fork?.sessionId; materialized = true; }
    if (!UUID.test(nativeId || '') || nativeId === scope.sessionId) throw fail('INVALID_FORK_RESULT', 'SDK 未返回独立的分支会话');
    const result = clone(latest);
    // Project decoration must resolve the selected turn's directory, never
    // overwrite it with a project the source conversation moved to later.
    const directoryKey = value => {
      const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
      return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    const currentDirectory = typeof latest.workingDir === 'string' ? latest.workingDir : latest.workingDir?.path;
    if (scope.routing && Object.hasOwn(scope.routing, 'projectId')) result.projectId = scope.routing.projectId || null;
    else if (directoryKey(currentDirectory) !== directoryKey(scope.hostCwd || scope.cwd)) result.projectId = null;
    Object.assign(result, { id, title, titleManual: true, titleGenerated: true, pinned: false,
      createdAt, updatedAt: createdAt, sessionId: point ? scope.sessionId : nativeId,
      executionMode: latest.executionMode?.kind === 'plan' ? { kind: 'plan' } : { kind: 'default' },
      workingDir: { path: scope.hostCwd || scope.cwd, name: '原对话工作目录' },
      sdkSessionContext: { ...scope, sessionId: point ? scope.sessionId : nativeId },
      forkedFrom: { conversationId, runId: runId || null, sessionId: scope.sessionId, messageUuid: point, sharesFiles: true },
      turns: latest.turns.slice(0, index + 1).map(turn => ({ ...clone(turn), runId: newId(), forkedFromRunId: turn.runId,
        status: turn.status === 'running' ? 'completed' : turn.status })),
    });
    for (const field of ['goalRecovery', 'contextUsage', 'sdkTaskResources', 'carryContextOnNextTurn', 'pendingSdkFork', 'paused']) delete result[field];
    // A branch shares the source files without silently turning its managed
    // workspace into a new project (which would change the SDK policy scope).
    if (!result.projectId) result.sdkForkWorkspace = { path: scope.hostCwd || scope.cwd };
    else delete result.sdkForkWorkspace;
    if (scope.routing) {
      const route = scope.routing;
      Object.assign(result, { sessionProviderId: route.providerId, sessionProviderRevision: route.providerRevision,
        sessionAgentEnvironment: route.agentEnvironment, sessionRouteTier: route.routeTier, sessionModel: route.routeTier,
        model: route.routeTier, sessionEffort: route.effort, effort: route.effort,
        sdkRuntimeFingerprint: route.runtimeFingerprint, mode: route.mode || source.mode, agent: route.agentName || null });
      if (route.runtimeFingerprintVersion) result.sdkRuntimeFingerprintVersion = route.runtimeFingerprintVersion;
      else delete result.sdkRuntimeFingerprintVersion;
    }
    if (point) result.pendingSdkFork = { sourceSessionId: scope.sessionId, targetSessionId: nativeId, messageUuid: point,
      ...(redo ? { resumeDropsTurn: dropsTurn } : {}) };
    try {
      await validateSource(scope);
      const changed = loadConversation(conversationId);
      if (!changed || isBusy(conversationId) || changed.sessionId !== latest.sessionId || changed.turns?.length !== turns.length
          || changed.pendingSdkFork || JSON.stringify(resolveStoredScope(changed, runId)) !== JSON.stringify(scope)
          || runId && changed.turns[index]?.sdkForkPoint !== point) throw fail('FORK_SOURCE_CHANGED', '原会话已发生变化，请重试');
      persistConversation(decorate(result));
    } catch (error) {
      if (materialized) try { await execute({ ...scope, sessionId: nativeId }, 'deleteSession', {}); } catch (_) {}
      throw error;
    }
    return { ok: true, conversationId: id, pendingNativeFork: !!point, sharesFiles: true,
      ...(redo ? { prefill: String(turns[selectedIndex]?.user || ''), files: clone(turns[selectedIndex]?.files || []) } : {}) };
  }
  return { create };
}
module.exports = { createSessionForkService };
