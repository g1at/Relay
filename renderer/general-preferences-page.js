(function (root) {
  'use strict';
  const defaults = { sdkRuntimePreferences: {}, workspaceRoot: '', fileOpenTarget: 'relay', agentEnvironment: 'native', terminalShell: 'auto', followUpMode: 'steer', maxParallelTasks: 2 };
  const parallelPresets = [2, 6, 9, 0];
  function normalizeParallelLimit(value) {
    if (!Number.isSafeInteger(value) || value < 0) return defaults.maxParallelTasks;
    if (value === 0) return 0;
    return parallelPresets.find(limit => limit >= value) || 9;
  }
  const fields = [
    ['workspaceRoot', '无项目任务文件夹', '新建的非项目对话按会话分类保存；已有文件保持原位。', 'folder'],
    ['fileOpenTarget', '默认文件打开位置', '选择打开本地文件和文件夹的应用。', 'file'],
    ['agentEnvironment', '智能体环境', '选择新任务的运行环境；正在执行的任务保持当前环境。', 'environment'],
    ['terminalShell', '集成终端 Shell', '新建终端时使用的 Shell，已有终端保持不变。', 'terminal'],
    ['followUpMode', '跟进处理方式', '任务运行时加入队列，或调整当前方向。Ctrl+Enter 对单条消息使用另一种方式。', 'followup'],
    ['maxParallelTasks', '并行对话数', '超出数量的任务自动排队。保存后立即生效，正在运行的任务会继续完成。', 'parallel'],
  ];
  const paths = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
    file: '<path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
    environment: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3m-4-9 3 3-3 3M13 15h3"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    followup: '<path d="M4 5h10a6 6 0 0 1 0 12H7m4-4-4 4 4 4M4 9h4"/>',
    parallel: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  };
  function create({ mount, mounts = {}, api, settings = {}, onChange = () => {} }) {
    const doc = mount.ownerDocument;
    let base = { ...defaults, ...settings, maxParallelTasks: normalizeParallelLimit(settings.maxParallelTasks) }, draft = { ...base }, snapshot = null, pending = false, disposed = false, revision = 0;
    const dirty = new Set(), dropdowns = new Map();
    let runtimeSaveRevision = 0, runtimeSaveQueue = Promise.resolve();
    const livePreferenceKeys = ['autoCompact', 'showThinkingSummaries', 'outputBudget'];
    const node = (tag, className, text) => { const el = doc.createElement(tag); el.className = className; if (text != null) el.textContent = text; return el; };
    const owned = [];
    function group(target, title) {
      const section = node('section', 'rgp-section');
      section.setAttribute('aria-label', title);
      const heading = node('h3', 'set-section-head rgp-heading', title);
      const panel = node('div', 'set-panel rgp-panel'); section.append(heading, panel);
      (mounts[target] || mount).append(section); owned.push(section);
      return { section, heading, panel };
    }
    const workspace = group('workspace', '文件与环境');
    const conversation = group('conversation', '跟进与并行');
    const section = workspace.section;
    const retry = node('button', 'rgp-icon-button'); retry.type = 'button'; retry.dataset.generalRefresh = '';
    retry.title = '重新检测'; retry.setAttribute('aria-label', '重新检测'); retry.setAttribute('aria-busy', 'false');
    retry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.34 5.66"/></svg>';
    retry.addEventListener('click', () => void refresh(true));
    workspace.heading.append(retry);
    const slots = new Map();
    const destinations = { workspaceRoot: workspace, fileOpenTarget: workspace, agentEnvironment: workspace, terminalShell: workspace,
      followUpMode: conversation, maxParallelTasks: conversation };
    for (const [key, label, description, icon] of fields) {
      const row = node('div', 'set-row rgp-row'); row.dataset.generalRow = key;
      const symbol = node('div', 'set-icon'); symbol.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon]}</svg>`;
      const text = node('div', 'rgp-label'); text.append(node('label', '', label), node('p', '', description));
      const controls = node('div', 'rgp-controls'); controls.dataset.generalControl = key;
      row.append(symbol, text, controls); destinations[key].panel.append(row); slots.set(key, controls);
    }
    const footer = node('div', 'rgp-feedback'), status = node('span', 'rgp-status'); status.setAttribute('role', 'status');
    footer.append(status); section.append(footer);
    function change(key, value) {
      draft[key] = value;
      if (JSON.stringify(base[key]) === JSON.stringify(value)) dirty.delete(key); else dirty.add(key);
      onChange();
    }
    function select(key, options, { value = draft[key], onSelect = next => change(key, next) } = {}) {
      const slot = slots.get(key), label = fields.find(field => field[0] === key)[1];
      if (!options.length) options = [{ id: draft[key], label: '尚未检测', available: false }];
      if (!options.some(option => option.id === value)) options = [...options, { id: value, label: '当前配置不可用', available: false }];
      const host = node('div', '');
      host.innerHTML = root.buildCustomSelect('general-' + key, options.map(option => ({ value: option.id, label: option.label })), value);
      const wrapper = host.firstElementChild, oldTrigger = wrapper.querySelector('.cs-trigger'), trigger = node('button', 'cs-trigger');
      trigger.type = 'button'; trigger.innerHTML = oldTrigger.innerHTML; oldTrigger.replaceWith(trigger);
      trigger.dataset.generalSetting = key; trigger.setAttribute('aria-label', label); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
      const popup = wrapper.querySelector('.cs-popup'); popup.id = wrapper.id + '-options'; popup.setAttribute('role', 'listbox'); trigger.setAttribute('aria-controls', popup.id);
      const items = [...popup.querySelectorAll('.cs-option')];
      items.forEach(item => {
        const option = options.find(value => value.id === item.dataset.value);
        item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(item.dataset.value === value)); item.tabIndex = -1;
        item.setAttribute('aria-disabled', String(option.available === false));
        if (option.reason) item.title = option.reason;
        item.addEventListener('click', event => {
          if (option.available === false) { event.stopImmediatePropagation(); status.textContent = option.reason || '当前环境不可用'; return; }
          onSelect(item.dataset.value);
          items.forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === item)));
          trigger.title = option.reason || option.label;
        }, true);
      });
      root.bindCustomSelects(host); wrapper.classList.replace('custom-select', 'rgp-dropdown');
      const selected = options.find(option => option.id === value); trigger.title = selected?.reason || selected?.label || '';
      wrapper.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const enabled = items.filter(item => item.getAttribute('aria-disabled') !== 'true');
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); if (popup.hidden) trigger.click();
          const index = enabled.indexOf(doc.activeElement);
          const next = enabled[event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length];
          next?.focus({ preventScroll: true }); if (next) root.revealCustomSelectOption(popup, next);
        } else if (['Enter', ' '].includes(event.key) && popup.contains(doc.activeElement)) { event.preventDefault(); event.stopPropagation(); doc.activeElement.click(); }
        else if (event.key === 'Escape') { root.closeCustomSelect(); trigger.focus({ preventScroll: true }); }
      });
      dropdowns.set(key, { popup, trigger }); slot.replaceChildren(wrapper);
    }
    const folder = slots.get('workspaceRoot'), folderName = node('span', 'rgp-path'), choose = node('button', 'rgp-button', '更改'), reset = node('button', 'rgp-button rgp-reset', '恢复默认');
    choose.type = reset.type = 'button'; choose.dataset.generalChooseFolder = ''; reset.dataset.generalResetFolder = '';
    folder.append(folderName, choose, reset);
    function renderFolder() { folderName.textContent = draft.workspaceRoot || snapshot?.preferences?.defaultWorkspaceRoot || 'RelayProjects'; folderName.title = folderName.textContent; reset.hidden = !draft.workspaceRoot; }
    choose.addEventListener('click', async () => {
      if (choose.disabled || typeof api?.pickWorkspaceRoot !== 'function') return;
      choose.disabled = true;
      try { const result = await api.pickWorkspaceRoot(); if (disposed) return; if (result?.ok && result.path) { change('workspaceRoot', result.path); renderFolder(); } else if (!result?.canceled) status.textContent = result?.error || '文件夹选择失败'; }
      catch (error) { if (!disposed) status.textContent = error.message || '文件夹选择失败'; }
      finally { if (!disposed) choose.disabled = false; }
    });
    reset.addEventListener('click', () => { change('workspaceRoot', ''); renderFolder(); });
    function renderParallel() {
      select('maxParallelTasks', parallelPresets.map(value => ({ id: String(value), label: value === 0 ? '不限制' : value + ' 个' })), {
        value: String(draft.maxParallelTasks),
        onSelect(value) { change('maxParallelTasks', Number(value)); },
      });
    }
    const advanced = root.RelaySdkRuntimeControls?.create({ mount: section, mounts, value: draft.sdkRuntimePreferences || {}, onChange: value => change('sdkRuntimePreferences', value) });
    function render() {
      if (disposed) return;
      if ([...dropdowns.values()].some(value => !value.popup.hidden)) root.closeCustomSelect();
      renderFolder(); choose.disabled = !api?.pickWorkspaceRoot;
      select('fileOpenTarget', snapshot?.capabilities?.fileOpenTargets || [{ id: 'relay', label: 'Relay', available: false }, { id: 'system', label: '系统默认应用', available: false }]);
      select('agentEnvironment', snapshot?.capabilities?.agentEnvironments || [{ id: 'native', label: '系统原生', available: false }]);
      select('terminalShell', snapshot?.capabilities?.terminalShells || [{ id: 'auto', label: '系统默认', available: false }]);
      select('followUpMode', [{ id: 'queue', label: '加入队列' }, { id: 'steer', label: '调整方向' }]);
      renderParallel();
    }
    async function refresh(force = false) {
      if (disposed || pending || (snapshot && !force) || typeof api?.get !== 'function') return;
      const own = ++revision; pending = true; retry.disabled = true; retry.setAttribute('aria-busy', 'true'); status.textContent = '正在检测可用环境…';
      try {
        const result = await api.get({ refresh: force }); if (disposed || own !== revision) return;
        if (!result?.ok) throw Error(result?.error || '环境检测失败');
        snapshot = result; advanced?.setModelCapability(snapshot.modelCapability);
        // The settings form owns its draft. A late capability response must not
        // reset a choice made or saved while environment detection was running.
        status.textContent = ''; render();
      } catch (error) { if (!disposed && own === revision) status.textContent = error.message || '环境检测失败，可重新检测'; }
      finally { if (!disposed && own === revision) { pending = false; retry.disabled = false; retry.setAttribute('aria-busy', 'false'); } }
    }
    render();
    return {
      refresh,
      getPatch() {
        if (dirty.has('maxParallelTasks') && !parallelPresets.includes(draft.maxParallelTasks)) throw Error('请选择 2、6、9 个并行对话，或不限制。');
        return Object.fromEntries([...dirty].map(key => [key, draft[key]]));
      },
      saved(patch) {
        // Only confirmed saves reach this method; never submit a draft to a live session.
        const nextRuntime = patch.sdkRuntimePreferences;
        const changed = nextRuntime ? livePreferenceKeys.filter(key => (base.sdkRuntimePreferences?.[key] ?? 'inherit') !== (nextRuntime[key] ?? 'inherit')) : [];
        for (const [key, value] of Object.entries(patch)) {
          if (!(key in defaults)) continue;
          base[key] = value;
          if (JSON.stringify(draft[key]) === JSON.stringify(value)) dirty.delete(key);
        }
        if (!changed.length || disposed || typeof api?.applyRuntimeFlags !== 'function') return;
        const own = ++runtimeSaveRevision;
        const restoresDefault = changed.some(key => (nextRuntime[key] ?? 'inherit') === 'inherit');
        runtimeSaveQueue = runtimeSaveQueue.catch(() => {}).then(async () => {
          if (disposed || own !== runtimeSaveRevision) return { skipped: true };
          try {
            const result = await api.applyRuntimeFlags();
            if (disposed || own !== runtimeSaveRevision) return { skipped: true };
            return { ok: !!result?.ok, deferred: restoresDefault || !result?.ok };
          } catch (_) { return disposed || own !== runtimeSaveRevision ? { skipped: true } : { ok: false, deferred: true }; }
        });
        return runtimeSaveQueue;
      },
      destroy() { disposed = true; runtimeSaveRevision++; advanced?.destroy(); owned.forEach(section => section.remove()); revision++; if ([...dropdowns.values()].some(value => !value.popup.hidden)) root.closeCustomSelect(); },
    };
  }
  root.RelayGeneralPreferencesPage = { create, normalizeParallelLimit };
})(window);
