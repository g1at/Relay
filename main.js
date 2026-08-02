// main.js — Electron 主进程
// 职责:
//   1. 创建窗口
//   2. 通过 claude-agent-sdk 驱动 Claude Code(SDK 自带运行时,不依赖用户安装)
//   3. 把 SDK 吐出的事件流经 IPC 转发给 renderer

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, Notification, globalShortcut, clipboard, nativeTheme } = require('electron');
const { spawn, execFile } = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const fs = require('fs');
const scheduler = require('./scheduler');
const updater = require('./updater');
const claudeSdk = require('./claude-sdk');

const IS_DEV = process.argv.includes('--dev');
// 开机自启唤起:--autostart 时不弹主窗,静默建托盘 + 起调度器在后台跑定时任务。
const IS_AUTOSTART = process.argv.includes('--autostart');

// ── 主进程滚动日志:尽早初始化,之后所有 console.* 自动镜像到 userData/logs/main.log ──
//   打包后没有控制台,主进程报错以前无处可看,偶发问题(转圈/漏跑/spawn 失败)只能靠复现猜;
//   现在翻日志即可定位。注:app.getPath('userData') 在 ready 前即可用;
//   初始化失败时 logger 自动整体静默,绝不影响启动。
const logger = require('./logger');
logger.init(path.join(app.getPath('userData'), 'logs'), {
  banner: `Relay ${app.getVersion()} | electron ${process.versions.electron} | node ${process.versions.node}` +
          ` | ${process.platform} ${os.release()} | packaged=${app.isPackaged} | pid=${process.pid}` +
          (IS_AUTOSTART ? ' | autostart' : '') + (IS_DEV ? ' | dev' : ''),
});
// 用户级 Agent 子智能体目录 / 技能目录(Claude Code 原生约定)。
//   用户把任意 Agent 包导入到 ~/.claude/agents 即可,
//   调用时从用户主目录启动 Claude,Claude 自动加载这里的子智能体定义。
const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// ─────────────────────────────────────────
// 长期记忆库(全局单库,与 cwd / 工作目录 / agent 解耦)
// ─────────────────────────────────────────
//   复刻 Claude Code CLI 的原生记忆模式:纯文件 —— 一个 MEMORY.md 索引(每条一行)
//   + 每条事实一个 .md(带 name/description/type frontmatter)。但 CLI 的记忆注入是
//   交互式 harness 的特权,`claude -p`(headless)从不注入;故由 main 进程在拼 prompt 时
//   把索引塞进去(见下方 buildMemoryHint),并用 --add-dir 授权该目录,让模型自读自写。
//   所有对话共享这一套(方案 A),用绝对路径注入,不受 CLI 项目键(随 cwd 漂移)影响。
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'relay-memory');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

// ── #1 索引由主进程自动维护(模型只写正文 .md,不再手写索引行) ──
//   扫描 MEMORY_DIR 下所有 .md(MEMORY.md 自身除外),按 frontmatter 的 name/description
//   重建 MEMORY.md。这从结构上根治三类问题:孤儿索引行(删了正文留着行)、重复行、
//   分叉(写到别处的不会进索引)。关键:模型在 -p 会话里是用 Write 工具直接落 .md 的,
//   不经过我们的 IPC,所以重建必须在「注入前」也跑一次(见 buildMemoryHint),
//   这样无论谁写的(模型 Write / 用户 UI)下一轮都能看到新鲜、去重、无孤儿的索引。
//   返回 { count, bytes }(条目数 + 重建后索引字节数),供注入预算判断用。
function rebuildMemoryIndex() {
  let entries = [];
  try {
    const names = fs.readdirSync(MEMORY_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'memory.md')
      .map((e) => e.name);
    for (const file of names) {
      let fm = {}, mtime = 0;
      try { fm = parseFrontmatter(fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8')); } catch (_) {}
      try { mtime = fs.statSync(path.join(MEMORY_DIR, file)).mtimeMs; } catch (_) {}
      const title = fm.name || file.replace(/\.md$/i, '');
      const desc = (fm.description || '').replace(/\r?\n/g, ' ').trim();
      entries.push({ file, title, desc, mtime });
    }
  } catch (_) { /* 目录不存在 → 空索引 */ }
  // 新→旧排序(最近写的在前,符合「最相关」直觉);组装每条一行
  entries.sort((a, b) => b.mtime - a.mtime);
  const lines = entries.map((e) => `- [${e.title}](${e.file})${e.desc ? ' — ' + e.desc : ''}`);
  const body = lines.length ? lines.join('\n') + '\n' : '';
  // 写回 MEMORY.md(UTF-8 无 BOM 原子写);空库则删掉残留的 MEMORY.md,保持干净
  try {
    if (lines.length) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      const tmp = MEMORY_INDEX + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(body, 'utf8'));
      fs.renameSync(tmp, MEMORY_INDEX);
    } else if (fs.existsSync(MEMORY_INDEX)) {
      fs.rmSync(MEMORY_INDEX, { force: true });
    }
  } catch (e) { console.warn('[memory] 写入索引失败: %s', e.message); }
  return { count: lines.length, bytes: Buffer.byteLength(body, 'utf8'), lines };
}

// 注入预算上限(#2):索引超过这个字节数就降级注入,避免每轮 prompt 无限膨胀。
//   8KB ≈ 几十条「name — description」级别的索引行,够个人助手用很久;超了说明该 consolidate。
const MEMORY_INDEX_BUDGET = 8 * 1024;
const MEMORY_INDEX_HEAD = 40;   // 降级时保留最近的前 N 条

// 组装注入到每轮 prompt 末尾的「长期记忆」提示。
//   先重建索引(#1),再按体量决定全量 / 降级注入(#2)。
//   模型只被教「写正文 .md」——索引完全由上面 rebuildMemoryIndex 生成,不再让模型手写,
//   从源头消灭孤儿/重复索引行。
//   mode:
//     'full'(默认) — 交互聊天:索引 + 读规则 + 写规则,可读可写。
//     'read'       — 定时任务默认:索引 + 只读规则(无人值守,明示不要写入);空库直接返回 ''(省 token)。
//   定时任务为何默认只读:读是普惠的(产出个性化),写是危险的——周期任务跑得多,
//   模型偶发把当次产出(如当日新闻)当「长期事实」写库,日积月累污染记忆。
//   可读写(readwrite→full)留给记忆整理任务和用户显式要求。
function buildMemoryHint(mode = 'full') {
  const { count, bytes, lines } = rebuildMemoryIndex();
  if (mode === 'read' && count === 0) return '';

  // 写入规则(空库/满库共用的尾部):什么时候写、写成什么格式、只能写哪里。
  //   刻意不提「更新 MEMORY.md / 写索引」——索引是主进程的事,模型碰了反而添乱。
  const writeRules =
    '\n\n写入规则:\n' +
    '· 若本轮出现值得长期记住的新事实(用户的身份/偏好、对你工作方式的指正、项目约束、外部资源链接等),' +
    '用 Write 工具在记忆库目录新建一个 kebab-case 命名的 .md 文件,以 YAML frontmatter 开头' +
    '(name: 短横线标识;description: 一句话摘要,会被用作索引,务必准确精炼;type: user|feedback|project|reference),' +
    '正文写这条事实本身。你只需写这个 .md 文件——不要去创建或编辑 MEMORY.md,索引由系统自动维护。\n' +
    '· 若已有同主题的记忆文件,更新那个文件,不要重复新建。已过期/被证伪的记忆,直接删掉对应 .md。\n' +
    '· 若用户明确要求你记住某件事(如「记住…」「记一下…」),直接照办写入,无需追问;' +
    '当用户只是要你记事、并没有其它问题时,写完简短确认一句即可,不要展开长篇解释。\n' +
    '· 不要记录代码本身已经记录的东西,也不要记录只对本次对话有意义的临时信息。\n' +
    '· 【位置铁律】所有记忆 .md 只能位于这个目录:' + MEMORY_DIR + '。' +
    '严禁在任何其它位置创建或修改记忆文件——尤其不要写到 ~/.claude/projects/ 下任何 memory/ 目录、当前工作目录、或主目录其它位置。' +
    '这是本应用唯一的记忆库,写到别处不会被加载、只会造成分叉。';

  if (count === 0) {
    return '\n\n---\n[长期记忆] 你有一个持久记忆库,位于:' + MEMORY_DIR + '(当前为空)。' + writeRules;
  }

  // #2 注入预算:体量在阈值内 → 全量;超阈值 → 只注入最近 MEMORY_INDEX_HEAD 条 + 提示按需 Read。
  let indexBlock, head;
  if (bytes <= MEMORY_INDEX_BUDGET) {
    indexBlock = lines.join('\n');
    head = '下面是全部记忆的索引(每行一条,含定位线索):';
  } else {
    indexBlock = lines.slice(0, MEMORY_INDEX_HEAD).join('\n');
    head = '记忆较多(共 ' + count + ' 条),下面只列出最近的 ' + MEMORY_INDEX_HEAD +
      ' 条;完整清单见记忆库目录,需要时可用 Read/Glob 在该目录中查找其它记忆:';
  }

  // 只读模式(定时任务):有索引、有读规则,但明示无人值守不要写。
  if (mode === 'read') {
    return '\n\n---\n[长期记忆] 你有一个持久记忆库,位于:' + MEMORY_DIR + '\n' +
      head + '\n' + indexBlock + '\n\n' +
      '使用规则:\n' +
      '· 若本次任务与某条记忆相关(用户偏好、关注重点、项目约束等),先用 Read 工具读取对应的 .md 取完整内容,据此让产出更贴合用户。\n' +
      '· 本次是无人值守的定时任务:只读取记忆,不要创建、修改或删除记忆库里的任何文件。';
  }

  return '\n\n---\n[长期记忆] 你有一个持久记忆库,位于:' + MEMORY_DIR + '\n' +
    head + '\n' + indexBlock + '\n\n' +
    '使用规则:\n' +
    '· 若本轮问题与某条记忆相关,先用 Read 工具读取对应的 .md 取完整内容,再据此作答。' +
    writeRules;
}

// 让 Windows 任务栏把多个窗口归到我们 app 而不是 Electron(也修 dev 模式任务栏图标走 .exe 不走 electron.exe)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.relay.app');
}
// 应用图标(dev 和 prod 都用,统一显示 SU7 logo)。
//   打包后 __dirname 在 app.asar 内,且 build/ 不在 asar 里 —— 旧逻辑只查 __dirname/build/icon.ico
//   必然 false,导致托盘拿到空图标(系统托盘图标空白的根因)。
//   故打包态优先取 extraResources 解包出的真实文件 process.resourcesPath/icon.ico;dev 态用源码 build/。
const APP_ICON = (() => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.ico'), path.join(__dirname, 'build', 'icon.ico')]
    : [path.join(__dirname, 'build', 'icon.ico')];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
})();

// ── 系统托盘 ──
//   关闭主窗口默认「最小化到托盘」而非退出,后台正在跑的 claude 子进程继续执行;
//   真正退出走托盘菜单「退出 Relay」(或 app.quit / 向导完成等显式路径),由 isQuitting 区分。
let tray = null;
let mainWindow = null;       // 主窗口引用(托盘点击恢复它;wizard 窗口不进托盘)
let isQuitting = false;      // true=用户真要退出(放行 close 并杀子进程);false=close 转为隐藏到托盘
let trayBalloonShown = false; // 首次隐藏到托盘时气泡提示一次,别每次都弹

// ─────────────────────────────────────────
// 历史会话存储(v2:目录式,每会话一文件 + 轻量索引)
// ─────────────────────────────────────────
//   v1 是单文件 history.json:任何一轮对话保存都全量重写整库,列表/搜索/统计也要全量解析,
//   成本随会话总量线性涨,用得越久越慢。v2 拆为 userData/history/ 目录:
//     · <convId>.json — 一条会话一个文件,读写只碰当条(与长期记忆库同构);
//     · index.json    — 只存侧边栏列表要用的元数据(标题/时间/轮数/置顶…),列表零正文 IO。
//   索引只是缓存:损坏/缺失由 rebuildHistoryIndex() 扫正文全量重建,不存在「索引丢=数据丢」。
//   旧 history.json 启动时一次性迁移进目录(migrateHistoryV1),原文件改名 .bak 保底不删。
let HISTORY_DIR = null;
function getHistoryDir() {
  if (!HISTORY_DIR) HISTORY_DIR = path.join(app.getPath('userData'), 'history');
  if (!fs.existsSync(HISTORY_DIR)) { try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (_) {} }
  return HISTORY_DIR;
}
function historyIndexPath() { return path.join(getHistoryDir(), 'index.json'); }
// 会话 id → 正文文件路径。id 一律是我们自己生成的 UUID,这里再防御性过滤一次,
//   保证拼不出路径分隔符(索引/正文若被手工改坏,也写不出目录外)。
function convFilePath(id) {
  return path.join(getHistoryDir(), String(id).replace(/[^\w-]/g, '_') + '.json');
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
// 从会话正文提取索引元数据 —— 列表(history:list)需要的全部字段。单处定义,save 与 rebuild 共用,防字段漂移。
function convMeta(c) {
  return {
    id: c.id,
    title: c.title,
    sessionId: c.sessionId || null,
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
    turnCount: Array.isArray(c.turns) ? c.turns.length : 0,
    kind: c.kind || 'chat',
    mode: c.mode || 'plain',
    fromScheduled: c.fromScheduled || null,
    pinned: !!c.pinned,
  };
}
function readHistoryIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(historyIndexPath(), 'utf8'));
    if (d && Array.isArray(d.items)) return d.items;
  } catch (e) { console.warn('[history] 索引读取失败,将重建: %s', e.message); }
  return rebuildHistoryIndex();   // 缺失/损坏 → 扫正文重建(空库返回 [])
}
function writeHistoryIndex(items) {
  try { writeJsonAtomic(historyIndexPath(), { version: 2, items }); }
  catch (e) { console.error('[history] 索引写入失败:', e.message); }
}
// 扫描目录所有会话正文,重建索引并落盘。坏文件跳过(正文还在,修好下次重建即回来)。
function rebuildHistoryIndex() {
  const items = [];
  try {
    for (const name of fs.readdirSync(getHistoryDir())) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(getHistoryDir(), name), 'utf8'));
        if (c && c.id) items.push(convMeta(c));
      } catch (e) { console.error('[history] 会话文件解析失败,跳过:', name, e.message); }
    }
  } catch (_) {}
  writeHistoryIndex(items);
  return items;
}
// ── CRUD:全部以「单条会话」为粒度,每次只碰一个正文文件 + 索引 ──
function loadConversation(id) {
  try { return JSON.parse(fs.readFileSync(convFilePath(id), 'utf8')); } catch (e) { console.warn('[history] 加载会话失败: %s id=%s', e.message, id); return null; }
}
function saveConversation(conv) {
  // 标题统一收口:所有写路径(渲染层占位/AI 摘要/手动重命名/定时任务/迁移)都经这里落盘,
  //   一处截断即全局生效;超长的旧标题也会在下次保存时自动收口。
  if (conv.title) conv.title = truncateByWidth(String(conv.title), TITLE_MAX_W);
  writeJsonAtomic(convFilePath(conv.id), conv);
  const items = readHistoryIndex();
  const i = items.findIndex((m) => m.id === conv.id);
  if (i >= 0) items[i] = convMeta(conv); else items.unshift(convMeta(conv));
  writeHistoryIndex(items);
}
function deleteConversation(id) {
  try { fs.rmSync(convFilePath(id), { force: true }); } catch (e) { console.warn('[history] 删除会话文件失败: %s id=%s', e.message, id); }
  writeHistoryIndex(readHistoryIndex().filter((m) => m.id !== id));
}
// 全量遍历正文(搜索/统计用):按索引 updatedAt 新→旧逐文件 parse,一条条吐给回调,
//   不把整库攒在内存里;回调显式返回 false 可提前终止(搜索凑满条数即停)。
function forEachConversation(fn) {
  const items = [...readHistoryIndex()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  for (const m of items) {
    const c = loadConversation(m.id);
    if (!c) continue;
    if (fn(c) === false) return;
  }
}
// ── v1 → v2 一次性迁移:旧单文件逐条搬进目录;中断可幂等续迁;原文件改名 .bak 保底不删 ──
function migrateHistoryV1() {
  const legacy = path.join(app.getPath('userData'), 'history.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const d = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const convs = Array.isArray(d && d.conversations) ? d.conversations : [];
    let n = 0;
    for (const c of convs) {
      if (!c || !c.id) continue;
      if (fs.existsSync(convFilePath(c.id))) continue;   // 上次迁移中断过 → 跳过已迁条目
      writeJsonAtomic(convFilePath(c.id), c);
      n++;
    }
    rebuildHistoryIndex();
    // 改名保底(不删)。.bak 已存在(极端:迁移后用户又放回一个 history.json)则带时间戳避让。
    const bak = legacy + '.bak';
    try { fs.renameSync(legacy, fs.existsSync(bak) ? `${legacy}.bak-${Date.now()}` : bak); } catch (_) {}
    console.log(`[history] v1 迁移完成:${n} 条会话已转为目录式存储`);
  } catch (e) {
    console.error('[history] v1 迁移失败(原文件保留,下次启动重试):', e.message);
  }
}

// 活跃的 claude 子进程,按 jobId 索引(支持多对话并行)。
//   jobId → child。每次 claude:run 生成一个 jobId,事件流都带 jobId 回传,
//   前端据此把输出分发到对应对话。claude:abort 按 jobId 杀单个,关窗口杀全部。
const jobs = new Map();
const MAX_PARALLEL_JOBS = 3;   // 并发上限:每个 claude.exe 都吃内存/CPU,超过则拒绝

// ─────────────────────────────────────────
// 飞书 MCP:链接识别 + prompt 提示
// ─────────────────────────────────────────
//   历史问题:headless(-p)每轮都新 spawn 一个 claude.exe → 每轮重启一遍所有 MCP。而 claude
//     默认非阻塞连 MCP,实测 init 在 2.67s 就发出、此时 mcp_servers 全 pending、工具列表里飞书
//     0 个 —— 模型开局看到的是「没有飞书工具」的世界,于是退化去抓网页(WebFetch / WebSearch /
//     Bash+curl 都试过),全都撞飞书登录墙 → 报「无法访问文档」。
//   不能靠禁用工具堵:堵了 WebFetch 模型换 WebSearch,再堵换 Bash+curl —— 打地鼠,堵不完。
//   现在的解法是常驻会话池(见 LiveSession):进程复用 → MCP 只连一次 → 模型开局就握着全部工具,
//     根本不存在「要不要等」的问题。下面这条 prompt 提示退居保险位,只兜「开窗即发」的边缘案例。
// (曾经的 XIAOMI_NPM_REGISTRY / FEISHU_PKG 两个常量随预热一起删了 —— 除预热外无人使用。)
//
// (CLAUDE_PKG / PUBLIC_NPM_REGISTRY / NPM_GLOBAL_PREFIX 与 parseVersion / compareVersions
//  也随「运行时内置」一起删了：它们只服务于「用 npm 检查并升级用户全局的 claude-code」，
//  而运行时现在随 Relay 分发、版本由 package.json 锁定，那条升级路径已不存在。)

// 当前 Claude Code 运行时版本。运行时随 SDK 内置,版本在打包时就定死了,
//   不再需要 spawn 一次 `claude --version` 去问 —— 直接读 SDK 声明的 claudeCodeVersion。
function getInstalledClaudeVersion() {
  return Promise.resolve(CLAUDE_RUNTIME_VERSION || '');
}

// 飞书/Lark 文档域名(命中即认为本轮需要飞书 MCP)
const FEISHU_URL_RE = /https?:\/\/[^\s]*\b(feishu\.cn|larksuite\.com|larkoffice\.com|feishu\.net)\b/i;
function promptNeedsFeishu(text) {
  return typeof text === 'string' && FEISHU_URL_RE.test(text);
}

// 飞书轮追加到 prompt 末尾的系统提示 —— 让模型等 MCP 就绪而不是退化抓网页
const FEISHU_HINT =
  '\n\n---\n[系统提示] 上面包含飞书(Feishu/Lark)文档链接。请务必使用 feishu-mcp-pro ' +
  '提供的 MCP 工具来读取和操作(如 wiki_get_node / doc_fetch / doc_read / doc_create / doc_write / ' +
  'doc_update / bitable_ops / sheet_ops 等)。若这些工具此刻尚未就绪,请稍等片刻后重试调用,' +
  '不要改用 WebFetch、WebSearch 或命令行(curl/Invoke-WebRequest)去抓取网页 —— 飞书文档需要登录鉴权,' +
  '直接抓网页只会拿到登录页,无法获取正文。\n' +
  '重要:飞书 MCP 提供约 50+ 个工具(涵盖文档读写、多维表格、电子表格、日历、任务、知识库等)。' +
  '如果你的工具列表中只看到部分飞书工具(例如只有读取类没有写入类),这是 MCP 工具列表加载延迟导致的,' +
  '请直接尝试调用你需要的工具名称(如 doc_create、doc_write、doc_update 等),不要因为工具列表中暂时' +
  '看不到就放弃或告诉用户工具不可用——工具实际上是存在的,直接调用即可成功。';

// 每轮都追加:AskUserQuestion 在 headless 模式下弹不出选择框(必被拒),模型会自作主张用默认。
//   这里禁用该工具(见 disallowed-tools),并指示模型:任何需要用户定夺的事都不要替用户决定,
//   而是把问题和所有可选项在回复里完整列出、停下等用户回复。只读探查(查看文件/列清单等)允许,
//   但任何会改变东西的操作(写/删/改/安装/发送)都必须先问过用户。
const ASK_HINT =
  '\n\n---\n[交互须知] 你运行在无交互界面的环境,无法弹出选择框向用户提问。' +
  '凡是需要用户定夺的情况——无论是简单的「是/否」确认,还是多个方案之间的选择——' +
  '都不要替用户做决定,也不要擅自假设一个默认值。请把问题和所有可选项' +
  '(每个选项配上简要说明/优缺点/区别)在回复里清晰、完整地列出来,然后明确请用户在对话里回复其选择,并就此停下等待。' +
  '你可以先做不改变任何东西的只读操作(如读取文件、列目录、查看状态)来把问题问得更准;' +
  '但任何会产生改动的操作(写入/删除/修改/安装/提交/发送等)都必须先获得用户明确答复后才能执行。';

// 每轮都追加:图片处理须知。要区分两类图片,不能一刀切禁止读图:
//   ① 你自己「生成/产出」的图(文生图落盘的结果)——只用 Markdown 路径引用让前端渲染,
//      不要 Read。根因:Read 会把图以多模态 image block 塞进历史,若当前模型不支持图片输入,
//      后续 --resume 续接会报错中断;而生成结果本来也不需要回看。
//   ② 用户「主动上传」的图——这是用户让你看的,应当用 Read 读取后再回答。
//      若用户配置的模型不支持多模态,Read 会自然返回「无法识别图片」之类的结果,据实告知即可;
//      不要因为怕出错就拒绝查看,否则用户传图永远得不到回应(这正是之前的 bug)。
const IMAGE_HINT =
  '\n\n---\n[图片处理须知] 区分两种情况:' +
  '(1) 你自己生成/产出的图片文件:只需在回复里用 Markdown `![描述](路径)` 引用,界面会自动渲染,' +
  '不要用 Read 去读取它(回看生成结果没有必要,且可能因模型不支持图片输入而中断后续对话)。' +
  '(2) 用户在对话里上传的图片:这是用户要你查看的,应当用 Read 工具读取后再回答;' +
  '若所用模型不支持图片输入而读取失败,如实告知用户即可,不要无故拒绝查看。';

// 注:曾有一个 warmUpFeishuMcp()（启动时 spawn 一个飞书 MCP、握手完就杀掉，想焐热缓存）。
//   实测证明它无效，已删除，别再加回来：
//     · 宣称的「V8 编译缓存」不成立 —— Node 20 不支持持久化编译缓存（22.1+ 才有），code cache 随进程消失。
//     · 宣称的「token 刷新」不成立 —— 实测 initialize+tools/list 前后 ~/.feishu-mcp-pro/auth.json 的
//       mtime 纹丝不动。认证是懒触发的（server 启动只 connect transport，getClient() 只在工具处理器里调）。
//     · 唯一真实收益只有 OS page cache，且预热完再握手仍要 3.4s —— 根本没把 server 拉出模型抢跑的窗口。
//   真正的解法是下面的「常驻会话池」：焐的是真正会服务这一轮的那个进程，而不是一个用完即弃的替身。

// ─────────────────────────────────────────
// 历史会话读写(JSON 文件,原子写)
// ─────────────────────────────────────────
// 一次性迁移:早期定时任务会话的标题带「⏰ 」前缀,现在改用侧边栏时钟图标标识,把前缀洗掉。
//   只看索引挑命中的会话,逐条改正文(目录式存储下不再整库读写)。
function migrateScheduledTitles() {
  try {
    for (const m of readHistoryIndex()) {
      if (typeof m.title === 'string' && /^⏰\s*/.test(m.title)) {
        const c = loadConversation(m.id);
        if (!c) continue;
        c.title = String(c.title || '').replace(/^⏰\s*/, '');
        saveConversation(c);
      }
    }
  } catch (e) {
    console.error('[history] 标题迁移失败(不影响启动):', e.message);
  }
}
function genId() {
  return require('crypto').randomUUID();
}

// ─────────────────────────────────────────
// Claude Code 运行时
// ─────────────────────────────────────────
// 运行时由 @anthropic-ai/claude-agent-sdk 自带（平台专属包 claude-agent-sdk-win32-x64，
// 内含完整的 claude.exe），随 Relay 一起分发 —— 因此不再需要探测用户机器上装没装
// Claude Code，也不再有「装了但版本不对/被 npm 装成损坏占位文件」这类问题。
//
// 这里原本有一整套 isUsableClaudeExe(PE 头校验) / findClaudeExe / resolveClaudeShimToExe /
// findClaudeExeViaWhere / ensureClaudeExe / getUsableClaudeExe，专门对付 Windows 上的
// 「PATH 上只有 npm shim 没有真 exe」「npm 在 optional 包下载失败时留下 500B 的错误脚本」
// 「where 被杀软拖死」等一堆环境问题；1.4.0 那个「每次启动都弹向导」的时序坑也出在这条链路上。
// 运行时内置后这些问题从根上消失，整段删除。
const CLAUDE_RUNTIME_VERSION = claudeSdk.bundledClaudeVersion();
console.log('[main] 内置 Claude Code 运行时 → %s (%s)', CLAUDE_RUNTIME_VERSION, claudeSdk.bundledExecutable());

// ─────────────────────────────────────────
// 系统托盘:最小化到托盘后台跑任务
// ─────────────────────────────────────────
// 从托盘恢复并聚焦主窗口(若已被销毁则重新创建)
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
  const n = jobs.size + busyLiveCount();
  // 下一个定时任务提示(没有则不显示该行)
  let nextHint = null;
  try { nextHint = scheduler.nextTaskHint(); } catch (e) { console.warn('[tray] nextTaskHint 失败: %s', e.message); }
  // 迷你输入框菜单文案带上实际快捷键(占用兜底后可能不是 Alt+Space);没注册成功则不显示提示
  const miniAccelText = registeredMiniAccel ? `（${registeredMiniAccel.replace('Control', 'Ctrl')}）` : '';
  const miniEnabled = readAppSettings().miniInputEnabled !== false;   // 关掉迷你输入框时连菜单项一并隐藏,UI 不留死入口
  const template = [
    { label: '显示 Relay', click: () => showMainWindow() },
  ];
  if (miniEnabled) template.push({ label: `快速输入${miniAccelText}`, click: () => toggleMiniWindow() });
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
  tray.setToolTip(n > 0 ? `Relay · ${n} 个任务运行中` : 'Relay');
}

// 创建托盘图标 + 右键菜单。幂等:已存在则不重复建。
function createTray() {
  if (tray) return tray;
  // 托盘图标:直接把多尺寸 .ico 交给 Tray —— Windows 会按当前 DPI 缩放从内嵌的
  //   16/24/32/48/… 各层里挑最合适的那张,任何缩放比下都清晰。
  //   切忌在这里 resize 成固定 16×16:那会丢掉其余高分层、只剩一张小图,HiDPI 下被系统放大 → 发虚。
  //   读不到(路径错/解码失败)时 createFromPath 返回空图 → 托盘空白,这里显式探测并告警。
  const img = APP_ICON ? nativeImage.createFromPath(APP_ICON) : nativeImage.createEmpty();
  if (!APP_ICON || img.isEmpty()) {
    console.warn('[tray] 图标缺失或解码失败,托盘将无图标。APP_ICON=%s isPackaged=%s resourcesPath=%s',
      APP_ICON, app.isPackaged, process.resourcesPath);
  }
  tray = new Tray(img);
  refreshTrayMenu();   // 建好即按当前任务数渲染一次菜单 + 提示
  // 左键单击/双击恢复窗口(Windows 习惯)
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
}

