// cron-mcp.js — Relay 定时任务的 MCP 工具（进程内托管）
//
// 让对话里的 Claude 能查询/管理定时任务。由 claude:run 在交互轮次挂载。
//
// 为什么是进程内：
//   原来这是一个独立的 stdio JSON-RPC server（cron-mcp-server.js），每个常驻会话都要
//   spawn 一个 Electron 子进程（ELECTRON_RUN_AS_NODE）跑它，还要先把 MCP 配置写成临时
//   JSON 文件、进程结束后再删掉。SDK 的 createSdkMcpServer 支持进程内注册工具，于是
//   子进程、临时文件、手写的 JSON-RPC 主循环三者一起消失 —— 工具处理器就是普通 JS 函数。
//   顺带也消除了「MCP 子进程被杀后 claude 仍报 connected、模型拿着幽灵工具调用」这个
//   已知风险中属于 cron 的那一份（它现在与主进程同生共死）。
//
// 数据流保持不变：工具直接读写 userData/schedules.json（原子写），
//   main 进程的 fs.watch 监听到变化后重排定时器 + 刷新 UI。
//   写操作即时生效，不走待确认。cron_run 只写一个 runNowAt 标记，
//   真正执行仍由 main 的调度器完成（它持有 runClaudeJob）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 数据读写 ──
function readSchedules(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); d.tasks = d.tasks || []; d.runs = d.runs || []; return d; }
  catch (_) { return { version: 1, tasks: [], runs: [] }; }
}
// 直接写回 schedules.json（原子写）。main 进程监听到文件变化后会重排定时器 + 刷新 UI。
//   nextRunAt 留给 main 的 reschedule 计算（外部写时它会补全）。
function writeSchedules(file, d) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file);
}
function genId() { try { return crypto.randomUUID(); } catch (_) { return 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1e6); } }

// 任务对外视图（裁剪给模型看的字段，避免噪音）。
function taskView(t) {
  const s = t.schedule || {};
  let when = '';
  if (s.kind === 'cron') when = `cron: ${s.cron || ''}`;
  else if (s.kind === 'every') when = `每 ${Math.round((s.everyMs || 0) / 60000)} 分钟`;
  else if (s.kind === 'at') when = `一次性: ${s.at || ''}`;
  const a = t.action || {};
  return {
    id: t.id,
    name: t.name || '未命名任务',
    enabled: t.enabled !== false,
    type: a.type || 'chat',
    schedule: when,
    scheduleRaw: s,
    nextRunAt: t.nextRunAt || null,
    lastStatus: t.lastStatus || null,
    runCount: t.runCount || 0,
    prompt: a.type === 'command' ? (a.command || '') : (a.prompt || ''),
    memory: a.type === 'chat' ? (a.memory || 'read') : undefined,   // chat 任务的长期记忆模式
  };
}

// 按名称/描述模糊匹配任务（写操作定位目标用）。返回 {match, candidates}。
function matchTask(file, query) {
  const d = readSchedules(file);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { match: null, candidates: [] };
  let m = d.tasks.find((t) => t.id === query);                       // 精确 id
  if (m) return { match: m, candidates: [] };
  m = d.tasks.find((t) => (t.name || '').toLowerCase() === q);       // 名称完全相等
  if (m) return { match: m, candidates: [] };
  const partial = d.tasks.filter((t) => (t.name || '').toLowerCase().includes(q) || q.includes((t.name || '').toLowerCase()));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial.map(taskView) };
}

// 别名 → 真实工具名。模型（尤其较弱的档）常凭直觉猜通用 cron 命名，
//   而 claude 会校验工具是否在列表里 —— 只做映射不够，必须把别名也注册成工具，
//   否则模型猜错名就会得到「工具不存在」并据此编出「我没有删除能力」之类的结论。
const ALIAS = {
  cron_delete: 'cron_remove', cron_del: 'cron_remove', cron_rm: 'cron_remove',
  cron_run_now: 'cron_run', cron_trigger: 'cron_run', cron_execute: 'cron_run',
  cron_next: 'cron_get', cron_show: 'cron_get', cron_detail: 'cron_get',
  cron_search: 'cron_list', cron_status: 'cron_list', cron_ls: 'cron_list',
  cron_create: 'cron_add', cron_new: 'cron_add',
  cron_edit: 'cron_update', cron_modify: 'cron_update', cron_change: 'cron_update',
  cron_enable: 'cron_toggle', cron_disable: 'cron_toggle', cron_pause: 'cron_toggle', cron_resume: 'cron_toggle',
  cron_history: 'cron_runs', cron_logs: 'cron_runs',
};

