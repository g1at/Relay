// updater.js — Relay 应用自更新（electron-updater + GitHub Releases）
//
// 设计要点：
//   · 静默流：启动延迟后自动检查 → 后台静默下载（blockmap 差分）→ 下载就绪发一次通知；
//     默认退出时自动装（autoInstallOnAppQuit），设置页可点「重启安装」立即生效。
//   · 只在打包版启用：electron-updater 不支持未打包运行（读不到 app-update.yml），
//     dev 下所有 IPC 返回 { state: 'disabled' }，UI 显示「开发模式」。
//   · 状态机：idle → checking → available(下载中,含 progress%) → ready | error(→ 可重查)。
//     每次变化推 relay:update-event 给 renderer（设置页开着就实时刷）。
//   · quitAndInstall 前必须先 deps.markQuitting()：主窗口 close 被托盘逻辑拦截成隐藏，
//     不置位 isQuitting 的话安装器等不到进程退出。
//
// 依赖通过 init(deps) 注入（与 scheduler.js 同风格），避免与 main.js 循环引用。
//   deps = {
//     appVersion: string,            // app.getVersion()
//     isPackaged: boolean,           // app.isPackaged
//     markQuitting: fn,              // 置位 main.js 的 isQuitting（放行 close 钩子）
//     notify: fn({title, body}),     // 系统通知
//     getMainWindow: fn → BrowserWindow|null,   // 推送 relay:update-event
//   }

// 启动后首查延迟：让首屏/调度器先走。环境变量可覆盖(调试/验证用),生产默认 3 分钟。
const CHECK_INITIAL_DELAY_MS = Number(process.env.RELAY_UPDATE_CHECK_DELAY_MS) || 3 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 之后每 6 小时一次

let deps = null;
let autoUpdater = null;   // 打包版才 require（dev 下模块可用但行为无意义，干脆不加载）
let notified = false;     // 下载就绪通知只发一次（每次检查周期内）

// 当前状态快照（renderer 拉取 + 事件推送共用同一份）
const status = {
  state: 'idle',        // idle | checking | available | ready | error | disabled
  current: '',          // 当前版本
  latest: '',           // 发现的新版本号（available/ready 时有值）
  progress: 0,          // 下载进度 0-100（available 时有意义）
  error: '',            // error 时的提示文案
  checkedAt: 0,         // 最近一次成功检查的时间戳（0=从未；UI 借此区分「未检查」和「已是最新」）
};

function setState(patch) {
  Object.assign(status, patch);
  // 推给 renderer（窗口可能已销毁/隐藏,失败无害）
  try {
    const win = deps && deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('relay:update-event', { ...status });
  } catch (_) {}
}

function init(d) {
  deps = d;
  status.current = deps.appVersion || '';
  if (!deps.isPackaged) {
    status.state = 'disabled';
    console.log('[updater] 开发模式,自更新不启用');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    status.state = 'disabled';
    console.error('[updater] electron-updater 加载失败: %s', e.message);
    return;
  }

  autoUpdater.logger = console;                 // 镜像进 userData/logs/main.log
  autoUpdater.autoDownload = true;              // 发现即后台静默下载
  autoUpdater.autoInstallOnAppQuit = true;      // 不打扰:退出时自动装

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => {
    setState({ state: 'available', latest: (info && info.version) || '', progress: 0, error: '', checkedAt: Date.now() });
  });
  autoUpdater.on('update-not-available', () => {
    notified = false;
    setState({ state: 'idle', latest: '', progress: 0, error: '', checkedAt: Date.now() });
  });
  autoUpdater.on('download-progress', (p) => {
    setState({ state: 'available', progress: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const v = (info && info.version) || status.latest;
    setState({ state: 'ready', latest: v, progress: 100, error: '' });
    if (!notified) {
      notified = true;
      try { deps.notify({ title: 'Relay 新版本已就绪', body: `v${v} 已下载完成，重启应用即可更新（退出时也会自动安装）。` }); } catch (_) {}
    }
  });
  autoUpdater.on('error', (e) => {
    // 网络失败很常见(GitHub 国内访问),只记日志 + 状态,不弹通知打扰
    const msg = (e && e.message || String(e)).slice(0, 200);
    console.warn('[updater] 出错: %s', msg);
    setState({ state: 'error', error: msg });
  });

  // 定时检查:首查延迟 + 周期重查。timer 常驻(与 app 同生命周期,无需清理)。
  setTimeout(() => { check(); setInterval(check, CHECK_INTERVAL_MS); }, CHECK_INITIAL_DELAY_MS);
  console.log('[updater] 已启动,%d 分钟后首次检查', Math.round(CHECK_INITIAL_DELAY_MS / 60000));
}

// 触发一次检查(自动定时 + 设置页手动共用)。已在下载/就绪则不打断。
function check() {
  if (!autoUpdater) return;
  if (status.state === 'checking' || status.state === 'ready') return;
  if (status.state === 'available' && status.progress > 0) return;   // 下载中不重查
  autoUpdater.checkForUpdates().catch((e) => {
    console.warn('[updater] 检查失败: %s', e && e.message);
  });
}

function getStatus() { return { ...status }; }

// 立即重启安装(仅 ready 状态有效)。先置位 isQuitting 放行主窗口 close。
function quitAndInstall() {
  if (!autoUpdater || status.state !== 'ready') return { ok: false, error: '安装包尚未就绪' };
  try { deps.markQuitting(); } catch (_) {}
  // isSilent=true 静默装(oneClick NSIS 本就无交互);isForceRunAfter=true 装完自动拉起新版
  setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { console.error('[updater] quitAndInstall 失败: %s', e.message); } });
  return { ok: true };
}

module.exports = { init, check, getStatus, quitAndInstall };
