(function (root) {
  'use strict';
  const MAX_LENGTH = 10000;
  function create({ mount, value = '', api, onChange, onSaved } = {}) {
    let saved = String(value || ''), busy = false, disposed = false;
    mount.innerHTML = `<header class="relay-guidance-head"><div><h2>Relay 说明</h2><p id="relayInstructionsHelp">为所有聊天提供额外说明和偏好。保存后在后续任务中使用。</p></div><button type="button" id="relayInstructionsSave" disabled>保存</button></header>
      <textarea id="relayInstructions" aria-label="Relay 说明" aria-describedby="relayInstructionsHelp relayInstructionsStatus" placeholder="例如：默认使用中文回答，先给结论，再说明依据。" maxlength="${MAX_LENGTH}" spellcheck="false"></textarea>
      <div class="relay-guidance-foot"><span id="relayInstructionsStatus" role="status" aria-live="polite"></span><span id="relayInstructionsCount"></span></div>`;
    const input = mount.querySelector('textarea'), button = mount.querySelector('button');
    const status = mount.querySelector('#relayInstructionsStatus'), count = mount.querySelector('#relayInstructionsCount');
    input.value = saved;
    function sync() {
      button.disabled = busy || input.value === saved || input.value.length > MAX_LENGTH;
      button.textContent = busy ? '保存中…' : '保存';
      count.textContent = `${input.value.length.toLocaleString('zh-CN')} / ${MAX_LENGTH.toLocaleString('zh-CN')}`;
    }
    function getPatch() {
      if (busy) throw Error('Relay 说明正在保存，请稍候');
      if (input.value.length > MAX_LENGTH) throw Error(`Relay 说明最多 ${MAX_LENGTH} 个字符`);
      return input.value === saved ? {} : { relayInstructions: input.value };
    }
    function beginSave() { busy = true; status.textContent = ''; status.dataset.error = 'false'; sync(); }
    function finishSave(value, error) {
      busy = false;
      if (disposed) return;
      if (error) { status.textContent = error.message || '保存失败，请重试'; status.dataset.error = 'true'; }
      else { saved = value; status.textContent = input.value === value ? '已保存' : '有未保存的修改'; status.dataset.error = 'false'; onSaved?.(value); }
      sync();
    }
    input.addEventListener('input', () => {
      status.textContent = input.value.length > MAX_LENGTH ? `最多 ${MAX_LENGTH} 个字符` : '';
      status.dataset.error = String(input.value.length > MAX_LENGTH); sync(); onChange?.();
    });
    button.addEventListener('click', async () => {
      if (busy) return;
      const patch = getPatch(); if (!Object.hasOwn(patch, 'relayInstructions')) return;
      beginSave();
      try {
        const result = await api.write({ app: patch });
        if (!result || result.ok === false) throw Error(result?.message || result?.error || '未收到保存确认');
        finishSave(patch.relayInstructions);
      } catch (error) { finishSave(null, error); }
    });
    sync();
    return { getPatch, beginSave, finishSave, destroy() { disposed = true; } };
  }
  root.RelayPersonalizationGuidance = { create, MAX_LENGTH };
})(window);
