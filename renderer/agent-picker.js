(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayAgentPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeAgents(value) {
    const list = Array.isArray(value) ? value : value && value.items;
    const names = new Set();
    return (Array.isArray(list) ? list : []).filter(item => {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || names.has(item.name)) return false;
      names.add(item.name); return true;
    }).map(item => ({ ...item, displayName: String(item.displayName || item.name), description: String(item.desc || item.description || '') }));
  }

  function selectionState(agents, selected) {
    const items = agents.filter(item => selected.has(item.name));
    return {
      items,
      mode: items.length > 1 ? 'orchestrate' : items.length === 1 ? 'agent' : null,
      label: items.length > 1 ? `开始协奏 · ${items.length}` : '开始对话',
      hint: items.length > 1 ? `已选 ${items.length} 个 Agent，将协作完成任务` : items.length === 1 ? `由 ${items[0].displayName} 为你完成任务` : '选择一个 Agent 对话，选择多个 Agent 协奏',
    };
  }

  function create(options = {}) {
    const doc = options.document || document;
    const win = options.window || doc.defaultView;
    let overlay = null, origin = null, generation = 0, disposed = false;
    const node = (tag, className, text) => {
      const el = doc.createElement(tag); el.className = className || '';
      if (text !== undefined) el.textContent = text;
      return el;
    };
    function close(restore = true) {
      generation++;
      if (!overlay) return;
      overlay.remove(); overlay = null;
      if (restore) {
        for (const target of [origin, doc.getElementById('btnNewAnalysis'), doc.getElementById('btnToggleSidebar')]) {
          if (!target || target === doc.body || target === doc.documentElement || !target.isConnected || target.closest('[inert],[hidden]') || !target.getClientRects().length) continue;
          target.focus({ preventScroll: true });
          if (doc.activeElement === target) break;
        }
      }
    }
    function open() {
      if (disposed) return;
      if (overlay) { overlay.querySelector('input').focus(); return; }
      origin = doc.activeElement;
      const surface = node('div', 'agent-picker-overlay agent-selection-overlay show');
      overlay = surface;
      const dialog = node('section', 'agent-selection-dialog');
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'agentSelectionTitle');
      dialog.setAttribute('aria-describedby', 'agentSelectionDescription');
      const header = node('header', 'agent-selection-header');
      const heading = node('div');
      const title = node('h2', '', '选择 Agent'); title.id = 'agentSelectionTitle';
      const description = node('p', '', '单独对话，或组队协作。'); description.id = 'agentSelectionDescription';
      heading.append(title, description);
      const cancel = node('button', 'btn-icon agent-selection-close'); cancel.type = 'button';
      cancel.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      cancel.setAttribute('aria-label', '关闭 Agent 选择'); cancel.title = '关闭';
      cancel.addEventListener('click', () => close()); header.append(heading, cancel);
      const searchBox = node('label', 'agent-selection-search');
      const searchIcon = node('span'); searchIcon.setAttribute('aria-hidden', 'true');
      searchIcon.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
      const search = node('input'); search.type = 'search'; search.placeholder = '搜索 Agent';
      search.setAttribute('aria-label', '搜索 Agent'); search.autocomplete = 'off';
      searchBox.append(searchIcon, search);
      const list = node('div', 'agent-selection-list'); list.setAttribute('aria-label', '已安装的 Agent');
      const status = node('div', 'agent-selection-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const footer = node('footer', 'agent-selection-footer');
      const manage = node('button', 'btn-ghost agent-selection-manage', '管理 Agent'); manage.type = 'button';
      const start = node('button', 'btn-primary agent-selection-start', '开始对话'); start.type = 'button'; start.disabled = true;
      manage.addEventListener('click', () => { close(false); if (options.onManage) options.onManage(); });
      footer.append(manage, start); dialog.append(header, searchBox, list, status, footer); surface.append(dialog); doc.body.append(surface);
      let agents = [], loading = false, loaded = false, selected = new Set();
      function update() {
        const state = selectionState(agents, selected);
        start.disabled = loading || !state.items.length;
        start.textContent = state.label;
        if (!loading) status.textContent = state.hint;
      }
      function render() {
        list.replaceChildren();
        const query = search.value.trim().toLocaleLowerCase();
        const shown = agents.filter(item => `${item.displayName} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query));
        for (const item of shown) {
          const row = node('label', 'agent-selection-item'); row.dataset.agent = item.name;
          const check = node('input', 'agent-selection-checkbox'); check.type = 'checkbox'; check.checked = selected.has(item.name);
          check.setAttribute('aria-label', item.displayName);
          const avatar = node('span', 'agent-selection-avatar'); avatar.setAttribute('aria-hidden', 'true');
          if (win.AgentAvatar) { const img = node('img'); img.src = win.AgentAvatar.dataUri(item.name); img.alt = ''; avatar.append(img); }
          else avatar.textContent = Array.from(item.displayName)[0];
          const details = node('span', 'agent-selection-details');
          details.append(node('span', 'agent-selection-name', item.displayName));
          details.append(node('span', 'agent-selection-description', item.description || item.name));
          const mark = node('span', 'agent-selection-check', '✓'); mark.setAttribute('aria-hidden', 'true');
          check.addEventListener('change', () => {
            if (check.checked) selected.add(item.name); else selected.delete(item.name);
            row.classList.toggle('is-selected', check.checked); update();
          });
          row.classList.toggle('is-selected', check.checked); row.append(check, avatar, details, mark); list.append(row);
        }
        if (!shown.length) {
          const empty = node('div', 'agent-selection-empty');
          empty.append(node('strong', '', agents.length ? '没有找到匹配的 Agent' : '还没有安装 Agent'));
          empty.append(node('p', '', agents.length ? '试试其他关键词，已选的 Agent 会保留。' : '前往插件页面，添加你的第一个 Agent。'));
          list.append(empty);
        }
        update();
      }
      async function load() {
        const token = ++generation; loading = true; loaded = false; start.disabled = true;
        list.replaceChildren(node('div', 'agent-selection-empty', '正在加载 Agent…')); status.textContent = '';
        list.setAttribute('aria-busy', 'true');
        try {
          const result = await options.loadAgents();
          if (disposed || token !== generation || overlay !== surface) return;
          if (result && result.ok === false) throw Error('load failed');
          agents = normalizeAgents(result); loading = false; loaded = true; list.removeAttribute('aria-busy'); render();
        } catch (_) {
          if (disposed || token !== generation || overlay !== surface) return;
          loading = false; list.removeAttribute('aria-busy');
          const empty = node('div', 'agent-selection-empty');
          empty.append(node('strong', '', 'Agent 加载失败'), node('p', '', '请重试，或前往插件页面检查。'));
          const retry = node('button', 'btn-ghost', '重新加载'); retry.type = 'button'; retry.addEventListener('click', load);
          empty.append(retry); list.replaceChildren(empty); status.textContent = '暂时无法读取已安装的 Agent';
        }
      }
      search.addEventListener('input', () => { if (loaded) render(); });
      start.addEventListener('click', () => {
        const state = selectionState(agents, selected);
        if (loading || !state.items.length) return;
        close(false); if (options.onStart) options.onStart(state.items);
      });
      surface.addEventListener('click', event => { if (event.target === surface) close(); });
      surface.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== 'Tab') return;
        const stops = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter(el => el.getClientRects().length);
        const first = stops[0], last = stops.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      search.focus(); load();
    }
    return { open, close, destroy() { disposed = true; close(); } };
  }
  return { normalizeAgents, selectionState, create };
});
