(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayPermissionControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODES = Object.freeze([
    Object.freeze({ value: 'default', label: '请求批准', description: '需要工具授权时请求批准', icon: 'hand' }),
    Object.freeze({ value: 'acceptEdits', label: '帮我批准', description: '自动允许文件编辑，其他操作请求批准', icon: 'terminal' }),
    Object.freeze({ value: 'bypassPermissions', label: '完全访问权限', description: '跳过常规工具审批，访问文件并执行命令', icon: 'shield' }),
  ]);
  const ICONS = {
    hand: '<path d="M8 12V6a2 2 0 0 1 4 0v5M12 10V4a2 2 0 0 1 4 0v7M16 11V6a2 2 0 0 1 4 0v8c0 5-3 8-7 8-3 0-5-2-7-5l-3-5a2 2 0 0 1 3-2l2 2Z"/>',
    terminal: '<path d="m12 3 8 4v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V7l8-4Z"/><path d="m8 9 2.5 2.5L8 14M13 14h3"/>',
    shield: '<path d="m12 3 8 4v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V7l8-4Z"/><path d="M12 8v5M12 16h.01"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  let nextId = 0;
  function permissionState(raw = {}) {
    if (!raw || typeof raw !== 'object') raw = {};
    const mode = MODES.find(item => item.value === raw.permissionMode) || null;
    const plan = raw.plan === true || raw.permissionMode === 'plan';
    return {
      mode, plan, busy: raw.busy === true,
      disabled: !mode || plan || raw.disabled === true || raw.busy === true,
      title: plan ? '计划模式下暂不能修改权限；退出计划模式后可调整' : raw.busy === true ? '正在更新权限…' : !mode ? '正在加载权限设置' : raw.disabled ? '当前暂不能修改权限，请稍后重试' : mode.description,
      label: mode?.label || (plan ? '计划模式' : '加载权限'),
    };
  }
  function placePopover(anchor, size, viewport, edge = 10, gap = 8) {
    const originLeft = viewport.left || 0, originTop = viewport.top || 0;
    const width = Math.max(0, Math.min(size.width, viewport.width - edge * 2));
    const above = Math.max(0, anchor.top - originTop - edge - gap);
    const below = Math.max(0, originTop + viewport.height - anchor.bottom - edge - gap);
    const side = above >= size.height || above >= below ? 'above' : 'below';
    const maxHeight = Math.max(0, Math.min(viewport.height - edge * 2, side === 'above' ? above : below));
    const height = Math.min(size.height, maxHeight);
    const left = Math.max(originLeft + edge, Math.min(anchor.left, originLeft + viewport.width - edge - width));
    const top = Math.max(originTop + edge, Math.min(side === 'above' ? anchor.top - gap - height : anchor.bottom + gap, originTop + viewport.height - edge - height));
    return { width, maxHeight, left, top, side };
  }
  function create({ button, getState, onChange, beforeOpen, notify = () => {} } = {}) {
    if (!button || typeof getState !== 'function' || typeof onChange !== 'function') throw new TypeError('权限选择缺少按钮或状态接口');
    if (button._relayPermissionControls) return button._relayPermissionControls;
    const doc = button.ownerDocument, win = doc.defaultView;
    let popup = null, disposed = false, preparing = false, saving = false, generation = 0, frame = null, observer = null;
    const id = `relayPermissionMenu-${++nextId}`;
    const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text != null) value.textContent = text; return value; };
    const read = () => { try { return permissionState(getState() || {}); } catch (_) { return permissionState(); } };
    button.classList.add('rpc-trigger'); button.type = 'button'; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id);
    const triggerIcon = node('span', 'rpc-trigger-icon'), triggerLabel = node('span', 'rpc-trigger-label'); button.replaceChildren(triggerIcon, triggerLabel);
    function close(restore = false) {
      generation++; preparing = false;
      if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; }
      observer?.disconnect(); observer = null;
      if (popup) { popup.remove(); popup = null; }
      button.setAttribute('aria-expanded', 'false');
      if (!disposed) updateButton(read());
      if (restore && button.isConnected && !button.disabled) button.focus({ preventScroll: true });
    }
    function updateButton(state) {
      button.dataset.permissionMode = state.mode?.value || '';
      button.dataset.permissionPlan = String(state.plan);
      button.dataset.permissionBusy = String(saving || preparing || state.busy);
      button.disabled = state.disabled || saving || preparing;
      button.title = saving ? '正在更新权限…' : preparing ? '正在加载权限设置' : state.title;
      button.setAttribute('aria-label', `权限：${state.label}${state.plan ? '，计划模式中不可更改' : ''}`);
      triggerLabel.textContent = state.label;
      const shape = state.mode?.icon || 'terminal';
      if (triggerIcon.dataset.icon !== shape) { triggerIcon.dataset.icon = shape; triggerIcon.innerHTML = icon(shape); }
    }
    function sync() {
      if (disposed) return;
      const state = read(); updateButton(state);
      if (popup && (state.plan || !state.mode || (state.disabled && !state.busy))) { close(); return; }
      if (!popup) return;
      popup.setAttribute('aria-busy', String(saving || state.busy));
      popup.querySelectorAll('[data-permission-option]').forEach(option => {
        option.setAttribute('aria-checked', String(option.dataset.permissionOption === state.mode?.value));
        option.disabled = saving || state.disabled;
      });
      schedulePosition();
    }
    function viewport() {
      const visual = win.visualViewport;
      return { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0, width: visual?.width || win.innerWidth, height: visual?.height || win.innerHeight };
    }
    function position() {
      frame = null; if (!popup || disposed) return;
      const rect = button.getBoundingClientRect(), view = viewport();
      if (!button.isConnected || !rect.width || !rect.height || rect.bottom <= view.top || rect.top >= view.top + view.height || rect.right <= view.left || rect.left >= view.left + view.width) { close(); return; }
      for (let parent = button.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
        const style = win.getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if ((/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top >= clip.bottom || rect.bottom <= clip.top)) || (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left >= clip.right || rect.right <= clip.left))) { close(); return; }
      }
      const preferredWidth = parseFloat(win.getComputedStyle(popup).getPropertyValue('--rpc-popover-width')) || 280;
      popup.style.width = Math.max(0, Math.min(preferredWidth, view.width - 20)) + 'px';
      const layout = placePopover(rect, { width: preferredWidth, height: Math.max(popup.scrollHeight + 2, popup.offsetHeight) }, view);
      if (layout.maxHeight < 36) { close(); return; }
      popup.style.left = layout.left + 'px'; popup.style.top = layout.top + 'px'; popup.style.maxHeight = layout.maxHeight + 'px'; popup.dataset.placement = layout.side;
    }
    function schedulePosition() { if (popup && frame === null) frame = win.requestAnimationFrame(position); }
    function focusOption(which) {
      if (!popup) return;
      const options = [...popup.querySelectorAll('[data-permission-option]:not(:disabled)')];
      const selected = options.find(option => option.getAttribute('aria-checked') === 'true');
      (which === 'first' ? options[0] : which === 'last' ? options.at(-1) : selected || options[0])?.focus({ preventScroll: true });
    }
    async function select(mode) {
      if (disposed || saving || read().disabled) return;
      if (read().mode?.value === mode) { close(true); return; }
      saving = true; sync();
      try {
        const result = await onChange(mode);
        if (disposed) return;
        if (result === false || result?.ok === false) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || '未能更新权限，请重试');
        saving = false; sync();
        if (read().mode?.value === mode) close(true);
        else notify('权限尚未变更，请稍后重试');
      } catch (error) { if (!disposed) notify(error?.message || '未能更新权限，请重试'); }
      finally { saving = false; if (!disposed) sync(); }
    }
    async function open(which = 'selected') {
      if (disposed || preparing || saving || read().disabled) return;
      if (popup) { close(true); return; }
      const own = ++generation; preparing = true; updateButton(read());
      try { if (typeof beforeOpen === 'function') await beforeOpen(); }
      catch (_) { if (!disposed && own === generation) notify('暂时无法加载权限设置，请重试'); return; }
      finally { if (!disposed && own === generation) { preparing = false; updateButton(read()); } }
      if (disposed || own !== generation || read().disabled) return;
      popup = node('div', 'rpc-popover'); popup.id = id; popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', '工具权限');
      for (const mode of MODES) {
        const option = node('button', 'rpc-option'); option.type = 'button'; option.dataset.permissionOption = mode.value; option.setAttribute('role', 'menuitemradio'); option.tabIndex = -1;
        const symbol = node('span', 'rpc-option-icon'); symbol.innerHTML = icon(mode.icon);
        const copy = node('span', 'rpc-option-copy'); copy.append(node('span', 'rpc-option-label', mode.label), node('span', 'rpc-option-description', mode.description));
        const check = node('span', 'rpc-option-check'); check.innerHTML = icon('check');
        option.append(symbol, copy, check); option.addEventListener('click', () => select(mode.value)); popup.append(option);
      }
      doc.body.append(popup); button.setAttribute('aria-expanded', 'true'); sync(); position();
      if (!popup) return;
      popup.classList.add('is-open'); focusOption(which);
      if (typeof win.ResizeObserver === 'function') {
        observer = new win.ResizeObserver(schedulePosition);
        let parent = button; for (let count = 0; parent && count < 4; count++, parent = parent.parentElement) observer.observe(parent);
        observer.observe(popup);
      }
    }
    const click = () => open();
    const triggerKeys = event => { if (!event.isComposing && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(event.key === 'ArrowUp' ? 'last' : 'first'); } };
    const outside = event => { if ((popup || preparing) && !button.contains(event.target) && !popup?.contains(event.target)) close(); };
    const keys = event => {
      if ((!popup && !preparing) || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(true); return; }
      if (!popup) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !popup.contains(doc.activeElement)) return;
      event.preventDefault();
      const options = [...popup.querySelectorAll('[data-permission-option]:not(:disabled)')]; if (!options.length) return;
      const index = options.indexOf(doc.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next].focus({ preventScroll: true }); options[next].scrollIntoView({ block: 'nearest' });
    };
    button.addEventListener('click', click); button.addEventListener('keydown', triggerKeys);
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keys, true); doc.addEventListener('scroll', schedulePosition, true);
    win.addEventListener('resize', schedulePosition); win.visualViewport?.addEventListener('resize', schedulePosition); win.visualViewport?.addEventListener('scroll', schedulePosition);
    const manager = { sync, close: () => close(), destroy() { if (disposed) return; close(); disposed = true; generation++; button.removeEventListener('click', click); button.removeEventListener('keydown', triggerKeys); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', keys, true); doc.removeEventListener('scroll', schedulePosition, true); win.removeEventListener('resize', schedulePosition); win.visualViewport?.removeEventListener('resize', schedulePosition); win.visualViewport?.removeEventListener('scroll', schedulePosition); if (button._relayPermissionControls === manager) delete button._relayPermissionControls; } };
    button._relayPermissionControls = manager; sync(); return manager;
  }
  return { MODES, permissionState, placePopover, create };
});
