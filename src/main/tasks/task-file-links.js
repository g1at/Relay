'use strict';

const path = require('node:path');
const marked = require('../../../renderer/vendor/marked.umd.js');
const { parse: parseLocalLink } = require('../../../renderer/local-file-links');
const windowsPath = value => /^[a-z]:[\\/]/i.test(value || '') || /^(?:\\\\|\/\/)/.test(value || '');

function resolveLocation(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (windowsPath(value)) return path.win32.resolve(value);
  if (path.posix.isAbsolute(value)) return path.posix.resolve(value);
  return windowsPath(cwd) ? path.win32.resolve(cwd, value) : path.posix.resolve(cwd || '/', value);
}

// Lexical comparison only: callers performing file operations must also check
// realpaths, ownership and symlinks. Windows drive paths and WSL aliases agree.
function locationKey(value, cwd) {
  value = resolveLocation(value, cwd);
  if (!value) return null;
  const mounted = /^\/mnt\/([a-z])(?:\/|$)/i.exec(value);
  if (mounted) value = mounted[1] + ':/' + value.slice(mounted[0].length);
  return windowsPath(value)
    ? 'win:' + path.win32.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    : 'posix:' + value.replace(/\/$/, '');
}
function isWithinLocation(file, root, cwd) {
  const key = locationKey(file, cwd), base = locationKey(root, cwd);
  return !!key && !!base && (key === base || key.startsWith(base + '/'));
}

function localFileLinkEntries(message, cwd) {
  if (typeof message !== 'string' || !message) return [];
  // Protection callers must not mistake an incomplete scan for an empty result.
  if (message.length > 256 * 1024) throw Object.assign(new RangeError('本地文件引用内容过长，无法完整检查。'), { code: 'LOCAL_FILE_LINKS_TOO_LARGE' });
  const links = [];
  try {
    // The lexer handles reference links, images, angle paths and parentheses.
    // Code blocks, inline code and raw HTML are not delivered Markdown links.
    marked.walkTokens(marked.lexer(message), token => {
      if (!['link', 'image'].includes(token.type)) return;
      const parsed = parseLocalLink(token.href);
      if (!parsed) return;
      const resolved = resolveLocation(parsed.path, cwd);
      if (resolved) links.push({ path: resolved, rawPath: parsed.path });
    });
  } catch (cause) {
    throw Object.assign(new Error('本地文件引用无法完整解析。', { cause }), { code: 'LOCAL_FILE_LINKS_PARSE_FAILED' });
  }
  return links;
}
function localFileLinks(message, cwd) {
  const seen = new Set();
  return localFileLinkEntries(message, cwd).filter(link => {
    const key = locationKey(link.path);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(link => link.path);
}

module.exports = { locationKey, isWithinLocation, localFileLinks, localFileLinkEntries };
