'use strict';

// Claude Code owns the retry of an individual API request, including its
// Retry-After/backoff and partial-stream safety. Never replay a Relay turn here.
// Verified against Agent SDK 0.3.266 / Claude Code 2.1.266:
// https://code.claude.com/docs/en/errors#tune-retry-behavior
const RETRY_ENV = Object.freeze({
  CLAUDE_CODE_RETRY_WATCHDOG: '1',
  CLAUDE_CODE_MAX_RETRIES: '2147483647',
});
const CONNECTION_FAILURE_LIMIT = 3;
const INTERRUPT_TIMEOUT_MS = 10000;
const CONNECTION_FAILURE_MESSAGE = '连续多次未能连接到模型服务，已停止本轮重试。请检查网络、代理或服务商地址，恢复后可继续对话。';
const RETRY_CONTROL_FAILURE = 'RELAY_RETRY_CONTROL_FAILED';

async function interruptFailedConnection(query, capabilities) {
  if (!capabilities?.includes('interrupt_cancel_queued_v1')) throw new Error('SDK cannot atomically cancel queued input');
  // Public sdk.mjs 0.3.266 accepts this option even though its Query interface
  // omits the parameter. The advertised CLI capability and receipt are checked
  // as well; never assume a legacy runtime drained its surviving input queue.
  const receipt = await query.interrupt({ cancelQueued: true });
  if (!Array.isArray(receipt?.cancelled) || !Array.isArray(receipt?.still_queued) || receipt.still_queued.length) {
    throw new Error('SDK did not confirm its input queue was canceled');
  }
  return receipt;
}

async function closeFailedRetryQuery(query) {
  // Query.return() is the public AsyncGenerator cleanup path. Unlike ending our
  // event iterator, it also closes the child transport and waits for its exit.
  try { query?.close?.(); } finally {
    if (typeof query?.return === 'function') await query.return();
  }
}

function isRoot(event) {
  return event && !event.parent_tool_use_id && !event.agent_id && !event.task_id;
}

class SdkRetryGuard {
  constructor({ interrupt, signal, enabled = true, interruptTimeoutMs = INTERRUPT_TIMEOUT_MS } = {}) {
    this.interrupt = interrupt;
    this.signal = signal;
    this.enabled = enabled;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.connectionFailures = 0;
    this.lastAttempt = null;
    this.pendingError = null;
    this.cancelWait = null;
    this.capabilities = [];
  }

  // An explicit user pause/cancel always wins a race with the connection guard.
  cancel() {
    this.pendingError = null;
    this.connectionFailures = 0;
    this.lastAttempt = null;
    if (this.cancelWait) this.cancelWait();
  }

  async interruptWithDeadline() {
    let timer, release;
    const canceled = new Promise(resolve => { release = resolve; });
    this.cancelWait = release;
    const aborted = () => release();
    this.signal?.addEventListener('abort', aborted, { once: true });
    try {
      if (this.signal?.aborted || !this.pendingError) return;
      await Promise.race([
        Promise.resolve().then(() => {
          if (this.pendingError && !this.signal?.aborted) return this.interrupt();
        }), canceled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK interrupt acknowledgement timed out')), this.interruptTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', aborted);
      if (this.cancelWait === release) this.cancelWait = null;
    }
  }

  async observe(event) {
    if (!this.enabled || !isRoot(event)) return event;
    if (this.signal?.aborted) { this.cancel(); return event; }

    if (event.type === 'system' && event.subtype === 'init') {
      this.capabilities = Array.isArray(event.capabilities) ? event.capabilities : [];
      return event;
    }

    if (event.type === 'result') {
      const error = this.pendingError;
      this.cancel();
      // A completed response can already be queued when the interrupt is sent.
      // It wins, as does a more precise native permanent error. Only reinterpret
      // the native abort caused by this guard, never rewrite a delivered answer.
      if (!error || !/^aborted_(streaming|tools)$/.test(String(event.terminal_reason || ''))) return event;
      // Keep the native result's usage, UUID and turn ownership. Distinguish an
      // unavailable connection from a user pause, without closing the session.
      return { ...event, subtype: 'error_during_execution', is_error: true,
        terminal_reason: 'api_error', result: error, errors: [error],
        relay_retry_stopped: 'connection_unavailable' };
    }

    const responseStarted = event.type === 'stream_event' && event.event?.type === 'message_start';
    const assistantResponse = event.type === 'assistant' && !event.isApiErrorMessage && !event.error;
    if (responseStarted || assistantResponse) {
      this.connectionFailures = 0;
      this.lastAttempt = null;
      return event;
    }

    if (event.type !== 'system' || event.subtype !== 'api_retry') return event;
    const enriched = { ...event, relay_retry_policy: 'persistent' };
    // Only null means there was no HTTP response. HTTP 429/5xx capacity errors
    // retain the SDK watchdog's ongoing retries; authentication/billing errors
    // are rejected by the SDK itself. Repeated countdown events are one attempt.
    if (event.error_status !== null) {
      this.connectionFailures = 0;
      this.lastAttempt = null;
      return enriched;
    }
    const attempt = Number(event.attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt === this.lastAttempt) return enriched;
    this.lastAttempt = attempt;
    this.connectionFailures++;
    if (this.connectionFailures < CONNECTION_FAILURE_LIMIT || this.pendingError) return enriched;
    this.pendingError = CONNECTION_FAILURE_MESSAGE;
    try {
      await this.interruptWithDeadline();
    } catch (error) {
      if (this.signal?.aborted || !this.pendingError) return enriched;
      const stopped = new Error(CONNECTION_FAILURE_MESSAGE, { cause: error });
      stopped.code = RETRY_CONTROL_FAILURE;
      throw stopped;
    }
    return enriched;
  }
}

module.exports = { RETRY_ENV, CONNECTION_FAILURE_LIMIT, CONNECTION_FAILURE_MESSAGE, RETRY_CONTROL_FAILURE,
  SdkRetryGuard, interruptFailedConnection, closeFailedRetryQuery };