// ── 工具实现 ──
// 每个处理器返回一段给模型看的文本；调用方负责包成 MCP 的 content 结构。
function execTool(file, name, args) {
  args = args || {};
  if (!file) return '错误：未能定位 Relay 数据目录。';

  // 读操作
  if (name === 'cron_list') {
    const d = readSchedules(file);
    let tasks = d.tasks.map(taskView);
    if (args.includeDisabled === false) tasks = tasks.filter((t) => t.enabled);
    if (!tasks.length) return '当前没有任何定时任务。';
    return JSON.stringify(tasks, null, 2);
  }
  if (name === 'cron_get') {
    const { match, candidates } = matchTask(file, args.query);
    if (match) return JSON.stringify(taskView(match), null, 2);
    if (candidates.length) return '没有唯一匹配。候选：\n' + JSON.stringify(candidates, null, 2);
    return `没找到名为「${args.query}」的定时任务。`;
  }
  if (name === 'cron_runs') {
    const { match } = matchTask(file, args.query);
    if (!match) return `没找到名为「${args.query}」的定时任务。`;
    const d = readSchedules(file);
    const runs = (d.runs || []).filter((r) => r.taskId === match.id).slice(0, 10);
    if (!runs.length) return `「${match.name}」还没有执行记录。`;
    return JSON.stringify(runs.map((r) => ({ at: r.at, status: r.status, ms: r.ms, summary: (r.summary || '').slice(0, 100) })), null, 2);
  }

  // 新建任务（写操作）—— 直接写库，即时生效。
  if (name === 'cron_add') {
    const taskName = String(args.name || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!taskName) return '缺少任务名称（name）。';
    if (!prompt) return '缺少任务内容（prompt）。';
    let schedule = null;
    if (typeof args.cron === 'string' && args.cron.trim()) schedule = { kind: 'cron', cron: args.cron.trim() };
    else if (Number.isFinite(args.everyMs) && args.everyMs >= 1000) schedule = { kind: 'every', everyMs: args.everyMs };
    else if (typeof args.at === 'string' && args.at.trim()) schedule = { kind: 'at', at: args.at.trim() };
    if (!schedule) return '缺少调度（cron / everyMs / at 至少给一个）。';
    const atype = args.type === 'image' ? 'image' : 'chat';
    const mem = ['off', 'read', 'readwrite'].includes(args.memory) ? args.memory : 'read';
    const now = new Date().toISOString();
    const task = {
      id: genId(), name: taskName, enabled: true, schedule,
      action: atype === 'image'
        ? { type: 'image', prompt }
        : { type: 'chat', prompt, model: 'haiku', sessionMode: 'isolated', mode: 'plain', memory: mem },
      delivery: { notify: true, saveToHistory: true },
      createdAt: now, updatedAt: now, lastRunAt: null, lastStatus: null, lastError: null,
      nextRunAt: null, runCount: 0,   // nextRunAt 由 main 的 reschedule 计算
    };
    const d = readSchedules(file);
    d.tasks.push(task);
    writeSchedules(file, d);
    return `✅ 已创建定时任务「${taskName}」。当前共 ${d.tasks.length} 个任务。`;
  }

  // 其余写操作 —— 定位目标后直接改库，即时生效。
  const { match, candidates } = matchTask(file, args.query);
  if (!match) {
    if (candidates.length) {
      return `「${args.query}」匹配到多个任务，请让用户说清楚是哪个：\n`
        + JSON.stringify(candidates.map((c) => c.name)) + '\n（不要猜，请回复用户让其确认具体名称）';
    }
    return `没找到名为「${args.query}」的定时任务，无法操作。可先用 cron_list 查看现有任务名。`;
  }
  const d = readSchedules(file);
  const t = d.tasks.find((x) => x.id === match.id);
  if (!t) return `任务「${match.name}」已不存在。`;

  if (name === 'cron_toggle') {
    t.enabled = !!args.enabled;
    t.nextRunAt = null;   // 让 main 重算
    writeSchedules(file, d);
    return `✅ 已${args.enabled ? '启用' : '暂停'}「${t.name}」。`;
  }
  if (name === 'cron_remove') {
    d.tasks = d.tasks.filter((x) => x.id !== match.id);
    writeSchedules(file, d);
    return `✅ 已删除「${match.name}」。当前剩 ${d.tasks.length} 个任务。`;
  }
  if (name === 'cron_run') {
    // 立即运行：写一个 runNowAt 标记，main 监听到后尽快跑一次。
    //   真正执行仍由 main 的调度器完成（它持有 runClaudeJob）。
    t.runNowAt = new Date().toISOString();
    writeSchedules(file, d);
    return `✅ 已触发「${t.name}」立即运行一次，请稍候查看结果。`;
  }
  if (name === 'cron_update') {
    const sched = {};
    if (typeof args.cron === 'string' && args.cron.trim()) { sched.kind = 'cron'; sched.cron = args.cron.trim(); }
    else if (Number.isFinite(args.everyMs)) { sched.kind = 'every'; sched.everyMs = args.everyMs; }
    else if (typeof args.at === 'string' && args.at.trim()) { sched.kind = 'at'; sched.at = args.at.trim(); }
    const change = [];
    if (Object.keys(sched).length) { t.schedule = sched; t.nextRunAt = null; change.push('调度'); }
    if (typeof args.name === 'string' && args.name.trim()) { t.name = args.name.trim(); change.push('名称'); }
    if (typeof args.prompt === 'string' && args.prompt.trim()) { t.action = t.action || {}; t.action.prompt = args.prompt.trim(); change.push('内容'); }
    if (typeof args.memory === 'string' && ['off', 'read', 'readwrite'].includes(args.memory)) { t.action = t.action || {}; t.action.memory = args.memory; change.push('记忆模式'); }
    if (!change.length) return '没有提供任何要修改的字段（cron/everyMs/at/name/prompt/memory 至少给一个）。';
    t.updatedAt = new Date().toISOString();
    writeSchedules(file, d);
    return `✅ 已修改「${t.name}」（${change.join('、')}）。`;
  }

  return `未知工具：${name}`;
}

