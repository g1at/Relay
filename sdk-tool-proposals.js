'use strict';

// These SDK tools have product decisions beyond ordinary file/tool permission.
// A human answer is still required even when general permission is bypassed.
function createToolProposalHook({ broker, context }) {
  return async (input, toolUseId, { signal } = {}) => {
    const scope = context();
    const name = input.tool_name, data = input.tool_input || {};
    if (name !== 'ProposeGoal' && !(name === 'ExitWorktree' && data.action === 'remove' && data.discard_changes === true)) return {};
    const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    if (!scope.runId || !scope.conversationId || scope.windowId == null || scope.background || input.agent_id || scope.executionMode?.kind === 'plan') return deny('当前任务不能发起此操作');
    if (name === 'ProposeGoal' && (typeof data.condition !== 'string' || !data.condition.trim() || data.condition.length > 500)) return deny('目标完成条件无效');
    const question = name === 'ProposeGoal' ? `将这个完成条件设为当前目标？\n${data.condition}` : '删除工作树并放弃其中尚未提交或合并的改动？';
    const yes = name === 'ProposeGoal' ? '设为目标' : '放弃改动并删除';
    const response = await broker.registerToolUse({ toolName: 'AskUserQuestion', context: scope,
      input: { questions: [{ question, header: name === 'ProposeGoal' ? '目标建议' : '工作树', multiSelect: false,
        options: [{ label: yes, description: name === 'ProposeGoal' ? '让 SDK 按此条件持续执行，并保留现有对话' : '删除当前工作树及分支，这些改动无法恢复' },
          { label: '取消', description: '保留当前状态' }] }] },
      sdkOptions: { signal, requestId: JSON.stringify(['sdk-proposal', scope.conversationId, scope.runId, toolUseId || input.tool_use_id]), toolUseID: toolUseId || input.tool_use_id } });
    if (response.behavior !== 'allow' || response.updatedInput?.answers?.[question] !== yes) return deny('用户未批准此建议');
    if (signal?.aborted || context().runId !== scope.runId) return deny('任务已改变');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: name === 'ProposeGoal' ? { ...data, ask_user: false } : data } };
  };
}
module.exports = { createToolProposalHook };
