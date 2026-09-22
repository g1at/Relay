'use strict';


function registerSkillDraftIpc({
  ipcMain, getSkillDraftService, broadcastSkillDraftEvent,
  readSkillUsage, writeSkillUsage, getSkillMaintenanceHost, notifySkillUsageUpdated,
  reloadSkillsInLiveSessions, recordSkillActivity,
}) {

  async function skillDraftResult(fn, key = null) {
    try {
      if (!getSkillDraftService()) throw new Error('Skill 草稿服务不可用');
      const value = await fn();
      return key ? { ok: true, [key]: value } : { ok: true, data: value };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null, details: e.details || null };
    }
  }

  ipcMain.handle('skillDrafts:list', (_e, filter = {}) => skillDraftResult(
    () => getSkillDraftService().list(filter), 'items',
  ));
  ipcMain.handle('skillDrafts:diff', (_e, id) => skillDraftResult(
    () => getSkillDraftService().diff(id), 'diff',
  ));
  ipcMain.handle('skillDrafts:validate', (_e, id) => skillDraftResult(
    () => getSkillDraftService().validate(id), 'validation',
  ));
  ipcMain.handle('skillDrafts:rebase', async (_e, { id, options } = {}) => {
    const result = await skillDraftResult(() => getSkillDraftService().rebaseDraft(id, options || {}), 'result');
    if (result.ok) broadcastSkillDraftEvent('skillDraft.rebased', { draftId: id, result: result.result });
    return result;
  });
  ipcMain.handle('skillDrafts:publish', async (_e, id) => {
    const result = await skillDraftResult(() => getSkillDraftService().publish(id, published => {
      const draft = published && published.draft;
      try {
        if (draft && draft.skillName) {
          const sidecar = readSkillUsage();
          const record = sidecar[draft.skillName] || {};
          record.state = 'active';
          record.archivedAt = null;
          if (!record.firstSeenAt) record.firstSeenAt = new Date().toISOString();
          record.lastPatchedAt = new Date().toISOString();
          if (!record.createdBy && draft.sourceRef && draft.sourceRef.type === 'conversation-review') {
            record.createdBy = 'agent';
          }
          sidecar[draft.skillName] = record;
          writeSkillUsage(sidecar);
          getSkillMaintenanceHost().recordPublished(published);
          notifySkillUsageUpdated({ reason: 'draft-published', skillName: draft.skillName });
        }
      } catch (e) { console.warn('[skill-draft] 更新技能生命周期失败: %s', e.message); }
      broadcastSkillDraftEvent('skillDraft.published', { draftId: id, result: published });
    }), 'result');
    if (result.ok) result.liveReload = await reloadSkillsInLiveSessions('draft-published');
    return result;
  });
  ipcMain.handle('skillDrafts:reject', async (_e, { id, reason } = {}) => {
    const result = await skillDraftResult(() => getSkillDraftService().reject(id, reason), 'draft');
    if (result.ok) broadcastSkillDraftEvent('skillDraft.rejected', { draft: result.draft });
    return result;
  });
  ipcMain.handle('skillDrafts:history', (_e, skillName) => skillDraftResult(
    () => getSkillDraftService().listHistory(skillName), 'items',
  ));
  ipcMain.handle('skillDrafts:rollback', async (_e, { skillName, versionId, options } = {}) => {
    const result = await skillDraftResult(() => getSkillDraftService().rollback(skillName, versionId, options || {}, restored => {
      try {
        const sidecar = readSkillUsage();
        if (restored && restored.restored && restored.restored.exists) {
          const record = sidecar[skillName] || {};
          record.state = 'active';
          record.archivedAt = null;
          record.restoredAt = new Date().toISOString();
          sidecar[skillName] = record;
          recordSkillActivity(skillName, 'restored');
        } else {
          delete sidecar[skillName];
          getSkillMaintenanceHost().forget(skillName);
        }
        writeSkillUsage(sidecar);
        notifySkillUsageUpdated({ reason: 'history-rollback', skillName });
      } catch (e) { console.warn('[skill-draft] 回滚后生命周期同步失败: %s', e.message); }
      broadcastSkillDraftEvent('skillDraft.rolledBack', { skillName, versionId, result: restored });
    }), 'result');
    if (result.ok) result.liveReload = await reloadSkillsInLiveSessions('history-rollback');
    return result;
  });


}

module.exports = { registerSkillDraftIpc };
