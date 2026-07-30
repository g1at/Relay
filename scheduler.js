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

// ── 注入的依赖（init 时填充）──
let deps = null;
//   deps = {
//     userDataDir: string,                  // app.getPath('userData')
//     runClaudeJob: fn,                      // main.js 的执行核心
//     buildMemoryHint: fn(mode),             // 长期记忆注入（'read'=只读索引 / 'full'=可读写）
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
let lastSelfWriteAt = 0;     // 本进程最近一次写 schedules.json 的时间戳（用于过滤自身写入，避免回环）

// setTimeout 上限 ~24.8 天；超长间隔分段重 arm。
const MAX_TIMEOUT = 2 ** 31 - 1;
const RUNS_CAP = 200;        // runs 环形历史上限

// ─────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────
function storePath() { return path.join(deps.userDataDir, 'schedules.json'); }

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return { version: 1, tasks: [], runs: [] };
    d.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    d.runs = Array.isArray(d.runs) ? d.runs : [];
    return d;
  } catch (_) {
    return { version: 1, tasks: [], runs: [] };
  }
}

function writeStore(d) {
  const f = storePath();
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(JSON.stringify(d, null, 2), 'utf8'));
  fs.renameSync(tmp, f);
  lastSelfWriteAt = Date.now();   // 标记自身写入，文件监听据此忽略本次变化（防回环）
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

// 从 after 之后，逐分钟向前找下一个 cron 命中时刻（本地时区）。最多扫 ~366 天兜底。
function nextCronAfter(c, after) {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);   // 从下一分钟起找（不含 after 本身）
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
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
      // 基于上次触发推进；没有上次则从 from + step。
      const base = task.lastRunAt ? Date.parse(task.lastRunAt) : fromMs;
      let next = base + step;
      while (next <= fromMs) next += step;   // 错过多次时推进到未来
      return next;
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

