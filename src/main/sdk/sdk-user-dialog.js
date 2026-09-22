'use strict';

// Only register dialog kinds whose payload AND result are known. An unknown
// kind must reject, allowing another SDK consumer to handle it.
const SUPPORTED_DIALOG_KINDS = Object.freeze(['refusal_fallback_prompt']);
function createUserDialogHandler({ broker, context, onResolved } = {}) {
  return async (request, options = {}) => {
    if (!SUPPORTED_DIALOG_KINDS.includes(request?.dialogKind)) throw new Error('Unsupported SDK dialog kind');
    const scope = typeof context === 'function' ? context() : context || {};
    if (!scope.conversationId || !scope.runId || scope.windowId == null || scope.background || options.signal?.aborted) return { behavior: 'cancelled' };
    const data = request.payload;
    if (!data || typeof data.originalModel !== 'string' || typeof data.fallbackModel !== 'string') throw new Error('Invalid SDK refusal dialog payload');
    const sameProvider = new Set(scope.allowedModels || []).has(data.fallbackModel);
    const question = '当前模型未能处理这次请求，接下来如何处理？';
    const choices = [
      ...(sameProvider ? [{ label: '使用备用模型重试', description: `使用当前服务商配置的 ${data.fallbackModel}` }] : []),
      { label: '修改提示词', description: '返回输入框，调整本次要求后重新发送' },
      { label: '取消本次请求', description: '保留已有对话，等待下一条消息' },
    ];
    const result = await broker.registerToolUse({ toolName: 'AskUserQuestion', context: scope,
      input: { questions: [{ question, header: '模型请求', multiSelect: false, options: choices }] },
      sdkOptions: { ...options, requestId: JSON.stringify(['sdk-dialog', scope.conversationId, scope.runId, options.requestId]) } });
    const answer = result?.updatedInput?.answers?.[question];
    const choice = result?.behavior !== 'allow' ? 'cancelled'
      : sameProvider && answer === '使用备用模型重试' ? 'retry_fallback'
      : answer === '修改提示词' ? 'edit_prompt' : 'cancelled';
    // Do not retract on receipt: the task could end before the user resolves it.
    // The host checks ownership again before evicting any partial messages.
    if (!options.signal?.aborted) await onResolved?.({ request, choice, scope });
    return { behavior: 'completed', result: choice };
  };
}
module.exports = { SUPPORTED_DIALOG_KINDS, createUserDialogHandler };
