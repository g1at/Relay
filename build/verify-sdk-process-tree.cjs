'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const names = ['win32-x64.node', 'sdk-job-launcher-win32-x64.exe'];
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function verifySdkProcessTree(root = path.resolve(__dirname, '..')) {
  const directory = path.join(root, 'src/main/sdk/native');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.version !== 1) throw Error('原生组件清单无效');
    for (const name of names) {
      const file = path.join(directory, name), bytes = fs.readFileSync(file);
      if (!fs.lstatSync(file).isFile() || bytes.length < 1024 || bytes.toString('ascii', 0, 2) !== 'MZ' ||
          digest(file) !== manifest.artifacts?.[name]) throw Error('原生组件缺失或校验失败：' + name);
    }
    // Source builds must not silently package stale binaries. Fixtures and
    // packaged apps need only the artifact checks above.
    for (const [name, hash] of Object.entries(manifest.sources || {})) {
      const file = path.join(root, 'build', name);
      if (fs.existsSync(file) && digest(file) !== hash) throw Error('原生源码已变化，需要重新构建：' + name);
    }
  } catch (cause) {
    throw new Error('会话进程树组件不可用，已停止打包。请运行 npm run build:sdk-process-tree。', { cause });
  }
}
module.exports = verifySdkProcessTree;
