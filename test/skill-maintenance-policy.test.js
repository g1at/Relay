'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMaintenancePolicy, evaluateSkillMaintenance,
  evaluateMaintenanceRun, findExactDuplicateGroups,
} = require('../src/main/skills/skill-maintenance-policy');
const DAY = 86400000;
const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const at = days => new Date(NOW - days * DAY).toISOString();
const ownership = { owner: 'relay', managed: true, verified: true };
const base = () => ({
  now: NOW, skill: { name: 'release-workflow', callName: 'release' },
  record: { state: 'active', firstSeenAt: at(100) },
  ownership, usage: {}, usageReady: true,
  referencedSkills: new Set(), referencesReady: true,
  policy: { autoArchive: true },
});

test('defaults preserve manual archival and opt-in consolidation; old settings win', () => {
  const policy = normalizeMaintenancePolicy();
  assert.equal(policy.staleDays, 30); assert.equal(policy.archiveDays, 90);
  assert.equal(policy.intervalHours, 168); assert.equal(policy.idleHours, 2);
  assert.equal(policy.autoArchive, false); assert.equal(policy.consolidate, false);
  assert.equal(normalizeMaintenancePolicy({ skillStaleDays: 120 }).archiveDays, 120);
  assert.equal(normalizeMaintenancePolicy({ skillStaleDays: '30oops' }).staleDays, 30);
  assert.equal(normalizeMaintenancePolicy({ skillStaleDays: 14, staleDays: 60 }).staleDays, 14);
  assert.equal(normalizeMaintenancePolicy({ skillAutoReview: false }).autoArchive, false);
  assert.equal(normalizeMaintenancePolicy({ skillAutoArchive: 'false' }).autoArchive, false);
});

test('boundaries mark stale at 30 days and permit archive at 90 without claiming a move', () => {
  const evaluate = days => evaluateSkillMaintenance({ ...base(), record: { firstSeenAt: at(days) } });
  assert.equal(evaluate(29.99).state, 'active');
  assert.equal(evaluate(30).state, 'stale');
  assert.equal(evaluate(89.99).archiveCandidate, false);
  const old = evaluate(90);
  assert.equal(old.state, 'stale'); assert.equal(old.archiveCandidate, true); assert.equal(old.autoArchiveEligible, true);
  assert.equal(evaluateSkillMaintenance({ ...base(), policy: {} }).autoArchiveEligible, false);
});

test('legacy agent marker and presentation metadata cannot confer Relay ownership', () => {
  for (const owner of [undefined, { owner: 'relay', managed: true }, { ...ownership, owner: 'cli' }, { ...ownership, managed: false }]) {
    const result = evaluateSkillMaintenance({ ...base(), ownership: owner,
      record: { firstSeenAt: at(200), createdBy: 'agent', relayMetadata: true } });
    assert.equal(result.protected, true); assert.equal(result.autoArchiveEligible, false);
    assert.equal(result.state, 'active');
  }
});

test('pins and paused task references protect both directory and call names', () => {
  for (const input of [
    { record: { firstSeenAt: at(200), pinned: true } },
    { referencedSkills: new Set(['release-workflow']) },
    { referencedSkills: ['release'] },
  ]) {
    const result = evaluateSkillMaintenance({ ...base(), ...input });
    assert.equal(result.protected, true); assert.equal(result.archiveCandidate, false);
  }
});

test('external, project, bundled, imported and symlink packages are protected even with an ownership claim', () => {
  for (const flag of ['external', 'shared', 'bundled', 'installed', 'project', 'symlink']) {
    const result = evaluateSkillMaintenance({ ...base(), skill: { name: 'release-workflow', [flag]: true } });
    assert.equal(result.protected, true); assert.equal(result.autoArchiveEligible, false);
  }
});

test('incomplete telemetry and unavailable task store never turn zero observations into archive', () => {
  for (const input of [{ usageReady: false }, { referencesReady: false }, { referencedSkills: undefined }]) {
    const result = evaluateSkillMaintenance({ ...base(), ...input });
    assert.equal(result.archiveCandidate, false); assert.equal(result.state, 'active');
  }
});

test('first observation establishes grace; actual use, view, patch, import and restore reset idle', () => {
  const fresh = evaluateSkillMaintenance({ ...base(), record: {} });
  assert.deepEqual(fresh.seedRecord, { firstSeenAt: new Date(NOW).toISOString() });
  assert.equal(fresh.archiveCandidate, false);
  for (const recent of [
    { usage: { lastUsedAt: at(1) } }, { usage: { lastViewedAt: at(1) } },
    { record: { state: 'stale', firstSeenAt: at(100), lastPatchedAt: at(1) } },
    { record: { firstSeenAt: at(1) }, usage: { lastUsedAt: at(300) } },
    { record: { state: 'active', firstSeenAt: at(100), restoredAt: at(1) } },
  ]) assert.equal(evaluateSkillMaintenance({ ...base(), ...recent }).state, 'active');
  assert.equal(evaluateSkillMaintenance({ ...base(), record: { state: 'archived', firstSeenAt: at(100) }, usage: { lastUsedAt: at(1) } }).state, 'archived');
});

test('invalid and future evidence cannot silently fall back to an old idle anchor', () => {
  for (const lastUsedAt of ['yesterday', '2026-09-11', at(-1)]) {
    const result = evaluateSkillMaintenance({ ...base(), usage: { lastUsedAt } });
    assert.equal(result.archiveCandidate, false); assert.equal(result.autoArchiveEligible, false);
  }
  assert.equal(evaluateSkillMaintenance({ ...base(), policy: { paused: true } }).archiveCandidate, false);
});

test('idle scheduler seeds first run and requires known quiet state and both time gates', () => {
  const input = { now: NOW, lastRunAt: at(8), lastActivityAt: at(1), busy: false };
  assert.equal(evaluateMaintenanceRun(input).run, true);
  assert.equal(evaluateMaintenanceRun({ ...input, lastRunAt: null }).seedLastRunAt, new Date(NOW).toISOString());
  for (const change of [
    { lastRunAt: at(1) }, { lastRunAt: at(-1) }, { busy: true }, { busy: undefined },
    { lastActivityAt: undefined }, { lastActivityAt: at(-1) }, { lastActivityAt: at(1 / 24) },
    { policy: { enabled: false } }, { policy: { paused: true } },
  ]) assert.equal(evaluateMaintenanceRun({ ...input, ...change }).run, false);
  assert.equal(evaluateMaintenanceRun({ ...input, lastRunAt: at(7), lastActivityAt: at(2 / 24) }).run, true);
});

test('dedup requires complete identical packages and protected names never become merge targets', () => {
  const make = name => ({ name, ownership, packageVerified: true, treeHash: 'a'.repeat(64) });
  const options = { referencedSkills: new Set(['cron-owned']), referencesReady: true };
  const rows = [make('beta'), make('alpha'), make('alpha'), make('cron-owned'),
    { ...make('pinned'), pinned: true }, { ...make('legacy'), ownership: undefined },
    { ...make('partial'), packageVerified: false }, { ...make('different'), treeHash: 'b'.repeat(64) }];
  const groups = findExactDuplicateGroups(rows, options);
  assert.deepEqual(groups, [{ treeHash: 'a'.repeat(64), names: ['alpha', 'beta'], action: 'review', automatic: false }]);
  assert.deepEqual(findExactDuplicateGroups(rows), []);
});
