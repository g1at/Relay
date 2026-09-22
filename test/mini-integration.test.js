'use strict';

// Actual main mini service/IPC/settings/quit code with synthetic windows and an
// in-memory disk. The production controller and interaction broker run unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createMiniChatController } = require('../src/main/app/mini-chat-controller');
const { InteractionBroker, isAppPermissionMode } = require('../src/main/tasks/interaction-broker');
const { createGeneralPreferences, normalizePreferences } = require('../src/main/app/general-preferences');
const { isQuickChatEnabled, normalizeQuickChatPatch } = require('../src/main/app/mini-window-host');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 80; i++) { if (predicate()) return; await tick(); } assert.fail('Integration did not settle'); };
const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Source block exists: ${start}`);
  return source.slice(from, to);
};
const success = text => ({ type: 'result', subtype: 'success', result: text });

// Load each complete production factory with controlled platform/filesystem
// adapters. No function-body extraction or production user-data access.
function loadFactory(relativeFile, overrides = {}, platform = process) {
  const filename = path.join(__dirname, '..', relativeFile);
  const loaded = { exports: {} }, nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: loaded, process: platform, console, setTimeout, clearTimeout,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name),
  }, { filename });
  return loaded.exports;
}

function harness() {
  const handlers = {}, appEvents = {}, history = new Map(), jobs = new Map(), ledger = new Map(), calls = [];
  const fixtureUserData = path.resolve('/fixture/userData');
  const settingsPath = path.join(fixtureUserData, 'app-settings.json');
  const disk = new Map([[settingsPath, JSON.stringify({ theme: 'light', miniInputEnabled: true, floatingOrbEnabled: true, miniWindowPinned: true })]]);
  const windowFor = (id, name) => {
    const sent = [], backgrounds = [], overlays = [];
    const webContents = { mainFrame: { name: name + '-main' }, send: (channel, payload) => sent.push({ channel, payload: copy(payload) }), isLoadingMainFrame: () => false,
      on() {}, setWindowOpenHandler() {} };
    return { id, name, sent, backgrounds, overlays, webContents, maximized: false, fullScreen: false,
      isDestroyed: () => false, isMaximized() { return this.maximized; }, isFullScreen() { return this.fullScreen; },
      setBackgroundColor: value => backgrounds.push(value), setTitleBarOverlay: value => overlays.push(value),
      once() {}, on() {}, loadFile: async () => {}, setMenuBarVisibility() {} };
  };
  const panel = windowFor(2, 'panel'), orb = windowFor(3, 'orb'), main = windowFor(1, 'main');
  const hostCalls = [];
  let hostOptions, registered = null, shown = 0;
  const readSettings = () => JSON.parse(disk.get(settingsPath));
  const host = {
    getPanelWindow: () => panel, getOrbWindow: () => orb,
    isPanelSender: sender => sender === panel.webContents,
    ownsWebContents: sender => sender === panel.webContents || sender === orb.webContents,
    getState: () => ({ pinned: readSettings().miniWindowPinned !== false, panelVisible: true, orbVisible: true }),
    hide: () => { hostCalls.push(['hide']); return { ok: true }; },
    resize: (height, options) => { hostCalls.push(['resize', height, options]); return { ok: true }; },
    setPinned: value => { hostCalls.push(['pin', value]); return { ok: true }; },
    toggle: input => { hostCalls.push(['toggle', input]); return { ok: true }; },
    orbDrag: input => { hostCalls.push(['drag', input]); return { ok: true }; },
    showContextMenu: () => { hostCalls.push(['menu']); return { ok: true }; },
    syncSettings: () => { calls.push(['syncSettings', readSettings()]); return { ok: true }; },
    destroy: () => { calls.push(['hostDestroy']); },
  };
  const context = {
    __dirname: '/fixture/relay', appRoot: '/fixture/relay', path, pathToFileURL: require('node:url').pathToFileURL,
    Promise, Object, setTimeout, clearTimeout, process: { platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    require: name => {
      if (name === './app/mini-local-images') return require('../src/main/app/mini-local-images');
      assert.equal(name, 'electron');
      return { screen: {} };
    },
    Menu: {}, mainWindow: main, readAppSettings: readSettings,
    isQuickChatEnabled, normalizeQuickChatPatch,
    normalizePreferences, generalPreferences: createGeneralPreferences({ getSettings: readSettings }),
    appSettingsPath: () => settingsPath,
    appSettingsCache: { invalidate: () => calls.push(['settingsCacheInvalidated']) },
    fs: {
      existsSync: filename => filename.startsWith('/history/') ? history.has(filename.slice(9)) : filename === fixtureUserData || disk.has(filename),
      mkdirSync: () => {}, writeFileSync: (filename, data) => { disk.set(filename, data); calls.push(['writeTemp', filename]); },
      renameSync: (from, to) => { disk.set(to, disk.get(from)); disk.delete(from); calls.push(['settingsPersisted', readSettings()]); },
    },
    convFilePath: id => '/history/' + id,
    loadConversation: id => copy(history.get(id)), projectConversation: record => record,
    saveConversation: record => { history.set(record.id, copy(record)); calls.push(['historySave', record.turns.at(-1).status]); },
    createMiniChatController,
    providerStore: { getRoutingView: () => ({ defaultModel: 'opus' }) },
    activeRelayProviderRuntime: ({ tier }) => ({ id: 'fixture-provider', revision: 1, tier }),
    providerSessionRoute: runtime => ({ providerId: runtime.id, providerRevision: runtime.revision, routeTier: runtime.tier }),
    runClaudeRequest: (event, request) => {
      assert.equal(event.miniChat, true);
      const managed = '/fixture/RelayProjects/' + request.convId;
      const record = history.get(request.convId); record.workingDir = { path: managed, name: 'managed' };
      history.set(record.id, record);
      ledger.set(request.runId, { runId: request.runId, source: { type: 'mini', conversationId: request.convId }, state: 'running' });
      jobs.set(request.runId, { request, emit: value => event.sender.send('claude:event', { jobId: request.runId, ...value }) });
      return { jobId: request.runId, providerId: 'fixture-provider', providerRevision: 1, routeTier: request.model, workingDir: managed };
    },
    pauseClaudeJob: async id => { calls.push(['pause', id]); return { paused: true, settled: true }; },
    steerLiveTurn: request => { calls.push(['steer', request]); return { ok: false, message: 'synthetic executor has no supplements' }; },
    createMiniWindowHost: options => { hostOptions = options; return host; },
    showMainWindow: () => { shown++; }, brandLogoDataUrl: () => null,
    globalShortcut: {
      register: accelerator => { registered = accelerator; calls.push(['register', readSettings()]); return true; },
      unregister: () => { registered = null; calls.push(['unregister', readSettings()]); },
      unregisterAll: () => calls.push(['unregisterAll']),
    },
    refreshTrayMenu: () => {},
    updateNativeBrandTheme: () => calls.push(['nativeBrandTheme', readSettings()]),
    taskLedger: {
      get: id => ledger.get(id),
      list: filter => [...ledger.values()].filter(run => filter && filter.terminal === false
        ? !['complete', 'failed', 'canceled', 'succeeded'].includes(run.state) : true),
      update: (id, patch) => { ledger.set(id, { ...ledger.get(id), ...patch }); }, flush: () => calls.push(['ledgerFlush']),
    },
    isTerminalState: state => ['complete', 'failed', 'canceled', 'succeeded'].includes(state),
    RUN_STATES: { WAITING_USER: 'waiting_user', RUNNING: 'running' },
    cancelTaskByRunId: async () => {},
    ipcMain: { on() {}, handle: (channel, callback) => { assert.equal(handlers[channel], undefined, channel); handlers[channel] = callback; } },
    BrowserWindow: { getAllWindows: () => [main, panel, orb], fromWebContents: sender => [main, panel, orb].find(window => window.webContents === sender) },
    MAIN_WINDOW_CHROME_HEIGHT: 36, nativeTheme: { themeSource: 'light', get shouldUseDarkColors() { return this.themeSource === 'dark'; } },
    isAppPermissionMode, applyPermissionModeToLiveSessions: async () => ({}),
    isQuitting: false, _memoryUsageFlushTimer: null, flushMemoryUsage() {},
    usageStatsService: null, usageShutdownPending: false, usageShutdownComplete: false,
    skillDraftService: null, skillDraftShutdownPending: false, skillDraftShutdownComplete: false,
    taskProgressStore: null, progressShutdownPending: false, progressShutdownComplete: false,
    app: { whenReady: () => ({ then() {} }), on: (event, callback) => { appEvents[event] = callback; }, quit: () => { calls.push(['quit']); appEvents['before-quit']({ preventDefault: () => calls.push(['preventQuit']) }); } },
    attachmentDialog: { dispose: () => calls.push(['attachmentDispose']) }, browserPanelTools: { dispose() {} }, workspaceTools: { dispose() {} },
    flushStreamJournalEvents() {}, flushTaskJournalEvents() {}, scheduler: { shutdown() {} }, taskOrchestrator: null,
    taskResourceLeases: new Map(), interruptActiveShadowRuns() {}, jobs: new Map(), liveSessions: new Map(),
    killLiveSession() {}, powerMonitor: { removeListener() {} }, handlePowerResume() {}, tray: null,
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context);
  vm.runInContext(between('let miniHost = null;', 'let cachedRelayGitBashPath;'), context);
  vm.runInContext('function refreshMiniBrand() { miniBrandCache = null; if (miniHost) publishMiniState(); }', context);
  const settings = loadFactory('src/main/app/app-settings-service.js', {
    fs: context.fs, './app-settings-cache': { createAppSettingsCache: () => context.appSettingsCache },
  }).createAppSettingsService({ getUserDataDir: () => fixtureUserData, providerStore: context.providerStore, onWrite: context.refreshMiniBrand });
  context.writeAppSettings = settings.writeAppSettings;
  const MockWindow = Object.assign(function MockWindow() { return main; }, context.BrowserWindow);
  const windows = loadFactory('src/main/app/application-windows.js', {
    fs: context.fs, './paths': { appRoot: context.appRoot },
  }, context.process).createApplicationWindows({
    electron: {
      app: context.app, BrowserWindow: MockWindow, ipcMain: context.ipcMain, shell: {},
      Tray: class { on() {} setContextMenu() {} setToolTip() {} destroy() {} },
      Menu: { buildFromTemplate: value => value }, nativeTheme: context.nativeTheme,
      nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
    },
    logger: context.console, settings: { read: readSettings, write: context.writeAppSettings },
    providers: { store: context.providerStore },
    tasks: { runningCount: () => 0, waitingInteractions: () => [], nextScheduledHint: () => null,
      refreshBadge() {}, scheduleRetention() {}, rejectWindow() {} },
    mini: { shortcut: () => registered, getHost: () => context.getMiniWindowHost(),
      getExistingHost: () => vm.runInContext('miniHost', context) },
    browser: {}, startup: {}, HAS_SINGLE_INSTANCE_LOCK: false,
  });
  context.applicationWindows = windows;
  windows.createMainWindow();
  context.syncMainWindowChromeAppearance = windows.syncMainWindowChromeAppearance;
  const settingsWindows = { applyTheme: windows.applyTheme, updateNativeBrandTheme: context.updateNativeBrandTheme };
  loadFactory('src/main/app/settings-ipc.js').registerSettingsIpc({
    ipcMain: context.ipcMain, app: context.app, providerStore: context.providerStore,
    readAppSettings: readSettings, writeAppSettings: context.writeAppSettings,
    generalPreferences: context.generalPreferences, windows: settingsWindows,
    applyParallelTaskLimit() {}, publishProviderChange() {}, onEnvironmentChanged() {},
    onQuickChatChanged: () => { context.registerMiniShortcut(); context.getMiniWindowHost().syncSettings(); context.refreshTrayMenu(); },
    refreshMiniBrand: context.refreshMiniBrand,
  });
  vm.runInContext(between("ipcMain.handle('mini:brand'", "ipcMain.handle('brand:setName'"), context);
  loadFactory('src/main/app/history-ipc.js', { fs: context.fs }).registerHistoryIpc({
    ipcMain: context.ipcMain,
    history: { loadConversation: context.loadConversation, convFilePath: context.convFilePath },
    projects: { projectConversation: context.projectConversation }, nativeHistory: {},
    isMiniChatActive: id => vm.runInContext('miniChat', context)?.isRunning() && context.getMiniChat().getConversationId() === id,
    saveConversation: context.saveConversation, protectSdkMetadata: context.protectSdkMetadata,
    deleteConversation: id => history.delete(id), genId: () => 'synthetic-new-id',
  });
  vm.runInContext(between('function emitInteractionChange(event)', 'const interactionBroker ='), context);
  const broker = context.interactionBroker = new InteractionBroker({ onChange: event => context.emitInteractionChange(event), logger: context.console });
  vm.runInContext(between('function interactionCallerWindowId(event)', "ipcMain.handle('checkpoints:get'"), context);
  loadFactory('src/main/app/application-lifecycle.js').registerApplicationLifecycle({
    app: context.app, BrowserWindow: context.BrowserWindow, nativeTheme: context.nativeTheme,
    powerMonitor: context.powerMonitor, globalShortcut: context.globalShortcut, windows,
    settings: {}, history: {}, scheduler: context.scheduler,
    getSkillDraftService: () => context.skillDraftService,
    getExistingUsageStatsService: () => context.usageStatsService,
    taskRuntime: {
      jobs: context.jobs, liveSessions: context.liveSessions, resourceLeases: context.taskResourceLeases,
      interactions: broker, getProgressStore: () => context.taskProgressStore,
      getOrchestrator: () => context.taskOrchestrator, getLedger: () => context.taskLedger,
      killLiveSession: context.killLiveSession, interruptActiveRuns: context.interruptActiveShadowRuns,
      flushStreams: context.flushStreamJournalEvents, flushEvents: context.flushTaskJournalEvents,
    },
    mini: { getChat: () => vm.runInContext('miniChat', context), getHost: () => vm.runInContext('miniHost', context) },
    memory: { hasPendingUsage: () => !!context._memoryUsageFlushTimer, flushUsage: context.flushMemoryUsage },
    integrations: { attachmentDialog: context.attachmentDialog, browserPanelTools: context.browserPanelTools, workspaceTools: context.workspaceTools },
  });
  context.getMiniWindowHost();
  const invoke = (channel, window = panel, payload, frame = window.webContents.mainFrame) => handlers[channel]({ sender: window.webContents, senderFrame: frame }, payload);
  const finish = async (id, text) => {
    const job = jobs.get(id);
    ledger.set(id, { ...ledger.get(id), state: 'succeeded' });
    job.emit(success(text)); job.emit({ type: 'job-done', exitCode: 0, finalResult: success(text) });
    await waitFor(() => !context.getMiniChat().isRunning());
  };
  return { context, panel, orb, main, host, hostCalls, calls, history, jobs, ledger, broker, invoke, finish, appEvents,
    readSettings, get registered() { return registered; }, get shown() { return shown; }, get hostOptions() { return hostOptions; },
    close: async () => { await context.getMiniChat().shutdown(); broker.close(); } };
}

test('authenticated mini submission streams and completes inline, then resumes the same saved conversation', async () => {
  const h = harness();
  assert.equal((await h.invoke('mini:state')).model, 'opus');
  const sent = await h.invoke('mini:submit', h.panel, { text: '第一轮' });
  assert.equal(sent.ok, true); assert.equal(h.shown, 0);
  const job = h.jobs.get(sent.runId);
  job.emit({ type: 'system', subtype: 'init', session_id: 'mini-native' });
  job.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**正在回复**' } } });
  assert.equal((await h.invoke('mini:state')).conversation.turns[0].preview, '**正在回复**');
  await h.finish(sent.runId, '**完成**');
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, '**完成**');
  const next = await h.invoke('mini:submit', h.panel, '第二轮');
  assert.equal(next.conversationId, sent.conversationId);
  assert.equal(h.jobs.get(next.runId).request.sessionId, 'mini-native');
  assert.equal(h.jobs.get(next.runId).request.taskContext.turnRef.index, 1);
  assert.equal(h.shown, 0);
  await h.finish(next.runId, '第二轮完成');
  assert.equal(h.history.get(sent.conversationId).turns.length, 2);
  assert.equal(h.main.sent.some(item => item.channel === 'claude:event'), false);
  assert.equal(h.orb.sent.some(item => item.payload.conversation), false, 'orb receives no private transcript');
  await h.close();
});

test('main/orb/foreign frame cannot submit, pause or resize the quick conversation', async () => {
  const h = harness();
  for (const window of [h.main, h.orb]) {
    for (const channel of ['mini:submit', 'mini:pause', 'mini:resize', 'mini:newChat', 'mini:setPinned', 'mini:openMain']) {
      assert.equal((await h.invoke(channel, window, { text: 'forged', height: 999 })).ok, false, channel);
    }
  }
  for (const channel of ['mini:submit', 'mini:pause', 'mini:resize']) {
    assert.equal((await h.invoke(channel, h.panel, { text: 'iframe', height: 999 }, {})).ok, false);
  }
  assert.equal(h.history.size, 0); assert.equal(h.jobs.size, 0); assert.equal(h.hostCalls.length, 0); assert.equal(h.shown, 0);
  assert.equal((await h.invoke('mini:resize', h.panel, { height: 460, reducedMotion: true })).ok, true);
  assert.deepEqual(copy(h.hostCalls[0]), ['resize', 460, { reduceMotion: true }]);
  await h.close();
});

test('orb has visibility-only controls and private conversation access stays panel-only', async () => {
  const h = harness();
  assert.equal(h.invoke('mini:toggle', h.main).ok, false);
  assert.equal(h.invoke('mini:toggle', h.panel).ok, false);
  assert.equal(h.invoke('mini:toggle', h.orb, null, {}).ok, false);
  assert.equal(h.invoke('mini:toggle', h.orb).ok, true);
  assert.equal((await h.invoke('mini:state', h.orb)).conversation, undefined);
  assert.equal((await h.invoke('mini:state', h.main)).ok, false);
  assert.equal(h.invoke('mini:orbDrag', h.panel, {}).ok, false);
  assert.equal(h.invoke('mini:orbDrag', h.orb, { phase: 'start' }).ok, true);
  await h.close();
});

test('orb-only startup and state requests never initialize a chat controller', async () => {
  const h = harness();
  h.host.getPanelWindow = () => null;
  const getMiniChat = h.context.getMiniChat;
  h.context.getMiniChat = () => { throw Error('orb must not initialize private chat state'); };
  h.context.publishMiniState();
  assert.equal(h.orb.sent.at(-1).payload.running, false);
  assert.equal(h.orb.sent.at(-1).payload.brand.name, 'Relay');
  assert.equal((await h.invoke('mini:state', h.orb)).running, false);
  assert.equal(h.panel.sent.length, 0);
  h.context.getMiniChat = getMiniChat;
  await h.close();
});

test('orb-only updates retain a running chat without copying its transcript', async () => {
  const h = harness();
  const sent = await h.invoke('mini:submit', h.panel, 'keep running');
  const controller = h.context.getMiniChat();
  const state = controller.state;
  controller.state = () => { throw Error('orb must not clone the transcript'); };
  h.host.getPanelWindow = () => null;
  h.context.publishMiniState();
  assert.equal(h.orb.sent.at(-1).payload.running, true);
  assert.equal(h.orb.sent.at(-1).payload.conversation, undefined);
  controller.state = state;
  await h.finish(sent.runId, 'completed while hidden');
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, 'completed while hidden');
  assert.equal(h.orb.sent.at(-1).payload.running, false);
  await h.close();
});

test('mini approvals belong to its panel, route there and reject other windows before broker settlement', async () => {
  const h = harness();
  const sent = await h.invoke('mini:submit', h.panel, { text: '需要确认的操作' });
  assert.equal(h.context.miniInteractionWindowId(sent.runId), h.panel.id);
  const allow = h.broker.createCanUseTool(() => ({ runId: sent.runId, conversationId: sent.conversationId,
    windowId: h.context.miniInteractionWindowId(sent.runId), source: 'conversation' }));
  const pending = allow('Bash', { command: 'echo fixture' }, { requestId: 'fixture-approval', toolUseID: 'tool-fixture' });
  const items = h.invoke('interactions:list', h.panel).items;
  assert.equal(items.length, 1);
  assert.equal(h.invoke('interactions:list', h.main).items.length, 0);
  assert.equal(h.invoke('interactions:list', h.orb).items.length, 0);
  assert.equal(h.panel.sent.filter(item => item.channel === 'interactions:event').length, 1);
  assert.equal(h.main.sent.filter(item => item.channel === 'interactions:event').length, 0);
  const decision = { id: items[0].id, decision: { action: 'allow_once' } };
  assert.equal(h.invoke('interactions:respond', h.main, decision).ok, false);
  assert.equal(h.invoke('interactions:respond', h.orb, decision).ok, false);
  assert.equal(h.broker.size, 1);
  assert.equal(h.invoke('interactions:respond', h.panel, decision).ok, true);
  assert.equal((await pending).behavior, 'allow');
  assert.equal(h.broker.size, 0);
  await h.finish(sent.runId, '确认后完成');
  await h.close();
});

test('openMain waits for main readiness, then returns the exact completed conversation once', async () => {
  const h = harness();
  const sent = await h.invoke('mini:submit', h.panel, { text: '保留同一对话' });
  assert.equal((await h.invoke('mini:openMain')).ok, false); assert.equal(h.shown, 0);
  await h.finish(sent.runId, 'done');
  assert.equal((await h.invoke('mini:openMain')).ok, true); assert.equal(h.shown, 1);
  assert.equal(h.main.sent.filter(item => item.channel === 'mini:open-conversation').length, 0);
  assert.equal(h.invoke('mini:mainReady', h.orb).ok, false);
  assert.equal(h.invoke('mini:mainReady', h.main).id, sent.conversationId);
  assert.equal(h.invoke('mini:mainReady', h.main).id, null);
  assert.equal(h.history.size, 1);
  await h.close();
});

test('an already-ready main receives one immediate conversation event without a later duplicate', async () => {
  const h = harness();
  h.invoke('mini:mainReady', h.main);
  const sent = await h.invoke('mini:submit', h.panel, { text: 'ready main' });
  await h.finish(sent.runId, 'done');
  await h.invoke('mini:openMain');
  const events = h.main.sent.filter(item => item.channel === 'mini:open-conversation');
  assert.equal(events.length, 1); assert.equal(events[0].payload.id, sent.conversationId);
  assert.equal(h.invoke('mini:mainReady', h.main).id, null);
  await h.close();
});

for (const state of ['floating', 'maximized', 'fullScreen']) {
test(`settings persist atomically and preserve opaque main and independent mini backgrounds (${state})`, async () => {
  const h = harness();
  if (state !== 'floating') h.main[state] = true;
  h.context.registerMiniShortcut(); assert.equal(h.registered, 'Alt+Space');
  h.calls.length = 0;
  const result = await h.invoke('settings:write', h.main, { app: { theme: 'dark', miniInputEnabled: false, floatingOrbEnabled: false } });
  assert.equal(result.ok, true); assert.equal(h.registered, null);
  const persisted = h.calls.findIndex(call => call[0] === 'settingsPersisted');
  const invalidated = h.calls.findIndex(call => call[0] === 'settingsCacheInvalidated');
  const unregistered = h.calls.findIndex(call => call[0] === 'unregister');
  const synced = h.calls.findIndex(call => call[0] === 'syncSettings');
  const themed = h.calls.findIndex(call => call[0] === 'nativeBrandTheme');
  assert.ok(persisted >= 0 && unregistered > persisted && synced > persisted);
  assert.ok(invalidated > persisted && invalidated < synced, 'published settings cannot use the previous cached snapshot');
  assert.ok(themed > persisted);
  assert.equal(h.calls[themed][1].theme, 'dark');
  assert.equal(h.calls[synced][1].floatingOrbEnabled, false);
  assert.equal(h.calls[unregistered][1].miniInputEnabled, false);
  assert.deepEqual(h.main.backgrounds, ['#1a1a1a']);
  assert.equal(h.main.overlays.at(-1).color, '#1a1a1a');
  assert.deepEqual(h.panel.backgrounds, []); assert.deepEqual(h.orb.backgrounds, []);
  assert.equal((await h.invoke('mini:state')).brand.theme, 'dark');
  await h.close();
});
}

test('saving or reverting a theme retains opaque backing and search shade in every window state', async () => {
  const h = harness();
  h.context.syncMainWindowChromeAppearance(h.main, { dark: false, searchOpen: true });
  for (const state of ['floating', 'maximized', 'fullScreen']) {
    if (state !== 'floating') h.main[state] = true;
    for (const theme of ['dark', 'light']) {
      // The saved selection supersedes a different live preview without
      // clearing the open search shade or changing mini-window backgrounds.
      h.context.syncMainWindowChromeAppearance(h.main, { dark: theme !== 'dark', searchOpen: true });
      assert.equal((await h.invoke('settings:write', h.main, { app: { theme } })).ok, true);
      assert.equal(h.main.backgrounds.at(-1), theme === 'dark' ? '#1a1a1a' : '#fafafa');
      assert.equal(h.main.overlays.at(-1).color, theme === 'dark' ? '#0f0f0f' : '#919191');
    }
    if (state !== 'floating') h.main[state] = false;
  }
  h.context.syncMainWindowChromeAppearance(h.main, { dark: true, searchOpen: false });
  await h.invoke('settings:write', h.main, { app: { theme: 'light' } });
  assert.equal(h.main.backgrounds.at(-1), '#fafafa');
  assert.equal(h.main.overlays.at(-1).color, '#fafafa');
  assert.ok(h.main.backgrounds.every(value => value === '#fafafa' || value === '#1a1a1a'));
  assert.deepEqual(h.panel.backgrounds, []);
  assert.deepEqual(h.orb.backgrounds, []);
  await h.close();
});

test('before-quit waits for one interrupted history save before destroying windows and executors', async () => {
  const h = harness();
  const sent = await h.invoke('mini:submit', h.panel, { text: 'quit while working' });
  h.jobs.get(sent.runId).emit({ type: 'assistant', message: { id: 'work', content: [{ type: 'text', text: 'unfinished process' }] } });
  let prevented = 0;
  h.appEvents['before-quit']({ preventDefault: () => { prevented++; } });
  h.appEvents['before-quit']({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(h.calls.some(call => call[0] === 'hostDestroy'), false);
  await waitFor(() => h.calls.some(call => call[0] === 'hostDestroy'));
  const interrupted = h.calls.findIndex(call => call[0] === 'historySave' && call[1] === 'interrupted');
  const cleanup = h.calls.findIndex(call => call[0] === 'hostDestroy');
  assert.ok(interrupted >= 0 && cleanup > interrupted);
  assert.equal(h.calls.filter(call => call[0] === 'quit').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'hostDestroy').length, 1);
  assert.equal(h.history.get(sent.conversationId).turns[0].status, 'interrupted');
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, '');
  await h.close();
});

test('before-quit saves interrupted mini history before flushing usage and only then destroys windows', async () => {
  const h = harness();
  const sent = await h.invoke('mini:submit', h.panel, { text: 'quit with usage pending' });
  let finishUsage;
  h.context.usageStatsService = {
    destroy() {
      h.calls.push(['usageDestroy']);
      return new Promise(resolve => { finishUsage = resolve; });
    },
  };
  h.appEvents['before-quit']({ preventDefault() {} });
  await waitFor(() => !!finishUsage);
  const saved = h.calls.findIndex(call => call[0] === 'historySave' && call[1] === 'interrupted');
  const flushed = h.calls.findIndex(call => call[0] === 'usageDestroy');
  assert.ok(saved >= 0 && flushed > saved);
  assert.equal(h.calls.some(call => call[0] === 'hostDestroy'), false);
  h.appEvents['before-quit']({ preventDefault() {} });
  assert.equal(h.calls.filter(call => call[0] === 'usageDestroy').length, 1);
  finishUsage();
  await waitFor(() => h.calls.some(call => call[0] === 'hostDestroy'));
  assert.equal(h.calls.filter(call => call[0] === 'hostDestroy').length, 1);
  assert.equal(h.history.get(sent.conversationId).turns[0].status, 'interrupted');
  await h.close();
});

test('before-quit waits for a single durable process checkpoint before disposing the app', async () => {
  const h = harness();
  let finish, closes = 0;
  h.context.taskProgressStore = { close: () => { closes++; return new Promise(resolve => { finish = resolve; }); } };
  h.appEvents['before-quit']({ preventDefault() {} });
  await waitFor(() => !!finish);
  h.appEvents['before-quit']({ preventDefault() {} });
  assert.equal(closes, 1);
  assert.equal(h.calls.some(call => call[0] === 'hostDestroy'), false);
  finish();
  await waitFor(() => h.calls.some(call => call[0] === 'hostDestroy'));
  assert.equal(closes, 1);
  assert.equal(h.calls.filter(call => call[0] === 'hostDestroy').length, 1);
  await h.close();
});

test('retained mini cannot take ownership from an active main turn, including its pre-admission placeholder', async () => {
  for (const owner of ['live', 'ledger', 'placeholder']) {
    const h = harness();
    const sent = await h.invoke('mini:submit', h.panel, { text: 'start in mini' });
    await h.finish(sent.runId, 'mini completed');
    const mainRunId = '00000000-0000-4000-8000-000000000099';
    const record = copy(h.history.get(sent.conversationId));
    record.turns.push({ user: 'continue in main', assistant: '', runId: mainRunId, ts: '2026-09-08T02:00:00.000Z',
      ...(owner === 'placeholder' ? {} : { status: 'running' }) });
    assert.equal(h.invoke('history:save', h.main, record).id, sent.conversationId);
    if (owner === 'live') h.context.liveSessions.set(record.id, { busy: true, jobId: mainRunId });
    if (owner === 'ledger') h.ledger.set(mainRunId, { runId: mainRunId, state: 'running', source: { type: 'conversation', conversationId: record.id } });
    const writes = h.calls.filter(call => call[0] === 'historySave').length;
    const rejected = await h.invoke('mini:submit', h.panel, { text: 'must stay a draft' });
    assert.equal(rejected.ok, false, owner);
    assert.equal(rejected.code, 'MAIN_TURN_ACTIVE', owner);
    assert.equal(h.calls.filter(call => call[0] === 'historySave').length, writes, owner);
    assert.equal(h.context.getMiniChat().isRunning(), false, owner);
    assert.equal(h.history.get(record.id).turns.length, 2, owner);
    // Since mini never stole ownership, the main renderer can still save its
    // final answer through the actual guarded history handler.
    record.turns[1].assistant = 'main final answer';
    record.turns[1].status = 'complete';
    record.sessionId = 'main-native'; record.sessionModel = 'opus';
    record.sessionProviderId = 'fixture-provider'; record.sessionProviderRevision = 1; record.sessionRouteTier = 'opus';
    const completed = h.invoke('history:save', h.main, record);
    assert.equal(completed.error, undefined, owner);
    assert.equal(completed.id, record.id, owner);
    h.context.liveSessions.delete(record.id);
    if (owner === 'ledger') h.ledger.set(mainRunId, { ...h.ledger.get(mainRunId), state: 'succeeded' });
    const resumed = await h.invoke('mini:submit', h.panel, { text: 'back to mini' });
    assert.equal(resumed.ok, true, owner);
    assert.equal(resumed.conversationId, record.id, owner);
    assert.equal(h.jobs.get(resumed.runId).request.sessionId, 'main-native', owner);
    assert.equal((await h.invoke('mini:state')).conversation.turns[1].assistant, 'main final answer', owner);
    assert.equal(h.history.get(record.id).turns.length, 3, owner);
    await h.finish(resumed.runId, 'mini continues');
    await h.close();
  }
});

test('openMain retries failed terminal persistence and never reveals an empty disk placeholder as the answer', async () => {
  const h = harness();
  const save = h.context.saveConversation;
  let unavailable = true;
  h.context.saveConversation = record => {
    if (record.turns.at(-1).status === 'complete' && unavailable) throw Error('temporary disk failure');
    return save(record);
  };
  const sent = await h.invoke('mini:submit', h.panel, { text: 'preserve before opening' });
  await h.finish(sent.runId, 'only answer in mini memory');
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, '');
  assert.equal((await h.invoke('mini:openMain')).ok, false);
  assert.equal(h.shown, 0);
  assert.equal((await h.invoke('mini:state')).conversation.turns[0].assistant, 'only answer in mini memory');
  unavailable = false;
  assert.equal((await h.invoke('mini:openMain')).ok, true);
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, 'only answer in mini memory');
  assert.equal(h.history.get(sent.conversationId).turns[0].saveError, undefined);
  assert.equal(h.shown, 1);
  assert.equal(h.invoke('mini:mainReady', h.main).id, sent.conversationId);
  await h.close();
});


test('one quick-chat preference hides both entrances and reenables Alt+Space without cancelling an active turn', async () => {
  const h = harness();
  h.context.registerMiniShortcut(); assert.equal(h.registered, 'Alt+Space');
  const sent = await h.invoke('mini:submit', h.panel, { text: 'continue while quick-chat is hidden' });
  assert.equal(h.context.getMiniChat().isRunning(), true);
  const disabled = await h.invoke('settings:write', h.main, { app: { quickChatEnabled: false } });
  assert.equal(disabled.ok, true); assert.equal(h.registered, null);
  for (const key of ['quickChatEnabled', 'miniInputEnabled', 'floatingOrbEnabled']) assert.equal(h.readSettings()[key], false);
  assert.equal(h.invoke('mini:brand').enabled, false);
  assert.equal(h.context.getMiniChat().isRunning(), true);
  assert.equal(h.calls.some(call => call[0] === 'pause'), false);
  const enabled = await h.invoke('settings:write', h.main, { app: { quickChatEnabled: true } });
  assert.equal(enabled.ok, true); assert.equal(h.registered, 'Alt+Space');
  for (const key of ['quickChatEnabled', 'miniInputEnabled', 'floatingOrbEnabled']) assert.equal(h.readSettings()[key], true);
  assert.equal(h.invoke('mini:brand').enabled, true);
  assert.equal(h.context.getMiniChat().getConversationId(), sent.conversationId);
  await h.finish(sent.runId, 'finished after the setting changed');
  assert.equal(h.history.get(sent.conversationId).turns[0].assistant, 'finished after the setting changed');
  const invalid = await h.invoke('settings:write', h.main, { app: { quickChatEnabled: 'false' } });
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'INVALID_SETTING');
  assert.equal(h.registered, 'Alt+Space');
  await h.close();
});
