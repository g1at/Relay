'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createBrowserPanelHost } = require('./browser-panel-host');
const { createBrowserProfileStore } = require('./browser-profile-store');

// Only the local main document owns browser tabs. Remote views never receive
// preload.js, and even a foreign renderer with a bridge cannot control them.
function registerBrowserPanelIpc({ ipcMain, getWindow, entryFile, createHost = createBrowserPanelHost,
  getElectron = () => require('electron'), profileRoot, profile: injectedProfile }) {
  const entryUrl = pathToFileURL(entryFile).href;
  let owner = null, host = null, disposed = false;
  let profile = injectedProfile;
  let formStore;
  const isTrusted = event => {
    const window = getWindow();
    try {
      return !!window && !window.isDestroyed() && !!event && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame
        && event.senderFrame.url.replace(/[?#].*$/, '') === entryUrl
        && window.webContents.getURL().replace(/[?#].*$/, '') === entryUrl;
    } catch (_) { return false; }
  };
  function getHost() {
    const window = getWindow();
    if (owner !== window || !host || host.isDestroyed()) {
      if (host) host.destroy();
      const { WebContentsView, session, shell, dialog, Menu, clipboard, app, safeStorage } = getElectron();
      if (!profile && (profileRoot || app)) profile = createBrowserProfileStore({ rootDir: profileRoot || path.join(app.getPath('userData'), 'browser'),
        downloadDirectory: app ? app.getPath('downloads') : '' });
      if (!formStore && profile?.rootDir) formStore = require('./browser-form-store').createBrowserFormStore({ filePath: path.join(profile.rootDir, 'forms.enc.json'), safeStorage });
      owner = window;
      const target = window;
      host = createHost({ owner: target, WebContentsView, session, shell, dialog, Menu, clipboard, profile, formStore,
        onEvent: payload => {
          if (!disposed && owner === target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
            target.webContents.send('browser:event', payload);
          }
        },
      });
    }
    return host;
  }
  ipcMain.handle('browser:invoke', async (event, input) => {
    if (disposed || !isTrusted(event)) return { ok: false, code: 'FORBIDDEN', error: '此窗口不能操作内置浏览器' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_ACTION', error: '浏览器操作无效' };
    try {
      // CSS geometry is measured in the renderer; the actual display scale is
      // owned by Electron, never trusted from the request or devicePixelRatio.
      const request = input.action === 'setBounds'
        ? { ...input, coordinateScale: event.sender.getZoomFactor() } : input;
      return await getHost().invoke(request);
    } catch (error) {
      const profileErrors = { BROWSER_PROFILE_INVALID: '浏览器资料读取失败，原文件已保留', BROWSER_PROFILE_WRITE_FAILED: '浏览器资料保存失败，请检查磁盘空间和目录权限' };
      if (Object.hasOwn(profileErrors, error?.code)) return { ok: false, code: error.code, error: profileErrors[error.code] };
      return { ok: false, code: 'BROWSER_FAILED', error: '浏览器暂时无法打开，请重试' };
    }
  });
  return {
    // Main-process entry for links opened by the mini window or Electron's
    // navigation guard. This does not grant those renderers browser control.
    async openLink(url) {
      const target = getWindow();
      if (disposed || !target || target.isDestroyed()) return { ok: false, error: '浏览器页面尚未就绪，请重试' };
      const response = await getHost().invoke({ action: 'openLink', url });
      if (response?.ok && response.tab && !disposed && target === getWindow()
        && !target.isDestroyed() && !target.webContents.isDestroyed()) {
        target.webContents.send('browser:event', { type: 'open-link', tab: response.tab });
      }
      return response;
    },
    dispose() {
      if (disposed) return;
      disposed = true; ipcMain.removeHandler('browser:invoke');
      if (host) host.destroy();
      host = null; owner = null;
    },
  };
}

module.exports = { registerBrowserPanelIpc };
