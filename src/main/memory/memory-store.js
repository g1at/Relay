'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryRecovery } = require('./memory-recovery');
const {
  VALID_STATUS, VALID_TYPES, MAX_MEMORY_SOURCES, MAX_MEMORY_REPLACES, normalizeMemoryMeta, parseMemoryDocument, serializeMemoryFrontmatter,
  memoryEligibility, memoryScopeEligibility,
} = require('./memory-schema');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function revision(content) { return content == null ? null : crypto.createHash('sha256').update(content).digest('hex'); }
function fileKey(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }
function sameFile(a, b) { return fileKey(a) === fileKey(b); }
function isUser(options) { return !options.actor || options.actor === 'user'; }
function requireUser(options) { if (!isUser(options)) fail('MEMORY_PERMISSION', '请在 Relay 记忆管理中确认此操作。'); }
function replacements(meta) {
  const targets = [...(meta.replaces || [])];
  if (meta.supersedes && meta.supersedesRevision && !targets.some((item) => sameFile(item.file, meta.supersedes))) {
    targets.push({ file: meta.supersedes, revision: meta.supersedesRevision });
  }
  return targets;
}
function mergeSources(...groups) {
  const unique = new Map();
  for (const source of groups.flat()) unique.set(JSON.stringify(source), source);
  const result = [...unique.values()];
  if (result.length > MAX_MEMORY_SOURCES) fail('MEMORY_SCHEMA', '来源超过 32 条，请缩小归并范围；原始证据未被丢弃。');
  return result;
}
function legacyFields(parsed) {
  if (parsed.errors.includes('invalid_frontmatter')) return [];
  return ['scope', 'status', 'confidence'].filter((key) => String(parsed.frontmatter[key] ?? '').trim() === '');
}

class MemoryStore {
  constructor({ dir, isCore, now = () => Date.now() } = {}) {
    if (!dir) throw new TypeError('MemoryStore requires dir');
    this.dir = path.resolve(dir);
    this.now = now;
    this.recovery = new MemoryRecovery(this, now);
    this.recoveryPath = this.recovery.path;
    this.lockPath = path.join(this.dir, '.relay-memory.lock');
    this.isCore = typeof isCore === 'function' ? isCore : () => false;
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

  _lock(fn, { recover = true } = {}) {
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
      this.recovery.open({ recover });
      return fn();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.unlinkSync(this.lockPath);
    }
  }

  _commit(changes, operation, options = {}) {
    return this.recovery.commit(changes, operation, options);
  }

  _purge(file, previous) {
    return this.recovery.purge(file, previous);
  }

