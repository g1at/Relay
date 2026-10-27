/* Media bindings share Relay's settings rows and top-layer menus. */
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const icons = {
    image:'<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m21 16-5-5L7 20"/>',
    video:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
    chevron:'<path d="m9 6 6 6-6 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',
    settings:'<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  let choiceId = 0;
  const parameters = () => root.RelayMediaParameters || (typeof require === 'function' ? require('./media-parameters') : null);
  function parameterDescriptors(capabilities) { return parameters().parameterDescriptors(capabilities); }
  function mountParameters(host, model, initialValues, rawDraft) { return parameters().mountParameters(host, model, initialValues, rawDraft); }
  function parseEditorJSON(input, label) {
    try { const value=JSON.parse(input.value||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();input.setCustomValidity('');return value; }
    catch (_) {const message=`${label} JSON 格式不正确`;input.setCustomValidity(message);throw new Error(message);}
  }
  function mountChoice(select) {
    const holder=document.createElement('div');holder.className='media-choice';
    holder.innerHTML=root.buildCustomSelect(`media-choice-${++choiceId}`,Array.from(select.options,o=>({value:o.value,label:o.textContent})),select.value);
    const custom=holder.firstElementChild,old=custom.querySelector('.cs-trigger'),trigger=document.createElement('button');
    trigger.type='button';trigger.className=old.className;trigger.innerHTML=old.innerHTML;trigger.setAttribute('aria-label',select.getAttribute('aria-label')||'选择');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');old.replaceWith(trigger);
    select.hidden=true;select.after(holder);root.bindCustomSelects(holder);
    const popup=custom.querySelector('.cs-popup'),options=Array.from(custom.querySelectorAll('.cs-option'));popup.setAttribute('role','listbox');
    const refresh=()=>{custom.dataset.value=select.value;custom.querySelector('.cs-text').textContent=select.selectedOptions[0]?.textContent||'选择';options.forEach(o=>{o.classList.toggle('selected',o.dataset.value===select.value);o.setAttribute('aria-selected',String(o.dataset.value===select.value));});};
    options.forEach(o=>{o.tabIndex=-1;o.setAttribute('role','option');o.addEventListener('click',()=>{const changed=select.value!==o.dataset.value;select.value=o.dataset.value;if(changed)select.dispatchEvent(new Event('change',{bubbles:true}));refresh();trigger.focus({preventScroll:true});});});
    select.addEventListener('change',refresh);select.refreshMediaChoice=refresh;
    custom.addEventListener('keydown',event=>{
      if(!['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape'){root.closeCustomSelect();trigger.focus({preventScroll:true});return;}
      const index=options.indexOf(document.activeElement);
      if(['Enter',' '].includes(event.key)&&index>=0){options[index].click();return;}
      if(popup.hidden)trigger.click();
      let next=index<0?Math.max(0,options.findIndex(o=>o.classList.contains('selected'))):index;
      if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;
      else if(index>=0&&event.key==='ArrowDown')next=(index+1)%options.length;else if(index>=0&&event.key==='ArrowUp')next=(index-1+options.length)%options.length;
      options[next]?.focus({preventScroll:true});if(options[next])root.revealCustomSelectOption(popup,options[next]);
    });refresh();
  }
  function mountProvider(host, seed, api) {
    let bindings = clone(seed.mediaModels || []), catalog = [], presets = null, activeIndex = -1;
    let discovery = { enabled: false, loading: false }, saving = false;
    const lockedControls = new Map();
    function lockControls() {
      if (!saving) return;
      for (const control of host.querySelectorAll('input, button, select, textarea')) {
        if (!lockedControls.has(control)) lockedControls.set(control, control.disabled);
        control.disabled = true;
      }
    }
    const selected = new Set(), templateValues = new Map(), automatic = new Set();
    const connection = clone(seed.mediaConnection || { preset: 'custom' });
    const rawId = item => String(item?.rawId || item?.modelId || item?.id || '').trim();
    const ownerOf = item => String(item?.ownedBy || item?.owned_by || '').trim();
    const catalogKey = item => JSON.stringify([rawId(item), ownerOf(item)]);
    const bindingKey = item => JSON.stringify([item.modelId || '', ownerOf(item)]);
    const setupFor = value => {
      const item = presets?.capabilities?.find(item => item.id === value?.setup?.templateId);
      if (value?.setup?.source === 'family-template') return `已匹配${item ? ` · ${item.label}` : ''}`;
      if (value?.setup?.source === 'legacy-template') return `模板已更新${item ? ` · ${item.label}` : ''}`;
      if (value?.setup?.source === 'directory' || automatic.has(value?.id)) return '已自动配置';
      return '';
    };
    function configurationFor(item) {
      if (item?.mediaConfig) return { ...clone(item.mediaConfig), setup: { source: 'directory' } };
      const match = root.RelayMediaTemplateMatching?.matchMediaTemplate(item);
      const template = match && presets?.capabilities?.find(value => value.id === match.templateId);
      return template ? { protocol: template.protocol, capabilities: clone(template.capabilities),
        setup: { source: 'family-template', templateId: match.templateId, version: presets.templateVersion } } : null;
    }
    for (const binding of bindings) if (binding.setup?.templateId) templateValues.set(binding.id, binding.setup.templateId);
    const connectionLabels = { custom: '自定义', mify: 'Mify', openai: 'OpenAI', ark: '火山 Ark', dashscope: '阿里云 DashScope' };
    host.innerHTML = `<div class="provider-edit-section-head media-section-head"><h3 class="provider-edit-section-title">图片与视频</h3><div class="provider-section-actions">
      <button type="button" class="media-text-action" data-connection-toggle aria-expanded="false" title="媒体连接设置">${svg('settings')}<span data-connection-label></span></button>
      <button type="button" class="provider-inline-btn media-add-button" data-add aria-haspopup="dialog" aria-expanded="false">${svg('plus')}添加模型</button></div></div>
      <div class="provider-edit-panel media-connection" hidden><div class="provider-edit-row"><span class="provider-edit-label"><strong>连接方式</strong></span><div><select data-preset aria-label="媒体连接方式"></select></div></div><details class="media-advanced"><summary>${svg('chevron')}高级配置</summary><div class="media-advanced-body"><textarea data-connection aria-label="媒体连接 JSON" spellcheck="false"></textarea></div></details></div>
      <div class="provider-edit-panel media-bindings" data-bindings></div>
      <div class="media-add-popover" popover="auto" data-add-popover role="dialog" aria-label="添加媒体模型">
      <input type="search" data-search placeholder="搜索图片或视频模型…" aria-label="搜索媒体模型" autocomplete="off">
      <div class="media-catalog-results" data-catalog-results></div><div class="media-catalog-footer"><button type="button" class="media-manual-add" data-add-manual>${svg('plus')}手动添加</button><button type="button" class="provider-inline-btn" data-add-selected disabled>添加</button></div></div>
      <select data-catalog aria-label="从目录添加媒体模型" hidden></select>`;
    const preset = host.querySelector('[data-preset]'), connectionJson = host.querySelector('[data-connection]');
    for (const [value, label] of Object.entries(connectionLabels)) preset.add(new Option(label, value));
    preset.value = connection.preset || 'custom'; connectionJson.value = JSON.stringify(connection, null, 2);
    const connectionPanel = host.querySelector('.media-connection'), connectionToggle = host.querySelector('[data-connection-toggle]');
    const showConnection = () => { connectionPanel.hidden = false; connectionToggle.setAttribute('aria-expanded', 'true'); };
    const refreshConnectionLabel = () => { host.querySelector('[data-connection-label]').textContent = connectionLabels[preset.value] || '连接设置'; };
    preset.addEventListener('change', () => {
      try { const value = parseEditorJSON(connectionJson, '连接'); value.preset = preset.value; connectionJson.value = JSON.stringify(value, null, 2); refreshConnectionLabel(); }
      catch (_) { showConnection(); connectionJson.closest('details').open = true; connectionJson.reportValidity(); }
    });
    connectionJson.addEventListener('change', () => {
      try { const value = parseEditorJSON(connectionJson, '连接'); if (connectionLabels[value.preset]) preset.value = value.preset; preset.refreshMediaChoice?.(); refreshConnectionLabel(); }
      catch (_) { connectionJson.reportValidity(); }
    });
    mountChoice(preset); refreshConnectionLabel();
    connectionToggle.onclick = () => { connectionPanel.hidden = !connectionPanel.hidden; connectionToggle.setAttribute('aria-expanded', String(!connectionPanel.hidden)); };
    const container = host.querySelector('[data-bindings]');
    function collect() { for (const row of container.querySelectorAll('.media-binding')) row._read(); }
    const field = (label, content) => `<div class="provider-edit-row"><span class="provider-edit-label"><strong>${label}</strong></span><div class="media-field-value">${content}</div></div>`;
    function render() {
      root.closeCustomSelect?.(); container.replaceChildren();
      if (!bindings.length) {
        const empty = document.createElement('div'); empty.className = 'media-empty'; empty.textContent = '从模型目录勾选添加'; container.append(empty);
      }
      bindings.forEach((binding, index) => {
        const row = document.createElement('article'); row.className = 'media-binding';
        row.innerHTML = `<div class="media-binding-summary"><button type="button" class="media-binding-main" data-edit aria-expanded="false"><span class="media-model-icon"></span><span class="media-model-copy"><strong data-name></strong><span data-subtitle></span></span><span class="media-row-chevron">${svg('chevron')}</span></button><input type="checkbox" class="media-model-switch" data-enabled role="switch"></div>
          <section class="media-binding-editor" data-editor hidden><div class="media-binding-fields">
          ${field('模板', '<select data-template aria-label="配置模板"></select>')}
          <div data-defaults class="media-binding-defaults"></div></div>
          <details class="media-advanced" data-advanced><summary>${svg('chevron')}高级设置</summary><div class="media-advanced-body">
          ${field('模型 ID', '<input class="provider-edit-inline-input provider-model-input" data-id aria-label="远端模型 ID" placeholder="输入模型 ID" spellcheck="false">')}
          ${field('显示名称', '<input class="provider-edit-inline-input" data-label aria-label="显示名称" placeholder="与模型 ID 相同">')}
          ${field('协议', '<select data-protocol aria-label="协议"></select>')}
          ${field('路由供应商', '<input class="provider-edit-inline-input" data-owner aria-label="网关路由供应商" placeholder="默认" spellcheck="false">')}
          <details class="media-json-details"><summary>${svg('chevron')}编辑配置 JSON</summary><textarea data-json aria-label="模型绑定 JSON" spellcheck="false"></textarea></details></div></details>
          <div class="media-binding-error" role="alert" hidden></div><div class="media-binding-footer"><button type="button" class="media-remove" data-remove>移除模型</button><button type="button" class="provider-inline-btn" data-done>收起</button></div></section>`;
        const id = row.querySelector('[data-id]'), protocol = row.querySelector('[data-protocol]'), enabled = row.querySelector('[data-enabled]');
        const label = row.querySelector('[data-label]'), owner = row.querySelector('[data-owner]'), json = row.querySelector('[data-json]');
        const editor = row.querySelector('[data-editor]'), editButton = row.querySelector('[data-edit]'), error = row.querySelector('.media-binding-error');
        const template = row.querySelector('[data-template]'), defaults = row.querySelector('[data-defaults]');
        let readDefaults = null;
        const title = () => label.value.trim() || id.value.trim() || '新模型';
        const updateSummary = () => {
          const contract = presets?.protocols?.find(item => item.id === protocol.value);
          row.querySelector('.media-model-icon').innerHTML = svg((contract?.modality || bindings[index]?.modality) === 'video' ? 'video' : 'image');
          row.querySelector('[data-name]').textContent = title(); row.querySelector('[data-name]').title = title();
          row.querySelector('[data-subtitle]').textContent = [contract ? (setupFor(bindings[index]) || contract.label) : '请选择一个模板', owner.value.trim()].filter(Boolean).join(' · ');
          row.classList.toggle('is-disabled', !enabled.checked); row.classList.toggle('needs-template', !contract);
          editButton.setAttribute('aria-label', `编辑 ${title()}`); enabled.setAttribute('aria-label', `启用 ${title()}`); enabled.setAttribute('aria-checked', String(enabled.checked));
        };
        const open = value => { editor.hidden = !value; editButton.setAttribute('aria-expanded', String(value)); row.classList.toggle('is-editing', value); };
        const fail = caught => { activeIndex = index; open(true); error.hidden = false; error.textContent = caught.message; if (json.validationMessage) { row.querySelector('[data-advanced]').open = true; json.closest('details').open = true; } };
        id.value = binding.modelId || ''; label.value = binding.label || ''; owner.value = ownerOf(binding); enabled.checked = binding.enabled !== false;
        protocol.add(new Option('选择协议', ''));
        if (!presets && binding.protocol) protocol.add(new Option(binding.protocol, binding.protocol));
        for (const item of presets?.protocols || []) protocol.add(new Option(item.label, item.id));
        protocol.value = binding.protocol || ''; json.value = JSON.stringify(binding, null, 2);
        template.add(new Option(binding.protocol ? (automatic.has(binding.id) ? '自动识别' : '保留当前配置') : '选择模板', ''));
        for (const item of presets?.capabilities || []) {
          // New typed directory candidates need only the templates for that type.
          const modality = presets.protocols.find(p => p.id === item.protocol)?.modality;
          if (!binding.protocol && binding.modality && modality !== binding.modality) continue;
          template.add(new Option(item.label, item.id));
        }
        template.value = templateValues.get(binding.id) || '';
        const renderDefaults = () => { readDefaults = mountParameters(defaults, bindings[index]); defaults.hidden = !defaults.children.length; };
        const sync = () => {
          try {
            const value = parseEditorJSON(json, '模型绑定');
            if (readDefaults && value.capabilities) {
              const values = readDefaults(), next = { ...(value.capabilities.defaults || {}) };
              for (const descriptor of parameterDescriptors(value.capabilities)) delete next[descriptor.key];
              value.capabilities.defaults = { ...next, ...values };
            }
            Object.assign(value, { modelId: id.value.trim(), label: label.value.trim(), ownedBy: owner.value.trim(), protocol: protocol.value,
              modality: presets?.protocols?.find(item => item.id === protocol.value)?.modality || binding.modality, enabled: enabled.checked });
            bindings[index] = value; json.value = JSON.stringify(value, null, 2); error.hidden = true; updateSummary();
          } catch (caught) { fail(caught); throw caught; }
        };
        const edit = action => { try { action(); } catch (caught) { fail(caught); } };
        const applyBinding = value => {
          bindings[index] = value; id.value = value.modelId || ''; label.value = value.label || ''; owner.value = ownerOf(value);
          protocol.value = value.protocol || ''; enabled.checked = value.enabled !== false; protocol.refreshMediaChoice?.();
          template.options[0].textContent = value.protocol ? (automatic.has(binding.id) ? '自动识别' : '保留当前配置') : '选择模板';
          template.refreshMediaChoice?.();
          json.value = JSON.stringify(value, null, 2); error.hidden = true; renderDefaults(); updateSummary();
        };
        [id, label, owner, enabled].forEach(control => control.addEventListener('change', () => edit(() => {
          sync();
          if (control === id) {
            bindings[index].setup = { source: 'manual' }; automatic.delete(binding.id); templateValues.delete(binding.id);
            template.value = ''; template.refreshMediaChoice?.(); applyBinding(bindings[index]);
          }
        })));
        [id, label].forEach(control => control.addEventListener('input', updateSummary));
        protocol.addEventListener('change', () => edit(() => {
          sync(); const chosen = presets?.protocols?.find(item => item.id === protocol.value);
          bindings[index].capabilities = { operations: chosen ? [chosen.operations[0]] : [], parameters: {}, defaults: {}, references: { max: 0 } };
          bindings[index].setup = { source: 'manual' };
          delete bindings[index].editTransport; automatic.delete(binding.id); templateValues.delete(binding.id); template.value = ''; template.refreshMediaChoice?.();
          applyBinding(bindings[index]);
        }));
        json.addEventListener('change', () => edit(() => {
          const value = parseEditorJSON(json, '模型绑定'); automatic.delete(binding.id); templateValues.delete(binding.id);
          value.setup = { source: 'manual' };
          template.value = ''; template.refreshMediaChoice?.(); applyBinding(value);
        }));
        template.addEventListener('change', () => edit(() => {
          const item = presets.capabilities.find(value => value.id === template.value);
          if (!item) return;
          sync(); const value = bindings[index]; if (value.protocol !== item.protocol) delete value.editTransport;
          value.protocol = item.protocol; value.modality = presets.protocols.find(p => p.id === item.protocol).modality;
          value.capabilities = clone(item.capabilities); value.setup = { source: 'manual-template', templateId: item.id, version: presets.templateVersion };
          templateValues.set(binding.id, item.id); automatic.delete(binding.id); applyBinding(value);
        }));
        defaults.addEventListener('change', () => edit(sync));
        editButton.disabled = !presets; enabled.disabled = !presets;
        editButton.onclick = () => { try { collect(); } catch (_) { return; } activeIndex = activeIndex === index ? -1 : index; render(); container.children[index]?.querySelector('[data-edit]').focus({ preventScroll: true }); };
        row.querySelector('[data-done]').onclick = () => { try { collect(); } catch (_) { return; } activeIndex = -1; render(); container.children[index]?.querySelector('[data-edit]').focus({ preventScroll: true }); };
        row.querySelector('[data-remove]').onclick = () => {
          try { collect(); } catch (_) { return; }
          templateValues.delete(binding.id); automatic.delete(binding.id); bindings.splice(index, 1); activeIndex = -1; render(); renderCatalog();
        };
        if (!binding.modelId) row.querySelector('.media-binding-fields').prepend(id.closest('.provider-edit-row'));
        row._read = sync; container.append(row); mountChoice(protocol); mountChoice(template); renderDefaults(); updateSummary(); open(activeIndex === index);
      });
      lockControls();
    }
    const add = host.querySelector('[data-add]'), popover = host.querySelector('[data-add-popover]'), search = host.querySelector('[data-search]');
    const picker = host.querySelector('[data-catalog]'), addSelected = host.querySelector('[data-add-selected]');
    let addFrame = 0;
    function closeAdd() { cancelAnimationFrame(addFrame); if (popover.matches(':popover-open')) popover.hidePopover(); add.setAttribute('aria-expanded', 'false'); }
    function positionAdd() {
      if (!popover.matches(':popover-open')) return;
      if (!add.isConnected || !add.checkVisibility({ visibilityProperty: true })) { closeAdd(); return; }
      const rect = add.getBoundingClientRect(); let top = 0, bottom = innerHeight;
      for (let parent = add.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) { const r = parent.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
      }
      if (rect.bottom <= top || rect.top >= bottom) { closeAdd(); return; }
      const width = Math.min(390, innerWidth - 24), below = innerHeight - rect.bottom - 16, above = rect.top - 16, upward = below < 290 && above > below;
      popover.style.width = `${width}px`; popover.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
      popover.style.maxHeight = `${Math.max(0, Math.min(420, upward ? above : below))}px`; popover.style.top = upward ? 'auto' : `${rect.bottom + 6}px`; popover.style.bottom = upward ? `${innerHeight - rect.top + 6}px` : 'auto';
      addFrame = requestAnimationFrame(positionAdd);
    }
    function newBinding(item) {
      const metadata = configurationFor(item), contract = presets?.protocols.find(p => p.id === metadata?.protocol);
      const type = String(item?.modality || item?.model_type || item?.modelType || '').toLowerCase();
      const modality = ['video', 'video_generation', 'text_to_video', 'image_to_video'].includes(type) ? 'video'
        : ['image', 'image_generation', 'text_to_image', 'image_to_image'].includes(type) ? 'image' : '';
      const value = { id: `binding-${crypto.randomUUID()}`, modelId: rawId(item), label: '', ownedBy: ownerOf(item),
        protocol: contract?.id || '', modality: contract?.modality || modality, enabled: true,
        capabilities: contract ? clone(metadata.capabilities || { operations: [contract.operations[0]], parameters: {}, defaults: {}, references: { max: 0 } }) : { operations: [], parameters: {}, defaults: {}, references: { max: 0 } } };
      if (contract) {
        value.setup = metadata.setup;
        if (metadata.setup.source === 'directory') automatic.add(value.id);
        if (metadata.setup.templateId) templateValues.set(value.id, metadata.setup.templateId);
        if (metadata.editTransport) value.editTransport = metadata.editTransport;
      }
      return value;
    }
    function addBindings(items) {
      if (saving || !presets) return;
      try { collect(); } catch (_) { closeAdd(); return; }
      const existing = new Set(bindings.map(bindingKey)), added = [];
      for (const item of items) {
        if (item && existing.has(catalogKey(item))) continue;
        const value = newBinding(item); bindings.push(value); added.push(bindings.length - 1); existing.add(bindingKey(value));
      }
      selected.clear(); closeAdd(); activeIndex = added.find(index => !bindings[index].protocol) ?? -1;
      render(); renderCatalog();
      const target = container.children[activeIndex >= 0 ? activeIndex : (added[0] ?? 0)];
      if (target) {
        const control = activeIndex >= 0 ? (bindings[activeIndex].modelId ? target.querySelector('[data-template]').nextElementSibling.querySelector('.cs-trigger') : target.querySelector('[data-id]')) : target.querySelector('[data-edit]');
        control?.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }
    }
    function updateSelected() {
      addSelected.disabled = !selected.size || !presets;
      addSelected.textContent = selected.size ? `添加 ${selected.size} 个` : '添加';
    }
    function renderCatalog() {
      const results = host.querySelector('[data-catalog-results]'); results.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase(), existing = new Set(bindings.map(bindingKey));
      const matches = catalog.filter(item => `${rawId(item)} ${ownerOf(item)}`.toLocaleLowerCase().includes(query));
      for (const item of matches) {
        const key = catalogKey(item), added = existing.has(key), row = document.createElement('label'); row.className = 'media-catalog-option';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.catalogCheck = ''; checkbox.value = key; checkbox.disabled = added; checkbox.checked = added || selected.has(key);
        checkbox.setAttribute('aria-label', `${rawId(item)}${ownerOf(item) ? ` · ${ownerOf(item)}` : ''}`);
        const copy = document.createElement('span'); copy.className = 'media-catalog-copy';
        const name = document.createElement('span'); name.textContent = rawId(item); name.title = name.textContent;
        const config = configurationFor(item);
        const detail = document.createElement('small'); detail.textContent = [ownerOf(item), added ? '已添加' : config?.setup.source === 'family-template' ? '已匹配模板' : config ? '自动配置' : '需选模板'].filter(Boolean).join(' · ');
        copy.append(name, detail); row.append(checkbox, copy); row.classList.toggle('is-added', added);
        checkbox.onchange = () => { if (checkbox.checked) selected.add(key); else selected.delete(key); updateSelected(); }; results.append(row);
      }
      if (!matches.length) {
        const empty = document.createElement('div'); empty.className = 'media-catalog-empty'; empty.textContent = query ? '未找到模型' : (discovery.loading ? '正在刷新…' : '暂无模型，请先刷新'); results.append(empty);
      }
      updateSelected();
      lockControls();
    }
    add.disabled = true;
    add.onclick = () => {
      if (saving || !presets) return;
      if (popover.matches(':popover-open')) { closeAdd(); return; }
      try { collect(); } catch (_) { return; }
      root.closeCustomSelect?.(); search.value = ''; renderCatalog(); popover.showPopover(); positionAdd();
      add.setAttribute('aria-expanded', 'true'); search.focus({ preventScroll: true });
    };
    popover.addEventListener('toggle', event => { add.setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState !== 'open') cancelAnimationFrame(addFrame); });
    popover.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAdd(); add.focus({ preventScroll: true }); }
      else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const choices = [search, ...popover.querySelectorAll('input[type=checkbox]:not(:disabled),button:not(:disabled)')], current = choices.indexOf(document.activeElement);
        event.preventDefault(); choices[(current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
      }
    });
    search.addEventListener('input', renderCatalog);
    host.querySelector('[data-add-manual]').onclick = () => addBindings([null]);
    addSelected.onclick = () => addBindings(catalog.filter(item => selected.has(catalogKey(item))));
    picker.onchange = () => { if (picker.value !== '' && presets) { addBindings([catalog[Number(picker.value)]]); picker.value = ''; } };
    function applyCatalog(items) {
      const source = Array.isArray(items) ? items : items?.models || [], seen = new Set();
      catalog = source.filter(item => { if (!item || !rawId(item)) return false; const key = catalogKey(item); if (seen.has(key)) return false; seen.add(key); return true; });
      for (const key of selected) if (!seen.has(key)) selected.delete(key);
      picker.replaceChildren(new Option('从目录添加', '')); catalog.forEach((item, index) => picker.add(new Option(rawId(item), String(index)))); renderCatalog();
    }
    function setDiscoveryState(value) {
      discovery = { ...discovery, ...value };
      renderCatalog();
    }
    function setSaving(value) {
      saving = !!value;
      host.inert = saving;
      if (saving) { closeAdd(); root.closeCustomSelect?.(); lockControls(); }
      else {
        for (const [control, disabled] of lockedControls) control.disabled = disabled;
        lockedControls.clear();
        add.disabled = !presets; updateSelected(); setDiscoveryState(discovery);
      }
    }
    api.mediaPresets().then(result => {
      if (!result.ok) throw new Error(result.message); presets = result; add.disabled = false; render(); renderCatalog();
    }).catch(() => { add.title = '模板加载失败'; });
    render(); applyCatalog(seed.mediaCatalog?.models || seed.mediaCatalog || []); setDiscoveryState(discovery);
    return { applyCatalog, setDiscoveryState, setSaving, read() {
      if (!presets && bindings.length) throw new Error('媒体模板仍在加载，请稍后保存'); collect();
      const incomplete = bindings.findIndex(binding => !binding.protocol || !binding.modelId);
      if (incomplete >= 0) {
        activeIndex = incomplete; render(); const row = container.children[incomplete];
        const control = !bindings[incomplete].modelId ? row.querySelector('[data-id]') : row.querySelector('[data-template]').nextElementSibling.querySelector('.cs-trigger');
        if (!bindings[incomplete].modelId) row.querySelector('[data-advanced]').open = true;
        row.scrollIntoView({ block: 'nearest', behavior: 'instant' }); control.focus({ preventScroll: true });
        throw new Error(!bindings[incomplete].modelId ? '请填写媒体模型 ID' : `请为「${bindings[incomplete].label || bindings[incomplete].modelId}」选择模板`);
      }
      let mediaConnection;
      try { mediaConnection = parseEditorJSON(connectionJson, '连接'); }
      catch (error) { showConnection(); connectionJson.closest('details').open = true; throw error; }
      mediaConnection.preset = preset.value; return { mediaConnection, mediaModels: bindings };
    } };
  }
  const api = { parameterDescriptors, mountParameters, mountProvider };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.RelayMediaUI = api;
})(typeof window === 'object' ? window : globalThis);
