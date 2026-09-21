(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.relayBrowserForms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  function mount(container, section, options = {}) {
    if (!container || !['passwords', 'contacts'].includes(section)) throw new Error('表单管理页面无效');
    container._relayBrowserForms?.destroy();
    const doc = container.ownerDocument, win = doc.defaultView || root;
    const api = options.api || win.api?.browser, passwords = section === 'passwords';
    const el = (tag, cls, value) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (value != null) node.textContent = value; return node; };
    const button = (label, action) => { const node = el('button', 'rbf-button', label); node.type = 'button'; node.dataset.formAction = action; return node; };
    const page = el('section', 'relay-browser-forms'); page.setAttribute('aria-label', passwords ? '保存的密码' : '联系人');
    const intro = el('p', 'rbf-intro', passwords ? '仅保存你主动添加的账号，使用系统加密保护。需要时可在对应网站手动选择填入。' : '保存常用联系信息，方便在网页中手动选择填入。资料使用系统加密保护。');
    const toolbar = el('div', 'rbf-toolbar'), search = el('input', 'rbf-search'), add = button(passwords ? '添加密码' : '添加联系人', 'add');
    search.type = 'search'; search.placeholder = passwords ? '搜索网站或用户名' : '搜索联系人'; search.setAttribute('aria-label', search.placeholder); search.autocomplete = 'off';
    toolbar.append(search, add);
    const status = el('p', 'rbf-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const editor = el('form', 'rbf-editor'); editor.hidden = true; editor.autocomplete = 'off';
    const formTitle = el('strong', 'rbf-editor-title'), fields = {}, grid = el('div', 'rbf-fields');
    const specs = passwords ? [['origin', '网站地址', 'url'], ['username', '用户名', 'text'], ['password', '密码', 'password']]
      : [['name', '姓名', 'text'], ['email', '电子邮箱', 'email'], ['phone', '电话', 'tel'], ['address', '地址', 'textarea']];
    for (const [name, label, type] of specs) {
      const wrap = el('label', 'rbf-field'), caption = el('span', '', label), input = el(type === 'textarea' ? 'textarea' : 'input');
      input.name = name; input.dataset.formField = name; input.setAttribute('aria-label', label); input.autocomplete = type === 'password' ? 'new-password' : 'off';
      if (type !== 'textarea') input.type = type; else input.rows = 2;
      input.maxLength = ({ origin: 2048, username: 500, password: 4096, name: 100, email: 254, phone: 100, address: 1000 })[name];
      if (name === 'origin') { input.required = true; input.placeholder = 'https://example.com'; }
      wrap.append(caption, input); grid.append(wrap); fields[name] = input;
    }
    const formActions = el('div', 'rbf-actions'), cancel = button('取消', 'cancel-edit'), save = button('保存', 'save'); save.type = 'submit'; save.classList.add('rbf-primary');
    formActions.append(cancel, save); editor.append(formTitle, grid, formActions);
    const list = el('div', 'rbf-list'); list.setAttribute('aria-label', passwords ? '密码列表' : '联系人列表');
    page.append(intro, toolbar, status, editor, list); container.replaceChildren(page);
    let disposed = false, revision = 0, secretsRevision = 0, items = [], available = false, editing = null, saving = false;
    const masks = new Set();
    function clearSecrets() { secretsRevision++; for (const hide of [...masks]) hide(); }
    function message(value = '', error = false) { if (disposed) return; status.textContent = value; status.classList.toggle('is-error', error); }
    function controls() { add.disabled = !available || saving; save.disabled = !available || saving; cancel.disabled = saving; search.disabled = !available; }
    async function invoke(action, payload = {}) {
      if (!api?.invoke) throw new Error('本地资料管理暂不可用，请重启 Relay');
      const response = await api.invoke({ action, ...payload });
      if (!response || response.ok === false) throw Object.assign(new Error(response?.error || '操作失败，请重试'), { code: response?.code });
      return response;
    }
    function closeEditor() {
      editing = null; editor.hidden = true;
      for (const input of Object.values(fields)) input.value = '';
    }
    function edit(record = null) {
      if (!available || saving) return;
      clearSecrets(); editing = record; editor.hidden = false;
      formTitle.textContent = (record ? '编辑' : '添加') + (passwords ? '密码' : '联系人');
      for (const [name, input] of Object.entries(fields)) input.value = name === 'password' ? '' : record?.[name] || '';
      if (passwords) { fields.password.required = !record; fields.password.placeholder = record ? '留空则保留原密码' : '输入密码'; }
      Object.values(fields)[0].focus();
    }
    function render() {
      clearSecrets(); masks.clear(); list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const filtered = items.filter(item => (passwords ? [item.origin, item.username] : [item.name, item.email, item.phone, item.address]).join(' ').toLocaleLowerCase().includes(query));
      if (!filtered.length) { list.append(el('p', 'rbf-empty', query ? '没有匹配的记录' : passwords ? '还没有保存密码' : '还没有保存联系人')); return; }
      for (const record of filtered) {
        const row = el('article', 'rbf-record'); row.dataset.formRecord = record.recordId;
        const body = el('div', 'rbf-record-body'), title = el('strong', '', passwords ? record.origin : record.name || record.email || record.phone);
        const detail = el('p', '', passwords ? record.username || '未填写用户名' : [record.email, record.phone].filter(Boolean).join(' · '));
        body.append(title, detail); if (!passwords && record.address) body.append(el('p', 'rbf-address', record.address));
        const actions = el('div', 'rbf-record-actions'); row.append(body, actions);
        const valid = () => !disposed && row.parentNode === list;
        if (passwords) {
          const secret = el('code', 'rbf-secret', '••••••••'); secret.dataset.formSecret = ''; secret.hidden = true; body.append(secret);
          const reveal = button('显示', 'reveal'), copy = button('复制', 'copy'); reveal.setAttribute('aria-pressed', 'false');
          let shown = false, pending = false, timer = null;
          const hide = () => { shown = false; secret.textContent = '••••••••'; secret.hidden = true; reveal.textContent = '显示'; reveal.setAttribute('aria-pressed', 'false'); clearTimeout(timer); timer = null; };
          masks.add(hide);
          const revealValue = async copyOnly => {
            if (pending || !valid()) return;
            if (!copyOnly && shown) { hide(); return; }
            pending = true; reveal.disabled = true; copy.disabled = true; const stamp = secretsRevision;
            try {
              const result = await invoke('passwords.reveal', { recordId: record.recordId });
              if (!valid() || stamp !== secretsRevision) return;
              if (copyOnly) {
                if (!win.navigator?.clipboard?.writeText) throw new Error('无法访问剪贴板，请重试');
                await win.navigator.clipboard.writeText(result.password);
                if (valid()) message('密码已复制');
              } else {
                secret.textContent = result.password; secret.hidden = false; shown = true; reveal.textContent = '隐藏'; reveal.setAttribute('aria-pressed', 'true');
                timer = setTimeout(hide, 30000);
              }
            } catch (error) { if (valid()) message(error.message, true); }
            finally { pending = false; if (valid()) { reveal.disabled = false; copy.disabled = false; } }
          };
          reveal.addEventListener('click', () => void revealValue(false)); copy.addEventListener('click', () => void revealValue(true)); actions.append(reveal, copy);
        }
        const editButton = button('编辑', 'edit'), remove = button('删除', 'delete');
        editButton.addEventListener('click', () => edit(record));
        remove.addEventListener('click', () => {
          clearSecrets(); actions.replaceChildren();
          const confirm = button('确认删除', 'confirm-delete'), keep = button('取消', 'cancel-delete'); confirm.classList.add('rbf-danger'); actions.append(confirm, keep);
          keep.addEventListener('click', render);
          confirm.addEventListener('click', async () => {
            if (confirm.disabled) return; confirm.disabled = true; keep.disabled = true;
            try { await invoke(section + '.delete', { recordId: record.recordId }); if (!disposed) { if (editing?.recordId === record.recordId) closeEditor(); await refresh(); message('已删除'); } }
            catch (error) { if (valid()) { message(error.message, true); confirm.disabled = false; keep.disabled = false; } }
          });
        });
        actions.append(editButton, remove); list.append(row);
      }
    }
    async function refresh() {
      const stamp = ++revision; clearSecrets(); message('正在读取…');
      try { const result = await invoke(section + '.list'); if (disposed || stamp !== revision) return; items = result.items || []; available = true; render(); message(); }
      catch (error) { if (disposed || stamp !== revision) return; available = false; items = []; list.replaceChildren(); message(error.message, true); }
      finally { if (!disposed && stamp === revision) controls(); }
    }
    editor.addEventListener('submit', async event => {
      event.preventDefault(); if (!available || saving || (editor.reportValidity && !editor.reportValidity())) return;
      const payload = Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value]));
      if (editing) payload.recordId = editing.recordId;
      if (passwords && editing && !payload.password) delete payload.password;
      saving = true; controls();
      try { await invoke(section + '.save', payload); if (!disposed) { closeEditor(); await refresh(); message('已保存'); } }
      catch (error) { if (!disposed) message(error.message, true); }
      finally { saving = false; if (!disposed) controls(); }
    });
    add.addEventListener('click', () => edit()); cancel.addEventListener('click', closeEditor); search.addEventListener('input', render);
    win.addEventListener?.('blur', clearSecrets);
    const controller = {
      refresh,
      destroy() { if (disposed) return; disposed = true; revision++; clearSecrets(); masks.clear(); closeEditor(); items = []; win.removeEventListener?.('blur', clearSecrets); container.replaceChildren(); if (container._relayBrowserForms === controller) delete container._relayBrowserForms; },
    };
    container._relayBrowserForms = controller; controls(); void refresh(); return controller;
  }
  return { mount };
});
