'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { unpackPath } = require('../app/paths');

const workerRoot = unpackPath(__dirname);
const failure = (message, code) => Object.assign(new Error(message), { code });

// Only transport runs on the host. Reduction, serialization and disk access all
// belong to one worker; ordered RPCs provide barriers for the one-way event feed.
class TaskProgressClient {
  constructor(options = {}) {
    if (typeof options.rootDir !== 'string' || !options.rootDir) throw new TypeError('TaskProgressClient requires rootDir');
    this.options = { rootDir: path.resolve(options.rootDir), flushIntervalMs: options.flushIntervalMs };
    this.workerFile = options.workerFile || path.join(workerRoot, 'task-progress-worker.js');
    this.WorkerClass = options.WorkerClass || Worker;
    this.logger = options.logger || console;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
    this.failed = null;
    this.lastError = null;
    this.closing = false;
    this.closePromise = null;
    this.closeAcknowledged = false;
  }

  _report(error) {
    this.lastError = error;
    try { this.logger.warn('[task-progress-client] Progress persistence degraded:', error.message); } catch (_) {}
    try { this.onError?.(error); } catch (_) {}
  }

  _failed(cause) {
    if (this.failed) return;
    const error = failure(`Task progress worker unavailable: ${cause?.message || 'worker exited'}`, 'TASK_PROGRESS_WORKER_FAILED');
    error.cause = cause;
    this.failed = error;
    this._report(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.rejectClose?.(error);
    // Do not replay potentially persisted events after losing a worker receipt.
    // The durable journal remains the recovery source for the missing interval.
    this.worker?.unref();
  }

  _setRef() {
    if (this.pending.size || this.closing) this.worker?.ref();
    else this.worker?.unref();
  }

  _start() {
    if (this.failed) throw this.failed;
    if (this.worker) return this.worker;
    let worker;
    try { worker = new this.WorkerClass(this.workerFile, { workerData: this.options }); }
    catch (error) { this._failed(error); throw this.failed; }
    this.worker = worker;
    worker.on('message', message => {
      if (this.worker !== worker || this.failed) return;
      if (message?.type === 'warning') {
        this._report(failure(message.error?.message || 'Task progress persistence failed', message.error?.code || 'TASK_PROGRESS_PERSISTENCE_FAILED'));
        return;
      }
      const request = this.pending.get(message?.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      if (message.ok === true) {
        if (request.method === 'close') this.closeAcknowledged = true;
        request.resolve(message.value);
      } else {
        const error = failure(message.error?.message || 'Task progress operation failed', message.error?.code || 'TASK_PROGRESS_FAILED');
        if (message.error?.name) error.name = message.error.name;
        this._report(error);
        request.reject(error);
      }
      this._setRef();
    });
    worker.once('error', error => this._failed(error));
    worker.once('messageerror', error => this._failed(error));
    worker.once('exit', code => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code === 0 && this.closing && this.closeAcknowledged && !this.failed) this.resolveClose?.();
      else this._failed(failure(`Task progress worker exited (${code})`, 'TASK_PROGRESS_WORKER_EXITED'));
    });
    worker.unref();
    return worker;
  }

  observe(envelopes) {
    if (this.closing || this.failed) return false;
    if (!Array.isArray(envelopes)) throw new TypeError('Progress envelopes must be an array');
    if (!envelopes.length) return true;
    try {
      // No callback/Promise is retained for individual token batches. The worker
      // receives these before any subsequently posted load/flush/close barrier.
      this._start().postMessage({ method: 'observe', envelopes });
      return true;
    } catch (error) {
      if (this.failed) return false;
      this._report(error);
      throw error;
    }
  }

  _request(method, args = [], closing = false) {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing && !closing) return Promise.reject(failure('Task progress service is closing', 'TASK_PROGRESS_CLOSED'));
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = this._start(); } catch (error) { reject(error); return; }
      const requestId = ++this.sequence;
      this.pending.set(requestId, { method, resolve, reject });
      this._setRef();
      try { worker.postMessage({ requestId, method, args }); }
      catch (error) {
        this.pending.delete(requestId);
        this._setRef();
        this._report(error);
        reject(error);
      }
    });
  }

  load(runId) { return this._request('load', [runId]); }
  flush() { return this._request('flush'); }
  remove(runId) { return this._request('remove', [runId]); }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.failed) { this.closePromise = Promise.reject(this.failed); return this.closePromise; }
    if (!this.worker) { this.closePromise = Promise.resolve(); return this.closePromise; }
    this.closePromise = new Promise((resolve, reject) => { this.resolveClose = resolve; this.rejectClose = reject; });
    // Resolve on exit, after the worker has flushed and closed its message port.
    this._request('close', [], true).catch(error => this.rejectClose(error));
    return this.closePromise;
  }
}

module.exports = { TaskProgressClient };
