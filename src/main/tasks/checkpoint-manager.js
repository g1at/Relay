'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function fileHashAsync(file, budget = {}) {
  const signal = budget.signal || null;
  try {
    throwIfAborted(signal);
    const stat = await awaitWithSignal(() => fs.promises.stat(file), signal);
    throwIfAborted(signal);
    if (!stat.isFile()) return { exists: true, regular: false, size: stat.size, sha256: null };
    const maxFileBytes = Number.isFinite(budget.maxFileBytes) ? budget.maxFileBytes : 128 * 1024 * 1024;
    if (stat.size > maxFileBytes || (Number.isFinite(budget.remainingBytes) && stat.size > budget.remainingBytes)) {
      return {
        exists: true, regular: true, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs),
        sha256: null, unverifiable: 'size_budget',
      };
    }
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file);
      let settled = false;
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        const error = abortReason(signal);
        stream.destroy(error);
        finish(error);
      };
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', (error) => finish(error));
      stream.once('end', () => finish());
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    throwIfAborted(signal);
    return {
      exists: true, regular: true, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs),
      sha256: hash.digest('hex'),
    };
  } catch (error) {
    if (isOperationAbort(error)) throw error;
    if (error && error.code === 'ENOENT') return { exists: false, regular: false, size: 0, sha256: null };
    return { exists: null, regular: false, size: null, sha256: null, error: error.message };
  }
}

function operationTimeout(code, message) {
  const error = new Error(message);
  error.code = code;
  error.operationTimeout = true;
  return error;
}

function abortReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error('检查点操作已取消');
  error.name = 'AbortError';
  error.code = 'CHECKPOINT_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortReason(signal);
}

function isOperationAbort(error) {
  return !!(error && (error.operationTimeout || error.name === 'AbortError'
    || error.code === 'CHECKPOINT_ABORTED'));
}

