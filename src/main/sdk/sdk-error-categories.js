'use strict';
let usagePrefixes = [], orgPrefixes = [];
const DESCRIPTIONS = Object.freeze({
  organization_policy: '组织策略限制了这次请求，请检查当前服务商的组织授权。',
  usage_exhausted: '当前服务商的额度不足，请补充额度或切换服务商。',
  runtime_version_policy: '当前 SDK 运行时版本不符合组织要求，请检查最低或最高版本限制。',
  managed_settings_unavailable: '组织配置暂时无法读取，请恢复连接后重试。',
  resume_guard_rejected: '原生会话记录已变化，无法安全重试这一轮；请重新发送需求。',
  model_refusal: '当前模型拒绝了这次请求，可以修改输入后重试。',
  turn_limit: '已达到本次任务的轮次上限，可以调整运行选项后继续。',
  authentication: '当前服务商的认证失败，请检查密钥。',
});
function configureSdkErrorCategories(sdk) {
  usagePrefixes = Array.isArray(sdk?.USAGE_LIMIT_ERROR_PREFIXES) ? [...sdk.USAGE_LIMIT_ERROR_PREFIXES] : [];
  orgPrefixes = Array.isArray(sdk?.ORG_POLICY_LIMIT_PREFIXES) ? [...sdk.ORG_POLICY_LIMIT_PREFIXES] : [];
}
function errorCategory(value) {
  const text = String(value || '');
  if (orgPrefixes.some(prefix => text.includes(prefix)) || /organization.*(?:disabled|policy)|managed.policy.*denied/i.test(text)) return 'organization_policy';
  if (usagePrefixes.some(prefix => text.includes(prefix)) || /insufficient_quota|insufficient.balance|billing.hard.limit|credit.balance.*low|余额不足|欠费/i.test(text)) return 'usage_exhausted';
  if (/requiredMinimumVersion|requiredMaximumVersion|requires Claude Code.*version|minimum.required.version|maximum.allowed.version/i.test(text)) return 'runtime_version_policy';
  if (/forceRemoteSettingsRefresh|failed.*(?:managed|remote).*settings/i.test(text)) return 'managed_settings_unavailable';
  if (/Resume rejected by --resume-drops-turn:/.test(text)) return 'resume_guard_rejected';
  if (/refusal|refused.*(?:request|response)/i.test(text)) return 'model_refusal';
  if (/error_max_turns|maximum.*turns|maxTurns/i.test(text)) return 'turn_limit';
  if (/401|invalid.*api.?key|authentication_error/i.test(text)) return 'authentication';
  if (/429|rate_limit|rate.limit/i.test(text)) return 'rate_limit';
  return null;
}
function annotateError(event) {
  if (!event || !['assistant', 'result'].includes(event.type)) return event;
  const source = [event.error, event.result, event.subtype, ...(Array.isArray(event.errors) ? event.errors : []),
    ...(event.isApiErrorMessage && Array.isArray(event.message?.content) ? event.message.content.filter(b => b?.type === 'text').map(b => b.text) : [])].join('\n');
  const category = errorCategory(source);
  return category ? { ...event, relay_error_category: category,
    ...(DESCRIPTIONS[category] ? { relay_error_description: DESCRIPTIONS[category] } : {}) } : event;
}
module.exports = { configureSdkErrorCategories, errorCategory, annotateError };
