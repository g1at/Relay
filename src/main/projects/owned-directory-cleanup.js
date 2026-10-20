'use strict';

// Directory ownership and removal refer to physical files, including ASAR archives.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
function key(value) { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function within(child, parent) { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function blocked(message, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'CONVERSATION_FILES_NOT_OWNED' }); }
async function stat(file) { try { return await fs.promises.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directory(entry) { return entry?.isDirectory() && !entry.isSymbolicLink(); }
async function inspectDirectory(target) {
  const base = await stat(target.root);
  if (!base) {
    await fs.promises.access(path.parse(target.root).root);
    if (target.realRoot && key(target.realRoot) !== key(target.root)) throw blocked('目录入口已消失，无法确认原文件位置');
    return null;
  }
  if (!directory(base)) throw blocked('待清理目录的父目录不是实际文件夹');
  const realRoot = await fs.promises.realpath(target.root);
  if (target.realRoot && key(realRoot) !== key(target.realRoot)) throw blocked('待清理目录的父目录位置已改变');
  const entry = await stat(target.dir);
  if (!entry) return null;
  if (!directory(entry)) throw blocked('待清理目录不能是链接或普通文件');
  const realDir = await fs.promises.realpath(target.dir);
  if (key(realDir) !== key(path.join(realRoot, path.basename(target.dir))) || target.realDir && key(realDir) !== key(target.realDir)) throw blocked('待清理目录已离开登记位置');
  if (target.marker) {
    const markerFile = path.join(target.dir, '.relay-migration-' + target.marker.token + '.json');
    const markerStat = await stat(markerFile);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink() || markerStat.size > 2048) throw blocked('迁移副本缺少有效的会话所有权标记');
    const marker = JSON.parse(await fs.promises.readFile(markerFile, 'utf8'));
    for (const field of ['conversationId', 'token', 'source', 'target']) if (marker[field] !== target.marker[field]) throw blocked('迁移副本的会话所有权不匹配');
  }
  return { ...target, realRoot, realDir, dev: entry.dev, ino: entry.ino };
}
async function pathVariants(value, pinned, resolved) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return [];
  const found = [value];
  if (typeof pinned === 'string' && path.isAbsolute(pinned)) found.push(pinned);
  if (resolved.has(value)) found.push(resolved.get(value));
  else {
    let current = value, tail = [];
    while (true) {
      try { const real = path.join(await fs.promises.realpath(current), ...tail); resolved.set(value, real); found.push(real); break; }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        const parent = path.dirname(current); if (parent === current) break;
        tail.unshift(path.basename(current)); current = parent;
      }
    }
  }
  return found.map(key);
}
async function assertDirectoryOwnership({ id, targets, records }) {
  const resolved = new Map();
  for (const target of targets) {
    const candidates = [target.dir, target.realDir].filter(Boolean).map(key);
    const covers = variants => variants.some(value => candidates.some(candidate => within(value, candidate)));
    const overlaps = variants => variants.some(value => candidates.some(candidate => within(value, candidate) || within(candidate, value)));
    for (const [otherId, item] of Object.entries(records)) {
      const cwd = await pathVariants(item.cwd, item.browseScope?.realCwd, resolved);
      if (covers(cwd)) throw blocked('待清理目录覆盖了会话工作目录');
      const output = await pathVariants(item.outputDir, item.browseScope?.realOutput, resolved);
      const dedicatedOutput = item.outputDir && item.cwd && key(item.outputDir) !== key(item.cwd);
      if (dedicatedOutput ? overlaps(output) : covers(output)) throw blocked('待清理目录与已登记成果目录重合');
      if (otherId === id) continue;
      for (const location of [
        { dir: item.scratchDir, real: item.scratchRootReal && item.scratchDir && path.join(item.scratchRootReal, path.basename(item.scratchDir)) },
        ...(item.scratchPrevious || []).map(part => ({ dir: part.dir, real: part.realRoot && path.join(part.realRoot, path.basename(part.dir)) })),
        { dir: item.scratchMigration?.stagingDir, real: item.scratchMigration?.realRoot && item.scratchMigration?.stagingDir && path.join(item.scratchMigration.realRoot, path.basename(item.scratchMigration.stagingDir)) },
        { dir: item.scratchMigration?.targetDir, real: item.scratchMigration?.realRoot && item.scratchMigration?.targetDir && path.join(item.scratchMigration.realRoot, path.basename(item.scratchMigration.targetDir)) },
      ]) if (overlaps(await pathVariants(location.dir, location.real, resolved))) throw blocked('待清理目录与其他会话过程文件重合');
    }
  }
}
function registrySignature(records) {
  return JSON.stringify(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => [id,
    item.cwd, item.outputDir, item.browseScope?.realCwd, item.browseScope?.realOutput,
    item.scratchRoot, item.scratchDir, item.scratchRootReal,
    (item.scratchPrevious || []).map(part => [part.root, part.dir, part.realRoot]),
    item.scratchMigration && [item.scratchMigration.token, item.scratchMigration.root, item.scratchMigration.realRoot,
      item.scratchMigration.sourceDir, item.scratchMigration.stagingDir, item.scratchMigration.targetDir],
  ]));
}
async function removeOwnedDirectories({ id, targets, readRecords }) {
  const ownSignature = () => { const item = readRecords()[id]; return registrySignature(item ? { [id]: item } : {}); };
  const signature = ownSignature(), plan = [];
  const unchanged = () => { if (signature !== ownSignature()) throw blocked('本会话文件归属在清理时发生变化，请重试'); };
  async function stableOwnership(selected) {
    for (let attempt = 0; attempt < 3; attempt++) {
      unchanged(); const observed = registrySignature(readRecords());
      await assertDirectoryOwnership({ id, targets: selected, records: readRecords() }); unchanged();
      if (observed === registrySignature(readRecords())) return observed;
    }
    throw blocked('目录归属持续变化，尚未完成清理检查，请稍后重试');
  }
  try {
    for (const target of targets) { const checked = await inspectDirectory(target); if (checked) plan.push(checked); }
    await stableOwnership(plan);
  } catch (error) { error.cleanupUnchanged = true; throw error; }
  const removedPaths = [];
  let removalStarted = false;
  for (const target of plan) {
    try {
      let settled = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const observed = await stableOwnership([target]);
        const checked = await inspectDirectory(target); unchanged();
        if (observed !== registrySignature(readRecords())) continue;
        if (!checked) { settled = true; break; }
        if (checked.dev !== target.dev || checked.ino !== target.ino) throw blocked('清理目录在检查后被替换');
        removalStarted = true;
        await fs.promises.rm(checked.realDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removedPaths.push(target.dir); settled = true; break;
      }
      if (!settled) throw blocked('目录归属持续变化，尚未完成清理检查，请稍后重试');
    } catch (error) { error.cleanupUnchanged = !removalStarted; error.removedPaths = removedPaths; throw error; }
  }
  return { removed: removedPaths.length > 0, removedPaths };
}
module.exports = { removeOwnedDirectories, inspectDirectory, assertDirectoryOwnership, registrySignature };
