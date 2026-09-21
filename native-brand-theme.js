'use strict';

const path = require('node:path');
const { execFile: defaultExecFile } = require('node:child_process');
const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

function parseSystemDark(stdout) {
  const match = /^\s*SystemUsesLightTheme\s+REG_DWORD\s+(0x[0-9a-f]+|[01])\s*$/im.exec(String(stdout || ''));
  if (!match) return null;
  const value = Number(match[1]);
  return value === 0 ? true : value === 1 ? false : null;
}

// Electron's app-theme override also changes shouldUseDarkColors. Shell artwork
// instead follows the Windows system color, and only in Relay's System mode.
function createNativeBrandTheme({ nativeTheme, platform = process.platform,
  execFile = defaultExecFile, systemRoot = process.env.SystemRoot || 'C:\\Windows', onChange = () => {} }) {
  let systemDark = null, pending = null, disposed = false;
  function usesLightArtwork() {
    if (nativeTheme.themeSource !== 'system') return false;
    if (typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean') return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    return platform === 'win32' ? systemDark === true : nativeTheme.shouldUseDarkColors === true;
  }
  function refresh() {
    if (disposed || platform !== 'win32' || nativeTheme.themeSource !== 'system'
      || typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean') return Promise.resolve(usesLightArtwork());
    if (pending) return pending;
    // Current Electron 32 has no separate system-theme API. Read only this
    // documented value asynchronously; never block startup or rewrite OS theme.
    pending = new Promise(resolve => {
      const finish = (error, stdout) => {
        const next = error ? null : parseSystemDark(stdout);
        if (!disposed && next !== systemDark) { systemDark = next; onChange(); }
        resolve(usesLightArtwork());
      };
      try {
        execFile(path.win32.join(systemRoot, 'System32', 'reg.exe'), ['query', PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'],
          { windowsHide: true, timeout: 1500, maxBuffer: 8192, encoding: 'utf8' }, finish);
      } catch (error) { finish(error); }
    }).finally(() => { pending = null; });
    return pending;
  }
  return { usesLightArtwork, refresh, dispose() { disposed = true; } };
}

module.exports = { createNativeBrandTheme, parseSystemDark };
