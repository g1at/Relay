'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resourcePath } = require('./paths');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { POLICY_DEFAULTS, normalizeRuntimePolicy } = require('../sdk/sdk-runtime-policy');
const { normalizeSdkPreferences } = require('../sdk/sdk-runtime-preferences');
const { normalizeRelayInstructions, validateRelayInstructions } = require('../sdk/relay-instructions');

const DEFAULTS = Object.freeze({ workspaceRoot: '', fileOpenTarget: 'relay', agentEnvironment: 'native', terminalShell: 'auto', followUpMode: 'steer', maxParallelTasks: 2, relayInstructions: '', showContextUsage: true, ...POLICY_DEFAULTS });
const VALUES = Object.freeze({ fileOpenTarget: ['relay', 'system', 'vscode', 'vscode-insiders', 'cursor'], agentEnvironment: ['native', 'wsl'], terminalShell: ['auto', 'powershell', 'pwsh', 'cmd', 'wsl'], followUpMode: ['steer', 'queue'] });
const PARALLEL_LIMITS = Object.freeze([2, 6, 9, 0]);
const error = (code, message) => Object.assign(new Error(message), { code });
function normalizeParallelLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULTS.maxParallelTasks;
  if (value === 0) return 0;
  // Migrate former custom limits into the supported tiers. Unlimited stays opt-in.
  return PARALLEL_LIMITS.find(limit => limit >= value) || 9;
}
function normalizePreferences(settings = {}) {
  const result = { ...DEFAULTS };
  if (typeof settings.workspaceRoot === 'string') result.workspaceRoot = settings.workspaceRoot;
  result.maxParallelTasks = normalizeParallelLimit(settings.maxParallelTasks);
  result.relayInstructions = normalizeRelayInstructions(settings.relayInstructions);
  result.showContextUsage = settings.showContextUsage !== false;
  for (const [key, values] of Object.entries(VALUES)) if (values.includes(settings[key])) result[key] = settings[key];
  Object.assign(result, normalizeRuntimePolicy(settings));
  return result;
}
function createGeneralPreferences(options = {}) {
  const platform = options.platform || process.platform, env = options.env || process.env;
  const paths = platform === 'win32' ? path.win32 : path;
  const homeDir = options.homeDir || os.homedir();
  const defaultWorkspaceRoot = paths.join(homeDir, 'RelayProjects');
  const getSettings = options.getSettings || (() => ({}));
  const exists = options.isFile || (file => { try { return fs.statSync(file).isFile(); } catch (_) { return false; } });
  const spawnProcess = options.spawn || spawn;
  let cache = null, cacheAt = 0, pending = null;
  const preferences = () => ({ ...normalizePreferences(getSettings()), defaultWorkspaceRoot });
  const find = (names, candidates = []) => [...candidates, ...String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')
    .filter(Boolean).flatMap(dir => names.map(name => paths.join(dir, name)))].find(file => paths.isAbsolute(file) && exists(file)) || null;
  function detectExecutables() {
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    const programs = env.ProgramFiles || 'C:\\Program Files', local = env.LOCALAPPDATA || paths.join(homeDir, 'AppData', 'Local');
    return platform === 'win32' ? {
      powershell: find(['powershell.exe'], [paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]),
      pwsh: find(['pwsh.exe'], [paths.join(programs, 'PowerShell', '7', 'pwsh.exe')]),
      cmd: find(['cmd.exe'], [paths.join(systemRoot, 'System32', 'cmd.exe')]),
      wsl: find(['wsl.exe'], [paths.join(systemRoot, 'System32', 'wsl.exe')]),
      vscode: find(['Code.exe'], [paths.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), paths.join(programs, 'Microsoft VS Code', 'Code.exe')]),
      'vscode-insiders': find(['Code - Insiders.exe'], [paths.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'), paths.join(programs, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')]),
      cursor: find(['Cursor.exe'], [paths.join(local, 'Programs', 'cursor', 'Cursor.exe'), paths.join(programs, 'Cursor', 'Cursor.exe')]),
    } : { nativeShell: find(['bash', 'sh'], [env.SHELL || '/bin/bash']), vscode: find(['code']), 'vscode-insiders': find(['code-insiders']), cursor: find(['cursor']) };
  }
  async function capabilities({ refresh = false } = {}) {
    if (pending) return pending;
    if (!refresh && cache && Date.now() - cacheAt < 30000) return cache;
    pending = (async () => {
      const executables = detectExecutables();
      let wsl = { available: false, reason: '此系统不支持 Windows 子系统。', terminalAvailable: false };
      if (platform === 'win32') {
        wsl = executables.wsl && typeof options.probeWsl === 'function'
          ? await options.probeWsl({ refresh }) : { available: false, terminalAvailable: false, reason: '未安装 WSL，请先安装发行版。' };
      }
      const fileOpenTargets = [{ id: 'relay', label: 'Relay 内置', available: true }, { id: 'system', label: '系统默认应用', available: true }];
      for (const [id, label] of [['vscode', 'Visual Studio Code'], ['vscode-insiders', 'VS Code Insiders'], ['cursor', 'Cursor']]) {
        if (executables[id]) fileOpenTargets.push({ id, label, available: true });
      }
      const terminalShells = [{ id: 'auto', label: '系统默认', available: true }];
      if (platform === 'win32') for (const [id, label] of [['powershell', 'Windows PowerShell'], ['pwsh', 'PowerShell 7'], ['cmd', '命令提示符'], ['wsl', 'WSL']]) {
        if (executables[id]) terminalShells.push({ id, label, available: id !== 'wsl' || !!wsl.terminalAvailable, ...(id === 'wsl' && !wsl.terminalAvailable ? { reason: wsl.reason } : {}) });
      }
      cache = { fileOpenTargets, terminalShells, agentEnvironments: [
        { id: 'native', label: platform === 'win32' ? 'Windows 原生' : '本机', available: true },
        { id: 'wsl', label: 'WSL', available: !!wsl.available, ...(wsl.available ? {} : { reason: wsl.reason || 'WSL 运行环境尚未准备好。' }) },
      ], executables };
      cacheAt = Date.now(); return cache;
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function get(input = {}) {
    const { executables, ...publicCapabilities } = await capabilities(input);
    const project = typeof options.getProjectContext === 'function' ? options.getProjectContext(input) : null;
    const projectContext = project && typeof project.id === 'string' ? { id: project.id, name: String(project.name || '当前项目').slice(0, 160) } : null;
    return { ok: true, preferences: preferences(), capabilities: publicCapabilities, projectContext, modelCapability: options.getModelCapability?.(input) || null };
  }
  async function validatePatch(patch = {}) {
    const result = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key];
      if (key === 'relayInstructions') { result[key] = validateRelayInstructions(value); continue; }
      if (key === 'showContextUsage') {
        if (typeof value !== 'boolean') throw error('INVALID_PREFERENCE', '上下文用量显示选项必须是开启或关闭。');
        result[key] = value; continue;
      }
      if (key.startsWith('sdk')) {
        if (key === 'sdkRuntimePreferences') {
          const next = normalizeSdkPreferences(value, { strict: true });
          const current = normalizeSdkPreferences(getSettings().sdkRuntimePreferences);
          for (const [id, entry] of Object.entries(next.projectMcpApprovals)) {
            if (JSON.stringify(current.projectMcpApprovals[id]) === JSON.stringify(entry)) continue;
            if (typeof options.getProjectContext !== 'function' || options.getProjectContext({ projectId: id })?.id !== id) throw error('INVALID_PROJECT_TRUST', '仅可配置已经加入 Relay 的项目工具。');
          }
          result[key] = next;
        } else if (key === 'sdkTrustedProjectIds') {
          const current = normalizeRuntimePolicy(getSettings()).sdkTrustedProjectIds;
          const next = normalizeRuntimePolicy({ sdkTrustedProjectIds: value }).sdkTrustedProjectIds;
          if (!Array.isArray(value) || JSON.stringify(next) !== JSON.stringify(value)) throw error('INVALID_PROJECT_TRUST', '项目配置授权列表无效。');
          if (next.some(id => !current.includes(id) && (typeof options.getProjectContext !== 'function' || options.getProjectContext({ projectId: id })?.id !== id))) throw error('INVALID_PROJECT_TRUST', '仅可授权已加入 Relay 的项目配置。');
          result[key] = next;
        } else if (key === 'sdkCleanupPeriodDays') {
          // Accept legacy clients/configuration without retaining an obsolete cleanup override.
          result[key] = null;
        } else if (key === 'sdkMemoryMode' || key === 'sdkAutoDreamEnabled') {
          // Ignore all retired values, including malformed legacy values, without
          // blocking unrelated preferences in the same save. Persist the disabled
          // values so older clients cannot accidentally restore native SDK memory.
          result[key] = POLICY_DEFAULTS[key];
        } else {
          const values = ['user', 'project', 'local'];
          if (!values.includes(value)) throw error('INVALID_PREFERENCE', 'SDK 运行设置无效。');
          result[key] = value;
        }
        continue;
      }
      if (key === 'maxParallelTasks') {
        if (!PARALLEL_LIMITS.includes(value)) throw error('INVALID_PARALLEL_LIMIT', '请选择 2、6、9 个并行对话，或不限制。');
        result[key] = value; continue;
      }
      if (key === 'workspaceRoot') {
        if (typeof value !== 'string' || value.includes('\0') || (value && !paths.isAbsolute(value))) throw error('INVALID_WORKSPACE_ROOT', '任务文件夹必须是一个绝对路径。');
        if (value) {
          let stat; try { stat = await fs.promises.stat(value); await fs.promises.access(value, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); }
          catch (_) { throw error('WORKSPACE_ROOT_UNAVAILABLE', '任务文件夹不存在或无法写入，请重新选择。'); }
          if (!stat.isDirectory()) throw error('INVALID_WORKSPACE_ROOT', '任务文件夹必须是文件夹。');
        }
        result[key] = value ? paths.resolve(value) : ''; continue;
      }
      if (!VALUES[key].includes(value)) throw error('INVALID_PREFERENCE', '常规设置选项无效。');
      result[key] = value;
    }
    const categories = { fileOpenTarget: 'fileOpenTargets', agentEnvironment: 'agentEnvironments', terminalShell: 'terminalShells' };
    if (Object.keys(categories).some(key => Object.hasOwn(result, key))) {
      const available = await capabilities({ refresh: true });
      for (const [key, list] of Object.entries(categories)) if (Object.hasOwn(result, key)) {
        const item = available[list].find(item => item.id === result[key]);
        if (!item || !item.available) throw error('PREFERENCE_UNAVAILABLE', item && item.reason || '所选应用或运行环境已不可用，请重新选择。');
      }
    }
    return result;
  }
  async function resolveTerminal({ cwd } = {}) {
    const selected = preferences().terminalShell;
    // Native terminal creation must not wait for unrelated WSL/runtime probes.
    const executables = detectExecutables();
    let id = selected;
    if (id === 'auto') id = platform === 'win32' ? (executables.powershell ? 'powershell' : executables.cmd ? 'cmd' : 'pwsh') : 'nativeShell';
    const wslReady = id !== 'wsl' || typeof options.probeWsl === 'function' && (await options.probeWsl({ terminalOnly: true })).terminalAvailable;
    if (!executables[id] || !wslReady) throw error('SHELL_UNAVAILABLE', '所选终端 Shell 已不可用，请在常规设置中重新选择。');
    return { file: executables[id], args: id === 'wsl' ? ['--cd', cwd] : id === 'cmd' ? ['/D'] : id === 'nativeShell' ? ['-l'] : ['-NoLogo', '-NoProfile'],
      label: ({ powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', cmd: '命令提示符', wsl: 'WSL' })[id] || paths.basename(executables[id]), cwd };
  }
  async function openFile(file, target = 'default') {
    const id = target === 'default' ? preferences().fileOpenTarget : target;
    if (!VALUES.fileOpenTarget.includes(id)) throw error('INVALID_FILE_TARGET', '文件打开方式无效。');
    if (id === 'relay') return { ok: true, target: 'relay' };
    if (id === 'system') { const message = await options.shell.openPath(file); if (message) throw error('OPEN_FAILED', message); return { ok: true, target: id }; }
    const { executables } = await capabilities({ refresh: true });
    if (!executables[id]) throw error('EDITOR_UNAVAILABLE', '所选编辑器已不可用，请在常规设置中重新选择。');
    await new Promise((resolve, reject) => {
      // -- terminates switches even for files whose basename starts with '-'.
      const child = spawnProcess(executables[id], ['--reuse-window', '--', file], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { ok: true, target: id };
  }
  async function diagnostics(input = {}) {
    if (typeof options.getSdkDiagnostics !== 'function') return { ok: false, error: '当前会话尚无配置诊断。' };
    return options.getSdkDiagnostics(input);
  }
  return { preferences, get, diagnostics, validatePatch, resolveTerminal, openFile, workspaceRoot: () => preferences().workspaceRoot || defaultWorkspaceRoot };
}

function registerGeneralPreferencesIpc({ ipcMain, getWindow, service, dialog, entryFile = resourcePath('renderer', 'index.html') }) {
  const expected = pathToFileURL(entryFile).href;
  const authorized = event => {
    const win = getWindow(), sender = event && event.sender;
    return !!win && !win.isDestroyed() && sender === win.webContents && !sender.isDestroyed()
      && event.senderFrame === sender.mainFrame && event.senderFrame.url === expected;
  };
  for (const [channel, operation] of [
    ['generalPreferences:get', (_event, input) => service.get(input)],
    ['generalPreferences:diagnostics', (_event, input) => service.diagnostics(input)],
    ['generalPreferences:pickWorkspaceRoot', async event => {
      const result = await dialog.showOpenDialog(getWindow(), { title: '选择任务文件夹', defaultPath: service.workspaceRoot(), properties: ['openDirectory', 'createDirectory'] });
      if (!authorized(event)) throw error('FORBIDDEN', '窗口已改变，请重新操作。');
      return result.canceled || !result.filePaths[0] ? { ok: false, canceled: true } : { ok: true, path: result.filePaths[0] };
    }],
  ]) ipcMain.handle(channel, async (event, input) => {
    if (!authorized(event)) return { ok: false, code: 'FORBIDDEN', error: '此窗口不能访问常规设置。' };
    try { return await operation(event, input || {}); }
    catch (cause) { return { ok: false, code: cause.code || 'PREFERENCES_UNAVAILABLE', error: cause.message || '无法读取常规设置。' }; }
  });
}

module.exports = { createGeneralPreferences, registerGeneralPreferencesIpc, normalizePreferences, normalizeParallelLimit, PARALLEL_LIMITS, DEFAULTS };
