// claude-sdk.js — Relay 与 @anthropic-ai/claude-agent-sdk 的唯一接触面
//
// 为什么要有这一层：
//   历史上 Relay 直接 spawn 用户机器上的 claude.exe，再手工按行 JSON.parse stdout。
//   那套代码要处理「找不到 exe / exe 损坏 / npm shim 解析 / 中文经 GBK 二次转码」等一堆
//   与业务无关的杂事。改用官方 SDK 后这些统统消失 —— SDK 自带平台专属的 claude.exe
//   （@anthropic-ai/claude-agent-sdk-win32-x64），不再依赖用户是否装过 Claude Code。
//
// 关键设计：事件契约保持不变
//   实测确认 SDK 吐出的消息结构与 CLI 的 stream-json 逐字段一致
//   （type:'system' + subtype:'task_started' + task_id/tool_use_id …），
//   所以这里【原样】把消息交给调用方的 onEvent，main.js 与 renderer 的事件处理一行不用改。
//   这是让这次迁移可控的前提，别在这一层做「翻译」或「归一化」，那会引入不必要的偏差。
//
// 为什么自己接管 spawn（spawnClaudeCodeProcess）：
//   常驻会话的 MCP watchdog 需要 claude 进程的 pid 去枚举它的直接子进程（见 main.js
//   snapshotMcpChildren 的三个坑）。SDK 默认自己 spawn、不暴露 pid，所以这里提供自定义
//   spawn 把真实 ChildProcess 截下来。ChildProcess 天然满足 SDK 的 SpawnedProcess 接口。
//
// ESM/CJS：SDK 是 ESM-only，Relay 主进程是 CommonJS —— 实测动态 import() 即可，
//   不必把 main.js 改造成 ESM。加载结果缓存，避免每轮重复解析 1.2MB 的 sdk.mjs。

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { version: RELAY_VERSION } = require('./package.json');
const { snapshotAttachments, prepareAttachmentContent, stripAttachmentImageData } = require('./attachment-input');
const { createUsageObserver } = require('./usage-capture');
const { LiveAsyncAgentTracker, liveResultDisposition } = require('./live-async-agent-tracker');
const { LiveTurnRouter } = require('./live-turn-router');
const { TaskClock } = require('./task-clock');
const { collectStructuredOutput } = require('./sdk-structured-output');
const { RETRY_ENV, RETRY_CONTROL_FAILURE, SdkRetryGuard, interruptFailedConnection, closeFailedRetryQuery } = require('./sdk-retry-policy');
const { LiveMcpReadiness, McpControlQueue } = require('./live-mcp-readiness');
const { normalizeExecutionMode, executionToolPolicy, LiveExecutionModes, PLAN_INSTRUCTIONS } = require('./execution-modes');
const { McpPermissionOverrides, requiresMcpApproval, mcpApprovalHook } = require('./sdk-mcp-permissions');
const { validateFlagSettings, customPrompt } = require('./sdk-runtime-preferences');
const { sanitizeNativeEvent } = require('./sdk-native-events');
const { configureSdkErrorCategories, annotateError } = require('./sdk-error-categories');
const { createDiagnosticLog } = require('./sdk-diagnostics-log');
const { relayInstructionsPrompt } = require('./relay-instructions');
const { taskFileInstructions, createTaskFilePolicy } = require('./task-file-policy');

let sdkPromise = null;
let runtimeEnvironmentAdapter = null;
const runtimeMcpMappers = new WeakMap();
const runtimeTaskFilePolicies = new WeakMap();
const { withDrainedExit } = require('./sdk-process-adapter');
const { createRuntimeMcpMapper } = require('./host-stdio-mcp');

// The host supplies an environment adapter; each Query captures its prepared
// launch once. Switching preferences cannot mutate an already running process.
function configureRuntimeEnvironment(adapter = null) {
  if (adapter !== null && typeof adapter.prepareOptions !== 'function') throw new TypeError('Runtime environment must provide prepareOptions');
  runtimeEnvironmentAdapter = adapter;
}
async function prepareRuntimeOptions(options, onSpawn, onPrepared) {
  const adapter = runtimeEnvironmentAdapter;
  // Retain the host path before an adapter translates it for the subprocess.
  const resourceDir = options.env && options.env.CLAUDE_CONFIG_DIR;
  const canceled = () => options.abortController && options.abortController.signal.aborted;
  if (canceled()) throw new Error('Claude launch canceled');
  const prepared = adapter ? await adapter.prepareOptions(options, { onSpawn, onPrepared }) : options;
  if (canceled()) throw new Error('Claude launch canceled');
  if (!prepared || typeof prepared !== 'object') throw new Error('Claude runtime preparation failed');
  runtimeTaskFilePolicies.get(options)?.prepare({ cwd: prepared.cwd,
    scratchDir: prepared.env?.RELAY_SCRATCH_DIR });
  if (adapter && typeof adapter.prepareMcpServers === 'function') {
    const environment = prepared.env && prepared.env.RELAY_AGENT_ENVIRONMENT || 'native';
    runtimeMcpMappers.set(prepared, createRuntimeMcpMapper(prepared.mcpServers,
      servers => adapter.prepareMcpServers(servers, { environment, resourceDir, prepared })));
  }
  if (typeof prepared.spawnClaudeCodeProcess === 'function') {
    const spawnProcess = prepared.spawnClaudeCodeProcess;
    prepared.spawnClaudeCodeProcess = opts => withDrainedExit(spawnProcess(opts));
  }
  return prepared;
}

// 连接、认证和模型由 Relay 的服务商快照决定。启动环境里的其它 Claude
// 客户端配置不能混进来；网络代理、证书及技能/MCP/会话目录等普通环境保留。
const RELAY_PROVIDER_ENV_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
  'CLAUDE_CONTEXT_COLLAPSE_MODEL',
  'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
  'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
]);
const relayProviderEnvKeys = new Set(RELAY_PROVIDER_ENV_KEYS);
function isRelayProviderEnvKey(key) {
  return relayProviderEnvKeys.has(key)
    || key.startsWith('ANTHROPIC_DEFAULT_')
    || key.startsWith('ANTHROPIC_CUSTOM_MODEL_OPTION');
}

