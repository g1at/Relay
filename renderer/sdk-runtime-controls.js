(function (root) {
  'use strict';

  // Keep runtime support for previous overrides without exposing duplicate
  // model, skill and system-prompt controls in everyday settings.
  const compatibilityDefaults = {
    thinking: 'inherit', thinkingBudget: 4096, thinkingDisplay: 'summarized',
    forwardSubagentText: false, skillBudget: 'inherit', outputBudget: 'inherit',
    skills: null, skillOverrides: {}, autoCompactWindow: null,
    switchModelsOnFlag: 'inherit', customSystemPrompt: null,
  };
  const compatibilityLabels = {
    thinking: '旧版思考方式', thinkingBudget: '旧版思考预算', thinkingDisplay: '旧版思考内容',
    forwardSubagentText: '子任务文字转发', skillBudget: '技能说明长度', outputBudget: '工具返回长度',
    skills: '默认技能范围', skillOverrides: '技能调用规则', autoCompactWindow: '上下文压缩窗口',
    switchModelsOnFlag: '旧版拒绝后模型切换', customSystemPrompt: '自定义主系统指令',
  };
  const icons = {
    context: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M8 8h8M8 12h8M8 16h5"/>',
    plan: '<path d="M8 4h10a2 2 0 0 1 2 2v14H6V6a2 2 0 0 1 2-2Z"/><path d="M9 3h8v4H9zM10 11h6m-6 4h6M3 8v13"/>',
    limits: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    summary: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>',
    tools: '<path d="m14 6 4 4m-11 7 7-7M14 3a6 6 0 0 0-6 8l-5 5a3 3 0 0 0 4 4l5-5a6 6 0 0 0 8-6l-4 3-4-4Z"/>',
    shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
  };
  let instanceId = 0;

  function create({ mount, mounts = {}, value = {}, onChange = () => {} }) {
    const primaryMount = mount || mounts.conversation || mounts.toolRules || mounts.advanced;
    const doc = primaryMount.ownerDocument, id = 'sdk-settings-' + (++instanceId);
    const destinations = {
      conversation: mounts.conversation || primaryMount,
      // Retain the old mount argument for callers restoring an earlier layout.
      toolRules: mounts.toolRules || mounts.advanced || mounts.conversation || primaryMount,
    };
    let draft = structuredClone(value), disposed = false, modelCapability = null;
    const sections = [], painters = [], dropdowns = [];
    const node = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls || ''; if (text != null) el.textContent = text; return el; };
    const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.limits}</svg>`;
    const update = (key, next) => { if (!disposed) { draft = { ...draft, [key]: next }; onChange(structuredClone(draft)); } };

    function group(destination, key, title, { note = '' } = {}) {
      const section = node('section', 'rgp-section sdk-runtime-controls sdk-settings-section');
      section.dataset.sdkGroup = key; section.setAttribute('aria-label', title);
      section.append(node('div', 'set-section-head', title));
      if (note) section.append(node('p', 'sdk-settings-note', note));
      const panel = node('div', 'set-panel rgp-panel sdk-settings-panel'); section.append(panel);
      destinations[destination].append(section); sections.push(section);
      return { section, panel };
    }

    function row(group, key, label, note, { icon = 'limits', multiline = false } = {}) {
      const item = node('div', 'set-row rgp-row sdk-settings-row' + (multiline ? ' sdk-settings-row--multiline' : ''));
      item.dataset.sdkPreference = key;
      const symbol = node('div', 'set-icon'); symbol.innerHTML = svg(icon);
      const caption = node('div', 'rgp-label'); caption.append(node('label', '', label)); if (note) caption.append(node('p', '', note));
      const controls = node('div', 'rgp-controls sdk-settings-control'); controls.dataset.sdkControl = key;
      item.append(symbol, caption, controls); group.panel.append(item); return controls;
    }

    function choice(slot, key, label, options, { get = () => draft[key] || options[0][0], set = next => update(key, next), descriptions = null } = {}) {
      const host = node('div', '');
      host.innerHTML = root.buildCustomSelect(id + '-' + key, options.map(([value, label]) => ({ value, label })), get());
      const wrapper = host.firstElementChild, previous = wrapper.querySelector('.cs-trigger'), trigger = node('button', 'cs-trigger');
      trigger.type = 'button'; trigger.innerHTML = previous.innerHTML; previous.replaceWith(trigger);
      trigger.setAttribute('aria-label', label); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.dataset.sdkSetting = key;
      const description = descriptions && slot.parentElement.querySelector('.rgp-label p');
      if (description) { description.id = id + '-' + key + '-description'; trigger.setAttribute('aria-describedby', description.id); }
      const popup = wrapper.querySelector('.cs-popup'); popup.id = wrapper.id + '-options'; popup.setAttribute('role', 'listbox'); trigger.setAttribute('aria-controls', popup.id);
      const items = [...popup.querySelectorAll('.cs-option')];
      const paint = () => {
        const selected = get(), option = options.find(([value]) => value === selected) || options[0];
        wrapper.dataset.value = option[0]; trigger.querySelector('.cs-text').textContent = option[1];
        if (description) description.textContent = descriptions[option[0]];
        items.forEach(item => { const active = item.dataset.value === option[0]; item.setAttribute('aria-selected', String(active)); item.classList.toggle('selected', active); });
      };
      items.forEach(item => {
        item.tabIndex = -1; item.setAttribute('role', 'option');
        item.addEventListener('click', () => { set(item.dataset.value); paint(); });
      });
      root.bindCustomSelects(host); wrapper.classList.replace('custom-select', 'rgp-dropdown');
      wrapper.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); if (popup.hidden) trigger.click();
          const index = items.indexOf(doc.activeElement);
          const next = items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
          next?.focus({ preventScroll: true }); if (next) root.revealCustomSelectOption?.(popup, next);
        } else if (['Enter', ' '].includes(event.key) && popup.contains(doc.activeElement)) {
          event.preventDefault(); event.stopPropagation(); doc.activeElement.click(); trigger.focus({ preventScroll: true });
        } else if (event.key === 'Escape') { root.closeCustomSelect?.(); trigger.focus({ preventScroll: true }); }
      });
      painters.push(paint); dropdowns.push({ wrapper, popup }); paint(); slot.append(wrapper);
    }

    function toggle(slot, key, label, { get = () => !!draft[key], set = next => update(key, next) } = {}) {
      const button = node('button', 'rgp-toggle'); button.type = 'button'; button.dataset.sdkSetting = key;
      button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label);
      const paint = () => button.setAttribute('aria-checked', String(get()));
      button.addEventListener('click', () => { set(!get()); paint(); });
      painters.push(paint); paint(); slot.append(button); return button;
    }

    function listInput(slot, key, label, { get = () => draft[key] || [], set = next => update(key, next), placeholder = '每行一条' } = {}) {
      const input = node('textarea', 'provider-edit-inline-input sdk-runtime-input sdk-settings-input'); input.rows = 3;
      input.setAttribute('aria-label', label); input.placeholder = placeholder; input.spellcheck = false;
      const paint = () => { input.value = get().join('\n'); };
      input.addEventListener('input', () => set(input.value.split('\n').map(line => line.trim()).filter(Boolean)));
      painters.push(paint); paint(); slot.append(input);
    }

    const conversation = group('conversation', 'context', '上下文与计划');
    choice(row(conversation, 'autoCompact', '自动压缩上下文', ' ', { icon: 'context' }),
      'autoCompact', '自动压缩上下文', [['inherit', '自动'], ['enabled', '开启'], ['disabled', '关闭']], { descriptions: {
        inherit: '使用默认压缩策略（默认开启）；下次启动会话时生效。',
        enabled: '开启自动压缩，接近上限时整理上下文；保存后尝试应用于当前对话。',
        disabled: '关闭自动压缩，不自动整理上下文；保存后尝试应用于当前对话。',
      } });
    toggle(row(conversation, 'showClearContextOnPlanAccept', '接受计划时提供清空选项', '清空前需要确认，Relay 历史对话会保留。', { icon: 'plan' }), 'showClearContextOnPlanAccept', '接受计划时提供清空选项');

    const summaries = group('conversation', 'summaries', '过程摘要', { note: '思考摘要需服务商支持，不改变推理强度。' });
    toggle(row(summaries, 'agentProgressSummaries', '生成子任务进度摘要', '由 SDK 额外调用模型生成摘要，会增加用量。', { icon: 'summary' }), 'agentProgressSummaries', '生成子任务进度摘要');
    choice(row(summaries, 'showThinkingSummaries', '请求思考摘要', ' ', { icon: 'summary' }),
      'showThinkingSummaries', '请求思考摘要', [['inherit', '自动'], ['enabled', '开启'], ['disabled', '关闭']], { descriptions: {
        inherit: '使用默认摘要策略；下次启动会话时生效。',
        enabled: '请求服务商提供思考摘要；保存后尝试应用于当前对话。',
        disabled: '不请求额外摘要，模型仍可进行推理；保存后尝试应用于当前对话。',
      } });

    const tools = group('toolRules', 'tool-rules', '工具规则', { note: '为指定工具设置批准和禁止规则。' });
    listInput(row(tools, 'allowedTools', '自动批准的工具', '例如 Read。拒绝规则优先，计划模式仍限制写入。', { icon: 'shield', multiline: true }), 'allowedTools', '自动批准的工具');
    listInput(row(tools, 'disallowedTools', '禁止的工具', '同样适用于子智能体。', { icon: 'shield', multiline: true }), 'disallowedTools', '禁止的工具');
    toggle(row(tools, 'disableSkillShellExecution', '禁止技能内的命令替换', '控制技能加载时的内联命令，与对话中的命令权限分别管理。', { icon: 'tools' }), 'disableSkillShellExecution', '禁止技能内的命令替换');

    const compatibility = group('toolRules', 'compatibility', '已有兼容配置', { note: '旧版配置继续生效。可逐项恢复默认，保存后应用。' });
    function compatibilitySummary(key, value) {
      if (key === 'thinking') return ({ adaptive: '自适应', enabled: '固定预算', disabled: '已关闭' })[value] + (value === 'adaptive' && modelCapability?.supportsAdaptiveThinking === false ? ' · 当前模型不支持' : '');
      if (key === 'thinkingBudget' || key === 'autoCompactWindow') return Number(value).toLocaleString() + ' Token';
      if (key === 'thinkingDisplay') return value === 'omitted' ? '隐藏思考内容' : '使用摘要';
      if (key === 'forwardSubagentText') return '已开启';
      if (key === 'skillBudget' || key === 'outputBudget') return ({ compact: '精简', balanced: '均衡', expanded: '详细' })[value] || '已有配置';
      if (key === 'skills') return value?.length ? '限定为 ' + value.length + ' 项技能' : '未开放任何技能';
      if (key === 'skillOverrides') return '已配置 ' + Object.keys(value || {}).length + ' 项规则';
      if (key === 'switchModelsOnFlag') return (value === 'enabled' ? '已允许' : '已关闭') + ' · Relay 不会自动更换服务商';
      if (key === 'customSystemPrompt') return '已设置固定指令 ' + (value?.static?.length || 0) + ' 段、动态指令 ' + (value?.dynamic?.length || 0) + ' 段';
      return '已有配置';
    }
    function renderCompatibility() {
      if (disposed) return;
      compatibility.panel.replaceChildren();
      const keys = Object.keys(compatibilityDefaults).filter(key => draft[key] !== undefined && JSON.stringify(draft[key]) !== JSON.stringify(compatibilityDefaults[key]));
      compatibility.section.hidden = !keys.length;
      for (const key of keys) {
        const slot = row(compatibility, 'compatibility-' + key, compatibilityLabels[key], compatibilitySummary(key, draft[key]), { icon: 'history' });
        slot.parentElement.dataset.sdkCompatibility = key;
        const reset = node('button', 'rgp-button rgp-reset', '恢复默认'); reset.type = 'button'; reset.dataset.sdkReset = key;
        reset.setAttribute('aria-label', '恢复' + compatibilityLabels[key] + '的默认值');
        reset.addEventListener('click', () => {
          const position = keys.indexOf(key);
          update(key, structuredClone(compatibilityDefaults[key])); renderCompatibility();
          const remaining = compatibility.panel.querySelectorAll('[data-sdk-reset]');
          const focusTarget = remaining[Math.min(position, remaining.length - 1)] || tools.panel.querySelector('textarea, button');
          focusTarget?.focus({ preventScroll: true });
        }); slot.append(reset);
      }
    }
    renderCompatibility();

    return {
      setModelCapability(info) { modelCapability = info; renderCompatibility(); },
      setValue(next = {}) {
        if (disposed) return;
        if (dropdowns.some(item => !item.popup.hidden)) root.closeCustomSelect?.();
        draft = structuredClone(next); painters.forEach(paint => paint()); renderCompatibility();
      },
      destroy() {
        if (dropdowns.some(item => !item.popup.hidden)) root.closeCustomSelect?.();
        disposed = true; sections.forEach(section => section.remove()); painters.length = dropdowns.length = 0;
      },
    };
  }
  root.RelaySdkRuntimeControls = { create };
})(window);
