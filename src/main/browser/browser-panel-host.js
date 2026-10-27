'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resourcePath } = require('../app/paths');
const { chordFromEvent, validateChord } = require('../../../renderer/keyboard-shortcuts');
const WORKSPACE_ACTIONS = new Set(['newBrowser', 'openFiles', 'newTerminal', 'openReview']);
const { createBrowserProfileStore } = require('./browser-profile-store');
const { attachBrowserPageScrollbars } = require('./browser-page-scrollbars');
const { previewDocument, ownsPreviewUrl, installPreviewSession } = require('./browser-preview-session');
const { createAutomationDownload } = require('./browser-automation-downloads');
const { createBrowserTaskState, taskId } = require('./browser-task-state');
const { localBrowserAddress, createBrowserConnectionSecurity } = require('./browser-connection-security');
const { createBrowserFavicon } = require('./browser-favicon');
const BARE_HOST_PORT = /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+|\[[a-f\d:.]+\]):\d{1,5}(?:[/?#]|$)/i;

function resolveBrowserAddress(value, engine = 'bing') {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !localBrowserAddress(input) && !BARE_HOST_PORT.test(input)) return normalizeBrowserUrl(input);
  if (!/\s/.test(input) && (localBrowserAddress(input) || BARE_HOST_PORT.test(input) || /^[^/?#]+\.[^/?#]+/.test(input))) return normalizeBrowserUrl(input);
  if (input.length > 4000 || /[\u0000-\u001f]/.test(input)) throw browserError('INVALID_URL', '搜索内容过长或无效');
  const base = { bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=' }[engine] || 'https://www.bing.com/search?q=';
  return base + encodeURIComponent(input);
}
function localWebUrl(value) {
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.endsWith('.local')
    || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
function safeFilename(value, fallback = 'download') {
  let name = text(value, 180).replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function browserError(code, message) { return Object.assign(new Error(message), { code }); }
function normalizeBrowserUrl(value = 'about:blank') {
  let text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 16384 || /[\u0000-\u001f\u007f]/.test(text)) throw browserError('INVALID_URL', '请输入有效的网址');
  if (text === 'about:blank') return text;
  if (localBrowserAddress(text) && !/^https?:\/\//i.test(text)) text = 'http://' + text;
  else if (BARE_HOST_PORT.test(text)) text = 'https://' + text;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch (_) { throw browserError('INVALID_URL', '请输入有效的网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw browserError('UNSUPPORTED_URL', '内置浏览器仅支持 HTTP 和 HTTPS 网页');
  }
  return url.href;
}
function navigationAllowed(value) {
  try { return normalizeBrowserUrl(value) === value || ['http:', 'https:'].includes(new URL(value).protocol) && !new URL(value).username && !new URL(value).password; }
  catch (_) { return false; }
}
function text(value, max = 512) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max); }
function alive(contents) { return !!contents && !contents.isDestroyed(); }
function sendPage(contents, channel, payload) {
  try { if (!alive(contents) || typeof contents.send !== 'function') return false; contents.send(channel, payload); return true; }
  catch (_) { return false; } // A live WebContents can briefly have no main frame during navigation.
}

/**
 * One host belongs to one Relay window. Remote views have no Relay API preload or
 * default session. The caller must authenticate every invoke against the owner
 * renderer's mainFrame; never forward IPC arriving from these WebContents.
 * Rectangles are owner content coordinates in DIP, or CSS pixels accompanied
 * by coordinateScale (the owner's zoom factor). No OS coordinates are accepted.
 */
function createBrowserPanelHost({ owner, WebContentsView, BaseWindow, screen, session, shell, dialog, Menu, clipboard, profile, formStore, taskState, onEvent = () => {},
  idFactory = () => crypto.randomUUID(), now = Date.now, maxTabs = 16, platform = process.platform } = {}) {
  if (!owner || !owner.contentView || !WebContentsView || !session) throw new TypeError('Browser panel requires an owner, WebContentsView and session');
  const tabs = new Map();
  const store = profile || createBrowserProfileStore();
  let taskStore = taskState, taskStoreError = null;
  try { taskStore ||= createBrowserTaskState({ filePath: store.rootDir ? path.join(store.rootDir, 'task-tabs.json') : undefined, now }); }
  catch (error) { taskStoreError = error; }
  const persistent = !!store.sessionPath;
  if (persistent) fs.mkdirSync(store.sessionPath, { recursive: true });
  const browserSession = persistent ? session.fromPath(store.sessionPath) : null;
  const sessionListeners = new Map(), liveDownloads = new Map(), automationDownloads = new Map(), permissionPrompts = new Set();
  const hostId = crypto.randomUUID();
  let activeId = null, visible = false, destroyed = false, retiring = false, ownerSuspended = false;
  let requestedRect = { x: 0, y: 0, width: 0, height: 0 };
  let coordinateScale = 1;
  let workspaceBindings = new Map();

  function emit(type, tab, extra = {}) {
    if (destroyed) return;
    try { onEvent({ type, ...(tab ? { tab: snapshot(tab), id: tab.id } : {}), activeId, visible, ...extra }); } catch (_) {}
  }
  function snapshot(tab) {
    const wc = tab.view.webContents;
    const history = wc.navigationHistory;
    const read = (fn, fallback) => { try { return alive(wc) ? fn() : fallback; } catch (_) { return fallback; } };
    return { id: tab.id, title: tab.title || (tab.url === 'about:blank' ? '新标签页' : tab.url), url: tab.url,
      loading: tab.loading, canGoBack: read(() => history.canGoBack(), false), canGoForward: read(() => history.canGoForward(), false),
      historyIndex: read(() => history.getActiveIndex(), null), historyLength: read(() => history.length(), null),
      zoom: read(() => wc.getZoomFactor(), tab.zoom || 1), error: tab.error || null,
      connection: tab.connectionSecurity?.snapshot() || { state: 'none' },
      favicon: tab.faviconReader?.snapshot() || null,
      muted: read(() => !!wc.isAudioMuted?.(), false), audible: read(() => !!wc.isCurrentlyAudible?.(), false),
      bookmarked: !ownsPreviewUrl(tab.preview, tab.url) && !!store.getBookmark(tab.url),
      ownerConversationId: tab.ownerConversationId || null,
      ...(tab.conversationId ? { conversationId: tab.conversationId, recoveryId: tab.recoveryId,
        recovery: { state: tab.taskState || 'paused', requiresObservation: true, restored: !!tab.restored,
          ...(tab.taskPersistenceError ? { persistenceError: { ...tab.taskPersistenceError } } : {}) } } : {}),
      isPreview: ownsPreviewUrl(tab.preview, tab.url) };
  }
  function state(id) {
    const tab = id ? requireTab(id) : tabs.get(activeId);
    return { ok: true, ...(tab ? { id: tab.id, tab: snapshot(tab) } : {}), tabs: [...tabs.values()].map(snapshot), activeId, visible };
  }
  function requireTab(id) {
    const tab = tabs.get(String(id || ''));
    if (!tab) throw browserError('TAB_NOT_FOUND', '这个浏览器标签已关闭');
    return tab;
  }
  function requireTaskStore() {
    if (taskStoreError) throw taskStoreError;
    return taskStore;
  }
  function taskPersistenceFailed(tab, error) {
    const next = { code: error.code || 'BROWSER_TASK_STATE_WRITE_FAILED', error: text(error.message || '任务网页恢复记录未保存') };
    const changed = tab.taskPersistenceError?.code !== next.code || tab.taskPersistenceError?.error !== next.error;
    tab.taskPersistenceError = next;
    if (changed) emit('task-state-error', tab, next);
  }
  function taskPersistenceSaved(tab) {
    if (!tab.taskPersistenceError) return;
    tab.taskPersistenceError = null; emit('task-state-saved', tab);
  }
  function persistTask(tab) {
    if (!tab.conversationId || tab.privateSession || destroyed) return;
    try {
      const recovery = requireTaskStore();
      if (tab.url === 'about:blank') recovery.remove(tab.recoveryId);
      else recovery.upsert({ id: tab.recoveryId, conversationId: tab.conversationId, url: tab.url, title: tab.title });
      taskPersistenceSaved(tab);
    } catch (error) { taskPersistenceFailed(tab, error); }
  }
  function setTaskBinding(id, input = {}) {
    const tab = requireTab(id);
    if (input.conversationId == null || ['paused', 'unbound'].includes(input.state)) {
      tab.automationPopupOperationId = null; cancelAutomationInput(tab); cancelAnnotation(tab);
    }
    if (input.conversationId == null) {
      if (tab.recoveryId && !destroyed) {
        try { requireTaskStore().remove(tab.recoveryId); taskPersistenceSaved(tab); }
        catch (error) { taskPersistenceFailed(tab, error); }
      }
      cancelAnnotation(tab);
      tab.conversationId = null; tab.recoveryId = null; tab.taskState = null; tab.restored = false;
    } else {
      const conversationId = taskId(input.conversationId);
      if (tab.privateSession) throw browserError('PRIVATE_TAB', '私密网页不保存任务关联');
      if (tab.ownerConversationId && tab.ownerConversationId !== conversationId) throw browserError('TAB_ALREADY_OWNED', '网页属于其他会话');
      if (tab.conversationId && tab.conversationId !== conversationId) throw browserError('TAB_ALREADY_OWNED', '网页已绑定其他任务，请先释放控制权');
      tab.ownerConversationId = conversationId;
      tab.conversationId = conversationId; tab.recoveryId ||= crypto.randomUUID();
      if (input.state === 'controlled') {
        if (tab.backgroundFailure && tab.error === tab.backgroundFailure.message) tab.error = null;
        tab.backgroundFailure = null;
      }
      tab.taskState = ['paused', 'unbound'].includes(input.state) ? 'paused' : 'controlled';
      persistTask(tab);
    }
    layout(); emit('state', tab); return snapshot(tab);
  }
  function listTaskTabs(conversationId) {
    return { ok: true, conversationId: taskId(conversationId), tabs: requireTaskStore().list(conversationId) };
  }
  function restoreTaskTabs(conversationId) {
    const saved = listTaskTabs(conversationId).tabs, restored = [];
    let remaining = 0;
    for (const item of saved) {
      const existing = [...tabs.values()].find(tab => tab.recoveryId === item.id && tab.conversationId === conversationId);
      if (existing) {
        if (existing.taskState === 'controlled') emit('manual-action', existing, { action: 'restore-task' });
        setTaskBinding(existing.id, { conversationId, state: 'paused' });
        restored.push(snapshot(existing)); continue;
      }
      if (tabs.size >= maxTabs) { remaining++; continue; }
      const result = create(item.url, { conversationId, restored: true }, null, false, item);
      const tab = requireTab(result.id); restored.push(snapshot(tab));
      emit('task-restored', tab, { conversationId, requiresObservation: true });
    }
    return { ok: true, conversationId, tabs: restored, remaining, state: 'paused', requiresObservation: true };
  }
  function ownerSize() {
    const size = owner.getContentSize();
    return { width: Math.max(0, size[0]), height: Math.max(0, size[1]) };
  }
  function boundedRect() {
    const size = ownerSize(), source = requestedRect, scale = coordinateScale;
    const x = Math.max(0, Math.min(size.width, Math.round(source.x * scale)));
    const y = Math.max(0, Math.min(size.height, Math.round(source.y * scale)));
    const right = Math.max(x, Math.min(size.width, Math.round((source.x + source.width) * scale)));
    const bottom = Math.max(y, Math.min(size.height, Math.round((source.y + source.height) * scale)));
    return { x, y, width: right - x, height: bottom - y };
  }
  function layout() {
    if (destroyed || owner.isDestroyed()) return;
    const rect = boundedRect();
    const ownerVisible = !ownerSuspended && (typeof owner.isVisible !== 'function' || owner.isVisible())
      && (typeof owner.isMinimized !== 'function' || !owner.isMinimized());
    for (const tab of tabs.values()) {
      const show = ownerVisible && visible && activeId === tab.id && rect.width > 0 && rect.height > 0;
      // Presentation and task execution have separate lifetimes. A controlled
      // page must keep its timers/compositor running when another conversation
      // is shown, without focusing or revealing that task's native view.
      const running = !!tab.conversationId && tab.taskState === 'controlled';
      const throttled = !show && !running;
      if (tab.backgroundThrottled !== throttled && alive(tab.view.webContents)) tab.view.webContents.setBackgroundThrottling?.(throttled);
      tab.backgroundThrottled = throttled;
      if (tab.presented && !show) {
        cancelAnnotation(tab);
      }
      // Native focus is outside document.activeElement. Reconcile it again when
      // an inactive app regains focus, preserving the existing chat selection.
      // Never raise Relay over whichever application the user is working in.
      if (!show && tab.view.webContents.isFocused?.() && owner.isFocused?.() !== false) owner.webContents?.focus?.();
      tab.presented = show;
      if (!show) { tab.rightAltDown = false; tab.altGraphDown = false; }
      if (show) {
        releaseBackgroundPaint(tab);
        releaseBackgroundWindow(tab);
        tab.backgroundReady = undefined;
        tab.view.setBounds(rect); tab.appliedBounds = { ...rect };
        owner.contentView.addChildView(tab.view);
        tab.view.setVisible(true);
        refreshAnnotationViewport(tab);
      } else {
        if (!running) {
          tab.view.setVisible(false);
          releaseBackgroundPaint(tab); releaseBackgroundWindow(tab);
        }
        // Never resize another task to the foreground conversation's panel.
        // New background pages still need a usable layout before first reveal.
        if (running && !tab.appliedBounds) {
          const backgroundRect = { x: 0, y: 0, width: 1024, height: 768 };
          tab.view.setBounds(backgroundRect); tab.appliedBounds = backgroundRect;
        }
        if (running) {
          try { ensureBackgroundWindow(tab); }
          catch (error) { backgroundUnavailable(tab, error); continue; }
        }
        if (running && !tab.backgroundPaint && typeof tab.view.webContents.beginFrameSubscription === 'function') {
          // Electron 32 can throttle a hidden native view's compositor to 1fps
          // even though its timers are active. A scoped dirty-frame subscriber
          // keeps that task's surface producing frames; no images are retained.
          tab.backgroundPaint = true;
          tab.view.webContents.beginFrameSubscription(true, () => {});
        } else if (!running) releaseBackgroundPaint(tab);
        if (tab.annotation) cancelAnnotation(tab);
      }
    }
  }
  function ensureBackgroundWindow(tab) {
    if (tab.backgroundFailure) throw tab.backgroundFailure;
    if (tab.backgroundWindow?.isDestroyed?.()) throw browserError('BROWSER_BACKGROUND_UNAVAILABLE', '后台网页渲染宿主已关闭。');
    const { width, height } = tab.appliedBounds;
    const ownerBounds = (owner.isMinimized?.() ? owner.getNormalBounds?.() : owner.getBounds?.()) || owner.getBounds?.() || { x: 0, y: 0 };
    const area = screen?.getDisplayMatching?.(ownerBounds)?.workArea;
    const x = area ? Math.max(area.x, Math.min(ownerBounds.x, area.x + Math.max(0, area.width - width))) : ownerBounds.x;
    const y = area ? Math.max(area.y, Math.min(ownerBounds.y, area.y + Math.max(0, area.height - height))) : ownerBounds.y;
    if (!tab.backgroundWindow) {
      if (!BaseWindow) throw browserError('BROWSER_BACKGROUND_UNAVAILABLE', '当前浏览器宿主未配置后台渲染环境。');
      const background = new BaseWindow({ x, y, width, height, show: false, frame: false, transparent: true,
        opacity: 0, focusable: false, skipTaskbar: true, resizable: false, fullscreenable: false,
        minimizable: false, maximizable: false, hasShadow: false, title: '' });
      tab.backgroundWindow = background;
      try {
        tab.backgroundContentView = background.contentView;
        // All invisibility and input exclusions precede the first native show.
        background.setOpacity(0); background.setIgnoreMouseEvents(true);
        background.setFocusable?.(false); background.setSkipTaskbar?.(true);
        if (background.getOpacity?.() !== 0 || background.isFocusable?.() === true) {
          throw browserError('BROWSER_BACKGROUND_UNAVAILABLE', '当前平台无法创建不可见且不获取焦点的后台网页环境。');
        }
        tab.backgroundClosed = () => {
          if (tab.backgroundWindow === background) backgroundUnavailable(tab, browserError('BROWSER_BACKGROUND_UNAVAILABLE', '后台网页渲染宿主意外关闭，请重新交由任务控制。'));
        };
        background.on?.('closed', tab.backgroundClosed);
        tab.view.setVisible(false);
        owner.contentView.removeChildView(tab.view);
        background.contentView.addChildView(tab.view);
        tab.view.setBounds({ x: 0, y: 0, width, height }); tab.view.setVisible(true);
        background.showInactive();
      } catch (error) { releaseBackgroundWindow(tab); throw error; }
      startBackgroundInitialization(tab);
    } else {
      // The task retains its own last viewport, including its page zoom.
      const placement = tab.backgroundWindow.getBounds?.();
      if (placement && (placement.x !== x || placement.y !== y)) tab.backgroundWindow.setPosition(x, y);
      tab.view.setBounds({ x: 0, y: 0, width, height }); tab.view.setVisible(true);
      if (tab.backgroundInitializationFailed) startBackgroundInitialization(tab);
    }
  }
  function startBackgroundInitialization(tab) {
    let initialization;
    const promise = new Promise((resolve, reject) => { initialization = { resolve, reject }; });
    promise.catch(() => {}); tab.backgroundReady = promise;
    tab.backgroundInitialization = initialization; tab.backgroundInitializationFailed = false;
    initialization.timer = setTimeout(() => finishBackgroundInitialization(tab, initialization,
      browserError('BROWSER_BACKGROUND_UNAVAILABLE', '后台网页画面初始化超时，请稍后重新观察此网页。')), 5000);
    initialization.timer.unref?.();
    const checkViewport = async () => {
      if (tab.backgroundInitialization !== initialization || !alive(tab.view.webContents)) return;
      try {
        const wc = tab.view.webContents;
        let viewport;
        if (wc.debugger?.isAttached?.()) {
          // Electron executeJavaScript waits for loading; CDP can read the live
          // viewport while unrelated resources remain pending. Use our own world
          // so page globals cannot counterfeit readiness, and keep scrollbars
          // in the dimensions (Page.getLayoutMetrics excludes them).
          const tree = await wc.debugger.sendCommand('Page.getFrameTree');
          const frameId = tree.frameTree?.frame?.id;
          if (frameId) {
            const context = await wc.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'Relay Background Viewport' });
            const result = await wc.debugger.sendCommand('Runtime.evaluate', { contextId: context.executionContextId,
              expression: '({ width: window.innerWidth, height: window.innerHeight })', returnByValue: true });
            viewport = result.result?.value;
          }
        } else if (!wc.debugger && wc.getURL()) {
          // Lightweight embedders can supply a geometry reader without CDP.
          viewport = await wc.executeJavaScriptInIsolatedWorld(1004,
            [{ code: '({ width: window.innerWidth, height: window.innerHeight })' }], false);
        }
        if (viewport) {
          if (tab.backgroundInitialization !== initialization || !alive(wc)) return;
          const zoom = wc.getZoomFactor?.() || 1, bounds = tab.appliedBounds;
          if (viewport?.width === Math.floor(bounds.width / zoom) && viewport?.height === Math.floor(bounds.height / zoom)) {
            finishBackgroundInitialization(tab, initialization); return;
          }
        }
      } catch (_) { /* Navigation can briefly remove the isolated world. */ }
      if (tab.backgroundInitialization === initialization) {
        initialization.poll = setTimeout(checkViewport, 25); initialization.poll.unref?.();
      }
    };
    void checkViewport();
  }
  function finishBackgroundInitialization(tab, initialization, error) {
    if (tab.backgroundInitialization !== initialization) return;
    tab.backgroundInitialization = null; clearTimeout(initialization.timer); clearTimeout(initialization.poll);
    tab.backgroundInitializationFailed = !!error;
    if (error) initialization.reject(error); else initialization.resolve();
  }
  function releaseBackgroundWindow(tab) {
    const background = tab.backgroundWindow;
    if (!background) return;
    if (tab.backgroundInitialization) finishBackgroundInitialization(tab, tab.backgroundInitialization,
      tab.presented ? undefined : browserError('STALE_LEASE', '后台网页控制已暂停或释放。'));
    const container = tab.backgroundContentView;
    tab.backgroundWindow = null; tab.backgroundContentView = null; tab.backgroundInitializationFailed = false;
    const errors = [], attempt = work => { try { work(); } catch (error) { errors.push(error); } };
    attempt(() => background.removeListener?.('closed', tab.backgroundClosed)); tab.backgroundClosed = null;
    attempt(() => tab.view.setVisible(false));
    attempt(() => container?.removeChildView(tab.view));
    if (!owner.isDestroyed()) attempt(() => owner.contentView.addChildView(tab.view));
    // A failed detach must not skip either reparenting or native-window disposal.
    // BaseWindow does not own the WebContents lifetime; closeTab handles it later.
    attempt(() => { if (!background.isDestroyed?.()) background.destroy(); });
    if (errors.length) {
      tab.backgroundFailure = browserError('BROWSER_BACKGROUND_UNAVAILABLE', '后台网页渲染宿主未能正常释放，请重新交由任务控制。');
      tab.error = tab.backgroundFailure.message;
      emit('background-cleanup-error', tab, { code: tab.backgroundFailure.code, error: tab.error });
      if (tab.conversationId && tab.taskState === 'controlled') {
        tab.taskState = 'paused'; tab.automationPopupOperationId = null; cancelAutomationInput(tab); cancelAnnotation(tab);
        emit('background-unavailable', tab, { code: tab.backgroundFailure.code, error: tab.error });
      }
    }
  }
  function backgroundUnavailable(tab, error) {
    if (tab.backgroundFailure && !tab.backgroundWindow && tab.taskState === 'paused') return;
    releaseBackgroundPaint(tab); releaseBackgroundWindow(tab);
    const failure = browserError('BROWSER_BACKGROUND_UNAVAILABLE', text(error?.message || '后台网页渲染环境不可用。'));
    tab.backgroundFailure = failure; tab.error = failure.message; tab.taskState = 'paused';
    tab.automationPopupOperationId = null; cancelAutomationInput(tab); cancelAnnotation(tab);
    const ready = Promise.reject(failure); ready.catch(() => {}); tab.backgroundReady = ready;
    emit('background-unavailable', tab, { code: failure.code, error: failure.message });
  }
  function releaseBackgroundPaint(tab) {
    if (!tab.backgroundPaint) return;
    tab.backgroundPaint = false;
    if (alive(tab.view.webContents)) { try { tab.view.webContents.endFrameSubscription?.(); } catch (_) {} }
  }
  function setBounds(rect, scale = coordinateScale) {
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
      || rect.width < 0 || rect.height < 0 || !Number.isFinite(scale) || scale <= 0 || scale > 5) {
      throw browserError('INVALID_BOUNDS', '浏览器显示区域无效');
    }
    requestedRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; coordinateScale = scale;
    layout(); return { ...state(), rect: boundedRect() };
  }
  function setVisibility(value, id = activeId) {
    if (typeof value !== 'boolean') throw browserError('INVALID_VISIBILITY', '浏览器显示状态无效');
    if (id) activeId = requireTab(id).id;
    visible = value && !!activeId;
    layout(); emit('state', tabs.get(activeId)); return state();
  }
  function tabNavigationAllowed(tab, url) { return navigationAllowed(url) || ownsPreviewUrl(tab.preview, url); }
  function update(tab) {
    if (!tabs.has(tab.id) || !alive(tab.view.webContents)) return;
    const current = tab.view.webContents.getURL();
    if (current && tabNavigationAllowed(tab, current) && (!tab.loading || current === tab.url)) tab.url = current;
    persistTask(tab); emit('state', tab);
  }
  function navigate(tab, url) {
    const target = ownsPreviewUrl(tab.preview, url) ? url : resolveBrowserAddress(url, store.settings().searchEngine);
    cancelAnnotation(tab);
    cancelAutomationInput(tab);
    tab.automationPopupOperationId = null;
    const epoch = ++tab.navigationEpoch;
    tab.url = target; tab.error = null; tab.loading = target !== 'about:blank'; tab.findText = null;
    tab.connectionSecurity?.target(target);
    tab.faviconReader?.reset();
    // Entering a download URL in Relay's address bar is also explicit browsing.
    // Match the redirect chain rather than granting a broad timed download pass.
    tab.downloadNavigation = { url: target, at: now() };
    persistTask(tab); emit('state', tab);
    Promise.resolve().then(() => {
      if (tabs.has(tab.id) && epoch === tab.navigationEpoch) return tab.view.webContents.loadURL(target);
    }).catch(error => {
      if (!tabs.has(tab.id) || epoch !== tab.navigationEpoch || error && error.code === 'ERR_ABORTED') return;
      tab.loading = false; tab.error = text(error && error.message || '网页加载失败'); emit('state', tab);
    });
    return state(tab.id);
  }
  function profileChanged(section) { emit('profile', null, { section }); }
  function ownedTab(contents) { return [...tabs.values()].find(value => value.view.webContents === contents); }
  function ownedBlobUrl(value, tab) {
    try {
      if (!tab || !alive(tab.view.webContents) || !String(value).startsWith('blob:')) return false;
      const blob = new URL(value), embedded = normalizeBrowserUrl(value.slice(5)), page = new URL(tab.view.webContents.getURL());
      return ['http:', 'https:'].includes(page.protocol) && blob.origin !== 'null' && blob.origin === page.origin && new URL(embedded).origin === page.origin;
    } catch (_) { return false; }
  }
  function permissionKeys(permission, details = {}) {
    if (permission === 'media') {
      const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
      if (!types.length || types.some(value => !['audio', 'video'].includes(value))) return [];
      return types.map(value => value === 'audio' ? 'microphone' : 'camera');
    }
    return { geolocation: ['location'], notifications: ['notifications'], 'clipboard-read': ['clipboard'] }[permission] || [];
  }
  function permissionOrigin(contents, value) {
    try {
      const url = new URL(normalizeBrowserUrl(value || contents.getURL()));
      if (url.protocol !== 'https:' && !localWebUrl(url.href)) return null;
      return url.origin;
    } catch (_) { return null; }
  }
  function configurePermissions(partition) {
    partition.setPermissionCheckHandler((contents, permission, requestingOrigin, details = {}) => {
      const tab = ownedTab(contents), origin = tab && permissionOrigin(contents, requestingOrigin), keys = permissionKeys(permission, details);
      return !!(tab && !tab.privateSession && tab.presented && origin && keys.length && keys.every(key => store.permission(origin, key) === 'allow'));
    });
    partition.setPermissionRequestHandler(async (contents, permission, callback, details = {}) => {
      const tab = ownedTab(contents), origin = tab && permissionOrigin(contents, details.requestingUrl), keys = permissionKeys(permission, details);
      if (!tab || tab.privateSession || !tab.presented || !origin || !keys.length) { callback(false); return; }
      const rules = keys.map(key => store.permission(origin, key));
      if (rules.includes('block')) { callback(false); return; }
      if (rules.every(rule => rule === 'allow')) { callback(true); return; }
      const promptKey = origin + ':' + keys.join(',');
      if (!dialog?.showMessageBox || permissionPrompts.has(promptKey)) { callback(false); return; }
      permissionPrompts.add(promptKey);
      const epoch = tab.navigationEpoch, pageUrl = contents.getURL();
      try {
        const labels = { camera: '摄像头', microphone: '麦克风', location: '位置信息', notifications: '通知', clipboard: '剪贴板' };
        const result = await dialog.showMessageBox(owner, { type: 'question', title: '网站权限', message: '允许这个网站使用' + keys.map(key => labels[key]).join('、') + '？',
          detail: origin, buttons: ['拒绝', '允许一次', '始终允许'], defaultId: 0, cancelId: 0, noLink: true });
        if (destroyed || !tabs.has(tab.id) || !tab.presented || tab.navigationEpoch !== epoch || contents.getURL() !== pageUrl) { callback(false); return; }
        if (result.response === 2) { for (const key of keys) store.setPermission({ origin, permission: key, decision: 'allow' }); profileChanged('permissions'); }
        callback(result.response === 1 || result.response === 2);
      } catch (_) { callback(false); } finally { permissionPrompts.delete(promptKey); }
    });
  }
  function downloadSnapshot(entry, status) {
    const { item, record } = entry;
    const read = (name, fallback) => { try { return typeof item[name] === 'function' ? item[name]() : fallback; } catch (_) { return fallback; } };
    return { ...record, path: read('getSavePath', record.path || ''), receivedBytes: read('getReceivedBytes', 0), totalBytes: read('getTotalBytes', 0),
      state: status || (read('isPaused', false) ? 'paused' : read('getState', 'progressing')), canResume: read('canResume', false) };
  }
  function persistDownload(entry, status, force = false) {
    const item = downloadSnapshot(entry, status);
    if (force || !entry.savedAt || now() - entry.savedAt >= 1000) {
      try { entry.record = store.download(item); entry.savedAt = now(); } catch (_) { item.error = '下载记录保存失败'; }
    }
    emit('download', null, { item, status: item.state, filename: item.filename });
  }
  function detachDownload(entry) {
    entry.item.removeListener('updated', entry.onUpdated);
    entry.item.removeListener('done', entry.onDone);
    liveDownloads.delete(entry.record.id);
  }
  function configureDownloads(partition) {
    if (sessionListeners.has(partition)) return;
    configurePermissions(partition);
    const listener = (event, item, contents) => {
      const tab = ownedTab(contents);
      const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [item.getURL()];
      const allowance = tab && tab.downloadNavigation;
      const addressBarDownload = allowance && now() - allowance.at < 30000 && chain.includes(allowance.url);
      const gesture = typeof item.hasUserGesture === 'function' && item.hasUserGesture();
      const hasBlob = chain.some(url => String(url).startsWith('blob:'));
      const capture = tab && automationDownloads.get(tab.id);
      const explicitBlobGesture = gesture || addressBarDownload && allowance.nativeGesture === true;
      if (destroyed || !tab || tab.privateSession || !tab.presented && !capture
        || !chain.length || chain.some(url => url === 'about:blank' || !(navigationAllowed(url) || ownedBlobUrl(url, tab)))
        || (!capture && (hasBlob ? !explicitBlobGesture : !gesture && !addressBarDownload))) {
        event.preventDefault(); emit('download', tab, { status: 'blocked', filename: text(item.getFilename()) }); return;
      }
      tab.downloadNavigation = null;
      if (capture) {
        // Exactly one item from this WebContents may consume the registered
        // click expectation. Further items cannot fall through to native dialogs.
        if (!capture.accept(item, { filename: item.getFilename(), url: hasBlob ? contents.getURL() : item.getURL() })) event.preventDefault();
        return;
      }
      const settings = store.settings(), filename = safeFilename(item.getFilename());
      try {
        let destination = settings.downloadDirectory ? path.join(settings.downloadDirectory, filename) : filename;
        if (!settings.askDownloadLocation && settings.downloadDirectory) {
          fs.mkdirSync(settings.downloadDirectory, { recursive: true });
          const parsed = path.parse(filename); let suffix = 1;
          while (fs.existsSync(destination) || [...liveDownloads.values()].some(value => downloadSnapshot(value).path === destination)) {
            destination = path.join(settings.downloadDirectory, `${parsed.name} (${suffix++})${parsed.ext}`);
          }
          item.setSavePath(destination);
        } else item.setSaveDialogOptions({ title: '保存下载文件', defaultPath: destination, properties: ['showOverwriteConfirmation', 'createDirectory'] });
        // Blob URLs expire with their document. Keep the producing page as the
        // durable source, without persisting the exported in-memory payload.
        const record = store.download({ id: crypto.randomUUID(), url: hasBlob ? contents.getURL() : item.getURL(), filename, path: '', state: 'progressing', receivedBytes: 0, totalBytes: 0 });
        const entry = { item, record }; liveDownloads.set(record.id, entry);
        entry.onUpdated = (_event, status) => {
          if (!destroyed && liveDownloads.get(record.id) === entry) persistDownload(entry, status === 'interrupted' ? 'interrupted' : undefined);
        };
        entry.onDone = (_event, status) => {
          if (destroyed || liveDownloads.get(record.id) !== entry) return;
          detachDownload(entry); persistDownload(entry, status, true); profileChanged('downloads');
        };
        item.on('updated', entry.onUpdated);
        item.once('done', entry.onDone);
        persistDownload(entry, undefined, true);
      } catch (_) { event.preventDefault(); emit('download', tab, { status: 'blocked', filename, error: '下载目录或记录不可写' }); }
    };
    partition.on('will-download', listener);
    sessionListeners.set(partition, listener);
  }
  function create(url = 'about:blank', createdMetadata = {}, preview = null, privateSession = false, recovery = null) {
    if (tabs.size >= maxTabs) throw browserError('TAB_LIMIT', '打开的网页较多，请先关闭部分标签');
    const ownerValue = recovery?.conversationId || createdMetadata.ownerConversationId || createdMetadata.conversationId;
    const ownerConversationId = ownerValue ? taskId(ownerValue) : null;
    const target = preview ? preview.url : resolveBrowserAddress(url, store.settings().searchEngine), id = String(idFactory());
    privateSession = privateSession || !!preview;
    if (!id || tabs.has(id)) throw browserError('DUPLICATE_TAB', '无法创建浏览器标签');
    const partition = !privateSession && browserSession || session.fromPartition(`relay-browser-${hostId}-${crypto.randomUUID()}`);
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true,
      preload: resourcePath('browser-page-preload.js'),
      // Start task pages with a live scheduler; changing this only after an
      // initially hidden document loads can leave its first layout/rAF frozen.
      backgroundThrottling: !ownerConversationId || privateSession,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
      safeDialogs: true, spellcheck: false } });
    const previewSession = privateSession ? installPreviewSession(partition, preview, () => view.webContents) : null;
    const tab = { id, view, partition, preview, previewSession, privateSession, url: target, title: preview?.title || '', loading: false, error: null, navigationEpoch: 0, zoom: 1 };
    tab.faviconReader = createBrowserFavicon({ partition,
      current: () => ({ url: tab.url, documentUrl: alive(view.webContents) ? view.webContents.getURL() : '',
        alive: !destroyed && !retiring && tabs.get(id) === tab && alive(view.webContents) }),
      changed: () => emit('state', tab) });
    tab.connectionSecurity = createBrowserConnectionSecurity({ partition, now,
      current: () => ({ url: tab.url, epoch: tab.navigationEpoch, alive: !destroyed && !retiring && tabs.get(id) === tab && alive(view.webContents) }),
      changed: () => {
        const connection = tab.connectionSecurity.snapshot();
        if (connection.state === 'certificate-error') { tab.loading = false; tab.error = connection.errorCode; }
        else if (connection.state === 'certificate-exception') tab.error = null;
        emit('state', tab);
      } });
    if (ownerConversationId) tab.ownerConversationId = ownerConversationId;
    if (recovery) Object.assign(tab, { recoveryId: recovery.id, conversationId: recovery.conversationId, title: recovery.title,
      taskState: 'paused', restored: true });
    tabs.set(id, tab); if (!activeId) activeId = id;
    view.setVisible(false); owner.contentView.addChildView(view);
    const wc = view.webContents;
    wc.on('ipc-message', (event, channel, payload) => {
      if (channel !== 'browser:page-event' || !wc.mainFrame || event.senderFrame !== wc.mainFrame) return;
      if (handlePageInput(tab, payload)) return;
      void handlePageAnnotation(tab, payload);
    });
    wc.on('did-start-navigation', (event, _url, inPlace, isMainFrame) => {
      const main = typeof event?.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
      if (main !== false) {
        tab.navigationEpoch++; tab.inputDocumentToken = null; tab.automationPopupOperationId = null; cancelAnnotation(tab); cancelAutomationInput(tab);
        const targetUrl = event?.url || _url;
        if (!inPlace && tabNavigationAllowed(tab, targetUrl)) { tab.url = targetUrl; tab.connectionSecurity.target(targetUrl); tab.faviconReader.reset(); }
      }
    });
    wc.on('dom-ready', () => {
      tab.inputDocumentToken = crypto.randomUUID();
      sendPage(wc, 'relay:browser-input-context', { documentToken: tab.inputDocumentToken });
    });
    tab.pageScrollbars = attachBrowserPageScrollbars(wc, value => ownsPreviewUrl(preview, value));
    if (typeof wc.setIgnoreMenuShortcuts === 'function') wc.setIgnoreMenuShortcuts(true);
    wc.on('blur', () => { tab.rightAltDown = false; tab.altGraphDown = false; });
    wc.on('before-input-event', (event, input) => {
      if (destroyed || retiring || !tabs.has(id) || !input) return;
      // CDP task input bypasses Electron's native key hook. A retained native
      // focus/queued OS key must never type into an invisible task's document.
      if (!tab.presented) { event.preventDefault(); return; }
      const down = input.type === 'keyDown', up = input.type === 'keyUp';
      // Electron's native key hook sees local keyboard input but not CDP key
      // dispatch (characterized by browser-input-origin-probe on Electron 32).
      // Revoke synchronously before the event reaches the page. DOM isTrusted
      // cannot make this distinction and is deliberately not used here.
      const manualKey = () => { if (down && tab.conversationId && !tab.annotation) emit('manual-action', tab, { action: 'keyboard' }); };
      if (input.code === 'AltRight' && (down || up)) tab.rightAltDown = down;
      if (input.key === 'AltGraph' && (down || up)) tab.altGraphDown = down;
      const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
      // Electron does not consistently expose AltGraph in its modifier list.
      // Track right Alt as well so international text entry remains in the page.
      const altGraph = tab.altGraphDown || modifiers.some(value => /^altgr(aph)?$/i.test(value))
        || platform !== 'darwin' && tab.rightAltDown && input.control && input.alt;
      if (/^(?:Control|Meta|Shift|Alt|AltGraph|OS)$/i.test(String(input.key || ''))) return;
      if (!down || input.isComposing || input.keyCode === 229 || input.isAutoRepeat || altGraph) { manualKey(); return; }
      const chord = chordFromEvent({ key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta,
        altKey: input.alt, shiftKey: input.shift, repeat: input.isAutoRepeat, isComposing: input.isComposing,
        getModifierState: name => name === 'AltGraph' && altGraph }, platform === 'darwin');
      const workspaceAction = chord && workspaceBindings.get(chord);
      if (workspaceAction) { event.preventDefault(); emit('shortcut', tab, { action: 'workspace', workspaceAction }); return; }
      const key = String(input.key || '').toLowerCase();
      let action;
      if (input.alt && !input.control && !input.meta) action = { arrowleft: 'back', arrowright: 'forward' }[key];
      else if (!input.alt && (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)) {
        action = input.shift ? { t: 'reopenTab', tab: 'previousTab', '+': 'zoomIn', '=': 'zoomIn' }[key] :
          { l: 'address', t: 'newTab', w: 'closeTab', f: 'find', r: 'reload', p: 'print', d: 'bookmark', h: 'history', j: 'downloads', tab: 'nextTab', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', '0': 'zoomReset' }[key];
      } else if (!input.alt && !input.shift) action = { f5: 'reload', f12: 'devTools' }[key];
      if (!action) { manualKey(); return; }
      // These keys only change Relay's presentation. Page mutations such as
      // reload/back/zoom still revoke the lease before their shortcut executes.
      if (!['address', 'newTab', 'nextTab', 'previousTab', 'find', 'bookmark', 'history', 'downloads'].includes(action)) manualKey();
      event.preventDefault(); emit('shortcut', tab, { action });
    });
    const guard = (event, url) => {
      const targetUrl = event && event.url || url;
      if (!tabNavigationAllowed(tab, targetUrl)) { event.preventDefault(); tab.error = '已阻止不支持的网址'; emit('state', tab); }
    };
    wc.on('will-navigate', (event, url, _isInPlace, isMainFrame) => {
      guard(event, url);
      // This event is page/user initiated, unlike loadURL or history traversal.
      // Keep subframe/redirect guards separate so they do not discard the
      // renderer's logical forward history across local management pages.
      if (!destroyed && !retiring && tabs.has(id) && event.isMainFrame !== false && isMainFrame !== false
        && !event.defaultPrevented && tabNavigationAllowed(tab, event.url || url)) emit('navigation-start', tab);
    });
    wc.on('will-frame-navigate', guard); wc.on('will-redirect', guard);
    wc.on('did-redirect-navigation', (event, url, _inPlace, isMainFrame) => {
      if (event?.isMainFrame === false || isMainFrame === false) return;
      const targetUrl = event?.url || url;
      if (tabNavigationAllowed(tab, targetUrl)) { tab.url = targetUrl; tab.connectionSecurity.target(targetUrl); tab.faviconReader.reset(); }
    });
    wc.on('certificate-error', (...args) => tab.connectionSecurity.certificateError(...args));
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('content-bounds-updated', event => event.preventDefault());
    wc.setWindowOpenHandler(details => {
      if (destroyed || !tabs.has(id)) return { action: 'deny' };
      if (details.postBody) { tab.error = '这个新窗口提交需要在系统浏览器中打开'; emit('state', tab); return { action: 'deny' }; }
      try {
        create(details.url, { openerId: id, requestedActive: details.disposition !== 'background-tab',
          ...(tab.ownerConversationId ? { ownerConversationId: tab.ownerConversationId } : {}),
          ...(tab.automationPopupOperationId ? { automationOperationId: tab.automationPopupOperationId } : {}) }, null, tab.privateSession);
      } catch (error) { tab.error = text(error.message); emit('state', tab); }
      return { action: 'deny' };
    });
    wc.on('did-start-loading', () => {
      if (tab.connectionSecurity.snapshot().state !== 'certificate-error') { tab.loading = true; tab.error = null; }
      update(tab);
    });
    wc.on('did-stop-loading', () => { tab.loading = false; update(tab); });
    function remember(value) {
      if (tab.privateSession || value === 'about:blank') return;
      try { tab.historyId = store.visit({ url: value, title: tab.title }).id; profileChanged('history'); } catch (_) {}
    }
    wc.on('did-navigate', (_event, value) => { if (tabNavigationAllowed(tab, value)) { tab.url = value; remember(value); } update(tab); });
    wc.on('did-navigate-in-page', (_event, value, isMainFrame) => { if (isMainFrame !== false && tabNavigationAllowed(tab, value)) { tab.url = value; remember(value); update(tab); } });
    wc.on('page-title-updated', (_event, title) => {
      tab.title = text(title);
      try { if (!tab.privateSession && tab.historyId && tab.url !== 'about:blank') store.visit({ url: tab.url, title: tab.title, id: tab.historyId }); } catch (_) {}
      update(tab);
    });
    wc.on('page-favicon-updated', (_event, urls) => { void tab.faviconReader.update(urls); });
    wc.on('media-started-playing', () => update(tab)); wc.on('media-paused', () => update(tab));
    wc.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame === false || code === -3 || failedUrl && failedUrl !== tab.url) return;
      tab.faviconReader.reset();
      tab.loading = false; tab.error = text(description || '网页加载失败'); emit('state', tab);
    });
    wc.on('render-process-gone', (_event, details) => {
      tab.connectionSecurity.cancel(); tab.faviconReader.reset(); tab.navigationEpoch++;
      tab.loading = false; tab.error = `网页进程已结束（${text(details && details.reason, 80)}），可以重新加载`; emit('state', tab);
    });
    wc.on('found-in-page', (_event, result) => emit('find', tab, { requestId: result.requestId, matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: !!result.finalUpdate }));
    wc.on('destroyed', () => { if (tabs.has(id)) remove(tab, false); });
    wc.on('context-menu', (_event, params) => showContextMenu(tab, params));
    configureDownloads(partition);
    emit('created', tab, createdMetadata); navigate(tab, target); return state(id);
  }
  function remove(tab, closeContents = true) {
    tab.faviconReader?.close();
    tab.connectionSecurity?.close();
    releaseBackgroundPaint(tab);
    releaseBackgroundWindow(tab);
    tab.automationPopupOperationId = null;
    cancelAnnotation(tab);
    cancelAutomationInput(tab);
    if (!destroyed && tab.recoveryId) {
      try { requireTaskStore().remove(tab.recoveryId); taskPersistenceSaved(tab); }
      catch (error) { taskPersistenceFailed(tab, error); }
    }
    const capture = automationDownloads.get(tab.id);
    automationDownloads.delete(tab.id);
    capture?.cancel(browserError('TAB_CLOSED', '网页已关闭，下载已取消'));
    tabs.delete(tab.id); tab.navigationEpoch++;
    tab.pageScrollbars?.dispose();
    tab.previewSession?.dispose();
    if (!persistent || tab.privateSession) {
      const listener = sessionListeners.get(tab.partition); if (listener) tab.partition.removeListener('will-download', listener);
      sessionListeners.delete(tab.partition);
    }
    const cleanupStorage = () => setImmediate(() => {
      try { Promise.resolve(tab.partition.clearStorageData()).catch(() => {}); } catch (_) {}
      try { Promise.resolve(tab.partition.clearCache()).catch(() => {}); } catch (_) {}
      try { Promise.resolve(tab.partition.clearAuthCache?.()).catch(() => {}); } catch (_) {}
      try { Promise.resolve(tab.partition.closeAllConnections?.()).catch(() => {}); } catch (_) {}
    });
    if (!persistent || tab.privateSession) { if (alive(tab.view.webContents)) tab.view.webContents.once('destroyed', cleanupStorage); else cleanupStorage(); }
    try { owner.contentView.removeChildView(tab.view); } catch (_) {}
    if (closeContents && alive(tab.view.webContents)) {
      // Views are not automatically destroyed with BaseWindow/BrowserWindow.
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    if (activeId === tab.id) { activeId = [...tabs.keys()].at(-1) || null; visible = false; }
    if (!activeId) visible = false;
    layout(); emit('closed', null, { id: tab.id, tabs: [...tabs.values()].map(snapshot) });
    return state();
  }
  function cancelAnnotation(tab, notify = true) {
    tab.annotationGeneration = (tab.annotationGeneration || 0) + 1;
    const pending = tab.annotation;
    if (!pending) return { ok: true };
    tab.annotation = null;
    clearTimeout(pending.readyTimer);
    pending.rejectReady?.(browserError('ANNOTATION_CANCELLED', '网页批注已取消，请重新选择'));
    sendPage(tab.view.webContents, 'relay:browser-annotation-cancel', { requestId: pending.requestId });
    if (notify) emit('annotation-cancelled', tab, { requestId: pending.requestId, conversationId: pending.conversationId });
    return { ok: true };
  }
  function annotationGeometry(tab) {
    const bounds = tab.appliedBounds || tab.view.getBounds?.() || boundedRect();
    return { width: bounds.width, height: bounds.height, zoom: tab.view.webContents.getZoomFactor?.() || 1 };
  }
  function annotationViewport(geometry, round = Math.floor) {
    return { width: round(geometry.width / geometry.zoom), height: round(geometry.height / geometry.zoom) };
  }
  function sameViewport(left, right) { return !!left && !!right && left.width === right.width && left.height === right.height; }
  function sameAnnotationGeometry(left, right) { return sameViewport(left, right) && left.zoom === right.zoom; }
  function sendAnnotationPreparation(tab, pending) {
    return sendPage(tab.view.webContents, 'relay:browser-annotation-start', { requestId: pending.requestId, mode: pending.mode,
      revision: pending.revision, viewport: pending.viewport, viewportMax: annotationViewport(pending.geometry, Math.ceil) });
  }
  function refreshAnnotationViewport(tab) {
    const pending = tab.annotation;
    if (!pending) return;
    const geometry = annotationGeometry(tab);
    if (sameAnnotationGeometry(geometry, pending.geometry)) return;
    if (pending.ready) { cancelAnnotation(tab); return; }
    // Native layout and Chromium paint travel separately. Bind each preparation
    // revision to exact native bounds/zoom, then latch the page's measured size.
    pending.geometry = geometry; pending.viewport = annotationViewport(geometry); pending.revision++;
    if (!sendAnnotationPreparation(tab, pending)) cancelAnnotation(tab);
  }
  function cancelAutomationInput(tab, reason = '网页控制状态已改变', code = 'STALE_LEASE') {
    const pending = tab.inputPending;
    if (!pending) return;
    tab.inputPending = null; clearTimeout(pending.timer);
    pending.reject(browserError(code, reason)); pending.consumed(false);
    sendPage(tab.view.webContents, 'relay:browser-input-cancel', { token: pending.token });
  }
  function handlePageInput(tab, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.type === 'manual-pointer') {
      if (tab.presented && !tab.annotation && tab.conversationId && payload.documentToken
        && payload.documentToken === tab.inputDocumentToken && payload.url === tab.view.webContents.getURL()) {
        cancelAutomationInput(tab, '用户已接管网页');
        emit('manual-action', tab, { action: 'pointer' });
      }
      return true;
    }
    if (!['input-ready', 'input-consumed', 'input-not-visible'].includes(payload.type)) return false;
    const pending = tab.inputPending;
    if (!pending || payload.token !== pending.token || pending.epoch !== tab.navigationEpoch
      || pending.url !== tab.view.webContents.getURL() || tab.taskState !== 'controlled') return true;
    if (payload.type === 'input-not-visible' || payload.type === 'input-ready' && payload.visible !== true && !(pending.allowBackground && payload.background === true)) {
      cancelAutomationInput(tab, '网页文档仍处于隐藏状态，请显示此网页后重新观察；尚未发送本次输入', 'BROWSER_NOT_VISIBLE');
    } else if (payload.type === 'input-ready') { clearTimeout(pending.timer); pending.resolve(); }
    else pending.consumed(true);
    return true;
  }
  async function prepareAutomationInput(id, { method, params = {} } = {}) {
    let expected;
    if (method === 'webContents.sendInputEvent' && params.type === 'mouseWheel') {
      // Electron native input uses view DIP; the isolated DOM listener observes
      // CSS pixels. Both position and wheel deltas scale with page zoom.
      const zoom = requireTab(id).view.webContents.getZoomFactor?.() || 1;
      expected = { type: 'wheel', x: params.x / zoom, y: params.y / zoom, modifiers: 0, count: 1,
        deltaX: -(params.deltaX || 0) / zoom, deltaY: -(params.deltaY || 0) / zoom };
    } else if (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseWheel'].includes(params.type)) {
      const zoom = requireTab(id).view.webContents.getZoomFactor?.() || 1;
      expected = { type: params.type === 'mouseWheel' ? 'wheel' : 'pointerdown', x: params.x, y: params.y,
        button: ({ left: 0, middle: 1, right: 2 })[params.button] ?? 0,
        modifiers: params.modifiers || 0, count: 1,
        ...(params.type === 'mouseWheel' ? { deltaX: (params.deltaX || 0) / zoom, deltaY: (params.deltaY || 0) / zoom } : {}) };
    } else if (method === 'Input.synthesizeTapGesture') {
      expected = { type: 'pointerdown', x: params.x, y: params.y, button: 0, modifiers: 0, count: params.tapCount || 1 };
    } else if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      // Releasing an already-held button is cleanup, not a new gesture. The
      // caller retains target/lease guards even if Chromium became hidden.
      return () => {};
    } else if (method === 'visibility' || method?.startsWith('Input.') || method === 'webContents.sendInputEvent') {
      // Hover/key/text preparation also needs a live Chromium document. This
      // handshake grants no pointer suppression and has no consumed event.
      expected = { type: 'visibility' };
    } else return () => {};
    if (expected.type !== 'visibility' && (![expected.x, expected.y].every(Number.isFinite) || ![1, 2].includes(expected.count))) throw browserError('INVALID_INPUT', '浏览器输入位置无效');
    const tab = requireTab(id), wc = tab.view.webContents;
    if (!tab.conversationId || tab.taskState !== 'controlled' || !alive(wc)) throw browserError('STALE_LEASE', '网页尚未交给当前任务控制');
    if (tab.inputPending) throw browserError('BROWSER_INPUT_BUSY', '网页已有一个等待中的输入');
    tab.inputDocumentToken ||= crypto.randomUUID();
    let resolveReady, rejectReady, consumed;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const received = new Promise(resolve => { consumed = resolve; });
    const pending = { token: crypto.randomUUID(), epoch: tab.navigationEpoch, url: wc.getURL(), resolve: resolveReady, reject: rejectReady, consumed, allowBackground: true };
    tab.inputPending = pending;
    pending.timer = setTimeout(() => cancelAutomationInput(tab, '网页输入握手超时，请重新观察'), 1500);
    if (!sendPage(wc, 'relay:browser-input-prepare', { token: pending.token, documentToken: tab.inputDocumentToken, expected, allowBackground: pending.allowBackground })) cancelAutomationInput(tab, '网页进程已更换，请重新观察');
    try { await ready; }
    catch (error) { if (tab.inputPending === pending) cancelAutomationInput(tab); throw error; }
    if (tab.inputPending !== pending) throw browserError('STALE_LEASE', '网页输入已取消');
    if (expected.type === 'visibility') { tab.inputPending = null; return () => {}; }
    return async () => {
      // CDP acknowledgement and the renderer IPC response use separate pipes.
      // Wait briefly for the exact event to be consumed before clearing it;
      // unrelated human input is never hidden by this bounded wait.
      let timer;
      await Promise.race([received, new Promise(resolve => { timer = setTimeout(resolve, 300); })]);
      clearTimeout(timer);
      if (tab.inputPending === pending) {
        tab.inputPending = null;
        sendPage(wc, 'relay:browser-input-cancel', { token: pending.token });
      }
    };
  }
  function armAutomationPopup(id, operationId) {
    const tab = requireTab(id);
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw browserError('INVALID_INPUT', '弹出页操作标识无效');
    if (!tab.conversationId || tab.taskState !== 'controlled' || tab.privateSession) throw browserError('STALE_LEASE', '网页尚未交给当前任务控制');
    if (tab.automationPopupOperationId) throw browserError('BROWSER_INPUT_BUSY', '网页已有一个等待中的弹出页操作');
    tab.automationPopupOperationId = operationId;
    return () => { if (tab.automationPopupOperationId === operationId) tab.automationPopupOperationId = null; };
  }
  function annotationCurrent(tab, pending) {
    const wc = tab.view.webContents;
    return !destroyed && !retiring && tabs.get(tab.id) === tab && alive(wc) && tab.presented && activeId === tab.id
      && tab.conversationId === pending.conversationId && tab.navigationEpoch === pending.epoch
      && tab.annotationGeneration === pending.generation && wc.getURL() === pending.url
      && sameAnnotationGeometry(annotationGeometry(tab), pending.geometry);
  }
  // Main-process guard across the trusted task-directory lookup. A page that
  // navigates, is hidden, or is paused and shown again is still a new target.
  function captureAnnotationTarget(id, conversationId) {
    const tab = requireTab(id), wc = tab.view.webContents;
    const generation = tab.annotationGeneration, epoch = tab.navigationEpoch, url = wc.getURL();
    return () => !destroyed && !retiring && tabs.get(tab.id) === tab && alive(wc) && tab.presented && activeId === tab.id
      && tab.conversationId === conversationId && tab.annotationGeneration === generation
      && tab.navigationEpoch === epoch && wc.getURL() === url;
  }
  function annotationDirectory(contextRoot) {
    if (typeof contextRoot !== 'string' || !path.isAbsolute(contextRoot)) throw browserError('INVALID_CONTEXT', '批注缺少可信任务目录');
    const root = fs.realpathSync(contextRoot);
    if (!fs.statSync(root).isDirectory()) throw browserError('INVALID_CONTEXT', '任务目录不可用');
    let directory = root;
    for (const component of ['.relay', 'browser', 'annotations']) {
      directory = path.join(directory, component);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw browserError('UNSAFE_ARTIFACT_PATH', '批注目录不能是符号链接或文件');
      const relative = path.relative(root, fs.realpathSync(directory));
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw browserError('UNSAFE_ARTIFACT_PATH', '批注目录不在当前任务中');
    }
    return directory;
  }
  function startAnnotation(id, { conversationId, mode = 'element', contextRoot, onPaused = () => {} } = {}) {
    const tab = requireTab(id), wc = tab.view.webContents;
    taskId(conversationId);
    if (tab.conversationId !== conversationId) throw browserError('TAB_NOT_OWNED', '请先将此网页交给当前任务，再添加批注');
    if (tab.privateSession) throw browserError('PRIVATE_TAB', '私密网页不允许任务批注');
    if (!['element', 'region'].includes(mode)) throw browserError('INVALID_ANNOTATION', '批注选择方式无效');
    if (!alive(wc) || !tab.presented || activeId !== tab.id) throw browserError('BROWSER_NOT_VISIBLE', '请先显示需要批注的网页');
    const url = normalizeBrowserUrl(wc.getURL());
    if (url === 'about:blank') throw browserError('INVALID_ANNOTATION', '请先打开需要批注的网页');
    const directory = annotationDirectory(contextRoot);
    cancelAnnotation(tab);
    // This callback revokes the automation lease before the selection UI opens.
    emit('manual-action', tab, { action: 'annotation' });
    let resolveReady, rejectReady;
    const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const pending = { requestId: crypto.randomUUID(), conversationId, mode, directory, epoch: tab.navigationEpoch,
      generation: tab.annotationGeneration, url, geometry: annotationGeometry(tab), revision: 1, ready: false, resolveReady, rejectReady };
    pending.viewport = annotationViewport(pending.geometry);
    tab.annotation = pending;
    onPaused({ requestId: pending.requestId });
    pending.readyTimer = setTimeout(() => {
      if (tab.annotation !== pending || pending.ready) return;
      rejectReady(browserError('ANNOTATION_NOT_READY', '网页显示区域尚未就绪，请稍后重新打开批注'));
      cancelAnnotation(tab);
    }, 5000);
    if (!sendAnnotationPreparation(tab, pending)) {
      rejectReady(browserError('TAB_CLOSED', '网页进程已更换，请重新打开批注')); cancelAnnotation(tab);
    }
    return readiness.then(() => ({ ok: true, id, conversationId, requestId: pending.requestId,
      viewport: { ...pending.viewport } }));
  }
  async function handlePageAnnotation(tab, payload) {
    const pending = tab.annotation;
    if (!pending || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.requestId !== pending.requestId) return;
    if (payload.type === 'annotation-ready') {
      const minimum = annotationViewport(pending.geometry), maximum = annotationViewport(pending.geometry, Math.ceil);
      // Fractional page zoom rounds CSS pixels differently across native sizes.
      // Accept only the integer floor/ceil interval during preparation; every
      // selection and capture remains tied to this exact measured viewport.
      if (pending.ready || payload.revision !== pending.revision || !payload.viewport
        || !['width', 'height'].every(key => Number.isInteger(payload.viewport[key]) && payload.viewport[key] > 0
          && payload.viewport[key] >= minimum[key] && payload.viewport[key] <= maximum[key])
        || !annotationCurrent(tab, pending)) return;
      pending.viewport = { width: payload.viewport.width, height: payload.viewport.height };
      pending.ready = true; clearTimeout(pending.readyTimer); pending.resolveReady(); return;
    }
    if (payload.type === 'annotation-cancel') {
      // Escape is a whole-request human cancellation; stale geometry messages
      // from a replaced preparation revision must not cancel its successor.
      if (payload.reason === 'escape' || payload.revision === pending.revision) cancelAnnotation(tab);
      return;
    }
    if (payload.type !== 'annotation' || !pending.ready || payload.revision !== pending.revision
      || !sameViewport(payload.viewport, pending.viewport)) return;
    // Consume the nonce before awaiting native capture, preventing replay.
    tab.annotation = null;
    let filename;
    try {
      if (!annotationCurrent(tab, pending)) throw browserError('ANNOTATION_STALE', '网页已变化，请重新选择批注位置');
      const selection = payload.selection, viewport = payload.viewport, rect = selection?.rect;
      if (!selection || selection.kind !== pending.mode || !rect || !viewport
        || !['width', 'height'].every(key => Number.isFinite(viewport[key]) && viewport[key] > 0 && viewport[key] <= 16384)
        || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
        || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
        || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1) {
        throw browserError('INVALID_ANNOTATION', '批注区域无效，请重新选择');
      }
      const safeSelection = { kind: selection.kind, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        text: text(selection.text, 4000), tagName: text(selection.tagName, 80), selector: text(selection.selector, 1000),
        viewport: { width: viewport.width, height: viewport.height } };
      let screenshot = await tab.view.webContents.capturePage();
      if (!annotationCurrent(tab, pending)) throw browserError('ANNOTATION_STALE', '网页已变化，请重新选择批注位置');
      if (screenshot.isEmpty()) throw browserError('BROWSER_CAPTURE_EMPTY', '网页截图暂不可用');
      const original = screenshot.getSize(), longest = Math.max(original.width, original.height);
      if (longest > 1600) screenshot = screenshot.resize({ width: Math.max(1, Math.round(original.width * 1600 / longest)), height: Math.max(1, Math.round(original.height * 1600 / longest)) });
      const png = screenshot.toPNG();
      if (!png.length || png.length > 12 * 1024 * 1024) throw browserError('BROWSER_CAPTURE_TOO_LARGE', '网页截图过大，请缩小窗口后重试');
      // Revalidate the directory after the async capture; the page never chooses a path.
      if (fs.realpathSync(pending.directory) !== pending.directory || fs.lstatSync(pending.directory).isSymbolicLink()) throw browserError('UNSAFE_ARTIFACT_PATH', '批注目录已变化');
      const name = 'browser-annotation-' + crypto.randomUUID() + '.png';
      filename = path.join(pending.directory, name);
      fs.writeFileSync(filename, png, { flag: 'wx', mode: 0o600 });
      if (!annotationCurrent(tab, pending)) throw browserError('ANNOTATION_STALE', '网页已变化，请重新选择批注位置');
      emit('annotation', tab, { requestId: pending.requestId, conversationId: pending.conversationId, url: pending.url,
        title: tab.title, selection: safeSelection, screenshot: { path: filename, name, mimeType: 'image/png', bytes: png.length,
          dataUrl: 'data:image/png;base64,' + png.toString('base64') } });
    } catch (error) {
      if (filename) { try { fs.unlinkSync(filename); } catch (_) {} }
      emit('annotation-error', tab, { requestId: pending.requestId, conversationId: pending.conversationId,
        code: error.code || 'ANNOTATION_FAILED', error: error.code ? text(error.message) : '批注截图保存失败，请重试' });
    }
  }
  async function showContextMenu(tab, params) {
    if (!Menu?.buildFromTemplate || !tab.presented) return;
    const wc = tab.view.webContents, menuEpoch = tab.navigationEpoch, menuUrl = wc.getURL();
    // Native menus do not traverse browser:invoke. Announce known manual changes
    // synchronously so the owner can revoke automation before the callback runs.
    const manual = (action, run) => () => { emit('manual-action', tab, { action }); return run(); };
    const template = [], command = action => manual(action, () => invoke({ action, id: tab.id }));
    const separator = () => { if (template.length && template.at(-1).type !== 'separator') template.push({ type: 'separator' }); };
    if (params.isEditable) {
      for (const [label, method, enabled] of [['撤销', 'undo', params.editFlags?.canUndo], ['重做', 'redo', params.editFlags?.canRedo],
        ['剪切', 'cut', params.editFlags?.canCut], ['复制', 'copy', params.editFlags?.canCopy], ['粘贴', 'paste', params.editFlags?.canPaste], ['全选', 'selectAll', true]]) {
        const edit = () => { if (alive(wc)) wc[method](); };
        template.push({ label, enabled: !!enabled, click: method === 'copy' ? edit : manual(method, edit) });
      }
    } else if (params.selectionText) template.push({ label: '复制', click: () => alive(wc) && wc.copy() });
    if (params.linkURL && navigationAllowed(params.linkURL) && params.linkURL !== 'about:blank') {
      separator(); template.push({ label: '在新标签页打开链接', click: manual('open-link', () => create(params.linkURL, { openerId: tab.id, requestedActive: true,
        ...(tab.ownerConversationId ? { ownerConversationId: tab.ownerConversationId } : {}) }, null, tab.privateSession)) },
        { label: '复制链接地址', click: () => clipboard?.writeText(params.linkURL) });
    }
    if (params.mediaType === 'image') {
      separator(); template.push({ label: '复制图片', click: () => alive(wc) && wc.copyImageAt(params.x, params.y) });
      if (!tab.privateSession && params.srcURL && (navigationAllowed(params.srcURL) || ownedBlobUrl(params.srcURL, tab)) && params.srcURL !== 'about:blank') template.push({ label: '图片另存为…', click: manual('save-image', () => {
        if (alive(wc)) { tab.downloadNavigation = { url: params.srcURL, at: now(), nativeGesture: true }; wc.downloadURL(params.srcURL); }
      }) });
    }
    if (!tab.privateSession && formStore && params.isEditable && menuUrl.startsWith('https:')) {
      try {
        const origin = new URL(menuUrl).origin;
        const accounts = await formStore.invoke({ action: 'passwords.forOrigin', origin });
        if (accounts.ok && accounts.items?.length) {
          separator(); template.push({ label: '填写已保存的账号', submenu: accounts.items.map(item => ({ label: text(item.username || '未命名账号'),
            click: manual('passwords.fill', () => invoke({ action: 'passwords.fill', id: tab.id, recordId: item.recordId, expectedUrl: menuUrl })) })) });
        }
        const contacts = await formStore.invoke({ action: 'contacts.list' });
        if (contacts.ok && contacts.items?.length) template.push({ label: '填写联系人', submenu: contacts.items.map(item => ({ label: text(item.name || item.email || '联系人'),
          click: manual('contacts.fill', () => invoke({ action: 'contacts.fill', id: tab.id, recordId: item.recordId, expectedUrl: menuUrl })) })) });
      } catch (_) {}
    }
    separator(); const current = snapshot(tab);
    template.push({ label: '后退', enabled: current.canGoBack, click: command('back') }, { label: '前进', enabled: current.canGoForward, click: command('forward') },
      { label: '刷新', click: command('reload') }, { type: 'separator' }, { label: '打印…', click: command('print') },
      { label: '检查元素', click: manual('inspect-element', () => { if (alive(wc)) wc.inspectElement(params.x, params.y); }) });
    function guardItems(items) { for (const item of items) {
      if (item.submenu) guardItems(item.submenu);
      if (item.click) {
        const click = item.click;
        item.click = () => {
          if (destroyed || !tabs.has(tab.id) || !alive(wc) || tab.navigationEpoch !== menuEpoch || wc.getURL() !== menuUrl) return;
          try { Promise.resolve(click()).catch(error => { tab.error = text(error.message || '网页操作失败'); emit('state', tab); }); }
          catch (error) { tab.error = text(error.message || '网页操作失败'); emit('state', tab); }
        };
      }
    } }
    guardItems(template);
    if (destroyed || !tabs.has(tab.id) || !alive(wc) || tab.navigationEpoch !== menuEpoch || wc.getURL() !== menuUrl) return;
    Menu.buildFromTemplate(template).popup({ window: owner });
  }
  async function profileAction(input) {
    const { action } = input;
    if (/^(passwords|contacts)\./.test(action) && !action.endsWith('.fill')) {
      if (!formStore) throw browserError('ENCRYPTION_UNAVAILABLE', '本机安全存储暂不可用');
      const result = await formStore.invoke(input);
      if (result.ok && /\.(save|delete)$/.test(action)) profileChanged(action.split('.')[0]);
      return result;
    }
    if (action === 'settings.get') return { ok: true, settings: store.settings() };
    if (action === 'settings.update') { const settings = store.updateSettings(input.settings); profileChanged('settings'); return { ok: true, settings }; }
    if (action === 'downloads.chooseDirectory') {
      if (!dialog?.showOpenDialog) throw browserError('DIALOG_UNAVAILABLE', '目录选择暂不可用');
      const result = await dialog.showOpenDialog(owner, { title: '选择下载目录', defaultPath: store.settings().downloadDirectory || undefined, properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
      const settings = store.updateSettings({ downloadDirectory: result.filePaths[0] }); profileChanged('settings'); return { ok: true, settings };
    }
    const list = /^(history|bookmarks|downloads|permissions)\.list$/.exec(action);
    if (list) {
      const result = store.list(list[1], input);
      if (list[1] === 'downloads') result.items = result.items.map(item => liveDownloads.has(item.id) ? downloadSnapshot(liveDownloads.get(item.id)) : { ...item, canResume: false });
      return { ok: true, ...result };
    }
    if (action === 'bookmarks.add') { const item = store.bookmark(input); profileChanged('bookmarks'); return { ok: true, item }; }
    const removal = /^(history|bookmarks|downloads)\.delete$/.exec(action);
    if (removal) {
      if (removal[1] === 'downloads' && liveDownloads.has(input.recordId)) throw browserError('DOWNLOAD_ACTIVE', '请先取消正在进行的下载');
      store.remove(removal[1], input.recordId); profileChanged(removal[1]); return { ok: true };
    }
    if (action === 'history.clear') { store.clear('history'); profileChanged('history'); return { ok: true }; }
    if (action === 'permissions.set' || action === 'permissions.remove') {
      store.setPermission({ origin: input.origin, permission: input.permission, decision: action === 'permissions.remove' ? 'ask' : input.decision });
      profileChanged('permissions'); return { ok: true };
    }
    if (action === 'data.clear') {
      if (!['history', 'cookies', 'cache', 'permissions'].some(key => input[key] === true)) throw browserError('INVALID_CLEAR_OPTIONS', '请先选择要清除的数据');
      const sessions = browserSession ? [browserSession] : [...sessionListeners.keys()];
      for (const partition of sessions) {
        if (input.cookies === true) { await partition.clearStorageData(); await partition.clearAuthCache?.(); }
        if (input.cache === true) await partition.clearCache();
      }
      for (const section of ['history', 'permissions']) if (input[section] === true) { store.clear(section); profileChanged(section); }
      return { ok: true };
    }
    if (/^downloads\.(pause|resume|cancel|open|showInFolder)$/.test(action)) {
      const verb = action.split('.')[1], entry = liveDownloads.get(input.recordId), saved = store.getDownload(input.recordId);
      if (!saved) throw browserError('DOWNLOAD_NOT_FOUND', '下载记录不存在');
      if (['pause', 'resume', 'cancel'].includes(verb)) {
        if (!entry) throw browserError('DOWNLOAD_NOT_ACTIVE', '此下载已结束，无法继续控制');
        if (verb === 'resume' && !downloadSnapshot(entry).canResume) throw browserError('DOWNLOAD_NOT_RESUMABLE', '服务器不支持继续此下载');
        entry.item[verb]();
        if (liveDownloads.get(input.recordId) === entry) persistDownload(entry, verb === 'pause' ? 'paused' : verb === 'cancel' ? 'cancelled' : undefined, true);
      } else {
        const record = entry ? downloadSnapshot(entry) : saved;
        if (!record.path || !path.isAbsolute(record.path) || !fs.existsSync(record.path)) throw browserError('DOWNLOAD_FILE_MISSING', '下载文件已移动或删除');
        if (verb === 'open') {
          if (record.state !== 'completed') throw browserError('DOWNLOAD_INCOMPLETE', '请等待下载完成后再打开');
          const error = await shell.openPath(record.path); if (error) throw browserError('DOWNLOAD_OPEN_FAILED', '无法打开这个下载文件');
        } else shell.showItemInFolder(record.path);
      }
      return { ok: true };
    }
    return null;
  }
  async function savePage(tab, action) {
    if (!dialog?.showSaveDialog) throw browserError('DIALOG_UNAVAILABLE', '保存对话框暂不可用');
    const wc = tab.view.webContents, epoch = tab.navigationEpoch, url = wc.getURL(), extension = action === 'savePdf' ? 'pdf' : 'png';
    const result = await dialog.showSaveDialog(owner, { title: extension === 'pdf' ? '保存网页为 PDF' : '保存网页截图',
      defaultPath: path.join(store.settings().downloadDirectory || '', safeFilename(tab.title, 'webpage') + '.' + extension),
      filters: [{ name: extension === 'pdf' ? 'PDF 文档' : 'PNG 图片', extensions: [extension] }] });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    if (!alive(wc) || tab.navigationEpoch !== epoch || wc.getURL() !== url) throw browserError('BROWSER_CAPTURE_STALE', '网页已改变，请重新保存');
    let buffer;
    if (extension === 'pdf') buffer = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
    else {
      const screenshot = await wc.capturePage();
      if (screenshot.isEmpty()) throw browserError('BROWSER_CAPTURE_EMPTY', '网页截图暂不可用'); buffer = screenshot.toPNG();
    }
    if (destroyed || !tabs.has(tab.id) || !alive(wc) || tab.navigationEpoch !== epoch || wc.getURL() !== url) throw browserError('BROWSER_CAPTURE_STALE', '网页已改变，请重新保存');
    await fs.promises.writeFile(result.filePath, buffer); return { ok: true, path: result.filePath };
  }
  async function fillPage(tab, input) {
    if (tab.privateSession) throw browserError('PREVIEW_PRIVATE', '代码预览不使用浏览器中保存的个人信息');
    if (!formStore) throw browserError('ENCRYPTION_UNAVAILABLE', '本机安全存储暂不可用');
    if (!tab.presented || activeId !== tab.id) throw browserError('BROWSER_NOT_VISIBLE', '请先显示要填写的网页');
    const wc = tab.view.webContents, url = wc.getURL(), epoch = tab.navigationEpoch;
    const origin = new URL(url).origin;
    if (!url.startsWith('https:')) throw browserError('INSECURE_FORM', '仅在 HTTPS 网页上填写保存的信息');
    if (input.expectedUrl && input.expectedUrl !== url) throw browserError('FORM_PAGE_CHANGED', '网页已改变，请重新选择填写');
    let fields;
    if (input.action === 'passwords.fill') {
      const result = await formStore.invoke({ action: 'passwords.reveal', recordId: input.recordId, origin });
      if (!result.ok) return result;
      if (result.origin !== origin) throw browserError('ORIGIN_MISMATCH', '保存的账号不属于这个网站');
      fields = { username: result.username, password: result.password };
    } else {
      const result = await formStore.invoke({ action: 'contacts.list' }); if (!result.ok) return result;
      const record = result.items.find(item => item.recordId === input.recordId);
      if (!record) throw browserError('CONTACT_NOT_FOUND', '联系人不存在');
      fields = { name: record.name, email: record.email, phone: record.phone, address: record.address };
    }
    if (destroyed || !tabs.has(tab.id) || !tab.presented || activeId !== tab.id || !alive(wc) || tab.navigationEpoch !== epoch || wc.getURL() !== url) throw browserError('FORM_PAGE_CHANGED', '网页已改变，请重新选择填写');
    // These values are delivered only after an explicit trusted UI command.
    // Recheck the target inside Chromium as navigation can race IPC delivery.
    // No form is submitted and no fields are read back into Relay.
    const payload = JSON.stringify({ origin, url, fields, password: input.action === 'passwords.fill' });
    const result = await wc.executeJavaScript(`(() => {
      const request = ${payload};
      if (document.visibilityState !== 'visible' || location.protocol !== 'https:' || location.origin !== request.origin || location.href !== request.url) return { changed: true };
      const visible = node => node && !node.disabled && !node.readOnly && node.getClientRects().length > 0;
      const set = (node, value) => {
        const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      let filled = 0;
      if (request.password) {
        const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
        if (!password) return { filled: 0 };
        const scope = password.form || document;
        const username = Array.from(scope.querySelectorAll('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[type="text"]')).find(visible);
        if (username) { set(username, request.fields.username); filled++; }
        set(password, request.fields.password); filled++;
      } else {
        const selectors = { name: 'input[autocomplete="name"],input[name="name"]', email: 'input[autocomplete="email"],input[type="email"]',
          phone: 'input[autocomplete="tel"],input[type="tel"]', address: 'textarea[autocomplete="street-address"],input[autocomplete="street-address"],input[autocomplete="address-line1"]' };
        for (const [key, selector] of Object.entries(selectors)) {
          if (!request.fields[key]) continue;
          for (const node of Array.from(document.querySelectorAll(selector)).filter(visible)) { set(node, request.fields[key]); filled++; }
        }
      }
      return { filled };
    })()`, true);
    if (result.changed) throw browserError('FORM_PAGE_CHANGED', '网页已改变，请重新选择填写');
    if (!result.filled) throw browserError('FORM_NOT_FOUND', '当前网页没有可填写的对应表单');
    return { ok: true, filled: result.filled };
  }
  async function invoke(input = {}) {
    try {
      if (destroyed || retiring || owner.isDestroyed()) throw browserError('BROWSER_CLOSED', '浏览器窗口已关闭');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw browserError('INVALID_ACTION', '浏览器操作无效');
      const { action, id } = input;
      if (action === 'shortcuts.set') {
        if (!input.bindings || typeof input.bindings !== 'object' || Array.isArray(input.bindings)) throw browserError('INVALID_SHORTCUTS', '快捷键配置无效');
        const next = new Map();
        for (const [name, chords] of Object.entries(input.bindings)) {
          if (!WORKSPACE_ACTIONS.has(name) || !Array.isArray(chords) || chords.length > 3) throw browserError('INVALID_SHORTCUTS', '快捷键配置无效');
          for (const value of chords) {
            const result = validateChord(value);
            if (!result.ok || next.has(result.chord)) throw browserError('INVALID_SHORTCUTS', '快捷键配置无效');
            next.set(result.chord, name);
          }
        }
        workspaceBindings = next;
        return { ok: true };
      }
      const managed = await profileAction(input); if (managed) return managed;
      if (action === 'resolve') return { ok: true, url: resolveBrowserAddress(input.text, store.settings().searchEngine) };
      if (action === 'openLink') {
        const url = normalizeBrowserUrl(input.url), settings = store.settings();
        if (url !== 'about:blank' && settings[localWebUrl(url) ? 'localLinkTarget' : 'webLinkTarget'] === 'external') { await shell.openExternal(url); return { ok: true, external: true, url }; }
        const ownerConversationId = input.ownerConversationId || input.conversationId;
        return create(url, ownerConversationId ? { ownerConversationId: taskId(ownerConversationId) } : {});
      }
      if (action === 'create' || action === 'createPreview' || action === 'duplicatePreview') {
        // Correlate the early created event with its renderer request without
        // retaining client metadata on the native tab or forwarding extra fields.
        const clientRequestId = typeof input.clientRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.clientRequestId)
          ? input.clientRequestId : null;
        const metadata = clientRequestId ? { clientRequestId } : {};
        const ownerConversationId = input.ownerConversationId || input.conversationId;
        if (ownerConversationId) metadata.ownerConversationId = taskId(ownerConversationId);
        if (action === 'createPreview') return create(null, metadata, previewDocument(input.html, input.title));
        if (action === 'duplicatePreview') {
          const originalTab = requireTab(input.id), original = originalTab.preview;
          if (!original) throw browserError('NOT_A_PREVIEW', '这个标签不是代码预览');
          if (originalTab.ownerConversationId) metadata.ownerConversationId = originalTab.ownerConversationId;
          return create(null, metadata, previewDocument(original.html, original.title));
        }
        return create(input.url || 'about:blank', metadata);
      }
      if (action === 'state') return state(id);
      if (action === 'setBounds') return setBounds(input.rect, input.coordinateScale == null ? coordinateScale : input.coordinateScale);
      if (action === 'visibility') return setVisibility(input.visible, id);
      const tab = requireTab(id || activeId), wc = tab.view.webContents;
      if (action === 'close') return remove(tab);
      if (!alive(wc)) throw browserError('TAB_CLOSED', '网页进程已关闭');
      if (action === 'security.continue') {
        tab.connectionSecurity.proceed(input.challengeId); tab.loading = true; return state(tab.id);
      }
      if (action === 'security.useHttp') {
        const target = new URL(tab.url);
        if (target.protocol !== 'https:' || !tab.error) throw browserError('HTTP_FALLBACK_UNAVAILABLE', '当前网页不需要切换为 HTTP');
        target.protocol = 'http:'; return navigate(tab, target.href);
      }
      if (action === 'passwords.fill' || action === 'contacts.fill') return await fillPage(tab, input);
      if (action === 'savePdf' || action === 'saveScreenshot') return await savePage(tab, action);
      if (action === 'print') return await new Promise(resolve => wc.print({ silent: false, printBackground: true }, (success, reason) => resolve(success ? { ok: true } : { ok: false, code: 'PRINT_CANCELLED', error: text(reason || '打印已取消') })));
      if (action === 'bookmark') {
        if (ownsPreviewUrl(tab.preview, tab.url)) throw browserError('PREVIEW_PRIVATE', '代码预览不会保存到浏览器收藏');
        const existing = store.getBookmark(tab.url);
        let item; if (input.toggle && existing) { store.remove('bookmarks', existing.id); item = null; } else item = store.bookmark({ url: tab.url, title: tab.title });
        profileChanged('bookmarks'); update(tab); return { ok: true, item, bookmarked: !!item };
      }
      if (action === 'navigate') return navigate(tab, input.url);
      if (action === 'back' || action === 'forward') {
        const history = wc.navigationHistory;
        if (action === 'back' ? history.canGoBack() : history.canGoForward()) { tab.faviconReader.reset(); history[action === 'back' ? 'goBack' : 'goForward'](); }
      } else if (action === 'reload') { tab.connectionSecurity.target(tab.url); tab.faviconReader.reset(); tab.error = null; wc.reload(); }
      else if (action === 'devTools') { if (input.open === false || input.open == null && wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' }); }
      else if (action === 'mute') { if (typeof input.muted !== 'boolean') throw browserError('INVALID_MUTE', '静音状态无效'); wc.setAudioMuted(input.muted); }
      else if (action === 'stop') { tab.connectionSecurity.cancel(); tab.faviconReader.reset(); tab.navigationEpoch++; tab.loading = false; wc.stop(); }
      else if (action === 'focus') {
        if (tab.presented && activeId === tab.id && owner.isVisible?.() !== false && !owner.isMinimized?.()) wc.focus();
      }
      else if (action === 'capture') {
        if (!tab.presented || activeId !== tab.id) throw browserError('BROWSER_NOT_VISIBLE', '只能截取当前显示的网页');
        const epoch = tab.navigationEpoch, url = wc.getURL();
        let screenshot = await wc.capturePage();
        if (destroyed || retiring || !tabs.has(tab.id) || !tab.presented || activeId !== tab.id || tab.navigationEpoch !== epoch || wc.getURL() !== url) {
          throw browserError('BROWSER_CAPTURE_STALE', '网页显示状态已改变');
        }
        if (screenshot.isEmpty()) throw browserError('BROWSER_CAPTURE_EMPTY', '网页截图暂不可用');
        const size = screenshot.getSize(), longest = Math.max(size.width, size.height);
        if (longest > 1600) screenshot = screenshot.resize({ width: Math.max(1, Math.round(size.width * 1600 / longest)), height: Math.max(1, Math.round(size.height * 1600 / longest)) });
        return { ok: true, id: tab.id, dataUrl: screenshot.toDataURL() };
      } else if (action === 'zoom') {
        if (!Number.isFinite(input.factor) || input.factor < 0.25 || input.factor > 3) throw browserError('INVALID_ZOOM', '网页缩放比例无效');
        wc.setZoomFactor(input.factor); tab.zoom = input.factor;
      } else if (action === 'find') {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000) throw browserError('INVALID_FIND', '请输入要查找的文字');
        // Electron 32 calls Blink's new_session flag `findNext` (true starts
        // a search). Our public findNext means advance within the same query.
        const newSession = !input.findNext || tab.findText !== input.text;
        const requestId = wc.findInPage(input.text, { forward: input.forward !== false, findNext: newSession, matchCase: !!input.matchCase });
        tab.findText = input.text;
        return { ...state(tab.id), requestId };
      } else if (action === 'stopFind') { wc.stopFindInPage('clearSelection'); tab.findText = null; }
      else if (action === 'openExternal') {
        const target = normalizeBrowserUrl(input.url || tab.url);
        if (target === 'about:blank' || !shell || typeof shell.openExternal !== 'function') throw browserError('UNSUPPORTED_URL', '这个地址无法在系统浏览器打开');
        await shell.openExternal(target);
      } else throw browserError('INVALID_ACTION', '浏览器操作无效');
      update(tab); return state(tab.id);
    } catch (error) { return { ok: false, code: error.code || 'BROWSER_FAILED', error: text(error.message || '浏览器操作失败') }; }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const capture of automationDownloads.values()) capture.cancel(browserError('BROWSER_CLOSED', '浏览器窗口已关闭，下载已取消'));
    automationDownloads.clear();
    owner.removeListener('resize', layout); owner.removeListener('move', layout); owner.removeListener('focus', layout); owner.removeListener('close', ownerClose); owner.removeListener('closed', ownerGone);
    for (const name of ['hide', 'minimize']) owner.removeListener(name, suspend);
    for (const name of ['show', 'restore']) owner.removeListener(name, resume);
    if (owner.webContents) {
      owner.webContents.removeListener('destroyed', ownerGone); owner.webContents.removeListener('render-process-gone', ownerGone);
      owner.webContents.removeListener('will-navigate', destroy); owner.webContents.removeListener('did-start-navigation', ownerNavigation);
    }
    for (const entry of liveDownloads.values()) {
      // cancel() can emit done synchronously or after the owner has gone.
      // Retire callbacks first so teardown writes the terminal state once.
      detachDownload(entry);
      try { entry.item.cancel(); } catch (_) {}
      persistDownload(entry, 'interrupted', true);
    }
    for (const [partition, listener] of sessionListeners) {
      partition.removeListener('will-download', listener);
      partition.setPermissionCheckHandler(() => false); partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    }
    sessionListeners.clear();
    if (browserSession) { try { browserSession.flushStorageData?.(); } catch (_) {} }
    for (const tab of [...tabs.values()]) remove(tab);
  }
  function ownerGone() {
    if (retiring || destroyed) return;
    retiring = true;
    // Closing other WebContents inside an owner's native destruction callback
    // can re-enter Chromium teardown on Windows. Retire now, release next tick.
    setImmediate(destroy);
  }
  function suspend() { ownerSuspended = true; layout(); }
  function resume() { ownerSuspended = false; layout(); }
  function ownerClose(event) {
    // Relay's close-to-tray listener runs first and prevents the close. For a
    // real close, release child views before Chromium tears down the owner.
    if (!event.defaultPrevented) destroy();
  }
  function ownerNavigation(event, _url, isInPlace, isMainFrame) {
    const main = event && typeof event.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
    const inPage = event && typeof event.isSameDocument === 'boolean' ? event.isSameDocument : isInPlace;
    if (main !== false && !inPage) destroy();
  }
  owner.on('resize', layout); owner.on('move', layout); owner.on('focus', layout); owner.on('close', ownerClose); owner.once('closed', ownerGone);
  for (const name of ['hide', 'minimize']) owner.on(name, suspend);
  for (const name of ['show', 'restore']) owner.on(name, resume);
  if (owner.webContents) {
    owner.webContents.on('destroyed', ownerGone); owner.webContents.on('render-process-gone', ownerGone);
    owner.webContents.on('will-navigate', destroy); owner.webContents.on('did-start-navigation', ownerNavigation);
  }
  // Main-process capability only. Never serialize WebContents through renderer
  // IPC; task ownership and input leases are enforced by the automation service.
  function getAutomationTarget(id) {
    if (destroyed || retiring) throw browserError('BROWSER_CLOSED', '浏览器窗口已关闭');
    const tab = requireTab(id), webContents = tab.view.webContents;
    if (!alive(webContents)) throw browserError('TAB_CLOSED', '网页进程已关闭');
    if (tab.backgroundWindow?.isDestroyed?.()) backgroundUnavailable(tab, browserError('BROWSER_BACKGROUND_UNAVAILABLE', '后台网页渲染宿主已关闭。'));
    if (tab.backgroundWindow && tab.backgroundInitializationFailed && tab.conversationId && tab.taskState === 'controlled') startBackgroundInitialization(tab);
    return { id: tab.id, webContents, privateSession: tab.privateSession, presented: !!tab.presented,
      ownerConversationId: tab.ownerConversationId || null, backgroundCapable: !tab.backgroundFailure,
      backgroundReady: tab.backgroundReady };
  }
  function beginAutomationDownload(id, { directory, signal, check, timeoutMs } = {}) {
    const tab = requireTab(id), contents = tab.view.webContents;
    if (automationDownloads.has(id)) throw browserError('BROWSER_DOWNLOAD_BUSY', '此网页已有一个等待中的下载');
    const guard = () => {
      if (destroyed || retiring || !tabs.has(id) || tab.view.webContents !== contents || !alive(contents)) throw browserError('TAB_CLOSED', '下载网页已关闭或更换');
      if (tab.privateSession) throw browserError('PRIVATE_TAB', '私密网页不允许自动下载');
      if (!tab.conversationId || tab.taskState !== 'controlled') throw browserError('STALE_LEASE', '下载网页尚未交给当前任务控制');
      if (typeof check !== 'function') throw browserError('BROWSER_DOWNLOAD_CONTEXT', '下载缺少任务授权检查');
      return check();
    };
    let capture;
    capture = createAutomationDownload({ directory, signal, check: guard, timeoutMs,
      onSettled: (result, error) => {
        // Keep successful captures consumed until the calling gesture has
        // finished its post-click observation and explicitly releases the ticket.
        if (error && automationDownloads.get(id) === capture) automationDownloads.delete(id);
        emit('download', tab, result ? { item: result, status: 'completed', filename: result.filename, taskDownload: true }
          : { status: 'interrupted', error: error?.message || '下载未完成' });
      } });
    automationDownloads.set(id, capture);
    return { result: capture.result, arm: () => capture.arm(), cancel(reason) {
      if (automationDownloads.get(id) === capture) automationDownloads.delete(id);
      capture.cancel(reason);
    } };
  }
  // These methods are main-process capabilities; the automation service checks
  // task ownership/leases before invoking them. They never announce human input.
  function navigateTab(id, url) { return navigate(requireTab(id), normalizeBrowserUrl(url)); }
  function activateTab(id) {
    const tab = requireTab(id);
    const result = setVisibility(true, id);
    emit('automation-activate', tab, { conversationId: tab.conversationId });
    return result;
  }
  return { invoke, state, setBounds, setVisibility, getAutomationTarget, beginAutomationDownload,
    setTaskBinding, listTaskTabs, restoreTaskTabs, captureAnnotationTarget, startAnnotation, prepareAutomationInput, armAutomationPopup,
    cancelAnnotation: id => cancelAnnotation(requireTab(id)),
    navigateTab, activateTab, closeTab: id => remove(requireTab(id)),
    goBackTab: id => invoke({ action: 'back', id }), goForwardTab: id => invoke({ action: 'forward', id }),
    reloadTab: id => invoke({ action: 'reload', id }),
    destroy, isDestroyed: () => destroyed || retiring, ownsWebContents: contents => [...tabs.values()].some(tab => tab.view.webContents === contents) };
}

module.exports = { createBrowserPanelHost, normalizeBrowserUrl, resolveBrowserAddress, localWebUrl };
