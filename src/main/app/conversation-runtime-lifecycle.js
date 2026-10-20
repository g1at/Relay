'use strict';

// Keep ownership until native close, including handles already evicted from the
// warm-session map. A stop request or a logical turn result is not native close.
function createConversationRuntimeLifecycle({ timeoutMs = 20000 } = {}) {
  const entries = new Map();
  const key = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
  function observeClose(entry) {
    try {
      if (typeof entry.handle.whenClosed === 'function') {
        entry.closed = Promise.resolve(entry.handle.whenClosed()).then(entry.confirm, () => ({ stopConfirmed: false }));
      }
    } catch (_) { /* Unknown close state must continue to block cleanup. */ }
  }
  function track(id, handle, stop = () => handle.kill()) {
    if (!id || !handle) return;
    id = key(id);
    const owned = entries.get(id) || new Set();
    if ([...owned].some(entry => entry.handle === handle)) return;
    entries.set(id, owned);
    const entry = { handle, stop, closed: null, confirmed: false };
    owned.add(entry);
    const confirm = result => {
      if (result?.stopConfirmed === true) {
        entry.confirmed = true; owned.delete(entry);
        if (!owned.size && entries.get(id) === owned) entries.delete(id);
      }
      return result;
    };
    entry.confirm = confirm;
    observeClose(entry);
  }
  async function stop(id) {
    id = key(id);
    const owned = [...(entries.get(id) || [])];
    if (!owned.length) return { stopConfirmed: true };
    const stopping = Promise.all(owned.map(async entry => {
      if (entry.confirmed) return true;
      try {
        // A failed observation is not permanent state. Reobserve the retained
        // handle on retry while still rejecting an unconfirmed stop receipt.
        observeClose(entry);
        const requested = Promise.resolve(entry.stop()).then(entry.confirm, () => ({ stopConfirmed: false }));
        // A bounded observer can report "pending" just before kill finishes
        // closing the same resources. Accept a confirmed receipt from either
        // path; a stale negative observation must not hide a successful stop.
        const receipts = entry.closed ? [entry.closed, requested] : [requested];
        return await new Promise(resolve => {
          let remaining = receipts.length;
          for (const receipt of receipts) Promise.resolve(receipt).then(result => {
            if (result?.stopConfirmed === true) resolve(true);
            else if (--remaining === 0) resolve(false);
          }, () => { if (--remaining === 0) resolve(false); });
        });
      } catch (_) { return false; }
    })).then(results => ({ stopConfirmed: results.every(Boolean) && !entries.get(id)?.size }));
    let timer;
    try {
      return await Promise.race([stopping, new Promise(resolve => {
        timer = setTimeout(() => resolve({ stopConfirmed: false, code: 'STOP_NOT_CONFIRMED' }), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  return { track, stop, has: id => !!entries.get(key(id))?.size };
}

module.exports = { createConversationRuntimeLifecycle };
