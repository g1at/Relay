(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.relayBrowserSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const SECTIONS = { general: '浏览器', history: '浏览历史', bookmarks: '书签', clear: '清理浏览数据', downloads: '下载记录', permissions: '站点权限', passwords: '密码管理器', contacts: '联系人信息' };
  const PERMISSIONS = { camera: '相机', microphone: '麦克风', location: '位置', notifications: '通知', clipboard: '剪贴板' };
  const DOWNLOAD_STATES = { progressing: '下载中', paused: '已暂停', completed: '已完成', cancelled: '已取消', interrupted: '已中断' };
  const PAGE_SIZE = 50;
  let nextDropdownId = 0;
  let navigation = {};
  const isSection = value => Object.hasOwn(SECTIONS, value);
  const message = error => String(error?.error || error?.message || error || '操作失败，请重试');
  function result(value) { if (!value || value.ok === false) throw new Error(message(value)); return value; }
  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return Math.round(value) + ' B';
    const unit = value >= 1073741824 ? 1073741824 : value >= 1048576 ? 1048576 : 1024;
    return (value / unit).toFixed(1).replace(/\.0$/, '') + (unit === 1073741824 ? ' GB' : unit === 1048576 ? ' MB' : ' KB');
  }
  function formatDate(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function downloadActions(item) {
    const active = ['progressing', 'paused'].includes(item.state);
    return { pause: item.state === 'progressing', resume: ['paused', 'interrupted'].includes(item.state), cancel: active || (item.state === 'interrupted' && !!item.canResume), open: item.state === 'completed', showInFolder: item.state === 'completed', delete: !active };
  }
  async function routeLink({ api, workspace, url }) {
    const value = String(url || '').trim();
    if (/^mailto:/i.test(value)) return api.openExternal(value);
    const response = result(await api.browser.invoke({ action: 'openLink', url: value }));
    if (response.tab) {
      if (!workspace?.showBrowserTab) throw new Error('浏览器页面尚未就绪，请重试');
      await workspace.showBrowserTab(response.tab);
    }
    return response;
  }
  function create({ mount, api, openUrl, hostView = 'settings', onNavigate } = {}) {
    if (!mount || typeof api?.invoke !== 'function') throw new Error('浏览器设置尚未就绪');
    if (mount._relayBrowserSettings) return mount._relayBrowserSettings;
    const doc = mount.ownerDocument;
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ({ back: '<path d="m14 5-7 7 7 7"/>', refresh: '<path d="M20 7v5h-5M20 12a8 8 0 1 0-2.34 5.66"/>', open: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>', delete: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', folder: '<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>', plus: '<path d="M12 5v14M5 12h14"/>' })[name] + '</svg>';
    const page = element('section', 'relay-browser-settings'); page.setAttribute('aria-label', '浏览器设置');
    page.innerHTML = `<header class="rbs-heading"><div><button type="button" class="rbs-back" data-browser-back hidden>${icon('back')}浏览器</button><h2 data-browser-heading>浏览器</h2><p data-browser-subtitle>管理 Relay 内置浏览器。</p></div><button type="button" class="rbs-icon-button" data-browser-refresh title="刷新浏览器设置" aria-label="刷新浏览器设置">${icon('refresh')}</button></header>
      <div class="rbs-status" data-browser-status role="status" aria-live="polite">正在读取设置…</div>
      <div data-browser-general>
        <section class="rbs-section"><h3>常规</h3><div class="rbs-card">
          <div class="rbs-row"><div class="rbs-label"><strong>网络链接打开位置</strong><p>从对话中打开网页链接时使用</p></div><select class="rbs-select" data-browser-setting="webLinkTarget" aria-label="网络链接打开位置" disabled><option value="external">默认浏览器</option><option value="internal">Relay 内置浏览器</option></select></div>
          <div class="rbs-row"><div class="rbs-label"><strong>本地链接打开位置</strong><p>本机开发服务，例如 localhost</p></div><select class="rbs-select" data-browser-setting="localLinkTarget" aria-label="本地链接打开位置" disabled><option value="internal">Relay 内置浏览器</option><option value="external">默认浏览器</option></select></div>
          <div class="rbs-row"><div class="rbs-label"><strong>搜索引擎</strong><p>在浏览器地址栏中输入文字时使用</p></div><select class="rbs-select" data-browser-setting="searchEngine" aria-label="搜索引擎" disabled><option value="bing">Bing</option><option value="google">Google</option><option value="duckduckgo">DuckDuckGo</option></select></div>
          <div class="rbs-row"><div class="rbs-label"><strong>显示完整网址</strong><p>地址栏显示路径、查询参数和片段</p></div><button type="button" class="rbs-switch" data-browser-setting="showFullUrl" role="switch" aria-label="显示完整网址" aria-checked="false" disabled><span></span></button></div>
        </div></section>
        <section class="rbs-section"><h3>浏览数据</h3><div class="rbs-card">
          <div class="rbs-row"><div class="rbs-label"><strong>浏览历史</strong><p>查找和管理在 Relay 中访问过的网页</p></div><button type="button" class="rbs-button" data-browser-section="history">管理</button></div>
          <div class="rbs-row"><div class="rbs-label"><strong>书签</strong><p>保存常用网页，方便稍后打开</p></div><button type="button" class="rbs-button" data-browser-section="bookmarks">管理</button></div>
          <div class="rbs-row"><div class="rbs-label"><strong>清理浏览数据</strong><p>选择清理历史、网站数据、缓存或权限</p></div><button type="button" class="rbs-button" data-browser-section="clear">管理</button></div>
        </div></section>
        <section class="rbs-section"><h3>自动填充与密码</h3><div class="rbs-card">
          <div class="rbs-row"><div class="rbs-label"><strong>密码管理器</strong><p>管理已保存的网站账号和密码</p></div><button type="button" class="rbs-button" data-browser-section="passwords">管理</button></div>
          <div class="rbs-row"><div class="rbs-label"><strong>联系人信息</strong><p>管理用于填写表单的姓名、地址和联系方式</p></div><button type="button" class="rbs-button" data-browser-section="contacts">管理</button></div>
        </div></section>
        <section class="rbs-section"><h3>下载</h3><div class="rbs-card">
          <div class="rbs-row"><div class="rbs-label"><strong>保存位置</strong><p data-browser-download-directory>正在读取…</p></div><button type="button" class="rbs-button" data-browser-directory disabled>更改</button></div>
          <div class="rbs-row"><div class="rbs-label"><strong>下载前询问保存位置</strong><p>每次下载时选择文件保存位置</p></div><button type="button" class="rbs-switch" data-browser-setting="askDownloadLocation" role="switch" aria-label="下载前询问保存位置" aria-checked="false" disabled><span></span></button></div>
          <div class="rbs-row"><div class="rbs-label"><strong>下载记录</strong><p>查看进度，管理下载和已保存的文件</p></div><button type="button" class="rbs-button" data-browser-section="downloads">管理</button></div>
        </div></section>
        <section class="rbs-section"><h3>权限</h3><div class="rbs-card"><div class="rbs-row"><div class="rbs-label"><strong>站点权限</strong><p>管理网站对相机、麦克风、位置等功能的访问</p></div><button type="button" class="rbs-button" data-browser-section="permissions">管理</button></div></div></section>
      </div>
      <div class="rbs-clear" data-browser-clear-panel hidden>
        <section class="rbs-section" aria-label="选择要清理的数据"><h3>选择要清理的数据</h3><div class="rbs-card rbs-clear-options">
          <label class="rbs-row rbs-clear-option"><input type="checkbox" data-browser-clear="history" checked><span class="rbs-label"><strong>浏览历史</strong><span>在 Relay 中访问过的网页记录</span></span></label>
          <label class="rbs-row rbs-clear-option"><input type="checkbox" data-browser-clear="cache" checked><span class="rbs-label"><strong>缓存文件</strong><span>网页保存的图片和文件，下次访问时会重新加载</span></span></label>
          <label class="rbs-row rbs-clear-option"><input type="checkbox" data-browser-clear="cookies"><span class="rbs-label"><strong>Cookie 和网站数据</strong><span>清理后会退出网站登录，并移除网站的本地数据</span></span></label>
          <label class="rbs-row rbs-clear-option"><input type="checkbox" data-browser-clear="permissions"><span class="rbs-label"><strong>网站权限</strong><span>重置相机、麦克风、位置等访问权限，下次访问时重新询问</span></span></label>
        </div></section>
        <div class="rbs-clear-footer"><small>仅清理 Relay 内置浏览器；书签、保存的密码和已下载的文件会保留。</small><div class="rbs-clear-actions"><button type="button" class="rbs-button" data-browser-clear-cancel>重置选择</button><button type="button" class="rbs-button rbs-danger" data-browser-clear-submit>清理所选数据</button></div></div>
      </div>
      <div data-browser-forms hidden></div>
      <div data-browser-manager hidden><div class="rbs-list-toolbar"><input class="rbs-search" type="search" data-browser-search placeholder="搜索" aria-label="搜索记录" autocomplete="off"><button type="button" class="rbs-button" data-browser-add hidden>${icon('plus')}<span>添加</span></button></div>
        <form class="rbs-add-form" data-browser-add-form hidden><div class="rbs-form-fields" data-browser-form-fields></div><div class="rbs-form-actions"><button type="button" class="rbs-button" data-browser-add-cancel>取消</button><button type="submit" class="rbs-button" data-browser-add-save>保存</button></div></form>
        <div class="rbs-records" data-browser-records></div><div class="rbs-pagination"><span data-browser-total></span><div><button type="button" class="rbs-button" data-browser-previous>上一页</button><button type="button" class="rbs-button" data-browser-next>下一页</button></div></div>
      </div>`;
    mount.replaceChildren(page);
    const $ = selector => page.querySelector(selector);
    let section = 'general', settings = null, disposed = false, searching = null, eventTimer = null, formsView = null, navigationRevision = 0, clearStatus = '', clearError = false;
    page.dataset.browserSection = 'general';
    const formsSection = () => ['passwords', 'contacts'].includes(section);
    const listSection = () => ['history', 'bookmarks', 'downloads', 'permissions'].includes(section);
    const versions = new Map(), pending = new Set(), queries = new Map(), offsets = new Map(), cached = new Map(), rows = new Map(), dropdowns = new Map();
    const status = (text = '', error = false) => { if (disposed) return; $('[data-browser-status]').textContent = text; page.classList.toggle('has-error', error); };
    async function invoke(action, values = {}) { return result(await api.invoke({ action, ...values })); }
    function closePreferenceDropdowns() {
      if ([...dropdowns.values()].some(item => !item.popup.hidden)) root.closeCustomSelect();
    }
    function makePreferenceDropdown(select) {
      const key = select.dataset.browserSetting, options = [...select.options].map(option => ({ value: option.value, label: option.textContent }));
      const host = element('div'); host.innerHTML = root.buildCustomSelect('browserPreference-' + (++nextDropdownId), options, select.value);
      const wrapper = host.firstElementChild, original = wrapper.querySelector('.cs-trigger'), trigger = element('button', 'cs-trigger rbs-select');
      trigger.type = 'button'; trigger.innerHTML = original.innerHTML; trigger.dataset.browserSetting = key; trigger.value = select.value; trigger.disabled = true;
      trigger.setAttribute('aria-label', select.getAttribute('aria-label')); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); original.replaceWith(trigger);
      const popup = wrapper.querySelector('.cs-popup'), items = [...popup.querySelectorAll('.cs-option')];
      popup.id = wrapper.id + '-options'; popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', select.getAttribute('aria-label')); trigger.setAttribute('aria-controls', popup.id);
      for (const option of items) { option.tabIndex = -1; option.setAttribute('role', 'option'); }
      // Reuse the settings top-layer positioning and one-active-menu lifecycle.
      // Bind once before changing the wrapper class: the parent settings binder
      // must not attach a second optimistic selection handler when it runs later.
      root.bindCustomSelects(host); wrapper.classList.replace('custom-select', 'rbs-dropdown'); select.replaceWith(wrapper);
      const sync = () => {
        const selected = options.find(option => option.value === settings?.[key]) || options[0];
        wrapper.dataset.value = selected.value; trigger.value = selected.value; wrapper.querySelector('.cs-text').textContent = selected.label;
        for (const option of items) { const active = option.dataset.value === selected.value; option.classList.toggle('selected', active); option.setAttribute('aria-selected', String(active)); }
      };
      const focusOption = index => { const target = items[Math.max(0, Math.min(items.length - 1, index))]; target?.focus({ preventScroll: true }); if (target) root.revealCustomSelectOption(popup, target); };
      const choose = async value => {
        if (trigger.disabled || !options.some(option => option.value === value)) { sync(); return; }
        const ownNavigation = navigationRevision;
        root.closeCustomSelect();
        if (value !== settings?.[key]) await updateSettings({ [key]: value });
        if (!disposed && navigationRevision === ownNavigation && section === 'general' && trigger.isConnected && trigger.checkVisibility({ visibilityProperty: true }) && !trigger.disabled && (doc.activeElement === doc.body || wrapper.contains(doc.activeElement))) trigger.focus({ preventScroll: true });
      };
      for (const option of items) option.addEventListener('click', event => {
        // Only the confirmed settings response may update the visible choice.
        event.stopImmediatePropagation(); void choose(option.dataset.value);
      }, true);
      trigger.addEventListener('click', () => { if (!popup.hidden) focusOption(Math.max(0, items.findIndex(option => option.classList.contains('selected')))); });
      trigger.addEventListener('change', () => void choose(trigger.value));
      wrapper.addEventListener('keydown', event => {
        if (event.isComposing || trigger.disabled) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const wasClosed = popup.hidden; if (wasClosed) trigger.click(); if (popup.hidden) return;
          const current = Math.max(0, items.indexOf(doc.activeElement));
          focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : wasClosed ? current : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        } else if (['Enter', ' '].includes(event.key) && popup.contains(doc.activeElement)) {
          event.preventDefault(); event.stopPropagation(); doc.activeElement.click();
        }
      });
      dropdowns.set(trigger, { popup, sync });
    }
    for (const select of page.querySelectorAll('select[data-browser-setting]')) makePreferenceDropdown(select);
    function renderSettings() {
      if (!settings || pending.has('settings')) closePreferenceDropdowns();
      for (const control of page.querySelectorAll('[data-browser-setting]')) {
        const key = control.dataset.browserSetting; control.disabled = !settings || pending.has('settings');
        if (dropdowns.has(control)) dropdowns.get(control).sync();
        else control.setAttribute('aria-checked', String(settings?.[key] === true));
      }
      $('[data-browser-directory]').disabled = !settings || pending.has('settings');
      const directory = settings?.downloadDirectory || '系统下载文件夹'; $('[data-browser-download-directory]').textContent = settings ? directory : '正在读取…'; $('[data-browser-download-directory]').title = settings ? directory : '';
    }
    async function refreshSettings() {
      const version = (versions.get('settings') || 0) + 1, ownNavigation = navigationRevision; versions.set('settings', version);
      try { const response = await invoke('settings.get'); if (disposed || versions.get('settings') !== version) return; if (!response.settings) throw Error('没有收到浏览器设置'); settings = response.settings; renderSettings(); if (section === 'general' && navigationRevision === ownNavigation && !pending.size) status(); }
      catch (error) { if (!disposed && versions.get('settings') === version && section === 'general' && navigationRevision === ownNavigation) status(message(error), true); }
    }
    async function updateSettings(patch, choose = false) {
      if (!settings || pending.has('settings')) return;
      const ownSection = section, ownNavigation = navigationRevision;
      pending.add('settings'); renderSettings(); status('正在保存…');
      try {
        const response = await invoke(choose ? 'downloads.chooseDirectory' : 'settings.update', choose ? {} : { settings: patch });
        if (disposed) return;
        if (response.settings) { versions.set('settings', (versions.get('settings') || 0) + 1); settings = response.settings; }
        if (section === ownSection && navigationRevision === ownNavigation) status(response.canceled ? '' : '已保存');
      } catch (error) { if (!disposed && section === ownSection && navigationRevision === ownNavigation) status(message(error), true); }
      finally { pending.delete('settings'); if (!disposed) renderSettings(); }
    }
    for (const control of page.querySelectorAll('[data-browser-setting]')) {
      if (!dropdowns.has(control)) control.addEventListener('click', () => void updateSettings({ [control.dataset.browserSetting]: !settings?.[control.dataset.browserSetting] }));
    }
    $('[data-browser-directory]').addEventListener('click', () => void updateSettings(null, true));
    for (const button of page.querySelectorAll('[data-browser-section]')) button.addEventListener('click', () => show(button.dataset.browserSection));
    function resetClearSelection() {
      for (const input of page.querySelectorAll('[data-browser-clear]')) input.checked = false;
      syncClear();
    }
    $('[data-browser-clear-cancel]').addEventListener('click', resetClearSelection);
    const clearFlags = () => Object.fromEntries([...page.querySelectorAll('[data-browser-clear]')].map(input => [input.dataset.browserClear, input.checked]));
    function syncClear() {
      const busy = pending.has('clear');
      for (const input of page.querySelectorAll('[data-browser-clear]')) input.disabled = busy;
      $('[data-browser-clear-cancel]').disabled = busy || !Object.values(clearFlags()).some(Boolean);
      $('[data-browser-clear-submit]').disabled = busy || !Object.values(clearFlags()).some(Boolean);
      $('[data-browser-clear-submit]').textContent = busy ? '正在清理…' : '清理所选数据';
      $('[data-browser-clear-panel]').setAttribute('aria-busy', String(busy));
    }
    const showClearStatus = () => { if (section === 'clear') status(clearStatus, clearError); };
    for (const input of page.querySelectorAll('[data-browser-clear]')) input.addEventListener('change', () => { clearStatus = ''; clearError = false; syncClear(); showClearStatus(); });
    $('[data-browser-clear-submit]').addEventListener('click', async () => {
      const flags = clearFlags();
      if (section !== 'clear' || pending.has('clear') || !Object.values(flags).some(Boolean)) return;
      pending.add('clear'); clearStatus = '正在清理…'; clearError = false; syncClear(); showClearStatus();
      try { await invoke('data.clear', flags); if (!disposed) { cached.clear(); resetClearSelection(); clearStatus = '所选数据已清理'; if (listSection() && flags[section]) void refreshList(); } }
      catch (error) { if (!disposed) { clearStatus = message(error); clearError = true; } }
      finally { pending.delete('clear'); if (!disposed) { syncClear(); showClearStatus(); } }
    });
    function listKey() { return [section, queries.get(section) || '', offsets.get(section) || 0].join('\n'); }
    function permissionKey(item) { return item.origin + '\n' + item.permission; }
    function textDetail(item, kind) {
      if (kind === 'permissions') return PERMISSIONS[item.permission] || item.permission;
      if (kind !== 'downloads') return item.url || '';
      const received = formatBytes(item.receivedBytes), total = item.totalBytes > 0 ? ' / ' + formatBytes(item.totalBytes) : '';
      return (DOWNLOAD_STATES[item.state] || '未知状态') + (item.state === 'completed' ? ' · ' + (item.totalBytes > 0 ? formatBytes(item.totalBytes) : received) : ' · ' + received + total);
    }
    function actionButton(action, label, iconName, handler) {
      const button = element('button', iconName ? 'rbs-icon-button' : 'rbs-button', iconName ? null : label); button.type = 'button'; button.dataset.browserAction = action; button.title = label; button.setAttribute('aria-label', label); if (iconName) button.innerHTML = icon(iconName); button.addEventListener('click', handler); return button;
    }
    async function perform(item, action) {
      const kind = section, id = kind === 'permissions' ? permissionKey(item) : item.id, key = kind + ':' + id;
      if (pending.has(key)) return;
      pending.add(key); refreshRows(); status();
      try {
        if (action === 'open' && kind !== 'downloads') await openUrl(item.url);
        else if (kind === 'permissions') await invoke('permissions.remove', { origin: item.origin, permission: item.permission });
        else await invoke(kind + '.' + action, { recordId: item.id });
        if (!disposed && kind === section) { cached.delete(listKey()); await refreshList(); }
      } catch (error) { if (!disposed && kind === section) status(message(error), true); }
      finally { pending.delete(key); if (!disposed && kind === section) refreshRows(); }
    }
    function makeRow(kind, id) {
      const node = element('article', 'rbs-record'); node.dataset.browserRecord = id;
      const body = element('div', 'rbs-record-body'), title = element('strong', 'rbs-record-title'), detail = element('p', 'rbs-record-detail'), meta = element('small', 'rbs-record-meta');
      body.append(title, detail, meta); const actions = element('div', 'rbs-record-actions'); node.append(body, actions);
      const row = { node, title, detail, meta, actions, item: null, buttons: {} };
      if (kind === 'permissions') {
        const select = element('select', 'rbs-select'); select.dataset.browserPermissionDecision = '';
        for (const [value, label] of [['ask', '每次询问'], ['allow', '允许'], ['block', '阻止']]) { const option = element('option', '', label); option.value = value; select.append(option); }
        select.addEventListener('change', async () => {
          const item = row.item, decision = select.value, key = kind + ':' + id; if (pending.has(key)) return;
          pending.add(key); select.disabled = true;
          try { await invoke('permissions.set', { origin: item.origin, permission: item.permission, decision }); if (!disposed && section === kind) await refreshList(); }
          catch (error) { if (!disposed && section === kind) status(message(error), true); }
          finally { pending.delete(key); if (!disposed && section === kind) refreshRows(); }
        }); actions.append(select); row.select = select;
        row.buttons.delete = actionButton('delete', '恢复默认权限', 'delete', () => void perform(row.item, 'delete')); actions.append(row.buttons.delete);
      } else {
        const list = kind === 'downloads' ? [['pause', '暂停'], ['resume', '继续'], ['cancel', '取消'], ['open', '打开文件'], ['showInFolder', '显示文件', 'folder'], ['delete', '删除下载记录', 'delete']] : [['open', '打开网页', 'open'], ['delete', kind === 'history' ? '删除此条历史' : '删除书签', 'delete']];
        for (const [action, label, symbol] of list) { row.buttons[action] = actionButton(action, label, symbol, () => void perform(row.item, action)); actions.append(row.buttons[action]); }
        if (kind === 'downloads') { row.progress = element('progress', 'rbs-progress'); row.progress.max = 100; body.append(row.progress); }
      }
      return row;
    }
    function renderList(data) {
      const host = $('[data-browser-records]'), kind = section;
      if (!data) { if (!host.childElementCount) host.append(element('p', 'rbs-empty', '正在读取记录…')); return; }
      const validIds = new Set();
      data.items.forEach((item, index) => {
        const id = kind === 'permissions' ? permissionKey(item) : String(item.id), key = kind + ':' + id; validIds.add(key);
        let row = rows.get(key); if (!row) { row = makeRow(kind, id); rows.set(key, row); }
        row.item = item; row.title.textContent = kind === 'permissions' ? item.origin : kind === 'downloads' ? item.filename || '下载文件' : item.title || item.url; row.title.title = row.title.textContent;
        row.detail.textContent = textDetail(item, kind); row.detail.title = kind === 'downloads' ? item.path || item.url || '' : item.url || ''; row.meta.textContent = kind === 'downloads' && item.error ? item.error : kind === 'permissions' ? '' : formatDate(item.visitedAt || item.createdAt || item.startedAt);
        const busy = pending.has(key); row.node.classList.toggle('is-pending', busy);
        if (row.select) { row.select.value = item.decision; row.select.disabled = busy; row.select.setAttribute('aria-label', item.origin + ' · ' + (PERMISSIONS[item.permission] || item.permission)); }
        const available = kind === 'downloads' ? downloadActions(item) : null;
        for (const [action, button] of Object.entries(row.buttons)) { button.hidden = available ? !available[action] : false; button.disabled = busy || (action === 'resume' && !item.canResume); }
        if (row.progress) { row.progress.hidden = !['progressing', 'paused'].includes(item.state); if (item.totalBytes > 0 && Number.isFinite(item.receivedBytes)) row.progress.value = Math.max(0, Math.min(100, item.receivedBytes / item.totalBytes * 100)); else row.progress.removeAttribute('value'); row.progress.setAttribute('aria-label', '下载进度：' + (item.filename || '下载文件')); }
        if (host.children[index] !== row.node) host.insertBefore(row.node, host.children[index] || null);
      });
      for (const [key, row] of rows) if (!validIds.has(key)) { row.node.remove(); rows.delete(key); }
      for (const child of [...host.children]) if (!child.matches('.rbs-record')) child.remove();
      if (!data.items.length) host.append(element('p', 'rbs-empty', queries.get(kind) ? '没有匹配的记录' : ({ history: '还没有浏览历史', bookmarks: '还没有书签', downloads: '还没有下载记录', permissions: '还没有保存的网站权限' })[kind]));
      const offset = offsets.get(kind) || 0, total = Number.isFinite(data.total) ? data.total : data.items.length;
      $('[data-browser-total]').textContent = total ? `${offset + 1}–${Math.min(offset + data.items.length, total)} / ${total}` : '0 条记录';
      $('[data-browser-previous]').disabled = offset === 0; $('[data-browser-next]').disabled = offset + PAGE_SIZE >= total;
    }
    function refreshRows() { if (listSection()) renderList(cached.get(listKey())); }
    async function refreshList() {
      if (!listSection()) return;
      const kind = section, key = listKey(), query = queries.get(kind) || '', offset = offsets.get(kind) || 0;
      const version = (versions.get('list') || 0) + 1; versions.set('list', version);
      status(cached.has(key) ? '正在刷新…' : '正在读取记录…');
      try {
        const response = await invoke(kind + '.list', { query, offset, limit: PAGE_SIZE });
        if (disposed || versions.get('list') !== version || listKey() !== key) return;
        const items = Array.isArray(response.items) ? response.items : [];
        if (!items.length && offset && response.total < offset + 1) { offsets.set(kind, Math.max(0, Math.floor(Math.max(0, response.total - 1) / PAGE_SIZE) * PAGE_SIZE)); return refreshList(); }
        const data = { items, total: response.total }; cached.set(key, data); renderList(data); status();
      } catch (error) { if (!disposed && versions.get('list') === version && section === kind) status(message(error), true); }
    }
    function show(value = 'general') {
      closePreferenceDropdowns();
      if (disposed) return;
      navigationRevision++;
      formsView?.destroy(); formsView = null; $('[data-browser-forms]').replaceChildren(); clearTimeout(eventTimer); eventTimer = null;
      section = isSection(value) ? value : 'general'; versions.set('list', (versions.get('list') || 0) + 1); clearTimeout(searching); rows.clear(); $('[data-browser-records]').replaceChildren();
      $('[data-browser-refresh]').title = '刷新' + SECTIONS[section]; $('[data-browser-refresh]').setAttribute('aria-label', '刷新' + SECTIONS[section]);
      $('[data-browser-refresh]').hidden = section === 'clear';
      page.dataset.browserSection = section; $('[data-browser-heading]').textContent = SECTIONS[section]; $('[data-browser-subtitle]').textContent = section === 'general' ? '管理 Relay 内置浏览器。' : ({ history: '查找访问过的网页。', bookmarks: '收藏和整理常用网页。', clear: '按类别清理浏览器保存的数据。', downloads: '查看下载进度与已保存的文件。', permissions: '未保存的站点权限会在网站请求时询问。', passwords: '管理网站账号，按需填写登录表单。', contacts: '保存常用联系人信息，按需填写表单。' })[section];
      $('[data-browser-back]').hidden = section === 'general'; $('[data-browser-general]').hidden = section !== 'general'; $('[data-browser-manager]').hidden = !listSection(); $('[data-browser-forms]').hidden = !formsSection(); $('[data-browser-clear-panel]').hidden = section !== 'clear'; $('[data-browser-add-form]').hidden = true;
      $('[data-browser-add]').hidden = !['bookmarks', 'permissions'].includes(section); $('[data-browser-add] span').textContent = section === 'permissions' ? '添加网站' : '添加书签';
      $('[data-browser-search]').placeholder = section === 'permissions' ? '搜索网站' : '搜索'; $('[data-browser-search]').value = queries.get(section) || ''; $('[data-browser-search]').setAttribute('aria-label', '搜索' + SECTIONS[section]);
      status();
      if (formsSection()) mountForms();
      else if (section === 'clear') { syncClear(); showClearStatus(); }
      else if (section === 'general') { renderSettings(); void refreshSettings(); }
      else { renderList(cached.get(listKey())); void refreshList(); }
      onNavigate?.(section);
    }
    $('[data-browser-back]').addEventListener('click', () => show('general'));
    $('[data-browser-refresh]').addEventListener('click', () => refresh());
    $('[data-browser-search]').addEventListener('input', event => { queries.set(section, event.target.value.trim()); offsets.set(section, 0); status('正在搜索…'); clearTimeout(searching); searching = setTimeout(() => void refreshList(), 160); });
    for (const [selector, direction] of [['previous', -1], ['next', 1]]) $('[data-browser-' + selector + ']').addEventListener('click', () => { offsets.set(section, Math.max(0, (offsets.get(section) || 0) + direction * PAGE_SIZE)); void refreshList(); });
    function formField(label, key, values = null) {
      const wrapper = element('label', 'rbs-field'), text = element('span', '', label), control = element(values ? 'select' : 'input', values ? 'rbs-select' : 'rbs-input'); control.name = key;
      if (values) for (const [value, label] of values) { const option = element('option', '', label); option.value = value; control.append(option); }
      else { control.type = 'text'; control.maxLength = key === 'title' ? 250 : 2000; control.placeholder = key === 'title' ? '书签名称（可选）' : 'https://example.com'; control.required = key !== 'title'; control.autocomplete = 'off'; }
      wrapper.append(text, control); return wrapper;
    }
    $('[data-browser-add]').addEventListener('click', () => {
      const fields = $('[data-browser-form-fields]'); fields.replaceChildren();
      if (section === 'bookmarks') fields.append(formField('网址', 'url'), formField('名称', 'title'));
      else fields.append(formField('网站', 'origin'), formField('权限', 'permission', Object.entries(PERMISSIONS)), formField('处理方式', 'decision', [['ask', '每次询问'], ['allow', '允许'], ['block', '阻止']]));
      $('[data-browser-add-form]').hidden = false; fields.querySelector('input')?.focus();
    });
    $('[data-browser-add-cancel]').addEventListener('click', () => { $('[data-browser-add-form]').hidden = true; $('[data-browser-add]').focus(); });
    $('[data-browser-add-form]').addEventListener('submit', async event => {
      event.preventDefault(); if (pending.has('add')) return;
      const kind = section, form = event.target, values = Object.fromEntries(new FormData(form)); pending.add('add'); $('[data-browser-add-save]').disabled = true;
      try { await invoke(kind === 'bookmarks' ? 'bookmarks.add' : 'permissions.set', values); if (!disposed && section === kind) { form.hidden = true; status('已保存'); await refreshList(); } }
      catch (error) { if (!disposed && section === kind) status(message(error), true); }
      finally { pending.delete('add'); if (!disposed) $('[data-browser-add-save]').disabled = false; }
    });
    function mountForms() {
      if (!root.relayBrowserForms?.mount) { status('表单管理组件尚未就绪，请重新启动 Relay', true); return; }
      formsView = root.relayBrowserForms.mount($('[data-browser-forms]'), section);
    }
    function suspend() { navigationRevision++; closePreferenceDropdowns(); formsView?.destroy(); formsView = null; $('[data-browser-forms]').replaceChildren(); }
    function refresh() { if (disposed) return; if (formsSection()) { if (!formsView) mountForms(); else return formsView.refresh?.(); return; } if (section === 'clear') { syncClear(); showClearStatus(); return; } return section === 'general' ? refreshSettings() : refreshList(); }
    const viewChanged = event => { if (event.detail?.view !== hostView) suspend(); };
    root.addEventListener?.('relay:view-changed', viewChanged);
    const off = api.onEvent?.(event => {
      if (disposed || !['profile', 'download'].includes(event?.type)) return;
      const changedSection = event.type === 'download' ? 'downloads' : event.section;
      if (changedSection === 'settings') { void refreshSettings(); return; }
      for (const key of cached.keys()) if (key.startsWith(changedSection + '\n')) cached.delete(key);
      // Download progress arrives independently from profile writes. Throttle
      // without postponing an update indefinitely during a continuous transfer.
      if (changedSection === section && !formsSection() && !eventTimer) eventTimer = setTimeout(() => { eventTimer = null; void refreshList(); }, 120);
    });
    const instance = { show, refresh, suspend, destroy() { if (disposed) return; disposed = true; suspend(); root.removeEventListener?.('relay:view-changed', viewChanged); clearTimeout(searching); clearTimeout(eventTimer); off?.(); rows.clear(); cached.clear(); if (mount._relayBrowserSettings === instance) delete mount._relayBrowserSettings; } };
    mount._relayBrowserSettings = instance; renderSettings(); void refreshSettings(); return instance;
  }
  return {
    create, formatBytes, downloadActions, routeLink,
    configure(value = {}) { navigation = value; },
    open(section = 'general') { return navigation.open?.(isSection(section) ? section : 'general'); },
    openLink(url) { return routeLink({ api: root.api, workspace: root.relayWorkspacePanel, url }); },
  };
});
