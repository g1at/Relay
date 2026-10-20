'use strict';
const { diagnosticsFromEvent, hasDiagnostics } = require('./sdk-diagnostic-details');
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
  tool_schema_incompatible: '当前模型无法接受某个工具的参数格式，本轮请求已被服务商拒绝。',
  context_compaction_loop: '上下文压缩后仍很快超限，SDK 已停止重复压缩。工具定义、固定提示或过大的工具结果都可能占满上下文。',
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
  if (/Autocompact is thrashing|autocompact_thrashing|rapid_refill_breaker/i.test(text)) return 'context_compaction_loop';
  if (/parameters is not a valid moonshot flavored json schema/i.test(text)) return 'tool_schema_incompatible';
  if (/401|invalid.*api.?key|authentication_error/i.test(text)) return 'authentication';
  if (/429|rate_limit|rate.limit/i.test(text)) return 'rate_limit';
  return null;
}
function annotateError(event) {
  if (!event || typeof event !== 'object') return event;
  const diagnostics = diagnosticsFromEvent(event);
  const annotated = hasDiagnostics(diagnostics) ? { ...event, relay_diagnostics: diagnostics } : event;
  if (diagnostics.startupFailure) return { ...annotated, relay_error_category: 'sdk_startup_failure',
    relay_error_description: diagnostics.startupFailure.message, relay_error_suggestion: diagnostics.startupFailure.suggestion };
  // System recovery and plugin warnings are advisory, never task errors.
  if (!['assistant', 'result'].includes(event.type)) return annotated;
  const source = [event.error, event.result, event.subtype, event.terminal_reason, ...(Array.isArray(event.errors) ? event.errors : []),
    ...(event.isApiErrorMessage && Array.isArray(event.message?.content) ? event.message.content.filter(b => b?.type === 'text').map(b => b.text) : [])].join('\n');
  const category = errorCategory(source);
  // A successful answer may quote a provider error; only classify a real failure.
  if (['tool_schema_incompatible', 'context_compaction_loop'].includes(category) && !event.isApiErrorMessage && event.is_error !== true
    && !event.error && !/^error_/.test(String(event.subtype || ''))) return annotated;
  return category ? { ...annotated, relay_error_category: category,
    ...(DESCRIPTIONS[category] ? { relay_error_description: DESCRIPTIONS[category] } : {}),
    ...(category === 'context_compaction_loop' ? { relay_error_suggestion: '重启 Relay 后在原会话继续，可保留历史并让工具按需重新加载；若仍出现，请检查单次工具输出和服务商的上下文上限。' } : {}),
    ...(category === 'tool_schema_incompatible' ? { relay_error_suggestion: '需要修正工具定义或服务商兼容性，原样重试不会解决此问题。' } : {}) } : annotated;
}
module.exports = { configureSdkErrorCategories, errorCategory, annotateError };
