'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createBrowserPanelHost } = require('./browser-panel-host');
const { createBrowserProfileStore } = require('./browser-profile-store');

// Only the local main document owns browser tabs. Remote views never receive
// preload.js, and even a foreign renderer with a bridge cannot control them.
function registerBrowserPanelIpc({ ipcMain, getWindow, entryFile, createHost = createBrowserPanelHost,
  getElectron = () => require('electron'), profileRoot, profile: injectedProfile,
  getConversationContext,
  createAutomation = options => require('./browser-automation-service').createBrowserAutomationService(options) }) {
  const entryUrl = pathToFileURL(entryFile).href;
  let owner = null, host = null, disposed = false;
  let profile = injectedProfile;
  let formStore;
  let automation = null;
  let hostGeneration = 0;
  const feedbackResumes = new Map();
  const annotationLookups = new Map(), lookupCancelled = Symbol('annotation lookup cancelled');
  function cancelAnnotationLookups(predicate = () => true) {
    for (const [id, pending] of annotationLookups) {
      if (!predicate(pending, id)) continue;
      annotationLookups.delete(id); pending.cancel(lookupCancelled);
    }
  }
  function cancelFeedbackResumes(predicate = () => true) {
    for (const [id, pending] of feedbackResumes) if (predicate(pending, id)) feedbackResumes.delete(id);
  }
  const isTrusted = event => {
    const window = getWindow();
    try {
      return !!window && !window.isDestroyed() && !!event && event.sender === window.webContents
        && event.senderFrame === window.webContents.mainFrame
        && event.senderFrame.url.replace(/[?#].*$/, '') === entryUrl
        && window.webContents.getURL().replace(/[?#].*$/, '') === entryUrl;
    } catch (_) { return false; }
  };
  function getHost() {
    const window = getWindow();
    if (owner !== window || !host || host.isDestroyed()) {
      const generation = ++hostGeneration;
      cancelAnnotationLookups(); cancelFeedbackResumes();
      automation?.dispose(); automation = null;
      if (host) host.destroy();
      const { BaseWindow, WebContentsView, screen, session, shell, dialog, Menu, clipboard, app, safeStorage } = getElectron();
      if (!profile && (profileRoot || app)) profile = createBrowserProfileStore({ rootDir: profileRoot || path.join(app.getPath('userData'), 'browser'),
        downloadDirectory: app ? app.getPath('downloads') : '' });
      if (!formStore && profile?.rootDir) formStore = require('./browser-form-store').createBrowserFormStore({ filePath: path.join(profile.rootDir, 'forms.enc.json'), safeStorage });
      owner = window;
      const target = window;
      host = createHost({ owner: target, BaseWindow, WebContentsView, screen, session, shell, dialog, Menu, clipboard, profile, formStore,
        onEvent: payload => {
          if (disposed || generation !== hostGeneration || owner !== target || target !== getWindow()
            || target.isDestroyed() || target.webContents.isDestroyed()) return;
          const hadFeedbackAuthority = feedbackResumes.has(payload?.id) || annotationLookups.has(payload?.id);
          if (['manual-action', 'navigation-start', 'closed'].includes(payload?.type) && payload.id) {
            cancelAnnotationLookups((_pending, id) => id === payload.id);
          }
          if (['navigation-start', 'closed'].includes(payload?.type) && payload.id
            || payload?.type === 'manual-action' && payload.action !== 'annotation') {
            feedbackResumes.delete(payload.id);
          }
          if (['annotation-error', 'annotation-cancelled'].includes(payload?.type)
            && feedbackResumes.get(payload.id)?.requestId === payload.requestId) feedbackResumes.delete(payload.id);
          if (payload?.type === 'annotation') {
            const pending = feedbackResumes.get(payload.id);
            const current = automation?.control({ action: 'state', id: payload.id });
            if (pending && pending.requestId === payload.requestId && pending.generation === hostGeneration
              && current?.state === 'paused' && current.conversationId === pending.conversationId
              && current.controlRevision === pending.controlRevision) {
              pending.completed = true;
              const { id, conversationId, controlRevision, requestId } = pending;
              payload = { ...payload, browserResume: { id, conversationId, controlRevision, requestId } };
            } else feedbackResumes.delete(payload.id);
          }
          if (payload?.type === 'manual-action' && payload.id) {
            // control() revokes the lease synchronously, before the native menu
            // callback performs its navigation, edit, or saved-form insertion.
            // A paused page's subsequent keystrokes do not repeatedly dispose
            // its adapter, rewrite recovery data or broadcast the same state.
            if (payload.action === 'annotation' || payload.tab?.recovery?.state !== 'paused' || hadFeedbackAuthority) {
              automation?.control({ action: 'pause', id: payload.id, reason: '你已操作浏览器' });
            }
          }
          automation?.handleHostEvent?.(payload);
          if (!disposed && owner === target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
            target.webContents.send('browser:event', payload);
          }
        },
      });
    }
    return host;
  }
  function getAutomation() {
    // Prepare the host first: replacing it disposes all old page capabilities.
    getHost();
    if (!automation) {
      const target = owner;
      automation = createAutomation({ getHost, onEvent: payload => {
        if (!disposed && target === getWindow() && !target.isDestroyed() && !target.webContents.isDestroyed()) {
          target.webContents.send('browser:event', payload);
        }
      } });
    }
    return automation;
  }
  ipcMain.handle('browser:invoke', async (event, input) => {
    if (disposed || !isTrusted(event)) return { ok: false, code: 'FORBIDDEN', error: '此窗口不能操作内置浏览器' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_ACTION', error: '浏览器操作无效' };
    try {
      if (input.action === 'cancelFeedback') {
        const pending = feedbackResumes.get(input.id);
        if (pending?.requestId === input.requestId && pending.conversationId === input.conversationId) feedbackResumes.delete(input.id);
        return { ok: true };
      }
      if (input.action === 'resumeFeedback') {
        const pending = feedbackResumes.get(input.id);
        const service = getAutomation();
        const current = service.control({ action: 'state', id: input.id });
        if (!pending?.completed || pending.generation !== hostGeneration || pending.requestId !== input.requestId
          || pending.conversationId !== input.conversationId || pending.controlRevision !== input.controlRevision
          || current.state !== 'paused' || current.conversationId !== pending.conversationId
          || current.controlRevision !== pending.controlRevision) {
          return { ok: false, code: 'STALE_LEASE', error: '网页控制状态已改变，请在浏览器中允许继续' };
        }
        // Consume before resuming. A delayed or repeated send cannot re-authorize input.
        feedbackResumes.delete(input.id);
        return service.control({ action: 'resume', id: pending.id, conversationId: pending.conversationId,
          expectedControlRevision: pending.controlRevision });
      }
      if (input.action === 'automation') {
        if (input.command !== 'state') feedbackResumes.delete(input.id);
        return await getAutomation().control({ action: input.command, id: input.id, conversationId: input.conversationId });
      }
      if (input.action === 'automationPauseConversation') {
        cancelAnnotationLookups(pending => pending.conversationId === input.conversationId);
        cancelFeedbackResumes(pending => pending.conversationId === input.conversationId);
        automation?.pauseConversation(input.conversationId, '用户已暂停此会话的网页');
        return { ok: true };
      }
      if (input.action === 'taskTabs.list') return getHost().listTaskTabs(input.conversationId);
      if (input.action === 'restoreTaskTabs') {
        // Restored events must reach a live service so every restored page gets
        // a fresh paused entry, never its pre-restart authority or observations.
        getAutomation().pauseConversation?.(input.conversationId, '恢复网页后请重新观察');
        return getHost().restoreTaskTabs(input.conversationId);
      }
      if (input.action === 'annotation.cancel') {
        feedbackResumes.delete(input.id);
        cancelAnnotationLookups((_pending, id) => id === input.id);
        return getHost().cancelAnnotation(input.id);
      }
      if (input.action === 'annotation.start') {
        const service = getAutomation(), currentHost = host, generation = hostGeneration;
        const previousResume = feedbackResumes.get(input.id);
        feedbackResumes.delete(input.id);
        if (typeof getConversationContext !== 'function') return { ok: false, code: 'INVALID_CONTEXT', error: '当前任务目录暂不可用，无法保存网页批注' };
        const before = service.control({ action: 'state', id: input.id });
        cancelAnnotationLookups((_pending, id) => id === input.id);
        currentHost.cancelAnnotation(input.id);
        const targetCurrent = currentHost.captureAnnotationTarget(input.id, input.conversationId);
        let cancel;
        const cancelled = new Promise(resolve => { cancel = resolve; });
        const pending = { conversationId: input.conversationId, cancel };
        annotationLookups.set(input.id, pending);
        let context;
        try { context = await Promise.race([getConversationContext(input.conversationId), cancelled]); }
        finally { if (annotationLookups.get(input.id) === pending) annotationLookups.delete(input.id); }
        if (disposed || generation !== hostGeneration || currentHost !== host || owner !== getWindow() || host.isDestroyed()) {
          return { ok: false, code: 'STALE_TARGET', error: '浏览器窗口已更换，请重新选择网页' };
        }
        if (context === lookupCancelled || !targetCurrent()) return { ok: false, code: 'ANNOTATION_CANCELLED', error: '网页批注已取消，请重新选择' };
        const current = service.control({ action: 'state', id: input.id });
        const inheritedResume = previousResume?.completed && previousResume.generation === generation
          && previousResume.conversationId === before.conversationId && previousResume.controlRevision === before.controlRevision;
        const mayResume = before.ok && before.conversationId === input.conversationId && (before.state !== 'paused' || inheritedResume)
          && current.conversationId === before.conversationId && current.controlRevision === before.controlRevision;
        const paused = service.control({ action: 'pause', id: input.id, conversationId: input.conversationId, reason: '正在选择网页批注' });
        if (!paused?.ok) return paused;
        return await currentHost.startAnnotation(input.id, { conversationId: input.conversationId, mode: input.mode,
          contextRoot: context?.cwd || context?.rootDir, onPaused({ requestId }) {
            const state = service.control({ action: 'state', id: input.id });
            if (mayResume && state.ok && state.state === 'paused' && Number.isSafeInteger(state.controlRevision)
              && state.conversationId === input.conversationId) feedbackResumes.set(input.id, {
              id: input.id, conversationId: input.conversationId, controlRevision: state.controlRevision,
              requestId, generation, completed: false,
            });
          } });
      }
      if (input.action === 'visibility') cancelAnnotationLookups((_pending, id) => !input.visible || input.id && input.id !== id);
      if (['navigate', 'back', 'forward', 'reload', 'stop', 'close', 'zoom'].includes(input.action)) {
        const id = input.id || host?.state().activeId;
        cancelAnnotationLookups((_pending, targetId) => targetId === id);
      }
      // Manual navigation/refresh/closing must revoke outstanding automation
      // before changing the page. This path cannot be reached by remote pages.
      if (automation && ['navigate', 'back', 'forward', 'reload', 'stop', 'close', 'zoom', 'passwords.fill', 'contacts.fill', 'print', 'devTools'].includes(input.action)) {
        const id = input.id || host?.state().activeId;
        if (id) { feedbackResumes.delete(id); await automation.control({ action: 'pause', id, reason: '你已操作浏览器' }); }
      }
      // CSS geometry is measured in the renderer; the actual display scale is
      // owned by Electron, never trusted from the request or devicePixelRatio.
      const request = input.action === 'setBounds'
        ? { ...input, coordinateScale: event.sender.getZoomFactor() } : input;
      return await getHost().invoke(request);
    } catch (error) {
      const profileErrors = { BROWSER_PROFILE_INVALID: '浏览器资料读取失败，原文件已保留', BROWSER_PROFILE_WRITE_FAILED: '浏览器资料保存失败，请检查磁盘空间和目录权限',
        BROWSER_TASK_STATE_INVALID: '任务网页恢复记录读取失败，原文件已保留', BROWSER_TASK_STATE_WRITE_FAILED: '任务网页恢复记录保存失败，请检查磁盘空间和目录权限',
        BROWSER_TASK_STATE_LIMIT: '任务网页恢复记录已达上限，请关闭不再使用的网页',
        INVALID_CONTEXT: '当前任务目录暂不可用，无法保存网页批注', INVALID_CONVERSATION: '任务标识无效',
        TAB_NOT_FOUND: '这个网页标签已关闭', TAB_NOT_OWNED: '请先将此网页交给当前任务', PRIVATE_TAB: '私密网页不允许任务批注',
        INVALID_ANNOTATION: '批注选择无效，请重新选择', BROWSER_NOT_VISIBLE: '请先显示需要操作的网页',
        ANNOTATION_CANCELLED: '网页批注已取消，请重新选择', ANNOTATION_NOT_READY: '网页显示区域尚未就绪，请稍后重新打开批注',
        UNSAFE_ARTIFACT_PATH: '批注保存目录不安全，请检查任务目录' };
      if (Object.hasOwn(profileErrors, error?.code)) return { ok: false, code: error.code, error: profileErrors[error.code] };
      return { ok: false, code: 'BROWSER_FAILED', error: '浏览器暂时无法打开，请重试' };
    }
  });
  return {
    async automationInvoke(context, input) {
      const target = getWindow();
      if (disposed || !target || target.isDestroyed()) return { ok: false, code: 'BROWSER_CLOSED', error: '浏览器窗口尚未就绪' };
      return getAutomation().invoke(context, input);
    },
    automationPauseAll(reason) { cancelAnnotationLookups(); if (!['run-ended', 'run-finished', 'run-stopped', 'run-failed', 'session-closed', 'run-replaced', 'all-runs-stopped'].includes(reason)) cancelFeedbackResumes(); automation?.pauseAll(reason); },
    automationPauseConversation(conversationId, reason) { cancelAnnotationLookups(pending => pending.conversationId === conversationId); if (!['run-ended', 'run-finished', 'run-stopped', 'run-failed', 'session-closed', 'run-replaced', 'all-runs-stopped'].includes(reason)) cancelFeedbackResumes(pending => pending.conversationId === conversationId); automation?.pauseConversation(conversationId, reason); },
    // Main-process entry for links opened by the mini window or Electron's
    // navigation guard. This does not grant those renderers browser control.
    async openLink(url, options) {
      const target = getWindow();
      if (disposed || !target || target.isDestroyed()) return { ok: false, error: '浏览器页面尚未就绪，请重试' };
      const conversationId = options?.conversationId;
      const response = await getHost().invoke({ action: 'openLink', url, ...(conversationId ? { conversationId } : {}) });
      if (response?.ok && response.tab && !disposed && target === getWindow()
        && !target.isDestroyed() && !target.webContents.isDestroyed()) {
        target.webContents.send('browser:event', { type: 'open-link', tab: response.tab });
      }
      return response;
    },
    dispose() {
      if (disposed) return;
      disposed = true; ipcMain.removeHandler('browser:invoke');
      cancelAnnotationLookups(); cancelFeedbackResumes();
      automation?.dispose(); automation = null;
      if (host) host.destroy();
      host = null; owner = null;
    },
  };
}

module.exports = { registerBrowserPanelIpc };