const RUNTIME_PATH_ENV_KEYS = new Set(['CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'XDG_CACHE_HOME', 'TMPDIR', 'TEMP', 'TMP', 'RELAY_SCRATCH_DIR']);
function buildRelayRuntimeEnv(runtimeEnv = {}) {
  const env = { ...process.env };
  const explicitPaths = new Set(Object.keys(runtimeEnv || {}).map(key => key.toUpperCase()).filter(key => RUNTIME_PATH_ENV_KEYS.has(key)));
  // Windows environment names are case-insensitive, including values inherited
  // through another Node process where differently cased keys can coexist.
  const inheritedHostAuthKey = Object.entries(env).find(([key]) => key.toUpperCase() === 'CLAUDE_CODE_HOST_AUTH_ENV_VAR')?.[1];
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (isRelayProviderEnvKey(normalized) || Object.hasOwn(RETRY_ENV, normalized) || normalized === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
      || explicitPaths.has(normalized) || (inheritedHostAuthKey && normalized === inheritedHostAuthKey.toUpperCase())) delete env[key];
  }
  Object.assign(env, RETRY_ENV);
  if (runtimeEnv && typeof runtimeEnv === 'object') {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const normalized = key.toUpperCase();
      const targetKey = isRelayProviderEnvKey(normalized) || Object.hasOwn(RETRY_ENV, normalized) || normalized === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY' || RUNTIME_PATH_ENV_KEYS.has(normalized) ? normalized : key;
      if (value === undefined || value === null || value === '') delete env[targetKey];
      else env[targetKey] = String(value);
    }
  }
  // Official host-provider contract, verified with the pinned SDK 0.3.266 /
  // Claude Code 2.1.266. Keep user resource settings while preventing startup
  // and hot reload from replacing this process's endpoint/auth/model mapping.
  // Inherited proxy/CA env remains available; never put keys in --settings argv.
  // Keep a single canonical key even when Windows inherited case variants.
  // Relay owns long-term memory; caller and shell values cannot restore SDK writes.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `relay/${RELAY_VERSION}`;
  return env;
}

function buildRelayModelSettings(model, runtimeEnv = {}) {
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && value.trim()) ids.add(value.trim()); };
  add(model);
  for (const [key, value] of Object.entries(runtimeEnv || {})) {
    const normalized = key.toUpperCase();
    if (normalized === 'ANTHROPIC_MODEL' || normalized === 'ANTHROPIC_SMALL_FAST_MODEL'
      || /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(normalized)) add(value);
  }
  // Host-managed auth does not suppress direct user model settings. The flag
  // layer keeps Relay's routes selectable and disables user fallback chains;
  // explicit identity mappings override inherited canonical-model remaps.
  // This object contains model names only: never serialize the runtime env or
  // authentication into SDK --settings arguments.
  const settings = { enforceAvailableModels: false, fallbackModel: [] };
  if (ids.size) {
    settings.availableModels = [...ids];
    const identities = new Set(ids);
    for (const id of ids) {
      // Claude strips the context tag before looking up a canonical mapping.
      // Preserve the actual route ID and namespace; only shadow its base key.
      const base = id.replace(/(?:\[1m\])+$/i, '').trim();
      if (base) identities.add(base);
    }
    settings.modelOverrides = Object.fromEntries([...identities].map(id => [id, id]));
  }
  return settings;
}

function buildRelayRuntimeSettings(runtimePolicy, model, runtimeEnv) {
  const settings = { ...(runtimePolicy?.settings || {}), ...buildRelayModelSettings(model, runtimeEnv),
    autoMemoryEnabled: false, autoDreamEnabled: false };
  // Old callers may still supply an SDK directory. Do not pass it to the SDK,
  // create it, migrate it, or remove any historical files from it.
  delete settings.autoMemoryDirectory;
  return settings;
}

// 懒加载 + 缓存。第一次调用会解析 sdk.mjs（~1.2MB），之后直接命中缓存。
function loadSdk() {
  if (!sdkPromise) {
    const entry = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
    sdkPromise = import(pathToFileURL(entry).href).then(sdk => { configureSdkErrorCategories(sdk); return sdk; }).catch((e) => {
      sdkPromise = null;   // 失败不缓存，下次还能重试
      throw new Error(`claude-agent-sdk 加载失败：${e.message}`);
    });
  }
  return sdkPromise;
}

// 自带运行时的绝对路径。
//   三个坑叠在一起，必须小心处理，不能写死一条路径：
//   ① 位置不同：开发环境 npm 会把平台包提升到顶层 node_modules；electron-builder 打包后
//      它却嵌在 claude-agent-sdk/node_modules/ 里（实测打包产物如此）。
//   ② asar：253MB 的 exe 不能进 asar（进了就无法 spawn），package.json 里用 asarUnpack
//      把它排出去，真实文件落在 app.asar.unpacked 下。
//   ③ ⚠️ Electron 给 fs 打了补丁，**asar 内的路径 existsSync 也返回 true**。所以绝不能把
//      asar 路径本身当候选去 existsSync —— 它会「存在」但 spawn 必失败，而且 SDK 报的错是
//      「binary exists but failed to launch ... libc 不匹配」，完全指错方向（实测踩过）。
//      因此：路径一旦落在 app.asar 内，就【只】保留 .unpacked 变体，不保留原路径。
//   返回第一个真实存在的候选；全都不存在时返回 null，交由 SDK 用它自己的解析逻辑兜底。
const RUNTIME_PKG = `claude-agent-sdk-${process.platform}-${process.arch}`;
const RUNTIME_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';
let cachedExecutable;

function bundledExecutable() {
  if (cachedExecutable !== undefined) return cachedExecutable;
  const rels = [
    // 开发环境：npm 提升到顶层
    path.join('node_modules', '@anthropic-ai', RUNTIME_PKG, RUNTIME_BIN),
    // 打包产物：嵌在 SDK 自己的 node_modules 下
    path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', RUNTIME_PKG, RUNTIME_BIN),
  ];
  const candidates = rels.map((rel) => {
    const p = path.join(__dirname, rel);
    // 坑③：asar 内的路径不可执行，直接换成 unpacked，不保留原路径
    return p.includes(`app.asar${path.sep}`)
      ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      : p;
  });
  cachedExecutable = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
  if (!cachedExecutable) {
    console.warn('[sdk] 未找到内置运行时，已尝试：\n  %s', candidates.join('\n  '));
  }
  return cachedExecutable;
}

