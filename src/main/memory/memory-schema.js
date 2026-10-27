'use strict';

const yaml = require('js-yaml');

const VALID_SCOPES = new Set(['global', 'project']);
const VALID_STATUS = new Set(['active', 'draft', 'superseded', 'expired']);
const VALID_CONFIDENCE = new Set(['user_confirmed', 'inferred']);
const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);
const VALID_TYPES = new Set(MEMORY_TYPES);
const MAX_MEMORY_SOURCES = 32;
const MAX_MEMORY_REPLACES = 16;
const MEMORY_TYPE_GUIDANCE = '每条记忆必须按正文主旨明确选择 type：user（用户）用于稳定背景、身份及长期个人偏好；feedback（反馈）用于用户对助手做事方式的要求、纠正和避免再犯的规则；project（项目）用于具体项目事实、状态、约束及项目或车型关系；reference（参考）用于可查阅资源、文档、工具或环境入口及固定查阅资料。个人喜好属于 user，要求助手如何回应或操作属于 feedback；项目事实属于 project，去哪里查资料属于 reference。按实际内容分类，不从文件名前缀推断；多个独立主旨应拆成多条记忆。type 与 scope 独立，项目类型不自动决定使用范围。调用 propose 时必须提供 type；正文元数据如也填写 type，须与参数一致。';

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function truthy(value) {
  return value === true || value === 1 || /^(true|yes|1|core|pinned)$/i.test(text(value, 20));
}

function validMemoryFilename(value) {
  return typeof value === 'string' && value.length <= 200 && /^[^<>:"/\\|?*\x00-\x1f]+\.md$/i.test(value)
    && !value.startsWith('.') && !/[. ]\.md$/i.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) && value.toLowerCase() !== 'memory.md';
}

function provenanceList(value, kind, errors) {
  if (value == null) return [];
  const limit = kind === 'sources' ? MAX_MEMORY_SOURCES : MAX_MEMORY_REPLACES;
  if (!Array.isArray(value) || value.length > limit) { errors.push(`invalid_${kind}`); return []; }
  const result = [], seen = new Map();
  const id = (item) => typeof item === 'string' && item.length > 0 && item.length <= 128 && !/[\x00-\x20\x7f]/.test(item);
  const hash = (item) => typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item);
  for (const item of value) {
    let normalized = null;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if ((kind === 'replaces' || item.kind === 'memory') && validMemoryFilename(item.file) && hash(item.revision)) {
        const allowed = kind === 'replaces' ? ['file', 'revision'] : ['kind', 'file', 'revision'];
        if (Object.keys(item).every((key) => allowed.includes(key))) {
          normalized = { ...(kind === 'sources' ? { kind: 'memory' } : {}), file: item.file, revision: item.revision.toLowerCase() };
        }
      } else if (kind === 'sources' && item.kind === 'conversation'
        && id(item.conversationId) && (item.turnId == null || id(item.turnId))
        && Number.isSafeInteger(item.turnIndex) && item.turnIndex >= 0
        && ['user', 'assistant'].includes(item.role) && typeof item.quote === 'string'
        && item.quote.trim() && item.quote.length <= 2000 && !/\x00/.test(item.quote)
        && typeof item.at === 'string' && item.at.length <= 80 && Number.isFinite(Date.parse(item.at))
        && hash(item.revision) && (item.title == null || typeof item.title === 'string' && item.title.length <= 160)
        && Object.keys(item).every((key) => ['kind', 'conversationId', 'turnId', 'turnIndex', 'role', 'quote', 'at', 'revision', 'title'].includes(key))) {
        normalized = { kind: 'conversation', conversationId: item.conversationId,
          ...(item.turnId != null ? { turnId: item.turnId } : {}), turnIndex: item.turnIndex, role: item.role,
          quote: item.quote, at: item.at, revision: item.revision.toLowerCase(),
          ...(item.title != null ? { title: item.title } : {}) };
      }
    }
    if (!normalized) { errors.push(`invalid_${kind}`); continue; }
    const key = kind === 'replaces' ? normalized.file.toLowerCase() : JSON.stringify(normalized);
    if (seen.has(key)) {
      if (kind === 'replaces' && seen.get(key).revision !== normalized.revision) errors.push('invalid_replaces');
      continue;
    }
    seen.set(key, normalized); result.push(normalized);
  }
  return result;
}

