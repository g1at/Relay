'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resourcePath } = require('./paths');

const CHANNEL = 'dialog:openAttachments';
const failure = (code, message) => Object.assign(new Error(message), { code });
function registerNativeAttachmentDialog(options) {
  const { ipcMain, getWindow, dialog } = options;
  if (!ipcMain || typeof getWindow !== 'function') throw new TypeError('Native attachment registration requires ipcMain and getWindow');
  const platform = options.platform || process.platform, paths = platform === 'win32' ? path.win32 : path;
  const filesystem = options.fs || fs;
  const expectedURL = options.rendererURL || pathToFileURL(resourcePath('renderer', 'index.html')).href;
  const operations = new Map();
  let disposed = false;
  function canonicalURL(value) {
    try { const url = new URL(value); url.hash = ''; url.search = ''; return platform === 'win32' ? url.href.toLowerCase() : url.href; }
    catch (_) { return ''; }
  }
  function authorize(event, expectedWindow) {
    const window = getWindow(), sender = event?.sender;
    if (disposed || !window || window.isDestroyed() || expectedWindow && window !== expectedWindow
      || sender !== window.webContents || !sender || sender.isDestroyed()
      || !event.senderFrame || event.senderFrame !== sender.mainFrame
      || canonicalURL(event.senderFrame.url) !== canonicalURL(expectedURL)) throw failure('UNTRUSTED_SENDER', '此窗口不能打开附件选择');
    return window;
  }
  async function metadata(selected) {
    if (!Array.isArray(selected) || selected.length > 2048) throw failure('INVALID_RESULT', '附件选择结果无效或数量过多');
    const seen = new Set(), items = [];
    for (const input of selected) {
      if (typeof input !== 'string' || input.includes('\0') || !paths.isAbsolute(input)) throw failure('INVALID_RESULT', '附件选择返回了无效路径');
      const full = await filesystem.promises.realpath(input), key = platform === 'win32' ? full.toLowerCase() : full;
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = await filesystem.promises.stat(full), isDirectory = stat.isDirectory();
      if (!isDirectory && !stat.isFile()) throw failure('INVALID_RESULT', '只能添加文件或文件夹');
      items.push({ path: full, name: paths.basename(full) || full, isDirectory, ext: isDirectory ? 'folder' : paths.extname(full).slice(1).toLowerCase(), size: isDirectory ? 0 : stat.size });
    }
    return items;
  }
  ipcMain.handle(CHANNEL, async (event, input = {}) => {
    const window = authorize(event), owner = event.sender;
    const defaultPath = input?.defaultPath;
    const kind = input?.kind ?? 'files';
    if (!['files', 'folders'].includes(kind)) throw failure('INVALID_KIND', '附件选择类型无效');
    if (defaultPath != null && (typeof defaultPath !== 'string' || defaultPath.includes('\0') || defaultPath.length > 32767 || defaultPath && !paths.isAbsolute(defaultPath))) throw failure('INVALID_PATH', '初始文件夹路径无效');
    if (operations.has(owner)) throw failure('DIALOG_BUSY', '附件选择窗口已经打开');
    const operation = { cancelled: false }, listeners = [];
    operations.set(owner, operation);
    const abort = () => { operation.cancelled = true; };
    const listen = (target, eventName, callback) => { target.on(eventName, callback); listeners.push([target, eventName, callback]); };
    listen(window, 'closed', abort); listen(owner, 'destroyed', abort); listen(owner, 'render-process-gone', abort);
    listen(owner, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) abort(); });
    try {
      if (!dialog?.showOpenDialog) throw failure('NATIVE_DIALOG_UNAVAILABLE', '系统附件选择不可用');
      // Electron owns modality and the standard system controls. Keep file and
      // folder modes separate; mixed flags do not work consistently on Windows.
      const result = await dialog.showOpenDialog(window, {
        title: kind === 'folders' ? '选择文件夹' : '选择文件',
        properties: [kind === 'folders' ? 'openDirectory' : 'openFile', 'multiSelections'],
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (operation.cancelled) throw failure('DIALOG_ABORTED', '附件选择已关闭');
      authorize(event, window);
      if (!result || typeof result.canceled !== 'boolean') throw failure('INVALID_RESULT', '系统附件选择返回了无效结果');
      const items = await metadata(result.canceled ? [] : result.filePaths);
      if (operation.cancelled) throw failure('DIALOG_ABORTED', '附件选择已关闭');
      authorize(event, window); return items;
    } finally {
      for (const [target, name, callback] of listeners) target.removeListener(name, callback);
      if (operations.get(owner) === operation) operations.delete(owner);
    }
  });
  return { dispose() { if (disposed) return; disposed = true; ipcMain.removeHandler(CHANNEL); for (const operation of operations.values()) operation.cancelled = true; } };
}
module.exports = { registerNativeAttachmentDialog, CHANNEL };
