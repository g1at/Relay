'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { unpackPath } = require('../app/paths');

const VERSION = 1;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const iso = value => { const time = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
const identity = value => typeof value === 'string' && value.length <= 240 ? value : '';
const configurationKey = historyDir => crypto.createHash('sha256').update(path.resolve(historyDir)).digest('hex');

// This is the only boundary allowed to forward SDK data to the statistics
// worker. Never spread an SDK event: results and tool payloads contain text.
function normalizeUsageRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const queryId = identity(input.queryId);
  const at = iso(input.at);
  if (!queryId || !at || !input.modelUsage || typeof input.modelUsage !== 'object') return null;
  const models = Object.create(null);
  for (const [name, value] of Object.entries(input.modelUsage).slice(0, 100)) {
    if (!name || name.length > 240 || !value || typeof value !== 'object') continue;
    if (!TOKEN_FIELDS.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)) continue;
    models[name] = Object.fromEntries(TOKEN_FIELDS.map(field => [field, value[field]]));
  }
  if (!Object.keys(models).length) return null;
  if (input.isError === true && Object.values(models).every(value => TOKEN_FIELDS.every(field => value[field] === 0))) return null;
  const record = {
    queryId, sessionId: identity(input.sessionId), resultId: identity(input.resultId),
    at, startedAt: iso(input.startedAt) || at,
    source: ['conversation', 'scheduled', 'background', 'mini'].includes(input.source) ? input.source : 'background',
    conversationId: identity(input.conversationId) || null, modelUsage: models,
    isError: input.isError === true,
  };
  // A result UUID stays the same if redelivered across a conversation reset;
  // deduplicate it within the query independently of the wrapper session ID.
  // Older producers may omit the result uuid; the fallback contains only
  // identifiers and counters, never the assistant answer.
  record.id = crypto.createHash('sha256').update(JSON.stringify(record.resultId
    ? [queryId, record.resultId]
    : [queryId, record.sessionId, at, models])).digest('hex');
  return record;
}

function unknownSnapshot(days) {
  return {
    ok: true, days, available: false, generatedAt: null,
    totals: { conversations: null, messages: null }, daily: [],
    tokens: { available: false, inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheCreationTokens: null, totalTokens: null, byModel: [], coverage: 'unknown',
      recordedResults: 0, recordingStartedAt: null },
    coverage: { history: 'unknown', warningCodes: [] },
  };
}

