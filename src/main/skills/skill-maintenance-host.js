'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanPackage, sameManifest, parseSkillFrontmatter } = require('./skill-draft-service');
const { normalizeMaintenancePolicy, evaluateSkillMaintenance, evaluateMaintenanceRun } = require('./skill-maintenance-policy');

const PUBLICATION_SOURCES = new Set(['conversation-review', 'skill-curator', 'sdk-proposal']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
function safeName(value) {
  if (typeof value !== 'string' || !value || value.startsWith('.') || /[\\/<>:"|?*\x00-\x1f]/.test(value)
      || ['__proto__', 'constructor', 'prototype'].includes(value)
      || /[. ]$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) {
    throw failure('INVALID_SKILL_NAME', '非法技能名');
  }
  return value;
}

class SkillMaintenanceHost {
  constructor(options = {}) {
    this.skillsDir = path.resolve(options.skillsDir);
    this.stateDir = path.resolve(options.stateDir);
    this.schedulesFile = path.resolve(options.schedulesFile);
    this.draftsDir = path.resolve(options.draftsDir);
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.io = options.fs || fs;
    this.now = options.now || Date.now;
    this.scan = options.scanPackage || scanPackage;
    this.running = false;
  }

  readJson(file, missing) {
    try { return JSON.parse(this.io.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && missing !== undefined) return missing; throw error; }
  }
  writeJson(file, data) {
    this.io.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${crypto.randomUUID()}`;
    try {
      this.io.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
      this.io.renameSync(temp, file);
    } catch (error) { try { this.io.rmSync(temp, { force: true }); } catch (_) {} throw error; }
  }
  readState() {
    const value = this.readJson(this.stateFile, { schemaVersion: 1, records: {}, lastRunAt: null });
    if (!object(value) || value.schemaVersion !== 1 || !object(value.records)
        || Object.values(value.records).some(record => !object(record))) {
      throw failure('MAINTENANCE_STATE_INVALID', '技能维护记录无法确认，已暂停自动归档');
    }
    return value;
  }
  lifecycle() {
    const usage = this.readJson(path.join(this.skillsDir, '.usage.json'), {});
    if (!object(usage) || Object.values(usage).some(record => !object(record))) {
      throw failure('USAGE_STATE_INVALID', '技能状态记录无法确认，已暂停自动归档');
    }
    return usage;
  }
  activity(name) { return { ...(this.readState().records[safeName(name)]?.activity || {}) }; }
  recordActivity(name, type, options = {}) {
    safeName(name);
    const field = { viewed: 'lastViewedAt', edited: 'lastEditedAt', patched: 'lastPatchedAt', restored: 'restoredAt' }[type];
    if (!field) throw failure('INVALID_ACTIVITY', 'Unknown skill activity');
    const state = this.readState(), record = state.records[name] || {};
    record.activity = { ...record.activity, [field]: new Date(this.now()).toISOString() };
    if (options.updateOwnedHash === true && record.ownership) {
      record.ownership.treeHash = this.scan(path.join(this.skillsDir, name)).treeHash;
    }
    state.records[name] = record; this.writeJson(this.stateFile, state);
    return record.activity;
  }
  forget(name) {
    safeName(name);
    const state = this.readState();
    if (Object.hasOwn(state.records, name)) { delete state.records[name]; this.writeJson(this.stateFile, state); }
  }
  recordPublished(result) {
    const { draft, history } = result || {};
    if (!draft || !draft.skillName || !history) return false;
    const name = safeName(draft.skillName), state = this.readState(), record = state.records[name] || {};
    const manifest = this.scan(path.join(this.skillsDir, name));
    if (!draft.published || manifest.treeHash !== draft.published.treeHash) return false;
    const createdHere = draft.operation === 'create' && draft.base?.exists === false
      && history.snapshot?.exists === false && PUBLICATION_SOURCES.has(draft.sourceRef?.type);
    const continuedHere = record.ownership?.origin === 'new-relay-publication'
      && history.snapshot?.treeHash === record.ownership.treeHash;
    if (createdHere || continuedHere) {
      record.ownership = { owner: 'relay', managed: true, origin: 'new-relay-publication',
        draftId: draft.id, publishedAt: draft.published.at, treeHash: manifest.treeHash };
    } else delete record.ownership;
    record.activity = { ...record.activity, lastPatchedAt: new Date(this.now()).toISOString() };
    state.records[name] = record; this.writeJson(this.stateFile, state);
    return !!record.ownership;
  }
  ownership(name, state = this.readState()) {
    const own = state.records[safeName(name)]?.ownership;
    if (!own || own.origin !== 'new-relay-publication' || own.owner !== 'relay' || own.managed !== true
        || !/^[a-f0-9]{64}$/.test(own.treeHash || '')) return null;
    try {
      const manifest = this.scan(path.join(this.skillsDir, name));
      if (manifest.treeHash !== own.treeHash) return null;
      return { owner: 'relay', managed: true, verified: true };
    } catch (_) { return null; }
  }
  listSkills() {
    return this.io.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter(entry => this.io.existsSync(path.join(this.skillsDir, entry.name, 'SKILL.md')))
      .map(entry => {
        let callName = entry.name;
        try { callName = parseSkillFrontmatter(this.io.readFileSync(path.join(this.skillsDir, entry.name, 'SKILL.md'), 'utf8')).fields.name || callName; } catch (_) {}
        return { name: entry.name, callName };
      });
  }
  references(skills) {
    const store = this.readJson(this.schedulesFile, { tasks: [] });
    if (!object(store) || !Array.isArray(store.tasks) || store.tasks.some(task => !object(task)
        || typeof task.id !== 'string' || !object(task.action) || !object(task.schedule))) {
      throw failure('TASK_REFERENCES_UNKNOWN', '定时任务引用无法确认，已暂停自动归档');
    }
    const references = new Set();
    const texts = store.tasks.map(task => JSON.stringify(task)); // Include disabled and paused jobs.
    for (const entry of this.io.readdirSync(this.draftsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const draft = this.readJson(path.join(this.draftsDir, entry.name, 'record.json'));
      if (!object(draft) || typeof draft.status !== 'string' || typeof draft.skillName !== 'string') {
        throw failure('DRAFT_REFERENCES_UNKNOWN', '待确认改进记录无法确认，已暂停自动归档');
      }
      if (draft.status !== 'draft') continue;
      references.add(draft.skillName);
      texts.push(JSON.stringify(draft));
      // Curator candidates may absorb siblings without a persisted source map.
      // Until reviewed, retain every possible source instead of guessing.
      if (draft.sourceRef?.type === 'skill-curator') skills.forEach(skill => references.add(skill.name));
      const proposed = path.join(this.draftsDir, entry.name, 'proposed');
      const manifest = this.scan(proposed);
      for (const file of manifest.files) {
        if (/\.(?:md|txt|ya?ml|json)$/i.test(file.path)) texts.push(this.io.readFileSync(path.join(proposed, file.path), 'utf8'));
      }
    }
    for (const skill of skills) for (const name of [skill.name, skill.callName]) {
      if (typeof name !== 'string' || !name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'iu');
      if (texts.some(text => pattern.test(text))) references.add(name);
    }
    return references;
  }
  archive(name, { automatic = false, expectedManifest = null } = {}) {
    safeName(name);
    const state = this.readState(), source = path.join(this.skillsDir, name);
    const archiveRoot = path.join(this.skillsDir, '.archive'), destination = path.join(archiveRoot, name);
    if (this.io.existsSync(destination)) throw failure('ARCHIVE_EXISTS', '归档中已有同名技能，请先处理已有归档；本次未覆盖');
    if (this.io.existsSync(archiveRoot) && this.io.lstatSync(archiveRoot).isSymbolicLink()) throw failure('UNSAFE_ARCHIVE_ROOT', '归档目录不能是符号链接');
    const before = this.scan(source);
    if (expectedManifest && !sameManifest(before, expectedManifest)) throw failure('SKILL_CHANGED', '技能已变化，本次归档取消');
    if (automatic) {
      if (!this.ownership(name, state) || this.lifecycle()[name]?.pinned) throw failure('PROTECTED_SKILL', '该技能不允许自动归档');
      const skills = this.listSkills(), refs = this.references(skills), skill = skills.find(item => item.name === name);
      if (!skill || refs.has(name) || refs.has(skill.callName)) throw failure('PROTECTED_SKILL', '任务或待确认改进仍在引用该技能');
    }
    const id = `archive-${this.now()}-${crypto.randomUUID()}`;
    const backup = path.join(this.stateDir, 'backups', id);
    const temp = `${backup}.pending`;
    this.io.mkdirSync(temp, { recursive: true });
    try {
      this.io.cpSync(source, path.join(temp, 'package'), { recursive: true, force: false, errorOnExist: true });
      if (!sameManifest(before, this.scan(path.join(temp, 'package'))) || !sameManifest(before, this.scan(source))) {
        throw failure('BACKUP_VERIFICATION_FAILED', '完整技能备份校验失败，本次未归档');
      }
      this.writeJson(path.join(temp, 'manifest.json'), { schemaVersion: 1, name, automatic, capturedAt: new Date(this.now()).toISOString(), manifest: before });
      this.io.renameSync(temp, backup);
    } catch (error) { try { this.io.rmSync(temp, { recursive: true, force: true }); } catch (_) {} throw error; }
    this.io.mkdirSync(archiveRoot, { recursive: true });
    if (this.io.lstatSync(archiveRoot).isSymbolicLink() || this.io.existsSync(destination)) throw failure('ARCHIVE_EXISTS', '归档目标已变化，本次未覆盖');
    if (!sameManifest(before, this.scan(source))) throw failure('SKILL_CHANGED', '备份后技能已变化，本次归档取消');
    state.lastPreparedArchive = { name, backupId: id, at: new Date(this.now()).toISOString() };
    this.writeJson(this.stateFile, state); // Storage failure must happen before moving the live package.
    let moved = false;
    try {
      this.io.renameSync(source, destination); moved = true; // Same root; no destructive copy/remove fallback.
      if (!sameManifest(before, this.scan(destination))) throw failure('ARCHIVE_VERIFICATION_FAILED', '归档校验失败');
      const record = state.records[name] || {};
      record.archivedAt = new Date(this.now()).toISOString(); record.backupId = id;
      state.records[name] = record; delete state.lastPreparedArchive;
      this.writeJson(this.stateFile, state);
      return { name, archivedAt: record.archivedAt, backupId: id, treeHash: before.treeHash };
    } catch (error) {
      if (moved && !this.io.existsSync(source) && this.io.existsSync(destination)) {
        try { this.io.renameSync(destination, source); } catch (rollbackError) { error.recovery = { backup, destination, message: rollbackError.message }; }
      }
      throw error;
    }
  }
  restore(name) {
    safeName(name);
    const archiveRoot = path.join(this.skillsDir, '.archive');
    if (this.io.lstatSync(archiveRoot).isSymbolicLink()) throw failure('UNSAFE_ARCHIVE_ROOT', '归档目录不能是符号链接');
    const source = path.join(archiveRoot, name), destination = path.join(this.skillsDir, name);
    if (this.io.existsSync(destination)) throw failure('RESTORE_EXISTS', '已存在同名技能，恢复取消（避免覆盖）');
    const before = this.scan(source), state = this.readState(), record = state.records[name] || {};
    this.io.renameSync(source, destination);
    try {
      if (!sameManifest(before, this.scan(destination))) throw failure('RESTORE_VERIFICATION_FAILED', '恢复校验失败');
      record.activity = { ...record.activity, restoredAt: new Date(this.now()).toISOString() };
      record.archivedAt = null; state.records[name] = record; this.writeJson(this.stateFile, state);
      return { name, restoredAt: record.activity.restoredAt };
    } catch (error) {
      if (!this.io.existsSync(source)) { try { this.io.renameSync(destination, source); } catch (_) {} }
      throw error;
    }
  }
  run({ policy: settings, usage = new Map(), usageReady = false, busy, lastActivityAt } = {}) {
    if (this.running) return { ran: false, reason: 'running', archived: [] };
    this.running = true;
    const archived = [];
    try {
      const now = this.now(), policy = normalizeMaintenancePolicy(settings), state = this.readState();
      const due = evaluateMaintenanceRun({ now, lastRunAt: state.lastRunAt, busy, lastActivityAt, policy });
      if (due.seedLastRunAt) { state.lastRunAt = due.seedLastRunAt; this.writeJson(this.stateFile, state); }
      if (!due.run) return { ran: false, reason: due.reason, archived: [] };
      if (!usageReady || !(usage instanceof Map)) return { ran: false, reason: 'usage-unavailable', archived: [] };
      const skills = this.listSkills(), refs = this.references(skills), lifecycle = this.lifecycle(), decisions = [];
      for (const skill of skills) {
        const record = { ...lifecycle[skill.name], ...state.records[skill.name]?.activity };
        const decision = evaluateSkillMaintenance({ skill, record, usage: usage.get(skill.callName) || usage.get(skill.name) || {},
          usageReady, now, policy, ownership: this.ownership(skill.name, state), referencedSkills: refs, referencesReady: true });
        decisions.push({ name: skill.name, ...decision });
        if (decision.autoArchiveEligible) archived.push(this.archive(skill.name, { automatic: true, expectedManifest: this.scan(path.join(this.skillsDir, skill.name)) }));
      }
      const latest = this.readState(); latest.lastRunAt = new Date(now).toISOString();
      latest.lastReport = { at: latest.lastRunAt, checked: decisions.length, archived: archived.map(item => item.name) };
      this.writeJson(this.stateFile, latest);
      return { ran: true, reason: 'completed', archived, decisions };
    } catch (error) { error.archived = archived; throw error; }
    finally { this.running = false; }
  }
}

module.exports = { SkillMaintenanceHost };