// 把 Relay 的调用参数翻译成 SDK Options。一次性与常驻共用，保证两条路行为一致
// （这正是原来 buildClaudeArgs 的职责）。
function buildOptions({
  cwd, validWorkingDir, agentProjectRoot, scratchDir, model, effort, sessionId, forkSession, resumeSessionAt, forkSessionId, resumeDropsTurn,
  permissionMode, mcpServers, mcpServersFactory, appendSystemPrompt, memoryDir, onSpawn, abortController,
  canUseTool, disallowAskUserQuestion = false, enableFileCheckpointing = false, tools, runtimeEnv,
  executionMode, executionModeState, runtimePolicy, nativeAgent, onElicitation, stderr, onInstructionsLoaded,
  perTaskStopAffordance = false, outputFormat, mcpPermissionOverrides, onUserDialog, supportedDialogKinds,
  onNativeHook, plugins, customSystemPrompt, onToolProposal, onMemoryTool, includeRelayInstructions = true,
}, sdk) {
  const fileInstructions = taskFileInstructions(cwd, scratchDir);
  const relayInstructions = includeRelayInstructions ? relayInstructionsPrompt(runtimePolicy?.relayInstructions) : '';
  appendSystemPrompt = [appendSystemPrompt, relayInstructions, fileInstructions].filter(Boolean).join('\n\n');
  const sessionEnv = scratchDir ? { ...runtimeEnv, TEMP: scratchDir, TMP: scratchDir, TMPDIR: scratchDir, RELAY_SCRATCH_DIR: scratchDir } : runtimeEnv;
  const additionalDirectories = [];
  if (scratchDir) additionalDirectories.push(scratchDir);
  if (memoryDir) additionalDirectories.push(memoryDir);
  if (validWorkingDir) additionalDirectories.push(validWorkingDir);
  // Agent 项目根不在 cwd 链上时单独授权（避免与 validWorkingDir 重复）
  if (agentProjectRoot && path.resolve(agentProjectRoot) !== path.resolve(validWorkingDir || '')) {
    additionalDirectories.push(agentProjectRoot);
  }

  const getExecutionMode = typeof executionModeState === 'function'
    ? executionModeState : () => normalizeExecutionMode(executionMode);
  const policy = executionToolPolicy(getExecutionMode, canUseTool);
  const options = {
    ...(runtimePolicy?.options || {}),
    cwd,
    additionalDirectories,
    // 保留用户技能、Agent、MCP 等资源；连接/认证/模型由下方宿主托管环境锁定。
    settingSources: runtimePolicy?.settingSources || ['user'],
    permissionMode: getExecutionMode().kind === 'plan' ? 'plan' : permissionMode || 'default',
    planModeInstructions: PLAN_INSTRUCTIONS,
    hooks: policy.hooks,
    includePartialMessages: true,   // 打字机效果所需的 stream_event
    pathToClaudeCodeExecutable: bundledExecutable(),
    // SDK 支持会话级 env；显式传入完整环境对象，不修改 process.env。
    env: buildRelayRuntimeEnv(sessionEnv),
    settings: buildRelayRuntimeSettings(runtimePolicy, model, runtimeEnv),
  };
  // Relay 的设置页允许用户在常驻会话存活期间切到 bypassPermissions。这个开关本身
  // 不会放宽权限，只是让随后显式的 setPermissionMode('bypassPermissions') 可以生效。
  options.allowDangerouslySkipPermissions = true;
  options.hooks.PreToolUse.push({ hooks: [mcpApprovalHook(mcpPermissionOverrides)] });
  if (typeof onMemoryTool === 'function') options.hooks.PreToolUse.push({ hooks: [onMemoryTool] });
  if (typeof onToolProposal === 'function') options.hooks.PreToolUse.push({ hooks: [onToolProposal] });
  if (relayInstructions || fileInstructions) {
    const taskFiles = createTaskFilePolicy({ cwd, scratchDir, relayInstructions, getExecutionMode,
      signal: abortController?.signal });
    options.hooks.PreToolUse.push({ hooks: [taskFiles.delegate] });
    if (fileInstructions) {
      options.hooks.UserPromptSubmit = [{ hooks: [taskFiles.submit] }];
      options.hooks.Stop = [{ hooks: [taskFiles.stop] }];
    }
    runtimeTaskFilePolicies.set(options, taskFiles);
  }
  if (nativeAgent?.agent && nativeAgent?.agents) {
    options.agent = nativeAgent.agent;
    options.agents = Object.fromEntries(Object.entries(nativeAgent.agents).map(([name, agent]) => [name,
      fileInstructions || relayInstructions ? { ...agent, prompt: [agent.prompt, relayInstructions, fileInstructions].filter(Boolean).join('\n\n') } : agent]));
  }
  if (typeof onElicitation === 'function') options.onElicitation = onElicitation;
  if (typeof onUserDialog === 'function' && Array.isArray(supportedDialogKinds) && supportedDialogKinds.length) {
    options.onUserDialog = onUserDialog;
    options.supportedDialogKinds = [...supportedDialogKinds];
  }
  if (Array.isArray(plugins) && plugins.length) options.plugins = plugins;
  if (typeof onNativeHook === 'function') for (const hook of ['SessionStart', 'StopFailure', 'Elicitation', 'ConfigChange', 'CwdChanged', 'FileChanged', 'PostToolUse']) {
    options.hooks[hook] = [...(options.hooks[hook] || []), { hooks: [async (input, toolUseId, context) => {
      // Observers never grant permission or change the tool's result.
      try {
        const result = await onNativeHook(input, toolUseId, context);
        if (['SessionStart', 'CwdChanged', 'FileChanged'].includes(hook) && Array.isArray(result?.watchPaths)) {
          return { hookSpecificOutput: { hookEventName: hook, watchPaths: result.watchPaths.slice(0, 16).filter(p => typeof p === 'string') } };
        }
      } catch (_) {}
      return {};
    }] }];
  }
  if (typeof stderr === 'function') options.stderr = stderr;
  if (perTaskStopAffordance) options.perTaskStopAffordance = true;
  if (outputFormat) options.outputFormat = outputFormat;
  if (typeof onInstructionsLoaded === 'function') options.hooks = { ...options.hooks,
    InstructionsLoaded: [{ hooks: [async input => { onInstructionsLoaded(input); return {}; }] }] };

  // 交互式 Relay 会话通过 canUseTool 承接 AskUserQuestion 与权限请求。后台无人值守
  // 任务仍可显式禁用 AskUserQuestion，避免出现没有 UI 消费者的永久等待。
  if (disallowAskUserQuestion) options.disallowedTools = [...new Set([...(options.disallowedTools || []), 'AskUserQuestion'])];
  if (Array.isArray(tools)) options.tools = tools;
  if (typeof canUseTool === 'function' || typeof executionModeState === 'function' || getExecutionMode().kind === 'plan'
      || typeof mcpPermissionOverrides === 'function' || Object.keys(mcpPermissionOverrides || {}).length) {
    options.canUseTool = (name, input, sdkOptions) => policy.canUseTool(name, input, { ...sdkOptions,
      relayMcpApprovalRequired: requiresMcpApproval(name, mcpPermissionOverrides),
      relayMcpPermissionOverrides: mcpPermissionOverrides,
    });
  }
  if (enableFileCheckpointing) options.enableFileCheckpointing = true;
  // SDK 的 supportedModels() 可能返回带上下文窗口后缀的值（例如 opus[1m]）。
  // 保留 Relay 的 haiku/sonnet/opus 别名兼容，同时允许把 SDK 返回的真实 value 原样传回。
  if (typeof model === 'string' && model.trim()) options.model = model.trim();
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) options.effort = effort;
  if (sessionId) options.resume = sessionId;
  if (forkSession) {
    const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
    if (!uuid.test(sessionId || '') || !uuid.test(forkSessionId || '') || !uuid.test(resumeSessionAt || '') || forkSessionId === sessionId) throw new Error('原生分支续接参数无效');
    options.forkSession = true;
    options.resumeSessionAt = resumeSessionAt;
    options.sessionId = forkSessionId;
    if (resumeDropsTurn !== undefined) {
      if (!uuid.test(resumeDropsTurn)) throw new Error('重试轮次标识无效');
      options.resumeDropsTurn = resumeDropsTurn;
    }
  }
  // MCP 有两种给法：
  //   · mcpServers        —— 现成的配置对象（如 stdio 型的外部 server）
  //   · mcpServersFactory —— 需要 SDK 本身才能构造的（进程内 server 要用 createSdkMcpServer/tool），
  //     所以延迟到这里、拿到已加载的 sdk 再造。这样 claude-sdk.js 不必知道具体是哪个业务 server。
  const factored = typeof mcpServersFactory === 'function' && sdk ? mcpServersFactory(sdk) : null;
  const allMcp = { ...(mcpServers || {}), ...(factored || {}) };
  if (Object.keys(allMcp).length) options.mcpServers = allMcp;
  if (appendSystemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: appendSystemPrompt, snapshot: true };
  const custom = customSystemPrompt || runtimePolicy?.summary?.runtimePreferences?.customSystemPrompt;
  if (custom) options.systemPrompt = customPrompt(custom.static, [...(custom.dynamic || []), appendSystemPrompt || ''], sdk);
  if (abortController) options.abortController = abortController;

  // 自定义 spawn：把真实 ChildProcess 截下来交给调用方（常驻会话的 MCP watchdog 要 pid）。
  // ChildProcess 已满足 SDK 的 SpawnedProcess 接口，直接返回即可。
  if (onSpawn) {
    options.spawnClaudeCodeProcess = (spawnOpts) => {
      const child = spawn(spawnOpts.command, spawnOpts.args, {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        signal: spawnOpts.signal,
        shell: false,        // 不走 cmd —— 避免中文 prompt 经 GBK 二次转码乱码
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      try { onSpawn(child); } catch (_) {}
      return child;
    };
  }
  return options;
}

// Only factory-created, in-process servers are permanent. External/user MCP
// entries must remain removable when a reused session receives a new snapshot.
function buildMcpSessionOptions(params, sdk) {
  let baseMcpServers = {};
  const factory = params.mcpServersFactory;
  const options = buildOptions({
    ...params,
    mcpServersFactory: typeof factory === 'function' ? (loadedSdk) => {
      const servers = factory(loadedSdk) || {};
      baseMcpServers = Object.fromEntries(Object.entries(servers)
        .filter(([, config]) => config && config.type === 'sdk'));
      return servers;
    } : undefined,
  }, sdk);
  return { options, baseMcpServers };
}

// ── 一次性执行 ──
// 对应原来的 runClaudeJob：跑完即结束，用于定时任务与无 convId 的兼容回退。
// 返回 { handle }，handle 鸭子类型兼容原来的 ChildProcess（jobs map 与 claude:abort 都只用
// 到 .pid / .kill()），所以上层的中止逻辑不用改。
async function consumeOneShotMessages(messages, emit, { userMessageId } = {}) {
  const tracker = new LiveAsyncAgentTracker();
  const router = userMessageId ? new LiveTurnRouter() : null;
  if (router) router.begin(userMessageId);
  for await (const raw of messages) {
    const normalized = TaskClock.normalizeEvent(raw);
    const msg = router ? router.accept(normalized) : normalized;
    if (!msg) continue;
    tracker.ingest(msg);
    const disposition = TaskClock.isRootEvent(msg) ? liveResultDisposition(msg, tracker) : null;
    if (router && disposition) router.noteResult(disposition, tracker.size);
    // result.permission_denials 是 SDK 的权威拒绝清单，但每项还带原始 tool_input。
    // Relay 只需要工具名与数组长度来展示拒绝记录，不能把无人值守任务的输入参数
    // 继续转发到任务事件日志。
    emit(annotateError(sanitizeNativeEvent(sanitizeResultPermissionDenials(msg))));
    if (disposition === 'finish') return msg;
  }
  return null;
}

const MAX_PERMISSION_DENIED_TOOL_NAMES = 12;
const MAX_PERMISSION_DENIED_TOOL_NAME_LENGTH = 120;

function compactPermissionDeniedToolName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  return name.length > MAX_PERMISSION_DENIED_TOOL_NAME_LENGTH
    ? `${name.slice(0, MAX_PERMISSION_DENIED_TOOL_NAME_LENGTH - 1)}…`
    : name;
}

