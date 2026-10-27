/* Capability-driven media controls. The composer keeps its parameters in a
   lightweight popover; settings use the same fields in their existing rows. */
(function (root) {
  'use strict';
  const labels = {
    size: '尺寸', n: '数量', duration: '时长（秒）', resolution: '分辨率', ratio: '比例',
    audio: '声音', quality: '画质', watermark: '水印', promptExtend: '扩写提示词',
    outputFormat: '格式', sequential: '组图', seed: '随机种子', background: '背景',
    responseFormat: '返回格式', negativePrompt: '负面提示词', enableThinking: '思考', layerDecomposition: '分层',
    outputCompression: '压缩质量', promptOptimize: '提示词优化', promptExtendMode: '扩写方式', moderation: '内容审核',
  };
  const booleanKeys = new Set(['audio', 'watermark', 'promptExtend', 'sequential', 'enableThinking', 'layerDecomposition']);
  const numberKeys = new Set(['n', 'duration', 'seed', 'outputCompression']);
  const advancedKeys = new Set(['watermark', 'seed', 'responseFormat', 'outputCompression', 'negativePrompt', 'promptExtend', 'promptExtendMode', 'promptOptimize', 'enableThinking', 'layerDecomposition', 'moderation']);
  const mounted = new WeakMap();
  let pickerId = 0;
  const sliders = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h5m4 0h5M3 10h9m4 0h1M3 15h1m4 0h9"/><circle cx="10" cy="5" r="2"/><circle cx="14" cy="10" r="2"/><circle cx="6" cy="15" r="2"/></svg>';

  function parameterDescriptors(capabilities = {}) {
    return Object.entries(capabilities.parameters || {}).filter(([key, rule]) => labels[key] && rule !== false)
      .map(([key, rule]) => ({ key, label: labels[key], rule: {
        ...(booleanKeys.has(key) ? { type: 'boolean' } : numberKeys.has(key) ? { type: 'number', integer: true } : {}),
        ...rule,
      }, value: capabilities.defaults?.[key] }));
  }
  function inputValue(control, rule) {
    if (!control.value.trim()) return undefined;
    if (rule.type === 'boolean') return control.value === 'true';
    return rule.type === 'number' || rule.integer || rule.min != null || rule.max != null
      ? Number(control.value) : control.value.trim();
  }
  function optionLabel(key, value) {
    const text = String(value);
    if (text === '') return '默认';
    if (text === 'true') return '开';
    if (text === 'false') return '关';
    if (key === 'quality') return ({ low: '快速', medium: '标准', high: '精细', xhigh: '超清', max: '最高', auto: '自动' })[text] || text;
    if (key === 'background') return ({ auto: '自动', transparent: '透明', opaque: '不透明' })[text] || text;
    if (key === 'size') return text === 'auto' ? '自动' : text.replace(/^(\d+)[x*](\d+)$/, '$1 × $2');
    if (key === 'duration') return text === '-1' ? '自动' : text + ' 秒';
    if (key === 'n') return text + ' 张';
    if (key === 'outputFormat') return text.toUpperCase();
    if (key === 'ratio' && text === 'adaptive') return '自适应';
    if (key === 'promptOptimize') return ({ standard: '标准', fast: '快速' })[text] || text;
    if (key === 'promptExtendMode') return ({ direct: '直接', agent: '智能体' })[text] || text;
    if (key === 'responseFormat') return ({ url: '链接', b64_json: 'Base64' })[text] || text;
    if (key === 'moderation') return ({ auto: '标准', low: '宽松' })[text] || text;
    return text;
  }
  function button(text, className, label) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = className; node.textContent = text;
    if (label) node.setAttribute('aria-label', label);
    return node;
  }

  // Preserve the canonical select; Relay's shared menu owns the visible UI.
  function mountChoice(select) {
    select.hidden = true; select.tabIndex = -1;
    const holder = document.createElement('span'); holder.className = 'media-parameter-select-host'; select.after(holder);
    const id = `media-parameter-picker-${++pickerId}`;
    let signature = '', wrapper, trigger, popup, items = [];
    const close = () => { if (popup?.matches(':popover-open')) root.closeCustomSelect(); };
    const refresh = () => {
      const options = Array.from(select.options, option => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
      if (!options.length) options.push({ value: '', label: '暂无选项', disabled: true });
      const nextSignature = JSON.stringify(options);
      if (!wrapper || nextSignature !== signature) {
        close(); signature = nextSignature;
        holder.innerHTML = root.buildCustomSelect(id, options, select.value);
        wrapper = holder.firstElementChild;
        wrapper.dataset.popupHeight = '248';
        const old = wrapper.querySelector('.cs-trigger'); trigger = button('', 'cs-trigger media-parameter-select-trigger');
        trigger.innerHTML = old.innerHTML; old.replaceWith(trigger);
        trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择');
        trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
        popup = wrapper.querySelector('.cs-popup'); popup.id = id + '-options'; popup.setAttribute('role', 'listbox');
        popup.setAttribute('aria-label', select.getAttribute('aria-label') || '选择'); trigger.setAttribute('aria-controls', popup.id);
        items = Array.from(popup.querySelectorAll('.cs-option'));
        items.forEach((item, index) => {
          item.tabIndex = -1; item.setAttribute('role', 'option'); item.setAttribute('aria-disabled', String(options[index].disabled));
          item.addEventListener('click', event => {
            event.preventDefault();
            if (select.disabled || select.closest('[inert]') || options[index].disabled) event.stopImmediatePropagation();
          }, true);
        });
        trigger.addEventListener('click', event => {
          if (select.disabled || select.closest('[inert]')) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        root.bindCustomSelects(holder);
        wrapper.classList.replace('custom-select', 'media-parameter-picker');
        items.forEach(item => item.addEventListener('click', () => {
          select.value = item.dataset.value;
          select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
          refresh();
          if (!holder.parentElement.contains(document.activeElement) || popup.contains(document.activeElement)) trigger.focus({ preventScroll: true });
        }));
        bindChoiceKeyboard();
      }
      wrapper.dataset.value = select.value;
      const caption = select.selectedOptions[0]?.textContent || '选择';
      wrapper.querySelector('.cs-text').textContent = caption; trigger.title = caption;
      trigger.disabled = select.disabled; trigger.setAttribute('aria-invalid', select.getAttribute('aria-invalid') || 'false');
      items.forEach(item => { const selected = item.dataset.value === select.value; item.classList.toggle('selected', selected); item.setAttribute('aria-selected', String(selected)); });
      if (select.disabled) close();
    };
    function bindChoiceKeyboard() {
      wrapper.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
          if (!popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus({ preventScroll: true }); }
          return;
        }
        if (event.key === 'Tab') { if (!popup.hidden) { close(); trigger.focus({ preventScroll: true }); } return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) || select.disabled) return;
        event.preventDefault(); event.stopPropagation();
        const available = items.filter(item => item.getAttribute('aria-disabled') !== 'true');
        const index = available.indexOf(document.activeElement);
        if (['Enter', ' '].includes(event.key) && index >= 0) { available[index].click(); return; }
        if (popup.hidden) trigger.click();
        let next = index < 0 ? Math.max(0, available.findIndex(item => item.dataset.value === select.value)) : index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = available.length - 1;
        else if (index >= 0 && event.key === 'ArrowDown') next = (index + 1) % available.length;
        else if (index >= 0 && event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length;
        available[next]?.focus({ preventScroll: true });
        if (available[next]) root.revealCustomSelectOption(popup, available[next]);
      });
    }
    select.refreshMediaChoice = refresh;
    select.addEventListener('input', refresh); select.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-invalid', 'value', 'label'] });
    refresh();
    return { close, dispose() { close(); observer.disconnect(); select.removeEventListener('input', refresh); select.removeEventListener('change', refresh); delete select.refreshMediaChoice; } };
  }

  function sizeError(rule, value) {
    if (!value) return rule.required ? '请选择尺寸' : '';
    if (rule.maxLength != null && Array.from(value).length > rule.maxLength) return `尺寸最多 ${rule.maxLength} 个字符`;
    const preset = Array.isArray(rule.enum) && rule.enum.includes(value);
    if (Array.isArray(rule.enum) && !preset && !rule.allowCustom) return '尺寸的原值不在当前允许范围内，请重新选择';
    try {
      if (rule.pattern && !(preset && rule.allowCustom) && !(new RegExp(rule.pattern)).test(value)) return '尺寸请填写允许的宽和高';
    } catch (_) { return '尺寸规则配置有误，请检查高级配置中的 pattern'; }
    const dimensions = /^(\d+)[x*](\d+)$/.exec(value);
    if (dimensions) {
      const width = Number(dimensions[1]), height = Number(dimensions[2]), pixels = width * height, ratio = width / height;
      if (width <= 0 || height <= 0 || !Number.isSafeInteger(pixels) || (rule.minPixels != null && pixels < rule.minPixels) || (rule.maxPixels != null && pixels > rule.maxPixels)) return '尺寸的总像素超出允许范围';
      if ((rule.minEdge != null && Math.min(width, height) < rule.minEdge) || (rule.maxEdge != null && Math.max(width, height) > rule.maxEdge)) return '尺寸的边长超出允许范围';
      if (rule.multipleOf && (width % rule.multipleOf || height % rule.multipleOf)) return `尺寸的宽和高须为 ${rule.multipleOf} 的倍数`;
      if ((rule.minRatio != null && ratio < rule.minRatio) || (rule.maxRatio != null && ratio > rule.maxRatio)) return '尺寸的宽高比超出允许范围';
    } else if (!preset && (rule.minPixels != null || rule.maxPixels != null)) return '尺寸请填写允许的宽和高';
    return '';
  }

  function dimensionValue(rule, width, height, preferred = 'x') {
    const candidates = Array.from(new Set([preferred, 'x', '*'])).map(separator => `${width}${separator}${height}`);
    return candidates.find(value => !sizeError(rule, value)) || candidates.find(value => {
      try { return rule.pattern && new RegExp(rule.pattern).test(value); } catch (_) { return false; }
    }) || candidates[0];
  }

  function sizeOptions(rule, value) {
    const options = (rule.enum || []).map(value => ({ value: String(value), label: optionLabel('size', value) }));
    const custom = !Array.isArray(rule.enum) || rule.allowCustom === true;
    const separator = typeof value === 'string' && /^\d+\*\d+$/.test(value) ? '*' : 'x';
    // UI shortcuts are filtered by the saved contract. They never widen an
    // enum, rewrite a binding or depend on a provider/model identity.
    if (custom && !options.some(item => /^\d+(?:\.\d+)?K$/i.test(item.value))) {
      for (const [width, height] of [[1024, 1024], [1536, 1024], [1024, 1536], [2048, 2048], [2048, 1152], [1152, 2048], [1280, 1280]]) {
        const candidate = dimensionValue(rule, width, height, separator);
        if (!sizeError(rule, candidate) && !options.some(item => item.value === candidate)) {
          options.push({ value: candidate, label: `${width === height ? '方形' : width > height ? '横向' : '纵向'} · ${width} × ${height}` });
        }
      }
    }
    return { options, custom, separator };
  }

  function mountParameters(host, model, initialValues, rawDraft) {
    mounted.get(host)?.();
    host.replaceChildren();
    const compact = host.id === 'cvMediaParameters';
    host.classList.toggle('media-parameters-compact', compact);
    host.classList.toggle('media-parameters-inline', !compact);
    const descriptors = parameterDescriptors(model?.capabilities);
    const fields = [], pickers = [];
    let surface = host, trigger = null, summary = null, panel = null, advanced = null, frame = 0;
    let close = () => {};
    if (compact && descriptors.length) {
      trigger = button('', 'media-settings-trigger', '生成参数');
      trigger.innerHTML = sliders;
      summary = document.createElement('span'); summary.className = 'media-settings-summary'; trigger.append(summary);
      trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'dialog');
      panel = document.createElement('section'); panel.className = 'media-settings-popover';
      panel.setAttribute('popover', 'auto'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '生成参数');
      const header = document.createElement('div'); header.className = 'media-settings-head';
      const title = document.createElement('span'); title.textContent = '生成参数';
      const reset = button('重置', 'media-settings-reset');
      header.append(title, reset);
      surface = document.createElement('div'); surface.className = 'media-settings-fields';
      if (descriptors.some(item => advancedKeys.has(item.key))) {
        const details = document.createElement('details'); details.className = 'media-settings-advanced';
        const toggle = document.createElement('summary'); toggle.textContent = '更多参数';
        advanced = document.createElement('div'); advanced.className = 'media-settings-advanced-fields';
        details.append(toggle, advanced); surface.append(details);
      }
      panel.append(header, surface); host.append(trigger, panel);
      reset.addEventListener('click', () => {
        fields.forEach(field => {
          field.resetControl?.();
          field.input.value = field.value == null ? '' : String(field.value);
          field.input.dispatchEvent(new Event('input', { bubbles: true }));
          field.input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }

    function refreshSummary() {
      if (!summary) return;
      const preferred = ['size', 'resolution', 'ratio', 'duration', 'n', 'quality'];
      const chunks = preferred.map(key => fields.find(field => field.key === key))
        .filter(field => field && field.input.value !== '')
        .map(field => optionLabel(field.key, field.input.value));
      summary.textContent = chunks.slice(0, 2).join(' · ') || '参数';
      trigger.title = chunks.length ? '生成参数 · ' + chunks.join(' · ') : '生成参数';
    }
    for (const descriptor of descriptors) {
      const { key, label: labelText, rule } = descriptor;
      const value = initialValues === undefined ? descriptor.value : initialValues?.[key];
      let resetControl = null;
      const label = document.createElement('label'); label.className = 'media-param media-parameter-field';
      label.dataset.mediaParameter = key;
      const text = document.createElement('span'); text.className = 'media-parameter-label'; text.textContent = labelText; label.append(text);
      const control = document.createElement('span'); control.className = 'media-parameter-control'; label.append(control);
      const isSize = key === 'size';
      const isSelect = !isSize && (Array.isArray(rule.enum) || rule.type === 'boolean');
      const input = document.createElement(isSelect ? 'select' : 'input');
      input.setAttribute('aria-label', labelText); input.dataset.mediaParameter = key;
      if (isSize) {
        const { options, custom, separator } = sizeOptions(rule, value);
        const freeform = !rule.pattern && !['minPixels', 'maxPixels', 'minEdge', 'maxEdge', 'minRatio', 'maxRatio', 'multipleOf'].some(key => rule[key] != null);
        input.type = 'text'; input.hidden = true; input.tabIndex = -1;
        input.className = 'media-parameter-value'; input.value = value == null ? '' : String(value);
        input.placeholder = '尺寸';
        const picker = document.createElement('select'); picker.className = 'media-parameter-select';
        picker.dataset.mediaSizePicker = ''; picker.setAttribute('aria-label', labelText);
        const appendOption = (item, current = false) => {
          const option = document.createElement('option'); option.value = item.value; option.textContent = item.label;
          option.disabled = !!item.disabled; if (current) option.dataset.current = ''; picker.append(option); return option;
        };
        if (!rule.required) appendOption({ value: '', label: '默认' });
        else if (!input.value) { const option = appendOption({ value: '', label: '请选择' }); option.disabled = true; }
        options.forEach(item => appendOption(item));
        if (custom) appendOption({ value: '__custom__', label: '自定义' });
        const dimensions = document.createElement('span'); dimensions.className = 'media-parameter-dimensions'; dimensions.hidden = true;
        const width = document.createElement('input'), height = document.createElement('input');
        for (const [node, name, title] of [[width, 'width', '宽度'], [height, 'height', '高度']]) {
          node.type = 'text'; node.inputMode = 'numeric'; node.pattern = '[0-9]+';
          node.dataset.dimension = name; node.setAttribute('aria-label', title); node.placeholder = title[0]; node.autocomplete = 'off';
        }
        const multiply = document.createElement('span'); multiply.textContent = '×'; multiply.setAttribute('aria-hidden', 'true');
        dimensions.append(width, multiply, height);
        let customOpen = false, editingDimensions = false;
        let previousCustom = freeform || /^(\d+)[x*](\d+)$/.test(input.value) ? input.value : '';
        resetControl = () => { customOpen = false; previousCustom = descriptor.value != null && (freeform || /^(\d+)[x*](\d+)$/.test(String(descriptor.value))) ? String(descriptor.value) : ''; };
        const refreshSize = () => {
          const text = input.value.trim();
          const match = /^(\d+)[x*](\d+)$/.exec(text);
          if (customOpen && (freeform || match)) previousCustom = text;
          if (!editingDimensions) { width.value = match?.[1] || ''; height.value = match?.[2] || ''; }
          dimensions.hidden = !customOpen || freeform; control.classList.toggle('is-custom', customOpen);
          input.hidden = !customOpen || !freeform; input.tabIndex = input.hidden ? -1 : 0;
          input.classList.toggle('media-parameter-input', freeform); width.required = height.required = customOpen && !freeform;
          let error = customOpen && (freeform ? !text : !match) ? (freeform ? '请填写尺寸' : '请填写尺寸的宽和高（整数像素）') : sizeError(rule, text);
          picker.querySelectorAll('[data-current]').forEach(option => option.remove());
          if (!customOpen && text && !Array.from(picker.options).some(option => option.value === text)) {
            appendOption({ value: text, label: optionLabel('size', text) + (error ? '（原值）' : ''), disabled: !!error }, true);
          }
          picker.value = customOpen ? '__custom__' : text;
          input.setCustomValidity(error); picker.setCustomValidity(error);
          for (const node of [input, picker, width, height]) node.setAttribute('aria-invalid', String(!!error));
          picker.title = customOpen ? '自定义尺寸' : (picker.selectedOptions[0]?.textContent || '尺寸');
          picker.refreshMediaChoice?.();
        };
        picker.addEventListener('change', () => {
          customOpen = picker.value === '__custom__'; input.value = customOpen ? previousCustom : picker.value;
          input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
          if (customOpen) (freeform ? input : width).focus({ preventScroll: true });
        });
        const updateDimensions = () => {
          editingDimensions = true; input.value = width.value || height.value ? dimensionValue(rule, width.value, height.value, separator) : '';
          input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
          editingDimensions = false;
        };
        for (const node of [width, height]) { node.addEventListener('input', updateDimensions); node.addEventListener('change', updateDimensions); }
        control.classList.add('media-parameter-size'); control.append(picker, input, dimensions);
        input.addEventListener('input', refreshSize); input.addEventListener('change', refreshSize); refreshSize();
        pickers.push(mountChoice(picker));
      } else if (isSelect) {
        const permitted = Array.isArray(rule.enum) ? rule.enum : [true, false];
        const values = rule.type === 'boolean' || value == null ? ['', ...permitted] : [...permitted];
        const originalOutsideRange = value != null && String(value) !== '' && !permitted.some(item => String(item) === String(value));
        if (originalOutsideRange) values.push(value);
        const dropdown = values.length > 4;
        input.className = dropdown ? 'media-parameter-select' : 'media-parameter-value'; input.hidden = !dropdown;
        if (!dropdown) input.tabIndex = -1;
        const choices = document.createElement('span'); choices.className = 'media-parameter-choices';
        choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', labelText);
        for (const item of values) {
          const stale = originalOutsideRange && String(item) === String(value);
          const text = optionLabel(key, item) + (stale ? '（原值）' : '');
          const option = document.createElement('option'); option.value = String(item); option.textContent = text; option.disabled = stale; input.append(option);
          const choice = button(text, 'media-parameter-choice'); choice.dataset.value = String(item); choice.disabled = stale;
          choice.setAttribute('aria-label', `${labelText}：${optionLabel(key, item)}`); choice.title = optionLabel(key, item);
          choice.addEventListener('click', event => {
            event.preventDefault(); input.value = String(item);
            input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
          });
          choices.append(choice);
        }
        control.append(input); if (!dropdown) control.append(choices);
        const refreshChoices = () => {
          input.setCustomValidity(input.value && !permitted.some(item => String(item) === input.value) ? `${labelText}的原值不在当前允许范围内，请重新选择` : '');
          input.setAttribute('aria-invalid', String(!!input.validationMessage));
          if (dropdown) input.title = optionLabel(key, input.value);
          input.refreshMediaChoice?.();
          choices.querySelectorAll('button').forEach(choice => {
            const selected = choice.dataset.value === input.value;
            choice.classList.toggle('is-selected', selected); choice.setAttribute('aria-pressed', String(selected));
          });
        };
        input.addEventListener('input', refreshChoices); input.addEventListener('change', refreshChoices);
        input.value = value == null ? '' : String(value); refreshChoices();
        if (dropdown) pickers.push(mountChoice(input));
      } else {
        input.className = 'media-parameter-input';
        if (rule.type === 'number' || rule.integer || rule.min != null || rule.max != null) {
          input.type = 'number'; input.step = rule.integer ? '1' : 'any';
          if (rule.min != null) input.min = rule.min;
          if (rule.max != null) input.max = rule.max;
          if (key === 'seed') {
            input.classList.add('media-parameter-seed'); control.append(input);
          } else {
            const stepper = document.createElement('span'); stepper.className = 'media-parameter-stepper';
            const decrement = button('−', 'media-parameter-step', `减少${labelText}`);
            const increment = button('+', 'media-parameter-step', `增加${labelText}`);
            const specialValues = Array.isArray(rule.specialValues) ? rule.specialValues : [];
            let specialChoices = null;
            const refreshSteps = () => {
              const present = input.value === '' ? null : Number(input.value);
              const special = specialValues.includes(present);
              if (rule.min != null) { if (special) input.removeAttribute('min'); else input.min = rule.min; }
              if (rule.max != null) { if (special) input.removeAttribute('max'); else input.max = rule.max; }
              const fixed = Number.isFinite(rule.min) && rule.min === rule.max;
              decrement.disabled = fixed || special || (present !== null && Number.isFinite(rule.min) && present <= rule.min);
              increment.disabled = fixed || (!special && present !== null && Number.isFinite(rule.max) && present >= rule.max);
              specialChoices?.querySelectorAll('button').forEach(choice => {
                const selected = Number(choice.dataset.value) === present;
                choice.classList.toggle('is-selected', selected); choice.setAttribute('aria-pressed', String(selected));
              });
            };
            const step = direction => {
              const present = input.value === '' ? (Number.isFinite(rule.min) ? rule.min : 0) : Number(input.value);
              const next = specialValues.includes(present) ? (rule.min ?? 0) : Math.min(rule.max ?? Infinity, Math.max(rule.min ?? -Infinity, present + direction));
              if (Number.isFinite(next)) input.value = String(next);
              input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            decrement.addEventListener('click', event => { event.preventDefault(); step(-1); });
            increment.addEventListener('click', event => { event.preventDefault(); step(1); });
            stepper.append(decrement, input, increment); control.append(stepper);
            if (specialValues.length) {
              specialChoices = document.createElement('span'); specialChoices.className = 'media-parameter-choices media-parameter-special';
              for (const special of specialValues) {
                const choice = button(optionLabel(key, special), 'media-parameter-choice'); choice.dataset.value = String(special);
                choice.setAttribute('aria-label', `${labelText}：${optionLabel(key, special)}`);
                choice.addEventListener('click', event => { event.preventDefault(); input.value = String(special); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
                specialChoices.append(choice);
              }
              control.prepend(specialChoices);
            }
            input.addEventListener('input', refreshSteps); input.addEventListener('change', refreshSteps);
            input.value = value == null ? '' : String(value); refreshSteps();
          }
        } else {
          input.type = 'text';
          if (rule.pattern) input.pattern = rule.pattern;
          control.append(input);
        }
        input.value = value == null ? '' : String(value); input.placeholder = '默认';
      }
      if (rule.maxLength != null && !isSize) {
        const validateLength = () => input.setCustomValidity(Array.from(input.value).length > rule.maxLength ? `${labelText}最多 ${rule.maxLength} 个字符` : '');
        input.addEventListener('input', validateLength); input.addEventListener('change', validateLength); validateLength();
      }
      input.addEventListener('input', refreshSummary); input.addEventListener('change', refreshSummary);
      if (advanced && advancedKeys.has(key)) advanced.append(label);
      else if (advanced) surface.insertBefore(label, advanced.parentElement);
      else surface.append(label);
      fields.push({ input, ...descriptor, resetControl });
    }
    // Partial edits belong to the local draft, never to provider defaults.
    for (const field of fields) {
      const raw = rawDraft?.[field.key];
      if (!raw || typeof raw.value !== 'string') continue;
      const row = field.input.closest('.media-parameter-field');
      field.input.value = raw.value;
      field.input.dispatchEvent(new Event('input', { bubbles: true }));
      const picker = row.querySelector('[data-media-size-picker]');
      if (picker && raw.custom === true) {
        picker.value = '__custom__'; picker.dispatchEvent(new Event('change', { bubbles: true }));
        const width = row.querySelector('[data-dimension="width"]'), height = row.querySelector('[data-dimension="height"]');
        if (width && height && raw.dimensions && !width.parentElement.hidden) {
          width.value = raw.dimensions.width; height.value = raw.dimensions.height;
          width.dispatchEvent(new Event('input', { bubbles: true }));
          continue;
        } else { field.input.value = raw.value; field.input.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      field.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshSummary();

    if (panel) {
      close = () => { pickers.forEach(picker => picker.close()); if (panel.matches(':popover-open')) panel.hidePopover(); trigger.setAttribute('aria-expanded', 'false'); cancelAnimationFrame(frame); };
      const position = () => {
        if (!panel.matches(':popover-open')) return;
        if (!trigger.isConnected || !trigger.checkVisibility({ visibilityProperty: true })) { close(); return; }
        const bounds = trigger.getBoundingClientRect(), edge = 12, gap = 8;
        const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
        panel.style.width = Math.min(256, Math.max(180, width - edge * 2)) + 'px';
        panel.style.maxHeight = Math.max(80, Math.min(480, height - edge * 2)) + 'px';
        const above = Math.max(0, bounds.top - gap - edge), below = Math.max(0, height - bounds.bottom - gap - edge);
        const openAbove = above >= Math.min(panel.scrollHeight, 320) || above >= below;
        panel.style.maxHeight = Math.max(80, openAbove ? above : below) + 'px';
        panel.style.left = Math.max(edge, Math.min(bounds.left, width - panel.offsetWidth - edge)) + 'px';
        panel.style.top = openAbove ? Math.max(edge, bounds.top - panel.offsetHeight - gap) + 'px' : Math.min(height - panel.offsetHeight - edge, bounds.bottom + gap) + 'px';
        frame = requestAnimationFrame(position);
      };
      trigger.addEventListener('click', event => {
        event.stopPropagation();
        if (panel.matches(':popover-open')) { close(); return; }
        root.closeCustomSelect?.(); root.closeProviderModelPickers?.();
        panel.showPopover(); trigger.setAttribute('aria-expanded', 'true'); position();
      });
      panel.addEventListener('toggle', () => { if (!panel.matches(':popover-open')) { pickers.forEach(picker => picker.close()); trigger.setAttribute('aria-expanded', 'false'); cancelAnimationFrame(frame); } });
      panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus({ preventScroll: true }); }
        if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault();
      });
    }
    mounted.set(host, () => { close(); pickers.forEach(picker => picker.dispose()); });
    const read = () => {
      const result = {};
      for (const field of fields) {
        if (!field.input.checkValidity()) throw new Error(field.input.validity.customError ? field.input.validationMessage : `${field.label}不符合范围要求`);
        const value = inputValue(field.input, field.rule);
        if (value !== undefined) result[field.key] = value;
      }
      return result;
    };
    read.snapshot = () => {
      const values = {}, raw = {};
      for (const field of fields) {
        const value = inputValue(field.input, field.rule);
        if (value !== undefined && (typeof value !== 'number' || Number.isFinite(value))) values[field.key] = value;
        const row = field.input.closest('.media-parameter-field');
        const picker = row.querySelector('[data-media-size-picker]');
        const width = row.querySelector('[data-dimension="width"]'), height = row.querySelector('[data-dimension="height"]');
        raw[field.key] = { value: field.input.value, ...(picker ? { custom: picker.value === '__custom__' } : {}),
          ...(width && height ? { dimensions: { width: width.value, height: height.value } } : {}) };
      }
      return { values, raw };
    };
    return read;
  }
  const api = { parameterDescriptors, mountParameters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayMediaParameters = api;
})(typeof window === 'object' ? window : globalThis);
