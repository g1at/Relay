'use strict';

const Context = require('../../../renderer/conversation-context');
const Continuity = require('../../../renderer/task-continuity');

const HISTORY_HEADER = '以下是我们之前的对话记录，供你参考延续：';
// This is an exact inverse of the known host envelope, not a heuristic that
// treats the last paragraph (or a quoted instruction) as a new user request.
const ASK_HINT = '\n\n---\n[原生交互] 当你确实需要用户在多个方案中选择、补充关键输入或确认取舍时，'
  + '请使用 AskUserQuestion 工具。Relay 会显示专属决策卡并把答案回传给你；'
  + '不要把本可结构化的问题改写成普通回复后结束任务。只读探查可先继续进行，'
  + '涉及权限的操作由 Relay 原生权限审批卡处理。';
const IMAGE_HINT = '\n\n---\n[图片处理须知] 区分两种情况:'
  + '(1) 你自己生成/产出的图片文件:只需在回复里用 Markdown `![描述](路径)` 引用,界面会自动渲染,'
  + '不要用 Read 去读取它(回看生成结果没有必要,且可能因模型不支持图片输入而中断后续对话)。'
  + '(2) 用户在对话里上传的图片:已随消息附上的图片请直接查看;仅提供路径时用 Read 工具读取后再回答;'
  + '若所用模型不支持图片输入而读取失败,如实告知用户即可,不要无故拒绝查看。';
const FEISHU_HINT = '\n\n---\n[系统提示] 上面包含飞书(Feishu/Lark)文档链接。请务必使用 feishu-mcp-pro '
  + '提供的 MCP 工具来读取和操作。先检查本轮当前工具列表：所需业务工具已列出时，按其原始参数调用；'
  + '若只看到名称以 relay_search_tools 开头的飞书发现入口，先通过该入口用 query 或 names 搜索并激活所需工具，'
  + '再调用返回的原始工具名。工具按需加载，看不到业务工具不代表服务离线。\n'
  + '只使用当前列表中的发现入口，不要从历史复制或猜测带随机后缀的工具名。若返回 No such tool available，'
  + '重新检查当前工具列表并通过当前入口重新发现，最多重试发现一次；入口缺失或仍失败时，报告实际错误，'
  + '提示用户在 MCP 设置中重连服务或重建会话，不要反复猜名调用，也不要自动重放可能已经生效的写入。'
  + '不要改用 WebFetch、WebSearch 或命令行抓取需要登录的飞书网页，也不要查找凭据或另行启动 MCP 服务来绕过工具发现。';
// Native transcripts can still contain the previous host envelope. Match its
// complete suffix so recovery preserves the original input without old hints.
const LEGACY_FEISHU_HINT = '\n\n---\n[系统提示] 上面包含飞书(Feishu/Lark)文档链接。请务必使用 feishu-mcp-pro '
  + '提供的 MCP 工具来读取和操作(如 wiki_get_node / doc_fetch / doc_read / doc_create / doc_write / '
  + 'doc_update / bitable_ops / sheet_ops 等)。若这些工具此刻尚未就绪,请稍等片刻后重试调用,'
  + '不要改用 WebFetch、WebSearch 或命令行(curl/Invoke-WebRequest)去抓取网页 —— 飞书文档需要登录鉴权,'
  + '直接抓网页只会拿到登录页,无法获取正文。\n'
  + '重要:飞书 MCP 提供约 50+ 个工具(涵盖文档读写、多维表格、电子表格、日历、任务、知识库等)。'
  + '如果你的工具列表中只看到部分飞书工具(例如只有读取类没有写入类),这是 MCP 工具列表加载延迟导致的,'
  + '请直接尝试调用你需要的工具名称(如 doc_create、doc_write、doc_update 等),不要因为工具列表中暂时'
  + '看不到就放弃或告诉用户工具不可用——工具实际上是存在的,直接调用即可成功。';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
const identity = value => typeof value === 'string' && value.length > 0;
const fail = (code, error) => ({ ok: false, code, error });

function extractNativeUserInput({ conversation, run, rawMessage, historyPrefix } = {}) {
  const row = rawMessage;
  if (!object(row) || row.type !== 'user' || row.uuid !== run?.runId || row.isMeta
      || row.isCompactSummary || row.isVisibleInTranscriptOnly || row.isSidechain || row.parent_tool_use_id
      || row.parentToolUseId || row.agent_id || row.subagent_type
      || row.message?.role && row.message.role !== 'user') {
    return fail('RECOVERY_MESSAGE_IDENTITY', '原生记录不属于这个用户轮次。');
  }
  const content = row.message?.content;
  let user;
  if (typeof content === 'string') user = content;
  else if (Array.isArray(content) && content.length > 0
      && content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    user = content.map(block => block.text).join('\n');
  }
  else return fail('RECOVERY_UNSUPPORTED_CONTENT', '原生消息含有无法完整还原的附件或内容块。');

  if (user.startsWith(HISTORY_HEADER)) {
    const prefix = historyPrefix === undefined
      ? Context.build(conversation, { turnIndex: run.metadata?.turnIndex }) : historyPrefix;
    if (typeof prefix !== 'string' || !prefix.startsWith(HISTORY_HEADER)
        || !user.startsWith(prefix + '\n\n')) {
      return fail('RECOVERY_HISTORY_BOUNDARY', '无法确认原生消息中历史记录与本轮输入的边界。');
    }
    user = user.slice(prefix.length + 2);
  }
  // Attachment paths, skill wrappers and old/changed host envelopes are not
  // enough evidence to invent a complete user turn. New runs use recoveryTurn.
  if (/\n\n---\n用户(?:上传了以下文件|添加了以下文件或文件夹)/.test(user)
      || user.includes('[用户图片附件内容已省略]')) {
    return fail('RECOVERY_UNSUPPORTED_CONTENT', '原生附件信息不足，无法完整还原本轮输入。');
  }
  const suffix = ASK_HINT + IMAGE_HINT;
  const at = user.indexOf(suffix);
  if (at >= 0) {
    const tail = user.slice(at + suffix.length);
    if (user.indexOf(suffix, at + suffix.length) >= 0
        || tail && !tail.startsWith('\n\n---\n[长期记忆]')) {
      return fail('RECOVERY_HOST_BOUNDARY', '无法确认原生消息中宿主提示的边界。');
    }
    user = user.slice(0, at);
    const feishuHint = [FEISHU_HINT, LEGACY_FEISHU_HINT].find(hint => user.endsWith(hint));
    if (feishuHint) user = user.slice(0, -feishuHint.length);
  }
  if (user.includes(HISTORY_HEADER) || user.includes('[Relay 工作目录迁移]')
      || /\n\n---\n\[(?:原生交互|交互须知|图片处理须知|系统提示|长期记忆)\]/.test(user)
      || user.startsWith('你现在是「任务编排者(PM)」')
      || user.startsWith('当前会话处于只读计划模式。')
      || user.startsWith('请先调用 Skill 工具加载「')
      || Continuity.normalize(run.metadata?.taskRun)?.resumedFromRunId) {
    return fail('RECOVERY_UNSUPPORTED_ENVELOPE', '原生消息含有尚不能可靠分离的宿主包装。');
  }
  if (!user.trim()) return fail('RECOVERY_EMPTY_INPUT', '原生记录没有可恢复的用户输入。');
  return { ok: true, recoveryTurn: { user, files: [], ts: run.metadata.turnTs, runId: run.runId } };
}

