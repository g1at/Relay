// scheduler.js — Relay 定时任务调度器（P0）
//
// 设计要点（详见 docs/定时任务方案.md）：
//   · 单进程内调度：复用 Electron 托盘常驻进程，不引入独立守护进程 / SQLite。
//   · 持久化：userData/schedules.json，原子写（.tmp + rename，UTF-8 无 BOM），与 app-settings 一致。
//   · 单 timer：每次取「最早 nextRunAt」setTimeout 一个；触发后重算、落盘、重新 arm。
//     避免每任务一个 setInterval 在休眠/时钟漂移下累积误差。
//   · 三种调度：cron（5 段，本地时区）/ at（一次性 ISO，跑完 enabled=false）/ every（固定间隔 ms）。
//   · 错过补跑：启动时 nextRunAt<now → 补跑“最近一次”，随后重算未来触发点（不补 N 次，防刷屏）。
//   · 周期整点抖动：cron 命中 :00/:30 时在同一分钟内加随机秒级抖动（错峰但不改变显示的触发分钟）。
//   · 执行：复用注入的 runClaudeJob（headless claude -p），累积流式结果 → 落历史 + 完成通知。
//
// 依赖通过 init(deps) 注入，避免与 main.js 循环引用。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

// ── 注入的依赖（init 时填充）──
let deps = null;
//   deps = {
//     userDataDir: string,                  // app.getPath('userData')
//     runClaudeJob: fn,                      // main.js 的执行核心
//     buildMemoryHint: fn(mode, query),      // 长期记忆注入（相关性裁剪；maintenance 附使用遥测）
//     onSkillCuratorStart / onSkillCuratorDone / onMemoryMaintenanceStart,
//     saveConversation: fn(conv),            // 单条会话落历史（v2 目录式存储,只写当条）
//     loadConversation: fn(id) → conv|null,  // 读单条会话（不存在/被删→null，用于复用同任务会话）
//     notify: fn({title, body}),            // 系统通知
//     refreshTray: fn,                      // 触发/结束时刷新托盘
//     getMainWindow: fn → BrowserWindow|null,// 推送 sched:update 给 renderer
//     readAppSettings, writeAppSettings,    // 开机自启等开关
//   }

let timer = null;            // 当前 arm 的单一 setTimeout
let started = false;
let storeWatcher = null;     // schedules.json 文件监听（感知 MCP server 的外部写入）
let storeWatchDebounce = null;
let missedCatchupTimer = null;
const pendingMissedCatchups = new Map(); // taskId → scheduledFor（启动/恢复合并去重）
let lastObservedStoreFingerprint = null; // 当前已处理内容；自身写先更新它，外部不同内容绝不被时间窗吞掉
const commandChildren = new Set(); // 在跑的 PowerShell 命令；退出时必须回收整棵进程树
const activeRuns = new Map();      // 影子 runId → 可取消执行控制器
const activeWebhookDeliveries = new Map(); // deliveryId → AbortController（退出时中止网络投递）

// setTimeout 上限 ~24.8 天；超长间隔分段重 arm。
const MAX_TIMEOUT = 2 ** 31 - 1;
const RUNS_CAP = 200;        // runs 环形历史上限
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_REQUEST_BYTES = 64 * 1024;
const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
const WEBHOOK_MAX_REDIRECTS = 3;
const WEBHOOK_MAX_RETRIES = 2;

// ─────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────
function storePath() { return path.join(deps.userDataDir, 'schedules.json'); }
function storeFingerprint(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function readStore({ strict = false } = {}) {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)
        || !Array.isArray(d.tasks) || (d.runs != null && !Array.isArray(d.runs))) {
      throw new Error('schedules.json 根结构无效');
    }
    if (d.tasks.some((task) => !task || typeof task !== 'object' || Array.isArray(task)
        || typeof task.id !== 'string' || !task.id.trim()
        || !task.schedule || typeof task.schedule !== 'object' || Array.isArray(task.schedule)
        || !task.action || typeof task.action !== 'object' || Array.isArray(task.action))) {
      throw new Error('schedules.json 包含无效任务');
    }
    if (new Set(d.tasks.map((task) => task.id)).size !== d.tasks.length) {
      throw new Error('schedules.json 包含重复任务 id');
    }
    d.runs = d.runs || [];
    if (d.runs.some((run) => !run || typeof run !== 'object' || Array.isArray(run))) {
      throw new Error('schedules.json 包含无效执行记录');
    }
    return d;
  } catch (e) {
    // 首次启动时文件尚不存在是正常状态；其它 I/O / JSON 错误不能在执行入口伪装成“空任务库”。
    if (e && e.code === 'ENOENT') return { version: 1, tasks: [], runs: [] };
    if (strict) throw e;
    console.warn('[scheduler] 读取 schedules.json 失败: %s', e && e.message ? e.message : e);
    return { version: 1, tasks: [], runs: [] };
  }
}

function writeStore(d) {
  const f = storePath();
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  const raw = JSON.stringify(d, null, 2);
  fs.writeFileSync(tmp, Buffer.from(raw, 'utf8'));
  fs.renameSync(tmp, f);
  lastObservedStoreFingerprint = storeFingerprint(raw);
}

// ─────────────────────────────────────────
// 5 段 cron 解析（本地时区）—— 自写，零依赖
//   字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6, 0=周日)
//   支持：*  a  a-b  a,b,c  */n  a-b/n   组合用逗号
//   语义对齐 Unix cron：dom 与 dow 同时受限时为 OR（任一满足即可）。
// ─────────────────────────────────────────
function parseField(expr, min, max) {
  // 返回一个 Set<number>，或 null 表示“*”（全集，不约束）
  if (expr === '*' || expr === '*/1') return null;
  const allowed = new Set();
  for (const part of String(expr).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron 字段非法: "${part}"`);
    const range = m[1];
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step <= 0) throw new Error(`cron 步长非法: "${part}"`);
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map((x) => parseInt(x, 10));
      lo = a; hi = b;
    } else { lo = hi = parseInt(range, 10); }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段越界: "${part}"`);
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

// 解析整条 cron → { minute,hour,dom,month,dow }（每项为 Set 或 null）。非法抛错。
function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须是 5 段：分 时 日 月 周');
  return {
    minute: parseField(parts[0], 0, 59),
    hour:   parseField(parts[1], 0, 23),
    dom:    parseField(parts[2], 1, 31),
    month:  parseField(parts[3], 1, 12),
    dow:    parseField(parts[4], 0, 6),
    raw: expr,
  };
}

// 某个本地时刻 date 是否命中 cron。
function cronMatches(c, date) {
  const min = date.getMinutes();
  const hr = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();   // 0=周日
  const hit = (set, v) => set === null || set.has(v);
  if (!hit(c.minute, min)) return false;
  if (!hit(c.hour, hr)) return false;
  if (!hit(c.month, mon)) return false;
  // dom/dow 的 OR 语义：两者都被限制时，命中任一即可；只限其一时按该项。
  const domR = c.dom !== null;
  const dowR = c.dow !== null;
  if (domR && dowR) return c.dom.has(dom) || c.dow.has(dow);
  if (domR) return c.dom.has(dom);
  if (dowR) return c.dow.has(dow);
  return true;
}

function cronValues(set, min, max) {
  if (set === null) return Array.from({ length: max - min + 1 }, (_unused, index) => min + index);
  return [...set].sort((a, b) => a - b);
}

// 从 after 之后找下一个 cron 命中时刻（本地时区）。按“日期 + 可选时分”跳跃，
// 稀疏表达式不会再逐分钟扫描一整年、阻塞 Electron 主线程。
function nextCronAfter(c, after) {
  const threshold = new Date(after.getTime());
  threshold.setSeconds(0, 0);
  threshold.setMinutes(threshold.getMinutes() + 1); // 不含 after 本身
  const hours = cronValues(c.hour, 0, 23);
  const minutes = cronValues(c.minute, 0, 59);
  const day = new Date(threshold.getFullYear(), threshold.getMonth(), threshold.getDate());

  // 八年覆盖完整闰年周期，同时仍只有约三千次“按天”判断。
  for (let offset = 0; offset <= 8 * 366; offset += 1) {
    const probeDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
    // 先用当天中午判断月 / 日 / 周，避开 DST 午夜归一化带来的边界噪声。
    const dateProbe = new Date(
      probeDay.getFullYear(), probeDay.getMonth(), probeDay.getDate(), 12, 0, 0, 0,
    );
    const monthHit = c.month === null || c.month.has(dateProbe.getMonth() + 1);
    const domRestricted = c.dom !== null;
    const dowRestricted = c.dow !== null;
    const domHit = !domRestricted || c.dom.has(dateProbe.getDate());
    const dowHit = !dowRestricted || c.dow.has(dateProbe.getDay());
    const dateHit = monthHit && (domRestricted && dowRestricted
      ? (domHit || dowHit)
      : (domHit && dowHit));
    if (!dateHit) continue;

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(
          dateProbe.getFullYear(), dateProbe.getMonth(), dateProbe.getDate(), hour, minute, 0, 0,
        );
        // 本地时区 DST 跳时可能把不存在的 02:xx 归一化到 03:xx；必须复验字段。
        if (candidate < threshold || !cronMatches(c, candidate)) continue;
        return candidate;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────
// nextRunAt 计算（三种调度统一出口）
//   from = 计算基准（通常 now 或上次触发时刻）。返回 ms 时间戳或 null（无未来触发）。
// ─────────────────────────────────────────
function computeNextRun(task, fromMs) {
  const s = task.schedule || {};
  const from = new Date(fromMs);
  try {
    if (s.kind === 'at') {
      const t = parseAtToMs(s.at, fromMs);
      // 一次性：仅当还在未来才返回；过去的由补跑逻辑单独处理。
      return (t && t > fromMs) ? t : null;
    }
    if (s.kind === 'every') {
      const step = Number(s.everyMs);
      if (!Number.isFinite(step) || step < 1000) return null;   // 最小 1s 防风暴
      // 只以“上次计划触发点”推进；手动运行只改 lastRunAt，不得让周期漂移。
      const base = task.scheduledLastRunAt ? Date.parse(task.scheduledLastRunAt) : fromMs;
      if (!Number.isFinite(base)) return fromMs + step;
      if (base > fromMs) return base;
      // O(1) 跳过错过的周期，避免恢复很老的高频任务时长循环阻塞主进程。
      return base + (Math.floor((fromMs - base) / step) + 1) * step;
    }
    if (s.kind === 'cron') {
      const c = parseCron(s.cron);
      let next = nextCronAfter(c, from);
      if (!next) return null;
      let nextMs = next.getTime();
      // 周期整点抖动：命中 :00/:30 且未显式精确 → 加 jitter（默认几分钟内随机）。
      nextMs = applyJitter(task, nextMs);
      return nextMs;
    }
  } catch (e) {
    // 解析失败：记错误，不返回触发点（避免坏任务反复尝试）。
    task.lastError = 'schedule 解析失败: ' + e.message;
  }
  return null;
}

// 解析 at：ISO 绝对时间，或相对 "20m"/"2h"/"30s"/"1d"（相对 fromMs）。
function parseAtToMs(at, fromMs) {
  if (typeof at !== 'string' || !at.trim()) return null;
  const rel = at.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const mult = unit === 's' ? 1e3 : unit === 'm' ? 6e4 : unit === 'h' ? 36e5 : 864e5;
    return fromMs + n * mult;
  }
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

// 抖动：仅对 cron 类、命中整点/半点、且未开 exact 的任务加随机延迟。
//   jitterSec 显式给了就用它的上限；否则默认限制在同一分钟内（0..59s）——
//   仍能错开同时刻的并发请求，但 UI 显示的触发分钟与用户设定一致（设 15:00 就显示 15:00）。
function applyJitter(task, ms) {
  const s = task.schedule || {};
  if (s.exact) return ms;                       // 用户要求精确，不抖
  const d = new Date(ms);
  const onTheDot = d.getMinutes() === 0 || d.getMinutes() === 30;
  if (!onTheDot) return ms;                      // 只对整点/半点抖
  const capSec = Number.isFinite(s.jitterSec) && s.jitterSec > 0 ? s.jitterSec : 59;
  const jitter = Math.floor(Math.random() * capSec * 1000);
  return ms + jitter;
}

// ─────────────────────────────────────────
// 调度循环（单 timer）
// ─────────────────────────────────────────
function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null; }
}

