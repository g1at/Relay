'use strict';

const yaml = require('js-yaml');

const VALID_SCOPES = new Set(['global', 'project']);
const VALID_STATUS = new Set(['active', 'draft', 'superseded', 'expired']);
const VALID_CONFIDENCE = new Set(['user_confirmed', 'inferred']);

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function truthy(value) {
  return value === true || value === 1 || /^(true|yes|1|core|pinned)$/i.test(text(value, 20));
}

function normalizeMemoryMeta(frontmatter = {}) {
  const fm = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter) ? frontmatter : {};
  const errors = Array.isArray(fm.schemaErrors) ? [...fm.schemaErrors] : [];
  const rawScope = text(fm.scope, 40);
  const scope = rawScope ? (VALID_SCOPES.has(rawScope) ? rawScope : 'retired') : 'global';
  const rawStatus = text(fm.status, 40);
  const status = !rawStatus ? 'active' : (VALID_STATUS.has(rawStatus) ? rawStatus : 'draft');
  const rawConfidence = text(fm.confidence, 40);
  const confidence = !rawConfidence ? (status === 'draft' ? 'inferred' : 'user_confirmed')
    : (VALID_CONFIDENCE.has(rawConfidence) ? rawConfidence : 'inferred');
  const projectId = text(fm.project_id ?? fm.projectId, 128) || null;
  const expiresAt = text(fm.expires_at ?? fm.expiresAt, 80) || null;
  if (rawStatus && !VALID_STATUS.has(rawStatus)) errors.push('invalid_status');
  if (rawConfidence && !VALID_CONFIDENCE.has(rawConfidence)) errors.push('invalid_confidence');
  if (scope === 'project' && !projectId) errors.push('missing_project_id');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) errors.push('invalid_expiry');
  return {
    name: text(fm.name, 120),
    description: text(fm.description, 500),
    type: text(fm.type, 40) || 'reference',
    core: truthy(fm.core) || truthy(fm.pinned),
    scope,
    projectId,
    status,
    sourceRef: text(fm.source_ref ?? fm.sourceRef, 1000) || null,
    confidence,
    expiresAt,
    supersedes: text(fm.supersedes, 200) || null,
    supersedesRevision: text(fm.supersedes_revision ?? fm.supersedesRevision, 128) || null,
    schemaErrors: [...new Set(errors)],
  };
}

function memoryScopeEligibility(meta, context = {}) {
  const value = normalizeMemoryMeta(meta);
  if (value.scope === 'retired') return { eligible: false, reason: 'retired_scope' };
  if (value.scope === 'project' && (!context.projectId || context.projectId !== value.projectId)) {
    return { eligible: false, reason: 'project_scope' };
  }
  return { eligible: true, reason: null };
}

function memoryEligibility(meta, context = {}) {
  const value = normalizeMemoryMeta(meta);
  if (value.schemaErrors.length) return { eligible: false, reason: value.schemaErrors[0] };
  if (value.status !== 'active') return { eligible: false, reason: value.status };
  if (value.confidence !== 'user_confirmed') return { eligible: false, reason: 'inferred' };
  if (value.expiresAt) {
    const now = context.now == null ? Date.now() : new Date(context.now).getTime();
    if (!Number.isFinite(now)) return { eligible: false, reason: 'invalid_now' };
    if (Date.parse(value.expiresAt) <= now) return { eligible: false, reason: 'expired' };
  }
  return memoryScopeEligibility(value, context);
}

function parseMemoryDocument(content) {
  const source = String(content == null ? '' : content).replace(/^\uFEFF/, '');
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  let frontmatter = {}, errors = [], body = source;
  if (match) {
    body = source.slice(match[0].length);
    try {
      const loaded = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
      if (loaded != null && (typeof loaded !== 'object' || Array.isArray(loaded))) throw new Error('mapping required');
      frontmatter = loaded || {};
    } catch (_) { errors.push('invalid_frontmatter'); }
  } else if (/^---[ \t]*\r?\n/.test(source)) errors.push('invalid_frontmatter');
  const meta = normalizeMemoryMeta({ ...frontmatter, schemaErrors: errors });
  return { frontmatter, meta, body, hasFrontmatter: !!match, errors: meta.schemaErrors };
}

function serializeMemoryFrontmatter(meta = {}) {
  const value = normalizeMemoryMeta(meta);
  const fields = [
    ['name', value.name], ['description', value.description], ['type', value.type],
    ['scope', value.scope], ['project_id', value.projectId], ['status', value.status],
    ['confidence', value.confidence], ['source_ref', value.sourceRef],
    ['expires_at', value.expiresAt], ['supersedes', value.supersedes],
    ['supersedes_revision', value.supersedesRevision], ['core', value.core ? 'true' : null],
  ];
  return ['---', ...fields.filter(([, item]) => item != null && item !== '').map(([key, item]) => {
    const string = String(item);
    const safe = /^[a-zA-Z_][a-zA-Z0-9_./-]*$/.test(string) && !/^(true|false|null|yes|no|on|off)$/i.test(string)
      ? string : JSON.stringify(string);
    return `${key}: ${key === 'core' ? 'true' : safe}`;
  }), '---'].join('\n');
}

module.exports = {
  VALID_SCOPES, VALID_STATUS, VALID_CONFIDENCE, normalizeMemoryMeta,
  memoryEligibility, memoryScopeEligibility, parseMemoryDocument, serializeMemoryFrontmatter,
};
