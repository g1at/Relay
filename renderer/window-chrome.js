(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RelayWindowChrome = api;
    const mount = () => {
      const host = root.document.getElementById('windowChrome');
      if (host) root.relayWindowChrome = api.create({ window: root, host });
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const instances = new WeakMap();

  function create({ window: win, host }) {
    if (instances.has(host)) return instances.get(host);
    const root = win.document.documentElement;
    const bridge = win.api && win.api.windowChrome;
    const overlay = !!(bridge && bridge.overlay);
    const controls = win.navigator && win.navigator.windowControlsOverlay;
    const listeners = [];
    let lastTheme = null;
    let searchOpen = false;
    let disposed = false;
    const on = (target, name, handler) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(name, handler);
      listeners.push(() => target.removeEventListener(name, handler));
    };
    root.setAttribute('data-window-chrome', overlay ? 'overlay' : 'native');

    function syncTheme() {
      if (disposed) return;
      const current = root.getAttribute('data-theme');
      const theme = current === 'dark' || current === 'light' ? current
        : bridge && bridge.initialTheme === 'dark' ? 'dark' : 'light';
      root.setAttribute('data-window-chrome-theme', theme);
      root.setAttribute('data-window-chrome-dimmed', String(searchOpen));
      const appearance = `${theme}:${searchOpen}`;
      if (appearance === lastTheme) return;
      lastTheme = appearance;
      if (overlay && typeof bridge.setTheme === 'function') {
        try { bridge.setTheme(theme, searchOpen); } catch (_) {}
      }
    }

    function syncGeometry() {
      if (disposed) return;
      let left = 0;
      let right = overlay ? 144 : 0;
      if (overlay && controls) {
        try {
          if (controls.visible === false) right = 0;
          else {
            const rect = controls.getTitlebarAreaRect();
            if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.width) && rect.width > 0) {
              left = Math.max(0, Math.ceil(rect.x));
              right = Math.max(0, Math.ceil(win.innerWidth - rect.x - rect.width));
            }
          }
        } catch (_) { /* Keep the safe caption-button fallback until geometry is available. */ }
      }
      host.style.setProperty('--relay-window-controls-left', `${left}px`);
      host.style.setProperty('--relay-window-controls-right', `${right}px`);
    }

    const observer = new win.MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    on(controls, 'geometrychange', syncGeometry);
    on(win, 'resize', syncGeometry);
    const api = {
      sync() { syncTheme(); syncGeometry(); },
      setSearchOpen(value) {
        if (disposed || typeof value !== 'boolean') return;
        searchOpen = value;
        syncTheme();
      },
      dispose() {
        if (disposed) return;
        if (searchOpen) { searchOpen = false; syncTheme(); }
        disposed = true;
        observer.disconnect();
        for (const remove of listeners) remove();
        instances.delete(host);
      },
    };
    on(win, 'pagehide', api.dispose);
    instances.set(host, api);
    api.sync();
    return api;
  }

  return { create };
}));
