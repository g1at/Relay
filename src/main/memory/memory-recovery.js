'use strict';

// Recovery data, not a version library: one short-lived undo, one snapshot per
// removed memory, and a journal only while a transaction is incomplete.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UNDO_TTL_MS = 5 * 60 * 1000;
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
const same = (a, b) => key(a) === key(b);
const digest = content => content == null ? null : crypto.createHash('sha256').update(content).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const legacyName = name => /^[0-9a-f-]{36}\.json$/.test(name);
const purgeName = name => /^\.purge-[0-9a-f-]{36}\.json$/.test(name);
const empty = () => ({ format: 1, archives: [], undo: null, pending: null });

class MemoryRecovery {
  constructor(store, now) {
    this.store = store;
    this.now = now;
    this.path = path.join(store.dir, '.relay-memory-recovery.json');
    this.legacyDir = path.join(store.dir, '.history');
    this.state = null;
  }

  _json(abs) {
    if (!this.store._checkNode(abs)) return undefined;
    try { return JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (error) { fail('MEMORY_RECOVERY', '记忆恢复数据无法读取，已停止修改。'); }
  }

  _validateFile(file) { this.store._file(file); }

  _validate(state) {
    const objectOrNull = value => value === null || value && typeof value === 'object' && !Array.isArray(value);
    if (!state || state.format !== 1 || !Array.isArray(state.archives)
      || !objectOrNull(state.undo) || !objectOrNull(state.pending)
      || state.legacyCleanup !== undefined && typeof state.legacyCleanup !== 'boolean') fail('MEMORY_RECOVERY', '记忆恢复数据格式无效。');
    const names = new Set();
    for (const item of state.archives) {
      this._validateFile(item.file);
      if (names.has(key(item.file)) || typeof item.id !== 'string' || !item.id || typeof item.content !== 'string'
        || !Number.isFinite(Date.parse(item.createdAt))) fail('MEMORY_RECOVERY', '已移除记忆的恢复数据无效。');
      names.add(key(item.file));
    }
    const validateChanges = changes => {
      if (!Array.isArray(changes) || !changes.length) fail('MEMORY_RECOVERY', '记忆事务数据无效。');
      const files = new Set();
      for (const change of changes) {
        this._validateFile(change.file);
        if (files.has(key(change.file)) || !(change.before === null || typeof change.before === 'string')
          || !(change.afterRevision === null || /^[0-9a-f]{64}$/.test(change.afterRevision))) fail('MEMORY_RECOVERY', '记忆事务数据无效。');
        files.add(key(change.file));
      }
    };
    if (state.undo) {
      this._validateFile(state.undo.file);
      if (typeof state.undo.id !== 'string' || !Number.isFinite(Date.parse(state.undo.expiresAt))) fail('MEMORY_RECOVERY', '记忆撤销数据无效。');
      validateChanges(state.undo.changes);
      if (!state.undo.changes.some(change => same(change.file, state.undo.file))) fail('MEMORY_RECOVERY', '记忆撤销目标无效。');
    }
    if (state.pending) {
      if (state.pending.operation === 'purge') {
        this._validateFile(state.pending.file);
        if (!(state.pending.previousRevision === null || /^[0-9a-f]{64}$/.test(state.pending.previousRevision))) fail('MEMORY_RECOVERY', '永久删除事务无效。');
      } else if (state.pending.operation === 'write') validateChanges(state.pending.changes);
      else fail('MEMORY_RECOVERY', '未知的记忆恢复事务。');
    }
    return state;
  }

  _save(state) {
    this._validate(state);
    this.store._atomic(this.path, JSON.stringify(state));
    this.state = state;
  }

  _legacyEntries() {
    if (!this.store._checkNode(this.legacyDir, true)) return [];
    return fs.readdirSync(this.legacyDir).filter(legacyName).map(name => {
      const abs = path.join(this.legacyDir, name), record = this._json(abs);
      if (!record || !Array.isArray(record.changes) || !['pending', 'committed', 'rolled_back'].includes(record.state)) fail('MEMORY_HISTORY', '旧记忆恢复记录无效，已保留原数据。');
      for (const change of record.changes) {
        this._validateFile(change.file);
        if (![change.before, change.after].every(value => value === null || typeof value === 'string')) fail('MEMORY_HISTORY', '旧记忆恢复内容无效。');
      }
      const mtime = Number.isFinite(record.historyOrderMtimeMs) ? record.historyOrderMtimeMs : fs.statSync(abs).mtimeMs;
      return { abs, record, mtime };
    });
  }

  _legacyPurges() {
    if (!this.store._checkNode(this.legacyDir, true)) return [];
    return fs.readdirSync(this.legacyDir).filter(purgeName).map(name => {
      const abs = path.join(this.legacyDir, name), record = this._json(abs);
      if (!record || record.version !== 1 || record.operation !== 'purge'
        || !(record.previousRevision === null || /^[0-9a-f]{64}$/.test(record.previousRevision))) fail('MEMORY_HISTORY', '旧永久删除记录无效。');
      this._validateFile(record.file);
      return { abs, record };
    });
  }

  _recoverLegacy() {
    // A durable deletion intent always wins over older rollback snapshots.
    for (const { abs, record } of this._legacyPurges()) {
      const current = this.store._read(record.file);
      if (current && current.revision !== record.previousRevision) fail('MEMORY_PURGE_CONFLICT', '永久删除期间出现了同名新记忆，已保留新文件。');
      const entries = this._legacyEntries();
      for (const item of entries) {
        const changes = item.record.changes.filter(change => !same(change.file, record.file));
        if (changes.length === item.record.changes.length) continue;
        if (changes.length) this.store._atomic(item.abs, JSON.stringify({ ...item.record, historyOrderMtimeMs: item.mtime, changes }));
        else fs.unlinkSync(item.abs);
      }
      fs.rmSync(this.store._file(record.file), { force: true });
      fs.unlinkSync(abs);
    }
    for (const { abs, record } of this._legacyEntries()) {
      if (record.state !== 'pending') continue;
      this._rollback(record.changes.map(change => ({ file: change.file, before: change.before, afterRevision: digest(change.after) })));
      this.store._atomic(abs, JSON.stringify({ ...record, state: 'rolled_back' }));
    }
  }

  _cleanLegacy() {
    if (!this.store._checkNode(this.legacyDir, true)) return;
    for (const name of fs.readdirSync(this.legacyDir)) {
      // Only files owned by the old store, including abandoned atomic writes.
      if (!legacyName(name) && !purgeName(name) && !/^(?:\.purge-)?[0-9a-f-]{36}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const abs = path.join(this.legacyDir, name);
      this.store._checkNode(abs);
      fs.unlinkSync(abs);
    }
    if (!fs.readdirSync(this.legacyDir).length) fs.rmdirSync(this.legacyDir);
  }

  _cleanupTemporaryWrites() {
    for (const name of fs.readdirSync(this.store.dir)) {
      if (!/^(?:\.relay-memory-recovery\.json|[^/\\]+\.md)\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const abs = path.join(this.store.dir, name);
      this.store._checkNode(abs);
      fs.unlinkSync(abs);
    }
  }

  open({ recover = true } = {}) {
    const saved = this._json(this.path);
    this.state = saved === undefined ? empty() : this._validate(saved);
    if (this.state.pending) {
      if (!recover) fail('MEMORY_RECOVERY_REQUIRED', '记忆库有未完成的更新，请先打开记忆页完成恢复。');
      if (this.state.pending.operation === 'purge') this._completePurge();
      else {
        this._rollback(this.state.pending.changes);
        this._save({ ...this.state, pending: null });
      }
    }
    if (this.state.legacyCleanup) {
      if (!recover) fail('MEMORY_RECOVERY_REQUIRED', '旧记忆恢复数据正在迁移，请先打开记忆页完成清理。');
      this._cleanLegacy();
      this._save({ ...this.state, legacyCleanup: false });
    }
    let entries = this._legacyEntries();
    const purges = this._legacyPurges();
    if (entries.length || purges.length) {
      if (!recover && (purges.length || entries.some(item => item.record.state === 'pending'))) fail('MEMORY_RECOVERY_REQUIRED', '旧记忆库有未完成的更新，请先打开记忆页完成恢复。');
      if (recover) { this._recoverLegacy(); entries = this._legacyEntries(); }
      const latest = new Map();
      entries.filter(item => item.record.state === 'committed')
        .sort((a, b) => String(a.record.createdAt).localeCompare(String(b.record.createdAt)) || a.mtime - b.mtime)
        .forEach(item => item.record.changes.forEach(change => latest.set(key(change.file), { record: item.record, change })));
      const archives = new Map(this.state.archives.map(item => [key(item.file), item]));
      for (const [file, { record, change }] of latest) {
        if (['archive', 'remove'].includes(record.operation) && change.after === null && change.before !== null) {
          archives.set(file, { id: record.id, file: change.file, createdAt: record.createdAt || new Date(this.now()).toISOString(), content: change.before });
        }
      }
      const migrated = { ...this.state, archives: [...archives.values()], undo: null, legacyCleanup: true };
      if (recover) {
        // Persist every surviving archive before deleting any old version. This
        // marker makes a crash halfway through cleanup safe and idempotent.
        this._save(migrated);
        this._cleanLegacy();
        this._save({ ...migrated, legacyCleanup: false });
      } else this.state = { ...migrated, legacyCleanup: false };
    }
    const undo = this.state.undo;
    const expired = undo && Date.parse(undo.expiresAt) <= this.now();
    const stale = undo && undo.changes.some(change => (this.store._read(change.file)?.revision || null) !== change.afterRevision);
    if (expired || stale) {
      const next = { ...this.state, undo: null };
      if (recover) this._save(next); else this.state = next;
    } else if (saved === undefined && recover && !fs.existsSync(this.path)) this._save(this.state);
    if (recover) this._cleanupTemporaryWrites();
  }

  _rollback(changes) {
    for (const change of changes) {
      const current = this.store._read(change.file)?.revision || null;
      if (current !== digest(change.before) && current !== change.afterRevision) fail('MEMORY_RECOVERY_CONFLICT', '异常更新后记忆已被其他操作修改，已保留当前内容并停止恢复。');
    }
    for (const change of changes) {
      if (change.before === null) fs.rmSync(this.store._file(change.file), { force: true });
      else this.store._atomic(this.store._file(change.file), change.before);
    }
  }

  commit(changes, operation, options = {}) {
    const before = this.state;
    const id = crypto.randomUUID();
    const now = this.now(), createdAt = new Date(now).toISOString();
    const touched = file => changes.some(change => same(change.file, file));
    const snapshots = changes.map(change => ({ file: change.file, before: change.before, afterRevision: digest(change.after) }));
    let undo = operation === 'undo' || before.undo?.changes.some(change => touched(change.file)) ? null : before.undo;
    let result = {};
    if (operation === 'status' && options.undoFile) {
      undo = { id, file: options.undoFile, createdAt, expiresAt: new Date(now + UNDO_TTL_MS).toISOString(), changes: snapshots };
      result = { undoId: id, undoExpiresAt: undo.expiresAt };
    }
    // A newly created same-name memory must not silently destroy a removed
    // memory's recovery copy. Only explicit archive/restore/purge consumes it.
    const archives = ['archive', 'restoreArchive'].includes(operation)
      ? before.archives.filter(item => !touched(item.file)) : [...before.archives];
    if (operation === 'archive') {
      for (const change of changes) if (change.before !== null && change.after === null) archives.push({ id, file: change.file, createdAt, content: change.before });
      result.archiveId = id;
    }
    const pending = { operation: 'write', changes: snapshots };
    this._save({ ...before, pending });
    try {
      for (const change of changes) {
        if (change.after === null) fs.rmSync(this.store._file(change.file), { force: true });
        else this.store._atomic(this.store._file(change.file), change.after);
      }
      this._save({ ...before, generation: id, archives, undo, pending: null });
    } catch (error) {
      // An I/O wrapper can throw after a successful atomic rename. A committed
      // generation must never be rolled back after its journal disappeared.
      const durable = this._json(this.path);
      if (durable?.generation === id && !durable.pending) { this.state = this._validate(durable); return result; }
      this._rollback(snapshots);
      this._save(before);
      throw error;
    }
    return result;
  }

  _completePurge() {
    const pending = this.state.pending;
    const current = this.store._read(pending.file);
    if (current && current.revision !== pending.previousRevision) fail('MEMORY_PURGE_CONFLICT', '永久删除期间出现了同名新记忆，已保留新文件。');
    fs.rmSync(this.store._file(pending.file), { force: true });
    this._save({ ...this.state, generation: pending.id, pending: null,
      archives: this.state.archives.filter(item => !same(item.file, pending.file)),
      undo: this.state.undo?.changes.some(change => same(change.file, pending.file)) ? null : this.state.undo });
  }

  purge(file, previous) {
    const id = crypto.randomUUID();
    let accepted = false;
    try {
      this._save({ ...this.state, pending: { operation: 'purge', id, file, previousRevision: previous?.revision || null } });
      accepted = true;
      this._completePurge();
    }
    catch (cause) {
      if (cause.code === 'MEMORY_PURGE_CONFLICT') throw cause;
      let durable;
      try { durable = this._json(this.path); }
      catch (readError) { if (!accepted) throw readError; }
      if (durable?.generation === id && !durable.pending) {
        this.state = this._validate(durable);
        return { file, permanent: true };
      }
      if (durable?.pending?.id === id) { accepted = true; this.state = this._validate(durable); }
      if (!accepted) throw cause;
      const error = new Error('永久删除尚未完成，下次打开记忆库时会继续清理。');
      error.code = 'MEMORY_PURGE_PENDING'; error.cause = cause; throw error;
    }
    return { file, permanent: true };
  }
}

module.exports = { MemoryRecovery, UNDO_TTL_MS };
