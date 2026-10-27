(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.RelayHistoryCompletion = exported;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function create({ api, getVisibleConversationId, isForeground, onChange = () => {} }) {
    let revision = -1;
    let items = new Map();
    let unsubscribe;
    let started = false;
    const pending = new Set();

    function applySnapshot(value) {
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
          || value.revision <= revision || !Array.isArray(value.items)) return false;
      const next = new Map();
      for (const item of value.items) {
        if (typeof item?.conversationId !== 'string' || typeof item.runId !== 'string'
            || !['succeeded', 'failed'].includes(item.status)) continue;
        next.set(item.conversationId, { ...item });
      }
      const changed = new Set([...items.keys(), ...next.keys()].filter(id => {
        const before = items.get(id), after = next.get(id);
        return before?.runId !== after?.runId || before?.status !== after?.status;
      }));
      revision = value.revision;
      items = next;
      onChange(changed);
      syncVisible();
      return true;
    }

    function syncVisible() {
      if (!isForeground() || typeof api?.markCompletionRead !== 'function') return;
      const id = getVisibleConversationId();
      const item = items.get(id);
      if (!item) return;
      const key = `${id}:${item.runId}`;
      if (pending.has(key)) return;
      pending.add(key);
      // Never clear optimistically: a failed disk write must retain the dot.
      Promise.resolve().then(() => api.markCompletionRead(id, item.runId)).then(result => {
        if (result?.ok) applySnapshot(result);
      }).catch(() => {}).finally(() => pending.delete(key));
    }

    async function start() {
      if (started) return;
      started = true;
      unsubscribe = api?.onCompletionChanged?.(applySnapshot);
      try { applySnapshot(await api?.completionSnapshot?.()); } catch (_) {}
    }

    return { start, applySnapshot, syncVisible, get: id => items.get(id) || null,
      dispose() { unsubscribe?.(); unsubscribe = null; } };
  }
  return { create };
});
