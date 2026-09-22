'use strict';

const fs = require('fs');

// Disk access, project projection and native title sync remain separate services.
function registerHistoryIpc({
  ipcMain, history, projects, nativeHistory, isMiniChatActive,
  saveConversation, deleteConversation, genId, protectSdkMetadata,
}) {
  const { readHistoryIndex, loadConversation, persistConversationRecord, convFilePath, forEachConversation } = history;
  ipcMain.handle('history:list', () => {
    projects.initialize();
    // 列表只读索引,零正文 IO(v2 目录式存储的核心收益)
    return readHistoryIndex().map(m => ({
      id: m.id,
      title: m.title,
      sessionId: m.sessionId,
      projectId: projects.getStore().binding(m.id) || null,
      updatedAt: m.updatedAt,
      turnCount: m.turnCount || 0,
      kind: m.kind || 'chat',   // 'chat'=普通对话 / 'create'=AI 创作,前端据此切换视图与图标
      mode: m.mode || 'plain',  // 'plain'=普通 / 'agent'=Agent 对话,前端据此选图标
      fromScheduled: m.fromScheduled || null,  // 定时任务产出的会话,前端用时钟图标
      pinned: !!m.pinned,       // 置顶标记:列表里排在最前
    })).sort((a, b) => {
      // 置顶优先;同组内按更新时间倒序
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  });

  // 置顶/取消置顶一条会话。只改 pinned 标记,不动 updatedAt(避免影响"最近更新"语义)。
  //   pinned 写进正文而非只改索引 —— 索引可由正文完整重建,这个不变量不能破。
  ipcMain.handle('history:setPinned', (_e, { id, pinned } = {}) => {
    const c = loadConversation(id);
    if (!c) return { ok: false };
    c.pinned = !!pinned;
    saveConversation(c);
    return { ok: true, pinned: c.pinned };
  });

  // IPC: 手动重命名会话。仿 setPinned:只改字段、不刷 updatedAt(重命名不该把会话顶到列表最前)。
  //   titleManual 标记「用户手动起的名」——渲染层的 AI 摘要标题回写前会检查它,防止覆盖手动命名。
  //   返回 c.title(saveConversation 收口后的值,可能被截到 64 视觉宽),渲染层以它回显。
  ipcMain.handle('history:rename', (_e, { id, title } = {}) => {
    const t = String(title || '').trim();
    if (!t) return { ok: false };
    const c = loadConversation(id);
    if (!c) return { ok: false };
    c.title = t;
    c.titleGenerated = true;
    c.titleManual = true;
    saveConversation(c);
    if (c.sdkSessionContext) void nativeHistory.getManagement().rename(id, c.title).then(() => {
      const latest = loadConversation(id); if (latest?.title !== c.title) return;
      latest.sdkTitleSync = 'synced'; persistConversationRecord(latest);
    }).catch(() => {
      const latest = loadConversation(id); if (latest?.title !== c.title) return;
      latest.sdkTitleSync = 'pending'; persistConversationRecord(latest);
    });
    return { ok: true, title: c.title };
  });

  ipcMain.handle('history:load', (_e, id) => projects.projectConversation(loadConversation(id)));

  ipcMain.handle('history:save', (_e, conv) => {
    if (isMiniChatActive(conv.id)) {
      return { error: '这个对话正在快捷小窗中运行，请在小窗中继续补充要求。', code: 'MINI_TURN_ACTIVE' };
    }
    const now = new Date().toISOString();
    if (!conv.id) conv.id = genId();
    if (!conv.createdAt) conv.createdAt = now;
    conv.updatedAt = now;
    // 置顶由专用 setPinned 入口维护；运行中旧快照整存不能撤销最新的置顶操作。
    // 正文是权威来源，避免索引暂未同步时读回旧标记；新记录保留初始化值。
    const existing = fs.existsSync(convFilePath(conv.id)) ? loadConversation(conv.id) : null;
    if (existing) conv.pinned = !!existing.pinned;
    protectSdkMetadata(conv, existing);
    conv = projects.projectConversation(conv);
    saveConversation(conv);
    return { id: conv.id, updatedAt: conv.updatedAt, projectId: conv.projectId || null,
      permissionMode: conv.permissionMode, permissionRevision: conv.permissionRevision,
      permissionLegacyPlan: conv.permissionLegacyPlan, executionMode: conv.executionMode };
  });

  ipcMain.handle('history:delete', (_e, id) => {
    deleteConversation(id);
    return { ok: true };
  });

  // 会话全文搜索:在标题 + 对话正文(chat 的 user/assistant、create 的 prompt)里
  //   做大小写不敏感子串匹配。目录式存储下按 updatedAt 新→旧逐文件扫描,凑满 cap 即提前停 ——
  //   扫描序与结果序一致,无需再排序。个人量级(几百会话)全扫也在毫秒级,无需 DB/FTS5。
  //   返回命中会话 {id,title,kind,mode,fromScheduled,updatedAt,snippet,matchField},按 updatedAt 倒序。
  ipcMain.handle('history:search', (_e, { query, limit } = {}) => {
    const q = String(query || '').trim();
    if (!q) return { ok: true, items: [] };
    const qLower = q.toLowerCase();
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // 在一段文本里找命中,返回前后约 30 字的片段 + 用 \x00…\x01 包裹命中词(前端转 <mark>)
    const SNIP = 30;
    const makeSnippet = (text) => {
      const t = String(text || '');
      const idx = t.toLowerCase().indexOf(qLower);
      if (idx < 0) return null;
      const start = Math.max(0, idx - SNIP);
      const end = Math.min(t.length, idx + q.length + SNIP);
      let s = t.slice(start, end);
      // 在片段内把命中词(可能多处)用哨兵包裹
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s = s.replace(re, (m) => '\x00' + m + '\x01');
      return (start > 0 ? '…' : '') + s + (end < t.length ? '…' : '');
    };

    const results = [];
    try {
      forEachConversation((c) => {
        const kind = c.kind || 'chat';
        let snippet = null, matchField = null;
        // 命中正文时记下定位:turnIndex = 命中所在 turn 的下标;matchSide = 命中在该 turn 的哪一侧
        //   (user / assistant / prompt),供前端打开会话后精确滚动到那条消息。标题命中则保持 null。
        let turnIndex = null, matchSide = null;
        // 标题
        if ((c.title || '').toLowerCase().includes(qLower)) { snippet = makeSnippet(c.title); matchField = 'title'; }
        // 正文(首条命中即可)
        if (!snippet) {
          const turns = c.turns || [];
          for (let ti = 0; ti < turns.length; ti++) {
            const t = turns[ti];
            const fields = kind === 'create' ? [['prompt', t.prompt]] : [['user', t.user], ['assistant', t.assistant]];
            for (const [side, f] of fields) {
              if (f && String(f).toLowerCase().includes(qLower)) {
                snippet = makeSnippet(f); matchField = 'body'; turnIndex = ti; matchSide = side; break;
              }
            }
            if (snippet) break;
          }
        }
        if (snippet) {
          results.push({
            id: c.id, title: c.title || '未命名', kind, mode: c.mode || 'plain',
            fromScheduled: c.fromScheduled || null, updatedAt: c.updatedAt || c.createdAt || '',
            snippet, matchField, turnIndex, matchSide,
          });
        }
        return results.length < cap;   // 凑满即提前终止扫描
      });
    } catch (_) { return { ok: true, items: [] }; }
    return { ok: true, items: results };
  });


}

module.exports = { registerHistoryIpc };
