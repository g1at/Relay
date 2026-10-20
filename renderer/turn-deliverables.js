(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayTurnDeliverables = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const text = (value, limit = 4096) => typeof value === 'string' && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
  const keyOf = (conversationId, runId, turnTs = null) => JSON.stringify([conversationId, runId, turnTs]);
  function normalizeSnapshot(value) {
    if (!value || value.version !== 1 || !text(value.conversationId, 256)
        || !text(value.runId, 256) || !text(value.turnTs, 128) || !Array.isArray(value.items)) return null;
    const ids = new Set(), items = [];
    for (const item of value.items) {
      const id = text(item?.id, 256), path = text(item?.path, 16384);
      if (!id || ids.has(id) || !path || !/^(?:[a-z]:[\\/]|\/(?!\/)|\\\\)/i.test(path)) continue;
      ids.add(id);
      items.push({ id, path, name: text(item.name, 512) || path.replace(/\\/g, '/').split('/').pop() || '文件',
        ...(Number.isFinite(item.size) && item.size >= 0 ? { size: item.size } : {}),
        ...(Number.isFinite(item.mtimeMs) && item.mtimeMs >= 0 ? { mtimeMs: item.mtimeMs } : {}),
        source: text(item.source, 128), ...(text(item.toolUseId, 256) ? { toolUseId: item.toolUseId } : {}) });
    }
    return { version: 1, conversationId: value.conversationId, runId: value.runId, turnTs: value.turnTs,
      status: text(value.status, 64), items, complete: value.complete === true,
      warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 32).map(item => typeof item === 'string' ? item : item?.message).filter(item => text(item, 2048)) : [] };
  }
  function matchesTurn(turn, snapshot) {
    return !!turn && turn.runId === snapshot.runId && turn.ts === snapshot.turnTs;
  }
  // Host snapshots are authoritative. A turn index is a presentation hint only;
  // never attach an unknown run to the last turn or to a similarly timed input.
  function applySnapshot(value, { conversation = null, run = null } = {}) {
    const snapshot = normalizeSnapshot(value);
    if (!snapshot) return null;
    const matching = conversation?.id === snapshot.conversationId && Array.isArray(conversation.turns)
      ? conversation.turns.map((turn, index) => ({ turn, index })).filter(item => matchesTurn(item.turn, snapshot)) : [];
    const stored = matching.length === 1 ? matching[0] : null;
    const live = run?.convId === snapshot.conversationId && run.jobId === snapshot.runId
      && matchesTurn(run.turn, snapshot) ? run : null;
    if (!stored && !live) return null;
    if (stored) stored.turn.deliverables = snapshot;
    if (live) live.turn.deliverables = snapshot;
    return { snapshot, stored, run: live };
  }
  const terminalSnapshots = new Set(['complete', 'failed', 'canceled', 'interrupted']);
  const terminalTurns = new Set(['complete', 'error', 'failed', 'canceled', 'interrupted', 'paused']);
  function canRenderSnapshot(turn, snapshot, run = null) {
    if (!snapshot || !matchesTurn(turn, snapshot) || !terminalSnapshots.has(snapshot.status)) return false;
    if (!run || run.convId !== snapshot.conversationId || run.jobId !== snapshot.runId || !matchesTurn(run.turn, snapshot)) return true;
    // A host completion can arrive before the renderer has finalized the answer.
    // Keep the data, but wait for the owning live output to reach its terminal state.
    const status = run.outputState?.status || run.turn?.output?.status || run.turn?.status;
    return terminalTurns.has(status);
  }
  function createController({ container, getConversation = () => null, getRun = () => null,
    isVisible = () => true, bridge = null, onPresentationChanged = () => {} } = {}) {
    const views = new Map(), pending = new Map(), observed = new Map();
    const document = container?.ownerDocument;
    let destroyed = false;
    function presentationChanged(identity) {
      try { onPresentationChanged({ conversationId: identity.conversationId, runId: identity.runId, turnTs: identity.turnTs }); } catch (_) {}
    }
    function removeView(key, view) {
      if (!view) return;
      view.element.remove(); views.delete(key); presentationChanged(view.snapshot);
    }
    function nextTurnAnchor(turnIndex) {
      return Array.from(container?.children || []).find(node => node.classList.contains('conversation-turn-anchor')
        && Number(node.dataset.turnAnchor) > turnIndex) || null;
    }
    function answerBody(snapshot) {
      const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const selector = '.message.assistant:not(.turn-deliverables):not([data-timeline-partial="true"])'
        + '[data-conversation-id=' + quote(snapshot.conversationId) + ']'
        + '[data-run-id=' + quote(snapshot.runId) + ']'
        + '[data-turn-ts=' + quote(snapshot.turnTs) + ']';
      const answers = Array.from(container.querySelectorAll(selector)).filter(node => node.parentNode === container);
      return answers.at(-1)?.querySelector(':scope > .bubble > .body') || null;
    }
    function render(turn, { conversationId, turnIndex, before = null } = {}) {
      if (destroyed || !document || !container || !isVisible() || getConversation()?.id !== conversationId) return null;
      const key = keyOf(conversationId, turn?.runId, turn?.ts), snapshot = normalizeSnapshot(turn?.deliverables);
      let view = views.get(key);
      const owned = !!snapshot && snapshot.conversationId === conversationId && matchesTurn(turn, snapshot);
      const ownership = owned ? JSON.stringify([snapshot.status, snapshot.items, snapshot.warnings]) : null;
      const ownerChanged = observed.get(key) !== ownership;
      if (owned) observed.set(key, ownership); else observed.delete(key);
      if (!snapshot || snapshot.conversationId !== conversationId || !canRenderSnapshot(turn, snapshot, getRun(turn?.runId)) || !snapshot.items.length) {
        if (view) removeView(key, view);
        else if (owned && ownerChanged) presentationChanged(snapshot);
        return null;
      }
      if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) return null;
      let changed = !view || ownerChanged;
      if (!view) {
        const element = document.createElement('section');
        element.className = 'message assistant turn-deliverables';
        element.setAttribute('aria-label', '本轮成果');
        const heading = document.createElement('div'); heading.className = 'turn-deliverables-heading';
        const title = document.createElement('span'); title.textContent = '本轮成果';
        const count = document.createElement('span'); count.className = 'turn-deliverables-count';
        heading.append(title, count);
        const list = document.createElement('div'); list.className = 'turn-deliverables-list';
        const note = document.createElement('div'); note.className = 'turn-deliverables-note'; note.hidden = true;
        element.append(heading, list, note); view = { element, count, list, note, entries: new Map(), before: null };
        views.set(key, view);
      }
      const signature = JSON.stringify([snapshot.items, snapshot.warnings]);
      changed ||= view.signature !== signature;
      view.signature = signature; view.snapshot = snapshot; view.turn = turn;
      view.element.dataset.turn = String(turnIndex); view.element.dataset.runId = snapshot.runId;
      view.element.dataset.conversationId = conversationId; view.element.dataset.turnTs = snapshot.turnTs;
      view.count.textContent = String(snapshot.items.length);
      const wanted = new Set(snapshot.items.map(item => item.id));
      for (const [id, entry] of view.entries) if (!wanted.has(id)) { entry.node.remove(); view.entries.delete(id); }
      for (const item of snapshot.items) {
        const signature = JSON.stringify([item.path, item.name, item.size, item.mtimeMs]);
        let entry = view.entries.get(item.id);
        if (!entry) {
          const node = document.createElement('p'); node.dataset.deliverableId = item.id;
          entry = { node, signature: null }; view.entries.set(item.id, entry);
        }
        if (entry.signature !== signature) {
          const link = document.createElement('a');
          // Preserve literal filename #/? instead of interpreting them as URL
          // fragments or line numbers; activation uses existing file-link IPC.
          link.setAttribute('href', encodeURI(item.path).replace(/#/g, '%23').replace(/\?/g, '%3F'));
          link.textContent = item.name; entry.node.replaceChildren(link); entry.signature = signature;
        }
      }
      let next = null;
      for (const item of [...snapshot.items].reverse()) {
        const node = view.entries.get(item.id).node;
        if (node.parentNode !== view.list || node.nextSibling !== next) view.list.insertBefore(node, next);
        next = node;
      }
      view.note.hidden = !snapshot.warnings.length;
      view.note.textContent = snapshot.warnings.length ? '部分文件未能登记，已保留可确认的成果。' : '';
      const body = answerBody(snapshot);
      if (body) {
        view.element.className = 'turn-deliverables';
        // The result belongs to this answer. Keep the existing answer actions
        // and time below the entire bubble; never relocate them into another row.
        if (view.element.parentNode !== body.parentNode || body.nextSibling !== view.element) {
          body.parentNode.insertBefore(view.element, body.nextSibling); changed = true;
        }
      } else {
        view.element.className = 'message assistant turn-deliverables';
        if (before?.parentNode === container) view.before = before;
        const nextTurn = nextTurnAnchor(turnIndex);
        let boundary = view.before?.parentNode === container ? view.before : nextTurn;
        // A retained timeline marker may outlive a history repaint. Never let its
        // stale position move an earlier result underneath a later turn.
        if (nextTurn && boundary && nextTurn !== boundary && (nextTurn.compareDocumentPosition(boundary) & 4)) boundary = nextTurn;
        if (view.element.parentNode !== container || view.element.nextSibling !== boundary) { container.insertBefore(view.element, boundary); changed = true; }
      }
      if (changed) presentationChanged(snapshot);
      return view.element;
    }
    function receive(event) {
      if (destroyed || !event?.snapshot || event.conversationId !== event.snapshot.conversationId
          || event.runId !== event.snapshot.runId) return false;
      const key = keyOf(event.conversationId, event.runId);
      const request = pending.get(key); if (request) request.stale = true;
      const conversation = getConversation(), result = applySnapshot(event.snapshot, { conversation, run: getRun(event.runId) });
      if (!result) return false;
      if (conversation?.id === result.snapshot.conversationId) {
        const stored = result.stored;
        const turn = result.run?.turn || stored?.turn;
        const turnIndex = stored?.index ?? result.run?.turnIndex;
        if (turn) render(turn, { conversationId: conversation.id, turnIndex,
          before: result.run?.supplementTimeline?.end || null });
      }
      return true;
    }
    async function refresh(conversationId, runId) {
      if (destroyed || typeof bridge?.get !== 'function') return false;
      const key = keyOf(conversationId, runId), request = { stale: false };
      pending.set(key, request);
      try {
        const result = await bridge.get({ conversationId, runId });
        if (destroyed || request.stale || pending.get(key) !== request || !result?.ok || !result.snapshot) return false;
        return receive({ conversationId, runId, snapshot: result.snapshot });
      } catch (_) { return false; } // Delivery presentation cannot break terminal cleanup.
      finally { if (pending.get(key) === request) pending.delete(key); }
    }
    function getArtifactTarget({ conversationId, runId, turnTs, itemId } = {}) {
      if (destroyed || !isVisible() || getConversation()?.id !== conversationId) return null;
      const view = views.get(keyOf(conversationId, runId, turnTs));
      if (!view || !container.contains(view.element) || !canRenderSnapshot(view.turn, view.snapshot, getRun(runId))) return null;
      const entry = view.entries.get(itemId), link = entry?.node.querySelector('a');
      return entry?.node.parentNode === view.list && link?.isConnected ? link : null;
    }
    function clear() { for (const [key, view] of views) removeView(key, view); observed.clear(); }
    const unsubscribe = typeof bridge?.onChanged === 'function' ? bridge.onChanged(receive) : null;
    return { render, receive, refresh, clear, getArtifactTarget, destroy() {
      destroyed = true; clear(); pending.clear(); if (typeof unsubscribe === 'function') unsubscribe();
    } };
  }
  return Object.freeze({ normalizeSnapshot, matchesTurn, applySnapshot, canRenderSnapshot, createController });
});