function recoverConversationTurn({ conversation, run, recoveryTurn, rawMessage, historyPrefix } = {}) {
  const reject = result => ({ ...result, conversation });
  if (!object(conversation) || !identity(conversation.id) || !Array.isArray(conversation.turns)
      || !object(run) || !identity(run.runId) || !time(run.metadata?.turnTs)
      || run.source?.conversationId && run.source.conversationId !== conversation.id) {
    return reject(fail('RECOVERY_IDENTITY', '无法确认任务与对话轮次的归属。'));
  }
  const turns = conversation.turns, ts = run.metadata.turnTs;
  const matches = turns.map((turn, index) => ({ turn, index })).filter(({ turn }) =>
    turn?.runId === run.runId || turn?.ts === ts);
  if (matches.length) {
    if (matches.length !== 1 || matches.some(({ turn }) =>
      identity(turn.runId) && turn.runId !== run.runId || identity(turn.ts) && turn.ts !== ts)) {
      return reject(fail('RECOVERY_CONFLICT', '任务标识或轮次时间与已有记录冲突。'));
    }
    return { ok: true, conversation, recovered: false, turnIndex: matches[0].index };
  }

  const index = run.metadata.turnIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index > turns.length) {
    return reject(fail('RECOVERY_POSITION', '缺失轮次的位置尚不能可靠恢复。'));
  }
  const before = turns[index - 1], after = turns[index];
  if (before && (!time(before.ts) || Date.parse(before.ts) >= Date.parse(ts))
      || after && (!time(after.ts) || Date.parse(after.ts) <= Date.parse(ts))) {
    return reject(fail('RECOVERY_CONFLICT', '缺失轮次的时间顺序与已有记录冲突。'));
  }
  let source = recoveryTurn === undefined ? run.metadata.recoveryTurn : recoveryTurn;
  if (source === undefined) {
    const extracted = extractNativeUserInput({ conversation, run, rawMessage, historyPrefix });
    if (!extracted.ok) return reject(extracted);
    source = extracted.recoveryTurn;
  }
  if (!object(source) || source.runId !== run.runId || source.ts !== ts || typeof source.user !== 'string'
      || source.files !== undefined && !Array.isArray(source.files)
      || source.files?.some(file => !object(file) || typeof file.path !== 'string')
      || source.skill != null && !object(source.skill)
      || !source.user.trim() && !source.files?.length && !source.skill && source.inputKind !== 'resume') {
    return reject(fail('RECOVERY_INPUT', '可恢复的原始输入不完整或与任务标识不一致。'));
  }
  const taskRun = source.taskRun === undefined ? run.metadata.taskRun : source.taskRun;
  if (taskRun !== undefined && !Continuity.normalize(taskRun)) {
    return reject(fail('RECOVERY_TASK_CLOCK', '任务计时记录无效，无法可靠恢复。'));
  }
  if (source.inputKind !== undefined && !['message', 'resume'].includes(source.inputKind)) {
    return reject(fail('RECOVERY_INPUT_KIND', '无法识别原始输入类型。'));
  }
  if (source.executionMode !== undefined && (!object(source.executionMode)
      || !['default', 'plan', 'goal'].includes(source.executionMode.kind))) {
    return reject(fail('RECOVERY_EXECUTION_MODE', '无法识别原始会话模式。'));
  }
  try {
    const turn = { user: source.user, assistant: '', files: structuredClone(source.files || []), ts, runId: run.runId };
    for (const key of ['skill', 'inputKind', 'executionMode']) if (own(source, key)) turn[key] = structuredClone(source[key]);
    if (taskRun !== undefined) turn.taskRun = structuredClone(taskRun);
    const recovered = turns.slice(); recovered.splice(index, 0, turn);
    return { ok: true, conversation: { ...conversation, turns: recovered }, recovered: true, turnIndex: index };
  } catch (_) {
    return reject(fail('RECOVERY_INPUT', '原始输入包含无法持久保存的数据。'));
  }
}

module.exports = { recoverConversationTurn, extractNativeUserInput };