function awaitWithSignal(factory, signal) {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve().then(factory);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(factory).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function withOperationDeadline(timeoutMs, code, message, operation) {
  const controller = new AbortController();
  const timeoutError = operationTimeout(code, message);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    return await awaitWithSignal(() => operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sameFingerprint(left, right) {
  if (!left || !right) return false;
  return left.exists === right.exists
    && left.regular === right.regular
    && left.size === right.size
    && left.sha256 === right.sha256;
}

class CheckpointManager {
  constructor(options = {}) {
    if (!options.rootDir) throw new Error('CheckpointManager requires rootDir');
    this.rootDir = path.resolve(options.rootDir);
    this.recordsDir = path.join(this.rootDir, 'records');
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.previewTimeoutMs = Number.isFinite(options.previewTimeoutMs)
      ? Math.max(100, Number(options.previewTimeoutMs)) : 15_000;
    this.rollbackTimeoutMs = Number.isFinite(options.rollbackTimeoutMs)
      ? Math.max(100, Number(options.rollbackTimeoutMs)) : 30_000;
    this.abortConfirmationTimeoutMs = Number.isFinite(options.abortConfirmationTimeoutMs)
      ? Math.max(100, Number(options.abortConfirmationTimeoutMs)) : 5_000;
    this.hashFile = typeof options.fileHashAsync === 'function' ? options.fileHashAsync : fileHashAsync;
    this.adapters = new Map();
    fs.mkdirSync(this.recordsDir, { recursive: true });
  }

  _at() { return this.now().toISOString(); }

  _file(runId) {
    if (!VALID_ID.test(String(runId || ''))) throw new Error('Invalid checkpoint runId');
    return path.join(this.recordsDir, `${runId}.json`);
  }

  _write(record) {
    atomicJson(this._file(record.runId), record);
    return clone(record);
  }

  register(input = {}) {
    const runId = String(input.runId || '');
    const userMessageId = String(input.userMessageId || '');
    if (!VALID_ID.test(runId)) throw new Error('Invalid checkpoint runId');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(userMessageId)) {
      throw new Error('Checkpoint userMessageId must be a UUID');
    }
    const existing = this.get(runId);
    if (existing) return existing;
    return this._write({
      schemaVersion: 1,
      runId,
      userMessageId,
      conversationId: input.conversationId || null,
      sessionKey: input.sessionKey || null,
      workspace: input.workspace || null,
      status: 'tracking',
      createdAt: this._at(),
      updatedAt: this._at(),
      preview: null,
      rollback: null,
      unavailableReason: null,
    });
  }

  attach(runId, adapter) {
    if (!adapter || typeof adapter.rewindFiles !== 'function') {
      throw new Error('Checkpoint adapter requires rewindFiles()');
    }
    this.adapters.set(String(runId), adapter);
  }

  detach(runId) { this.adapters.delete(String(runId)); }

  get(runId) {
    try { return JSON.parse(fs.readFileSync(this._file(runId), 'utf8')); }
    catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  list(filter = {}) {
    let names = [];
    try { names = fs.readdirSync(this.recordsDir); } catch (_) { return []; }
    return names.filter((name) => name.endsWith('.json')).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.recordsDir, name), 'utf8')); }
      catch (_) { return null; }
    }).filter(Boolean).filter((record) => (
      !filter.conversationId || record.conversationId === filter.conversationId
    )).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone);
  }

  publicRecord(record) {
    if (!record) return null;
    return clone({
      schemaVersion: record.schemaVersion,
      runId: record.runId,
      conversationId: record.conversationId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      preview: record.preview && {
        canRewind: record.preview.canRewind,
        error: record.preview.error || null,
        filesChanged: record.preview.filesChanged || [],
        totalFilesChanged: Number(record.preview.totalFilesChanged || (record.preview.filesChanged || []).length),
        insertions: record.preview.insertions || 0,
        deletions: record.preview.deletions || 0,
        capturedAt: record.preview.capturedAt,
      },
      rollback: record.rollback,
      available: this.adapters.has(record.runId),
      unavailableReason: record.unavailableReason || null,
    });
  }

  async preview(runId) {
    const record = this.get(runId);
    if (!record) throw new Error('Checkpoint not found');
    const adapter = this.adapters.get(String(runId));
    if (!adapter) {
      record.status = 'unavailable';
      record.unavailableReason = '原执行会话已经结束，无法再通过 Relay 一键撤销本任务的文件修改';
      record.updatedAt = this._at();
      this._write(record);
      return this.publicRecord(record);
    }
    try {
      return await withOperationDeadline(
        this.previewTimeoutMs,
        'CHECKPOINT_PREVIEW_TIMEOUT',
        `文件检查点预览超时（${Math.ceil(this.previewTimeoutMs / 1000)} 秒）`,
        async (signal) => {
          const result = await awaitWithSignal(
            () => adapter.rewindFiles(record.userMessageId, { dryRun: true }),
            signal,
          );
          throwIfAborted(signal);
          const allFiles = Array.isArray(result && result.filesChanged)
            ? [...new Set(result.filesChanged.map((file) => path.resolve(String(file))))]
            : [];
          const tooManyFiles = allFiles.length > 200;
          // rewindFiles 会回退整轮，不能只校验前 200 项后仍允许覆盖其余文件。
          // 超过安全上限时保留可审阅的前 200 项，但整轮强制不可自动回退。
          const files = allFiles.slice(0, 200);
          const fingerprints = {};
          const totalBudget = 512 * 1024 * 1024;
          let remainingBytes = totalBudget;
          let overBudget = tooManyFiles;
          for (const file of files) {
            throwIfAborted(signal);
            fingerprints[file] = await awaitWithSignal(
              () => this.hashFile(file, { remainingBytes, signal }),
              signal,
            );
            if (fingerprints[file].unverifiable) overBudget = true;
            else if (fingerprints[file].exists && fingerprints[file].regular) {
              remainingBytes -= fingerprints[file].size;
            }
          }
          throwIfAborted(signal);
          record.preview = {
            canRewind: !!(result && result.canRewind) && !overBudget,
            error: overBudget
              ? (tooManyFiles
                ? `本轮改动了 ${allFiles.length} 个文件，超过 200 个文件的自动回退安全上限；请手动检查或缩小任务范围`
                : '变更文件超过安全校验预算，Relay 不会自动覆盖；请手动检查或缩小任务范围')
              : (result && result.error || null),
            filesChanged: files,
            totalFilesChanged: allFiles.length,
            insertions: Number(result && result.insertions) || 0,
            deletions: Number(result && result.deletions) || 0,
            fingerprints,
            capturedAt: this._at(),
          };
          record.status = record.preview.canRewind && files.length ? 'ready' : 'empty';
          record.updatedAt = this._at();
          record.unavailableReason = null;
          throwIfAborted(signal);
          return this.publicRecord(this._write(record));
        },
      );
    } catch (error) {
      if (error && error.code === 'CHECKPOINT_PREVIEW_TIMEOUT') {
        // SDK、文件 stat/read/hash 任一阶段超时都让当前适配器失效。预览是只读操作，
        // 可在发出回收请求后立即解除工作区锁；迟到结果会被 signal 拦截，不能覆盖状态。
        try {
          if (typeof adapter.abort === 'function') Promise.resolve(adapter.abort()).catch(() => {});
        } catch (_) {}
        this.markUnavailable(runId, '文件检查点预览超时，已释放工作区；本轮不再支持自动回退');
      }
      throw error;
    }
  }

  async rollback(runId) {
    const record = this.get(runId);
    if (!record || !record.preview) throw new Error('请先预览本轮文件变更');
    if (!record.preview.canRewind) throw new Error(record.preview.error || '当前检查点不可回退');
    const adapter = this.adapters.get(String(runId));
    if (!adapter) throw new Error('原执行会话已经结束，无法回退');
    let phase = 'validate';
    try {
      return await withOperationDeadline(
        this.rollbackTimeoutMs,
        'CHECKPOINT_ROLLBACK_TIMEOUT',
        `文件回退超时（${Math.ceil(this.rollbackTimeoutMs / 1000)} 秒）`,
        async (signal) => {
          const conflicts = [];
          let remainingBytes = 512 * 1024 * 1024;
          for (const file of record.preview.filesChanged || []) {
            throwIfAborted(signal);
            const expected = record.preview.fingerprints && record.preview.fingerprints[file];
            const actual = await awaitWithSignal(
              () => this.hashFile(file, { remainingBytes, signal }),
              signal,
            );
            if (actual.exists && actual.regular && !actual.unverifiable) remainingBytes -= actual.size;
            if (!sameFingerprint(expected, actual)) conflicts.push(file);
          }
          if (conflicts.length) {
            const error = new Error('文件在任务完成后又被修改，已阻止覆盖');
            error.code = 'CHECKPOINT_CONFLICT';
            error.conflicts = conflicts;
            throw error;
          }

          throwIfAborted(signal);
          phase = 'rewind';
          const result = await awaitWithSignal(
            () => adapter.rewindFiles(record.userMessageId, { dryRun: false }),
            signal,
          );
          throwIfAborted(signal);
          if (!result || !result.canRewind) throw new Error(result && result.error || '文件回退失败');
          record.status = 'rolled_back';
          record.rollback = {
            at: this._at(),
            filesChanged: Array.isArray(result.filesChanged) ? result.filesChanged : record.preview.filesChanged,
            skippedLinks: Number(result.skippedLinks) || 0,
          };
          record.updatedAt = record.rollback.at;
          throwIfAborted(signal);
          return this.publicRecord(this._write(record));
        },
      );
    } catch (error) {
      if (!error || error.code !== 'CHECKPOINT_ROLLBACK_TIMEOUT') throw error;
      if (phase !== 'rewind') {
        this.markUnavailable(runId, '回退前的文件安全校验超时；未写入文件，本轮自动回退已停用');
        throw error;
      }

      // dryRun:false 可能已经改写了部分文件。此时必须先等执行器确认关闭，调用方才能
      // 在 finally 中释放工作区锁；否则迟到的回退会与下一轮任务并发写同一目录。
      let stopped = false;
      if (typeof adapter.abort === 'function') {
        const stopConfirmation = Promise.resolve().then(() => adapter.abort()).then(
          (confirmation) => !!(confirmation && confirmation.stopConfirmed === true),
          () => false,
        );
        try {
          stopped = await withOperationDeadline(
            this.abortConfirmationTimeoutMs,
            'CHECKPOINT_ABORT_CONFIRM_TIMEOUT',
            `等待回退执行器停止超时（${Math.ceil(this.abortConfirmationTimeoutMs / 1000)} 秒）`,
            (signal) => awaitWithSignal(() => stopConfirmation, signal),
          );
        } catch (confirmationError) {
          if (confirmationError && confirmationError.code === 'CHECKPOINT_ABORT_CONFIRM_TIMEOUT') {
            // 先让 IPC 返回明确的“不确定/仍锁定”终态；如果执行器之后真的关闭，main
            // 会消费这个 Promise 并安全解锁，而不是要求用户重启应用。
            error.releaseCheckpointLockWhen = stopConfirmation;
          }
        }
      }
      this.markUnavailable(
        runId,
        stopped
          ? '文件回退超时，执行器已停止；回退结果不确定，请检查工作区后再继续'
          : '文件回退超时且无法确认执行器已停止；为保护工作区，当前目录保持锁定',
      );
      error.code = 'ROLLBACK_OUTCOME_UNKNOWN';
      error.message = stopped
        ? '文件回退超时，执行器已停止；部分文件可能已经变化，请检查工作区'
        : '文件回退超时，且无法确认执行器已经停止';
      error.holdCheckpointLock = !stopped;
      throw error;
    }
  }

  markUnavailable(runId, reason) {
    const record = this.get(runId);
    this.detach(runId);
    if (!record || record.status === 'rolled_back') return this.publicRecord(record);
    record.status = 'unavailable';
    record.unavailableReason = String(reason || '原执行会话已经结束');
    record.updatedAt = this._at();
    return this.publicRecord(this._write(record));
  }
}

module.exports = { CheckpointManager, fileHashAsync, sameFingerprint };
