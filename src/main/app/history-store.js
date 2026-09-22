'use strict';

const fs = require('fs');
const path = require('path');

function createHistoryStore({
  getUserDataDir, recoverLegacyOutput,
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
    writeJsonAtomic(convFilePath(conv.id), conv);
    const items = readHistoryIndex();
    const i = items.findIndex((m) => m.id === conv.id);
    if (i >= 0) items[i] = convMeta(conv); else items.unshift(convMeta(conv));
    writeHistoryIndex(items);
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
        if (!c || !c.id) continue;
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
  return { getHistoryDir, historyIndexPath, convFilePath, writeJsonAtomic, convMeta, readHistoryIndex, writeHistoryIndex, rebuildHistoryIndex, loadConversation, persistConversationRecord, forEachConversation, migrateHistoryV1 };
}

module.exports = { createHistoryStore };
