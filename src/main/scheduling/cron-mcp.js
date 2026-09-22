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
const { _scheduleConfigurationError: scheduleConfigurationError } = require('./scheduler');

// SDK 0.3.250 起进程内 MCP 可设置硬超时。定时任务工具只做本地小文件读写，
// 30 秒足以覆盖慢磁盘，同时能避免异常处理器永久占住 Claude 回合。
const CRON_MCP_TOOL_TIMEOUT_MS = 30_000;

// ── 数据读写 ──
function readSchedules(file, { strict = false } = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object' || !Array.isArray(d.tasks) || (d.runs != null && !Array.isArray(d.runs))) {
      throw new Error('schedules.json 结构无效');
    }
    d.runs = Array.isArray(d.runs) ? d.runs : [];
    return d;
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1, tasks: [], runs: [] };
    if (strict) throw error;
    return { version: 1, tasks: [], runs: [] };
  }
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
    catchUp: t.catchUp !== false,
    type: a.type || 'chat',
    mode: a.type === 'chat' ? (a.mode === 'agent' ? 'agent' : 'plain') : undefined,
    agentName: a.type === 'chat' && a.mode === 'agent' ? (a.agentName || null) : undefined,
    schedule: when,
    scheduleRaw: s,
    nextRunAt: t.nextRunAt || null,
    lastStatus: t.lastStatus || null,
    runCount: t.runCount || 0,
    prompt: a.type === 'command' ? (a.command || '') : (a.prompt || ''),
    command: a.type === 'command' ? (a.command || '') : undefined,
    workingDir: a.workingDir || null,
    memory: a.type === 'chat' ? (a.memory || 'read') : undefined,   // chat 任务的长期记忆模式
  };
}

