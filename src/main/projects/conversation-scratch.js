'use strict';

// Directory ownership and removal refer to physical files, including ASAR archives.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyTree, verifyTree } = require('./scratch-copy');
const { assertScratchCleanupAllowed } = require('./scratch-protection');
const { removeOwnedDirectories, assertDirectoryOwnership } = require('./owned-directory-cleanup');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeId(id) { return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : id; }

function key(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function missing(error) { return error && error.code === 'ENOENT'; }
function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (missing(error)) return null; throw error; }
}
async function lstatAsync(file) {
  try { return await fs.promises.lstat(file); } catch (error) { if (missing(error)) return null; throw error; }
}
function realDirectory(stat) { return stat && stat.isDirectory() && !stat.isSymbolicLink(); }
function variants(value) {
  const result = [path.resolve(value)];
  try { result.push(fs.realpathSync(value)); }
  catch (error) {
    if (!missing(error)) throw error;
    try { result.push(path.join(fs.realpathSync(path.dirname(value)), path.basename(value))); }
    catch (parentError) { if (!missing(parentError)) throw parentError; }
  }
  return result;
}
function scratchRecord(item) {
  if (!item || !item.scratchDir) return {};
  return { scratchRoot: item.scratchRoot, scratchDir: item.scratchDir, scratchRootReal: item.scratchRootReal,
    ...(item.scratchPrevious ? { scratchPrevious: item.scratchPrevious } : {}),
    ...(item.scratchMigration ? { scratchMigration: item.scratchMigration } : {}) };
}