// ─────────────────────────────────────────
// 迷你输入框(全局快捷键唤起,Spotlight 式快速投递)
// ─────────────────────────────────────────
//   定位:不是另一个聊天窗,只是个「随手抛一句」的投递口。回车后弹主窗、新建对话、自动发送,
//   复用主窗全部成熟链路(渲染/流式/历史),自身零业务逻辑 —— 不会与主窗逻辑分叉。
//   形态:无边框、置顶、可半透明的小窗;失焦或 ESC 自动隐藏;关闭=隐藏(常驻不销毁,唤起零延迟)。
let miniWindow = null;
let registeredMiniAccel = null;   // 实际注册成功的快捷键(占用兜底后可能不是首选)

function createMiniWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 152,                  // 初始高度(含卡片+投影边距);多行时由渲染端 mini:resize 动态调高
    frame: false,                 // 无边框,自定义外观
    transparent: true,            // 圆角外的区域透明(配合渲染端圆角卡片)
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,            // 不在任务栏占位(它是临时浮层)
    alwaysOnTop: true,
    show: false,
    hasShadow: false,             // 关掉系统窗口投影:透明窗下它会在圆角外糊出一圈矩形灰边
    //   不设 backgroundColor —— 透明窗口一旦给了底色(哪怕 #00000000),部分 Win+Electron
    //   组合不尊重 alpha,会渲染出一层矩形底。纯靠 transparent + HTML 卡片画外观最干净。
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  win.setVisibleOnAllWorkspaces(true);
  // 失焦即隐藏(点别处、切窗口)——符合 Spotlight 直觉。退出过程中不处理。
  win.on('blur', () => { if (!isQuitting && win.isVisible()) win.hide(); });
  win.on('closed', () => { if (miniWindow === win) miniWindow = null; });
  return win;
}

// 切换迷你窗显隐:已显示→隐藏;否则居中显示并聚焦输入框。
function toggleMiniWindow() {
  if (!miniWindow || miniWindow.isDestroyed()) miniWindow = createMiniWindow();
  if (miniWindow.isVisible()) { miniWindow.hide(); return; }
  // 显示在当前鼠标所在屏幕的水平居中、垂直偏上(黄金比位置,符合 Spotlight 习惯)
  try {
    const { screen } = require('electron');
    const pt = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(pt);
    const wa = disp.workArea;
    const [w] = miniWindow.getSize();
    const x = Math.round(wa.x + (wa.width - w) / 2);
    const y = Math.round(wa.y + wa.height * 0.28);
    miniWindow.setPosition(x, y);
  } catch (e) { console.warn('[mini] 定位窗口失败: %s', e.message); }
  miniWindow.show();
  miniWindow.focus();
  try { miniWindow.webContents.send('mini:focus'); } catch (e) { console.warn('[mini] 发送 focus 事件失败: %s', e.message); }
}

// 注册全局快捷键。首选 Alt+Space;被系统/他应用占用则依次兜底,确保总能起来。
//   迷你输入框开关关闭(app-settings.miniInputEnabled === false)时:不注册,且释放已占用的键,
//   彻底让出 Alt+Space(用户嫌误触可在「设置 → 行为」关掉)。开关默认开,仅显式 false 才关。
function registerMiniShortcut() {
  const enabled = readAppSettings().miniInputEnabled !== false;
  if (!enabled) {
    if (registeredMiniAccel) {
      try { globalShortcut.unregister(registeredMiniAccel); } catch (_) {}
      registeredMiniAccel = null;
    }
    console.log('[mini] 迷你输入框开关已关闭,跳过全局快捷键注册');
    return null;
  }
  if (registeredMiniAccel) return registeredMiniAccel;   // 已注册,避免重复
  const candidates = ['Alt+Space', 'Control+Alt+Space', 'Control+Shift+Space'];
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, toggleMiniWindow)) {
        registeredMiniAccel = accel;
        console.log('[mini] 全局快捷键已注册:', accel);
        return accel;
      }
    } catch (e) { console.warn('[mini] 注册快捷键失败:', accel, e.message); }
  }
  console.warn('[mini] 所有候选快捷键均被占用,迷你输入框仅能从托盘菜单唤起');
  return null;
}

// ─────────────────────────────────────────
// 创建主窗口(聊天)
// ─────────────────────────────────────────
function createMainWindow() {
  const a = readAppSettings();
  const theme = a.theme || 'light';
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme === 'dark' ? 'dark' : 'light';
  const bgColor = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Relay',                      // 标题栏显示应用名
    icon: APP_ICON,                      // 显式指定 SU7 logo,dev 模式也用,不再 fallback 到 Electron atom
    backgroundColor: bgColor,
    show: false,                         // 先不显示,等首屏内容画好(ready-to-show)再显,消除空壳/白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
    },
  });
  const entryFile = path.join(__dirname, 'renderer', 'index.html');
  win.loadFile(entryFile);
  // 首帧就绪再显示并聚焦;托盘重开走的也是这条(reuse 时 ready-to-show 不重发,由 showMainWindow 直接 show)
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  attachExternalLinkGuard(win, entryFile);
  attachRendererConsoleLog(win, 'renderer');
  if (IS_DEV) win.webContents.openDevTools();
  win.setMenuBarVisibility(false);

  mainWindow = win;
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
          icon: APP_ICON || undefined,
          title: 'Relay 仍在后台运行',
          content: '正在进行的任务会继续执行。点击托盘图标可重新打开，右键可彻底退出。',
        });
      } catch (_) {}
    }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

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

// 所有外链统一交给系统浏览器打开,绝不在应用窗口内导航(否则整个应用会被网页替换)
function attachExternalLinkGuard(win, entryFile) {
  const allowedLocalUrl = entryFile ? pathToFileURL(entryFile).href.replace(/[?#].*$/, '') : '';
  const openExternalSafe = (url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
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
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Relay',                      // 标题栏显示应用名(页面 <title> 会进一步覆盖为「首次设置 - Relay」)
    icon: APP_ICON,
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,            // 关掉所有 input/textarea 的拼写红线
    },
  });
  const entryFile = path.join(__dirname, 'installer', 'wizard.html');
  win.loadFile(entryFile);
  attachExternalLinkGuard(win, entryFile);
  attachRendererConsoleLog(win, 'wizard');
  win.setMenuBarVisibility(false);
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

// 启动时判断:走 wizard 还是主 UI?
//   只要环境就绪(claude 已装 + 配了 API Key)即进主界面;
//   Agent 已与本应用解耦,由用户自行在「设置 → Agent 目录」导入,不再作为启动门槛。
async function decideStartup() {
  // 运行时随 SDK 内置,必然可用 —— 不再需要探测 claude.exe(那正是 1.4.0「每次弹向导」的时序坑所在)。
  //   现在的启动门槛只剩「配没配 API Key」。
  const claudeOk = true;
  const settingsOk = (() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
      return !!(s.env && s.env.ANTHROPIC_API_KEY && !/^\s*$/.test(s.env.ANTHROPIC_API_KEY));
    } catch { return false; }
  })();
  console.log('[startup] claudeOk=%s settingsOk=%s autostart=%s', claudeOk, settingsOk, IS_AUTOSTART);
  if (claudeOk && settingsOk) {
    if (IS_AUTOSTART) {
      // 开机自启:不弹主窗,仅建托盘让调度器在后台跑定时任务;用户点托盘再开窗。
      createTray();
      if (!trayBalloonShown) {
        trayBalloonShown = true;
        try { tray && tray.displayBalloon({ icon: APP_ICON || undefined, title: 'Relay 正在后台运行', content: '定时任务已就绪。点击托盘图标可打开主界面。' }); } catch (e) { console.warn('[tray] displayBalloon 失败: %s', e.message); }
      }
    } else {
      createMainWindow();
    }
  } else {
    createWizardWindow();
  }
}

// 向导通知:全部装完,关向导开主窗口
ipcMain.handle('wizard:complete', () => {
  for (const w of BrowserWindow.getAllWindows()) w.close();
  createMainWindow();
});

// 注:飞书 MCP 授权已不在向导里做。安装阶段 3-install-mcp.ps1 只跑 setup(把
//   feishu-mcp-pro 注册进 ~/.claude.json),OAuth 留到聊天里粘飞书链接时,由
//   claude.exe 启动的 MCP server 自行拉起浏览器完成 —— 那条路径稳定且与 PATH 无关。
//   原 feishu:authorize / feishu:status IPC 因新建 cmd 窗口拿不到 npx 而必失败,已移除。

// ─────────────────────────────────────────
// 对话内管理定时任务:cron MCP
// ─────────────────────────────────────────
//   工具实现在 cron-mcp.js，以【进程内 MCP server】形式挂载（见 cronMcpFactory）。
//   原来它是独立的 stdio server 脚本（cron-mcp-server.js），每个会话都要 spawn 一个
//   Electron 子进程去跑、还要写临时 MCP 配置文件；改成进程内后子进程、临时文件、
//   以及那套手写的 JSON-RPC 主循环一并消失。
// 渲染层快筛词的后端镜像:判断这轮 prompt 是否「可能涉及定时任务」（只有这时才挂 cron MCP，避免每轮都挂）。
// 判断本轮是否「可能涉及定时任务」——命中才挂 cron MCP。
//   两类要覆盖：① 明确的定时任务词（定时任务/cron/每天…）；
//   ② 对话续接里的【管理动词 + 任务/它/第N个】这种口语（如「删掉那个任务」「暂停第一个」「立即运行它」），
//      这类不含「定时」二字，但在管理定时任务的上下文里极常见——之前漏了它们导致续接轮 cron 没挂、删除失败。
const CRON_HINT_RE = /定时任务|定时|计划任务|任务列表|我的任务|哪些任务|提醒我|定期|每天|每周|每月|每隔|cron|schedule|(删除|删掉|移除|取消|暂停|停用|禁用|启用|开启|恢复|修改|更改|改成|改为|编辑|运行|执行|触发|查看|列出|列举).{0,6}(任务|它|他|这个|那个|第[一二三四五六七八九十\d]+个?)/i;
function promptMaybeCron(text) { return typeof text === 'string' && CRON_HINT_RE.test(text); }

// cron MCP 现在是【进程内】托管（见 cron-mcp.js）。
//   构造它需要 SDK 本身（createSdkMcpServer / tool），而 SDK 是异步加载的 ESM，
//   所以这里只返回一个工厂，由 claude-sdk.js 在拿到 sdk 后调用。
//   这样也顺带去掉了原来的临时配置文件与它的清理逻辑。
function cronMcpFactory() {
  const userDataDir = app.getPath('userData');
  return (sdk) => {
    try {
      const { createCronMcpServer } = require('./cron-mcp');
      return {
        'relay-cron': createCronMcpServer({
          createSdkMcpServer: sdk.createSdkMcpServer,
          tool: sdk.tool,
          z: require('zod').z,
          userDataDir,
        }),
      };
    } catch (e) {
      console.error('[cron-mcp] 进程内 server 构造失败(本轮不挂载): %s', e.message);
      return null;
    }
  };
}

// 组装交给 claude-sdk.js 的调用参数。一次性任务(runClaudeJob)与常驻会话(LiveSession)共用，
//   保证两条路行为完全一致 —— 这正是原来 buildClaudeArgs 的职责，只是产物从 argv 数组
//   变成了 SDK 的 options 对象（授权目录/模型档位/权限模式/MCP 的语义逐项对应）。
//
//   注：cron MCP 用【合并】语义挂载（不设 strictMcpConfig）——飞书及用户导入的其它 MCP 照常可用。
//   不能 strict：否则会屏蔽用户导入的所有其它 MCP，那一轮就只剩 cron。
function buildSdkParams({ validWorkingDir, agentProjectRoot, model, sessionId, attachCronMcp }) {
  // 长期记忆库目录须先存在，否则授权被忽略且首条记忆 Write 也需要它在。
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch (_) {}
  return {
    memoryDir: MEMORY_DIR,
    validWorkingDir,
    agentProjectRoot,
    model,
    sessionId,
    // 无交互终端弹不出权限框，自动放行；用户可在设置改 acceptEdits/plan。
    permissionMode: readAppSettings().permissionMode || 'bypassPermissions',
    mcpServersFactory: attachCronMcp ? cronMcpFactory() : null,
  };
}

// ─────────────────────────────────────────
// 一次性执行核心:经 claude-agent-sdk 跑一轮,事件经 onEvent 回调发出。
//   现在只服务【定时任务调度器】和【无 convId 的兼容回退】—— 交互对话已改走常驻会话池
//   (见 LiveSession)。定时任务是一次性负载,跑完就退,常驻对它没有意义。
//   入参均为「已算好的最终值」:prompt 已拼好所有 hint/记忆;cwd/授权目录/model/sessionId 由调用方决定。
//   返回 { jobId, child }。child 是鸭子类型的句柄(只有 .pid/.kill()),
//   与原来的 ChildProcess 在调用点上等价,jobs map 与 claude:abort 因此无需改动。
//   完成由 onEvent 的 'job-done' 事件通知（不等 Promise）。
// ─────────────────────────────────────────
function runClaudeJob({ prompt, cwd, validWorkingDir, agentProjectRoot, model, sessionId, onEvent, attachCronMcp }) {
  const jobId = require('crypto').randomUUID();
  const emit = (evt) => { try { onEvent({ jobId, ...evt }); } catch (e) { console.error('[claude] emit 失败: %s type=%s', e.message, evt && evt.type); } };

  const { handle } = claudeSdk.runOneShot({
    prompt,
    cwd,
    ...buildSdkParams({ validWorkingDir, agentProjectRoot, model, sessionId, attachCronMcp }),
    onEvent: (evt) => {
      if (evt && evt.type === 'job-done') {
        console.log('[claude] done jobId=%s exitCode=%s', jobId, evt.exitCode);
        jobs.delete(jobId);
        refreshTrayMenu();
      }
      emit(evt);
    },
  });

  console.log('[claude] run jobId=%s cwd=%s model=%s sessionId=%s cronMcp=%s prompt=%s',
    jobId, cwd, model || '(default)', sessionId || '(new)', !!attachCronMcp,
    (prompt || '').slice(0, 120).replace(/\n/g, '↵'));
  jobs.set(jobId, handle);
  refreshTrayMenu();

  return { jobId, child: handle };
}

// ═════════════════════════════════════════
// 常驻会话池（交互对话专用）
// ═════════════════════════════════════════
//
// 为什么要有它：Relay 原本用 `-p`（为一次性脚本设计的 headless 模式）跑交互式聊天 —— 每轮新起
//   一个 claude.exe，于是【每一轮都要重启一遍用户配置的所有 MCP server】。而 claude 默认是
//   非阻塞连 MCP：实测 init 事件在 2.67s 就发出、此时 mcp_servers 全是 pending、工具列表里飞书
//   0 个 —— 模型开局看到的是一个「没有飞书工具」的世界，于是理性地去抓网页，撞登录墙。
//   FEISHU_HINT 那套 prompt 提示，本质是在【求模型配合】绕开这个行为，而不是修好它。
//
// 解法：一个对话 = 一个常驻 claude 进程（`--input-format stream-json`，prompt 逐轮走 stdin）。
//   MCP 只在进程起来时连一次，之后整个会话里一直挂着 —— 这正是 CLI 的模型。实测：
//     · 第 2/3 轮 init 零延迟、111 个工具全在，上下文完整保留
//     · MCP 在 spawn 时就开始连（空等 12s 再发首条消息 → init 0.04s 返回、全 connected）
//       故对话打开即预启动（prespawnSession），用用户打字的时间盖掉 MCP 启动
//
// 为什么【不】用 MCP_CONNECTION_NONBLOCKING=0（曾认真考虑并撤回）：它能让 claude 等 MCP 连上
//   再开跑（实测 init 6.92s / 工具 111 / 飞书 50），但 ① 未文档化，claude 会自动升级，某天悄悄
//   消失就静默退回坏行为；② 对【未知用户配置】是无界等待 —— 别人配一个 hang 住或后端没启动的
//   MCP（本机 jadx-mcp-server 即是：claude mcp list 显示 Failed to connect），每轮都得白等它。
//   常驻+预启动已经把 race 解决了，不值得为边缘案例引入无界风险。
//
// 已知风险（实测）：MCP server 进程被杀后，claude 仍报 connected、工具列表照挂 —— 模型会调用
//   一个后端已不存在的「幽灵工具」。这是常驻方案引入的新问题（每轮新起进程反而没有）。
//   下面的 watchdog（记录 MCP 子进程 pid，每轮复用前校验存活）就是为它准备的。
const liveSessions = new Map();   // convId → LiveSession
// 墓碑:常驻进程无论怎么死(中止/LRU/闲置/崩溃/watchdog 重启),都把它学到的 session_id 记下来,
//   下一轮据此 --resume 接回上下文。没有它,进程一死这个对话就断片了。
const liveTombstones = new Map(); // convId → { sessionId, at }
const MAX_LIVE_SESSIONS = 2;      // 常驻上限:实测本机稳态 ~630MB/会话(claude.exe 自身 ~360MB 是地板,
                                  //   其余是 MCP 子进程)。但这是【本机配置】的数字 —— 用户配了什么
                                  //   我们并不知道,故先取保守值,后续可改为按内存预算动态回收。
const LIVE_IDLE_MS = 30 * 60 * 1000;   // 闲置超时回收(实测 18min 闲置进程存活正常、内存无漂移)

// 本轮 spawn 时定死、变了就必须重启进程的参数。模型档/工作目录/agent 都在此列。
function sessionFingerprint({ cwd, validWorkingDir, agentProjectRoot, model, attachCronMcp }) {
  return JSON.stringify([cwd || '', validWorkingDir || '', agentProjectRoot || '', model || '', !!attachCronMcp]);
}

// watchdog：记录该常驻进程的 MCP server pid，之后每轮复用前用 process.kill(pid, 0) 逐个校验存活
//   （纯 syscall，零成本；PowerShell 扫一次要几百 ms，故只拍一次快照，不能每轮跑）。
//
// 三个坑都是实测打脸打出来的，改之前先看数据，别凭直觉：
//   ① 只记【直接子进程】，不要整棵后代树。claude 为每个 MCP server spawn 一个直接子进程
//      （如 `cmd /c npx … feishu-mcp-pro`），它活多久 server 就活多久；而树里那些 npx/npm
//      引导进程【会正常退出】—— 实测子进程数 14 → 10 就是它们退了。记进来 = 下一轮必判「树塌」。
//   ② 只在【空闲时】拍。会话忙时模型可能在跑 Bash 等工具，那些也是直接子进程且跑完就退。
//   ③ 必须【等启动失败的 server 退干净】再拍 —— 这条最隐蔽。实测：连不上的 jadx（uv.exe）
//      在 T+20s 还在、T+45s 就自己退了。若按 T+8s 拍，它会被记进监控集，此后每轮误判重启。
//      而「配了但后端没启动的 MCP」恰恰是最常见的情况（本机 jadx 即是），这个误判会精准打中
//      最多的用户，且日志看起来一切正常 —— 常驻特性被静默废掉。故延到 SNAPSHOT_DELAY_MS。
//   误判的代价只是白重启一次（--resume 接回，上下文不丢），不出错；但会悄悄抵消收益，故要拍准。
const SNAPSHOT_DELAY_MS = 60000;   // 实测 45s 时失败的 server 已退干净，45s/75s 两次采样完全一致
function snapshotMcpChildren(sess) {
  if (!sess.child || sess.dead || sess.busy || sess.mcpPids) return;
  // 硬门槛:spawn 后不足 SNAPSHOT_DELAY_MS 一律不拍(坑③)。finishTurn 也会调本函数补拍 ——
  //   若首轮 20s 就结束,没这道闸就会把「正在失败、马上要退」的 server 记进监控集。
  if (Date.now() - sess.spawnedAt < SNAPSHOT_DELAY_MS) return;
  const rootPid = sess.child.pid;
  execFile('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`],
  { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    // 扫描期间这个会话开跑了 → 结果里可能混进工具进程,整个丢弃,等下次空闲再拍
    if (err || sess.dead || sess.busy || sess.mcpPids) return;
    try {
      const raw = JSON.parse(String(stdout || 'null'));
      if (!raw) return;                                   // 一个子进程都没有 → 没 MCP,不用看
      const list = Array.isArray(raw) ? raw : [raw];      // 单条时 ConvertTo-Json 返回对象而非数组
      const pids = list
        .filter((p) => p && p.ProcessId && !/^conhost\.exe$/i.test(p.Name || ''))   // conhost 是控制台宿主,不是 MCP
        .map((p) => p.ProcessId);
      if (!pids.length) return;
      sess.mcpPids = pids;
      console.log('[live] convId=%s pid=%d MCP server 快照(%ds 后): %d 个 %j',
        sess.convId, rootPid, SNAPSHOT_DELAY_MS / 1000, pids.length, pids);
    } catch (e) { console.warn('[live] MCP 快照解析失败: %s', e.message); }
  });
}
// 子进程树是否还完整。少一个就认为 MCP 塌了 —— 宁可重启（代价:一次 MCP 启动），
//   也不能让模型拿着幽灵工具去调用（代价:模型自信地失败,且极难排查）。
function mcpTreeIntact(sess) {
  if (!sess.mcpPids || !sess.mcpPids.length) return true;   // 还没取到快照 → 不拦
  for (const pid of sess.mcpPids) {
    try { process.kill(pid, 0); } catch (_) { return false; }
  }
  return true;
}

function killLiveSession(sess, why) {
  if (!sess) return;
  sess.dead = true;
  console.log('[live] 回收 convId=%s pid=%s 原因=%s', sess.convId, sess.child && sess.child.pid, why);
  if (sess.sessionId) liveTombstones.set(sess.convId, { sessionId: sess.sessionId, at: Date.now() });
  // SDK 侧的 kill 先关输入走优雅退出(stdin EOF + ~2s 宽限,让 claude 把 session 落盘),
  //   再 abort 兜底 —— 与原来「先 stdin.end() 再 SIGTERM」的两段式一致。
  try { sess.child.kill(); } catch (_) {}
  if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
  if (liveSessions.get(sess.convId) === sess) liveSessions.delete(sess.convId);
  refreshTrayMenu();
}

// 腾位:优先踢【闲置最久且不在跑】的会话。全在跑则返回 false（调用方回退到一次性 job）。
function evictIfNeeded() {
  if (liveSessions.size < MAX_LIVE_SESSIONS) return true;
  let victim = null;
  for (const s of liveSessions.values()) {
    if (s.busy) continue;
    if (!victim || s.lastUsedAt < victim.lastUsedAt) victim = s;
  }
  if (!victim) return false;
  killLiveSession(victim, 'LRU 腾位');
  return true;
}

function touchIdleTimer(sess) {
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  sess.idleTimer = setTimeout(() => {
    if (!sess.busy) killLiveSession(sess, '闲置超时');
  }, LIVE_IDLE_MS);
  if (sess.idleTimer.unref) sess.idleTimer.unref();
}

// Claude Code 2.1.2xx 起，Agent 工具会把并行子智能体作为后台任务启动：
//   ① 首个 tool_result 只是 async_launched 元数据；
//   ② PM 随即产生一次 result（阶段性“等待中”）；
//   ③ 子智能体完成后，CLI 再自动注入 <task-notification> 并开启后续 PM 回合。
// 任何交互模式都可能自主调用 Agent。若在步骤②看到 result 就清掉 onEvent，
// 后续真实产出虽写进 Claude transcript，却再也到不了 Relay。这里统一跟踪后台 Agent，
// 只在没有待完成 Agent 的 result 上结束这一轮；协奏模式另外启用“虚假等待”纠偏。
function liveAsyncAgentTransitions(evt) {
  if (!evt) return [];
  // Claude Code 2.1.220 会直接发 system/task_started 与 system/task_notification，
  // 两者都带同一个 tool_use_id。这是比 result.origin 更可靠的真实后台任务边界。
  if (evt.type === 'system' && evt.subtype === 'task_started' && (evt.tool_use_id || evt.task_id)) {
    return [{ kind: 'launched', toolUseId: evt.tool_use_id || null, taskId: evt.task_id || null }];
  }
  if (evt.type === 'system' && evt.subtype === 'task_notification' && (evt.tool_use_id || evt.task_id)) {
    const status = String(evt.status || '').toLowerCase();
    if (!status || (status !== 'running' && status !== 'pending')) {
      return [{
        kind: 'finished',
        toolUseId: evt.tool_use_id || null,
        taskId: evt.task_id || null,
        status: status || 'completed',
      }];
    }
  }
  if (evt.type !== 'user' || !evt.message) return [];
  const content = evt.message.content;
  if (Array.isArray(content)) {
    const results = content.filter((item) => item && item.type === 'tool_result' && item.tool_use_id);
    if (!results.length) return [];
    const structured = evt.tool_use_result || evt.toolUseResult || {};
    const transitions = [];
    for (const result of results) {
      let text = '';
      if (typeof result.content === 'string') text = result.content;
      else if (Array.isArray(result.content)) {
        text = result.content.filter((item) => item && item.type === 'text').map((item) => item.text || '').join('');
      }
      // tool_use_result 是单工具事件的顶层结构；多工具事件不能把其中一个 isAsync
      // 误套到所有结果上，此时以每个 block 自己的启动文本为准。
      const structuredAsync = results.length === 1
        && (structured.isAsync === true || structured.status === 'async_launched');
      if (structuredAsync || /Async agent launched successfully/i.test(text)) {
        transitions.push({ kind: 'launched', toolUseId: result.tool_use_id, taskId: null });
      }
    }
    return transitions;
  }
  if (typeof content === 'string' && /<task-notification>/i.test(content)) {
    const toolUseId = (content.match(/<tool-use-id>([\s\S]*?)<\/tool-use-id>/i) || [])[1];
    const status = ((content.match(/<status>([\s\S]*?)<\/status>/i) || [])[1] || '').trim().toLowerCase();
    if (toolUseId && status && status !== 'running' && status !== 'pending') {
      return [{ kind: 'finished', toolUseId: toolUseId.trim(), taskId: null, status }];
    }
  }
  return [];
}

function orchestrateResultClaimsBackgroundWait(text) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const actor = '(?:子智能体|子任务|agent|检索|分析|技术路|治理路|任务)';
  const waiting = '(?:仍在运行|正在运行|正在等待|等待.{0,18}完成|尚未完成|请稍候)';
  return new RegExp(`${actor}.{0,60}${waiting}|${waiting}.{0,60}${actor}`, 'i').test(value);
}

// PM 偶尔会把 TaskCreate/TaskUpdate 的看板状态误当成 Agent 已启动，口头声称“正在等待”，
// 但底层并没有对应的 Agent 工具调用。此时静等永远不会有通知。最多自动纠偏两次：
// 让 PM 根据真实 Agent 调用重新核对，缺失的立即补派；纠偏提示属于内部 user 事件，
// 协奏渲染器会吞掉，不会显示给用户。
function retryMissingOrchestrateAgents(sess, resultEvt) {
  if (!sess.orchestrateMode || !sess.keepAliveForAsyncAgents || sess.asyncAgentToolIds.size > 0) return false;
  if (!orchestrateResultClaimsBackgroundWait(resultEvt && resultEvt.result)) return false;
  if (sess.orchRepairAttempts >= 2) return false;
  sess.orchRepairAttempts += 1;
  const correction = [
    '[Relay 协奏运行态校验]',
    '当前没有任何实际运行中的 Agent 工具调用，但你刚才声称仍在等待子智能体或子任务。',
    'TaskCreate/TaskUpdate/TaskList 只是任务看板，不代表子智能体已经启动。',
    '请立即核对本轮真实收到的 Agent 工具调用回执：每个计划执行的子任务都必须有一次独立的 Agent 工具调用。',
    '若有遗漏，现在补发缺失的 Agent；若已无遗漏，则继续下游派发或直接完成最终汇总。',
    '不得只修改 Task 状态后继续等待，也不要向用户复述本段运行态校验。',
  ].join('\n');
  try {
    if (!sess.child.push(correction)) throw new Error('会话已关闭');
    console.warn('[live] 协奏检测到虚假等待，已要求 PM 补派缺失 Agent convId=%s attempt=%d',
      sess.convId, sess.orchRepairAttempts);
    return true;
  } catch (e) {
    console.error('[live] 协奏纠偏写入失败 convId=%s: %s', sess.convId, e.message);
    return false;
  }
}

