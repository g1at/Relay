(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayLocalFileLinks = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';
  const installed = new WeakMap();

  function parse(href) {
    if (typeof href !== 'string' || href.length > 16384) return null;
    let value = href.trim();
    if (!value || /[\u0000-\u001f\u007f]/.test(value) || /^[#?]/.test(value)) return null;
    if (/^file:/i.test(value)) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'file:' || url.username || url.password || url.port) return null;
        value = (url.hostname && url.hostname !== 'localhost' ? `\\\\${url.hostname}` : '') + url.pathname + url.hash;
        if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
      } catch (_) { return null; }
    // marked percent-encodes Windows backslashes in generated hrefs. Admit only
    // an encoded drive separator here; decode once below, then recheck schemes.
    // Decoding the whole URL earlier would reinterpret encoded filename #/?.
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)
      && !/^[^:]+\.[^:]+:\d+(?::\d+)?$/.test(value)) return null;
    else if (value.startsWith('//') && !/^\/\/wsl(?:\.localhost|\$)\//i.test(value)) return null;
    let line = null;
    const suffix = /(?:#L(\d+)(?:C\d+)?|:(\d+)(?::\d+)?)$/.exec(value);
    if (suffix) { line = Number(suffix[1] || suffix[2]); value = value.slice(0, suffix.index); }
    else value = value.replace(/#[^#]*$/, '');
    if (value.includes('?')) return null;
    try { value = decodeURIComponent(value); } catch (_) { return null; }
    if (!value || /[\u0000-\u001f\u007f]/.test(value)
      || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)
      || line !== null && (!Number.isSafeInteger(line) || line < 1 || line > 10000000)) return null;
    return { path: value, line };
  }

  function install(container, initialOptions = {}) {
    if (!container?.ownerDocument) return null;
    if (installed.has(container)) { const current = installed.get(container); current.setOptions(initialOptions); current.decorate(); return current; }
    const document = container.ownerDocument, links = new WeakMap(), presentations = new WeakMap();
    let options = initialOptions, menu = null, menuAnchor = null;
    const value = item => typeof item === 'function' ? item() : item;
    function request(href) {
      const context = value(options.context) || root?.relayConversationWorkspace?.() || null;
      return { href, context: context ? { ...context } : null, ...(value(options.basePath) ? { basePath: value(options.basePath) } : {}) };
    }
    function report(error) { const message = error?.message || String(error || '无法打开此文件'); if (options.onError) options.onError(message); }
    function standalone(link, parsed) {
      if (parsed.line || options.cards === false || options.cards !== true && !link.closest('.message.assistant')) return false;
      const block = link.closest('p,h1,h2,h3,h4,h5,h6,li');
      if (!block || !container.contains(block)) return false;
      const onlyLink = node => node === link || (node.nodeType === 3 ? !node.textContent.trim()
        : node.nodeType === 1 && /^(P|H[1-6]|LI|STRONG|EM|SPAN|S|DEL)$/.test(node.tagName)
          && node.childNodes.length > 0 && [...node.childNodes].every(onlyLink));
      return onlyLink(block);
    }
    function restoreLink(link, record) {
      link.replaceChildren(...record.nodes.map(node => node.cloneNode(true)));
      link.classList.remove('relay-file-card');
      link.removeAttribute('aria-label');
    }
    function decorateLink(link) {
      if (link.closest('pre') || link.closest('code')) return;
      const attribute = link.getAttribute('href');
      const href = links.has(link) && attribute === '#' ? links.get(link) : attribute;
      const parsed = parse(href);
      let record = presentations.get(link);
      if (!parsed) {
        if (record) {
          restoreLink(link, record); links.delete(link); presentations.delete(link);
          link.classList.remove('relay-local-file-link'); link.removeAttribute('data-relay-file-link');
          if (record.title) link.title = record.title; else link.removeAttribute('title');
        }
        return;
      }
      if (!record) {
        record = { nodes: [...link.childNodes].map(node => node.cloneNode(true)), label: link.textContent.trim(), title: link.getAttribute('title'), key: null };
        presentations.set(link, record);
      }
      const card = standalone(link, parsed), key = JSON.stringify([href, card]);
      if (record.key === key) return;
      record.key = key;
      links.set(link, href);
      if (attribute !== '#') link.setAttribute('href', '#');
      link.setAttribute('data-relay-file-link', ''); link.classList.add('relay-local-file-link');
      link.title = `${parsed.path}${parsed.line ? `:${parsed.line}` : ''}`;
      restoreLink(link, record);
      const types = root?.relayWorkspaceFileTypes || root?.relayFileTypes;
      const directory = /[\\/]$/.test(parsed.path);
      const info = types?.describe?.(parsed.path, { directory }) || { label: '文件' };
      const icon = types?.createIcon?.(parsed.path, { directory, className: 'relay-local-file-icon' });
      if (!card) { if (icon) link.prepend(icon); return; }
      const parts = parsed.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
      const name = parts.pop() || record.label || parsed.path;
      const parent = parts.filter(Boolean).slice(-2).join(' / ');
      const alias = record.label && record.label !== name && !/[\\/]/.test(record.label) ? record.label : '';
      const span = (className, text) => { const node = document.createElement('span'); node.className = className; if (text) node.textContent = text; return node; };
      const badge = span('relay-file-card-icon'); if (icon) badge.append(icon);
      const content = span('relay-file-card-content');
      content.append(span('relay-file-card-name', name), span('relay-file-card-meta', [info.label === 'Markdown' ? 'Markdown 文档' : info.label, alias || parent].filter(Boolean).join(' · ')));
      const action = span('relay-file-card-action', directory ? '打开' : '预览'); action.setAttribute('aria-hidden', 'true');
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.setAttribute('viewBox', '0 0 16 16'); arrow.setAttribute('fill', 'none'); arrow.setAttribute('stroke', 'currentColor'); arrow.setAttribute('stroke-width', '1.5');
      arrow.innerHTML = '<path d="M3 8h10M9 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>';
      action.append(arrow); link.replaceChildren(badge, content, action); link.classList.add('relay-file-card');
      link.setAttribute('aria-label', `${directory ? '打开文件夹' : '预览文件'}：${name}${alias ? `，${alias}` : ''}`);
    }
    function decorateScope(node) {
      if (node.nodeType !== 1 || node.closest?.('.relay-file-card,.relay-local-file-icon') && !node.matches?.('a[href]')) return;
      if (node.matches?.('a[href]')) decorateLink(node);
      for (const link of node.querySelectorAll('a[href]')) decorateLink(link);
    }
    function decorate() {
      for (const link of container.querySelectorAll('a[href]')) decorateLink(link);
    }
    function selected(event) {
      const link = event.target?.closest?.('a');
      if (!link || !container.contains(link)) return null;
      if (!links.has(link)) decorateLink(link);
      return links.has(link) ? { link, href: links.get(link) } : null;
    }
    function closeMenu(restore = false) {
      menu?.remove(); menu = null;
      root?.relayWorkspacePanel?.setObscured('file-link-menu', false);
      if (restore) menuAnchor?.focus();
      menuAnchor = null;
    }
    async function activate(event) {
      if (event.type === 'auxclick' && event.button !== 1) return;
      const item = selected(event); if (!item) return;
      event.preventDefault(); event.stopImmediatePropagation();
      closeMenu();
      try {
        const input = request(item.href);
        const preview = options.preview || root?.relayWorkspacePanel?.openFileLink;
        if (typeof preview !== 'function') throw new Error('此窗口暂不支持文件预览，请在主窗口中打开。');
        const result = await preview(input);
        if (result?.ok === false) throw new Error(result.error || '无法打开此文件');
      } catch (error) { report(error); }
    }
    function showMenu(event) {
      const item = selected(event); if (!item) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeMenu();
      const input = request(item.href);
      menuAnchor = item.link;
      menu = document.createElement('div'); menu.className = 'relay-local-file-menu'; menu.setAttribute('role', 'menu');
      const actions = [['在本地打开', 'system'], ['在资源管理器中显示', 'reveal'], ['复制路径', 'copy']];
      for (const [label, target] of actions) {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label;
        button.addEventListener('click', async () => {
          closeMenu(true);
          try {
            const bridge = options.bridge || root?.api?.workspace;
            const result = target === 'copy' ? await bridge.resolveLink(input) : await bridge.openLink({ ...input, target });
            if (!result?.ok) throw new Error(result?.error || '无法打开此文件');
            if (target === 'copy') await (options.clipboard || root.navigator.clipboard).writeText(result.absolutePath);
          } catch (error) { report(error); }
        });
        menu.append(button);
      }
      document.body.append(menu);
      const rect = item.link.getBoundingClientRect(), x = event.clientX || rect.left, y = event.clientY || rect.bottom;
      menu.style.left = `${Math.max(8, Math.min(x, (root.innerWidth || 1000) - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, (root.innerHeight || 800) - menu.offsetHeight - 8))}px`;
      root?.relayWorkspacePanel?.setObscured('file-link-menu', true);
      menu.firstElementChild?.focus();
    }
    function key(event) {
      if (!menu) {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showMenu(event);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...menu.children], index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); event.stopPropagation(); buttons[next].focus();
    }
    function outside(event) { if (menu && !menu.contains(event.target) && !menuAnchor?.contains(event.target)) closeMenu(); }
    const contextChanged = () => closeMenu();
    container.addEventListener('click', activate, true); container.addEventListener('auxclick', activate, true);
    container.addEventListener('contextmenu', showMenu, true);
    document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', outside, true);
    root?.addEventListener('relay:conversation-changed', contextChanged);
    const observer = typeof root?.MutationObserver === 'function' ? new root.MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') { if (record.target.matches?.('a[href]')) decorateLink(record.target); }
        else for (const node of record.addedNodes) decorateScope(node);
        // A streamed paragraph can gain text after its link was inserted. Keep
        // that reference inline once it is no longer a standalone deliverable.
        const block = (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest?.('p,h1,h2,h3,h4,h5,h6,li');
        if (block && container.contains(block)) for (const link of block.querySelectorAll('a[data-relay-file-link]')) decorateLink(link);
      }
    }) : null;
    observer?.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
    const api = { decorate, setOptions(next) { options = next || {}; }, destroy() {
      closeMenu(); observer?.disconnect(); installed.delete(container);
      container.removeEventListener('click', activate, true); container.removeEventListener('auxclick', activate, true); container.removeEventListener('contextmenu', showMenu, true);
      document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside, true);
      root?.removeEventListener('relay:conversation-changed', contextChanged);
    } };
    installed.set(container, api); decorate(); return api;
  }
  return Object.freeze({ parse, install });
});
