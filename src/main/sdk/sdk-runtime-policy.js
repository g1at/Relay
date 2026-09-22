'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeSdkPreferences, sdkPreferenceOptions } = require('./sdk-runtime-preferences');
const { normalizeRelayInstructions, validateRelayInstructions } = require('./relay-instructions');

const RETENTION_DAYS = Object.freeze([30, 90, 180, 365]);
const POLICY_DEFAULTS = Object.freeze({
  sdkSettingSources: 'user', sdkTrustedProjectIds: Object.freeze([]),
  sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false, sdkCleanupPeriodDays: null,
  sdkRuntimePreferences: Object.freeze({}),
});
function normalizeRuntimePolicy(settings = {}) {
  return {
    sdkSettingSources: ['user', 'project', 'local'].includes(settings.sdkSettingSources) ? settings.sdkSettingSources : 'user',
    sdkTrustedProjectIds: [...new Set((Array.isArray(settings.sdkTrustedProjectIds) ? settings.sdkTrustedProjectIds : [])
      .filter(value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value)))].slice(0, 1000),
    // Retired controls remain accepted for old settings and clients, but cannot
    // restore SDK memory. Relay is the sole long-term memory library.
    sdkMemoryMode: 'relay',
    sdkAutoDreamEnabled: false,
    // Retired desktop control: never carry an old user override into shared SDK cleanup.
    sdkCleanupPeriodDays: null,
    sdkRuntimePreferences: normalizeSdkPreferences(settings.sdkRuntimePreferences),
  };
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function absolutePath(value) { return typeof value === 'string' && !value.includes('\0') && (path.isAbsolute(value) || path.win32.isAbsolute(value)); }

// Pure policy derivation: never edits ~/.claude, moves memories, or touches a
// conversation's timestamps. The host must rebuild a session if this changes.
function buildRuntimePolicy({ settings = {}, projectId, projectRoot, cwd, environment = 'native', mapPath, diagnosticsDir } = {}) {
  const policy = normalizeRuntimePolicy(settings);
  const relayInstructions = validateRelayInstructions(normalizeRelayInstructions(settings.relayInstructions));
  const trusted = !!projectId && absolutePath(projectRoot) && policy.sdkTrustedProjectIds.includes(projectId);
  const settingSources = ['user'];
  if (trusted && ['project', 'local'].includes(policy.sdkSettingSources)) settingSources.push('project');
  if (trusted && policy.sdkSettingSources === 'local') settingSources.push('local');
  const advanced = sdkPreferenceOptions(policy.sdkRuntimePreferences, { cwd, projectId, trustedProject: trusted,
    environment, mapPath, diagnosticsDir });
  const nativeSettings = {
    ...advanced.settings,
    autoMemoryEnabled: false, autoDreamEnabled: false,
    ...(policy.sdkCleanupPeriodDays != null ? { cleanupPeriodDays: policy.sdkCleanupPeriodDays } : {}),
  };
  return {
    settingSources, settings: nativeSettings, options: advanced.options, relayInstructions,
    // Preserve existing empty-default contracts; changes to actual guidance
    // rebuild resident/resumed sessions using Relay's existing history recovery.
    fingerprint: hash({ policy, projectId: projectId || null, projectRoot: trusted ? projectRoot : null, environment, plansDirectory: nativeSettings.plansDirectory,
      ...(relayInstructions.trim() ? { relayInstructions } : {}) }),
    summary: {
      sources: settingSources, trustedProject: trusted,
      memoryMode: 'relay',
      autoDreamEnabled: nativeSettings.autoDreamEnabled, cleanupPeriodDays: policy.sdkCleanupPeriodDays,
      relayHistoryRetained: true,
      runtimePreferences: advanced.preferences,
    },
  };
}

const SOURCES = new Set(['user', 'project', 'local', 'managed', 'flag']);
const MEMORY_TYPES = new Set(['User', 'Project', 'Local', 'Managed']);
const REASONS = new Set(['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact']);
function safePathLabel(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  // Only fixed, recognized basenames are exposed; arbitrary names may include
  // client/project/user identity, credentials, or prompt content.
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'MEMORY.md', 'settings.json', 'settings.local.json', 'managed-settings.json'].includes(base) ? base : '其他文件';
}
function summarizeInstructionsLoaded(input = {}) {
  return {
    file: safePathLabel(input.file_path),
    source: MEMORY_TYPES.has(input.memory_type) ? input.memory_type : 'Unknown',
    reason: REASONS.has(input.load_reason) ? input.load_reason : 'unknown',
    hasPathFilter: Array.isArray(input.globs) && input.globs.length > 0,
    hasParent: !!input.parent_file_path,
  };
}
const DISPLAY_KEYS = ['permissions', 'sandbox', 'hooks', 'disableAllHooks', 'model', 'env', 'modelOverrides', 'availableModels', 'autoMemoryEnabled', 'autoMemoryDirectory', 'autoDreamEnabled', 'cleanupPeriodDays', 'alwaysThinkingEnabled', 'policyHelper',
  'allowedMcpServers', 'deniedMcpServers', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
  'strictPluginOnlyCustomization', 'enabledPlugins', 'pluginConfigs', 'forceRemoteSettingsRefresh', 'requiredMinimumVersion', 'requiredMaximumVersion',
  'claudeMdExcludes', 'skillOverrides', 'disableSkillShellExecution', 'plansDirectory', 'autoCompactEnabled', 'autoCompactWindow', 'showThinkingSummaries', 'switchModelsOnFlag'];
