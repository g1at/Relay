'use strict';

const { RUN_STATES, isTerminalState } = require('./task-protocol');

// 将 Claude SDK 的底层事件压缩成任务中心所需的稳定语义。
// 这里不决定“有后台 Agent 的 result 是否为最终结果”——该判断仍由现有
// LiveAsyncAgentTracker 负责，只有它补出的 job-done 才结束成功任务。

function isErrorResult(event) {
  if (!event || event.type !== 'result') return false;
  if (/^aborted_/.test(String(event.terminal_reason || ''))) return true;
  if (event.is_error === true) return true;
  const subtype = String(event.subtype || '');
  return !!subtype && subtype !== 'success';
}

function compactText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function summarizeResultText(value, max = 240) {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/[^\s)\]}]+/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？；：,.!?;:])/g, '$1')
    .trim();
  return compactText(text || source, max);
}

function resultError(event) {
  if (/^aborted_/.test(String(event && event.terminal_reason || ''))) return 'Claude 执行已中止';
  if (Array.isArray(event && event.errors) && event.errors.length) {
    return compactText(event.errors.join('\n')) || '执行出错';
  }
  const detail = compactText(event && (event.result || event.error));
  if (detail) return detail;
  const denied = permissionDenialInfo(event);
  if (denied) {
    const suffix = denied.tools.length ? `：${denied.tools.join('、')}` : '';
    return compactText(`工具权限被拒绝（${denied.count} 次）${suffix}`) || '工具权限被拒绝';
  }
  return '执行出错';
}

const MAX_PERMISSION_DENIED_TOOL_NAMES = 12;
const MAX_PERMISSION_DENIED_TOOL_NAME_LENGTH = 120;