  _read(file) {
    const abs = this._file(file);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const parsed = parseMemoryDocument(content);
    return { file, content, meta: parsed.meta, legacyFields: legacyFields(parsed),
      revision: revision(content), mtime: fs.statSync(abs).mtimeMs };
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

  _protectCore(entry, options = {}) {
    const names = new Set([entry.file]);
    // The sidecar may keep the original spelling while Windows accepts an alias.
    if (process.platform === 'win32') {
      for (const file of fs.readdirSync(this.dir)) if (sameFile(file, entry.file)) names.add(file);
    }
    if (entry.meta.core || [...names].some(file => this.isCore(file)
      || typeof options.isCore === 'function' && options.isCore(file))) {
      fail('MEMORY_CORE', '核心记忆只报告问题，由用户决定是否修改。');
    }
  }

  _replacementEntries(targets, meta, candidateFile, options = {}) {
    return targets.map((target) => {
      if (sameFile(target.file, candidateFile)) fail('MEMORY_CONFLICT', '候选记忆不能替代自身。');
      const original = this._read(target.file);
      if (!original || original.revision !== target.revision) fail('MEMORY_CONFLICT', '原记忆已变化，请重新审核候选内容。');
      this._protectCore(original, options);
      if (original.meta.scope !== meta.scope || original.meta.projectId !== meta.projectId) {
        fail('MEMORY_SCOPE', '归并记忆必须属于同一作用域和项目。');
      }
      const confirmed = original.meta.status === 'active' && original.meta.confidence === 'user_confirmed';
      const sourcedDraft = original.meta.status === 'draft' && original.meta.confidence === 'inferred' && original.meta.sources.length;
      if (original.meta.schemaErrors.length || !(confirmed || sourcedDraft)) {
        fail('MEMORY_CONFLICT', '只能替代当前已确认的记忆或带来源的待确认候选。');
      }
      return original;
    });
  }

  _expandReplacementTargets(targets, meta, candidateFile, options) {
    const all = [], seen = new Map();
    const pending = [...targets];
    for (let index = 0; index < pending.length; index++) {
      const target = pending[index], key = fileKey(target.file);
      if (seen.has(key)) {
        if (seen.get(key) !== target.revision) fail('MEMORY_CONFLICT', '归并链包含不同的原记忆修订。');
        continue;
      }
      if (all.length >= MAX_MEMORY_REPLACES) fail('MEMORY_SCHEMA', '归并链超过 16 条，请缩小归并范围。');
      const [entry] = this._replacementEntries([target], meta, candidateFile, options);
      seen.set(key, target.revision); all.push(entry);
      // A draft that already replaces an older fact has not retired it yet. Include that
      // dependency so approving the merged candidate cannot leave the older fact active.
      if (entry.meta.status === 'draft') pending.push(...replacements(entry.meta));
    }
    return all;
  }

  list(context = {}, options = {}) {
    return this._lock(() => fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((item) => item.isFile() && /\.md$/i.test(item.name) && item.name.toLowerCase() !== 'memory.md')
      .map((item) => this._read(item.name))
      .filter((entry) => entry && (isUser(options) && !options.eligibleOnly || memoryEligibility(entry.meta, context).eligible))
      .map(({ content, ...entry }) => entry)
      .sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)), { recover: options.readOnly !== true });
  }

  read(file, options = {}) {
    return this._lock(() => {
      const entry = this._read(file);
      if (!entry) fail('MEMORY_NOT_FOUND', '记忆文件不存在。');
      this._access(entry, options, true);
      return entry;
    });
  }

  _prepare(content, options, proposalFor = null, previous = null) {
    const parsed = parseMemoryDocument(content);
    if (parsed.errors.length) fail('MEMORY_SCHEMA', `记忆元数据无效：${parsed.errors.join(', ')}`);
    if (isUser(options)) {
      const inherited = previous && previous.meta;
      const targets = inherited ? replacements(inherited) : [];
      if (!(inherited && inherited.sources.length) && !targets.length
        && !Object.hasOwn(parsed.frontmatter, 'sources') && !Object.hasOwn(parsed.frontmatter, 'replaces')) return String(content);
      // Editing text cannot fabricate evidence or silently apply a linked approval.
      const meta = { ...(inherited && !parsed.hasFrontmatter ? inherited : parsed.meta),
        sources: inherited ? inherited.sources : [], replaces: targets,
        supersedes: inherited ? inherited.supersedes : null, supersedesRevision: inherited ? inherited.supersedesRevision : null,
        ...(targets.length ? { status: inherited.status, confidence: inherited.confidence,
          scope: inherited.scope, projectId: inherited.projectId } : {}) };
      return `${serializeMemoryFrontmatter(meta)}\n${parsed.body}`;
    }
    if (Object.hasOwn(options, 'memoryType') && !VALID_TYPES.has(options.memoryType)) {
      fail('MEMORY_SCHEMA', '记忆 type 无效，必须选择 user、feedback、project 或 reference。');
    }
    const bodyType = Object.hasOwn(parsed.frontmatter, 'type') ? parsed.meta.type : null;
    if (options.memoryType && parsed.meta.type && options.memoryType !== parsed.meta.type) {
      fail('MEMORY_SCHEMA', '记忆正文 type 与工具参数不一致，请按正文主旨选择同一类型。');
    }
    const type = options.memoryType || bodyType;
    if (!VALID_TYPES.has(type)) fail('MEMORY_SCHEMA', '新生成的记忆必须明确填写 type：user、feedback、project 或 reference。');
    const context = options.context || {};
    const trusted = normalizeMemoryMeta({ sources: context.sources });
    if (trusted.schemaErrors.length) fail('MEMORY_SCHEMA', '宿主记忆来源格式无效。');
    const inherited = previous || proposalFor;
    const targets = proposalFor && (!previous || previous.file === proposalFor.file)
      ? [{ file: proposalFor.file, revision: proposalFor.revision }]
      : previous ? replacements(previous.meta) : [];
    const meta = { ...parsed.meta, type, core: false,
      scope: inherited ? inherited.meta.scope : (context.projectId ? 'project' : 'global'),
      projectId: inherited ? inherited.meta.projectId : (context.projectId || null),
      sourceRef: context.sourceRef || inherited && inherited.meta.sourceRef || null,
      sources: mergeSources(inherited && inherited.meta.sources || [], trusted.sources,
        proposalFor && (!previous || previous.file === proposalFor.file) ? [{ kind: 'memory', file: proposalFor.file, revision: proposalFor.revision }] : []),
      replaces: targets,
      status: options.userConfirmed && !targets.length ? 'active' : 'draft',
      confidence: options.userConfirmed && !targets.length ? 'user_confirmed' : 'inferred',
      supersedes: targets.length ? targets[0].file : null,
      supersedesRevision: targets.length ? targets[0].revision : null,
    };
    return `${serializeMemoryFrontmatter(meta)}\n${parsed.body}`;
  }

  _propose(file, content, options, previous) {
    if (!previous) fail('MEMORY_NOT_FOUND', '被替代的记忆不存在。');
    this._access(previous, options);
    this._expected(previous, options);
    this._protectCore(previous, options);
    const next = this._prepare(content, { ...options, actor: 'model', userConfirmed: false }, previous, previous);
    for (const item of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!item.isFile() || !/\.md$/i.test(item.name) || item.name.toLowerCase() === 'memory.md') continue;
      const candidate = this._read(item.name);
      if (candidate && candidate.meta.status === 'draft' && candidate.meta.confidence === 'inferred'
        && candidate.meta.supersedes && sameFile(candidate.meta.supersedes, file)
        && candidate.meta.supersedesRevision === previous.revision && candidate.content === next) {
        return { ...candidate, proposalFor: file, deduplicated: true };
      }
    }
    let proposal;
    do { proposal = `${file.slice(0, -3).slice(0, 130)}-draft-${crypto.randomUUID()}.md`; }
    while (fs.existsSync(this._file(proposal)));
    this._commit([{ file: proposal, before: null, after: next }], 'propose', options);
    return { ...this._read(proposal), proposalFor: file };
  }

  propose(file, content, options = {}) {
    return this._lock(() => this._propose(file, content, options, this._read(file)));
  }

  // Host-only entry point. The history learner supplies already verified transcript evidence;
  // this is deliberately absent from the model-facing memory MCP tools.
  proposeLearning(candidate, options = {}) {
    return this._lock(() => {
      if (!candidate || typeof candidate !== 'object') fail('MEMORY_SCHEMA', '学习候选内容无效。');
      const { file, name, description, type, body, sources, replaces: targets = [] } = candidate;
      this._file(file);
      if (!VALID_TYPES.has(type) || typeof name !== 'string' || !name.trim() || name.length > 120
        || typeof description !== 'string' || description.length > 500
        || typeof body !== 'string' || !body.trim() || body.length > 32000) fail('MEMORY_SCHEMA', '学习候选须有明确类型、名称和正文。');
      const context = options.context || {};
      const meta = normalizeMemoryMeta({ name, description, type, sources, replaces: targets,
        scope: context.projectId ? 'project' : 'global', projectId: context.projectId || null,
        status: 'draft', confidence: 'inferred' });
      if (meta.schemaErrors.length || !meta.sources.length) fail('MEMORY_SCHEMA', '学习候选必须附带有效来源和替换修订。');
      const originals = this._expandReplacementTargets(meta.replaces, meta, file, options);
      meta.replaces = originals.map(({ file: targetFile, revision: targetRevision }) => ({ file: targetFile, revision: targetRevision }));
      meta.sources = mergeSources(...originals.map((entry) => entry.meta.sources), meta.sources,
        originals.map((entry) => ({ kind: 'memory', file: entry.file, revision: entry.revision })));
      if (meta.replaces.length) {
        meta.supersedes = meta.replaces[0].file;
        meta.supersedesRevision = meta.replaces[0].revision;
      }
      const content = `${serializeMemoryFrontmatter(meta)}\n${body}`;
      const previous = this._read(file);
      if (previous) {
        if (previous.content !== content) fail('MEMORY_CONFLICT', '学习候选文件已存在不同内容，已保留原文件。');
        return { ...previous, deduplicated: true };
      }
      this._commit([{ file, before: null, after: content }], 'learn', { actor: 'model' });
      return this._read(file);
    });
  }

  write(file, content, options = {}) {
    return this._lock(() => {
      const previous = this._read(file);
      this._expected(previous, options);
      if (previous) this._access(previous, options);
      if (previous && !isUser(options)) this._protectCore(previous, options);
      if (!isUser(options) && previous && previous.meta.confidence === 'user_confirmed') {
        return this._propose(file, content, options, previous);
      }
      const proposalFor = previous && previous.meta.supersedes && previous.meta.supersedesRevision
        ? { file: previous.meta.supersedes, revision: previous.meta.supersedesRevision, meta: previous.meta } : null;
      const next = this._prepare(content == null ? '' : content, options, proposalFor, previous);
      this._commit([{ file, before: previous ? previous.content : null, after: next }], 'write', options);
      return this._read(file);
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
      if (status === 'active' && replacements(previous.meta).length) {
        // Validate every participant before producing changes or recovery data.
        const originals = this._replacementEntries(replacements(previous.meta), previous.meta, file, options);
        for (const original of originals) {
          const old = parseMemoryDocument(original.content);
          changes.push({ file: original.file, before: original.content,
            after: `${serializeMemoryFrontmatter({ ...old.meta, status: 'superseded' })}\n${old.body}` });
        }
      }
      changes.push({ file, before: previous.content,
        after: `${serializeMemoryFrontmatter({ ...parsed.meta, status, confidence: status === 'active' ? 'user_confirmed' : parsed.meta.confidence })}\n${parsed.body}` });
      const needsConfirmation = previous.meta.status === 'draft' || previous.meta.confidence === 'inferred';
      const undoFile = needsConfirmation && ['active', 'expired'].includes(status) ? file : null;
      const result = this._commit(changes, 'status', { ...options, undoFile });
      return { ...this._read(file), ...result };
    });
  }

  archive(file, options = {}) { return this.remove(file, { ...options, permanent: false }); }

  purgeArchived(file, options = {}) {
    requireUser(options);
    return this._lock(() => {
      this._file(file);
      const snapshot = this.recovery.state.archives.find(item => sameFile(item.file, file));
      if (this._read(file) || !snapshot || typeof options.expectedArchiveId !== 'string'
        || snapshot.id !== options.expectedArchiveId) fail('MEMORY_CONFLICT', '这条记忆的移除状态已变化，请刷新已移除列表后重试。');
      return { ...this._purge(snapshot.file, null), purgedArchiveId: snapshot.id };
    });
  }

  remove(file, options = {}) {
    requireUser(options);
    return this._lock(() => {
      const previous = this._read(file);
      this._expected(previous, options);
      if (options.permanent === true) return this._purge(file, previous);
      if (!previous) return { file, archived: true, archiveId: null };
      const result = this._commit([{ file, before: previous.content, after: null }], 'archive', options);
      return { file, archived: true, ...result };
    });
  }

  archived(options = {}) {
    requireUser(options);
    return this._lock(() => this.recovery.state.archives.filter(snapshot => !this._read(snapshot.file)).map(snapshot => {
      const parsed = parseMemoryDocument(snapshot.content);
      return { file: snapshot.file, meta: parsed.meta, legacyFields: legacyFields(parsed),
        archiveId: snapshot.id, createdAt: snapshot.createdAt };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.file.localeCompare(b.file)), { recover: options.readOnly !== true });
  }

  restoreArchived(file, archiveId, options = {}) {
    requireUser(options);
    return this._lock(() => {
      this._file(file);
      // Restoring an archive must never replace a live or recreated memory.
      if (this._read(file)) fail('MEMORY_CONFLICT', '已有同名记忆，无法恢复覆盖。');
      const snapshot = this.recovery.state.archives.find(item => sameFile(item.file, file));
      if (!snapshot || typeof archiveId !== 'string' || snapshot.id !== archiveId) fail('MEMORY_CONFLICT', '这条记忆的移除状态已变化，请刷新后重试。');
      this._commit([{ file: snapshot.file, before: null, after: snapshot.content }], 'restoreArchive', options);
      return this._read(snapshot.file);
    });
  }

  undo(file, undoId, options = {}) {
    requireUser(options);
    return this._lock(() => {
      this._file(file);
      const snapshot = this.recovery.state.undo;
      if (!snapshot || Date.parse(snapshot.expiresAt) <= this.now()) fail('MEMORY_UNDO_EXPIRED', '这次操作已无法撤销，请刷新后查看当前记忆。');
      if (typeof undoId !== 'string' || snapshot.id !== undoId || !sameFile(snapshot.file, file)) fail('MEMORY_CONFLICT', '撤销目标已变化，请刷新后重试。');
      this._expected(this._read(file), options);
      const changes = snapshot.changes.map(change => {
        const current = this._read(change.file);
        if ((current?.revision || null) !== change.afterRevision) fail('MEMORY_CONFLICT', '关联记忆已发生变化，不能撤销这次操作。');
        return { file: change.file, before: current?.content ?? null, after: change.before };
      });
      this._commit(changes, 'undo', options);
      return { ...this._read(file), restoredFiles: changes.map(change => change.file) };
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