function permissionDenialSummary(terminal) {
  const denials = Array.isArray(terminal && terminal.permission_denials)
    ? terminal.permission_denials : [];
  if (!denials.length) return null;
  const tools = [];
  const seen = new Set();
  for (const denial of denials) {
    const name = compactPermissionDeniedToolName(denial && (denial.tool_name || denial.toolName));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (tools.length < MAX_PERMISSION_DENIED_TOOL_NAMES) tools.push(name);
  }
  return { count: denials.length, tools };
}

function permissionDenialError(terminal) {
  const summary = permissionDenialSummary(terminal);
  if (!summary) return null;
  const suffix = summary.tools.length ? `：${summary.tools.join('、')}` : '';
  return `工具权限被拒绝（${summary.count} 次）${suffix}`;
}

function sanitizeResultPermissionDenials(message) {
  const summary = permissionDenialSummary(message);
  if (!summary || !message || message.type !== 'result') return message;
  // 保持数组长度等于拒绝次数；每项只保留工具名，不保留 tool_use_id/tool_input。
  return {
    ...message,
    permission_denials: message.permission_denials.map((denial) => ({
      tool_name: compactPermissionDeniedToolName(denial && (denial.tool_name || denial.toolName))
        || '未知工具',
    })),
  };
}

// SDK 流可以正常结束，但最终 result 本身仍可能是 error_during_execution。
// 若只看迭代器/进程退出状态，定时任务会把这种失败错记成成功。
function oneShotTerminalError(terminal) {
  if (!terminal || terminal.type !== 'result') return 'Claude 未返回最终结果';
  if (/^aborted_/.test(String(terminal.terminal_reason || ''))) return 'Claude 执行已中止';
  const subtype = String(terminal.subtype || '');
  if (terminal.is_error !== true && (!subtype || subtype === 'success')) return null;
  if (Array.isArray(terminal.errors) && terminal.errors.length) {
    return terminal.errors.map((item) => String(item || '')).filter(Boolean).join('\n') || 'Claude 执行失败';
  }
  return String(terminal.result || terminal.error || permissionDenialError(terminal) || subtype || 'Claude 执行失败');
}