// Scratch owns only its deterministic per-conversation child, never the chosen
// root, a project cwd, or another conversation's directory. The same registry as
// workspaces pins older allocations when the default root changes.
function createConversationScratch({ legacyRoot, getRoot, folderFor, readRecords, saveRecords, loadConversation, loadConversationForCleanup = loadConversation }) {
  const operations = new Map();
  function update(id, transform) {
    const all = readRecords(), previous = all[id], next = transform(previous || {});
    if (next && Object.keys(next).length) all[id] = next; else delete all[id];
    try { saveRecords(); }
    catch (error) { if (previous) all[id] = previous; else delete all[id]; throw error; }
  }
  function validateLocation(id, location) {
    if (!location || typeof location.root !== 'string' || !path.isAbsolute(location.root)
      || typeof location.dir !== 'string' || !path.isAbsolute(location.dir)
      || key(location.dir) !== key(path.join(location.root, folderFor(id)))) throw new Error('过程文件索引不属于此会话，无法操作');
    return location;
  }
  function allocation(id) {
    const folder = folderFor(id), previous = readRecords()[id];
    if (previous && previous.scratchDir) {
      if (typeof previous.scratchRoot !== 'string' || !path.isAbsolute(previous.scratchRoot)
        || typeof previous.scratchDir !== 'string' || !path.isAbsolute(previous.scratchDir)
        || key(previous.scratchDir) !== key(path.join(previous.scratchRoot, folder))) {
        throw new Error('过程文件索引不属于此会话，无法操作');
      }
      return { root: path.resolve(previous.scratchRoot), dir: path.resolve(previous.scratchDir), realRoot: previous.scratchRootReal || null, recorded: true };
    }
    // Upgrade existing pre-registry scratch in place, even when the preference
    // has already changed. Do not create anything while locating old data.
    const legacy = path.join(legacyRoot, folder);
    const legacyExists = !!lstat(legacy);
    const root = legacyExists ? legacyRoot : (getRoot() || legacyRoot);
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('过程文件目录必须是绝对路径');
    const dir = path.join(path.resolve(root), folder);
    if (!legacyExists && key(root) !== key(legacyRoot) && lstat(dir)) throw new Error('过程文件目录已被占用，无法确认会话归属');
    return { root: path.resolve(root), dir, realRoot: null, recorded: false };
  }
  function ensureExclusive(id, dir, prospectiveCwd = null) {
    const candidates = variants(dir);
    const covers = value => variants(value).some(cwd => candidates.some(candidate => contains(candidate, cwd)));
    const overlaps = value => variants(value).some(other => candidates.some(candidate => contains(candidate, other) || contains(other, candidate)));
    if (prospectiveCwd && covers(prospectiveCwd)) throw new Error('过程文件目录与任务工作目录重合，无法操作');
    const all = readRecords();
    for (const [otherId, item] of Object.entries(all)) {
      if (otherId !== id) {
        const owned = [item.scratchDir, ...(item.scratchPrevious || []).map(location => location.dir), item.scratchMigration?.stagingDir, item.scratchMigration?.targetDir].filter(Boolean);
        if (owned.some(overlaps)) throw new Error('过程文件目录属于其他会话，无法操作');
      }
      if (item.cwd && path.isAbsolute(item.cwd) && covers(item.cwd)) throw new Error('过程文件目录与任务工作目录重合，无法操作');
    }
    // A registered workspace is authoritative; do not parse its full transcript
    // just to recheck a directory during background migration.
    const conversation = all[id]?.cwd ? null : loadConversation(id);
    const cwd = conversation && (typeof conversation.workingDir === 'string' ? conversation.workingDir : conversation.workingDir && conversation.workingDir.path);
    if (cwd && path.isAbsolute(cwd) && covers(cwd)) throw new Error('过程文件目录与任务工作目录重合，无法操作');
  }
  function remember(id, location, realRoot) {
    const all = readRecords(), previous = all[id];
    const next = { ...(previous || {}), scratchRoot: location.root, scratchDir: location.dir, scratchRootReal: realRoot };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    all[id] = next;
    try { saveRecords(); }
    catch (error) { if (previous) all[id] = previous; else delete all[id]; throw error; }
  }
  function resolve(id, prospectiveCwd) {
    id = normalizeId(id);
    if (operations.has(id)) throw new Error('此会话的过程文件正在清理或迁移，请稍后重试');
    const location = allocation(id);
    ensureExclusive(id, location.dir, prospectiveCwd);
    fs.mkdirSync(location.root, { recursive: true });
    if (!realDirectory(lstat(location.root))) throw new Error('过程文件目录不能链接到 Relay 数据目录之外');
    const realRoot = fs.realpathSync(location.root);
    if (location.realRoot && key(location.realRoot) !== key(realRoot)) throw new Error('过程文件根目录已被替换，无法操作');
    const existed = !!lstat(location.dir);
    fs.mkdirSync(location.dir, { recursive: true });
    if (!realDirectory(lstat(location.dir)) || key(fs.realpathSync(location.dir)) !== key(path.join(realRoot, folderFor(id)))) {
      throw new Error('过程文件目录不能链接到其他会话或会话归档之外');
    }
    try { remember(id, location, realRoot); }
    catch (error) { if (!existed) { try { fs.rmdirSync(location.dir); } catch (_) {} } throw error; }
    return location.dir;
  }
  async function inspect(id, location) {
    validateLocation(id, location);
    ensureExclusive(id, location.dir);
    const baseStat = await lstatAsync(location.root);
    if (!baseStat) {
      // An unavailable removable/network drive is not successful cleanup.
      if (process.platform === 'win32') await fs.promises.access(path.parse(location.root).root);
      return null;
    }
    if (!realDirectory(baseStat)) throw new Error('过程文件根目录是链接或非目录，无法安全清理');
    const realRoot = await fs.promises.realpath(location.root);
    if (location.realRoot && key(location.realRoot) !== key(realRoot)) throw new Error('过程文件根目录已被替换，无法安全清理');
    const stat = await lstatAsync(location.dir);
    if (!stat) return null;
    if (!realDirectory(stat)) throw new Error('过程文件目录不能链接到其他会话，无法安全清理');
    const realDir = await fs.promises.realpath(location.dir);
    if (key(realDir) !== key(path.join(realRoot, folderFor(id)))) throw new Error('过程文件目录不属于此会话，无法安全清理');
    return { ...location, realRoot, realDir };
  }
  function protectCleanup(id, directories) {
    return assertScratchCleanupAllowed({ id, directories, records: readRecords(), loadConversation: loadConversationForCleanup });
  }
  async function removeLocation(id, location) {
    const checked = await inspect(id, location);
    if (!checked) return false;
    await protectCleanup(id, [checked.dir, checked.realDir]);
    // rm unlinks children that are links instead of traversing their targets.
    await fs.promises.rm(checked.realDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  }
  async function recoverTransaction(id, { migration = false } = {}) {
    const transaction = readRecords()[id] && readRecords()[id].scratchMigration;
    if (!transaction) return;
    const { token, root, realRoot, sourceDir, stagingDir, targetDir } = transaction;
    if (!/^[a-f0-9]{32}$/.test(token || '') || typeof root !== 'string' || !path.isAbsolute(root)
      || typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)
      || key(stagingDir || '.') !== key(path.join(root, '.relay-migrate-' + folderFor(id) + '-' + token))
      || key(targetDir || '.') !== key(path.join(root, folderFor(id)))) throw new Error('过程文件迁移记录无效，已保留原目录');
    const source = allocation(id);
    if (key(source.dir) !== key(sourceDir) || !await inspect(id, source)) throw new Error('迁移原目录已不可用，保留目标副本待检查');
    const base = await lstatAsync(root);
    if (base && (!realDirectory(base) || key(await fs.promises.realpath(root)) !== key(realRoot))) throw new Error('迁移目标目录已被替换，已保留原目录');
    // A migration owns its transaction copies, regardless of text in unrelated
    // histories. Keep the stricter reference policy for explicit generic cleanup.
    if (!migration) await protectCleanup(id, [stagingDir, targetDir]);
    const targets = [];
    for (const candidate of [stagingDir, targetDir]) {
      const stat = await lstatAsync(candidate);
      if (!stat) continue;
      if (!realDirectory(stat)) throw new Error('迁移临时目录不能是链接');
      const marker = path.join(candidate, '.relay-migration-' + token + '.json');
      const markerStat = await lstatAsync(marker);
      if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 2048) throw new Error('迁移目标缺少所有权标记，已保留待检查');
      const saved = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
      if (saved.conversationId !== id || saved.token !== token || saved.source !== sourceDir || saved.target !== targetDir) throw new Error('迁移目标所有权不匹配，已保留待检查');
      ensureExclusive(id, candidate);
      if (migration) targets.push({ root, dir: candidate, realRoot,
        marker: { conversationId: id, token, source: sourceDir, target: targetDir } });
      else {
        await protectCleanup(id, [candidate]);
        await fs.promises.rm(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    if (migration) await removeOwnedDirectories({ id, targets, readRecords });
    update(id, previous => { const next = { ...previous }; delete next.scratchMigration; return next; });
  }
  async function cleanupPrevious(id, { migration = false } = {}) {
    const pending = [...(readRecords()[id]?.scratchPrevious || [])];
    if (migration) {
      if (!pending.length) return;
      for (const location of pending) {
        validateLocation(id, location);
        if (key(location.dir) === key(readRecords()[id].scratchDir)) throw new Error('迁移清理目录不能是当前会话目录');
      }
      // The verified destination and its mapping are already durable. Only old
      // registered scratch allocations are removed; project/output ownership is
      // checked without coupling migration to every saved conversation body.
      await removeOwnedDirectories({ id, targets: pending, readRecords });
      update(id, previous => { const next = { ...previous }; delete next.scratchPrevious; return next; });
      return;
    }
    await protectCleanup(id, pending.map(location => location.dir));
    for (const location of pending) {
      if (key(location.dir) === key(readRecords()[id].scratchDir)) throw new Error('迁移清理目录不能是当前会话目录');
      await removeLocation(id, location);
      update(id, previous => {
        const next = { ...previous, scratchPrevious: previous.scratchPrevious.filter(item => key(item.dir) !== key(location.dir)) };
        if (!next.scratchPrevious.length) delete next.scratchPrevious;
        return next;
      });
    }
  }
  async function removeOwned(id) {
    const location = allocation(id), record = readRecords()[id];
    // Preflight every current, previous and uncommitted location before deleting
    // any of them. Only this rejection proves that this attempt changed no files.
    try {
      await protectCleanup(id, [location.dir, ...(record?.scratchPrevious || []).map(item => item.dir),
        record?.scratchMigration?.stagingDir, record?.scratchMigration?.targetDir]);
    } catch (error) {
      if (error.code === 'SCRATCH_CLEANUP_PROTECTED') error.cleanupUnchanged = true;
      throw error;
    }
    await recoverTransaction(id);
    const removed = await removeLocation(id, location);
    await cleanupPrevious(id);
    if (readRecords()[id]?.scratchDir) update(id, previous => {
      const next = { ...previous };
      delete next.scratchRoot; delete next.scratchDir; delete next.scratchRootReal;
      delete next.scratchPrevious; delete next.scratchMigration;
      return next;
    });
    return { removed, path: location.dir };
  }
  function exclusive(id, kind, operation, target = '') {
    folderFor(id);
    const current = operations.get(id);
    if (current) return current.kind === kind && current.target === target ? current.promise : Promise.reject(new Error('此会话的过程文件正在清理或迁移，请稍后重试'));
    const promise = Promise.resolve().then(operation).finally(() => operations.delete(id));
    operations.set(id, { kind, target, promise });
    return promise;
  }
  async function removeForHistoryDeletionOwned(id) {
    const record = readRecords()[id], targets = [];
    let current, cleanupStarted = false;
    try {
      if (record?.scratchDir) current = { root: record.scratchRoot, dir: record.scratchDir, realRoot: record.scratchRootReal };
      else {
        const legacy = path.join(legacyRoot, folderFor(id)), legacyExists = !!await lstatAsync(legacy);
        const root = legacyExists ? legacyRoot : (getRoot() || legacyRoot);
        if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('过程文件目录登记无效');
        const dir = path.join(root, folderFor(id));
        if (!legacyExists && key(root) !== key(legacyRoot) && await lstatAsync(dir)) throw new Error('过程文件目录已被占用，无法确认归属');
        current = { root, dir, realRoot: null };
      }
      for (const location of [current, ...(record?.scratchPrevious || [])]) {
        validateLocation(id, location);
        if (!targets.some(target => key(target.dir) === key(location.dir))) targets.push({ ...location, kind: 'scratch' });
      }
      const transaction = record?.scratchMigration;
      if (transaction) {
        const { token, root, realRoot, sourceDir, stagingDir, targetDir } = transaction;
        if (!/^[a-f0-9]{32}$/.test(token || '') || typeof root !== 'string' || !path.isAbsolute(root)
          || typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir) || key(sourceDir) !== key(current.dir)
          || key(stagingDir || '.') !== key(path.join(root, '.relay-migrate-' + folderFor(id) + '-' + token))
          || key(targetDir || '.') !== key(path.join(root, folderFor(id)))) throw new Error('过程文件迁移登记不属于此会话');
        const marker = { conversationId: id, token, source: sourceDir, target: targetDir };
        for (const dir of [stagingDir, targetDir]) if (!targets.some(target => key(target.dir) === key(dir))) targets.push({ root, dir, realRoot, marker, kind: 'scratch' });
      }
      cleanupStarted = true;
      const result = await require('./owned-directory-cleanup').removeOwnedDirectories({ id, targets, readRecords });
      if (record?.scratchDir || record?.scratchPrevious || record?.scratchMigration) update(id, previous => {
        const next = { ...previous };
        delete next.scratchRoot; delete next.scratchDir; delete next.scratchRootReal;
        delete next.scratchPrevious; delete next.scratchMigration;
        return next;
      });
      return result;
    } catch (error) {
      if (error.cleanupUnchanged === undefined) error.cleanupUnchanged = !cleanupStarted;
      throw error;
    }
  }
  function removeForHistoryDeletion(id) {
    id = normalizeId(id);
    return exclusive(id, 'remove-history-files', () => removeForHistoryDeletionOwned(id));
  }
  function remove(id) {
    id = normalizeId(id);
    return exclusive(id, 'remove', () => removeOwned(id));
  }
  async function migrateOwned(id, root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('过程文件目录必须是绝对路径');
    await recoverTransaction(id, { migration: true });
    try { await cleanupPrevious(id, { migration: true }); }
    catch (error) {
      if (!['SCRATCH_CLEANUP_PROTECTED', 'CONVERSATION_FILES_NOT_OWNED'].includes(error.code)) throw error;
      return { migrated: false, from: readRecords()[id]?.scratchPrevious?.[0]?.dir, path: allocation(id).dir,
        cleanupPending: true, code: error.code, error: error.message };
    }
    const from = allocation(id);
    if (key(from.root) === key(root)) return { migrated: false, from: from.dir, path: from.dir };
    const source = await inspect(id, from);
    const target = { root: path.resolve(root), dir: path.join(path.resolve(root), folderFor(id)) };
    ensureExclusive(id, target.dir);
    if (contains(source?.realDir || from.dir, target.root) || contains(target.dir, source?.realDir || from.dir)) throw new Error('迁移目标不能位于原过程目录内或覆盖原目录');
    await fs.promises.mkdir(target.root, { recursive: true });
    if (!realDirectory(await lstatAsync(target.root))) throw new Error('迁移目标根目录不能是链接');
    const realRoot = await fs.promises.realpath(target.root);
    if (contains(source?.realDir || from.dir, realRoot) || contains(path.join(realRoot, folderFor(id)), source?.realDir || from.dir)) throw new Error('迁移目标不能与原过程目录重合');
    if (await lstatAsync(target.dir)) throw new Error('迁移目标目录已被占用，无法覆盖');
    await assertDirectoryOwnership({ id, targets: [source || from, { ...target, realDir: path.join(realRoot, folderFor(id)) }], records: readRecords() });
    // Resolve through canonical paths during copying; a changed alias is checked
    // again before committing the new mapping.
    if (!source) {
      // The source volume was accessible and this conversation directory was
      // absent. Pin an empty allocation to the new root rather than recreating
      // the obsolete location when its history is next resumed.
      await fs.promises.mkdir(target.dir);
      try { remember(id, target, realRoot); }
      catch (error) { try { await fs.promises.rmdir(target.dir); } catch (_) {} throw error; }
      return { migrated: true, from: from.dir, path: target.dir, missing: true };
    }
    remember(id, from, source.realRoot);
    const token = crypto.randomBytes(16).toString('hex');
    const stagingDir = path.join(target.root, '.relay-migrate-' + folderFor(id) + '-' + token);
    const markerName = '.relay-migration-' + token + '.json';
    const transaction = { token, root: target.root, realRoot, sourceDir: from.dir, stagingDir, targetDir: target.dir };
    update(id, previous => ({ ...previous, scratchMigration: transaction }));
    try {
      await fs.promises.mkdir(stagingDir);
      await fs.promises.writeFile(path.join(stagingDir, markerName), JSON.stringify({ version: 1, conversationId: id, token, source: from.dir, target: target.dir }), { flag: 'wx' });
      await copyTree(source.realDir, stagingDir, target.dir, source.realDir, from.dir);
      await verifyTree(source.realDir, stagingDir, target.dir, markerName, source.realDir, from.dir);
      if (!realDirectory(await lstatAsync(target.root)) || key(await fs.promises.realpath(target.root)) !== key(realRoot)) throw new Error('迁移目标根目录已变化');
      if (await lstatAsync(target.dir)) throw new Error('迁移目标目录已被占用，无法覆盖');
      await fs.promises.rename(stagingDir, target.dir);
      update(id, previous => {
        const next = { ...previous, scratchRoot: target.root, scratchDir: target.dir, scratchRootReal: realRoot,
          scratchPrevious: [{ root: from.root, dir: from.dir, realRoot: source.realRoot }] };
        delete next.scratchMigration;
        return next;
      });
    } catch (error) {
      try { await recoverTransaction(id, { migration: true }); }
      catch (cleanupError) { error.cleanupError = cleanupError.message; }
      throw error;
    }
    // The new mapping is durable before source cleanup. A failed cleanup keeps
    // a ledger entry that subsequent migration/deletion can safely retry.
    try { await fs.promises.unlink(path.join(target.dir, markerName)); } catch (_) {}
    try { await cleanupPrevious(id, { migration: true }); }
    catch (error) { return { migrated: true, from: from.dir, path: target.dir, cleanupPending: true, ...(error.code ? { code: error.code } : {}), error: error.message }; }
    return { migrated: true, from: from.dir, path: target.dir };
  }
  function migrate(id, root = getRoot() || legacyRoot) {
    id = normalizeId(id);
    return exclusive(id, 'migrate', () => migrateOwned(id, root), root);
  }
  async function list(knownConversationIds = []) {
    const all = readRecords(), ids = new Set(Object.keys(all).filter(id => all[id].scratchDir || all[id].scratchMigration));
    const byFolder = new Map();
    for (const id of [...Object.keys(all), ...knownConversationIds]) {
      try { byFolder.set(folderFor(id), id); } catch (_) {}
    }
    const legacyStat = await lstatAsync(legacyRoot);
    if (legacyStat) {
      if (!realDirectory(legacyStat)) throw new Error('旧过程文件根目录不能是链接');
      for await (const entry of await fs.promises.opendir(legacyRoot)) {
        const id = normalizeId(byFolder.get(entry.name) || (UUID.test(entry.name) ? entry.name.toLowerCase() : null));
        if (id) ids.add(id);
      }
    }
    const found = [];
    for (const conversationId of ids) {
      const item = all[conversationId];
      try {
        const location = allocation(conversationId);
        found.push({ conversationId, path: location.dir, root: location.root, registered: location.recorded, exists: !!await lstatAsync(location.dir),
          ...(item?.scratchPrevious?.length || item?.scratchMigration ? { cleanupPending: true } : {}),
          ...(item?.scratchMigration ? { migrationPending: true } : {}) });
      } catch (error) { found.push({ conversationId, error: error.message }); }
    }
    return found;
  }
  return { resolve, remove, removeForHistoryDeletion, migrate, list, get base() { return getRoot() || legacyRoot; } };
}

module.exports = { createConversationScratch, scratchRecord };
