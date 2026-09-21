'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PERMISSIONS = ['camera', 'microphone', 'location', 'notifications', 'clipboard'];
const clone = value => JSON.parse(JSON.stringify(value));
const clean = (value, max = 512) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function webUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_URL', '请输入有效的网址');
  let url; try { url = new URL(value); } catch (_) { fail('INVALID_URL', '请输入有效的网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(value).length > 16384) fail('INVALID_URL', '仅支持 HTTP 和 HTTPS 网址');
  return url.href;
}

function createBrowserProfileStore({ rootDir, downloadDirectory = '', now = Date.now, idFactory = () => crypto.randomUUID() } = {}) {
  const defaults = { webLinkTarget: 'internal', localLinkTarget: 'internal', showFullUrl: false,
    searchEngine: 'bing', downloadDirectory, askDownloadLocation: true };
  const file = rootDir ? path.join(rootDir, 'profile.json') : null;
  let data = { version: 1, settings: defaults, history: [], bookmarks: [], downloads: [], permissions: [] };
  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !['history', 'bookmarks', 'downloads', 'permissions'].every(key => Array.isArray(saved[key]))) throw Error('Invalid profile');
      data = { ...saved, settings: { ...defaults, ...saved.settings } };
      for (const item of data.downloads) if (['progressing', 'paused'].includes(item.state)) { item.state = 'interrupted'; item.canResume = false; }
    } catch (_) { fail('BROWSER_PROFILE_INVALID', '浏览器资料读取失败，原文件已保留'); }
  }
  function commit(change) {
    const next = clone(data), result = change(next);
    if (file) {
      fs.mkdirSync(rootDir, { recursive: true });
      const temporary = file + '.' + crypto.randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, file); }
      catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} fail('BROWSER_PROFILE_WRITE_FAILED', '浏览器资料保存失败，请检查磁盘空间和目录权限'); }
    }
    data = next; return clone(result === undefined ? { ok: true } : result);
  }
  function settings() { return clone(data.settings); }
  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('INVALID_SETTINGS', '浏览器设置无效');
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      if (['webLinkTarget', 'localLinkTarget'].includes(key)) {
        if (!['internal', 'external'].includes(value)) fail('INVALID_SETTINGS', '打开位置无效'); next[key] = value;
      } else if (['showFullUrl', 'askDownloadLocation'].includes(key)) {
        if (typeof value !== 'boolean') fail('INVALID_SETTINGS', '浏览器设置无效'); next[key] = value;
      } else if (key === 'searchEngine') {
        if (!['bing', 'google', 'duckduckgo'].includes(value)) fail('INVALID_SETTINGS', '搜索引擎无效'); next[key] = value;
      } else if (key === 'downloadDirectory') {
        if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/.test(value) || value && !path.isAbsolute(value)) fail('INVALID_SETTINGS', '下载目录必须是本机绝对路径');
        if (value && (!fs.existsSync(value) || !fs.statSync(value).isDirectory())) fail('INVALID_SETTINGS', '下载目录不存在'); next[key] = value;
      } else fail('INVALID_SETTINGS', '未知的浏览器设置');
    }
    return commit(state => (state.settings = { ...state.settings, ...next }));
  }
  function list(section, { query = '', limit = 100, offset = 0 } = {}) {
    if (!['history', 'bookmarks', 'downloads', 'permissions'].includes(section)) fail('INVALID_SECTION', '浏览器资料类型无效');
    const needle = clean(query, 200).toLowerCase();
    const items = data[section].filter(item => !needle || [item.url, item.title, item.filename, item.origin].some(value => String(value || '').toLowerCase().includes(needle)));
    const start = Math.max(0, Math.floor(Number(offset) || 0)), count = Math.max(1, Math.min(1000, Number(limit) || 100));
    return { items: clone(items.slice(start, start + count)), total: items.length };
  }
  function remove(section, id) {
    if (!['history', 'bookmarks', 'downloads'].includes(section)) fail('INVALID_SECTION', '浏览器资料类型无效');
    return commit(state => { state[section] = state[section].filter(item => item.id !== id); });
  }
  function clear(section) {
    if (!['history', 'permissions'].includes(section)) fail('INVALID_SECTION', '不能清除此类浏览器资料');
    return commit(state => { state[section] = []; });
  }
  function visit({ url, title = '', id }) {
    const target = webUrl(url);
    return commit(state => {
      let item = id && state.history.find(value => value.id === id && value.url === target);
      if (item) { item.title = clean(title) || item.title; return item; }
      if (id) return null;
      item = { id: idFactory(), url: target, title: clean(title) || target, visitedAt: new Date(now()).toISOString() };
      state.history.unshift(item); state.history = state.history.slice(0, 3000); return item;
    });
  }
  function bookmark({ url, title = '' }) {
    const target = webUrl(url);
    return commit(state => {
      let item = state.bookmarks.find(value => value.url === target);
      if (item) { item.title = clean(title) || item.title; return item; }
      if (state.bookmarks.length >= 1000) fail('BOOKMARK_LIMIT', '书签已达上限，请先删除部分书签');
      item = { id: idFactory(), url: target, title: clean(title) || target, createdAt: new Date(now()).toISOString() };
      state.bookmarks.unshift(item); return item;
    });
  }
  function download(value) {
    return commit(state => {
      let item = state.downloads.find(entry => entry.id === value.id);
      if (!item) { item = { id: value.id || idFactory(), url: webUrl(value.url), startedAt: new Date(now()).toISOString() }; state.downloads.unshift(item); }
      for (const key of ['filename', 'path', 'state', 'error']) if (value[key] !== undefined) item[key] = clean(value[key], key === 'path' ? 4096 : 512);
      for (const key of ['receivedBytes', 'totalBytes']) if (value[key] !== undefined) item[key] = Math.max(0, Number(value[key]) || 0);
      item.canResume = !!value.canResume; item.updatedAt = new Date(now()).toISOString();
      state.downloads = state.downloads.slice(0, 500); return item;
    });
  }
  function getDownload(id) { const item = data.downloads.find(value => value.id === id); return item ? clone(item) : null; }
  function permission(origin, key) {
    const normalized = new URL(webUrl(origin)).origin;
    if (!PERMISSIONS.includes(key)) fail('INVALID_PERMISSION', '不支持此网站权限');
    return data.permissions.find(item => item.origin === normalized && item.permission === key)?.decision || 'ask';
  }
  function setPermission({ origin, permission: key, decision }) {
    const normalized = new URL(webUrl(origin)).origin;
    if (!PERMISSIONS.includes(key) || !['ask', 'allow', 'block'].includes(decision)) fail('INVALID_PERMISSION', '网站权限设置无效');
    return commit(state => {
      state.permissions = state.permissions.filter(item => item.origin !== normalized || item.permission !== key);
      if (decision !== 'ask') state.permissions.push({ origin: normalized, permission: key, decision });
    });
  }
  function getBookmark(url) { const item = data.bookmarks.find(value => value.url === url); return item ? clone(item) : null; }
  return { rootDir, sessionPath: rootDir ? path.join(rootDir, 'session') : null, settings, updateSettings, list, remove, clear, getBookmark,
    visit, bookmark, download, getDownload, permission, setPermission };
}

module.exports = { createBrowserProfileStore, PERMISSIONS };
