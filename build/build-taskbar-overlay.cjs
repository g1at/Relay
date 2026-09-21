'use strict';
// Offline Windows x64 build. MinGW-w64 g++ must already be installed; no package
// install, header download, Electron rebuild, or user runtime compiler is needed.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw Error('The taskbar overlay build currently supports Windows x64 only');
}
const root = path.resolve(__dirname, '..');
const compiler = process.env.RELAY_TASKBAR_CXX || 'g++.exe';
const directory = path.join(root, 'renderer', 'taskbar-badges', 'native');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'win32-x64.node');
const result = spawnSync(compiler, [
  '-std=c++17', '-O2', '-shared', '-static', '-s', '-Wl,--no-insert-timestamp',
  path.join(__dirname, 'taskbar-overlay-win.cc'), '-o', output,
  '-lole32', '-luuid', '-luser32', '-lgdi32',
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || 'Taskbar overlay build failed');
const addon = require(output);
if (typeof addon.getOverlaySize !== 'function' || typeof addon.setOverlayIcon !== 'function')
  throw Error('Taskbar overlay exports are missing');
console.log('Built Node-API Windows x64 taskbar overlay: ' + output);
