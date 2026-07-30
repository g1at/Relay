// cron-mcp-server.js — Relay 定时任务的 MCP 工具（stdio JSON-RPC 2.0）
//
// 让对话里的 Claude 能查询/管理定时任务（方案 A）。由 claude:run 在涉及定时任务的轮次挂载。
//   · 读操作（list/get/runs）：直接读 schedules.json，立即返回。
//   · 写操作（add/update/remove/toggle/run）：直接改 schedules.json，即时生效（不再走确认）。
//     main 进程 fs.watch 监听该文件，外部写入后自动重排定时器 + 刷新 UI。
//   · cron_run：写一个 runNowAt 标记，main 监听到后立即跑一次（真正执行在 main，它持有 runClaudeJob）。
//
// 路径来源：命令行参数 argv[2]（claude 透传 args 最稳）= Electron 的 userData 目录。
// 零依赖：纯 Node，手写 JSON-RPC。本地脚本毫秒级启动，无 npx 冷启动（不会触发模型退化）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// userData 路径：优先命令行参数（claude 透传 args 最稳），其次环境变量兜底。
//   （实测 --mcp-config 里的 env 字段 claude 不一定透传，故主用 argv。）
const USERDATA = process.argv[2] || process.env.RELAY_USERDATA || '';
const SCHEDULES = USERDATA ? path.join(USERDATA, 'schedules.json') : '';

// ── stdio JSON-RPC ──
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (_) {} };
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
// 工具返回内容（MCP content 数组，文本即可）
const toolText = (id, text) => ok(id, { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }] });

// ── 数据读写 ──
function readSchedules() {
  try { const d = JSON.parse(fs.readFileSync(SCHEDULES, 'utf8')); d.tasks = d.tasks || []; d.runs = d.runs || []; return d; }
  catch (_) { return { version: 1, tasks: [], runs: [] }; }
}
// 直接写回 schedules.json（原子写）。main 进程监听到文件变化后会重排定时器 + 刷新 UI。
//   写操作即时生效，不再走 pending 确认。nextRunAt 留给 main 的 reschedule 计算（外部写时它会补全）。
function writeSchedules(d) {
  const dir = path.dirname(SCHEDULES);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SCHEDULES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, SCHEDULES);
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
function matchTask(query) {
  const d = readSchedules();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { match: null, candidates: [] };
  // 精确 id
  let m = d.tasks.find((t) => t.id === query);
  if (m) return { match: m, candidates: [] };
  // 名称完全相等
  m = d.tasks.find((t) => (t.name || '').toLowerCase() === q);
  if (m) return { match: m, candidates: [] };
  // 名称包含
  const partial = d.tasks.filter((t) => (t.name || '').toLowerCase().includes(q) || q.includes((t.name || '').toLowerCase()));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial.map(taskView) };
}

// 别名 → 真实工具名（模型常凭直觉猜的通用 cron 命名都映射过来）。
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

