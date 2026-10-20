(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayComposerPrewarm = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  // Preparing an actual draft can hide startup latency. Reading history must
  // not start another SDK and all of its MCP processes.
  function create({ readIntent, dispatch, delayMs = 800, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null, pendingKey = null, revision = 0, dispatchedKey = null;
    function clearPending() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pendingKey = null;
      revision++;
    }
    function cancel() {
      clearPending();
      dispatchedKey = null;
    }
    function schedule() {
      const intent = readIntent();
      if (!intent) { cancel(); return; }
      if (intent.key === dispatchedKey) { clearPending(); return; }
      // Keystrokes do not change the launch contract. Keep its first deadline
      // so continuous typing can overlap initialization with draft preparation.
      if (timer !== null && pendingKey === intent.key) return;
      clearPending();
      pendingKey = intent.key;
      const expected = revision;
      timer = setTimer(() => {
        if (expected !== revision) return;
        timer = null;
        pendingKey = null;
        const current = readIntent();
        if (expected !== revision || !current || current.key !== intent.key) return;
        dispatchedKey = current.key;
        const failed = () => { if (dispatchedKey === current.key) dispatchedKey = null; };
        try {
          Promise.resolve(dispatch(current)).then(result => { if (result?.ok === false) failed(); }, failed);
        } catch (_) { failed(); }
      }, delayMs);
    }
    // Cancellation only discards pending intent. It never stops an executor.
    return { schedule, cancel };
  }
  return { create };
});
