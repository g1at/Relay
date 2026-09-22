'use strict';
const crypto = require('node:crypto');
const { executeSessionOperation, validateScope, UUID } = require('./sdk-session-history');
const { resolveStoredScope } = require('./sdk-session-provenance');
const activity = require('../../../renderer/activity-stream');
const err = (code, message) => Object.assign(Error(message), { code });
const clone = value => structuredClone(value);
const asDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString(); };
const contentText = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(b => b.type === 'text').map(b => b.text).join('\n');
function nativeTurns(messages) {
  const turns = []; let current = null, state = null;
  const finish = () => {
    if (!current || !state) return;
    // getSessionMessages is a transcript, not a live executor. Missing tool
    // results cannot establish success and must never leave history spinning.
    for (const item of state.items) if (['running', 'preparing'].includes(item.status)) {
      item.status = 'canceled'; item.detail = '原生记录未保存完成状态';
    }
    state.phase = state.error ? 'error' : current.assistant ? 'complete' : 'paused';
    state.startedAt = null; state.endedAt = null;
    current.activity = activity.serialize(state);
  };
  for (const message of messages) {
    if (message.parent_tool_use_id || message.agent_id) continue;
    const blocks = message.message?.content;
    const human = message.type === 'user' && !message.isMeta && (typeof blocks === 'string' || Array.isArray(blocks) && !blocks.some(b => b.type === 'tool_result'));
    if (human) {
      finish();
      current = { runId: crypto.randomUUID(), userMessageId: message.uuid, sdkUserMessageId: message.uuid,
        user: contentText(blocks), assistant: '', files: [], sdkImported: true, nativeMessageUuids: [], timestamp: message.timestamp || null };
      if (Array.isArray(blocks) && blocks.some(b => ['image', 'document'].includes(b.type))) current.user += '\n[原生记录包含附件；原始附件仍以原会话保存的文件为准]';
      turns.push(current); state = activity.createState();
    }
    if (!current) continue;
    if (UUID.test(message.uuid || '')) current.nativeMessageUuids.push(message.uuid);
    activity.ingest(state, message);
    if (message.type === 'assistant') current.assistant = contentText(blocks);
  }
  finish();
  return turns;
}
function mergeNativeHistory(record, messages) {
  const result = clone(record), candidates = nativeTurns(messages); let added = 0, repaired = 0;
  const known = new Set((result.turns || []).flatMap(t => [t.runId, t.userMessageId, t.sdkUserMessageId, ...(t.nativeMessageUuids || [])]).filter(Boolean));
  result.turns ||= [];
  for (const turn of candidates) {
    const existing = result.turns.find(t => t.userMessageId === turn.userMessageId || t.sdkUserMessageId === turn.userMessageId || t.runId === turn.userMessageId);
    if (existing) {
      if (!existing.assistant && !existing.error && !existing.failure && !existing.activity?.error && turn.assistant) { existing.assistant = turn.assistant; repaired++; }
      if (!existing.activity) existing.activity = turn.activity;
      existing.nativeMessageUuids = [...new Set([...(existing.nativeMessageUuids || []), ...turn.nativeMessageUuids])];
    } else if (!known.has(turn.userMessageId)) { result.turns.push(turn); added++; }
    for (const id of turn.nativeMessageUuids) known.add(id);
  }
  // Repair is never activity and never changes local title, pin or timestamps.
  return { record: result, added, repaired };
}
function createHistoryManagement({ resolveWorkspaceScope, load, list, save, isBusy, execute = executeSessionOperation } = {}) {
  const pending = new Map(), renameQueue = new Map();
  const sameScope = (a, b) => a?.sessionId === b?.sessionId && a?.cwd === b?.cwd && a?.configDir === b?.configDir
    && (a?.agentEnvironment || 'native') === (b?.agentEnvironment || 'native') && (a?.wslDistribution || '') === (b?.wslDistribution || '');
  async function messages(scope) {
    const all = [], seen = new Set();
    for (let offset = 0; offset < 20000; offset += 100) {
      const page = await execute(scope, 'getSessionMessages', { limit: 100, offset });
      for (const row of page) if (!seen.has(row.uuid)) { seen.add(row.uuid); all.push(row); }
      if (page.length < 100) return all;
    }
    throw err('SESSION_HISTORY_TOO_LARGE', '原生记录超过 20000 条，请先按轮次查看，不会导入不完整的会话。');
  }
  async function exclusive(key, work) {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(work); pending.set(key, promise);
    try { return await promise; } finally { if (pending.get(key) === promise) pending.delete(key); }
  }
  async function getScope(id) { const record = await load(id); if (!record) throw err('SESSION_NOT_FOUND', '对话不存在'); return { record, scope: validateScope(resolveStoredScope(record)) }; }
  return {
    async list(input = {}) {
      const scope = validateScope(await resolveWorkspaceScope(input), { listing: true });
      const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      const items = await execute(scope, 'listSessions', { limit: 31, offset });
      return { ok: true, items: items.slice(0, 30).map(x => ({ sessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || '原生会话', updatedAt: asDate(x.lastModified), cwd: x.cwd })), nextOffset: items.length > 30 ? offset + 30 : null };
    },
    async inspect(id) {
      const { record, scope } = await getScope(id);
      const info = await execute(scope, 'getSessionInfo');
      return { ok: true, available: !!info, localTurns: record.turns?.length || 0, scope: { sessionId: scope.sessionId, cwd: scope.cwd, environment: scope.agentEnvironment },
        message: info ? '原生记录可读取；修复只补充缺失内容，保留 Relay 的错误、附件和名称。' : '原生记录已不存在，Relay 本地历史仍保留。' };
    },
    import(input) { return exclusive('import:' + input.sessionId, async () => {
      if (!UUID.test(input.sessionId || '')) throw err('SESSION_SCOPE_INVALID', '原生会话标识无效');
      const scope = validateScope({ ...await resolveWorkspaceScope(input), sessionId: input.sessionId });
      const info = await execute(scope, 'getSessionInfo'); if (!info) throw err('SESSION_NOT_FOUND', '在所选工作目录中未找到原生记录');
      for (const meta of await list()) { const existing = await load(meta.id); if (sameScope(existing?.sdkSessionContext, scope)) return { ok: true, id: existing.id, reused: true }; }
      const turns = nativeTurns(await messages(scope));
      const record = { id: crypto.randomUUID(), title: String(info.customTitle || info.summary || info.firstPrompt || '导入的会话').slice(0, 128),
        titleGenerated: true, titleManual: !!info.customTitle, mode: 'plain', kind: 'chat', turns, pinned: false,
        createdAt: asDate(info.createdAt || info.lastModified), updatedAt: asDate(info.lastModified),
        workingDir: { path: scope.hostCwd || scope.cwd }, projectId: scope.projectId || null,
        sessionId: scope.sessionId, sdkSessionContext: scope, sdkImported: true };
      await save(record); return { ok: true, id: record.id, turns: turns.length };
    }); },
    repair(id) { return exclusive('repair:' + id, async () => {
      if (isBusy(id)) throw err('SESSION_BUSY', '请先等待当前任务结束');
      const { record, scope } = await getScope(id), before = JSON.stringify(record);
      const merged = mergeNativeHistory(record, await messages(scope));
      if (isBusy(id) || JSON.stringify(await load(id)) !== before) throw err('SESSION_HISTORY_STALE', '对话已变化，请重新检查后再修复');
      await save(merged.record); return { ok: true, added: merged.added, repaired: merged.repaired };
    }); },
    rename(id, title) {
      const work = (renameQueue.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
        const { scope } = await getScope(id); await execute(scope, 'renameSession', { title }); return { ok: true };
      });
      renameQueue.set(id, work); work.finally(() => { if (renameQueue.get(id) === work) renameQueue.delete(id); }).catch(() => {});
      return work;
    },
    deleteNative(id) { return exclusive('delete:' + id, async () => {
      if (isBusy(id)) throw err('SESSION_BUSY', '任务运行中不能删除原生记录');
      const { scope } = await getScope(id);
      for (const meta of await list()) if (meta.id !== id) {
        const other = await load(meta.id);
        const refs = [other?.sdkSessionContext, ...(other?.turns || []).map(t => t.sdkSessionContext)];
        if (refs.some(ref => sameScope(ref, scope))) throw err('SESSION_SHARED', '另一条 Relay 对话仍引用这份原生记录，无法删除');
      }
      if (isBusy(id) || !sameScope((await getScope(id)).scope, scope)) throw err('SESSION_HISTORY_STALE', '对话已变化，请重新检查');
      await execute(scope, 'deleteSession'); // Local Relay data is not deleted.
      return { ok: true, localHistoryRetained: true };
    }); },
  };
}
module.exports = { nativeTurns, mergeNativeHistory, createHistoryManagement };
