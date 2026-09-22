'use strict';
const path = require('node:path');
const MAX_RESOURCES = 200;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;
const CONTROL = /[\x00-\x1f\x7f]/;
function validDistribution(value) {
  return typeof value === 'string' && value.length <= 128 && /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(value) && !/[. ]$/.test(value);
}
function resourceEntries(event, { jobId, cwd, agentEnvironment = 'native', wslDistribution } = {}) {
  if (!jobId) return [];
  if (event?.type === 'user' && event.tool_use_result && Array.isArray(event.message?.content)) {
    const ids = event.message.content.filter(x => x.type === 'tool_result').map(x => x.tool_use_id);
    const output = event.tool_use_result;
    if (ids.length !== 1 || !ids[0]) return [];
    return [output.persistedOutputPath, output.rawOutputPath].filter(value => typeof value === 'string').flatMap(uri => resourceEntries({ type: 'system', subtype: 'task_notification', task_id: ids[0], output_file: uri }, { jobId, cwd, agentEnvironment, wslDistribution }));
  }
  if (event?.type !== 'system' || event.subtype !== 'task_notification' || !event.task_id) return [];
  const raw = (Array.isArray(event.resource_links) ? event.resource_links.slice(0, 50) : [])
    .filter(link => link && typeof link === 'object')
    .map(link => ({ uri: link.uri, name: link.name || link.title || '任务资源', output: false }));
  if (event.output_file) raw.unshift({ uri: event.output_file, name: '任务输出', output: true });
  // The environment is the host-owned launch snapshot, never event/renderer data.
  // Do not infer a distribution later: the default may change after this run.
  return raw.filter(item => typeof item.uri === 'string' && item.uri.length > 0 && item.uri.length <= 8192 && !CONTROL.test(item.uri))
    .map(item => ({ ...item, jobId, taskId: event.task_id, cwd: cwd || null,
      agentEnvironment: agentEnvironment === 'wsl' ? 'wsl' : 'native',
      ...(agentEnvironment === 'wsl' && validDistribution(wslDistribution) ? { wslDistribution } : {}),
    }));
}
function mergeResources(previous, additions) {
  const entries = new Map((Array.isArray(previous) ? previous : []).map(item => [JSON.stringify([item.jobId, item.taskId, item.uri]), item]));
  for (const item of additions) entries.set(JSON.stringify([item.jobId, item.taskId, item.uri]), item);
  return [...entries.values()].slice(-MAX_RESOURCES);
}
function ownedResource(entries, { jobId, taskId, uri }) {
  return (Array.isArray(entries) ? entries : []).find(item => item.jobId === jobId && item.taskId === taskId && item.uri === uri) || null;
}
function invalidPath() { throw new Error('资源路径无效，无法打开'); }
function assertPath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || CONTROL.test(value)) invalidPath();
}
function decodeFileUri(uri, windows) {
  if (uri.includes('\\')) invalidPath();
  const url = new URL(uri);
  if (url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) invalidPath();
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch (_) { invalidPath(); }
  assertPath(decoded);
  if (url.hostname && url.hostname !== 'localhost') {
    if (!windows || !/^[a-z\d][a-z\d._-]*$/i.test(url.hostname)) invalidPath();
    return `\\\\${url.hostname}${decoded.replace(/\//g, '\\')}`;
  }
  return windows && /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
}
function windowsPath(value) {
  assertPath(value);
  if (/^[\\/]{2}[?.]/.test(value) || /^[\\/]\?\?/.test(value)) invalidPath();
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  if (!WINDOWS_ABSOLUTE.test(normalized) && !/^\\\\[^\\]+\\[^\\]+\\/.test(root)) invalidPath();
  const components = normalized.slice(WINDOWS_ABSOLUTE.test(normalized) ? 3 : 2).split('\\').filter(Boolean);
  if (components.some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalidPath();
  return normalized;
}
function windowsToPosix(value) { return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replace(/\\/g, '/')}`; }
function wslToWindows(file, distribution) {
  // A Linux backslash is a filename character, but becomes a separator in UNC.
  // Refuse that ambiguity before normalization, including UNC/device injection.
  if (file.includes('\\') || file.startsWith('//')) invalidPath();
  const normalized = path.posix.normalize(file);
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(normalized)) {
    return windowsPath(`${normalized[5].toUpperCase()}:\\${normalized.slice(7).replace(/\//g, '\\')}`);
  }
  if (!validDistribution(distribution)) throw new Error('此任务未记录 WSL 发行版，无法定位 Linux 资源');
  return windowsPath(`\\\\wsl.localhost\\${distribution}\\${normalized.slice(1).replace(/\//g, '\\')}`);
}
function resourceTarget(resource, platform = process.platform) {
  const uri = resource?.uri;
  assertPath(uri);
  if (/^https?:\/\//i.test(uri)) {
    const url = new URL(uri);
    if (url.username || url.password) throw new Error('资源链接包含账号信息，无法打开');
    return { kind: 'url', url: url.href };
  }
  let file = uri;
  const wsl = resource.agentEnvironment === 'wsl';
  if (/^file:/i.test(uri)) file = decodeFileUri(uri, platform === 'win32' && !wsl);
  else if (/^[a-z]:/i.test(uri) && !WINDOWS_ABSOLUTE.test(uri)) invalidPath();
  else if (/^[a-z][a-z\d+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) return { kind: 'resource', uri };
  if (wsl) {
    if (WINDOWS_ABSOLUTE.test(file)) file = windowsToPosix(windowsPath(file));
    if (file.includes('\\') || file.startsWith('//')) invalidPath();
    if (!path.posix.isAbsolute(file)) {
      let cwd = resource.cwd;
      assertPath(cwd);
      if (WINDOWS_ABSOLUTE.test(cwd)) cwd = windowsToPosix(windowsPath(cwd));
      if (!path.posix.isAbsolute(cwd) || cwd.startsWith('//') || cwd.includes('\\')) invalidPath();
      file = path.posix.resolve(cwd, file);
    }
    file = path.posix.normalize(file);
    return { kind: 'file', path: platform === 'win32' ? wslToWindows(file, resource.wslDistribution) : file };
  }
  if (platform === 'win32') {
    // Historical /mnt drive links predate environment metadata and remain safe.
    if (/^\/mnt\/[a-z](?:\/|$)/i.test(file)) return { kind: 'file', path: wslToWindows(file) };
    if (!WINDOWS_ABSOLUTE.test(file) && !/^[\\/]{2}/.test(file)) {
      if (/^[\\/]/.test(file)) invalidPath();
      if (!resource.cwd) throw new Error('资源没有可用的工作目录');
      file = path.win32.resolve(windowsPath(resource.cwd), file);
    }
    return { kind: 'file', path: windowsPath(file) };
  }
  if (WINDOWS_ABSOLUTE.test(file) || file.startsWith('\\') || file.startsWith('//')) invalidPath();
  if (!path.posix.isAbsolute(file)) {
    if (!resource.cwd || !path.posix.isAbsolute(resource.cwd) || resource.cwd.startsWith('//')) throw new Error('资源没有可用的工作目录');
    assertPath(resource.cwd);
    file = path.posix.resolve(resource.cwd, file);
  }
  return { kind: 'file', path: path.posix.normalize(file) };
}
module.exports = { resourceEntries, mergeResources, ownedResource, resourceTarget, validDistribution };