// 重新计算所有任务的 nextRunAt（仅 enabled 且尚未排定的），落盘，arm 最早的那个。
function reschedule() {
  if (!started) return;
  clearTimer();
  const store = readStore();
  const now = Date.now();

  // 确保每个 enabled 任务都有未来 nextRunAt
  let dirty = false;
  for (const task of store.tasks) {
    if (!task.enabled) { if (task.nextRunAt) { task.nextRunAt = null; dirty = true; } continue; }
    if (!task.nextRunAt || Date.parse(task.nextRunAt) <= now) {
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
  const store = readStore();
  const now = Date.now();
  const due = store.tasks.filter(
    (t) => t.enabled && t.nextRunAt && Date.parse(t.nextRunAt) <= now + 1000
  );
  for (const task of due) {
    fireTask(task.id).catch(() => {});   // 异步执行，错误内部已记
  }
  // 立即重排（fireTask 内部会在完成后再 reschedule 一次以反映新 nextRunAt）
  reschedule();
}

// ─────────────────────────────────────────
// 执行单个任务
// ─────────────────────────────────────────
const inflight = new Set();   // 防同一任务并发重入

async function fireTask(taskId, opts = {}) {
  if (inflight.has(taskId)) return;
  inflight.add(taskId);
  const startedAt = Date.now();
  let store = readStore();
  let task = store.tasks.find((t) => t.id === taskId);
  if (!task) { inflight.delete(taskId); return; }

  // 推进调度状态：先把 nextRunAt 推到未来（避免重入），lastRunAt 置当前。
  task.lastRunAt = new Date(startedAt).toISOString();
  task.runCount = (task.runCount || 0) + 1;
  if (task.schedule && task.schedule.kind === 'at' && !opts.keepEnabled) {
    task.enabled = false;          // 一次性跑完归档
    task.nextRunAt = null;
  } else {
    const next = computeNextRun(task, startedAt + 1000);
    task.nextRunAt = next ? new Date(next).toISOString() : null;
  }
  writeStore(store);
  notifyRenderer();

  // 技能体检任务开始前拍技能名快照(供完成后 diff 出真正新建的伞技能)
  if (task && task.builtin === 'skill-curator' && typeof deps.onSkillCuratorStart === 'function') {
    try { deps.onSkillCuratorStart(); } catch (_) {}
  }

  let result;
  try {
    result = await execAction(task);
    task = refetch(taskId);   // 期间可能被编辑，重新读
    if (task) {
      task.lastStatus = result.ok ? 'ok' : 'error';
      task.lastError = result.ok ? null : (result.error || '执行失败');
      persistTask(task);
    }
    // 技能体检任务跑完 → 通知 main 善后(标归档/新伞技能 + 完成通知)。失败不影响调度。
    if (result && result.ok && task && task.builtin === 'skill-curator' && typeof deps.onSkillCuratorDone === 'function') {
      try { deps.onSkillCuratorDone(result); } catch (_) {}
    }
  } catch (e) {
    task = refetch(taskId);
    if (task) { task.lastStatus = 'error'; task.lastError = e.message; persistTask(task); }
    result = { ok: false, error: e.message };
  }

  // 记 runs 环形历史
  appendRun({
    taskId,
    at: new Date(startedAt).toISOString(),
    status: result.ok ? 'ok' : 'error',
    ms: Date.now() - startedAt,
    summary: result.ok ? (result.summary || '') : '',
    error: result.ok ? null : (result.error || ''),
  });

  // 完成通知
  const t2 = refetch(taskId);
  if (t2 && t2.delivery && t2.delivery.notify !== false) {
    const title = result.ok ? `定时任务完成：${t2.name || taskId}` : `定时任务失败：${t2.name || taskId}`;
    const body = result.ok ? (result.summary || '已执行完成').slice(0, 180)
                           : ('错误：' + (result.error || '').slice(0, 180));
    try { deps.notify({ title, body }); } catch (_) {}
  }

  inflight.delete(taskId);
  reschedule();
  return result;
}

// 真正执行动作。chat（runClaudeJob）/ image（generateImage）/ command（PowerShell 脚本）。
function execAction(task) {
  const a = task.action || {};
  if (a.type === 'image') return execImage(task);
  if (a.type === 'command') return execCommand(task);
  return execChat(task);
}

// 命令任务：到点跑一段 PowerShell 脚本，不起模型。安全面最大，受全局开关 allowCommandTasks 闸控。
//   捕获 stdout/stderr，带超时（防卡死）。结果进 runs 历史 + 通知；不落聊天历史。
function execCommand(task) {
  return new Promise((resolve) => {
    // 安全闸①：全局开关默认关，关时直接拒绝执行（不只是 UI 拦，执行侧也兜底）。
    let allow = false;
    try { allow = !!(deps.readAppSettings() || {}).allowCommandTasks; } catch (_) {}
    if (!allow) { resolve({ ok: false, error: '命令任务被禁用（在 设置 → 行为 → 允许命令任务 中开启）' }); return; }

    const a = task.action || {};
    const script = String(a.command || '').trim();
    if (!script) { resolve({ ok: false, error: '命令脚本为空' }); return; }

    const { spawn } = require('child_process');
    const os = require('os');
    let child, out = '', err = '', settled = false;
    const TIMEOUT = 120000;   // 120s 看门狗，超时杀进程
    const done = (ok, error, summary) => {
      if (settled) return; settled = true;
      resolve({ ok, error, summary });
    };
    try {
      // -NoProfile 不加载用户 profile；-NonInteractive 禁交互；脚本经 -Command 传入。
      //   cwd 用工作目录（若设了）否则用户主目录。
      let cwd = os.homedir();
      if (a.workingDir && typeof a.workingDir === 'string') {
        try { if (fs.existsSync(a.workingDir) && fs.statSync(a.workingDir).isDirectory()) cwd = a.workingDir; } catch (_) {}
      }
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { cwd, shell: false, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { done(false, 'PowerShell 启动失败: ' + e.message); return; }

    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} done(false, `执行超时（${TIMEOUT / 1000}s 已杀进程）`); }, TIMEOUT);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(killer);
      // summary 取 stdout 末尾若干字符（runs 历史里展示）；非 0 退出码视为失败。
      const tail = (s) => { s = (s || '').trim(); return s.length > 200 ? s.slice(-200) : s; };
      if (code === 0) done(true, null, tail(out) || '（无输出）');
      else done(false, (tail(err) || tail(out) || `退出码 ${code}`), tail(out));
    });
    child.on('error', (e) => { clearTimeout(killer); done(false, 'PowerShell 执行错误: ' + e.message); });
  });
}