function normalizeMemoryMeta(frontmatter = {}) {
  const fm = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter) ? frontmatter : {};
  const errors = Array.isArray(fm.schemaErrors) ? [...fm.schemaErrors] : [];
  const rawScope = text(fm.scope, 40);
  const scope = rawScope ? (VALID_SCOPES.has(rawScope) ? rawScope : 'retired') : 'global';
  const rawStatus = text(fm.status, 40);
  const status = !rawStatus ? 'active' : (VALID_STATUS.has(rawStatus) ? rawStatus : 'draft');
  const rawConfidence = text(fm.confidence, 40);
  const legacyMetadata = fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata) ? fm.metadata : {};
  const suppliedType = Object.hasOwn(fm, 'type') ? fm.type : legacyMetadata.type;
  const rawType = text(suppliedType, 40);
  const confidence = !rawConfidence ? (status === 'draft' ? 'inferred' : 'user_confirmed')
    : (VALID_CONFIDENCE.has(rawConfidence) ? rawConfidence : 'inferred');
  const projectId = text(fm.project_id ?? fm.projectId, 128) || null;
  const expiresAt = text(fm.expires_at ?? fm.expiresAt, 80) || null;
  if (rawStatus && !VALID_STATUS.has(rawStatus)) errors.push('invalid_status');
  if (rawConfidence && !VALID_CONFIDENCE.has(rawConfidence)) errors.push('invalid_confidence');
  if (suppliedType != null && (typeof suppliedType !== 'string' || rawType && !VALID_TYPES.has(rawType))) errors.push('invalid_type');
  if (scope === 'project' && !projectId) errors.push('missing_project_id');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) errors.push('invalid_expiry');
  const sources = provenanceList(fm.sources, 'sources', errors);
  const replaces = provenanceList(fm.replaces, 'replaces', errors);
  return {
    name: text(fm.name, 120),
    description: text(fm.description, 500),
    type: rawType || null,
    core: truthy(fm.core) || truthy(fm.pinned),
    scope,
    projectId,
    status,
    sourceRef: text(fm.source_ref ?? fm.sourceRef, 1000) || null,
    confidence,
    expiresAt,
    supersedes: text(fm.supersedes, 200) || null,
    supersedesRevision: text(fm.supersedes_revision ?? fm.supersedesRevision, 128) || null,
    sources,
    replaces,
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
    ['sources', value.sources.length ? value.sources : null], ['replaces', value.replaces.length ? value.replaces : null],
  ];
  return ['---', ...fields.filter(([, item]) => item != null && item !== '').map(([key, item]) => {
    if (Array.isArray(item)) return `${key}: ${JSON.stringify(item)}`;
    const string = String(item);
    const safe = /^[a-zA-Z_][a-zA-Z0-9_./-]*$/.test(string) && !/^(true|false|null|yes|no|on|off)$/i.test(string)
      ? string : JSON.stringify(string);
    return `${key}: ${key === 'core' ? 'true' : safe}`;
  }), '---'].join('\n');
}

module.exports = {
  VALID_SCOPES, VALID_STATUS, VALID_CONFIDENCE, MEMORY_TYPES, VALID_TYPES, MAX_MEMORY_SOURCES, MAX_MEMORY_REPLACES,
  MEMORY_TYPE_GUIDANCE, normalizeMemoryMeta,
  memoryEligibility, memoryScopeEligibility, parseMemoryDocument, serializeMemoryFrontmatter,
};