// 起一个常驻会话。不发任何 prompt —— MCP 会在此刻就开始连（已实测）。
//   SDK 的流式输入模式等价于原来的 `--input-format stream-json`：一个进程服务多轮。
//   这里仍保留 sess.child 这个字段名，但它现在是 claude-sdk.js 给的会话句柄
//   （.pid / .push() / .kill()）—— pid 仍是真实 claude 进程的，MCP watchdog 照常工作。
function spawnLiveSession({ convId, cwd, validWorkingDir, agentProjectRoot, model, sessionId, attachCronMcp }) {
  const sess = {
    convId, child: null,
    fingerprint: sessionFingerprint({ cwd, validWorkingDir, agentProjectRoot, model, attachCronMcp }),
    // 重新加载 MCP 时必须原样复用这些启动参数。fingerprint 只适合比较，不能反解。
    launchSpec: { convId, cwd, validWorkingDir, agentProjectRoot, model, attachCronMcp },
    sessionId: sessionId || null,   // claude 的 session_id,首轮从 init 事件学到
    busy: false, dead: false,
    jobId: null, onEvent: null,
    mcpPids: null,
    spawnedAt: Date.now(),   // watchdog 拍快照的时间门槛基准(见 snapshotMcpChildren 坑③)
    lastUsedAt: Date.now(),
    idleTimer: null,
    keepAliveForAsyncAgents: false,
    orchestrateMode: false,
    asyncAgentToolIds: new Set(),
    asyncAgentTaskIds: new Map(),
    orchRepairAttempts: 0,
  };

  // 消息处理与原来逐行 JSON.parse stdout 的逻辑【完全一致】——
  //   实测 SDK 吐出的消息结构与 CLI 的 stream-json 逐字段相同，所以这里不做任何翻译。
  const onMessage = (evt) => {
    // 学 session_id:新会话首轮由 claude 分配,后续重启进程时用它 resume 接回(已验证可行)
    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) sess.sessionId = evt.session_id;
    if (sess.keepAliveForAsyncAgents) {
      const transitions = liveAsyncAgentTransitions(evt);
      for (const transition of transitions) {
        const mappedId = transition.taskId ? sess.asyncAgentTaskIds.get(transition.taskId) : null;
        const trackingId = mappedId
          || transition.toolUseId
          || (transition.taskId ? `task:${transition.taskId}` : null);
        if (transition.kind === 'launched' && trackingId) {
          sess.asyncAgentToolIds.add(trackingId);
          if (transition.taskId) sess.asyncAgentTaskIds.set(transition.taskId, trackingId);
          console.log('[live] 后台 Agent 已启动 convId=%s trackingId=%s taskId=%s pending=%d',
            convId, trackingId, transition.taskId || '-', sess.asyncAgentToolIds.size);
        } else if (transition.kind === 'finished' && trackingId) {
          sess.asyncAgentToolIds.delete(trackingId);
          if (transition.taskId) sess.asyncAgentTaskIds.delete(transition.taskId);
          console.log('[live] 后台 Agent 已结束 convId=%s trackingId=%s taskId=%s status=%s pending=%d',
            convId, trackingId, transition.taskId || '-', transition.status, sess.asyncAgentToolIds.size);
        }
      }
    }
    const done = evt.type === 'result';
    if (sess.onEvent) {
      try { sess.onEvent({ jobId: sess.jobId, ...evt }); }
      catch (e) { console.error('[live] emit 失败: %s type=%s', e.message, evt && evt.type); }
    }
    // 关键:前端只认 job-done 收尾(result 只记状态,见 renderer/app.js 的事件分发)。
    //   一次性 job 的 job-done 是进程结束时发的 —— 但常驻进程【永远不结束】,
    //   不在这里补发就是每轮永远转圈。
    // result.origin 不能用于区分中间态/最终态：2.1.220 在消费完成通知后，
    // PM 整轮输出的 result 仍带 origin.kind=task-notification。
    // 唯一可靠的收尾依据是实际 Agent 调用 Set：仍有后台 Agent 就继续等；归零后，
    // 若 PM 虚假声称还在等待则内部纠偏，否则本轮正常结束。
    if (done) {
      if (sess.keepAliveForAsyncAgents && sess.asyncAgentToolIds.size > 0) {
        console.log('[live] 阶段性 result，继续等待后台 Agent convId=%s mode=%s pending=%d',
          convId, sess.orchestrateMode ? 'orchestrate' : 'interactive',
          sess.asyncAgentToolIds.size);
      } else if (!retryMissingOrchestrateAgents(sess, evt)) {
        finishTurn(sess, evt);
      }
    }
  };

  const onExit = (code, err) => {
    const wasBusy = sess.busy;
    sess.dead = true;
    if (sess.sessionId) liveTombstones.set(convId, { sessionId: sess.sessionId, at: Date.now() });
    if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
    if (liveSessions.get(convId) === sess) liveSessions.delete(convId);
    console.log('[live] close convId=%s pid=%s exitCode=%s busy=%s', convId, sess.child && sess.child.pid, code, wasBusy);
    // 进程在一轮跑到一半时死掉 → 必须给前端收尾,否则 UI 永远转圈
    if (wasBusy && sess.onEvent) {
      try { sess.onEvent({ jobId: sess.jobId, type: 'job-done', exitCode: code == null ? -1 : code, error: err }); } catch (_) {}
    }
    sess.busy = false; sess.onEvent = null;
    refreshTrayMenu();
  };

  sess.child = claudeSdk.createLiveSession({
    cwd,
    ...buildSdkParams({ validWorkingDir, agentProjectRoot, model, sessionId, attachCronMcp }),
    onMessage,
    onExit,
  });

  console.log('[live] spawn convId=%s cwd=%s model=%s resume=%s cronMcp=%s',
    convId, cwd, model || '(default)', sessionId || '(new)', !!attachCronMcp);

  liveSessions.set(convId, sess);
  touchIdleTimer(sess);
  // 拍 MCP 子进程快照供 watchdog 用。延到 60s 是有原因的(见 snapshotMcpChildren 的坑③);
  //   unref 掉,别为了一个诊断用的定时器拖住进程退出。
  const snapTimer = setTimeout(() => snapshotMcpChildren(sess), SNAPSHOT_DELAY_MS);
  if (snapTimer.unref) snapTimer.unref();
  return sess;
}

// 一轮结束:补发 job-done 让前端收尾,然后把进程还回池子等下一轮(进程不退出)。
function finishTurn(sess, resultEvt) {
  const onEvent = sess.onEvent;
  const jobId = sess.jobId;
  sess.busy = false;
  sess.onEvent = null;   // 本轮已结束,后续残留事件不再转发(避免串到下一轮的 UI)
  sess.jobId = null;
  sess.keepAliveForAsyncAgents = false;
  sess.orchestrateMode = false;
  sess.asyncAgentToolIds.clear();
  sess.asyncAgentTaskIds.clear();
  sess.orchRepairAttempts = 0;
  sess.lastUsedAt = Date.now();
  touchIdleTimer(sess);
  refreshTrayMenu();
  // exitCode 0 = 本轮正常结束(进程还活着,这是个"逻辑收尾"信号,不代表进程退出)。
  //   result.is_error / error_* subtype 时前端已在 result 分支记了 run.error,这里照常收尾即可。
  if (onEvent) {
    try { onEvent({ jobId, type: 'job-done', exitCode: 0 }); }
    catch (e) { console.error('[live] job-done 发送失败: %s', e.message); }
  }
  // 补一次快照机会:spawn 那次定时可能因为当时正忙(新对话是 spawn 完立刻就发)而放弃了。
  //   现在刚空下来,正是拍准的时机 —— 函数内部自带「不足 60s 不拍」与「已拍过则 no-op」的闸。
  const t = setTimeout(() => snapshotMcpChildren(sess), 500);
  if (t.unref) t.unref();
  void resultEvt;
}

// 预启动:对话打开/切换时调用。此刻起进程 → MCP 在用户打字的几秒里连好 → 首轮 init 也是零延迟。
//   这才是原 warmUpFeishuMcp 想做却做不到的事:焐的是真正会服务这一轮的那个进程。
function prespawnSession(opts) {
  if (!opts || !opts.convId) return null;
  const exist = liveSessions.get(opts.convId);
  if (exist && !exist.dead) return exist;    // 已有:什么都不用做
  if (!evictIfNeeded()) return null;         // 位置全被占着(都在跑)→ 放弃预启动,不影响正确性
  // 墓碑比前端传来的 sessionId 新:前端记的是这个对话【最初】的 session_id,而进程重启过几次后
  //   claude 侧的 id 可能已经变了(--resume 会派生新 id)。优先用墓碑。
  const tomb = liveTombstones.get(opts.convId);
  const sessionId = (tomb && tomb.sessionId) || opts.sessionId || null;
  try { return spawnLiveSession({ ...opts, sessionId }); }
  catch (e) { console.warn('[live] 预启动失败(忽略): %s', e.message); return null; }
}

// 跑一轮。能复用常驻进程就复用(仅写 stdin);否则(不存在/已死/参数变了/MCP 树塌了)重启一个,
//   并用已知 session_id --resume 接回上下文。返回 jobId + 运行时已学到的 sessionId;
//   拿不到常驻位则返回 null 让调用方回退。
function runLiveTurn({ convId, prompt, cwd, validWorkingDir, agentProjectRoot, model, sessionId, attachCronMcp, forceFreshSession, keepAliveForAsyncAgents, orchestrateMode, onEvent }) {
  const fp = sessionFingerprint({ cwd, validWorkingDir, agentProjectRoot, model, attachCronMcp });
  let sess = liveSessions.get(convId);
  // 重启后要靠 session_id --resume 接回上下文(已验证优雅/强杀都能接回)。取值优先级:
  //   进程自己学到的 > 墓碑(上个进程死时留下的) > 前端传来的。
  //   注意:必须在 kill 之前取 —— killLiveSession 会把 sess 从 map 里摘掉。
  const tomb = forceFreshSession ? null : liveTombstones.get(convId);
  let learnedSid = forceFreshSession ? null : ((sess && sess.sessionId) || (tomb && tomb.sessionId) || null);

  if (sess && !sess.dead && sess.busy) {
    // 同一对话上一轮还在跑 —— 前端不该发生,兜底:拒绝,让调用方回退到一次性 job
    console.warn('[live] convId=%s 上一轮仍在跑,本轮回退一次性 job', convId);
    return null;
  }
  if (sess && !sess.dead && sess.fingerprint !== fp) {
    killLiveSession(sess, '参数变更(模型/目录/agent)');   // 这些是 spawn 时定死的,只能重启
    if (forceFreshSession) { liveTombstones.delete(convId); learnedSid = null; }
    sess = null;
  }
  if (sess && !sess.dead && !mcpTreeIntact(sess)) {
    killLiveSession(sess, 'MCP 子进程树已塌(防幽灵工具)');
    if (forceFreshSession) { liveTombstones.delete(convId); learnedSid = null; }
    sess = null;
  }
  if (sess && sess.dead) { learnedSid = learnedSid || sess.sessionId; sess = null; }

  if (!sess) {
    if (!evictIfNeeded()) return null;   // 常驻位全忙 → 回退一次性 job(行为等同改造前)
    try {
      sess = spawnLiveSession({
        convId, cwd, validWorkingDir, agentProjectRoot, model, attachCronMcp,
        sessionId: learnedSid || sessionId || null,
      });
    } catch (e) {
      console.error('[live] spawn 失败: %s', e.message);
      return null;
    }
  }

  const jobId = require('crypto').randomUUID();
  sess.jobId = jobId;
  sess.onEvent = onEvent;
  sess.busy = true;
  sess.keepAliveForAsyncAgents = !!keepAliveForAsyncAgents;
  sess.orchestrateMode = !!orchestrateMode;
  sess.asyncAgentToolIds.clear();
  sess.asyncAgentTaskIds.clear();
  sess.orchRepairAttempts = 0;
  sess.lastUsedAt = Date.now();
  touchIdleTimer(sess);
  refreshTrayMenu();
  try {
    if (!sess.child.push(prompt)) throw new Error('会话已关闭');
  } catch (e) {
    console.error('[live] 投递本轮输入失败: %s', e.message);
    killLiveSession(sess, '输入投递失败');
    return null;
  }
  console.log('[live] turn convId=%s jobId=%s pid=%s 复用常驻进程 promptLen=%d',
    convId, jobId, sess.child.pid, (prompt || '').length);
  return { jobId, sessionId: sess.sessionId || null };
}

// 在跑的常驻轮数(托盘/并发上限要把它算进去)
function busyLiveCount() {
  let n = 0;
  for (const s of liveSessions.values()) if (s.busy) n++;
  return n;
}

// ─────────────────────────────────────────
// IPC: 启动一次 claude 对话
// ─────────────────────────────────────────
ipcMain.handle('claude:run', async (event, { prompt, sessionId, mode, files, model, agentName, workingDir, orchestrateAgents, convId, forceFreshSession }) => {
  // 并发上限:一次性 job + 正在跑的常驻轮 一起算(常驻但闲置的不算 —— 它不吃 CPU,只占内存,
  //   由 MAX_LIVE_SESSIONS / 闲置回收 单独管)。
  const running = jobs.size + busyLiveCount();
  if (running >= MAX_PARALLEL_JOBS) {
    console.warn('[claude:run] 并行上限,已拒绝。当前任务数=%d(一次性%d + 常驻在跑%d)', running, jobs.size, busyLiveCount());
    return { error: `并行任务已达上限（${MAX_PARALLEL_JOBS} 个），请等待其中一个完成后再发起。` };
  }
  // mode='agent':让 Claude 用用户在 ~/.claude/agents 里安装的指定子智能体
  // mode='orchestrate':多 Agent 协同 —— 让主 Claude 当 PM,自主拆解并用 Task(实际工具名 Agent)委派给多个子智能体
  // mode='plain':纯 Claude 聊天,不触发任何 agent
  const useAgent = mode === 'agent' && agentName;
  const useOrchestrate = mode === 'orchestrate';
  // 工作目录:用户为本对话指定了有效目录就用它,否则回落用户主目录。
  //   cwd 决定相对路径基准 + LLM 文件读写落点;同时下面用 --add-dir 显式授权。
  //   注:用户级 Agent/技能在 ~/.claude 下,与 cwd 无关(--setting-sources user 已加载),
  //   故改 cwd 不影响子智能体发现(已实测验证)。
  let cwd = os.homedir();
  let validWorkingDir = null;
  if (workingDir && typeof workingDir === 'string') {
    try {
      if (fs.existsSync(workingDir) && fs.statSync(workingDir).isDirectory()) {
        cwd = workingDir;
        validWorkingDir = workingDir;
      }
    } catch (e) { console.warn('[claude:run] workingDir 验证失败: %s dir=%s', e.message, workingDir); }
  }
  // 项目级 Agent 的配套资源根:本轮用的 agent 是「带知识库的完整包」(导入时记录了
  //   agentProjects 映射)时,它内部会用相对路径读 `knowledge/xxx` 等随包资源。
  //   把项目根单独记下来(与 cwd 解耦),后面据它做两件事:
  //     ① 始终 --add-dir 授权该目录(否则即便给绝对路径也会被权限拦);
  //     ② 用户另选了工作目录时,在 prompt 里告知资源的绝对路径(相对路径基准已不是项目根)。
  let agentProjectRoot = null;
  if (useAgent) {
    try {
      const projRoot = (readAppSettings().agentProjects || {})[agentName];
      if (projRoot && fs.existsSync(projRoot) && fs.statSync(projRoot).isDirectory()) {
        agentProjectRoot = projRoot;
        // 用户没手动指定工作目录 → cwd 设为项目根,相对路径 `cat knowledge/xxx` 即可命中
        //   (等价 CLI 项目级用法)。用户指定了目录则尊重用户,cwd 不动。
        if (!validWorkingDir) {
          cwd = projRoot;
          validWorkingDir = projRoot;
        }
      }
    } catch (e) { console.warn('[claude:run] agentProjectRoot 验证失败: %s agent=%s', e.message, agentName); }
  }
  if (useAgent) {
    const agentFile = path.join(AGENTS_DIR, `${agentName}.md`);
    if (!fs.existsSync(agentFile)) {
      return { error: `找不到 Agent「${agentName}」。请在 设置 → Agent 目录 重新导入。` };
    }
    // headless(-p)模式没有交互选择,显式指示 Claude 用该子智能体处理本次请求
    prompt = `请使用「${agentName}」子智能体(subagent)来完成下面的任务：\n\n${prompt}`;
    // 用户另选了工作目录(cwd ≠ 项目根)时:Agent 内部 `cat knowledge/xxx` 的相对路径会以
    //   用户目录为基准而读不到随包资源。这里把资源根的绝对路径 + 顶层条目清单都告诉它,
    //   强制它对所有随包资源改用绝对路径读取;产出文件仍写在当前工作目录(用户选的)。
    //   该目录已 --add-dir 授权,有访问权限。措辞写硬一些,压过 Agent 内部可能硬编码的相对路径。
    if (agentProjectRoot && path.resolve(cwd) !== path.resolve(agentProjectRoot)) {
      // 列出项目根顶层条目,让模型确知有哪些资源、该拼哪个绝对路径(目录名后加 / 便于区分)
      let entriesHint = '';
      try {
        const entries = fs.readdirSync(agentProjectRoot, { withFileTypes: true })
          .filter((e) => e.name !== '.claude' && e.name !== '__MACOSX' && e.name !== '.DS_Store')
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
        if (entries.length) entriesHint = `\n该目录下的资源包括：${entries.join('、')}`;
      } catch (e) { console.warn('[claude:run] 读取 agentProjectRoot 目录列表失败: %s', e.message); }
      prompt = `${prompt}\n\n---\n[重要·资源读取规则] 你随这个子智能体一起安装的配套资源（knowledge/、配置文件等）全部位于这个绝对路径下：\n${agentProjectRoot}${entriesHint}\n\n规则（务必遵守）：\n1. 读取上述任何随包资源时，一律使用该绝对路径前缀拼出完整路径，例如 ${path.join(agentProjectRoot, 'knowledge', 'subsystems.json')}。\n2. 绝不要用相对路径（如 \`knowledge/xxx\`）去读这些资源——当前工作目录是用户另行指定的目录，不是上面这个安装目录，相对路径必然找不到文件。\n3. 你为用户产出的结果文件，仍写在当前工作目录即可，不要写进上面的安装目录。`;
    }
  }
  // mode='orchestrate':多 Agent 协同 —— 注入 PM 编排提示 + 可用子智能体清单。
  //   主 Claude 当 PM,自己读各 subagent 的 description、拆解任务、用 Task 工具(实际工具名 Agent)
  //   并行/接力派给合适的子智能体,最后汇总。子智能体发现由 --setting-sources user 保证(与 cwd 无关)。
  //   orchestrateAgents 为用户勾选的子智能体 name 数组(可空=全量交 PM 自选)。
  if (useOrchestrate) {
    const all = listAgentNames();   // [{ name, file, desc, displayName }]
    const pick = Array.isArray(orchestrateAgents) && orchestrateAgents.length
      ? all.filter((a) => orchestrateAgents.includes(a.name))
      : all;
    if (pick.length) {
      const roster = pick
        .map((a) => `- ${a.name}：${(a.desc || '(无描述)').replace(/\s+/g, ' ').slice(0, 200)}`)
        .join('\n');
      prompt = `你现在是「任务编排者(PM)」。你有以下可用的子智能体(subagent),请阅读它们的描述,把用户的任务拆解成子任务,用 Agent 工具【分别派发】给最合适的子智能体并行或接力完成,最后把各子智能体的产出汇总成给用户的最终结论。

可用子智能体：
${roster}

⚠️ 关键前提:每个子智能体都在【完全独立、互相隔离】的上下文里运行。它看不到用户的原始任务、看不到你的规划、更看不到其他子智能体的产出——它只能读到你在 Agent 委派提示里写给它的那段文字。因此「上游→下游」的所有信息流转,完全取决于你在派活时写了什么。

编排规则：
1. 先用一两句话说明你打算怎么拆解、派给谁(让用户看得到你的规划)。
2. 【只有 Agent 工具才会真正启动子智能体】通过 Agent 工具委派,不要自己直接完成子智能体擅长的活;有依赖关系的子任务按顺序派、可并行的就并行派。TaskCreate/TaskUpdate/TaskList 只是可选的进度看板,绝不代表子智能体已经启动。
3. 【传递上游原文,不要自己转述概括】给下游派活时,把它需要依赖的上游子智能体产出【原文整段贴进】委派提示,而不是你压缩成一两句。下游基于完整素材作业,质量才不打折。
4. 【保留并继承标注】上游若标了「推断/假设/置信度低/待核实」等限定词,派给下游时必须原样带上;不要把"推断"在传递中悄悄变成"事实"。
5. 【统一口径】在首次派活时就约定全局一致的口径——时间粒度(如统一用季度还是按周)、术语表、单位、命名——并把这份约定写进【每一个】子任务的委派提示,避免各子智能体各说各话。
6. 【风险回流要二次派活】子智能体返回的产出里若包含风险、矛盾、对上游的质疑或新发现的约束,不要只在最终汇总里一笔带过——若它会影响已完成的上游环节,主动【再发起一轮】Agent 把这个反馈传回相关子智能体修正。单向流水线会漏掉这类问题。
7. 【逐一核对真实启动】计划并行 N 个子任务时,必须实际产生 N 次独立的 Agent 工具调用,并分别收到启动回执。进入等待前按真实 Agent 调用逐一核对;缺一个就立即补派。不得因为创建了 Task 看板、修改了 in_progress 状态或自己写了“已启动”文字,就声称对应 Agent 已运行。
8. 【后台启动回执不是产出】Agent 工具可能先返回 "Async agent launched successfully"、agentId、output_file 等后台启动元数据。此时子智能体仍在运行,绝不能把这段回执当成结果、也不能结束任务或让用户重发需求。继续等待对应的完成通知和真实输出;若有下游接力,拿到上游真实产出后再派发。
9. 所有实际启动的子智能体都返回真实产出后,综合它们给出最终汇总;若过程中做过二次派活,说明修正了什么。

---
用户的任务：
${prompt}`;
    }
    // pick 为空(没装任何 agent)时不注入,退化为普通对话 —— 前端入口已拦截无 agent 的情况,这里只是兜底。
  }
  // 文件:把绝对路径作为明确指令拼到 prompt 末尾,让 Claude 用 Read 工具读取。
  //   不用 @<path> 语法 —— 它在 headless(-p)模式下不一定展开,且遇到含空格的
  //   Windows 路径会按空格被截断。逐行列路径最稳。
  if (Array.isArray(files) && files.length) {
    const lines = files.map((f) => `- ${f.path}`).join('\n');
    prompt = `${prompt || '请查看我上传的文件。'}\n\n---\n用户上传了以下文件（绝对路径），请先用 Read 工具读取其内容，再据此回答：\n${lines}`;
  }
  // 飞书轮:追加系统提示,引导模型用 feishu-mcp-pro 工具(并等其就绪),不要退化抓网页。
  //   常驻会话池已让 MCP 在用户打字时就连好,这条 hint 只兜「开窗即发」的边缘案例;
  //   保留它的理由:纯 prompt 文本,跨 claude 版本永不失效,是最廉价的保险。
  if (promptNeedsFeishu(prompt)) prompt = `${prompt}${FEISHU_HINT}`;
  // 每轮都追加交互须知:禁用 AskUserQuestion(下面 --disallowed-tools),并让模型把需要用户
  //   定夺的问题/选项用文字完整列出、停下等回复,而不是被拒后自作主张用默认。
  prompt = `${prompt}${ASK_HINT}${IMAGE_HINT}`;
  // 长期记忆:把记忆库索引注入 prompt(CLI headless 不会自动注入),并教模型自读自写。
  //   放在最后,确保前面的文件/飞书/图片须知都已就位;下方 spawn 时 --add-dir 授权该目录。
  prompt = `${prompt}${buildMemoryHint()}`;

  // 防御:用户输入以 - 开头时,CLI 参数解析器会把它当成命令行选项(如 -i / -u / -P),
  //   导致 "error: unknown option" 后静默退出、回复为空。加一句安全前缀消除歧义。
  if (prompt.trimStart().startsWith('-')) {
    prompt = '以下是用户的输入内容：\n' + prompt;
  }

  // 对话内管理定时任务:非 agent/协同 模式时挂 cron MCP。
  //   注意:常驻会话下 MCP 是 spawn 时定死的,不能像以前那样「按本轮 prompt 像不像定时任务」临时挂 ——
  //   那会让每次判定翻转都重启进程(丢掉常驻的全部意义)。cron MCP 是 Relay 自己的本地 node 脚本、
  //   毫秒级启动、工具也少,常挂的代价远小于反复重启,故这里固定挂。
  //   (一次性回退路径仍沿用旧的按轮判定 —— 它每轮都新起进程,没有这个约束。)
  const cronOk = mode !== 'agent' && mode !== 'orchestrate';
  const onEvent = (evt) => {
    try { event.sender.send('claude:event', evt); }
    catch (e) { console.error('[claude:run] 事件转发失败: %s type=%s', e.message, evt && evt.type); }
  };

  // 主路径:常驻会话(需要 convId 做稳定的池 key)。复用进程 = MCP 不重启 = 模型开局就有全部工具。
  if (convId) {
    const liveRun = runLiveTurn({
      convId, prompt, cwd, validWorkingDir, agentProjectRoot, model, sessionId,
      attachCronMcp: cronOk, forceFreshSession: !!forceFreshSession,
      // 普通对话、指定 Agent 和协奏都可能在运行中自主派遣后台 Agent。
      // 常驻会话必须统一保持事件监听；只有协奏额外启用虚假等待纠偏。
      keepAliveForAsyncAgents: true, orchestrateMode: useOrchestrate, onEvent,
    });
    if (liveRun) return liveRun;
    console.warn('[claude:run] 常驻会话不可用,本轮回退一次性 job convId=%s', convId);
  }

  // 回退:没有 convId(旧前端/边缘路径)或常驻位全忙 —— 行为与改造前完全一致。
  try {
    const { jobId } = runClaudeJob({
      prompt, cwd, validWorkingDir, agentProjectRoot, model, sessionId,
      attachCronMcp: cronOk && promptMaybeCron(prompt),
      onEvent,
    });
    return { jobId };
  } catch (e) {
    console.error('[claude:run] 启动失败: %s', e.message);
    return { error: e.message || 'Claude Code 启动失败' };
  }
});

// IPC: 丢弃某对话的常驻会话 + 墓碑。
//   给前端的降级重跑路径(relaunchWithoutResume)用:那条路正是因为 --resume 接不回才走的,
//   此时该对话的 session_id 已经是坏的。若不连墓碑一起清掉,下一轮 runLiveTurn 会拿着同一个
//   坏 id 再 --resume 一次,等于刚降级完又坏回去。
ipcMain.handle('claude:dropSession', (_e, convId) => {
  if (!convId) return { dropped: false };
  const sess = liveSessions.get(convId);
  if (sess) killLiveSession(sess, '前端要求丢弃(降级重跑)');
  liveTombstones.delete(convId);   // 必须在 kill 之后 —— killLiveSession 会写墓碑
  console.log('[live] 已丢弃 convId=%s 的常驻会话与墓碑', convId);
  return { dropped: true };
});

// 等待旧 claude 进程退出，避免重新加载时旧/新两套 MCP 在短时间内重叠。
// 超时只代表旧进程退出事件没及时到；SIGTERM 已发出，不阻断新运行时拉起。
function waitForChildClose(child, timeoutMs = 1500) {
  if (!child || child.exitCode != null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    child.once('close', finish);
  });
}