// Windows 上 child.kill() 只保证终止直接子进程，脚本启动的孙进程可能变成孤儿。
// taskkill /T 负责整棵树；启动失败或返回非 0 时再退回 child.kill()。
function terminateCommandTree(child, options = {}) {
  if (!child || child.exitCode !== null) return false;
  const platform = options.platform || process.platform;
  const spawnKiller = typeof options.spawn === 'function' ? options.spawn : spawn;
  if (platform === 'win32' && child.pid) {
    try {
      const killer = spawnKiller('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      const fallback = () => { try { child.kill('SIGTERM'); } catch (_) {} };
      killer.once('error', fallback);
      killer.once('close', (code) => { if (code !== 0) fallback(); });
      if (typeof killer.unref === 'function') killer.unref();
      return true;
    } catch (_) {
      try { child.kill('SIGTERM'); return true; } catch (_) { return false; }
    }
  }
  try { child.kill('SIGTERM'); return true; } catch (_) { return false; }
}

// Electron 退出时停止所有未来调度，并回收命令任务。Claude 执行器由 main.js 统一回收。
function shutdown() {
  started = false;
  clearTimer();
  if (missedCatchupTimer) { clearTimeout(missedCatchupTimer); missedCatchupTimer = null; }
  pendingMissedCatchups.clear();
  if (storeWatchDebounce) { clearTimeout(storeWatchDebounce); storeWatchDebounce = null; }
  if (storeWatcher) {
    try {
      if (typeof storeWatcher.close === 'function') storeWatcher.close();
      else clearInterval(storeWatcher);
    } catch (_) {}
    storeWatcher = null;
  }
  const active = activeRuns.size;
  for (const control of [...activeRuns.values()]) control.cancel();
  const webhookDeliveries = activeWebhookDeliveries.size;
  for (const [eventId, active] of [...activeWebhookDeliveries.entries()]) {
    try { active.controller.abort(); } catch (_) {}
    updateWebhookDeliveryState(active.taskId, eventId, {
      status: 'canceled',
      at: new Date().toISOString(),
      error: '应用退出，投递已取消',
      code: 'WEBHOOK_ABORTED',
    });
  }
  activeWebhookDeliveries.clear();
  const running = commandChildren.size;
  for (const child of [...commandChildren]) terminateCommandTree(child);
  return { terminatedCommands: running, canceledRuns: active, canceledWebhookDeliveries: webhookDeliveries };
}

// 重新计算所有任务的 nextRunAt（仅 enabled 且尚未排定的），落盘，arm 最早的那个。
function reschedule() {
  if (!started) return;
  clearTimer();
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) {
    console.error('[scheduler] 重排失败，任务库结构无效: %s', e.message);
    return;
  }
  const now = Date.now();

  // 确保每个 enabled 任务都有未来 nextRunAt
  let dirty = false;
  for (const task of store.tasks) {
    if (!task.enabled) { if (task.nextRunAt) { task.nextRunAt = null; dirty = true; } continue; }
    const plannedAt = Date.parse(task.nextRunAt);
    if (!task.nextRunAt || !Number.isFinite(plannedAt) || plannedAt <= now) {
      const next = computeNextRun(task, now);
      task.nextRunAt = next ? new Date(next).toISOString() : null;
      if (!task.nextRunAt && task.schedule && task.schedule.kind === 'at') {
        // 一次性且已无未来触发（时间已过且未被补跑命中）→ 自动归档。
        task.enabled = false;
      }
      dirty = true;
    }
  }
  if (dirty) writeStore(store);

  // 找最早的未来触发
  let soonest = null;
  for (const task of store.tasks) {
    if (!task.enabled || !task.nextRunAt) continue;
    const t = Date.parse(task.nextRunAt);
    if (!Number.isFinite(t)) continue;
    if (soonest === null || t < soonest) soonest = t;
  }

  notifyRenderer();   // 列表/倒计时刷新
  updateTrayHint();

  if (soonest === null) return;   // 没有可调度任务，等下次 CRUD 触发 reschedule

  let delay = soonest - Date.now();
  if (delay < 0) delay = 0;
  if (delay > MAX_TIMEOUT) delay = MAX_TIMEOUT;   // 超长间隔分段
  timer = setTimeout(onTick, delay);
}

// timer 到点：跑所有「已到期」的任务，然后重排。
function onTick() {
  timer = null;
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) {
    console.error('[scheduler] 触发失败，任务库结构无效: %s', e.message);
    return;
  }
  const now = Date.now();
  const due = store.tasks.filter(
    (t) => t.enabled && t.nextRunAt && Date.parse(t.nextRunAt) <= now + 1000
  );
  for (const task of due) {
    fireTask(task.id, { trigger: 'timer', scheduledFor: task.nextRunAt }).catch(() => {});   // 异步执行，错误内部已记
  }
  // 立即重排（fireTask 内部会在完成后再 reschedule 一次以反映新 nextRunAt）
  reschedule();
}

// ─────────────────────────────────────────
// 执行单个任务
// ─────────────────────────────────────────
const inflight = new Set();   // 防同一任务并发重入

function canceledResult(summary = '') {
  return { ok: false, canceled: true, error: '任务已取消', summary };
}

// 取消控制器在任务创建影子 run 后立即注册，因此执行前准备阶段也可取消。
// cancel() 幂等：运行中（包括已请求取消）返回 true，收尾后返回 false。
function createRunControl(runId, taskId, actionType) {
  const handlers = new Set();
  let resolveCanceled;
  const whenCanceled = new Promise((resolve) => { resolveCanceled = resolve; });
  const control = {
    runId: runId || null,
    taskId,
    actionType,
    canceled: false,
    finished: false,
    whenCanceled,
    cancel() {
      if (control.finished) return false;
      if (control.canceled) return true;
      control.canceled = true;
      resolveCanceled();
      for (const handler of [...handlers]) {
        try { handler(); } catch (e) {
          console.warn('[scheduler] 取消执行器失败 runId=%s: %s', control.runId, e.message);
        }
      }
      return true;
    },
    onCancel(handler) {
      if (typeof handler !== 'function' || control.finished) return () => {};
      handlers.add(handler);
      if (control.canceled) {
        try { handler(); } catch (e) {
          console.warn('[scheduler] 取消执行器失败 runId=%s: %s', control.runId, e.message);
        }
      }
      return () => handlers.delete(handler);
    },
    finish() {
      if (control.finished) return false;
      control.finished = true;
      handlers.clear();
      if (control.runId && activeRuns.get(control.runId) === control) activeRuns.delete(control.runId);
      return true;
    },
  };
  return control;
}

async function runCancelablePreparation(runContext, callback) {
  if (typeof callback !== 'function' || runWasCanceled(runContext)) return null;
  let pending;
  try { pending = Promise.resolve(callback()); } catch (_) { return null; }
  // 准备钩子没有可中止句柄，但取消不应被它阻塞；catch 保证晚到 reject 不成为未处理异常。
  const guarded = pending.then((value) => ({ value })).catch(() => ({ value: null }));
  const control = runContext && runContext.control;
  const outcome = control && control.whenCanceled
    ? await Promise.race([guarded, control.whenCanceled.then(() => ({ canceled: true }))])
    : await guarded;
  return outcome && !outcome.canceled ? outcome.value : null;
}

function runWasCanceled(runContext) {
  return !!(runContext && runContext.control && runContext.control.canceled);
}

function onRunCancel(runContext, handler) {
  const control = runContext && runContext.control;
  return control && typeof control.onCancel === 'function' ? control.onCancel(handler) : () => {};
}

// 供任务中心按影子 runId 停止定时执行。未知/已结束为 false，已接受取消为 true。
function cancelRun(runId) {
  const key = typeof runId === 'string' ? runId : String(runId || '');
  const control = key ? activeRuns.get(key) : null;
  return control ? control.cancel() : false;
}

// ── Webhook 出站安全边界 ──
// 网址在每次请求（包括重试/重定向）前重新解析，验证所有 DNS 答案后用 lookup 回调锁定本次 IP。
// 这样不会在“安全检查”和真正 connect 之间再做一次可被重绑的 DNS 查询。
function normalizeWebhookConfig(raw) {
  if (!raw) return null;
  const source = typeof raw === 'string' ? { url: raw } : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const url = typeof source.url === 'string' ? source.url.trim().slice(0, 2048) : '';
  if (!url) return null;
  const secret = typeof source.secret === 'string' && source.secret
    ? source.secret.slice(0, 512)
    : null;
  const retries = Number.isFinite(source.maxRetries) ? Math.round(source.maxRetries) : WEBHOOK_MAX_RETRIES;
  return {
    url,
    secret,
    maxRetries: Math.max(0, Math.min(WEBHOOK_MAX_RETRIES, retries)),
  };
}

function webhookConfigError(config) {
  if (!config) return null;
  let url;
  try { url = new URL(config.url); }
  catch (_) { return 'Webhook 地址无效'; }
  if (url.protocol !== 'https:') return 'Webhook 仅允许 HTTPS 地址';
  if (url.username || url.password) return 'Webhook 地址不能包含用户名或密码';
  if (!url.hostname) return 'Webhook 地址缺少主机名';
  if (!config.secret) return 'Webhook 必须配置签名密钥（至少 16 字节）';
  if (config.secret && Buffer.byteLength(config.secret, 'utf8') < 16) {
    return 'Webhook 签名密钥至少需要 16 字节';
  }
  return null;
}

function ipv4Parts(address) {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts : null;
}