class UsageStatsService {
  constructor(options = {}) {
    if (!options.historyDir || !options.cacheDir) throw new TypeError('UsageStatsService requires historyDir and cacheDir');
    this.historyDir = path.resolve(options.historyDir);
    this.cacheDir = path.resolve(options.cacheDir);
    this.workerFile = options.workerFile || unpackPath(path.join(__dirname, 'usage-stats-worker.js'));
    this.WorkerClass = options.WorkerClass || Worker;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.onUpdated = typeof options.onUpdated === 'function' ? options.onUpdated : () => {};
    this.refreshIntervalMs = options.refreshIntervalMs == null ? 15000 : options.refreshIntervalMs;
    this.refreshTimeoutMs = options.refreshTimeoutMs == null ? 45000 : options.refreshTimeoutMs;
    this.flushTimeoutMs = options.flushTimeoutMs == null ? 2500 : options.flushTimeoutMs;
    this.configKey = configurationKey(this.historyDir);
    this.worker = null; this.snapshot = null; this.error = null; this.closed = false;
    this.pending = new Map(); this.requests = new Map(); this.sequence = 0;
    this.refreshPromise = null; this.lastRefreshAt = 0; this.dirty = false;
    this.refreshTimer = null;
    this.usageGeneration = 0; this.closing = false;
    // Only this bounded display snapshot is read on the UI process. The large
    // incremental index, history files and metric journal belong to the worker.
    try {
      const file = path.join(this.cacheDir, 'usage-snapshot-v1.json');
      if (fs.statSync(file).size <= 512 * 1024) {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.version === VERSION && value.configKey === this.configKey && value.windows) this.snapshot = value;
      }
    } catch (_) {}
  }

  _notify() {
    try { this.onUpdated({ generatedAt: this.snapshot && this.snapshot.generatedAt || null,
      refreshing: !!this.refreshPromise, stale: this.dirty || !!this.error, error: clone(this.error) }); } catch (_) {}
  }

  _worker() {
    if (this.closed) throw new Error('Statistics service is closed');
    if (this.worker) return this.worker;
    const worker = new this.WorkerClass(this.workerFile, { workerData: {
      historyDir: this.historyDir, cacheDir: this.cacheDir, configKey: this.configKey,
    } });
    this.worker = worker;
    if (typeof worker.unref === 'function') worker.unref();
    worker.on('message', message => {
      if (!message || this.worker !== worker) return;
      if (message.type === 'usage-ack') {
        if (message.ok) this.pending.delete(message.id);
        else { this.error = { code: 'USAGE_WRITE_FAILED', message: '用量记录暂未保存，稍后会重试。' }; this._notify(); }
        return;
      }
      const request = this.requests.get(message.requestId);
      if (request) { clearTimeout(request.timer); this.requests.delete(message.requestId); request.resolve(message); }
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this._failWorker({ code: 'STATS_WORKER_FAILED', message: '统计暂时未能更新，已保留上次结果。' });
    };
    worker.once('error', failed);
    worker.once('exit', () => { if (!this.closed) failed(); });
    for (const record of this.pending.values()) worker.postMessage({ type: 'usage', record });
    return worker;
  }

  _failWorker(error) {
    const worker = this.worker; this.worker = null;
    this.error = error;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error }); }
    this.requests.clear();
    if (worker) Promise.resolve(worker.terminate()).catch(() => {});
    this._notify();
  }

  _request(type, extra = {}) {
    try {
      const worker = this._worker();
      const requestId = ++this.sequence;
      return new Promise(resolve => {
        const timer = setTimeout(() => this._failWorker({ code: 'STATS_TIMEOUT', message: '统计后台响应超时，已保留上次结果。' }), type === 'flush' ? this.flushTimeoutMs : this.refreshTimeoutMs);
        this.requests.set(requestId, { resolve, timer });
        try { worker.postMessage({ type, requestId, ...extra }); }
        catch (_) { this._failWorker({ code: 'STATS_WORKER_FAILED', message: '统计后台暂时不可用。' }); }
      });
    } catch (_) {
      return Promise.resolve({ ok: false, error: { code: 'STATS_WORKER_FAILED', message: '统计后台暂时不可用。' } });
    }
  }

  recordUsage(input) {
    if (this.closed || this.closing) return { ok: false };
    const record = normalizeUsageRecord(input);
    if (!record) return { ok: false, code: 'USAGE_UNAVAILABLE' };
    if (this.pending.has(record.id)) return { ok: true, queued: true };
    this.pending.set(record.id, record); this.dirty = true; this.usageGeneration += 1;
    try {
      const existed = !!this.worker;
      const worker = this._worker();
      if (existed) worker.postMessage({ type: 'usage', record });
    } catch (_) {}
    this._scheduleRefresh();
    return { ok: true, queued: true };
  }

  _scheduleRefresh() {
    if (!this.refreshTimer && !this.closed && !this.closing) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        if (!this.closed) this.refresh();
      }, Math.max(250, this.lastRefreshAt + this.refreshIntervalMs - Number(this.now())));
      if (this.refreshTimer.unref) this.refreshTimer.unref();
    }
  }

  overview(options = {}) {
    const days = [7, 30, 90].includes(Number(options.days)) ? Number(options.days) : 30;
    if (!this.closed) this.refresh({ force: !!options.force });
    const value = this.snapshot && this.snapshot.windows[String(days)];
    return { ...(value ? clone(value) : unknownSnapshot(days)), refreshing: !!this.refreshPromise,
      stale: !!value && (this.dirty || !!this.error || this.now() - Date.parse(value.generatedAt) > this.refreshIntervalMs),
      error: clone(this.error) };
  }

  refresh(options = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.closed) return Promise.resolve({ ok: false });
    const now = Number(this.now());
    if (!options.force && this.lastRefreshAt && now - this.lastRefreshAt < this.refreshIntervalMs) return Promise.resolve({ ok: true, skipped: true });
    this.lastRefreshAt = now;
    const generationAtStart = this.usageGeneration;
    if (this.pending.size) {
      try {
        const worker = this._worker();
        for (const record of this.pending.values()) worker.postMessage({ type: 'usage', record });
      } catch (_) {}
    }
    this.refreshPromise = this._request('refresh', { now }).then(result => {
      if (result.ok && result.snapshot) {
        this.snapshot = result.snapshot;
        this.error = this.pending.size ? { code: 'USAGE_WRITE_FAILED', message: '部分用量记录暂未保存，稍后会重试。' } : result.error || null;
        this.dirty = this.usageGeneration !== generationAtStart || this.pending.size > 0;
      } else this.error = result.error || { code: 'STATS_REFRESH_FAILED', message: '统计暂时未能更新，已保留上次结果。' };
      return { ok: !!result.ok, error: clone(this.error) };
    }).finally(() => { this.refreshPromise = null; this._notify(); if (this.dirty) this._scheduleRefresh(); });
    return this.refreshPromise;
  }

  async flush() {
    if (this.closed || (!this.worker && !this.pending.size)) return { ok: !this.pending.size };
    let worker;
    try { worker = this._worker(); } catch (_) { return { ok: false, error: { code: 'USAGE_WRITE_FAILED', message: '用量记录尚未保存。' } }; }
    // Retry unacknowledged records; the journal's stable record ids deduplicate
    // retries after an uncertain worker response or an interrupted shutdown.
    for (const record of this.pending.values()) worker.postMessage({ type: 'usage', record });
    const result = await this._request('flush');
    return { ok: !!result.ok && this.pending.size === 0, error: result.error || null };
  }

  async destroy() {
    if (this.closed) return;
    if (this.destroyPromise) return this.destroyPromise;
    this.closing = true;
    this.destroyPromise = this._destroy();
    return this.destroyPromise;
  }

  async _destroy() {
    const result = await this.flush();
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const worker = this.worker; this.worker = null;
    if (worker) {
      let timer;
      await Promise.race([Promise.resolve(worker.terminate()).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
    }
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.resolve({ ok: false }); }
    this.requests.clear();
    return result;
  }
}

module.exports = { UsageStatsService, normalizeUsageRecord, configurationKey, VERSION, TOKEN_FIELDS };
