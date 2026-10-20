'use strict';

// This is the only conversion from open SDK diagnostic fields to a host DTO.
// Never copy producer text, paths, environment, credentials or stderr into it.
const STARTUP = Object.freeze({
  org_pin_api_key_conflict: ['组织登录方式不匹配', '组织要求指定登录方式，当前配置与之冲突。', '请检查组织要求的登录方式和当前服务商认证设置。'],
  org_verify_failed: ['组织身份暂时无法验证', 'SDK 未能验证当前登录所属的组织。', '请检查网络和登录状态，再重试。'],
  org_pin_mismatch: ['当前账号不符合组织要求', '当前登录所属的组织不在允许范围内。', '请使用组织允许的账号登录，或联系管理员。'],
  managed_settings_invalid: ['组织配置无法使用', '组织配置无效，或没有符合策略的可用模型。', '请检查组织配置及允许的模型，必要时联系管理员。'],
  remote_settings_required_unavailable: ['组织配置暂时不可用', 'SDK 未能加载启动所需的远端组织配置。', '请恢复网络连接后重试，或联系管理员。'],
  gateway_signin_required: ['需要重新登录网关', '组织网关要求重新登录。', '请重新登录组织网关后再试。'],
  gateway_access_denied: ['网关拒绝访问', '组织网关未允许当前账号访问配置。', '请检查网关账号权限，或联系管理员。'],
  proxy_invalid: ['代理设置无效', 'SDK 无法使用当前代理地址。', '请检查代理地址是否包含完整协议和主机。'],
  temp_dir_unusable: ['临时目录不可用', 'SDK 无法安全创建或使用临时目录。', '请检查临时目录的存在性、可写权限和磁盘空间。'],
  cwd_unavailable: ['工作目录不可用', '当前工作目录已移动、删除或无法读取。', '请重新选择可访问的工作目录后重试。'],
  shell_tool_missing: ['命令执行环境不可用', 'SDK 没有找到可用的命令执行工具。', '请检查 Git Bash 或 PowerShell 的安装和启用状态。'],
  session_held_by_background: ['会话仍被后台任务占用', 'SDK 报告要恢复的会话仍在后台运行。', '请等待对应后台任务结束，或在其所属会话中暂停。'],
  worktree_resume_refused: ['工作树恢复被拒绝', 'SDK 未通过工作树恢复检查。', '请检查原工作树及当前启动目录，再选择合适的恢复方式。'],
  worktree_unverified: ['暂时无法确认工作树', 'SDK 暂时无法验证原工作树的状态。', '请确认工作树可访问后重试。'],
  cli_version_too_old: ['执行器版本过旧', '当前 SDK 执行器低于服务要求的最低版本。', '请更新 Relay 及其内置执行器后重试。'],
  bypass_root: ['当前用户不能使用完全访问', 'SDK 不允许当前 root 用户启用跳过权限检查。', '请改用标准权限模式，或使用普通用户运行。'],
  unknown: ['执行器启动失败', 'SDK 报告了尚未识别的启动失败原因。', '请检查运行环境后重试；若持续失败，请保留诊断记录。'],
});
const PLUGINS = Object.freeze({
  'path-not-found': ['插件位置不可用', '插件目录或文件不可访问，请检查安装状态。'],
  'manifest-validation-error': ['插件清单无效', '插件清单未通过验证，请更新或重新安装插件。'],
  'dependency-unsatisfied': ['插件依赖不满足', '插件所需依赖不可用，请检查安装状态。'],
  'hook-load-failed': ['插件钩子加载失败', '插件钩子未能加载，该部分功能可能不可用。'],
  'generic-error': ['插件加载异常', '插件或其部分组件未能加载，请检查安装状态。'],
});
const RECOVERY = Object.freeze({
  host_draining: 'SDK 报告本轮因宿主退出准备而继续执行。',
  checkpoint_restore: 'SDK 报告本轮从检查点恢复后继续执行。',
  container_recreated: 'SDK 报告本轮在运行环境重新创建后继续执行。',
  interrupted_turn: 'SDK 报告本轮是先前中断轮次的再次执行。',
  unknown: 'SDK 报告本轮是恢复执行，具体原因暂未识别。',
});
const QUEUES = new Set(['durable_post', 'ephemeral_post', 'retry_backoff', 'hold', 'none']);
const MAX_PLUGIN_SCAN = 256, MAX_PLUGIN_ENTRIES = 12, MAX_COUNT = 10000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const own = (value, key) => !!value && Object.hasOwn(value, key);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(MAX_COUNT, value) : null;
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
const root = event => !event.parent_tool_use_id && !event.parentToolUseId && !event.agent_id && !event.subagent_type;
function startupFailure(reason) {
  const key = typeof reason === 'string' && own(STARTUP, reason) ? reason : 'unknown';
  const [title, message, suggestion] = STARTUP[key];
  return { reason: key, title, message, suggestion };
}
function pluginName(value) {
  if (typeof value !== 'string' || value.length > 129 || /(?:token|secret|password|api[-_]?key|bearer|authorization|^sk-|^gh[pousr]_|^AKIA)/i.test(value)) return '未识别插件';
  if (/^(?:inline|synced)\[\d{1,6}\]$/.test(value)) return value;
  return /^[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9][a-z0-9._-]{0,63})?$/i.test(value) ? value : '未识别插件';
}
function pluginEntry(value) {
  const type = plain(value) && typeof value.type === 'string' && own(PLUGINS, value.type) ? value.type : 'generic-error';
  const [label, message] = PLUGINS[type];
  return { plugin: pluginName(value?.plugin), type, label, message };
}
function pluginErrors(value) {
  if (!Array.isArray(value)) return null;
  const categories = new Map(), entries = [], seen = new Set();
  for (const item of value.slice(0, MAX_PLUGIN_SCAN)) {
    const entry = pluginEntry(item);
    categories.set(entry.type, (categories.get(entry.type) || 0) + 1);
    const key = `${entry.plugin}:${entry.type}`;
    if (!seen.has(key) && entries.length < MAX_PLUGIN_ENTRIES) { seen.add(key); entries.push(entry); }
  }
  return { count: Math.min(MAX_COUNT, value.length), truncated: value.length > MAX_PLUGIN_SCAN || value.length > entries.length,
    categories: [...categories].map(([type, total]) => ({ type, label: PLUGINS[type][0], count: total })), entries };
}
function recovery(reason) {
  const key = typeof reason === 'string' && own(RECOVERY, reason) ? reason : 'unknown';
  return { reason: key, message: RECOVERY[key] };
}
function timing(value, host = false) {
  const out = {};
  const keys = ['first_text_post_ms', 'first_stream_post_queue_wait_ms',
    ...(host ? ['hostStartupMs', 'hostModeMs', 'hostMcpMs', 'hostPreparationMs', 'hostFirstTextMs'] : [])];
  for (const key of keys) if (duration(value?.[key])) out[key] = value[key];
  if (typeof value?.first_stream_post_queued_behind === 'string' && value.first_stream_post_queued_behind) {
    out.first_stream_post_queued_behind = QUEUES.has(value.first_stream_post_queued_behind) ? value.first_stream_post_queued_behind : 'unknown';
  }
  return Object.keys(out).length ? out : null;
}
const workerRestart = () => ({ reason: 'worker_restart', message: 'SDK 报告后台任务因执行器重启而停止；这不代表整个对话已完成。' });
function sanitizeDiagnostics(value) {
  const out = { version: 1 };
  if (!plain(value)) return out;
  if (plain(value.startupFailure)) out.startupFailure = startupFailure(value.startupFailure.reason);
  if (plain(value.recovery)) out.recovery = recovery(value.recovery.reason);
  const times = timing(value.timing, true); if (times) out.timing = times;
  if (Number.isSafeInteger(value.resultIndex) && value.resultIndex >= 0 && value.resultIndex <= 1000000000) out.resultIndex = value.resultIndex;
  if (value.workerRestart?.reason === 'worker_restart') out.workerRestart = workerRestart();
  if (plain(value.pluginErrors) && count(value.pluginErrors.count) !== null) {
    const info = value.pluginErrors;
    const parsed = pluginErrors(Array.isArray(info.entries) ? info.entries.slice(0, MAX_PLUGIN_ENTRIES) : []);
    const categories = new Map();
    for (const item of Array.isArray(info.categories) ? info.categories.slice(0, 16) : []) {
      const type = typeof item?.type === 'string' && own(PLUGINS, item.type) ? item.type : 'generic-error';
      if (count(item?.count) !== null) categories.set(type, Math.min(MAX_COUNT, (categories.get(type) || 0) + count(item.count)));
    }
    out.pluginErrors = { count: count(info.count), truncated: info.truncated === true,
      categories: [...categories].map(([type, total]) => ({ type, label: PLUGINS[type][0], count: total })), entries: parsed.entries };
  }
  return out;
}
function diagnosticsFromEvent(event) {
  if (!plain(event)) return { version: 1 };
  if (!root(event)) return { version: 1 };
  if (event.type === 'job-done') {
    const final = event.finalResult;
    // A wrapper may carry explicit identity even when a consumer has no run
    // state. Never import a nested result known to belong to another context.
    if (final && (event.session_id && final.session_id && event.session_id !== final.session_id
        || Number.isSafeInteger(event.context_epoch) && Number.isSafeInteger(final.context_epoch) && event.context_epoch !== final.context_epoch)) return { version: 1 };
    return mergeDiagnostics(event.relay_diagnostics, diagnosticsFromEvent(final));
  }
  const out = sanitizeDiagnostics(event.relay_diagnostics);
  if (event.type === 'result' && own(event, 'startup_failure_reason') && event.startup_failure_reason != null && event.startup_failure_reason !== '') out.startupFailure = startupFailure(event.startup_failure_reason);
  if (event.type === 'system' && event.subtype === 'init') {
    const plugins = pluginErrors(event.plugin_errors); if (plugins) out.pluginErrors = plugins;
  }
  if (['assistant', 'stream_event', 'result'].includes(event.type) && typeof event.resume_reason === 'string' && event.resume_reason) out.recovery = recovery(event.resume_reason);
  if (['stream_event', 'result'].includes(event.type)) { const times = timing(event); if (times) out.timing = { ...out.timing, ...times }; }
  if (event.type === 'result' && Number.isSafeInteger(event.result_index) && event.result_index >= 0 && event.result_index <= 1000000000) out.resultIndex = event.result_index;
  if (event.type === 'system' && event.subtype === 'task_notification' && event.status === 'stopped' && event.reason === 'worker_restart') out.workerRestart = workerRestart();
  return out;
}
function hasDiagnostics(value) { return !!value && Object.keys(value).some(key => key !== 'version'); }
function mergeDiagnostics(previous, incoming) {
  const prior = sanitizeDiagnostics(previous), next = sanitizeDiagnostics(incoming);
  return { ...prior, ...next, ...(prior.timing || next.timing ? { timing: { ...prior.timing, ...next.timing } } : {}) };
}
module.exports = { diagnosticsFromEvent, sanitizeDiagnostics, mergeDiagnostics, hasDiagnostics, startupFailure, pluginErrors, pluginName };
