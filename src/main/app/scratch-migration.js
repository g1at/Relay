'use strict';

const path = require('node:path');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function createScratchMigration({ getWorkspaces, getTargetRoot, knownConversationIds = () => [],
  isBusy = () => false, canMigrate = () => true, stopIdle = async () => ({ stopConfirmed: true }),
  pollMs = 5000, onStatus = () => {},
} = {}) {
  const queue = new Set(), moving = new Map(), waiting = new Set(), failures = new Map();
  let worker = null, rescan = false, timer = null, disposed = false, migrated = 0, scanError = null;
  function status() {
    return { running: moving.size > 0, pending: waiting.size, migrated, failed: failures.size + (scanError ? 1 : 0),
      error: scanError || failures.values().next().value || null };
  }
  function publish() { try { onStatus(status()); } catch (_) {} }
  function assertAvailable(id) {
    if (moving.has(id)) throw Object.assign(new Error('正在迁移这条会话的临时文件，请稍后重试。'), { code: 'SCRATCH_MIGRATING' });
  }
  function schedule() {
    if (disposed || timer || !queue.size) return;
    timer = setTimeout(() => { timer = null; void run(); }, pollMs);
    timer.unref?.();
  }
  async function drain() {
    do {
      if (rescan) {
        rescan = false; scanError = null;
        try {
          const items = await getWorkspaces().listScratch(knownConversationIds());
          for (const item of items) {
            if (item.error) { failures.set(item.conversationId, item.error); continue; }
            if (key(item.root) !== key(getTargetRoot()) || item.cleanupPending) queue.add(item.conversationId);
          }
        } catch (error) { scanError = error.message; }
      }
      for (const id of [...queue]) {
        if (disposed) break;
        if (!canMigrate(id)) { queue.delete(id); waiting.delete(id); failures.delete(id); continue; }
        if (isBusy(id)) { waiting.add(id); continue; }
        waiting.delete(id);
        // Lock synchronously before awaiting idle-process shutdown. Admission
        // cannot create another writer between the check and the file copy.
        let released;
        moving.set(id, new Promise(resolve => { released = resolve; })); publish();
        try {
          const stopped = await stopIdle(id);
          if (stopped?.stopConfirmed !== true) throw new Error('尚未确认执行器退出，原临时目录已保留。');
          if (!canMigrate(id)) { queue.delete(id); continue; }
          const result = await getWorkspaces().migrateScratch(id, getTargetRoot());
          if (result?.migrated) migrated++;
          if (result?.cleanupPending) throw new Error(result.error || (result.migrated
            ? '临时文件已迁移，原目录暂未清理，请检查后重试。'
            : '临时目录仍有待处理的清理项，文件已保留，请检查后重试。'));
          failures.delete(id); queue.delete(id);
        } catch (error) {
          failures.set(id, error.message); queue.delete(id);
        } finally { moving.delete(id); released(); publish(); }
      }
    } while (rescan && !disposed);
  }
  function run() {
    if (worker || disposed) return worker || Promise.resolve();
    worker = drain().catch(error => { scanError = error.message || String(error); }).finally(() => {
      worker = null; publish();
      if (rescan && !disposed) void run(); else schedule();
    });
    return worker;
  }
  function request() {
    rescan = true; failures.clear(); clearTimeout(timer); timer = null;
    return run();
  }
  // A deletion waits for a copy already in progress, then removes the committed
  // location. New migration attempts are rejected by the deletion tombstone.
  async function waitFor(id) { if (moving.has(id)) await moving.get(id); }
  function dispose() { disposed = true; clearTimeout(timer); timer = null; }
  return { request, status, assertAvailable, waitFor, dispose };
}

module.exports = { createScratchMigration };