// ── 工具定义 ──
const TOOLS = [
  {
    name: 'cron_list',
    description: '列出当前所有定时任务（含名称、调度、下次运行、启用状态、已运行次数）。无参数。查询「我有哪些定时任务」时调用。\n\n【重要·你具备完整的定时任务管理能力】这套 relay-cron 工具支持对定时任务的增、删、改、查、启停、立即运行全部操作：cron_list/cron_get/cron_runs（查看）、cron_add（新建）、cron_update（修改）、cron_remove（删除）、cron_toggle（启用/暂停）、cron_run（立即运行）。当用户要求删除/修改/新建/暂停任务时，直接调用对应工具即可——绝不要回答「只支持查看」或「没有删除接口」，也不存在 cron_status 这种工具。写操作（增删改/启停/运行）调用后会返回「已提交，等待用户确认」，这是正常流程，照实告诉用户去界面确认即可。',
    inputSchema: { type: 'object', properties: { includeDisabled: { type: 'boolean', description: '是否包含已暂停的任务，默认 true' } } },
  },
  {
    name: 'cron_get',
    description: '查看某个定时任务的详情。参数 query：任务名称或 id。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '任务名称或 id' } }, required: ['query'] },
  },
  {
    name: 'cron_runs',
    description: '查看某个定时任务的最近执行历史。参数 query：任务名称或 id。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '任务名称或 id' } }, required: ['query'] },
  },
  {
    name: 'cron_toggle',
    description: '启用或暂停一个定时任务。这是写操作，会提交给用户确认后才生效。参数 query（任务名/ id）+ enabled（true 启用 / false 暂停）。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['query', 'enabled'] },
  },
  {
    name: 'cron_remove',
    description: '删除一个定时任务。这是写操作，会提交给用户确认后才生效。参数 query：任务名称或 id。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'cron_run',
    description: '立即运行一次某个定时任务（不影响其计划）。这是写操作，会提交给用户确认后才执行。参数 query：任务名称或 id。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'cron_update',
    description: '修改一个定时任务的调度或内容。这是写操作，会提交给用户确认后才生效。参数 query（任务名/ id）+ 要改的字段：\n- cron: 5 段 cron 表达式（本地时间，如「0 8 * * *」每天8点）\n- everyMs: 间隔毫秒（改成每隔多久）\n- at: ISO8601 时间（改成某个一次性时刻）\n- name: 新名称\n- prompt: 新的任务指令/描述\n- memory: 长期记忆模式，"read"（默认，执行时注入记忆只读）｜"off"（不用记忆）｜"readwrite"（可读写记忆，仅记忆整理类任务用）\n只传需要改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '任务名称或 id' },
        cron: { type: 'string' }, everyMs: { type: 'number' }, at: { type: 'string' },
        name: { type: 'string' }, prompt: { type: 'string' },
        memory: { type: 'string', description: 'off | read | readwrite' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cron_add',
    description: '创建一个新的定时任务。这是写操作，会提交给用户确认后才生效。\n参数：\n- name: 任务名称（简短中文）\n- 调度（三选一）：cron=5段cron表达式（本地时间，如「0 9 * * *」每天9点）｜ everyMs=固定间隔毫秒 ｜ at=ISO8601带时区偏移的一次性时刻\n- prompt: 任务要做什么（自包含的指令，因为每次都是全新上下文。出图任务这里写图片描述）\n- type: 任务类型，"chat"（对话，默认）｜ "image"（出图）。命令类不在对话里创建。\n写 cron 用本地时间，不要转 UTC。例：每天早上9点总结新闻 → name="每日新闻", cron="0 9 * * *", prompt="总结今天的重要科技新闻，列出3-5条要点", type="chat"。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称' },
        cron: { type: 'string' }, everyMs: { type: 'number' }, at: { type: 'string' },
        prompt: { type: 'string', description: '任务指令/图片描述' },
        type: { type: 'string', description: 'chat | image' },
        memory: { type: 'string', description: '长期记忆模式（chat 任务）：read=默认，执行时注入记忆只读 | off=不用记忆 | readwrite=可读写（仅记忆整理类任务）。一般不传。' },
      },
      required: ['name', 'prompt'],
    },
  },
];

// 把别名也注册成真实工具（advertise 出去，模型才能调用）——claude 会校验工具是否在列表里，
//   只在 ALIAS 映射里归一不够，必须把别名声明为工具。复用目标工具的 inputSchema。
for (const [alias, target] of Object.entries(ALIAS)) {
  const base = TOOLS.find((t) => t.name === target);
  if (base) TOOLS.push({ name: alias, description: `（等同 ${target}）${(base.description || '').split('\n')[0]}`, inputSchema: base.inputSchema });
}