function runOneShot({ prompt, files, onEvent, userMessageId, onUsage, onRuntimePrepared, taskStartedAt, taskRun, ...rest }) {
  const taskClock = new TaskClock({ startedAt: taskStartedAt, taskRun });
  const mcpPermissions = new McpPermissionOverrides(rest.mcpPermissionOverrides);
  const attachments = snapshotAttachments(files);
  const observeUsage = createUsageObserver(onUsage);
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  const abortController = new AbortController();
  let child = null;
  let retryGuard;
  const emit = (evt) => { try { onEvent(stripAttachmentImageData(taskClock.stamp(evt))); } catch (e) { console.error('[sdk] emit 失败: %s type=%s', e.message, evt && evt.type); } };

  const handle = {
    get pid() { return child ? child.pid : null; },
    get taskStartedAt() { return taskClock.startedAt; },
    kill() { observeUsage.stop(); if (retryGuard) retryGuard.cancel(); try { abortController.abort(); } catch (_) {} return closedPromise; },
    whenClosed() { return closedPromise; },
  };

  (async () => {
    let exitCode = 0;
    let terminalError = null;
    let terminal = null;
    let runtimeMapper;
    let diagnosticLog;
    try {
      const sdk = await loadSdk();
      const onSpawn = (c) => { child = c; };
      const built = buildMcpSessionOptions({ ...rest, mcpPermissionOverrides: () => mcpPermissions.snapshot(), abortController, onSpawn }, sdk);
      if (built.options.debug) { diagnosticLog = createDiagnosticLog({ onSummary: rest.onDiagnosticSummary }); built.options.debugFile = diagnosticLog.file; }
      const baseMcpServers = built.baseMcpServers;
      const options = await prepareRuntimeOptions(built.options, onSpawn, onRuntimePrepared);
      const mapMcpServers = runtimeMcpMappers.get(options) || (servers => servers);
      runtimeMapper = mapMcpServers;
      const inputId = userMessageId || randomUUID();
      let resolveQuery;
      const queryReady = new Promise((resolve) => { resolveQuery = resolve; });
      const prepareMcp = rest.mcpServers && !(Array.isArray(rest.tools) && rest.tools.length === 0);
      const queryPrompt = (async function* oneShotInput() {
            if (Object.keys(mcpPermissions.snapshot()).length) {
              const activeQuery = await queryReady;
              await activeQuery.initializationResult();
              await mcpPermissions.apply(activeQuery);
            }
            if (prepareMcp) {
              const activeQuery = await queryReady;
              const mcpControlQueue = new McpControlQueue();
              const control = (method, ...args) => {
                const operation = async () => {
                  await activeQuery.initializationResult();
                  if (abortController.signal.aborted) throw new Error('MCP_PREPARE_CANCELED');
                  if (typeof activeQuery[method] !== 'function') throw new Error('MCP_CONTROL_UNAVAILABLE');
                  if (method === 'setMcpServers' && mapMcpServers.applyServers) return mapMcpServers.applyServers(
                    mapped => { if (abortController.signal.aborted) throw new Error('MCP_PREPARE_CANCELED'); return activeQuery.setMcpServers(mapped); }, args[0]);
                  if (method === 'setMcpServers') args = [await mapMcpServers(args[0])];
                  if (abortController.signal.aborted) throw new Error('MCP_PREPARE_CANCELED');
                  return activeQuery[method](...args);
                };
                return method === 'mcpServerStatus' ? mcpControlQueue.read(operation) : mcpControlQueue.run(operation);
              };
              const readiness = new LiveMcpReadiness({
                whenIdle: () => mcpControlQueue.whenIdle(),
                setMcpServers: (servers) => control('setMcpServers', { ...servers, ...baseMcpServers }),
                mcpServerStatus: () => control('mcpServerStatus'),
                reconnectMcpServer: (name) => control('reconnectMcpServer', name),
                toggleMcpServer: (name, enabled) => control('toggleMcpServer', name, enabled),
              }, { signal: abortController.signal, initialServers: rest.mcpServers,
                protectedNames: Object.keys(baseMcpServers) });
              emit({ type: 'system', subtype: 'relay_mcp_status', phase: 'preparing', items: [] });
              const status = await readiness.prepare({ servers: rest.mcpServers });
              if (abortController.signal.aborted) return;
              emit({ type: 'system', subtype: 'relay_mcp_status', phase: 'settled', ...status });
            }
            if (abortController.signal.aborted) return;
            const content = await prepareAttachmentContent(prompt, attachments, { environment: options.env && options.env.RELAY_AGENT_ENVIRONMENT });
            if (abortController.signal.aborted) return;
            yield {
              type: 'user',
              message: { role: 'user', content },
              parent_tool_use_id: null,
              session_id: '',
              uuid: inputId,
            };
          })();
      const query = sdk.query({ prompt: queryPrompt, options });
      observeUsage.attach(query);
      resolveQuery(query);
      retryGuard = new SdkRetryGuard({ interrupt: () => interruptFailedConnection(query, retryGuard.capabilities), signal: abortController.signal,
        enabled: options.env.CLAUDE_CODE_RETRY_WATCHDOG === '1' });
      const guardedMessages = (async function* () {
        for await (const event of query) {
          observeUsage(event);
          yield await retryGuard.observe(TaskClock.normalizeEvent(event));
        }
      })();
      try {
        terminal = await consumeOneShotMessages(guardedMessages, emit, { userMessageId: inputId });
        terminalError = oneShotTerminalError(terminal);
        if (terminalError) exitCode = -1;
      } catch (error) {
        if (error.code === RETRY_CONTROL_FAILURE) {
          terminalError = error.message;
          await closeFailedRetryQuery(query);
        }
        throw error;
      } finally {
        // 后台 Bash 会让 query 继续存活；最终 result 已发出后主动清理它，finally 再补 job-done。
        try { if (query && typeof query.close === 'function') query.close(); } catch (_) {}
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        console.error('[sdk] 一次性任务出错: %s', e && e.message);
        emit({ type: 'stderr', text: String((e && e.message) || e) });
        exitCode = -1;
      }
    } finally {
      observeUsage.close();
      diagnosticLog?.close();
      if (runtimeMapper && runtimeMapper.close) await runtimeMapper.close();
      // 显式收尾：result 事件可能因异常退出而缺失，前端只认 job-done
      emit({
        type: 'job-done',
        exitCode: abortController.signal.aborted ? -1 : exitCode,
        ...(terminalError ? { error: terminalError } : {}),
        ...(terminal ? { finalResult: sanitizeResultPermissionDenials(terminal) } : {}),
        ...(abortController.signal.aborted ? { aborted: true } : {}),
      });
      resolveClosed({ exitCode: abortController.signal.aborted ? -1 : exitCode });
    }
  })();

  return { handle };
}