// ── 工具描述 ──
const DESC = {
  cron_list: '列出当前所有定时任务（含名称、调度、下次运行、启用状态、已运行次数）。无参数。查询「我有哪些定时任务」时调用。\n\n【重要·你具备完整的定时任务管理能力】这套 relay-cron 工具支持对定时任务的增、删、改、查、启停、立即运行全部操作：cron_list/cron_get/cron_runs（查看）、cron_add（新建）、cron_update（修改）、cron_remove（删除）、cron_toggle（启用/暂停）、cron_run（立即运行）。当用户要求删除/修改/新建/暂停任务时，直接调用对应工具即可——绝不要回答「只支持查看」或「没有删除接口」。写操作调用后立即生效。',
  cron_get: '查看某个定时任务的详情。参数 query：任务名称或 id。',
  cron_runs: '查看某个定时任务的最近执行历史。参数 query：任务名称或 id。',
  cron_toggle: '启用或暂停一个定时任务。参数 query（任务名/ id）+ enabled（true 启用 / false 暂停）。',
  cron_remove: '删除一个定时任务。参数 query：任务名称或 id。',
  cron_run: '立即运行一次某个定时任务（不影响其计划）。参数 query：任务名称或 id。',
  cron_update: '修改一个定时任务的调度或内容。参数 query（任务名/ id）+ 要改的字段：\n- cron: 5 段 cron 表达式（本地时间，如「0 8 * * *」每天8点）\n- everyMs: 间隔毫秒（改成每隔多久）\n- at: ISO8601 时间（改成某个一次性时刻）\n- name: 新名称\n- prompt: 新的任务指令/描述\n- memory: 长期记忆模式，"read"（默认，执行时注入记忆只读）｜"off"（不用记忆）｜"readwrite"（可读写记忆，仅记忆整理类任务用）\n只传需要改的字段。',
  cron_add: '创建一个新的定时任务。\n参数：\n- name: 任务名称（简短中文）\n- 调度（三选一）：cron=5段cron表达式（本地时间，如「0 9 * * *」每天9点）｜ everyMs=固定间隔毫秒 ｜ at=ISO8601带时区偏移的一次性时刻\n- prompt: 任务要做什么（自包含的指令，因为每次都是全新上下文。出图任务这里写图片描述）\n- type: 任务类型，"chat"（对话，默认）｜ "image"（出图）。命令类不在对话里创建。\n写 cron 用本地时间，不要转 UTC。例：每天早上9点总结新闻 → name="每日新闻", cron="0 9 * * *", prompt="总结今天的重要科技新闻，列出3-5条要点", type="chat"。',
};

