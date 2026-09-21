// app.js — renderer

const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────
// marked 安全配置:绝不把模型输出里的原始 HTML 当作真 DOM 注入
//   - 修复:模型把 ```html 围栏粘在文字行尾(不在行首)时,CommonMark 不识别为代码块,
//     默认会把 <style>/<button> 等当作 raw HTML 直接渲染 → 整个计算器控件被注入、样式串台。
//   - 同时关闭这个 XSS 口子(模型输出里的任意 HTML/JS 不应在渲染进程执行)。
//   做法:重写 renderer.html(块级)/ tokenizer 的 inline html,统一转义为纯文本。
if (typeof marked !== 'undefined') {
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
  const hasHljs = typeof hljs !== 'undefined';
  // Reuse completed fences across streaming updates; bound retained source+HTML.
  const codeCache = new Map();
  let codeCacheSize = 0;
  // 重写 token 渲染:
  //   - html:块级/行内原始 HTML 一律转义为纯文本,绝不注入 DOM(安全 + 修计算器注入问题)
  //   - code:用 highlight.js 做语法高亮,输出 <pre><code class="hljs language-xx">高亮 HTML</code></pre>
  // marked v5+ 把这些 token 交给 renderer 对应方法,token 形如 { text, lang }。
  marked.use({
    breaks: true,
    renderer: {
      html(token) {
        const raw = typeof token === 'string' ? token : (token && token.text) || '';
        return escHtml(raw);
      },
      image(...args) { return window.RelayLocalMarkdownImages?.image(...args) ?? false; },
      code(token) {
        // 兼容新旧签名:新版传 token 对象,老版传 (code, infostring)
        let code, lang;
        if (typeof token === 'object' && token) { code = token.text || ''; lang = (token.lang || '').trim(); }
        else { code = token || ''; lang = (arguments[1] || '').trim(); }
        lang = lang.split(/\s+/)[0].toLowerCase();   // ```js foo → 取 js
        // 常见别名归一(hljs 里 HTML 注册名是 xml)
        const ALIAS = { html: 'xml', htm: 'xml', vue: 'xml', js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', yml: 'yaml', 'c++': 'cpp', py: 'python' };
        if (ALIAS[lang]) lang = ALIAS[lang];
        const cacheKey = lang + '\0' + code;
        if (codeCache.has(cacheKey)) return codeCache.get(cacheKey);
        let html, cls = 'hljs';
        if (hasHljs && lang && hljs.getLanguage(lang)) {
          try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; cls += ' language-' + lang; }
          catch { html = escHtml(code); }
        } else if (hasHljs) {
          try { const r = hljs.highlightAuto(code); html = r.value; if (r.language) cls += ' language-' + r.language; }
          catch { html = escHtml(code); }
        } else {
          html = escHtml(code);
        }
        const rendered = `<pre><code class="${cls}">${html}</code></pre>`;
        const size = cacheKey.length + rendered.length;
        if (size <= 256000) {
          while (codeCache.size && (codeCache.size >= 96 || codeCacheSize + size > 1000000)) {
            const oldest = codeCache.keys().next().value;
            codeCacheSize -= oldest.length + codeCache.get(oldest).length; codeCache.delete(oldest);
          }
          codeCache.set(cacheKey, rendered); codeCacheSize += size;
        }
        return rendered;
      },
    },
  });
}

// 渲染 markdown 前先修正模型常见的"围栏粘行"问题:
//   把粘在文字行尾的 ``` 或开/闭围栏拆到独立行,否则 CommonMark 不识别为代码块,
//   会把整段代码当普通文字/原始 HTML 处理(就是计算器那种乱象的根源)。
function normalizeFences(md) {
  let s = String(md || '');
  // 只处理"围栏粘在前面文字行尾"这一种(如「…即可使用。```html」)→ 把围栏前补一个换行,
  //   让它落到行首,CommonMark 才认作代码块。注意保留围栏后的语言信息串(```html 不能拆开)。
  s = s.replace(/([^\n`])(```+)/g, '$1\n$2');
  return s;
}
function renderMarkdown(text) {
  // 兜底:marked.parse 偶遇畸形 markdown 会直接抛异常,一路炸穿所有调用方
  //   (最致命的是 finishRun 收尾被跳过,转圈永远关不掉)。这里捕获后
  //   回退为转义纯文本(<pre> 保留换行),内容一个字不丢。
  try {
    return marked.parse(normalizeFences(text));
  } catch (e) {
    console.error('renderMarkdown: marked.parse 解析失败,回退纯文本渲染', e);
    return `<pre class="md-fallback">${escapeHtml(text)}</pre>`;
  }
}
// Activity stream is loaded as an isolated renderer module. Expose the same
// configured/safe Markdown pipeline so thinking rows do not maintain a second parser.
window.relayRenderMarkdown = renderMarkdown;
const streamMarkdownRenderer = window.RelayStreamMarkdown.create({ marked, normalize: normalizeFences, fallback: renderMarkdown });

const messagesEl = $('messages');
const conversationIndexEl = $('conversationIndex');
const conversationIndexKeysEl = $('conversationIndexKeys');
const inputEl    = $('input');
const sendBtn    = $('btnSend');
let isRunning = false;
const historyEl  = $('historyList');
let historyRefreshRevision = 0; // 初始加载会在文件后半段执行之前请求历史。
const chatTitle  = $('chatTitle');
const inputCard    = $('inputCard');
const attachmentsEl= $('attachments');
const btnAttach    = $('btnAttach');
const btnModelSwitch = $('btnModelSwitch');
const msIco        = $('msIco');
const msLabel      = $('msLabel');
const contextUsageEl = $('contextUsage');
const contextUsageLabel = $('contextUsageLabel');
const contextUsagePopover = $('contextUsagePopover');
const contextUsagePercent = $('contextUsagePercent');
const contextUsageTokens = $('contextUsageTokens');
const msEffortLabel = $('msEffortLabel');
const skillQuickClear = $('skillQuickClear');
const composerSkillChip = $('composerSkillChip');
const composerSkillLabel = $('composerSkillLabel');

let attachedFiles = [];            // 待发送附件 [{ path, name, ext, size }]
let currentModel  = 'haiku';       // 模型档位:haiku=快速 / sonnet=思考 / opus=专家
let currentEffort = null;          // SDK effort；拿到 supportedModels() 后才按模型能力设置
let defaultModel  = 'haiku';       // 用户在设置里选的「默认使用」档;「新对话」回到它(不带历史会话的档位)
let supportedClaudeModels = [];    // SDK 返回的模型能力目录；不是已配置路由的准入名单
let supportedClaudeProviderId = '';
let claudeRuntimeUIRevision = 0;     // 防止迟到的能力读取或模型切换覆盖新的界面选择
let claudeRuntimeReadRevision = 0;
let pendingClaudeRuntimeSelection = null;
let providerRouting = { defaultModel: 'haiku', chatRoutes: [], imageRoutes: [] };
let providerRoutingLoaded = false;
let providerRuntimeChangeOff = null;
let contextUsageEnabled = true;
const contextUsageByConv = new Map();
const contextUsageReadRevisions = new Map();
let contextUsagePollTimer = null;
let contextUsagePollRevision = 0;
let contextUsagePollKey = '';
let contextUsagePollInFlight = null;
let selectedQuickSkill = null;      // 输入区快捷选择的技能；仅作用于下一条消息
let quickSkillMetadataBackfillStarted = false;

// 图片附件判定:扩展名命中常见图片格式即视为图片(IMAGE_EXTS 定义在下方附件上传区,
//   这两个函数只在运行时被调用,届时该常量已初始化,故此处前向引用安全)。
//   用途:某轮带图却失败收尾时,据此给「模型可能不支持读图」的友好提示(纯文本模型 Read 图会崩,退出码 1)。
function fileIsImage(f) {
  if (!f) return false;
  const ext = (f.ext || (f.name || '').split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.includes(ext);
}
function hasImageAttachment(files) {
  return Array.isArray(files) && files.some(fileIsImage);
}
// 档位 → 中文标签(用于提示文案)。与 MODEL_TIERS 一致:快速/思考/专家。
const TIER_LABEL = { haiku: '快速', sonnet: '思考', opus: '专家' };

// ─────────────── 状态 ───────────────
let currentSessionId = null;       // 当前【所看】会话的 claude --resume sessionId
let currentAssistantBubble = null; // 当前【所看】会话流式更新中的 assistant 气泡 DOM
let currentConv = null;            // 当前【显示】的会话 { id, title, sessionId, ..., turns: [], mode }
let currentMode = 'plain';         // 'agent' = 调用某个子智能体 / 'orchestrate' = 多 Agent 协同 / 'plain' = 纯 Claude 聊
let currentAgent = null;           // agent 模式下选中的子智能体真实 id(传给 Claude 用,如 'feature-dev')
let currentAgentLabel = null;      // 该 Agent 的显示名(用户自定义优先,仅界面展示)
let currentOrchestrateAgents = null;  // 协作选中的 Agent name 数组；旧历史的 null 保持自动调度语义
let currentWorkingDir = null;      // 当前【所看】对话的工作目录({path,name} 或 null);LLM 文件读写落点,随会话保存
let currentProjectId = null;
let pageNavigationVersion = 0;
let currentExecutionMode = { kind: 'default' };
let projectComposer = null;
let permissionControls = null;
let currentPermissionState = null;
let permissionLoadPromise = null;
let permissionViewRevision = 0;
let permissionModeEditRevision = 0;
let permissionMutation = null;
let permissionEventsReady = false;


// Reserve a stable folder identity before the first message (e.g. when opening a terminal).
// The first history record adopts the same id; browsing files alone creates no history row.
let workspaceDraftId = null;
window.relayConversationWorkspace = () => ({
  conversationId: currentConv && currentConv.id || (workspaceDraftId ||= newClientRunId()),
  title: currentConv && currentConv.title || '新对话',
  workingDir: currentWorkingDir && currentWorkingDir.path || null,
  projectId: currentProjectId,
  mode: currentMode,
  agentName: currentAgent,
});

function emitConversationChanged(conversationId = null, { loading = false } = {}) {
  window.dispatchEvent(new CustomEvent('relay:conversation-changed', {
    detail: { conversationId: conversationId || null, mode: currentMode, loading },
  }));
}

// ─────────────── 并行运行态(支持多对话同时跑)───────────────
//   每个【正在跑】的会话一条 run,按 convId 索引。数据始终在这里累积(不管用户在不在看),
//   只有当某个 run 的 convId === 当前所看会话时,事件才同时更新 DOM。
//   run = {
//     jobId,            后端进程标识(中止/分发用)
//     convId,           归属会话
//     sessionId,        该会话的 --resume id(随事件更新)
//     turn,             正在收集的 turn { user, assistant, thinkingList[], files, ts }
//     sessionModel,     本轮运行所用模型档位
//   }
const runs = new Map();            // convId → run
const jobToConv = new Map();       // jobId → convId(事件只带 jobId,用它反查 conv)
const supplementDrafts = new Map(); // conversation id -> retryable supplemental input with stable message ID
// Drafts stay in this renderer and never update conversation history timestamps.
// The owner object also follows slow attachment imports across view switches.
const composerDrafts = new Map();
let composerDraftOwner = {};
let followUpMode = 'steer';
let agentEnvironment = 'native';
const conversationControls = new Map(); // one pause/steer operation per conversation
const pendingConversationSends = new Set(); // conversation id → initial history write awaiting completion
const pendingConversationSaves = new Map(); // Track only chat persistence; terminals do not wait on it.
const unsavedWorkspaceConversations = new WeakSet(); // local objects whose first history write has not succeeded
// 进行中的创作生成：convId → { runId, turnIndex, restored }。放在通用运行态旁边，
// 让启动时的任务账本恢复也能在创作视图脚本执行到之前安全登记。
const cvJobs = new Map();
function newClientRunId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Electron 32 正常都有 randomUUID；这里只给极端旧运行时一个 UUID 形状的兼容兜底。
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const n = Math.floor(Math.random() * 16);
    return (ch === 'x' ? n : ((n & 0x3) | 0x8)).toString(16);
  });
}
function runForJob(jobId) {
  const convId = jobToConv.get(jobId);
  return convId ? runs.get(convId) : null;
}
// 某个会话是否正在跑
function isConvRunning(convId) { return !!(convId && (runs.has(convId) || cvJobs.has(convId))); }
// 事件所属会话是否正是当前所看的会话(决定要不要动 DOM)
function isMountedChatJob(jobId) {
  const convId = jobToConv.get(jobId);
  return !!(convId && currentConv && currentConv.id === convId);
}

// ── 对话快捷索引（竖向钢琴键） ──
// 锚点按 turn 单独存在，不依赖消息气泡或结构化活动流的具体 DOM。
let conversationIndexFrame = 0;
let conversationIndexWaveFrame = 0;
let conversationIndexPointerY = null;
let conversationIndexEnabled = true;

function appendConversationTurnAnchor(turnIndex) {
  const index = Number(turnIndex);
  const existing = messagesEl.querySelector(`.conversation-turn-anchor[data-turn-anchor="${index}"]`);
  if (existing) return existing;
  const anchor = document.createElement('span');
  anchor.className = 'conversation-turn-anchor';
  anchor.dataset.turnAnchor = String(index);
  anchor.setAttribute('aria-hidden', 'true');
  messagesEl.appendChild(anchor);
  return anchor;
}

function clearConversationIndex() {
  resetConversationIndexWave();
  if (conversationIndexKeysEl) conversationIndexKeysEl.replaceChildren();
  if (conversationIndexEl) conversationIndexEl.classList.add('hidden');
}

function layoutConversationIndexKeys(count) {
  if (!conversationIndexEl || !conversationIndexKeysEl || !count) return;
  const available = Math.max(40, conversationIndexEl.clientHeight - 8);
  let gap = 6;
  let keyHeight = 3;
  const preferredHeight = count * keyHeight + Math.max(0, count - 1) * gap;
  if (preferredHeight > available) {
    const minReadableKeyHeight = count > 220 ? 1 : (count > 140 ? 1.5 : 2);
    gap = count > 1
      ? Math.max(0, Math.min(6, (available - count * minReadableKeyHeight) / (count - 1)))
      : 0;
    keyHeight = Math.max(
      minReadableKeyHeight,
      Math.min(3, (available - Math.max(0, count - 1) * gap) / count),
    );
  }
  const stackHeight = Math.min(
    available,
    count * keyHeight + Math.max(0, count - 1) * gap,
  );
  conversationIndexEl.style.setProperty('--index-key-gap', `${gap}px`);
  conversationIndexKeysEl.style.setProperty('--index-stack-height', `${stackHeight}px`);
}

function updateConversationIndexPosition() {
  if (!conversationIndexEl || !conversationIndexKeysEl) return;
  // Width changes already relayout the visible chat. Defer the optional index
  // measurements until release, instead of measuring every history anchor.
  if (document.querySelector('.app.is-workspace-resizing, .app.is-sidebar-resizing')) return;
  const keys = Array.from(conversationIndexKeysEl.children);
  const anchors = Array.from(messagesEl.querySelectorAll('.conversation-turn-anchor'));
  const hasRoom = messagesEl.clientWidth >= 860;
  const hasScrollableContent = messagesEl.scrollHeight - messagesEl.clientHeight > 90;
  const shouldShow = conversationIndexEnabled
    && keys.length >= 2
    && anchors.length === keys.length
    && hasRoom
    && hasScrollableContent;
  conversationIndexEl.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;
  layoutConversationIndexKeys(keys.length);

  let activeIndex = 0;
  if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 28) {
    activeIndex = anchors.length - 1;
  } else {
    const readingLine = messagesEl.scrollTop + Math.min(messagesEl.clientHeight * 0.3, 180);
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].offsetTop <= readingLine) activeIndex = i;
      else break;
    }
  }

  keys.forEach((key, index) => {
    const active = index === activeIndex;
    key.classList.toggle('is-active', active);
    if (active) key.setAttribute('aria-current', 'true');
    else key.removeAttribute('aria-current');
  });
}

window.addEventListener('relay:workspace-resize-end', () => {
  scheduleConversationIndexUpdate(); scrollToBottom();
});

function scheduleConversationIndexUpdate() {
  if (conversationIndexFrame) return;
  conversationIndexFrame = requestAnimationFrame(() => {
    conversationIndexFrame = 0;
    updateConversationIndexPosition();
  });
}

function applyConversationIndexWave() {
  conversationIndexWaveFrame = 0;
  if (conversationIndexPointerY == null || !conversationIndexEl || !conversationIndexKeysEl) return;
  const keys = Array.from(conversationIndexKeysEl.children);
  if (!keys.length) return;
  const stackRect = conversationIndexKeysEl.getBoundingClientRect();
  const localY = conversationIndexPointerY - stackRect.top;
  // 波浪只影响鼠标附近的一小段琴键，避免纵向扩散过高、整条索引一起起伏。
  const radius = Math.min(36, Math.max(18, stackRect.height * 0.09));
  keys.forEach((key) => {
    const center = key.offsetTop + key.offsetHeight / 2;
    const distance = Math.abs(center - localY);
    const strength = distance >= radius
      ? 0
      : Math.pow(Math.cos((distance / radius) * Math.PI / 2), 1.35);
    const baseWidth = key.classList.contains('is-active') ? 38 : 12;
    const targetWidth = 12 + strength * 24;
    key.style.setProperty('--wave-width', `${Math.max(0, targetWidth - baseWidth).toFixed(2)}px`);
    key.style.setProperty('--wave-shift', '0px');
  });
}

function scheduleConversationIndexWave(clientY) {
  conversationIndexPointerY = clientY;
  if (conversationIndexWaveFrame) return;
  conversationIndexWaveFrame = requestAnimationFrame(applyConversationIndexWave);
}

function resetConversationIndexWave() {
  conversationIndexPointerY = null;
  if (conversationIndexWaveFrame) {
    cancelAnimationFrame(conversationIndexWaveFrame);
    conversationIndexWaveFrame = 0;
  }
  if (!conversationIndexKeysEl) return;
  conversationIndexKeysEl.querySelectorAll('.conversation-index-key').forEach((key) => {
    key.style.removeProperty('--wave-width');
    key.style.removeProperty('--wave-shift');
  });
}

function conversationTurnQuestion(turn) {
  const files = turn && Array.isArray(turn.files) ? turn.files : [];
  const fileLabel = files.map((file) => String(file && file.name || '').trim()).filter(Boolean).join('、');
  const raw = String((turn && turn.user) || fileLabel || '附件消息')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '附件消息';
  return raw.length > 72 ? `${raw.slice(0, 72)}…` : raw;
}

function setConversationIndexEnabled(enabled) {
  conversationIndexEnabled = enabled !== false;
  if (!conversationIndexEnabled) {
    resetConversationIndexWave();
    if (conversationIndexEl) conversationIndexEl.classList.add('hidden');
    return;
  }
  refreshConversationIndex();
}

function refreshConversationIndex() {
  if (!conversationIndexEl || !conversationIndexKeysEl) return;
  const turns = currentConv && Array.isArray(currentConv.turns) ? currentConv.turns : [];
  if (!turns.length) {
    clearConversationIndex();
    return;
  }

  const fragment = document.createDocumentFragment();
  turns.forEach((turn, index) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'conversation-index-key';
    key.dataset.turnIndex = String(index);
    key.dataset.label = conversationTurnQuestion(turn);
    key.setAttribute('aria-label', `跳转到：${key.dataset.label}`);
    key.addEventListener('click', () => {
      const anchor = messagesEl.querySelector(
        `.conversation-turn-anchor[data-turn-anchor="${key.dataset.turnIndex}"]`,
      );
      if (!anchor) return;
      stopFollowingMessages();
      anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      requestAnimationFrame(scheduleConversationIndexUpdate);
    });
    fragment.appendChild(key);
  });

  conversationIndexKeysEl.replaceChildren(fragment);
  conversationIndexKeysEl.style.setProperty('--turn-count', String(turns.length));
  scheduleConversationIndexUpdate();
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { scheduleConversationIndexUpdate(); scrollToBottom(); }).observe(messagesEl);
}
window.addEventListener('resize', scheduleConversationIndexUpdate);
if (conversationIndexEl) {
  conversationIndexEl.addEventListener('pointermove', (event) => {
    scheduleConversationIndexWave(event.clientY);
  });
  conversationIndexEl.addEventListener('pointerleave', resetConversationIndexWave);
}

// ── Claude Code 结构化过程流 ──
// 普通、单个 Agent 与多个 Agent 协作共用同一条过程流。
function newActivityState(saved = null) {
  return window.RelayActivity ? window.RelayActivity.createState(saved || undefined) : null;
}
function appendActivityState(state, collapsed = false, options = {}) {
  if (!state || !window.RelayActivity) return null;
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();
  const el = window.RelayActivity.createElement(state, { collapsed, collapseOnComplete: true, ...options });
  const subagents = document.createElement('button');
  subagents.type = 'button'; subagents.className = 'session-subagents'; subagents.textContent = '子智能体记录';
  subagents.title = '按需查看这轮任务的原生子智能体历史';
  subagents.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (el.dataset.conversationId && el.dataset.jobId) void window.relaySubagentHistory?.open({ convId: el.dataset.conversationId, runId: el.dataset.jobId });
  });
  el.appendChild(subagents);
  syncSubagentHistoryEntry(el, state);
  if (currentConv?.id) el.dataset.conversationId = currentConv.id;
  messagesEl.appendChild(el);
  window.RelayActivity.syncTaskSummary(el);
  scrollToBottom();
  return el;
}
function syncSubagentHistoryEntry(element, state) {
  element.classList.toggle('has-subagents', !!state?.items?.some(item => /^(Agent|Task)$/.test(item.toolName || '')
    || item.type === 'task' && /agent/i.test(item.taskType || item.task_type || '')));
}
// Only persisted, validated task metadata links pause/resume runs. Identical
// manually typed prompts and legacy text remain independent user messages.
function taskSegmentForTurn(turn, turns = currentConv?.turns || []) {
  const taskRun = window.RelayTaskContinuity?.normalize(turn?.taskRun);
  if (!taskRun) return turns.some(next => window.RelayTaskContinuity?.isResume(next)
    && next.taskRun.resumedFromRunId === turn?.runId) ? 'previous' : 'current';
  const latest = window.RelayTaskContinuity.latestTurn(turns, taskRun.taskId);
  return latest && latest !== turn && latest.runId !== turn.runId ? 'previous' : 'current';
}
function taskSummaryKeyForTurn(turn, turns = currentConv?.turns || []) {
  const taskRun = window.RelayTaskContinuity?.normalize(turn?.taskRun);
  if (taskRun) return taskRun.taskId;
  const resumed = turns.find(next => window.RelayTaskContinuity?.isResume(next)
    && next.taskRun.resumedFromRunId === turn?.runId);
  return resumed?.taskRun.taskId || turn?.runId || turn?.ts || null;
}
function retirePreviousTaskProcesses(taskRun, { retry = false } = {}) {
  if (!taskRun || !retry && !taskRun.resumedFromRunId) return;
  for (const element of messagesEl.querySelectorAll('.process-stream')) {
    const state = element._processState;
    if (state && (state.taskRun?.taskId === taskRun.taskId || element.dataset.jobId === taskRun.resumedFromRunId)) {
      window.RelayActivity.updateElement(element, state, { segment: 'previous' });
    }
  }
}
function activityStateForTurn(turn) {
  if (!window.RelayActivity || !turn) return null;
  let state = turn.activity && Array.isArray(turn.activity.items) ? window.RelayActivity.hydrate(turn.activity)
    : turn.thinking ? window.RelayActivity.fromLegacy(turn.thinking) : null;
  const taskRun = window.RelayTaskContinuity?.normalize(turn.taskRun);
  if (taskRun) { if (!state) state = newActivityState(); state.taskRun = taskRun; }
  const output = turn.output ? window.RelayAssistantOutput.createState(turn.output) : null;
  if (output) {
    if (!state) state = newActivityState();
    const items = activityOutputItems(output, state.items);
    state.items = window.RelayAssistantOutput.mergeActivityItems(state.items, items);
  }
  // 旧协作记录保留原始数据；仅在显示时将群聊日志映射为过程与子任务。
  // 最后一段 PM 文字可能仍是规划，不能据此猜测最终答案。
  const finalText = savedAssistantDisplay(turn).text;
  for (const [index, entry] of (Array.isArray(turn.chat) ? turn.chat : []).entries()) {
    const text = String(entry && entry.text || '');
    if (!entry || !text || text === finalText) continue;
    if (output && output.messages.some((message) => (
      entry.role === 'pm' ? !message.parent : message.parent && (!entry.toolUseId || message.parent === entry.toolUseId)
    ) && window.RelayAssistantOutput.textFor(message) === text)) continue;
    if (!state) state = newActivityState();
    if (state.items.some((item) => item.id === `legacy-collaboration:${index}`)) continue;
    if (entry.toolUseId && state.items.some((item) => item.toolUseId === entry.toolUseId && item.result === text)) continue;
    const diagnostic = window.RelayAssistantOutput.splitProtocol(text).diagnostics.length > 0;
    const agent = entry.role === 'agent';
    state.items.push({
      id: `legacy-collaboration:${index}`, type: diagnostic ? 'diagnostic' : agent ? 'task' : 'narration',
      title: diagnostic ? '历史工具协议文本（已隔离）' : agent ? (entry.agent || 'Agent') : '执行过程',
      detail: agent ? '历史 Agent 执行结果' : '', result: text,
      ...(agent ? { toolUseId: entry.toolUseId || null, subagentType: entry.agent || null } : {}),
      status: entry.status === 'failed' || entry.status === 'error' ? 'error' : 'success',
    });
  }
  // 旧版本偶有群聊日志未覆盖全部聚合正文的情况：完整保留在可展开详情，避免遗漏。
  if (!output && Array.isArray(turn.chat) && turn.chat.length && turn.assistant) {
    let uncovered = String(turn.assistant);
    for (const entry of turn.chat) {
      if (entry && entry.text) uncovered = uncovered.replace(String(entry.text), '');
    }
    uncovered = uncovered.replace(/\*\*(?:PM\s*→\s*)?@[^*]+\*\*[:：]\s*/g, '').trim();
    if (uncovered) {
      if (!state) state = newActivityState();
      if (!state.items.some((item) => item.id === 'legacy-collaboration:transcript')) state.items.push({
        id: 'legacy-collaboration:transcript', type: 'task', title: '历史协作完整记录',
        detail: '保留原始记录中未归入单独条目的内容', result: String(turn.assistant), status: 'success',
      });
    }
  }
  if (state && !turn.activity) state.phase = output && output.status === 'running' ? 'running'
    : output && ['error', 'canceled'].includes(output.status) ? 'error' : 'complete';
  if (state) {
    // Older records stored an SDK attempt duration/early result timestamp. The
    // persisted user-send and final-answer times span the actual task instead.
    // Mini-chat persists the same clock on its turn, without an activity blob.
    if (!state.taskStartedAt && Number.isFinite(turn.taskStartedAt) && turn.taskStartedAt > 0) state.taskStartedAt = turn.taskStartedAt;
    if (!state.taskFinishedAt && Number.isFinite(turn.taskFinishedAt) && turn.taskFinishedAt >= state.taskStartedAt) {
      state.taskFinishedAt = turn.taskFinishedAt;
      state.taskDurationMs = Number.isFinite(turn.taskDurationMs) ? turn.taskDurationMs : turn.taskFinishedAt - state.taskStartedAt;
    }
    const startedAt = Date.parse(turn.ts), finishedAt = Date.parse(turn.assistantTs);
    if (!state.taskStartedAt && Number.isFinite(startedAt)) state.startedAt = startedAt;
    if (!state.taskFinishedAt && Number.isFinite(finishedAt) && finishedAt >= state.startedAt
        && (turn.status === 'complete' || output?.status === 'complete' || !!turn.assistant)) state.endedAt = finishedAt;
  }
  return state;
}
function activityOutputItems(output, activityItems = []) {
  const existing = Array.isArray(activityItems) ? activityItems : [];
  return window.RelayAssistantOutput.processItems(output, { includeChildren: true }).filter((item) => {
    if (item.type !== 'narration') return true;
    const child = output.messages.find((message) => message.parent
      && item.id.startsWith(`output:${message.parent}:${message.id}:`));
    if (!child) return true;
    // 流式子文本先显示在过程区；同一内容已进入子任务详情后，仅保留一份可见结果。
    return !existing.some((task) => (task.type === 'task' || task.type === 'tool')
      && task.toolUseId === child.parent && task.result && String(task.result).includes(item.result));
  });
}
function outputStateForRun(run) {
  if (!run.outputState) run.outputState = window.RelayAssistantOutput.createState(run.turn.output);
  return run.outputState;
}
function syncRunOutputActivity(run, onView) {
  if (run.outputRenderTimer) { clearTimeout(run.outputRenderTimer); run.outputRenderTimer = null; }
  const output = outputStateForRun(run);
  // A streamed message may still be followed by tools, another SDK round or an
  // in-turn requirement. Keep one process presentation until job-done confirms
  // the answer, instead of briefly displaying and retracting an answer bubble.
  const items = activityOutputItems(output, run.activityState && run.activityState.items);
  if (!run.activityState && items.length) run.activityState = newActivityState();
  if (run.activityState) {
    run.activityState.items = window.RelayAssistantOutput.mergeActivityItems(run.activityState.items, items);
    if (!hasSupplementTimeline(run.turn)) updateRunActivity(run, onView, true);
  }
  if (onView) {
    if (hasSupplementTimeline(run.turn)) renderSupplementTimeline(run);
    else renderRunOutput(run);
  }
}
function scheduleRunOutputActivity(run, onView, force = false) {
  if (force) { syncRunOutputActivity(run, onView); return; }
  if (run.outputRenderTimer) return;
  run.outputRenderTimer = setTimeout(() => {
    run.outputRenderTimer = null;
    if (runForJob(run.jobId) !== run || run.finishing) return;
    syncRunOutputActivity(run, isMountedChatJob(run.jobId));
  }, 100);
}
function savedAssistantDisplay(turn) {
  // 早期协作的 assistant 是派活、子结果和 PM 所有发言的聚合日志，并非最终答案。
  if (turn && !turn.output && Array.isArray(turn.chat) && turn.chat.length) return { text: '', diagnostics: [] };
  const text = String(turn && (turn.assistant || (turn.output && turn.output.status === 'complete' && turn.output.final)) || '');
  if (['（任务已完成，但刷新前的最终回复没有保存在可恢复的本地事件中。请在任务中心查看详情或重新执行。）', '（任务已结束，但未取得可恢复的最终回复。请在任务中心查看详情或重新执行。）'].includes(text)) {
    return { text: '（任务已结束，但未取得可恢复的最终回复。可以重新发送请求。）', diagnostics: [] };
  }
  const split = window.RelayAssistantOutput.splitProtocol(text);
  return { text: split.text, diagnostics: split.diagnostics };
}
function appendSavedTurnError(turn, turnIndex) {
  const error = window.RelayConversationErrors.forTurn(turn);
  if (!error) return null;
  const el = appendMessage('error', error);
  if (el) {
    el.dataset.turn = String(turnIndex);
    if (turn.runId) el.dataset.errorRun = turn.runId;
  }
  return el;
}
function showRunError(run, error) {
  if (!error) return;
  let el = run.errorEl;
  if (el && el.isConnected) {
    if (el.dataset.raw !== error) {
      el.innerHTML = window.RelayActivity.renderError(error);
      el.dataset.raw = error;
    }
  } else {
    el = run.errorEl = appendMessage('error', error);
    if (el) { el.dataset.turn = String(run.turnIndex ?? 0); el.dataset.errorRun = run.jobId; }
  }
}

function appendLegacyOutputDiagnostics(parts) {
  if (!parts.length) return;
  const state = newActivityState();
  state.phase = 'complete';
  state.items = parts.map((text, index) => ({
    id: 'legacy-output:' + index, type: 'diagnostic', status: 'success',
    title: '历史回复中的工具协议文本（已隔离）',
    detail: '原始内容保留在详情中；实际工具状态请查看对应工具活动。',
    result: text, outputOwned: true,
  }));
  appendActivityState(state, true);
}

function activityEventNeedsRender(evt) {
  if (!evt || evt.type !== 'stream_event') return true;
  const raw = evt.event || {};
  if (raw.type === 'content_block_start' || raw.type === 'content_block_stop' || raw.type === 'error') return true;
  const deltaType = raw.delta && raw.delta.type;
  return deltaType === 'thinking_delta' || deltaType === 'input_json_delta';
}
function hasSupplementTimeline(turn) {
  return !!window.RelaySupplementTimeline && (turn && turn.supplements || [])
    .some(input => window.RelaySupplementTimeline.normalize(input.presentation));
}

// Keep a keyed DOM range for each turn. A supplement cuts the presentation at
// send time; later tokens/tools update their own segment without moving the
// user's interruption above already visible work or rebuilding the transcript.
function renderSupplementTimeline(run, history = false) {
  const output = outputStateForRun(run);
  const segments = window.RelaySupplementTimeline.plan({ output,
    activityItems: run.activityState && run.activityState.items || [],
    supplements: run.turn.supplements || [] });
  let timeline = run.supplementTimeline;
  if (!timeline || !timeline.end.isConnected) {
    const start = document.createComment('supplement timeline');
    const end = document.createComment('end supplement timeline');
    const previous = [run.activityEl, run.outputBubble].filter(node => node && node.parentNode === messagesEl);
    if (previous.length) {
      messagesEl.insertBefore(start, previous[0]);
      messagesEl.insertBefore(end, previous[previous.length - 1].nextSibling);
    } else { messagesEl.append(start, end); }
    timeline = run.supplementTimeline = { start, end, segments: new Map() };
    if (previous.length) timeline.segments.set('start', { activity: run.activityEl, bubble: run.outputBubble });
  }
  const desired = [], active = output.status === 'running';
  const lastTextIndex = segments.findLastIndex(segment => !!segment.text);
  let latestBubble = null;
  segments.forEach((segment, index) => {
    let view = timeline.segments.get(segment.key);
    if (!view) { view = {}; timeline.segments.set(segment.key, view); }
    const state = { ...(run.activityState || newActivityState()), items: segment.items };
    const last = index === segments.length - 1;
    const processOptions = { collapseOnComplete: true, segment: last ? taskSegmentForTurn(run.turn) : 'previous',
      taskKey: taskSummaryKeyForTurn(run.turn) };
    const showProcess = index === 0 || segment.items.length || last && (active || !!run.activityState);
    if (showProcess) {
      if (!view.activity || !view.activity.isConnected) view.activity = appendActivityState(state, history, processOptions);
      else window.RelayActivity.updateElement(view.activity, state, processOptions);
      if (view.activity) {
        view.activity.dataset.turn = String(run.turnIndex ?? 0);
        view.activity.dataset.conversationId = run.convId || currentConv?.id || '';
        view.activity.dataset.jobId = run.jobId || run.turn?.runId || '';
        syncSubagentHistoryEntry(view.activity, state);
        desired.push(view.activity);
      }
    } else if (view.activity) { view.activity.remove(); view.activity = null; }
    if (segment.text) {
      if (!view.bubble || !view.bubble.isConnected) view.bubble = appendMessage('assistant', segment.text, null, { streaming: true });
      const bubble = view.bubble, body = bubble.querySelector('.body');
      bubble.dataset.turn = String(run.turnIndex ?? 0);
      bubble.dataset.raw = segment.text;
      const displayText = segment.displayText ?? segment.text;
      bubble.dataset.displayRaw = displayText;
      bubble.dataset.timelinePartial = String(active || index !== lastTextIndex);
      bubble.classList.toggle('is-streaming', active && last);
      if (body._relayRenderedText !== displayText) {
        streamMarkdownRenderer.render(body, displayText);
        body._relayRenderedText = displayText;
      }
      if (!active) {
        enhanceCodeBlocks(body, { collapse: false });
        streamMarkdownRenderer.release(body);
      }
      if (!active && index === lastTextIndex && output.final) {
        bubble.dataset.copyRaw = output.final;
        appendAssistantCopy(bubble);
        if (history && run.turn.assistantTs) appendMessageTime(bubble, run.turn.assistantTs);
      } else {
        delete bubble.dataset.copyRaw;
        bubble.querySelector('.assistant-actions')?.remove();
      }
      desired.push(bubble); latestBubble = bubble;
    } else if (view.bubble) {
      streamMarkdownRenderer.release(view.bubble.querySelector('.body'));
      view.bubble.remove(); view.bubble = null;
    }
    if (segment.inputAfter) desired.push(appendSupplementMessage(segment.inputAfter, run.turnIndex));
  });
  // Only move a node when its actual neighbour changed. Stream deltas keep DOM,
  // selection, expanded tool details and cached Markdown blocks in place.
  let before = timeline.end;
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const node = desired[index];
    if (!node) continue;
    if (node.nextSibling !== before) messagesEl.insertBefore(node, before);
    before = node;
  }
  run.activityEl = null; run.outputBubble = latestBubble;
  // Ordering is now final: the earliest process owns the task header even
  // when the last/current segment is empty or belongs to a resumed run.
  const firstActivity = [...timeline.segments.values()].find(view => view.activity)?.activity;
  if (firstActivity) window.RelayActivity.syncTaskSummary(firstActivity, taskSummaryKeyForTurn(run.turn));
  currentAssistantBubble = latestBubble;
  scrollToBottom();
}

function updateRunActivity(run, onView, force = false) {
  if (!run || !run.activityState || !window.RelayActivity || !onView) return;
  if (hasSupplementTimeline(run.turn)) {
    if (force) renderSupplementTimeline(run);
    return;
  }
  if (!run.activityEl || !run.activityEl.isConnected) {
    run.activityEl = appendActivityState(run.activityState, false);
  } else if (force) {
    window.RelayActivity.updateElement(run.activityEl, run.activityState, { collapseOnComplete: true });
    // 活动流和最终回答共用同一套“贴底跟随”语义：用户仍在底部时，
    // 每次活动节点增高后立即把最新内容带入视口；用户主动上滑后则不打断阅读。
    scrollToBottom();
  }
  if (run.activityEl) { run.activityEl.dataset.conversationId = run.convId || currentConv?.id || ''; run.activityEl.dataset.jobId = run.jobId || run.turn?.runId || ''; }
  if (run.activityEl) syncSubagentHistoryEntry(run.activityEl, run.activityState);
  if (run.activityEl) window.RelayActivity.syncTaskSummary(run.activityEl, taskSummaryKeyForTurn(run.turn));
}

function syncMcpReconnectButtons(busyOverride = null) {
  const busy = busyOverride == null
    ? !!(currentConv && isConvRunning(currentConv.id))
    : !!busyOverride;
  const unavailable = !currentConv;
  document.querySelectorAll('[data-mcp-reconnect]').forEach((btn) => {
    if (btn.classList.contains('is-loading')) return;
    btn.disabled = unavailable || busy;
    btn.title = unavailable
      ? '请先打开一个已有对话'
      : (busy ? '当前对话还在回复中，请结束后再重新加载' : '');
  });
}

async function resetCurrentMcpSession(triggerBtn = null) {
  if (!currentConv) { showToast('请先打开一个已有对话'); return false; }
  if (isConvRunning(currentConv.id)) { showToast('当前对话还在回复中，请结束后再重新加载'); return false; }

  const targetConv = currentConv;
  const targetConvId = targetConv.id;
  const buttons = Array.from(document.querySelectorAll('[data-mcp-reconnect]'));
  for (const btn of buttons) {
    btn.disabled = true;
    btn.classList.add('is-loading');
    const label = btn.querySelector('span');
    if (label) { btn.dataset.label = label.textContent; label.textContent = '正在加载…'; }
  }
  try {
    const r = await window.api.resetClaudeSession(
      targetConvId, currentMode, runtimeModelForValue(currentModel), currentEffort,
      currentWorkingDir && currentWorkingDir.path ? currentWorkingDir.path : null,
    );
    if (!r || !r.ok) {
      showToast((r && r.message) || '重新加载失败');
      return false;
    }
    // MCP 工具清单在 Claude Code session 创建时固定。这里不再 --resume 旧 session，
    // 而是让下一条消息把 Relay 保存的历史作为文本上下文带入全新 session。
    targetConv.sessionId = null;
    targetConv.carryContextOnNextTurn = 'mcp';
    await window.api.history.save(targetConv);
    if (currentConv && currentConv.id === targetConvId) currentSessionId = null;
    showToast(r.deferred ? '已重置会话，下一条消息将重新加载 MCP' : '已新建 Claude 会话并重新加载 MCP');
    return true;
  } catch (e) {
    showToast((e && e.message) || '重新加载失败');
    return false;
  } finally {
    for (const btn of buttons) {
      btn.classList.remove('is-loading');
      const label = btn.querySelector('span');
      if (label && btn.dataset.label) { label.textContent = btn.dataset.label; delete btn.dataset.label; }
    }
    syncMcpReconnectButtons();
    void triggerBtn;
  }
}

// ─────────────────────────────────────────
// 主题(深色/浅色/跟随系统)
// ─────────────────────────────────────────
let _themeSetting = 'light';
const _systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)');

function applyThemeToDOM(mode) {
  const dark = mode === 'dark' || (mode === 'system' && _systemDarkMq.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

async function initTheme(settingsPromise = window.api.settings.read()) {
  try {
    const s = await settingsPromise;
    _themeSetting = (s?.app?.theme) || 'light';
    setConversationIndexEnabled(s?.app?.conversationIndex !== false);
    setContextUsageEnabled(s?.app?.showContextUsage !== false);
  } catch {
    _themeSetting = 'light';
    setConversationIndexEnabled(true);
  }
  applyThemeToDOM(_themeSetting);
  _systemDarkMq.addEventListener('change', () => {
    if (_themeSetting === 'system') applyThemeToDOM('system');
  });
}

// ─────────────────────────────────────────
// 启动:探测环境 + 加载历史列表
// ─────────────────────────────────────────
let brandRenderRevision = 0;
let settingsViewSnapshot = null;
(async () => {
  // Theme and routing consume the same startup snapshot. Later settings views
  // still read fresh state; this promise is local to initialization only.
  const settingsPromise = window.api.settings.read();
  // 主题:尽早应用,避免白/黑屏闪烁
  initTheme(settingsPromise);
  void refreshComposerPermission();
  // 首屏关键路径:尽快把历史列表和输入区画出来。
  // ⚡ settings / brand / history 三个 IPC 互不依赖 —— 并行发起,别串行等(原来三次串行往返)。
  applyBrand();       // 内部自取 brand.get() 并刷新侧边栏 logo/名称
  applyWorkdirUI();   // 工作目录按钮初始态(纯本地,无 IPC)
  refreshHistoryList();   // 历史列表(不 await,回来即渲染)
  // 模型档位默认值取设置里的「默认使用」(只影响切换器初始态,不挡首屏其它部分)
  try {
    const s = await settingsPromise;
    followUpMode = s?.app?.followUpMode === 'queue' ? 'queue' : 'steer';
    agentEnvironment = s?.app?.agentEnvironment === 'wsl' ? 'wsl' : 'native';
    if (s?.claude?.routes) applyProviderRouting(s.claude.routes);
    if (s?.claude?.defaultModel) defaultModel = s.claude.defaultModel;
    const initialTier = configuredChatRoute(defaultModel)
      ? defaultModel
      : (providerRouting.chatRoutes.find((route) => route && route.available) || {}).tier;
    if (initialTier) { defaultModel = initialTier; currentModel = initialTier; }
  } catch {}
  initProviderRoutingEvents();
  currentEffort = effortForTier(currentTier());
  updateModelSwitchUI();
  updateComposerForMode();
  // 应用自更新：订阅状态推送，在侧边栏展示可用的新版本。
  //   不能等用户打开设置页才订阅。内部有幂等守卫,bindRelayUpdate 再调一次无害。
  initRelayUpdate();
})();

// Projects choose execution directories; attachments never change the workspace.
function getProjectComposer() {
  if (!projectComposer && window.RelayProjectsComposer) projectComposer = window.RelayProjectsComposer.create({
    api: window.api,
    context: () => ({ conversationId: currentConv && currentConv.id || workspaceDraftId, projectId: currentProjectId,
      navigationVersion: pageNavigationVersion, isDraft: !currentConv,
      executionMode: currentExecutionMode, selectedSkill: selectedQuickSkill,
      running: !!(currentConv && isConvRunning(currentConv.id)) }),
    selectProject: selectConversationProject,
    newConversation: id => { startNewConv('plain', null, null, null, id); },
    setMode: setComposerExecutionMode, addFiles, captureAttachmentOwner: captureComposerDraft, notify: showToast, refreshHistory: refreshHistoryList,
    listSkills: listComposerSkills, selectSkill: selectComposerSkill, beforeOpen: () => { hideModelPopup(); permissionControls?.close(); },
    prompt: customPrompt, confirm: customConfirm,
  });
  return projectComposer;
}
function applyWorkdirUI() { getProjectComposer()?.sync(); }
async function selectConversationProject(projectId, conversationId = null) {
  const targetId = conversationId && conversationId !== workspaceDraftId ? conversationId : currentConv && currentConv.id;
  if (targetId && (isConvRunning(targetId) || pendingConversationSends.has(targetId))) throw Error('当前对话正在运行，请结束任务后再切换项目');
  const selected = getProjectComposer()?.project(projectId);
  if (projectId && !selected) throw Error('项目不存在，请重新选择');
  if (targetId) {
    const result = await window.api.projects.assign({ conversationId: targetId, projectId });
    if (!result || !result.ok) throw Error(result && result.error || '项目切换失败');
    if (!currentConv || currentConv.id !== targetId) { await refreshHistoryList(); return; }
    Object.assign(currentConv, result.conversation);
    currentSessionId = currentConv.sessionId || null;
  }
  currentProjectId = projectId || null;
  currentWorkingDir = selected ? { path: selected.path, name: selected.name } : null;
  applyWorkdirUI();
  window.dispatchEvent(new CustomEvent('relay:workdir-changed'));
  await refreshHistoryList();
}
function validComposerPermission(value) {
  return ['default', 'acceptEdits', 'bypassPermissions'].includes(value);
}
function applyPermissionMetadata(conv, value) {
  if (!conv || !value) return;
  conv.permissionMode = value.permissionMode;
  conv.permissionRevision = value.revision;
  conv.permissionLegacyPlan = value.legacyPlan === true;
}
function syncPermissionControl() {
  if (!permissionControls && window.RelayPermissionControls && $('btnPermissionMode')) {
    permissionControls = window.RelayPermissionControls.create({
      button: $('btnPermissionMode'),
      getState: () => ({
        permissionMode: currentPermissionState?.permissionMode,
        plan: currentExecutionMode.kind === 'plan', busy: !!permissionMutation,
        disabled: !currentPermissionState || !!(currentConv && (pendingConversationSends.has(currentConv.id)
          || conversationControls.has(currentConv.id))),
      }),
      onChange: permissionMode => changeComposerPermission(permissionMode),
      beforeOpen: () => { hideModelPopup(); getProjectComposer()?.close(); }, notify: showToast,
    });
  }
  permissionControls?.sync();
  if (!permissionEventsReady && window.api.permissions?.onChanged) {
    permissionEventsReady = true;
    window.api.permissions.onChanged(value => {
      // A changed default never replaces the choice shown in an existing draft.
      if (!permissionMutation && currentConv && value?.conversationId === currentConv.id) void refreshComposerPermission();
    });
  }
}
function refreshComposerPermission() {
  const revision = ++permissionViewRevision;
  const target = currentConv;
  const modeRevision = permissionModeEditRevision;
  currentPermissionState = null;
  permissionControls?.close();
  syncPermissionControl();
  permissionLoadPromise = (async () => {
    try {
      const value = await window.api.permissions.get(target?.id || null);
      if (revision !== permissionViewRevision || currentConv !== target) return false;
      if (!value?.ok || !validComposerPermission(value.permissionMode)) throw Error(value?.error || '权限读取失败，请重试');
      currentPermissionState = value;
      applyPermissionMetadata(target, value);
      if (modeRevision === permissionModeEditRevision && (target || value.legacyPlan)) {
        currentExecutionMode = { kind: value.executionMode?.kind || 'default' };
        if (target) target.executionMode = { ...currentExecutionMode };
        getProjectComposer()?.sync();
      }
      syncPermissionControl();
      return true;
    } catch (error) {
      if (revision === permissionViewRevision && currentConv === target) {
        showToast(error.message || '权限读取失败，请重试'); syncPermissionControl();
      }
      return false;
    }
  })();
  const request = permissionLoadPromise;
  request.finally(() => { if (permissionLoadPromise === request) permissionLoadPromise = null; });
  return request;
}
async function changeComposerPermission(permissionMode, executionMode = null) {
  if (!validComposerPermission(permissionMode)) throw Error('请选择有效的权限模式');
  if (permissionMutation) throw Error('正在更新权限，请稍候');
  const target = currentConv, viewRevision = permissionViewRevision;
  const token = {};
  permissionMutation = token;
  syncPermissionControl();
  try {
    const value = await window.api.permissions.set({ conversationId: target?.id || null,
      permissionMode, ...(target ? { expectedRevision: currentPermissionState?.revision } : {}),
      ...(executionMode ? { executionMode } : {}) });
    if (!value?.ok || !validComposerPermission(value.permissionMode)) {
      if (value?.code === 'PERMISSION_CONFLICT' && target === currentConv) void refreshComposerPermission();
      throw Error(value?.error || '权限更新失败');
    }
    applyPermissionMetadata(target, value);
    if (target && executionMode) target.executionMode = { ...executionMode };
    if (target === currentConv && viewRevision === permissionViewRevision) {
      currentPermissionState = value;
      if (executionMode) currentExecutionMode = { ...executionMode };
      getProjectComposer()?.sync();
    }
    return value;
  } finally {
    if (permissionMutation === token) permissionMutation = null;
    syncPermissionControl();
  }
}
function choosePlanContext() {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="执行计划"><h3>执行计划</h3><p>可保留当前上下文，或清空后开始执行。清空只影响模型运行上下文；对话记录和工作文件保留，旧附件与指引不会自动带入。</p><div class="confirm-actions"><button data-choice="cancel">取消</button><button data-choice="keep">保留上下文</button><button class="btn-primary" data-choice="clear">清空后继续</button></div></div>';
    const close = choice => { document.removeEventListener('keydown', key); overlay.remove(); resolve(choice); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); close(null); }
      if (event.key === 'Tab') { const items = [...overlay.querySelectorAll('button')], index = items.indexOf(document.activeElement); if (event.shiftKey && index <= 0 || !event.shiftKey && index === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); } } };
    for (const button of overlay.querySelectorAll('button')) button.onclick = () => close(button.dataset.choice === 'cancel' ? null : button.dataset.choice);
    overlay.onclick = event => { if (event.target === overlay) close(null); };
    document.body.append(overlay); requestAnimationFrame(() => overlay.classList.add('show'));
    overlay.querySelector('[data-choice="keep"]').focus(); document.addEventListener('keydown', key);
  });
}
async function setComposerExecutionMode(mode) {
  if (currentConv && isConvRunning(currentConv.id)) { showToast('任务运行中不能切换模式'); return false; }
  const target = currentConv;
  const kind = mode && ['default', 'plan', 'goal'].includes(mode.kind) ? mode.kind : 'default';
  const permissionWait = currentPermissionState ? null : (permissionLoadPromise || refreshComposerPermission());
  let viewRevision = permissionViewRevision;
  if (permissionWait && !await permissionWait) return false;
  if (target !== currentConv || viewRevision !== permissionViewRevision) return false;
  try {
    if (target && currentExecutionMode.kind === 'plan' && kind !== 'plan' && appSettings.sdkRuntimePreferences?.showClearContextOnPlanAccept) {
      const choice = await choosePlanContext();
      if (!choice || target !== currentConv || viewRevision !== permissionViewRevision) return false;
      if (choice === 'clear') {
        const result = await window.api.claudeClearContext({ conversationId: target.id });
        if (!result?.ok) throw Error(result?.error || '清空上下文未确认');
        if (target !== currentConv) return false;
        target.sdkContextBoundary = result.sdkContextBoundary;
        await refreshComposerPermission(); viewRevision = permissionViewRevision;
      }
    }
    // The host clears migrated legacy plan restrictions only on an explicit mode change.
    if (target || currentPermissionState.legacyPlan && kind !== 'plan') {
      await changeComposerPermission(currentPermissionState.permissionMode, { kind });
      if (target !== currentConv || viewRevision !== permissionViewRevision) return false;
    }
    permissionModeEditRevision++;
    currentExecutionMode = { kind };
    getProjectComposer()?.sync(); syncPermissionControl();
    inputEl.focus();
    return true;
  } catch (error) { showToast(error.message || '模式切换失败'); return false; }
}

// ── 本地技能快捷调用（一次性） ──
// 加号菜单复用插件页的数据源；已选技能只作用于下一条消息。
function normalizeComposerSkill(skill) {
  return skill && skill.name ? {
    name: String(skill.name),
    callName: String(skill.callName || skill.name),
    displayName: String(skill.displayName || skill.name),
    desc: String(skill.desc || ''),
    summary: String(skill.summary || skill.desc || ''),
    defaultPrompt: String(skill.defaultPrompt || ''),
  } : null;
}
function setSelectedQuickSkill(skill) {
  selectedQuickSkill = normalizeComposerSkill(skill);
  if (!composerSkillChip || !composerSkillLabel) return;
  composerSkillChip.classList.toggle('hidden', !selectedQuickSkill);
  composerSkillLabel.textContent = selectedQuickSkill ? selectedQuickSkill.displayName : '';
  composerSkillChip.title = selectedQuickSkill
    ? `${selectedQuickSkill.displayName}（调用 ID：${selectedQuickSkill.callName}）` : '';
}
function selectComposerSkill(skill) {
  setSelectedQuickSkill(skill);
  // 作者提供的调用模板仅填入空白草稿，不覆盖用户已经输入的内容。
  if (selectedQuickSkill && selectedQuickSkill.defaultPrompt && !inputEl.value.trim()) {
    inputEl.value = selectedQuickSkill.defaultPrompt;
    autoGrowInput();
  }
  hideSkillQuickPopup();
  inputEl.focus();
}
async function listComposerSkills() {
  const openingId = currentConv?.id;
  const [result, native] = await Promise.all([window.api.data.listSkills(), window.api.claudeCommands?.(openingId).catch(() => null)]);
  if (currentConv?.id !== openingId) return [];
  if (!result || !result.ok || !Array.isArray(result.items)) {
    throw Error(result && result.error || '技能加载失败，请重试');
  }
  const merged = new Map(result.items.map(item => [item.callName || item.name, item]));
  for (const item of native?.items || []) if (!merged.has(item.name)) merged.set(item.name, item);
  const items = [...merged.values()].map(normalizeComposerSkill).filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  // 旧技能元数据仍在后台补齐；后续打开时读取最新信息，不改写正在输入的草稿。
  if (!quickSkillMetadataBackfillStarted && window.api.skills?.backfillMetadata) {
    quickSkillMetadataBackfillStarted = true;
    Promise.resolve().then(() => window.api.skills.backfillMetadata()).then(result => {
      if (!result || !result.ok) quickSkillMetadataBackfillStarted = false;
    }).catch(error => {
      quickSkillMetadataBackfillStarted = false;
      console.warn('[skills] 快捷选择器历史元数据补齐失败', error);
    });
  }
  return items;
}
// 保留会话切换、发送和模型选择已有的关闭入口，统一关闭加号面板。
function hideSkillQuickPopup() { projectComposer?.close(); permissionControls?.close(); }

// 应用侧边栏品牌。默认标志按主题使用 Dual Gate 矢量版，自定义图片保留原样。
const DEFAULT_BRAND_NAME = 'Relay';
function setBrandLogo(element, customLogo) {
  if (!element) return;
  element.classList.toggle('relay-default-logo', !customLogo);
  element.src = customLogo || 'logo.svg';
}
async function applyBrand() {
  const revision = ++brandRenderRevision;
  let b = null;
  try { b = await window.api.brand.get(); } catch { return; }
  if (revision !== brandRenderRevision) return;
  const nameEl = $('brandName');
  const logoEl = $('brandLogo');
  if (nameEl) {
    const name = (b && b.name) ? b.name : DEFAULT_BRAND_NAME;
    nameEl.textContent = name;
    nameEl.title = name;        // 悬停看完整名字
  }
  setBrandLogo(logoEl, b && b.logo);
  updateProfileIdentity(b);
}

// ─────────────────────────────────────────
// 历史侧边栏
// ─────────────────────────────────────────
// 五类会话的专属图标，侧边栏历史与搜索结果共用：
//   定时任务=时钟 / 生图=图片 / Agent=机器人 / 协奏=团队 / 普通=气泡。
const ICON_HIST_SCHED = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_HIST_IMAGE = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.3"/><path d="M20 15l-4-4-6 6"/></svg>';
const ICON_HIST_AGENT = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="3"></rect><line x1="12" y1="4.5" x2="12" y2="8"></line><circle cx="12" cy="3.5" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="9.5" cy="13" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="14.5" cy="13" r="1.1" fill="currentColor" stroke="none"></circle><line x1="4" y1="12" x2="4" y2="15"></line><line x1="20" y1="12" x2="20" y2="15"></line></svg>';
const ICON_HIST_CHAT = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
const ICON_HIST_TEAM = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="9" r="2.6"></circle><circle cx="16" cy="8" r="2.2"></circle><path d="M3.5 18c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2"></path><path d="M14.5 14c2.4-.2 6 1 6 4"></path></svg>';
// 按会话类型选图标；定时任务保留独立的时钟标识。
const HIST_TYPES = {
  chat: { label: '普通对话', icon: ICON_HIST_CHAT },
  create: { label: '生图', icon: ICON_HIST_IMAGE },
  agent: { label: 'Agent', icon: ICON_HIST_AGENT },
  orchestrate: { label: '多 Agent 协奏', icon: ICON_HIST_TEAM },
  scheduled: { label: '定时任务', icon: ICON_HIST_SCHED },
};
function histIconType(it) {
  if (it.fromScheduled) return 'scheduled';
  if (it.kind === 'create') return 'create';
  if (it.mode === 'orchestrate') return 'orchestrate';
  if (it.mode === 'agent') return 'agent';
  return 'chat';
}
function histIconSvg(it) {
  const type = histIconType(it), entry = HIST_TYPES[type];
  return entry.icon.replace('<svg ', `<svg data-history-type="${type}" role="img" aria-label="${entry.label}" `);
}

// 置顶图钉图标(模块级常量,避免每行重复拼字符串)
const HIST_ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
// 重命名铅笔图标(与图钉同款交互:悬停行才露出)
const HIST_ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';

// 历史列表交互一次性委托到容器:点击行打开会话、点铅笔重命名、点图钉置顶、点 × 删除。
//   省掉每行 addEventListener —— 列表越长收益越大,且增量更新时不必反复重绑。
let _histDelegated = false;
function ensureHistoryDelegation() {
  if (_histDelegated || !historyEl) return;
  _histDelegated = true;
  historyEl.addEventListener('click', async (e) => {
    const li = e.target.closest('.history-item');
    if (!li) return;
    const id = li.dataset.id;
    if (!id) return;
    const isCreate = li.dataset.kind === 'create';
    // 图钉:置顶/取消置顶
    if (e.target.closest('.hi-pin')) {
      e.stopPropagation();
      const nowPinned = li.classList.contains('pinned');
      const result = await window.api.history.setPinned(id, !nowPinned);
      if (result && result.ok === false) { showToast(result.error || '置顶状态更新失败'); return; }
      if (currentConv && currentConv.id === id) currentConv.pinned = !nowPinned;
      await refreshHistoryList();
      return;
    }
    // 铅笔:手动重命名
    if (e.target.closest('.hi-rename')) {
      e.stopPropagation();
      const oldTitle = li.querySelector('.hi-title')?.textContent || '';
      const nv = await customPrompt({
        title: '重命名会话',
        value: oldTitle === '未命名' ? '' : oldTitle,
        placeholder: '会话标题',
        maxLength: 128,
        // AI 重新总结:用全程骨架素材重新起名,结果只填入输入框,用户确认才生效
        aiAction: {
          label: '✨ AI 总结',
          run: async () => {
            const conv = await window.api.history.load(id);
            const mat = conv ? buildTitleMaterial(conv) : '';
            if (!mat) return '';
            const res = await window.api.summarizeTitle(mat);
            return ((res && res.title) || '').trim();
          },
        },
      });
      if (nv === null) return;   // 取消
      const t = nv.trim();
      if (!t || t === oldTitle) return;   // 空输入或没改,视为放弃
      const r = await window.api.history.rename(id, t);
      if (!(r && r.ok)) { showToast('重命名失败'); return; }
      const finalTitle = r.title || t;   // 主进程按 64 视觉宽收口，显示宽度由侧栏控制
      // 若该会话此刻正打开:同步内存对象(防止后续整存把旧标题写回)+ 顶部标题
      if (currentConv && currentConv.id === id) {
        currentConv.title = finalTitle; currentConv.titleGenerated = true; currentConv.titleManual = true;
        chatTitle.textContent = finalTitle;
      }
      if (currentCreateConv && currentCreateConv.id === id) {
        currentCreateConv.title = finalTitle; currentCreateConv.titleGenerated = true; currentCreateConv.titleManual = true;
      }
      await refreshHistoryList();
      return;
    }
    // 删除
    if (e.target.closest('.hi-del')) {
      e.stopPropagation();
      const title = li.querySelector('.hi-title')?.textContent || '该会话';
      const ok = await customConfirm({
        title: '删除会话',
        message: `「${title}」将被永久删除，无法恢复。`,
        confirmText: '删除', cancelText: '取消', danger: true,
      });
      if (!ok) return;
      await window.api.history.delete(id);
      composerDrafts.delete(id); supplementDrafts.delete(id);
      if (currentConv && currentConv.id === id) startNewConv();
      await refreshHistoryList();
      return;
    }
    // 行本体:打开会话
    if (isCreate) loadCreateConv(id);
    else loadConversation(id);
  });
}

// 新建一行历史项的 DOM(结构与下面 updateHistoryRow 的更新逻辑保持一致)
function buildHistoryRow(it) {
  const li = document.createElement('div');
  li.className = 'history-item';
  li.dataset.id = it.id;
  li.dataset.kind = it.kind || 'chat';
  li.innerHTML = `${histIconSvg(it)}<button type="button" class="hi-title"></button><button type="button" class="hi-rename" title="重命名" aria-label="重命名会话"></button><button type="button" class="hi-pin" title=""></button><span class="hi-tail"></span>`;
  updateHistoryRow(li, it);
  return li;
}

// 把一行的可变部分按 it 当前状态对齐(复用已有 DOM,只改变化处)。
function updateHistoryRow(li, it) {
  const activeId = activeView === 'create'
    ? (currentCreateConv && currentCreateConv.id)
    : activeView === 'chat' ? (currentConv && currentConv.id) : null;
  const isActive = !!(activeId && activeId === it.id);
  const running = isConvRunning(it.id);
  li.classList.toggle('active', isActive);
  li.classList.toggle('running', running);
  li.classList.toggle('pinned', !!it.pinned);
  if (li.dataset.kind !== (it.kind || 'chat')) li.dataset.kind = it.kind || 'chat';

  const iconType = histIconType(it), icon = li.querySelector(':scope > .hi-icon');
  li.dataset.historyType = iconType;
  if (!icon) li.insertAdjacentHTML('afterbegin', histIconSvg(it));
  else if (icon.dataset.historyType !== iconType) icon.outerHTML = histIconSvg(it);

  const titleEl = li.querySelector('.hi-title');
  const title = it.title || '未命名';
  if (titleEl.textContent !== title) titleEl.textContent = title;
  titleEl.title = title;
  titleEl.setAttribute('aria-label', title);

  const pin = li.querySelector('.hi-pin');
  pin.classList.toggle('on', !!it.pinned);
  const pinTitle = it.pinned ? '取消置顶' : '置顶';
  if (pin.title !== pinTitle) pin.title = pinTitle;
  pin.setAttribute('aria-label', pinTitle + '会话');
  if (!pin.firstChild) pin.innerHTML = HIST_ICON_PIN;   // 图钉 SVG 一次性填充

  const rn = li.querySelector('.hi-rename');
  if (rn && !rn.firstChild) rn.innerHTML = HIST_ICON_EDIT;   // 铅笔 SVG 一次性填充

  // 尾部:运行中显示转圈,否则显示删除按钮。只在两态切换时重写,避免每帧重建。
  const tail = li.querySelector('.hi-tail');
  const want = running ? 'spin' : 'del';
  if (tail.dataset.state !== want) {
    tail.dataset.state = want;
    tail.innerHTML = running
      ? '<span class="hi-spinner" title="正在回复中"></span>'
      : '<button class="hi-del" title="删除">×</button>';
  }
}

async function refreshHistoryList() {
  const revision = ++historyRefreshRevision;
  const composer = getProjectComposer();
  const [items, projects] = await Promise.all([window.api.history.list(), composer ? composer.refresh() : Promise.resolve([])]);
  if (revision !== historyRefreshRevision) return;
  ensureHistoryDelegation();
  window.RelaySidebarHistory.reconcile(historyEl, items, {
    buildRow: buildHistoryRow, updateRow: updateHistoryRow, projects,
    projectHeader: composer ? composer.header : undefined,
  });
}

// jumpTo(可选):{ turnIndex, side } —— 从搜索结果跳转时,打开会话后滚动到命中的那条消息并高亮。
async function loadConversation(id, jumpTo = null, { forceReload = false } = {}) {
  const navigationIntent = ++pageNavigationVersion;
  const isCurrentNavigation = () => navigationIntent === pageNavigationVersion;
  // 主页面之间往返时复用已挂载的对话，不重读历史、不重建流、不触发预启动。
  if (currentConv && currentConv.id === id && !jumpTo && !forceReload && !pendingConversationViewReloads.has(`chat:${id}`)) {
    if (!showChatView(navigationIntent)) return false;
    emitConversationChanged(id);
    syncRunningUI();
    return true;
  }
  // Hide the previous decision immediately while another history entry loads.
  emitConversationChanged(null, { loading: true });
  let conv, model, activeProviderRoute, prespawnSessionRoute;
  try {
    conv = await window.api.history.load(id);
    if (!conv || !isCurrentNavigation()) {
      if (isCurrentNavigation()) emitConversationChanged(currentConv && currentConv.id);
      return false;
    }
    model = conv.model || currentModel;
    activeProviderRoute = providerRoutingLoaded ? configuredChatRoute(model) : null;
    prespawnSessionRoute = sessionRouteSnapshot(activeProviderRoute, model);
    if (conv.sessionId && prespawnSessionRoute
        && !conversationSessionMatchesRoute(conv, activeProviderRoute, model)) {
      await invalidateConversationSessionForProvider(conv, prespawnSessionRoute.routeTier);
      if (!isCurrentNavigation()) return false;
    }
  } catch (error) {
    if (isCurrentNavigation()) emitConversationChanged(currentConv && currentConv.id);
    throw error;
  }
  const mode = conv.mode || 'plain';
  if (!showChatView(navigationIntent)) return false;
  activateComposerDraft(id);
  currentConv = conv;
  pendingConversationViewReloads.delete(`chat:${id}`);
  currentSessionId = conv.sessionId || null;
  currentMode = conv.mode || 'plain';  // 历史会话恢复时也要恢复 mode
  currentAgent = conv.agent || null;   // 恢复该会话选中的子智能体真实 id
  currentAgentLabel = conv.agentLabel || conv.agent || null;  // 恢复显示名
  currentOrchestrateAgents = conv.orchestrateAgents || null;  // 恢复协同选队
  currentWorkingDir = conv.workingDir || null;  // 恢复该会话的工作目录
  currentProjectId = conv.projectId || null;
  currentExecutionMode = conv.executionMode && ['default', 'plan', 'goal'].includes(conv.executionMode.kind) ? { kind: conv.executionMode.kind } : { kind: 'default' };
  void refreshComposerPermission();
  emitConversationChanged(id);
  hideSkillQuickPopup();
  // 准备完成后先显示上下文信息，再同步重建会话消息。
  // 优先使用当前进程里的最新值；Relay 刚启动时从会话正文恢复上次快照。
  if (!contextUsageByConv.has(id) && conv.contextUsage && Number(conv.contextUsage.rawMaxTokens || conv.contextUsage.maxTokens) > 0) {
    contextUsageByConv.set(id, conv.contextUsage);
  }
  renderContextUsage(id);
  applyWorkdirUI();
  if (conv.model) currentModel = conv.model;  // 恢复该会话的模型档位
  currentEffort = conv.effort || effortForTier(currentTier());
  updateModelSwitchUI();
  updateComposerForMode();  // 按会话模式显示/隐藏模型切换器
  clearConversationMessages();
  clearConversationIndex();
  chatTitle.textContent = conv.title || '历史会话';
  if (conv.forkedFrom) appendMessage('system', '此分支与原对话共享工作目录；聊天记录独立，文件不会自动回退。');

  // 预启动这个对话的常驻 claude 进程:用户读历史/打字的这几秒,正好用来连 MCP,
  //   等他真发消息时工具已经全就位(不预启动的话首轮模型会看到一个没有 MCP 工具的世界)。
  //   fire-and-forget:失败无害,发送时主进程会自己 spawn。
  if (prespawnSessionRoute) {
    try {
      window.api.prespawnClaude(
        id,
        currentSessionId,
        currentMode,
        runtimeModelForValue(currentModel),
        currentEffort,
        currentAgent,
        currentWorkingDir && currentWorkingDir.path ? currentWorkingDir.path : null,
        prespawnSessionRoute,
      )
        .then(() => refreshClaudeRuntimeInfo(id))
        .catch(() => {});
    } catch (_) {}
  }

  // 这个会话是否正在后台跑?(有 run 即在跑)
  const run = runs.get(id);
  const turns = conv.turns || [];
  const lastIdx = turns.length - 1;
  const liveTurnIndex = run && Number.isSafeInteger(run.turnIndex) && run.turnIndex >= 0 && run.turnIndex <= lastIdx
    ? run.turnIndex : lastIdx;

  // ── 渲染所有已存 turns ──
  //   若该会话正在跑,最后一个 turn 的 saved 内容是空占位,改用 run.turn 的内存内容渲染。
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLiveTurn = (i === liveTurnIndex) && !!run;
    appendConversationTurnAnchor(i);

    // 每条消息打 data-turn=i 标记,供搜索跳转按 turn 索引 + 角色定位到具体消息
    if (!window.RelayTaskContinuity?.isResume(turn) && (turn.user || (turn.files && turn.files.length))) {
      const el = appendMessage('user', turn.user, turn.files, { ts: turn.ts });
      if (el) el.dataset.turn = i;
    }

    if (hasSupplementTimeline(isLiveTurn ? run.turn : turn)) {
      if (!isLiveTurn) {
        renderSupplementTimeline({ turn, turnIndex: i, outputState: window.RelayAssistantOutput.createState(turn.output),
          activityState: activityStateForTurn(turn) }, true);
        appendSavedTurnError(turn, i);
        if (turn.outputNotice) appendMessage('system', turn.outputNotice);
      }
      continue;
    }
    for (const input of (isLiveTurn ? run.turn.supplements : turn.supplements) || []) appendSupplementMessage(input, i);

    // 所有会话按同一结构化过程流重建，旧协作日志在渲染期兼容。
    if (!isLiveTurn) {
      const segment = taskSegmentForTurn(turn, turns);
      const activityState = activityStateForTurn(turn)
        || (segment === 'previous' ? newActivityState({ phase: 'complete', startedAt: null }) : null);
      if (activityState && (activityState.items.length || activityState.taskRun || segment === 'previous')) {
        const activityEl = appendActivityState(activityState, true, { segment,
          taskKey: taskSummaryKeyForTurn(turn, turns) });
        if (activityEl) { activityEl.dataset.turn = i; activityEl.dataset.jobId = turn.runId || ''; }
      }
    }

    if (!isLiveTurn) {
      currentAssistantBubble = null;
      const display = savedAssistantDisplay(turn);
      appendLegacyOutputDiagnostics(display.diagnostics);
      if (display.text) appendOrUpdateAssistant(display.text, false, { ts: turn.assistantTs });
      // appendOrUpdateAssistant 不返回元素;此处它刚新建的气泡就是 currentAssistantBubble
      if (currentAssistantBubble) currentAssistantBubble.dataset.turn = i;
      currentAssistantBubble = null;
    }
    if (!isLiveTurn) appendSavedTurnError(turn, i);
    if (!isLiveTurn && turn.outputNotice) appendMessage('system', turn.outputNotice);
  }

  // ── 正在跑:把该 run 后台累积的 thinking/工具/文本补渲染出来,并接回流式气泡 ──
  if (run) {
    if (run.outputState) syncRunOutputActivity(run, false);
    currentSessionId = run.sessionId || currentSessionId;
    // 所有会话接回同一份过程状态；子 Agent 与中间文字只在过程区显示。
    if (run.activityState && !hasSupplementTimeline(run.turn)) run.activityEl = appendActivityState(run.activityState, false);
    syncRunOutputActivity(run, true);
    if (run.error) showRunError(run, run.error);
  }

  refreshConversationIndex();

  // ── 搜索跳转:滚动到命中的那条消息并短暂高亮 ──
  if (jumpTo && jumpTo.turnIndex != null) {
    // side: assistant → 命中助手回复;user/prompt → 命中用户消息。按 data-turn + 角色选元素。
    const wantAssistant = jumpTo.side === 'assistant';
    const sel = `.message.${wantAssistant ? 'assistant' : 'user'}[data-turn="${jumpTo.turnIndex}"]`;
    let target = messagesEl.querySelector(sel);
    // 兜底:若该侧没渲染出来(如纯附件无文字),退而用同 turn 的任意消息
    if (!target) target = messagesEl.querySelector(`.message[data-turn="${jumpTo.turnIndex}"]`);
    if (target) {
      stopFollowingMessages();
      // 渲染/布局可能未稳,等一帧再滚,定位更准
      requestAnimationFrame(() => {
        if (!isCurrentNavigation() || currentConv !== conv || activeView !== 'chat') return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('search-hit');
        setTimeout(() => target.classList.remove('search-hit'), 2000);
      });
    }
  } else {
    stickToBottom = true;
    requestAnimationFrame(() => {
      if (isCurrentNavigation() && currentConv === conv && activeView === 'chat') scrollToBottom(true);
    });
  }

  syncRunningUI();             // 发送按钮反映这个会话是否在跑
  await refreshHistoryList();  // 刷新 active 高亮
  return isCurrentNavigation() && currentConv === conv;
}

function startNewConv(mode = 'plain', agentName = null, agentLabel = null, orchestrateAgents = null, projectId = currentProjectId) {
  // 注意:不动 runs —— 让正在跑的其它会话继续在后台收数据,完成后各自写回自己的 conv。
  showChatView();   // 若当前在「AI 创作」视图,切回聊天视图
  activateComposerDraft();
  currentMode = mode;
  currentAgent = (mode === 'agent') ? agentName : null;
  currentAgentLabel = (mode === 'agent') ? (agentLabel || agentName) : null;
  currentOrchestrateAgents = (mode === 'orchestrate') ? (orchestrateAgents || null) : null;
  currentModel = defaultModel;   // 新对话回到用户设置的默认档(不沿用刚看的历史会话的档位)
  currentEffort = effortForTier(currentTier());
  updateComposerForMode();  // plain 显示模型切换器 / agent 隐藏(锁定模型)
  updateModelSwitchUI();    // 让切换器 UI 同步回默认档
  currentConv = null;
  workspaceDraftId = null;
  renderContextUsage(null);
  currentSessionId = null;
  currentProjectId = projectId || null;
  const selectedProject = getProjectComposer()?.project(currentProjectId);
  currentWorkingDir = selectedProject ? { path: selectedProject.path, name: selectedProject.name } : null;
  currentExecutionMode = { kind: 'default' };
  void refreshComposerPermission();
  emitConversationChanged(null);
  setSelectedQuickSkill(null);
  hideSkillQuickPopup();
  applyWorkdirUI();
  clearConversationMessages();
  clearConversationIndex();
  setRunning(false);   // 新对话本身没在跑(其它会话的运行不影响这个空白页)

  if (mode === 'agent') {
    const label = currentAgentLabel || 'Agent';
    chatTitle.textContent = label;
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>🤖 ${escapeHtml(label)}</h2>
        <p>已进入「${escapeHtml(label)}」对话，直接描述你的需求即可。</p>
      </div>
    `;
  } else if (mode === 'orchestrate') {
    chatTitle.textContent = 'Agent 协作';
    const names = (currentOrchestrateAgents || []).map((name) => selectedAgentLabels.get(name) || name);
    const scope = names.length ? names.join('、') : '已安装的 Agent';
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>Agent 协作</h2>
        <p>${escapeHtml(scope)} 将共同处理任务。描述你的需求，即可开始。</p>
      </div>
    `;
  } else {
    chatTitle.textContent = '新对话';
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>今天，想做些什么？</h2>
        <p>提问、创作，或把一个想法变成现实。</p>
      </div>
    `;
  }
  refreshHistoryList();
}

// 某个 run 的后端进程结束 → 把累积的 turn 写回它归属的 conv,清理 run,刷新 UI。
//   注意:此时用户可能正看着别的会话,所以一切都按 run.convId 操作,不依赖 currentConv。
async function finishRunUnsafe(jobId, doneEvt) {
  const run = runForJob(jobId);
  if (!run || run.finishing) return;
  run.finishing = true;
  const convId = run.convId;
  const wasViewing = currentConv && currentConv.id === convId;
  const isStillViewing = () => !!(currentConv && currentConv.id === convId);
  // A completed final answer can win the race with the user's pause click.
  const terminalResult = doneEvt && doneEvt.finalResult;
  const naturallyFinished = run.pauseRequested && terminalResult
    && terminalResult.subtype === 'success' && !terminalResult.is_error
    && !Number(terminalResult.queued_turn_count || 0)
    && !/^aborted_(?:streaming|tools)$/.test(String(terminalResult.terminal_reason || ''));
  const explicitlyAborted = !naturallyFinished && (!!run.abortRequested || !!doneEvt?.aborted
    || /^aborted_/.test(String(terminalResult?.terminal_reason || '')));

  // 会话失效(--resume 撞 "No conversation found")是可以自动恢复的——下面会无声重跑一次。
  //   这种情况不向用户抛刺眼的红色报错,只在重跑分支给一条温和的灰色提示。
  //   仅当本轮带着 sessionId、还没自动救过时才算"可自愈";否则按真实失败正常报错。
  const sessionGone = /No conversation found with session ID/i.test(run.stderrBuf || '');
  // 账本恢复的运行已经由持久化终态裁决，不能在刷新后又悄悄重跑一次。
  const willAutoRecover = !run.restoredFromLedger && sessionGone && run.sessionId && !run.autoRetried && !run.nativeFork;

  // spawn 失败/异常退出且没产出任何文字 → 给个错误提示(可自愈的会话失效除外)
  const exitCode = doneEvt && typeof doneEvt.exitCode === 'number' ? doneEvt.exitCode : 0;
  if (!explicitlyAborted && !run.error) {
    // job-done can be the only terminal frame (for example, preparation failure).
    run.error = window.RelayConversationErrors.forTurn({ error: doneEvt && doneEvt.error,
      output: { lastResult: terminalResult } }) || null;
  }
  if (!explicitlyAborted && !run.error && exitCode !== 0 && !run.turn.assistant) {
    const detail = (run.stderrBuf || '').trim();
    // 带图却失败:几乎都是当前模型不支持图片输入 —— 纯文本模型一旦读到图片 image block 就会
    //   整轮报错退出(错误码 1)。这种情况给一句友好提示,而不是裸露的「错误码 1」。
    //   判据:本轮带了图片附件、且不是可自愈的会话失效。stderr 仍留作可展开的细节。
    if (hasImageAttachment(run.turn.files) && !sessionGone) {
      const tierLabel = TIER_LABEL[run.sessionModel] || '';
      const isFastTier = run.sessionModel === 'haiku';
      // 在「快速」档建议切到能读图的档位;其它档(用户自配模型)只说明可能不支持图片。
      const suggest = isFastTier
        ? '当前「快速」档使用的模型不支持识别图片。请在输入框下方把模型切到「思考」或「专家」档后重试。'
        : `当前${tierLabel ? `「${tierLabel}」档所用的` : '所用'}模型可能不支持识别图片，无法读取你上传的图。请换用支持图片输入(多模态)的模型后重试。`;
      run.error = `无法识别图片：${suggest}`;
      if (detail) run.error += `\n\n（技术细节）${detail}`;
    } else {
      // 把进程的 stderr(若有)并入错误信息 —— 退出码 1 的真正原因几乎都在这里,
      //   过去因 onView 限制被丢弃,只剩光秃秃的「退出码 1」难以排查。
      run.error = doneEvt && doneEvt.error
        ? `运行失败:${doneEvt.error}`
        : `运行异常结束（错误码 ${exitCode}）`;
      if (detail) run.error += `\n\n${detail}`;
      // 可自愈的会话失效:不弹红色报错,把噪音留给下面的灰色"正在重新开始"提示。
    }
  }
  // 本轮是否失败:有 error,或非零退出且没产出任何回复。
  //   失败轮不能写回 sessionId(CLI 可能创建了一个又随即报错退出的"幽灵 session",
  //   存了它下一轮 --resume 会撞 "No conversation found with session ID")。
  //   也不该拿失败的报错文本去生成标题。
  const failed = !explicitlyAborted && (!!run.error || exitCode !== 0);
  const output = outputStateForRun(run);
  run.turn.assistant = window.RelayAssistantOutput.finish(output, doneEvt, {
    aborted: explicitlyAborted, error: failed ? run.error || '执行失败' : null,
    supplements: run.turn.supplements || [],
  });
  run.turn.output = window.RelayAssistantOutput.serialize(output);
  run.turn.error = failed ? (run.error || '任务执行失败') : null;
  run.turn.status = explicitlyAborted ? (run.pauseRequested ? 'paused' : 'canceled') : failed ? 'error' : 'complete';
  const taskRun = window.RelayTaskContinuity?.finish(run.activityState?.taskRun || run.taskRun || run.turn.taskRun, {
    finishedAt: doneEvt?.relay_task_finished_at, durationMs: doneEvt?.relay_task_duration_ms,
  });
  if (taskRun) { run.turn.taskRun = taskRun; if (run.activityState) run.activityState.taskRun = taskRun; }
  run.turn.outputNotice = output.notice || (run.replayIncomplete
    ? '部分执行过程已超出本地保留范围。' : '');
  if (doneEvt && Array.isArray(doneEvt.relay_unapplied_inputs) && doneEvt.relay_unapplied_inputs.length) {
    run.turn.outputNotice = [run.turn.outputNotice, '有补充要求尚未处理，请查看补充消息的状态。'].filter(Boolean).join('\n');
  }
  syncRunOutputActivity(run, wasViewing);
  if (wasViewing) {
    if (run.turn.outputNotice) appendMessage('system', run.turn.outputNotice);
  }
  // result 正常到达时归并器已完成；异常退出/中止 result 缺失时由 job-done 补齐最终状态。
  if (run.activityState && window.RelayActivity) {
    window.RelayActivity.finish(
      run.activityState,
      explicitlyAborted ? (run.pauseRequested ? '已暂停' : '已由用户中止') : (failed ? (run.error || `运行异常结束（错误码 ${exitCode}）`) : null),
      doneEvt,
    );
    updateRunActivity(run, wasViewing, true);
  }
  if (wasViewing && failed && !willAutoRecover) showRunError(run, run.turn.error);

  // 拿到目标 conv(优先内存里的 currentConv,否则从 disk 读)
  let conv;
  if (currentConv && currentConv.id === convId) {
    conv = currentConv;
  } else {
    conv = await window.api.history.load(convId);
  }

  // ── 兜底:--resume 撞 "No conversation found" → 自动降级为新会话重跑一次 ──
  //   触发条件:本轮带着 sessionId 去 resume、却失败、且 stderr 明确是会话找不到。
  //   成因可能是 cwd 漂移(方案 A 没拦住的历史遗留)、会话文件被清理、后端切换等。
  //   降级动作:清空该 conv 的 sessionId、弹掉这条没有回复的失败 turn,带前文重跑
  //   (不再 --resume)。用 run.autoRetried 防止无限重试 —— 只自动救一次。
  //   willAutoRecover 已在上面算好(sessionGone && sessionId && !autoRetried)。
  if (failed && willAutoRecover && conv) {
    runs.delete(convId);
    jobToConv.delete(jobId);
    conv.sessionId = null;
    // 弹掉失败的占位 turn(send 时压入、assistant 为空),重跑会重新压入一条
    const lastT = conv.turns[conv.turns.length - 1];
    const failedUser = lastT ? lastT.user : '';
    const failedFiles = lastT ? (lastT.files || []) : [];
    const failedSkill = lastT ? (lastT.skill || null) : null;
    if (lastT && !lastT.assistant) conv.turns.pop();
    await window.api.history.save(conv);
    if (isStillViewing()) {
      appendMessage('system', '会话已失效，正在自动重新开始（已带上前面的对话继续）…');
    }
    await relaunchWithoutResume(conv, failedUser, failedFiles, failedSkill, Date.parse(run.turn.ts),
      { taskRun: run.taskRun, inputKind: run.turn.inputKind, retryOfRunId: jobId });
    return;
  }

  if (conv) {
    if (run.pauseRequested && explicitlyAborted) conv.paused = { runId: jobId, at: new Date().toISOString() };
    else if (failed && window.RelayTaskContinuity?.isResume(run.turn)) {
      conv.paused = { runId: jobId, at: new Date(run.turn.taskRun.segmentFinishedAt).toISOString() };
    }
    if (!failed && !explicitlyAborted) {
      if (conv.paused && conv.paused.runId === run.resumedPauseId) delete conv.paused;
      if (run.carryContextReason && conv.carryContextOnNextTurn === run.carryContextReason) delete conv.carryContextOnNextTurn;
    }
    // 更新本运行对应的 turn。恢复任务必须使用账本里的 turnIndex，
    // 否则用户在刷新期间又添加了新轮时，会把终态正文写到错误的末轮。
    const assistantTs = run.turn.assistant ? new Date().toISOString() : null;
    run.turn.assistantTs = assistantTs;
    const targetIndex = Number.isSafeInteger(run.turnIndex)
      && run.turnIndex >= 0 && run.turnIndex < conv.turns.length
      ? run.turnIndex : conv.turns.length - 1;
    const targetTurn = conv.turns[targetIndex];
    if (targetTurn) {
      if (run.turn.supplements) targetTurn.supplements = run.turn.supplements.map(input => ({ ...input }));
      targetTurn.assistant = run.turn.assistant;
      targetTurn.output = run.turn.output;
      targetTurn.error = run.turn.error;
      targetTurn.status = run.turn.status;
      if (run.turn.taskRun) targetTurn.taskRun = run.turn.taskRun;
      if (run.turn.inputKind === 'resume') targetTurn.inputKind = 'resume';
      targetTurn.outputNotice = run.turn.outputNotice || null;
      if (assistantTs) targetTurn.assistantTs = assistantTs;
      targetTurn.thinking  = run.turn.thinkingList.join('\n\n--- 下一段思考 ---\n\n') || null;
      if (run.activityState && window.RelayActivity) {
        targetTurn.activity = window.RelayActivity.serialize(run.activityState);
      }
      // 保留旧协作日志以兼容存量数据；新运行只写统一的 output/activity。
      if (run.turn.chat && run.turn.chat.length) targetTurn.chat = run.turn.chat;
    }
    // 仅成功轮写回 sessionId;失败轮保持原 sessionId(可能为空 → 下一轮当新对话重开,不会撞幽灵 session)
    if (!failed && run.sessionId) {
      conv.sessionId = run.sessionId;
      if (run.sessionProviderId) conv.sessionProviderId = run.sessionProviderId;
      conv.sessionProviderRevision = Number(run.sessionProviderRevision || conv.sessionProviderRevision || 0);
      conv.sessionRouteTier = run.sessionRouteTier || conv.sessionRouteTier || run.sessionModel;
      conv.sessionAgentEnvironment = run.sessionAgentEnvironment || 'native';
    }
    const saved = await window.api.history.save(conv);
    conv.updatedAt = saved.updatedAt;
    if (isStillViewing() && assistantTs && currentAssistantBubble && currentAssistantBubble.isConnected) {
      appendMessageTime(currentAssistantBubble, assistantTs);
    }
  }

  // 清理 run
  runs.delete(convId);
  jobToConv.delete(jobId);

  // 当前所看会话的运行态:若结束的正是它,关闭 running UI
  if (isStillViewing()) {
    if (!failed && run.sessionId) currentSessionId = run.sessionId;  // 失败轮不更新,避免下一轮 resume 幽灵 session
    setRunning(false);
    if (explicitlyAborted && !run.pauseRequested) appendMessage('system', '已中止');
  }
  await refreshHistoryList();
  refreshClaudeRuntimeInfo(convId).catch(() => {});
  if (run.recoveryRerender && isStillViewing()) {
    if (activeView === 'chat') await loadConversation(convId, null, { forceReload: true });
    else pendingConversationViewReloads.add(`chat:${convId}`);
  }

  // 仅当首轮【成功】时才用快模型生成标题(否则会把"Not logged in"之类报错当成标题)
  if (!failed && !explicitlyAborted && isFirstLogicalTask(conv)) maybeGenerateTitle(conv);

  // Curator 二期:纠正/重试/工具失败恢复等强信号立即提炼，每 N 轮兜底(fire-and-forget,不阻塞 UI)。
  //   排除:失败轮 / 创作会话 / 定时任务产出的会话。节奏与开关由 main 侧配置。
  if (!failed && !explicitlyAborted && conv && conv.kind !== 'create' && !conv.fromScheduled) maybeAutoReviewSkills(conv);
}

// 终态清理必须比历史落盘更可靠：磁盘满、IPC 断开或历史文件损坏都只能让
// “本轮记录未完整保存”，不能把已经结束的后端任务永久留在运行态。
async function finishRun(jobId, doneEvt) {
  const run = runForJob(jobId);
  if (!run) return;
  if (run.finishPromise) return run.finishPromise;
  if (run.finishing) return;
  const convId = run.convId;
  run.finishPromise = Promise.resolve().then(async () => {
  try {
    await finishRunUnsafe(jobId, doneEvt);
  } catch (error) {
    run.finishError = error;
    console.error('finishRun: 终态持久化失败，已强制释放运行态', error);
    if (runs.get(convId) === run) runs.delete(convId);
    if (jobToConv.get(jobId) === convId) jobToConv.delete(jobId);

    // 自动恢复成功时会在同一 convId 下放入一个新 run；绝不能把新一轮关掉。
    const replacement = runs.get(convId);
    if (currentConv && currentConv.id === convId && !replacement) {
      setRunning(false);
      appendMessage('error', `任务已经结束，但本轮记录未能完整保存：${(error && error.message) || '未知错误'}`);
    }
    try { await refreshHistoryList(); } catch (_) {}
    refreshClaudeRuntimeInfo(convId).catch(() => {});
  }
  });
  return run.finishPromise;
}

const SKILL_REVIEW_CORRECTION_RE = /(不对|不是(?:这个|这样|我的意思)|我说的是|你理解错|搞错了|别再|不要再|怎么又|应该改成|应该是|重新来|并没有|仍然不对|还是不对|that'?s not what i meant|you misunderstood|not like that)/i;

function normalizeReviewText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:'"“”‘’`()\[\]{}<>]/g, '');
}

function reviewTextSimilarity(a, b) {
  const left = normalizeReviewText(a), right = normalizeReviewText(b);
  if (left.length < 12 || right.length < 12 || /^(继续|再试试|重试)$/.test(left)) return 0;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
    return set;
  };
  const x = grams(left), y = grams(right);
  let hit = 0;
  for (const token of x) if (y.has(token)) hit++;
  return hit / Math.max(1, x.size + y.size - hit);
}

function reviewTraceSafe(value, max = 180) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/ig, '$1=••••••••')
    .replace(/\s{2,}/g, ' ')
    .trim().slice(0, max);
}

function compactReviewToolTrace(turn) {
  const items = turn && turn.activity && Array.isArray(turn.activity.items) ? turn.activity.items : [];
  const tools = items.filter((item) => item && (item.type === 'tool' || item.type === 'task'));
  if (!tools.length) return '';
  const lines = [];
  for (const item of tools) {
    const status = item.status === 'error' ? '失败' : item.status === 'success' ? '成功' : '未完成';
    const name = reviewTraceSafe(item.toolName || item.title || (item.type === 'task' ? '后台任务' : '工具'), 80);
    const detail = item.status === 'error'
      ? reviewTraceSafe(item.error || item.result || item.detail, 220)
      : reviewTraceSafe(item.detail, 120);
    lines.push(`- ${name}：${status}${detail ? ` — ${detail}` : ''}`);
    if (lines.join('\n').length >= 3200) break;
  }
  return lines.length ? `[工具轨迹]\n${lines.join('\n')}` : '';
}

function skillReviewSignalReasons(conv) {
  const turns = Array.isArray(conv && conv.turns) ? conv.turns : [];
  const latest = turns[turns.length - 1] || {};
  const previous = turns[turns.length - 2] || {};
  const reasons = [];
  if (SKILL_REVIEW_CORRECTION_RE.test(String(latest.user || ''))) reasons.push('用户明确纠正或重述了要求');
  if (reviewTextSimilarity(latest.user, previous.user) >= 0.72) reasons.push('用户高相似度重发了上一轮请求');
  const items = latest.activity && Array.isArray(latest.activity.items) ? latest.activity.items : [];
  const tools = items.filter((item) => item && (item.type === 'tool' || item.type === 'task'));
  const failed = tools.filter((item) => item.status === 'error');
  if (failed.length >= 2) reasons.push('本轮出现连续工具失败');
  if (failed.length) {
    const failedNames = new Set(failed.map((item) => item.toolName || item.title).filter(Boolean));
    if (tools.some((item) => item.status === 'success' && failedNames.has(item.toolName || item.title))) {
      reasons.push('工具失败后通过替代路径恢复成功');
    }
  }
  return [...new Set(reasons)];
}

// 信号命中立即 review；每 N 轮只作为兜底。skillReviewThroughTurn 防止同一批轮次重复审查。
async function maybeAutoReviewSkills(conv) {
  try {
    const cfg = await window.api.skills.getReviewConfig();
    if (!cfg || !cfg.ok || !cfg.enabled) return;
    const n = cfg.everyTurns || 6;
    const turnCount = (conv.turns || []).length;
    if (turnCount < 1) return;
    const reviewedThrough = Math.max(0, Number(conv.skillReviewThroughTurn) || 0);
    if (reviewedThrough >= turnCount) return;
    const signalReasons = skillReviewSignalReasons(conv);
    const periodic = turnCount % n === 0;
    if (!signalReasons.length && !periodic) return;

    // 强信号只回看最近三轮，避免纠正信号被无关历史稀释；定期兜底只看尚未审查的窗口。
    const start = signalReasons.length
      ? Math.max(reviewedThrough, turnCount - 3)
      : Math.max(reviewedThrough, turnCount - n);
    const blocks = [];
    for (const t of (conv.turns || []).slice(start)) {
      if (!t) continue;
      const u = (t.user || '').trim();
      const a = (t.assistant || '').trim();
      let b = '';
      if (u) b += `我：${u}\n`;
      if (a) b += `你：${a}`;
      const trace = compactReviewToolTrace(t);
      if (trace) b += `${b ? '\n' : ''}${trace}`;
      if (b.trim()) blocks.push(b.trim());
    }
    if (!blocks.length) return;
    let text = blocks.join('\n\n');
    const MAX = 16000;   // 对话 + 紧凑工具轨迹总预算
    if (text.length > MAX) text = '（较早的对话已省略）\n\n' + text.slice(text.length - MAX);
    const workingDir = (conv.workingDir && conv.workingDir.path) ? conv.workingDir.path : null;
    const triggerReason = signalReasons.length ? signalReasons.join('；') : `每 ${n} 轮定期兜底`;
    const result = await window.api.skills.autoReview(text, workingDir, triggerReason);
    if (result && result.ok && (result.started || result.queued)) {
      conv.skillReviewThroughTurn = turnCount;
      conv.lastSkillReviewReason = triggerReason;
      try { await window.api.history.save(conv); } catch (_) {}
    }
  } catch (_) { /* review 失败不影响主流程 */ }
}

// 方案 B 的降级重跑:把指定会话以「新线程(不 --resume)+ 文字前文」重发一轮。
//   只被 finishRun 的兜底分支调用;复用 conv 自身记录的 模型档位/工作目录/agent。
async function relaunchWithoutResume(conv, userText, files, skill = null, taskStartedAt = null, continuity = null) {
  if (!conv) return;
  const filesToSend = Array.isArray(files) ? files : [];
  // 前文 = 已有历史(此时失败 turn 已被弹掉),拼成文字上下文带进新线程
  const ctx = buildContextPreamble(conv.turns, conv);
  const userPrompt = continuity?.inputKind === 'resume' ? window.RelayTaskContinuity.RESUME_PROMPT : userText || '';
  let promptToSend = userPrompt;
  if (ctx) promptToSend = `${ctx}\n\n${userPrompt}`.trim();
  if (skill && skill.name) {
    const invokeSkill = `请先调用 Skill 工具加载「${skill.callName || skill.name}」技能，并严格按照该技能处理下面的请求。`;
    promptToSend = `${invokeSkill}\n\n${promptToSend}`.trim();
  }

  const convId = conv.id;
  const sessionModel = conv.sessionModel || conv.model || null;
  const modelToSend = runtimeModelForValue(sessionModel);
  const selectedProviderRoute = configuredChatRoute(modelToSend);
  const sessionRouteForRun = sessionRouteSnapshot(selectedProviderRoute, modelToSend);
  const effortToSend = conv.effort || null;
  const agentName = conv.agent || null;
  const orchAgents = conv.orchestrateAgents || null;
  const workingDirPath = (conv.workingDir && conv.workingDir.path) ? conv.workingDir.path : null;
  const mode = conv.mode || 'plain';
  if (sessionRouteForRun) {
    conv.sessionProviderId = sessionRouteForRun.providerId;
    conv.sessionProviderRevision = sessionRouteForRun.providerRevision;
    conv.sessionRouteTier = sessionRouteForRun.routeTier;
    conv.sessionAgentEnvironment = sessionRouteForRun.agentEnvironment || 'native';
  }

  // Automatic recovery continues the same task clock, including the failed attempt.
  const startedAt = Number.isFinite(taskStartedAt) && taskStartedAt > 0 && taskStartedAt <= Date.now() ? taskStartedAt : Date.now();
  // 重新压入这条 turn 的占位(与 send 一致,供 finishRun 回填)
  const clientRunId = newClientRunId();
  const turnIndex = conv.turns.length;
  const taskRun = window.RelayTaskContinuity?.normalize(continuity?.taskRun);
  const inputKind = taskRun?.resumedFromRunId && continuity?.inputKind === 'resume' ? 'resume' : undefined;
  const turn = {
    user: userText, assistant: '', thinkingList: [], files: filesToSend, skill, taskRun, inputKind, runId: clientRunId,
    ts: new Date(startedAt).toISOString(), activityState: newActivityState({ startedAt, taskRun }), activityEl: null,
  };
  conv.turns.push({ user: userText, assistant: '', thinking: null, files: filesToSend, skill, ts: turn.ts, runId: clientRunId, taskRun, inputKind });
  const saved = await window.api.history.save(conv);
  conv.updatedAt = saved.updatedAt;

  if (currentConv && currentConv.id === convId) {
    setRunning(true);
    retirePreviousTaskProcesses(taskRun, { retry: true });
    turn.activityEl = appendActivityState(turn.activityState, false);
  }
  await refreshHistoryList();

  // 走到这条路 = 该对话的 session 已经接不回了。先把主进程里这个对话的常驻进程和它记住的
  //   session_id 一并丢掉,否则下一轮正常发送会拿着同一个坏 id 再 --resume 一次,又坏回去。
  try { await window.api.dropClaudeSession(convId); } catch (_) {}

  // 关键:sessionId 传 null —— 当全新会话开,不再撞 "No conversation found"。
  //   convId 也传 null:这条路正是因为常驻/续接出了问题才走到的,必须彻底另起炉灶,
  //   不能复用该对话的常驻进程(它挂着的正是那个坏掉的 session)。
  // 先登记 run 再调用 IPC：SDK 的 init/assistant 事件可能早于 invoke 返回。
  const run = {
    jobId: clientRunId,
    convId, turnIndex,
    sessionId: null,
    sessionModel,
    sessionProviderId: sessionRouteForRun && sessionRouteForRun.providerId,
    sessionProviderRevision: sessionRouteForRun && sessionRouteForRun.providerRevision,
    sessionRouteTier: sessionRouteForRun && sessionRouteForRun.routeTier,
    sessionAgentEnvironment: sessionRouteForRun?.agentEnvironment || 'native',
    sessionEffort: effortToSend,
    turn,
    error: null,
    stderrBuf: '',
    autoRetried: true, taskRun,
    mode,
    activityState: turn.activityState,
    activityEl: turn.activityEl,
    currentStreamMessageId: null,
    textDeltaMessageIds: new Set(),
  };
  runs.set(convId, run);
  jobToConv.set(clientRunId, convId);

  const result = await window.api.runClaude(
    promptToSend, null, mode, filesToSend, modelToSend, effortToSend,
    agentName, workingDirPath, orchAgents, convId, true, clientRunId, convId, { userPrompt, taskStartedAt: startedAt, taskRun, ...(inputKind ? { inputKind } : {}), retryOfRunId: continuity?.retryOfRunId, turnRef: { index: turnIndex, ts: turn.ts } }, sessionRouteForRun, conv.executionMode || { kind: 'default' },
  );
  if (!result || result.error) {
    run.launchError = result && result.error || '任务启动失败';
    if (runs.get(convId) === run) runs.delete(convId);
    jobToConv.delete(clientRunId);
    if (turn.activityState && window.RelayActivity) {
      window.RelayActivity.finish(turn.activityState, (result && result.error) || '自动重试启动失败', result);
      const failedTurn = conv.turns && conv.turns[conv.turns.length - 1];
      if (failedTurn) {
        failedTurn.activity = window.RelayActivity.serialize(turn.activityState);
        failedTurn.taskRun = turn.activityState.taskRun;
        failedTurn.error = run.launchError;
        failedTurn.status = 'error';
        if (window.RelayTaskContinuity?.isResume(failedTurn)) {
          conv.paused = { runId: clientRunId, at: new Date(failedTurn.taskRun.segmentFinishedAt).toISOString() };
        }
      }
      try { await window.api.history.save(conv); } catch (_) {}
    }
    if (currentConv && currentConv.id === convId) {
      if (turn.activityEl && turn.activityState && window.RelayActivity) window.RelayActivity.updateElement(turn.activityEl, turn.activityState);
      appendMessage('error', (result && result.error) || '自动重试启动失败');
      setRunning(false);
    }
    return;
  }
  if (runs.get(convId) === run) {
    run.sessionProviderId = result.providerId || run.sessionProviderId;
    run.sessionProviderRevision = Number(result.providerRevision || run.sessionProviderRevision || 0);
    run.sessionRouteTier = result.routeTier || run.sessionRouteTier;
    run.sessionAgentEnvironment = result.agentEnvironment || run.sessionAgentEnvironment || 'native';
  }
  // 极快任务可能已在 await 期间完成并清理；不能在这里把它重新放回运行态。
  if (runs.get(convId) === run && result.jobId && result.jobId !== clientRunId) {
    jobToConv.delete(clientRunId);
    run.jobId = result.jobId;
    jobToConv.set(result.jobId, convId);
  }
  refreshHistoryList();
}

// 为「AI 重新总结标题」构造素材:每轮用户消息截 60 字、从最新往回攒(预算 ~700 字)——
//   短会话可覆盖全程,长会话自动「近期完整、远期挤掉」;另附最新助手回复节选(当前讨论落点)。
//   不给首轮特殊地位:用户点重新总结,多半正是因为首轮已代表不了这个会话。
function isFirstLogicalTask(conv) {
  const turns = conv?.turns || [];
  if (turns.length === 1) return true;
  const latest = window.RelayTaskContinuity?.normalize(turns.at(-1)?.taskRun);
  return !!latest && turns.every((turn, index) =>
    window.RelayTaskContinuity.normalize(turn.taskRun)?.taskId === latest.taskId
    || index === 0 && turn.runId === latest.taskId);
}
function buildTitleMaterial(conv) {
  const isCreate = conv.kind === 'create';
  const turns = (conv.turns || []).filter((t) => t && (isCreate ? t.prompt : t.user));
  if (!turns.length) return '';
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = [];
  let budget = 700;
  for (let i = turns.length - 1; i >= 0; i--) {
    const u = clean(isCreate ? turns[i].prompt : turns[i].user, 60);
    if (!u) continue;
    if (u.length > budget) break;
    budget -= u.length;
    lines.unshift(`第${i + 1}轮:${u}`);
  }
  let mat = `以下是一段${isCreate ? '图片创作' : ''}多轮对话中每轮用户消息的摘录(从早到晚):\n${lines.join('\n')}`;
  const lastA = isCreate ? '' : clean(conv.turns.at(-1)?.assistant, 180);
  if (lastA) mat += `\n最新一轮助手回复(节选):${lastA}`;
  mat += '\n请以对话的整体主题为主、兼顾最近几轮的讨论重心。';
  return mat;
}

// 用快模型把首轮对话总结成简短标题,写回会话 + 刷新侧边栏
async function maybeGenerateTitle(conv) {
  if (!conv || conv.titleGenerated) return;
  const first = (conv.turns || [])[0];
  if (!first || !first.user) return;
  conv.titleGenerated = true;  // 占位避免并发重复;失败时不存盘,下次仍可重试
  const completed = isFirstLogicalTask(conv) ? conv.turns.at(-1) : first;
  const text = `用户:${(first.user || '').slice(0, 400)}\n助手:${(completed.assistant || '').slice(0, 300)}`;
  let title = '';
  try {
    const res = await window.api.summarizeTitle(text);
    title = (res && res.title || '').trim();
  } catch (_) {}
  if (!title) return;  // 失败保留原标题
  // 写回前从磁盘读最新状态:等待摘要的几秒里用户可能已手动重命名(titleManual),手动命名优先。
  //   与 maybeTitleCreateConv 同款「读回只改 title 再存」,不整存传入的 conv(它可能已积累新数据)。
  const fresh = await window.api.history.load(conv.id);
  if (!fresh || fresh.titleManual) return;
  fresh.title = title; fresh.titleGenerated = true;
  await window.api.history.save(fresh);
  conv.title = title;   // 同步内存对象,防后续整存把旧标题写回
  if (currentConv && currentConv.id === conv.id) {
    currentConv.title = title;
    chatTitle.textContent = title;
  }
  await refreshHistoryList();
}

// ─────────────────────────────────────────
// 监听后端 claude 事件流
// ─────────────────────────────────────────
let restoringActiveRuns = true;
const bufferedClaudeEvents = [];
window.api.onEvent((evt) => {
  if (restoringActiveRuns) bufferedClaudeEvents.push(evt);
  else handleClaudeEvent(evt);
});

let restoringTaskLifecycle = true;
const bufferedTaskLifecycleEvents = [];
const TERMINAL_LEDGER_STATES = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);

function claudeEventFingerprint(event) {
  try { return JSON.stringify(event); } catch (_) { return ''; }
}

function taskRunFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return payload.run || payload.task || event.run || event.task || null;
}

function taskSource(task) {
  return task && task.source && typeof task.source === 'object' ? task.source : {};
}

function taskIsTerminal(task) {
  return !!(task && TERMINAL_LEDGER_STATES.has(String(task.state || task.status || '').toLowerCase()));
}

function taskIsCreation(task) {
  const source = taskSource(task);
  return String(task && task.kind || '').toLowerCase() === 'image'
    || source.type === 'creation' || source.conversationKind === 'create';
}

function taskCanRestoreChat(task, epoch = null) {
  if (!task || taskIsCreation(task)) return false;
  // The mini controller remains the writer through its terminal save as well.
  // Older interrupted app instances still use the normal history recovery path.
  if (taskSource(task).type === 'mini' && (!taskIsTerminal(task)
      || (epoch && task.execution && task.execution.appInstanceId === epoch))) return false;
  const source = taskSource(task);
  return !!source.conversationId && ['chat', 'agent', 'orchestrate'].includes(String(task.kind || '').toLowerCase());
}

function taskTurnHasPersistedOutcome(turn) {
  // 已落盘的失败、暂停或空回复也是终态，不能仅凭 assistant 为空再次恢复。
  // 不把 activity 阶段当作落盘依据：无明确状态的旧占位轮仍可从日志补回最终回复。
  const terminalStatuses = ['complete', 'completed', 'succeeded', 'success', 'error', 'failed',
    'canceled', 'cancelled', 'aborted', 'paused', 'interrupted'];
  return !!turn && [turn.status, turn.output && turn.output.status]
    .some(status => terminalStatuses.includes(String(status || '').trim().toLowerCase()));
}

function taskHasEmptyInterruptedProgress(task, turn) {
  return task?.state === 'interrupted' && task.result?.error?.code === 'APP_RESTART'
    && taskTurnHasPersistedOutcome(turn) && !savedAssistantDisplay(turn).text
    && !turn?.activity?.items?.length && !turn?.output?.messages?.length && !turn?.thinking
    && !turn?.chat?.length;
}

function taskTurnLocation(conv, task, { allowLastFallback = false } = {}) {
  if (!conv || !Array.isArray(conv.turns) || !conv.turns.length || !task) return null;
  const source = taskSource(task);
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const preferredIndex = Number.isSafeInteger(source.turnIndex)
    ? source.turnIndex : (Number.isSafeInteger(metadata.turnIndex) ? metadata.turnIndex : null);
  const preferredTs = source.turnTs || metadata.turnTs || null;
  const accepts = (turn) => {
    if (!turn) return false;
    if (turn.runId && task.runId && turn.runId !== task.runId) return false;
    if (preferredTs && turn.ts && turn.ts !== preferredTs) return false;
    return true;
  };
  if (preferredIndex != null && preferredIndex >= 0 && preferredIndex < conv.turns.length
      && accepts(conv.turns[preferredIndex])) {
    return { index: preferredIndex, turn: conv.turns[preferredIndex], exact: true };
  }
  if (task.runId) {
    const byRunId = conv.turns.findIndex((turn) => turn && turn.runId === task.runId);
    if (byRunId >= 0) return { index: byRunId, turn: conv.turns[byRunId], exact: true };
  }
  if (preferredTs) {
    const byTs = conv.turns.findIndex((turn) => turn && turn.ts === preferredTs && accepts(turn));
    if (byTs >= 0) return { index: byTs, turn: conv.turns[byTs], exact: true };
  }
  if (!allowLastFallback) return null;
  const index = conv.turns.length - 1;
  return { index, turn: conv.turns[index], exact: false };
}

function taskErrorText(task, fallback = '任务未完成') {
  const value = task && task.result && task.result.error;
  if (value?.code === 'APP_RESTART') return 'Relay 在任务完成前关闭，本次任务已中断。';
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  return fallback;
}

function registerCreationTask(task, { restored = true } = {}) {
  const source = taskSource(task);
  const convId = source.conversationId;
  if (!task || !task.runId || !convId || taskIsTerminal(task)) return;
  const previous = cvJobs.get(convId);
  cvJobs.set(convId, {
    ...(previous && typeof previous === 'object' ? previous : {}),
    runId: task.runId,
    turnIndex: Number.isSafeInteger(source.turnIndex) ? source.turnIndex : null,
    restored: !!(restored || (previous && previous.restored)),
  });
  cvSyncGenerateBtn();
}

async function reconcileCreationTask(task) {
  if (!task || !task.runId || !taskIsTerminal(task)) return;
  const source = taskSource(task);
  const convId = source.conversationId;
  if (!convId) return;
  const tracked = cvJobs.get(convId);
  const ownsTrackedSlot = !tracked || !tracked.runId || tracked.runId === task.runId;
  if (ownsTrackedSlot) cvJobs.delete(convId);

  try {
    const conv = await window.api.history.load(convId);
    const located = taskTurnLocation(conv, task);
    if (located) {
      const turn = located.turn;
      const state = String(task.state || '').toLowerCase();
      const paths = task.result && Array.isArray(task.result.artifactPaths)
        ? task.result.artifactPaths.filter((item) => typeof item === 'string' && item) : [];
      let changed = false;
      if (state === 'succeeded' && paths.length && (!Array.isArray(turn.resultPaths) || !turn.resultPaths.length)) {
        turn.resultPaths = [...new Set(paths)];
        delete turn.error;
        changed = true;
      } else if (!Array.isArray(turn.resultPaths) || !turn.resultPaths.length) {
        const error = state === 'canceled'
          ? '任务已取消'
          : (state === 'succeeded'
            ? '任务已完成，但没有可用的图片结果'
            : taskErrorText(task, '图片生成未完成'));
        if (turn.error !== error) {
          turn.error = error;
          changed = true;
        }
      }
      if (!turn.runId) { turn.runId = task.runId; changed = true; }
      if (changed) await window.api.history.save(conv);
    }
  } catch (error) {
    console.warn('恢复创作任务结果失败', error);
  }

  if (ownsTrackedSlot && currentCreateConv && currentCreateConv.id === convId) {
    if (activeView === 'create') await loadCreateConv(convId, null, { forceReload: true });
    else {
      pendingConversationViewReloads.add(`create:${convId}`);
      cvSyncGenerateBtn();
      await refreshHistoryList();
    }
  } else {
    cvSyncGenerateBtn();
    await refreshHistoryList();
  }
}

async function reconcileRestoredChatTask(task) {
  if (!task || !task.runId || !taskIsTerminal(task)) return;
  const run = runForJob(task.runId);
  if (!run || !run.restoredFromLedger || run.finishing) return;
  const state = String(task.state || '').toLowerCase();
  if (state === 'succeeded') {
    await finishRun(task.runId, { ...run.recoveredTerminalEvent, exitCode: 0 });
    return;
  }
  if (state === 'canceled') {
    run.abortRequested = true;
    run.recoveryRerender = true;
    await finishRun(task.runId, { ...run.recoveredTerminalEvent, exitCode: -1 });
    return;
  }
  const error = taskErrorText(task, state === 'interrupted' ? '任务意外中断' : '任务执行失败');
  run.error = error;
  run.recoveryRerender = true;
  await finishRun(task.runId, { ...run.recoveredTerminalEvent, exitCode: -1, error });
}

async function handleTaskLifecycleEvent(event, { settleNow = false } = {}) {
  if (Array.isArray(event)) {
    for (const item of event) await handleTaskLifecycleEvent(item, { settleNow });
    return;
  }
  const task = taskRunFromEvent(event) || (event && event.runId ? event : null);
  if (!task || !task.runId) return;
  if (taskIsCreation(task)) {
    if (taskIsTerminal(task)) {
      if (settleNow) await reconcileCreationTask(task);
      else window.setTimeout(() => { void reconcileCreationTask(task); }, 50);
    } else {
      registerCreationTask(task, { restored: !cvJobs.has(taskSource(task).conversationId) });
      await refreshHistoryList();
    }
    return;
  }
  if (taskIsTerminal(task) && runForJob(task.runId) && runForJob(task.runId).restoredFromLedger) {
    if (settleNow) await reconcileRestoredChatTask(task);
    else window.setTimeout(() => { void reconcileRestoredChatTask(task); }, 50);
  }
}

if (window.api.tasks && typeof window.api.tasks.onEvent === 'function') {
  window.api.tasks.onEvent((event) => {
    if (restoringTaskLifecycle) bufferedTaskLifecycleEvents.push(event);
    else void handleTaskLifecycleEvent(event);
  });
}

async function restoreActiveRunsFromLedger() {
  const replayed = new Set();
  let snapshot = null;
  const restoredJobIds = new Set();
  const restoredCreationRunIds = new Set();
  const replayPlans = [];
  try {
    if (!window.api.tasks || typeof window.api.tasks.snapshot !== 'function'
        || typeof window.api.tasks.replayStream !== 'function') return;
    // 同时取活跃任务和最近终态：若任务在快照返回前已终态，仅查 active
    // 会永久错过它的 job-done/最终正文。主进程保证未完成任务不受 limit 挤压。
    snapshot = await window.api.tasks.snapshot({ limit: 2000 });
    if (!snapshot || snapshot.ok === false) return;
    const ledgerTasks = Array.isArray(snapshot.items) ? snapshot.items : [];
    for (const task of ledgerTasks) {
      const runId = task && task.runId;
      const source = taskSource(task);
      const convId = source.conversationId;
      if (!runId || !convId) continue;
      if (taskIsCreation(task)) {
        if (!taskIsTerminal(task)) {
          registerCreationTask(task);
          restoredCreationRunIds.add(runId);
        }
        continue;
      }
      if (!taskCanRestoreChat(task, snapshot.epoch) || runs.has(convId)) continue;
      const conv = await window.api.history.load(convId);
      if (!conv || !Array.isArray(conv.turns) || !conv.turns.length) continue;
      const located = taskTurnLocation(conv, task, { allowLastFallback: !taskIsTerminal(task) });
      const repairInterrupted = located && taskHasEmptyInterruptedProgress(task, located.turn);
      // 终态历史只修复能精确对应且仍缺回复的占位轮，避免重放旧任务覆盖正常历史。
      if (!located || (taskIsTerminal(task) && !repairInterrupted
          && (taskTurnHasPersistedOutcome(located.turn)
            || savedAssistantDisplay(located.turn).text
            || (!located.turn.output && Array.isArray(located.turn.chat) && located.turn.chat.length)))) continue;
      const savedTurn = located.turn || {};
      const epoch = task.execution?.appInstanceId || snapshot.epoch;
      const progressReply = typeof window.api.tasks.progress === 'function'
        ? await window.api.tasks.progress(runId) : null;
      const candidate = progressReply?.ok && progressReply.progress;
      const progress = candidate?.runId === runId && candidate.epoch === epoch
        && Number.isSafeInteger(candidate.seq) && candidate.seq > 0 ? candidate : null;
      let firstPage = null;
      // A previous version may already have saved a blank APP_RESTART error.
      // Repair only with real process evidence, never resave empty errors on
      // every startup or turn a known failure into an invented final answer.
      if (repairInterrupted && !progress?.activity?.items?.length && !progress?.output?.messages?.length) {
        firstPage = await window.api.tasks.replayStream({ epoch, runId, sinceSeq: 0, limit: 5000 });
        if (!firstPage?.ok || !firstPage.events?.some(envelope => {
          const event = envelope.payload?.event;
          return envelope.runId === runId && ['assistant', 'user', 'stream_event'].includes(event?.type);
        })) continue;
      }
      const mode = source.mode || conv.mode || 'plain';
      const activityState = activityStateForTurn(progress ? { ...savedTurn, activity: progress.activity, output: progress.output } : savedTurn) || newActivityState();
      if (activityState && !taskIsTerminal(task)) { activityState.phase = 'running'; activityState.endedAt = null; }
      const turn = {
        user: savedTurn.user || '', assistant: '', thinkingList: savedTurn.thinking ? [savedTurn.thinking] : [],
        runId, inputKind: savedTurn.inputKind, taskRun: window.RelayTaskContinuity?.normalize(savedTurn.taskRun),
        output: progress?.output || (repairInterrupted ? null : savedTurn.output) || null,
        files: Array.isArray(savedTurn.files) ? savedTurn.files : [],
        skill: savedTurn.skill || null,
        supplements: Array.isArray(savedTurn.supplements) ? savedTurn.supplements.map(input => ({ ...input })) : [],
        ts: savedTurn.ts || task.createdAt || new Date().toISOString(),
        chat: Array.isArray(savedTurn.chat) ? savedTurn.chat.slice() : [],
        activityState, activityEl: null,
      };
      const restored = {
        jobId: runId, convId,
        turnIndex: located.index,
        sessionId: conv.sessionId || null,
        sessionModel: conv.sessionModel || conv.model || null,
        sessionEffort: conv.effort || null,
        sessionProviderId: conv.sessionProviderId || null,
        sessionProviderRevision: Number(conv.sessionProviderRevision || 0),
        sessionRouteTier: conv.sessionRouteTier || conv.sessionModel || conv.model || null,
        sessionAgentEnvironment: conv.sessionAgentEnvironment || 'native',
        turn, taskRun: turn.taskRun, error: null, stderrBuf: '', mode,
        activityState, activityEl: null,
        currentStreamMessageId: null,
        textDeltaMessageIds: new Set(),
        currentMessageHadTextDelta: false,
        restoredFromLedger: true,
        progressEpoch: epoch, progressSeq: progress?.deliverySeq || progress?.seq || 0,
        recoveredTerminalEvent: progress?.terminalEvent || null,
      };
      runs.set(convId, restored);
      jobToConv.set(runId, convId);
      restoredJobIds.add(runId);
      replayPlans.push({ runId, epoch, sinceSeq: progress?.seq || 0, firstPage });
    }

    // Each run owns an epoch and a saved cursor. A new app epoch must not hide
    // the previous process's log; a snapshot protects long runs from rotation.
    for (const plan of replayPlans) {
      let sinceSeq = plan.sinceSeq;
      for (;;) {
        const response = plan.firstPage || await window.api.tasks.replayStream({
          epoch: plan.epoch, runId: plan.runId, sinceSeq, limit: 5000,
        });
        plan.firstPage = null;
        if (!response || response.ok === false) {
          const run = runForJob(plan.runId);
          if (run) run.replayIncomplete = true;
          break;
        }
        const events = Array.isArray(response.events) ? response.events : [];
        if (response.resetRequired || response.damagedTail) {
          const run = runForJob(plan.runId);
          if (run) run.replayIncomplete = true;
        }
        for (const envelope of events) {
          const event = envelope && envelope.payload && envelope.payload.event;
          if (!event || (envelope.runId || event.jobId) !== plan.runId
              || (event.jobId && event.jobId !== plan.runId) || !runForJob(plan.runId)) continue;
          const fingerprint = claudeEventFingerprint(event);
          if (fingerprint) replayed.add(fingerprint);
          handleClaudeEvent({ ...event, jobId: plan.runId,
            relay_stream_epoch: plan.epoch, relay_stream_seq: event.relay_stream_seq || envelope.seq });
        }
        if (!events.length) {
          const compactedThrough = Number(response.compactedThroughSeq || 0);
          if (response.resetRequired && compactedThrough > sinceSeq) {
            sinceSeq = compactedThrough;
            continue;
          }
          break;
        }
        const nextSeq = Number(events[events.length - 1].seq) || sinceSeq;
        if (nextSeq <= sinceSeq) break;
        sinceSeq = nextSeq;
        if (!response.hasMore) break;
      }
    }
    if (currentConv && runs.has(currentConv.id)) {
      if (activeView === 'chat') await loadConversation(currentConv.id, null, { forceReload: true });
      else pendingConversationViewReloads.add(`chat:${currentConv.id}`);
    }
    refreshHistoryList();
  } catch (error) {
    console.warn('恢复运行中任务失败', error);
  } finally {
    restoringActiveRuns = false;
    for (const event of bufferedClaudeEvents.splice(0)) {
      const fingerprint = claudeEventFingerprint(event);
      if (!fingerprint || !replayed.has(fingerprint)) handleClaudeEvent(event);
    }
    restoringTaskLifecycle = false;
    for (const event of bufferedTaskLifecycleEvents.splice(0)) {
      await handleTaskLifecycleEvent(event, { settleNow: true });
    }
  }

  // 第二次权威快照关闭「首次 snapshot 时还在跑，重放前已终态」的竞态窗口。
  // 此时 job-done/实时事件都已先消费，只对仍留在恢复表的任务做降级收尾。
  try {
    const finalSnapshot = await window.api.tasks.snapshot({ limit: 2000 });
    if (finalSnapshot && finalSnapshot.ok !== false && Array.isArray(finalSnapshot.items)) {
      for (const task of finalSnapshot.items) {
        if (taskIsCreation(task)) {
          if (taskIsTerminal(task) && restoredCreationRunIds.has(task.runId)) {
            await reconcileCreationTask(task);
          } else if (!taskIsTerminal(task)) {
            registerCreationTask(task);
            restoredCreationRunIds.add(task.runId);
          }
        } else if (taskIsTerminal(task) && restoredJobIds.has(task.runId)) {
          await reconcileRestoredChatTask(task);
        }
      }
    }
  } catch (error) {
    console.warn('核对恢复任务终态失败', error);
  }
}

void restoreActiveRunsFromLedger();

// 待处理请求卡片通过统一事件打开来源会话，避免直接依赖页面内部函数。
window.addEventListener('relay:open-conversation', (event) => {
  const detail = event && event.detail || {};
  const convId = detail.conversationId;
  if (!convId) return;
  event.preventDefault();
  let navigationIntent = ++pageNavigationVersion;
  Promise.resolve(window.api.history.load(convId))
    .then((conv) => {
      if (navigationIntent !== pageNavigationVersion) return false;
      if (!conv) {
        showToast('这条历史记录已被删除');
        return;
      }
      const kind = conv.kind || detail.conversationKind;
      navigationIntent = pageNavigationVersion + 1; // loader 在同步入口取得下一枚令牌。
      return kind === 'create' ? loadCreateConv(convId) : loadConversation(convId);
    })
    .catch((error) => {
      if (navigationIntent !== pageNavigationVersion) return;
      console.error('打开来源会话失败', error);
      showToast('暂时无法打开这条对话');
    });
});

// 请求卡片可从其他视图恢复来源会话并定位到专用决策卡。
window.addEventListener('relay:focus-interaction', (event) => {
  const detail = event && event.detail || {};
  void (async () => {
    try {
      const opened = detail.conversationId ? await loadConversation(detail.conversationId) : showChatView();
      if (!opened) return;
      const navigation = pageNavigationVersion;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (navigation !== pageNavigationVersion || activeView !== 'chat'
            || (detail.conversationId && currentConv?.id !== detail.conversationId)
            || $('interactionSurfaceMount').hidden) return;
        const surface = document.querySelector('.interaction-surface');
        // 权限审批先聚焦标题，避免恢复焦点时意外落到决策按钮。
        const target = surface && (surface.dataset.kind === 'permission'
          ? surface.querySelector('.interaction-title')
          : surface.querySelector('input:checked, input:not([disabled]), summary, [tabindex="-1"]'));
        if (target) target.focus();
        if (surface) surface.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }));
    } catch (error) {
      showToast((error && error.message) || '无法打开这个待处理请求');
    }
  })();
});

// Quick chat writes its own history; opening Relay never resubmits the prompt.
if (window.api.mini && window.api.mini.onOpenConversation) {
  const openMiniConversation = async payload => {
    if (payload && payload.id) await loadConversation(payload.id, null, { forceReload: true });
  };
  window.api.mini.onOpenConversation(payload => { void openMiniConversation(payload).catch(console.warn); });
  window.api.mini.onHistoryChanged(payload => {
    void refreshHistoryList();
    if (payload && currentConv && currentConv.id === payload.id && !runs.has(payload.id)) {
      // Reload only on real conversation writes; a hidden/focused mini window
      // must never change history activity times or the selected conversation.
      if (activeView === 'chat') void loadConversation(payload.id, null, { forceReload: true }).catch(console.warn);
      else pendingConversationViewReloads.add(`chat:${payload.id}`);
    }
  });
  window.api.mini.mainReady().then(openMiniConversation).catch(console.warn);
}

// 兼容旧版后台 Agent 通过 user 消息发送的完成通知，只映射到活动流。
// 原始事件仍交给输出归并器，通知或子结果不会成为主助手的最终答案。
function activityEventsForClaudeEvent(event, activityState = null) {
  const content = event.type === 'user' && event.message && event.message.content;
  if (typeof content !== 'string' || !/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/i.test(content)) return [event];
  const read = (name) => {
    const match = content.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return match ? match[1].trim() : '';
  };
  const taskId = read('task-id');
  const knownTask = taskId && activityState && activityState.items.find((item) => item.taskId === taskId);
  const toolUseId = read('tool-use-id') || (knownTask && knownTask.toolUseId) || (taskId ? `legacy-task:${taskId}` : '');
  if (!toolUseId) return [event];
  const status = read('status').toLowerCase();
  const result = read('result');
  const events = [{ type: 'system', subtype: 'task_notification', tool_use_id: toolUseId,
    task_id: taskId || null, status: status || 'completed', summary: read('summary') }];
  if (result && !['running', 'pending'].includes(status)) events.push({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId,
      content: result, is_error: ['failed', 'error', 'killed'].includes(status) }] },
  });
  return events;
}

function permissionDenialMessage(event) {
  const denials = Array.isArray(event && event.permission_denials) ? event.permission_denials : [];
  if (!denials.length) return null;
  const tools = [];
  const seen = new Set();
  for (const denial of denials) {
    const name = String(denial && (denial.tool_name || denial.toolName) || '').replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (tools.length < 12) tools.push(name.slice(0, 120));
  }
  return `工具权限被拒绝（${denials.length} 次）${tools.length ? `：${tools.join('、')}` : ''}`;
}

function handleClaudeEvent(evt) {
  // 所有事件都带 jobId(后端注入);用它反查归属会话的 run。
  //   没有 jobId 的事件(理论上不该有)直接忽略,避免污染当前会话。
  const jobId = evt.jobId;
  const run = jobId ? runForJob(jobId) : null;
  if (!run) {
    // run 已被清理(已完成/已中止)却仍收到迟到事件 → 丢弃
    return;
  }
  if (evt.relay_stream_epoch && Number.isSafeInteger(evt.relay_stream_seq)) {
    if (run.progressEpoch === evt.relay_stream_epoch && evt.relay_stream_seq <= (run.progressSeq || 0)) return;
    run.progressEpoch = evt.relay_stream_epoch;
    run.progressSeq = evt.relay_stream_seq;
  }
  // 页面切换仅隐藏聊天 DOM；其流仍持续更新，返回时不需要重放或重新连 SDK。
  const onView = isMountedChatJob(jobId);
  if (evt.type === 'system' && evt.subtype === 'relay_user_input') {
    applyRunSupplement(run, evt.input);
    return;
  }

  const output = outputStateForRun(run);
  const previousOrder = output.eventOrder;
  window.RelayAssistantOutput.ingest(output, evt);
  if (output.eventOrder === previousOrder) return;  // 重放重叠帧已归并，不再重复追加子任务详情。

  const childOutput = !!window.RelayAssistantOutput.owner(evt);
  // 子任务的终态和会话信息不能结束主任务或覆盖主会话 ID。
  if (childOutput && (['result', 'job-done', 'stderr', 'raw'].includes(evt.type)
      || (evt.type === 'system' && evt.subtype === 'init'))) return;

  // 所有会话共用结构化归并器。子流文字由 output 按 parent 分轨，
  // 不让子流的 message_start 覆盖活动流正在跟踪的主助手工具块。
  if (run.activityState && window.RelayActivity && !(childOutput && evt.type === 'stream_event')) {
    for (const [index, activityEvent] of activityEventsForClaudeEvent(evt, run.activityState).entries()) {
      window.RelayActivity.ingest(run.activityState, {
        ...activityEvent, presentation_order: outputStateForRun(run).eventOrder + index / 1000,
      });
    }
    if (run.activityState.taskRun && !run.activityState.taskRun.segmentFinishedAt) {
      run.taskRun = window.RelayTaskContinuity.normalize(run.activityState.taskRun);
      run.turn.taskRun = run.taskRun;
    }
    updateRunActivity(run, onView, activityEventNeedsRender(evt));
  }

  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id) {
      run.sessionId = evt.session_id;
      if (onView) currentSessionId = evt.session_id;
    }
    return;
  }
  if (evt.type === 'conversation_reset') {
    if (childOutput || !evt.new_conversation_id) return;
    run.sessionId = evt.new_conversation_id;
    contextUsageByConv.delete(run.convId);
    contextUsageReadRevisions.set(run.convId, (contextUsageReadRevisions.get(run.convId) || 0) + 1);
    run.error = null; run.stderrBuf = '';
    const visibleTurn = currentConv?.id === run.convId
      ? currentConv.turns?.find(turn => turn.runId === jobId) : null;
    for (const turn of new Set([run.turn, visibleTurn].filter(Boolean))) {
      delete turn.contextUsage; delete turn.goalRecovery;
      if (turn.executionMode?.kind === 'goal') turn.executionMode = { kind: 'default' };
    }
    if (currentConv?.id === run.convId) {
      currentSessionId = evt.new_conversation_id;
      currentConv.sessionId = evt.new_conversation_id;
      delete currentConv.contextUsage; delete currentConv.goalRecovery;
      if (currentConv.executionMode?.kind === 'goal') currentConv.executionMode = { kind: 'default' };
      if (currentExecutionMode.kind === 'goal') currentExecutionMode = { kind: 'default' };
      // Invalidate reads/edits issued for the discarded context, including when
      // settings covers the current conversation and its chat DOM is unmounted.
      permissionModeEditRevision += 1;
      void refreshComposerPermission();
      getProjectComposer()?.sync();
    }
    if (onView) renderContextUsage(run.convId);
    syncRunOutputActivity(run, onView);
    return;
  }
  if (evt.type === 'system' && ['model_refusal_fallback', 'session_state_changed'].includes(evt.subtype)) {
    if (evt.subtype === 'model_refusal_fallback') syncRunOutputActivity(run, onView);
    if (onView && evt.subtype === 'session_state_changed') void refreshClaudeRuntimeInfo(run.convId, { includeContext: true });
    return;
  }
  if (evt.type === 'assistant' || evt.type === 'stream_event') {
    // A text block is provisional until the backend confirms this run's final result.
    const raw = evt.event || {};
    scheduleRunOutputActivity(run, onView, evt.type === 'assistant' || raw.type === 'message_stop');
    return;
  }

  if (evt.type === 'result') {
    syncRunOutputActivity(run, onView);
    if (evt.session_id) {
      run.sessionId = evt.session_id;
      if (onView) currentSessionId = evt.session_id;
    }
    const deniedError = permissionDenialMessage(evt);
    if (!run.abortRequested && (evt.is_error || (evt.subtype && evt.subtype !== 'success'))) {
      run.error = (Array.isArray(evt.errors) && evt.errors.join('\n')) || evt.result || evt.error || deniedError || '执行出错';
      if (evt.relay_error_description) run.error = `${evt.relay_error_description}\n\n${run.error}`;
      if (onView) showRunError(run, run.error);
    }
    // 真正的收尾在 job-done(result 之后还可能有残留事件);这里只记录状态。
    return;
  }

  // 后端进程结束(正常/异常/spawn 失败)→ 落盘 + 清理该 run
  if (evt.type === 'job-done') {
    void finishRun(jobId, evt);
    return;
  }

  if (evt.type === 'stderr') {
    // 始终累积到 run(无论用户在不在看),供失败收尾时回放;在看则同时实时显示
    if (run) run.stderrBuf += evt.text;
    // 会话失效(No conversation found)是可自动恢复的,别把这条底层 stderr 当报错弹给用户 ——
    //   收尾时 finishRun 会无声重跑并给一条温和提示。其它 stderr 仍实时显示,便于排查。
    const recoverable = /No conversation found with session ID/i.test(evt.text);
    if (onView && !recoverable) appendMessage('error', `[stderr] ${evt.text}`);
    return;
  }
  if (evt.type === 'raw') {
    if (onView) appendMessage('system', evt.text);
    return;
  }
}

// ─────────────────────────────────────────
// 消息渲染
// ─────────────────────────────────────────
function formatMessageTime(ts) {
  return window.RelayMessageTime.compact(ts);
}

function appendMessageTime(el, ts) {
  if (!el) return;
  const timeText = formatMessageTime(ts);
  if (!timeText) return;

  const actions = el.querySelector('.assistant-actions');
  const host = actions || el;
  let meta = el.querySelector('.message-meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'message-meta';
    host.appendChild(meta);
  }
  else if (meta.parentElement !== host) host.appendChild(meta);
  let time = meta.querySelector('.message-time');
  if (!time) {
    time = document.createElement('time');
    time.className = 'message-time';
    meta.appendChild(time);
  }
  time.dateTime = ts;
  time.textContent = timeText;
  time.title = window.RelayMessageTime.full(ts);
}

function appendMessage(role, text, files, meta = null) {
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();

  const el = document.createElement('div');
  el.className = `message ${role}`;

  if (role === 'assistant') {
    el.innerHTML = `<div class="bubble"><div class="body"></div></div>`;
    const body = el.querySelector('.body');
    el.dataset.raw = text || '';
    if (meta && meta.streaming) streamMarkdownRenderer.render(body, text || '');
    else body.innerHTML = renderMarkdown(text || '');
    body._relayRenderedText = text || '';
    if (!(meta && meta.streaming)) {
      enhanceCodeBlocks(body);
      if (text) appendAssistantCopy(el);
    }
    appendMessageTime(el, meta && meta.ts);
  } else if (role === 'error' && window.RelayActivity?.renderError) {
    el.innerHTML = window.RelayActivity.renderError(text);
    el.dataset.raw = text || '';
  } else {
    // 用户消息:附件区(若有)在气泡上方、右对齐
    if (role === 'user' && Array.isArray(files) && files.length) {
      el.appendChild(renderMsgAttachments(files));
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text || '';
    // 纯附件无文字时不显示空气泡
    if (text || !(role === 'user' && Array.isArray(files) && files.length)) {
      el.appendChild(bubble);
    }
    if (role === 'user') appendMessageTime(el, meta && meta.ts);
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}


// Stream the changing lexer blocks; completed blocks keep their DOM and syntax
// highlighting. Add code controls only when output settles, and coalesce deltas.
const STREAM_RENDER_MS = 60;
let streamRenderTimer = null;
let streamRenderBubble = null;   // 本轮渲染锚定的气泡,切换会话后失效则不再写

// 切换会话时同时解除旧消息树的所有持有者，后台任务只保留可重建的数据。
function clearConversationMessages() {
  detachStreamRenderTarget();
  window.RelayActivity?.clearTaskSummaries(messagesEl);
  // Background tasks retain their state, never the detached transcript tree.
  // loadConversation already rebuilds these view references from run.turn and
  // activityState when the user returns, including supplemental timelines.
  for (const run of runs.values()) {
    run.activityEl = null;
    run.outputBubble = null;
    run.errorEl = null;
    run.supplementTimeline = null;
    if (run.turn) run.turn.activityEl = null;
  }
  messagesEl.replaceChildren();
}

function detachStreamRenderTarget() {
  // Cancel the old bubble's queued frame before binding a new stream target.
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }
  streamRenderBubble = null;
  currentAssistantBubble = null;
}

// 渲染流式中的气泡:只出 markdown,不加按钮/折叠
function renderStreamBubble(bubble) {
  if (!bubble || !bubble.isConnected || bubble !== currentAssistantBubble) return false;
  const body = bubble.querySelector('.body');
  if (!body) return false;
  const text = bubble.dataset.displayRaw ?? bubble.dataset.raw ?? '';
  if (body._relayRenderedText !== text) {
    streamMarkdownRenderer.render(body, text);
    body._relayRenderedText = text;
  }
  return true;
}
// 流式结束(或切走会话前)调用:立即把最终内容渲染出来,并补上「运行/复制/折叠」按钮(仅此一次)。
function flushStreamRender() {
  if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
  const bubble = streamRenderBubble || currentAssistantBubble;
  streamRenderBubble = null;
  if (!bubble || !bubble.isConnected) return;
  const body = bubble.querySelector('.body');
  if (!body) return;
  renderStreamBubble(bubble);
  enhanceCodeBlocks(body, { collapse: false });
  streamMarkdownRenderer.release(body);
  bubble.classList.remove('is-streaming');
  appendAssistantCopy(bubble);
}

function renderRunOutput(run) {
  const output = outputStateForRun(run);
  const text = output.status === 'complete' ? output.final || '' : '';
  let bubble = run.outputBubble;
  if (!text) {
    if (bubble && bubble.isConnected) {
      streamMarkdownRenderer.release(bubble.querySelector('.body'));
      bubble.remove();
    }
    if (currentAssistantBubble === bubble) detachStreamRenderTarget();
    run.outputBubble = null;
    return;
  }
  if (!bubble || !bubble.isConnected) {
    bubble = appendMessage('assistant', text, null, { streaming: true });
    run.outputBubble = bubble;
    bubble.dataset.turn = String(run.turnIndex ?? 0);
  }
  currentAssistantBubble = bubble;
  bubble.dataset.raw = text;
  // Render the confirmed body once, then install final-answer actions.
  renderStreamBubble(bubble);
  flushStreamRender();
  scrollToBottom();
}

function appendAssistantCopy(el) {
  if (!el || !el.dataset.raw || el.dataset.timelinePartial === 'true' || el.querySelector('.assistant-copy')) return;
  const actions = document.createElement('div');
  actions.className = 'assistant-actions';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'assistant-copy';
  button.title = '复制回答'; button.setAttribute('aria-label', '复制回答');
  button.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(el.dataset.copyRaw || el.dataset.raw || '');
      button.classList.add('copied'); button.title = '已复制';
      button.setAttribute('aria-label', '已复制');
      setTimeout(() => {
        button.classList.remove('copied'); button.title = '复制回答';
        button.setAttribute('aria-label', '复制回答');
      }, 1400);
    } catch (_) { showToast('复制失败，请重试'); }
    finally { button.disabled = false; }
  });
  actions.appendChild(button);
  const forkButton = document.createElement('button');
  forkButton.type = 'button'; forkButton.className = 'assistant-fork';
  forkButton.title = '从这一轮创建分支'; forkButton.setAttribute('aria-label', forkButton.title);
  forkButton.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 6-12 3-12 9"/></svg>';
  forkButton.addEventListener('click', () => {
    const turn = currentConv?.turns?.[Number(el.dataset.turn)];
    if (currentConv?.id && turn?.runId) void createConversationFork(currentConv.id, turn.runId, forkButton);
  });
  actions.appendChild(forkButton);
  const redoButton = document.createElement('button'); redoButton.type = 'button'; redoButton.className = 'assistant-fork';
  redoButton.title = '在新分支修改并重试最后一轮'; redoButton.setAttribute('aria-label', redoButton.title);
  redoButton.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></svg>';
  redoButton.addEventListener('click', () => { const turn = currentConv?.turns?.[Number(el.dataset.turn)]; if (turn?.runId) void createConversationFork(currentConv.id, turn.runId, redoButton, true); });
  actions.appendChild(redoButton);
  el.querySelector('.bubble').after(actions);
  const meta = Array.from(el.children).find(child => child.classList?.contains('message-meta'));
  if (meta) actions.appendChild(meta);
}

function appendOrUpdateAssistant(textDelta, isStreaming = false, meta = null) {
  if (!currentAssistantBubble) {
    currentAssistantBubble = appendMessage('assistant', isStreaming ? '' : textDelta, null, { ...meta, streaming: isStreaming });
    currentAssistantBubble.dataset.raw = textDelta;
  } else {
    const raw = (currentAssistantBubble.dataset.raw || '') + textDelta;
    currentAssistantBubble.dataset.raw = raw;   // 数据立即累积,绝不丢字
  }
  if (isStreaming) {
    streamRenderBubble = currentAssistantBubble;
    // 轻节流:首个 delta 也必须安排渲染；旧逻辑只在第二个 delta 才启动，
    // 切换会话附近若刚好只收到一个 delta，会留下空白或陈旧内容。
    if (!streamRenderTimer) {
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = null;
        const bubble = streamRenderBubble;
        if (renderStreamBubble(bubble)) scrollToBottom();
      }, STREAM_RENDER_MS);
    }
  }
}

// Follow the user's scrolling intent, not every scroll event. Native scroll
// anchoring, content-visibility and our own scrollTop writes also emit scroll.
let stickToBottom = true;
let bottomScrollFrame = 0;
let bottomScrollIntent = 0; // -1: away, 1: toward bottom, 2: scrollbar drag
let bottomScrollIntentTimer = 0;
let bottomScrollPointer = null;
let bottomScrollTouchY = null;
let lastMessageScrollTop = messagesEl.scrollTop;
function isNearBottom() {
  const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return gap < 80;
}
function clearBottomScrollIntent() {
  clearTimeout(bottomScrollIntentTimer);
  bottomScrollIntentTimer = 0;
  bottomScrollIntent = 0;
}
function stopFollowingMessages() {
  stickToBottom = false;
  clearBottomScrollIntent();
}
function noteBottomScrollIntent(direction) {
  if (activeView !== 'chat' || !direction) return;
  bottomScrollIntent = direction;
  lastMessageScrollTop = messagesEl.scrollTop;
  if (direction < 0) stickToBottom = false; // Cancel an already queued auto-scroll too.
  else if (direction === 1 && isNearBottom()) stickToBottom = true;
  clearTimeout(bottomScrollIntentTimer);
  // A bounded grace period covers the browser's asynchronous native scrolling;
  // pointer/touch moves renew it. No timer polls layout or forces scrolling.
  bottomScrollIntentTimer = setTimeout(clearBottomScrollIntent, 350);
}
function nestedMessageScrollCanConsume(target, direction) {
  for (let node = target && (target.nodeType === 1 ? target : target.parentElement); node && node !== messagesEl; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    if (!/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) continue;
    if (direction < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
  }
  return false;
}
messagesEl.addEventListener('wheel', event => {
  if (event.ctrlKey || !event.deltaY) return;
  const direction = Math.sign(event.deltaY);
  if (!nestedMessageScrollCanConsume(event.target, direction)) noteBottomScrollIntent(direction);
}, { passive: true });
messagesEl.addEventListener('touchstart', event => {
  bottomScrollTouchY = event.touches.length === 1 ? event.touches[0].clientY : null;
}, { passive: true });
messagesEl.addEventListener('touchmove', event => {
  if (bottomScrollTouchY == null || event.touches.length !== 1) return;
  const y = event.touches[0].clientY, direction = Math.sign(bottomScrollTouchY - y);
  bottomScrollTouchY = y;
  if (direction && !nestedMessageScrollCanConsume(event.target, direction)) noteBottomScrollIntent(direction);
}, { passive: true });
messagesEl.addEventListener('touchend', () => { bottomScrollTouchY = null; }, { passive: true });
messagesEl.addEventListener('touchcancel', () => { bottomScrollTouchY = null; }, { passive: true });
messagesEl.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target !== messagesEl || event.pointerType === 'touch') return;
  const bounds = messagesEl.getBoundingClientRect();
  const scrollbarWidth = Math.max(12, messagesEl.offsetWidth - messagesEl.clientWidth);
  if (event.clientX < bounds.right - scrollbarWidth || event.clientX > bounds.right) return;
  bottomScrollPointer = event.pointerId;
  // Stop while the native thumb owns the pointer. Only a user move back to the
  // bottom can restore following, even if content changes during the drag.
  stickToBottom = false;
  noteBottomScrollIntent(2);
});
window.addEventListener('pointermove', event => {
  if (bottomScrollPointer === event.pointerId) noteBottomScrollIntent(2);
}, { passive: true });
function finishBottomScrollPointer(event) {
  if (bottomScrollPointer !== event.pointerId) return;
  bottomScrollPointer = null;
  if (isNearBottom()) { stickToBottom = true; scrollToBottom(); }
  // Keep the last native scroll event eligible after pointerup.
}
window.addEventListener('pointerup', finishBottomScrollPointer, { passive: true });
window.addEventListener('pointercancel', finishBottomScrollPointer, { passive: true });
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.altKey || event.metaKey) return;
  const target = event.target;
  if (target?.closest?.('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])')) return;
  if (target !== document.body && target !== document.documentElement && !messagesEl.contains(target)) return;
  let direction = 0;
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) direction = -1;
  else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) direction = 1;
  else if (event.key === ' ') direction = event.shiftKey ? -1 : 1;
  if (direction && !nestedMessageScrollCanConsume(target, direction)) noteBottomScrollIntent(direction);
});
messagesEl.addEventListener('scroll', () => {
  if (activeView !== 'chat') return;
  const top = messagesEl.scrollTop;
  if (bottomScrollIntent) {
    clearTimeout(bottomScrollIntentTimer);
    bottomScrollIntentTimer = setTimeout(clearBottomScrollIntent, 350);
  }
  if (bottomScrollIntent === 2 && top < lastMessageScrollTop - 1) stickToBottom = false;
  else if ((bottomScrollIntent === 1 || bottomScrollIntent === 2) && top > lastMessageScrollTop + 1 && isNearBottom()) stickToBottom = true;
  lastMessageScrollTop = top;
  scheduleConversationIndexUpdate();
  if (stickToBottom) scrollToBottom();
});
messagesEl.addEventListener('contentvisibilityautostatechange', () => scrollToBottom(), true);
messagesEl.addEventListener('load', () => scrollToBottom(), true);

// force=true is for explicit new input/navigation; ordinary layout changes only
// keep following if the user has not scrolled away or selected a history anchor.
function scrollToBottom(force = false) {
  if (activeView !== 'chat') return;
  if (force) { stickToBottom = true; clearBottomScrollIntent(); }
  if (!stickToBottom || bottomScrollFrame) return;
  bottomScrollFrame = requestAnimationFrame(() => {
    bottomScrollFrame = 0;
    if (activeView !== 'chat' || !stickToBottom) return;
    const bottom = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    if (Math.abs(messagesEl.scrollTop - bottom) > 1) messagesEl.scrollTop = bottom;
    lastMessageScrollTop = messagesEl.scrollTop;
    scheduleConversationIndexUpdate();
  });
}

// 把已完成的历史轮次拼成文字上下文,用于「切换模型后开新线程」时带过去(纯对话模式)
function buildContextPreamble(turns, conversation = null) {
  return window.RelayConversationContext.build({ ...conversation, turns }, { turnIndex: Array.isArray(turns) ? turns.length : 0 });
}

// ─────────────────────────────────────────
// 发送 / 中止
// ─────────────────────────────────────────
async function send(options = null) {
  const sourceOwner = composerDraftOwner;
  const sourceDraft = readComposerDraft();
  const explicit = !!(options && typeof options === 'object' && options.explicit === true);
  const pendingSupplement = !explicit && currentConv && supplementDrafts.get(currentConv.id);
  if (pendingSupplement && composerMatchesSupplement(pendingSupplement)) {
    return submitComposerSupplement(pendingSupplement, currentConv.id);
  }
  const resumeOf = explicit && options.intent === 'resume' ? options.resumeOf : null;
  const wantsResume = explicit && options.intent === 'resume';
  if (wantsResume && (typeof resumeOf !== 'string' || !resumeOf || !currentConv?.paused
      || isConvRunning(currentConv.id))) return { ok: false, error: '暂停任务已变化，请重新打开对话后继续' };
  let prompt = wantsResume ? window.RelayTaskContinuity.RESUME_PROMPT : String(explicit ? options.prompt || '' : sourceDraft.prompt).trim();
  const sourceFiles = (explicit && Array.isArray(options.files) ? options.files : sourceDraft.files).map(file => ({ ...file }));
  // 允许「纯附件」发送(有文件即可,文字可为空)
  if (!prompt && !sourceFiles.length) return { ok: false, error: '没有可发送的内容' };
  if (currentConv && isConvRunning(currentConv.id)) return steerCurrent(options);
  if (permissionMutation) { showToast('正在更新权限，请稍后发送'); return { ok: false, error: '权限正在更新' }; }
  const permissionTarget = currentConv;
  const permissionWait = currentPermissionState ? null : (permissionLoadPromise || refreshComposerPermission());
  const permissionView = permissionViewRevision;
  if (permissionWait && !await permissionWait) return { ok: false, error: '权限尚未加载' };
  if (permissionTarget !== currentConv || permissionView !== permissionViewRevision || sourceOwner !== composerDraftOwner) return { ok: false, error: '对话已切换' };
  const permissionForSend = currentPermissionState.permissionMode;
  const needsPermissionBinding = !currentConv || unsavedWorkspaceConversations.has(currentConv);
  let executionMode = explicit && options.executionMode ? { ...options.executionMode } : { ...currentExecutionMode };
  let goalExplicit = false;
  const command = /^\/(goal|plan)(?:\s+|$)/i.exec(prompt);
  if (command) {
    executionMode = { kind: command[1].toLowerCase() }; prompt = prompt.slice(command[0].length).trim();
    goalExplicit = executionMode.kind === 'goal';
    if (!await setComposerExecutionMode(executionMode)) return { ok: false, error: '模式切换失败' };
    if (sourceOwner !== composerDraftOwner) return { ok: false, error: '对话已切换' };
    if (!prompt && !sourceFiles.length) { if (!explicit && composerMatchesSupplement(sourceDraft)) { inputEl.value = ''; autoGrowInput(); } return { ok: false, modeSelected: true }; }
  }
  if (executionMode.kind === 'goal' && (!prompt || prompt.length > 4000)) {
    showToast('请用 1–4000 个字符说明目标和完成条件'); return { ok: false, error: '目标长度无效' };
  }

  if (currentConv && (pendingConversationSends.has(currentConv.id)
      || (conversationControls.has(currentConv.id) && !(explicit && options.controlled)))) {
    const message = '正在准备当前对话，请稍候';
    showToast(message);
    return { ok: false, error: message };
  }
  // 全局并发由主进程的持久化队列管理；超出容量时任务进入排队，
  // 不在渲染层拒绝用户已经发出的请求。

  // 注：定时任务的建/查/改/删现已全部由 cron MCP 在对话里处理（claude:run 检测到相关词会自动挂载）。
  //   这里不再做意图识别拦截，含定时任务词的消息照常走 claude，点发送即刻转圈，无卡顿。

  // 模型档位:新对话和 Agent 模式都用用户当前选中的档位(Agent 也可自由切换模型)。
  const modelToSend = runtimeModelForValue(currentModel);
  const selectedProviderRoute = configuredChatRoute(currentModel);
  if (providerRoutingLoaded && !selectedProviderRoute) {
    const message = `${currentTier().label}档位尚未配置可用模型，请前往“设置 → 服务商”分配`;
    showToast(message);
    return { ok: false, error: message };
  }
  const effortToSend = currentEffort;
  const requestedSkill = explicit && Object.prototype.hasOwnProperty.call(options, 'skill')
    ? options.skill : sourceDraft.skill;
  const skillForTurn = requestedSkill
    ? {
        name: requestedSkill.name,
        callName: requestedSkill.callName || requestedSkill.name,
        displayName: requestedSkill.displayName || requestedSkill.name,
        desc: requestedSkill.desc || '',
        summary: requestedSkill.summary || requestedSkill.desc || '',
      }
    : null;

  // 跨模型续接 → thinking 块签名失效:不同档位走不同上游(快速=MiMo /
  //   思考·专家=Bedrock),旧后端留下的带签名 thinking 块在新后端 --resume 会被拒
  //   (400 Invalid signature in thinking block)。故切换档位时丢弃旧 session、开新
  //   线程;同时把前文作为文字上下文带进新线程,尽量不丢上下文。
  let promptToSend = prompt;
  let switchNotice = null;
  let needCarryContext = false;
  const carryContextReason = currentConv && currentConv.carryContextOnNextTurn;
  const carryContextPending = !!carryContextReason;
  if (carryContextPending) {
    // 工具重载、服务商切换和显式重试都会刻意放弃旧 Claude session；
    // 对话连续性由 Relay 把历史作为文本上下文带入。
    currentSessionId = null;
    currentConv.sessionId = null;
    needCarryContext = true;
    switchNotice = carryContextReason === 'mcp'
      ? '已在全新 Claude 会话中重新加载 MCP（已带上前面的对话继续）'
      : (carryContextReason === 'provider'
        ? `已切换到「${currentTier().label}」对应的服务商（已带上前面的对话继续）`
        : '已在全新会话中继续（已带上前面的对话）');
  }
  if (currentConv && currentSessionId && selectedProviderRoute
      && !conversationSessionMatchesRoute(currentConv, selectedProviderRoute, currentModel)) {
    currentSessionId = null;
    currentConv.sessionId = null;
    needCarryContext = true;
    switchNotice = `已切换到「${currentTier().label}」对应的服务商（已带上前面的对话继续）`;
  }
  if (currentConv && currentSessionId &&
      currentConv.sessionModel && currentConv.sessionModel !== currentModel) {
    currentSessionId = null;
    currentConv.sessionId = null;
    needCarryContext = true;
    switchNotice = `已切换到「${currentTier().label}」模型（已带上前面的对话继续）`;
  }

  // 跨工作目录续接 → 旧 session 失效:Claude Code 的会话按 cwd 分桶存储
  //   (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl)。对话中途改了工作目录,
  //   新 cwd 的桶里没有旧 sessionId,-p --resume 会硬退出报
  //   "No conversation found with session ID" 且不会自动开新会话 → 整个对话卡死。
  //   比照模型切换:丢弃旧 session、在新 cwd 开新线程,把前文当文字上下文带进去。
  //   注:不限定 plain 模式 —— agent 模式同样按 cwd 分桶,一样会漂移。
  const prevDirPath = (currentConv && currentConv.workingDir && currentConv.workingDir.path) || null;
  const nowDirPath  = (currentWorkingDir && currentWorkingDir.path) || null;
  if (currentConv && currentSessionId && prevDirPath !== nowDirPath) {
    currentSessionId = null;
    currentConv.sessionId = null;
    needCarryContext = true;
    const label = nowDirPath ? `「${currentWorkingDir.name || nowDirPath}」` : '默认目录';
    switchNotice = `工作目录已切换到 ${label}，已在新目录重新开始（已带上前面的对话继续）`;
  }

  // 任一种切换命中,都把前文 preamble 拼进本轮 prompt（只拼一次,避免叠加）
  if (needCarryContext) {
    const ctx = buildContextPreamble(currentConv.turns, currentConv);
    if (ctx) promptToSend = `${ctx}\n\n${prompt || ''}`.trim();
  }
  if (skillForTurn) {
    const invokeSkill = `请先调用 Skill 工具加载「${skillForTurn.callName || skillForTurn.name}」技能，并严格按照该技能处理下面的请求。`;
    promptToSend = `${invokeSkill}\n\n${promptToSend}`.trim();
  }

  // 取出本轮附件(轻量元数据,用于发送 + 存档),随后清空输入区
  const filesToSend = sourceFiles.map((f) => ({
    path: f.path, name: f.name, ext: f.ext, size: f.size,
    ...(f.isDirectory || f.ext === 'folder' ? { isDirectory: true } : {}),
  }));
  const clientRunId = (explicit && options.runId) || newClientRunId();
  const segmentStartedAt = Date.now();
  const taskRun = window.RelayTaskContinuity.begin({ runId: clientRunId, startedAt: segmentStartedAt,
    conversation: currentConv, resumedFromRunId: wantsResume ? resumeOf : null });
  if (!taskRun) { showToast('暂停任务已变化，请重新打开对话后继续'); return { ok: false, error: '暂停任务已变化' }; }
  const displayPrompt = wantsResume ? '' : prompt;
  const inputKind = wantsResume ? 'resume' : undefined;
  const consumeComposer = !explicit && composerMatchesSupplement(sourceDraft);
  if (consumeComposer) {
    attachedFiles = [];
    renderAttachments();
  }

  const turnIndex = currentConv && Array.isArray(currentConv.turns) ? currentConv.turns.length : 0;
  const turnAnchor = appendConversationTurnAnchor(turnIndex);
  if (switchNotice) appendMessage('system', switchNotice);
  const turnTs = new Date(segmentStartedAt).toISOString();
  const userMessageEl = wantsResume ? null : appendMessage('user', displayPrompt, filesToSend, { ts: turnTs });
  if (userMessageEl) userMessageEl.dataset.turn = String(turnIndex);
  if (consumeComposer) {
    inputEl.value = '';
    setSelectedQuickSkill(null);  // 快捷技能仅消费一次，避免下一轮误用
    hideSkillQuickPopup();
    autoGrowInput();   // 发送后缩回去
  }
  scrollToBottom(true);   // 自己刚发的消息,无条件滚到底
  currentAssistantBubble = null;

  const turn = {
    user: displayPrompt, taskRun, inputKind, runId: clientRunId,
    assistant: '',
    thinkingList: [],
    files: filesToSend,
    ts: turnTs,
    skill: skillForTurn,
    activityState: newActivityState({ startedAt: segmentStartedAt, taskRun }),
    activityEl: null,
  };

  // 立刻把 conv + 用户消息存盘,侧边栏立刻出现这次对话,切走再切回也找得到
  if (!currentConv) {
    currentConv = {
      id: workspaceDraftId || newClientRunId(),
      title: truncateByWidth(prompt || (filesToSend[0] && filesToSend[0].name) || '附件', 64),
      sessionId: currentSessionId,
      mode: currentMode,
      agent: currentAgent,
      agentLabel: currentAgentLabel,
      orchestrateAgents: currentOrchestrateAgents,   // 协作模式下选中的 Agent；兼容旧历史的 null
      model: currentModel,
      effort: currentEffort,
      sessionModel: currentModel,
      workingDir: currentWorkingDir ? { ...currentWorkingDir } : null,
      projectId: currentProjectId, executionMode,
      turns: [],
    };
    unsavedWorkspaceConversations.add(currentConv);
  } else {
    currentConv.sessionId = currentSessionId;
    currentConv.model = currentModel;
    currentConv.effort = currentEffort;
    currentConv.sessionModel = currentModel;
    currentConv.workingDir = currentWorkingDir ? { ...currentWorkingDir } : null;
  }
  if (currentConv.terminalWorkspaceOnly && !currentConv.turns.length) {
    if (currentConv.title === '终端工作区') currentConv.title = truncateByWidth(prompt || (filesToSend[0] && filesToSend[0].name) || '附件', 64);
    delete currentConv.terminalWorkspaceOnly;
  }
  const targetSessionRoute = sessionRouteSnapshot(selectedProviderRoute, currentModel);
  if (targetSessionRoute) {
    currentConv.sessionProviderId = targetSessionRoute.providerId;
    currentConv.sessionProviderRevision = targetSessionRoute.providerRevision;
    currentConv.sessionRouteTier = targetSessionRoute.routeTier;
    currentConv.sessionAgentEnvironment = targetSessionRoute.agentEnvironment || 'native';
  }
  currentConv.projectId = currentProjectId;
  currentConv.executionMode = executionMode;
  const pendingTurn = {
    executionMode, taskRun, inputKind,
    user: displayPrompt,
    assistant: '',         // 占位,稍后由 finishRun 填充
    thinking: null,
    files: filesToSend,
    ts: turn.ts,
    skill: skillForTurn,
    runId: clientRunId,
  };
  // 第一次异步保存之前固定归属和运行参数；保存期间用户可以切换或新建对话。
  const sentConv = currentConv;
  const convId = sentConv.id || (sentConv.id = workspaceDraftId || newClientRunId());
  bindComposerDraft(convId);
  const pausedRunToConsume = sentConv.paused && sentConv.paused.runId || null;
  const resumedPauseId = wantsResume ? resumeOf : null;
  const resumeSessionId = currentSessionId;
  const sessionModel = currentModel;
  const sessionEffort = currentEffort;
  const workingDirPath = nowDirPath;
  const sentMode = currentMode;
  const sentAgent = currentAgent;
  const sentOrchestrateAgents = Array.isArray(currentOrchestrateAgents) ? [...currentOrchestrateAgents] : null;
  const sessionRouteForRun = targetSessionRoute;
  sentConv.turns.push(pendingTurn);
  pendingConversationSends.add(convId);
  let savePromise;
  let placeholderPersisted = false;
  try {
    savePromise = window.api.history.save(sentConv);
    pendingConversationSaves.set(convId, savePromise);
    const saved = await savePromise;
    if (!saved || saved.error || saved.id !== convId) throw new Error(saved && saved.error || '对话保存结果无效');
    sentConv.updatedAt = saved.updatedAt;
    placeholderPersisted = true;
    // Bind the visible draft choice before any SDK call. Another window may
    // have changed the default while this draft was being composed.
    const permission = needsPermissionBinding
      ? await window.api.permissions.set({ conversationId: convId, permissionMode: permissionForSend, executionMode })
      : await window.api.permissions.get(convId);
    if (!permission?.ok) throw new Error(permission?.error || '无法确认本次对话权限');
    applyPermissionMetadata(sentConv, permission);
    if (currentConv === sentConv) { currentPermissionState = permission; syncPermissionControl(); }
    unsavedWorkspaceConversations.delete(sentConv);
    pendingConversationSaves.delete(convId);
  } catch (error) {
    if (pendingConversationSaves.get(convId) === savePromise) pendingConversationSaves.delete(convId);
    const pendingIndex = sentConv.turns.indexOf(pendingTurn);
    if (pendingIndex >= 0) sentConv.turns.splice(pendingIndex, 1);
    if (placeholderPersisted) {
      // Permission binding can fail after history was saved. Remove the
      // unlaunched placeholder while keeping this conversation's send gate.
      try { await window.api.history.save(sentConv); } catch (_) {}
    }
    pendingConversationSends.delete(convId);
    if (consumeComposer) restoreFailedComposerDraft(sourceOwner, sourceDraft);
    const message = `对话保存失败：${error && error.message || '请稍后重试'}`;
    if (currentConv === sentConv) {
      if (userMessageEl) userMessageEl.remove();
      if (turnAnchor) turnAnchor.remove();
      appendMessage('error', message);
      refreshConversationIndex();
      setRunning(false);
    }
    return { ok: false, error: message, conversationId: convId };
  }
  if (currentConv === sentConv) {
    if (workspaceDraftId === convId) workspaceDraftId = null;
    emitConversationChanged(convId);
    chatTitle.textContent = sentConv.title;
    refreshConversationIndex();
    setRunning(true);
    retirePreviousTaskProcesses(taskRun);
    turn.activityEl = appendActivityState(turn.activityState, false);
  }

  // 先登记本轮再调用 IPC。极快任务可能在 invoke 返回前就发出 init/assistant/result；
  // 若此时没有 jobId → convId 映射，旧逻辑会把这些事件当成“迟到事件”直接丢掉。
  const taskContextForRun = {
    ...((explicit && options.taskContext) || {}),
    turnRef: { index: turnIndex, ts: turnTs },
    taskStartedAt: segmentStartedAt, taskRun, ...(inputKind ? { inputKind } : {}),
  };
  const run = {
    jobId: clientRunId,
    convId,
    sessionId: resumeSessionId,
    nativeFork: !!sentConv.pendingSdkFork,
    resumedPauseId, carryContextReason, taskRun,
    sessionModel,
    sessionEffort,
    turnIndex,
    sessionProviderId: sessionRouteForRun && sessionRouteForRun.providerId,
    sessionProviderRevision: sessionRouteForRun && sessionRouteForRun.providerRevision,
    sessionRouteTier: sessionRouteForRun && sessionRouteForRun.routeTier,
    sessionAgentEnvironment: sessionRouteForRun?.agentEnvironment || 'native',
    turn,
    error: null,
    stderrBuf: '',
    mode: sentMode,
    activityState: turn.activityState,
    activityEl: turn.activityEl,
    currentStreamMessageId: null,
    textDeltaMessageIds: new Set(),
  };
  runs.set(convId, run);
  jobToConv.set(clientRunId, convId);
  pendingConversationSends.delete(convId);
  if (currentConv === sentConv) syncPermissionControl();
  refreshHistoryList();

  // 末位 convId:主进程据它复用本对话的常驻 claude 进程(MCP 不必每轮重启)。
  const launchPromise = run.launchPromise = window.api.runClaude(
    promptToSend, resumeSessionId, sentMode, filesToSend, modelToSend, effortToSend, sentAgent,
    workingDirPath, sentOrchestrateAgents, convId, needCarryContext, clientRunId, convId,
    { ...taskContextForRun, userPrompt: prompt, goalExplicit }, sessionRouteForRun, executionMode,
  );
  if (explicit && typeof options.onDispatch === 'function') {
    try { options.onDispatch({ runId: clientRunId, conversationId: convId }); } catch (_) {}
  }
  let result;
  try { result = await launchPromise; }
  catch (error) { result = { error: error && error.message || '任务启动失败' }; }
  // Queue cancellation can settle this run before its original invoke returns.
  // A late rejection must not modify the next turn, its DOM, or its saved output.
  if (runs.get(convId) !== run || (run.pauseRequested && result && result.code === 'TURN_CANCELED')) {
    return { ok: !!result && !result.error, settled: true, runId: clientRunId, conversationId: convId };
  }

  if (!result || result.error) {
    run.launchError = result && result.error || '任务启动失败';
    if (runs.get(convId) === run) runs.delete(convId);
    jobToConv.delete(clientRunId);
    const failedTurn = sentConv.turns && sentConv.turns.find(item => item.runId === clientRunId);
    if (failedTurn) {
      failedTurn.error = run.launchError;
      failedTurn.status = 'error';
      if (turn.activityState && window.RelayActivity) {
        window.RelayActivity.finish(turn.activityState, run.launchError, result);
        failedTurn.activity = window.RelayActivity.serialize(turn.activityState);
        failedTurn.taskRun = turn.activityState.taskRun;
        if (window.RelayTaskContinuity?.isResume(failedTurn)) {
          sentConv.paused = { runId: clientRunId, at: new Date(failedTurn.taskRun.segmentFinishedAt).toISOString() };
        }
      }
      try { await window.api.history.save(sentConv); } catch (_) {}
    }
    // spawn 失败 / 超并发上限:只影响这一条,回滚 UI(若仍在看这个会话)
    if (currentConv && currentConv.id === convId) {
      if (turn.activityEl && turn.activityState && window.RelayActivity) window.RelayActivity.updateElement(turn.activityEl, turn.activityState);
      showRunError(run, run.launchError);
      setRunning(false);
    }
    return { ok: false, error: (result && result.error) || '启动失败', runId: clientRunId, conversationId: convId };
  }

  // 只有新运行真正启动成功后才消费暂停/重连标记。
  const consumePaused = pausedRunToConsume && sentConv.paused && sentConv.paused.runId === pausedRunToConsume;
  const consumeContext = carryContextReason && sentConv.carryContextOnNextTurn === carryContextReason;
  if (!run.finishing && (consumeContext || consumePaused)) {
    if (consumePaused) delete sentConv.paused;
    if (consumeContext) delete sentConv.carryContextOnNextTurn;
    if (runs.get(convId) === run) {
      const resetSaved = await window.api.history.save(sentConv);
      sentConv.updatedAt = resetSaved.updatedAt;
    } else {
      // 极快任务可能在 invoke 返回前就已完成。此时重新读取终态记录，只删除一次性标记，
      // 不能用发送前的旧对象覆盖刚写入的最终回复。
      const latestConv = await window.api.history.load(convId).catch(() => null);
      if (latestConv) {
        if (latestConv.paused && latestConv.paused.runId === pausedRunToConsume) delete latestConv.paused;
        if (carryContextReason && latestConv.carryContextOnNextTurn === carryContextReason) delete latestConv.carryContextOnNextTurn;
        await window.api.history.save(latestConv).catch(() => null);
      }
    }
  }

  // 极快任务可能已在 await 期间完成并清理；这里只更新仍活跃的同一对象。
  if (runs.get(convId) === run) {
    run.sessionId = result.sessionId || run.sessionId;
    run.sessionProviderId = result.providerId || run.sessionProviderId;
    run.sessionProviderRevision = Number(result.providerRevision || run.sessionProviderRevision || 0);
    run.sessionRouteTier = result.routeTier || run.sessionRouteTier;
    run.sessionAgentEnvironment = result.agentEnvironment || run.sessionAgentEnvironment || 'native';
    if (result.jobId && result.jobId !== clientRunId) {
      jobToConv.delete(clientRunId);
      run.jobId = result.jobId;
      jobToConv.set(result.jobId, convId);
    }
  }
  refreshHistoryList();   // 侧边栏给这个会话亮起 running 指示
  return { ok: true, runId: result.jobId || clientRunId, conversationId: convId };
}

function readComposerDraft() {
  return { prompt: inputEl.value, files: attachedFiles.map(file => ({ ...file })),
    skill: selectedQuickSkill ? { ...selectedQuickSkill } : null,
    selectionStart: inputEl.selectionStart, selectionEnd: inputEl.selectionEnd,
    scrollTop: inputEl.scrollTop || 0 };
}
function captureComposerDraft() {
  const draft = readComposerDraft();
  if (composerDraftOwner.supplementSource && !sameRecoveredSupplementContent(draft, composerDraftOwner.supplementSource)) {
    delete composerDraftOwner.supplementSource;
  }
  Object.assign(composerDraftOwner, draft);
  return composerDraftOwner;
}
function renderComposerDraft() {
  inputEl.value = composerDraftOwner.prompt || '';
  attachedFiles = (composerDraftOwner.files || []).map(file => ({ ...file }));
  setSelectedQuickSkill(composerDraftOwner.skill || null);
  renderAttachments(); hideSkillQuickPopup(); autoGrowInput();
  if (Number.isInteger(composerDraftOwner.selectionStart)) {
    inputEl.setSelectionRange(composerDraftOwner.selectionStart, composerDraftOwner.selectionEnd);
  }
  inputEl.scrollTop = composerDraftOwner.scrollTop || 0;
}
function activateComposerDraft(conversationId = null) {
  captureComposerDraft();
  const next = conversationId ? composerDrafts.get(conversationId) || {} : {};
  if (conversationId) composerDrafts.set(conversationId, next);
  if (next === composerDraftOwner) return;
  composerDraftOwner = next;
  renderComposerDraft();
}
function bindComposerDraft(conversationId) {
  composerDrafts.set(conversationId, captureComposerDraft());
}
function restoreFailedComposerDraft(owner, draft) {
  if (owner === composerDraftOwner) captureComposerDraft();
  if ((owner.prompt || '').trim() || owner.files?.length || owner.skill) return;
  Object.assign(owner, draft, { files: draft.files.map(file => ({ ...file })) });
  if (owner === composerDraftOwner) renderComposerDraft();
}
function sameComposerContent(left, right) {
  if (!left || !right || String(left.prompt || '').trim() !== String(right.prompt || '').trim()) return false;
  const fileKey = files => JSON.stringify((files || []).map(file => [file.path, file.name, file.ext, file.size, !!file.isDirectory]));
  const skillKey = skill => skill && (skill.callName || skill.name) || '';
  return fileKey(left.files) === fileKey(right.files) && skillKey(left.skill) === skillKey(right.skill);
}

function composerMatchesSupplement(draft) {
  return sameComposerContent(readComposerDraft(), draft);
}

function sameRecoveredSupplementContent(left, right) {
  return !!left && !!right && String(left.prompt || '') === String(right.prompt || '')
    && JSON.stringify(left.files || []) === JSON.stringify(right.files || [])
    && JSON.stringify(left.skill || null) === JSON.stringify(right.skill || null);
}

function clearDeliveredSupplementComposer(run, input) {
  const current = currentConv && currentConv.id === run.convId;
  const owner = current ? captureComposerDraft() : composerDrafts.get(run.convId);
  const source = owner && owner.supplementSource;
  if (!source || source.convId !== run.convId || source.jobId !== run.jobId || source.sourceMessageId !== input.id) return;
  const unchanged = sameRecoveredSupplementContent(owner, source);
  delete owner.supplementSource;
  if (!unchanged) return;
  Object.assign(owner, { prompt: '', files: [], skill: null });
  if (current) renderComposerDraft();
}

function clearSupplementComposer(draft, convId) {
  if (!currentConv || currentConv.id !== convId) {
    const saved = composerDrafts.get(convId);
    if (sameComposerContent(saved, draft)) {
      Object.assign(saved, { prompt: '', files: [], skill: null });
      delete saved.supplementSource;
    }
    return;
  }
  if (!composerMatchesSupplement(draft)) return;
  inputEl.value = ''; attachedFiles = []; renderAttachments();
  setSelectedQuickSkill(null); hideSkillQuickPopup(); autoGrowInput(); captureComposerDraft();
}

function restoreSupplementComposerDraft(convId) {
  // Each recovered input is reconciled only with its owning conversation.
  const draft = convId && supplementDrafts.get(convId);
  if (!draft || draft.composerSubmitting || inputEl.value.trim() || attachedFiles.length || selectedQuickSkill) return;
  inputEl.value = draft.prompt || '';
  attachedFiles = (draft.files || []).map(file => ({ ...file })); renderAttachments();
  setSelectedQuickSkill(draft.skill || null); autoGrowInput();
  const owner = captureComposerDraft();
  owner.supplementSource = { convId, jobId: draft.jobId, sourceMessageId: draft.sourceMessageId || draft.messageId,
    prompt: owner.prompt, files: owner.files.map(file => ({ ...file })), skill: owner.skill ? { ...owner.skill } : null };
  // Confirmed undelivered input is now an ordinary editable composer draft.
  // Uncertain receipts keep their stable ID until the original run is reconciled.
  if (draft.sendAsNew) supplementDrafts.delete(convId);
  else draft.composerRestored = true;
}

async function submitComposerSupplement(draft, convId) {
  if (conversationControls.has(convId) || draft.composerSubmitting) return { ok: false, pending: true };
  draft.composerSubmitting = true;
  clearSupplementComposer(draft, convId);
  try { return await submitSupplement(draft, convId); }
  finally {
    delete draft.composerSubmitting;
    if (currentConv && currentConv.id === convId) syncRunningUI();
  }
}

// 全局兼容标记(部分旧代码可能引用);真正的运行态以 runs 为准。
function setRunning(running) {
  isRunning = !!(running != null ? running : currentConv && isConvRunning(currentConv.id));
  const convId = currentConv && currentConv.id;
  const control = convId && conversationControls.get(convId);
  const controlling = !!control;
  getProjectComposer()?.sync();
  if (!controlling) restoreSupplementComposerDraft(convId);
  syncComposerAction();
  if (btnModelSwitch) btnModelSwitch.disabled = isRunning || controlling;
  syncMcpReconnectButtons(isRunning || controlling);
  syncPermissionControl();
  syncContextUsagePolling();
}
function syncRunningUI() { setRunning(currentConv && isConvRunning(currentConv.id)); }

function syncComposerAction() {
  const hasDraft = !!inputEl.value.trim() || attachedFiles.length > 0;
  const stopping = isRunning && !hasDraft;
  const resuming = !isRunning && !!(currentConv && currentConv.paused) && !hasDraft;
  sendBtn.classList.toggle('is-stop', stopping);
  sendBtn.classList.toggle('is-resume', resuming);
  sendBtn.disabled = !!(currentConv && conversationControls.has(currentConv.id));
  sendBtn.title = stopping ? '暂停当前任务' : resuming ? '继续任务'
    : isRunning ? (followUpMode === 'queue' ? '加入队列 (Enter) · 调整方向 (Ctrl+Enter)' : '调整方向 (Enter) · 加入队列 (Ctrl+Enter)') : '发送 (Enter)';
  sendBtn.setAttribute('aria-label', sendBtn.title);
}

function submitComposer(options = null) {
  if (currentConv && conversationControls.has(currentConv.id)) return;
  const hasDraft = !!inputEl.value.trim() || attachedFiles.length > 0;
  if (!hasDraft && (isRunning || currentConv && currentConv.paused)) return pauseCurrent();
  return send(options);
}

// interrupt is an execution boundary, not a frozen process. Never submit another
// turn until both the backend and this run's history writer have settled.
async function pauseRun(run) {
  if (!run) return { settled: true, alreadyFinished: true };
  if (run.pausePromise) return run.pausePromise;
  run.pausePromise = (async () => {
    if (runs.get(run.convId) !== run || run.finishing || run.finishPromise) {
      if (run.finishPromise) await run.finishPromise;
      if (run.finishError) throw run.finishError;
      return { settled: true, alreadyFinished: true };
    }
    run.pauseRequested = true;
    run.abortRequested = true;
    let response;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        response = await window.api.pauseClaude(run.jobId);
        if (!response || response.code !== 'NOT_REGISTERED') break;
        if (run.finishing || runs.get(run.convId) !== run) break;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      if ((!response || !response.settled) && !run.finishPromise) throw new Error(response && response.message || '暂停未完成，请重试');
    } catch (error) {
      if (!run.finishing) { run.pauseRequested = false; run.abortRequested = false; }
      throw error;
    }
    if (response && response.alreadyFinished && !run.finishPromise && runs.get(run.convId) === run) {
      // A task summary is not the final answer. Wait for the authoritative
      // terminal event; recover that exact event from the local journal if needed.
      const deadline = Date.now() + 1500;
      while (!run.finishPromise && runs.get(run.convId) === run && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!run.finishPromise && window.api.tasks && typeof window.api.tasks.replayStream === 'function') {
        let sinceSeq = 0;
        for (let page = 0; page < 20 && !run.finishPromise; page += 1) {
          const replay = await window.api.tasks.replayStream({ runId: run.jobId, sinceSeq, limit: 5000 });
          if (!replay || !replay.ok) break;
          const events = Array.isArray(replay.events) ? replay.events : [];
          const done = events.map(envelope => envelope.payload && envelope.payload.event)
            .find(event => event && event.jobId === run.jobId && event.type === 'job-done' && !window.RelayAssistantOutput.owner(event));
          if (done) { handleClaudeEvent(done); break; }
          const next = events.length ? Number(events[events.length - 1].seq) : 0;
          if (!next || next <= sinceSeq || replay.hasMore === false) break;
          sinceSeq = next;
        }
      }
      if (!run.finishPromise && runs.get(run.convId) === run) {
        run.pauseRequested = false; run.abortRequested = false;
        throw new Error('正在等待完整的最终回复，补充提示已保留');
      }
    }
    if (run.finishPromise) await run.finishPromise;
    else if (runs.get(run.convId) === run && response && response.paused) {
      await finishRun(run.jobId, { exitCode: -1, error: '已暂停' });
    }
    if (run.finishError) throw new Error('本轮记录保存失败，补充提示已保留，请稍后重试');
    if (run.launchError) throw new Error(run.launchError);
    return response;
  })();
  try { return await run.pausePromise; }
  finally { run.pausePromise = null; }
}

async function pauseCurrent() {
  const convId = currentConv && currentConv.id;
  if (!convId || conversationControls.has(convId)) return;
  const run = runs.get(convId);
  if (!run) {
    if (currentConv.paused) return send({ explicit: true, intent: 'resume', resumeOf: currentConv.paused.runId, files: [], skill: null });
    return;
  }
  const operation = Promise.resolve().then(() => pauseRun(run));
  conversationControls.set(convId, operation); syncRunningUI();
  try { await operation; }
  catch (error) { showToast(error && error.message || '暂停失败，请重试'); }
  finally { conversationControls.delete(convId); if (currentConv && currentConv.id === convId) syncRunningUI(); }
}

async function submitSupplement(draft, convId) {
  if (!currentConv || currentConv.id !== convId) return { ok: false, pending: true };
  if (conversationControls.has(convId)) return { ok: false, pending: true };
  const run = runs.get(convId);
  if (!draft.sendAsNew && draft.jobId && (!run || run.jobId !== draft.jobId)) {
    // An uncertain receipt must be reconciled with its ORIGINAL run, even after
    // completion. Sending it as an ordinary new prompt could repeat accepted work.
    const operation = Promise.resolve().then(async () => {
      const response = await window.api.steerClaude({ conversationId: convId, ...draft });
      if (response && response.ok && response.input && !['canceled', 'rejected'].includes(response.input.status)) {
        if (supplementDrafts.get(convId) === draft) supplementDrafts.delete(convId);
        if (currentConv && currentConv.id === convId) {
          const index = (currentConv.turns || []).findIndex(turn => turn.runId === draft.jobId);
          if (index >= 0) {
            const turn = currentConv.turns[index];
            applyRunSupplement({ jobId: draft.jobId, convId, turnIndex: index, turn }, response.input);
            // The background already saved this input; do not overwrite a newer final answer.
            if (activeView === 'chat') {
              if (hasSupplementTimeline(turn)) await loadConversation(convId, null, { forceReload: true });
              else {
                const before = messagesEl.querySelector(`.message.assistant[data-turn="${index}"], .conversation-stream[data-turn="${index}"]`);
                appendSupplementMessage(response.input, index, before);
              }
            }
          }
        }
        showToast('这条补充已被原任务接收');
        return { ok: true, input: response.input };
      }
      // Only a definitive refusal permits an explicit subsequent send as new input.
      if (response && (response.code === 'NOT_RUNNING'
          || response.ok && response.input && ['canceled', 'rejected'].includes(response.input.status))) draft.sendAsNew = true;
      showToast(response && (response.message || response.error) || '补充尚未送达，内容已保留');
      return { ok: false, pending: true };
    });
    operation.kind = 'supplement'; conversationControls.set(convId, operation); syncRunningUI();
    try { return await operation; }
    catch (error) { showToast(error && error.message || '暂时无法确认接收状态，补充内容已保留'); return { ok: false, pending: true }; }
    finally { conversationControls.delete(convId); if (currentConv && currentConv.id === convId) syncRunningUI(); }
  }
  const payload = { explicit: true, ...draft };
  if (draft.sendAsNew) { delete payload.messageId; delete payload.jobId; delete payload.sendAsNew; }
  const result = await send(payload);
  if (result && result.ok && supplementDrafts.get(convId) === draft) supplementDrafts.delete(convId);
  if (currentConv && currentConv.id === convId) syncRunningUI();
  return result;
}

function appendSupplementMessage(input, turnIndex, before = null) {
  if (!input || !input.id) return null;
  let el = [...messagesEl.querySelectorAll('.message.user[data-supplement-id]')]
    .find(node => node.dataset.supplementId === input.id);
  if (!el) {
    el = appendMessage('user', input.text, input.files, { ts: input.ts });
    el.dataset.supplementId = input.id;
    el.dataset.turn = String(turnIndex ?? 0);
    if (before && before.parentNode === messagesEl) messagesEl.insertBefore(el, before);
  }
  el.dataset.delivery = input.status;
  let status = el.querySelector('.supplement-status');
  if (!status) {
    let meta = el.querySelector('.message-meta');
    if (!meta) { meta = document.createElement('div'); meta.className = 'message-meta'; el.appendChild(meta); }
    status = document.createElement('span'); status.className = 'supplement-status'; meta.appendChild(status);
  }
  status.textContent = ({ queued: input.followUpMode === 'queue' ? '已排队 · 当前工作完成后处理' : '等待接收', applied: '已送达', canceled: '未处理 · 已取消', rejected: '未送达' })[input.status] || '等待接收';
  return el;
}

function applyRunSupplement(run, input) {
  if (!run || !input || typeof input.id !== 'string') return null;
  const items = run.turn.supplements || (run.turn.supplements = []);
  const index = items.findIndex(item => item.id === input.id);
  const previous = index >= 0 ? items[index] : null;
  // A confirmed delivery remains true after cancellation of the overall task.
  // A later host receipt can also correct an earlier cancellation of the queue.
  const accepted = previous && (previous.status === 'applied'
      || ['canceled', 'rejected'].includes(previous.status) && input.status !== 'applied'
      || input.status === 'queued' && previous.status !== 'queued')
    ? previous : { ...input, files: (input.files || []).map(file => ({ ...file })) };
  if (index >= 0) items[index] = accepted; else items.push(accepted);
  if (currentConv && currentConv.id === run.convId) {
    const target = currentConv.turns && currentConv.turns[run.turnIndex];
    if (target && (!target.runId || target.runId === run.jobId)) target.supplements = items;
  }
  const draft = supplementDrafts.get(run.convId);
  if (accepted.status === 'applied') clearDeliveredSupplementComposer(run, accepted);
  if (draft && draft.jobId === run.jobId && draft.messageId === input.id) {
    if (!['rejected', 'canceled'].includes(accepted.status)) {
      if (draft.composerRestored) clearSupplementComposer(draft, run.convId);
      supplementDrafts.delete(run.convId);
    } else {
      draft.sourceMessageId = input.id;
      draft.messageId = newClientRunId();
      draft.sendAsNew = true;
    }
  } else if (draft && accepted.status === 'applied' && draft.jobId === run.jobId && draft.sourceMessageId === input.id
      && sameRecoveredSupplementContent(draft, { prompt: accepted.text || '', files: accepted.files, skill: accepted.skill })) {
    supplementDrafts.delete(run.convId);
  }
  if (!draft && ['rejected', 'canceled'].includes(accepted.status)
      && (!previous || !['rejected', 'canceled'].includes(previous.status))) {
    // MCP preparation may fail after the acceptance receipt. Keep an explicit
    // composer draft for confirmed undelivered input without replacing another pending draft.
    supplementDrafts.set(run.convId, {
      jobId: run.jobId, messageId: newClientRunId(), sourceMessageId: input.id, prompt: accepted.text || '',
      files: (accepted.files || []).map(file => ({ ...file })), skill: accepted.skill || null, sendAsNew: true,
    });
    if (currentConv && currentConv.id === run.convId) syncRunningUI();
  }
  if (isMountedChatJob(run.jobId)) {
    if (hasSupplementTimeline(run.turn)) syncRunOutputActivity(run, true);
    else appendSupplementMessage(accepted, run.turnIndex, run.activityEl && run.activityEl.isConnected ? run.activityEl : run.outputBubble);
    scrollToBottom();
  }
  return accepted;
}

async function steerCurrent(options = null) {
  const convId = currentConv && currentConv.id;
  const run = convId && runs.get(convId);
  if (!run) return { ok: false, error: '任务状态已更新，请重新发送' };
  if (conversationControls.has(convId)) return { ok: false, pending: true };
  const explicit = !!(options && options.explicit);
  if (explicit && options.jobId && options.jobId !== run.jobId) return { ok: false, pending: true };
  // Flush buffered tokens before capturing the send boundary. The first segment
  // must match the text visible when the user submits, even within our throttle.
  if (isMountedChatJob(run.jobId)) syncRunOutputActivity(run, true);
  const draft = {
    jobId: run.jobId,
    presentation: explicit && window.RelaySupplementTimeline.normalize(options.presentation)
      || window.RelaySupplementTimeline.capture(outputStateForRun(run)),
    messageId: explicit && options.messageId || newClientRunId(),
    prompt: String(explicit ? options.prompt || '' : inputEl.value).trim(),
    files: (explicit && Array.isArray(options.files) ? options.files : attachedFiles).map(file => ({ ...file })),
    skill: explicit && Object.prototype.hasOwnProperty.call(options, 'skill') ? options.skill : selectedQuickSkill,
    followUpMode: explicit && ['steer', 'queue'].includes(options.followUpMode) ? options.followUpMode
      : options?.reverseFollowUp ? (followUpMode === 'queue' ? 'steer' : 'queue') : followUpMode,
  };
  if (!draft.prompt && !draft.files.length) return { ok: false, error: '请输入补充要求' };
  supplementDrafts.set(convId, draft);
  if (!explicit) {
    inputEl.value = ''; attachedFiles = []; renderAttachments();
    setSelectedQuickSkill(null); hideSkillQuickPopup(); autoGrowInput();
  }
  const operation = Promise.resolve().then(async () => {
    // This writes to the same persistent Query. It must never interrupt or create a run.
    const response = await window.api.steerClaude({ jobId: run.jobId, conversationId: convId, ...draft });
    const observed = (run.turn.supplements || []).find(input => input.id === draft.messageId);
    const input = response && response.ok && response.input ? applyRunSupplement(run, response.input) : observed;
    if (!input || ['rejected', 'canceled'].includes(input.status)) {
      if (input) draft.messageId = newClientRunId(); // A refused input needs a new submission ID.
      supplementDrafts.set(convId, draft);
      throw new Error(response && (response.message || response.error) || '补充内容未送达，已保留');
    }
    if (supplementDrafts.get(convId) === draft) supplementDrafts.delete(convId);
    return { ok: true, runId: run.jobId, conversationId: convId, input };
  });
  operation.kind = 'supplement';
  conversationControls.set(convId, operation); syncRunningUI();
  try { return await operation; }
  catch (error) {
    // If the acceptance event arrived but the invoke receipt was lost, do not resend.
    const accepted = (run.turn.supplements || []).find(input => input.id === draft.messageId && !['rejected', 'canceled'].includes(input.status));
    if (accepted) {
      if (supplementDrafts.get(convId) === draft) supplementDrafts.delete(convId);
      return { ok: true, runId: run.jobId, conversationId: convId, input: accepted };
    }
    supplementDrafts.set(convId, draft);
    showToast(error && error.message || '补充提示尚未发送，已保留');
    return { ok: false, pending: true };
  }
  finally { conversationControls.delete(convId); if (currentConv && currentConv.id === convId) syncRunningUI(); }
}

// 中止【当前所看会话】的运行
async function abortCurrent() {
  const convId = currentConv && currentConv.id;
  const run = convId && runs.get(convId);
  if (!run) { setRunning(false); return; }
  if (run.abortRequested) return;
  run.abortRequested = true;
  const jobId = run.jobId;
  let abortResult;
  try {
    abortResult = await window.api.abortClaude(jobId);
  } catch (error) {
    run.abortRequested = false;
    showToast(`中止失败：${(error && error.message) || '主进程无响应'}`);
    return;
  }
  // 常驻 interrupt、一次性 abort 和缺失执行器对账最终都统一进入 finishRun；
  // 它按 run.convId 落盘，切换会话期间不会把 A 的结果写到 B。
  if (run.finishing || runs.get(convId) !== run) return;

  if (!abortResult || abortResult.aborted !== true) {
    let task = abortResult && abortResult.task;
    if (!task && window.api.tasks && typeof window.api.tasks.get === 'function') {
      try {
        const response = await window.api.tasks.get(jobId);
        task = response && response.run;
      } catch (_) {}
    }
    if (run.finishing || runs.get(convId) !== run) return;
    const terminal = task && ['succeeded', 'failed', 'canceled', 'interrupted'].includes(task.state);
    if (terminal) {
      const errorValue = task.result && task.result.error;
      const errorText = typeof errorValue === 'string'
        ? errorValue
        : errorValue && (errorValue.message || errorValue.code);
      run.abortRequested = task.state === 'canceled';
      if (!run.abortRequested && task.state !== 'succeeded') {
        run.error = errorText || '任务执行器已结束';
      }
      await finishRun(jobId, {
        exitCode: task.state === 'succeeded' ? 0 : -1,
        error: errorText || undefined,
      });
      return;
    }
    run.abortRequested = false;
    run.error = '未找到正在运行的执行器';
    await finishRun(jobId, { exitCode: -1, error: run.error });
    return;
  }

  const deadline = Date.now() + 1000;
  while (!run.finishing && runs.get(convId) === run && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!run.finishing && runs.get(convId) === run) {
    await finishRun(jobId, { exitCode: -1, error: '用户中止' });
  }
}

sendBtn.addEventListener('click', event => { void submitComposer({ reverseFollowUp: event.ctrlKey || event.metaKey }); });
inputEl.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    void send({ reverseFollowUp: e.ctrlKey || e.metaKey });
  }
});

// 输入框自适应高度(豆包式:输入越多越高,到一定高度后内部滚动)
function autoGrowInput() {
  syncComposerAction();
  inputEl.style.height = 'auto';
  const max = 280;
  const full = inputEl.scrollHeight;
  inputEl.style.height = Math.min(full, max) + 'px';
  // 只有内容超过最大高度时才显示滚动条,单行/未超高时隐藏
  inputEl.style.overflowY = full > max ? 'auto' : 'hidden';
}
inputEl.addEventListener('input', autoGrowInput);

// ─────────────────────────────────────────
// 附件上传(点击 + / 拖拽)
// ─────────────────────────────────────────
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif'];

// 附件类型视觉映射。只依赖扩展名，保证拖拽、文件选择和历史消息都能离线稳定复现。
const ATTACHMENT_KIND_EXTS = {
  pdf:        ['pdf'],
  word:       ['doc', 'docx', 'rtf', 'odt'],
  sheet:      ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
  slides:     ['ppt', 'pptx', 'odp', 'key'],
  python:     ['py', 'pyw', 'ipynb'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx'],
  markdown:   ['md', 'mdx'],
  data:       ['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'],
  archive:    ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  audio:      ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'],
  video:      ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'],
  code:       ['java', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'kts', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'vue', 'svelte'],
  text:       ['txt', 'log', 'tex'],
};

function attachmentExt(f) {
  const explicit = String(f && f.ext || '').trim().toLowerCase().replace(/^\./, '');
  if (explicit) return explicit;
  const name = String(f && f.name || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function attachmentTypeInfo(ext) {
  const clean = String(ext || '').toLowerCase();
  if (clean === 'folder') return { kind: 'folder', label: '文件夹', mark: '' };
  if (IMAGE_EXTS.includes(clean)) return { kind: 'image', label: clean.toUpperCase() || 'IMG', mark: '' };
  let kind = 'file';
  for (const [candidate, exts] of Object.entries(ATTACHMENT_KIND_EXTS)) {
    if (exts.includes(clean)) { kind = candidate; break; }
  }
  const normalizedLabel = kind === 'word' ? 'DOC'
    : kind === 'sheet' && ['xls', 'xlsx', 'ods'].includes(clean) ? 'XLS'
    : kind === 'slides' ? 'PPT'
    : kind === 'python' ? 'PY'
    : kind === 'javascript' ? 'JS'
    : kind === 'typescript' ? 'TS'
    : kind === 'markdown' ? 'MD'
    : kind === 'archive' && clean === '7z' ? '7Z'
    : (clean || 'FILE').toUpperCase().slice(0, 8);
  const mark = kind === 'pdf' ? 'PDF'
    : kind === 'word' ? 'W'
    : kind === 'sheet' ? 'X'
    : kind === 'slides' ? 'P'
    : kind === 'javascript' ? 'JS'
    : kind === 'typescript' ? 'TS'
    : kind === 'markdown' ? 'M↓'
    : kind === 'data' ? '{ }'
    : kind === 'text' ? 'TXT'
    : kind === 'file' ? normalizedLabel.slice(0, 4)
    : '';
  return { kind, label: normalizedLabel, mark };
}

function attachmentIconSvg(kind) {
  if (kind === 'folder') return '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 9a2 2 0 0 1 2-2h7l3 3h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor" opacity=".15"/><path d="M4 9a2 2 0 0 1 2-2h7l3 3h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  if (kind === 'python') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#3776ab" d="M16 4.2c-6.2 0-5.8 2.7-5.8 2.7v2.8h6v.9H7.8S3.7 10.1 3.7 16s3.6 5.7 3.6 5.7h2.2v-3.1s-.1-3.6 3.5-3.6h6s3.4.1 3.4-3.3V7.4s.5-3.2-6.4-3.2Zm-3.3 2.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z"/><path fill="#ffd343" d="M16 27.8c6.2 0 5.8-2.7 5.8-2.7v-2.8h-6v-.9h8.4s4.1.5 4.1-5.4-3.6-5.7-3.6-5.7h-2.2v3.1s.1 3.6-3.5 3.6h-6s-3.4-.1-3.4 3.3v4.3s-.5 3.2 6.4 3.2Zm3.3-2.1a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z"/></svg>`;
  }
  if (kind === 'sheet') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 5.5h12l4 4v17H9z" fill="currentColor" opacity=".24"/><path d="M19.5 5.5v5h5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14 13.5h8v8h-8zM14 17.5h8M18 13.5v8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
  if (kind === 'slides') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="7.5" width="18" height="14" rx="2.5" fill="currentColor" opacity=".25"/><path d="M10.5 18V11h11v7zM16 21.5v4M12.5 25.5h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'archive') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 5.5h12l4 4v17H8z" fill="currentColor" opacity=".22"/><path d="M18.5 5.5v5h5M14.5 6v3M14.5 11v3M14.5 16v3M13 21h3v3h-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }
  if (kind === 'audio') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 8v14.2a3.2 3.2 0 1 1-2-3V11l12-2.5v11.7a3.2 3.2 0 1 1-2-3V6.5z" fill="currentColor"/></svg>`;
  }
  if (kind === 'video') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="7" width="22" height="18" rx="4" fill="currentColor" opacity=".24"/><path d="m14 12 7 4-7 4z" fill="currentColor"/></svg>`;
  }
  if (kind === 'code') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m12.5 10-6 6 6 6M19.5 10l6 6-6 6M18 7l-4 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (kind === 'data') {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M12 6.5H9.5v6L7 15l2.5 2.5v6H12M20 6.5h2.5v6L25 15l-2.5 2.5v6H20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  // PDF、Office、Markdown、文本和未知文件共用干净的折角文档底形，颜色与角标由 kind 控制。
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 4.5h11l5 5v18H8z" fill="currentColor" opacity=".24"/><path d="M18.5 4.5v6h5.5M11.5 14h9M11.5 18h9M11.5 22h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderAttachmentFallbackIcon(icon, info) {
  icon.replaceChildren();
  icon.className = `ac-icon ac-kind-${info.kind}`;
  icon.innerHTML = attachmentIconSvg(info.kind);
  if (info.mark) {
    const mark = document.createElement('span');
    mark.className = 'ac-icon-mark';
    mark.textContent = info.mark;
    icon.appendChild(mark);
  }
}

function toFileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}
function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 构造一个只读 chip(icon + 文件名 + 大小);删除按钮由调用方自行追加
function buildChipEl(f) {
  const chip = document.createElement('div');
  chip.className = 'attachment-chip';

  const icon = document.createElement('div');
  icon.setAttribute('aria-hidden', 'true');
  const ext = attachmentExt(f);
  const typeInfo = attachmentTypeInfo(ext);
  chip.dataset.fileKind = typeInfo.kind;
  if (typeInfo.kind === 'image') {
    // 输入区的图片卡片会隐藏文件名，仍通过悬浮提示保留完整信息。
    chip.title = f.name || f.path || '图片附件';
  }
  if (IMAGE_EXTS.includes(ext) && f.path) {
    icon.className = 'ac-icon ac-image-preview';
    const img = document.createElement('img');
    // 参考图传的是 data: URL,直接用;本地文件路径才转 file://
    img.src = /^data:/.test(f.path) ? f.path : toFileUrl(f.path);
    img.alt = '';
    // 缩略图加载失败时退回图片文件图标，避免留下破图占位。
    img.onerror = () => renderAttachmentFallbackIcon(icon, { kind: 'file', mark: 'IMG' });
    icon.appendChild(img);
  } else {
    renderAttachmentFallbackIcon(icon, typeInfo);
  }

  const meta = document.createElement('div');
  meta.className = 'ac-meta';
  const name = document.createElement('div');
  name.className = 'ac-name';
  name.textContent = f.name || f.path || '文件';
  name.title = f.name || f.path || '';
  meta.appendChild(name);
  const detailParts = [typeInfo.label, fmtSize(f.size)].filter(Boolean);
  if (detailParts.length) {
    const size = document.createElement('div');
    size.className = 'ac-size';
    size.textContent = detailParts.join(' · ');
    meta.appendChild(size);
  }

  chip.appendChild(icon);
  chip.appendChild(meta);
  return chip;
}

// 渲染输入区待发送附件(可删除)
function renderAttachments() {
  syncComposerAction();
  attachmentsEl.innerHTML = '';
  if (!attachedFiles.length) {
    attachmentsEl.classList.add('hidden');
    return;
  }
  attachmentsEl.classList.remove('hidden');
  attachedFiles.forEach((f, idx) => {
    const chip = buildChipEl(f);
    chip.classList.add('is-removable');
    const del = document.createElement('button');
    del.className = 'ac-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    del.setAttribute('aria-label', `移除附件 ${f.name || '文件'}`);
    del.addEventListener('click', () => {
      attachedFiles.splice(idx, 1);
      renderAttachments();
    });
    chip.appendChild(del);
    attachmentsEl.appendChild(chip);
  });
}

// 渲染已发送消息内的附件(只读)。
//   图片附件:用与「AI 创作」一致的 .cv-grid 完整缩略图展示(可点击放大、右键复制);
//   非图片附件(pdf/docx 等):仍用紧凑的 chip 卡片(icon+文件名+大小)。
function renderMsgAttachments(files) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-attachments';
  const list = Array.isArray(files) ? files : [];
  const images = list.filter((f) => fileIsImage(f) && f.path && !/^data:/.test(f.path));
  const others = list.filter((f) => !(fileIsImage(f) && f.path && !/^data:/.test(f.path)));
  // 图片走 buildImageGrid:多张自动排网格,点击进大图查看器(与创作结果同一套交互)。
  if (images.length) wrap.appendChild(buildImageGrid(images.map((f) => f.path)));
  // 其余文件保留 chip 卡片。
  for (const f of others) wrap.appendChild(buildChipEl(f));
  return wrap;
}

function addFiles(list, owner = composerDraftOwner) {
  if (owner === composerDraftOwner) captureComposerDraft();
  const files = owner.files || (owner.files = []);
  for (const f of (list || [])) {
    if (!f || !f.path || files.some(x => x.path === f.path)) continue;
    files.push({ ...f });
  }
  if (owner === composerDraftOwner) { attachedFiles = files.map(file => ({ ...file })); renderAttachments(); }
}

// The + menu owns attachments, project selection and execution modes.
getProjectComposer();

// 技能在加号面板中选择，输入区标签可取消这次调用。
if (skillQuickClear) {
  skillQuickClear.addEventListener('click', (e) => {
    e.stopPropagation();
    setSelectedQuickSkill(null);
    hideSkillQuickPopup();
    inputEl.focus();
  });
}

// 拖拽到输入卡片
['dragenter', 'dragover'].forEach((ev) => {
  inputCard.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    inputCard.classList.add('drag-over');
  });
});
inputCard.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // 在子元素间移动时 relatedTarget 仍在卡片内 → 不闪烁
  if (e.relatedTarget && inputCard.contains(e.relatedTarget)) return;
  inputCard.classList.remove('drag-over');
});
inputCard.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  inputCard.classList.remove('drag-over');
  const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((file) => {
    const p = window.api.getPathForFile(file);
    return {
      path: p,
      name: file.name,
      ext:  (file.name.split('.').pop() || '').toLowerCase(),
      size: file.size,
    };
  }).filter((f) => f.path);
  if (dropped.length) addFiles(dropped);
});

// 从 paste(Ctrl+V)事件里提取图片 File(截图、复制的图片等)。
//   剪贴板里的图片是 kind==='file' 且 type 以 image/ 开头的项;纯文本不在此列(交给默认粘贴)。
function imagesFromClipboard(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const out = [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//i.test(it.type)) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
// File → dataURL(Promise)
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('读取失败'));
    r.readAsDataURL(file);
  });
}
// dataURL → File(给原生剪贴板兜底:把 PNG dataURL 包成 File 复用现有 File 流程)
function dataUrlToFile(dataUrl, filename) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('无效 dataURL');
  const mime = m[1];
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

// 对话输入框:支持粘贴截图 —— 剪贴板位图没有文件路径,先落盘成真实文件,再走附件流程。
//   监听挂在输入框上(只在焦点在输入框时拦截图片粘贴),不影响在别处复制粘贴文本。
//   两条来源:① DOM 剪贴板的 image file 项;② 兜底——原生剪贴板(部分截图工具如微信只写位图,
//   DOM 取不到 file 项),从主进程 readClipboardImage 拿 PNG dataURL。
inputEl.addEventListener('paste', async (e) => {
  const owner = captureComposerDraft();
  const imgs = imagesFromClipboard(e);
  // 没有 DOM 图片项:尝试原生剪贴板兜底。拿到就拦截默认粘贴并落盘;拿不到就放行(纯文本照常)。
  if (!imgs.length) {
    let nativeUrl = null;
    try { const r = await window.api.image.readClipboardImage(); if (r && r.ok && r.dataUrl) nativeUrl = r.dataUrl; } catch (_) {}
    if (!nativeUrl) return;
    e.preventDefault();
    await savePastedDataUrlToChat(nativeUrl, 0, owner);
    return;
  }
  e.preventDefault();                // 有图片:拦下,避免把二进制塞进 textarea
  for (const file of imgs) {
    try { await savePastedDataUrlToChat(await fileToDataUrl(file), file.size, owner); }
    catch (_) { /* 单张失败忽略,不影响其它 */ }
  }
});
// 把一张粘贴图片(dataURL)落盘并加入对话附件
async function savePastedDataUrlToChat(dataUrl, size, owner = captureComposerDraft()) {
  try {
    const r = await window.api.image.savePaste({ dataUrl });
    if (r && r.ok && r.path) {
      addFiles([{ path: r.path, name: r.name || '粘贴的图片.png',
                  ext: (r.path.split('.').pop() || 'png').toLowerCase(), size: size || 0 }], owner);
    }
  } catch (_) {}
}

// 防止把文件拖到窗口空白处时 Electron 直接导航打开该文件(整个应用会被替换)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

function memoryFileFromMarkdownHref(href) {
  let target = String(href || '').split(/[?#]/, 1)[0];
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  try { target = decodeURIComponent(target); } catch (_) { return null; }
  // 记忆 IPC 只接受库根目录中的单个 .md 文件名；渲染层也保持相同边界。
  if (target.includes('/') || target.includes('\\') || target === '.' || target === '..') return null;
  return target.toLowerCase().endsWith('.md') ? target : null;
}

// Markdown 链接统一接管：网页遵循浏览器设置；记忆索引的相对 .md 链接打开记忆详情；
// 其它相对/本地链接不允许替换 Relay 主页面。
function handleAppAnchorClick(e) {
  if (e.defaultPrevented || (e.type === 'auxclick' && e.button !== 1)) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  const memoryPreview = a.closest('[data-memory-file]');
  if (memoryPreview) {
    const memoryFile = memoryFileFromMarkdownHref(href);
    if (memoryFile) {
      e.preventDefault();
      e.stopPropagation();
      const label = (a.textContent || '').trim() || memoryFile.replace(/\.md$/i, '');
      renderMemoryEditor(memoryFile, label);
      return;
    }
  }
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    e.preventDefault();
    void window.relayBrowserSettings.openLink(href).catch(error => showToast(error.message || '无法打开链接'));
    return;
  }
  if (href.startsWith('#')) return;
  e.preventDefault();
}
document.addEventListener('click', handleAppAnchorClick);
document.addEventListener('auxclick', handleAppAnchorClick);

// ─────────────────────────────────────────
// 模型档位切换(豆包式:快速 / 思考 / 专家)
//   快速=haiku(MiMo) · 思考=sonnet · 专家=opus
// ─────────────────────────────────────────
// 图标统一为细描边线性风格(stroke 1.8 / 圆角 / currentColor),与工具栏一致
const MODEL_TIERS = [
  {
    value: 'haiku',
    preferredEffort: 'low',
    label: '快速',
    desc: '适用于大部分情况',
    // 闪电(描边)
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  },
  {
    value: 'sonnet',
    preferredEffort: 'high',
    label: '思考',
    desc: '擅长解决更难的问题',
    // 灯泡(描边)
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.5 14.5A5.5 5.5 0 1 0 8.5 14.5c.7.6 1.2 1.3 1.4 2.2h4.2c.2-.9.7-1.6 1.4-2.2z"/></svg>',
  },
  {
    value: 'opus',
    preferredEffort: 'max',
    label: '专家',
    desc: '研究级智能模型',
    // 原子(描边):中心原子核 + 三条均匀分布(0°/60°/120°)的电子轨道,径向对称、是通用的原子符号写法
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  },
];

const EFFORT_LABELS = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };

function applyProviderRouting(value) {
  const input = value && typeof value === 'object' ? value : {};
  providerRouting = {
    defaultModel: ['haiku', 'sonnet', 'opus'].includes(input.defaultModel) ? input.defaultModel : 'haiku',
    chatRoutes: Array.isArray(input.chatRoutes) ? input.chatRoutes : [],
    imageRoutes: Array.isArray(input.imageRoutes) ? input.imageRoutes : [],
  };
  providerRoutingLoaded = true;
  if (configuredChatRoute(providerRouting.defaultModel)) defaultModel = providerRouting.defaultModel;
  syncBehaviorDefaultModel(providerRouting);
}

function configuredChatRoute(tier) {
  return providerRouting.chatRoutes.find((route) => route && route.tier === tier
    && route.configured && route.available) || null;
}

function sessionRouteSnapshot(route, tier) {
  if (!route || !route.providerId) return null;
  return {
    providerId: route.providerId,
    providerRevision: Number(route.providerRevision) || 0,
    routeTier: tier,
    agentEnvironment,
  };
}

function conversationSessionMatchesRoute(conv, route, tier) {
  if (!conv || !conv.sessionProviderId || !route || !route.providerId) return false;
  return conv.sessionProviderId === route.providerId
    && Number(conv.sessionProviderRevision || 0) === Number(route.providerRevision || 0)
    && (conv.sessionRouteTier || conv.sessionModel || tier) === tier
    && (conv.sessionAgentEnvironment || 'native') === agentEnvironment;
}

function applyConversationSessionState(conv, state) {
  if (!conv || !state) return;
  conv.sessionId = state.sessionId || null;
  const optionalKeys = [
    'sessionProviderId',
    'sessionRouteTier',
    'sessionAgentEnvironment',
    'sessionModel',
    'carryContextOnNextTurn',
    'model',
  ];
  for (const key of optionalKeys) {
    if (state[key] == null) delete conv[key];
    else conv[key] = state[key];
  }
  if (state.sessionProviderRevision == null) delete conv.sessionProviderRevision;
  else conv.sessionProviderRevision = Number(state.sessionProviderRevision) || 0;
}

const providerSessionInvalidationVersions = new WeakMap();

async function invalidateConversationSessionForProvider(conv, routeTier) {
  if (!conv) return null;
  const requestVersion = (providerSessionInvalidationVersions.get(conv) || 0) + 1;
  providerSessionInvalidationVersions.set(conv, requestVersion);
  // IPC 失败时也要优先阻止跨服务商 resume；成功后再用主进程的最新快照消除竞态。
  conv.sessionId = null;
  conv.carryContextOnNextTurn = 'provider';
  if (routeTier) conv.model = routeTier;
  if (!conv.id || !window.api.history.invalidateSessionForProvider) return null;
  try {
    const result = await window.api.history.invalidateSessionForProvider(conv.id, routeTier);
    const isLatestRequest = providerSessionInvalidationVersions.get(conv) === requestVersion;
    const isStillOptimisticState = conv.sessionId == null
      && conv.carryContextOnNextTurn === 'provider'
      && conv.model === routeTier;
    const returnedSessionMatchesCurrentRoute = !result || !result.session || !result.session.sessionId
      || conversationSessionMatchesRoute(result.session, configuredChatRoute(routeTier), routeTier);
    if (isLatestRequest && isStillOptimisticState && returnedSessionMatchesCurrentRoute
        && result && result.ok && result.session) {
      applyConversationSessionState(conv, result.session);
    }
    return result;
  } catch (_) {
    return null;
  } finally {
    if (providerSessionInvalidationVersions.get(conv) === requestVersion) {
      providerSessionInvalidationVersions.delete(conv);
    }
  }
}

function initProviderRoutingEvents() {
  if (providerRuntimeChangeOff || !window.api.providers || !window.api.providers.onChanged) return;
  providerRuntimeChangeOff = window.api.providers.onChanged((payload) => {
    const routes = payload && (payload.routes || (payload.active && payload.active.routes));
    if (!routes) return;
    applyProviderRouting(routes);
    imageConfigLoaded = false;
    if (activeView === 'create') loadImageModels().catch(() => {});
    supportedClaudeModels = [];
    supportedClaudeProviderId = '';

    let nextRoute = configuredChatRoute(currentModel);
    if (!nextRoute) {
      const fallback = availableModelTiers()[0];
      if (fallback) {
        currentModel = fallback.value;
        currentEffort = effortForTier(fallback);
        nextRoute = configuredChatRoute(currentModel);
      }
    }
    defaultModel = providerRouting.defaultModel;
    if (!currentConv && configuredChatRoute(defaultModel)) currentModel = defaultModel;

    if (currentConv && currentSessionId && nextRoute
        && !conversationSessionMatchesRoute(currentConv, nextRoute, currentModel)) {
      const targetSessionRoute = sessionRouteSnapshot(nextRoute, currentModel);
      const resettingConv = currentConv;
      currentSessionId = null;
      invalidateConversationSessionForProvider(resettingConv, targetSessionRoute.routeTier)
        .then(() => {
          if (currentConv === resettingConv) currentSessionId = resettingConv.sessionId || null;
        });
    }
    updateModelSwitchUI();
    if (modelPopup && modelPopup.classList.contains('show')) renderModelPopup();
  });
}

function modelCapability(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return null;
  const configured = ['haiku', 'sonnet', 'opus'].includes(clean) ? configuredChatRoute(clean) : null;
  if (configured && supportedClaudeProviderId && configured.providerId !== supportedClaudeProviderId) return null;
  const configuredModel = String(configured && configured.modelId || '').trim().toLowerCase();
  const target = configuredModel || clean;
  const exact = supportedClaudeModels.find((model) => {
    return String(model.value || '').toLowerCase() === target
      || String(model.resolvedModel || '').toLowerCase() === target;
  });
  if (exact) return exact;
  // 仅配置本身使用 SDK 别名时兼容其上下文窗口后缀；不能把原生 Claude
  // 的能力按 Relay 档位借给同一档位中配置的第三方模型。
  if (!['haiku', 'sonnet', 'opus'].includes(target)) return null;
  return supportedClaudeModels.find((model) => {
    const sdkValue = String(model.value || '').toLowerCase();
    const resolved = String(model.resolvedModel || '').toLowerCase();
    return sdkValue.startsWith(`${target}[`)
      || resolved.startsWith(`claude-${target}-`);
  }) || null;
}

function runtimeModelForValue(value) {
  // 主进程按稳定档位解析服务商和完整远端模型 ID。renderer 不再把当前 SDK
  // 会话返回的模型名带到另一个服务商，避免跨网关使用错误的模型标识。
  return ['haiku', 'sonnet', 'opus'].includes(value) ? value : 'haiku';
}

function effortForTier(tier) {
  if (!tier) return null;
  const capability = modelCapability(tier.value);
  if (!capability) return null;
  const levels = Array.isArray(capability.supportedEffortLevels) ? capability.supportedEffortLevels : [];
  if (!capability.supportsEffort || !levels.length) return null;
  if (levels.includes(tier.preferredEffort)) return tier.preferredEffort;
  return levels[levels.length - 1] || null;
}

function supportedEffortLevelsForTier(tier = currentTier()) {
  const capability = tier && modelCapability(tier.value);
  // 未取得当前模型的能力时不猜测其支持全部推理强度。
  if (!capability || !capability.supportsEffort) return [];
  return Array.isArray(capability.supportedEffortLevels)
    ? capability.supportedEffortLevels.filter((level) => EFFORT_LABELS[level])
    : [];
}

function effectiveEffortForTier(tier = currentTier()) {
  const levels = supportedEffortLevelsForTier(tier);
  if (currentEffort && levels.includes(currentEffort)) return currentEffort;
  const preferred = effortForTier(tier);
  if (preferred && levels.includes(preferred)) return preferred;
  return levels[0] || null;
}

function availableModelTiers() {
  if (!providerRoutingLoaded) return MODEL_TIERS;
  return MODEL_TIERS.filter((tier) => configuredChatRoute(tier.value));
}

function currentTier() {
  return MODEL_TIERS.find((t) => t.value === currentModel) || MODEL_TIERS[0];
}
function modelDisplayForTier(tier = currentTier()) {
  return window.RelayModelDisplay.describeRoute(configuredChatRoute(tier.value), { loaded: providerRoutingLoaded });
}
function updateModelSwitchUI() {
  const t = currentTier();
  const display = modelDisplayForTier(t);
  if (msIco)   msIco.innerHTML = t.icon;
  if (msLabel) msLabel.textContent = t.label;
  const effort = effectiveEffortForTier(t);
  if (msEffortLabel) msEffortLabel.textContent = effort ? (EFFORT_LABELS[effort] || effort) : '';
  if (btnModelSwitch) {
    btnModelSwitch.title = display.tooltip;
    btnModelSwitch.setAttribute('aria-label', `当前模型 ${display.label}${effort ? `，推理强度${EFFORT_LABELS[effort] || effort}` : ''}，打开模型设置`);
    btnModelSwitch.setAttribute('aria-haspopup', 'dialog');
  }
}

function fullTokenCount(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(Number(value) || 0)));
}

function compactContextTokenCount(value) {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  return tokens < 1000 ? String(tokens) : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(tokens / 1000)}k`;
}

function positionContextUsagePopover() {
  if (!contextUsageEl || !contextUsagePopover || contextUsageEl.classList.contains('hidden')) return;
  const anchor = contextUsageEl.getBoundingClientRect();
  const popover = contextUsagePopover.getBoundingClientRect();
  const viewportGap = 12;
  let left = anchor.left + (anchor.width - popover.width) / 2;
  left = Math.max(viewportGap, Math.min(left, window.innerWidth - popover.width - viewportGap));
  let top = anchor.top - popover.height - 8;
  let placement = 'top';
  if (top < viewportGap) {
    top = anchor.bottom + 8;
    placement = 'bottom';
  }
  const anchorCenter = anchor.left + anchor.width / 2;
  const anchorLeft = Math.max(16, Math.min(popover.width - 16, anchorCenter - left));
  contextUsagePopover.style.left = `${Math.round(left)}px`;
  contextUsagePopover.style.top = `${Math.round(top)}px`;
  contextUsagePopover.style.setProperty('--context-anchor-left', `${Math.round(anchorLeft)}px`);
  contextUsagePopover.dataset.placement = placement;
}

function showContextUsagePopover() {
  if (!contextUsagePopover || !contextUsageEl || contextUsageEl.classList.contains('hidden')) return;
  positionContextUsagePopover();
  contextUsagePopover.classList.add('visible');
  contextUsagePopover.setAttribute('aria-hidden', 'false');
}

function hideContextUsagePopover() {
  if (!contextUsagePopover) return;
  contextUsagePopover.classList.remove('visible');
  contextUsagePopover.setAttribute('aria-hidden', 'true');
}

if (contextUsageEl) {
  contextUsageEl.addEventListener('mouseenter', showContextUsagePopover);
  contextUsageEl.addEventListener('mouseleave', hideContextUsagePopover);
  contextUsageEl.addEventListener('focus', showContextUsagePopover);
  contextUsageEl.addEventListener('blur', hideContextUsagePopover);
}
window.addEventListener('resize', () => {
  if (contextUsagePopover && contextUsagePopover.classList.contains('visible')) positionContextUsagePopover();
});

function setContextUsageEnabled(value) {
  contextUsageEnabled = value !== false;
  renderContextUsage();
  syncContextUsagePolling();
}

function renderContextUsage(convId = currentConv && currentConv.id) {
  if (!contextUsageEl || !contextUsageLabel) return;
  const usage = convId ? contextUsageByConv.get(convId) : null;
  const windowTokens = Number(usage?.rawMaxTokens || usage?.maxTokens) || 0;
  if (!contextUsageEnabled || !usage || windowTokens <= 0) {
    contextUsageEl.classList.add('hidden');
    contextUsageEl.removeAttribute('title');
    contextUsageEl.removeAttribute('aria-label');
    hideContextUsagePopover();
    return;
  }
  const percentage = Math.max(0, Math.round(Number(usage.percentage) || 0));
  contextUsageLabel.textContent = `${percentage}%`;
  contextUsageEl.classList.remove('hidden', 'warn', 'critical');
  if (contextUsagePopover) contextUsagePopover.classList.remove('warn', 'critical');
  if (percentage >= 90) {
    contextUsageEl.classList.add('critical');
    if (contextUsagePopover) contextUsagePopover.classList.add('critical');
  } else if (percentage >= 75) {
    contextUsageEl.classList.add('warn');
    if (contextUsagePopover) contextUsagePopover.classList.add('warn');
  }
  contextUsageEl.removeAttribute('title');
  contextUsageEl.setAttribute('aria-label', `上下文占用约 ${percentage}%，SDK 估算 ${fullTokenCount(usage.totalTokens)}，上下文窗口 ${fullTokenCount(windowTokens)}`);
  if (contextUsagePercent) contextUsagePercent.textContent = `${percentage}% 已用`;
  if (contextUsageTokens) contextUsageTokens.textContent = `已用 ${compactContextTokenCount(usage.totalTokens)} Token，共 ${compactContextTokenCount(windowTokens)}`;
  if (contextUsagePopover) {
    contextUsagePopover.title = `SDK 估算${isConvRunning(convId) ? '，运行中约每 2 秒刷新' : ''}；以最近请求的上下文为准，并非逐 Token 精确计数。`;
    contextUsagePopover.setAttribute('aria-label', contextUsageEl.getAttribute('aria-label'));
  }
  if (contextUsagePopover && contextUsagePopover.classList.contains('visible')) positionContextUsagePopover();
}

async function refreshClaudeRuntimeInfo(convId, { includeContext = true, contextOnly = false, pollRevision = null } = {}) {
  if (!convId || !window.api.claudeRuntimeInfo) return null;
  includeContext = includeContext && contextUsageEnabled;
  if (contextOnly && !includeContext) return null;
  const requestedConv = currentConv && currentConv.id === convId ? currentConv : null;
  const requestedSessionId = requestedConv?.sessionId || null;
  const requestedModel = currentModel;
  const requestedRoute = configuredChatRoute(requestedModel);
  const requestRevision = claudeRuntimeUIRevision;
  const readRevision = requestedConv && !contextOnly ? ++claudeRuntimeReadRevision : null;
  const contextReadRevision = (contextUsageReadRevisions.get(convId) || 0) + 1;
  if (includeContext) contextUsageReadRevisions.set(convId, contextReadRevision);
  try {
    const info = await window.api.claudeRuntimeInfo(convId, { includeContext, contextOnly });
    if (!info || info.stale) return null;
    const isCurrentRequest = requestedConv && currentConv === requestedConv
      && (requestedConv.sessionId || null) === requestedSessionId
      && currentModel === requestedModel && requestRevision === claudeRuntimeUIRevision
      && (contextOnly || readRevision === claudeRuntimeReadRevision)
      && (!pendingClaudeRuntimeSelection || pendingClaudeRuntimeSelection.conv !== requestedConv)
      && configuredChatRoute(requestedModel) === requestedRoute;
    const matchesProvider = !requestedRoute || (info.providerId === requestedRoute.providerId
      && (info.providerRevision == null
        || Number(info.providerRevision) === Number(requestedRoute.providerRevision || 0)));
    const matchesModel = !info.routeTier || info.routeTier === requestedModel;
    if (!contextOnly && isCurrentRequest && matchesProvider && matchesModel && Array.isArray(info.models)) {
      supportedClaudeModels = info.models;
      supportedClaudeProviderId = info.providerId || '';
      currentEffort = Object.prototype.hasOwnProperty.call(info, 'effort')
        ? info.effort || null : requestedConv.effort || null;
      updateModelSwitchUI();
    }
    if (includeContext && info.context && isCurrentRequest && matchesProvider && matchesModel
        && contextReadRevision === contextUsageReadRevisions.get(convId)
        && (pollRevision == null || pollRevision === contextUsagePollRevision)) {
      contextUsageByConv.set(convId, info.context);
      // In-flight estimates belong to the UI cache; ordinary history saves must
      // not accidentally persist them every time a streaming event arrives.
      if (!contextOnly && !info.busy) requestedConv.contextUsage = info.context;
      renderContextUsage(convId);
    }
    return info;
  } catch (_) {
    return null;
  }
}

function contextUsagePollingKey() {
  const id = currentConv && currentConv.id;
  if (!contextUsageEnabled || activeView !== 'chat' || document.hidden || !id || !isConvRunning(id)
      || pendingClaudeRuntimeSelection || !window.api.claudeRuntimeInfo) return '';
  const route = configuredChatRoute(currentModel);
  return JSON.stringify([id, currentModel, route?.providerId, route?.providerRevision, runs.get(id)?.jobId]);
}

function syncContextUsagePolling() {
  const key = contextUsagePollingKey();
  if (key === contextUsagePollKey && (contextUsagePollTimer || contextUsagePollInFlight || !key)) return;
  if (contextUsagePollTimer) clearTimeout(contextUsagePollTimer);
  contextUsagePollTimer = null; contextUsagePollKey = key;
  const revision = ++contextUsagePollRevision;
  if (!key) { renderContextUsage(); return; }
  const convId = currentConv.id;
  const tick = async () => {
    contextUsagePollTimer = null;
    if (revision !== contextUsagePollRevision) return;
    if (contextUsagePollingKey() !== key) { syncContextUsagePolling(); return; }
    if (!contextUsagePollInFlight) {
      const request = refreshClaudeRuntimeInfo(convId, { contextOnly: true, pollRevision: revision });
      contextUsagePollInFlight = request;
      try { await request; } finally { if (contextUsagePollInFlight === request) contextUsagePollInFlight = null; }
    }
    if (revision === contextUsagePollRevision && contextUsagePollingKey() === key) {
      contextUsagePollTimer = setTimeout(tick, 2000);
    } else if (revision === contextUsagePollRevision) syncContextUsagePolling();
  };
  contextUsagePollTimer = setTimeout(tick, 0);
}

window.addEventListener('relay:view-changed', syncContextUsagePolling);
window.addEventListener('relay:conversation-changed', () => { syncContextUsagePolling(); });
document.addEventListener('visibilitychange', syncContextUsagePolling);

async function selectModelTier(tier) {
  if (providerRoutingLoaded && !configuredChatRoute(tier && tier.value)) {
    showToast(`${tier && tier.label || '该'}档位尚未配置，请前往“设置 → 服务商”分配模型`);
    return;
  }
  const previousModel = currentModel;
  const previousEffort = currentEffort;
  const nextEffort = effortForTier(tier);
  const changingConv = currentConv;
  const requestRevision = ++claudeRuntimeUIRevision;
  const isCurrentSelection = () => currentConv === changingConv && currentModel === tier.value
    && requestRevision === claudeRuntimeUIRevision;
  currentModel = tier.value;
  currentEffort = nextEffort;
  updateModelSwitchUI();
  rememberModelPopupHome('advanced');
  hideModelPopup();

  const convId = changingConv && changingConv.id;
  if (!convId || !window.api.setClaudeRuntime) return;
  const pendingSelection = { conv: changingConv, revision: requestRevision };
  pendingClaudeRuntimeSelection = pendingSelection;
  btnModelSwitch.disabled = true;
  try {
    const result = await window.api.setClaudeRuntime(
      convId, runtimeModelForValue(tier.value), nextEffort,
    );
    if (!result || !result.ok) throw new Error(result && result.message || '模型切换失败');
    let appliedEffort = Object.prototype.hasOwnProperty.call(result, 'effort') ? result.effort || null : nextEffort;
    const persistedRouteChanged = !!(changingConv.sessionProviderId && result.providerId
      && (changingConv.sessionProviderId !== result.providerId
        || Number(changingConv.sessionProviderRevision || 0) !== Number(result.providerRevision || 0)));
    if (result.restartRequired || persistedRouteChanged) {
      changingConv.sessionId = null;
      changingConv.sessionModel = null;
      changingConv.carryContextOnNextTurn = 'provider';
      delete changingConv.sessionProviderId;
      delete changingConv.sessionProviderRevision;
      delete changingConv.sessionRouteTier;
      delete changingConv.sessionAgentEnvironment;
      appliedEffort = null;
      if (isCurrentSelection()) {
        currentSessionId = null;
        supportedClaudeModels = [];
        supportedClaudeProviderId = '';
        showToast(`已切换到「${tier.label}」，下一条消息将使用新的服务商`);
      }
    } else if (result.applied) {
      // SDK 已在原 Query 内完成切换；同步 sessionModel，下一轮无需丢弃 session 或重连 MCP。
      changingConv.sessionModel = tier.value;
      changingConv.sessionProviderId = result.providerId || changingConv.sessionProviderId;
      changingConv.sessionProviderRevision = result.providerRevision ?? changingConv.sessionProviderRevision;
      changingConv.sessionRouteTier = result.routeTier || tier.value;
      changingConv.sessionAgentEnvironment = result.agentEnvironment || changingConv.sessionAgentEnvironment || 'native';
    }
    changingConv.model = tier.value;
    changingConv.effort = appliedEffort;
    if (previousModel !== tier.value || result.restartRequired || persistedRouteChanged) {
      contextUsageByConv.delete(convId);
      delete changingConv.contextUsage;
      if (isCurrentSelection()) renderContextUsage(convId);
    }
    if (isCurrentSelection()) {
      currentEffort = appliedEffort;
      if (!result.restartRequired && Array.isArray(result.models)) {
        supportedClaudeModels = result.models;
        supportedClaudeProviderId = result.providerId || supportedClaudeProviderId;
      }
      updateModelSwitchUI();
    }
    try { await window.api.history.save(changingConv); } catch (_) {}
  } catch (e) {
    if (isCurrentSelection()) {
      currentModel = previousModel;
      currentEffort = previousEffort;
      updateModelSwitchUI();
      showToast(e.message || '模型切换失败');
    }
  } finally {
    if (pendingClaudeRuntimeSelection === pendingSelection) pendingClaudeRuntimeSelection = null;
    if (requestRevision === claudeRuntimeUIRevision) {
      btnModelSwitch.disabled = !!(currentConv && isConvRunning(currentConv.id));
    }
  }
}

async function selectEffortLevel(level) {
  const allowed = supportedEffortLevelsForTier();
  if (!allowed.includes(level) || level === currentEffort) return;
  const previousEffort = currentEffort;
  const changingConv = currentConv;
  const changingModel = currentModel;
  const requestRevision = ++claudeRuntimeUIRevision;
  const isCurrentSelection = () => currentConv === changingConv && currentModel === changingModel
    && requestRevision === claudeRuntimeUIRevision;
  currentEffort = level;
  updateModelSwitchUI();

  const convId = changingConv && changingConv.id;
  if (!convId || !window.api.setClaudeRuntime) return;
  const pendingSelection = { conv: changingConv, revision: requestRevision };
  pendingClaudeRuntimeSelection = pendingSelection;
  btnModelSwitch.disabled = true;
  try {
    const result = await window.api.setClaudeRuntime(
      convId, runtimeModelForValue(changingModel), level,
    );
    if (!result || !result.ok) throw new Error(result && result.message || '推理强度切换失败');
    const appliedEffort = Object.prototype.hasOwnProperty.call(result, 'effort') ? result.effort || null : level;
    if (result.applied) changingConv.sessionModel = changingModel;
    changingConv.model = changingModel;
    changingConv.effort = appliedEffort;
    if (isCurrentSelection()) {
      currentEffort = appliedEffort;
      updateModelSwitchUI();
    }
    try { await window.api.history.save(changingConv); } catch (_) {}
  } catch (e) {
    if (isCurrentSelection()) {
      currentEffort = previousEffort;
      updateModelSwitchUI();
      if (modelPopup && modelPopup.classList.contains('show')) {
        modelPopupTransition = 'refresh';
        renderModelPopup();
      }
      showToast(e.message || '推理强度切换失败');
    }
  } finally {
    if (pendingClaudeRuntimeSelection === pendingSelection) pendingClaudeRuntimeSelection = null;
    if (requestRevision === claudeRuntimeUIRevision) {
      btnModelSwitch.disabled = !!(currentConv && isConvRunning(currentConv.id));
    }
  }
}

// 模型切换器只在「新对话」(plain)显示;「Agent」模式隐藏 = 锁定模型
function updateComposerForMode() {
  const ms = $('modelSwitch');
  if (ms) ms.style.display = '';   // Agent 模式也允许切换模型(与新对话一致)
  hideModelPopup();
}

let modelPopup = null;
const MODEL_POPUP_HOME_KEY = 'relay:model-popup-home';
function readModelPopupHome() {
  try { return localStorage.getItem(MODEL_POPUP_HOME_KEY) === 'root' ? 'root' : 'advanced'; }
  catch (_) { return 'advanced'; }
}
function rememberModelPopupHome(page) {
  modelPopupHomePage = page === 'advanced' ? 'advanced' : 'root';
  try { localStorage.setItem(MODEL_POPUP_HOME_KEY, modelPopupHomePage); } catch (_) {}
}
let modelPopupHomePage = readModelPopupHome();
let modelPopupPage = modelPopupHomePage;
let modelPopupTransition = 'open';
let modelPopupMorph = null;
function ensureModelPopup() {
  if (modelPopup) return modelPopup;
  modelPopup = document.createElement('div');
  modelPopup.className = 'model-popup model-switch-popup';
  modelPopup.id = 'modelSettingsPopup';
  modelPopup.setAttribute('role', 'dialog');
  modelPopup.setAttribute('aria-label', '模型与推理强度');
  btnModelSwitch.setAttribute('aria-controls', modelPopup.id);
  btnModelSwitch.setAttribute('aria-expanded', 'false');
  modelPopup.addEventListener('keydown', handleModelPopupKeydown);
  document.body.appendChild(modelPopup);
  return modelPopup;
}
function modelMenuChevron(direction = 'right') {
  const paths = {
    left: 'M10 3 5 8l5 5',
    right: 'M6 3l5 5-5 5',
    up: 'M3 10l5-5 5 5',
    down: 'M3 6l5 5 5-5',
  };
  const path = paths[direction] || paths.right;
  return `<svg class="model-menu-chevron" viewBox="0 0 16 16" fill="none"><path d="${path}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function appendModelSubmenuHead(pop, title, value) {
  const head = document.createElement('div');
  head.className = 'model-submenu-head';
  head.innerHTML = `
    <button class="model-submenu-back" type="button" aria-label="返回模型设置">
      ${modelMenuChevron('left')}
      <span>${escapeHtml(title)}</span>
    </button>
    <span class="model-submenu-current">${escapeHtml(value || '')}</span>`;
  head.querySelector('.model-submenu-back').addEventListener('click', (e) => {
    e.stopPropagation();
    modelPopupPage = 'root';
    modelPopupTransition = 'back';
    renderModelPopup();
  });
  pop.appendChild(head);
}

function renderModelPopupRoot(pop) {
  const tier = currentTier();
  const effortLevels = supportedEffortLevelsForTier(tier);
  const effectiveEffort = effectiveEffortForTier(tier);
  const rows = [
    { page: 'model', name: '模型', value: modelDisplayForTier(tier).label, disabled: false },
    {
      page: 'advanced', name: '推理强度',
      value: effortLevels.length ? (EFFORT_LABELS[effectiveEffort] || effectiveEffort) : '不可用',
      disabled: !effortLevels.length,
    },
  ];
  rows.forEach((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'model-menu-row';
    row.disabled = item.disabled;
    if (item.page === 'model') row.title = modelDisplayForTier(tier).tooltip;
    row.innerHTML = `
      <span class="model-menu-name">${item.name}</span>
      <span class="model-menu-value">${escapeHtml(item.value)}</span>
      ${modelMenuChevron('right')}`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      modelPopupPage = item.page;
      if (item.page === 'advanced') rememberModelPopupHome('advanced');
      else rememberModelPopupHome('root');
      modelPopupTransition = 'forward';
      renderModelPopup();
    });
    pop.appendChild(row);
  });
}

function renderModelPopupModels(pop) {
  appendModelSubmenuHead(pop, '模型', modelDisplayForTier().label);
  MODEL_TIERS.forEach((t) => {
    const route = configuredChatRoute(t.value);
    const display = modelDisplayForTier(t);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-row' + (t.value === currentModel ? ' selected' : '');
    row.disabled = providerRoutingLoaded && !route;
    row.title = display.tooltip;
    row.setAttribute('aria-label', `${t.label}，${display.label}`);
    row.setAttribute('aria-pressed', String(t.value === currentModel));
    row.innerHTML = `
      <span class="mp-ico">${t.icon}</span>
      <span class="mp-meta">
        <span class="mp-title">${t.label}</span>
        <span class="mp-desc">${escapeHtml(display.label)}</span>
      </span>
      <svg class="mp-check" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      selectModelTier(t);
    });
    pop.appendChild(row);
  });
}

function renderModelPopupAdvanced(pop) {
  const tier = currentTier();
  const display = modelDisplayForTier(tier);
  const levels = supportedEffortLevelsForTier(tier);
  const selectedIndex = Math.max(0, levels.indexOf(effectiveEffortForTier()));
  const head = document.createElement('div');
  head.className = 'model-submenu-head model-advanced-head';
  head.innerHTML = `
    <span class="model-strength-icon" aria-hidden="true">${tier.icon}</span>
    <button class="model-submenu-back model-advanced-back" type="button" aria-label="打开模型与推理强度选项">
      <span class="model-strength-title">${levels.length ? escapeHtml(EFFORT_LABELS[levels[selectedIndex]] || levels[selectedIndex]) : '推理强度'}</span>
      ${modelMenuChevron('right')}
    </button>`;
  head.querySelector('.model-advanced-back').addEventListener('click', (e) => {
    e.stopPropagation();
    rememberModelPopupHome('root');
    modelPopupPage = 'root';
    modelPopupTransition = 'back';
    renderModelPopup();
  });
  pop.appendChild(head);
  const strengthTitle = head.querySelector('.model-strength-title');
  const modelButton = document.createElement('button');
  modelButton.type = 'button';
  modelButton.className = 'model-current-name';
  modelButton.textContent = display.label;
  modelButton.title = display.tooltip;
  modelButton.setAttribute('aria-label', `选择模型，当前为 ${display.label}`);
  modelButton.addEventListener('click', (event) => {
    event.stopPropagation();
    modelPopupPage = 'model';
    modelPopupTransition = 'forward';
    renderModelPopup();
  });
  pop.appendChild(modelButton);
  if (!levels.length) {
    const unavailable = document.createElement('div');
    unavailable.className = 'model-effort-unavailable';
    unavailable.textContent = modelCapability(currentTier().value)
      ? '此模型暂不提供推理强度设置'
      : '尚未获取此模型的推理强度信息';
    pop.appendChild(unavailable);
    return;
  }

  const slider = document.createElement('div');
  slider.className = 'model-effort-slider-shell';
  slider.innerHTML = `
    <div class="model-effort-range-wrap">
      <div class="model-effort-track" aria-hidden="true"><div class="model-effort-fill"><span class="model-effort-shimmer"></span><span class="model-effort-particle-field"></span></div></div>
      <span class="model-effort-thumb" aria-hidden="true"></span>
      <input class="model-effort-range" type="range" min="0" max="${levels.length - 1}" step="1" value="${selectedIndex}" aria-label="推理强度">
      <div class="model-effort-dots"></div>
    </div>`;
  const range = slider.querySelector('.model-effort-range');
  const fill = slider.querySelector('.model-effort-fill');
  const thumb = slider.querySelector('.model-effort-thumb');
  const particles = slider.querySelector('.model-effort-particle-field');
  const dots = slider.querySelector('.model-effort-dots');
  // Static particles animate in CSS only while the popup is visible. No canvas,
  // timer or pointer loop remains running after the menu closes.
  for (let index = 0; index < 14; index += 1) {
    const spark = document.createElement('span');
    spark.className = 'model-effort-spark';
    spark.style.setProperty('--spark-x', `${6 + (index * 37) % 89}%`);
    spark.style.setProperty('--spark-y', `${20 + (index * 23) % 58}%`);
    spark.style.setProperty('--spark-delay', `${-(index % 7) * .43}s`);
    particles.appendChild(spark);
  }
  levels.forEach((level, index) => {
    const dot = document.createElement('span');
    dot.className = 'model-effort-dot';
    dot.style.left = `${levels.length === 1 ? 50 : (index / (levels.length - 1)) * 100}%`;
    dots.appendChild(dot);
  });
  let paintedIndex = selectedIndex;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = (index, pointerFraction = null) => {
    const visual = window.RelayModelDisplay.effortVisualState(levels, index);
    const fraction = pointerFraction ?? visual.fraction;
    // The track is inset one pixel; its flat fill edge stays beneath the thumb
    // center instead of introducing a rounded gap beside the white control.
    fill.style.width = `calc(12px + (100% - 24px) * ${fraction})`;
    thumb.style.left = `calc(13px + (100% - 26px) * ${fraction})`;
    strengthTitle.textContent = EFFORT_LABELS[visual.level] || visual.level;
    if (paintedIndex !== visual.index && !reducedMotion()) {
      const direction = visual.index > paintedIndex ? 1 : -1;
      strengthTitle.getAnimations().forEach(animation => animation.cancel());
      strengthTitle.animate([
        { opacity: .35, transform: `translateY(${direction * 5}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    paintedIndex = visual.index;
    pop.dataset.effort = visual.level;
    range.setAttribute('aria-valuetext', EFFORT_LABELS[visual.level] || visual.level);
    [...dots.children].forEach((dot, i) => {
      dot.classList.toggle('filled', i < visual.index);
      dot.classList.toggle('current', i === visual.index);
    });
  };
  paint(selectedIndex);
  range.disabled = levels.length < 2;
  range.addEventListener('input', () => paint(range.value));
  range.addEventListener('change', () => selectEffortLevel(levels[Number(range.value)]));
  let gesture = null;
  const paintPointer = (event) => {
    const track = range.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - track.left - 13) / Math.max(1, track.width - 26)));
    range.value = String(Math.round(fraction * (levels.length - 1)));
    paint(range.value, fraction);
  };
  const finishDragging = (commit = false) => {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    delete slider.dataset.dragging;
    if (!commit) range.value = String(previous.index);
    paint(range.value);
    if (range.hasPointerCapture(previous.pointerId)) range.releasePointerCapture(previous.pointerId);
    if (commit) range.dispatchEvent(new Event('change', { bubbles: true }));
  };
  range.addEventListener('pointerdown', (event) => {
    if (range.disabled || event.button !== 0 || gesture) return;
    // The native range keeps its discrete keyboard semantics. Pointer movement
    // previews continuously, then commits exactly one supported level on release.
    event.preventDefault();
    range.focus({ preventScroll: true });
    gesture = { pointerId: event.pointerId, index: Number(range.value) };
    range.setPointerCapture(event.pointerId);
    slider.dataset.dragging = 'true';
    paintPointer(event);
  });
  range.addEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    paintPointer(event);
    finishDragging(true);
  });
  range.addEventListener('pointercancel', () => finishDragging());
  range.addEventListener('lostpointercapture', () => finishDragging());
  range.addEventListener('blur', () => finishDragging());
  pop.cancelEffortGesture = () => finishDragging();
  const resetDotProximity = () => {
    slider.style.removeProperty('--thumb-proximity');
    [...dots.children].forEach((dot) => dot.style.removeProperty('--dot-scale'));
  };
  range.addEventListener('pointermove', (event) => {
    if (gesture && event.pointerId === gesture.pointerId) paintPointer(event);
    const thumbRect = thumb.getBoundingClientRect();
    const distance = Math.hypot(event.clientX - thumbRect.left - thumbRect.width / 2,
      event.clientY - thumbRect.top - thumbRect.height / 2);
    const proximity = range.disabled ? 0 : Math.max(0, Math.min(1, (20 - distance) / 8));
    slider.style.setProperty('--thumb-proximity', String(proximity));
    if (reducedMotion()) return;
    const dotTrack = dots.getBoundingClientRect();
    const pointerX = event.clientX - dotTrack.left;
    const lastIndex = Math.max(1, levels.length - 1);
    [...dots.children].forEach((dot, index) => {
      const dotX = (index / lastIndex) * dotTrack.width;
      const proximity = Math.max(0, 1 - Math.abs(pointerX - dotX) / 34);
      dot.style.setProperty('--dot-scale', String(1 + proximity * .9));
    });
  });
  range.addEventListener('pointerleave', resetDotProximity);
  range.addEventListener('pointercancel', resetDotProximity);
  slider.addEventListener('click', (e) => e.stopPropagation());
  pop.appendChild(slider);
}

function renderModelPopup() {
  const pop = ensureModelPopup();
  const previousFocus = pop.contains(document.activeElement) ? document.activeElement : null;
  const focusRange = previousFocus && previousFocus.classList.contains('model-effort-range');
  const transition = modelPopupTransition;
  if (modelPopupMorph) { modelPopupMorph.cancel(); modelPopupMorph = null; }
  const previousBounds = pop.classList.contains('show') ? pop.getBoundingClientRect() : null;
  const previousPage = pop.querySelector('.model-menu-page');
  if (previousPage && previousPage.cancelEffortGesture) previousPage.cancelEffortGesture();
  pop.innerHTML = '';
  const page = document.createElement('div');
  page.className = `model-menu-page model-menu-page-${modelPopupTransition}`;
  pop.appendChild(page);
  if (modelPopupPage === 'model') renderModelPopupModels(page);
  else if (modelPopupPage === 'advanced') renderModelPopupAdvanced(page);
  else renderModelPopupRoot(page);
  modelPopupTransition = 'refresh';
  if (pop.classList.contains('show')) {
    positionModelPopup();
    if (previousBounds && (transition === 'forward' || transition === 'back')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const nextBounds = pop.getBoundingClientRect();
      modelPopupMorph = pop.animate([
        { height: `${previousBounds.height}px`, top: `${previousBounds.top}px` },
        { height: `${nextBounds.height}px`, top: `${nextBounds.top}px` },
      ], { duration: 220, easing: 'cubic-bezier(.22,.8,.2,1)' });
    }
    if (previousFocus) {
      const nextFocus = (focusRange && pop.querySelector('.model-effort-range:not(:disabled)'))
        || pop.querySelector('button:not(:disabled)');
      if (nextFocus) nextFocus.focus({ preventScroll: true });
    }
  }
}
function positionModelPopup() {
  if (!modelPopup || !btnModelSwitch) return;
  const gap = 12;
  const anchor = btnModelSwitch.getBoundingClientRect();
  const popupWidth = Math.min(232, Math.max(1, window.innerWidth - gap * 2));
  modelPopup.style.position = 'fixed';
  modelPopup.style.width = `${popupWidth}px`;
  modelPopup.style.maxHeight = `${Math.max(64, window.innerHeight - gap * 2)}px`;
  modelPopup.style.left = `${Math.max(gap, Math.min(anchor.right - popupWidth, window.innerWidth - popupWidth - gap))}px`;
  modelPopup.style.bottom = 'auto';
  const height = modelPopup.offsetHeight;
  const above = anchor.top - height - 10;
  const preferred = above >= gap ? above : anchor.bottom + 10;
  modelPopup.style.top = `${Math.max(gap, Math.min(preferred, window.innerHeight - height - gap))}px`;
}
function showModelPopup({ focus = false } = {}) {
  permissionControls?.close();
  hideSkillQuickPopup();
  modelPopupPage = modelPopupHomePage;
  modelPopupTransition = 'open';
  renderModelPopup();
  const pop = ensureModelPopup();
  pop.classList.add('show');
  positionModelPopup();
  btnModelSwitch.classList.add('open');
  btnModelSwitch.setAttribute('aria-expanded', 'true');
  if (focus) {
    const first = pop.querySelector('.mp-row.selected:not(:disabled), .model-effort-range:not(:disabled)')
      || pop.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
}
function hideModelPopup({ restoreFocus = false } = {}) {
  if (modelPopupMorph) { modelPopupMorph.cancel(); modelPopupMorph = null; }
  if (modelPopup) {
    const page = modelPopup.querySelector('.model-menu-page');
    if (page && page.cancelEffortGesture) page.cancelEffortGesture();
    modelPopup.classList.remove('show');
  }
  btnModelSwitch.classList.remove('open');
  btnModelSwitch.setAttribute('aria-expanded', 'false');
  if (restoreFocus) btnModelSwitch.focus({ preventScroll: true });
}
function handleModelPopupKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideModelPopup({ restoreFocus: true });
    return;
  }
  const controls = [...modelPopup.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
  const index = controls.indexOf(document.activeElement);
  if (event.key === 'Tab') {
    if ((!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0)) {
      // Return to the anchor before the browser advances to the next toolbar
      // control, so this non-modal popover never traps keyboard users.
      hideModelPopup({ restoreFocus: true });
    }
    return;
  }
  if (event.target.matches('input[type="range"]')) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next = controls[(index + offset + controls.length) % controls.length];
    if (next) next.focus({ preventScroll: true });
  }
}

btnModelSwitch.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelPopup && modelPopup.classList.contains('show')) hideModelPopup();
  else showModelPopup();
});
btnModelSwitch.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    showModelPopup({ focus: true });
  }
});
window.addEventListener('resize', () => {
  if (modelPopup && modelPopup.classList.contains('show')) positionModelPopup();
});
document.addEventListener('click', (e) => {
  if (modelPopup && modelPopup.classList.contains('show') &&
      !modelPopup.contains(e.target) && !btnModelSwitch.contains(e.target)) {
    hideModelPopup();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modelPopup && modelPopup.classList.contains('show')) {
    hideModelPopup({ restoreFocus: modelPopup.contains(document.activeElement) });
  }
});

$('btnNewChat').addEventListener('click',     () => startNewConv('plain'));
$('btnNewAnalysis').addEventListener('click', () => openAgentPicker());

// ─── 顶部小工具栏 ───

// ─────────────────────────────────────────
// AI 创作(文生图)视图
// ─────────────────────────────────────────
const chatViewEl   = document.querySelector('main.chat');
const createViewEl  = $('createView');
const btnCreateNav  = $('btnCreate');
let imageConfigLoaded = false;
let imageConfigLoading = null;

// 当前所在视图,用于历史侧边栏高亮哪条会话(避免聊天/创作的 active 互相串台)
let activeView = 'chat';   // chat | create | library | scheduler | settings | plugins
let lastConversationView = 'chat';
const pageScrollPositions = new WeakMap();
let chatWasFollowingOutput = true;

const pendingConversationViewReloads = new Set();

function appViewElements() {
  return { chat: chatViewEl, create: createViewEl, library: $('libraryPage'), scheduler: $('scheduleModal'), settings: $('settingsModal'), plugins: $('pluginsPage') };
}
function syncPageNavigation() {
  document.querySelectorAll('[data-nav-view]').forEach((button) => {
    const selected = button.dataset.navView === activeView;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.history-item').forEach((row) => {
    const id = activeView === 'chat' ? currentConv && currentConv.id
      : activeView === 'create' ? currentCreateConv && currentCreateConv.id : null;
    const selected = !!id && row.dataset.id === id;
    row.classList.toggle('active', selected);
    if (selected) row.setAttribute('aria-current', 'page');
    else row.removeAttribute('aria-current');
  });
}
function showAppView(view, navigationIntent = null) {
  if (navigationIntent != null && navigationIntent !== pageNavigationVersion) return false;
  const views = appViewElements();
  const target = views[view];
  if (!target) return false;
  const previous = views[activeView];
  const changed = view !== activeView;
  const navigationVersion = navigationIntent == null ? ++pageNavigationVersion : navigationIntent;
  if (changed && previous) {
    previous.querySelectorAll('.messages, .workspace-page-body, .modal-body, .set-content, .set-nav, .sv-listbody, .sv-detail-column').forEach((el) => {
      pageScrollPositions.set(el, el.scrollTop);
    });
    if (activeView === 'chat') chatWasFollowingOutput = stickToBottom;
  }
  activeView = view;
  projectComposer?.close();
  if (view === 'chat' || view === 'create') lastConversationView = view;
  Object.entries(views).forEach(([key, el]) => { if (el) el.classList.toggle('hidden', key !== view); });
  const app = document.querySelector('.app');
  app.dataset.view = view;
  app.classList.remove('sidebar-mobile-open');
  if (window.relaySidebarLayout) window.relaySidebarLayout.sync();
  hideModelPopup();
  hideSkillQuickPopup();
  syncPageNavigation();
  window.dispatchEvent(new CustomEvent('relay:view-changed', { detail: { view, previousView: previous && previous.dataset.appView } }));
  if (view === 'chat' && navigationIntent == null) emitConversationChanged(currentConv && currentConv.id);
  if (changed) requestAnimationFrame(() => {
    if (pageNavigationVersion !== navigationVersion || activeView !== view) return;
    target.querySelectorAll('.messages, .workspace-page-body, .modal-body, .set-content, .set-nav, .sv-listbody, .sv-detail-column').forEach((el) => {
      if (pageScrollPositions.has(el)) el.scrollTop = pageScrollPositions.get(el);
    });
    if (view === 'chat') {
      stickToBottom = chatWasFollowingOutput;
      if (stickToBottom) scrollToBottom(true);
      scheduleConversationIndexUpdate();
    }
  });
  return pageNavigationVersion === navigationVersion && activeView === view;
}
function showChatView(navigationIntent = null) { return showAppView('chat', navigationIntent); }
function returnToConversationView() {
  if (lastConversationView === 'chat' && currentConv && pendingConversationViewReloads.has(`chat:${currentConv.id}`)) {
    void loadConversation(currentConv.id, null, { forceReload: true });
    return;
  }
  if (lastConversationView === 'create' && currentCreateConv && pendingConversationViewReloads.has(`create:${currentCreateConv.id}`)) {
    void loadCreateConv(currentCreateConv.id, null, { forceReload: true });
    return;
  }
  showAppView(lastConversationView);
  if (lastConversationView === 'chat') syncRunningUI();
}
function toggleAppSidebar() {
  if (window.relaySidebarLayout) { window.relaySidebarLayout.toggle(); return; }
  const app = document.querySelector('.app');
  app.classList.toggle(window.matchMedia('(max-width: 760px)').matches ? 'sidebar-mobile-open' : 'sidebar-collapsed');
  window.dispatchEvent(new CustomEvent('relay:sidebar-changed'));
}
document.querySelectorAll('[data-toggle-sidebar]').forEach((button) => button.addEventListener('click', toggleAppSidebar));
document.querySelectorAll('[data-return-conversation]').forEach((button) => button.addEventListener('click', returnToConversationView));
syncPageNavigation();
// 仅切到创作视图(不动会话)。fresh=true 时开一个新创作会话并清空消息区。
async function showCreateView(fresh = false, navigationIntent = null) {
  const intent = navigationIntent == null ? ++pageNavigationVersion : navigationIntent;
  if (!showAppView('create', intent)) return false;
  if (!imageConfigLoaded) {
    if (!imageConfigLoading) {
      imageConfigLoading = loadImageModels().then(() => { imageConfigLoaded = true; }).finally(() => { imageConfigLoading = null; });
    }
    await imageConfigLoading;
    if (intent !== pageNavigationVersion || activeView !== 'create') return false;
  }
  if (fresh) {
    newCreateConv();
    cvRefImages = []; cvRenderRef();
    cvMessagesEl.innerHTML = '<div class="welcome"><h2>🎨 AI 创作</h2><p>描述你想要的图片，点「生成」即可。<br/>同一会话里可继续描述，在上一张图基础上调整。</p></div>';
    refreshHistoryList();
  }
  return intent === pageNavigationVersion && activeView === 'create';
}
// 点侧边栏「AI 创作」= 开新创作会话
if (btnCreateNav) btnCreateNav.addEventListener('click', () => showCreateView(true));

// 从历史载入一个创作会话:重建消息流(用户描述气泡 + 结果图网格)
// jumpTo(可选):{ turnIndex } —— 从搜索结果跳转时滚动到命中的那轮提示词并高亮。
async function loadCreateConv(id, jumpTo = null, { forceReload = false } = {}) {
  const navigationIntent = ++pageNavigationVersion;
  const isCurrentNavigation = () => navigationIntent === pageNavigationVersion;
  if (currentCreateConv && currentCreateConv.id === id && !jumpTo && !forceReload && !pendingConversationViewReloads.has(`create:${id}`)) {
    return showCreateView(false, navigationIntent);
  }
  const conv = await window.api.history.load(id);
  if (!conv || !isCurrentNavigation()) return false;
  if (!await showCreateView(false, navigationIntent) || !isCurrentNavigation()) return false;
  currentCreateConv = conv;
  pendingConversationViewReloads.delete(`create:${id}`);
  if (!Array.isArray(currentCreateConv.turns)) currentCreateConv.turns = [];
  cvRefImages = []; cvRenderRef();
  cvMessagesEl.innerHTML = '';
  const running = cvIsRunning(id);
  currentCreateConv.turns.forEach((t, idx) => {
    const um = document.createElement('div');
    um.className = 'message user';
    um.dataset.turn = idx;   // 供搜索跳转定位
    // 该轮若带手动上传的参考图,在提示词气泡上方展示缩略图(文件已删则显示占位)。
    if (Array.isArray(t.refPaths) && t.refPaths.length) um.appendChild(buildImageGrid(t.refPaths));
    const ub = document.createElement('div'); ub.className = 'bubble'; ub.textContent = t.prompt || '';
    um.appendChild(ub); cvMessagesEl.appendChild(um);
    const am = document.createElement('div');
    am.className = 'message assistant cv-result-msg';
    const isLast = idx === currentCreateConv.turns.length - 1;
    if (t.resultPaths && t.resultPaths.length) {
      am.appendChild(buildImageGrid(t.resultPaths, t.prompt));
    } else if (isLast && running) {
      // 该会话正在后台生成,最后一轮还没结果 → 显示 loading(切回来能看到进行中)
      am.classList.add('cv-loading-msg');
      am.innerHTML = '<div class="cv-loading"><div class="cv-spinner"></div><div>正在生成，请稍候…</div></div>';
    } else if (t.error) {
      // 有持久化的失败原因 → 显示具体错误(如内容审核拒绝),而不是笼统的「本轮无结果」
      am.innerHTML = `<div class="cv-error">❌ 生成失败：${escapeHtml(t.error)}</div>`;
    } else {
      am.innerHTML = '<div class="cv-error">（本轮无结果）</div>';
    }
    cvMessagesEl.appendChild(am);
  });
  // 搜索跳转:滚动到命中那轮的提示词并高亮;否则默认停在底部
  let cvJumped = false;
  if (jumpTo && jumpTo.turnIndex != null) {
    const target = cvMessagesEl.querySelector(`.message.user[data-turn="${jumpTo.turnIndex}"]`);
    if (target) {
      cvJumped = true;
      requestAnimationFrame(() => {
        if (!isCurrentNavigation() || currentCreateConv !== conv || activeView !== 'create') return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('search-hit');
        setTimeout(() => target.classList.remove('search-hit'), 2000);
      });
    }
  }
  if (!cvJumped) cvMessagesEl.scrollTop = cvMessagesEl.scrollHeight;
  cvSyncGenerateBtn();
  refreshHistoryList();
  return isCurrentNavigation() && currentCreateConv === conv;
}

// ── 创作页的自定义下拉(与新对话模型切换器同款的 .ms-trigger + .model-popup) ──
//   通用工厂:给一个触发按钮挂一个弹出菜单,菜单项 = { value, label, desc?, icon?, disabled? }。
//   选中后更新触发按钮的图标/文字,并回调。复用聊天那套 .model-popup / .mp-row 样式。
const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L7 20"/></svg>';
// 各模型一句描述(按 name 匹配),让弹出项与新对话同款"图标+标题+副标题"两行结构。描述由后端 IMAGE_MODELS 提供,这里仅作兜底。
// 比例图标:按宽高比画一个描边矩形(豆包风)
function ratioIcon(w, h) {
  const maxW = 18, maxH = 18;
  let rw = maxW, rh = maxH;
  if (w >= h) rh = Math.max(7, Math.round(maxW * h / w)); else rw = Math.max(7, Math.round(maxH * w / h));
  const x = Math.round((22 - rw) / 2), y = Math.round((22 - rh) / 2);
  return `<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="2.5"/></svg>`;
}
// 「比例」触发按钮用的固定图标:裁剪框(crop)样式,比裸矩形好看
const ICON_RATIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v4M6 6H2M6 6v10a2 2 0 0 0 2 2h10M18 22v-4M18 18h4M18 18V8a2 2 0 0 0-2-2H6"/></svg>';
// 画质图标:火花/星亮(连清晰度、品质感)
const ICON_QUALITY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>';

function makeCvDropdown({ trigger, ico, label, getItems, getValue, onSelect, openLeft = true, fixedLabel = '', fixedIcon = '', labelPrefix = '', popupClass = '' }) {
  let pop = null;
  const ensure = () => { if (!pop) { pop = document.createElement('div'); pop.className = 'model-popup' + (popupClass ? ' ' + popupClass : ''); document.body.appendChild(pop); } return pop; };
  const render = () => {
    const p = ensure(); p.innerHTML = '';
    const cur = getValue();
    for (const it of getItems()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mp-row' + (it.value === cur ? ' selected' : '') + (it.disabled ? ' disabled' : '');
      row.innerHTML = `
        ${it.icon ? `<span class="mp-ico">${it.icon}</span>` : ''}
        <span class="mp-meta">
          <span class="mp-title">${escapeHtml(it.label)}</span>
          ${it.desc ? `<span class="mp-desc">${escapeHtml(it.desc)}</span>` : ''}
        </span>
        <svg class="mp-check" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      if (it.disabled) {
        row.addEventListener('click', (e) => e.stopPropagation());   // 不可用项:点了无反应
      } else {
        row.addEventListener('click', (e) => { e.stopPropagation(); onSelect(it); hide(); });
      }
      p.appendChild(row);
    }
  };
  const show = () => {
    render();
    const p = ensure();
    const r = trigger.getBoundingClientRect();
    p.style.position = 'fixed';
    p.style.left = `${openLeft ? r.left : Math.max(8, r.right - 240)}px`;
    p.style.bottom = `${window.innerHeight - r.top + 8}px`;
    p.classList.add('show');
    trigger.classList.add('open');
  };
  const hide = () => { if (pop) pop.classList.remove('show'); trigger.classList.remove('open'); };
  const isOpen = () => !!pop && pop.classList.contains('show');
  trigger.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? hide() : show(); });
  document.addEventListener('click', (e) => { if (isOpen() && !pop.contains(e.target) && !trigger.contains(e.target)) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // 暴露刷新触发按钮显示的方法
  return {
    refresh() {
      const items = getItems();
      const sel = items.find((x) => x.value === getValue()) || items[0];
      trigger.disabled = items.length === 0;
      // fixedIcon:触发按钮固定显示这个图标(不随选中项变);否则用选中项的图标
      if (ico) { if (fixedIcon) ico.innerHTML = fixedIcon; else if (sel && sel.icon) ico.innerHTML = sel.icon; }
      // 触发按钮文字:
      //   fixedLabel  → 始终显示这个固定文字(如未选中时的占位)
      //   labelPrefix → 显示「前缀 + 当前选中值」(豆包式,如「比例 1:1」);无前缀则只显示选中值
      if (label) {
        if (fixedLabel) label.textContent = fixedLabel;
        else if (sel) {
          const val = sel.shortLabel || sel.label;
          label.textContent = labelPrefix ? `${labelPrefix} ${val}` : val;
        } else label.textContent = labelPrefix ? `${labelPrefix} —` : '未配置';
      }
    },
  };
}

// 创作页下拉的状态
let cvModels = [];                       // 从后端拿的模型清单 [{name,label,ok,sizes,qualityKind,qualityTiers,...}]
let cvModelValue = '';
let cvSizeValue = '';
let cvQualityValue = '';                  // 「画质」下拉当前值:分辨率档(豆包 2K/3K/4K、GPT 1K/4K)
let cvResoTables = {};                     // resoKey→「档→[{ratio,value}]」表(后端 image:getConfig 给,如 {doubao:{...}, gpt:{...}})
const cvCountValue = '1';   // 常规生成张数固定为 1(数量下拉已移除)
const CV_GROUP_MAX = 6;      // 组图模式下请求的张数上限(交给模型 auto 决定实际张数,这里给上限)

// 组图触发:不再用手动开关按钮,改成从提示词自动判断(仅豆包支持组图)。
//   命中下列任一意图词就开启 sequential_image_generation:auto,让模型一次出一组关联图。
//   覆盖:组图/连环画/分镜/故事板;带数量量词(≥2,排除"1/一"单数)的"N张/N幅/N步/N个画面";
//   步骤/阶段/流程/分步;系列/一组/一套/多张/多幅/几张;英文 N images/steps、step-by-step、a series/set of、storyboard。
//   设计取向:宁可漏判(用户把话说明确即可),也尽量别误判——量词一律要 ≥2,且对易歧义词(一张纸/步伐/步行)做了排除。
//   N2 = 至少 2 的数量(阿拉伯 [2-9]/两位数,或中文 两/二三四…十),用来挡住"一张/1 image"这种单图。
const CV_GROUP_N2 = '([2-9]\\d*|\\d{2,}|[两二三四五六七八九十]|十[一二三四五六七八九]?)';
const CV_GROUP_PROMPT_RE = new RegExp(
  '组图|连环画|分镜|系列图|故事板|' +
  '[分按]\\s*' + CV_GROUP_N2 + '\\s*(步|张|幅|个|格|帧|画面|部分|阶段)|' +     // 分4步/分四步/按三个阶段
  CV_GROUP_N2 + '\\s*(张|幅)(?!\\s*(的)?(纸|脸|床|嘴|网))|' +                  // ≥2 张/幅 → 多图(排除 一张纸/张嘴)
  CV_GROUP_N2 + '\\s*(个|格|帧)\\s*(图|画面|插画|关联|海报|场景|镜头)|' +        // 3个画面/6格漫画
  CV_GROUP_N2 + '\\s*步(?![伐道行])|' +                                       // 裸"三步/4步"(排除 步伐/步道/步行)
  '(分|按)\\s*(步骤|阶段|流程)|步骤图|流程图解|分步骤|分步图|' +
  '一组|一套|一系列|系列|多张图?|多幅|几张图|连续[^。,，]{0,6}?' + CV_GROUP_N2 + '\\s*张|' +
  '\\b' + CV_GROUP_N2 + '\\s*(images?|pictures?|panels?|frames?|steps?|stages?|illustrations?)\\b|' +
  '\\bstep[\\s-]?by[\\s-]?step\\b|\\ba\\s+series\\s+of\\b|\\ba\\s+set\\s+of\\b|\\bsequence\\s+of\\b|\\bstoryboard\\b|\\bcomic\\s+strip\\b',
  'i'
);
function cvPromptWantsGroup(text) {
  return typeof text === 'string' && CV_GROUP_PROMPT_RE.test(text);
}

// 当前选中模型对象 / 它的可用尺寸(每个模型尺寸不同:豆包要大尺寸,GPT 用常规尺寸)
function cvCurrentModel() { return cvModels.find((m) => m.name === cvModelValue) || cvModels.find((m) => m.ok) || cvModels[0]; }
// 当前可选比例:随【画质档】变 —— 用模型 resoKey 对应的表(gpt/doubao)展开当前档的各比例像素。
function cvCurrentSizes() {
  const m = cvCurrentModel();
  let sizes;
  const table = m && m.resoKey ? cvResoTables[m.resoKey] : null;
  if (table) {
    // 当前档没有则回落到该表第一个档(键序稳定:豆包 2K 先、GPT 1K 先)
    const rows = table[cvQualityValue] || table[Object.keys(table)[0]] || [];
    sizes = rows.map((r) => ({ value: r.value, label: r.ratio, shortLabel: r.ratio, desc: '' }));
  } else {
    sizes = (m && m.sizes) || [];   // 兜底:没有 reso 表的模型用其固定 sizes
  }
  // 给每个尺寸按真实宽高比生成描边矩形图标。不带 desc:比例下拉只显示比例本身(如 16:9),收窄弹窗。
  return sizes.map((s) => {
    const [w, h] = String(s.value).split('x').map(Number);
    return { value: s.value, label: s.label, shortLabel: s.shortLabel || s.label, icon: ratioIcon(w || 1, h || 1) };
  });
}
// 当前模型的画质档列表(给画质下拉用)
function cvCurrentQualityTiers() { const m = cvCurrentModel(); return (m && m.qualityTiers) || []; }
// 模型切换后:把画质重置为该模型默认档,再据此把比例校准到可用集合内。
function cvResetQualityForModel() {
  const m = cvCurrentModel();
  const tiers = (m && m.qualityTiers) || [];
  if (!tiers.find((t) => t.value === cvQualityValue)) {
    cvQualityValue = (m && m.defaultQuality) || (tiers[0] ? tiers[0].value : '');
  }
}
// 把比例重置/校准:换模型或换画质档后,若当前比例值已不在可选集合里,落到第一个。
//   豆包换档时尽量保留同一比例(按 label 找对应新档的像素值),保持用户选的画幅不变。
function cvResetSizeForModel(prevSizeLabel = null) {
  const sizes = cvCurrentSizes();
  if (prevSizeLabel) {
    const same = sizes.find((s) => s.label === prevSizeLabel);
    if (same) { cvSizeValue = same.value; return; }
  }
  if (!sizes.find((s) => s.value === cvSizeValue)) cvSizeValue = sizes[0] ? sizes[0].value : '';
}
// 当前选中比例的 label(如 '16:9'),用于换画质档时保持画幅
function cvCurrentSizeLabel() {
  const s = cvCurrentSizes().find((x) => x.value === cvSizeValue);
  return s ? s.label : null;
}

let cvModelDD, cvSizeDD, cvQualityDD;
function initCvDropdowns() {
  if (cvModelDD) return;   // 只建一次
  cvModelDD = makeCvDropdown({
    trigger: $('cvModelTrigger'), ico: $('cvModelIco'), label: $('cvModelLabel'),
    // 不设 fixedLabel:按钮直接显示当前选中的模型名(如「Seedream 5.0」)
    getItems: () => cvModels.map((m) => {
      // 带参考图时,不支持参考图的模型置灰(豆包/GPT 均支持,故当前不会触发)
      const blockedByRef = cvRefImages.length > 0 && !cvModelSupportsRef(m);
      const disabled = !m.ok || blockedByRef;
      const desc = !m.ok
        ? '待接入'
        : (blockedByRef ? '不支持参考图' : (m.providerName || 'Relay 服务商'));
      return { value: m.name, label: m.label, shortLabel: m.label, desc, icon: ICON_IMAGE, disabled };
    }),
    getValue: () => cvModelValue,
    onSelect: (it) => {
      cvModelValue = it.value;
      cvResetQualityForModel();   // 先定画质档(默认),再据此校准比例
      cvResetSizeForModel();
      cvModelDD.refresh();
      if (cvQualityDD) cvQualityDD.refresh();
      if (cvSizeDD) cvSizeDD.refresh();
    },
  });
  // 画质下拉:切分辨率档(豆包 2K/3K/4K、GPT 1K/4K)。按钮显示「画质 + 当前值」。
  //   档名(1K/4K)本身已自解释,不带副标题说明;弹窗用 mp-narrow 收窄宽度。
  cvQualityDD = makeCvDropdown({
    trigger: $('cvQualityTrigger'), ico: $('cvQualityIco'), label: $('cvQualityLabel'),
    labelPrefix: '画质',
    fixedIcon: ICON_QUALITY,
    popupClass: 'mp-narrow',
    getItems: () => cvCurrentQualityTiers().map((t) => ({ value: t.value, label: t.label, shortLabel: t.label })),
    getValue: () => cvQualityValue,
    onSelect: (it) => {
      const prevLabel = cvCurrentSizeLabel();   // 记住当前画幅(如 16:9)
      cvQualityValue = it.value;
      // 换分辨率档后,比例的像素值要跟着换,且尽量保持同一画幅(16:9 还是 16:9,只是像素升降)
      cvResetSizeForModel(prevLabel);
      if (cvSizeDD) cvSizeDD.refresh();
      cvQualityDD.refresh();
    },
  });
  cvSizeDD = makeCvDropdown({
    trigger: $('cvSizeTrigger'), ico: $('cvSizeIco'), label: $('cvSizeLabel'),
    labelPrefix: '比例',   // 按钮显示「比例 + 当前选中值」(如「比例 1:1」)
    popupClass: 'mp-narrow',   // 只显示比例本身、无描述,弹窗收窄(与画质下拉同款)
    fixedIcon: ICON_RATIO,  // 按钮固定显示裁剪框图标(不随选中比例变成裸矩形)
    getItems: () => cvCurrentSizes(),       // 随当前模型 + 画质档变化
    getValue: () => cvSizeValue,
    onSelect: (it) => { cvSizeValue = it.value; cvSizeDD.refresh(); },
  });
  // 初始显示(固定文字)
  cvModelDD.refresh();
  cvQualityDD.refresh();
  cvSizeDD.refresh();
}

// 载入可选模型(填充模型下拉,默认选第一个可用的,并初始化其画质档与尺寸)
async function loadImageModels() {
  initCvDropdowns();
  let cfg;
  try { cfg = await window.api.image.getConfig(); } catch { cfg = null; }
  cvModels = (cfg && cfg.models) || [];
  cvResoTables = (cfg && cfg.resoTables) || {};
  const firstOk = cvModels.find((m) => m.ok) || cvModels[0];
  if (firstOk && !cvModels.some((model) => model.name === cvModelValue)) cvModelValue = firstOk.name;
  if (!firstOk) cvModelValue = '';
  cvResetQualityForModel();   // 先定画质档(默认),豆包据此展开比例
  cvResetSizeForModel();      // 按当前模型 + 画质档定下默认比例
  if (cvModelDD) cvModelDD.refresh();
  if (cvQualityDD) cvQualityDD.refresh();
  if (cvSizeDD) cvSizeDD.refresh();
  cvSyncGenerateBtn();
}

// 生成按钮
const btnGenerate = $('btnGenerate');
if (btnGenerate) btnGenerate.addEventListener('click', generateImages);
// Ctrl/Cmd+Enter 在 prompt 框里也触发生成
if ($('cvPrompt')) $('cvPrompt').addEventListener('keydown', (e) => {
  // 与新对话一致:Enter 发送,Shift+Enter 换行(输入法组合中的回车不触发)
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented && !e.repeat) { e.preventDefault(); generateImages(); }
});

const cvMessagesEl = $('cvMessages');

// ── 创作会话(进历史 + 单会话上下文迭代) ──
//   currentCreateConv = { id, kind:'create', title, turns:[{prompt, model, size, resultPaths:[], usedRef}], titleGenerated }
//   每轮记录 prompt + 生成结果路径;迭代时自动把上一轮最后一张结果作参考图。
let currentCreateConv = null;

function newCreateConv() {
  currentCreateConv = { id: null, kind: 'create', title: '', turns: [], titleGenerated: false };
}
// 上一轮最后一张结果图的本地路径(用于上下文迭代)
function cvLastResultPath(conv = currentCreateConv) {
  if (!conv || !Array.isArray(conv.turns) || !conv.turns.length) return null;
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if (t.resultPaths && t.resultPaths.length) return t.resultPaths[t.resultPaths.length - 1];
  }
  return null;
}
// 保存创作会话到历史(复用聊天的 history 机制)
async function saveCreateConv(targetConv = currentCreateConv) {
  if (!targetConv) return null;
  const saved = await window.api.history.save(targetConv);
  // await 期间可能已切到另一条创作历史：只更新本次发送时捕获的对象，
  // 绝不用返回的 id/updatedAt 污染新的 currentCreateConv。
  if (saved && saved.id) targetConv.id = saved.id;
  if (saved && saved.updatedAt) targetConv.updatedAt = saved.updatedAt;
  await refreshHistoryList();
  return saved;
}

// ── 参考图:支持多张(多图融合,仅豆包;GPT 编辑只用第一张)。豆包/GPT 都支持参考图,不支持的模型才置灰 ──
let cvRefImages = [];   // [{ name, dataUrl }, ...]
const CV_REF_MAX = 8 * 1024 * 1024;   // 单张 8MB 上限,避免请求体过大
const CV_REF_COUNT_MAX = 14;          // 豆包多图融合最多 14 张参考图

function cvRenderRef() {
  const wrap = $('cvAttachments');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!cvRefImages.length) { wrap.classList.add('hidden'); }
  else {
    wrap.classList.remove('hidden');
    cvRefImages.forEach((ref, idx) => {
      const chip = buildChipEl({ name: ref.name, ext: (ref.name.split('.').pop() || '').toLowerCase(), path: ref.dataUrl });
      const del = document.createElement('button');
      del.className = 'ac-del'; del.textContent = '×'; del.title = '移除参考图';
      del.addEventListener('click', () => { cvRefImages.splice(idx, 1); cvRenderRef(); cvSyncModelForRef(); });
      chip.appendChild(del);
      wrap.appendChild(chip);
    });
  }
  cvSyncModelForRef();
}

// 带参考图时:若当前选中的模型不支持参考图,自动切到第一个支持的模型。
// 现在豆包(图生图)和 GPT(图片编辑)都支持,故一般不会触发切换;保留以防未来加入不支持的模型。
function cvSyncModelForRef() {
  if (!cvRefImages.length) { if (cvModelDD) cvModelDD.refresh(); return; }
  const cur = cvModels.find((m) => m.name === cvModelValue);
  if (cur && !cvModelSupportsRef(cur)) {
    const alt = cvModels.find((m) => m.ok && cvModelSupportsRef(m));
    if (alt) { cvModelValue = alt.name; cvResetSizeForModel(); if (cvSizeDD) cvSizeDD.refresh(); }
  }
  if (cvModelDD) cvModelDD.refresh();
}
function cvResolvedModel(model) {
  if (model && model.adapterId) return model;
  const name = typeof model === 'string' ? model : (model && model.name);
  return cvModels.find((item) => item.name === name) || null;
}
// Relay 当前适配的三个图像模型均支持参考图；能力判断与供应商前缀无关。
function cvModelSupportsRef(model) {
  const resolved = cvResolvedModel(model);
  return !!(resolved && ['gpt-image-2', 'seedream-5.0', 'seedream-4.5'].includes(resolved.adapterId));
}
// 是否支持多图融合(2+ 张参考图):仅豆包。GPT 编辑只取第一张。
function cvModelSupportsMultiRef(model) {
  const resolved = cvResolvedModel(model);
  return !!(resolved && ['seedream-5.0', 'seedream-4.5'].includes(resolved.adapterId));
}

// 读文件为 dataURL(校验是图片 + 大小),追加到参考图数组
function cvLoadRefFromPath(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) { return; }   // 只收图片
  if (file.size && file.size > CV_REF_MAX) { alert('参考图过大(单张上限 8MB)'); return; }
  if (cvRefImages.length >= CV_REF_COUNT_MAX) { alert('参考图最多 ' + CV_REF_COUNT_MAX + ' 张'); return; }
  const reader = new FileReader();
  reader.onload = () => { cvRefImages.push({ name: file.name, dataUrl: reader.result }); cvRenderRef(); };
  reader.readAsDataURL(file);
}

// 点击 + 选图(支持多选;用浏览器原生文件选择,直接拿 File 读 dataURL,避免再走主进程读路径)
if ($('cvBtnAttach')) $('cvBtnAttach').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.onchange = () => { if (inp.files) Array.from(inp.files).forEach((f) => cvLoadRefFromPath(f)); };
  inp.click();
});


// 拖拽参考图到创作输入卡
const cvInputCardEl = $('cvInputCard');
if (cvInputCardEl) {
  ['dragenter', 'dragover'].forEach((ev) => cvInputCardEl.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    cvInputCardEl.classList.add('drag-over');
  }));
  cvInputCardEl.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.relatedTarget && cvInputCardEl.contains(e.relatedTarget)) return;
    cvInputCardEl.classList.remove('drag-over');
  });
  cvInputCardEl.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    cvInputCardEl.classList.remove('drag-over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) Array.from(files).forEach((f) => cvLoadRefFromPath(f));
  });
  // 粘贴截图作参考图:创作侧本就按 dataURL 走(cvRefImages),直接喂 cvLoadRefFromPath 即可。
  //   仅需给剪贴板图片补一个带扩展名的文件名(否则 cvLoadRefFromPath 的图片扩展名校验会拦掉)。
  //   兜底同对话框:DOM 取不到 file 项时,从原生剪贴板读 PNG dataURL 转成 File。
  const cvPromptEl = $('cvPrompt');
  if (cvPromptEl) cvPromptEl.addEventListener('paste', async (e) => {
    const imgs = imagesFromClipboard(e);
    if (!imgs.length) {
      let nativeUrl = null;
      try { const r = await window.api.image.readClipboardImage(); if (r && r.ok && r.dataUrl) nativeUrl = r.dataUrl; } catch (_) {}
      if (!nativeUrl) return;
      e.preventDefault();
      try { cvLoadRefFromPath(dataUrlToFile(nativeUrl, '粘贴的图片.png')); } catch (_) {}
      return;
    }
    e.preventDefault();
    imgs.forEach((file) => {
      const named = (file.name && /\.[a-z0-9]+$/i.test(file.name))
        ? file
        : new File([file], `粘贴的图片.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: file.type });
      cvLoadRefFromPath(named);
    });
  });
}

// 进行中的创作生成任务在通用运行态区声明。支持后台生成 + 多会话并发。
function cvIsRunning(convId) { return convId != null && cvJobs.has(convId); }

// 同步生成按钮的禁用态:仅当"当前所看的创作会话"正在生成时才禁用
function cvSyncGenerateBtn() {
  if (!btnGenerate) return;
  const cur = currentCreateConv && currentCreateConv.id;
  btnGenerate.disabled = !cvModels.length || cvIsRunning(cur);
  btnGenerate.title = cvModels.length ? '' : '请先在设置的服务商中获取图像模型';
}

async function generateImages() {
  const promptEl = $('cvPrompt');
  const prompt = (promptEl.value || '').trim();
  if (!prompt) { promptEl.focus(); return; }
  if (!cvModels.length || !cvModelValue) {
    showToast('未发现图像模型，请在“设置 → 服务商”中获取模型');
    return;
  }
  const model = cvModelValue;
  const size  = cvSizeValue;
  const n     = cvCountValue;

  if (!currentCreateConv) newCreateConv();   // 没有会话则新建
  // 同一会话正在生成时,不重复提交(不同会话可并发)
  if (currentCreateConv.id && cvIsRunning(currentCreateConv.id)) return;
  // 从第一个 await 之前就捕获本轮归属。保存参考图、读取上一张、写历史和
  // 生成 IPC 都可能耗时，期间用户可以任意切换创作历史，不能再读 currentCreateConv。
  const sentConv = currentCreateConv;
  const manualRefs = cvRefImages.map((ref) => ({ ...ref }));
  const automaticRefPath = cvLastResultPath(sentConv);
  const isViewingSentConv = () => activeView === 'create' && currentCreateConv === sentConv;

  // 参考图在点击发送时就由本轮消费。若等 await 后再清理，会误删切到新会话后新上传的图。
  cvRefImages = [];
  cvRenderRef();
  promptEl.value = '';
  autoGrowCvPrompt();

  // 清掉欢迎页
  const welcome = isViewingSentConv() ? cvMessagesEl.querySelector('.welcome') : null;
  if (welcome) welcome.remove();

  // 用户手动上传的参考图:先落盘拿到本地路径(用于在气泡上方展示 + 持久化到历史)。
  //   只针对手动上传的图;下面"自动取上一张结果当参考"那种隐式上下文不在此展示。
  //   落盘失败不阻断生成,顶多这条不显示参考图缩略。
  const manualRefDataUrls = manualRefs.map((r) => r.dataUrl);
  const refPaths = [];
  for (const du of manualRefDataUrls) {
    try { const r = await window.api.image.saveRef({ dataUrl: du }); if (r && r.ok && r.path) refPaths.push(r.path); }
    catch (_) {}
  }

  // 组图意图:从提示词自动判断(仅豆包支持组图)。命中即一次出一组关联图。
  //   一旦判为组图,就视作"新起一组系列",不再走"基于上一张迭代"那条参考图逻辑(下面据此跳过自动取上一张)。
  const wantsGroup = cvPromptWantsGroup(prompt) && cvModelSupportsMultiRef({ name: model });

  // 2) loading 占位(挂一个稳定标记,回填/重渲染时能找回)
  //   组图优先级最高;否则若在基于上一张迭代则显示"调整中";再否则普通"生成 N 张"。
  const iterating = !wantsGroup && !manualRefs.length && !!automaticRefPath && cvModelSupportsRef({ name: model });
  let loadingMsg = null;
  if (isViewingSentConv()) {
    // 1) 用户气泡(若有手动参考图,先在气泡上方展示缩略图,与普通对话上传图一致)
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    if (refPaths.length) userMsg.appendChild(buildImageGrid(refPaths));
    const ub = document.createElement('div');
    ub.className = 'bubble';
    ub.textContent = prompt;
    userMsg.appendChild(ub);
    cvMessagesEl.appendChild(userMsg);

    // 2) loading 占位。只能插入提交时那条会话的 DOM，切换后由 loadCreateConv 按账本重建。
    loadingMsg = document.createElement('div');
    loadingMsg.className = 'message assistant cv-result-msg cv-loading-msg';
    const loadingText = wantsGroup ? '正在生成一组图片，请稍候…' : (iterating ? '正在基于上一张图调整…' : '正在生成 ' + n + ' 张图片，请稍候…');
    loadingMsg.innerHTML = `<div class="cv-loading"><div class="cv-spinner"></div><div>${loadingText}</div></div>`;
    cvMessagesEl.appendChild(loadingMsg);
    cvMessagesEl.scrollTop = cvMessagesEl.scrollHeight;
  }

  // 决定参考图:① 用户手动上传的优先(支持多张,豆包多图融合);② 否则同会话上下文迭代——自动拿上一张结果
  //   多图仅豆包支持;若当前模型不支持多图(GPT),只取第一张。
  let refList = manualRefs.map((r) => r.dataUrl);
  if (refList.length > 1 && !cvModelSupportsMultiRef({ name: model })) refList = refList.slice(0, 1);
  let usedRef = refList.length > 0;
  // 组图模式下不自动取上一张结果作参考(组图是"新起一组系列",非"改上一张")。
  //   用户若手动上传了参考图则尊重(refList 已非空,上面不会进这里)。
  if (!wantsGroup && !refList.length && cvModelSupportsRef({ name: model })) {
    if (automaticRefPath) {
      try { const r = await window.api.image.toDataUrl(automaticRefPath); if (r && r.ok) { refList = [r.dataUrl]; usedRef = true; } } catch (_) {}
    }
  }
  // 传给后端:0 张→不传;1 张→string;多张→array
  const refImage = refList.length === 0 ? null : (refList.length === 1 ? refList[0] : refList);

  // 与新对话一致:提交即先把本轮(空结果占位)写入会话并入历史侧边栏
  //   refPaths:手动上传的参考图本地路径,持久化以便历史重载时仍能展示(只存路径不存 base64)。
  const runId = newClientRunId();
  const turn = { prompt, model, size, resultPaths: [], usedRef, refPaths, runId };
  sentConv.turns.push(turn);
  const isFirstTurn = sentConv.turns.length === 1;
  if (!sentConv.title) sentConv.title = truncateByWidth(prompt, 64);
  await saveCreateConv(sentConv);
  if (isFirstTurn && !sentConv.titleGenerated) void maybeTitleCreateConv(prompt, sentConv);

  // 标记本会话进入"生成中"(支持后台:即便用户切走,任务继续,完成后按 id 写回)
  const convId = sentConv.id;
  const turnIndex = sentConv.turns.length - 1;   // 本轮在 turns 里的下标(用于按 id+下标 回填,避免对象引用失效)
  cvJobs.set(convId, { runId, turnIndex, restored: false });
  cvSyncGenerateBtn();
  refreshHistoryList();   // 侧边栏给这个会话亮起 running 指示

  // 组图开关 = 上面据提示词自动判断的 wantsGroup(仅豆包)。把张数上限提到 CV_GROUP_MAX
  //   (实际张数由模型 sequential auto 决定);常规仍为 n(=1)。
  const effN = wantsGroup ? CV_GROUP_MAX : n;
  // 画质(分辨率档)已经体现在 size 像素值里:豆包直接用大尺寸,GPT 由后端按 size 反推 quality。
  //   故这里只传 size,不再单独传 quality。
  let res;
  try {
    res = await window.api.image.generate({
      prompt, model, size, n: effN, image: refImage, sequential: wantsGroup,
      runId, conversationId: convId, turnIndex,
    });
  }
  catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }

  const tracked = cvJobs.get(convId);
  if (!tracked || !tracked.runId || tracked.runId === runId) cvJobs.delete(convId);

  // 回填结果到对应会话并落盘(按 id + 下标 找回,即便期间被 loadCreateConv 换了对象/用户切走也写对)
  await cvFinishTurn(convId, turnIndex, prompt, res, loadingMsg);
}

// 回填本轮结果:始终从【磁盘真相】按 id 读回该会话,写第 turnIndex 轮的 resultPaths,再存。
//   关键:不依赖 turn 对象引用(loadCreateConv 会用磁盘新对象替换 currentCreateConv,旧引用会失效)。
async function cvFinishTurn(convId, turnIndex, prompt, res, loadingNode) {
  const resultPaths = (res && res.ok && res.paths) ? res.paths : [];
  // 失败原因:持久化到 turn.error,这样切走再切回(从历史重渲染)也能看到具体为什么没出图,
  //   而不是只显示笼统的「本轮无结果」。成功则清空该字段。
  const errMsg = (!res || !res.ok) ? ((res && res.error) || '未知错误') : '';
  try {
    const conv = await window.api.history.load(convId);
    if (conv && Array.isArray(conv.turns) && conv.turns[turnIndex]) {
      conv.turns[turnIndex].resultPaths = resultPaths;
      conv.turns[turnIndex].error = errMsg || undefined;
      await window.api.history.save(conv);
      // 若该会话正是当前内存里这个,把结果也同步进内存对象(保持一致)
      if (currentCreateConv && currentCreateConv.id === convId && currentCreateConv.turns[turnIndex]) {
        currentCreateConv.turns[turnIndex].resultPaths = resultPaths;
        currentCreateConv.turns[turnIndex].error = errMsg || undefined;
      }
    }
  } catch (_) {}

  // 更新当前视图里的 loading 节点(仅当用户还在看这个会话且该节点还在 DOM 里)
  const viewingThis = activeView === 'create' && currentCreateConv && currentCreateConv.id === convId;
  if (viewingThis && loadingNode && loadingNode.isConnected) {
    loadingNode.classList.remove('cv-loading-msg');
    if (!res || !res.ok) {
      loadingNode.innerHTML = `<div class="cv-error">❌ 生成失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
    } else {
      loadingNode.innerHTML = '';
      loadingNode.appendChild(buildImageGrid(res.paths, prompt));
    }
    cvMessagesEl.scrollTop = cvMessagesEl.scrollHeight;
  } else if (viewingThis && (!loadingNode || !loadingNode.isConnected)) {
    // loading 节点已被 loadCreateConv 重建过(切走又切回)→ 直接重渲染该会话,显示最新结果
    await loadCreateConv(convId, null, { forceReload: true });
  } else if (currentCreateConv && currentCreateConv.id === convId) {
    pendingConversationViewReloads.add(`create:${convId}`);
  }

  cvSyncGenerateBtn();
  refreshHistoryList();   // 关掉侧边栏 running 指示
}

// 给创作会话生成简短标题(复用聊天的快模型摘要)。按 id 找回写入,避免切走后写错。
async function maybeTitleCreateConv(firstPrompt, targetConv = currentCreateConv) {
  if (!targetConv || targetConv.titleGenerated) return;
  targetConv.titleGenerated = true;
  const convId = targetConv.id;
  try {
    const res = await window.api.summarizeTitle('用户想生成的图片:' + firstPrompt);
    const t = (res && res.title || '').trim();
    if (!t) return;
    // 始终从磁盘读回再只改 title 字段后存盘,避免与结果回填(cvFinishTurn)互相覆盖
    const conv = await window.api.history.load(convId);
    if (conv && !conv.titleManual) {   // 等待摘要期间用户手动重命名了 → 手动命名优先
      conv.title = t; conv.titleGenerated = true;
      await window.api.history.save(conv);
      targetConv.title = t;
      if (currentCreateConv && currentCreateConv.id === convId) {
        currentCreateConv.title = t;  // 只同步同一条会话，不依赖等待期间的全局指针
        currentCreateConv.titleGenerated = true;
      }
      await refreshHistoryList();
    }
  } catch (_) {}
}

// 收集"当前对话里所有结果图"(跨所有轮次,按 DOM 顺序)。用于大图查看器在整段会话内翻页。
//   clickedImg:被点的那个 <img>。返回 { paths:[...], index } ;若不在对话消息区内(如「我的创作」弹窗)返回 null,让调用方退回只翻本组。
function collectConversationImages(clickedImg) {
  const container = clickedImg.closest('.messages');   // 聊天 #messages / 创作 #cvMessages 都用 .messages
  if (!container) return null;
  // 只取带 imgPath 的结果图,保持 img 元素与路径一一对应(下标不错位)
  const imgs = Array.from(container.querySelectorAll('.cv-cell img')).filter((el) => el.dataset.imgPath);
  if (imgs.length <= 1) return null;   // 只有一张,无需跨会话,退回本组逻辑即可
  const paths = imgs.map((el) => el.dataset.imgPath);
  const index = Math.max(0, imgs.indexOf(clickedImg));
  return { paths, index };
}

// 构造图片网格元素(点击放大 / 右键复制图片)。返回 DOM,调用方自行插入。
function buildImageGrid(paths, caption) {
  const grid = document.createElement('div');
  grid.className = 'cv-grid';
  for (const p of paths) {
    const cell = document.createElement('div');
    cell.className = 'cv-cell';
    const img = document.createElement('img');
    // 优化:① 去掉 ?t=Date.now() 防缓存 —— 生成图文件名唯一(img-时间戳-序号.png),
    //   绝无同名覆盖,按路径走浏览器缓存即可,再打开资料库秒出(此前每次都重读+重解码全部原图,卡顿主因)。
    //   ② loading=lazy:视口外的图滚到才加载;③ decoding=async:异步解码,不阻塞主线程。
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = toFileUrl(p);
    img.alt = caption || '';
    img.title = '点击查看大图 · 右键复制图片';
    img.dataset.imgPath = p;
    // 兜底:图片文件已被删除(比如在「我的创作」里删了,但历史对话还留着这条记录)→
    //   图片加载失败时,把这个格子换成一个干净的「图片已删除」占位,而不是浏览器默认的破图标。
    img.addEventListener('error', () => {
      cell.classList.add('cv-cell-missing');
      cell.innerHTML = `
        <div class="cv-missing">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/><line x1="3" y1="3" x2="21" y2="21"/></svg>
          <span>图片已删除</span>
        </div>`;
    });
    // 点击放大:在对话里跨整段会话的所有图片间切换(不止本轮);其它场景(我的创作弹窗)退回本组。
    img.addEventListener('click', () => {
      const conv = collectConversationImages(img);   // { paths, index } 或 null
      if (conv) openImageViewer(conv.paths, conv.index);
      else      openImageViewer(paths, paths.indexOf(p));
    });
    cell.appendChild(img);
    grid.appendChild(cell);
  }
  return grid;
}

// 大图查看器(点遮罩关闭;多图时左右箭头切换上一张/下一张,支持 ←/→/Esc 键)
//   list:同一组图片的路径数组;start:点开时的序号。也兼容只传单个路径字符串。
function openImageViewer(list, start = 0) {
  const paths = Array.isArray(list) ? list : [list];
  if (!paths.length) return;
  let idx = Math.max(0, Math.min(start, paths.length - 1));
  const multi = paths.length > 1;

  const overlay = document.createElement('div');
  overlay.className = 'cv-viewer';
  // 箭头/关闭都用与整体一致的描边图标(viewBox 24,stroke currentColor,2px 圆角端点)
  overlay.innerHTML = `
    <button class="cv-viewer-nav cv-viewer-prev" title="上一张 (←)" ${multi ? '' : 'hidden'}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <img src="" alt="" />
    <button class="cv-viewer-nav cv-viewer-next" title="下一张 (→)" ${multi ? '' : 'hidden'}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
    </button>
    <button class="cv-viewer-close" title="关闭 (Esc)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    ${multi ? '<div class="cv-viewer-count"></div>' : ''}
  `;
  const imgEl = overlay.querySelector('img');
  const countEl = overlay.querySelector('.cv-viewer-count');
  const show = () => {
    const p = paths[idx];
    imgEl.src = toFileUrl(p);
    imgEl.dataset.imgPath = p;   // 右键复制取当前这张
    if (countEl) countEl.textContent = `${idx + 1} / ${paths.length}`;
  };
  const go = (delta) => { idx = (idx + delta + paths.length) % paths.length; show(); };   // 循环切换

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    // 用捕获阶段 + stopImmediatePropagation:Esc 只关查看器,不冒泡去关下面的「我的创作」弹窗
    if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); }
    else if (multi && e.key === 'ArrowLeft')  { e.preventDefault(); go(-1); }
    else if (multi && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  };

  // 点遮罩空白处关闭;点图片/箭头/关闭按钮各自处理,不冒泡到遮罩
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  imgEl.addEventListener('click', (e) => e.stopPropagation());
  overlay.querySelector('.cv-viewer-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  if (multi) {
    overlay.querySelector('.cv-viewer-prev').addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
    overlay.querySelector('.cv-viewer-next').addEventListener('click', (e) => { e.stopPropagation(); go(1); });
  }
  document.addEventListener('keydown', onKey, true);   // 捕获阶段,先于「我的创作」的 Esc 处理

  show();
  document.body.appendChild(overlay);
}

// prompt 框自适应高度
function autoGrowCvPrompt() {
  const t = $('cvPrompt');
  if (!t) return;
  t.style.height = 'auto';
  const max = 280;
  const full = t.scrollHeight;
  t.style.height = Math.min(full, max) + 'px';
  // 与新对话输入框一致:超过最大高度才显示滚动条,否则隐藏(否则内容被裁、滚动条也不出现)
  t.style.overflowY = full > max ? 'auto' : 'hidden';
}
if ($('cvPrompt')) $('cvPrompt').addEventListener('input', autoGrowCvPrompt);

// ── 资料库主页面：真实本地资料，挂载后保留页面与查询状态 ──
let myWorkEl = null;
const libState = { fileType: 'all', fileView: 'grid', query: '', renderKey: null, searchTimer: null };
const libSources = {
  images: { items: null, error: '', loading: false, request: 0, loadedAt: 0, promise: null },
  files: { items: null, error: '', loading: false, request: 0, loadedAt: 0, promise: null },
};
const LIB_TYPES = [['all', '全部'], ['document', '文档'], ['image', '图片'], ['spreadsheet', '表格'], ['presentation', '演示文稿'], ['pdf', 'PDF'], ['code', '代码'], ['other', '其他']];
const LIB_FILE_ICONS = {
  document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  spreadsheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  presentation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M9 20h6"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L7 20"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6 6 6-6 6M8 6l-6 6 6 6"/></svg>',
};
const LIB_UI_ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-1l3 3M4 15l3 3a7 7 0 0 0 11-1"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
};
function libFileIcon(type) { return LIB_FILE_ICONS[type] || LIB_FILE_ICONS.document; }
function libFmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function libFmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms); if (isNaN(d)) return '';
  const today = new Date();
  const date = d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return date;
}
function libPathKey(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}
function normalizeLibraryItems(items, source) {
  return (Array.isArray(items) ? items : []).filter(item => item && typeof item.path === 'string' && item.path.trim()).map(item => {
    const name = typeof item.name === 'string' && item.name ? item.name : item.path.split(/[\\/]/).pop();
    const ext = String(item.ext || (name.includes('.') ? name.split('.').pop() : '')).toLowerCase();
    const type = source === 'images' || /^(png|jpe?g|webp|gif|bmp|svg)$/.test(ext) ? 'image' : LIB_TYPES.some(([value]) => value === item.type) ? item.type : 'other';
    return { path: item.path, name, ext, type, mtime: Number(item.mtime) || 0, size: Number.isFinite(item.size) ? item.size : null, generatedImage: source === 'images' };
  });
}
function libraryItems() {
  const byPath = new Map();
  // 图片库提供明确的生成图身份；重复文件保留这一身份，删除时使用原图片接口。
  for (const kind of ['files', 'images']) {
    for (const item of libSources[kind].items || []) byPath.set(libPathKey(item.path), item);
  }
  return [...byPath.values()].sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}
function filteredLibraryItems() {
  const query = libState.query.trim().toLocaleLowerCase();
  return libraryItems().filter(item => (libState.fileType === 'all' || item.type === libState.fileType)
    && (!query || `${item.name}\n${item.path}`.toLocaleLowerCase().includes(query)));
}
function mountLibraryPage() {
  if (myWorkEl) return true;
  const host = $('libraryPageBody');
  if (!host) { showToast('资料库页面暂不可用'); return false; }
  myWorkEl = document.createElement('section');
  myWorkEl.className = 'libp-content';
  myWorkEl.innerHTML = `
    <div class="libp-head"><div><h1>资料库</h1><p>集中查看本地文件与生成的图片。</p></div><span class="libp-total" aria-live="polite"></span></div>
    <div class="libp-toolbar"><div class="libp-filters" role="group" aria-label="资料类型">${LIB_TYPES.map(([type, label]) => `<button type="button" data-lib-filter="${type}" aria-pressed="${type === libState.fileType}">${label}</button>`).join('')}</div>
      <label class="libp-search">${LIB_UI_ICONS.search}<input type="search" placeholder="搜索资料" aria-label="搜索资料" autocomplete="off" spellcheck="false"></label>
    </div>
    <div class="libp-section-head"><h2>最近修改</h2><div class="libp-tools">
      <button type="button" class="libp-folder" data-lib-folder title="打开图片文件夹">${LIB_UI_ICONS.folder}<span>图片文件夹</span></button>
      <button type="button" class="libp-icon-button" data-lib-refresh title="刷新资料库" aria-label="刷新资料库">${LIB_UI_ICONS.refresh}</button>
      <div class="libp-view-toggle" role="group" aria-label="资料布局"><button type="button" class="libp-icon-button" data-lib-view="grid" title="网格视图" aria-label="网格视图">${LIB_UI_ICONS.grid}</button><button type="button" class="libp-icon-button" data-lib-view="list" title="列表视图" aria-label="列表视图">${LIB_UI_ICONS.list}</button></div>
    </div></div>
    <div class="libp-status" role="status" aria-live="polite" hidden></div>
    <div class="libp-results" aria-label="资料列表"></div>
    <p class="libp-footnote">图片可点击放大，文件将使用默认应用打开。</p>`;
  host.appendChild(myWorkEl);
  if (typeof bindTransientScrollbar === 'function') bindTransientScrollbar(host);
  myWorkEl.addEventListener('click', event => {
    const filter = event.target.closest('[data-lib-filter]');
    if (filter) { libState.fileType = filter.dataset.libFilter; renderLibrary(); host.scrollTop = 0; return; }
    const view = event.target.closest('[data-lib-view]');
    if (view) { libState.fileView = view.dataset.libView; renderLibrary(); return; }
    if (event.target.closest('[data-lib-refresh]')) { refreshLibrary({ force: true }); return; }
    const retry = event.target.closest('[data-lib-retry]');
    if (retry) { loadLibrarySource(retry.dataset.libRetry, true); return; }
    if (event.target.closest('[data-lib-clear]')) {
      libState.query = ''; libState.fileType = 'all'; myWorkEl.querySelector('.libp-search input').value = ''; renderLibrary(); return;
    }
    if (event.target.closest('[data-lib-folder]')) {
      Promise.resolve().then(() => window.api.library.openImagesDir()).then(result => {
        if (!result || !result.ok) showToast('打开文件夹失败' + (result && result.error ? '：' + result.error : ''));
      }).catch(error => showToast('打开文件夹失败：' + error.message));
    }
  });
  myWorkEl.querySelector('.libp-search input').addEventListener('input', event => {
    libState.query = event.target.value;
    clearTimeout(libState.searchTimer);
    libState.searchTimer = setTimeout(() => { libState.searchTimer = null; renderLibrary(); host.scrollTop = 0; }, 100);
  });
  renderLibrary();
  return true;
}
async function openMyWork() {
  if (!mountLibraryPage()) return;
  showAppView('library');
  // 返回页面不销毁 DOM；一分钟后在已有内容上温和刷新，手动刷新始终可用。
  await refreshLibrary();
}
function loadLibrarySource(kind, force = false) {
  const source = libSources[kind];
  if (!source) return Promise.resolve();
  if (!force && source.promise) return source.promise;
  if (!force && source.items && Date.now() - source.loadedAt < 60000) return Promise.resolve();
  const request = ++source.request;
  source.loading = true; source.error = '';
  renderLibrary();
  const method = kind === 'images' ? 'listImages' : 'listFiles';
  const pending = Promise.resolve().then(() => window.api.library[method]()).then(result => {
    if (request !== source.request) return;
    if (!result || !result.ok) throw new Error(result && result.error ? result.error : '未能读取本地资料');
    source.items = normalizeLibraryItems(result.items, kind);
    source.loadedAt = Date.now();
  }).catch(error => {
    if (request === source.request) source.error = error && error.message ? error.message : '读取失败';
  }).finally(() => {
    if (request !== source.request) return;
    source.loading = false; source.promise = null;
    renderLibrary();
  });
  source.promise = pending;
  return pending;
}
function refreshLibrary({ force = false } = {}) {
  return Promise.all(['images', 'files'].map(kind => loadLibrarySource(kind, force)));
}
function renderLibrary() {
  if (!myWorkEl) return;
  const host = $('libraryPageBody');
  const scrollTop = host ? host.scrollTop : 0;
  const items = filteredLibraryItems();
  const required = libState.fileType === 'all' || libState.fileType === 'image' ? ['images', 'files'] : ['files'];
  const loading = required.some(kind => libSources[kind].loading);
  const pending = required.some(kind => libSources[kind].items === null && !libSources[kind].error);
  const errors = required.filter(kind => libSources[kind].error);
  const total = libraryItems().length;
  const partial = Object.values(libSources).some(source => source.error || source.items === null);
  myWorkEl.querySelector('.libp-total').textContent = total ? `${partial ? '已载入 ' : ''}${total} 项资料` : '';
  myWorkEl.querySelector('.libp-section-head h2').textContent = libState.query.trim() || libState.fileType !== 'all' ? `${items.length} 项匹配资料` : '最近修改';
  myWorkEl.querySelectorAll('[data-lib-filter]').forEach(button => {
    const selected = button.dataset.libFilter === libState.fileType;
    button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  myWorkEl.querySelectorAll('[data-lib-view]').forEach(button => {
    const selected = button.dataset.libView === libState.fileView;
    button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  const refresh = myWorkEl.querySelector('[data-lib-refresh]');
  const anyLoading = Object.values(libSources).some(source => source.loading);
  refresh.disabled = anyLoading; refresh.classList.toggle('is-loading', anyLoading);
  refresh.title = anyLoading ? '正在刷新资料库' : '刷新资料库';
  const status = myWorkEl.querySelector('.libp-status');
  const showLoading = loading && !items.length;
  status.hidden = !errors.length && !showLoading;
  status.innerHTML = errors.length ? errors.map(kind => `<div class="libp-error"><span>${kind === 'images' ? '图片' : '文件'}暂时无法载入${libSources[kind].items ? '，已保留上次结果' : ''}。</span><button type="button" data-lib-retry="${kind}">重试</button></div>`).join('') : showLoading ? '<span>正在更新资料…</span>' : '';
  const body = myWorkEl.querySelector('.libp-results');
  body.setAttribute('aria-busy', String(loading));
  // 元数据未变化时保留资料卡片节点、图片解码结果与页面滚动位置。
  const key = JSON.stringify([libState.fileView, libState.fileType, libState.query, items.map(item => [item.path, item.name, item.type, item.ext, item.mtime, item.size, item.generatedImage]), items.length ? '' : [pending, errors.length]]);
  if (key !== libState.renderKey) {
    libState.renderKey = key;
    if (items.length) body.replaceChildren(libState.fileView === 'grid' ? buildLibFileGrid(items) : buildLibFileList(items));
    else {
      const filtered = Boolean(libState.query.trim()) || libState.fileType !== 'all';
      const title = pending ? '正在载入资料' : errors.length ? '资料暂时无法载入' : filtered ? '没有找到匹配的资料' : '还没有本地资料';
      const detail = pending ? '图片和文件会在这里汇总。' : errors.length ? '请使用上方的重试按钮，再试一次。' : filtered ? '试试其他关键词，或查看全部类型。' : '生成图片或在对话中保存文件后，可以在这里查看。';
      body.innerHTML = `<div class="libp-empty">${LIB_UI_ICONS.folder}<h3>${title}</h3><p>${detail}</p>${filtered && !pending ? '<button type="button" data-lib-clear>清除筛选</button>' : ''}</div>`;
    }
  }
  if (host) host.scrollTop = scrollTop;
}
async function openLibraryFile(item) {
  try {
    const result = await window.api.library.openFile(item.path);
    if (!result || !result.ok) showToast('打开失败' + (result && result.error ? '：' + result.error : ''));
  } catch (error) { showToast('打开失败：' + error.message); }
}
function openLibraryItem(item, items) {
  if (item.type === 'image') {
    const paths = items.filter(candidate => candidate.type === 'image').map(candidate => candidate.path);
    openImageViewer(paths, Math.max(0, paths.indexOf(item.path)));
  } else openLibraryFile(item);
}
async function deleteLibraryItem(item) {
  const image = item.type === 'image';
  const confirmed = await customConfirm({ title: image ? '删除图片' : '删除文件',
    message: `将删除本地${image ? '图片' : '文件'}「${item.name}」，无法恢复。确定删除吗？`,
    confirmText: '删除', cancelText: '取消', danger: true });
  if (!confirmed) return;
  try {
    const result = item.generatedImage ? await window.api.image.deleteSaved(item.path) : await window.api.library.deleteFile(item.path);
    if (!result || !result.ok) { showToast('删除失败' + (result && result.error ? '：' + result.error : '')); return; }
    const interrupted = Object.keys(libSources).filter(kind => libSources[kind].loading);
    for (const source of Object.values(libSources)) {
      // 作废删除之前的列表请求，防止旧快照随后把文件重新放回页面。
      source.request++; source.loading = false; source.promise = null;
      if (source.items) source.items = source.items.filter(candidate => libPathKey(candidate.path) !== libPathKey(item.path));
    }
    renderLibrary(); showToast('已删除');
    // 若删除打断了首次加载，重新读取该源，不能留下永远等待的空列表。
    for (const kind of interrupted) loadLibrarySource(kind, true);
  } catch (error) { showToast('删除失败：' + error.message); }
}
function showLibFileMenu(event, item) {
  event.preventDefault(); event.stopPropagation();
  const pop = ensureCopyPopover();
  const copyBtn = pop.querySelector('.cp-btn:not(.cp-del)');
  const delBtn = pop.querySelector('.cp-del');
  const image = item.type === 'image';
  copyBtn.querySelector('span').textContent = image ? '复制图片' : '打开';
  const kbd = copyBtn.querySelector('kbd'); if (kbd) kbd.style.display = 'none';
  copyBtn.onclick = async () => {
    hideCopyPopover();
    if (!image) { openLibraryFile(item); return; }
    try { await copyImageToClipboard(toFileUrl(item.path)); showToast('图片已复制'); }
    catch (error) { showToast('复制失败：' + error.message); }
  };
  delBtn.hidden = false;
  delBtn.onclick = () => { hideCopyPopover(); deleteLibraryItem(item); };
  const anchor = event.currentTarget && event.currentTarget.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : null;
  const x = event.clientX || (anchor ? anchor.right : 12);
  const y = event.clientY || (anchor ? anchor.bottom : 12);
  pop.style.left = Math.max(8, Math.min(x, window.innerWidth - 156)) + 'px';
  pop.style.top = Math.max(8, y + 84 > window.innerHeight ? y - 84 : y + 6) + 'px';
  pop.classList.add('show');
}
function libraryThumbnail(item, compact = false) {
  const thumb = document.createElement('span');
  thumb.className = 'libp-thumb' + (compact ? ' is-compact' : '');
  if (item.type === 'image') {
    const image = document.createElement('img');
    image.loading = 'lazy'; image.decoding = 'async'; image.src = toFileUrl(item.path); image.alt = ''; image.dataset.imgPath = item.path;
    image.addEventListener('error', () => { thumb.classList.add('is-unavailable'); thumb.innerHTML = `${libFileIcon('image')}<span>无法预览</span>`; }, { once: true });
    thumb.appendChild(image);
  } else {
    thumb.innerHTML = `<span class="libp-file-placeholder">${libFileIcon(item.type)}<span>${escapeHtml(item.ext.toUpperCase() || 'FILE')}</span></span>`;
  }
  return thumb;
}
function libraryItemElement(item, items, list) {
  const row = document.createElement('article');
  row.className = 'libp-item'; row.dataset.libraryPath = item.path;
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'libp-open'; open.title = `${item.type === 'image' ? '查看图片' : '打开文件'} · ${item.path}`;
  const thumb = libraryThumbnail(item, list);
  const info = document.createElement('span'); info.className = 'libp-item-info';
  const meta = [libFmtTime(item.mtime), libFmtSize(item.size)].filter(Boolean).join(' · ');
  info.innerHTML = `<span class="libp-item-name">${escapeHtml(item.name)}</span><span class="libp-item-meta">${escapeHtml(meta)}</span>`;
  open.append(thumb, info);
  if (!list && item.ext) {
    const badge = document.createElement('span'); badge.className = 'libp-ext'; badge.textContent = item.ext.toUpperCase(); thumb.appendChild(badge);
  }
  if (list) {
    const date = document.createElement('span'); date.className = 'libp-item-date'; date.textContent = libFmtTime(item.mtime);
    const size = document.createElement('span'); size.className = 'libp-item-size'; size.textContent = libFmtSize(item.size);
    open.append(date, size);
  }
  const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'libp-item-menu'; menu.title = '更多操作'; menu.setAttribute('aria-label', `更多操作：${item.name}`); menu.innerHTML = LIB_UI_ICONS.more;
  menu.addEventListener('click', event => showLibFileMenu(event, item));
  open.addEventListener('click', () => openLibraryItem(item, items));
  row.addEventListener('contextmenu', event => showLibFileMenu(event, item));
  row.append(open, menu);
  return row;
}
function buildLibFileList(items) {
  const list = document.createElement('div'); list.className = 'libp-list';
  list.innerHTML = '<div class="libp-list-head"><span>名称</span><span>已修改</span><span>大小</span><span></span></div>';
  for (const item of items) list.appendChild(libraryItemElement(item, items, true));
  return list;
}
function buildLibFileGrid(items) {
  const grid = document.createElement('div'); grid.className = 'libp-grid';
  for (const item of items) grid.appendChild(libraryItemElement(item, items, false));
  return grid;
}
if ($('btnMyWork')) $('btnMyWork').addEventListener('click', openMyWork);
if ($('btnMyWorkChat')) $('btnMyWorkChat').addEventListener('click', openMyWork);


// 创作页顶部栏按钮:与新对话一致(新对话 / Agent / 设置)。图像 API 设置已融入设置弹窗。
if ($('cvBtnSettings'))       $('cvBtnSettings').addEventListener('click', openSettings);

// ─────────────────────────────────────────
// Agent 共用入口：选择一个直接调用，选择多个启动协作。
// ─────────────────────────────────────────
const selectedAgentLabels = new Map();
let sharedAgentPicker = null;
function openAgentPicker() {
  if (!sharedAgentPicker) sharedAgentPicker = window.RelayAgentPicker.create({
    document, window,
    loadAgents: async () => {
      const result = await window.api.data.listAgents();
      if (!result || result.ok === false) throw new Error(result && (result.message || result.error) || 'Agent 暂时无法加载');
      return Array.isArray(result.items) ? result.items : [];
    },
    onManage: () => openSettings('agent'),
    onStart: (agents) => {
      if (!Array.isArray(agents) || !agents.length) return;
      for (const agent of agents) selectedAgentLabels.set(agent.name, agent.displayName || agent.name);
      if (agents.length === 1) {
        const agent = agents[0];
        startNewConv('agent', agent.name, agent.displayName || agent.name);
      } else {
        startNewConv('orchestrate', null, null, agents.map((agent) => agent.name));
      }
    },
  });
  return sharedAgentPicker.open();
}

// ── 会话全文搜索弹窗(ChatGPT 式:搜索框 + 按时间分组的结果) ──
let searchEl = null;
// 把后端片段里的命中哨兵 \x00…\x01 转成高亮 <mark>(先转义 HTML 防注入)
function renderSnippet(snip) {
  const esc = escapeHtml(String(snip || ''));
  return esc.split('\x00').map((seg, i) => {
    if (i === 0) return seg;
    const close = seg.indexOf('\x01');
    if (close < 0) return seg;
    return `<mark>${seg.slice(0, close)}</mark>${seg.slice(close + 1)}`;
  }).join('');
}
// 按 updatedAt 把结果分到 今天/昨天/前7天/前30天/更早(年月) —— 仿 ChatGPT
function groupSearchResults(items) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  const buckets = new Map();   // label → items[](保持插入顺序)
  const order = ['今天', '昨天', '前 7 天', '前 30 天'];
  for (const l of order) buckets.set(l, []);
  for (const it of items) {
    const ts = Date.parse(it.updatedAt);
    let label;
    if (!Number.isFinite(ts)) label = '更早';
    else if (ts >= startOfToday) label = '今天';
    else if (ts >= startOfToday - DAY) label = '昨天';
    else if (ts >= startOfToday - 7 * DAY) label = '前 7 天';
    else if (ts >= startOfToday - 30 * DAY) label = '前 30 天';
    else { const d = new Date(ts); label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`; }
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(it);
  }
  return [...buckets.entries()].filter(([, arr]) => arr.length);
}
function showSearchModal() {
  if (!searchEl) {
    searchEl = document.createElement('div');
    searchEl.className = 'search-overlay';
    searchEl.innerHTML = `
      <div class="search-box">
        <div class="search-head">
          <svg class="search-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>
          <input type="text" class="search-input" placeholder="搜索历史对话…" />
          <button class="search-close" title="关闭 (Esc)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="search-results" data-results></div>
      </div>
    `;
    document.body.appendChild(searchEl);
    searchEl.addEventListener('click', (e) => { if (e.target === searchEl) hideSearchModal(); });
    searchEl.querySelector('.search-close').addEventListener('click', hideSearchModal);

    const input = searchEl.querySelector('.search-input');
    const resultsEl = searchEl.querySelector('[data-results]');
    let timer = null, lastQuery = '';

    const renderResults = (q, items) => {
      if (!q) { resultsEl.innerHTML = `<div class="search-empty">输入关键词搜索你的历史对话</div>`; return; }
      if (!items.length) { resultsEl.innerHTML = `<div class="search-empty">没有找到包含「${escapeHtml(q)}」的对话</div>`; return; }
      const groups = groupSearchResults(items);
      resultsEl.innerHTML = groups.map(([label, arr]) => `
        <div class="search-group-title">${escapeHtml(label)}</div>
        ${arr.map((it) => `
          <button class="search-result" data-id="${escapeAttr(it.id)}" data-kind="${escapeAttr(it.kind)}"${it.turnIndex != null ? ` data-turn="${it.turnIndex}" data-side="${escapeAttr(it.matchSide || '')}"` : ''}>
            <span class="sr-ico">${histIconSvg(it)}</span>
            <span class="sr-meta">
              <span class="sr-title">${escapeHtml(it.title)}</span>
              <span class="sr-snippet">${renderSnippet(it.snippet)}</span>
            </span>
          </button>
        `).join('')}
      `).join('');
      // 绑点击打开
      resultsEl.querySelectorAll('.search-result').forEach((row) => {
        row.addEventListener('click', () => {
          const id = row.dataset.id, isCreate = row.dataset.kind === 'create';
          // 命中正文时带上定位(turn 索引 + 命中侧),打开会话后滚到那条消息;命中标题则无 data-turn
          const jumpTo = row.dataset.turn != null
            ? { turnIndex: parseInt(row.dataset.turn, 10), side: row.dataset.side || null }
            : null;
          hideSearchModal();
          if (isCreate) loadCreateConv(id, jumpTo); else loadConversation(id, jumpTo);
        });
      });
    };

    const doSearch = async () => {
      const q = input.value.trim();
      lastQuery = q;
      if (!q) { renderResults('', []); return; }
      try {
        const r = await window.api.history.search(q);
        if (q !== lastQuery) return;   // 已有更新的查询,丢弃过期结果
        renderResults(q, (r && r.items) || []);
      } catch (_) { renderResults(q, []); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 120); });
    // Enter 打开第一条结果
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = resultsEl.querySelector('.search-result'); if (first) first.click(); }
    });
  }
  searchEl.classList.add('show');
  window.relayWindowChrome?.setSearchOpen(true);
  const input = searchEl.querySelector('.search-input');
  input.value = '';
  searchEl.querySelector('[data-results]').innerHTML = `<div class="search-empty">输入关键词搜索你的历史对话</div>`;
  setTimeout(() => input.focus(), 30);
}
function hideSearchModal() {
  if (searchEl) searchEl.classList.remove('show');
  window.relayWindowChrome?.setSearchOpen(false);
}
$('btnSearch').addEventListener('click', showSearchModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl && searchEl.classList.contains('show')) { hideSearchModal(); return; }
  // Search bindings are dispatched by the shared keyboard shortcut controller.
});


// ─────────────────────────────────────────
// 设置模态窗
// ─────────────────────────────────────────
const modal = $('settingsModal');
const modalBody = $('settingsBody');
const modalHint = $('settingsHint');
const btnSettingsSaveEl = $('btnSettingsSave');
const btnSettingsBackEl = $('btnSettingsBack');
const settingsFooterEl = btnSettingsSaveEl && btnSettingsSaveEl.closest('.modal-footer');
let pendingSettings = null;  // 用户改了但还没保存的值
let lastSettingsCat = 'profile'; // 进入全屏子面板前所在的一级菜单(子面板「返回」回到它)
let activeSettingsBackHandler = null;
let generalPreferencesView = null;
let personalizationGuidanceView = null;
let settingsFormLoaded = false;
let settingsFormPromise = null;
let selectSettingsCategory = null;
let settingsThemeObserver = null;
let settingsDirtyObserver = null;
let settingsEditRevision = 0;
let settingsSaveBusy = false;
const keyboardIsMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
let keyboardStorage = null;
try { keyboardStorage = window.localStorage; } catch (_) {}
const keyboardShortcutStore = window.RelayKeyboardShortcuts.createStore({ storage: keyboardStorage, isMac: keyboardIsMac });
window.relayKeyboardShortcuts = keyboardShortcutStore;
window.dispatchEvent(new CustomEvent('relay:keyboard-shortcuts-ready'));
window.relayShortcutPage = null;
let skillOverviewCache = null;       // 跨页面保留最近一次完整技能列表
let skillPanelConfigCache = null;    // 自动提炼/体检模型的最近快照
let skillUsageUpdateOff = null;      // 主进程增量索引完成通知，只保留一个监听器
let skillDraftEventOff = null;       // Skill 草稿创建/发布/忽略通知，只保留一个监听器
let memoryUsageUpdateOff = null;     // 同一份增量索引也承载记忆实际 Read 遥测
let providerChangeOff = null;        // 托盘或设置页切换服务商后的实时刷新
const providerHealth = new Map();    // 最近一次已保存配置的检测结果，绑定配置版本
const providerHealthProfiles = new Map();
const providerHealthRequests = new Map();
const providerModelCatalog = new Map(); // 模型目录按服务商配置版本隔离，不代表 Key 调用权限

function setSettingsBackAction(handler = null) {
  activeSettingsBackHandler = typeof handler === 'function' ? handler : null;
  if (btnSettingsBackEl) btnSettingsBackEl.style.display = activeSettingsBackHandler ? '' : 'none';
}

// 详情页不再销毁并重建整个设置表单：把当前 DOM 连同事件监听器暂存起来，
// 返回时直接原样挂回。这样可保留列表内容、表单状态和滚动位置，也不会再闪出“加载中”。
function preserveSettingsView() {
  if (settingsViewSnapshot || !modalBody.querySelector('.set-layout')) return;
  const content = $('setContent');
  const fragment = document.createDocumentFragment();
  settingsViewSnapshot = {
    fragment,
    modalScrollTop: modalBody.scrollTop,
    contentScrollTop: content ? content.scrollTop : 0,
    saveDisplay: btnSettingsSaveEl ? btnSettingsSaveEl.style.display : '',
    footerDisplay: settingsFooterEl ? settingsFooterEl.style.display : '',
    saveHandler: activeSaveHandler,
    backHandler: activeSettingsBackHandler,
    hint: modalHint.textContent,
  };
  while (modalBody.firstChild) fragment.appendChild(modalBody.firstChild);
  if (settingsFooterEl) settingsFooterEl.style.display = '';
}

function restoreSettingsView() {
  const snapshot = settingsViewSnapshot;
  if (!snapshot) return false;
  settingsViewSnapshot = null;
  modalBody.replaceChildren(snapshot.fragment);
  modalBody.scrollTop = snapshot.modalScrollTop;
  activeSaveHandler = snapshot.saveHandler;
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = snapshot.saveDisplay;
  if (settingsFooterEl) settingsFooterEl.style.display = snapshot.footerDisplay;
  setSettingsBackAction(snapshot.backHandler);
  modalHint.textContent = snapshot.hint;
  updateMainSettingsFooter();
  const content = $('setContent');
  if (content) requestAnimationFrame(() => { content.scrollTop = snapshot.contentScrollTop; });
  return true;
}

let settingsContentResizeObserver = null;
function bindSettingsContentLayout(content) {
  settingsContentResizeObserver?.disconnect();
  settingsContentResizeObserver = null;
  if (!content) return;
  // Avoid CSS layout containment here: model menus use viewport coordinates.
  const update = width => content.classList.toggle('is-provider-compact', width <= 560);
  const style = getComputedStyle(content);
  update(content.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
  if (typeof ResizeObserver === 'undefined') return;
  settingsContentResizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) if (entry.target === content) update(entry.contentRect.width);
  });
  settingsContentResizeObserver.observe(content);
}

function bindTransientScrollbar(el) {
  if (!el || el.dataset.scrollRevealBound === '1') return;
  el.dataset.scrollRevealBound = '1';
  let timer = null;
  el.addEventListener('scroll', () => {
    el.classList.add('is-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('is-scrolling'), 650);
  }, { passive: true });
}
bindTransientScrollbar(modalBody);

function normalizeSettingsCategory(category) {
  if (category === 'personalization') return 'memory';
  if (category === 'personalize' || category === 'behavior') return 'general';
  if (category === 'usage') return 'profile';
  if (category === 'advanced' || category === 'maintenance') return 'conversation';
  return category;
}

async function openSettings(category) {
  if (['agent', 'skill', 'data', 'mcp'].includes(category)) {
    openPlugins(category === 'data' ? 'mcp' : category); return;
  }
  showAppView('settings');
  const explicitCategory = typeof category === 'string' ? normalizeSettingsCategory(category) : null;
  if (!settingsFormLoaded) await loadSettingsForm(explicitCategory || lastSettingsCat);
  if (explicitCategory && selectSettingsCategory) {
    restoreSettingsView();
    selectSettingsCategory(explicitCategory);
  }
}
function closeSettings() { returnToConversationView(); }

$('btnSettings').addEventListener('click', openSettings);
$('btnCloseSettings').addEventListener('click', closeSettings);
$('btnSettingsCancel').addEventListener('click', async () => {
  if (settingsSaveBusy) return;
  if (restoreSettingsView()) return;
  applyThemeToDOM(_themeSetting);
  await loadSettingsForm(lastSettingsCat);
});
if (btnSettingsBackEl) btnSettingsBackEl.addEventListener('click', () => {
  if (activeSettingsBackHandler) activeSettingsBackHandler();
});

function updateProfileIdentity(brand) {
  // A details view temporarily detaches the settings form; keep its saved identity current.
  const node = id => $(id) || settingsViewSnapshot?.fragment.querySelector('#' + id);
  const name = node('profileName');
  if (name) { name.textContent = brand?.name || DEFAULT_BRAND_NAME; name.title = name.textContent; }
  setBrandLogo(node('profileLogo'), brand?.logo);
}
function updateMainSettingsFooter(category = lastSettingsCat) {
  const managed = ['profile', 'providers', 'shortcuts', 'browser', 'memory'].includes(category);
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = managed ? 'none' : '';
  if (settingsFooterEl) settingsFooterEl.style.display = managed ? 'none' : '';
}
function markSettingsDirty() {
  settingsEditRevision += 1;
  modalHint.dataset.error = 'false';
  modalHint.textContent = '有未保存的修改';
}


function loadSettingsForm(activeCat = lastSettingsCat) {
  activeCat = normalizeSettingsCategory(activeCat);
  if (settingsFormPromise) return settingsFormPromise;
  settingsFormLoaded = false;
  window.relayShortcutPage?.destroy();
  usagePageView?.destroy();
  usagePageView = null;
  browserSettingsPageView?.destroy();
  browserSettingsPageView = null;
  window.relayShortcutPage = null;
  selectSettingsCategory = null;
  if (settingsThemeObserver) settingsThemeObserver.disconnect();
  if (settingsDirtyObserver) settingsDirtyObserver.disconnect();
  settingsThemeObserver = settingsDirtyObserver = null;
  for (const off of [memoryUsageUpdateOff, providerChangeOff]) {
    if (off) off();
  }
  memoryUsageUpdateOff = providerChangeOff = null;
  modalHint.textContent = '';
  modalHint.dataset.error = 'false';
  settingsFormPromise = renderSettingsForm(activeCat).then(() => {
    settingsFormLoaded = true;
    return true;
  }).catch((error) => {
    activeSaveHandler = null;
    if (settingsFooterEl) settingsFooterEl.style.display = 'none';
    modalBody.innerHTML = `<div class="settings-load-error"><p>设置暂时无法加载：${escapeHtml(error.message || '请稍后重试')}</p><button type="button" class="btn-ghost" id="settingsLoadRetry">重试</button></div>`;
    $('settingsLoadRetry').onclick = () => loadSettingsForm(activeCat);
    return false;
  }).finally(() => { settingsFormPromise = null; });
  return settingsFormPromise;
}

async function renderSettingsForm(activeCat = lastSettingsCat) {
  generalPreferencesView?.destroy(); generalPreferencesView = null;
  personalizationGuidanceView?.destroy(); personalizationGuidanceView = null;
  activeCat = normalizeSettingsCategory(activeCat);
  if (providerChangeOff) { providerChangeOff(); providerChangeOff = null; }
  settingsViewSnapshot = null;
  if (settingsFooterEl) settingsFooterEl.classList.remove('hidden');
  setSettingsBackAction();
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = '';  // 从子面板返回时恢复"保存"
  modalBody.innerHTML = '<div style="text-align:center;color:#888;padding:40px">加载中...</div>';
  const s = await window.api.settings.read();
  if (!s || s.ok === false) throw new Error(s?.message || '未收到设置内容');
  s.app = s.app || {}; s.claude = s.claude || {};
  pendingSettings = JSON.parse(JSON.stringify(s));  // 深拷贝,改它
  const behaviorRoutes = s.claude.routes || providerRouting;

  // GPT 式两栏:左侧一级菜单 + 右侧对应分类内容。所有分类的表单都渲染进 DOM(只切换显示),
  //   这样 bindSettingsEvents/保存逻辑读取各 input 不受影响,无需改动。
  modalBody.innerHTML = `
   <div class="set-layout">
    <nav class="set-nav" id="setNav">
      <button class="set-nav-item" data-cat="profile"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M5.5 18a7 7 0 0 1 13 0"/></svg></span><span>个人资料</span></button>
      <button class="set-nav-item" data-cat="general"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h7M15 7h5M4 17h3M11 17h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></span><span>常规</span></button>
      <button class="set-nav-item" data-cat="conversation"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11a8 8 0 0 1-8 8H7l-4 3V6a3 3 0 0 1 3-3h7a8 8 0 0 1 8 8Z"/><path d="M7 8h10M7 12h6"/></svg></span><span>对话与任务</span></button>
      <button class="set-nav-item" data-cat="workspace"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg></span><span>工作区</span></button>
      <button class="set-nav-item" data-cat="memory"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 9h.01M16 9h.01M8 14a4 4 0 0 0 8 0"/></svg></span><span>个性化</span></button>
      <button class="set-nav-item" data-cat="providers"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg></span><span>服务商</span></button>
      <button class="set-nav-item" data-cat="browser"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg></span><span>浏览器</span></button>
      <button class="set-nav-item" data-cat="shortcuts"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h.01M11 9h.01M15 9h.01M18 9h.01M7 12h.01M11 12h.01M15 12h.01M18 12h.01M8 15h8"/></svg></span><span>键盘快捷键</span></button>
      <button class="set-nav-item" data-cat="about"><span class="sn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></span><span>关于</span></button>
    </nav>
    <div class="set-content" id="setContent">

     <!-- 日常设置与任务、工作区共用草稿，切换分类不会重建控件。 -->
     <section class="set-cat" data-cat="general" aria-label="常规设置">
      <div class="set-section-head">外观</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon ico-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none"/></svg></div>
          <div class="set-label">外观主题</div>
          ${buildSettingsSegmented('set-theme', [
            { value: 'light',  label: '浅色' },
            { value: 'dark',   label: '深色' },
            { value: 'system', label: '跟随系统' },
          ], s.app.theme || 'light')}
        </div>
        <div class="set-row">
          <div class="set-icon ico-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M12 8h5M12 12h5M12 16h3"/></svg></div>
          <div class="set-label">对话快捷索引</div>
          <div class="switch ${s.app.conversationIndex !== false ? 'on' : ''}" id="sw-conversationIndex"></div>
        </div>
        <div class="set-row">
          <div class="set-icon ico-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v9h9"/></svg></div>
          <div class="set-label">显示上下文窗口使用情况</div>
          <button type="button" role="switch" aria-label="显示上下文窗口使用情况" aria-checked="${s.app.showContextUsage !== false}" class="switch ${s.app.showContextUsage !== false ? 'on' : ''}" id="sw-showContextUsage"></button>
        </div>
      </div>

      <div class="set-section-head">启动与快捷小窗</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M3 5l3-3M18 2l3 3M6 20l-1 2M18 20l1 2"/></svg></div>
          <div class="set-label">开机自动启动</div>
          <div class="switch" id="sw-autoLaunch"></div>
        </div>
        <div class="set-row" title="点击桌面悬浮球或按 Alt+Space 打开快捷对话；关闭后，运行中的对话仍会继续">
          <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="3"/><path d="m8 18-3 3v-3M8 9h8M8 13h5"/></svg></div>
          <div class="set-label">悬浮球与快捷小窗</div>
          <div class="switch ${(s.app.quickChatEnabled ?? (s.app.miniInputEnabled !== false || s.app.floatingOrbEnabled !== false)) ? 'on' : ''}" id="sw-quickChat"></div>
        </div>
      </div>
     </section>

     <section class="set-cat" data-cat="conversation" aria-label="对话与任务">
      <div class="set-section-head">新对话</div>
      <div class="set-panel">
        <div class="set-row" title="所有服务商共用一个新对话默认档位；每个档位的模型在服务商中配置">
          <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg></div>
          <div class="set-label">新对话默认档位</div>
          ${buildSettingsSegmented('behaviorDefaultModel', ['haiku', 'sonnet', 'opus'].map(tier => ({
            value: tier, label: providerTierLabel(tier),
            disabled: !(behaviorRoutes.chatRoutes || []).some(route => route.tier === tier && route.configured && route.available),
          })), behaviorRoutes.defaultModel || s.claude.defaultModel || 'haiku')}
        </div>
      </div>
      <div id="conversationPreferencesSection"></div>
      <div class="set-section-head">定时任务</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg></div>
          <div class="rgp-label"><label>允许命令任务</label><p>允许定时任务执行命令；对话权限在输入框中选择。</p></div>
          <div class="switch ${s.app.allowCommandTasks?'on':''}" id="sw-allowCommand"></div>
        </div>
      </div>
      <div id="toolRulesPreferencesSection"></div>
     </section>
     <section class="set-cat" data-cat="workspace" aria-label="工作区"><div id="workspacePreferencesSection"></div></section>

     <section class="set-cat" data-cat="shortcuts" aria-label="键盘快捷键"><div id="keyboardShortcutsSection"></div></section>

     <!-- ── Relay 服务商 ── -->
     <section class="set-cat" data-cat="providers">
      <div id="providerSection"></div>
     </section>


     <!-- ── 关于 ── -->
     <section class="set-cat" data-cat="about">
      <div class="set-section-head">应用</div>
      <div class="set-panel">
        <div class="set-row clickable" id="set-relayUpdate">
          <div class="set-icon ico-app"><img class="relay-default-logo" src="logo.svg" alt="" /></div>
          <div class="set-label">Relay</div>
          <div class="row-status" id="set-relayUpdateNote"></div>
          <div class="row-status">v${escapeHtml(s.info.uiVersion)}</div>
          <div class="row-chev">›</div>
        </div>
        <div class="set-row">
          <div class="set-icon ico-author"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></svg></div>
          <div class="set-label">作者</div>
          <div class="row-status">g0at</div>
        </div>
      </div>
     </section>



     <!-- ── 记忆 ── 内容由 renderMemoryPanel 异步填充进 #memorySection -->
     <section class="set-cat" data-cat="memory" aria-label="个性化">
      <section id="relayInstructionsSection" class="relay-guidance" aria-label="Relay 说明"></section>
      <h2 class="relay-memory-heading">Relay 记忆</h2>
      <div id="memorySection"></div>
      <div id="memoryPreferencesSection"></div>
     </section>

     <section class="set-cat" data-cat="browser" aria-label="浏览器设置"><div id="browserSettingsSection"></div></section>

     <!-- ── 个人资料 ── 本地品牌与轻量活动统计共用一个页面 -->
     <section class="set-cat" data-cat="profile" aria-label="个人资料">
      <div id="profilePage" class="relay-profile-page">
        <header class="rpp-heading"><h2>个人资料</h2><button type="button" id="profileEdit" class="rpp-edit" aria-expanded="false" aria-controls="profileIdentityEditor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg><span>编辑资料</span></button></header>
        <div class="rpp-identity"><img id="profileLogo" class="rpp-logo relay-default-logo" src="logo.svg" alt="应用标志"/><h1 id="profileName">Relay</h1></div>
        <dialog id="profileIdentityEditor" class="rpp-editor" role="dialog" aria-modal="true" aria-labelledby="profileEditorTitle">
          <form id="profileEditorForm" class="rpp-editor-card">
            <h2 id="profileEditorTitle">编辑个人资料</h2>
            <div class="rpp-avatar-editor">
              <img id="set-brandLogoPreview" class="rpp-avatar-preview relay-default-logo" src="logo.svg" alt="头像预览" />
              <button id="set-brandLogoPick" class="rpp-avatar-pick" type="button" title="选择头像" aria-label="选择头像"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg></button>
            </div>
            <button id="set-brandLogoReset" class="rpp-avatar-reset" type="button">恢复默认头像</button>
            <label class="rpp-name-label" for="set-brandName">显示名称</label>
            <div class="rpp-name-field"><input id="set-brandName" type="text" placeholder="Relay" autocomplete="off" spellcheck="false" aria-describedby="set-brandNameCount" /><span id="set-brandNameCount">0/40</span></div>
            <div class="rpp-editor-message"><span id="profileEditorStatus" role="status" aria-live="polite"></span><button id="profileEditorRetry" type="button" hidden>重新读取</button></div>
            <footer class="rpp-editor-actions"><button id="profileCancel" type="button">取消</button><button id="profileSave" type="submit">保存</button></footer>
          </form>
        </dialog>
        <div id="usageSection"></div>
      </div>
     </section>

    </div>
   </div>
  `;

  personalizationGuidanceView = window.RelayPersonalizationGuidance.create({
    mount: $('relayInstructionsSection'), value: s.app.relayInstructions || '', api: window.api.settings,
    onChange: markSettingsDirty,
    onSaved: value => {
      if (pendingSettings?.app) pendingSettings.app.relayInstructions = value;
      const base = pendingSettings?.app || {};
      const hasAppDraft = [['sw-allowCommand', 'allowCommandTasks', false], ['sw-quickChat', 'quickChatEnabled', base.miniInputEnabled !== false || base.floatingOrbEnabled !== false],
        ['sw-conversationIndex', 'conversationIndex', true], ['sw-showContextUsage', 'showContextUsage', true]]
        .some(([id, key, fallback]) => $(id)?.classList.contains('on') !== (base[key] ?? fallback));
      const hasDraft = hasAppDraft || $('set-theme')?.dataset.value !== (base.theme || 'light')
        || $('behaviorDefaultModel')?.dataset.edited === 'true' || Object.keys(generalPreferencesView?.getPatch() || {}).length
        || $('relayInstructions')?.value !== value;
      modalHint.textContent = hasDraft ? '有未保存的修改' : '';
      modalHint.dataset.error = 'false';
    },
  });

  const sdkSettingsScope = { conversationId: currentConv?.id, projectId: currentConv?.projectId };
  generalPreferencesView = window.RelayGeneralPreferencesPage?.create({
    mount: $('workspacePreferencesSection'),
    mounts: { conversation: $('conversationPreferencesSection'), workspace: $('workspacePreferencesSection'), toolRules: $('toolRulesPreferencesSection'), memory: $('memoryPreferencesSection') }, api: { ...window.api.generalPreferences,
      get: options => window.api.generalPreferences.get({ ...options, ...sdkSettingsScope }),
      applyRuntimeFlags: sdkSettingsScope.conversationId && typeof window.api.claudeApplyRuntimeFlags === 'function'
        ? () => window.api.claudeApplyRuntimeFlags(sdkSettingsScope.conversationId) : undefined,
    }, settings: s.app, onChange: markSettingsDirty,
  });

  // 管理型页面异步拉取，首次切换时再渲染。
  const lazyCatLoaded = { providers: 'idle', memory: 'idle', profile: 'idle', browser: 'idle' };
  const ensureLazyCat = (cat) => {
    if (lazyCatLoaded[cat] === 'loading' || lazyCatLoaded[cat] === 'ready') return;
    let renderTask = null;
    let mount = null;
    if (cat === 'providers') {
      mount = $('providerSection');
      if (mount) renderTask = renderProviderPanel(mount);
    } else if (cat === 'memory') {
      mount = $('memorySection');
      if (mount) renderTask = renderMemoryPanel(mount);
    } else if (cat === 'browser') {
      mount = $('browserSettingsSection');
      if (mount) renderTask = renderBrowserSettingsPanel(mount);
    } else if (cat === 'profile') {
      mount = $('usageSection');
      if (mount) renderTask = renderStatsPanel(mount);
    }
    if (!renderTask) return;
    lazyCatLoaded[cat] = 'loading';
    Promise.resolve(renderTask).then(() => {
      lazyCatLoaded[cat] = 'ready';
    }).catch((error) => {
      lazyCatLoaded[cat] = 'idle';
      if (mount && mount.isConnected) {
        mount.innerHTML = `<div class="dp-empty">加载失败，切换到其他页面后可重试</div>`;
      }
      console.error(`[settings] ${cat} 面板加载失败`, error);
    });
  };

  window.relayShortcutPage = window.RelayKeyboardShortcutsPage.create({
    mount: $('keyboardShortcutsSection'), store: keyboardShortcutStore, isMac: keyboardIsMac,
  });

  // 分类及其滚动位置随页面一起保留。
  const categoryScroll = new Map();
  let selectedCategory = null;
  const setActiveCat = (cat) => {
    cat = normalizeSettingsCategory(cat);
    if (cat !== 'profile') $('profileIdentityEditor')?._cancelProfile?.();
    if (!modalBody.querySelector(`.set-cat[data-cat="${cat}"]`)) return;
    window.relayShortcutPage?.cancelRecording(false);
    if (cat !== 'browser') browserSettingsPageView?.suspend();
    const content = $('setContent');
    if (content && selectedCategory) categoryScroll.set(selectedCategory, content.scrollTop);
    selectedCategory = cat;
    window.closeCustomSelect?.();
    modalBody.querySelectorAll('.set-nav-item').forEach((b) => { b.classList.toggle('active', b.dataset.cat === cat); if (b.dataset.cat === cat) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    modalBody.querySelectorAll('.set-cat').forEach((sec) => sec.classList.toggle('active', sec.dataset.cat === cat));
    if (content) content.scrollTop = categoryScroll.get(cat) || 0;
    lastSettingsCat = cat;   // 记住最近浏览的分类,供全屏子面板(数据栏的文件/历史)返回时回到此处
    updateMainSettingsFooter(cat);
    if (['conversation', 'workspace', 'memory'].includes(cat)) void generalPreferencesView?.refresh();
    // 用量页结构轻量且自带快照缓存，本次点击立即呈现；其他管理页仍延后一帧构建。
    if (cat === 'browser') {
      if (lazyCatLoaded.browser === 'idle') ensureLazyCat(cat);
      else browserSettingsPageView?.refresh();
    } else if (cat === 'profile') {
      if (lazyCatLoaded.profile === 'idle') ensureLazyCat(cat);
      else usagePageView?.refresh();
    } else if (lazyCatLoaded[cat] === 'idle') requestAnimationFrame(() => ensureLazyCat(cat));
    else ensureLazyCat(cat);
  };
  selectSettingsCategory = setActiveCat;
  setActiveCat(activeCat);
  bindTransientScrollbar($('setContent'));
  bindTransientScrollbar($('setNav'));
  bindSettingsContentLayout($('setContent'));
  // 左侧一级菜单切换:点哪个就只显示哪个分类
  modalBody.querySelectorAll('.set-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveCat(btn.dataset.cat);
    });
  });

  bindCustomSelects(modalBody);   // 把自绘下拉的事件绑上
  bindSettingsSegmented(modalBody);
  const behaviorDefault = $('behaviorDefaultModel');
  behaviorDefault.dataset.savedValue = behaviorRoutes.defaultModel || s.claude.defaultModel || 'haiku';
  behaviorDefault.dataset.edited = 'false';
  behaviorDefault.setAttribute('aria-label', '新对话默认档位');
  behaviorDefault.addEventListener('settings-segment-change', () => {
    behaviorDefault.dataset.edited = String(behaviorDefault.dataset.value !== behaviorDefault.dataset.savedValue);
    markSettingsDirty();
  });
  syncBehaviorDefaultModel(behaviorRoutes);

  // 主题下拉即时预览:选中即刻切换,不必等「保存」
  const themeSelect = $('set-theme');
  if (themeSelect) {
    settingsThemeObserver = new MutationObserver(() => applyThemeToDOM(themeSelect.dataset.value));
    settingsThemeObserver.observe(themeSelect, { attributes: true, attributeFilter: ['data-value'] });
  }

  bindSettingsEvents();
  const preferenceControls = new Set(['sw-allowCommand', 'sw-quickChat', 'sw-conversationIndex', 'sw-showContextUsage', 'set-theme']);
  settingsDirtyObserver = new MutationObserver((records) => {
    if (records.some((record) => preferenceControls.has(record.target.id) &&
      (record.attributeName === 'data-value' || record.attributeName === 'class'))) markSettingsDirty();
  });
  settingsDirtyObserver.observe(modalBody.querySelector('.set-layout'), { subtree: true, attributes: true, attributeFilter: ['data-value', 'class'] });
  activeSaveHandler = saveMainSettings;   // 主设置页:底部「保存」保存全部设置
}

// 外部路由更新同步已保存值，保留用户尚未保存的选择。普通设置保存不会
// 回写这里的旧快照，也不会因为服务商编辑而改变全局默认档位。
function syncBehaviorDefaultModel(routes) {
  const group = $('behaviorDefaultModel') || settingsViewSnapshot?.fragment.querySelector('#behaviorDefaultModel');
  if (!group || !routes) return;
  const saved = routes.defaultModel || 'haiku';
  const draft = group.dataset.edited === 'true' ? group.dataset.value : saved;
  group.dataset.savedValue = saved;
  group.dataset.value = draft;
  group.dataset.edited = String(draft !== saved);
  const options = Array.isArray(routes.chatRoutes) ? routes.chatRoutes : [];
  for (const button of group.querySelectorAll('button[data-value]')) {
    const route = options.find(item => item.tier === button.dataset.value);
    button.disabled = !(route && route.configured && route.available);
    button.setAttribute('aria-disabled', String(button.disabled));
    button.title = button.disabled ? '请先在服务商中配置此档位' : window.RelayModelDisplay.modelName(route.modelId);
    const active = button.dataset.value === draft;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }
}


// 把字符串切成「字素簇」(用户感知的一个字符):emoji(含肤色/ZWJ 家庭如 👨‍👩‍👧)算一个整体,
//   绝不拆成乱码。Intl.Segmenter 在 Electron 的 Chromium 里可用;万一不可用则退回按码点切。
function toGraphemes(str) {
  const s = String(str);
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment); }
    catch (_) {}
  }
  return Array.from(s);   // 退回:按码点(emoji 不被拆半,但 ZWJ 序列会拆成多个)
}
// 单个字素的视觉宽度:CJK/全角 = 2;emoji = 2(视觉约两格宽);其余(英文/数字/符号)= 1
function graphemeWidth(g) {
  const cp = g.codePointAt(0) || 0;
  if (cp > 0xffff) return 2;        // 增补平面:emoji 等,都按 2 宽
  return cp > 0x2e7f ? 2 : 1;       // 基本多文种平面里的全角/CJK 记 2
}
// 视觉宽度:全角/CJK/emoji 记 2,其余记 1(emoji 安全,与后端 strWidth 完全同算法)
function strWidth(str) {
  let w = 0;
  for (const g of toGraphemes(str)) w += graphemeWidth(g);
  return w;
}
// 按视觉宽度截断,且不在英文单词中间断开、不拆 emoji(与后端 truncateByWidth 同款规则)
function truncateByWidth(str, maxW) {
  const gs = toGraphemes(str);
  let w = 0, out = '', lastSafe = '', prevWord = false;
  for (const g of gs) {
    const cw = graphemeWidth(g);
    const isWord = /^[0-9A-Za-z]$/.test(g);
    if (!(prevWord && isWord)) lastSafe = out;   // 不在单词内部 → 记一个安全截断点
    if (w + cw > maxW) {
      // 超限:卡在单词中间则回退到最近安全点;若安全点为空(整串一个超长词)则就地硬切
      return (prevWord && isWord && lastSafe) ? lastSafe : out;
    }
    out += g; w += cw; prevWord = isWord;
  }
  return out;
}

// Identity edits are a separate modal transaction. The saved profile and usage
// page stay untouched until the host confirms both the name and avatar.
async function bindBrandSettings() {
  const page = $('profilePage'), editor = $('profileIdentityEditor'), edit = $('profileEdit');
  const input = $('set-brandName'), count = $('set-brandNameCount'), preview = $('set-brandLogoPreview');
  const pick = $('set-brandLogoPick'), reset = $('set-brandLogoReset'), save = $('profileSave'), cancel = $('profileCancel');
  const status = $('profileEditorStatus'), retry = $('profileEditorRetry');
  if (!page || !editor || editor.dataset.bound) return;
  editor.dataset.bound = 'true';
  const owned = () => $('profilePage') === page || !!settingsViewSnapshot?.fragment.contains(page);
  let saved = null, max = 40, generation = 0, readVersion = 0, active = false;
  let nameDirty = false, logoAction = 'keep', previewId = null, ready = false, composing = false, saving = false, logoBusy = false;
  const message = (text = '', error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const discard = id => { if (id) void window.api.brand.discardLogoPreview(id).catch(() => {}); };
  const updateCount = () => { count.textContent = `${strWidth(input.value)}/${max}`; };
  const buttons = () => {
    save.disabled = saving || !ready || logoBusy;
    cancel.disabled = saving; input.readOnly = saving;
    pick.disabled = reset.disabled = saving || logoBusy;
    save.textContent = saving ? '保存中…' : '保存';
  };
  const clamp = () => { if (strWidth(input.value) > max) input.value = truncateByWidth(input.value, max); updateCount(); };
  const close = () => {
    if (saving || !active) return;
    window.removeEventListener('keydown', escapeKey, true);
    active = false; generation++; readVersion++; ready = false; composing = false;
    discard(previewId); previewId = null; logoAction = 'keep'; nameDirty = false;
    input.value = saved?.name || ''; input.dataset.edited = 'false'; setBrandLogo(preview, saved?.logo); updateCount();
    if (editor.open) editor.close();
    edit.setAttribute('aria-expanded', 'false');
    if (edit.isConnected) edit.focus({ preventScroll: true });
  };
  const escapeKey = event => {
    if (!editor.open || event.key !== 'Escape') return;
    // A native dialog close request is not always cancelable once its focused
    // button becomes disabled. Stop the key's default action before that request.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!composing && !event.isComposing && event.keyCode !== 229) close();
  };
  editor._cancelProfile = close;
  const read = async () => {
    const version = ++readVersion, own = generation;
    if (active) { ready = false; retry.hidden = true; message('正在读取个人资料…'); buttons(); }
    try {
      const result = await window.api.brand.get();
      if (!result || result.ok === false) throw new Error(result?.error || '无法读取个人资料');
      if (!owned() || version !== readVersion || own !== generation) return;
      saved = result;
      if (Number.isSafeInteger(result.nameMax) && result.nameMax > 0) max = result.nameMax;
      updateProfileIdentity(result);
      if (active) {
        if (!nameDirty) input.value = result.name || '';
        if (logoAction === 'keep') setBrandLogo(preview, result.logo);
        ready = typeof result.revision === 'string' && !!result.revision;
        if (!ready) throw new Error('个人资料接口尚未就绪，请重新打开');
        updateCount(); message();
      }
    } catch (error) {
      if (owned() && version === readVersion && own === generation && active) { ready = false; retry.hidden = false; message(error.message || '读取失败，请重试', true); }
    } finally { if (owned() && version === readVersion && own === generation) buttons(); }
  };
  edit.addEventListener('click', () => {
    if (editor.open || !owned()) return;
    active = true; generation++; nameDirty = false; logoAction = 'keep'; previewId = null; logoBusy = false;
    input.value = saved?.name || ''; input.dataset.edited = 'false'; setBrandLogo(preview, saved?.logo); updateCount();
    editor.showModal(); window.addEventListener('keydown', escapeKey, true); edit.setAttribute('aria-expanded', 'true');
    input.focus({ preventScroll: true }); void read();
  });
  cancel.addEventListener('click', close);
  editor.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
  editor.addEventListener('close', () => { if (!editor.open) close(); });
  editor.addEventListener('keydown', event => {
    event.stopPropagation();
    if ((event.key === 'Enter' || event.key === 'Escape') && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  let backdropDown = false;
  const outside = event => { const rect = editor.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
  editor.addEventListener('pointerdown', event => { backdropDown = event.target === editor && outside(event); });
  editor.addEventListener('click', event => { if (backdropDown && event.target === editor && outside(event)) close(); backdropDown = false; });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; clamp(); });
  input.addEventListener('input', () => { nameDirty = true; input.dataset.edited = 'true'; if (!composing) clamp(); else updateCount(); });
  retry.addEventListener('click', () => void read());
  pick.addEventListener('click', async () => {
    if (logoBusy || saving || !active) return;
    const own = generation; logoBusy = true; buttons();
    try {
      const result = await window.api.brand.pickLogoPreview();
      if (result?.canceled) return;
      if (!result || !result.ok || !result.previewId || !result.logo) throw new Error(result?.error || result?.message || '无法读取头像');
      if (!owned() || own !== generation || !active) { discard(result.previewId); return; }
      discard(previewId); previewId = result.previewId; logoAction = 'replace'; setBrandLogo(preview, result.logo); message();
    } catch (error) { if (owned() && own === generation && active) message(error.message || '读取头像失败', true); }
    finally { if (owned() && own === generation) { logoBusy = false; buttons(); } }
  });
  reset.addEventListener('click', () => {
    if (saving || logoBusy) return;
    discard(previewId); previewId = null; logoAction = 'default'; setBrandLogo(preview, null); message();
  });
  $('profileEditorForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!active || !ready || saving || logoBusy || composing) return;
    saving = true; buttons(); message('正在保存…');
    try {
      const result = await window.api.brand.saveProfile({ name: input.value, logoAction, ...(previewId ? { previewId } : {}), expectedRevision: saved.revision });
      if (!result || !result.ok) throw Object.assign(new Error(result?.error || result?.message || '未收到保存确认'), { code: result?.code });
      saved = result; previewId = null; readVersion++; brandRenderRevision++;
      const name = $('brandName');
      if (name) { name.textContent = result.name || DEFAULT_BRAND_NAME; name.title = name.textContent; }
      setBrandLogo($('brandLogo'), result.logo); updateProfileIdentity(result);
      saving = false; close();
    } catch (error) {
      if (owned()) { message(error.message || '保存失败，请重试', true); if (error.code === 'PROFILE_CHANGED') { ready = false; retry.hidden = false; } }
    } finally { saving = false; if (owned()) buttons(); }
  });
  void read();
}

function bindSettingsEvents() {
  // ── 个人资料:标志 + 应用名称 ──
  bindBrandSettings();

  // 切换开关（这些随「保存」一起写）
  for (const id of ['sw-allowCommand', 'sw-quickChat', 'sw-conversationIndex']) {
    $(id).addEventListener('click', () => $(id).classList.toggle('on'));
  }
  const contextSwitch = $('sw-showContextUsage');
  contextSwitch?.addEventListener('click', () => {
    contextSwitch.classList.toggle('on');
    contextSwitch.setAttribute('aria-checked', String(contextSwitch.classList.contains('on')));
  });
  // 开机自启开关：OS 级设置，点击即时生效（不随「保存」批量写）。
  //   初始状态异步从主进程读真实注册表值；切换时立即 setAutoLaunch。
  const swAuto = $('sw-autoLaunch');
  if (swAuto && window.api.scheduler && window.api.scheduler.getAutoLaunch) {
    window.api.scheduler.getAutoLaunch().then((r) => {
      if (r && r.enabled) swAuto.classList.add('on');
    }).catch(() => {});
    swAuto.addEventListener('click', async () => {
      const next = !swAuto.classList.contains('on');
      swAuto.classList.toggle('on', next);
      try { await window.api.scheduler.setAutoLaunch(next); }
      catch (_) { swAuto.classList.toggle('on', !next); }   // 失败回滚
    });
  }
  // 关于:Relay 应用自更新状态(自动静默流,此处展示 + 手动检查 + 重启安装)
  bindRelayUpdate();
}

// ─────────────────────────────────────────
// Relay 服务商
// ─────────────────────────────────────────
function providerMonogram(name) {
  const chars = Array.from(String(name || 'R').trim());
  return (chars[0] || 'R').toUpperCase();
}

function providerAccent(id) {
  let hash = 0;
  for (const char of String(id || 'relay')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function providerTierLabel(tier) {
  return ({ haiku: '快速', sonnet: '思考', opus: '专家' })[tier] || '快速';
}

function providerConnectionSummary(response, includeModel = false) {
  const parts = ['Anthropic 连接正常'];
  if (response && response.authMode) parts.push(response.authMode === 'auth-token' ? 'Bearer' : 'API Key');
  if (response && response.latencyMs) parts.push(`${response.latencyMs} ms`);
  if (includeModel && response && response.model) parts.push(response.model);
  return parts.join(' · ');
}

function providerHealthProfileKey(profile) {
  if (!profile) return '';
  return JSON.stringify([profile.id, Number(profile.revision) || 0, profile.baseUrl,
    profile.models, profile.defaultModel, profile.enabled, profile.hasCredential, profile.authMode]);
}

function syncProviderHealth(profiles) {
  if (!Array.isArray(profiles)) return;
  const current = new Map(profiles.map(profile => [profile.id, providerHealthProfileKey(profile)]));
  providerHealthProfiles.clear();
  for (const [id, key] of current) providerHealthProfiles.set(id, key);
  for (const [id, result] of providerHealth) {
    if (!current.has(id) || result.profileKey !== current.get(id)) providerHealth.delete(id);
  }
  for (const [id, result] of providerModelCatalog) {
    if (!current.has(id) || result.profileKey !== current.get(id)) providerModelCatalog.delete(id);
  }
}

function providerHealthMarkup(id, currentResult = null) {
  const health = currentResult || providerHealth.get(id);
  if (!health) return '<span class="provider-health is-idle"><i></i>未检测</span>';
  if (health.loading) return '<span class="provider-health is-loading"><i></i>检测中</span>';
  if (health.ok) return `<span class="provider-health is-ok" title="${escapeAttr(health.message || '')}"><i></i>${escapeHtml(`${health.latencyMs || 0} ms`)}</span>`;
  if (health.errorKind === 'model_not_allowed') return `<span class="provider-health is-warning" title="${escapeAttr(health.message || '')}"><i></i>探测受限</span>`;
  return `<span class="provider-health is-error" title="${escapeAttr(health.message || '连接失败')}"><i></i>不可用</span>`;
}

function providerCapabilityMarkup(profile) {
  const imageCount = Array.isArray(profile.imageModels) ? profile.imageModels.length : 0;
  const imageState = profile.imageDiscovery && profile.imageDiscovery.status;
  const badges = [];
  if (profile.chatReady) badges.push(`<span class="provider-capability is-chat">对话 ${Number(profile.chatModelCount) || 0}</span>`);
  if (imageCount) badges.push(`<span class="provider-capability is-image" title="目录中的图像候选，调用权限未验证">图像候选 ${imageCount}</span>`);
  else if (imageState === 'error') badges.push('<span class="provider-capability is-error">图像识别失败</span>');
  else if (imageState === 'unknown') badges.push('<span class="provider-capability is-pending">图像待识别</span>');
  return badges.join('');
}

const PROVIDER_IMAGE_LABELS = {
  'gpt-image-2': 'GPT Image 2',
  'seedream-5.0': 'Seedream 5',
  'seedream-4.5': 'Seedream 4.5',
};

function providerAssignmentMarkup(profile) {
  const roles = [];
  for (const tier of Array.isArray(profile.activeTiers) ? profile.activeTiers : []) {
    roles.push(`<span class="provider-assignment is-chat">${escapeHtml(providerTierLabel(tier))}</span>`);
  }
  for (const adapterId of Array.isArray(profile.activeImageAdapters) ? profile.activeImageAdapters : []) {
    roles.push(`<span class="provider-assignment is-image">${escapeHtml(PROVIDER_IMAGE_LABELS[adapterId] || adapterId)}</span>`);
  }
  return roles.length ? roles.join('') : '<span class="provider-assignment is-spare">备用</span>';
}

function providerImageModelsMarkup(profile, selectedAdapters = null) {
  const models = profile && Array.isArray(profile.imageModels) ? profile.imageModels : [];
  const discovery = profile && profile.imageDiscovery || {};
  const selected = selectedAdapters instanceof Set
    ? selectedAdapters
    : new Set(profile && Array.isArray(profile.activeImageAdapters) ? profile.activeImageAdapters : []);
  if (models.length) {
    return `<div class="provider-image-capabilities">${models.map((item) => `
      <div class="provider-image-capability ${selected.has(item.adapterId) ? 'is-routed' : ''}" title="${escapeAttr(item.remoteModelId)}">
        ${ICON_IMAGE}<strong>${escapeHtml(PROVIDER_IMAGE_LABELS[item.adapterId] || item.adapterId)}</strong><small>${escapeHtml(item.remoteModelId)}</small>
        <button class="provider-route-toggle ${selected.has(item.adapterId) ? 'is-active' : ''}" data-image-route-adapter="${escapeAttr(item.adapterId)}" title="选择 Relay 使用的图像模型；调用权限未验证" type="button">${selected.has(item.adapterId) ? '已选用' : '选用'}</button>
      </div>`).join('')}</div>`;
  }
  if (discovery.status === 'error') return '<span class="provider-capability-note is-error">识别失败</span>';
  if (discovery.status === 'none') return '<span class="provider-capability-note">未发现</span>';
  return '<span class="provider-capability-note">未识别</span>';
}

function providerActionIcon(action) {
  const paths = {
    test: '<path d="M20 11a8 8 0 1 1-2.34-5.66"/><path d="M20 4v7h-7"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    remove: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m9 7 1-3h4l1 3"/><path d="m6 7 1 14h10l1-14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[action] || ''}</svg>`;
}

function providerModelPickerMarkup(id, value = '') {
  const popupId = `${id}Options`;
  return `
    <div class="provider-model-picker" data-provider-model-picker>
      <input class="provider-edit-inline-input provider-model-input" id="${id}" data-provider-model
        type="text" value="${escapeAttr(value)}" placeholder="模型 ID" spellcheck="false" autocomplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${popupId}" />
      <button class="provider-model-toggle" type="button" aria-label="选择模型" title="选择模型">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>
      </button>
      <div class="provider-model-popup" id="${popupId}" role="listbox" hidden></div>
    </div>`;
}

function providerChatRouteControlMarkup(tier, id, value, selected) {
  return `<div class="provider-route-control">
    ${providerModelPickerMarkup(id, value)}
    <button class="provider-route-toggle ${selected ? 'is-active' : ''}" data-chat-route-tier="${escapeAttr(tier)}"
      type="button">${selected ? '已分配' : '使用'}</button>
  </div>`;
}

function normalizeProviderModelCatalog(models) {
  const seen = new Set();
  const values = [];
  for (const item of Array.isArray(models) ? models : []) {
    const record = item && typeof item === 'object' ? item : {};
    const value = String(typeof item === 'string' ? item : (record.value || record.routeId || record.id) || '').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    const rawId = String(record.id || record.rawId || value).trim();
    const ownedBy = String(record.ownedBy || record.owned_by || '').trim();
    values.push({
      value,
      rawId,
      ownedBy,
      idKind: String(record.idKind || (value === rawId ? 'raw' : 'owner-qualified')),
      inference: String(record.inference || 'server-id'),
      searchText: `${value} ${rawId} ${ownedBy}`.toLocaleLowerCase(),
    });
  }
  return values.sort((left, right) => left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: 'base' }));
}

function closeProviderModelPickers(except = null) {
  document.querySelectorAll('.provider-model-picker.is-open').forEach((picker) => {
    if (picker === except) return;
    picker.classList.remove('is-open');
    const input = picker.querySelector('[data-provider-model]');
    const popup = picker.querySelector('.provider-model-popup');
    if (input) input.setAttribute('aria-expanded', 'false');
    if (popup) popup.hidden = true;
  });
}

function bindProviderModelPickers(mount, initialModels = []) {
  let catalog = normalizeProviderModelCatalog(initialModels);
  const pickers = Array.from(mount.querySelectorAll('[data-provider-model-picker]'));

  const close = (picker) => {
    picker.classList.remove('is-open');
    picker.querySelector('[data-provider-model]').setAttribute('aria-expanded', 'false');
    picker.querySelector('.provider-model-popup').hidden = true;
  };

  const place = (picker) => {
    const popup = picker.querySelector('.provider-model-popup');
    const anchor = picker.getBoundingClientRect();
    const edge = 12;
    const gap = 5;
    const desiredHeight = Math.min(288, popup.scrollHeight || 288);
    const below = Math.max(0, window.innerHeight - anchor.bottom - gap - edge);
    const above = Math.max(0, anchor.top - gap - edge);
    const openAbove = below < desiredHeight && above > below;
    popup.classList.toggle('open-up', openAbove);
    popup.style.width = `${Math.round(anchor.width)}px`;
    popup.style.left = `${Math.max(edge, Math.min(Math.round(anchor.left), window.innerWidth - anchor.width - edge))}px`;
    popup.style.maxHeight = `${Math.max(84, Math.min(288, Math.floor(openAbove ? above : below)))}px`;
    if (openAbove) {
      popup.style.top = 'auto';
      popup.style.bottom = `${Math.round(window.innerHeight - anchor.top + gap)}px`;
    } else {
      popup.style.top = `${Math.round(anchor.bottom + gap)}px`;
      popup.style.bottom = 'auto';
    }
  };

  const renderOptions = (picker) => {
    const input = picker.querySelector('[data-provider-model]');
    const popup = picker.querySelector('.provider-model-popup');
    const current = input.value.trim();
    const filtering = picker.dataset.filtering === 'true';
    const query = filtering ? current.toLocaleLowerCase() : '';
    let options = query
      ? catalog.filter((model) => model.searchText.includes(query))
      : catalog.slice();
    const currentCatalogModel = current
      ? catalog.find((model) => model.value === current)
      : null;
    const currentIsCatalogModel = !!currentCatalogModel;
    if (current && !currentIsCatalogModel && (!query || current.toLocaleLowerCase().includes(query))) {
      options.unshift({
        value: current,
        rawId: current,
        ownedBy: '',
        idKind: 'custom',
        inference: 'current',
        searchText: current.toLocaleLowerCase(),
      });
    }
    if (!options.length) {
      popup.innerHTML = `<div class="provider-model-empty">${catalog.length ? '没有匹配模型' : '尚未获取模型'}</div>`;
      return;
    }
    popup.innerHTML = (catalog.length ? '<div class="provider-model-empty">服务商目录 · 调用权限未验证</div>' : '') + options.map((model) => {
      const selected = model.value === current;
      const customCurrent = selected && !currentIsCatalogModel;
      const routeHint = !customCurrent && model.idKind === 'owner-qualified' && model.rawId !== model.value
        ? '兼容路由'
        : (!customCurrent && model.ownedBy ? model.ownedBy : '');
      const title = model.rawId !== model.value
        ? `${model.value}\n接口原始 ID：${model.rawId}`
        : model.value;
      return `<button class="provider-model-option ${selected ? 'is-selected' : ''}" type="button" role="option"
        aria-selected="${selected ? 'true' : 'false'}" data-model="${escapeAttr(model.value)}" title="${escapeAttr(title)}">
        <span>${escapeHtml(model.value)}</span>${customCurrent ? '<small>当前</small>' : (routeHint ? `<small>${escapeHtml(routeHint)}</small>` : '')}
      </button>`;
    }).join('');
    popup.querySelectorAll('.provider-model-option').forEach((option) => {
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        input.value = option.dataset.model || '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        picker.dataset.filtering = 'false';
        close(picker);
        input.focus();
      });
      option.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') { close(picker); input.focus(); return; }
        const optionsInPopup = Array.from(popup.querySelectorAll('.provider-model-option'));
        const index = optionsInPopup.indexOf(option);
        const next = event.key === 'ArrowDown'
          ? optionsInPopup[(index + 1) % optionsInPopup.length]
          : optionsInPopup[(index - 1 + optionsInPopup.length) % optionsInPopup.length];
        if (next) next.focus();
      });
    });
  };

  const open = (picker, filtering = false) => {
    closeProviderModelPickers(picker);
    picker.dataset.filtering = filtering ? 'true' : 'false';
    picker.classList.add('is-open');
    picker.querySelector('[data-provider-model]').setAttribute('aria-expanded', 'true');
    const popup = picker.querySelector('.provider-model-popup');
    popup.hidden = false;
    renderOptions(picker);
    place(picker);
    const selected = popup.querySelector('.provider-model-option.is-selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  pickers.forEach((picker) => {
    const input = picker.querySelector('[data-provider-model]');
    const toggle = picker.querySelector('.provider-model-toggle');
    picker.addEventListener('click', (event) => event.stopPropagation());
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (picker.classList.contains('is-open')) close(picker);
      else open(picker, false);
    });
    input.addEventListener('input', () => open(picker, true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && picker.classList.contains('is-open')) {
        event.preventDefault();
        close(picker);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!picker.classList.contains('is-open')) open(picker, false);
        const first = picker.querySelector('.provider-model-option');
        if (first) first.focus();
      }
    });
  });

  return {
    setModels(models) {
      catalog = normalizeProviderModelCatalog(models);
      pickers.filter((picker) => picker.classList.contains('is-open')).forEach((picker) => {
        renderOptions(picker);
        place(picker);
      });
    },
    get size() { return catalog.length; },
  };
}

async function renderProviderPanel(mount) {
  if (!mount) return;
  mount.innerHTML = '<div class="provider-loading">正在读取 Relay 服务商…</div>';

  const refresh = async () => {
    const result = await window.api.providers.list();
    const profiles = result && result.ok && Array.isArray(result.profiles) ? result.profiles : [];
    syncProviderHealth(profiles);
    const routes = result && result.routes || { defaultModel: 'haiku', chatRoutes: [], imageRoutes: [] };
    applyProviderRouting(routes);
    const configuredChatCount = (routes.chatRoutes || []).filter((item) => item && item.configured && item.available).length;
    const configuredImageCount = (routes.imageRoutes || []).filter((item) => item && item.configured && item.available).length;
    const cards = profiles.map((profile) => `
      <article class="provider-row ${profile.routed ? 'is-active' : ''}" data-provider-id="${escapeAttr(profile.id)}" title="点击编辑服务商">
        <div class="provider-avatar" style="--provider-hue:${providerAccent(profile.id)}">
          ${escapeHtml(providerMonogram(profile.name))}
          <span class="provider-avatar-state"></span>
        </div>
        <div class="provider-row-main">
          <div class="provider-row-titleline">
            <strong>${escapeHtml(profile.name)}</strong>
            ${providerCapabilityMarkup(profile)}
            ${profile.enabled ? '' : '<span class="provider-disabled-badge">已停用</span>'}
          </div>
          <div class="provider-endpoint" title="${escapeAttr(profile.baseUrl)}">${escapeHtml(profile.baseUrl)}</div>
          <div class="provider-row-meta">
            ${providerHealthMarkup(profile.id)}
            <span>${profile.hasCredential ? escapeHtml(profile.credentialHint || '密钥已保存') : '未配置密钥'}</span>
            <span>${profile.chatReady ? `${Number(profile.chatModelCount) || 0} 个对话模型` : '无对话模型'}${profile.imageReady ? ` · ${profile.imageModels.length} 个图像候选` : ''}</span>
          </div>
        </div>
        <div class="provider-row-actions">
          <div class="provider-assignments">${providerAssignmentMarkup(profile)}</div>
          <span class="provider-action-divider"></span>
          <button class="provider-row-action" data-provider-act="test" type="button" title="检测对话连接" aria-label="检测对话连接" ${!profile.chatReady ? 'disabled' : ''}>${providerActionIcon('test')}</button>
          <button class="provider-row-action" data-provider-act="edit" type="button" title="编辑服务商" aria-label="编辑服务商">${providerActionIcon('edit')}</button>
          <button class="provider-row-action" data-provider-act="duplicate" type="button" title="创建副本" aria-label="创建副本">${providerActionIcon('duplicate')}</button>
          <button class="provider-row-action danger" data-provider-act="remove" type="button" title="${profile.routed ? '请先移除该服务商承担的模型槽位' : '删除服务商'}" aria-label="删除服务商" ${profile.routed ? 'disabled' : ''}>${providerActionIcon('remove')}</button>
        </div>
      </article>
    `).join('');

    mount.innerHTML = `
      <div class="provider-page">
        <div class="provider-toolbar">
          <div class="provider-summary">
            <strong>${profiles.length} 个服务商</strong>
            <span>${configuredChatCount}/3 对话档位</span>
            <span>${configuredImageCount}/3 图像模型</span>
          </div>
          <button class="provider-add-btn" id="providerAdd" type="button">${providerActionIcon('plus')}<span>添加服务商</span></button>
        </div>
        <div class="provider-list-panel" id="providerList">
          ${cards || '<div class="provider-empty"><strong>还没有服务商</strong><span>添加模型服务后，可分别分配对话与图像能力。</span></div>'}
        </div>
      </div>`;

    const add = mount.querySelector('#providerAdd');
    if (add) add.addEventListener('click', () => renderProviderEditor(mount, null, routes));

    mount.querySelectorAll('.provider-row').forEach((card) => {
      const id = card.dataset.providerId;
      const profile = profiles.find((item) => item.id === id);
      card.querySelectorAll('[data-provider-act]').forEach((button) => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          const action = button.dataset.providerAct;
          if (action === 'edit') { renderProviderEditor(mount, profile, routes); return; }
          if (action === 'test') {
            const request = { loading: true, profileKey: providerHealthProfileKey(profile) };
            providerHealthRequests.set(id, request);
            providerHealth.set(id, request);
            await refresh();
            let response;
            try { response = await window.api.providers.test(id); }
            catch (error) { response = { ok: false, message: error.message || '检测失败' }; }
            // Configuration changes and later probes retire this exact request.
            if (providerHealthRequests.get(id) !== request) return;
            providerHealthRequests.delete(id);
            const resultKey = response && response.profile ? providerHealthProfileKey(response.profile) : request.profileKey;
            if ((response && response.stale) || resultKey !== providerHealthProfiles.get(id)) {
              if (providerHealth.get(id) === request) providerHealth.delete(id);
              return;
            }
            providerHealth.set(id, { ...(response || { ok: false, message: '检测失败' }), profileKey: resultKey });
            showToast(response && response.ok ? providerConnectionSummary(response) : ((response && response.message) || '连接失败'));
            await refresh();
            return;
          }
          if (action === 'duplicate') {
            button.disabled = true;
            const response = await window.api.providers.duplicate(id);
            if (!response || !response.ok) showToast((response && response.message) || '复制失败');
            else showToast('已创建服务商副本');
            await refresh();
            return;
          }
          if (action === 'remove') {
            const confirmed = await customConfirm({
              title: '删除服务商',
              message: `将删除“${profile.name}”及其加密密钥。此操作无法撤销。`,
              confirmText: '删除',
              danger: true,
            });
            if (!confirmed) return;
            const response = await window.api.providers.remove(id);
            if (!response || !response.ok) showToast((response && response.message) || '删除失败');
            else { providerHealth.delete(id); providerModelCatalog.delete(id); showToast('服务商已删除'); }
            await refresh();
          }
        });
      });
      card.addEventListener('click', () => renderProviderEditor(mount, profile, routes));
    });
  };

  if (!providerChangeOff && window.api.providers.onChanged) {
    providerChangeOff = window.api.providers.onChanged((payload) => {
      syncProviderHealth(payload && payload.profiles);
      imageConfigLoaded = false;
      if (activeView === 'create') loadImageModels().catch(() => {});
      const routes = payload && (payload.routes || (payload.active && payload.active.routes));
      if (routes) applyProviderRouting(routes);
      if (!currentConv && configuredChatRoute(defaultModel)) currentModel = defaultModel;
      updateModelSwitchUI();
      if (!mount.isConnected) return;
      if (mount.querySelector('.provider-editor')) {
        mount.querySelector('.provider-editor').dispatchEvent(new CustomEvent('provider-config-changed', { detail: payload }));
        modalHint.textContent = '服务商列表已更新；当前编辑内容未被覆盖';
        return;
      }
      refresh().catch((error) => console.error('[providers] 刷新失败', error));
    });
  }
  await refresh();
}

function renderProviderEditor(mount, profile, routeState = null) {
  const editing = !!profile;
  const routing = routeState && typeof routeState === 'object'
    ? routeState : { defaultModel: 'haiku', chatRoutes: [], imageRoutes: [] };
  const seed = profile || {
    name: '自定义服务',
    baseUrl: '',
    models: { haiku: '', sonnet: '', opus: '' },
    enabled: true,
  };
  const models = seed.models || {};
  const selectedChatRoutes = new Set(editing
    ? (Array.isArray(seed.activeTiers) ? seed.activeTiers : [])
    : ['haiku', 'sonnet', 'opus'].filter((tier) => !(routing.chatRoutes || []).some((item) => item && item.tier === tier && item.configured)));
  const selectedImageRoutes = new Set(editing
    ? (Array.isArray(seed.activeImageAdapters) ? seed.activeImageAdapters : [])
    : []);
  let discoveredImageModels = Array.isArray(seed.imageModels) ? seed.imageModels.slice() : [];
  const isRouted = editing && !!seed.routed;
  mount.innerHTML = `
    <div class="provider-editor">
      <div class="provider-editor-head">
        <button class="provider-back-btn" id="providerEditorBack" type="button" aria-label="返回服务商列表">${providerActionIcon('back')}</button>
        <span>${editing ? '编辑服务商' : '添加服务商'}</span>
      </div>
      <section class="provider-edit-primary">
        <input class="provider-edit-name" id="providerName" type="text" maxlength="48"
          value="${escapeAttr(editing ? seed.name : '')}" placeholder="服务商名称" autocomplete="off" />
      </section>

      <section class="provider-edit-section">
        <div class="provider-edit-section-title">连接</div>
        <div class="provider-edit-panel">
          <label class="provider-edit-row">
            <span class="provider-edit-label"><strong>网关 URL</strong></span>
            <input class="provider-edit-inline-input provider-url-input" id="providerBaseUrl" type="url"
              value="${escapeAttr(seed.baseUrl || '')}" placeholder="https://api.example.com" spellcheck="false" />
          </label>
          <label class="provider-edit-row">
            <span class="provider-edit-label"><strong>API Key</strong></span>
            <span class="provider-secret-input">
              <input class="provider-edit-inline-input" id="providerApiKey" type="password" value="" autocomplete="new-password"
                placeholder="${escapeAttr(editing && seed.hasCredential ? `已保存${seed.credentialHint ? `（${seed.credentialHint}）` : ''}，留空保持不变` : '输入 API Key')}" />
              <button id="providerShowKey" type="button">显示</button>
            </span>
          </label>
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>对话检查</strong></span>
            <span class="provider-edit-row-control">
              <span class="provider-test-state">${editing ? providerHealthMarkup(seed.id) : '<span class="provider-health is-idle"><i></i>未检测</span>'}</span>
              <button class="provider-inline-btn" id="providerEditorTest" type="button" disabled>检测当前填写</button>
            </span>
          </div>
        </div>
      </section>

      <section class="provider-edit-section">
        <div class="provider-edit-section-title">模型配置</div>
        <p class="provider-catalog-notice">调用权限未验证：服务商目录可能包含当前 Key 未获授权的模型。选用仅保存配置，对话检查仅验证所测模型。</p>
        <div class="provider-edit-panel">
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>模型目录</strong></span>
            <button class="provider-inline-btn" id="providerDiscover" type="button" title="自动探测并刷新模型目录">刷新模型</button>
          </div>
          <div class="provider-edit-row provider-image-capability-row">
            <span class="provider-edit-label"><strong>图像候选</strong></span>
            <div id="providerImageCapabilities">${providerImageModelsMarkup(seed, selectedImageRoutes)}</div>
          </div>
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>快速</strong></span>
            ${providerChatRouteControlMarkup('haiku', 'providerModelHaiku', models.haiku || '', selectedChatRoutes.has('haiku'))}
          </div>
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>思考</strong></span>
            ${providerChatRouteControlMarkup('sonnet', 'providerModelSonnet', models.sonnet || '', selectedChatRoutes.has('sonnet'))}
          </div>
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>专家</strong></span>
            ${providerChatRouteControlMarkup('opus', 'providerModelOpus', models.opus || '', selectedChatRoutes.has('opus'))}
          </div>
        </div>
      </section>

      <section class="provider-edit-section">
        <div class="provider-edit-section-title">可用性</div>
        <div class="provider-edit-panel">
          <div class="provider-edit-row">
            <span class="provider-edit-label"><strong>启用服务商</strong></span>
            <div class="switch ${seed.enabled !== false ? 'on' : ''}" id="providerEnabled" ${isRouted ? 'data-locked="true"' : ''}></div>
          </div>
        </div>
      </section>

      <div class="provider-editor-status" id="providerEditorStatus"></div>
      <div class="provider-editor-actions">
        <button class="provider-secondary-btn" id="providerEditorCancel" type="button">取消</button>
        <button class="provider-primary-btn" id="providerEditorSave" type="button">保存服务商</button>
      </div>
    </div>`;

  const editorRoot = mount.querySelector('.provider-editor');
  bindSettingsSegmented(mount);
  const back = () => renderProviderPanel(mount);
  mount.querySelector('#providerEditorBack').addEventListener('click', back);
  mount.querySelector('#providerEditorCancel').addEventListener('click', back);
  const keyInput = mount.querySelector('#providerApiKey');
  mount.querySelector('#providerShowKey').addEventListener('click', (event) => {
    const visible = keyInput.type === 'text';
    keyInput.type = visible ? 'password' : 'text';
    event.currentTarget.textContent = visible ? '显示' : '隐藏';
  });
  const enabledSwitch = mount.querySelector('#providerEnabled');
  enabledSwitch.addEventListener('click', () => {
    if (savePending || enabledSwitch.dataset.locked === 'true') return;
    enabledSwitch.classList.toggle('on');
  });

  const status = mount.querySelector('#providerEditorStatus');
  const discover = mount.querySelector('#providerDiscover');
  const baseUrlInput = mount.querySelector('#providerBaseUrl');
  const syncChatRouteButtons = () => {
    mount.querySelectorAll('[data-chat-route-tier]').forEach((button) => {
      const tier = button.dataset.chatRouteTier;
      const active = selectedChatRoutes.has(tier);
      const inputId = ({ haiku: 'providerModelHaiku', sonnet: 'providerModelSonnet', opus: 'providerModelOpus' })[tier];
      const hasModel = !!(inputId && mount.querySelector(`#${inputId}`) && mount.querySelector(`#${inputId}`).value.trim());
      button.classList.toggle('is-active', active);
      button.classList.toggle('is-pending', active && !hasModel);
      button.textContent = active ? '已分配' : '使用';
    });
  };
  mount.querySelectorAll('[data-chat-route-tier]').forEach((button) => {
    button.addEventListener('click', () => {
      const tier = button.dataset.chatRouteTier;
      if (selectedChatRoutes.has(tier)) selectedChatRoutes.delete(tier);
      else selectedChatRoutes.add(tier);
      syncChatRouteButtons();
    });
  });
  mount.querySelectorAll('[data-provider-model]').forEach((input) => {
    input.addEventListener('input', syncChatRouteButtons);
    input.addEventListener('change', syncChatRouteButtons);
  });
  syncChatRouteButtons();

  let imageSelectionTouched = false;
  const bindImageRouteButtons = () => {
    mount.querySelectorAll('[data-image-route-adapter]').forEach((button) => {
      button.addEventListener('click', () => {
        const adapterId = button.dataset.imageRouteAdapter;
        imageSelectionTouched = true;
        if (selectedImageRoutes.has(adapterId)) selectedImageRoutes.delete(adapterId);
        else selectedImageRoutes.add(adapterId);
        const capability = button.closest('.provider-image-capability');
        const active = selectedImageRoutes.has(adapterId);
        button.classList.toggle('is-active', active);
        button.textContent = active ? '已选用' : '选用';
        if (capability) capability.classList.toggle('is-routed', active);
      });
    });
  };
  bindImageRouteButtons();
  const cachedCatalog = editing ? providerModelCatalog.get(seed.id) : null;
  const cacheMatches = !!(cachedCatalog && cachedCatalog.baseUrl === seed.baseUrl
    && cachedCatalog.profileKey === providerHealthProfileKey(seed));
  const modelPickers = bindProviderModelPickers(
    mount,
    cacheMatches
      ? (Array.isArray(cachedCatalog.modelCatalog) && cachedCatalog.modelCatalog.length
        ? cachedCatalog.modelCatalog
        : (cachedCatalog.models || []))
      : [],
  );
  let discoveryRequest = 0;
  let discoveryTimer = null;
  let discoveryProfile = seed;
  let savePending = false;
  let editorStatusOwner = 'directory';

  const clearDiscovery = (discoveryStatus = 'unknown') => {
    if (editing) providerModelCatalog.delete(seed.id);
    modelPickers.setModels([]);
    discoveredImageModels = [];
    const capability = mount.querySelector('#providerImageCapabilities');
    if (capability) capability.innerHTML = providerImageModelsMarkup({ imageDiscovery: { status: discoveryStatus } });
  };

  const canDiscover = () => !!(
    baseUrlInput.value.trim()
    && (keyInput.value.trim() || (editing && discoveryProfile.hasCredential))
  );
  const updateDiscoverAvailability = () => {
    if (discover) discover.disabled = savePending || !canDiscover();
  };
  const renderDiscoveryCapabilities = (response) => {
    const capability = mount.querySelector('#providerImageCapabilities');
    if (!capability || !response || !response.ok) return;
    if (response.profile) {
      discoveredImageModels = Array.isArray(response.profile.imageModels) ? response.profile.imageModels.slice() : [];
      if (!imageSelectionTouched) {
        selectedImageRoutes.clear();
        for (const adapterId of Array.isArray(response.profile.activeImageAdapters) ? response.profile.activeImageAdapters : []) {
          selectedImageRoutes.add(adapterId);
        }
      }
      capability.innerHTML = providerImageModelsMarkup(response.profile, selectedImageRoutes);
      bindImageRouteButtons();
      return;
    }
    const imageModels = Array.isArray(response.imageModels) ? response.imageModels : [];
    discoveredImageModels = imageModels.slice();
    capability.innerHTML = providerImageModelsMarkup({
      imageModels,
      imageDiscovery: { status: imageModels.length ? 'ready' : 'none' },
    }, selectedImageRoutes);
    bindImageRouteButtons();
  };
  const applyDiscoveredModelIdCorrections = (catalog) => {
    let corrected = 0;
    const records = Array.isArray(catalog) ? catalog : [];
    for (const id of ['providerModelHaiku', 'providerModelSonnet', 'providerModelOpus']) {
      const input = mount.querySelector(`#${id}`);
      if (!input) continue;
      const current = input.value.trim();
      const suffixMatch = current.match(/\[1m\]$/i);
      const suffix = suffixMatch ? suffixMatch[0] : '';
      const core = suffix ? current.slice(0, -suffix.length).trim() : current;
      const match = records.find((item) => item
        && String(item.inference || '') === 'configured-owner'
        && String(item.id || '').toLocaleLowerCase() === core.toLocaleLowerCase()
        && String(item.value || '').trim()
        && String(item.value).toLocaleLowerCase() !== core.toLocaleLowerCase());
      if (!match) continue;
      input.value = `${String(match.value).trim()}${suffix}`;
      corrected += 1;
    }
    return corrected;
  };
  const loadProviderModels = async ({ manual = false } = {}) => {
    if (!editorRoot || !editorRoot.isConnected || savePending) return null;
    clearTimeout(discoveryTimer);
    if (manual) editorStatusOwner = 'directory';
    if (!canDiscover()) {
      if (manual) {
        status.textContent = '请先填写 Base URL 和 API Key。';
        status.classList.add('is-error');
      }
      updateDiscoverAvailability();
      return null;
    }
    const requestId = ++discoveryRequest;
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = keyInput.value.trim();
    const requestedProfileKey = editing ? providerHealthProfileKey(discoveryProfile) : '';
    const draftModels = {
      haiku: mount.querySelector('#providerModelHaiku').value.trim(),
      sonnet: mount.querySelector('#providerModelSonnet').value.trim(),
      opus: mount.querySelector('#providerModelOpus').value.trim(),
    };
    const usesSavedProfile = editing && !apiKey && baseUrl === String(discoveryProfile.baseUrl || '').trim()
      && Object.keys(draftModels).every(tier => draftModels[tier] === String((discoveryProfile.models || {})[tier] || '').trim());
    discover.disabled = true;
    discover.textContent = '同步中…';
    if (editorStatusOwner === 'directory') {
      status.textContent = '正在探测模型目录…';
      status.classList.remove('is-error', 'is-warning');
    }
    let response = null;
    try {
      response = usesSavedProfile
        ? await window.api.providers.discoverModels(profile.id)
        : await window.api.providers.discoverDraftModels({
          id: editing ? profile.id : '',
          baseUrl,
          apiKey,
          models: draftModels,
        });
    } catch (error) {
      response = { ok: false, models: [], message: error && error.message || '模型目录探测失败' };
    }
    if (requestId !== discoveryRequest || !editorRoot.isConnected) return response;
    const latestProfileKey = editing ? providerHealthProfileKey(discoveryProfile) : '';
    const responseProfileKey = response && response.profile ? providerHealthProfileKey(response.profile) : requestedProfileKey;
    if ((response && response.stale) || (editing && !apiKey
      && latestProfileKey !== requestedProfileKey && latestProfileKey !== responseProfileKey)) {
      response = { ok: false, stale: true, message: '服务商配置已更改，请重新刷新模型目录。' };
    }
    discover.textContent = '刷新模型';
    updateDiscoverAvailability();
    if (editorStatusOwner === 'directory') {
      status.textContent = response && response.message || '模型目录探测失败';
      status.classList.toggle('is-error', !(response && response.ok));
    }
    if (response && response.ok && Array.isArray(response.models)) {
      const responseCatalog = Array.isArray(response.modelCatalog) && response.modelCatalog.length
        ? response.modelCatalog
        : response.models;
      modelPickers.setModels(responseCatalog);
      const correctedModels = applyDiscoveredModelIdCorrections(response.modelCatalog);
      if (correctedModels && editorStatusOwner === 'directory') status.textContent = `${status.textContent} · 已匹配 ${correctedModels} 个旧模型路由`;
      if (usesSavedProfile) {
        if (response.profile) discoveryProfile = response.profile;
        providerModelCatalog.set(profile.id, {
          baseUrl,
          profileKey: responseProfileKey,
          models: response.models.slice(),
          modelCatalog: Array.isArray(response.modelCatalog) ? response.modelCatalog.slice() : [],
          fetchedAt: Date.now(),
          endpoint: response.endpoint || '',
        });
      }
      renderDiscoveryCapabilities(response);
    } else {
      clearDiscovery('error');
    }
    return response;
  };

  if (discover) discover.addEventListener('click', () => loadProviderModels({ manual: true }));
  const scheduleDraftDiscovery = () => {
    discoveryRequest += 1;
    clearTimeout(discoveryTimer);
    clearDiscovery();
    discover.textContent = '刷新模型';
    editorStatusOwner = 'directory';
    status.textContent = '连接信息已更改，正在等待刷新模型目录…';
    status.classList.remove('is-error', 'is-warning');
    updateDiscoverAvailability();
    if (!canDiscover()) return;
    discoveryTimer = setTimeout(() => loadProviderModels(), 800);
  };
  baseUrlInput.addEventListener('input', scheduleDraftDiscovery);
  keyInput.addEventListener('input', scheduleDraftDiscovery);
  baseUrlInput.addEventListener('change', scheduleDraftDiscovery);
  keyInput.addEventListener('change', scheduleDraftDiscovery);
  editorRoot.addEventListener('provider-config-changed', (event) => {
    if (!editing || !Array.isArray(event.detail && event.detail.profiles)) return;
    const current = event.detail.profiles.find(item => item.id === seed.id);
    if (providerHealthProfileKey(current) === providerHealthProfileKey(discoveryProfile)) return;
    // Leave the in-flight request alive: its own auth detection may have advanced
    // the revision. Only a response matching the current profile can be applied.
    discoveryProfile = current || { id: seed.id, hasCredential: false };
    clearDiscovery();
    updateDiscoverAvailability();
  });
  updateDiscoverAvailability();
  const cacheIsFresh = cacheMatches && Date.now() - Number(cachedCatalog.fetchedAt || 0) < 5 * 60 * 1000;
  if (editing && seed.hasCredential && seed.baseUrl && !cacheIsFresh) {
    setTimeout(() => loadProviderModels(), 0);
  }

  const testButton = mount.querySelector('#providerEditorTest');
  let probeRequest = 0;
  let hasDraftProbe = false;
  let successfulDraftProbe = null;
  const probeDraft = () => ({
    id: editing ? profile.id : '',
    baseUrl: baseUrlInput.value.trim(),
    apiKey: keyInput.value.trim(),
    models: {
      haiku: mount.querySelector('#providerModelHaiku').value.trim(),
      sonnet: mount.querySelector('#providerModelSonnet').value.trim(),
      opus: mount.querySelector('#providerModelOpus').value.trim(),
    },
    tier: providerRouting.defaultModel || routing.defaultModel || 'haiku',
  });
  const updateProbeAvailability = () => {
    testButton.disabled = savePending || !canDiscover() || !Object.values(probeDraft().models).some(Boolean);
  };
  const invalidateDraftProbe = (event) => {
    probeRequest += 1;
    if (event && event.target.matches('[data-provider-model]')) {
      discoveryRequest += 1;
      discover.textContent = '刷新模型';
      updateDiscoverAvailability();
    }
    successfulDraftProbe = null;
    const testState = mount.querySelector('.provider-test-state');
    if (testState) testState.innerHTML = '<span class="provider-health is-idle"><i></i>填写待检测</span>';
    if (hasDraftProbe && !savePending) {
      editorStatusOwner = 'probe';
      status.textContent = '当前填写已更改，请重新检测。';
      status.classList.remove('is-error', 'is-warning');
    }
    testButton.textContent = '检测当前填写';
    updateProbeAvailability();
  };
  for (const input of [baseUrlInput, keyInput, ...mount.querySelectorAll('[data-provider-model]')]) {
    input.addEventListener('input', invalidateDraftProbe);
    input.addEventListener('change', invalidateDraftProbe);
  }
  editorRoot.addEventListener('provider-config-changed', invalidateDraftProbe);
  updateProbeAvailability();
  if (testButton) testButton.addEventListener('click', async () => {
    if (savePending) return;
    editorStatusOwner = 'probe';
    const request = ++probeRequest;
    const draft = probeDraft();
    const signature = JSON.stringify(draft);
    hasDraftProbe = true;
    successfulDraftProbe = null;
    testButton.disabled = true;
    testButton.textContent = '检测中…';
    status.textContent = '正在检测当前填写内容…';
    status.classList.remove('is-error', 'is-warning');
    let response;
    try { response = await window.api.providers.testDraft(draft); }
    catch (error) { response = { ok: false, message: error.message || '检测失败' }; }
    if (request !== probeRequest || !editorRoot.isConnected || signature !== JSON.stringify(probeDraft())) return;
    if (response && response.ok && ['api-key', 'auth-token'].includes(response.authMode)) {
      successfulDraftProbe = { signature, authMode: response.authMode };
    }
    const testState = mount.querySelector('.provider-test-state');
    if (testState) testState.innerHTML = providerHealthMarkup(null, response || { ok: false, message: '检测失败' });
    const resultText = response && response.ok ? providerConnectionSummary(response, true) : ((response && response.message) || '连接失败');
    const advisory = !!(response && response.reachable && response.errorKind === 'model_not_allowed');
    if (editorStatusOwner === 'probe') {
      status.textContent = `当前填写${response && response.tier ? ` · ${providerTierLabel(response.tier)}` : ''}：${resultText}；尚未保存。`;
      status.classList.toggle('is-error', !(response && response.ok) && !advisory);
      status.classList.toggle('is-warning', advisory);
    }
    updateProbeAvailability();
    testButton.textContent = '检测当前填写';
  });

  mount.querySelector('#providerEditorSave').addEventListener('click', async (event) => {
    if (savePending) return;
    const button = event.currentTarget;
    const input = {
      name: mount.querySelector('#providerName').value.trim(),
      baseUrl: mount.querySelector('#providerBaseUrl').value.trim(),
      apiKey: keyInput.value.trim(),
      models: {
        haiku: mount.querySelector('#providerModelHaiku').value.trim(),
        sonnet: mount.querySelector('#providerModelSonnet').value.trim(),
        opus: mount.querySelector('#providerModelOpus').value.trim(),
      },
      imageModels: discoveredImageModels,
      routeTiers: [],
      imageRouteAdapters: Array.from(selectedImageRoutes),
      claimUnassignedRoutes: false,
      enabled: enabledSwitch.classList.contains('on'),
    };
    // The probe itself is read-only. Persist its verified auth choice only when
    // the user explicitly saves exactly the tested connection and credentials.
    if (successfulDraftProbe && successfulDraftProbe.signature === JSON.stringify(probeDraft())) {
      input.authMode = successfulDraftProbe.authMode;
    }
    input.routeTiers = Array.from(selectedChatRoutes).filter((tier) => input.models[tier]);
    if (!input.name || !input.baseUrl || (!editing && !input.apiKey)) {
      status.textContent = '请填写名称、网关和 API Key。';
      status.classList.add('is-error');
      return;
    }
    savePending = true;
    editorStatusOwner = 'save';
    enabledSwitch.setAttribute('aria-disabled', 'true');
    probeRequest += 1;
    const controlStates = new Map(Array.from(editorRoot.querySelectorAll('input, button'), control => [control, control.disabled]));
    for (const control of controlStates.keys()) control.disabled = true;
    button.textContent = '保存中…';
    discoveryRequest += 1;
    clearTimeout(discoveryTimer);
    const savedImageRoutes = new Set(input.imageRouteAdapters);
    let response;
    try {
      response = editing
        ? await window.api.providers.update(profile.id, input)
        : await window.api.providers.create(input);
    } catch (error) {
      response = { ok: false, message: error && error.message || '保存失败' };
    }
    if (!response || !response.ok) {
      savePending = false;
      enabledSwitch.setAttribute('aria-disabled', String(enabledSwitch.dataset.locked === 'true'));
      for (const [control, disabled] of controlStates) control.disabled = disabled;
      status.textContent = (response && response.message) || '保存失败';
      status.classList.add('is-error');
      button.textContent = '保存服务商';
      updateDiscoverAvailability();
      updateProbeAvailability();
      return;
    }
    if (editing) providerHealth.delete(profile.id);
    probeRequest += 1;
    keyInput.value = '';
    status.classList.remove('is-error');
    status.textContent = '服务商已保存，正在刷新模型目录…';
    const savedProfile = response.profile;
    let discovery = null;
    if (savedProfile && savedProfile.id) {
      providerModelCatalog.delete(savedProfile.id);
      discovery = await window.api.providers.discoverModels(savedProfile.id).catch(() => null);
      if (discovery && discovery.ok && Array.isArray(discovery.models)) {
        providerModelCatalog.set(savedProfile.id, {
          baseUrl: savedProfile.baseUrl,
          profileKey: providerHealthProfileKey(discovery.profile || savedProfile),
          models: discovery.models.slice(),
          modelCatalog: Array.isArray(discovery.modelCatalog) ? discovery.modelCatalog.slice() : [],
          fetchedAt: Date.now(),
          endpoint: discovery.endpoint || '',
        });
      }
      if (discovery && discovery.ok && discovery.profile) {
        const detected = new Set((discovery.profile.imageModels || []).map((item) => item.adapterId));
        const activeAfterDiscovery = new Set(discovery.profile.activeImageAdapters || []);
        for (const adapterId of ['gpt-image-2', 'seedream-5.0', 'seedream-4.5']) {
          const shouldUse = savedImageRoutes.has(adapterId) && detected.has(adapterId);
          if (shouldUse || activeAfterDiscovery.has(adapterId)) {
            await window.api.providers.setImageRoute(adapterId, shouldUse ? savedProfile.id : null).catch(() => null);
          }
        }
      }
    }
    imageConfigLoaded = false;
    const imageCount = discovery && discovery.profile && Array.isArray(discovery.profile.imageModels)
      ? discovery.profile.imageModels.length
      : 0;
    showToast(discovery && discovery.ok
      ? `${editing ? '服务商已更新' : '服务商已添加'} · 目录含 ${imageCount} 个图像候选，调用权限未验证`
      : `${editing ? '服务商已更新' : '服务商已添加'}；模型目录稍后可重试`);
    if (editorRoot.isConnected) await renderProviderPanel(mount);
  });
}

// ─────────────────────────────────────────
// Relay 应用自更新 —— 界面侧
//   主进程只自动「检查」,下载和安装都要用户点(见 updater.js 顶部说明)。
//   两个入口共用同一份状态(relay:update-event 推送):
//     ① 侧栏更新入口:发现新版时显示,说明浮层只在用户点击后展开;
//     ② 设置页「Relay」行:随时手动检查,发现新版后再次点击才开始下载。
//   sidebar-update.js 只订阅一次,设置页反复切换不会堆积监听器。
// ─────────────────────────────────────────
let relayUpdateUI = null;

// 首屏订阅,侧栏入口不依赖设置页是否打开过。
function initRelayUpdate() {
  if (relayUpdateUI || !window.api.relayUpdate || !window.RelaySidebarUpdate) return;
  const button = $('btnRelayUpdate');
  const panel = $('sidebarUpdatePanel');
  if (!button || !panel) return;
  relayUpdateUI = window.RelaySidebarUpdate.create({
    api: window.api.relayUpdate, button, panel, label: $('relayUpdateLabel'),
    onState: renderRelayUpdateStatus,
  });
  relayUpdateUI.start();
}

// 设置页版本行复用同一状态与失败信息,每次按 ID 获取当前页面节点。
function renderRelayUpdateStatus(st, view) {
  const row = $('set-relayUpdate');
  const note = $('set-relayUpdateNote');
  if (!row || !note || !st || !window.RelaySidebarUpdate) return;
  const statusView = view || window.RelaySidebarUpdate.describe(st);
  note.textContent = statusView.note;
  note.className = 'row-status' + (statusView.noteKind ? ' note-' + statusView.noteKind : '');
  row.setAttribute('aria-disabled', String(!statusView.action || statusView.pending));
}

function bindRelayUpdate() {
  const row = $('set-relayUpdate');
  if (!row) return;
  initRelayUpdate();
  if (relayUpdateUI) {
    renderRelayUpdateStatus(relayUpdateUI.getState(), relayUpdateUI.getView());
    relayUpdateUI.refresh();
  }
  row.onclick = () => relayUpdateUI?.activateFromSettings();
}

// ─────────────────────────────────────────
// 数据中心子面板(UI 内编辑 / 管理,不跳转文件)
// ─────────────────────────────────────────
function backToSettings() {
  if (restoreSettingsView()) return;
  // 返回到进入全屏子面板前所在的一级菜单。lastSettingsCat 在 setActiveCat 里随当前分类实时更新,
  //   所以无论子面板从哪个分类进入(Claude 设置文件现在在「关于」、MCP 在「数据」、历史已隐藏),返回都回到原处。
  loadSettingsForm(lastSettingsCat || 'general');
}
// 管理列表统一的「···」菜单：低频操作收起，点击空白处关闭。
function bindDpMenu(row) {
  const button = row.querySelector('.dp-more');
  const menu = row.querySelector('.dp-menu');
  if (!button || !menu) return;
  const close = () => {
    menu.classList.remove('open');
    button.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    menu.style.visibility = '';
  };
  const place = () => {
    // 先显示再测量，按按钮的真实视口位置决定向上或向下展开，避免靠“最后一行”
    // 猜测方向造成菜单偏移；fixed 也不会被列表卡片的 overflow 裁切。
    menu.style.position = 'fixed';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.visibility = 'hidden';
    menu.classList.add('open');
    const anchor = button.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const gap = 6;
    const edge = 12;
    const below = anchor.bottom + gap;
    const top = below + box.height <= window.innerHeight - edge
      ? below
      : Math.max(edge, anchor.top - box.height - gap);
    const left = Math.max(edge, Math.min(anchor.right - box.width, window.innerWidth - box.width - edge));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.visibility = '';
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');
    document.querySelectorAll('.dp-menu.open').forEach((it) => it.classList.remove('open'));
    document.querySelectorAll('.dp-more.open').forEach((it) => {
      it.classList.remove('open');
      it.setAttribute('aria-expanded', 'false');
    });
    if (willOpen) {
      place();
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    } else close();
  });
  menu.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  if (!bindDpMenu.bound) {
    bindDpMenu.bound = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.dp-menu.open').forEach((it) => it.classList.remove('open'));
      document.querySelectorAll('.dp-more.open').forEach((it) => {
        it.classList.remove('open');
        it.setAttribute('aria-expanded', 'false');
      });
    });
    // fixed 菜单不应在列表滚动或窗口尺寸变化后留在旧坐标。
    const closeFloatingMenus = () => {
      document.querySelectorAll('.dp-menu.open').forEach((it) => it.classList.remove('open'));
      document.querySelectorAll('.dp-more.open').forEach((it) => {
        it.classList.remove('open');
        it.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('scroll', closeFloatingMenus, true);
    window.addEventListener('resize', closeFloatingMenus);
  }
}

function buildPackageImportZone(kind) {
  const label = kind === 'skill' ? '技能' : 'Agent';
  return `
    <button class="dp-import dp-package-import" type="button" data-import
      aria-label="选择或拖入 ${label} ZIP 安装包" title="选择或拖入 ${label} ZIP 安装包">
      <svg class="dp-import-upload" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <path d="m17 8-5-5-5 5"></path>
        <path d="M12 3v12"></path>
      </svg>
      <span data-import-label>导入${kind === 'skill' ? '技能' : ' Agent'}</span>
    </button>
  `;
}

function placePackageImportZone(mount) {
  const zone = mount.querySelector('[data-import]');
  const actions = mount.closest('.plugins-category')?.querySelector('.plugins-intro-actions');
  // Move the same button before any async list loading: its click/drop handlers
  // keep their panel ownership, and the first frame already has the final layout.
  if (zone && actions) actions.replaceChildren(zone);
  return zone;
}

function bindPackageImportZone(zone, kind, onImported) {
  if (!zone) return;
  const label = zone.querySelector('[data-import-label]');
  const idleText = label ? label.textContent : '';
  let busy = false;
  let picking = false;
  let dragDepth = 0;

  const setBusy = (next) => {
    busy = next;
    zone.classList.toggle('is-busy', next);
    zone.disabled = next;
    if (label) label.textContent = next ? '正在安装…' : idleText;
  };
  const install = async (zipPath) => {
    if (busy) return;
    setBusy(true);
    zone.setAttribute('aria-busy', 'true');
    try {
      const r = await window.api.data.importZip(kind, zipPath);
      if (r && r.canceled) return;
      if (r && r.ok) {
        showToast(r.message || '导入成功');
        if (onImported) await onImported(r);
      } else {
        showToast((r && r.message) || '导入失败');
      }
    } catch (error) {
      showToast((error && error.message) || '导入失败');
    } finally {
      zone.setAttribute('aria-busy', 'false');
      setBusy(false);
    }
  };

  zone.addEventListener('click', async () => {
    if (busy || picking) return;
    picking = true;
    try {
      const picked = await window.api.data.pickImportZip(kind);
      if (picked && picked.ok && picked.path) await install(picked.path);
      else if (picked && !picked.canceled && picked.message) showToast(picked.message);
    } catch (error) {
      showToast((error && error.message) || '选择安装包失败');
    } finally {
      picking = false;
    }
  });
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (busy) return;
    dragDepth += 1;
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) zone.classList.remove('is-dragging');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove('is-dragging');
    if (busy) return;
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    const zipFile = files.find((file) => String(file.name || '').toLowerCase().endsWith('.zip'));
    if (!zipFile) {
      showToast('请拖入 .zip 安装包');
      return;
    }
    const zipPath = window.api.getPathForFile(zipFile);
    if (!zipPath) {
      showToast('无法读取安装包路径');
      return;
    }
    install(zipPath);
  });
}

// 渲染 Agent / 技能 管理界面。mount=要挂载到的容器(设置右侧对应分类的 section);
//   作为一级菜单分类内联展示,不再全屏跳转、无「返回」按钮(导航本身就是入口)。
async function renderAgentSkillPanel(kind, mount) {
  const isSkill = kind === 'skill';
  // 用作用域内查询,限定在本 mount 容器内,避免 agent/skill 两个 section 的同名元素串用
  const q = (sel) => mount.querySelector(sel);
  mount.innerHTML = `
    ${buildPackageImportZone(kind)}
    <div class="set-toolbar">
      <span class="set-toolbar-count" data-count></span>
    </div>
    <div class="set-panel dp-list" data-list></div>
  `;
  const importZone = placePackageImportZone(mount);

  const renderList = (items) => {
    const list = q('[data-list]');
    const count = q('[data-count]');
    if (count) count.textContent = `${items ? items.length : 0} 个${isSkill ? '技能' : ' Agent'}`;
    if (!items || !items.length) {
      list.innerHTML = `<div class="dp-empty">还没有${isSkill ? '技能' : ' Agent'}，点上方按钮导入</div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item';
      const renameBtn = isSkill ? '' : `<button type="button" data-action="rename">重命名</button>`;
      // Agent 使用统一的 DiceBear 头像(种子=真实名,圆形);技能仍用 🧩
      const iconHtml = isSkill
        ? `<div class="set-icon ico-skill">🧩</div>`
        : `<img class="set-icon dp-avatar" alt="" src="${(window.AgentAvatar) ? window.AgentAvatar.dataUri(it.name) : ''}">`;
      row.innerHTML = `
        ${iconHtml}
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
        </div>
        <div class="dp-item-actions dp-menu-wrap">
          <button class="dp-more" type="button" aria-label="更多操作">···</button>
          <div class="dp-menu">
            <button type="button" data-action="detail">详情</button>
            ${renameBtn}
            <button type="button" class="danger" data-action="delete">删除</button>
          </div>
        </div>
      `;
      const label = isSkill ? it.name : (it.displayName || it.name);
      row.querySelector('.dp-item-name').textContent = label;
      // Agent:自定义名 ≠ 真实 id 时,副信息标注真实 id
      const idHint = (!isSkill && label !== it.name) ? `id: ${it.name}　` : '';
      row.querySelector('.dp-item-desc').textContent = idHint + (it.desc || '');
      const itemKey = isSkill ? it.name : it.file;
      row.querySelector('[data-action="detail"]').addEventListener('click', () => {
        renderManagedMarkdownEditor(kind, itemKey, label);
      });
      if (!isSkill) {
        row.querySelector('[data-action="rename"]').addEventListener('click', async () => {
          const nv = await customPrompt({
            title: '重命名 Agent',
            message: `给这个 Agent 起一个方便辨认的名字(只改显示名，不影响 Agent 本身)。真实 id：${it.name}`,
            value: it.displayName || it.name,
            placeholder: it.name,
          });
          if (nv === null) return;  // 取消
          const r = await window.api.data.renameAgent(it.file, nv);
          if (r && r.ok) { showToast('已重命名'); renderList(r.items); }
          else showToast((r && r.message) || '重命名失败');
        });
      }
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const ok = await customConfirm({
          title: `删除${isSkill ? '技能' : ' Agent'}`,
          message: `确定删除「${label}」？此操作会从磁盘移除，无法恢复。`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = isSkill ? await window.api.data.removeSkill(it.name)
                          : await window.api.data.removeAgent(it.file);
        if (r && r.ok) { showToast('已删除'); renderList(r.items); }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);
      list.appendChild(row);
    });
  };

  bindPackageImportZone(importZone, kind, (r) => renderList(r.items));

  const refresh = async () => {
    const res = isSkill ? await window.api.data.listSkills() : await window.api.data.listAgents();
    if (!res || res.ok === false) throw new Error(res?.message || '列表读取失败');
    if (mount.isConnected) renderList(res.items);
  };
  await refresh();
  return { refresh };
}

// MCP 服务器管理面板(结构化:真实状态 + 热重连 + 即时启停 + 删除)。mount = #mcpSection 容器。
//   启用态来自 .claude.json 的 mcpServers,禁用态来自 sidecar 键;启停 = 在两者间搬运(见主进程 mcp:toggle)。
//   配置仍只读写 mcpServers/sidecar；运行态通过 Claude SDK Query 控制通道管理。
async function renderMcpPanel(mount) {
  let permissionPickers = [];
  const q = (sel) => mount.querySelector(sel);
  mount.innerHTML = `
    <div class="set-toolbar">
      <span class="set-toolbar-count" data-count></span>
      <button class="set-toolbar-btn" type="button" data-mcp-sync><span>↻ 同步配置</span></button>
      <button class="set-toolbar-btn" type="button" data-mcp-reconnect title="仅在热重连无法恢复时使用"><span>重建会话</span></button>
    </div>
    <div class="set-panel dp-list" data-list></div>
  `;

  const statusLabels = {
    connected: '已连接',
    failed: '连接失败',
    'needs-auth': '需要授权',
    pending: '连接中',
    disabled: '已停用',
    unknown: '等待连接',
    unavailable: '会话未启动',
    checking: '读取状态…',
    'status-error': '状态不可用',
  };
  let runtimeAvailable = false;
  let runtimeBusy = false;
  let runtimeChecking = false;
  let runtimeError = '';
  let runtimeMap = new Map();
  let loadSequence = 0;

  const currentConvId = () => (currentConv && currentConv.id) || null;
  const canControl = () => !!currentConvId() && !isConvRunning(currentConvId());

  q('[data-mcp-reconnect]').addEventListener('click', (e) => resetCurrentMcpSession(e.currentTarget));
  q('[data-mcp-sync]').addEventListener('click', async (e) => {
    if (!currentConvId()) { showToast('请先打开一个已有对话'); return; }
    if (!canControl()) { showToast('当前对话还在回复中，请结束后再同步'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('is-loading');
    const label = btn.querySelector('span');
    if (label) label.textContent = '正在同步…';
    try {
      const r = await window.api.mcp.sync(currentConvId());
      if (!r || !r.ok) { showToast((r && r.message) || '同步失败'); return; }
      showToast(r.result && r.result.errors && Object.keys(r.result.errors).length
        ? '配置已同步，部分服务连接失败'
        : 'MCP 配置已同步到当前对话');
      await loadPanel();
    } catch (err) {
      showToast((err && err.message) || '同步失败');
    } finally {
      btn.classList.remove('is-loading');
      if (label) label.textContent = '↻ 同步配置';
      btn.disabled = !canControl();
    }
  });
  syncMcpReconnectButtons();

  const renderList = (items) => {
    for (const picker of permissionPickers) picker.destroy(); permissionPickers = [];
    const list = q('[data-list]');
    const count = q('[data-count]');
    if (count) count.textContent = `${items ? items.length : 0} 个 MCP 服务器`;
    if (!items || !items.length) {
      list.innerHTML = `<div class="dp-empty">还没有 MCP 服务器。可在「Claude 设置文件」或 <code>~/.claude.json</code> 里添加。</div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item';
      const rt = runtimeMap.get(it.name) || null;
      const runtimeStatus = it.enabled
        ? (runtimeChecking ? 'checking'
          : (runtimeError ? 'status-error'
            : (runtimeAvailable ? ((rt && rt.status) || 'unknown') : 'unavailable')))
        : 'disabled';
      const reconnectDisabled = !it.enabled || !runtimeAvailable || runtimeBusy || !canControl();
      row.innerHTML = `
        <div class="set-icon ico-mcp">🔗</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc mcp-item-meta">
            <span class="mcp-state" data-state></span>
            <span class="mcp-summary" data-summary></span>
          </div>
        </div>
        <div class="dp-item-actions">
          <button class="mcp-row-reconnect" type="button" data-reconnect aria-label="重连 MCP" title="重连此 MCP" ${reconnectDisabled ? 'disabled' : ''}>↻</button>
          <div class="switch ${it.enabled ? 'on' : ''}" data-toggle title="${it.enabled ? '已启用,点击停用' : '已停用,点击启用'}"></div>
          <div class="dp-menu-wrap">
            <button class="dp-more" type="button" aria-label="更多操作">···</button>
            <div class="dp-menu">
              <button type="button" class="danger" data-action="delete">删除</button>
            </div>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.name;
      if (window.RelayMcpPermissionControls && window.api.mcp.setPermission) {
        permissionPickers.push(window.RelayMcpPermissionControls.create({
          mount: row.querySelector('.dp-item-actions'), name: it.name, mode: it.permissionModeOverride,
          onChange: ({ name, mode }) => window.api.mcp.setPermission(name, mode), notify: showToast,
        }));
      }
      const stateEl = row.querySelector('[data-state]');
      stateEl.className = `mcp-state ${runtimeStatus}`;
      stateEl.textContent = statusLabels[runtimeStatus] || statusLabels.unknown;
      if (rt && rt.toolCount > 0 && runtimeStatus === 'connected') stateEl.textContent += ` · ${rt.toolCount} 个工具`;
      if (rt && rt.error) stateEl.title = rt.error;
      else if (runtimeError && runtimeStatus === 'status-error') stateEl.title = runtimeError;
      const summaryEl = row.querySelector('[data-summary]');
      summaryEl.textContent = it.summary || '';
      if (!summaryEl.textContent) summaryEl.hidden = true;

      const reconnect = async () => {
        if (reconnectDisabled) return;
        const buttons = [row.querySelector('[data-reconnect]')];
        buttons.forEach((button) => { if (button) button.disabled = true; });
        try {
          const r = await window.api.mcp.reconnect(currentConvId(), it.name);
          if (!r || !r.ok) { showToast((r && r.message) || `重连「${it.name}」失败`); return; }
          showToast(`已请求重连「${it.name}」`);
          await loadPanel();
        } catch (err) {
          showToast((err && err.message) || `重连「${it.name}」失败`);
        } finally {
          buttons.forEach((button) => { if (button && button.isConnected) button.disabled = reconnectDisabled; });
        }
      };
      row.querySelector('[data-reconnect]').addEventListener('click', reconnect);

      // 启停开关:乐观切换 + 失败回滚(与「开机自启」开关一致的即时生效风格)
      const sw = row.querySelector('[data-toggle]');
      sw.addEventListener('click', async () => {
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        try {
          const r = await window.api.mcp.toggle(it.name, next, currentConvId());
          if (r && r.ok) {
            showToast(r.liveApplied
              ? `${next ? '已启用' : '已停用'}，当前对话已生效`
              : ((r && r.message) || `${next ? '已启用' : '已停用'}，将在下次会话启动时生效`));
            await loadPanel();
          } else {
            sw.classList.toggle('on', !next);
            showToast((r && r.message) || '操作失败');
          }
        } catch (err) {
          sw.classList.toggle('on', !next);
          showToast((err && err.message) || '操作失败');
        }
      });

      row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await customConfirm({
          title: '删除 MCP 服务器',
          message: `「${it.name}」将从 ~/.claude.json 永久移除，无法恢复。`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.mcp.remove(it.name, currentConvId());
        if (r && r.ok) {
          showToast(r.liveApplied ? '已删除，当前对话已生效' : ((r && r.message) || '已删除'));
          await loadPanel();
        }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);

      list.appendChild(row);
    });
  };

  async function loadPanel() {
    const sequence = ++loadSequence;
    const convId = currentConvId();
    const res = await window.api.mcp.list();
    if (!res || res.ok === false) throw new Error(res?.message || 'MCP 列表读取失败');
    if (sequence !== loadSequence || !mount.isConnected) return;
    runtimeChecking = !!convId;
    runtimeAvailable = false;
    runtimeBusy = false;
    runtimeError = '';
    runtimeMap = new Map();
    renderList((res && res.items) || []);

    const syncBtn = q('[data-mcp-sync]');
    if (syncBtn && !syncBtn.classList.contains('is-loading')) {
      syncBtn.disabled = !convId || !canControl();
      syncBtn.title = !convId
        ? '请先打开一个已有对话'
        : (!canControl() ? '当前对话还在回复中' : '读取磁盘配置并同步到当前 Claude 会话');
    }
    syncMcpReconnectButtons();

    if (!convId) {
      runtimeChecking = false;
      renderList((res && res.items) || []);
      return;
    }
    const runtime = await window.api.mcp.status(convId).catch((err) => ({ ok: false, message: err && err.message }));
    if (sequence !== loadSequence || !mount.isConnected) return;
    runtimeChecking = false;
    runtimeAvailable = !!(runtime && runtime.available);
    runtimeBusy = !!(runtime && runtime.busy);
    runtimeError = runtime && !runtime.ok ? (runtime.message || '读取 MCP 状态失败') : '';
    runtimeMap = new Map(((runtime && runtime.items) || []).map((item) => [item.name, item]));
    renderList((res && res.items) || []);
    if (syncBtn && !syncBtn.classList.contains('is-loading')) syncBtn.disabled = !canControl() || runtimeBusy;
  }

  await loadPanel();
  return { refresh: loadPanel, destroy() { for (const picker of permissionPickers) picker.destroy(); permissionPickers = []; } };
}

const MAINTENANCE_MODEL_OPTIONS = [
  { value: 'haiku', label: '快速' },
  { value: 'sonnet', label: '思考' },
  { value: 'opus', label: '专家' },
];
const MAINTENANCE_MODEL_VALUES = new Set(MAINTENANCE_MODEL_OPTIONS.map((item) => item.value));

async function getMaintenanceModel(settingKey, builtin, fallback = 'opus') {
  let configured = '';
  let taskModel = '';
  try {
    const [settings, tasks] = await Promise.all([
      window.api.settings.read(),
      window.api.scheduler.list(),
    ]);
    configured = settings && settings.app && MAINTENANCE_MODEL_VALUES.has(settings.app[settingKey])
      ? settings.app[settingKey]
      : '';
    const task = tasks && tasks.ok
      ? (tasks.items || []).find((item) => item.builtin === builtin)
      : null;
    taskModel = task && task.action && MAINTENANCE_MODEL_VALUES.has(task.action.model)
      ? task.action.model
      : '';
  } catch (_) {}
  // 已存在的任务代表当前真正会执行的模型；首次升级时据此无闪烁迁移。
  return taskModel || configured || fallback;
}

async function saveMaintenanceModel(settingKey, model) {
  if (!MAINTENANCE_MODEL_VALUES.has(model)) return { ok: false };
  return window.api.settings.write({ app: { [settingKey]: model } });
}

function skillDraftErrorMessage(result, fallback = '操作失败') {
  const code = result && result.code;
  const friendly = {
    BASE_CONFLICT: '当前技能已变化，请基于当前版本重新整理这份更新',
    CURRENT_CHANGED: '当前技能又有变化，请重新比较后再提交',
    REBASE_STALE: '当前技能又有变化，请重新比较后再提交',
    REBASE_CONFLICT: '这些文件存在冲突，请选择要保留的内容',
    DRAFT_INVALID: '草稿没有通过校验，暂时不能发布',
    DRAFT_NOT_FOUND: '这个草稿已不存在，列表将自动刷新',
    INVALID_DRAFT_STATE: '这个草稿已经处理过了',
    ROLLBACK_CONFLICT: '当前技能已发生变化，无法安全回滚到这个版本',
  };
  return friendly[code] || (result && (result.error || result.message)) || fallback;
}

function describeSkillDraftSource(draft) {
  const source = draft && draft.sourceRef;
  if (!source) return '未知来源';
  if (typeof source === 'string') return source;
  const typeLabels = {
    'conversation-review': '对话自动回看',
    'skill-curator': '技能库体检',
    'draft-rebase': '基于当前版本重新整理',
    rebase: '基于当前版本重新整理',
    import: '导入',
    manual: '手动创建',
  };
  const parts = [typeLabels[source.type] || source.type || '未知来源'];
  if (source.triggerReason) parts.push(String(source.triggerReason));
  else if (source.conversationId) parts.push(`对话 ${source.conversationId}`);
  return parts.join(' · ');
}

function summarizeSkillDraftChanges(changes) {
  const value = changes || {};
  const groups = [
    ['新增', value.added],
    ['修改', value.modified],
    ['删除', value.removed],
    ['权限变化', value.modeChanged],
  ];
  const visible = groups.filter(([, files]) => Array.isArray(files) && files.length);
  return {
    text: visible.length ? visible.map(([label, files]) => `${label} ${files.length}`).join(' · ') : '无文件变更',
    title: visible.map(([label, files]) => `${label}：${files.join('、')}`).join('\n'),
  };
}

function skillDraftValidationSummary(validation) {
  const errors = Array.isArray(validation && validation.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation && validation.warnings) ? validation.warnings : [];
  const passed = !validation || validation.ok !== false;
  return {
    passed,
    text: passed
      ? (warnings.length ? `校验通过 · ${warnings.length} 条提醒` : '校验通过')
      : `校验未通过 · ${errors.length || 1} 个问题`,
    title: [...errors, ...warnings].map((item) => item && (item.message || item.code)).filter(Boolean).join('\n'),
  };
}

function skillDraftUiState(draft) {
  const status = draft.status || 'draft';
  const completed = { published: '已发布', rejected: '已忽略', superseded: '已重新整理', merged: '已合并' };
  if (status !== 'draft') return { key: status, label: completed[status] || '已处理', processed: true, canPublish: false, canRebase: false };
  const invalid = draft.readiness === 'invalid' || draft.validation?.ok === false;
  if (!invalid && draft.readiness === 'already_applied') return { key: 'already_applied', label: '当前版本已包含', processed: true, canPublish: false, canRebase: false };
  const stale = draft.readiness === 'stale' || draft.baseMatches === false;
  if (invalid) return { key: 'invalid', label: '结构需要修复', processed: false, canPublish: false, canRebase: stale };
  if (stale) return { key: 'stale', label: '当前版本已变化', processed: false, canPublish: false, canRebase: true };
  const ready = draft.canPublish !== false;
  return { key: ready ? 'ready' : 'unavailable', label: ready ? '可以发布' : '暂不可发布', processed: false, canPublish: ready, canRebase: false };
}

function groupSkillDraftUpdates(drafts) {
  const groups = new Map(), processed = [];
  const newestFirst = (a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''));
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    if (!draft || !draft.id) continue;
    if (skillDraftUiState(draft).processed) { processed.push(draft); continue; }
    const name = draft.skillName || '未命名技能';
    if (!groups.has(name)) groups.set(name, { skillName: name, records: [], candidates: [] });
    groups.get(name).records.push(draft);
  }
  for (const group of groups.values()) {
    const contents = new Map();
    group.records.sort(newestFirst);
    for (const draft of group.records) {
      const key = draft.proposed?.treeHash || draft.fingerprint || draft.id;
      if (!contents.has(key)) contents.set(key, []);
      contents.get(key).push(draft);
    }
    for (const records of contents.values()) {
      // An older record of identical content may still have the current base.
      // Prefer the publishable record without discarding any other candidate.
      const primary = records.find(draft => skillDraftUiState(draft).canPublish) || records[0];
      group.candidates.push({ draft: primary, duplicates: records.filter(draft => draft !== primary), sourceCount: records.reduce((total, draft) => total + Math.max(1, Number(draft.sourceCount) || 1), 0) });
    }
  }
  return { groups: [...groups.values()].sort((a, b) => newestFirst(a.records[0], b.records[0])), processed: processed.sort(newestFirst) };
}

async function openSkillDraftRebase(draft, onChanged) {
  const api = window.api?.skillDrafts;
  if (typeof api?.rebase !== 'function') { showToast('当前版本暂不支持重新整理'); return; }
  const resultValue = response => response?.result || response;
  const completed = async response => {
    const result = resultValue(response);
    showToast(result.alreadyApplied ? '当前技能已包含这些内容，记录已归入已处理' : '已生成新的待审核更新，请查看差异后发布');
    await onChanged();
  };
  const request = options => api.rebase(draft.id, options || {});
  let response;
  try { response = await request(); }
  catch (error) { showToast(error.message || '重新整理失败'); return; }
  if (response?.ok && resultValue(response)?.ok !== false) { await completed(response); return; }
  if (response?.code !== 'REBASE_CONFLICT' || !Array.isArray(response.details?.conflicts)) {
    showToast(skillDraftErrorMessage(response, '重新整理失败')); await onChanged(); return;
  }

  const origin = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay show skill-rebase-overlay';
  overlay.innerHTML = `<section class="preview-box skill-rebase-box" role="dialog" aria-modal="true" aria-label="整理技能更新">
    <header class="preview-head"><div class="preview-title"></div><div class="dp-head-spacer"></div><button class="preview-close" type="button" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div class="skill-rebase-body"><p class="skill-rebase-explanation">这些文件在当前技能与草稿中都有变化。逐项选择要保留的内容，整理后会生成新的待审核更新。</p><div data-rebase-files></div></div>
    <footer class="skill-rebase-footer"><p data-rebase-status role="status"></p><button class="row-btn" type="button" data-rebase-reload hidden>重新比较</button><button class="row-btn" type="button" data-rebase-cancel>取消</button><button class="btn-primary" type="button" data-rebase-save disabled>生成待审核更新</button></footer>
  </section>`;
  overlay.querySelector('.preview-title').textContent = `${draft.skillName} · 整理更新`;
  const files = overlay.querySelector('[data-rebase-files]'), notice = overlay.querySelector('[data-rebase-status]');
  const save = overlay.querySelector('[data-rebase-save]'), refresh = overlay.querySelector('[data-rebase-reload]');
  let plan = response.details, busy = false, outdated = false;
  const choices = new Map(), edits = new Map();
  const updateReady = (updateNotice = true) => {
    save.disabled = busy || outdated || plan.conflicts.some(conflict => !choices.has(conflict.path));
    if (updateNotice && !busy && !outdated) notice.textContent = `已处理 ${choices.size} / ${plan.conflicts.length} 个冲突文件`;
  };
  const close = () => {
    if (busy) return;
    document.removeEventListener('keydown', keyHandler); overlay.remove();
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  };
  const keyHandler = event => {
    if (!overlay.isConnected || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)')].filter(node => node.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const setBusy = value => {
    busy = value;
    overlay.setAttribute('aria-busy', String(value));
    overlay.querySelectorAll('button,textarea').forEach(button => { button.disabled = value; });
    updateReady(false);
  };
  const renderPlan = () => {
    choices.clear(); files.replaceChildren();
    for (const conflict of plan.conflicts) {
      const item = document.createElement('section'); item.className = 'skill-rebase-file'; item.dataset.conflictPath = conflict.path;
      const heading = document.createElement('h3'); heading.textContent = conflict.path;
      const versions = document.createElement('div'); versions.className = 'skill-rebase-versions';
      for (const [key, label] of [['base', '原始版本'], ['current', '当前技能'], ['proposed', '草稿内容']]) {
        const column = document.createElement('div');
        const title = document.createElement('h4'); title.textContent = label;
        const text = document.createElement('pre'), version = conflict.versions?.[key];
        text.dataset.version = key;
        if (version?.exists === false) text.textContent = '此版本中不存在';
        else if (version?.kind === 'directory') text.textContent = '文件夹，请选择保留的版本';
        else if (typeof conflict[key] === 'string') text.textContent = conflict[key];
        else if (version?.size > 256 * 1024) text.textContent = '文件较大，无法在此预览';
        else if (version?.exists || conflict.binary) text.textContent = '二进制文件，无法以文本预览';
        else text.textContent = '此版本中不存在';
        column.append(title, text); versions.append(column);
      }
      const controls = document.createElement('div'); controls.className = 'skill-rebase-choices'; controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `${conflict.path} 的处理方式`);
      const textEditable = !conflict.binary && !conflict.structural;
      const editor = document.createElement('textarea'); editor.className = 'skill-rebase-editor'; editor.hidden = true; editor.spellcheck = false;
      editor.setAttribute('aria-label', `编辑 ${conflict.path} 的合并内容`);
      editor.value = edits.has(conflict.path) ? edits.get(conflict.path) : String(conflict.proposed ?? conflict.current ?? '');
      editor.addEventListener('input', () => { edits.set(conflict.path, editor.value); });
      for (const [choice, label] of [['current', '保留当前'], ['proposed', '采用草稿'], ...(textEditable ? [['edit', '手动编辑']] : [])]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'row-btn'; button.dataset.resolution = choice; button.textContent = label; button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          choices.set(conflict.path, choice);
          controls.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
          editor.hidden = choice !== 'edit';
          if (choice === 'edit') { edits.set(conflict.path, editor.value); editor.focus({ preventScroll: true }); }
          updateReady();
        });
        controls.append(button);
      }
      item.append(heading, versions, controls, editor); files.append(item);
    }
    updateReady();
  };
  const handleResponse = async next => {
    if (next?.ok && resultValue(next)?.ok !== false) {
      setBusy(false); close(); await completed(next); return true;
    }
    if (next?.code === 'REBASE_CONFLICT' && Array.isArray(next.details?.conflicts)) {
      plan = next.details; outdated = false; refresh.hidden = true; renderPlan();
      notice.textContent = '当前比较已更新，请重新选择处理方式。手动编辑内容仍保留。';
    } else {
      outdated = true; refresh.hidden = false;
      notice.textContent = skillDraftErrorMessage(next, '生成未完成，请重新比较后重试');
    }
    await onChanged(); return false;
  };
  save.addEventListener('click', async () => {
    if (busy || save.disabled) return;
    const resolutions = Object.fromEntries([...choices].map(([path, choice]) => [path, choice === 'edit' ? { text: edits.get(path) || '' } : { choice }]));
    setBusy(true); notice.textContent = '正在生成待审核更新…';
    try { await handleResponse(await request({ expectedCurrentTreeHash: plan.currentTreeHash, resolutions })); }
    catch (error) { notice.textContent = error.message || '生成失败，请重试'; }
    finally { if (overlay.isConnected) { setBusy(false); if (outdated) save.disabled = true; } }
  });
  refresh.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); notice.textContent = '正在重新比较…';
    try { await handleResponse(await request()); }
    catch (error) { notice.textContent = error.message || '比较失败，请重试'; }
    finally { if (overlay.isConnected) setBusy(false); }
  });
  overlay.querySelector('.preview-close').addEventListener('click', close);
  overlay.querySelector('[data-rebase-cancel]').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  renderPlan(); document.body.append(overlay); document.addEventListener('keydown', keyHandler);
  overlay.querySelector('.preview-close').focus();
}

async function openSkillDraftDiff(draft) {
  const api = window.api && window.api.skillDrafts;
  if (!api || typeof api.diff !== 'function') {
    showToast('当前版本暂不支持查看草稿差异');
    return;
  }
  let response;
  try { response = await api.diff(draft.id); }
  catch (error) { showToast((error && error.message) || '读取差异失败'); return; }
  if (!response || response.ok === false || !response.diff) {
    showToast(skillDraftErrorMessage(response, '读取差异失败'));
    return;
  }

  const diff = response.diff;
  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay show';
  overlay.innerHTML = `
    <div class="preview-box" role="dialog" aria-modal="true" aria-label="Skill 草稿差异">
      <div class="preview-head">
        <div class="preview-title"></div>
        <div class="row-status" data-diff-summary></div>
        <div class="dp-head-spacer"></div>
        <button class="preview-close" type="button" title="关闭" aria-label="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="preview-body"><pre class="pv-code"><code></code></pre></div>
    </div>
  `;
  overlay.querySelector('.preview-title').textContent = `${draft.skillName} · 完整包差异`;
  overlay.querySelector('[data-diff-summary]').textContent = diff.changed
    ? `+${diff.additions || 0} / -${diff.deletions || 0}`
    : '文件内容未变化';
  const code = overlay.querySelector('.pv-code code');
  const source = diff.text || '完整技能包没有可显示的文本差异。';
  if (typeof hljs !== 'undefined') {
    try {
      code.innerHTML = hljs.highlight(source, { language: 'diff', ignoreIllegals: true }).value;
      code.className = 'hljs language-diff';
    } catch (_) { code.textContent = source; }
  } else code.textContent = source;

  const keyHandler = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  const close = () => {
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  };
  overlay.querySelector('.preview-close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', keyHandler);
  document.body.appendChild(overlay);
  overlay.querySelector('.preview-close').focus();
}

async function openSkillVersionHistory(skillName, onRolledBack = null) {
  const api = window.api && window.api.skillDrafts;
  if (!api || typeof api.history !== 'function') {
    showToast('当前版本暂不支持技能版本历史');
    return;
  }
  let response;
  try { response = await api.history(skillName); }
  catch (error) { showToast((error && error.message) || '读取版本历史失败'); return; }
  if (!response || response.ok === false) {
    showToast(skillDraftErrorMessage(response, '读取版本历史失败'));
    return;
  }
  const versions = Array.isArray(response) ? response : (response.items || []);
  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay show';
  overlay.innerHTML = `
    <div class="preview-box" role="dialog" aria-modal="true" aria-label="技能版本历史">
      <div class="preview-head">
        <div class="preview-title"></div>
        <div class="row-status" data-history-count></div>
        <div class="dp-head-spacer"></div>
        <button class="preview-close" type="button" title="关闭" aria-label="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="preview-body" data-history-body></div>
    </div>
  `;
  overlay.querySelector('.preview-title').textContent = `${skillName} · 版本历史`;
  overlay.querySelector('[data-history-count]').textContent = `${versions.length} 个版本`;
  const body = overlay.querySelector('[data-history-body]');
  body.style.overflow = 'auto';
  body.style.padding = '18px';

  const keyHandler = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  const close = () => {
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  };
  overlay.querySelector('.preview-close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', keyHandler);

  if (!versions.length) {
    body.innerHTML = '<div class="dp-empty">暂无可回滚版本；发布草稿时会自动保留发布前版本。</div>';
  } else {
    const list = document.createElement('div');
    list.className = 'set-panel dp-list';
    versions.forEach((version) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item';
      const reasonLabels = { 'publish-preimage': '发布前版本', 'rollback-preimage': '回滚前备份' };
      const captured = version.capturedAt ? new Date(version.capturedAt) : null;
      const capturedText = captured && !Number.isNaN(captured.getTime())
        ? captured.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '时间未知';
      const fileCount = Array.isArray(version.snapshot && version.snapshot.files)
        ? version.snapshot.files.length : 0;
      const canRollback = !!version.replacedBy && !version.rollback;
      row.innerHTML = `
        <div class="set-icon ico-history">↩</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
        </div>
        <div class="dp-item-actions">
          <button class="row-btn" type="button" data-rollback></button>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = `${reasonLabels[version.reason] || '历史版本'} · ${capturedText}`;
      row.querySelector('.dp-item-desc').textContent = version.snapshot && version.snapshot.exists
        ? `${fileCount} 个文件 · ${version.id}`
        : `技能尚不存在 · ${version.id}`;
      const rollbackButton = row.querySelector('[data-rollback]');
      rollbackButton.style.marginLeft = '0';
      rollbackButton.textContent = version.rollback ? '已回滚' : (canRollback ? '回滚到此版本' : '不可回滚');
      rollbackButton.disabled = !canRollback;
      rollbackButton.addEventListener('click', async () => {
        const removesSkill = !(version.snapshot && version.snapshot.exists);
        const ok = await customConfirm({
          title: removesSkill ? `回滚并移除「${skillName}」？` : `回滚「${skillName}」？`,
          message: removesSkill
            ? '这个版本记录的是技能创建前的状态。回滚会移除当前技能，并先保存一份当前版本作为备份。'
            : '当前技能会先保存为一个可恢复版本，再替换为所选历史版本。',
          confirmText: '确认回滚', cancelText: '取消', danger: removesSkill,
        });
        if (!ok) return;
        rollbackButton.disabled = true;
        rollbackButton.textContent = '正在回滚…';
        try {
          const result = await api.rollback(skillName, version.id, {});
          if (!result || result.ok === false) {
            showToast(skillDraftErrorMessage(result, '回滚失败'));
            rollbackButton.disabled = false;
            rollbackButton.textContent = '回滚到此版本';
            return;
          }
          showToast(`已回滚技能「${skillName}」`);
          close();
          if (typeof onRolledBack === 'function') await onRolledBack();
        } catch (error) {
          showToast((error && error.message) || '回滚失败');
          if (rollbackButton.isConnected) {
            rollbackButton.disabled = false;
            rollbackButton.textContent = '回滚到此版本';
          }
        }
      });
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  document.body.appendChild(overlay);
  overlay.querySelector('.preview-close').focus();
}

// 合并同一批通知和操作回调；读取期间的新通知必须留下下一轮刷新。
// hold 用于保留确认/提交中的行，既不提前读取旧状态，也不让迟到响应重建 busy 行。
function createSkillPanelRefreshQueue({ load, render, onError, isConnected }) {
  let pending = false, pendingOptions = {}, revision = 0, holds = 0, running = false, timer = null;
  let waiters = [];
  const mergeOptions = (left, right) => ({ ...left, ...right,
    refresh: left.refresh === true || right.refresh === true,
    throwOnError: left.throwOnError === true || right.throwOnError === true,
  });
  const settle = error => {
    const current = waiters; waiters = [];
    current.forEach(({ resolve, reject }) => error ? reject(error) : resolve());
  };
  const schedule = () => {
    if (running || timer !== null || holds || !pending) return;
    timer = setTimeout(drain, 32);
  };
  const drain = async () => {
    timer = null;
    if (holds || running || !pending) return;
    if (!isConnected()) { pending = false; pendingOptions = {}; settle(); return; }
    const options = pendingOptions, startedRevision = revision;
    pending = false; pendingOptions = {}; running = true;
    let failure;
    try {
      const result = await load(options);
      if (holds || revision !== startedRevision) {
        // A completed read cannot cover invalidations that arrived after it began.
        pending = true;
      } else if (isConnected()) render(result, options);
    } catch (error) {
      failure = error;
      if (holds || revision !== startedRevision) pending = true;
      else if (isConnected()) onError(error, options);
    } finally {
      running = false;
      if (pending) schedule(); else settle(failure);
    }
  };
  const invalidate = (options = {}) => {
    pending = true; revision++; pendingOptions = mergeOptions(pendingOptions, options); schedule();
  };
  return {
    invalidate,
    whenIdle() {
      return pending || running
        ? new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        : Promise.resolve();
    },
    request(options = {}) {
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      invalidate(options); return promise;
    },
    hold() {
      holds++;
      let released = false;
      return () => { if (!released) { released = true; holds--; schedule(); } };
    },
  };
}

// 技能 Curator 面板:在"导入/列表/删除"基础上,补用量遥测(从 transcript 现算)+ 闲置标记 +
//   置顶(pin)/归档/恢复。状态机只标记不自动归档;归档是移动到 .archive/(可恢复)。
//   mount = #skillSection 容器。
async function renderSkillCuratorPanel(mount) {
  const q = (sel) => mount.querySelector(sel);
  const STALE_OPTS = [
    { value: '14', label: '14 天' }, { value: '30', label: '30 天' },
    { value: '60', label: '60 天' }, { value: '90', label: '90 天' },
  ];
  // 'YYYY-MM-DD...' → 'M/D';无则 '—'
  const fmtDay = (iso) => { if (!iso) return '—'; const p = (iso.slice(0, 10)).split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : '—'; };
  // 体检时间下拉(半小时粒度,默认凌晨 03:00 跑,避开使用高峰)
  const curTimeOpts = [];
  for (let h = 0; h < 24; h++) for (const mm of [0, 30]) {
    const v = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    curTimeOpts.push({ value: v, label: v });
  }

  // 先用最近快照（首次则用稳定默认值）同步画出完整框架；真实配置并行读取后无动画回填。
  // 技能列表和这些维护设置互不依赖，不能再让多轮 IPC 挡住列表首屏。
  let reviewCfg = skillPanelConfigCache && skillPanelConfigCache.reviewCfg
    ? { ...skillPanelConfigCache.reviewCfg }
    : { enabled: true, everyTurns: 6, autoArchive: false };
  let curatorModel = skillPanelConfigCache && MAINTENANCE_MODEL_VALUES.has(skillPanelConfigCache.curatorModel)
    ? skillPanelConfigCache.curatorModel
    : 'opus';
  const panelConfigPromise = Promise.all([
    window.api.skills.getReviewConfig().catch(() => null),
    getMaintenanceModel('skillMaintenanceModel', 'skill-curator', 'opus'),
  ]);

  mount.innerHTML = `
    ${buildPackageImportZone('skill')}
    <div class="set-toolbar">
      <span class="set-toolbar-count" data-skill-count></span>
    </div>

    <section class="plugins-maintenance skill-maintenance" aria-label="技能维护">
      <section class="skill-maintenance-group">
        <h3 class="set-section-head skill-auto-head">对话学习</h3>
        <div class="set-panel mem-auto-panel">
          <div class="set-row">
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6m-5 3h4M8.6 14.5a6 6 0 1 1 6.8 0c-.9.6-1.4 1.3-1.4 2.5h-4c0-1.2-.5-1.9-1.4-2.5Z"/></svg></div>
            <div class="set-label">自动提炼技能<div class="set-sub">从纠正和完成的任务中提出改进，确认后生效。</div></div>
            <button class="switch ${reviewCfg.enabled ? 'on' : ''}" type="button" role="switch" aria-checked="${!!reviewCfg.enabled}" data-review-on aria-label="自动提炼技能"></button>
          </div>
          <div class="set-row" data-review-freq-row${reviewCfg.enabled ? '' : ' style="opacity:0.45"'}>
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/></svg></div>
            <div class="set-label">定期回顾<div class="set-sub">没有明显改进信号时，按轮次补充检查。</div></div>
            ${buildCustomSelect('skill-review-every', [
              { value: '4', label: '每 4 轮' }, { value: '6', label: '每 6 轮' },
              { value: '10', label: '每 10 轮' }, { value: '20', label: '每 20 轮' },
            ], String(reviewCfg.everyTurns || 6))}
          </div>
        </div>
      </section>
      <section class="skill-maintenance-group">
        <h3 class="set-section-head">闲置管理</h3>
        <div class="set-panel">
          <div class="set-row">
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
            <div class="set-label">标记闲置<div class="set-sub">达到此时间后只标记，不会自动归档。</div></div>
            ${buildCustomSelect('skill-stale-days', STALE_OPTS, '30')}
          </div>
          <div class="set-row">
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/></svg></div>
            <div class="set-label">自动归档<div class="set-sub" data-skill-archive-description>连续 ${reviewCfg.archiveDays || 90} 天未使用、查看或更新后，在空闲时归档；可随时恢复。</div></div>
            <button class="switch ${reviewCfg.autoArchive ? 'on' : ''}" type="button" role="switch" aria-checked="${!!reviewCfg.autoArchive}" data-skill-auto-archive aria-label="自动归档闲置技能"></button>
          </div>
        </div>
      </section>
      <section class="skill-maintenance-group">
        <h3 class="set-section-head">定期检查</h3>
        <div class="set-panel">
          <div class="set-row skill-maintenance-run-row">
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6v4H9zM9 6H6v15h12V6h-3m-6 8 2 2 4-4"/></svg></div>
            <div class="set-label">技能体检<div class="set-sub" data-cur-next></div></div>
            <div class="skill-maintenance-controls">
              ${buildSettingsSegmented('skill-cur-model', MAINTENANCE_MODEL_OPTIONS, curatorModel)}
              <button class="row-btn" type="button" data-cur-run>立即体检</button>
              <button class="switch" type="button" role="switch" aria-checked="false" data-cur-on aria-label="定期技能体检"></button>
            </div>
          </div>
          <div class="set-row" data-cur-sched-row>
            <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-11 4h2m2 0h2"/></svg></div>
            <div class="set-label">体检时间</div>
            <div class="skill-maintenance-controls">
              ${buildCustomSelect('skill-cur-dow', [
                { value: '1', label: '每周一' }, { value: '2', label: '每周二' }, { value: '3', label: '每周三' },
                { value: '4', label: '每周四' }, { value: '5', label: '每周五' }, { value: '6', label: '每周六' },
                { value: '0', label: '每周日' },
              ], '5')}
              ${buildCustomSelect('skill-cur-time', curTimeOpts, '10:00')}
            </div>
          </div>
        </div>
      </section>
    </section>
    <div class="set-panel dp-list" data-list></div>
    <div data-draft-review style="order:4;margin-top:20px">
      <div class="set-section-head">
        待处理更新
        <span class="set-section-spacer"></span>
        <span class="set-section-count" data-draft-count>读取中…</span>
        <button class="row-btn" type="button" data-draft-refresh>刷新</button>
      </div>
      <p class="skill-updates-hint">按技能整理候选更新，发布后才会生效。</p>
      <div class="skill-update-list" data-draft-list>
        <div class="dp-empty">正在读取更新…</div>
      </div>
      <details class="skill-updates-processed" data-draft-processed hidden><summary>已处理 <span data-draft-processed-count></span></summary><div data-draft-processed-list></div></details>
    </div>
    <div class="skill-arch" data-arch-wrap hidden>
      <div class="skill-arch-head" data-arch-toggle>
        <span data-arch-title>已归档</span>
        <svg class="skill-arch-chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="set-panel dp-list skill-arch-list" data-arch-list hidden></div>
    </div>
  `;
  const importZone = placePackageImportZone(mount);
  bindCustomSelects(mount);
  bindSettingsSegmented(mount);

  const draftApi = window.api && window.api.skillDrafts;

  const draftExpanded = new Set();
  const rememberExpansion = (details, key) => {
    details.open = draftExpanded.has(key);
    details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) draftExpanded.add(key); else draftExpanded.delete(key); } });
  };
  const refreshDraftState = () => {
    draftRefresh.invalidate(); overviewRefresh.invalidate({ refresh: false });
  };

  const renderDraftRow = (draft, options = {}) => {
    const row = document.createElement('div');
    row.className = 'set-row dp-item skill-update-candidate'; row.dataset.draftId = draft.id;
    let readiness = skillDraftUiState(draft);
    const validation = skillDraftValidationSummary(draft.validation);
    const changes = summarizeSkillDraftChanges(draft.changes);
    const operation = draft.operation === 'create' ? '新建技能' : '更新技能';
    row.innerHTML = `<div class="dp-item-main">
      <div class="skill-update-candidate-title"><span class="dp-item-name"></span><span class="skill-update-state" data-draft-readiness></span></div>
      <div class="dp-item-desc" data-draft-source></div><div class="skill-update-meta" data-draft-changes></div>
      <p class="skill-update-message" data-draft-message hidden></p>
    </div><div class="dp-item-actions">
      <button class="row-btn" type="button" data-action="diff">查看差异</button>
      <button class="row-btn" type="button" data-action="rebase" title="基于当前版本重新整理" hidden>重新整理</button>
      <button class="row-btn" type="button" data-action="publish">发布</button>
      <button class="row-btn" type="button" data-action="history" hidden>版本历史</button>
      <div class="dp-menu-wrap"><button class="dp-more" type="button" aria-label="更多草稿操作">···</button><div class="dp-menu"><button class="danger" type="button" data-action="reject">忽略这份草稿</button></div></div>
    </div>`;
    const timestamp = new Date(draft.createdAt || draft.updatedAt || '');
    const time = Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    row.querySelector('.dp-item-name').textContent = readiness.processed ? draft.skillName : [operation, time].filter(Boolean).join(' · ');
    const source = row.querySelector('[data-draft-source]');
    source.textContent = describeSkillDraftSource(draft); source.title = [source.textContent, draft.note].filter(Boolean).join('\n');
    row.querySelector('[data-draft-changes]').textContent = changes.text; row.querySelector('[data-draft-changes]').title = changes.title;
    const badge = row.querySelector('[data-draft-readiness]');
    const diffButton = row.querySelector('[data-action="diff"]'), publishButton = row.querySelector('[data-action="publish"]');
    const rebaseButton = row.querySelector('[data-action="rebase"]'), rejectButton = row.querySelector('[data-action="reject"]');
    const historyButton = row.querySelector('[data-action="history"]');
    const syncState = () => {
      row.dataset.readiness = readiness.key; badge.dataset.state = readiness.key; badge.textContent = readiness.label;
      badge.title = readiness.key === 'invalid' ? validation.title : readiness.key === 'stale' ? '正式技能已变化，需要先重新整理，避免覆盖后续修改。' : '';
      publishButton.hidden = readiness.processed; publishButton.disabled = !readiness.canPublish;
      publishButton.title = readiness.canPublish ? '发布前会保存可回滚版本' : readiness.label;
      rebaseButton.hidden = !readiness.canRebase;
      historyButton.hidden = !readiness.processed;
      row.querySelector('.dp-menu-wrap').hidden = readiness.processed;
    };
    syncState();
    if (!validation.passed && !readiness.processed) {
      const problems = document.createElement('details'); problems.className = 'skill-update-problems';
      const summary = document.createElement('summary'); summary.textContent = validation.text;
      const text = document.createElement('p'); text.textContent = validation.title || '请查看差异并修复技能包结构后，再生成更新。';
      problems.append(summary, text); row.querySelector('.dp-item-main').append(problems);
    }
    let releaseRefresh = null;
    const setBusy = value => {
      if (value && !releaseRefresh) {
        const releaseDraft = draftRefresh.hold(), releaseOverview = overviewRefresh.hold();
        releaseRefresh = () => { releaseDraft(); releaseOverview(); };
      } else if (!value && releaseRefresh) {
        releaseRefresh(); releaseRefresh = null;
      }
      row.dataset.busy = value ? '1' : '';
      row.querySelectorAll('button').forEach(button => { button.disabled = value; });
      if (!value) syncState();
    };
    const finishBusy = async () => {
      if (releaseRefresh) { releaseRefresh(); releaseRefresh = null; }
      // Keep the old row disabled until its replacement is ready; a slow list
      // must not expose a second publish/reject for the just-completed mutation.
      try { await Promise.all([draftRefresh.whenIdle(), overviewRefresh.whenIdle()]); }
      catch (_) { /* The refresh queues already display their read error. */ }
      finally { if (row.isConnected) setBusy(false); }
    };
    const failed = async (response, fallback) => {
      if (response?.code === 'BASE_CONFLICT' || response?.code === 'CURRENT_CHANGED') readiness = { ...readiness, key: 'stale', label: '当前版本已变化', canPublish: false, canRebase: true };
      else if (response?.code === 'DRAFT_INVALID') readiness = { ...readiness, key: 'invalid', label: '结构需要修复', canPublish: false };
      else if (['DRAFT_NOT_FOUND', 'INVALID_DRAFT_STATE'].includes(response?.code)) readiness = { ...readiness, canPublish: false };
      syncState();
      const message = row.querySelector('[data-draft-message]'); message.hidden = false; message.textContent = skillDraftErrorMessage(response, fallback);
      showToast(message.textContent);
      draftRefresh.invalidate();
    };
    diffButton.addEventListener('click', async () => { setBusy(true); try { await openSkillDraftDiff(draft); } finally { await finishBusy(); } });
    historyButton.addEventListener('click', () => openSkillVersionHistory(draft.skillName, refreshDraftState));
    rebaseButton.addEventListener('click', async () => {
      if (!readiness.canRebase) return;
      setBusy(true);
      try { await openSkillDraftRebase(draft, refreshDraftState); }
      finally { await finishBusy(); }
    });
    publishButton.addEventListener('click', async () => {
      if (!readiness.canPublish || row.dataset.busy) return;
      if (typeof draftApi?.publish !== 'function') { showToast('当前版本暂不支持发布 Skill 草稿'); return; }
      setBusy(true);
      try {
        if (typeof draftApi.validate === 'function') {
          const checked = await draftApi.validate(draft.id);
          if (!checked || checked.ok === false) { await failed(checked, '草稿校验失败'); return; }
          if (checked.validation?.ok === false) { await failed({ code: 'DRAFT_INVALID' }, '草稿需要修复'); return; }
          if (checked.validation?.readiness === 'stale' || checked.validation?.baseMatches === false) { await failed({ code: 'BASE_CONFLICT' }, '当前技能已变化'); return; }
          if (checked.validation?.readiness === 'already_applied') { draftRefresh.invalidate(); showToast('当前版本已包含这份更新'); return; }
        }
        const ok = await customConfirm({ title: `发布「${draft.skillName}」？`, message: `${operation}，${changes.text}。发布前会保存当前版本，之后可安全回滚。`, confirmText: '发布', cancelText: '取消' });
        if (!ok) return;
        const response = await draftApi.publish(draft.id);
        if (!response || response.ok === false) { await failed(response, '发布失败'); return; }
        showToast(`已发布技能「${draft.skillName}」`); await refreshDraftState();
      } catch (error) { showToast(error.message || '发布失败'); }
      finally { await finishBusy(); }
    });
    rejectButton.addEventListener('click', async () => {
      if (row.dataset.busy || typeof draftApi?.reject !== 'function') return;
      setBusy(true);
      try {
        const ok = await customConfirm({ title: `忽略「${draft.skillName}」的这份更新？`, message: '记录会移入已处理，不改动正式技能；其他候选仍然保留。', confirmText: '忽略', cancelText: '取消', danger: true });
        if (!ok) return;
        const response = await draftApi.reject(draft.id, '用户在插件页忽略技能草稿');
        if (!response || response.ok === false) { await failed(response, '忽略失败'); return; }
        showToast('更新已移入已处理'); draftRefresh.invalidate();
      } catch (error) { showToast(error.message || '忽略失败'); }
      finally { await finishBusy(); }
    });
    bindDpMenu(row);
    const entries = Array.isArray(draft.sources) && draft.sources.length ? draft.sources : [{ sourceRef: draft.sourceRef, note: draft.note }];
    const sourceCount = Math.max(1, Number(options.sourceCount) || 0, Number(draft.sourceCount) || 0, entries.reduce((total, entry) => total + Math.max(1, Number(entry.count) || 1), 0));
    if (sourceCount > 1 || options.duplicates?.length) {
      const records = document.createElement('details'); records.className = 'skill-update-sources';
      const summary = document.createElement('summary'); summary.textContent = `来源与记录 · ${sourceCount}`; records.append(summary);
      const sources = document.createElement('ul');
      entries.forEach(entry => { const item = document.createElement('li'); item.textContent = [describeSkillDraftSource(entry), entry.note].filter(Boolean).join(' · '); sources.append(item); });
      records.append(sources);
      for (const duplicate of options.duplicates || []) records.append(renderDraftRow(duplicate));
      rememberExpansion(records, `sources:${draft.id}`); row.querySelector('.dp-item-main').append(records);
    }
    return row;
  };

  const renderDrafts = drafts => {
    const list = q('[data-draft-list]'), count = q('[data-draft-count]');
    if (!list || !count) return;
    const { groups, processed } = groupSkillDraftUpdates(drafts);
    count.textContent = `${groups.length} 个技能 · ${groups.reduce((total, group) => total + group.candidates.length, 0)} 份候选`;
    list.replaceChildren();
    if (!groups.length) list.innerHTML = '<div class="dp-empty">没有待处理更新</div>';
    for (const group of groups) {
      const box = document.createElement('section'); box.className = 'skill-update-group'; box.dataset.skillGroup = group.skillName;
      const header = document.createElement('header'); header.className = 'skill-update-group-head';
      const title = document.createElement('h3'); title.textContent = group.skillName;
      const count = document.createElement('span'); count.textContent = `${group.candidates.length} 份候选`;
      header.append(title, count); box.append(header);
      const renderCandidate = candidate => renderDraftRow(candidate.draft, candidate);
      box.append(renderCandidate(group.candidates[0]));
      if (group.candidates.length > 1) {
        const more = document.createElement('details'); more.className = 'skill-update-alternatives';
        const summary = document.createElement('summary'); summary.textContent = `其他候选 · ${group.candidates.length - 1}`; more.append(summary);
        group.candidates.slice(1).forEach(candidate => more.append(renderCandidate(candidate)));
        rememberExpansion(more, `skill:${group.skillName}`); box.append(more);
      }
      list.append(box);
    }
    const archive = q('[data-draft-processed]'), archivedList = q('[data-draft-processed-list]');
    archive.hidden = !processed.length; q('[data-draft-processed-count]').textContent = String(processed.length);
    archivedList.replaceChildren(...processed.map(draft => renderDraftRow(draft)));
  };

  const draftRefresh = createSkillPanelRefreshQueue({
    isConnected: () => mount.isConnected,
    load: () => typeof draftApi?.list === 'function' ? draftApi.list({}) : null,
    render: response => {
      const list = q('[data-draft-list]');
      const count = q('[data-draft-count]');
      if (!draftApi || typeof draftApi.list !== 'function') {
        if (list) list.innerHTML = '<div class="dp-empty">当前版本暂不支持 Skill 草稿</div>';
        if (count) count.textContent = '不可用';
        return;
      }
      if (!response || response.ok === false) {
        if (list) list.innerHTML = '<div class="dp-empty">草稿加载失败，请稍后重试</div>';
        if (count) count.textContent = '加载失败';
        return;
      }
      renderDrafts(Array.isArray(response) ? response : response.items);
    },
    onError: error => {
      const list = q('[data-draft-list]'), count = q('[data-draft-count]');
      if (list) list.innerHTML = '<div class="dp-empty">草稿加载失败，请稍后重试</div>';
      if (count) count.textContent = '加载失败';
      console.warn('[skills] Skill 草稿读取失败', error);
    },
  });
  const reloadDrafts = () => draftRefresh.request().catch(() => {});

  q('[data-draft-refresh]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await reloadDrafts(); }
    finally { if (button.isConnected) button.disabled = false; }
  });

  // 渲染主列表(已安装技能 + 用量/状态徽标 + 置顶/归档/删除)
  const renderList = (items, usageReady = true) => {
    const list = q('[data-list]');
    const count = q('[data-skill-count]');
    if (count) count.textContent = `${items ? items.length : 0} 个技能`;
    if (!items || !items.length) {
      list.innerHTML = `<div class="dp-empty">还没有技能，点上方按钮导入</div>`;
      return;
    }
    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item' + (it.state === 'stale' ? ' skill-stale' : '');
      const stateBadge = it.state === 'stale' ? `<span class="skill-badge stale">闲置</span>` : '';
      const pinBadge   = it.pinned ? `<span class="skill-badge pin">已保护</span>` : '';
      const autoBadge  = it.createdBy === 'agent' ? `<span class="skill-badge auto">🤖 自动生成</span>` : '';
      const historyAction = draftApi && typeof draftApi.history === 'function'
        ? '<button type="button" data-action="history">版本历史</button>' : '';
      const useText = !usageReady
        ? '正在后台统计用量…'
        : (it.useCount > 0
            ? `用 ${it.useCount} 次 · 最近 ${fmtDay(it.lastUsedAt)}` +
              ((it.correctionCount || it.retryCount || it.toolErrorCount)
                ? ` · 质量信号 纠正 ${it.correctionCount || 0}/重试 ${it.retryCount || 0}/报错 ${it.toolErrorCount || 0}`
                : '')
            : '未使用过');
      row.innerHTML = `
        <div class="set-icon ico-skill">🧩</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
          <div class="skill-meta"><span class="skill-use">${useText}</span>${autoBadge}${stateBadge}${pinBadge}</div>
        </div>
        <div class="dp-item-actions dp-menu-wrap">
          <button class="dp-more" type="button" aria-label="更多操作">···</button>
          <div class="dp-menu">
            <button type="button" data-action="detail">详情</button>
            ${historyAction}
            <button type="button" data-action="pin">${it.pinned ? '取消保护' : '保护'}</button>
            <button type="button" data-action="archive">归档</button>
            <button type="button" class="danger" data-action="delete">删除</button>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.displayName || it.name;
      row.querySelector('.dp-item-name').title = `调用 ID：${it.callName || it.name}`;
      row.querySelector('.dp-item-desc').textContent = it.summary || it.desc || '';
      row.querySelector('[data-action="detail"]').addEventListener('click', () => {
        renderManagedMarkdownEditor('skill', it.name, it.name);
      });
      const historyButton = row.querySelector('[data-action="history"]');
      if (historyButton) {
        historyButton.addEventListener('click', () => {
          void openSkillVersionHistory(it.name, () => reload({ refresh: false }));
        });
      }
      // 保护状态只更新当前行，避免重新拉取整个技能面板造成闪烁和滚动位置跳动。
      const pinButton = row.querySelector('[data-action="pin"]');
      pinButton.addEventListener('click', async () => {
        pinButton.disabled = true;
        try {
          const r = await window.api.skills.pin(it.name, !it.pinned);
          if (r && r.ok) {
            it.pinned = !!r.pinned;
            pinButton.textContent = it.pinned ? '取消保护' : '保护';
            let badge = row.querySelector('.skill-badge.pin');
            if (it.pinned && !badge) {
              badge = document.createElement('span');
              badge.className = 'skill-badge pin';
              badge.textContent = '已保护';
              row.querySelector('.skill-meta').appendChild(badge);
            } else if (!it.pinned && badge) {
              badge.remove();
            }
            showToast(it.pinned ? '已保护' : '已取消保护');
          } else {
            showToast((r && r.message) || '操作失败');
          }
        } catch (e) {
          showToast((e && e.message) || '操作失败');
        } finally {
          pinButton.disabled = false;
        }
      });
      row.querySelector('[data-action="archive"]').addEventListener('click', async () => {
        const r = await window.api.skills.archive(it.name);
        if (r && r.ok) { showToast('已归档，可在下方随时恢复'); reload(); }
        else showToast((r && r.message) || '归档失败');
      });
      // 删除(彻底,不可恢复)
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const ok = await customConfirm({
          title: '删除技能',
          message: `确定删除「${it.name}」？此操作会从磁盘移除，无法恢复。`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.data.removeSkill(it.name);
        if (r && r.ok) { showToast('已删除'); reload(); }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
  };

  // 渲染归档区(折叠；操作与上方技能统一收进三点菜单)
  const renderArchived = (archived) => {
    const wrap = q('[data-arch-wrap]');
    const archList = q('[data-arch-list]');
    if (!archived || !archived.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    q('[data-arch-title]').textContent = `已归档 (${archived.length})`;
    archList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    archived.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item skill-archived-item';
      const useText = it.useCount > 0 ? `曾用 ${it.useCount} 次` : '未使用过';
      row.innerHTML = `
        <div class="set-icon ico-skill">🗄️</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="skill-meta"><span class="skill-use">${useText} · 归档于 ${fmtDay(it.archivedAt)}</span></div>
        </div>
        <div class="dp-item-actions dp-menu-wrap">
          <button class="dp-more" type="button" aria-label="更多操作">···</button>
          <div class="dp-menu">
            <button type="button" data-action="detail">详情</button>
            <button type="button" data-action="restore">恢复</button>
            <button type="button" class="danger" data-action="delete">删除</button>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.name;
      row.querySelector('[data-action="detail"]').addEventListener('click', () => {
        renderManagedMarkdownEditor('archivedSkill', it.name, it.name);
      });
      row.querySelector('[data-action="restore"]').addEventListener('click', async () => {
        const r = await window.api.skills.restore(it.name);
        if (r && r.ok) { showToast('已恢复'); reload(); }
        else showToast((r && r.message) || '恢复失败');
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const ok = await customConfirm({
          title: '删除归档技能',
          message: `确定永久删除「${it.name}」？删除后无法恢复。`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.skills.deleteArchived(it.name);
        if (r && r.ok) { showToast('已删除'); reload(); }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);
      fragment.appendChild(row);
    });
    archList.appendChild(fragment);
  };

  // 归档区折叠开合
  q('[data-arch-toggle]').addEventListener('click', () => {
    const archList = q('[data-arch-list]');
    const wrap = q('[data-arch-wrap]');
    archList.hidden = !archList.hidden;
    wrap.classList.toggle('open', !archList.hidden);
  });

  // 列表优先显示最近快照，后台校准期间不清空、不放 spinner；只有首次且没有任何快照时显示骨架行。
  if (skillOverviewCache && skillOverviewCache.ok) {
    renderList(skillOverviewCache.items, skillOverviewCache.usageReady !== false);
    renderArchived(skillOverviewCache.archived);
  } else {
    q('[data-list]').innerHTML = Array.from({ length: 5 }, () => `
      <div class="set-row dp-item skill-list-skeleton" aria-hidden="true">
        <div class="set-icon ico-skill">🧩</div>
        <div class="dp-item-main"><div class="skill-skeleton-line"></div><div class="skill-skeleton-line short"></div></div>
      </div>`).join('');
  }

  // 拉数据 + 渲染。refresh=false 用于 Worker 完成通知，只读取新索引，避免再次启动校准。
  const overviewRefresh = createSkillPanelRefreshQueue({
    isConnected: () => mount.isConnected && !!q('[data-list]'),
    load: ({ refresh = false }) => window.api.skills.overview({ refresh }),
    render: r => {
      if (!r || !r.ok) {
        const message = r?.message || '技能列表读取失败';
        throw new Error(message);
      }
      skillOverviewCache = r;
      renderList(r.items, r.usageReady !== false);
      renderArchived(r.archived);
      // 回填阈值下拉(程序设值,bindCustomSelects 只处理点击)
      const root = q('#skill-stale-days');
      if (root && r.staleDays != null) {
        const val = String(r.staleDays);
        root.dataset.value = val;
        const opt = root.querySelector(`.cs-option[data-value="${val}"]`);
        const txt = root.querySelector('.cs-text');
        if (txt) txt.textContent = opt ? opt.textContent.trim() : (val + ' 天');
        root.querySelectorAll('.cs-option').forEach((o) => o.classList.toggle('selected', o === opt));
      }
    },
    onError: (error, { throwOnError }) => { if (!throwOnError) showToast(error.message); },
  });
  const reload = ({ refresh = true, throwOnError = false } = {}) => overviewRefresh.request({ refresh, throwOnError }).catch(error => { if (throwOnError) throw error; });

  // 阈值切换 → 存 + 重算状态机 + 刷新
  const staleRoot = q('#skill-stale-days');
  if (staleRoot) {
    staleRoot.querySelectorAll('.cs-option').forEach((o) => {
      o.addEventListener('click', async () => {
        const v = parseInt(o.dataset.value, 10);
        if (Number.isFinite(v)) { await window.api.skills.setStaleDays(v); reload(); }
      });
    });
  }

  // ── 二期:自动提炼技能 开关 + 频率(初始态已在 HTML 里烘焙好,这里只绑交互) ──
  const reviewOn = q('[data-review-on]');
  const reviewFreqRoot = q('#skill-review-every');
  const reviewFreqRow = q('[data-review-freq-row]');
  if (reviewOn) {
    reviewOn.addEventListener('click', async () => {
      const next = !reviewOn.classList.contains('on');
      reviewOn.classList.toggle('on', next);
      reviewOn.setAttribute('aria-checked', String(next));
      if (reviewFreqRow) reviewFreqRow.style.opacity = next ? '' : '0.45';
      await window.api.skills.setReviewConfig({ enabled: next });
      showToast(next ? '已开启自动提炼' : '已关闭自动提炼');
    });
  }
  if (reviewFreqRoot) {
    reviewFreqRoot.querySelectorAll('.cs-option').forEach((o) => {
      o.addEventListener('click', async () => {
        const v = parseInt(o.dataset.value, 10);
        if (Number.isFinite(v)) await window.api.skills.setReviewConfig({ everyTurns: v });
      });
    });
  }

  const autoArchive = q('[data-skill-auto-archive]');
  autoArchive?.addEventListener('click', async () => {
    const next = !autoArchive.classList.contains('on');
    autoArchive.disabled = true;
    try {
      const result = await window.api.skills.setReviewConfig({ autoArchive: next });
      if (!result?.ok) throw new Error(result?.message || '设置保存失败');
      autoArchive.classList.toggle('on', next); autoArchive.setAttribute('aria-checked', String(next));
      if (skillPanelConfigCache?.reviewCfg) skillPanelConfigCache.reviewCfg.autoArchive = next;
    } catch (error) { showToast(error.message || '设置保存失败'); }
    finally { autoArchive.disabled = false; }
  });

  // ── 三期:定期技能体检(伞状合并)——一个 builtin 定时任务,和记忆整理同构 ──
  const CURATOR_BUILTIN = 'skill-curator';
  const curOn = q('[data-cur-on]'), curNext = q('[data-cur-next]'), curRun = q('[data-cur-run]');
  const curSchedRow = q('[data-cur-sched-row]');
  const curModelRoot = q('#skill-cur-model');
  const curDowRoot = q('#skill-cur-dow'), curTimeRoot = q('#skill-cur-time');
  const curGetModel = () => {
    const value = curModelRoot && curModelRoot.dataset.value;
    return MAINTENANCE_MODEL_VALUES.has(value) ? value : 'opus';
  };
  const curGetDow = () => (curDowRoot && curDowRoot.dataset.value) || '5';
  const curGetTime = () => (curTimeRoot && curTimeRoot.dataset.value) || '10:00';
  const curSetSelect = (root, val) => {
    if (!root) return;
    root.dataset.value = val;
    const opt = root.querySelector(`.cs-option[data-value="${val}"]`);
    const txt = root.querySelector('.cs-text');
    if (txt) txt.textContent = opt ? opt.textContent.trim() : val;
    root.querySelectorAll('.cs-option').forEach((o) => o.classList.toggle('selected', o === opt));
  };
  const curFindTask = async () => {
    try {
      const r = await window.api.scheduler.list();
      if (r && r.ok) return (r.items || []).find((t) => t.builtin === CURATOR_BUILTIN) || null;
    } catch (_) {}
    return null;
  };
  const curBuildCron = () => {
    const [h, m] = curGetTime().split(':').map((x) => parseInt(x, 10) || 0);
    return `${m} ${h} * * ${curGetDow()}`;
  };
  // 体检任务体:prompt + workingDir 都从 main 现取(prompt 自带最新技能清单)
  const curTaskBody = async (enabled) => {
    let prompt = '', dir = '';
    try { const p = await window.api.skills.curatorPrompt(); if (p && p.ok) prompt = p.prompt; } catch (_) {}
    try { const d = await window.api.skills.getDir(); if (d && d.ok) dir = d.dir; } catch (_) {}
    return {
      name: '技能库体检', builtin: CURATOR_BUILTIN, enabled,
      schedule: { kind: 'cron', cron: curBuildCron() },
      action: { type: 'chat', prompt, model: curGetModel(), memory: 'off', sessionMode: 'isolated', mode: 'plain', workingDir: dir },
      delivery: { notify: true, saveToHistory: true },
    };
  };
  if (curModelRoot) {
    curModelRoot.setAttribute('aria-label', '技能体检模型');
    curModelRoot.addEventListener('settings-segment-change', async () => {
      const model = curGetModel();
      try {
        await saveMaintenanceModel('skillMaintenanceModel', model);
        const t = await curFindTask();
        if (t) {
          await window.api.scheduler.update(t.id, {
            action: { ...(t.action || {}), model },
          });
        }
      } catch (e) {
        showToast((e && e.message) || '模型设置保存失败');
      }
    });
  }
  let curFirstFill = true;
  const refreshCur = async () => {
    const t = await curFindTask();
    if (curFirstFill) {
      curFirstFill = false;
      curOn.classList.add('no-anim');
      curOn.classList.toggle('on', !!(t && t.enabled));
      requestAnimationFrame(() => requestAnimationFrame(() => curOn.classList.remove('no-anim')));
    } else {
      curOn.classList.toggle('on', !!(t && t.enabled));
    }
    curOn.setAttribute('aria-checked', String(!!(t && t.enabled)));
    if (curSchedRow) curSchedRow.style.opacity = (t && t.enabled) ? '' : '0.45';
    curNext.textContent = '';
    if (!t) return;
    const m = String((t.schedule || {}).cron || '').match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6])$/);
    if (m) {
      const pad = (n) => String(n).padStart(2, '0');
      curSetSelect(curTimeRoot, `${pad(m[2])}:${pad(m[1])}`);
      curSetSelect(curDowRoot, m[3]);
    } else if (t.schedule && t.schedule.cron) {
      curNext.textContent = `自定义 cron:${t.schedule.cron}`;
      return;
    }
    if (t.enabled && t.nextRunAt) {
      const d = new Date(Date.parse(t.nextRunAt));
      if (!isNaN(d)) curNext.textContent = `下次:${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  };
  if (curOn) {
    curOn.addEventListener('click', async () => {
      const turnOn = !curOn.classList.contains('on');
      curOn.classList.toggle('on', turnOn);
      curOn.setAttribute('aria-checked', String(turnOn));
      if (curSchedRow) curSchedRow.style.opacity = turnOn ? '' : '0.45';
      const t = await curFindTask();
      if (turnOn) {
        if (t) await window.api.scheduler.toggle(t.id, true);
        else await window.api.scheduler.create(await curTaskBody(true));
        showToast('已开启定期技能体检');
      } else if (t) {
        await window.api.scheduler.toggle(t.id, false);
        showToast('已关闭定期技能体检');
      }
      refreshCur();
    });
  }
  const curOnSchedChange = async () => {
    const t = await curFindTask();
    if (t) { await window.api.scheduler.update(t.id, { schedule: { kind: 'cron', cron: curBuildCron() } }); refreshCur(); }
  };
  for (const root of [curDowRoot, curTimeRoot]) {
    if (root) root.querySelectorAll('.cs-option').forEach((o) => o.addEventListener('click', curOnSchedChange));
  }
  if (curRun) {
    curRun.addEventListener('click', async () => {
      let t = await curFindTask();
      if (!t) {
        const r = await window.api.scheduler.create(await curTaskBody(false));
        t = r && r.task;
        if (!t) { showToast('创建体检任务失败'); return; }
      } else {
        // 已存在任务:用最新技能清单刷新它的 prompt(技能库可能已变)
        try { const p = await window.api.skills.curatorPrompt(); if (p && p.ok) { const body = await curTaskBody(t.enabled); await window.api.scheduler.update(t.id, { action: body.action }); } } catch (_) {}
      }
      window.api.scheduler.runNow(t.id);   // 不等待体检完成；结束后由系统通知
      showToast('技能体检已开始,完成后会通知');
      refreshCur();
    });
  }
  refreshCur();

  bindPackageImportZone(importZone, 'skill', () => reload());

  if (skillUsageUpdateOff) skillUsageUpdateOff();
  skillUsageUpdateOff = window.api.skills.onUsageUpdated(() => {
    if (!mount.isConnected) return;
    overviewRefresh.invalidate({ refresh: false });
  });

  if (skillDraftEventOff) skillDraftEventOff();
  if (draftApi && typeof draftApi.onEvent === 'function') {
    skillDraftEventOff = draftApi.onEvent((event) => {
      if (!mount.isConnected) return;
      draftRefresh.invalidate();
      if (event && ['skillDraft.published', 'skillDraft.rolledBack'].includes(event.type)) {
        overviewRefresh.invalidate({ refresh: false });
      }
    });
  }

  const applyConfigPromise = panelConfigPromise.then(([cfgResult, modelResult]) => {
    if (!mount.isConnected) return;
    const nextCfg = cfgResult && cfgResult.ok
      ? cfgResult
      : reviewCfg;
    const nextModel = MAINTENANCE_MODEL_VALUES.has(modelResult) ? modelResult : curatorModel;
    skillPanelConfigCache = { reviewCfg: { ...nextCfg }, curatorModel: nextModel };

    if (reviewOn) {
      reviewOn.classList.add('no-anim');
      reviewOn.classList.toggle('on', !!nextCfg.enabled);
      reviewOn.setAttribute('aria-checked', String(!!nextCfg.enabled));
      if (reviewFreqRow) reviewFreqRow.style.opacity = nextCfg.enabled ? '' : '0.45';
      requestAnimationFrame(() => reviewOn.classList.remove('no-anim'));
    }
    if (autoArchive) {
      autoArchive.classList.add('no-anim'); autoArchive.classList.toggle('on', !!nextCfg.autoArchive);
      autoArchive.setAttribute('aria-checked', String(!!nextCfg.autoArchive));
      requestAnimationFrame(() => autoArchive.classList.remove('no-anim'));
    }
    const archiveDescription = q('[data-skill-archive-description]');
    if (archiveDescription) archiveDescription.textContent = `连续 ${nextCfg.archiveDays || 90} 天未使用、查看或更新后，在空闲时归档；可随时恢复。`;
    if (reviewFreqRoot) {
      const value = String(nextCfg.everyTurns || 6);
      reviewFreqRoot.dataset.value = value;
      const option = reviewFreqRoot.querySelector(`.cs-option[data-value="${value}"]`);
      const text = reviewFreqRoot.querySelector('.cs-text');
      if (text) text.textContent = option ? option.textContent.trim() : `每 ${value} 轮`;
      reviewFreqRoot.querySelectorAll('.cs-option').forEach((item) => item.classList.toggle('selected', item === option));
    }
    if (curModelRoot) {
      curModelRoot.dataset.value = nextModel;
      curModelRoot.querySelectorAll('button[data-value]').forEach((button) => {
        const active = button.dataset.value === nextModel;
        button.classList.toggle('active', active);
        button.setAttribute('aria-checked', String(active));
      });
    }
  }).catch((error) => console.warn('[settings] 技能维护配置读取失败', error));

  await Promise.all([reload({ throwOnError: true }), reloadDrafts(), applyConfigPromise]);

  // 旧版本已安装的 Skill 可能没有 agents/relay.yaml。技能页先正常展示，
  // 再后台增量补齐；完成后原位刷新，不把 LLM 扫描塞进 Relay 启动流程。
  window.api.skills.backfillMetadata().then((result) => {
    if (!mount.isConnected || !result || !result.ok || !result.total) return;
    reload({ refresh: false });
    if (result.fallbackCount) {
      showToast(`已整理 ${result.total} 个历史技能，${result.fallbackCount} 个使用原始说明`);
    } else {
      showToast(`已为 ${result.total} 个历史技能生成中文标题和摘要`);
    }
  }).catch((error) => console.warn('[skills] 历史技能元数据补齐失败', error));
  return { refresh: () => Promise.all([reload({ throwOnError: true }), reloadDrafts()]) };
}

// Relay 记忆管理：模型通过受控工具提出候选，用户可确认、编辑和恢复。
//   在设置右侧查看/编辑单条、删除、查看只读索引 MEMORY.md。
//   mount = #memorySection 容器。
async function renderMemoryPanel(mount) {
  const q = (sel) => mount.querySelector(sel);
  // type → 中文徽标(与记忆 frontmatter 的 type 对齐;空/未知不显示徽标)
  const TYPE_LABEL = { user: '用户', feedback: '反馈', project: '项目', reference: '参考' };
  // 整理时间下拉:半小时粒度(00:00~23:30 共 48 项),与「每周X」同款自绘下拉
  const timeOpts = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) {
    const v = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    timeOpts.push({ value: v, label: v });
  }
  const memoryMaintenanceModel = await getMaintenanceModel('memoryMaintenanceModel', 'memory-consolidate', 'opus');
  mount.innerHTML = `
    <div class="mem-toolbar">
      <span class="dp-count" data-count></span>
      <div class="mem-toolbar-btns">
        <button class="mem-btn" type="button" data-mem-archived aria-pressed="false">已移除</button>
        <button class="mem-btn" data-mem-index>查看索引</button>
      </div>
    </div>
    <div class="set-panel dp-list" data-list></div>
    <section class="memory-maintenance" aria-label="自动整理与维护">
    <h3 class="set-section-head mem-auto-heading">自动整理与维护</h3>
    <div class="set-panel mem-auto-panel" data-mem-auto-panel>
      <div class="set-row">
        <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg></div>
        <div class="set-label">定期自动整理</div>
        <div class="memory-maintenance-controls">
          ${buildSettingsSegmented('mem-auto-model', MAINTENANCE_MODEL_OPTIONS, memoryMaintenanceModel)}
          <button class="row-btn" data-auto-run>立即整理</button>
          <div class="switch" data-auto-on title="开启/关闭定期整理"></div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
        <div class="set-label">整理时间<div class="set-sub" data-auto-next></div></div>
        <div class="memory-maintenance-controls">
        ${buildCustomSelect('mem-auto-dow', [
          { value: '1', label: '每周一' }, { value: '2', label: '每周二' }, { value: '3', label: '每周三' },
          { value: '4', label: '每周四' }, { value: '5', label: '每周五' }, { value: '6', label: '每周六' },
          { value: '0', label: '每周日' }, { value: '*', label: '每天' },
        ], '1')}
        ${buildCustomSelect('mem-auto-time', timeOpts, '10:00')}
        </div>
      </div>
    </div>
    </section>

  `;

  // ── 定期自动整理:本质是一个 builtin 标记的普通定时任务,在定时任务列表里同样可见/可管 ──
  //   开关=创建或启停;周几+时间=改 cron;「立即整理」=没有任务就先建一个(不启用),然后手动跑一次。
  const CONSOLIDATE_BUILTIN = 'memory-consolidate';
  const CONSOLIDATE_PROMPT = '通过 relay-memory 的 list/read 核对已确认记忆，只对重复、过时或冲突提出替代候选。propose 必须携带刚读取的 revision，核心条目只报告问题。不要直接覆写或删除文件，不要改 MEMORY.md。已确认事实在用户接受候选前保持有效；无需改动时不要制造候选。';
  const autoOn = q('[data-auto-on]'), autoNext = q('[data-auto-next]'), autoRun = q('[data-auto-run]');
  bindCustomSelects(mount);   // 激活「每周X」「时间」自绘下拉(与设置其它下拉同款)
  bindSettingsSegmented(mount);
  const autoModelRoot = q('#mem-auto-model');
  const dowRoot = q('#mem-auto-dow'), timeRoot = q('#mem-auto-time');
  const getAutoModel = () => {
    const value = autoModelRoot && autoModelRoot.dataset.value;
    return MAINTENANCE_MODEL_VALUES.has(value) ? value : 'opus';
  };
  const getDow = () => (dowRoot && dowRoot.dataset.value) || '1';
  const getTime = () => (timeRoot && timeRoot.dataset.value) || '10:00';
  // 程序回填下拉选中值(bindCustomSelects 只处理用户点击)
  const setSelect = (root, val) => {
    if (!root) return;
    root.dataset.value = val;
    const opt = root.querySelector(`.cs-option[data-value="${val}"]`);
    // 值不在选项里(对话里设了非整半点时间)也照常显示在触发器上
    root.querySelector('.cs-text').textContent = opt ? opt.textContent.trim() : val;
    root.querySelectorAll('.cs-option').forEach((o) => o.classList.toggle('selected', o === opt));
  };

  const findConsolidate = async () => {
    try {
      const r = await window.api.scheduler.list();
      if (r && r.ok) return (r.items || []).find((t) => t.builtin === CONSOLIDATE_BUILTIN) || null;
    } catch (_) {}
    return null;
  };
  const buildCron = () => {
    const [h, m] = getTime().split(':').map((x) => parseInt(x, 10) || 0);
    return `${m} ${h} * * ${getDow()}`;
  };
  const consolidateTaskBody = (enabled) => ({
    name: '记忆库整理',
    builtin: CONSOLIDATE_BUILTIN,
    enabled,
    schedule: { kind: 'cron', cron: buildCron() },
    action: { type: 'chat', prompt: CONSOLIDATE_PROMPT, model: getAutoModel(), memory: 'readwrite', sessionMode: 'isolated', mode: 'plain' },
    delivery: { notify: true, saveToHistory: true },
  });
  if (autoModelRoot) {
    autoModelRoot.setAttribute('aria-label', '记忆整理模型');
    autoModelRoot.addEventListener('settings-segment-change', async () => {
      const model = getAutoModel();
      try {
        await saveMaintenanceModel('memoryMaintenanceModel', model);
        const t = await findConsolidate();
        if (t) {
          await window.api.scheduler.update(t.id, {
            action: { ...(t.action || {}), model },
          });
        }
      } catch (e) {
        showToast((e && e.message) || '模型设置保存失败');
      }
    });
  }
  // 把任务现状回填到控件;cron 不是「分 时 * * 周」简单形态(对话里改过)就原样展示不动控件
  let autoFirstFill = true;   // 首次回填时抑制开关滑动动画(状态来自异步,避免"先关后开"滑入)
  const refreshAuto = async () => {
    const t = await findConsolidate();
    if (autoFirstFill) {
      autoFirstFill = false;
      autoOn.classList.add('no-anim');
      autoOn.classList.toggle('on', !!(t && t.enabled));
      // 下一帧(终态已绘制)再恢复动画,后续用户点击仍有滑动反馈
      requestAnimationFrame(() => requestAnimationFrame(() => autoOn.classList.remove('no-anim')));
    } else {
      autoOn.classList.toggle('on', !!(t && t.enabled));
    }
    autoNext.textContent = '';
    if (!t) return;
    const m = String((t.schedule || {}).cron || '').match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6])$/);
    if (m) {
      const pad = (n) => String(n).padStart(2, '0');
      setSelect(timeRoot, `${pad(m[2])}:${pad(m[1])}`);
      setSelect(dowRoot, m[3]);
    } else if (t.schedule && t.schedule.cron) {
      autoNext.textContent = `自定义 cron:${t.schedule.cron}`;
      return;
    }
    if (t.enabled && t.nextRunAt) {
      const d = new Date(Date.parse(t.nextRunAt));
      if (!isNaN(d)) autoNext.textContent = `下次:${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  };
  autoOn.addEventListener('click', async () => {
    const turnOn = !autoOn.classList.contains('on');
    autoOn.classList.toggle('on', turnOn);   // 先乐观切换,随后 refreshAuto 校准
    const t = await findConsolidate();
    if (turnOn) {
      if (t) await window.api.scheduler.toggle(t.id, true);
      else await window.api.scheduler.create(consolidateTaskBody(true));
      showToast('已开启定期整理');
    } else if (t) {
      await window.api.scheduler.toggle(t.id, false);
      showToast('已关闭定期整理');
    }
    refreshAuto();
  });
  const onSchedChange = async () => {
    const t = await findConsolidate();
    if (t) { await window.api.scheduler.update(t.id, { schedule: { kind: 'cron', cron: buildCron() } }); refreshAuto(); }
  };
  for (const root of [dowRoot, timeRoot]) {
    if (root) root.querySelectorAll('.cs-option').forEach((o) => o.addEventListener('click', onSchedChange));
  }
  autoRun.addEventListener('click', async () => {
    let t = await findConsolidate();
    if (!t) {
      const r = await window.api.scheduler.create(consolidateTaskBody(false));
      t = r && r.task;
      if (!t) { showToast('创建整理任务失败'); return; }
    } else {
      // 立即执行也使用面板当前选择，避免旧任务仍带着历史模型。
      const body = consolidateTaskBody(t.enabled);
      await window.api.scheduler.update(t.id, { action: body.action });
    }
    window.api.scheduler.runNow(t.id);   // 不等执行完(可能要跑几分钟),完成会有系统通知 + 落历史
    showToast('整理已开始,完成后会通知并落历史会话');
    refreshAuto();
  });
  refreshAuto();

  let showingArchived = false, listRequest = 0;
  const renderList = (items) => {
    const list = q('[data-list]');
    if (showingArchived) {
      q('[data-count]').textContent = items?.length ? `已移除 ${items.length} 条记忆` : '';
      list.replaceChildren();
      if (!items?.length) { list.innerHTML = '<div class="dp-empty">没有已移除的记忆。</div>'; return; }
      for (const item of items) {
        const row = document.createElement('div'); row.className = 'set-row dp-item';
        row.innerHTML = '<div class="dp-item-main"><div class="dp-item-name"></div><div class="dp-item-desc"></div></div><button class="row-btn" type="button">恢复</button>';
        row.querySelector('.dp-item-name').textContent = item.name || item.meta?.name || item.file;
        row.querySelector('.dp-item-desc').textContent = item.description || item.meta?.description || item.file;
        const button = row.querySelector('button');
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await window.api.memory.restore(item.file, item.versionId, null);
            if (!result?.ok) throw new Error(result?.message || '恢复失败');
            showToast('记忆已恢复'); await load();
          } catch (error) { showToast(error.message || '恢复失败'); button.disabled = false; }
        });
        list.appendChild(row);
      }
      return;
    }
    const count = q('[data-count]');
    if (count) count.textContent = items && items.length ? `共 ${items.length} 条记忆` : '';
    if (!items || !items.length) {
      list.innerHTML = `<div class="dp-empty">还没有记忆。随着你和助手对话,它会自动把值得长期记住的事记在这里。</div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = `set-row dp-item${it.status === 'draft' ? ' is-memory-draft' : ''}`;
      const badge = TYPE_LABEL[it.type] ? `<span class="mem-badge">${TYPE_LABEL[it.type]}</span>` : '';
      const reviewActions = it.status === 'draft'
        ? '<button type="button" data-action="approve">确认记住</button><button type="button" data-action="dismiss">忽略候选</button>'
        : '';
      row.innerHTML = `
        <div class="set-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.7-1.3A3.8 3.8 0 0 0 4 10a4 4 0 0 0 .7 7.5A3.8 3.8 0 0 0 12 19V5Zm0 0a3 3 0 0 1 5.7-1.3A3.8 3.8 0 0 1 20 10a4 4 0 0 1-.7 7.5A3.8 3.8 0 0 1 12 19"/><path d="M8 9c0 2 2 2 2 3M16 9c0 2-2 2-2 3M8 17c0-2-2-2-2-3M16 17c0-2 2-2 2-3"/></svg></div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
        </div>
        <div class="dp-item-actions dp-menu-wrap">
          ${badge}
          <button class="dp-more" type="button" aria-label="更多操作">···</button>
          <div class="dp-menu">
            ${reviewActions}
            <button type="button" data-action="detail">详情</button>
            <button type="button" data-action="pin"${it.pinnedInFile ? ' disabled title="该标记来自 Markdown frontmatter，请在编辑页修改"' : ''}>${it.pinnedInFile ? '核心来自 Markdown' : (it.pinned ? '取消核心' : '设为核心')}</button>
            <button type="button" class="danger" data-action="delete">移除</button>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.name || it.file;
      const scopeLabel = it.scope === 'project' ? '项目'
        : (it.scope === 'retired' ? '已停用' : '全局');
      const statusLabel = it.status === 'draft' ? '待确认 · ' : '';
      row.querySelector('.dp-item-desc').textContent = `${statusLabel}${it.pinned ? '核心 · ' : ''}${scopeLabel} · ${it.description || '(无摘要)'} · 展示 ${it.exposureCount || 0} / 实读 ${it.readCount || 0}`;
      const approve = row.querySelector('[data-action="approve"]');
      if (approve) approve.addEventListener('click', async () => {
        const result = await window.api.memory.setStatus(it.file, 'active', it.revision);
        if (result && result.ok) { showToast('已确认，以后会在合适的作用域中使用'); load(); }
        else showToast(result && result.message || '确认失败');
      });
      const dismiss = row.querySelector('[data-action="dismiss"]');
      if (dismiss) dismiss.addEventListener('click', async () => {
        const result = await window.api.memory.setStatus(it.file, 'expired', it.revision);
        if (result && result.ok) { showToast('已忽略这条候选记忆'); load(); }
        else showToast(result && result.message || '操作失败');
      });
      row.querySelector('[data-action="detail"]').addEventListener('click', () => renderMemoryEditor(it.file, it.name || it.file));
      row.querySelector('[data-action="pin"]').addEventListener('click', async () => {
        if (it.pinnedInFile) return;
        const r = await window.api.memory.setPinned(it.file, !it.pinned);
        if (r && r.ok) { showToast(r.pinned ? '已设为核心记忆' : '已取消核心记忆'); load(); }
        else showToast((r && r.message) || '设置失败');
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const ok = await customConfirm({
          title: '移除记忆',
          message: `移除「${it.name || it.file}」后，助手将不再使用这条记忆。可在“已移除”中恢复。`,
          confirmText: '移除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.memory.remove(it.file, it.revision);
        if (r && r.ok) { showToast('已移除，可随时恢复'); load(); }
        else showToast((r && r.message) || '移除失败');
      });
      bindDpMenu(row);
      list.appendChild(row);
    });
  };

  q('[data-mem-index]').addEventListener('click', () => renderMemoryEditor('MEMORY.md', '记忆索引 (MEMORY.md)'));

  const load = async () => {
    const request = ++listRequest;
    const res = showingArchived ? await window.api.memory.archived() : await window.api.memory.list();
    if (!mount.isConnected || request !== listRequest) return;
    if (res && !res.ok) { showToast(res.message || '记忆读取失败'); return; }
    renderList(res && res.items);
  };
  q('[data-mem-archived]').addEventListener('click', () => {
    showingArchived = !showingArchived;
    q('[data-mem-archived]').setAttribute('aria-pressed', String(showingArchived));
    q('[data-mem-archived]').textContent = showingArchived ? '返回记忆' : '已移除';
    void load();
  });
  getMemoryPageHost(mount).refreshList = load;
  if (memoryUsageUpdateOff) memoryUsageUpdateOff();
  memoryUsageUpdateOff = window.api.skills.onUsageUpdated(() => {
    if (!mount.isConnected) return;
    load();
  });
  await load();
}

// 用量页先同步绘制轻量界面，再以快照更新数字，统计读取由后台完成。
let browserSettingsPageView = null;
function renderBrowserSettingsPanel(mount) {
  browserSettingsPageView?.destroy();
  browserSettingsPageView = window.relayBrowserSettings.create({
    mount, api: window.api.browser,
    openUrl: url => window.relayWorkspacePanel.openUrl(url),
  });
  return browserSettingsPageView;
}
window.relayBrowserSettings.configure({
  async open(section) {
    await openSettings('browser');
    browserSettingsPageView?.show(section);
  },
});

let usagePageView = null;
function renderStatsPanel(mount) {
  usagePageView?.destroy();
  usagePageView = window.relayUsagePage.create({ mount, api: window.api.stats, profile: true });
  return usagePageView;
}

function memoryMarkdownBody(content) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  if (!/^---\s*(?:\r?\n)/.test(text)) return text;
  const match = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return match ? text.slice(match[0].length).trimStart() : text;
}

// Agent / 技能详情复用记忆详情的 Markdown 阅读 + 源码编辑结构。
// kind 决定受控目录；key 仅为 Agent 文件名或技能目录名，真实路径由主进程收敛。
async function renderManagedMarkdownEditor(kind, key, title) {
  const host = window.relayPluginsPage ? window.relayPluginsPage.beginDetail(kind) : null;
  if (!host) preserveSettingsView();
  const body = host ? host.body : modalBody;
  const hint = host ? host.hint : modalHint;
  const saveButton = host ? host.saveButton : btnSettingsSaveEl;
  const prefix = host ? host.prefix : '';
  const q = id => body.querySelector('#' + prefix + id);
  const setBack = handler => host ? host.setBack(handler) : setSettingsBackAction(handler);
  const setSave = handler => { if (host) host.setSave(handler); else activeSaveHandler = handler; };
  const showSave = visible => { if (saveButton) { if (host) saveButton.hidden = !visible; saveButton.style.display = visible ? '' : 'none'; } };
  hint.textContent = ''; setSave(null); showSave(false);
  const isArchivedSkill = kind === 'archivedSkill';
  const typeLabel = kind === 'agent' ? 'Agent' : '技能';
  const fileLabel = kind === 'agent' ? key : 'SKILL.md';
  body.innerHTML = `
    <div class="data-panel-head">
      <div class="dp-title">${escapeHtml(title || key)}</div>
      <span class="dp-head-spacer"></span>
      <div class="detail-head-actions">
        <button class="mem-view-toggle" id="${prefix}memOpenLocal" type="button">在本地打开</button>
        ${isArchivedSkill ? '' : `<button class="mem-view-toggle" id="${prefix}memViewToggle" type="button">编辑</button>`}
      </div>
    </div>
    <div class="memory-markdown-view" id="${prefix}dpMemoryPreview"><div class="memory-preview-loading">加载中…</div></div>
    <div class="memory-edit-workspace hidden" id="${prefix}dpMemorySource">
      <section class="memory-edit-pane">
        <div class="memory-pane-head"><span>Markdown</span><code>${escapeHtml(fileLabel)}</code></div>
        <textarea class="data-editor" id="${prefix}dpEditor" spellcheck="false" wrap="soft" placeholder="加载中…"></textarea>
      </section>
      <section class="memory-edit-pane memory-preview-pane">
        <div class="memory-pane-head"><span>实时预览</span></div>
        <div class="memory-markdown-view memory-live-preview" id="${prefix}dpMemoryLivePreview"></div>
      </section>
    </div>
  `;
  const returnToList = () => {
    if (host) host.back(); else backToSettings();
  };

  const editor = q('dpEditor');
  const preview = q('dpMemoryPreview');
  const source = q('dpMemorySource');
  const livePreview = q('dpMemoryLivePreview');
  const toggle = q('memViewToggle');
  const openLocal = q('memOpenLocal');
  openLocal.addEventListener('click', async () => {
    const r = await window.api.data.revealItem(kind, key);
    if (!r || !r.ok) showToast((r && r.message) || '打开失败');
  });
  setBack(returnToList);
  const res = await window.api.data.readItem(kind, key).catch(error => ({ ok: false, message: error.message }));
  if (!body.contains(editor)) return;
  if (!res || !res.ok) {
    preview.textContent = (res && res.message) || '详情加载失败';
    if (toggle) { toggle.textContent = '重试'; toggle.addEventListener('click', () => renderManagedMarkdownEditor(kind, key, title)); }
    return;
  }
  editor.value = (res && res.ok) ? res.content : '';
  const renderPreview = (target = preview) => {
    const body = memoryMarkdownBody(editor.value);
    target.innerHTML = body.trim()
      ? renderMarkdown(body)
      : `<div class="memory-preview-empty">这个${typeLabel}暂无可预览内容。</div>`;
  };
  let liveRenderFrame = 0;
  const scheduleLivePreview = () => {
    cancelAnimationFrame(liveRenderFrame);
    liveRenderFrame = requestAnimationFrame(() => renderPreview(livePreview));
  };
  editor.addEventListener('input', scheduleLivePreview);
  const setEditing = (editing) => {
    preview.classList.toggle('hidden', editing);
    source.classList.toggle('hidden', !editing);
    if (toggle) toggle.style.display = editing ? 'none' : '';
    setBack(editing ? () => setEditing(false) : returnToList);
    showSave(editing && !isArchivedSkill);
    if (editing) {
      renderPreview(livePreview);
      requestAnimationFrame(() => editor.focus());
    }
    else renderPreview();
  };
  if (toggle) toggle.addEventListener('click', () => setEditing(true));
  setEditing(false);
  if (!isArchivedSkill) {
    setSave(async () => {
      const r = await window.api.data.writeItem(kind, key, editor.value);
      if (!body.contains(editor)) return;
      if (r && r.ok) {
        hint.textContent = '✓ 已保存';
        showToast('已保存');
        setEditing(false);
      } else {
        hint.textContent = '';
        showToast((r && r.message) || '保存失败');
      }
    });
  }
}

// Memory navigation owns only its category's content. Keep the settings shell,
// other categories and global save handler mounted while a document is open.
function getMemoryPageHost(mount) {
  if (mount._memoryPage) return mount._memoryPage;
  const list = document.createElement('div'); list.className = 'memory-list-page';
  while (mount.firstChild) list.appendChild(mount.firstChild);
  const detail = document.createElement('section'); detail.className = 'memory-detail'; detail.hidden = true;
  detail.setAttribute('aria-label', '记忆详情'); mount.append(list, detail);
  const records = new Map();
  let active = null, listScroll = 0, listFocus = null, motion = null;
  const owned = () => $('memorySection') === mount || !!settingsViewSnapshot?.fragment?.contains(mount);
  const visible = () => mount.isConnected && mount.closest('.set-cat')?.classList.contains('active');
  const notify = record => { if (owned() && active === record) record.paint?.(); };
  const animate = (node, direction) => {
    motion?.cancel(); motion = null;
    node.dataset.memoryTransition = direction;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !node.animate) return;
    motion = node.animate([{ opacity: .35, transform: `translateX(${direction === 'forward' ? 10 : -8}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' });
  };
  const returnToList = () => {
    if (!active) return;
    active.paint = null; active = null;
    detail.hidden = true; detail.replaceChildren(); list.hidden = false;
    const content = mount.closest('.set-content');
    if (content) content.scrollTop = listScroll;
    animate(list, 'back');
    requestAnimationFrame(() => {
      if (!owned() || active || !visible()) return;
      if (content) content.scrollTop = listScroll;
      if (listFocus?.isConnected) listFocus.focus({ preventScroll: true });
    });
  };
  const load = record => {
    if (record.pendingRead) return record.pendingRead;
    record.loading = true; record.readError = false; record.error = ''; notify(record);
    record.pendingRead = (async () => {
      try {
        const result = await window.api.memory.read(record.file);
        if (!result || !result.ok) throw new Error(result?.message || result?.error || '记忆读取失败，请重试');
        record.original = record.content = String(result.content || ''); record.revision = result.revision; record.loaded = true;
      } catch (error) { record.readError = true; record.error = error.message || '记忆读取失败，请重试'; }
      finally { record.loading = false; record.pendingRead = null; notify(record); }
    })();
    return record.pendingRead;
  };
  const save = async record => {
    if (record.saving || !record.loaded || record.isIndex) return;
    const content = record.content;
    record.saving = true; record.error = ''; record.status = ''; notify(record);
    try {
      const result = await window.api.memory.write(record.file, content, record.revision);
      if (!result || !result.ok) throw new Error(result?.message || result?.error || '保存失败，请重试');
      record.original = content; record.revision = result.revision; record.editing = false; record.status = '已保存';
      if (owned()) void host.refreshList?.().catch(() => {});
    } catch (error) { record.error = error.message || '保存失败，请重试'; }
    finally { record.saving = false; notify(record); }
  };
  const cancel = record => {
    if (record.saving) return;
    record.content = record.original; record.editing = false; record.error = ''; record.status = ''; notify(record);
  };
  const render = record => {
    detail.innerHTML = `
      <header class="memory-detail-head">
        <button class="memory-back" type="button" data-memory-back aria-label="返回记忆列表" title="返回记忆列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
        <div class="memory-detail-title"><h2>${escapeHtml(record.title)}</h2><span>${escapeHtml(record.file)}</span></div>
        <div class="detail-head-actions">${record.isIndex ? '' : '<button class="mem-view-toggle" type="button" data-memory-history aria-expanded="false">修改记录</button>'}<button class="mem-view-toggle" id="memOpenLocal" type="button">在本地打开</button>${record.isIndex ? '' : '<button class="mem-view-toggle" id="memViewToggle" type="button">编辑</button>'}</div>
      </header>
      <div class="memory-version-list set-panel" data-memory-history-list hidden></div>
      <div class="memory-markdown-view" id="dpMemoryPreview" data-memory-file="${escapeAttr(record.file)}"></div>
      <div class="memory-edit-workspace hidden" id="dpMemorySource">
        <section class="memory-edit-pane"><div class="memory-pane-head"><span>Markdown</span><code>${escapeHtml(record.file)}</code></div><textarea class="data-editor" id="dpEditor" aria-label="记忆 Markdown 源码" spellcheck="false" wrap="soft" ${record.isIndex ? 'readonly' : ''}></textarea></section>
        <section class="memory-edit-pane memory-preview-pane"><div class="memory-pane-head"><span>实时预览</span></div><div class="memory-markdown-view memory-live-preview" id="dpMemoryLivePreview" data-memory-file="${escapeAttr(record.file)}"></div></section>
      </div>
      <footer class="memory-detail-footer"><span data-memory-status role="status" aria-live="polite"></span><button class="mem-view-toggle" type="button" data-memory-retry hidden>重试</button>${record.isIndex ? '' : '<button class="mem-view-toggle" type="button" data-memory-cancel hidden>取消编辑</button><button class="memory-save" type="button" data-memory-save hidden>保存</button>'}</footer>`;
    const q = selector => detail.querySelector(selector), editor = q('#dpEditor'), preview = q('#dpMemoryPreview'), source = q('#dpMemorySource'), live = q('#dpMemoryLivePreview');
    const toggle = q('#memViewToggle'), saveButton = q('[data-memory-save]'), cancelButton = q('[data-memory-cancel]'), status = q('[data-memory-status]'), retry = q('[data-memory-retry]');
    let frame = 0;
    const markdown = target => {
      const body = memoryMarkdownBody(record.content);
      target.innerHTML = body.trim() ? renderMarkdown(body) : '<div class="memory-preview-empty">这条记忆暂无正文。</div>';
    };
    record.paint = () => {
      if (active !== record || !detail.contains(editor)) return;
      detail.dataset.memoryFile = record.file; detail.dataset.memoryEditing = String(record.editing);
      detail.setAttribute('aria-busy', String(record.loading || record.saving));
      editor.value = record.content; editor.readOnly = record.isIndex || record.loading || record.saving || !record.loaded;
      preview.classList.toggle('hidden', record.editing); source.classList.toggle('hidden', !record.editing);
      if (toggle) { toggle.hidden = record.editing; toggle.disabled = !record.loaded || record.loading || record.saving; }
      for (const button of [saveButton, cancelButton]) if (button) { button.hidden = !record.editing; button.disabled = record.saving; }
      if (saveButton) saveButton.textContent = record.saving ? '保存中…' : '保存';
      if (historyButton) historyButton.disabled = record.editing || record.saving || record.loading;
      retry.hidden = !record.readError; retry.disabled = record.loading;
      status.textContent = record.error || (record.loading ? '正在读取…' : record.saving ? '正在保存…' : record.status);
      status.dataset.error = String(!!record.error);
      if (record.loaded) markdown(record.editing ? live : preview);
      else { preview.textContent = record.loading ? '正在读取记忆…' : record.error || '正在读取记忆…'; }
    };
    const historyButton = q('[data-memory-history]'), historyList = q('[data-memory-history-list]');
    historyButton?.addEventListener('click', async () => {
      if (record.saving || record.loading || record.editing) return;
      const opening = historyList.hidden;
      historyList.hidden = !opening; historyButton.setAttribute('aria-expanded', String(opening));
      if (!opening) return;
      historyList.textContent = '正在读取修改记录…';
      try {
        const result = await window.api.memory.history(record.file);
        if (!result?.ok) throw new Error(result?.message || '读取修改记录失败');
        if (active !== record || !detail.contains(historyList)) return;
        historyList.replaceChildren();
        const labels = { create: '创建', write: '编辑', update: '编辑', status: '状态调整', approve: '确认候选', restore: '恢复', propose: '候选更新' };
        if (!result.items?.length) historyList.textContent = '暂无修改记录。';
        for (const item of (result.items || []).slice(0, 30)) {
          const row = document.createElement('div'); row.className = 'set-row';
          row.innerHTML = '<div class="set-label"></div><button type="button" class="row-btn">恢复</button>';
          const at = new Date(item.createdAt);
          row.querySelector('.set-label').textContent = (Number.isNaN(at.getTime()) ? '' : at.toLocaleString('zh-CN')) + ' · ' + (labels[item.operation] || '更新') + '留档';
          const button = row.querySelector('button');
          if (item.requiresRelatedRestore) { button.textContent = '恢复关联变更'; button.title = '这条记忆曾参与候选批准，需要连同关联记忆一起恢复。'; }
          button.addEventListener('click', async () => {
            if (record.saving || record.editing) return;
            const accepted = await customConfirm({ title: '恢复记忆', message: (item.requiresRelatedRestore ? '先撤销关联的候选批准或恢复操作。' : '恢复此记录保存的内容。') + '涉及替代关系的记忆将一起恢复，当前内容也会保留版本。', confirmText: '恢复', cancelText: '取消' });
            if (!accepted || active !== record) return;
            record.saving = true; button.disabled = true; notify(record);
            try {
              const restored = await window.api.memory.restore(record.file, item.requiresRelatedRestore ? item.relatedVersionId : item.versionId, record.revision);
              if (!restored?.ok) throw new Error(restored?.message || '恢复失败');
              record.revision = restored.revision; record.status = '已恢复';
              historyList.hidden = true; historyButton.setAttribute('aria-expanded', 'false');
              await load(record); await host.refreshList?.();
            } catch (error) { record.error = error.message || '恢复失败'; }
            finally { record.saving = false; button.disabled = false; notify(record); }
          });
          historyList.appendChild(row);
        }
      } catch (error) { historyList.textContent = error.message || '读取修改记录失败'; }
    });
    q('[data-memory-back]').addEventListener('click', returnToList);
    q('#memOpenLocal').addEventListener('click', async () => {
      try { const result = await window.api.memory.revealFile(record.file); if (!result || !result.ok) throw new Error(result?.message || result?.error || '打开失败'); }
      catch (error) { record.error = error.message || '打开失败'; notify(record); }
    });
    retry.addEventListener('click', () => void load(record));
    toggle?.addEventListener('click', () => {
      record.editing = true; record.status = ''; notify(record);
      requestAnimationFrame(() => { if (active === record && visible()) editor.focus({ preventScroll: true }); });
    });
    saveButton?.addEventListener('click', () => void save(record));
    cancelButton?.addEventListener('click', () => cancel(record));
    editor.addEventListener('input', () => {
      record.content = editor.value; record.status = ''; record.error = '';
      status.textContent = '有未保存的修改'; status.dataset.error = 'false';
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (active === record && detail.contains(live)) markdown(live); });
    });
    record.paint();
  };
  detail.addEventListener('keydown', event => {
    if (!active || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (active.editing) cancel(active); else returnToList();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's' && active.editing) {
      event.preventDefault(); event.stopPropagation(); void save(active);
    }
  });
  const host = {
    refreshList: null,
    async open(file, title) {
      if (!owned()) return;
      let record = records.get(file);
      if (!record) { record = { file, title: title || file, isIndex: file.toLowerCase() === 'memory.md', content: '', original: '', loaded: false, loading: false, readError: false, saving: false, editing: false, error: '', status: '', paint: null }; records.set(file, record); }
      else if (title) record.title = title;
      if (!active) { listScroll = mount.closest('.set-content')?.scrollTop || 0; listFocus = list.contains(document.activeElement) ? document.activeElement : null; }
      if (active) active.paint = null;
      active = record; list.hidden = true; detail.hidden = false;
      render(record);
      const content = mount.closest('.set-content'); if (content) content.scrollTop = 0;
      animate(detail, 'forward');
      requestAnimationFrame(() => { if (active === record && visible()) detail.querySelector('[data-memory-back]')?.focus({ preventScroll: true }); });
      // Files and the generated index may change outside this page. Refresh a
      // clean document on every open, while an unsaved editor owns its draft.
      if (!record.loaded || (!record.editing && !record.saving)) await load(record);
    },
    back: returnToList,
  };
  mount._memoryPage = host;
  return host;
}

// Index links reuse the same right-hand document surface; index remains read-only.
async function renderMemoryEditor(file, title) {
  const mount = $('memorySection');
  if (!mount || typeof file !== 'string' || /[\\/]/.test(file) || !file.toLowerCase().endsWith('.md')) return;
  return getMemoryPageHost(mount).open(file, title);
}


function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── 给 markdown 渲染出的 <pre> 加右上角复制按钮 ──
function enhanceCodeBlocks(container, options = {}) {
  return window.RelayCodeBlocks?.enhance(container, { ...options, preview: html => openCodePreview(html), onError: message => showToast(message) });
}
window.relayEnhanceCodeBlocks = enhanceCodeBlocks;

// HTML code runs in a dedicated right-sidebar browser tab. Source, copy and
// folding remain on the original code block; no full-window preview overlay.
async function openCodePreview(html) {
  try {
    if (!window.relayWorkspacePanel?.openCodePreview) throw new Error('浏览器组件未加载，请重启 Relay');
    return await window.relayWorkspacePanel.openCodePreview(String(html || ''));
  } catch (error) {
    showToast(error.message || '代码预览未能打开');
    return { ok: false };
  }
}

// ── 选中文字 → 右键弹出 复制 气泡(豆包式)──
let copyPopover = null;
// 复制图片到剪贴板:画到 canvas 转 PNG(剪贴板基本只认 image/png),再 write
async function copyImageToClipboard(src) {
  const im = await new Promise((resolve, reject) => {
    const x = new Image();
    x.onload = () => resolve(x);
    x.onerror = reject;
    x.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = im.naturalWidth;
  canvas.height = im.naturalHeight;
  canvas.getContext('2d').drawImage(im, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('blob fail');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function ensureCopyPopover() {
  if (copyPopover) return copyPopover;
  copyPopover = document.createElement('div');
  copyPopover.className = 'copy-popover';
  // 复制按钮(默认),外加一个删除按钮(仅在「我的创作」右键图片时显示)
  copyPopover.innerHTML = `
    <button class="cp-btn"><span>复制</span><kbd>Ctrl+C</kbd></button>
    <button class="cp-btn cp-del" hidden><span>删除</span></button>`;
  document.body.appendChild(copyPopover);
  return copyPopover;
}
function hideCopyPopover() {
  if (copyPopover) copyPopover.classList.remove('show');
}
document.addEventListener('contextmenu', (e) => {
  // 右键图片(创作结果 / 大图查看器)→ 弹"复制图片"
  const imgEl = e.target.closest ? e.target.closest('.cv-cell img, .cv-viewer img') : null;
  if (imgEl) {
    e.preventDefault();
    const src = imgEl.dataset.imgPath ? toFileUrl(imgEl.dataset.imgPath) : imgEl.src;
    const pop = ensureCopyPopover();
    const copyBtn = pop.querySelector('.cp-btn:not(.cp-del)');
    const delBtn  = pop.querySelector('.cp-del');
    const span = copyBtn.querySelector('span'); if (span) span.textContent = '复制图片';
    const kbd = copyBtn.querySelector('kbd'); if (kbd) kbd.style.display = 'none';
    copyBtn.onclick = async () => {
      try { await copyImageToClipboard(src); showToast('图片已复制'); }
      catch { showToast('复制失败'); }
      hideCopyPopover();
    };
    // 删除:仅在「我的创作」弹窗里右键时提供(连同本地文件删除)
    const inMyWork = !!imgEl.closest('.mywork-body');
    const imgPath = imgEl.dataset.imgPath || '';
    if (delBtn) {
      if (inMyWork && imgPath) {
        delBtn.hidden = false;
        delBtn.onclick = async () => {
          hideCopyPopover();
          const ok = await customConfirm({
            title: '删除图片',
            message: '这张图片将从「库」移除，并删除本地文件，无法恢复。确定删除吗？',
            confirmText: '删除', cancelText: '取消', danger: true,
          });
          if (!ok) return;
          const r = await window.api.image.deleteSaved(imgPath);
          if (r && r.ok) {
            const cell = imgEl.closest('.cv-cell');
            if (cell) cell.remove();
            showToast('已删除');
          } else {
            showToast('删除失败' + (r && r.error ? '：' + r.error : ''));
          }
        };
      } else {
        delBtn.hidden = true;
        delBtn.onclick = null;
      }
    }
    // 弹窗高度随是否含删除项变化,定位用实际尺寸
    const popH = inMyWork ? 78 : 38;
    let ix = e.clientX, iy = e.clientY + 6;
    if (ix + 148 > window.innerWidth)  ix = window.innerWidth - 156;
    if (iy + popH > window.innerHeight) iy = e.clientY - popH - 6;
    pop.style.left = ix + 'px'; pop.style.top = iy + 'px';
    pop.classList.add('show');
    return;
  }
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  if (!text.trim()) { hideCopyPopover(); return; }
  e.preventDefault();
  const pop = ensureCopyPopover();
  // 复位为文字复制态(图片态可能改过文案/隐藏了 kbd/显示了删除按钮)
  const copyBtn0 = pop.querySelector('.cp-btn:not(.cp-del)');
  const span0 = copyBtn0.querySelector('span'); if (span0) span0.textContent = '复制';
  const kbd0 = copyBtn0.querySelector('kbd'); if (kbd0) kbd0.style.display = '';
  const delBtn0 = pop.querySelector('.cp-del'); if (delBtn0) { delBtn0.hidden = true; delBtn0.onclick = null; }
  const w = 130, h = 38;
  let x = e.clientX, y = e.clientY + 6;
  if (x + w > window.innerWidth)  x = window.innerWidth - w - 8;
  if (y + h > window.innerHeight) y = e.clientY - h - 6;
  pop.style.left = x + 'px';
  pop.style.top  = y + 'px';
  pop.classList.add('show');
  copyBtn0.onclick = async () => {
    try { await navigator.clipboard.writeText(text); showToast('已复制'); }
    catch { showToast('复制失败'); }
    hideCopyPopover();
  };
});
document.addEventListener('mousedown', (e) => {
  if (copyPopover && !copyPopover.contains(e.target)) hideCopyPopover();
});
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || !sel.toString().trim()) hideCopyPopover();
});

// 顶部居中浮动提示(2 秒自动消失)
let toastTimer = null;
function showToast(text) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}


// 设置页分段选择器：用于少量、固定且适合并排比较的选项。
// 保留 id + data-value 约定，保存逻辑和主题即时预览无需区分控件类型。
function buildSettingsSegmented(id, options, value) {
  const sel = options.find((o) => o.value === value) || options[0];
  const buttons = options.map((o) => {
    const active = o.value === sel.value;
    return `
      <button type="button" class="${active ? 'active' : ''}" role="radio"
        aria-checked="${active}" aria-disabled="${!!o.disabled}" ${o.disabled ? 'disabled' : ''} data-value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</button>
    `;
  }).join('');
  return `
    <div class="settings-segmented" id="${id}" data-value="${escapeAttr(sel.value)}"
      role="radiogroup">${buttons}</div>
  `;
}

function bindSettingsSegmented(rootEl) {
  rootEl.querySelectorAll('.settings-segmented').forEach((group) => {
    const buttons = Array.from(group.querySelectorAll('button[data-value]'));
    const selectButton = (button, focus = false) => {
      if (!button || button.disabled || button.classList.contains('active')) return;
      group.dataset.value = button.dataset.value;
      buttons.forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
      if (focus) button.focus();
      group.dispatchEvent(new CustomEvent('settings-segment-change', {
        detail: { value: group.dataset.value },
      }));
    };

    group.addEventListener('click', (event) => {
      selectButton(event.target.closest('button[data-value]'));
    });
    group.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const available = buttons.filter(button => !button.disabled);
      if (!available.length) return;
      const current = Math.max(0, available.indexOf(document.activeElement));
      let next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + available.length) % available.length;
      if (event.key === 'ArrowRight') next = (current + 1) % available.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = available.length - 1;
      event.preventDefault();
      selectButton(available[next], true);
    });
  });
}

// 自绘下拉(替代原生 <select>,完全可控样式)
function buildCustomSelect(id, options, value) {
  const sel = options.find(o => o.value === value) || options[0];
  const items = options.map(o => `
    <div class="cs-option ${o.value === sel.value ? 'selected' : ''}" data-value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</div>
  `).join('');
  return `
    <div class="custom-select" id="${id}" data-value="${escapeAttr(sel.value)}">
      <div class="cs-trigger" tabindex="0">
        <span class="cs-text">${escapeHtml(sel.label)}</span>
        <svg class="cs-chev" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="cs-popup" hidden>${items}</div>
    </div>
  `;
}

let activeCustomSelect = null;

function closeCustomSelect() {
  const active = activeCustomSelect;
  if (!active) return;
  activeCustomSelect = null;
  cancelAnimationFrame(active.frame);
  if (active.popup.matches(':popover-open')) active.popup.hidePopover();
  active.popup.hidden = true;
  active.trigger.setAttribute('aria-expanded', 'false');
}

function revealCustomSelectOption(popup, option) {
  // Scroll only the options, never the containing settings/workspace page.
  const item = option.getBoundingClientRect();
  const menu = popup.getBoundingClientRect();
  const top = menu.top + popup.clientTop;
  const bottom = top + popup.clientHeight;
  if (item.top < top) popup.scrollTop -= top - item.top;
  else if (item.bottom > bottom) popup.scrollTop += item.bottom - bottom;
}

function positionCustomSelect(active) {
  const { root, trigger, popup } = active;
  // Closed <details> can retain layout rects even though their controls are hidden.
  if (!trigger.isConnected || !trigger.checkVisibility({ visibilityProperty: true }) || popup.hidden) {
    closeCustomSelect();
    return;
  }
  const r = trigger.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const geometry = [r.left, r.top, r.width, r.height, viewportWidth, viewportHeight].join(',');
  if (geometry !== active.geometry) {
    // A trigger scrolled out of its page should not leave an orphaned top-layer menu.
    let clipTop = 0, clipBottom = viewportHeight, clipLeft = 0, clipRight = viewportWidth;
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
      const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
      if (!clipsY && !clipsX) continue;
      const bounds = parent.getBoundingClientRect();
      if (clipsY) { clipTop = Math.max(clipTop, bounds.top); clipBottom = Math.min(clipBottom, bounds.bottom); }
      if (clipsX) { clipLeft = Math.max(clipLeft, bounds.left); clipRight = Math.min(clipRight, bounds.right); }
    }
    if (r.bottom <= clipTop || r.top >= clipBottom || r.right <= clipLeft || r.left >= clipRight) {
      closeCustomSelect();
      return;
    }

    const gap = 4, edge = 10;
    const maxWidth = Math.max(0, viewportWidth - edge * 2);
    popup.style.minWidth = `${Math.min(maxWidth, Math.max(r.width, Number(root.dataset.popupWidth) || 0))}px`;
    popup.style.maxWidth = `${maxWidth}px`;
    const requestedHeight = Math.max(120, Number(root.dataset.popupHeight) || 264);
    popup.style.maxHeight = `${requestedHeight}px`;
    const desiredHeight = Math.min(requestedHeight, popup.scrollHeight + 2);
    const belowSpace = Math.max(0, viewportHeight - r.bottom - gap - edge);
    const aboveSpace = Math.max(0, r.top - gap - edge);
    const openAbove = belowSpace < desiredHeight && aboveSpace > belowSpace;
    popup.style.maxHeight = `${Math.min(requestedHeight, Math.floor(openAbove ? aboveSpace : belowSpace))}px`;
    popup.classList.toggle('open-up', openAbove);
    popup.style.left = `${Math.max(edge, Math.min(r.right - popup.offsetWidth, viewportWidth - edge - popup.offsetWidth))}px`;
    popup.style.top = openAbove ? 'auto' : `${r.bottom + gap}px`;
    popup.style.bottom = openAbove ? `${viewportHeight - r.top + gap}px` : 'auto';
    active.geometry = geometry;
  }
  // Follow scrolling, window resizing and animated sidebar/layout changes while open.
  active.frame = requestAnimationFrame(() => positionCustomSelect(active));
}

function bindCustomSelects(rootEl) {
  rootEl.querySelectorAll('.custom-select').forEach((root) => {
    const trigger = root.querySelector('.cs-trigger');
    const popup   = root.querySelector('.cs-popup');
    const text    = root.querySelector('.cs-text');
    const opts    = root.querySelectorAll('.cs-option');
    // The top layer escapes transformed/container-query ancestors without moving
    // the DOM, preserving scoped styles, option listeners and keyboard bubbling.
    popup.setAttribute('popover', 'manual');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = popup.hidden;
      closeCustomSelect();
      if (opening) {
        popup.style.visibility = 'hidden';
        popup.hidden = false;
        popup.showPopover();
        activeCustomSelect = { root, trigger, popup, frame: 0, geometry: '' };
        positionCustomSelect(activeCustomSelect);
        popup.style.visibility = '';
        const selected = popup.querySelector('.cs-option.selected');
        if (!popup.hidden && selected) revealCustomSelectOption(popup, selected);
        trigger.setAttribute('aria-expanded', String(!popup.hidden));
      }
    });

    opts.forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        root.dataset.value = val;
        text.textContent = opt.textContent.trim();
        opts.forEach((o) => o.classList.toggle('selected', o === opt));
        closeCustomSelect();
      });
    });
  });
}

// 全局:点击空白处关下拉
document.addEventListener('click', () => {
  closeCustomSelect();
  closeProviderModelPickers();
});
document.addEventListener('keydown', (event) => {
  if (!activeCustomSelect || !['Escape', 'Tab'].includes(event.key)) return;
  const trigger = activeCustomSelect.trigger;
  closeCustomSelect();
  if (event.key === 'Escape') {
    event.preventDefault();
    trigger.focus({ preventScroll: true });
  }
});

// 替换浏览器原生 confirm,用同款 UI 风格的对话框
function customConfirm({ title = '', message = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <div class="confirm-body">
          ${title ? `<div class="confirm-title"></div>` : ''}
          <div class="confirm-message"></div>
        </div>
        <div class="confirm-actions">
          <button class="confirm-btn cancel" type="button"></button>
          <button class="confirm-btn ${danger ? 'danger' : 'primary'}" type="button"></button>
        </div>
      </div>
    `;
    if (title) overlay.querySelector('.confirm-title').textContent = title;
    overlay.querySelector('.confirm-message').textContent = message;
    const cancelBtn  = overlay.querySelector('.confirm-btn.cancel');
    const confirmBtn = overlay.querySelector('.confirm-btn.primary, .confirm-btn.danger');
    cancelBtn.textContent  = cancelText;
    confirmBtn.textContent = confirmText;

    document.body.appendChild(overlay);
    // 默认焦点放在"取消",防止误按 Enter 触发危险操作
    cancelBtn.focus();

    const cleanup = (result) => {
      document.removeEventListener('keydown', keyHandler);
      overlay.remove();
      resolve(result);
    };
    cancelBtn.onclick  = () => cleanup(false);
    confirmBtn.onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter' && document.activeElement === confirmBtn) {
        e.preventDefault(); cleanup(true);
      }
    };
    document.addEventListener('keydown', keyHandler);
  });
}

// 文本输入对话框(复用 confirm 弹层样式),返回字符串;取消返回 null
// aiAction(可选):{ label, run } —— 弹窗左下多一个 AI 按钮,点击调 run() 异步取文本填入输入框
//   (只填不提交,用户可编辑、确认才生效;失败按钮短暂提示可重试)。
function customPrompt({ title = '', message = '', value = '', placeholder = '', confirmText = '确定', cancelText = '取消', maxLength = 0, aiAction = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <div class="confirm-body">
          ${title ? `<div class="confirm-title"></div>` : ''}
          ${message ? `<div class="confirm-message"></div>` : ''}
          <input type="text" class="confirm-input" />
        </div>
        <div class="confirm-actions">
          ${aiAction ? '<button class="confirm-btn ai" type="button"></button>' : ''}
          <button class="confirm-btn cancel" type="button"></button>
          <button class="confirm-btn primary" type="button"></button>
        </div>
      </div>
    `;
    if (title) overlay.querySelector('.confirm-title').textContent = title;
    if (message) overlay.querySelector('.confirm-message').textContent = message;
    const input = overlay.querySelector('.confirm-input');
    input.value = value || '';
    input.placeholder = placeholder || '';
    // maxLength 按字符数粗挡(挡住超长粘贴);视觉宽的精确截断由落盘处(saveConversation)统一做
    if (maxLength > 0) input.maxLength = maxLength;
    const cancelBtn  = overlay.querySelector('.confirm-btn.cancel');
    const confirmBtn = overlay.querySelector('.confirm-btn.primary');
    cancelBtn.textContent  = cancelText;
    confirmBtn.textContent = confirmText;

    document.body.appendChild(overlay);
    input.focus(); input.select();

    const cleanup = (result) => {
      document.removeEventListener('keydown', keyHandler);
      overlay.remove();
      resolve(result);
    };
    cancelBtn.onclick  = () => cleanup(null);
    confirmBtn.onclick = () => cleanup(input.value.trim());
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    // AI 按钮:取文本填入输入框。弹窗若在生成中被关掉,后到的结果写向已移除的节点,无副作用。
    if (aiAction) {
      const aiBtn = overlay.querySelector('.confirm-btn.ai');
      const label = aiAction.label || 'AI 总结';
      aiBtn.textContent = label;
      aiBtn.onclick = async () => {
        aiBtn.disabled = true; aiBtn.textContent = '生成中…';
        let t = '';
        try { t = (await aiAction.run()) || ''; } catch (_) {}
        aiBtn.disabled = false;
        aiBtn.textContent = t ? label : '失败,可重试';
        if (t) { input.value = t; input.focus(); input.select(); }
      };
    }
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); cleanup(input.value.trim()); }
    };
    document.addEventListener('keydown', keyHandler);
  });
}

// 底部「保存」当前要执行的动作:主设置页 = 保存全部设置;Claude/MCP 子面板 = 保存该文件。
//   这样子面板的保存也走最外层底部按钮(和取消并排),风格统一。其它子面板(Agent/技能/历史)不需要保存则置空并隐藏按钮。
let activeSaveHandler = null;

async function saveMainSettings() {
  if (!modalBody.querySelector('.set-layout')) return;   // 主表单未挂载,忽略
  const payload = {
    claude: {},
    app: {
      allowCommandTasks:   $('sw-allowCommand') ? $('sw-allowCommand').classList.contains('on') : false,
      quickChatEnabled:    $('sw-quickChat') ? $('sw-quickChat').classList.contains('on') : true,
      conversationIndex:   $('sw-conversationIndex') ? $('sw-conversationIndex').classList.contains('on') : true,
      showContextUsage:    $('sw-showContextUsage') ? $('sw-showContextUsage').classList.contains('on') : true,
      theme:               $('set-theme') ? $('set-theme').dataset.value : undefined,
    },
  };
  const generalView = generalPreferencesView;
  const generalPatch = generalView?.getPatch() || {};
  const guidanceView = personalizationGuidanceView;
  const guidancePatch = guidanceView?.getPatch() || {};
  Object.assign(payload.app, generalPatch, guidancePatch);
  const behaviorDefault = $('behaviorDefaultModel');
  if (behaviorDefault?.dataset.edited === 'true') {
    const selected = behaviorDefault.querySelector('button.active');
    if (!selected || selected.disabled) throw new Error('该默认档位当前不可用，请先配置服务商或选择其他档位');
    payload.claude.defaultModel = behaviorDefault.dataset.value;
  }
  const editRevision = settingsEditRevision;
  const settingsForm = modalBody.querySelector('.set-layout');
  const requireSaved = (result) => {
    if (!result || result.ok === false) throw new Error(result?.message || result?.error || '未收到保存确认');
  };
  const savesGuidance = Object.hasOwn(guidancePatch, 'relayInstructions');
  if (savesGuidance) guidanceView.beginSave();
  let savedSettings;
  try {
    savedSettings = await window.api.settings.write(payload);
    requireSaved(savedSettings);
    if (pendingSettings?.app) Object.assign(pendingSettings.app, payload.app);
    if (savesGuidance) guidanceView.finishSave(guidancePatch.relayInstructions);
  } catch (error) {
    if (savesGuidance) guidanceView.finishSave(null, error);
    throw error;
  }
  const runtimeUpdate = generalView?.saved(generalPatch);
  if (generalPatch.followUpMode) { followUpMode = generalPatch.followUpMode; syncComposerAction(); }
  if (generalPatch.agentEnvironment) agentEnvironment = generalPatch.agentEnvironment;
  if (savedSettings.routes) applyProviderRouting(savedSettings.routes);
  // 主题即时切换
  if (payload.app && payload.app.theme) {
    _themeSetting = payload.app.theme;
    applyThemeToDOM(_themeSetting);
  }
  setConversationIndexEnabled(payload.app.conversationIndex);
  setContextUsageEnabled(payload.app.showContextUsage);
  const hint = settingsEditRevision === editRevision ? '✓ 已保存' : '有未保存的修改';
  if (settingsViewSnapshot?.fragment.contains(settingsForm)) settingsViewSnapshot.hint = hint;
  else if (settingsForm && modalBody.contains(settingsForm)) {
    modalHint.dataset.error = 'false';
    modalHint.textContent = hint;
    setTimeout(() => { if (settingsForm && modalBody.contains(settingsForm) && modalHint.textContent === '✓ 已保存') modalHint.textContent = ''; }, 2000);
  }
  // A slow or unavailable executor must not block persisting desktop preferences.
  if (runtimeUpdate) void Promise.resolve(runtimeUpdate).then(result => {
    if (!result?.deferred || generalView !== generalPreferencesView || settingsEditRevision !== editRevision) return;
    const message = '已保存，部分选项将在下次运行时生效';
    if (settingsViewSnapshot?.fragment.contains(settingsForm)) settingsViewSnapshot.hint = message;
    else if (settingsForm && modalBody.contains(settingsForm)) { modalHint.dataset.error = 'false'; modalHint.textContent = message; }
  });
}

// ─────────────────────────────────────────
// 定时任务视图
// ─────────────────────────────────────────
(function initScheduleView() {
  const sched = (window.api && window.api.scheduler) || null;
  const scheduleModalEl = $('scheduleModal');
  if (!sched || !scheduleModalEl) return;

  const btnNavs     = ['btnSchedule', 'cvBtnSchedule'].map((id) => $(id)).filter(Boolean);
  const listPane    = $('svListPane');
  const editorPane  = $('svEditorPane');
  const editorFooter = $('svEditorFooter');
  const editorBack  = $('svEditorBack');
  const editorSave  = $('svEditorSave');
  const editorHint  = $('svEditorHint');
  const listEl      = $('svList');
  const emptyEl     = $('svEmpty');
  const addBtn      = $('svModalAdd');
  const searchInput = $('svSearchInput');
  const tasksPanel = $('svTasksPanel');
  const runsPanel = $('svRunsPanel');
  const pageTabs = [$('svTasksTab'), $('svRunsTab')];
  const runsList = $('svRunsList');
  const runsSearch = $('svRunsSearch');
  const runsTaskFilter = $('svRunsTaskFilter');
  const runsRefresh = $('svRunsRefresh');
  const runsSummary = $('svRunsSummary');
  const runsMore = $('svRunsMore');
  const surface = scheduleModalEl.querySelector('.workspace-surface');
  let activePage = 'tasks';
  let runTaskId = '';
  let runRecords = [];
  let runsLoaded = false;
  let runLimit = 20;
  const pageScroll = { tasks: 0, runs: 0 };
  let runFilterSignature = '';
  let editingTask = null;
  let creatingTask = false;
  let scheduleItems = [];
  let activeDraft = null;
  let savingTaskKey = null;
  let refreshRevision = 0;
  let runsRevision = 0;
  const editorDrafts = new Map();
  const pendingActions = new Set();
  const taskKey = (task) => task && task.id || '__new__';
  const taskConfiguration = (task) => JSON.stringify({
    name: task.name, action: task.action, schedule: task.schedule,
    catchUp: task.catchUp, delivery: task.delivery,
  });
  bindTransientScrollbar(listPane);
  bindTransientScrollbar(editorPane);
  bindTransientScrollbar(scheduleModalEl.querySelector('.workspace-surface'));
  // Reflow the existing draft when the window or sidebar changes its available width.
  // Observe the pane once; resize the active textarea without replacing its node or value.
  if (typeof ResizeObserver === 'function') {
    let promptLayoutWidth = 0;
    let promptLayoutFrame = 0;
    const promptLayoutObserver = new ResizeObserver((entries) => {
      const width = entries[0] && entries[0].contentRect.width;
      if (!width) { promptLayoutWidth = 0; return; }
      if (Math.abs(width - promptLayoutWidth) < 0.5) return;
      promptLayoutWidth = width;
      cancelAnimationFrame(promptLayoutFrame);
      promptLayoutFrame = requestAnimationFrame(() => {
        promptLayoutFrame = 0;
        if (activeDraft && activeDraft.resizePromptInput) activeDraft.resizePromptInput();
      });
    });
    promptLayoutObserver.observe(editorPane);
  }

  // The page stays mounted. Each task retains its own form nodes and listeners.
  const isModalOpen = () => !scheduleModalEl.classList.contains('hidden');
  function retainEditorDraft() {
    if (!activeDraft) return;
    activeDraft.nodes = Array.from(editorPane.childNodes);
    activeDraft.hint = editorHint.textContent;
    activeDraft.scrollTop = editorPane.scrollTop;
    editorDrafts.set(activeDraft.key, activeDraft);
  }
  function updateEditorDirtyState() {
    if (!activeDraft || savingTaskKey) return;
    activeDraft.dirty = activeDraft.isNew || activeDraft.readState() !== activeDraft.initialState;
    editorSave.disabled = !activeDraft.dirty;
    editorHint.textContent = activeDraft.dirty ? '有未保存的更改' : '配置已保存';
    const title = editorPane.querySelector('[data-sv-detail-title]');
    if (title) title.textContent = editorPane.querySelector('#svEditName').value.trim() || '未命名任务';
    renderFilteredList();
  }
  editorPane.addEventListener('input', updateEditorDirtyState);
  editorPane.addEventListener('change', updateEditorDirtyState);
  editorPane.addEventListener('click', (event) => {
    if (event.target.closest('.cs-option, .settings-segmented button, .segmented-option')) queueMicrotask(updateEditorDirtyState);
  });
  function showScheduleList() {
    if (savingTaskKey) return;
    const selectedId = editingTask && editingTask.id;
    if (activeDraft) editorDrafts.delete(activeDraft.key);
    activeDraft = null;
    const selected = scheduleItems.find((task) => task.id === selectedId) || scheduleItems[0];
    if (selected) {
      openTaskEditor(selected, { discard: true });
    } else {
      editingTask = null;
      creatingTask = false;
      editorPane.classList.remove('hidden');
      editorPane.innerHTML = '<div class="sv-detail-empty"><h2>让工作按时开始</h2><p>新建一项任务，安排内容与重复时间。</p></div>';
      editorFooter.classList.add('hidden');
      renderFilteredList();
    }
  }
  function selectSchedulePage(page, { taskId } = {}) {
    if (page !== 'runs') page = 'tasks';
    const changed = activePage !== page;
    if (changed) {
      closeCustomSelect();
      pageScroll[activePage] = surface.scrollTop;
      retainEditorDraft();
      activePage = page;
    }
    if (typeof taskId === 'string') {
      runTaskId = taskId;
      runsSearch.value = '';
      runLimit = 20;
      pageScroll.runs = 0;
    }
    tasksPanel.classList.toggle('hidden', page !== 'tasks');
    runsPanel.classList.toggle('hidden', page !== 'runs');
    pageTabs.forEach((tab, index) => {
      const selected = (index === 0) === (page === 'tasks');
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    if (changed) surface.scrollTop = pageScroll[page];
    if (page === 'runs') {
      renderRunTaskFilter();
      void refreshRunHistory();
    } else if (activeDraft?.resizePromptInput) {
      requestAnimationFrame(activeDraft.resizePromptInput);
    }
  }
  pageTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectSchedulePage(index ? 'runs' : 'tasks'));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      pageTabs[next].focus();
      selectSchedulePage(next ? 'runs' : 'tasks');
    });
  });
  runsSearch.addEventListener('input', () => { runLimit = 20; renderRunRecords(); });
  runsRefresh.addEventListener('click', () => refreshRunHistory());
  runsMore.addEventListener('click', () => { runLimit += 20; renderRunRecords(); });

  function showScheduleView() {
    if (typeof showAppView === 'function') showAppView('scheduler');
    else scheduleModalEl.classList.remove('hidden');
    refresh();
  }
  function closeScheduleModal() {
    retainEditorDraft();
    if (typeof returnToConversationView === 'function') returnToConversationView();
    else scheduleModalEl.classList.add('hidden');
  }
  window.openScheduleModal = showScheduleView;
  btnNavs.forEach((b) => b.addEventListener('click', showScheduleView));
  const closeBtn = $('svModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeScheduleModal);
  if (editorBack) {
    editorBack.textContent = '取消';
    editorBack.addEventListener('click', showScheduleList);
  }
  if (addBtn) addBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    selectSchedulePage('tasks');
    openTaskEditor(null, { focus: true });
  });

  // ── 拉取并渲染 ──
  function renderFilteredList() {
    const query = String(searchInput && searchInput.value || '').trim().toLocaleLowerCase();
    const items = query
      ? scheduleItems.filter((task) => String(task.name || '').toLocaleLowerCase().includes(query))
      : scheduleItems;
    renderList(items, { query, total: scheduleItems.length });
  }
  async function refresh() {
    const revision = ++refreshRevision;
    try {
      const result = await sched.list();
      if (revision !== refreshRevision) return;
      if (!result || !result.ok) throw new Error(result && result.error || '读取定时任务失败');
      scheduleItems = result.items || [];
    } catch (error) {
      if (revision === refreshRevision) showToast(error.message || '读取定时任务失败');
      return;
    }
    for (const [key, draft] of editorDrafts) {
      if (draft === activeDraft || draft.dirty || draft.isNew) continue;
      const task = scheduleItems.find((item) => item.id === key);
      if (!task || taskConfiguration(task) !== taskConfiguration(draft.task)) editorDrafts.delete(key);
    }
    const latestSelected = activeDraft && scheduleItems.find((task) => task.id === activeDraft.key);
    if (activeDraft && !activeDraft.dirty && !savingTaskKey && latestSelected
      && taskConfiguration(latestSelected) !== taskConfiguration(activeDraft.task)) {
      openTaskEditor(latestSelected, { discard: true });
    }
    renderFilteredList();
    if (!activeDraft) {
      if (scheduleItems.length) openTaskEditor(scheduleItems[0]);
      else showScheduleList();
    }
    updateTaskStatus();
    if (activePage === 'runs') { renderRunTaskFilter(); void refreshRunHistory(); }
  }
  if (searchInput) searchInput.addEventListener('input', renderFilteredList);

  function fmtNext(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '—';
    const d = new Date(t), now = Date.now();
    const diff = t - now;
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = d.toDateString() === new Date().toDateString();
    let when;
    if (sameDay) when = `今天 ${hhmm}`;
    else {
      const tmr = new Date(now + 86400000);
      if (d.toDateString() === tmr.toDateString()) when = `明天 ${hhmm}`;
      else when = `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
    }
    if (diff > 0 && diff < 3600000) when += `（${Math.max(1, Math.round(diff / 60000))} 分钟后）`;
    return when;
  }

  // 把常见 cron 翻译成人话（每天/工作日/每周X/每月X日 + 时刻）；翻译不了的原样展示
  function cronDesc(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5) return `cron：${cron || ''}`;
    const [min, hour, dom, mon, dow] = parts;
    const nums = (s) => (/^\d+(,\d+)*$/.test(s) ? s.split(',').map(Number) : null);
    const m = nums(min), hs = nums(hour);
    if (!m || m.length !== 1 || !hs) return `cron：${cron}`;
    const pad = (n) => String(n).padStart(2, '0');
    const times = hs.map((h) => `${pad(h)}:${pad(m[0])}`).join('、');
    const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const monthStep = mon.match(/^\*\/(\d+)$/);
    const dayStep = dom.match(/^\*\/(\d+)$/);
    const steppedMonthDay = nums(dom);
    if (monthStep && dow === '*' && steppedMonthDay && steppedMonthDay.length === 1) {
      return `每 ${Number(monthStep[1])} 个月的 ${steppedMonthDay[0]} 日 ${times}`;
    }
    if (mon === '*' && dayStep && dow === '*') return `每 ${Number(dayStep[1])} 天 ${times}`;
    if (mon !== '*') return `cron：${cron}`;
    if (dom === '*' && dow === '*') return `每天 ${times}`;
    if (dom === '*' && (dow === '1-5' || dow === '1,2,3,4,5')) return `工作日 ${times}`;
    const ds = nums(dow);
    if (dom === '*' && ds) return `每${ds.map((d) => DOW[d % 7]).join('、')} ${times}`;
    const doms = nums(dom);
    if (dow === '*' && doms && doms.length === 1) return `每月 ${doms[0]} 日 ${times}`;
    return `cron：${cron}`;
  }

  function schedDesc(task) {
    const s = task.schedule || {};
    if (s.kind === 'at') return '一次性';
    if (s.kind === 'every') {
      const ms = s.everyMs || 0;
      if (ms % 86400000 === 0) return `每 ${ms / 86400000} 天`;
      if (ms % 3600000 === 0) return `每 ${ms / 3600000} 小时`;
      return `每 ${Math.round(ms / 60000)} 分钟`;
    }
    return cronDesc(s.cron);
  }

  const EDIT_MODEL_OPTIONS = [
    { value: 'haiku', label: '快速' },
    { value: 'sonnet', label: '思考' },
    { value: 'opus', label: '专家' },
  ];
  const EDIT_MEMORY_OPTIONS = [
    { value: 'off', label: '不使用' },
    { value: 'read', label: '只读' },
    { value: 'readwrite', label: '可读写' },
  ];
  const EDIT_MODE_OPTIONS = [
    { value: 'plain', label: '普通对话' },
    { value: 'agent', label: 'Agent' },
  ];
  const EDIT_TYPE_OPTIONS = [
    { value: 'chat', label: '对话任务' },
    { value: 'image', label: '图像生成' },
    { value: 'command', label: '命令任务' },
  ];
  const EDIT_REPEAT_OPTIONS = [
    { value: 'daily', label: '每天' },
    { value: 'weekdays', label: '工作日' },
    { value: 'weekly', label: '每周' },
    { value: 'monthly', label: '每月' },
    { value: 'custom', label: '自定义' },
    { value: 'at', label: '仅一次' },
    { value: 'every', label: '固定间隔' },
    { value: 'cron', label: 'Cron 表达式' },
  ];
  const EDIT_CUSTOM_REPEAT_OPTIONS = [
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每周' },
    { value: 'monthly', label: '每月' },
  ];
  const EDIT_WEEK_OPTIONS = [
    { value: '1', label: '每周一' }, { value: '2', label: '每周二' },
    { value: '3', label: '每周三' }, { value: '4', label: '每周四' },
    { value: '5', label: '每周五' }, { value: '6', label: '每周六' },
    { value: '0', label: '每周日' },
  ];
  function parseScheduleForEditor(schedule) {
    const s = schedule || {};
    const state = {
      repeat: 'cron',
      time: '09:00',
      weekDay: '1',
      monthDay: '1',
      customRepeat: 'monthly',
      customInterval: '1',
      cron: String(s.cron || '0 9 * * *'),
      at: '',
      everyAmount: '1',
      everyUnit: '3600000',
    };
    if (s.kind === 'at') {
      const date = new Date(Date.parse(s.at || ''));
      state.repeat = 'at';
      if (!isNaN(date)) {
        const pad = (value) => String(value).padStart(2, '0');
        state.at = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      }
      return state;
    }
    if (s.kind === 'every') {
      const ms = Math.max(1000, Number(s.everyMs) || 3600000);
      const unit = [86400000, 3600000, 60000, 1000].find((value) => ms % value === 0) || 1000;
      state.repeat = 'every';
      state.everyUnit = String(unit);
      state.everyAmount = String(ms / unit);
      return state;
    }
    const parts = state.cron.trim().split(/\s+/);
    if (parts.length !== 5) return state;
    const [minute, hour, dom, month, dow] = parts;
    if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return state;
    state.time = `${String(+hour).padStart(2, '0')}:${String(+minute).padStart(2, '0')}`;
    if (month === '*' && dom === '*' && dow === '*') state.repeat = 'daily';
    else if (month === '*' && dom === '*' && (dow === '1-5' || dow === '1,2,3,4,5')) state.repeat = 'weekdays';
    else if (month === '*' && dom === '*' && /^[0-6]$/.test(dow)) {
      state.repeat = 'weekly';
      state.weekDay = dow;
    } else if (month === '*' && dow === '*' && /^(?:[1-9]|[12]\d|3[01])$/.test(dom)) {
      state.repeat = 'monthly';
      state.monthDay = dom;
    } else {
      state.repeat = 'cron';
      const monthStep = month.match(/^\*\/(\d{1,2})$/);
      const dayStep = dom.match(/^\*\/(\d{1,2})$/);
      if (dow === '*' && /^(?:[1-9]|[12]\d|3[01])$/.test(dom) && monthStep) {
        if (Number(monthStep[1]) > 12) return state;
        state.repeat = 'custom';
        state.customRepeat = 'monthly';
        state.customInterval = String(Math.min(12, Number(monthStep[1])));
        state.monthDay = dom;
      } else if (month === '*' && dow === '*' && dayStep) {
        if (Number(dayStep[1]) > 12) return state;
        state.repeat = 'custom';
        state.customRepeat = 'daily';
        state.customInterval = String(Math.min(12, Number(dayStep[1])));
      } else if (month === '*' && dom === '*' && /^[0-6]$/.test(dow)) {
        state.customRepeat = 'weekly';
        state.customInterval = '1';
        state.weekDay = dow;
      }
    }
    return state;
  }

  function openTaskEditor(task, { discard = false, focus = false } = {}) {
    if (!editorPane || !editorFooter || !editorSave) return;
    if (savingTaskKey) { showToast('正在保存，请稍候'); return; }
    const key = taskKey(task);
    if (activeDraft && activeDraft.key === key && !discard) return;
    if (!discard) retainEditorDraft();
    const cached = editorDrafts.get(key);
    if (cached && !discard) {
      activeDraft = cached;
      creatingTask = cached.isNew;
      editingTask = cached.isNew ? null : cached.task;
      editorPane.replaceChildren(...cached.nodes);
      editorPane.classList.remove('hidden');
      editorFooter.classList.remove('hidden');
      editorSave.onclick = cached.save;
      editorSave.disabled = !cached.dirty;
      editorHint.textContent = cached.hint;
      editorPane.scrollTop = cached.scrollTop || 0;
      if (cached.resizePromptInput) requestAnimationFrame(cached.resizePromptInput);
      renderFilteredList();
      updateTaskStatus();
      return;
    }
    const isNew = !task;
    creatingTask = isNew;
    task = task || {
      name: '',
      enabled: true,
      catchUp: true,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { type: 'chat', prompt: '', model: 'haiku', memory: 'read', mode: 'plain', agentName: null },
      delivery: { notify: true, saveToHistory: true },
    };
    editingTask = isNew ? null : task;
    const action = task.action || {};
    const scheduleState = parseScheduleForEditor(task.schedule);
    const taskType = ['chat', 'image', 'command'].includes(action.type) ? action.type : 'chat';
    const model = ['haiku', 'sonnet', 'opus'].includes(action.model) ? action.model : 'haiku';
    const memory = ['off', 'read', 'readwrite'].includes(action.memory) ? action.memory : 'read';
    const actionMode = action.mode === 'agent' ? 'agent' : 'plain';
    const agentName = typeof action.agentName === 'string' ? action.agentName : '';
    const webhook = task.delivery && task.delivery.webhook;
    const webhookUrl = typeof webhook === 'string' ? webhook : (webhook && webhook.url) || '';
    const webhookSecret = webhook && typeof webhook === 'object' ? (webhook.secret || '') : '';
    const promptText = taskType === 'command' ? (action.command || '') : (action.prompt || '');
    const numberedOptions = (start, end, suffix = '', pad = true) => Array.from(
      { length: end - start + 1 },
      (_, index) => {
        const n = start + index;
        const value = pad ? String(n).padStart(2, '0') : String(n);
        return { value, label: suffix ? `${value} ${suffix}` : value };
      },
    );
    const editTimeOptions = [];
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 15, 30, 45]) {
        const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        editTimeOptions.push({ value, label: `${hour}:${String(minute).padStart(2, '0')}` });
      }
    }
    if (!editTimeOptions.some((item) => item.value === scheduleState.time)) {
      const [hour, minute] = scheduleState.time.split(':').map(Number);
      if (Number.isFinite(hour) && Number.isFinite(minute)) {
        editTimeOptions.push({ value: scheduleState.time, label: `${hour}:${String(minute).padStart(2, '0')}` });
        editTimeOptions.sort((a, b) => a.value.localeCompare(b.value));
      }
    }
    const monthDayOptions = numberedOptions(1, 31, '', false);

    if (addBtn) addBtn.classList.remove('hidden');
    if (listPane) listPane.classList.remove('hidden');
    editorPane.classList.remove('hidden');
    editorFooter.classList.remove('hidden');
    if (editorHint) editorHint.textContent = '';
    editorPane.innerHTML = `
      <div class="sv-editor">
        <header class="sv-detail-head">
          <div><div class="sv-detail-eyebrow">${isNew ? '新建任务' : '任务详情'}</div><h2 data-sv-detail-title></h2><p data-sv-detail-status></p></div>
          <div class="sv-detail-actions${isNew ? ' hidden' : ''}">
            <button type="button" class="btn-ghost" data-sv-detail-history>运行记录</button>
            <button type="button" class="btn-ghost" data-sv-detail-toggle></button>
            <button type="button" class="btn-ghost" data-sv-detail-run>立即运行</button>
          </div>
        </header>
        <section class="sv-edit-primary">
          <label for="svEditName" class="sv-field-label">任务名称</label>
          <input class="sv-edit-name" id="svEditName" maxlength="80" autocomplete="off"
            aria-label="任务名称" placeholder="${isNew ? '已安排任务标题' : '任务名称'}">
          <label for="svEditPrompt" class="sv-field-label">任务内容</label>
          <textarea class="sv-edit-prompt" id="svEditPrompt" spellcheck="false"
            aria-label="任务内容" placeholder="${isNew ? '描述 Relay 应该做什么' : '任务内容'}"></textarea>
        </section>

        <section class="sv-edit-section" aria-labelledby="svExecutionTitle">
          <div class="sv-edit-section-title" id="svExecutionTitle">执行设置</div>
          <div class="sv-edit-panel">
            <div class="sv-edit-row">
              <span>任务类型</span>
              ${buildCustomSelect('svEditType', EDIT_TYPE_OPTIONS, taskType)}
            </div>
            <div class="sv-edit-row" data-sv-chat-only>
              <span>模型</span>
              ${buildSettingsSegmented('svEditModel', EDIT_MODEL_OPTIONS, model)}
            </div>
            <div class="sv-edit-row" data-sv-chat-only>
              <span>执行方式</span>
              ${buildCustomSelect('svEditMode', EDIT_MODE_OPTIONS, actionMode)}
            </div>
            <div class="sv-edit-row ${actionMode === 'agent' ? '' : 'hidden'}" data-sv-agent-only>
              <span>Agent ID</span>
              <input class="sv-edit-inline-input" id="svEditAgentName" maxlength="120"
                spellcheck="false" autocomplete="off" placeholder="与 Agent 文件 name 一致" value="${escapeAttr(agentName)}">
            </div>
            <div class="sv-edit-row" data-sv-chat-only>
              <span>长期记忆</span>
              ${buildCustomSelect('svEditMemory', EDIT_MEMORY_OPTIONS, memory)}
            </div>
          </div>
        </section>

        <section class="sv-edit-section">
          <div class="sv-edit-section-title">频率</div>
          <div class="sv-edit-panel">
            <div class="sv-edit-row">
              <span>重复</span>
              ${buildCustomSelect('svEditRepeat', EDIT_REPEAT_OPTIONS, scheduleState.repeat)}
            </div>
            <div class="sv-edit-row hidden" data-sv-at-row>
              <label for="svEditAt">运行日期与时间</label>
              <input class="sv-edit-inline-input" id="svEditAt" type="datetime-local" step="1" value="${escapeAttr(scheduleState.at)}">
            </div>
            <div class="sv-edit-row hidden" data-sv-every-row>
              <label for="svEditEveryAmount">每隔</label>
              <div class="sv-every-controls"><input class="sv-edit-inline-input" id="svEditEveryAmount" type="number" min="0.001" step="any" value="${escapeAttr(scheduleState.everyAmount)}">
              ${buildCustomSelect('svEditEveryUnit', [{value:'1000',label:'秒'}, {value:'60000',label:'分钟'}, {value:'3600000',label:'小时'}, {value:'86400000',label:'天'}], scheduleState.everyUnit)}</div>
            </div>
            <div class="sv-edit-row hidden" data-sv-cron-row>
              <label for="svEditCron">Cron 表达式</label>
              <input class="sv-edit-inline-input sv-mono" id="svEditCron" autocomplete="off" spellcheck="false" value="${escapeAttr(scheduleState.cron)}">
            </div>
            <div class="sv-edit-row hidden" data-sv-custom-repeat-row>
              <span>重复</span>
              ${buildCustomSelect('svEditCustomRepeat', EDIT_CUSTOM_REPEAT_OPTIONS, scheduleState.customRepeat)}
            </div>
            <div class="sv-edit-row hidden" data-sv-custom-interval-row>
              <span>每隔</span>
              <label class="sv-custom-interval">
                <input id="svEditCustomInterval" type="number" min="1" max="12" step="1"
                  inputmode="numeric" value="${escapeAttr(scheduleState.customInterval)}">
                <span data-sv-custom-unit>个月</span>
              </label>
            </div>
            <div class="sv-edit-row hidden" data-sv-week-row>
              <span>在以下日期</span>
              ${buildCustomSelect('svEditWeekDay', EDIT_WEEK_OPTIONS, scheduleState.weekDay)}
            </div>
            <div class="sv-edit-row hidden" data-sv-month-row>
              <span>在以下日期</span>
              ${buildCustomSelect('svEditMonthDay', monthDayOptions, scheduleState.monthDay)}
            </div>
            <div class="sv-edit-row" data-sv-time-row>
              <span>时间</span>
              ${buildCustomSelect('svEditTime', editTimeOptions, scheduleState.time)}
            </div>
            <div class="sv-edit-row" title="Relay 未运行时错过计划，下次启动是否补跑最近一次">
              <span>错过后补跑</span>
              <label class="sv-switch"><input id="svEditCatchUp" type="checkbox" ${task.catchUp !== false ? 'checked' : ''}><span class="sv-slider"></span></label>
            </div>
          </div>
          <p class="sv-schedule-timezone">${escapeHtml(task.schedule && task.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时间')} · 单次日期按本机时间输入</p>
        </section>

        <details class="sv-edit-section sv-edit-advanced">
          <summary class="sv-edit-section-title">完成后投递</summary>
          <div class="sv-edit-panel">
            <div class="sv-edit-row">
              <span>Webhook</span>
              <input class="sv-edit-inline-input" id="svEditWebhookUrl" type="url" maxlength="2048"
                spellcheck="false" autocomplete="off" placeholder="https://example.com/hook" value="${escapeAttr(webhookUrl)}">
            </div>
            <div class="sv-edit-row" title="用于 HMAC-SHA256 签名，接收方使用同一密钥验证请求">
              <span>签名密钥</span>
              <input class="sv-edit-inline-input" id="svEditWebhookSecret" type="password" maxlength="512"
                autocomplete="new-password" placeholder="启用 Webhook 时必填，至少 16 字节" value="${escapeAttr(webhookSecret)}">
            </div>
          </div>
        </details>
      </div>
    `;

    const nameInput = editorPane.querySelector('#svEditName');
    const promptInput = editorPane.querySelector('#svEditPrompt');
    const typeRoot = editorPane.querySelector('#svEditType');
    const modelRoot = editorPane.querySelector('#svEditModel');
    const modeRoot = editorPane.querySelector('#svEditMode');
    const agentNameInput = editorPane.querySelector('#svEditAgentName');
    const memoryRoot = editorPane.querySelector('#svEditMemory');
    const repeatRoot = editorPane.querySelector('#svEditRepeat');
    const customRepeatRoot = editorPane.querySelector('#svEditCustomRepeat');
    const customIntervalInput = editorPane.querySelector('#svEditCustomInterval');
    const weekRoot = editorPane.querySelector('#svEditWeekDay');
    const timeRoot = editorPane.querySelector('#svEditTime');
    const monthDayRoot = editorPane.querySelector('#svEditMonthDay');
    const catchUpInput = editorPane.querySelector('#svEditCatchUp');
    const webhookUrlInput = editorPane.querySelector('#svEditWebhookUrl');
    const webhookSecretInput = editorPane.querySelector('#svEditWebhookSecret');
    const atInput = editorPane.querySelector('#svEditAt');
    const everyAmountInput = editorPane.querySelector('#svEditEveryAmount');
    const everyUnitRoot = editorPane.querySelector('#svEditEveryUnit');
    const cronInput = editorPane.querySelector('#svEditCron');

    nameInput.value = task.name || '';
    promptInput.value = promptText;

    const resizePromptInput = () => {
      if (!promptInput.isConnected || !promptInput.clientWidth) return;
      const minHeight = 74;
      const maxHeight = 148;
      promptInput.style.height = `${minHeight}px`;
      promptInput.style.overflowY = 'hidden';
      const contentHeight = promptInput.scrollHeight;
      promptInput.style.height = `${Math.min(maxHeight, Math.max(minHeight, contentHeight))}px`;
      promptInput.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    };
    promptInput.addEventListener('input', resizePromptInput);
    requestAnimationFrame(resizePromptInput);

    editorPane.querySelectorAll('.custom-select').forEach((root) => {
      root.dataset.popupWidth = '128';
      root.dataset.popupHeight = '360';
    });
    bindCustomSelects(editorPane);
    bindSettingsSegmented(editorPane);
    bindTransientScrollbar(promptInput);
    editorPane.querySelectorAll('.custom-select').forEach(root => bindScheduleSelectKeyboard(root, updateEditorDirtyState));

    const updateAgentRow = () => {
      const show = typeRoot.dataset.value === 'chat' && modeRoot.dataset.value === 'agent';
      editorPane.querySelectorAll('[data-sv-agent-only]').forEach((row) => row.classList.toggle('hidden', !show));
    };
    const updateTypeRows = () => {
      const chat = typeRoot.dataset.value === 'chat';
      editorPane.querySelectorAll('[data-sv-chat-only]').forEach((row) => row.classList.toggle('hidden', !chat));
      const command = typeRoot.dataset.value === 'command';
      promptInput.placeholder = command ? '执行命令' : (isNew ? '描述 Relay 应该做什么' : '任务内容');
      promptInput.setAttribute('aria-label', command ? '执行命令' : '任务内容');
      promptInput.classList.toggle('sv-mono', command);
      updateAgentRow();
    };
    const updateScheduleRows = () => {
      const repeat = repeatRoot.dataset.value;
      const custom = repeat === 'custom';
      const customRepeat = customRepeatRoot.dataset.value;
      editorPane.querySelector('[data-sv-at-row]').classList.toggle('hidden', repeat !== 'at');
      editorPane.querySelector('[data-sv-every-row]').classList.toggle('hidden', repeat !== 'every');
      editorPane.querySelector('[data-sv-cron-row]').classList.toggle('hidden', repeat !== 'cron');
      editorPane.querySelector('[data-sv-time-row]').classList.toggle('hidden', ['at', 'every', 'cron'].includes(repeat));
      editorPane.querySelector('[data-sv-custom-repeat-row]').classList.toggle('hidden', !custom);
      editorPane.querySelector('[data-sv-custom-interval-row]').classList.toggle('hidden', !custom);
      editorPane.querySelector('[data-sv-week-row]').classList.toggle(
        'hidden', repeat !== 'weekly' && !(custom && customRepeat === 'weekly'));
      editorPane.querySelector('[data-sv-month-row]').classList.toggle(
        'hidden', repeat !== 'monthly' && !(custom && customRepeat === 'monthly'));
      const customUnit = editorPane.querySelector('[data-sv-custom-unit]');
      if (customUnit) {
        customUnit.textContent = customRepeat === 'daily' ? '天'
          : customRepeat === 'weekly' ? '周' : '个月';
      }
    };
    typeRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateTypeRows));
    modeRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateAgentRow));
    repeatRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateScheduleRows));
    customRepeatRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateScheduleRows));
    updateTypeRows();
    updateScheduleRows();

    const scheduleControls = [repeatRoot, timeRoot, customRepeatRoot, customIntervalInput,
      weekRoot, monthDayRoot, atInput, everyAmountInput, everyUnitRoot, cronInput];
    const controlValue = (control) => control.dataset.value !== undefined ? control.dataset.value
      : control.type === 'checkbox' ? control.checked : control.value;
    const readScheduleState = () => JSON.stringify(scheduleControls.map(controlValue));
    const initialScheduleState = readScheduleState();
    const buildEditedSchedule = () => {
      if (!isNew && readScheduleState() === initialScheduleState) return { ...task.schedule };
      const repeat = repeatRoot.dataset.value;
      if (repeat === 'at') {
        const at = new Date(atInput.value);
        if (!atInput.value || !Number.isFinite(at.getTime())) throw new Error('请选择运行日期与时间');
        return { kind: 'at', at: at.toISOString() };
      }
      if (repeat === 'every') {
        const everyMs = Number(everyAmountInput.value) * Number(everyUnitRoot.dataset.value);
        if (!Number.isSafeInteger(everyMs) || everyMs < 1000) throw new Error('固定间隔至少为 1 秒');
        return { kind: 'every', everyMs };
      }
      if (repeat === 'cron') {
        const cron = cronInput.value.trim();
        if (!cron) throw new Error('请输入 Cron 表达式');
        return { kind: 'cron', cron };
      }
      const timeMatch = String(timeRoot.dataset.value || '').match(/^(\d{2}):(\d{2})$/);
      if (!timeMatch) throw new Error('请选择运行时间');
      const hour = Number(timeMatch[1]), minute = Number(timeMatch[2]);
      if (hour > 23 || minute > 59) throw new Error('运行时间无效');
      if (repeat === 'custom') {
        const interval = Math.round(Number(customIntervalInput.value));
        if (!Number.isFinite(interval) || interval < 1 || interval > 12) {
          throw new Error('间隔应为 1–12');
        }
        const customRepeat = customRepeatRoot.dataset.value;
        if (customRepeat === 'daily') {
          const dayToken = interval === 1 ? '*' : `*/${interval}`;
          return { kind: 'cron', cron: `${minute} ${hour} ${dayToken} * *` };
        }
        if (customRepeat === 'weekly') {
          if (interval !== 1) throw new Error('按星期重复时，每隔目前仅支持 1 周');
          const weekDay = weekRoot.dataset.value;
          return { kind: 'cron', cron: `${minute} ${hour} * * ${weekDay}` };
        }
        const monthDay = Math.round(Number(monthDayRoot.dataset.value));
        if (!Number.isFinite(monthDay) || monthDay < 1 || monthDay > 31) {
          throw new Error('每月日期应为 1–31');
        }
        const monthToken = interval === 1 ? '*' : `*/${interval}`;
        return { kind: 'cron', cron: `${minute} ${hour} ${monthDay} ${monthToken} *` };
      }
      if (repeat === 'daily') return { kind: 'cron', cron: `${minute} ${hour} * * *` };
      if (repeat === 'weekdays') return { kind: 'cron', cron: `${minute} ${hour} * * 1-5` };
      if (repeat === 'weekly') return { kind: 'cron', cron: `${minute} ${hour} * * ${weekRoot.dataset.value}` };
      const monthDay = Math.round(Number(monthDayRoot.dataset.value));
      if (!Number.isFinite(monthDay) || monthDay < 1 || monthDay > 31) throw new Error('每月日期应为 1–31');
      return { kind: 'cron', cron: `${minute} ${hour} ${monthDay} * *` };
    };

    const saveDraft = async () => {
      if (savingTaskKey) return;
      if (pendingActions.has(key)) { showToast('正在更新任务状态，请稍候'); return; }
      const name = nameInput.value.trim();
      const text = promptInput.value.trim();
      if (!name) { editorHint.textContent = '请输入任务名称'; nameInput.focus(); return; }
      if (!text) { editorHint.textContent = typeRoot.dataset.value === 'command' ? '请输入执行命令' : '请输入任务内容'; promptInput.focus(); return; }
      editorSave.disabled = true;
      savingTaskKey = key;
      editorBack.disabled = true;
      editorPane.inert = true;
      editorPane.setAttribute('aria-busy', 'true');
      editorHint.textContent = '正在保存…';
      updateTaskStatus();
      try {
        const currentTask = scheduleItems.find((item) => item.id === task.id) || task;
        const enabled = currentTask.enabled !== false;
        const schedule = { ...(task.schedule || {}), ...buildEditedSchedule() };
        const preview = await sched.preview(schedule);
        const completedOnce = !enabled && schedule.kind === 'at';
        if (!preview || !preview.ok || (!(preview.times || []).length && !completedOnce)) {
          throw new Error('调度设置无效，无法计算下次运行时间');
        }
        const type = typeRoot.dataset.value;
        const webhookUrlValue = webhookUrlInput.value.trim();
        const webhookSecretValue = webhookSecretInput.value;
        if (webhookUrlValue && !/^https:\/\//i.test(webhookUrlValue)) {
          throw new Error('Webhook 仅支持 HTTPS 地址');
        }
        if (webhookUrlValue && !webhookSecretValue) {
          throw new Error('启用 Webhook 时必须填写签名密钥');
        }
        if (webhookSecretValue && new TextEncoder().encode(webhookSecretValue).length < 16) {
          throw new Error('Webhook 签名密钥至少需要 16 字节');
        }
        const editedAction = {
          ...(task.action || {}),
          type,
        };
        if (type === 'command') editedAction.command = text;
        else editedAction.prompt = text;
        if (type === 'chat') {
          editedAction.model = modelRoot.dataset.value;
          editedAction.memory = memoryRoot.dataset.value;
          editedAction.mode = modeRoot.dataset.value === 'agent' ? 'agent' : 'plain';
          editedAction.agentName = editedAction.mode === 'agent' ? agentNameInput.value.trim() : null;
          if (editedAction.mode === 'agent' && !editedAction.agentName) {
            throw new Error('Agent 模式必须填写 Agent ID');
          }
        }
        const payload = {
          name,
          enabled,
          catchUp: !!catchUpInput.checked,
          schedule,
          action: editedAction,
          delivery: {
            ...(task.delivery || {}),
            notify: !task.delivery || task.delivery.notify !== false,
            saveToHistory: !task.delivery || task.delivery.saveToHistory !== false,
            webhook: webhookUrlValue ? {
              ...(webhook && typeof webhook === 'object' ? webhook : {}),
              url: webhookUrlValue,
              secret: webhookSecretValue || null,
              maxRetries: webhook && Number.isFinite(webhook.maxRetries) ? webhook.maxRetries : 2,
            } : null,
          },
        };
        const result = isNew
          ? await sched.create(payload)
          : await sched.update(task.id, payload);
        if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
        showToast(isNew ? '定时任务已创建' : '定时任务已保存');
        if (isNew && searchInput) searchInput.value = '';
        const saved = result.task || { ...task, ...payload, id: result.id || task.id };
        editorDrafts.delete(key);
        activeDraft = null;
        savingTaskKey = null;
        scheduleItems = scheduleItems.filter((item) => item.id !== saved.id).concat(saved);
        openTaskEditor(saved, { discard: true });
        await refresh();
      } catch (e) {
        editorHint.textContent = (e && e.message) || '保存失败';
      } finally {
        savingTaskKey = null;
        editorBack.disabled = false;
        editorPane.inert = false;
        editorPane.removeAttribute('aria-busy');
        editorSave.disabled = !!activeDraft && !activeDraft.dirty;
        updateTaskStatus();
      }
    };
    editorSave.onclick = saveDraft;
    const formControls = Array.from(editorPane.querySelectorAll('input, textarea, .custom-select, .settings-segmented'));
    const readState = () => JSON.stringify(formControls.map(controlValue));
    activeDraft = { key, task, isNew, dirty: isNew, readState, initialState: readState(), save: saveDraft, resizePromptInput };
    modelRoot.addEventListener('settings-segment-change', updateEditorDirtyState);
    retainEditorDraft();
    updateEditorDirtyState();
    updateTaskStatus();
    const runButton = editorPane.querySelector('[data-sv-detail-run]');
    const toggleButton = editorPane.querySelector('[data-sv-detail-toggle]');
    editorPane.querySelector('[data-sv-detail-history]').addEventListener('click', () => selectSchedulePage('runs', { taskId: task.id }));
    runButton.addEventListener('click', () => runTask(task.id));
    toggleButton.addEventListener('click', () => {
      const current = scheduleItems.find((item) => item.id === task.id) || task;
      toggleTask(task.id, !current.enabled);
    });
    if (focus) requestAnimationFrame(() => nameInput.isConnected && nameInput.focus());
  }

  async function runTask(id) {
    if (!id || pendingActions.has(id) || savingTaskKey) return;
    const task = scheduleItems.find((item) => item.id === id);
    if (!task || task.running) return;
    pendingActions.add(id);
    updateTaskStatus();
    renderFilteredList();
    try {
      const result = await sched.runNow(id);
      if (!result || !result.ok) throw new Error(result && result.error || '运行失败');
      showToast('任务已开始运行');
    } catch (error) {
      showToast(error.message || '运行失败');
    } finally {
      pendingActions.delete(id);
      await refresh();
    }
  }

  async function toggleTask(id, enabled) {
    if (!id || pendingActions.has(id) || savingTaskKey) return;
    pendingActions.add(id);
    updateTaskStatus();
    renderFilteredList();
    try {
      const result = await sched.toggle(id, enabled);
      if (!result || !result.ok) throw new Error(result && result.error || '更新任务状态失败');
      showToast(enabled ? '任务已启用' : '任务已暂停');
    } catch (error) {
      showToast(error.message || '更新任务状态失败');
    } finally {
      pendingActions.delete(id);
      await refresh();
    }
  }

  function updateTaskStatus() {
    if (!activeDraft) return;
    const task = scheduleItems.find((item) => item.id === activeDraft.key);
    const status = editorPane.querySelector('[data-sv-detail-status]');
    const toggle = editorPane.querySelector('[data-sv-detail-toggle]');
    const run = editorPane.querySelector('[data-sv-detail-run]');
    if (!status || !toggle || !run) return;
    if (activeDraft.isNew) status.textContent = '设置内容与时间，保存后生效';
    else if (!task) status.textContent = '任务已移除，未保存的内容仍保留';
    else status.textContent = task.running ? '正在运行' : `${schedDesc(task)} · ${task.enabled ? `下次 ${fmtNext(task.nextRunAt)}` : '已暂停'}`;
    const unavailable = !task || pendingActions.has(activeDraft.key) || !!savingTaskKey;
    toggle.disabled = unavailable;
    toggle.textContent = task && task.enabled ? '暂停' : '启用';
    toggle.setAttribute('aria-pressed', String(!!(task && task.enabled)));
    run.disabled = unavailable || !!(task && task.running);
    run.textContent = task && task.running ? '运行中' : '立即运行';
  }

  function bindScheduleSelectKeyboard(root, onChange) {
  const trigger = root.querySelector('.cs-trigger');
  const popup = root.querySelector('.cs-popup');
  const options = Array.from(root.querySelectorAll('.cs-option'));
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  popup.setAttribute('role', 'listbox');
  options.forEach((option) => {
    option.tabIndex = -1;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(option.classList.contains('selected')));
    option.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'false');
      options.forEach((item) => item.setAttribute('aria-selected', String(item === option)));
      if (onChange) onChange();
    });
  });
  trigger.addEventListener('click', () => trigger.setAttribute('aria-expanded', String(!popup.hidden)));
  root.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      closeCustomSelect();
      trigger.focus({ preventScroll: true });
      return;
    }
    const index = options.indexOf(document.activeElement);
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      options[index].click();
      trigger.focus({ preventScroll: true });
      return;
    }
    if (popup.hidden) trigger.click();
    let next = index < 0 ? Math.max(0, options.findIndex((option) => option.classList.contains('selected'))) : index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (index >= 0 && event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (index >= 0 && event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    options[next].focus({ preventScroll: true });
    revealCustomSelectOption(popup, options[next]);
  });
  }

  function renderRunTaskFilter() {
    const options = [{ value: '', label: '全部任务' }, ...scheduleItems.map(task => ({ value: task.id, label: task.name || '未命名任务' }))];
    if (runTaskId && !scheduleItems.some(task => task.id === runTaskId)) options.push({ value: runTaskId, label: '已移除的任务' });
    const signature = JSON.stringify([options, runTaskId]);
    if (signature === runFilterSignature) return;
    runFilterSignature = signature;
    runsTaskFilter.innerHTML = buildCustomSelect('svRunTaskSelect', options, runTaskId);
    const control = runsTaskFilter.firstElementChild;
    control.dataset.popupWidth = '240';
    control.dataset.popupHeight = '320';
    control.querySelector('.cs-trigger').setAttribute('aria-label', '按任务筛选运行记录');
    bindCustomSelects(runsTaskFilter);
    bindScheduleSelectKeyboard(control);
    control.querySelectorAll('.cs-option').forEach(option => option.addEventListener('click', () => {
      runTaskId = control.dataset.value || '';
      runFilterSignature = '';
      runLimit = 20;
      renderRunRecords();
    }));
  }

  async function refreshRunHistory() {
    if (activePage !== 'runs' || !isModalOpen()) return;
    const revision = ++runsRevision;
    runsRefresh.disabled = true;
    runsRefresh.setAttribute('aria-busy', 'true');
    if (!runsLoaded) runsList.innerHTML = '<p class="sv-run-empty">正在读取运行记录…</p>';
    if (!sched.runs) { runsLoaded = true; runRecords = []; renderRunRecords(); runsRefresh.disabled = false; runsRefresh.removeAttribute('aria-busy'); return; }
    try {
      // The API already supports all tasks. One snapshot also retains records for
      // deleted tasks and lets filtering stay instant, without per-task requests.
      const result = await sched.runs();
      if (revision !== runsRevision) return;
      if (!result || !result.ok) throw new Error('读取运行记录失败');
      runRecords = (result.items || []).slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
      runsLoaded = true;
      renderRunRecords();
    } catch (_) {
      if (revision !== runsRevision) return;
      runsSummary.textContent = '运行记录暂时无法加载，请点击右侧刷新重试。';
      if (!runsLoaded) runsList.replaceChildren();
    } finally {
      if (revision === runsRevision) { runsRefresh.disabled = false; runsRefresh.removeAttribute('aria-busy'); }
    }
  }

  function renderRunRecords() {
    const query = runsSearch.value.trim().toLocaleLowerCase();
    const taskNames = new Map(scheduleItems.map(task => [task.id, task.name || '未命名任务']));
    const titleOf = record => taskNames.get(record.taskId) || record.taskName || record.name || '已移除的任务';
    const records = runRecords.filter(record => (!runTaskId || record.taskId === runTaskId)
      && (!query || [titleOf(record), record.summary, record.error].some(value => String(value || '').toLocaleLowerCase().includes(query))));
    runsSummary.textContent = records.length ? `${records.length} 条运行记录` : '';
    runsMore.classList.toggle('hidden', records.length <= runLimit);
    runsMore.textContent = `显示更多（还有 ${Math.max(0, records.length - runLimit)} 条）`;
    runsList.replaceChildren();
    if (!records.length) {
      runsList.innerHTML = `<div class="sv-runs-empty"><h2>${query ? '没有找到相关记录' : '还没有运行记录'}</h2><p>${query ? '试试其他关键词，或切换任务筛选。' : '任务运行后，可以在这里查看结果与执行时间。'}</p></div>`;
      return;
    }
    const statuses = { ok: '已完成', error: '失败', canceled: '已取消', skipped: '已跳过', blocked: '未执行' };
    const durationText = ms => {
      if (!Number.isFinite(ms)) return '';
      const seconds = Math.max(0, Math.round(ms / 1000));
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
      return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', rest || !seconds ? `${rest} 秒` : ''].filter(Boolean).join(' ');
    };
    for (const record of records.slice(0, runLimit)) {
      const row = document.createElement('article');
      row.className = 'sv-run-record';
      row.dataset.taskId = record.taskId || '';
      const date = new Date(record.at);
      const when = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '时间未知';
      const duration = durationText(record.ms);
      row.innerHTML = `<div class="sv-run-record-head"><div class="sv-run-heading"><h2>${escapeHtml(titleOf(record))}</h2><span>${escapeHtml(when)}${duration ? ` · ${escapeHtml(duration)}` : ''}</span></div><span class="sv-run-status${record.status === 'error' ? ' is-error' : ''}">${escapeHtml(statuses[record.status] || '已结束')}</span></div><div class="sv-run-output" role="region" tabindex="0"></div><div class="sv-run-record-actions"></div>`;
      const output = row.querySelector('.sv-run-output');
      output.setAttribute('aria-label', `${titleOf(record)} ${when} 运行结果`);
      bindTransientScrollbar(output);
      const content = String(record.error || record.summary || (record.status === 'ok' ? '任务已完成。' : '暂无更多信息。'));
      if (typeof window.relayRenderReadOnlyMarkdown === 'function') window.relayRenderReadOnlyMarkdown(output, content);
      else output.textContent = content;
      const actions = row.querySelector('.sv-run-record-actions');
      const task = scheduleItems.find(item => item.id === record.taskId);
      if (task) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn-ghost sv-run-task-open';
        edit.textContent = '任务设置';
        edit.addEventListener('click', () => { selectSchedulePage('tasks'); openTaskEditor(task); });
        actions.appendChild(edit);
      }
      if (record.conversationId) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-ghost sv-run-open';
        button.title = '在对话中查看完整结果';
        button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 18.5 3 21V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5Z"/><path d="M8 8h8M8 12h5"/></svg><span>查看完整结果</span>';
        button.addEventListener('click', async () => {
          closeScheduleModal();
          if (record.conversationKind === 'create') await loadCreateConv(record.conversationId);
          else await loadConversation(record.conversationId);
        });
        actions.appendChild(button);
      }
      if (!actions.childNodes.length) actions.remove();
      runsList.appendChild(row);
    }
  }

  async function removeTask(task) {
    if (savingTaskKey || pendingActions.has(task.id)) { showToast('正在更新任务，请稍候'); return; }
    pendingActions.add(task.id);
    renderFilteredList();
    updateTaskStatus();
    try {
      const yes = await customConfirm({
        title: '删除定时任务',
        message: `确定删除「${task.name || '未命名任务'}」？此操作无法撤销。`,
        confirmText: '删除',
        danger: true,
      });
      if (!yes) return;
      const result = await sched.remove(task.id);
      if (!result || !result.ok) throw new Error(result && result.error || '删除失败');
      editorDrafts.delete(task.id);
      if (activeDraft && activeDraft.key === task.id) {
        activeDraft = null;
        editingTask = null;
      }
      await refresh();
    } catch (error) { showToast(error.message || '删除失败'); }
    finally {
      pendingActions.delete(task.id);
      updateTaskStatus();
      renderFilteredList();
    }
  }

  function renderList(items, { query = '', total = items.length } = {}) {
    const focusedCard = document.activeElement && document.activeElement.closest('.sv-card');
    const focusedKey = focusedCard && focusedCard.dataset.taskId;
    const focusedDelete = document.activeElement && document.activeElement.classList.contains('sv-card-delete');
    Array.from(listEl.querySelectorAll('.sv-card')).forEach((card) => card.remove());
    const hasNewDraft = creatingTask || editorDrafts.has('__new__');
    emptyEl.style.display = items.length || hasNewDraft ? 'none' : '';
    if (!items.length && !hasNewDraft) {
      const title = emptyEl.querySelector('h2');
      const description = emptyEl.querySelector('p:not(.sv-note)');
      const note = emptyEl.querySelector('.sv-note');
      if (title) title.textContent = query && total ? '没有找到相关任务' : '还没有定时任务';
      if (description) description.textContent = query && total ? '试试搜索其他任务名称' : '点击“新建任务”，安排内容与时间。';
      if (note) note.style.display = query && total ? 'none' : '';
    }
    const visible = hasNewDraft ? [null, ...items] : items;
    for (const task of visible) {
      const key = taskKey(task);
      const cached = activeDraft && activeDraft.key === key ? activeDraft : editorDrafts.get(key);
      const draftInput = cached && cached.nodes && cached.nodes.flatMap((node) => node.querySelectorAll ? [...node.querySelectorAll('#svEditName')] : [])[0];
      const name = draftInput ? draftInput.value.trim() : task && task.name;
      const selected = !!activeDraft && activeDraft.key === key;
      const card = document.createElement('div');
      card.className = 'sv-card' + (selected ? ' is-selected' : '') + (task && !task.enabled ? ' paused' : '');
      card.dataset.taskId = key;
      const select = document.createElement('button');
      select.className = 'sv-card-select';
      select.type = 'button';
      select.setAttribute('aria-pressed', String(selected));
      select.innerHTML = '<span class="sv-card-name"></span><span class="sv-card-meta"></span><span class="sv-card-state"></span>';
      select.querySelector('.sv-card-name').textContent = name || (task ? '未命名任务' : '新建任务草稿');
      select.querySelector('.sv-card-meta').textContent = task ? schedDesc(task) : '配置内容与运行时间';
      const status = !task ? '未保存' : task.running ? '运行中' : task.enabled ? '已启用' : '已暂停';
      select.querySelector('.sv-card-state').textContent = status + (task && cached && cached.dirty ? ' · 未保存' : '');
      select.addEventListener('click', () => openTaskEditor(task));
      card.appendChild(select);
      if (task) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sv-card-delete btn-icon';
        remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
        remove.title = '删除定时任务';
        remove.setAttribute('aria-label', `删除「${task.name || '未命名任务'}」`);
        remove.disabled = !!savingTaskKey || pendingActions.has(task.id);
        remove.addEventListener('click', () => removeTask(task));
        card.appendChild(remove);
      }
      listEl.appendChild(card);
    }
    if (focusedKey) {
      const card = Array.from(listEl.querySelectorAll('.sv-card')).find((item) => item.dataset.taskId === focusedKey);
      const target = card && card.querySelector(focusedDelete ? '.sv-card-delete' : '.sv-card-select');
      if (target) target.focus({ preventScroll: true });
    }
  }

  // 主进程推送任务状态变化 → 刷新（仅当本视图可见时）
  if (sched.onUpdate) sched.onUpdate(() => {
    // 定时任务模态打开时刷新它本身（列表/倒计时）
    if (isModalOpen()) refresh();
    // 始终刷新侧边栏历史会话列表：定时任务跑完会新写一条历史会话,
    //   不管当前在哪个视图,都要让它立刻冒出来（否则要点别的会话才触发刷新）。
    try { refreshHistoryList(); } catch (_) {}
  });
})();

$('btnSettingsSave').addEventListener('click', async () => {
  if (!activeSaveHandler || settingsSaveBusy) return;
  settingsSaveBusy = true;
  btnSettingsSaveEl.disabled = true;
  $('btnSettingsCancel').disabled = true;
  try { await activeSaveHandler(); }
  catch (error) {
    modalHint.dataset.error = 'true';
    modalHint.textContent = '保存未完成：' + (error.message || '请重试');
  } finally {
    settingsSaveBusy = false;
    btnSettingsSaveEl.disabled = false;
    $('btnSettingsCancel').disabled = false;
  }
});

// Keep the original feature buttons and their event handlers when customizing navigation.
window.relaySidebarExplore = window.RelaySidebarExplore.create({ document, window });


function openPlugins(category) {
  window.relayPluginsPage?.open(typeof category === 'string' ? category : undefined);
}
window.relayPluginsPage = window.RelayPluginsPage.create({
  page: $('pluginsPage'),
  navigate: () => showAppView('plugins'),
  returnToConversation: returnToConversationView,
  render: (category, mount) => category === 'package' ? window.RelaySdkPluginManager.create(mount) : category === 'skill' ? renderSkillCuratorPanel(mount)
    : category === 'agent' ? renderAgentSkillPanel('agent', mount) : renderMcpPanel(mount),
});
$('btnPlugins').addEventListener('click', () => openPlugins());

// Application shortcuts share one dispatcher.
const keyboardActionButtons = {
  newChat: ['btnNewChat', '新对话'], search: ['btnSearch', '搜索历史对话'],
  toggleSidebar: ['btnToggleSidebar', '展开或收起侧边栏'], settings: ['btnSettings', '设置'],
  plugins: ['btnPlugins', '管理技能、Agent 和 MCP'], library: ['btnMyWorkChat', '资料库'], scheduler: ['btnSchedule', '定时任务'],
};
const keyboardWorkspaceActions = Object.freeze({
  newBrowser: 'browser', openFiles: 'files', newTerminal: 'terminal', openReview: 'review',
});
function syncKeyboardShortcutHints() {
  const { bindings } = keyboardShortcutStore.get();
  for (const [id, [buttonId, label]] of Object.entries(keyboardActionButtons)) {
    const button = $(buttonId);
    if (!button) continue;
    const chords = bindings[id] || [];
    button.title = label + (chords.length ? ' (' + chords.map(chord => window.RelayKeyboardShortcuts.formatChord(chord, keyboardIsMac).join('+')).join(' / ') + ')' : '');
    if (chords.length) button.setAttribute('aria-keyshortcuts', keyboardShortcutStore.getAriaShortcuts(id));
    else button.removeAttribute('aria-keyshortcuts');
  }
}
function keyboardElementVisible(element) {
  if (!element || element.closest('[hidden],[inert],[aria-hidden="true"]') || !element.getClientRects().length) return false;
  const style = getComputedStyle(element);
  // An opening dialog owns its keys even during its initial fade-in frame.
  return style.display !== 'none' && style.visibility !== 'hidden';
}
function keyboardActionAllowed(id) {
  // Dialogs retain their own keys; the search overlay can reuse its search action.
  return ![...document.querySelectorAll('[role="dialog"],[role="alertdialog"],.modal-backdrop,.search-overlay,.agent-picker-overlay,.preview-overlay,.confirm-overlay,.cv-viewer')].some(element => {
    if (!keyboardElementVisible(element)) return false;
    if (id === 'search' && element.classList.contains('search-overlay')) return false;
    return true;
  });
}
function invokeKeyboardAction(id) {
  if (Object.prototype.hasOwnProperty.call(keyboardWorkspaceActions, id)) {
    const workspace = window.relayWorkspacePanel;
    if (typeof workspace?.create !== 'function') return false;
    // Return to the current conversation without recreating it or discarding a settings draft.
    if (activeView !== 'chat' && !showAppView('chat')) return false;
    return workspace.create(keyboardWorkspaceActions[id]) !== false;
  } else if (id === 'search') {
    showSearchModal();
  } else if (id === 'newChat') startNewConv('plain');
  else if (id === 'settings') void openSettings();
  else if (id === 'shortcuts') void openSettings('shortcuts');
  else if (id === 'toggleSidebar') toggleAppSidebar();
  else if (id === 'focusComposer') {
    if (activeView !== 'chat' && activeView !== 'create') return false;
    (activeView === 'create' ? $('cvPrompt') : inputEl)?.focus();
  } else if (id === 'stopGeneration') {
    if (activeView !== 'chat' || !isRunning) return false;
    void abortCurrent();
  } else {
    const button = $(keyboardActionButtons[id]?.[0]);
    if (!button || button.disabled) return false;
    button.click();
  }
  return true;
}
window.addEventListener('keydown', event => {
  if (window.relayShortcutPage?.handleKeyDown(event)) return;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.target?.closest?.('[inert]')) return;
  const chord = window.RelayKeyboardShortcuts.chordFromEvent(event, keyboardIsMac);
  if (!chord) return;
  const { bindings } = keyboardShortcutStore.get();
  const id = Object.keys(bindings).find(action => bindings[action].includes(chord));
  // Keep shell editing keys in xterm, but let explicit workspace commands create or switch tools.
  if (event.target?.closest?.('.xterm') && !Object.prototype.hasOwnProperty.call(keyboardWorkspaceActions, id)) return;
  if (!id || !keyboardActionAllowed(id)) return;
  if (!invokeKeyboardAction(id)) return;
  event.preventDefault(); event.stopImmediatePropagation();
}, true);
window.addEventListener('relay:workspace-shortcut', event => {
  const id = event.detail?.action;
  if (Object.prototype.hasOwnProperty.call(keyboardWorkspaceActions, id) && keyboardActionAllowed(id)) invokeKeyboardAction(id);
});
window.addEventListener('relay:view-changed', () => window.relayShortcutPage?.cancelRecording());
window.addEventListener('storage', event => {
  if (event.key !== window.RelayKeyboardShortcuts.STORAGE_KEY || (event.storageArea && keyboardStorage && event.storageArea !== keyboardStorage)) return;
  try { keyboardShortcutStore.receive(JSON.parse(event.newValue || 'null')); } catch (_) {}
});
keyboardShortcutStore.subscribe(syncKeyboardShortcutHints);
window.addEventListener('relay:sidebar-changed', syncKeyboardShortcutHints);
syncKeyboardShortcutHints();

// Activity actions retain the conversation and turn that produced the row.
function activityActionOwner(event) {
  const element = event.target.closest('[data-conversation-id][data-job-id]');
  if (!element?.dataset.conversationId || !element.dataset.jobId) return null;
  return { convId: element.dataset.conversationId, jobId: element.dataset.jobId };
}
document.addEventListener('relay:task-stop', async event => {
  const owner = activityActionOwner(event); if (!owner) return;
  const run = runForJob(owner.jobId);
  if (!run || run.convId !== owner.convId) return;
  try {
    const result = await window.api.stopClaudeTask({ ...owner, taskId: event.detail.taskId });
    if (!result?.ok && !result?.stale) showToast(result?.message || '子任务停止请求未确认');
  } catch (error) { showToast(error?.message || '子任务停止请求未确认'); }
});
document.addEventListener('relay:task-background', async event => {
  const owner = activityActionOwner(event); if (!owner) return;
  const run = runForJob(owner.jobId);
  if (!run || run.convId !== owner.convId || !event.detail?.toolUseId) return;
  try {
    const result = await window.api.backgroundClaudeTask({ ...owner, toolUseId: event.detail.toolUseId });
    if (runForJob(owner.jobId) !== run) return;
    if (!result?.ok && !result?.stale) showToast(result?.message || '转后台请求未确认');
  } catch (error) {
    if (runForJob(owner.jobId) === run) showToast(error?.message || '转后台请求未确认');
  }
});
document.addEventListener('relay:task-resource', async event => {
  const owner = activityActionOwner(event); if (!owner) return;
  try {
    const result = await window.api.openClaudeTaskResource({ ...owner, taskId: event.detail.taskId, uri: event.detail.uri });
    if (!result?.ok) { showToast(result?.message || '无法打开任务资源'); return; }
    if (result.kind === 'url') await window.relayWorkspacePanel?.openUrl?.(result.url);
    else if (result.kind === 'resource') { await navigator.clipboard.writeText(result.uri); showToast('已复制资源地址'); }
  } catch (error) { showToast(error?.message || '无法打开任务资源'); }
});

// Native branches preserve the source conversation and share its working files.
async function createConversationFork(conversationId, runId, trigger, redo = false) {
  if (trigger?.disabled) return;
  if (trigger) trigger.disabled = true;
  const navigation = pageNavigationVersion;
  try {
    const result = await window.api.history.fork({ conversationId, runId, redo });
    if (!result?.ok) { showToast(result?.message || '无法创建分支'); return; }
    await refreshHistoryList();
    if (navigation === pageNavigationVersion) {
      await loadConversation(result.conversationId);
      if (result.prefill && currentConv?.id === result.conversationId && !inputEl.value.trim()) { inputEl.value = result.prefill; attachedFiles = Array.isArray(result.files) ? result.files : []; renderAttachments(); autoGrowInput(); captureComposerDraft(); inputEl.focus(); }
    }
    else showToast('分支已加入历史对话');
  } catch (error) { showToast(error?.message || '无法创建分支'); }
  finally { if (trigger) trigger.disabled = false; }
}
window.addEventListener('relay:native-history-updated', () => { void refreshHistoryList(); });

window.RelayLocalFileLinks?.install(messagesEl, {
  context: () => window.relayConversationWorkspace(),
  onError: message => showToast(message),
});
window.RelayLocalMarkdownImages?.install(messagesEl, {
  context: () => window.relayConversationWorkspace(),
});
