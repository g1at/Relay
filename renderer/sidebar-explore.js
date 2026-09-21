(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelaySidebarExplore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'relay.sidebar.features.v1';
  const FEATURES = Object.freeze([
    { id: 'search', buttonId: 'btnSearch', label: '搜索' },
    { id: 'settings', buttonId: 'btnSettings', containerId: 'sidebarSettingsEntry', label: '设置' },
    { id: 'plugins', buttonId: 'btnPlugins', label: '插件' },
    { id: 'library', buttonId: 'btnMyWorkChat', label: '资料库' },
    { id: 'scheduler', buttonId: 'btnSchedule', label: '定时任务' },
    { id: 'agent', buttonId: 'btnNewAnalysis', label: 'Agent' },
    { id: 'create', buttonId: 'btnCreate', label: 'AI 创作' },
  ].map(Object.freeze));
  const IDS = FEATURES.map(item => item.id);
  const DEFAULT_PINNED = ['search', 'settings', 'plugins', 'library', 'scheduler'];

  function normalizePreferences(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    // v4 folds the previous collaboration entry into Agent. Preserve whichever
    // entry appeared first, and keep Agent pinned if either old entry was pinned.
    const known = list => [...new Set((Array.isArray(list) ? list : [])
      .map(id => id === 'orchestrate' ? 'agent' : id).filter(id => IDS.includes(id)))];
    const configuredOrder = known(input.order);
    const order = [...configuredOrder];
    for (const id of IDS) if (!order.includes(id)) order.push(id);
    const pinned = known(Array.isArray(input.pinned) ? input.pinned : DEFAULT_PINNED);
    // Add the new entry once for existing v1 preferences; v2 preserves deliberate hiding.
    if (input.version === 1 && !known(input.order).includes('plugins')) {
      order.splice(order.indexOf('plugins'), 1);
      order.unshift('plugins'); pinned.unshift('plugins');
    }
    // These entries were always visible before v3. Keep that layout on upgrade,
    // then honor deliberate hiding and reordering in subsequent snapshots.
    if (input.version == null || input.version === 1 || input.version === 2) {
      const added = ['search', 'settings'].filter(id => !configuredOrder.includes(id));
      for (const id of added) order.splice(order.indexOf(id), 1);
      order.unshift(...added); pinned.unshift(...added);
    }
    return { version: 4, order, pinned: order.filter(id => pinned.includes(id)) };
  }

  function setPinnedPreference(value, id, enabled) {
    const next = normalizePreferences(value);
    if (!IDS.includes(id)) return next;
    const pinned = new Set(next.pinned);
    if (enabled) pinned.add(id); else pinned.delete(id);
    next.pinned = next.order.filter(item => pinned.has(item));
    return next;
  }

  function movePreference(value, id, index) {
    const next = normalizePreferences(value);
    if (!IDS.includes(id) || !Number.isFinite(Number(index))) return next;
    const from = next.order.indexOf(id);
    const target = Math.max(0, Math.min(next.order.length - 1, Math.trunc(Number(index))));
    next.order.splice(from, 1);
    next.order.splice(target, 0, id);
    return normalizePreferences(next);
  }

  function createPreferencesStore(storage, onChange = () => {}) {
    let preferences;
    try { preferences = normalizePreferences(JSON.parse(storage && storage.getItem(STORAGE_KEY) || 'null')); }
    catch (_) { preferences = normalizePreferences(null); }
    const snapshot = () => normalizePreferences(preferences);
    const commit = value => {
      preferences = normalizePreferences(value);
      let persisted = false;
      try {
        if (storage) { storage.setItem(STORAGE_KEY, JSON.stringify(preferences)); persisted = true; }
      } catch (_) {}
      onChange(snapshot(), { persisted });
      return snapshot();
    };
    return {
      get: snapshot,
      setPinned: (id, enabled) => commit(setPinnedPreference(preferences, id, enabled)),
      move: (id, index) => commit(movePreference(preferences, id, index)),
      receive(value) { preferences = normalizePreferences(value); onChange(snapshot(), { persisted: true }); },
    };
  }

  function surfacePosition(anchor, size, viewport) {
    const gap = 10, margin = 12;
    const vw = Math.max(0, Number(viewport.width) || 0), vh = Math.max(0, Number(viewport.height) || 0);
    const topMargin = Math.max(margin, Number(viewport.topInset) || 0);
    const width = Math.min(Math.max(0, size.width), Math.max(0, vw - margin * 2));
    const height = Math.min(Math.max(0, size.height), Math.max(0, vh - topMargin - margin));
    const right = Number(anchor.right) || 0, left = Number(anchor.left) || 0;
    const top = Number(anchor.top) || 0, bottom = Number(anchor.bottom) || top;
    const beside = right + gap + width <= vw - margin;
    const x = beside ? right + gap : left;
    let y = beside ? top : bottom + gap;
    if (!beside && y + height > vh - margin && top - gap - height >= topMargin) y = top - gap - height;
    return {
      left: Math.max(margin, Math.min(x, vw - margin - width)),
      top: Math.max(topMargin, Math.min(y, vh - margin - height)),
      maxHeight: Math.max(0, vh - topMargin - margin),
    };
  }

  function create(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (doc && doc.defaultView);
    if (!doc || !win) return null;
    const pinned = options.pinnedContainer || doc.getElementById('sidebarPinnedFeatures');
    const trigger = options.exploreButton || doc.getElementById('btnExplore');
    const featureStore = options.featureStore || doc.getElementById('sidebarFeatureStore');
    if (!pinned || !trigger || !featureStore) return null;
    // Root may safely call create again during initialization without multiplying
    // listeners, moving another copy of a button, or losing an open customizer.
    if (trigger._relaySidebarExplore) return trigger._relaySidebarExplore;
    const features = FEATURES.map(item => ({ ...item, button: doc.getElementById(item.buttonId) }))
      .filter(item => item.button)
      .map(item => ({ ...item, element: (item.containerId && doc.getElementById(item.containerId)) || item.button }));
    const settingsEntry = doc.getElementById('sidebarSettingsEntry');
    const exploreEntry = doc.getElementById('sidebarExploreEntry');
    const updateButton = doc.getElementById('btnRelayUpdate');
    const feature = id => features.find(item => item.id === id);
    let storage = null;
    try { storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : win.localStorage; }
    catch (_) {}
    let surface = null, kind = '', origin = trigger, point = null;
    let disposed = false, dragState = null, dragFrame = 0, frame = 0, persisted = true;
    let resizeObserver = null, activeObserver = null;
    const off = [];
    const listen = (element, name, handler, settings) => {
      element.addEventListener(name, handler, settings);
      off.push(() => element.removeEventListener(name, handler, settings));
    };
    const node = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const isVisible = element => {
      if (!element || element.isConnected === false || element.hidden || element.disabled
          || typeof element.focus !== 'function' || element.closest('[inert]')
          || !element.getClientRects().length) return false;
      if (typeof win.getComputedStyle === 'function') {
        for (let current = element; current; current = current.parentElement) {
          const style = win.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || style.pointerEvents === 'none' || style.opacity === '0') return false;
        }
      }
      return true;
    };
    const focus = element => {
      if (!isVisible(element)) return false;
      try { element.focus({ preventScroll: true }); } catch (_) { return false; }
      return doc.activeElement === element;
    };
    function restoreFocus() {
      if (focus(origin) || focus(trigger)) return;
      if (focus(doc.getElementById('btnToggleSidebar'))) return;
      for (const element of doc.querySelectorAll('[data-toggle-sidebar]')) if (focus(element)) return;
    }
    const icon = button => {
      const source = button && button.querySelector('svg');
      if (!source) return node('span', 'se-feature-icon');
      const copy = source.cloneNode(true);
      copy.removeAttribute('id');
      copy.setAttribute('class', 'se-feature-icon');
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('focusable', 'false');
      for (const child of copy.querySelectorAll('[id]')) child.removeAttribute('id');
      return copy;
    };

    function syncExploreState() {
      if (disposed) return;
      const active = features.some(item => item.element.parentElement === featureStore && item.button.classList.contains('active'));
      trigger.classList.toggle('has-active-feature', active);
    }

    function apply(preferences) {
      // Move the original nodes. Existing handlers, active state, IDs and stored
      // references in app.js remain authoritative for all feature behavior.
      for (const id of preferences.order) {
        const item = feature(id);
        if (item) (preferences.pinned.includes(id) ? pinned : featureStore).appendChild(item.element);
      }
      // Keep version updates reachable even when Settings is tucked into Explore.
      if (updateButton && settingsEntry && exploreEntry) {
        const host = preferences.pinned.includes('settings') ? settingsEntry : exploreEntry;
        if (updateButton.parentElement !== host) host.appendChild(updateButton);
      }
      syncExploreState();
    }

    const store = createPreferencesStore(storage, (preferences, status) => {
      cancelDrag();
      persisted = status.persisted;
      apply(preferences);
      if (typeof options.onChange === 'function') options.onChange(preferences, status);
      if (kind === 'customize') renderCustomizer();
      else if (kind === 'explore') renderExplore();
    });

    function position() {
      if (!surface || disposed) return;
      if (!isVisible(origin)) { close({ restore: true }); return; }
      const chrome = doc.getElementById('windowChrome');
      const topInset = chrome && chrome.getClientRects().length ? chrome.getBoundingClientRect().bottom + 8 : 12;
      const viewport = { width: win.innerWidth, height: win.innerHeight, topInset };
      surface.style.maxHeight = `${Math.max(0, viewport.height - topInset - 12)}px`;
      if (kind === 'customize') {
        // Edit the navigation in place, below the sidebar's brand row.
        const sidebar = doc.getElementById('sidebarNavigation');
        const nav = sidebar && sidebar.querySelector('.nav-list');
        if (sidebar && nav) {
          const bounds = sidebar.getBoundingClientRect(), anchor = nav.getBoundingClientRect();
          const width = Math.min(300, Math.max(144, bounds.width - 16), viewport.width - 24);
          surface.style.width = `${width}px`;
          surface.style.left = `${Math.max(8, Math.min(bounds.left + 8, viewport.width - width - 8))}px`;
          surface.style.top = `${Math.max(topInset, anchor.top)}px`;
          surface.style.maxHeight = `${Math.max(0, viewport.height - Math.max(topInset, anchor.top) - 12)}px`;
          return;
        }
      }
      const rectangle = surface.getBoundingClientRect();
      const placed = surfacePosition(point || origin.getBoundingClientRect(), rectangle, viewport);
      surface.style.left = `${placed.left}px`;
      surface.style.top = `${placed.top}px`;
    }
    function schedulePosition() {
      if (!surface || frame) return;
      frame = win.requestAnimationFrame(() => { frame = 0; position(); });
    }
    function sidebarChanged() {
      if (!surface) return;
      if (!isVisible(origin)) close({ restore: true });
      else schedulePosition();
    }
    function close({ restore = true } = {}) {
      if (!surface) return;
      cancelDrag();
      const previous = surface;
      surface = null; kind = ''; point = null;
      previous.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-haspopup', 'menu');
      if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
      if (restore) restoreFocus();
    }
    function openSurface(nextKind, anchor = trigger, at = null) {
      close({ restore: false });
      kind = nextKind; origin = anchor; point = at;
      surface = node('section', `sidebar-explore-surface se-${kind}`);
      surface.id = 'sidebarExploreSurface';
      surface.setAttribute('role', kind === 'customize' ? 'dialog' : 'menu');
      surface.setAttribute('aria-label', kind === 'customize' ? '自定义侧边栏' : kind === 'context' ? '入口选项' : '探索');
      if (kind === 'customize') surface.setAttribute('aria-modal', 'false');
      surface.addEventListener('keydown', surfaceKeys);
      doc.body.appendChild(surface);
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-haspopup', kind === 'customize' ? 'dialog' : 'menu');
      trigger.setAttribute('aria-controls', surface.id);
      return surface;
    }
    function action(text, callback, item = null) {
      const button = node('button', 'se-menu-item');
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      if (item) { button.appendChild(icon(item.button)); button.dataset.feature = item.id; }
      if (!item && text === '自定义') {
        const mark = node('span', 'se-feature-icon');
        mark.setAttribute('aria-hidden', 'true');
        mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>';
        button.appendChild(mark);
      }
      button.appendChild(node('span', 'se-menu-label', text));
      button.addEventListener('click', callback);
      surface.appendChild(button);
      return button;
    }
    function activate(item) {
      if (!item || item.button.disabled) return;
      close();
      item.button.click();
    }
    function renderExplore() {
      if (!surface || kind !== 'explore') return;
      surface.replaceChildren();
      const preferences = store.get();
      const available = preferences.order.map(feature).filter(item => item && !preferences.pinned.includes(item.id));
      for (const item of available) {
        const button = action(item.label, () => activate(item), item);
        button.disabled = !!item.button.disabled;
        if (item.button.classList.contains('active')) button.setAttribute('aria-current', 'page');
      }
      if (!available.length) surface.appendChild(node('p', 'se-empty', '所有入口已显示在侧边栏'));
      surface.appendChild(node('div', 'se-menu-separator'));
      const customize = action('自定义', () => openCustomize());
      customize.dataset.action = 'customize';
      position();
    }
    function openExplore({ last = false } = {}) {
      if (disposed) return;
      openSurface('explore'); renderExplore();
      const buttons = menuItems();
      focus(last ? buttons.at(-1) : buttons[0]);
    }
    function openContext(item, event) {
      if (disposed || !item || item.element.parentElement !== pinned) return;
      const at = event && event.type === 'contextmenu' && (event.clientX || event.clientY)
        ? { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY } : null;
      openSurface('context', item.button, at);
      const open = action(`打开${item.label === 'Agent' ? ' Agent' : item.label}`, () => activate(item), item);
      open.disabled = !!item.button.disabled;
      const remove = action('从侧边栏移除', () => { store.setPinned(item.id, false); close(); });
      remove.dataset.action = 'unpin'; remove.dataset.feature = item.id;
      surface.appendChild(node('div', 'se-menu-separator'));
      const customize = action('自定义', () => openCustomize());
      customize.dataset.action = 'customize';
      position(); focus(menuItems()[0]);
    }
    function menuItems() { return surface ? [...surface.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled) : []; }
    function surfaceKeys(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); escape(); return; }
      if (kind === 'customize') {
        const row = event.target.closest('[data-customize-feature]');
        if (row && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          moveRelative(row.dataset.customizeFeature, event.key === 'ArrowUp' ? -1 : 1);
        }
        return;
      }
      if (event.key === 'Tab') { close(); return; }
      const items = menuItems(), current = items.indexOf(doc.activeElement);
      let index;
      if (event.key === 'ArrowDown') index = (current + 1) % items.length;
      if (event.key === 'ArrowUp') index = (current - 1 + items.length) % items.length;
      if (event.key === 'Home') index = 0;
      if (event.key === 'End') index = items.length - 1;
      if (index !== undefined) { event.preventDefault(); event.stopPropagation(); focus(items[index]); }
    }

    function focusCustomizer(id, actionName = 'checkbox') {
      if (!surface || kind !== 'customize') return;
      const row = surface.querySelector(`[data-customize-feature="${id}"]`);
      if (row) focus(row.querySelector(`[data-action="${actionName}"]`) || row.querySelector('input'));
    }
    function announce(text) {
      const live = surface && surface.querySelector('.se-live');
      if (live) live.textContent = text;
    }
    const customizeRows = () => surface ? [...surface.querySelectorAll('[data-customize-feature]')] : [];
    const reducedMotion = () => typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function rowPositions() {
      return new Map(customizeRows().map(row => [row.dataset.customizeFeature, row.getBoundingClientRect()]));
    }
    function animateRowsFrom(before) {
      if (reducedMotion()) return;
      for (const row of customizeRows()) {
        const previous = before.get(row.dataset.customizeFeature);
        if (!previous || typeof row.animate !== 'function') continue;
        const current = row.getBoundingClientRect(), delta = previous.top - current.top;
        if (Math.abs(delta) < .5) continue;
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
          duration: 230, easing: 'cubic-bezier(.2,.8,.2,1)',
        });
      }
    }
    function layoutRectangle(row) {
      const rectangle = row.getBoundingClientRect(), list = row.parentElement;
      // Hit testing must ignore the live transforms; otherwise moving neighbors
      // repeatedly switch the destination beneath a stationary pointer.
      if (row.offsetParent !== list || !Number.isFinite(row.offsetTop)) return rectangle;
      const top = list.getBoundingClientRect().top + list.clientTop + row.offsetTop - list.scrollTop;
      return { ...rectangle, top, bottom: top + row.offsetHeight, height: row.offsetHeight };
    }
    function moveRelative(id, direction) {
      cancelDrag();
      const preferences = store.get();
      const index = preferences.order.indexOf(id);
      if (index < 0 || index + direction < 0 || index + direction >= preferences.order.length) return;
      const before = rowPositions();
      store.move(id, index + direction);
      animateRowsFrom(before);
      focusCustomizer(id, 'drag');
      announce(`${feature(id).label}已移至第 ${index + direction + 1} 项`);
    }
    function clearDrop() {
      if (surface) for (const row of surface.querySelectorAll('[data-drop]')) row.removeAttribute('data-drop');
    }
    function cancelDrag({ restore = false, announceCancel = false, animate = true } = {}) {
      const previous = dragState;
      const before = previous && previous.moved && animate ? rowPositions() : null;
      dragState = null;
      if (dragFrame) { win.cancelAnimationFrame(dragFrame); dragFrame = 0; }
      clearDrop();
      if (surface) surface.classList.remove('is-sorting');
      if (!previous) return;
      previous.row.classList.remove('is-dragging');
      for (const row of customizeRows()) row.style.transform = '';
      try {
        if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
      } catch (_) {}
      if (before) animateRowsFrom(before);
      if (restore) focus(previous.handle);
      if (announceCancel && previous.moved) announce('已取消排序');
    }
    function escape() {
      if (dragState) cancelDrag({ restore: true, announceCancel: true });
      else close();
    }
    function updateDragTarget() {
      const state = dragState;
      if (!state || !surface || !state.moved) return;
      const allRows = customizeRows();
      const rows = allRows.filter(row => row.dataset.customizeFeature !== state.id);
      // The captured event target stays the handle. Always measure the current
      // rows instead, including after a scroll or viewport change.
      let target = null;
      for (const row of rows) {
        const rectangle = layoutRectangle(row);
        if (state.clientY < rectangle.top + rectangle.height / 2) {
          target = { row, id: row.dataset.customizeFeature, after: false }; break;
        }
      }
      if (!target && rows.length) {
        const row = rows.at(-1);
        target = { row, id: row.dataset.customizeFeature, after: true };
      }
      clearDrop(); state.target = null;
      if (!target) return;
      const order = store.get().order;
      const index = order.filter(id => id !== state.id).indexOf(target.id) + (target.after ? 1 : 0);
      if (index !== order.indexOf(state.id)) {
        target.row.dataset.drop = target.after ? 'after' : 'before';
        state.target = { index };
      }
      const rectangles = new Map(allRows.map(row => [row, layoutRectangle(row)]));
      const moving = rectangles.get(state.row), list = state.row.parentElement;
      const first = rectangles.get(allRows[0]), last = rectangles.get(allRows.at(-1));
      const gap = allRows.length > 1 ? Math.max(0, rectangles.get(allRows[1]).top - first.bottom) : 0;
      const projected = movePreference({ order, pinned: [] }, state.id, index).order;
      let top = first.top;
      for (const id of projected) {
        const row = allRows.find(item => item.dataset.customizeFeature === id);
        if (!row) continue;
        const rectangle = rectangles.get(row);
        if (row === state.row) {
          if (typeof list.style.setProperty === 'function') {
            list.style.setProperty('--se-slot-top', `${top - list.getBoundingClientRect().top + list.scrollTop}px`);
            list.style.setProperty('--se-slot-height', `${moving.height}px`);
          }
        } else row.style.transform = `translateY(${top - rectangle.top}px)`;
        top += rectangle.height + gap;
      }
      const liftedTop = Math.max(first.top, Math.min(state.clientY - state.grabOffset, last.bottom - moving.height));
      state.row.style.transform = `translateY(${liftedTop - moving.top}px)`;
    }
    function scheduleDrag() {
      if (!dragState || !dragState.moved || dragFrame) return;
      dragFrame = win.requestAnimationFrame(() => {
        dragFrame = 0;
        const list = dragState.row.parentElement, bounds = list.getBoundingClientRect();
        if (list.scrollHeight > list.clientHeight) {
          const edge = Math.min(30, bounds.height / 4), y = dragState.clientY;
          const distance = y < bounds.top + edge ? y - bounds.top - edge : y > bounds.bottom - edge ? y - bounds.bottom + edge : 0;
          list.scrollTop += Math.max(-8, Math.min(8, distance * .2));
        }
        updateDragTarget();
        scheduleDrag();
      });
    }
    function trackDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId || !Number.isFinite(event.clientY)) return false;
      dragState.clientY = event.clientY;
      if (!dragState.moved && Math.abs(dragState.clientY - dragState.startY) >= 4) {
        dragState.moved = true;
        dragState.row.classList.add('is-dragging');
        surface.classList.add('is-sorting');
      }
      return true;
    }
    function beginDrag(event, item, row, handle) {
      if (dragState || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.clientY)) return;
      event.preventDefault(); event.stopPropagation();
      for (const element of [surface, ...customizeRows()]) {
        if (typeof element.getAnimations === 'function') for (const animation of element.getAnimations()) animation.finish();
      }
      focus(handle);
      try { handle.setPointerCapture(event.pointerId); } catch (_) { return; }
      dragState = { id: item.id, pointerId: event.pointerId, row, handle, startY: event.clientY, clientY: event.clientY,
        grabOffset: event.clientY - layoutRectangle(row).top, moved: false, target: null };
    }
    function pointerMove(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (event.pointerType === 'mouse' && event.buttons === 0) { cancelDrag(); return; }
      if (!trackDrag(event)) return;
      event.preventDefault(); scheduleDrag();
    }
    function pointerUp(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      trackDrag(event);
      updateDragTarget();
      const { id, target } = dragState;
      const before = rowPositions();
      cancelDrag({ animate: false });
      if (!target) { animateRowsFrom(before); return; }
      store.move(id, target.index); animateRowsFrom(before); focusCustomizer(id, 'drag');
      announce(`${feature(id).label}已移至第 ${target.index + 1} 项`);
    }
    function renderCustomizer() {
      if (!surface || kind !== 'customize') return;
      const selected = doc.activeElement;
      const oldRow = selected && selected.closest('[data-customize-feature]');
      const focusId = oldRow && oldRow.dataset.customizeFeature;
      const actionName = selected && selected.dataset.action || 'checkbox';
      surface.replaceChildren();
      const head = node('div', 'se-customize-heading');
      const title = node('h2');
      title.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>';
      title.appendChild(node('span', '', '自定义')); head.appendChild(title);
      const done = node('button', 'se-done', '完成'); done.type = 'button'; done.dataset.action = 'done';
      done.addEventListener('click', () => close()); head.appendChild(done); surface.appendChild(head);
      surface.appendChild(node('p', 'se-customize-caption', '勾选显示 · 拖动排序'));
      const list = node('div', 'se-customize-list'); list.setAttribute('role', 'list');
      list.setAttribute('aria-label', '侧边栏入口顺序');
      const preferences = store.get();
      const ordered = preferences.order.map(feature).filter(Boolean);
      ordered.forEach(item => {
        const row = node('div', 'se-customize-row'); row.dataset.customizeFeature = item.id;
        row.setAttribute('role', 'listitem');
        const drag = node('button', 'se-drag'); drag.type = 'button';
        drag.innerHTML = '<svg viewBox="0 0 12 18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.25"/><circle cx="9" cy="3" r="1.25"/><circle cx="3" cy="9" r="1.25"/><circle cx="9" cy="9" r="1.25"/><circle cx="3" cy="15" r="1.25"/><circle cx="9" cy="15" r="1.25"/></svg>';
        drag.dataset.action = 'drag'; drag.setAttribute('aria-label', `调整${item.label}顺序`);
        drag.title = '拖动排序，或按 Alt + ↑ / ↓'; drag.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
        drag.addEventListener('pointerdown', event => beginDrag(event, item, row, drag));
        drag.addEventListener('lostpointercapture', event => {
          if (dragState && event.pointerId === dragState.pointerId) cancelDrag({ announceCancel: true });
        });
        const label = node('label', 'se-choice');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = preferences.pinned.includes(item.id);
        checkbox.dataset.action = 'checkbox'; checkbox.setAttribute('aria-label', `在侧边栏显示${item.label}`);
        checkbox.addEventListener('change', () => {
          store.setPinned(item.id, checkbox.checked); focusCustomizer(item.id);
          announce(`${item.label}${checkbox.checked ? '已显示在侧边栏' : '已移到探索'}`);
        });
        label.appendChild(checkbox); label.appendChild(icon(item.button)); label.appendChild(node('span', 'se-choice-label', item.label));
        row.appendChild(label);
        row.appendChild(drag);
        list.appendChild(row);
      });
      surface.appendChild(list);
      if (!persisted) {
        const footer = node('div', 'se-customize-footer', '已调整显示，暂时无法保存到本机');
        footer.dataset.persisted = 'false'; footer.setAttribute('role', 'status'); surface.appendChild(footer);
      }
      const live = node('span', 'se-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); surface.appendChild(live);
      position();
      if (focusId) focusCustomizer(focusId, actionName);
    }
    function openCustomize() {
      if (disposed) return;
      openSurface('customize', trigger); renderCustomizer();
      const first = surface && surface.querySelector('input');
      focus(first);
    }

    featureStore.hidden = true; featureStore.setAttribute('aria-hidden', 'true');
    pinned.classList.add('sidebar-pinned-features');
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    listen(trigger, 'click', () => kind === 'explore' ? close() : openExplore());
    listen(trigger, 'contextmenu', event => { event.preventDefault(); openExplore(); });
    listen(trigger, 'keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); openExplore({ last: event.key === 'ArrowUp' });
      }
    });
    for (const item of features) {
      listen(item.button, 'contextmenu', event => {
        if (item.element.parentElement !== pinned) return;
        event.preventDefault(); openContext(item, event);
      });
      listen(item.button, 'keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); openContext(item, event);
        }
      });
    }
    listen(doc, 'pointerdown', event => {
      if (surface && !surface.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) close({ restore: false });
    }, true);
    listen(doc, 'keydown', event => {
      if (surface && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); escape(); }
    }, true);
    listen(doc, 'focusin', event => {
      if (surface && !surface.contains(event.target) && event.target !== trigger) close({ restore: false });
    });
    listen(win, 'resize', sidebarChanged);
    listen(win, 'pointermove', pointerMove, { capture: true, passive: false });
    listen(win, 'pointerup', pointerUp, true);
    listen(win, 'pointercancel', event => {
      if (dragState && event.pointerId === dragState.pointerId) cancelDrag({ announceCancel: true });
    }, true);
    listen(win, 'blur', () => cancelDrag({ announceCancel: true }));
    listen(win, 'relay:sidebar-changed', sidebarChanged);
    listen(doc, 'scroll', event => { if (surface && !surface.contains(event.target)) schedulePosition(); }, true);
    listen(win, 'storage', event => {
      if (event.key !== STORAGE_KEY || (event.storageArea && storage && event.storageArea !== storage)) return;
      try { store.receive(JSON.parse(event.newValue || 'null')); } catch (_) {}
    });
    if (typeof win.ResizeObserver === 'function') {
      resizeObserver = new win.ResizeObserver(schedulePosition);
      resizeObserver.observe(pinned); resizeObserver.observe(trigger);
    }
    if (typeof win.MutationObserver === 'function') {
      activeObserver = new win.MutationObserver(syncExploreState);
      for (const item of features) activeObserver.observe(item.button, { attributes: true, attributeFilter: ['class'] });
    }
    apply(store.get());
    const controller = {
      openExplore, openCustomize, close,
      getPreferences: store.get,
      setPinned(id, enabled) { return disposed ? store.get() : store.setPinned(id, !!enabled); },
      move(id, index) { return disposed ? store.get() : store.move(id, index); },
      destroy() {
        if (disposed) return;
        close({ restore: false }); disposed = true;
        off.forEach(remove => remove());
        if (resizeObserver) resizeObserver.disconnect();
        if (activeObserver) activeObserver.disconnect();
        delete trigger._relaySidebarExplore;
      },
    };
    trigger._relaySidebarExplore = controller;
    return controller;
  }

  return { FEATURES, STORAGE_KEY, normalizePreferences, setPinnedPreference, movePreference, createPreferencesStore, surfacePosition, create };
});
