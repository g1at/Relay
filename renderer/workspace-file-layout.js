(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayWorkspaceFileLayout = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const DEFAULT_WIDTH = 230, MIN_WIDTH = 160, COLLAPSE_WIDTH = 128, REOPEN_WIDTH = 160;
  const MIN_PREVIEW = 240, OVERLAY_BREAKPOINT = 560, MOTION_MS = 240;
  const STORAGE_KEY = 'relay.workspace-file-layout.v1';
  const instances = new WeakMap();
  function readPreference(storage) {
    try {
      const value = JSON.parse(storage?.getItem(STORAGE_KEY));
      if (value?.version === 1 && Number.isFinite(value.width) && value.width >= MIN_WIDTH && value.width < 10000 && typeof value.collapsed === 'boolean') {
        return { width: Math.round(value.width), collapsed: value.collapsed };
      }
    } catch (_) {}
    return { width: DEFAULT_WIDTH, collapsed: false };
  }
  function create({ body, tree, handle, toggle, window: win, storage, getActive = () => true }) {
    if (instances.has(body)) return instances.get(body);
    if (!storage) { try { storage = win.localStorage; } catch (_) {} }
    const saved = readPreference(storage), listeners = [];
    let preferredWidth = saved.width, collapsed = saved.collapsed, width = 0;
    let preview = false, key = null, drawerOpen = false, active = false, lastSize = body.clientWidth || 380;
    let narrow = lastSize < OVERLAY_BREAKPOINT, drag = null, frame = null, snapTimer = null, destroyed = false;
    const previewNode = body.querySelector('.workspace-preview');
    let previewPriorInert = null;
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (target, name, fn, options) => { target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options)); };
    const maxWidth = () => Math.max(MIN_WIDTH, lastSize - (narrow ? 24 : MIN_PREVIEW));
    const clamp = value => Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(value)));
    const isPickerFull = () => !preview && narrow;
    const isExpanded = () => isPickerFull() || (narrow ? drawerOpen && !collapsed : !collapsed);
    function persist() {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, width: preferredWidth, collapsed })); } catch (_) {}
    }
    function clearAnimation() {
      if (snapTimer != null) win.clearTimeout(snapTimer);
      snapTimer = null; body.classList.remove('is-file-tree-snapping');
    }
    function animate() {
      clearAnimation();
      if (media.matches || destroyed) return;
      body.classList.add('is-file-tree-snapping');
      snapTimer = win.setTimeout(clearAnimation, MOTION_MS + 34);
    }
    function apply() {
      if (destroyed) return;
      active = !!getActive();
      const expanded = isExpanded();
      width = isPickerFull() ? lastSize : expanded ? drag ? Math.max(0, Math.min(maxWidth(), drag.rawWidth)) : clamp(preferredWidth) : 0;
      body.style.setProperty('--file-tree-width', width + 'px');
      body.classList.toggle('is-picker', !preview);
      body.classList.toggle('is-file-tree-picker', isPickerFull());
      body.classList.toggle('tree-closed', !expanded);
      body.classList.toggle('is-file-tree-overlay', preview && narrow);
      tree.hidden = false; tree.inert = !active || !expanded;
      tree.setAttribute('aria-hidden', String(!active || !expanded));
      if (active && !expanded && (tree.contains(win.document.activeElement) || (!drag && win.document.activeElement === handle))) (drag ? handle : toggle).focus({ preventScroll: true });
      const overlay = active && preview && narrow && expanded;
      if (previewNode) {
        if (overlay && previewPriorInert == null) previewPriorInert = previewNode.inert;
        if (overlay) previewNode.inert = true;
        else if (previewPriorInert != null) { previewNode.inert = previewPriorInert; previewPriorInert = null; }
      }
      handle.hidden = !active || isPickerFull() || (!expanded && !drag);
      handle.tabIndex = handle.hidden ? -1 : 0;
      handle.setAttribute('aria-disabled', String(handle.hidden));
      handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', String(maxWidth()));
      handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', expanded ? `${Math.round(width)} 像素` : '已收起');
      toggle.disabled = !active || isPickerFull();
      toggle.setAttribute('aria-controls', tree.id); toggle.setAttribute('aria-pressed', String(expanded));
      toggle.title = isPickerFull() ? '选择文件后可调整目录宽度' : expanded ? '收起文件树' : '显示文件树';
      toggle.setAttribute('aria-label', toggle.title);
    }
    function cancelFrame() { if (frame != null) win.cancelAnimationFrame(frame); frame = null; }
    function endDrag(commit) {
      if (!drag) return;
      const previous = drag; drag = null; cancelFrame();
      if (commit) preferredWidth = collapsed ? previous.preferredWidth : clamp(previous.rawWidth);
      else { clearAnimation(); preferredWidth = previous.preferredWidth; collapsed = previous.collapsed; drawerOpen = previous.drawerOpen; }
      body.classList.remove('is-file-tree-resizing');
      try { if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id); } catch (_) {}
      apply(); if (commit) persist();
    }
    function measure() {
      const nextSize = body.clientWidth;
      if (nextSize > 0 && nextSize !== lastSize) {
        if (drag) endDrag(false);
        lastSize = nextSize;
        const nextNarrow = lastSize < OVERLAY_BREAKPOINT;
        if (nextNarrow !== narrow) drawerOpen = false;
        narrow = nextNarrow;
      }
    }
    function sync(options = {}) {
      if (destroyed) return;
      const nextPreview = options.preview ?? preview, nextKey = options.key === undefined ? key : options.key;
      if (drag && (!getActive() || nextPreview !== preview || nextKey !== key)) endDrag(false);
      if (nextPreview !== preview) drawerOpen = false;
      preview = !!nextPreview; key = nextKey; measure();
      if (!getActive()) clearAnimation();
      apply();
    }
    function toggleTree() {
      if (!getActive() || isPickerFull()) return;
      endDrag(false); const expanded = isExpanded();
      collapsed = expanded; drawerOpen = !expanded; animate(); apply(); persist();
    }
    function showTree() {
      if (!getActive()) return;
      endDrag(false); measure(); collapsed = false; drawerOpen = true;
      animate(); apply(); persist();
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault();
      drag.rawWidth = Math.max(0, Math.min(maxWidth(), Math.round(drag.width + drag.x - event.clientX)));
      const nextCollapsed = collapsed ? drag.rawWidth < REOPEN_WIDTH : drag.rawWidth < COLLAPSE_WIDTH;
      if (nextCollapsed !== collapsed) { collapsed = nextCollapsed; drawerOpen = !collapsed; animate(); }
      if (frame == null) frame = win.requestAnimationFrame(() => { frame = null; apply(); });
    }
    on(handle, 'pointerdown', event => {
      if (!active || isPickerFull() || !isExpanded() || drag || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, x: event.clientX, width, rawWidth: width, preferredWidth, collapsed, drawerOpen };
      body.classList.add('is-file-tree-resizing'); handle.focus({ preventScroll: true });
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    });
    on(win, 'pointermove', move, { passive: false });
    on(win, 'pointerup', event => { if (drag && event.pointerId === drag.id) { move(event); endDrag(true); } });
    on(win, 'pointercancel', event => { if (drag && event.pointerId === drag.id) endDrag(false); });
    on(handle, 'lostpointercapture', event => { if (drag && event.pointerId === drag.id) endDrag(false); });
    on(win, 'blur', () => endDrag(false));
    on(win, 'keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); endDrag(false); } }, true);
    on(toggle, 'click', toggleTree);
    function setWidth(value) { endDrag(false); preferredWidth = clamp(value); collapsed = false; drawerOpen = true; animate(); apply(); persist(); }
    on(handle, 'dblclick', event => { if (active && !isPickerFull()) { event.preventDefault(); setWidth(DEFAULT_WIDTH); } });
    on(handle, 'keydown', event => {
      if (!active || isPickerFull() || drag) return;
      const step = event.shiftKey ? 32 : 8;
      const value = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step
        : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth() : event.key === 'Enter' ? DEFAULT_WIDTH : null;
      if (value == null) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowRight' && value < MIN_WIDTH) toggleTree(); else setWidth(value);
    });
    on(body, 'transitionend', event => { if (event.target === body && event.propertyName === 'grid-template-columns') clearAnimation(); });
    if (media.addEventListener) on(media, 'change', event => { if (event.matches) clearAnimation(); });
    on(win, 'resize', () => { endDrag(false); sync(); });
    on(win, 'relay:workspace-tab', () => sync());
    on(win, 'relay:view-changed', () => { endDrag(false); clearAnimation(); sync(); });
    const observer = win.ResizeObserver ? new win.ResizeObserver(() => sync()) : null;
    observer?.observe(body);
    const controller = { sync, toggle: toggleTree, show: showTree,
      getState: () => ({ width, preferredWidth, collapsed, expanded: isExpanded(), preview, active, narrow, max: maxWidth(), dragging: !!drag }),
      destroy() { if (destroyed) return; endDrag(false); clearAnimation(); cancelFrame(); observer?.disconnect(); listeners.splice(0).forEach(off => off()); if (previewNode && previewPriorInert != null) previewNode.inert = previewPriorInert; destroyed = true; instances.delete(body); },
    };
    on(win, 'pagehide', () => controller.destroy());
    instances.set(body, controller); body.classList.add('has-file-layout'); apply();
    return controller;
  }
  return { create, readPreference, STORAGE_KEY, DEFAULT_WIDTH, MIN_WIDTH, COLLAPSE_WIDTH, REOPEN_WIDTH };
}));