// 按名称/描述模糊匹配任务（写操作定位目标用）。返回 {match, candidates}。
function matchTask(file, query, suppliedStore = null) {
  const d = suppliedStore || readSchedules(file, { strict: true });
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
    const d = readSchedules(file, { strict: true });
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
    const d = readSchedules(file, { strict: true });
    const runs = (d.runs || []).filter((r) => r.taskId === match.id).slice(0, 10);
    if (!runs.length) return `「${match.name}」还没有执行记录。`;
    return JSON.stringify(runs.map((r) => ({ at: r.at, status: r.status, ms: r.ms, summary: (r.summary || '').slice(0, 100) })), null, 2);
  }

  // 新建任务（写操作）—— 直接写库，即时生效。
  if (name === 'cron_add') {
    const taskName = String(args.name || '').trim();
    const rawType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
    const prompt = String(args.prompt || '').trim();
    const command = String(args.command || '').trim();
    if (args.type != null && typeof args.type !== 'string') return '任务类型（type）必须是 chat、image 或 command。';
    if (rawType && !['chat', 'image', 'command'].includes(rawType)) {
      return `未知任务类型「${rawType}」；type 仅支持 chat、image 或 command。`;
    }
    const atype = rawType || (command ? 'command' : 'chat');
    if (command && atype !== 'command') return 'command 字段只能用于 type=command 的命令任务。';
    const content = atype === 'command' ? (command || prompt) : prompt;
    const workingDir = typeof args.workingDir === 'string' ? args.workingDir.trim() : '';
    if (!taskName) return '缺少任务名称（name）。';
    if (!content) return atype === 'command' ? '缺少命令脚本（command 或 prompt）。' : '缺少任务内容（prompt）。';
    let schedule = null;
    if (typeof args.cron === 'string' && args.cron.trim()) schedule = { kind: 'cron', cron: args.cron.trim() };
    else if (Number.isFinite(args.everyMs) && args.everyMs >= 1000) schedule = { kind: 'every', everyMs: args.everyMs };
    else if (typeof args.at === 'string' && args.at.trim()) schedule = { kind: 'at', at: args.at.trim() };
    if (!schedule) return '缺少调度（cron / everyMs / at 至少给一个）。';
    const scheduleError = scheduleConfigurationError(schedule, { requireFuture: true });
    if (scheduleError) return `调度无效：${scheduleError}。`;
    const mem = ['off', 'read', 'readwrite'].includes(args.memory) ? args.memory : 'read';
    const mode = atype === 'chat' && args.mode === 'agent' ? 'agent' : 'plain';
    const agentName = typeof args.agentName === 'string' ? args.agentName.trim() : '';
    if (mode === 'agent' && !agentName) return 'Agent 模式必须提供 agentName。';
    const now = new Date().toISOString();
    const task = {
      id: genId(), name: taskName, enabled: true, catchUp: args.catchUp !== false, schedule,
      action: atype === 'image'
        ? { type: 'image', prompt: content, ...(workingDir ? { workingDir } : {}) }
        : atype === 'command'
          ? { type: 'command', command: content, ...(workingDir ? { workingDir } : {}) }
          : { type: 'chat', prompt: content, model: 'haiku', sessionMode: 'isolated', mode, agentName: mode === 'agent' ? agentName : null, memory: mem, ...(workingDir ? { workingDir } : {}) },
      delivery: { notify: true, saveToHistory: true },
      createdAt: now, updatedAt: now, lastRunAt: null, lastStatus: null, lastError: null,
      nextRunAt: null, runCount: 0,   // nextRunAt 由 main 的 reschedule 计算
    };
    const d = readSchedules(file, { strict: true });
    d.tasks.push(task);
    writeSchedules(file, d);
    return `✅ 已创建定时任务「${taskName}」。当前共 ${d.tasks.length} 个任务。`;
  }

  // 其余写操作 —— 定位目标后直接改库，即时生效。
  const mutationStore = readSchedules(file, { strict: true });
  const { match, candidates } = matchTask(file, args.query, mutationStore);
  if (!match) {
    if (candidates.length) {
      return `「${args.query}」匹配到多个任务，请让用户说清楚是哪个：\n`
        + JSON.stringify(candidates.map((c) => c.name)) + '\n（不要猜，请回复用户让其确认具体名称）';
    }
    return `没找到名为「${args.query}」的定时任务，无法操作。可先用 cron_list 查看现有任务名。`;
  }
  const d = mutationStore;
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
    const currentAction = t.action && typeof t.action === 'object' ? t.action : {};
    const currentType = currentAction.type === 'image' ? 'image' : (currentAction.type === 'command' ? 'command' : 'chat');
    const rawType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
    if (args.type != null && typeof args.type !== 'string') return '任务类型（type）必须是 chat、image 或 command。';
    if (rawType && !['chat', 'image', 'command'].includes(rawType)) {
      return `未知任务类型「${rawType}」；type 仅支持 chat、image 或 command。`;
    }
    if (rawType && rawType !== currentType && rawType !== 'command') {
      return 'cron_update 当前只支持将现有任务明确转换为 type=command。';
    }
    const targetType = rawType || currentType;
    const nextPrompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const nextCommand = typeof args.command === 'string' ? args.command.trim() : '';
    const convertingToCommand = targetType === 'command' && currentType !== 'command';
    if (nextCommand && targetType !== 'command') return '只有命令任务可以使用 command 字段；如需转换，请同时指定 type=command。';
    const conversionCommand = convertingToCommand
      ? (nextCommand || nextPrompt || String(currentAction.prompt || '').trim())
      : '';
    if (convertingToCommand && !conversionCommand) {
      return '转换为命令任务时缺少命令脚本（command、prompt 或原任务 prompt）。';
    }

    const sched = {};
    if (typeof args.cron === 'string' && args.cron.trim()) { sched.kind = 'cron'; sched.cron = args.cron.trim(); }
    else if (Number.isFinite(args.everyMs)) { sched.kind = 'every'; sched.everyMs = args.everyMs; }
    else if (typeof args.at === 'string' && args.at.trim()) { sched.kind = 'at'; sched.at = args.at.trim(); }
    const change = [];
    if (Object.keys(sched).length) {
      const scheduleError = scheduleConfigurationError(sched, { requireFuture: true });
      if (scheduleError) return `调度无效：${scheduleError}。`;
      t.schedule = sched;
      t.nextRunAt = null;
      change.push('调度');
    }
    if (typeof args.name === 'string' && args.name.trim()) { t.name = args.name.trim(); change.push('名称'); }
    if (convertingToCommand) {
      const oldWorkingDir = typeof currentAction.workingDir === 'string' && currentAction.workingDir.trim()
        ? currentAction.workingDir.trim()
        : null;
      t.action = {
        type: 'command',
        command: conversionCommand,
        ...(oldWorkingDir ? { workingDir: oldWorkingDir } : {}),
      };
      change.push('类型', '内容');
    } else {
      const nextContent = currentType === 'command' ? (nextCommand || nextPrompt) : nextPrompt;
      if (nextContent) {
        t.action = t.action || { type: currentType };
        if (currentType === 'command') {
          t.action.command = nextContent;
          delete t.action.prompt;
        } else {
          t.action.prompt = nextContent;
        }
        change.push('内容');
      }
    }
    if (typeof args.workingDir === 'string') {
      t.action = t.action || { type: targetType };
      t.action.workingDir = args.workingDir.trim() || null;
      change.push('工作目录');
    }
    if (typeof args.memory === 'string' && ['off', 'read', 'readwrite'].includes(args.memory)) { t.action = t.action || {}; t.action.memory = args.memory; change.push('记忆模式'); }
    if (typeof args.catchUp === 'boolean') { t.catchUp = args.catchUp; change.push('错过补跑策略'); }
    if (typeof args.mode === 'string' && ['plain', 'agent'].includes(args.mode)) {
      t.action = t.action || {};
      if ((t.action.type || 'chat') !== 'chat' && args.mode === 'agent') return '只有对话任务可以使用 Agent 模式。';
      t.action.mode = args.mode;
      change.push('执行模式');
    }
    if (typeof args.agentName === 'string' && args.agentName.trim()) {
      t.action = t.action || {};
      t.action.agentName = args.agentName.trim();
      change.push('Agent');
    }
    if (t.action && t.action.mode === 'agent' && !String(t.action.agentName || '').trim()) {
      return 'Agent 模式必须提供 agentName。';
    }
    if (!change.length) return '没有提供任何要修改的字段（cron/everyMs/at/name/type/prompt/command/workingDir/memory/catchUp/mode/agentName 至少给一个）。';
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
  cron_update: '修改一个定时任务的调度或内容。参数 query（任务名/ id）+ 要改的字段：cron/everyMs/at/name/type/prompt/command/workingDir/memory。现有 chat/image 任务可明确传 type="command" 转为命令任务，脚本依次取 command、prompt、原任务 prompt；命令任务也可用 prompt 或 command 更新脚本。command 不能用于未明确转换的非命令任务。catchUp 表示错过后下次启动是否补跑（默认 true）；对话任务可设 mode="agent" 并必须同时设 agentName。只传需要修改的字段。',
  cron_add: '创建一个新的定时任务。\n参数：name、调度（cron/everyMs/at 三选一）、type（chat 默认 / image / command，忽略大小写和两端空白）。省略 type 但提供 command 时自动创建命令任务，绝不会把 command 当作 chat 丢弃。chat/image 用 prompt；command 可用 command 或 prompt 提供 PowerShell 脚本，并可选 workingDir。catchUp 默认 true，表示 Relay 未运行时错过计划会在下次启动补跑最近一次；设 false 则记录跳过并直接排下次。需使用 Agent 时设 mode="agent" 和 agentName（仅 chat）。写 cron 用本地时间，不要转 UTC。',
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
      name: z.string().optional(), type: z.string().optional().describe('保持原类型；传 command 可将 chat/image 转为命令任务'),
      prompt: z.string().optional(), command: z.string().optional(),
      workingDir: z.string().optional().describe('命令或对话任务的工作目录；传空字符串可清除'),
      memory: z.string().optional().describe('off | read | readwrite'),
      catchUp: z.boolean().optional().describe('错过计划时是否在下次启动补跑最近一次'),
      mode: z.string().optional().describe('plain | agent'),
      agentName: z.string().optional().describe('mode=agent 时必填'),
    },
    cron_add: {
      name: z.string().describe('任务名称'),
      cron: z.string().optional(), everyMs: z.number().optional(), at: z.string().optional(),
      prompt: z.string().optional().describe('对话指令、图片描述，或命令任务的 PowerShell 脚本'),
      command: z.string().optional().describe('命令任务的 PowerShell 脚本；type=command 时可替代 prompt'),
      workingDir: z.string().optional().describe('命令或对话任务的工作目录'),
      type: z.string().optional().describe('chat | image | command'),
      memory: z.string().optional().describe('长期记忆模式（chat 任务）：read=默认 | off=不用记忆 | readwrite=可读写（仅记忆整理类任务）。一般不传。'),
      catchUp: z.boolean().optional().describe('默认 true；false=错过后跳过'),
      mode: z.string().optional().describe('plain | agent'),
      agentName: z.string().optional().describe('mode=agent 时必填'),
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

  return createSdkMcpServer({
    name: 'relay-cron',
    version: '1.0.0',
    tools,
    timeout: CRON_MCP_TOOL_TIMEOUT_MS,
  });
}

module.exports = {
  createCronMcpServer,
  CRON_MCP_TOOL_TIMEOUT_MS,
  _execTool: execTool,
  _readSchedules: readSchedules,
};
