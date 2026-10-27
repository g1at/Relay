'use strict';

const { normalizeMemoryMeta, parseMemoryDocument } = require('./memory-schema');

const ISSUE_MESSAGES = {
  invalid_frontmatter: '记忆元数据格式错误，请修正文件顶部的 YAML。',
  invalid_type: '记忆类型无效，请选择用户、反馈、项目或参考。',
  invalid_sources: '来源记录格式无效，请检查 sources。',
  invalid_replaces: '归并目标格式无效，请检查 replaces。',
  missing_type: '尚未分类，请按内容补充类型。',
  missing_project_id: '项目记忆缺少项目 ID，请指定所属项目。',
  invalid_status: '记忆状态无效，请修正 status。',
  invalid_confidence: '确认状态无效，请修正 confidence。',
  invalid_expiry: '到期时间无效，请修正 expires_at。',
  unknown_project: '所属项目不存在或已被移除，请核对项目 ID。',
  retired_scope: '旧作用域已停用，请核对并设置有效的作用域。',
  draft: '等待用户确认，尚未用于回答。',
  inferred: '尚未得到用户确认，未用于回答。',
  expired: '记忆已过期，未用于回答。',
  superseded: '记忆已被替代，未用于回答。',
  project_scope: '这条记忆仅在所属项目中使用。',
  archived: '记忆已归档，恢复前不会用于回答。',
  invalid_now: '检查时间无效，无法判断是否过期。',
};

function legacyFieldsFor(entry, parsed) {
  if (Array.isArray(entry.legacyFields)) return entry.legacyFields;
  if (!parsed || parsed.errors.includes('invalid_frontmatter')) return [];
  return ['scope', 'status', 'confidence'].filter((field) => !Object.hasOwn(parsed.frontmatter, field)
    || parsed.frontmatter[field] == null || String(parsed.frontmatter[field]).trim() === '');
}

// A management view describes library health, not visibility in a particular chat.
// With no current project, a valid project memory is usable in its own project.
function memoryHealth(entry = {}, { context = {}, knownProjectIds, archived = false, now = Date.now() } = {}) {
  const parsed = typeof entry.content === 'string' ? parseMemoryDocument(entry.content) : null;
  const meta = normalizeMemoryMeta(entry.meta || (parsed && parsed.meta) || {});
  const legacyFields = legacyFieldsFor(entry, parsed);
  const issues = [];
  const add = (code, message = ISSUE_MESSAGES[code] || `记忆元数据错误：${code}。`) => {
    if (!issues.some((issue) => issue.code === code)) issues.push({ code, message });
  };
  meta.schemaErrors.forEach((code) => add(code));
  if (meta.scope === 'project' && meta.projectId && knownProjectIds instanceof Set && !knownProjectIds.has(meta.projectId)) {
    add('unknown_project');
  }

  let state = 'active', label = '可用', reasonCode = null;
  const invalid = issues.length > 0;
  if (archived) {
    state = 'inactive'; label = '已归档'; reasonCode = 'archived';
  } else if (invalid) {
    state = 'invalid'; label = '无效'; reasonCode = issues[0].code;
  } else if (meta.scope === 'retired') {
    state = 'inactive'; label = '未生效'; reasonCode = 'retired_scope';
  } else if (meta.status === 'superseded' || meta.status === 'expired') {
    state = 'inactive'; label = meta.status === 'superseded' ? '已替代' : '已过期'; reasonCode = meta.status;
  } else {
    const checkedAt = new Date(context.now == null ? now : context.now).getTime();
    if (meta.expiresAt && !Number.isFinite(checkedAt)) {
      state = 'invalid'; label = '无效'; reasonCode = 'invalid_now';
    } else if (meta.expiresAt && Date.parse(meta.expiresAt) <= checkedAt) {
      state = 'inactive'; label = '已过期'; reasonCode = 'expired';
    } else if (meta.status === 'draft' || meta.confidence === 'inferred') {
      state = 'draft'; label = '待确认'; reasonCode = meta.status === 'draft' ? 'draft' : 'inferred';
    } else if (meta.scope === 'project' && context.projectId && context.projectId !== meta.projectId) {
      state = 'inactive'; label = '其他项目'; reasonCode = 'project_scope';
    }
  }
  if (reasonCode) add(reasonCode);
  if (!meta.type && !meta.schemaErrors.includes('invalid_frontmatter') && !meta.schemaErrors.includes('invalid_type')) add('missing_type');
  if (legacyFields.length) {
    add('legacy_fields', `旧格式缺少 ${legacyFields.join('、')}，当前沿用兼容默认值；这不代表用户已逐条审核。请核对后显式保存。`);
  }
  return { state, label, reason: reasonCode ? issues.find((issue) => issue.code === reasonCode).message : null,
    issues, legacy: legacyFields.length > 0 };
}

function memoryHealthSummary(items) {
  const summary = { total: items.length, active: 0, draft: 0, inactive: 0, invalid: 0, legacy: 0 };
  for (const item of items) {
    const health = item.health;
    if (health && Object.hasOwn(summary, health.state)) summary[health.state] += 1;
    if (health && health.legacy) summary.legacy += 1;
  }
  return summary;
}

module.exports = { memoryHealth, memoryHealthSummary };
