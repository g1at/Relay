'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('function skillDraftUiState(draft) {');
const end = source.indexOf('async function openSkillDraftRebase(', start);
assert.ok(start > 0 && end > start);
const context = {}; vm.createContext(context); vm.runInContext(source.slice(start, end), context);
const view = value => JSON.parse(JSON.stringify(value));
const draft = (id, changes = {}) => ({ id, skillName: 'sample', status: 'draft', validation: { ok: true }, readiness: 'ready', canPublish: true, createdAt: '2026-09-08T10:00:00Z', proposed: { treeHash: id }, ...changes });

test('all stale or structurally invalid candidates are visibly blocked before publish', () => {
  for (const changes of [{ readiness: 'stale' }, { baseMatches: false }, { readiness: 'invalid' }, { validation: { ok: false } }]) {
    assert.equal(context.skillDraftUiState(draft('x', changes)).canPublish, false);
  }
  assert.equal(context.skillDraftUiState(draft('x', { readiness: 'already_applied', validation: { ok: false } })).key, 'invalid');
  assert.equal(context.skillDraftUiState(draft('x', { readiness: 'invalid', baseMatches: false })).canRebase, true);
});
test('published, rejected, superseded, merged and already applied records leave the pending count', () => {
  const input = ['published', 'rejected', 'superseded', 'merged'].map(status => draft(status, { status }));
  input.push(draft('already', { readiness: 'already_applied' }), draft('pending'));
  const grouped = view(context.groupSkillDraftUpdates(input));
  assert.equal(grouped.groups.length, 1); assert.equal(grouped.groups[0].records.length, 1);
  assert.equal(grouped.processed.length, 5);
});
test('same-content legacy drafts share a candidate while all IDs and sources remain reviewable', () => {
  const input = [draft('older-ready', { sourceCount: 3, proposed: { treeHash: 'same' } }), draft('newer-stale', { readiness: 'stale', canPublish: false, createdAt: '2026-09-09T10:00:00Z', proposed: { treeHash: 'same' } }), draft('other')];
  const original = JSON.stringify(input), grouped = view(context.groupSkillDraftUpdates(input));
  const group = grouped.groups[0], same = group.candidates.find(candidate => candidate.duplicates.length);
  assert.equal(group.candidates.length, 2); assert.equal(group.records.length, 3);
  assert.equal(same.draft.id, 'older-ready'); assert.equal(same.duplicates[0].id, 'newer-stale'); assert.equal(same.sourceCount, 4);
  assert.equal(JSON.stringify(input), original);
});
test('identical hashes belonging to different skills never coalesce', () => {
  const grouped = view(context.groupSkillDraftUpdates([draft('a', { skillName: 'one', proposed: { treeHash: 'same' } }), draft('b', { skillName: 'two', proposed: { treeHash: 'same' } })]));
  assert.equal(grouped.groups.length, 2); assert.deepEqual(grouped.groups.map(group => group.candidates.length), [1, 1]);
});
test('legacy records without content hashes stay separate rather than disappearing into one bucket', () => {
  const grouped = view(context.groupSkillDraftUpdates([null, draft('one', { proposed: null }), draft('two', { proposed: null })]));
  assert.equal(grouped.groups[0].candidates.length, 2);
});
