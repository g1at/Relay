'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { appRoot } = require('./paths');
const { isQuickChatEnabled, normalizeQuickChatPatch } = require('./mini-window-host');

// This owner keeps all native window/tray state in one place. Runtime services
// are callbacks, so constructing the owner never starts a task or an SDK session.
function createApplicationWindows({
  electron, logger, settings, providers, tasks, mini, browser, startup,
  IS_DEV = false, IS_AUTOSTART = false, HAS_SINGLE_INSTANCE_LOCK = true,
}) {
  const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme } = electron;
  const { read: readAppSettings, write: writeAppSettings } = settings;
  const FIRST_RUN_SETUP_VERSION = 1;
  function resolveNativeIcon(name) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, name), path.join(appRoot, 'build', name)]
      : [path.join(appRoot, 'build', name)];
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
    const n = tasks.runningCount();
    const waitingCount = tasks.waitingInteractions().length;
    // 下一个定时任务提示(没有则不显示该行)
    let nextHint = null;
    try { nextHint = tasks.nextScheduledHint(); } catch (e) { console.warn('[tray] nextTaskHint 失败: %s', e.message); }
    // 迷你输入框菜单文案带上实际快捷键(占用兜底后可能不是 Alt+Space);没注册成功则不显示提示
    const miniAccelText = mini.shortcut() ? `（${mini.shortcut().replace('Control', 'Ctrl')}）` : '';
    const miniEnabled = isQuickChatEnabled(readAppSettings());   // 关掉迷你输入框时连菜单项一并隐藏,UI 不留死入口
    const template = [
      { label: '显示 Relay', click: () => showMainWindow() },
    ];
    try {
      const routing = providers.store.getRoutingView();
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
                const changed = providers.store.setDefaultModel(item.tier);
                if (changed.changed) providers.publishChange('更新默认档位');
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
    if (miniEnabled) template.push({ label: `快捷对话${miniAccelText}`, click: () => mini.toggle() });
    template.push({ label: '显示桌面悬浮球', click: () => {
      const settings = readAppSettings();
      if (!isQuickChatEnabled(settings)) {
        writeAppSettings({ ...settings, ...normalizeQuickChatPatch({ quickChatEnabled: true }) });
        mini.registerShortcut();
        refreshTrayMenu();
      }
      mini.getHost().syncSettings();
      mini.getHost().showOrb();
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
        preload: path.join(appRoot, 'preload.js'),
        additionalArguments: process.platform === 'win32' ? [
          '--relay-window-chrome-overlay',
          `--relay-window-chrome-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`,
        ] : [],
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
      },
    });
    const entryFile = path.join(appRoot, 'renderer/index.html');
    win.relayContentReady = Promise.resolve(win.loadFile(entryFile));
    // Keep a handled readiness promise for the first-run handoff. A failed
    // renderer load must leave the welcome window available for retry.
    void win.relayContentReady.catch(error => logger.error('[renderer] load failed:', error.message));
    // 首帧就绪再显示并聚焦;托盘重开走的也是这条(reuse 时 ready-to-show 不重发,由 showMainWindow 直接 show)
    win.once('ready-to-show', () => {
      if (showOnReady) { win.show(); win.focus(); }
      tasks.scheduleRetention();
    });
    attachExternalLinkGuard(win, entryFile);
    // Electron 32 can miss a shell-only color change when the application color
    // stays unchanged. WM_SETTINGCHANGE also covers Windows custom theme modes.
    if (process.platform === 'win32') win.hookWindowMessage?.(0x001a, updateNativeBrandTheme);
    attachRendererConsoleLog(win, 'renderer');
    if (IS_DEV) win.webContents.openDevTools();
    win.setMenuBarVisibility(false);

    mainWindow = win;
    tasks.refreshBadge();
    win.on('show', () => {
      syncMainWindowChromeAppearance(win);
      tasks.refreshBadge();
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
      tasks.rejectWindow(win.id, { message: '窗口已关闭，等待中的操作已安全拒绝' });
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
    const response = await browser.openLink(url);
    if (!response || response.ok === false) throw Error(response?.error || '无法打开链接');
    if (response.tab) showMainWindow();
    return response;
  }

  // Keep the native navigation fallback consistent with ordinary Markdown clicks.
  function attachExternalLinkGuard(win, entryFile) {
    require('../projects/local-preview-guard').attachLocalPreviewGuard(win.webContents);
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
        preload: path.join(appRoot, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
      },
    });
    const entryFile = path.join(appRoot, 'installer/wizard.html');
    win.loadFile(entryFile);
    attachExternalLinkGuard(win, entryFile);
    attachRendererConsoleLog(win, 'wizard');
    win.setMenuBarVisibility(false);
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
    return win;
  }


  function relaySetupCompleted() {
    const settings = readAppSettings();
    if (Number(settings.firstRunSetupVersion) >= FIRST_RUN_SETUP_VERSION) return true;
    // 已使用过 Relay 私有服务商的老用户直接迁移完成标记，避免升级后再次看到首次向导。
    if (!startup.providerConfigured()) return false;
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
    console.log('[startup] setupOk=%s providerOk=%s autostart=%s', setupOk, startup.providerConfigured(), IS_AUTOSTART);
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
    const expected = pathToFileURL(path.join(appRoot, 'installer/wizard.html')).href;
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


  function markQuitting() { isQuitting = true; }
  function destroyTray() { if (tray) { try { tray.destroy(); } catch (_) {} tray = null; } }
  function disposeNativeTheme() { nativeBrandTheme.dispose(); }
  function applyTheme(theme) {
    nativeTheme.themeSource = theme === 'system' ? 'system' : theme === 'dark' ? 'dark' : 'light';
    const background = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa';
    const miniHost = mini.getExistingHost();
    for (const win of BrowserWindow.getAllWindows()) {
      if (miniHost && miniHost.ownsWebContents(win.webContents)) continue;
      try {
        if (win === mainWindow && process.platform === 'win32') {
          syncMainWindowChromeAppearance(win, {
            dark: nativeTheme.shouldUseDarkColors,
            searchOpen: mainWindowChromeAppearances.get(win)?.searchOpen === true,
          });
        } else win.setBackgroundColor(background);
      } catch (error) { console.warn('[settings] 设置窗口背景色失败: %s', error.message); }
    }
  }

  return {
    currentAppIcon, updateNativeBrandTheme, refreshTrayMenu, createTray, showMainWindow, quitApp, createMainWindow, createWizardWindow, openConfiguredWebLink, decideStartup, markQuitting, destroyTray, disposeNativeTheme, applyTheme, syncMainWindowChromeAppearance,
    get mainWindow() { return mainWindow; },
    get tray() { return tray; },
    get isQuitting() { return isQuitting; },
    chromeAppearance: win => mainWindowChromeAppearances.get(win),
  };
}

module.exports = { createApplicationWindows };