function permissionDenialInfo(event) {
  const denials = Array.isArray(event && event.permission_denials)
    ? event.permission_denials : [];
  if (!denials.length) return null;
  const tools = [];
  const seen = new Set();
  for (const denial of denials) {
    const name = compactText(denial && (denial.tool_name || denial.toolName), MAX_PERMISSION_DENIED_TOOL_NAME_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (tools.length < MAX_PERMISSION_DENIED_TOOL_NAMES) tools.push(name);
  }
  return { count: denials.length, tools };
}

function taskLabel(event) {
  const taskType = String(event.task_type || '').toLowerCase();
  const toolName = String(event.tool_name || '').trim();
  if (taskType.includes('agent') || taskType === 'local_agent') return '正在等待 Agent';
  if (toolName) return `正在运行 ${toolName}`;
  if (taskType === 'shell' || taskType === 'bash') return '正在运行命令';
  return '正在运行工具';
}

function isAmbientTask(event) {
  return !!event && typeof event === 'object' && event.ambient === true;
}

function resultSdkMetadata(event) {
  const sdk = {};
  const assign = (key, value) => {
    if (value !== undefined && value !== null && value !== '') sdk[key] = value;
  };
  assign('userMessageUuid', event && event.user_message_uuid);
  if (event && event.queued_turn_count != null) {
    assign('queuedTurnCount', Number(event.queued_turn_count || 0));
  }
  assign('terminalReason', event && event.terminal_reason);
  if (event && event.api_error_status != null) assign('apiErrorStatus', Number(event.api_error_status));
  if (event && event.duration_ms != null) assign('durationMs', Number(event.duration_ms));
  if (event && event.duration_api_ms != null) assign('durationApiMs', Number(event.duration_api_ms));
  if (event && event.total_cost_usd != null) assign('totalCostUsd', Number(event.total_cost_usd));
  if (event && event.usage && typeof event.usage === 'object') sdk.usage = { ...event.usage };
  if (event && event.modelUsage && typeof event.modelUsage === 'object') {
    sdk.modelUsage = JSON.parse(JSON.stringify(event.modelUsage));
  }
  assign('fastModeState', event && event.fast_mode_state);
  assign('fastModeDisabledReason', event && event.fast_mode_disabled_reason);
  const denied = permissionDenialInfo(event);
  if (denied) sdk.permissionDenials = denied;
  return sdk;
}

/**
 * @returns {{ kind: 'noop' } | { kind: 'update', patch: object } |
 *   { kind: 'terminal', status: string, details: object }}
 */
function normalizeClaudeTaskEvent(event, currentRun = {}, now = new Date().toISOString()) {
  if (!event || typeof event !== 'object') return { kind: 'noop' };
  const currentState = currentRun && (currentRun.state || currentRun.status);
  if (isTerminalState(currentState)) return { kind: 'noop' };
  const progress = {
    ...((currentRun && currentRun.progress) || {}),
    lastEventAt: now,
  };

  if (event.type === 'system' && event.subtype === 'init') {
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: 'preparing',
        health: 'ok',
        executorState: 'active',
        progress: { ...progress, label: '正在准备' },
        execution: {
          ...((currentRun && currentRun.execution) || {}),
          sessionId: event.session_id || (currentRun.execution && currentRun.execution.sessionId) || null,
          model: event.model || (currentRun.execution && currentRun.execution.model) || null,
          claudeCodeVersion: event.claude_code_version
            || (currentRun.execution && currentRun.execution.claudeCodeVersion) || null,
          permissionMode: event.permissionMode
            || (currentRun.execution && currentRun.execution.permissionMode) || null,
          effort: event.effort === undefined
            ? ((currentRun.execution && currentRun.execution.effort) || null)
            : event.effort,
          capabilities: Array.isArray(event.capabilities)
            ? event.capabilities.slice()
            : ((currentRun.execution && currentRun.execution.capabilities) || []),
        },
      },
    };
  }

  if (event.type === 'system' && event.subtype === 'task_started') {
    if (isAmbientTask(event)) return { kind: 'noop' };
    const agent = /agent/i.test(String(event.task_type || ''));
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: agent ? 'agent' : 'tool',
        health: 'ok',
        executorState: 'active',
        progress: { ...progress, label: taskLabel(event) },
      },
    };
  }

  if (event.type === 'system' && event.subtype === 'task_notification') {
    if (isAmbientTask(event)) return { kind: 'noop' };
    const status = String(event.status || '').toLowerCase();
    const stillRunning = status === 'running' || status === 'pending';
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: /agent/i.test(String(event.task_type || '')) ? 'agent' : 'tool',
        health: 'ok',
        executorState: 'active',
        progress: {
          ...progress,
          label: stillRunning ? taskLabel(event) : '正在整理结果',
        },
      },
    };
  }

  if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
    const tasks = (Array.isArray(event.tasks) ? event.tasks : []).filter((task) => !isAmbientTask(task));
    const count = tasks.length;
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        ...(count ? { phase: tasks.some((task) => /agent/i.test(String(task.task_type || ''))) ? 'agent' : 'tool' } : {}),
        health: 'ok',
        executorState: 'active',
        progress: {
          ...progress,
          backgroundTaskCount: count,
          label: count ? (count === 1 ? taskLabel(tasks[0]) : `正在运行 ${count} 个后台任务`)
            : ((currentRun.progress && currentRun.progress.label) || '正在运行'),
        },
      },
    };
  }

  if (event.type === 'system' && event.subtype === 'task_updated') {
    if (isAmbientTask(event)) return { kind: 'noop' };
    const patch = event.patch && typeof event.patch === 'object' ? event.patch : {};
    const status = String(patch.status || '').toLowerCase();
    const terminal = ['completed', 'failed', 'killed', 'canceled', 'cancelled'].includes(status);
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: terminal ? 'finalizing' : (/agent/i.test(String(event.task_type || '')) ? 'agent' : 'tool'),
        health: 'ok',
        executorState: terminal ? 'draining' : 'active',
        progress: {
          ...progress,
          label: terminal ? '正在整理结果' : taskLabel({ ...event, ...patch }),
        },
      },
    };
  }

  if (event.type === 'assistant' || event.type === 'stream_event') {
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: 'thinking',
        health: 'ok',
        executorState: 'active',
        progress: { ...progress, label: '正在生成回复' },
      },
    };
  }

  if (event.type === 'tool_progress') {
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: 'tool',
        health: 'ok',
        executorState: 'active',
        progress: { ...progress, label: taskLabel(event) },
      },
    };
  }

  if (event.type === 'result') {
    const sdk = resultSdkMetadata(event);
    const hasPendingInput = Number(event.queued_turn_count || 0) > 0 || Number(event.relay_pending_inputs || 0) > 0;
    if (currentState === RUN_STATES.STOPPING || currentRun.cancelRequestedAt) {
      return {
        kind: 'terminal', status: RUN_STATES.CANCELED,
        details: {
          phase: 'terminal', executorState: 'stopped',
          progress: { ...progress, label: '已取消' },
        },
      };
    }
    if (isErrorResult(event)) {
      return {
        kind: 'terminal',
        status: RUN_STATES.FAILED,
        details: {
          phase: 'terminal',
          health: 'ok',
          executorState: 'stopped',
          progress: { ...progress, label: '执行失败' },
          result: {
            ...((currentRun && currentRun.result) || {}),
            status: RUN_STATES.FAILED,
            error: resultError(event),
            summary: summarizeResultText(event.result),
            sdk,
          },
        },
      };
    }
    return {
      kind: 'update',
      patch: {
        state: RUN_STATES.RUNNING,
        phase: hasPendingInput ? 'running' : 'finalizing',
        health: 'ok',
        executorState: hasPendingInput ? 'active' : 'draining',
        progress: {
          ...progress,
          label: hasPendingInput ? '正在处理排队消息' : '正在完成',
        },
        result: {
          ...((currentRun && currentRun.result) || {}),
          summary: summarizeResultText(event.result),
          sdk,
        },
      },
    };
  }

  if (event.type === 'job-done') {
    if (currentRun && (currentState === RUN_STATES.STOPPING || currentRun.cancelRequestedAt)) {
      return {
        kind: 'terminal', status: RUN_STATES.CANCELED,
        details: {
          phase: 'terminal', executorState: 'stopped',
          progress: { ...progress, label: '已取消' },
        },
      };
    }
    const finalResult = event.finalResult?.type === 'result' ? event.finalResult : null;
    const sdkFailed = isErrorResult(finalResult);
    const success = !event.error && !sdkFailed && (event.exitCode === 0 || event.exitCode == null);
    return {
      kind: 'terminal',
      status: success ? RUN_STATES.SUCCEEDED : RUN_STATES.FAILED,
      details: {
        phase: 'terminal',
        health: 'ok',
        executorState: 'stopped',
        progress: { ...progress, label: success ? '已完成' : '执行失败' },
        result: {
          ...((currentRun && currentRun.result) || {}),
          ...(finalResult ? { summary: summarizeResultText(finalResult.result),
            sdk: { ...(currentRun.result?.sdk || {}), ...resultSdkMetadata(finalResult) } } : {}),
          status: success ? RUN_STATES.SUCCEEDED : RUN_STATES.FAILED,
          exitCode: event.exitCode == null ? null : event.exitCode,
          error: success ? null : (compactText(event.error) || (sdkFailed ? resultError(finalResult) : `执行器退出码 ${event.exitCode}`)),
        },
      },
    };
  }

  if (event.type === 'stderr') {
    return {
      kind: 'update',
      patch: {
        health: 'ok',
        progress: { ...progress, label: currentRun.progress && currentRun.progress.label || '正在运行' },
      },
    };
  }

  return { kind: 'noop' };
}

module.exports = {
  compactText,
  isErrorResult,
  isAmbientTask,
  normalizeClaudeTaskEvent,
  resultSdkMetadata,
  summarizeResultText,
};
