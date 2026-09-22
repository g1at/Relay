'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeElicitationSchema, validateElicitationContent, normalizeElicitationUrl } = require('./elicitation-schema');
const { requiresMcpApproval } = require('../sdk/sdk-mcp-permissions');

// SDK 0.3.250 contract notes (sdk.d.ts + sdk.mjs):
// - canUseTool may park without a deadline, and returning null means the host already replied
//   out-of-band. Relay never returns null; every path resolves to an allow/deny PermissionResult.
// - requestId can be redelivered after reconnect, so it is the idempotency key. toolUseID identifies
//   the actual tool call. The SDK also overwrites toolUseID on the final control response.
// - AskUserQuestion is answered by allowing the tool with updatedInput.answers, keyed by the exact
//   question text. Multi-select answers are comma-separated strings.

const INTERACTION_SCHEMA_VERSION = 1;

const INTERACTION_KINDS = Object.freeze({
  QUESTION: 'question',
  PERMISSION: 'permission',
  ELICITATION: 'elicitation',
});

const INTERACTION_EVENTS = Object.freeze({
  PENDING: 'interaction.pending',
  RESOLVED: 'interaction.resolved',
  ELICITATION_COMPLETE: 'interaction.elicitation_complete',
});

const PERMISSION_ACTIONS = Object.freeze({
  ALLOW_ONCE: 'allow_once',
  ALLOW_SESSION: 'allow_session',
  ALLOW_SUGGESTED: 'allow_suggested',
  DENY: 'deny',
});

const QUESTION_ACTIONS = Object.freeze({
  SUBMIT: 'submit',
  DENY: 'deny',
});

const PERMISSION_UPDATE_TYPES = new Set([
  'addRules',
  'replaceRules',
  'removeRules',
  'setMode',
  'addDirectories',
  'removeDirectories',
]);
const PERMISSION_DESTINATIONS = new Set([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
]);
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask']);
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

const APP_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

function isAppPermissionMode(value) {
  return APP_PERMISSION_MODES.has(value);
}

function normalizeAppPermissionMode(value, options = {}) {
  if (isAppPermissionMode(value)) return value;
  // 旧版 Relay 在 app-settings 不存在 permissionMode 时实际使用全部放行；
  // 只有真正的新安装才采用新的逐项确认默认值。
  if (options.hasExistingSettings && (value == null || value === '')) {
    return 'bypassPermissions';
  }
  return 'default';
}