// chat：把 prompt 原样交给 runClaudeJob（prompt 须自包含；不在此追加 UI 那套 hint —
//   定时任务通常 isolated，更需自包含。模型档/工作目录/agent 由 task.action 决定）。
//   注：agent 模式的 prompt 包装与 --add-dir 由调用方在 prompt 里写清；P0 先支持 plain。
function execChat(task) {
  return new Promise((resolve) => {
    const a = task.action || {};
    const os = require('os');
    let cwd = os.homedir();
    let validWorkingDir = null;
    if (a.workingDir && typeof a.workingDir === 'string') {
      try {
        if (fs.existsSync(a.workingDir) && fs.statSync(a.workingDir).isDirectory()) {
          cwd = a.workingDir; validWorkingDir = a.workingDir;
        }
      } catch (_) {}
    }
    // 持久 session：带上 sessionRef（--resume），累积上下文；isolated 不带。
    const sessionId = (a.sessionMode === 'session' && a.sessionRef) ? a.sessionRef : null;

    // 长期记忆注入：a.memory = 'off' | 'read'(默认) | 'readwrite'。
    //   默认只读——读让产出贴合用户偏好（普惠），写有污染记忆库的风险（周期任务跑得多，
    //   偶发把当次产出当长期事实写库）。readwrite（→ full 提示词，含写规则）留给记忆整理任务。
    //   --add-dir 记忆目录在 runClaudeJob 核心里已无条件授权，这里只负责把索引和规则告诉模型。
    const memMode = ['off', 'read', 'readwrite'].includes(a.memory) ? a.memory : 'read';
    let memHint = '';
    if (memMode !== 'off' && deps && typeof deps.buildMemoryHint === 'function') {
      try { memHint = deps.buildMemoryHint(memMode === 'readwrite' ? 'full' : 'read') || ''; } catch (_) {}
    }

    let assistantText = '';
    let realSessionId = sessionId;
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return; settled = true;
      // 持久 session：把首次拿到的 session_id 记回任务，供下次续接。
      if (a.sessionMode === 'session' && realSessionId && realSessionId !== a.sessionRef) {
        const t = refetch(task.id);
        if (t) { t.action = t.action || {}; t.action.sessionRef = realSessionId; persistTask(t); }
      }
      if (ok && (task.delivery || {}).saveToHistory !== false) {
        try { saveResultToHistory(task, assistantText, realSessionId); } catch (_) {}
      }
      resolve({ ok, error, summary: assistantText.trim().slice(0, 200) });
    };

    try {
      runClaudeJobSafe({
        prompt: (a.prompt || '') + memHint,
        cwd, validWorkingDir,
        agentProjectRoot: null,
        model: a.model,
        sessionId,
        onEvent: (evt) => {
          try {
            // 累积 assistant 文本（stream-json：assistant 消息块）
            if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
              for (const b of evt.message.content) {
                if (b && b.type === 'text' && b.text) assistantText += b.text;
              }
            }
            // 抓 session_id（system/init 或 result 事件里带）
            if (evt.session_id) realSessionId = evt.session_id;
            if (evt.type === 'result' && evt.result && typeof evt.result === 'string' && !assistantText) {
              assistantText = evt.result;
            }
            if (evt.type === 'job-done') {
              if (evt.exitCode === 0 || (evt.exitCode == null && !evt.error)) finish(true, null);
              else finish(false, evt.error || `claude 退出码 ${evt.exitCode}`);
            }
          } catch (e) {
            // 关键：流式处理里的任何异常都不能让任务“静默卡死”（参考转圈 bug 教训）。
            finish(false, '事件处理异常: ' + e.message);
          }
        },
      });
    } catch (e) {
      finish(false, 'spawn 失败: ' + e.message);
    }

    // 兜底超时：10 分钟没收到 job-done 视为失败（看门狗）。
    setTimeout(() => finish(false, '执行超时（600s 未完成）'), 600000);
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
async function execImage(task) {
  if (!deps || typeof deps.generateImage !== 'function') {
    return { ok: false, error: 'generateImage 未注入' };
  }
  const a = task.action || {};
  let res;
  try {
    res = await deps.generateImage({
      prompt: a.prompt || '',
      model: a.imageModel || undefined,   // 不传则用 core 的默认模型
      size: a.size || undefined,
      n: Number.isFinite(a.n) ? a.n : 1,
    });
  } catch (e) {
    return { ok: false, error: '出图失败: ' + e.message };
  }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || '出图失败' };
  const paths = res.paths || [];
  if ((task.delivery || {}).saveToHistory !== false) {
    try { saveImageToHistory(task, paths); } catch (_) {}
  }
  return { ok: true, summary: `已生成 ${paths.length} 张图片`, paths };
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
  const id = crypto.randomUUID();
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
  appendOrCreateConv(task, makeTurn, (id, now) => ({
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
function saveResultToHistory(task, text, sessionId) {
  const a = task.action || {};
  const makeTurn = (now) => ({
    user: a.prompt || '(定时任务)',
    assistant: text || '(无输出)',
    thinkingList: [],
    files: [],
    ts: now,
  });
  appendOrCreateConv(task, makeTurn, (id, now) => ({
    id,
    title: task.name || '定时任务',
    sessionId: sessionId || null,
    kind: 'chat',
    mode: a.mode || 'plain',
    model: a.model || 'haiku',
    createdAt: now,
    updatedAt: now,
    fromScheduled: task.id,
    turns: [makeTurn(now)],
  }), sessionId ? { sessionId } : null);   // 持久 session：复用时刷新最新 sessionId
}

// ─────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────
function refetch(taskId) {
  const store = readStore();
  return store.tasks.find((t) => t.id === taskId) || null;
}
function persistTask(task) {
  const store = readStore();
  const i = store.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) { store.tasks[i] = task; writeStore(store); }
}
function appendRun(run) {
  const store = readStore();
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
function init(injected) {
  deps = injected;
  started = true;
  const store = readStore();
  const now = Date.now();
  const missed = [];

  let cleared = false;
  for (const task of store.tasks) {
    if (!task.enabled) continue;
    if (task.nextRunAt && Date.parse(task.nextRunAt) <= now) {
      missed.push(task.id);   // 应用没开时错过了
    } else if (task.nextRunAt && task.schedule && task.schedule.kind === 'cron') {
      // cron 是网格推算，重算无损：清掉旧 nextRunAt 让 reschedule 按当前抖动策略重排
      //   （旧版默认抖动最长 5 分钟，落盘的触发点可能偏离设定分钟，如 15:00 → 15:04）。
      task.nextRunAt = null;
      cleared = true;
    }
  }
  if (cleared) writeStore(store);   // reschedule 会重新 readStore，清空必须先落盘才生效

  // 补跑“最近一次”：对每个错过的任务跑一次（一次性任务跑完归档；周期任务随后重排到未来）。
  //   延后一拍，避开启动 I/O 高峰；不阻塞窗口创建。
  if (missed.length) {
    setTimeout(() => {
      for (const id of missed) fireTask(id).catch(() => {});
    }, 4000);
  }

  reschedule();
  startStoreWatcher();   // 监听 schedules.json 外部变更（MCP server 直接写库时）
}

// 消费 MCP cron_run 写下的 runNowAt 标记：清掉标记并立即跑一次该任务（手动运行，不影响计划）。
function processRunNowMarks() {
  let store;
  try { store = readStore(); } catch (_) { return; }
  const marked = (store.tasks || []).filter((t) => t.runNowAt);
  if (!marked.length) return;
  for (const t of marked) delete t.runNowAt;   // 先清标记再写回，避免重复触发
  writeStore(store);
  for (const t of marked) fireTask(t.id, { keepEnabled: true }).catch(() => {});
}

// 监听 schedules.json：MCP server 在对话里直接改库后，main 进程据此重排定时器 + 刷新 UI。
//   过滤掉本进程自己的写入（lastSelfWriteAt），只对“外部写入”反应；防抖避免连续触发。
function startStoreWatcher() {
  if (storeWatcher) return;
  const f = storePath();
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (_) {}
  let debounce = null;
  const onChange = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      // 本进程刚写过（renameSync 触发的）→ 距今很近，忽略，避免回环重排。
      if (Date.now() - lastSelfWriteAt < 800) return;
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
      if (Date.now() - lastSelfWriteAt < 800) return;
      onChange();
    }, 5000);
  }
}

// 从休眠唤醒 / 系统恢复时调用，强制重算（时钟可能跳变）。
function onResume() { reschedule(); }

// ─────────────────────────────────────────
// CRUD（供 IPC 调用）
// ─────────────────────────────────────────
function list() {
  const store = readStore();
  return store.tasks.map((t) => ({ ...t }));
}
function get(id) {
  return refetch(id);
}
function create(input) {
  const store = readStore();
  const now = new Date().toISOString();
  const task = normalizeTask(input);
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
  const store = readStore();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: '任务不存在' };
  const merged = normalizeTask({ ...t, ...patch, schedule: { ...t.schedule, ...(patch.schedule || {}) }, action: { ...t.action, ...(patch.action || {}) }, delivery: { ...t.delivery, ...(patch.delivery || {}) } });
  merged.id = t.id;
  merged.createdAt = t.createdAt;
  merged.runCount = t.runCount;
  merged.lastRunAt = t.lastRunAt;
  merged.lastStatus = t.lastStatus;
  merged.lastError = t.lastError;
  merged.updatedAt = new Date().toISOString();
  // 调度相关变化 → 重算 nextRunAt
  const next = merged.enabled ? computeNextRun(merged, Date.now()) : null;
  merged.nextRunAt = next ? new Date(next).toISOString() : null;
  const i = store.tasks.findIndex((x) => x.id === id);
  store.tasks[i] = merged;
  writeStore(store);
  reschedule();
  return { ok: true, task: merged };
}
function remove(id) {
  const store = readStore();
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
  const r = await fireTask(id, { keepEnabled: true });
  return r || { ok: false, error: '任务不存在' };
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
    builtin: t.builtin || null,   // 内置任务标记（如 'memory-consolidate'），UI 据此定位，普通任务为 null
    schedule: normalizeSchedule(t.schedule),
    action: normalizeActionObj(t.action),
    delivery: {
      notify: (t.delivery && t.delivery.notify) !== false,
      saveToHistory: (t.delivery && t.delivery.saveToHistory) !== false,
      webhook: (t.delivery && t.delivery.webhook) || null,
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
    mode: a.mode === 'agent' ? 'agent' : 'plain',
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

module.exports = {
  init, onResume,
  list, get, create, update, remove, toggle, runNow, runs, preview,
  nextTaskHint,
  // 暴露给测试 / 复用
  _parseCron: parseCron, _computeNextRun: computeNextRun,
};
