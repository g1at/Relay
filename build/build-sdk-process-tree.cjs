'use strict';
// Offline Windows x64 build: shipped Node-API addon and launcher have no compiler,
// Python, PowerShell, or Node/Electron-header dependency at application runtime.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('SDK process tree build requires Windows x64');
const root = path.resolve(__dirname, '..'), directory = path.join(root, 'src/main/sdk/native');
fs.mkdirSync(directory, { recursive: true });
const compiler = process.env.RELAY_SDK_CXX || 'g++.exe';
for (const [source, output, flags] of [
  ['sdk-job-control-win.cc', 'win32-x64.node', ['-shared']],
  ['sdk-job-launcher-win.cc', 'sdk-job-launcher-win32-x64.exe', ['-municode']],
]) {
  const result = spawnSync(compiler, ['-std=c++17', '-O2', '-static', '-s', '-Wl,--no-insert-timestamp',
    ...flags, path.join(__dirname, source), '-o', path.join(directory, output)], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || 'SDK Job build failed');
}
const native = require(path.join(directory, 'win32-x64.node'));
if (!['create', 'snapshot', 'terminate', 'close'].every(key => typeof native[key] === 'function')) throw Error('SDK Job exports missing');
console.log('Built isolated Windows SDK Job controller and launcher');

const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  version: 1, platform: 'win32', arch: 'x64',
  sources: Object.fromEntries(['sdk-job-state.h', 'sdk-job-control-win.cc', 'sdk-job-launcher-win.cc']
    .map(name => [name, hash(path.join(__dirname, name))])),
  artifacts: Object.fromEntries(['win32-x64.node', 'sdk-job-launcher-win32-x64.exe']
    .map(name => [name, hash(path.join(directory, name))])),
}, null, 2) + '\n');
