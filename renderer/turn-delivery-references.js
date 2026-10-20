(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayTurnDeliveryReferences = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 16384
    && !/[\u0000-\u001f\u007f]/.test(value);
  function fileKey(value, cwd = '') {
    if (!text(value)) return null;
    let file = value.replace(/\\/g, '/');
    file = file.replace(/^\/mnt\/([a-z])\//i, (_, drive) => drive + ':/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:\//i.test(file)) return null;
    if (!/^(?:[a-z]:\/|\/)/i.test(file)) {
      const base = fileKey(cwd);
      if (!base) return null;
      file = base + '/' + file;
    }
    const drive = /^[a-z]:\//i.test(file), unc = file.startsWith('//');
    const root = drive ? file.slice(0, 3) : unc ? '//' : '/';
    const parts = [];
    for (const part of file.slice(root.length).split('/')) {
      if (!part) continue;
      if (part === '.') { if (unc && parts.length < 2) return null; continue; }
      if (part === '..') { if (parts.length <= (unc ? 2 : 0)) return null; parts.pop(); }
      else parts.push(part);
    }
    if (unc && parts.length < 2) return null;
    if (unc && /^(?:wsl\$|wsl\.localhost)$/i.test(parts[0])) {
      parts[0] = parts[0].toLowerCase();
      return root + parts.join('/');
    }
    const result = root + parts.join('/');
    return drive || unc ? result.toLowerCase() : result;
  }
  function stampOwner(element, conversationId, turn, turnIndex) {
    if (!element?.dataset) return;
    if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) element.dataset.turn = String(turnIndex);
    for (const [key, value] of Object.entries({ conversationId, runId: turn?.runId, turnTs: turn?.ts })) {
      if (text(value)) element.dataset[key] = value; else delete element.dataset[key];
    }
  }
  function ownerOf(element) {
    const owner = { conversationId: element?.dataset?.conversationId,
      runId: element?.dataset?.runId, turnTs: element?.dataset?.turnTs };
    return Object.values(owner).every(text) ? owner : null;
  }
  function create({ container, getConversation = () => null, getTarget = () => null } = {}) {
    function findSnapshot(owner) {
      const conversation = getConversation();
      if (!owner || conversation?.id !== owner.conversationId) return null;
      const turns = (conversation.turns || []).filter(turn => turn?.runId === owner.runId && turn.ts === owner.turnTs);
      if (turns.length !== 1) return null;
      const snapshot = turns[0].deliverables;
      if (snapshot?.version !== 1 || snapshot.conversationId !== owner.conversationId
        || snapshot.runId !== owner.runId || snapshot.turnTs !== owner.turnTs || !Array.isArray(snapshot.items)) return null;
      return { conversation, snapshot };
    }
    function resolve(link, parsed) {
      if (!container?.contains(link) || parsed?.line || link.closest('.turn-deliverables')) return null;
      const bubble = link.closest('.message.assistant'), owner = ownerOf(bubble);
      if (!bubble || !container.contains(bubble)) return null;
      const match = findSnapshot(owner);
      if (!match) return null;
      const cwd = match.conversation.workingDir || match.conversation.sdkSessionContext?.hostCwd
        || match.conversation.sdkSessionContext?.cwd;
      const key = fileKey(parsed?.path, cwd);
      if (!key) return null;
      const items = match.snapshot.items.filter(item => text(item?.id) && fileKey(item.path) === key);
      if (items.length !== 1) return null;
      const reference = { ...owner, itemId: items[0].id };
      const terminal = ['complete', 'failed', 'canceled', 'interrupted'].includes(match.snapshot.status);
      const target = terminal && getTarget(reference);
      return { ...reference, pending: !target || !container.contains(target) };
    }
    function navigate(reference) {
      const match = findSnapshot(reference);
      if (!match || !['complete', 'failed', 'canceled', 'interrupted'].includes(match.snapshot.status)
        || !match.snapshot.items.some(item => item.id === reference.itemId)) return false;
      const target = getTarget(reference);
      if (!target || !container.contains(target)) return false;
      target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      (target.querySelector?.('a,button') || target).focus?.({ preventScroll: true });
      return true;
    }
    function refresh(owner, decorate) {
      if (!owner || !Object.values({ conversationId: owner.conversationId, runId: owner.runId, turnTs: owner.turnTs }).every(text)
        || typeof decorate !== 'function') return;
      const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const selector = '.message.assistant:not(.turn-deliverables)'
        + '[data-conversation-id=' + quote(owner.conversationId) + ']'
        + '[data-run-id=' + quote(owner.runId) + ']'
        + '[data-turn-ts=' + quote(owner.turnTs) + ']';
      for (const bubble of container?.querySelectorAll(selector) || []) decorate(bubble.querySelector('.body') || bubble);
    }
    return { resolve, navigate, refresh };
  }
  return Object.freeze({ fileKey, stampOwner, ownerOf, create });
});
