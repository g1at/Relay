'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { unpackPath } = require('./paths');
const canceled = () => ({ ok: true, items: [], canceled: true });

// Only small requests/results cross this boundary. History IO, parsing and
// compact text caching belong to the worker, never Electron's main event loop.
class HistorySearchClient {
  constructor({ historyDir, cacheMaxBytes, WorkerClass = Worker, workerFile, timeoutMs = 30000 } = {}) {
    if (typeof historyDir !== 'string' || !path.isAbsolute(historyDir)) throw new TypeError('historyDir must be absolute');
    this.options = { historyDir, ...(cacheMaxBytes == null ? {} : { cacheMaxBytes }) };
    this.WorkerClass = WorkerClass;
    this.workerFile = workerFile || path.join(unpackPath(__dirname), 'history-search-worker.js');
    this.timeoutMs = timeoutMs;
    this.worker = null; this.sequence = 0; this.pending = new Map(); this.active = new Map(); this.closed = false;
  }
  _ref() { if (this.pending.size) this.worker?.ref(); else this.worker?.unref(); }
  _settle(requestId, result) {
    const request = this.pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(requestId);
    if (this.active.get(request.clientId) === requestId) this.active.delete(request.clientId);
    request.resolve(result); this._ref();
  }
  _failed(worker, code = 'HISTORY_SEARCH_WORKER_FAILED') {
    if (worker && this.worker !== worker) return;
    const current = this.worker; this.worker = null;
    for (const requestId of [...this.pending.keys()]) this._settle(requestId, {
      ok: false, items: [], code, error: code === 'HISTORY_SEARCH_TIMEOUT' ? '搜索超时，请重试。' : '搜索服务暂时不可用，请重试。',
    });
    if (current) { try { Promise.resolve(current.terminate()).catch(() => {}); } catch (_) {} }
  }
  _start() {
    if (this.worker) return this.worker;
    const worker = new this.WorkerClass(this.workerFile, { workerData: this.options });
    this.worker = worker;
    worker.on('message', message => {
      if (this.worker !== worker) return;
      if (!message || !this.pending.has(message.requestId)) return;
      const result = message.result;
      this._settle(message.requestId, result && typeof result.ok === 'boolean' && Array.isArray(result.items)
        ? result : { ok: false, items: [], code: 'HISTORY_SEARCH_INVALID_RESPONSE', error: '搜索结果暂时不可用，请重试。' });
    });
    worker.on('error', () => this._failed(worker));
    worker.on('messageerror', () => this._failed(worker));
    worker.on('exit', () => this._failed(worker));
    worker.unref(); return worker;
  }
  search(query, limit, clientId = 'default') {
    clientId = String(clientId); this.cancel(clientId);
    if (this.closed) return Promise.resolve({ ok: false, items: [], code: 'HISTORY_SEARCH_CLOSED', error: '搜索服务已关闭。' });
    const q = String(query || '').trim();
    if (!q) return Promise.resolve({ ok: true, items: [] });
    if (q.length > 512) return Promise.resolve({ ok: false, items: [], code: 'HISTORY_SEARCH_QUERY_TOO_LONG', error: '关键词过长，请缩短后搜索。' });
    return new Promise(resolve => {
      let worker;
      try { worker = this._start(); }
      catch (_) { resolve({ ok: false, items: [], code: 'HISTORY_SEARCH_WORKER_FAILED', error: '搜索服务暂时不可用，请重试。' }); return; }
      const requestId = ++this.sequence;
      const timer = setTimeout(() => this._failed(worker, 'HISTORY_SEARCH_TIMEOUT'), this.timeoutMs);
      this.pending.set(requestId, { clientId, resolve, timer }); this.active.set(clientId, requestId); this._ref();
      try { worker.postMessage({ type: 'search', requestId, clientId, query: q, limit }); }
      catch (_) { this._failed(worker); }
    });
  }
  cancel(clientId = 'default') {
    clientId = String(clientId);
    const requestId = this.active.get(clientId);
    if (requestId === undefined) return false;
    this._settle(requestId, canceled());
    try { this.worker?.postMessage({ type: 'cancel', clientId }); } catch (_) { this._failed(this.worker); }
    return true;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const clientId of [...this.active.keys()]) this.cancel(clientId);
    const worker = this.worker; this.worker = null;
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }
}
module.exports = { HistorySearchClient };