// ── 常驻会话 ──
// 对应原来的 spawnLiveSession：一个进程服务多轮，避免每轮重连 MCP。
// SDK 的流式输入要一个 AsyncIterable，这里用一个「推送队列」把它转成命令式的 push(text)。
function createLiveSession({ onMessage, onExit, onUsage, onInitialized, onRuntimePrepared, ...rest }) {
  const mcpPermissions = new McpPermissionOverrides(rest.mcpPermissionOverrides);
  const observeUsage = createUsageObserver(onUsage);
  const abortController = new AbortController();
  let child = null;
  let queryInstance = null;
  const retryGuard = new SdkRetryGuard({
    interrupt: () => {
      queue.length = 0;
      inputGeneration++;
      return interruptFailedConnection(queryInstance, retryGuard.capabilities);
    }, signal: abortController.signal,
  });
  let executionError = null;
  let inputEnvironment = 'native';
  let baseMcpServers = {};
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveQuery;
  let rejectQuery;
  const queryReady = new Promise((resolve, reject) => {
    resolveQuery = resolve;
    rejectQuery = reject;
  });
  // 控制接口通常不会被调用；预先吞掉未观察的拒绝，避免 SDK 初始化失败时产生
  // unhandledRejection。真正调用控制接口时仍会收到同一个错误。
  queryReady.catch(() => {});
  let inputGeneration = 0;
  const queue = [];              // 已入队待消费的用户消息
  let waiter = null;             // 消费者在等下一条时挂在这里

  async function* inputStream() {
    while (true) {
      if (closed) return;
      if (queue.length) {
        await ready();
        // A manual stop may clear the local queue while initialization waits.
        const queued = queue.shift();
        if (!queued) continue;
        const { files, ...message } = queued;
        const generation = inputGeneration;
        try {
          message.message.content = await prepareAttachmentContent(message.message.content[0].text, files, { environment: inputEnvironment });
        } catch (error) {
          if (closed) return;
          if (generation !== inputGeneration || retryGuard.pendingError) continue;
          throw error;
        }
        if (closed) return;
        if (generation !== inputGeneration || retryGuard.pendingError) continue;
        yield message; continue;
      }
      await new Promise((resolve) => { waiter = resolve; });
    }
  }
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
  const enqueueInput = (text, metadata = {}) => {
    if (closed || retryGuard.pendingError) return false;
    const { files, ...messageMetadata } = metadata;
    queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null, session_id: '', ...messageMetadata, files: snapshotAttachments(files) });
    wake(); return true;
  };

  let initialization = null;
  const ready = async () => {
    if (closed) throw new Error('Claude 会话已关闭');
    if (!initialization) initialization = queryReady.then(async query => {
      if (closed || !query) throw new Error('Claude 会话已关闭');
      const result = await query.initializationResult();
      await mcpPermissions.apply(query, { names: rest.sessionId ? Object.keys(rest.mcpServers || {}) : [] });
      if (!closed && typeof onInitialized === 'function') onInitialized(result);
      return query;
    });
    const query = await initialization;
    if (closed || abortController.signal.aborted) throw new Error('Claude 会话已关闭');
    return query;
  };
  // Startup has its own deadline; slow transcript/tool loading must not exhaust
  // the short mode-command or MCP-control deadlines before they even start.
  const whenReady = ({ signal, timeoutMs = 60000 } = {}) => new Promise((resolve, reject) => {
    let timer;
    const signals = [signal, abortController.signal].filter(Boolean);
    const finish = (callback, value) => {
      clearTimeout(timer);
      for (const entry of signals) entry.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, Object.assign(new Error('会话准备已取消'), { code: 'SESSION_START_CANCELED' }));
    if (signals.some(entry => entry.aborted)) { onAbort(); return; }
    for (const entry of signals) entry.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, Object.assign(new Error('会话启动超时，请重新发送继续当前对话'),
      { code: 'SESSION_START_TIMEOUT' })), Math.max(1, Math.min(Number(timeoutMs) || 60000, 120000)));
    ready().then(value => finish(resolve, value), error => finish(reject, error));
  });
  const control = async (method, ...args) => {
    const query = await ready();
    if (typeof query[method] !== 'function') throw new Error(`当前 Claude SDK 不支持 ${method}`);
    return query[method](...args);
  };

  let mapLiveMcpServers = servers => servers;
  const mcpControlQueue = new McpControlQueue();
  const mcpControl = (method, ...args) => {
    const operation = async () => {
      const result = await control(method, ...args);
      if (method === 'reconnectMcpServer' || method === 'toggleMcpServer') await mcpPermissions.apply(await ready(), { force: true });
      return result;
    };
    return method === 'mcpServerStatus' ? mcpControlQueue.read(operation) : mcpControlQueue.run(operation);
  };
  const applyMcpServers = (servers) => mcpControlQueue.run(async () => {
    // Factories are created after loadSdk; wait before reading their base set.
    await queryReady;
    const snapshot = { ...(servers || {}), ...baseMcpServers };
    const query = await ready();
    await mcpPermissions.apply(query);
    const result = mapLiveMcpServers.applyServers
      ? await mapLiveMcpServers.applyServers(mapped => control('setMcpServers', mapped), snapshot)
      : await control('setMcpServers', await mapLiveMcpServers(snapshot));
    await mcpPermissions.apply(query, { names: Object.keys(snapshot), force: true });
    return result;
  });
  const mcpReadiness = new LiveMcpReadiness({
    whenIdle: () => mcpControlQueue.whenIdle(),
    setMcpServers: applyMcpServers,
    mcpServerStatus: () => mcpControl('mcpServerStatus'),
    reconnectMcpServer: (name) => mcpControl('reconnectMcpServer', name),
    toggleMcpServer: (name, enabled) => mcpControl('toggleMcpServer', name, enabled),
  }, { signal: abortController.signal, initialServers: rest.mcpServers });

  const execution = new LiveExecutionModes({
    control, ready, enqueue: enqueueInput,
    stop: (error) => { executionError = error && error.message || '模式准备失败'; session.kill(); },
    permissionMode: rest.permissionMode || 'default', executionMode: rest.executionMode, resumed: !!rest.sessionId,
  });

  const session = {
    get pid() { return child ? child.pid : null; },
    // 投递一轮用户输入。SDK 侧会把它作为 user 消息喂给常驻进程。
    push(text, metadata = {}) {
      if (!execution.beforePush(text, metadata)) return false;
      return enqueueInput(text, {
        ...(metadata && metadata.uuid ? { uuid: metadata.uuid } : {}),
        ...(metadata && metadata.files ? { files: metadata.files } : {}),
        ...(['now', 'next', 'later'].includes(metadata && metadata.priority) ? { priority: metadata.priority } : {}),
      });
    },
    // 回收时撤回本地未发送内容，并通过 AbortController 结束 Query。只停当前轮用 interrupt。
    kill() {
      if (!closed) {
        observeUsage.stop();
        retryGuard.cancel();
        closed = true;
        execution.close();
        queue.length = 0;
        wake();
        try { abortController.abort(); } catch (_) {}
      }
      // 文件回退超时等安全路径需要等到 Query 真正结束后才能释放工作区锁。
      return closedPromise;
    },
    whenClosed() { return closedPromise; },
    whenReady,
    // 常驻会话控制：中止当前轮但保留 Query/MCP，及运行时能力、模型与上下文控制。
    interrupt() {
      retryGuard.cancel();
      queue.length = 0;
      inputGeneration++;
      // Cancel native queued/folding inputs atomically with the running turn.
      // Always send the option: init capability events can arrive after ready().
      // Older CLIs may ignore it; the host still checks still_queued and recycles.
      return control('interrupt', { cancelQueued: true });
    },
    setPermissionMode(mode) { return execution.setPermissionMode(mode); },
    prepareExecutionMode(mode, options) { return execution.prepare(mode, options); },
    clearContext() { return execution.clearContext(); },
    get executionMode() { return { ...execution.mode }; },
    adoptGoal(condition) {
      if (typeof condition !== 'string' || !condition.trim() || condition.length > 500) return;
      execution.mode = { kind: 'goal' }; execution.goalMayExist = true; execution.knownGoal = true; execution.goalCondition = condition;
    },
    getContextUsage(options = { detail: 'summary' }) { return control('getContextUsage', options); },
    supportedModels() { return control('supportedModels'); },
    supportedCommands() { return control('supportedCommands'); },
    readFile(file, options) { return control('readFile', file, options); },
    initializationResult() { return control('initializationResult'); },
    supportedAgents() { return control('supportedAgents'); },
    reloadPlugins() { return mcpControlQueue.run(async () => {
      const result = await control('reloadPlugins');
      mcpReadiness.invalidate(rest.mcpServers || {});
      await mcpPermissions.apply(await ready(), { force: true });
      return result;
    }); },
    stopTask(taskId) { return control('stopTask', taskId); },
    backgroundTasks(toolUseId) { return control('backgroundTasks', toolUseId); },
    setModel(model) { return control('setModel', model); },
    applyFlagSettings(settings) { return control('applyFlagSettings', validateFlagSettings(settings)); },
    reloadSkills() { return control('reloadSkills'); },
    rewindFiles(userMessageId, options) { return control('rewindFiles', userMessageId, options || {}); },
    // MCP 控制通道：只在流式 Query 中可用。Relay 主进程通过这些方法做状态查询和
    // 热重连，不再为了普通连接故障丢弃整个 Claude session。
    mcpServerStatus() { return mcpControl('mcpServerStatus'); },
    reconnectMcpServer(name) { return mcpControl('reconnectMcpServer', name); },
    toggleMcpServer(name, enabled) { return mcpControl('toggleMcpServer', name, !!enabled); },
    setMcpPermissionModeOverride(name, mode) {
      mcpPermissions.set(name, mode);
      return mcpControlQueue.run(async () => mcpPermissions.apply(await ready()));
    },
    syncMcpPermissionOverrides(overrides) {
      mcpPermissions.replace(overrides);
      return mcpControlQueue.run(async () => mcpPermissions.apply(await ready()));
    },
    prepareMcp(options) { return mcpReadiness.prepare(options); },
    // 保留会话启动时由 Relay 注入的进程内 MCP（例如 relay-cron）。SDK 的
    // setMcpServers 是“替换动态集合”语义，直接传用户配置会误把这些内置服务移除。
    setMcpServers(servers) {
      mcpReadiness.invalidate(servers);
      return applyMcpServers(servers);
    },
  };

  (async () => {
    let exitCode = 0;
    let error;
    let diagnosticLog;
    try {
      const sdk = await loadSdk();
      const onSpawn = (c) => { child = c; };
      const built = buildMcpSessionOptions({ ...rest, mcpPermissionOverrides: () => mcpPermissions.snapshot(), executionModeState: () => execution.mode,
        abortController, onSpawn }, sdk);
      if (built.options.debug) { diagnosticLog = createDiagnosticLog({ onSummary: rest.onDiagnosticSummary }); built.options.debugFile = diagnosticLog.file; }
      const options = await prepareRuntimeOptions(built.options, onSpawn, info => {
        if (!closed && !abortController.signal.aborted && typeof onRuntimePrepared === 'function') onRuntimePrepared(info);
      });
      inputEnvironment = options.env && options.env.RELAY_AGENT_ENVIRONMENT || 'native';
      retryGuard.enabled = options.env.CLAUDE_CODE_RETRY_WATCHDOG === '1';
      mapLiveMcpServers = runtimeMcpMappers.get(options) || (servers => servers);
      // Replay acknowledgements expose the UUID of consumed/absorbed input.
      // Queue lifecycle remains the authoritative consumption boundary.
      options.extraArgs = { ...(options.extraArgs || {}), 'replay-user-messages': null };
      baseMcpServers = built.baseMcpServers;
      mcpReadiness.protectedNames = new Set(Object.keys(baseMcpServers));
      // Query options already installed these servers. Preserve the first sync
      // when a factory also added external servers that the registry must retire.
      if (!Object.entries(built.options.mcpServers || {}).some(([name, config]) => config && config.type !== 'sdk'
        && rest.mcpServers?.[name] !== config)) mcpReadiness.adoptInitialServers(rest.mcpServers || {});
      queryInstance = sdk.query({ prompt: inputStream(), options });
      observeUsage.attach(queryInstance);
      resolveQuery(queryInstance);
      // Observe initialize even when no caller asks for a control method.
      ready().catch(() => {});
      for await (const raw of queryInstance) {
        observeUsage(raw);
        const msg = execution.observe(await retryGuard.observe(TaskClock.normalizeEvent(raw)));
        if (!msg) continue;
        // 常驻会话与 one-shot 使用同一条拒绝清单脱敏边界，避免 tool_input/tool_use_id
        // 在 main 进程写入原始流事件日志后才被任务归一化层发现。
        try { onMessage(stripAttachmentImageData(annotateError(sanitizeNativeEvent(sanitizeResultPermissionDenials(msg))))); }
        catch (e) { console.error('[sdk] onMessage 失败: %s type=%s', e.message, msg && msg.type); }
      }
    } catch (e) {
      if (!queryInstance) rejectQuery(e);
      if (!abortController.signal.aborted) {
        error = String((e && e.message) || e);
        console.error('[sdk] 常驻会话出错: %s', error);
        exitCode = -1;
        if (e.code === RETRY_CONTROL_FAILURE) {
          closed = true;
          queue.length = 0;
          inputGeneration++;
          wake();
          try { abortController.abort(); } catch (_) {}
          await closeFailedRetryQuery(queryInstance);
        }
      }
    } finally {
      observeUsage.close();
      diagnosticLog?.close();
      closed = true;
      execution.close();
      if (mapLiveMcpServers.close) await mapLiveMcpServers.close();
      if (executionError) { exitCode = -1; error = executionError; }
      try { onExit(exitCode, error); } catch (_) {}
      finally { resolveClosed({ exitCode, error: error || null }); }
    }
  })();

  return session;
}