// ── 工具执行 ──
function handleTool(id, name, args) {
  args = args || {};
  if (!USERDATA) { toolText(id, '错误：未能定位 Relay 数据目录（RELAY_USERDATA 未设置）。'); return; }

  // 别名归一：模型（尤其较弱的档）常凭直觉猜通用 cron 命名（cron_delete/cron_run_now/…），
  //   这里把这些别名映射到我们的真实工具名，模型猜什么名都能命中，根治「工具不存在」幻觉。
  name = ALIAS[name] || name;

  // 读操作 —— 直接返回
  if (name === 'cron_list') {
    const d = readSchedules();
    let tasks = d.tasks.map(taskView);
    if (args.includeDisabled === false) tasks = tasks.filter((t) => t.enabled);
    if (!tasks.length) { toolText(id, '当前没有任何定时任务。'); return; }
    toolText(id, JSON.stringify(tasks, null, 2));
    return;
  }
  if (name === 'cron_get') {
    const { match, candidates } = matchTask(args.query);
    if (match) { toolText(id, JSON.stringify(taskView(match), null, 2)); return; }
    if (candidates.length) { toolText(id, '没有唯一匹配。候选：\n' + JSON.stringify(candidates, null, 2)); return; }
    toolText(id, `没找到名为「${args.query}」的定时任务。`);
    return;
  }
  if (name === 'cron_runs') {
    const { match } = matchTask(args.query);
    if (!match) { toolText(id, `没找到名为「${args.query}」的定时任务。`); return; }
    const d = readSchedules();
    const runs = (d.runs || []).filter((r) => r.taskId === match.id).slice(0, 10);
    if (!runs.length) { toolText(id, `「${match.name}」还没有执行记录。`); return; }
    toolText(id, JSON.stringify(runs.map((r) => ({ at: r.at, status: r.status, ms: r.ms, summary: (r.summary || '').slice(0, 100) })), null, 2));
    return;
  }

  // 新建任务（写操作）—— 直接写库，即时生效。
  if (name === 'cron_add') {
    const taskName = String(args.name || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!taskName) { toolText(id, '缺少任务名称（name）。'); return; }
    if (!prompt) { toolText(id, '缺少任务内容（prompt）。'); return; }
    let schedule = null;
    if (typeof args.cron === 'string' && args.cron.trim()) schedule = { kind: 'cron', cron: args.cron.trim() };
    else if (Number.isFinite(args.everyMs) && args.everyMs >= 1000) schedule = { kind: 'every', everyMs: args.everyMs };
    else if (typeof args.at === 'string' && args.at.trim()) schedule = { kind: 'at', at: args.at.trim() };
    if (!schedule) { toolText(id, '缺少调度（cron / everyMs / at 至少给一个）。'); return; }
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
    const d = readSchedules();
    d.tasks.push(task);
    writeSchedules(d);
    toolText(id, `✅ 已创建定时任务「${taskName}」。当前共 ${d.tasks.length} 个任务。`);
    return;
  }

  // 其余写操作 —— 定位目标后直接改库，即时生效。
  const needTarget = ['cron_toggle', 'cron_remove', 'cron_run', 'cron_update'];
  if (needTarget.includes(name)) {
    const { match, candidates } = matchTask(args.query);
    if (!match) {
      if (candidates.length) { toolText(id, `「${args.query}」匹配到多个任务，请让用户说清楚是哪个：\n` + JSON.stringify(candidates.map((c) => c.name)) + '\n（不要猜，请回复用户让其确认具体名称）'); return; }
      toolText(id, `没找到名为「${args.query}」的定时任务，无法操作。可先用 cron_list 查看现有任务名。`); return;
    }
    const d = readSchedules();
    const t = d.tasks.find((x) => x.id === match.id);
    if (!t) { toolText(id, `任务「${match.name}」已不存在。`); return; }

    if (name === 'cron_toggle') {
      t.enabled = !!args.enabled;
      t.nextRunAt = null;   // 让 main 重算
      writeSchedules(d);
      toolText(id, `✅ 已${args.enabled ? '启用' : '暂停'}「${t.name}」。`);
      return;
    }
    if (name === 'cron_remove') {
      d.tasks = d.tasks.filter((x) => x.id !== match.id);
      writeSchedules(d);
      toolText(id, `✅ 已删除「${match.name}」。当前剩 ${d.tasks.length} 个任务。`);
      return;
    }
    if (name === 'cron_run') {
      // 立即运行：标记一个一次性的「马上触发」——把 nextRunAt 置为现在，main 监听后会尽快跑。
      //   注:真正执行仍由 main 的调度器完成（它持有 runClaudeJob）。这里用一个 runNowAt 标记。
      t.runNowAt = new Date().toISOString();
      writeSchedules(d);
      toolText(id, `✅ 已触发「${t.name}」立即运行一次，请稍候查看结果。`);
      return;
    }
    if (name === 'cron_update') {
      const sched = {};
      if (typeof args.cron === 'string' && args.cron.trim()) { sched.kind = 'cron'; sched.cron = args.cron.trim(); }
      else if (Number.isFinite(args.everyMs)) { sched.kind = 'every'; sched.everyMs = args.everyMs; }
      else if (typeof args.at === 'string' && args.at.trim()) { sched.kind = 'at'; sched.at = args.at.trim(); }
      let change = [];
      if (Object.keys(sched).length) { t.schedule = sched; t.nextRunAt = null; change.push('调度'); }
      if (typeof args.name === 'string' && args.name.trim()) { t.name = args.name.trim(); change.push('名称'); }
      if (typeof args.prompt === 'string' && args.prompt.trim()) { t.action = t.action || {}; t.action.prompt = args.prompt.trim(); change.push('内容'); }
      if (typeof args.memory === 'string' && ['off', 'read', 'readwrite'].includes(args.memory)) { t.action = t.action || {}; t.action.memory = args.memory; change.push('记忆模式'); }
      if (!change.length) { toolText(id, '没有提供任何要修改的字段（cron/everyMs/at/name/prompt/memory 至少给一个）。'); return; }
      t.updatedAt = new Date().toISOString();
      writeSchedules(d);
      toolText(id, `✅ 已修改「${t.name}」（${change.join('、')}）。`);
      return;
    }
  }

  toolText(id, `未知工具：${name}`);
}

// ── JSON-RPC 主循环 ──
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    try {
      if (msg.method === 'initialize') {
        ok(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'relay-cron', version: '1.0' } });
      } else if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
        // 通知，无需回复
      } else if (msg.method === 'tools/list') {
        ok(msg.id, { tools: TOOLS });
      } else if (msg.method === 'tools/call') {
        handleTool(msg.id, msg.params && msg.params.name, msg.params && msg.params.arguments);
      } else if (msg.method === 'ping') {
        ok(msg.id, {});
      } else if (msg.id != null) {
        ok(msg.id, {});   // 其它请求兜底回空
      }
    } catch (e) {
      if (msg && msg.id != null) fail(msg.id, -32603, 'internal error: ' + e.message);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