function ipv6Bytes(address) {
  let value = String(address || '').toLowerCase().split('%')[0];
  if (net.isIP(value) !== 6) return null;
  if (value.includes('.')) {
    const splitAt = value.lastIndexOf(':');
    const v4 = ipv4Parts(value.slice(splitAt + 1));
    if (!v4) return null;
    value = `${value.slice(0, splitAt)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group, 16), index * 2));
  return out;
}

// 只允许公网单播地址。不仅阻断 RFC1918，也阻断回环、链路本地、CGNAT、文档/测试、
// multicast/reserved 以及可封装 IPv4 的 6to4/NAT64 范围，避免绕过 SSRF 边界。
function isPublicNetworkAddress(address) {
  const v4 = ipv4Parts(String(address || ''));
  if (v4) {
    const [a, b, c] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const v6 = ipv6Bytes(String(address || '').replace(/^\[|\]$/g, ''));
  if (!v6) return false;
  const mapped = v6.subarray(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return isPublicNetworkAddress(`${v6[12]}.${v6[13]}.${v6[14]}.${v6[15]}`);
  // 当前全局单播仅从 2000::/3 放行；其余未指定/本地/组播均失败关闭。
  if ((v6[0] & 0xe0) !== 0x20) return false;
  // IETF Protocol Assignments 2001::/23 内含 Teredo/benchmark/ORCHID/AMT 等非常规全局转发段，
  // 对 webhook 采取保守策略整段阻断，避免未来新增 special-purpose 子段漏网。
  if (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] & 0xfe) === 0x00) return false;
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return false; // 2001:db8::/32
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00
      && (v6[3] & 0xf0) === 0x10) return false; // ORCHIDv1 2001:10::/28
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00
      && (v6[3] & 0xf0) === 0x20) return false; // ORCHIDv2 2001:20::/28
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x00) return false; // Teredo 2001::/32
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x02
      && v6[4] === 0x00 && v6[5] === 0x00) return false; // benchmark 2001:2::/48
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x03) return false; // AMT 2001:3::/32
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x04
      && v6[4] === 0x01 && v6[5] === 0x12) return false; // AS112 2001:4:112::/48
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && (v6[3] & 0xf0) === 0x30) return false; // Drone RID 2001:30::/28
  if (v6[0] === 0x20 && v6[1] === 0x02) return false; // 6to4 可封装私网 IPv4
  if (v6[0] === 0x3f && (v6[1] & 0xf0) === 0xf0) return false; // documentation 3fff::/20
  return true;
}

function normalizedHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function assertWebhookHostname(hostname) {
  const host = normalizedHostname(hostname);
  if (!host) throw webhookError('Webhook 主机名为空', 'WEBHOOK_INVALID_URL');
  const blockedNames = new Set([
    'localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.aws.internal',
    'metadata.azure.internal', 'instance-data', 'instance-data.ec2.internal', 'metadata.oraclecloud.com',
  ]);
  if (blockedNames.has(host) || /\.(?:localhost|local|internal|lan|home)$/.test(host)) {
    throw webhookError('Webhook 目标不能是本机、内网或云 metadata 主机', 'WEBHOOK_BLOCKED_HOST');
  }
  return host;
}

function webhookError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

async function resolveWebhookTarget(url, options = {}) {
  const host = assertWebhookHostname(url.hostname);
  if (net.isIP(host)) {
    if (!isPublicNetworkAddress(host)) {
      throw webhookError('Webhook 目标 IP 不是公网单播地址', 'WEBHOOK_BLOCKED_ADDRESS');
    }
    return { address: host, family: net.isIP(host), hostname: host };
  }
  const lookupAll = options.lookup || dns.promises.lookup;
  let records;
  try { records = await lookupAll(host, { all: true, verbatim: true }); }
  catch (e) { throw webhookError(`Webhook DNS 解析失败: ${e.message}`, 'WEBHOOK_DNS_FAILED', { retryable: true }); }
  if (!Array.isArray(records)) records = records ? [records] : [];
  const normalized = records.map((record) => ({
    address: typeof record === 'string' ? record : record && record.address,
    family: Number(typeof record === 'object' && record ? record.family : net.isIP(record)),
  })).filter((record) => record.address && (record.family === 4 || record.family === 6));
  if (!normalized.length) throw webhookError('Webhook DNS 未返回可用地址', 'WEBHOOK_DNS_EMPTY', { retryable: true });
  if (normalized.some((record) => !isPublicNetworkAddress(record.address))) {
    throw webhookError('Webhook DNS 包含本机、私网或保留地址', 'WEBHOOK_BLOCKED_ADDRESS');
  }
  return { ...normalized[0], hostname: host };
}

function webhookSigningSecret(config) {
  if (config.secret) return config.secret;
  throw webhookError('Webhook 未配置可供接收方验证的签名密钥', 'WEBHOOK_SECRET_UNAVAILABLE');
}

function requestWebhookOnce(url, target, body, secret, context, options = {}) {
  return new Promise((resolve, reject) => {
    const requestFn = options.request || https.request;
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const timestamp = String(now);
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const keyId = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
    const hostname = normalizedHostname(url.hostname);
    let settled = false;
    let timer = null;
    let request = null;
    const signal = options.signal || null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (error) => done(reject, error);
    const onAbort = () => {
      const error = webhookError('Webhook 投递已取消', 'WEBHOOK_ABORTED');
      try { if (request) request.destroy(error); } catch (_) {}
      fail(error);
    };
    if (signal && signal.aborted) { onAbort(); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const requestOptions = {
      protocol: 'https:',
      method: 'POST',
      hostname,
      port: url.port || 443,
      path: `${url.pathname || '/'}${url.search || ''}`,
      servername: net.isIP(hostname) ? undefined : hostname,
      agent: false,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'Relay-Scheduler-Webhook/1.0',
        'x-relay-event': 'scheduled-task.completed',
        'x-relay-delivery-id': context.eventId,
        'x-relay-timestamp': timestamp,
        'x-relay-signature': `sha256=${signature}`,
        'x-relay-key-id': keyId,
      },
      // 上方已验证 DNS 全部答案；连接时钉住其中一个，防止 DNS rebinding/TOCTOU。
      lookup: (_lookupHost, lookupOptions, callback) => {
        const cb = typeof lookupOptions === 'function' ? lookupOptions : callback;
        const all = !!(lookupOptions && typeof lookupOptions === 'object' && lookupOptions.all);
        if (all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      },
    };
    try {
      request = requestFn(requestOptions, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buf.length;
          if (bytes > WEBHOOK_MAX_RESPONSE_BYTES) {
            const error = webhookError('Webhook 响应超过 64 KiB 上限', 'WEBHOOK_RESPONSE_TOO_LARGE');
            try { response.destroy(error); } catch (_) {}
            try { request.destroy(error); } catch (_) {}
            fail(error);
            return;
          }
          chunks.push(buf);
        });
        response.once('error', (e) => {
          if (e && ['WEBHOOK_ABORTED', 'WEBHOOK_RESPONSE_TOO_LARGE'].includes(e.code)) fail(e);
          else fail(webhookError(`Webhook 响应中断: ${e.message}`, 'WEBHOOK_RESPONSE_FAILED', { retryable: true }));
        });
        response.once('end', () => done(resolve, {
          statusCode: Number(response.statusCode || 0),
          headers: response.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    } catch (e) {
      fail(webhookError(`Webhook 请求创建失败: ${e.message}`, 'WEBHOOK_REQUEST_FAILED', { retryable: true }));
      return;
    }
    request.once('error', (e) => {
      if (e && e.code === 'WEBHOOK_ABORTED') fail(e);
      else fail(webhookError(`Webhook 请求失败: ${e.message}`, e.code || 'WEBHOOK_REQUEST_FAILED', { retryable: true }));
    });
    timer = setTimeout(() => {
      const error = webhookError(`Webhook 请求超时（${WEBHOOK_TIMEOUT_MS / 1000}s）`, 'WEBHOOK_TIMEOUT', { retryable: true });
      try { request.destroy(error); } catch (_) {}
      fail(error);
    }, WEBHOOK_TIMEOUT_MS);
    if (typeof request.setTimeout === 'function') {
      request.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
        const error = webhookError(`Webhook 请求超时（${WEBHOOK_TIMEOUT_MS / 1000}s）`, 'WEBHOOK_TIMEOUT', { retryable: true });
        try { request.destroy(error); } catch (_) {}
        fail(error);
      });
    }
    request.end(body);
  });
}

async function requestWebhookFollowingRedirects(config, body, secret, context, options = {}) {
  let current;
  try { current = new URL(config.url); }
  catch (_) { throw webhookError('Webhook 地址无效', 'WEBHOOK_INVALID_URL'); }
  let redirects = 0;
  while (true) {
    if (current.protocol !== 'https:' || current.username || current.password) {
      throw webhookError('Webhook 重定向目标必须是不含身份信息的 HTTPS 地址', 'WEBHOOK_UNSAFE_REDIRECT');
    }
    const target = await resolveWebhookTarget(current, options);
    const response = await requestWebhookOnce(current, target, body, secret, context, options);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) throw webhookError('Webhook 重定向缺少 Location', 'WEBHOOK_BAD_REDIRECT');
      redirects += 1;
      if (redirects > WEBHOOK_MAX_REDIRECTS) {
        throw webhookError(`Webhook 重定向超过 ${WEBHOOK_MAX_REDIRECTS} 次`, 'WEBHOOK_TOO_MANY_REDIRECTS');
      }
      try { current = new URL(location, current); }
      catch (_) { throw webhookError('Webhook 重定向地址无效', 'WEBHOOK_BAD_REDIRECT'); }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const retryable = response.statusCode === 408 || response.statusCode === 425
        || response.statusCode === 429 || response.statusCode >= 500;
      throw webhookError(`Webhook 返回 HTTP ${response.statusCode || '未知'}`, 'WEBHOOK_HTTP_ERROR', {
        httpStatus: response.statusCode || null,
        retryable,
      });
    }
    return { statusCode: response.statusCode, redirects };
  }
}

function webhookAudit(event, context, extra = {}) {
  const entry = {
    event,
    taskId: context.taskId,
    runId: context.runId || null,
    deliveryId: context.eventId,
    destinationHash: context.destinationHash,
    at: new Date().toISOString(),
    ...extra,
  };
  try {
    if (deps && typeof deps.webhookAudit === 'function') deps.webhookAudit(entry);
    else console.info('[scheduler:webhook] %s', JSON.stringify(entry));
  } catch (_) {}
}

async function deliverWebhook(config, payload, context, options = {}) {
  const invalid = webhookConfigError(config);
  if (invalid) {
    return { status: 'failed', at: new Date().toISOString(), attempts: 0, httpStatus: null, error: invalid };
  }
  let secret;
  try { secret = webhookSigningSecret(config); }
  catch (e) {
    return { status: 'failed', at: new Date().toISOString(), attempts: 0, httpStatus: null, error: e.message };
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > WEBHOOK_MAX_REQUEST_BYTES) {
    return { status: 'failed', at: new Date().toISOString(), attempts: 0, httpStatus: null, error: 'Webhook 请求体超过 64 KiB 上限' };
  }
  const retries = Math.max(0, Math.min(WEBHOOK_MAX_RETRIES, Number(config.maxRetries) || 0));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError = null;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal && options.signal.aborted) {
      return { status: 'canceled', at: new Date().toISOString(), attempts: attempt, httpStatus: null, error: '应用退出，投递已取消' };
    }
    attemptsMade = attempt + 1;
    webhookAudit('attempt', context, { attempt: attempt + 1 });
    try {
      const response = await requestWebhookFollowingRedirects(config, body, secret, context, options);
      return {
        status: 'delivered', at: new Date().toISOString(), attempts: attempt + 1,
        httpStatus: response.statusCode, redirects: response.redirects, error: null,
      };
    } catch (e) {
      lastError = e;
      if (!e.retryable || attempt >= retries || (options.signal && options.signal.aborted)) break;
      const delay = Math.min(2000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 100);
      webhookAudit('retry', context, { attempt: attempt + 1, code: e.code || 'WEBHOOK_ERROR', delayMs: delay });
      await sleep(delay);
    }
  }
  return {
    status: options.signal && options.signal.aborted ? 'canceled' : 'failed',
    at: new Date().toISOString(),
    attempts: attemptsMade,
    httpStatus: lastError && lastError.httpStatus || null,
    error: String(lastError && lastError.message || 'Webhook 投递失败').slice(0, 240),
    code: lastError && lastError.code || 'WEBHOOK_FAILED',
  };
}

function buildWebhookPayload(task, result, runMeta) {
  return {
    schemaVersion: 1,
    event: 'scheduled-task.completed',
    eventId: runMeta.eventId,
    emittedAt: new Date().toISOString(),
    task: { id: task.id, name: String(task.name || '').slice(0, 80) },
    run: {
      runId: runMeta.runId || null,
      trigger: runMeta.trigger || 'timer',
      scheduledFor: runMeta.scheduledFor || null,
      startedAt: new Date(runMeta.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      status: result.canceled ? 'canceled' : (result.ok ? 'ok' : 'error'),
      summary: String(result.summary || '').slice(0, 1000),
      error: result.ok ? null : String(result.error || '').slice(0, 1000),
      conversationId: result.conversationId || null,
      conversationKind: result.conversationKind || null,
      artifactCount: Array.isArray(result.paths) ? result.paths.length : 0,
    },
  };
}

function updateWebhookDeliveryState(taskId, eventId, outcome) {
  try {
    const store = readStore({ strict: true });
    const run = store.runs.find((item) => item && item.delivery && item.delivery.webhook
      && item.delivery.webhook.eventId === eventId);
    if (run) run.delivery.webhook = { ...run.delivery.webhook, ...outcome, eventId };
    const task = store.tasks.find((item) => item.id === taskId);
    if (task && (!task.lastDelivery || !task.lastDelivery.webhook
        || task.lastDelivery.webhook.eventId === eventId)) {
      task.lastDelivery = { ...(task.lastDelivery || {}), webhook: { ...outcome, eventId } };
    }
    if (run || task) writeStore(store);
    notifyRenderer();
  } catch (e) {
    console.warn('[scheduler:webhook] 保存投递状态失败 taskId=%s deliveryId=%s: %s', taskId, eventId, e.message);
  }
}

function prepareWebhookDelivery(task, result, runMeta) {
  const config = normalizeWebhookConfig(task && task.delivery && task.delivery.webhook);
  if (!config) return null;
  const eventId = crypto.randomUUID();
  let destinationHash = 'invalid';
  try { destinationHash = crypto.createHash('sha256').update(config.url).digest('hex').slice(0, 16); } catch (_) {}
  const context = { taskId: task.id, runId: runMeta.runId || null, eventId, destinationHash };
  const pending = {
    status: 'pending', eventId, queuedAt: new Date().toISOString(), attempts: 0,
    httpStatus: null, error: null, destinationHash,
  };
  const payload = buildWebhookPayload(task, result, { ...runMeta, eventId });
  return {
    pending,
    start() {
      const controller = new AbortController();
      activeWebhookDeliveries.set(eventId, { controller, taskId: task.id });
      webhookAudit('queued', context);
      Promise.resolve().then(() => deliverWebhook(config, payload, context, {
        ...((deps && deps.webhookRequestOptions) || {}),
        signal: controller.signal,
      })).then((outcome) => {
        const finalized = { ...pending, ...outcome, eventId, destinationHash };
        webhookAudit(finalized.status, context, {
          attempts: finalized.attempts,
          httpStatus: finalized.httpStatus,
          code: finalized.code || null,
        });
        updateWebhookDeliveryState(task.id, eventId, finalized);
      }).catch((e) => {
        const failed = {
          ...pending, status: 'failed', at: new Date().toISOString(), eventId, destinationHash,
          error: String(e && e.message || e).slice(0, 240), code: e && e.code || 'WEBHOOK_FAILED',
        };
        webhookAudit('failed', context, { code: failed.code });
        updateWebhookDeliveryState(task.id, eventId, failed);
      }).finally(() => activeWebhookDeliveries.delete(eventId));
    },
  };
}

async function fireTask(taskId, opts = {}) {
  if (inflight.has(taskId)) {
    return { ok: false, code: 'TASK_RUNNING', error: '任务正在运行，请稍候' };
  }
  const startedAt = Date.now();
  let shadowRunId = null;
  let shadowFinishAttempted = false;
  let runControl = null;
  let resourceLease = null;
  let skillCuratorContext = null;
  let skillCuratorFinalized = false;
  let store;
  try {
    store = readStore({ strict: true });
  } catch (e) {
    console.warn('[scheduler] 运行任务前读取存储失败 taskId=%s: %s', taskId, e.message);
    return { ok: false, code: 'STORE_READ_FAILED', error: '读取定时任务失败，请稍后重试' };
  }
  let task = store.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: '任务不存在' };
  // 投递配置以“本次执行启动时”的快照为准；运行中编辑只影响下一次。
  const deliveryTaskSnapshot = {
    id: task.id,
    name: task.name,
    delivery: { webhook: normalizeWebhookConfig(task.delivery && task.delivery.webhook) },
  };
  const scheduledFor = opts.trigger === 'manual'
    ? null
    : (opts.scheduledFor || task.nextRunAt || null);
  inflight.add(taskId);

  // 在执行前固定目录对应的会话 ID；首次落历史复用它，失败/重试也不会散落到新目录。
  if (!task.builtin && deps && typeof deps.resolveWorkspace === 'function') {
    const previous = task.lastConvId && typeof deps.loadConversation === 'function'
      ? deps.loadConversation(task.lastConvId) : null;
    if (!task.workspaceConversationId || (task.lastConvId && !previous && task.workspaceConversationId === task.lastConvId)) {
      task.workspaceConversationId = previous ? task.lastConvId : crypto.randomUUID();
    }
  }

  // 推进调度状态：先把 nextRunAt 推到未来（避免重入），lastRunAt 置当前。
  task.lastRunAt = new Date(startedAt).toISOString();
  task.runCount = (task.runCount || 0) + 1;
  if (opts.trigger === 'manual') {
    task.manualLastRunAt = task.lastRunAt;
    task.manualRunCount = (task.manualRunCount || 0) + 1;
    // 手动运行不移动原有的 nextRunAt，也不消费一次性 at 计划。
  } else if (task.schedule && task.schedule.kind === 'at' && !opts.keepEnabled) {
    task.scheduledLastRunAt = scheduledFor || task.lastRunAt;
    task.enabled = false;          // 一次性跑完归档
    task.nextRunAt = null;
  } else {
    task.scheduledLastRunAt = scheduledFor || task.lastRunAt;
    const next = computeNextRun(task, startedAt + 1000);
    task.nextRunAt = next ? new Date(next).toISOString() : null;
  }
  try {
    writeStore(store);
  } catch (e) {
    inflight.delete(taskId);
    console.warn('[scheduler] 保存任务启动状态失败 taskId=%s: %s', taskId, e.message);
    return { ok: false, code: 'STORE_WRITE_FAILED', error: '保存定时任务状态失败，请稍后重试' };
  }
  if (deps && typeof deps.taskRunStart === 'function') {
    try {
      shadowRunId = deps.taskRunStart({
        task,
        trigger: opts.trigger || 'timer',
        scheduledFor,
        startedAt,
      }) || null;
    } catch (e) { console.warn('[scheduler] 创建影子任务失败 taskId=%s: %s', taskId, e.message); }
  }
  runControl = createRunControl(shadowRunId, taskId, (task.action || {}).type || 'chat');
  if (shadowRunId) activeRuns.set(shadowRunId, runControl);
  notifyRenderer();
  if (typeof opts.onStarted === 'function') {
    try { opts.onStarted({ ok: true, code: 'TASK_STARTED' }); } catch (_) {}
  }

  try {
    if (shadowRunId && deps && typeof deps.taskRunAcquire === 'function') {
      resourceLease = await deps.taskRunAcquire(
        shadowRunId,
        (task.action || {}).type || 'chat',
        task.id,
      );
      if (!resourceLease && runControl) runControl.cancel();
    }
    // 技能体检只在隔离工作区运行。准备钩子返回一次性 prompt/cwd；拿不到隔离上下文时
    // 必须失败关闭，绝不能退回正式技能目录直接修改。
    if (task && task.builtin === 'skill-curator' && typeof deps.onSkillCuratorStart === 'function') {
      skillCuratorContext = await runCancelablePreparation(
        { runId: shadowRunId, control: runControl }, deps.onSkillCuratorStart,
      );
      if (skillCuratorContext) {
        task = {
          ...task,
          action: {
            ...(task.action || {}),
            prompt: skillCuratorContext.prompt || '',
            workingDir: skillCuratorContext.stagingRoot || null,
            canUseTool: skillCuratorContext.canUseTool,
          },
        };
      }
    }
    if (task && task.builtin === 'memory-consolidate' && typeof deps.onMemoryMaintenanceStart === 'function') {
      await runCancelablePreparation({ runId: shadowRunId, control: runControl }, deps.onMemoryMaintenanceStart);
    }

    let result;
    try {
      if (task && task.builtin === 'skill-curator' && !skillCuratorContext) {
        result = runWasCanceled({ control: runControl })
          ? canceledResult()
          : { ok: false, error: '无法创建隔离的技能体检工作区' };
      } else {
        result = await execAction(task, {
          runId: shadowRunId,
          control: runControl,
          resourceSignal: resourceLease && resourceLease.signal || null,
        });
      }
      task = refetch(taskId);   // 期间可能被编辑，重新读
      if (task) {
        task.lastStatus = result.canceled ? 'canceled' : (result.ok ? 'ok' : 'error');
        task.lastError = result.ok ? null : (result.error || '执行失败');
        persistTask(task);
      }
      // 无论成功、失败还是取消都交回 main 清理隔离目录；只有成功结果会生成待审核草稿。
      if (skillCuratorContext && typeof deps.onSkillCuratorDone === 'function') {
        try { await deps.onSkillCuratorDone(result, skillCuratorContext); } catch (_) {}
        skillCuratorFinalized = true;
      }
    } catch (e) {
      const wasCanceled = !!(runControl && runControl.canceled);
      task = refetch(taskId);
      if (task) {
        task.lastStatus = wasCanceled ? 'canceled' : 'error';
        task.lastError = wasCanceled ? '任务已取消' : e.message;
        persistTask(task);
      }
      result = wasCanceled ? canceledResult() : { ok: false, error: e.message };
    }

    if (shadowRunId && deps && typeof deps.taskRunFinish === 'function') {
      shadowFinishAttempted = true;
      try {
        deps.taskRunFinish(shadowRunId, result);
      } catch (e) { console.warn('[scheduler] 结束影子任务失败 runId=%s: %s', shadowRunId, e.message); }
    }

    // Webhook 与任务本体是两条独立状态线：此时影子任务已终态，
    // 投递以 pending 入库后在后台进行，投递失败绝不会把已成功的任务改成 error。
    const webhookDelivery = prepareWebhookDelivery(deliveryTaskSnapshot, result, {
      runId: shadowRunId,
      trigger: opts.trigger || 'timer',
      scheduledFor,
      startedAt,
    });
    if (webhookDelivery) {
      try {
        const current = refetch(taskId);
        if (current) {
          current.lastDelivery = {
            ...(current.lastDelivery || {}),
            webhook: webhookDelivery.pending,
          };
          persistTask(current);
        }
      } catch (e) {
        console.warn('[scheduler:webhook] 保存 pending 状态失败 taskId=%s: %s', taskId, e.message);
      }
    }

    // 记 runs 环形历史。历史写入失败不应把任务永久卡在“运行中”。
    try {
      appendRun({
        taskId,
        runId: shadowRunId,
        at: new Date(startedAt).toISOString(),
        trigger: opts.trigger || 'timer',
        scheduledFor,
        status: result.canceled ? 'canceled' : (result.ok ? 'ok' : 'error'),
        ms: Date.now() - startedAt,
        summary: (result.ok || result.canceled) ? (result.summary || '') : '',
        error: result.ok ? null : (result.error || ''),
        conversationId: result.conversationId || null,
        conversationKind: result.conversationKind || null,
        delivery: webhookDelivery ? { webhook: webhookDelivery.pending } : null,
      });
    } catch (e) {
      console.warn('[scheduler] 写入任务历史失败 taskId=%s: %s', taskId, e.message);
    }
    if (webhookDelivery) webhookDelivery.start();

    // 完成通知
    const t2 = refetch(taskId);
    if (t2 && t2.delivery && t2.delivery.notify !== false) {
      const title = result.canceled ? `定时任务已取消：${t2.name || taskId}`
        : result.ok ? `定时任务完成：${t2.name || taskId}` : `定时任务失败：${t2.name || taskId}`;
      const body = result.canceled ? '任务已按用户要求停止'
        : result.ok ? (result.summary || '已执行完成').slice(0, 180)
                    : ('错误：' + (result.error || '').slice(0, 180));
      try { deps.notify({ title, body }); } catch (_) {}
    }
    return result;
  } finally {
    if (skillCuratorContext && !skillCuratorFinalized && deps
        && typeof deps.onSkillCuratorDone === 'function') {
      try {
        await deps.onSkillCuratorDone(
          runControl && runControl.canceled ? canceledResult() : { ok: false, error: '技能体检异常中断' },
          skillCuratorContext,
        );
      } catch (_) {}
    }
    if (shadowRunId && !shadowFinishAttempted && deps && typeof deps.taskRunFinish === 'function') {
      shadowFinishAttempted = true;
      const fallback = runControl && runControl.canceled
        ? canceledResult()
        : { ok: false, error: '任务在结束前异常中断' };
      try { deps.taskRunFinish(shadowRunId, fallback); } catch (_) {}
    }
    if (shadowRunId && deps && typeof deps.taskRunRelease === 'function') {
      try { deps.taskRunRelease(shadowRunId); } catch (_) {}
    }
    if (runControl) runControl.finish();
    inflight.delete(taskId);
    try { reschedule(); } catch (e) { console.warn('[scheduler] 任务完成后重排失败: %s', e.message); }
  }
}

// 真正执行动作。chat（runClaudeJob）/ image（generateImage）/ command（PowerShell 脚本）。
function execAction(task, runContext = {}) {
  if (runWasCanceled(runContext)) return Promise.resolve(canceledResult());
  const a = task.action || {};
  if (a.type === 'image') return execImage(task, runContext);
  if (a.type === 'command') return execCommand(task, runContext);
  return execChat(task, runContext);
}

function reportTaskRunPhase(runContext, phase, label) {
  if (!runContext || !runContext.runId || !deps || typeof deps.taskRunPhase !== 'function') return;
  try { deps.taskRunPhase(runContext.runId, phase, label); } catch (_) {}
}

// 定时对话与命令共用失败关闭的目录边界：只有“未设置”才回退主目录。
function resolveScheduledWorkingDir(action, taskLabel, task = null) {
  if (task && !task.builtin && deps && typeof deps.resolveWorkspace === 'function') {
    try {
      return { ok: true, ...deps.resolveWorkspace({
        conversationId: task.workspaceConversationId || task.lastConvId || `scheduled-${task.id}`,
        workingDir: action && action.workingDir, mode: action && action.mode, agentName: action && action.agentName,
      }) };
    } catch (error) { return { ok: false, error: `${taskLabel}工作目录不可用：${error.message}` }; }
  }
  const configured = action && typeof action.workingDir === 'string' && action.workingDir
    ? action.workingDir
    : null;
  if (!configured) return { ok: true, cwd: os.homedir(), validWorkingDir: null };
  const errorPrefix = `${taskLabel}工作目录不可用：${configured}`;
  if (!path.isAbsolute(configured)) {
    return { ok: false, error: `${errorPrefix}（必须是绝对路径）` };
  }

  let stat;
  try {
    stat = fs.statSync(configured);
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? '路径不存在' : '无法访问';
    return { ok: false, error: `${errorPrefix}（${reason}）` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `${errorPrefix}（不是目录）` };
  }
  try {
    // 工作目录可以是只读的，但必须能读取并进入；否则不应降级到其它目录执行。
    fs.accessSync(configured, fs.constants.R_OK | fs.constants.X_OK);
  } catch (_) {
    return { ok: false, error: `${errorPrefix}（无法访问）` };
  }
  return { ok: true, cwd: configured, validWorkingDir: configured };
}

// 命令任务：到点跑一段 PowerShell 脚本，不起模型。安全面最大，受全局开关 allowCommandTasks 闸控。
//   捕获 stdout/stderr，带超时（防卡死）。结果进 runs 历史 + 通知；不落聊天历史。
function execCommand(task, runContext = {}) {
  return new Promise((resolve) => {
    reportTaskRunPhase(runContext, 'tool', '正在运行命令');
    // 安全闸①：全局开关默认关，关时直接拒绝执行（不只是 UI 拦，执行侧也兜底）。
    let allow = false;
    try { allow = !!(deps.readAppSettings() || {}).allowCommandTasks; } catch (_) {}
    if (!allow) { resolve({ ok: false, error: '命令任务被禁用（在 设置 → 常规 → 允许命令任务 中开启）' }); return; }

    const a = task.action || {};
    const script = String(a.command || '').trim();
    if (!script) { resolve({ ok: false, error: '命令脚本为空' }); return; }

    let child, out = '', err = '', settled = false, timedOut = false, cancelRequested = false;
    let killer = null, killGrace = null, removeCancel = () => {};
    const TIMEOUT = 120000;   // 120s 看门狗，超时杀进程
    const OUTPUT_LIMIT = 256 * 1024;
    const appendBounded = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
    };
    const tail = (s) => { s = (s || '').trim(); return s.length > 200 ? s.slice(-200) : s; };
    const done = (ok, error, summary, extra = null) => {
      if (settled) return; settled = true;
      if (killer) { clearTimeout(killer); killer = null; }
      if (killGrace) { clearTimeout(killGrace); killGrace = null; }
      removeCancel();
      resolve({ ok, error, summary, ...(extra || {}) });
    };
    if (runWasCanceled(runContext)) { done(false, '任务已取消', '', { canceled: true }); return; }
    const workingDir = resolveScheduledWorkingDir(a, '命令', task);
    if (!workingDir.ok) { done(false, workingDir.error); return; }
    try {
      // -NoProfile 不加载用户 profile；-NonInteractive 禁交互；脚本经 -Command 传入。
      //   cwd 用经严格校验的显式工作目录；未设置时才使用用户主目录。
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { cwd: workingDir.cwd, shell: false, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { done(false, 'PowerShell 启动失败: ' + e.message); return; }

    commandChildren.add(child);
    killer = setTimeout(() => {
      timedOut = true;
      terminateCommandTree(child);
      // 正常等待进程树退出；极端情况下 5 秒后先释放调度任务，退出清理仍会再次尝试回收。
      killGrace = setTimeout(() => {
        done(false, `执行超时（${TIMEOUT / 1000}s，已请求终止进程树）`);
      }, 5000);
      if (killGrace && typeof killGrace.unref === 'function') killGrace.unref();
    }, TIMEOUT);
    if (killer && typeof killer.unref === 'function') killer.unref();
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out = appendBounded(out, d); }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err = appendBounded(err, d); }); }
    child.on('close', (code) => {
      commandChildren.delete(child);
      // summary 取 stdout 末尾若干字符（runs 历史里展示）；非 0 退出码视为失败。
      if (cancelRequested || runWasCanceled(runContext)) {
        done(false, '任务已取消', tail(out), { canceled: true });
        return;
      }
      if (timedOut) { done(false, `执行超时（${TIMEOUT / 1000}s，进程树已终止）`, tail(out)); return; }
      if (code === 0) done(true, null, tail(out) || '（无输出）');
      else done(false, (tail(err) || tail(out) || `退出码 ${code}`), tail(out));
    });
    child.on('error', (e) => {
      commandChildren.delete(child);
      if (cancelRequested || runWasCanceled(runContext)) {
        done(false, '任务已取消', tail(out), { canceled: true });
      } else {
        done(false, 'PowerShell 执行错误: ' + e.message);
      }
    });
    removeCancel = onRunCancel(runContext, () => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      terminateCommandTree(child);
      if (settled) return;
      // 等待 close 确认直接子进程已退出；异常执行器最多占用收尾 5 秒。
      killGrace = setTimeout(() => {
        done(false, '任务已取消', tail(out), { canceled: true });
      }, 5000);
      if (killGrace && typeof killGrace.unref === 'function') killGrace.unref();
    });
  });
}

function agentFrontmatterName(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').slice(0, 16 * 1024);
    const block = raw.match(/^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!block) return '';
    const line = block[1].split(/\r?\n/).find((item) => /^name\s*:/.test(item));
    if (!line) return '';
    return line.replace(/^name\s*:\s*/, '').trim().replace(/^["']|["']$/g, '');
  } catch (_) { return ''; }
}

function findScheduledAgentFile(agentDir, requestedName) {
  let entries;
  try { entries = fs.readdirSync(agentDir, { withFileTypes: true }); }
  catch (e) { throw new Error(`Agent 目录不可读：${e.message}`); }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(agentDir, entry.name);
    const basename = entry.name.replace(/\.md$/i, '');
    if (basename === requestedName || agentFrontmatterName(file) === requestedName) return file;
  }
  return null;
}

// 与交互对话使用同样的 Agent 启动语义：验证用户级 Agent 文件、加载项目资源根，
// 并明确指示 headless Claude 必须调用指定 subagent。任何配置缺失都失败关闭，不允许静默退化 plain。
function prepareScheduledAgentLaunch(action, launch) {
  if (action.mode !== 'agent') return { ...launch, agentProjectRoot: null };
  const agentName = typeof action.agentName === 'string' ? action.agentName.trim() : '';
  if (!agentName) throw new Error('Agent 模式未指定 Agent');
  if (agentName.length > 120 || /[\\/\0\r\n]/.test(agentName) || agentName === '.' || agentName === '..') {
    throw new Error('Agent 名称无效');
  }
  const agentDir = deps && typeof deps.agentDir === 'string' && deps.agentDir
    ? deps.agentDir
    : path.join(os.homedir(), '.claude', 'agents');
  const agentFile = findScheduledAgentFile(agentDir, agentName);
  if (!agentFile) throw new Error(`找不到 Agent「${agentName}」，请在设置中重新导入`);

  let { cwd, validWorkingDir, prompt } = launch;
  let agentProjectRoot = null;
  try {
    const settings = deps && typeof deps.readAppSettings === 'function' ? (deps.readAppSettings() || {}) : {};
    const projectRoot = settings.agentProjects && settings.agentProjects[agentName];
    if (typeof projectRoot === 'string' && fs.existsSync(projectRoot) && fs.statSync(projectRoot).isDirectory()) {
      agentProjectRoot = projectRoot;
      if (!validWorkingDir) { cwd = projectRoot; validWorkingDir = projectRoot; }
    }
  } catch (e) {
    console.warn('[scheduler] Agent 项目资源校验失败 agent=%s: %s', agentName, e.message);
  }

  prompt = `请使用「${agentName}」子智能体(subagent)来完成下面的任务：\n\n${prompt}`;
  if (agentProjectRoot && path.resolve(cwd) !== path.resolve(agentProjectRoot)) {
    let entriesHint = '';
    try {
      const names = fs.readdirSync(agentProjectRoot, { withFileTypes: true })
        .filter((entry) => !['.claude', '__MACOSX', '.DS_Store'].includes(entry.name))
        .slice(0, 30)
        .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
      if (names.length) entriesHint = `\n该目录下的资源包括：${names.join('、')}`;
    } catch (_) {}
    prompt = `${prompt}\n\n---\n[重要·资源读取规则] 该 Agent 的配套资源位于：\n${agentProjectRoot}${entriesHint}\n\n读取配套资源时必须使用上述绝对路径；产出文件仍写入当前工作目录。`;
  }
  return { cwd, validWorkingDir, prompt, agentProjectRoot, agentFile };
}

function scheduledConversationContext(task, maxChars = 18000) {
  if (!deps || typeof deps.loadConversation !== 'function') return '';
  const fresh = refetch(task.id) || task;
  if (!fresh || !fresh.lastConvId) return '';
  let conv = null;
  try { conv = deps.loadConversation(fresh.lastConvId); } catch (_) { conv = null; }
  const turns = conv && Array.isArray(conv.turns) ? conv.turns : [];
  if (!turns.length) return '';
  const chunks = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0 && chunks.length < 16; i--) {
    const turn = turns[i] && typeof turns[i] === 'object' ? turns[i] : {};
    const user = String(turn.user || '').trim();
    const assistant = String(turn.assistant || '').trim();
    if (!user && !assistant) continue;
    const chunk = `${user ? `用户：${user}` : ''}${user && assistant ? '\n' : ''}${assistant ? `助手：${assistant}` : ''}`;
    if (size && size + chunk.length > maxChars) break;
    chunks.unshift(chunk.slice(0, maxChars));
    size += chunk.length;
  }
  if (!chunks.length) return '';
  return [
    '[Relay 会话迁移]',
    '本任务的服务商路由或工作目录已调整，旧 Claude session 不能在新执行环境恢复。请基于以下 Relay 历史文本继续执行，不要把这段说明复述给用户：',
    '',
    chunks.join('\n\n'),
  ].join('\n');
}

// chat：把完整 prompt 交给 runClaudeJob。Agent 模式在执行前会被严格校验与包装。
function execChat(task, runContext = {}) {
  return new Promise((resolve) => {
    reportTaskRunPhase(runContext, 'preparing', '正在准备定时对话');
    const a = task.action || {};
    const workingDir = resolveScheduledWorkingDir(a, '定时对话', task);
    if (!workingDir.ok) {
      resolve({
        ok: false,
        error: workingDir.error,
        summary: '',
        conversationId: null,
        conversationKind: null,
      });
      return;
    }
    let actionPrompt = task.builtin === 'memory-consolidate' && deps?.memoryConsolidationPrompt
      ? deps.memoryConsolidationPrompt : a.prompt || '';
    let cwd = workingDir.cwd;
    let validWorkingDir = workingDir.validWorkingDir;
    // 持久 session：sessionRef 必须同时带服务商路由指纹。路由已变化或旧版本没有
    // 指纹时，先把已有 Relay 历史作为文本前文带入，再在目标服务商创建新 session。
    const storedSessionId = (a.sessionMode === 'session' && a.sessionRef) ? a.sessionRef : null;
    const sessionRoute = normalizeSessionRoute(a.sessionRoute);
    let targetSessionRoute = null;
    try {
      targetSessionRoute = deps && typeof deps.resolveChatRoute === 'function'
        ? normalizeSessionRoute(deps.resolveChatRoute(a.model)) : null;
    } catch (_) {}
    const providerRouteChanged = !!(storedSessionId && targetSessionRoute
      && !sessionRoutesEqual(sessionRoute, targetSessionRoute));
    const workspaceRouteChanged = !!(storedSessionId && (workingDir.workspaceChanged || workingDir.needsContext
      || (deps && typeof deps.acceptsWorkspaceSession === 'function'
        && !deps.acceptsWorkspaceSession(workingDir.conversationId, storedSessionId))));
    const sessionId = providerRouteChanged || workspaceRouteChanged ? null : storedSessionId;
    if (providerRouteChanged || workspaceRouteChanged || workingDir.needsContext) {
      const historyContext = scheduledConversationContext(task);
      if (historyContext) {
        actionPrompt = `${historyContext}\n\n${actionPrompt}`.trim();
      }
    }

    // 长期记忆注入：a.memory = 'off' | 'read'(默认) | 'readwrite'。
    //   默认只读——读让产出贴合用户偏好（普惠），写有污染记忆库的风险（周期任务跑得多，
    //   偶发把当次产出当长期事实写库）。readwrite（→ full 提示词，含写规则）留给记忆整理任务。
    //   只有启用记忆的任务才授权记忆目录；off 模式既不注入提示，也不追加目录。
    const memMode = task.builtin === 'skill-curator'
      ? 'off'
      : (['off', 'read', 'readwrite'].includes(a.memory) ? a.memory : 'read');
    let memHint = '';
    if (memMode !== 'off' && deps && typeof deps.buildMemoryHint === 'function') {
      try {
        const hintMode = task.builtin === 'memory-consolidate'
          ? 'maintenance'
          : (memMode === 'readwrite' ? 'full' : 'read');
        memHint = deps.buildMemoryHint(hintMode, actionPrompt, { projectId: workingDir.projectId || null,
          sourceRef: 'scheduled:' + task.id + '/run:' + (runContext.runId || '') }) || '';
      } catch (_) {}
    }

    let assistantText = '';
    let realSessionId = sessionId;
    let launchedSessionRoute = targetSessionRoute || sessionRoute;
    let sawSessionId = false;
    let settled = false, cancelRequested = false;
    let watchdog = null, cancelGrace = null, removeCancel = () => {};
    let runningChild = null;
    const finish = (ok, error, extra = null) => {
      if (settled) return; settled = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (cancelGrace) { clearTimeout(cancelGrace); cancelGrace = null; }
      try { removeCancel(); } catch (_) {}
      // 持久 session：session_id 与创建它的服务商指纹作为一个原子引用保存。
      const routeChanged = !sessionRoutesEqual(launchedSessionRoute, a.sessionRoute);
      if (a.sessionMode === 'session' && realSessionId
          && (realSessionId !== a.sessionRef || routeChanged)) {
        try {
          const t = refetch(task.id);
          if (t) {
            t.action = t.action || {};
            t.action.sessionRef = realSessionId;
            t.action.sessionRoute = normalizeSessionRoute(launchedSessionRoute);
            persistTask(t);
          }
        } catch (persistError) {
          // 会话引用只是下轮续接优化；保存失败不能阻断本轮 Promise 的终态。
          console.warn('[scheduler] 保存定时会话引用失败 taskId=%s: %s', task.id, persistError.message);
        }
      }
      let conversationId = null;
      if (ok && (task.delivery || {}).saveToHistory !== false) {
        try {
          conversationId = saveResultToHistory(task, assistantText, realSessionId, launchedSessionRoute);
        } catch (_) {}
      }
      resolve({
        ok,
        error,
        summary: assistantText.trim().slice(0, 200),
        conversationId,
        conversationKind: conversationId ? 'chat' : null,
        ...(extra || {}),
      });
    };

    if (runWasCanceled(runContext)) { finish(false, '任务已取消', { canceled: true }); return; }
    let agentProjectRoot = null;
    try {
      const prepared = prepareScheduledAgentLaunch(a, { cwd, validWorkingDir, prompt: actionPrompt });
      cwd = prepared.cwd;
      validWorkingDir = prepared.validWorkingDir;
      actionPrompt = prepared.prompt;
      agentProjectRoot = prepared.agentProjectRoot;
    } catch (e) {
      finish(false, `Agent 配置错误：${e.message}`);
      return;
    }
    try {
      const launched = runClaudeJobSafe({
        runId: runContext.runId || undefined,
        prompt: actionPrompt + memHint,
        cwd, validWorkingDir,
        conversationId: workingDir.conversationId || task.lastConvId || null,
        agentProjectRoot,
        model: a.model,
        sessionId,
        sessionRoute,
        background: true,
        includeMemoryDirectory: memMode !== 'off',
        memoryMode: memMode === 'readwrite' ? 'full' : memMode,
        memoryContext: { projectId: workingDir.projectId || null, sourceRef: 'scheduled:' + task.id + '/run:' + (runContext.runId || ''),
          mode: task.builtin === 'memory-consolidate' ? 'maintenance' : (memMode === 'readwrite' ? 'full' : memMode) },
        tools: task.builtin === 'skill-curator' ? ['Read', 'Write', 'Edit', 'Glob', 'Grep'] : undefined,
        canUseTool: typeof a.canUseTool === 'function' ? a.canUseTool : null,
        // 保存并启用普通定时任务就是一次性自动化授权：后续触发不再逐项审批。
        // 受限内置任务仍显式使用 default，并由自己的 canUseTool 守卫收窄权限。
        permissionMode: task.builtin === 'skill-curator' ? 'default' : 'bypassPermissions',
        onEvent: (evt) => {
          try {
            if (runContext.runId && deps && typeof deps.taskRunEvent === 'function') {
              try { deps.taskRunEvent(runContext.runId, evt); } catch (_) {}
            }
            // 累积 assistant 文本（stream-json：assistant 消息块）
            if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
              for (const b of evt.message.content) {
                if (b && b.type === 'text' && b.text) assistantText += b.text;
              }
            }
            // 抓 session_id（system/init 或 result 事件里带）
            if (evt.session_id) {
              realSessionId = evt.session_id;
              sawSessionId = true;
            }
            if (evt.type === 'result' && evt.result && typeof evt.result === 'string' && !assistantText) {
              assistantText = evt.result;
            }
            if (evt.type === 'job-done') {
              if (!cancelRequested && !runWasCanceled(runContext) && evt.exitCode === 0
                  && workingDir.conversationId && typeof deps.workspaceContextCarried === 'function') {
                deps.workspaceContextCarried(workingDir.conversationId);
              }
              if (cancelRequested || runWasCanceled(runContext)) finish(false, '任务已取消', { canceled: true });
              else if (evt.exitCode === 0 || (evt.exitCode == null && !evt.error)) finish(true, null);
              else finish(false, evt.error || `claude 退出码 ${evt.exitCode}`);
            }
          } catch (e) {
            // 关键：流式处理里的任何异常都不能让任务“静默卡死”（参考转圈 bug 教训）。
            finish(false, '事件处理异常: ' + e.message);
          }
        },
      });
      runningChild = launched && launched.child || null;
      launchedSessionRoute = normalizeSessionRoute(launched && launched.sessionRoute);
      // 路由不匹配时 runClaudeJob 已经按全新会话启动。若 init 尚未返回新 id，不能
      // 继续把旧 id 当成本轮真实会话写回任务或历史。
      if (launched && launched.resumeAccepted === false && !sawSessionId) realSessionId = null;
      removeCancel = onRunCancel(runContext, () => {
        if (settled || cancelRequested) return;
        cancelRequested = true;
        try { if (runningChild && typeof runningChild.kill === 'function') runningChild.kill(); } catch (_) {}
        if (settled) return;
        // SDK 正常会回送 job-done；异常句柄也不能让调度任务永久卡在 stopping。
        cancelGrace = setTimeout(() => finish(false, '任务已取消', { canceled: true }), 5000);
        if (cancelGrace && typeof cancelGrace.unref === 'function') cancelGrace.unref();
      });
    } catch (e) {
      if (runWasCanceled(runContext)) finish(false, '任务已取消', { canceled: true });
      else finish(false, 'spawn 失败: ' + e.message);
    }

    // 兜底超时必须真正终止执行器；旧逻辑只 resolve，底层 Claude 仍会继续运行和写文件。
    if (!settled) {
      watchdog = setTimeout(() => {
        try { if (runningChild && typeof runningChild.kill === 'function') runningChild.kill(); } catch (_) {}
        if (cancelRequested || runWasCanceled(runContext)) finish(false, '任务已取消', { canceled: true });
        else finish(false, '执行超时（600s，已中止执行器）');
      }, 600000);
      if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    }
  });
}

// 包一层：runClaudeJob 必须存在（注入），否则直接报错而非崩溃。
function runClaudeJobSafe(args) {
  if (!deps || typeof deps.runClaudeJob !== 'function') {
    throw new Error('runClaudeJob 未注入');
  }
  return deps.runClaudeJob(args);
}

// 定时出图：复用注入的 generateImage（main 的 generateImageCore）。
//   成功 → 落一条 kind='create' 的历史会话（结构对齐 AI 创作视图），summary 给图片张数。
async function execImage(task, runContext = {}) {
  reportTaskRunPhase(runContext, 'tool', '正在生成图片');
  if (runWasCanceled(runContext)) return canceledResult();
  if (!deps || typeof deps.generateImage !== 'function') {
    return { ok: false, error: 'generateImage 未注入' };
  }
  const a = task.action || {};
  const controller = new AbortController();
  const inheritedSignal = runContext && runContext.resourceSignal;
  const abort = () => { try { controller.abort(); } catch (_) {} };
  if (inheritedSignal) {
    if (inheritedSignal.aborted) abort();
    else inheritedSignal.addEventListener('abort', abort, { once: true });
  }
  const removeCancel = onRunCancel(runContext, abort);
  let res;
  try {
    res = await deps.generateImage({
      prompt: a.prompt || '',
      model: a.imageModel || undefined,   // 不传则用 core 的默认模型
      size: a.size || undefined,
      n: Number.isFinite(a.n) ? a.n : 1,
      signal: controller.signal,
    });
  } catch (e) {
    if (runWasCanceled(runContext)) return canceledResult();
    return { ok: false, error: '出图失败: ' + e.message };
  } finally {
    removeCancel();
    if (inheritedSignal) inheritedSignal.removeEventListener('abort', abort);
  }
  if (runWasCanceled(runContext)) return canceledResult();
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || '出图失败' };
  const paths = res.paths || [];
  let conversationId = null;
  if ((task.delivery || {}).saveToHistory !== false) {
    try { conversationId = saveImageToHistory(task, paths); } catch (_) {}
  }
  return {
    ok: true,
    summary: `已生成 ${paths.length} 张图片`,
    paths,
    conversationId,
    conversationKind: conversationId ? 'create' : null,
  };
}

// 同一个定时任务的多次执行，复用同一条历史会话（每次追加一「轮」），而不是每跑一次新开一条。
//   做法：任务上记一个 lastConvId；执行落历史时——
//     · 若 lastConvId 存在且该会话还在（用户没删）→ 加载它、把本次结果作为新一轮 push 进去、更新 updatedAt。
//     · 否则（首次 / 用户删掉了那条会话）→ 新建一条，并把新 id 记回任务的 lastConvId。
//   loadConversation 读不到（文件被删）即返回 null，正好作为「会话已被用户删除」的判定。
//   makeTurn(): 返回要追加的「轮」对象（chat / create 结构不同，由调用方提供）。
//   buildBase(id, now): 新建会话时返回完整会话对象（含该 id、首轮、各元字段）。
//   mergeOnReuse(可选): 复用既有会话时要刷新的字段（如持久 session 的最新 sessionId）。
function appendOrCreateConv(task, makeTurn, buildBase, mergeOnReuse) {
  const now = new Date().toISOString();
  const fresh = refetch(task.id) || task;
  const lastId = fresh.lastConvId;
  // 尝试复用既有会话
  if (lastId && deps && typeof deps.loadConversation === 'function') {
    let conv = null;
    try { conv = deps.loadConversation(lastId); } catch (_) { conv = null; }
    if (conv && typeof conv === 'object') {
      conv.turns = Array.isArray(conv.turns) ? conv.turns : [];
      conv.turns.push(makeTurn(now));
      conv.updatedAt = now;
      if (mergeOnReuse && typeof mergeOnReuse === 'object') Object.assign(conv, mergeOnReuse);
      deps.saveConversation(conv);
      return lastId;
    }
  }
  // 新建一条，并把 id 记回任务
  const id = fresh.workspaceConversationId || crypto.randomUUID();
  deps.saveConversation(buildBase(id, now));
  try {
    const t = refetch(task.id);
    if (t) { t.lastConvId = id; persistTask(t); }
  } catch (_) {}
  return id;
}

// 把出图结果落进历史会话（kind='create'，结构对齐 AI 创作视图的 turn）。复用同一任务的会话。
function saveImageToHistory(task, paths) {
  const a = task.action || {};
  const makeTurn = () => ({ prompt: a.prompt || '(定时出图)', model: a.imageModel || '', size: a.size || '', resultPaths: paths || [] });
  return appendOrCreateConv(task, makeTurn, (id, now) => ({
    id,
    title: task.name || '定时出图',
    kind: 'create',
    createdAt: now,
    updatedAt: now,
    fromScheduled: task.id,
    titleGenerated: true,
    turns: [makeTurn(now)],
  }));
}

// 把 chat 结果落进历史会话（kind=chat、来源标记 scheduled）。复用同一任务的会话（每次追加一轮）。
//   turn 结构必须对齐 Relay 渲染器：扁平字段 { user, assistant, thinkingList, files, ts }，
//   一「轮」含用户+助手两段（不是两条 {role,text} 消息——那样渲染器读 turn.user/turn.assistant 取不到值会空白）。
function saveResultToHistory(task, text, sessionId, sessionRoute = null) {
  const a = task.action || {};
  const route = normalizeSessionRoute(sessionRoute);
  const sessionFields = sessionId && route ? {
    sessionId,
    sessionProviderId: route.providerId,
    sessionProviderRevision: route.providerRevision,
    sessionRouteTier: route.routeTier,
    sessionModel: route.routeTier,
  } : (sessionId ? { sessionId } : {});
  const makeTurn = (now) => ({
    user: a.prompt || '(定时任务)',
    assistant: text || '(无输出)',
    thinkingList: [],
    files: [],
    ts: now,
  });
  return appendOrCreateConv(task, makeTurn, (id, now) => ({
    id,
    title: task.name || '定时任务',
    sessionId: sessionId || null,
    ...(sessionId && route ? sessionFields : {}),
    kind: 'chat',
    mode: a.mode || 'plain',
    agent: a.mode === 'agent' ? (a.agentName || null) : null,
    workingDir: a.workingDir ? { path: a.workingDir, name: path.basename(a.workingDir) } : null,
    model: a.model || 'haiku',
    createdAt: now,
    updatedAt: now,
    fromScheduled: task.id,
    turns: [makeTurn(now)],
  }), sessionId ? sessionFields : null);   // 持久 session：复用时同步最新 id 与服务商指纹
}

// ─────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────
function refetch(taskId) {
  const store = readStore({ strict: true });
  return store.tasks.find((t) => t.id === taskId) || null;
}
function persistTask(task) {
  const store = readStore({ strict: true });
  const i = store.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) { store.tasks[i] = task; writeStore(store); }
}
function appendRun(run) {
  const store = readStore({ strict: true });
  store.runs = store.runs || [];
  store.runs.unshift(run);
  if (store.runs.length > RUNS_CAP) store.runs.length = RUNS_CAP;
  writeStore(store);
}
function notifyRenderer() {
  try {
    const win = deps.getMainWindow && deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('sched:update');
  } catch (_) {}
}
function updateTrayHint() {
  try { if (deps.refreshTray) deps.refreshTray(); } catch (_) {}
}

// 计算「下一个任务」的人类可读提示（供托盘显示）。
function nextTaskHint() {
  // 托盘先于延迟初始化创建；此时还没有任务库依赖，初始化后的刷新会补上提示。
  if (!started) return null;
  const store = readStore();
  let soonest = null, name = '';
  for (const t of store.tasks) {
    if (!t.enabled || !t.nextRunAt) continue;
    const ts = Date.parse(t.nextRunAt);
    if (!Number.isFinite(ts)) continue;
    if (soonest === null || ts < soonest) { soonest = ts; name = t.name || '定时任务'; }
  }
  if (soonest === null) return null;
  const d = new Date(soonest);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return { at: soonest, label: `${hh}:${mm} ${name}` };
}

// ─────────────────────────────────────────
// 启动 + 错过补跑
// ─────────────────────────────────────────
function markMissedTaskSkipped(store, task, now, scheduledFor) {
  const at = new Date(now).toISOString();
  const reason = '应用未运行期间错过，已按任务设置跳过';
  task.lastStatus = 'skipped';
  task.lastError = null;
  task.lastSkippedAt = at;
  task.lastSkipReason = reason;
  if (task.schedule && task.schedule.kind === 'at') {
    task.enabled = false;
    task.nextRunAt = null;
  } else {
    // every 必须沿原计划网格推进；跳过一次不能把恢复时刻变成新的周期锚点。
    if (task.schedule && task.schedule.kind === 'every' && scheduledFor) {
      task.scheduledLastRunAt = scheduledFor;
    }
    const next = computeNextRun(task, now);
    task.nextRunAt = next ? new Date(next).toISOString() : null;
  }
  store.runs.unshift({
    taskId: task.id,
    runId: null,
    at,
    trigger: 'catchup',
    scheduledFor,
    status: 'skipped',
    ms: 0,
    summary: reason,
    error: null,
    conversationId: null,
    conversationKind: null,
    delivery: null,
  });
  if (store.runs.length > RUNS_CAP) store.runs.length = RUNS_CAP;
}

function recoverInterruptedWebhookDeliveries(store, now) {
  const at = new Date(now).toISOString();
  const error = '上次 Relay 进程在投递完成前结束';
  let recovered = 0;
  const finalize = (state) => {
    if (!state || state.status !== 'pending') return false;
    Object.assign(state, { status: 'failed', at, error, code: 'WEBHOOK_INTERRUPTED' });
    recovered += 1;
    return true;
  };
  for (const run of store.runs) {
    const state = run && run.delivery && run.delivery.webhook;
    if (finalize(state)) {
      webhookAudit('interrupted', {
        taskId: run.taskId,
        runId: run.runId || null,
        eventId: state.eventId,
        destinationHash: state.destinationHash || 'unknown',
      }, { code: 'WEBHOOK_INTERRUPTED' });
    }
  }
  // task.lastDelivery 与 runs 是两份独立状态，不用 recovered 计数判断是否修改过。
  let taskChanged = false;
  for (const task of store.tasks) {
    if (finalize(task && task.lastDelivery && task.lastDelivery.webhook)) taskChanged = true;
  }
  return { changed: recovered > 0 || taskChanged, recovered };
}

function queueMissedCatchups(items, delayMs = 0) {
  for (const item of items || []) {
    if (!item || !item.id || !item.scheduledFor) continue;
    // 同一任务多次 resume 只保留最近一次持久化的计划点，最多补跑一次。
    pendingMissedCatchups.set(item.id, item.scheduledFor);
  }
  if (!pendingMissedCatchups.size || missedCatchupTimer) return;
  missedCatchupTimer = setTimeout(() => {
    missedCatchupTimer = null;
    if (!started) {
      pendingMissedCatchups.clear();
      return;
    }
    const queued = [...pendingMissedCatchups.entries()];
    pendingMissedCatchups.clear();
    for (const [id, scheduledFor] of queued) {
      fireTask(id, { trigger: 'catchup', scheduledFor }).catch(() => {});
    }
  }, Math.max(0, Number(delayMs) || 0));
  if (missedCatchupTimer && typeof missedCatchupTimer.unref === 'function') missedCatchupTimer.unref();
}

function collectMissedRuns(store, now) {
  const missed = [];
  let dirty = false;
  for (const task of store.tasks) {
    if (!task.enabled || !task.nextRunAt) continue;
    const scheduledMs = Date.parse(task.nextRunAt);
    if (!Number.isFinite(scheduledMs)) {
      task.nextRunAt = null;
      dirty = true;
      continue;
    }
    if (scheduledMs > now) continue;
    const scheduledFor = task.nextRunAt;
    if (task.catchUp !== false) missed.push({ id: task.id, scheduledFor });
    else {
      markMissedTaskSkipped(store, task, now, scheduledFor);
      dirty = true;
    }
  }
  return { missed, dirty };
}

function init(injected) {
  deps = injected;
  started = true;
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) {
    started = false;
    throw new Error(`定时任务库读取失败：${e.message}`);
  }
  const now = Date.now();
  const recoveredWebhooks = recoverInterruptedWebhookDeliveries(store, now);
  const missedState = collectMissedRuns(store, now);
  const missed = missedState.missed;

  let dirty = recoveredWebhooks.changed || missedState.dirty;
  for (const task of store.tasks) {
    if (!task.enabled) continue;
    if (task.nextRunAt && Date.parse(task.nextRunAt) > now
        && task.schedule && task.schedule.kind === 'cron') {
      // cron 是网格推算，重算无损：清掉旧 nextRunAt 让 reschedule 按当前抖动策略重排
      //   （旧版默认抖动最长 5 分钟，落盘的触发点可能偏离设定分钟，如 15:00 → 15:04）。
      task.nextRunAt = null;
      dirty = true;
    }
  }
  if (dirty) writeStore(store);   // reschedule 会重新 readStore，状态变化必须先落盘

  // 补跑“最近一次”：对每个错过的任务跑一次（一次性任务跑完归档；周期任务随后重排到未来）。
  //   延后一拍，避开启动 I/O 高峰；不阻塞窗口创建。
  queueMissedCatchups(missed, 4000);

  reschedule();
  startStoreWatcher();   // 监听 schedules.json 外部变更（MCP server 直接写库时）
}

// 消费 MCP cron_run 写下的 runNowAt 标记：清掉标记并立即跑一次该任务（手动运行，不影响计划）。
function processRunNowMarks() {
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) { console.warn('[scheduler] 消费立即运行标记前读取失败: %s', e.message); return; }
  const marked = (store.tasks || []).filter((t) => t.runNowAt);
  if (!marked.length) return;
  for (const t of marked) delete t.runNowAt;   // 先清标记再写回，避免重复触发
  writeStore(store);
  for (const t of marked) fireTask(t.id, { keepEnabled: true, trigger: 'manual' }).catch(() => {});
}

// 监听 schedules.json：MCP server 在对话里直接改库后，main 进程据此重排定时器 + 刷新 UI。
//   以文件内容指纹过滤自身写入，只对真正不同的外部内容反应；防抖避免连续触发。
function startStoreWatcher() {
  if (storeWatcher) return;
  const f = storePath();
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (_) {}
  try {
    lastObservedStoreFingerprint = storeFingerprint(fs.readFileSync(f));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') console.warn('[scheduler] 初始化任务库指纹失败: %s', e.message);
  }
  const onChange = () => {
    if (storeWatchDebounce) clearTimeout(storeWatchDebounce);
    storeWatchDebounce = setTimeout(() => {
      storeWatchDebounce = null;
      if (!started) return;
      let fingerprint;
      try { fingerprint = storeFingerprint(fs.readFileSync(f)); }
      catch (e) {
        if (!e || e.code !== 'ENOENT') console.warn('[scheduler] 读取外部任务库变更失败: %s', e.message);
        return;
      }
      if (fingerprint === lastObservedStoreFingerprint) return;
      lastObservedStoreFingerprint = fingerprint;
      processRunNowMarks();   // MCP 的 cron_run 用 runNowAt 标记，这里消费并立即触发
      reschedule();        // 外部改了库 → 重算下次触发 + arm timer
      notifyRenderer();    // 顺带让 UI 刷新（若定时任务弹窗开着）
    }, 200);
  };
  try {
    // 监听目录而非文件：原子写用 rename，直接 watch 文件在 rename 后会失效。
    storeWatcher = fs.watch(path.dirname(f), (evt, name) => {
      if (name === 'schedules.json' || name === path.basename(f)) onChange();
    });
  } catch (e) {
    // fs.watch 在个别环境不稳；失败则降级为轮询兜底（5s）。
    storeWatcher = setInterval(() => {
      onChange();
    }, 5000);
  }
}

// 从休眠唤醒 / 系统恢复时调用：先按任务策略处理睡眠期间错过的计划，再重排。
// catchUp=true 最多补最近一次；false 留下 skipped 记录，不能静默吞掉。
function onResume() {
  if (!started) return;
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) {
    console.warn('[scheduler] 恢复后读取任务库失败: %s', e.message);
    return;
  }
  const now = Date.now();
  const { missed, dirty } = collectMissedRuns(store, now);
  if (dirty) writeStore(store);
  // 先推进 nextRunAt，连续 power resume 事件便不会重复收集同一个计划点。
  reschedule();
  queueMissedCatchups(missed, 0);
}

// ─────────────────────────────────────────
// CRUD（供 IPC 调用）
// ─────────────────────────────────────────
function list() {
  const store = readStore();
  return store.tasks.map((t) => ({ ...t, running: inflight.has(t.id) }));
}
function get(id) {
  const task = refetch(id);
  return task ? { ...task, running: inflight.has(id) } : null;
}
function create(input) {
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) { return { ok: false, code: 'STORE_READ_FAILED', error: '读取定时任务失败，请稍后重试' }; }
  const now = new Date().toISOString();
  const task = normalizeTask(input);
  const configError = taskConfigurationError(task, { requireFutureSchedule: true });
  if (configError) return { ok: false, code: 'INVALID_TASK_CONFIGURATION', error: configError };
  task.id = crypto.randomUUID();
  task.createdAt = now;
  task.updatedAt = now;
  task.lastRunAt = null;
  task.lastStatus = null;
  task.lastError = null;
  task.runCount = 0;
  // 立即算首个 nextRunAt
  const next = task.enabled ? computeNextRun(task, Date.now()) : null;
  task.nextRunAt = next ? new Date(next).toISOString() : null;
  store.tasks.push(task);
  writeStore(store);
  reschedule();
  return { ok: true, id: task.id, task };
}
function update(id, patch) {
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) { return { ok: false, code: 'STORE_READ_FAILED', error: '读取定时任务失败，请稍后重试' }; }
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: '任务不存在' };
  const previousSchedule = normalizeSchedule(t.schedule);
  const merged = normalizeTask({ ...t, ...patch, schedule: { ...t.schedule, ...(patch.schedule || {}) }, action: { ...t.action, ...(patch.action || {}) }, delivery: { ...t.delivery, ...(patch.delivery || {}) } });
  const scheduleChanged = JSON.stringify(previousSchedule) !== JSON.stringify(merged.schedule);
  const enabledChanged = t.enabled !== merged.enabled;
  const configError = taskConfigurationError(merged, {
    requireFutureSchedule: merged.enabled && (scheduleChanged || (!t.enabled && merged.enabled)),
  });
  if (configError) return { ok: false, code: 'INVALID_TASK_CONFIGURATION', error: configError };
  merged.id = t.id;
  merged.createdAt = t.createdAt;
  merged.runCount = t.runCount;
  merged.lastRunAt = t.lastRunAt;
  merged.lastStatus = t.lastStatus;
  merged.lastError = t.lastError;
  merged.lastConvId = t.lastConvId || null;
  merged.workspaceConversationId = t.workspaceConversationId || null;
  merged.manualLastRunAt = t.manualLastRunAt || null;
  merged.manualRunCount = Number(t.manualRunCount || 0);
  merged.scheduledLastRunAt = t.scheduledLastRunAt || null;
  merged.runNowAt = t.runNowAt || null;
  merged.lastSkippedAt = t.lastSkippedAt || null;
  merged.lastSkipReason = t.lastSkipReason || null;
  merged.lastDelivery = t.lastDelivery || null;
  merged.updatedAt = new Date().toISOString();
  // 只有调度值/启停状态真实变化才重算。改名、prompt、投递等字段保持原触发点。
  if (scheduleChanged || enabledChanged) {
    if (scheduleChanged || (!t.enabled && merged.enabled)) merged.scheduledLastRunAt = null;
    const next = merged.enabled ? computeNextRun(merged, Date.now()) : null;
    merged.nextRunAt = next ? new Date(next).toISOString() : null;
  } else {
    merged.nextRunAt = t.nextRunAt || null;
  }
  const i = store.tasks.findIndex((x) => x.id === id);
  store.tasks[i] = merged;
  writeStore(store);
  reschedule();
  return { ok: true, task: merged };
}
function remove(id) {
  let store;
  try { store = readStore({ strict: true }); }
  catch (e) { return { ok: false, code: 'STORE_READ_FAILED', error: '读取定时任务失败，请稍后重试' }; }
  store.tasks = store.tasks.filter((t) => t.id !== id);
  writeStore(store);
  reschedule();
  return { ok: true };
}
function toggle(id, enabled) {
  return update(id, { enabled: !!enabled });
}
async function runNow(id) {
  // 手动立即跑一次（不影响调度；一次性任务手动跑不归档）。
  // IPC 只等待“成功进入执行态”，不等待可能长达数分钟的任务本体；完成状态由 sched:update 推送。
  return await new Promise((resolve) => {
    let acknowledged = false;
    const resolveOnce = (result) => {
      if (acknowledged) return;
      acknowledged = true;
      resolve(result);
    };
    fireTask(id, { keepEnabled: true, trigger: 'manual', onStarted: resolveOnce })
      .then(resolveOnce)
      .catch((e) => {
        console.warn('[scheduler] 启动立即运行任务失败 taskId=%s: %s', id, e.message);
        resolveOnce({ ok: false, code: 'TASK_START_FAILED', error: '启动定时任务失败，请稍后重试' });
      });
  });
}
function runs(id) {
  const store = readStore();
  const all = store.runs || [];
  return id ? all.filter((r) => r.taskId === id) : all;
}
// 预览未来 N 次触发（UI 填 cron 时即时反馈）。
function preview(schedule, n = 5) {
  const fake = { schedule: normalizeSchedule(schedule), lastRunAt: null };
  const out = [];
  let cursor = Date.now();
  for (let i = 0; i < n; i++) {
    const next = computeNextRun(fake, cursor);
    if (!next) break;
    out.push(new Date(next).toISOString());
    cursor = next + 1000;   // 推进，找下一个
    if (fake.schedule.kind === 'at') break;   // 一次性只有一个
  }
  return out;
}

// 归一化输入，填默认值，做基本校验。
function normalizeTask(input) {
  const t = input && typeof input === 'object' ? input : {};
  return {
    name: String(t.name || '未命名任务').slice(0, 80),
    enabled: t.enabled !== false,
    // 默认 true 保持旧版“下次启动补跑最近一次”的用户预期；任务可显式关闭。
    catchUp: t.catchUp !== false,
    builtin: t.builtin || null,   // 内置任务标记（如 'memory-consolidate'），UI 据此定位，普通任务为 null
    schedule: normalizeSchedule(t.schedule),
    action: normalizeActionObj(t.action),
    delivery: {
      notify: (t.delivery && t.delivery.notify) !== false,
      saveToHistory: (t.delivery && t.delivery.saveToHistory) !== false,
      webhook: normalizeWebhookConfig(t.delivery && t.delivery.webhook),
    },
    // 保留运行时字段（update 时会被覆盖回原值）
    nextRunAt: t.nextRunAt || null,
  };
}
function normalizeSchedule(s) {
  s = s && typeof s === 'object' ? s : {};
  const kind = ['at', 'every', 'cron'].includes(s.kind) ? s.kind : 'cron';
  return {
    kind,
    at: s.at || null,
    everyMs: Number.isFinite(s.everyMs) ? s.everyMs : null,
    cron: s.cron || '0 9 * * *',
    tz: s.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    jitterSec: Number.isFinite(s.jitterSec) ? s.jitterSec : 0,
    exact: !!s.exact,
  };
}
function normalizeActionObj(a) {
  a = a && typeof a === 'object' ? a : {};
  const type = ['chat', 'image', 'command'].includes(a.type) ? a.type : 'chat';
  return {
    type,
    prompt: a.prompt || '',
    sessionMode: a.sessionMode === 'session' ? 'session' : 'isolated',
    sessionRef: a.sessionRef || null,
    sessionRoute: normalizeSessionRoute(a.sessionRoute),
    mode: type === 'chat' && a.mode === 'agent' ? 'agent' : 'plain',
    agentName: a.agentName || null,
    memory: ['off', 'read', 'readwrite'].includes(a.memory) ? a.memory : 'read',   // 长期记忆：off/read(默认)/readwrite
    model: ['haiku', 'sonnet', 'opus'].includes(a.model) ? a.model : 'haiku',
    workingDir: a.workingDir || null,
    imageModel: a.imageModel || null,
    size: a.size || null,
    n: Number.isFinite(a.n) ? a.n : 1,
    command: a.command || null,
  };
}

function normalizeSessionRoute(value) {
  const route = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const providerId = typeof route.providerId === 'string' ? route.providerId.trim() : '';
  const routeTier = ['haiku', 'sonnet', 'opus'].includes(route.routeTier) ? route.routeTier : '';
  if (!providerId || !routeTier) return null;
  return {
    providerId,
    providerRevision: Math.max(0, Number(route.providerRevision) || 0),
    routeTier,
  };
}

function sessionRoutesEqual(left, right) {
  const a = normalizeSessionRoute(left);
  const b = normalizeSessionRoute(right);
  if (!a || !b) return a === b;
  return a.providerId === b.providerId
    && a.providerRevision === b.providerRevision
    && a.routeTier === b.routeTier;
}

function scheduleConfigurationError(schedule, options = {}) {
  const s = normalizeSchedule(schedule);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (s.kind === 'every') {
    if (!Number.isFinite(s.everyMs) || s.everyMs < 1000) return '固定间隔必须至少为 1000 毫秒';
    return null;
  }
  if (s.kind === 'at') {
    const at = parseAtToMs(s.at, now);
    if (!Number.isFinite(at)) return '一次性时间格式无效';
    if (options.requireFuture && at <= now) return '一次性时间必须晚于当前时间';
    return null;
  }
  try {
    const cron = parseCron(s.cron);
    if (!nextCronAfter(cron, new Date(now))) return 'cron 在未来八年内没有可触发的时间';
  } catch (error) {
    return `cron 格式无效：${error.message}`;
  }
  return null;
}

function taskConfigurationError(task, options = {}) {
  const scheduleProblem = scheduleConfigurationError(task && task.schedule, {
    now: options.now,
    requireFuture: options.requireFutureSchedule === true,
  });
  if (scheduleProblem) return scheduleProblem;
  const webhookProblem = webhookConfigError(task && task.delivery && task.delivery.webhook);
  if (webhookProblem) return webhookProblem;
  const action = task && task.action || {};
  if (action.type === 'chat' && action.mode === 'agent' && !String(action.agentName || '').trim()) {
    return 'Agent 模式必须指定 agentName';
  }
  return null;
}

module.exports = {
  init, shutdown, onResume,
  list, get, create, update, remove, toggle, runNow, cancelRun, runs, preview,
  nextTaskHint,
  // 暴露给测试 / 复用
  _parseCron: parseCron, _computeNextRun: computeNextRun, _terminateCommandTree: terminateCommandTree,
  _normalizeTask: normalizeTask,
  _scheduleConfigurationError: scheduleConfigurationError,
  _isPublicNetworkAddress: isPublicNetworkAddress,
  _resolveWebhookTarget: resolveWebhookTarget,
  _requestWebhookOnce: requestWebhookOnce,
  _deliverWebhook: deliverWebhook,
};
