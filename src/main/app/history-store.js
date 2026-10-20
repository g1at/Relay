'use strict';

const fs = require('fs');
const path = require('path');

function createHistoryStore({
  getUserDataDir, recoverLegacyOutput, canWrite = () => true,
}) {
  let HISTORY_DIR = null;
  function getHistoryDir() {
    if (!HISTORY_DIR) HISTORY_DIR = path.join(getUserDataDir(), 'history');
    if (!fs.existsSync(HISTORY_DIR)) { try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (_) {} }
    return HISTORY_DIR;
  }

  function historyIndexPath() { return path.join(getHistoryDir(), 'index.json'); }

  function convFilePath(id) {
    return path.join(getHistoryDir(), String(id).replace(/[^\w-]/g, '_') + '.json');
  }

  function writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function convMeta(c) {
    return {
      id: c.id,
      title: c.title,
      sessionId: c.sessionId || null,
      createdAt: c.createdAt || null,
      updatedAt: c.updatedAt || null,
      turnCount: Array.isArray(c.turns) ? c.turns.length : 0,
      kind: c.kind || 'chat',
      mode: c.mode || 'plain',
      fromScheduled: c.fromScheduled || null,
      pinned: !!c.pinned,
    };
  }

  function readHistoryIndex() {
    try {
      const d = JSON.parse(fs.readFileSync(historyIndexPath(), 'utf8'));
      if (d && Array.isArray(d.items)) return d.items;
    } catch (e) { console.warn('[history] 索引读取失败,将重建: %s', e.message); }
    return rebuildHistoryIndex();   // 缺失/损坏 → 扫正文重建(空库返回 [])
  }

  function writeHistoryIndex(items) {
    try { writeJsonAtomic(historyIndexPath(), { version: 2, items }); }
    catch (e) { console.error('[history] 索引写入失败:', e.message); }
  }

  function rebuildHistoryIndex() {
    const items = [];
    try {
      for (const name of fs.readdirSync(getHistoryDir())) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(getHistoryDir(), name), 'utf8'));
          if (c && c.id) items.push(convMeta(c));
        } catch (e) { console.error('[history] 会话文件解析失败,跳过:', name, e.message); }
      }
    } catch (_) {}
    writeHistoryIndex(items);
    return items;
  }

  function loadConversation(id) {
    try {
      const conversation = JSON.parse(fs.readFileSync(convFilePath(id), 'utf8'));
      try { return recoverLegacyOutput(conversation, { rootDir: path.join(getUserDataDir(), 'task-ledger') }); }
      catch (_) { return conversation; }
    } catch (e) {
      // 新会话尚未落盘、已删除会话仍被任务账本引用时，缺失正文是正常的查询结果。
      // 只容忍 ENOENT；权限、I/O 和 JSON 损坏仍需保留诊断。
      if (e.code !== 'ENOENT') console.warn('[history] 加载会话失败: %s id=%s', e.message, id);
      return null;
    }
  }

  function persistConversationRecord(conv) {
    if (!canWrite(conv?.id)) return false;
    writeJsonAtomic(convFilePath(conv.id), conv);
    const items = readHistoryIndex();
    const i = items.findIndex((m) => m.id === conv.id);
    if (i >= 0) items[i] = convMeta(conv); else items.unshift(convMeta(conv));
    writeHistoryIndex(items);
  }

  function removeConversationRecord(id, { loadRecord = true } = {}) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id) || id.toLowerCase() === 'index') {
      throw Object.assign(new Error('会话标识无效'), { code: 'INVALID_CONVERSATION_ID' });
    }
    // Ordinary deletion needs no transcript, legacy recovery, or global rebuild.
    const conversation = loadRecord ? loadConversation(id) : null;
    let index;
    try {
      index = JSON.parse(fs.readFileSync(historyIndexPath(), 'utf8'));
      if (!index || !Array.isArray(index.items)) throw new Error('历史索引格式无效');
    } catch (cause) {
      throw Object.assign(new Error('历史索引暂不可用，会话记录已保留'), { code: 'HISTORY_INDEX_UNAVAILABLE', cause });
    }
    const items = index.items;
    const sameId = value => value === id || (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      && typeof value === 'string' && value.toLowerCase() === id.toLowerCase());
    // Commit the small index first so a write failure cannot lose the body.
    // Both operations are synchronous: another history write cannot interleave
    // with the removal or its rollback. Filesystem workspaces are independent.
    writeJsonAtomic(historyIndexPath(), { version: 2, items: items.filter(item => !sameId(item.id)) });
    try { fs.rmSync(convFilePath(id), { force: true }); }
    catch (error) {
      try { writeJsonAtomic(historyIndexPath(), { version: 2, items }); }
      catch (rollbackError) {
        throw Object.assign(new Error(`删除会话历史失败，正文已保留，但恢复历史索引失败：${rollbackError.message}`), {
          code: 'HISTORY_DELETE_ROLLBACK_FAILED', cause: error, rollbackError,
        });
      }
      throw error;
    }
    return conversation;
  }

  function forEachConversation(fn) {
    const items = [...readHistoryIndex()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const m of items) {
      const c = loadConversation(m.id);
      if (!c) continue;
      if (fn(c) === false) return;
    }
  }

  function migrateHistoryV1() {
    const legacy = path.join(getUserDataDir(), 'history.json');
    if (!fs.existsSync(legacy)) return;
    try {
      const d = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      const convs = Array.isArray(d && d.conversations) ? d.conversations : [];
      let n = 0;
      for (const c of convs) {
        if (!c || !c.id || !canWrite(c.id)) continue;
        if (fs.existsSync(convFilePath(c.id))) continue;   // 上次迁移中断过 → 跳过已迁条目
        writeJsonAtomic(convFilePath(c.id), c);
        n++;
      }
      rebuildHistoryIndex();
      // 改名保底(不删)。.bak 已存在(极端:迁移后用户又放回一个 history.json)则带时间戳避让。
      const bak = legacy + '.bak';
      try { fs.renameSync(legacy, fs.existsSync(bak) ? `${legacy}.bak-${Date.now()}` : bak); } catch (_) {}
      console.log(`[history] v1 迁移完成:${n} 条会话已转为目录式存储`);
    } catch (e) {
      console.error('[history] v1 迁移失败(原文件保留,下次启动重试):', e.message);
    }
  }
  return { getHistoryDir, historyIndexPath, convFilePath, writeJsonAtomic, convMeta, readHistoryIndex, writeHistoryIndex, rebuildHistoryIndex, loadConversation, persistConversationRecord, removeConversationRecord, forEachConversation, migrateHistoryV1 };
}

module.exports = { createHistoryStore };
