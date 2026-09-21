'use strict';

// Accept only the SDK's validated final structured_output, never intermediate
// assistant text or JSON scraped from markdown. Callers keep their local
// presentation fallback if a provider does not implement structured outputs.
async function collectStructuredOutput(messages, validate, onMessage = () => {}) {
  let result = null;
  for await (const event of messages) {
    onMessage(event);
    if (event.type === 'result') result = event;
  }
  if (!result || result.subtype !== 'success' || result.is_error
      || result.permission_denials?.length || /^aborted_/.test(result.terminal_reason || '')) {
    throw Object.assign(new Error('结构化输出未完成'), { code: 'STRUCTURED_OUTPUT_FAILED' });
  }
  if (!Object.hasOwn(result, 'structured_output')) {
    throw Object.assign(new Error('服务商没有返回结构化结果'), { code: 'STRUCTURED_OUTPUT_MISSING' });
  }
  const parsed = validate(result.structured_output);
  if (!parsed || parsed.success !== true) {
    throw Object.assign(new Error('结构化结果不符合约定格式'), { code: 'STRUCTURED_OUTPUT_INVALID' });
  }
  return parsed.data;
}
module.exports = { collectStructuredOutput };
