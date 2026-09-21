(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayMcpPermissionControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  let sequence = 0;
  const OPTIONS = Object.freeze([{ value: 'follow', label: '跟随会话' }, { value: 'default', label: '始终请求批准' }]);
  function create({ mount, name, mode = null, onChange, notify = () => {} }) {
    if (!mount || typeof onChange !== 'function' || typeof root.buildCustomSelect !== 'function') throw TypeError('MCP 审批选择缺少挂载点或接口');
    const doc = mount.ownerDocument, host = doc.createElement('div');
    host.innerHTML = root.buildCustomSelect(`mcp-permission-${++sequence}`, OPTIONS, mode === 'default' ? 'default' : 'follow');
    const wrapper = host.firstElementChild, previous = wrapper.querySelector('.cs-trigger'), trigger = doc.createElement('button');
    trigger.type = 'button'; trigger.className = 'cs-trigger'; trigger.innerHTML = previous.innerHTML; previous.replaceWith(trigger);
    trigger.setAttribute('aria-label', `${name} 的工具审批`); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const popup = wrapper.querySelector('.cs-popup'); popup.setAttribute('role', 'listbox');
    const items = [...popup.querySelectorAll('.cs-option')];
    let current = mode === 'default' ? 'default' : null, busy = false, disposed = false;
    const update = value => {
      current = value === 'default' ? 'default' : null;
      const selected = current || 'follow'; wrapper.dataset.value = selected;
      trigger.querySelector('.cs-text').textContent = OPTIONS.find(item => item.value === selected).label;
      trigger.title = current ? '每次使用此工具都请你确认，会话的自动批准不会覆盖此设置' : '使用当前会话的审批方式';
      items.forEach(item => { item.classList.toggle('selected', item.dataset.value === selected); item.setAttribute('aria-selected', String(item.dataset.value === selected)); });
    };
    items.forEach(item => {
      item.setAttribute('role', 'option'); item.tabIndex = -1;
      item.addEventListener('click', async event => {
        event.preventDefault(); event.stopImmediatePropagation(); root.closeCustomSelect?.();
        if (busy || disposed) return;
        const next = item.dataset.value === 'default' ? 'default' : null;
        if (next === current) return;
        busy = true; trigger.disabled = true;
        try {
          const result = await onChange({ name, mode: next });
          if (disposed) return;
          const authoritative = result?.items?.find(item => item.name === name);
          if (authoritative) update(authoritative.mode);
          else if (result?.ok !== false) update(next);
          if (result?.ok === false) notify(authoritative ? '审批设置已保存，部分对话需重新连接后继续' : result.message || '审批设置未能保存');
        } catch (_) { if (!disposed) notify('审批设置未能保存，请稍后重试'); }
        finally { busy = false; if (!disposed) trigger.disabled = false; }
      }, true);
    });
    root.bindCustomSelects(host); wrapper.classList.replace('custom-select', 'rmp-permission-picker');
    wrapper.addEventListener('keydown', event => {
      if (event.isComposing || busy) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation(); if (popup.hidden) trigger.click();
        const index = items.indexOf(doc.activeElement), delta = event.key === 'ArrowDown' ? 1 : -1;
        items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length].focus({ preventScroll: true });
      } else if ((event.key === 'Enter' || event.key === ' ') && popup.contains(doc.activeElement)) {
        event.preventDefault(); event.stopPropagation(); doc.activeElement.click();
      } else if (event.key === 'Escape') { root.closeCustomSelect?.(); trigger.focus({ preventScroll: true }); }
    });
    mount.append(wrapper); update(current);
    return { setMode: update, destroy() { disposed = true; if (!popup.hidden) root.closeCustomSelect?.(); wrapper.remove(); } };
  }
  return { create, OPTIONS };
});
