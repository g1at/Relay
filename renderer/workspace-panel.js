(function () {
  'use strict';
  const app = document.querySelector('.app');
  const panel = document.getElementById('workspacePanel');
  const toggle = document.getElementById('btnWorkspacePanel');
  const handle = document.getElementById('workspaceResizeHandle');
  if (!app || !panel || !toggle || !handle) return;
  const $ = id => document.getElementById(id);
  const bridge = window.api && window.api.workspace;
  const icons = {
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    review: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 12h6M11 9v6M8 18h6"/>',
    close: '<path d="m7 7 10 10M7 17 17 7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    reload: '<path d="M20 7v5h-5M4 17v-5h5M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    restore: '<path d="M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    bookmark: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    print: '<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6Z"/>',
    camera: '<rect x="3" y="6" width="18" height="15" rx="2"/><path d="m8 6 2-3h4l2 3"/><circle cx="12" cy="13" r="4"/>',
    settings: '<path d="M4 7h7M15 7h5M4 17h3M11 17h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    sound: '<path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',

  };
  function icon(name, className = '') {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.6');
    node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    if (className) node.setAttribute('class', className);
    node.innerHTML = icons[name] || icons.file;
    return node;
  }
  const MIN_WIDTH = 300, DEFAULT_WIDTH = 380, MIN_MAIN = 360, STORAGE_KEY = 'relay.workspace-panel.width.v1';
  const COLLAPSE_WIDTH = 240, REOPEN_WIDTH = MIN_WIDTH;
  const SNAP_MAIN = 280, RESTORE_MAIN = 320, SNAP_DURATION = 280;
  let preferredWidth = DEFAULT_WIDTH, width = 0, opened = false, tab = null, maximized = false, restoreWidth = DEFAULT_WIDTH;
  let automaticMaximized = false, snapTimer = null;
  try { const saved = Number(localStorage.getItem(STORAGE_KEY)); if (saved >= MIN_WIDTH && saved < 10000) preferredWidth = saved; } catch (_) {}
  let drag = null, layoutFrame = null, lastLayoutWidth = -1, lastLayoutViewportWidth = -1;
  let context = null, contextKey = '', revision = 0, filesRevision = 0, previewRevision = 0;
  let workspace = null, expanded = new Set(), entries = new Map(), preview = null, sourceMode = false, previewImages = null;
  let directoryLink = null, selectedDirectory = null;
  let loadingFiles = false, fileFingerprint = '';
  let htmlSuspended = false;
  const sessions = new Map(), pendingTerminals = new Set(), earlyEvents = new Map();
  let termNumber = 0, disposed = false;
  function readContext() {
    return typeof window.relayConversationWorkspace === 'function' ? window.relayConversationWorkspace() : null;
  }
  const keyFor = value => value ? JSON.stringify([value.conversationId, value.workingDir || null]) : '';
  const notice = message => { $('workspaceFileNotice').textContent = message || ''; };
  function assertResult(result) { if (!result || result.ok === false) throw new Error(result && result.error || '操作未完成，请重试'); return result; }
  function maxWidth() { return Math.max(MIN_WIDTH, app.clientWidth); }
  function splitRestoreWidth(value, maximum = maxWidth()) { return Math.max(MIN_WIDTH, Math.min(Number(value) || DEFAULT_WIDTH, maximum - RESTORE_MAIN)); }
  const snapMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function clearSnapAnimation() {
    if (snapTimer != null) clearTimeout(snapTimer);
    snapTimer = null; app.classList.remove('is-workspace-snapping', 'is-workspace-collapsing');
  }
  function armSnapTimeout() {
    if (snapTimer != null) clearTimeout(snapTimer);
    snapTimer = setTimeout(clearSnapAnimation, SNAP_DURATION + 34);
  }
  function animateSnap() {
    clearSnapAnimation();
    if (snapMotion.matches || disposed) return;
    app.classList.add('is-workspace-snapping'); armSnapTimeout();
  }
  app.addEventListener('transitionrun', event => {
    if (event.target === app && event.propertyName === 'grid-template-columns' && app.classList.contains('is-workspace-snapping')) armSnapTimeout();
  });
  app.addEventListener('transitionend', event => { if (event.target === app && event.propertyName === 'grid-template-columns') clearSnapAnimation(); });
  snapMotion.addEventListener?.('change', event => { if (event.matches) clearSnapAnimation(); });
  window.addEventListener('pagehide', clearSnapAnimation);
  function layout(geometry = null) {
    // Measure before changing either grid column; both panes reuse this snapshot.
    const viewportWidth = Number.isFinite(geometry?.viewportWidth) ? geometry.viewportWidth : app.clientWidth;
    const maximum = Math.max(MIN_WIDTH, viewportWidth);
    const displayed = opened && (!app.dataset.view || app.dataset.view === 'chat');
    if (!displayed && $('workspacePreviewBody').querySelector('.workspace-html-frame')) {
      htmlSuspended = true; disposeHtmlPreview();
    } else if (displayed && htmlSuspended) {
      htmlSuspended = false;
      if (tab === 'files' && preview && !sourceMode) renderPreview();
    }
    if (!displayed) {
      if ((app.dataset.view && app.dataset.view !== 'chat') || !app.classList.contains('is-workspace-collapsing')) clearSnapAnimation();
      if (automaticMaximized) { maximized = false; automaticMaximized = false; }
    } else if (!drag) {
      const remaining = maximum - Math.max(MIN_WIDTH, Math.min(preferredWidth, maximum));
      const wasFull = maximized;
      if (automaticMaximized && remaining >= RESTORE_MAIN) { maximized = false; automaticMaximized = false; }
      else if (!maximized && remaining <= SNAP_MAIN) { maximized = true; automaticMaximized = true; restoreWidth = splitRestoreWidth(preferredWidth, maximum); }
      if (wasFull !== maximized && lastLayoutWidth > 0) animateSnap();
    }
    const splitWidth = drag && !drag.collapsed && Number.isFinite(drag.targetWidth)
      ? Math.max(COLLAPSE_WIDTH, Math.min(drag.targetWidth, maximum))
      : Math.max(MIN_WIDTH, Math.min(preferredWidth, maximum));
    width = displayed ? maximized ? maximum : splitWidth : 0;
    // All three panes use the same grid budget. The sidebar temporarily shrinks
    // within the remainder without changing its saved width or collapse choice.
    app.style.setProperty('--workspace-visible-width', width + 'px');
    app.style.setProperty('--workspace-panel-width', width + 'px');
    handle.style.setProperty('--workspace-panel-width', width + 'px');
    app.classList.toggle('workspace-open', displayed);
    app.classList.toggle('workspace-maximized', displayed && maximized);
    panel.inert = !displayed; panel.setAttribute('aria-hidden', String(!displayed));
    toggle.setAttribute('aria-expanded', String(displayed));
    toggle.title = opened ? '收起右侧栏' : '展开文件、浏览器、终端、审查与任务';
    toggle.setAttribute('aria-label', toggle.title);
    // Keep the captured grip alive through collapse so a reverse movement in
    // the same gesture can reopen the pane, or Escape can restore its state.
    handle.hidden = !displayed && !drag;
    handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', width + ' 像素');
    if (lastLayoutWidth !== width || lastLayoutViewportWidth !== viewportWidth) {
      lastLayoutWidth = width; lastLayoutViewportWidth = viewportWidth;
      window.dispatchEvent(new CustomEvent('relay:workspace-layout', { detail: { width, open: opened, minMainWidth: MIN_MAIN, viewportWidth } }));
    }
    const maximizeButton = $('workspaceMaximize'), full = displayed && maximized;
    if (maximizeButton.getAttribute('aria-pressed') !== String(full)) {
      maximizeButton.setAttribute('aria-pressed', String(full)); maximizeButton.title = full ? '恢复阅读区域' : '放大阅读区域'; maximizeButton.setAttribute('aria-label', maximizeButton.title);
      maximizeButton.replaceChildren(icon(full ? 'restore' : 'expand'));
    }
    const sidebarState = window.relaySidebarLayout?.getState({ viewportWidth });
    const leftWidth = window.innerWidth <= 760 ? 0 : sidebarState?.width || 0;
    const mainWidth = Math.max(0, viewportWidth - width - leftWidth);
    const mainConstrained = displayed && mainWidth <= SNAP_MAIN;
    app.classList.toggle('workspace-chat-constrained', mainConstrained);
    app.style.setProperty('--workspace-chat-opacity', mainConstrained ? '0' : '1');
    for (const node of app.children) {
      if (node.id === 'sidebarNavigation' && sidebarState?.constrained && node.contains(document.activeElement)) handle.focus({ preventScroll: true });
      if (!node.classList.contains('chat')) continue;
      if (mainConstrained) {
        if (!priorInert.has(node)) priorInert.set(node, node.inert);
        if (node.contains(document.activeElement)) handle.focus({ preventScroll: true });
        node.inert = true;
      } else if (priorInert.has(node)) {
        node.inert = priorInert.get(node);
        priorInert.delete(node);
      }
    }
    panel.classList.toggle('is-narrow', width < 620);
    syncInternalPages();
    reviewView?.setActive(displayed && tab === 'review');
    fitTerminal(); scheduleNative();
  }
  function saveWidth() { try { localStorage.setItem(STORAGE_KEY, String(maximized ? restoreWidth : preferredWidth)); } catch (_) {} }
  function resizeWidth(value, { forceSplit = false, viewportWidth = app.clientWidth } = {}) {
    const maximum = Math.max(MIN_WIDTH, viewportWidth);
    const next = forceSplit ? splitRestoreWidth(value, maximum) : Math.max(MIN_WIDTH, Math.min(maximum, value));
    const remaining = maximum - next;
    const full = maximized ? remaining < RESTORE_MAIN : remaining <= SNAP_MAIN;
    if (full && !maximized) restoreWidth = splitRestoreWidth(drag ? drag.splitWidth : width || preferredWidth, maximum);
    if (full !== maximized) animateSnap();
    maximized = full; automaticMaximized = false; preferredWidth = next;
  }
  function resizeDrag(viewportWidth = app.clientWidth) {
    if (!drag || !Number.isFinite(drag.targetWidth)) return;
    const wasCollapsed = drag.collapsed;
    if (!wasCollapsed && drag.targetWidth < COLLAPSE_WIDTH) drag.collapsed = true;
    else if (wasCollapsed && drag.targetWidth >= REOPEN_WIDTH) drag.collapsed = false;
    if (drag.collapsed) {
      opened = false; maximized = false; automaticMaximized = false;
    } else {
      opened = true;
      resizeWidth(drag.targetWidth, { viewportWidth });
    }
    if (wasCollapsed !== drag.collapsed) {
      animateSnap();
      if (drag.collapsed && !snapMotion.matches) app.classList.add('is-workspace-collapsing');
    }
  }
  let dragPerformanceFrame = null;
  function measureDragFrame(now) {
    if (!drag) { dragPerformanceFrame = null; return; }
    if (drag.lastFrame != null && drag.frameIntervals.length < 600) drag.frameIntervals.push(now - drag.lastFrame);
    drag.lastFrame = now; dragPerformanceFrame = requestAnimationFrame(measureDragFrame);
  }
  function endDrag(commit) {
    if (!drag) return;
    if (dragPerformanceFrame != null) cancelAnimationFrame(dragPerformanceFrame);
    dragPerformanceFrame = null;
    if (drag.frameIntervals?.length) {
      const frames = drag.frameIntervals.slice().sort((a, b) => a - b);
      window.relayWorkspacePerformance = { samples: frames.length, p95FrameMs: Math.round(frames[Math.floor((frames.length - 1) * .95)]),
        maxFrameMs: Math.round(frames[frames.length - 1]), slowFrames: frames.filter(ms => ms > 32).length };
    }
    if (commit) resizeDrag();
    const previous = drag; drag = null;
    if (!commit) { clearSnapAnimation(); opened = previous.opened; preferredWidth = previous.preferredWidth; maximized = previous.maximized; automaticMaximized = previous.automaticMaximized; restoreWidth = previous.restoreWidth; }
    else if (!previous.collapsed && previous.targetWidth < MIN_WIDTH) animateSnap();
    if (layoutFrame) { cancelAnimationFrame(layoutFrame); layoutFrame = null; }
    app.classList.remove('is-workspace-resizing');
    try { if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id); } catch (_) {}
    layout(); if (commit) saveWidth();
    if (commit && previous.collapsed) {
      navigationRevision++; closeMenus(false); toggle.focus({ preventScroll: true }); dispatchTab();
    }
    window.dispatchEvent(new CustomEvent('relay:workspace-resize-end'));
  }
  handle.addEventListener('pointerdown', event => {
    if (!opened || handle.hidden || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, width, preferredWidth, maximized, automaticMaximized, restoreWidth, opened, collapsed: false, frameIntervals: [], lastFrame: null,
      splitWidth: splitRestoreWidth(maximized ? automaticMaximized ? preferredWidth : restoreWidth : width) };
    dragPerformanceFrame = requestAnimationFrame(measureDragFrame);
    app.classList.add('is-workspace-resizing'); handle.focus({ preventScroll: true });
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  });
  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag.targetWidth = drag.width + drag.x - event.clientX;
    if (!layoutFrame) layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      const viewportWidth = app.clientWidth;
      if (drag) resizeDrag(viewportWidth);
      layout({ viewportWidth });
    });
  }
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', event => { if (drag && event.pointerId === drag.id) { moveDrag(event); endDrag(true); } });
  handle.addEventListener('lostpointercapture', () => endDrag(false));
  window.addEventListener('pointercancel', () => endDrag(false));
  window.addEventListener('blur', () => endDrag(false));
  window.addEventListener('keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); endDrag(false); } }, true);
  handle.addEventListener('dblclick', () => { resizeWidth(DEFAULT_WIDTH, { forceSplit: true }); layout(); saveWidth(); });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 32 : 8;
    const value = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? maximized ? automaticMaximized ? preferredWidth : restoreWidth : width - step
      : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth() : event.key === 'Enter' ? DEFAULT_WIDTH : null;
    if (value == null || drag || handle.hidden) return;
    event.preventDefault(); resizeWidth(value, { forceSplit: event.key === 'ArrowRight' && maximized || ['Home', 'Enter'].includes(event.key) }); layout(); saveWidth();
  });
  let reviewView = null;
  function ensureReview() {
    if (!reviewView && window.RelayWorkspaceReview && $('workspaceReviewMount')) {
      reviewView = window.RelayWorkspaceReview.create({ mount: $('workspaceReviewMount'), api: bridge });
      reviewView.setContext(context);
    }
    return reviewView;
  }
  const tabs = [];
  let activeId = null, navigationRevision = 0, tabNumber = 0;
  let tabsFingerprint = '', menuButton = null;
  const obscured = new Set(), priorInert = new Map();
  const activeTab = () => tabs.find(item => item.id === activeId);
  const fileLayout = window.relayWorkspaceFileLayout = window.RelayWorkspaceFileLayout.create({
    body: $('workspaceFileBody'), tree: $('workspaceTreePane'), handle: $('workspaceTreeResizeHandle'), toggle: $('workspaceTreeToggle'), window,
    getActive: () => opened && tab === 'files' && (!app.dataset.view || app.dataset.view === 'chat'),
  });
  function renderTabs() {
    const hasTabs = tabs.length > 0;
    $('workspaceAdd').hidden = !hasTabs;
    $('workspaceTabs').hidden = !hasTabs;
    $('workspaceNoTabs').hidden = hasTabs;
    if (!hasTabs) {
      panel.querySelectorAll('[data-workspace-content]').forEach(content => { content.hidden = true; });
      $('workspaceTreeToggle').hidden = true;
    }
    const fingerprint = JSON.stringify(tabs.map(item => [item.id, item.title, item.id === activeId]));
    if (fingerprint === tabsFingerprint) return;
    tabsFingerprint = fingerprint;
    const host = $('workspaceTabs'), scroll = host.scrollLeft;
    const focus = host.contains(document.activeElement) ? { id: document.activeElement.closest('[data-tab-id]')?.dataset.tabId, close: document.activeElement.classList.contains('workspace-tab-close') } : null;
    host.replaceChildren();
    for (const item of tabs) {
      const wrapper = document.createElement('div'); wrapper.className = 'workspace-tab-item'; wrapper.dataset.tabId = item.id;
      wrapper.classList.toggle('is-active', item.id === activeId);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'workspace-tab'; button.dataset.workspaceTab = item.kind;
      button.id = item.id === 'files' ? 'workspaceFilesTab' : 'workspaceTab-' + item.id;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(item.id === activeId)); button.setAttribute('aria-controls', ({ files: 'workspaceFiles', browser: 'workspaceBrowser', terminal: 'workspaceTerminal', review: 'workspaceReview' })[item.kind]);
      button.tabIndex = item.id === activeId ? 0 : -1; button.title = item.preview?.path || item.terminalRoot || item.title;
      button.append(item.preview && window.relayWorkspaceFileTypes ? window.relayWorkspaceFileTypes.createIcon(item.preview.path) : icon(item.kind === 'files' ? 'folder' : item.kind));
      const label = document.createElement('span'); label.className = 'workspace-tab-label'; label.textContent = item.title; button.append(label);
      button.addEventListener('click', () => activate(item.id));
      button.addEventListener('keydown', event => {
        if (event.key === 'Delete') { event.preventDefault(); void closeTab(item.id); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const index = tabs.indexOf(item), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); activate(tabs[next].id); $('workspaceTabs').querySelector('[aria-selected="true"]')?.focus();
      });
      const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'workspace-tab-close'; closeButton.setAttribute('aria-label', '关闭标签页：' + item.title); closeButton.title = '关闭标签页'; closeButton.append(icon('close'));
      closeButton.addEventListener('click', () => void closeTab(item.id)); wrapper.append(button, closeButton); host.append(wrapper);
    }
    host.scrollLeft = scroll;
    if (focus) { const wrapper = Array.from(host.children).find(node => node.dataset.tabId === focus.id); wrapper?.querySelector(focus.close ? '.workspace-tab-close' : '.workspace-tab')?.focus({ preventScroll: true }); }
    // Navigation titles arrive after activation. Keep the complete selected tab,
    // including its close control, visible when that label changes width.
    requestAnimationFrame(() => {
      if (opened && !disposed) host.querySelector('[aria-selected="true"]')?.closest('.workspace-tab-item')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function previewScrollElement() { return $('workspacePreviewBody').querySelector('pre.workspace-source') || $('workspacePreviewBody'); }
  function savePreviewScroll() {
    const item = activeTab(); if (!item?.preview) return;
    const scroll = previewScrollElement(), mode = $('workspacePreviewBody').classList.contains('is-source') ? 'source' : 'preview';
    item.scrollPositions ||= {}; item.scrollPositions[mode] = { top: scroll.scrollTop, left: scroll.scrollLeft };
  }
  function restorePreviewScroll() {
    const mode = $('workspacePreviewBody').classList.contains('is-source') ? 'source' : 'preview';
    const position = activeTab()?.scrollPositions?.[mode], scroll = previewScrollElement();
    scroll.scrollTop = position?.top || 0; scroll.scrollLeft = position?.left || 0;
  }
  function activate(id, { refresh = true, reveal = true } = {}) {
    const item = tabs.find(value => value.id === id); if (!item) return;
    clearTimeout(findTimer); findTimer = null;
    $('workspaceNotice').textContent = '';
    navigationRevision++; savePreviewScroll(); disposeHtmlPreview(); activeId = id; tab = item.kind; if (reveal) opened = true; closeMenus(false);
    preview = item.preview || null; sourceMode = !!item.sourceMode;
    panel.querySelectorAll('[data-workspace-content]').forEach(content => { content.hidden = content.dataset.workspaceContent !== tab; });
    $('workspaceNoTabs').hidden = true; $('workspaceTreeToggle').hidden = tab !== 'files';
    renderTabs(); syncFileLayout();
    if (tab === 'files') { if (preview) { renderPreview(); } else { showTree(); } if (refresh) void refreshFiles(); }
    if (tab === 'terminal') { renderTerminals(); requestAnimationFrame(() => { if (reveal && opened && activeId === id && (!app.dataset.view || app.dataset.view === 'chat')) currentTerminal()?.terminal.focus(); }); }
    if (tab === 'browser') renderBrowser();
    if (tab === 'review') ensureReview();
    layout(); dispatchTab(); syncNative();
    requestAnimationFrame(() => { if (activeId === id) $('workspaceTabs').querySelector('[aria-selected="true"]')?.closest('.workspace-tab-item')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }
  function dispatchTab() { window.dispatchEvent(new CustomEvent('relay:workspace-tab', { detail: { tab, open: opened, id: activeId } })); }
  function open(next = null, { startTerminal = false, refresh = true } = {}) {
    opened = true; syncContext();
    const kind = ['files', 'browser', 'terminal', 'review'].includes(next) ? next : null;
    if (!kind && !tabs.length) {
      renderTabs(); layout(); dispatchTab(); syncNative();
      $('workspaceLauncherActions').querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
      return;
    }
    if (kind === 'browser') { const existing = tabs.find(item => item.kind === kind); if (existing) activate(existing.id); else void createBrowser(); return; }
    if (kind === 'terminal') { void openTerminal(); return; }
    let item = kind ? tabs.find(value => value.id === (kind === 'files' ? 'files' : kind)) : activeTab();
    if (!item) { const type = kind || 'files'; item = { id: type, kind: type, title: ({ files: '打开文件', terminal: '终端', review: '审查' })[type] }; tabs.push(item); }
    activate(item.id, { refresh });
  }
  function close() {
    if (!opened) return;
    navigationRevision++; disposeHtmlPreview(); endDrag(false); closeMenus(false); opened = false; setMaximized(false, { preservePreference: true });
    if (panel.contains(document.activeElement)) toggle.focus();
    layout(); dispatchTab(); syncNative();
  }
  async function closeTab(id, { remoteClosed = false } = {}) {
    const index = tabs.findIndex(item => item.id === id); if (index < 0) return;
    const item = tabs[index];
    if (item.kind === 'terminal' && !await closeTerminal(item)) return;
    if (!tabs.includes(item)) return;
    if (item.kind === 'browser') {
      item.browserNavigation = (item.browserNavigation || 0) + 1;
      // A logical tab may retain native history on either side of a local page.
      // Detach all native IDs first so their closed events cannot close it twice.
      const ids = nativeBrowserIds(item);
      for (const browserId of ids) releaseNativeBrowser(browserId);
    }
    if (item.id === activeId) savePreviewScroll();
    if (item.kind === 'browser' && !item.browser?.isPreview && item.browser?.url && item.browser.url !== 'about:blank') { closedPages.push(item.browser.url); if (closedPages.length > 20) closedPages.shift(); }
    item.managerView?.destroy(); item.managerMount?.remove();
    if (item.kind === 'review') { reviewView?.destroy(); reviewView = null; }
    tabs.splice(tabs.indexOf(item), 1);
    if (item.id !== activeId) { renderTabs(); return; }
    previewRevision++; disposeHtmlPreview();
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) { const wasOpen = opened; activate(next.id); if (!wasOpen) { opened = false; layout(); dispatchTab(); syncNative(); } }
    else { navigationRevision++; activeId = null; tab = null; preview = null; panel.querySelectorAll('[data-workspace-content]').forEach(content => { content.hidden = true; }); $('workspaceNoTabs').hidden = false; $('workspaceTreeToggle').hidden = true; renderTabs(); dispatchTab(); syncNative(); if (opened) $('workspaceLauncherActions').querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); }
  }
  function setMaximized(value, { preservePreference = false } = {}) {
    const full = opened && !!value;
    if (full && !maximized) restoreWidth = splitRestoreWidth(width || preferredWidth);
    if (!full && maximized && (!automaticMaximized || !preservePreference)) preferredWidth = splitRestoreWidth(automaticMaximized ? preferredWidth : restoreWidth);
    if (full !== maximized) animateSnap();
    maximized = full; automaticMaximized = false;
    layout(); syncNative();
  }
  function syncFileLayout() {
    const isPreview = !!activeTab()?.preview;
    fileLayout.sync({ preview: isPreview, key: activeTab()?.id || null });
    $('workspaceFileEmpty').hidden = isPreview;
    $('workspaceFileTree').hidden = false;
  }
  function closeMenus(restoreFocus = true) {
    const previous = menuButton; menuButton = null;
    for (const [menu, button] of [['workspaceAddMenu', 'workspaceAdd'], ['workspaceBrowserMenu', 'workspaceBrowserMore']]) { if (!$(menu).hidden) $(menu).hidden = true; $(button).setAttribute('aria-expanded', 'false'); }
    if (restoreFocus && previous) previous.focus({ preventScroll: true });
    scheduleNative();
  }
  function menuItem(host, label, iconName, action, disabled = false) {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = disabled; button.append(icon(iconName));
    const text = document.createElement('span'); text.textContent = label; button.append(text); host.append(button);
    button.addEventListener('click', () => { closeMenus(false); action(); }); return button;
  }
  function showMenu(id, button) {
    const menu = $(id), wasOpen = !menu.hidden; closeMenus(false); if (wasOpen) return;
    menu.hidden = false; menuButton = button; button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect(), box = panel.getBoundingClientRect();
    const menuWidth = Math.min(224, box.width - 20); menu.style.width = menuWidth + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left - box.left, box.width - menuWidth - 8)) + 'px'; menu.style.top = (rect.bottom - box.top + 6) + 'px'; menu.style.maxHeight = Math.max(60, box.bottom - rect.bottom - 14) + 'px';
    syncNative(); menu.querySelector('button:not(:disabled)')?.focus();
  }
  const workspaceShortcutIds = { browser: 'newBrowser', files: 'openFiles', terminal: 'newTerminal', review: 'openReview' };
  const shortcutStore = window.relayKeyboardShortcuts;
  const shortcutIsMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  function syncToolShortcut(button) {
    const actionId = workspaceShortcutIds[button.dataset.workspaceCreate];
    if (!actionId) return;
    const label = shortcutStore?.getLabel?.(actionId, shortcutIsMac) || '';
    const aria = shortcutStore?.getAriaShortcuts?.(actionId, shortcutIsMac) || '';
    let hint = button.querySelector('.workspace-shortcut');
    if (!hint) { hint = document.createElement('kbd'); hint.className = 'workspace-shortcut'; hint.setAttribute('aria-hidden', 'true'); button.append(hint); }
    hint.textContent = label; hint.hidden = !label;
    button.title = (button.dataset.toolTitle || '') + (label ? ' (' + label + ')' : '');
    if (aria) button.setAttribute('aria-keyshortcuts', aria); else button.removeAttribute('aria-keyshortcuts');
  }
  function decorateToolShortcut(button, action) {
    button.dataset.workspaceCreate = action.kind;
    button.dataset.toolTitle = action.disabled ? (button.title || '组件未加载，请重启 Relay') : '打开' + action.label;
    syncToolShortcut(button);
  }
  async function syncNativeWorkspaceShortcuts() {
    if (!browserBridge?.invoke || !shortcutStore?.get) return;
    const source = shortcutStore.get().bindings;
    const bindings = Object.fromEntries(Object.values(workspaceShortcutIds).map(id => [id, source[id] || []]));
    try { await browserBridge.invoke({ action: 'shortcuts.set', bindings }); } catch (_) {}
  }
  const stopShortcutHints = shortcutStore?.subscribe?.(() => {
    void syncNativeWorkspaceShortcuts();
    for (const button of panel.querySelectorAll('[data-workspace-create]')) syncToolShortcut(button);
  });
  function createTool(kind) {
    const action = toolActions().find(item => item.kind === kind);
    if (!action || action.disabled) return false;
    opened = true; syncContext(); layout();
    action.run(); return true;
  }
  function toolActions() {
    return [
      { kind: 'browser', label: '浏览器', icon: 'browser', run: () => void createBrowser(), disabled: !browserBridge?.invoke },
      { kind: 'files', label: '文件', icon: 'folder', run: () => open('files') },
      { kind: 'terminal', label: '终端', icon: 'terminal', run: () => newTerminal() },
      { kind: 'review', label: '审查', icon: 'review', run: () => open('review') },
    ];
  }
  function renderLauncher() {
    const host = $('workspaceLauncherActions'); host.replaceChildren();
    for (const action of toolActions()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'workspace-launcher-action';
      button.dataset.workspaceCreate = action.kind; button.disabled = !!action.disabled;
      button.title = action.disabled ? '浏览器组件未加载，请重启 Relay' : '打开' + action.label;
      const label = document.createElement('span'); label.textContent = action.label;
      button.append(icon(action.icon), label); decorateToolShortcut(button, action);
      button.addEventListener('click', action.run); host.append(button);
    }
  }
  $('workspaceAdd').addEventListener('click', () => {
    const menu = $('workspaceAddMenu'); menu.replaceChildren();
    for (const action of toolActions()) {
      const button = menuItem(menu, action.label, action.icon, action.run, action.disabled);
      decorateToolShortcut(button, action);
    }
    showMenu('workspaceAddMenu', $('workspaceAdd'));
  });
  $('workspaceMaximize').addEventListener('click', () => setMaximized(!maximized));
  $('workspaceClose').addEventListener('click', close);
  toggle.addEventListener('click', () => opened ? close() : open());
  document.addEventListener('pointerdown', event => { if (menuButton && !event.target.closest('.workspace-menu') && !menuButton.contains(event.target)) closeMenus(false); }, true);
  panel.addEventListener('keydown', event => {
    if (!menuButton) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenus(); return; }
    if (event.key === 'Tab') { closeMenus(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const menu = panel.querySelector('.workspace-menu:not([hidden])'), buttons = Array.from(menu?.querySelectorAll('[role="menuitem"]:not(:disabled)') || []); if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); event.stopPropagation(); buttons[next].focus();
  });
  window.relayWorkspacePanel = {
    open, close, create: createTool, newTerminal, createTerminal: newTerminal, isActive: name => opened && tab === name,
    openFileLink,
    getState: () => ({ open: opened, tab, activeId, tabs: tabs.map(item => ({ id: item.id, kind: item.kind, title: item.title, path: item.preview?.path, browserId: item.browserId, sessionId: item.sessionId, root: item.terminalRoot })), width, preferredWidth, min: MIN_WIDTH, max: maxWidth(), maximized }),
    setObscured(reason, value) { if (value) obscured.add(reason); else obscured.delete(reason); syncNative(); },
  };
  function syncContext() {
    const next = readContext(), key = keyFor(next);
    if (key === contextKey) {
      context = next;
      reviewView?.setContext(next);
      $('workspaceRootTitle').textContent = directoryLink ? workspace?.name || '文件夹' : next?.title || '当前对话';
      return;
    }
    context = next; reviewView?.setContext(next); contextKey = key; revision++; filesRevision++; previewRevision++;
    const removedActivePreview = !!activeTab()?.preview;
    for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].preview) tabs.splice(i, 1);
    // A file preview does not implicitly own a file-tree tab. Switching
    // conversations restores an existing tool or the launcher, never a new tab.
    if (removedActivePreview) {
      activeId = (tabs.find(item => item.id === 'files') || tabs[0])?.id || null;
      tab = activeTab()?.kind || null;
    }
    renderTabs();
    workspace = null; directoryLink = null; selectedDirectory = null; preview = null; sourceMode = false; expanded = new Set(); entries = new Map(); loadingFiles = false; fileFingerprint = '';
    $('workspaceRootPath').removeAttribute('aria-current');
    $('workspaceFileFilter').value = '';
    $('workspaceRootTitle').textContent = next?.title || '当前对话';
    $('workspaceRootPath').textContent = '正在准备工作目录…'; notice(''); showTree();
    $('workspaceTerminalError').textContent = '';
    $('workspaceFileTree').replaceChildren();
    renderTerminals();
    if (removedActivePreview) {
      if (activeId) activate(activeId, { reveal: false });
      else { layout(); dispatchTab(); syncNative(); }
    } else if (opened && tab === 'files') void refreshFiles();
  }
  async function resolveRoot(fileStamp = filesRevision) {
    if (!bridge || !context?.conversationId) throw new Error('请先进入一个对话，再打开工作目录');
    const stamp = revision, ctx = context;
    const result = assertResult(await bridge.resolve(ctx));
    if (stamp !== revision || fileStamp !== filesRevision) return null;
    workspace = result;
    $('workspaceRootTitle').textContent = ctx.title || '当前对话';
    $('workspaceRootPath').textContent = result.root; $('workspaceRootPath').title = result.root;
    $('workspaceRootOpen').title = '在文件管理器中打开：' + result.root;
    return result;
  }
  function emptyState(host, title, description, iconName = 'folder') {
    const empty = document.createElement('div'); empty.className = 'workspace-empty'; empty.append(icon(iconName));
    const strong = document.createElement('strong'); strong.textContent = title;
    const text = document.createElement('p'); text.textContent = description;
    empty.append(strong, text); host.replaceChildren(empty); return empty;
  }
  function sizeLabel(size) { return size < 1024 ? size + ' B' : size < 1048576 ? (size / 1024).toFixed(1) + ' KB' : (size / 1048576).toFixed(1) + ' MB'; }
  function renderFiles() {
    const tree = $('workspaceFileTree');
    const filter = $('workspaceFileFilter').value.trim().toLowerCase();
    const nextFingerprint = JSON.stringify([Array.from(entries), Array.from(expanded), filter, selectedDirectory]);
    if (nextFingerprint === fileFingerprint) return;
    fileFingerprint = nextFingerprint;
    const scroll = tree.scrollTop, activePath = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    if (!(entries.get('') || []).length) { emptyState(tree, '对话文件会出现在这里', '生成的文档、代码和过程文件会集中保存。'); return; }
    const fragment = document.createDocumentFragment();
    function appendRows(parent = '', depth = 0) {
      for (const item of entries.get(parent) || []) {
        if (filter && !item.name.toLowerCase().includes(filter) && item.type !== 'directory') continue;
        const directory = item.type === 'directory';
        const row = document.createElement('button'); row.type = 'button'; row.className = 'workspace-file-row';
        if (directory && item.path === selectedDirectory) { row.classList.add('is-selected'); row.setAttribute('aria-current', 'true'); }
        row.dataset.path = item.path; row.style.setProperty('--file-depth', String(Math.min(depth, 8))); row.title = item.path;
        if (directory) { row.setAttribute('aria-expanded', String(expanded.has(item.path))); row.append(icon('chevron', 'workspace-folder-chevron')); }
        else { const spacer = document.createElement('span'); spacer.className = 'file-indent'; row.append(spacer); }
        const fileType = window.relayWorkspaceFileTypes?.describe(item.path, { directory, expanded: expanded.has(item.path) });
        row.dataset.fileKind = fileType?.kind || (directory ? 'folder' : 'file');
        row.setAttribute('aria-label', item.name + '，' + (fileType?.label || (directory ? '文件夹' : '文件')));
        row.append(window.relayWorkspaceFileTypes ? window.relayWorkspaceFileTypes.createIcon(item.path, { directory, expanded: expanded.has(item.path) }) : icon(directory ? 'folder' : 'file'));
        const name = document.createElement('span'); name.className = 'file-name'; name.textContent = item.name; row.append(name);
        if (!directory && Number.isFinite(item.size)) { const size = document.createElement('span'); size.className = 'file-size'; size.textContent = sizeLabel(item.size); row.append(size); }
        row.addEventListener('click', () => {
          if (directory) { previewRevision++; selectedDirectory = item.path; $('workspaceRootPath').removeAttribute('aria-current'); expanded.has(item.path) ? expanded.delete(item.path) : expanded.add(item.path); fileFingerprint = ''; renderFiles(); void refreshFiles(); }
          else void readFile(item.path);
        });
        fragment.append(row);
        if (directory && expanded.has(item.path) && depth < 32) appendRows(item.path, depth + 1);
      }
    }
    appendRows(); tree.replaceChildren(fragment); tree.scrollTop = scroll;
    if (activePath) Array.from(tree.querySelectorAll('[data-path]')).find(row => row.dataset.path === activePath)?.focus({ preventScroll: true });
  }
  async function refreshFiles() {
    if (loadingFiles || !opened || tab !== 'files') return;
    const stamp = ++filesRevision, ctx = context, link = directoryLink; loadingFiles = true;
    try {
      if (!workspace && !await resolveRoot(stamp)) return;
      if (stamp !== filesRevision) return;
      const paths = ['', ...expanded];
      const results = await Promise.allSettled(paths.map(path => bridge.list({ context: ctx, path, ...(link ? { directoryLink: link } : {}) })));
      if (stamp !== filesRevision) return;
      let error = '', truncated = false;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value?.ok !== false) { entries.set(paths[index], result.value.entries || []); truncated ||= !!result.value.truncated; }
        else { entries.delete(paths[index]); error = result.reason?.message || result.value?.error || '无法读取目录'; }
      });
      notice(error || (truncated ? '目录内容较多，仅展示前一部分文件。可在文件管理器中查看全部。' : '')); renderFiles();
    } catch (error) { if (stamp === filesRevision) notice(error.message); }
    finally { if (stamp === filesRevision) loadingFiles = false; }
  }
  function disposeHtmlPreview() {
    previewImages?.destroy(); previewImages = null;
    $('workspacePreviewBody').querySelector('.workspace-html-frame')?.remove(); $('workspacePreviewBody').removeAttribute('aria-busy');
  }
  function showTree() { disposeHtmlPreview(); $('workspacePreview').hidden = true; syncFileLayout(); }
  function sameDirectory(a, b) {
    const key = value => {
      const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
      return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    return key(a) === key(b);
  }
  function localPathHref(path) {
    // These are already-decoded host paths. Encode filename punctuation before
    // feeding them back to the Markdown link parser (including #, % and :line).
    return String(path).replace(/[^/\\]+/g, (part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part));
  }
  async function revealDirectory(result, source, current) {
    // Resolve against the host's conversation root. Browsing an authorized
    // scratch folder is temporary and never changes the project's working dir.
    const primary = assertResult(await bridge.resolve(source));
    if (!current()) return { ok: true, canceled: true };
    const relative = sameDirectory(primary.root, result.root) ? result.relativePath || '' : '';
    const parts = relative.split('/').filter(Boolean);
    let link = sameDirectory(primary.root, result.root) && parts.length <= 32 ? null : { href: localPathHref(result.absolutePath) };
    let root = link ? result.absolutePath : primary.root;
    let selected = link ? '' : relative;
    let openedPaths = sameDirectory(workspace?.root, root) ? new Set(expanded) : new Set();
    if (selected) for (let i = 1; i <= parts.length; i++) openedPaths.add(parts.slice(0, i).join('/'));
    async function load() {
      const paths = ['', ...openedPaths];
      const required = new Set(['', ...(selected ? parts.map((_, i) => parts.slice(0, i + 1).join('/')) : [])]);
      const results = await Promise.allSettled(paths.map(async path => assertResult(await bridge.list({ context: source, path, ...(link ? { directoryLink: link } : {}) }))));
      const listings = [];
      results.forEach((listing, i) => {
        if (listing.status === 'fulfilled') listings.push([paths[i], listing.value]);
        else if (required.has(paths[i])) throw listing.reason;
        else openedPaths.delete(paths[i]);
      });
      return listings;
    }
    let listings = await load();
    if (!current()) return { ok: true, canceled: true };
    // A capped parent listing can omit the requested folder. Browse that
    // already-authorized folder directly rather than silently missing it.
    if (selected && parts.some((_, i) => !listings.find(([path]) => path === parts.slice(0, i).join('/'))?.[1].entries?.some(item => item.path === parts.slice(0, i + 1).join('/')))) {
      link = { href: localPathHref(result.absolutePath) }; root = result.absolutePath; selected = ''; openedPaths = new Set();
      listings = await load();
      if (!current()) return { ok: true, canceled: true };
    }
    filesRevision++; loadingFiles = false;
    workspace = { ...primary, root, name: result.name }; directoryLink = link;
    selectedDirectory = selected; expanded = openedPaths;
    entries = new Map(listings.map(([path, listing]) => [path, listing.entries || []]));
    $('workspaceFileFilter').value = ''; fileFingerprint = '';
    $('workspaceRootTitle').textContent = link ? result.name || '文件夹' : source.title || '当前对话';
    $('workspaceRootPath').textContent = root; $('workspaceRootPath').title = root;
    $('workspaceRootPath').tabIndex = -1;
    if (!selected) $('workspaceRootPath').setAttribute('aria-current', 'true'); else $('workspaceRootPath').removeAttribute('aria-current');
    $('workspaceRootOpen').title = '在文件管理器中打开：' + root;
    notice(listings.some(([, listing]) => listing.truncated) ? '目录内容较多，仅展示前一部分文件。可在文件管理器中查看全部。' : '');
    // Only a resolved directory needs a tree tab. Commit the loaded tree before
    // revealing it, so neither failed links nor pending reads leave empty tabs.
    open('files', { refresh: false }); renderFiles();
    fileLayout.show();
    const row = selected ? Array.from($('workspaceFileTree').querySelectorAll('[data-path]')).find(item => item.dataset.path === selected) : $('workspaceRootPath');
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return { ok: true, kind: 'directory' };
  }
  async function openFileLink(input = {}) {
    syncContext();
    const source = input.context ? { ...input.context } : context ? { ...context } : null;
    if (!source?.conversationId || source.conversationId !== context?.conversationId) return { ok: false, error: '文件所属对话已变化，请回到原对话后打开。' };
    if (typeof bridge?.readLink !== 'function') return { ok: false, error: '当前版本无法预览本地文件链接。' };
    const stamp = ++previewRevision, epoch = revision, key = contextKey, intent = navigationRevision;
    const current = () => !disposed && stamp === previewRevision && epoch === revision && key === contextKey
      && intent === navigationRevision && (!app.dataset.view || app.dataset.view === 'chat');
    const request = { href: input.href, context: source, ...(input.basePath ? { basePath: input.basePath } : {}) };
    try {
      // Model-authored links stay inside Relay: files preview, directories
      // reveal in the tree, regardless of the external-editor preference.
      const result = assertResult(await bridge.readLink(request));
      if (!current()) return { ok: true, canceled: true };
      if (result.kind === 'directory') {
        return await revealDirectory(result, source, current);
      }
      const path = result.absolutePath || result.path;
      let item = tabs.find(value => value.preview && sameDirectory(value.preview.absolutePath || value.preview.path, path));
      if (!item) { item = { id: 'file-' + (++tabNumber), kind: 'files', title: path.replace(/\\/g, '/').split('/').pop(), sourceMode: !!result.line }; tabs.push(item); }
      else if (result.line) item.sourceMode = true;
      item.preview = { ...result, path, linkInput: { href: localPathHref(path), context: source }, sourceContext: source };
      activate(item.id);
      return { ok: true };
    } catch (error) {
      if (!current()) return { ok: true, canceled: true };
      notice(error.message); return { ok: false, error: error.message };
    }
  }
  async function readFile(path, { keepLayout = false } = {}) {
    if (directoryLink) return openFileLink({ context, href: localPathHref(workspace.root.replace(/[\\/]$/, '') + '/' + path) });
    const stamp = ++previewRevision, ctx = context, intent = navigationRevision, sourceRoot = workspace?.root;
    try {
      if (!keepLayout && typeof bridge.open === 'function') {
        const opened = assertResult(await bridge.open({ context: ctx, path, target: 'default' }));
        if (stamp !== previewRevision) return;
        // Older hosts do not return a target; preserve their built-in preview.
        if (opened.target && opened.target !== 'relay') return;
      }
      const result = assertResult(await bridge.read({ context: ctx, path }));
      if (stamp !== previewRevision) return;
      const absolutePath = sourceRoot ? sourceRoot.replace(/[\\/]$/, '') + '/' + path : result.absolutePath;
      let item = tabs.find(value => value.preview?.path === path || absolutePath && value.preview && sameDirectory(value.preview.absolutePath || value.preview.path, absolutePath));
      if (!item) { item = { id: 'file-' + (++tabNumber), kind: 'files', title: path.replace(/\\/g, '/').split('/').pop(), sourceMode: false }; tabs.push(item); }
      item.preview = { ...result, path, absolutePath, sourceContext: ctx,
        ...(absolutePath ? { linkInput: { href: localPathHref(absolutePath), context: ctx } } : {}) };
      if (opened && intent === navigationRevision && (!app.dataset.view || app.dataset.view === 'chat')) activate(item.id); else renderTabs();
    } catch (error) { if (stamp === previewRevision) notice(error.message); }
  }
  function renderPreview() {
    if (!preview) return;
    previewImages?.destroy(); previewImages = null;
    htmlSuspended = false;
    $('workspacePreview').hidden = false; syncFileLayout();
    const body = $('workspacePreviewBody'); body.classList.remove('relay-readonly-markdown', 'is-plain-text', 'is-source', 'is-html-preview'); body.removeAttribute('aria-busy'); body.tabIndex = 0; body.replaceChildren();
    $('workspacePreviewTitle').textContent = preview.path; $('workspacePreviewTitle').title = preview.path;
    const markdown = /\.(md|markdown|mdown)$/i.test(preview.path) && !preview.binary;
    const html = /\.html?$/i.test(preview.path) && !preview.binary && !preview.truncated;
    $('workspacePreviewMode').hidden = !(markdown || html);
    $('workspacePreviewMode').textContent = sourceMode ? '预览' : '源码';
    $('workspacePreviewMode').title = sourceMode ? '查看渲染结果' : '查看源代码';
    $('workspacePreviewCopy').title = '复制文件内容';
    $('workspacePreviewCopy').disabled = preview.binary || typeof preview.content !== 'string';
    $('workspacePreviewMode').setAttribute('aria-pressed', String(sourceMode));
    if (preview.dataUrl && /^data:image\/(png|jpeg|gif|webp);base64,/.test(preview.dataUrl)) {
      const img = document.createElement('img'); img.className = 'workspace-image'; img.src = preview.dataUrl; img.alt = preview.path; body.append(img);
    } else if (preview.binary) {
      emptyState(body, '此文件可在系统应用中查看', '使用右上角的打开按钮。', 'file');
    } else if (html && !sourceMode && window.RelayWorkspaceHtml) {
      const current = preview;
      void window.RelayWorkspaceHtml.mount(body, preview, {
        context: preview.sourceContext || context, readLink: bridge.readLink,
        onReady: message => { if (preview === current && !sourceMode) $('workspacePreviewMeta').textContent = message; },
      }).catch(() => { if (preview === current && !sourceMode) $('workspacePreviewMeta').textContent = '预览未能加载，可切换源码或在本地打开'; });
    } else if (markdown && !sourceMode && window.relayRenderReadOnlyMarkdown) {
      window.relayRenderReadOnlyMarkdown(body, preview.content || '', {
        context: preview.sourceContext || context, basePath: preview.absolutePath || preview.path, localImages: true, onError: notice,
      });
      previewImages = window.RelayLocalMarkdownImages?.install(body, {
        context: () => preview?.sourceContext || context,
        basePath: () => preview?.absolutePath || preview?.path,
        read: input => bridge.readLink(input),
      });
    } else {
      window.relayRenderWorkspaceSource(body, preview);
    }
    $('workspacePreviewMeta').textContent = preview.reason || (preview.truncated ? '只读预览 · 内容较大，仅显示前 512 KB' : html && !sourceMode ? '交互预览' : '只读预览');
    restorePreviewScroll();
    if (preview.line && !preview.lineApplied) {
      const current = preview; current.lineApplied = true;
      requestAnimationFrame(() => {
        if (preview !== current) return;
        const source = body.querySelector('pre.workspace-source');
        if (!source) return;
        const lineHeight = parseFloat(getComputedStyle(source.querySelector('code') || source).lineHeight) || 20;
        source.scrollTop = Math.max(0, (current.line - 1) * lineHeight - source.clientHeight / 3);
        $('workspacePreviewMeta').textContent = `只读预览 · 第 ${current.line} 行${current.truncated ? ' · 内容已截断' : ''}`;
      });
    }
  }
  async function openPath(path) {
    const stamp = revision;
    try { assertResult(preview?.path === path && preview.linkInput
      ? await bridge.openLink({ ...preview.linkInput, target: 'system' })
      : directoryLink ? await bridge.openLink({ context, href: localPathHref(workspace.root.replace(/[\\/]$/, '') + (path ? '/' + path : '')), target: 'system' })
      : await bridge.open({ context, path, target: 'system' })); } catch (error) { if (stamp === revision) notice(error.message); }
  }
  $('workspaceRefresh').addEventListener('click', () => { void refreshFiles(); if (preview?.linkInput) void openFileLink(preview.linkInput); else if (preview) void readFile(preview.path, { keepLayout: true }); });
  $('workspaceRootOpen').addEventListener('click', () => void openPath(''));
  $('workspacePreviewOpen').addEventListener('click', () => { if (preview) void openPath(preview.path); });
  $('workspacePreviewBack').addEventListener('click', () => { previewRevision++; open('files'); });
  $('workspacePreviewMode').addEventListener('click', () => { savePreviewScroll(); sourceMode = !sourceMode; if (activeTab()) activeTab().sourceMode = sourceMode; renderPreview(); });
  $('workspaceFileFilter').addEventListener('input', renderFiles);
  $('workspacePreviewCopy').addEventListener('click', async () => {
    if (!preview || preview.binary) return;
    const item = activeTab();
    try { await navigator.clipboard.writeText(preview.content || ''); if (activeTab() === item) { $('workspacePreviewCopy').title = '已复制'; $('workspacePreviewMeta').textContent = '已复制文件内容'; } }
    catch (_) { if (activeTab() === item) notice('复制失败，请重试'); }
  });

  const browserBridge = window.api?.browser;
  void syncNativeWorkspaceShortcuts();
  const closedPages = [];
  let browserPreferences = { showFullUrl: false };
  for (const [id, name, label, before] of [
    ['workspaceBrowserSiteInfo', 'lock', '网站信息', 'workspaceBrowserAddress'],
    ['workspaceBrowserBookmark', 'bookmark', '收藏此页', 'workspaceBrowserMore'],
  ]) {
    const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'workspace-icon-button';
    button.title = label; button.setAttribute('aria-label', label); button.append(icon(name));
    $('workspaceBrowserNav').insertBefore(button, $(before));
  }
  $('workspaceBrowserAddress').placeholder = '搜索或输入网址';
  let creatingBrowser = false, nativeFrame = null, nativeChain = Promise.resolve(), nativeEpoch = 0, nativeSignature = '', nativeActiveId = null;
  let findTimer = null, captureTimer = null, capturing = false, geometryUntil = 0;
  const closedBrowserIds = new Set();
  const browserNotice = value => { $('workspaceBrowserNotice').textContent = value || ''; };
  const pendingBrowserCreates = new Map(), pendingNativeBrowsers = new Map();
  let browserRequestNumber = 0;
  function browserRoutes(item) {
    if (!item.browserRoutes) {
      item.browserRoutes = item.browserId ? [{ browserId: item.browserId, state: item.browser }] : [];
      item.browserRouteIndex = item.browserRoutes.length - 1;
    }
    return item.browserRoutes;
  }
  function nativeBrowserIds(item) { return [...new Set([item.browserId, ...(item.browserRoutes || []).map(route => route.browserId)].filter(Boolean))]; }
  function browserTab(id) { return id ? tabs.find(item => item.kind === 'browser' && nativeBrowserIds(item).includes(id)) : null; }
  function releaseNativeBrowser(id) {
    if (!id || closedBrowserIds.has(id)) return;
    closedBrowserIds.add(id);
    void browserBridge.invoke({ action: 'close', id }).catch(() => {});
  }
  function discardBrowserForward(item) {
    const routes = browserRoutes(item), removed = routes.splice(item.browserRouteIndex + 1);
    for (const route of removed) if (route.browserId) releaseNativeBrowser(route.browserId);
  }
  function appendBrowserRoute(item, route) {
    discardBrowserForward(item); item.browserRoutes.push(route); item.browserRouteIndex = item.browserRoutes.length - 1;
  }
  function restoreBrowserRoute(item, index) {
    const route = browserRoutes(item)[index]; if (!route) return;
    item.browserNavigation = (item.browserNavigation || 0) + 1;
    item.browserRouteIndex = index; item.findOpen = false; item.snapshot = null;
    if (route.section) showInternalPage(item, route.section, { restoring: true });
    else {
      item.internalPage = null; item.browserId = route.browserId; item.browser = route.state;
      applyBrowserState(route.state); syncInternalPages(); syncNative();
    }
  }
  function applyBrowserState(state) {
    if (!state?.id || closedBrowserIds.has(state.id)) return null;
    const pending = pendingNativeBrowsers.get(state.id);
    if (pending) { pending.state = { ...pending.state, ...state }; return null; }
    let item = browserTab(state.id);
    if (!item) { item = { id: 'browser-' + (++tabNumber), kind: 'browser', browserId: state.id, title: '新标签页', browser: {} }; tabs.push(item); }
    const route = browserRoutes(item).find(value => value.browserId === state.id);
    // In-page navigation can create history without a will-navigate event.
    if (route && !item.internalPage && item.browserId === state.id && Number.isInteger(route.endIndex) && Number.isInteger(state.historyIndex) && state.historyIndex > route.endIndex) {
      route.endIndex = null; discardBrowserForward(item);
    }
    if (route) route.state = { ...route.state, ...state };
    if (item.internalPage || item.browserId !== state.id) return item;
    if ((state.url && item.browser.url && state.url !== item.browser.url) || (Number.isFinite(state.zoom) && state.zoom !== item.browser.zoom)) { item.snapshot = null; item.capturedAt = 0; }
    item.browser = { ...item.browser, ...state }; item.title = state.title || (state.url && state.url !== 'about:blank' ? state.url : '新标签页'); renderTabs();
    if (activeId === item.id) renderBrowser(); return item;
  }
  function nativeCanGo(item, action) {
    if (item.internalPage || !item.browser?.[action === 'back' ? 'canGoBack' : 'canGoForward']) return false;
    const route = browserRoutes(item)[item.browserRouteIndex];
    return action === 'back' || !Number.isInteger(route?.endIndex) || !Number.isInteger(item.browser.historyIndex) || item.browser.historyIndex < route.endIndex;
  }
  async function browserCall(payload) {
    if (!browserBridge?.invoke) throw new Error('浏览器组件未加载，请重启 Relay');
    const result = assertResult(await browserBridge.invoke(payload));
    if (result.tab && payload.action !== 'close') applyBrowserState(result.tab);
    return result;
  }
  async function createBrowser(url = 'about:blank') {
    const internal = window.RelayBrowserInternalPages?.parse(url);
    if (internal) { const item = createInternalPage(internal); return { ok: true, id: item.id }; }
    if (creatingBrowser) return;
    creatingBrowser = true; closeMenus(false); const intent = navigationRevision;
    try { await syncNativeWorkspaceShortcuts(); const result = await browserCall({ action: 'create', url }); const item = applyBrowserState(result.tab || { id: result.id, url }); if (item && opened && navigationRevision === intent && (!app.dataset.view || app.dataset.view === 'chat')) { activate(item.id); focusBrowserAddress(); } return result; }
    catch (error) { $('workspaceNotice').textContent = error.message; }
    finally { creatingBrowser = false; }
  }
  function showBrowserTab(state) {
    void syncNativeWorkspaceShortcuts();
    if (typeof window.showChatView === 'function') window.showChatView();
    opened = true; syncContext();
    const item = applyBrowserState(state); if (item) activate(item.id);
  }
  window.relayWorkspacePanel.showBrowserTab = showBrowserTab;
  window.relayWorkspacePanel.openUrl = url => {
    if (typeof window.showChatView === 'function') window.showChatView();
    opened = true; syncContext(); layout();
    return createBrowser(url);
  };
  const pendingCodePreviews = new Map();
  async function openCodePreview(html, duplicateId = null) {
    if (typeof html !== 'string' || !duplicateId && !html.trim()) throw new Error('没有可运行的 HTML 代码');
    if (typeof browserBridge?.invoke !== 'function') throw new Error('浏览器组件未加载，请重启 Relay');
    if (typeof window.showChatView === 'function') window.showChatView();
    opened = true; syncContext(); closeMenus(false); layout();
    const sourceKey = contextKey, pendingKey = sourceKey + '\0' + html;
    if (!duplicateId) {
      const existing = tabs.find(item => item.kind === 'browser' && item.browser?.isPreview && item.previewHtml === html);
      if (existing) { activate(existing.id); return { ok: true, id: existing.browserId }; }
      if (pendingCodePreviews.has(pendingKey)) return pendingCodePreviews.get(pendingKey);
    }
    const intent = navigationRevision;
    const clientRequestId = 'workspace-preview-' + (++browserRequestNumber);
    const pending = { state: null }; pendingBrowserCreates.set(clientRequestId, pending);
    const request = (async () => {
      try {
        const result = assertResult(await browserBridge.invoke(duplicateId
          ? { action: 'duplicatePreview', id: duplicateId, clientRequestId }
          : { action: 'createPreview', html, title: '运行预览', clientRequestId }));
        const state = { ...result.tab, ...pending.state };
        if (pending.state?.id) pendingNativeBrowsers.delete(pending.state.id);
        if (disposed || contextKey !== sourceKey || !opened || navigationRevision !== intent || app.dataset.view && app.dataset.view !== 'chat') {
          releaseNativeBrowser(state.id || result.id); return { ok: true, canceled: true };
        }
        const item = applyBrowserState(state);
        if (item) { item.previewHtml = html; activate(item.id); }
        return result;
      } catch (error) {
        if (pending.state?.id) releaseNativeBrowser(pending.state.id);
        throw error;
      } finally {
        pendingBrowserCreates.delete(clientRequestId);
        if (pending.state?.id) pendingNativeBrowsers.delete(pending.state.id);
        if (!duplicateId) pendingCodePreviews.delete(pendingKey);
      }
    })();
    if (!duplicateId) pendingCodePreviews.set(pendingKey, request);
    return request;
  }
  window.relayWorkspacePanel.openCodePreview = openCodePreview;
  async function refreshBrowserPreferences() {
    try { const result = await browserBridge?.invoke?.({ action: 'settings.get' }); if (result?.ok && result.settings) { browserPreferences = result.settings; if (tab === 'browser') renderBrowser(); } } catch (_) {}
  }
  function displayBrowserUrl(url) {
    if (!url || url === 'about:blank') return '';
    if (window.RelayBrowserInternalPages?.parse(url)) return url;
    if (browserPreferences.showFullUrl) return url;
    try { return new URL(url).host; } catch (_) { return url; }
  }
  function renderBrowser() {
    const item = activeTab(); if (item?.kind !== 'browser') return;
    const state = item.browser || {}, internal = !!item.internalPage, blank = !state.url || state.url === 'about:blank';
    syncInternalPages();
    const address = $('workspaceBrowserAddress');
    if (address.dataset.tabId !== item.id && document.activeElement === address) address.value = blank || state.isPreview ? '' : state.url;
    else if (document.activeElement !== address) address.value = state.isPreview ? '代码预览' : displayBrowserUrl(state.url);
    address.dataset.tabId = item.id;
    address.title = state.isPreview ? '代码预览 · ' + state.title : blank ? '搜索或输入网址' : state.url;
    $('workspaceBrowserBookmark').disabled = blank || internal || !!state.isPreview;
    $('workspaceBrowserBookmark').setAttribute('aria-pressed', String(!!state.bookmarked));
    $('workspaceBrowserBookmark').title = state.bookmarked ? '取消收藏' : '收藏此页';
    $('workspaceBrowserBookmark').setAttribute('aria-label', $('workspaceBrowserBookmark').title);
    $('workspaceBrowserSiteInfo').disabled = blank || internal || !!state.isPreview;
    $('workspaceBrowserSiteInfo').title = state.isPreview ? '本地代码预览' : state.url?.startsWith('https:') ? '网站信息 · HTTPS 连接' : '网站信息 · HTTP 连接';
    $('workspaceBrowserSiteInfo').replaceChildren(icon(state.isPreview ? 'code' : 'lock'));
    $('workspaceBrowserNav').classList.toggle('is-loading', !!state.loading);
    $('workspaceBrowserBack').disabled = !(nativeCanGo(item, 'back') || item.browserRouteIndex > 0);
    $('workspaceBrowserForward').disabled = !(nativeCanGo(item, 'forward') || item.browserRouteIndex < (item.browserRoutes?.length || 0) - 1);
    const reload = $('workspaceBrowserReload'); reload.title = state.loading ? '停止加载' : '刷新页面'; reload.setAttribute('aria-label', reload.title); reload.replaceChildren(icon(state.loading ? 'stop' : 'reload')); reload.disabled = blank;
    browserNotice(state.error || '');
    $('workspaceBrowserEmpty').hidden = !blank;
    $('workspaceBrowserFind').hidden = !item.findOpen;
    if ($('workspaceBrowserFindInput').dataset.tabId !== item.id) { $('workspaceBrowserFindInput').value = item.findText || ''; $('workspaceBrowserFindInput').dataset.tabId = item.id; $('workspaceBrowserFindCount').textContent = item.findCount || ''; }
    scheduleNative(); if (!state.loading && !blank) scheduleCapture();
  }
  function visibleElement(node) {
    if (!node || node.hidden || node.closest('[hidden],.hidden,[inert]')) return false;
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  const overlaySelector = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],.model-popup,.preview-overlay,.confirm-overlay,.search-overlay,.cs-popup,.copy-popover,.project-composer-menu,.modal-backdrop,.agent-picker-overlay,.cv-viewer,.context-usage-popover';
  const activeOverlaySelector = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],.model-popup.show,.preview-overlay.show,.confirm-overlay,.search-overlay.show,.cs-popup.show,.copy-popover.show,.project-composer-menu:not([hidden]),.modal-backdrop,.search-overlay,.agent-picker-overlay,.cv-viewer,.context-usage-popover.visible';
  let overlayCandidates = null;
  function hasOverlay() {
    // Candidate membership changes only with DOM insertion/removal or role.
    // Visibility is still checked live so a closing modal cannot expose a page early.
    if (!overlayCandidates) overlayCandidates = Array.from(document.querySelectorAll(overlaySelector));
    return overlayCandidates.some(node => node.isConnected && node.matches(activeOverlaySelector) && visibleElement(node));
  }
  function nativeDesired() {
    const item = activeTab(), state = item?.browser;
    // A launcher/file/terminal has no native page geometry to measure. Still
    // return a hidden target so a previously active browser can be detached.
    if (item?.kind !== 'browser' || item.internalPage || !item.browserId) return { id: null, visible: false,
      rect: { x: 0, y: 0, width: 0, height: 0 }, cover: false };
    const allowed = opened && tab === 'browser' && !!item?.browserId && !document.hidden && !obscured.size && (!app.dataset.view || app.dataset.view === 'chat') && !hasOverlay();
    const viewport = $('workspaceBrowserViewport').getBoundingClientRect();
    // Fill the page viewport even at full width. The resize grip remains
    // reachable beside the tab/address bars above the native WebContentsView;
    // pointer capture keeps that gesture active when the pane moves.
    const rect = { x: viewport.left, y: viewport.y, width: Math.max(0, viewport.right - viewport.left), height: viewport.height };
    const realPage = !!state?.url && state.url !== 'about:blank' && !state.error;
    return { id: item?.kind === 'browser' ? item.browserId : null, visible: allowed && realPage && rect.width > 10 && rect.height > 10, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.floor(rect.width)), height: Math.max(0, Math.floor(rect.height)) }, cover: realPage && !allowed };
  }
  function syncNative() {
    if (disposed || !browserBridge?.invoke) return;
    const desired = nativeDesired();
    const cover = $('workspaceBrowserCover'); if (cover.hidden === desired.cover) cover.hidden = !desired.cover;
    if (desired.cover) renderBrowserSnapshot(desired); else if (cover.childElementCount) cover.replaceChildren();
    const signature = JSON.stringify([desired.id, desired.visible, desired.rect]);
    if (signature === nativeSignature) return;
    nativeSignature = signature; const epoch = ++nativeEpoch;
    // IPC geometry and visibility are serialized. Re-evaluate after each await so
    // an old measurement can never re-show a page over a newly opened dialog.
    nativeChain = nativeChain.catch(() => {}).then(async () => {
      if (epoch !== nativeEpoch || disposed) return;
      if (nativeActiveId && (nativeActiveId !== desired.id || !desired.visible)) {
        await browserBridge.invoke({ action: 'visibility', id: nativeActiveId, visible: false }); nativeActiveId = null;
      }
      if (epoch !== nativeEpoch || !desired.id || !desired.visible || disposed) return;
      assertResult(await browserBridge.invoke({ action: 'setBounds', id: desired.id, rect: desired.rect }));
      if (epoch !== nativeEpoch || !nativeDesired().visible || disposed) return;
      if (nativeActiveId !== desired.id) { assertResult(await browserBridge.invoke({ action: 'visibility', id: desired.id, visible: true })); nativeActiveId = desired.id; scheduleCapture(); }
    }).catch(error => { nativeSignature = ''; browserNotice(error.message); });
  }
  function renderBrowserSnapshot(desired) {
    const cover = $('workspaceBrowserCover'), snapshot = activeTab()?.snapshot;
    const valid = snapshot && snapshot.url === activeTab()?.browser?.url && snapshot.zoom === activeTab()?.browser?.zoom && Math.abs(snapshot.width - desired.rect.width) < 2 && Math.abs(snapshot.height - desired.rect.height) < 2;
    if (!valid) { if (cover.childElementCount) cover.replaceChildren(); return; }
    if (cover.firstElementChild?.src === snapshot.dataUrl) return;
    const image = document.createElement('img'); image.src = snapshot.dataUrl; image.alt = ''; cover.replaceChildren(image);
  }
  function scheduleCapture(delay = 220) {
    if (captureTimer || capturing || disposed) return;
    const item = activeTab(); if (item?.kind !== 'browser' || item.browser?.loading || !nativeDesired().visible || Date.now() - (item.capturedAt || 0) < 900) return;
    captureTimer = setTimeout(async () => {
      captureTimer = null; const desired = nativeDesired();
      if (!desired.visible || activeTab() !== item || nativeActiveId !== item.browserId) return;
      capturing = true; const url = item.browser.url, zoom = item.browser.zoom;
      try {
        const result = await browserBridge.invoke({ action: 'capture', id: item.browserId });
        if (result?.ok && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(result.dataUrl || '') && item.browser.url === url && item.browser.zoom === zoom && activeTab() === item && nativeDesired().visible) {
          item.snapshot = { dataUrl: result.dataUrl, url, zoom, width: desired.rect.width, height: desired.rect.height }; item.capturedAt = Date.now();
        }
      } catch (_) { /* Snapshots are optional; they never delay hiding the view. */ }
      finally { capturing = false; }
    }, delay);
  }
  panel.querySelector('.workspace-panel-header').addEventListener('pointerenter', () => scheduleCapture(0));
  $('workspaceBrowserNav').addEventListener('pointerenter', () => scheduleCapture(0));
  function scheduleNative() {
    if (nativeFrame || disposed) return;
    if (!nativeActiveId && !activeTab()?.browserId) return;
    nativeFrame = requestAnimationFrame(() => {
      nativeFrame = null; syncNative();
      if (performance.now() < geometryUntil) scheduleNative();
    });
  }
  function trackGeometry() { geometryUntil = performance.now() + 400; scheduleNative(); }
  async function navigateFromInternal(item, url) {
    const revision = item.browserNavigation = (item.browserNavigation || 0) + 1;
    const clientRequestId = 'workspace-' + (++browserRequestNumber);
    const pending = { item, revision, state: null }; pendingBrowserCreates.set(clientRequestId, pending);
    try {
      // Preserve Chromium history in each web segment. A local management page
      // sits between those segments in this tab's own back/forward history.
      const response = assertResult(await browserBridge.invoke({ action: 'create', url, clientRequestId }));
      const state = { ...response.tab, ...pending.state };
      if (pending.state?.id) pendingNativeBrowsers.delete(pending.state.id);
      if (!tabs.includes(item) || item.browserNavigation !== revision) { releaseNativeBrowser(state.id); return; }
      appendBrowserRoute(item, { browserId: state.id, state });
      item.internalPage = null; item.browserId = state.id; item.browser = {}; item.snapshot = null;
      applyBrowserState(state); syncInternalPages(); syncNative();
    } catch (error) {
      if (pending.state?.id) releaseNativeBrowser(pending.state.id);
      if (tabs.includes(item) && item.browserNavigation === revision && activeTab() === item) browserNotice(error.message);
    } finally {
      pendingBrowserCreates.delete(clientRequestId);
      if (pending.state?.id) pendingNativeBrowsers.delete(pending.state.id);
    }
  }
  async function browserAction(action, extra = {}) {
    const item = activeTab(); if (item?.kind !== 'browser') return;
    try {
      if (action === 'navigate') {
        const section = window.RelayBrowserInternalPages?.parse(extra.url);
        if (section) { showInternalPage(item, section); return; }
        if (/^relay:/i.test(extra.url || '')) throw new Error('没有这个浏览器管理页面');
        if (item.internalPage) { await navigateFromInternal(item, extra.url); return; }
        discardBrowserForward(item);
      }
      if (action === 'back' || action === 'forward') {
        if (!nativeCanGo(item, action)) { restoreBrowserRoute(item, item.browserRouteIndex + (action === 'back' ? -1 : 1)); return; }
      }
      if (item.internalPage) { if (action === 'reload') await item.managerView.refresh(); return; }
      await browserCall({ action, id: item.browserId, ...extra });
    }
    catch (error) { if (item === activeTab()) browserNotice(error.message); }
  }
  function focusBrowserAddress() {
    const address = $('workspaceBrowserAddress'), state = activeTab()?.browser, url = state?.url;
    address.value = !state?.isPreview && url && url !== 'about:blank' ? url : ''; address.focus(); address.select();
  }
  $('workspaceBrowserNav').addEventListener('submit', event => { event.preventDefault(); const value = $('workspaceBrowserAddress').value.trim(); if (value) { $('workspaceBrowserAddress').blur(); void browserAction('navigate', { url: value }); } });
  $('workspaceBrowserAddress').addEventListener('focus', event => { const state = activeTab()?.browser, url = state?.url; event.target.value = !state?.isPreview && url && url !== 'about:blank' ? url : ''; event.target.select(); });
  $('workspaceBrowserAddress').addEventListener('blur', () => { renderBrowser(); });
  $('workspaceBrowserAddress').addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); event.target.blur(); renderBrowser(); } });
  $('workspaceBrowserBack').addEventListener('click', () => void browserAction('back'));
  $('workspaceBrowserForward').addEventListener('click', () => void browserAction('forward'));
  $('workspaceBrowserReload').addEventListener('click', () => void browserAction(activeTab()?.browser?.loading ? 'stop' : 'reload'));
  function openFind() { const item = activeTab(); if (item?.kind !== 'browser') return; if (item.internalPage) { item.managerMount.querySelector('[data-browser-search]')?.focus(); return; } item.findOpen = true; renderBrowser(); $('workspaceBrowserFindInput').focus(); $('workspaceBrowserFindInput').select(); trackGeometry(); }
  function closeFind() { clearTimeout(findTimer); findTimer = null; const item = activeTab(); if (item?.kind !== 'browser') return; item.findOpen = false; void browserAction('stopFind'); renderBrowser(); trackGeometry(); $('workspaceBrowserAddress').focus(); }
  async function findInPage(forward = true, findNext = false) {
    const item = activeTab(); if (item?.kind !== 'browser' || !item.findOpen) return;
    const text = $('workspaceBrowserFindInput').value; item.findText = text;
    if (!text) { item.findCount = ''; $('workspaceBrowserFindCount').textContent = ''; await browserAction('stopFind'); return; }
    try { const result = await browserCall({ action: 'find', id: item.browserId, text, forward, findNext }); item.findRequestId = result.requestId; }
    catch (error) { if (item === activeTab()) browserNotice(error.message); }
  }
  $('workspaceBrowserFindInput').addEventListener('input', () => { const item = activeTab(); if (item?.kind === 'browser') item.findText = $('workspaceBrowserFindInput').value; clearTimeout(findTimer); findTimer = setTimeout(() => void findInPage(), 130); });
  $('workspaceBrowserFindInput').addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); clearTimeout(findTimer); void findInPage(!event.shiftKey, true); } else if (event.key === 'Escape') { event.preventDefault(); closeFind(); } });
  $('workspaceBrowserFindPrevious').addEventListener('click', () => void findInPage(false, true));
  $('workspaceBrowserFindNext').addEventListener('click', () => void findInPage(true, true));
  $('workspaceBrowserFindClose').addEventListener('click', closeFind);
  function syncInternalPages() {
    for (const item of tabs) {
      if (!item.managerView) continue;
      const active = !!item.internalPage && item.id === activeId && opened && (!app.dataset.view || app.dataset.view === 'chat');
      item.managerMount.hidden = !active; item.managerView.setActive(active);
    }
  }
  function showInternalPage(item, section, { restoring = false } = {}) {
    if (!window.RelayBrowserInternalPages) { browserNotice('浏览器管理页面尚未就绪，请重启 Relay'); return; }
    const routes = browserRoutes(item);
    if (!restoring && !item.internalPage) {
      const route = routes[item.browserRouteIndex];
      if (route) route.endIndex = item.browser?.historyIndex;
    }
    item.browserNavigation = (item.browserNavigation || 0) + 1;
    item.internalPage = section; item.browserId = null; item.findOpen = false; item.snapshot = null;
    const changed = state => {
      if (!tabs.includes(item)) return;
      item.browserNavigation = (item.browserNavigation || 0) + 1;
      const current = browserRoutes(item)[item.browserRouteIndex];
      if (!item.restoringBrowserRoute && current?.section !== state.section) appendBrowserRoute(item, { section: state.section });
      item.internalPage = state.section; item.title = state.title; item.browser = { ...state, loading: false, zoom: 1 };
      renderTabs(); if (item.id === activeId) renderBrowser();
    };
    item.restoringBrowserRoute = restoring;
    try {
      if (!item.managerView) {
        item.managerMount = document.createElement('div'); item.managerMount.className = 'browser-internal-host'; item.managerMount.hidden = true;
        $('workspaceBrowserViewport').append(item.managerMount);
        item.managerView = window.RelayBrowserInternalPages.create({ mount: item.managerMount, api: browserBridge, section,
          openUrl: url => createBrowser(url), onChange: changed });
      } else item.managerView.navigate(section);
    } finally { item.restoringBrowserRoute = false; }
    if (item.id === activeId) { renderBrowser(); syncNative(); }
  }
  function createInternalPage(section) {
    const item = { id: 'browser-' + (++tabNumber), kind: 'browser', title: '', browser: {} };
    tabs.push(item); showInternalPage(item, section); activate(item.id); return item;
  }
  function openBrowserManager(section = 'general') {
    closeMenus(false);
    const existing = tabs.find(item => item.internalPage === section);
    if (existing) activate(existing.id); else createInternalPage(section);
  }
  async function reopenClosedBrowser() { const url = closedPages.pop(); if (url) { const result = await createBrowser(url); if (!result?.ok) closedPages.push(url); } }
  $('workspaceBrowserBookmark').addEventListener('click', () => void browserAction('bookmark', { toggle: true }));
  $('workspaceBrowserSiteInfo').addEventListener('click', () => {
    const menu = $('workspaceBrowserMenu'); menu.replaceChildren();
    const url = activeTab()?.browser?.url || '';
    const heading = document.createElement('div'); heading.className = 'workspace-site-info';
    const title = document.createElement('strong'); try { title.textContent = new URL(url).host; } catch (_) { title.textContent = '网站信息'; }
    const detail = document.createElement('span'); detail.textContent = url.startsWith('https:') ? '连接使用 HTTPS 加密' : '连接使用 HTTP，未加密';
    heading.append(title, detail); menu.append(heading);
    menuItem(menu, '管理网站权限', 'settings', () => openBrowserManager('permissions'));
    showMenu('workspaceBrowserMenu', $('workspaceBrowserSiteInfo'));
  });
  function menuDivider(menu) { const node = document.createElement('div'); node.className = 'workspace-menu-divider'; menu.append(node); }
  $('workspaceBrowserMore').addEventListener('click', () => {
    const menu = $('workspaceBrowserMenu'); menu.replaceChildren();
    const state = activeTab()?.browser || {}, internal = !!activeTab()?.internalPage, blank = internal || !state.url || state.url === 'about:blank';
    menuItem(menu, '新建标签页', 'plus', () => void createBrowser());
    menuItem(menu, '复制标签页', 'copy', () => {
      if (state.isPreview) void openCodePreview(activeTab()?.previewHtml || ' ', state.id).catch(error => browserNotice(error.message));
      else void createBrowser(state.url || 'about:blank');
    });
    menuItem(menu, '重新打开关闭的标签页', 'history', () => void reopenClosedBrowser(), !closedPages.length);
    menuDivider(menu);
    menuItem(menu, state.bookmarked ? '取消收藏此页' : '收藏此页', 'bookmark', () => void browserAction('bookmark', { toggle: true }), blank || !!state.isPreview);
    menuItem(menu, '书签', 'folder', () => openBrowserManager('bookmarks'));
    menuItem(menu, '历史记录', 'history', () => openBrowserManager('history'));
    menuItem(menu, '下载', 'download', () => openBrowserManager('downloads'));
    menuDivider(menu);
    menuItem(menu, '在页面中查找', 'search', openFind, blank);
    const zoom = Number(state.zoom) || 1;
    const zoomRow = document.createElement('div'); zoomRow.className = 'workspace-browser-zoom';
    const zoomLabel = document.createElement('span'); zoomLabel.textContent = '缩放'; zoomRow.append(zoomLabel);
    for (const [label, factor, disabled] of [['−', Math.max(.25, Math.round((zoom - .1) * 10) / 10), zoom <= .25], [Math.round(zoom * 100) + '%', 1, false], ['+', Math.min(3, Math.round((zoom + .1) * 10) / 10), zoom >= 3]]) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label; button.title = factor === 1 && label.endsWith('%') ? '恢复为 100%' : label === '−' ? '缩小' : '放大'; button.setAttribute('aria-label', button.title); button.disabled = disabled || internal;
      button.addEventListener('click', () => { closeMenus(false); void browserAction('zoom', { factor }); }); zoomRow.append(button);
    }
    menu.append(zoomRow);
    menuItem(menu, '打印…', 'print', () => void browserAction('print'), blank);
    menuItem(menu, '另存为 PDF…', 'file', () => void browserAction('savePdf'), blank);
    menuItem(menu, '保存网页截图…', 'camera', () => void browserAction('saveScreenshot'), blank);
    menuDivider(menu);
    menuItem(menu, state.muted ? '取消标签页静音' : '将标签页静音', 'sound', () => void browserAction('mute', { muted: !state.muted }), blank);
    menuItem(menu, '开发者工具', 'code', () => void browserAction('devTools'), internal);
    menuItem(menu, '复制网址', 'copy', () => { void navigator.clipboard.writeText(state.url).catch(() => browserNotice('复制失败，请重试')); }, blank || !!state.isPreview);
    menuItem(menu, '在默认浏览器中打开', 'external', () => void browserAction('openExternal'), blank || !!state.isPreview);
    menuDivider(menu);
    menuItem(menu, '浏览器设置', 'settings', () => openBrowserManager());
    showMenu('workspaceBrowserMenu', $('workspaceBrowserMore'));
  });
  function browserShortcut(action) {
    if (action === 'newTab') { void createBrowser(); return; }
    if (action === 'reopenTab') { void reopenClosedBrowser(); return; }
    const item = activeTab(); if (item?.kind !== 'browser') return;
    if (action === 'address') focusBrowserAddress();
    else if (action === 'newTab') void createBrowser();
    else if (action === 'closeTab') void closeTab(item.id);
    else if (action === 'reopenTab') void reopenClosedBrowser();
    else if (action === 'find') openFind();
    else if (['history', 'downloads', 'bookmarks'].includes(action)) openBrowserManager(action);
    else if (action === 'bookmark') void browserAction('bookmark', { toggle: true });
    else if (['nextTab', 'previousTab'].includes(action)) { const index = tabs.indexOf(item); activate(tabs[(index + (action === 'nextTab' ? 1 : -1) + tabs.length) % tabs.length].id); }
    else if (['zoomIn', 'zoomOut', 'zoomReset'].includes(action)) { const zoom = item.browser.zoom || 1; void browserAction('zoom', { factor: action === 'zoomReset' ? 1 : Math.max(.25, Math.min(3, Math.round((zoom + (action === 'zoomIn' ? .1 : -.1)) * 10) / 10)) }); }
    else if (['back', 'forward', 'reload', 'print', 'devTools'].includes(action)) void browserAction(action);
  }
  window.addEventListener('keydown', event => {
    if (!opened || (tab && tab !== 'browser') || !panel.contains(event.target) || event.isComposing || hasOverlay()) return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    const action = key === 'f12' ? 'devTools' : key === 'f5' ? 'reload' : event.altKey && !mod ? ({ arrowleft: 'back', arrowright: 'forward' })[key]
      : mod && !event.altKey ? event.shiftKey ? ({ t: 'reopenTab', tab: 'previousTab', '=': 'zoomIn', '+': 'zoomIn' })[key]
      : ({ l: 'address', t: 'newTab', w: 'closeTab', f: 'find', r: 'reload', p: 'print', d: 'bookmark', h: 'history', j: 'downloads', tab: 'nextTab', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', '0': 'zoomReset' })[key] : null;
    if (!action || (tab !== 'browser' && !['newTab', 'reopenTab'].includes(action))) return;
    event.preventDefault(); event.stopImmediatePropagation(); browserShortcut(action);
  }, true);
  const offBrowser = browserBridge?.onEvent?.(event => {
    if (disposed) return;
    if (event.type === 'shortcut') {
      const item = browserTab(event.id);
      if (opened && tab === 'browser' && item?.id === activeId) {
        if (event.action === 'workspace' && Object.values(workspaceShortcutIds).includes(event.workspaceAction)) {
          window.dispatchEvent(new CustomEvent('relay:workspace-shortcut', { detail: { action: event.workspaceAction } }));
        } else browserShortcut(event.action);
      }
      return;
    }
    if (event.type === 'navigation-start') {
      const item = browserTab(event.id);
      if (item && !item.internalPage && item.browserId === event.id) {
        const route = browserRoutes(item)[item.browserRouteIndex];
        if (route) route.endIndex = null;
        discardBrowserForward(item); renderTabs(); if (item === activeTab()) renderBrowser();
      }
      return;
    }
    if (event.type === 'open-link') { if (event.tab) showBrowserTab(event.tab); return; }
    if (event.type === 'profile') { if (event.section === 'settings') void refreshBrowserPreferences(); return; }
    if (event.type === 'closed') { const wasReleased = closedBrowserIds.has(event.id); closedBrowserIds.add(event.id); const item = browserTab(event.id); if (nativeActiveId === event.id) { nativeActiveId = null; nativeSignature = ''; } if (item && !wasReleased) void closeTab(item.id, { remoteClosed: true }); return; }
    if (event.type === 'find') { const item = browserTab(event.id); if (!item || (item.findRequestId && event.requestId && event.requestId < item.findRequestId)) return; item.findCount = event.matches ? String(event.activeMatchOrdinal || 0) + ' / ' + event.matches : '无匹配'; if (item === activeTab() && item.findOpen) $('workspaceBrowserFindCount').textContent = item.findCount; return; }
    if (event.type === 'download') { if (browserTab(event.id) === activeTab() && !activeTab()?.internalPage && activeTab()?.browserId === event.id) browserNotice(event.error || ({ completed: '文件已下载，可在下载管理中查看', cancelled: '下载已取消', interrupted: '下载中断，请在下载管理中重试', blocked: '已阻止网页自动下载' })[event.item?.state || event.status] || '正在下载…'); return; }
    if (event.type === 'created' && event.clientRequestId && pendingBrowserCreates.has(event.clientRequestId)) {
      const pending = pendingBrowserCreates.get(event.clientRequestId); pending.state = event.tab;
      pendingNativeBrowsers.set(event.tab.id, pending); return;
    }
    const item = applyBrowserState(event.tab); if (item && event.type === 'created' && event.requestedActive && opened && activeTab()?.browserId === event.openerId && (!app.dataset.view || app.dataset.view === 'chat')) activate(item.id);
  });
  const overlayObserver = new MutationObserver(records => {
    if (tab !== 'browser' || !opened) { overlayCandidates = null; return; }
    // Changes inside the browser's own native-placeholder decoration do not
    // affect overlays. Ignore them to avoid an observer/style feedback loop.
    // Streaming text, syntax highlighting and per-message status classes cannot
    // create an overlay. Avoid scanning/measuring the entire long transcript for
    // those mutations, but keep actual dialogs (including in-chat approvals).
    const relevant = record => {
      const target = record.target;
      if ($('workspaceBrowserViewport').contains(target)) return false;
      if (record.type === 'attributes') {
        if (record.attributeName === 'role') { overlayCandidates = null; return true; }
        if (target.matches?.(overlaySelector)) {
          if (overlayCandidates && !overlayCandidates.includes(target)) overlayCandidates.push(target);
          return true;
        }
        if (target.closest?.(overlaySelector)) return true;
        // Ancestor visibility/inert changes can obscure an existing overlay.
        return !target.closest?.('#messages') && (!overlayCandidates || overlayCandidates.some(node => target.contains(node)));
      }
      const changed = [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(overlaySelector) || node.querySelector(overlaySelector)));
      if (changed) overlayCandidates = null;
      return changed;
    };
    // Inspect every membership change even while another tool tab is active.
    const changed = records.map(relevant).some(Boolean);
    if (changed && tab === 'browser' && opened) scheduleNative();
  });
  overlayObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'inert', 'role'] });
  window.addEventListener('relay:view-changed', () => { navigationRevision++; endDrag(false); clearSnapAnimation(); closeMenus(false); if (app.dataset.view !== 'chat' && maximized) setMaximized(false, { preservePreference: true }); layout(); syncNative(); });
  document.addEventListener('visibilitychange', syncNative);
  document.addEventListener('transitionrun', event => {
    if (event.target === app || event.target === panel || panel.contains(event.target)) trackGeometry();
  }, true);
  window.addEventListener('resize', () => { closeMenus(false); trackGeometry(); });
  document.addEventListener('scroll', scheduleNative, true);
  // Shells belong to resolved directories. Conversation IDs are used only by
  // the workspace resolver, never to save history or to own a terminal process.
  function terminalDirectoryKey(root) {
    const value = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
  }
  function currentTerminal() { return sessions.get(activeTab()?.sessionId); }
  function newTerminal() {
    if (disposed) return null;
    syncContext();
    const number = ++termNumber;
    const item = { id: 'terminal-' + number, kind: 'terminal', title: '终端 ' + number, terminalNumber: number, terminalContext: context ? { ...context } : null, terminalContextKey: contextKey, sessionId: null, terminalError: '' };
    tabs.push(item); activate(item.id); void startTerminalSession(item); return item.id;
  }
  async function openTerminal() {
    const ctx = context ? { ...context } : null, key = contextKey, navigation = navigationRevision;
    const unchanged = () => !disposed && opened && contextKey === key && navigationRevision === navigation;
    // Opening a workspace restores an existing tab. Explicit + / shortcuts
    // always use newTerminal(), even while another shell is starting.
    let directory = ctx?.workingDir && terminalDirectoryKey(ctx.workingDir);
    if (!directory && bridge && ctx?.conversationId) {
      try { directory = terminalDirectoryKey(assertResult(await bridge.resolve(ctx)).root); }
      catch (_) { /* The new tab owns and displays any launch failure. */ }
    }
    if (!unchanged()) return;
    const matching = tabs.filter(item => item.kind === 'terminal' && (item.terminalRoot ? terminalDirectoryKey(item.terminalRoot) === directory : item.terminalContextKey === key));
    const existing = matching.find(item => item.id === activeId) || matching.at(-1);
    if (existing) activate(existing.id); else newTerminal();
  }
  function terminalTheme() {
    const style = getComputedStyle(panel);
    return {
      background: style.getPropertyValue('--bg-panel').trim() || '#fafafa',
      foreground: style.getPropertyValue('--text').trim() || '#242424',
      cursor: style.getPropertyValue('--text').trim() || '#242424',
      selectionBackground: '#80808055',
      scrollbarSliderBackground: style.getPropertyValue('--border-strong').trim() || '#d4d4d6',
      scrollbarSliderHoverBackground: style.getPropertyValue('--text-muted').trim() || '#8a8a8a',
      scrollbarSliderActiveBackground: style.getPropertyValue('--text-dim').trim() || '#525252',
      overviewRulerBorder: '#00000000'
    };
  }
  function handleTerminalEvent(event) {
    const item = sessions.get(event.id);
    if (!item) {
      if (!pendingTerminals.size) return;
      const backlog = earlyEvents.get(event.id) || [];
      if (backlog.length < 100 && earlyEvents.size < 16) { backlog.push(event); earlyEvents.set(event.id, backlog); }
      return;
    }
    if (event.type === 'data') item.terminal.write(String(event.data || ''));
    if (event.type === 'exit' && !item.exited) { item.exited = true; item.exitCode = event.exitCode; item.terminal.write('\r\n\x1b[2m进程已退出 (' + String(event.exitCode ?? '') + ')\x1b[0m\r\n'); updateTerminalTitle(item.tab); renderTerminals(); }
  }
  const offTerminal = bridge?.onTerminalEvent?.(handleTerminalEvent);
  function renderTerminals() {
    if (disposed) return;
    const active = activeTab(), current = currentTerminal();
    for (const item of sessions.values()) item.host.hidden = item !== current;
    const pending = !!active?.terminalLaunch;
    $('workspaceTerminalEmpty').hidden = !!current;
    $('workspaceTerminalError').textContent = active?.terminalError || '';
    $('workspaceTerminalStart').disabled = pending || !!active?.terminalClosing;
    $('workspaceTerminalStart').textContent = pending ? '正在启动…' : active?.terminalError ? '重试' : '打开终端';
    $('workspaceTerminalStatus').textContent = current ? (current.exited ? '已结束 · ' : '') + current.root : pending ? '正在启动终端…' : active?.terminalRoot || '在当前项目或工作区中手工调试';
    $('workspaceTerminalStatus').title = current?.root || active?.terminalRoot || '';
    if (active?.kind === 'terminal') $('workspaceTerminal').setAttribute('aria-labelledby', 'workspaceTab-' + active.id);
    fitTerminal();
  }
  function updateTerminalTitle(item) {
    const session = sessions.get(item.sessionId);
    const directory = String(item.terminalRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
    item.title = (directory || '终端 ' + item.terminalNumber) + (session?.exited ? ' · 已结束' : '');
    renderTabs();
  }
  let terminalComponentsPromise = null;
  function loadTerminalComponent(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      const finish = loaded => {
        script.onload = script.onerror = null;
        script.remove();
        if (loaded && ready()) resolve();
        else reject(new Error('终端组件加载失败，请重试'));
      };
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    });
  }
  function ensureTerminalComponents() {
    // Terminal parsing and initialization stay off the chat startup path.
    // All tabs share one request; a failed addon can retry without reloading
    // the successfully initialized terminal dependency.
    if (!terminalComponentsPromise) {
      terminalComponentsPromise = (async () => {
        await loadTerminalComponent('vendor/xterm.js', () => typeof window.Terminal === 'function');
        await loadTerminalComponent('vendor/xterm-addon-fit.js', () => typeof window.FitAddon?.FitAddon === 'function');
      })().catch(error => { terminalComponentsPromise = null; throw error; });
    }
    return terminalComponentsPromise;
  }
  async function startTerminalSession(target = activeTab()) {
    if (disposed || !target || target.kind !== 'terminal' || !tabs.includes(target) || target.terminalLaunch || target.sessionId || target.terminalClosing) return;
    const launch = {}; target.terminalLaunch = launch; target.terminalError = ''; pendingTerminals.add(launch); renderTerminals();
    const valid = () => !disposed && tabs.includes(target) && target.terminalLaunch === launch && !target.terminalClosing;
    let remote = null, terminal = null, host = null;
    try {
      if (!bridge || !target.terminalContext?.conversationId) throw new Error('无法确定终端工作目录，请重新打开终端');
      await ensureTerminalComponents();
      if (!valid()) return;
      remote = assertResult(await bridge.terminalStart({ context: target.terminalContext, cols: 80, rows: 24 }));
      if (!valid()) { await bridge.terminalClose({ id: remote.id }); return; }
      const workspaceKey = terminalDirectoryKey(remote.root);
      terminal = new window.Terminal({ fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 12, lineHeight: 1.18, cursorBlink: true, scrollback: 3000, overviewRuler: { width: 9, showTopBorder: false, showBottomBorder: false }, theme: terminalTheme(), allowProposedApi: false });
      const fit = new window.FitAddon.FitAddon(); terminal.loadAddon(fit);
      host = document.createElement('div'); host.className = 'workspace-terminal-surface'; host.dataset.terminalId = remote.id;
      host.hidden = target !== activeTab(); $('workspaceTerminalSurfaces').append(host); terminal.open(host);
      const item = { id: remote.id, workspaceKey, root: remote.root, tab: target, terminal, fit, host, exited: false, lastSize: '' };
      sessions.set(item.id, item); target.sessionId = item.id; target.terminalRoot = remote.root; updateTerminalTitle(target);
      terminal.onData(data => { if (!item.exited) void bridge.terminalInput({ id: item.id, data }).then(assertResult).catch(error => { if (currentTerminal() === item) $('workspaceTerminalStatus').textContent = error.message; }); });
      for (const event of earlyEvents.get(item.id) || []) handleTerminalEvent(event);
      earlyEvents.delete(item.id); renderTerminals(); if (target === activeTab() && opened && (!app.dataset.view || app.dataset.view === 'chat')) terminal.focus();
    } catch (error) {
      terminal?.dispose(); host?.remove(); if (remote?.id) { sessions.delete(remote.id); void bridge.terminalClose({ id: remote.id }).catch(() => {}); }
      if (valid()) { target.sessionId = null; target.terminalError = error.message; }
    } finally { pendingTerminals.delete(launch); if (target.terminalLaunch === launch) target.terminalLaunch = null; if (!pendingTerminals.size) earlyEvents.clear(); renderTerminals(); }
  }
  async function closeTerminal(target) {
    if (target.terminalClosing) return false;
    target.terminalClosing = true;
    const item = sessions.get(target.sessionId);
    if (!item) { target.terminalLaunch = null; return true; }
    try {
      assertResult(await bridge.terminalClose({ id: item.id }));
      sessions.delete(item.id); item.terminal.dispose(); item.host.remove(); target.sessionId = null; return true;
    } catch (error) { target.terminalClosing = false; target.terminalError = error.message; renderTerminals(); return false; }
  }
  let fitFrame = null;
  function fitTerminal() {
    if (disposed || fitFrame || !opened || tab !== 'terminal') return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null; const item = currentTerminal();
      if (!item || item.host.hidden || item.host.clientWidth < 40 || item.host.clientHeight < 40) return;
      try {
        item.fit.fit(); const size = item.terminal.cols + ':' + item.terminal.rows;
        if (!item.exited && !item.resizePending && item.lastSize !== size) {
          if (item.requestedSize !== size) item.resizeFailures = 0;
          item.requestedSize = size; item.resizePending = true;
          void bridge.terminalResize({ id: item.id, cols: item.terminal.cols, rows: item.terminal.rows }).then(assertResult).then(() => {
            item.lastSize = size; item.resizeFailures = 0;
          }).catch(error => {
            item.resizeFailures = (item.resizeFailures || 0) + 1;
            if (currentTerminal() === item) $('workspaceTerminalStatus').textContent = error.message;
          }).finally(() => {
            item.resizePending = false;
            // A rejected resize must not be cached as applied. Also catch up if
            // the user dragged again while the prior IPC was in flight.
            if (!item.exited && (item.resizeFailures || 0) < 3) setTimeout(fitTerminal, item.resizeFailures ? 250 : 0);
          });
        }
      } catch (_) {}
    });
  }
  $('workspaceTerminalStart').addEventListener('click', () => void startTerminalSession());
  window.addEventListener('relay:conversation-changed', syncContext);
  const offRuntimeWorkspace = bridge?.onRuntimeChanged?.(event => {
    if (disposed || event.conversationId !== context?.conversationId) return;
    revision++; filesRevision++; previewRevision++; workspace = null; directoryLink = null; selectedDirectory = null;
    expanded = new Set(); entries = new Map(); loadingFiles = false; fileFingerprint = '';
    $('workspaceRootPath').removeAttribute('aria-current'); $('workspaceFileTree').replaceChildren();
    if (opened && tab === 'files') void refreshFiles();
    if (opened && tab === 'review') void reviewView?.refresh();
  });
  window.addEventListener('pagehide', () => offRuntimeWorkspace?.());
  window.addEventListener('relay:workdir-changed', syncContext);
  window.addEventListener('relay:sidebar-changed', event => layout(event.detail));
  window.addEventListener('resize', () => { endDrag(false); clearSnapAnimation(); layout(); });
  const resizeObserver = new ResizeObserver(() => { panel.classList.toggle('is-narrow', panel.clientWidth < 620); fitTerminal(); scheduleNative(); }); resizeObserver.observe(panel); resizeObserver.observe($('workspaceBrowserViewport'));
  const themeObserver = new MutationObserver(() => { for (const item of sessions.values()) item.terminal.options.theme = terminalTheme(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const refreshTimer = setInterval(() => { if (opened && tab === 'files' && !document.hidden) void refreshFiles(); }, 3000);
  window.addEventListener('pagehide', () => { disposed = true; stopShortcutHints?.(); reviewView?.destroy(); reviewView = null; clearInterval(refreshTimer); resizeObserver.disconnect(); themeObserver.disconnect(); overlayObserver.disconnect(); offTerminal?.(); offBrowser?.(); clearTimeout(findTimer); clearTimeout(captureTimer); if (nativeFrame) cancelAnimationFrame(nativeFrame); for (const item of tabs) { item.managerView?.destroy(); for (const id of nativeBrowserIds(item)) releaseNativeBrowser(id); } for (const item of sessions.values()) { item.terminal.dispose(); void bridge.terminalClose({ id: item.id }).catch(() => {}); } });
  app.classList.add('has-workspace-panel'); renderLauncher(); renderTabs(); layout(); void refreshBrowserPreferences();
}());
