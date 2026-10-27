'use strict';

// Keep the real OS popup and production IPC callback. Tests choose a native
// MenuItem directly because webContents input cannot address an OS menu.
function createBrowserMenuProbe(electron) {
  let active = null;
  const Menu = {
    buildFromTemplate(template) {
      const menu = electron.Menu.buildFromTemplate(template);
      const popup = menu.popup.bind(menu);
      menu.popup = options => {
        const entry = { menu, window: options.window };
        active = entry;
        popup({ ...options, callback: (...args) => {
          if (active === entry) active = null;
          options.callback?.(...args);
        } });
      };
      return menu;
    },
  };
  function find(label, menu = active?.menu) {
    for (const item of menu?.items || []) {
      if (item.label === label) return item;
      const nested = item.submenu && find(label, item.submenu);
      if (nested) return nested;
    }
    return null;
  }
  function labels(menu = active?.menu) {
    return (menu?.items || []).flatMap(item => [item.label, ...(item.submenu ? labels(item.submenu) : [])]).filter(Boolean);
  }
  return {
    getElectron: () => ({ ...electron, Menu }),
    isOpen: () => !!active,
    has: label => !!find(label),
    labels,
    menu: () => active?.menu,
    select(label) {
      const entry = active, item = find(label);
      if (!entry || !item || !item.enabled || !item.visible || item.submenu) throw Error('Native menu action unavailable: ' + label);
      item.click(item, entry.window, {});
      entry.menu.closePopup(entry.window);
    },
    close() { if (active) active.menu.closePopup(active.window); },
  };
}

module.exports = { createBrowserMenuProbe };
