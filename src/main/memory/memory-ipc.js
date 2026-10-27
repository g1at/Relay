'use strict';

const fs = require('fs');
const path = require('path');
const { memoryHealth, memoryHealthSummary } = require('./memory-health');

function registerMemoryIpc({
  ipcMain, shell, relayMemoryStore, MEMORY_DIR, MEMORY_INDEX,
  refreshSkillUsageInBackground, readMemoryUsage, memoryReadStats, flushMemoryUsage, rebuildMemoryIndex,
  getProjects, getLearningStatus, invalidateMemory,
}) {

  function memoryIpcError(error, extra = {}) {
    return { ok: false, message: error.message, error: error.message, code: error.code || null, ...extra };
  }

  function projectCatalog() {
    if (typeof getProjects !== 'function') return { projectCheck: { available: false, reason: null, skipped: true } };
    try {
      const projects = getProjects();
      if (!Array.isArray(projects) || projects.some((project) => !project || typeof project.id !== 'string' || !project.id.trim())) {
        throw new TypeError('Project catalog unavailable');
      }
      return { knownProjectIds: new Set(projects.map((project) => project.id)), projectCheck: { available: true, reason: null } };
    } catch (_) {
      return { projectCheck: { available: false, reason: '项目列表暂不可用，尚未检查项目归属；请稍后重试。' } };
    }
  }

  function memoryListResult(options = {}, { refreshUsage = true, readOnly = false } = {}) {
    try {
      options = options && typeof options === 'object' ? options : {};
      if (refreshUsage) refreshSkillUsageInBackground().catch(() => {});
      const archived = options.archived === true;
      const context = options.context || { projectId: options.projectId };
      const checkedAt = new Date().toISOString();
      const { knownProjectIds, projectCheck } = projectCatalog();
      const sidecar = readMemoryUsage();
      const readOptions = readOnly ? { readOnly: true } : {};
      const entries = archived ? relayMemoryStore.archived(readOptions) : relayMemoryStore.list({}, readOptions);
      const items = entries.map((entry) => {
        const { file, meta } = entry;
        const health = memoryHealth(entry, { context, knownProjectIds, archived, now: checkedAt });
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
          sources: meta.sources || [],
          replaces: meta.replaces || [],
          expiresAt: meta.expiresAt,
          supersedes: meta.supersedes,
          supersedesRevision: meta.supersedesRevision,
          eligible: health.state === 'active',
          health,
          schemaErrors: meta.schemaErrors,
          revision: entry.revision || null,
          mtime: entry.mtime || Date.parse(entry.createdAt) || 0,
          pinned: meta.core || !!(sidecar[file] && sidecar[file].pinned),
          pinnedInFile: meta.core,
          exposureCount: Math.max(0, Number(sidecar[file] && sidecar[file].exposureCount) || 0),
          readCount: Math.max(0, Number(usage.readCount) || 0),
          lastReadAt: usage.lastReadAt || null,
          archived,
          ...(archived ? { archiveId: entry.archiveId, archivedAt: entry.createdAt } : {}),
        };
      }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime || a.file.localeCompare(b.file));
      return { ok: true, items, summary: memoryHealthSummary(items), checkedAt, projectCheck,
        dir: MEMORY_DIR, hasIndex: fs.existsSync(MEMORY_INDEX), archived };
    } catch (error) { return memoryIpcError(error, { items: [] }); }
  }

  ipcMain.handle('memory:list', (_event, options) => memoryListResult(options));
  ipcMain.handle('memory:check', (_event, options) => memoryListResult(options, { refreshUsage: false, readOnly: true }));
  ipcMain.handle('memory:learningStatus', () => {
    try { return { ok: true, ...(typeof getLearningStatus === 'function' ? getLearningStatus() : {}) }; }
    catch (error) { return memoryIpcError(error); }
  });

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
      return { ok: true, file: result.file, status: result.meta.status, revision: result.revision,
        undoId: result.undoId, undoExpiresAt: result.undoExpiresAt };
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
      const { knownProjectIds, projectCheck } = projectCatalog();
      return { ok: true, ...entry, content: entry.content.replace(/^\uFEFF/, ''),
        health: memoryHealth(entry, { knownProjectIds }), projectCheck };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:write', (_event, { file, content, expectedRevision } = {}) => {
    try {
      const result = relayMemoryStore.write(file, content, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, revision: result.revision };
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

  ipcMain.handle('memory:purge', (_event, request) => {
    const { file, expectedArchiveId } = request || {};
    let result;
    try { result = relayMemoryStore.purgeArchived(file, { actor: 'user', expectedArchiveId }); }
    catch (error) { return memoryIpcError(error); }
    let warning;
    try {
      invalidateMemory?.(result.file);
      const usage = readMemoryUsage();
      for (const key of Object.keys(usage)) {
        if (key === file || process.platform === 'win32' && key.toLowerCase() === file.toLowerCase()) delete usage[key];
      }
      flushMemoryUsage({ strict: true });
      rebuildMemoryIndex({}, { strict: true });
    } catch (_) { warning = '记忆已永久删除，统计或索引刷新失败，请重新打开记忆页。'; }
    return { ok: true, ...result, ...(warning ? { warning } : {}) };
  });

  ipcMain.handle('memory:undo', (_event, { file, undoId, expectedRevision } = {}) => {
    try {
      const result = relayMemoryStore.undo(file, undoId, { actor: 'user', expectedRevision });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, revision: result.revision };
    } catch (error) { return memoryIpcError(error); }
  });

  ipcMain.handle('memory:restoreArchived', (_event, { file, archiveId } = {}) => {
    try {
      const result = relayMemoryStore.restoreArchived(file, archiveId, { actor: 'user', expectedRevision: null });
      rebuildMemoryIndex();
      return { ok: true, file: result.file, revision: result.revision };
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