// 后台权限必须由调用点显式声明。普通定时任务由 scheduler 传 bypassPermissions，
// 表示用户保存/启用任务时已经完成一次性授权；内置受限任务可传 default/plan，
// 再配合自己的 canUseTool 守卫。遗漏或非法值一律回退 default，避免未来新增的
// background 调用点仅因忘记声明就自动获得全部权限。
function resolveUnattendedPermissionMode(value) {
  return isAppPermissionMode(value) ? value : 'default';
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SETTLED_REQUESTS = 256;

class InteractionBrokerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'InteractionBrokerError';
    this.code = code;
    this.details = details;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

// Renderer never receives SDK signals, promise resolvers, prototypes, or unbounded/cyclic input.
// This is a display clone only; authoritative SDK objects stay private inside the broker.
function sanitizeForRenderer(value, options = {}, state = null) {
  const limits = {
    maxDepth: Number.isSafeInteger(options.maxDepth) ? options.maxDepth : 8,
    maxArrayLength: Number.isSafeInteger(options.maxArrayLength) ? options.maxArrayLength : 100,
    maxObjectKeys: Number.isSafeInteger(options.maxObjectKeys) ? options.maxObjectKeys : 100,
    maxStringLength: Number.isSafeInteger(options.maxStringLength) ? options.maxStringLength : 32_000,
  };
  const current = state || { depth: 0, seen: new WeakSet(), limits };

  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value !== 'number' ? value : String(value);
  }
  if (typeof value === 'string') {
    if (value.length <= current.limits.maxStringLength) return value;
    return `${value.slice(0, current.limits.maxStringLength)}\n…（内容已截断）`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (current.depth >= current.limits.maxDepth) return '…（层级过深）';
  if (current.seen.has(value)) return '…（循环引用）';
  current.seen.add(value);

  try {
    if (value instanceof Date) return isoTime(value);
    if (Buffer.isBuffer(value)) return `[二进制数据：${value.length} 字节]`;
    if (value instanceof Error) {
      return {
        name: optionalString(value.name) || 'Error',
        message: optionalString(value.message) || '',
      };
    }

    const nextState = {
      depth: current.depth + 1,
      seen: current.seen,
      limits: current.limits,
    };
    if (Array.isArray(value)) {
      return value.slice(0, current.limits.maxArrayLength).map((item) => {
        const sanitized = sanitizeForRenderer(item, {}, nextState);
        return sanitized === undefined ? null : sanitized;
      });
    }

    const result = {};
    const keys = Object.keys(value).slice(0, current.limits.maxObjectKeys);
    for (const key of keys) {
      // Avoid creating magic properties when DTOs are later merged in renderer code.
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      let child;
      try { child = value[key]; } catch (_) { child = '…（无法读取）'; }
      const sanitized = sanitizeForRenderer(child, {}, nextState);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  } finally {
    current.seen.delete(value);
  }
}

function copyPermissionUpdate(update, destinationOverride = null) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  if (!PERMISSION_UPDATE_TYPES.has(update.type)) return null;
  if (!PERMISSION_DESTINATIONS.has(update.destination)) return null;
  const destination = destinationOverride || update.destination;
  if (!PERMISSION_DESTINATIONS.has(destination)) return null;

  if (update.type === 'setMode') {
    if (!PERMISSION_MODES.has(update.mode)) return null;
    return { type: update.type, mode: update.mode, destination };
  }

  if (update.type === 'addDirectories' || update.type === 'removeDirectories') {
    if (!Array.isArray(update.directories) || update.directories.length === 0) return null;
    const directories = update.directories.filter((item) => typeof item === 'string');
    if (directories.length !== update.directories.length) return null;
    return { type: update.type, directories: [...directories], destination };
  }

  if (!Array.isArray(update.rules) || update.rules.length === 0
    || !PERMISSION_BEHAVIORS.has(update.behavior)) return null;
  const rules = update.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const toolName = nonEmptyString(rule.toolName);
    if (!toolName) return null;
    const copied = { toolName };
    if (typeof rule.ruleContent === 'string') copied.ruleContent = rule.ruleContent;
    return copied;
  });
  if (rules.some((rule) => !rule)) return null;
  return { type: update.type, rules, behavior: update.behavior, destination };
}

function copyPermissionSuggestions(value, destinationOverride = null) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const copied = value.map((item) => copyPermissionUpdate(item, destinationOverride));
  return copied.every(Boolean) ? copied : [];
}

function normalizeQuestions(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return null;
  if (input.questions.length < 1 || input.questions.length > 4) return null;
  const questions = input.questions.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const question = nonEmptyString(item.question);
    const header = nonEmptyString(item.header);
    if (!question || !header || !Array.isArray(item.options)) return null;
    if (item.options.length < 2 || item.options.length > 4) return null;
    const options = item.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const label = nonEmptyString(option.label);
      if (!label || typeof option.description !== 'string') return null;
      const copied = { label, description: option.description };
      if (typeof option.preview === 'string') copied.preview = option.preview;
      return copied;
    });
    if (options.some((option) => !option)) return null;
    return {
      question,
      header,
      options,
      multiSelect: item.multiSelect === true,
    };
  });
  if (questions.some((question) => !question)) return null;
  if (new Set(questions.map((question) => question.question)).size !== questions.length) return null;
  return questions;
}

function normalizeAnswers(questions, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractionBrokerError('INVALID_ANSWERS', '请回答所有问题');
  }
  const answers = {};
  for (const question of questions) {
    let answer = value[question.question];
    if (Array.isArray(answer)) {
      if (!question.multiSelect || answer.some((item) => typeof item !== 'string')) {
        throw new InteractionBrokerError(
          'INVALID_ANSWER',
          `“${question.question}”的答案格式无效`,
        );
      }
      answer = answer.map((item) => item.trim()).filter(Boolean).join(', ');
    }
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new InteractionBrokerError(
        'MISSING_ANSWER',
        `请回答“${question.question}”`,
        { question: question.question },
      );
    }
    // AskUserQuestionOutput requires question text -> string; multi-select uses commas.
    answers[question.question] = answer.trim();
  }
  return answers;
}

function denialResult(entry, message, interrupt = false) {
  return {
    behavior: 'deny',
    message: nonEmptyString(message) || '用户未允许此操作',
    interrupt: interrupt === true,
    ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
    decisionClassification: 'user_reject',
  };
}

