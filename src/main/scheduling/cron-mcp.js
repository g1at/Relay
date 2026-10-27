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
// 与设置页共用注入的 scheduler 服务，CRUD 与立即运行都由调度器校验、落盘。
// 工具不直接修改 schedules.json，也不把写入标记误报成已运行。

const { _scheduleConfigurationError: scheduleConfigurationError,
  _normalizeMediaActionFields: normalizeMediaActionFields,
  _mediaModelView: mediaModelView } = require('./scheduler');

// 工具只等待本地管理操作或调度器接收回执，不等待任务执行完成。
const CRON_MCP_TOOL_TIMEOUT_MS = 30_000;

function toolResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}
function fail(message, code = 'INVALID_ARGUMENT') {
  throw Object.assign(new Error(message), { code });
}
function requireSuccess(result) {
  if (!result || result.ok !== true) {
    fail(result && result.error || '调度器未接受本次操作。', result && result.code || 'SCHEDULER_OPERATION_FAILED');
  }
  return result;
}
async function execTool(scheduler, name, args) {
  try {
    const result = await executeTool(scheduler, name, args || {});
    return typeof result === 'string' ? toolResult(result) : result;
  } catch (error) {
    const details = { ok: false, ...(name === 'cron_run' ? { status: 'failed' } : {}), code: error && error.code || 'SCHEDULER_OPERATION_FAILED', error: error && error.message || String(error) };
    return toolResult(`执行失败：${details.error}`, details, true);
  }
}

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
    overlapPolicy: t.overlapPolicy === 'queueLatest' ? 'queueLatest' : 'skip',
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
    ...(['image', 'video'].includes(a.type) ? {
      mediaModel: a.mediaModel || a.imageModel || null,
      parameters: a.parameters || {}, references: a.references || [],
    } : {}),
  };
}

