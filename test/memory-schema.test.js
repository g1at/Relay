'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { memoryEligibility, normalizeMemoryMeta, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

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
