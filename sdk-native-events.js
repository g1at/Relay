'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanPackage } = require('./skill-draft-service');

const text = (value, max = 1000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max) : '';
const name = value => text(value, 160);
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const diagnosticTypes = new Set(['control_request_progress', 'hook_started', 'hook_progress', 'hook_response', 'plugin_install', 'worker_shutting_down', 'commands_changed']);
function nativeWorkingDirectory(input = {}) {
  if (input.agent_id) return null;
  const candidate = ['SessionStart','CwdChanged'].includes(input.hook_event_name) ? input.new_cwd || input.cwd
    : input.hook_event_name === 'PostToolUse' && input.tool_name === 'EnterWorktree' ? input.tool_response?.worktreePath
    : input.hook_event_name === 'PostToolUse' && input.tool_name === 'ExitWorktree' ? input.tool_response?.originalCwd : null;
  return typeof candidate === 'string' && candidate.length <= 8192 && !/[\x00-\x1f]/.test(candidate)
    && (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) ? candidate : null;
}
function contextSnapshot(value) {
  const categories = Array.isArray(value?.categories) ? value.categories : [];
  return { model: name(value?.model), total_tokens: finite(value?.total_tokens), raw_max_tokens: finite(value?.raw_max_tokens),
    percentage: finite(value?.percentage), sampledAt: new Date().toISOString(),
    categories: categories.slice(0, 32).filter(row => row && ['used', 'free', 'buffer', 'deferred'].includes(row.kind))
      .map(row => ({ name: name(row.name), kind: row.kind, tokens: finite(row.tokens) })) };
}
function sanitizeNativeEvent(event) {
  if (!event || event.type !== 'system' || !/^hook_(started|progress|response)$/.test(event.subtype || '')) return event;
  // Hook stdout may include command input and secrets. Show lifecycle only.
  const { stdout, stderr, output, ...safe } = event;
  return { ...safe, stdout: '', stderr: '', output: '', relay_output_bytes: Buffer.byteLength(String(stdout || '') + String(stderr || '') + String(output || '')) };
}
class NativeEventState {
  constructor(limit = 64) { this.limit = limit; this.records = new Map(); this.revision = 0; this.context = null; this.session = {}; this.failure = null; }
  put(key, value) {
    this.records.delete(key); this.records.set(key, value);
    while (this.records.size > this.limit) this.records.delete(this.records.keys().next().value);
  }
  hook(input = {}) {
    const kind = name(input.hook_event_name);
    const row = { kind, agentId: name(input.agent_id), source: name(input.source), at: new Date().toISOString() };
    if (kind === 'SessionStart') Object.assign(row, { model: name(input.model), cacheExpired: input.prompt_cache_likely_expired === true,
      contextTokens: finite(input.context_tokens), sinceLastResponseSeconds: finite(input.seconds_since_last_response) });
    if (kind === 'StopFailure') { row.error = name(input.error); this.failure = row; }
    if (kind === 'ConfigChange') this.revision++;
    if (kind === 'Elicitation') row.server = name(input.mcp_server_name);
    this.put(`hook:${kind}:${row.agentId}:${row.source}`, row);
    return row;
  }
  observe(event = {}) {
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      // Context snapshots are not billed usage; no addition to profile totals.
      if (event.context_usage) this.context = contextSnapshot(event.context_usage);
    }
    if (event.type !== 'system') return;
    if (event.subtype === 'init') this.session = { apiKeySource: name(event.apiKeySource), betas: (Array.isArray(event.betas) ? event.betas : []).map(name).slice(0, 32), outputStyle: name(event.output_style) };
    if (event.subtype === 'thinking_tokens' && !event.parent_tool_use_id && !event.agent_id) this.put('thinking-progress', {kind:'thinking_tokens', estimatedTokens:finite(event.estimated_tokens), delta:finite(event.estimated_tokens_delta), userMessageId:name(event.user_message_uuid), sampledAt:new Date().toISOString()});
    if (event.subtype === 'commands_changed') this.revision++;
    if (diagnosticTypes.has(event.subtype)) this.put(`${event.subtype.replace(/hook_.*/, 'hook')}:${name(event.hook_id || event.request_id || event.name || event.uuid)}`, {
      kind: event.subtype, name: name(event.hook_name || event.name), event: name(event.hook_event), status: name(event.outcome || event.status),
      attempt: finite(event.attempt), delayMs: finite(event.retry_delay_ms), outputBytes: finite(event.relay_output_bytes),
      exitCode: Number.isInteger(event.exit_code) ? event.exit_code : null, reason: name(event.reason), at: new Date().toISOString(),
    });
  }
  snapshot() { return structuredClone({ revision: this.revision, records: [...this.records.values()], session: this.session, context: this.context, failure: this.failure }); }
}
function safeFindings(input) {
  return (Array.isArray(input?.findings) ? input.findings : []).slice(0, 32).flatMap(item => {
    if (!item || typeof item.file !== 'string' || !item.summary || item.file.length > 2048 || /[\x00-\x1f]/.test(item.file)
        || path.posix.isAbsolute(item.file) || path.win32.isAbsolute(item.file) || /^[a-z]:/i.test(item.file)
        || item.file.split(/[\\/]/).some(p => p === '..')) return [];
    return [{ file: item.file.replace(/\\/g, '/'), line: Number.isSafeInteger(item.line) && item.line > 0 ? item.line : null,
      summary: text(item.summary, 2000), shortSummary: text(item.short_summary, 120), scenario: text(item.failure_scenario, 4000),
      category: name(item.category), verdict: ['CONFIRMED', 'PLAUSIBLE'].includes(item.verdict) ? item.verdict : null,
      outcome: ['fixed', 'skipped', 'no_change_needed'].includes(item.outcome) ? item.outcome : null }];
  });
}
function stageSkillProposals(input, { service, skillsDir, stagingRoot, sourceRef, onDraft } = {}) {
  if (!service || !Array.isArray(input?.proposals) || input.proposals.length > 3) throw new Error('技能建议格式无效');
  const drafts = [];
  for (const proposal of input.proposals) {
    const skillName = proposal.kind === 'improvement' ? proposal.target : proposal.name;
    if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(skillName || '') || !['new', 'improvement'].includes(proposal.kind)
        || !proposal.description || proposal.description.length > 1024 || typeof proposal.skillMd !== 'string' || proposal.skillMd.length > 200000) throw new Error('技能建议的名称或内容无效');
    const existing = path.join(skillsDir, skillName);
    if (proposal.kind === 'improvement' && !fs.existsSync(path.join(existing, 'SKILL.md'))) throw new Error('建议修改的技能已不存在');
    if (proposal.kind === 'new' && fs.existsSync(existing)) throw new Error('同名技能已经存在，请改用更新建议');
    const temp = path.join(stagingRoot, crypto.randomUUID());
    try {
      fs.mkdirSync(temp, { recursive: true });
      // Preserve resources for an improvement. The draft service validates the
      // copied tree and detects symlinks/conflicts before publication.
      if (proposal.kind === 'improvement') {
        scanPackage(existing); // Reject links before writing any copied SKILL.md.
        fs.cpSync(existing, temp, { recursive: true, dereference: false });
        scanPackage(temp); // Also catch a directory changed during the copy.
      }
      const body = proposal.skillMd.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      fs.writeFileSync(path.join(temp, 'SKILL.md'), `---\nname: ${skillName}\ndescription: ${JSON.stringify(proposal.description)}\n---\n\n${body}`);
      const draft = service.createDraft({ skillName, stagingDir: temp, sourceRef, note: 'SDK 技能建议，审核后才会发布。' });
      drafts.push(draft); onDraft?.(draft);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return drafts;
}
module.exports = { NativeEventState, sanitizeNativeEvent, safeFindings, stageSkillProposals, nativeWorkingDirectory };
