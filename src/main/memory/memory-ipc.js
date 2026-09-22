'use strict';

const fs = require('fs');
const path = require('path');
const { memoryEligibility } = require("./memory-schema");

function registerMemoryIpc({
  ipcMain, shell, relayMemoryStore, MEMORY_DIR, MEMORY_INDEX,
  refreshSkillUsageInBackground, readMemoryUsage, memoryReadStats, flushMemoryUsage, rebuildMemoryIndex,
}) {

  function memoryIpcError(error, extra = {}) {
    return { ok: false, message: error.message, error: error.message, code: error.code || null, ...extra };
  }

  function memoryListResult(options = {}) {
    try {
      options = options && typeof options === 'object' ? options : {};
      refreshSkillUsageInBackground().catch(() => {});
      const archived = options.archived === true;
      const context = options.context || { projectId: options.projectId };
      const sidecar = readMemoryUsage();
      const entries = archived ? relayMemoryStore.archived() : relayMemoryStore.list();
      const items = entries.map((entry) => {
        const { file, meta } = entry;
        const usage = memoryReadStats(file) || {};
        return {
          file,
          name: meta.name || file.replace(/\.md$/i, ''),
          description: meta.description,
          type: meta.type,
          scope: meta.scope,
          projectId: meta.projectId,
          status: archived ? 'archived' : meta.status,
          confidence: meta.confidence,
          sourceRef: meta.sourceRef,
          expiresAt: meta.expiresAt,
          supersedes: meta.supersedes,
          supersedesRevision: meta.supersedesRevision,
          eligible: !archived && memoryEligibility(meta, context).eligible,
          schemaErrors: meta.schemaErrors,
          revision: entry.revision || null,
          mtime: entry.mtime || Date.parse(entry.createdAt) || 0,
          pinned: meta.core || !!(sidecar[file] && sidecar[file].pinned),
          pinnedInFile: meta.core,
          exposureCount: Math.max(0, Number(sidecar[file] && sidecar[file].exposureCount) || 0),
          readCount: Math.max(0, Number(usage.readCount) || 0),
          lastReadAt: usage.lastReadAt || null,
          archived,
          ...(archived ? { versionId: entry.versionId, archivedAt: entry.createdAt } : {}),
        };
      }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime || a.file.localeCompare(b.file));
      return { ok: true, items, dir: MEMORY_DIR, hasIndex: fs.existsSync(MEMORY_INDEX), archived };
    } catch (error) { return memoryIpcError(error, { items: [] }); }
  }

  ipcMain.handle('memory:list', (_event, options) => memoryListResult(options));

  ipcMain.handle('memory:archived', () => {
    try { return { ok: true, items: relayMemoryStore.archived() }; }
    catch (error) { return memoryIpcError(error, { items: [] }); }
  });

  ipcMain.handle('memory:setPinned', (_event, { file, pinned } = {}) => {
    try {
      const entry = relayMemoryStore.read(file);
      const usage = readMemoryUsage();
      const record = usage[entry.file] && typeof usage[entry.file] === 'object' ? usage[entry.file] : {};
      record.pinned = !!pinned;
      usage[entry.file] = record;
      flushMemoryUsage();
      rebuildMemoryIndex();
      return { ok: true, pinned: record.pinned };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:setStatus', (_event, { file, status, expectedRevision } = {}) => {
    try {
      const result = relayMemoryStore.setStatus(file, status, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, status: result.meta.status, revision: result.revision, versionId: result.versionId };
    } catch (error) { return memoryIpcError(error); }
  });

  // 生成索引只供宿主 UI 查看；模型的 MemoryStore.read 不允许访问 MEMORY.md。
  ipcMain.handle('memory:read', (_event, file) => {
    try {
      if (typeof file === 'string' && file.toLowerCase() === 'memory.md') {
        const { indexLines } = rebuildMemoryIndex();
        return { ok: true, file: 'MEMORY.md', content: indexLines.length ? indexLines.join('\n') + '\n' : '', revision: null, generated: true };
      }
      const entry = relayMemoryStore.read(file, { actor: 'user' });
      return { ok: true, ...entry, content: entry.content.replace(/^\uFEFF/, '') };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:write', (_event, { file, content, expectedRevision } = {}) => {
    try {
      const result = relayMemoryStore.write(file, content, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, revision: result.revision, versionId: result.versionId };
    } catch (error) { return memoryIpcError(error); }
  });

  // 移除会归档正文，保留使用统计，恢复后继续沿用原有固定状态与统计。
  ipcMain.handle('memory:remove', (_event, request) => {
    try {
      const { file, expectedRevision } = typeof request === 'string' ? { file: request } : (request || {});
      const result = relayMemoryStore.archive(file, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, ...result };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:history', (_event, file) => {
    try { return { ok: true, items: relayMemoryStore.history(file, { actor: 'user' }) }; }
    catch (error) { return memoryIpcError(error, { items: [] }); }
  });

  ipcMain.handle('memory:restore', (_event, { file, versionId, expectedRevision } = {}) => {
    try {
      const result = relayMemoryStore.restore(file, versionId, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, revision: result.revision, versionId: result.versionId };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:revealFile', (_event, file) => {
    try {
      const entry = relayMemoryStore.read(file, { actor: 'user' });
      shell.showItemInFolder(path.join(MEMORY_DIR, entry.file));
      return { ok: true };
    } catch (error) { return memoryIpcError(error); }
  });


}

module.exports = { registerMemoryIpc };
