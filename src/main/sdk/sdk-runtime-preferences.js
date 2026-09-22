'use strict';

const path = require('node:path');
const fail = message => Object.assign(new Error(message), { code: 'INVALID_SDK_PREFERENCE' });
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeName = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 300
  && !/[\x00-\x1f\x7f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const DEFAULTS = Object.freeze({
  maxTurns: null, thinking: 'inherit', thinkingBudget: 4096, thinkingDisplay: 'summarized',
  diagnostics: false, forwardSubagentText: false, agentProgressSummaries: false,
  skillBudget: 'inherit', outputBudget: 'inherit', autoCompact: 'inherit', autoCompactWindow: null,
  showThinkingSummaries: 'inherit', disableSkillShellExecution: false, showClearContextOnPlanAccept: false,
  skills: null, skillOverrides: {}, allowedTools: [], disallowedTools: [], claudeMdExcludes: [],
  projectMcpApprovals: {}, worktree: {}, switchModelsOnFlag: 'inherit',
  customSystemPrompt: null,
});
// These former user settings are no longer part of Relay's product surface.
// Accept their old keys during upgrades, but never retain invisible execution
// limits, project exclusions/worktree overrides or debug collection. Direct SDK
// options used internally (for example bounded title generation) are unaffected.
const RETIRED_PREFERENCE_KEYS = Object.freeze(['maxTurns', 'diagnostics', 'claudeMdExcludes', 'worktree']);
const ENUMS = {
  thinking: ['inherit', 'adaptive', 'enabled', 'disabled'], thinkingDisplay: ['summarized', 'omitted'],
  skillBudget: ['inherit', 'compact', 'balanced', 'expanded'], outputBudget: ['inherit', 'compact', 'balanced', 'expanded'],
  autoCompact: ['inherit', 'enabled', 'disabled'], showThinkingSummaries: ['inherit', 'enabled', 'disabled'],
  switchModelsOnFlag: ['inherit', 'enabled', 'disabled'],
};
const BOOLS = ['diagnostics', 'forwardSubagentText', 'agentProgressSummaries', 'disableSkillShellExecution', 'showClearContextOnPlanAccept'];
function stringList(value, label, max = 128) {
  if (!Array.isArray(value) || value.length > max || value.some(item => !safeName(item))) throw fail(`${label}应为不重复的名称列表。`);
  return [...new Set(value)];
}
function normalizeSdkPreferences(input = {}, { strict = false } = {}) {
  if (!plain(input)) { if (strict) throw fail('运行选项格式无效。'); input = {}; }
  const out = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(input)) {
    if (RETIRED_PREFERENCE_KEYS.includes(key)) continue;
    try {
      if (!Object.hasOwn(DEFAULTS, key)) { if (strict) throw fail(`不支持的运行选项：${key}`); continue; }
      if (ENUMS[key]) { if (!ENUMS[key].includes(value)) throw fail('运行选项取值无效。'); out[key] = value; }
      else if (BOOLS.includes(key)) { if (typeof value !== 'boolean') throw fail('运行开关必须是布尔值。'); out[key] = value; }
      else if (key === 'maxTurns' || key === 'autoCompactWindow' || key === 'thinkingBudget') {
        const [min, max] = key === 'maxTurns' ? [1, 10000] : key === 'thinkingBudget' ? [1024, 128000] : [10000, 2000000];
        if (value === null && key !== 'thinkingBudget') out[key] = null;
        else { if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${key}超出支持范围。`); out[key] = value; }
      } else if (['skills', 'allowedTools', 'disallowedTools', 'claudeMdExcludes'].includes(key)) {
        out[key] = key === 'skills' && value === null ? null : stringList(value, key);
      } else if (key === 'customSystemPrompt') {
        if (value === null) out[key] = null;
        else {
          if (!plain(value) || Object.keys(value).some(k => !['static', 'dynamic'].includes(k))) throw fail('自定义主指令格式无效');
          const blocks = part => {
            if (!Array.isArray(part) || part.length > 32 || part.some(x => typeof x !== 'string' || x.length > 64000 || x.includes('\0'))) throw fail('主指令内容过大或格式无效');
            return part.filter(x => x.trim());
          };
          out[key] = { static: blocks(value.static || []), dynamic: blocks(value.dynamic || []) };
          if (!out[key].static.length) throw fail('请填写固定主指令，或关闭自定义主指令');
        }
      } else if (key === 'skillOverrides') {
        if (!plain(value) || Object.keys(value).length > 512) throw fail('技能调用规则过多或格式无效。');
        const map = {};
        for (const [name, mode] of Object.entries(value)) {
          if (!safeName(name) || !['on', 'name-only', 'user-invocable-only', 'off'].includes(mode)) throw fail('技能调用规则无效。');
          map[name] = mode;
        }
        out[key] = map;
      } else if (key === 'projectMcpApprovals') {
        if (!plain(value) || Object.keys(value).length > 1000) throw fail('项目工具规则无效。');
        const map = {};
        for (const [id, entry] of Object.entries(value)) {
          if (!/^[\w-]{1,160}$/.test(id) || !safeName(id) || !plain(entry) || Object.keys(entry).some(k => !['all', 'enabled', 'disabled'].includes(k))) throw fail('项目工具规则无效。');
          if (entry.all !== undefined && typeof entry.all !== 'boolean') throw fail('项目工具授权值无效。');
          map[id] = { all: entry.all === true, enabled: stringList(entry.enabled || [], '允许工具'), disabled: stringList(entry.disabled || [], '拒绝工具') };
        }
        out[key] = map;
      } else if (key === 'worktree') {
        if (!plain(value) || Object.keys(value).some(k => !['baseRef', 'sparsePaths', 'symlinkDirectories'].includes(k))) throw fail('工作树选项无效。');
        const config = {};
        if (value.baseRef !== undefined) { if (!['fresh', 'head'].includes(value.baseRef)) throw fail('工作树起点无效。'); config.baseRef = value.baseRef; }
        for (const field of ['sparsePaths', 'symlinkDirectories']) if (value[field] !== undefined) {
          config[field] = stringList(value[field], '工作树目录');
          if (config[field].some(item => path.posix.isAbsolute(item) || path.win32.isAbsolute(item) || item.split(/[\\/]/).some(p => p === '..' || p === '.git'))) throw fail('工作树目录必须位于项目内。');
        }
        out[key] = config;
      }
    } catch (error) { if (strict) throw error; }
  }
  return out;
}

function sdkPreferenceOptions(input, { cwd, projectId, trustedProject = false, environment = 'native', mapPath } = {}) {
  const prefs = normalizeSdkPreferences(input), settings = {}, options = {};
  if (prefs.maxTurns !== null) options.maxTurns = prefs.maxTurns;
  if (prefs.thinking !== 'inherit') options.thinking = { type: prefs.thinking,
    ...(prefs.thinking === 'enabled' ? { budgetTokens: prefs.thinkingBudget } : {}),
    ...(prefs.thinking !== 'disabled' ? { display: prefs.thinkingDisplay } : {}) };
  for (const key of ['forwardSubagentText', 'agentProgressSummaries']) if (prefs[key]) options[key] = true;
  if (prefs.skills !== null) options.skills = prefs.skills;
  for (const key of ['allowedTools', 'disallowedTools']) if (prefs[key].length) options[key] = prefs[key];
  if (Object.keys(prefs.skillOverrides).length) settings.skillOverrides = prefs.skillOverrides;
  if (prefs.claudeMdExcludes.length) settings.claudeMdExcludes = prefs.claudeMdExcludes;
  if (Object.keys(prefs.worktree).length) settings.worktree = prefs.worktree;
  const skillBudgets = { compact: [384, .005], balanced: [1536, .01], expanded: [3072, .02] };
  if (skillBudgets[prefs.skillBudget]) [settings.skillListingMaxDescChars, settings.skillListingBudgetFraction] = skillBudgets[prefs.skillBudget];
  const outputs = { compact: 16000, balanced: 48000, expanded: 96000 };
  if (outputs[prefs.outputBudget]) settings.bashOutputMaxChars = settings.taskOutputMaxChars = outputs[prefs.outputBudget];
  for (const [from, to] of [['autoCompact', 'autoCompactEnabled'], ['showThinkingSummaries', 'showThinkingSummaries'], ['switchModelsOnFlag', 'switchModelsOnFlag']]) {
    if (prefs[from] !== 'inherit') settings[to] = prefs[from] === 'enabled';
  }
  if (prefs.autoCompactWindow !== null) settings.autoCompactWindow = prefs.autoCompactWindow;
  if (prefs.disableSkillShellExecution) settings.disableSkillShellExecution = true;
  if (prefs.showClearContextOnPlanAccept) settings.showClearContextOnPlanAccept = true;
  const approval = trustedProject && projectId && prefs.projectMcpApprovals[projectId];
  if (approval) Object.assign(settings, { enableAllProjectMcpServers: approval.all,
    enabledMcpjsonServers: approval.enabled.filter(name => !approval.disabled.includes(name)), disabledMcpjsonServers: approval.disabled });
  if (cwd && (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd))) {
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? path.win32 : path;
    let plansDirectory = paths.join(cwd, '.relay', 'plans');
    if (environment === 'wsl' && !plansDirectory.startsWith('/')) {
      if (typeof mapPath !== 'function') throw fail('计划目录缺少 WSL 路径映射。'); plansDirectory = mapPath(plansDirectory);
    }
    settings.plansDirectory = plansDirectory;
  }
  if (prefs.diagnostics) {
    options.includeHookEvents = true;
    // SDK debug logs may contain full prompts and credentials. An isolated
    // host sink retains aggregate counters only. Live and one-shot execution
    // install the same private, short-lived diagnostic sink.
    options.debug = true;
  }
  return { preferences: prefs, settings, options };
}

// applyFlagSettings uses shallow merge. Never accept arbitrary renderer JSON,
// permissions, model routing, env or plugin state on this live control path.
function validateFlagSettings(input) {
  if (!plain(input) || !Object.keys(input).length) throw fail('会话选项为空。');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'effortLevel' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) out[key] = value;
    else if (['autoCompactEnabled', 'showThinkingSummaries'].includes(key) && typeof value === 'boolean') out[key] = value;
    else if (['bashOutputMaxChars', 'taskOutputMaxChars'].includes(key) && Number.isSafeInteger(value) && value >= 4000 && value <= 128000) out[key] = value;
    else throw fail(`该选项不能在运行中修改：${key}`);
  }
  return out;
}
function customPrompt(staticBlocks, dynamicBlocks, sdk) {
  const blocks = values => (Array.isArray(values) ? values : [values]).filter(value => typeof value === 'string' && value.trim());
  const fixed = blocks(staticBlocks), dynamic = blocks(dynamicBlocks);
  if (!fixed.length) throw fail('自定义提示词缺少固定说明。');
  const boundary = sdk?.SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
  if (dynamic.length && typeof boundary !== 'string') throw fail('当前 SDK 不支持提示词缓存分界。');
  return { type: 'custom', prompt: dynamic.length ? [...fixed, boundary, ...dynamic] : fixed, snapshot: true };
}

module.exports = { DEFAULTS, RETIRED_PREFERENCE_KEYS, normalizeSdkPreferences, sdkPreferenceOptions, validateFlagSettings, customPrompt, safeName, stringList };
