'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { bridgeMcpServers } = require('./host-stdio-mcp');
const { mcpConfigKey } = require('./live-mcp-readiness');
const { validDistribution } = require('./sdk-task-resources');

const fail = (code, message) => Object.assign(new Error(message), { code });
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
function toWslPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw fail('WSL_PATH_UNSUPPORTED', 'WSL 路径无效。');
  if (WINDOWS_PATH.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replace(/\\/g, '/')}`;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  throw fail('WSL_PATH_UNSUPPORTED', 'WSL 目前仅支持本机磁盘上的任务和资源文件夹。');
}
function translateValue(value) {
  if (typeof value !== 'string') return value;
  return WINDOWS_PATH.test(value) ? toWslPath(value) : value;
}
function mapMcpServers(servers, options) {
  // The registry belongs to Relay's Windows host. Keep local commands and paths
  // there, regardless of the agent process's selected execution environment.
  return bridgeMcpServers(servers, options);
}

function runtimePath(base = __dirname) {
  return path.join(base, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}
function createAgentEnvironment(options = {}) {
  const platform = options.platform || process.platform, hostEnv = options.env || process.env;
  const getEnvironment = options.getEnvironment || (() => 'native');
  const homeDir = options.homeDir || os.homedir();
  const configDir = options.configDir || path.join(homeDir, '.claude');
  const linuxExecutable = options.linuxExecutable || runtimePath();
  const wslExecutable = options.wslExecutable || path.win32.join(hostEnv.SystemRoot || hostEnv.WINDIR || 'C:\\Windows', 'System32', 'wsl.exe');
  const spawnProcess = options.spawn || spawn;
  const runFile = options.runFile || ((file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
  }));
  const probeStates = new Map();
  const mcpContexts = new WeakMap();
  function mapForContext(servers, context) {
    const previous = context.bridges || new Map();
    const next = new Map();
    const result = {};
    for (const [name, config] of Object.entries(servers || {})) {
      if (!config || config.type === 'sdk' || config.type === 'http' || config.type === 'sse' || config.url) {
        result[name] = config; continue;
      }
      const key = mcpConfigKey({ [name]: config });
      const cached = previous.get(name);
      const mapped = cached && cached.key === key ? cached.mapped : mapMcpServers({ [name]: config }, { cwd: context.cwd, env: context.env })[name];
      next.set(name, { key, mapped }); result[name] = mapped;
    }
    context.bridges = next;
    return result;
  }
  async function run(args) { return String(await runFile(wslExecutable, args)).replace(/\0/g, '').trim(); }
  async function checkResources(servers = {}, resourceDir = configDir) {
    // User hooks are loaded from the shared directory. Do not let Windows-only
    // hooks silently disappear or change behavior inside Linux.
    const settingsFile = path.join(resourceDir, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      let settings; try { settings = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8')); }
      catch (_) { throw fail('WSL_SETTINGS_INVALID', 'Claude 用户设置无法读取，无法确认 WSL 资源兼容性。'); }
      const hookCommands = [];
      function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (typeof value.command === 'string') hookCommands.push(value.command);
        for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
      }
      visit(settings.hooks);
      if (hookCommands.some(command => /(?:[a-z]:\\|\b(?:cmd|powershell|pwsh)(?:\.exe)?\b|\.(?:exe|cmd|bat)\b)/i.test(command))) {
        throw fail('WSL_HOOK_INCOMPATIBLE', '用户 Hook 包含 Windows 命令，请改为 Linux 兼容命令后启用 WSL。');
      }
    }
  }
  async function probe({ refresh = false, terminalOnly = false, runtimeOnly = false } = {}) {
    if (terminalOnly) {
      const existing = probeStates.get('runtime') || probeStates.get('all');
      if (existing && existing.cached && Date.now() - existing.cachedAt < 30000) return existing.cached;
      try { if (platform !== 'win32') throw Error(); await run(['--exec', 'uname', '-m']); return { terminalAvailable: true }; }
      catch (_) { return { terminalAvailable: false, reason: '未安装可启动的 WSL 默认发行版，请先安装并完成初始化。' }; }
    }
    // Runtime availability is independent of whichever resource directory a
    // particular query pins. Never share a global resource failure with an
    // isolated query's preflight.
    const key = runtimeOnly ? 'runtime' : 'all';
    if (!probeStates.has(key)) probeStates.set(key, { cached: null, cachedAt: 0, pending: null });
    const state = probeStates.get(key);
    if (state.pending) return state.pending;
    if (!refresh && state.cached && Date.now() - state.cachedAt < 30000) return state.cached;
    state.pending = (async () => {
      let terminalAvailable = false;
      try {
        if (platform !== 'win32') throw fail('WSL_UNAVAILABLE', 'WSL 运行环境仅适用于 Windows。');
        // Sample the actual default distro and architecture in one existing
        // preflight. Every later launch pins that distro, even if Windows changes
        // its default while this snapshot is cached or queued.
        const identity = await run(['--exec', 'sh', '-c', 'printf "%s\\n" "$WSL_DISTRO_NAME"; uname -m']); terminalAvailable = true;
        const [wslDistribution, arch] = identity.split(/\r?\n/);
        if (arch !== 'x86_64') throw fail('WSL_ARCH_UNSUPPORTED', '当前 WSL 发行版需要 x86_64 架构。');
        if (!validDistribution(wslDistribution)) throw fail('WSL_DISTRIBUTION_UNAVAILABLE', '无法确认 WSL 发行版名称，请重新检测工作环境。');
        if (!fs.existsSync(linuxExecutable)) throw fail('WSL_RUNTIME_MISSING', 'Relay 的 Linux 运行时未安装，请重新安装当前版本。');
        const executable = toWslPath(linuxExecutable);
        const version = await run(['--distribution', wslDistribution, '--exec', executable, '--version']);
        const expected = options.expectedVersion || '2.1.266';
        if (!version.includes(expected)) throw fail('WSL_RUNTIME_VERSION', 'Relay 的 Linux 运行时版本不匹配，请重新安装当前版本。');
        if (!runtimeOnly) await checkResources(typeof options.getMcpServers === 'function' ? options.getMcpServers() : {});
        return { available: true, terminalAvailable, executable, wslExecutable, wslDistribution, version: expected };
      } catch (cause) {
        const known = String(cause.code || '').startsWith('WSL_');
        return { available: false, terminalAvailable, code: known ? cause.code : 'WSL_UNAVAILABLE',
          reason: known ? cause.message : terminalAvailable ? 'WSL 无法运行内置 Linux 运行时，请确认发行版支持 glibc 且允许执行 Windows 磁盘文件。' : '未安装可启动的 WSL 默认发行版，请先安装并完成初始化。' };
      }
    })();
    try { state.cached = await state.pending; state.cachedAt = Date.now(); return state.cached; } finally { state.pending = null; }
  }
  async function prepareOptions(input, { onSpawn, onPrepared } = {}) {
    // An already prepared provider snapshot pins the environment across async
    // queueing. A preference change must not mutate the launched task.
    const environment = input.env && input.env.RELAY_AGENT_ENVIRONMENT || getEnvironment();
    if (environment !== 'wsl') {
      try { if (onPrepared) onPrepared(Object.freeze({ agentEnvironment: 'native', cwd: input.cwd || process.cwd() })); } catch (_) {}
      return input;
    }
    const info = await probe({ runtimeOnly: true });
    if (!info.available) throw fail(info.code || 'WSL_UNAVAILABLE', info.reason);
    if (input.abortController && input.abortController.signal.aborted) throw fail('ABORT_ERR', '任务已取消。');
    const resourceDir = input.env && input.env.CLAUDE_CONFIG_DIR || configDir;
    await checkResources({}, resourceDir);
    const mcpContext = { cwd: input.cwd || process.cwd(), env: input.env };
    const mcpServers = mapForContext(input.mcpServers, mcpContext);
    const env = { ...input.env, RELAY_AGENT_ENVIRONMENT: 'wsl', CLAUDE_CONFIG_DIR: toWslPath(resourceDir) };
    for (const key of ['HOME', 'USERPROFILE', 'PATH', 'Path', 'TEMP', 'TMP', 'SHELL', 'COMSPEC', 'ComSpec', 'CLAUDE_CODE_GIT_BASH_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'XDG_CACHE_HOME', 'TMPDIR', 'RELAY_SCRATCH_DIR']) if (env[key]) env[key] = translateValue(env[key]);
    // Tool subprocesses inherit the per-conversation scratch on Linux too.
    // Windows stdio MCP bridges keep mcpContext.env with native paths instead.
    if (env.RELAY_SCRATCH_DIR) env.TEMP = env.TMP = env.TMPDIR = env.RELAY_SCRATCH_DIR;
    const forbidden = new Set(['HOME', 'USERPROFILE', 'PATH', 'SHELL', 'COMSPEC', 'CLAUDE_CODE_GIT_BASH_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', ...(!env.RELAY_SCRATCH_DIR ? ['TEMP', 'TMP'] : [])]);
    // WSLENV names are not values, but reusing the spawning process's list can
    // re-enable discarded provider aliases. Build it only from sanitized SDK env.
    const pass = new Set();
    for (const [key, value] of Object.entries(env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== 'WSLENV' && value != null) pass.add(key);
    env.WSLENV = [...pass].join(':');
    const prepared = { ...input, cwd: toWslPath(input.cwd || process.cwd()),
      additionalDirectories: (input.additionalDirectories || []).map(toWslPath), mcpServers,
      pathToClaudeCodeExecutable: info.executable, env };
    const executionContext = Object.freeze({ agentEnvironment: 'wsl', wslDistribution: info.wslDistribution, cwd: prepared.cwd });
    for (const key of ['debugFile', 'settings', 'resume']) if (typeof prepared[key] === 'string' && WINDOWS_PATH.test(prepared[key])) prepared[key] = toWslPath(prepared[key]);
    if (Array.isArray(input.plugins)) prepared.plugins = input.plugins.map(plugin => plugin && plugin.type === 'local' ? { ...plugin, path: toWslPath(plugin.path) } : plugin);
    if (prepared.settings && prepared.settings.permissions && Array.isArray(prepared.settings.permissions.additionalDirectories)) {
      prepared.settings = { ...prepared.settings, permissions: { ...prepared.settings.permissions,
        additionalDirectories: prepared.settings.permissions.additionalDirectories.map(toWslPath) } };
    }
    if (prepared.settings && typeof prepared.settings === 'object' && typeof prepared.settings.autoMemoryDirectory === 'string') {
      prepared.settings = { ...prepared.settings, autoMemoryDirectory: toWslPath(prepared.settings.autoMemoryDirectory) };
    }
    // The native Agent owns its prompt instead of a parent delegation message.
    // Translate the same authorized resource roots in either prompt surface.
    const replacements = [...new Set([input.cwd, ...(input.additionalDirectories || []), resourceDir].filter(directory => typeof directory === 'string' && WINDOWS_PATH.test(directory)))].sort((a, b) => b.length - a.length);
    function translatePrompt(value) {
      if (typeof value !== 'string') return value;
      for (const directory of replacements) {
        const translated = toWslPath(directory);
        value = value.split(JSON.stringify(directory)).join(JSON.stringify(translated));
        value = value.split(directory).join(translated);
        value = value.split(directory.replace(/\\/g, '/')).join(translated);
      }
      return value;
    }
    if (typeof prepared.systemPrompt === 'string') prepared.systemPrompt = translatePrompt(prepared.systemPrompt);
    else if (prepared.systemPrompt && typeof prepared.systemPrompt.append === 'string') {
      prepared.systemPrompt = { ...prepared.systemPrompt, append: translatePrompt(prepared.systemPrompt.append) };
    }
    if (prepared.systemPrompt?.type === 'custom') {
      prepared.systemPrompt = { ...prepared.systemPrompt,
        prompt: Array.isArray(prepared.systemPrompt.prompt)
          ? prepared.systemPrompt.prompt.map(translatePrompt) : translatePrompt(prepared.systemPrompt.prompt) };
    }
    if (prepared.agents && typeof prepared.agents === 'object') {
      prepared.agents = Object.fromEntries(Object.entries(prepared.agents).map(([name, agent]) => [name, {
        ...agent, prompt: translatePrompt(agent.prompt),
        ...(typeof agent.criticalSystemReminder_EXPERIMENTAL === 'string' ? { criticalSystemReminder_EXPERIMENTAL: translatePrompt(agent.criticalSystemReminder_EXPERIMENTAL) } : {}),
      }]));
    }
    prepared.spawnClaudeCodeProcess = spawnOptions => {
      const args = [...spawnOptions.args];
      // The SDK may provide a platform command prefix. It is never executed in
      // WSL; the verified Linux runtime is the sole executable.
      if (args[0] === input.pathToClaudeCodeExecutable || args[0] === info.executable) args.shift();
      const pathFlags = new Set(['--add-dir', '--plugin-dir', '--plugin-dir-no-mcp', '--debug-file', '--settings', '--resume', '--session-debug-file']);
      for (let index = 1; index < args.length; index++) if (pathFlags.has(args[index - 1]) && WINDOWS_PATH.test(args[index])) args[index] = toWslPath(args[index]);
      const launchEnv = { ...spawnOptions.env, ...env };
      // Only the OS loader's basic variables may be supplied outside SDK env.
      for (const key of ['SystemRoot', 'WINDIR']) if (!launchEnv[key] && hostEnv[key]) launchEnv[key] = hostEnv[key];
      const keys = Object.keys(launchEnv).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== 'WSLENV' && !forbidden.has(key.toUpperCase()) && launchEnv[key] != null);
      launchEnv.WSLENV = [...new Set(keys)].join(':');
      const child = spawnProcess(wslExecutable, ['--distribution', info.wslDistribution, '--cd', prepared.cwd, '--exec', info.executable, ...args], {
        cwd: homeDir, env: launchEnv, signal: spawnOptions.signal,
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      try { if (onSpawn) onSpawn(child, executionContext); } catch (_) {}
      return child;
    };
    mcpContexts.set(prepared, mcpContext);
    try { if (onPrepared) onPrepared(executionContext); } catch (_) {}
    return prepared;
  }
  async function inspectSettings({ cwd, settingSources = ['user'], wslDistribution } = {}) {
    if (platform !== 'win32') return { ok: false, code: 'WSL_UNAVAILABLE', error: 'WSL 配置诊断仅适用于 Windows。' };
    try {
      const expandAsar = value => value.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const script = expandAsar(options.diagnosticScript || path.join(__dirname, 'sdk-settings-probe.cjs'));
      const sdk = expandAsar(options.sdkModulePath || path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'));
      const input = { cwd: toWslPath(cwd || homeDir), settingSources: settingSources.filter(source => ['user', 'project', 'local'].includes(source)), configDir: toWslPath(configDir), sdkPath: toWslPath(sdk) };
      const cached = probeStates.get('runtime')?.cached;
      const distribution = wslDistribution === undefined ? (cached?.available ? cached.wslDistribution : null) : wslDistribution;
      if (distribution !== null && !validDistribution(distribution)) throw fail('WSL_DISTRIBUTION_UNAVAILABLE', '无法确认配置诊断的 WSL 发行版。');
      const prefix = distribution ? ['--distribution', distribution] : [];
      const result = JSON.parse(await run([...prefix, '--cd', input.cwd, '--exec', 'node', toWslPath(script), Buffer.from(JSON.stringify(input)).toString('base64')]));
      return result && typeof result.ok === 'boolean' ? result : { ok: false, error: 'WSL 配置诊断返回了无效结果。' };
    } catch (_) {
      return { ok: false, code: 'WSL_DIAGNOSTICS_UNAVAILABLE', error: 'WSL 配置诊断需要可用的 Node.js 18.18 或更新版本；任务运行不受影响。' };
    }
  }
  return { probe, prepareOptions, inspectSettings,
    async prepareMcpServers(servers, { environment, resourceDir, prepared } = {}) {
      if (environment !== 'wsl') return servers;
      await checkResources({}, resourceDir || configDir);
      return mapForContext(servers, mcpContexts.get(prepared) || {});
    },
  };
}

module.exports = { createAgentEnvironment, toWslPath, mapMcpServers, runtimePath };
