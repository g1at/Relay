'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createHistorySearchCore } = require('./history-search-core');

// One core scan at a time. Every client keeps only its newest queued request;
// replacing a busy client's request does not move it ahead of other clients.
function createHistorySearchDispatcher({ core, send }) {
  const waiting = new Map(), queue = [];
  let active = null, draining = false;
  function reply(job, result) {
    if (job.replied) return;
    job.replied = true; send({ requestId: job.requestId, result });
  }
  function cancel(job) {
    if (!job) return;
    job.canceled = true; reply(job, { ok: true, items: [], canceled: true });
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const clientId = queue.shift(), job = waiting.get(clientId);
        if (!job) continue;
        waiting.delete(clientId); active = job;
        try {
          const result = await core.search({ query: job.query, limit: job.limit, offset: job.offset, isCanceled: () => job.canceled });
          reply(job, job.canceled ? { ok: true, items: [], canceled: true } : result);
        } catch (_) { reply(job, { ok: false, items: [], code: 'HISTORY_SEARCH_FAILED', error: '历史搜索暂时失败，请重试。' }); }
        active = null;
      }
    } finally { draining = false; }
  }
  function handle(message) {
    if (!message || !['search', 'cancel'].includes(message.type)) return;
    const clientId = String(message.clientId ?? 'default');
    if (active?.clientId === clientId) cancel(active);
    const previous = waiting.get(clientId);
    if (previous) cancel(previous);
    if (message.type === 'cancel') {
      waiting.delete(clientId);
      const position = queue.indexOf(clientId); if (position >= 0) queue.splice(position, 1);
      return;
    }
    if (!previous) queue.push(clientId);
    waiting.set(clientId, { requestId: message.requestId, clientId, query: message.query, limit: message.limit, offset: message.offset, canceled: false, replied: false });
    void drain();
  }
  return { handle };
}
if (parentPort) {
  const core = createHistorySearchCore({ historyDir: workerData.historyDir, cacheMaxBytes: workerData.cacheMaxBytes });
  const dispatcher = createHistorySearchDispatcher({ core, send: message => parentPort.postMessage(message) });
  parentPort.on('message', dispatcher.handle);
}
module.exports = { createHistorySearchDispatcher };