// 创建进程内 MCP server。userDataDir = Electron 的 userData 目录。
//   返回值直接塞进 SDK options.mcpServers 的某个键即可。
//
//   【必须每个会话新建一个实例，不能缓存复用】
//   createSdkMcpServer 返回的实例在 query 启动时会被 connect 到一个传输层，
//   同一实例被第二个会话再 connect 就会失败 —— 表现为该会话里 relay-cron 静默缺席
//   （模型只看到其它 MCP，进而回答「我没有定时任务管理能力」）。
//   工具本身是无状态的（状态都在 schedules.json 里），重建成本只是搭 31 个 zod schema，可忽略。
function createCronMcpServer({ createSdkMcpServer, tool, z, userDataDir }) {
  const file = userDataDir ? path.join(userDataDir, 'schedules.json') : '';

  // 各工具的入参 schema（zod raw shape）。与原 JSON Schema 一一对应。
  const shapes = {
    cron_list: { includeDisabled: z.boolean().optional().describe('是否包含已暂停的任务，默认 true') },
    cron_get: { query: z.string().describe('任务名称或 id') },
    cron_runs: { query: z.string().describe('任务名称或 id') },
    cron_toggle: { query: z.string().describe('任务名称或 id'), enabled: z.boolean().describe('true 启用 / false 暂停') },
    cron_remove: { query: z.string().describe('任务名称或 id') },
    cron_run: { query: z.string().describe('任务名称或 id') },
    cron_update: {
      query: z.string().describe('任务名称或 id'),
      cron: z.string().optional(), everyMs: z.number().optional(), at: z.string().optional(),
      name: z.string().optional(), prompt: z.string().optional(),
      memory: z.string().optional().describe('off | read | readwrite'),
    },
    cron_add: {
      name: z.string().describe('任务名称'),
      cron: z.string().optional(), everyMs: z.number().optional(), at: z.string().optional(),
      prompt: z.string().describe('任务指令/图片描述'),
      type: z.string().optional().describe('chat | image'),
      memory: z.string().optional().describe('长期记忆模式（chat 任务）：read=默认 | off=不用记忆 | readwrite=可读写（仅记忆整理类任务）。一般不传。'),
    },
  };

  const mk = (toolName, realName, description) => tool(
    toolName,
    description,
    shapes[realName],
    async (args) => {
      let text;
      try { text = execTool(file, realName, args); }
      catch (e) {
        console.error('[cron-mcp] %s 执行失败: %s', toolName, e && e.message);
        text = `执行失败：${(e && e.message) || e}`;
      }
      return { content: [{ type: 'text', text: String(text) }] };
    },
  );

  const tools = Object.keys(shapes).map((n) => mk(n, n, DESC[n]));
  // 别名也注册成真实工具（见上方 ALIAS 的说明）。描述取目标工具的首行，避免整表重复占上下文。
  for (const [alias, target] of Object.entries(ALIAS)) {
    tools.push(mk(alias, target, `（等同 ${target}）${(DESC[target] || '').split('\n')[0]}`));
  }

  return createSdkMcpServer({ name: 'relay-cron', version: '1.0.0', tools });
}

module.exports = { createCronMcpServer };
