'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 1000;
const clone = value => JSON.parse(JSON.stringify(value));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function taskId(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_CONVERSATION', '任务标识无效');
  }
  return value;
}
function webUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { fail('INVALID_URL', '恢复网址无效'); }
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)
    || !['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('INVALID_URL', '恢复仅支持 HTTP 和 HTTPS 网页');
  return url.href;
}
function record(input, now) {
  return { id: taskId(input.id), conversationId: taskId(input.conversationId), url: webUrl(input.url),
    title: String(input.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512), updatedAt: now };
}

/** A recovery index only: no cookies, permissions, observation IDs, selectors or leases. */
function createBrowserTaskState({ filePath, now = Date.now } = {}) {
  let data = { version: 1, tabs: [] };
  if (filePath && fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).size > 20 * 1024 * 1024) throw Error('Oversized browser recovery index');
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tabs) || saved.tabs.length > MAX_RECORDS) throw Error('Invalid browser recovery index');
      const ids = new Set();
      data.tabs = saved.tabs.map(value => {
        const item = record(value, Number.isFinite(value.updatedAt) ? value.updatedAt : 0);
        if (ids.has(item.id)) throw Error('Duplicate recovery id');
        ids.add(item.id); return item;
      });
    } catch (_) { fail('BROWSER_TASK_STATE_INVALID', '任务网页恢复记录读取失败，原文件已保留'); }
  }
  function commit(tabs) {
    if (filePath) {
      const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, tabs }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filePath);
      } catch (_) {
        try { fs.unlinkSync(temporary); } catch (_) {}
        fail('BROWSER_TASK_STATE_WRITE_FAILED', '任务网页恢复记录保存失败，请检查磁盘空间和目录权限');
      }
    }
    data = { version: 1, tabs };
  }
  return {
    list(conversationId) { taskId(conversationId); return clone(data.tabs.filter(item => item.conversationId === conversationId)); },
    upsert(input) {
      const item = record(input, now()), previous = data.tabs.find(value => value.id === item.id);
      if (previous && ['conversationId', 'url', 'title'].every(key => previous[key] === item[key])) return clone(previous);
      if (!previous && data.tabs.length >= MAX_RECORDS) fail('BROWSER_TASK_STATE_LIMIT', '任务网页恢复记录已达上限，请关闭不再使用的网页');
      commit([...data.tabs.filter(value => value.id !== item.id), item]); return clone(item);
    },
    remove(id) {
      taskId(id);
      if (data.tabs.some(value => value.id === id)) commit(data.tabs.filter(value => value.id !== id));
    },
  };
}

module.exports = { createBrowserTaskState, taskId };
