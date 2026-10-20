'use strict';
// Treat user archives as opaque files. Electron's fs exposes .asar as virtual
// directories, which makes lstat/copy/verify disagree with the physical tree.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function migratedLink(value, sourceRoot, finalRoot, sourceAlias = sourceRoot) {
  // Relative links retain their relative meaning. Absolute links to this
  // scratch are rebased so source cleanup cannot break its internal links.
  if (!path.isAbsolute(value)) return value;
  for (const root of [sourceRoot, sourceAlias]) if (inside(root, value)) return path.join(finalRoot, path.relative(root, value));
  return value;
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function copyTree(source, target, finalRoot, sourceRoot = source, sourceAlias = sourceRoot) {
  for await (const entry of await fs.promises.opendir(source)) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    const stat = await fs.promises.lstat(from);
    if (stat.isSymbolicLink()) {
      const link = await fs.promises.readlink(from);
      let type;
      if (process.platform === 'win32') {
        try { type = (await fs.promises.stat(from)).isDirectory() ? 'junction' : 'file'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; type = 'file'; }
      }
      await fs.promises.symlink(migratedLink(link, sourceRoot, finalRoot, sourceAlias), to, type);
    } else if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { mode: stat.mode });
      await copyTree(from, to, finalRoot, sourceRoot, sourceAlias);
      await fs.promises.utimes(to, stat.atime, stat.mtime);
    } else if (stat.isFile()) {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(to, stat.mode);
      await fs.promises.utimes(to, stat.atime, stat.mtime);
    } else {
      throw new Error('过程文件包含无法迁移的特殊文件：' + entry.name);
    }
  }
}
async function verifyTree(source, target, finalRoot, markerName, sourceRoot = source, sourceAlias = sourceRoot) {
  const names = (await fs.promises.readdir(source)).sort();
  const actual = (await fs.promises.readdir(target)).filter(name => source === sourceRoot ? name !== markerName : true).sort();
  if (JSON.stringify(names) !== JSON.stringify(actual)) throw new Error('迁移期间文件列表发生变化，旧目录已保留');
  for (const name of names) {
    const from = path.join(source, name), to = path.join(target, name);
    const [before, copied] = await Promise.all([fs.promises.lstat(from), fs.promises.lstat(to)]);
    if (before.isSymbolicLink()) {
      if (!copied.isSymbolicLink() || migratedLink(await fs.promises.readlink(from), sourceRoot, finalRoot, sourceAlias) !== await fs.promises.readlink(to)) {
        throw new Error('迁移链接校验失败，旧目录已保留');
      }
    } else if (before.isDirectory()) {
      if (!copied.isDirectory() || copied.isSymbolicLink()) throw new Error('迁移目录校验失败，旧目录已保留');
      await verifyTree(from, to, finalRoot, markerName, sourceRoot, sourceAlias);
    } else if (before.isFile()) {
      if (!copied.isFile() || copied.isSymbolicLink() || before.size !== copied.size) throw new Error('迁移文件大小校验失败，旧目录已保留');
      const [sourceHash, copyHash] = await Promise.all([digest(from), digest(to)]);
      const after = await fs.promises.lstat(from);
      if (sourceHash !== copyHash || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        throw new Error('迁移文件内容校验失败或源文件仍在变化，旧目录已保留');
      }
    } else throw new Error('过程文件包含无法校验的特殊文件');
  }
  if (JSON.stringify(names) !== JSON.stringify((await fs.promises.readdir(source)).sort())) throw new Error('迁移期间文件列表发生变化，旧目录已保留');
}

module.exports = { copyTree, verifyTree };
