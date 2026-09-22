'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const MAX_AGENT_BYTES = 512 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parseAgentDocument(text, fallbackName = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_AGENT_BYTES) throw failure('INVALID_AGENT_DOCUMENT', 'Agent 定义过大或内容无效。');
  const source = text.replace(/^\uFEFF/, '');
  let metadata = {}, body = source;
  const frontmatter = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (frontmatter) {
    try { metadata = yaml.load(frontmatter[1], { schema: yaml.JSON_SCHEMA, json: false }) || {}; }
    catch (_) { throw failure('INVALID_AGENT_FRONTMATTER', 'Agent 的 YAML 配置无法解析，请检查字段、缩进和重复项。'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure('INVALID_AGENT_FRONTMATTER', 'Agent 配置应为字段列表。');
    body = source.slice(frontmatter[0].length);
  } else if (/^---(?:\s|$)/.test(source)) throw failure('INVALID_AGENT_FRONTMATTER', 'Agent 的 YAML 配置缺少结束分隔线。');
  const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  if (!name || name.length > 160 || /[\x00-\x1f/\\]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw failure('INVALID_AGENT_NAME', 'Agent 名称无效。');
  const prompt = body.trim() || (typeof metadata.prompt === 'string' ? metadata.prompt.trim() : '');
  if (!prompt) throw failure('EMPTY_AGENT_PROMPT', 'Agent 定义缺少任务说明。');
  return { name, metadata, prompt, description: typeof metadata.description === 'string' && metadata.description.trim() ? metadata.description.trim() : `使用 ${name} 完成用户任务。` };
}
function stringList(value, key) {
  if (value == null) return undefined;
  const list = typeof value === 'string' ? value.split(/,(?![^()]*\))/).map(item => item.trim()).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length > 128 || list.some(item => typeof item !== 'string' || !item.trim() || item.length > 300 || /[\x00-\x1f]/.test(item))) throw failure('INVALID_AGENT_FIELD', `Agent 的 ${key} 必须是名称列表。`);
  return [...new Set(list.map(item => item.trim()))];
}
function buildNativeAgent({ text, name, selectedModel, effort, modelMap = {}, allowedModels = [], modelCapabilities = [], mcpServerNames = [], resourceRoot, parentInstructions = '', inheritedDisallowedTools = [] } = {}) {
  const parsed = parseAgentDocument(text, name);
  const meta = parsed.metadata;
  const definition = { description: parsed.description, prompt: parsed.prompt, model: 'inherit' };
  for (const field of ['tools', 'skills']) { const list = stringList(meta[field], field); if (list) definition[field] = list; }
  const disallowed = stringList(meta.disallowedTools ?? meta['disallowed-tools'], 'disallowedTools') || [];
  if (disallowed.length || inheritedDisallowedTools.length) definition.disallowedTools = [...new Set([...disallowed, ...inheritedDisallowedTools])];
  if (meta.maxTurns != null || meta['max-turns'] != null) {
    const value = meta.maxTurns ?? meta['max-turns'];
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw failure('INVALID_AGENT_FIELD', 'Agent 的 maxTurns 必须是 1 至 10000 之间的整数。');
    definition.maxTurns = value;
  }
  if (meta.model && meta.model !== 'inherit') {
    const target = modelMap[meta.model] || meta.model;
    if (typeof target !== 'string' || ![selectedModel, ...allowedModels].includes(target)) throw failure('AGENT_MODEL_ROUTE_MISMATCH', 'Agent 指定的模型未配置在当前服务商中，请修改 Agent 模型或切换服务商。');
    definition.model = target === selectedModel ? 'inherit' : target;
  }
  const agentEffort = meta.effort ?? effort;
  if (agentEffort != null && !['inherit', 'low', 'medium', 'high', 'xhigh', 'max'].includes(agentEffort)) throw failure('INVALID_AGENT_FIELD', 'Agent 推理强度无效。');
  const effectiveModel = definition.model === 'inherit' ? selectedModel : definition.model;
  const capability = modelCapabilities.find(item => item.value === effectiveModel || item.resolvedModel === effectiveModel);
  const unsupportedEffort = capability && (capability.supportsEffort === false || capability.supportedEffortLevels?.length && !capability.supportedEffortLevels.includes(agentEffort));
  if (meta.effort && meta.effort !== 'inherit' && unsupportedEffort) throw failure('AGENT_EFFORT_UNSUPPORTED', 'Agent 指定的推理强度不受当前模型支持，请调整 Agent 配置。');
  if (agentEffort && agentEffort !== 'inherit' && !unsupportedEffort) definition.effort = agentEffort;
  if (meta.background !== undefined) {
    if (typeof meta.background !== 'boolean') throw failure('INVALID_AGENT_FIELD', 'Agent background 必须为 true 或 false。');
    definition.background = meta.background;
  }
  const servers = stringList(meta.mcpServers ?? meta['mcp-servers'], 'mcpServers');
  if (servers) {
    if (servers.some(server => !mcpServerNames.includes(server))) throw failure('AGENT_MCP_UNAVAILABLE', 'Agent 指定的 MCP 尚未配置或未启用。');
    definition.mcpServers = servers;
  }
  // Prompt replacement must preserve the host's memory, plan and product
  // constraints. Explicit model/background options above stay within the host's
  // provider and task lifecycle. Imports cannot change credentials, permission
  // mode, or add an independent initial/observer workload.
  if (parentInstructions.trim()) definition.prompt += `\n\n---\n[Relay 会话规则]\n${parentInstructions.trim()}`;
  if (resourceRoot) {
    if (typeof resourceRoot !== 'string' || resourceRoot.includes('\0') || (!path.isAbsolute(resourceRoot) && !path.win32.isAbsolute(resourceRoot))) throw failure('INVALID_AGENT_RESOURCE_ROOT', 'Agent 资源目录必须为绝对路径。');
    definition.prompt += `\n\n[Agent 资源目录]\n随包资源位于：${resourceRoot}\n读取随包资源请使用此目录的绝对路径。交付文件写入当前会话工作目录。`;
  }
  const ignoredFields = ['permissionMode', 'permission-mode', 'memory', 'initialPrompt', 'initial-prompt', 'observer', 'observerMessage', 'hooks']
    .filter(key => Object.hasOwn(meta, key));
  // Default explicitly to inherit: omission may select a separately configured
  // subagent model. An explicit model above must belong to the current provider.
  const options = { agent: parsed.name, agents: { [parsed.name]: definition } };
  return { ...options, fingerprint: hash({ options, selectedModel: selectedModel || null, resourceRoot: resourceRoot || null }), ignoredFields };
}
function loadNativeAgent({ agentsDir, agentName, ...options }) {
  if (!agentName || typeof agentName !== 'string') throw failure('INVALID_AGENT_NAME', '请选择 Agent。');
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isFile() && /\.md$/i.test(entry.name));
  const matches = [], legacyMatches = [];
  for (const entry of entries) {
    const file = path.join(agentsDir, entry.name);
    if (fs.statSync(file).size > MAX_AGENT_BYTES) continue;
    const text = fs.readFileSync(file, 'utf8');
    let parsed;
    try { parsed = parseAgentDocument(text, entry.name.replace(/\.md$/i, '')); }
    catch (error) { if (entry.name.replace(/\.md$/i, '') === agentName) throw error; continue; }
    if (parsed.name === agentName) matches.push({ text, name: parsed.name });
    else if (entry.name.replace(/\.md$/i, '') === agentName) legacyMatches.push({ text, name: parsed.name });
  }
  if (!matches.length) matches.push(...legacyMatches);
  if (!matches.length) throw failure('AGENT_NOT_FOUND', `找不到 Agent「${agentName}」。`);
  if (matches.length > 1) throw failure('DUPLICATE_AGENT_NAME', `多个 Agent 使用名称「${agentName}」，请先修改重复名称。`);
  return buildNativeAgent({ ...options, ...matches[0] });
}

module.exports = { MAX_AGENT_BYTES, parseAgentDocument, buildNativeAgent, loadNativeAgent };
