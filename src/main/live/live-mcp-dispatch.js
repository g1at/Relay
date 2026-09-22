'use strict';

// Keep a turn cancellable while its existing Query discovers/synchronizes MCP.
// Registry, execution mode and connecting tools settle before input. Recovery
// of already failed MCP transports does not hold an ordinary message.
const { snapshotAttachments } = require('../sdk/attachment-input');

const PREPARATION_ERROR_CODES = new Set([
  'SESSION_START_TIMEOUT', 'SESSION_START_CANCELED',
  'MODE_INITIALIZATION_TIMEOUT', 'MODE_INPUT_START_TIMEOUT', 'MODE_PREPARE_TIMEOUT', 'MODE_PREPARE_CANCELED',
  'MODE_CONTEXT_RESET', 'MODE_INPUT_FAILED', 'GOAL_UNAVAILABLE',
  'MCP_PREPARE_SUPERSEDED',
]);

function dispatchLiveInput({ session, jobId, prompt, files, prepareInput, loadServers, isSessionCurrent, onStatus, onFailure, onTiming }) {
  const startedAt = Date.now();
  const timing = {};
  const attachments = snapshotAttachments(files);
  const pending = { jobId, controller: new AbortController() };
  session.pendingInput = pending;
  const current = () => session.pendingInput === pending && !pending.controller.signal.aborted
    && !session.dead && session.busy && session.jobId === jobId && isSessionCurrent();
  const status = (result) => { try { onStatus(result); } catch (_) {} };
  const fail = (message, stage, error) => {
    if (!current()) return;
    session.pendingInput = null;
    pending.controller.abort();
    // Only fixed stages/codes and elapsed time reach diagnostics. SDK errors
    // can carry prompts, file paths or credentials in their other properties.
    onFailure(message, { stage,
      code: PREPARATION_ERROR_CODES.has(error?.code) ? error.code : 'INPUT_PREPARATION_FAILED',
      elapsedMs: Date.now() - startedAt });
  };
  pending.done = Promise.resolve().then(async () => {
    if (!current()) return;
    if (typeof session.child.whenReady === 'function') {
      status({ phase: 'preparing', stage: 'initializing', items: [] });
      if (!current()) return;
      try { await session.child.whenReady({ signal: pending.controller.signal }); }
      catch (error) {
        fail(error.message || '会话准备失败', 'initialization', error);
        return;
      }
      if (!current()) return;
    }
    timing.startupMs = Date.now() - startedAt;
    const preparedAt = Date.now();
    status({ phase: 'preparing', items: [] });
    if (!current()) return;
    // Mode commands contain no model/tool work. Prepare them alongside the MCP
    // control channel, but never deliver the user prompt until both are settled.
    const modeReady = (async () => {
      if (typeof prepareInput !== 'function') return;
      pending.modePreparationPending = true;
      try { return await prepareInput(pending.controller.signal); }
      catch (error) {
        fail(error.message || '模式准备失败', 'mode', error);
        throw error;
      } finally {
        pending.modePreparationPending = false;
        timing.modeMs = Date.now() - preparedAt;
      }
    })();
    const mcpReady = (async () => {
      if (!current()) return { ok: false, canceled: true, items: [] };
      try {
        const deadline = Date.now() + 15000;
        for (let attempt = 0; attempt < 3; attempt++) {
          const servers = loadServers();
          const result = await session.child.prepareMcp({ servers, timeoutMs: Math.max(1, deadline - Date.now()),
            signal: pending.controller.signal, reconnect: false });
          if (!result.stale || !current() || Date.now() >= deadline) return result;
        }
        return { ok: false, stale: true, code: 'MCP_PREPARE_SUPERSEDED', items: [] };
      } catch (_) {
        // Never forward raw config/SDK errors which can contain credentials.
        return { ok: false, code: 'configuration-or-control', items: [] };
      } finally { timing.mcpMs = Date.now() - preparedAt; }
    })();
    const [preparedInput, result] = await Promise.all([modeReady, mcpReady]);
    if (!current()) return;
    if (result.stale) {
      fail('工具配置正在更新，请重新发送', 'tools', result);
      return;
    }
    status({ phase: 'settled', ...result });
    // An unrelated offline MCP must not prevent ordinary conversation. Its
    // real status is visible; successful servers remain available to the Query.
    if (!current()) return;
    const preparedPrompt = preparedInput && typeof preparedInput.prompt === 'string' ? preparedInput.prompt : prompt;
    const preparedFiles = preparedInput && Object.hasOwn(preparedInput, 'files') ? snapshotAttachments(preparedInput.files) : attachments;
    if (!session.child.push(preparedPrompt, { uuid: jobId, ...(preparedFiles.length ? { files: preparedFiles } : {}) })) throw new Error('输入未能发送，请重试');
    if (session.pendingInput === pending) session.pendingInput = null;
    try { if (typeof onTiming === 'function') onTiming({ ...timing, totalMs: Date.now() - startedAt }); } catch (_) {}
    if (!result.ok && !result.canceled) {
      // Do not keep the composer waiting for unrelated offline servers to retry.
      // Only the owning live run may receive later status; no prompt is resent.
      const belongsToRun = () => !pending.controller.signal.aborted && !session.dead
        && session.busy && session.jobId === jobId && isSessionCurrent();
      session.mcpBackgroundPreparation = Promise.resolve().then(async () => {
        if (!belongsToRun()) return;
        const settled = await session.child.prepareMcp({ servers: loadServers(), timeoutMs: 15000,
          signal: pending.controller.signal });
        if (belongsToRun() && !settled.canceled && !settled.stale) status({ phase: 'settled', ...settled });
      }).catch(() => {});
    }
  }).catch(() => {
    fail('输入未能发送，请重试', 'input');
  });
  return pending;
}

function cancelPendingLiveInput(session) {
  const pending = session && session.pendingInput;
  if (!pending) return false;
  session.pendingInput = null;
  pending.controller.abort();
  return true;
}

module.exports = { dispatchLiveInput, cancelPendingLiveInput };
