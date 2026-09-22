'use strict';

const path = require('node:path');
const { resourcePath, unpackPath } = require('../app/paths');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { validDistribution } = require('./sdk-task-resources');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,159}$/i;
const OPERATIONS = new Set(['listSessions', 'getSessionInfo', 'getSessionMessages', 'listSubagents', 'getSubagentMessages', 'forkSession', 'deleteSession', 'renameSession']);
const PAGE_SIZE = 30;
const fail = (code, message) => Object.assign(new Error(message), { code });
function requirePath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)
      || !(path.posix.isAbsolute(value) || path.win32.isAbsolute(value))) throw fail('SESSION_SCOPE_INVALID', '没有可用的会话存储位置。');
  return value;
}
function linuxPath(value) {
  requirePath(value);
  if (/^[a-z]:[\\/]/i.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replace(/\\/g, '/')}`;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  throw fail('SESSION_ENVIRONMENT_UNAVAILABLE', '无法映射这个会话的 WSL 存储位置。');
}
function validateScope(scope, { listing = false } = {}) {
  if (!scope || !listing && !UUID.test(scope.sessionId || '')) throw fail('SESSION_SCOPE_INVALID', '这条记录没有有效的原生会话标识。');
  requirePath(scope.cwd); requirePath(scope.configDir);
  if (!['native', 'wsl'].includes(scope.agentEnvironment)) throw fail('SESSION_SCOPE_INVALID', '这条记录没有有效的运行环境。');
  if (scope.agentEnvironment === 'wsl' && !validDistribution(scope.wslDistribution)) throw fail('SESSION_ENVIRONMENT_UNAVAILABLE', '这条记录未保存 WSL 发行版，无法准确定位原生历史。');
  return scope;
}
function operationArgs(operation, value = {}) {
  if (!OPERATIONS.has(operation)) throw fail('SESSION_OPERATION_INVALID', '不支持的会话操作。');
  const args = {};
  if (['listSessions', 'getSessionMessages', 'getSubagentMessages'].includes(operation)) {
    args.offset = Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
    args.limit = Number.isSafeInteger(value.limit) && value.limit > 0 ? Math.min(value.limit, 101) : PAGE_SIZE;
  }
  if (operation === 'getSessionMessages' && value.includeSystemMessages === true) args.includeSystemMessages = true;
  if (operation === 'getSubagentMessages') {
    if (!AGENT_ID.test(value.agentId || '')) throw fail('SUBAGENT_INVALID', '子 Agent 标识无效。');
    args.agentId = value.agentId;
  }
  if (operation === 'forkSession') {
    if (value.upToMessageId !== undefined) {
      if (!UUID.test(value.upToMessageId)) throw fail('FORK_BOUNDARY_INVALID', '分支起点无效。');
      args.upToMessageId = value.upToMessageId;
    }
    if (value.title !== undefined) {
      if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 512 || /[\x00-\x1f]/.test(value.title)) throw fail('FORK_TITLE_INVALID', '分支标题无效。');
      args.title = value.title.trim();
    }
  }
  if (operation === 'renameSession') {
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 512 || /[\x00-\x1f]/.test(value.title)) throw fail('SESSION_TITLE_INVALID', '会话名称无效');
    args.title = value.title.trim();
  }
  return args;
}
function publicError(error) {
  const known = /^SESSION_|^SUBAGENT_|^FORK_/.test(error?.code || '');
  return { ok: false, code: known ? error.code : 'SESSION_HISTORY_FAILED', message: known ? error.message : '暂时无法读取原生会话历史，请稍后重试。' };
}

// This runs in a dedicated worker / pinned WSL process. It calls public SDK
// exports with an explicit dir; it never searches every project's transcript.
async function invokeSessionOperation(sdk, scope, operation, input = {}) {
  validateScope(scope, { listing: operation === 'listSessions' }); const args = operationArgs(operation, input);
  if (typeof sdk[operation] !== 'function') throw fail('SESSION_API_UNAVAILABLE', '当前 SDK 不支持这项历史操作。');
  if (operation === 'listSessions') return sdk.listSessions({ dir: scope.cwd, ...args });
  if (operation === 'renameSession') return sdk.renameSession(scope.sessionId, args.title, { dir: scope.cwd });
  if (operation === 'getSubagentMessages') {
    const found = await sdk.listSubagents(scope.sessionId, { dir: scope.cwd });
    if (!found.includes(args.agentId)) throw fail('SUBAGENT_HISTORY_UNAVAILABLE', '子 Agent 的原生记录已清理或尚未写入。');
    const result = await sdk.getSubagentMessages(scope.sessionId, args.agentId, { dir: scope.cwd, limit: args.limit, offset: args.offset });
    if (!result.length && args.offset === 0) throw fail('SUBAGENT_HISTORY_UNAVAILABLE', '子 Agent 的原生记录已清理或尚未写入。');
    if (result.some(message => message.session_id && message.session_id !== scope.sessionId)) throw fail('SUBAGENT_SCOPE_MISMATCH', '子 Agent 记录与当前会话不匹配。');
    return result;
  }
  if (operation !== 'getSessionInfo' && operation !== 'deleteSession') {
    const info = await sdk.getSessionInfo(scope.sessionId, { dir: scope.cwd });
    if (!info) throw fail('SESSION_HISTORY_UNAVAILABLE', '原生会话记录已清理、已删除或尚未写入。Relay 对话记录仍保留。');
  }
  if (operation === 'listSubagents') return (await sdk.listSubagents(scope.sessionId, { dir: scope.cwd })).filter(id => AGENT_ID.test(id));
  return sdk[operation](scope.sessionId, { dir: scope.cwd, ...args });
}

// Isolate the SDK's process.env-based directory cache and JSONL parsing from
// Electron's main thread. Neither route starts a model Query or loads hooks.
function executeSessionOperation(scope, operation, input = {}, options = {}) {
  validateScope(scope, { listing: operation === 'listSessions' }); const args = operationArgs(operation, input);
  const platform = options.platform || process.platform;
  const script = unpackPath(options.workerPath || path.join(__dirname, 'sdk-session-history-worker.cjs'));
  const sdkPath = unpackPath(options.sdkPath || resourcePath('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'));
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs || 15000, 60000));
  const snapshot = { sessionId: scope.sessionId, cwd: scope.cwd, configDir: scope.configDir, agentEnvironment: scope.agentEnvironment, wslDistribution: scope.wslDistribution };
  const payload = { scope: snapshot, operation, args, sdkPath, timeoutMs };
  return new Promise((resolve, reject) => {
    let worker, child, timer, finished = false;
    const stop = () => { if (worker) void worker.terminate(); if (child) child.kill(); };
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      stop(); if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(fail('SESSION_HISTORY_CANCELED', '已取消读取原生历史。'));
    const receive = response => {
      if (response?.ok === true) finish(null, response.value);
      else finish(fail(response?.code || 'SESSION_HISTORY_FAILED', response?.message || '原生历史操作失败。'));
    };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(fail('SESSION_HISTORY_TIMEOUT', '原生历史仍未响应，请稍后重试。')), timeoutMs);
    try {
      if (scope.agentEnvironment === 'wsl' && platform === 'win32') {
        payload.scope.cwd = linuxPath(scope.cwd); payload.scope.configDir = linuxPath(scope.configDir); payload.sdkPath = linuxPath(sdkPath);
        const executable = options.wslExecutable || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
        const spawnProcess = options.spawn || spawn;
        child = spawnProcess(executable, ['--distribution', scope.wslDistribution, '--cd', payload.scope.cwd, '--exec', 'node', linuxPath(script)],
          { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', size = 0;
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { finish(fail('SESSION_HISTORY_TOO_LARGE', '历史内容过大，请缩小读取范围。')); return; }
          stdout += chunk;
        });
        child.stderr.on('data', () => {});
        child.on('error', () => finish(fail('SESSION_ENVIRONMENT_UNAVAILABLE', '无法启动这条记录所属的 WSL 环境。')));
        child.on('close', code => {
          if (finished) return;
          if (code !== 0) { finish(fail('SESSION_ENVIRONMENT_UNAVAILABLE', 'WSL 历史读取需要该发行版中可用的 Node.js 18.18 或更新版本。')); return; }
          try { receive(JSON.parse(stdout)); } catch (_) { finish(fail('SESSION_HISTORY_FAILED', 'WSL 历史读取返回了无效内容。')); }
        });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
      } else {
        if (scope.agentEnvironment === 'wsl' && options.currentDistribution && scope.wslDistribution !== options.currentDistribution) throw fail('SESSION_ENVIRONMENT_UNAVAILABLE', '这条记录属于另一个 WSL 发行版。');
        const WorkerType = options.Worker || Worker;
        worker = new WorkerType(script, { workerData: payload, env: { ...process.env, CLAUDE_CONFIG_DIR: scope.configDir },
          resourceLimits: { maxOldGenerationSizeMb: 256 } });
        worker.once('message', receive);
        worker.once('error', () => finish(fail('SESSION_HISTORY_FAILED', '原生历史读取进程发生错误。')));
        worker.once('exit', () => { if (!finished) finish(fail('SESSION_HISTORY_FAILED', '原生历史读取未完成。')); });
      }
    } catch (error) { finish(error); }
  });
}

function scopeKey(scope) { return JSON.stringify([scope.conversationId, scope.runId, scope.sessionId, scope.cwd, scope.configDir, scope.agentEnvironment, scope.wslDistribution || null, [...(scope.agentIds || [])].sort()]); }
function createSessionHistoryService({ resolveScope, execute = executeSessionOperation } = {}) {
  if (typeof resolveScope !== 'function') throw new TypeError('resolveScope is required');
  const pending = new Map();
  let active = 0; const waiting = [];
  function schedule(work) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; waiting.shift()?.(); });
      };
      if (active < 2) start(); else waiting.push(start);
    });
  }
  async function request(input, operation) {
    try {
      if (!input || !UUID.test(input.convId || '') || !UUID.test(input.runId || '')) throw fail('SESSION_SCOPE_INVALID', '请选择一轮有效的对话。');
      const resolved = validateScope(await resolveScope({ convId: input.convId, runId: input.runId }));
      const scope = { ...resolved, agentIds: [...(resolved.agentIds || [])] };
      if (scope.conversationId !== input.convId || scope.runId !== input.runId) throw fail('SESSION_SCOPE_INVALID', '运行记录不属于这个会话。');
      const allowed = new Set((Array.isArray(scope.agentIds) ? scope.agentIds : []).filter(id => AGENT_ID.test(id)));
      if (!allowed.size) throw fail('SUBAGENT_OWNERSHIP_UNAVAILABLE', '这轮任务未记录可核验的原生子 Agent 归属。');
      if (operation === 'getSubagentMessages' && !allowed.has(input.agentId)) throw fail('SUBAGENT_SCOPE_MISMATCH', '这个子 Agent 不属于当前轮次。');
      const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit, 50)) : PAGE_SIZE;
      const args = operationArgs(operation, { ...input, limit: limit + 1 });
      const key = JSON.stringify([scopeKey(scope), operation, args]);
      if (!pending.has(key)) {
        if (pending.size >= 16) throw fail('SESSION_HISTORY_BUSY', '历史读取请求较多，请稍后再试。');
        const work = schedule(async () => {
          const current = await resolveScope({ convId: input.convId, runId: input.runId });
          if (!current || scopeKey(current) !== scopeKey(scope)) throw fail('SESSION_HISTORY_STALE', '会话记录已变化，请重新打开详情。');
          return execute(scope, operation, args);
        });
        pending.set(key, work);
        work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
      }
      const raw = await pending.get(key);
      const current = await resolveScope({ convId: input.convId, runId: input.runId });
      if (!current || scopeKey(current) !== scopeKey(scope)) throw fail('SESSION_HISTORY_STALE', '会话记录已变化，请重新打开详情。');
      if (operation === 'listSubagents') return { ok: true, items: raw.filter(id => allowed.has(id)).map(id => ({ agentId: id })) };
      const hasMore = raw.length > limit;
      return { ok: true, items: raw.slice(0, limit), offset: args.offset,
        nextOffset: args.offset + Math.min(raw.length, limit), hasMore };
    } catch (error) { return publicError(error); }
  }
  return { listSubagents: input => request(input, 'listSubagents'), getSubagentMessages: input => request(input, 'getSubagentMessages') };
}

module.exports = { executeSessionOperation, invokeSessionOperation, createSessionHistoryService, validateScope, operationArgs, publicError, PAGE_SIZE, UUID };