// ── 一次性取纯文本 ──
// 给「只要一段文字结果」的轻量调用用（会话标题、技能中文元数据、技能 review）。
// 这些原来是 `claude -p <prompt>` 读 stdout 纯文本；SDK 只吐结构化消息，
// 所以这里把 assistant 的 text block 拼起来，拿不到就退回 result.result。
// 不挂 MCP、不授权额外目录 —— 它们本就不该触发工具或 Agent。
function runText({
  prompt, cwd, model, timeoutMs = 30000, permissionMode = 'default', tools = [],
  additionalDirectories, canUseTool, runtimeEnv, onUsage, runtimePolicy,
}) {
  const observeUsage = createUsageObserver(onUsage);
  return new Promise((resolve) => {
    const abortController = new AbortController();
    let text = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      observeUsage.stop();
      try { abortController.abort(); } catch (_) {}
      finish(text.trim());
    }, timeoutMs);
    if (timer.unref) timer.unref();

    (async () => {
      try {
        const { query } = await loadSdk();
        const options = {
          cwd,
          settingSources: runtimePolicy?.settingSources || ['user'],
          persistSession: false,
          // Title generation and staged skill review never require inherited MCP.
          strictMcpConfig: true, mcpServers: {},
          permissionMode,
          abortController,
          disallowedTools: ['AskUserQuestion'],
          pathToClaudeCodeExecutable: bundledExecutable(),
          env: buildRelayRuntimeEnv(runtimeEnv),
          settings: buildRelayRuntimeSettings(runtimePolicy, model, runtimeEnv),
        };
        if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
        if (typeof canUseTool === 'function') options.canUseTool = canUseTool;
        // tools: [] 表示「只做文本生成，禁止调用任何工具」（原来的 `--tools ''`）
        if (Array.isArray(tools)) options.tools = tools;
        if (Array.isArray(additionalDirectories) && additionalDirectories.length) {
          options.additionalDirectories = additionalDirectories;
        }
        if (typeof model === 'string' && model.trim()) options.model = model.trim();
        const preparedOptions = await prepareRuntimeOptions(options);
        const textQuery = query({ prompt, options: preparedOptions });
        observeUsage.attach(textQuery);
        for await (const msg of textQuery) {
          observeUsage(msg);
          if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
            for (const b of msg.message.content) if (b && b.type === 'text') text += b.text;
          } else if (msg.type === 'result' && !text && typeof msg.result === 'string') {
            text = msg.result;
          }
        }
      } catch (e) {
        if (!abortController.signal.aborted) console.error('[sdk] runText 出错: %s', e && e.message);
      } finally {
        observeUsage.close();
        clearTimeout(timer);
        finish(text.trim());
      }
    })();
  });
}

