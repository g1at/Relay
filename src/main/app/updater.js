// updater.js — Relay 应用自更新（electron-updater + GitHub Releases）
//
// 设计要点：
//   · 全程用户说了算：只「检查」是自动的，下载和安装都必须用户点过才发生。
//     autoDownload=false  → 发现新版只报信，不偷偷占用户带宽；
//     autoInstallOnAppQuit=false → 不在退出时静默替换，用户没同意就永远不动。
//     （早期版本两者都为 true，等于强制更新，被用户反馈太激进。）
//   · 两条触发路径共用同一套状态机：
//     ① 定时检查发现新版 → 界面右下角冒个小气泡，用户点「立即更新」才开始下载；
//     ② 用户主动在设置页点 Relay 那行 → 立刻查一次（同 Claude Code 那行的交互）。
//   · 只在打包版启用：electron-updater 不支持未打包运行（读不到 app-update.yml），
//     dev 下所有 IPC 返回 { state: 'disabled' }，UI 显示「开发模式」。
//   · 状态机：
//     idle ─check→ checking ─┬→ idle       (已是最新)
//                            ├→ available  (发现新版,等用户点)
//                            └→ error      (查不动,可重试)
//     available ─download→ downloading(progress%) ─┬→ ready (等用户点重启安装)
//                                                  └→ available + error (下载失败,可重试)
//     每次变化推 relay:update-event 给 renderer（气泡和设置页都靠它实时刷）。
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
let autoUpdater = null;   // 打包版首次检查时才加载，首屏不承担依赖加载成本
let notified = false;     // 下载就绪通知只发一次（每次检查周期内）

// 用户点过「稍后」的版本号。只存内存：这一轮不再打扰，下次启动重新提醒一次 ——
// 持久化会导致用户误点一次就永远收不到该版本的提示。
let dismissedVersion = '';

// 当前状态快照（renderer 拉取 + 事件推送共用同一份）
const status = {
  state: 'idle',        // idle | checking | available | downloading | ready | error | disabled
  current: '',          // 当前版本
  latest: '',           // 发现的新版本号（available/downloading/ready 时有值）
  progress: 0,          // 下载进度 0-100（downloading 时有意义）
  error: '',            // 出错时的提示文案（downloading 失败会退回 available 并保留它）
  checkedAt: 0,         // 最近一次成功检查的时间戳（0=从未；UI 借此区分「未检查」和「已是最新」）
  dismissed: false,     // 用户已对该版本点过「稍后」→ 气泡不再冒（设置页仍照常显示）
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

  // 定时检查:首查延迟 + 周期重查。依赖也等到首次检查才加载，
  // 用户提前点检查会立即初始化，不必等待这个 timer。
  setTimeout(() => { check(); setInterval(check, CHECK_INTERVAL_MS); }, CHECK_INITIAL_DELAY_MS);
  console.log('[updater] 已启动,%d 分钟后首次检查', Math.round(CHECK_INITIAL_DELAY_MS / 60000));
}

function ensureAutoUpdater() {
  if (autoUpdater) return true;
  if (!deps || !deps.isPackaged || status.state === 'disabled') return false;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    setState({ state: 'disabled' });
    console.error('[updater] electron-updater 加载失败: %s', e.message);
    return false;
  }

  autoUpdater.logger = console;                 // 镜像进 userData/logs/main.log
  // 这两项是「不强制更新」的关键：查归查，下载和安装都等用户点。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => {
    const v = (info && info.version) || '';
    setState({
      state: 'available', latest: v, progress: 0, error: '', checkedAt: Date.now(),
      dismissed: dismissedVersion !== '' && dismissedVersion === v,
    });
  });
  autoUpdater.on('update-not-available', () => {
    notified = false;
    setState({ state: 'idle', latest: '', progress: 0, error: '', checkedAt: Date.now(), dismissed: false });
  });
  autoUpdater.on('download-progress', (p) => {
    setState({ state: 'downloading', progress: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const v = (info && info.version) || status.latest;
    // 下载是用户亲自点的,装不装的提示必须让他看见 —— 把之前的「稍后」清掉。
    dismissedVersion = '';
    setState({ state: 'ready', latest: v, progress: 100, error: '', dismissed: false });
    if (!notified) {
      notified = true;
      try { deps.notify({ title: 'Relay 新版本已下载完成', body: `v${v} 已就绪，重启 Relay 即可完成更新。` }); } catch (_) {}
    }
  });
  autoUpdater.on('error', (e) => {
    // 网络失败很常见(GitHub 国内访问),只记日志 + 状态,不弹通知打扰
    const msg = (e && e.message || String(e)).slice(0, 200);
    console.warn('[updater] 出错: %s', msg);
    if (status.state === 'downloading') {
      // 下载中断:退回 available 并保留错误文案,用户可以再点一次重试
      setState({ state: 'available', progress: 0, error: msg });
    } else {
      setState({ state: 'error', error: msg });
    }
  });

  return true;
}

// 触发一次检查(定时 + 设置页手动共用)。已发现新版/下载中/已就绪都不重查。
function check() {
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return;
  if (!ensureAutoUpdater()) return;
  autoUpdater.checkForUpdates().catch((e) => {
    console.warn('[updater] 检查失败: %s', e && e.message);
  });
}

// 用户确认更新后才下载。available(含上次下载失败退回来的)才有意义。
function download() {
  if (!deps || !deps.isPackaged || status.state === 'disabled') return { ok: false, error: '开发模式不支持更新' };
  if (!autoUpdater) return { ok: false, error: '当前没有可下载的新版本' };
  if (status.state === 'ready') return { ok: true };            // 已经下好了,直接当成功
  if (status.state === 'downloading') return { ok: true };      // 正在下,别重复触发
  if (status.state !== 'available') return { ok: false, error: '当前没有可下载的新版本' };
  dismissedVersion = '';
  setState({ state: 'downloading', progress: 0, error: '', dismissed: false });
  autoUpdater.downloadUpdate().catch((e) => {
    const msg = (e && e.message || String(e)).slice(0, 200);
    console.warn('[updater] 下载失败: %s', msg);
    setState({ state: 'available', progress: 0, error: msg });
  });
  return { ok: true };
}

// 用户点「稍后」：只压掉界面上的气泡,不影响设置页里的状态展示,也不取消已在跑的下载。
// 仅对当前这个版本号生效,下次启动或出更新的版本会重新提醒。
function dismiss() {
  if (!status.latest) return { ok: false };
  dismissedVersion = status.latest;
  setState({ dismissed: true });
  return { ok: true };
}

function getStatus() { return { ...status }; }

// 立即重启安装(仅 ready 状态有效)。先置位 isQuitting 放行主窗口 close。
function quitAndInstall() {
  if (!autoUpdater || status.state !== 'ready') return { ok: false, error: '安装包尚未就绪' };
  try { deps.markQuitting(); } catch (_) {}
  // isSilent=true 静默装(NSIS 侧走 /S,见 build/installer.nsh 对静默路径的放行);
  // isForceRunAfter=true 装完自动拉起新版
  setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { console.error('[updater] quitAndInstall 失败: %s', e.message); } });
  return { ok: true };
}

module.exports = { init, check, download, dismiss, getStatus, quitAndInstall };
