'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NAME = /^[a-z0-9][a-z0-9-]{0,100}$/;
const KEY = /^[A-Za-z_]\w{0,100}$/;
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const fail = message => { throw Object.assign(Error(message), { code: 'SDK_PLUGIN_INVALID' }); };
function manifest(directory) {
  const root = fs.realpathSync(directory), file = path.join(root, '.claude-plugin', 'plugin.json');
  if (fs.statSync(file).size > 256 * 1024) fail('插件清单过大');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!plain(data) || !NAME.test(data.name || '')) fail('插件缺少有效的名称');
  const fields = {};
  if (data.userConfig !== undefined && !plain(data.userConfig)) fail('插件配置声明无效');
  for (const [key, def] of Object.entries(data.userConfig || {})) {
    if (!KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !plain(def) || !['string', 'number', 'boolean', 'directory', 'file'].includes(def.type)) fail('插件含不支持的配置项');
    if (typeof def.title !== 'string' || !def.title.trim() || typeof def.description !== 'string') fail('插件配置项缺少 SDK 要求的标题或说明');
    fields[key] = { type: def.type, title: String(def.title || key).slice(0, 160), description: String(def.description || '').slice(0, 1000),
      sensitive: def.sensitive === true, required: def.required === true, multiple: def.multiple === true,
      ...(def.default !== undefined && def.sensitive !== true ? { default: def.default } : {}),
      ...(Number.isFinite(def.min) ? { min: def.min } : {}), ...(Number.isFinite(def.max) ? { max: def.max } : {}) };
  }
  return { path: root, name: data.name, sdkId: data.name + '@inline', description: String(data.description || '').slice(0, 1000),
    version: String(data.version || '').slice(0, 64), fields, hasHooks: !!data.hooks || fs.existsSync(path.join(root, 'hooks', 'hooks.json')),
    hasMcp: !!data.mcpServers || fs.existsSync(path.join(root, '.mcp.json')) };
}
function normalizeOptions(fields, input, { requireValues = false } = {}) {
  if (!plain(input)) fail('插件配置必须是对象');
  const out = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) fail('配置项已从插件中移除，请刷新后重试');
  for (const [key, def] of Object.entries(fields)) {
    if (def.sensitive) { if (Object.hasOwn(input, key)) fail('敏感项由 SDK 安全存储管理，不可写入普通配置'); continue; }
    const value = input[key] ?? def.default;
    if (value === undefined || value === '') { if (requireValues && def.required) fail(`${def.title}尚未填写`); continue; }
    if (def.type === 'boolean' ? typeof value !== 'boolean'
      : def.type === 'number' ? !Number.isFinite(value) || def.min != null && value < def.min || def.max != null && value > def.max
      : def.multiple ? !Array.isArray(value) || value.length > 128 || value.some(x => typeof x !== 'string' || x.length > 8192)
      : typeof value !== 'string' || value.length > 8192) fail(`${def.title}的值无效`);
    out[key] = value;
  }
  return out;
}
function createPluginStore({ file }) {
  function read() { try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(raw) ? raw.slice(0, 100) : []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  function write(items) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  function views() { return read().map(entry => { try { const info = manifest(entry.path); return { ...entry, ...info, options: normalizeOptions(info.fields, entry.options || {}) }; }
    catch (error) { return { id: entry.id, name: entry.name, path: entry.path, enabled: false, error: error.message, fields: {}, options: {} }; } }); }
  return {
    list: views,
    add(directory) {
      const info = manifest(directory), items = read();
      if (items.some(x => x.path === info.path || x.name === info.name)) fail('这个插件或同名插件已添加');
      if (items.length >= 100) fail('插件数量已达上限');
      const item = { id: crypto.randomUUID(), path: info.path, name: info.name, enabled: false, options: {} };
      items.push(item); write(items); return { ...item, ...info };
    },
    update(id, patch = {}) {
      const items = read(), item = items.find(x => x.id === id); if (!item) fail('插件已不存在');
      const info = manifest(item.path);
      if (Object.keys(patch).some(k => !['enabled', 'options'].includes(k))) fail('不支持的插件设置');
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') fail('插件启用状态无效');
      const enabled = patch.enabled ?? item.enabled;
      item.options = normalizeOptions(info.fields, patch.options || item.options || {}, { requireValues: enabled });
      item.enabled = enabled; write(items); return { ...item, ...info };
    },
    remove(id) { const items = read(); write(items.filter(x => x.id !== id)); return { ok: true, sourceRetained: true }; },
    runtime() {
      const items = views(), plugins = [], enabledPlugins = {}, pluginConfigs = {};
      for (const item of items) {
        if (item.error) { if (read().find(x => x.id === item.id)?.enabled) fail(`插件 ${item.name} 无法加载：${item.error}`); continue; }
        enabledPlugins[item.sdkId] = item.enabled === true;
        if (item.enabled) { plugins.push({ type: 'local', path: item.path }); pluginConfigs[item.sdkId] = { options: normalizeOptions(item.fields, item.options, { requireValues: true }) }; }
      }
      return { plugins, settings: { enabledPlugins, pluginConfigs }, fingerprint: crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex') };
    },
  };
}
module.exports = { manifest, normalizeOptions, createPluginStore };