// 按名称/描述模糊匹配任务（写操作定位目标用）。返回 {match, candidates}。
function matchTask(tasks, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { match: null, candidates: [] };
  const m = tasks.find((t) => t.id === query);                       // 精确 id
  if (m) return { match: m, candidates: [] };
  const exactNames = tasks.filter((t) => (t.name || '').toLowerCase() === q);
  if (exactNames.length === 1) return { match: exactNames[0], candidates: [] };
  if (exactNames.length > 1) return { match: null, candidates: exactNames.map(taskView) };
  const partial = tasks.filter((t) => {
    const name = String(t.name || '').trim().toLowerCase();
    return name && (name.includes(q) || q.includes(name));
  });
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
// 结果兼容文本读取；执行回执同时提供结构化字段，失败统一标记 isError。
async function executeTool(scheduler, name, args) {
  if (!scheduler || typeof scheduler.list !== 'function') fail('Relay 调度器尚未就绪，请稍后重试。', 'SCHEDULER_UNAVAILABLE');

  // 读操作
  if (name === 'cron_media_models') {
    if (args.modality !== undefined && !['image', 'video'].includes(args.modality)) fail('modality 必须是 image 或 video。');
    if (args.includeUnavailable !== undefined && typeof args.includeUnavailable !== 'boolean') fail('includeUnavailable 必须是布尔值。');
    if (typeof scheduler.listMediaModels !== 'function') fail('媒体模型列表尚未就绪。', 'MEDIA_CATALOG_UNAVAILABLE');
    const found = await scheduler.listMediaModels({ ...(args.modality ? { modality: args.modality } : {}), includeUnavailable: args.includeUnavailable === true });
    if (!Array.isArray(found)) fail('媒体模型列表返回格式无效。', 'MEDIA_CATALOG_UNAVAILABLE');
    const models = found.map(mediaModelView).filter(model => model && (!args.modality || model.modality === args.modality)
      && (args.includeUnavailable === true || (model.enabled && model.available)));
    const result = { ok: true, models };
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  if (name === 'cron_list') {
    let tasks = (await scheduler.list()).map(taskView);
    if (args.includeDisabled === false) tasks = tasks.filter((t) => t.enabled);
    if (!tasks.length) return '当前没有任何定时任务。';
    return JSON.stringify(tasks, null, 2);
  }
  if (name === 'cron_get') {
    const { match, candidates } = matchTask(await scheduler.list(), args.query);
    if (match) return JSON.stringify(taskView(match), null, 2);
    if (candidates.length) fail('没有唯一匹配。候选：\n' + JSON.stringify(candidates, null, 2), 'AMBIGUOUS_TASK');
    fail(`没找到名为「${args.query}」的定时任务。`, 'TASK_NOT_FOUND');
  }
  if (name === 'cron_runs') {
    const { match, candidates } = matchTask(await scheduler.list(), args.query);
    if (candidates.length) fail('没有唯一匹配。候选：\n' + JSON.stringify(candidates, null, 2), 'AMBIGUOUS_TASK');
    if (!match) fail(`没找到名为「${args.query}」的定时任务。`, 'TASK_NOT_FOUND');
    const runs = (await scheduler.runs(match.id)).slice(0, 10);
    if (!runs.length) return `「${match.name}」还没有执行记录。`;
    return JSON.stringify(runs.map((r) => ({ ...r, summary: (r.summary || '').slice(0, 100) })), null, 2);
  }

  // 新建任务：由调度器统一校验、生成 id 并计算首次触发时间。
  if (name === 'cron_add') {
    const taskName = String(args.name || '').trim();
    const rawType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
    const prompt = String(args.prompt || '').trim();
    const command = String(args.command || '').trim();
    if (args.type != null && typeof args.type !== 'string') fail('任务类型（type）必须是 chat、image、video 或 command。');
    if (rawType && !['chat', 'image', 'video', 'command'].includes(rawType)) {
      fail(`未知任务类型「${rawType}」；type 仅支持 chat、image、video 或 command。`);
    }
    const atype = rawType || (command ? 'command' : 'chat');
    const mediaAction = mediaFields(args, atype);
    if (atype === 'video' && !mediaAction.mediaModel && !args.imageModel) fail('视频任务必须提供 mediaModel 精确路由 ID。');
    if (command && atype !== 'command') fail('command 字段只能用于 type=command 的命令任务。');
    const content = atype === 'command' ? (command || prompt) : prompt;
    const workingDir = typeof args.workingDir === 'string' ? args.workingDir.trim() : '';
    if (!taskName) fail('缺少任务名称（name）。');
    if (!content) fail(atype === 'command' ? '缺少命令脚本（command 或 prompt）。' : '缺少任务内容（prompt）。');
    let schedule = null;
    if (typeof args.cron === 'string' && args.cron.trim()) schedule = { kind: 'cron', cron: args.cron.trim() };
    else if (Number.isFinite(args.everyMs) && args.everyMs >= 1000) schedule = { kind: 'every', everyMs: args.everyMs };
    else if (typeof args.at === 'string' && args.at.trim()) schedule = { kind: 'at', at: args.at.trim() };
    if (!schedule) fail('缺少调度（cron / everyMs / at 至少给一个）。');
    if (args.tz !== undefined) schedule.tz = args.tz;
    const scheduleError = scheduleConfigurationError(schedule, { requireFuture: true });
    if (scheduleError) fail(`调度无效：${scheduleError}。`, 'INVALID_TASK_CONFIGURATION');
    const mem = ['off', 'read', 'readwrite'].includes(args.memory) ? args.memory : 'read';
    const mode = atype === 'chat' && args.mode === 'agent' ? 'agent' : 'plain';
    const agentName = typeof args.agentName === 'string' ? args.agentName.trim() : '';
    if (mode === 'agent' && !agentName) fail('Agent 模式必须提供 agentName。');
    if (args.overlapPolicy !== undefined && !['skip', 'queueLatest'].includes(args.overlapPolicy)) {
      fail('overlapPolicy 必须是 skip 或 queueLatest。');
    }
    const task = {
      name: taskName, enabled: true, catchUp: args.catchUp !== false,
      overlapPolicy: args.overlapPolicy || 'skip', schedule,
      action: ['image', 'video'].includes(atype)
        ? { type: atype, prompt: content, ...mediaAction, ...(workingDir ? { workingDir } : {}) }
        : atype === 'command'
          ? { type: 'command', command: content, ...(workingDir ? { workingDir } : {}) }
          : { type: 'chat', prompt: content, model: 'haiku', sessionMode: 'isolated', mode, agentName: mode === 'agent' ? agentName : null, memory: mem, ...(workingDir ? { workingDir } : {}) },
      delivery: { notify: true, saveToHistory: true },
    };
    const created = requireSuccess(await scheduler.create(task));
    return toolResult(`✅ 已创建定时任务「${taskName}」。`, { ok: true, task: taskView(created.task) });
  }

  // 查询只用于定位；实际修改由调度器重新读取并合并，避免覆盖运行期间更新的状态。
  const { match, candidates } = matchTask(await scheduler.list(), args.query);
  if (!match) {
    if (candidates.length) {
      fail(`「${args.query}」匹配到多个任务，请指定名称或 id：\n`
        + JSON.stringify(candidates.map((c) => ({ id: c.id, name: c.name }))), 'AMBIGUOUS_TASK');
    }
    fail(`没找到名为「${args.query}」的定时任务，无法操作。可先用 cron_list 查看现有任务名。`, 'TASK_NOT_FOUND');
  }
  // 永远不原地修改服务返回的任务对象；校验失败时不得留下半次修改。
  const t = { ...match, schedule: { ...(match.schedule || {}) }, action: { ...(match.action || {}) } };

  if (name === 'cron_toggle') {
    if (typeof args.enabled !== 'boolean') fail('enabled 必须是 true 或 false。');
    requireSuccess(await scheduler.toggle(match.id, args.enabled));
    return `✅ 已${args.enabled ? '启用' : '暂停'}「${t.name}」。`;
  }
  if (name === 'cron_remove') {
    requireSuccess(await scheduler.remove(match.id));
    return `✅ 已删除「${match.name}」。`;
  }
  if (name === 'cron_run') {
    const receipt = await scheduler.runNow(match.id);
    if (!receipt || !['accepted', 'queued', 'already_running', 'failed'].includes(receipt.status)
        || (receipt.ok !== ['accepted', 'queued'].includes(receipt.status))
        || (['accepted', 'queued', 'already_running'].includes(receipt.status)
          && (typeof receipt.runId !== 'string' || !receipt.runId))) {
      fail('调度器未返回有效的执行回执，请查询运行记录确认状态。', 'INVALID_RUN_RECEIPT');
    }
    // accepted / queued 仅表示已接收，不能宣称任务已经执行成功。
    const result = { ...receipt, taskId: receipt.taskId || match.id };
    return toolResult(JSON.stringify(result, null, 2), result, result.ok !== true);
  }
  if (name === 'cron_update') {
    const currentAction = match.action && typeof match.action === 'object' ? match.action : {};
    const currentType = ['image', 'video', 'command'].includes(currentAction.type) ? currentAction.type : 'chat';
    const rawType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
    if (args.type != null && typeof args.type !== 'string') fail('任务类型（type）必须是 chat、image、video 或 command。');
    if (rawType && !['chat', 'image', 'video', 'command'].includes(rawType)) {
      fail(`未知任务类型「${rawType}」；type 仅支持 chat、image、video 或 command。`);
    }
    if (rawType && rawType !== currentType && rawType !== 'command') {
      fail('cron_update 当前只支持将现有任务明确转换为 type=command。');
    }
    const targetType = rawType || currentType;
    const mediaPatch = mediaFields(args, targetType);
    const nextPrompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const nextCommand = typeof args.command === 'string' ? args.command.trim() : '';
    const convertingToCommand = targetType === 'command' && currentType !== 'command';
    if (nextCommand && targetType !== 'command') fail('只有命令任务可以使用 command 字段；如需转换，请同时指定 type=command。');
    const conversionCommand = convertingToCommand
      ? (nextCommand || nextPrompt || String(currentAction.prompt || '').trim())
      : '';
    if (convertingToCommand && !conversionCommand) {
      fail('转换为命令任务时缺少命令脚本（command、prompt 或原任务 prompt）。');
    }

    const sched = {};
    if (typeof args.cron === 'string' && args.cron.trim()) { sched.kind = 'cron'; sched.cron = args.cron.trim(); }
    else if (Number.isFinite(args.everyMs)) { sched.kind = 'every'; sched.everyMs = args.everyMs; }
    else if (typeof args.at === 'string' && args.at.trim()) { sched.kind = 'at'; sched.at = args.at.trim(); }
    const change = [];
    if (Object.keys(mediaPatch).length) {
      t.action = { ...t.action, ...mediaPatch };
      if (targetType === 'video' && !t.action.mediaModel && !t.action.imageModel) fail('视频任务必须提供 mediaModel 精确路由 ID。');
      change.push('媒体配置');
    }
    if (args.tz !== undefined) sched.tz = args.tz;
    if (Object.keys(sched).length) {
      const scheduleError = scheduleConfigurationError({ ...t.schedule, ...sched }, { requireFuture: true });
      if (scheduleError) fail(`调度无效：${scheduleError}。`, 'INVALID_TASK_CONFIGURATION');
      t.schedule = { ...t.schedule, ...sched };
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
    if (args.overlapPolicy !== undefined) {
      if (!['skip', 'queueLatest'].includes(args.overlapPolicy)) fail('overlapPolicy 必须是 skip 或 queueLatest。');
      t.overlapPolicy = args.overlapPolicy;
      change.push('重叠策略');
    }
    if (typeof args.mode === 'string' && ['plain', 'agent'].includes(args.mode)) {
      t.action = t.action || {};
      if ((t.action.type || 'chat') !== 'chat' && args.mode === 'agent') fail('只有对话任务可以使用 Agent 模式。');
      t.action.mode = args.mode;
      change.push('执行模式');
    }
    if (typeof args.agentName === 'string' && args.agentName.trim()) {
      t.action = t.action || {};
      t.action.agentName = args.agentName.trim();
      change.push('Agent');
    }
    if (t.action && t.action.mode === 'agent' && !String(t.action.agentName || '').trim()) {
      fail('Agent 模式必须提供 agentName。');
    }
    if (!change.length) fail('没有提供任何要修改的字段（调度、名称、内容、mediaModel/parameters/references 等至少给一个）。');
    const patch = {};
    if (change.includes('调度')) patch.schedule = sched;
    if (change.includes('名称')) patch.name = t.name;
    if (change.includes('错过补跑策略')) patch.catchUp = t.catchUp;
    if (change.includes('重叠策略')) patch.overlapPolicy = t.overlapPolicy;
    if (change.some((item) => ['类型', '内容', '工作目录', '记忆模式', '执行模式', 'Agent', '媒体配置'].includes(item))) {
      patch.action = Object.fromEntries(Object.entries(t.action).filter(([key, value]) =>
        convertingToCommand || value !== currentAction[key]));
      if (convertingToCommand) {
        // scheduler 合并 action；显式清除只属于旧类型的会话配置。
        Object.assign(patch.action, { prompt: '', sessionMode: 'isolated', sessionRef: null, sessionRoute: null, mode: 'plain', agentName: null });
      }
    }
    requireSuccess(await scheduler.update(match.id, patch));
    return `✅ 已修改「${t.name}」（${change.join('、')}）。`;
  }

  fail(`未知工具：${name}`, 'UNKNOWN_TOOL');
}

function mediaFields(args, type) {
  const keys = ['mediaModel', 'imageModel', 'parameters', 'references'].filter(key => Object.prototype.hasOwnProperty.call(args, key));
  if (!keys.length) return {};
  if (!['image', 'video'].includes(type)) fail('mediaModel、parameters 和 references 只能用于图片或视频任务。');
  for (const key of ['mediaModel', 'imageModel']) if (Object.prototype.hasOwnProperty.call(args, key)
    && typeof args[key] !== 'string') fail(`${key} 必须是精确媒体路由 ID。`);
  const normalized = normalizeMediaActionFields(args);
  const result = {};
  for (const key of keys) result[key] = key === 'imageModel' ? args.imageModel.trim() || null : normalized[key];
  return result;
}

// ── 工具描述 ──
const DESC = {
  cron_media_models: '只读列出已配置的图片、视频模型绑定及 capabilities。创建或修改媒体任务前，先从此处选取精确 routeId 作为 mediaModel；参数、参考素材数量和角色按 capabilities 填写。可选 modality=image/video；includeUnavailable=true 时也列出未启用或缺少连接配置的绑定。available 仅表示本地配置齐备，不代表已验证远端权限。不调用生成接口，不产生生成费用。',
  cron_list: '列出当前所有定时任务（含名称、调度、下次运行、启用状态、已运行次数）。无参数。查询「我有哪些定时任务」时调用。\n\n【重要·你具备完整的定时任务管理能力】这套 relay-cron 工具支持对定时任务的增、删、改、查、启停、立即运行全部操作：cron_list/cron_get/cron_runs（查看）、cron_add（新建）、cron_update（修改）、cron_remove（删除）、cron_toggle（启用/暂停）、cron_run（立即运行）。当用户要求删除/修改/新建/暂停任务时，直接调用对应工具即可——绝不要回答「只支持查看」或「没有删除接口」。写操作调用后立即生效。',
  cron_get: '查看某个定时任务的详情。参数 query：任务名称或 id。',
  cron_runs: '查看某个定时任务的最近执行历史。参数 query：任务名称或 id。',
  cron_toggle: '启用或暂停一个定时任务。参数 query（任务名/ id）+ enabled（true 启用 / false 暂停）。',
  cron_remove: '删除一个定时任务。参数 query：任务名称或 id。',
  cron_run: '请求立即运行一次定时任务（不影响其计划）。返回调度器回执 status：accepted=已接收、queued=等待资源、already_running=已有运行、failed=未接收；runId 用于追踪。accepted/queued 不代表执行完成，结果请查询 cron_runs。参数 query：任务名称或 id。',
  cron_update: '修改一个定时任务的调度或内容。参数 query（任务名/ id）+ 要改的字段：cron/everyMs/at/tz/name/type/prompt/command/workingDir/memory；图片与视频支持 mediaModel/parameters/references。现有 chat/image 任务可明确传 type="command" 转为命令任务，脚本依次取 command、prompt、原任务 prompt；命令任务也可用 prompt 或 command 更新脚本。command 不能用于未明确转换的非命令任务。catchUp 表示错过后下次启动是否补跑（默认 true）；对话任务可设 mode="agent" 并必须同时设 agentName。overlapPolicy 可设 skip（默认，跳过重叠触发）或 queueLatest（上轮结束后补跑最近一次）。只传需要修改的字段。',
  cron_add: '创建一个新的定时任务。\n参数：name、调度（cron/everyMs/at 三选一）、type（chat 默认 / image / video / command，忽略大小写和两端空白）。省略 type 但提供 command 时自动创建命令任务，绝不会把 command 当作 chat 丢弃。chat/image/video 用 prompt；视频必须指定 mediaModel 精确路由 ID，图片或视频可提供 parameters 和 references；command 可用 command 或 prompt 提供 PowerShell 脚本，并可选 workingDir。catchUp 默认 true，表示 Relay 未运行时错过计划会在下次启动补跑最近一次；设 false 则记录跳过并直接排下次。overlapPolicy 默认 skip（跳过重叠触发），queueLatest 表示上轮结束后补跑最近一次。需使用 Agent 时设 mode="agent" 和 agentName（仅 chat）。cron 按 tz 指定的 IANA 时区解释；不传 tz 时使用系统时区，不要自行转 UTC。',
};

// 创建进程内 MCP server。scheduler 为主进程共享的调度器服务。
//   返回值直接塞进 SDK options.mcpServers 的某个键即可。
//
//   【必须每个会话新建一个实例，不能缓存复用】
//   createSdkMcpServer 返回的实例在 query 启动时会被 connect 到一个传输层，
//   同一实例被第二个会话再 connect 就会失败 —— 表现为该会话里 relay-cron 静默缺席
//   （模型只看到其它 MCP，进而回答「我没有定时任务管理能力」）。
//   工具本身是无状态的（状态都在 schedules.json 里），重建成本只是搭 31 个 zod schema，可忽略。
function createCronMcpServer({ createSdkMcpServer, tool, z, scheduler }) {

  const mediaShape = () => ({
    mediaModel: z.string().optional().describe('媒体绑定的精确 routeId，先调用 cron_media_models 选择，禁止猜测型号或网关'),
    imageModel: z.string().optional().describe('旧图像任务模型选择，优先使用 mediaModel'),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('绑定能力声明支持的生成参数，如 duration、resolution；不要放认证信息'),
    references: z.array(z.union([z.string(), z.object({ url: z.string(), role: z.string().optional(), mime: z.string().optional() })])).optional().describe('参考图片 URL 或 {url,role,mime}；视频首帧 role=first_frame'),
  });

  // 各工具的入参 schema（zod raw shape）。与原 JSON Schema 一一对应。
  const shapes = {
    cron_media_models: {
      modality: z.string().optional().describe('image 或 video；省略时返回两种类型'),
      includeUnavailable: z.boolean().optional().describe('是否包含未启用或连接配置不完整的绑定，默认 false'),
    },
    cron_list: { includeDisabled: z.boolean().optional().describe('是否包含已暂停的任务，默认 true') },
    cron_get: { query: z.string().describe('任务名称或 id') },
    cron_runs: { query: z.string().describe('任务名称或 id') },
    cron_toggle: { query: z.string().describe('任务名称或 id'), enabled: z.boolean().describe('true 启用 / false 暂停') },
    cron_remove: { query: z.string().describe('任务名称或 id') },
    cron_run: { query: z.string().describe('任务名称或 id') },
    cron_update: {
      ...mediaShape(),
      query: z.string().describe('任务名称或 id'),
      cron: z.string().optional(), everyMs: z.number().optional(), at: z.string().optional(),
      tz: z.string().optional().describe('IANA 时区，如 Asia/Shanghai、America/New_York；local 表示跟随系统'),
      name: z.string().optional(), type: z.string().optional().describe('保持原类型；传 command 可将 chat/image 转为命令任务'),
      prompt: z.string().optional(), command: z.string().optional(),
      workingDir: z.string().optional().describe('命令或对话任务的工作目录；传空字符串可清除'),
      memory: z.string().optional().describe('off | read | readwrite'),
      catchUp: z.boolean().optional().describe('错过计划时是否在下次启动补跑最近一次'),
      overlapPolicy: z.string().optional().describe('skip=跳过重叠触发（默认） | queueLatest=上轮结束后补跑最近一次'),
      mode: z.string().optional().describe('plain | agent'),
      agentName: z.string().optional().describe('mode=agent 时必填'),
    },
    cron_add: {
      ...mediaShape(),
      name: z.string().describe('任务名称'),
      cron: z.string().optional(), everyMs: z.number().optional(), at: z.string().optional(),
      tz: z.string().optional().describe('IANA 时区，如 Asia/Shanghai、America/New_York；local 表示跟随系统'),
      prompt: z.string().optional().describe('对话指令、图片或视频描述，或命令任务的 PowerShell 脚本'),
      command: z.string().optional().describe('命令任务的 PowerShell 脚本；type=command 时可替代 prompt'),
      workingDir: z.string().optional().describe('命令或对话任务的工作目录'),
      type: z.string().optional().describe('chat | image | video | command'),
      memory: z.string().optional().describe('长期记忆模式（chat 任务）：read=默认 | off=不用记忆 | readwrite=可读写（仅记忆整理类任务）。一般不传。'),
      catchUp: z.boolean().optional().describe('默认 true；false=错过后跳过'),
      overlapPolicy: z.string().optional().describe('skip=跳过重叠触发（默认） | queueLatest=上轮结束后补跑最近一次'),
      mode: z.string().optional().describe('plain | agent'),
      agentName: z.string().optional().describe('mode=agent 时必填'),
    },
  };

  const mk = (toolName, realName, description) => tool(
    toolName,
    description,
    shapes[realName],
    (args) => execTool(scheduler, realName, args),
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
};
