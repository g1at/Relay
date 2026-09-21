'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Explicit FileSets keep both native runtimes at the paths used by Relay and
// WSL. electron-builder otherwise silently skips a missing FileSet source.
function verifySdkPackaging(context = {}) {
  const root = context.packager?.info?.appDir || path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('SDK 版本必须锁定后再打包。');
  for (const [platform, file, magic] of [
    ['win32', 'claude.exe', Buffer.from('MZ')],
    ['linux', 'claude', Buffer.from([127, 69, 76, 70])],
  ]) {
    const name = `@anthropic-ai/claude-agent-sdk-${platform}-x64`;
    const directory = path.join(root, 'node_modules', name), executable = path.join(directory, file);
    try {
      if (!fs.lstatSync(directory).isDirectory() || !fs.lstatSync(executable).isFile()) throw Error('运行时文件不是普通文件');
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name !== name || metadata.version !== version || !metadata.os?.includes(platform) || !metadata.cpu?.includes('x64')) throw Error('平台或版本不匹配');
      const handle = fs.openSync(executable, 'r'), header = Buffer.alloc(magic.length);
      try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
      if (!header.equals(magic)) throw Error('运行时文件格式不正确');
    } catch (error) {
      const recovery = platform === 'linux' ? '请先运行 npm run prepare:sdk-runtime。' : '请重新安装当前项目依赖。';
      throw new Error(`缺少可用的 ${name}@${version}，已停止打包。${recovery}`, { cause: error });
    }
  }
}

module.exports = verifySdkPackaging;
