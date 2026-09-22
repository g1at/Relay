'use strict';

// Pure decisions only. The host supplies verified ownership, complete usage and
// task references; this module never infers ownership from SKILL.md or a path.
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STATES = new Set(['active', 'stale', 'archived']);

function numberSetting(value, fallback, min, max) {
  if (value === null || value === '' || typeof value === 'boolean') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeMaintenancePolicy(settings = {}) {
  const staleDays = numberSetting(settings.skillStaleDays ?? settings.staleDays, 30, 1, 3650);
  const archiveDays = Math.max(staleDays, numberSetting(settings.skillArchiveDays ?? settings.archiveDays, 90, 1, 3650));
  return {
    enabled: (settings.skillMaintenanceEnabled ?? settings.enabled) !== false,
    paused: (settings.skillMaintenancePaused ?? settings.paused) === true,
    staleDays,
    archiveDays,
    intervalHours: numberSetting(settings.skillMaintenanceIntervalHours ?? settings.intervalHours, 168, 1, 87600),
    idleHours: numberSetting(settings.skillMaintenanceIdleHours ?? settings.idleHours, 2, 0, 87600),
    // Existing installations retain manual archival and their review switches.
    autoArchive: (settings.skillAutoArchive ?? settings.autoArchive) === true,
    consolidate: (settings.skillConsolidate ?? settings.consolidate) === true,
  };
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  // Reject locale-dependent dates rather than making archival depend on locale.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function ownershipReasons(ownership) {
  if (!ownership || ownership.verified !== true) return ['ownership-unverified'];
  if (ownership.owner !== 'relay' || ownership.managed !== true) return ['not-relay-managed'];
  if (ownership.external === true || ownership.shared === true || ownership.bundled === true
      || ownership.installed === true || ownership.project === true) return ['external-owner'];
  return [];
}

function protectedReasons({ skill = {}, record = {}, ownership, referencedSkills, referencesReady }) {
  const reasons = ownershipReasons(ownership);
  if (record.pinned === true || skill.pinned === true) reasons.push('pinned');
  if (skill.external === true || skill.shared === true || skill.bundled === true
      || skill.installed === true || skill.project === true || skill.symlink === true) reasons.push('external-owner');
  if (referencesReady !== true || !(referencedSkills instanceof Set || Array.isArray(referencedSkills))) {
    reasons.push('references-unavailable');
  } else {
    const names = referencedSkills instanceof Set ? referencedSkills : new Set(referencedSkills);
    if ([skill.name, skill.callName].some(name => name && names.has(name))) reasons.push('task-reference');
  }
  return [...new Set(reasons)];
}

function evaluateSkillMaintenance(input = {}) {
  const skill = input.skill || {};
  const record = input.record || {};
  const usage = input.usage || {};
  const policy = normalizeMaintenancePolicy(input.policy);
  const now = timestamp(input.now ?? Date.now());
  const reasons = protectedReasons({ ...input, skill, record });
  const result = {
    state: STATES.has(record.state) ? record.state : 'active',
    idleDays: null,
    anchorAt: null,
    protected: reasons.length > 0,
    reasons,
    archiveCandidate: false,
    autoArchiveEligible: false,
    seedRecord: null,
  };
  if (now === null) { reasons.push('invalid-now'); return result; }

  const fields = ['lastUsedAt', 'lastViewedAt', 'lastPatchedAt', 'lastEditedAt', 'lastActivityAt', 'restoredAt'];
  const supplied = fields.flatMap(key => [usage[key], record[key]])
    .concat([record.firstSeenAt, record.createdAt])
    .filter(value => value !== null && value !== undefined && value !== '');
  const stamps = supplied.map(timestamp);
  if (stamps.some(value => value === null)) { reasons.push('invalid-activity'); return result; }
  if (!stamps.length) {
    reasons.push('first-observation');
    result.seedRecord = { firstSeenAt: new Date(now).toISOString() };
    return result;
  }
  const anchor = Math.max(...stamps);
  result.anchorAt = new Date(anchor).toISOString();
  result.idleDays = Math.max(0, (now - anchor) / DAY_MS);
  if (anchor > now) { reasons.push('future-activity'); return result; }
  if (input.usageReady !== true) { reasons.push('usage-unavailable'); return result; }
  if (result.protected || result.state === 'archived') return result;
  if (!policy.enabled || policy.paused) { reasons.push(policy.paused ? 'paused' : 'disabled'); return result; }

  result.state = result.idleDays >= policy.staleDays ? 'stale' : 'active';
  result.archiveCandidate = result.idleDays >= policy.archiveDays;
  result.autoArchiveEligible = result.archiveCandidate && policy.autoArchive;
  // state remains stale until the host has backed up and moved the full package.
  return result;
}

function evaluateMaintenanceRun(input = {}) {
  const policy = normalizeMaintenancePolicy(input.policy);
  const result = { run: false, reason: '', seedLastRunAt: null };
  if (!policy.enabled || policy.paused) return { ...result, reason: policy.paused ? 'paused' : 'disabled' };
  const now = timestamp(input.now ?? Date.now());
  if (now === null) return { ...result, reason: 'invalid-now' };
  const last = timestamp(input.lastRunAt);
  if (last === null) return { ...result, reason: 'first-observation', seedLastRunAt: new Date(now).toISOString() };
  if (last > now) return { ...result, reason: 'future-run' };
  if (now - last < policy.intervalHours * HOUR_MS) return { ...result, reason: 'interval' };
  // The caller must explicitly establish that no foreground/scheduled/review job
  // is running. Missing busy or idle information cannot grant an unattended run.
  if (input.busy !== false) return { ...result, reason: 'busy-or-unknown' };
  const activity = timestamp(input.lastActivityAt);
  if (activity === null) return { ...result, reason: 'idle-unavailable' };
  if (activity > now) return { ...result, reason: 'future-activity' };
  if (now - activity < policy.idleHours * HOUR_MS) return { ...result, reason: 'not-idle' };
  return { ...result, run: true, reason: 'due' };
}

function findExactDuplicateGroups(skills = [], options = {}) {
  const groups = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || !skill.name || skill.state === 'archived' || skill.record?.state === 'archived') continue;
    const reasons = protectedReasons({
      skill, record: skill.record || {}, ownership: skill.ownership,
      referencedSkills: options.referencedSkills, referencesReady: options.referencesReady,
    });
    // Hashes must cover every file, including scripts/assets/relative paths.
    if (reasons.length || skill.packageVerified !== true || !/^[a-f0-9]{64}$/i.test(skill.treeHash || '')) continue;
    const key = skill.treeHash.toLowerCase();
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(skill.name);
  }
  return [...groups].filter(([, names]) => names.size > 1)
    .map(([treeHash, names]) => ({ treeHash, names: [...names].sort(), action: 'review', automatic: false }))
    .sort((a, b) => a.names[0].localeCompare(b.names[0]));
}

module.exports = {
  normalizeMaintenancePolicy,
  evaluateSkillMaintenance,
  evaluateMaintenanceRun,
  findExactDuplicateGroups,
};
