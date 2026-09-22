'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  VALID_STATUS, parseMemoryDocument, serializeMemoryFrontmatter, memoryEligibility, memoryScopeEligibility,
} = require('./memory-schema');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function revision(content) { return content == null ? null : crypto.createHash('sha256').update(content).digest('hex'); }
function fileKey(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }
function sameFile(a, b) { return fileKey(a) === fileKey(b); }
function compareHistory(a, b) {
  return String(a.record.createdAt).localeCompare(String(b.record.createdAt))
    || fs.statSync(a.abs).mtimeMs - fs.statSync(b.abs).mtimeMs;
}
function isUser(options) { return !options.actor || options.actor === 'user'; }
function requireUser(options) { if (!isUser(options)) fail('MEMORY_PERMISSION', '请在 Relay 记忆管理中确认此操作。'); }

class MemoryStore {
  constructor({ dir }) {
    if (!dir) throw new TypeError('MemoryStore requires dir');
    this.dir = path.resolve(dir);
    this.historyDir = path.join(this.dir, '.history');
    this.lockPath = path.join(this.dir, '.relay-memory.lock');
  }

  _checkNode(abs, directory = false) {
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink > 1))) {
        fail('MEMORY_PATH', '记忆路径不能是链接或特殊文件。');
      }
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  _file(file, allowIndex = false) {
    if (typeof file !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]+\.md$/i.test(file)
      || file.startsWith('.') || /[. ]\.md$/i.test(file) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)) {
      fail('MEMORY_PATH', '非法记忆文件名，须为记忆库内的单个 .md 文件。');
    }
    if (!allowIndex && file.toLowerCase() === 'memory.md') fail('MEMORY_INDEX', 'MEMORY.md 由 Relay 自动维护。');
    const abs = path.join(this.dir, file);
    this._checkNode(abs);
    return abs;
  }

  _atomic(abs, content) {
    this._checkNode(abs);
    const tmp = `${abs}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, abs);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  _lock(fn) {
    this._checkNode(this.dir, true);
    fs.mkdirSync(this.dir, { recursive: true });
    this._checkNode(this.lockPath);
    let fd;
    try { fd = fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A crashed host must not leave the library permanently locked. Never steal a live lock.
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
        }
      } catch (_) { stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > 60000; }
      if (!stale) fail('MEMORY_BUSY', '记忆库正在更新，请重试。');
      fs.unlinkSync(this.lockPath);
      fd = fs.openSync(this.lockPath, 'wx', 0o600);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.closeSync(fd); fd = undefined;
      this._checkNode(this.historyDir, true);
      fs.mkdirSync(this.historyDir, { recursive: true });
      this._recover();
      return fn();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.unlinkSync(this.lockPath);
    }
  }

  _records() {
    return fs.readdirSync(this.historyDir).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map((name) => {
      const abs = path.join(this.historyDir, name);
      this._checkNode(abs);
      const record = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (!record || !Array.isArray(record.changes)) fail('MEMORY_HISTORY', '记忆历史记录损坏，已停止修改。');
      return { abs, record };
    });
  }

  _apply(changes, side) {
    for (const change of changes) {
      const abs = this._file(change.file);
      if (change[side] == null) fs.rmSync(abs, { force: true });
      else this._atomic(abs, change[side]);
    }
  }

  _recover() {
    for (const { abs, record } of this._records()) {
      if (record.state !== 'pending') continue;
      this._apply(record.changes, 'before');
      record.state = 'rolled_back';
      this._atomic(abs, JSON.stringify(record));
    }
  }

  _latestChanges() {
    const latest = new Map();
    const records = this._records().filter(({ record }) => record.state === 'committed')
      .map((item) => ({ ...item, mtime: fs.statSync(item.abs).mtimeMs }))
      .sort((a, b) => String(a.record.createdAt).localeCompare(String(b.record.createdAt)) || a.mtime - b.mtime);
    for (const { record } of records) {
      for (const change of record.changes) latest.set(fileKey(change.file), { record, change });
    }
    return latest;
  }

  _latestRelatedHistory(file, records) {
    return records.filter(({ record }) => record.state === 'committed' && record.changes.length > 1
      && ['status', 'restore'].includes(record.operation) && record.changes.some((change) => sameFile(change.file, file)))
      .sort(compareHistory).pop() || null;
  }

  _requiresRelatedRestore(item, related) {
    return item.record.changes.length === 1 && !!related && compareHistory(item, related) < 0;
  }

  _commit(changes, operation, options) {
    const id = crypto.randomUUID();
    const abs = path.join(this.historyDir, `${id}.json`);
    const record = { id, createdAt: new Date().toISOString(), operation, actor: isUser(options) ? 'user' : 'model', state: 'pending', changes };
    this._atomic(abs, JSON.stringify(record));
    try {
      this._apply(changes, 'after');
      record.state = 'committed';
      this._atomic(abs, JSON.stringify(record));
    } catch (error) {
      this._apply(changes, 'before');
      record.state = 'rolled_back';
      this._atomic(abs, JSON.stringify(record));
      throw error;
    }
    return id;
  }

  _read(file) {
    const abs = this._file(file);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const parsed = parseMemoryDocument(content);
    return { file, content, meta: parsed.meta, revision: revision(content), mtime: fs.statSync(abs).mtimeMs };
  }

  _access(entry, options, activeOnly = false) {
    if (isUser(options)) return;
    const check = (activeOnly ? memoryEligibility : memoryScopeEligibility)(entry.meta, options.context || {});
    if (!check.eligible) fail('MEMORY_SCOPE', '当前任务不可访问这条记忆。');
  }

  _expected(entry, options) {
    if (options.expectedRevision !== undefined && options.expectedRevision !== (entry ? entry.revision : null)) {
      fail('MEMORY_CONFLICT', '记忆已发生变化，请重新读取后再保存。');
    }
  }

  list(context = {}, options = {}) {
    return this._lock(() => fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((item) => item.isFile() && /\.md$/i.test(item.name) && item.name.toLowerCase() !== 'memory.md')
      .map((item) => this._read(item.name))
      .filter((entry) => entry && (isUser(options) && !options.eligibleOnly || memoryEligibility(entry.meta, context).eligible))
      .map(({ content, ...entry }) => entry)
      .sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)));
  }

  read(file, options = {}) {
    return this._lock(() => {
      const entry = this._read(file);
      if (!entry) fail('MEMORY_NOT_FOUND', '记忆文件不存在。');
      this._access(entry, options, true);
      return entry;
    });
  }

  _prepare(content, options, proposalFor = null) {
    const parsed = parseMemoryDocument(content);
    if (parsed.errors.length) fail('MEMORY_SCHEMA', `记忆元数据无效：${parsed.errors.join(', ')}`);
    if (isUser(options)) return String(content);
    const context = options.context || {};
    const meta = { ...parsed.meta, core: false,
      scope: proposalFor ? proposalFor.meta.scope : (context.projectId ? 'project' : 'global'),
      projectId: proposalFor ? proposalFor.meta.projectId : (context.projectId || null),
      sourceRef: context.sourceRef || null,
      status: options.userConfirmed && !proposalFor ? 'active' : 'draft',
      confidence: options.userConfirmed && !proposalFor ? 'user_confirmed' : 'inferred',
      supersedes: proposalFor ? proposalFor.file : null,
      supersedesRevision: proposalFor ? proposalFor.revision : null,
    };
    return `${serializeMemoryFrontmatter(meta)}\n${parsed.body}`;
  }

  _propose(file, content, options, previous) {
    if (!previous) fail('MEMORY_NOT_FOUND', '被替代的记忆不存在。');
    this._access(previous, options);
    this._expected(previous, options);
    const next = this._prepare(content, { ...options, actor: 'model', userConfirmed: false }, previous);
    for (const item of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!item.isFile() || !/\.md$/i.test(item.name) || item.name.toLowerCase() === 'memory.md') continue;
      const candidate = this._read(item.name);
      if (candidate && candidate.meta.status === 'draft' && candidate.meta.confidence === 'inferred'
        && candidate.meta.supersedes && sameFile(candidate.meta.supersedes, file)
        && candidate.meta.supersedesRevision === previous.revision && candidate.content === next) {
        const latest = this._latestChanges().get(fileKey(candidate.file));
        return { ...candidate, versionId: latest ? latest.record.id : null, proposalFor: file, deduplicated: true };
      }
    }
    let proposal;
    do { proposal = `${file.slice(0, -3).slice(0, 130)}-draft-${crypto.randomUUID()}.md`; }
    while (fs.existsSync(this._file(proposal)));
    const versionId = this._commit([{ file: proposal, before: null, after: next }], 'propose', options);
    return { ...this._read(proposal), versionId, proposalFor: file };
  }

  propose(file, content, options = {}) {
    return this._lock(() => this._propose(file, content, options, this._read(file)));
  }

  write(file, content, options = {}) {
    return this._lock(() => {
      const previous = this._read(file);
      this._expected(previous, options);
      if (previous) this._access(previous, options);
      if (!isUser(options) && previous && previous.meta.confidence === 'user_confirmed') {
        return this._propose(file, content, options, previous);
      }
      const proposalFor = previous && previous.meta.supersedes && previous.meta.supersedesRevision
        ? { file: previous.meta.supersedes, revision: previous.meta.supersedesRevision, meta: previous.meta } : null;
      const next = this._prepare(content == null ? '' : content, options, proposalFor);
      const versionId = this._commit([{ file, before: previous ? previous.content : null, after: next }], 'write', options);
      return { ...this._read(file), versionId };
    });
  }

  setStatus(file, status, options = {}) {
    requireUser(options);
    if (!VALID_STATUS.has(status)) fail('MEMORY_SCHEMA', '不支持的记忆状态。');
    return this._lock(() => {
      const previous = this._read(file);
      if (!previous) fail('MEMORY_NOT_FOUND', '记忆文件不存在。');
      this._expected(previous, options);
      if (previous.meta.status === status && (status !== 'active' || previous.meta.confidence === 'user_confirmed')) return previous;
      const parsed = parseMemoryDocument(previous.content);
      if (parsed.errors.length) fail('MEMORY_SCHEMA', '请先修正记忆元数据。');
      const changes = [];
      if (status === 'active' && previous.meta.supersedes && previous.meta.supersedesRevision) {
        const original = this._read(previous.meta.supersedes);
        if (!original || original.revision !== previous.meta.supersedesRevision) fail('MEMORY_CONFLICT', '原记忆已变化，请重新审核候选内容。');
        const old = parseMemoryDocument(original.content);
        changes.push({ file: original.file, before: original.content,
          after: `${serializeMemoryFrontmatter({ ...old.meta, status: 'superseded' })}\n${old.body}` });
      }
      changes.push({ file, before: previous.content,
        after: `${serializeMemoryFrontmatter({ ...parsed.meta, status, confidence: status === 'active' ? 'user_confirmed' : parsed.meta.confidence })}\n${parsed.body}` });
      const versionId = this._commit(changes, 'status', options);
      return { ...this._read(file), versionId };
    });
  }

  archive(file, options = {}) { return this.remove(file, { ...options, permanent: false }); }

  remove(file, options = {}) {
    requireUser(options);
    return this._lock(() => {
      const previous = this._read(file);
      this._expected(previous, options);
      if (options.permanent === true) {
        // Purge only this file's snapshots; shared approval transactions retain the other memory's history.
        for (const { abs, record } of this._records()) {
          record.changes = record.changes.filter((change) => !sameFile(change.file, file));
          if (record.changes.length) this._atomic(abs, JSON.stringify(record));
          else fs.unlinkSync(abs);
        }
        fs.rmSync(this._file(file), { force: true });
        return { file, permanent: true };
      }
      if (!previous) return { file, archived: true, versionId: null };
      const versionId = this._commit([{ file, before: previous.content, after: null }], 'archive', options);
      return { file, archived: true, versionId };
    });
  }

  history(file, options = {}) {
    requireUser(options);
    return this._lock(() => {
      this._file(file);
      const records = this._records();
      const related = this._latestRelatedHistory(file, records);
      return records.filter(({ record }) => record.state === 'committed').flatMap((item) => {
        const { record } = item;
        const requiresRelatedRestore = this._requiresRelatedRestore(item, related);
        return record.changes.filter((change) => sameFile(change.file, file)).map((change) => ({
          versionId: record.id, createdAt: record.createdAt, operation: record.operation,
          revision: revision(change.before == null ? change.after : change.before), archived: change.after == null,
          requiresRelatedRestore, relatedVersionId: requiresRelatedRestore ? related.record.id : null,
        }));
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  archived(options = {}) {
    requireUser(options);
    return this._lock(() => [...this._latestChanges().values()]
      .filter(({ record, change }) => ['remove', 'archive'].includes(record.operation)
        && change.after == null && change.before != null && !fs.existsSync(this._file(change.file)))
      .map(({ record, change }) => ({ file: change.file, meta: parseMemoryDocument(change.before).meta,
        versionId: record.id, createdAt: record.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.file.localeCompare(b.file)));
  }

  restore(file, versionId, options = {}) {
    requireUser(options);
    return this._lock(() => {
      const previous = this._read(file);
      this._expected(previous, options);
      const records = this._records();
      const found = records.find(({ record }) => record.id === versionId && record.state === 'committed');
      const change = found && found.record.changes.find((item) => sameFile(item.file, file));
      if (!change) fail('MEMORY_NOT_FOUND', '记忆历史版本不存在。');
      if (this._requiresRelatedRestore(found, this._latestRelatedHistory(file, records))) {
        fail('MEMORY_CONFLICT', '该版本早于关联审批，不能单独恢复。请选择关联的审批或整体恢复记录，同步恢复原记忆和候选记忆。');
      }
      if (found.record.changes.length > 1) {
        // Approval moves the original and candidate together. Reverting either entry must
        // revert the whole transaction, including when this is undoing a previous restore.
        const changes = found.record.changes.map((snapshot) => {
          const current = this._read(snapshot.file);
          if ((current ? current.revision : null) !== revision(snapshot.after)) {
            fail('MEMORY_CONFLICT', '关联记忆已发生变化，不能单独恢复这次审批。请重新读取并审核关联记忆。');
          }
          return { file: snapshot.file, before: current ? current.content : null, after: snapshot.before };
        });
        const restored = this._commit(changes, 'restore', options);
        return { ...this._read(file), versionId: restored, restoredFiles: changes.map((item) => item.file) };
      }
      const content = change.before == null ? change.after : change.before;
      if (content == null) fail('MEMORY_NOT_FOUND', '历史版本没有可恢复内容。');
      const restored = this._commit([{ file, before: previous ? previous.content : null, after: content }], 'restore', options);
      return { ...this._read(file), versionId: restored };
    });
  }

  writeIndex(content) {
    return this._lock(() => {
      const abs = this._file('MEMORY.md', true);
      if (content) this._atomic(abs, String(content));
      else fs.rmSync(abs, { force: true });
    });
  }
}

function guardMemoryToolInput(toolName, input = {}, { memoryDir, cwd = process.cwd() } = {}) {
  if (!memoryDir) return null;
  cwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const name = String(toolName || '').split('__').pop();
  const read = /^(Read|Glob|Grep|LS)$/i.test(name);
  const write = /^(Write|Edit|MultiEdit|NotebookEdit|Delete|Move)$/i.test(name);
  if (!read && !write) return null;
  const win = /^[a-z]:[\\/]|^\\\\/i.test(memoryDir);
  const paths = win ? path.win32 : path.posix;
  const portable = (value) => {
    const normalized = String(value).replace(/\\/g, '/');
    return win ? normalized.replace(/^\/mnt\/([a-z])(?:\/|$)/i, (_, drive) => `${drive}:/`) : normalized;
  };
  const normalize = (value) => {
    let resolved = paths.resolve(portable(cwd), portable(value));
    let ancestor = resolved;
    const suffix = [];
    while (true) {
      try { resolved = paths.join(fs.realpathSync(ancestor), ...suffix); break; }
      catch (_) {
        const parent = paths.dirname(ancestor);
        if (parent === ancestor) break;
        suffix.unshift(paths.basename(ancestor)); ancestor = parent;
      }
    }
    return resolved.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  };
  const root = normalize(memoryDir);
  const candidates = [input.file_path, input.path, input.notebook_path, input.destination, input.source];
  if (/^Glob$/i.test(name) && typeof input.pattern === 'string' && /[\\/]/.test(input.pattern)) candidates.push(input.pattern);
  if (Array.isArray(input.edits)) candidates.push(...input.edits.map((edit) => edit.file_path));
  if (read && !candidates.some(Boolean)) candidates.push(cwd);
  for (const candidate of candidates.filter((value) => typeof value === 'string' && value)) {
    const abs = normalize(candidate);
    const inside = abs === root || abs.startsWith(`${root}/`);
    const recursiveParent = /^(Glob|Grep|LS)$/i.test(name) && root.startsWith(`${abs}/`);
    const sdkMemory = /(?:^|\/)\.claude\/(?:projects\/[^/]+\/)?memory(?:\/|$)/i.test(abs);
    if (inside || recursiveParent || (write && sdkMemory)) {
      return { behavior: 'deny', message: '记忆由 Relay 管理，请使用 Relay 记忆工具；索引、归档和 SDK 记忆目录不能直接修改。' };
    }
  }
  return null;
}

module.exports = { MemoryStore, guardMemoryToolInput };
