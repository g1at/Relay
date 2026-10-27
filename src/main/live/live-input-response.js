'use strict';

// Reconnecting an offline MCP can serialize the native CLI control channel.
// Wait for an explicitly attributed model response before starting that work.
class LiveInputResponse {
  constructor() { this.waiters = new Map(); this.closed = false; }

  wait(inputId, { signal, timeoutMs = 60000 } = {}) {
    if (this.closed || typeof inputId !== 'string' || !inputId || inputId.length > 200 || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer, settled = false;
      let entries = this.waiters.get(inputId);
      if (!entries) this.waiters.set(inputId, entries = new Set());
      const finish = responded => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        entries.delete(finish);
        if (!entries.size && this.waiters.get(inputId) === entries) this.waiters.delete(inputId);
        resolve(responded);
      };
      const aborted = () => finish(false);
      entries.add(finish);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(aborted, Math.max(1, Math.min(Number(timeoutMs) || 60000, 60000)));
    });
  }

  observe(event) {
    if (!event || this.closed || event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type) return;
    const response = event.type === 'assistant' || event.type === 'result'
      || event.type === 'stream_event' && event.event?.type === 'message_start';
    if (!response) return;
    const ids = new Set([event.user_message_uuid, ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])]);
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      for (const finish of [...(this.waiters.get(id) || [])]) finish(true);
    }
  }

  cancel() {
    for (const entries of [...this.waiters.values()]) for (const finish of [...entries]) finish(false);
  }

  close() { this.closed = true; this.cancel(); }
}

module.exports = { LiveInputResponse };
