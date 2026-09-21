(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayKeyboardShortcutsPage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ICONS = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
    edit: '<path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
    remove: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  };

  function create({ mount, store, isMac = false } = {}) {
    if (!mount || !store) throw new Error('快捷键页面缺少容器或偏好存储');
    const doc = mount.ownerDocument;
    const win = doc.defaultView || root;
    const core = win.RelayKeyboardShortcuts || root.RelayKeyboardShortcuts;
    if (!core) throw new Error('快捷键模块尚未加载');
    const actions = core.ACTIONS;
    const actionById = new Map(actions.map(action => [action.id, action]));
    const primary = isMac ? '⌘' : 'Ctrl';
    const basics = [
      { id: 'basic-send', label: '发送消息', description: '在对话和 AI 创作输入框中发送', keys: ['Enter'] },
      { id: 'basic-followup', label: '切换本次跟进方式', description: '任务运行时，在加入队列与调整方向之间临时切换', keys: [primary, 'Enter'] },
      { id: 'basic-newline', label: '插入换行', description: '在消息输入框中换行', keys: ['Shift', 'Enter'] },
      { id: 'basic-dismiss', label: '关闭弹窗', description: '关闭当前弹窗或取消当前操作', keys: ['Esc'] },
      { id: 'basic-submit-request', label: '提交请求选项', description: '在请求选择界面中提交已选答案', keys: [primary, 'Enter'] },
      { id: 'basic-sidebar-width', label: '调整侧栏宽度', description: '侧栏分隔线获得焦点时使用', keys: ['←', '→'], alternatives: true },
      { id: 'basic-feature-order', label: '调整入口顺序', description: '自定义列表中的拖动手柄获得焦点时使用', keys: ['Alt', '↑ / ↓'] },
      { id: 'basic-plugin-tab', label: '切换插件标签', description: '技能、Agent 或 MCP 标签获得焦点时使用', keys: ['←', '→'], alternatives: true },
    ];
    let recording = null;
    let rowError = '';
    let destroyed = false;
    let mutating = false;
    let focusRevision = 0;
    let miniRevision = 0;
    let miniShortcut = { status: 'loading', chord: '' };

    const element = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const icon = name => {
      const wrapper = element('span', 'ksp-icon');
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
      return wrapper;
    };
    const button = (label, iconName, className = 'ksp-icon-button') => {
      const node = element('button', className);
      node.type = 'button';
      node.title = label;
      node.setAttribute('aria-label', label);
      if (iconName) node.append(icon(iconName));
      return node;
    };
    const page = element('section', 'keyboard-shortcuts-page');
    page.setAttribute('aria-label', '键盘快捷键');
    const heading = element('header', 'ksp-heading');
    const headingText = element('div', 'ksp-heading-text');
    headingText.append(element('h2', '', '键盘快捷键'), element('p', '', '查看全局快捷键，或按你的习惯调整主窗口快捷键。'));
    const reset = button('恢复默认快捷键', 'reset', 'ksp-reset');
    reset.dataset.shortcutReset = '';
    reset.append(element('span', '', '恢复默认'));
    heading.append(headingText, reset);
    const searchBox = element('div', 'ksp-search');
    searchBox.append(icon('search'));
    const search = element('input', 'ksp-search-input');
    search.type = 'search';
    search.placeholder = '搜索快捷键';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', '搜索快捷键');
    search.dataset.shortcutSearch = '';
    const searchRecord = button('按下组合键搜索快捷键', 'keyboard');
    searchRecord.dataset.shortcutSearchRecord = '';
    searchRecord.setAttribute('aria-pressed', 'false');
    searchBox.append(search, searchRecord);
    const notice = element('div', 'ksp-notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.dataset.shortcutStatus = '';
    notice.textContent = '修改会自动保存在本机。每个操作最多可设置 3 个快捷键。';
    const groups = element('div', 'ksp-groups');
    groups.dataset.shortcutGroups = '';
    page.append(heading, searchBox, notice, groups);
    mount.replaceChildren(page);

    function visible() {
      if (destroyed || !mount.isConnected || mount.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = win.getComputedStyle(mount);
      return style.display !== 'none' && style.visibility !== 'hidden' && mount.getClientRects().length > 0;
    }
    function setNotice(message, error = false) {
      notice.textContent = message;
      notice.classList.toggle('is-error', error);
      notice.dataset.error = String(error);
    }
    function focus(node) {
      if (!node || destroyed || !visible()) return;
      node.focus({ preventScroll: true });
    }
    function focusControl(id, index) {
      const row = [...groups.querySelectorAll('[data-shortcut-action]')].find(node => node.dataset.shortcutAction === id);
      if (!row) return focus(search);
      focus(row.querySelector(`[data-shortcut-edit="${index}"]`) || row.querySelector('[data-shortcut-add]') || row.querySelector('[data-shortcut-edit]') || search);
    }
    function cancelRecording(restoreFocus = true) {
      if (!recording) return;
      const previous = recording;
      recording = null;
      rowError = '';
      focusRevision++;
      search.readOnly = false;
      search.placeholder = '搜索快捷键';
      searchBox.classList.remove('is-recording');
      searchRecord.setAttribute('aria-pressed', 'false');
      searchRecord.title = '按下组合键搜索快捷键';
      searchRecord.setAttribute('aria-label', searchRecord.title);
      renderRows();
      if (restoreFocus) {
        if (previous.type === 'search') focus(search);
        else focusControl(previous.id, previous.index);
      }
    }
    function searchable(value) {
      return String(value || '').toLocaleLowerCase().replace(/command|⌘/g, 'cmd').replace(/control|⌃/g, 'ctrl').replace(/option|⌥/g, 'alt').replace(/⇧/g, 'shift').replace(/escape/g, 'esc').replace(/[+\s]+/g, ' ').trim();
    }
    function matches(action, bindings) {
      const tokens = searchable(search.value).split(' ').filter(Boolean);
      const source = searchable([action.label, action.description, action.group, ...bindings.map(chord => core.formatChord(chord, isMac).join(' ')), ...bindings].join(' '));
      return tokens.every(token => source.includes(token));
    }
    function keycaps(keys, alternatives = false) {
      const node = element('span', 'ksp-keys');
      node.setAttribute('aria-label', keys.join(alternatives ? ' 或 ' : ' + '));
      keys.forEach((key, index) => {
        if (index) node.append(element('span', 'ksp-key-join', alternatives ? '/' : '+'));
        node.append(element('kbd', 'ksp-key', key));
      });
      return node;
    }
    function actionInfo(action) {
      const node = element('div', 'ksp-action-info');
      node.append(element('div', 'ksp-action-name', action.label), element('div', 'ksp-action-description', action.description));
      return node;
    }
    function globalSection() {
      const descriptions = {
        loading: '默认 Alt+Space，正在读取当前快捷键。',
        active: '在任意应用中唤起或收起迷你输入框。',
        fallback: 'Alt+Space 已被占用，当前使用备用组合键。',
        disabled: '默认 Alt+Space；已关闭，可在「设置 → 常规」中开启。',
        unavailable: '默认 Alt+Space；快捷键注册失败，可从托盘菜单打开。',
        error: '默认 Alt+Space；暂时无法读取状态，重新进入此页可重试。',
      };
      const action = { label: '快捷小窗', description: descriptions[miniShortcut.status], group: '全局快捷键 迷你输入框' };
      if (!matches(action, ['Alt+Space', miniShortcut.chord].filter(Boolean))) return null;
      const section = element('section', 'ksp-group');
      section.dataset.shortcutGlobalGroup = '';
      const title = element('div', 'ksp-group-heading');
      title.append(element('h3', '', '全局快捷键'), element('span', '', '在其他应用中也可使用'));
      const card = element('div', 'ksp-card');
      const row = element('div', 'ksp-row ksp-row-readonly');
      row.dataset.shortcutGlobal = 'miniWindow';
      row.dataset.shortcutState = miniShortcut.status;
      row.append(actionInfo(action));
      if (miniShortcut.chord) row.append(keycaps(core.formatChord(miniShortcut.chord, isMac)));
      else {
        const labels = { loading: '读取中…', disabled: '已关闭', unavailable: '未注册', error: '暂不可用' };
        row.append(element('span', 'ksp-global-state', labels[miniShortcut.status]));
      }
      card.append(row);
      section.append(title, card);
      return section;
    }
    function syncEmptyState() {
      groups.querySelector('[data-shortcut-empty]')?.remove();
      if (groups.querySelector('[data-shortcut-action], [data-shortcut-basic], [data-shortcut-global]')) return;
      const empty = element('div', 'ksp-empty');
      empty.dataset.shortcutEmpty = '';
      empty.append(icon('search'), element('p', '', '没有找到匹配的快捷键'), element('span', '', '试试操作名称或 Ctrl K 这样的组合键。'));
      groups.append(empty);
    }
    async function refreshMiniShortcut() {
      const revision = ++miniRevision;
      let next;
      try {
        const state = await win.api?.mini?.brand?.();
        if (!state || typeof state.enabled !== 'boolean') throw new Error('Missing mini shortcut status');
        const chord = typeof state.shortcut === 'string' ? state.shortcut.replace(/Control/g, 'Ctrl') : '';
        if (!state.enabled) next = { status: 'disabled', chord: '' };
        else if (!chord) next = { status: 'unavailable', chord: '' };
        else if (!core.formatChord(chord, isMac).length) throw new Error('Invalid mini shortcut');
        else next = { status: chord === 'Alt+Space' ? 'active' : 'fallback', chord };
      } catch (_) {
        next = { status: 'error', chord: '' };
      }
      if (destroyed || revision !== miniRevision) return;
      miniShortcut = next;
      // Only replace this read-only section: an IPC reply must not steal the
      // focus or recorded keys from an in-progress local-shortcut edit.
      const previous = groups.querySelector('[data-shortcut-global-group]');
      const section = globalSection();
      if (previous) { if (section) previous.replaceWith(section); else previous.remove(); }
      else if (section) groups.prepend(section);
      syncEmptyState();
    }
    function refreshVisibleMiniShortcut() { if (visible()) refreshMiniShortcut(); }
    function recorder(action, index) {
      const node = element('div', 'ksp-recorder');
      node.dataset.shortcutRecording = action.id;
      const controls = element('div', 'ksp-record-controls');
      const input = element('input', 'ksp-record-input');
      input.type = 'text';
      input.readOnly = true;
      input.placeholder = '按下快捷键';
      input.setAttribute('aria-label', `为“${action.label}”录制快捷键`);
      input.setAttribute('aria-describedby', `ksp-record-help-${action.id}`);
      input.dataset.shortcutRecordInput = '';
      const cancel = button('取消录制快捷键', 'close');
      cancel.dataset.shortcutCancel = '';
      controls.append(input, cancel);
      const help = element('div', `ksp-record-help${rowError ? ' is-error' : ''}`, rowError || '按下组合键以保存，Esc 取消');
      help.id = `ksp-record-help-${action.id}`;
      help.setAttribute('aria-live', 'polite');
      if (rowError) help.dataset.shortcutError = '';
      node.append(controls, help);
      return node;
    }
    function actionRow(action, bindings) {
      const row = element('div', 'ksp-row');
      row.dataset.shortcutAction = action.id;
      row.append(actionInfo(action));
      const controls = element('div', 'ksp-bindings');
      bindings.forEach((chord, index) => {
        if (recording && recording.type === 'binding' && recording.id === action.id && recording.index === index) {
          controls.append(recorder(action, index));
          return;
        }
        const binding = element('div', 'ksp-binding');
        const edit = button(`编辑“${action.label}”快捷键 ${core.formatChord(chord, isMac).join('+')}`, 'edit');
        edit.dataset.shortcutEdit = String(index);
        const remove = button(`删除“${action.label}”快捷键 ${core.formatChord(chord, isMac).join('+')}`, 'remove', 'ksp-icon-button ksp-remove');
        remove.dataset.shortcutRemove = String(index);
        binding.append(keycaps(core.formatChord(chord, isMac)), edit, remove);
        controls.append(binding);
      });
      const adding = recording && recording.type === 'binding' && recording.id === action.id && recording.index >= bindings.length;
      if (adding) controls.append(recorder(action, bindings.length));
      else if (bindings.length < 3) {
        const add = button(bindings.length ? `为“${action.label}”添加快捷键` : `为“${action.label}”分配快捷键`, bindings.length ? 'plus' : 'edit', 'ksp-add');
        add.dataset.shortcutAdd = '';
        add.append(element('span', '', bindings.length ? '添加快捷键' : '未分配'));
        controls.append(add);
      }
      row.append(controls);
      return row;
    }
    function renderRows() {
      if (destroyed) return;
      const prefs = store.get();
      const fragment = doc.createDocumentFragment();
      const global = globalSection();
      if (global) fragment.append(global);
      const grouped = new Map();
      for (const action of actions) {
        const bindings = prefs.bindings[action.id] || [];
        if (!matches(action, bindings)) continue;
        const group = action.group || '应用操作';
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(actionRow(action, bindings));
      }
      function section(label, rows, hint) {
        if (!rows.length) return;
        const node = element('section', 'ksp-group');
        const title = element('div', 'ksp-group-heading');
        title.append(element('h3', '', label));
        if (hint) title.append(element('span', '', hint));
        const card = element('div', 'ksp-card');
        card.append(...rows);
        node.append(title, card);
        fragment.append(node);
      }
      for (const [label, rows] of grouped) section(label, rows, label === '右侧工作区' ? '在浏览器和终端中也可使用，修改后立即生效' : null);
      const basicRows = basics.filter(action => matches({ ...action, group: '基础操作' }, [action.keys.join('+')])).map(action => {
        const row = element('div', 'ksp-row ksp-row-readonly');
        row.dataset.shortcutBasic = action.id;
        row.append(actionInfo(action), keycaps(action.keys, action.alternatives));
        return row;
      });
      section('基础操作', basicRows, '在对应界面中使用，不支持修改');
      groups.replaceChildren(fragment);
      syncEmptyState();
    }
    function beginRecording(id, index) {
      cancelRecording(false);
      recording = { type: 'binding', id, index };
      rowError = '';
      renderRows();
      const input = groups.querySelector('[data-shortcut-record-input]');
      focus(input);
    }
    function describeError(result) {
      if (result && result.conflictId) return `这个快捷键已用于“${actionById.get(result.conflictId)?.label || '其他操作'}”，请使用其他组合键。`;
      return result && typeof result.error === 'string' ? result.error : '快捷键未能保存，请重试。';
    }
    function mutate(operation, successMessage, restore) {
      let result;
      mutating = true;
      try { result = operation(); }
      catch (_) { result = { ok: false, error: '快捷键未能保存，请检查本机存储后重试。' }; }
      finally { mutating = false; }
      if (!result || !result.ok) {
        const message = describeError(result);
        if (recording && recording.type === 'binding') {
          rowError = message;
          renderRows();
          focus(groups.querySelector('[data-shortcut-record-input]'));
        } else setNotice(message, true);
        return false;
      }
      cancelRecording(false);
      renderRows();
      setNotice(successMessage);
      if (restore) restore();
      return true;
    }
    function onClick(event) {
      const target = event.target.closest('button');
      if (!target || !page.contains(target)) return;
      if ('shortcutCancel' in target.dataset) return cancelRecording();
      if ('shortcutSearchRecord' in target.dataset) {
        if (recording && recording.type === 'search') return cancelRecording();
        cancelRecording(false);
        recording = { type: 'search' };
        search.readOnly = true;
        search.placeholder = '按下组合键以搜索';
        searchBox.classList.add('is-recording');
        searchRecord.setAttribute('aria-pressed', 'true');
        searchRecord.title = '取消按键搜索';
        searchRecord.setAttribute('aria-label', searchRecord.title);
        focus(search);
        return;
      }
      if ('shortcutReset' in target.dataset) {
        cancelRecording(false);
        return mutate(() => store.reset(), '已恢复默认快捷键。', () => focus(reset));
      }
      const row = target.closest('[data-shortcut-action]');
      if (!row) return;
      const id = row.dataset.shortcutAction;
      if ('shortcutEdit' in target.dataset) return beginRecording(id, Number(target.dataset.shortcutEdit));
      if ('shortcutAdd' in target.dataset) return beginRecording(id, (store.get().bindings[id] || []).length);
      if ('shortcutRemove' in target.dataset) {
        cancelRecording(false);
        const index = Number(target.dataset.shortcutRemove);
        return mutate(() => store.remove(id, index), `已删除“${actionById.get(id).label}”的快捷键。`, () => focusControl(id, index));
      }
    }
    function onSearch() {
      if (recording) cancelRecording(false);
      renderRows();
    }
    function onFocusOut() {
      const revision = ++focusRevision;
      queueMicrotask(() => {
        if (destroyed || !recording || revision !== focusRevision) return;
        const scope = recording.type === 'search' ? searchBox : groups.querySelector('[data-shortcut-recording]');
        if (!scope || !scope.contains(doc.activeElement)) cancelRecording(false);
      });
    }
    function onWindowBlur() { cancelRecording(false); }
    function handleKeyDown(event) {
      if (!recording) return false;
      if (!visible()) { cancelRecording(false); return false; }
      // Tab must still move focus; other recording keys must not reach app shortcuts.
      event.stopImmediatePropagation();
      if (event.key === 'Tab') { cancelRecording(); return true; }
      event.preventDefault();
      if (event.key === 'Escape') { cancelRecording(); return true; }
      if (event.repeat || event.isComposing || event.keyCode === 229) return true;
      const chord = core.chordFromEvent(event, isMac);
      if (!chord) return true;
      if (recording.type === 'search') {
        search.value = core.formatChord(chord, isMac).join('+');
        cancelRecording(false);
        focus(search);
        return true;
      }
      const validated = core.validateChord(chord);
      if (!validated.ok) {
        rowError = describeError(validated);
        const help = groups.querySelector('.ksp-record-help');
        if (help) { help.textContent = rowError; help.classList.add('is-error'); help.dataset.shortcutError = ''; }
        return true;
      }
      const { id, index } = recording;
      mutate(() => store.assign(id, index, validated.chord || chord), `已更新“${actionById.get(id).label}”的快捷键。`, () => focusControl(id, index));
      return true;
    }
    const unsubscribe = store.subscribe(() => {
      if (mutating || destroyed) return;
      cancelRecording(false);
      renderRows();
    });
    page.addEventListener('click', onClick);
    page.addEventListener('focusout', onFocusOut);
    search.addEventListener('input', onSearch);
    win.addEventListener('blur', onWindowBlur);
    win.addEventListener('focus', refreshVisibleMiniShortcut);
    win.addEventListener('relay:view-changed', refreshVisibleMiniShortcut);
    const visibilityObserver = new win.MutationObserver(refreshVisibleMiniShortcut);
    const visibilityAttributes = { attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] };
    visibilityObserver.observe(mount, visibilityAttributes);
    const category = mount.closest('.set-cat');
    if (category && category !== mount) visibilityObserver.observe(category, visibilityAttributes);
    renderRows();
    refreshMiniShortcut();
    return {
      handleKeyDown,
      cancelRecording,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        recording = null;
        focusRevision++;
        miniRevision++;
        if (typeof unsubscribe === 'function') unsubscribe();
        page.removeEventListener('click', onClick);
        page.removeEventListener('focusout', onFocusOut);
        search.removeEventListener('input', onSearch);
        win.removeEventListener('blur', onWindowBlur);
        win.removeEventListener('focus', refreshVisibleMiniShortcut);
        win.removeEventListener('relay:view-changed', refreshVisibleMiniShortcut);
        visibilityObserver.disconnect();
        page.remove();
      },
    };
  }
  return { create };
});
