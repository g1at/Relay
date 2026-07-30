// logger.js — 主进程滚动文件日志（零依赖）
//
// 为什么需要：打包后的 Relay 没有控制台，主进程 console.error 全部无处可看，
//   偶发问题（转圈不停 / 定时任务漏跑 / spawn 失败）只能靠复现去猜。这里把主进程的
//   console.* 原样镜像到 userData/logs/main.log，并捕获顶层异常，事后翻日志即可定位。
//
// 设计：
//   · init() 一次完成：建目录 → 接管 console → 挂顶层异常钩子 → 写启动横幅。
//   · 同步 appendFileSync 逐行落盘：日志量级低（事件级，非请求级），不值得引入异步队列；
//     同步还保证进程崩溃前最后一行不丢。
//   · 滚动：超 MAX_BYTES 把 main.log 改名 main.old.log（保留一代），重新开写。
//     两代合计 ~4MB 封顶，绝不撑爆用户磁盘。
//   · 任何日志操作失败都静默吞掉 —— 日志系统自己绝不能成为新的崩溃源。

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 2 * 1024 * 1024;   // 单文件上限 2MB，超过滚动

let logFile = null;   // 当前日志文件路径（null = 未初始化/初始化失败，所有写入静默跳过）
let oldFile = null;   // 滚动目标（上一代日志）
let bytes = 0;        // 当前文件已写字节（init 时从磁盘读一次，之后内存累计）

// 本地时间戳：YYYY-MM-DD HH:mm:ss.SSS（与用户墙上时钟一致，对表方便）
function ts() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function writeLine(level, args) {
  if (!logFile) return;
  try {
    const line = `${ts()} [${level}] ${util.format(...args)}\n`;
    const buf = Buffer.from(line, 'utf8');
    if (bytes + buf.length > MAX_BYTES) {
      // 滚动失败（如文件被占用）则继续追加当前文件，下次写入再试
      try { fs.rmSync(oldFile, { force: true }); fs.renameSync(logFile, oldFile); bytes = 0; } catch (_) {}
    }
    fs.appendFileSync(logFile, buf);
    bytes += buf.length;
  } catch (_) { /* 日志失败绝不影响主流程 */ }
}

const info  = (...args) => writeLine('INFO ', args);
const warn  = (...args) => writeLine('WARN ', args);
const error = (...args) => writeLine('ERROR', args);

// 接管 console：原行为保留（dev 模式终端照常可见），额外镜像到文件。
//   存量代码里所有 console.log/warn/error 一行不用改，自动全部落盘。
function hookConsole() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log   = (...a) => { try { orig.log(...a); } catch (_) {} info(...a); };
  console.info  = (...a) => { try { orig.info(...a); } catch (_) {} info(...a); };
  console.warn  = (...a) => { try { orig.warn(...a); } catch (_) {} warn(...a); };
  console.error = (...a) => { try { orig.error(...a); } catch (_) {} error(...a); };
}

// 顶层异常落盘。uncaughtException 记录后不退出：Relay 是带后台定时任务的托盘应用，
//   硬崩会杀掉所有在跑/待跑任务，代价比带伤运行更大；真有状态损坏，日志里有完整堆栈可查。
function hookProcess() {
  process.on('uncaughtException', (err) => { error('[uncaught]', (err && err.stack) || String(err)); });
  process.on('unhandledRejection', (reason) => { error('[unhandledRejection]', (reason && reason.stack) || String(reason)); });
}

function init(dir, { banner } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    oldFile = path.join(dir, 'main.old.log');
    try { bytes = fs.statSync(logFile).size; } catch (_) { bytes = 0; }
    hookConsole();
    hookProcess();
    info('━━━ 启动 ━━━', banner || '');
  } catch (_) { logFile = null; }   // 初始化失败 → 永久静默，不影响应用
}

module.exports = { init, info, warn, error, getLogPath: () => logFile };
