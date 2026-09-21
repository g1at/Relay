(function (root) {
  'use strict';
  const pages = Object.freeze({ general: '浏览器设置', history: '历史记录', bookmarks: '书签', downloads: '下载',
    permissions: '网站权限', passwords: '密码管理器', contacts: '联系人信息', clear: '清理浏览数据' });
  const address = section => 'relay://browser/' + (section === 'general' ? 'settings' : section);
  function parse(value) {
    // Electron may treat an unregistered custom scheme as an opaque URL.
    // Match only our local routes; never interpret arbitrary authorities or paths.
    const match = /^relay:\/\/browser(?:\/([a-z]+))?\/?$/i.exec(String(value || '').trim());
    if (!match) return null;
    const key = (match[1] || 'settings').toLowerCase();
    return key === 'settings' ? 'general' : Object.hasOwn(pages, key) ? key : null;
  }

  function create({ mount, api, section = 'general', openUrl, onChange } = {}) {
    const doc = mount.ownerDocument, buttons = new Map();
    let current = null, active = false, destroyed = false;
    const shell = doc.createElement('div'); shell.className = 'browser-internal-page';
    const nav = doc.createElement('nav'); nav.className = 'browser-internal-nav'; nav.setAttribute('aria-label', '浏览器管理');
    const body = doc.createElement('div'); body.className = 'browser-internal-content';
    shell.append(nav, body); mount.append(shell);
    for (const [key, label] of Object.entries(pages)) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.browserInternalSection = key; button.addEventListener('click', () => navigate(key));
      nav.append(button); buttons.set(key, button);
    }
    function changed(value) {
      if (destroyed) return;
      current = value;
      for (const [key, button] of buttons) { if (key === value) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
      onChange?.(state());
    }
    const view = root.relayBrowserSettings.create({ mount: body, api, openUrl, hostView: 'chat', onNavigate: changed });
    function navigate(value) { if (!destroyed) view.show(Object.hasOwn(pages, value) ? value : 'general'); }
    function state() { return { section: current, title: pages[current], url: address(current) }; }
    const instance = { navigate, state, refresh: () => view.refresh(),
      setActive(value) {
        if (destroyed || active === value) return;
        active = value; shell.hidden = !value;
        if (!value) view.suspend(); else void view.refresh();
      },
      destroy() { if (destroyed) return; destroyed = true; view.destroy(); shell.remove(); },
    };
    navigate(section); shell.hidden = true; return instance;
  }
  root.RelayBrowserInternalPages = { pages, parse, address, create };
})(window);
