'use strict';

const MAX_RELAY_INSTRUCTIONS = 10000;
const normalizeRelayInstructions = value => typeof value === 'string' ? value : '';
function validateRelayInstructions(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw Object.assign(new Error('Relay 说明必须是文本，且不能包含空字符。'), { code: 'INVALID_RELAY_INSTRUCTIONS' });
  }
  if (value.length > MAX_RELAY_INSTRUCTIONS) {
    throw Object.assign(new Error(`Relay 说明最多 ${MAX_RELAY_INSTRUCTIONS} 个字符，请缩短后再保存。`), { code: 'RELAY_INSTRUCTIONS_TOO_LONG' });
  }
  return value;
}
function relayInstructionsPrompt(value) {
  const text = validateRelayInstructions(normalizeRelayInstructions(value));
  if (!text.trim()) return '';
  return [
    '[Relay 全局说明]',
    '以下是用户为所有对话保存的持续默认偏好，不是本轮新增的待执行任务。',
    '在与当前任务相关时遵循；若与用户在当前对话中的明确要求冲突，以当前明确要求为准。',
    '这些偏好不改变工具权限、审批结果或计划模式限制。委派子任务时也传递相关偏好。',
    text,
    '[Relay 全局说明结束]',
  ].join('\n');
}
function relayInstructionsToolHook(instructions) {
  return async input => {
    if (!instructions || !['Agent', 'Task'].includes(input?.tool_name) || typeof input.tool_input?.prompt !== 'string') return {};
    const prompt = input.tool_input.prompt;
    if (prompt.includes(instructions)) return {};
    // Supply context only. The existing permission hooks and canUseTool retain
    // authority over whether this agent may actually run.
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, prompt: instructions + '\n\n' + prompt } } };
  };
}

module.exports = { MAX_RELAY_INSTRUCTIONS, normalizeRelayInstructions, validateRelayInstructions, relayInstructionsPrompt, relayInstructionsToolHook };
