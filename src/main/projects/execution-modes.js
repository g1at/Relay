'use strict';

const { randomUUID } = require('crypto');

const PLAN_INSTRUCTIONS = '当前会话处于只读计划模式。只调查、澄清并在最终回复中给出计划；不要修改文件、执行命令、调用会产生副作用的工具或创建子代理。不要调用 ExitPlanMode 或写入计划文件。用户需要在 Relay 中明确切回普通模式后才能执行计划。';
const PLAN_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'AskUserQuestion', 'TaskGet', 'TaskList', 'mcp__relay-memory__list', 'mcp__relay-memory__read']);
const PLAN_DENIAL = '当前对话是只读计划模式，此操作不会执行。请先完成文字计划，由用户在 Relay 中明确切回普通模式。';

function modeError(code, message) { return Object.assign(new Error(message), { code }); }

function normalizeExecutionMode(value) {
  const kind = value == null ? 'default' : value.kind;
  if (!['default', 'plan', 'goal'].includes(kind)) throw modeError('INVALID_EXECUTION_MODE', '无效的对话模式');
  // Native /goal has no token-budget flag. Do not silently pretend to enforce it.
  if (value && Object.keys(value).some(key => key !== 'kind')) {
    throw modeError('UNSUPPORTED_EXECUTION_MODE_OPTION', '当前模式不支持附加预算参数；可在目标条件中明确写出停止条件');
  }
  return { kind };
}

function prepareExecutionRequest(rawPrompt, fullyBuiltPrompt, mode) {
  const executionMode = normalizeExecutionMode(mode);
  const text = String(rawPrompt || '').trim();
  const complete = String(fullyBuiltPrompt == null ? rawPrompt || '' : fullyBuiltPrompt);
  if (executionMode.kind === 'goal') {
    const condition = text.replace(/^\/goal\s+/i, '').trim();
    if (!condition || condition === '/goal' || /^(clear|stop|off|reset|none|cancel)$/i.test(condition)) {
      throw modeError('INVALID_GOAL', '请输入具体的目标完成条件');
    }
    if (condition.length > 4000) throw modeError('GOAL_TOO_LONG', '目标条件最多 4000 个字符，请缩短目标描述；附件和额外上下文不受此限制');
    return { executionMode, prompt: `/goal ${condition}`, contextPrompt: complete,
      goalCondition: condition, goalExplicit: /^\/goal\s+/i.test(text) };
  }
  return { executionMode, prompt: executionMode.kind === 'plan' ? `${PLAN_INSTRUCTIONS}\n\n${complete}` : complete };
}

function executionToolPolicy(getMode, canUseTool) {
  const blocked = name => getMode().kind === 'plan' && !PLAN_READ_TOOLS.has(name);
  return {
    // A hook denial is evaluated even when user settings normally auto-allow a
    // tool. Keep this separate from the callback to protect plan + global bypass.
    hooks: { PreToolUse: [{ hooks: [async input => blocked(input.tool_name) ? {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_DENIAL },
    } : {}] }] },
    canUseTool: async (name, input, options) => {
      if (blocked(name)) return { behavior: 'deny', message: PLAN_DENIAL };
      if (typeof canUseTool === 'function') return canUseTool(name, input, options);
      return { behavior: 'deny', message: '此操作需要用户授权，但当前没有可用的确认入口' };
    },
  };
}

// The public stream input protocol runs local commands without a model call.
// Some runtimes emit their result WITHOUT user_message_uuid. A correlated lifecycle
// started -> zero-turn result -> completed is the only accepted internal ACK.
class LiveExecutionModes {
  constructor({ control, enqueue, stop, ready = async () => {}, permissionMode = 'default', executionMode, resumed = false }) {
    this.control = control; this.enqueue = enqueue; this.stop = stop; this.ready = ready;
    this.mode = normalizeExecutionMode(executionMode);
    this.permissionMode = permissionMode;
    this.appliedPermission = this.mode.kind === 'plan' ? 'plan' : permissionMode;
    this.goalMayExist = resumed;
    this.knownGoal = resumed && this.mode.kind === 'goal';
    this.goalStateKnown = !resumed;
    this.goalCondition = null;
    this.pending = null; this.internalIds = new Set(); this.tail = Promise.resolve();
    this.goalInputId = null; this.goalInputStarted = false; this.closed = false;
    this.inputStarted = false;
    this.contextEpoch = 0; this.contextResetUuids = new Set();
  }

