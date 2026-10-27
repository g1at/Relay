'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MEMORY_TYPES, memoryEligibility, normalizeMemoryMeta, parseMemoryDocument, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

test('旧记忆默认迁移成全局、已确认、活动状态', () => {
  const meta = normalizeMemoryMeta({ name: 'tone', description: '简洁', type: 'feedback' });
  assert.equal(meta.scope, 'global');
  assert.equal(meta.status, 'active');
  assert.equal(meta.confidence, 'user_confirmed');
});

test('草稿、过期、跨项目和已停用作用域记忆不会注入', () => {
  assert.equal(memoryEligibility({ status: 'draft' }).eligible, false);
  assert.equal(memoryEligibility({ expires_at: '2020-01-01T00:00:00Z' }, { now: '2026-01-01T00:00:00Z' }).eligible, false);
  assert.equal(memoryEligibility({ scope: 'project', project_id: 'a' }, { projectId: 'b' }).eligible, false);
  assert.equal(memoryEligibility({ scope: 'project', project_id: 'a' }, { projectId: 'a' }).eligible, true);
  const normalized = normalizeMemoryMeta({
    scope: 'workflow', workflow_id: 'wf-1', source_ref: 'task:1', expires_at: '2030-01-01T00:00:00Z',
  });
  assert.equal(normalized.scope, 'retired');
  assert.equal(memoryEligibility(normalized, { now: '2026-01-01T00:00:00Z' }).eligible, false);
  assert.equal(normalized.sourceRef, 'task:1');
});

test('新字段可稳定序列化供编辑器创建候选记忆', () => {
  const output = serializeMemoryFrontmatter({
    name: 'relay-style', description: '简洁:直接', type: 'feedback', status: 'draft', confidence: 'inferred', source_ref: 'conv:1',
  });
  assert.match(output, /status: draft/);
  assert.match(output, /confidence: inferred/);
  assert.match(output, /description: "简洁:直接"/);
});

test('missing types remain unclassified and readable without manufacturing reference metadata', () => {
  for (const content of ['Legacy body.', '---\nname: feedback-example\n---\nLegacy body.', '---\ntype: null\n---\nLegacy body.']) {
    const parsed = parseMemoryDocument(content);
    assert.equal(parsed.meta.type, null);
    assert.deepEqual(parsed.errors, []);
    assert.equal(memoryEligibility(parsed.meta).eligible, true);
    assert.doesNotMatch(serializeMemoryFrontmatter(parsed.meta), /^type:/m);
  }
});

test('only the four defined types are valid and their scope remains independent', () => {
  for (const type of MEMORY_TYPES) {
    const parsed = parseMemoryDocument(`---\ntype: ${type}\n---\nSynthetic fact.`);
    assert.equal(parsed.meta.type, type);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.meta.scope, 'global');
  }
  for (const value of ['other', 'USER', 'true', '123', '[user]', '{name: user}']) {
    const parsed = parseMemoryDocument(`---\ntype: ${value}\n---\nSynthetic fact.`);
    assert.deepEqual(parsed.errors, ['invalid_type'], value);
    assert.equal(memoryEligibility(parsed.meta).eligible, false, value);
  }
});

test('legacy nested type remains readable while explicit top-level metadata takes precedence', () => {
  const nested = parseMemoryDocument('---\nmetadata:\n  type: feedback\n---\nAlways verify before editing.');
  assert.equal(nested.meta.type, 'feedback');
  assert.deepEqual(nested.errors, []);
  assert.equal(memoryEligibility(nested.meta).eligible, true);
  assert.match(serializeMemoryFrontmatter(nested.meta), /^type: feedback$/m);
  assert.doesNotMatch(serializeMemoryFrontmatter(nested.meta), /metadata:/);
  const top = parseMemoryDocument('---\ntype: project\nmetadata:\n  type: reference\n---\nProject relationship.');
  assert.equal(top.meta.type, 'project');
  assert.deepEqual(top.errors, []);
  for (const content of [
    '---\ntype: unsupported\nmetadata:\n  type: feedback\n---\nFact.',
    '---\nmetadata:\n  type: unsupported\n---\nFact.',
    '---\nmetadata:\n  type: [feedback]\n---\nFact.',
  ]) {
    const parsed = parseMemoryDocument(content);
    assert.deepEqual(parsed.errors, ['invalid_type']);
    assert.equal(memoryEligibility(parsed.meta).eligible, false);
  }
});

test('bounded structured provenance round-trips quoted evidence and multiple replacement revisions', () => {
  const hash = 'a'.repeat(64);
  const sources = [
    { kind: 'conversation', conversationId: 'conv-1', turnId: 'turn:1', turnIndex: 3, role: 'user',
      quote: 'Use "safe": text\n---\n# literal evidence', at: '2026-10-21T01:00:00Z', revision: hash, title: 'A: "title"' },
    { kind: 'memory', file: 'old.md', revision: hash },
  ];
  const replaces = [{ file: 'old.md', revision: hash }, { file: 'another.md', revision: 'b'.repeat(64) }];
  const parsed = parseMemoryDocument(`${serializeMemoryFrontmatter({ sources, replaces })}\nBody`);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.meta.sources, sources);
  assert.deepEqual(parsed.meta.replaces, replaces);
  assert.equal(parsed.body, 'Body');
  assert.deepEqual(normalizeMemoryMeta(parsed.meta).sources, sources);
});

test('malformed provenance cannot turn into eligible evidence or unbounded metadata', () => {
  const hash = 'a'.repeat(64);
  const source = { kind: 'conversation', conversationId: 'conv-1', turnIndex: 0, role: 'assistant',
    quote: 'A fact.', at: '2026-10-21T01:00:00Z', revision: hash };
  for (const sources of [null, []]) assert.deepEqual(normalizeMemoryMeta({ sources }).schemaErrors, []);
  for (const sources of [
    {}, Array(33).fill(source), [{ ...source, role: 'system' }], [{ ...source, revision: 'unknown' }],
    [{ ...source, quote: 'x'.repeat(2001) }], [{ ...source, turnIndex: -1 }], [{ ...source, at: 'bad-date' }],
    [{ ...source, forged: true }], [{ ...source, conversationId: 'line\nbreak' }],
    [{ kind: 'memory', file: '../other.md', revision: hash }],
  ]) {
    const normalized = normalizeMemoryMeta({ sources });
    assert.ok(normalized.schemaErrors.includes('invalid_sources'));
    assert.equal(memoryEligibility(normalized).eligible, false);
  }
  for (const replaces of [
    {}, Array(17).fill({ file: 'old.md', revision: hash }), [{ file: 'memory.md', revision: hash }],
    [{ file: 'old.md', revision: hash }, { file: 'OLD.md', revision: 'b'.repeat(64) }],
  ]) assert.ok(normalizeMemoryMeta({ replaces }).schemaErrors.includes('invalid_replaces'));
});