// IPC:为当前 Relay 对话创建全新 Claude session，让 MCP 工具清单从零重新发现。
// 不能 --resume 旧 session：Claude Code 会保留旧 session 启动时的工具集，这正是“旧对话不能用、新对话能用”的根因。
// 对话上下文由 renderer 在下一条消息里以 Relay 历史文本带入，不依赖旧 Claude session。
ipcMain.handle('claude:resetSession', async (_e, { convId, mode, model, workingDir } = {}) => {
  let resetCommitted = false;
  try {
    if (!convId) return { ok: false, message: '请先打开一个已有对话' };

    const sess = liveSessions.get(convId);
    if (sess && !sess.dead) {
      if (sess.busy) return { ok: false, busy: true, message: '当前对话还在回复中，请结束后再重新加载' };
      const launchSpec = { ...(sess.launchSpec || {}) };
      const closed = waitForChildClose(sess.child);
      killLiveSession(sess, '用户重新加载 MCP');
      await closed;
      // killLiveSession 会把旧 session_id 写进墓碑。必须在 kill 之后删掉，
      // 否则 spawn/prespawn 会又从墓碑取回旧 id，隐式恢复成 --resume。
      liveTombstones.delete(convId);
      resetCommitted = true;
      if (!evictIfNeeded()) return { ok: true, restarted: false, deferred: true };
      const fresh = spawnLiveSession({ ...launchSpec, convId, sessionId: null });
      console.log('[live] MCP 全新会话已启动 convId=%s oldPid=%s newPid=%s',
        convId, sess.child && sess.child.pid, fresh.child && fresh.child.pid);
      return { ok: true, restarted: true };
    }

    // 运行时已被闲置/LRU 回收时也要清墓碑，防止下一轮自动续接旧 session。
    liveTombstones.delete(convId);
    resetCommitted = true;
    // 普通对话可直接预启动；Agent/协同会话会在下一条消息时按完整 prompt 参数创建。
    if (mode === 'agent' || mode === 'orchestrate') {
      return { ok: true, restarted: false, deferred: true };
    }
    let cwd = os.homedir();
    let validWorkingDir = null;
    if (workingDir && typeof workingDir === 'string') {
      try {
        if (fs.existsSync(workingDir) && fs.statSync(workingDir).isDirectory()) {
          cwd = workingDir;
          validWorkingDir = workingDir;
        }
      } catch (_) {}
    }
    const fresh = prespawnSession({
      convId, cwd, validWorkingDir, agentProjectRoot: null, model,
      sessionId: null,
      attachCronMcp: true,
    });
    return fresh
      ? { ok: true, restarted: true }
      : { ok: true, restarted: false, deferred: true };
  } catch (e) {
    console.error('[live] MCP 全新会话启动失败 convId=%s: %s', convId, e.message);
    // 旧 session 一旦已丢弃就不能让 renderer 退回旧 id。预启动失败时改为延迟创建，
    // 下一条消息仍会带 forceFreshSession 重试，不再 --resume 旧工具集。
    if (resetCommitted) return { ok: true, restarted: false, deferred: true };
    return { ok: false, message: e.message || '重新加载失败' };
  }
});

// IPC: 预启动常驻会话 —— 前端在【打开/切换对话】时调用(fire-and-forget)。
//   此刻起进程,MCP 就在用户打字的几秒里连好,首轮 init 也是零延迟(实测空等 12s 后发首条消息,
//   init 0.04s 返回、工具全 connected)。失败完全无害:下面 claude:run 会照常自己 spawn。
ipcMain.handle('claude:prespawn', async (_e, { convId, sessionId, mode, model, agentName, workingDir }) => {
  try {
    if (!convId) return { ok: false };
    if (mode === 'agent' || mode === 'orchestrate') return { ok: false, skipped: 'agent 模式的 prompt 包装依赖本轮内容,不预启动' };
    let cwd = os.homedir();
    let validWorkingDir = null;
    if (workingDir && typeof workingDir === 'string') {
      try {
        if (fs.existsSync(workingDir) && fs.statSync(workingDir).isDirectory()) { cwd = workingDir; validWorkingDir = workingDir; }
      } catch (_) {}
    }
    const sess = prespawnSession({
      convId, cwd, validWorkingDir, agentProjectRoot: null, model,
      sessionId: sessionId || null, attachCronMcp: true,
    });
    return { ok: !!sess };
  } catch (e) {
    console.warn('[live] prespawn 失败(忽略): %s', e.message);
    return { ok: false };
  }
});

// IPC: 中止任务(按 jobId 杀单个;不传则杀全部 —— 兜底)
ipcMain.handle('claude:abort', (_e, jobId) => {
  // 常驻会话的「中止」= 杀掉整个常驻进程。stream-json 输入模式没有「取消当前轮」的协议,
  //   而且这一轮的部分输出已经进了 claude 的会话历史,留着进程反而状态不干净。
  //   杀掉不丢上下文:下一轮会用学到的 session_id --resume 接回(已验证优雅/强杀都能接回)。
  //   代价只是下一轮要重连一次 MCP —— 用户主动中止本就不是热路径。
  //   (session_id 由 killLiveSession 统一记进墓碑,下轮自动 --resume 接回)
  const abortLive = (sess) => killLiveSession(sess, '用户中止');
  if (jobId) {
    const child = jobs.get(jobId);
    if (child) {
      console.log('[claude:abort] 中止一次性任务 jobId=%s pid=%d', jobId, child.pid);
      try { child.kill('SIGTERM'); } catch (_) {}
      jobs.delete(jobId);
      refreshTrayMenu();
      return { aborted: true, jobId };
    }
    for (const sess of liveSessions.values()) {
      if (sess.busy && sess.jobId === jobId) {
        console.log('[claude:abort] 中止常驻轮 jobId=%s convId=%s pid=%d', jobId, sess.convId, sess.child.pid);
        abortLive(sess);
        return { aborted: true, jobId };
      }
    }
    console.warn('[claude:abort] 未找到任务 jobId=%s', jobId);
    return { aborted: false, jobId };
  }
  // 无 jobId:全部中止
  let n = 0;
  for (const [id, child] of jobs) {
    console.log('[claude:abort] 批量中止 jobId=%s pid=%d', id, child.pid);
    try { child.kill('SIGTERM'); } catch (_) {}
    jobs.delete(id);
    n++;
  }
  for (const sess of [...liveSessions.values()]) {
    if (!sess.busy) continue;
    console.log('[claude:abort] 批量中止常驻轮 convId=%s pid=%d', sess.convId, sess.child.pid);
    abortLive(sess);
    n++;
  }
  refreshTrayMenu();
  return { aborted: n > 0, count: n };
});

// 按【视觉宽度】截断标题:汉字/全角算 2,英文/数字/半角算 1,上限 maxW(默认 24 ≈ 12 个汉字)。
//   关键点:不在英文/数字单词中间切。若到达上限时恰好处在一个 ASCII 单词内部,
//   回退到该单词起点之前(宁可短一点,也不留半个单词)。
// 把字符串切成字素簇:emoji(含 ZWJ 家庭如 👨‍👩‍👧)算一个整体,绝不拆成乱码。
// 会话标题统一上限:26 视觉宽 ≈ 13 个汉字 / 26 个英文字符(与侧边栏列宽对齐)。
//   所有标题(占位/AI 摘要/手动重命名/定时任务)最终都经 saveConversation 落盘,在那里统一收口。
const TITLE_MAX_W = 26;
function toGraphemes(str) {
  const s = String(str);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment); }
    catch (_) {}
  }
  return Array.from(s);
}
// 单个字素的视觉宽度:CJK/全角 = 2;emoji(增补平面)= 2;其余 = 1
function graphemeWidth(g) {
  const cp = g.codePointAt(0) || 0;
  if (cp > 0xffff) return 2;
  return cp > 0x2e7f ? 2 : 1;
}
function truncateByWidth(str, maxW = 24) {
  const gs = toGraphemes(str);
  let w = 0, out = '', lastSafe = '', prevWord = false;
  for (const g of gs) {
    const cw = graphemeWidth(g);
    const isWord = /^[0-9A-Za-z]$/.test(g);
    // 进入下一字素前,如果不在单词内部,记为安全截断点
    if (!(prevWord && isWord)) lastSafe = out;
    if (w + cw > maxW) {
      // 超限:卡在单词中间则回退到最近安全点;否则就地切(整串一个超长词时硬切,不返回空)
      return (prevWord && isWord && lastSafe) ? lastSafe : out;
    }
    out += g; w += cw; prevWord = isWord;
  }
  return out;
}

