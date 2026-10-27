'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { memoryHealth, memoryHealthSummary } = require('../src/main/memory/memory-health');
const { parseMemoryDocument, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

function entry(fields = {}) {
  const content = `${serializeMemoryFrontmatter({ type: 'reference', ...fields })}\nSynthetic memory body.`;
  return { content, meta: parseMemoryDocument(content).meta };
}

test('health exposes malformed YAML and missing project identifiers as invalid', () => {
  const malformed = memoryHealth({ content: '---\nname: overview\ndescription: "overview" means a summary\nscope: project\n---\nSynthetic body.' });
  assert.equal(malformed.state, 'invalid');
  assert.equal(malformed.issues[0].code, 'invalid_frontmatter');
  assert.equal(malformed.legacy, false, 'a parser failure is not a legacy format');
  const missingProject = memoryHealth(entry({ scope: 'project' }));
  assert.equal(missingProject.state, 'invalid');
  assert.equal(missingProject.issues[0].code, 'missing_project_id');
  assert.match(missingProject.reason, /项目 ID/);
});

test('project catalog validation distinguishes unknown projects from scope in a selected chat', () => {
  const project = entry({ scope: 'project', projectId: 'known' });
  const knownProjectIds = new Set(['known']);
  assert.equal(memoryHealth(project, { knownProjectIds }).state, 'active');
  const differentChat = memoryHealth(project, { knownProjectIds, context: { projectId: 'other' } });
  assert.equal(differentChat.state, 'inactive');
  assert.equal(differentChat.issues[0].code, 'project_scope');
  const orphan = memoryHealth(entry({ scope: 'project', projectId: 'removed' }), { knownProjectIds });
  assert.equal(orphan.state, 'invalid');
  assert.equal(orphan.issues[0].code, 'unknown_project');
  assert.equal(memoryHealth(project).state, 'active', 'no project catalog does not imply an empty catalog');
});

test('draft, unconfirmed, expired, superseded and retired entries expose specific reasons', () => {
  const now = '2026-10-21T00:00:00Z';
  for (const [fields, state, issue] of [
    [{ status: 'draft' }, 'draft', 'draft'],
    [{ status: 'active', confidence: 'inferred' }, 'draft', 'inferred'],
    [{ status: 'expired' }, 'inactive', 'expired'],
    [{ expiresAt: '2026-10-20T00:00:00Z' }, 'inactive', 'expired'],
    [{ status: 'superseded' }, 'inactive', 'superseded'],
    [{ scope: 'session' }, 'inactive', 'retired_scope'],
  ]) {
    const result = memoryHealth(entry(fields), { now });
    assert.equal(result.state, state, JSON.stringify(fields));
    assert.equal(result.issues[0].code, issue, JSON.stringify(fields));
    assert.ok(result.reason);
  }
  assert.equal(memoryHealth(entry({ expiresAt: '2026-10-22T00:00:00Z' }), { now }).state, 'active');
  const archived = memoryHealth(entry(), { archived: true });
  assert.equal(archived.state, 'inactive');
  assert.equal(archived.label, '已归档');
});

test('legacy defaults remain compatible without implying that the user approved them', () => {
  const content = '---\nname: legacy\ntype: feedback\n---\nSynthetic old-format body.\n';
  const legacy = { content };
  const result = memoryHealth(legacy);
  assert.equal(result.state, 'active');
  assert.equal(result.legacy, true);
  assert.equal(result.issues[0].code, 'legacy_fields');
  assert.match(result.issues[0].message, /不代表用户已逐条审核/);
  assert.deepEqual(legacy, { content }, 'health only reads the entry');
  assert.equal(memoryHealth({ meta: parseMemoryDocument(content).meta, legacyFields: ['scope', 'status', 'confidence'] }).legacy, true);
  assert.equal(memoryHealth({ meta: parseMemoryDocument(content).meta }).legacy, false, 'absence of source metadata is not evidence of a legacy file');
  assert.equal(memoryHealth(entry()).legacy, false);
});

test('unclassified legacy memories produce a nonblocking issue without being mislabeled reference', () => {
  const content = '---\nscope: global\nstatus: active\nconfidence: user_confirmed\n---\nSynthetic fact.';
  const result = memoryHealth({ content });
  assert.equal(result.state, 'active');
  assert.equal(result.reason, null);
  assert.deepEqual(result.issues.map(issue => issue.code), ['missing_type']);
  const nested = memoryHealth({ content: '---\nmetadata:\n  type: feedback\n---\nSynthetic fact.' });
  assert.equal(nested.state, 'active');
  assert.equal(nested.issues.some(issue => issue.code === 'missing_type'), false);
  const invalid = memoryHealth({ content: '---\ntype: unsupported\n---\nSynthetic fact.' });
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.issues[0].code, 'invalid_type');
  assert.equal(invalid.issues.some(issue => issue.code === 'missing_type'), false);
});

test('health summary separates invalid and inactive data from active and pending entries', () => {
  const summary = memoryHealthSummary([
    { health: memoryHealth(entry()) },
    { health: memoryHealth({ content: 'legacy' }) },
    { health: memoryHealth(entry({ status: 'draft' })) },
    { health: memoryHealth(entry({ status: 'superseded' })) },
    { health: memoryHealth(entry({ scope: 'project' })) },
  ]);
  assert.deepEqual(summary, { total: 5, active: 2, draft: 1, inactive: 1, invalid: 1, legacy: 1 });
});
