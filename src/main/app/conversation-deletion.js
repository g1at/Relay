'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id);
}
function canonicalId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
}
function failure(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}
function detail(error) { return String(error?.message || error?.error || error || '未知错误'); }
function retainedScratchWarning(retained) {
  return { code: 'CONVERSATION_SCRATCH_RETAINED',
    message: '会话已删除，临时文件已保留。',
    retentionReason: retained.reason,
    ...(retained.causeCode ? { causeCode: retained.causeCode } : {}),
    ...(retained.relatedConversationId ? { relatedConversationId: retained.relatedConversationId } : {}) };
}

// Deletion owns a durable write/admission barrier. Only idle executors may be
// closed here; active work must finish or be paused explicitly by the user.
function createConversationDeletion({
  statePath, stopConversation, removeScratch, removeHistory, afterDelete,
  isRunning = () => false, fileSystem = fs,
} = {}) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) throw new TypeError('会话删除状态路径必须是绝对路径');
  for (const [name, callback] of Object.entries({ isRunning, stopConversation, removeScratch, removeHistory })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} 必须是函数`);
  }
  let records = null;
  const pending = new Map();

  function read() {
    if (records) return records;
    let saved;
    try { saved = JSON.parse(fileSystem.readFileSync(statePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { records = Object.create(null); return records; }
      throw failure('CONVERSATION_DELETION_STATE_UNAVAILABLE', `无法读取会话删除状态：${detail(error)}`, error);
    }
    if (!saved || saved.version !== 1 || !saved.items || typeof saved.items !== 'object' || Array.isArray(saved.items)
      || Object.entries(saved.items).some(([id, item]) => !validId(id) || !item || !['deleting', 'deleted'].includes(item.status))) {
      throw failure('CONVERSATION_DELETION_STATE_UNAVAILABLE', '会话删除状态格式无效，暂不能修改会话');
    }
    records = Object.create(null);
    for (const [id, item] of Object.entries(saved.items)) {
      const key = canonicalId(id);
      if (records[key]?.status !== 'deleted') records[key] = item;
    }
    return records;
  }

  function persist(next) {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    let descriptor = null;
    try {
      fileSystem.mkdirSync(path.dirname(statePath), { recursive: true });
      descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, JSON.stringify({ version: 1, items: next }, null, 2), 'utf8');
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor); descriptor = null;
      fileSystem.renameSync(temporary, statePath);
      records = next;
    } catch (error) {
      throw failure('CONVERSATION_DELETION_STATE_WRITE_FAILED', `无法保存会话删除状态：${detail(error)}`, error);
    } finally {
      if (descriptor !== null) { try { fileSystem.closeSync(descriptor); } catch (_) {} }
      try { fileSystem.unlinkSync(temporary); } catch (_) {}
    }
  }

  function assertAvailable(id) {
    if (!validId(id)) throw failure('INVALID_CONVERSATION_ID', '会话标识无效');
    id = canonicalId(id);
    const item = read()[id];
    if (item?.status === 'deleted') throw failure('CONVERSATION_DELETED', '这条会话已删除，请新建会话');
    if (item) throw failure('CONVERSATION_DELETING', '这条会话正在删除或等待重试，请完成删除后新建会话');
  }
  function canWrite(id) {
    try { assertAvailable(id); return true; } catch (_) { return false; }
  }
  function assertIdle(id) {
    let running;
    try {
      running = isRunning(id);
      // This check and the admission barrier must share one synchronous turn.
      if (typeof running !== 'boolean') {
        if (running && typeof running.then === 'function') Promise.resolve(running).catch(() => {});
        throw new TypeError('运行状态检查必须同步返回布尔值');
      }
    } catch (error) {
      throw failure('CONVERSATION_RUNNING_STATE_UNAVAILABLE', '暂时无法确认任务状态，请稍后再试。', error);
    }
    if (running) throw failure('CONVERSATION_RUNNING', '任务正在运行，请等待完成或手动暂停后再删除。');
  }
  function rejected(id, error) {
    return { ok: false, id, code: error.code || 'CONVERSATION_DELETE_FAILED', error: detail(error),
      retryable: !['INVALID_CONVERSATION_ID', 'CONVERSATION_RUNNING'].includes(error.code),
      ...(error.cause?.code ? { causeCode: error.cause.code } : {}) };
  }
  async function step(callback, id, code, message) {
    try {
      const result = await callback(id);
      if (result?.ok === false) throw failure(result.code || code, detail(result));
      return result;
    } catch (error) { throw failure(code, `${message}：${detail(error)}`, error); }
  }

  async function perform(id, canReleaseProtectedBarrier) {
    const warnings = [];
    let cleanupStarted = false;
    try {
      assertIdle(id);
      const stopped = await step(stopConversation, id, 'CONVERSATION_STOP_FAILED', '释放空闲会话执行器失败');
      if (stopped?.stopConfirmed !== true) throw failure('CONVERSATION_STOP_UNCONFIRMED', '执行器尚未确认停止，已保留历史和临时目录，请稍后重试删除');
      cleanupStarted = true;
      const cleaned = await step(removeScratch, id, 'CONVERSATION_SCRATCH_DELETE_FAILED', '删除会话临时目录失败，已保留历史');
      if (cleaned?.retained === true) throw failure('CONVERSATION_SCRATCH_DELETE_FAILED', '会话临时目录尚未删除，已保留历史，请重试');
      if (cleaned && Array.isArray(cleaned.removedPaths)) {
        // Keep completed paths across an index-write failure. Retrying still
        // rechecks shutdown and the target's remaining scratch locations.
        const previous = read()[id]?.fileCleanup?.removedPaths || [];
        const fileCleanup = { removedPaths: [...new Set([...previous, ...cleaned.removedPaths])] };
        const { scratchRetained: obsoleteRetention, ...record } = read()[id];
        persist(Object.assign(Object.create(null), read(), { [id]: { ...record, fileCleanup } }));
      }
      await step(removeHistory, id, 'CONVERSATION_HISTORY_DELETE_FAILED', '删除会话历史失败');
    } catch (error) {
      const runningError = [error, error.cause].find(item =>
        ['CONVERSATION_RUNNING', 'CONVERSATION_RUNNING_STATE_UNAVAILABLE'].includes(item?.code));
      if (runningError && !cleanupStarted) {
        // A change while waiting for migration must not cancel active work or
        // strand a fresh conversation behind a deletion tombstone.
        if (canReleaseProtectedBarrier) {
          const restored = Object.assign(Object.create(null), read());
          delete restored[id];
          try { persist(restored); } catch (restoreError) { return rejected(id, restoreError); }
        }
        return rejected(id, runningError);
      }
      const protection = error.code === 'CONVERSATION_SCRATCH_DELETE_FAILED' && error.cause;
      if (canReleaseProtectedBarrier && ['SCRATCH_CLEANUP_PROTECTED', 'CONVERSATION_FILES_NOT_OWNED'].includes(protection?.code) && protection.cleanupUnchanged === true) {
        // A preflight refusal has not removed a file or history. Let the user
        // reopen the conversation to correct its directory binding, including on restart.
        // Never apply this to retries of an earlier possibly partial deletion.
        const restored = Object.assign(Object.create(null), read());
        delete restored[id];
        try { persist(restored); }
        catch (restoreError) { return rejected(id, restoreError); }
        return { ...rejected(id, protection), conversationAvailable: true,
          protectionReason: protection.protectionReason, relatedConversationId: protection.conversationId };
      }
      return rejected(id, error);
    }

    // The history is now gone. Failures from here are cleanup warnings, never a
    // claim that the history was preserved. The earlier on-disk barrier survives
    // even if writing the final tombstone fails, so restart cannot revive it.
    const completed = Object.assign(Object.create(null), read(), {
      [id]: { ...records[id], status: 'deleted', deletedAt: new Date().toISOString() },
    });
    try { persist(completed); }
    catch (error) { records = completed; warnings.push({ code: error.code, message: detail(error) }); }
    if (typeof afterDelete === 'function') {
      try { await step(afterDelete, id, 'CONVERSATION_DELETE_CLEANUP_FAILED', '会话已删除，附加清理失败'); }
      catch (error) { warnings.push({ code: error.code, message: detail(error) }); }
    }
    return { ok: true, id, deleted: true, ...(read()[id]?.fileCleanup ? { fileCleanup: read()[id].fileCleanup } : {}), ...(warnings.length ? { cleanupWarning: warnings.map(item => item.message).join('；'), warnings } : {}) };
  }

  function deleteConversation(id) {
    if (!validId(id)) return Promise.resolve(rejected(id, failure('INVALID_CONVERSATION_ID', '会话标识无效')));
    id = canonicalId(id);
    if (pending.has(id)) return pending.get(id);
    let canReleaseProtectedBarrier = false;
    try {
      const current = read()[id];
      canReleaseProtectedBarrier = !current;
      if (current?.status === 'deleted') {
        const warning = current.scratchRetained && retainedScratchWarning(current.scratchRetained);
        return Promise.resolve({ ok: true, id, deleted: true, alreadyDeleted: true,
          ...(current.fileCleanup ? { fileCleanup: current.fileCleanup } : {}),
          ...(warning ? { scratchRetained: true, cleanupWarning: warning.message, warnings: [warning] } : {}) });
      }
      assertIdle(id);
      // Retrying an interrupted deletion must confirm idle shutdown again. There is
      // deliberately no persisted "already stopped" flag or skipped stage.
      persist(Object.assign(Object.create(null), read(), {
        [id]: { status: 'deleting', startedAt: current?.startedAt || new Date().toISOString(),
          ...(current?.fileCleanup ? { fileCleanup: current.fileCleanup } : {}) },
      }));
    } catch (error) { return Promise.resolve(rejected(id, error)); }
    const operation = Promise.resolve().then(() => perform(id, canReleaseProtectedBarrier)).finally(() => {
      if (pending.get(id) === operation) pending.delete(id);
    });
    pending.set(id, operation);
    return operation;
  }

  return { delete: deleteConversation, assertAvailable, canWrite, assertIdle };
}

module.exports = { createConversationDeletion };
