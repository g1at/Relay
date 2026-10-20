'use strict';

const { randomUUID } = require('node:crypto');
const { createBrowserAutomationAdapter } = require('./browser-automation-adapter');
const { readEvidence, appendEvidence, saveScreenshot } = require('./browser-evidence-store');
const { resolveUploadFiles, resolveDownloadDirectory } = require('./browser-automation-files');

const READ_ACTIONS = new Set(['list', 'observe', 'verify', 'wait', 'diagnostics', 'downloads', 'evidence', 'screenshot', 'frames', 'locate']);
const ACTIONS = new Set([...READ_ACTIONS, 'open', 'act', 'upload', 'download', 'navigate', 'focus', 'close']);
const INPUT_ACTIONS = new Set(['act', 'upload', 'download', 'screenshot']);
const RUN_END_REASONS = new Set(['run-ended', 'run-finished', 'run-stopped', 'run-failed', 'session-closed', 'run-replaced', 'all-runs-stopped']);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function resultError(error, extra = {}) {
  return { ok: false, code: error.code || 'AUTOMATION_FAILED', error: error.code ? error.message : '浏览器自动化操作失败', ...extra };
}
function actionFailure(error, attempted) {
  if (!attempted) return {};
  return error.inputDispatched === false ? { outcome: 'not-executed' }
    : { outcome: 'unknown', retryable: false, recovery: '操作可能已经生效。请重新观察并验证结果，不要直接重试。' };
}
function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw failure('INVALID_CONTEXT', `${name}无效`);
  return value;
}
function aborted(signal) {
  if (signal?.aborted) throw typeof signal.reason?.code === 'string' ? signal.reason : failure('AUTOMATION_ABORTED', '浏览器操作已取消');
}
function raceAbort(work, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Main-process only. Model input never supplies task identity or gains a tab lease. */
function createBrowserAutomationService({ getHost, onEvent = () => {}, createAdapter = createBrowserAutomationAdapter,
  visibilityTimeoutMs = 5000 } = {}) {
  if (typeof getHost !== 'function') throw new TypeError('getHost is required');
  const entries = new Map();
  const artifacts = [];
  const evidenceWrites = new Map();
  let disposed = false;
  let revision = 0, controlRevision = 0;

  function emit(event) { try { onEvent(event); } catch (_) {} }
  function status(entry) {
    return { id: entry.id, conversationId: entry.conversationId, state: entry.state, reason: entry.reason || null,
      revision: entry.revision, controlRevision: entry.controlRevision };
  }
  function state(entry, value, reason = null) {
    entry.state = value; entry.reason = reason;
    entry.revision = ++revision;
    let liveTarget;
    try { liveTarget = entry.host.getAutomationTarget?.(entry.id); }
    catch (error) {
      // Native close removes the tab before announcing it. Releasing its lease
      // must still publish state and let the closed event reach the renderer.
      if (!['TAB_NOT_FOUND', 'TAB_CLOSED', 'BROWSER_CLOSED'].includes(error?.code)) throw error;
    }
    if (liveTarget) entry.host.setTaskBinding?.(entry.id, { conversationId: entry.conversationId, state: value, reason });
    emit({ type: 'automation-state', ...status(entry) });
  }
  function invalidate(entry, code, reason) {
    entry.generation++;
    entry.controller.abort(failure(code, reason));
    entry.controller = new AbortController();
    try { entry.adapter?.dispose(); } catch (_) {}
    entry.adapter = null;
    entry.runId = null;
  }
  function release(entry, reason = '任务已释放此网页') {
    entry.controlRevision = ++controlRevision;
    invalidate(entry, 'AUTOMATION_RELEASED', reason);
    entries.delete(entry.id);
    entry.conversationId = null;
    state(entry, 'unbound', reason);
  }
  function pause(entry, reason = '用户已接管网页') {
    entry.controlRevision = ++controlRevision;
    invalidate(entry, 'AUTOMATION_PAUSED', reason);
    state(entry, 'paused', reason);
  }
  function revokeRun(entry, reason) {
    const userPaused = entry.state === 'paused', oldReason = entry.reason;
    invalidate(entry, 'AUTOMATION_ABORTED', '任务运行已停止，请重新观察');
    const message = reason === 'run-finished' ? '本轮操作已结束，后续操作会重新观察网页' : '本轮操作已停止，后续操作会重新观察网页';
    state(entry, userPaused ? 'paused' : 'controlled', userPaused ? oldReason : message);
  }
  function current(context) {
    if (disposed) throw failure('AUTOMATION_CLOSED', '浏览器自动化服务已关闭');
    if (!context || typeof context !== 'object') throw failure('INVALID_CONTEXT', '浏览器工具缺少任务上下文');
    requiredId(context.conversationId, '任务'); requiredId(context.runId, '运行');
    aborted(context.signal);
    if (typeof context.isCurrent === 'function' && !context.isCurrent()) throw failure('STALE_RUN', '此任务运行已结束，请在当前运行重新调用');
  }
  function target(host, id) {
    const found = host?.getAutomationTarget(id);
    if (!found?.webContents || found.webContents.isDestroyed?.()) throw failure('TAB_CLOSED', '网页已经关闭');
    if (found.privateSession) throw failure('PRIVATE_TAB', '私密网页不允许自动化控制');
    return found;
  }
  function makeEntry(host, item, conversationId) {
    if (item.ownerConversationId && item.ownerConversationId !== conversationId) throw failure('TAB_NOT_OWNED', '此网页属于其他会话');
    const entry = { id: item.id, conversationId, host, webContents: item.webContents, state: 'controlled', reason: null,
      generation: 0, controller: new AbortController(), queue: Promise.resolve(), adapter: null, runId: null,
      revision: 0, controlRevision: ++controlRevision };
    entries.set(entry.id, entry);
    state(entry, 'controlled');
    return entry;
  }
  function owned(context, id) {
    requiredId(id, '网页');
    const entry = entries.get(id);
    if (!entry || entry.conversationId !== context.conversationId) throw failure('TAB_NOT_OWNED', '此网页未授权给当前任务；请先在浏览器工具栏授权');
    if (entry.state === 'paused') throw failure('AUTOMATION_PAUSED', `${entry.reason || '网页控制已暂停'}；请点击继续后重新观察网页`);
    if (getHost() !== entry.host || target(entry.host, id).webContents !== entry.webContents) {
      release(entry, '网页目标已更换');
      throw failure('STALE_TARGET', '网页目标已更换，请重新授权');
    }
    return entry;
  }
  function tabInfo(entry) {
    const item = target(entry.host, entry.id), wc = item.webContents;
    if (wc !== entry.webContents) throw failure('STALE_TARGET', '网页目标已更换');
    return { ...status(entry), ownerConversationId: item.ownerConversationId || entry.conversationId,
      url: wc.getURL?.() || '', title: wc.getTitle?.() || '', presented: item.presented === true,
      backgroundCapable: item.backgroundCapable === true };
  }
  function guard(entry, context, generation, signal) {
    current(context); aborted(signal);
    if (entries.get(entry.id) !== entry || entry.generation !== generation || entry.state === 'paused') {
      throw failure('STALE_LEASE', '网页控制权已改变，请重新观察');
    }
    if (getHost() !== entry.host) throw failure('STALE_TARGET', '浏览器窗口已更换');
    const item = target(entry.host, entry.id);
    if (item.webContents !== entry.webContents) throw failure('STALE_TARGET', '网页进程已更换');
    return item;
  }
  async function waitPresented(check, signal) {
    const deadline = Date.now() + visibilityTimeoutMs;
    while (!check().presented) {
      if (Date.now() >= deadline) throw failure('BROWSER_NOT_VISIBLE', '网页尚未显示。请切回此任务并关闭遮挡网页的弹窗后继续');
      await raceAbort(new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, deadline - Date.now())))), signal);
    }
  }
  async function present(entry, context, check, signal) {
    // The renderer owns the active task, panel geometry and modal visibility.
    // Never activate a native view behind its back or report focus before layout.
    check();
    emit({ type: 'automation-open', tab: tabInfo(entry), conversationId: context.conversationId, reveal: true });
    await waitPresented(check, signal);
    check();
  }

  async function open(context, input) {
    const host = getHost(); current(context);
    if (!host) throw failure('BROWSER_CLOSED', '浏览器窗口不可用');
    // Host validates the URL and creates synchronously. Never retry a create with an unknown outcome.
    const created = await host.invoke({ action: 'create', url: input.url, conversationId: context.conversationId });
    if (!created?.ok) throw failure(created?.code || 'BROWSER_FAILED', created?.error || '无法创建网页');
    const item = target(host, created.tab?.id || created.id);
    const entry = makeEntry(host, item, context.conversationId);
    try { current(context); if (getHost() !== host) throw failure('STALE_TARGET', '浏览器窗口已更换'); }
    catch (error) { release(entry, '创建网页期间任务已停止'); throw error; }
    emit({ type: 'automation-open', tab: { ...created.tab, ...tabInfo(entry) }, conversationId: context.conversationId });
    // Presentation belongs to the renderer. A background task must not wait for
    // a panel mount, activate a different conversation, or create duplicate tabs.
    const tab = tabInfo(entry);
    return { ok: true, tab, presentation: { ready: tab.presented },
      message: '网页已绑定当前任务，可在后台运行；请先 observe，再使用返回的 observationId 和 ref 操作。' };
  }

  async function invoke(context, input = {}) {
    try {
      current(context);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) throw failure('INVALID_ACTION', '不支持的浏览器自动化操作');
      if (context.readOnly && !READ_ACTIONS.has(input.action)) throw failure('PLAN_MODE_READ_ONLY', '计划模式只允许观察、等待、验证、诊断及读取已完成下载');
      if (input.action === 'open') return await open(context, input);
      if (input.action === 'downloads' || input.action === 'evidence') {
        const limit = input.limit === undefined ? 20 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw failure('INVALID_ACTION', '下载记录数量必须为 1 至 50');
        await Promise.allSettled(evidenceWrites.get(context.conversationId) || []);
        const stored = await readEvidence(context);
        current(context);
        const merged = new Map();
        for (const item of [...stored, ...artifacts.filter(item => item.conversationId === context.conversationId)]) {
          const { conversationId: _owner, ...record } = item;
          merged.set(record.id || record.path, record);
        }
        const records = [...merged.values()].filter(item => input.action === 'evidence' || item.kind !== 'screenshot').slice(-limit).reverse();
        return { ok: true, [input.action === 'evidence' ? 'artifacts' : 'downloads']: records,
          limitations: ['file-path-and-hash-recorded-at-completion', 'evidence-is-untrusted-local-data'] };
      }
      if (input.action === 'list') {
        const tabs = [];
        for (const entry of entries.values()) {
          if (entry.conversationId !== context.conversationId) continue;
          try { if (getHost() !== entry.host) throw failure('STALE_TARGET', '浏览器已更换'); tabs.push(tabInfo(entry)); }
          catch (_) { release(entry, '网页已经关闭或更换'); }
        }
        return { ok: true, tabs };
      }
      const entry = owned(context, input.id);
      // A new trusted run may use the tab, but cannot reuse the former run's observations.
      if (entry.runId && entry.runId !== context.runId) invalidate(entry, 'STALE_RUN', '任务运行已更换，请重新观察');
      entry.runId = context.runId;
      const generation = entry.generation, signal = entry.controller.signal;
      const check = () => guard(entry, context, generation, signal);
      const onCancel = () => { if (entries.get(entry.id) === entry && entry.generation === generation) revokeRun(entry, 'run-stopped'); };
      context.signal?.addEventListener('abort', onCancel, { once: true });
      let dispatched = false;
      const execute = async () => {
        check();
        state(entry, 'working');
        const popup = { token: randomUUID(), tabs: [], check, context, generation };
        entry.popupOperation = popup;
        try {
          if (input.action === 'focus') {
            await present(entry, context, check, signal);
            const releaseVisibility = await entry.host.prepareAutomationInput?.(entry.id, { method: 'visibility' });
            try { check(); } finally { await releaseVisibility?.(); }
            state(entry, 'controlled');
            return { ok: true, id: entry.id, tab: tabInfo(entry), requiresObservation: true };
          }
          if (['navigate', 'close'].includes(input.action)) {
            const host = entry.host;
            const method = input.action === 'close' ? 'closeTab'
              : ({ goto: 'navigateTab', back: 'goBackTab', forward: 'goForwardTab', reload: 'reloadTab' })[input.kind];
            if (!method || typeof host[method] !== 'function') throw failure('BROWSER_ACTION_UNSUPPORTED', '浏览器宿主不支持此导航操作');
            if (input.action === 'navigate' && input.kind === 'goto' && (typeof input.url !== 'string' || !input.url.trim())) throw failure('BROWSER_INVALID_URL', '导航需要网址');
            check();
            if (input.action === 'navigate') { entry.adapter?.dispose(); entry.adapter = null; }
            dispatched = true;
            const navigationWork = Promise.resolve(host[method](entry.id, input.url));
            const navigation = input.action === 'close' ? await navigationWork : await raceAbort(navigationWork, signal);
            if (navigation?.ok === false) throw failure(navigation.code || 'BROWSER_NAVIGATION_FAILED', navigation.error || '网页导航失败');
            if (input.action === 'close') { if (entries.get(entry.id) === entry) release(entry, '网页已关闭'); return { ok: true, id: input.id, closed: true }; }
            check(); state(entry, 'controlled');
            return { ok: true, id: entry.id, tab: tabInfo(entry), requiresObservation: input.action === 'navigate' };
          }
          const inputCheck = () => {
            const item = check();
            if (INPUT_ACTIONS.has(input.action) && !item.presented && !item.backgroundCapable) {
              throw failure('BROWSER_BACKGROUND_UNAVAILABLE', '此网页的后台执行环境尚未就绪');
            }
            return item;
          };
          if (INPUT_ACTIONS.has(input.action)) {
            inputCheck();
            // The host derives hidden-input authority from the current task
            // lease. This preflight must finish before any adapter side effect.
            const releaseVisibility = await entry.host.prepareAutomationInput?.(entry.id, { method: 'visibility' });
            try { check(); } finally { await releaseVisibility?.(); }
          }
          check();
          if (!entry.adapter) entry.adapter = createAdapter({ webContents: entry.webContents });
          const options = { signal, check: inputCheck, isBackground: () => !check().presented,
            waitForBackgroundReady: async () => {
              const ready = check().backgroundReady;
              if (ready) await raceAbort(ready, signal);
              check();
            }, onInput: async descriptor => {
            inputCheck();
            const release = await entry.host.prepareAutomationInput?.(entry.id, descriptor);
            let releasePopup;
            try {
              inputCheck();
              const p = descriptor.params || {};
              const startsGesture = descriptor.method === 'Input.synthesizeTapGesture'
                || descriptor.method === 'Input.dispatchMouseEvent' && p.type === 'mousePressed'
                || descriptor.method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.key === 'Enter';
              if (startsGesture && ['act', 'download'].includes(input.action)) releasePopup = entry.host.armAutomationPopup?.(entry.id, popup.token);
              return async () => { try { await release?.(); } finally { releasePopup?.(); } };
            } catch (error) { releasePopup?.(); await release?.(); throw error; }
          } };
          let work;
          if (input.action === 'upload') {
            const resolved = await resolveUploadFiles(context, input.files);
            inputCheck(); dispatched = true;
            work = entry.adapter.upload({ ...input, files: resolved.files }, options);
          } else if (input.action === 'download') {
            const directory = await resolveDownloadDirectory(context);
            inputCheck();
            if (typeof entry.host.beginAutomationDownload !== 'function') throw failure('BROWSER_DOWNLOAD_UNAVAILABLE', '此浏览器宿主暂不支持任务下载');
            const ticket = entry.host.beginAutomationDownload(entry.id, { directory, signal, check: inputCheck, timeoutMs: input.timeoutMs });
            // Consume early rejections while Chromium acknowledges the click.
            const completion = Promise.resolve(ticket.result).then(async value => {
              // A completed file belongs to the original task even if takeover
              // races with the click's post-action observation.
              const artifact = { ...value, kind: 'download', conversationId: context.conversationId, tabId: entry.id, completedAt: new Date().toISOString() };
              artifacts.push(artifact); if (artifacts.length > 200) artifacts.shift();
              const { conversationId: _owner, ...download } = artifact;
              const pending = appendEvidence(context, download);
              const writes = evidenceWrites.get(context.conversationId) || new Set();
              evidenceWrites.set(context.conversationId, writes); writes.add(pending);
              try { await pending; } catch (_) { download.evidenceWarning = '文件已完成，证据索引未持久化'; }
              finally { writes.delete(pending); if (!writes.size) evidenceWrites.delete(context.conversationId); }
              return { value: download };
            }, error => ({ error }));
            work = (async () => {
              let click, clickError;
              try {
                inputCheck(); dispatched = true;
                try { click = await entry.adapter.act({ kind: 'click', ref: input.ref, locator: input.locator, frameId: input.frameId, observationId: input.observationId }, { ...options, beforeClick: () => ticket.arm() }); }
                catch (error) {
                  if (error.inputDispatched === false || signal.aborted) throw error;
                  clickError = error;
                }
                const completed = await completion;
                if (completed.error) throw completed.error;
                check();
                const download = completed.value;
                return { executed: true, download, observation: click?.observation || null,
                  ...(clickError ? { observationError: clickError.code || 'BROWSER_OBSERVATION_FAILED', requiresObservation: true } : {}),
                  limitations: ['next-download-from-this-tab-after-click', 'one-file-per-call', 'file-integrity-is-not-business-content-verification'] };
              } finally { ticket.cancel(); }
            })();
          } else {
            dispatched = input.action === 'act';
            work = ['act', 'verify', 'wait', 'diagnostics', 'locate'].includes(input.action)
              ? entry.adapter[input.action](input, options) : entry.adapter[input.action](options, input);
          }
          const result = await raceAbort(work, signal);
          check();
          if (input.action === 'screenshot' && context.workspaceRoot && result?.data) {
            try { result.artifact = await saveScreenshot(context, result); if (result.artifact.evidenceWarning) result.evidenceWarning = result.artifact.evidenceWarning; }
            catch (_) { result.evidenceWarning = '截图已返回，但未能保存任务证据'; }
            check();
          }
          state(entry, 'controlled');
          return { ok: true, id: entry.id, ...result, ...(popup.tabs.length ? { openedTabs: popup.tabs, requiresObservation: true } : {}) };
        } catch (error) {
          // A frontmost popup can legitimately hide its opener after the gesture.
          // This proves only that the child opened; the model must observe it.
          if (popup.tabs.length && error.code === 'BROWSER_NOT_VISIBLE') {
            try { check(); state(entry, 'controlled'); return { ok: true, id: entry.id, executed: true,
              ...(input.waitFor ? { waitResult: { event: input.waitFor.event, satisfied: false, cancelled: true, reason: 'opener-hidden-by-popup' } } : {}),
              openedTabs: popup.tabs, requiresObservation: true, observation: null }; } catch (_) {}
          }
          if (entries.get(entry.id) === entry && entry.generation === generation) state(entry, 'error', error.code ? error.message : '操作失败');
          const outcome = !dispatched && ['act', 'upload', 'download'].includes(input.action)
            ? { outcome: 'not-executed' } : actionFailure(error, dispatched);
          return resultError(error, { ...outcome, ...(popup.tabs.length ? { openedTabs: popup.tabs } : {}) });
        } finally { if (entry.popupOperation === popup) entry.popupOperation = null; }
      };
      // The settled queue absorbs failures without poisoning later operations.
      const pending = entry.queue.then(execute);
      entry.queue = pending.catch(() => {});
      try { return input.action === 'close' ? await pending : await raceAbort(pending, signal); }
      catch (error) { return resultError(error, actionFailure(error, dispatched)); }
      finally { context.signal?.removeEventListener('abort', onCancel); }
    } catch (error) { return resultError(error); }
  }

  function control(input = {}) {
    try {
      if (disposed) throw failure('AUTOMATION_CLOSED', '浏览器自动化服务已关闭');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_ACTION', '浏览器控制命令无效');
      requiredId(input.id, '网页');
      let entry = entries.get(input.id);
      if (input.action === 'state') return { ok: true, ...(entry ? status(entry) : { id: input.id, conversationId: null, state: 'unbound', reason: null, revision, controlRevision }) };
      if (input.action === 'claim') {
        requiredId(input.conversationId, '任务');
        if (entry && entry.conversationId !== input.conversationId) throw failure('TAB_ALREADY_OWNED', '网页已绑定其他任务，请先释放控制权');
        if (!entry) { const host = getHost(); entry = makeEntry(host, target(host, input.id), input.conversationId); }
        return { ok: true, ...status(entry) };
      }
      if (!entry) throw failure('TAB_NOT_OWNED', '此网页尚未授权给任务');
      if (input.conversationId && input.conversationId !== entry.conversationId) throw failure('TAB_NOT_OWNED', '此网页属于其他任务');
      if (input.action === 'pause') pause(entry, input.reason || '用户已接管网页');
      else if (input.action === 'resume') {
        if (input.expectedControlRevision !== undefined && (entry.state !== 'paused'
            || input.expectedControlRevision !== entry.controlRevision)) {
          throw failure('STALE_LEASE', '网页控制状态已变化，请检查页面后点击允许继续');
        }
        const item = target(entry.host, entry.id);
        if (getHost() !== entry.host || item.webContents !== entry.webContents) throw failure('STALE_TARGET', '网页目标已更换，请重新授权');
        invalidate(entry, 'STALE_LEASE', '控制权已恢复，请重新观察');
        entry.controlRevision = ++controlRevision;
        state(entry, 'controlled');
      } else if (input.action === 'release') release(entry);
      else throw failure('INVALID_ACTION', '不支持的浏览器控制命令');
      return { ok: true, ...status(entry) };
    } catch (error) { return resultError(error); }
  }
  function pauseAll(reason = '用户已接管网页') { for (const entry of entries.values()) RUN_END_REASONS.has(reason) ? revokeRun(entry, reason) : pause(entry, reason); }
  function pauseConversation(conversationId, reason = '任务已切换') {
    for (const entry of entries.values()) if (entry.conversationId === conversationId) RUN_END_REASONS.has(reason) ? revokeRun(entry, reason) : pause(entry, reason);
  }
  function handleHostEvent(event) {
    if (event?.type === 'manual-action') { const entry = entries.get(event.id || event.tab?.id); if (entry && entry.state !== 'paused') pause(entry, '你已操作浏览器'); }
    if (event?.type === 'background-unavailable') {
      const entry = entries.get(event.id || event.tab?.id);
      if (entry && entry.state !== 'paused') pause(entry, '后台网页渲染环境已中断，恢复后需要确认');
    }
    if (event?.type === 'closed') { const entry = entries.get(event.id || event.tab?.id); if (entry) release(entry, '网页已关闭'); }
    if (event?.type === 'task-restored' && event.conversationId) {
      try {
        const host = getHost(), item = target(host, event.id || event.tab?.id);
        if (!entries.has(item.id)) { const entry = makeEntry(host, item, requiredId(event.conversationId, '任务')); pause(entry, '已恢复上次网页，请确认后允许继续并重新观察'); }
      } catch (_) { /* A stale restoration event cannot grant a target. */ }
    }
    if (event?.type === 'created' && event.openerId && event.automationOperationId) {
      const opener = entries.get(event.openerId), operation = opener?.popupOperation;
      if (!operation || operation.token !== event.automationOperationId || operation.tabs.length >= 4) return;
      try {
        operation.check();
        const item = target(opener.host, event.id || event.tab?.id);
        if (entries.has(item.id)) return;
        const child = makeEntry(opener.host, item, operation.context.conversationId);
        operation.tabs.push(tabInfo(child));
      } catch (_) { /* A cancelled, changed or private opener cannot grant a popup. */ }
    }
    // Other page-created tabs remain unclaimed; only a host-tagged input scope transfers task ownership.
  }
  function dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) pause(entry, '浏览器窗口已关闭，恢复后需要确认'); entries.clear(); }
  return { invoke, control, pauseAll, pauseConversation, handleHostEvent, dispose };
}

module.exports = { createBrowserAutomationService };
