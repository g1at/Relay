(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelayConversationErrors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CANCELED = new Set(['paused', 'canceled', 'cancelled', 'aborted']);
  const COMPLETED = new Set(['complete', 'completed', 'succeeded', 'success']);
  const FAILED = new Set(['error', 'failed']);
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = value => typeof value === 'string' ? value.trim() : '';
  const status = value => text(value).toLowerCase();
  const errorText = value => text(value) || text(object(value).message);
  const isChild = value => !!(value.parent_tool_use_id || value.subagent_type || value.parent);

  // History may contain a saved failed activity with no final answer and no
  // top-level error. Read only whole-turn evidence, never a failed child tool.
  function forTurn(value) {
    const turn = object(value), output = object(turn.output), activity = object(turn.activity);
    const turnStatus = status(turn.status), outputStatus = status(output.status);
    if (CANCELED.has(turnStatus) || CANCELED.has(outputStatus)) return '';
    if ((COMPLETED.has(outputStatus) && text(output.final))
        || (COMPLETED.has(turnStatus) && (text(turn.assistant) || text(output.final)))) return '';

    const explicit = errorText(turn.error);
    if (explicit) return explicit;
    const failedActivity = !isChild(activity) && status(activity.phase) === 'error';
    const activityError = failedActivity ? errorText(activity.error) : '';
    // Older renderers recorded a user pause through Activity.finish(error).
    if (/^(?:已暂停|已由用户中止|已中止|任务已取消)$/.test(activityError)) return '';
    if (activityError) return activityError;

    const result = object(output.lastResult);
    const fresh = !(Number.isFinite(output.revision) && Number.isFinite(output.resultRevision))
      || output.revision === output.resultRevision;
    if (fresh && result.type === 'result' && !isChild(result)) {
      if (/^aborted_(?:streaming|tools)$/.test(text(result.terminal_reason))) return '';
      const failed = result.is_error === true || /^(?:error(?:_|$)|failed$)/.test(status(result.subtype));
      if (failed) {
        const details = Array.isArray(result.errors) ? result.errors.map(errorText).filter(Boolean).join('\n') : '';
        const original = details || errorText(result.error) || text(result.result) || '任务执行失败';
        return text(result.relay_error_description) ? `${result.relay_error_description}\n\n${original}` : original;
      }
    }
    return FAILED.has(turnStatus) || FAILED.has(outputStatus) || failedActivity
      ? '任务执行失败' : '';
  }

  return { forTurn };
});