function summarizeResolvedSettings(resolved, filtered) {
  const raw = resolved && typeof resolved === 'object' ? resolved : {};
  const effective = filtered && typeof filtered === 'object' ? filtered : {};
  const rawMode = raw.effective?.permissions?.defaultMode;
  const permissions = effective.permissions || {};
  const allowedModes = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']);
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).map(source => ({
    source: SOURCES.has(source.source) ? source.source : 'unknown',
    file: safePathLabel(source.path),
    keys: DISPLAY_KEYS.filter(key => Object.hasOwn(source.settings || {}, key)),
  }));
  return {
    sources,
    entries: DISPLAY_KEYS.filter(key => Object.hasOwn(effective, key)).map(key => ({
      key, source: SOURCES.has(raw.provenance?.[key]?.source) ? raw.provenance[key].source : 'unknown',
    })),
    defaultPermissionMode: allowedModes.has(permissions.defaultMode) ? permissions.defaultMode : null,
    filteredProjectEscalation: !!rawMode && rawMode !== permissions.defaultMode,
    hooksDisabled: effective.disableAllHooks === true,
    policyHelperDetected: !!raw.effective?.policyHelper || sources.some(source => source.keys.includes('policyHelper')),
    restrictions: {
      pluginOnly: effective.strictPluginOnlyCustomization === true || Array.isArray(effective.strictPluginOnlyCustomization),
      pluginOnlyKinds: Array.isArray(effective.strictPluginOnlyCustomization) ? effective.strictPluginOnlyCustomization.filter(v => ['skills', 'agents', 'hooks', 'mcp'].includes(v)) : [],
      mcpCommandRules: [...(effective.allowedMcpServers || []), ...(effective.deniedMcpServers || [])].filter(x => x.serverCommand || x.serverUrl).length,
      allowedMcpServers: (effective.allowedMcpServers || []).map(item => item.serverName).filter(name => typeof name === 'string').slice(0, 128),
      deniedMcpServers: (effective.deniedMcpServers || []).map(item => item.serverName).filter(name => typeof name === 'string').slice(0, 128),
      minVersion: typeof effective.requiredMinimumVersion === 'string' ? effective.requiredMinimumVersion.slice(0, 50) : null,
      maxVersion: typeof effective.requiredMaximumVersion === 'string' ? effective.requiredMaximumVersion.slice(0, 50) : null,
      refreshManagedSettings: effective.forceRemoteSettingsRefresh === true,
    },
    limitations: ['配置预览不执行 policyHelper；实际启动时的管理策略仍由 SDK 执行。', '服务商、模型与当前权限由 Relay 的会话选项指定；这里不用于覆盖会话。'],
  };
}

// This helper is explicitly a preview, never an authorization or execution
// option builder. In WSL a Windows resolveSettings call would inspect the wrong
// machine: callers must supply an in-environment resolver or show unavailable.
function createRuntimeDiagnostics({ resolveSettings, filterEscalatingDefaultMode, resolveInEnvironment, inspectInEnvironment, maxInstructions = 32 } = {}) {
  let instructions = [];
  function recordInstructions(input) {
    const item = summarizeInstructionsLoaded(input);
    if (instructions.some(previous => JSON.stringify(previous) === JSON.stringify(item))) return item;
    instructions.push(item); instructions = instructions.slice(-Math.max(1, Math.min(128, maxInstructions)));
    return item;
  }
  async function inspect({ cwd, settingSources = ['user'], environment = 'native' } = {}) {
    if (environment === 'wsl' && typeof inspectInEnvironment === 'function') {
      try {
        const result = await inspectInEnvironment({ cwd, settingSources });
        return { ...result, instructions: [...instructions] };
      } catch (_) { return { ok: false, code: 'DIAGNOSTICS_ENVIRONMENT_UNAVAILABLE', error: 'WSL 配置诊断暂不可用，任务运行不受影响。', instructions: [...instructions] }; }
    }
    if (environment === 'wsl' && typeof resolveInEnvironment !== 'function') return { ok: false, code: 'DIAGNOSTICS_ENVIRONMENT_UNAVAILABLE', error: '当前为 WSL 运行环境，宿主配置预览不能代表 WSL 配置。', instructions: [...instructions] };
    if (typeof resolveSettings !== 'function' || typeof filterEscalatingDefaultMode !== 'function') return { ok: false, code: 'DIAGNOSTICS_UNAVAILABLE', error: '当前 SDK 不提供配置诊断接口。', instructions: [...instructions] };
    try {
      const args = { ...(absolutePath(cwd) ? { cwd } : {}), settingSources: settingSources.filter(source => ['user', 'project', 'local'].includes(source)) };
      const raw = environment === 'wsl' ? await resolveInEnvironment(args) : await resolveSettings(args);
      const filtered = await filterEscalatingDefaultMode(raw);
      return { ok: true, ...summarizeResolvedSettings(raw, filtered), instructions: [...instructions] };
    } catch (_) {
      // SDK/OS exception messages can contain paths, env values and commands.
      return { ok: false, code: 'DIAGNOSTICS_FAILED', error: '配置诊断暂不可用，未修改当前运行配置。', instructions: [...instructions] };
    }
  }
  return { inspect, recordInstructions, getInstructions: () => [...instructions], clear: () => { instructions = []; } };
}

module.exports = { POLICY_DEFAULTS, RETENTION_DAYS, normalizeRuntimePolicy, buildRuntimePolicy, summarizeInstructionsLoaded, summarizeResolvedSettings, createRuntimeDiagnostics };
