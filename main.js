// main.js — Electron 主进程
// 职责:
//   1. 创建窗口
//   2. 通过 claude-agent-sdk 驱动 Claude Code(SDK 自带运行时,不依赖用户安装)
//   3. 把 SDK 吐出的事件流经 IPC 转发给 renderer

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, Notification, globalShortcut, clipboard, nativeTheme, powerMonitor, safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const os = require('os');
const fs = require('fs');
const { createAppSettingsCache } = require('./app-settings-cache');
const appSettingsCache = createAppSettingsCache();
const crypto = require('crypto');
const scheduler = require('./scheduler');
const { createSdkRuntimeStorage } = require('./sdk-runtime-storage');
let sdkRuntimeStorage;
function getSdkRuntimeStorage() {
  return sdkRuntimeStorage ||= createSdkRuntimeStorage({ dataDir: app.getPath('userData') });
}
const { createConversationWorkspaces, workspaceKey, directoryValue, conversationContext, UUID: WORKSPACE_UUID } = require('./conversation-workspaces');
const { createProjectStore } = require('./project-store');
const { normalizeExecutionMode, prepareExecutionRequest } = require('./execution-modes');
const { protectGoalRecovery, previousConversationGoal, condition: goalConditionValue } = require('./conversation-goals');
const { registerWorkspaceTools } = require('./workspace-tools');
const { createGeneralPreferences, registerGeneralPreferencesIpc, normalizePreferences, DEFAULTS: GENERAL_PREFERENCE_DEFAULTS } = require('./general-preferences');
const { createAgentEnvironment, toWslPath } = require('./agent-environment');
const { buildRuntimePolicy, createRuntimeDiagnostics } = require('./sdk-runtime-policy');
const { loadNativeAgent } = require('./native-agent-definition');
const { requiresFreshContract, contractFingerprints, migrateLegacyRuntimeContract, RUNTIME_FINGERPRINT_VERSION } = require('./sdk-runtime-contract');
const { SUPPORTED_DIALOG_KINDS, createUserDialogHandler } = require('./sdk-user-dialog');
const { safeFindings, nativeWorkingDirectory } = require('./sdk-native-events');
const { createHistoryManagement } = require('./sdk-history-management');
const { createPluginStore } = require('./sdk-plugin-store');
const { createToolProposalHook } = require('./sdk-tool-proposals');
let sdkPluginStore;
function getSdkPluginStore() { return sdkPluginStore ||= createPluginStore({ file: path.join(app.getPath('userData'), 'sdk-plugins.json') }); }
const { SdkSessionObserver, stopOwnedTask, backgroundOwnedTask, observeOwnedBackgroundTasks, RouteTimingHistory } = require('./sdk-session-observer');
const { resourceEntries, mergeResources, ownedResource, resourceTarget } = require('./sdk-task-resources');
const { createMcpPermissions } = require('./sdk-mcp-permissions');
const { observeProvenance, applyProvenance, protectSdkMetadata, resolveStoredScope, pendingForkOptions } = require('./sdk-session-provenance');
const { createSessionForkService } = require('./sdk-session-forks');
const { createSessionHistoryService, executeSessionOperation } = require('./sdk-session-history');
const { registerNativeAttachmentDialog } = require('./native-attachment-dialog');
const { createMiniWindowHost, isQuickChatEnabled, normalizeQuickChatPatch } = require('./mini-window-host');
const { createMiniChatController } = require('./mini-chat-controller');
const { createTaskbarCompletionBadge, createNativeTaskbarOverlay } = require('./taskbar-completion-badge');
const updater = require('./updater');
const claudeSdk = require('./claude-sdk');
const { LiveTurnRouter } = require('./live-turn-router');
const { createPrewarmState, canReuseFreshPrewarm } = require('./live-prewarm-reuse');
const { TaskClock } = require('./task-clock');
const { TaskContinuityHost } = require('./task-continuity-host');
const taskContinuityHost = new TaskContinuityHost({ loadConversation });
const { normalizeSupplement, sameSupplement, submitLiveSupplement, observeSupplement, flushSupplementUpdates, mergeSupplementHistory } = require('./live-supplement-input');
const recoverLegacyOutput = require('./legacy-output-recovery').createLegacyOutputRecovery();
const { LiveTurnControls } = require('./live-turn-control');
const { ProviderStore } = require('./provider-store');
const {
  providerApiUrl,
  imageRequestRoute,
  testProviderConnection,
  createProviderDraftRuntime,
  discoverProviderModels,
} = require('./provider-connectivity');
const { TaskLedger } = require('./task-ledger');
const { TaskEventJournal, isValidEpoch } = require('./task-event-journal');
const { TaskProgressClient } = require('./task-progress-client');
const { TaskOrchestrator } = require('./task-orchestrator');
const {
  InteractionBroker,
  isAppPermissionMode,
  normalizeAppPermissionMode,
  resolveUnattendedPermissionMode,
} = require('./interaction-broker');
const { createConversationPermissions, isConversationPermissionMode } = require('./conversation-permissions');
const { CheckpointManager } = require('./checkpoint-manager');
const { SkillDraftClient } = require('./skill-draft-client');
const { prepareSkillGenerationWorkspace } = require('./skill-generation-workspace');
const { SkillMaintenanceHost } = require('./skill-maintenance-host');
const { normalizeMaintenancePolicy, evaluateMaintenanceRun } = require('./skill-maintenance-policy');
const { normalizeMemoryMeta, memoryEligibility } = require('./memory-schema');
const {
  RUN_STATES,
  RUN_EVENT_SCHEMA_VERSION,
  isTerminalState,
  selectTaskSnapshotRuns,
} = require('./task-protocol');
const { compactText, normalizeClaudeTaskEvent } = require('./task-event-normalizer');
const {
  LiveAsyncAgentTracker,
  LiveBackgroundTaskTracker,
  liveResultDisposition,
} = require('./live-async-agent-tracker');
const { dispatchLiveInput, cancelPendingLiveInput } = require('./live-mcp-dispatch');

const IS_DEV = process.argv.includes('--dev');
// 开机自启唤起:--autostart 时不弹主窗,静默建托盘 + 起调度器在后台跑定时任务。
const IS_AUTOSTART = process.argv.includes('--autostart');
const handlePowerResume = () => {
  try { scheduler.onResume(); }
  catch (e) { console.warn('[scheduler] 系统恢复后重排失败: %s', e.message); }
};
// Relay 的执行器、调度器和任务账本都属于单主进程资源。第二次启动只唤醒已有实例，
// 绝不能同时恢复/写同一账本（否则会把首实例仍在运行的任务误标为 interrupted）。
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) app.quit();

// ── 主进程滚动日志:尽早初始化,之后所有 console.* 自动镜像到 userData/logs/main.log ──
//   打包后没有控制台,主进程报错以前无处可看,偶发问题(转圈/漏跑/spawn 失败)只能靠复现猜;
//   现在翻日志即可定位。注:app.getPath('userData') 在 ready 前即可用;
//   初始化失败时 logger 自动整体静默,绝不影响启动。
const logger = require('./logger');
logger.init(path.join(app.getPath('userData'), 'logs'), {
  banner: `Relay ${app.getVersion()} | electron ${process.versions.electron} | node ${process.versions.node}` +
          ` | ${process.platform} ${os.release()} | packaged=${app.isPackaged} | pid=${process.pid}` +
          (IS_AUTOSTART ? ' | autostart' : '') + (IS_DEV ? ' | dev' : ''),
});
// API / 模型配置只存在 Relay userData 内，不读取或改写其他 AI 应用的认证配置。
// 密钥由 Electron safeStorage（Windows 上为 DPAPI）加密。
const providerStore = new ProviderStore({
  userDataDir: app.getPath('userData'),
  safeStorage,
  logger: console,
});
const FIRST_RUN_SETUP_VERSION = 1;
// 用户级 Agent 子智能体目录 / 技能目录(Claude Code 原生约定)。
//   用户把任意 Agent 包导入到 ~/.claude/agents 即可,
//   调用时从用户主目录启动 Claude,Claude 自动加载这里的子智能体定义。
const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// ─────────────────────────────────────────
// Relay 长期记忆主库：保留旧目录，记录按全局/项目作用域访问。
// ─────────────────────────────────────────
//   复刻 Claude Code CLI 的原生记忆模式:纯文件 —— 一个 MEMORY.md 索引(每条一行)
//   + 每条事实一个 .md(带 name/description/type frontmatter)。但 CLI 的记忆注入是
//   交互式 harness 的特权,`claude -p`(headless)从不注入;故由 main 进程在拼 prompt 时
//   把索引塞进去(见下方 buildMemoryHint),并用 --add-dir 授权该目录,让模型自读自写。
//   数据位置保持兼容；受控工具负责读取、候选写入、版本校验和恢复。
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'relay-memory');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const { MemoryStore } = require('./memory-store');
const { createMemoryRuntime, MEMORY_CONSOLIDATION_PROMPT } = require('./memory-runtime');
const relayMemoryStore = new MemoryStore({ dir: MEMORY_DIR });
const memoryRequestContexts = new Map();
const MEMORY_USAGE_FILE = path.join(MEMORY_DIR, '.usage.json');
let _memoryUsageCache = null;
let _memoryUsageFlushTimer = null;

function readMemoryUsage() {
  if (_memoryUsageCache) return _memoryUsageCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_USAGE_FILE, 'utf8'));
    _memoryUsageCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { _memoryUsageCache = {}; }
  return _memoryUsageCache;
}

function flushMemoryUsage() {
  if (_memoryUsageFlushTimer) clearTimeout(_memoryUsageFlushTimer);
  _memoryUsageFlushTimer = null;
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const tmp = MEMORY_USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(readMemoryUsage(), null, 2), 'utf8');
    try { fs.renameSync(tmp, MEMORY_USAGE_FILE); }
    catch (e) {
      if (!fs.existsSync(MEMORY_USAGE_FILE)) throw e;
      fs.rmSync(MEMORY_USAGE_FILE, { force: true });
      fs.renameSync(tmp, MEMORY_USAGE_FILE);
    }
  } catch (e) { console.warn('[memory] 用量元数据写入失败: %s', e.message); }
}

function scheduleMemoryUsageFlush() {
  if (_memoryUsageFlushTimer) return;
  _memoryUsageFlushTimer = setTimeout(flushMemoryUsage, 800);
  if (_memoryUsageFlushTimer && typeof _memoryUsageFlushTimer.unref === 'function') _memoryUsageFlushTimer.unref();
}

function recordMemoryExposures(files) {
  const usage = readMemoryUsage();
  const nowIso = new Date().toISOString();
  let dirty = false;
  for (const file of new Set(Array.isArray(files) ? files : [])) {
    if (!file || String(file).toLowerCase() === 'memory.md') continue;
    const rec = usage[file] && typeof usage[file] === 'object' ? usage[file] : {};
    rec.exposureCount = Math.max(0, Number(rec.exposureCount) || 0) + 1;
    rec.lastExposedAt = nowIso;
    if (typeof rec.pinned !== 'boolean') rec.pinned = false;
    usage[file] = rec;
    dirty = true;
  }
  if (dirty) scheduleMemoryUsageFlush();
}

function memoryReadStats(file) {
  try {
    const state = loadSkillUsageState();
    const legacy = state?.memoryMap?.get(file) || {}, managed = readMemoryUsage()[file] || {};
    return { readCount: (Number(legacy.readCount) || 0) + (Number(managed.managedReadCount) || 0),
      lastReadAt: [legacy.lastReadAt, managed.managedLastReadAt].filter(Boolean).sort().pop() || null };
  } catch (_) { return null; }
}

function memoryIndexLine(entry) {
  const scope = entry.meta && entry.meta.scope !== 'global'
    ? ` [${entry.meta.scope}:${entry.meta.projectId || '-'}]` : '';
  return `- [${entry.title}](${entry.file})${entry.pinned ? ' [核心]' : ''}${scope}${entry.desc ? ' — ' + entry.desc : ''}`;
}

function memoryQueryTerms(value) {
  const text = String(value || '').toLowerCase().slice(-8000);
  const terms = new Set((text.match(/[a-z0-9_\-]{2,}|[\u3400-\u9fff]{2,}/g) || []).flatMap((token) => {
    if (!/[\u3400-\u9fff]/.test(token) || token.length <= 2) return [token];
    const grams = [];
    for (let i = 0; i < token.length - 1; i++) grams.push(token.slice(i, i + 2));
    return grams;
  }));
  return [...terms].slice(0, 160);
}

function memoryRelevanceScore(entry, terms) {
  const title = `${entry.title} ${entry.file}`.toLowerCase();
  const desc = String(entry.desc || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 6;
    if (desc.includes(term)) score += 3;
  }
  return score;
}

// ── 索引由主进程根据受治理的记忆库生成，模型通过 Relay 记忆工具访问正文。 ──
// 磁盘索引供用户查看；每轮返回的 entries/lines 按调用方的项目上下文过滤。
function rebuildMemoryIndex(context = {}) {
  let allEntries = [];
  const usage = readMemoryUsage();
  try {
    allEntries = relayMemoryStore.list().map(({ file, meta, mtime, revision }) => ({
      file, meta, mtime, revision,
      title: (meta.name || file.replace(/\.md$/i, '')).replace(/\r?\n/g, ' ').trim(),
      desc: meta.description.replace(/\r?\n/g, ' ').trim(),
      pinned: meta.core || !!(usage[file] && usage[file].pinned),
    }));
  } catch (error) { console.warn('[memory] 读取记忆库失败: %s', error.message); }
  allEntries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime || a.file.localeCompare(b.file));
  const activeIndexEntries = allEntries.filter((entry) => memoryEligibility(entry.meta, {
    projectId: entry.meta.projectId, now: context.now,
  }).eligible);
  const indexLines = activeIndexEntries.map(memoryIndexLine);
  const body = indexLines.length ? indexLines.join('\n') + '\n' : '';
  const entries = allEntries.filter((entry) => memoryEligibility(entry.meta, context).eligible);
  const lines = entries.map(memoryIndexLine);
  try { relayMemoryStore.writeIndex(body); }
  catch (error) { console.warn('[memory] 写入索引失败: %s', error.message); }
  return {
    count: lines.length, totalCount: allEntries.length,
    bytes: Buffer.byteLength(lines.join('\n'), 'utf8'),
    lines, entries, allEntries, indexLines,
  };
}


// 注入预算上限(#2):索引超过这个字节数就降级注入,避免每轮 prompt 无限膨胀。
//   8KB ≈ 几十条「name — description」级别的索引行,够个人助手用很久;超了说明该 consolidate。
const MEMORY_INDEX_BUDGET = 8 * 1024;
const MEMORY_INDEX_HEAD = 40;   // 降级时保留核心记忆 + 与当前任务最相关的 N 条左右

// 每轮只注入当前作用域中有预算的索引，正文通过受控工具按需读取。
// full 可提候选；read/plan 只读；off 不读取。维护任务只提建议，不直接覆盖或删除。
function buildMemoryHint(mode = 'full', query = '', context = {}) {
  if (mode === 'off') return '';
  const { entries } = rebuildMemoryIndex(context);
  const terms = memoryQueryTerms(query);
  const ranked = entries.map(entry => ({ entry, score: memoryRelevanceScore(entry, terms) }))
    .sort((a, b) => Number(b.entry.pinned) - Number(a.entry.pinned) || b.score - a.score || b.entry.mtime - a.entry.mtime);
  const selected = []; let used = 0;
  for (const { entry } of ranked) {
    const line = memoryIndexLine(entry), size = Buffer.byteLength(line + '\n', 'utf8');
    if (used + size > MEMORY_INDEX_BUDGET || selected.length >= MEMORY_INDEX_HEAD) continue;
    selected.push({ entry, line }); used += size;
  }
  recordMemoryExposures(selected.map(item => item.entry.file));
  const scope = context.projectId ? '当前项目与全局' : '全局';
  const rules = mode === 'read' ? '此任务只读记忆，不保存或改写。'
    : '稳定的用户事实、偏好进入记忆；复用流程进入技能，临时过程留在当前对话。发现新事实可调用 mcp__relay-memory__propose，正文使用 Markdown；宿主记录项目、来源和审核状态。已有条目先 read 并传 expectedRevision，新条目传 expectedRevision:null。模型推断与已有事实修订会成为待确认候选，批准前不影响已确认记忆；不要伪造用户确认、核心标记或项目。';
  return '\n\n---\n[长期记忆] Relay 管理' + scope + '记忆。\n'
    + selected.map(item => item.line).join('\n')
    + '\n使用 mcp__relay-memory__list 查询、mcp__relay-memory__read 读取正文。完整索引和版本由宿主管理，不通过文件或 Shell 直接读写记忆目录。\n'
    + rules + (mode === 'maintenance' ? '\n' + MEMORY_CONSOLIDATION_PROMPT : '');
}

// 让 Windows 任务栏把多个窗口归到我们 app 而不是 Electron(也修 dev 模式任务栏图标走 .exe 不走 electron.exe)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.relay.app');
}
// 应用图标(dev 和 prod 都用,统一显示 Relay Dual Gate 图标)。
//   打包后 __dirname 在 app.asar 内,且 build/ 不在 asar 里 —— 旧逻辑只查 __dirname/build/icon.ico
//   必然 false,导致托盘拿到空图标(系统托盘图标空白的根因)。
//   故打包态优先取 extraResources 解包出的真实文件 process.resourcesPath/icon.ico;dev 态用源码 build/。
function resolveNativeIcon(name) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, name), path.join(__dirname, 'build', name)]
    : [path.join(__dirname, 'build', name)];
  return candidates.find(candidate => { try { return fs.existsSync(candidate); } catch { return false; } }) || null;
}
const APP_ICON = resolveNativeIcon('icon.ico');
const APP_ICON_DARK = resolveNativeIcon('icon-dark.ico');
const nativeBrandTheme = require('./native-brand-theme').createNativeBrandTheme({
  nativeTheme, onChange: () => refreshNativeBrandIcons(),
});
function currentAppIcon() {
  return nativeBrandTheme.usesLightArtwork() && APP_ICON_DARK ? APP_ICON_DARK : APP_ICON;
}
function updateNativeBrandTheme() {
  // Reset manual themes immediately, then refresh the independent Windows
  // system preference in the background for System mode.
  refreshNativeBrandIcons();
  void nativeBrandTheme.refresh();
}
function refreshNativeBrandIcons() {
  const file = currentAppIcon();
  if (!file) return;
  try {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty() && tray && !tray.isDestroyed()) tray.setImage(image);
  } catch (error) { console.warn('[brand] 托盘图标更新失败: %s', error.message); }
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.setIcon(file); }
    catch (error) { console.warn('[brand] 窗口图标更新失败: %s', error.message); }
  }
}

// ── 系统托盘 ──
//   关闭主窗口默认「最小化到托盘」而非退出,后台正在跑的 claude 子进程继续执行;
//   真正退出走托盘菜单「退出 Relay」(或 app.quit / 向导完成等显式路径),由 isQuitting 区分。
let tray = null;
let mainWindow = null;       // 主窗口引用(托盘点击恢复它;wizard 窗口不进托盘)
let isQuitting = false;      // true=用户真要退出(放行 close 并杀子进程);false=close 转为隐藏到托盘
let trayBalloonShown = false; // 首次隐藏到托盘时气泡提示一次,别每次都弹

if (HAS_SINGLE_INSTANCE_LOCK) {
  app.on('second-instance', () => {
    const focusExisting = () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          showMainWindow();
          return;
        }
        const existing = BrowserWindow.getAllWindows()[0];
        if (existing && !existing.isDestroyed()) {
          if (existing.isMinimized()) existing.restore();
          existing.show();
          existing.focus();
          return;
        }
        showMainWindow();
      } catch (e) { console.warn('[app] 唤醒已有实例失败: %s', e.message); }
    };
    if (app.isReady()) focusExisting();
    else app.whenReady().then(focusExisting).catch(() => {});
  });
}

// ── 统一任务运行时 ──
// 账本保存权威状态；两个事件日志分别保存任务状态和 Claude 流式事件，避免 renderer
// 刷新后只恢复 spinner、却丢掉正在生成的正文。所有模块故障都必须可降级。
const TASK_EVENT_EPOCH = crypto.randomUUID();
let taskEventSeq = 0;
let streamEventSeq = 0;
let streamDeliverySeq = 0;
let taskJournalBuffer = [];
let taskJournalFlushTimer = null;
let streamJournalBuffer = [];
let streamJournalFlushTimer = null;
const taskProgressWriteAt = new Map();
const taskEventQueues = new Map();
// History recovery may run before the history helper declarations later in this file execute.
// Keep the lazy directory cell initialized before task-ledger recovery to avoid a TDZ failure.
let HISTORY_DIR = null;

let taskEventJournal = null;
let streamEventJournal = null;
let taskProgressStore = null;
let progressShutdownPending = false;
let progressShutdownComplete = false;
let checkpointManager = null;
let skillDraftService = null;
let skillDraftShutdownPending = false;
let skillDraftShutdownComplete = false;
const checkpointWorkspaceLocks = new Map();
const checkpointConversationLocks = new Map();
const checkpointUnlockWaiters = new Set();

function normalizedWorkspaceKey(value) {
  if (!value) return null;
  try {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (_) { return null; }
}

function checkpointWriteLocked(workingDir, conversationId) {
  const workspaceKey = normalizedWorkspaceKey(workingDir);
  return !!((workspaceKey && checkpointWorkspaceLocks.has(workspaceKey))
    || (conversationId && checkpointConversationLocks.has(String(conversationId))));
}

function acquireCheckpointScope(workingDir, conversationId) {
  const workspaceKey = normalizedWorkspaceKey(workingDir);
  const conversationKey = conversationId ? String(conversationId) : null;
  if (workspaceKey) checkpointWorkspaceLocks.set(workspaceKey, (checkpointWorkspaceLocks.get(workspaceKey) || 0) + 1);
  if (conversationKey) checkpointConversationLocks.set(conversationKey, (checkpointConversationLocks.get(conversationKey) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const release = (map, key) => {
      if (!key) return;
      const next = (map.get(key) || 0) - 1;
      if (next > 0) map.set(key, next);
      else map.delete(key);
    };
    release(checkpointWorkspaceLocks, workspaceKey);
    release(checkpointConversationLocks, conversationKey);
    for (const check of [...checkpointUnlockWaiters]) {
      try { check(); } catch (_) {}
    }
  };
}

function waitForCheckpointUnlock(workingDir, conversationId, { timeoutMs = 60000, signal = null } = {}) {
  if (!checkpointWriteLocked(workingDir, conversationId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      checkpointUnlockWaiters.delete(check);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const check = () => {
      if (!checkpointWriteLocked(workingDir, conversationId)) finish(true);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();
    checkpointUnlockWaiters.add(check);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function emitCheckpointUpdate(checkpoint) {
  if (!checkpoint) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('checkpoints:event', { type: 'checkpoint.updated', checkpoint });
    }
  } catch (_) {}
}

function emitCurrentCheckpoint(runId) {
  if (!checkpointManager) return null;
  const checkpoint = checkpointManager.publicRecord(checkpointManager.get(runId));
  emitCheckpointUpdate(checkpoint);
  return checkpoint;
}

function markCheckpointUnavailable(runId, reason) {
  if (!checkpointManager) return null;
  const checkpoint = checkpointManager.markUnavailable(runId, reason);
  emitCheckpointUpdate(checkpoint);
  return checkpoint;
}
if (HAS_SINGLE_INSTANCE_LOCK) {
  const runtimeRoot = path.join(app.getPath('userData'), 'task-ledger');
  const initialize = (name, factory) => {
    try { return factory(); }
    catch (e) {
      console.warn('[task-runtime] %s 初始化失败，仅该能力降级: %s', name, e.message);
      return null;
    }
  };
  taskEventJournal = initialize('任务事件日志', () => new TaskEventJournal({
    rootDir: path.join(runtimeRoot, 'events'), epoch: TASK_EVENT_EPOCH,
    maxEvents: 20000, maxBytes: 24 * 1024 * 1024,
  }));
  streamEventJournal = initialize('流式事件日志', () => new TaskEventJournal({
    rootDir: path.join(runtimeRoot, 'stream-events'), epoch: TASK_EVENT_EPOCH,
    maxEvents: 50000, maxBytes: 64 * 1024 * 1024,
  }));
  taskProgressStore = initialize('任务过程快照', () => new TaskProgressClient({
    rootDir: path.join(runtimeRoot, 'progress'),
  }));
  checkpointManager = initialize('文件检查点', () => new CheckpointManager({
    rootDir: path.join(app.getPath('userData'), 'checkpoints'),
  }));
  skillDraftService = initialize('Skill 草稿', () => new SkillDraftClient({
    skillsDir: SKILLS_DIR, draftsDir: path.join(app.getPath('userData'), 'skill-drafts'),
    stagingRoot: path.join(app.getPath('userData'), 'sdk-skill-proposals'),
  }));
  if (taskEventJournal) taskEventSeq = taskEventJournal.lastSeq;
  if (streamEventJournal) streamEventSeq = streamEventJournal.lastSeq;
}

function emitInteractionChange(event) {
  const interaction = event && event.interaction;
  if (interaction && interaction.runId && taskLedger) {
    try {
      const run = taskLedger.get(interaction.runId);
      if (run && !isTerminalState(run.state)) {
        if (event.type === 'interaction.pending') {
          taskLedger.update(run.runId, {
            state: RUN_STATES.WAITING_USER,
            phase: interaction.kind === 'question' || interaction.kind === 'elicitation' ? 'question' : 'permission',
            health: 'ok',
            waiting: {
              interactionId: interaction.id,
              kind: interaction.kind,
              title: interaction.kind === 'question'
                ? '需要你回答一个问题'
                : interaction.kind === 'elicitation' ? interaction.elicitation?.title || '工具需要你补充信息'
                  : (interaction.permission && interaction.permission.title) || '需要你确认一项操作',
            },
            progress: { label: interaction.kind === 'question' || interaction.kind === 'elicitation' ? '等待你回复' : '等待你确认' },
          });
        } else if (event.type === 'interaction.resolved') {
          if (event.resolution && event.resolution.interrupt === true) {
            // “拒绝并停止”是任务级动作，不是普通拒绝。先进入统一取消链，避免短暂恢复 running。
            void cancelTaskByRunId(run.runId).catch((error) => {
              console.warn('[interaction] 停止任务失败 runId=%s: %s', run.runId, error.message);
            });
          } else {
            const remaining = interactionBroker.list({ runId: run.runId });
            if (remaining.length) {
              const next = remaining[0];
              taskLedger.update(run.runId, {
                state: RUN_STATES.WAITING_USER,
                phase: next.kind === 'question' || next.kind === 'elicitation' ? 'question' : 'permission',
                waiting: {
                  interactionId: next.id,
                  kind: next.kind,
                  title: next.kind === 'question'
                    ? '需要你回答一个问题'
                    : next.kind === 'elicitation' ? next.elicitation?.title || '工具需要你补充信息'
                      : (next.permission && next.permission.title) || '需要你确认一项操作',
                },
                progress: { label: next.kind === 'question' || next.kind === 'elicitation' ? '等待你回复' : '等待你确认' },
              });
            } else {
              taskLedger.update(run.runId, {
                state: RUN_STATES.RUNNING,
                phase: 'running',
                waiting: null,
                progress: { label: '已收到你的回复，继续执行' },
              });
            }
          }
        }
      }
    } catch (e) {
      if (!e || (e.code !== 'RUN_TERMINAL' && e.code !== 'RUN_NOT_FOUND')) {
        console.warn('[interaction] 同步任务状态失败: %s', e.message);
      }
    }
  }
  try {
    const miniPanel = miniHost && miniHost.getPanelWindow();
    const target = miniPanel && !miniPanel.isDestroyed() && interaction && String(interaction.windowId) === String(miniPanel.id) ? miniPanel : mainWindow;
    if (target && !target.isDestroyed()) target.webContents.send('interactions:event', event);
  } catch (e) { console.warn('[interaction] 推送界面事件失败: %s', e.message); }
  try { refreshTrayMenu(); } catch (_) {}
}

const interactionBroker = new InteractionBroker({ onChange: emitInteractionChange, logger: console });

function redactTaskText(value) {
  return compactText(value, 240)
    .replace(/(authorization\s*[:=]?\s*bearer\s+)[^\s]+/ig, '$1[已隐藏]')
    .replace(/(authorization\s*[:=]?\s*basic\s+)[^\s]+/ig, '$1[已隐藏]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/ig, '$1[已隐藏]@')
    .replace(/((?:--(?:password|passwd|pass|secret|token|api[-_]?key|credential))\s*(?:=\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;&]+)/ig, '$1[已隐藏]')
    .replace(/([?&](?:access_token|api_key|token|key)=)[^&\s]+/ig, '$1[已隐藏]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/g, '[已隐藏凭据]');
}

function publicTaskRun(run) {
  if (!run) return null;
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    revision: run.revision,
    kind: run.kind,
    trigger: run.trigger,
    title: run.title,
    priority: run.priority,
    source: run.source || null,
    lineage: run.lineage || null,
    state: run.state,
    phase: run.phase,
    health: run.health,
    executorState: run.executorState,
    createdAt: run.createdAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastEventAt: run.lastEventAt,
    endedAt: run.endedAt,
    progress: run.progress || null,
    waiting: run.waiting || null,
    result: run.result || null,
    recovery: run.recovery || null,
    execution: run.execution ? {
      jobId: run.execution.jobId || null,
      appInstanceId: run.execution.appInstanceId || null,
      sessionId: run.execution.sessionId || null,
    } : null,
    metadata: run.metadata ? {
      model: run.metadata.model || null,
      effort: run.metadata.effort || null,
      workingDir: run.metadata.workingDir || null,
      turnIndex: Number.isSafeInteger(run.metadata.turnIndex) ? run.metadata.turnIndex : null,
      turnTs: run.metadata.turnTs || null,
    } : null,
  };
}

const taskbarBadgeImages = new Map();
function focusedRelayWindow(win) {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
}
const taskbarCompletionBadge = createTaskbarCompletionBadge({
  setOverlay: createNativeTaskbarOverlay({ assetDirectory: path.join(__dirname, 'renderer', 'taskbar-badges'),
    onError: error => console.warn('[taskbar-badge-native] %s', error.message) }),
  getWindow: () => process.platform === 'win32' ? mainWindow : null,
  imageForCount: count => {
    const name = count > 9 ? '9-plus' : String(count);
    if (!taskbarBadgeImages.has(name)) {
      // setOverlayIcon uses AsBitmap() and fixes the result to 16px, even for
      // ICOs. Its 1x source must already be 16px; keep higher DPI frames separate.
      const directory = path.join(__dirname, 'renderer', 'taskbar-badges');
      const icon = nativeImage.createFromPath(path.join(directory, `${name}.png`));
      for (const scaleFactor of [1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]) {
        const frame = fs.readFileSync(path.join(directory, `${name}@${scaleFactor}x.png`));
        icon.addRepresentation({ scaleFactor, dataURL: `data:image/png;base64,${frame.toString('base64')}` });
      }
      if (icon.isEmpty()) throw Error('后台任务角标资源缺失');
      taskbarBadgeImages.set(name, icon);
    }
    return taskbarBadgeImages.get(name);
  },
  isForeground: run => focusedRelayWindow(mainWindow)
    || (run.source?.type === 'mini' && miniChat?.getConversationId() === run.source.conversationId
      && focusedRelayWindow(miniHost?.getPanelWindow())),
  onError: error => console.warn('[taskbar-badge] %s', error.message),
});
app.on('browser-window-focus', (_event, win) => {
  if (win === mainWindow) taskbarCompletionBadge.clear();
  else if (miniHost && win === miniHost.getPanelWindow()) taskbarCompletionBadge.clearConversation(miniChat?.getConversationId());
});

function broadcastTaskLedgerChange(change) {
  if (process.platform === 'win32') taskbarCompletionBadge.observe(change);
  const run = publicTaskRun(change && change.run);
  if (!run) return;
  const input = { type: 'run.upsert', runId: run.runId, revision: run.revision, payload: { run } };
  if (!taskEventJournal) {
    const envelope = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION, epoch: TASK_EVENT_EPOCH,
      seq: ++taskEventSeq, emittedAt: new Date().toISOString(), ...input,
    };
    broadcastTaskEnvelope(envelope);
    return;
  }
  taskJournalBuffer.push(input);
  const urgent = isTerminalState(run.state)
    || run.state === RUN_STATES.WAITING_USER || run.state === RUN_STATES.STOPPING;
  if (urgent || taskJournalBuffer.length >= 100) {
    flushTaskJournalEvents();
  } else if (!taskJournalFlushTimer) {
    taskJournalFlushTimer = setTimeout(flushTaskJournalEvents, 120);
    if (taskJournalFlushTimer.unref) taskJournalFlushTimer.unref();
  }
}

function broadcastTaskEnvelope(envelope) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:event', envelope);
  } catch (e) { console.warn('[task-ledger] 事件广播失败: %s', e.message); }
}

function flushTaskJournalEvents() {
  if (taskJournalFlushTimer) {
    clearTimeout(taskJournalFlushTimer);
    taskJournalFlushTimer = null;
  }
  if (!taskJournalBuffer.length) return [];
  const batch = taskJournalBuffer;
  taskJournalBuffer = [];
  let envelopes;
  try {
    envelopes = taskEventJournal.appendMany(batch);
    if (envelopes.length) taskEventSeq = envelopes[envelopes.length - 1].seq;
  } catch (e) {
    console.warn('[task-ledger] 事件日志批量写入失败，退回内存序号 count=%d: %s', batch.length, e.message);
    envelopes = batch.map((input) => ({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION, epoch: TASK_EVENT_EPOCH,
      seq: ++taskEventSeq, emittedAt: new Date().toISOString(), ...input,
    }));
  }
  for (const envelope of envelopes) broadcastTaskEnvelope(envelope);
  return envelopes;
}

function journalClaudeEvent(runId, event) {
  if (!runId || !event) return null;
  // The same cursor travels to the renderer and the durable snapshot. Buffered
  // live events at renderer startup must not append a saved delta a second time.
  event.relay_stream_epoch = TASK_EVENT_EPOCH;
  event.relay_stream_seq = ++streamDeliverySeq;
  streamJournalBuffer.push({ type: 'claude.event', runId, payload: { event } });
  const terminal = event.type === 'result' || event.type === 'job-done';
  if (terminal || streamJournalBuffer.length >= 250) return flushStreamJournalEvents();
  if (!streamJournalFlushTimer) {
    streamJournalFlushTimer = setTimeout(flushStreamJournalEvents, 120);
    if (streamJournalFlushTimer.unref) streamJournalFlushTimer.unref();
  }
  return null;
}

function flushStreamJournalEvents() {
  if (streamJournalFlushTimer) {
    clearTimeout(streamJournalFlushTimer);
    streamJournalFlushTimer = null;
  }
  if (!streamJournalBuffer.length) return null;
  const batch = streamJournalBuffer;
  streamJournalBuffer = [];
  try {
    if (!streamEventJournal) {
      streamEventSeq += batch.length;
      return null;
    }
    const envelopes = typeof streamEventJournal.appendMany === 'function'
      ? streamEventJournal.appendMany(batch)
      : batch.map((item) => streamEventJournal.append(item));
    if (envelopes.length) streamEventSeq = envelopes[envelopes.length - 1].seq;
    try { if (taskProgressStore) taskProgressStore.observe(envelopes); }
    catch (error) { console.warn('[task-progress] 记录执行过程失败: %s', error.message); }
    return envelopes[envelopes.length - 1] || null;
  } catch (e) {
    console.warn('[task-runtime] 流式事件日志批量写入失败 count=%d: %s', batch.length, e.message);
    return null;
  }
}

let taskLedger = null;
let taskOrchestrator = null;
try {
  if (!HAS_SINGLE_INSTANCE_LOCK) throw new Error('secondary Relay instance');
  taskLedger = new TaskLedger({
    rootDir: path.join(app.getPath('userData'), 'task-ledger'),
    logger: console,
    onChange: broadcastTaskLedgerChange,
  });
} catch (e) {
  // 影子账本是旁路能力；userData 暂不可写时必须降级，不能因此阻止 Relay 启动。
  console.warn('[task-ledger] 初始化失败，任务状态恢复本次运行不可用（主流程不受影响）: %s', e.message);
}

try {
  const recovered = taskLedger
    // Relay 的统一资源队列在内存中；重启后旧 queued 已失去消费者，必须显式中断，
    // 让来源对话恢复为可继续的中断状态，不能留下永久排队的幽灵任务。
    ? taskLedger.recover({
      reason: 'Relay restarted before the task reached a terminal state',
      retainQueued: false,
      includeTerminal: false,
    })
    : { interrupted: [] };
  if (recovered.interrupted.length) {
    console.warn('[task-ledger] 启动恢复：%d 个未完成任务已标记为 interrupted', recovered.interrupted.length);
    for (const run of recovered.interrupted) {
      if (run && run.source && run.source.type === 'creation') {
        try {
          materializeCreationTaskResult(run, {
            ok: false,
            error: 'Relay 在图片生成完成前退出，请重新生成',
          });
        } catch (historyError) {
          console.warn('[image] 恢复创作占位失败 runId=%s: %s', run.runId, historyError.message);
        }
      }
    }
  }
} catch (e) { console.warn('[task-ledger] 启动恢复失败（不影响主流程）: %s', e.message); }

try {
  if (taskLedger) {
    // 既有 Claude/图片/PowerShell 执行链通过 acquireExisting 租用这里的统一资源池；
    // orchestrator 负责公平排队、并发限制、会话互斥、健康监控和取消信号。
    taskOrchestrator = new TaskOrchestrator({ ledger: taskLedger });
    taskOrchestrator.start({ recover: false });
  }
} catch (e) { console.warn('[task-orchestrator] 启动失败（任务仍可按旧链路执行）: %s', e.message); }

const taskResourceLeases = new Map();

async function acquireTaskResource(runId, resource, conversationKey = null) {
  if (!taskOrchestrator || !taskLedger || !taskLedger.get(runId)) {
    return { runId, resource, signal: null, release() {} };
  }
  try {
    const lease = await taskOrchestrator.acquireExisting(runId, { resource, conversationKey });
    if (lease) taskResourceLeases.set(runId, lease);
    return lease;
  } catch (e) {
    if (e && ['RUN_ALREADY_ACQUIRING', 'RUN_NOT_QUEUED', 'RUN_TERMINAL'].includes(e.code)) {
      console.warn('[task-orchestrator] 拒绝重复执行 runId=%s code=%s', runId, e.code);
      return null;
    }
    console.warn('[task-orchestrator] 资源租约失败，降级直接执行 runId=%s: %s', runId, e.message);
    return { runId, resource, signal: null, release() {} };
  }
}

function releaseTaskResource(runId) {
  const lease = taskResourceLeases.get(String(runId || ''));
  if (!lease) return false;
  taskResourceLeases.delete(String(runId || ''));
  try { return lease.release() !== false; } catch (_) { return false; }
}

let startupTaskLedgerRetentionScheduled = false;
function scheduleStartupTaskLedgerRetention() {
  if (startupTaskLedgerRetentionScheduled || !taskLedger) return;
  startupTaskLedgerRetentionScheduled = true;
  // Recovery stays synchronous; terminal-record retention must not block the first frame.
  const timer = setTimeout(() => {
    if (isQuitting) return;
    try {
      const pruned = taskLedger.prune({ maxTerminalRuns: 1000, maxAgeMs: 90 * 24 * 60 * 60 * 1000 });
      if (pruned.removed.length) console.log('[task-ledger] 已清理 %d 条过期终态记录', pruned.removed.length);
    } catch (e) { console.warn('[task-ledger] 历史清理失败（不影响主流程）: %s', e.message); }
  }, 1000);
  timer.unref?.();
}

let taskLedgerTerminalWrites = 0;
let taskLedgerPruneTimer = null;
function scheduleTaskLedgerRetention() {
  if (!taskLedger || ++taskLedgerTerminalWrites < 50 || taskLedgerPruneTimer) return;
  taskLedgerPruneTimer = setTimeout(() => {
    taskLedgerPruneTimer = null;
    taskLedgerTerminalWrites = 0;
    try {
      taskLedger.prune({ maxTerminalRuns: 1000, maxAgeMs: 90 * 24 * 60 * 60 * 1000 });
    } catch (e) { console.warn('[task-ledger] 定期历史清理失败: %s', e.message); }
  }, 1000);
  if (taskLedgerPruneTimer.unref) taskLedgerPruneTimer.unref();
}

function createShadowTaskRun(input) {
  if (!taskLedger) return null;
  try {
    return taskLedger.create({
      ...input,
      state: input.state || RUN_STATES.STARTING,
      phase: input.phase || 'preparing',
      title: redactTaskText(input.title || '未命名任务'),
      progress: {
        label: '正在准备',
        ...((input && input.progress) || {}),
      },
    });
  } catch (e) {
    console.warn('[task-ledger] 创建影子任务失败 runId=%s: %s', input && input.runId, e.message);
    return null;
  }
}

function sanitizeTaskAction(action) {
  if (!action || action.kind === 'noop') return action;
  const next = JSON.parse(JSON.stringify(action));
  const target = next.kind === 'terminal' ? next.details : next.patch;
  if (target && target.result) {
    if (target.result.summary) target.result.summary = redactTaskText(target.result.summary);
    if (target.result.error && typeof target.result.error === 'string') {
      target.result.error = redactTaskText(target.result.error);
    }
  }
  return next;
}

function isNoisyShadowEvent(event) {
  const systemProgress = event && event.type === 'system'
    && (event.subtype === 'task_started' || event.subtype === 'task_notification');
  return !!event && (event.type === 'stream_event' || event.type === 'assistant'
    || event.type === 'tool_progress' || event.type === 'stderr' || systemProgress);
}

function drainShadowTaskEvents(runId) {
  const queue = taskEventQueues.get(runId);
  if (!queue) return;
  queue.handle = null;
  while (queue.items.length) {
    const item = queue.items.shift();
    observeShadowClaudeEvent(runId, item.event, item.options);
  }
  taskEventQueues.delete(runId);
}

function enqueueShadowClaudeEvent(runId, event, options = {}) {
  if (!taskLedger || !runId || !event) return;
  if (isNoisyShadowEvent(event)) {
    const nowMs = Date.now();
    if (nowMs - (taskProgressWriteAt.get(runId) || 0) < 1000) return;
    taskProgressWriteAt.set(runId, nowMs);
  }
  let queue = taskEventQueues.get(runId);
  if (!queue) {
    queue = { items: [], handle: null };
    taskEventQueues.set(runId, queue);
  }
  queue.items.push({ event, options });
  if (!queue.handle) queue.handle = setImmediate(() => drainShadowTaskEvents(runId));
}

function flushShadowTaskEvents(runId = null) {
  const ids = runId ? [runId] : [...taskEventQueues.keys()];
  for (const id of ids) {
    const queue = taskEventQueues.get(id);
    if (!queue) continue;
    if (queue.handle) clearImmediate(queue.handle);
    drainShadowTaskEvents(id);
  }
}

function observeShadowClaudeEvent(runId, event, { terminalOwner = 'sdk' } = {}) {
  if (!taskLedger || !runId || !event) return null;
  try {
    const current = taskLedger.get(runId);
    if (!current || isTerminalState(current.state)) return current;
    const action = sanitizeTaskAction(normalizeClaudeTaskEvent(event, current));
    if (!action || action.kind === 'noop') return current;
    // SDK 可能在 canUseTool 挂起后继续吐出已经排队的 stream/tool 事件。只要 broker 仍有
    // 未处理请求，这些迟到事件就只能刷新活动时间，不能把 waiting_user 冲回 running。
    if (action.kind === 'update'
        && current.state === RUN_STATES.WAITING_USER
        && interactionBroker.list({ runId }).length) {
      action.patch = {
        ...(action.patch || {}),
        state: RUN_STATES.WAITING_USER,
        phase: current.phase,
        waiting: current.waiting,
        progress: {
          ...((action.patch && action.patch.progress) || {}),
          label: current.progress && current.progress.label || '等待你的回复',
        },
      };
    }
    if (action.kind === 'terminal' && terminalOwner === 'sdk') {
      taskProgressWriteAt.delete(runId);
      const terminal = taskLedger.terminal(runId, action.status, action.details || {});
      scheduleTaskLedgerRetention();
      return terminal;
    }
    if (action.kind === 'terminal' && action.status === RUN_STATES.CANCELED) {
      // 取消优先于 scheduler 的结果所有权；否则 stopping 会被强行改回 running，
      // 随后的 fireTask(false) 又会把用户取消误记成 failed。
      taskProgressWriteAt.delete(runId);
      const terminal = taskLedger.terminal(runId, RUN_STATES.CANCELED, action.details || {});
      scheduleTaskLedgerRetention();
      return terminal;
    }
    if (action.kind === 'terminal') {
      // 定时任务由 fireTask 的 result.ok 唯一拥有终态；SDK 事件只提供进度与错误摘要。
      return taskLedger.update(runId, {
        ...(action.details || {}),
        state: RUN_STATES.RUNNING,
        executorState: 'draining',
      });
    }
    return taskLedger.update(runId, action.patch || {});
  } catch (e) {
    if (e && (e.code === 'RUN_TERMINAL' || e.code === 'RUN_NOT_FOUND')) return null;
    console.warn('[task-ledger] 观察事件失败 runId=%s type=%s: %s', runId, event && event.type, e.message);
    return null;
  }
}

function finishShadowTaskRun(runId, ok, details = {}) {
  if (!taskLedger || !runId) return null;
  flushShadowTaskEvents(runId);
  try {
    taskProgressWriteAt.delete(runId);
    const status = details.status || (ok ? RUN_STATES.SUCCEEDED : RUN_STATES.FAILED);
    const terminal = taskLedger.terminal(runId, status, {
      phase: 'terminal',
      executorState: 'stopped',
      progress: { label: ok ? '已完成' : (status === RUN_STATES.CANCELED ? '已取消' : '执行失败') },
      ...(details.conversationId ? {
        source: {
          conversationId: details.conversationId,
          conversationKind: details.conversationKind || 'chat',
        },
      } : {}),
      result: {
        status,
        summary: redactTaskText(details.summary || ''),
        error: details.error ? redactTaskText(details.error) : null,
        artifactPaths: Array.isArray(details.artifactPaths) ? details.artifactPaths.slice(0, 100) : [],
      },
    });
    scheduleTaskLedgerRetention();
    return terminal;
  } catch (e) {
    if (e && (e.code === 'RUN_TERMINAL' || e.code === 'RUN_NOT_FOUND')) return null;
    console.warn('[task-ledger] 结束影子任务失败 runId=%s: %s', runId, e.message);
    return null;
  }
}

function requestShadowTaskCancel(runId) {
  if (!taskLedger || !runId) return;
  flushShadowTaskEvents(runId);
  try {
    const run = taskLedger.get(runId);
    if (!run || isTerminalState(run.state)) return;
    taskLedger.update(runId, {
      state: RUN_STATES.STOPPING,
      phase: 'stopping',
      cancelRequestedAt: new Date().toISOString(),
      progress: { label: '正在停止' },
    });
  } catch (e) { console.warn('[task-ledger] 标记取消失败 runId=%s: %s', runId, e.message); }
}

function startScheduledShadowRun({ task, trigger, scheduledFor, startedAt } = {}) {
  const action = task && task.action || {};
  const scheduledWorkspace = resolveExecutionWorkspace({
    conversationId: task.workspaceConversationId || task.lastConvId || `scheduled-${task.id}`,
    workingDir: action.workingDir, ignoreProjects: true,
    useAgent: action.mode === 'agent',
    agentName: action.agentName || null,
  });
  const actionType = action.type || 'chat';
  const kind = actionType === 'image' ? 'scheduled_image'
    : actionType === 'command' ? 'scheduled_command'
      : 'scheduled_chat';
  const runId = crypto.randomUUID();
  const run = createShadowTaskRun({
    runId,
    state: RUN_STATES.QUEUED,
    phase: 'queued',
    kind,
    trigger: trigger || 'timer',
    title: task && task.name || '定时任务',
    priority: trigger === 'manual' ? 80 : 50,
    queuedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
    source: {
      type: 'schedule',
      scheduleId: task && task.id || null,
      conversationId: task.workspaceConversationId || task.lastConvId || null,
      builtin: task && task.builtin || null,
      scheduledFor: scheduledFor || null,
    },
    execution: { jobId: runId, appInstanceId: TASK_EVENT_EPOCH },
    metadata: {
      actionType,
      model: action.model || action.imageModel || null,
      workingDir: scheduledWorkspace.cwd,
    },
  });
  return run && run.runId || null;
}

function updateScheduledShadowPhase(runId, phase, label) {
  if (!taskLedger) return;
  try {
    const run = taskLedger.get(runId);
    if (!run || isTerminalState(run.state)) return;
    taskLedger.update(runId, {
      state: RUN_STATES.RUNNING,
      phase: phase || 'running',
      executorState: 'active',
      progress: { label: redactTaskText(label || '正在运行') },
    });
  } catch (e) {
    if (!e || (e.code !== 'RUN_TERMINAL' && e.code !== 'RUN_NOT_FOUND')) {
      console.warn('[task-ledger] 更新定时任务阶段失败 runId=%s: %s', runId, e.message);
    }
  }
}

function finishScheduledShadowRun(runId, result) {
  const value = result || { ok: false, error: '任务没有返回结果' };
  return finishShadowTaskRun(runId, value.ok === true, {
    status: value.canceled === true ? RUN_STATES.CANCELED : undefined,
    summary: value.summary || '',
    error: value.ok === true || value.canceled === true ? null : (value.error || '执行失败'),
    artifactPaths: Array.isArray(value.paths) ? value.paths : [],
    conversationId: value.conversationId || null,
    conversationKind: value.conversationKind || null,
  });
}

function interruptActiveShadowRuns(reason) {
  if (!taskLedger) return;
  flushShadowTaskEvents();
  try {
    for (const run of taskLedger.list({ terminal: false })) {
      if (run.state === RUN_STATES.QUEUED && !run.startedAt) continue;
      taskLedger.terminal(run.runId, RUN_STATES.INTERRUPTED, {
        phase: 'terminal',
        executorState: 'stopped',
        progress: { label: '因 Relay 退出而中断' },
        result: { error: { code: 'APP_EXIT', message: reason } },
      });
    }
  } catch (e) { console.warn('[task-ledger] 退出状态写入失败: %s', e.message); }
}

// ─────────────────────────────────────────
// 历史会话存储(v2:目录式,每会话一文件 + 轻量索引)
// ─────────────────────────────────────────
//   v1 是单文件 history.json:任何一轮对话保存都全量重写整库,列表/搜索/统计也要全量解析,
//   成本随会话总量线性涨,用得越久越慢。v2 拆为 userData/history/ 目录:
//     · <convId>.json — 一条会话一个文件,读写只碰当条(与长期记忆库同构);
//     · index.json    — 只存侧边栏列表要用的元数据(标题/时间/轮数/置顶…),列表零正文 IO。
//   索引只是缓存:损坏/缺失由 rebuildHistoryIndex() 扫正文全量重建,不存在「索引丢=数据丢」。
//   旧 history.json 启动时一次性迁移进目录(migrateHistoryV1),原文件改名 .bak 保底不删。
function getHistoryDir() {
  if (!HISTORY_DIR) HISTORY_DIR = path.join(app.getPath('userData'), 'history');
  if (!fs.existsSync(HISTORY_DIR)) { try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (_) {} }
  return HISTORY_DIR;
}
function historyIndexPath() { return path.join(getHistoryDir(), 'index.json'); }
// 会话 id → 正文文件路径。id 一律是我们自己生成的 UUID,这里再防御性过滤一次,
//   保证拼不出路径分隔符(索引/正文若被手工改坏,也写不出目录外)。
function convFilePath(id) {
  return path.join(getHistoryDir(), String(id).replace(/[^\w-]/g, '_') + '.json');
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
// 从会话正文提取索引元数据 —— 列表(history:list)需要的全部字段。单处定义,save 与 rebuild 共用,防字段漂移。
function convMeta(c) {
  return {
    id: c.id,
    title: c.title,
    sessionId: c.sessionId || null,
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
    turnCount: Array.isArray(c.turns) ? c.turns.length : 0,
    kind: c.kind || 'chat',
    mode: c.mode || 'plain',
    fromScheduled: c.fromScheduled || null,
    pinned: !!c.pinned,
  };
}
function readHistoryIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(historyIndexPath(), 'utf8'));
    if (d && Array.isArray(d.items)) return d.items;
  } catch (e) { console.warn('[history] 索引读取失败,将重建: %s', e.message); }
  return rebuildHistoryIndex();   // 缺失/损坏 → 扫正文重建(空库返回 [])
}
function writeHistoryIndex(items) {
  try { writeJsonAtomic(historyIndexPath(), { version: 2, items }); }
  catch (e) { console.error('[history] 索引写入失败:', e.message); }
}
// 扫描目录所有会话正文,重建索引并落盘。坏文件跳过(正文还在,修好下次重建即回来)。
function rebuildHistoryIndex() {
  const items = [];
  try {
    for (const name of fs.readdirSync(getHistoryDir())) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(getHistoryDir(), name), 'utf8'));
        if (c && c.id) items.push(convMeta(c));
      } catch (e) { console.error('[history] 会话文件解析失败,跳过:', name, e.message); }
    }
  } catch (_) {}
  writeHistoryIndex(items);
  return items;
}
// ── CRUD:全部以「单条会话」为粒度,每次只碰一个正文文件 + 索引 ──
function loadConversation(id) {
  try {
    const conversation = JSON.parse(fs.readFileSync(convFilePath(id), 'utf8'));
    try { return recoverLegacyOutput(conversation, { rootDir: path.join(app.getPath('userData'), 'task-ledger') }); }
    catch (_) { return conversation; }
  } catch (e) {
    // 新会话尚未落盘、已删除会话仍被任务账本引用时，缺失正文是正常的查询结果。
    // 只容忍 ENOENT；权限、I/O 和 JSON 损坏仍需保留诊断。
    if (e.code !== 'ENOENT') console.warn('[history] 加载会话失败: %s id=%s', e.message, id);
    return null;
  }
}
// 原样持久化一条会话并同步轻量索引。这个底层函数不做字段语义变更，供
// “置顶/会话失效”等不能刷新最近时间或顺带改标题的元数据维护路径使用。
function persistConversationRecord(conv) {
  writeJsonAtomic(convFilePath(conv.id), conv);
  const items = readHistoryIndex();
  const i = items.findIndex((m) => m.id === conv.id);
  if (i >= 0) items[i] = convMeta(conv); else items.unshift(convMeta(conv));
  writeHistoryIndex(items);
}
let conversationPermissions = null;
function getConversationPermissions() {
  if (!conversationPermissions) conversationPermissions = createConversationPermissions({
    readSettings: readAppSettings, writeSettings: writeAppSettings, loadConversation,
    persistConversation: persistConversationRecord,
    applyRuntime: async (id, next, before) => {
      const sess = liveSessions.get(id);
      if (!sess || sess.dead || !sess.child) {
        const activeFallback = [...jobs.keys()].some(runId => {
          const task = taskLedger && taskLedger.get(runId);
          return task && task.source && task.source.conversationId === id;
        });
        if (activeFallback) throw Object.assign(new Error('当前任务无法实时切换权限，请等待本轮完成'), { code: 'PERMISSION_RUNTIME_UNAVAILABLE', runtimeUnchanged: true });
        return;
      }
      const changedExecution = JSON.stringify(next.executionMode) !== JSON.stringify(before.executionMode);
      if (changedExecution && sess.busy) throw Object.assign(new Error('请先停止或完成当前任务，再切换计划或目标模式'), { code: 'MODE_CHANGE_WHILE_RUNNING', runtimeUnchanged: true });
      if (typeof sess.child.whenReady === 'function') await sess.child.whenReady();
      if (liveSessions.get(id) !== sess || sess.dead) throw Object.assign(new Error('对话执行器已更新，请重试权限切换'), { code: 'PERMISSION_RUNTIME_CHANGED', runtimeUnchanged: true });
      const previousReconciliation = sess.permissionReconciliation;
      // During any transition, especially a downgrade, never settle callbacks
      // using the previous broader mode while the SDK control is in flight.
      sess.permissionReconciliation = null;
      if (changedExecution) {
        const ready = await withLiveControlTimeout(sess.child.prepareExecutionMode(next.executionMode, { permissionMode: next.permissionMode }), '更新对话执行模式');
        sess.executionMode = ready.executionMode;
        sess.permissionMode = ready.permissionMode;
      } else {
        await withLiveControlTimeout(sess.child.setPermissionMode(next.permissionMode), '更新对话权限');
        sess.permissionMode = next.executionMode.kind === 'plan' ? 'plan' : next.permissionMode;
      }
      if (liveSessions.get(id) !== sess || sess.dead) throw Object.assign(new Error('对话执行器已更新，请重试权限切换'), { code: 'PERMISSION_RUNTIME_CHANGED', runtimeUnchanged: true });
      const runId = sess.jobId;
      const commit = () => {
        if (!runId || liveSessions.get(id) !== sess || sess.dead || sess.jobId !== runId) return;
        const reconciliation = { conversationId: id, runId, revision: next.revision,
          permissionMode: next.executionMode.kind === 'plan' ? 'plan' : next.permissionMode,
          cwd: sess.launchSpec?.cwd, additionalDirectories: [sess.launchSpec?.validWorkingDir, sess.launchSpec?.agentProjectRoot].filter(Boolean),
        };
        sess.permissionReconciliation = reconciliation;
        interactionBroker.reconcilePermissionMode(reconciliation);
      };
      commit.rollback = async () => {
        if (liveSessions.get(id) !== sess || sess.dead) return;
        if (changedExecution) {
          const ready = await withLiveControlTimeout(sess.child.prepareExecutionMode(before.executionMode, { permissionMode: before.permissionMode }), '恢复对话执行模式');
          sess.executionMode = ready.executionMode; sess.permissionMode = ready.permissionMode;
        } else {
          await withLiveControlTimeout(sess.child.setPermissionMode(before.permissionMode), '恢复对话权限');
          sess.permissionMode = before.executionMode.kind === 'plan' ? 'plan' : before.permissionMode;
        }
        sess.permissionReconciliation = previousReconciliation;
      };
      return commit;
    },
    stopRuntime: id => { const sess = liveSessions.get(id); if (sess && !sess.dead) killLiveSession(sess, '权限切换未确认，安全停止当前执行'); },
    onChanged: snapshot => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || (miniHost && miniHost.getOrbWindow() === window)) continue;
        try { window.webContents.send('permissions:changed', snapshot); } catch (_) {}
      }
    },
  });
  return conversationPermissions;
}
function conversationPermissionSnapshot(id) {
  return getConversationPermissions().get(id && fs.existsSync(convFilePath(id)) ? id : null);
}
function persistGoalRecovery(id, value) {
  const record = id && loadConversation(id);
  if (!record) return;
  const condition = goalConditionValue(value);
  if (Object.hasOwn(record, 'goalRecovery') && (record.goalRecovery?.condition || null) === condition) return;
  record.goalRecovery = condition ? { condition } : null;
  // Goal bookkeeping must not change the conversation's history ordering.
  persistConversationRecord(record);
}
function saveConversation(conv) {
  const saved = conv.id && fs.existsSync(convFilePath(conv.id)) ? loadConversation(conv.id) : null;
  const runtime = liveSessions.get(conv.id);
  if (saved) mergeSupplementHistory(conv, saved, runtime);
  // The contract belongs to the persisted native identity. An empty prewarm
  // may already use a newer contract while the renderer still holds the old
  // session; presentation saves must not make that old handle look compatible.
  // applyProvenance advances identity and contract together on native events.
  if (saved?.sdkRuntimeFingerprint) conv.sdkRuntimeFingerprint = saved.sdkRuntimeFingerprint;
  else delete conv.sdkRuntimeFingerprint;
  const fingerprintVersion = saved?.sdkRuntimeFingerprintVersion;
  if (fingerprintVersion) conv.sdkRuntimeFingerprintVersion = fingerprintVersion;
  else delete conv.sdkRuntimeFingerprintVersion;
  if (saved?.sdkTaskResources) conv.sdkTaskResources = saved.sdkTaskResources;
  if (saved?.sdkReviewFindings) conv.sdkReviewFindings = saved.sdkReviewFindings;
  protectSdkMetadata(conv, saved);
  protectGoalRecovery(conv, saved);
  getConversationPermissions().protectSave(conv, saved);
  // 标题统一收口:所有内容写路径(渲染层占位/AI 摘要/手动重命名/定时任务)都经这里落盘,
  //   一处截断即全局生效;超长的旧标题也会在下次保存时自动收口。
  if (conv.title) conv.title = truncateByWidth(String(conv.title), TITLE_MAX_W);
  persistConversationRecord(conv);
}
// 上下文占用是会话的派生快照：单独写回正文，不能刷新 updatedAt，
// 否则仅仅打开一条历史对话就会把它错误顶到“最近对话”最前面。
function persistConversationContextUsage(id, raw) {
  const context = compactContextUsage(raw);
  if (!id || !context || (!context.rawMaxTokens && !context.maxTokens)) return null;
  const conv = loadConversation(id);
  if (!conv) return null;
  const cached = { ...context, cachedAt: new Date().toISOString() };
  conv.contextUsage = cached;
  try {
    writeJsonAtomic(convFilePath(id), conv);
    return cached;
  } catch (e) {
    console.warn('[history] 保存上下文占用失败 id=%s: %s', id, e.message);
    return context;
  }
}
function deleteConversation(id) {
  if (taskProgressStore) {
    const conversation = loadConversation(id);
    for (const turn of conversation?.turns || []) {
      if (turn.runId) void taskProgressStore.remove(turn.runId)
        .catch(error => console.warn('[task-progress] 清理已删除会话进度失败: %s', error.message));
    }
  }
  try { fs.rmSync(convFilePath(id), { force: true }); } catch (e) { console.warn('[history] 删除会话文件失败: %s id=%s', e.message, id); }
  writeHistoryIndex(readHistoryIndex().filter((m) => m.id !== id));
}
// 全量遍历正文(搜索/统计用):按索引 updatedAt 新→旧逐文件 parse,一条条吐给回调,
//   不把整库攒在内存里;回调显式返回 false 可提前终止(搜索凑满条数即停)。
function forEachConversation(fn) {
  const items = [...readHistoryIndex()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  for (const m of items) {
    const c = loadConversation(m.id);
    if (!c) continue;
    if (fn(c) === false) return;
  }
}
// ── v1 → v2 一次性迁移:旧单文件逐条搬进目录;中断可幂等续迁;原文件改名 .bak 保底不删 ──
function migrateHistoryV1() {
  const legacy = path.join(app.getPath('userData'), 'history.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const d = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const convs = Array.isArray(d && d.conversations) ? d.conversations : [];
    let n = 0;
    for (const c of convs) {
      if (!c || !c.id) continue;
      if (fs.existsSync(convFilePath(c.id))) continue;   // 上次迁移中断过 → 跳过已迁条目
      writeJsonAtomic(convFilePath(c.id), c);
      n++;
    }
    rebuildHistoryIndex();
    // 改名保底(不删)。.bak 已存在(极端:迁移后用户又放回一个 history.json)则带时间戳避让。
    const bak = legacy + '.bak';
    try { fs.renameSync(legacy, fs.existsSync(bak) ? `${legacy}.bak-${Date.now()}` : bak); } catch (_) {}
    console.log(`[history] v1 迁移完成:${n} 条会话已转为目录式存储`);
  } catch (e) {
    console.error('[history] v1 迁移失败(原文件保留,下次启动重试):', e.message);
  }
}

// 活跃的 claude 子进程,按 jobId 索引(支持多对话并行)。
//   jobId → child。每次 claude:run 生成一个 jobId,事件流都带 jobId 回传,
//   前端据此把输出分发到对应对话。claude:abort 按 jobId 杀单个,关窗口杀全部。
const jobs = new Map();
let maxParallelTasks = GENERAL_PREFERENCE_DEFAULTS.maxParallelTasks; // 0 表示不限制；启动与保存设置后同步

// ─────────────────────────────────────────
// 飞书 MCP:链接识别 + prompt 提示
// ─────────────────────────────────────────
//   历史问题:headless(-p)每轮都新 spawn 一个 claude.exe → 每轮重启一遍所有 MCP。而 claude
//     默认非阻塞连 MCP,实测 init 在 2.67s 就发出、此时 mcp_servers 全 pending、工具列表里飞书
//     0 个 —— 模型开局看到的是「没有飞书工具」的世界,于是退化去抓网页(WebFetch / WebSearch /
//     Bash+curl 都试过),全都撞飞书登录墙 → 报「无法访问文档」。
//   不能靠禁用工具堵:堵了 WebFetch 模型换 WebSearch,再堵换 Bash+curl —— 打地鼠,堵不完。
//   现在的解法是常驻会话池(见 LiveSession):进程复用 → MCP 只连一次 → 模型开局就握着全部工具,
//     根本不存在「要不要等」的问题。下面这条 prompt 提示退居保险位,只兜「开窗即发」的边缘案例。
// (曾经的 XIAOMI_NPM_REGISTRY / FEISHU_PKG 两个常量随预热一起删了 —— 除预热外无人使用。)
//
// (CLAUDE_PKG / PUBLIC_NPM_REGISTRY / NPM_GLOBAL_PREFIX 与 parseVersion / compareVersions
//  也随「运行时内置」一起删了：它们只服务于「用 npm 检查并升级用户全局的 claude-code」，
//  而运行时现在随 Relay 分发、版本由 package.json 锁定，那条升级路径已不存在。)

// 飞书/Lark 文档域名(命中即认为本轮需要飞书 MCP)
const FEISHU_URL_RE = /https?:\/\/[^\s]*\b(feishu\.cn|larksuite\.com|larkoffice\.com|feishu\.net)\b/i;
function promptNeedsFeishu(text) {
  return typeof text === 'string' && FEISHU_URL_RE.test(text);
}

// 飞书轮追加到 prompt 末尾的系统提示 —— 让模型等 MCP 就绪而不是退化抓网页
const FEISHU_HINT =
  '\n\n---\n[系统提示] 上面包含飞书(Feishu/Lark)文档链接。请务必使用 feishu-mcp-pro ' +
  '提供的 MCP 工具来读取和操作(如 wiki_get_node / doc_fetch / doc_read / doc_create / doc_write / ' +
  'doc_update / bitable_ops / sheet_ops 等)。若这些工具此刻尚未就绪,请稍等片刻后重试调用,' +
  '不要改用 WebFetch、WebSearch 或命令行(curl/Invoke-WebRequest)去抓取网页 —— 飞书文档需要登录鉴权,' +
  '直接抓网页只会拿到登录页,无法获取正文。\n' +
  '重要:飞书 MCP 提供约 50+ 个工具(涵盖文档读写、多维表格、电子表格、日历、任务、知识库等)。' +
  '如果你的工具列表中只看到部分飞书工具(例如只有读取类没有写入类),这是 MCP 工具列表加载延迟导致的,' +
  '请直接尝试调用你需要的工具名称(如 doc_create、doc_write、doc_update 等),不要因为工具列表中暂时' +
  '看不到就放弃或告诉用户工具不可用——工具实际上是存在的,直接调用即可成功。';

// Relay 已为 AskUserQuestion 和权限请求提供原生决策卡。明确鼓励使用结构化工具，
// 避免模型退回到一大段文字选项；UI 会在用户回复后把答案原样回传并继续本轮。
const ASK_HINT =
  '\n\n---\n[原生交互] 当你确实需要用户在多个方案中选择、补充关键输入或确认取舍时，' +
  '请使用 AskUserQuestion 工具。Relay 会显示专属决策卡并把答案回传给你；' +
  '不要把本可结构化的问题改写成普通回复后结束任务。只读探查可先继续进行，' +
  '涉及权限的操作由 Relay 原生权限审批卡处理。';

// 每轮都追加:图片处理须知。要区分两类图片,不能一刀切禁止读图:
//   ① 你自己「生成/产出」的图(文生图落盘的结果)——只用 Markdown 路径引用让前端渲染,
//      不要 Read。根因:Read 会把图以多模态 image block 塞进历史,若当前模型不支持图片输入,
//      后续 --resume 续接会报错中断;而生成结果本来也不需要回看。
//   ② 用户「主动上传」的图——这是用户让你看的,应当用 Read 读取后再回答。
//      若用户配置的模型不支持多模态,Read 会自然返回「无法识别图片」之类的结果,据实告知即可;
//      不要因为怕出错就拒绝查看,否则用户传图永远得不到回应(这正是之前的 bug)。
const IMAGE_HINT =
  '\n\n---\n[图片处理须知] 区分两种情况:' +
  '(1) 你自己生成/产出的图片文件:只需在回复里用 Markdown `![描述](路径)` 引用,界面会自动渲染,' +
  '不要用 Read 去读取它(回看生成结果没有必要,且可能因模型不支持图片输入而中断后续对话)。' +
  '(2) 用户在对话里上传的图片:已随消息附上的图片请直接查看;仅提供路径时用 Read 工具读取后再回答;' +
  '若所用模型不支持图片输入而读取失败,如实告知用户即可,不要无故拒绝查看。';

// 注:曾有一个 warmUpFeishuMcp()（启动时 spawn 一个飞书 MCP、握手完就杀掉，想焐热缓存）。
//   实测证明它无效，已删除，别再加回来：
//     · 宣称的「V8 编译缓存」不成立 —— Node 20 不支持持久化编译缓存（22.1+ 才有），code cache 随进程消失。
//     · 宣称的「token 刷新」不成立 —— 实测 initialize+tools/list 前后 ~/.feishu-mcp-pro/auth.json 的
//       mtime 纹丝不动。认证是懒触发的（server 启动只 connect transport，getClient() 只在工具处理器里调）。
//     · 唯一真实收益只有 OS page cache，且预热完再握手仍要 3.4s —— 根本没把 server 拉出模型抢跑的窗口。
//   真正的解法是下面的「常驻会话池」：焐的是真正会服务这一轮的那个进程，而不是一个用完即弃的替身。

// ─────────────────────────────────────────
// 历史会话读写(JSON 文件,原子写)
// ─────────────────────────────────────────
// 一次性迁移:早期定时任务会话的标题带「⏰ 」前缀,现在改用侧边栏时钟图标标识,把前缀洗掉。
//   只看索引挑命中的会话,逐条改正文(目录式存储下不再整库读写)。
function migrateScheduledTitles() {
  try {
    for (const m of readHistoryIndex()) {
      if (typeof m.title === 'string' && /^⏰\s*/.test(m.title)) {
        const c = loadConversation(m.id);
        if (!c) continue;
        c.title = String(c.title || '').replace(/^⏰\s*/, '');
        saveConversation(c);
      }
    }
  } catch (e) {
    console.error('[history] 标题迁移失败(不影响启动):', e.message);
  }
}
function genId() {
  return require('crypto').randomUUID();
}

// ─────────────────────────────────────────
// Claude Code 运行时
// ─────────────────────────────────────────
// 运行时由 @anthropic-ai/claude-agent-sdk 自带（平台专属包 claude-agent-sdk-win32-x64，
// 内含完整的 claude.exe），随 Relay 一起分发 —— 因此不再需要探测用户机器上装没装
// Claude Code，也不再有「装了但版本不对/被 npm 装成损坏占位文件」这类问题。
//
// 这里原本有一整套 isUsableClaudeExe(PE 头校验) / findClaudeExe / resolveClaudeShimToExe /
// findClaudeExeViaWhere / ensureClaudeExe / getUsableClaudeExe，专门对付 Windows 上的
// 「PATH 上只有 npm shim 没有真 exe」「npm 在 optional 包下载失败时留下 500B 的错误脚本」
// 「where 被杀软拖死」等一堆环境问题；1.4.0 那个「每次启动都弹向导」的时序坑也出在这条链路上。
// 运行时内置后这些问题从根上消失，整段删除。
const CLAUDE_RUNTIME_VERSION = claudeSdk.bundledClaudeVersion();
console.log('[main] 内置 Claude Code 运行时 → %s (%s)', CLAUDE_RUNTIME_VERSION, claudeSdk.bundledExecutable());

// ─────────────────────────────────────────
// 系统托盘:最小化到托盘后台跑任务
// ─────────────────────────────────────────
// 从托盘恢复并聚焦主窗口(若已被销毁则重新创建)
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 真正退出:置位 isQuitting(放行 close 钩子)→ quit。子进程在 window-all-closed 里统一清理。
function quitApp() {
  isQuitting = true;
  app.quit();
}

// 重建托盘右键菜单 + 刷新提示气泡上的任务数。
//   关键:Windows 下一旦 setContextMenu 接管,系统原生弹出菜单,right-click 事件并不可靠触发,
//   因此不能「等右键时才刷新」——必须在任务数变化时主动调本函数推送新菜单(否则永远停在建菜单那一刻的快照,显示空闲)。
function refreshTrayMenu() {
  if (!tray) return;
  // 常驻会话里【正在跑】的那些也算在跑;闲置常驻不算(用户视角它不是"任务")
  const n = jobs.size + busyLiveCount();
  const waitingCount = interactionBroker.list().length;
  // 下一个定时任务提示(没有则不显示该行)
  let nextHint = null;
  try { nextHint = scheduler.nextTaskHint(); } catch (e) { console.warn('[tray] nextTaskHint 失败: %s', e.message); }
  // 迷你输入框菜单文案带上实际快捷键(占用兜底后可能不是 Alt+Space);没注册成功则不显示提示
  const miniAccelText = registeredMiniAccel ? `（${registeredMiniAccel.replace('Control', 'Ctrl')}）` : '';
  const miniEnabled = isQuickChatEnabled(readAppSettings());   // 关掉迷你输入框时连菜单项一并隐藏,UI 不留死入口
  const template = [
    { label: '显示 Relay', click: () => showMainWindow() },
  ];
  try {
    const routing = providerStore.getRoutingView();
    const labels = { haiku: '快速', sonnet: '思考', opus: '专家' };
    const routes = routing.chatRoutes.filter((item) => item.available);
    if (routes.length) {
      const active = routes.find((item) => item.tier === routing.defaultModel) || routes[0];
      template.push({
        label: `默认模型 · ${active ? labels[active.tier] : '未选择'}`,
        submenu: routes.map((item) => ({
          label: `${labels[item.tier]} · ${item.providerName}`,
          type: 'radio',
          checked: item.tier === routing.defaultModel,
          click: () => {
            try {
              const changed = providerStore.setDefaultModel(item.tier);
              if (changed.changed) publishProviderChange('更新默认档位');
            } catch (error) { console.warn('[provider] 托盘切换默认档位失败: %s', error.message); }
          },
        })),
      });
    }
  } catch (error) {
    console.warn('[tray] 读取 Relay 服务商失败: %s', error.message);
  }
  if (waitingCount > 0) {
    template.push({
      label: `需要你处理：${waitingCount} 项`,
      click: () => showMainWindow(),
    });
  }
  if (miniEnabled) template.push({ label: `快捷对话${miniAccelText}`, click: () => toggleMiniWindow() });
  template.push({ label: '显示桌面悬浮球', click: () => {
    const settings = readAppSettings();
    if (!isQuickChatEnabled(settings)) {
      writeAppSettings({ ...settings, ...normalizeQuickChatPatch({ quickChatEnabled: true }) });
      registerMiniShortcut();
      refreshTrayMenu();
    }
    getMiniWindowHost().syncSettings();
    getMiniWindowHost().showOrb();
  } });
  template.push(
    {
      // 动态显示当前后台任务数,让用户知道退出会中断什么
      label: n > 0 ? `后台任务:${n} 个运行中` : '后台任务:空闲',
      enabled: false,
    },
  );
  if (nextHint) template.push({ label: `下一个定时任务:${nextHint.label}`, enabled: false });
  template.push({ type: 'separator' }, { label: '退出 Relay', click: () => quitApp() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(waitingCount > 0
    ? `Relay · ${waitingCount} 项等待处理`
    : (n > 0 ? `Relay · ${n} 个任务运行中` : 'Relay'));
}

// 创建托盘图标 + 右键菜单。幂等:已存在则不重复建。
function createTray() {
  if (tray) return tray;
  // 托盘图标:直接把多尺寸 .ico 交给 Tray —— Windows 会按当前 DPI 缩放从内嵌的
  //   16/24/32/48/… 各层里挑最合适的那张,任何缩放比下都清晰。
  //   切忌在这里 resize 成固定 16×16:那会丢掉其余高分层、只剩一张小图,HiDPI 下被系统放大 → 发虚。
  //   读不到(路径错/解码失败)时 createFromPath 返回空图 → 托盘空白,这里显式探测并告警。
  const iconFile = currentAppIcon();
  const img = iconFile ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  if (!iconFile || img.isEmpty()) {
    console.warn('[tray] 图标缺失或解码失败,托盘将无图标。APP_ICON=%s isPackaged=%s resourcesPath=%s',
      iconFile, app.isPackaged, process.resourcesPath);
  }
  tray = new Tray(img);
  refreshTrayMenu();   // 建好即按当前任务数渲染一次菜单 + 提示
  // 左键单击/双击恢复窗口(Windows 习惯)
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
}

// ─────────────────────────────────────────
// 快捷对话与桌面悬浮球：窗口可隐藏，执行与历史由主进程持续管理。
// ─────────────────────────────────────────
let miniHost = null;
let miniChat = null;
let pendingMiniConversationId = null;
let miniMainReadySender = null;
let miniBrandCache = null;
let miniShutdownPending = false;
let miniShutdownComplete = false;
let registeredMiniAccel = null;

function miniBrandSnapshot() {
  if (miniBrandCache) return miniBrandCache;
  const a = readAppSettings();
  return miniBrandCache = {
    name: a.brandName || 'Relay', logo: brandLogoDataUrl(),
    theme: a.theme || 'light', enabled: isQuickChatEnabled(a),
    shortcut: registeredMiniAccel,
  };
}
function miniSnapshot(chatState) {
  return { ...(chatState || getMiniChat().state()), ...(miniHost ? miniHost.getState() : { pinned: readAppSettings().miniWindowPinned !== false }), brand: miniBrandSnapshot(), followUpMode: readAppSettings().followUpMode === 'queue' ? 'queue' : 'steer' };
}
function publishMiniState(chatState) {
  if (!miniHost) return;
  const panel = miniHost.getPanelWindow();
  const orb = miniHost.getOrbWindow();
  // The orb needs no transcript. Avoid creating the controller or cloning a long
  // conversation simply to update a stateless window's running indicator.
  try { if (panel && !panel.isDestroyed()) panel.webContents.send('mini:state', miniSnapshot(chatState)); } catch (_) {}
  try {
    if (orb && !orb.isDestroyed()) orb.webContents.send('mini:state', {
      running: chatState ? chatState.running : !!miniChat?.isRunning(),
      pinned: miniHost.getState().pinned, brand: miniBrandSnapshot(),
    });
  } catch (_) {}
}
function getMiniChat() {
  if (!miniChat) miniChat = createMiniChatController({
    run: (request, onEvent) => runClaudeRequest({ miniChat: true, sender: { send: (_channel, value) => onEvent(value) } }, request),
    pause: jobId => pauseClaudeJob(jobId),
    steer: request => steerLiveTurn(request),
    loadConversation: id => fs.existsSync(convFilePath(id)) ? loadConversation(id) : null,
    saveConversation: conv => saveConversation(projectConversation(conv)),
    generateTitle: text => generateConversationTitle(text),
    getDefaultModel: () => providerStore.getRoutingView().defaultModel || 'haiku',
    getPermissions: id => getConversationPermissions().get(id),
    setPermissions: input => getConversationPermissions().set(input),
    getSessionRoute: model => providerSessionRoute(activeRelayProviderRuntime({ tier: model }), model),
    onState: state => publishMiniState(state),
    onHistoryChanged: id => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini:history-changed', { id }); } catch (_) {}
    },
  });
  return miniChat;
}
function getMiniWindowHost() {
  if (!miniHost) miniHost = createMiniWindowHost({
    BrowserWindow, screen: require('electron').screen, Menu, rootDir: __dirname,
    readSettings: readAppSettings, writeSettings: writeAppSettings,
    onOpenMain: () => { showMainWindow(); },
    onDisableOrb: () => { registerMiniShortcut(); refreshTrayMenu(); },
    onStateChange: () => publishMiniState(),
  });
  return miniHost;
}
function toggleMiniWindow() { return getMiniWindowHost().toggle({ source: 'shortcut' }); }
function miniPanelCaller(event) { return !!miniHost && !!event && event.senderFrame === event.sender.mainFrame && miniHost.isPanelSender(event.sender); }
function miniOrbCaller(event) {
  const orb = miniHost && miniHost.getOrbWindow();
  return !!orb && !orb.isDestroyed() && event && event.senderFrame === event.sender.mainFrame && event.sender === orb.webContents;
}
function miniInteractionWindowId(runId) {
  const run = taskLedger && taskLedger.get(runId);
  if (run && run.source && run.source.type === 'mini') {
    const win = miniHost && miniHost.getPanelWindow();
    return win && !win.isDestroyed() ? win.id : null;
  }
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.id : null;
}
function submitMiniChatRequest(input) {
  const controller = getMiniChat();
  const id = controller.getConversationId();
  if (id && !controller.isRunning()) {
    const session = liveSessions.get(id);
    const ownedElsewhere = (session && session.busy)
      || (taskLedger && taskLedger.list({ terminal: false }).some(run => run.source && run.source.conversationId === id));
    // Main saves its user placeholder just before admitting the execution. Cover
    // that short gap too, so a retained mini window cannot steal the write owner.
    const latest = fs.existsSync(convFilePath(id)) ? loadConversation(id) : null;
    const latestTurn = latest && latest.turns && latest.turns.at(-1);
    const known = controller.state().conversation;
    const knownTurn = known && known.turns && known.turns.at(-1);
    const pendingMainInput = latestTurn && latestTurn.runId !== (knownTurn && knownTurn.runId)
      && !latestTurn.assistant && !latestTurn.output && !latestTurn.error && !latestTurn.status;
    if (ownedElsewhere || pendingMainInput) return { ok: false, code: 'MAIN_TURN_ACTIVE', error: '这个对话正在主窗口中运行，请等待回复完成后继续。' };
  }
  return controller.submit(typeof input === 'string' ? { text: input } : input);
}
async function openMiniConversationInMain() {
  if (getMiniChat().isRunning()) return { ok: false, error: '回复完成后可在主窗口查看。' };
  const saved = await getMiniChat().flush();
  if (!saved || saved.ok === false) return saved || { ok: false, error: '对话记录尚未保存' };
  if (getMiniChat().isRunning()) return { ok: false, error: '回复完成后可在主窗口查看。' };
  pendingMiniConversationId = getMiniChat().getConversationId();
  showMainWindow();
  if (mainWindow && miniMainReadySender === mainWindow.webContents && !mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('mini:open-conversation', { id: pendingMiniConversationId });
    pendingMiniConversationId = null;
  }
  return { ok: true };
}

// 注册全局快捷键。首选 Alt+Space;被系统/他应用占用则依次兜底,确保总能起来。
//   快捷小窗总开关关闭时不注册，并释放已占用的键。
//   在「设置 → 常规」控制悬浮球与 Alt+Space；关闭窗口不影响运行中的对话。
function registerMiniShortcut() {
  const enabled = isQuickChatEnabled(readAppSettings());
  if (!enabled) {
    if (registeredMiniAccel) {
      try { globalShortcut.unregister(registeredMiniAccel); } catch (_) {}
      registeredMiniAccel = null;
    }
    console.log('[mini] 迷你输入框开关已关闭,跳过全局快捷键注册');
    return null;
  }
  if (registeredMiniAccel) return registeredMiniAccel;   // 已注册,避免重复
  const candidates = ['Alt+Space', 'Control+Alt+Space', 'Control+Shift+Space'];
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, toggleMiniWindow)) {
        registeredMiniAccel = accel;
        console.log('[mini] 全局快捷键已注册:', accel);
        return accel;
      }
    } catch (e) { console.warn('[mini] 注册快捷键失败:', accel, e.message); }
  }
  console.warn('[mini] 所有候选快捷键均被占用,迷你输入框仅能从托盘菜单唤起');
  return null;
}

// ─────────────────────────────────────────
// 创建主窗口(聊天)
// ─────────────────────────────────────────
const MAIN_WINDOW_CHROME_HEIGHT = 36;
const mainWindowChromeAppearances = new WeakMap();
function mainWindowTitleBarOverlay(dark, searchOpen = false) {
  return {
    color: searchOpen ? (dark ? '#0f0f0f' : '#919191') : (dark ? '#1a1a1a' : '#fafafa'),
    symbolColor: searchOpen ? (dark ? '#848486' : '#1e1e1f') : (dark ? '#e4e4e7' : '#343436'),
    // Leave the last CSS pixel for the continuous title-bar divider.
    height: MAIN_WINDOW_CHROME_HEIGHT - 1,
  };
}

function syncMainWindowChromeAppearance(win, appearance = mainWindowChromeAppearances.get(win)) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return false;
  const resolved = appearance || { dark: nativeTheme.shouldUseDarkColors, searchOpen: false };
  // An acrylic backdrop can disappear during cross-display/DPI transitions,
  // even in a floating window. Always paint a complete themed surface rather
  // than relying on DWM recovery or repainting on every move/resize event.
  try {
    win.setBackgroundColor(resolved.dark ? '#1a1a1a' : '#fafafa');
    win.setTitleBarOverlay(mainWindowTitleBarOverlay(resolved.dark, resolved.searchOpen));
    mainWindowChromeAppearances.set(win, resolved);
    return true;
  } catch (_) { return false; }
}

// Only the main window can preview its resolved light/dark caption colors.
// Native minimize/maximize/close buttons remain owned by Electron/Windows.
function updateMainWindowChromeTheme(event, theme, searchOpen = false) {
  const win = mainWindow;
  if (process.platform !== 'win32' || !win || win.isDestroyed()
    || !event || event.sender !== win.webContents
    || event.senderFrame !== win.webContents.mainFrame
    || (theme !== 'light' && theme !== 'dark')
    || typeof searchOpen !== 'boolean') return false;
  return syncMainWindowChromeAppearance(win, { dark: theme === 'dark', searchOpen });
}
ipcMain.on('window-chrome:theme', updateMainWindowChromeTheme);

function createMainWindow({ showOnReady = true } = {}) {
  const a = readAppSettings();
  const theme = a.theme || 'light';
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme === 'dark' ? 'dark' : 'light';
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: mainWindowTitleBarOverlay(nativeTheme.shouldUseDarkColors),
    } : {}),
    title: 'Relay',                      // 标题栏显示应用名
    icon: currentAppIcon(),                      // 显式指定 Relay Dual Gate 图标,dev 模式也用,不再 fallback 到 Electron atom
    backgroundColor: bgColor,
    show: false,                         // 先不显示,等首屏内容画好(ready-to-show)再显,消除空壳/白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: process.platform === 'win32' ? [
        '--relay-window-chrome-overlay',
        `--relay-window-chrome-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`,
      ] : [],
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
    },
  });
  const entryFile = path.join(__dirname, 'renderer', 'index.html');
  win.relayContentReady = Promise.resolve(win.loadFile(entryFile));
  // Keep a handled readiness promise for the first-run handoff. A failed
  // renderer load must leave the welcome window available for retry.
  void win.relayContentReady.catch(error => logger.error('[renderer] load failed:', error.message));
  // 首帧就绪再显示并聚焦;托盘重开走的也是这条(reuse 时 ready-to-show 不重发,由 showMainWindow 直接 show)
  win.once('ready-to-show', () => {
    if (showOnReady) { win.show(); win.focus(); }
    scheduleStartupTaskLedgerRetention();
  });
  attachExternalLinkGuard(win, entryFile);
  // Electron 32 can miss a shell-only color change when the application color
  // stays unchanged. WM_SETTINGCHANGE also covers Windows custom theme modes.
  if (process.platform === 'win32') win.hookWindowMessage?.(0x001a, updateNativeBrandTheme);
  attachRendererConsoleLog(win, 'renderer');
  if (IS_DEV) win.webContents.openDevTools();
  win.setMenuBarVisibility(false);

  mainWindow = win;
  taskbarCompletionBadge.refresh();
  win.on('show', () => {
    syncMainWindowChromeAppearance(win);
    taskbarCompletionBadge.refresh();
  });
  createTray();   // 主窗口存在期间保证托盘可用

  // 点关闭按钮:不退出,而是隐藏到托盘(后台任务继续跑)。真正退出由托盘菜单/quitApp 置 isQuitting。
  win.on('close', (e) => {
    if (isQuitting) return;            // 放行真正的退出
    e.preventDefault();
    win.hide();
    if (!trayBalloonShown) {
      trayBalloonShown = true;
      // Windows 气泡提示;失败(部分系统不支持)忽略即可
      try {
        tray && tray.displayBalloon({
          icon: currentAppIcon() || undefined,
          title: 'Relay 仍在后台运行',
          content: '正在进行的任务会继续执行。点击托盘图标可重新打开，右键可彻底退出。',
        });
      } catch (_) {}
    }
  });
  win.on('closed', () => {
    interactionBroker.rejectWindow(win.id, { message: '窗口已关闭，等待中的操作已安全拒绝' });
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

// renderer 的 warning/error 级 console 输出也落主进程日志。渲染层异常以前只在 DevTools
//   可见,打包后无从排查 —— 「转圈不停」那类 bug 的现场(如 marked.parse 抛异常的回退日志)
//   就在这里。verbose/info 级不收,避免刷屏。
function attachRendererConsoleLog(win, name) {
  try {
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      // Electron 32 传位置参数(level 为 0-3 数字);新版本改为 e.level 字符串 —— 两种都兼容
      const lvl = typeof level === 'number' ? level
        : ({ verbose: 0, info: 1, warning: 2, error: 3 })[(e && e.level) || ''] ?? 1;
      if (lvl < 2) return;   // 0=verbose 1=info 2=warning 3=error
      const msg = String(typeof message === 'string' ? message : (e && e.message) || '').slice(0, 4000);
      const src = String(typeof sourceId === 'string' ? sourceId : (e && e.sourceId) || '');
      const ln = typeof line === 'number' ? line : (e && e.line) || 0;
      const where = src ? ` (${path.basename(src)}:${ln})` : '';
      (lvl >= 3 ? logger.error : logger.warn)(`[${name}]`, msg + where);
    });
  } catch (_) {}
}

// Web links honor the saved browser destination, including legacy shell calls
// from the mini window. Never navigate the application document itself.
async function openConfiguredWebLink(url) {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow({ showOnReady: false });
  const target = mainWindow;
  await target.relayContentReady;
  if (target !== mainWindow || target.isDestroyed()) throw Error('浏览器页面尚未就绪，请重试');
  const response = await browserPanelTools.openLink(url);
  if (!response || response.ok === false) throw Error(response?.error || '无法打开链接');
  if (response.tab) showMainWindow();
  return response;
}

// Keep the native navigation fallback consistent with ordinary Markdown clicks.
function attachExternalLinkGuard(win, entryFile) {
  require('./local-preview-guard').attachLocalPreviewGuard(win.webContents);
  const allowedLocalUrl = entryFile ? pathToFileURL(entryFile).href.replace(/[?#].*$/, '') : '';
  const openExternalSafe = (url) => {
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
    const open = win === mainWindow && /^https?:\/\//i.test(url)
      ? () => openConfiguredWebLink(url) : () => shell.openExternal(url);
    void Promise.resolve().then(open).catch(error => logger.warn('[browser] 无法打开链接:', error.message));
  };
  // target="_blank" / window.open
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // 普通 <a> 点击触发的整页导航：只放行该窗口自己的入口页面。
  // 不能笼统放行 file://，否则 Markdown 相对链接会被解析到 renderer 目录，
  // 再用一个不存在的 .md 文件替换整套应用，最终只剩 ERR_FILE_NOT_FOUND 白屏。
  win.webContents.on('will-navigate', (e, url) => {
    const localBase = String(url || '').replace(/[?#].*$/, '');
    if (allowedLocalUrl && localBase === allowedLocalUrl) return;
    e.preventDefault();
    openExternalSafe(url);
  });
}

// 创建首次设置向导窗口
function createWizardWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Relay',                      // 标题栏显示应用名(页面 <title> 会进一步覆盖为「首次设置 - Relay」)
    icon: currentAppIcon(),
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
    },
  });
  const entryFile = path.join(__dirname, 'installer', 'wizard.html');
  win.loadFile(entryFile);
  attachExternalLinkGuard(win, entryFile);
  attachRendererConsoleLog(win, 'wizard');
  win.setMenuBarVisibility(false);
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

let cachedRelayGitBashPath;
function relayGitBashPath() {
  if (cachedRelayGitBashPath !== undefined) return cachedRelayGitBashPath;
  const legacy = readLegacyClaudeSettings();
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    legacy && legacy.env && legacy.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(os.tmpdir(), 'relay-gitbash.txt'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = candidate.endsWith('.txt') ? fs.readFileSync(candidate, 'utf8').trim() : candidate;
      if (value && fs.existsSync(value)) {
        cachedRelayGitBashPath = value;
        return value;
      }
    } catch (_) {}
  }
  cachedRelayGitBashPath = '';
  return '';
}

const RELAY_MODEL_TIERS = new Set(['haiku', 'sonnet', 'opus']);

function relayModelTier(value = '') {
  const requested = String(value || '').trim();
  if (RELAY_MODEL_TIERS.has(requested)) return requested;
  const routes = providerStore.getRoutingView().chatRoutes || [];
  const matched = routes.find((route) => route && route.configured && route.modelId === requested);
  return matched ? matched.tier : providerStore.getRoutingView().defaultModel;
}

function activeRelayProviderRuntime({ required = true, tier = '', fallback = false } = {}) {
  const requestedTier = relayModelTier(tier);
  let runtime = providerStore.getChatRuntime(requestedTier);
  if (!runtime && fallback) runtime = providerStore.getActiveRuntime();
  if (!runtime) {
    if (required) {
      const labels = { haiku: '快速', sonnet: '思考', opus: '专家' };
      throw new Error(`${labels[requestedTier] || '当前'}档位尚未配置可用模型，请前往“设置 → 服务商”分配模型路由`);
    }
    return null;
  }
  const env = { ...runtime.env };
  const gitBash = relayGitBashPath();
  if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  const agentEnvironment = readAppSettings().agentEnvironment === 'wsl' ? 'wsl' : 'native';
  env.RELAY_AGENT_ENVIRONMENT = agentEnvironment;
  return { ...runtime, env, agentEnvironment };
}

function providerSessionRoute(runtime, tier = '') {
  if (!runtime || !runtime.id) return null;
  const routeTier = relayModelTier(tier || runtime.tier || runtime.defaultModel);
  return {
    providerId: runtime.id,
    providerRevision: Number(runtime.revision) || 0,
    agentEnvironment: runtime.agentEnvironment === 'wsl' ? 'wsl' : 'native',
    routeTier,
  };
}

function sessionRouteMatchesProvider(candidate, target) {
  return !!(candidate && candidate.providerId && target && target.providerId
    && RELAY_MODEL_TIERS.has(candidate.routeTier) && RELAY_MODEL_TIERS.has(target.routeTier)
    && candidate.providerId === target.providerId
    && Number(candidate.providerRevision || 0) === Number(target.providerRevision || 0)
    && candidate.routeTier === target.routeTier
    && (candidate.agentEnvironment || 'native') === (target.agentEnvironment || 'native'));
}

function publishProviderChange(reason, { runtimeChanged = false } = {}) {
  if (runtimeChanged) {
    supportedModelsCache.clear();
    // 已经开始执行的任务继续使用自己的配置快照；仅回收空闲会话。
    for (const sess of [...liveSessions.values()]) {
      if (!sess.busy) killLiveSession(sess, `Relay 服务商已${reason}`);
    }
  }
  try { refreshTrayMenu(); } catch (error) { console.warn('[provider] 刷新托盘失败: %s', error.message); }
  const payload = {
    reason,
    runtimeChanged,
    active: providerStore.getSettingsView(),
    profiles: providerStore.listProfiles(),
    routes: providerStore.getRoutingView(),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('providers:changed', payload); } catch (_) {}
  }
  return payload;
}

function relayProviderConfigured() {
  try { return !!activeRelayProviderRuntime({ required: false }); }
  catch (error) {
    console.warn('[provider] 初始化失败: %s', error.message);
    return false;
  }
}

function relaySetupCompleted() {
  const settings = readAppSettings();
  if (Number(settings.firstRunSetupVersion) >= FIRST_RUN_SETUP_VERSION) return true;
  // 已使用过 Relay 私有服务商的老用户直接迁移完成标记，避免升级后再次看到首次向导。
  if (!relayProviderConfigured()) return false;
  settings.firstRunSetupVersion = FIRST_RUN_SETUP_VERSION;
  try { writeAppSettings(settings); }
  catch (error) { console.warn('[startup] 首次设置标记迁移失败: %s', error.message); }
  return true;
}

// 启动时判断:走欢迎页还是主 UI?
//   Claude SDK、Node 运行时和平台可执行文件均随 Relay 打包。首次启动不再安装或修改
//   Git / Node / MCP 等系统环境；服务商及可选能力均在进入应用后按需配置。
async function decideStartup() {
  const setupOk = relaySetupCompleted();
  console.log('[startup] setupOk=%s providerOk=%s autostart=%s', setupOk, relayProviderConfigured(), IS_AUTOSTART);
  if (setupOk) {
    if (IS_AUTOSTART) {
      // 开机自启:不弹主窗,仅建托盘让调度器在后台跑定时任务;用户点托盘再开窗。
      createTray();
      if (!trayBalloonShown) {
        trayBalloonShown = true;
        try { tray && tray.displayBalloon({ icon: currentAppIcon() || undefined, title: 'Relay 正在后台运行', content: '定时任务已就绪。点击托盘图标可打开主界面。' }); } catch (e) { console.warn('[tray] displayBalloon 失败: %s', e.message); }
      }
    } else {
      createMainWindow();
    }
  } else {
    createWizardWindow();
  }
}

// Commit first-run state only after the main page loads. Duplicate requests
// share the same handoff; a failure closes only its incomplete main window.
const wizardHandoffs = new WeakMap();
ipcMain.handle('wizard:complete', (event) => {
  const wizard = BrowserWindow.fromWebContents(event.sender);
  const expected = pathToFileURL(path.join(__dirname, 'installer', 'wizard.html')).href;
  if (!wizard || wizard.isDestroyed() || event.sender.getURL().split(/[?#]/)[0] !== expected) {
    return { ok: false, message: '请从首次设置窗口进入 Relay。' };
  }
  if (wizardHandoffs.has(wizard)) return wizardHandoffs.get(wizard);
  const handoff = Promise.resolve().then(async () => {
    let next;
    try {
      next = createMainWindow({ showOnReady: false });
      await next.relayContentReady;
      if (next.isDestroyed()) throw new Error('主窗口已关闭，请重试。');
      if (wizard.isDestroyed()) throw new Error('首次设置窗口已关闭。');
      const settings = readAppSettings();
      settings.firstRunSetupVersion = FIRST_RUN_SETUP_VERSION;
      writeAppSettings(settings);
      if (!wizard.isDestroyed()) wizard.close();
      next.show(); next.focus();
      return { ok: true };
    } catch (error) {
      if (next && !next.isDestroyed()) next.destroy();
      if (!wizard.isDestroyed()) { wizard.show(); wizard.focus(); }
      return { ok: false, message: error.message || '无法进入 Relay，请重试。' };
    }
  }).finally(() => wizardHandoffs.delete(wizard));
  wizardHandoffs.set(wizard, handoff);
  return handoff;
});

// ─────────────────────────────────────────
// 对话内管理定时任务:cron MCP
// ─────────────────────────────────────────
//   工具实现在 cron-mcp.js，以【进程内 MCP server】形式挂载（见 cronMcpFactory）。
//   原来它是独立的 stdio server 脚本（cron-mcp-server.js），每个会话都要 spawn 一个
//   Electron 子进程去跑、还要写临时 MCP 配置文件；改成进程内后子进程、临时文件、
//   以及那套手写的 JSON-RPC 主循环一并消失。
// 渲染层快筛词的后端镜像:判断这轮 prompt 是否「可能涉及定时任务」（只有这时才挂 cron MCP，避免每轮都挂）。
// 判断本轮是否「可能涉及定时任务」——命中才挂 cron MCP。
//   两类要覆盖：① 明确的定时任务词（定时任务/cron/每天…）；
//   ② 对话续接里的【管理动词 + 任务/它/第N个】这种口语（如「删掉那个任务」「暂停第一个」「立即运行它」），
//      这类不含「定时」二字，但在管理定时任务的上下文里极常见——之前漏了它们导致续接轮 cron 没挂、删除失败。
const CRON_HINT_RE = /定时任务|定时|计划任务|任务列表|我的任务|哪些任务|提醒我|定期|每天|每周|每月|每隔|cron|schedule|(删除|删掉|移除|取消|暂停|停用|禁用|启用|开启|恢复|修改|更改|改成|改为|编辑|运行|执行|触发|查看|列出|列举).{0,6}(任务|它|他|这个|那个|第[一二三四五六七八九十\d]+个?)/i;
function promptMaybeCron(text) { return typeof text === 'string' && CRON_HINT_RE.test(text); }

// cron MCP 现在是【进程内】托管（见 cron-mcp.js）。
//   构造它需要 SDK 本身（createSdkMcpServer / tool），而 SDK 是异步加载的 ESM，
//   所以这里只返回一个工厂，由 claude-sdk.js 在拿到 sdk 后调用。
//   这样也顺带去掉了原来的临时配置文件与它的清理逻辑。
function cronMcpFactory() {
  const userDataDir = app.getPath('userData');
  return (sdk) => {
    try {
      const { createCronMcpServer } = require('./cron-mcp');
      return {
        'relay-cron': createCronMcpServer({
          createSdkMcpServer: sdk.createSdkMcpServer,
          tool: sdk.tool,
          z: require('zod').z,
          userDataDir,
        }),
      };
    } catch (e) {
      console.error('[cron-mcp] 进程内 server 构造失败(本轮不挂载): %s', e.message);
      return null;
    }
  };
}

// 组装交给 claude-sdk.js 的调用参数。一次性任务(runClaudeJob)与常驻会话(LiveSession)共用，
//   保证两条路行为完全一致 —— 这正是原来 buildClaudeArgs 的职责，只是产物从 argv 数组
//   变成了 SDK 的 options 对象（授权目录/模型档位/权限模式/MCP 的语义逐项对应）。
//
//   注：cron MCP 用【合并】语义挂载（不设 strictMcpConfig）——飞书及用户导入的其它 MCP 照常可用。
//   不能 strict：否则会屏蔽用户导入的所有其它 MCP，那一轮就只剩 cron。
function sdkProjectContext(input = {}) {
  const store = getProjectStore();
  const project = input.conversationId ? store.resolve(input.conversationId) : input.projectId ? store.get(input.projectId) : null;
  return project ? { id: project.id, name: project.name, path: project.path } : null;
}
function conversationRuntimeContract({ convId, cwd, mode, agentName, model, effort, agentProjectRoot, projectContext, providerRuntime } = {}) {
  const project = projectContext === undefined ? sdkProjectContext({ conversationId: convId }) : projectContext;
  const settings = readAppSettings();
  const policy = buildRuntimePolicy({ settings, cwd, projectId: project?.id, projectRoot: project?.path,
    memoryDir: MEMORY_DIR, environment: normalizePreferences(settings).agentEnvironment, mapPath: toWslPath });
  const modelCapability = typeof getProviderModelCatalog === 'function'
    ? getProviderModelCatalog(providerRuntime).find(info => info.value === model || info.resolvedModel === model) : null;
  if (policy.options.thinking?.type === 'adaptive' && modelCapability?.supportsAdaptiveThinking === false) {
    throw Error('当前模型不支持自适应思考，请在常规设置的高级运行选项中选择模型默认。');
  }
  const pluginRuntime = getSdkPluginStore().runtime();
  if (pluginRuntime.plugins.length || Object.keys(pluginRuntime.settings.enabledPlugins).length) {
    Object.assign(policy.settings, pluginRuntime.settings);
    policy.fingerprint = crypto.createHash('sha256').update(policy.fingerprint + pluginRuntime.fingerprint).digest('hex');
  }
  const agentRoute = providerRuntime;
  const nativeAgent = mode === 'agent' && agentName ? loadNativeAgent({ agentsDir: AGENTS_DIR,
    agentName, selectedModel: model, effort, modelMap: agentRoute?.models || {},
    allowedModels: Object.values(agentRoute?.models || {}).filter(Boolean),
    modelCapabilities: typeof getProviderModelCatalog === 'function' ? getProviderModelCatalog(agentRoute) : [],
    mcpServerNames: Object.keys(readClaudeMcpRegistry().enabled || {}),
    inheritedDisallowedTools: policy.options?.disallowedTools || [],
    resourceRoot: agentProjectRoot && normalizePreferences(settings).agentEnvironment === 'wsl' ? toWslPath(agentProjectRoot) : agentProjectRoot,
    parentInstructions: '遵循 Relay 当前会话的权限与计划模式限制；用户在执行过程中补充的要求属于同一任务。' }) : null;
  const scratchDir = convId ? getConversationWorkspaces().resolveScratch(convId) : null;
  policy.fingerprint = crypto.createHash('sha256').update(policy.fingerprint + ':relay-memory-v2:file-locations-v2').digest('hex');
  const fingerprints = contractFingerprints(policy, nativeAgent, { cwd,
    configDir: path.join(os.homedir(), '.claude'), settingSources: policy.settingSources });
  const contract = { policy, nativeAgent, ...fingerprints, scratchDir, plugins: pluginRuntime.plugins, projectId: project?.id || null };
  if (convId) migrateConversationRuntimeContract(convId, cwd, contract);
  return contract;
}
function migrateConversationRuntimeContract(convId, cwd, contract) {
  const saved = loadConversation(convId), migrated = migrateLegacyRuntimeContract(saved, contract);
  if (!migrated) return false;
  // Persist the exact proof before updating resident bookkeeping. This never
  // changes native handles, task content, clear boundaries or history ordering.
  persistConversationRecord(migrated);
  const previous = saved.sdkRuntimeFingerprint;
  const live = liveSessions.get(convId);
  if (live?.convId === convId && live.launchSpec?.runtimeFingerprint === previous
      && workspaceKey(live.launchSpec.cwd) === workspaceKey(cwd)) {
    live.launchSpec.runtimeFingerprint = contract.fingerprint;
    live.launchSpec.runtimeFingerprintVersion = RUNTIME_FINGERPRINT_VERSION;
    if (live.runtimeContract) live.runtimeContract = { ...live.runtimeContract, fingerprint: contract.fingerprint,
      fingerprintVersion: RUNTIME_FINGERPRINT_VERSION };
    live.fingerprint = sessionFingerprint(live.launchSpec);
  }
  const tomb = liveTombstones.get(convId);
  if (tomb?.runtimeFingerprint === previous && workspaceKey(tomb.cwd) === workspaceKey(cwd)) {
    tomb.runtimeFingerprint = contract.fingerprint;
  }
  return true;
}
function makeSdkDiagnostics() {
  return createRuntimeDiagnostics({ resolveSettings: async options => (await claudeSdk.loadSdk()).resolveSettings(options),
    filterEscalatingDefaultMode: async result => (await claudeSdk.loadSdk()).filterEscalatingDefaultMode(result) });
}

function buildSdkParams({
  cwd, validWorkingDir, agentProjectRoot, conversationId, model, effort, sessionId, attachCronMcp,
  canUseTool, background = false, permissionMode = null, enableFileCheckpointing = false,
  includeMemoryDirectory = true, memoryContext, tools, providerRuntime = null, runtimeContract = null, onElicitation, onInstructionsLoaded, stderr, onUserDialog, supportedDialogKinds, onNativeHook,
}) {
  // Relay 的受控记忆工具负责文件管理，不再把目录作为 SDK 原始读写授权。
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch (_) {}
  const runtime = providerRuntime || activeRelayProviderRuntime();
  const effectivePermissionMode = background
    ? resolveUnattendedPermissionMode(permissionMode)
    : (isConversationPermissionMode(permissionMode) || permissionMode === 'plan' ? permissionMode : 'default');
  const memory = createMemoryRuntime({ store: relayMemoryStore,
    isCore: file => !!readMemoryUsage()[file]?.pinned,
    context: () => ({ cwd: cwd || validWorkingDir || os.homedir(), projectId: runtimeContract?.projectId || null,
      mode: includeMemoryDirectory ? (background ? 'read' : 'full') : 'off',
      ...(typeof memoryContext === 'function' ? memoryContext() : memoryContext || {}) }),
    onChanged: () => { rebuildMemoryIndex(); notifySkillUsageUpdated({ reason: 'memory-updated' }); },
    onRead: file => { const usage = readMemoryUsage(); const rec = usage[file] || {};
      rec.managedReadCount = (Number(rec.managedReadCount) || 0) + 1; rec.managedLastReadAt = new Date().toISOString();
      usage[file] = rec; flushMemoryUsage(); },
  });
  const cron = attachCronMcp ? cronMcpFactory() : null;
  return {
    memoryDir: null,
    onMemoryTool: memory.hook,
    validWorkingDir,
    agentProjectRoot,
    model: runtime.modelId || model,
    effort,
    sessionId,
    // 前台会话按该对话的权限快照走 Relay 审批卡；scheduler 会为用户已保存/启用的普通
    // 定时任务显式传 bypassPermissions。其它后台调用若遗漏声明则安全回退 default；
    // 内置受限任务仍可显式传 default + canUseTool 守卫。
    permissionMode: effectivePermissionMode,
    canUseTool: typeof canUseTool === 'function' ? canUseTool : null,
    disallowAskUserQuestion: background,
    enableFileCheckpointing: !background && !!enableFileCheckpointing,
    tools,
    scratchDir: runtimeContract?.scratchDir || (conversationId ? getConversationWorkspaces().resolveScratch(conversationId) : null),
    runtimeEnv: getSdkRuntimeStorage().apply(runtime.env),
    runtimePolicy: runtimeContract?.policy || buildRuntimePolicy({ settings: readAppSettings(), cwd: validWorkingDir, memoryDir: MEMORY_DIR,
      environment: runtime.agentEnvironment || 'native', mapPath: toWslPath }),
    nativeAgent: runtimeContract?.nativeAgent,
    plugins: runtimeContract?.plugins,
    onElicitation, onInstructionsLoaded, stderr, onUserDialog, supportedDialogKinds, onNativeHook,
    // Snapshot also covers one-shot history fallback; live turns resync before input.
    mcpServers: Array.isArray(tools) && tools.length === 0 ? {} : (readClaudeMcpRegistry().enabled || {}),
    mcpPermissionOverrides: Array.isArray(tools) && tools.length === 0 ? {} : (readAppSettings().mcpPermissionOverrides || {}),
    mcpServersFactory: sdk => ({ ...(cron ? cron(sdk) : {}),
      ...(includeMemoryDirectory && !(Array.isArray(tools) && tools.length === 0) ? memory.factory(sdk) : {}) }),
  };
}

function runRelayText(options) {
  const runtime = activeRelayProviderRuntime({ tier: options && options.model, fallback: true });
  return claudeSdk.runText({ tools: [], ...options, model: runtime.modelId, runtimeEnv: getSdkRuntimeStorage().apply(runtime.env),
    runtimePolicy: buildRuntimePolicy({ settings: readAppSettings(), memoryDir: MEMORY_DIR,
      environment: runtime.agentEnvironment || 'native', mapPath: toWslPath }),
    onUsage: record => recordRelayUsage(record, 'background') });
}

// ─────────────────────────────────────────
// 一次性执行核心:经 claude-agent-sdk 跑一轮,事件经 onEvent 回调发出。
//   现在只服务【定时任务调度器】和【无 convId 的兼容回退】—— 交互对话已改走常驻会话池
//   (见 LiveSession)。定时任务是一次性负载,跑完就退,常驻对它没有意义。
//   入参均为「已算好的最终值」:prompt 已拼好所有 hint/记忆;cwd/授权目录/model/sessionId 由调用方决定。
//   返回 { jobId, child }。child 是鸭子类型的句柄(只有 .pid/.kill()),
//   与原来的 ChildProcess 在调用点上等价,jobs map 与 claude:abort 因此无需改动。
//   完成由 onEvent 的 'job-done' 事件通知（不等 Promise）。
// ─────────────────────────────────────────
function runClaudeJob({
  prompt, files, cwd, validWorkingDir, agentProjectRoot, model, effort, sessionId, onEvent,
  attachCronMcp, runId, background = false, conversationId = null, userMessageId = null,
  includeMemoryDirectory = true, memoryMode, memoryContext, tools, canUseTool: suppliedCanUseTool = null,
  permissionMode = null, sessionRoute = null, runtimeContract = null,
  taskStartedAt, taskRun,
}) {
  const taskClock = new TaskClock({ startedAt: taskStartedAt, taskRun });
  const jobId = runId || crypto.randomUUID();
  const storedFork = conversationId && loadConversation(conversationId);
  if (sessionId && storedFork?.forkedFrom) sessionId = storedFork.sessionId || null;
  // 一次性任务在启动时固定供应商快照；执行中修改设置不会改变它。
  const providerRuntime = activeRelayProviderRuntime({ tier: model });
  runtimeContract ||= conversationRuntimeContract({ convId: conversationId, cwd, model: providerRuntime.modelId, effort,
    agentProjectRoot, providerRuntime });
  const targetSessionRoute = providerSessionRoute(providerRuntime, providerRuntime.tier || model);
  // Claude session_id 只能回到创建它的 Base URL/认证/模型路由。旧版本没有保存
  // 服务商指纹的 session 一律按新会话启动；Relay 历史文本负责保持对话连续性。
  const contractChanged = !!sessionId && requiresFreshContract(storedFork, runtimeContract.fingerprint);
  if (contractChanged && !String(prompt || '').includes('以下是我们之前的对话记录，供你参考延续：')) {
    const context = conversationContext(storedFork); if (context) prompt = `${context}\n\n${prompt || ''}`;
  }
  const resumeAccepted = !!sessionId && !contractChanged && sessionRouteMatchesProvider(sessionRoute, targetSessionRoute);
  const safeSessionId = resumeAccepted ? sessionId : null;
  const nativeFork = conversationId ? pendingForkOptions(loadConversation(conversationId), safeSessionId) : {};
  const provenance = { sessionId: safeSessionId, jobId, launchSpec: { cwd, agentEnvironment: providerRuntime.agentEnvironment || 'native',
    projectId: runtimeContract?.projectId || null,
    providerId: providerRuntime.id, providerRevision: providerRuntime.revision, routeTier: providerRuntime.tier || model,
    model: providerRuntime.modelId, effort, runtimeFingerprint: runtimeContract?.fingerprint,
    runtimeFingerprintVersion: runtimeContract?.fingerprintVersion } };
  const emit = (evt) => { try { onEvent(taskClock.stamp({ jobId, ...evt })); } catch (e) { console.error('[claude] emit 失败: %s type=%s', e.message, evt && evt.type); } };
  const canUseTool = typeof suppliedCanUseTool === 'function'
    ? suppliedCanUseTool
    : (background ? null : interactionBroker.createCanUseTool(() => ({
      runId: jobId,
      conversationId,
      windowId: miniInteractionWindowId(jobId),
      source: 'conversation',
    })));

  const { handle } = claudeSdk.runOneShot({
    prompt, files,
    taskStartedAt: taskClock.startedAt, taskRun,
    cwd,
    ...nativeFork,
    onRuntimePrepared: info => { provenance.launchSpec.runtimeCwd = info.cwd; provenance.launchSpec.wslDistribution = info.wslDistribution; },
    userMessageId: userMessageId || (!background ? jobId : null),
    onUsage: record => recordRelayUsage(record, background ? 'scheduled' : 'conversation', conversationId),
    ...buildSdkParams({
      cwd, validWorkingDir, agentProjectRoot, conversationId, model: providerRuntime.modelId, effort, sessionId: safeSessionId, attachCronMcp,
      canUseTool, background, permissionMode, enableFileCheckpointing: !background,
      includeMemoryDirectory, tools, providerRuntime, runtimeContract,
      memoryContext: { ...memoryRequestContexts.get(jobId), projectId: sdkProjectContext({ conversationId })?.id || null,
        sourceRef: 'conversation:' + (conversationId || 'background') + '/run:' + jobId,
        mode: memoryMode || (includeMemoryDirectory ? (background ? 'read' : 'full') : 'off'), ...(memoryContext || {}) },
      onElicitation: background ? undefined : interactionBroker.createOnElicitation(() => ({ runId: jobId, conversationId,
        windowId: miniInteractionWindowId(jobId), source: 'conversation' })),
    }),
    onEvent: (evt) => {
      if (conversationId && TaskClock.isRootEvent(evt)) {
        if (evt.type === 'system' && evt.subtype === 'init') provenance.sessionId = evt.session_id;
        if (evt.type === 'conversation_reset') provenance.sessionId = evt.new_conversation_id;
        observeProvenance(provenance, evt);
        if (evt.type === 'result' || evt.type === 'system' && evt.subtype === 'init') {
          const record = loadConversation(conversationId);
          if (applyProvenance(record, provenance, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
            { complete: evt.type === 'result' && !evt.is_error && evt.subtype === 'success' })) persistConversationRecord(record);
        }
      }
      if (evt?.subtype === 'elicitation_complete') interactionBroker.completeElicitation(evt, { runId: jobId, conversationId, windowId: miniInteractionWindowId(jobId) });
      if (evt && evt.type === 'job-done' && TaskClock.isRootEvent(evt)) {
        console.log('[claude] done jobId=%s exitCode=%s', jobId, evt.exitCode);
        interactionBroker.rejectTask(jobId, { message: evt.error || '执行会话已经结束', interrupt: false });
        jobs.delete(jobId);
        refreshTrayMenu();
      }
      emit(evt);
    },
  });

  console.log('[claude] run jobId=%s cwd=%s model=%s sessionId=%s cronMcp=%s prompt=%s',
    jobId, cwd, model || '(default)', safeSessionId || '(new)', !!attachCronMcp,
    (prompt || '').slice(0, 120).replace(/\n/g, '↵'));
  jobs.set(jobId, handle);
  refreshTrayMenu();

  return {
    jobId,
    child: handle,
    ...taskClock.snapshot(),
    providerId: providerRuntime.id,
    providerRevision: providerRuntime.revision,
    agentEnvironment: providerRuntime.agentEnvironment || 'native',
    routeTier: providerRuntime.tier,
    routeRevision: providerRuntime.routeRevision,
    sessionRoute: targetSessionRoute,
    resumeAccepted,
  };
}

// ═════════════════════════════════════════
// 常驻会话池（交互对话专用）
// ═════════════════════════════════════════
//
// 为什么要有它：Relay 原本用 `-p`（为一次性脚本设计的 headless 模式）跑交互式聊天 —— 每轮新起
//   一个 claude.exe，于是【每一轮都要重启一遍用户配置的所有 MCP server】。而 claude 默认是
//   非阻塞连 MCP：实测 init 事件在 2.67s 就发出、此时 mcp_servers 全是 pending、工具列表里飞书
//   0 个 —— 模型开局看到的是一个「没有飞书工具」的世界，于是理性地去抓网页，撞登录墙。
//   FEISHU_HINT 那套 prompt 提示，本质是在【求模型配合】绕开这个行为，而不是修好它。
//
// 解法：一个对话 = 一个常驻 claude 进程（`--input-format stream-json`，prompt 逐轮走 stdin）。
//   MCP 只在进程起来时连一次，之后整个会话里一直挂着 —— 这正是 CLI 的模型。实测：
//     · 第 2/3 轮 init 零延迟、111 个工具全在，上下文完整保留
//     · MCP 在 spawn 时就开始连（空等 12s 再发首条消息 → init 0.04s 返回、全 connected）
//       故对话打开即预启动（prespawnSession），用用户打字的时间盖掉 MCP 启动
//
// 为什么【不】用 MCP_CONNECTION_NONBLOCKING=0（曾认真考虑并撤回）：它能让 claude 等 MCP 连上
//   再开跑（实测 init 6.92s / 工具 111 / 飞书 50），但 ① 未文档化，claude 会自动升级，某天悄悄
//   消失就静默退回坏行为；② 对【未知用户配置】是无界等待 —— 别人配一个 hang 住或后端没启动的
//   MCP（本机 jadx-mcp-server 即是：claude mcp list 显示 Failed to connect），每轮都得白等它。
//   预启动只能降低等待，不能证明工具已就绪；发送前另走有上限的 MCP 同步与状态检查。
//
// 已知风险（实测）：MCP server 进程被杀后，claude 仍报 connected、工具列表照挂 —— 模型会调用
//   一个后端已不存在的「幽灵工具」。这是常驻方案引入的新问题（每轮新起进程反而没有）。
//   下面的 watchdog（记录 MCP 子进程 pid，每轮复用前校验存活）就是为它准备的。
const routeTimingHistory = new RouteTimingHistory();
const liveSessions = new Map();   // convId → LiveSession
const liveTurnControls = new LiveTurnControls({
  cancelPendingInput: cancelPendingLiveInput, settleUnsent: settleUnsentLiveTurn,
  withTimeout: withLiveControlTimeout, waitForIdle: waitForLiveTurnIdle, killSession: killLiveSession,
});
// 墓碑:常驻进程无论怎么死(中止/LRU/闲置/崩溃/watchdog 重启),都把它学到的 session_id 记下来,
//   下一轮据此 --resume 接回上下文。没有它,进程一死这个对话就断片了。
const liveTombstones = new Map(); // convId → { sessionId, at }
// 常驻会话与统一 Claude 资源池共用 maxParallelTasks；闲置会话继续按 LRU 与超时回收。
const LIVE_IDLE_MS = 30 * 60 * 1000;   // 闲置超时回收(实测 18min 闲置进程存活正常、内存无漂移)
const LIVE_CONTROL_TIMEOUT_MS = 10000;
const SDK_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const supportedModelsCache = new Map();

function withLiveControlTimeout(promise, label, timeoutMs = LIVE_CONTROL_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function refreshLivePluginCatalog(sess) {
  const revision = sess.catalogRevision = (sess.catalogRevision || 0) + 1;
  const result = await withLiveControlTimeout(sess.child.reloadPlugins(), '刷新运行时插件');
  if (sess.dead || liveSessions.get(sess.convId) !== sess || revision !== sess.catalogRevision) return { stale: true };
  // supportedAgents() is the cached initialize payload in SDK 0.3.266.
  // Only reloadPlugins().agents reflects the newly reloaded runtime catalog.
  const agents = Array.isArray(result.agents) ? result.agents : [];
  sess.supportedAgents = agents.map(({ name, description, model }) => ({ name, description, model }));
  if (sess.observer) {
    sess.observer.catalog.commands = (result.commands || []).map(item => item.name);
    sess.observer.catalog.agents = agents.map(item => item.name);
    sess.observer.catalog.plugins = (result.plugins || []).map(item => item.name);
    sess.observer.catalog.mcpServers = (result.mcpServers || []).map(item => ({ name: item.name, status: item.status }));
  }
  sess.supportedModels = null;
  await readSupportedModels(sess).catch(() => {});
  return { ok: !result.error_count, errorCount: result.error_count || 0 };
}
async function reloadSkillsInLiveSessions(reason) {
  const sessions = [...liveSessions.values()].filter(sess => sess && !sess.dead && sess.child);
  const settled = await Promise.allSettled(sessions.map(async sess => {
    await withLiveControlTimeout(sess.child.reloadSkills(), '刷新技能');
    return refreshLivePluginCatalog(sess);
  }));
  const failed = settled.filter(item => item.status === 'rejected' || item.value?.ok === false).length;
  return { requested: sessions.length, applied: sessions.length - failed, failed };
}


function publicModelInfo(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    value: String(model.value || ''),
    resolvedModel: model.resolvedModel ? String(model.resolvedModel) : null,
    displayName: String(model.displayName || model.value || ''),
    description: String(model.description || ''),
    supportsEffort: !!model.supportsEffort,
    supportedEffortLevels: Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((level) => SDK_EFFORT_LEVELS.has(level))
      : [],
    supportsAdaptiveThinking: !!model.supportsAdaptiveThinking,
    supportsFastMode: !!model.supportsFastMode,
    supportsAutoMode: !!model.supportsAutoMode,
  };
}

function getProviderModelCatalog(runtime) {
  if (!runtime?.id) return [];
  const prefix = `${runtime.id}:${runtime.revision || 0}:`;
  return [...supportedModelsCache].filter(([key]) => key.startsWith(prefix)).flatMap(([, models]) => models);
}

async function readSupportedModels(sess) {
  const cacheKey = sess && sess.launchSpec
    ? `${sess.launchSpec.providerId || ''}:${sess.launchSpec.providerRevision || 0}:${sess.launchSpec.routeTier || ''}`
    : '';
  const cached = cacheKey ? (supportedModelsCache.get(cacheKey) || []) : [];
  if (!sess || sess.dead || !sess.child) return cached;
  const models = await withLiveControlTimeout(sess.child.supportedModels(), '读取模型列表');
  const clean = (Array.isArray(models) ? models : []).map(publicModelInfo).filter((m) => m && m.value);
  if (clean.length) {
    sess.supportedModels = clean;
    if (cacheKey) supportedModelsCache.set(cacheKey, clean);
  }
  return clean.length ? clean : cached;
}

function compactContextUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  return {
    totalTokens: count(raw.totalTokens),
    maxTokens: count(raw.maxTokens),
    rawMaxTokens: count(raw.rawMaxTokens),
    percentage: count(raw.percentage),
    model: String(raw.model || ''),
    estimated: true,
    source: 'sdk-summary',
    sampledAt: raw.sampledAt || new Date().toISOString(),
    running: raw.running === true,
    categories: (Array.isArray(raw.categories) ? raw.categories : []).map((item) => ({
      name: String(item && item.name || ''),
      tokens: count(item && item.tokens),
      color: String(item && item.color || ''),
    })).filter((item) => item.name),
  };
}

function contextRuntimeKey(sess) {
  const spec = sess.launchSpec || {};
  return JSON.stringify([spec.model, spec.routeTier, spec.providerId, spec.providerRevision,
    spec.agentEnvironment, sess.fingerprint, sess.observer?.epoch || 0, sess.jobId || null, !!sess.busy]);
}

async function readLiveContextUsage(sess, { persist = true } = {}) {
  if (!sess || sess.dead || !sess.child) return null;
  const key = contextRuntimeKey(sess);
  const current = () => !sess.dead && liveSessions.get(sess.convId) === sess && contextRuntimeKey(sess) === key;
  if (!current()) return null;
  const sample = sess.nativeContextSample;
  if (sample?.key === key && Date.now() - sample.at < 2000) {
    if (persist && !sess.busy && !sample.persisted) { persistConversationContextUsage(sess.convId, sample.value); sample.persisted = true; }
    return sample.value;
  }
  const state = sess.contextUsageRead || (sess.contextUsageRead = { key: null, checkedAt: 0, value: null, pending: false });
  const result = () => {
    if (!current() || state.key !== key || !state.value) return null;
    if (persist && !sess.busy && state.persisted !== state.value) {
      state.value = persistConversationContextUsage(sess.convId, state.value) || state.value;
      state.persisted = state.value;
    }
    return state.value;
  };
  if (state.pending) {
    await state.wait;
    if (current() && !state.pending && state.key !== key) return readLiveContextUsage(sess, { persist });
    return result();
  }
  if (state.key === key && Date.now() - state.checkedAt < 2000) return result();
  if (state.key !== key) { state.value = null; state.persisted = null; }
  state.key = key; state.checkedAt = Date.now(); state.pending = true;
  // summary uses the last response usage and local estimates, without token-count API calls.
  // Keep the underlying request gate after a UI timeout: a stuck control must not accumulate.
  const operation = Promise.resolve().then(() => sess.child.getContextUsage({ detail: 'summary' })).then(raw => {
    if (current() && state.key === key) {
      state.value = compactContextUsage({ ...raw, running: !!sess.busy });
      state.persisted = null;
    }
  }).finally(() => { state.pending = false; });
  state.wait = withLiveControlTimeout(operation, '读取上下文占用', 4000).catch(() => null);
  await state.wait;
  return result();
}


// 本轮 spawn 时定死、变了就必须重启进程的参数。模型档/工作目录/agent 都在此列。
function sessionFingerprint({
  cwd, validWorkingDir, agentProjectRoot, model, effort, attachCronMcp,
  providerRuntime = null, providerId = null, providerRevision = null, agentEnvironment = 'native', runtimeFingerprint = null,
}) {
  return JSON.stringify([
    cwd || '', validWorkingDir || '', agentProjectRoot || '', model || '', effort || '', !!attachCronMcp,
    providerRuntime ? providerRuntime.id : (providerId || ''),
    providerRuntime ? providerRuntime.revision : (Number(providerRevision) || 0),
    providerRuntime ? providerRuntime.agentEnvironment || 'native' : agentEnvironment, runtimeFingerprint || '',
  ]);
}

// watchdog：记录该常驻进程的 MCP server pid，之后每轮复用前用 process.kill(pid, 0) 逐个校验存活
//   （纯 syscall，零成本；PowerShell 扫一次要几百 ms，故只拍一次快照，不能每轮跑）。
//
// 三个坑都是实测打脸打出来的，改之前先看数据，别凭直觉：
//   ① 只记【直接子进程】，不要整棵后代树。claude 为每个 MCP server spawn 一个直接子进程
//      （如 `cmd /c npx … feishu-mcp-pro`），它活多久 server 就活多久；而树里那些 npx/npm
//      引导进程【会正常退出】—— 实测子进程数 14 → 10 就是它们退了。记进来 = 下一轮必判「树塌」。
//   ② 只在【空闲时】拍。会话忙时模型可能在跑 Bash 等工具，那些也是直接子进程且跑完就退。
//   ③ 必须【等启动失败的 server 退干净】再拍 —— 这条最隐蔽。实测：连不上的 jadx（uv.exe）
//      在 T+20s 还在、T+45s 就自己退了。若按 T+8s 拍，它会被记进监控集，此后每轮误判重启。
//      而「配了但后端没启动的 MCP」恰恰是最常见的情况（本机 jadx 即是），这个误判会精准打中
//      最多的用户，且日志看起来一切正常 —— 常驻特性被静默废掉。故延到 SNAPSHOT_DELAY_MS。
//   误判的代价只是白重启一次（--resume 接回，上下文不丢），不出错；但会悄悄抵消收益，故要拍准。
const SNAPSHOT_DELAY_MS = 60000;   // 实测 45s 时失败的 server 已退干净，45s/75s 两次采样完全一致
function snapshotMcpChildren(sess) {
  if (!sess.child || sess.dead || sess.busy || sess.mcpPids) return;
  // 硬门槛:spawn 后不足 SNAPSHOT_DELAY_MS 一律不拍(坑③)。finishTurn 也会调本函数补拍 ——
  //   若首轮 20s 就结束,没这道闸就会把「正在失败、马上要退」的 server 记进监控集。
  if (Date.now() - sess.spawnedAt < SNAPSHOT_DELAY_MS) return;
  const rootPid = sess.child.pid;
  execFile('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`],
  { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    // 扫描期间这个会话开跑了 → 结果里可能混进工具进程,整个丢弃,等下次空闲再拍
    if (err || sess.dead || sess.busy || sess.mcpPids) return;
    try {
      const raw = JSON.parse(String(stdout || 'null'));
      if (!raw) return;                                   // 一个子进程都没有 → 没 MCP,不用看
      const list = Array.isArray(raw) ? raw : [raw];      // 单条时 ConvertTo-Json 返回对象而非数组
      const pids = list
        .filter((p) => p && p.ProcessId && !/^conhost\.exe$/i.test(p.Name || ''))   // conhost 是控制台宿主,不是 MCP
        .map((p) => p.ProcessId);
      if (!pids.length) return;
      sess.mcpPids = pids;
      console.log('[live] convId=%s pid=%d MCP server 快照(%ds 后): %d 个 %j',
        sess.convId, rootPid, SNAPSHOT_DELAY_MS / 1000, pids.length, pids);
    } catch (e) { console.warn('[live] MCP 快照解析失败: %s', e.message); }
  });
}
// 子进程树是否还完整。少一个就认为 MCP 塌了 —— 宁可重启（代价:一次 MCP 启动），
//   也不能让模型拿着幽灵工具去调用（代价:模型自信地失败,且极难排查）。
function mcpTreeIntact(sess) {
  if (!sess.mcpPids || !sess.mcpPids.length) return true;   // 还没取到快照 → 不拦
  for (const pid of sess.mcpPids) {
    try { process.kill(pid, 0); } catch (_) { return false; }
  }
  return true;
}

function killLiveSession(sess, why) {
  if (!sess) return Promise.resolve({ exitCode: null, error: null });
  cancelPendingLiveInput(sess);
  sess.dead = true;
  console.log('[live] 回收 convId=%s pid=%s 原因=%s', sess.convId, sess.child && sess.child.pid, why);
  if (sess.sessionId && sess.nativeContextReady !== false) liveTombstones.set(sess.convId, {
    sessionId: sess.sessionId,
    cwd: sess.launchSpec && sess.launchSpec.cwd || null,
    providerId: sess.launchSpec && sess.launchSpec.providerId || null,
    providerRevision: sess.launchSpec && sess.launchSpec.providerRevision || 0,
    agentEnvironment: sess.launchSpec && sess.launchSpec.agentEnvironment || 'native',
    routeTier: sess.launchSpec && sess.launchSpec.routeTier || null,
    at: Date.now(),
  });
  if (sess.jobId) interactionBroker.rejectTask(sess.jobId, { message: why || '任务执行会话已经结束' });
  // SDK 侧的 kill 先关输入走优雅退出(stdin EOF + ~2s 宽限,让 claude 把 session 落盘),
  //   再 abort 兜底 —— 与原来「先 stdin.end() 再 SIGTERM」的两段式一致。
  let closed = Promise.resolve({ exitCode: null, error: null });
  let stopConfirmed = true;
  try {
    const pending = sess.child && sess.child.kill();
    if (pending && typeof pending.then === 'function') closed = pending;
    else if (sess.child && typeof sess.child.whenClosed === 'function') closed = sess.child.whenClosed();
  } catch (error) {
    stopConfirmed = false;
    console.warn('[live] 回收请求失败 convId=%s: %s', sess.convId, error.message);
  }
  if (checkpointManager && sess.checkpointRunIds) {
    for (const runId of sess.checkpointRunIds) {
      try { markCheckpointUnavailable(runId, why || '执行会话已经结束'); } catch (_) {}
    }
    sess.checkpointRunIds.clear();
  }
  if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
  if (liveSessions.get(sess.convId) === sess) liveSessions.delete(sess.convId);
  refreshTrayMenu();
  return Promise.resolve(closed).then((result) => ({ ...(result || {}), stopConfirmed }));
}

// 只回收闲置会话；降低上限后在跑的会话可以暂时超额，后续启动等待腾位。
function evictIfNeeded(reserve = 1) {
  if (maxParallelTasks === 0) return true;
  while (liveSessions.size + reserve > maxParallelTasks) {
    let victim = null;
    for (const sess of liveSessions.values()) {
      if (sess.busy) continue;
      if (!victim || sess.lastUsedAt < victim.lastUsedAt) victim = sess;
    }
    if (!victim) return false;
    killLiveSession(victim, 'LRU 腾位');
  }
  return true;
}

function applyParallelTaskLimit(value) {
  maxParallelTasks = normalizePreferences({ maxParallelTasks: value }).maxParallelTasks;
  evictIfNeeded(0);
  if (taskOrchestrator) taskOrchestrator.setPoolLimits({ claude: maxParallelTasks });
}

function touchIdleTimer(sess) {
  // A reduced limit can temporarily be exceeded by busy sessions. Reclaim their
  // warm slots only after turn finalization, and recheck busy state in the LRU helper.
  if (!sess.busy && maxParallelTasks !== 0 && liveSessions.size > maxParallelTasks) {
    const trim = setImmediate(() => evictIfNeeded(0));
    if (trim.unref) trim.unref();
  }
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  sess.idleTimer = setTimeout(() => {
    if (!sess.busy) killLiveSession(sess, '闲置超时');
  }, LIVE_IDLE_MS);
  if (sess.idleTimer.unref) sess.idleTimer.unref();
}

// Claude Code 2.1.2xx 起，Agent 工具会把并行子智能体作为后台任务启动：
//   ① 首个 tool_result 只是 async_launched 元数据；
//   ② PM 随即产生一次 result（阶段性“等待中”）；
//   ③ 子智能体完成后，CLI 再自动注入 <task-notification> 并开启后续 PM 回合。
// 任何交互模式都可能自主调用 Agent。若在步骤②看到 result 就清掉 onEvent，
// 后续真实产出虽写进 Claude transcript，却再也到不了 Relay。这里统一跟踪后台 Agent，
// 只在没有待完成 Agent 的 result 上结束这一轮；协奏模式另外启用“虚假等待”纠偏。
// 注意：SDK 的 task_started 同时覆盖 Bash 与 Agent，不能把所有 task 都当成 Agent。
// 分类、边沿配对及 background_tasks_changed 的全量对账统一封装在 LiveAsyncAgentTracker。

function orchestrateResultClaimsBackgroundWait(text) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const actor = '(?:子智能体|子任务|agent|检索|分析|技术路|治理路|任务)';
  const waiting = '(?:仍在运行|正在运行|正在等待|等待.{0,18}完成|尚未完成|请稍候)';
  return new RegExp(`${actor}.{0,60}${waiting}|${waiting}.{0,60}${actor}`, 'i').test(value);
}

// PM 偶尔会把 TaskCreate/TaskUpdate 的看板状态误当成 Agent 已启动，口头声称“正在等待”，
// 但底层并没有对应的 Agent 工具调用。此时静等永远不会有通知。最多自动纠偏两次：
// 让 PM 根据真实 Agent 调用重新核对，缺失的立即补派；纠偏提示属于内部 user 事件，
// 协奏渲染器会吞掉，不会显示给用户。
function retryMissingOrchestrateAgents(sess, resultEvt) {
  if (sess.turnRouter && sess.turnRouter.interruptRequested) return false;
  // A successful answer can retain rejected tool calls. That does not authorize
  // a repair send that might retry the rejected operation; aborts also stop here.
  if (!TaskClock.isRootEvent(resultEvt) || resultEvt.type !== 'result'
      || resultEvt.is_error === true || resultEvt.subtype !== 'success'
      || (Array.isArray(resultEvt.permission_denials) && resultEvt.permission_denials.length > 0)
      || /^aborted_/.test(String(resultEvt.terminal_reason || ''))) return false;
  if (!sess.orchestrateMode || !sess.keepAliveForAsyncAgents || sess.asyncAgentTracker.size > 0) return false;
  if (!orchestrateResultClaimsBackgroundWait(resultEvt && resultEvt.result)) return false;
  if (sess.orchRepairAttempts >= 2) return false;
  sess.orchRepairAttempts += 1;
  const correction = [
    '[Relay 协奏运行态校验]',
    '当前没有任何实际运行中的 Agent 工具调用，但你刚才声称仍在等待子智能体或子任务。',
    'TaskCreate/TaskUpdate/TaskList 只是任务看板，不代表子智能体已经启动。',
    '请立即核对本轮真实收到的 Agent 工具调用回执：每个计划执行的子任务都必须有一次独立的 Agent 工具调用。',
    '若有遗漏，现在补发缺失的 Agent；若已无遗漏，则继续下游派发或直接完成最终汇总。',
    '不得只修改 Task 状态后继续等待，也不要向用户复述本段运行态校验。',
  ].join('\n');
  try {
    const correctionId = crypto.randomUUID();
    sess.turnRouter.addSend(correctionId);
    if (!sess.child.push(correction, { uuid: correctionId })) throw new Error('会话已关闭');
    console.warn('[live] 协奏检测到虚假等待，已要求 PM 补派缺失 Agent convId=%s attempt=%d',
      sess.convId, sess.orchRepairAttempts);
    return true;
  } catch (e) {
    console.error('[live] 协奏纠偏写入失败 convId=%s: %s', sess.convId, e.message);
    return false;
  }
}

// 起一个常驻会话。不发任何 prompt —— MCP 会在此刻就开始连（已实测）。
//   SDK 的流式输入模式等价于原来的 `--input-format stream-json`：一个进程服务多轮。
//   这里仍保留 sess.child 这个字段名，但它现在是 claude-sdk.js 给的会话句柄
//   （.pid / .push() / .kill()）—— pid 仍是真实 claude 进程的，MCP watchdog 照常工作。
// Supplemental input is authoritative in the main process. Always reload the
// latest conversation so a delayed renderer snapshot cannot erase accepted input.
function persistLiveSupplementRecord(conversationId, jobId, input) {
  const conversation = loadConversation(conversationId);
  const turn = conversation && Array.isArray(conversation.turns)
    && conversation.turns.find(item => item && item.runId === jobId);
  if (!turn) throw new Error('当前任务记录不可用，补充内容已保留');
  const inputs = Array.isArray(turn.supplements) ? turn.supplements : [];
  const index = inputs.findIndex(item => item && item.id === input.id);
  const record = JSON.parse(JSON.stringify(input));
  if (index < 0) {
    inputs.push(record);
    conversation.updatedAt = record.ts;
  } else inputs[index] = record;
  turn.supplements = inputs;
  persistConversationRecord(conversation);
  return record;
}

function publishLiveSupplement(sess, input, jobId = sess.jobId, onEvent = sess.onEvent) {
  let persisted = true;
  try { persistLiveSupplementRecord(sess.convId, jobId, input); }
  catch (error) { persisted = false; console.warn('[live] 补充状态保存失败 jobId=%s: %s', jobId, error.message); }
  if (onEvent) {
    try { onEvent({ jobId, type: 'system', subtype: 'relay_user_input', input: JSON.parse(JSON.stringify(input)) }); }
    catch (error) { console.warn('[live] 补充状态发布失败 jobId=%s: %s', jobId, error.message); }
  }
  return persisted;
}

function settleLiveSupplements(sess, fallbackStatus = 'rejected') {
  flushSupplementUpdates(sess, input => publishLiveSupplement(sess, input));
  const pending = new Set(sess.turnRouter.pendingSupplementIds());
  const failures = sess.turnRouter.supplementFailures;
  const unapplied = [];
  for (const input of (sess.supplementInputs || new Map()).values()) {
    const failed = failures.get(input.id);
    if (pending.has(input.id) || input.status === 'queued' || failed) {
      input.status = failed === 'cancelled' || failed === 'discarded' ? 'canceled'
        : failed === 'refused' ? 'rejected' : fallbackStatus;
      publishLiveSupplement(sess, input);
    }
    if (input.status === 'canceled' || input.status === 'rejected') unapplied.push(JSON.parse(JSON.stringify(input)));
  }
  return unapplied;
}

function steerLiveTurn(request = {}) {
  try {
    const { jobId, conversationId } = request || {};
    const validId = value => typeof value === 'string' && /^[0-9a-f][0-9a-f-]{15,63}$/i.test(value);
    if (!validId(jobId) || !validId(conversationId)) return { ok: false, code: 'INVALID_INPUT', message: '任务或对话标识无效，补充内容已保留' };
    const configuredFollowUp = readAppSettings().followUpMode === 'queue' ? 'queue' : 'steer';
    const selectedFollowUp = request.followUpMode === undefined ? configuredFollowUp : request.followUpMode;
    const input = normalizeSupplement({ ...request, followUpMode: selectedFollowUp });
    if (request.reverseFollowUp) input.followUpMode = input.followUpMode === 'queue' ? 'steer' : 'queue';
    const conversation = loadConversation(conversationId);
    const turn = conversation && Array.isArray(conversation.turns)
      && conversation.turns.find(item => item && item.runId === jobId);
    if (!turn) return { ok: false, code: 'HISTORY_MISSING', message: '当前任务记录不可用，补充内容已保留' };
    const existing = (Array.isArray(turn.supplements) ? turn.supplements : []).find(item => item && item.id === input.id);
    // Retries after a lost IPC response remain idempotent even after this run ended.
    if (existing) return sameSupplement(existing, input)
      ? { ok: true, duplicate: true, jobId, conversationId, input: existing }
      : { ok: false, code: 'INPUT_CONFLICT', message: '这条补充消息的标识已被使用，内容已保留' };
    const sess = liveSessions.get(conversationId);
    if (!sess || sess.dead || !sess.busy || sess.jobId !== jobId || sess.convId !== conversationId) {
      if (jobs.has(jobId)) return { ok: false, code: 'UNSUPPORTED_EXECUTOR', message: '当前执行方式暂不支持运行中补充，内容已保留，请等待任务结束后发送' };
      const run = taskLedger && taskLedger.get(jobId);
      if (run && !isTerminalState(run.state) && run.source && run.source.conversationId === conversationId) {
        return { ok: false, code: 'NOT_READY', message: '任务仍在准备执行，补充内容已保留，请稍后发送' };
      }
      return { ok: false, code: 'NOT_RUNNING', message: '当前任务已结束或已切换，补充内容已保留' };
    }
    if (liveTurnControls.isStopping(conversationId)) return { ok: false, code: 'TURN_STOPPING', message: '任务正在暂停，补充内容已保留' };
    const onEvent = sess.onEvent;
    return { ...submitLiveSupplement({ session: sess, jobId, input,
      persist: record => persistLiveSupplementRecord(conversationId, jobId, record),
      emit: record => { if (onEvent) onEvent({ jobId, type: 'system', subtype: 'relay_user_input', input: JSON.parse(JSON.stringify(record)) }); },
    }), jobId, conversationId };
  } catch (error) {
    return { ok: false, code: 'INVALID_INPUT', message: error.message || '补充内容未能发送，已保留在输入框中' };
  }
}

function spawnLiveSession({
  convId, cwd, validWorkingDir, agentProjectRoot, model, routeTier, effort, sessionId, attachCronMcp,
  providerRuntime = null, runtimeContract = null, mode, agentName,
}) {
  const requestedTier = relayModelTier(routeTier || model);
  const runtime = providerRuntime || activeRelayProviderRuntime({ tier: requestedTier });
  const runtimeModel = runtime.modelId || model;
  runtimeContract ||= conversationRuntimeContract({ convId, cwd, mode, agentName, model: runtimeModel, effort, agentProjectRoot, providerRuntime: runtime });
  const observer = new SdkSessionObserver();
  const diagnostics = makeSdkDiagnostics();
  const permissions = conversationPermissionSnapshot(convId);
  const storedConversation = loadConversation(convId);
  const nativeFork = pendingForkOptions(storedConversation, sessionId);
  const sess = {
    convId, child: null, observer, diagnostics,
    runtimeContract,
    prewarm: createPrewarmState(storedConversation, { resumed: !!sessionId, forked: !!nativeFork.forkSession, epoch: observer.epoch }),
    // Reserving a fresh Query does not mean its history-bearing input reached
    // the SDK. Keep this independent of the one-use prewarm certificate.
    nativeContextReady: !!sessionId,
    fingerprint: sessionFingerprint({ cwd, validWorkingDir, agentProjectRoot, model: runtimeModel, effort, attachCronMcp, providerRuntime: runtime, runtimeFingerprint: runtimeContract.fingerprint }),
    // 重新加载 MCP 时必须原样复用这些启动参数。fingerprint 只适合比较，不能反解。
    launchSpec: {
      convId, cwd, validWorkingDir, agentProjectRoot, model: runtimeModel, routeTier: requestedTier, effort, attachCronMcp,
      runtimeFingerprint: runtimeContract.fingerprint, mode, agentName,
      runtimeFingerprintVersion: runtimeContract.fingerprintVersion,
      projectId: runtimeContract.projectId || null,
      providerId: runtime.id, providerRevision: runtime.revision, agentEnvironment: runtime.agentEnvironment || 'native',
    },
    sessionId: sessionId || null,   // claude 的 session_id,首轮从 init 事件学到
    permissionMode: permissions.executionMode.kind === 'plan' ? 'plan' : permissions.permissionMode,
    executionMode: permissions.executionMode,
    effort: effort || null,
    capabilities: new Set(),
    fastModeState: null,
    fastModeDisabledReason: null,
    busy: false, dead: false,
    jobId: null, onEvent: null,
    mcpPids: null,
    spawnedAt: Date.now(),   // watchdog 拍快照的时间门槛基准(见 snapshotMcpChildren 坑③)
    lastUsedAt: Date.now(),
    idleTimer: null,
    keepAliveForAsyncAgents: false,
    orchestrateMode: false,
    asyncAgentTracker: new LiveAsyncAgentTracker(),
    backgroundTaskTracker: new LiveBackgroundTaskTracker(),
    turnRouter: new LiveTurnRouter(),
    orchRepairAttempts: 0,
    checkpointRunIds: new Set(),
    supplementInputs: new Map(),
  };

  // SDK 会话级状态先对账，再将本轮事件交给 Relay 的归并/持久化管线。
  const onMessage = (evt) => {
    evt = TaskClock.normalizeEvent(evt);
    if (sess.dead || (liveSessions.has(convId) && liveSessions.get(convId) !== sess)) return;
    if (TaskClock.isRootEvent(evt) && evt.type === 'result' && evt.relay_error_category === 'resume_guard_rejected') {
      const saved = loadConversation(convId);
      if (saved && (nativeFork?.resumeDropsTurn || saved.pendingSdkFork?.resumeDropsTurn)) {
        delete saved.pendingSdkFork; delete saved.sdkSessionContext; saved.sessionId = null;
        saved.carryContextOnNextTurn = true; saved.sdkResumeRejected = true; sess.sessionId = null; sess.resumeGuardRejected = true;
        liveTombstones.delete(convId);
        persistConversationRecord(saved);
      }
    }
    if (sess.resumeGuardRejected && evt.type !== 'result') return;
    const observed = observer.observe(evt);
    const childEvent = !TaskClock.isRootEvent(evt);
    // A reset changes the wire session, not the Relay run. Reject every late
    // parent frame from the old session before it can settle this run. Child
    // frames have their own session IDs and are checked by tool ownership below.
    if (evt.type !== 'conversation_reset' && !childEvent && observer.sessionId
        && evt.session_id && evt.session_id !== observer.sessionId) return;
    if (!observed && (evt.type === 'conversation_reset' || evt.type === 'system' && ['init', 'status', 'session_state_changed'].includes(evt.subtype))) return;
    if (evt.type === 'conversation_reset' && observed) {
      sess.sessionId = evt.new_conversation_id;
      sess.nativeContextReady = true;
      sess.contextUsage = null; sess.contextUsageKey = null;
      if (sess.executionMode?.kind === 'goal') sess.executionMode = { kind: 'default' };
      sess.backgroundTaskTracker.reset(); sess.asyncAgentTracker.reset();
      sess.turnRouter.resetConversation();
      if (sess.jobId) interactionBroker.rejectTask(sess.jobId, { message: '上下文已重置，请等待新的请求' });
      getConversationPermissions().resetContext(convId, { sessionId: evt.new_conversation_id, runId: sess.jobId });
    }
    if (!childEvent && evt.type === 'assistant' && Number.isFinite(evt.context_usage?.total_tokens) && Number.isFinite(evt.context_usage?.raw_max_tokens)) {
      const raw = evt.context_usage;
      sess.nativeContextSample = { key: contextRuntimeKey(sess), at: Date.now(), value: {
        ...compactContextUsage({totalTokens:raw.total_tokens,maxTokens:raw.raw_max_tokens,rawMaxTokens:raw.raw_max_tokens,percentage:raw.percentage,
          model:raw.model,categories:raw.categories,running:!!sess.busy}), source:'sdk-context-snapshot' } };
    }
    if (evt.subtype === 'elicitation_complete') interactionBroker.completeElicitation(evt, {
      runId: sess.jobId, conversationId: convId, windowId: miniInteractionWindowId(sess.jobId) });
    // 学 session_id:新会话首轮由 claude 分配,后续重启进程时用它 resume 接回(已验证可行)
    if (evt.type === 'system' && evt.subtype === 'init') {
      if (evt.session_id) sess.sessionId = evt.session_id;
      if (evt.permissionMode) sess.permissionMode = evt.permissionMode;
      if (evt.effort !== undefined) sess.effort = evt.effort;
      sess.capabilities = new Set(Array.isArray(evt.capabilities) ? evt.capabilities : []);
      sess.fastModeState = evt.fast_mode_state || null;
      sess.fastModeDisabledReason = evt.fast_mode_disabled_reason || null;
    }
    if (evt.type === 'system' && evt.subtype === 'status' && evt.permissionMode) {
      sess.permissionMode = evt.permissionMode;
    }
    // Native forks/resumes already contain history, so persist their idle init
    // identity immediately. A fresh Query has no history yet: keep the saved
    // handle/contract until its first user input is absorbed, even if reserved.
    // Otherwise recycling it would later resume an empty transcript as current.
    if (evt.type === 'conversation_reset' || evt.type === 'system' && evt.subtype === 'init') {
      if (evt.type === 'conversation_reset') observeProvenance(sess, evt);
      const record = loadConversation(convId);
      if (applyProvenance(record, sess, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))) persistConversationRecord(record);
    }
    // 恢复 session 会先送出旧后台命令的内部通知/零轮 result；它们没有回答
    // 本轮用户发送。先按发送 UUID 和已归属的 Agent 分流，再挂当前 jobId。
    evt = sess.turnRouter.accept(evt);
    if (!evt) return;
    const contextBecameReady = sess.nativeContextReady === false && TaskClock.isRootEvent(evt)
      && (evt.type === 'command_lifecycle' && evt.state === 'started' && evt.command_uuid === sess.jobId
        || evt.type === 'assistant' && !evt.error
        || evt.type === 'stream_event' && evt.event?.type === 'message_start'
        || evt.type === 'result' && evt.subtype === 'success' && !evt.is_error && Number(evt.num_turns) > 0);
    if (contextBecameReady) sess.nativeContextReady = true;
    observeProvenance(sess, evt);
    if (contextBecameReady || evt.type === 'result' || evt.type === 'system' && ['init', 'task_notification'].includes(evt.subtype)) {
      const record = loadConversation(convId);
      if (applyProvenance(record, sess, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))) persistConversationRecord(record);
    }
    if (sess.busy && !sess.firstResponseLogged && TaskClock.isRootEvent(evt) &&
      (evt.type === 'stream_event' && evt.event?.type === 'message_start' || evt.type === 'assistant' && !evt.error)) {
      sess.firstResponseLogged = true;
      console.log('[live] 首次响应 jobId=%s elapsedMs=%d', sess.jobId, Date.now() - sess.turnStartedAt);
    }
    const resources = resourceEntries(evt, { jobId: sess.jobId,
      cwd: sess.launchSpec.runtimeCwd || sess.launchSpec.cwd,
      agentEnvironment: sess.launchSpec.agentEnvironment,
      wslDistribution: sess.launchSpec.wslDistribution });
    if (resources.length) {
      sess.taskResources = mergeResources(sess.taskResources, resources);
      const saved = loadConversation(convId);
      if (saved) { saved.sdkTaskResources = mergeResources(saved.sdkTaskResources, resources); persistConversationRecord(saved); }
    }
    observeSupplement(sess, evt, input => publishLiveSupplement(sess, input));
    sess.backgroundTaskTracker.ingest(evt);
    const pendingManualTasks = observeOwnedBackgroundTasks(sess, evt);
    if (sess.keepAliveForAsyncAgents) {
      const transitions = sess.asyncAgentTracker.ingest(evt);
      for (const transition of transitions) {
        if (transition.kind === 'snapshot') {
          if (transition.changed) {
            console.log('[live] 后台 Agent 快照已对账 convId=%s pending=%d', convId, transition.pending);
          }
        } else if (transition.kind === 'launched' && transition.changed) {
          console.log('[live] 后台 Agent 已启动 convId=%s trackingId=%s taskId=%s pending=%d',
            convId, transition.trackingId, transition.taskId || '-', transition.pending);
        } else if (transition.kind === 'finished') {
          console.log('[live] 后台 Agent 已结束 convId=%s trackingId=%s taskId=%s status=%s pending=%d',
            convId, transition.trackingId, transition.taskId || '-', transition.status, transition.pending);
        }
      }
    }
    let resultDisposition = TaskClock.isRootEvent(evt) ? liveResultDisposition(evt, sess.asyncAgentTracker) : null;
    const pendingInputs = sess.turnRouter.resultPendingSupplementCount(evt);
    const failedResult = evt.type === 'result' && (evt.is_error === true || evt.subtype !== 'success'
      || /^aborted_/.test(String(evt.terminal_reason || '')) || sess.turnRouter.interruptRequested);
    // A result can precede the CLI consuming newly pushed input. Only evaluate
    // a new result here; a later started/echo must never reuse that old result.
    if (resultDisposition === 'finish' && (pendingInputs > 0 || pendingManualTasks > 0) && !failedResult) resultDisposition = 'wait';
    if (evt.type === 'result' && pendingInputs > 0) evt = { ...evt, relay_pending_inputs: pendingInputs };
    if (evt.type === 'result' && pendingManualTasks > 0) evt = { ...evt, relay_pending_background_tasks: pendingManualTasks };
    if (resultDisposition) sess.turnRouter.noteResult(resultDisposition, sess.asyncAgentTracker.size + pendingManualTasks);
    if (sess.onEvent) {
      try { sess.onEvent({ jobId: sess.jobId, ...evt }); }
      catch (e) { console.error('[live] emit 失败: %s type=%s', e.message, evt && evt.type); }
    }
    // 关键:前端只认 job-done 收尾(result 只记状态,见 renderer/app.js 的事件分发)。
    //   一次性 job 的 job-done 是进程结束时发的 —— 但常驻进程【永远不结束】,
    //   不在这里补发就是每轮永远转圈。
    // result.origin 不能用于区分中间态/最终态：2.1.220 在消费完成通知后，
    // PM 整轮输出的 result 仍带 origin.kind=task-notification。
    // 唯一可靠的收尾依据是实际 Agent 调用 Set：仍有后台 Agent 就继续等；归零后，
    // 若 PM 虚假声称还在等待则内部纠偏，否则本轮正常结束。
    if (resultDisposition) {
      if (resultDisposition === 'wait') {
        console.log('[live] 阶段性 result，继续等待本轮任务或补充输入 convId=%s mode=%s pending=%d',
          convId, sess.orchestrateMode ? 'orchestrate' : 'interactive',
          sess.asyncAgentTracker.size + pendingManualTasks);
      } else if (!retryMissingOrchestrateAgents(sess, evt)) {
        finishTurn(sess, evt);
        if (sess.resumeGuardRejected) { killLiveSession(sess, 'SDK 重做边界校验未通过'); liveTombstones.delete(convId); }
      }
    }
  };

  const onExit = (code, err) => {
    const wasBusy = sess.busy;
    const exitingJobId = sess.jobId;
    const unappliedInputs = wasBusy ? settleLiveSupplements(sess, sess.turnRouter.interruptRequested ? 'canceled' : 'rejected') : [];
    sess.dead = true;
    if (sess.sessionId && sess.nativeContextReady !== false) liveTombstones.set(convId, {
      sessionId: sess.sessionId,
      cwd: sess.launchSpec && sess.launchSpec.cwd || null,
      providerId: sess.launchSpec && sess.launchSpec.providerId || null,
      providerRevision: sess.launchSpec && sess.launchSpec.providerRevision || 0,
    agentEnvironment: sess.launchSpec && sess.launchSpec.agentEnvironment || 'native',
      routeTier: sess.launchSpec && sess.launchSpec.routeTier || null,
      runtimeFingerprint: sess.launchSpec?.runtimeFingerprint || null,
      at: Date.now(),
    });
    if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
    if (liveSessions.get(convId) === sess) liveSessions.delete(convId);
    console.log('[live] close convId=%s pid=%s exitCode=%s busy=%s', convId, sess.child && sess.child.pid, code, wasBusy);
    // 进程在一轮跑到一半时死掉 → 必须给前端收尾,否则 UI 永远转圈
    if (wasBusy && sess.onEvent) {
      // 正常收尾已由 finishTurn 清掉 busy。走到这里就没有本轮权威结果，
      // 即使进程自身以 0 退出也只能记未完成，不能制造成功但正文为空的任务。
      const unfinishedError = err || 'Claude 会话在返回本轮最终结果前结束';
      try {
        sess.onEvent({
          jobId: sess.jobId, type: 'job-done',
          exitCode: code == null || code === 0 ? -1 : code, error: unfinishedError,
          ...(unappliedInputs.length ? { relay_unapplied_inputs: unappliedInputs } : {}),
        });
      } catch (_) {}
    }
    if (exitingJobId) interactionBroker.rejectTask(exitingJobId, { message: err || '执行会话已经结束' });
    if (checkpointManager && sess.checkpointRunIds) {
      for (const runId of sess.checkpointRunIds) {
        try { markCheckpointUnavailable(runId, err || '执行会话已经结束'); } catch (_) {}
      }
      sess.checkpointRunIds.clear();
    }
    sess.busy = false; sess.onEvent = null;
    sess.turnRouter.end();
    refreshTrayMenu();
  };

  const canUseTool = interactionBroker.createCanUseTool(() => ({
    runId: sess.jobId,
    conversationId: sess.convId,
    windowId: miniInteractionWindowId(sess.jobId),
    source: 'conversation',
    permissionReconciliation: sess.permissionReconciliation?.runId === sess.jobId ? sess.permissionReconciliation : null,
  }));
  const onNativeHook = async input => {
    if (sess.dead || liveSessions.has(convId) && liveSessions.get(convId) !== sess) return;
    observer.native.hook(input);
    const childHook = !!input.agent_id;
    const reportedCwd = nativeWorkingDirectory(input);
    if (reportedCwd) {
      // This is the live executor's cwd, never a new project binding.
      const target = resourceTarget({ uri: reportedCwd, cwd: sess.launchSpec.runtimeCwd || cwd,
        agentEnvironment: sess.launchSpec.agentEnvironment, wslDistribution: sess.launchSpec.wslDistribution });
      if (target.kind === 'file') { sess.launchSpec.runtimeCwd = reportedCwd; sess.workspaceRoot = target.path; }
    }
    if (input.hook_event_name === 'ConfigChange') {
      sess.catalogRevision = (sess.catalogRevision || 0) + 1;
      sess.supportedCommands = null; sess.supportedModels = null;
    }
    if (!childHook && input.hook_event_name === 'PostToolUse' && sess.jobId) {
      if (input.tool_name === 'ProposeGoal' && typeof input.tool_input?.condition === 'string') {
        sess.executionMode = { kind: 'goal' }; sess.child?.adoptGoal(input.tool_input.condition);
        getConversationPermissions().adoptGoal(convId, { condition: input.tool_input.condition, sessionId: sess.sessionId });
      }
      if (input.tool_name === 'ReportFindings') {
        const findings = safeFindings(input.tool_response?.findings ? input.tool_response : input.tool_input);
        const saved = loadConversation(convId);
        if (saved) { saved.sdkReviewFindings = { runId: sess.jobId, findings, cwd: sess.launchSpec.runtimeCwd || cwd, at: new Date().toISOString() }; persistConversationRecord(saved); }
      }
      if (input.tool_name === 'ProposeSkills') {
        try {
          const drafts = await skillDraftService.stageProposals(input.tool_input, {
            sourceRef: { type: 'sdk-proposal', conversationId: convId, runId: sess.jobId, toolUseId: input.tool_use_id },
          });
          for (const draft of drafts) broadcastSkillDraftEvent(draft.deduplicated ? 'skillDraft.updated' : 'skillDraft.created', { draft });
        } catch (error) {
          for (const draft of error.drafts || []) broadcastSkillDraftEvent(draft.deduplicated ? 'skillDraft.updated' : 'skillDraft.created', { draft });
          observer.native.put('skill-proposal-failure', { kind: 'skill_proposal', status: 'error', reason: '技能建议未能保存，请检查技能格式及原技能是否仍存在。' });
          sess.onEvent?.({ jobId: sess.jobId, type: 'system', subtype: 'notification', level: 'warning',
            title: '技能建议未能保存', message: '请检查技能格式及原技能是否仍存在；已有技能未被覆盖。' });
        }
      }
    }
    if (!childHook && ['CwdChanged', 'FileChanged'].includes(input.hook_event_name)
        || input.hook_event_name === 'PostToolUse' && ['ReportFindings', 'EnterWorktree', 'ExitWorktree'].includes(input.tool_name)) {
      if (!sess.workspaceRefreshTimer) sess.workspaceRefreshTimer = setTimeout(() => {
        sess.workspaceRefreshTimer = null;
        if (!sess.dead && liveSessions.get(convId) === sess) mainWindow?.webContents.send('workspace:runtime-changed', { conversationId: convId, root: sess.workspaceRoot || null });
      }, 180);
    }
    if (!childHook && ['SessionStart', 'CwdChanged'].includes(input.hook_event_name)) return { watchPaths: [input.new_cwd || input.cwd].filter(Boolean) };
  };
  sess.child = claudeSdk.createLiveSession({
    cwd,
    onUsage: record => recordRelayUsage(record, 'conversation', convId),
    ...buildSdkParams({
      cwd, validWorkingDir, agentProjectRoot, conversationId: convId, model: runtimeModel, effort, sessionId, attachCronMcp,
      canUseTool, permissionMode: permissions.executionMode.kind === 'plan' ? 'plan' : permissions.permissionMode,
      enableFileCheckpointing: true, providerRuntime: runtime, runtimeContract,
      memoryContext: () => ({ ...memoryRequestContexts.get(sess.jobId), projectId: sess.runtimeContract?.projectId || runtimeContract?.projectId || null,
        sourceRef: 'conversation:' + convId + '/run:' + (sess.jobId || 'idle'),
        mode: sess.dead || !sess.busy || !sess.jobId ? 'off' : 'full', plan: sess.executionMode?.kind === 'plan' }),
      stderr: chunk => observer.stderr(chunk), onInstructionsLoaded: input => diagnostics.recordInstructions(input),
      onNativeHook,
      supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
      onUserDialog: createUserDialogHandler({ broker: interactionBroker,
        context: () => ({ runId: sess.jobId, conversationId: convId, windowId: miniInteractionWindowId(sess.jobId), source: 'conversation', allowedModels: Object.values(runtime.models || {}) }),
        onResolved: ({ request, scope }) => {
          if (sess.dead || liveSessions.get(convId) !== sess || sess.jobId !== scope.runId) return;
          const ids = request.payload.retractedMessageUuids;
          if (Array.isArray(ids) && ids.length) onMessage({ type: 'system', subtype: 'model_refusal_fallback',
            retracted_message_uuids: ids, session_id: sess.sessionId, uuid: crypto.randomUUID(), scope: 'local', content: '模型请求已结束' });
        } }),
      onElicitation: interactionBroker.createOnElicitation(() => ({ runId: sess.jobId, conversationId: sess.convId,
        windowId: miniInteractionWindowId(sess.jobId), source: 'conversation' })),
    }),
    perTaskStopAffordance: true,
    onToolProposal: createToolProposalHook({ broker: interactionBroker, context: () => ({
      runId: sess.jobId, conversationId: convId, windowId: miniInteractionWindowId(sess.jobId), source: 'conversation', executionMode: sess.executionMode,
    }) }),
    onDiagnosticSummary: summary => observer.native.put('debug-log', { kind: 'debug_log', ...summary }),
    ...nativeFork,
    onRuntimePrepared: context => {
      if (sess.dead) return;
      sess.launchSpec.runtimeCwd = context.cwd;
      sess.launchSpec.wslDistribution = context.wslDistribution || null;
    },
    onInitialized: result => observer.initialized(result),
    executionMode: permissions.executionMode,
    onMessage,
    onExit,
  });

  console.log('[live] spawn convId=%s cwd=%s model=%s provider=%s@%s resume=%s cronMcp=%s',
    convId, cwd, runtimeModel || '(default)', runtime.id, runtime.revision, sessionId || '(new)', !!attachCronMcp);

  liveSessions.set(convId, sess);
  touchIdleTimer(sess);
  sess.child.supportedAgents().then(agents => {
    if (!sess.dead && liveSessions.get(convId) === sess && !sess.catalogRevision) sess.supportedAgents = agents.map(({ name, description, model }) => ({ name, description, model }));
  }).catch(() => {});
  // 初始化完成后缓存 SDK 实际可用模型；不阻塞预启动和首轮发送。
  readSupportedModels(sess).catch((e) => console.warn('[live] 读取模型能力失败 convId=%s: %s', convId, e.message));
  // 拍 MCP 子进程快照供 watchdog 用。延到 60s 是有原因的(见 snapshotMcpChildren 的坑③);
  //   unref 掉,别为了一个诊断用的定时器拖住进程退出。
  const snapTimer = setTimeout(() => snapshotMcpChildren(sess), SNAPSHOT_DELAY_MS);
  if (snapTimer.unref) snapTimer.unref();
  return sess;
}

// 一轮结束:补发 job-done 让前端收尾,然后把进程还回池子等下一轮(进程不退出)。
function finishTurn(sess, resultEvt) {
  if (!sess || !sess.busy) return false;
  const onEvent = sess.onEvent;
  const jobId = sess.jobId;
  routeTimingHistory.add(sess.launchSpec || {}, sess.observer?.snapshot().timing);
  const pendingInputs = sess.turnRouter.pendingSupplementCount;
  const paused = sess.turnRouter.interruptRequested || /^aborted_/.test(String(resultEvt && resultEvt.terminal_reason || ''));
  const hasDenials = Array.isArray(resultEvt?.permission_denials) && resultEvt.permission_denials.length > 0;
  const failed = paused || (resultEvt && (resultEvt.is_error === true || resultEvt.subtype !== 'success'));
  // Deliver the native successful result without interpreting its prose as goal
  // verification or authorizing a retry of the rejected operation.
  if (sess.executionMode?.kind === 'goal' && !failed && !hasDenials) {
    try { persistGoalRecovery(sess.convId, null); }
    catch (error) { console.warn('[goal] 完成状态保存失败: %s', error.message); }
  }
  const recycleQueuedInputs = pendingInputs > 0 && (failed || hasDenials);
  const unappliedInputs = settleLiveSupplements(sess, paused ? 'canceled' : 'rejected');
  if (unappliedInputs.length) resultEvt = { ...resultEvt, relay_unapplied_inputs: unappliedInputs };
  if (jobId) interactionBroker.rejectTask(jobId, { message: '任务已经结束', interrupt: false });
  const residualBackgroundTasks = Math.max(
    sess.backgroundTaskTracker.size,
    sess.asyncAgentTracker.size,
  );
  if (!failed && resultEvt?.subtype === 'success') {
    try {
      const record = loadConversation(sess.convId);
      if (applyProvenance(record, sess, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), { complete: true })) persistConversationRecord(record);
    } catch (error) { console.warn('[live] 完成轮次来源保存失败: %s', error.message); }
  }
  sess.busy = false;
  sess.onEvent = null;   // 本轮已结束,后续残留事件不再转发(避免串到下一轮的 UI)
  sess.jobId = null;
  sess.keepAliveForAsyncAgents = false;
  sess.turnRouter.end();
  sess.orchestrateMode = false;
  sess.asyncAgentTracker.reset();
  sess.orchRepairAttempts = 0;
  sess.lastUsedAt = Date.now();
  touchIdleTimer(sess);
  refreshTrayMenu();
  // exitCode 0 = 本轮正常结束(进程还活着,这是个"逻辑收尾"信号,不代表进程退出)。
  //   result.is_error / error_* subtype 时前端已在 result 分支记了 run.error,这里照常收尾即可。
  // 在发出 job-done（资源槽随即释放）前先占住工作区/会话写锁。预览哈希可以异步，
  // 但下一轮必须等它取得一致快照后才能进入执行器。
  let releaseCheckpointScope = null;
  let checkpointRecord = null;
  if (checkpointManager && jobId) {
    try {
      checkpointRecord = checkpointManager.get(jobId);
      if (checkpointRecord) {
        const workspaceKey = normalizedWorkspaceKey(checkpointRecord.workspace);
        const conversationKey = checkpointRecord.conversationId ? String(checkpointRecord.conversationId) : null;
        const conflict = taskLedger && taskLedger.list({ terminal: false }).find((run) => {
          if (!run || run.runId === jobId) return false;
          const sameWorkspace = workspaceKey
            && normalizedWorkspaceKey(run.metadata && run.metadata.workingDir) === workspaceKey;
          const sameConversation = conversationKey
            && run.source && String(run.source.conversationId || '') === conversationKey;
          return sameWorkspace || sameConversation;
        });
        if (conflict) {
          const unavailable = markCheckpointUnavailable(
            jobId,
            '同一工作区仍有其他任务在写入，无法安全建立本轮回退点',
          );
          void unavailable;
          checkpointRecord = null;
        } else {
          releaseCheckpointScope = acquireCheckpointScope(checkpointRecord.workspace, checkpointRecord.conversationId);
        }
      }
    } catch (_) {}
  }
  if (onEvent) {
    try { onEvent({ jobId, type: 'job-done', exitCode: 0, finalResult: resultEvt, ...(unappliedInputs.length ? { relay_unapplied_inputs: unappliedInputs } : {}) }); }
    catch (e) { console.error('[live] job-done 发送失败: %s', e.message); }
  }
  // Query 仍存活时立刻做 dry-run，并记录完成时文件哈希。用户之后点击回退时会再次
  // 校验这些哈希，若文件被外部程序改过则拒绝覆盖。
  if (checkpointManager && jobId && checkpointRecord) {
    checkpointManager.preview(jobId).then((record) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('checkpoints:event', { type: 'checkpoint.updated', checkpoint: record });
        }
      } catch (_) {}
    }).catch((e) => {
      console.warn('[checkpoint] 完成后预览失败 runId=%s: %s', jobId, e.message);
      try { emitCurrentCheckpoint(jobId); } catch (_) {}
    })
      .finally(() => { if (releaseCheckpointScope) releaseCheckpointScope(); });
  } else if (releaseCheckpointScope) {
    releaseCheckpointScope();
  }
  // 最终回复已经交付时，后台 Bash 不再阻塞 UI；但也不能继续挂在可复用 query 上。
  // 回收进程会终止残留命令，并把 session_id 留进墓碑，下一轮用 --resume 无缝接回。
  if (recycleQueuedInputs) {
    killLiveSession(sess, '任务结束后仍有未消费的补充输入');
    return true;
  }
  if (residualBackgroundTasks > 0) {
    killLiveSession(sess, `最终 result 后仍有 ${residualBackgroundTasks} 个后台任务`);
    return true;
  }
  sess.backgroundTaskTracker.reset();
  // 补一次快照机会:spawn 那次定时可能因为当时正忙(新对话是 spawn 完立刻就发)而放弃了。
  //   现在刚空下来,正是拍准的时机 —— 函数内部自带「不足 60s 不拍」与「已拍过则 no-op」的闸。
  const t = setTimeout(() => snapshotMcpChildren(sess), 500);
  if (t.unref) t.unref();
  void resultEvt;
  return true;
}

// 预启动:对话打开/切换时调用。此刻起进程 → MCP 在用户打字的几秒里连好 → 首轮 init 也是零延迟。
//   这才是原 warmUpFeishuMcp 想做却做不到的事:焐的是真正会服务这一轮的那个进程。
function prespawnSession(opts) {
  if (!opts || !opts.convId) return null;
  const routeTier = relayModelTier(opts.routeTier || opts.model);
  const providerRuntime = activeRelayProviderRuntime({ tier: routeTier });
  const targetRoute = providerSessionRoute(providerRuntime, routeTier);
  const runtimeContract = conversationRuntimeContract({ ...opts, model: providerRuntime.modelId, providerRuntime });
  const savedContract = loadConversation(opts.convId);
  if (savedContract?.forkedFrom) opts = { ...opts, sessionId: savedContract.sessionId || null };
  const contractMatches = !requiresFreshContract(savedContract, runtimeContract.fingerprint);
  const exist = liveSessions.get(opts.convId);
  if (exist && !exist.dead) {
    if (exist.launchSpec.runtimeFingerprint === runtimeContract.fingerprint && sessionRouteMatchesProvider(exist.launchSpec, targetRoute)
        && workspaceKey(exist.launchSpec.cwd) === workspaceKey(opts.cwd)
        && workspaceKey(exist.launchSpec.agentProjectRoot) === workspaceKey(opts.agentProjectRoot)
        && getConversationWorkspaces().acceptsSession(opts.convId, exist.sessionId)) return exist;
    // 正在执行的旧路由不能由预启动打断；真正发送时会按 busy 规则安全处理。
    if (exist.busy) return exist;
    killLiveSession(exist, '预启动时模型路由已切换');
    // kill 会写入旧路由墓碑；必须立即移除，禁止新服务商恢复旧 session_id。
    liveTombstones.delete(opts.convId);
  }
  if (!evictIfNeeded()) return null;         // 位置全被占着(都在跑)→ 放弃预启动,不影响正确性
  // 墓碑比前端传来的 sessionId 新:前端记的是这个对话【最初】的 session_id,而进程重启过几次后
  //   claude 侧的 id 可能已经变了(--resume 会派生新 id)。优先用墓碑。
  const tomb = liveTombstones.get(opts.convId);
  const tombSessionId = tomb && tomb.runtimeFingerprint === runtimeContract.fingerprint && sessionRouteMatchesProvider(tomb, targetRoute)
    && workspaceKey(tomb.cwd) === workspaceKey(opts.cwd)
    && getConversationWorkspaces().acceptsSession(opts.convId, tomb.sessionId) ? tomb.sessionId : null;
  if (tomb && !tombSessionId) liveTombstones.delete(opts.convId);
  const suppliedSessionId = contractMatches && opts.sessionId && getConversationWorkspaces().acceptsSession(opts.convId, opts.sessionId)
    && !opts.workspaceChanged && sessionRouteMatchesProvider(opts.sessionRoute, targetRoute)
    ? opts.sessionId : null;
  const sessionId = tombSessionId || suppliedSessionId || null;
  try {
    return spawnLiveSession({
      ...opts,
      routeTier,
      providerRuntime, runtimeContract,
      sessionId,
    });
  }
  catch (e) { console.warn('[live] 预启动失败(忽略): %s', e.message); return null; }
}

// 跑一轮。能复用常驻进程就复用(仅写 stdin);否则(不存在/已死/参数变了/MCP 树塌了)重启一个,
//   并用已知 session_id --resume 接回上下文。返回 jobId + 运行时已学到的 sessionId;
//   拿不到常驻位则返回 null 让调用方回退。
function runLiveTurn({ convId, prompt, files, executionRequest, cwd, validWorkingDir, agentProjectRoot, model, effort, sessionId, sessionRoute, attachCronMcp, forceFreshSession, keepAliveForAsyncAgents, orchestrateMode, onEvent, runId, runtimeContract, mode, agentName, taskStartedAt, taskRun }) {
  const taskClock = new TaskClock({ startedAt: taskStartedAt, taskRun });
  const storedFork = loadConversation(convId);
  if (!forceFreshSession && storedFork?.forkedFrom) sessionId = storedFork.sessionId || null;
  const routeTier = relayModelTier(model);
  const providerRuntime = activeRelayProviderRuntime({ tier: routeTier });
  const runtimeModel = providerRuntime.modelId;
  runtimeContract ||= conversationRuntimeContract({ convId, cwd, mode, agentName, model: runtimeModel, effort, agentProjectRoot, providerRuntime });
  const targetRoute = providerSessionRoute(providerRuntime, routeTier);
  const routeMatches = (candidate) => sessionRouteMatchesProvider(candidate, targetRoute);
  const incomingRouteKnown = !!(sessionRoute && sessionRoute.providerId);
  const incomingRouteMatches = !incomingRouteKnown || routeMatches(sessionRoute);
  const currentSession = liveSessions.get(convId);
  const workspaceMismatch = currentSession && workspaceKey(currentSession.launchSpec && currentSession.launchSpec.cwd) !== workspaceKey(cwd);
  const freshRequested = !!forceFreshSession || !incomingRouteMatches || !!workspaceMismatch
    || !!currentSession && currentSession.launchSpec?.runtimeFingerprint !== runtimeContract.fingerprint
    || !getConversationWorkspaces().acceptsSession(convId, sessionId);
  const fp = sessionFingerprint({ cwd, validWorkingDir, agentProjectRoot, model: runtimeModel, effort, attachCronMcp, providerRuntime, runtimeFingerprint: runtimeContract.fingerprint });
  const reuseFreshPrewarm = freshRequested && canReuseFreshPrewarm(currentSession, {
    conversationId: convId, fingerprint: fp, record: storedFork,
    routeMatches: routeMatches(currentSession?.launchSpec),
    workspaceAccepts: getConversationWorkspaces().acceptsSession(convId, currentSession?.sessionId),
  });
  // A matching, unused replacement already has the requested empty context.
  // Keep its MCP/SDK startup work, while discarding any older resumable handle.
  const mustStartFresh = freshRequested && !reuseFreshPrewarm;
  if (reuseFreshPrewarm) liveTombstones.delete(convId);
  let sess = liveSessions.get(convId);
  // 重启后要靠 session_id --resume 接回上下文(已验证优雅/强杀都能接回)。取值优先级:
  //   进程自己学到的 > 墓碑(上个进程死时留下的) > 前端传来的。
  //   注意:必须在 kill 之前取 —— killLiveSession 会把 sess 从 map 里摘掉。
  const candidateTomb = mustStartFresh ? null : liveTombstones.get(convId);
  const tomb = candidateTomb && routeMatches(candidateTomb) && candidateTomb.runtimeFingerprint === runtimeContract.fingerprint
    && workspaceKey(candidateTomb.cwd) === workspaceKey(cwd)
    && getConversationWorkspaces().acceptsSession(convId, candidateTomb.sessionId) ? candidateTomb : null;
  const sessionRouteMatches = sess && routeMatches(sess.launchSpec)
    && workspaceKey(sess.launchSpec.cwd) === workspaceKey(cwd)
    && getConversationWorkspaces().acceptsSession(convId, sess.sessionId);
  let learnedSid = mustStartFresh
    ? null
    : ((sessionRouteMatches && sess && sess.sessionId) || (tomb && tomb.sessionId) || null);

  if (sess && !sess.dead && sess.busy) {
    // Same-conversation overlap is never a one-shot fallback: both would write
    // the same SDK session and make terminal events impossible to attribute.
    return { error: '该对话上一轮仍在执行，请先暂停或等待完成。', code: 'CONVERSATION_BUSY' };
  }
  if (sess && !sess.dead && mustStartFresh) {
    killLiveSession(sess, incomingRouteMatches ? '请求全新会话' : '模型路由已切换');
    liveTombstones.delete(convId);
    learnedSid = null;
    sess = null;
  }
  if (sess && !sess.dead && sess.fingerprint !== fp) {
    killLiveSession(sess, '参数变更(模型/目录/agent)');   // 这些是 spawn 时定死的,只能重启
    if (mustStartFresh) { liveTombstones.delete(convId); learnedSid = null; }
    sess = null;
  }
  if (sess && !sess.dead && !mcpTreeIntact(sess)) {
    killLiveSession(sess, 'MCP 子进程树已塌(防幽灵工具)');
    if (mustStartFresh) { liveTombstones.delete(convId); learnedSid = null; }
    sess = null;
  }
  if (sess && sess.dead) {
    if (!mustStartFresh && sessionRouteMatches) learnedSid = learnedSid || sess.sessionId;
    sess = null;
  }

  if (!sess) {
    if (!evictIfNeeded()) return null;   // 常驻位全忙 → 回退一次性 job(行为等同改造前)
    try {
      sess = spawnLiveSession({
        convId, cwd, validWorkingDir, agentProjectRoot, model: runtimeModel, routeTier, effort, attachCronMcp,
        providerRuntime, runtimeContract, mode, agentName,
        sessionId: learnedSid || (!mustStartFresh && incomingRouteMatches ? sessionId : null) || null,
      });
    } catch (e) {
      console.error('[live] spawn 失败: %s', e.message);
      return null;
    }
  }

  const jobId = runId || crypto.randomUUID();
  // Reserve before asynchronous mode preparation: /goal may enqueue context
  // internally before the ordinary push. Never reuse this Query as empty again.
  sess.prewarm = null;
  sess.jobId = jobId;
  sess.onEvent = typeof onEvent === 'function' ? evt => onEvent(taskClock.stamp(evt)) : null;
  sess.turnStartedAt = taskClock.startedAt;
  sess.sdkProvenance = null;
  sess.firstResponseLogged = false;
  sess.observer?.beginTurn();
  sess.busy = true;
  sess.turnRouter.begin(jobId);
  sess.supplementInputs = new Map();
  sess.backgroundRequests = new Map();
  sess.keepAliveForAsyncAgents = !!keepAliveForAsyncAgents;
  sess.orchestrateMode = !!orchestrateMode;
  sess.asyncAgentTracker.reset();
  sess.backgroundTaskTracker.reset();
  sess.orchRepairAttempts = 0;
  sess.lastUsedAt = Date.now();
  touchIdleTimer(sess);
  refreshTrayMenu();
  try {
    if (checkpointManager) {
      try {
        checkpointManager.register({
          runId: jobId,
          userMessageId: jobId,
          conversationId: convId,
          sessionKey: convId,
          workspace: validWorkingDir || cwd || null,
        });
        checkpointManager.attach(jobId, {
          rewindFiles: (userMessageId, options) => sess.child.rewindFiles(userMessageId, options),
          abort: () => killLiveSession(sess, '文件检查点预览超时'),
        });
        sess.checkpointRunIds.add(jobId);
      } catch (e) { console.warn('[checkpoint] 开始跟踪失败 runId=%s: %s', jobId, e.message); }
    }
    dispatchLiveInput({
      session: sess, jobId, prompt, files: executionRequest && executionRequest.executionMode.kind === 'goal' ? undefined : files,
      prepareInput: async signal => {
        if (Object.keys(readAppSettings().mcpPermissionOverrides || {}).length) await reconcileMcpPermissions();
        if (!executionRequest && typeof sess.child.prepareExecutionMode !== 'function') return;
        const request = executionRequest || { executionMode: { kind: 'default' } };
        return getConversationPermissions().withSnapshot(convId, async permissions => {
          const executionMode = permissions.executionMode;
          const ready = await sess.child.prepareExecutionMode(executionMode, {
            permissionMode: permissions.permissionMode, contextPrompt: request.contextPrompt, contextFiles: files,
            goalCondition: request.goalCondition, goalExplicit: request.goalExplicit,
            previousGoal: executionMode.kind === 'goal' ? previousConversationGoal(loadConversation(convId), jobId) : null, signal,
          });
          if (ready.goalCondition) persistGoalRecovery(convId, ready.goalCondition);
          sess.permissionMode = ready.permissionMode;
          sess.executionMode = ready.executionMode;
          return ready;
        });
      },
      isSessionCurrent: () => liveSessions.get(convId) === sess,
      loadServers: () => {
        const registry = readClaudeMcpRegistry();
        if (!registry.ok) throw new Error('MCP 配置暂时不可读');
        return registry.enabled;
      },
      onStatus: (result) => {
        if (sess.dead || sess.jobId !== jobId || !sess.onEvent) return;
        if (result.phase === 'settled') {
          const items = Array.isArray(result.items) ? result.items : [];
          console.log('[mcp] 准备结果 connected=%d other=%d code=%s',
            items.filter((item) => item.status === 'connected').length,
            items.filter((item) => item.status !== 'connected').length,
            result.code || 'ready');
        }
        sess.onEvent({ jobId, type: 'system', subtype: 'relay_mcp_status', ...result });
      },
      onTiming: timing => { sess.observer?.preparation(timing); console.log('[live] 输入准备 jobId=%s startupMs=%d modeMs=%d mcpMs=%d totalMs=%d',
        jobId, timing.startupMs, timing.modeMs || 0, timing.mcpMs || 0, timing.totalMs); },
      onFailure: (message, diagnostic = {}) => {
        console.warn('[live] 输入准备失败 jobId=%s stage=%s code=%s elapsedMs=%d',
          jobId, diagnostic.stage, diagnostic.code, diagnostic.elapsedMs);
        settleUnsentLiveTurn(sess, jobId, message, false);
        killLiveSession(sess, '输入投递失败');
      },
    });
  } catch (e) {
    console.error('[live] 投递本轮输入失败: %s', e.message);
    // 这次 live attempt 尚未提交成功，外层会用同一 runId 回退到 one-shot。
    // 先摘掉本轮 observer，避免 kill 的 onExit 发出一个幽灵 job-done，提前结束 fallback。
    sess.busy = false;
    sess.onEvent = null;
    sess.jobId = null;
    killLiveSession(sess, '输入投递失败');
    return null;
  }
  console.log('[live] turn convId=%s jobId=%s pid=%s 复用常驻进程 promptLen=%d',
    convId, jobId, sess.child.pid, (prompt || '').length);
  return {
    jobId,
    sessionId: sess.sessionId || null,
    ...taskClock.snapshot(),
    providerId: providerRuntime.id,
    providerRevision: providerRuntime.revision,
    agentEnvironment: providerRuntime.agentEnvironment || 'native',
    routeTier,
    routeRevision: providerRuntime.routeRevision,
  };
}

// 在跑的常驻轮数(托盘/并发上限要把它算进去)
function busyLiveCount() {
  let n = 0;
  for (const s of liveSessions.values()) if (s.busy) n++;
  return n;
}

let projectStore = null;
function getProjectStore() {
  if (!projectStore) projectStore = createProjectStore({
    filePath: path.join(app.getPath('userData'), 'projects.json'),
    isBusy: id => !!(liveSessions.get(id) && liveSessions.get(id).busy)
      || !!(taskLedger && taskLedger.list({ terminal: false }).some(run => run.source && run.source.conversationId === id)),
  });
  return projectStore;
}
let projectHistoryInitialized = false;
function initializeProjectHistory() {
  if (projectHistoryInitialized) return;
  const store = getProjectStore();
  function* unboundConversations() {
    for (const item of readHistoryIndex()) {
      if (store.binding(item.id) !== undefined) continue;
      const conversation = loadConversation(item.id);
      if (conversation) yield conversation;
    }
  }
  // Stream old records through one registry transaction, not one rewrite per chat.
  store.adoptMany(unboundConversations());
  projectHistoryInitialized = true;
}
function projectConversation(conversation) {
  if (!conversation) return null;
  const store = getProjectStore();
  const saved = store.binding(conversation.id) === undefined && fs.existsSync(convFilePath(conversation.id)) ? loadConversation(conversation.id) : null;
  store.adopt(saved || conversation);
  return store.decorate(conversation);
}
function updateConversationProject(id, projectId) {
  const conversation = loadConversation(id); if (!conversation) throw Error('对话不存在');
  const store = getProjectStore(); store.adopt(conversation);
  if (store.binding(id) === (projectId || null) && !conversation.sdkForkWorkspace) return store.decorate(conversation);
  store.bind(id, projectId || null, { rebind: !!conversation.sdkForkWorkspace,
    beforeCommit: () => getConversationWorkspaces().invalidateConversationSession(id, conversation.sessionId) });
  delete conversation.sdkForkWorkspace;
  delete conversation.pendingSdkFork;
  const updated = { ...store.decorate(conversation), sessionId: null, carryContextOnNextTurn: 'workspace' };
  persistConversationRecord(updated);
  const sess = liveSessions.get(id); if (sess) killLiveSession(sess, '对话项目已切换');
  liveTombstones.delete(id);
  return updated;
}
function projectAction(action) {
  try { return { ok: true, ...action() }; }
  catch (error) { return { ok: false, error: error.message || '项目操作失败' }; }
}
ipcMain.handle('projects:list', () => projectAction(() => {
  initializeProjectHistory(); return { projects: getProjectStore().list(), workspace: getConversationWorkspaces().base };
}));
ipcMain.handle('projects:add', (_event, { path: folder, name } = {}) => projectAction(() => ({ project: getProjectStore().add(folder, name) })));
ipcMain.handle('projects:rename', (_event, { id, name } = {}) => projectAction(() => ({ project: getProjectStore().rename(id, name) })));
ipcMain.handle('projects:assign', (_event, { conversationId, projectId } = {}) => projectAction(() => ({ conversation: updateConversationProject(conversationId, projectId) })));
ipcMain.handle('projects:remove', (_event, id) => projectAction(() => {
  const affected = getProjectStore().remove(id, { beforeCommit: ids => {
    for (const conversationId of ids) {
      const old = loadConversation(conversationId);
      if (old) getConversationWorkspaces().invalidateConversationSession(conversationId, old.sessionId);
    }
  } });
  for (const conversationId of affected) {
    const conversation = loadConversation(conversationId);
    if (!conversation) continue;
    persistConversationRecord({ ...getProjectStore().decorate(conversation), sessionId: null, carryContextOnNextTurn: 'workspace' });
    const sess = liveSessions.get(conversationId); if (sess) killLiveSession(sess, '项目已移除');
    liveTombstones.delete(conversationId);
  }
  return { affected };
}));
ipcMain.handle('projects:open', async (_event, id) => {
  try {
    const project = getProjectStore().get(id); if (!project) throw Error('项目不存在');
    return await generalPreferences.openFile(project.path, generalPreferences.preferences().fileOpenTarget === 'relay' ? 'system' : 'default');
  } catch (error) { return { ok: false, error: error.message }; }
});

let conversationWorkspaceService = null;
const agentEnvironmentService = createAgentEnvironment({
  getEnvironment: () => normalizePreferences(readAppSettings()).agentEnvironment,
  getMcpServers: () => readClaudeMcpRegistry().enabled || {},
});
const generalPreferences = createGeneralPreferences({
  getSettings: readAppSettings, shell, probeWsl: input => agentEnvironmentService.probe(input),
  getProjectContext: sdkProjectContext,
  getModelCapability: input => {
    const sess = input.conversationId ? liveSessions.get(input.conversationId) : null;
    const model = sess?.launchSpec?.model;
    return sess?.supportedModels?.find(info => info.value === model || info.resolvedModel === model) || null;
  },
  getSdkDiagnostics: async input => {
    const sess = input.conversationId ? liveSessions.get(input.conversationId) : null;
    const project = sdkProjectContext(input);
    const environment = sess?.launchSpec?.agentEnvironment || normalizePreferences(readAppSettings()).agentEnvironment;
    const policy = sess?.runtimeContract?.policy || buildRuntimePolicy({ settings: readAppSettings(), projectId: project?.id, projectRoot: project?.path,
      memoryDir: MEMORY_DIR, environment, mapPath: toWslPath });
    const cwd = sess?.launchSpec?.runtimeCwd || sess?.launchSpec?.cwd || project?.path || generalPreferences.workspaceRoot();
    const inspector = sess?.diagnostics || makeSdkDiagnostics();
    const config = environment === 'wsl' && typeof agentEnvironmentService.inspectSettings === 'function'
      ? await agentEnvironmentService.inspectSettings({ cwd, settingSources: policy.settingSources,
        wslDistribution: sess?.launchSpec?.wslDistribution || undefined })
      : await inspector.inspect({ cwd, settingSources: policy.settingSources, environment });
    return { ...config, policy: policy.summary, instructions: inspector.getInstructions(), runtime: sess?.observer?.snapshot() || null,
      routeTiming: collectRouteTimings(), context: sess?.contextUsage || null };
  },
});
claudeSdk.configureRuntimeEnvironment(agentEnvironmentService);
registerGeneralPreferencesIpc({ ipcMain, getWindow: () => mainWindow, service: generalPreferences, dialog });
function getConversationWorkspaces() {
  if (!conversationWorkspaceService) conversationWorkspaceService = createConversationWorkspaces({
    registryPath: path.join(app.getPath('userData'), 'conversation-workspaces.json'),
    scratchBaseDir: path.join(app.getPath('userData'), 'conversation-scratch'),
    getBaseDir: () => generalPreferences.workspaceRoot(),
    loadConversation: (id) => fs.existsSync(convFilePath(id)) ? loadConversation(id) : null,
    persistConversationRecord,
    validateWorkspace: ({ conversationId, cwd }) => {
      const active = liveSessions.get(conversationId);
      const activeLedgerRun = taskLedger && taskLedger.list({ terminal: false }).find((run) =>
        run.source && run.source.conversationId === conversationId && run.state !== RUN_STATES.QUEUED
        && run.metadata && run.metadata.workingDir && workspaceKey(run.metadata.workingDir) !== workspaceKey(cwd));
      if ((active && active.busy && workspaceKey(active.launchSpec && active.launchSpec.cwd) !== workspaceKey(cwd)) || activeLedgerRun) {
        throw new Error('当前对话正在运行，请任务结束后再切换工作目录');
      }
    },
    getAgentProjectRoot: (agentName) => (readAppSettings().agentProjects || {})[agentName] || null,
  });
  return conversationWorkspaceService;
}
function resolveExecutionWorkspace({ conversationId, workingDir, projectId, useAgent = false, agentName = null, mode, ignoreProjects = false } = {}) {
  if (ignoreProjects) return getConversationWorkspaces().resolveWorkspace({ conversationId, workingDir, agentName, mode: mode || (useAgent ? 'agent' : 'plain') });
  const store = getProjectStore();
  const saved = fs.existsSync(convFilePath(conversationId)) ? loadConversation(conversationId) : null;
  if (saved) store.adopt(saved);
  const project = store.resolve(conversationId, projectId);
  const bound = store.binding(conversationId) !== undefined;
  const effectiveDirectory = project ? project.path : bound ? saved?.sdkForkWorkspace?.path || null : workingDir;
  return { ...getConversationWorkspaces().resolveWorkspace({
    conversationId, workingDir: effectiveDirectory, agentName, mode: mode || (useAgent ? 'agent' : 'plain'),
  }), projectId: project && project.id || null };
}
function resolveWorkspaceForTools(context = {}) {
  const id = context.conversationId;
  if (typeof id !== 'string' || !WORKSPACE_UUID.test(id)) throw new Error('请先创建或打开一个对话');
  const saved = fs.existsSync(convFilePath(id)) ? loadConversation(id) : null;
  const live = liveSessions.get(id);
  if (live && !live.dead && live.workspaceRoot) return { root: live.workspaceRoot, cwd: live.workspaceRoot,
    scratchDir: getConversationWorkspaces().resolveScratch(id), conversationId: id, managed: false };
  return resolveExecutionWorkspace({
    conversationId: id,
    projectId: context.projectId,
    workingDir: context.workingDir !== undefined ? context.workingDir : saved ? directoryValue(saved.workingDir) : undefined,
    agentName: saved ? saved.agent : context.agentName,
    mode: saved ? saved.mode : context.mode,
  });
}
function resolveLinkWorkspace(context = {}) {
  const id = context.conversationId;
  if (typeof id !== 'string' || !WORKSPACE_UUID.test(id)) throw new Error('请先创建或打开一个对话');
  const saved = fs.existsSync(convFilePath(id)) ? loadConversation(id) : null;
  // Saved project membership owns the link roots. A model link or renderer
  // parameter cannot replace them; active shell cd events do not broaden them.
  const resolved = resolveExecutionWorkspace({ conversationId: id,
    projectId: saved ? undefined : context.projectId,
    workingDir: saved ? directoryValue(saved.workingDir) : context.workingDir,
    agentName: saved ? saved.agent : context.agentName, mode: saved ? saved.mode : context.mode });
  const live = liveSessions.get(id);
  return { ...resolved, roots: [resolved.root, resolved.scratchDir],
    wslDistribution: live?.launchSpec?.wslDistribution || saved?.sdkSessionContext?.wslDistribution || undefined };
}
const workspaceTools = registerWorkspaceTools({
  ipcMain, getWindow: () => mainWindow, resolveWorkspace: resolveWorkspaceForTools, resolveLinkWorkspace, shell,
  resolveTerminal: input => generalPreferences.resolveTerminal(input),
  openFile: (file, target) => generalPreferences.openFile(file, target),
  getReviewFindings: id => loadConversation(id)?.sdkReviewFindings || null,
  readRuntimeFile: async (context, file) => {
    const sess = liveSessions.get(context?.conversationId);
    if (!sess || sess.dead || sess.launchSpec.agentEnvironment !== 'wsl') return { handled: false };
    const epoch = sess.observer.epoch, cwd = sess.launchSpec.runtimeCwd;
    const value = await withLiveControlTimeout(sess.child.readFile(file.replace(/\\/g, '/'), { maxBytes: 8 * 1024 * 1024, encoding: 'base64' }), '读取运行环境文件');
    if (sess.dead || liveSessions.get(context.conversationId) !== sess || epoch !== sess.observer.epoch || cwd !== sess.launchSpec.runtimeCwd) throw Error('会话工作目录已变化，请重新打开文件');
    return { handled: true, value };
  },
});
const browserPanelTools = require('./browser-panel-ipc').registerBrowserPanelIpc({
  ipcMain, getWindow: () => mainWindow, entryFile: path.join(__dirname, 'renderer', 'index.html'),
});
const attachmentDialog = registerNativeAttachmentDialog({
  ipcMain, getWindow: () => mainWindow, dialog,
});

// ─────────────────────────────────────────
// IPC: 启动一次 claude 对话
// ─────────────────────────────────────────
ipcMain.handle('claude:steer', (_event, request) => steerLiveTurn(request));

ipcMain.handle('claude:run', (event, request) => runClaudeRequest(event, request));

async function runClaudeRequest(event, { prompt, sessionId, sessionRoute, mode, files, model, effort, agentName, workingDir, orchestrateAgents, convId, forceFreshSession, runId: requestedRunId, sourceConvId, taskContext, executionMode, taskStartedAt } = {}) {
  let taskClock = new TaskClock({ startedAt: taskStartedAt ?? taskContext?.taskStartedAt });
  if (!event.miniChat && miniChat && miniChat.isRunning() && miniChat.getConversationId() === (sourceConvId || convId)) {
    return { ...taskClock.finish(), error: '这个对话正在快捷小窗中运行，请在小窗中继续补充要求。', code: 'MINI_TURN_ACTIVE' };
  }
  const runId = typeof requestedRunId === 'string' && /^[0-9a-f][0-9a-f-]{15,63}$/i.test(requestedRunId)
    ? requestedRunId
    : crypto.randomUUID();
  const originalPrompt = String(prompt || '');
  // mode='agent':让 Claude 用用户在 ~/.claude/agents 里安装的指定子智能体
  // mode='orchestrate':多 Agent 协同 —— 让主 Claude 当 PM,自主拆解并用 Task(实际工具名 Agent)委派给多个子智能体
  // mode='plain':纯 Claude 聊天,不触发任何 agent
  const useAgent = mode === 'agent' && agentName;
  const useOrchestrate = mode === 'orchestrate';
  const suppliedTaskContext = taskContext && typeof taskContext === 'object' && !Array.isArray(taskContext)
    ? taskContext : {};
  const taskConversationId = typeof sourceConvId === 'string' && sourceConvId ? sourceConvId : convId;
  let continuity;
  try {
    continuity = taskContinuityHost.resolve({ runId, conversationId: taskConversationId,
      executionConversationId: convId || taskConversationId, startedAt: taskClock.startedAt, taskContext: suppliedTaskContext, originalPrompt });
    taskClock = new TaskClock({ taskRun: continuity.taskRun });
  } catch (error) { return { ...taskClock.finish(), error: error.message, code: error.code }; }
  let selectedExecutionMode;
  try {
    selectedExecutionMode = normalizeExecutionMode(executionMode);
    const permissions = conversationPermissionSnapshot(sourceConvId || convId);
    selectedExecutionMode = permissions.executionMode;
  }
  catch (error) { return { ...taskClock.finish(), error: error.message, code: error.code }; }
  const rawInput = continuity.resumed
    ? previousConversationGoal(continuity.conversation || loadConversation(taskConversationId), runId) || continuity.logicalPrompt
    : typeof suppliedTaskContext.userPrompt === 'string' ? suppliedTaskContext.userPrompt : originalPrompt;
  const rawUserPrompt = selectedExecutionMode.kind === 'goal' && !continuity.resumed && suppliedTaskContext.goalExplicit && !/^\s*\/goal\s+/i.test(rawInput)
    ? `/goal ${rawInput}` : rawInput;
  try { prepareExecutionRequest(rawUserPrompt, prompt, selectedExecutionMode); }
  catch (error) { return { ...taskClock.finish(), error: error.message, code: error.code }; }
  const suppliedTurnRef = suppliedTaskContext.turnRef && typeof suppliedTaskContext.turnRef === 'object'
    ? suppliedTaskContext.turnRef : {};
  const turnIndex = Number.isSafeInteger(suppliedTurnRef.index) && suppliedTurnRef.index >= 0
    ? suppliedTurnRef.index : null;
  const turnTs = typeof suppliedTurnRef.ts === 'string' && Number.isFinite(Date.parse(suppliedTurnRef.ts))
    ? suppliedTurnRef.ts : null;
  if (liveTurnControls.isStopping(taskConversationId)) {
    return { ...taskClock.finish(), error: '正在暂停上一轮，请稍后重试。', code: 'TURN_STOPPING' };
  }
  let resolvedWorkspace;
  try {
    resolvedWorkspace = resolveExecutionWorkspace({ conversationId: taskConversationId || runId, workingDir, useAgent, agentName, mode });
  } catch (error) { return { ...taskClock.finish(), error: error.message || '无法打开对话工作目录' }; }
  let { cwd, validWorkingDir, agentProjectRoot } = resolvedWorkspace;
  let runtimeContract;
  try {
    runtimeContract = conversationRuntimeContract({ convId: taskConversationId, cwd, mode, agentName,
      model: activeRelayProviderRuntime({ tier: model }).modelId, effort, agentProjectRoot, providerRuntime: activeRelayProviderRuntime({ tier: model }) });
    const saved = loadConversation(taskConversationId);
    if (requiresFreshContract(saved, runtimeContract.fingerprint)) {
      sessionId = null; forceFreshSession = true;
      if (!String(prompt || '').includes('以下是我们之前的对话记录，供你参考延续：')) {
        const context = conversationContext(saved, { turnIndex }); if (context) prompt = `${context}\n\n${prompt || ''}`;
      }
    }
  } catch (error) { return { ...taskClock.finish(), error: error.message, code: error.code || 'RUNTIME_POLICY_INVALID' }; }

  const rejectedWorkspaceSession = !!sessionId && (resolvedWorkspace.workspaceChanged
    || !getConversationWorkspaces().acceptsSession(resolvedWorkspace.conversationId, sessionId));
  if (rejectedWorkspaceSession) { sessionId = null; forceFreshSession = true; }
  if ((resolvedWorkspace.needsContext || rejectedWorkspaceSession) && !String(prompt || '').includes('以下是我们之前的对话记录，供你参考延续：')) {
    const context = conversationContext(resolvedWorkspace.conversation, { turnIndex });
    if (context) prompt = `${context}\n\n${prompt || ''}`;
  }
  if (!await waitForCheckpointUnlock(cwd, taskConversationId)) {
    return { ...taskClock.finish(), error: '正在核验或回退这个工作区的文件检查点，请稍后再启动新任务。' };
  }
  let runTitle = compactText(originalPrompt, 80);
  try {
    const existingConv = taskConversationId ? loadConversation(taskConversationId) : null;
    if (existingConv && existingConv.title) runTitle = existingConv.title;
  } catch (_) {}
  try {
    const existing = taskLedger && taskLedger.get(runId);
    if (existing) return { ...taskClock.finish(), error: '任务标识重复，请重新发送。' };
  } catch (e) { console.warn('[task-ledger] 任务去重检查失败（继续原流程）: %s', e.message); }
  createShadowTaskRun({
    runId,
    state: RUN_STATES.QUEUED,
    phase: 'queued',
    kind: useOrchestrate ? 'orchestrate' : (useAgent ? 'agent' : 'chat'),
    trigger: 'user',
    title: runTitle || (files && files[0] && files[0].name) || '对话任务',
    priority: 100,
    source: {
      type: event.miniChat ? 'mini' : 'conversation',
      conversationId: taskConversationId || null,
      mode: mode || 'plain',
      agentName: useAgent ? agentName : null,
    },
    lineage: suppliedTaskContext.lineage && typeof suppliedTaskContext.lineage === 'object'
      ? {
          retryOf: typeof suppliedTaskContext.lineage.retryOf === 'string'
            ? suppliedTaskContext.lineage.retryOf.slice(0, 128) : null,
          continuationOf: typeof suppliedTaskContext.lineage.continuationOf === 'string'
            ? suppliedTaskContext.lineage.continuationOf.slice(0, 128) : null,
        }
      : null,
    execution: { jobId: runId, appInstanceId: TASK_EVENT_EPOCH, sessionId: sessionId || null },
    metadata: {
      requestHash: crypto.createHash('sha256').update(originalPrompt).digest('hex'),
      model: model || null,
      effort: effort || null,
      workingDir: cwd,
      turnIndex,
      turnTs,
      taskRun: continuity.taskRun,
    },
    progress: { label: '等待可用执行资源' },
  });
  const resourceLease = await acquireTaskResource(runId, 'claude', taskConversationId || null);
  if (!resourceLease) return { ...taskClock.finish(), error: '任务已取消', code: 'TURN_CANCELED' };
  const releaseStartSlot = () => resourceLease.release();
  // 任务可能在队列里等待了很久；检查点锁可能在等待期间才建立，拿到资源后必须二次验收。
  if (!await waitForCheckpointUnlock(cwd, taskConversationId, { signal: resourceLease.signal })) {
    releaseStartSlot();
    finishShadowTaskRun(runId, false, { error: '正在核验或回退这个工作区的文件检查点' });
    return { ...taskClock.finish(), error: '正在核验或回退这个工作区的文件检查点，请稍后再启动新任务。' };
  }
  if (resourceLease.signal && resourceLease.signal.aborted) {
    releaseStartSlot();
    finishShadowTaskRun(runId, false, { status: RUN_STATES.CANCELED, error: '任务已暂停' });
    return { ...taskClock.finish(), error: '任务已暂停', code: 'TURN_CANCELED' };
  }
  if (liveTurnControls.isStopping(taskConversationId)) {
    releaseStartSlot();
    finishShadowTaskRun(runId, false, { error: '正在暂停上一轮' });
    return { ...taskClock.finish(), error: '正在暂停上一轮，请稍后重试。', code: 'TURN_STOPPING' };
  }
  try {
    if (taskLedger) taskLedger.update(runId, {
      state: RUN_STATES.STARTING,
      phase: 'preparing',
      executorState: 'active',
      progress: { label: '正在准备' },
    });
  } catch (e) {
    releaseStartSlot();
    return { ...taskClock.finish(), error: e.message || '任务无法开始' };
  }
  // 工作目录:使用用户显式目录，未指定时使用本对话独立的 RelayProjects 归档目录。
  //   cwd 决定相对路径基准 + LLM 文件读写落点;同时下面用 --add-dir 显式授权。
  //   注:用户级 Agent/技能在 ~/.claude 下,与 cwd 无关(--setting-sources user 已加载),
  //   故改 cwd 不影响子智能体发现(已实测验证)。
  // 项目级 Agent 的配套资源根:本轮用的 agent 是「带知识库的完整包」(导入时记录了
  //   agentProjects 映射)时,它内部会用相对路径读 `knowledge/xxx` 等随包资源。
  //   把项目根单独记下来(与 cwd 解耦),后面据它做两件事:
  //     ① 始终 --add-dir 授权该目录(否则即便给绝对路径也会被权限拦);
  //     ② 用户另选了工作目录时,在 prompt 里告知资源的绝对路径(相对路径基准已不是项目根)。
  // Selected Agents run natively via Options.agent/agents. Relay retains
  // resource paths and provider ownership in the validated runtime contract.
  if (useOrchestrate) {
    const all = listAgentNames();   // [{ name, file, desc, displayName }]
    const pick = Array.isArray(orchestrateAgents) && orchestrateAgents.length
      ? all.filter((a) => orchestrateAgents.includes(a.name))
      : all;
    if (pick.length) {
      const roster = pick
        .map((a) => `- ${a.name}：${(a.desc || '(无描述)').replace(/\s+/g, ' ').slice(0, 200)}`)
        .join('\n');
      prompt = `你现在是「任务编排者(PM)」。你有以下可用的子智能体(subagent),请阅读它们的描述,把用户的任务拆解成子任务,用 Agent 工具【分别派发】给最合适的子智能体并行或接力完成,最后把各子智能体的产出汇总成给用户的最终结论。

可用子智能体：
${roster}

⚠️ 关键前提:每个子智能体都在【完全独立、互相隔离】的上下文里运行。它看不到用户的原始任务、看不到你的规划、更看不到其他子智能体的产出——它只能读到你在 Agent 委派提示里写给它的那段文字。因此「上游→下游」的所有信息流转,完全取决于你在派活时写了什么。

编排规则：
1. 先用一两句话说明你打算怎么拆解、派给谁(让用户看得到你的规划)。
2. 【只有 Agent 工具才会真正启动子智能体】通过 Agent 工具委派,不要自己直接完成子智能体擅长的活;有依赖关系的子任务按顺序派、可并行的就并行派。TaskCreate/TaskUpdate/TaskList 只是可选的进度看板,绝不代表子智能体已经启动。
3. 【传递上游原文,不要自己转述概括】给下游派活时,把它需要依赖的上游子智能体产出【原文整段贴进】委派提示,而不是你压缩成一两句。下游基于完整素材作业,质量才不打折。
4. 【保留并继承标注】上游若标了「推断/假设/置信度低/待核实」等限定词,派给下游时必须原样带上;不要把"推断"在传递中悄悄变成"事实"。
5. 【统一口径】在首次派活时就约定全局一致的口径——时间粒度(如统一用季度还是按周)、术语表、单位、命名——并把这份约定写进【每一个】子任务的委派提示,避免各子智能体各说各话。
6. 【风险回流要二次派活】子智能体返回的产出里若包含风险、矛盾、对上游的质疑或新发现的约束,不要只在最终汇总里一笔带过——若它会影响已完成的上游环节,主动【再发起一轮】Agent 把这个反馈传回相关子智能体修正。单向流水线会漏掉这类问题。
7. 【逐一核对真实启动】计划并行 N 个子任务时,必须实际产生 N 次独立的 Agent 工具调用,并分别收到启动回执。进入等待前按真实 Agent 调用逐一核对;缺一个就立即补派。不得因为创建了 Task 看板、修改了 in_progress 状态或自己写了“已启动”文字,就声称对应 Agent 已运行。
8. 【后台启动回执不是产出】Agent 工具可能先返回 "Async agent launched successfully"、agentId、output_file 等后台启动元数据。此时子智能体仍在运行,绝不能把这段回执当成结果、也不能结束任务或让用户重发需求。继续等待对应的完成通知和真实输出;若有下游接力,拿到上游真实产出后再派发。
9. 所有实际启动的子智能体都返回真实产出后,综合它们给出最终汇总;若过程中做过二次派活,说明修正了什么。

---
用户的任务：
${prompt}`;
    }
    // pick 为空(没装任何 agent)时不注入,退化为普通对话 —— 前端入口已拦截无 agent 的情况,这里只是兜底。
  }
  // 附件保持宿主路径，交给 SDK 输入边界按本会话环境映射并读取图片内容。
  if (Array.isArray(files) && files.length && !prompt) prompt = '请查看我上传的文件。';
  // 飞书轮:追加系统提示,引导模型用 feishu-mcp-pro 工具(并等其就绪),不要退化抓网页。
  //   常驻会话池已让 MCP 在用户打字时就连好,这条 hint 只兜「开窗即发」的边缘案例;
  //   保留它的理由:纯 prompt 文本,跨 claude 版本永不失效,是最廉价的保险。
  if (promptNeedsFeishu(prompt)) prompt = `${prompt}${FEISHU_HINT}`;
  // 每轮都追加交互须知：优先使用 AskUserQuestion。Relay 会把提问与权限请求
  //   显示为输入框上方的专属决策卡，并在用户答复后继续同一轮。
  prompt = `${prompt}${ASK_HINT}${IMAGE_HINT}`;
  // 宿主固定项目、来源和明确记住的请求；模型不能通过工具参数自行升级确认状态。
  const memoryContext = { projectId: runtimeContract?.projectId || resolvedWorkspace.projectId || null,
    sourceRef: 'conversation:' + (taskConversationId || 'legacy') + '/run:' + runId,
    userConfirmed: /^(?:请|帮我)?(?:记住|记一下|记下)|^remember\b/i.test(String(originalPrompt || '').trim()) };
  memoryRequestContexts.set(runId, memoryContext);
  while (memoryRequestContexts.size > 256) memoryRequestContexts.delete(memoryRequestContexts.keys().next().value);
  prompt = `${prompt}${buildMemoryHint(selectedExecutionMode.kind === 'plan' ? 'read' : 'full', originalPrompt, memoryContext)}`;

  // 防御:用户输入以 - 开头时,CLI 参数解析器会把它当成命令行选项(如 -i / -u / -P),
  //   导致 "error: unknown option" 后静默退出、回复为空。加一句安全前缀消除歧义。
  if (prompt.trimStart().startsWith('-')) {
    prompt = '以下是用户的输入内容：\n' + prompt;
  }

  // 对话内管理定时任务:非 agent/协同 模式时挂 cron MCP。
  //   注意:常驻会话下 MCP 是 spawn 时定死的,不能像以前那样「按本轮 prompt 像不像定时任务」临时挂 ——
  //   那会让每次判定翻转都重启进程(丢掉常驻的全部意义)。cron MCP 是 Relay 自己的本地 node 脚本、
  //   毫秒级启动、工具也少,常挂的代价远小于反复重启,故这里固定挂。
  //   (一次性回退路径仍沿用旧的按轮判定 —— 它每轮都新起进程,没有这个约束。)
  const cronOk = mode !== 'agent' && mode !== 'orchestrate';
  try {
    if (taskLedger) taskLedger.update(runId, {
      metadata: { workingDir: cwd },
    });
  } catch (_) {}
  const onEvent = (evt) => {
    evt = taskClock.stamp(evt);
    taskContinuityHost.observe(runId, evt);
    if (TaskClock.isRootEvent(evt) && ['assistant', 'result'].includes(evt.type)) {
      try { getConversationWorkspaces().markContextCarried(resolvedWorkspace.conversationId); }
      catch (error) { console.warn('[workspace] 记录上下文接续失败: %s', error.message); }
    }
    journalClaudeEvent(runId, evt);
    try { event.sender.send('claude:event', evt); }
    catch (e) { console.error('[claude:run] 事件转发失败: %s type=%s', e.message, evt && evt.type); }
    enqueueShadowClaudeEvent(runId, evt);
    if (evt && evt.type === 'job-done' && TaskClock.isRootEvent(evt)) {
      // 先把 job-done 同步落成终态，再释放租约；否则旧 active 状态会继续占池且无人再触发补位。
      flushShadowTaskEvents(runId);
      releaseTaskResource(runId);
    }
  };

  let safeSessionId = sessionId;
  let safeForceFreshSession = !!forceFreshSession;
  // A fresh Query has no transcript until its first input was absorbed. It may
  // already be reserved or have survived a pause during MCP preparation.
  const prewarmedSession = liveSessions.get(convId);
  if (prewarmedSession && (prewarmedSession.prewarm || prewarmedSession.nativeContextReady === false)
      && !prewarmedSession.dead && !prewarmedSession.busy) {
    safeSessionId = null;
    safeForceFreshSession = true;
  }
  try {
    const targetRuntime = activeRelayProviderRuntime({ tier: model });
    const targetRoute = providerSessionRoute(targetRuntime, model);
    const stored = loadConversation(taskConversationId);
    const storedRoute = stored?.sdkSessionContext?.routing;
    if (!safeSessionId && !safeForceFreshSession && stored?.sessionId
        && stored.sdkSessionContext?.sessionId === stored.sessionId
        && workspaceKey(stored.sdkSessionContext.hostCwd || stored.sdkSessionContext.cwd) === workspaceKey(cwd)
        && stored.sdkRuntimeFingerprint === runtimeContract.fingerprint
        && sessionRouteMatchesProvider(storedRoute, targetRoute)
        && getConversationWorkspaces().acceptsSession(taskConversationId, stored.sessionId)) {
      // A renderer refresh can lose its local handle. Prefer the host's durable
      // identity before degrading to a new session and a bounded text bridge.
      safeSessionId = stored.sessionId;
      sessionRoute = storedRoute;
    }
    if (safeSessionId && !sessionRouteMatchesProvider(sessionRoute, targetRoute)) {
      safeSessionId = null;
      safeForceFreshSession = true;
      if (!String(prompt || '').includes('以下是我们之前的对话记录，供你参考延续：')) {
        const context = conversationContext(loadConversation(taskConversationId), { turnIndex });
        if (context) prompt = `${context}\n\n${prompt || ''}`;
      }
    }
  } catch (_) {}

  if ((!safeSessionId || safeForceFreshSession)
      && !String(prompt || '').includes('以下是我们之前的对话记录，供你参考延续：')) {
    const context = conversationContext(loadConversation(taskConversationId), { turnIndex });
    if (context) prompt = `${context}\n\n${prompt || ''}`;
  }

  try {
    await getConversationPermissions().withSnapshot(taskConversationId || null, permissions => {
      selectedExecutionMode = permissions.executionMode;
    });
  } catch (error) {
    releaseStartSlot(); finishShadowTaskRun(runId, false, { error: error.message });
    return { ...taskClock.finish(), error: error.message, code: error.code || 'PERMISSION_READ_FAILED' };
  }
  const executionRequest = prepareExecutionRequest(rawUserPrompt, prompt, selectedExecutionMode);
  if (continuity.resumed) executionRequest.goalExplicit = false;
  prompt = executionRequest.prompt;

  // 主路径:常驻会话(需要 convId 做稳定的池 key)。复用上下文，发送前同步并核对 MCP 状态。
  if (convId) {
    const liveRun = runLiveTurn({
      convId, prompt, files, executionRequest, cwd, validWorkingDir, agentProjectRoot, model, effort, runtimeContract, mode, agentName,
      sessionId: safeSessionId, sessionRoute,
      attachCronMcp: cronOk, forceFreshSession: safeForceFreshSession,
      // 普通对话、指定 Agent 和协奏都可能在运行中自主派遣后台 Agent。
      // 常驻会话必须统一保持事件监听；只有协奏额外启用虚假等待纠偏。
      keepAliveForAsyncAgents: true, orchestrateMode: useOrchestrate, onEvent, runId,
      taskStartedAt: taskClock.startedAt, taskRun: continuity.taskRun,
    });
    if (liveRun) {
      if (liveRun.error) {
        releaseStartSlot();
        finishShadowTaskRun(runId, false, { error: liveRun.error });
      }
      return { ...liveRun, ...(liveRun.error ? taskClock.finish() : taskClock.snapshot()), ...(event.miniChat ? { workingDir: cwd } : {}) };
    }
    console.warn('[claude:run] 常驻会话不可用,本轮回退一次性 job convId=%s', convId);
  }

  // A resumed native session may still contain /goal even if this request is
  // ordinary mode. Only the live preparation handshake can safely clear it.
  if (selectedExecutionMode.kind !== 'default' || safeSessionId) {
    const error = '当前会话暂时无法完成模式准备，请稍后重试';
    releaseStartSlot(); finishShadowTaskRun(runId, false, { error });
    return { ...taskClock.finish(), error, code: 'MODE_REQUIRES_LIVE_SESSION' };
  }
  // 回退:没有 convId(旧前端/边缘路径)或常驻位全忙 —— 行为与改造前完全一致。
  try {
    const launched = runClaudeJob({
      prompt, files, cwd, validWorkingDir, agentProjectRoot, model, effort, sessionId: safeSessionId,
      sessionRoute, runtimeContract,
      attachCronMcp: cronOk && promptMaybeCron(prompt),
      onEvent, runId, conversationId: taskConversationId || convId || null, userMessageId: runId,
      taskStartedAt: taskClock.startedAt, taskRun: continuity.taskRun,
      permissionMode: conversationPermissionSnapshot(taskConversationId).permissionMode,
    });
    return {
      ...(event.miniChat ? { workingDir: cwd } : {}),
      jobId: launched.jobId,
      ...taskClock.snapshot(),
      providerId: launched.providerId,
      providerRevision: launched.providerRevision,
      agentEnvironment: launched.agentEnvironment || 'native',
      routeTier: launched.routeTier,
      routeRevision: launched.routeRevision,
    };
  } catch (e) {
    releaseStartSlot();
    console.error('[claude:run] 启动失败: %s', e.message);
    finishShadowTaskRun(runId, false, { error: e.message || 'Claude Code 启动失败' });
    return { ...taskClock.finish(), error: e.message || 'Claude Code 启动失败' };
  }
}
// IPC: 丢弃某对话的常驻会话 + 墓碑。
//   给前端的降级重跑路径(relaunchWithoutResume)用:那条路正是因为 --resume 接不回才走的,
//   此时该对话的 session_id 已经是坏的。若不连墓碑一起清掉,下一轮 runLiveTurn 会拿着同一个
//   坏 id 再 --resume 一次,等于刚降级完又坏回去。
ipcMain.handle('claude:clearContext', async (_event, { conversationId } = {}) => {
  const sess = liveSessions.get(conversationId);
  if (!sess || sess.dead || sess.busy || sess.executionMode?.kind !== 'plan') return { ok: false, error: '请在计划完成后清空上下文' };
  try {
    const epoch = sess.observer?.epoch;
    const result = await sess.child.clearContext();
    if (sess.dead || liveSessions.get(conversationId) !== sess || !result?.ok || sess.observer?.epoch === epoch) return { ok: false, error: '执行器已变化，请重新确认' };
    // Idle clears have no active renderer turn to store a reset event in.
    // Preserve that boundary independently so a later fresh session cannot
    // silently restore the discarded context from visible conversation history.
    const record = loadConversation(conversationId);
    if (!record) return { ok: false, error: '对话已不存在' };
    record.sdkContextBoundary = { turnIndex: (record.turns || []).length,
      afterRunId: record.turns?.at(-1)?.runId || null };
    persistConversationRecord(record);
    return { ok: true, sessionId: sess.sessionId, sdkContextBoundary: record.sdkContextBoundary };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('claude:dropSession', (_e, convId) => {
  if (!convId) return { dropped: false };
  const sess = liveSessions.get(convId);
  if (sess) killLiveSession(sess, '前端要求丢弃(降级重跑)');
  liveTombstones.delete(convId);   // 必须在 kill 之后 —— killLiveSession 会写墓碑
  console.log('[live] 已丢弃 convId=%s 的常驻会话与墓碑', convId);
  return { dropped: true };
});

// 等待旧 claude 进程退出，避免重新加载时旧/新两套 MCP 在短时间内重叠。
// 超时只代表旧进程退出事件没及时到；SIGTERM 已发出，不阻断新运行时拉起。
function waitForChildClose(child, timeoutMs = 1500) {
  if (!child || child.exitCode != null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    child.once('close', finish);
  });
}

// IPC:为当前 Relay 对话创建全新 Claude session，让 MCP 工具清单从零重新发现。
// 正常发送会在原 Query 内同步配置并检查连接；这里保留用户主动要求全新会话的恢复入口。
// 对话上下文由 renderer 在下一条消息里以 Relay 历史文本带入，不依赖旧 Claude session。
ipcMain.handle('claude:resetSession', async (_e, { convId, mode, model, effort, agentName, workingDir } = {}) => {
  let resetCommitted = false;
  try {
    if (!convId) return { ok: false, message: '请先打开一个已有对话' };

    const sess = liveSessions.get(convId);
    if (sess && !sess.dead && sess.busy) return { ok: false, busy: true, message: '当前对话还在回复中，请结束后再重新加载' };
    const workspace = resolveExecutionWorkspace({ conversationId: convId, workingDir, agentName, mode });
    if (sess && !sess.dead) {
      const launchSpec = { ...(sess.launchSpec || {}), ...workspace };
      const closed = waitForChildClose(sess.child);
      killLiveSession(sess, '用户重新加载 MCP');
      await closed;
      // killLiveSession 会把旧 session_id 写进墓碑。必须在 kill 之后删掉，
      // 否则 spawn/prespawn 会又从墓碑取回旧 id，隐式恢复成 --resume。
      liveTombstones.delete(convId);
      resetCommitted = true;
      if (!evictIfNeeded()) return { ok: true, restarted: false, deferred: true };
      const fresh = spawnLiveSession({ ...launchSpec, convId, sessionId: null });
      console.log('[live] MCP 全新会话已启动 convId=%s oldPid=%s newPid=%s',
        convId, sess.child && sess.child.pid, fresh.child && fresh.child.pid);
      return { ok: true, restarted: true };
    }

    // 运行时已被闲置/LRU 回收时也要清墓碑，防止下一轮自动续接旧 session。
    liveTombstones.delete(convId);
    resetCommitted = true;
    // 普通对话可直接预启动；Agent/协同会话会在下一条消息时按完整 prompt 参数创建。
    if (mode === 'agent' || mode === 'orchestrate') {
      return { ok: true, restarted: false, deferred: true };
    }
    const fresh = prespawnSession({
      ...workspace, convId, model, effort,
      sessionId: null,
      attachCronMcp: true,
    });
    return fresh
      ? { ok: true, restarted: true }
      : { ok: true, restarted: false, deferred: true };
  } catch (e) {
    console.error('[live] MCP 全新会话启动失败 convId=%s: %s', convId, e.message);
    // 旧 session 一旦已丢弃就不能让 renderer 退回旧 id。预启动失败时改为延迟创建，
    // 下一条消息仍会带 forceFreshSession 重试，不再 --resume 旧工具集。
    if (resetCommitted) return { ok: true, restarted: false, deferred: true };
    return { ok: false, message: e.message || '重新加载失败' };
  }
});

// IPC: 预启动常驻会话 —— 前端在【打开/切换对话】时调用(fire-and-forget)。
//   提前启动可让 MCP 在用户输入时开始连接，但预启动完成不代表所有工具已经就绪。
//   每轮发送前仍会检查真实状态；预启动失败时 claude:run 会照常创建会话。
ipcMain.handle('claude:prespawn', async (_e, { convId, sessionId, sessionRoute, mode, model, effort, agentName, workingDir }) => {
  try {
    if (!convId) return { ok: false };
    if (mode === 'agent' || mode === 'orchestrate') return { ok: false, skipped: 'agent 模式的 prompt 包装依赖本轮内容,不预启动' };
    const workspace = resolveExecutionWorkspace({ conversationId: convId, workingDir, agentName, mode });
    const sess = prespawnSession({
      ...workspace, convId, model, effort,
      sessionId: sessionId || null, sessionRoute, attachCronMcp: true,
    });
    return { ok: !!sess };
  } catch (e) {
    console.warn('[live] prespawn 失败(忽略): %s', e.message);
    return { ok: false };
  }
});

function collectRouteTimings() { return routeTimingHistory.snapshot(); }
ipcMain.handle('claude:applyRuntimeFlags', async (event, convId) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const sess = liveSessions.get(convId); if (!sess || sess.dead) return { ok: false, message: '会话执行器未连接' };
  const epoch = sess.observer.epoch;
  const policy = buildRuntimePolicy({ settings: readAppSettings() });
  const flags = Object.fromEntries(['autoCompactEnabled', 'showThinkingSummaries', 'bashOutputMaxChars', 'taskOutputMaxChars']
    .filter(key => Object.hasOwn(policy.settings, key)).map(key => [key, policy.settings[key]]));
  if (!Object.keys(flags).length) return { ok: false, message: '已保存的设置均沿用默认值，下次启动时恢复默认' };
  try {
    await withLiveControlTimeout(sess.child.applyFlagSettings(flags), '应用运行选项');
    if (sess.dead || liveSessions.get(convId) !== sess || epoch !== sess.observer.epoch) return { ok: false, stale: true };
    sess.appliedRuntimeFlags = flags; return { ok: true, applied: Object.keys(flags) };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('claude:commands', async (event, convId) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const sess = liveSessions.get(convId); if (!sess || sess.dead) return { ok: true, items: [] };
  const epoch = sess.observer.epoch, revision = sess.observer.native.revision;
  try {
    const raw = await withLiveControlTimeout(sess.child.supportedCommands(), '读取可用命令');
    if (sess.dead || liveSessions.get(convId) !== sess || epoch !== sess.observer.epoch || revision !== sess.observer.native.revision) return { ok: false, stale: true, items: [] };
    const skills = new Set(sess.observer.catalog.skills || []);
    return { ok: true, items: raw.filter(x => skills.has(x.name) || x.name.includes(':')).map(x => ({ name: x.name, callName: x.name, desc: x.description, summary: x.description, argumentHint: x.argumentHint, source: 'sdk' })) };
  } catch (error) { return { ok: false, message: error.message, items: [] }; }
});
ipcMain.handle('claude:stopTask', (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  return stopOwnedTask({ session: liveSessions.get(input.convId), convId: input.convId, jobId: input.jobId, taskId: input.taskId,
    isCurrent: sess => liveSessions.get(sess.convId) === sess });
});
ipcMain.handle('claude:backgroundTask', (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  if (!input || typeof input !== 'object') return { ok: false, code: 'TASK_NOT_ACTIVE' };
  return backgroundOwnedTask({ session: liveSessions.get(input.convId), convId: input.convId, jobId: input.jobId, toolUseId: input.toolUseId,
    isCurrent: sess => liveSessions.get(sess.convId) === sess });
});
ipcMain.handle('claude:reloadPlugins', async event => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  return { ok: true, ...await reloadSkillsInLiveSessions('plugins-refresh') };
});
ipcMain.handle('sdkPlugins:list', event => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try { return { ok: true, items: getSdkPluginStore().list() }; } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('sdkPlugins:add', async event => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const selected = await dialog.showOpenDialog(mainWindow, { title: '添加本地 SDK 插件', properties: ['openDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
  try { return { ok: true, item: getSdkPluginStore().add(selected.filePaths[0]) }; } catch (error) { return { ok: false, message: error.message }; }
});
for (const operation of ['update', 'remove']) ipcMain.handle('sdkPlugins:' + operation, async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try {
    const item = getSdkPluginStore()[operation](input.id, input.patch);
    // Plugin search roots are Query options. Reload refreshes an existing root;
    // a changed list requires the next executor to capture a new contract.
    for (const sess of liveSessions.values()) if (!sess.busy) killLiveSession(sess, '本地插件配置已更新');
    return { ok: true, item, nextTurn: true };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('claude:openTaskResource', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const saved = loadConversation(input.convId);
  const sess = liveSessions.get(input.convId);
  const resource = ownedResource(mergeResources(saved?.sdkTaskResources, sess?.taskResources || []), input);
  if (!resource) return { ok: false, message: '资源不属于这个对话的任务，或记录已过期' };
  try {
    const target = resourceTarget(resource);
    if (target.kind === 'file') {
      if (!fs.existsSync(target.path)) return { ok: false, message: '任务输出文件已不存在或当前环境无法访问' };
      // Reveal rather than execute an untrusted resource as a program.
      shell.showItemInFolder(target.path);
      return { ok: true, revealed: true };
    }
    return { ok: true, ...target };
  } catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('claude:contextDetails', async (event, convId) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const sess = liveSessions.get(convId);
  if (!sess || sess.dead) return { ok: false, message: '会话执行器未连接' };
  if (sess.fullContextPending) return withLiveControlTimeout(sess.fullContextPending, '读取上下文明细', 15000)
    .catch(() => ({ ok: false, message: '统计仍在进行，请稍后查看' }));
  const key = contextRuntimeKey(sess);
  const pending = sess.child.getContextUsage({ detail: 'full' }).then(raw => {
    if (sess.dead || liveSessions.get(convId) !== sess || key !== contextRuntimeKey(sess)) return { ok: false, stale: true };
    return { ok: true, sampledAt: new Date().toISOString(), estimated: true, totalTokens: raw.totalTokens,
      categories: (raw.categories || []).map(x => ({ name: String(x.name || ''), tokens: Number(x.tokens) || 0, deferred: !!x.isDeferred })) };
  }).catch(error => ({ ok: false, message: error.message }));
  // Keep the actual request reserved even if the UI's bounded wait expires.
  sess.fullContextPending = pending;
  pending.finally(() => { if (sess.fullContextPending === pending) sess.fullContextPending = null; });
  return withLiveControlTimeout(pending, '读取上下文明细', 15000).catch(() => ({ ok: false, message: '统计仍在进行，请稍后查看' }));
});

// IPC: 模型能力与轻量上下文快照。运行中 contextOnly 请求跳过模型目录且不写历史。
ipcMain.handle('claude:runtimeInfo', async (_e, convId, options = {}) => {
  const sess = convId ? liveSessions.get(convId) : null;
  if (!sess || sess.dead) return { ok: true, connected: false, models: [], context: null };
  const key = contextRuntimeKey(sess);
  const contextOnly = options && options.contextOnly === true;
  try {
    const [models, context] = await Promise.all([
      contextOnly ? Promise.resolve(null) : readSupportedModels(sess).catch(() => sess.supportedModels || []),
      options && options.includeContext === false ? Promise.resolve(null) : readLiveContextUsage(sess, { persist: !contextOnly && !sess.busy }),
    ]);
    if (sess.dead || liveSessions.get(convId) !== sess || contextRuntimeKey(sess) !== key) {
      return { ok: true, connected: false, stale: true, models: [], context: null };
    }
    return {
      ok: true,
      connected: true,
      busy: !!sess.busy,
      model: sess.launchSpec && sess.launchSpec.model || null,
      routeTier: sess.launchSpec && sess.launchSpec.routeTier || null,
      providerId: sess.launchSpec && sess.launchSpec.providerId || null,
      providerRevision: sess.launchSpec && sess.launchSpec.providerRevision || 0,
      effort: sess.launchSpec && sess.launchSpec.effort || null,
      permissionMode: sess.permissionMode || null,
      capabilities: [...(sess.capabilities || [])],
      fastModeState: sess.fastModeState || null,
      fastModeDisabledReason: sess.fastModeDisabledReason || null,
      ...(contextOnly ? {} : { models, diagnostics: sess.observer?.snapshot(), agents: sess.supportedAgents || [] }),
      context,
    };
  } catch (e) {
    return { ok: false, connected: true, models: sess.supportedModels || [], context: null, message: e.message };
  }
});

// IPC:空闲常驻会话原地切换模型和 effort。成功后同步更新 fingerprint，确保下一轮继续复用
// 同一个 Query/MCP；会话尚未预启动时返回 deferred，由下一轮启动参数应用。
ipcMain.handle('claude:setRuntime', async (_e, { convId, model, effort } = {}) => {
  const targetTier = relayModelTier(model);
  let targetRuntime;
  try { targetRuntime = activeRelayProviderRuntime({ tier: targetTier }); }
  catch (error) { return { ok: false, message: error.message }; }
  const sess = convId ? liveSessions.get(convId) : null;
  if (!sess || sess.dead) {
    // 已被 LRU/闲置回收时不能在下一轮偷偷从旧墓碑恢复成旧模型；renderer 会按既有
    // 跨模型逻辑把 Relay 历史作为文字上下文带进新 session。
    if (convId) liveTombstones.delete(convId);
    return {
      ok: true,
      applied: false,
      deferred: true,
      routeTier: targetTier,
      model: targetRuntime.modelId,
      providerId: targetRuntime.id,
      providerRevision: targetRuntime.revision,
    };
  }
  if (sess.busy) return { ok: false, busy: true, message: '当前对话仍在回复中，请结束后再切换模型' };
  const cleanModel = targetRuntime.modelId;
  const cleanEffort = SDK_EFFORT_LEVELS.has(effort) ? effort : null;
  try {
    const sameProvider = sess.launchSpec
      && sess.launchSpec.providerId === targetRuntime.id
      && Number(sess.launchSpec.providerRevision || 0) === Number(targetRuntime.revision || 0)
      && (sess.launchSpec.agentEnvironment || 'native') === (targetRuntime.agentEnvironment || 'native');
    if (!sameProvider) {
      await killLiveSession(sess, '跨服务商切换模型');
      // 不把旧上游生成的 Claude session_id 交给另一个 Base URL。下一轮由 renderer
      // 携带 Relay 历史文本进入全新 session，避免认证和 thinking 签名串线。
      liveTombstones.delete(convId);
      return {
        ok: true,
        applied: false,
        deferred: true,
        restartRequired: true,
        routeTier: targetTier,
        model: cleanModel,
        effort: null,
        providerId: targetRuntime.id,
        providerRevision: targetRuntime.revision,
      };
    }
    // 目标准入由当前已配置路由决定。SDK 的目录是能力提示，可能只列 Claude
    // 别名，并不等于第三方网关的模型白名单；历史与新会话必须使用同一解析结果。
    let models = [];
    try { models = await readSupportedModels(sess); }
    catch (_) { models = Array.isArray(sess.supportedModels) ? sess.supportedModels : []; }
    if (sess.dead || liveSessions.get(convId) !== sess || sess.busy) {
      return { ok: false, message: '会话状态已变化，请重试切换模型' };
    }
    const info = models.find((item) => item.value === cleanModel || item.resolvedModel === cleanModel) || null;
    if (cleanEffort && info && info.supportedEffortLevels.length
        && !info.supportedEffortLevels.includes(cleanEffort)) {
      return { ok: false, message: `${info.displayName} 不支持 ${cleanEffort} effort` };
    }

    if (cleanModel && cleanModel !== sess.launchSpec.model) {
      await withLiveControlTimeout(sess.child.setModel(cleanModel), '切换模型');
    }
    const previousEffort = sess.launchSpec.effort || null;
    if (cleanEffort !== previousEffort) {
      await withLiveControlTimeout(
        sess.child.applyFlagSettings({ effortLevel: cleanEffort }), '切换推理强度',
      );
    }
    if (sess.dead || liveSessions.get(convId) !== sess) {
      return { ok: false, message: '会话已重新连接，请重试切换模型' };
    }
    sess.launchSpec.model = cleanModel || sess.launchSpec.model || null;
    sess.launchSpec.routeTier = targetTier;
    sess.launchSpec.providerId = targetRuntime.id;
    sess.launchSpec.providerRevision = targetRuntime.revision;
    sess.launchSpec.effort = cleanEffort;
    sess.effort = cleanEffort;
    sess.fingerprint = sessionFingerprint(sess.launchSpec);
    return {
      ok: true,
      applied: true,
      model: sess.launchSpec.model,
      routeTier: targetTier,
      providerId: targetRuntime.id,
      providerRevision: targetRuntime.revision,
      effort: cleanEffort,
      models,
    };
  } catch (e) {
    console.warn('[live] 运行时切换失败 convId=%s: %s', convId, e.message);
    return { ok: false, message: e.message || '运行时切换失败' };
  }
});

async function waitForLiveTurnIdle(sess, jobId, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sess || sess.dead || !sess.busy || sess.jobId !== jobId) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !sess || sess.dead || !sess.busy || sess.jobId !== jobId;
}

function settleUnsentLiveTurn(sess, jobId, message, aborted) {
  if (!sess || !sess.busy || sess.jobId !== jobId) return false;
  const onEvent = sess.onEvent;
  cancelPendingLiveInput(sess);
  const unappliedInputs = settleLiveSupplements(sess, aborted ? 'canceled' : 'rejected');
  sess.busy = false;
  sess.onEvent = null;
  sess.jobId = null;
  sess.turnRouter.end();
  sess.asyncAgentTracker.reset();
  sess.backgroundTaskTracker.reset();
  sess.keepAliveForAsyncAgents = false;
  sess.orchestrateMode = false;
  interactionBroker.rejectTask(jobId, { message, interrupt: false });
  if (checkpointManager) {
    try { markCheckpointUnavailable(jobId, '本轮输入尚未发送'); } catch (_) {}
  }
  touchIdleTimer(sess);
  refreshTrayMenu();
  if (onEvent) onEvent({ jobId, type: 'job-done', exitCode: -1, error: message, aborted: !!aborted, ...(unappliedInputs.length ? { relay_unapplied_inputs: unappliedInputs } : {}) });
  return true;
}

async function interruptLiveTurn(sess) {
  return liveTurnControls.interrupt(sess);
}

// IPC: 中止任务。一次性任务仍终止进程；常驻会话优先用 SDK interrupt() 只停当前轮，
// 控制接口失败或收尾超时时才回退到原来的整会话回收路径。
ipcMain.handle('claude:abort', async (_e, jobId) => {
  if (jobId) {
    // job-done 先同步转发给 renderer，再延后一拍落影子账本。执行器可能已从 jobs/liveSessions
    // 摘除；先冲刷该任务的队列，避免这条成功终态被“执行器不存在”误写成 interrupted。
    flushShadowTaskEvents(jobId);
    const child = jobs.get(jobId);
    if (child) {
      requestShadowTaskCancel(jobId);
      console.log('[claude:abort] 中止一次性任务 jobId=%s pid=%d', jobId, child.pid);
      try { child.kill('SIGTERM'); } catch (_) {}
      jobs.delete(jobId);
      refreshTrayMenu();
      return { aborted: true, jobId };
    }
    for (const sess of liveSessions.values()) {
      if (sess.busy && sess.jobId === jobId) {
        requestShadowTaskCancel(jobId);
        console.log('[claude:abort] 中止常驻轮 jobId=%s convId=%s pid=%d', jobId, sess.convId, sess.child.pid);
        return { ...(await interruptLiveTurn(sess)), jobId };
      }
    }
    console.warn('[claude:abort] 未找到任务 jobId=%s', jobId);
    let shadow = null;
    try {
      shadow = taskLedger && taskLedger.get(jobId);
      if (shadow && shadow.state === RUN_STATES.STOPPING) {
        return { aborted: true, pending: true, jobId, task: publicTaskRun(shadow) };
      }
      if (shadow && !isTerminalState(shadow.state)) {
        shadow = taskLedger.terminal(jobId, RUN_STATES.INTERRUPTED, {
          phase: 'terminal',
          executorState: 'stopped',
          progress: { label: '执行器已不存在' },
          result: { error: { code: 'EXECUTOR_MISSING', message: '未找到正在运行的执行器' } },
        });
      }
    } catch (e) { console.warn('[claude:abort] 缺失执行器对账失败 jobId=%s: %s', jobId, e.message); }
    return { aborted: false, jobId, task: publicTaskRun(shadow) };
  }
  // 无 jobId:全部中止
  let n = 0;
  for (const [id, child] of jobs) {
    requestShadowTaskCancel(id);
    console.log('[claude:abort] 批量中止 jobId=%s pid=%d', id, child.pid);
    try { child.kill('SIGTERM'); } catch (_) {}
    jobs.delete(id);
    n++;
  }
  const liveInterrupts = [];
  for (const sess of [...liveSessions.values()]) {
    if (!sess.busy) continue;
    requestShadowTaskCancel(sess.jobId);
    console.log('[claude:abort] 批量中止常驻轮 convId=%s pid=%d', sess.convId, sess.child.pid);
    liveInterrupts.push(interruptLiveTurn(sess));
    n++;
  }
  if (liveInterrupts.length) await Promise.allSettled(liveInterrupts);
  refreshTrayMenu();
  return { aborted: n > 0, count: n };
});

// Pause means interrupt-and-continue. It never claims to freeze a process.
ipcMain.handle('claude:pause', (_event, jobId) => pauseClaudeJob(jobId));

async function pauseClaudeJob(jobId) {
  if (typeof jobId !== 'string' || !jobId.trim()) {
    return { paused: false, settled: false, jobId: null, message: '缺少要暂停的任务' };
  }
  const outcome = (result) => {
    let task = null;
    if (result.alreadyFinished) {
      flushShadowTaskEvents(jobId);
      task = publicTaskRun(taskLedger && taskLedger.get(jobId));
    }
    return { ...result, paused: result.aborted === true && result.settled === true, jobId, ...(task ? { task } : {}) };
  };
  const pending = liveTurnControls.pendingResult(jobId);
  if (pending) return outcome(await pending);
  flushShadowTaskEvents(jobId);
  let run = taskLedger && taskLedger.get(jobId);
  if (run && isTerminalState(run.state)) {
    return { paused: false, settled: true, alreadyFinished: true, jobId, task: publicTaskRun(run) };
  }
  for (const session of liveSessions.values()) {
    if (session.busy && session.jobId === jobId) {
      requestShadowTaskCancel(jobId);
      return outcome(await interruptLiveTurn(session));
    }
  }
  const child = jobs.get(jobId);
  if (child) {
    requestShadowTaskCancel(jobId);
    interactionBroker.rejectTask(jobId, { message: '用户暂停了任务', interrupt: false });
    return outcome(await liveTurnControls.stopOneShot(child, jobId, run && run.source && run.source.conversationId));
  }
  if (run && [RUN_STATES.QUEUED, RUN_STATES.STARTING].includes(run.state) && taskOrchestrator) {
    taskOrchestrator.cancel(jobId, '用户暂停了尚未启动的任务');
    return { paused: true, settled: true, preservedSession: true, preparing: true, jobId };
  }
  return { paused: false, settled: false, jobId, code: run ? 'STOP_NOT_CONFIRMED' : 'NOT_REGISTERED',
    message: '任务尚未就绪或未能确认停止，请稍后重试' };
}

// 对话任务状态：快照是主进程账本的权威视图，renderer 仅按 revision 合并增量事件。
ipcMain.handle('tasks:snapshot', (_e, filter = {}) => {
  try {
    if (!taskLedger) throw new Error('task ledger unavailable');
    flushShadowTaskEvents();
    const limit = Number.isSafeInteger(filter && filter.limit)
      ? Math.min(Math.max(filter.limit, 0), 2000)
      : 200;
    const query = {};
    if (filter && typeof filter.kind === 'string') query.kind = filter.kind;
    if (filter && typeof filter.terminal === 'boolean') query.terminal = filter.terminal;
    if (filter && (typeof filter.state === 'string' || Array.isArray(filter.states))) {
      query.state = Array.isArray(filter.states) ? filter.states.slice(0, 20) : filter.state;
    }
    const all = taskLedger.list(query);
    // 历史终态可截断，但任何未完成任务都必须返回；否则长期运行的任务会被较新的
    // 已完成记录挤出快照，导致后台运行状态无法恢复。
    const items = selectTaskSnapshotRuns(all, {
      terminal: filter && filter.terminal,
      limit,
    });
    return {
      ok: true,
      epoch: TASK_EVENT_EPOCH,
      seq: taskEventSeq,
      items: items.map(publicTaskRun),
    };
  } catch (e) {
    console.warn('[task-ledger] 快照读取失败: %s', e.message);
    return { ok: false, epoch: TASK_EVENT_EPOCH, seq: taskEventSeq, items: [], error: '任务状态暂时不可用' };
  }
});

ipcMain.handle('tasks:get', (_e, runId) => {
  try {
    if (!taskLedger) throw new Error('task ledger unavailable');
    flushShadowTaskEvents(runId);
    return { ok: true, run: publicTaskRun(taskLedger.get(runId)) };
  }
  catch (_) { return { ok: false, run: null, error: '任务不存在' }; }
});

ipcMain.handle('tasks:replay', (_e, { epoch, sinceSeq = 0, limit = 1000 } = {}) => {
  try {
    flushTaskJournalEvents();
    if (!taskEventJournal) return { ok: false, resetRequired: true, events: [], error: '任务事件日志不可用' };
    return { ok: true, ...taskEventJournal.replay({ epoch, sinceSeq, limit: Math.min(Math.max(Number(limit) || 0, 0), 5000) }) };
  } catch (e) { return { ok: false, resetRequired: true, events: [], error: e.message }; }
});

ipcMain.handle('tasks:replayStream', (_e, { epoch, sinceSeq = 0, limit = 5000, runId } = {}) => {
  try {
    flushStreamJournalEvents();
    if (!streamEventJournal) return { ok: false, resetRequired: true, events: [], error: '流式事件日志不可用' };
    // Older epochs are only accessible through their owning run. Never accept
    // an arbitrary renderer-supplied filename or replay a different task's log.
    if (epoch && epoch !== TASK_EVENT_EPOCH) {
      const task = runId && taskLedger && taskLedger.get(runId);
      if (!task || task.execution?.appInstanceId !== epoch) throw new Error('任务日志与运行实例不匹配');
    }
    const replay = streamEventJournal.replayEpoch({
      epoch,
      sinceSeq,
      limit: Math.min(Math.max(Number(limit) || 0, 0), 20000),
      runId: runId || undefined,
    });
    return { ok: true, ...replay };
  } catch (e) { return { ok: false, resetRequired: true, events: [], error: e.message }; }
});

ipcMain.handle('tasks:progress', async (_e, runId) => {
  try {
    const task = runId && taskLedger && taskLedger.get(runId);
    if (!task) throw new Error('任务不存在');
    flushStreamJournalEvents();
    const progress = taskProgressStore ? await taskProgressStore.load(runId) : null;
    return { ok: true, progress: progress && progress.epoch === task.execution?.appInstanceId ? progress : null };
  } catch (error) { return { ok: false, progress: null, error: error.message }; }
});

ipcMain.handle('tasks:ack', (_e, { epoch, seq, stream = false, compact = false } = {}) => {
  try {
    const journal = stream ? streamEventJournal : taskEventJournal;
    if (!journal) throw new Error('事件日志不可用');
    return { ok: true, metadata: journal.ack({ epoch, seq, compact: !!compact }) };
  } catch (e) { return { ok: false, error: e.message }; }
});

async function cancelTaskByRunId(runId) {
  if (!taskLedger) return { ok: false, error: '任务系统不可用' };
  flushShadowTaskEvents(runId);
  let run = taskLedger.get(runId);
  if (!run) return { ok: false, error: '任务不存在' };
  if (isTerminalState(run.state)) return { ok: true, run: publicTaskRun(run), alreadyTerminal: true };
  interactionBroker.rejectTask(runId, { message: '用户停止了任务' });
  try {
    if (taskOrchestrator) run = taskOrchestrator.cancel(runId, '用户停止了任务');
    else requestShadowTaskCancel(runId);
  } catch (e) { console.warn('[tasks] orchestrator 取消失败 runId=%s: %s', runId, e.message); }

  // 定时任务同时由 scheduler 维护运行历史/通知。先同步它的取消控制器，再处理底层 child，
  // 避免 child 先退出后被 scheduler 误记为 failed。
  if (run.source && run.source.type === 'schedule'
      && scheduler && typeof scheduler.cancelRun === 'function') {
    try { scheduler.cancelRun(runId); } catch (_) {}
  }

  const child = jobs.get(runId);
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
    return { ok: true, pending: true, run: publicTaskRun(taskLedger.get(runId)) };
  }
  for (const sess of liveSessions.values()) {
    if (sess.busy && sess.jobId === runId) {
      const result = await interruptLiveTurn(sess);
      return { ok: true, pending: true, control: result, run: publicTaskRun(taskLedger.get(runId)) };
    }
  }
  if (scheduler && typeof scheduler.cancelRun === 'function') {
    try {
      const canceled = scheduler.cancelRun(runId);
      if (canceled) return { ok: true, pending: true, run: publicTaskRun(taskLedger.get(runId)) };
    } catch (_) {}
  }
  try {
    run = taskLedger.terminal(runId, RUN_STATES.CANCELED, {
      phase: 'terminal', executorState: 'stopped', progress: { label: '已取消' },
      result: { error: { code: 'EXECUTOR_MISSING', message: '执行器已经结束或无法重新连接' } },
    });
  } catch (_) { run = taskLedger.get(runId); }
  return { ok: true, run: publicTaskRun(run) };
}

function interactionCallerWindowId(event) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? String(win.id) : null;
  } catch (_) { return null; }
}

function interactionVisibleTo(event, interaction) {
  const caller = interactionCallerWindowId(event);
  return !!interaction && !!caller && String(interaction.windowId || '') === caller;
}

ipcMain.handle('interactions:list', (event, filter = {}) => {
  const windowId = interactionCallerWindowId(event);
  return { ok: true, items: windowId ? interactionBroker.list({ ...(filter || {}), windowId }) : [] };
});
ipcMain.handle('interactions:respond', (event, { id, decision } = {}) => {
  try {
    const interaction = interactionBroker.get(id);
    if (!interactionVisibleTo(event, interaction)) throw new Error('这个窗口无权处理该请求');
    interactionBroker.respond(id, decision || {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
});

ipcMain.handle('checkpoints:get', (_e, runId) => {
  try {
    if (!checkpointManager) throw new Error('文件检查点不可用');
    return { ok: true, checkpoint: checkpointManager.publicRecord(checkpointManager.get(runId)) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('checkpoints:preview', async (_e, runId) => {
  let releaseScope = null;
  try {
    if (!checkpointManager) throw new Error('文件检查点不可用');
    const record = checkpointManager.get(runId);
    if (!record) throw new Error('检查点不存在');
    if (checkpointWriteLocked(record.workspace, record.conversationId)) throw new Error('这个工作区已有检查点操作正在进行');
    const workspaceKey = normalizedWorkspaceKey(record.workspace);
    const conversationKey = record.conversationId ? String(record.conversationId) : null;
    const conflict = taskLedger && taskLedger.list({ terminal: false }).find((run) => {
      if (!run || run.runId === runId) return false;
      const sameWorkspace = workspaceKey
        && normalizedWorkspaceKey(run.metadata && run.metadata.workingDir) === workspaceKey;
      const sameConversation = conversationKey
        && run.source && String(run.source.conversationId || '') === conversationKey;
      return sameWorkspace || sameConversation;
    });
    if (conflict) throw new Error('同一对话或工作区仍有任务在写文件，无法安全预览');
    releaseScope = acquireCheckpointScope(record.workspace, record.conversationId);
    const checkpoint = await checkpointManager.preview(runId);
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('checkpoints:event', { type: 'checkpoint.updated', checkpoint }); } catch (_) {}
    if (!checkpoint || !checkpoint.available) {
      return {
        ok: false,
        checkpoint,
        error: checkpoint && checkpoint.unavailableReason
          || '原执行会话已经结束，无法再通过 Relay 一键撤销本任务的文件修改',
      };
    }
    return { ok: true, checkpoint };
  }
  catch (e) {
    try { emitCurrentCheckpoint(runId); } catch (_) {}
    return { ok: false, error: e.message, code: e.code || null, conflicts: e.conflicts || [] };
  }
  finally { if (releaseScope) releaseScope(); }
});
ipcMain.handle('checkpoints:rollback', async (_e, runId) => {
  let workspaceKey = null;
  let conversationKey = null;
  let releaseScope = null;
  let holdScope = false;
  try {
    if (!checkpointManager) throw new Error('文件检查点不可用');
    const record = checkpointManager.get(runId);
    if (!record) throw new Error('检查点不存在');
    workspaceKey = normalizedWorkspaceKey(record.workspace);
    conversationKey = record.conversationId ? String(record.conversationId) : null;
    if (checkpointWriteLocked(record.workspace, record.conversationId)) throw new Error('这个工作区已有文件回退正在进行');
    if (taskLedger) {
      const conflict = taskLedger.list({ terminal: false }).find((run) => {
        if (!run || run.runId === runId) return false;
        const sameConversation = conversationKey
          && run.source && String(run.source.conversationId || '') === conversationKey;
        const sameWorkspace = workspaceKey
          && normalizedWorkspaceKey(run.metadata && run.metadata.workingDir) === workspaceKey;
        return sameConversation || sameWorkspace;
      });
      if (conflict) throw new Error('同一对话或工作区仍有任务在写文件，已阻止回退');
    }
    releaseScope = acquireCheckpointScope(record.workspace, record.conversationId);
    const checkpoint = await checkpointManager.rollback(runId);
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('checkpoints:event', { type: 'checkpoint.updated', checkpoint }); } catch (_) {}
    return { ok: true, checkpoint };
  }
  catch (e) {
    holdScope = !!e.holdCheckpointLock;
    try { emitCurrentCheckpoint(runId); } catch (_) {}
    if (holdScope) {
      console.error('[checkpoint] 回退执行器停止状态不明，保留工作区锁 runId=%s', runId);
      if (releaseScope && e.releaseCheckpointLockWhen
          && typeof e.releaseCheckpointLockWhen.then === 'function') {
        const releaseHeldScope = releaseScope;
        Promise.resolve(e.releaseCheckpointLockWhen).then((confirmed) => {
          if (!confirmed) return;
          releaseHeldScope();
          markCheckpointUnavailable(
            runId,
            '回退执行器已停止；工作区锁已释放，但回退结果仍不确定，请先检查文件',
          );
          console.warn('[checkpoint] 迟到的停止确认已收到，释放工作区锁 runId=%s', runId);
        }).catch(() => {});
      }
    }
    return {
      ok: false,
      error: e.message,
      code: e.code || null,
      conflicts: e.conflicts || [],
      workspaceLocked: holdScope,
    };
  }
  finally {
    if (releaseScope && !holdScope) releaseScope();
  }
});

function broadcastSkillDraftEvent(type, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skillDrafts:event', { type, ...payload });
    }
  } catch (_) {}
}

async function skillDraftResult(fn, key = null) {
  try {
    if (!skillDraftService) throw new Error('Skill 草稿服务不可用');
    const value = await fn();
    return key ? { ok: true, [key]: value } : { ok: true, data: value };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null, details: e.details || null };
  }
}

// Keep app-owned live skill writes outside a worker's validation/swap window.
// Only the short filesystem transaction belongs here, not model calls or reloads.
function withSkillLibraryWrite(write) {
  return skillDraftService ? skillDraftService.runExclusive(write) : Promise.resolve().then(write);
}
ipcMain.handle('skillDrafts:list', (_e, filter = {}) => skillDraftResult(
  () => skillDraftService.list(filter), 'items',
));
ipcMain.handle('skillDrafts:diff', (_e, id) => skillDraftResult(
  () => skillDraftService.diff(id), 'diff',
));
ipcMain.handle('skillDrafts:validate', (_e, id) => skillDraftResult(
  () => skillDraftService.validate(id), 'validation',
));
ipcMain.handle('skillDrafts:rebase', async (_e, { id, options } = {}) => {
  const result = await skillDraftResult(() => skillDraftService.rebaseDraft(id, options || {}), 'result');
  if (result.ok) broadcastSkillDraftEvent('skillDraft.rebased', { draftId: id, result: result.result });
  return result;
});
ipcMain.handle('skillDrafts:publish', async (_e, id) => {
  const result = await skillDraftResult(() => skillDraftService.publish(id, published => {
    const draft = published && published.draft;
    try {
      if (draft && draft.skillName) {
        const sidecar = readSkillUsage();
        const record = sidecar[draft.skillName] || {};
        record.state = 'active';
        record.archivedAt = null;
        if (!record.firstSeenAt) record.firstSeenAt = new Date().toISOString();
        record.lastPatchedAt = new Date().toISOString();
        if (!record.createdBy && draft.sourceRef && draft.sourceRef.type === 'conversation-review') {
          record.createdBy = 'agent';
        }
        sidecar[draft.skillName] = record;
        writeSkillUsage(sidecar);
        getSkillMaintenanceHost().recordPublished(published);
        notifySkillUsageUpdated({ reason: 'draft-published', skillName: draft.skillName });
      }
    } catch (e) { console.warn('[skill-draft] 更新技能生命周期失败: %s', e.message); }
    broadcastSkillDraftEvent('skillDraft.published', { draftId: id, result: published });
  }), 'result');
  if (result.ok) result.liveReload = await reloadSkillsInLiveSessions('draft-published');
  return result;
});
ipcMain.handle('skillDrafts:reject', async (_e, { id, reason } = {}) => {
  const result = await skillDraftResult(() => skillDraftService.reject(id, reason), 'draft');
  if (result.ok) broadcastSkillDraftEvent('skillDraft.rejected', { draft: result.draft });
  return result;
});
ipcMain.handle('skillDrafts:history', (_e, skillName) => skillDraftResult(
  () => skillDraftService.listHistory(skillName), 'items',
));
ipcMain.handle('skillDrafts:rollback', async (_e, { skillName, versionId, options } = {}) => {
  const result = await skillDraftResult(() => skillDraftService.rollback(skillName, versionId, options || {}, restored => {
    try {
      const sidecar = readSkillUsage();
      if (restored && restored.restored && restored.restored.exists) {
        const record = sidecar[skillName] || {};
        record.state = 'active';
        record.archivedAt = null;
        record.restoredAt = new Date().toISOString();
        sidecar[skillName] = record;
        recordSkillActivity(skillName, 'restored');
      } else {
        delete sidecar[skillName];
        getSkillMaintenanceHost().forget(skillName);
      }
      writeSkillUsage(sidecar);
      notifySkillUsageUpdated({ reason: 'history-rollback', skillName });
    } catch (e) { console.warn('[skill-draft] 回滚后生命周期同步失败: %s', e.message); }
    broadcastSkillDraftEvent('skillDraft.rolledBack', { skillName, versionId, result: restored });
  }), 'result');
  if (result.ok) result.liveReload = await reloadSkillsInLiveSessions('history-rollback');
  return result;
});

// 按【视觉宽度】截断标题:汉字/全角算 2,英文/数字/半角算 1,上限 maxW(默认 24 ≈ 12 个汉字)。
//   关键点:不在英文/数字单词中间切。若到达上限时恰好处在一个 ASCII 单词内部,
//   回退到该单词起点之前(宁可短一点,也不留半个单词)。
// 把字符串切成字素簇:emoji(含 ZWJ 家庭如 👨‍👩‍👧)算一个整体,绝不拆成乱码。
// 会话标题保存上限:64 视觉宽，约 32 个汉字 / 64 个英文字符；显示由可伸缩侧栏自然省略。
//   所有标题(占位/AI 摘要/手动重命名/定时任务)最终都经 saveConversation 落盘,在那里统一收口。
const TITLE_MAX_W = 64;
function toGraphemes(str) {
  const s = String(str);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment); }
    catch (_) {}
  }
  return Array.from(s);
}
// 单个字素的视觉宽度:CJK/全角 = 2;emoji(增补平面)= 2;其余 = 1
function graphemeWidth(g) {
  const cp = g.codePointAt(0) || 0;
  if (cp > 0xffff) return 2;
  return cp > 0x2e7f ? 2 : 1;
}
function truncateByWidth(str, maxW = 24) {
  const gs = toGraphemes(str);
  let w = 0, out = '', lastSafe = '', prevWord = false;
  for (const g of gs) {
    const cw = graphemeWidth(g);
    const isWord = /^[0-9A-Za-z]$/.test(g);
    // 进入下一字素前,如果不在单词内部,记为安全截断点
    if (!(prevWord && isWord)) lastSafe = out;
    if (w + cw > maxW) {
      // 超限:卡在单词中间则回退到最近安全点;否则就地切(整串一个超长词时硬切,不返回空)
      return (prevWord && isWord && lastSafe) ? lastSafe : out;
    }
    out += g; w += cw; prevWord = isWord;
  }
  return out;
}

// IPC: 用最快档位给对话起一个简短标题(历史侧边栏用,豆包式摘要)
//   独立的一次性调用,不走流式、不占用 jobs 配额、不触发 agent。
async function generateConversationTitle(text) {
  if (!text) return { title: '' };
  const prompt =
    '为下面这段对话生成一个简短标题。要求:概括核心主题、' +
    '长度控制在约 32 个汉字以内(英文/数字按半个汉字宽度算,即纯英文标题可到约 64 个字符);' +
    '出现的英文单词或型号必须保持完整、不要在单词中间断开;' +
    '不要标点/引号/书名号/序号、只输出标题本身、不要任何解释。\n\n' +
    String(text).slice(0, 1200);
  const out = await runRelayText({
    prompt,
    cwd: os.homedir(),          // 纯聊天目录,绝不触发任何 Agent
    model: 'haiku',             // 最快档位,便宜且快
    timeoutMs: 30000,
  });
  // 取第一行非空文本,去掉「标题:」前缀、引号/书名号,按视觉宽度截断兜底(不切坏英文单词)
  //   上限 64 视觉宽，保持较完整的标题；窄侧栏通过 CSS 省略，拉宽可展示更多。
  //   不按当前侧栏宽度永久裁剪标题；已截短的旧标题不自动重写。
  let t = (String(out).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '');
  t = t.replace(/^标题\s*[:：]\s*/, '').replace(/["'「」『』《》]/g, '').trim();
  return { title: truncateByWidth(t, TITLE_MAX_W) };
}
ipcMain.handle('claude:title', (_e, { text }) => generateConversationTitle(text));


// Claude Code 运行时的「检查更新 / 一键更新」两个 IPC 已随内置运行时一起去掉：
//   运行时现在是 SDK 的平台包，版本由 package.json 锁定、跟着 Relay 一起发版，
//   用户不再能（也不需要）单独升级它 —— 这换来的是版本可控：不会因为用户或别的程序
//   升级了全局 CLI 而让 Relay 的行为在某天突然变掉。
//   设置页对应的行也从「可点击检查更新」改成了纯展示（见 renderer/app.js）。
//   运行时版本仍由 env:probe 报告。

// ─────────────────────────────────────────
// Relay 应用自更新(electron-updater,见 updater.js)
//   自动的只有「检查」,下载和安装都要用户在界面上点过才发生。
// ─────────────────────────────────────────
// IPC: 当前更新状态快照(设置页/气泡打开时拉一次,后续靠 relay:update-event 推送)
ipcMain.handle('relay:updateStatus', () => updater.getStatus());
// IPC: 手动触发一次检查(fire-and-forget,结果走事件推送)
ipcMain.handle('relay:checkUpdate', () => { updater.check(); return updater.getStatus(); });
// IPC: 用户确认更新 → 开始下载(进度走事件推送)
ipcMain.handle('relay:downloadUpdate', () => updater.download());
// IPC: 用户点「稍后」→ 压掉气泡(不影响设置页展示,也不取消已在跑的下载)
ipcMain.handle('relay:dismissUpdate', () => updater.dismiss());
// IPC: 下载就绪后立即重启安装
ipcMain.handle('relay:quitAndInstall', () => updater.quitAndInstall());

// ─────────────────────────────────────────
// AI 创作(文生图)—— 调 OpenAI 兼容的图像生成端点 /v1/images/generations
//   · Base URL、API Key 与完整远端模型 ID 都归属 Relay 服务商配置。
//   · 用 Node 原生 https,零外部依赖(不依赖 Python/openai 包,便于分发)。
//   · 生成的图存到 userData/generated_images/,返回本地路径给 renderer 渲染(file://)。
// ─────────────────────────────────────────
// 可选的图像模型清单。每个模型自带可用尺寸 sizes(value=API 传的 size,label=界面比例)。
//   · gpt-image-2:azure_openai 前缀,返回 b64_json。清晰度由独立的 quality 参数(low/medium/high)控制,
//                 尺寸用固定 5 档比例;界面「画质」下拉走 qualityTiers。
//   · 豆包 Seedream:volcengine_maas 前缀,返回 url。没有 quality 参数,清晰度=像素量(2K/4K),
//                 故界面「画质」下拉切的是分辨率档(resoTiers),每档每比例对应一组官方推荐像素。
// GPT-image-2 按「分辨率档 × 比例」给尺寸(和豆包同构,界面「画质」下拉切 1K/4K 档)。
//   约束(Azure 官方):两边都是 16 的倍数、长边 ≤3840、宽高比 ≤3:1、总像素 [655,360, 8,294,400]。
//   4K 档各值均已离线核验满足全部约束(注:受 829万像素上限,1:1 最大 2880×2880,到不了 4096)。
const GPT_RESO = {
  '1K': [
    { ratio: '1:1',  value: '1024x1024' },
    { ratio: '2:3',  value: '1024x1536' },
    { ratio: '3:2',  value: '1536x1024' },
    { ratio: '9:16', value: '1024x1792' },
    { ratio: '16:9', value: '1792x1024' },
  ],
  '4K': [
    { ratio: '1:1',  value: '2880x2880' },
    { ratio: '2:3',  value: '2352x3520' },
    { ratio: '3:2',  value: '3520x2352' },
    { ratio: '9:16', value: '2160x3840' },
    { ratio: '16:9', value: '3840x2160' },
  ],
};
const GPT_RATIO_DESC = {
  '1:1': '正方形，头像', '2:3': '竖图，社交媒体', '3:2': '横图，横版插画',
  '9:16': '手机壁纸，人像', '16:9': '桌面壁纸，风景',
};
function gptSizesForTier(tier) {
  const rows = GPT_RESO[tier] || GPT_RESO['1K'];
  return rows.map((r) => ({ value: r.value, label: r.ratio, shortLabel: r.ratio, desc: GPT_RATIO_DESC[r.ratio] || '' }));
}
// GPT 分辨率档 → quality 参数:1K 用 medium(快/省)、4K 用 high(配高分辨率)。在 generateImageCore 里据 size 反推。
const GPT_TIERS = [
  { value: '1K', label: '1K', desc: '标准，快' },
  { value: '4K', label: '4K', desc: '超清，慢' },
];
// 判断某 size 属于 GPT 哪个分辨率档(用于反推 quality);非 GPT 尺寸返回 null。
function gptTierOfSize(size) {
  for (const [tier, rows] of Object.entries(GPT_RESO)) {
    if (rows.some((r) => r.value === size)) return tier;
  }
  return null;
}
// 豆包按「分辨率档 × 比例」给官方推荐像素值(火山《Seedream·size》原表)。
//   2K/4K 各比例的宽高像素;界面选「画质(档) + 比例」两件事,生成时查这张表得最终 size。
//   注:豆包 size 约束=总像素 [3,686,400, 16,777,216] 且宽高比 [1/16,16],下列值均已满足。
const DOUBAO_RESO = {
  '2K': [
    { ratio: '1:1',  value: '2048x2048' },
    { ratio: '4:3',  value: '2304x1728' },
    { ratio: '3:4',  value: '1728x2304' },
    { ratio: '16:9', value: '2848x1600' },
    { ratio: '9:16', value: '1600x2848' },
    { ratio: '3:2',  value: '2496x1664' },
    { ratio: '2:3',  value: '1664x2496' },
    { ratio: '21:9', value: '3136x1344' },
  ],
  '4K': [
    { ratio: '1:1',  value: '4096x4096' },
    { ratio: '4:3',  value: '4704x3520' },
    { ratio: '3:4',  value: '3520x4704' },
    { ratio: '16:9', value: '5504x3040' },
    { ratio: '9:16', value: '3040x5504' },
    { ratio: '3:2',  value: '4992x3328' },
    { ratio: '2:3',  value: '3328x4992' },
    { ratio: '21:9', value: '6240x2656' },
  ],
};
// 比例 → 中文描述(界面比例下拉的副标题,2K/4K 共用)
const DOUBAO_RATIO_DESC = {
  '1:1': '正方形，头像', '4:3': '横图，文章配图', '3:4': '竖图，经典比例',
  '16:9': '桌面壁纸，风景', '9:16': '手机壁纸，人像', '3:2': '横图，横版插画',
  '2:3': '竖图，社交媒体', '21:9': '超宽，电影感',
};
// 把某一分辨率档展开成 sizes 列表(供界面比例下拉用;value=该档该比例的像素值)
function doubaoSizesForTier(tier) {
  const rows = DOUBAO_RESO[tier] || DOUBAO_RESO['2K'];
  return rows.map((r) => ({
    value: r.value, label: r.ratio, shortLabel: r.ratio, desc: DOUBAO_RATIO_DESC[r.ratio] || '',
  }));
}
// 豆包各模型支持的分辨率档(5.0-lite 多一档 3K;4.5/4.0 只有 2K/4K)
const DOUBAO_TIERS_53 = [
  { value: '2K', label: '2K', desc: '标清，快' },
  { value: '3K', label: '3K', desc: '高清' },
  { value: '4K', label: '4K', desc: '超清，慢且贵' },
];
const DOUBAO_TIERS_2 = [
  { value: '2K', label: '2K', desc: '标清，快' },
  { value: '4K', label: '4K', desc: '超清，慢且贵' },
];
// 模型清单。qualityKind 告诉前端「画质」下拉切的是什么:
//   'resolution' → 切分辨率档(豆包),qualityTiers 为档列表,真正的 size 由前端按 档×比例 查表;
//   'quality'    → 切 quality 参数(GPT),qualityTiers 为 quality 取值,sizes 固定。
// 三个模型的「画质」下拉统一切【分辨率档】(qualityKind:'resolution')。各自的档→比例→像素表
//   分别走 gptReso / doubaoReso(getConfig 下发);前端按 档×比例 查出最终 size。
//   GPT 的 quality 参数不在前端选,由 generateImageCore 据 size 落在哪个档自动推(1K→medium,4K→high)。
const IMAGE_MODELS = [
  { adapterId: 'gpt-image-2', label: 'GPT-image-2',  desc: '通用，文字渲染好',  ok: true,
    sizes: gptSizesForTier('1K'), qualityKind: 'resolution', qualityTiers: GPT_TIERS, defaultQuality: '1K', resoKey: 'gpt' },
  { adapterId: 'seedream-5.0', label: 'Seedream 5.0', desc: '中文友好，支持组图', ok: true,
    sizes: doubaoSizesForTier('2K'), qualityKind: 'resolution', qualityTiers: DOUBAO_TIERS_53, defaultQuality: '2K', resoKey: 'doubao' },
  { adapterId: 'seedream-4.5', label: 'Seedream 4.5', desc: '稳定，支持组图',   ok: true,
    sizes: doubaoSizesForTier('2K'), qualityKind: 'resolution', qualityTiers: DOUBAO_TIERS_2, defaultQuality: '2K', resoKey: 'doubao' },
];

function generatedImagesDir() {
  const dir = path.join(app.getPath('userData'), 'generated_images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 图生图上传的参考图落点(与生成图分开存,便于区分/清理)。
function referenceImagesDir() {
  const dir = path.join(app.getPath('userData'), 'reference_images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 普通对话里粘贴(Ctrl+V)的截图落点 —— 剪贴板位图无文件路径,先落盘成真实文件供附件流程使用。
function pastedImagesDir() {
  const dir = path.join(app.getPath('userData'), 'attachments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// IPC: 读取服务商已识别出的图像路由(renderer 渲染下拉用)。
ipcMain.handle('image:getConfig', () => {
  const metadata = new Map(IMAGE_MODELS.map((item) => [item.adapterId, item]));
  const routes = providerStore.listImageRoutes()
    .sort((left, right) => Number(right.activeProvider) - Number(left.activeProvider))
    .map((route) => {
      const adapted = metadata.get(route.adapterId);
      return adapted ? {
        ...adapted,
        name: route.routeId,
        routeId: route.routeId,
        providerId: route.providerId,
        providerName: route.providerName,
        remoteModelId: route.remoteModelId,
        desc: `${route.providerName} · ${adapted.desc}`,
      } : null;
    })
    .filter(Boolean);
  return {
    models: routes,
    // 各 resoKey → 「分辨率档 → [{ratio,value}]」表。前端按 模型.resoKey + 当前档 + 比例 查出最终 size。
    resoTables: { doubao: DOUBAO_RESO, gpt: GPT_RESO },
    savedDir: generatedImagesDir(),
  };
});

// IPC: 文生图 / 图生图 / 多图融合 / 组图。
//   { prompt, model, size, n, image, sequential } → { ok, paths:[], error }
//   image:参考图,可为 data URL 字符串(单图)或字符串数组(多图融合,仅豆包,最多 14 张)。
//   sequential:true 时开启组图(仅豆包,sequential_image_generation:auto,一次出一组关联图)。
//   按固定适配模型的 provider 前缀分流（JSON 请求体）：
//     · 豆包 volcengine_maas:打 /images/generations。参考图放 `image`(单图传 string、多图传 array);
//       默认 watermark:false 去掉「AI生成」水印;组图透传 sequential_image_generation。
//     · GPT azure_openai:带参考图时走「图片编辑」端点 /images/edits,参考图放 `image_url`
//       （当前适配协议使用 JSON，而非 Azure 原生 multipart）；仅支持单图，数组取第一张。
//       不支持多图融合/组图/watermark 参数。
// 图像生成核心（供 image:generate IPC 与定时任务调度器共用）。
//   入参 { prompt, model, size, n, image, sequential } → { ok, paths, error }。
const MAX_IMAGE_API_RESPONSE_BYTES = 160 * 1024 * 1024;
const MAX_DOWNLOADED_IMAGE_BYTES = 64 * 1024 * 1024;

async function downloadGeneratedImage(urlValue, file, signal, redirectsLeft = 3) {
  if (signal && signal.aborted) return { ok: false, canceled: true, error: '任务已取消' };
  let url;
  try { url = new URL(urlValue); } catch (_) { return { ok: false, error: '图片下载地址无效' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '图片下载协议不受支持' };
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let output = null;
    let bytes = 0;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result.ok) {
        try { if (output) output.destroy(); } catch (_) {}
        try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      }
      resolve(result);
    };
    const onAbort = () => {
      try { if (request) request.destroy(); } catch (_) {}
      finish({ ok: false, canceled: true, error: '任务已取消' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const mod = url.protocol === 'http:' ? require('http') : require('https');
    request = mod.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        cleanup();
        if (redirectsLeft <= 0) return finish({ ok: false, error: '图片下载重定向过多' });
        settled = true;
        downloadGeneratedImage(new URL(response.headers.location, url).toString(), file, signal, redirectsLeft - 1)
          .then(resolve);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        finish({ ok: false, error: `图片下载失败（HTTP ${response.statusCode}）` });
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOADED_IMAGE_BYTES) {
        response.destroy();
        finish({ ok: false, error: '图片文件超过 64MB 安全上限' });
        return;
      }
      output = fs.createWriteStream(temporary, { flags: 'wx' });
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOADED_IMAGE_BYTES) {
          response.destroy();
          finish({ ok: false, error: '图片文件超过 64MB 安全上限' });
        }
      });
      response.on('error', (error) => finish({ ok: false, error: error.message }));
      output.on('error', (error) => finish({ ok: false, error: error.message }));
      output.on('finish', () => {
        if (settled || (signal && signal.aborted)) return finish({ ok: false, canceled: true, error: '任务已取消' });
        try { fs.renameSync(temporary, file); finish({ ok: true }); }
        catch (error) { finish({ ok: false, error: error.message }); }
      });
      response.pipe(output);
    });
    request.setTimeout(120000, () => {
      request.destroy();
      finish({ ok: false, error: '图片下载超时（120s）' });
    });
    request.on('error', (error) => {
      if (signal && signal.aborted) finish({ ok: false, canceled: true, error: '任务已取消' });
      else finish({ ok: false, error: error.message });
    });
  });
}

async function generateImageCore({ prompt, model, size, n, image, sequential, signal } = {}) {
  if (signal && signal.aborted) return { ok: false, canceled: true, error: '任务已取消' };
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: '请输入图片描述' };
  const route = providerStore.getImageRuntime(model);
  if (!route) return {
    ok: false,
    error: '未发现可用图像模型，请在“设置 → 服务商”保存服务商后点击“获取模型”',
  };
  const { baseUrl, apiKey } = route;
  const chosen = IMAGE_MODELS.find((item) => item.adapterId === route.adapterId);
  if (!chosen) return { ok: false, error: '该图像模型尚未被 Relay 适配' };
  const isGpt = chosen.adapterId === 'gpt-image-2';
  // 识别阶段不关心供应商前缀；调用阶段则完整保留远端模型 ID。
  // 仅对 Relay 旧版已验证过的两种网关命名空间维持“请求头 + 裸模型名”兼容，
  // 其他 Base URL 一律把服务端返回的完整 ID 原样放入 model 字段。
  const { requestModel, providerHeader } = imageRequestRoute(route.remoteModelId);
  // 归一化参考图:统一成数组,过滤掉空/非字符串项
  const refs = (Array.isArray(image) ? image : (image ? [image] : []))
    .filter((s) => typeof s === 'string' && s);
  const hasRef = refs.length > 0;
  const wantGroup = !!sequential && !isGpt;   // 组图仅豆包
  // GPT 带参考图 → 编辑端点;其余(豆包,或纯文生图)→ 生成端点
  const useEdit = isGpt && hasRef;

  const payloadObj = {
    model: requestModel,
    prompt: text,
    // 组图模式下放宽张数上限到 15(豆包组图:参考图数+生成数≤15);常规仍 1-4
    n: Math.min(Math.max(parseInt(n, 10) || 1, 1), wantGroup ? 15 : 4),
    size: size || '1024x1024',
  };
  if (hasRef) {
    if (useEdit) {
      payloadObj.image_url = refs[0];            // GPT 编辑:单图 image_url(取第一张)
    } else {
      // 豆包:单图传 string,多图传 array(多图融合)
      payloadObj.image = refs.length === 1 ? refs[0] : refs;
    }
  }
  // GPT 画质:quality 不由前端选,按 size 落在哪个分辨率档自动推 —— 1K→medium(快/省)、4K→high(配高清)。
  //   size 不在已知档里(如定时任务传了自定义尺寸)则回落 high(官方默认)。
  if (isGpt) {
    const tier = gptTierOfSize(payloadObj.size);
    payloadObj.quality = (tier === '1K') ? 'medium' : 'high';
  }
  if (!isGpt) {
    payloadObj.watermark = false;                // 豆包去水印(GPT 无此参数)
    if (wantGroup) {
      // 组图:auto 让模型自主决定张数;max_images 用 n 兜住上限
      payloadObj.sequential_image_generation = 'auto';
      payloadObj.sequential_image_generation_options = { max_images: payloadObj.n };
    }
  }
  const payload = JSON.stringify(payloadObj);

  const endpoint = useEdit ? '/images/edits' : '/images/generations';
  let url;
  try { url = new URL(providerApiUrl(baseUrl, `/v1${endpoint}`)); }
  catch (_) { return { ok: false, error: '服务商 Base URL 无效' }; }
  const mod = url.protocol === 'http:' ? require('http') : require('https');

  const result = await new Promise((resolve) => {
    let body = '';
    let bodyBytes = 0;
    let req;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { if (req) req.destroy(); } catch (_) {}
      finish({ status: 0, body: '', err: '任务已取消', canceled: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + apiKey,
          'x-api-key': apiKey,
          'content-length': Buffer.byteLength(payload),
          ...(providerHeader ? { 'x-model-provider-id': providerHeader } : {}),
        },
      }, (res) => {
        res.on('data', (c) => {
          bodyBytes += c.length;
          if (bodyBytes > MAX_IMAGE_API_RESPONSE_BYTES) {
            res.destroy();
            try { req.destroy(); } catch (_) {}
            finish({ status: 0, body: '', err: 'API 响应超过 160MB 安全上限' });
            return;
          }
          body += c;
        });
        res.on('end', () => finish({ status: res.statusCode, body }));
      });
    } catch (e) { return finish({ status: 0, body: '', err: e.message }); }
    // 生图可能较慢,给 6 分钟(GPT-image-2 的 quality=high / 4K 单张常超 3 分钟)
    req.setTimeout(360000, () => { try { req.destroy(); } catch (_) {} finish({ status: 0, body: '', err: '请求超时(360s)' }); });
    req.on('error', (e) => finish({ status: 0, body: '', err: e.message, canceled: !!(signal && signal.aborted) }));
    req.write(payload);
    req.end();
  });

  if (result.canceled) return { ok: false, canceled: true, error: '任务已取消' };
  if (result.err) { console.error('[image] 网络错误: %s', result.err); return { ok: false, error: '网络错误:' + result.err }; }
  let json;
  try { json = JSON.parse(result.body); } catch (_) { console.error('[image] API 返回非 JSON status=%d body=%s', result.status, (result.body || '').slice(0, 200)); return { ok: false, error: `API 返回非 JSON(HTTP ${result.status})` }; }
  if (result.status !== 200 || json.error) {
    const errObj = json.error || {};
    const msg = errObj.message || errObj.param || `HTTP ${result.status}`;
    const code = String(errObj.code || errObj.type || '').toLowerCase();
    console.error('[image] API 报错 status=%d code=%s msg=%s', result.status, code, msg.slice(0, 200));
    // 内容审核拒绝:给一句中文提示,告诉用户是被安全系统拦了、改提示词即可(GPT/豆包措辞不一,统一识别)
    if (code.includes('content_policy') || code.includes('content_filter') ||
        /safety system|content policy|moderation|被.*(拒绝|拦截|过滤)|敏感|违规/i.test(msg)) {
      return { ok: false, error: '提示词被内容安全系统拒绝，未生成图片。请调整描述(尤其涉及人物身材/裸露/敏感的措辞)后重试。\n原始信息：' + msg };
    }
    return { ok: false, error: 'API 错误:' + msg };
  }
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) return { ok: false, error: 'API 未返回图片数据' };

  // 落盘:b64_json 直接写(.png);url 模式下载(豆包多为 .jpeg,按 URL 后缀定扩展名)
  const dir = generatedImagesDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const paths = [];
  for (let i = 0; i < data.length; i++) {
    if (signal && signal.aborted) return { ok: false, canceled: true, error: '任务已取消', paths };
    const item = data[i];
    try {
      if (item.b64_json) {
        const file = path.join(dir, `img-${ts}-${i + 1}.png`);
        const encoded = String(item.b64_json);
        const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
        const estimatedBytes = Math.floor(encoded.length * 3 / 4) - padding;
        if (estimatedBytes > 64 * 1024 * 1024) {
          console.warn('[image] 跳过超限 base64 图片 index=%d estimatedBytes=%d', i, estimatedBytes);
          continue;
        }
        if (signal && signal.aborted) return { ok: false, canceled: true, error: '任务已取消', paths };
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > 64 * 1024 * 1024) continue;
        const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
        try {
          await fs.promises.writeFile(temporary, bytes, signal ? { signal } : undefined);
          if (signal && signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
          await fs.promises.rename(temporary, file);
          paths.push(file);
        } catch (writeError) {
          try { await fs.promises.rm(temporary, { force: true }); } catch (_) {}
          if ((signal && signal.aborted) || writeError.name === 'AbortError') {
            return { ok: false, canceled: true, error: '任务已取消', paths };
          }
          throw writeError;
        }
      } else if (item.url) {
        // 从 URL 路径推断扩展名(jpg/jpeg/png/webp),拿不到则用 .png
        let ext = 'png';
        try { const m = new URL(item.url).pathname.match(/\.(jpe?g|png|webp)(?:$|\?)/i); if (m) ext = m[1].toLowerCase(); } catch (_) {}
        const file = path.join(dir, `img-${ts}-${i + 1}.${ext}`);
        const dl = await downloadGeneratedImage(item.url, file, signal);
        if (dl.canceled) return { ok: false, canceled: true, error: '任务已取消', paths };
        if (dl.ok) paths.push(file);
      }
    } catch (e) { console.warn('[image] 保存图片失败: %s', e.message); }
  }
  if (!paths.length) return { ok: false, error: '图片保存失败' };
  return { ok: true, paths };
}

// renderer 可能在付费图片请求完成前刷新或崩溃。主进程持有权威的 conversationId + turnIndex，
// 因而在返回 IPC 前先幂等回填历史；renderer 正常在线时随后写入相同结果，不会产生重复轮次。
function materializeCreationTaskResult(source, result = {}) {
  const mapping = source && source.source && typeof source.source === 'object' ? source.source : source || {};
  const conversationId = typeof mapping.conversationId === 'string' ? mapping.conversationId : null;
  const turnIndex = Number.isSafeInteger(mapping.turnIndex) ? mapping.turnIndex : null;
  if (!conversationId || turnIndex == null || turnIndex < 0) return false;
  const conv = loadConversation(conversationId);
  if (!conv || conv.kind !== 'create' || !Array.isArray(conv.turns) || !conv.turns[turnIndex]) return false;
  const turn = conv.turns[turnIndex];
  const paths = Array.isArray(result.paths) ? [...new Set(result.paths.filter((item) => typeof item === 'string' && item))] : [];
  if (result.ok) {
    turn.resultPaths = paths;
    delete turn.error;
  } else if (!Array.isArray(turn.resultPaths) || !turn.resultPaths.length) {
    turn.resultPaths = [];
    turn.error = compactText(result.error || (result.canceled ? '任务已取消' : '图片生成未完成'), 1000);
  }
  const runId = source && source.runId || mapping.runId;
  if (runId && !turn.runId) turn.runId = String(runId);
  conv.updatedAt = new Date().toISOString();
  saveConversation(conv);
  return true;
}

// IPC: 文生图 / 图生图 / 多图融合 / 组图。用户创作同样进入统一影子账本。
ipcMain.handle('image:generate', async (_e, opts = {}) => {
  const runId = typeof opts.runId === 'string' && /^[0-9a-f][0-9a-f-]{15,63}$/i.test(opts.runId)
    ? opts.runId
    : crypto.randomUUID();
  const createdRun = createShadowTaskRun({
    runId,
    state: RUN_STATES.QUEUED,
    phase: 'queued',
    kind: 'image',
    trigger: 'user',
    title: compactText(opts.prompt, 80) || 'AI 创作',
    priority: 100,
    source: {
      type: 'creation',
      conversationId: typeof opts.conversationId === 'string' ? opts.conversationId : null,
      conversationKind: 'create',
      turnIndex: Number.isSafeInteger(opts.turnIndex) ? opts.turnIndex : null,
    },
    execution: { jobId: runId, appInstanceId: TASK_EVENT_EPOCH },
    metadata: { model: opts.model || null, size: opts.size || null },
  });
  if (taskLedger && !createdRun) {
    const existing = taskLedger.get(runId);
    if (existing) {
      if (!isTerminalState(existing.state)) {
        return { ok: false, code: 'RUN_IN_PROGRESS', error: '这次图片任务已经在运行中', runId };
      }
      const priorPaths = existing.result && Array.isArray(existing.result.artifactPaths)
        ? existing.result.artifactPaths : [];
      return existing.state === RUN_STATES.SUCCEEDED
        ? { ok: true, paths: priorPaths, runId, reused: true }
        : {
          ok: false, runId, reused: true,
          canceled: existing.state === RUN_STATES.CANCELED,
          error: existing.result && existing.result.error && (existing.result.error.message || existing.result.error)
            || '这次图片任务已经结束',
        };
    }
  }
  const lease = await acquireTaskResource(runId, 'image', opts.conversationId || null);
  if (!lease) {
    const canceled = { ok: false, canceled: true, error: '任务已取消', runId };
    try { materializeCreationTaskResult({ ...opts, runId }, canceled); } catch (_) {}
    return canceled;
  }
  updateScheduledShadowPhase(runId, 'tool', '正在生成图片');
  try {
    const result = await generateImageCore({ ...opts, signal: lease.signal || opts.signal });
    try { materializeCreationTaskResult({ ...opts, runId }, result || {}); }
    catch (e) { console.warn('[image] 主进程回填创作历史失败 runId=%s: %s', runId, e.message); }
    finishShadowTaskRun(runId, !!(result && result.ok), {
      status: result && result.canceled ? RUN_STATES.CANCELED : undefined,
      summary: result && result.ok ? `已生成 ${(result.paths || []).length} 张图片` : '',
      error: result && !result.ok ? result.error : null,
      artifactPaths: result && result.paths || [],
    });
    return { ...result, runId };
  } catch (e) {
    try { materializeCreationTaskResult({ ...opts, runId }, { ok: false, error: e.message || '图片生成失败' }); }
    catch (historyError) { console.warn('[image] 主进程回填创作失败状态失败 runId=%s: %s', runId, historyError.message); }
    finishShadowTaskRun(runId, false, { error: e.message || '图片生成失败' });
    return { ok: false, error: e.message || '图片生成失败', runId };
  } finally {
    releaseTaskResource(runId);
  }
});

// IPC: 删除"我的创作"里的一张图(连同本地文件)。安全起见:只允许删 generated_images 目录内的文件。
ipcMain.handle('image:deleteSaved', (_e, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    const dir = generatedImagesDir();
    const abs = path.resolve(String(p));
    // 路径越权防护:目标必须真的位于 generated_images 目录内,不能用 ../ 跳出去删别的文件
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '非法路径' };
    if (!fs.existsSync(abs)) return { ok: true };   // 已不存在视作删除成功(幂等)
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─────────────────────────────────────────
// 库:汇总 LLM 生成到本地的文件 —— 图片来自 generated_images;其它文件扫描各会话的工作目录
// ─────────────────────────────────────────
// 扩展名 → 类型分类(用于库里按类型筛选)
const LIB_TYPE_BY_EXT = {
  png:'image', jpg:'image', jpeg:'image', webp:'image', gif:'image', bmp:'image', svg:'image',
  pdf:'pdf',
  doc:'document', docx:'document', txt:'document', md:'document', rtf:'document',
  xls:'spreadsheet', xlsx:'spreadsheet', csv:'spreadsheet', tsv:'spreadsheet',
  ppt:'presentation', pptx:'presentation',
  // 代码 / 标记 / 配置 —— LLM 写的代码文件归到「代码」一类
  html:'code', htm:'code', css:'code', js:'code', mjs:'code', cjs:'code', jsx:'code', ts:'code', tsx:'code', vue:'code',
  json:'code', yaml:'code', yml:'code', toml:'code', xml:'code', ini:'code',
  py:'code', java:'code', c:'code', h:'code', cpp:'code', cc:'code', hpp:'code', cs:'code', go:'code', rs:'code',
  rb:'code', php:'code', swift:'code', kt:'code', sh:'code', bash:'code', ps1:'code', bat:'code', sql:'code', r:'code', lua:'code',
};
function libTypeOf(ext) { return LIB_TYPE_BY_EXT[(ext || '').toLowerCase()] || 'other'; }

// IPC: 列出 generated_images 中的图片。
ipcMain.handle('library:listImages', () => {
  const dir = generatedImagesDir();
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(n))
      .map((n) => { const p = path.join(dir, n); let mtime = 0, size = 0; try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch (_) {} return { path: p, name: n, mtime, size }; })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items: files };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// IPC: 列出库里的文件 —— 解析 Claude CLI 的会话日志(~/.claude/projects/**/*.jsonl),
//   提取 LLM 用 Write/Edit/NotebookEdit 工具写过的所有文件路径(不管在哪个子目录/主目录),
//   去重、只保留当前仍存在的文件,按类型归类。这是「LLM 生成到本地的文件」最准确的来源。
ipcMain.handle('library:listFiles', () => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return { ok: true, items: [] };
    // 收集所有 .jsonl 会话文件(各 cwd 子目录下),按修改时间倒序(新会话优先),最多扫 400 个防卡
    const jsonls = [];
    for (const sub of fs.readdirSync(projectsDir)) {
      const subDir = path.join(projectsDir, sub);
      let st; try { st = fs.statSync(subDir); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      let names; try { names = fs.readdirSync(subDir); } catch (_) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const fp = path.join(subDir, n);
        let s; try { s = fs.statSync(fp); } catch (_) { continue; }
        jsonls.push({ fp, mtime: s.mtimeMs });
      }
    }
    jsonls.sort((a, b) => b.mtime - a.mtime);
    const SCAN_CAP = 400;

    const writeTools = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
    const writtenPaths = new Set();   // LLM 写过的文件绝对路径(去重)
    for (const { fp } of jsonls.slice(0, SCAN_CAP)) {
      let content; try { content = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      // 只统计 Relay 应用发起的会话:Relay 给每条 prompt 都注入了「无交互界面」须知,
      //   据此排除用户直接用 Claude CLI / 开发本应用产生的会话(否则会混入一堆无关源码文件)。
      if (content.indexOf('无交互界面') < 0) continue;
      for (const line of content.split('\n')) {
        if (!line.trim() || line.indexOf('tool_use') < 0) continue;   // 没有工具调用的行直接跳过(省解析)
        let o; try { o = JSON.parse(line); } catch (_) { continue; }
        const msg = o && o.message;
        if (!msg || o.type !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const b of msg.content) {
          if (b && b.type === 'tool_use' && writeTools.has(b.name)) {
            const p = b.input && (b.input.file_path || b.input.notebook_path || b.input.path);
            if (p && typeof p === 'string') writtenPaths.add(path.resolve(p));
          }
        }
      }
    }

    // 只保留当前仍存在的文件,取 stat + 类型
    const items = [];
    for (const p of writtenPaths) {
      let st; try { st = fs.statSync(p); } catch (_) { continue; }   // 已删除/移动的跳过
      if (!st.isFile()) continue;
      const name = path.basename(p);
      const ext = path.extname(name).slice(1).toLowerCase();
      items.push({ path: p, name, ext, type: libTypeOf(ext), mtime: st.mtimeMs, size: st.size, dir: path.dirname(p) });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// IPC: 用系统默认程序打开文件
ipcMain.handle('library:openFile', async (_e, p) => {
  try { if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' }; return await generalPreferences.openFile(p, generalPreferences.preferences().fileOpenTarget === 'relay' ? 'system' : 'default'); }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 打开图片库目录(generated_images,所有生成图片的落点)。没有则先建,再用系统文件管理器打开。
ipcMain.handle('library:openImagesDir', () => {
  try { const dir = generatedImagesDir(); shell.openPath(dir); return { ok: true, dir }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 删除库里的一个文件(连同本地磁盘文件)。只删文件、不删目录;前端有二次确认。
ipcMain.handle('library:deleteFile', (_e, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    const abs = path.resolve(String(p));
    if (!fs.existsSync(abs)) return { ok: true };          // 已不存在 → 幂等成功
    if (!fs.statSync(abs).isFile()) return { ok: false, error: '不是文件' };   // 拒绝删目录
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 把本地图片读成 data URL(给"上下文迭代:拿上一张图当参考图"用)
ipcMain.handle('image:toDataUrl', (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const b64 = fs.readFileSync(p).toString('base64');
    return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 把图片 data URL 落盘到指定目录,返回 { ok, path }。供参考图、粘贴附件等共用。
//   dir:目标目录;prefix:文件名前缀。文件名 = <prefix>-<时间戳>-<随机>.<扩展名>。
function saveImageDataUrl(dataUrl, dir, prefix) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return { ok: false, error: '不是有效的图片 data URL' };
  const mime = m[1].toLowerCase();
  // mime → 扩展名(jpeg 归一为 jpg);未知则回退 png
  const ext = mime === 'image/jpeg' ? 'jpg'
    : mime === 'image/webp' ? 'webp'
    : mime === 'image/gif'  ? 'gif'
    : mime === 'image/bmp'  ? 'bmp'
    : mime === 'image/svg+xml' ? 'svg'
    : 'png';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = require('crypto').randomBytes(3).toString('hex');
  const file = path.join(dir, `${prefix}-${ts}-${rand}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return { ok: true, path: file };
}

// IPC: 把图生图上传的参考图(data URL)落盘到 reference_images/,返回本地路径。
//   用途:让参考图能像生成图一样持久展示(用户气泡上方),会话历史只存路径、不存 base64(避免 JSON 膨胀)。
ipcMain.handle('image:saveRef', (_e, { dataUrl } = {}) => {
  try { return saveImageDataUrl(dataUrl, referenceImagesDir(), 'ref'); }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 把粘贴(Ctrl+V)进来的截图(data URL)落盘到 attachments/,返回本地路径 + 文件名。
//   普通对话的附件链路是按路径走的(让 CLI 用 Read 读),而剪贴板位图没有文件路径,
//   故先落盘成真实文件再喂给附件流程。
ipcMain.handle('image:savePaste', (_e, { dataUrl } = {}) => {
  try {
    const r = saveImageDataUrl(dataUrl, pastedImagesDir(), 'pasted');
    if (r.ok) r.name = path.basename(r.path);
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 读系统剪贴板里的图片(PNG dataURL)。兜底用 —— 部分 Windows 截图工具(如微信)
//   只把位图写进原生剪贴板,DOM paste 事件取不到 file 项;此时从主进程原生读 CF_BITMAP。
//   剪贴板无图片则返回 ok:false。
ipcMain.handle('clipboard:readImage', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false };
    const b64 = img.toPNG().toString('base64');
    if (!b64) return { ok: false };
    return { ok: true, dataUrl: `data:image/png;base64,${b64}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Compatibility API: ordinary web links use browser preferences; explicit
// "在默认浏览器中打开" still uses browser.invoke('openExternal').
ipcMain.handle('shell:open', async (event, url) => {
  if (typeof url !== 'string') return { ok: false, error: '链接地址无效' };
  if (/^https?:\/\//i.test(url)
    && (mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame || miniPanelCaller(event))) {
    return openConfiguredWebLink(url);
  }
  if (typeof url === 'string' && /^file:\/\//i.test(url)) {
    try {
      const file = fileURLToPath(url);
      if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
      return await generalPreferences.openFile(file, generalPreferences.preferences().fileOpenTarget === 'relay' ? 'system' : 'default');
    } catch (error) { return { ok: false, error: error.message }; }
  }
  return shell.openExternal(url);
});

// IPC: 文件选择对话框
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '常用',  extensions: ['png','jpg','jpeg','gif','webp','pdf','txt','md','json','csv','xlsx','docx','pptx','py','js','ts','java','c','cpp','go','rs'] },
      { name: '图片',  extensions: ['png','jpg','jpeg','gif','webp','bmp','svg'] },
      { name: '文档',  extensions: ['pdf','txt','md','docx','xlsx','pptx'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    ext:  path.extname(p).slice(1).toLowerCase(),
    size: (() => { try { return fs.statSync(p).size; } catch { return 0; } })(),
  }));
});

// IPC: 选择工作目录(对话级)。选中后,该对话后续所有 claude:run 都以此为 cwd + --add-dir,
//   LLM 的文件读写都落在这个目录。返回 { path, name } 或 null(取消)。
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  return { path: dir, name: path.basename(dir) || dir };
});

// ─────────────────────────────────────────
// IPC: 历史会话 CRUD
// ─────────────────────────────────────────
ipcMain.handle('history:list', () => {
  initializeProjectHistory();
  // 列表只读索引,零正文 IO(v2 目录式存储的核心收益)
  return readHistoryIndex().map(m => ({
    id: m.id,
    title: m.title,
    sessionId: m.sessionId,
    projectId: getProjectStore().binding(m.id) || null,
    updatedAt: m.updatedAt,
    turnCount: m.turnCount || 0,
    kind: m.kind || 'chat',   // 'chat'=普通对话 / 'create'=AI 创作,前端据此切换视图与图标
    mode: m.mode || 'plain',  // 'plain'=普通 / 'agent'=Agent 对话,前端据此选图标
    fromScheduled: m.fromScheduled || null,  // 定时任务产出的会话,前端用时钟图标
    pinned: !!m.pinned,       // 置顶标记:列表里排在最前
  })).sort((a, b) => {
    // 置顶优先;同组内按更新时间倒序
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
});

// 置顶/取消置顶一条会话。只改 pinned 标记,不动 updatedAt(避免影响"最近更新"语义)。
//   pinned 写进正文而非只改索引 —— 索引可由正文完整重建,这个不变量不能破。
ipcMain.handle('history:setPinned', (_e, { id, pinned } = {}) => {
  const c = loadConversation(id);
  if (!c) return { ok: false };
  c.pinned = !!pinned;
  saveConversation(c);
  return { ok: true, pinned: c.pinned };
});

// IPC: 手动重命名会话。仿 setPinned:只改字段、不刷 updatedAt(重命名不该把会话顶到列表最前)。
//   titleManual 标记「用户手动起的名」——渲染层的 AI 摘要标题回写前会检查它,防止覆盖手动命名。
//   返回 c.title(saveConversation 收口后的值,可能被截到 64 视觉宽),渲染层以它回显。
ipcMain.handle('history:rename', (_e, { id, title } = {}) => {
  const t = String(title || '').trim();
  if (!t) return { ok: false };
  const c = loadConversation(id);
  if (!c) return { ok: false };
  c.title = t;
  c.titleGenerated = true;
  c.titleManual = true;
  saveConversation(c);
  if (c.sdkSessionContext) void getSdkHistoryManagement().rename(id, c.title).then(() => {
    const latest = loadConversation(id); if (latest?.title !== c.title) return;
    latest.sdkTitleSync = 'synced'; persistConversationRecord(latest);
  }).catch(() => {
    const latest = loadConversation(id); if (latest?.title !== c.title) return;
    latest.sdkTitleSync = 'pending'; persistConversationRecord(latest);
  });
  return { ok: true, title: c.title };
});

ipcMain.handle('history:load', (_e, id) => projectConversation(loadConversation(id)));
let sdkHistoryManagement;
function getSdkHistoryManagement() {
  return sdkHistoryManagement ||= createHistoryManagement({
    load: loadConversation, list: readHistoryIndex, save: persistConversationRecord,
    isBusy: id => !!liveSessions.get(id)?.busy || !!taskLedger?.list({ terminal: false }).some(run => run.source?.conversationId === id),
    resolveWorkspaceScope: async input => {
      const project = input.projectId ? getProjectStore().get(input.projectId) : null;
      if (input.projectId && !project) throw Error('项目已不存在');
      const workspace = input.conversationId ? resolveWorkspaceForTools({ conversationId: input.conversationId }) : null;
      const hostCwd = project?.path || workspace?.root || workspace?.cwd || getConversationWorkspaces().base;
      const environment = normalizePreferences(readAppSettings()).agentEnvironment;
      const info = environment === 'wsl' ? await agentEnvironmentService.probe({ runtimeOnly: true }) : null;
      if (environment === 'wsl' && !info?.available) throw Error('当前 WSL 环境不可用');
      return { cwd: environment === 'wsl' ? toWslPath(hostCwd) : hostCwd, hostCwd,
        configDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), agentEnvironment: environment,
        wslDistribution: info?.distribution || info?.wslDistribution || null, projectId: project?.id || null };
    },
  });
}
ipcMain.handle('history:native', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try {
    const service = getSdkHistoryManagement();
    if (input.operation === 'list') return await service.list(input);
    if (input.operation === 'import') return await service.import(input);
    if (input.operation === 'inspect') return await service.inspect(input.conversationId);
    if (input.operation === 'repair') return await service.repair(input.conversationId);
    if (input.operation === 'rename') return await service.rename(input.conversationId, loadConversation(input.conversationId)?.title);
    if (input.operation === 'deleteNative' && input.confirm === true) return await service.deleteNative(input.conversationId);
    return { ok: false, message: '不支持的历史操作' };
  } catch (error) { return { ok: false, code: error.code, message: error.message }; }
});

function resolveNativeHistoryScope({ convId, runId } = {}) {
  if (typeof convId !== 'string' || !/^[\w-]{1,160}$/.test(convId)) throw Error('对话标识无效');
  const record = loadConversation(convId);
  const live = liveSessions.get(convId);
  if (record && live && !live.dead && (!runId || live.jobId === runId)) {
    applyProvenance(record, live, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  }
  return resolveStoredScope(record, runId);
}
let nativeHistoryService, nativeForkService;
function getNativeHistoryService() {
  return nativeHistoryService ||= createSessionHistoryService({ resolveScope: resolveNativeHistoryScope });
}
function getNativeForkService() {
  return nativeForkService ||= createSessionForkService({ loadConversation, persistConversation: persistConversationRecord,
    execute: executeSessionOperation, decorate: projectConversation,
    validateSource: scope => {
      if (!scope.routing) return;
      const runtime = activeRelayProviderRuntime({ tier: scope.routing.routeTier });
      const current = providerSessionRoute(runtime, scope.routing.routeTier);
      if (!sessionRouteMatchesProvider(scope.routing, current)) throw Object.assign(Error('原轮次的服务商或运行环境已变更，请恢复对应配置后创建分支'), { code: 'FORK_ROUTE_CHANGED' });
      const source = loadConversation(scope.conversationId);
      const projectId = Object.hasOwn(scope.routing, 'projectId') ? scope.routing.projectId
        : workspaceKey(source?.workingDir?.path) === workspaceKey(scope.hostCwd || scope.cwd) ? source?.projectId : null;
      const project = projectId ? getProjectStore().get(projectId) : null;
      if (projectId && (!project || workspaceKey(project.path) !== workspaceKey(scope.hostCwd || scope.cwd))) {
        throw Object.assign(Error('原轮次的项目已移除或目录已变更，无法保持原生分支上下文'), { code: 'FORK_PROJECT_UNAVAILABLE' });
      }
      const contract = conversationRuntimeContract({ convId: scope.conversationId, cwd: scope.hostCwd || scope.cwd,
        mode: scope.routing.mode, agentName: scope.routing.agentName, model: runtime.modelId, effort: scope.routing.effort,
        agentProjectRoot: (readAppSettings().agentProjects || {})[scope.routing.agentName] || null, projectContext: project, providerRuntime: runtime });
      // The contract calculation may have migrated this exact stored scope.
      // Keep the fork's snapshot in sync without accepting any changed source
      // fields; its later full-scope comparison still guards concurrent edits.
      const migratedScope = resolveStoredScope(loadConversation(scope.conversationId), scope.runId);
      if (migratedScope.routing?.runtimeFingerprint === contract.fingerprint
          && migratedScope.routing.runtimeFingerprintVersion === RUNTIME_FINGERPRINT_VERSION
          && scope.routing.runtimeFingerprint !== contract.fingerprint) {
        scope.routing.runtimeFingerprint = migratedScope.routing.runtimeFingerprint;
        scope.routing.runtimeFingerprintVersion = migratedScope.routing.runtimeFingerprintVersion;
      }
      if (scope.routing.runtimeFingerprint && scope.routing.runtimeFingerprint !== contract.fingerprint) {
        throw Object.assign(Error('原轮次的指令、Agent 或记忆设置已变更，无法保持原生分支上下文'), { code: 'FORK_RUNTIME_CHANGED' });
      }
    },
    isBusy: id => !!liveSessions.get(id)?.busy || !!taskLedger?.list({ terminal: false }).some(run => run.source?.conversationId === id),
  });
}
ipcMain.handle('history:fork', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try { return await getNativeForkService().create({ conversationId: input.conversationId, runId: input.runId, redo: input.redo === true }); }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
});
ipcMain.handle('history:subagents', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try { return await getNativeHistoryService().listSubagents({ convId: input.convId, runId: input.runId }); }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
});
ipcMain.handle('history:subagentMessages', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  try { return await getNativeHistoryService().getSubagentMessages({ convId: input.convId, runId: input.runId,
    agentId: input.agentId, offset: input.offset }); }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
});

// 打开旧会话或服务商路由变化时，旧上游 session 不能继续复用。这里只从主进程
// 的最新正文中失效 session，并保留 updatedAt/pinned/title；否则一次内部兼容迁移
// 会被误算成“最近对话”，导致左侧记录在点击后自己跑到顶部。
ipcMain.handle('history:invalidateSessionForProvider', (_e, { id, routeTier } = {}) => {
  if (!id) return { ok: false, code: 'INVALID_ID' };
  const c = loadConversation(id);
  if (!c) return { ok: false, code: 'NOT_FOUND' };

  const requestedTier = String(routeTier || '').trim();
  const liveRoute = RELAY_MODEL_TIERS.has(requestedTier)
    ? providerStore.getRoutingView().chatRoutes.find((route) => route && route.tier === requestedTier
      && route.configured && route.available)
    : null;
  if (!liveRoute || !liveRoute.providerId) {
    return { ok: false, code: 'INVALID_ROUTE' };
  }
  // 服务商可能被连续编辑；只认主进程此刻的权威路由，不能让较早的 renderer 事件
  // 用过期 providerId/revision 误伤一个刚建立的新 session。
  const target = {
    providerId: liveRoute.providerId,
    providerRevision: Number(liveRoute.providerRevision) || 0,
    agentEnvironment: normalizePreferences(readAppSettings()).agentEnvironment,
    routeTier: requestedTier,
  };

  const currentRoute = {
    providerId: c.sessionProviderId,
    providerRevision: c.sessionProviderRevision,
    agentEnvironment: c.sessionAgentEnvironment || 'native',
    routeTier: c.sessionRouteTier || c.sessionModel,
  };
  let applied = false;
  if (c.sessionId && !sessionRouteMatchesProvider(currentRoute, target)) {
    c.sessionId = null;
    c.carryContextOnNextTurn = 'provider';
    c.model = requestedTier;
    applied = true;
  } else if (!c.sessionId && c.carryContextOnNextTurn === 'provider'
      && c.model !== requestedTier) {
    // 连续路由事件可能在前一个失效请求落盘后又切换档位；此时后到的事件仍应胜出。
    c.model = requestedTier;
    applied = true;
  }
  if (applied) {
    persistConversationRecord(c);
  }

  return {
    ok: true,
    applied,
    updatedAt: c.updatedAt || null,
    session: {
      sessionId: c.sessionId || null,
      sessionProviderId: c.sessionProviderId || null,
      sessionProviderRevision: Number(c.sessionProviderRevision || 0),
      sessionAgentEnvironment: c.sessionAgentEnvironment || 'native',
      sessionRouteTier: c.sessionRouteTier || null,
      sessionModel: c.sessionModel || null,
      carryContextOnNextTurn: c.carryContextOnNextTurn || null,
      model: c.model || null,
    },
  };
});

ipcMain.handle('history:save', (_e, conv) => {
  if (miniChat && miniChat.isRunning() && miniChat.getConversationId() === conv.id) {
    return { error: '这个对话正在快捷小窗中运行，请在小窗中继续补充要求。', code: 'MINI_TURN_ACTIVE' };
  }
  const now = new Date().toISOString();
  if (!conv.id) conv.id = genId();
  if (!conv.createdAt) conv.createdAt = now;
  conv.updatedAt = now;
  // 置顶由专用 setPinned 入口维护；运行中旧快照整存不能撤销最新的置顶操作。
  // 正文是权威来源，避免索引暂未同步时读回旧标记；新记录保留初始化值。
  const existing = fs.existsSync(convFilePath(conv.id)) ? loadConversation(conv.id) : null;
  if (existing) conv.pinned = !!existing.pinned;
  protectSdkMetadata(conv, existing);
  conv = projectConversation(conv);
  saveConversation(conv);
  return { id: conv.id, updatedAt: conv.updatedAt, projectId: conv.projectId || null,
    permissionMode: conv.permissionMode, permissionRevision: conv.permissionRevision,
    permissionLegacyPlan: conv.permissionLegacyPlan, executionMode: conv.executionMode };
});

ipcMain.handle('history:delete', (_e, id) => {
  deleteConversation(id);
  return { ok: true };
});

// 会话全文搜索:在标题 + 对话正文(chat 的 user/assistant、create 的 prompt)里
//   做大小写不敏感子串匹配。目录式存储下按 updatedAt 新→旧逐文件扫描,凑满 cap 即提前停 ——
//   扫描序与结果序一致,无需再排序。个人量级(几百会话)全扫也在毫秒级,无需 DB/FTS5。
//   返回命中会话 {id,title,kind,mode,fromScheduled,updatedAt,snippet,matchField},按 updatedAt 倒序。
ipcMain.handle('history:search', (_e, { query, limit } = {}) => {
  const q = String(query || '').trim();
  if (!q) return { ok: true, items: [] };
  const qLower = q.toLowerCase();
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  // 在一段文本里找命中,返回前后约 30 字的片段 + 用 \x00…\x01 包裹命中词(前端转 <mark>)
  const SNIP = 30;
  const makeSnippet = (text) => {
    const t = String(text || '');
    const idx = t.toLowerCase().indexOf(qLower);
    if (idx < 0) return null;
    const start = Math.max(0, idx - SNIP);
    const end = Math.min(t.length, idx + q.length + SNIP);
    let s = t.slice(start, end);
    // 在片段内把命中词(可能多处)用哨兵包裹
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, (m) => '\x00' + m + '\x01');
    return (start > 0 ? '…' : '') + s + (end < t.length ? '…' : '');
  };

  const results = [];
  try {
    forEachConversation((c) => {
      const kind = c.kind || 'chat';
      let snippet = null, matchField = null;
      // 命中正文时记下定位:turnIndex = 命中所在 turn 的下标;matchSide = 命中在该 turn 的哪一侧
      //   (user / assistant / prompt),供前端打开会话后精确滚动到那条消息。标题命中则保持 null。
      let turnIndex = null, matchSide = null;
      // 标题
      if ((c.title || '').toLowerCase().includes(qLower)) { snippet = makeSnippet(c.title); matchField = 'title'; }
      // 正文(首条命中即可)
      if (!snippet) {
        const turns = c.turns || [];
        for (let ti = 0; ti < turns.length; ti++) {
          const t = turns[ti];
          const fields = kind === 'create' ? [['prompt', t.prompt]] : [['user', t.user], ['assistant', t.assistant]];
          for (const [side, f] of fields) {
            if (f && String(f).toLowerCase().includes(qLower)) {
              snippet = makeSnippet(f); matchField = 'body'; turnIndex = ti; matchSide = side; break;
            }
          }
          if (snippet) break;
        }
      }
      if (snippet) {
        results.push({
          id: c.id, title: c.title || '未命名', kind, mode: c.mode || 'plain',
          fromScheduled: c.fromScheduled || null, updatedAt: c.updatedAt || c.createdAt || '',
          snippet, matchField, turnIndex, matchSide,
        });
      }
      return results.length < cap;   // 凑满即提前终止扫描
    });
  } catch (_) { return { ok: true, items: [] }; }
  return { ok: true, items: results };
});

// 从 transcript 派生「技能用量」。旧实现会在 Relay 启动 3 秒后同步全扫全部 JSONL，
// 既阻塞 Electron 主进程，又会在当前会话继续写入后迅速失效。现在改为：
//   1. 主进程只同步读取一个很小的持久化索引；
//   2. 打开技能页时立即返回索引里的旧值；
//   3. Worker 线程只读取新增文件/已有文件的追加尾部，完成后通知技能页无闪更新。
const SKILL_USAGE_INDEX_VERSION = 2;
const SKILL_USAGE_INDEX_FILE = path.join(app.getPath('userData'), 'skill-usage-index.json');
const SKILL_USAGE_WORKER_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'skill-usage-worker.js')
  : path.join(__dirname, 'skill-usage-worker.js');
let _skillUsageState = null;        // { index, map, ready }
let _skillUsageRefreshPromise = null;
let _skillUsageLastRefreshAt = 0;

function skillStatsArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    map.set(item.name, {
      useCount: Math.max(0, Number(item.useCount) || 0),
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
      feedbackOpportunities: Math.max(0, Number(item.feedbackOpportunities) || 0),
      correctionCount: Math.max(0, Number(item.correctionCount) || 0),
      retryCount: Math.max(0, Number(item.retryCount) || 0),
      toolErrorCount: Math.max(0, Number(item.toolErrorCount) || 0),
      positiveCount: Math.max(0, Number(item.positiveCount) || 0),
      lastNegativeAt: typeof item.lastNegativeAt === 'string' ? item.lastNegativeAt : null,
    });
  }
  return map;
}

function memoryStatsArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    map.set(item.name, {
      readCount: Math.max(0, Number(item.readCount) || 0),
      lastReadAt: typeof item.lastReadAt === 'string' ? item.lastReadAt : null,
    });
  }
  return map;
}

function loadSkillUsageState() {
  if (_skillUsageState) return _skillUsageState;
  let index = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_USAGE_INDEX_FILE, 'utf8'));
    if (parsed && parsed.version === SKILL_USAGE_INDEX_VERSION) index = parsed;
  } catch (_) {}
  _skillUsageState = {
    index,
    map: skillStatsArrayToMap(index && index.skills),
    memoryMap: memoryStatsArrayToMap(index && index.memories),
    ready: !!index,
  };
  return _skillUsageState;
}

async function persistSkillUsageIndex(index) {
  const tmp = SKILL_USAGE_INDEX_FILE + '.tmp';
  await fs.promises.mkdir(path.dirname(SKILL_USAGE_INDEX_FILE), { recursive: true });
  await fs.promises.writeFile(tmp, Buffer.from(JSON.stringify(index), 'utf8'));
  await fs.promises.rename(tmp, SKILL_USAGE_INDEX_FILE);
}

function notifySkillUsageUpdated(payload = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send('skills:usageUpdated', payload); } catch (_) {}
  }
}

function refreshSkillUsageInBackground({ force = false } = {}) {
  if (_skillUsageRefreshPromise) return _skillUsageRefreshPromise;
  const now = Date.now();
  // 同一技能页内的重复 overview/操作不反复创建 Worker；当前对话仍在写时，15 秒后再校准即可。
  if (!force && _skillUsageLastRefreshAt && now - _skillUsageLastRefreshAt < 15000) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const state = loadSkillUsageState();
  _skillUsageLastRefreshAt = now;
  const startedAt = Date.now();
  _skillUsageRefreshPromise = new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(SKILL_USAGE_WORKER_FILE, {
      workerData: {
        projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
        memoryDir: MEMORY_DIR,
        previous: state.index,
      },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      _skillUsageRefreshPromise = null;
      resolve(result);
    };
    worker.once('message', async (result) => {
      if (!result || !result.ok || !result.index) {
        console.warn('[skill-usage] 增量索引失败: %s', (result && result.message) || '未知错误');
        finish(result || { ok: false });
        return;
      }
      if (result.complete === false) {
        console.warn('[skill-usage] 本次统计不完整，保留原快照 errors=%d', Object.values(result.integrity || {}).reduce((sum, value) => sum + (Number(value) || 0), 0));
        finish({ ok: false, complete: false, message: '本次统计不完整，已保留原快照' });
        return;
      }
      try {
        if (!result.changed && state.ready) {
          console.log(
            '[skill-usage] 索引已是最新 files=%d duration=%dms',
            result.totalFiles || 0,
            Date.now() - startedAt,
          );
          finish(result);
          return;
        }
        await persistSkillUsageIndex(result.index);
        _skillUsageState = {
          index: result.index,
          map: skillStatsArrayToMap(result.index.skills),
          memoryMap: memoryStatsArrayToMap(result.index.memories),
          ready: true,
        };
        console.log(
          '[skill-usage] 增量索引完成 files=%d changed=%d bytes=%d duration=%dms',
          result.totalFiles || 0,
          result.scannedFiles || 0,
          result.scannedBytes || 0,
          Date.now() - startedAt,
        );
        // 首次建立索引或 transcript 有变化时才让可见技能页更新；不清空现有列表。
        if (result.changed || !state.ready) {
          notifySkillUsageUpdated({ updatedAt: result.index.updatedAt });
        }
        finish(result);
      } catch (e) {
        console.warn('[skill-usage] 索引落盘失败: %s', e.message);
        finish({ ok: false, message: e.message });
      }
    });
    worker.once('error', (error) => {
      console.warn('[skill-usage] Worker 失败: %s', error.message);
      finish({ ok: false, message: error.message });
    });
    worker.once('exit', (code) => {
      if (code !== 0) finish({ ok: false, message: `Worker 退出码 ${code}` });
    });
  });
  return _skillUsageRefreshPromise;
}

// ─────────────────────────────────────────
// IPC: 用量统计。只返回小快照；历史统计和指标持久化均在 Worker 中执行。
const { UsageStatsService } = require('./usage-stats-service');
let usageStatsService = null;
let usageShutdownPending = false;
let usageShutdownComplete = false;
function getUsageStatsService() {
  if (!usageStatsService) usageStatsService = new UsageStatsService({
    historyDir: path.join(app.getPath('userData'), 'history'),
    cacheDir: path.join(app.getPath('userData'), 'usage-stats'),
    workerFile: app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'usage-stats-worker.js')
      : path.join(__dirname, 'usage-stats-worker.js'),
    onUpdated: payload => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('stats:updated', payload); } catch (_) {}
      }
    },
  });
  return usageStatsService;
}
function recordRelayUsage(record, source, conversationId = null) {
  if (usageShutdownComplete) return;
  try { getUsageStatsService().recordUsage({ ...record, source, conversationId }); }
  catch (error) { console.warn('[usage] 记录指标失败:', error.message); }
}
ipcMain.handle('stats:overview', (_event, { days, force } = {}) =>
  getUsageStatsService().overview({ days, force: force === true }));

// ─────────────────────────────────────────
// IPC: 设置(Relay 私有供应商配置 + 本地 app 偏好)
// ─────────────────────────────────────────
function settingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }
function appSettingsPath() { return path.join(app.getPath('userData'), 'app-settings.json'); }

const PROVIDER_ISOLATION_SETTINGS_VERSION = 1;
const IMAGE_PROVIDER_MIGRATION_VERSION = 1;
const LEGACY_IMAGE_MODELS = Object.freeze([
  { adapterId: 'gpt-image-2', remoteModelId: 'azure_openai/gpt-image-2' },
  { adapterId: 'seedream-5.0', remoteModelId: 'volcengine_maas/Doubao-Seedream-5.0-lite' },
  { adapterId: 'seedream-4.5', remoteModelId: 'volcengine_maas/Doubao-Seedream-4.5' },
]);

// 外部 Claude 配置从此只读：用于一次性迁移和兼容 Git Bash / MCP 资源，
// Relay 的 API、模型与行为设置不再写回这个文件。
function readLegacyClaudeSettings() {
  const f = settingsPath();
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.error('[settings] 外部 Claude 配置解析失败:', e.message); return {}; }
}
function readAppSettings() {
  const f = appSettingsPath();
  const hasExistingSettings = fs.existsSync(f);
  let settings = {
    permissionMode: 'default',
    providerIsolationSettingsVersion: 0,
    firstRunSetupVersion: 0,
  };
  try {
    if (hasExistingSettings) {
      const parsed = appSettingsCache.read(f);
      settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : settings;
    }
    let changed = false;
    if (settings.sdkMemoryMode !== 'relay' || settings.sdkAutoDreamEnabled !== false) {
      settings.sdkMemoryMode = 'relay'; settings.sdkAutoDreamEnabled = false; changed = true;
    }
    const permissionMode = normalizeAppPermissionMode(settings.permissionMode, { hasExistingSettings });
    if (settings.permissionMode !== permissionMode) {
      settings.permissionMode = permissionMode;
      changed = true;
    }
    if (settings.providerIsolationSettingsVersion !== PROVIDER_ISOLATION_SETTINGS_VERSION) {
      // 历史图像 Key 也移入同一系统密钥仓，不再以明文留在 app-settings.json。
      if (settings.imageApi && typeof settings.imageApi.apiKey === 'string' && settings.imageApi.apiKey.trim()) {
        providerStore.setAppSecret('image-api-key', settings.imageApi.apiKey);
        delete settings.imageApi.apiKey;
      }
      settings.providerIsolationSettingsVersion = PROVIDER_ISOLATION_SETTINGS_VERSION;
      changed = true;
    }
    if (settings.imageProviderMigrationVersion !== IMAGE_PROVIDER_MIGRATION_VERSION) {
      try {
        const legacyImage = settings.imageApi && typeof settings.imageApi === 'object'
          ? settings.imageApi
          : {};
        const legacyKey = providerStore.getAppSecret('image-api-key');
        if (legacyImage.baseUrl && legacyKey) {
          providerStore.migrateLegacyImageProvider({
            baseUrl: legacyImage.baseUrl,
            apiKey: legacyKey,
            imageModels: LEGACY_IMAGE_MODELS,
          });
        }
        delete settings.imageApi;
        providerStore.deleteAppSecret('image-api-key');
        settings.imageProviderMigrationVersion = IMAGE_PROVIDER_MIGRATION_VERSION;
        changed = true;
      } catch (error) {
        // 保留旧配置与迁移标记，下次启动可继续尝试，避免静默丢失可用凭据。
        console.warn('[settings] 旧版图像配置迁移失败: %s', error.message);
      }
    }
    if (changed) {
      try { writeAppSettings(settings); }
      catch (error) { console.warn('[settings] Relay 私有设置迁移写入失败: %s', error.message); }
    }
    return settings;
  }
  catch (e) {
    console.error('[settings] app-settings 解析失败: %s', e.message);
    return {
      permissionMode: 'default',
      providerIsolationSettingsVersion: PROVIDER_ISOLATION_SETTINGS_VERSION,
      imageProviderMigrationVersion: IMAGE_PROVIDER_MIGRATION_VERSION,
      firstRunSetupVersion: 0,
    };
  }
}
function writeAppSettings(data) {
  data = { ...data, sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false };
  const f = appSettingsPath();
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  appSettingsCache.invalidate();
  miniBrandCache = null;
  if (miniHost) publishMiniState();
}

function permissionCaller(event) {
  return !!event && !!event.sender && event.senderFrame === event.sender.mainFrame
    && ((mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) || miniPanelCaller(event));
}
function permissionError(error) { return { ok: false, ...(error.current ? { current: error.current } : {}), error: error.message || '无法更新权限', code: error.code || 'PERMISSION_UPDATE_FAILED' }; }
ipcMain.handle('permissions:get', (event, conversationId) => {
  if (!permissionCaller(event)) return { ok: false, error: '此窗口不能读取对话权限', code: 'FORBIDDEN' };
  try { return getConversationPermissions().get(conversationId); } catch (error) { return permissionError(error); }
});
ipcMain.handle('permissions:set', async (event, input) => {
  if (!permissionCaller(event)) return { ok: false, error: '此窗口不能修改对话权限', code: 'FORBIDDEN' };
  try { return await getConversationPermissions().set(input); } catch (error) { return permissionError(error); }
});

ipcMain.handle('settings:read', () => {
  const provider = providerStore.getSettingsView();
  const a = readAppSettings();
  return {
    claude: {
      // 密钥不回传 renderer；当前设置页以“留空表示不修改”兼容。
      apiKey:        '',
      hasApiKey:     provider.hasCredential,
      apiKeyHint:    provider.credentialHint,
      baseUrl:       provider.baseUrl || '',
      opusModel:     provider.models.opus || '',
      sonnetModel:   provider.models.sonnet || '',
      haikuModel:    provider.models.haiku || '',
      defaultModel:  provider.defaultModel || 'haiku',
      providerId: provider.id,
      providerRevision: provider.revision,
      routes: provider.routes,
      isolated: true,
    },
    app: {
      ...normalizePreferences(a),
      allowCommandTasks: !!a.allowCommandTasks,   // 命令类定时任务总开关（默认关）
      quickChatEnabled: isQuickChatEnabled(a),
      miniInputEnabled: isQuickChatEnabled(a), // 兼容旧版设置读取
      floatingOrbEnabled: isQuickChatEnabled(a),
      conversationIndex: a.conversationIndex !== false, // 对话快捷索引（默认开；仅显式 false 才关）
      showContextUsage: a.showContextUsage !== false,
      theme: a.theme || 'light',
      skillMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.skillMaintenanceModel) ? a.skillMaintenanceModel : '',
      memoryMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.memoryMaintenanceModel) ? a.memoryMaintenanceModel : '',
    },
    info: {
      uiVersion:    app.getVersion ? app.getVersion() : 'dev',
    },
  };
});

ipcMain.handle('settings:write', async (_e, payload = {}) => {
  let preferencePatch;
  try { preferencePatch = { ...await generalPreferences.validatePatch(payload.app || {}), ...normalizeQuickChatPatch(payload.app || {}) }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
  const a = readAppSettings();
  const previousEnvironment = normalizePreferences(a).agentEnvironment;
  if (payload.app && Object.hasOwn(payload.app, 'permissionMode')
      && !isAppPermissionMode(payload.app.permissionMode)) {
    return { ok: false, message: '权限模式无效' };
  }
  let defaultModelChange = null;
  if (payload.claude && Object.hasOwn(payload.claude, 'defaultModel')) {
    try { defaultModelChange = providerStore.setDefaultModel(payload.claude.defaultModel); }
    catch (error) { return { ok: false, message: error.message }; }
  }
  if (payload.app) {
    const appPatch = { ...payload.app, ...preferencePatch };
    delete appPatch.defaultModel;
    delete appPatch.permissionMode;
    delete appPatch.conversationPermissions;
    delete appPatch.skipDangerousPrompt;
    Object.assign(a, appPatch);
    // 主题切换 → 同步 Electron nativeTheme + 窗口背景色
    if (payload.app.theme) {
      nativeTheme.themeSource = payload.app.theme === 'system' ? 'system'
                              : payload.app.theme === 'dark'   ? 'dark' : 'light';
      const bg = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa';
      for (const w of BrowserWindow.getAllWindows()) {
        if (miniHost && miniHost.ownsWebContents(w.webContents)) continue;
        try {
          if (w === mainWindow && process.platform === 'win32') {
            syncMainWindowChromeAppearance(w, {
              dark: nativeTheme.shouldUseDarkColors,
              searchOpen: mainWindowChromeAppearances.get(w)?.searchOpen === true,
            });
          } else w.setBackgroundColor(bg);
        } catch (e) { console.warn('[settings] 设置窗口背景色失败: %s', e.message); }
      }
    }
  }
  delete a.defaultModel;
  try { writeAppSettings(a); }
  catch (error) {
    const prefix = defaultModelChange && defaultModelChange.changed
      ? '默认档位已保存，其他本地偏好保存失败：'
      : '本地偏好保存失败：';
    return { ok: false, message: prefix + error.message };
  }
  if (payload.app?.theme) updateNativeBrandTheme();
  if (Object.hasOwn(preferencePatch, 'maxParallelTasks')) applyParallelTaskLimit(preferencePatch.maxParallelTasks);
  if (defaultModelChange && defaultModelChange.changed) publishProviderChange('更新默认档位');
  if (previousEnvironment !== normalizePreferences(a).agentEnvironment) {
    supportedModelsCache.clear();
    for (const sess of [...liveSessions.values()]) if (!sess.busy) killLiveSession(sess, '智能体运行环境已切换');
  }
  // Apply after persistence so shortcuts and window visibility read the new values.
  if (Object.hasOwn(preferencePatch, 'quickChatEnabled')) {
    registerMiniShortcut();
    getMiniWindowHost().syncSettings();
    refreshTrayMenu();
  }
  miniBrandCache = null;
  if (miniHost) publishMiniState();
  return { ok: true,
    ...(defaultModelChange ? { routes: providerStore.getRoutingView() } : {}) };
});

// ─────────────────────────────────────────
// IPC: Relay 服务商管理
// ─────────────────────────────────────────
ipcMain.handle('providers:list', () => ({
  ok: true,
  profiles: providerStore.listProfiles(),
  routes: providerStore.getRoutingView(),
}));

ipcMain.handle('providers:create', (_event, input = {}) => {
  try {
    const result = providerStore.createProfile(input);
    publishProviderChange('新增', { runtimeChanged: !!result.chatRoutesChanged });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('providers:update', (_event, { id, patch } = {}) => {
  try {
    const before = providerStore.getProfile(id);
    const result = providerStore.updateProfile(id, patch || {});
    publishProviderChange('更新', {
      runtimeChanged: !!(result.chatRoutesChanged
        || (before && before.activeTiers && before.activeTiers.length && result.runtimeChanged)),
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('providers:duplicate', (_event, id) => {
  try {
    const result = providerStore.duplicateProfile(id);
    publishProviderChange('复制');
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('providers:remove', (_event, id) => {
  try {
    const result = providerStore.removeProfile(id);
    publishProviderChange('删除');
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('providers:setImageRoute', (_event, { adapterId, id } = {}) => {
  try {
    const result = providerStore.setImageRoute(adapterId, id || null);
    if (result.changed) publishProviderChange('切换图像模型');
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('providers:test', async (_event, id) => {
  try {
    const runtime = providerStore.getRuntime(id);
    if (!runtime) return { ok: false, scope: 'saved', message: '该服务商尚未配置对话模型、Base URL 或 API Key' };
    const result = await testProviderConnection(runtime);
    const before = providerStore.getProfile(id);
    // A response from a previous URL/key/model must not update this profile's
    // auth mode or be shown as proof for a newly saved configuration.
    if (!before || Number(before.revision) !== Number(runtime.revision)) {
      return { ...result, ok: false, scope: 'saved', stale: true, message: '服务商配置已变更，请重新检测' };
    }
    if (!result.ok || !result.authMode) return { ...result, scope: 'saved', profile: before };
    const stored = providerStore.setAuthMode(id, result.authMode);
    if (stored.changed) {
      publishProviderChange('Anthropic 认证方式更新', {
        runtimeChanged: !!(before.activeTiers && before.activeTiers.length),
      });
    }
    return { ...result, scope: 'saved', profile: stored.profile };
  } catch (error) {
    return { ok: false, scope: 'saved', message: error.message || '连接检测失败' };
  }
});

ipcMain.handle('providers:testDraft', async (_event, draft = {}) => {
  try {
    const input = draft && typeof draft === 'object' ? draft : {};
    const existing = input.id ? providerStore.getConnectionRuntime(input.id) : null;
    const runtime = createProviderDraftRuntime(input, existing, { requireModel: true });
    return { ...await testProviderConnection(runtime), scope: 'draft', tier: runtime.tier };
  } catch (error) {
    return { ok: false, scope: 'draft', message: error.message || '连接检测失败' };
  }
});

ipcMain.handle('providers:discoverModels', async (_event, id) => {
  const runtime = providerStore.getConnectionRuntime(id);
  if (!runtime) return { ok: false, models: [], message: '该服务商尚未配置 Base URL 或 API Key' };
  const discovered = await discoverProviderModels(runtime);
  const imageModels = Array.isArray(discovered.imageModels) ? discovered.imageModels : [];
  const models = Array.isArray(discovered.models) ? discovered.models : [];
  try {
    const before = providerStore.getProfile(id);
    // Discovery is scoped to the URL/key/revision that started the request.
    // Do not let an old response restore capabilities after a key change.
    if (!before || Number(before.revision) !== Number(runtime.revision)) {
      return {
        ...discovered, ok: false, stale: true,
        models: [], modelCatalog: [], imageModels: [], totalModels: 0,
        message: '服务商配置已变更，请重新获取模型目录',
      };
    }
    // 同域根路径回退只用于读取共享模型目录；它可能是 OpenAI 风格目录，
    // 不能据此改变 Claude Messages 的认证方式。只有 Anthropic 主路径命中时才记忆认证。
    const auth = discovered.ok && discovered.authMode && !discovered.gatewayRootFallbackUsed
      ? providerStore.setAuthMode(id, discovered.authMode)
      : { changed: false };
    const stored = providerStore.setDiscoveredImageModels(
      id,
      discovered.ok ? imageModels : null,
      {
        status: discovered.ok
          ? (imageModels.length ? 'ready' : 'none')
          : 'error',
        message: discovered.message,
        modelCount: Number(discovered.totalModels) || models.length,
        claimUnassignedRoutes: false,
      },
    );
    if (stored.routesChanged || auth.changed) {
      publishProviderChange(
        auth.changed ? 'Anthropic 认证与模型能力更新' : '图像能力更新',
        { runtimeChanged: !!(auth.changed && before && before.activeTiers && before.activeTiers.length) },
      );
    }
    return { ...discovered, profile: stored.profile };
  } catch (error) {
    return { ...discovered, ok: false, message: error.message };
  }
});

ipcMain.handle('providers:discoverDraftModels', async (_event, draft = {}) => {
  try {
    const input = draft && typeof draft === 'object' ? draft : {};
    const existing = input.id ? providerStore.getConnectionRuntime(input.id) : null;
    return await discoverProviderModels(createProviderDraftRuntime(input, existing));
  } catch (error) {
    return { ok: false, models: [], message: error.message || '模型目录探测失败' };
  }
});

// ─────────────────────────────────────────
// IPC: 品牌自定义(侧边栏左上角 logo 图片 + 名称)
// ─────────────────────────────────────────
//   名称存 app-settings.json 的 brandName(按视觉宽度限制,与历史对话标题同规则);
//   logo 图片拷贝进 userData/brand-logo.<ext>(随应用升级/重装不丢,不写进配置文件),
//   只在 app-settings.json 存相对文件名 brandLogo。渲染端拿 data URL 显示(避免 file://
//   在打包后的 contextIsolation 下的路径/缓存坑)。
// 名称长度上限 = 视觉宽度 40(全角/CJK/emoji 记 2、英文/数字记 1),即约 20 个中文或 40 个英文。
//   窄侧栏自然省略，悬停可查看全名；保存时明确拒绝超限，避免静默修改用户输入。
const BRAND_NAME_MAX = 40;
const BRAND_IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'];
const BRAND_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
function brandLogoAbsPath() {
  const a = readAppSettings();
  if (!a.brandLogo) return null;
  const p = path.join(app.getPath('userData'), a.brandLogo);
  return fs.existsSync(p) ? p : null;
}
// 读 logo 为 data URL(没有自定义则返回 null,渲染端按主题回落到内置 Dual Gate SVG)
function brandLogoDataUrl() {
  const p = brandLogoAbsPath();
  if (!p) return null;
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = BRAND_MIME[ext] || 'image/png';
    const b64 = fs.readFileSync(p).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch { return null; }
}

// A preview is held in memory and belongs to one trusted main renderer. Canceling
// never writes a file or restores settings after the fact.
const brandLogoPreviews = new WeakMap();
function brandProfileCaller(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && !!event?.sender
    && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
}
function brandProfileRevision(settings) {
  return crypto.createHash('sha256').update(JSON.stringify([settings.brandName || '', settings.brandLogo || ''])).digest('hex');
}
function brandProfileSnapshot() {
  const settings = readAppSettings();
  return { name: typeof settings.brandName === 'string' ? settings.brandName : '', nameMax: BRAND_NAME_MAX, logo: brandLogoDataUrl(), revision: brandProfileRevision(settings) };
}
ipcMain.handle('brand:pickLogoPreview', async event => {
  if (!brandProfileCaller(event)) return { ok: false, code: 'FORBIDDEN', error: '此窗口不能编辑个人资料' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择个人资料头像', properties: ['openFile'], filters: [{ name: '图片', extensions: BRAND_IMG_EXT.map(ext => ext.slice(1)) }] });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    if (!brandProfileCaller(event)) return { ok: false, code: 'FORBIDDEN', error: '编辑窗口已经关闭' };
    const file = result.filePaths[0], ext = path.extname(file).toLowerCase();
    if (!BRAND_IMG_EXT.includes(ext)) return { ok: false, error: '不支持的图片格式' };
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > 5 * 1024 * 1024) return { ok: false, error: '请选择小于 5MB 的图片' };
    const bytes = fs.readFileSync(file);
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) return { ok: false, error: '图片为空或超过 5MB' };
    const previewId = crypto.randomUUID();
    brandLogoPreviews.set(event.sender, { previewId, ext, bytes });
    return { ok: true, previewId, logo: `data:${BRAND_MIME[ext]};base64,${bytes.toString('base64')}` };
  } catch (error) { return { ok: false, error: '读取图片失败：' + error.message }; }
});
ipcMain.handle('brand:discardLogoPreview', (event, previewId) => {
  if (!brandProfileCaller(event)) return { ok: false, code: 'FORBIDDEN' };
  const preview = brandLogoPreviews.get(event.sender);
  if (!previewId || preview?.previewId === previewId) brandLogoPreviews.delete(event.sender);
  return { ok: true };
});
ipcMain.handle('brand:saveProfile', (event, input) => {
  if (!brandProfileCaller(event)) return { ok: false, code: 'FORBIDDEN', error: '此窗口不能编辑个人资料' };
  if (!input || typeof input.name !== 'string' || !['keep', 'default', 'replace'].includes(input.logoAction)) return { ok: false, code: 'INVALID_PROFILE', error: '个人资料格式不正确' };
  const name = input.name.replace(/[\r\n\t]/g, ' ').trim();
  if (toGraphemes(name).reduce((sum, part) => sum + graphemeWidth(part), 0) > BRAND_NAME_MAX) return { ok: false, code: 'NAME_TOO_LONG', error: '名称过长：最多约 20 个汉字或 40 个英文字符', nameMax: BRAND_NAME_MAX };
  const settings = readAppSettings();
  if (input.expectedRevision !== brandProfileRevision(settings)) return { ok: false, code: 'PROFILE_CHANGED', error: '个人资料已在其他地方更新，请重新打开后编辑' };
  const preview = brandLogoPreviews.get(event.sender);
  if (input.logoAction === 'replace' && (!preview || preview.previewId !== input.previewId)) return { ok: false, code: 'PREVIEW_EXPIRED', error: '头像预览已失效，请重新选择图片' };
  const oldLogo = settings.brandLogo;
  let createdPath = null;
  try {
    if (name) settings.brandName = name; else delete settings.brandName;
    if (input.logoAction === 'default') delete settings.brandLogo;
    if (input.logoAction === 'replace') {
      settings.brandLogo = `brand-logo-${crypto.randomUUID()}${preview.ext}`;
      createdPath = path.join(app.getPath('userData'), settings.brandLogo);
      fs.mkdirSync(path.dirname(createdPath), { recursive: true });
      fs.writeFileSync(createdPath, preview.bytes, { flag: 'wx' });
    }
    // The unique image is not observable until the single atomic settings rename.
    writeAppSettings(settings);
  } catch (error) {
    if (createdPath) { try { fs.rmSync(createdPath, { force: true }); } catch (_) {} }
    return { ok: false, code: 'PROFILE_SAVE_FAILED', error: '保存失败：' + error.message };
  }
  brandLogoPreviews.delete(event.sender);
  if (oldLogo && oldLogo !== settings.brandLogo && /^brand-logo(?:-[a-f\d-]+)?\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(oldLogo)) {
    try { fs.rmSync(path.join(app.getPath('userData'), oldLogo), { force: true }); } catch (_) {}
  }
  return { ok: true, ...brandProfileSnapshot() };
});

ipcMain.handle('brand:get', () => {
  return brandProfileSnapshot();
});

// ── 迷你输入框 IPC ──
// 渲染端拉品牌(名称 + logo data URL),用于迷你窗头部展示。
ipcMain.handle('mini:brand', () => {
  const a = readAppSettings();
  return {
    name: (typeof a.brandName === 'string' && a.brandName) ? a.brandName : 'Relay',
    logo: brandLogoDataUrl(),
    enabled: isQuickChatEnabled(a),
    shortcut: registeredMiniAccel,
    theme: a.theme || 'light',
  };
});
// Only the quick-chat panel may mutate its conversation. The orb controls visibility.
ipcMain.handle('mini:state', async event => {
  if (miniOrbCaller(event)) return { ...getMiniWindowHost().getState(), running: !!miniChat?.isRunning(), brand: miniBrandSnapshot() };
  if (!miniPanelCaller(event)) return { ok: false };
  await getMiniChat().refresh();
  return miniSnapshot();
});
require('./mini-local-images').registerMiniLocalImages({
  ipcMain, isCaller: event => miniPanelCaller(event)
    && event.senderFrame.url === pathToFileURL(path.join(__dirname, 'renderer', 'mini.html')).href,
  getConversationId: () => miniChat?.getConversationId(),
  readImage: input => workspaceTools.readLocalImage(input),
});
ipcMain.handle('mini:submit', (event, input) => miniPanelCaller(event) ? submitMiniChatRequest(input) : { ok: false, error: '无权发送小窗消息' });
ipcMain.handle('mini:pause', event => miniPanelCaller(event) ? getMiniChat().pause() : { ok: false });
ipcMain.handle('mini:newChat', event => miniPanelCaller(event) ? getMiniChat().newChat() : { ok: false });
ipcMain.handle('mini:hide', event => miniPanelCaller(event) ? getMiniWindowHost().hide() : { ok: false });
ipcMain.handle('mini:resize', (event, input) => miniPanelCaller(event)
  ? getMiniWindowHost().resize(typeof input === 'object' && input ? input.height : input, { reduceMotion: !!(input && input.reducedMotion) }) : { ok: false });
ipcMain.handle('mini:setPinned', (event, pinned) => miniPanelCaller(event) ? getMiniWindowHost().setPinned(pinned === true) : { ok: false });
ipcMain.handle('mini:openMain', event => miniPanelCaller(event) ? openMiniConversationInMain() : { ok: false });
ipcMain.handle('mini:toggle', event => miniOrbCaller(event) ? getMiniWindowHost().toggle({ source: 'orb' }) : { ok: false });
ipcMain.handle('mini:orbDrag', (event, input) => miniOrbCaller(event) ? getMiniWindowHost().orbDrag(input) : { ok: false });
ipcMain.handle('mini:orbMenu', event => miniOrbCaller(event) ? getMiniWindowHost().showContextMenu() : { ok: false });
ipcMain.handle('mini:mainReady', event => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
  miniMainReadySender = event.sender;
  const id = pendingMiniConversationId;
  pendingMiniConversationId = null;
  return { ok: true, id };
});

ipcMain.handle('brand:setName', (_e, name) => {
  const a = readAppSettings();
  // 与渲染端使用相同的字素视觉宽度；先规范空白，超限时保留原设置。
  const clean = String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim();
  const width = toGraphemes(clean).reduce((sum, grapheme) => sum + graphemeWidth(grapheme), 0);
  if (width > BRAND_NAME_MAX) {
    return { ok: false, error: `应用名称过长：最多约 ${Math.floor(BRAND_NAME_MAX / 2)} 个汉字或 ${BRAND_NAME_MAX} 个英文字符。`, nameMax: BRAND_NAME_MAX };
  }
  if (clean) a.brandName = clean; else delete a.brandName;   // 清空 = 恢复默认名 "Relay"
  writeAppSettings(a);
  return { ok: true, name: clean };
});

ipcMain.handle('brand:pickLogo', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择 Logo 图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: BRAND_IMG_EXT.map((e) => e.slice(1)) }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!BRAND_IMG_EXT.includes(ext)) return { ok: false, message: '不支持的图片格式' };
  try {
    const st = fs.statSync(src);
    if (st.size > 5 * 1024 * 1024) return { ok: false, message: '图片过大(请小于 5MB)' };
    // 先清掉旧的 brand-logo.*,避免换格式后残留多份
    const ud = app.getPath('userData');
    for (const e of BRAND_IMG_EXT) {
      const old = path.join(ud, `brand-logo${e}`);
      if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
    }
    const destName = `brand-logo${ext}`;
    fs.copyFileSync(src, path.join(ud, destName));
    const a = readAppSettings();
    a.brandLogo = destName;
    writeAppSettings(a);
    return { ok: true, logo: brandLogoDataUrl() };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  }
});

ipcMain.handle('brand:resetLogo', () => {
  const a = readAppSettings();
  const ud = app.getPath('userData');
  for (const e of BRAND_IMG_EXT) {
    const old = path.join(ud, `brand-logo${e}`);
    if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
  }
  delete a.brandLogo;
  writeAppSettings(a);
  return { ok: true };
});

// ─────────────────────────────────────────
// IPC: 数据中心(在 UI 内直接编辑配置 / 管理 Agent & 技能 / 导入 zip)
// ─────────────────────────────────────────
function claudeJsonPath() { return path.join(os.homedir(), '.claude.json'); }

// 极简 YAML frontmatter 解析(只取顶层 key: value),用于显示 agent/skill 描述
function parseFrontmatter(text) {
  const out = {};
  const m = String(text || '').match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
function listAgentNames() {
  try {
    const custom = readAppSettings().agentNames || {};   // { file → 用户自定义显示名 }
    return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => {
        let desc = '', fmName = '';
        try {
          const fm = parseFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, e.name), 'utf8'));
          desc = fm.description || '';
          fmName = fm.name || '';
        } catch (_) {}
        // name = Claude 实际识别的子智能体 id(优先取 frontmatter.name,否则文件名)
        const name = fmName || e.name.replace(/\.md$/i, '');
        // displayName = 用户自定义名(若设过),否则用 name —— 仅用于界面显示
        const displayName = (custom[e.name] && String(custom[e.name]).trim()) || name;
        return { name, file: e.name, desc, displayName };
      });
  } catch (e) { console.warn('[agent] 列表读取失败: %s', e.message); return []; }
}
function parseSkillPresentationYaml(file) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const scalar = (value) => {
      const s = String(value || '').trim();
      if (!s) return '';
      if (s.startsWith('"') && s.endsWith('"')) {
        try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); }
      }
      if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
      return s.replace(/\s+#.*$/, '').trim();
    };
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(display_name|short_description|default_prompt)\s*:\s*(.*?)\s*$/);
      if (m) out[m[1]] = scalar(m[2]);
    }
  } catch (_) {}
  return out;
}

function skillBodyPresentation(raw, fallbackName, fallbackDesc) {
  const body = String(raw || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
  const lines = body.split(/\r?\n/);
  let title = '';
  let paragraph = [];
  for (const line of lines) {
    const text = line.trim();
    if (!title) {
      const h1 = text.match(/^#\s+(.+)$/);
      if (h1) { title = h1[1].trim(); continue; }
    }
    if (!text) {
      if (paragraph.length) break;
      continue;
    }
    // 标题、列表、代码块、引用和表格不是摘要；优先取 H1 后的第一段自然语言。
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|>|---+$|\|)/.test(text)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(text);
    if (paragraph.join(' ').length >= 180) break;
  }
  return {
    displayName: title || fallbackName,
    summary: paragraph.join(' ').trim() || fallbackDesc || '',
  };
}

function cleanSkillPresentationText(value, maxLength) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, maxLength);
}

// 用快速模型为新安装的 Skill 生成 Relay 专属中文展示元数据。
// 文件位置沿用 Codex 的 agents/openai.yaml 约定，改用 agents/relay.yaml；
// 它只负责界面展示，Claude Code 实际调用仍使用 SKILL.md frontmatter.name。
async function generateSkillPresentationWithClaude(skillName, callName, description, skillBody) {
  const source = String(skillBody || '').slice(0, 7000);
  const prompt = [
    '请根据下面的 Skill 定义，为桌面 AI 助手生成中文展示元数据。',
    '要求：',
    '1. display_name：准确、自然的中文标题，建议 4-16 个汉字；必要的产品名、缩写可保留。',
    '2. short_description：一句中文摘要，建议 18-45 个汉字；说明这个技能能做什么以及适用场景。',
    '3. 不要夸大能力，不要添加原文没有的信息。',
    '4. 只输出一行严格 JSON，不要 Markdown、代码围栏或解释。',
    'JSON 格式：{"display_name":"中文标题","short_description":"中文摘要"}',
    '',
    `目录名：${skillName}`,
    `调用 ID：${callName}`,
    `原始描述：${description || '无'}`,
    '',
    'SKILL.md：',
    source,
  ].join('\n');

  try {
    const { z } = require('zod');
    const shape = z.object({ display_name: z.string().min(1).max(80), short_description: z.string().min(1).max(240) }).strict();
    const runtime = activeRelayProviderRuntime({ tier: 'haiku', fallback: true });
    const data = await claudeSdk.runStructured({ prompt, cwd: os.homedir(), model: runtime.modelId,
      runtimeEnv: getSdkRuntimeStorage().apply(runtime.env), schema: z.toJSONSchema(shape), validate: value => shape.safeParse(value),
      runtimePolicy: buildRuntimePolicy({ settings: readAppSettings(), memoryDir: MEMORY_DIR,
        environment: runtime.agentEnvironment || 'native', mapPath: toWslPath }),
      onUsage: record => recordRelayUsage(record, 'background'), timeoutMs: 30000 });
    const displayName = cleanSkillPresentationText(data.display_name, 40);
    const summary = cleanSkillPresentationText(data.short_description, 120);
    const hasChinese = (value) => /[\u3400-\u9fff]/.test(value);
    if (!displayName || !summary || !hasChinese(displayName) || !hasChinese(summary)) return null;
    return { displayName, summary };
  } catch (e) {
    console.warn('[skill-meta] 返回内容无法解析: %s', e.message);
    return null;
  }
}

function writeRelaySkillPresentation(skillDir, presentation) {
  const agentsDir = path.join(skillDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const target = path.join(agentsDir, 'relay.yaml');
  const temp = target + '.tmp';
  const body = [
    '# Generated by Relay. Used for display only; SKILL.md remains the source of truth.',
    'interface:',
    `  display_name: ${JSON.stringify(presentation.displayName)}`,
    `  short_description: ${JSON.stringify(presentation.summary)}`,
    '',
  ].join('\n');
  fs.writeFileSync(temp, body, 'utf8');
  try {
    fs.renameSync(temp, target);
  } catch (e) {
    // Windows 某些文件系统不允许 rename 覆盖已有文件；重复导入时安全替换。
    if (!fs.existsSync(target)) throw e;
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  }
}

async function generateRelaySkillPresentation(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  const fm = parseFrontmatter(raw) || {};
  const skillName = path.basename(skillDir);
  const callName = fm.name || skillName;
  const fallback = skillBodyPresentation(raw, skillName, fm.description || '');
  const packageMeta = parseSkillPresentationYaml(path.join(skillDir, 'agents', 'openai.yaml'));
  const generated = await generateSkillPresentationWithClaude(
    skillName,
    callName,
    fm.description || '',
    raw,
  );
  const presentation = {
    displayName: generated?.displayName
      || packageMeta.display_name
      || fallback.displayName
      || skillName,
    summary: generated?.summary
      || packageMeta.short_description
      || fallback.summary
      || fm.description
      || '',
  };
  await withSkillLibraryWrite(() => {
    // Generation can outlive an archive, edit or publication. Never recreate a
    // removed package or attach a summary generated from a different SKILL.md.
    if (!fs.existsSync(skillFile) || fs.readFileSync(skillFile, 'utf8') !== raw) {
      throw new Error('技能内容已变化，请重新生成显示信息');
    }
    writeRelaySkillPresentation(skillDir, presentation);
  });
  console.log('[skill-meta] relay.yaml 已生成: %s source=%s', skillName, generated ? 'llm' : 'fallback');
  return { ...presentation, generatedBy: generated ? 'llm' : 'fallback' };
}

async function generateImportedSkillPresentations(skillDirs) {
  let llmCount = 0;
  let fallbackCount = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < skillDirs.length) {
      const skillDir = skillDirs[cursor++];
      try {
        const knownOwner = skillMaintenanceOwnership(path.basename(skillDir));
        const result = await generateRelaySkillPresentation(skillDir);
        if (knownOwner?.verified) recordSkillActivity(path.basename(skillDir), 'patched', { updateOwnedHash: true });
        if (result.generatedBy === 'llm') llmCount++;
        else fallbackCount++;
      } catch (e) {
        fallbackCount++;
        console.warn('[skill-meta] relay.yaml 写入失败 %s: %s', path.basename(skillDir), e.message);
      }
    }
  };
  const concurrency = Math.min(2, skillDirs.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { llmCount, fallbackCount };
}

function listSkillNames() {
  try {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      // 排除 . 前缀目录(.archive 归档区、.usage.json 等 Curator 元数据),否则会被当成"技能"
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        let desc = '', raw = '', fm = {};
        const sk = path.join(SKILLS_DIR, e.name, 'SKILL.md');
        try {
          if (fs.existsSync(sk)) {
            raw = fs.readFileSync(sk, 'utf8').replace(/^﻿/, '');
            fm = parseFrontmatter(raw) || {};
            desc = fm.description || '';
          }
        } catch (_) {}
        const bodyMeta = skillBodyPresentation(raw, e.name, desc);
        const relayMeta = parseSkillPresentationYaml(path.join(SKILLS_DIR, e.name, 'agents', 'relay.yaml'));
        const openaiMeta = parseSkillPresentationYaml(path.join(SKILLS_DIR, e.name, 'agents', 'openai.yaml'));
        const uiMeta = { ...openaiMeta, ...relayMeta };
        return {
          name: e.name,                         // 本地目录键；设置页管理操作继续使用它
          callName: fm.name || e.name,           // Claude Code 实际调用 ID，绝不能本地化
          desc,
          displayName: uiMeta.display_name || fm.display_name || fm.displayName || bodyMeta.displayName || e.name,
          summary: uiMeta.short_description || fm.short_description || fm.summary || bodyMeta.summary || desc,
          defaultPrompt: uiMeta.default_prompt || fm.default_prompt || '',
        };
      });
  } catch (e) { console.warn('[skill] 列表读取失败: %s', e.message); return []; }
}
// 解压 zip 到临时目录(用 PowerShell Expand-Archive,Windows 自带)
function unzipToTemp(zipPath) {
  return new Promise((resolve, reject) => {
    const dest = path.join(os.tmpdir(), 'relay-import-' + Date.now());
    fs.mkdirSync(dest, { recursive: true });
    const q = (s) => String(s).replace(/'/g, "''");
    const cmd = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(dest)}' -Force`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => (code === 0 ? resolve(dest) : reject(new Error(err.trim() || ('Expand-Archive 退出码 ' + code)))));
    ps.on('error', reject);
  });
}
// 跳过 zip 常见的单层包裹目录 / __MACOSX
function findContentRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  return dir;
}
function findDirsWithFile(root, fileName, maxDepth) {
  const found = [];
  (function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === fileName.toLowerCase())) { found.push(d); return; }
    for (const e of entries) if (e.isDirectory() && e.name !== '__MACOSX') walk(path.join(d, e.name), depth + 1);
  })(root, 0);
  return found;
}

// ── MCP 服务器结构化管理(启停 / 删除)──
//   设计:.claude.json 的 mcpServers = 「启用」的服务器(claude.exe 只启动这里的条目);
//   「禁用但保留」的条目移到同文件的 sidecar 键 mcpServersDisabled(claude.exe 不认识该键、直接忽略)。
//   这样「关掉」是真关(条目离开 mcpServers,claude 不会再起它),且配置不丢、可一键移回。
//   —— 不用「entry 里加 disabled:true」是因为 claude.exe 是否honor该标记不确定,移走才 100% 可靠。
const MCP_DISABLED_KEY = 'mcpServersDisabled';
const MCP_CONTROL_TIMEOUT_MS = 12000;
let mcpPermissionsService = null;
let mcpPermissionRegistrySnapshot = null;
function allMcpPermissionServers() {
  const registry = readClaudeMcpRegistry();
  if (!registry.ok) throw new Error(registry.message);
  return { ...registry.enabled, ...registry.disabled };
}
function mcpPermissionTargets() {
  const targets = [], seen = new Set();
  const add = (child, source) => {
    if (!child || seen.has(child)) return;
    seen.add(child);
    targets.push({ ...source, originalChild: child, child: {
      syncMcpPermissionOverrides: typeof child.syncMcpPermissionOverrides === 'function'
        ? value => withMcpControlTimeout(child.syncMcpPermissionOverrides(value), '更新 MCP 审批') : undefined,
      toggleMcpServer: typeof child.toggleMcpServer === 'function'
        ? (name, enabled) => withMcpControlTimeout(child.toggleMcpServer(name, enabled), '停用已删除的 MCP') : undefined,
    } });
  };
  for (const sess of liveSessions.values()) if (!sess.dead) add(sess.child, { session: sess, runId: sess.jobId });
  for (const [runId, child] of jobs) add(child, { runId });
  return targets;
}
function getMcpPermissions() {
  if (!mcpPermissionsService) {
    mcpPermissionRegistrySnapshot = allMcpPermissionServers();
    mcpPermissionsService = createMcpPermissions({ readSettings: readAppSettings, writeSettings: writeAppSettings,
      readServers: allMcpPermissionServers, listSessions: mcpPermissionTargets,
      stopSession: async target => {
        const reason = 'MCP 审批方式已收紧，请重新发送后继续';
        if (target.session) await killLiveSession(target.session, reason);
        else {
          if (target.runId) interactionBroker.rejectTask(target.runId, { message: reason, interrupt: true });
          await target.originalChild.kill();
        }
      },
    });
  }
  return mcpPermissionsService;
}
async function reconcileMcpPermissions() {
  const service = getMcpPermissions(), next = allMcpPermissionServers(), previous = mcpPermissionRegistrySnapshot || {};
  const added = Object.keys(next).filter(name => !Object.hasOwn(previous, name));
  const removed = Object.keys(previous).filter(name => !Object.hasOwn(next, name));
  const renames = {};
  // An exact, unique unchanged configuration is a rename. Matching only a URL
  // or display label could confuse separate MCP identities and is not enough.
  const key = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const old of removed) {
    const matches = added.filter(name => key(next[name]) === key(previous[old]));
    if (matches.length === 1 && removed.filter(name => key(previous[name]) === key(previous[old])).length === 1) renames[old] = matches[0];
  }
  const result = await service.reconcileRegistry({ renames });
  mcpPermissionRegistrySnapshot = next;
  return result;
}

function readClaudeMcpRegistry() {
  const file = claudeJsonPath();
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (e) { return { ok: false, message: '.claude.json 解析失败：' + e.message, file, cfg: {} }; }
  }
  return {
    ok: true,
    file,
    cfg,
    enabled: cfg.mcpServers || {},
    disabled: cfg[MCP_DISABLED_KEY] || {},
  };
}

function mcpControlSession(convId) {
  if (!convId) return null;
  const sess = liveSessions.get(convId);
  if (!sess || sess.dead || !sess.child) return null;
  return sess;
}

function withMcpControlTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), MCP_CONTROL_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// SDK 状态里可能带 MCP config（其中 env 可能含密钥）。renderer 只需要展示状态，
// 所以严格挑选公开字段，绝不把 config 原样跨 IPC 发出去。
function publicMcpStatus(item) {
  return {
    name: String((item && item.name) || ''),
    status: String((item && item.status) || 'failed'),
    error: item && item.error ? String(item.error) : '',
    scope: item && item.scope ? String(item.scope) : '',
    toolCount: item && Array.isArray(item.tools) ? item.tools.length : 0,
    serverInfo: item && item.serverInfo
      ? { name: String(item.serverInfo.name || ''), version: String(item.serverInfo.version || '') }
      : null,
  };
}

async function syncMcpConfigToLiveSession(sess) {
  const registry = readClaudeMcpRegistry();
  if (!registry.ok) return registry;
  const permissions = await reconcileMcpPermissions();
  if (!permissions.ok && sess.dead) return { ok: false, message: '审批设置已保存，请重新发送后继续' };
  const result = await withMcpControlTimeout(
    sess.child.setMcpServers(registry.enabled),
    '同步 MCP 配置',
  );
  return { ok: true, result };
}

// 安全读改写 .claude.json:BOM 剥离 + 解析失败拒写(绝不冲掉会话/onboarding 等其他键)+ 原子写。
function mutateClaudeJson(fn) {
  const f = claudeJsonPath();
  let cfg = {};
  if (fs.existsSync(f)) {
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
    catch (e) { return { ok: false, message: '.claude.json 解析失败，已取消操作以防数据丢失：' + e.message }; }
  }
  const ret = fn(cfg);   // fn 直接改 cfg;可返回 {ok:false,...} 中止
  if (ret && ret.ok === false) return ret;
  const dir = path.dirname(f); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'));   // 无 BOM
  fs.renameSync(tmp, f);
  return { ok: true };
}
// 一行摘要(列表副信息):本地命令显示 command;远程显示 url;否则给个类型提示。
function mcpSummary(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'url' || c.url) return String(c.url || 'url');
  if (c.command) return [c.command, ...(Array.isArray(c.args) ? c.args : [])].join(' ').trim();
  return c.type ? String(c.type) : '';
}
// 列出全部 MCP 服务器:启用(mcpServers)+ 禁用(sidecar),各带 enabled 标记 + 摘要,按名称排序。
ipcMain.handle('mcp:list', () => {
  const registry = readClaudeMcpRegistry();
  if (!registry.ok) return registry;
  const on = registry.enabled;
  const off = registry.disabled;
  const items = [];
  const overrides = getMcpPermissions().overrides();
  for (const [name, c] of Object.entries(on))  items.push({ name, enabled: true,  summary: mcpSummary(c) });
  for (const [name, c] of Object.entries(off)) items.push({ name, enabled: false, summary: mcpSummary(c) });
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) item.permissionModeOverride = overrides[item.name] === 'default' ? 'default' : null;
  return { ok: true, items, path: registry.file };
});
ipcMain.handle('mcp:permission:set', async (event, input = {}) => {
  if (!permissionCaller(event)) return { ok: false, code: 'FORBIDDEN', message: '此窗口不能修改 MCP 审批' };
  try { return await getMcpPermissions().set(input); }
  catch (error) { return { ok: false, code: error.code || 'MCP_PERMISSION_UPDATE_FAILED', message: error.message || '审批设置未能保存' }; }
});

// 当前常驻 Query 的真实 MCP 状态。没有常驻会话不算错误：设置页仍可管理磁盘配置，
// 下一次对话启动时自然加载。
ipcMain.handle('mcp:status', async (_e, { convId } = {}) => {
  const sess = mcpControlSession(convId);
  if (!sess) return { ok: true, available: false, busy: false, items: [] };
  try {
    const statuses = await withMcpControlTimeout(sess.child.mcpServerStatus(), '读取 MCP 状态');
    return { ok: true, available: true, busy: !!sess.busy, items: (statuses || []).map(publicMcpStatus) };
  } catch (e) {
    return { ok: false, available: true, busy: !!sess.busy, message: e.message || '读取 MCP 状态失败' };
  }
});

ipcMain.handle('mcp:reconnect', async (_e, { convId, name } = {}) => {
  if (!name) return { ok: false, message: '缺少服务器名称' };
  const sess = mcpControlSession(convId);
  if (!sess) return { ok: false, unavailable: true, message: '当前对话尚未启动 Claude 会话' };
  if (sess.busy) return { ok: false, busy: true, message: '当前对话还在回复中，请结束后再重连' };
  try {
    await withMcpControlTimeout(sess.child.reconnectMcpServer(name), `重连 ${name}`);
    const statuses = await withMcpControlTimeout(sess.child.mcpServerStatus(), '刷新 MCP 状态');
    return { ok: true, items: (statuses || []).map(publicMcpStatus) };
  } catch (e) {
    return { ok: false, message: e.message || `重连「${name}」失败` };
  }
});

// 将磁盘里当前启用的配置作为 SDK 动态 MCP 同步到本会话。用于用户在 Relay 外部
// 修改 .claude.json 后即时发现新增服务；SDK 包装层会自动保留 relay-cron 等内置服务。
ipcMain.handle('mcp:sync', async (_e, { convId } = {}) => {
  const sess = mcpControlSession(convId);
  if (!sess) return { ok: false, unavailable: true, message: '当前对话尚未启动 Claude 会话' };
  if (sess.busy) return { ok: false, busy: true, message: '当前对话还在回复中，请结束后再同步' };
  try {
    const synced = await syncMcpConfigToLiveSession(sess);
    if (!synced.ok) return synced;
    const statuses = await withMcpControlTimeout(sess.child.mcpServerStatus(), '刷新 MCP 状态');
    return { ok: true, result: synced.result, items: (statuses || []).map(publicMcpStatus) };
  } catch (e) {
    return { ok: false, message: e.message || '同步 MCP 配置失败' };
  }
});

// 启停:在 mcpServers ↔ mcpServersDisabled 之间搬运该条目。enabled=目标状态。
ipcMain.handle('mcp:toggle', async (_e, { name, enabled, convId } = {}) => {
  if (!name) return { ok: false, message: '缺少服务器名称' };
  const changed = mutateClaudeJson((cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg[MCP_DISABLED_KEY] = cfg[MCP_DISABLED_KEY] || {};
    const from = enabled ? cfg[MCP_DISABLED_KEY] : cfg.mcpServers;
    const to   = enabled ? cfg.mcpServers : cfg[MCP_DISABLED_KEY];
    if (!(name in from)) {
      // 已在目标状态:幂等放行(可能用户连点),不报错
      if (name in to) return;
      return { ok: false, message: `未找到服务器「${name}」` };
    }
    to[name] = from[name];
    delete from[name];
    if (Object.keys(cfg[MCP_DISABLED_KEY]).length === 0) delete cfg[MCP_DISABLED_KEY];   // 空了就别留垃圾键
  });
  if (!changed.ok) return changed;
  const sess = mcpControlSession(convId);
  if (!sess) return { ok: true, liveApplied: false };
  if (sess.busy) return { ok: true, liveApplied: false, deferred: true, message: '配置已保存，将在下次发送前同步' };
  try {
    // 先同步集合让“此前未加载的禁用服务”进入当前 Query，再切换状态；停用时
    // toggle 会立即断开 settings-owned 实例，随后 setMcpServers 清理动态副本。
    if (enabled) {
      const synced = await syncMcpConfigToLiveSession(sess);
      if (!synced.ok) throw new Error(synced.message || '同步 MCP 配置失败');
    }
    let toggleError = null;
    try {
      await withMcpControlTimeout(sess.child.toggleMcpServer(name, !!enabled), `${enabled ? '启用' : '停用'} ${name}`);
    } catch (e) {
      toggleError = e;
      // 停用一个本轮尚未发现的服务可能返回 unknown；仍继续同步动态集合，确保
      // Relay 通过 setMcpServers 加入的同名实例被移除。
      if (enabled) throw e;
    }
    if (!enabled) {
      const synced = await syncMcpConfigToLiveSession(sess);
      if (!synced.ok) throw new Error(synced.message || '同步 MCP 配置失败');
    }
    if (enabled && typeof sess.child.mcpServerStatus === 'function') {
      const statuses = await withMcpControlTimeout(sess.child.mcpServerStatus(), '核验 MCP 启用状态');
      const status = statuses?.find(item => item.name === name);
      if (!status || status.status !== 'connected') return { ok: true, liveApplied: false, message: '启用配置已保存，但 SDK 尚未连接该服务。请查看服务状态与常规设置中的配置来源；管理策略的拒绝优先于启用选择。', items: (statuses || []).map(publicMcpStatus) };
    }
    return { ok: true, liveApplied: !toggleError, message: toggleError ? '已保存停用配置；当前会话未发现该服务' : '' };
  } catch (e) {
    console.warn('[mcp] 配置已保存但当前会话即时启停失败 name=%s: %s', name, e.message);
    return { ok: true, liveApplied: false, deferred: true, message: '配置已保存，当前会话同步失败；可尝试“同步配置”' };
  }
});
// 删除:从启用或禁用任一处移除该条目(彻底删,不可恢复)。
ipcMain.handle('mcp:delete', async (_e, { name, convId } = {}) => {
  if (!name) return { ok: false, message: '缺少服务器名称' };
  const changed = mutateClaudeJson((cfg) => {
    let hit = false;
    if (cfg.mcpServers && name in cfg.mcpServers) { delete cfg.mcpServers[name]; hit = true; }
    if (cfg[MCP_DISABLED_KEY] && name in cfg[MCP_DISABLED_KEY]) { delete cfg[MCP_DISABLED_KEY][name]; hit = true; }
    if (cfg[MCP_DISABLED_KEY] && Object.keys(cfg[MCP_DISABLED_KEY]).length === 0) delete cfg[MCP_DISABLED_KEY];
    if (!hit) return { ok: false, message: `未找到服务器「${name}」` };
  });
  if (!changed.ok) return changed;
  try { await reconcileMcpPermissions(); }
  catch (_) { return { ok: true, liveApplied: false, deferred: true, message: '配置已删除，审批状态将在下次同步时更新' }; }
  const sess = mcpControlSession(convId);
  if (!sess || sess.busy) return { ok: true, liveApplied: false, deferred: !!(sess && sess.busy) };
  try {
    let toggleError = null;
    try { await withMcpControlTimeout(sess.child.toggleMcpServer(name, false), `停用 ${name}`); }
    catch (e) { toggleError = e; }
    const synced = await syncMcpConfigToLiveSession(sess);
    if (!synced.ok) throw new Error(synced.message || '同步 MCP 配置失败');
    return {
      ok: true,
      liveApplied: !toggleError,
      message: toggleError ? '配置已删除；当前会话未发现该服务' : '',
    };
  } catch (e) {
    console.warn('[mcp] 已删除配置但当前会话清理失败 name=%s: %s', name, e.message);
    return { ok: true, liveApplied: false, deferred: true, message: '配置已删除，当前会话仍可能保留旧工具；可使用“重建会话”兜底' };
  }
});

ipcMain.handle('data:listAgents', () => ({ ok: true, items: listAgentNames(), dir: AGENTS_DIR }));
ipcMain.handle('data:listSkills', () => ({ ok: true, items: listSkillNames(), dir: SKILLS_DIR }));

// Agent / 技能条目的详情、编辑与本地定位。所有路径都从受控目录和单个 basename
// 重新构造，renderer 不能传入任意绝对路径或跳出 ~/.claude。
function managedDataItem(kind, key) {
  const raw = String(key || '');
  const base = path.basename(raw);
  if (!base || base !== raw || base === '.' || base === '..') return null;
  if (kind === 'agent') {
    if (!base.toLowerCase().endsWith('.md')) return null;
    return { file: path.join(AGENTS_DIR, base), reveal: path.join(AGENTS_DIR, base) };
  }
  if (kind === 'skill') {
    const dir = path.join(SKILLS_DIR, base);
    return { file: path.join(dir, 'SKILL.md'), reveal: dir };
  }
  if (kind === 'archivedSkill') {
    const dir = path.join(SKILLS_DIR, '.archive', base);
    return { file: path.join(dir, 'SKILL.md'), reveal: dir };
  }
  return null;
}

ipcMain.handle('data:readItem', (_e, { kind, key } = {}) => {
  try {
    const item = managedDataItem(kind, key);
    if (!item) return { ok: false, message: '非法条目' };
    if (!fs.existsSync(item.file)) return { ok: false, message: '文件不存在' };
    const content = fs.readFileSync(item.file, 'utf8').replace(/^﻿/, '');
    if (kind === 'skill') recordSkillActivity(path.basename(String(key || '')), 'viewed');
    return {
      ok: true,
      file: path.basename(item.file),
      content,
    };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:writeItem', async (_e, { kind, key, content } = {}) => {
  try {
    const write = () => {
      if (kind === 'archivedSkill') return { ok: false, message: '归档技能仅支持查看' };
      const item = managedDataItem(kind, key);
      if (!item) return { ok: false, message: '非法条目' };
      if (!fs.existsSync(item.file)) return { ok: false, message: '文件不存在' };
      const knownSkillOwner = kind === 'skill' ? skillMaintenanceOwnership(path.basename(String(key || ''))) : null;
      const tmp = item.file + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(String(content == null ? '' : content), 'utf8'));
      fs.renameSync(tmp, item.file);
      if (kind === 'skill') recordSkillActivity(path.basename(String(key || '')), 'edited', { updateOwnedHash: knownSkillOwner?.verified === true });
      // 技能 Markdown 的描述变化不影响 transcript 派生的历史用量，无需让用量索引失效。
      return { ok: true };
    };
    return kind === 'skill' ? await withSkillLibraryWrite(write) : write();
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:revealItem', async (_e, { kind, key } = {}) => {
  try {
    const item = managedDataItem(kind, key);
    if (!item) return { ok: false, message: '非法条目' };
    if (!fs.existsSync(item.reveal)) return { ok: false, message: '路径不存在' };
    if (kind === 'skill' || kind === 'archivedSkill') {
      const message = await shell.openPath(item.reveal);
      return message ? { ok: false, message } : { ok: true };
    }
    shell.showItemInFolder(item.reveal);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:removeAgent', (_e, { file }) => {
  try {
    const p = path.join(AGENTS_DIR, path.basename(String(file || '')));
    // 删 .md 之前先读出 agentName(frontmatter.name),用于清理项目级安装的资源映射
    let agentName = '';
    try { if (fs.existsSync(p)) agentName = (parseFrontmatter(fs.readFileSync(p, 'utf8')).name || '').trim(); } catch (_) {}
    if (!agentName) agentName = path.basename(String(file || '')).replace(/\.md$/i, '');
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    // 同时清掉它的自定义名映射 + 项目级安装(铺开的整包项目根 + agentProjects 映射)
    const a = readAppSettings();
    let dirty = false;
    if (a.agentNames && a.agentNames[file]) { delete a.agentNames[file]; dirty = true; }
    if (a.agentProjects && a.agentProjects[agentName]) {
      const projRoot = a.agentProjects[agentName];
      // 安全护栏:只删 ~/.claude/relay-agents/ 下的目录,绝不误删用户别处的目录
      const projBase = path.join(os.homedir(), '.claude', 'relay-agents');
      try {
        if (projRoot && projRoot.startsWith(projBase) && fs.existsSync(projRoot)) {
          fs.rmSync(projRoot, { recursive: true, force: true });
        }
      } catch (_) {}
      delete a.agentProjects[agentName]; dirty = true;
    }
    if (dirty) writeAppSettings(a);
    return { ok: true, items: listAgentNames() };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 给某个 Agent 设置/清除用户自定义显示名(只存映射,不改 .md 本体)
ipcMain.handle('data:renameAgent', (_e, { file, displayName }) => {
  try {
    const f = path.basename(String(file || ''));
    const a = readAppSettings();
    if (!a.agentNames) a.agentNames = {};
    const dn = String(displayName || '').trim();
    if (dn) a.agentNames[f] = dn.slice(0, 40);
    else delete a.agentNames[f];   // 清空 = 恢复默认名
    writeAppSettings(a);
    return { ok: true, items: listAgentNames() };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('data:removeSkill', async (_e, { name }) => {
  try {
    return await withSkillLibraryWrite(() => {
      const p = path.join(SKILLS_DIR, path.basename(String(name || '')));
      getSkillMaintenanceHost().forget(path.basename(String(name || '')));
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      return { ok: true, items: listSkillNames() };
    });
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator:技能生命周期(遥测 + 状态 + 手动归档/恢复/置顶)
//   遥测(用量/最近使用)从 transcript 现算;状态(stale/archived/pinned/firstSeen)存 sidecar。
//   列表仅标记；可选后台归档由独立宿主检查可信归属、空闲和引用，并验证整包备份。
// ─────────────────────────────────────────
const SKILL_USAGE_FILE = () => path.join(SKILLS_DIR, '.usage.json');
const SKILL_ARCHIVE_DIR = () => path.join(SKILLS_DIR, '.archive');
const STALE_DAYS_DEFAULT = 30;
let skillMaintenanceHost = null;
let skillMaintenanceTickPromise = null;
let skillMaintenanceLastBusyAt = Date.now();
const pendingSkillActivity = new Map();
function getSkillMaintenanceHost() {
  return skillMaintenanceHost ||= new SkillMaintenanceHost({
    skillsDir: SKILLS_DIR,
    stateDir: path.join(app.getPath('userData'), 'skill-maintenance'),
    schedulesFile: path.join(app.getPath('userData'), 'schedules.json'),
    draftsDir: path.join(app.getPath('userData'), 'skill-drafts', 'drafts'),
  });
}
function skillMaintenanceOwnership(name) {
  try { return getSkillMaintenanceHost().ownership(name); } catch (_) { return null; }
}
function recordSkillActivity(name, type, options) {
  const key = `${name}:${type}`;
  try { getSkillMaintenanceHost().recordActivity(name, type, options); pendingSkillActivity.delete(key); }
  catch (_) {
    pendingSkillActivity.set(key, { name, type, options: { ...options, updateOwnedHash: false } });
    console.warn('[skill-maintenance] 技能活动记录待重试，期间暂停自动归档');
  }
}
function skillMaintenanceRuntimeSnapshot() {
  try {
    if (!taskLedger || typeof powerMonitor.getSystemIdleTime !== 'function') return { busy: true, lastActivityAt: null };
    const now = Date.now(), systemIdle = powerMonitor.getSystemIdleTime();
    if (!Number.isFinite(systemIdle) || systemIdle < 0) return { busy: true, lastActivityAt: null };
    const runs = taskLedger.list(), scheduled = scheduler.list();
    const busy = jobs.size > 0 || reviewInflight || pendingSkillReviews.length > 0 || pendingSkillActivity.size > 0
      || !!skillMetadataBackfillPromise || !!_skillUsageRefreshPromise
      || [...liveSessions.values()].some(session => !session.dead && (session.busy || session.keepAliveForAsyncAgents))
      || runs.some(run => !isTerminalState(run.state)) || scheduled.some(task => task.running);
    if (busy) skillMaintenanceLastBusyAt = now;
    const activity = [now - systemIdle * 1000, skillMaintenanceLastBusyAt,
      ...[...liveSessions.values()].map(session => Number(session.lastUsedAt) || 0),
      ...runs.map(run => Date.parse(run.updatedAt || run.endedAt || run.createdAt || '')).filter(Number.isFinite)];
    return { busy, lastActivityAt: new Date(activity.reduce((latest, value) => Math.max(latest, value), 0)).toISOString() };
  } catch (_) { return { busy: true, lastActivityAt: null }; }
}
async function synchronizeSkillArchives(archived) {
  if (!archived?.length) return;
  const sidecar = readSkillUsage();
  for (const entry of archived) sidecar[entry.name] = { ...sidecar[entry.name], state: 'archived', archivedAt: entry.archivedAt, backupId: entry.backupId };
  writeSkillUsage(sidecar);
  notifySkillUsageUpdated({ reason: 'automatic-archive', count: archived.length });
  await reloadSkillsInLiveSessions('automatic-skill-archive');
}
function tickSkillMaintenance() {
  if (skillMaintenanceTickPromise || isQuitting || !getReviewConfig().autoArchive) return;
  skillMaintenanceTickPromise = (async () => {
    for (const activity of [...pendingSkillActivity.values()]) recordSkillActivity(activity.name, activity.type, activity.options);
    const host = getSkillMaintenanceHost(), policy = normalizeMaintenancePolicy(readAppSettings());
    const runtime = skillMaintenanceRuntimeSnapshot();
    const gate = evaluateMaintenanceRun({ ...runtime, now: Date.now(), lastRunAt: host.readState().lastRunAt, policy });
    if (!gate.run) { host.run({ ...runtime, policy, usageReady: false }); return; }
    const refreshed = await refreshSkillUsageInBackground({ force: true });
    if (refreshed?.ok !== true || refreshed.complete !== true || isQuitting) return;
    // The user may have resumed work or disabled archival while the worker ran.
    const currentPolicy = normalizeMaintenancePolicy(readAppSettings());
    if (!currentPolicy.autoArchive) return;
    const usage = loadSkillUsageState();
    const result = await withSkillLibraryWrite(() => host.run({ ...skillMaintenanceRuntimeSnapshot(),
      policy: normalizeMaintenancePolicy(readAppSettings()), usage: usage.map, usageReady: usage.ready }));
    await synchronizeSkillArchives(result.archived);
  })().catch(async error => {
    await synchronizeSkillArchives(error.archived || []);
    console.warn('[skill-maintenance] 本轮检查停止，未处理的技能保持原样 code=%s', error.code || 'IO_ERROR');
  }).finally(() => { skillMaintenanceTickPromise = null; });
}
// No extra model task: this quiet timer only runs deterministic maintenance.
if (HAS_SINGLE_INSTANCE_LOCK) app.whenReady().then(() => {
  const start = setTimeout(tickSkillMaintenance, 30000);
  const timer = setInterval(tickSkillMaintenance, 60000);
  start.unref?.(); timer.unref?.();
  app.once('will-quit', () => { clearTimeout(start); clearInterval(timer); });
});

function readSkillUsage() {
  try {
    const f = SKILL_USAGE_FILE();
    if (!fs.existsSync(f)) return {};
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { console.warn('[curator] skill-usage 读取失败: %s', e.message); return {}; }
}
function writeSkillUsage(data) {
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const f = SKILL_USAGE_FILE();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    fs.renameSync(tmp, f);
  } catch (e) { console.error('[curator] sidecar 写入失败:', e.message); }
}
function getStaleDays() {
  const v = parseInt(readAppSettings().skillStaleDays, 10);
  return Number.isFinite(v) && v >= 1 ? v : STALE_DAYS_DEFAULT;
}

// 已安装(非归档)技能名集合
function installedSkillSet() {
  return new Set(listSkillNames().map((s) => s.name));
}
// 归档区技能名列表
function listArchivedSkillNames() {
  try {
    return fs.readdirSync(SKILL_ARCHIVE_DIR(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (e) { console.warn('[curator] 归档区读取失败: %s', e.message); return []; }
}

// 确定性状态机:对每个已安装技能,按 anchor(最近使用‖首见)判 active/stale。绝不自动归档。
//   返回 { sidecar(已更新), usage(派生用量 Map) }。会落盘 sidecar(补 firstSeen / 改 state)。
function applySkillTransitions(
  now = Date.now(),
  usage = new Map(),
  usageReady = false,
  installed = installedSkillSet(),
  archived = new Set(listArchivedSkillNames()),
) {
  const sidecar = readSkillUsage();
  const staleMs = getStaleDays() * 24 * 60 * 60 * 1000;
  const nowIso = new Date(now).toISOString();
  let dirty = false;
  const callNames = new Map(listSkillNames().map(skill => [skill.name, skill.callName || skill.name]));
  let maintenanceRecords = null;
  try { maintenanceRecords = getSkillMaintenanceHost().readState().records; } catch (_) {}

  for (const name of installed) {
    let rec = sidecar[name];
    if (!rec || typeof rec !== 'object') {
      // 首次见到 → 锚定 firstSeen=now,本轮按 active,不立刻判 stale(防新导入的被误标)
      rec = { state: 'active', pinned: false, firstSeenAt: nowIso, archivedAt: null };
      sidecar[name] = rec; dirty = true;
      continue;
    }
    if (!usageReady) continue;                // 首次增量索引未完成前，不用“0 次”误判旧技能为闲置
    if (rec.pinned) continue;                 // 置顶:跳过一切自动转换
    if (rec.state === 'archived') continue;   // 归档态由 restore 显式改回

    const callName = callNames.get(name) || name;
    const u = usage.get(callName) || usage.get(name);
    if (!maintenanceRecords) continue;
    const recorded = maintenanceRecords[name]?.activity || {};
    const anchors = [u?.lastUsedAt, rec.firstSeenAt, rec.lastViewedAt, rec.lastEditedAt, rec.lastPatchedAt, rec.restoredAt,
      recorded.lastViewedAt, recorded.lastEditedAt, recorded.lastPatchedAt, recorded.restoredAt].filter(Boolean).map(Date.parse);
    const anchorMs = anchors.length && anchors.every(Number.isFinite) ? Math.max(...anchors) : NaN;
    const idle = Number.isFinite(anchorMs) ? (now - anchorMs) : 0;

    if (idle >= staleMs && rec.state !== 'stale') { rec.state = 'stale'; dirty = true; }
    else if (idle < staleMs && rec.state === 'stale') { rec.state = 'active'; dirty = true; }
  }

  // 清理 sidecar 里既不在已安装、也不在归档区的孤儿条目(技能被彻底删除后)
  for (const name of Object.keys(sidecar)) {
    if (!installed.has(name) && !archived.has(name)) { delete sidecar[name]; dirty = true; }
  }

  if (dirty) writeSkillUsage(sidecar);
  return { sidecar, usage };
}

// 技能总览:跑一次状态机,返回每个已安装技能的用量+状态 + 归档列表 + 当前阈值
ipcMain.handle('skills:overview', (_e, { refresh = true } = {}) => {
  try {
    const now = Date.now();
    const usageState = loadSkillUsageState();
    const usage = usageState.map;
    const skillList = listSkillNames();
    const archivedNames = listArchivedSkillNames();
    const { sidecar } = applySkillTransitions(
      now,
      usage,
      usageState.ready,
      new Set(skillList.map((skill) => skill.name)),
      new Set(archivedNames),
    );
    const items = skillList.map((s) => {
      const rec = sidecar[s.name] || {};
      const u = usage.get(s.callName || s.name) || usage.get(s.name) || { useCount: 0, lastUsedAt: null };
      return {
        name: s.name,
        callName: s.callName || s.name,
        desc: s.desc || '',
        displayName: s.displayName || s.name,
        summary: s.summary || s.desc || '',
        defaultPrompt: s.defaultPrompt || '',
        useCount: u.useCount || 0,
        lastUsedAt: u.lastUsedAt || null,
        feedbackOpportunities: u.feedbackOpportunities || 0,
        correctionCount: u.correctionCount || 0,
        retryCount: u.retryCount || 0,
        toolErrorCount: u.toolErrorCount || 0,
        positiveCount: u.positiveCount || 0,
        lastNegativeAt: u.lastNegativeAt || null,
        state: rec.state || 'active',
        pinned: !!rec.pinned,
        createdBy: rec.createdBy || null,   // 'agent'=对话自动提炼生成;null=用户手动导入
      };
    });
    // 归档区直接复用同一份持久化聚合结果，不再触发第二次 transcript 扫描。
    const archived = archivedNames.map((name) => {
      const rec = sidecar[name] || {};
      const u = usage.get(name) || { useCount: 0, lastUsedAt: null };
      return { name, useCount: u.useCount || 0, lastUsedAt: u.lastUsedAt || null, archivedAt: rec.archivedAt || null };
    });
    if (refresh) refreshSkillUsageInBackground();
    return {
      ok: true,
      items,
      archived,
      staleDays: getStaleDays(),
      dir: SKILLS_DIR,
      usageReady: usageState.ready,
      usageRefreshing: !!_skillUsageRefreshPromise,
    };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 历史技能迁移：只补没有 agents/relay.yaml 的已安装 Skill。
// 由技能设置页打开后在后台触发，不放进 Relay 启动链路；同一时刻只跑一批，
// 页面反复进入也会复用同一个 Promise，不重复消耗模型。
let skillMetadataBackfillPromise = null;
ipcMain.handle('skills:backfillMetadata', async () => {
  if (skillMetadataBackfillPromise) return skillMetadataBackfillPromise;
  const pending = [];
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillDir = path.join(SKILLS_DIR, entry.name);
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
      if (fs.existsSync(path.join(skillDir, 'agents', 'relay.yaml'))) continue;
      pending.push(skillDir);
    }
  } catch (e) {
    return { ok: false, message: e.message, total: 0 };
  }
  if (!pending.length) return { ok: true, total: 0, llmCount: 0, fallbackCount: 0 };
  skillMetadataBackfillPromise = (async () => {
    const result = await generateImportedSkillPresentations(pending);
    return { ok: true, total: pending.length, ...result };
  })();
  try {
    return await skillMetadataBackfillPromise;
  } finally {
    skillMetadataBackfillPromise = null;
  }
});

// 置顶/取消置顶(只改 sidecar)
ipcMain.handle('skills:pin', (_e, { name, pinned } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n) return { ok: false, message: '技能名为空' };
    const sidecar = readSkillUsage();
    const rec = sidecar[n] || { state: 'active', pinned: false, firstSeenAt: new Date().toISOString(), archivedAt: null };
    rec.pinned = !!pinned;
    sidecar[n] = rec;
    writeSkillUsage(sidecar);
    return { ok: true, pinned: rec.pinned };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 归档:把技能目录移到 .archive/(移动而非删除,可恢复)
ipcMain.handle('skills:archive', async (_e, { name } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
    await withSkillLibraryWrite(() => {
      const archived = getSkillMaintenanceHost().archive(n);
      const sidecar = readSkillUsage();
      const rec = sidecar[n] || { firstSeenAt: new Date().toISOString(), pinned: false };
      rec.state = 'archived'; rec.archivedAt = archived.archivedAt; rec.backupId = archived.backupId;
      sidecar[n] = rec;
      writeSkillUsage(sidecar);
    });
    return { ok: true, liveReload: await reloadSkillsInLiveSessions('skill-archived') };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 恢复:从 .archive/ 移回;同名已存在则拒绝(不覆盖用户现有技能)
ipcMain.handle('skills:restore', async (_e, { name } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
    await withSkillLibraryWrite(() => {
      const restored = getSkillMaintenanceHost().restore(n);
      const sidecar = readSkillUsage();
      const rec = sidecar[n] || { firstSeenAt: new Date().toISOString(), pinned: false };
      rec.state = 'active'; rec.archivedAt = null; rec.restoredAt = restored.restoredAt;
      sidecar[n] = rec;
      writeSkillUsage(sidecar);
    });
    return { ok: true, liveReload: await reloadSkillsInLiveSessions('skill-restored') };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 永久删除归档技能：只允许删除 .archive 下的直接子目录，并同步清理生命周期 sidecar。
ipcMain.handle('skills:deleteArchived', async (_e, { name } = {}) => {
  try {
    return await withSkillLibraryWrite(() => {
      const n = path.basename(String(name || ''));
      if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
      const archivedRoot = path.resolve(SKILL_ARCHIVE_DIR());
      const target = path.resolve(archivedRoot, n);
      const relative = path.relative(archivedRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, message: '非法归档路径' };
      }
      if (!fs.existsSync(target)) return { ok: false, message: '归档中无此技能' };
      getSkillMaintenanceHost().forget(n);
      fs.rmSync(target, { recursive: true, force: true });
      const sidecar = readSkillUsage();
      if (sidecar[n]) {
        delete sidecar[n];
        writeSkillUsage(sidecar);
      }
      return { ok: true };
    });
  } catch (e) { return { ok: false, message: e.message }; }
});

// 设置"闲置"阈值天数(存 app-settings)
ipcMain.handle('skills:setStaleDays', (_e, { days } = {}) => {
  try {
    const v = parseInt(days, 10);
    if (!Number.isFinite(v) || v < 1) return { ok: false, message: '天数非法' };
    const a = readAppSettings();
    a.skillStaleDays = Math.min(v, 3650);
    writeAppSettings(a);
    return { ok: true, staleDays: a.skillStaleDays };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator 二期:技能候选草稿
//   用户纠正/重试/连续工具失败等强信号命中时立即触发；每 N 轮仅作兜底。后台模型只在
//   隔离的候选工作区回看并编辑技能包，完成后生成可验证、可查看差异的草稿。
//   任何候选都不会直接覆盖 ~/.claude/skills；只有用户在技能中心显式发布后才进入正式库。
//   prompt 改写自 Hermes agent/background_review.py 的 _SKILL_REVIEW_PROMPT。
// ─────────────────────────────────────────
const REVIEW_DEFAULT_EVERY = 6;

// 中文版技能 review 指令(要点照搬 Hermes:积极但别造碎技能、优先 patch 已有/伞技能、类级命名、
//   不要把环境性失败固化成约束、没值得学的就停)。对话正文由调用方拼在末尾。
const SKILL_REVIEW_PROMPT_HEAD = [
  '你现在作为后台「技能策展」在运行:回看下面这段刚结束的对话,判断有没有值得沉淀进技能库的经验,有就更新技能库。',
  '',
  '候选技能工作区(已授权你读写,绝对路径):' + SKILLS_DIR + '。这是隔离副本，不是正式技能库。每个技能是一个子目录,内含 SKILL.md(带 YAML frontmatter:name/description,description 一句话、说清这个技能"做什么、什么时候用")。',
  '',
  '要积极,但只在真有料时动手。命中下面任一信号就该更新:',
  '· 用户纠正了你的风格/语气/格式/啰嗦程度(如「别这么啰嗦」「别这样排版」「直接给答案」「你总是…我不喜欢」)——把这条偏好写进相关技能,让下次开局就照做。',
  '· 用户纠正了你的工作流/步骤/顺序——把纠正作为一条 pitfall 或明确步骤写进管这类任务的技能。',
  '· 冒出了一个非平凡的技巧/修复/绕过办法/调试路径/工具用法,以后同类任务用得上——固化它。',
  '· 这次用到的某个技能被发现是错的/缺步骤/过时了——立刻 patch 它。',
  '',
  '动作优先级(选最靠前、能套上的那个):',
  '1. 优先改本次已经调用或阅读的相关技能：先在本次回看中重新 Read 它的 SKILL.md，再把可复用经验加入候选副本。已保护技能跳过；没有已用技能覆盖时，再选现有类级技能。不要把一次失败写成长期禁令。',
  '2. 新建一个「类级」技能:没有现成技能覆盖这一类任务时才新建。名字必须是类级的,不能是某次任务的专名(不要带具体报错串、某个功能代号、「修复X」「调试Y」「今天的Z」这种一次性命名)。如果想出来的名字只有今天这次任务才说得通,那就是错的——退回去走 1。',
  '',
  '坚决不要固化的东西(否则会变成日后反咬自己的死规矩):',
  '· 环境性失败:缺二进制、全新安装的报错、迁移后路径不对、command not found、凭证没配、包没装。这些用户能修,不是长期规律。',
  '· 关于工具/能力的负面断言(「浏览器工具用不了」「X 工具是坏的」)——这种会硬化成几个月后模型拿来拒绝自己的借口,哪怕那时问题早修好了。如果是 setup 状态导致的失败,要固化就固化「修复办法」(装什么、配什么),绝不固化「这工具不能用」。',
  '· 只在本次会话里有意义的一次性叙事(「总结今天的行情」「分析这个 PR」不是一类值得建技能的工作)。',
  '',
  '硬规则:',
  '· 用 Write/Edit/Read 工具只在上面的候选工作区建/改文件。新建技能就建 <技能名>/SKILL.md；完成后 Relay 会生成待审核草稿，未经用户发布不会影响正式技能。',
  '· patch 已有技能前必须先 Read 它的 SKILL.md；自动提炼只允许修改 SKILL.md,不要改 scripts/references/assets 等配套文件。',
  '· 绝对不要读取或修改技能目录下任何 . 开头的目录或文件,尤其是 .history/.archive/.usage.json。',
  '· 一次最多动 1~2 个技能,不要刷一堆。',
  '· description 要精炼准确(它会被用来检索这个技能)。',
  '· 如果这次对话平顺、没有纠正、也没冒出新技巧——就直接回一句「无需更新」然后停下,不要硬凑。',
  '',
].join('\n');

let reviewInflight = false;   // 并发护栏:同时只允许一个 review 在跑
const pendingSkillReviews = []; // 忙时排队；不能因上一轮 review 尚未结束就吞掉新的纠正信号
const MAX_PENDING_SKILL_REVIEWS = 6;

function buildSkillReviewPrompt(conversationText, triggerReason = '', targetDir = SKILLS_DIR) {
  let listText = '(技能库为空,如确有可复用经验可新建类级技能。)';
  try {
    const sidecar = readSkillUsage();
    const skills = listSkillNames();
    if (skills.length) {
      listText = skills.map((skill) => {
        const usage = sidecar[skill.name] || {};
        const tags = [usage.pinned ? 'PINNED' : '', usage.createdBy === 'agent' ? '自动生成' : '']
          .filter(Boolean).join(' / ');
        const desc = String(skill.desc || skill.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return `· ${skill.name}${skill.callName && skill.callName !== skill.name ? ` (调用 ID: ${skill.callName})` : ''}${tags ? ` [${tags}]` : ''}\n    ${desc || '(无 description)'}\n    文件: ${path.join(targetDir, skill.name, 'SKILL.md')}`;
      }).join('\n');
    }
  } catch (e) {
    console.warn('[skill-review] 读取现有技能清单失败: %s', e.message);
    listText = '(清单读取失败；先用 Glob 查看技能目录,确认没有现有技能可 patch 后才能新建。)';
  }
  return [
    SKILL_REVIEW_PROMPT_HEAD.replaceAll(SKILLS_DIR, targetDir),
    '',
    `触发原因:${triggerReason || '定期兜底检查'}`,
    '',
    '当前已安装技能清单(优先从这里选择候选并 patch,不要创建同义重复技能):',
    listText,
    '',
    '下面是这次对话及紧凑工具轨迹:',
    '',
    String(conversationText || '').trim(),
  ].join('\n');
}

function stagingPathAllowed(root, candidate) {
  try {
    const rootPath = fs.realpathSync(root);
    const target = path.resolve(root, String(candidate || '.'));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRelative = path.relative(rootPath, realExisting);
    return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
  } catch (_) { return false; }
}

function stagingGlobAllowed(candidate) {
  if (candidate == null || candidate === '') return true;
  if (typeof candidate !== 'string' || candidate.includes('\0')) return false;
  const normalized = candidate.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

// 后台技能模型面对的是不受信任的对话/技能文本。它只能使用文件型工具，并且每个路径都
// 在主进程再次收口到隔离工作区；即使文本里出现提示注入，也无法借 review 修改其它目录。
function createStagingToolGuard(stagingRoot) {
  const rulesByTool = {
    Read: { paths: ['file_path'] },
    Write: { paths: ['file_path'] },
    Edit: { paths: ['file_path'] },
    Glob: { paths: ['path'], globs: ['pattern'] },
    Grep: { paths: ['path'], globs: ['glob'] },
  };
  return async (toolName, input, sdkOptions = {}) => {
    const rules = rulesByTool[toolName];
    const value = input && typeof input === 'object' ? input : {};
    const allowed = !!rules
      && rules.paths.every((field) => {
        const supplied = value[field];
        return (supplied == null || supplied === '' || typeof supplied === 'string')
          && stagingPathAllowed(stagingRoot, supplied || '.');
      })
      && (rules.globs || []).every((field) => stagingGlobAllowed(value[field]));
    if (!allowed) {
      return {
        behavior: 'deny',
        message: '后台技能审核只能访问隔离候选工作区',
        ...(sdkOptions.toolUseID ? { toolUseID: sdkOptions.toolUseID } : {}),
        decisionClassification: 'user_reject',
      };
    }
    return {
      behavior: 'allow',
      ...(sdkOptions.toolUseID ? { toolUseID: sdkOptions.toolUseID } : {}),
      decisionClassification: 'user_temporary',
    };
  };
}

// 后台跑一次技能 review。fire-and-forget;不串聊天 UI 事件、不计入对话并行数。
function runSkillReviewJob({ conversationText, workingDir, triggerReason } = {}) {
  if (reviewInflight) {
    pendingSkillReviews.push({ conversationText, workingDir, triggerReason });
    if (pendingSkillReviews.length > MAX_PENDING_SKILL_REVIEWS) {
      pendingSkillReviews.splice(0, pendingSkillReviews.length - MAX_PENDING_SKILL_REVIEWS);
    }
    console.log('[skill-review] 上一次 review 仍在跑,已排队触发 queue=%d', pendingSkillReviews.length);
    return { started: false, queued: true };
  }
  const text = String(conversationText || '').trim();
  if (!text) return { started: false, skipped: 'empty' };

  reviewInflight = true;
  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch (_) {}
  const reviewId = `review-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const workspaceRoot = path.join(app.getPath('userData'), 'skill-review-staging', reviewId);
  let stagingRoot, baseDir;
  try {
    ({ stagingRoot, baseDir } = prepareSkillGenerationWorkspace({ skillsDir: SKILLS_DIR, workspaceRoot }));
  } catch (e) {
    reviewInflight = false;
    return { started: false, queued: false, skipped: 'staging_failed', error: e.message };
  }

  // 输出静默消费(不串聊天 UI);只在结束时看有没有新技能。
  //   工具白名单 + 主进程路径守卫只授权隔离候选目录；90s 硬超时防模型卡死。
  runRelayText({
    prompt: buildSkillReviewPrompt(text, triggerReason, stagingRoot),
    cwd: stagingRoot,
    model: 'haiku',                       // review 走 haiku 档(用户选定;出问题再调)
    additionalDirectories: [stagingRoot],
    permissionMode: 'default',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    canUseTool: createStagingToolGuard(stagingRoot),
    timeoutMs: 90000,
  }).then(async () => {
    const drafts = [];
    if (!skillDraftService) throw new Error('Skill 草稿服务不可用');
    // Admit the complete finalized batch before yielding so shutdown drains all candidates.
    await Promise.all(fs.readdirSync(stagingRoot, { withFileTypes: true }).map(async entry => {
      if (!entry.isDirectory() || entry.name.startsWith('.')) return;
      const packageDir = path.join(stagingRoot, entry.name);
      if (!fs.existsSync(path.join(packageDir, 'SKILL.md'))) return;
      try {
        const draft = await skillDraftService.createDraft({
          skillName: entry.name,
          stagingDir: packageDir,
          baseDir,
          sourceRef: { type: 'conversation-review', reviewId, triggerReason: triggerReason || null },
          note: '由 Relay 对话回看生成，发布前需要人工审核。',
        });
        drafts.push(draft);
        broadcastSkillDraftEvent(draft.deduplicated ? 'skillDraft.updated' : 'skillDraft.created', { draft });
      } catch (e) {
        if (!e || e.code !== 'NO_CHANGES') {
          console.warn('[skill-review] 候选技能 %s 无法生成草稿: %s', entry.name, e.message);
        }
      }
    }));
    const newDrafts = drafts.filter(draft => !draft.deduplicated);
    if (newDrafts.length) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'Relay 有新的技能更新',
            body: `有 ${newDrafts.length} 个技能更新等待审核。`,
            icon: currentAppIcon() || undefined,
          }).show();
        }
      } catch (_) {}
      console.log('[skill-review] 已生成待审草稿: %s', drafts.map((item) => item.skillName).join(', '));
    } else console.log('[skill-review] 本次无可发布的技能改动');
  }).catch((e) => {
    console.error('[skill-review] 执行出错:', e && e.message);
  }).finally(() => {
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch (_) {}
    reviewInflight = false;
    const pending = pendingSkillReviews.shift();
    if (pending) setImmediate(() => runSkillReviewJob(pending));
  });
  return { started: true, queued: false };
}

// 读/写 二期配置(总开关 + 频率)
function getReviewConfig() {
  const a = readAppSettings();
  const every = parseInt(a.skillReviewEveryTurns, 10);
  return {
    enabled: a.skillAutoReview !== false,   // 默认开
    everyTurns: (Number.isFinite(every) && every >= 1) ? every : REVIEW_DEFAULT_EVERY,
    autoArchive: a.skillAutoArchive === true,
    archiveDays: normalizeMaintenancePolicy(a).archiveDays,
  };
}

// renderer 在 finishRun 里按强信号或周期兜底调它(已在 renderer 侧判好节奏/排除条件,这里只管跑)
ipcMain.handle('skills:autoReview', (_e, { conversationText, workingDir, triggerReason } = {}) => {
  try {
    if (!getReviewConfig().enabled) return { ok: false, skipped: 'disabled' };
    return { ok: true, ...runSkillReviewJob({ conversationText, workingDir, triggerReason }) };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('skills:getReviewConfig', () => ({ ok: true, ...getReviewConfig() }));
ipcMain.handle('skills:setReviewConfig', (_e, { enabled, everyTurns, autoArchive } = {}) => {
  try {
    const a = readAppSettings();
    if (enabled !== undefined) a.skillAutoReview = !!enabled;
    if (autoArchive !== undefined) a.skillAutoArchive = autoArchive === true;
    if (everyTurns !== undefined) {
      const v = parseInt(everyTurns, 10);
      if (Number.isFinite(v) && v >= 1) a.skillReviewEveryTurns = Math.min(v, 100);
    }
    writeAppSettings(a);
    return { ok: true, ...getReviewConfig() };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator 三期:LLM 伞状合并体检(审核式 + 定时 + opus)
//   定时让 opus 在隔离副本中通览技能库，把同类碎技能整理成类级大技能候选。
//   完成后只生成待审核草稿；正式技能库的发布、归档和回滚始终由用户显式操作。
//   prompt 改写自 Hermes agent/curator.py 的 CURATOR_REVIEW_PROMPT(umbrella-building pass)。
// ─────────────────────────────────────────
const SKILL_CURATOR_PROMPT_HEAD = [
  '你现在作为后台「技能库策展员」在运行。这是一次「伞状合并」整理,不是被动审计、也不是简单查重。',
  '',
  '你当前的工作目录是技能库的隔离候选副本，不是正式技能库。每个子目录是一个技能,内含 SKILL.md(YAML frontmatter:name/description)+ 可选的 references/ templates/ scripts/ assets/ 子文件。所有操作都用相对路径在当前目录里进行。',
  '',
  '目标:技能库应该是一批「类级」的大技能(每个 SKILL.md 内容丰富 + 用子文件装一次性细节),而不是几百个「一次会话一个 bug」的窄技能。检索技能是按 description 匹配的——一个带多个小节的大伞技能,比五个名字相近的窄兄弟更好找。',
  '',
  '判据(关键):不要问「这两个像不像」,要问「一个人类维护者会把这些写成 N 个独立技能,还是 1 个带 N 个小节的大技能?」——答案是后者,就合并。「每个技能触发场景不同」不是保留的理由,而是把它作为大技能的一个小节的理由。',
  '',
  '三种合并手法(按簇选合适的):',
  '① 并入已有伞技能:某个技能已经够大够通用 → 用 Edit 给它加一节(吸收兄弟的独特点),并在总结中把兄弟列为归档候选。',
  '② 新建伞技能:没有现成的够大 → 用 Write 建一个类级 <伞名>/SKILL.md 覆盖这一类的共同流程 + 短小节,并在总结中列出被吸收的窄兄弟。',
  '③ 降级成子文件:某个窄技能有"窄但有价值"的一次性内容 → 把它复制进伞技能的 references/<主题>.md(一次性细节/知识)、templates/<名>(可复制的样板)、scripts/<名>(可直接跑的脚本),并改写新包内的路径。',
  '',
  '硬规则(必须遵守):',
  '1. 不要移动、删除或改名任何现有技能目录，也不要创建 .archive。这里只生成新建/更新候选；需要归档的旧技能写进末尾的 archive_candidates，交给用户审核后手动归档。',
  '2. 绝对不要碰 pinned 列表里的技能(下面会列出)——跳过它们,既不合并也不归档。',
  '3. 绝对不要碰 . 开头的东西(.archive、.usage.json 等是元数据,不是技能)。',
  '4. 包完整性:某个技能带 references/ templates/ scripts/ assets/ 子文件、或 SKILL.md 里有指向这些的相对链接时,不要只把它的 SKILL.md 拍扁塞进别人的 references。三选一:要么整体保留为独立技能、要么连子文件一起搬进伞技能对应目录并改写路径、要么整包原样归档。绝不能留下指向"已被搬走的旧目录"的死链接。',
  '5. 名字太窄的技能(带 PR 号、某个报错串、功能代号、"fix-X/debug-Y/今天的Z"这种一次性命名)几乎都该作为某个伞技能的小节或子文件,而不是独立技能。',
  '6. 稳健:每次只处理你有把握的簇。拿不准是否该合并的,保持原样别动。技能数量很少时(比如就两三个、彼此无关),直接保持现状、什么都不做也是对的。',
  '7. 质量遥测只是证据:纠正/重试/工具报错可能由任务本身或多个技能共同造成。不得仅凭单次负向信号归档技能;优先 Read 内容判断,多次稳定负向证据才用于提示合并或修订。',
  '',
  '做完后,在回复末尾输出一段结构化 YAML(给系统善后用),格式严格如下:',
  '```yaml',
  'consolidations:',
  '  - from: <被合并掉的技能名>',
  '    into: <合并进的伞技能名>',
  '    reason: <一句话:为什么合,不要只写"相似">',
  'prunings:',
  '  - name: <纯归档、无合并目标的技能名>',
  '    reason: <一句话:为什么归档>',
  'archive_candidates:',
  '  - name: <建议归档的旧技能名>',
  '    reason: <一句话原因>',
  '```',
  '没有就留空列表(consolidations: []; prunings: []; archive_candidates: [])。这段 YAML 放在你给人看的总结之后。',
  '',
].join('\n');

// 拼最终体检 prompt:头部规则 + 当前技能清单(名字/描述/pinned)。清单由 main 现算(自包含,不靠模型 ls)。
function buildSkillCuratorPrompt(targetDir = null) {
  let listText = '', count = 0;
  try {
    const sidecar = readSkillUsage();
    const usageState = loadSkillUsageState();
    const skills = listSkillNames();
    count = skills.length;
    if (!skills.length) {
      listText = '(技能库目前是空的,无需整理。直接回复「技能库为空,无需整理」并停止。)';
    } else {
      listText = skills.map((s) => {
        const pinned = sidecar[s.name] && sidecar[s.name].pinned ? '  [PINNED-跳过]' : '';
        const desc = (s.desc || '').slice(0, 120);
        const u = usageState.map.get(s.callName || s.name) || usageState.map.get(s.name) || {};
        const telemetry = `调用 ${Number(u.useCount) || 0};反馈机会 ${Number(u.feedbackOpportunities) || 0};` +
          `纠正 ${Number(u.correctionCount) || 0};重试 ${Number(u.retryCount) || 0};工具报错 ${Number(u.toolErrorCount) || 0};` +
          `正向确认 ${Number(u.positiveCount) || 0}${u.lastNegativeAt ? `;最近负向 ${u.lastNegativeAt}` : ''}`;
        return `· ${s.name}${pinned}\n    ${desc}\n    遥测:${telemetry}`;
      }).join('\n');
    }
  } catch (e) { console.warn('[curator] 读取技能清单失败: %s', e.message); listText = '(读取技能清单失败,请你自己用 Bash ls 看当前目录)'; }
  const rootHint = targetDir ? `候选工作区绝对路径:${targetDir}\n\n` : '';
  return SKILL_CURATOR_PROMPT_HEAD + rootHint + '当前已安装技能清单(共 ' + count + ' 个):\n\n' + listText;
}

function prepareSkillCurator() {
  refreshSkillUsageInBackground({ force: true }).catch(() => {});
  if (!skillDraftService) throw new Error('Skill 草稿服务不可用');
  const id = `curator-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const workspaceRoot = path.join(app.getPath('userData'), 'skill-curator-staging', id);
  const workspace = prepareSkillGenerationWorkspace({ skillsDir: SKILLS_DIR, workspaceRoot });
  const { stagingRoot } = workspace;
  return {
    id,
    ...workspace,
    createdAt: new Date().toISOString(),
    prompt: buildSkillCuratorPrompt(stagingRoot),
    canUseTool: createStagingToolGuard(stagingRoot),
  };
}

// scheduler 在隔离体检完成后调用。成功时把每个发生变化的完整技能包转成持久草稿；
// 失败/取消只清理隔离目录，正式技能库在任何情况下都不会被后台体检直接改写。
async function finalizeSkillCuratorDrafts(result, context) {
  const drafts = [];
  const stagingRoot = context && context.stagingRoot;
  try {
    if (!result || result.ok !== true || !stagingRoot || !fs.existsSync(stagingRoot)) return { drafts };
    if (!context.baseDir || !fs.existsSync(context.baseDir)) throw new Error('技能生成基线缺失，请重新运行体检');
    // Admit the complete finalized batch before yielding so shutdown drains all candidates.
    await Promise.all(fs.readdirSync(stagingRoot, { withFileTypes: true }).map(async entry => {
      if (!entry.isDirectory() || entry.name.startsWith('.')) return;
      const packageDir = path.join(stagingRoot, entry.name);
      if (!fs.existsSync(path.join(packageDir, 'SKILL.md'))) return;
      try {
        const draft = await skillDraftService.createDraft({
          skillName: entry.name,
          stagingDir: packageDir,
          baseDir: context.baseDir,
          sourceRef: { type: 'skill-curator', reviewId: context.id || null },
          note: '由定期技能体检生成。请先查看完整包差异与校验结果，再决定是否发布；归档建议需另行确认。',
        });
        drafts.push(draft);
        broadcastSkillDraftEvent(draft.deduplicated ? 'skillDraft.updated' : 'skillDraft.created', { draft });
      } catch (e) {
        if (!e || e.code !== 'NO_CHANGES') {
          console.warn('[skill-curator] 候选技能 %s 无法生成草稿: %s', entry.name, e.message);
        }
      }
    }));
    const newDrafts = drafts.filter(draft => !draft.deduplicated);
    if (newDrafts.length) {
      result.summary = `有 ${newDrafts.length} 个技能更新等待审核`;
      if (Notification.isSupported()) {
        new Notification({
          title: '技能库体检完成',
          body: `有 ${newDrafts.length} 个技能更新等待审核，正式技能尚未改变。`,
          icon: currentAppIcon() || undefined,
        }).show();
      }
    } else {
      result.summary = drafts.length ? '本次提炼已归并到现有待处理更新' : (result.summary || '技能库体检完成，没有产生包变更');
    }
    return { drafts };
  } finally {
    if (stagingRoot) {
      try { fs.rmSync(context.workspaceRoot || stagingRoot, { recursive: true, force: true }); }
      catch (e) { console.warn('[skill-curator] 清理隔离目录失败: %s', e.message); }
    }
  }
}

// 定时任务只保存声明，不保存正式技能目录；每次真正执行时由 prepareSkillCurator 动态创建隔离副本。
ipcMain.handle('skills:getDir', () => ({ ok: true, dir: null, isolated: true }));
ipcMain.handle('skills:curatorPrompt', () => ({
  ok: true,
  prompt: '运行隔离的技能库体检，并把任何候选变更提交为待审核草稿。',
  isolated: true,
}));

// 点击导入区时只负责选择文件；真正开始安装后 renderer 才切换“正在安装”状态。
ipcMain.handle('data:pickImportZip', async (_e, { kind } = {}) => {
  if (kind !== 'agent' && kind !== 'skill') return { ok: false, message: '未知安装包类型' };
  const r = await dialog.showOpenDialog({
    title: kind === 'skill' ? '选择技能包 (.zip)' : '选择 Agent 包 (.zip)',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

// 选取或拖入 zip → 解压 → 自动安装到对应目录(kind: 'agent' | 'skill')。
// zipPath 只用于 renderer 通过 webUtils 取得的拖放文件；未传时仍打开系统文件选择器。
ipcMain.handle('data:importZip', async (_e, { kind, zipPath } = {}) => {
  if (kind !== 'agent' && kind !== 'skill') return { ok: false, message: '未知安装包类型' };
  let zip = String(zipPath || '').trim();
  if (!zip) {
    const r = await dialog.showOpenDialog({
      title: kind === 'skill' ? '选择技能包 (.zip)' : '选择 Agent 包 (.zip)',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    zip = r.filePaths[0];
  }
  if (path.extname(zip).toLowerCase() !== '.zip') return { ok: false, message: '仅支持 .zip 安装包' };
  try {
    if (!fs.statSync(zip).isFile()) return { ok: false, message: '安装包不是有效文件' };
  } catch (_) {
    return { ok: false, message: '安装包不存在或无法访问' };
  }
  let temp;
  try {
    temp = await unzipToTemp(zip);
    const root = findContentRoot(temp);
    if (kind === 'agent') {
      // 统一把包里所有 Agent 定义(.md)收集进 ~/.claude/agents。
      //   兼容三种包形态:① 完整包(含 .claude/agents/*.md)② 松散 .md ③ 直接一个 .md。
      //   优先取 .claude/agents 下的(那才是真正的子智能体定义),否则退而取所有 .md。
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      const claudeAgentsDir = path.join(root, '.claude', 'agents');
      let mds = [];
      if (fs.existsSync(claudeAgentsDir)) {
        mds = fs.readdirSync(claudeAgentsDir)
          .filter((n) => n.toLowerCase().endsWith('.md'))
          .map((n) => path.join(claudeAgentsDir, n));
      } else {
        (function findMd(d) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === '__MACOSX') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) findMd(p);
            else if (e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') mds.push(p);
          }
        })(root);
      }
      if (!mds.length) return { ok: false, message: '压缩包里没找到 Agent(.md)文件' };
      // 全局放一份 .md,保证 Relay 的 agent 列表能发现 + 能触发(子智能体 id 由 frontmatter.name 决定)
      for (const m of mds) fs.copyFileSync(m, path.join(AGENTS_DIR, path.basename(m)));

      // ── 项目级支持:把【整包】铺到固定项目根,并记录 agentName→项目根 映射 ──
      //   feature-dev 这类 agent 运行时会 `cat knowledge/xxx`(相对 cwd 的路径),
      //   只复制 .md 到全局会丢掉 knowledge/ 等同级资源 → 跑到一半读不到文件。
      //   故把整包原样铺到 ~/.claude/relay-agents/<agentName>/,运行时(claude:run)
      //   在用户没指定工作目录时自动把 cwd 设为该项目根,等价于 CLI 的项目级用法。
      //   判定"完整包":包里除 .claude/ 外还有别的资源(如 knowledge/、CLAUDE.md)。
      const hasExtraResources = fs.readdirSync(root, { withFileTypes: true })
        .some((e) => e.name !== '.claude' && e.name !== '__MACOSX' && e.name !== '.DS_Store'
          && e.name.toLowerCase() !== 'readme.md');
      if (hasExtraResources) {
        const appCfg = readAppSettings();
        if (!appCfg.agentProjects) appCfg.agentProjects = {};   // { agentName → 项目根绝对路径 }
        const projBase = path.join(os.homedir(), '.claude', 'relay-agents');
        fs.mkdirSync(projBase, { recursive: true });
        for (const m of mds) {
          let agentName = '';
          try { agentName = (parseFrontmatter(fs.readFileSync(m, 'utf8')).name || '').trim(); } catch (_) {}
          if (!agentName) agentName = path.basename(m).replace(/\.md$/i, '');
          // 每个 agent 一个项目根;同名重复导入则覆盖
          const projRoot = path.join(projBase, agentName.replace(/[\\/:*?"<>|]/g, '_'));
          fs.rmSync(projRoot, { recursive: true, force: true });
          fs.cpSync(root, projRoot, { recursive: true, force: true });
          appCfg.agentProjects[agentName] = projRoot;
        }
        writeAppSettings(appCfg);
      }

      // 若包里同时带技能(.claude/skills/*),顺手一起导入到全局技能目录
      const pkgSkills = path.join(root, '.claude', 'skills');
      let skillNote = '';
      if (fs.existsSync(pkgSkills)) {
        const importedSkillDirs = await withSkillLibraryWrite(() => {
          fs.mkdirSync(SKILLS_DIR, { recursive: true });
          const directories = [];
          for (const e of fs.readdirSync(pkgSkills, { withFileTypes: true })) {
            if (e.isDirectory()) {
              const dest = path.join(SKILLS_DIR, e.name);
              getSkillMaintenanceHost().forget(e.name);
              fs.cpSync(path.join(pkgSkills, e.name), dest, { recursive: true, force: true });
              directories.push(dest);
            }
          }
          return directories;
        });
        const sc = importedSkillDirs.length;
        if (sc) {
          const meta = await generateImportedSkillPresentations(importedSkillDirs);
          skillNote = `，并附带 ${sc} 个技能`;
          if (meta.fallbackCount) skillNote += `（${meta.fallbackCount} 个使用原始说明）`;
        }
      }
      return { ok: true, message: `已导入 ${mds.length} 个 Agent${skillNote}`, items: listAgentNames() };
    }
    // skill
    const dirs = findDirsWithFile(root, 'SKILL.md', 3);
    if (!dirs.length) return { ok: false, message: '压缩包里没找到技能(缺少 SKILL.md)' };
    const importedSkillDirs = await withSkillLibraryWrite(() => {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const directories = [];
      for (const d of dirs) {
        // SKILL.md 直接在解压根(无文件夹包裹)→ 用 zip 名;否则用所在文件夹名
        const name = (d === temp) ? path.basename(zip, path.extname(zip)) : path.basename(d);
        const dest = path.join(SKILLS_DIR, name);
        getSkillMaintenanceHost().forget(name);
        fs.cpSync(d, dest, { recursive: true, force: true });
        directories.push(dest);
      }
      return directories;
    });
    const count = importedSkillDirs.length;
    const meta = await generateImportedSkillPresentations(importedSkillDirs);
    const metaNote = meta.fallbackCount
      ? `；${meta.fallbackCount} 个中文摘要生成失败，已使用原始说明`
      : '，中文标题与摘要已生成';
    return { ok: true, message: `已导入 ${count} 个技能${metaNote}`, items: listSkillNames() };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  } finally {
    if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {} }
  }
});

// ─────────────────────────────────────────
// IPC: 长期记忆库管理(数据中心「记忆」标签页用)
// ─────────────────────────────────────────
// 这些接口代表用户在 Relay 中的操作；模型由独立的记忆工具执行草稿治理。
// 所有正文修改、移除和恢复经过 MemoryStore，保留版本并校验可选的读取版本。

function memoryIpcError(error, extra = {}) {
  return { ok: false, message: error.message, error: error.message, code: error.code || null, ...extra };
}

function memoryListResult(options = {}) {
  try {
    options = options && typeof options === 'object' ? options : {};
    refreshSkillUsageInBackground().catch(() => {});
    const archived = options.archived === true;
    const context = options.context || { projectId: options.projectId };
    const sidecar = readMemoryUsage();
    const entries = archived ? relayMemoryStore.archived() : relayMemoryStore.list();
    const items = entries.map((entry) => {
      const { file, meta } = entry;
      const usage = memoryReadStats(file) || {};
      return {
        file,
        name: meta.name || file.replace(/\.md$/i, ''),
        description: meta.description,
        type: meta.type,
        scope: meta.scope,
        projectId: meta.projectId,
        status: archived ? 'archived' : meta.status,
        confidence: meta.confidence,
        sourceRef: meta.sourceRef,
        expiresAt: meta.expiresAt,
        supersedes: meta.supersedes,
        supersedesRevision: meta.supersedesRevision,
        eligible: !archived && memoryEligibility(meta, context).eligible,
        schemaErrors: meta.schemaErrors,
        revision: entry.revision || null,
        mtime: entry.mtime || Date.parse(entry.createdAt) || 0,
        pinned: meta.core || !!(sidecar[file] && sidecar[file].pinned),
        pinnedInFile: meta.core,
        exposureCount: Math.max(0, Number(sidecar[file] && sidecar[file].exposureCount) || 0),
        readCount: Math.max(0, Number(usage.readCount) || 0),
        lastReadAt: usage.lastReadAt || null,
        archived,
        ...(archived ? { versionId: entry.versionId, archivedAt: entry.createdAt } : {}),
      };
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime || a.file.localeCompare(b.file));
    return { ok: true, items, dir: MEMORY_DIR, hasIndex: fs.existsSync(MEMORY_INDEX), archived };
  } catch (error) { return memoryIpcError(error, { items: [] }); }
}

ipcMain.handle('memory:list', (_event, options) => memoryListResult(options));

ipcMain.handle('memory:archived', () => {
  try { return { ok: true, items: relayMemoryStore.archived() }; }
  catch (error) { return memoryIpcError(error, { items: [] }); }
});

ipcMain.handle('memory:setPinned', (_event, { file, pinned } = {}) => {
  try {
    const entry = relayMemoryStore.read(file);
    const usage = readMemoryUsage();
    const record = usage[entry.file] && typeof usage[entry.file] === 'object' ? usage[entry.file] : {};
    record.pinned = !!pinned;
    usage[entry.file] = record;
    flushMemoryUsage();
    rebuildMemoryIndex();
    return { ok: true, pinned: record.pinned };
  } catch (error) { return memoryIpcError(error); }
});

ipcMain.handle('memory:setStatus', (_event, { file, status, expectedRevision } = {}) => {
  try {
    const result = relayMemoryStore.setStatus(file, status, { actor: 'user', expectedRevision });
    rebuildMemoryIndex();
    return { ok: true, file: result.file, status: result.meta.status, revision: result.revision, versionId: result.versionId };
  } catch (error) { return memoryIpcError(error); }
});

// 生成索引只供宿主 UI 查看；模型的 MemoryStore.read 不允许访问 MEMORY.md。
ipcMain.handle('memory:read', (_event, file) => {
  try {
    if (typeof file === 'string' && file.toLowerCase() === 'memory.md') {
      const { indexLines } = rebuildMemoryIndex();
      return { ok: true, file: 'MEMORY.md', content: indexLines.length ? indexLines.join('\n') + '\n' : '', revision: null, generated: true };
    }
    const entry = relayMemoryStore.read(file, { actor: 'user' });
    return { ok: true, ...entry, content: entry.content.replace(/^\uFEFF/, '') };
  } catch (error) { return memoryIpcError(error); }
});

ipcMain.handle('memory:write', (_event, { file, content, expectedRevision } = {}) => {
  try {
    const result = relayMemoryStore.write(file, content, { actor: 'user', expectedRevision });
    rebuildMemoryIndex();
    return { ok: true, file: result.file, revision: result.revision, versionId: result.versionId };
  } catch (error) { return memoryIpcError(error); }
});

// 移除会归档正文，保留使用统计，恢复后继续沿用原有固定状态与统计。
ipcMain.handle('memory:remove', (_event, request) => {
  try {
    const { file, expectedRevision } = typeof request === 'string' ? { file: request } : (request || {});
    const result = relayMemoryStore.archive(file, { actor: 'user', expectedRevision });
    rebuildMemoryIndex();
    return { ok: true, ...result };
  } catch (error) { return memoryIpcError(error); }
});

ipcMain.handle('memory:history', (_event, file) => {
  try { return { ok: true, items: relayMemoryStore.history(file, { actor: 'user' }) }; }
  catch (error) { return memoryIpcError(error, { items: [] }); }
});

ipcMain.handle('memory:restore', (_event, { file, versionId, expectedRevision } = {}) => {
  try {
    const result = relayMemoryStore.restore(file, versionId, { actor: 'user', expectedRevision });
    rebuildMemoryIndex();
    return { ok: true, file: result.file, revision: result.revision, versionId: result.versionId };
  } catch (error) { return memoryIpcError(error); }
});

ipcMain.handle('memory:revealFile', (_event, file) => {
  try {
    const entry = relayMemoryStore.read(file, { actor: 'user' });
    shell.showItemInFolder(path.join(MEMORY_DIR, entry.file));
    return { ok: true };
  } catch (error) { return memoryIpcError(error); }
});


// IPC: 探测环境(Agent 目录是否存在;运行时随 SDK 内置故恒可用)
ipcMain.handle('env:probe', async () => ({
  agentDir: AGENTS_DIR,
  agentDirExists: fs.existsSync(AGENTS_DIR),
  claudeExe: claudeSdk.bundledExecutable(),
  claudeAvailable: true,
  claudeVersion: CLAUDE_RUNTIME_VERSION,
  bundled: true,
}));

// ─────────────────────────────────────────
// IPC: 定时任务（scheduler.js）
// ─────────────────────────────────────────
//   调度器跑在主进程内（复用托盘常驻 + runClaudeJob）。这里只做 IPC 转发 + 启动注入。
function initScheduler() {
  try {
    scheduler.init({
      userDataDir: app.getPath('userData'),
      agentDir: AGENTS_DIR,                 // 定时 Agent 与交互 Agent 使用同一份已安装配置
      runClaudeJob,                       // 执行核心（上面抽出的纯函数）
      resolveWorkspace: resolveExecutionWorkspace,
      acceptsWorkspaceSession: (id, sessionId) => getConversationWorkspaces().acceptsSession(id, sessionId),
      workspaceContextCarried: (id) => getConversationWorkspaces().markContextCarried(id),
      resolveChatRoute: (tier) => {
        const runtime = activeRelayProviderRuntime({ tier });
        return providerSessionRoute(runtime, runtime.tier || tier);
      },
      memoryConsolidationPrompt: MEMORY_CONSOLIDATION_PROMPT,
      buildMemoryHint,                    // 普通定时任务默认只读；内置记忆整理使用 maintenance 候选模式
      generateImage: generateImageCore,   // 定时出图（type=image）复用图像生成核心
      saveConversation,                   // chat/出图结果落历史（v2 目录式:单条写入,不再整库读写）
      loadConversation,                   // 读单条会话（被删→null）：同一任务多次执行复用同一条会话
      readAppSettings, writeAppSettings,  // 开机自启等开关
      refreshTray: refreshTrayMenu,       // 托盘「下一个任务」提示刷新
      getMainWindow: () => mainWindow,    // 推送 sched:update 给 renderer
      onSkillCuratorStart: prepareSkillCurator,              // 创建隔离副本与动态体检 prompt
      onSkillCuratorDone: finalizeSkillCuratorDrafts,        // 只生成待审草稿并清理隔离副本
      onMemoryMaintenanceStart: () => refreshSkillUsageInBackground({ force: true }), // 整理前刷新记忆实读遥测
      taskRunStart: startScheduledShadowRun,
      taskRunAcquire: async (runId, actionType) => {
        const run = taskLedger && taskLedger.get(runId);
        const workspace = run && run.metadata && run.metadata.workingDir;
        const conversationId = run && run.source && run.source.conversationId;
        if (!await waitForCheckpointUnlock(workspace, conversationId)) return null;
        const lease = await acquireTaskResource(
          runId,
          actionType === 'image' ? 'image' : (actionType === 'command' ? 'command' : 'claude'),
          conversationId || null,
        );
        if (!lease) return null;
        if (!await waitForCheckpointUnlock(workspace, conversationId, { signal: lease.signal })) {
          lease.release();
          return null;
        }
        return lease;
      },
      taskRunRelease: releaseTaskResource,
      taskRunPhase: updateScheduledShadowPhase,
      taskRunEvent: (runId, evt) => enqueueShadowClaudeEvent(runId, evt, { terminalOwner: 'scheduler' }),
      taskRunFinish: finishScheduledShadowRun,
      notify: ({ title, body }) => {
        try {
          if (Notification.isSupported()) {
            new Notification({ title: title || 'Relay', body: body || '', icon: currentAppIcon() || undefined }).show();
          } else if (tray) {
            tray.displayBalloon({ icon: currentAppIcon() || undefined, title: title || 'Relay', content: body || '' });
          }
        } catch (_) {}
      },
    });
    console.log('[scheduler] 已启动');
  } catch (e) {
    console.error('[scheduler] 启动失败:', e.message);
  }
}

// 首次创建定时任务时，询问用户是否开启「开机自启」（按决策：不默认偷偷常驻）。
//   只问一次：在 app-settings 记 autostartAsked 标志。返回是否本次弹了询问。
async function maybeAskAutostart() {
  const a = readAppSettings();
  if (a.autostartAsked) return false;
  a.autostartAsked = true;
  writeAppSettings(a);
  try {
    const r = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'question',
      buttons: ['开启开机自启', '暂不开启'],
      defaultId: 0,
      cancelId: 1,
      title: '定时任务',
      message: '让 Relay 开机自动在后台运行？',
      detail: '定时任务只有在 Relay 运行时才会触发。开启「开机自启」后，Relay 会随系统启动并静默到托盘，定时任务更可靠。\n\n若不开启：应用没开着时到点的任务，会在你下次打开 Relay 时补跑一次。\n\n（之后可在 设置 中随时更改。）',
    });
    const enable = r.response === 0;
    setAutoLaunch(enable);
    return true;
  } catch (e) { console.warn('[autostart] 弹窗失败: %s', e.message); return false; }
}

// 设置/取消开机自启（Windows 走注册表 Run 键；--autostart 让启动时静默到托盘）。
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable, args: ['--autostart'] });
    const a = readAppSettings();
    a.autoLaunch = !!enable;
    writeAppSettings(a);
  } catch (e) { console.error('[autostart] 设置失败:', e.message); }
}

ipcMain.handle('sched:list',   () => ({ ok: true, items: scheduler.list() }));
ipcMain.handle('sched:runs', (_e, id) => ({ ok: true, items: scheduler.runs(typeof id === 'string' ? id : undefined) }));
ipcMain.handle('sched:create', async (_e, task) => {
  const r = scheduler.create(task);
  // 首个任务创建成功后，问一次开机自启
  try { if (r.ok && scheduler.list().length === 1) await maybeAskAutostart(); } catch (e) { console.warn('[sched] autostart 检查失败: %s', e.message); }
  return r;
});
ipcMain.handle('sched:update', (_e, { id, patch }) => scheduler.update(id, patch));
ipcMain.handle('sched:remove', (_e, id) => scheduler.remove(id));
ipcMain.handle('sched:toggle', (_e, { id, enabled }) => scheduler.toggle(id, enabled));
ipcMain.handle('sched:runNow', async (_e, id) => await scheduler.runNow(id));
ipcMain.handle('sched:preview', (_e, schedule) => ({ ok: true, times: scheduler.preview(schedule) }));
// 开机自启开关（设置页用）
ipcMain.handle('sched:getAutoLaunch', () => {
  try {
    const s = app.getLoginItemSettings({ args: ['--autostart'] });
    return { ok: true, enabled: !!s.openAtLogin };
  } catch (e) { console.warn('[autostart] 读取注册表失败: %s', e.message); return { ok: true, enabled: !!readAppSettings().autoLaunch }; }
});
ipcMain.handle('sched:setAutoLaunch', (_e, enabled) => { setAutoLaunch(enabled); return { ok: true }; });

// ─────────────────────────────────────────
// Electron 生命周期
// ─────────────────────────────────────────
app.whenReady().then(() => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  applyParallelTaskLimit(normalizePreferences(readAppSettings()).maxParallelTasks);
  nativeTheme.on('updated', updateNativeBrandTheme);
  app.once('will-quit', () => {
    nativeTheme.removeListener('updated', updateNativeBrandTheme);
    nativeBrandTheme.dispose();
  });
  // ⚡ 首屏优先:先建窗(decideStartup 快速路径同步命中即零延迟),其余维护任务全推到窗口之后,
  //   避免同步文件 I/O 在窗口创建前阻塞主线程,导致"按钮要等一下才能点"。
  decideStartup();
  if (!mainWindow) scheduleStartupTaskLedgerRetention();
  updateNativeBrandTheme();
  // 两个一次性/幂等迁移推到窗口创建之后的后台跑(不挡首屏;数据量小,延后无副作用)。
  //   migrateHistoryV1 在无旧 history.json 时瞬间 return;migrateScheduledTitles 全量扫历史索引,
  //   故都延后,且后者本就只为洗很久前的 ⏰ 前缀,绝大多数启动无命中。
  setTimeout(() => {
    try { migrateHistoryV1(); } catch (e) { console.warn('[startup] 历史迁移 V1 失败: %s', e.message); }
    try { migrateScheduledTitles(); } catch (e) { console.warn('[startup] 定时标题迁移失败: %s', e.message); }
  }, 800);
  // 启动调度器：延后一拍,让窗口首帧 + 渲染层启动 IPC(settings/brand/history)先走,
  //   scheduler.init 读 schedules.json + 注册 cron 不挤占首屏。错过补跑本就在其内部再延后。
  setTimeout(() => { try { initScheduler(); } catch (e) { console.error('[scheduler] 启动失败', e); } }, 300);
  // 应用自更新:打包版才生效(内部有 isPackaged 守卫);首查在其内部再延迟 3 分钟,不影响首屏。
  try {
    updater.init({
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      markQuitting: () => { isQuitting = true; },
      getMainWindow: () => mainWindow,
      notify: ({ title, body }) => {
        try {
          if (Notification.isSupported()) {
            new Notification({ title: title || 'Relay', body: body || '', icon: currentAppIcon() || undefined }).show();
          } else if (tray) {
            tray.displayBalloon({ icon: currentAppIcon() || undefined, title: title || 'Relay', content: body || '' });
          }
        } catch (_) {}
      },
    });
  } catch (e) { console.error('[updater] 启动失败:', e.message); }
  // 技能用量不再在启动阶段预热；首次打开技能页时先显示持久化快照，再由 Worker 增量校准。
  // 全局快捷键唤起迷你输入框(Alt+Space)。注册失败不影响主功能,托盘菜单仍可唤起。
  registerMiniShortcut();
  getMiniWindowHost().start();
  // 窗口先显示，统计在后台预热；首次打开用量页无需等待历史重读。
  const usageWarmup = setTimeout(() => {
    if (!isQuitting) getUsageStatsService().refresh().catch(() => {});
  }, 1800);
  usageWarmup.unref?.();
  try { powerMonitor.on('resume', handlePowerResume); }
  catch (e) { console.warn('[scheduler] 无法监听系统恢复事件: %s', e.message); }
});
app.on('window-all-closed', () => {
  // 主窗口现在「关闭=隐藏到托盘」,不会触发本事件;此处只在真正退出(isQuitting)
  //   或仅有向导窗口被关时走到。托盘存活且非退出意图时,保持进程驻留让后台任务继续跑。
  if (!isQuitting && tray) return;
  // 杀掉所有在跑的 claude 子进程(含常驻会话 —— 它们不会自己退,漏杀就是每个 ~630MB 的孤儿)
  for (const [, child] of jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
  jobs.clear();
  for (const sess of [...liveSessions.values()]) killLiveSession(sess, '应用退出');
  if (process.platform !== 'darwin') app.quit();
});
// 退出前兜底清理:无论从哪条路径退出,都确保子进程被杀、托盘被销毁(否则托盘图标残留)
app.on('before-quit', event => {
  isQuitting = true;
  if (skillDraftService && !skillDraftShutdownComplete) {
    event.preventDefault();
    if (!skillDraftShutdownPending) {
      skillDraftShutdownPending = true;
      skillDraftService.close().catch(error => console.warn('[skill-draft] 退出排空失败:', error.message)).finally(() => {
        skillDraftShutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  if (miniChat && !miniShutdownComplete) {
    event.preventDefault();
    if (!miniShutdownPending) {
      miniShutdownPending = true;
      Promise.resolve(miniChat.shutdown()).catch(error => console.warn('[mini] 保存退出状态失败:', error.message)).finally(() => {
        miniShutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  if (usageStatsService && !usageShutdownComplete) {
    event.preventDefault();
    if (!usageShutdownPending) {
      usageShutdownPending = true;
      Promise.resolve(usageStatsService.destroy()).catch(error => console.warn('[usage] 保存退出状态失败:', error.message)).finally(() => {
        usageShutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  if (taskProgressStore && !progressShutdownComplete) {
    event.preventDefault();
    if (!progressShutdownPending) {
      progressShutdownPending = true;
      flushStreamJournalEvents();
      taskProgressStore.close().catch(error => console.warn('[task-progress] 保存退出进度失败:', error.message)).finally(() => {
        progressShutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  try { if (miniChat) miniChat.destroy(); } catch (_) {}
  try { if (miniHost) miniHost.destroy(); } catch (_) {}
  attachmentDialog.dispose();
  browserPanelTools.dispose();
  try { workspaceTools.dispose(); } catch (e) { console.warn('[workspace] 退出清理失败: %s', e.message); }
  try { interactionBroker.close({ message: 'Relay 正在退出，等待中的操作已安全拒绝', interrupt: true }); }
  catch (e) { console.warn('[interaction] 退出清理失败: %s', e.message); }
  flushStreamJournalEvents();
  flushTaskJournalEvents();
  if (_memoryUsageFlushTimer) flushMemoryUsage();
  try { scheduler.shutdown(); } catch (e) { console.warn('[scheduler] 退出清理失败: %s', e.message); }
  try { if (taskOrchestrator) taskOrchestrator.shutdown(); }
  catch (e) { console.warn('[task-orchestrator] 退出清理失败: %s', e.message); }
  for (const lease of taskResourceLeases.values()) {
    try { lease.release(); } catch (_) {}
  }
  taskResourceLeases.clear();
  interruptActiveShadowRuns('Relay exited before the task completed');
  try { if (taskLedger && typeof taskLedger.flush === 'function') taskLedger.flush(); } catch (_) {}
  for (const [, child] of jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
  jobs.clear();
  for (const sess of [...liveSessions.values()]) killLiveSession(sess, '应用退出');
  try { globalShortcut.unregisterAll(); } catch (_) {}   // 释放全局快捷键,避免残留占用
  try { powerMonitor.removeListener('resume', handlePowerResume); } catch (_) {}
  if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
});
app.on('activate', () => {
  // 有主窗口(可能只是被隐藏)就恢复它;否则按启动逻辑重建
  if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
  else if (BrowserWindow.getAllWindows().length === 0) decideStartup();
});