// 内置运行时的版本。取自 SDK package.json 的 claudeCodeVersion 字段
// SDK 与其内置 CLI 同包发布，避免把全局安装版本误当成 Relay 实际运行版本。
function bundledClaudeVersion() {
  try {
    return require('@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion || '';
  } catch (_) {
    try {
      const p = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).claudeCodeVersion || '';
    } catch (_) { return ''; }
  }
}

async function runStructured({ prompt, cwd, model, runtimeEnv, schema, validate, timeoutMs = 30000, onUsage, runtimePolicy }) {
  if (!schema || typeof validate !== 'function') throw new Error('结构化调用需要 schema 和本地校验器');
  const abortController = new AbortController();
  const observe = createUsageObserver(onUsage);
  const timer = setTimeout(() => { observe.stop(); abortController.abort(); }, timeoutMs);
  let query;
  try {
    const sdk = await loadSdk();
    const built = buildOptions({ cwd, model, runtimeEnv, runtimePolicy, includeRelayInstructions: false,
      abortController, tools: [], disallowAskUserQuestion: true,
      canUseTool: async (name, input) => name === 'StructuredOutput'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: '结构化辅助调用不执行其他工具。' },
      outputFormat: { type: 'json_schema', schema } }, sdk);
    // tools: [] disables built-ins only. Keep user/plugin MCP out of metadata
    // generation without changing discovery for normal conversation Queries.
    built.strictMcpConfig = true;
    built.mcpServers = {};
    built.hooks = { ...built.hooks, PreToolUse: [{ hooks: [async input => input.tool_name === 'StructuredOutput' ? {} : {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: '结构化辅助调用不执行其他工具。' },
    }] }] };
    const options = await prepareRuntimeOptions(built);
    options.persistSession = false;
    query = sdk.query({ prompt, options });
    observe.attach(query);
    return await collectStructuredOutput(query, validate, observe);
  } finally {
    observe.close();
    clearTimeout(timer);
    if (query && typeof query.close === 'function') query.close();
  }
}

module.exports = {
  loadSdk, runOneShot, runText, runStructured, createLiveSession, bundledClaudeVersion, bundledExecutable, configureRuntimeEnvironment,
  consumeOneShotMessages, oneShotTerminalError, sanitizeResultPermissionDenials,
  buildRelayRuntimeEnv, buildRelayModelSettings, RELAY_PROVIDER_ENV_KEYS,
  _buildOptions: buildOptions,
};