// IPC: 用最快档位给对话起一个简短标题(历史侧边栏用,豆包式摘要)
//   独立的一次性调用,不走流式、不占用 jobs 配额、不触发 agent。
ipcMain.handle('claude:title', async (_e, { text }) => {
  if (!text) return { title: '' };
  const prompt =
    '为下面这段对话生成一个简短标题。要求:概括核心主题、' +
    '长度控制在约 13 个汉字以内(英文/数字按半个汉字宽度算,即纯英文标题可到约 26 个字符);' +
    '出现的英文单词或型号必须保持完整、不要在单词中间断开;' +
    '不要标点/引号/书名号/序号、只输出标题本身、不要任何解释。\n\n' +
    String(text).slice(0, 1200);
  const out = await claudeSdk.runText({
    prompt,
    cwd: os.homedir(),          // 纯聊天目录,绝不触发任何 Agent
    model: 'haiku',             // 最快档位,便宜且快
    timeoutMs: 30000,
  });
  // 取第一行非空文本,去掉「标题:」前缀、引号/书名号,按视觉宽度截断兜底(不切坏英文单词)
  //   上限 26 视觉宽 = 13 个汉字(纯英文则约 26 字符);与上方提示词「约 13 个汉字」保持一致。
  //   侧栏静止态标题可用宽 ~187px,13 汉字(~176px)放得下,故只抬数据上限、CSS 列宽不动。
  let t = (String(out).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '');
  t = t.replace(/^标题\s*[:：]\s*/, '').replace(/["'「」『』《》]/g, '').trim();
  return { title: truncateByWidth(t, TITLE_MAX_W) };
});


// IPC: 查询 Claude Code 运行时版本。
//   运行时现在随 Relay 内置（SDK 平台包），版本由 package.json 锁定、跟着 Relay 一起发版，
//   用户不再能（也不需要）单独升级它 —— 这换来的是版本可控：不会因为用户或别的程序
//   升级了全局 CLI 而让 Relay 的行为在某天突然变掉。
//   保留这个 IPC 名字是为了不动 preload/renderer 的调用方；hasUpdate 恒为 false。
ipcMain.handle('claude:checkUpdate', async () => {
  const current = await getInstalledClaudeVersion();
  return { current, latest: current, hasUpdate: false, error: '', bundled: true };
});

// IPC: 保留接口以兼容旧的 renderer 调用，但内置运行时无法单独更新。
//   要升级 Claude Code 版本请升级 Relay 本身（设置 → 关于 → Relay）。
ipcMain.handle('claude:update', async () => ({
  ok: false,
  bundled: true,
  version: CLAUDE_RUNTIME_VERSION,
  error: 'Claude Code 运行时已内置于 Relay，随 Relay 更新一同升级，无需单独更新。',
}));

// ─────────────────────────────────────────
// Relay 应用自更新(electron-updater,见 updater.js)
//   自动的只有「检查」,下载和安装都要用户在界面上点过才发生。
// ─────────────────────────────────────────
// IPC: 当前更新状态快照(设置页/气泡打开时拉一次,后续靠 relay:update-event 推送)
ipcMain.handle('relay:updateStatus', () => updater.getStatus());
// IPC: 手动触发一次检查(fire-and-forget,结果走事件推送)
ipcMain.handle('relay:checkUpdate', () => { updater.check(); return updater.getStatus(); });
// IPC: 用户确认更新 → 开始下载(进度走事件推送)
ipcMain.handle('relay:downloadUpdate', () => updater.download());
// IPC: 用户点「稍后」→ 压掉气泡(不影响设置页展示,也不取消已在跑的下载)
ipcMain.handle('relay:dismissUpdate', () => updater.dismiss());
// IPC: 下载就绪后立即重启安装
ipcMain.handle('relay:quitAndInstall', () => updater.quitAndInstall());

// ─────────────────────────────────────────
// AI 创作(文生图)—— 调 OpenAI 兼容的图像生成端点 /v1/images/generations
//   · 配置存 app-settings.json 的 imageApi { baseUrl, apiKey };未设则用内置默认。
//   · 用 Node 原生 https,零外部依赖(不依赖 Python/openai 包,便于分发)。
//   · 生成的图存到 userData/generated_images/,返回本地路径给 renderer 渲染(file://)。
// ─────────────────────────────────────────
const IMAGE_API_DEFAULTS = {
  baseUrl: 'https://api.llm.mioffice.cn/v1',
  apiKey: '',   // 默认空;读取时回落到 Claude settings 的 ANTHROPIC_API_KEY(同一套 key 在该网关通用)
};
// 可选的图像模型清单。每个模型自带可用尺寸 sizes(value=API 传的 size,label=界面比例)。
//   · gpt-image-2:azure_openai 前缀,返回 b64_json。清晰度由独立的 quality 参数(low/medium/high)控制,
//                 尺寸用固定 5 档比例;界面「画质」下拉走 qualityTiers。
//   · 豆包 Seedream:volcengine_maas 前缀,返回 url。没有 quality 参数,清晰度=像素量(2K/4K),
//                 故界面「画质」下拉切的是分辨率档(resoTiers),每档每比例对应一组官方推荐像素。
// GPT-image-2 按「分辨率档 × 比例」给尺寸(和豆包同构,界面「画质」下拉切 1K/4K 档)。
//   约束(Azure 官方):两边都是 16 的倍数、长边 ≤3840、宽高比 ≤3:1、总像素 [655,360, 8,294,400]。
//   4K 档各值均已离线核验满足全部约束(注:受 829万像素上限,1:1 最大 2880×2880,到不了 4096)。
const GPT_RESO = {
  '1K': [
    { ratio: '1:1',  value: '1024x1024' },
    { ratio: '2:3',  value: '1024x1536' },
    { ratio: '3:2',  value: '1536x1024' },
    { ratio: '9:16', value: '1024x1792' },
    { ratio: '16:9', value: '1792x1024' },
  ],
  '4K': [
    { ratio: '1:1',  value: '2880x2880' },
    { ratio: '2:3',  value: '2352x3520' },
    { ratio: '3:2',  value: '3520x2352' },
    { ratio: '9:16', value: '2160x3840' },
    { ratio: '16:9', value: '3840x2160' },
  ],
};
const GPT_RATIO_DESC = {
  '1:1': '正方形，头像', '2:3': '竖图，社交媒体', '3:2': '横图，横版插画',
  '9:16': '手机壁纸，人像', '16:9': '桌面壁纸，风景',
};
function gptSizesForTier(tier) {
  const rows = GPT_RESO[tier] || GPT_RESO['1K'];
  return rows.map((r) => ({ value: r.value, label: r.ratio, shortLabel: r.ratio, desc: GPT_RATIO_DESC[r.ratio] || '' }));
}
// GPT 分辨率档 → quality 参数:1K 用 medium(快/省)、4K 用 high(配高分辨率)。在 generateImageCore 里据 size 反推。
const GPT_TIERS = [
  { value: '1K', label: '1K', desc: '标准，快' },
  { value: '4K', label: '4K', desc: '超清，慢' },
];
// 判断某 size 属于 GPT 哪个分辨率档(用于反推 quality);非 GPT 尺寸返回 null。
function gptTierOfSize(size) {
  for (const [tier, rows] of Object.entries(GPT_RESO)) {
    if (rows.some((r) => r.value === size)) return tier;
  }
  return null;
}
// 豆包按「分辨率档 × 比例」给官方推荐像素值(火山《Seedream·size》原表)。
//   2K/4K 各比例的宽高像素;界面选「画质(档) + 比例」两件事,生成时查这张表得最终 size。
//   注:豆包 size 约束=总像素 [3,686,400, 16,777,216] 且宽高比 [1/16,16],下列值均已满足。
const DOUBAO_RESO = {
  '2K': [
    { ratio: '1:1',  value: '2048x2048' },
    { ratio: '4:3',  value: '2304x1728' },
    { ratio: '3:4',  value: '1728x2304' },
    { ratio: '16:9', value: '2848x1600' },
    { ratio: '9:16', value: '1600x2848' },
    { ratio: '3:2',  value: '2496x1664' },
    { ratio: '2:3',  value: '1664x2496' },
    { ratio: '21:9', value: '3136x1344' },
  ],
  '4K': [
    { ratio: '1:1',  value: '4096x4096' },
    { ratio: '4:3',  value: '4704x3520' },
    { ratio: '3:4',  value: '3520x4704' },
    { ratio: '16:9', value: '5504x3040' },
    { ratio: '9:16', value: '3040x5504' },
    { ratio: '3:2',  value: '4992x3328' },
    { ratio: '2:3',  value: '3328x4992' },
    { ratio: '21:9', value: '6240x2656' },
  ],
};
// 比例 → 中文描述(界面比例下拉的副标题,2K/4K 共用)
const DOUBAO_RATIO_DESC = {
  '1:1': '正方形，头像', '4:3': '横图，文章配图', '3:4': '竖图，经典比例',
  '16:9': '桌面壁纸，风景', '9:16': '手机壁纸，人像', '3:2': '横图，横版插画',
  '2:3': '竖图，社交媒体', '21:9': '超宽，电影感',
};
// 把某一分辨率档展开成 sizes 列表(供界面比例下拉用;value=该档该比例的像素值)
function doubaoSizesForTier(tier) {
  const rows = DOUBAO_RESO[tier] || DOUBAO_RESO['2K'];
  return rows.map((r) => ({
    value: r.value, label: r.ratio, shortLabel: r.ratio, desc: DOUBAO_RATIO_DESC[r.ratio] || '',
  }));
}
// 豆包各模型支持的分辨率档(5.0-lite 多一档 3K;4.5/4.0 只有 2K/4K)
const DOUBAO_TIERS_53 = [
  { value: '2K', label: '2K', desc: '标清，快' },
  { value: '3K', label: '3K', desc: '高清' },
  { value: '4K', label: '4K', desc: '超清，慢且贵' },
];
const DOUBAO_TIERS_2 = [
  { value: '2K', label: '2K', desc: '标清，快' },
  { value: '4K', label: '4K', desc: '超清，慢且贵' },
];
// 模型清单。qualityKind 告诉前端「画质」下拉切的是什么:
//   'resolution' → 切分辨率档(豆包),qualityTiers 为档列表,真正的 size 由前端按 档×比例 查表;
//   'quality'    → 切 quality 参数(GPT),qualityTiers 为 quality 取值,sizes 固定。
// 三个模型的「画质」下拉统一切【分辨率档】(qualityKind:'resolution')。各自的档→比例→像素表
//   分别走 gptReso / doubaoReso(getConfig 下发);前端按 档×比例 查出最终 size。
//   GPT 的 quality 参数不在前端选,由 generateImageCore 据 size 落在哪个档自动推(1K→medium,4K→high)。
const IMAGE_MODELS = [
  { name: 'azure_openai/gpt-image-2',                 label: 'GPT-image-2',  desc: '通用，文字渲染好',  ok: true,
    sizes: gptSizesForTier('1K'), qualityKind: 'resolution', qualityTiers: GPT_TIERS, defaultQuality: '1K', resoKey: 'gpt' },
  { name: 'volcengine_maas/Doubao-Seedream-5.0-lite', label: 'Seedream 5.0', desc: '豆包出品，中文友好', ok: true,
    sizes: doubaoSizesForTier('2K'), qualityKind: 'resolution', qualityTiers: DOUBAO_TIERS_53, defaultQuality: '2K', resoKey: 'doubao' },
  { name: 'volcengine_maas/Doubao-Seedream-4.5',      label: 'Seedream 4.5', desc: '豆包上一代，稳定',   ok: true,
    sizes: doubaoSizesForTier('2K'), qualityKind: 'resolution', qualityTiers: DOUBAO_TIERS_2, defaultQuality: '2K', resoKey: 'doubao' },
];

function imageApiConfig() {
  const a = readAppSettings();
  const cfg = a.imageApi || {};
  let apiKey = cfg.apiKey || IMAGE_API_DEFAULTS.apiKey;
  if (!apiKey) {
    // 回落:用 Claude settings.json 里的 key(实测同网关通用)
    try { apiKey = readSettings().env?.ANTHROPIC_API_KEY || ''; } catch (_) {}
  }
  return {
    baseUrl: (cfg.baseUrl || IMAGE_API_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey,
  };
}

function generatedImagesDir() {
  const dir = path.join(app.getPath('userData'), 'generated_images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 图生图上传的参考图落点(与生成图分开存,便于区分/清理)。
function referenceImagesDir() {
  const dir = path.join(app.getPath('userData'), 'reference_images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 普通对话里粘贴(Ctrl+V)的截图落点 —— 剪贴板位图无文件路径,先落盘成真实文件供附件流程使用。
function pastedImagesDir() {
  const dir = path.join(app.getPath('userData'), 'attachments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// IPC: 读取图像 API 配置 + 可选模型清单(renderer 渲染下拉用)
ipcMain.handle('image:getConfig', () => {
  const { baseUrl, apiKey } = imageApiConfig();
  return {
    baseUrl,
    hasKey: !!apiKey,
    models: IMAGE_MODELS,
    // 各 resoKey → 「分辨率档 → [{ratio,value}]」表。前端按 模型.resoKey + 当前档 + 比例 查出最终 size。
    resoTables: { doubao: DOUBAO_RESO, gpt: GPT_RESO },
    savedDir: generatedImagesDir(),
  };
});

// IPC: 保存图像 API 配置(baseUrl / apiKey)到 app-settings.json
ipcMain.handle('image:setConfig', (_e, { baseUrl, apiKey } = {}) => {
  const a = readAppSettings();
  a.imageApi = a.imageApi || {};
  if (typeof baseUrl === 'string') a.imageApi.baseUrl = baseUrl.trim();
  if (typeof apiKey === 'string')  a.imageApi.apiKey  = apiKey.trim();
  writeAppSettings(a);
  return { ok: true };
});

// IPC: 文生图 / 图生图 / 多图融合 / 组图。
//   { prompt, model, size, n, image, sequential } → { ok, paths:[], error }
//   image:参考图,可为 data URL 字符串(单图)或字符串数组(多图融合,仅豆包,最多 14 张)。
//   sequential:true 时开启组图(仅豆包,sequential_image_generation:auto,一次出一组关联图)。
//   按 provider 分流(均走 mify 网关 api.llm.mioffice.cn,JSON 体):
//     · 豆包 volcengine_maas:打 /images/generations。参考图放 `image`(单图传 string、多图传 array);
//       默认 watermark:false 去掉「AI生成」水印;组图透传 sequential_image_generation。
//     · GPT azure_openai:带参考图时走「图片编辑」端点 /images/edits,参考图放 `image_url`
//       (mify 文档约定的 JSON 写法,非 Azure 原生 multipart);仅支持单图,数组取第一张。
//       不支持多图融合/组图/watermark 参数。
// 图像生成核心（供 image:generate IPC 与定时任务调度器共用）。
//   入参 { prompt, model, size, n, image, sequential } → { ok, paths, error }。
async function generateImageCore({ prompt, model, size, n, image, sequential } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: '请输入图片描述' };
  const { baseUrl, apiKey } = imageApiConfig();
  if (!apiKey) return { ok: false, error: '未配置图像 API Key（在 设置 → 图像生成 中填写，或沿用 Claude 的 API Key）' };

  const chosen = (IMAGE_MODELS.find((m) => m.name === model) || IMAGE_MODELS[0]);
  const isGpt = /^azure_openai\//i.test(chosen.name);
  // mify 网关协议(见飞书《调用示例·图片生成》):供应商放 `X-Model-Provider-Id` 请求头,
  //   model 字段只放裸模型名(不带 `provider/` 前缀)。我们的 IMAGE_MODELS.name 是带前缀的
  //   (如 `azure_openai/gpt-image-2`),这里拆成 provider + 裸名:
  //     · /images/generations:网关对带前缀无头、裸名带头两种都收(实测均 200),但统一走头+裸名最稳。
  //     · /images/edits:**必须**头+裸名;带前缀会被拒(only gpt-image-2 is supported),
  //       裸名无头也会被拒(Not supported model)。这是 GPT 编辑此前一直失败的根因。
  const slash = chosen.name.indexOf('/');
  const providerId = slash >= 0 ? chosen.name.slice(0, slash) : '';
  const bareModel = slash >= 0 ? chosen.name.slice(slash + 1) : chosen.name;
  // 归一化参考图:统一成数组,过滤掉空/非字符串项
  const refs = (Array.isArray(image) ? image : (image ? [image] : []))
    .filter((s) => typeof s === 'string' && s);
  const hasRef = refs.length > 0;
  const wantGroup = !!sequential && !isGpt;   // 组图仅豆包
  // GPT 带参考图 → 编辑端点;其余(豆包,或纯文生图)→ 生成端点
  const useEdit = isGpt && hasRef;

  const payloadObj = {
    model: bareModel,            // 裸模型名;供应商走下面的 X-Model-Provider-Id 头
    prompt: text,
    // 组图模式下放宽张数上限到 15(豆包组图:参考图数+生成数≤15);常规仍 1-4
    n: Math.min(Math.max(parseInt(n, 10) || 1, 1), wantGroup ? 15 : 4),
    size: size || '1024x1024',
  };
  if (hasRef) {
    if (useEdit) {
      payloadObj.image_url = refs[0];            // GPT 编辑:单图 image_url(取第一张)
    } else {
      // 豆包:单图传 string,多图传 array(多图融合)
      payloadObj.image = refs.length === 1 ? refs[0] : refs;
    }
  }
  // GPT 画质:quality 不由前端选,按 size 落在哪个分辨率档自动推 —— 1K→medium(快/省)、4K→high(配高清)。
  //   size 不在已知档里(如定时任务传了自定义尺寸)则回落 high(官方默认)。
  if (isGpt) {
    const tier = gptTierOfSize(payloadObj.size);
    payloadObj.quality = (tier === '1K') ? 'medium' : 'high';
  }
  if (!isGpt) {
    payloadObj.watermark = false;                // 豆包去水印(GPT 无此参数)
    if (wantGroup) {
      // 组图:auto 让模型自主决定张数;max_images 用 n 兜住上限
      payloadObj.sequential_image_generation = 'auto';
      payloadObj.sequential_image_generation_options = { max_images: payloadObj.n };
    }
  }
  const payload = JSON.stringify(payloadObj);

  const endpoint = useEdit ? '/images/edits' : '/images/generations';
  let url;
  try { url = new URL(baseUrl + endpoint); } catch (_) { return { ok: false, error: 'baseUrl 无效' }; }
  const mod = url.protocol === 'http:' ? require('http') : require('https');

  const result = await new Promise((resolve) => {
    let body = '';
    let req;
    try {
      req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + apiKey,
          'content-length': Buffer.byteLength(payload),
          // 供应商路由头:网关据此把请求转发到对应供应商(火山/azure/通义/vertex)。
          //   GPT 图片编辑必须带它(否则裸名报 Not supported model);生成端点带它也无害。
          ...(providerId ? { 'x-model-provider-id': providerId } : {}),
        },
      }, (res) => {
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    } catch (e) { return resolve({ status: 0, body: '', err: e.message }); }
    // 生图可能较慢,给 6 分钟(GPT-image-2 的 quality=high / 4K 单张常超 3 分钟)
    req.setTimeout(360000, () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: '', err: '请求超时(360s)' }); });
    req.on('error', (e) => resolve({ status: 0, body: '', err: e.message }));
    req.write(payload);
    req.end();
  });

  if (result.err) { console.error('[image] 网络错误: %s', result.err); return { ok: false, error: '网络错误:' + result.err }; }
  let json;
  try { json = JSON.parse(result.body); } catch (_) { console.error('[image] API 返回非 JSON status=%d body=%s', result.status, (result.body || '').slice(0, 200)); return { ok: false, error: `API 返回非 JSON(HTTP ${result.status})` }; }
  if (result.status !== 200 || json.error) {
    const errObj = json.error || {};
    const msg = errObj.message || errObj.param || `HTTP ${result.status}`;
    const code = String(errObj.code || errObj.type || '').toLowerCase();
    console.error('[image] API 报错 status=%d code=%s msg=%s', result.status, code, msg.slice(0, 200));
    // 内容审核拒绝:给一句中文提示,告诉用户是被安全系统拦了、改提示词即可(GPT/豆包措辞不一,统一识别)
    if (code.includes('content_policy') || code.includes('content_filter') ||
        /safety system|content policy|moderation|被.*(拒绝|拦截|过滤)|敏感|违规/i.test(msg)) {
      return { ok: false, error: '提示词被内容安全系统拒绝，未生成图片。请调整描述(尤其涉及人物身材/裸露/敏感的措辞)后重试。\n原始信息：' + msg };
    }
    return { ok: false, error: 'API 错误:' + msg };
  }
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) return { ok: false, error: 'API 未返回图片数据' };

  // 落盘:b64_json 直接写(.png);url 模式下载(豆包多为 .jpeg,按 URL 后缀定扩展名)
  const dir = generatedImagesDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const paths = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    try {
      if (item.b64_json) {
        const file = path.join(dir, `img-${ts}-${i + 1}.png`);
        fs.writeFileSync(file, Buffer.from(item.b64_json, 'base64'));
        paths.push(file);
      } else if (item.url) {
        // 从 URL 路径推断扩展名(jpg/jpeg/png/webp),拿不到则用 .png
        let ext = 'png';
        try { const m = new URL(item.url).pathname.match(/\.(jpe?g|png|webp)(?:$|\?)/i); if (m) ext = m[1].toLowerCase(); } catch (_) {}
        const file = path.join(dir, `img-${ts}-${i + 1}.${ext}`);
        const dl = await new Promise((resolve) => {
          const u = new URL(item.url);
          const m2 = u.protocol === 'http:' ? require('http') : require('https');
          m2.get(item.url, (r) => {
            if (r.statusCode !== 200) { r.resume(); return resolve(false); }
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => { try { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(true); } catch { resolve(false); } });
          }).on('error', () => resolve(false));
        });
        if (dl) paths.push(file);
      }
    } catch (e) { console.warn('[image] 保存图片失败: %s', e.message); }
  }
  if (!paths.length) return { ok: false, error: '图片保存失败' };
  return { ok: true, paths };
}

// IPC: 文生图 / 图生图 / 多图融合 / 组图（瘦封装，逻辑在 generateImageCore）。
ipcMain.handle('image:generate', async (_e, opts = {}) => generateImageCore(opts));

// IPC: 列出"我的创作"(已生成的图片,按时间倒序)
ipcMain.handle('image:listSaved', () => {
  const dir = generatedImagesDir();
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
        return { path: p, name: n, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items: files, dir };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// IPC: 删除"我的创作"里的一张图(连同本地文件)。安全起见:只允许删 generated_images 目录内的文件。
ipcMain.handle('image:deleteSaved', (_e, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    const dir = generatedImagesDir();
    const abs = path.resolve(String(p));
    // 路径越权防护:目标必须真的位于 generated_images 目录内,不能用 ../ 跳出去删别的文件
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '非法路径' };
    if (!fs.existsSync(abs)) return { ok: true };   // 已不存在视作删除成功(幂等)
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─────────────────────────────────────────
// 库:汇总 LLM 生成到本地的文件 —— 图片来自 generated_images;其它文件扫描各会话的工作目录
// ─────────────────────────────────────────
// 扩展名 → 类型分类(用于库里按类型筛选)
const LIB_TYPE_BY_EXT = {
  png:'image', jpg:'image', jpeg:'image', webp:'image', gif:'image', bmp:'image', svg:'image',
  pdf:'pdf',
  doc:'document', docx:'document', txt:'document', md:'document', rtf:'document',
  xls:'spreadsheet', xlsx:'spreadsheet', csv:'spreadsheet', tsv:'spreadsheet',
  ppt:'presentation', pptx:'presentation',
  // 代码 / 标记 / 配置 —— LLM 写的代码文件归到「代码」一类
  html:'code', htm:'code', css:'code', js:'code', mjs:'code', cjs:'code', jsx:'code', ts:'code', tsx:'code', vue:'code',
  json:'code', yaml:'code', yml:'code', toml:'code', xml:'code', ini:'code',
  py:'code', java:'code', c:'code', h:'code', cpp:'code', cc:'code', hpp:'code', cs:'code', go:'code', rs:'code',
  rb:'code', php:'code', swift:'code', kt:'code', sh:'code', bash:'code', ps1:'code', bat:'code', sql:'code', r:'code', lua:'code',
};
function libTypeOf(ext) { return LIB_TYPE_BY_EXT[(ext || '').toLowerCase()] || 'other'; }

// IPC: 列出库里的图片(就是 generated_images,等同 image:listSaved,语义更清晰)
ipcMain.handle('library:listImages', () => {
  const dir = generatedImagesDir();
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(n))
      .map((n) => { const p = path.join(dir, n); let mtime = 0, size = 0; try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch (_) {} return { path: p, name: n, mtime, size }; })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items: files };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// IPC: 列出库里的文件 —— 解析 Claude CLI 的会话日志(~/.claude/projects/**/*.jsonl),
//   提取 LLM 用 Write/Edit/NotebookEdit 工具写过的所有文件路径(不管在哪个子目录/主目录),
//   去重、只保留当前仍存在的文件,按类型归类。这是「LLM 生成到本地的文件」最准确的来源。
ipcMain.handle('library:listFiles', () => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return { ok: true, items: [] };
    // 收集所有 .jsonl 会话文件(各 cwd 子目录下),按修改时间倒序(新会话优先),最多扫 400 个防卡
    const jsonls = [];
    for (const sub of fs.readdirSync(projectsDir)) {
      const subDir = path.join(projectsDir, sub);
      let st; try { st = fs.statSync(subDir); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      let names; try { names = fs.readdirSync(subDir); } catch (_) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const fp = path.join(subDir, n);
        let s; try { s = fs.statSync(fp); } catch (_) { continue; }
        jsonls.push({ fp, mtime: s.mtimeMs });
      }
    }
    jsonls.sort((a, b) => b.mtime - a.mtime);
    const SCAN_CAP = 400;

    const writeTools = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
    const writtenPaths = new Set();   // LLM 写过的文件绝对路径(去重)
    for (const { fp } of jsonls.slice(0, SCAN_CAP)) {
      let content; try { content = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      // 只统计 Relay 应用发起的会话:Relay 给每条 prompt 都注入了「无交互界面」须知,
      //   据此排除用户直接用 Claude CLI / 开发本应用产生的会话(否则会混入一堆无关源码文件)。
      if (content.indexOf('无交互界面') < 0) continue;
      for (const line of content.split('\n')) {
        if (!line.trim() || line.indexOf('tool_use') < 0) continue;   // 没有工具调用的行直接跳过(省解析)
        let o; try { o = JSON.parse(line); } catch (_) { continue; }
        const msg = o && o.message;
        if (!msg || o.type !== 'assistant' || !Array.isArray(msg.content)) continue;
        for (const b of msg.content) {
          if (b && b.type === 'tool_use' && writeTools.has(b.name)) {
            const p = b.input && (b.input.file_path || b.input.notebook_path || b.input.path);
            if (p && typeof p === 'string') writtenPaths.add(path.resolve(p));
          }
        }
      }
    }

    // 只保留当前仍存在的文件,取 stat + 类型
    const items = [];
    for (const p of writtenPaths) {
      let st; try { st = fs.statSync(p); } catch (_) { continue; }   // 已删除/移动的跳过
      if (!st.isFile()) continue;
      const name = path.basename(p);
      const ext = path.extname(name).slice(1).toLowerCase();
      items.push({ path: p, name, ext, type: libTypeOf(ext), mtime: st.mtimeMs, size: st.size, dir: path.dirname(p) });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// IPC: 用系统默认程序打开文件
ipcMain.handle('library:openFile', async (_e, p) => {
  try { if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' }; const err = await shell.openPath(p); return err ? { ok: false, error: err } : { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 在文件管理器中定位文件
ipcMain.handle('library:revealFile', (_e, p) => {
  try { if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' }; shell.showItemInFolder(p); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 打开图片库目录(generated_images,所有生成图片的落点)。没有则先建,再用系统文件管理器打开。
ipcMain.handle('library:openImagesDir', () => {
  try { const dir = generatedImagesDir(); shell.openPath(dir); return { ok: true, dir }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 删除库里的一个文件(连同本地磁盘文件)。只删文件、不删目录;前端有二次确认。
ipcMain.handle('library:deleteFile', (_e, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    const abs = path.resolve(String(p));
    if (!fs.existsSync(abs)) return { ok: true };          // 已不存在 → 幂等成功
    if (!fs.statSync(abs).isFile()) return { ok: false, error: '不是文件' };   // 拒绝删目录
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 把本地图片读成 data URL(给"上下文迭代:拿上一张图当参考图"用)
ipcMain.handle('image:toDataUrl', (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const b64 = fs.readFileSync(p).toString('base64');
    return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 把图片 data URL 落盘到指定目录,返回 { ok, path }。供参考图、粘贴附件等共用。
//   dir:目标目录;prefix:文件名前缀。文件名 = <prefix>-<时间戳>-<随机>.<扩展名>。
function saveImageDataUrl(dataUrl, dir, prefix) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return { ok: false, error: '不是有效的图片 data URL' };
  const mime = m[1].toLowerCase();
  // mime → 扩展名(jpeg 归一为 jpg);未知则回退 png
  const ext = mime === 'image/jpeg' ? 'jpg'
    : mime === 'image/webp' ? 'webp'
    : mime === 'image/gif'  ? 'gif'
    : mime === 'image/bmp'  ? 'bmp'
    : mime === 'image/svg+xml' ? 'svg'
    : 'png';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = require('crypto').randomBytes(3).toString('hex');
  const file = path.join(dir, `${prefix}-${ts}-${rand}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return { ok: true, path: file };
}

// IPC: 把图生图上传的参考图(data URL)落盘到 reference_images/,返回本地路径。
//   用途:让参考图能像生成图一样持久展示(用户气泡上方),会话历史只存路径、不存 base64(避免 JSON 膨胀)。
ipcMain.handle('image:saveRef', (_e, { dataUrl } = {}) => {
  try { return saveImageDataUrl(dataUrl, referenceImagesDir(), 'ref'); }
  catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 把粘贴(Ctrl+V)进来的截图(data URL)落盘到 attachments/,返回本地路径 + 文件名。
//   普通对话的附件链路是按路径走的(让 CLI 用 Read 读),而剪贴板位图没有文件路径,
//   故先落盘成真实文件再喂给附件流程。
ipcMain.handle('image:savePaste', (_e, { dataUrl } = {}) => {
  try {
    const r = saveImageDataUrl(dataUrl, pastedImagesDir(), 'pasted');
    if (r.ok) r.name = path.basename(r.path);
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 读系统剪贴板里的图片(PNG dataURL)。兜底用 —— 部分 Windows 截图工具(如微信)
//   只把位图写进原生剪贴板,DOM paste 事件取不到 file 项;此时从主进程原生读 CF_BITMAP。
//   剪贴板无图片则返回 ok:false。
ipcMain.handle('clipboard:readImage', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false };
    const b64 = img.toPNG().toString('base64');
    if (!b64) return { ok: false };
    return { ok: true, dataUrl: `data:image/png;base64,${b64}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC: 在浏览器打开 URL(给飞书文档链接用)
ipcMain.handle('shell:open', (_e, url) => {
  shell.openExternal(url);
});

// IPC: 文件选择对话框
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '常用',  extensions: ['png','jpg','jpeg','gif','webp','pdf','txt','md','json','csv','xlsx','docx','pptx','py','js','ts','java','c','cpp','go','rs'] },
      { name: '图片',  extensions: ['png','jpg','jpeg','gif','webp','bmp','svg'] },
      { name: '文档',  extensions: ['pdf','txt','md','docx','xlsx','pptx'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    ext:  path.extname(p).slice(1).toLowerCase(),
    size: (() => { try { return fs.statSync(p).size; } catch { return 0; } })(),
  }));
});

// IPC: 选择工作目录(对话级)。选中后,该对话后续所有 claude:run 都以此为 cwd + --add-dir,
//   LLM 的文件读写都落在这个目录。返回 { path, name } 或 null(取消)。
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择工作目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  return { path: dir, name: path.basename(dir) || dir };
});

// ─────────────────────────────────────────
// IPC: 历史会话 CRUD
// ─────────────────────────────────────────
ipcMain.handle('history:list', () => {
  // 列表只读索引,零正文 IO(v2 目录式存储的核心收益)
  return readHistoryIndex().map(m => ({
    id: m.id,
    title: m.title,
    sessionId: m.sessionId,
    updatedAt: m.updatedAt,
    turnCount: m.turnCount || 0,
    kind: m.kind || 'chat',   // 'chat'=普通对话 / 'create'=AI 创作,前端据此切换视图与图标
    mode: m.mode || 'plain',  // 'plain'=普通 / 'agent'=Agent 对话,前端据此选图标
    fromScheduled: m.fromScheduled || null,  // 定时任务产出的会话,前端用时钟图标
    pinned: !!m.pinned,       // 置顶标记:列表里排在最前
  })).sort((a, b) => {
    // 置顶优先;同组内按更新时间倒序
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
});

// 置顶/取消置顶一条会话。只改 pinned 标记,不动 updatedAt(避免影响"最近更新"语义)。
//   pinned 写进正文而非只改索引 —— 索引可由正文完整重建,这个不变量不能破。
ipcMain.handle('history:setPinned', (_e, { id, pinned } = {}) => {
  const c = loadConversation(id);
  if (!c) return { ok: false };
  c.pinned = !!pinned;
  saveConversation(c);
  return { ok: true, pinned: c.pinned };
});

// IPC: 手动重命名会话。仿 setPinned:只改字段、不刷 updatedAt(重命名不该把会话顶到列表最前)。
//   titleManual 标记「用户手动起的名」——渲染层的 AI 摘要标题回写前会检查它,防止覆盖手动命名。
//   返回 c.title(saveConversation 收口后的值,可能被截到 26 视觉宽),渲染层以它回显。
ipcMain.handle('history:rename', (_e, { id, title } = {}) => {
  const t = String(title || '').trim();
  if (!t) return { ok: false };
  const c = loadConversation(id);
  if (!c) return { ok: false };
  c.title = t;
  c.titleGenerated = true;
  c.titleManual = true;
  saveConversation(c);
  return { ok: true, title: c.title };
});

ipcMain.handle('history:load', (_e, id) => loadConversation(id));

ipcMain.handle('history:save', (_e, conv) => {
  const now = new Date().toISOString();
  if (!conv.id) conv.id = genId();
  if (!conv.createdAt) conv.createdAt = now;
  conv.updatedAt = now;
  // 保留服务端侧的 pinned:渲染层的 conv 通常不带这个标记,整条覆盖会把置顶弄丢
  if (conv.pinned === undefined) {
    const prev = readHistoryIndex().find(m => m.id === conv.id);
    if (prev && prev.pinned) conv.pinned = true;
  }
  saveConversation(conv);
  return { id: conv.id, updatedAt: conv.updatedAt };
});

ipcMain.handle('history:delete', (_e, id) => {
  deleteConversation(id);
  return { ok: true };
});

// 会话全文搜索:在标题 + 对话正文(chat 的 user/assistant、create 的 prompt)里
//   做大小写不敏感子串匹配。目录式存储下按 updatedAt 新→旧逐文件扫描,凑满 cap 即提前停 ——
//   扫描序与结果序一致,无需再排序。个人量级(几百会话)全扫也在毫秒级,无需 DB/FTS5。
//   返回命中会话 {id,title,kind,mode,fromScheduled,updatedAt,snippet,matchField},按 updatedAt 倒序。
ipcMain.handle('history:search', (_e, { query, limit } = {}) => {
  const q = String(query || '').trim();
  if (!q) return { ok: true, items: [] };
  const qLower = q.toLowerCase();
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  // 在一段文本里找命中,返回前后约 30 字的片段 + 用 \x00…\x01 包裹命中词(前端转 <mark>)
  const SNIP = 30;
  const makeSnippet = (text) => {
    const t = String(text || '');
    const idx = t.toLowerCase().indexOf(qLower);
    if (idx < 0) return null;
    const start = Math.max(0, idx - SNIP);
    const end = Math.min(t.length, idx + q.length + SNIP);
    let s = t.slice(start, end);
    // 在片段内把命中词(可能多处)用哨兵包裹
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, (m) => '\x00' + m + '\x01');
    return (start > 0 ? '…' : '') + s + (end < t.length ? '…' : '');
  };

  const results = [];
  try {
    forEachConversation((c) => {
      const kind = c.kind || 'chat';
      let snippet = null, matchField = null;
      // 命中正文时记下定位:turnIndex = 命中所在 turn 的下标;matchSide = 命中在该 turn 的哪一侧
      //   (user / assistant / prompt),供前端打开会话后精确滚动到那条消息。标题命中则保持 null。
      let turnIndex = null, matchSide = null;
      // 标题
      if ((c.title || '').toLowerCase().includes(qLower)) { snippet = makeSnippet(c.title); matchField = 'title'; }
      // 正文(首条命中即可)
      if (!snippet) {
        const turns = c.turns || [];
        for (let ti = 0; ti < turns.length; ti++) {
          const t = turns[ti];
          const fields = kind === 'create' ? [['prompt', t.prompt]] : [['user', t.user], ['assistant', t.assistant]];
          for (const [side, f] of fields) {
            if (f && String(f).toLowerCase().includes(qLower)) {
              snippet = makeSnippet(f); matchField = 'body'; turnIndex = ti; matchSide = side; break;
            }
          }
          if (snippet) break;
        }
      }
      if (snippet) {
        results.push({
          id: c.id, title: c.title || '未命名', kind, mode: c.mode || 'plain',
          fromScheduled: c.fromScheduled || null, updatedAt: c.updatedAt || c.createdAt || '',
          snippet, matchField, turnIndex, matchSide,
        });
      }
      return results.length < cap;   // 凑满即提前终止扫描
    });
  } catch (_) { return { ok: true, items: [] }; }
  return { ok: true, items: results };
});

// 聚合真实 token 用量:Claude Code 会把每条消息(含 usage)写到
//   ~/.claude/projects/<编码cwd>/<sessionId>.jsonl。这里按「Relay 会话的 sessionId 集合」
//   只挑出经 Relay 发起的那些 transcript 文件,逐行累加 message.usage(输入/输出/缓存读写 token、模型)。
//   纯读本地文件、不联网;逐行解析 + 全程 try,坏行/缺字段直接跳过,绝不抛出影响面板。
//   sessionIdSet: Set<string>(Relay history 里所有会话的 sessionId)。
function aggregateTokenUsage(sessionIdSet) {
  const out = {
    available: false,            // 找到至少一个匹配 transcript 才置 true
    messages: 0,                 // 累计 assistant 消息条数(有 usage 的)
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearch: 0, webFetch: 0,
    byModel: [],                 // [{key:model,count:总token,...四项明细}] 降序
    matchedSessions: 0,          // 实际命中的 transcript 文件数
  };
  if (!sessionIdSet || sessionIdSet.size === 0) return out;

  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (_) { return out; }   // 没有 projects 目录 → 直接返回 unavailable

  const modelTokens = new Map();   // model → 输入/输出/缓存读写/总 token
  // 收集所有候选 transcript 路径:<projectsRoot>/<proj>/<sessionId>.jsonl
  //   (子目录 subagents/ 下还有子代理 transcript,这里只算主会话,避免重复计入父会话的 token)
  const targets = [];
  for (const proj of projectDirs) {
    const dir = path.join(projectsRoot, proj);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue;
      const sid = fn.slice(0, -6);   // 去掉 '.jsonl'
      if (sessionIdSet.has(sid)) targets.push(path.join(dir, fn));
    }
  }
  if (!targets.length) return out;
  out.matchedSessions = targets.length;

  for (const fp of targets) {
    let content = '';
    try { content = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    // 逐行解析(JSONL 每行一个 JSON 对象);只关心 type=assistant 且 message.usage 存在的行
    for (const line of content.split('\n')) {
      const s = line.trim();
      if (!s || s.indexOf('"usage"') < 0) continue;
      let d;
      try { d = JSON.parse(s); } catch (_) { continue; }
      const m = d && d.message;
      if (!m || typeof m !== 'object') continue;
      const u = m.usage;
      if (!u || typeof u !== 'object') continue;
      out.messages++;
      out.inputTokens += u.input_tokens || 0;
      out.outputTokens += u.output_tokens || 0;
      out.cacheCreationTokens += u.cache_creation_input_tokens || 0;
      out.cacheReadTokens += u.cache_read_input_tokens || 0;
      const stu = u.server_tool_use || {};
      out.webSearch += stu.web_search_requests || 0;
      out.webFetch += stu.web_fetch_requests || 0;
      const mdl = m.model || 'unknown';
      if (mdl !== '<synthetic>') {
        const item = modelTokens.get(mdl) || {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
        item.inputTokens += Number(u.input_tokens) || 0;
        item.outputTokens += Number(u.output_tokens) || 0;
        item.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
        item.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
        modelTokens.set(mdl, item);
      }
    }
  }
  out.available = out.messages > 0;
  out.byModel = [...modelTokens.entries()].map(([key, item]) => ({
    key,
    ...item,
    count: item.inputTokens + item.outputTokens + item.cacheCreationTokens + item.cacheReadTokens,
  })).sort((a, b) => b.count - a.count);
  return out;
}

// 从 transcript 派生「技能用量」。旧实现会在 Relay 启动 3 秒后同步全扫全部 JSONL，
// 既阻塞 Electron 主进程，又会在当前会话继续写入后迅速失效。现在改为：
//   1. 主进程只同步读取一个很小的持久化索引；
//   2. 打开技能页时立即返回索引里的旧值；
//   3. Worker 线程只读取新增文件/已有文件的追加尾部，完成后通知技能页无闪更新。
const SKILL_USAGE_INDEX_VERSION = 1;
const SKILL_USAGE_INDEX_FILE = path.join(app.getPath('userData'), 'skill-usage-index.json');
const SKILL_USAGE_WORKER_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'skill-usage-worker.js')
  : path.join(__dirname, 'skill-usage-worker.js');
let _skillUsageState = null;        // { index, map, ready }
let _skillUsageRefreshPromise = null;
let _skillUsageLastRefreshAt = 0;

function skillStatsArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    map.set(item.name, {
      useCount: Math.max(0, Number(item.useCount) || 0),
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
    });
  }
  return map;
}

function loadSkillUsageState() {
  if (_skillUsageState) return _skillUsageState;
  let index = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_USAGE_INDEX_FILE, 'utf8'));
    if (parsed && parsed.version === SKILL_USAGE_INDEX_VERSION) index = parsed;
  } catch (_) {}
  _skillUsageState = {
    index,
    map: skillStatsArrayToMap(index && index.skills),
    ready: !!index,
  };
  return _skillUsageState;
}

async function persistSkillUsageIndex(index) {
  const tmp = SKILL_USAGE_INDEX_FILE + '.tmp';
  await fs.promises.mkdir(path.dirname(SKILL_USAGE_INDEX_FILE), { recursive: true });
  await fs.promises.writeFile(tmp, Buffer.from(JSON.stringify(index), 'utf8'));
  await fs.promises.rename(tmp, SKILL_USAGE_INDEX_FILE);
}

function notifySkillUsageUpdated(payload = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send('skills:usageUpdated', payload); } catch (_) {}
  }
}

function refreshSkillUsageInBackground({ force = false } = {}) {
  if (_skillUsageRefreshPromise) return _skillUsageRefreshPromise;
  const now = Date.now();
  // 同一技能页内的重复 overview/操作不反复创建 Worker；当前对话仍在写时，15 秒后再校准即可。
  if (!force && _skillUsageLastRefreshAt && now - _skillUsageLastRefreshAt < 15000) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const state = loadSkillUsageState();
  _skillUsageLastRefreshAt = now;
  const startedAt = Date.now();
  _skillUsageRefreshPromise = new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(SKILL_USAGE_WORKER_FILE, {
      workerData: {
        projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
        previous: state.index,
      },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      _skillUsageRefreshPromise = null;
      resolve(result);
    };
    worker.once('message', async (result) => {
      if (!result || !result.ok || !result.index) {
        console.warn('[skill-usage] 增量索引失败: %s', (result && result.message) || '未知错误');
        finish(result || { ok: false });
        return;
      }
      try {
        if (!result.changed && state.ready) {
          console.log(
            '[skill-usage] 索引已是最新 files=%d duration=%dms',
            result.totalFiles || 0,
            Date.now() - startedAt,
          );
          finish(result);
          return;
        }
        await persistSkillUsageIndex(result.index);
        _skillUsageState = {
          index: result.index,
          map: skillStatsArrayToMap(result.index.skills),
          ready: true,
        };
        console.log(
          '[skill-usage] 增量索引完成 files=%d changed=%d bytes=%d duration=%dms',
          result.totalFiles || 0,
          result.scannedFiles || 0,
          result.scannedBytes || 0,
          Date.now() - startedAt,
        );
        // 首次建立索引或 transcript 有变化时才让可见技能页更新；不清空现有列表。
        if (result.changed || !state.ready) {
          notifySkillUsageUpdated({ updatedAt: result.index.updatedAt });
        }
        finish(result);
      } catch (e) {
        console.warn('[skill-usage] 索引落盘失败: %s', e.message);
        finish({ ok: false, message: e.message });
      }
    });
    worker.once('error', (error) => {
      console.warn('[skill-usage] Worker 失败: %s', error.message);
      finish({ ok: false, message: error.message });
    });
    worker.once('exit', (code) => {
      if (code !== 0) finish({ ok: false, message: `Worker 退出码 ${code}` });
    });
  });
  return _skillUsageRefreshPromise;
}

// ─────────────────────────────────────────
// IPC: 用量统计(stats:overview)
//   双数据源:① Relay 自家历史库(userData/history/,会话/创作)+ schedules.json(定时任务 runs)——会话数、
//   轮次、创作张数、模型/Agent/模式占比、活跃、定时任务成功率;② Claude Code 的 jsonl transcript
//   ——按 Relay 会话的 sessionId 聚合真实 token 用量(输入/输出/缓存/按模型)。token 块只统计经
//   Relay 发起的会话(用 sessionId 匹配),不含用户在终端直连 claude 的用量。
//   days: 时间分布与活跃统计的回溯窗口(默认 30 天);全局累计(总数/排行/token)不受 days 限制。
// ─────────────────────────────────────────
ipcMain.handle('stats:overview', (_e, { days } = {}) => {
  const N = Math.min(Math.max(parseInt(days, 10) || 30, 7), 180);   // 7..180,默认 30
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 本地日期 key(YYYY-MM-DD),按本地时区分桶,跨天才符合用户直觉
  const dayKey = (ms) => {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const parseMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

  // 预置 N 天的日期桶(零值占位),保证柱状图连续不缺天
  const dailyMap = new Map();
  const startKeyMs = new Date(now); startKeyMs.setHours(0, 0, 0, 0);
  const startDayMs = startKeyMs.getTime() - (N - 1) * dayMs;
  for (let i = 0; i < N; i++) dailyMap.set(dayKey(startDayMs + i * dayMs), 0);

  const totals = { conversations: 0, chatConvs: 0, createConvs: 0, messages: 0, images: 0, scheduledConvs: 0 };
  const byModel = new Map();   // 档位 → 会话数(保留在 payload,前端暂不展示)
  const byAgent = new Map();   // agentLabel → 会话数(仅 agent 模式)
  const byMode = { plain: 0, agent: 0, orchestrate: 0, create: 0 };
  const sessionIds = new Set();   // Relay 所有会话的 sessionId,供 token 聚合按会话匹配 transcript

  // 逐文件遍历全部会话正文(目录式存储),一条条累加,不把整库攒进内存
  try { forEachConversation((c) => {
    totals.conversations++;
    const kind = c.kind || 'chat';
    const turns = Array.isArray(c.turns) ? c.turns : [];
    if (c.fromScheduled) totals.scheduledConvs++;
    if (c.sessionId) sessionIds.add(c.sessionId);

    if (kind === 'create') {
      totals.createConvs++;
      byMode.create++;
      // 创作:每个 turn 产出的图片张数 = resultPaths 长度
      for (const t of turns) {
        const n = Array.isArray(t.resultPaths) ? t.resultPaths.length : 0;
        totals.images += n;
      }
    } else {
      totals.chatConvs++;
      // 协同(orchestrate)单列;agent 单列;其余归 plain
      const mode = c.mode === 'agent' ? 'agent' : (c.mode === 'orchestrate' ? 'orchestrate' : 'plain');
      byMode[mode]++;
      // 消息轮次:有用户输入的 turn 计一轮
      for (const t of turns) {
        if (t && (t.user || (t.files && t.files.length))) totals.messages++;
      }
      // 模型占比(会话级,按档位计数;前端暂不展示,保留备用)
      const model = (c.sessionModel || c.model || 'unknown');
      byModel.set(model, (byModel.get(model) || 0) + 1);
      // Agent 排行:① 单 agent 模式按会话计;② 协同模式统计本会话里派给过哪些子 agent(去重,每会话每 agent 计一次)
      if (mode === 'agent') {
        const label = c.agentLabel || c.agent || '(未命名 Agent)';
        byAgent.set(label, (byAgent.get(label) || 0) + 1);
      } else if (mode === 'orchestrate') {
        const used = new Set();
        for (const t of turns) {
          for (const m of (Array.isArray(t.chat) ? t.chat : [])) {
            if (m && m.role === 'agent' && m.agent) used.add(m.agent);
          }
        }
        for (const name of used) byAgent.set(name, (byAgent.get(name) || 0) + 1);
      }
    }

    // 每日活跃:用每个 turn 的 ts 落桶(取不到则退回会话 updatedAt),只统计窗口内
    let counted = false;
    for (const t of turns) {
      const ms = parseMs(t && t.ts);
      if (ms == null) continue;
      const k = dayKey(ms);
      if (dailyMap.has(k)) { dailyMap.set(k, dailyMap.get(k) + 1); counted = true; }
    }
    if (!counted) {
      const ms = parseMs(c.updatedAt);
      if (ms != null) { const k = dayKey(ms); if (dailyMap.has(k)) dailyMap.set(k, dailyMap.get(k) + 1); }
    }
  }); } catch (e) { console.warn('[usage] 历史库读取异常: %s', e.message); }

  // 定时任务:从 scheduler 拿全部 runs + 任务列表
  let runs = [], tasks = [];
  try { runs = scheduler.runs() || []; } catch (e) { console.warn('[usage] scheduler.runs 失败: %s', e.message); runs = []; }
  try { tasks = scheduler.list() || []; } catch (e) { console.warn('[usage] scheduler.list 失败: %s', e.message); tasks = []; }

  const sched = { tasksTotal: tasks.length, tasksEnabled: 0, runsTotal: runs.length, ok: 0, error: 0, avgMs: 0, recent: [] };
  for (const t of tasks) { if (t && t.enabled) sched.tasksEnabled++; }
  let msSum = 0, msCount = 0;
  for (const r of runs) {
    if (r.status === 'ok') sched.ok++; else if (r.status === 'error') sched.error++;
    if (Number.isFinite(r.ms)) { msSum += r.ms; msCount++; }
  }
  sched.avgMs = msCount ? Math.round(msSum / msCount) : 0;
  sched.successRate = sched.runsTotal ? Math.round((sched.ok / sched.runsTotal) * 100) : null;
  // 最近 5 条执行记录(runs 已按新→旧 unshift),附任务名
  const taskNameById = new Map(tasks.map((t) => [t.id, t.name]));
  sched.recent = runs.slice(0, 5).map((r) => ({
    name: taskNameById.get(r.taskId) || '(已删除任务)',
    at: r.at, status: r.status, ms: r.ms || 0,
    summary: (r.summary || r.error || '').slice(0, 60),
  }));

  // Map → 排序数组(降序),便于前端直接渲染排行
  const toRanked = (map) => [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  const daily = [...dailyMap.entries()].map(([date, count]) => ({ date, count }));

  // 真实 token 用量(读 Claude Code transcript,按 Relay sessionId 过滤)。失败/无数据返回 available:false。
  let tokens;
  try { tokens = aggregateTokenUsage(sessionIds); }
  catch (e) { console.warn('[usage] token 统计失败: %s', e.message); tokens = { available: false }; }

  return {
    ok: true,
    days: N,
    generatedAt: new Date(now).toISOString(),
    totals,
    daily,                         // [{date:'YYYY-MM-DD', count}] 长度 N,旧→新
    byModel: toRanked(byModel),    // [{key, count}]
    byAgent: toRanked(byAgent),
    byMode,                        // {plain, agent, create}
    scheduler: sched,
    tokens,                        // {available, messages, inputTokens, outputTokens, cacheReadTokens, ..., byModel}
  };
});

// ─────────────────────────────────────────
// IPC: 设置(~/.claude/settings.json + 本地 app 偏好)
// ─────────────────────────────────────────
function settingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }
function appSettingsPath() { return path.join(app.getPath('userData'), 'app-settings.json'); }

function readSettings() {
  const f = settingsPath();
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.error('[settings] 解析失败:', e.message); return {}; }
}
function writeSettings(data) {
  const f = settingsPath();
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 用 UTF-8 无 BOM 写,跟 install-claude 保持一致(否则 feishu MCP 不认)
  const utf8NoBom = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, utf8NoBom);
  fs.renameSync(tmp, f);
}
function readAppSettings() {
  const f = appSettingsPath();
  if (!fs.existsSync(f)) return { permissionMode: 'bypassPermissions' };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { console.error('[settings] app-settings 解析失败: %s', e.message); return { permissionMode: 'bypassPermissions' }; }
}
function writeAppSettings(data) {
  const f = appSettingsPath();
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

ipcMain.handle('settings:read', () => {
  const s = readSettings();
  const a = readAppSettings();
  return {
    paths: {
      claudeSettings: settingsPath(),
      claudeJson: path.join(os.homedir(), '.claude.json'),
      appSettings: appSettingsPath(),
      historyDir: getHistoryDir(),
      logsDir: path.join(app.getPath('userData'), 'logs'),
      agentDir: AGENTS_DIR,
      skillsDir: SKILLS_DIR,
      installLog: path.join(os.tmpdir(), 'relay-install.log'),
    },
    claude: {
      apiKey:        s.env?.ANTHROPIC_API_KEY        || '',
      baseUrl:       s.env?.ANTHROPIC_BASE_URL       || 'http://model.mify.ai.srv/anthropic',
      opusModel:     s.env?.ANTHROPIC_DEFAULT_OPUS_MODEL    || '',
      sonnetModel:   s.env?.ANTHROPIC_DEFAULT_SONNET_MODEL  || '',
      haikuModel:    s.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL   || '',
      defaultModel:  s.model || 'haiku',
      alwaysThinking:          !!s.alwaysThinkingEnabled,
      skipDangerousPrompt:     !!s.skipDangerousModePermissionPrompt,
    },
    app: {
      permissionMode: a.permissionMode || 'bypassPermissions',
      allowCommandTasks: !!a.allowCommandTasks,   // 命令类定时任务总开关（默认关）
      miniInputEnabled: a.miniInputEnabled !== false,   // 迷你输入框（Alt+Space）总开关（默认开；仅显式 false 才关）
      conversationIndex: a.conversationIndex !== false, // 对话快捷索引（默认开；仅显式 false 才关）
      theme: a.theme || 'light',
      skillMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.skillMaintenanceModel) ? a.skillMaintenanceModel : '',
      memoryMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.memoryMaintenanceModel) ? a.memoryMaintenanceModel : '',
    },
    imageApi: {
      // 当前生效值(已含默认回落);apiKey 仅返回是否已设,不回显明文
      baseUrl: (a.imageApi && a.imageApi.baseUrl) || IMAGE_API_DEFAULTS.baseUrl,
      apiKey:  (a.imageApi && a.imageApi.apiKey) || '',
    },
    info: {
      uiVersion:    app.getVersion ? app.getVersion() : 'dev',
    },
  };
});

ipcMain.handle('settings:write', (_e, payload) => {
  // 合并写,不动用户其他自定义字段
  const s = readSettings();
  if (!s.env) s.env = {};
  if (payload.claude) {
    const c = payload.claude;
    if (c.apiKey      !== undefined) s.env.ANTHROPIC_API_KEY              = c.apiKey;
    if (c.baseUrl     !== undefined) s.env.ANTHROPIC_BASE_URL             = c.baseUrl;
    if (c.opusModel   !== undefined) s.env.ANTHROPIC_DEFAULT_OPUS_MODEL   = c.opusModel;
    if (c.sonnetModel !== undefined) s.env.ANTHROPIC_DEFAULT_SONNET_MODEL = c.sonnetModel;
    if (c.haikuModel  !== undefined) s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  = c.haikuModel;
    if (c.defaultModel        !== undefined) s.model                            = c.defaultModel;
    if (c.alwaysThinking      !== undefined) s.alwaysThinkingEnabled            = c.alwaysThinking;
    if (c.skipDangerousPrompt !== undefined) s.skipDangerousModePermissionPrompt = c.skipDangerousPrompt;
  }
  writeSettings(s);

  if (payload.app) {
    const a = readAppSettings();
    Object.assign(a, payload.app);
    writeAppSettings(a);
    // 主题切换 → 同步 Electron nativeTheme + 窗口背景色
    if (payload.app.theme) {
      nativeTheme.themeSource = payload.app.theme === 'system' ? 'system'
                              : payload.app.theme === 'dark'   ? 'dark' : 'light';
      const bg = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa';
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.setBackgroundColor(bg); } catch (e) { console.warn('[settings] 设置窗口背景色失败: %s', e.message); }
      }
    }
    // 迷你输入框开关可能变了 → 即时生效:开则(重)注册快捷键,关则释放 Alt+Space + 隐藏已开的迷你窗;
    //   并刷新托盘菜单(关时连「快速输入」项一起隐藏)。
    if (Object.prototype.hasOwnProperty.call(payload.app, 'miniInputEnabled')) {
      try { registerMiniShortcut(); } catch (e) { console.warn('[settings] 注册迷你快捷键失败: %s', e.message); }
      if (payload.app.miniInputEnabled === false && miniWindow && !miniWindow.isDestroyed()) {
        try { miniWindow.hide(); } catch (e) { console.warn('[mini] 隐藏窗口失败: %s', e.message); }
      }
      try { refreshTrayMenu(); } catch (e) { console.warn('[tray] 刷新菜单失败: %s', e.message); }
    }
  }
  if (payload.imageApi) {
    const a = readAppSettings();
    a.imageApi = a.imageApi || {};
    if (payload.imageApi.baseUrl !== undefined) a.imageApi.baseUrl = payload.imageApi.baseUrl;
    if (payload.imageApi.apiKey  !== undefined) a.imageApi.apiKey  = payload.imageApi.apiKey;
    writeAppSettings(a);
  }
  return { ok: true };
});

ipcMain.handle('settings:revealFile', (_e, p) => {
  if (!p) return { ok: false };
  if (fs.existsSync(p)) {
    shell.showItemInFolder(p);
    return { ok: true };
  }
  // 文件不存在 → 打开父目录
  const dir = path.dirname(p);
  if (fs.existsSync(dir)) {
    shell.openPath(dir);
    return { ok: true, note: '文件不存在，已打开所在文件夹' };
  }
  return { ok: false, note: '路径不存在' };
});

// ─────────────────────────────────────────
// IPC: 品牌自定义(侧边栏左上角 logo 图片 + 名称)
// ─────────────────────────────────────────
//   名称存 app-settings.json 的 brandName(按视觉宽度限制,与历史对话标题同规则);
//   logo 图片拷贝进 userData/brand-logo.<ext>(随应用升级/重装不丢,不写进配置文件),
//   只在 app-settings.json 存相对文件名 brandLogo。渲染端拿 data URL 显示(避免 file://
//   在打包后的 contextIsolation 下的路径/缓存坑)。
// 名称长度上限 = 视觉宽度 21(全角/CJK 记 2、英文/数字记 1),即约 10 个中文 或 21 个英文。
//   取 21 是因为左上角 Logo 区在 15px 字号下最多一行放得下这么宽——不缩字号,放不下就不让再输。
const BRAND_NAME_MAX = 21;
const BRAND_IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'];
const BRAND_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
function brandLogoAbsPath() {
  const a = readAppSettings();
  if (!a.brandLogo) return null;
  const p = path.join(app.getPath('userData'), a.brandLogo);
  return fs.existsSync(p) ? p : null;
}
// 读 logo 为 data URL(没有自定义则返回 null,渲染端 fallback 到内置 logo.png)
function brandLogoDataUrl() {
  const p = brandLogoAbsPath();
  if (!p) return null;
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = BRAND_MIME[ext] || 'image/png';
    const b64 = fs.readFileSync(p).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch { return null; }
}

ipcMain.handle('brand:get', () => {
  const a = readAppSettings();
  const name = typeof a.brandName === 'string' ? a.brandName : '';
  return { name, nameMax: BRAND_NAME_MAX, logo: brandLogoDataUrl() };
});

// ── 迷你输入框 IPC ──
// 渲染端拉品牌(名称 + logo data URL),用于迷你窗头部展示。
ipcMain.handle('mini:brand', () => {
  const a = readAppSettings();
  return {
    name: (typeof a.brandName === 'string' && a.brandName) ? a.brandName : 'Relay',
    logo: brandLogoDataUrl(),
  };
});
// 迷你窗投递一句话:隐藏自身 → 弹主窗 → 转发给主窗渲染端,由其新建对话并发送。
//   主窗可能未创建/在托盘:showMainWindow 会按需创建;主窗渲染端就绪后监听 'mini:submit'。
//   首帧未必就绪,这里延后一拍再发,确保 app.js 的监听已挂上(主窗刚冷启时尤其需要)。
ipcMain.handle('mini:submit', (_e, text) => {
  const prompt = String(text || '').trim();
  if (!prompt) return { ok: false };
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  const wasReady = mainWindow && !mainWindow.isDestroyed();
  showMainWindow();
  const send = () => { try { mainWindow.webContents.send('mini:submit', prompt); } catch (e) { console.error('[mini] 转发 prompt 到主窗口失败: %s', e.message); } };
  // 已有主窗 → 立即发;冷启新建 → 等首帧就绪再发(否则监听还没挂上,消息丢失)
  if (wasReady) send();
  else if (mainWindow) mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 120));
  return { ok: true };
});
// 迷你窗请求隐藏(ESC)。
ipcMain.handle('mini:hide', () => { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide(); return { ok: true }; });
// 迷你窗按内容高度请求调整窗口高度(多行输入时长高)。宽度不变,只调高度。
ipcMain.handle('mini:resize', (_e, height) => {
  if (!miniWindow || miniWindow.isDestroyed()) return { ok: false };
  const h = Math.max(152, Math.min(440, Math.round(Number(height) || 152)));
  const [w] = miniWindow.getSize();
  miniWindow.setSize(w, h);
  return { ok: true };
});

ipcMain.handle('brand:setName', (_e, name) => {
  const a = readAppSettings();
  // 按【视觉宽度】裁剪(与渲染端 + 历史标题一致):全角记 2/半角记 1,且不切断英文单词
  const raw = String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim();
  const clean = truncateByWidth(raw, BRAND_NAME_MAX);
  if (clean) a.brandName = clean; else delete a.brandName;   // 清空 = 恢复默认名 "Relay"
  writeAppSettings(a);
  return { ok: true, name: clean };
});

ipcMain.handle('brand:pickLogo', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择 Logo 图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: BRAND_IMG_EXT.map((e) => e.slice(1)) }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!BRAND_IMG_EXT.includes(ext)) return { ok: false, message: '不支持的图片格式' };
  try {
    const st = fs.statSync(src);
    if (st.size > 5 * 1024 * 1024) return { ok: false, message: '图片过大(请小于 5MB)' };
    // 先清掉旧的 brand-logo.*,避免换格式后残留多份
    const ud = app.getPath('userData');
    for (const e of BRAND_IMG_EXT) {
      const old = path.join(ud, `brand-logo${e}`);
      if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
    }
    const destName = `brand-logo${ext}`;
    fs.copyFileSync(src, path.join(ud, destName));
    const a = readAppSettings();
    a.brandLogo = destName;
    writeAppSettings(a);
    return { ok: true, logo: brandLogoDataUrl() };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  }
});

