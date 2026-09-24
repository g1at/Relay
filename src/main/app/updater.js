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
let activeCheck = null;
let activeDownload = null;
let installing = false;

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
  checking: false,      // ready 重查时保留可安装状态，另行报告检查进度
  newerVersion: '',     // ready 时新发现的更高版本；确认下载前保留已有包
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
  setTimeout(() => { check(); setInterval(() => check(), CHECK_INTERVAL_MS); }, CHECK_INITIAL_DELAY_MS);
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

  autoUpdater.on('checking-for-update', () => {
    if (activeCheck) setState({ checking: true, error: '' });
  });
  autoUpdater.on('update-available', (info) => {
    if (!activeCheck) return;
    const v = (info && info.version) || '';
    if (activeCheck.ready) {
      setState({ newerVersion: isNewerStable(v, status.latest) ? v : '', error: '', checkedAt: Date.now() });
    } else {
      setState({
        state: 'available', latest: v, newerVersion: '', progress: 0, error: '', checkedAt: Date.now(),
        dismissed: dismissedVersion !== '' && dismissedVersion === v,
      });
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (!activeCheck) return;
    if (activeCheck.ready) {
      setState({ newerVersion: '', error: '', checkedAt: Date.now() });
    } else {
      notified = false;
      setState({ state: 'idle', latest: '', newerVersion: '', progress: 0, error: '', checkedAt: Date.now(), dismissed: false });
    }
  });
  autoUpdater.on('download-progress', (p) => {
    if (activeDownload && !activeDownload.completed) {
      setState({ state: 'downloading', progress: Math.round((p && p.percent) || 0) });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (!activeDownload || activeDownload.completed) return;
    const v = (info && info.version) || status.latest;
    if (v !== activeDownload.version) return;
    activeDownload.completed = true;
    dismissedVersion = '';
    setState({ state: 'ready', latest: v, newerVersion: '', progress: 100, error: '', dismissed: false });
    if (!notified) {
      notified = true;
      try { deps.notify({ title: 'Relay 新版本已下载完成', body: `v${v} 已就绪，重启 Relay 即可完成更新。` }); } catch (_) {}
    }
  });
  // electron-updater emits error before rejecting its operation promise. State
  // transitions belong to that promise so an old rejection cannot clobber a retry.
  autoUpdater.on('error', (e) => {
    console.warn('[updater] 出错: %s', errorMessage(e));
    if (installing) { installing = false; setState({ error: errorMessage(e) }); }
  });

  return true;
}

function errorMessage(e) { return (e && e.message || String(e)).slice(0, 200); }

// Published Relay releases are stable X.Y.Z versions (enforced by release-policy).
function isNewerStable(candidate, downloaded) {
  if (![candidate, downloaded].every(value => /^\d+\.\d+\.\d+$/.test(value))) return false;
  const a = candidate.split('.').map(Number), b = downloaded.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Timers leave ready alone. Only the explicit UI action may recheck a cached update.
function check({ manual = false } = {}) {
  if (installing || activeCheck || activeDownload || status.state === 'downloading'
      || (status.state === 'ready' && !manual)) return;
  if (!ensureAutoUpdater()) return;
  const operation = { ready: status.state === 'ready', snapshot: { ...status } };
  activeCheck = operation;
  setState({ state: operation.ready ? 'ready' : 'checking', checking: true, error: '' });
  const finish = () => {
    if (activeCheck !== operation) return;
    activeCheck = null;
    setState({ checking: false });
  };
  const fail = (e) => {
    if (activeCheck !== operation) return;
    console.warn('[updater] 检查失败: %s', errorMessage(e));
    setState(operation.ready
      ? { ...operation.snapshot, error: errorMessage(e), checking: false }
      : { state: 'error', error: errorMessage(e) });
  };
  try {
    return Promise.resolve(autoUpdater.checkForUpdates()).then(
      result => { finish(); return result; },
      error => { fail(error); finish(); },
    );
  } catch (error) { fail(error); finish(); }
}

// The newer package only replaces the cache after explicit user confirmation.
// electron-updater may remove the old cache once downloading starts; after a
// download failure we must show available, never claim the old file is installable.
function download() {
  if (!deps || !deps.isPackaged || status.state === 'disabled') return { ok: false, error: '开发模式不支持更新' };
  if (!autoUpdater) return { ok: false, error: '当前没有可下载的新版本' };
  if (installing || activeCheck) return { ok: false, error: '正在检查或安装更新，请稍后重试' };
  if (activeDownload) return { ok: true };
  if (status.state === 'ready' && !status.newerVersion) return { ok: true };
  if (status.state !== 'available' && status.state !== 'ready') return { ok: false, error: '当前没有可下载的新版本' };
  const operation = { version: status.newerVersion || status.latest, completed: false };
  activeDownload = operation;
  notified = false;
  dismissedVersion = '';
  setState({ state: 'downloading', latest: operation.version, newerVersion: '', progress: 0, error: '', dismissed: false });
  const finish = (error) => {
    if (activeDownload !== operation) return;
    activeDownload = null;
    if (error && !operation.completed) {
      console.warn('[updater] 下载失败: %s', errorMessage(error));
      setState({ state: 'available', progress: 0, error: errorMessage(error) });
    }
  };
  try { Promise.resolve(autoUpdater.downloadUpdate()).then(() => finish(), error => finish(error)); }
  catch (error) { finish(error); }
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
  if (!autoUpdater || status.state !== 'ready' || activeCheck || activeDownload) return { ok: false, error: '安装包尚未就绪或正在检查更新' };
  if (installing) return { ok: true };
  installing = true;
  try { deps.markQuitting(); } catch (_) {}
  // isSilent=true 静默装(NSIS 侧走 /S,见 build/installer.nsh 对静默路径的放行);
  // isForceRunAfter=true 装完自动拉起新版
  setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { installing = false; setState({ error: errorMessage(e) }); console.error('[updater] quitAndInstall 失败: %s', e.message); } });
  return { ok: true };
}

module.exports = { init, check, download, dismiss, getStatus, quitAndInstall };
