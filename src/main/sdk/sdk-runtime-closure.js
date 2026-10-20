'use strict';

// A native process exit and a request to close its MCP transports are separate
// facts. Keep pending resources owned across bounded waits and explicit retries.
function createRuntimeClosure({ getMapper, onClosed, timeoutMs = 1000, onPending = () => {} }) {
  let mapper, resourceWork = null, resourcesClosed = false;
  let native = null, result = null, metadata = null, notified = false, attempt = null;
  let resolveInitial;
  const initial = new Promise(resolve => { resolveInitial = resolve; });
  let current = initial, started = false;

  async function closeResources() {
    const selected = getMapper();
    if (typeof selected?.close !== 'function') return { stopConfirmed: true };
    if (mapper !== selected) { mapper = selected; resourceWork = null; resourcesClosed = false; }
    if (resourcesClosed) return { stopConfirmed: true };
    if (!resourceWork) {
      const work = Promise.resolve().then(() => selected.close()).then(value => {
        if (value?.stopConfirmed === false || value?.ok === false) throw new Error('RESOURCE_CLOSE_UNCONFIRMED');
        resourcesClosed = true;
        return { stopConfirmed: true };
      }).catch(() => ({ stopConfirmed: false, code: 'RUNTIME_RESOURCE_CLEANUP_FAILED' }));
      resourceWork = work;
      work.then(receipt => { if (!receipt.stopConfirmed && resourceWork === work) resourceWork = null; });
    }
    let timer;
    try {
      const receipt = await Promise.race([resourceWork, new Promise(resolve => {
        timer = setTimeout(() => resolve({ stopConfirmed: false, code: 'RUNTIME_RESOURCE_CLEANUP_PENDING' }), timeoutMs);
      })]);
      if (!receipt.stopConfirmed) { try { onPending(receipt.code); } catch (_) {} }
      return receipt;
    } finally { clearTimeout(timer); }
  }

  function observe() {
    if (attempt) return current;
    const first = !started; started = true;
    const work = (async () => {
      const resources = await closeResources();
      if (!notified) { notified = true; metadata = onClosed(native) || {}; }
      result = { ...native, ...metadata, stopConfirmed: native?.stopConfirmed === true && resources.stopConfirmed === true,
        ...(!resources.stopConfirmed ? { code: resources.code } : {}) };
      return result;
    })();
    attempt = work;
    if (!first) current = work;
    work.then(receipt => {
      if (attempt === work) attempt = null;
      if (first) resolveInitial(receipt);
    });
    return current;
  }
  return {
    finish(receipt) {
      native = receipt;
      return result?.stopConfirmed === true ? current : observe();
    },
    whenClosed() {
      if (native && result?.stopConfirmed !== true) return observe();
      return current;
    },
  };
}

module.exports = { createRuntimeClosure };
