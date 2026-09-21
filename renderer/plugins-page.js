(function (root) {
  'use strict';
  const categories = {
    package: { label: '插件包', description: '加载标准 SDK 插件，统一管理其中的技能、Agent、工具和运行钩子。', mount: 'sdkPluginSection' },
    skill: { label: '技能', description: '通过任务专用技能扩展 Relay 的能力。', mount: 'skillSection' },
    agent: { label: 'Agent', description: '管理专门的助手，为不同任务选择合适的 Agent。', mount: 'agentSection' },
    mcp: { label: 'MCP', description: '管理工具连接，查看服务状态与当前对话的连接情况。', mount: 'mcpSection' },
  };
  const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
  function create({ page, render, navigate, returnToConversation }) {
    if (!page) return null;
    if (page._relayPlugins) return page._relayPlugins;
    let selected = 'skill';
    const states = new Map();
    page.innerHTML = `
      <header class="workspace-header plugins-header">
        <div class="plugins-tabs" role="tablist" aria-label="插件类型">${Object.entries(categories).map(([id, c]) => `<button id="pluginsTab-${id}" type="button" role="tab" data-plugin-tab="${id}" aria-controls="pluginsCategory-${id}" aria-selected="false" tabindex="-1">${c.label}</button>`).join('')}</div>
        <div class="plugins-header-actions"><button id="pluginsRefresh" class="btn-icon" type="button" aria-label="刷新插件列表" title="刷新"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.34 5.66"/></svg></button><button class="workspace-return btn-ghost" type="button" id="pluginsReturn">返回对话</button></div>
      </header>
      <div class="workspace-page-body plugins-body">${Object.entries(categories).map(([id, c]) => `
        <section id="pluginsCategory-${id}" class="plugins-category" role="tabpanel" aria-labelledby="pluginsTab-${id}" hidden>
          <div class="plugins-overview">
            <div class="plugins-intro"><div class="plugins-intro-heading"><h1>${c.label}</h1><p>${c.description}</p></div><div class="plugins-intro-actions"></div></div>
            <label class="plugins-search">${searchIcon}<input type="search" aria-label="搜索${c.label}" placeholder="搜索${c.label}" autocomplete="off" data-plugin-search="${id}"></label>
            <div class="plugins-panel" id="${c.mount}"></div>
            <p class="plugins-search-empty" hidden>没有匹配的内容，试试其他关键词。</p>
          </div>
          <section class="plugins-detail" hidden aria-label="${c.label}详情"><div class="plugins-detail-body"></div><footer class="plugins-detail-footer"><button class="btn-ghost" type="button" data-detail-back>返回</button><span role="status" data-detail-hint></span><button class="btn-primary" type="button" data-detail-save hidden>保存</button></footer></section>
        </section>`).join('')}
      </div>`;
    const refresh = page.querySelector('#pluginsRefresh');
    const tabs = [...page.querySelectorAll('[data-plugin-tab]')];
    const body = page.querySelector('.plugins-body');
    for (const [id, category] of Object.entries(categories)) {
      const section = page.querySelector(`#pluginsCategory-${id}`);
      const state = { id, section, mount: section.querySelector('.plugins-panel'), query: '', status: 'idle', promise: null, manager: null, observer: null, scroll: 0, detail: null, skillView: 'library', skillFilter: 'all' };
      states.set(id, state);
      section.querySelector('input').addEventListener('input', event => { state.query = event.target.value; filter(state); });
    }
    function filter(state) {
      const query = state.query.trim().toLocaleLowerCase();
      if (state.id === 'skill') syncSkillView(state);
      const selector = state.id === 'skill' && state.skillView === 'updates'
        ? '[data-skill-group]'
        : state.id === 'skill' && state.skillFilter === 'archived'
          ? '[data-arch-list] > .dp-item' : '[data-list] > .dp-item:not(.skill-list-skeleton)';
      const rows = [...state.mount.querySelectorAll(selector)];
      let matches = 0;
      for (const row of rows) {
        const text = [...row.querySelectorAll('.dp-item-name, .dp-item-desc, .skill-update-group-head h3')].map(el => el.textContent).join(' ').toLocaleLowerCase();
        const scopeMatches = state.id !== 'skill' || state.skillView !== 'library'
          || !['stale', 'protected'].includes(state.skillFilter)
          || (state.skillFilter === 'stale' ? row.classList.contains('skill-stale') : !!row.querySelector('.skill-badge.pin'));
        row.hidden = !scopeMatches || (!!query && !text.includes(query));
        if (!row.hidden) matches++;
      }
      const scoped = state.id === 'skill' && state.skillView === 'library' && state.skillFilter !== 'all';
      const empty = state.section.querySelector('.plugins-search-empty');
      empty.hidden = state.id === 'skill' && state.skillView === 'maintenance'
        || (!query && !scoped) || (!rows.length && !scoped) || matches > 0;
      empty.textContent = query ? '没有匹配的内容，试试其他关键词。'
        : state.skillFilter === 'archived' ? '没有已归档的技能。' : '这个筛选下还没有技能。';
    }
    function ensureSkillNavigation(state) {
      if (state.skillNavigation) return;
      const nav = document.createElement('div'); nav.className = 'plugins-skill-navigation';
      nav.innerHTML = `<div class="plugins-skill-views" role="tablist" aria-label="技能视图">
        <button type="button" role="tab" data-skill-view="library" aria-selected="true">我的技能</button>
        <button type="button" role="tab" data-skill-view="updates" aria-selected="false" tabindex="-1">待确认改进<span data-skill-update-badge hidden></span></button>
        <button type="button" role="tab" data-skill-view="maintenance" aria-selected="false" tabindex="-1">维护</button>
      </div><div class="plugins-skill-filter"><span class="sr-only" id="pluginsSkillFilterLabel">筛选技能</span>${root.buildCustomSelect('pluginsSkillFilter', [
        { value: 'all', label: '全部技能' }, { value: 'stale', label: '闲置' },
        { value: 'protected', label: '已保护' }, { value: 'archived', label: '已归档' },
      ], state.skillFilter)}</div>`;
      state.section.querySelector('.plugins-search').before(nav);
      state.skillNavigation = nav;
      const buttons = [...nav.querySelectorAll('[data-skill-view]')];
      const choose = value => { state.skillView = value; filter(state); };
      buttons.forEach((button, index) => {
        button.addEventListener('click', () => choose(button.dataset.skillView));
        button.addEventListener('keydown', event => {
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
          if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = buttons.length - 1;
          if (next == null) return;
          event.preventDefault(); buttons[next].focus(); choose(buttons[next].dataset.skillView);
        });
      });
      const picker = nav.querySelector('.custom-select');
      picker.dataset.skillFilter = '';
      root.bindCustomSelects(nav);
      const trigger = picker.querySelector('.cs-trigger');
      const popup = picker.querySelector('.cs-popup');
      const options = [...picker.querySelectorAll('.cs-option')];
      picker.querySelector('.cs-text').id = 'pluginsSkillFilterValue';
      trigger.setAttribute('role', 'button');
      trigger.setAttribute('aria-labelledby', 'pluginsSkillFilterLabel pluginsSkillFilterValue');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', 'pluginsSkillFilterOptions');
      popup.id = 'pluginsSkillFilterOptions';
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-labelledby', 'pluginsSkillFilterLabel');
      options.forEach(option => {
        option.tabIndex = -1;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(option.classList.contains('selected')));
        option.addEventListener('click', () => {
          state.skillFilter = picker.dataset.value;
          options.forEach(item => item.setAttribute('aria-selected', String(item === option)));
          trigger.focus({ preventScroll: true });
          filter(state);
        });
      });
      picker.addEventListener('keydown', event => {
        if (event.key === 'Tab') {
          if (!popup.hidden) { root.closeCustomSelect(); trigger.focus({ preventScroll: true }); }
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') {
          root.closeCustomSelect(); trigger.focus({ preventScroll: true }); return;
        }
        const index = options.indexOf(document.activeElement);
        if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
          options[index].click(); return;
        }
        if (popup.hidden) trigger.click();
        let next = index < 0 ? Math.max(0, options.findIndex(option => option.classList.contains('selected'))) : index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        else if (index >= 0 && event.key === 'ArrowDown') next = (index + 1) % options.length;
        else if (index >= 0 && event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
        options[next].focus({ preventScroll: true });
        root.revealCustomSelectOption(popup, options[next]);
      });
    }
    function syncSkillView(state) {
      ensureSkillNavigation(state);
      const library = state.skillView === 'library', archived = library && state.skillFilter === 'archived';
      for (const button of state.skillNavigation.querySelectorAll('[data-skill-view]')) {
        const active = button.dataset.skillView === state.skillView;
        button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      }
      const skillFilter = state.skillNavigation.querySelector('.plugins-skill-filter');
      if (!library && !skillFilter.querySelector('.cs-popup').hidden) root.closeCustomSelect();
      skillFilter.hidden = !library;
      state.section.querySelector('.plugins-search').hidden = state.skillView === 'maintenance';
      state.section.querySelector('.plugins-intro-actions').hidden = !library;
      const installed = state.mount.querySelector('[data-list]');
      const count = state.mount.querySelector('.set-toolbar');
      const updates = state.mount.querySelector('[data-draft-review]');
      const maintenance = state.mount.querySelector('.plugins-maintenance');
      const archive = state.mount.querySelector('[data-arch-wrap]');
      if (installed) installed.hidden = !library || archived;
      if (count) count.hidden = !library || archived;
      if (updates) updates.hidden = state.skillView !== 'updates';
      if (maintenance) maintenance.hidden = state.skillView !== 'maintenance';
      if (archive) {
        archive.hidden = !archived;
        const list = archive.querySelector('[data-arch-list]');
        if (list) list.hidden = !archived;
      }
      const pending = state.mount.querySelectorAll('[data-skill-group]').length;
      const badge = state.skillNavigation.querySelector('[data-skill-update-badge]');
      const label = String(pending);
      if (badge.textContent !== label) badge.textContent = label;
      badge.hidden = !pending;
    }
    function decorate(state) {
      // Move the existing controls, preserving their listeners and async updates.
      const heading = state.mount.querySelector('.skill-auto-head');
      const panel = state.mount.querySelector('.mem-auto-panel');
      if (heading && panel && !state.mount.querySelector('.plugins-maintenance')) {
        const maintenance = document.createElement('section'); maintenance.className = 'plugins-maintenance';
        maintenance.setAttribute('aria-label', '自动化与维护');
        maintenance.append(heading, panel); state.mount.append(maintenance);
      }
      filter(state);
    }
    function syncRefresh() {
      const state = states.get(selected);
      refresh.disabled = state.status === 'loading' || !!state.detail;
      refresh.setAttribute('aria-busy', String(state.status === 'loading'));
    }
    async function ensure(id, force = false) {
      const state = states.get(id);
      if (state.promise) return state.promise;
      if (state.status === 'ready' && !force) return true;
      state.status = 'loading'; syncRefresh();
      state.promise = (async () => {
        try {
          if (force && state.manager && typeof state.manager.refresh === 'function') await state.manager.refresh();
          else {
            state.manager = await render(id, state.mount);
            decorate(state);
            if (!state.observer) {
              state.observer = new MutationObserver(() => filter(state));
              state.observer.observe(state.mount, { childList: true, subtree: true, characterData: true });
            }
          }
          state.status = 'ready'; filter(state); return true;
        } catch (error) {
          state.status = 'error';
          // Replace a failed mount so late results owned by that instance cannot
          // overwrite a retry, while other tabs and their drafts stay mounted.
          if (state.observer) state.observer.disconnect();
          state.observer = null; state.manager = null;
          state.section.querySelector('.plugins-intro-actions').replaceChildren();
          const next = document.createElement('div'); next.id = categories[id].mount; next.className = 'plugins-panel';
          state.mount.replaceWith(next); state.mount = next;
          const box = document.createElement('div'); box.className = 'plugins-load-error'; box.setAttribute('role', 'status');
          const text = document.createElement('p'); text.textContent = `暂时无法加载${categories[id].label}：${error.message || '请稍后重试'}`;
          const retry = document.createElement('button'); retry.className = 'btn-ghost'; retry.type = 'button'; retry.textContent = '重试'; retry.addEventListener('click', () => ensure(id));
          box.append(text, retry); next.append(box); return false;
        } finally { state.promise = null; syncRefresh(); }
      })();
      return state.promise;
    }
    function select(id) {
      if (!categories[id]) id = selected;
      const old = states.get(selected); if (old) old.scroll = body.scrollTop;
      selected = id;
      for (const tab of tabs) {
        const active = tab.dataset.pluginTab === id;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      }
      for (const [key, state] of states) state.section.hidden = key !== id;
      body.scrollTop = states.get(id).scroll;
      syncRefresh(); void ensure(id, id === 'mcp' && states.get(id).status === 'ready');
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab.dataset.pluginTab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next == null) return;
        event.preventDefault(); tabs[next].focus(); select(tabs[next].dataset.pluginTab);
      });
    });
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const result = await window.api?.reloadClaudePlugins?.();
        if (result?.failed && typeof window.showToast === 'function') window.showToast('部分会话的插件刷新未完成，可稍后重试');
        await ensure(selected, true);
      } catch (_) {
        if (typeof window.showToast === 'function') window.showToast('插件刷新未完成，请稍后重试');
      } finally { syncRefresh(); }
    });
    page.querySelector('#pluginsReturn').addEventListener('click', returnToConversation);
    function beginDetail(kind) {
      const id = kind === 'agent' ? 'agent' : 'skill';
      const state = states.get(id);
      const overview = state.section.querySelector('.plugins-overview');
      const detail = state.section.querySelector('.plugins-detail');
      const detailBody = detail.querySelector('.plugins-detail-body');
      const hint = detail.querySelector('[data-detail-hint]');
      const save = detail.querySelector('[data-detail-save]');
      const back = detail.querySelector('[data-detail-back]');
      let saveHandler = null, backHandler = null, busy = false;
      const origin = document.activeElement;
      overview.hidden = true; detail.hidden = false; hint.textContent = ''; save.hidden = true;
      const context = {
        body: detailBody, hint, saveButton: save, prefix: `plugin-${id}-`,
        setSave(handler) { saveHandler = handler; },
        setBack(handler) { backHandler = handler; },
        back() {
          if (busy || state.detail !== context) return;
          state.detail = null; overview.hidden = false; detail.hidden = true;
          detailBody.replaceChildren(); saveHandler = null; backHandler = null;
          syncRefresh(); filter(state);
          if (origin && origin.isConnected && origin.getClientRects().length) origin.focus({ preventScroll: true });
        },
      };
      state.detail = context; syncRefresh();
      back.onclick = () => { if (!busy && backHandler) backHandler(); };
      save.onclick = async () => {
        if (busy || !saveHandler) return;
        busy = true; save.disabled = back.disabled = true;
        try { await saveHandler(); }
        catch (error) { if (state.detail === context) hint.textContent = `保存未完成：${error.message || '请重试'}`; }
        finally { busy = false; if (state.detail === context) save.disabled = back.disabled = false; }
      };
      return context;
    }
    const controller = {
      open(id) { navigate(); select(id); },
      beginDetail,
      getSelected: () => selected,
      refresh: () => ensure(selected, true),
    };
    page._relayPlugins = controller;
    return controller;
  }
  root.RelayPluginsPage = { create };
})(typeof window === 'undefined' ? globalThis : window);
