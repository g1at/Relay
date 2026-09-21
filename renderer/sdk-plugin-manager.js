(function (root) {
  'use strict';
  function create(mount) {
    const doc = mount.ownerDocument, api = root.api.sdkPlugins;
    const node = (tag, cls, value) => { const el = doc.createElement(tag); el.className = cls || ''; if (value != null) el.textContent = value; return el; };
    const toolbar = node('div', 'sdk-plugin-toolbar'), add = node('button', 'btn-ghost', '添加本地插件'), status = node('p', 'rgp-status'), list = node('div');
    add.type = 'button'; list.dataset.list = ''; toolbar.append(add); mount.replaceChildren(toolbar, status, list); let revision = 0, disposed = false;
    async function run(work) { try { const result = await work(); if (!result?.ok) throw Error(result?.message || '操作失败'); status.textContent = result.liveReload?.failed ? '部分运行会话未刷新，下次启动时生效。' : ''; return result; } catch (e) { status.textContent = e.message; return null; } }
    async function refresh() {
      const own = ++revision, response = await run(() => api.list()); if (!response || disposed || revision !== own) return;
      list.replaceChildren();
      for (const item of response.items) {
        const box = node('section', 'dp-item sdk-plugin-item'), info = node('div'), name = node('strong', 'dp-item-name', item.name), desc = node('p', 'dp-item-desc', item.error || item.description || '本地 SDK 插件'); info.append(name, desc);
        const toggle = node('button', 'rgp-toggle'); toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', '启用 ' + item.name); toggle.setAttribute('aria-checked', String(!!item.enabled)); toggle.disabled = !!item.error;
        toggle.onclick = async () => { toggle.disabled = true; if (await run(() => api.update(item.id, { enabled: !item.enabled }))) await refresh(); else toggle.disabled = false; };
        box.append(info, toggle);
        const config = node('details', 'sdk-plugin-config'), form = node('div'); config.append(node('summary', '', '配置与来源'), node('p', '', item.path), form);
        if (item.hasHooks || item.hasMcp) config.append(node('small', '', '此插件含工具或运行钩子。启用后由 SDK 按会话权限和管理策略加载。'));
        const inputs = new Map();
        for (const [key, def] of Object.entries(item.fields || {})) {
          const label = node('label', 'sdk-runtime-field'), title = node('span', 'sdk-runtime-label', def.title); title.append(node('small', '', def.description)); label.append(title);
          if (def.sensitive) label.append(node('span', 'sdk-plugin-secret', '由 SDK 安全存储管理'));
          else {
            const input = node(def.multiple ? 'textarea' : 'input', 'sdk-runtime-input'); input.setAttribute('aria-label', def.title);
            if (def.type === 'boolean') { input.type = 'checkbox'; input.checked = !!(item.options[key] ?? def.default); }
            else { input.type = def.type === 'number' ? 'number' : 'text'; input.value = def.multiple ? (item.options[key] || def.default || []).join('\n') : item.options[key] ?? def.default ?? ''; if (def.min != null) input.min = def.min; if (def.max != null) input.max = def.max; }
            inputs.set(key, { input, def }); label.append(input);
          }
          form.append(label);
        }
        const save = node('button', 'btn-ghost', '保存配置'), remove = node('button', 'btn-ghost', '移除此入口'); save.type = remove.type = 'button';
        save.onclick = async () => { const options = Object.fromEntries([...inputs].map(([k, { input, def }]) => [k, def.type === 'boolean' ? input.checked : def.type === 'number' ? input.value === '' ? undefined : Number(input.value) : def.multiple ? input.value.split('\n').filter(Boolean) : input.value])); save.disabled = true; if (await run(() => api.update(item.id, { options }))) await refresh(); else save.disabled = false; };
        remove.onclick = async () => { if (await run(() => api.remove(item.id))) await refresh(); };
        config.append(save, remove); box.append(config); list.append(box);
      }
      if (!response.items.length) list.append(node('p', '', '添加包含 .claude-plugin/plugin.json 的文件夹。原有技能、Agent 和 MCP 仍可单独管理。'));
    }
    add.onclick = async () => { add.disabled = true; try { const result = await api.add(); if (result?.canceled) return; if (result?.ok) await refresh(); else status.textContent = result?.message || '添加失败'; } finally { add.disabled = false; } };
    void refresh(); return { refresh, destroy() { disposed = true; revision++; } };
  }
  root.RelaySdkPluginManager = { create };
})(window);
