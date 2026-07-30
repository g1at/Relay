// preload.js — 把 IPC 安全暴露给 renderer
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 启动一次 Claude 对话(prompt 文本,可选 sessionId 续接,mode='agent'|'plain',
  //   model='haiku'|'sonnet'|'opus',agentName=选中的子智能体名(agent 模式用))
  //   orchestrateAgents=协同模式下用户勾选的子智能体 name 数组(可空=全量交 PM 自选)
  //   convId=会话 id：主进程据它复用该对话的常驻 claude 进程(MCP 不必每轮重启)。
  //     不传也能跑 —— 主进程会回退到每轮新起进程的老行为。
  runClaude: (prompt, sessionId, mode, files, model, agentName, workingDir, orchestrateAgents, convId, forceFreshSession) =>
    ipcRenderer.invoke('claude:run', { prompt, sessionId, mode, files, model, agentName, workingDir, orchestrateAgents, convId, forceFreshSession }),

  // 预启动该对话的常驻 claude 进程(打开/切换对话时调,fire-and-forget)。
  //   目的:让 MCP 在用户打字的这几秒里连好,首轮就能拿到完整工具列表。失败完全无害。
  prespawnClaude: (convId, sessionId, mode, model, agentName, workingDir) =>
    ipcRenderer.invoke('claude:prespawn', { convId, sessionId, mode, model, agentName, workingDir }),

  // 丢弃该对话的常驻进程 + 已记住的 session_id(降级重跑前调,避免拿坏 session 再续接)
  dropClaudeSession: (convId) => ipcRenderer.invoke('claude:dropSession', convId),
  // 新建 Claude session 重新加载 MCP；Relay 会在下一条消息中带入历史上下文。
  resetClaudeSession: (convId, mode, model, workingDir) =>
    ipcRenderer.invoke('claude:resetSession', { convId, mode, model, workingDir }),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // Electron 32 起 File.path 被移除,拖拽文件须用 webUtils 取真实磁盘路径
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // 中止任务(按 jobId 杀单个;不传则杀全部)
  abortClaude: (jobId) => ipcRenderer.invoke('claude:abort', jobId),

  // 让快模型给对话起个简短标题(历史侧边栏摘要)
  summarizeTitle: (text) => ipcRenderer.invoke('claude:title', { text }),

  // 探测环境
  probeEnv: () => ipcRenderer.invoke('env:probe'),

  // 检查 Claude Code 是否有新版本(联网对比 npm 最新版)
  checkClaudeUpdate: () => ipcRenderer.invoke('claude:checkUpdate'),
  // 一键更新 Claude Code 到最新版
  updateClaude: () => ipcRenderer.invoke('claude:update'),

  // Relay 应用自更新(electron-updater;主进程自动检查+静默下载,这里只做状态展示与安装触发)
  relayUpdate: {
    status: () => ipcRenderer.invoke('relay:updateStatus'),           // 当前状态快照
    check: () => ipcRenderer.invoke('relay:checkUpdate'),             // 手动触发检查
    quitAndInstall: () => ipcRenderer.invoke('relay:quitAndInstall'), // 重启安装(ready 时)
    onEvent: (handler) => {                                           // 状态变化推送
      const listener = (_evt, payload) => handler(payload);
      ipcRenderer.on('relay:update-event', listener);
      return () => ipcRenderer.removeListener('relay:update-event', listener);
    },
  },

  // 用系统浏览器打开 URL
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // AI 创作(文生图)
  image: {
    generate:  (opts)    => ipcRenderer.invoke('image:generate', opts),
    listSaved: ()        => ipcRenderer.invoke('image:listSaved'),
    getConfig: ()        => ipcRenderer.invoke('image:getConfig'),
    setConfig: (cfg)     => ipcRenderer.invoke('image:setConfig', cfg),
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
    revealFile: (p) => ipcRenderer.invoke('library:revealFile', p),
    deleteFile: (p) => ipcRenderer.invoke('library:deleteFile', p),
  },

  // 监听 claude 事件流
  onEvent: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('claude:event', listener);
    return () => ipcRenderer.removeListener('claude:event', listener);
  },
  // 历史会话
  history: {
    list:     ()    => ipcRenderer.invoke('history:list'),
    search:   (query, limit) => ipcRenderer.invoke('history:search', { query, limit }),
    load:     (id)  => ipcRenderer.invoke('history:load', id),
    save:     (conv)=> ipcRenderer.invoke('history:save', conv),
    delete:   (id)  => ipcRenderer.invoke('history:delete', id),
    setPinned:(id, pinned) => ipcRenderer.invoke('history:setPinned', { id, pinned }),
    rename:   (id, title)  => ipcRenderer.invoke('history:rename', { id, title }),
  },

  // 用量统计(本地聚合 history + 定时任务 runs,供「用量」面板展示)
  stats: {
    overview: (days) => ipcRenderer.invoke('stats:overview', { days }),
  },

  // 设置
  settings: {
    read:       ()        => ipcRenderer.invoke('settings:read'),
    write:      (payload) => ipcRenderer.invoke('settings:write', payload),
    revealFile: (p)       => ipcRenderer.invoke('settings:revealFile', p),
  },

  // 品牌自定义(侧边栏左上角 logo + 名称)
  brand: {
    get:       ()     => ipcRenderer.invoke('brand:get'),
    setName:   (name) => ipcRenderer.invoke('brand:setName', name),
    pickLogo:  ()     => ipcRenderer.invoke('brand:pickLogo'),
    resetLogo: ()     => ipcRenderer.invoke('brand:resetLogo'),
  },
  // 协同 PM 的名称 + 头像自定义(与 brand 同机制)
  pm: {
    get:       ()     => ipcRenderer.invoke('pm:get'),
    setName:   (name) => ipcRenderer.invoke('pm:setName', name),
    pickLogo:  ()     => ipcRenderer.invoke('pm:pickLogo'),
    resetLogo: ()     => ipcRenderer.invoke('pm:resetLogo'),
  },

  // 数据中心:UI 内编辑配置 / 管理 Agent & 技能 / 导入 zip
  data: {
    read:        (kind)          => ipcRenderer.invoke('data:read', { kind }),
    write:       (kind, content) => ipcRenderer.invoke('data:write', { kind, content }),
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
    list:   ()              => ipcRenderer.invoke('mcp:list'),
    toggle: (name, enabled) => ipcRenderer.invoke('mcp:toggle', { name, enabled }),
    remove: (name)          => ipcRenderer.invoke('mcp:delete', { name }),
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
    // 二期:自动提炼技能(每 N 轮由 finishRun 触发)+ 配置读写
    autoReview:      (conversationText, workingDir) => ipcRenderer.invoke('skills:autoReview', { conversationText, workingDir }),
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

  // 长期记忆库:查看 / 编辑 / 删除模型记下的内容(模型在对话里自读自写,这里供人工审计纠正)
  memory: {
    list:   ()            => ipcRenderer.invoke('memory:list'),
    read:   (file)        => ipcRenderer.invoke('memory:read', file),
    write:  (file, content) => ipcRenderer.invoke('memory:write', { file, content }),
    remove: (file)        => ipcRenderer.invoke('memory:remove', file),
    reveal: ()            => ipcRenderer.invoke('memory:reveal'),
    revealFile: (file)     => ipcRenderer.invoke('memory:revealFile', file),
  },

  // 定时任务（scheduler）
  scheduler: {
    list:    ()            => ipcRenderer.invoke('sched:list'),
    get:     (id)          => ipcRenderer.invoke('sched:get', id),
    create:  (task)        => ipcRenderer.invoke('sched:create', task),
    update:  (id, patch)   => ipcRenderer.invoke('sched:update', { id, patch }),
    remove:  (id)          => ipcRenderer.invoke('sched:remove', id),
    toggle:  (id, enabled) => ipcRenderer.invoke('sched:toggle', { id, enabled }),
    runNow:  (id)          => ipcRenderer.invoke('sched:runNow', id),
    runs:    (id)          => ipcRenderer.invoke('sched:runs', id),
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

  // 迷你输入框(全局快捷键唤起的快速投递窗)
  mini: {
    brand:  ()     => ipcRenderer.invoke('mini:brand'),          // 取品牌名 + logo + 当前快捷键
    submit: (text) => ipcRenderer.invoke('mini:submit', text),   // 投递一句话(主窗新建对话并发送)
    hide:   ()     => ipcRenderer.invoke('mini:hide'),           // 请求隐藏自身(ESC)
    resize: (h)    => ipcRenderer.invoke('mini:resize', h),      // 按内容高度调窗口高
    // 唤起时主进程通知渲染端清空+聚焦输入框
    onFocus: (handler) => {
      const fn = () => handler();
      ipcRenderer.on('mini:focus', fn);
      return () => ipcRenderer.removeListener('mini:focus', fn);
    },
  },

  // 主窗接收迷你窗投递的一句话(新建对话并发送)
  onMiniSubmit: (handler) => {
    const fn = (_e, text) => handler(text);
    ipcRenderer.on('mini:submit', fn);
    return () => ipcRenderer.removeListener('mini:submit', fn);
  },

  // 首次安装向导
  installer: {
    probe:    ()        => ipcRenderer.invoke('installer:probe'),
    run:      (apiKey)  => ipcRenderer.invoke('installer:run', { apiKey }),
    abort:    ()        => ipcRenderer.invoke('installer:abort'),
    onLog:    (handler) => {
      const fn = (_e, payload) => handler(payload);
      ipcRenderer.on('installer:log', fn);
      return () => ipcRenderer.removeListener('installer:log', fn);
    },
    complete: ()        => ipcRenderer.invoke('wizard:complete'),
    openMifyKey: ()     => ipcRenderer.invoke('shell:open', 'https://llm.mioffice.cn/apikey'),
  },
});
