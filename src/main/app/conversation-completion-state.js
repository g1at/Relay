'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_user', 'stopping']);
const SOURCES = new Set(['conversation', 'mini', 'creation', 'schedule']);
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)
  && value.toLowerCase() !== 'index';
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Completion reminders are metadata, not conversation activity. Keeping them
// outside transcripts prevents stale content saves from restoring a read dot or
// clearing a newer one, and leaves history ordering/index rebuilding unchanged.
function createConversationCompletionState({ filePath, onChange = () => {}, onError = () => {}, now = () => new Date() }) {
  let revision = 0;
  let unread = new Map();
  const report = error => { try { onError(error); } catch (_) {} };
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.items)) {
      throw new Error('会话完成提示格式无效');
    }
    revision = saved.revision;
    for (const item of saved.items) {
      if (!validId(item?.conversationId) || !validId(item?.runId)
          || !['succeeded', 'failed'].includes(item.status) || !validTime(item.completedAt)) continue;
      unread.set(item.conversationId, {
        conversationId: item.conversationId, runId: item.runId,
        status: item.status, completedAt: item.completedAt,
      });
    }
  } catch (error) { if (error.code !== 'ENOENT') report(error); }

  function snapshot() {
    return { revision, items: [...unread.values()].map(item => ({ ...item })) };
  }

  function commit(next) {
    const nextRevision = revision + 1;
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      descriptor = fs.openSync(temporary, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, revision: nextRevision, items: [...next.values()] }, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) {} }
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      report(error);
      return false;
    }
    unread = next;
    revision = nextRevision;
    // Listeners see only durable state. Notification failures never turn a
    // completed task into a failure or roll back its reminder.
    try { onChange(snapshot()); } catch (error) { report(error); }
    return true;
  }

  function observe(change) {
    const { run, previous } = change || {};
    if (!run || !previous || !['succeeded', 'failed'].includes(run.state)
        || TERMINAL.has(previous.state) || !ACTIVE.has(previous.state)
        || !SOURCES.has(run.source?.type) || run.lineage?.parentRunId || !validId(run.runId)) return false;
    // A scheduled run can create a different output conversation from its
    // workspace/previous run. Explicit null means no history was produced.
    const conversationId = run.source.type === 'schedule' && Object.hasOwn(run.result || {}, 'conversationId')
      ? run.result.conversationId : run.source.conversationId;
    if (!validId(conversationId) || unread.get(conversationId)?.runId === run.runId) return false;
    const completedAt = validTime(run.endedAt) ? run.endedAt
      : validTime(run.updatedAt) ? run.updatedAt : new Date(now()).toISOString();
    const next = new Map(unread);
    next.set(conversationId, { conversationId, runId: run.runId, status: run.state, completedAt });
    return commit(next);
  }

  function markRead(conversationId, expectedRunId) {
    if (!validId(conversationId) || !validId(expectedRunId)) {
      return { ok: false, changed: false, code: 'INVALID_COMPLETION_ACK', ...snapshot() };
    }
    const item = unread.get(conversationId);
    // A renderer can finish loading one answer after a newer answer completes.
    // Its acknowledgement applies only to the completion it actually displayed.
    if (!item || item.runId !== expectedRunId) return { ok: true, changed: false, ...snapshot() };
    const next = new Map(unread);
    next.delete(conversationId);
    const changed = commit(next);
    return { ok: changed, changed, ...(!changed ? { code: 'COMPLETION_STATE_WRITE_FAILED' } : {}), ...snapshot() };
  }

  function remove(conversationId) {
    if (!validId(conversationId) || !unread.has(conversationId)) return false;
    const next = new Map(unread);
    next.delete(conversationId);
    return commit(next);
  }

  return { snapshot, observe, markRead, remove };
}

module.exports = { createConversationCompletionState };
