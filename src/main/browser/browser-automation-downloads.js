'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_TIMEOUT_MS = 30000;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function filenameFor(value) {
  let name = String(value || 'download').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').slice(0, 180).replace(/[. ]+$/, '') || 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

/** A single DownloadItem capture, called only from the host's existing listener. */
function createAutomationDownload({ directory, signal, check = () => {}, timeoutMs = MAX_DOWNLOAD_TIMEOUT_MS,
  maxBytes = MAX_DOWNLOAD_BYTES, onSettled = () => {} } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('BROWSER_DOWNLOAD_DIRECTORY', '下载需要当前任务的可信绝对目录');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DOWNLOAD_TIMEOUT_MS) throw failure('BROWSER_DOWNLOAD_TIMEOUT_INVALID', '下载等待时间必须在 1 到 30000 毫秒之间');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_BYTES) throw failure('BROWSER_DOWNLOAD_LIMIT_INVALID', '下载上限不得超过 100 MB');
  function guard() {
    if (signal?.aborted) throw failure('BROWSER_DOWNLOAD_CANCELLED', '下载已随任务取消');
    const result = check();
    if (signal?.aborted) throw failure('BROWSER_DOWNLOAD_CANCELLED', '下载已随任务取消');
    if (result && typeof result.then === 'function') throw failure('BROWSER_DOWNLOAD_CHECK_INVALID', '下载授权检查必须同步完成');
  }
  guard();
  let directoryPath;
  try { fs.mkdirSync(directory, { recursive: true }); directoryPath = fs.mkdtempSync(path.join(fs.realpathSync(directory), 'download-')); }
  catch (_) { throw failure('BROWSER_DOWNLOAD_DIRECTORY', '无法创建任务下载目录'); }
  const id = crypto.randomUUID(), partialPath = path.join(directoryPath, '.relay-partial-' + id);
  let item = null, armed = false, settled = false, nativeDone = false, verifying = false, stream = null, metadata = null, publishedPath = null;
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Cancellation may race the caller's first await. Keep the rejection observed.
  result.catch(() => {});
  function cleanup(attempt = 0) {
    let retry = false;
    for (const file of [partialPath, partialPath + '.crdownload', publishedPath].filter(Boolean)) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') retry = true; }
    }
    try { fs.rmdirSync(directoryPath); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) retry = true; }
    if (retry && attempt < 8) { const timer = setTimeout(() => cleanup(attempt + 1), 250); timer.unref?.(); }
  }
  function detach() {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    item?.removeListener('updated', onUpdated); item?.removeListener('done', onDone);
  }
  function fail(error) {
    if (settled) return;
    settled = true; detach(); stream?.destroy();
    if (item && !nativeDone) {
      // Chromium can hold the partial file briefly on Windows after cancel().
      const afterDone = () => cleanup();
      item.once('done', afterDone);
      const retire = setTimeout(() => item.removeListener('done', afterDone), 2500); retire.unref?.();
      try { item.cancel(); } catch (_) {}
    }
    cleanup();
    const errorResult = error?.code ? error : failure('BROWSER_DOWNLOAD_FAILED', '下载未完成或无法核验文件');
    reject(errorResult);
    try { onSettled(null, errorResult); } catch (_) {}
  }
  function checkSize() {
    const received = item.getReceivedBytes(), total = item.getTotalBytes();
    if (!Number.isFinite(received) || received < 0 || !Number.isFinite(total)) throw failure('BROWSER_DOWNLOAD_BYTES_INVALID', '浏览器未返回有效的下载字节数');
    if (received > maxBytes || total > maxBytes) throw failure('BROWSER_DOWNLOAD_TOO_LARGE', '下载文件超过本次大小上限');
    return { received, total };
  }
  function onUpdated(_event, state) {
    try {
      guard(); checkSize();
      if (state === 'interrupted') throw failure('BROWSER_DOWNLOAD_INTERRUPTED', '下载中断，未生成已验证文件');
    } catch (error) { fail(error); }
  }
  async function verifyCompleted() {
    guard();
    const bytes = checkSize(), before = fs.lstatSync(partialPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || before.size !== bytes.received || bytes.total > 0 && before.size !== bytes.total) {
      throw failure('BROWSER_DOWNLOAD_SIZE_MISMATCH', '下载文件字节数与浏览器记录不一致');
    }
    const hash = crypto.createHash('sha256'); let read = 0;
    stream = fs.createReadStream(partialPath, { highWaterMark: 65536 });
    for await (const chunk of stream) {
      if (settled) return;
      guard(); read += chunk.length;
      if (read > maxBytes) throw failure('BROWSER_DOWNLOAD_TOO_LARGE', '下载文件超过本次大小上限');
      hash.update(chunk);
    }
    stream = null;
    if (settled) return;
    guard();
    const after = fs.lstatSync(partialPath);
    if (!after.isFile() || after.isSymbolicLink() || read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino || after.dev !== before.dev) throw failure('BROWSER_DOWNLOAD_CHANGED', '下载文件在核验期间发生变化');
    const finalPath = path.join(directoryPath, metadata.filename);
    // Hard-link publication is exclusive: an existing filename is never replaced.
    // Both names live in the fresh task subdirectory, on the same filesystem.
    try { fs.linkSync(partialPath, finalPath); publishedPath = finalPath; fs.unlinkSync(partialPath); }
    catch (_) { throw failure('BROWSER_DOWNLOAD_PUBLISH_FAILED', '无法独占保存已验证的下载文件'); }
    settled = true; detach();
    const completed = { id, state: 'completed', path: finalPath, filename: metadata.filename, size: read, sha256: hash.digest('hex'), url: metadata.url };
    resolve(completed); try { onSettled(completed, null); } catch (_) {}
  }
  function onDone(_event, state) {
    if (settled || verifying) return;
    nativeDone = true;
    if (state !== 'completed') { fail(failure(state === 'cancelled' ? 'BROWSER_DOWNLOAD_CANCELLED' : 'BROWSER_DOWNLOAD_INTERRUPTED', '下载未完成，未生成已验证文件')); return; }
    verifying = true;
    void verifyCompleted().catch(error => fail(error));
  }
  const onAbort = () => fail(failure('BROWSER_DOWNLOAD_CANCELLED', '下载已随任务取消'));
  const timer = setTimeout(() => fail(failure('BROWSER_DOWNLOAD_TIMEOUT', '等待下载完成超时，未生成已验证文件')), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    result,
    arm() {
      if (settled || item) throw failure('BROWSER_DOWNLOAD_CLOSED', '下载期待已失效，请重新登记');
      guard(); armed = true;
    },
    get consumed() { return !!item; },
    cancel(reason) { fail(reason instanceof Error ? reason : failure('BROWSER_DOWNLOAD_CANCELLED', '下载已取消')); },
    accept(nextItem, { filename, url } = {}) {
      if (settled || item || !armed) return false;
      try {
        guard(); item = nextItem; metadata = { filename: filenameFor(filename), url: String(url || '') };
        checkSize();
        item.on('updated', onUpdated); item.once('done', onDone);
        item.setSavePath(partialPath);
        return true;
      } catch (error) { fail(error); return false; }
    },
  };
}

module.exports = { createAutomationDownload, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_TIMEOUT_MS };
