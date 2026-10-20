'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { finalFileMessages } = require('../projects/scratch-protection');
const { localFileLinks, localFileLinkEntries, locationKey, isWithinLocation } = require('../tasks/task-file-links');

const DEFAULT_LIMITS = Object.freeze({
  maxLocations: 1000, maxEntries: 12000, maxDirectories: 1500, maxDepth: 6,
  maxFiles: 2000, maxFileChecks: 8000, maxRoots: 3000, maxHistoryFiles: 150, maxLogFiles: 100,
  maxFileBytes: 2 * 1024 * 1024, maxReadBytes: 16 * 1024 * 1024,
});
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);

// Only the drive mount has a portable mapping. Do not guess a Linux distro for
// /home paths when running on Windows, or a Windows share when running on Linux.
function nativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const mounted = /^\/mnt\/([a-z])(?:\/|$)/i.exec(value);
  const drive = /^([a-z]):[\\/]/i.exec(value);
  if (process.platform === 'win32') {
    if (mounted) return path.win32.resolve(mounted[1] + ':\\' + value.slice(mounted[0].length).replace(/\//g, '\\'));
    return path.win32.isAbsolute(value) && (drive || /^(?:\\\\|\/\/)/.test(value)) ? path.win32.resolve(value) : null;
  }
  if (drive) return path.posix.resolve('/mnt/' + drive[1].toLowerCase(), value.slice(3).replace(/\\/g, '/'));
  return path.posix.isAbsolute(value) && !value.startsWith('//') ? path.posix.resolve(value) : null;
}

async function listOutputLibrary({ locations = [], historyDir, projectsDir, typeOf = () => 'other', limits = {} } = {}) {
  const cap = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key,
    Number.isSafeInteger(limits[key]) && limits[key] >= 0 ? limits[key] : value]));
  const warnings = [], warned = new Set(), files = new Map();
  const counts = { entries: 0, directories: 0, bytes: 0, fileChecks: 0, roots: 0 };
  let truncated = false;
  function warn(code, target) {
    const key = code + ':' + (target || '');
    if (warned.has(key)) return;
    warned.add(key);
    if (warnings.length < 50) warnings.push({ code, ...(target ? { path: target } : {}) });
  }
  function limit(code) { truncated = true; warn(code); }
  function failed(error, target) { if (!missing(error)) warn(error?.code || 'READ_FAILED', target); }
  const registered = (Array.isArray(locations) ? locations : []).slice(0, cap.maxLocations);
  if (registered.length < (Array.isArray(locations) ? locations.length : 0)) limit('LOCATION_LIMIT');
  const byConversation = new Map(registered.filter(item => item?.conversationId).map(item => [item.conversationId, item]));
  // Limits restrict filesystem work, not known ownership. Retain lexical
  // scratch boundaries even when a later conversation/root cannot be scanned.
  const scratchRoots = (Array.isArray(locations) ? locations : []).flatMap(location => {
    if (!location || typeof location !== 'object') return [];
    return [location.scratchDir, ...(Array.isArray(location.previousScratchDirs) ? location.previousScratchDirs : [])]
      .filter(value => typeof value === 'string' && value)
      .map(value => ({ path: nativePath(value) || value, real: null, scan: false, conversationId: location.conversationId }));
  });
  const outputRoots = [];

  async function rootInfo(value, conversationId) {
    if (typeof value !== 'string' || !value) return null;
    if (counts.roots >= cap.maxRoots) { limit('ROOT_LIMIT'); return null; }
    counts.roots++;
    const native = nativePath(value);
    if (!native) { warn('UNSUPPORTED_PATH', value); return { path: value, real: null, scan: false, conversationId }; }
    try {
      const stat = await fs.promises.lstat(native);
      const real = await fs.promises.realpath(native);
      if (stat.isSymbolicLink()) { warn('SYMLINK_SKIPPED', native); return { path: native, real, scan: false, conversationId }; }
      if (!stat.isDirectory()) { warn('NOT_DIRECTORY', native); return { path: native, real, scan: false, conversationId }; }
      return { path: native, real, scan: true, conversationId };
    } catch (error) { failed(error, native); return { path: native, real: null, scan: false, conversationId }; }
  }
  for (const location of registered) {
    if (!location || typeof location !== 'object') continue;
    const scratch = [location.scratchDir, ...(Array.isArray(location.previousScratchDirs) ? location.previousScratchDirs : [])];
    for (const value of new Set(scratch)) {
      const root = await rootInfo(value, location.conversationId);
      if (root) scratchRoots.push(root);
    }
    if (location.outputDir && locationKey(location.outputDir) !== locationKey(location.cwd)) {
      const root = await rootInfo(location.outputDir, location.conversationId);
      if (root) outputRoots.push(root);
    }
  }
  // Normalization is independent of the candidate file. Compute registered
  // keys once, rather than resolving every root for every displayed item.
  const boundaries = roots => roots.map(root => ({ conversationId: root.conversationId,
    key: locationKey(root.path), realKey: root.real ? locationKey(root.real) : null }));
  const scratchBoundaries = boundaries(scratchRoots), outputBoundaries = boundaries(outputRoots);
  const keyWithin = (file, root) => !!file && !!root && (file === root || file.startsWith(root + '/'));
  function classify(candidate, real, fallback, conversationId) {
    const candidateKey = locationKey(candidate), realKey = candidate === real ? candidateKey : locationKey(real);
    const matches = root => keyWithin(candidateKey, root.key) || keyWithin(candidateKey, root.realKey)
      || keyWithin(realKey, root.key) || keyWithin(realKey, root.realKey);
    const scratch = scratchBoundaries.find(matches);
    if (scratch) return { kind: 'process', conversationId: scratch.conversationId || conversationId };
    const output = outputBoundaries.find(matches);
    return { kind: output ? 'output' : fallback, conversationId: conversationId || output?.conversationId };
  }
  async function addFile(value, fallback, conversationId, boundary, allowDirectory = false) {
    if (counts.fileChecks >= cap.maxFileChecks) { limit('FILE_CHECK_LIMIT'); return; }
    counts.fileChecks++;
    const candidate = nativePath(value);
    if (!candidate) { warn('UNSUPPORTED_PATH', value); return; }
    try {
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) { warn('SYMLINK_SKIPPED', candidate); return; }
      const isDirectory = stat.isDirectory();
      if (!stat.isFile() && !(allowDirectory && isDirectory)) return;
      const real = await fs.promises.realpath(candidate);
      if (boundary && !isWithinLocation(real, boundary)) { warn('OUTSIDE_ROOT_SKIPPED', candidate); return; }
      const key = locationKey(real), classification = classify(candidate, real, fallback, conversationId);
      const previous = files.get(key), rank = { legacy: 0, output: 1, process: 2 };
      if (previous && rank[previous.kind] >= rank[classification.kind]) return;
      if (!previous && files.size >= cap.maxFiles) { limit('FILE_LIMIT'); return; }
      const name = path.basename(real), ext = isDirectory ? '' : path.extname(name).slice(1).toLowerCase();
      files.set(key, { path: real, name, ext, type: isDirectory ? 'other' : typeOf(ext), mtime: stat.mtimeMs, size: isDirectory ? null : stat.size, dir: path.dirname(real),
        ...(isDirectory ? { isDirectory: true } : {}),
        kind: classification.kind, ...(classification.conversationId ? { conversationId: classification.conversationId } : {}) });
    } catch (error) { failed(error, candidate); }
  }
  async function entries(directory, visit) {
    if (counts.directories >= cap.maxDirectories) { limit('DIRECTORY_LIMIT'); return; }
    if (counts.entries >= cap.maxEntries) { limit('ENTRY_LIMIT'); return; }
    counts.directories++;
    try {
      const handle = await fs.promises.opendir(directory);
      for await (const entry of handle) {
        if (counts.entries >= cap.maxEntries) { limit('ENTRY_LIMIT'); break; }
        counts.entries++;
        if (await visit(entry) === false) break;
      }
    } catch (error) { failed(error, directory); }
  }
  const visitedRoots = new Set();
  async function scanRoot(root, kind) {
    if (!root.scan || visitedRoots.has(locationKey(root.real))) return;
    visitedRoots.add(locationKey(root.real));
    async function walk(directory, depth) {
      if (files.size >= cap.maxFiles) { limit('FILE_LIMIT'); return; }
      await entries(directory, async entry => {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { warn('SYMLINK_SKIPPED', candidate); return; }
        try {
          const stat = await fs.promises.lstat(candidate);
          if (stat.isSymbolicLink()) { warn('SYMLINK_SKIPPED', candidate); return; }
          const real = await fs.promises.realpath(candidate);
          if (!isWithinLocation(real, root.real)) { warn('OUTSIDE_ROOT_SKIPPED', candidate); return; }
          if (stat.isDirectory()) {
            if (depth >= cap.maxDepth) { limit('DEPTH_LIMIT'); return; }
            await walk(real, depth + 1);
          } else if (stat.isFile()) await addFile(real, kind, root.conversationId, root.real);
          if (files.size >= cap.maxFiles) { limit('FILE_LIMIT'); return false; }
        } catch (error) { failed(error, candidate); }
      });
    }
    await walk(root.real, 0);
  }
  // Classify against all registered scratch roots before scanning any output.
  for (const root of outputRoots) await scanRoot(root, 'output');
  for (const root of scratchRoots) await scanRoot(root, 'process');

  async function candidateFile(value, boundary) {
    try {
      const stat = await fs.promises.lstat(value);
      if (stat.isSymbolicLink()) { warn('SYMLINK_SKIPPED', value); return null; }
      if (!stat.isFile()) return null;
      const real = await fs.promises.realpath(value);
      if (!isWithinLocation(real, boundary)) { warn('OUTSIDE_ROOT_SKIPPED', value); return null; }
      return { path: real, mtime: stat.mtimeMs };
    } catch (error) { failed(error, value); return null; }
  }
  async function boundedRead(candidate) {
    let handle;
    try {
      handle = await fs.promises.open(candidate.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > cap.maxFileBytes) { limit('SOURCE_FILE_BYTE_LIMIT'); warn('SOURCE_TOO_LARGE', candidate.path); return null; }
      if (stat.size > cap.maxReadBytes - counts.bytes) { limit('TOTAL_BYTE_LIMIT'); return null; }
      const length = Math.min(stat.size + 1, cap.maxFileBytes + 1, cap.maxReadBytes - counts.bytes + 1);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      counts.bytes += read;
      if (read > stat.size || read > cap.maxFileBytes || counts.bytes > cap.maxReadBytes) { limit('SOURCE_CHANGED_DURING_READ'); return null; }
      return buffer.subarray(0, read).toString('utf8');
    } catch (error) { failed(error, candidate.path); return null; }
    finally { if (handle) await handle.close().catch(error => failed(error, candidate.path)); }
  }
  function recent(candidates, maximum, code) {
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    if (candidates.length > maximum) limit(code);
    return candidates.slice(0, maximum);
  }
  const historyRoot = await rootInfo(historyDir);
  if (historyRoot?.scan) {
    const histories = [];
    await entries(historyRoot.real, async entry => {
      if (!entry.name.endsWith('.json') || entry.name.toLowerCase() === 'index.json') return;
      const candidate = await candidateFile(path.join(historyRoot.real, entry.name), historyRoot.real);
      if (candidate) histories.push({ ...candidate, conversationId: entry.name.slice(0, -5) });
    });
    for (const candidate of recent(histories, cap.maxHistoryFiles, 'HISTORY_LIMIT')) {
      const text = await boundedRead(candidate);
      if (text === null) continue;
      let conversation;
      try { conversation = JSON.parse(text); }
      catch (_) { warn('INVALID_HISTORY', candidate.path); continue; }
      const location = byConversation.get(candidate.conversationId);
      const cwd = location?.cwd || (typeof conversation?.workingDir === 'string' ? conversation.workingDir : conversation?.workingDir?.path);
      const legacyTurns = [];
      for (const turn of conversation?.turns || []) {
        const snapshot = turn?.deliverables;
        if (snapshot?.version !== 1 || snapshot.conversationId !== candidate.conversationId
            || snapshot.runId !== turn.runId || snapshot.turnTs !== turn.ts || !Array.isArray(snapshot.items)) {
          legacyTurns.push(turn); continue;
        }
        for (const item of snapshot.items.slice(0, 128)) {
          if (typeof item?.path !== 'string') continue;
          await addFile(item.path, 'output', candidate.conversationId, null);
          const entry = files.get(locationKey(nativePath(item.path)));
          if (!entry || entry.kind !== 'output') continue;
          entry.deliveries ||= [];
          if (!entry.deliveries.some(value => value.conversationId === candidate.conversationId && value.runId === turn.runId)) {
            entry.deliveries.push({ conversationId: candidate.conversationId, runId: turn.runId, turnTs: turn.ts });
          }
        }
      }
      // Older histories retain their fallback. Registered turns do not turn
      // every cited source-code link into a deliverable again.
      for (const message of finalFileMessages({ ...conversation, turns: legacyTurns })) {
        let links;
        try {
          if (cwd) links = localFileLinks(message, cwd);
          else {
            const entries = localFileLinkEntries(message);
            links = entries.filter(entry => {
              const absolute = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(entry.rawPath);
              if (!absolute) warn('FINAL_LINK_WITHOUT_CWD', candidate.path);
              return absolute;
            }).map(entry => entry.path);
          }
        }
        catch (error) { warn(error.code || 'INVALID_FINAL_LINKS', candidate.path); continue; }
        for (const file of links) await addFile(file, 'output', candidate.conversationId, null, true);
      }
    }
  }

  const logRoot = await rootInfo(projectsDir);
  if (logRoot?.scan) {
    const logs = [];
    await entries(logRoot.real, async entry => {
      if (entry.isSymbolicLink()) { warn('SYMLINK_SKIPPED', path.join(logRoot.real, entry.name)); return; }
      if (!entry.isDirectory()) return;
      const directory = path.join(logRoot.real, entry.name);
      try {
        const stat = await fs.promises.lstat(directory), real = await fs.promises.realpath(directory);
        if (stat.isSymbolicLink() || !isWithinLocation(real, logRoot.real)) { warn('SYMLINK_SKIPPED', directory); return; }
        await entries(real, async child => {
          if (!child.name.endsWith('.jsonl')) return;
          const candidate = await candidateFile(path.join(real, child.name), logRoot.real);
          if (candidate) logs.push(candidate);
        });
      } catch (error) { failed(error, directory); }
    });
    for (const candidate of recent(logs, cap.maxLogFiles, 'LOG_LIMIT')) {
      const content = await boundedRead(candidate);
      if (content === null || !content.includes('无交互界面')) continue;
      for (const line of content.split('\n')) {
        if (!line.includes('tool_use')) continue;
        let record;
        try { record = JSON.parse(line); }
        catch (_) { warn('INVALID_LOG_LINE', candidate.path); continue; }
        if (record?.type !== 'assistant' || !Array.isArray(record.message?.content)) continue;
        for (const block of record.message.content) {
          if (block?.type !== 'tool_use' || !WRITE_TOOLS.has(block.name)) continue;
          const file = block.input && (block.input.file_path || block.input.notebook_path || block.input.path);
          if (typeof file !== 'string' || !file) continue;
          // Old records sometimes contain relative writes. Resolve only when the
          // record supplies cwd; never reinterpret them under Relay's own cwd.
          const cwd = record.cwd;
          let resolved = file;
          if (!nativePath(file)) {
            if (typeof cwd !== 'string' || !nativePath(cwd) || /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(file)) { warn('UNRESOLVED_LOG_PATH', candidate.path); continue; }
            resolved = path.resolve(nativePath(cwd), file);
          }
          await addFile(resolved, 'legacy');
        }
      }
    }
  }
  return { ok: true, items: [...files.values()].sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)), truncated, warnings };
}

module.exports = { listOutputLibrary, nativePath, DEFAULT_LIMITS };
