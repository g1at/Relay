'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const { unpackPath } = require('../app/paths');

const MUTATIONS = new Set(['createDraft', 'publish', 'reject', 'rebaseDraft', 'rollback', 'stageProposals']);
const workerRoot = unpackPath(__dirname);
function failure(message, code) { return Object.assign(new Error(message), { code }); }

// One worker owns all draft requests. Never replay a mutation after losing its receipt.
class SkillDraftClient {
  constructor(options = {}) {
    if (!options.skillsDir || !options.draftsDir) throw new Error('SkillDraftClient requires skillsDir and draftsDir');
    this.workerFile = options.workerFile || path.join(workerRoot, 'skill-draft-worker.js');
    this.WorkerClass = options.WorkerClass || Worker;
    this.options = { skillsDir: path.resolve(options.skillsDir), draftsDir: path.resolve(options.draftsDir),
      stagingRoot: path.resolve(options.stagingRoot || path.join(options.draftsDir, 'sdk-proposals')) };
    this.worker = null;
    this.queue = [];
    this.active = null;
    this.sequence = 0;
    this.closing = false;
    this.closeSent = false;
    this.closePromise = null;
    this.workerFailed = false;
    this.exclusiveContext = new AsyncLocalStorage();
  }

  _start() {
    if (this.worker) return this.worker;
    const worker = new this.WorkerClass(this.workerFile, { workerData: this.options });
    this.worker = worker;
    this.workerFailed = false;
    worker.on('message', message => {
      if (this.worker !== worker || this.workerFailed || this.active?.kind !== 'worker' || message?.requestId !== this.active.requestId) return;
      const request = this.active;
      if (message.ok === true) {
        try {
          if (request.onCommitted) {
            const context = { active: true };
            try {
              const result = this.exclusiveContext.run(context, () => request.onCommitted(message.value));
              if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {});
                throw new TypeError('Skill draft onCommitted callback must be synchronous');
              }
            } finally { context.active = false; }
          }
          request.resolve(message.value);
        } catch (cause) {
          const error = failure('技能草稿已提交，但本地状态更新失败；请刷新确认，不要重复发布。', 'SKILL_DRAFT_COMMIT_HOOK_FAILED');
          error.cause = cause;
          error.committed = true;
          request.reject(error);
        }
      }
      else {
        const error = failure(message.error?.message || '技能草稿操作失败', message.error?.code || 'SKILL_DRAFT_FAILED');
        if (message.error?.details != null) error.details = message.error.details;
        if (Array.isArray(message.error?.drafts)) error.drafts = message.error.drafts;
        request.reject(error);
      }
      this.active = null;
      this._pump();
    });
    worker.once('error', error => this._failed(worker, error));
    worker.once('exit', code => {
      if (this.worker !== worker) return;
      if (!this.closeSent || code !== 0) this._failed(worker, failure(`技能草稿后台进程已退出 (${code})`, 'SKILL_DRAFT_WORKER_FAILED'));
      this.worker = null;
      this.workerFailed = false;
      this._pump();
    });
    worker.unref();
    return worker;
  }

  _failed(worker, cause) {
    if (this.worker !== worker || this.workerFailed) return;
    this.workerFailed = true;
    if (this.active?.kind === 'worker') {
      const mutation = MUTATIONS.has(this.active.method);
      this.active.reject(failure(mutation
        ? '技能草稿后台处理中断，操作结果尚未确认；请刷新列表核对后再操作。'
        : `技能草稿后台读取失败：${cause?.message || '进程退出'}`,
      mutation ? 'SKILL_DRAFT_RESULT_UNCONFIRMED' : 'SKILL_DRAFT_WORKER_FAILED'));
      this.active = null;
    }
    for (const request of this.queue.splice(0)) request.reject(failure('技能草稿后台进程已退出，此操作尚未执行。', 'SKILL_DRAFT_WORKER_FAILED'));
    // An error event precedes worker exit. Keep that instance reserved until exit.
  }

  _pump() {
    if (this.active || this.workerFailed) return;
    if (!this.queue.length) {
      if (this.closing) {
        if (!this.worker) { this.resolveClose?.(); return; }
        if (!this.closeSent) {
          this.closeSent = true;
          this.worker.ref();
          this.worker.postMessage({ type: 'close' });
        }
      } else this.worker?.unref();
      return;
    }
    const request = this.queue.shift();
    if (request.kind === 'exclusive') {
      this.active = request;
      this.worker?.ref();
      const context = { active: true };
      const complete = (ok, value) => {
        context.active = false;
        this.active = null;
        if (ok) request.resolve(value); else request.reject(value);
        this._pump();
      };
      // Reserve the queue until async callbacks settle too. No worker command can overlap.
      this.exclusiveContext.run(context, () => Promise.resolve().then(request.fn))
        .then(value => complete(true, value), error => complete(false, error));
      return;
    }
    try {
      const worker = this._start();
      this.active = request;
      worker.ref();
      worker.postMessage({ requestId: request.requestId, method: request.method, args: request.args });
    } catch (error) {
      // A construction/structured-clone failure cannot have dispatched this request.
      this.active = null;
      request.reject(error);
      this._pump();
    }
  }

  _request(method, args, fn = null, onCommitted = null) {
    if (this.exclusiveContext.getStore()?.active) return Promise.reject(failure('互斥操作内不能调用同一个技能草稿队列；请将后续操作放在回调外。', 'SKILL_DRAFT_REENTRANT'));
    if (this.closing) return Promise.reject(failure('技能草稿服务正在关闭', 'SKILL_DRAFT_CLOSED'));
    if (this.workerFailed) return Promise.reject(failure('技能草稿后台进程正在退出，请稍后刷新。', 'SKILL_DRAFT_WORKER_FAILED'));
    if (onCommitted != null && (typeof onCommitted !== 'function' || onCommitted.constructor?.name === 'AsyncFunction')) {
      return Promise.reject(new TypeError('Skill draft onCommitted callback must be synchronous'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ requestId: ++this.sequence, method, args, fn, onCommitted, kind: fn ? 'exclusive' : 'worker', resolve, reject });
      this._pump();
    });
  }

  list(filter) { return this._request('list', [filter]); }
  get(id) { return this._request('get', [id]); }
  diff(id) { return this._request('diff', [id]); }
  validate(id) { return this._request('validate', [id]); }
  createDraft(input) { return this._request('createDraft', [input]); }
  // These synchronous callbacks commit host metadata before another queued edit.
  // They run only after a successful worker receipt and are never sent to the worker.
  publish(id, onCommitted) { return this._request('publish', [id], null, onCommitted); }
  reject(id, reason) { return this._request('reject', [id, reason]); }
  rebaseDraft(id, options) { return this._request('rebaseDraft', [id, options]); }
  rollback(name, version, options, onCommitted) { return this._request('rollback', [name, version, options], null, onCommitted); }
  listHistory(name) { return this._request('listHistory', [name]); }
  stageProposals(input, options) { return this._request('stageProposals', [input, options]); }

  // Keep host-side skill-library writes in the same FIFO as publication. Callbacks
  // must not call this client recursively; await further work outside the callback.
  runExclusive(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('runExclusive requires a callback'));
    return this._request('runExclusive', [], fn);
  }

  close() {
    if (this.exclusiveContext.getStore()?.active) return Promise.reject(failure('互斥操作内不能关闭同一个技能草稿队列。', 'SKILL_DRAFT_REENTRANT'));
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise(resolve => { this.resolveClose = resolve; });
    this._pump();
    return this.closePromise;
  }
}

module.exports = { SkillDraftClient };