// These are only used to reconcile prompts already waiting when the user
// changes the conversation's mode. New tools still go through SDK policy.
function permissionPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  if (process.platform === 'win32') value = value.replace(/^\/mnt\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':\\');
  return path.resolve(value);
}
function canonicalPermissionPath(value) {
  const target = permissionPath(value);
  if (!target) return null;
  let parent = target;
  for (;;) {
    try { return path.resolve(fs.realpathSync(parent), path.relative(parent, target)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      const next = path.dirname(parent); if (next === parent) return null; parent = next;
    }
  }
}
function permissionWithin(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function independentMcpApproval(entry, options = {}) {
  return entry.mcpApprovalRequired || requiresMcpApproval(entry.toolName, entry.mcpPermissionOverrides)
    || requiresMcpApproval(entry.toolName, options.mcpPermissionOverrides);
}
function modeAllowsPendingPermission(entry, options) {
  if (entry.kind !== INTERACTION_KINDS.PERMISSION || entry.matchedAskRule
      || entry.decisionReason || independentMcpApproval(entry, options)
      || ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].includes(entry.toolName)) return false;
  // blockedPath identifies a requested path, not a permanent deny rule. The
  // native SDK also sets it for ordinary Bash redirects inside the workspace.
  // Explicit full access covers these parked path prompts; acceptEdits below
  // still limits automatic approval to actual file edits in granted paths.
  if (options.permissionMode === 'bypassPermissions') return true;
  if (options.permissionMode !== 'acceptEdits' || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(entry.toolName)) return false;
  const raw = entry.input.file_path || entry.input.notebook_path;
  if (typeof raw !== 'string' || !raw || !options.cwd) return false;
  // SDK continues to ask about protected configuration and out-of-scope paths
  // in acceptEdits. A mode change must not turn those prompts into broad grants.
  if (/(^|[\\/])(?:\.git|\.claude|\.vscode)(?:[\\/]|$)/i.test(raw)
      || /(^|[\\/])(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|\.gitconfig)$/i.test(raw)) return false;
  const cwd = permissionPath(options.cwd);
  const requested = path.isAbsolute(raw) || process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(raw)
    ? raw : path.resolve(cwd, raw);
  const file = canonicalPermissionPath(requested);
  if (!file || /(^|[\\/])(?:\.git|\.claude|\.vscode)(?:[\\/]|$)/i.test(file)) return false;
  const roots = [options.cwd, ...(options.additionalDirectories || [])].map(canonicalPermissionPath).filter(Boolean);
  if (!roots.some(root => permissionWithin(file, root))) return false;
  if (!entry.blockedPath) return true;
  const blocked = canonicalPermissionPath(path.isAbsolute(entry.blockedPath) || process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(entry.blockedPath)
    ? entry.blockedPath : path.resolve(cwd, entry.blockedPath));
  return !!blocked && roots.some(root => permissionWithin(blocked, root));
}

class InteractionBroker {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => `interaction-${crypto.randomUUID()}`;
    this.setTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.clearTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs) && options.defaultTimeoutMs >= 0
      ? options.defaultTimeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxSettledRequests = Number.isSafeInteger(options.maxSettledRequests)
      && options.maxSettledRequests >= 0
      ? options.maxSettledRequests
      : MAX_SETTLED_REQUESTS;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.logger = options.logger || console;
    this.pending = new Map();
    this.byRequestId = new Map();
    this.settledByRequestId = new Map();
    this.urlElicitations = new Map();
  }

  get size() {
    return this.pending.size;
  }

  createCanUseTool(context = {}) {
    const contextFactory = typeof context === 'function' ? context : () => context;
    return (toolName, input, sdkOptions) => this.registerToolUse({
      toolName,
      input,
      sdkOptions,
      context: contextFactory(toolName, input, sdkOptions) || {},
    });
  }

  createOnElicitation(context = {}) {
    const contextFactory = typeof context === 'function' ? context : () => context;
    return (request, sdkOptions) => this.registerElicitation({ request, sdkOptions,
      context: contextFactory(request, sdkOptions) || {} });
  }

  registerElicitation({ request, sdkOptions = {}, context = {}, timeoutMs } = {}) {
    // A scope-less or unattended request cannot display a decision in another
    // conversation/window. Never return null: the SDK must receive a response.
    const conversationId = optionalString(context.conversationId) || optionalString(context.convId);
    const runId = optionalString(context.runId) || optionalString(context.taskId);
    const windowId = context.windowId == null ? null : String(context.windowId);
    if (!conversationId || !runId || windowId == null || context.background === true
        || !request || !nonEmptyString(request.serverName) || typeof request.message !== 'string') {
      return Promise.resolve({ action: 'cancel' });
    }
    const requestId = nonEmptyString(sdkOptions.requestId);
    const requestKey = requestId ? JSON.stringify(['elicitation', windowId, conversationId, runId, requestId]) : null;
    const active = requestKey && this.pending.get(this.byRequestId.get(requestKey));
    if (active) return active.promise;
    if (requestKey && this.settledByRequestId.has(requestKey)) return Promise.resolve(this.settledByRequestId.get(requestKey));
    const signal = sdkOptions.signal;
    if (signal?.aborted) return Promise.resolve({ action: 'cancel' });
    let schema = null, url = null, unsupported = null;
    const mode = request.mode || 'form';
    try {
      if (mode === 'form') schema = normalizeElicitationSchema(request.requestedSchema);
      else if (mode === 'url') {
        if (!nonEmptyString(request.elicitationId)) throw new Error('工具未提供网页请求标识');
        url = normalizeElicitationUrl(request.url);
      } else throw new Error('暂不支持此工具交互方式');
    } catch (error) { unsupported = error.message; }
    const id = nonEmptyString(this.idFactory()) || `interaction-${crypto.randomUUID()}`;
    if (this.pending.has(id)) return Promise.resolve({ action: 'cancel' });
    const createdAt = isoTime(this.now());
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs
      : Number.isFinite(context.timeoutMs) && context.timeoutMs >= 0 ? context.timeoutMs : this.defaultTimeoutMs;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { id, kind: INTERACTION_KINDS.ELICITATION, state: 'pending', createdAt,
      expiresAt: isoTime(new Date(new Date(createdAt).getTime() + effectiveTimeout)),
      runId, conversationId, windowId, source: optionalString(context.source), requestId, requestKey,
      toolName: request.serverName, elicitation: { mode, serverName: request.serverName,
        message: request.message, title: optionalString(request.title), displayName: optionalString(request.displayName),
        description: optionalString(request.description), elicitationId: optionalString(request.elicitationId), url, schema, unsupported },
      resolve, promise, timer: null, signal: signal && typeof signal.addEventListener === 'function' ? signal : null, onAbort: null };
    this.pending.set(id, entry);
    if (requestKey) this.byRequestId.set(requestKey, id);
    entry.onAbort = () => this._settle(entry, { action: 'cancel' }, { action: 'cancel', reason: 'abort_signal' });
    entry.signal?.addEventListener('abort', entry.onAbort, { once: true });
    if (entry.signal?.aborted) { entry.onAbort(); return promise; }
    entry.timer = this.setTimeout(() => this._settle(entry, { action: 'cancel' }, { action: 'cancel', reason: 'timeout' }), effectiveTimeout);
    entry.timer?.unref?.();
    this._emit({ type: INTERACTION_EVENTS.PENDING, interaction: this._toDto(entry) });
    return promise;
  }

  completeElicitation(message, context = {}) {
    if (message?.type !== 'system' || message.subtype !== 'elicitation_complete'
        || !context.runId || !context.conversationId) return false;
    // The SDK supplies server+elicitation ids; the host supplies the authoritative
    // current run. The same server-side id can exist in another conversation.
    let completed = false;
    const matches = entry => entry.runId === String(context.runId) && entry.conversationId === String(context.conversationId)
      && (context.windowId == null || entry.windowId === String(context.windowId))
      && entry.elicitation?.mode === 'url' && entry.elicitation.serverName === message.mcp_server_name
      && entry.elicitation.elicitationId === message.elicitation_id;
    // A very fast local callback may arrive before browser creation resolves.
    // Remember that notification without approving a still-visible request.
    for (const entry of this.pending.values()) {
      if (entry.kind === INTERACTION_KINDS.ELICITATION && matches(entry)) { entry.serverCompleted = true; completed = true; }
    }
    for (const [id, entry] of this.urlElicitations) {
      if (!matches(entry)) continue;
      this.urlElicitations.delete(id);
      this._emit({ type: INTERACTION_EVENTS.ELICITATION_COMPLETE, interaction: this._toDto(entry),
        resolution: { action: 'completed', reason: 'server_notification' } });
      completed = true;
    }
    return completed;
  }

  registerToolUse({ toolName, input, sdkOptions = {}, context = {}, timeoutMs } = {}) {
    const normalizedToolName = nonEmptyString(toolName);
    if (!normalizedToolName) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'SDK 未提供有效的工具名称',
        decisionClassification: 'user_reject',
      });
    }

    const requestId = nonEmptyString(sdkOptions && sdkOptions.requestId);
    if (requestId) {
      const activeId = this.byRequestId.get(requestId);
      if (activeId) {
        const active = this.pending.get(activeId);
        if (active) return active.promise;
        this.byRequestId.delete(requestId);
      }
      if (this.settledByRequestId.has(requestId)) {
        return Promise.resolve(this.settledByRequestId.get(requestId));
      }
    }

    const questions = normalizedToolName === 'AskUserQuestion' ? normalizeQuestions(input) : null;
    if (normalizedToolName === 'AskUserQuestion' && !questions) {
      return Promise.resolve({
        behavior: 'deny',
        message: '模型给出的提问格式无效，请换一种方式说明问题',
        ...(nonEmptyString(sdkOptions.toolUseID) ? { toolUseID: sdkOptions.toolUseID } : {}),
        decisionClassification: 'user_reject',
      });
    }

    const signal = sdkOptions && sdkOptions.signal;
    if (signal && signal.aborted) {
      return Promise.resolve({
        behavior: 'deny',
        message: '任务已停止，未执行等待中的操作',
        ...(nonEmptyString(sdkOptions.toolUseID) ? { toolUseID: sdkOptions.toolUseID } : {}),
        decisionClassification: 'user_reject',
      });
    }

    const createdAt = isoTime(this.now());
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : (Number.isFinite(context.timeoutMs) && context.timeoutMs >= 0
        ? context.timeoutMs
        : this.defaultTimeoutMs);
    const suggestions = copyPermissionSuggestions(sdkOptions && sdkOptions.suggestions);
    const sessionSuggestions = copyPermissionSuggestions(
      sdkOptions && sdkOptions.suggestions,
      'session',
    );
    const id = nonEmptyString(this.idFactory()) || `interaction-${crypto.randomUUID()}`;
    if (this.pending.has(id)) {
      return Promise.resolve({
        behavior: 'deny',
        message: '无法创建交互请求，请稍后重试',
        ...(nonEmptyString(sdkOptions.toolUseID) ? { toolUseID: sdkOptions.toolUseID } : {}),
        decisionClassification: 'user_reject',
      });
    }

    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      id,
      kind: questions ? INTERACTION_KINDS.QUESTION : INTERACTION_KINDS.PERMISSION,
      state: 'pending',
      createdAt,
      expiresAt: isoTime(new Date(new Date(createdAt).getTime() + effectiveTimeout)),
      runId: optionalString(context.runId) || optionalString(context.taskId),
      conversationId: optionalString(context.conversationId) || optionalString(context.convId),
      windowId: context.windowId == null ? null : String(context.windowId),
      source: optionalString(context.source),
      toolName: normalizedToolName,
      toolUseID: nonEmptyString(sdkOptions && sdkOptions.toolUseID),
      requestId,
      agentID: optionalString(sdkOptions && sdkOptions.agentID),
      title: optionalString(sdkOptions && sdkOptions.title),
      displayName: optionalString(sdkOptions && sdkOptions.displayName),
      description: optionalString(sdkOptions && sdkOptions.description),
      decisionReason: optionalString(sdkOptions && sdkOptions.decisionReason),
      blockedPath: optionalString(sdkOptions && sdkOptions.blockedPath),
      matchedAskRule: sanitizeForRenderer(sdkOptions && sdkOptions.matchedAskRule),
      mcpApprovalRequired: sdkOptions.relayMcpApprovalRequired === true,
      mcpPermissionOverrides: sdkOptions.relayMcpPermissionOverrides || context.mcpPermissionOverrides,
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
      questions,
      suggestions,
      sessionSuggestions,
      resolve: resolvePromise,
      promise,
      timer: null,
      signal: signal && typeof signal.addEventListener === 'function' ? signal : null,
      onAbort: null,
    };

    this.pending.set(id, entry);
    if (requestId) this.byRequestId.set(requestId, id);

    // A pre-change control request can arrive after the mode ACK and commit.
    // The host exposes this only for the same live run after persistence; it is
    // cleared while another mode change is in flight and never crosses turns.
    const reconciliation = context.permissionReconciliation;
    if (reconciliation && reconciliation.conversationId === entry.conversationId
        && reconciliation.runId === entry.runId && Number.isSafeInteger(reconciliation.revision)
        && modeAllowsPendingPermission(entry, reconciliation)) {
      this._allowAfterModeChange(entry, reconciliation.permissionMode);
      return promise;
    }

    entry.onAbort = () => {
      this._settle(entry, denialResult(entry, '任务已停止，未执行等待中的操作', true), {
        action: 'aborted',
        reason: 'abort_signal',
      });
    };
    if (entry.signal) entry.signal.addEventListener('abort', entry.onAbort, { once: true });

    entry.timer = this.setTimeout(() => {
      // Timeout is intentionally fail-closed. It can never produce an allow result.
      this._settle(entry, denialResult(entry, '等待回复超时，Relay 已安全拒绝此操作'), {
        action: 'timed_out',
        reason: 'timeout',
      });
    }, effectiveTimeout);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();

    this._emit({ type: INTERACTION_EVENTS.PENDING, interaction: this._toDto(entry) });
    return promise;
  }

  get(id) {
    const entry = this.pending.get(String(id || ''));
    return entry ? this._toDto(entry) : null;
  }

  hasPendingPermission(conversationId) {
    return [...this.pending.values()].some(entry => entry.kind === INTERACTION_KINDS.PERMISSION
      && entry.conversationId === String(conversationId || ''));
  }

  reconcilePermissionMode(options = {}) {
    const conversationId = optionalString(options.conversationId), runId = optionalString(options.runId);
    if (!conversationId || !runId || !['acceptEdits', 'bypassPermissions'].includes(options.permissionMode)) return 0;
    let settled = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.conversationId !== conversationId || entry.runId !== runId || entry.signal?.aborted
          || !modeAllowsPendingPermission(entry, options)) continue;
      if (this._allowAfterModeChange(entry, options.permissionMode)) settled++;
    }
    return settled;
  }

  _allowAfterModeChange(entry, permissionMode) {
    return this._settle(entry, { behavior: 'allow',
      ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}), decisionClassification: 'user_temporary',
    }, { action: PERMISSION_ACTIONS.ALLOW_ONCE, reason: 'permission_mode_changed', permissionMode });
  }

  list(filters = {}) {
    const matches = (entry, key, aliases = []) => {
      const expected = filters[key] ?? aliases.map((alias) => filters[alias]).find((item) => item != null);
      return expected == null || entry[key] === String(expected);
    };
    return [...this.pending.values()]
      .filter((entry) => matches(entry, 'runId', ['taskId']))
      .filter((entry) => matches(entry, 'conversationId', ['convId']))
      .filter((entry) => matches(entry, 'windowId'))
      .filter((entry) => filters.kind == null || entry.kind === filters.kind)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((entry) => this._toDto(entry));
  }

  respond(id, decision = {}) {
    const entry = this._requirePending(id);
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new InteractionBrokerError('INVALID_DECISION', '交互回复格式无效');
    }

    if (entry.kind === INTERACTION_KINDS.ELICITATION) {
      const action = decision.action;
      if (action === 'cancel' || action === 'decline' || action === 'deny') {
        const result = { action: action === 'deny' ? 'decline' : action };
        return this._settle(entry, result, { action: result.action, reason: 'user' });
      }
      if (action !== 'accept') throw new InteractionBrokerError('INVALID_DECISION', '工具表单回复操作无效');
      if (entry.elicitation.unsupported) throw new InteractionBrokerError('UNSUPPORTED_ELICITATION', entry.elicitation.unsupported);
      let result = { action: 'accept' };
      if (entry.elicitation.mode === 'form') {
        try { result.content = validateElicitationContent(entry.elicitation.schema, decision.content); }
        catch (error) { throw new InteractionBrokerError('INVALID_ELICITATION_CONTENT', error.message); }
      } else {
        // This acknowledges the user's choice to continue in a browser. Only
        // elicitation_complete confirms success; accepting is not authentication.
        if (!entry.serverCompleted) this.urlElicitations.set(entry.id, entry);
        while (this.urlElicitations.size > MAX_SETTLED_REQUESTS) this.urlElicitations.delete(this.urlElicitations.keys().next().value);
      }
      const settled = this._settle(entry, result, { action: 'accept', reason: 'user',
        ...(entry.elicitation.mode === 'url' ? { awaitingBrowser: !entry.serverCompleted } : {}) });
      if (settled && entry.serverCompleted) this._emit({ type: INTERACTION_EVENTS.ELICITATION_COMPLETE,
        interaction: this._toDto(entry), resolution: { action: 'completed', reason: 'server_notification' } });
      return settled;
    }

    if (entry.kind === INTERACTION_KINDS.QUESTION) {
      const action = decision.action || QUESTION_ACTIONS.SUBMIT;
      if (action === QUESTION_ACTIONS.DENY) {
        return this._settle(
          entry,
          denialResult(entry, decision.message || '用户取消了这个问题'),
          { action: QUESTION_ACTIONS.DENY, reason: 'user' },
        );
      }
      if (action !== QUESTION_ACTIONS.SUBMIT) {
        throw new InteractionBrokerError('INVALID_DECISION', `提问不支持操作：${String(action)}`);
      }
      // Validate first. A malformed renderer response leaves the request pending so it can be corrected.
      const answers = normalizeAnswers(entry.questions, decision.answers);
      const result = {
        behavior: 'allow',
        updatedInput: { ...entry.input, answers },
        ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
        decisionClassification: 'user_temporary',
      };
      return this._settle(entry, result, { action: QUESTION_ACTIONS.SUBMIT, reason: 'user' });
    }

    const action = decision.action;
    if (action === PERMISSION_ACTIONS.DENY) {
      return this._settle(
        entry,
        denialResult(entry, decision.message || '用户拒绝了此操作', decision.interrupt === true),
        { action: PERMISSION_ACTIONS.DENY, reason: 'user', interrupt: decision.interrupt === true },
      );
    }
    if (action === PERMISSION_ACTIONS.ALLOW_ONCE) {
      return this._settle(entry, {
        behavior: 'allow',
        ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
        decisionClassification: 'user_temporary',
      }, { action: PERMISSION_ACTIONS.ALLOW_ONCE, reason: 'user' });
    }
    if (independentMcpApproval(entry) && [PERMISSION_ACTIONS.ALLOW_SESSION, PERMISSION_ACTIONS.ALLOW_SUGGESTED].includes(action)) {
      throw new InteractionBrokerError('MCP_APPROVAL_REQUIRED', '此 MCP 始终逐项请求批准，请选择仅允许一次');
    }
    if (action === PERMISSION_ACTIONS.ALLOW_SESSION) {
      if (!entry.sessionSuggestions.length) {
        throw new InteractionBrokerError(
          'SESSION_PERMISSION_UNAVAILABLE',
          'SDK 没有提供可用于本会话的权限规则，请选择仅允许一次',
        );
      }
      return this._settle(entry, {
        behavior: 'allow',
        updatedPermissions: entry.sessionSuggestions,
        ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
        decisionClassification: 'user_permanent',
      }, { action: PERMISSION_ACTIONS.ALLOW_SESSION, reason: 'user' });
    }
    if (action === PERMISSION_ACTIONS.ALLOW_SUGGESTED) {
      if (!entry.suggestions.length) {
        throw new InteractionBrokerError(
          'SUGGESTED_PERMISSION_UNAVAILABLE',
          'SDK 没有提供可保存的权限规则，请选择仅允许一次',
        );
      }
      return this._settle(entry, {
        behavior: 'allow',
        updatedPermissions: entry.suggestions,
        ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
        decisionClassification: 'user_permanent',
      }, { action: PERMISSION_ACTIONS.ALLOW_SUGGESTED, reason: 'user' });
    }
    throw new InteractionBrokerError('INVALID_DECISION', `权限审批不支持操作：${String(action)}`);
  }

  deny(id, options = {}) {
    return this.respond(id, {
      action: INTERACTION_KINDS.QUESTION === this._requirePending(id).kind
        ? QUESTION_ACTIONS.DENY
        : PERMISSION_ACTIONS.DENY,
      message: options.message,
      interrupt: options.interrupt,
    });
  }

  rejectTask(runId, options = {}) {
    return this._rejectMatching(
      (entry) => entry.runId === String(runId),
      options.message || '任务已结束，Relay 已拒绝等待中的操作',
      options.interrupt !== false,
      'task_cleanup',
    );
  }

  rejectWindow(windowId, options = {}) {
    return this._rejectMatching(
      (entry) => entry.windowId === String(windowId),
      options.message || '窗口已关闭，Relay 已拒绝等待中的操作',
      options.interrupt === true,
      'window_cleanup',
    );
  }

  rejectAll(options = {}) {
    return this._rejectMatching(
      () => true,
      options.message || 'Relay 正在退出，已拒绝等待中的操作',
      options.interrupt !== false,
      'broker_cleanup',
    );
  }

  close(options = {}) {
    return this.rejectAll(options);
  }

  _rejectMatching(predicate, message, interrupt, reason) {
    for (const [id, entry] of this.urlElicitations) if (predicate(entry)) this.urlElicitations.delete(id);
    const entries = [...this.pending.values()].filter(predicate);
    for (const entry of entries) {
      this._settle(entry, entry.kind === INTERACTION_KINDS.ELICITATION ? { action: 'cancel' } : denialResult(entry, message, interrupt), {
        action: 'rejected',
        reason,
      });
    }
    return entries.length;
  }

  _requirePending(id) {
    const normalizedId = String(id || '');
    const entry = this.pending.get(normalizedId);
    if (!entry) {
      throw new InteractionBrokerError(
        'INTERACTION_NOT_PENDING',
        '这个请求已回复、已取消或已超时',
        { id: normalizedId },
      );
    }
    return entry;
  }

  _settle(entry, result, resolution) {
    if (!entry || this.pending.get(entry.id) !== entry) return false;

    this.pending.delete(entry.id);
    const requestKey = entry.requestKey || entry.requestId;
    if (requestKey && this.byRequestId.get(requestKey) === entry.id) {
      this.byRequestId.delete(requestKey);
    }
    if (entry.timer != null) {
      try { this.clearTimeout(entry.timer); } catch (_) {}
      entry.timer = null;
    }
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener('abort', entry.onAbort); } catch (_) {}
    }

    entry.state = 'resolved';
    entry.resolvedAt = isoTime(this.now());
    entry.resolution = resolution;
    if (requestKey && this.maxSettledRequests > 0) {
      this.settledByRequestId.delete(requestKey);
      this.settledByRequestId.set(requestKey, result);
      while (this.settledByRequestId.size > this.maxSettledRequests) {
        this.settledByRequestId.delete(this.settledByRequestId.keys().next().value);
      }
    }

    const dto = this._toDto(entry);
    try { entry.resolve(result); } catch (_) {}
    this._emit({
      type: INTERACTION_EVENTS.RESOLVED,
      interaction: dto,
      resolution: sanitizeForRenderer(resolution),
    });
    return true;
  }

  _toDto(entry) {
    const common = {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      id: entry.id,
      kind: entry.kind,
      state: entry.state,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ...(entry.resolvedAt ? { resolvedAt: entry.resolvedAt } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.windowId != null ? { windowId: entry.windowId } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      toolName: entry.toolName,
      ...(entry.toolUseID ? { toolUseID: entry.toolUseID } : {}),
      ...(entry.agentID ? { agentID: entry.agentID } : {}),
    };

    if (entry.kind === INTERACTION_KINDS.ELICITATION) return { ...common,
      elicitation: sanitizeForRenderer(entry.elicitation) };

    if (entry.kind === INTERACTION_KINDS.QUESTION) {
      return {
        ...common,
        question: {
          questions: sanitizeForRenderer(entry.questions),
        },
      };
    }

    const destinations = [...new Set(entry.suggestions.map((item) => item.destination))];
    return {
      ...common,
      permission: {
        title: entry.title || null,
        displayName: entry.displayName || entry.toolName,
        description: entry.description || null,
        decisionReason: entry.decisionReason || null,
        blockedPath: entry.blockedPath || null,
        matchedAskRule: sanitizeForRenderer(entry.matchedAskRule),
        input: sanitizeForRenderer(entry.input),
        canAllowForSession: !independentMcpApproval(entry) && entry.sessionSuggestions.length > 0,
        canApplySuggestedPermissions: !independentMcpApproval(entry) && entry.suggestions.length > 0,
        suggestedDestinations: independentMcpApproval(entry) ? [] : destinations,
      },
    };
  }

  _emit(event) {
    try { this.onChange(event); } catch (error) {
      try {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('[interaction-broker] onChange 失败: %s', error && error.message);
        }
      } catch (_) {}
    }
  }
}

module.exports = {
  INTERACTION_SCHEMA_VERSION,
  INTERACTION_KINDS,
  INTERACTION_EVENTS,
  PERMISSION_ACTIONS,
  QUESTION_ACTIONS,
  DEFAULT_TIMEOUT_MS,
  InteractionBrokerError,
  InteractionBroker,
  sanitizeForRenderer,
  copyPermissionSuggestions,
  normalizeQuestions,
  normalizeAnswers,
  isAppPermissionMode,
  normalizeAppPermissionMode,
  resolveUnattendedPermissionMode,
};