ipcMain.handle('brand:resetLogo', () => {
  const a = readAppSettings();
  const ud = app.getPath('userData');
  for (const e of BRAND_IMG_EXT) {
    const old = path.join(ud, `brand-logo${e}`);
    if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
  }
  delete a.brandLogo;
  writeAppSettings(a);
  return { ok: true };
});

// ── 协同 PM 的名称 + 头像自定义(与 brand 同机制:名称存 pmName,图片拷进 userData/pm-logo.<ext>) ──
//   名称上限放宽到 16(群聊气泡名字行,比左上角 Logo 区宽松);为空 = 默认 "PM"。
const PM_NAME_MAX = 16;
function pmLogoAbsPath() {
  const a = readAppSettings();
  if (!a.pmLogo) return null;
  const p = path.join(app.getPath('userData'), a.pmLogo);
  return fs.existsSync(p) ? p : null;
}
function pmLogoDataUrl() {
  const p = pmLogoAbsPath();
  if (!p) return null;
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = BRAND_MIME[ext] || 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return null; }
}
ipcMain.handle('pm:get', () => {
  const a = readAppSettings();
  const name = typeof a.pmName === 'string' ? a.pmName : '';
  return { name, nameMax: PM_NAME_MAX, logo: pmLogoDataUrl() };
});
ipcMain.handle('pm:setName', (_e, name) => {
  const a = readAppSettings();
  const raw = String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim();
  const clean = truncateByWidth(raw, PM_NAME_MAX);
  if (clean) a.pmName = clean; else delete a.pmName;   // 清空 = 恢复默认 "PM"
  writeAppSettings(a);
  return { ok: true, name: clean };
});
ipcMain.handle('pm:pickLogo', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择 PM 头像图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: BRAND_IMG_EXT.map((e) => e.slice(1)) }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!BRAND_IMG_EXT.includes(ext)) return { ok: false, message: '不支持的图片格式' };
  try {
    const st = fs.statSync(src);
    if (st.size > 5 * 1024 * 1024) return { ok: false, message: '图片过大(请小于 5MB)' };
    const ud = app.getPath('userData');
    for (const e of BRAND_IMG_EXT) {
      const old = path.join(ud, `pm-logo${e}`);
      if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
    }
    const destName = `pm-logo${ext}`;
    fs.copyFileSync(src, path.join(ud, destName));
    const a = readAppSettings();
    a.pmLogo = destName;
    writeAppSettings(a);
    return { ok: true, logo: pmLogoDataUrl() };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  }
});
ipcMain.handle('pm:resetLogo', () => {
  const a = readAppSettings();
  const ud = app.getPath('userData');
  for (const e of BRAND_IMG_EXT) {
    const old = path.join(ud, `pm-logo${e}`);
    if (fs.existsSync(old)) { try { fs.rmSync(old, { force: true }); } catch (_) {} }
  }
  delete a.pmLogo;
  writeAppSettings(a);
  return { ok: true };
});

// ─────────────────────────────────────────
// IPC: 数据中心(在 UI 内直接编辑配置 / 管理 Agent & 技能 / 导入 zip)
// ─────────────────────────────────────────
function claudeJsonPath() { return path.join(os.homedir(), '.claude.json'); }

// 极简 YAML frontmatter 解析(只取顶层 key: value),用于显示 agent/skill 描述
function parseFrontmatter(text) {
  const out = {};
  const m = String(text || '').match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (mm) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
function listAgentNames() {
  try {
    const custom = readAppSettings().agentNames || {};   // { file → 用户自定义显示名 }
    return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => {
        let desc = '', fmName = '';
        try {
          const fm = parseFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, e.name), 'utf8'));
          desc = fm.description || '';
          fmName = fm.name || '';
        } catch (_) {}
        // name = Claude 实际识别的子智能体 id(优先取 frontmatter.name,否则文件名)
        const name = fmName || e.name.replace(/\.md$/i, '');
        // displayName = 用户自定义名(若设过),否则用 name —— 仅用于界面显示
        const displayName = (custom[e.name] && String(custom[e.name]).trim()) || name;
        return { name, file: e.name, desc, displayName };
      });
  } catch (e) { console.warn('[agent] 列表读取失败: %s', e.message); return []; }
}
function parseSkillPresentationYaml(file) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const scalar = (value) => {
      const s = String(value || '').trim();
      if (!s) return '';
      if (s.startsWith('"') && s.endsWith('"')) {
        try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); }
      }
      if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
      return s.replace(/\s+#.*$/, '').trim();
    };
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(display_name|short_description|default_prompt)\s*:\s*(.*?)\s*$/);
      if (m) out[m[1]] = scalar(m[2]);
    }
  } catch (_) {}
  return out;
}

function skillBodyPresentation(raw, fallbackName, fallbackDesc) {
  const body = String(raw || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
  const lines = body.split(/\r?\n/);
  let title = '';
  let paragraph = [];
  for (const line of lines) {
    const text = line.trim();
    if (!title) {
      const h1 = text.match(/^#\s+(.+)$/);
      if (h1) { title = h1[1].trim(); continue; }
    }
    if (!text) {
      if (paragraph.length) break;
      continue;
    }
    // 标题、列表、代码块、引用和表格不是摘要；优先取 H1 后的第一段自然语言。
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|>|---+$|\|)/.test(text)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(text);
    if (paragraph.join(' ').length >= 180) break;
  }
  return {
    displayName: title || fallbackName,
    summary: paragraph.join(' ').trim() || fallbackDesc || '',
  };
}

function cleanSkillPresentationText(value, maxLength) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, maxLength);
}

// 用快速模型为新安装的 Skill 生成 Relay 专属中文展示元数据。
// 文件位置沿用 Codex 的 agents/openai.yaml 约定，改用 agents/relay.yaml；
// 它只负责界面展示，Claude Code 实际调用仍使用 SKILL.md frontmatter.name。
async function generateSkillPresentationWithClaude(skillName, callName, description, skillBody) {
  const source = String(skillBody || '').slice(0, 7000);
  const prompt = [
    '请根据下面的 Skill 定义，为桌面 AI 助手生成中文展示元数据。',
    '要求：',
    '1. display_name：准确、自然的中文标题，建议 4-16 个汉字；必要的产品名、缩写可保留。',
    '2. short_description：一句中文摘要，建议 18-45 个汉字；说明这个技能能做什么以及适用场景。',
    '3. 不要夸大能力，不要添加原文没有的信息。',
    '4. 只输出一行严格 JSON，不要 Markdown、代码围栏或解释。',
    'JSON 格式：{"display_name":"中文标题","short_description":"中文摘要"}',
    '',
    `目录名：${skillName}`,
    `调用 ID：${callName}`,
    `原始描述：${description || '无'}`,
    '',
    'SKILL.md：',
    source,
  ].join('\n');

  const out = await claudeSdk.runText({
    prompt,
    cwd: os.homedir(),
    model: 'haiku',
    timeoutMs: 30000,
    tools: [],           // 只做文本归纳，禁止被导入内容诱导调用任何工具
  });
  if (!out) { console.warn('[skill-meta] 中文元数据生成无输出: %s', skillName); return null; }
  try {
    const cleaned = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const data = JSON.parse(cleaned.slice(start, end + 1));
    const displayName = cleanSkillPresentationText(data.display_name, 40);
    const summary = cleanSkillPresentationText(data.short_description, 120);
    const hasChinese = (value) => /[\u3400-\u9fff]/.test(value);
    if (!displayName || !summary || !hasChinese(displayName) || !hasChinese(summary)) return null;
    return { displayName, summary };
  } catch (e) {
    console.warn('[skill-meta] 返回内容无法解析: %s', e.message);
    return null;
  }
}

function writeRelaySkillPresentation(skillDir, presentation) {
  const agentsDir = path.join(skillDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const target = path.join(agentsDir, 'relay.yaml');
  const temp = target + '.tmp';
  const body = [
    '# Generated by Relay. Used for display only; SKILL.md remains the source of truth.',
    'interface:',
    `  display_name: ${JSON.stringify(presentation.displayName)}`,
    `  short_description: ${JSON.stringify(presentation.summary)}`,
    '',
  ].join('\n');
  fs.writeFileSync(temp, body, 'utf8');
  try {
    fs.renameSync(temp, target);
  } catch (e) {
    // Windows 某些文件系统不允许 rename 覆盖已有文件；重复导入时安全替换。
    if (!fs.existsSync(target)) throw e;
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  }
}

async function generateRelaySkillPresentation(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  const fm = parseFrontmatter(raw) || {};
  const skillName = path.basename(skillDir);
  const callName = fm.name || skillName;
  const fallback = skillBodyPresentation(raw, skillName, fm.description || '');
  const packageMeta = parseSkillPresentationYaml(path.join(skillDir, 'agents', 'openai.yaml'));
  const generated = await generateSkillPresentationWithClaude(
    skillName,
    callName,
    fm.description || '',
    raw,
  );
  const presentation = {
    displayName: generated?.displayName
      || packageMeta.display_name
      || fallback.displayName
      || skillName,
    summary: generated?.summary
      || packageMeta.short_description
      || fallback.summary
      || fm.description
      || '',
  };
  writeRelaySkillPresentation(skillDir, presentation);
  console.log('[skill-meta] relay.yaml 已生成: %s source=%s', skillName, generated ? 'llm' : 'fallback');
  return { ...presentation, generatedBy: generated ? 'llm' : 'fallback' };
}

async function generateImportedSkillPresentations(skillDirs) {
  let llmCount = 0;
  let fallbackCount = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < skillDirs.length) {
      const skillDir = skillDirs[cursor++];
      try {
        const result = await generateRelaySkillPresentation(skillDir);
        if (result.generatedBy === 'llm') llmCount++;
        else fallbackCount++;
      } catch (e) {
        fallbackCount++;
        console.warn('[skill-meta] relay.yaml 写入失败 %s: %s', path.basename(skillDir), e.message);
      }
    }
  };
  const concurrency = Math.min(2, skillDirs.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { llmCount, fallbackCount };
}

function listSkillNames() {
  try {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      // 排除 . 前缀目录(.archive 归档区、.usage.json 等 Curator 元数据),否则会被当成"技能"
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        let desc = '', raw = '', fm = {};
        const sk = path.join(SKILLS_DIR, e.name, 'SKILL.md');
        try {
          if (fs.existsSync(sk)) {
            raw = fs.readFileSync(sk, 'utf8').replace(/^﻿/, '');
            fm = parseFrontmatter(raw) || {};
            desc = fm.description || '';
          }
        } catch (_) {}
        const bodyMeta = skillBodyPresentation(raw, e.name, desc);
        const relayMeta = parseSkillPresentationYaml(path.join(SKILLS_DIR, e.name, 'agents', 'relay.yaml'));
        const openaiMeta = parseSkillPresentationYaml(path.join(SKILLS_DIR, e.name, 'agents', 'openai.yaml'));
        const uiMeta = { ...openaiMeta, ...relayMeta };
        return {
          name: e.name,                         // 本地目录键；设置页管理操作继续使用它
          callName: fm.name || e.name,           // Claude Code 实际调用 ID，绝不能本地化
          desc,
          displayName: uiMeta.display_name || fm.display_name || fm.displayName || bodyMeta.displayName || e.name,
          summary: uiMeta.short_description || fm.short_description || fm.summary || bodyMeta.summary || desc,
          defaultPrompt: uiMeta.default_prompt || fm.default_prompt || '',
        };
      });
  } catch (e) { console.warn('[skill] 列表读取失败: %s', e.message); return []; }
}
// 解压 zip 到临时目录(用 PowerShell Expand-Archive,Windows 自带)
function unzipToTemp(zipPath) {
  return new Promise((resolve, reject) => {
    const dest = path.join(os.tmpdir(), 'relay-import-' + Date.now());
    fs.mkdirSync(dest, { recursive: true });
    const q = (s) => String(s).replace(/'/g, "''");
    const cmd = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(dest)}' -Force`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => (code === 0 ? resolve(dest) : reject(new Error(err.trim() || ('Expand-Archive 退出码 ' + code)))));
    ps.on('error', reject);
  });
}
// 跳过 zip 常见的单层包裹目录 / __MACOSX
function findContentRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  return dir;
}
function findDirsWithFile(root, fileName, maxDepth) {
  const found = [];
  (function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === fileName.toLowerCase())) { found.push(d); return; }
    for (const e of entries) if (e.isDirectory() && e.name !== '__MACOSX') walk(path.join(d, e.name), depth + 1);
  })(root, 0);
  return found;
}