  prepare(value, { permissionMode = this.permissionMode, contextPrompt, contextFiles,
    goalCondition, goalExplicit = false, previousGoal, signal, timeoutMs = 10000, startupTimeoutMs = 60000 } = {}) {
    const mode = normalizeExecutionMode(value);
    const contextEpoch = this.contextEpoch;
    const startupDeadline = Date.now() + Math.max(1, Math.min(startupTimeoutMs, 120000));
    const acknowledgeTimeout = Math.max(1, Math.min(timeoutMs, 15000));
    if (signal && signal.aborted) return Promise.reject(modeError('MODE_PREPARE_CANCELED', '模式准备已取消'));
    let timer; let abort; let armTimer;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(modeError('MODE_PREPARE_CANCELED', '模式准备已取消'));
      if (signal) signal.addEventListener('abort', abort, { once: true });
      armTimer = (duration, code, message) => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(modeError(code, message)), duration);
      };
      armTimer(Math.max(1, Math.min(startupTimeoutMs, 120000)), 'MODE_INITIALIZATION_TIMEOUT', '智能体启动超时，请重新发送');
    });
    const check = () => {
      if (this.closed || signal && signal.aborted) throw modeError('MODE_PREPARE_CANCELED', '模式准备已取消');
      if (this.contextEpoch !== contextEpoch) throw modeError('MODE_CONTEXT_RESET', '运行上下文已重置，请重新发送本次要求');
    };
    const localInput = (...args) => {
      check();
      // initialize acknowledges the control channel before the native command
      // engine has finished loading MCP/transcript state. Its first queued
      // command must still share the bounded startup budget; the short ACK
      // clock only starts when that exact command begins executing.
      if (!this.inputStarted) armTimer(Math.max(1, startupDeadline - Date.now()),
        'MODE_INPUT_START_TIMEOUT', '智能体运行环境准备超时，请重新发送');
      return this.localInput(...args, () => {
        if (!this.closed && this.contextEpoch === contextEpoch && !(signal && signal.aborted)) {
          armTimer(acknowledgeTimeout, 'MODE_PREPARE_TIMEOUT', '模式准备超时，请重新发送');
        }
      });
    };
    const work = this.tail.then(async () => {
      check();
      // Cold/resumed Queries can spend time loading their transcript and tools.
      // Do not consume the local-command ACK deadline before the SDK is ready.
      await this.ready(); check();
      armTimer(acknowledgeTimeout, 'MODE_PREPARE_TIMEOUT', '模式准备超时，请重新发送');
      if (mode.kind === 'goal' || this.goalMayExist) {
        const commands = await this.control('supportedCommands'); check();
        if (!Array.isArray(commands) || !commands.some(command => (typeof command === 'string' ? command : command.name) === 'goal')) {
          if (mode.kind === 'goal' || this.knownGoal) throw modeError('GOAL_UNAVAILABLE', '当前 Claude 会话不支持 /goal，或目标功能被策略禁用');
          // A legacy ordinary resume must not become unusable merely because
          // that runtime cannot expose goals. Known active goals stay fail-closed.
          this.goalMayExist = false;
          this.goalStateKnown = true;
        }
      }
      if (mode.kind === 'plan') this.mode = mode; // tighten the tool guard before changing SDK permission
      if (mode.kind !== 'goal' && this.goalMayExist) {
        await localInput('/goal clear', false, undefined, 'clear'); check(); this.goalMayExist = false; this.knownGoal = false; this.goalStateKnown = true;
        this.goalCondition = null;
      }
      if (mode.kind === 'goal' && !this.goalStateKnown) {
        const status = await localInput('/goal', false, undefined, 'status'); check();
        this.goalMayExist = this.knownGoal = /^Goal active: /.test(status);
        const condition = /^Goal active: ([\s\S]+) \((?:not yet evaluated|\d+ turns?)\)(?:\nLast check: [\s\S]*)?$/.exec(status);
        if (condition) this.goalCondition = condition[1];
        this.goalStateKnown = true;
      }
      const permission = mode.kind === 'plan' ? 'plan' : permissionMode;
      if (permission !== this.appliedPermission) {
        await this.control('setPermissionMode', permission); check();
        this.appliedPermission = permission;
      }
      this.permissionMode = permissionMode; this.mode = mode;
      // A normal follow-up (including retry after 429) must not replace the
      // native completion condition with the latest text such as "continue".
      if (mode.kind === 'goal' && this.knownGoal && !goalExplicit && goalCondition) {
        return { ok: true, executionMode: { ...mode }, permissionMode: permission,
          prompt: contextPrompt || goalCondition, files: contextFiles || [],
          goalCondition: this.goalCondition || previousGoal || goalCondition };
      }
      // The CLI clears its own goal after an unrecoverable API error. Relay's
      // durable condition allows a user-requested retry to restore that goal.
      const recoverableGoal = typeof previousGoal === 'string' && previousGoal.trim().length <= 4000 ? previousGoal.trim() : '';
      const nextCondition = !goalExplicit && recoverableGoal ? recoverableGoal : goalCondition;
      if (mode.kind === 'goal' && contextPrompt) {
        await localInput(`以下是本次目标的任务上下文，稍后的 /goal 命令会明确目标完成条件。\n\n${contextPrompt}`, true, contextFiles, 'clear'); check();
      }
      return { ok: true, executionMode: { ...mode }, permissionMode: permission,
        ...(mode.kind === 'goal' && nextCondition ? { prompt: `/goal ${nextCondition}`, files: [], goalCondition: nextCondition } : {}) };
    });
    const result = Promise.race([work, canceled]).catch(error => {
      // A late write/control must never overtake a later user turn. Closing this
      // Query retains its persisted session for a safe resume on the next send.
      this.close(error); try { this.stop(error); } catch (_) {} throw error;
    }).finally(() => {
      clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  clearContext() {
    const update = this.tail.then(async () => {
      await this.ready();
      if (this.pending || this.closed) throw modeError('MODE_INPUT_FAILED', '当前执行器不能清空上下文');
      let timer;
      try {
        return await Promise.race([this.localInput('/clear', false, undefined, 'context-clear'), new Promise((_, reject) => {
          timer = setTimeout(() => reject(modeError('MODE_INPUT_FAILED', '未收到清空上下文的确认')), 10000);
        })]);
      } catch (error) { this.close(error); try { this.stop(error); } catch (_) {} throw error; }
      finally { clearTimeout(timer); }
    });
    this.tail = update.catch(() => {});
    return update;
  }

  localInput(text, shouldQuery = false, files, kind = 'clear', onStarted) {
    if (this.closed) return Promise.reject(modeError('MODE_PREPARE_CANCELED', '模式准备已取消'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); this.internalIds.add(id);
      this.pending = { id, started: false, result: null, shouldQuery, kind, resolve, reject, onStarted };
      if (!this.enqueue(text, { uuid: id, ...(shouldQuery ? { shouldQuery: false } : {}), ...(files && files.length ? { files } : {}) })) {
        this.pending = null; reject(modeError('MODE_INPUT_FAILED', '模式准备命令未能发送'));
      }
    });
  }

  beforePush(text, metadata = {}) {
    if (this.pending || this.closed) return false;
    const goal = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(text);
    if (metadata.priority !== 'next' && goal && goal[1] && !/^(clear|stop|off|reset|none|cancel)$/i.test(goal[1].trim())) {
      this.goalMayExist = true; this.knownGoal = true; this.goalInputId = metadata.uuid || null; this.goalInputStarted = false;
      this.goalCondition = goal[1].trim();
    }
    return true;
  }

  setPermissionMode(mode) {
    const update = this.tail.then(async () => {
      if (this.closed) throw modeError('MODE_PREPARE_CANCELED', '模式准备已取消');
      const effective = this.mode.kind === 'plan' ? 'plan' : mode;
      await this.control('setPermissionMode', effective);
      if (this.closed) throw modeError('MODE_PREPARE_CANCELED', '模式准备已取消');
      this.permissionMode = mode;
      this.appliedPermission = effective;
    });
    this.tail = update.catch(() => {});
    return update;
  }

  observe(event) {
    if (event.type === 'conversation_reset' && event.new_conversation_id
        && !event.parent_tool_use_id && !event.parentToolUseId && !event.agent_id) {
      if (event.uuid && this.contextResetUuids.has(event.uuid)) return event;
      if (event.uuid) this.contextResetUuids.add(event.uuid);
      this.contextEpoch += 1;
      this.goalMayExist = false; this.knownGoal = false; this.goalStateKnown = true;
      this.goalCondition = null; this.goalInputId = null; this.goalInputStarted = false;
      if (this.mode.kind === 'goal') this.mode = { kind: 'default' };
      // Preserve a user-selected read-only plan guard and the host's permission
      // choice. A transcript reset is not permission to start writing files.
      const pending = this.pending; this.pending = null;
      if (pending?.kind === 'context-clear') pending.resolve({ ok: true, sessionId: event.new_conversation_id });
      else if (pending) pending.reject(modeError('MODE_CONTEXT_RESET', '运行上下文已重置，请重新发送本次要求'));
      // Retain internal command IDs as tombstones so late ACKs cannot surface as
      // new user messages or satisfy a later prepare operation.
      return event;
    }
    const pending = this.pending;
    const commandId = event.type === 'command_lifecycle' ? event.command_uuid : null;
    if (commandId && commandId === this.goalInputId && event.state === 'started') this.goalInputStarted = true;
    if (commandId && commandId === this.goalInputId && ['cancelled', 'discarded', 'refused'].includes(event.state)) {
      this.goalStateKnown = false;
    }
    if (commandId && this.internalIds.has(commandId)) {
      if (pending && pending.id === commandId) {
        if (event.state === 'started' && !pending.started) {
          pending.started = true; this.inputStarted = true;
          if (pending.onStarted) pending.onStarted();
        }
        if (['cancelled', 'discarded', 'refused'].includes(event.state)) {
          this.pending = null; pending.reject(modeError('MODE_INPUT_FAILED', '模式准备命令未被执行'));
        } else if (event.state === 'completed' && pending.started) {
          this.pending = null;
          const result = pending.result;
          const text = String(result && result.result || '');
          const acknowledged = pending.shouldQuery || (pending.kind === 'status'
            ? /^(?:No goal set(?:\. Usage: `\/goal <condition>`)?|Goal active: [\s\S]+)$/.test(text)
            : /^(No goal set|Goal cleared:)/.test(text));
          if (result && result.subtype === 'success' && !result.is_error && result.num_turns === 0 && result.duration_api_ms === 0 && acknowledged) pending.resolve(text);
          else pending.reject(modeError('MODE_INPUT_FAILED', '无法确认目标清理或任务上下文已准备完成，请重新发送'));
        }
      }
      return null;
    }
    if (pending && event.type === 'result' && event.user_message_uuid === pending.id && pending.started) {
      pending.result = event; return null;
    }
    if (this.internalIds.has(event.user_message_uuid) || event.type === 'user' && this.internalIds.has(event.uuid)) return null;
    if (event.type === 'system' && event.permissionMode && !event.parent_tool_use_id && !event.agent_id) this.appliedPermission = event.permissionMode;
    if (event.type === 'active_goal' && !event.parent_tool_use_id && !event.agent_id) {
      this.goalMayExist = !!event.value; this.knownGoal = !!event.value; this.goalStateKnown = true;
      if (event.value && typeof event.value.condition === 'string') this.goalCondition = event.value.condition;
    }
    if (pending && pending.started && !event.parent_tool_use_id && !event.parentToolUseId && !event.agent_id) {
      if (event.type === 'result' && !event.user_message_uuid) { pending.result = event; return null; }
      if (['assistant', 'stream_event', 'active_goal'].includes(event.type) && !event.user_message_uuid) return null;
    }
    if (this.goalInputId && this.goalInputStarted && event.type === 'result' && !event.parent_tool_use_id &&
        (!event.user_message_uuid || event.user_message_uuid === this.goalInputId)) {
      this.goalInputId = null;
      if (event.num_turns === 0 && event.duration_api_ms === 0) {
        this.goalStateKnown = false;
        if (!event.is_error) return { ...event, is_error: true, result: `目标未启动：${event.result || '当前会话未接受 /goal，请检查 hooks 策略或工作区信任设置'}` };
      }
    }
    // The native Stop hook can clear a completed goal without emitting an
    // active_goal frame on the SDK stream. Recheck after the turn instead of
    // carrying our optimistic pre-push state into a later user request.
    if (event.type === 'result' && this.mode.kind === 'goal' && !event.parent_tool_use_id
        && !event.parentToolUseId && !event.agent_id) this.goalStateKnown = false;
    return event;
  }

  close(error = modeError('MODE_PREPARE_CANCELED', '模式准备已取消')) {
    this.closed = true;
    const pending = this.pending; this.pending = null;
    if (pending) pending.reject(error);
  }
}

module.exports = { normalizeExecutionMode, prepareExecutionRequest, executionToolPolicy, LiveExecutionModes, PLAN_INSTRUCTIONS };
