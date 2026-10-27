'use strict';

const MAX_ITEMS = 80, MAX_DEPTH = 3, MAX_LABEL = 256;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const failure = (code, error) => ({ ok: false, code, error });

// This bridge only returns a selected identifier to the trusted app renderer.
// Electron roles, accelerators and executable callbacks never come from IPC.
function createBrowserChromeMenu({ getWindow, getElectron = () => require('electron') }) {
  let active = null, disposed = false;

  function current(pending) {
    const owner = pending.owner, contents = pending.contents;
    return !disposed && active === pending && getWindow() === owner
      && !owner.isDestroyed() && owner.webContents === contents && !contents.isDestroyed()
      && owner.isVisible?.() !== false && owner.isMinimized?.() !== true;
  }
  function finish(pending, selectedId = null, error = null) {
    if (pending.finished) return;
    pending.finished = true;
    if (active === pending) active = null;
    for (const [target, event, listener] of pending.listeners) target.removeListener(event, listener);
    pending.listeners.length = 0;
    if (pending.completion) clearImmediate(pending.completion);
    pending.resolve(error || { ok: true, requestId: pending.requestId, selectedId });
  }
  function cancel(pending = active) {
    if (!pending || pending.finished) return;
    // Invalidate before closing: a late native click/callback cannot select an
    // item from the cancelled popup or finish its replacement.
    finish(pending);
    try { pending.menu.closePopup(pending.owner); } catch (_) { /* Owner may already be gone. */ }
  }
  function close(requestId) {
    if (active?.requestId === requestId) cancel();
    return { ok: true };
  }
  function templateFor(items, pending) {
    let count = 0;
    const ids = new Set();
    function convert(list, depth, parentEnabled = true) {
      if (!Array.isArray(list) || !list.length || depth > MAX_DEPTH) throw new TypeError('Invalid menu items');
      return list.map(item => {
        if (++count > MAX_ITEMS || !item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid menu item');
        if (item.type === 'separator') return { type: 'separator' };
        if (item.type != null && item.type !== 'normal') throw new TypeError('Invalid menu type');
        if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(item.label)) throw new TypeError('Invalid menu label');
        if (item.enabled != null && typeof item.enabled !== 'boolean') throw new TypeError('Invalid menu enabled state');
        if (item.id != null) {
          if (!validId(item.id) || ids.has(item.id)) throw new TypeError('Invalid menu identifier');
          ids.add(item.id);
        }
        const enabled = parentEnabled && item.enabled !== false;
        const nativeItem = { label: item.label, enabled };
        if (item.submenu != null) nativeItem.submenu = convert(item.submenu, depth + 1, enabled);
        else if (item.id != null) {
          nativeItem.click = () => {
            if (enabled && current(pending) && pending.selectedId == null) pending.selectedId = item.id;
          };
        } else nativeItem.enabled = false;
        return nativeItem;
      });
    }
    return convert(items, 1);
  }
  function listen(pending, target, event, listener) {
    target.on(event, listener);
    pending.listeners.push([target, event, listener]);
  }
  function popup(input) {
    if (disposed) return Promise.resolve(failure('BROWSER_CLOSED', '浏览器窗口已关闭'));
    if (!validId(input?.requestId) || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return Promise.resolve(failure('INVALID_MENU', '浏览器菜单无效'));
    }
    const owner = getWindow(), contents = owner?.webContents;
    if (!owner || owner.isDestroyed() || !contents || contents.isDestroyed()
      || owner.isVisible?.() === false || owner.isMinimized?.() === true) {
      return Promise.resolve(failure('BROWSER_CLOSED', '浏览器窗口尚未就绪'));
    }
    const pending = { owner, contents, requestId: input.requestId, selectedId: null, listeners: [], finished: false };
    let template, x, y;
    try {
      template = templateFor(input.items, pending);
      const bounds = owner.getContentBounds(), zoom = contents.getZoomFactor();
      if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
        || bounds.width < 1 || bounds.height < 1) throw new TypeError('Invalid menu bounds');
      x = Math.round(Math.max(0, Math.min(bounds.width - 1, input.x * zoom)));
      y = Math.round(Math.max(0, Math.min(bounds.height - 1, input.y * zoom)));
    } catch (_) { return Promise.resolve(failure('INVALID_MENU', '浏览器菜单无效')); }
    try {
      const Menu = getElectron().Menu;
      if (!Menu?.buildFromTemplate) throw new TypeError('Menu unavailable');
      pending.menu = Menu.buildFromTemplate(template);
    }
    catch (_) { return Promise.resolve(failure('MENU_UNAVAILABLE', '浏览器菜单暂不可用')); }
    cancel();
    const result = new Promise(resolve => { pending.resolve = resolve; });
    active = pending;
    const dismissed = () => cancel(pending);
    try {
      for (const event of ['hide', 'minimize', 'close', 'closed']) listen(pending, owner, event, dismissed);
      for (const event of ['destroyed', 'render-process-gone']) listen(pending, contents, event, dismissed);
      listen(pending, contents, 'did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame !== false) dismissed();
      });
      pending.menu.popup({ window: owner, x, y, callback: () => {
        // Some Electron platforms notify closure before dispatching the item
        // click in the same turn. Wait one turn, then deliver the final choice.
        if (pending.finished || pending.completion) return;
        pending.completion = setImmediate(() => finish(pending, current(pending) ? pending.selectedId : null));
      } });
    } catch (_) {
      finish(pending, null, failure('MENU_UNAVAILABLE', '浏览器菜单暂不可用'));
      try { pending.menu.closePopup(pending.owner); } catch (_) { /* Failed popup needs no further cleanup. */ }
    }
    return result;
  }
  return { popup, close, dispose() { if (disposed) return; disposed = true; cancel(); } };
}

module.exports = { createBrowserChromeMenu };