// 读配置文件原文(claudeSettings=settings.json)。MCP 已改走结构化 mcp:list/toggle/delete,不再经此。
ipcMain.handle('data:read', (_e, { kind }) => {
  try {
    if (kind === 'claudeSettings') {
      const f = settingsPath();
      const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^﻿/, '') : '{\n}\n';
      return { ok: true, path: f, content: raw };
    }
    return { ok: false, message: '未知类型' };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 写配置(先校验 JSON,UTF-8 无 BOM 原子写)
ipcMain.handle('data:write', (_e, { kind, content }) => {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { return { ok: false, message: 'JSON 格式有误，请检查：' + e.message }; }
  const atomicWrite = (f, obj) => {
    const dir = path.dirname(f); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));  // 无 BOM
    fs.renameSync(tmp, f);
  };
  try {
    if (kind === 'claudeSettings') { atomicWrite(settingsPath(), parsed); return { ok: true }; }
    return { ok: false, message: '未知类型' };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── MCP 服务器结构化管理(启停 / 删除)──
//   设计:.claude.json 的 mcpServers = 「启用」的服务器(claude.exe 只启动这里的条目);
//   「禁用但保留」的条目移到同文件的 sidecar 键 mcpServersDisabled(claude.exe 不认识该键、直接忽略)。
//   这样「关掉」是真关(条目离开 mcpServers,claude 不会再起它),且配置不丢、可一键移回。
//   —— 不用「entry 里加 disabled:true」是因为 claude.exe 是否honor该标记不确定,移走才 100% 可靠。
const MCP_DISABLED_KEY = 'mcpServersDisabled';
// 安全读改写 .claude.json:BOM 剥离 + 解析失败拒写(绝不冲掉会话/onboarding 等其他键)+ 原子写。
function mutateClaudeJson(fn) {
  const f = claudeJsonPath();
  let cfg = {};
  if (fs.existsSync(f)) {
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
    catch (e) { return { ok: false, message: '.claude.json 解析失败，已取消操作以防数据丢失：' + e.message }; }
  }
  const ret = fn(cfg);   // fn 直接改 cfg;可返回 {ok:false,...} 中止
  if (ret && ret.ok === false) return ret;
  const dir = path.dirname(f); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'));   // 无 BOM
  fs.renameSync(tmp, f);
  return { ok: true };
}
// 一行摘要(列表副信息):本地命令显示 command;远程显示 url;否则给个类型提示。
function mcpSummary(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'url' || c.url) return String(c.url || 'url');
  if (c.command) return [c.command, ...(Array.isArray(c.args) ? c.args : [])].join(' ').trim();
  return c.type ? String(c.type) : '';
}
// 列出全部 MCP 服务器:启用(mcpServers)+ 禁用(sidecar),各带 enabled 标记 + 摘要,按名称排序。
ipcMain.handle('mcp:list', () => {
  const f = claudeJsonPath();
  let cfg = {};
  if (fs.existsSync(f)) { try { cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { console.warn('[mcp] 解析 claude.json 失败: %s', e.message); } }
  const on = cfg.mcpServers || {};
  const off = cfg[MCP_DISABLED_KEY] || {};
  const items = [];
  for (const [name, c] of Object.entries(on))  items.push({ name, enabled: true,  summary: mcpSummary(c) });
  for (const [name, c] of Object.entries(off)) items.push({ name, enabled: false, summary: mcpSummary(c) });
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, items, path: f };
});
// 启停:在 mcpServers ↔ mcpServersDisabled 之间搬运该条目。enabled=目标状态。
ipcMain.handle('mcp:toggle', (_e, { name, enabled } = {}) => {
  if (!name) return { ok: false, message: '缺少服务器名称' };
  return mutateClaudeJson((cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg[MCP_DISABLED_KEY] = cfg[MCP_DISABLED_KEY] || {};
    const from = enabled ? cfg[MCP_DISABLED_KEY] : cfg.mcpServers;
    const to   = enabled ? cfg.mcpServers : cfg[MCP_DISABLED_KEY];
    if (!(name in from)) {
      // 已在目标状态:幂等放行(可能用户连点),不报错
      if (name in to) return;
      return { ok: false, message: `未找到服务器「${name}」` };
    }
    to[name] = from[name];
    delete from[name];
    if (Object.keys(cfg[MCP_DISABLED_KEY]).length === 0) delete cfg[MCP_DISABLED_KEY];   // 空了就别留垃圾键
  });
});
// 删除:从启用或禁用任一处移除该条目(彻底删,不可恢复)。
ipcMain.handle('mcp:delete', (_e, { name } = {}) => {
  if (!name) return { ok: false, message: '缺少服务器名称' };
  return mutateClaudeJson((cfg) => {
    let hit = false;
    if (cfg.mcpServers && name in cfg.mcpServers) { delete cfg.mcpServers[name]; hit = true; }
    if (cfg[MCP_DISABLED_KEY] && name in cfg[MCP_DISABLED_KEY]) { delete cfg[MCP_DISABLED_KEY][name]; hit = true; }
    if (cfg[MCP_DISABLED_KEY] && Object.keys(cfg[MCP_DISABLED_KEY]).length === 0) delete cfg[MCP_DISABLED_KEY];
    if (!hit) return { ok: false, message: `未找到服务器「${name}」` };
  });
});

ipcMain.handle('data:listAgents', () => ({ ok: true, items: listAgentNames(), dir: AGENTS_DIR }));
ipcMain.handle('data:listSkills', () => ({ ok: true, items: listSkillNames(), dir: SKILLS_DIR }));

// Agent / 技能条目的详情、编辑与本地定位。所有路径都从受控目录和单个 basename
// 重新构造，renderer 不能传入任意绝对路径或跳出 ~/.claude。
function managedDataItem(kind, key) {
  const raw = String(key || '');
  const base = path.basename(raw);
  if (!base || base !== raw || base === '.' || base === '..') return null;
  if (kind === 'agent') {
    if (!base.toLowerCase().endsWith('.md')) return null;
    return { file: path.join(AGENTS_DIR, base), reveal: path.join(AGENTS_DIR, base) };
  }
  if (kind === 'skill') {
    const dir = path.join(SKILLS_DIR, base);
    return { file: path.join(dir, 'SKILL.md'), reveal: dir };
  }
  if (kind === 'archivedSkill') {
    const dir = path.join(SKILLS_DIR, '.archive', base);
    return { file: path.join(dir, 'SKILL.md'), reveal: dir };
  }
  return null;
}

ipcMain.handle('data:readItem', (_e, { kind, key } = {}) => {
  try {
    const item = managedDataItem(kind, key);
    if (!item) return { ok: false, message: '非法条目' };
    if (!fs.existsSync(item.file)) return { ok: false, message: '文件不存在' };
    return {
      ok: true,
      file: path.basename(item.file),
      content: fs.readFileSync(item.file, 'utf8').replace(/^﻿/, ''),
    };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:writeItem', (_e, { kind, key, content } = {}) => {
  try {
    if (kind === 'archivedSkill') return { ok: false, message: '归档技能仅支持查看' };
    const item = managedDataItem(kind, key);
    if (!item) return { ok: false, message: '非法条目' };
    if (!fs.existsSync(item.file)) return { ok: false, message: '文件不存在' };
    const tmp = item.file + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(String(content == null ? '' : content), 'utf8'));
    fs.renameSync(tmp, item.file);
    // 技能 Markdown 的描述变化不影响 transcript 派生的历史用量，无需让用量索引失效。
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:revealItem', async (_e, { kind, key } = {}) => {
  try {
    const item = managedDataItem(kind, key);
    if (!item) return { ok: false, message: '非法条目' };
    if (!fs.existsSync(item.reveal)) return { ok: false, message: '路径不存在' };
    if (kind === 'skill' || kind === 'archivedSkill') {
      const message = await shell.openPath(item.reveal);
      return message ? { ok: false, message } : { ok: true };
    }
    shell.showItemInFolder(item.reveal);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('data:removeAgent', (_e, { file }) => {
  try {
    const p = path.join(AGENTS_DIR, path.basename(String(file || '')));
    // 删 .md 之前先读出 agentName(frontmatter.name),用于清理项目级安装的资源映射
    let agentName = '';
    try { if (fs.existsSync(p)) agentName = (parseFrontmatter(fs.readFileSync(p, 'utf8')).name || '').trim(); } catch (_) {}
    if (!agentName) agentName = path.basename(String(file || '')).replace(/\.md$/i, '');
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    // 同时清掉它的自定义名映射 + 项目级安装(铺开的整包项目根 + agentProjects 映射)
    const a = readAppSettings();
    let dirty = false;
    if (a.agentNames && a.agentNames[file]) { delete a.agentNames[file]; dirty = true; }
    if (a.agentProjects && a.agentProjects[agentName]) {
      const projRoot = a.agentProjects[agentName];
      // 安全护栏:只删 ~/.claude/relay-agents/ 下的目录,绝不误删用户别处的目录
      const projBase = path.join(os.homedir(), '.claude', 'relay-agents');
      try {
        if (projRoot && projRoot.startsWith(projBase) && fs.existsSync(projRoot)) {
          fs.rmSync(projRoot, { recursive: true, force: true });
        }
      } catch (_) {}
      delete a.agentProjects[agentName]; dirty = true;
    }
    if (dirty) writeAppSettings(a);
    return { ok: true, items: listAgentNames() };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 给某个 Agent 设置/清除用户自定义显示名(只存映射,不改 .md 本体)
ipcMain.handle('data:renameAgent', (_e, { file, displayName }) => {
  try {
    const f = path.basename(String(file || ''));
    const a = readAppSettings();
    if (!a.agentNames) a.agentNames = {};
    const dn = String(displayName || '').trim();
    if (dn) a.agentNames[f] = dn.slice(0, 40);
    else delete a.agentNames[f];   // 清空 = 恢复默认名
    writeAppSettings(a);
    return { ok: true, items: listAgentNames() };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('data:removeSkill', (_e, { name }) => {
  try {
    const p = path.join(SKILLS_DIR, path.basename(String(name || '')));
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    return { ok: true, items: listSkillNames() };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator:技能生命周期(遥测 + 状态 + 手动归档/恢复/置顶)
//   遥测(用量/最近使用)从 transcript 现算;状态(stale/archived/pinned/firstSeen)存 sidecar。
//   只标记不自动归档:状态机最多把 active↔stale,archive/restore 由用户在 UI 触发。
// ─────────────────────────────────────────
const SKILL_USAGE_FILE = () => path.join(SKILLS_DIR, '.usage.json');
const SKILL_ARCHIVE_DIR = () => path.join(SKILLS_DIR, '.archive');
const STALE_DAYS_DEFAULT = 30;

function readSkillUsage() {
  try {
    const f = SKILL_USAGE_FILE();
    if (!fs.existsSync(f)) return {};
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { console.warn('[curator] skill-usage 读取失败: %s', e.message); return {}; }
}
function writeSkillUsage(data) {
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const f = SKILL_USAGE_FILE();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    fs.renameSync(tmp, f);
  } catch (e) { console.error('[curator] sidecar 写入失败:', e.message); }
}
function getStaleDays() {
  const v = parseInt(readAppSettings().skillStaleDays, 10);
  return Number.isFinite(v) && v >= 1 ? v : STALE_DAYS_DEFAULT;
}

// 已安装(非归档)技能名集合
function installedSkillSet() {
  return new Set(listSkillNames().map((s) => s.name));
}
// 归档区技能名列表
function listArchivedSkillNames() {
  try {
    return fs.readdirSync(SKILL_ARCHIVE_DIR(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (e) { console.warn('[curator] 归档区读取失败: %s', e.message); return []; }
}

// 确定性状态机:对每个已安装技能,按 anchor(最近使用‖首见)判 active/stale。绝不自动归档。
//   返回 { sidecar(已更新), usage(派生用量 Map) }。会落盘 sidecar(补 firstSeen / 改 state)。
function applySkillTransitions(
  now = Date.now(),
  usage = new Map(),
  usageReady = false,
  installed = installedSkillSet(),
  archived = new Set(listArchivedSkillNames()),
) {
  const sidecar = readSkillUsage();
  const staleMs = getStaleDays() * 24 * 60 * 60 * 1000;
  const nowIso = new Date(now).toISOString();
  let dirty = false;

  for (const name of installed) {
    let rec = sidecar[name];
    if (!rec || typeof rec !== 'object') {
      // 首次见到 → 锚定 firstSeen=now,本轮按 active,不立刻判 stale(防新导入的被误标)
      rec = { state: 'active', pinned: false, firstSeenAt: nowIso, archivedAt: null };
      sidecar[name] = rec; dirty = true;
      continue;
    }
    if (!usageReady) continue;                // 首次增量索引未完成前，不用“0 次”误判旧技能为闲置
    if (rec.pinned) continue;                 // 置顶:跳过一切自动转换
    if (rec.state === 'archived') continue;   // 归档态由 restore 显式改回

    const u = usage.get(name);
    const anchorIso = (u && u.lastUsedAt) || rec.firstSeenAt || nowIso;
    const anchorMs = Date.parse(anchorIso);
    const idle = Number.isFinite(anchorMs) ? (now - anchorMs) : 0;

    if (idle >= staleMs && rec.state !== 'stale') { rec.state = 'stale'; dirty = true; }
    else if (idle < staleMs && rec.state === 'stale') { rec.state = 'active'; dirty = true; }
  }

  // 清理 sidecar 里既不在已安装、也不在归档区的孤儿条目(技能被彻底删除后)
  for (const name of Object.keys(sidecar)) {
    if (!installed.has(name) && !archived.has(name)) { delete sidecar[name]; dirty = true; }
  }

  if (dirty) writeSkillUsage(sidecar);
  return { sidecar, usage };
}

// 技能总览:跑一次状态机,返回每个已安装技能的用量+状态 + 归档列表 + 当前阈值
ipcMain.handle('skills:overview', (_e, { refresh = true } = {}) => {
  try {
    const now = Date.now();
    const usageState = loadSkillUsageState();
    const usage = usageState.map;
    const skillList = listSkillNames();
    const archivedNames = listArchivedSkillNames();
    const { sidecar } = applySkillTransitions(
      now,
      usage,
      usageState.ready,
      new Set(skillList.map((skill) => skill.name)),
      new Set(archivedNames),
    );
    const items = skillList.map((s) => {
      const rec = sidecar[s.name] || {};
      const u = usage.get(s.name) || { useCount: 0, lastUsedAt: null };
      return {
        name: s.name,
        callName: s.callName || s.name,
        desc: s.desc || '',
        displayName: s.displayName || s.name,
        summary: s.summary || s.desc || '',
        defaultPrompt: s.defaultPrompt || '',
        useCount: u.useCount || 0,
        lastUsedAt: u.lastUsedAt || null,
        state: rec.state || 'active',
        pinned: !!rec.pinned,
        createdBy: rec.createdBy || null,   // 'agent'=对话自动提炼生成;null=用户手动导入
      };
    });
    // 归档区直接复用同一份持久化聚合结果，不再触发第二次 transcript 扫描。
    const archived = archivedNames.map((name) => {
      const rec = sidecar[name] || {};
      const u = usage.get(name) || { useCount: 0, lastUsedAt: null };
      return { name, useCount: u.useCount || 0, lastUsedAt: u.lastUsedAt || null, archivedAt: rec.archivedAt || null };
    });
    if (refresh) refreshSkillUsageInBackground();
    return {
      ok: true,
      items,
      archived,
      staleDays: getStaleDays(),
      dir: SKILLS_DIR,
      usageReady: usageState.ready,
      usageRefreshing: !!_skillUsageRefreshPromise,
    };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 历史技能迁移：只补没有 agents/relay.yaml 的已安装 Skill。
// 由技能设置页打开后在后台触发，不放进 Relay 启动链路；同一时刻只跑一批，
// 页面反复进入也会复用同一个 Promise，不重复消耗模型。
let skillMetadataBackfillPromise = null;
ipcMain.handle('skills:backfillMetadata', async () => {
  if (skillMetadataBackfillPromise) return skillMetadataBackfillPromise;
  const pending = [];
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillDir = path.join(SKILLS_DIR, entry.name);
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
      if (fs.existsSync(path.join(skillDir, 'agents', 'relay.yaml'))) continue;
      pending.push(skillDir);
    }
  } catch (e) {
    return { ok: false, message: e.message, total: 0 };
  }
  if (!pending.length) return { ok: true, total: 0, llmCount: 0, fallbackCount: 0 };
  skillMetadataBackfillPromise = (async () => {
    const result = await generateImportedSkillPresentations(pending);
    return { ok: true, total: pending.length, ...result };
  })();
  try {
    return await skillMetadataBackfillPromise;
  } finally {
    skillMetadataBackfillPromise = null;
  }
});

// 置顶/取消置顶(只改 sidecar)
ipcMain.handle('skills:pin', (_e, { name, pinned } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n) return { ok: false, message: '技能名为空' };
    const sidecar = readSkillUsage();
    const rec = sidecar[n] || { state: 'active', pinned: false, firstSeenAt: new Date().toISOString(), archivedAt: null };
    rec.pinned = !!pinned;
    sidecar[n] = rec;
    writeSkillUsage(sidecar);
    return { ok: true, pinned: rec.pinned };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 归档:把技能目录移到 .archive/(移动而非删除,可恢复)
ipcMain.handle('skills:archive', (_e, { name } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
    const src = path.join(SKILLS_DIR, n);
    if (!fs.existsSync(src)) return { ok: false, message: '技能不存在' };
    fs.mkdirSync(SKILL_ARCHIVE_DIR(), { recursive: true });
    const dest = path.join(SKILL_ARCHIVE_DIR(), n);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });   // 归档区同名残留先清
    // 跨设备兜底:rename 失败则 copy+rm
    try { fs.renameSync(src, dest); }
    catch (_) { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    const sidecar = readSkillUsage();
    const rec = sidecar[n] || { firstSeenAt: new Date().toISOString(), pinned: false };
    rec.state = 'archived'; rec.archivedAt = new Date().toISOString();
    sidecar[n] = rec;
    writeSkillUsage(sidecar);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 恢复:从 .archive/ 移回;同名已存在则拒绝(不覆盖用户现有技能)
ipcMain.handle('skills:restore', (_e, { name } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
    const src = path.join(SKILL_ARCHIVE_DIR(), n);
    if (!fs.existsSync(src)) return { ok: false, message: '归档中无此技能' };
    const dest = path.join(SKILLS_DIR, n);
    if (fs.existsSync(dest)) return { ok: false, message: '已存在同名技能，恢复取消（避免覆盖）' };
    try { fs.renameSync(src, dest); }
    catch (_) { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    const sidecar = readSkillUsage();
    const rec = sidecar[n] || { firstSeenAt: new Date().toISOString(), pinned: false };
    rec.state = 'active'; rec.archivedAt = null;
    sidecar[n] = rec;
    writeSkillUsage(sidecar);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 永久删除归档技能：只允许删除 .archive 下的直接子目录，并同步清理生命周期 sidecar。
ipcMain.handle('skills:deleteArchived', (_e, { name } = {}) => {
  try {
    const n = path.basename(String(name || ''));
    if (!n || n.startsWith('.')) return { ok: false, message: '非法技能名' };
    const archivedRoot = path.resolve(SKILL_ARCHIVE_DIR());
    const target = path.resolve(archivedRoot, n);
    const relative = path.relative(archivedRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, message: '非法归档路径' };
    }
    if (!fs.existsSync(target)) return { ok: false, message: '归档中无此技能' };
    fs.rmSync(target, { recursive: true, force: true });
    const sidecar = readSkillUsage();
    if (sidecar[n]) {
      delete sidecar[n];
      writeSkillUsage(sidecar);
    }
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 设置"闲置"阈值天数(存 app-settings)
ipcMain.handle('skills:setStaleDays', (_e, { days } = {}) => {
  try {
    const v = parseInt(days, 10);
    if (!Number.isFinite(v) || v < 1) return { ok: false, message: '天数非法' };
    const a = readAppSettings();
    a.skillStaleDays = Math.min(v, 3650);
    writeAppSettings(a);
    return { ok: true, staleDays: a.skillStaleDays };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator 二期:技能自动生成(方案 B 全自动)
//   每 N 轮对话后,后台 spawn 一个 claude -p 回看刚结束的对话,判断有没有值得固化成技能的经验,
//   有就直接在 ~/.claude/skills 写/改 SKILL.md。新生成的技能标 createdBy:agent,交一期 Curator 管理。
//   prompt 改写自 Hermes agent/background_review.py 的 _SKILL_REVIEW_PROMPT。
// ─────────────────────────────────────────
const REVIEW_DEFAULT_EVERY = 6;

// 中文版技能 review 指令(要点照搬 Hermes:积极但别造碎技能、优先 patch 已有/伞技能、类级命名、
//   不要把环境性失败固化成约束、没值得学的就停)。对话正文由调用方拼在末尾。
const SKILL_REVIEW_PROMPT = [
  '你现在作为后台「技能策展」在运行:回看下面这段刚结束的对话,判断有没有值得沉淀进技能库的经验,有就更新技能库。',
  '',
  '技能库目录(已授权你读写,绝对路径):' + SKILLS_DIR + '。在这个目录下操作技能,每个技能是一个子目录,内含 SKILL.md(带 YAML frontmatter:name/description,description 一句话、说清这个技能"做什么、什么时候用")。',
  '',
  '要积极,但只在真有料时动手。命中下面任一信号就该更新:',
  '· 用户纠正了你的风格/语气/格式/啰嗦程度(如「别这么啰嗦」「别这样排版」「直接给答案」「你总是…我不喜欢」)——把这条偏好写进相关技能,让下次开局就照做。',
  '· 用户纠正了你的工作流/步骤/顺序——把纠正作为一条 pitfall 或明确步骤写进管这类任务的技能。',
  '· 冒出了一个非平凡的技巧/修复/绕过办法/调试路径/工具用法,以后同类任务用得上——固化它。',
  '· 这次用到的某个技能被发现是错的/缺步骤/过时了——立刻 patch 它。',
  '',
  '动作优先级(选最靠前、能套上的那个):',
  '1. 改一个已存在的相关技能(patch):新经验落在它覆盖的范围内,就扩它——加一节、加一条 pitfall、放宽触发描述。优先这个。',
  '2. 新建一个「类级」技能:没有现成技能覆盖这一类任务时才新建。名字必须是类级的,不能是某次任务的专名(不要带具体报错串、某个功能代号、「修复X」「调试Y」「今天的Z」这种一次性命名)。如果想出来的名字只有今天这次任务才说得通,那就是错的——退回去走 1。',
  '',
  '坚决不要固化的东西(否则会变成日后反咬自己的死规矩):',
  '· 环境性失败:缺二进制、全新安装的报错、迁移后路径不对、command not found、凭证没配、包没装。这些用户能修,不是长期规律。',
  '· 关于工具/能力的负面断言(「浏览器工具用不了」「X 工具是坏的」)——这种会硬化成几个月后模型拿来拒绝自己的借口,哪怕那时问题早修好了。如果是 setup 状态导致的失败,要固化就固化「修复办法」(装什么、配什么),绝不固化「这工具不能用」。',
  '· 只在本次会话里有意义的一次性叙事(「总结今天的行情」「分析这个 PR」不是一类值得建技能的工作)。',
  '',
  '硬规则:',
  '· 用 Write/Edit/Read 工具直接在上面那个技能目录里建/改文件。新建技能就建 <技能名>/SKILL.md。',
  '· 一次最多动 1~2 个技能,不要刷一堆。',
  '· description 要精炼准确(它会被用来检索这个技能)。',
  '· 如果这次对话平顺、没有纠正、也没冒出新技巧——就直接回一句「无需更新」然后停下,不要硬凑。',
  '',
  '下面是这次对话的内容:',
  '',
].join('\n');

let reviewInflight = false;   // 并发护栏:同时只允许一个 review 在跑

// 后台跑一次技能 review。fire-and-forget;不串聊天 UI 事件、不计入 MAX_PARALLEL_JOBS。
function runSkillReviewJob({ conversationText, workingDir } = {}) {
  if (reviewInflight) { console.log('[skill-review] 上一次 review 仍在跑,跳过本次'); return; }
  const text = String(conversationText || '').trim();
  if (!text) return;

  reviewInflight = true;
  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch (_) {}
  // 跑前快照现有技能名(用于完成后 diff 出新生成的技能 → 标 createdBy:agent)
  const beforeSet = new Set(listSkillNames().map((s) => s.name));

  // review 在技能目录里跑(cwd),工作目录无关紧要;给个稳定 cwd 即可
  const cwd = (workingDir && fs.existsSync(workingDir)) ? workingDir : SKILLS_DIR;

  // 输出静默消费(不串聊天 UI);只在结束时看有没有新技能。
  //   仅授权技能目录写权限(不挂记忆/工作目录/cron);90s 硬超时防模型卡死。
  claudeSdk.runText({
    prompt: SKILL_REVIEW_PROMPT + text,
    cwd,
    model: 'haiku',                       // review 走 haiku 档(用户选定;出问题再调)
    permissionMode: 'bypassPermissions',  // 后台无人值守,自动放行(只授权了技能目录)
    additionalDirectories: [SKILLS_DIR],
    timeoutMs: 90000,
  }).then(() => {
    reviewInflight = false;
    // diff:跑后新出现的技能 = 自动生成的
    let created = [];
    try {
      const afterSet = new Set(listSkillNames().map((s) => s.name));
      created = [...afterSet].filter((n) => !beforeSet.has(n));
    } catch (e) { console.warn('[skill-review] 检测新技能失败: %s', e.message); }
    if (created.length) {
      // 标 createdBy:agent + firstSeenAt,衔接一期 Curator
      try {
        const sidecar = readSkillUsage();
        const nowIso = new Date().toISOString();
        for (const n of created) {
          const rec = sidecar[n] || { state: 'active', pinned: false, archivedAt: null };
          rec.createdBy = 'agent';
          if (!rec.firstSeenAt) rec.firstSeenAt = nowIso;
          sidecar[n] = rec;
        }
        writeSkillUsage(sidecar);
      } catch (e) { console.warn('[skill-review] 更新技能元数据失败: %s', e.message); }
      // 轻量通知,让用户知道发生了什么(全自动但不黑箱)
      try {
        if (Notification.isSupported()) {
          new Notification({ title: 'Relay 自动提炼了技能', body: '从对话中新增技能：' + created.join('、'), icon: APP_ICON || undefined }).show();
        }
      } catch (e) { console.warn('[skill-review] 通知显示失败: %s', e.message); }
      console.log('[skill-review] 新增技能:', created.join(', '));
    } else {
      console.log('[skill-review] 本次无新增技能');
    }
  }).catch((e) => {
    reviewInflight = false;
    console.error('[skill-review] 执行出错:', e && e.message);
  });
}

// 读/写 二期配置(总开关 + 频率)
function getReviewConfig() {
  const a = readAppSettings();
  const every = parseInt(a.skillReviewEveryTurns, 10);
  return {
    enabled: a.skillAutoReview !== false,   // 默认开
    everyTurns: (Number.isFinite(every) && every >= 1) ? every : REVIEW_DEFAULT_EVERY,
  };
}

// renderer 在 finishRun 里每 N 轮调它(已在 renderer 侧判好节奏/排除条件,这里只管跑)
ipcMain.handle('skills:autoReview', (_e, { conversationText, workingDir } = {}) => {
  try {
    if (!getReviewConfig().enabled) return { ok: false, skipped: 'disabled' };
    runSkillReviewJob({ conversationText, workingDir });
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('skills:getReviewConfig', () => ({ ok: true, ...getReviewConfig() }));
ipcMain.handle('skills:setReviewConfig', (_e, { enabled, everyTurns } = {}) => {
  try {
    const a = readAppSettings();
    if (enabled !== undefined) a.skillAutoReview = !!enabled;
    if (everyTurns !== undefined) {
      const v = parseInt(everyTurns, 10);
      if (Number.isFinite(v) && v >= 1) a.skillReviewEveryTurns = Math.min(v, 100);
    }
    writeAppSettings(a);
    return { ok: true, ...getReviewConfig() };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// Curator 三期:LLM 伞状合并体检(全自动 + 定时 + opus)
//   定时让 opus 通览技能库,把同类碎技能合并成类级大技能、归档过时的。作为一个 builtin chat
//   定时任务跑(workingDir=SKILLS_DIR → runClaudeJob 自动 --add-dir 授权 + cwd 在技能目录)。
//   prompt 改写自 Hermes agent/curator.py 的 CURATOR_REVIEW_PROMPT(umbrella-building pass)。
// ─────────────────────────────────────────
const SKILL_CURATOR_PROMPT_HEAD = [
  '你现在作为后台「技能库策展员」在运行。这是一次「伞状合并」整理,不是被动审计、也不是简单查重。',
  '',
  '技能库就在你当前的工作目录。每个子目录是一个技能,内含 SKILL.md(YAML frontmatter:name/description)+ 可选的 references/ templates/ scripts/ assets/ 子文件。所有操作都用相对路径在当前目录里进行。',
  '',
  '目标:技能库应该是一批「类级」的大技能(每个 SKILL.md 内容丰富 + 用子文件装一次性细节),而不是几百个「一次会话一个 bug」的窄技能。检索技能是按 description 匹配的——一个带多个小节的大伞技能,比五个名字相近的窄兄弟更好找。',
  '',
  '判据(关键):不要问「这两个像不像」,要问「一个人类维护者会把这些写成 N 个独立技能,还是 1 个带 N 个小节的大技能?」——答案是后者,就合并。「每个技能触发场景不同」不是保留的理由,而是把它作为大技能的一个小节的理由。',
  '',
  '三种合并手法(按簇选合适的):',
  '① 并入已有伞技能:某个技能已经够大够通用 → 用 Edit 给它加一节(吸收兄弟的独特点),然后把兄弟归档。',
  '② 新建伞技能:没有现成的够大 → 用 Write 建一个类级 <伞名>/SKILL.md 覆盖这一类的共同流程 + 短小节,然后把被吸收的窄兄弟归档。',
  '③ 降级成子文件:某个窄技能有"窄但有价值"的一次性内容 → 把它搬进伞技能的 references/<主题>.md(一次性细节/知识)、templates/<名>(可复制的样板)、scripts/<名>(可直接跑的脚本),然后归档原技能。',
  '',
  '硬规则(必须遵守):',
  '1. 归档 = 用 Bash 工具把技能目录 mv 进 .archive/ 子目录(mkdir -p .archive 再 mv)。绝对不要 rm 删除任何技能——归档可恢复,删除不可逆。',
  '2. 绝对不要碰 pinned 列表里的技能(下面会列出)——跳过它们,既不合并也不归档。',
  '3. 绝对不要碰 . 开头的东西(.archive、.usage.json 等是元数据,不是技能)。',
  '4. 包完整性:某个技能带 references/ templates/ scripts/ assets/ 子文件、或 SKILL.md 里有指向这些的相对链接时,不要只把它的 SKILL.md 拍扁塞进别人的 references。三选一:要么整体保留为独立技能、要么连子文件一起搬进伞技能对应目录并改写路径、要么整包原样归档。绝不能留下指向"已被搬走的旧目录"的死链接。',
  '5. 名字太窄的技能(带 PR 号、某个报错串、功能代号、"fix-X/debug-Y/今天的Z"这种一次性命名)几乎都该作为某个伞技能的小节或子文件,而不是独立技能。',
  '6. 稳健:每次只处理你有把握的簇。拿不准是否该合并的,保持原样别动。技能数量很少时(比如就两三个、彼此无关),直接保持现状、什么都不做也是对的。',
  '',
  '做完后,在回复末尾输出一段结构化 YAML(给系统善后用),格式严格如下:',
  '```yaml',
  'consolidations:',
  '  - from: <被合并掉的技能名>',
  '    into: <合并进的伞技能名>',
  '    reason: <一句话:为什么合,不要只写"相似">',
  'prunings:',
  '  - name: <纯归档、无合并目标的技能名>',
  '    reason: <一句话:为什么归档>',
  '```',
  '凡是你 mv 进 .archive/ 的技能,必须出现在上面两个列表之一。没有就留空列表(consolidations: [])。这段 YAML 放在你给人看的总结之后。',
  '',
].join('\n');

// 拼最终体检 prompt:头部规则 + 当前技能清单(名字/描述/pinned)。清单由 main 现算(自包含,不靠模型 ls)。
function buildSkillCuratorPrompt() {
  let listText = '', count = 0;
  try {
    const sidecar = readSkillUsage();
    const skills = listSkillNames();
    count = skills.length;
    if (!skills.length) {
      listText = '(技能库目前是空的,无需整理。直接回复「技能库为空,无需整理」并停止。)';
    } else {
      listText = skills.map((s) => {
        const pinned = sidecar[s.name] && sidecar[s.name].pinned ? '  [PINNED-跳过]' : '';
        const desc = (s.desc || '').slice(0, 120);
        return `· ${s.name}${pinned}\n    ${desc}`;
      }).join('\n');
    }
  } catch (e) { console.warn('[curator] 读取技能清单失败: %s', e.message); listText = '(读取技能清单失败,请你自己用 Bash ls 看当前目录)'; }
  return SKILL_CURATOR_PROMPT_HEAD + '当前已安装技能清单(共 ' + count + ' 个):\n\n' + listText;
}

// 体检跑之前的技能名快照,用于完成后 diff 出"真正新建的伞技能"(区别于预先存在但没进 sidecar 的用户技能)。
let curatorBeforeSnapshot = null;
// scheduler 在 builtin=skill-curator 任务【开始前】回调(deps.onSkillCuratorStart),拍快照。
function snapshotSkillsBeforeCurator() {
  try { curatorBeforeSnapshot = new Set(listSkillNames().map((s) => s.name)); }
  catch (e) { console.warn('[curator] 快照技能列表失败: %s', e.message); curatorBeforeSnapshot = null; }
}

// 体检任务跑完后善后:把被 mv 进 .archive/ 的技能在 sidecar 里标 archived;真正新建的伞技能标 createdBy:agent。
//   由 scheduler 在 builtin=skill-curator 任务完成后回调(deps.onSkillCuratorDone)。返回 diff 概要供通知。
function reconcileSkillSidecarFromArchive() {
  const summary = { newlyArchived: [], newSkills: [] };
  try {
    const sidecar = readSkillUsage();
    const installed = new Set(listSkillNames().map((s) => s.name));
    const archived = new Set(listArchivedSkillNames());
    const nowIso = new Date().toISOString();
    let dirty = false;

    // 归档区里、但 sidecar 还没标 archived 的 → 标上(体检 mv 进去的)
    for (const name of archived) {
      const rec = sidecar[name] || { pinned: false, firstSeenAt: nowIso, createdBy: null };
      if (rec.state !== 'archived') {
        rec.state = 'archived';
        rec.archivedAt = rec.archivedAt || nowIso;
        sidecar[name] = rec;
        summary.newlyArchived.push(name);
        dirty = true;
      }
    }
    // 技能库里 sidecar 没记录的 → 补一条基础记录(firstSeenAt)。
    //   注意:不能在这里推断 createdBy:agent——预先存在但从没进过 sidecar 的"用户技能"也会落到这里,
    //   误标成自动生成就把用户的技能冤枉了。createdBy:agent 只在「确实是体检/二期 review 新建」时由
    //   带快照的路径标(二期 runSkillReviewJob 用 before/after diff 标;体检的 before 快照见下)。
    for (const name of installed) {
      if (!sidecar[name]) {
        const isNew = curatorBeforeSnapshot && !curatorBeforeSnapshot.has(name);
        sidecar[name] = { state: 'active', pinned: false, firstSeenAt: nowIso, archivedAt: null, createdBy: isNew ? 'agent' : null };
        if (isNew) summary.newSkills.push(name);
        dirty = true;
      }
    }
    if (dirty) writeSkillUsage(sidecar);
    // 体检只改变技能文件，不改变历史 transcript；现有用量索引继续有效。
  } catch (e) { console.error('[skill-curator] reconcile 失败:', e.message); }

  // 完成通知
  try {
    const nA = summary.newlyArchived.length, nN = summary.newSkills.length;
    if ((nA || nN) && Notification.isSupported()) {
      const parts = [];
      if (nN) parts.push('合并/新建 ' + nN + ' 个伞技能');
      if (nA) parts.push('归档 ' + nA + ' 个');
      new Notification({ title: '技能库体检完成', body: parts.join('、') || '无变化', icon: APP_ICON || undefined }).show();
    }
  } catch (e) { console.warn('[curator] 善后处理失败: %s', e.message); }
  return summary;
}

// 技能目录路径(renderer 建体检任务时需要,塞进 action.workingDir)
ipcMain.handle('skills:getDir', () => ({ ok: true, dir: SKILLS_DIR }));
// 体检 prompt(renderer 建体检任务时取,塞进 action.prompt;现算以带上最新技能清单)
ipcMain.handle('skills:curatorPrompt', () => ({ ok: true, prompt: buildSkillCuratorPrompt() }));

// 点击导入区时只负责选择文件；真正开始安装后 renderer 才切换“正在安装”状态。
ipcMain.handle('data:pickImportZip', async (_e, { kind } = {}) => {
  if (kind !== 'agent' && kind !== 'skill') return { ok: false, message: '未知安装包类型' };
  const r = await dialog.showOpenDialog({
    title: kind === 'skill' ? '选择技能包 (.zip)' : '选择 Agent 包 (.zip)',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

// 选取或拖入 zip → 解压 → 自动安装到对应目录(kind: 'agent' | 'skill')。
// zipPath 只用于 renderer 通过 webUtils 取得的拖放文件；未传时仍打开系统文件选择器。
ipcMain.handle('data:importZip', async (_e, { kind, zipPath } = {}) => {
  if (kind !== 'agent' && kind !== 'skill') return { ok: false, message: '未知安装包类型' };
  let zip = String(zipPath || '').trim();
  if (!zip) {
    const r = await dialog.showOpenDialog({
      title: kind === 'skill' ? '选择技能包 (.zip)' : '选择 Agent 包 (.zip)',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    zip = r.filePaths[0];
  }
  if (path.extname(zip).toLowerCase() !== '.zip') return { ok: false, message: '仅支持 .zip 安装包' };
  try {
    if (!fs.statSync(zip).isFile()) return { ok: false, message: '安装包不是有效文件' };
  } catch (_) {
    return { ok: false, message: '安装包不存在或无法访问' };
  }
  let temp;
  try {
    temp = await unzipToTemp(zip);
    const root = findContentRoot(temp);
    if (kind === 'agent') {
      // 统一把包里所有 Agent 定义(.md)收集进 ~/.claude/agents。
      //   兼容三种包形态:① 完整包(含 .claude/agents/*.md)② 松散 .md ③ 直接一个 .md。
      //   优先取 .claude/agents 下的(那才是真正的子智能体定义),否则退而取所有 .md。
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      const claudeAgentsDir = path.join(root, '.claude', 'agents');
      let mds = [];
      if (fs.existsSync(claudeAgentsDir)) {
        mds = fs.readdirSync(claudeAgentsDir)
          .filter((n) => n.toLowerCase().endsWith('.md'))
          .map((n) => path.join(claudeAgentsDir, n));
      } else {
        (function findMd(d) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === '__MACOSX') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) findMd(p);
            else if (e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') mds.push(p);
          }
        })(root);
      }
      if (!mds.length) return { ok: false, message: '压缩包里没找到 Agent(.md)文件' };
      // 全局放一份 .md,保证 Relay 的 agent 列表能发现 + 能触发(子智能体 id 由 frontmatter.name 决定)
      for (const m of mds) fs.copyFileSync(m, path.join(AGENTS_DIR, path.basename(m)));

      // ── 项目级支持:把【整包】铺到固定项目根,并记录 agentName→项目根 映射 ──
      //   feature-dev 这类 agent 运行时会 `cat knowledge/xxx`(相对 cwd 的路径),
      //   只复制 .md 到全局会丢掉 knowledge/ 等同级资源 → 跑到一半读不到文件。
      //   故把整包原样铺到 ~/.claude/relay-agents/<agentName>/,运行时(claude:run)
      //   在用户没指定工作目录时自动把 cwd 设为该项目根,等价于 CLI 的项目级用法。
      //   判定"完整包":包里除 .claude/ 外还有别的资源(如 knowledge/、CLAUDE.md)。
      const hasExtraResources = fs.readdirSync(root, { withFileTypes: true })
        .some((e) => e.name !== '.claude' && e.name !== '__MACOSX' && e.name !== '.DS_Store'
          && e.name.toLowerCase() !== 'readme.md');
      if (hasExtraResources) {
        const appCfg = readAppSettings();
        if (!appCfg.agentProjects) appCfg.agentProjects = {};   // { agentName → 项目根绝对路径 }
        const projBase = path.join(os.homedir(), '.claude', 'relay-agents');
        fs.mkdirSync(projBase, { recursive: true });
        for (const m of mds) {
          let agentName = '';
          try { agentName = (parseFrontmatter(fs.readFileSync(m, 'utf8')).name || '').trim(); } catch (_) {}
          if (!agentName) agentName = path.basename(m).replace(/\.md$/i, '');
          // 每个 agent 一个项目根;同名重复导入则覆盖
          const projRoot = path.join(projBase, agentName.replace(/[\\/:*?"<>|]/g, '_'));
          fs.rmSync(projRoot, { recursive: true, force: true });
          fs.cpSync(root, projRoot, { recursive: true, force: true });
          appCfg.agentProjects[agentName] = projRoot;
        }
        writeAppSettings(appCfg);
      }

      // 若包里同时带技能(.claude/skills/*),顺手一起导入到全局技能目录
      const pkgSkills = path.join(root, '.claude', 'skills');
      let skillNote = '';
      if (fs.existsSync(pkgSkills)) {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        let sc = 0;
        const importedSkillDirs = [];
        for (const e of fs.readdirSync(pkgSkills, { withFileTypes: true })) {
          if (e.isDirectory()) {
            const dest = path.join(SKILLS_DIR, e.name);
            fs.cpSync(path.join(pkgSkills, e.name), dest, { recursive: true, force: true });
            importedSkillDirs.push(dest);
            sc++;
          }
        }
        if (sc) {
          const meta = await generateImportedSkillPresentations(importedSkillDirs);
          skillNote = `，并附带 ${sc} 个技能`;
          if (meta.fallbackCount) skillNote += `（${meta.fallbackCount} 个使用原始说明）`;
        }
      }
      return { ok: true, message: `已导入 ${mds.length} 个 Agent${skillNote}`, items: listAgentNames() };
    }
    // skill
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const dirs = findDirsWithFile(root, 'SKILL.md', 3);
    if (!dirs.length) return { ok: false, message: '压缩包里没找到技能(缺少 SKILL.md)' };
    let count = 0;
    const importedSkillDirs = [];
    for (const d of dirs) {
      // SKILL.md 直接在解压根(无文件夹包裹)→ 用 zip 名;否则用所在文件夹名
      const name = (d === temp) ? path.basename(zip, path.extname(zip)) : path.basename(d);
      const dest = path.join(SKILLS_DIR, name);
      fs.cpSync(d, dest, { recursive: true, force: true });
      importedSkillDirs.push(dest);
      count++;
    }
    const meta = await generateImportedSkillPresentations(importedSkillDirs);
    const metaNote = meta.fallbackCount
      ? `；${meta.fallbackCount} 个中文摘要生成失败，已使用原始说明`
      : '，中文标题与摘要已生成';
    return { ok: true, message: `已导入 ${count} 个技能${metaNote}`, items: listSkillNames() };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  } finally {
    if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {} }
  }
});

// ─────────────────────────────────────────
// IPC: 长期记忆库管理(数据中心「记忆」标签页用)
// ─────────────────────────────────────────
//   记忆由模型在对话里自读自写(见 buildMemoryHint);这组 IPC 仅供用户在 UI 里
//   查看 / 编辑 / 删除 / 打开文件夹,让记下的内容可审计、可纠正。
//   安全:所有按文件名的操作都用 memoryFileAbs 做路径越权防护,只允许操作 MEMORY_DIR 内的 .md。

// 把传入的文件名收敛为 MEMORY_DIR 内的合法 .md 绝对路径;越权/非 .md 返回 null。
function memoryFileAbs(file) {
  const base = path.basename(String(file || ''));          // 砍掉任何目录成分
  if (!base || !base.toLowerCase().endsWith('.md')) return null;
  const abs = path.resolve(MEMORY_DIR, base);
  const rel = path.relative(MEMORY_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;  // 不能跳出记忆库
  return abs;
}

// 列出所有记忆条目(MEMORY.md 自身除外):名称 + frontmatter 摘要,按修改时间倒序。
ipcMain.handle('memory:list', () => {
  try {
    if (!fs.existsSync(MEMORY_DIR)) return { ok: true, items: [], dir: MEMORY_DIR, hasIndex: false };
    const items = fs.readdirSync(MEMORY_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'memory.md')
      .map((e) => {
        const p = path.join(MEMORY_DIR, e.name);
        let fm = {}, mtime = 0;
        try { fm = parseFrontmatter(fs.readFileSync(p, 'utf8')); } catch (_) {}
        try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
        return {
          file: e.name,
          name: fm.name || e.name.replace(/\.md$/i, ''),
          description: fm.description || '',
          type: fm.type || '',
          mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items, dir: MEMORY_DIR, hasIndex: fs.existsSync(MEMORY_INDEX) };
  } catch (e) { return { ok: false, items: [], error: e.message }; }
});

// 读单条记忆原文(也用于读 MEMORY.md:传 file='MEMORY.md')
ipcMain.handle('memory:read', (_e, file) => {
  try {
    const abs = memoryFileAbs(file);
    if (!abs) return { ok: false, message: '非法文件名' };
    if (!fs.existsSync(abs)) return { ok: false, message: '文件不存在' };
    return { ok: true, file: path.basename(abs), content: fs.readFileSync(abs, 'utf8').replace(/^﻿/, '') };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 写单条记忆(UTF-8 无 BOM 原子写)。file 不存在则新建,存在则覆盖。
//   写的是正文 .md → 落盘后重建索引(#1);写的是 MEMORY.md 本身 → 忽略(索引是派生的,
//   不该手编;下次注入会从各 .md 重新生成,这里不写以免误导用户以为能手改索引)。
ipcMain.handle('memory:write', (_e, { file, content } = {}) => {
  try {
    const abs = memoryFileAbs(file);
    if (!abs) return { ok: false, message: '非法文件名(须为 .md)' };
    if (path.basename(abs).toLowerCase() === 'memory.md') {
      return { ok: false, message: '索引(MEMORY.md)由系统自动维护,无需手动编辑。改记忆请编辑对应的 .md 文件。' };
    }
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(String(content == null ? '' : content), 'utf8'));
    fs.renameSync(tmp, abs);
    rebuildMemoryIndex();   // #1:正文变了,索引随即重建(去重/补全/排序)
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 删除单条记忆 → 删完重建索引,对应索引行自动消失(根治孤儿索引行)。
ipcMain.handle('memory:remove', (_e, file) => {
  try {
    const abs = memoryFileAbs(file);
    if (!abs) return { ok: false, message: '非法文件名' };
    if (path.basename(abs).toLowerCase() === 'memory.md') {
      return { ok: false, message: '索引由系统自动维护,不能单独删除。' };
    }
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    rebuildMemoryIndex();   // #1:删了正文,索引里对应行自动清掉
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 在文件管理器打开记忆库目录(没有则先建)
ipcMain.handle('memory:reveal', () => {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    shell.openPath(MEMORY_DIR);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// 在文件管理器中选中某一条记忆；与“打开记忆库”区分，便于从条目菜单直接跳到本地文件。
ipcMain.handle('memory:revealFile', (_e, file) => {
  try {
    const abs = memoryFileAbs(file);
    if (!abs) return { ok: false, message: '非法文件名' };
    if (!fs.existsSync(abs)) return { ok: false, message: '文件不存在' };
    shell.showItemInFolder(abs);
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ─────────────────────────────────────────
// IPC: 首次设置向导 — 调 PS 脚本装 git/node/claude/MCP
// ─────────────────────────────────────────
// PS 脚本和 msi 都在 extra-resources/ 里(dev 时是本地路径,prod 时在 process.resourcesPath)
function getInstallerResourcesDir() {
  // dev 运行:从 __dirname/extra-resources 找
  // prod 运行:electron-builder 把 extraResources 放在 process.resourcesPath/extra-resources
  const candidates = [
    path.join(process.resourcesPath || '', 'extra-resources'),
    path.join(__dirname, 'extra-resources'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

ipcMain.handle('installer:probe', async () => {
  const claudeOk = true;   // 运行时随 Relay 内置,不需要探测也不会缺
  let settingsOk = false;
  let existingKey = '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    existingKey = s.env?.ANTHROPIC_API_KEY || '';
    settingsOk = !!existingKey && !/^\s*$/.test(existingKey);
  } catch {}
  const resourcesDir = getInstallerResourcesDir();
  return {
    claudeOk, settingsOk,
    existingKey,
    claudeVersion: null,
    resourcesDirFound: !!resourcesDir,
    resourcesDir,
  };
});

// 跑安装总编排:spawn powershell 跑 extra-resources/install.ps1,流式 stdout 转发
let installerChild = null;
ipcMain.handle('installer:run', async (event, { apiKey }) => {
  if (installerChild) return { error: '安装正在进行中' };
  const resourcesDir = getInstallerResourcesDir();
  if (!resourcesDir) return { error: '找不到安装资源目录(extra-resources)' };
  const installPs1 = path.join(resourcesDir, 'install.ps1');
  if (!fs.existsSync(installPs1)) return { error: `install.ps1 缺失：${installPs1}` };

  return new Promise((resolve) => {
    const args = [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', installPs1,
      '-ApiKey', apiKey,
      '-SkipPreflight',     // wizard 已经做过自己的探测
      '-AssumeUpgrade',
    ];
    installerChild = spawn('powershell.exe', args, {
      cwd: resourcesDir,
      shell: false,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    installerChild.stdout.setEncoding('utf8');
    installerChild.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) event.sender.send('installer:log', { stream: 'stdout', text: line });
      }
    });
    installerChild.stderr.setEncoding('utf8');
    installerChild.stderr.on('data', (chunk) => {
      event.sender.send('installer:log', { stream: 'stderr', text: chunk });
    });
    installerChild.on('close', (code) => {
      installerChild = null;
      if (stdoutBuf.trim()) event.sender.send('installer:log', { stream: 'stdout', text: stdoutBuf });
      resolve({ exitCode: code, claudeFound: true });   // 运行时内置,不需要装也不会找不到
    });
    installerChild.on('error', (err) => {
      installerChild = null;
      resolve({ error: `powershell spawn 失败: ${err.message}` });
    });
  });
});

ipcMain.handle('installer:abort', () => {
  if (installerChild) {
    try { installerChild.kill('SIGTERM'); } catch {}
    installerChild = null;
    return { aborted: true };
  }
  return { aborted: false };
});

// IPC: 探测环境(Agent 目录是否存在;运行时随 SDK 内置故恒可用)
ipcMain.handle('env:probe', async () => ({
  agentDir: AGENTS_DIR,
  agentDirExists: fs.existsSync(AGENTS_DIR),
  claudeExe: claudeSdk.bundledExecutable(),
  claudeAvailable: true,
  claudeVersion: CLAUDE_RUNTIME_VERSION,
  bundled: true,
}));

// ─────────────────────────────────────────
// IPC: 定时任务（scheduler.js）
// ─────────────────────────────────────────
//   调度器跑在主进程内（复用托盘常驻 + runClaudeJob）。这里只做 IPC 转发 + 启动注入。
function initScheduler() {
  try {
    scheduler.init({
      userDataDir: app.getPath('userData'),
      runClaudeJob,                       // 执行核心（上面抽出的纯函数）
      buildMemoryHint,                    // 长期记忆注入（chat 任务默认只读 'read'，整理任务 'full'）
      generateImage: generateImageCore,   // 定时出图（type=image）复用图像生成核心
      saveConversation,                   // chat/出图结果落历史（v2 目录式:单条写入,不再整库读写）
      loadConversation,                   // 读单条会话（被删→null）：同一任务多次执行复用同一条会话
      readAppSettings, writeAppSettings,  // 开机自启等开关
      refreshTray: refreshTrayMenu,       // 托盘「下一个任务」提示刷新
      getMainWindow: () => mainWindow,    // 推送 sched:update 给 renderer
      onSkillCuratorStart: snapshotSkillsBeforeCurator,      // 技能体检任务开始前拍技能名快照
      onSkillCuratorDone: reconcileSkillSidecarFromArchive,  // 技能体检任务完成后善后 sidecar + 通知
      notify: ({ title, body }) => {
        try {
          if (Notification.isSupported()) {
            new Notification({ title: title || 'Relay', body: body || '', icon: APP_ICON || undefined }).show();
          } else if (tray) {
            tray.displayBalloon({ icon: APP_ICON || undefined, title: title || 'Relay', content: body || '' });
          }
        } catch (_) {}
      },
    });
    console.log('[scheduler] 已启动');
  } catch (e) {
    console.error('[scheduler] 启动失败:', e.message);
  }
}

// 首次创建定时任务时，询问用户是否开启「开机自启」（按决策：不默认偷偷常驻）。
//   只问一次：在 app-settings 记 autostartAsked 标志。返回是否本次弹了询问。
async function maybeAskAutostart() {
  const a = readAppSettings();
  if (a.autostartAsked) return false;
  a.autostartAsked = true;
  writeAppSettings(a);
  try {
    const r = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'question',
      buttons: ['开启开机自启', '暂不开启'],
      defaultId: 0,
      cancelId: 1,
      title: '定时任务',
      message: '让 Relay 开机自动在后台运行？',
      detail: '定时任务只有在 Relay 运行时才会触发。开启「开机自启」后，Relay 会随系统启动并静默到托盘，定时任务更可靠。\n\n若不开启：应用没开着时到点的任务，会在你下次打开 Relay 时补跑一次。\n\n（之后可在 设置 中随时更改。）',
    });
    const enable = r.response === 0;
    setAutoLaunch(enable);
    return true;
  } catch (e) { console.warn('[autostart] 弹窗失败: %s', e.message); return false; }
}

// 设置/取消开机自启（Windows 走注册表 Run 键；--autostart 让启动时静默到托盘）。
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable, args: ['--autostart'] });
    const a = readAppSettings();
    a.autoLaunch = !!enable;
    writeAppSettings(a);
  } catch (e) { console.error('[autostart] 设置失败:', e.message); }
}

ipcMain.handle('sched:list',   () => ({ ok: true, items: scheduler.list() }));
ipcMain.handle('sched:get',    (_e, id) => ({ ok: true, task: scheduler.get(id) }));
ipcMain.handle('sched:create', async (_e, task) => {
  const r = scheduler.create(task);
  // 首个任务创建成功后，问一次开机自启
  try { if (r.ok && scheduler.list().length === 1) await maybeAskAutostart(); } catch (e) { console.warn('[sched] autostart 检查失败: %s', e.message); }
  return r;
});
ipcMain.handle('sched:update', (_e, { id, patch }) => scheduler.update(id, patch));
ipcMain.handle('sched:remove', (_e, id) => scheduler.remove(id));
ipcMain.handle('sched:toggle', (_e, { id, enabled }) => scheduler.toggle(id, enabled));
ipcMain.handle('sched:runNow', async (_e, id) => await scheduler.runNow(id));
ipcMain.handle('sched:runs',   (_e, id) => ({ ok: true, items: scheduler.runs(id) }));
ipcMain.handle('sched:preview', (_e, schedule) => ({ ok: true, times: scheduler.preview(schedule) }));
// 开机自启开关（设置页用）
ipcMain.handle('sched:getAutoLaunch', () => {
  try {
    const s = app.getLoginItemSettings({ args: ['--autostart'] });
    return { ok: true, enabled: !!s.openAtLogin };
  } catch (e) { console.warn('[autostart] 读取注册表失败: %s', e.message); return { ok: true, enabled: !!readAppSettings().autoLaunch }; }
});
ipcMain.handle('sched:setAutoLaunch', (_e, enabled) => { setAutoLaunch(enabled); return { ok: true }; });

// ─────────────────────────────────────────
// Electron 生命周期
// ─────────────────────────────────────────
app.whenReady().then(() => {
  // ⚡ 首屏优先:先建窗(decideStartup 快速路径同步命中即零延迟),其余维护任务全推到窗口之后,
  //   避免同步文件 I/O 在窗口创建前阻塞主线程,导致"按钮要等一下才能点"。
  decideStartup();
  // 两个一次性/幂等迁移推到窗口创建之后的后台跑(不挡首屏;数据量小,延后无副作用)。
  //   migrateHistoryV1 在无旧 history.json 时瞬间 return;migrateScheduledTitles 全量扫历史索引,
  //   故都延后,且后者本就只为洗很久前的 ⏰ 前缀,绝大多数启动无命中。
  setTimeout(() => {
    try { migrateHistoryV1(); } catch (e) { console.warn('[startup] 历史迁移 V1 失败: %s', e.message); }
    try { migrateScheduledTitles(); } catch (e) { console.warn('[startup] 定时标题迁移失败: %s', e.message); }
  }, 800);
  // 启动调度器：延后一拍,让窗口首帧 + 渲染层启动 IPC(settings/brand/history)先走,
  //   scheduler.init 读 schedules.json + 注册 cron 不挤占首屏。错过补跑本就在其内部再延后。
  setTimeout(() => { try { initScheduler(); } catch (e) { console.error('[scheduler] 启动失败', e); } }, 300);
  // 应用自更新:打包版才生效(内部有 isPackaged 守卫);首查在其内部再延迟 3 分钟,不影响首屏。
  try {
    updater.init({
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      markQuitting: () => { isQuitting = true; },
      getMainWindow: () => mainWindow,
      notify: ({ title, body }) => {
        try {
          if (Notification.isSupported()) {
            new Notification({ title: title || 'Relay', body: body || '', icon: APP_ICON || undefined }).show();
          } else if (tray) {
            tray.displayBalloon({ icon: APP_ICON || undefined, title: title || 'Relay', content: body || '' });
          }
        } catch (_) {}
      },
    });
  } catch (e) { console.error('[updater] 启动失败:', e.message); }
  // 技能用量不再在启动阶段预热；首次打开技能页时先显示持久化快照，再由 Worker 增量校准。
  // 全局快捷键唤起迷你输入框(Alt+Space)。注册失败不影响主功能,托盘菜单仍可唤起。
  registerMiniShortcut();
});
app.on('window-all-closed', () => {
  // 主窗口现在「关闭=隐藏到托盘」,不会触发本事件;此处只在真正退出(isQuitting)
  //   或仅有向导窗口被关时走到。托盘存活且非退出意图时,保持进程驻留让后台任务继续跑。
  if (!isQuitting && tray) return;
  // 杀掉所有在跑的 claude 子进程(含常驻会话 —— 它们不会自己退,漏杀就是每个 ~630MB 的孤儿)
  for (const [, child] of jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
  jobs.clear();
  for (const sess of [...liveSessions.values()]) killLiveSession(sess, '应用退出');
  if (process.platform !== 'darwin') app.quit();
});
// 退出前兜底清理:无论从哪条路径退出,都确保子进程被杀、托盘被销毁(否则托盘图标残留)
app.on('before-quit', () => {
  isQuitting = true;
  for (const [, child] of jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
  jobs.clear();
  for (const sess of [...liveSessions.values()]) killLiveSession(sess, '应用退出');
  try { globalShortcut.unregisterAll(); } catch (_) {}   // 释放全局快捷键,避免残留占用
  if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
});
app.on('activate', () => {
  // 有主窗口(可能只是被隐藏)就恢复它;否则按启动逻辑重建
  if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
  else if (BrowserWindow.getAllWindows().length === 0) decideStartup();
});
