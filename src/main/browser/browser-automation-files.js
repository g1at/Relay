'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
function failure(code, message) { return Object.assign(new Error(message), { code, inputDispatched: false }); }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function workspace(context) {
  // Only the main process supplies this field. It is absent from every tool schema.
  const configured = context?.workspaceRoot;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw failure('BROWSER_WORKSPACE_REQUIRED', '当前任务没有可用的本机工作目录');
  try {
    const root = await fs.realpath(configured);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
    return root;
  } catch (_) { throw failure('BROWSER_WORKSPACE_REQUIRED', '当前任务工作目录不存在或不可访问'); }
}
function nativeUploadPath(value) {
  // The SDK may run in WSL while Electron and its file input run on Windows.
  if (process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(value)) return value[5].toUpperCase() + ':\\' + value.slice(7).replace(/\//g, '\\');
  return value;
}
async function resolveUploadFiles(context, requested) {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 16) throw failure('BROWSER_UPLOAD_FILES_INVALID', '每次上传需要 1 至 16 个任务目录内的文件');
  const root = await workspace(context), files = [], seen = new Set();
  let bytes = 0;
  for (const input of requested) {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0')) throw failure('BROWSER_UPLOAD_FILES_INVALID', '上传文件路径无效');
    const value = nativeUploadPath(input);
    if (process.platform === 'win32' && (value.startsWith('\\\\') || value.startsWith('//') || /(^|[\\/])[^\\/]*:/.test(value.replace(/^[a-z]:[\\/]/i, '')))) throw failure('BROWSER_UPLOAD_OUTSIDE_WORKSPACE', '仅支持任务工作目录内的本机文件');
    const candidate = path.resolve(root, value);
    if (!within(root, candidate)) throw failure('BROWSER_UPLOAD_OUTSIDE_WORKSPACE', '上传文件必须位于当前任务工作目录内');
    let actual, stat;
    try { actual = await fs.realpath(candidate); stat = await fs.stat(actual); }
    catch (_) { throw failure('BROWSER_UPLOAD_FILE_UNAVAILABLE', '上传文件不存在或不可访问'); }
    if (!within(root, actual)) throw failure('BROWSER_UPLOAD_OUTSIDE_WORKSPACE', '上传文件链接指向任务工作目录之外');
    if (!stat.isFile()) throw failure('BROWSER_UPLOAD_FILES_INVALID', '只能上传普通文件，不能上传目录或设备');
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (seen.has(key)) throw failure('BROWSER_UPLOAD_FILES_INVALID', '同一文件不能重复上传');
    bytes += stat.size;
    if (bytes > MAX_UPLOAD_BYTES) throw failure('BROWSER_UPLOAD_TOO_LARGE', '单次上传的文件总大小不能超过 100 MiB');
    seen.add(key); files.push(actual);
  }
  return { files, bytes };
}
async function resolveDownloadDirectory(context) {
  const root = await workspace(context), directory = path.join(root, 'browser-downloads');
  try {
    await fs.mkdir(directory, { recursive: true });
    const actual = await fs.realpath(directory);
    if (!within(root, actual)) throw failure('BROWSER_DOWNLOAD_OUTSIDE_WORKSPACE', '下载目录链接指向任务工作目录之外');
    if (!(await fs.stat(actual)).isDirectory()) throw new Error('not a directory');
    return actual;
  } catch (error) {
    if (error.code === 'BROWSER_DOWNLOAD_OUTSIDE_WORKSPACE') throw error;
    throw failure('BROWSER_DOWNLOAD_DIRECTORY_UNAVAILABLE', '无法创建当前任务的下载目录');
  }
}

module.exports = { resolveUploadFiles, resolveDownloadDirectory, MAX_UPLOAD_BYTES };
