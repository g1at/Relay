(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RelaySidebarLayout = api;
    const app = root.document.querySelector('.app');
    const sidebar = root.document.getElementById('sidebarNavigation');
    const handle = root.document.getElementById('sidebarResizeHandle');
    if (app && sidebar && handle) root.relaySidebarLayout = api.create({ app, sidebar, handle, window: root });
  }
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const DEFAULT_WIDTH = 224;
  const MIN_WIDTH = 176;
  const COLLAPSE_THRESHOLD = 144;
  const REOPEN_THRESHOLD = 176;
  const MIN_MAIN_WIDTH = 480;
  const BREAKPOINT = 760;
  const STORAGE_KEY = 'relay.sidebar.width.v1';
  const STATE_KEY = 'relay.sidebar.layout.v2';
  const instances = new WeakMap();

  function boundsForWidth(viewportWidth) {
    const available = Math.max(0, Number(viewportWidth) || 0);
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.floor(available - MIN_MAIN_WIDTH)) };
  }
  function normalizePreference(value) {
    const width = Number(value);
    return Number.isFinite(width) && width >= MIN_WIDTH && Number.isSafeInteger(Math.round(width)) ? Math.round(width) : DEFAULT_WIDTH;
  }
  function readPreference(store, defaultCollapsed) {
    let legacyWidth = DEFAULT_WIDTH;
    try { legacyWidth = normalizePreference(store && store.getItem(STORAGE_KEY)); } catch (_) {}
    try {
      const saved = JSON.parse(store && store.getItem(STATE_KEY));
      if (saved && saved.version === 2 && typeof saved.collapsed === 'boolean' && typeof saved.width === 'number'
        && saved.width >= MIN_WIDTH && normalizePreference(saved.width) === saved.width) {
        return { width: saved.width, collapsed: saved.collapsed };
      }
    } catch (_) {}
    return { width: legacyWidth, collapsed: defaultCollapsed };
  }
  function create({ app, sidebar, handle, window: win, storage = null }) {
    if (instances.has(app)) return instances.get(app);
    let store = storage;
    if (!store) { try { store = win.localStorage; } catch (_) {} }
    const saved = readPreference(store, app.classList.contains('sidebar-collapsed'));
    let preferredWidth = saved.width;
    let width = preferredWidth;
    let drag = null;
    let pendingFrame = null;
    let pendingWidth = null;
    app.classList.toggle('sidebar-collapsed', saved.collapsed);
    const listeners = [];
    const on = (target, name, handler, options) => {
      target.addEventListener(name, handler, options);
      listeners.push(() => target.removeEventListener(name, handler, options));
    };
    const isNarrow = () => win.matchMedia(`(max-width: ${BREAKPOINT}px)`).matches;
    const viewportWidth = knownWidth => Number.isFinite(knownWidth) ? knownWidth : app.clientWidth || win.innerWidth;
    const workspaceWidth = () => Math.max(0, parseFloat(app.style.getPropertyValue('--workspace-visible-width')) || 0);
    // This is a temporary layout budget, not a new user preference. Unlike the
    // manual resize bounds it may reach zero as the right pane fills the app.
    const layoutBudget = knownWidth => workspaceWidth() ? Math.max(0, viewportWidth(knownWidth) - workspaceWidth() - 360) : Infinity;
    const isConstrained = knownWidth => layoutBudget(knownWidth) <= MIN_WIDTH;
    const bounds = knownWidth => {
      const right = workspaceWidth();
      return boundsForWidth(viewportWidth(knownWidth) - right + (right ? MIN_MAIN_WIDTH - 360 : 0));
    };
    const isExpanded = () => isNarrow() ? app.classList.contains('sidebar-mobile-open') : !app.classList.contains('sidebar-collapsed');
    const isResizable = () => !isNarrow() && isExpanded() && !isConstrained();
    const clamp = value => Math.max(bounds().min, Math.min(bounds().max, Math.round(value)));
    function persist() {
      // Keep the old width readable by earlier builds; v2 additionally owns the
      // desktop collapsed state. Temporary narrow-screen navigation is not saved.
      try { if (store) store.setItem(STORAGE_KEY, String(preferredWidth)); } catch (_) {}
      try { if (store) store.setItem(STATE_KEY, JSON.stringify({ version: 2, width: preferredWidth, collapsed: app.classList.contains('sidebar-collapsed') })); } catch (_) {}
    }
    function notify(state) {
      win.dispatchEvent(new win.CustomEvent('relay:sidebar-changed', { detail: { width, preferredWidth, ...state } }));
    }
    function apply({ notifyChange = true, viewportWidth: knownWidth } = {}) {
      const measuredWidth = viewportWidth(knownWidth), limits = bounds(measuredWidth), budget = layoutBudget(measuredWidth);
      const narrow = isNarrow();
      const expanded = isExpanded();
      const constrained = budget <= MIN_WIDTH, visible = expanded && !constrained;
      const expandedWidth = narrow ? Math.min(preferredWidth, Math.max(MIN_WIDTH, measuredWidth - 48)) : Math.max(limits.min, Math.min(limits.max, Math.round(preferredWidth)));
      width = expanded ? Math.min(budget, drag ? Math.max(0, Math.min(limits.max, Math.round(drag.rawWidth))) : expandedWidth) : 0;
      app.style.setProperty('--sidebar-width', (expanded ? width : expandedWidth) + 'px');
      app.style.setProperty('--sidebar-visible-width', width + 'px');
      app.classList.toggle('sidebar-constrained', constrained);
      app.style.setProperty('--sidebar-content-opacity', workspaceWidth() && expanded ? String(Math.max(0, Math.min(1, (budget - MIN_WIDTH) / 40))) : '1');
      // Do not hide a captured handle when the same gesture crosses the collapse
      // threshold. It must still receive pointerup or Escape to commit or cancel.
      const disabled = narrow || !expanded || constrained;
      handle.hidden = disabled && !drag;
      handle.tabIndex = disabled ? -1 : 0;
      handle.setAttribute('aria-disabled', String(disabled));
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', String(limits.max));
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuetext', expanded ? `${width} 像素` : '已收起');
      sidebar.inert = !visible;
      sidebar.setAttribute('aria-hidden', String(!visible));
      win.document.querySelectorAll('[data-toggle-sidebar]').forEach(button => {
        button.disabled = constrained;
        button.setAttribute('aria-disabled', String(constrained));
        button.setAttribute('aria-expanded', String(visible));
        button.setAttribute('aria-controls', sidebar.id);
        button.setAttribute('aria-label', expanded ? '收起侧边栏' : '展开侧边栏');
        button.title = constrained ? '缩小右侧栏后可展开侧边栏' : expanded ? '收起侧边栏' : '展开侧边栏';
      });
      if (notifyChange) notify({ expanded, narrow, constrained, viewportWidth: measuredWidth });
    }
    function setWidth(value, { save = false } = {}) {
      preferredWidth = clamp(value);
      apply();
      if (save) persist();
    }
    function cancelFrame() {
      if (pendingFrame != null) win.cancelAnimationFrame(pendingFrame);
      pendingFrame = null; pendingWidth = null;
    }
    function previewDrag(value) {
      if (!drag) return;
      drag.rawWidth = Math.min(bounds().max, value);
      // Spatial hysteresis lets a gesture collapse immediately without flickering
      // open and shut when the pointer trembles around the threshold.
      if (!drag.collapsed && drag.rawWidth < COLLAPSE_THRESHOLD) drag.collapsed = true;
      else if (drag.collapsed && drag.rawWidth >= REOPEN_THRESHOLD) drag.collapsed = false;
      app.classList.toggle('sidebar-collapsed', drag.collapsed);
      app.classList.toggle('is-sidebar-snapping', drag.collapsed);
      apply();
    }
    function endDrag(commit, applyOptions) {
      if (!drag) return;
      if (commit && pendingWidth != null) previewDrag(pendingWidth);
      const previous = drag;
      cancelFrame();
      drag = null;
      if (commit) {
        preferredWidth = previous.collapsed ? previous.preferredWidth : clamp(previous.rawWidth);
      } else {
        preferredWidth = previous.preferredWidth;
        app.classList.toggle('sidebar-collapsed', previous.originalCollapsed);
      }
      app.classList.remove('is-sidebar-resizing', 'is-sidebar-snapping');
      try { if (handle.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId); } catch (_) {}
      apply(applyOptions);
      if (commit) persist();
    }
    function sync(options = {}) {
      const measuredWidth = viewportWidth(options.viewportWidth);
      const applyOptions = { notifyChange: options.notifyChange !== false, viewportWidth: measuredWidth };
      if (drag && (isNarrow() || isConstrained(measuredWidth))) { endDrag(false, applyOptions); return; }
      apply(applyOptions);
    }
    function reset() {
      if (drag) endDrag(false);
      preferredWidth = DEFAULT_WIDTH;
      apply(); persist();
    }
    on(handle, 'pointerdown', event => {
      if (!isResizable() || drag || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
      event.preventDefault();
      const startWidth = sidebar.getBoundingClientRect().width || width;
      drag = { pointerId: event.pointerId, startX: event.clientX, startWidth, rawWidth: startWidth,
        preferredWidth, collapsed: false, originalCollapsed: app.classList.contains('sidebar-collapsed') };
      app.classList.add('is-sidebar-resizing');
      apply();
      handle.focus({ preventScroll: true });
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    });
    on(win, 'pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      pendingWidth = drag.startWidth + event.clientX - drag.startX;
      if (pendingFrame == null) pendingFrame = win.requestAnimationFrame(() => {
        pendingFrame = null;
        if (drag && pendingWidth != null) { const next = pendingWidth; pendingWidth = null; previewDrag(next); }
      });
    }, { passive: false });
    on(win, 'pointerup', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      pendingWidth = drag.startWidth + event.clientX - drag.startX;
      endDrag(true);
    });
    on(win, 'pointercancel', event => { if (drag && drag.pointerId === event.pointerId) endDrag(false); });
    on(handle, 'lostpointercapture', event => { if (drag && drag.pointerId === event.pointerId) endDrag(false); });
    on(win, 'blur', () => endDrag(false));
    on(win, 'keydown', event => {
      if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endDrag(false); }
    }, true);
    on(handle, 'dblclick', event => { if (isResizable()) { event.preventDefault(); reset(); } });
    on(handle, 'keydown', event => {
      if (!isResizable() || drag) return;
      const step = event.shiftKey ? 32 : 8;
      const next = event.key === 'ArrowLeft' ? width - step
        : event.key === 'ArrowRight' ? width + step
          : event.key === 'Home' ? bounds().min
            : event.key === 'End' ? bounds().max : null;
      if (next != null) { event.preventDefault(); setWidth(next, { save: true }); }
      else if (event.key === 'Enter') { event.preventDefault(); reset(); }
    });
    // The workspace already owns this layout pass. Do not echo a sidebar
    // notification back into it; reuse its pre-write viewport measurement.
    on(win, 'relay:workspace-layout', event => sync({ notifyChange: false, viewportWidth: event.detail?.viewportWidth }));
    on(win, 'resize', () => {
      if (drag) endDrag(false);
      if (!isNarrow()) app.classList.remove('sidebar-mobile-open');
      sync();
    });
    const controller = {
      toggle() {
        if (isConstrained()) return;
        if (drag) endDrag(false);
        app.classList.toggle(isNarrow() ? 'sidebar-mobile-open' : 'sidebar-collapsed');
        sync();
        if (!isNarrow()) persist();
      },
      sync, reset,
      getState({ viewportWidth: knownWidth } = {}) { const measuredWidth = viewportWidth(knownWidth), limits = bounds(measuredWidth); return { width, preferredWidth, min: limits.min, max: limits.max, narrow: isNarrow(), expanded: isExpanded(), dragging: !!drag,
        collapsed: !isExpanded(), constrained: isConstrained(measuredWidth), collapseThreshold: COLLAPSE_THRESHOLD, reopenThreshold: REOPEN_THRESHOLD }; },
      destroy() { endDrag(false); cancelFrame(); listeners.splice(0).forEach(off => off()); instances.delete(app); },
    };
    instances.set(app, controller);
    app.classList.add('is-sidebar-initializing');
    apply({ notifyChange: false });
    sidebar.getBoundingClientRect();
    app.classList.remove('is-sidebar-initializing');
    return controller;
  }
  return { create, boundsForWidth, normalizePreference, DEFAULT_WIDTH, MIN_WIDTH, MIN_MAIN_WIDTH, COLLAPSE_THRESHOLD, REOPEN_THRESHOLD, BREAKPOINT, STORAGE_KEY, STATE_KEY };
}));
