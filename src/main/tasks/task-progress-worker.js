'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { TaskProgressStore } = require('./task-progress-store');

const errorData = error => ({ name: error?.name || 'Error', message: error?.message || String(error), code: error?.code || null });
const warn = error => parentPort.postMessage({ type: 'warning', error: errorData(error) });
const store = new TaskProgressStore({ ...workerData,
  logger: { warn: (...parts) => warn(new Error(parts.join(' '))) },
});
const methods = new Set(['load', 'flush', 'remove', 'close']);
let tail = Promise.resolve();
let closing = false;

// Each barrier waits for previous operations; asynchronous file access cannot let
// remove/close overtake a preceding load or flush. Observe itself needs no receipt.
parentPort.on('message', request => {
  tail = tail.then(async () => {
    const { requestId, method, args } = request || {};
    const hasReceipt = Number.isSafeInteger(requestId) && requestId > 0;
    try {
      if (closing) throw new Error('Task progress worker is closing');
      if (method === 'observe' && !hasReceipt) {
        if (!store.observe(request.envelopes)) throw new Error('Task progress store rejected observation');
        return;
      }
      if (!hasReceipt || !Array.isArray(args) || !methods.has(method)) throw new TypeError('Invalid task progress request');
      if (method === 'close') closing = true;
      const value = await store[method](...args);
      parentPort.postMessage({ requestId, ok: true, value });
    } catch (error) {
      if (hasReceipt) parentPort.postMessage({ requestId, ok: false, error: errorData(error) });
      else warn(error);
    } finally {
      if (method === 'close' && closing) parentPort.close();
    }
  }).catch(warn);
});
