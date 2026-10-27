'use strict';

const RETRY_DELAYS_MS = Object.freeze([50, 150, 350, 750]);
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry a fresh synchronous store mutation, never a network request or a cached
// state snapshot. A rejected atomic replace leaves the previous file in place.
async function retryProviderWrite(operation, { sleep = delay } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (error?.code !== 'PROVIDER_STORAGE_WRITE_FAILED') throw error;
      error.attempts = attempt;
      const retryable = error.retryable === true && TRANSIENT_WRITE_CODES.has(error.storageCode);
      if (!retryable || attempt > RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
}

function providerWriteFailure(error, fallback = '服务商操作失败') {
  if (error?.code !== 'PROVIDER_STORAGE_WRITE_FAILED') {
    return { ok: false, message: error?.message || fallback };
  }
  const outcome = Number(error.attempts) > 1 ? '自动重试后仍未保存' : '未保存';
  let message = '服务商配置未保存，请稍后重试。';
  if (error.storageCode === 'EPERM') {
    message = `配置文件暂时无法替换，${outcome}。请稍后重试；若持续失败，请检查文件占用或权限。`;
  } else if (error.storageCode === 'EBUSY') {
    message = `配置文件正被占用，${outcome}。请稍后重试。`;
  } else if (error.storageCode === 'EACCES' || error.storageCode === 'EROFS') {
    message = '服务商配置未保存，请检查配置文件的写入权限后重试。';
  } else if (error.storageCode === 'ENOSPC' || error.storageCode === 'EDQUOT') {
    message = '磁盘可用空间不足，服务商配置未保存。请释放空间后重试。';
  }
  return {
    ok: false,
    code: 'PROVIDER_STORAGE_WRITE_FAILED',
    message,
    retryable: error.retryable === true,
    attempts: Number(error.attempts) || 1,
  };
}

module.exports = { retryProviderWrite, providerWriteFailure, RETRY_DELAYS_MS };
