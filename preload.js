// preload.js — 把 IPC 安全暴露给 renderer
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Display metadata and a restricted theme preview; native window controls do
  // not need renderer-accessible minimize/maximize/close methods.
  windowChrome: {
    overlay: process.platform === 'win32' && process.argv.includes('--relay-window-chrome-overlay'),
    initialTheme: process.argv.includes('--relay-window-chrome-theme=dark') ? 'dark' : 'light',
    setTheme: (theme, searchOpen = false) => {
      if ((theme !== 'light' && theme !== 'dark') || typeof searchOpen !== 'boolean') return;
      if (searchOpen) ipcRenderer.send('window-chrome:theme', theme, true);
      else ipcRenderer.send('window-chrome:theme', theme);
    },
  },
  // 启动一次 Claude 对话(prompt 文本,可选 sessionId 续接,mode='agent'|'plain',
  //   model='haiku'|'sonnet'|'opus',agentName=选中的子智能体名(agent 模式用))
  //   orchestrateAgents=协同模式下用户勾选的子智能体 name 数组(可空=全量交 PM 自选)
  //   convId=会话 id：主进程据它复用该对话的常驻 claude 进程(MCP 不必每轮重启)。
  //     不传也能跑 —— 主进程会回退到每轮新起进程的老行为。
  runClaude: (prompt, sessionId, mode, files, model, effort, agentName, workingDir, orchestrateAgents, convId, forceFreshSession, runId, sourceConvId, taskContext, sessionRoute, executionMode) =>
    ipcRenderer.invoke('claude:run', { prompt, sessionId, sessionRoute, mode, files, model, effort, agentName, workingDir, orchestrateAgents, convId, forceFreshSession, runId, sourceConvId, taskContext, executionMode }),

  // Add user context to the current live task without interrupting its work.
  steerClaude: (input) => ipcRenderer.invoke('claude:steer', input),

  // 预启动该对话的常驻 claude 进程(打开/切换对话时调,fire-and-forget)。
  //   目的:让 MCP 在用户打字的这几秒里连好,首轮就能拿到完整工具列表。失败完全无害。
  prespawnClaude: (convId, sessionId, mode, model, effort, agentName, workingDir, sessionRoute) =>
    ipcRenderer.invoke('claude:prespawn', { convId, sessionId, sessionRoute, mode, model, effort, agentName, workingDir }),

  // 丢弃该对话的常驻进程 + 已记住的 session_id(降级重跑前调,避免拿坏 session 再续接)
  dropClaudeSession: (convId) => ipcRenderer.invoke('claude:dropSession', convId),
  // 新建 Claude session 重新加载 MCP；Relay 会在下一条消息中带入历史上下文。
  resetClaudeSession: (convId, mode, model, effort, workingDir) =>
    ipcRenderer.invoke('claude:resetSession', { convId, mode, model, effort, workingDir }),
  stopClaudeTask: input => ipcRenderer.invoke('claude:stopTask', input),
  backgroundClaudeTask: input => ipcRenderer.invoke('claude:backgroundTask', input),
  reloadClaudePlugins: () => ipcRenderer.invoke('claude:reloadPlugins'),
  openClaudeTaskResource: input => ipcRenderer.invoke('claude:openTaskResource', input),
  claudeContextDetails: convId => ipcRenderer.invoke('claude:contextDetails', convId),
  claudeRuntimeInfo: (convId, options) => ipcRenderer.invoke('claude:runtimeInfo', convId, options),
  claudeClearContext: input => ipcRenderer.invoke('claude:clearContext', input),
  claudeCommands: convId => ipcRenderer.invoke('claude:commands', convId),
  claudeApplyRuntimeFlags: convId => ipcRenderer.invoke('claude:applyRuntimeFlags', convId),
  setClaudeRuntime: (convId, model, effort) =>
    ipcRenderer.invoke('claude:setRuntime', { convId, model, effort }),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openAttachmentDialog: (input) => ipcRenderer.invoke('dialog:openAttachments', input),
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: (input) => ipcRenderer.invoke('projects:add', input),
    rename: (input) => ipcRenderer.invoke('projects:rename', input),
    assign: (input) => ipcRenderer.invoke('projects:assign', input),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    open: (id) => ipcRenderer.invoke('projects:open', id),
  },

  // Electron 32 起 File.path 被移除,拖拽文件须用 webUtils 取真实磁盘路径
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // 中止任务(按 jobId 杀单个;不传则杀全部)
  abortClaude: (jobId) => ipcRenderer.invoke('claude:abort', jobId),
  // Interrupt the selected turn, preserving its conversation for a later input.
  pauseClaude: (jobId) => ipcRenderer.invoke('claude:pause', jobId),

  // 让快模型给对话起个简短标题(历史侧边栏摘要)
  summarizeTitle: (text) => ipcRenderer.invoke('claude:title', { text }),

  // 探测环境
  probeEnv: () => ipcRenderer.invoke('env:probe'),

  // Relay 应用自更新(见 updater.js)。主进程只自动「检查」,
  // 下载与安装都由这里的 download / quitAndInstall 显式触发。
  relayUpdate: {
    status: () => ipcRenderer.invoke('relay:updateStatus'),           // 当前状态快照
    check: () => ipcRenderer.invoke('relay:checkUpdate'),             // 手动触发检查
    download: () => ipcRenderer.invoke('relay:downloadUpdate'),       // 用户确认后开始下载
    dismiss: () => ipcRenderer.invoke('relay:dismissUpdate'),         // 「稍后」:压掉气泡
    quitAndInstall: () => ipcRenderer.invoke('relay:quitAndInstall'), // 重启安装(ready 时)
    onEvent: (handler) => {                                           // 状态变化推送
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('relay:update-event', listener);
      return () => ipcRenderer.removeListener('relay:update-event', listener);
    },
  },

  // 打开链接（网页遵循浏览器设置；保留旧 API 名称供已有界面使用）
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // Browser controls are available only to Relay's trusted main document.
  browser: {
    invoke: (input) => ipcRenderer.invoke('browser:invoke', input),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('browser:event', listener);
      return () => ipcRenderer.removeListener('browser:event', listener);
    },
  },

  generalPreferences: {
    get: (options) => ipcRenderer.invoke('generalPreferences:get', options || {}),
    pickWorkspaceRoot: () => ipcRenderer.invoke('generalPreferences:pickWorkspaceRoot'),
    diagnostics: input => ipcRenderer.invoke('generalPreferences:diagnostics', input || {}),
  },

  // 工作目录文件与交互终端；主进程校验窗口身份及文件边界。
  workspace: {
    onRuntimeChanged: handler => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('workspace:runtime-changed', listener);
      return () => ipcRenderer.removeListener('workspace:runtime-changed', listener);
    },
    resolve: (context) => ipcRenderer.invoke('workspace:resolve', context || {}),
    list: (options) => ipcRenderer.invoke('workspace:list', options || {}),
    read: (options) => ipcRenderer.invoke('workspace:read', options || {}),
    open: (options) => ipcRenderer.invoke('workspace:open', options || {}),
    resolveLink: options => ipcRenderer.invoke('workspace:resolveLink', options || {}),
    readLink: options => ipcRenderer.invoke('workspace:readLink', options || {}),
    openLink: options => ipcRenderer.invoke('workspace:openLink', options || {}),
    review: (context) => ipcRenderer.invoke('workspace:review', context || {}),
    reviewDiff: (options) => ipcRenderer.invoke('workspace:reviewDiff', options || {}),
    terminalStart: (options) => ipcRenderer.invoke('workspace:terminalStart', options || {}),
    terminalInput: (options) => ipcRenderer.invoke('workspace:terminalInput', options || {}),
    terminalResize: (options) => ipcRenderer.invoke('workspace:terminalResize', options || {}),
    terminalClose: (options) => ipcRenderer.invoke('workspace:terminalClose', options || {}),
    onTerminalEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('workspace:terminal-event', listener);
      return () => ipcRenderer.removeListener('workspace:terminal-event', listener);
    },
  },

  // AI 创作(文生图)
  image: {
    generate:  (opts)    => ipcRenderer.invoke('image:generate', opts),
    getConfig: ()        => ipcRenderer.invoke('image:getConfig'),
    toDataUrl: (p)       => ipcRenderer.invoke('image:toDataUrl', p),
    saveRef:   (opts)    => ipcRenderer.invoke('image:saveRef', opts),
    savePaste: (opts)    => ipcRenderer.invoke('image:savePaste', opts),
    readClipboardImage: () => ipcRenderer.invoke('clipboard:readImage'),
    deleteSaved: (p)     => ipcRenderer.invoke('image:deleteSaved', p),
  },

  // 库:汇总本地生成的图片与文件
  library: {
    listImages: ()  => ipcRenderer.invoke('library:listImages'),
    listFiles:  ()  => ipcRenderer.invoke('library:listFiles'),
    openImagesDir: () => ipcRenderer.invoke('library:openImagesDir'),
    openFile:   (p) => ipcRenderer.invoke('library:openFile', p),
    deleteFile: (p) => ipcRenderer.invoke('library:deleteFile', p),
  },

  // 监听 claude 事件流
  onEvent: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('claude:event', listener);
    return () => ipcRenderer.removeListener('claude:event', listener);
  },
  // 对话任务状态：持久化快照、事件补放与恢复。
  tasks: {
    snapshot: (filter) => ipcRenderer.invoke('tasks:snapshot', filter || {}),
    get: (runId) => ipcRenderer.invoke('tasks:get', runId),
    replay: (options) => ipcRenderer.invoke('tasks:replay', options || {}),
    replayStream: (options) => ipcRenderer.invoke('tasks:replayStream', options || {}),
    progress: (runId) => ipcRenderer.invoke('tasks:progress', runId),
    ack: (options) => ipcRenderer.invoke('tasks:ack', options || {}),
    onEvent: (handler) => {
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('tasks:event', listener);
      return () => ipcRenderer.removeListener('tasks:event', listener);
    },
  },
  // 原生交互面：AskUserQuestion 与权限审批都在专用决策卡中处理。
  interactions: {
    list: (filter) => ipcRenderer.invoke('interactions:list', filter || {}),
    respond: (id, decision) => ipcRenderer.invoke('interactions:respond', { id, decision }),
    onEvent: (handler) => {
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('interactions:event', listener);
      return () => ipcRenderer.removeListener('interactions:event', listener);
    },
  },
  permissions: {
    get: conversationId => ipcRenderer.invoke('permissions:get', conversationId),
    set: input => ipcRenderer.invoke('permissions:set', input),
    onChanged: handler => {
      const listener = (_event, value) => handler(value);
      ipcRenderer.on('permissions:changed', listener);
      return () => ipcRenderer.removeListener('permissions:changed', listener);
    },
  },
  checkpoints: {
    get: (runId) => ipcRenderer.invoke('checkpoints:get', runId),
    preview: (runId) => ipcRenderer.invoke('checkpoints:preview', runId),
    rollback: (runId) => ipcRenderer.invoke('checkpoints:rollback', runId),
    onEvent: (handler) => {
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('checkpoints:event', listener);
      return () => ipcRenderer.removeListener('checkpoints:event', listener);
    },
  },
  // 历史会话
  history: {
    native: input => ipcRenderer.invoke('history:native', input),
    fork: input => ipcRenderer.invoke('history:fork', input),
    subagents: input => ipcRenderer.invoke('history:subagents', input),
    subagentMessages: input => ipcRenderer.invoke('history:subagentMessages', input),
    list:     ()    => ipcRenderer.invoke('history:list'),
    search:   (query, limit) => ipcRenderer.invoke('history:search', { query, limit }),
    load:     (id)  => ipcRenderer.invoke('history:load', id),
    save:     (conv)=> ipcRenderer.invoke('history:save', conv),
    invalidateSessionForProvider: (id, routeTier) => ipcRenderer.invoke(
      'history:invalidateSessionForProvider', { id, routeTier },
    ),
    delete:   (id)  => ipcRenderer.invoke('history:delete', id),
    setPinned:(id, pinned) => ipcRenderer.invoke('history:setPinned', { id, pinned }),
    rename:   (id, title)  => ipcRenderer.invoke('history:rename', { id, title }),
  },
  sdkPlugins: {
    list: () => ipcRenderer.invoke('sdkPlugins:list'), add: () => ipcRenderer.invoke('sdkPlugins:add'),
    update: (id, patch) => ipcRenderer.invoke('sdkPlugins:update', { id, patch }),
    remove: id => ipcRenderer.invoke('sdkPlugins:remove', { id }),
  },
  sessionHistory: {
    listSubagents: input => ipcRenderer.invoke('history:subagents', input),
    getSubagentMessages: input => ipcRenderer.invoke('history:subagentMessages', input),
  },

  // 用量统计(本地聚合 history + 定时任务 runs,供「用量」面板展示)
  stats: {
    overview: (days, options = {}) => ipcRenderer.invoke('stats:overview', { days, force: options.refresh === true || options.force === true }),
    onUpdated: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('stats:updated', listener);
      return () => ipcRenderer.removeListener('stats:updated', listener);
    },
  },

  // 设置
  settings: {
    read:       ()        => ipcRenderer.invoke('settings:read'),
    write:      (payload) => ipcRenderer.invoke('settings:write', payload),
  },
  // Relay 服务商：密钥只在主进程解密，renderer 永远拿不到明文。
  providers: {
    list:          ()            => ipcRenderer.invoke('providers:list'),
    create:        (input)       => ipcRenderer.invoke('providers:create', input),
    update:        (id, patch)   => ipcRenderer.invoke('providers:update', { id, patch }),
    duplicate:     (id)          => ipcRenderer.invoke('providers:duplicate', id),
    remove:        (id)          => ipcRenderer.invoke('providers:remove', id),
    setImageRoute: (adapterId, id)=> ipcRenderer.invoke('providers:setImageRoute', { adapterId, id }),
    test:          (id)          => ipcRenderer.invoke('providers:test', id),
    testDraft:     (draft)       => ipcRenderer.invoke('providers:testDraft', draft),
    discoverModels:(id)          => ipcRenderer.invoke('providers:discoverModels', id),
    discoverDraftModels:(draft)  => ipcRenderer.invoke('providers:discoverDraftModels', draft),
    onChanged: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('providers:changed', listener);
      return () => ipcRenderer.removeListener('providers:changed', listener);
    },
  },

  // 品牌自定义(侧边栏左上角 logo + 名称)
  brand: {
    get:       ()     => ipcRenderer.invoke('brand:get'),
    setName:   (name) => ipcRenderer.invoke('brand:setName', name),
    pickLogo:  ()     => ipcRenderer.invoke('brand:pickLogo'),
    resetLogo: ()     => ipcRenderer.invoke('brand:resetLogo'),
    pickLogoPreview: () => ipcRenderer.invoke('brand:pickLogoPreview'),
    discardLogoPreview: (previewId) => ipcRenderer.invoke('brand:discardLogoPreview', previewId),
    saveProfile: (profile) => ipcRenderer.invoke('brand:saveProfile', profile),
  },

  // 数据中心:UI 内编辑配置 / 管理 Agent & 技能 / 导入 zip
  data: {
    listAgents:  ()              => ipcRenderer.invoke('data:listAgents'),
    listSkills:  ()              => ipcRenderer.invoke('data:listSkills'),
    removeAgent: (file)          => ipcRenderer.invoke('data:removeAgent', { file }),
    removeSkill: (name)          => ipcRenderer.invoke('data:removeSkill', { name }),
    renameAgent: (file, displayName) => ipcRenderer.invoke('data:renameAgent', { file, displayName }),
    pickImportZip:(kind)          => ipcRenderer.invoke('data:pickImportZip', { kind }),
    importZip:   (kind, zipPath) => ipcRenderer.invoke('data:importZip', { kind, zipPath }),
    readItem:    (kind, key)     => ipcRenderer.invoke('data:readItem', { kind, key }),
    writeItem:   (kind, key, content) => ipcRenderer.invoke('data:writeItem', { kind, key, content }),
    revealItem:  (kind, key)     => ipcRenderer.invoke('data:revealItem', { kind, key }),
  },

  // MCP 服务器结构化管理(列表 / 启停 / 删除)——读写 .claude.json 的 mcpServers + sidecar
  mcp: {
    list:      ()                        => ipcRenderer.invoke('mcp:list'),
    setPermission: (name, mode)          => ipcRenderer.invoke('mcp:permission:set', { name, mode }),
    status:    (convId)                  => ipcRenderer.invoke('mcp:status', { convId }),
    reconnect: (convId, name)            => ipcRenderer.invoke('mcp:reconnect', { convId, name }),
    sync:      (convId)                  => ipcRenderer.invoke('mcp:sync', { convId }),
    toggle:    (name, enabled, convId)   => ipcRenderer.invoke('mcp:toggle', { name, enabled, convId }),
    remove:    (name, convId)            => ipcRenderer.invoke('mcp:delete', { name, convId }),
  },

  // 技能生命周期(Curator):用量遥测 + 闲置标记 + 置顶/归档/恢复 + 自动提炼
  skills: {
    overview:     (options)       => ipcRenderer.invoke('skills:overview', options),
    backfillMetadata:()           => ipcRenderer.invoke('skills:backfillMetadata'),
    pin:          (name, pinned)  => ipcRenderer.invoke('skills:pin', { name, pinned }),
    archive:      (name)          => ipcRenderer.invoke('skills:archive', { name }),
    restore:      (name)          => ipcRenderer.invoke('skills:restore', { name }),
    deleteArchived:(name)         => ipcRenderer.invoke('skills:deleteArchived', { name }),
    setStaleDays: (days)          => ipcRenderer.invoke('skills:setStaleDays', { days }),
    // 二期:自动提炼技能(强信号即时触发、每 N 轮兜底)+ 配置读写
    autoReview:      (conversationText, workingDir, triggerReason) => ipcRenderer.invoke('skills:autoReview', { conversationText, workingDir, triggerReason }),
    getReviewConfig: ()                  => ipcRenderer.invoke('skills:getReviewConfig'),
    setReviewConfig: (cfg)               => ipcRenderer.invoke('skills:setReviewConfig', cfg),
    // 三期:技能体检(伞状合并)——建 builtin 定时任务时取技能目录 + 体检 prompt
    getDir:          ()                  => ipcRenderer.invoke('skills:getDir'),
    curatorPrompt:   ()                  => ipcRenderer.invoke('skills:curatorPrompt'),
    onUsageUpdated:  (handler)            => {
      const fn = (_event, payload) => handler(payload);
      ipcRenderer.on('skills:usageUpdated', fn);
      return () => ipcRenderer.removeListener('skills:usageUpdated', fn);
    },
  },
  // Skill Curator 只产出待审核草稿；发布与回滚都必须由用户显式操作。
  skillDrafts: {
    list: (filter) => ipcRenderer.invoke('skillDrafts:list', filter || {}),
    diff: (id) => ipcRenderer.invoke('skillDrafts:diff', id),
    validate: (id) => ipcRenderer.invoke('skillDrafts:validate', id),
    rebase: (id, options) => ipcRenderer.invoke('skillDrafts:rebase', { id, options: options || {} }),
    publish: (id) => ipcRenderer.invoke('skillDrafts:publish', id),
    reject: (id, reason) => ipcRenderer.invoke('skillDrafts:reject', { id, reason }),
    history: (skillName) => ipcRenderer.invoke('skillDrafts:history', skillName),
    rollback: (skillName, versionId, options) => ipcRenderer.invoke('skillDrafts:rollback', {
      skillName, versionId, options: options || {},
    }),
    onEvent: (handler) => {
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('skillDrafts:event', listener);
      return () => ipcRenderer.removeListener('skillDrafts:event', listener);
    },
  },

  // 长期记忆库：用户审核、编辑、移除、历史查看及恢复。
  memory: {
    list: (options) => ipcRenderer.invoke('memory:list', options),
    archived: () => ipcRenderer.invoke('memory:archived'),
    read: (file) => ipcRenderer.invoke('memory:read', file),
    write: (file, content, expectedRevision) => ipcRenderer.invoke('memory:write', { file, content, expectedRevision }),
    setPinned: (file, pinned) => ipcRenderer.invoke('memory:setPinned', { file, pinned }),
    setStatus: (file, status, expectedRevision) => ipcRenderer.invoke('memory:setStatus', { file, status, expectedRevision }),
    remove: (file, expectedRevision) => ipcRenderer.invoke('memory:remove', { file, expectedRevision }),
    history: (file) => ipcRenderer.invoke('memory:history', file),
    restore: (file, versionId, expectedRevision) => ipcRenderer.invoke('memory:restore', { file, versionId, expectedRevision }),
    revealFile: (file) => ipcRenderer.invoke('memory:revealFile', file),
  },

  // 定时任务（scheduler）
  scheduler: {
    list:    ()            => ipcRenderer.invoke('sched:list'),
    runs:    (id)          => ipcRenderer.invoke('sched:runs', id),
    create:  (task)        => ipcRenderer.invoke('sched:create', task),
    update:  (id, patch)   => ipcRenderer.invoke('sched:update', { id, patch }),
    remove:  (id)          => ipcRenderer.invoke('sched:remove', id),
    toggle:  (id, enabled) => ipcRenderer.invoke('sched:toggle', { id, enabled }),
    runNow:  (id)          => ipcRenderer.invoke('sched:runNow', id),
    preview: (schedule)    => ipcRenderer.invoke('sched:preview', schedule),
    getAutoLaunch: ()      => ipcRenderer.invoke('sched:getAutoLaunch'),
    setAutoLaunch: (on)    => ipcRenderer.invoke('sched:setAutoLaunch', on),
    // 任务状态变化（触发/完成/CRUD）时主进程推送，UI 据此刷新列表
    onUpdate: (handler) => {
      const fn = () => handler();
      ipcRenderer.on('sched:update', fn);
      return () => ipcRenderer.removeListener('sched:update', fn);
    },
  },

  // Desktop floating orb and persistent quick chat. Conversation execution stays
  // in the main process; hiding the panel does not interrupt it.
  mini: {
    brand: () => ipcRenderer.invoke('mini:brand'),
    state: () => ipcRenderer.invoke('mini:state'),
    readLocalImage: input => ipcRenderer.invoke('mini:readLocalImage', input),
    submit: input => ipcRenderer.invoke('mini:submit', input),
    pause: () => ipcRenderer.invoke('mini:pause'),
    newChat: () => ipcRenderer.invoke('mini:newChat'),
    hide: () => ipcRenderer.invoke('mini:hide'),
    resize: input => ipcRenderer.invoke('mini:resize', input),
    setPinned: value => ipcRenderer.invoke('mini:setPinned', value),
    openMain: () => ipcRenderer.invoke('mini:openMain'),
    toggle: () => ipcRenderer.invoke('mini:toggle'),
    orbDrag: input => ipcRenderer.invoke('mini:orbDrag', input),
    orbMenu: () => ipcRenderer.invoke('mini:orbMenu'),
    mainReady: () => ipcRenderer.invoke('mini:mainReady'),
    onState: handler => {
      const listener = (_event, value) => handler(value);
      ipcRenderer.on('mini:state', listener);
      return () => ipcRenderer.removeListener('mini:state', listener);
    },
    onFocus: handler => {
      const listener = () => handler();
      ipcRenderer.on('mini:focus', listener);
      return () => ipcRenderer.removeListener('mini:focus', listener);
    },
    onOpenConversation: handler => {
      const listener = (_event, value) => handler(value);
      ipcRenderer.on('mini:open-conversation', listener);
      return () => ipcRenderer.removeListener('mini:open-conversation', listener);
    },
    onHistoryChanged: handler => {
      const listener = (_event, value) => handler(value);
      ipcRenderer.on('mini:history-changed', listener);
      return () => ipcRenderer.removeListener('mini:history-changed', listener);
    },
  },

  // 首次欢迎页只记录完成状态，不探测或修改系统环境。
  installer: {
    complete: ()        => ipcRenderer.invoke('wizard:complete'),
  },
});
