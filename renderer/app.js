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
      code(token) {
        // 兼容新旧签名:新版传 token 对象,老版传 (code, infostring)
        let code, lang;
        if (typeof token === 'object' && token) { code = token.text || ''; lang = (token.lang || '').trim(); }
        else { code = token || ''; lang = (arguments[1] || '').trim(); }
        lang = lang.split(/\s+/)[0].toLowerCase();   // ```js foo → 取 js
        // 常见别名归一(hljs 里 HTML 注册名是 xml)
        const ALIAS = { html: 'xml', htm: 'xml', vue: 'xml', js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', yml: 'yaml', 'c++': 'cpp', py: 'python' };
        if (ALIAS[lang]) lang = ALIAS[lang];
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
        return `<pre><code class="${cls}">${html}</code></pre>`;
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

const messagesEl = $('messages');
const conversationIndexEl = $('conversationIndex');
const conversationIndexKeysEl = $('conversationIndexKeys');
const inputEl    = $('input');
const sendBtn    = $('btnSend');
let isRunning = false;
const historyEl  = $('historyList');
const chatTitle  = $('chatTitle');
const inputCard    = $('inputCard');
const attachmentsEl= $('attachments');
const btnAttach    = $('btnAttach');
const btnModelSwitch = $('btnModelSwitch');
const msIco        = $('msIco');
const msLabel      = $('msLabel');
const btnSkillQuick = $('btnSkillQuick');
const skillQuickLabel = $('skillQuickLabel');
const skillQuickClear = $('skillQuickClear');
const composerSkillChip = $('composerSkillChip');
const composerSkillLabel = $('composerSkillLabel');

let attachedFiles = [];            // 待发送附件 [{ path, name, ext, size }]
let currentModel  = 'haiku';       // 模型档位:haiku=快速 / sonnet=思考 / opus=专家
let defaultModel  = 'haiku';       // 用户在设置里选的「默认使用」档;「新对话」回到它(不带历史会话的档位)
let selectedQuickSkill = null;      // 输入区快捷选择的技能；仅作用于下一条消息
let skillQuickPopup = null;
let quickSkillItems = [];
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
let currentOrchestrateAgents = null;  // orchestrate 模式下用户勾选的子智能体 name 数组(空=全量交 PM)
let currentWorkingDir = null;      // 当前【所看】对话的工作目录({path,name} 或 null);LLM 文件读写落点,随会话保存

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
function runForJob(jobId) {
  const convId = jobToConv.get(jobId);
  return convId ? runs.get(convId) : null;
}
// 某个会话是否正在跑
function isConvRunning(convId) { return !!(convId && (runs.has(convId) || (typeof cvJobs !== 'undefined' && cvJobs.has(convId)))); }
// 事件所属会话是否正是当前所看的会话(决定要不要动 DOM)
function isViewingJob(jobId) {
  const convId = jobToConv.get(jobId);
  return !!(convId && currentConv && currentConv.id === convId);
}

// ── 对话快捷索引（竖向钢琴键） ──
// 锚点按 turn 单独存在，不依赖普通气泡、结构化活动流或协奏群聊的具体 DOM。
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
      stickToBottom = false;
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
  new ResizeObserver(scheduleConversationIndexUpdate).observe(messagesEl);
}
window.addEventListener('resize', scheduleConversationIndexUpdate);
if (conversationIndexEl) {
  conversationIndexEl.addEventListener('pointermove', (event) => {
    scheduleConversationIndexWave(event.clientY);
  });
  conversationIndexEl.addEventListener('pointerleave', resetConversationIndexWave);
}

// ── Claude Code 结构化过程流 ──
// 普通/Agent 对话使用；协奏模式继续走自己的群聊轨道。
function newActivityState(saved = null) {
  return window.RelayActivity ? window.RelayActivity.createState(saved || undefined) : null;
}
function appendActivityState(state, collapsed = false) {
  if (!state || !window.RelayActivity) return null;
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();
  const el = window.RelayActivity.createElement(state, { collapsed, collapseOnComplete: true });
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}
function activityStateForTurn(turn) {
  if (!window.RelayActivity || !turn) return null;
  if (turn.activity && Array.isArray(turn.activity.items)) return window.RelayActivity.hydrate(turn.activity);
  if (turn.thinking) return window.RelayActivity.fromLegacy(turn.thinking);
  return null;
}
function activityEventNeedsRender(evt) {
  if (!evt || evt.type !== 'stream_event') return true;
  const raw = evt.event || {};
  if (raw.type === 'content_block_start' || raw.type === 'content_block_stop' || raw.type === 'error') return true;
  const deltaType = raw.delta && raw.delta.type;
  return deltaType === 'thinking_delta' || deltaType === 'input_json_delta';
}
function updateRunActivity(run, onView, force = false) {
  if (!run || !run.activityState || !window.RelayActivity || !onView) return;
  if (!run.activityEl || !run.activityEl.isConnected) {
    run.activityEl = appendActivityState(run.activityState, false);
  } else if (force) {
    window.RelayActivity.updateElement(run.activityEl, run.activityState, { collapseOnComplete: true });
    // 活动流和最终回答共用同一套“贴底跟随”语义：用户仍在底部时，
    // 每次活动节点增高后立即把最新内容带入视口；用户主动上滑后则不打断阅读。
    scrollToBottom();
  }
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
      targetConvId, currentMode, currentModel,
      currentWorkingDir && currentWorkingDir.path ? currentWorkingDir.path : null,
    );
    if (!r || !r.ok) {
      showToast((r && r.message) || '重新加载失败');
      return false;
    }
    // MCP 工具清单在 Claude Code session 创建时固定。这里不再 --resume 旧 session，
    // 而是让下一条消息把 Relay 保存的历史作为文本上下文带入全新 session。
    targetConv.sessionId = null;
    targetConv.carryContextOnNextTurn = true;
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

async function initTheme() {
  try {
    const s = await window.api.settings.read();
    _themeSetting = (s?.app?.theme) || 'light';
    setConversationIndexEnabled(s?.app?.conversationIndex !== false);
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
(async () => {
  // 主题:尽早应用,避免白/黑屏闪烁
  initTheme();
  // 首屏关键路径:尽快把历史列表和输入区画出来。
  //   probeEnv 会在主进程 spawn 一个 `claude --version` 子进程(数百 ms),只给设置页用,
  //   绝不能挡首屏 —— 移到后台异步跑,结果回填 envCache,设置页打开时自然读到。
  window.api.probeEnv().then((r) => { envCache = r; }).catch(() => {});
  // ⚡ settings / brand / history 三个 IPC 互不依赖 —— 并行发起,别串行等(原来三次串行往返)。
  applyBrand();       // 内部自取 brand.get() 并刷新侧边栏 logo/名称
  applyWorkdirUI();   // 工作目录按钮初始态(纯本地,无 IPC)
  refreshHistoryList();   // 历史列表(不 await,回来即渲染)
  // 模型档位默认值取设置里的「默认使用」(只影响切换器初始态,不挡首屏其它部分)
  try {
    const s = await window.api.settings.read();
    if (s?.claude?.defaultModel) { defaultModel = s.claude.defaultModel; currentModel = defaultModel; }
  } catch {}
  updateModelSwitchUI();
  updateComposerForMode();
  // 应用自更新:订阅状态推送,好让「发现新版」的气泡能自己冒出来 ——
  //   不能等用户打开设置页才订阅。内部有幂等守卫,bindRelayUpdate 再调一次无害。
  initRelayUpdate();
})();

// ── 工作目录(对话级)──
// 把当前 currentWorkingDir 反映到输入区按钮上(显示目录名)。
//   想换目录直接点按钮重选;想用默认目录就新建对话 —— 故不提供清除。
function applyWorkdirUI() {
  const label = $('wdLabel');
  const btn = $('btnWorkdir');
  if (!label || !btn) return;
  if (currentWorkingDir && currentWorkingDir.path) {
    label.textContent = currentWorkingDir.name || currentWorkingDir.path;
    btn.title = `工作目录：${currentWorkingDir.path}（LLM 在此读写，点击可更换）`;
  } else {
    label.textContent = '工作目录';
    btn.title = '设置工作目录';
  }
}

// 选择工作目录:写入当前对话(若已存在则落盘),并刷新 UI。
async function pickWorkingDir() {
  const dir = await window.api.openFolderDialog();
  if (!dir) return;   // 取消
  currentWorkingDir = dir;
  if (currentConv) {
    currentConv.workingDir = dir;
    if (currentConv.id) { try { await window.api.history.save(currentConv); } catch (_) {} }
  }
  applyWorkdirUI();
}

// ── 本地技能快捷调用（一次性） ──
// 列表直接复用设置页的数据源，只读取技能名与 frontmatter 描述，不触发用量扫描。
const QUICK_SKILL_ICON = `
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="m12 3 8 4.5-8 4.5-8-4.5z"></path>
    <path d="m4 12 8 4.5 8-4.5"></path>
    <path d="m4 16.5 8 4.5 8-4.5"></path>
  </svg>`;

function setSelectedQuickSkill(skill) {
  selectedQuickSkill = skill && skill.name
    ? {
        name: String(skill.name),
        callName: String(skill.callName || skill.name),
        displayName: String(skill.displayName || skill.name),
        desc: String(skill.desc || ''),
        summary: String(skill.summary || skill.desc || ''),
        defaultPrompt: String(skill.defaultPrompt || ''),
      }
    : null;
  if (!btnSkillQuick || !skillQuickLabel || !skillQuickClear ||
      !composerSkillChip || !composerSkillLabel) return;
  const selected = !!selectedQuickSkill;
  skillQuickLabel.textContent = '技能';
  composerSkillChip.classList.toggle('hidden', !selected);
  composerSkillLabel.textContent = selected ? selectedQuickSkill.displayName : '';
  composerSkillChip.title = selected
    ? `${selectedQuickSkill.displayName}（调用 ID：${selectedQuickSkill.callName}）`
    : '';
  btnSkillQuick.title = selected
    ? `更换技能（当前：${selectedQuickSkill.name}）`
    : '选择本地技能';
}

function ensureSkillQuickPopup() {
  if (skillQuickPopup) return skillQuickPopup;
  skillQuickPopup = document.createElement('div');
  skillQuickPopup.className = 'skill-quick-popup';
  skillQuickPopup.innerHTML = `
    <div class="skill-quick-search-wrap">
      <svg class="skill-quick-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>
      </svg>
      <input class="skill-quick-search" type="text" placeholder="搜索本地技能" autocomplete="off" spellcheck="false">
    </div>
    <div class="skill-quick-list"><div class="skill-quick-empty">正在读取技能…</div></div>
  `;
  document.body.appendChild(skillQuickPopup);
  const search = skillQuickPopup.querySelector('.skill-quick-search');
  const list = skillQuickPopup.querySelector('.skill-quick-list');
  bindTransientScrollbar(list);
  search.addEventListener('input', () => renderSkillQuickItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideSkillQuickPopup();
      btnSkillQuick && btnSkillQuick.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('.skill-quick-row')?.focus();
    }
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.skill-quick-row');
    if (!row || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const rows = Array.from(list.querySelectorAll('.skill-quick-row'));
    const index = rows.indexOf(row);
    const next = e.key === 'ArrowDown' ? rows[index + 1] : rows[index - 1];
    (next || search).focus();
  });
  return skillQuickPopup;
}

function renderSkillQuickItems(query = '') {
  const pop = ensureSkillQuickPopup();
  const list = pop.querySelector('.skill-quick-list');
  const keyword = String(query || '').trim().toLowerCase();
  const items = quickSkillItems.filter((item) => {
    if (!keyword) return true;
    return `${item.name || ''} ${item.callName || ''} ${item.displayName || ''} ${item.summary || ''} ${item.desc || ''}`
      .toLowerCase()
      .includes(keyword);
  });
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'skill-quick-empty';
    empty.textContent = quickSkillItems.length ? '没有匹配的技能' : '本地还没有可用技能';
    list.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const selected = !!(selectedQuickSkill && selectedQuickSkill.name === item.name);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `skill-quick-row${selected ? ' selected' : ''}`;
    row.title = `调用 ID：${item.callName || item.name}`;
    row.innerHTML = `
      <span class="skill-quick-row-icon">${QUICK_SKILL_ICON}</span>
      <span class="skill-quick-row-main">
        <span class="skill-quick-row-name">${escapeHtml(item.displayName || item.name)}</span>
        <span class="skill-quick-row-desc">${escapeHtml(item.summary || item.desc || '本地技能')}</span>
      </span>
      <svg class="skill-quick-row-check" width="17" height="17" viewBox="0 0 17 17" fill="none">
        <path d="M3.5 8.7 7 12l6.5-7" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextSkill = selected ? null : item;
      setSelectedQuickSkill(nextSkill);
      // 兼容 Codex 的 agents/openai.yaml：仅在输入框为空时带入作者提供的调用模板，
      // 不覆盖用户已经输入的内容。
      if (nextSkill && nextSkill.defaultPrompt && !inputEl.value.trim()) {
        inputEl.value = nextSkill.defaultPrompt;
        autoGrowInput();
      }
      hideSkillQuickPopup();
      inputEl.focus();
    });
    list.appendChild(row);
  });
}

function positionSkillQuickPopup() {
  if (!skillQuickPopup || !inputCard) return;
  const cardRect = inputCard.getBoundingClientRect();
  const width = Math.max(360, Math.min(620, cardRect.width - 24));
  const centeredLeft = cardRect.left + (cardRect.width - width) / 2;
  const left = Math.min(
    Math.max(16, centeredLeft),
    Math.max(16, window.innerWidth - width - 16),
  );
  skillQuickPopup.style.width = `${width}px`;
  skillQuickPopup.style.left = `${left}px`;
  skillQuickPopup.style.bottom = `${window.innerHeight - cardRect.top + 8}px`;
}

async function showSkillQuickPopup() {
  const pop = ensureSkillQuickPopup();
  hideModelPopup();
  positionSkillQuickPopup();
  pop.classList.add('show');
  btnSkillQuick && btnSkillQuick.classList.add('open');
  const search = pop.querySelector('.skill-quick-search');
  search.value = '';
  pop.querySelector('.skill-quick-list').innerHTML = '<div class="skill-quick-empty">正在读取技能…</div>';
  try {
    const result = await window.api.data.listSkills();
    quickSkillItems = result && result.ok && Array.isArray(result.items)
      ? result.items.slice().sort((a, b) => String(a.displayName || a.name || '')
          .localeCompare(String(b.displayName || b.name || ''), 'zh-CN'))
      : [];
  } catch (_) {
    quickSkillItems = [];
  }
  if (!pop.classList.contains('show')) return;
  renderSkillQuickItems('');
  requestAnimationFrame(() => search.focus());

  // 兼容旧版本已安装的技能：选择器立即显示现有信息，缺少 relay.yaml 的部分在后台补齐。
  // 每个 renderer 生命周期只主动触发一次；主进程还会对设置页的并发请求做合并。
  if (!quickSkillMetadataBackfillStarted) {
    quickSkillMetadataBackfillStarted = true;
    window.api.skills.backfillMetadata().then(async (metaResult) => {
      if (!metaResult || !metaResult.ok || !metaResult.total) return;
      const fresh = await window.api.data.listSkills();
      quickSkillItems = fresh && fresh.ok && Array.isArray(fresh.items)
        ? fresh.items.slice().sort((a, b) => String(a.displayName || a.name || '')
            .localeCompare(String(b.displayName || b.name || ''), 'zh-CN'))
        : quickSkillItems;
      if (skillQuickPopup && skillQuickPopup.classList.contains('show')) {
        renderSkillQuickItems(skillQuickPopup.querySelector('.skill-quick-search')?.value || '');
      }
    }).catch((error) => {
      quickSkillMetadataBackfillStarted = false;
      console.warn('[skills] 快捷选择器历史元数据补齐失败', error);
    });
  }
}

function hideSkillQuickPopup() {
  if (skillQuickPopup) skillQuickPopup.classList.remove('show');
  if (btnSkillQuick) btnSkillQuick.classList.remove('open');
}

// 应用侧边栏品牌(logo + 名称)。无自定义时:名称回落 "Relay",logo 回落内置 logo.png。
const DEFAULT_BRAND_NAME = 'Relay';
async function applyBrand() {
  let b = null;
  try { b = await window.api.brand.get(); } catch {}
  const nameEl = $('brandName');
  const logoEl = $('brandLogo');
  if (nameEl) {
    const name = (b && b.name) ? b.name : DEFAULT_BRAND_NAME;
    nameEl.textContent = name;
    nameEl.title = name;        // 悬停看完整名字
  }
  if (logoEl) logoEl.src = (b && b.logo) ? b.logo : 'logo.png';
}

// ─────────────────────────────────────────
// 历史侧边栏
// ─────────────────────────────────────────
// 四类会话的专属图标(模块级,侧边栏历史 + 搜索结果共用,保证一致):
//   定时任务=时钟(同右上角)/ 创作=图片 / Agent=机器人(同左上角)/ 普通=气泡。
const ICON_HIST_SCHED = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_HIST_IMAGE = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.3"/><path d="M20 15l-4-4-6 6"/></svg>';
const ICON_HIST_AGENT = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="3"></rect><line x1="12" y1="4.5" x2="12" y2="8"></line><circle cx="12" cy="3.5" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="9.5" cy="13" r="1.1" fill="currentColor" stroke="none"></circle><circle cx="14.5" cy="13" r="1.1" fill="currentColor" stroke="none"></circle><line x1="4" y1="12" x2="4" y2="15"></line><line x1="20" y1="12" x2="20" y2="15"></line></svg>';
const ICON_HIST_CHAT = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
const ICON_HIST_TEAM = '<svg class="hi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="9" r="2.6"></circle><circle cx="16" cy="8" r="2.2"></circle><path d="M3.5 18c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2"></path><path d="M14.5 14c2.4-.2 6 1 6 4"></path></svg>';
// 按会话(带 kind/mode/fromScheduled)选图标
function histIconSvg(it) {
  if (it.fromScheduled) return ICON_HIST_SCHED;
  if (it.kind === 'create') return ICON_HIST_IMAGE;
  if (it.mode === 'orchestrate') return ICON_HIST_TEAM;
  if (it.mode === 'agent') return ICON_HIST_AGENT;
  return ICON_HIST_CHAT;
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
      await window.api.history.setPinned(id, !nowPinned);
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
        maxLength: 26,
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
      const finalTitle = r.title || t;   // 主进程按 26 视觉宽收口后的实际标题,以它回显
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
  li.innerHTML = `${histIconSvg(it)}<div class="hi-title"></div><button class="hi-rename" title="重命名"></button><button class="hi-pin" title=""></button><span class="hi-tail"></span>`;
  updateHistoryRow(li, it);
  return li;
}

// 把一行的可变部分按 it 当前状态对齐(复用已有 DOM,只改变化处)。
function updateHistoryRow(li, it) {
  const activeId = activeView === 'create'
    ? (currentCreateConv && currentCreateConv.id)
    : (currentConv && currentConv.id);
  const isActive = !!(activeId && activeId === it.id);
  const running = isConvRunning(it.id);
  li.classList.toggle('active', isActive);
  li.classList.toggle('running', running);
  li.classList.toggle('pinned', !!it.pinned);
  if (li.dataset.kind !== (it.kind || 'chat')) li.dataset.kind = it.kind || 'chat';

  const titleEl = li.querySelector('.hi-title');
  const title = it.title || '未命名';
  if (titleEl.textContent !== title) titleEl.textContent = title;

  const pin = li.querySelector('.hi-pin');
  pin.classList.toggle('on', !!it.pinned);
  const pinTitle = it.pinned ? '取消置顶' : '置顶';
  if (pin.title !== pinTitle) pin.title = pinTitle;
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
  const items = await window.api.history.list();
  ensureHistoryDelegation();
  if (items.length === 0) {
    historyEl.innerHTML = '<div class="history-empty">还没有记录</div>';
    return;
  }
  // 清掉可能存在的空态占位
  const emptyEl = historyEl.querySelector('.history-empty');
  if (emptyEl) emptyEl.remove();

  // 增量对齐:按 id 复用已有行,缺则建、变则改;最后按新顺序重排、删掉多余行。
  const existing = new Map();
  for (const li of historyEl.querySelectorAll('.history-item')) existing.set(li.dataset.id, li);

  const seen = new Set();
  let prev = null;   // 上一个已就位的行,用于按序插入
  for (const it of items) {
    seen.add(it.id);
    let li = existing.get(it.id);
    if (li) updateHistoryRow(li, it);
    else { li = buildHistoryRow(it); existing.set(it.id, li); }
    // 把 li 放到 prev 之后的正确位置(已在位则不动 DOM)
    const anchor = prev ? prev.nextSibling : historyEl.firstChild;
    if (li !== anchor) historyEl.insertBefore(li, anchor);
    prev = li;
  }
  // 删除本次不再出现的旧行
  for (const [id, li] of existing) {
    if (!seen.has(id)) li.remove();
  }
}

// jumpTo(可选):{ turnIndex, side } —— 从搜索结果跳转时,打开会话后滚动到命中的那条消息并高亮。
async function loadConversation(id, jumpTo = null) {
  const conv = await window.api.history.load(id);
  if (!conv) return;
  showChatView();   // 从「AI 创作」视图点历史会话时,切回聊天视图
  currentConv = conv;
  currentSessionId = conv.sessionId || null;
  currentMode = conv.mode || 'plain';  // 历史会话恢复时也要恢复 mode
  currentAgent = conv.agent || null;   // 恢复该会话选中的子智能体真实 id
  currentAgentLabel = conv.agentLabel || conv.agent || null;  // 恢复显示名
  currentOrchestrateAgents = conv.orchestrateAgents || null;  // 恢复协同选队
  currentWorkingDir = conv.workingDir || null;  // 恢复该会话的工作目录
  setSelectedQuickSkill(null);  // 技能选择是输入草稿态，不跨会话继承
  hideSkillQuickPopup();
  // 历史协奏必须先拿到 PM 的自定义名称/头像再重建群聊。
  // 新建协奏时原本是 fire-and-forget 预取；应用刚启动就直接点历史时缓存仍为空，
  // appendChatBubble 会退回默认 “PM” 徽章，造成“自定义信息丢失”的假象。
  if (currentMode === 'orchestrate' && !pmBrandCache) await ensureOrchLabels();
  applyWorkdirUI();
  if (conv.model) { currentModel = conv.model; updateModelSwitchUI(); }  // 恢复该会话的模型档位
  updateComposerForMode();  // 按会话模式显示/隐藏模型切换器
  detachStreamRenderTarget();
  pendingPmBubble = null;   // DOM 即将清空,作废上次的待出 PM 气泡引用
  messagesEl.innerHTML = '';
  clearConversationIndex();
  chatTitle.textContent = conv.title || '历史会话';

  // 预启动这个对话的常驻 claude 进程:用户读历史/打字的这几秒,正好用来连 MCP,
  //   等他真发消息时工具已经全就位(不预启动的话首轮模型会看到一个没有 MCP 工具的世界)。
  //   fire-and-forget:失败无害,发送时主进程会自己 spawn。
  try {
    window.api.prespawnClaude(id, currentSessionId, currentMode, currentModel, currentAgent,
      currentWorkingDir && currentWorkingDir.path ? currentWorkingDir.path : null);
  } catch (_) {}

  // 这个会话是否正在后台跑?(有 run 即在跑)
  const run = runs.get(id);
  const turns = conv.turns || [];
  const lastIdx = turns.length - 1;

  // ── 渲染所有已存 turns ──
  //   若该会话正在跑,最后一个 turn 的 saved 内容是空占位,改用 run.turn 的内存内容渲染。
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLiveTurn = (i === lastIdx) && !!run;
    appendConversationTurnAnchor(i);

    // 每条消息打 data-turn=i 标记,供搜索跳转按 turn 索引 + 角色定位到具体消息
    if (turn.user || (turn.files && turn.files.length)) {
      const el = appendMessage('user', turn.user, turn.files, { ts: turn.ts });
      if (el) el.dataset.turn = i;
    }

    // 普通/Agent 会话按结构化 activity 重建；旧记录没有 activity 时在渲染期兼容 thinking。
    if (!isLiveTurn && conv.mode !== 'orchestrate') {
      const activityState = activityStateForTurn(turn);
      if (activityState && activityState.items.length) {
        const activityEl = appendActivityState(activityState, true);
        if (activityEl) activityEl.dataset.turn = i;
      }
    }

    // 协同会话:有结构化群聊日志就按群聊重建(保住头像/分轨/状态),不退化成单气泡
    if (turn.chat && turn.chat.length && !isLiveTurn) {
      renderChatLog(turn.chat);
    } else if (turn.assistant && !isLiveTurn) {
      currentAssistantBubble = null;
      appendOrUpdateAssistant(turn.assistant, false, { ts: turn.assistantTs });
      // appendOrUpdateAssistant 不返回元素;此处它刚新建的气泡就是 currentAssistantBubble
      if (currentAssistantBubble) currentAssistantBubble.dataset.turn = i;
      currentAssistantBubble = null;
    }
  }

  // ── 正在跑:把该 run 后台累积的 thinking/工具/文本补渲染出来,并接回流式气泡 ──
  if (run) {
    currentSessionId = run.sessionId || currentSessionId;
    // 正在跑的普通/Agent 会话直接接回同一份 activity 状态，不重新推断卡片位置。
    if (run.mode !== 'orchestrate' && run.activityState) {
      run.activityEl = appendActivityState(run.activityState, false);
    }
    if (run.mode === 'orchestrate' && run.orch) {
      // 协同正在跑:按结构化日志重建群聊;DOM 已清空,故 tracks/pmBubble 的旧 DOM 引用作废,
      //   重置它们 —— 后续事件会重新建气泡(结构记录 run.turn.chat 不丢,继续往里追加)。
      run.orch.tracks = new Map();
      renderChatLog(run.turn.chat || [], run.orch);
      run.orch.pmBubble = null;
      run.orch.pmEntry = null;
      if (!(run.turn.chat && run.turn.chat.length)) showThinking();
    } else if (run.turn.assistant) {
      // 接回流式气泡:后续该会话的 stream_event delta 会继续往这个气泡追加
      currentAssistantBubble = appendMessage('assistant', run.turn.assistant);
      currentAssistantBubble.dataset.raw = run.turn.assistant;
      streamRenderBubble = currentAssistantBubble;
    } else if (run.mode === 'orchestrate') {
      showThinking();   // 协奏模式仍使用群聊的待输出动画
    }
  } else {
    removeThinking();
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
      // 渲染/布局可能未稳,等一帧再滚,定位更准
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('search-hit');
        setTimeout(() => target.classList.remove('search-hit'), 2000);
      });
    }
  } else {
    stickToBottom = true;
    requestAnimationFrame(() => scrollToBottom(true));
  }

  syncRunningUI();             // 发送按钮反映这个会话是否在跑
  await refreshHistoryList();  // 刷新 active 高亮
}

function startNewConv(mode = 'plain', agentName = null, agentLabel = null, orchestrateAgents = null) {
  // 注意:不动 runs —— 让正在跑的其它会话继续在后台收数据,完成后各自写回自己的 conv。
  showChatView();   // 若当前在「AI 创作」视图,切回聊天视图
  currentMode = mode;
  currentAgent = (mode === 'agent') ? agentName : null;
  currentAgentLabel = (mode === 'agent') ? (agentLabel || agentName) : null;
  currentOrchestrateAgents = (mode === 'orchestrate') ? (orchestrateAgents || null) : null;
  currentModel = defaultModel;   // 新对话回到用户设置的默认档(不沿用刚看的历史会话的档位)
  updateComposerForMode();  // plain 显示模型切换器 / agent 隐藏(锁定模型)
  updateModelSwitchUI();    // 让切换器 UI 同步回默认档
  currentConv = null;
  currentSessionId = null;
  detachStreamRenderTarget();
  pendingPmBubble = null;     // 清掉上个会话残留的待出 PM 气泡引用
  currentWorkingDir = null;   // 新对话默认无工作目录
  setSelectedQuickSkill(null);
  hideSkillQuickPopup();
  applyWorkdirUI();
  messagesEl.innerHTML = '';
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
    ensureOrchLabels();   // 预取 name→displayName,供群聊头像/名字用
    chatTitle.textContent = '协奏';
    const n = (currentOrchestrateAgents && currentOrchestrateAgents.length) || 0;
    const scope = n ? `已选 ${n} 个 Agent 入队` : '由 PM 全权调度所有已装 Agent';
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>🎼 协奏</h2>
        <p>${scope}。描述你的任务，由 PM 拆解后派给各 Agent 接力完成。</p>
      </div>
    `;
  } else {
    chatTitle.textContent = '新对话';
    messagesEl.innerHTML = `
      <div class="welcome">
        <h2>💬 新对话</h2>
        <p>有什么可以帮你的，直接开始对话吧。<br/>需要调用某个 Agent 时，点左侧「Agent」选择已安装的 Agent。</p>
      </div>
    `;
  }
  refreshHistoryList();
}

// 某个 run 的后端进程结束 → 把累积的 turn 写回它归属的 conv,清理 run,刷新 UI。
//   注意:此时用户可能正看着别的会话,所以一切都按 run.convId 操作,不依赖 currentConv。
async function finishRun(jobId, doneEvt) {
  const run = runForJob(jobId);
  if (!run) return;
  const convId = run.convId;
  const wasViewing = currentConv && currentConv.id === convId;

  // 流式结束:立即渲染最终内容,并补上代码块的「运行/复制/折叠」按钮(流式中故意不挂,避免闪烁)
  //   双保险:渲染只是锦上添花,即便抛异常也绝不能阻断下面的收尾(关转圈/写回 turn)。
  if (wasViewing) {
    try { flushStreamRender(); }
    catch (e) { console.error('finishRun: flushStreamRender 收尾渲染失败,已忽略并继续收尾', e); }
  }

  // 会话失效(--resume 撞 "No conversation found")是可以自动恢复的——下面会无声重跑一次。
  //   这种情况不向用户抛刺眼的红色报错,只在重跑分支给一条温和的灰色提示。
  //   仅当本轮带着 sessionId、还没自动救过时才算"可自愈";否则按真实失败正常报错。
  const sessionGone = /No conversation found with session ID/i.test(run.stderrBuf || '');
  const willAutoRecover = sessionGone && run.sessionId && !run.autoRetried;

  // spawn 失败/异常退出且没产出任何文字 → 给个错误提示(可自愈的会话失效除外)
  const exitCode = doneEvt && typeof doneEvt.exitCode === 'number' ? doneEvt.exitCode : 0;
  if (!run.error && exitCode !== 0 && !run.turn.assistant) {
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
      if (wasViewing) { removeThinking(); appendMessage('error', `🖼️ ${run.error}`); }
    } else {
      // 把进程的 stderr(若有)并入错误信息 —— 退出码 1 的真正原因几乎都在这里,
      //   过去因 onView 限制被丢弃,只剩光秃秃的「退出码 1」难以排查。
      run.error = doneEvt && doneEvt.error
        ? `运行失败:${doneEvt.error}`
        : `运行异常结束（错误码 ${exitCode}）`;
      if (detail) run.error += `\n\n${detail}`;
      // 可自愈的会话失效:不弹红色报错,把噪音留给下面的灰色"正在重新开始"提示。
      if (wasViewing && !willAutoRecover) { removeThinking(); appendMessage('error', `❌ ${run.error}`); }
    }
  }
  // 本轮是否失败:有 error,或非零退出且没产出任何回复。
  //   失败轮不能写回 sessionId(CLI 可能创建了一个又随即报错退出的"幽灵 session",
  //   存了它下一轮 --resume 会撞 "No conversation found with session ID")。
  //   也不该拿失败的报错文本去生成标题。
  const failed = !!run.error || (exitCode !== 0 && !run.turn.assistant);

  // result 正常到达时归并器已完成；异常退出/中止 result 缺失时由 job-done 补齐最终状态。
  if (run.activityState && window.RelayActivity) {
    window.RelayActivity.finish(run.activityState, failed ? (run.error || `运行异常结束（错误码 ${exitCode}）`) : null);
    updateRunActivity(run, wasViewing, true);
  }

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
    if (wasViewing) {
      removeThinking();
      appendMessage('system', '会话已失效，正在自动重新开始（已带上前面的对话继续）…');
    }
    await relaunchWithoutResume(conv, failedUser, failedFiles, failedSkill);
    return;
  }

  if (conv) {
    // 更新最后一个 turn(send 时已塞过空 assistant 占位)
    const assistantTs = run.turn.assistant ? new Date().toISOString() : null;
    run.turn.assistantTs = assistantTs;
    const last = conv.turns[conv.turns.length - 1];
    if (last) {
      last.assistant = run.turn.assistant;
      if (assistantTs) last.assistantTs = assistantTs;
      last.thinking  = run.turn.thinkingList.join('\n\n--- 下一段思考 ---\n\n') || null;
      if (run.activityState && window.RelayActivity) {
        last.activity = window.RelayActivity.serialize(run.activityState);
      }
      // 协同会话:存结构化群聊日志,历史重开时据此重建群聊(不退化为单气泡)
      if (run.turn.chat && run.turn.chat.length) last.chat = run.turn.chat;
    }
    // 仅成功轮写回 sessionId;失败轮保持原 sessionId(可能为空 → 下一轮当新对话重开,不会撞幽灵 session)
    if (!failed && run.sessionId) conv.sessionId = run.sessionId;
    const saved = await window.api.history.save(conv);
    conv.updatedAt = saved.updatedAt;
    if (wasViewing && assistantTs && currentAssistantBubble && currentAssistantBubble.isConnected) {
      appendMessageTime(currentAssistantBubble, assistantTs);
    }
  }

  // 清理 run
  runs.delete(convId);
  jobToConv.delete(jobId);

  // 当前所看会话的运行态:若结束的正是它,关闭 running UI
  if (wasViewing) {
    if (!failed && run.sessionId) currentSessionId = run.sessionId;  // 失败轮不更新,避免下一轮 resume 幽灵 session
    removeThinking();
    setRunning(false);
  }
  await refreshHistoryList();

  // 仅当首轮【成功】时才用快模型生成标题(否则会把"Not logged in"之类报错当成标题)
  if (!failed && conv && (conv.turns || []).length === 1) maybeGenerateTitle(conv);

  // Curator 二期:每 N 轮后台自动提炼技能(fire-and-forget,不阻塞 UI)。
  //   排除:失败轮 / 创作会话 / 定时任务产出的会话。节奏与开关由 main 侧配置,这里按轮数触发。
  if (!failed && conv && conv.kind !== 'create' && !conv.fromScheduled) maybeAutoReviewSkills(conv);
}

// 满足节奏就触发一次技能 review。配置(开关/每 N 轮)从 main 拉;只在轮数命中 N 的整数倍时跑。
async function maybeAutoReviewSkills(conv) {
  try {
    const cfg = await window.api.skills.getReviewConfig();
    if (!cfg || !cfg.ok || !cfg.enabled) return;
    const n = cfg.everyTurns || 6;
    const turnCount = (conv.turns || []).length;
    if (turnCount < 1 || turnCount % n !== 0) return;   // 每 N 轮一次
    // 拼成纯对话文本喂给 review(我:/你: 格式;不带"继续回答"那种延续框架,review 只是回看)
    const blocks = [];
    for (const t of (conv.turns || [])) {
      if (!t) continue;
      const u = (t.user || '').trim();
      const a = (t.assistant || '').trim();
      let b = '';
      if (u) b += `我：${u}\n`;
      if (a) b += `你：${a}`;
      if (b.trim()) blocks.push(b.trim());
    }
    if (!blocks.length) return;
    let text = blocks.join('\n\n');
    const MAX = 12000;   // 控体量,过长保留最近部分
    if (text.length > MAX) text = '（较早的对话已省略）\n\n' + text.slice(text.length - MAX);
    const workingDir = (conv.workingDir && conv.workingDir.path) ? conv.workingDir.path : null;
    window.api.skills.autoReview(text, workingDir);   // 不 await:后台跑
  } catch (_) { /* review 失败不影响主流程 */ }
}

// 方案 B 的降级重跑:把指定会话以「新线程(不 --resume)+ 文字前文」重发一轮。
//   只被 finishRun 的兜底分支调用;复用 conv 自身记录的 模型档位/工作目录/agent。
async function relaunchWithoutResume(conv, userText, files, skill = null) {
  if (!conv) return;
  const filesToSend = Array.isArray(files) ? files : [];
  // 前文 = 已有历史(此时失败 turn 已被弹掉),拼成文字上下文带进新线程
  const ctx = buildContextPreamble(conv.turns);
  let promptToSend = userText || '';
  if (ctx) promptToSend = `${ctx}\n\n${userText || ''}`.trim();
  if (skill && skill.name) {
    const invokeSkill = `请先调用 Skill 工具加载「${skill.callName || skill.name}」技能，并严格按照该技能处理下面的请求。`;
    promptToSend = `${invokeSkill}\n\n${promptToSend}`.trim();
  }

  // 重新压入这条 turn 的占位(与 send 一致,供 finishRun 回填)
  const turn = {
    user: userText, assistant: '', thinkingList: [], files: filesToSend, skill,
    ts: new Date().toISOString(), activityState: newActivityState(), activityEl: null,
  };
  conv.turns.push({ user: userText, assistant: '', thinking: null, files: filesToSend, skill, ts: turn.ts });
  const saved = await window.api.history.save(conv);
  conv.updatedAt = saved.updatedAt;

  const convId = conv.id;
  const sessionModel = conv.sessionModel || conv.model || null;
  const modelToSend = sessionModel;
  const agentName = conv.agent || null;
  const orchAgents = conv.orchestrateAgents || null;
  const workingDirPath = (conv.workingDir && conv.workingDir.path) ? conv.workingDir.path : null;
  const mode = conv.mode || 'plain';

  if (currentConv && currentConv.id === convId) {
    setRunning(true);
    if (mode === 'orchestrate') showThinking();
    else turn.activityEl = appendActivityState(turn.activityState, false);
  }
  await refreshHistoryList();

  // 走到这条路 = 该对话的 session 已经接不回了。先把主进程里这个对话的常驻进程和它记住的
  //   session_id 一并丢掉,否则下一轮正常发送会拿着同一个坏 id 再 --resume 一次,又坏回去。
  try { await window.api.dropClaudeSession(convId); } catch (_) {}

  // 关键:sessionId 传 null —— 当全新会话开,不再撞 "No conversation found"。
  //   convId 也传 null:这条路正是因为常驻/续接出了问题才走到的,必须彻底另起炉灶,
  //   不能复用该对话的常驻进程(它挂着的正是那个坏掉的 session)。
  const result = await window.api.runClaude(promptToSend, null, mode, filesToSend, modelToSend, agentName, workingDirPath, orchAgents, null);
  if (!result || result.error) {
    if (turn.activityState && window.RelayActivity) {
      window.RelayActivity.finish(turn.activityState, (result && result.error) || '自动重试启动失败');
      const failedTurn = conv.turns && conv.turns[conv.turns.length - 1];
      if (failedTurn) failedTurn.activity = window.RelayActivity.serialize(turn.activityState);
      try { await window.api.history.save(conv); } catch (_) {}
    }
    if (currentConv && currentConv.id === convId) {
      removeThinking();
      if (turn.activityEl && turn.activityState && window.RelayActivity) window.RelayActivity.updateElement(turn.activityEl, turn.activityState);
      appendMessage('error', (result && result.error) || '自动重试启动失败');
      setRunning(false);
    }
    return;
  }
  const run = {
    jobId: result.jobId,
    convId,
    sessionId: null,
    sessionModel,
    turn,
    error: null,
    stderrBuf: '',
    autoRetried: true,   // 标记:这一轮已是降级重跑,若再失败不再自动重试,如实报错
    mode: mode,
    orch: mode === 'orchestrate' ? newOrchState() : null,
    activityState: mode === 'orchestrate' ? null : turn.activityState,
    activityEl: mode === 'orchestrate' ? null : turn.activityEl,
    currentStreamMessageId: null,
    textDeltaMessageIds: new Set(),
    assistantNeedsSeparator: false,
  };
  runs.set(convId, run);
  jobToConv.set(result.jobId, convId);
  refreshHistoryList();
}

// 为「AI 重新总结标题」构造素材:每轮用户消息截 60 字、从最新往回攒(预算 ~700 字)——
//   短会话可覆盖全程,长会话自动「近期完整、远期挤掉」;另附最新助手回复节选(当前讨论落点)。
//   不给首轮特殊地位:用户点重新总结,多半正是因为首轮已代表不了这个会话。
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
  const lastA = isCreate ? '' : clean(turns[turns.length - 1].assistant, 180);
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
  const text = `用户:${(first.user || '').slice(0, 400)}\n助手:${(first.assistant || '').slice(0, 300)}`;
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
window.api.onEvent((evt) => handleClaudeEvent(evt));

// 迷你输入框投递:新建一个普通对话,把文本填进输入框并发送 —— 完全复用现有 send() 链路。
//   主进程已保证主窗此刻可见且就绪;若当前正卡在某些非聊天视图,startNewConv 会切回聊天视图。
window.api.onMiniSubmit((text) => {
  const prompt = String(text || '').trim();
  if (!prompt) return;
  try {
    startNewConv('plain');     // 切回聊天视图 + 开一个干净的新对话(模型档位回到默认)
    inputEl.value = prompt;
    autoGrowInput();           // 同步输入框高度(多行时)
    send();                    // 走与手动发送完全相同的路径
  } catch (e) {
    console.error('迷你投递处理失败', e);
  }
});

// ─────────────────────────────────────────
// 多 Agent 协同(群聊式)渲染
//   依据实测的 headless 委派事件结构(见记忆 relay-multiagent-orchestration):
//   · assistant.tool_use(name='Agent', input{subagent_type,description,prompt}) → PM 派活
//   · user 事件带 subagent_type + parent_tool_use_id, content=text → 子 agent 发言
//   · system/task_started、task_notification(status:completed,+usage) → 子 agent 状态
//   · assistant 的 text block / 增量 → PM 自己的发言(规划 + 最终汇总)
// ─────────────────────────────────────────
function newOrchState() {
  return {
    tracks: new Map(),     // 每次 Agent 工具调用的唯一 key → { el, bodyEl, statusEl, raw, entry }
    byToolUse: new Map(),  // tool_use_id → { key, agent, toolUseId, description }
    pmBubble: null,        // 当前 PM 流式气泡(增量文本累计处)
    pmEntry: null,         // 当前 PM 段的结构记录(派活时置空,使每段 PM 文本各成一条)
    started: false,
  };
}
function orchAgentLabel(name) {
  // 复用用户自定义显示名(若有);agentLabelCache 在 listAgents 时填,没有就用 name
  return (orchLabelMap && orchLabelMap[name]) || name;
}
let orchLabelMap = {};   // name → displayName,首次进协同时填一次
let pmBrandCache = null;  // { name, logo } —— PM 自定义名/头像;null=未取/已失效,取一次缓存
let orchLabelsPromise = null; // 历史回放与即时发送可能同时请求，合并成一次本地读取
async function ensureOrchLabels() {
  if (orchLabelsPromise) return orchLabelsPromise;
  orchLabelsPromise = (async () => {
    try {
      const res = await window.api.data.listAgents();
      for (const it of ((res && res.items) || [])) orchLabelMap[it.name] = it.displayName || it.name;
    } catch (_) {}
    // 同时取 PM 自定义(名称 + 头像)
    try {
      const p = await window.api.pm.get();
      pmBrandCache = { name: (p && p.name) || '', logo: (p && p.logo) || '' };
    } catch (_) { pmBrandCache = { name: '', logo: '' }; }
  })();
  try {
    await orchLabelsPromise;
  } finally {
    orchLabelsPromise = null;
  }
}
// 群聊气泡:role='pm'|'agent';agentName 仅 agent 用(取头像/名字)
//   allowTyping=true 且 agent 无文本时显示「正在输入」动画(实时态);历史重建传 false。
function appendChatBubble(role, agentName, text, allowTyping = true) {
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();
  const el = document.createElement('div');
  // 带上 assistant 类:复用助手消息的 markdown 样式(strong/code/pre 等);
  //   裸文外观由下面 .chat-msg.assistant .bubble 的更高优先级覆盖(透明无框)。
  el.className = `message assistant chat-msg chat-${role}`;
  const isPM = role === 'pm';
  // PM 名称/头像:用户自定义优先(pmBrandCache),否则默认名 "PM" + 深色 PM 徽章
  const pmName = (pmBrandCache && pmBrandCache.name) ? pmBrandCache.name : 'PM';
  const pmLogo = (pmBrandCache && pmBrandCache.logo) ? pmBrandCache.logo : '';
  const name = isPM ? pmName : orchAgentLabel(agentName);
  const avatar = isPM
    ? (pmLogo
        ? `<img class="chat-avatar" alt="" src="${pmLogo}">`
        : `<div class="chat-avatar chat-avatar-pm" title="${escapeAttr(pmName)}">PM</div>`)
    : `<img class="chat-avatar" alt="" src="${(window.AgentAvatar) ? window.AgentAvatar.dataUri(agentName) : ''}">`;
  el.innerHTML = `
    ${avatar}
    <div class="chat-col">
      <div class="chat-head"><span class="chat-name"></span></div>
      <div class="bubble"><div class="body"></div></div>
    </div>
  `;
  el.querySelector('.chat-name').textContent = name;
  const body = el.querySelector('.body');
  // agent 轨未出结果时:body 里先放「正在输入」动画(复用 .typing 三点),等文本到达再替换。
  //   PM 是流式增量,首段空时不放动画(它会立刻有字)。历史重建 allowTyping=false,不放动画。
  if (!isPM && !text && allowTyping) {
    body.innerHTML = `<div class="typing chat-typing"><span></span><span></span><span></span></div>`;
  } else {
    body.innerHTML = renderMarkdown(text || '');
    enhanceCodeBlocks(body);
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return { el, bodyEl: body, statusEl: el.querySelector('.chat-status') };
}
// 剥离子 agent tool_result 里用户不该看到的非产出内容,只留最终成果。实测两类(见记忆 relay-multiagent-orchestration):
//   A. 框架尾巴:<usage>…</usage> + agentId: <id> (use SendMessage …)
//   B. 工具执行轨迹(会联网的 agent 如 researcher):规划碎碎念 + <function_calls>…</function_calls> 工具调用
//      + <function_response> 搜索原文(无闭合标签,散在文本里)。这些全在【最后一个 </function_calls> 之前】,
//      之后才是真正的产出 —— 故以最后一个 </function_calls> 为界整段砍前面,比逐个匹配不规范标签可靠。
function stripSubagentMeta(text) {
  if (!text) return text;
  let t = String(text);
  // 新版 Claude Code 的后台 Agent 首个 tool_result 只是启动回执，不是子智能体产出。
  // 旧版本 Relay 已经把它写进部分历史记录，重开历史时也要直接隐藏。
  if (/Async agent launched successfully/i.test(t)
    && /\b(?:agentId|output_file)\s*:/i.test(t)) return '';
  // ── B. 砍掉工具执行轨迹:有 </function_calls> 就丢弃它及之前的一切(规划+工具调用+搜索原文) ──
  const lastFc = t.lastIndexOf('</function_calls>');
  if (lastFc >= 0) t = t.slice(lastFc + '</function_calls>'.length);
  // 兜底:清掉可能残留的孤立工具标签
  t = t.replace(/<\/?function_(?:calls|response)>/gi, '')
       .replace(/<\/?invoke[^>]*>/gi, '')
       .replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/gi, '');
  // ── A. 砍掉框架尾巴 ──
  t = t.replace(/\s*<usage>[\s\S]*?<\/usage>\s*$/i, '');                          // 末尾 usage 块
  t = t.replace(/\s*agentId:\s*\S+\s*\(use SendMessage[^\n]*\)\s*$/i, '');        // agentId + SendMessage 提示
  t = t.replace(/\s*agentId:\s*\S+\s*$/i, '');                                    // 兜底:残留纯 agentId 行
  return t.trim();
}

function orchAgentRoute(input, toolUseId, description) {
  const rawType = (input && input.subagent_type) || 'agent';
  const source = `${description || ''}\n${(input && input.prompt) || ''}`;
  let agent = rawType;
  // 近期 CLI 会把用户 Agent 统一包装成 general-purpose；从派活提示中找回真实角色。
  if (rawType === 'general-purpose' || rawType === 'agent') {
    // PM 的标准委派提示通常以“你是……专员(writer)”开头，优先取第一个括号角色。
    // 下游 writer 的 prompt 会粘贴所有上游原文，若先全文搜索已知名称，会误命中素材里的 data-analyst。
    const tagged = source.match(/[（(【[]\s*([a-z][a-z0-9_-]{1,48})\s*[）)】\]]/i);
    if (tagged) agent = tagged[1];
    else {
      const names = Object.keys(orchLabelMap || {}).sort((a, b) => b.length - a.length);
      const matched = names.find((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, 'i').test(source);
      });
      if (matched) agent = matched;
    }
  }
  return {
    key: toolUseId || `${agent}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    agent,
    toolUseId: toolUseId || null,
    description: description || '',
  };
}

function normalizeOrchRoute(route) {
  if (route && typeof route === 'object') return route;
  const agent = route || 'agent';
  return { key: agent, agent, toolUseId: null, description: '' };
}

function isAsyncAgentLaunch(evt, text) {
  const structured = (evt && (evt.tool_use_result || evt.toolUseResult)) || {};
  return structured.isAsync === true
    || structured.status === 'async_launched'
    || /Async agent launched successfully/i.test(text || '');
}

function parseOrchTaskNotification(content) {
  if (typeof content !== 'string' || !/<task-notification>/i.test(content)) return null;
  const readTag = (name) => {
    const match = content.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return match ? match[1].trim() : '';
  };
  const toolUseId = readTag('tool-use-id');
  if (!toolUseId) return null;
  return {
    toolUseId,
    taskId: readTag('task-id'),
    status: readTag('status').toLowerCase(),
    summary: readTag('summary'),
    result: readTag('result'),
  };
}

// 取(或建)某次子 agent 调用的发言轨。chat=run.turn.chat,同步建一条结构化记录(供历史重建)。
function orchTrack(orch, routeValue, onView, chat) {
  const route = normalizeOrchRoute(routeValue);
  let t = orch.tracks.get(route.key);
  if (!t) {
    // 复用已有结构记录(重开正在跑的会话时 tracks 被重置,但 chat 里该调用的记录还在,别建重复)。
    // toolUseId 可区分同名 Agent 的多次/并行调用；旧历史没有它时才退回按名称查找。
    let entry = chat && chat.find((m) => m.role === 'agent'
      && (route.toolUseId ? m.toolUseId === route.toolUseId : m.agent === route.agent));
    if (onView) {
      t = appendChatBubble('agent', route.agent, entry ? entry.text : '');
    } else {
      t = { el: null, bodyEl: null, statusEl: null };
    }
    t.raw = entry ? (entry.text || '') : '';
    if (!entry) {
      entry = { role: 'agent', agent: route.agent, toolUseId: route.toolUseId, text: '' };
      if (chat) chat.push(entry);
    }
    t.entry = entry;
    t.route = route;
    orch.tracks.set(route.key, t);
  }
  return t;
}
// 从结构化 chat 日志重建群聊气泡。
// liveOrch 存在时表示会话仍在运行：保留空的“正在输入”轨，并把新 DOM 重新挂回 tracks，
// 这样切走再回来后，完成通知会原位填充，不会另建一条重复气泡。
function renderChatLog(chatArr, liveOrch = null) {
  for (const m of (chatArr || [])) {
    if (m.role === 'dispatch') {
      // 派活提示并入 PM,无需单独气泡;跳过(PM 气泡里已含规划文本)
      continue;
    }
    const role = (m.role === 'pm') ? 'pm' : 'agent';
    // 历史重建:agent 文本再过一遍剥离(兼容修复前存的旧会话,其 text 里可能还含工具调用/框架尾巴)
    const text = (role === 'agent') ? stripSubagentMeta(m.text || '') : (m.text || '');
    if (role === 'agent' && !text && !liveOrch) continue;
    const bubble = appendChatBubble(role, m.agent || null, text, !!liveOrch);
    if (role === 'agent' && liveOrch) {
      const route = (m.toolUseId && liveOrch.byToolUse.get(m.toolUseId))
        || normalizeOrchRoute({ key: m.toolUseId || m.agent, agent: m.agent, toolUseId: m.toolUseId || null });
      bubble.raw = text;
      bubble.entry = m;
      bubble.route = route;
      liveOrch.tracks.set(route.key, bubble);
    }
  }
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
  const onView = isViewingJob(jobId);   // 该事件归属会话是否正被查看

  // ── 协同模式:优先按群聊分流;命中则直接返回,不走下面的通用渲染 ──
  if (run.mode === 'orchestrate' && run.orch) {
    if (handleOrchestrateEvent(evt, run, onView)) return;
  }

  // 普通/Agent 模式的所有结构化事件先进入同一个归并器。它按 content block 和
  // tool_use_id 原位更新，不再把思考/工具调用拆成散落的独立卡片。
  if (run.activityState && window.RelayActivity) {
    window.RelayActivity.ingest(run.activityState, evt);
    updateRunActivity(run, onView, activityEventNeedsRender(evt));
  }

  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id) {
      run.sessionId = evt.session_id;
      if (onView) currentSessionId = evt.session_id;
    }
    return;
  }
  if (evt.type === 'assistant' && evt.message) {
    // 子 Agent 的完整 assistant 回合已经由活动流归入对应后台任务。
    // 这里不能再把它当作主助手最终回答，否则普通对话会提前出现子任务原文，
    // 随后的主任务汇总还会重复一次。
    if (evt.subagent_type) return;
    if (onView) removeThinking();
    const content = evt.message.content || [];
    const messageId = evt.message.id || run.currentStreamMessageId || '';
    const streamed = !!run.currentMessageHadTextDelta || (run.textDeltaMessageIds && run.textDeltaMessageIds.has(messageId));
    // include-partial-messages 正常会走 text_delta；若某版本/后端只给完整 assistant，
    // 用整段文本兜底，且按 message.id 避免与已流式累计的内容重复。
    let completedTextMessage = streamed;
    if (!streamed) {
      const fullText = content.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
      if (fullText) {
        const startsNewMessage = appendRunAssistantText(run, fullText);
        completedTextMessage = true;
        if (onView) {
          if (startsNewMessage) currentAssistantBubble = null;
          appendOrUpdateAssistant(fullText, false);
        }
      }
    }
    // 一条 assistant 消息结束 → 记录逻辑段落边界并断开流式气泡。
    // 这个边界必须进入 run.turn.assistant；否则切走再回来时，多条透明 assistant
    // 气泡会被重建成一个 Markdown 块，原先的段落间距就会全部挤在一起。
    if (completedTextMessage) run.assistantNeedsSeparator = true;
    run.currentMessageHadTextDelta = false;
    if (onView) {
      flushStreamRender();
      currentAssistantBubble = null;
    }
    return;
  }

  if (evt.type === 'stream_event' && evt.event) {
    const e = evt.event;
    if (e.type === 'message_start' && e.message && e.message.id) {
      run.currentStreamMessageId = e.message.id;
    }
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && e.delta.text) {
        if (!run.textDeltaMessageIds) run.textDeltaMessageIds = new Set();
        run.textDeltaMessageIds.add(run.currentStreamMessageId || 'unknown');
        run.currentMessageHadTextDelta = true;
        const startsNewMessage = appendRunAssistantText(run, e.delta.text);
        if (onView) {
          removeThinking();
          if (startsNewMessage) currentAssistantBubble = null;
          appendOrUpdateAssistant(e.delta.text, true);
        }
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.session_id) {
      run.sessionId = evt.session_id;
      if (onView) currentSessionId = evt.session_id;
    }
    if (onView) removeThinking();
    if (evt.is_error || (evt.subtype && evt.subtype !== 'success')) {
      run.error = (Array.isArray(evt.errors) && evt.errors.join('\n')) || evt.result || '执行出错';
      if (onView) appendMessage('error', `❌ ${run.error}`);
    }
    // 真正的收尾在 job-done(result 之后还可能有残留事件);这里只记录状态。
    return;
  }

  // 后端进程结束(正常/异常/spawn 失败)→ 落盘 + 清理该 run
  if (evt.type === 'job-done') {
    finishRun(jobId, evt);
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

// 协同事件分流:返回 true=本函数已处理(跳过通用渲染);false=放行给通用逻辑。
//   通用逻辑仍需处理 result / job-done / stderr 等收尾事件,故这些一律 return false。
//   除了渲染 DOM,还把每条群聊消息结构化存进 run.turn.chat[](finishRun 写回 turn.chat),
//   供历史会话重开时按结构重建群聊(不再退化成单气泡)。
function handleOrchestrateEvent(evt, run, onView) {
  const orch = run.orch;
  // run.turn.chat:[{role:'pm'|'agent'|'dispatch', agent?, text?, status?}]
  if (!run.turn.chat) run.turn.chat = [];
  const chat = run.turn.chat;

  // 1) PM 自己的 assistant 事件(不带 subagent_type):派活(Agent 工具)+ thinking。
  //   带 subagent_type 的 assistant 是子 agent 的输出,由下面的分支 1.5 处理,这里要排除。
  if (evt.type === 'assistant' && evt.message && !evt.subagent_type) {
    const blocks = evt.message.content || [];
    let handled = false;
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === 'Agent') {
        handled = true;
        const desc = (b.input && b.input.description) || '';
        const route = orchAgentRoute(b.input || {}, b.id, desc);
        // 派活时立刻建立 tool_use_id → 调用路由。不能只按 subagent_type：
        // 新版 CLI 的并行用户 Agent 会全部报告为 general-purpose，按类型会把多路结果互相覆盖。
        if (b.id) orch.byToolUse.set(b.id, route);
        // PM 派活记一条(累积进 transcript)
        run.turn.assistant += `\n\n**PM → @${orchAgentLabel(route.agent)}**：${desc}\n`;
        // 若 PM 还没出任何文本就直接派活,清掉那个空的"待出 PM 气泡"(只剩动画没内容,留着难看)
        if (pendingPmBubble && pendingPmBubble.el && !pendingPmBubble.raw) {
          if (pendingPmBubble.el.isConnected) pendingPmBubble.el.remove();
          pendingPmBubble = null;
        }
        orch.pmBubble = null; orch.pmEntry = null;   // 派活后另起 PM 段(气泡 + 结构记录都另起)
        orchTrack(orch, route, onView, chat);   // 预建该 agent 发言轨(头像+名字+正在输入动画),不显示状态文本
      } else if (b.type === 'thinking') {
        // 协同里 PM/子 agent 的思考卡片太碎、打断群聊节奏,不渲染(仍留存到 thinkingList 不影响)
        run.turn.thinkingList.push(b.thinking || '');
      }
      // text block:PM 整段文本,走 stream_event 增量,这里跳过避免重复
    }
    // assistant 事件即便含 Agent 也可能夹带 text,但 text 由 stream_event 增量渲染;
    //   本事件交给协同处理完毕(PM 气泡/派活都已处理),返回 true。
    if (handled) { orch.pmBubble = null; orch.pmEntry = null; }
    return true;
  }

  // 1.5) 子 agent 的 assistant 输出(实测:新版 CLI 把子 agent 的每个完整回合作为一条
  //   顶层带 subagent_type + parent_tool_use_id 的 assistant 事件透出,不再走 user/tool_result,
  //   也没有独立的 stream_event 增量流)。取其 text block 追加到对应 agent 气泡;thinking 吞掉。
  //   配对键:parent_tool_use_id === 派活时 Agent 工具块的 id(orch.byToolUse 已建);兜底按 subagent_type。
  if (evt.type === 'assistant' && evt.subagent_type && evt.message) {
    const pid = evt.parent_tool_use_id || null;
    let route = (pid && orch.byToolUse.get(pid))
      || orchAgentRoute({ subagent_type: evt.subagent_type }, pid, '');
    let text = '';
    for (const b of (evt.message.content || [])) {
      if (b.type === 'text' && b.text) text += b.text;
      // thinking 块不渲染(与 PM 一致);tool_use(子 agent 内部调用 web_search 等)不外显
    }
    text = stripSubagentMeta(text);
    if (text) {
      const t = orchTrack(orch, route, onView, chat);
      t.raw = (t.raw ? t.raw + '\n\n' : '') + text;   // 多轮 assistant 事件累积追加
      if (t.entry) t.entry.text = t.raw;
      run.turn.assistant += `\n\n**@${orchAgentLabel(route.agent)}**：${text}\n`;
      if (onView && t.bodyEl) {
        t.bodyEl.innerHTML = renderMarkdown(t.raw);
        enhanceCodeBlocks(t.bodyEl);
        scrollToBottom();
      }
    }
    return true;
  }

  // 2) 子 agent 的真实输出(实测确认):一条 user 事件的 tool_result,其 tool_use_id === 派活时 Agent.id。
  //   ⚠️ 关键语义(实测两次才搞清):
  //     · role=user + subagent_type  = PM【发给】子 agent 的任务输入(那段"请检索…"),不是产出 → 吞掉
  //     · role=user 的 tool_result(tool_use_id 配对) = 子 agent 的【完整产出正文】→ 填进对应 agent 气泡!
  if (evt.type === 'user') {
    const c = (evt.message || {}).content;
    const notification = parseOrchTaskNotification(c);
    if (notification) {
      const route = orch.byToolUse.get(notification.toolUseId);
      if (route) {
        const text = stripSubagentMeta(notification.result
          || (notification.status && notification.status !== 'completed' ? notification.summary : ''));
        if (text) {
          run.turn.assistant += `\n\n**@${orchAgentLabel(route.agent)}**：${text}\n`;
          const t = orchTrack(orch, route, onView, chat);
          t.raw = text;
          if (t.entry) t.entry.text = text;
          if (onView && t.bodyEl) {
            t.bodyEl.innerHTML = renderMarkdown(text);
            enhanceCodeBlocks(t.bodyEl);
            scrollToBottom();
          }
        }
      }
      return true;
    }
    if (Array.isArray(c)) {
      // 找 tool_result,用 tool_use_id 反查是哪个 agent(orch.byToolUse 在派活时已建 id→sub 映射)
      const tr = c.find((x) => x && x.type === 'tool_result');
      if (tr && !tr.is_error) {
        const route = orch.byToolUse.get(tr.tool_use_id);
        if (route) {
          let text = '';
          const inner = tr.content;
          if (typeof inner === 'string') text = inner;
          else if (Array.isArray(inner)) text = inner.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('');
          // 后台 Agent 的首个 tool_result 只是启动确认。保留“正在输入”轨道，
          // 真正结果稍后会通过 <task-notification> 到达。
          if (isAsyncAgentLaunch(evt, text)) return true;
          text = stripSubagentMeta(text);   // 剥掉框架附加的 agentId/<usage> 尾巴
          if (text) {
            run.turn.assistant += `\n\n**@${orchAgentLabel(route.agent)}**：${text}\n`;
            const t = orchTrack(orch, route, onView, chat);
            t.raw = text;   // tool_result 是完整正文(一次性),直接替换而非追加
            if (t.entry) t.entry.text = t.raw;
            if (onView && t.bodyEl) { t.bodyEl.innerHTML = renderMarkdown(t.raw); enhanceCodeBlocks(t.bodyEl); scrollToBottom(); }
          }
        }
      }
    }
    // 其余 user(任务输入、未配对的 tool_result)都是委派内部流转,不渲染
    return true;
  }

  // 3) 子 agent 状态事件:只用来兜底建轨,不再渲染任何状态文本(用户要求去掉「✓ 完成 · 24s · 866 tok」)
  if (evt.type === 'system' && (evt.subtype === 'task_started' || evt.subtype === 'task_notification')) {
    let route = orch.byToolUse.get(evt.tool_use_id);
    if (!route && evt.subagent_type) route = orchAgentRoute({ subagent_type: evt.subagent_type }, evt.tool_use_id, '');
    if (route) {
      // 2.1.220 的 task_started/task_notification 都直接带 tool_use_id；若前面的 assistant
      // 完整输出事件缺失，就用完成通知 summary 兜底填充。已有正文时不覆盖，避免重复。
      if (evt.tool_use_id && !orch.byToolUse.has(evt.tool_use_id)) orch.byToolUse.set(evt.tool_use_id, route);
      const t = orchTrack(orch, route, onView, chat);
      if (evt.subtype === 'task_notification' && !t.raw && evt.summary) {
        const text = stripSubagentMeta(evt.summary);
        if (text) {
          t.raw = text;
          if (t.entry) t.entry.text = text;
          run.turn.assistant += `\n\n**@${orchAgentLabel(route.agent)}**：${text}\n`;
          if (onView && t.bodyEl) {
            t.bodyEl.innerHTML = renderMarkdown(text);
            enhanceCodeBlocks(t.bodyEl);
            scrollToBottom();
          }
        }
      }
    }
    return true;
  }

  // 4) status:requesting / init 等 —— 协同里无需特殊渲染,但 init 要让通用逻辑记 session_id
  if (evt.type === 'system' && evt.subtype === 'status') return true;   // 静默吞掉 requesting 噪声

  // 5) stream_event:PM 自己的增量文本 → PM 气泡 + PM 结构记录
  if (evt.type === 'stream_event' && evt.event) {
    const e = evt.event;
    if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
      run.turn.assistant += e.delta.text;
      // 结构记录:当前 PM 段(派活会把 pmEntry 置空,从而下一段文本另起一条 PM 记录)
      if (!orch.pmEntry) { orch.pmEntry = { role: 'pm', text: '' }; chat.push(orch.pmEntry); }
      orch.pmEntry.text += e.delta.text;
      if (onView) {
        // 复用"待出 PM 气泡"(showThinking 建的,带头像+正在输入动画)→ 第一段文本到达即替换动画继续流式;
        //   没有待出气泡(派活后的后续 PM 段)就新建一个。
        if (!orch.pmBubble) {
          if (pendingPmBubble && pendingPmBubble.el && pendingPmBubble.el.isConnected) {
            orch.pmBubble = pendingPmBubble; pendingPmBubble = null;
          } else {
            orch.pmBubble = appendChatBubble('pm', null, '');
          }
        }
        orch.pmBubble.raw = (orch.pmBubble.raw || '') + e.delta.text;
        orch.pmBubble.bodyEl.innerHTML = renderMarkdown(orch.pmBubble.raw);
        enhanceCodeBlocks(orch.pmBubble.bodyEl);
        scrollToBottom();
      }
    }
    return true;
  }

  // 其余(init / result / job-done / stderr / raw)放行给通用逻辑收尾
  return false;
}

// ─────────────────────────────────────────
// 消息渲染
// ─────────────────────────────────────────
function formatMessageTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function appendMessageTime(el, ts) {
  if (!el) return;
  const timeText = formatMessageTime(ts);
  if (!timeText) return;

  let meta = Array.from(el.children).find((child) => child.classList && child.classList.contains('message-meta'));
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'message-meta';
    el.appendChild(meta);
  }
  let time = meta.querySelector('.message-time');
  if (!time) {
    time = document.createElement('time');
    time.className = 'message-time';
    meta.appendChild(time);
  }
  time.dateTime = ts;
  time.textContent = timeText;
}

function appendMessage(role, text, files, meta = null) {
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();

  const el = document.createElement('div');
  el.className = `message ${role}`;

  if (role === 'assistant') {
    el.innerHTML = `<div class="bubble"><div class="body"></div></div>`;
    const body = el.querySelector('.body');
    body.innerHTML = renderMarkdown(text || '');
    enhanceCodeBlocks(body);
    appendMessageTime(el, meta && meta.ts);
  } else {
    // 用户消息:附件区(若有)在气泡上方、右对齐
    if (role === 'user' && Array.isArray(files) && files.length) {
      el.appendChild(renderMsgAttachments(files));
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text || '';
    // 协同模式:用户消息也带头像(复用侧边栏自定义 logo),与群聊里 PM/agent 头像呼应。
    //   结构:气泡 + 头像,靠右(CSS .chat-user-row 处理布局)。
    if (role === 'user' && currentMode === 'orchestrate') {
      const row = document.createElement('div');
      row.className = 'chat-user-row';
      const av = document.createElement('img');
      av.className = 'chat-avatar chat-avatar-user';
      const brand = document.getElementById('brandLogo');
      av.src = (brand && brand.src) ? brand.src : 'logo.png';
      av.alt = '';
      if (text || !(Array.isArray(files) && files.length)) row.appendChild(bubble);
      row.appendChild(av);
      el.appendChild(row);
      appendMessageTime(el, meta && meta.ts);
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }
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


// 协同模式下"待出 PM 气泡"的引用:用户发完先建一个带 PM 头像+名字+正在输入动画的气泡,
//   PM 第一段流式文本到达时复用它(替换动画、继续追加),实现"头像名称→转圈→流式"的群聊感。
let pendingPmBubble = null;
function showThinking() {
  const welcome = document.querySelector('.welcome');
  if (welcome) welcome.remove();
  // 协同:用带头像/名字的 PM 气泡 + 正在输入动画,替代无头像的裸转圈
  if (currentMode === 'orchestrate') {
    if (pendingPmBubble && pendingPmBubble.el && pendingPmBubble.el.isConnected) return;
    const b = appendChatBubble('pm', null, '');   // PM 头像+名字
    b.bodyEl.innerHTML = `<div class="typing chat-typing"><span></span><span></span><span></span></div>`;
    b.raw = '';
    pendingPmBubble = b;
    return;
  }
  if (document.querySelector('.thinking-indicator')) return;
  const el = document.createElement('div');
  el.className = 'message assistant thinking-indicator';
  el.innerHTML = `
    <div class="bubble">
      <div class="typing"><span></span><span></span><span></span></div>
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}
function removeThinking() {
  const el = document.querySelector('.thinking-indicator');
  if (el) el.remove();
  // 协同:若 PM 待出气泡还空着(没等到文本就被收尾/出错),移除它,避免留个空转圈气泡
  if (pendingPmBubble && pendingPmBubble.el && !pendingPmBubble.raw) {
    if (pendingPmBubble.el.isConnected) pendingPmBubble.el.remove();
    pendingPmBubble = null;
  }
}

// 流式渲染:实时吐字(和正常 Chat 一样,代码块也跟着逐字出现)。
//   两个要点:
//   ① 流式过程中【只渲染 markdown,不加「运行/复制/折叠」按钮、也不折叠代码】——
//      每次重渲染都重建整棵 DOM,若此时挂按钮/折叠,就会:按钮悬停闪烁、点展开又被下一帧打回折叠。
//      按钮和折叠只在流式【结束】后用 enhanceCodeBlocks 加一次。
//   ② 轻节流(约 60ms / 帧)。renderMarkdown 每次都会对整段代码重跑 highlight.js,
//      代码很长时若按每个 token 渲染会卡;60ms ≈ 16fps 对"实时吐字"观感已足够顺滑,又不卡。
const STREAM_RENDER_MS = 60;
let streamRenderTimer = null;
let streamRenderBubble = null;   // 本轮渲染锚定的气泡,切换会话后失效则不再写

// 切换会话时，旧气泡会随 messagesEl.innerHTML 一起销毁。同步取消旧帧，
// 避免它和切回后新建的气泡争用同一个节流定时器。
function detachStreamRenderTarget() {
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }
  streamRenderBubble = null;
  currentAssistantBubble = null;
}

// Claude Code 一轮里可能产生多条顶层 assistant 消息（文本 → 工具 → 文本）。
// 直播时它们是多个透明气泡；持久化/切回时则会合并为 turn.assistant。
// 在下一条有文字的消息开始时补一个 Markdown 空行，确保两种渲染路径等价。
// 返回 true 表示这段文字属于一条新消息，当前视图也应另起气泡。
function appendRunAssistantText(run, text) {
  const value = String(text || '');
  if (!value) return false;
  const startsNewMessage = !!(run && run.assistantNeedsSeparator && run.turn && run.turn.assistant);
  if (startsNewMessage) run.turn.assistant += '\n\n';
  run.turn.assistant += value;
  run.assistantNeedsSeparator = false;
  return startsNewMessage;
}

// 渲染流式中的气泡:只出 markdown,不加按钮/折叠
function renderStreamBubble(bubble) {
  if (!bubble || !bubble.isConnected || bubble !== currentAssistantBubble) return false;
  const body = bubble.querySelector('.body');
  if (!body) return false;
  body.innerHTML = renderMarkdown(bubble.dataset.raw || '');
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
  body.innerHTML = renderMarkdown(bubble.dataset.raw || '');
  enhanceCodeBlocks(body);   // 收尾才挂按钮 + 折叠,只此一次,不会闪、不会被打回
}

function appendOrUpdateAssistant(textDelta, isStreaming = false, meta = null) {
  if (!currentAssistantBubble) {
    currentAssistantBubble = appendMessage('assistant', isStreaming ? '' : textDelta, null, meta);
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

// 用户是否“贴在底部”。流式输出时只有贴底才自动滚动,
//   用户一旦手动上滑查看,就不再强制拉回底部(像主流聊天应用)。
let stickToBottom = true;
function isNearBottom() {
  const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return gap < 80;   // 距底 80px 内算“贴底”
}
messagesEl.addEventListener('scroll', () => {
  stickToBottom = isNearBottom();
  scheduleConversationIndexUpdate();
});

// force=true 时无条件滚到底(如刚发出新消息);否则仅在贴底时才自动滚
function scrollToBottom(force = false) {
  if (force || stickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    stickToBottom = true;
    scheduleConversationIndexUpdate();
  }
}

// 把已完成的历史轮次拼成文字上下文,用于「切换模型后开新线程」时带过去(纯对话模式)
function buildContextPreamble(turns) {
  if (!Array.isArray(turns) || !turns.length) return '';
  const blocks = [];
  for (const t of turns) {
    if (!t) continue;
    const u = (t.user || '').trim();
    const a = (t.assistant || '').trim();
    let b = '';
    if (u) b += `我:${u}\n`;
    if (a) b += `你:${a}`;
    if (b.trim()) blocks.push(b.trim());
  }
  if (!blocks.length) return '';
  let joined = blocks.join('\n\n');
  const MAX = 12000;  // 控制体量,过长则只保留最近的部分
  if (joined.length > MAX) joined = '(较早的对话已省略)\n\n' + joined.slice(joined.length - MAX);
  return `以下是我们之前的对话记录，供你参考延续：\n\n${joined}\n\n———\n请基于以上上下文，继续回答我接下来的问题：`;
}

// ─────────────────────────────────────────
// 发送 / 中止
// ─────────────────────────────────────────
async function send() {
  const prompt = inputEl.value.trim();
  // 允许「纯附件」发送(有文件即可,文字可为空)
  if (!prompt && !attachedFiles.length) return;
  // 当前所看会话若已在跑,不允许在同一会话里再发(一个会话同时只跑一轮);
  //   但可以「新对话」后向另一个会话发 —— 那是并行,走下面正常流程。
  if (currentConv && isConvRunning(currentConv.id)) {
    showToast('这个对话还在回复中，请新建对话或等它完成…');
    inputEl.classList.add('shake');
    setTimeout(() => inputEl.classList.remove('shake'), 400);
    return;
  }
  // 并行上限(与后端 MAX_PARALLEL_JOBS 一致),提前给友好提示
  if (runs.size >= 3) {
    showToast('已有 3 个对话在同时运行，请等待其中一个完成…');
    inputEl.classList.add('shake');
    setTimeout(() => inputEl.classList.remove('shake'), 400);
    return;
  }

  // startNewConv 的身份预取是异步的。用户进入协奏后立即发送时也要等它完成，
  // 否则第一条“正在输入”PM 气泡仍可能短暂使用默认头像和名称。
  if (currentMode === 'orchestrate' && !pmBrandCache) await ensureOrchLabels();

  // 注：定时任务的建/查/改/删现已全部由 cron MCP 在对话里处理（claude:run 检测到相关词会自动挂载）。
  //   这里不再做意图识别拦截，含定时任务词的消息照常走 claude，点发送即刻转圈，无卡顿。

  // 模型档位:新对话和 Agent 模式都用用户当前选中的档位(Agent 也可自由切换模型)。
  const modelToSend = currentModel;
  const skillForTurn = selectedQuickSkill
    ? {
        name: selectedQuickSkill.name,
        callName: selectedQuickSkill.callName || selectedQuickSkill.name,
        displayName: selectedQuickSkill.displayName || selectedQuickSkill.name,
        desc: selectedQuickSkill.desc || '',
        summary: selectedQuickSkill.summary || selectedQuickSkill.desc || '',
      }
    : null;

  // 跨模型续接 → thinking 块签名失效:不同档位走不同上游(快速=MiMo /
  //   思考·专家=Bedrock),旧后端留下的带签名 thinking 块在新后端 --resume 会被拒
  //   (400 Invalid signature in thinking block)。故切换档位时丢弃旧 session、开新
  //   线程;同时把前文作为文字上下文带进新线程,尽量不丢上下文。
  let promptToSend = prompt;
  let switchNotice = null;
  let needCarryContext = false;
  const carryContextForMcpReset = !!(currentConv && currentConv.carryContextOnNextTurn);
  if (carryContextForMcpReset) {
    // 设置页的“重新加载 MCP”会刻意放弃旧 Claude session。工具列表由新 session
    // 在启动时重新发现；对话连续性则由 Relay 把历史作为文本上下文带入。
    currentSessionId = null;
    currentConv.sessionId = null;
    needCarryContext = true;
    switchNotice = '已在全新 Claude 会话中重新加载 MCP（已带上前面的对话继续）';
  }
  if (currentMode === 'plain' && currentConv && currentSessionId &&
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
    const ctx = buildContextPreamble(currentConv.turns);
    if (ctx) promptToSend = `${ctx}\n\n${prompt || ''}`.trim();
  }
  if (skillForTurn) {
    const invokeSkill = `请先调用 Skill 工具加载「${skillForTurn.callName || skillForTurn.name}」技能，并严格按照该技能处理下面的请求。`;
    promptToSend = `${invokeSkill}\n\n${promptToSend}`.trim();
  }

  // 取出本轮附件(轻量元数据,用于发送 + 存档),随后清空输入区
  const filesToSend = attachedFiles.map((f) => ({
    path: f.path, name: f.name, ext: f.ext, size: f.size,
  }));
  attachedFiles = [];
  renderAttachments();

  const turnIndex = currentConv && Array.isArray(currentConv.turns) ? currentConv.turns.length : 0;
  appendConversationTurnAnchor(turnIndex);
  if (switchNotice) appendMessage('system', switchNotice);
  const turnTs = new Date().toISOString();
  const userMessageEl = appendMessage('user', prompt, filesToSend, { ts: turnTs });
  if (userMessageEl) userMessageEl.dataset.turn = String(turnIndex);
  inputEl.value = '';
  setSelectedQuickSkill(null);  // 快捷技能仅消费一次，避免下一轮误用
  hideSkillQuickPopup();
  autoGrowInput();   // 发送后缩回去
  scrollToBottom(true);   // 自己刚发的消息,无条件滚到底
  currentAssistantBubble = null;

  const turn = {
    user: prompt,
    assistant: '',
    thinkingList: [],
    files: filesToSend,
    ts: turnTs,
    skill: skillForTurn,
    activityState: currentMode === 'orchestrate' ? null : newActivityState(),
    activityEl: null,
  };

  // 立刻把 conv + 用户消息存盘,侧边栏立刻出现这次对话,切走再切回也找得到
  if (!currentConv) {
    currentConv = {
      title: (prompt || (filesToSend[0] && filesToSend[0].name) || '附件').slice(0, 16),
      sessionId: currentSessionId,
      mode: currentMode,
      agent: currentAgent,
      agentLabel: currentAgentLabel,
      orchestrateAgents: currentOrchestrateAgents,   // 协同模式:用户勾选的 agent 名数组(空=PM 全权)
      model: currentModel,
      sessionModel: currentModel,
      workingDir: currentWorkingDir,   // 工作目录随会话保存
      turns: [],
    };
  } else {
    currentConv.sessionId = currentSessionId;
    currentConv.model = currentModel;
    currentConv.sessionModel = currentModel;
    currentConv.workingDir = currentWorkingDir;
  }
  currentConv.turns.push({
    user: prompt,
    assistant: '',         // 占位,稍后由 finishRun 填充
    thinking: null,
    files: filesToSend,
    ts: turn.ts,
    skill: skillForTurn,
  });
  const saved = await window.api.history.save(currentConv);
  currentConv.id = saved.id;
  currentConv.updatedAt = saved.updatedAt;
  chatTitle.textContent = currentConv.title;
  refreshConversationIndex();

  // 快照本轮所属会话(下面 await 期间用户可能切走,不能再依赖 currentConv)
  const convId = currentConv.id;
  const sentConv = currentConv;
  const resumeSessionId = currentSessionId;
  const sessionModel = currentModel;
  const workingDirPath = currentWorkingDir && currentWorkingDir.path ? currentWorkingDir.path : null;
  const sentMode = currentMode;
  const sentAgent = currentAgent;
  const sentOrchestrateAgents = currentOrchestrateAgents;

  setRunning(true);
  if (currentMode === 'orchestrate') showThinking();
  else turn.activityEl = appendActivityState(turn.activityState, false);
  await refreshHistoryList();

  // 末位 convId:主进程据它复用本对话的常驻 claude 进程(MCP 不必每轮重启)。
  const result = await window.api.runClaude(
    promptToSend, resumeSessionId, sentMode, filesToSend, modelToSend, sentAgent,
    workingDirPath, sentOrchestrateAgents, convId, carryContextForMcpReset,
  );

  if (!result || result.error) {
    if (turn.activityState && window.RelayActivity) {
      window.RelayActivity.finish(turn.activityState, (result && result.error) || '启动失败');
      const failedTurn = sentConv.turns && sentConv.turns[sentConv.turns.length - 1];
      if (failedTurn) failedTurn.activity = window.RelayActivity.serialize(turn.activityState);
      try { await window.api.history.save(sentConv); } catch (_) {}
    }
    // spawn 失败 / 超并发上限:只影响这一条,回滚 UI(若仍在看这个会话)
    if (currentConv && currentConv.id === convId) {
      removeThinking();
      if (turn.activityEl && turn.activityState && window.RelayActivity) window.RelayActivity.updateElement(turn.activityEl, turn.activityState);
      appendMessage('error', (result && result.error) || '启动失败');
      setRunning(false);
    }
    return;
  }

  // 只有新运行时真正启动成功后才消费这个标记。启动失败时保留，下次仍会尝试新 session。
  if (carryContextForMcpReset && sentConv.carryContextOnNextTurn) {
    delete sentConv.carryContextOnNextTurn;
    const resetSaved = await window.api.history.save(sentConv);
    sentConv.updatedAt = resetSaved.updatedAt;
  }

  // 登记本次运行(数据从此按 convId 累积,事件靠 jobId 反查)
  const run = {
    jobId: result.jobId,
    convId,
    sessionId: result.sessionId || resumeSessionId,
    sessionModel,
    turn,
    error: null,
    stderrBuf: '',   // 累积 stderr;失败收尾时回放(不再因用户没看着该会话而丢失错误详情)
    mode: sentMode,                 // 协同渲染要据此分流
    orch: sentMode === 'orchestrate' ? newOrchState() : null,  // 协同态:tool_use_id → agent 轨
    activityState: sentMode === 'orchestrate' ? null : turn.activityState,
    activityEl: sentMode === 'orchestrate' ? null : turn.activityEl,
    currentStreamMessageId: null,
    textDeltaMessageIds: new Set(),
    assistantNeedsSeparator: false,
  };
  runs.set(convId, run);
  jobToConv.set(result.jobId, convId);
  refreshHistoryList();   // 侧边栏给这个会话亮起 running 指示
}

// 全局兼容标记(部分旧代码可能引用);真正的运行态以 runs 为准。
function setRunning(running) {
  // 发送按钮的「停止/发送」反映【当前所看会话】是否在跑
  const viewingRunning = running != null
    ? running
    : (currentConv && isConvRunning(currentConv.id));
  isRunning = !!viewingRunning;
  sendBtn.classList.toggle('is-stop', !!viewingRunning);
  sendBtn.title = viewingRunning ? '中止' : '发送 (Enter)';
  syncMcpReconnectButtons(!!viewingRunning);
}
// 按当前所看会话刷新发送按钮状态
function syncRunningUI() { setRunning(currentConv && isConvRunning(currentConv.id)); }

// 中止【当前所看会话】的运行
async function abortCurrent() {
  const convId = currentConv && currentConv.id;
  const run = convId && runs.get(convId);
  if (!run) { setRunning(false); return; }
  await window.api.abortClaude(run.jobId);
  if (run.activityState && window.RelayActivity) {
    window.RelayActivity.finish(run.activityState, '已由用户中止');
    updateRunActivity(run, true, true);
  }
  // 中止不会保证后端再发 job-done；主动保存已经收到的回答和过程，避免历史里只剩空占位。
  const last = currentConv && currentConv.turns && currentConv.turns[currentConv.turns.length - 1];
  if (last) {
    last.assistant = run.turn.assistant;
    last.thinking = run.turn.thinkingList.join('\n\n--- 下一段思考 ---\n\n') || null;
    if (run.activityState && window.RelayActivity) last.activity = window.RelayActivity.serialize(run.activityState);
    try { await window.api.history.save(currentConv); } catch (_) {}
  }
  appendMessage('system', '已中止');
  // 清理该 run(后端已杀进程,可能不再有 job-done;这里主动收尾)
  runs.delete(convId);
  jobToConv.delete(run.jobId);
  removeThinking();
  setRunning(false);
  refreshHistoryList();
}

sendBtn.addEventListener('click', () => {
  if (isRunning) abortCurrent();
  else           send();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isRunning) send();
  }
});

// 输入框自适应高度(豆包式:输入越多越高,到一定高度后内部滚动)
function autoGrowInput() {
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
  icon.className = 'ac-icon';
  const ext = (f.ext || (f.name || '').split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.includes(ext) && f.path) {
    const img = document.createElement('img');
    // 参考图传的是 data: URL,直接用;本地文件路径才转 file://
    img.src = /^data:/.test(f.path) ? f.path : toFileUrl(f.path);
    img.alt = '';
    // 缩略图加载失败时退回扩展名标签
    img.onerror = () => { icon.textContent = (ext || 'IMG').toUpperCase().slice(0, 4); };
    icon.appendChild(img);
  } else {
    icon.textContent = (ext || 'FILE').toUpperCase().slice(0, 4);
  }

  const meta = document.createElement('div');
  meta.className = 'ac-meta';
  const name = document.createElement('div');
  name.className = 'ac-name';
  name.textContent = f.name || f.path || '文件';
  name.title = f.name || f.path || '';
  meta.appendChild(name);
  if (f.size) {
    const size = document.createElement('div');
    size.className = 'ac-size';
    size.textContent = fmtSize(f.size);
    meta.appendChild(size);
  }

  chip.appendChild(icon);
  chip.appendChild(meta);
  return chip;
}

// 渲染输入区待发送附件(可删除)
function renderAttachments() {
  attachmentsEl.innerHTML = '';
  if (!attachedFiles.length) {
    attachmentsEl.classList.add('hidden');
    return;
  }
  attachmentsEl.classList.remove('hidden');
  attachedFiles.forEach((f, idx) => {
    const chip = buildChipEl(f);
    const del = document.createElement('button');
    del.className = 'ac-del';
    del.textContent = '×';
    del.title = '移除';
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

function addFiles(list) {
  for (const f of (list || [])) {
    if (!f || !f.path) continue;
    if (attachedFiles.some((x) => x.path === f.path)) continue;  // 去重
    attachedFiles.push(f);
  }
  renderAttachments();
}

// 点击 + 选择文件
btnAttach.addEventListener('click', async () => {
  const files = await window.api.openFileDialog();
  if (files && files.length) addFiles(files);
});

// 工作目录按钮:弹目录选择(点击即可更换;用默认目录则新建对话)
$('btnWorkdir').addEventListener('click', () => pickWorkingDir());

// 技能按钮:读取本地 ~/.claude/skills，选择后作为下一条消息的显式技能调用。
if (btnSkillQuick) {
  btnSkillQuick.addEventListener('click', (e) => {
    e.stopPropagation();
    if (skillQuickPopup && skillQuickPopup.classList.contains('show')) hideSkillQuickPopup();
    else showSkillQuickPopup();
  });
}
if (skillQuickClear) {
  skillQuickClear.addEventListener('click', (e) => {
    e.stopPropagation();
    setSelectedQuickSkill(null);
    hideSkillQuickPopup();
    inputEl.focus();
  });
}
document.addEventListener('click', (e) => {
  if (skillQuickPopup && skillQuickPopup.classList.contains('show') &&
      !skillQuickPopup.contains(e.target) && !(btnSkillQuick && btnSkillQuick.contains(e.target))) {
    hideSkillQuickPopup();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && skillQuickPopup && skillQuickPopup.classList.contains('show')) {
    hideSkillQuickPopup();
  }
});
window.addEventListener('resize', () => {
  if (skillQuickPopup && skillQuickPopup.classList.contains('show')) positionSkillQuickPopup();
});

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
  const imgs = imagesFromClipboard(e);
  // 没有 DOM 图片项:尝试原生剪贴板兜底。拿到就拦截默认粘贴并落盘;拿不到就放行(纯文本照常)。
  if (!imgs.length) {
    let nativeUrl = null;
    try { const r = await window.api.image.readClipboardImage(); if (r && r.ok && r.dataUrl) nativeUrl = r.dataUrl; } catch (_) {}
    if (!nativeUrl) return;
    e.preventDefault();
    await savePastedDataUrlToChat(nativeUrl, 0);
    return;
  }
  e.preventDefault();                // 有图片:拦下,避免把二进制塞进 textarea
  for (const file of imgs) {
    try { await savePastedDataUrlToChat(await fileToDataUrl(file), file.size); }
    catch (_) { /* 单张失败忽略,不影响其它 */ }
  }
});
// 把一张粘贴图片(dataURL)落盘并加入对话附件
async function savePastedDataUrlToChat(dataUrl, size) {
  try {
    const r = await window.api.image.savePaste({ dataUrl });
    if (r && r.ok && r.path) {
      addFiles([{ path: r.path, name: r.name || '粘贴的图片.png',
                  ext: (r.path.split('.').pop() || 'png').toLowerCase(), size: size || 0 }]);
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

// Markdown 链接统一接管：外链交给系统浏览器；记忆索引的相对 .md 链接打开记忆详情；
// 其它相对/本地链接不允许替换 Relay 主页面。
document.addEventListener('click', (e) => {
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
    window.api.openExternal(href);
    return;
  }
  if (href.startsWith('#')) return;
  e.preventDefault();
});

// ─────────────────────────────────────────
// 模型档位切换(豆包式:快速 / 思考 / 专家)
//   快速=haiku(MiMo) · 思考=sonnet · 专家=opus
// ─────────────────────────────────────────
// 图标统一为细描边线性风格(stroke 1.8 / 圆角 / currentColor),与工具栏一致
const MODEL_TIERS = [
  {
    value: 'haiku',
    label: '快速',
    desc: '适用于大部分情况',
    // 闪电(描边)
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  },
  {
    value: 'sonnet',
    label: '思考',
    desc: '擅长解决更难的问题',
    // 灯泡(描边)
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.5 14.5A5.5 5.5 0 1 0 8.5 14.5c.7.6 1.2 1.3 1.4 2.2h4.2c.2-.9.7-1.6 1.4-2.2z"/></svg>',
  },
  {
    value: 'opus',
    label: '专家',
    desc: '研究级智能模型',
    // 原子(描边):中心原子核 + 三条均匀分布(0°/60°/120°)的电子轨道,径向对称、是通用的原子符号写法
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  },
];

function currentTier() {
  return MODEL_TIERS.find((t) => t.value === currentModel) || MODEL_TIERS[0];
}
function updateModelSwitchUI() {
  const t = currentTier();
  if (msIco)   msIco.innerHTML = t.icon;
  if (msLabel) msLabel.textContent = t.label;
}

// 模型切换器只在「新对话」(plain)显示;「Agent」模式隐藏 = 锁定模型
function updateComposerForMode() {
  const ms = $('modelSwitch');
  if (ms) ms.style.display = '';   // Agent 模式也允许切换模型(与新对话一致)
  hideModelPopup();
}

let modelPopup = null;
function ensureModelPopup() {
  if (modelPopup) return modelPopup;
  modelPopup = document.createElement('div');
  modelPopup.className = 'model-popup';
  document.body.appendChild(modelPopup);
  return modelPopup;
}
function renderModelPopup() {
  const pop = ensureModelPopup();
  pop.innerHTML = '';
  MODEL_TIERS.forEach((t) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mp-row' + (t.value === currentModel ? ' selected' : '');
    row.innerHTML = `
      <span class="mp-ico">${t.icon}</span>
      <span class="mp-meta">
        <span class="mp-title">${t.label}</span>
        <span class="mp-desc">${t.desc}</span>
      </span>
      <svg class="mp-check" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      currentModel = t.value;
      if (currentConv) currentConv.model = currentModel;  // 记到当前会话
      updateModelSwitchUI();
      hideModelPopup();
    });
    pop.appendChild(row);
  });
}
function showModelPopup() {
  hideSkillQuickPopup();
  renderModelPopup();
  const pop = ensureModelPopup();
  // 向上弹出,左对齐触发按钮(用 fixed 脱离 input-card 的 overflow:hidden 裁剪)
  const r = btnModelSwitch.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = `${r.left}px`;
  pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  pop.classList.add('show');
  btnModelSwitch.classList.add('open');
}
function hideModelPopup() {
  if (modelPopup) modelPopup.classList.remove('show');
  btnModelSwitch.classList.remove('open');
}

btnModelSwitch.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelPopup && modelPopup.classList.contains('show')) hideModelPopup();
  else showModelPopup();
});
document.addEventListener('click', (e) => {
  if (modelPopup && modelPopup.classList.contains('show') &&
      !modelPopup.contains(e.target) && !btnModelSwitch.contains(e.target)) {
    hideModelPopup();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideModelPopup(); });

$('btnNewChat').addEventListener('click',     () => startNewConv('plain'));
$('btnNewAnalysis').addEventListener('click', () => openAgentPicker());
if ($('btnTeam')) $('btnTeam').addEventListener('click', () => openTeamPicker());

// ─── 顶部小工具栏 ───
$('btnHeaderNewChat').addEventListener('click',     () => startNewConv('plain'));
$('btnHeaderNewAnalysis').addEventListener('click', () => openAgentPicker());

// ─────────────────────────────────────────
// AI 创作(文生图)视图
// ─────────────────────────────────────────
const chatViewEl   = document.querySelector('main.chat');
const createViewEl  = $('createView');
const btnCreateNav  = $('btnCreate');
let imageConfigLoaded = false;

// 当前所在视图,用于历史侧边栏高亮哪条会话(避免聊天/创作的 active 互相串台)
let activeView = 'chat';   // 'chat' | 'create'

// 视图切换:聊天 ↔ 创作
function showChatView() {
  activeView = 'chat';
  if (createViewEl) createViewEl.classList.add('hidden');
  if (chatViewEl)   chatViewEl.classList.remove('hidden');
  if (btnCreateNav) btnCreateNav.classList.remove('active');
}
// 仅切到创作视图(不动会话)。fresh=true 时开一个新创作会话并清空消息区。
async function showCreateView(fresh = false) {
  activeView = 'create';
  if (chatViewEl)   chatViewEl.classList.add('hidden');
  if (createViewEl) createViewEl.classList.remove('hidden');
  // 侧边栏顶部入口高亮:与「新对话」一致——进入创作视图不点亮「AI 创作」入口(不置灰),
  // 仅清掉其它入口的高亮即可。
  document.querySelectorAll('.nav-item.active').forEach((el) => el.classList.remove('active'));
  if (!imageConfigLoaded) { await loadImageModels(); imageConfigLoaded = true; }
  if (fresh) {
    newCreateConv();
    cvRefImages = []; cvRenderRef();
    cvMessagesEl.innerHTML = '<div class="welcome"><h2>🎨 AI 创作</h2><p>描述你想要的图片，点「生成」即可。<br/>同一会话里可继续描述，在上一张图基础上调整。</p></div>';
    refreshHistoryList();
  }
}
// 点侧边栏「AI 创作」= 开新创作会话
if (btnCreateNav) btnCreateNav.addEventListener('click', () => showCreateView(true));

// 从历史载入一个创作会话:重建消息流(用户描述气泡 + 结果图网格)
// jumpTo(可选):{ turnIndex } —— 从搜索结果跳转时滚动到命中的那轮提示词并高亮。
async function loadCreateConv(id, jumpTo = null) {
  const conv = await window.api.history.load(id);
  if (!conv) return;
  currentCreateConv = conv;
  if (!Array.isArray(currentCreateConv.turns)) currentCreateConv.turns = [];
  await showCreateView(false);   // 切到创作视图但不新建
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
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('search-hit');
        setTimeout(() => target.classList.remove('search-hit'), 2000);
      });
    }
  }
  if (!cvJumped) cvMessagesEl.scrollTop = cvMessagesEl.scrollHeight;
  cvSyncGenerateBtn();
  refreshHistoryList();
}
if ($('btnToggleSidebar2')) $('btnToggleSidebar2').addEventListener('click', () => {
  document.querySelector('.app').classList.toggle('sidebar-collapsed');
});

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
        }
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
      // 只保留功能性状态提示(待接入/不支持参考图),去掉介绍性副标题
      const desc = !m.ok ? '待接入' : (blockedByRef ? '不支持参考图' : '');
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
  if (firstOk && !cvModelValue) cvModelValue = firstOk.name;
  cvResetQualityForModel();   // 先定画质档(默认),豆包据此展开比例
  cvResetSizeForModel();      // 按当前模型 + 画质档定下默认比例
  if (cvModelDD) cvModelDD.refresh();
  if (cvQualityDD) cvQualityDD.refresh();
  if (cvSizeDD) cvSizeDD.refresh();
}

// 生成按钮
const btnGenerate = $('btnGenerate');
if (btnGenerate) btnGenerate.addEventListener('click', generateImages);
// Ctrl/Cmd+Enter 在 prompt 框里也触发生成
if ($('cvPrompt')) $('cvPrompt').addEventListener('keydown', (e) => {
  // 与新对话一致:Enter 发送,Shift+Enter 换行(输入法组合中的回车不触发)
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); generateImages(); }
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
function cvLastResultPath() {
  if (!currentCreateConv || !currentCreateConv.turns.length) return null;
  for (let i = currentCreateConv.turns.length - 1; i >= 0; i--) {
    const t = currentCreateConv.turns[i];
    if (t.resultPaths && t.resultPaths.length) return t.resultPaths[t.resultPaths.length - 1];
  }
  return null;
}
// 保存创作会话到历史(复用聊天的 history 机制)
async function saveCreateConv() {
  if (!currentCreateConv) return;
  const saved = await window.api.history.save(currentCreateConv);
  if (saved && saved.id) currentCreateConv.id = saved.id;
  if (saved && saved.updatedAt) currentCreateConv.updatedAt = saved.updatedAt;
  await refreshHistoryList();
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
// 是否支持参考图:豆包(volcengine_maas)走图生图,GPT(azure_openai)走图片编辑(/images/edits),两者都支持。
function cvModelSupportsRef(m) { return /^(volcengine_maas|azure_openai)\//i.test(m.name); }
// 是否支持多图融合(2+ 张参考图):仅豆包。GPT 编辑只取第一张。
function cvModelSupportsMultiRef(m) { return /^volcengine_maas\//i.test(m.name); }

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

// 进行中的创作生成任务:convId → true。支持后台生成 + 多会话并发(和新对话/Agent 一致)。
const cvJobs = new Map();
function cvIsRunning(convId) { return convId != null && cvJobs.has(convId); }

// 同步生成按钮的禁用态:仅当"当前所看的创作会话"正在生成时才禁用
function cvSyncGenerateBtn() {
  if (!btnGenerate) return;
  const cur = currentCreateConv && currentCreateConv.id;
  btnGenerate.disabled = cvIsRunning(cur);
}

async function generateImages() {
  const promptEl = $('cvPrompt');
  const prompt = (promptEl.value || '').trim();
  if (!prompt) { promptEl.focus(); return; }
  const model = cvModelValue;
  const size  = cvSizeValue;
  const n     = cvCountValue;

  if (!currentCreateConv) newCreateConv();   // 没有会话则新建
  // 同一会话正在生成时,不重复提交(不同会话可并发)
  if (currentCreateConv.id && cvIsRunning(currentCreateConv.id)) return;

  // 清掉欢迎页
  const welcome = cvMessagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  // 用户手动上传的参考图:先落盘拿到本地路径(用于在气泡上方展示 + 持久化到历史)。
  //   只针对手动上传的图;下面"自动取上一张结果当参考"那种隐式上下文不在此展示。
  //   落盘失败不阻断生成,顶多这条不显示参考图缩略。
  const manualRefDataUrls = cvRefImages.map((r) => r.dataUrl);
  const refPaths = [];
  for (const du of manualRefDataUrls) {
    try { const r = await window.api.image.saveRef({ dataUrl: du }); if (r && r.ok && r.path) refPaths.push(r.path); }
    catch (_) {}
  }

  // 1) 用户气泡(若有手动参考图,先在气泡上方展示缩略图,与普通对话上传图一致)
  const userMsg = document.createElement('div');
  userMsg.className = 'message user';
  if (refPaths.length) userMsg.appendChild(buildImageGrid(refPaths));
  const ub = document.createElement('div');
  ub.className = 'bubble';
  ub.textContent = prompt;
  userMsg.appendChild(ub);
  cvMessagesEl.appendChild(userMsg);

  // 组图意图:从提示词自动判断(仅豆包支持组图)。命中即一次出一组关联图。
  //   一旦判为组图,就视作"新起一组系列",不再走"基于上一张迭代"那条参考图逻辑(下面据此跳过自动取上一张)。
  const wantsGroup = cvPromptWantsGroup(prompt) && cvModelSupportsMultiRef({ name: model });

  // 2) loading 占位(挂一个稳定标记,回填/重渲染时能找回)
  //   组图优先级最高;否则若在基于上一张迭代则显示"调整中";再否则普通"生成 N 张"。
  const iterating = !wantsGroup && !cvRefImages.length && !!cvLastResultPath() && cvModelSupportsRef({ name: model });
  const loadingMsg = document.createElement('div');
  loadingMsg.className = 'message assistant cv-result-msg cv-loading-msg';
  const loadingText = wantsGroup ? '正在生成一组图片，请稍候…' : (iterating ? '正在基于上一张图调整…' : '正在生成 ' + n + ' 张图片，请稍候…');
  loadingMsg.innerHTML = `<div class="cv-loading"><div class="cv-spinner"></div><div>${loadingText}</div></div>`;
  cvMessagesEl.appendChild(loadingMsg);
  cvMessagesEl.scrollTop = cvMessagesEl.scrollHeight;

  promptEl.value = '';
  autoGrowCvPrompt();

  // 决定参考图:① 用户手动上传的优先(支持多张,豆包多图融合);② 否则同会话上下文迭代——自动拿上一张结果
  //   多图仅豆包支持;若当前模型不支持多图(GPT),只取第一张。
  let refList = cvRefImages.map((r) => r.dataUrl);
  if (refList.length > 1 && !cvModelSupportsMultiRef({ name: model })) refList = refList.slice(0, 1);
  let usedRef = refList.length > 0;
  // 组图模式下不自动取上一张结果作参考(组图是"新起一组系列",非"改上一张")。
  //   用户若手动上传了参考图则尊重(refList 已非空,上面不会进这里)。
  if (!wantsGroup && !refList.length && cvModelSupportsRef({ name: model })) {
    const last = cvLastResultPath();
    if (last) {
      try { const r = await window.api.image.toDataUrl(last); if (r && r.ok) { refList = [r.dataUrl]; usedRef = true; } } catch (_) {}
    }
  }
  // 传给后端:0 张→不传;1 张→string;多张→array
  const refImage = refList.length === 0 ? null : (refList.length === 1 ? refList[0] : refList);
  cvRefImages = []; cvRenderRef();   // 提交即清掉手动参考图(已取出)

  // 与新对话一致:提交即先把本轮(空结果占位)写入会话并入历史侧边栏
  //   refPaths:手动上传的参考图本地路径,持久化以便历史重载时仍能展示(只存路径不存 base64)。
  const turn = { prompt, model, size, resultPaths: [], usedRef, refPaths };
  currentCreateConv.turns.push(turn);
  const isFirstTurn = currentCreateConv.turns.length === 1;
  if (!currentCreateConv.title) currentCreateConv.title = prompt.slice(0, 30);
  await saveCreateConv();
  if (isFirstTurn && !currentCreateConv.titleGenerated) maybeTitleCreateConv(prompt);

  // 标记本会话进入"生成中"(支持后台:即便用户切走,任务继续,完成后按 id 写回)
  const convId = currentCreateConv.id;
  const turnIndex = currentCreateConv.turns.length - 1;   // 本轮在 turns 里的下标(用于按 id+下标 回填,避免对象引用失效)
  cvJobs.set(convId, true);
  cvSyncGenerateBtn();
  refreshHistoryList();   // 侧边栏给这个会话亮起 running 指示

  // 组图开关 = 上面据提示词自动判断的 wantsGroup(仅豆包)。把张数上限提到 CV_GROUP_MAX
  //   (实际张数由模型 sequential auto 决定);常规仍为 n(=1)。
  const effN = wantsGroup ? CV_GROUP_MAX : n;
  // 画质(分辨率档)已经体现在 size 像素值里:豆包直接用大尺寸,GPT 由后端按 size 反推 quality。
  //   故这里只传 size,不再单独传 quality。
  let res;
  try { res = await window.api.image.generate({ prompt, model, size, n: effN, image: refImage, sequential: wantsGroup }); }
  catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }

  cvJobs.delete(convId);

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
    await loadCreateConv(convId);
  }

  cvSyncGenerateBtn();
  refreshHistoryList();   // 关掉侧边栏 running 指示
}

// 给创作会话生成简短标题(复用聊天的快模型摘要)。按 id 找回写入,避免切走后写错。
async function maybeTitleCreateConv(firstPrompt) {
  if (!currentCreateConv || currentCreateConv.titleGenerated) return;
  currentCreateConv.titleGenerated = true;
  const convId = currentCreateConv.id;
  try {
    const res = await window.api.summarizeTitle('用户想生成的图片:' + firstPrompt);
    const t = (res && res.title || '').trim();
    if (!t) return;
    // 始终从磁盘读回再只改 title 字段后存盘,避免与结果回填(cvFinishTurn)互相覆盖
    const conv = await window.api.history.load(convId);
    if (conv && !conv.titleManual) {   // 等待摘要期间用户手动重命名了 → 手动命名优先
      conv.title = t; conv.titleGenerated = true;
      await window.api.history.save(conv);
      if (currentCreateConv && currentCreateConv.id === convId) currentCreateConv.title = t;  // 同步内存
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

// ── 库:汇总本地生成的图片与文件(参考 GPT 资料库;复用 preview-overlay 弹窗外壳) ──
let myWorkEl = null;
const libState = { tab: 'images', fileType: 'all', fileView: 'list' };   // 当前页签/筛选/视图

// 文件类型 → 图标(描边线性,与整体一致)
const LIB_FILE_ICONS = {
  pdf:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  document:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
  spreadsheet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/></svg>',
  presentation:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="12" y1="16" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></svg>',
  image:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L7 20"/></svg>',
  code:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  other:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};
function libFileIcon(type) { return LIB_FILE_ICONS[type] || LIB_FILE_ICONS.other; }
function libFmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function libFmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms); if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

let libImagesCache = null, libFilesCache = null;   // 本次打开期间缓存,切页签不重复拉取

async function openMyWork() {
  if (!myWorkEl) {
    myWorkEl = document.createElement('div');
    myWorkEl.className = 'preview-overlay mywork-overlay';
    myWorkEl.innerHTML = `
      <div class="preview-box">
        <div class="preview-head">
          <div class="preview-title">资料库</div>
          <button class="preview-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="lib-toolbar">
          <div class="lib-tabs">
            <button class="lib-tab" data-tab="images">图片</button>
            <button class="lib-tab" data-tab="files">文件</button>
          </div>
          <div class="lib-controls"></div>
        </div>
        <div class="preview-body mywork-body"></div>
      </div>
    `;
    document.body.appendChild(myWorkEl);
    bindTransientScrollbar(myWorkEl.querySelector('.mywork-body'));
    myWorkEl.addEventListener('click', (e) => { if (e.target === myWorkEl) closeMyWork(); });
    myWorkEl.querySelector('.preview-close').addEventListener('click', closeMyWork);
    myWorkEl.querySelectorAll('.lib-tab').forEach((b) => {
      b.addEventListener('click', () => { libState.tab = b.dataset.tab; renderLibrary(); });
    });
  }
  libImagesCache = null; libFilesCache = null;   // 每次打开重新拉取
  myWorkEl.classList.add('show');
  renderLibrary();
}

async function renderLibrary() {
  if (!myWorkEl) return;
  // 页签高亮
  myWorkEl.querySelectorAll('.lib-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === libState.tab));
  const body = myWorkEl.querySelector('.mywork-body');
  const controls = myWorkEl.querySelector('.lib-controls');
  body.innerHTML = `<div class="cv-loading cv-loading-fill"><div class="cv-spinner"></div><div>加载中…</div></div>`;

  if (libState.tab === 'images') {
    // 图片页右侧:打开图片库文件夹(generated_images)
    controls.innerHTML = `<button class="lib-openbtn" id="libOpenImagesDir">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
      <span>打开图片文件夹</span>
    </button>`;
    const openBtn = myWorkEl.querySelector('#libOpenImagesDir');
    if (openBtn) openBtn.addEventListener('click', () => window.api.library.openImagesDir());
    if (!libImagesCache) {
      try { const r = await window.api.library.listImages(); libImagesCache = (r && r.ok) ? r.items : []; }
      catch { libImagesCache = []; }
    }
    if (libState.tab !== 'images') return;   // 期间切走了
    if (!libImagesCache.length) { body.innerHTML = `<div class="cv-empty">还没有生成的图片。去「AI 创作」生成，或让对话产出图片。</div>`; return; }
    body.innerHTML = '';
    body.appendChild(buildImageGrid(libImagesCache.map((it) => it.path), ''));
    return;
  }

  // 文件页:类型筛选 + 列表/网格视图切换
  if (libState.fileType === 'image') libState.fileType = 'all';   // 图片筛选已移除,兜底复位
  controls.innerHTML = `
    <div class="lib-filter" id="libFilter">
      ${[['all','全部'],['code','代码'],['document','文档'],['spreadsheet','表格'],['presentation','PPT'],['pdf','PDF']]
        .map(([v, l]) => `<button class="lib-chip ${libState.fileType === v ? 'active' : ''}" data-ft="${v}">${l}</button>`).join('')}
    </div>
    <div class="lib-view-toggle">
      <button class="lib-vbtn ${libState.fileView === 'grid' ? 'active' : ''}" data-view="grid" title="网格视图"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></button>
      <button class="lib-vbtn ${libState.fileView === 'list' ? 'active' : ''}" data-view="list" title="列表视图"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.5" y2="6"/><line x1="3.5" y1="12" x2="3.5" y2="12"/><line x1="3.5" y1="18" x2="3.5" y2="18"/></svg></button>
    </div>`;
  controls.querySelectorAll('.lib-chip').forEach((b) => b.addEventListener('click', () => { libState.fileType = b.dataset.ft; renderLibrary(); }));
  controls.querySelectorAll('.lib-vbtn').forEach((b) => b.addEventListener('click', () => { libState.fileView = b.dataset.view; renderLibrary(); }));

  if (!libFilesCache) {
    try { const r = await window.api.library.listFiles(); libFilesCache = (r && r.ok) ? r.items : []; }
    catch { libFilesCache = []; }
  }
  if (libState.tab !== 'files') return;
  let items = libFilesCache;
  if (libState.fileType !== 'all') items = items.filter((it) => it.type === libState.fileType);
  if (!items.length) {
    body.innerHTML = `<div class="cv-empty">${libFilesCache.length ? '该类型暂无文件。' : '还没有生成的文件。让对话里的 LLM 写出文件(代码/文档等),就会在这里汇总。'}</div>`;
    return;
  }
  body.innerHTML = '';
  body.appendChild(libState.fileView === 'grid' ? buildLibFileGrid(items) : buildLibFileList(items));
}

// 右键文件 → 弹「删除」(复用复制气泡的 .copy-popover 外壳)
function showLibFileMenu(e, it) {
  e.preventDefault();
  e.stopPropagation();   // 阻止冒泡到 document 的 contextmenu 处理(否则它会立刻 hideCopyPopover)
  const pop = ensureCopyPopover();
  const copyBtn = pop.querySelector('.cp-btn:not(.cp-del)');
  const delBtn  = pop.querySelector('.cp-del');
  // 复制按钮在这里复用为「打开」
  copyBtn.querySelector('span').textContent = '打开';
  const kbd = copyBtn.querySelector('kbd'); if (kbd) kbd.style.display = 'none';
  copyBtn.onclick = () => { window.api.library.openFile(it.path); hideCopyPopover(); };
  delBtn.hidden = false;
  delBtn.onclick = async () => {
    hideCopyPopover();
    const ok = await customConfirm({
      title: '删除文件',
      message: `将删除本地文件「${it.name}」，无法恢复。确定删除吗？`,
      confirmText: '删除', cancelText: '取消', danger: true,
    });
    if (!ok) return;
    const r = await window.api.library.deleteFile(it.path);
    if (r && r.ok) {
      if (libFilesCache) libFilesCache = libFilesCache.filter((x) => x.path !== it.path);   // 从缓存移除
      renderLibrary();   // 重渲染当前筛选/视图
      showToast('已删除');
    } else { showToast('删除失败' + (r && r.error ? '：' + r.error : '')); }
  };
  let ix = e.clientX, iy = e.clientY + 6;
  if (ix + 148 > window.innerWidth)  ix = window.innerWidth - 156;
  if (iy + 78 > window.innerHeight)  iy = e.clientY - 84;
  pop.style.left = ix + 'px'; pop.style.top = iy + 'px';
  pop.classList.add('show');
}

// 文件列表视图(名称 / 修改时间 / 大小)
function buildLibFileList(items) {
  const wrap = document.createElement('div');
  wrap.className = 'lib-list';
  wrap.innerHTML = `<div class="lib-list-head"><span class="lc-name">名称</span><span class="lc-time">已修改</span><span class="lc-size">大小</span></div>`;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'lib-list-row';
    row.innerHTML = `<span class="lc-name"><span class="lc-ico">${libFileIcon(it.type)}</span><span class="lc-text" title="${escapeAttr(it.path)}">${escapeHtml(it.name)}</span></span><span class="lc-time">${libFmtTime(it.mtime)}</span><span class="lc-size">${libFmtSize(it.size)}</span>`;
    row.addEventListener('click', () => window.api.library.openFile(it.path));
    row.addEventListener('contextmenu', (e) => showLibFileMenu(e, it));
    wrap.appendChild(row);
  }
  return wrap;
}
// 文件网格视图(大图标 + 名称)
function buildLibFileGrid(items) {
  const grid = document.createElement('div');
  grid.className = 'lib-grid';
  for (const it of items) {
    const cell = document.createElement('div');
    cell.className = 'lib-cell';
    cell.title = it.path;
    // 图片类用真实缩略图,其它用类型图标
    const thumb = it.type === 'image'
      ? `<img src="${toFileUrl(it.path)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'lib-cell-ico',innerHTML:'${libFileIcon('image').replace(/'/g, "\\'")}'}))" />`
      : `<div class="lib-cell-ico">${libFileIcon(it.type)}</div>`;
    cell.innerHTML = `<div class="lib-cell-thumb">${thumb}</div><div class="lib-cell-name" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</div>`;
    cell.addEventListener('click', () => window.api.library.openFile(it.path));
    cell.addEventListener('contextmenu', (e) => showLibFileMenu(e, it));
    grid.appendChild(cell);
  }
  return grid;
}

function closeMyWork() { if (myWorkEl) myWorkEl.classList.remove('show'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && myWorkEl && myWorkEl.classList.contains('show')) closeMyWork();
});
if ($('btnMyWork')) $('btnMyWork').addEventListener('click', openMyWork);
if ($('btnMyWorkChat')) $('btnMyWorkChat').addEventListener('click', openMyWork);   // 聊天视图顶栏的「库」

// 创作页顶部栏按钮:与新对话一致(新对话 / Agent / 设置)。图像 API 设置已融入设置弹窗。
if ($('cvHeaderNewChat'))     $('cvHeaderNewChat').addEventListener('click', () => startNewConv('plain'));
if ($('cvHeaderNewAnalysis')) $('cvHeaderNewAnalysis').addEventListener('click', () => openAgentPicker());
if ($('cvBtnSettings'))       $('cvBtnSettings').addEventListener('click', openSettings);

// ─────────────────────────────────────────
// Agent 选择器:列出 ~/.claude/agents 里已安装的子智能体,选中后进入该 Agent 对话
// ─────────────────────────────────────────
async function openAgentPicker() {
  let res;
  try { res = await window.api.data.listAgents(); } catch { res = null; }
  const items = (res && res.items) || [];
  if (!items.length) {
    // 没装任何 Agent → 提示去设置导入
    const go = await customConfirm({
      title: '还没有 Agent',
      message: '你还没有导入任何 Agent。是否前往「设置 → Agent 目录」导入一个 Agent 包(.zip)？',
      confirmText: '去导入', cancelText: '取消',
    });
    if (go) { openSettings(); setTimeout(() => loadSettingsForm('agent'), 50); }
    return;
  }
  showAgentPicker(items);
}

let agentPickerEl = null;
function showAgentPicker(items) {
  if (!agentPickerEl) {
    agentPickerEl = document.createElement('div');
    agentPickerEl.className = 'agent-picker-overlay';
    agentPickerEl.innerHTML = `
      <div class="agent-picker">
        <div class="ap-head">
          <div class="ap-title">选择一个 Agent</div>
          <button class="ap-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="ap-list"></div>
        <div class="ap-foot">
          <button class="ap-import">＋ 导入新的 Agent</button>
        </div>
      </div>
    `;
    document.body.appendChild(agentPickerEl);
    agentPickerEl.addEventListener('click', (e) => { if (e.target === agentPickerEl) hideAgentPicker(); });
    agentPickerEl.querySelector('.ap-close').addEventListener('click', hideAgentPicker);
    agentPickerEl.querySelector('.ap-import').addEventListener('click', () => {
      hideAgentPicker(); openSettings(); setTimeout(() => loadSettingsForm('agent'), 50);
    });
  }
  const list = agentPickerEl.querySelector('.ap-list');
  list.innerHTML = '';
  items.forEach((it) => {
    const row = document.createElement('button');
    row.className = 'ap-item';
    // 头像:与协同群聊一致的 DiceBear bottts(种子=agent 真实名),圆形
    const avatar = (window.AgentAvatar) ? window.AgentAvatar.dataUri(it.name) : '';
    row.innerHTML = `
      <img class="ap-ico ap-avatar" alt="" src="${avatar}">
      <span class="ap-meta">
        <span class="ap-name"></span>
        <span class="ap-desc"></span>
      </span>
    `;
    const label = it.displayName || it.name;
    row.querySelector('.ap-name').textContent = label;
    // 自定义名与真实 id 不同时,副信息里标注真实 id,便于辨认
    const idHint = (label !== it.name) ? `${it.name} · ` : '';
    row.querySelector('.ap-desc').textContent = idHint + (it.desc || '');
    row.addEventListener('click', () => {
      hideAgentPicker();
      startNewConv('agent', it.name, label);
    });
    list.appendChild(row);
  });
  agentPickerEl.classList.add('show');
}
function hideAgentPicker() { if (agentPickerEl) agentPickerEl.classList.remove('show'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && agentPickerEl && agentPickerEl.classList.contains('show')) hideAgentPicker();
});

// ─────────────────────────────────────────
// 协同(多 Agent)选队:复用同一批已装 agent,多选;留空=全量交 PM 调度。
//   选完进 mode='orchestrate' 群聊式对话。
// ─────────────────────────────────────────
async function openTeamPicker() {
  let res;
  try { res = await window.api.data.listAgents(); } catch { res = null; }
  const items = (res && res.items) || [];
  if (!items.length) {
    const go = await customConfirm({
      title: '还没有 Agent',
      message: '协奏需要先导入至少一个 Agent。是否前往「设置 → Agent 目录」导入 Agent 包(.zip)？',
      confirmText: '去导入', cancelText: '取消',
    });
    if (go) { openSettings(); setTimeout(() => loadSettingsForm('agent'), 50); }
    return;
  }
  showTeamPicker(items);
}

let teamPickerEl = null;
function showTeamPicker(items) {
  const selected = new Set();   // 勾选的 agent.name;空 = 全量交 PM
  if (!teamPickerEl) {
    teamPickerEl = document.createElement('div');
    teamPickerEl.className = 'agent-picker-overlay team-picker-overlay';
    teamPickerEl.innerHTML = `
      <div class="agent-picker team-picker">
        <div class="ap-head ap-head-col">
          <div class="ap-title">组建协奏团队</div>
          <div class="ap-subtitle">勾选参与的 Agent，留空则由 PM 全权调度</div>
          <button class="ap-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="ap-list"></div>
        <div class="ap-foot tp-foot">
          <button class="tp-start">开始协奏</button>
        </div>
      </div>
    `;
    document.body.appendChild(teamPickerEl);
    teamPickerEl.addEventListener('click', (e) => { if (e.target === teamPickerEl) hideTeamPicker(); });
    teamPickerEl.querySelector('.ap-close').addEventListener('click', hideTeamPicker);
  }
  const startBtn = teamPickerEl.querySelector('.tp-start');
  // 按钮文案固定「开始协奏」(勾选数量/PM 全权/箭头都不缀,保持简洁)
  const syncStartLabel = () => { startBtn.textContent = '开始协奏'; };
  const list = teamPickerEl.querySelector('.ap-list');
  list.innerHTML = '';
  items.forEach((it) => {
    const row = document.createElement('button');
    row.className = 'ap-item tp-item';
    row.type = 'button';
    const label = it.displayName || it.name;
    const idHint = (label !== it.name) ? `${it.name} · ` : '';
    const avatar = (window.AgentAvatar) ? window.AgentAvatar.dataUri(it.name) : '';
    row.innerHTML = `
      <img class="tp-avatar" alt="" src="${avatar}">
      <span class="ap-meta">
        <span class="ap-name"></span>
        <span class="ap-desc"></span>
      </span>
      <span class="tp-check" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    row.querySelector('.ap-name').textContent = label;
    row.querySelector('.ap-desc').textContent = idHint + (it.desc || '');
    row.addEventListener('click', () => {
      if (selected.has(it.name)) { selected.delete(it.name); row.classList.remove('checked'); }
      else { selected.add(it.name); row.classList.add('checked'); }
      syncStartLabel();
    });
    list.appendChild(row);
  });
  syncStartLabel();
  // 重新绑定开始按钮(每次 show 时 selected 是新的闭包)
  const newStart = startBtn.cloneNode(true);
  startBtn.parentNode.replaceChild(newStart, startBtn);
  newStart.addEventListener('click', () => {
    const picked = Array.from(selected);
    hideTeamPicker();
    startNewConv('orchestrate', null, null, picked.length ? picked : null);
  });
  teamPickerEl.classList.add('show');
}
function hideTeamPicker() { if (teamPickerEl) teamPickerEl.classList.remove('show'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && teamPickerEl && teamPickerEl.classList.contains('show')) hideTeamPicker();
});

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
  const input = searchEl.querySelector('.search-input');
  input.value = '';
  searchEl.querySelector('[data-results]').innerHTML = `<div class="search-empty">输入关键词搜索你的历史对话</div>`;
  setTimeout(() => input.focus(), 30);
}
function hideSearchModal() { if (searchEl) searchEl.classList.remove('show'); }
$('btnSearch').addEventListener('click', showSearchModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchEl && searchEl.classList.contains('show')) { hideSearchModal(); return; }
  // Ctrl+K / Cmd+K 打开搜索(主流应用通用)
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); showSearchModal(); }
});

$('btnToggleSidebar').addEventListener('click', () => {
  document.querySelector('.app').classList.toggle('sidebar-collapsed');
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
let lastSettingsCat = 'personalize'; // 进入全屏子面板前所在的一级菜单(子面板「返回」回到它)
let activeSettingsBackHandler = null;
let settingsViewSnapshot = null;
let skillOverviewCache = null;       // 跨设置窗口保留最近一次完整技能列表
let skillPanelConfigCache = null;    // 自动提炼/体检模型的最近快照
let skillUsageUpdateOff = null;      // 主进程增量索引完成通知，只保留一个监听器

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
    saveHandler: activeSaveHandler,
    backHandler: activeSettingsBackHandler,
    hint: modalHint.textContent,
  };
  while (modalBody.firstChild) fragment.appendChild(modalBody.firstChild);
}

function restoreSettingsView() {
  const snapshot = settingsViewSnapshot;
  if (!snapshot) return false;
  settingsViewSnapshot = null;
  modalBody.replaceChildren(snapshot.fragment);
  modalBody.scrollTop = snapshot.modalScrollTop;
  activeSaveHandler = snapshot.saveHandler;
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = snapshot.saveDisplay;
  setSettingsBackAction(snapshot.backHandler);
  modalHint.textContent = snapshot.hint;
  const content = $('setContent');
  if (content) requestAnimationFrame(() => { content.scrollTop = snapshot.contentScrollTop; });
  return true;
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

function openSettings() {
  modal.classList.remove('hidden');
  loadSettingsForm();
}
function closeSettings() {
  modal.classList.add('hidden');
  if (skillUsageUpdateOff) { skillUsageUpdateOff(); skillUsageUpdateOff = null; }
  pendingSettings = null;
  settingsViewSnapshot = null;
  modalHint.textContent = '';
  setSettingsBackAction();
  applyThemeToDOM(_themeSetting);
}

$('btnSettings').addEventListener('click', openSettings);
$('btnCloseSettings').addEventListener('click', closeSettings);
$('btnSettingsCancel').addEventListener('click', closeSettings);
if (btnSettingsBackEl) btnSettingsBackEl.addEventListener('click', () => {
  if (activeSettingsBackHandler) activeSettingsBackHandler();
});
modal.addEventListener('click', (e) => {
  // 点遮罩关闭(不点 .modal 本身)
  if (e.target === modal) closeSettings();
});

async function loadSettingsForm(activeCat = 'personalize') {
  settingsViewSnapshot = null;
  if (settingsFooterEl) settingsFooterEl.classList.remove('hidden');
  setSettingsBackAction();
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = '';  // 从子面板返回时恢复"保存"
  modalBody.innerHTML = '<div style="text-align:center;color:#888;padding:40px">加载中...</div>';
  const s = await window.api.settings.read();
  pendingSettings = JSON.parse(JSON.stringify(s));  // 深拷贝,改它

  const claudeVer = (envCache?.claudeVersion || '未探测').replace(/\s*\(Claude Code\)\s*/i, '');
  // GPT 式两栏:左侧一级菜单 + 右侧对应分类内容。所有分类的表单都渲染进 DOM(只切换显示),
  //   这样 bindSettingsEvents/保存逻辑读取各 input 不受影响,无需改动。
  modalBody.innerHTML = `
   <div class="set-layout">
    <nav class="set-nav" id="setNav">
      <button class="set-nav-item active" data-cat="personalize"><span class="sn-ico">🎨</span><span>个性化</span></button>
      <button class="set-nav-item" data-cat="behavior"><span class="sn-ico">🎛️</span><span>行为</span></button>
      <button class="set-nav-item" data-cat="model"><span class="sn-ico">⚡</span><span>模型</span></button>
      <button class="set-nav-item" data-cat="agent"><span class="sn-ico">🤖</span><span>Agent</span></button>
      <button class="set-nav-item" data-cat="skill"><span class="sn-ico">🧩</span><span>技能</span></button>
      <button class="set-nav-item" data-cat="memory"><span class="sn-ico">🧠</span><span>记忆</span></button>
      <button class="set-nav-item" data-cat="usage"><span class="sn-ico">📊</span><span>用量</span></button>
      <button class="set-nav-item" data-cat="api"><span class="sn-ico">🔑</span><span>API</span></button>
      <button class="set-nav-item" data-cat="data"><span class="sn-ico">🔗</span><span>MCP</span></button>
      <button class="set-nav-item" data-cat="about"><span class="sn-ico">ℹ️</span><span>关于</span></button>
    </nav>
    <div class="set-content" id="setContent">

     <!-- ── 个性化 ── -->
     <section class="set-cat active" data-cat="personalize">
      <div class="set-section-head">外观</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon ico-brand">🌗</div>
          <div class="set-label">外观主题</div>
          ${buildSettingsSegmented('set-theme', [
            { value: 'light',  label: '浅色' },
            { value: 'dark',   label: '深色' },
            { value: 'system', label: '跟随系统' },
          ], s.app.theme || 'light')}
        </div>
        <div class="set-row">
          <div class="set-icon ico-brand">🎹</div>
          <div class="set-label">对话快捷索引</div>
          <div class="switch ${s.app.conversationIndex !== false ? 'on' : ''}" id="sw-conversationIndex"></div>
        </div>
      </div>
      <div class="set-section-head">品牌与身份</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon ico-brand">🖌️</div>
          <div class="set-label">侧边栏 Logo</div>
          <div class="brand-logo-ctl">
            <img id="set-brandLogoPreview" class="brand-logo-preview" src="logo.png" alt="" />
            <button id="set-brandLogoPick" type="button">更换</button>
            <button id="set-brandLogoReset" type="button" class="ghost">恢复默认</button>
          </div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-brand">🏷️</div>
            <div class="set-label">应用名称</div>
          </div>
          <div class="row-extra">
            <div class="input-with-count">
              <input type="text" id="set-brandName" placeholder="Relay" value="" />
              <span class="char-count" id="set-brandNameCount">0/21</span>
            </div>
          </div>
        </div>
        <div class="set-row">
          <div class="set-icon ico-brand">🧑‍💼</div>
          <div class="set-label">协奏 PM 头像</div>
          <div class="brand-logo-ctl">
            <img id="set-pmLogoPreview" class="brand-logo-preview" src="" alt="" />
            <button id="set-pmLogoPick" type="button">更换</button>
            <button id="set-pmLogoReset" type="button" class="ghost">恢复默认</button>
          </div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-brand">🏷️</div>
            <div class="set-label">协奏 PM 名称</div>
          </div>
          <div class="row-extra">
            <div class="input-with-count">
              <input type="text" id="set-pmName" placeholder="PM" value="" />
              <span class="char-count" id="set-pmNameCount">0/16</span>
            </div>
          </div>
        </div>
      </div>
     </section>

     <!-- ── 行为 ── -->
     <section class="set-cat" data-cat="behavior">
      <div class="set-section-head">对话与启动</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon ico-think">💭</div>
          <div class="set-label">深度思考</div>
          <div class="switch ${s.claude.alwaysThinking?'on':''}" id="sw-alwaysThinking"></div>
        </div>
        <div class="set-row">
          <div class="set-icon">⏰</div>
          <div class="set-label">开机自动启动</div>
          <div class="switch" id="sw-autoLaunch"></div>
        </div>
        <div class="set-row">
          <div class="set-icon">🔍</div>
          <div class="set-label">迷你输入框（Alt+Space）</div>
          <div class="switch ${s.app.miniInputEnabled?'on':''}" id="sw-miniInput"></div>
        </div>
      </div>
      <div class="set-section-head">工具与权限</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon">⌨️</div>
          <div class="set-label">允许命令任务</div>
          <div class="switch ${s.app.allowCommandTasks?'on':''}" id="sw-allowCommand"></div>
        </div>
        <div class="set-row">
          <div class="set-icon ico-shield">🛡️</div>
          <div class="set-label">工具权限</div>
          ${buildCustomSelect('set-permMode', [
            { value: 'bypassPermissions', label: '全部放行' },
            { value: 'acceptEdits',       label: '仅文件编辑' },
            { value: 'plan',              label: '只读规划' },
            { value: 'default',           label: '默认(需终端)' },
          ], s.app.permissionMode)}
        </div>
      </div>
      <div class="set-panel set-danger-panel">
        <div class="set-row">
          <div class="set-icon ico-warn">⚠️</div>
          <div class="set-label">跳过危险提示</div>
          <div class="switch ${s.claude.skipDangerousPrompt?'on':''}" id="sw-skipDangerous"></div>
        </div>
      </div>
     </section>

     <!-- ── 模型 ── -->
     <section class="set-cat" data-cat="model">
      <div class="set-section-head">默认模型</div>
      <div class="set-panel">
        <div class="set-row">
          <div class="set-icon ico-model">🎯</div>
          <div class="set-label">默认使用</div>
          ${buildSettingsSegmented('set-defaultModel', [
            { value: 'haiku',  label: '快速' },
            { value: 'sonnet', label: '思考' },
            { value: 'opus',   label: '专家' },
          ], s.claude.defaultModel)}
        </div>
      </div>
      <div class="set-section-head">模型映射 <span class="set-section-count">高级配置</span></div>
      <div class="set-panel">
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-opus">${MODEL_TIERS.find(t => t.value === 'opus').icon}</div>
            <div class="set-label">专家模型<span class="set-model-chip">Opus</span></div>
          </div>
          <div class="row-extra"><input type="text" id="set-opusModel" value="${escapeAttr(s.claude.opusModel)}" placeholder="ppio/pa/claude-opus-4-8" /></div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-sonnet">${MODEL_TIERS.find(t => t.value === 'sonnet').icon}</div>
            <div class="set-label">思考模型<span class="set-model-chip">Sonnet</span></div>
          </div>
          <div class="row-extra"><input type="text" id="set-sonnetModel" value="${escapeAttr(s.claude.sonnetModel)}" placeholder="ppio/pa/claude-sonnet-4-6" /></div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-haiku">${MODEL_TIERS.find(t => t.value === 'haiku').icon}</div>
            <div class="set-label">快速模型<span class="set-model-chip">Haiku</span></div>
          </div>
          <div class="row-extra"><input type="text" id="set-haikuModel" value="${escapeAttr(s.claude.haikuModel)}" placeholder="xiaomi/mimo-v2.5-pro" /></div>
        </div>
      </div>
     </section>

     <!-- ── API(含图像生成)── -->
     <section class="set-cat api-settings" data-cat="api">
      <div class="set-section-head">API 配置</div>
      <div class="set-panel">
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-key">🔐</div>
            <div class="set-label">API Key</div>
          </div>
          <div class="row-extra">
            <div class="input-with-btn">
              <input type="password" id="set-apiKey" value="${escapeAttr(s.claude.apiKey)}" placeholder="请输入 API Key" />
              <button id="set-showKey">显示</button>
            </div>
          </div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-globe">🌐</div>
            <div class="set-label">网关 URL</div>
          </div>
          <div class="row-extra">
            <input type="text" id="set-baseUrl" value="${escapeAttr(s.claude.baseUrl)}" />
          </div>
        </div>
      </div>
      <button class="set-fold" id="set-imageApiToggle" type="button" aria-expanded="false">
        <span>图像生成 API</span><span class="set-section-spacer"></span><span class="set-section-count">${(s.imageApi && (s.imageApi.apiKey || s.imageApi.baseUrl)) ? '已单独配置' : '沿用上方配置'}</span><span class="set-fold-chev">›</span>
      </button>
      <div class="set-panel set-fold-panel" id="set-imageApiPanel" hidden>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-key">🖼️</div>
            <div class="set-label">图像 API Key</div>
          </div>
          <div class="row-extra">
            <div class="input-with-btn">
              <input type="password" id="set-imgKey" value="${escapeAttr((s.imageApi && s.imageApi.apiKey) || '')}" placeholder="留空则沿用上方 API Key" />
              <button id="set-showImgKey">显示</button>
            </div>
          </div>
        </div>
        <div class="set-row col">
          <div class="row-main">
            <div class="set-icon ico-globe">🛰️</div>
            <div class="set-label">图像网关 URL</div>
          </div>
          <div class="row-extra">
            <input type="text" id="set-imgBaseUrl" value="${escapeAttr((s.imageApi && s.imageApi.baseUrl) || '')}" placeholder="https://api.llm.mioffice.cn/v1" />
          </div>
        </div>
      </div>
     </section>

     <!-- ── 数据 ── -->
     <!-- ── MCP ── 内容由 renderMcpPanel 异步填充进 #mcpSection(结构化:列表 + 启停 + 删除)。
          data-cat 仍沿用 "data" 作内部键,避免改动 setActiveCat/懒加载等多处映射;仅菜单标签改为「MCP」。 -->
     <section class="set-cat" data-cat="data">
      <div id="mcpSection"></div>
     </section>

     <!-- ── 关于 ── -->
     <section class="set-cat" data-cat="about">
      <div class="set-section-head">应用</div>
      <div class="set-panel">
        <div class="set-row" id="set-checkUpdate">
          <div class="set-icon ico-update">🔄</div>
          <div class="set-label">Claude Code</div>
          <div class="row-status">已内置，随 Relay 一同更新</div>
          <div class="row-status" id="set-claudeVer">${escapeHtml(claudeVer)}</div>
        </div>
        <div class="set-row clickable" id="set-relayUpdate">
          <div class="set-icon ico-app">🚀</div>
          <div class="set-label">Relay</div>
          <div class="row-status" id="set-relayUpdateNote"></div>
          <div class="row-status">v${escapeHtml(s.info.uiVersion)}</div>
          <div class="row-chev">›</div>
        </div>
        <div class="set-row">
          <div class="set-icon ico-author">👤</div>
          <div class="set-label">作者</div>
          <div class="row-status">g0at</div>
        </div>
      </div>
      <div class="set-section-head">高级</div>
      <div class="set-panel">
        <div class="set-row clickable" data-panel="claudeSettings">
          <div class="set-icon ico-file">📄</div>
          <div class="set-label">Claude 设置文件</div>
          <div class="row-status">settings.json</div>
          <div class="row-chev">›</div>
        </div>
      </div>
     </section>

     <!-- ── Agent ── 内容由 renderAgentSkillPanel 异步填充进 #agentSection -->
     <section class="set-cat" data-cat="agent">
      <div id="agentSection"></div>
     </section>

     <!-- ── 技能 ── 内容由 renderAgentSkillPanel 异步填充进 #skillSection -->
     <section class="set-cat" data-cat="skill">
      <div id="skillSection"></div>
     </section>

     <!-- ── 记忆 ── 内容由 renderMemoryPanel 异步填充进 #memorySection -->
     <section class="set-cat" data-cat="memory">
      <div id="memorySection"></div>
     </section>

     <!-- ── 用量 ── 内容由 renderStatsPanel 异步填充进 #usageSection -->
     <section class="set-cat" data-cat="usage">
      <div id="usageSection"></div>
     </section>

    </div>
   </div>
  `;

  // Agent / 技能 / 记忆 / 用量 的内容是异步拉取的,首次切到该分类时才渲染进对应 section(避免每次开设置都请求)。
  const lazyCatLoaded = { agent: 'idle', skill: 'idle', memory: 'idle', usage: 'idle', data: 'idle' };
  const ensureLazyCat = (cat) => {
    if (lazyCatLoaded[cat] === 'loading' || lazyCatLoaded[cat] === 'ready') return;
    let renderTask = null;
    let mount = null;
    if (cat === 'data') {
      mount = $('mcpSection');
      if (mount) renderTask = renderMcpPanel(mount);
    } else if (cat === 'agent') {
      mount = $('agentSection');
      if (mount) renderTask = renderAgentSkillPanel('agent', mount);
    } else if (cat === 'skill') {
      mount = $('skillSection');
      if (mount) renderTask = renderSkillCuratorPanel(mount);
    } else if (cat === 'memory') {
      mount = $('memorySection');
      if (mount) renderTask = renderMemoryPanel(mount);
    } else if (cat === 'usage') {
      mount = $('usageSection');
      if (mount) renderTask = renderStatsPanel(mount);
    }
    if (!renderTask) return;
    lazyCatLoaded[cat] = 'loading';
    Promise.resolve(renderTask).then(() => {
      lazyCatLoaded[cat] = 'ready';
    }).catch((error) => {
      lazyCatLoaded[cat] = 'idle';
      if (cat === 'skill' && skillUsageUpdateOff) {
        skillUsageUpdateOff();
        skillUsageUpdateOff = null;
      }
      if (mount && mount.isConnected) {
        mount.innerHTML = `<div class="dp-empty">加载失败，切换到其他页面后可重试</div>`;
      }
      console.error(`[settings] ${cat} 面板加载失败`, error);
    });
  };

  // 应用初始选中的分类(默认个性化)
  const setActiveCat = (cat) => {
    modalBody.querySelectorAll('.set-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
    modalBody.querySelectorAll('.set-cat').forEach((sec) => sec.classList.toggle('active', sec.dataset.cat === cat));
    lastSettingsCat = cat;   // 记住最近浏览的分类,供全屏子面板(数据栏的文件/历史)返回时回到此处
    // Agent/技能/记忆/用量/MCP 自带内容、不走底部「保存」;切到它们时藏掉,切回其它分类再显示
    const isManage = (cat === 'agent' || cat === 'skill' || cat === 'memory' || cat === 'usage' || cat === 'data');
    if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = isManage ? 'none' : '';
    // 懒渲染推迟到本帧切换绘制完成之后,避免首次切到技能/记忆/用量时,面板的同步 DOM 构建
    //   阻塞菜单高亮+分区显隐的重绘,造成"卡一下"。先让切换瞬间生效,内容下一帧再填。
    if (lazyCatLoaded[cat] === 'idle') requestAnimationFrame(() => ensureLazyCat(cat));
    else ensureLazyCat(cat);
  };
  setActiveCat(activeCat);
  bindTransientScrollbar($('setContent'));
  // 左侧一级菜单切换:点哪个就只显示哪个分类
  modalBody.querySelectorAll('.set-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveCat(btn.dataset.cat);
      const content = $('setContent'); if (content) content.scrollTop = 0;
    });
  });

  bindCustomSelects(modalBody);   // 把自绘下拉的事件绑上
  bindSettingsSegmented(modalBody);

  // 主题下拉即时预览:选中即刻切换,不必等「保存」
  const themeSelect = $('set-theme');
  if (themeSelect) {
    const ob = new MutationObserver(() => applyThemeToDOM(themeSelect.dataset.value));
    ob.observe(themeSelect, { attributes: true, attributeFilter: ['data-value'] });
  }

  bindSettingsEvents(s);
  activeSaveHandler = saveMainSettings;   // 主设置页:底部「保存」保存全部设置
}

let envCache = null;  // 由启动时探测填充

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

// 个性化设置:加载当前 logo/名称到表单,并绑定更换/恢复/字数统计。
//   保存策略:logo 是即时生效(选完就拷贝 + 刷新侧边栏);名称在「保存」时统一写
//   (跟其它设置一致),但这里实时更新字数计数。
async function bindBrandSettings() {
  const nameInput = $('set-brandName');
  const countEl   = $('set-brandNameCount');
  const preview   = $('set-brandLogoPreview');
  // 按视觉宽度限制(全角/中文记 2、英文/数字记 1),上限 21 —— 这是左上角 Logo 区在 15px
  //   字号下能一行完整放下的宽度(约 10 个中文 或 21 个英文)。不缩字号,放不下就不让再输。
  const max = 21;

  const updateCount = () => {
    if (!countEl || !nameInput) return;
    countEl.textContent = `${strWidth(nameInput.value)}/${max}`;
  };

  // 载入当前值
  try {
    const b = await window.api.brand.get();
    if (nameInput) nameInput.value = (b && b.name) ? b.name : '';
    if (preview)   preview.src = (b && b.logo) ? b.logo : 'logo.png';
  } catch {}
  updateCount();

  // 字数限制 + 计数。关键:中文输入法(IME)组合输入时,拼音字母会先进 value 触发 input —
  //   绝不能在组合中途按长度截断(否则拼音超限就把还没上屏的中文截了)。
  //   做法:用 compositionstart/end 跟踪组合状态;组合中只更新计数、不截断;
  //   组合结束(中文真正上屏)和普通(非组合)输入时,才按视觉宽度裁到上限(emoji 不会被拆半)。
  if (nameInput) {
    let composing = false;
    const clampToMax = () => {
      if (strWidth(nameInput.value) > max) nameInput.value = truncateByWidth(nameInput.value, max);
    };
    nameInput.addEventListener('compositionstart', () => { composing = true; });
    nameInput.addEventListener('compositionend', () => {
      composing = false;
      clampToMax();      // 中文上屏后再裁
      updateCount();
    });
    nameInput.addEventListener('input', () => {
      if (!composing) clampToMax();   // 组合中不裁,避免截断拼音/未上屏的中文
      updateCount();
    });
  }

  // 更换 logo:选图 → 主进程拷进 userData → 即时刷新预览 + 侧边栏
  if ($('set-brandLogoPick')) $('set-brandLogoPick').addEventListener('click', async () => {
    const r = await window.api.brand.pickLogo();
    if (r && r.ok) {
      if (preview && r.logo) preview.src = r.logo;
      applyBrand();
      modalHint.textContent = '✓ Logo 已更新';
      setTimeout(() => { if (modalHint.textContent === '✓ Logo 已更新') modalHint.textContent = ''; }, 1500);
    } else if (r && !r.canceled && r.message) {
      modalHint.textContent = '⚠ ' + r.message;
    }
  });

  // 恢复默认 logo
  if ($('set-brandLogoReset')) $('set-brandLogoReset').addEventListener('click', async () => {
    await window.api.brand.resetLogo();
    if (preview) preview.src = 'logo.png';
    applyBrand();
    modalHint.textContent = '✓ 已恢复默认 Logo';
    setTimeout(() => { if (modalHint.textContent === '✓ 已恢复默认 Logo') modalHint.textContent = ''; }, 1500);
  });
}

// 默认 PM 头像(无自定义时):深色圆底 + 白字"PM",与群聊里的 .chat-avatar-pm 观感一致。
const PM_DEFAULT_AVATAR = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><rect width="48" height="48" rx="24" fill="#1a1a1a"/><text x="24" y="30" font-family="sans-serif" font-size="16" font-weight="600" fill="#fff" text-anchor="middle">PM</text></svg>'
);
// 协同 PM 的名称 + 头像自定义(与 bindBrandSettings 同套路)
async function bindPmSettings() {
  const nameInput = $('set-pmName');
  const countEl   = $('set-pmNameCount');
  const preview   = $('set-pmLogoPreview');
  const max = 16;
  const updateCount = () => { if (countEl && nameInput) countEl.textContent = `${strWidth(nameInput.value)}/${max}`; };
  try {
    const p = await window.api.pm.get();
    if (nameInput) nameInput.value = (p && p.name) ? p.name : '';
    if (preview)   preview.src = (p && p.logo) ? p.logo : PM_DEFAULT_AVATAR;
  } catch {}
  updateCount();
  if (nameInput) {
    let composing = false;
    const clampToMax = () => { if (strWidth(nameInput.value) > max) nameInput.value = truncateByWidth(nameInput.value, max); };
    nameInput.addEventListener('compositionstart', () => { composing = true; });
    nameInput.addEventListener('compositionend', () => { composing = false; clampToMax(); updateCount(); });
    nameInput.addEventListener('input', () => { if (!composing) clampToMax(); updateCount(); });
  }
  if ($('set-pmLogoPick')) $('set-pmLogoPick').addEventListener('click', async () => {
    const r = await window.api.pm.pickLogo();
    if (r && r.ok) {
      if (preview && r.logo) preview.src = r.logo;
      pmBrandCache = null;   // 失效缓存,群聊下次取新头像
      modalHint.textContent = '✓ PM 头像已更新';
      setTimeout(() => { if (modalHint.textContent === '✓ PM 头像已更新') modalHint.textContent = ''; }, 1500);
    } else if (r && !r.canceled && r.message) {
      modalHint.textContent = '⚠ ' + r.message;
    }
  });
  if ($('set-pmLogoReset')) $('set-pmLogoReset').addEventListener('click', async () => {
    await window.api.pm.resetLogo();
    if (preview) preview.src = PM_DEFAULT_AVATAR;
    pmBrandCache = null;
    modalHint.textContent = '✓ 已恢复默认 PM 头像';
    setTimeout(() => { if (modalHint.textContent === '✓ 已恢复默认 PM 头像') modalHint.textContent = ''; }, 1500);
  });
}

function bindSettingsEvents(s) {
  // ── 个性化:logo + 名称 ──
  bindBrandSettings();
  bindPmSettings();   // 协同 PM 的名称 + 头像

  // 显示/隐藏 API Key
  $('set-showKey').addEventListener('click', () => {
    const el = $('set-apiKey');
    if (el.type === 'password') { el.type = 'text';     $('set-showKey').textContent = '隐藏'; }
    else                        { el.type = 'password'; $('set-showKey').textContent = '显示'; }
  });
  // 显示/隐藏 图像 API Key
  if ($('set-showImgKey')) $('set-showImgKey').addEventListener('click', () => {
    const el = $('set-imgKey');
    if (el.type === 'password') { el.type = 'text';     $('set-showImgKey').textContent = '隐藏'; }
    else                        { el.type = 'password'; $('set-showImgKey').textContent = '显示'; }
  });
  // 图像 API 是低频覆盖项，默认折叠；展开不影响隐藏字段随主设置一起保存。
  const imageApiToggle = $('set-imageApiToggle');
  const imageApiPanel = $('set-imageApiPanel');
  if (imageApiToggle && imageApiPanel) imageApiToggle.addEventListener('click', () => {
    const open = imageApiPanel.hidden;
    imageApiPanel.hidden = !open;
    imageApiToggle.classList.toggle('open', open);
    imageApiToggle.setAttribute('aria-expanded', String(open));
  });
  // 切换开关（这些随「保存」一起写）
  for (const id of ['sw-alwaysThinking', 'sw-skipDangerous', 'sw-allowCommand', 'sw-miniInput', 'sw-conversationIndex']) {
    $(id).addEventListener('click', () => $(id).classList.toggle('on'));
  }
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
  // 路径打开(仅"历史会话"仍是在文件夹中打开)
  modalBody.querySelectorAll('[data-reveal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.reveal;
      window.api.settings.revealFile(s.paths[key]);
    });
  });
  // 数据中心:五项改为 UI 内编辑 / 管理(不再跳转文件)
  modalBody.querySelectorAll('[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => showDataPanel(btn.dataset.panel));
  });

  // 关于:Relay 应用自更新状态(自动静默流,此处展示 + 手动检查 + 重启安装)
  bindRelayUpdate();
}

// ─────────────────────────────────────────
// Relay 应用自更新 —— 界面侧
//   主进程只自动「检查」,下载和安装都要用户点(见 updater.js 顶部说明)。
//   两个入口共用同一份状态(relay:update-event 推送):
//     ① 右上角气泡:定时检查发现新版时从设置齿轮下方弹出,不打断操作,可「稍后」关掉;
//     ② 设置页「Relay」行:随时手动检查,交互对齐上面的 Claude Code 行(二次点击确认)。
//   状态推送只订阅一次(模块级),handler 每次按 ID 现查 DOM,
//   设置弹窗反复开关不会堆积监听器。
// ─────────────────────────────────────────
let relayUpdateSubscribed = false;

// 订阅一次,气泡与设置行同时刷新。首屏就要订阅 —— 气泡不依赖设置弹窗是否打开过。
function initRelayUpdate() {
  if (relayUpdateSubscribed || !window.api.relayUpdate) return;
  relayUpdateSubscribed = true;
  window.api.relayUpdate.onEvent(onRelayUpdateState);
  window.api.relayUpdate.status().then(onRelayUpdateState).catch(() => {});
}

function onRelayUpdateState(st) {
  if (!st) return;
  renderUpdateBubble(st);
  renderRelayUpdateStatus(st);
}

// ── 右上角更新气泡(尖角对准设置齿轮)──
//   available(未忽略) → 「发现新版本 vX」+ 立即更新 / 稍后
//   downloading       → 「正在下载 n%」+ 进度条(无按钮,下载不打断)
//   ready             → 「vX 已就绪」+ 重启安装 / 稍后
//   其余状态一律不冒,避免打扰。
let updateBubbleHideTimer = null;   // 退场用;必须可取消,否则会误删刚重新显示的气泡
function renderUpdateBubble(st) {
  const show = !st.dismissed &&
    (st.state === 'available' || st.state === 'downloading' || st.state === 'ready');
  let el = document.getElementById('updateBubble');
  if (!show) {
    // 已经在退场了就别重复排队,否则多次状态推送会堆出一串定时器
    if (el && !updateBubbleHideTimer) {
      el.classList.add('hiding');
      updateBubbleHideTimer = setTimeout(() => {
        updateBubbleHideTimer = null;
        const cur = document.getElementById('updateBubble');
        if (cur) cur.remove();
      }, 200);
    }
    return;
  }
  // 退场途中又要显示了(例如点完「稍后」马上从设置页点下载):撤掉待执行的移除
  if (updateBubbleHideTimer) { clearTimeout(updateBubbleHideTimer); updateBubbleHideTimer = null; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'updateBubble';
    el.className = 'update-bubble';   // 入场动画由 CSS 在插入时自动播放
    document.body.appendChild(el);
  } else {
    el.classList.remove('hiding');    // 可能正在退场,拉回来
  }

  const ver = escapeHtml(st.latest || '');
  if (st.state === 'downloading') {
    el.innerHTML = `
      <div class="ub-head">
        <span class="ub-title">正在下载 v${ver}</span>
        <button class="ub-close" data-act="later" title="收起">✕</button>
      </div>
      <div class="ub-bar"><div class="ub-fill" style="width:${st.progress || 0}%"></div></div>
      <div class="ub-desc">${st.progress || 0}% · 下载完成后可选择何时重启</div>`;
  } else if (st.state === 'ready') {
    el.innerHTML = `
      <div class="ub-head">
        <span class="ub-title">v${ver} 已就绪</span>
        <button class="ub-close" data-act="later" title="稍后">✕</button>
      </div>
      <div class="ub-desc">重启 Relay 完成更新，正在进行的对话会先结束。</div>
      <div class="ub-actions">
        <button class="ub-btn ghost" data-act="later">稍后</button>
        <button class="ub-btn primary" data-act="install">重启安装</button>
      </div>`;
  } else {
    const err = st.error ? `<div class="ub-err">上次下载失败：${escapeHtml(st.error)}</div>` : '';
    el.innerHTML = `
      <div class="ub-head">
        <span class="ub-title">发现新版本 v${ver}</span>
        <button class="ub-close" data-act="later" title="稍后">✕</button>
      </div>
      <div class="ub-desc">当前 v${escapeHtml(st.current || '')}，更新前不会改动你的数据。</div>
      ${err}
      <div class="ub-actions">
        <button class="ub-btn ghost" data-act="later">稍后</button>
        <button class="ub-btn primary" data-act="download">${st.error ? '重试下载' : '立即更新'}</button>
      </div>`;
  }

  el.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => handleUpdateAction(b.dataset.act);
  });
}

async function handleUpdateAction(act) {
  if (!window.api.relayUpdate) return;
  try {
    if (act === 'later')     { await window.api.relayUpdate.dismiss(); return; }
    if (act === 'download')  { await window.api.relayUpdate.download(); return; }
    if (act === 'install')   { await window.api.relayUpdate.quitAndInstall(); return; }
  } catch (_) {}
}

// ── 设置页「Relay」行 ──
//   idle(未查过) → 「检查更新」,点击查;已查过 → 「已是最新版本」
//   available    → 「点击更新到 vX.Y.Z」→ 再点才下载(与 Claude Code 行的二次确认一致)
//   downloading  → 「正在下载 n%」(点击无操作)
//   ready        → 「vX.Y.Z 已就绪，点击重启安装」→ quitAndInstall
//   error        → 「检查失败」,点击重试
function renderRelayUpdateStatus(st) {
  const row = $('set-relayUpdate');
  const note = $('set-relayUpdateNote');
  if (!row || !note || !st) return;
  const setNote = (text, kind = '') => {
    note.textContent = text || '';
    note.className = 'row-status' + (kind ? ' note-' + kind : '');
  };
  switch (st.state) {
    case 'disabled':    setNote('开发模式'); break;
    case 'checking':    setNote('检查更新中…'); break;
    case 'available':   setNote(st.error ? `下载失败，点击重试 v${st.latest}` : `点击更新到 v${st.latest}`, st.error ? 'err' : 'accent'); break;
    case 'downloading': setNote(`正在下载 v${st.latest} ${st.progress || 0}%`, 'accent'); break;
    case 'ready':       setNote(`v${st.latest} 已就绪，点击重启安装`, 'accent'); break;
    case 'error':       setNote('✗ 检查失败，点击重试', 'err'); break;
    default:            setNote(st.checkedAt ? '已是最新版本' : '检查更新', st.checkedAt ? 'ok' : ''); break;
  }
}

function bindRelayUpdate() {
  const row = $('set-relayUpdate');
  if (!row) return;
  initRelayUpdate();
  // 打开设置时拉一次当前快照(订阅可能早已完成,但此刻 DOM 才存在)
  if (window.api.relayUpdate) window.api.relayUpdate.status().then(onRelayUpdateState).catch(() => {});
  row.onclick = async () => {
    if (!window.api.relayUpdate) return;
    try {
      const st = await window.api.relayUpdate.status();
      if (st.state === 'ready')     { await window.api.relayUpdate.quitAndInstall(); return; }
      if (st.state === 'available') { await window.api.relayUpdate.download(); return; }
      if (st.state === 'downloading' || st.state === 'checking' || st.state === 'disabled') return;
      onRelayUpdateState(await window.api.relayUpdate.check());
    } catch (_) {}
  };
}

// ─────────────────────────────────────────
// 数据中心子面板(UI 内编辑 / 管理,不跳转文件)
// ─────────────────────────────────────────
function backToSettings() {
  if (restoreSettingsView()) return;
  // 返回到进入全屏子面板前所在的一级菜单。lastSettingsCat 在 setActiveCat 里随当前分类实时更新,
  //   所以无论子面板从哪个分类进入(Claude 设置文件现在在「关于」、MCP 在「数据」、历史已隐藏),返回都回到原处。
  loadSettingsForm(lastSettingsCat || 'personalize');
}
function showDataPanel(kind) {
  preserveSettingsView();
  modalHint.textContent = '';
  // 目前唯一的全屏子面板:Claude 设置文件(JSON 编辑器,底部「保存」接管为保存该文件)。
  //   (MCP 已改为结构化面板 renderMcpPanel;历史会话管理面板已移除。)
  const keepSave = (kind === 'claudeSettings');
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = keepSave ? '' : 'none';
  if (!keepSave) activeSaveHandler = null;
  if (kind === 'claudeSettings') renderJsonEditorPanel(kind);
  modalBody.scrollTop = 0;   // 子面板本身从顶部显示
}

async function renderJsonEditorPanel(kind) {
  const meta = {
    claudeSettings: { title: 'Claude 设置文件', desc: '编辑 ~/.claude/settings.json(API、模型、行为等)。保存前会校验 JSON 格式。' },
  }[kind];
  const fileName = 'settings.json';
  modalBody.innerHTML = `
    <div class="data-panel-head">
      <div class="dp-title">${meta.title}</div>
    </div>
    <div class="dp-desc">${meta.desc}</div>
    <div class="code-window settings-source-window">
      <div class="cw-chrome">
        <span class="cw-dots"><i></i><i></i><i></i></span>
        <span class="cw-name">${fileName}</span>
      </div>
      <textarea class="data-editor" id="dpEditor" spellcheck="false" wrap="off" placeholder="加载中…"></textarea>
    </div>
  `;
  setSettingsBackAction(backToSettings);
  const editor = $('dpEditor');
  const res = await window.api.data.read(kind);
  editor.value = (res && res.ok) ? res.content : '';
  // 保存交给最外层底部「保存」按钮(和取消并排,风格统一)
  activeSaveHandler = async () => {
    const r = await window.api.data.write(kind, editor.value);
    if (r && r.ok) { modalHint.textContent = '✓ 已保存'; showToast('已保存'); }
    else { modalHint.textContent = ''; showToast((r && r.message) || '保存失败'); }
  };
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
      aria-label="选择或拖入 ${label} ZIP 安装包">
      <svg class="dp-import-upload" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <path d="m17 8-5-5-5 5"></path>
        <path d="M12 3v12"></path>
      </svg>
      <span data-import-label>导入 ${label} 包（.zip）</span>
    </button>
  `;
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
    modalHint.textContent = kind === 'skill' ? '正在安装并生成中文摘要…' : '正在导入…';
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
      modalHint.textContent = '';
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
      // Agent 用与协同群聊一致的 DiceBear 头像(种子=真实名,圆形);技能仍用 🧩
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

  bindPackageImportZone(q('[data-import]'), kind, (r) => renderList(r.items));

  const res = isSkill ? await window.api.data.listSkills() : await window.api.data.listAgents();
  renderList(res && res.items);
}

// MCP 服务器管理面板(结构化:列表 + 启停开关 + 删除)。mount = #mcpSection 容器。
//   启用态来自 .claude.json 的 mcpServers,禁用态来自 sidecar 键;启停 = 在两者间搬运(见主进程 mcp:toggle)。
//   只读写 mcpServers/sidecar,绝不碰 .claude.json 里的会话等其他数据。
async function renderMcpPanel(mount) {
  const q = (sel) => mount.querySelector(sel);
  mount.innerHTML = `
    <div class="set-toolbar">
      <span class="set-toolbar-count" data-count></span>
      <button class="set-toolbar-btn primary" type="button" data-mcp-reconnect><span>↻ 重新加载当前对话</span></button>
    </div>
    <div class="set-panel dp-list" data-list></div>
  `;

  q('[data-mcp-reconnect]').addEventListener('click', (e) => resetCurrentMcpSession(e.currentTarget));
  syncMcpReconnectButtons();

  const renderList = (items) => {
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
      row.innerHTML = `
        <div class="set-icon ico-mcp">🔗</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
        </div>
        <div class="dp-item-actions">
          <div class="switch ${it.enabled ? 'on' : ''}" data-toggle title="${it.enabled ? '已启用,点击停用' : '已停用,点击启用'}"></div>
          <div class="dp-menu-wrap">
            <button class="dp-more" type="button" aria-label="更多操作">···</button>
            <div class="dp-menu"><button type="button" class="danger" data-action="delete">删除</button></div>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.name;
      // 副信息:停用的加「· 已停用」标注;再带一行命令/url 摘要
      const parts = [it.enabled ? '' : '已停用', it.summary || ''].filter(Boolean);
      row.querySelector('.dp-item-desc').textContent = parts.join('　·　');

      // 启停开关:乐观切换 + 失败回滚(与「开机自启」开关一致的即时生效风格)
      const sw = row.querySelector('[data-toggle]');
      sw.addEventListener('click', async () => {
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        const r = await window.api.mcp.toggle(it.name, next);
        if (r && r.ok) { showToast(`${next ? '已启用' : '已停用'}，重连当前会话后生效`); renderList((await window.api.mcp.list()).items); }
        else { sw.classList.toggle('on', !next); showToast((r && r.message) || '操作失败'); }   // 回滚
      });

      row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await customConfirm({
          title: '删除 MCP 服务器',
          message: `「${it.name}」将从 ~/.claude.json 永久移除，无法恢复。`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.mcp.remove(it.name);
        if (r && r.ok) { showToast('已删除，重连当前会话后生效'); renderList((await window.api.mcp.list()).items); }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);

      list.appendChild(row);
    });
  };

  const res = await window.api.mcp.list();
  renderList(res && res.items);
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
    : { enabled: true, everyTurns: 6 };
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
    <div class="set-section-head skill-auto-head">自动化与维护 <span class="set-section-spacer"></span><span class="set-section-count">按需设置</span></div>
    <div class="set-panel mem-auto-panel">
      <div class="set-row">
        <div class="set-icon">✨</div>
        <div class="set-label">对话中自动提炼技能</div>
        <div class="switch ${reviewCfg.enabled ? 'on' : ''}" data-review-on title="开启/关闭自动提炼"></div>
      </div>
      <div class="set-row" data-review-freq-row${reviewCfg.enabled ? '' : ' style="opacity:0.45"'}>
        <div class="set-icon">🔁</div>
        <div class="set-label">提炼频率</div>
        ${buildCustomSelect('skill-review-every', [
          { value: '4', label: '每 4 轮' }, { value: '6', label: '每 6 轮' },
          { value: '10', label: '每 10 轮' }, { value: '20', label: '每 20 轮' },
        ], String(reviewCfg.everyTurns || 6))}
      </div>
      <div class="set-row">
        <div class="set-icon">🩺</div>
        <div class="set-label">闲置阈值</div>
        ${buildCustomSelect('skill-stale-days', STALE_OPTS, '30')}
      </div>
      <div class="set-row">
        <div class="set-icon">🔬</div>
        <div class="set-label">定期技能体检<div class="set-sub" data-cur-next></div></div>
        ${buildSettingsSegmented('skill-cur-model', MAINTENANCE_MODEL_OPTIONS, curatorModel)}
        <button class="row-btn" data-cur-run>立即体检</button>
        <div class="switch" data-cur-on title="开启/关闭定期体检"></div>
      </div>
      <div class="set-row" data-cur-sched-row>
        <div class="set-icon">🗓️</div>
        <div class="set-label">体检时间</div>
        ${buildCustomSelect('skill-cur-dow', [
          { value: '1', label: '每周一' }, { value: '2', label: '每周二' }, { value: '3', label: '每周三' },
          { value: '4', label: '每周四' }, { value: '5', label: '每周五' }, { value: '6', label: '每周六' },
          { value: '0', label: '每周日' },
        ], '5')}
        ${buildCustomSelect('skill-cur-time', curTimeOpts, '10:00')}
      </div>
    </div>
    <div class="set-panel dp-list" data-list></div>
    <div class="skill-arch" data-arch-wrap hidden>
      <div class="skill-arch-head" data-arch-toggle>
        <span data-arch-title>已归档</span>
        <svg class="skill-arch-chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="set-panel dp-list skill-arch-list" data-arch-list hidden></div>
    </div>
  `;
  bindCustomSelects(mount);
  bindSettingsSegmented(mount);

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
      const useText = !usageReady
        ? '正在后台统计用量…'
        : (it.useCount > 0 ? `用 ${it.useCount} 次 · 最近 ${fmtDay(it.lastUsedAt)}` : '未使用过');
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
            <button type="button" data-action="pin">${it.pinned ? '取消保护' : '保护'}</button>
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
  const reload = async ({ refresh = true } = {}) => {
    if (!mount.isConnected || !q('[data-list]')) return;
    const r = await window.api.skills.overview({ refresh });
    if (!mount.isConnected || !q('[data-list]')) return;
    if (!r || !r.ok) {
      if (!skillOverviewCache) q('[data-list]').innerHTML = `<div class="dp-empty">加载失败</div>`;
      return;
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
  };

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

  bindPackageImportZone(q('[data-import]'), 'skill', () => reload());

  if (skillUsageUpdateOff) skillUsageUpdateOff();
  skillUsageUpdateOff = window.api.skills.onUsageUpdated(() => {
    if (!mount.isConnected) return;
    reload({ refresh: false });
  });

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
      if (reviewFreqRow) reviewFreqRow.style.opacity = nextCfg.enabled ? '' : '0.45';
      requestAnimationFrame(() => reviewOn.classList.remove('no-anim'));
    }
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

  await Promise.all([reload(), applyConfigPromise]);

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
}

// 记忆管理面板(与 Agent/技能 同款风格)。记忆由模型在对话里自读自写,这里供人工审计:
//   查看/编辑单条(全屏子面板,复用 data-editor)、删除、查看索引 MEMORY.md。
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
    <button class="set-fold mem-auto-toggle" type="button" data-mem-auto-toggle aria-expanded="false">
      <span>自动整理与维护</span><span class="set-section-spacer"></span><span class="set-fold-chev">›</span>
    </button>
    <div class="set-panel mem-auto-panel" data-mem-auto-panel hidden>
      <div class="set-row">
        <div class="set-icon ico-history">🧹</div>
        <div class="set-label">定期自动整理</div>
        ${buildSettingsSegmented('mem-auto-model', MAINTENANCE_MODEL_OPTIONS, memoryMaintenanceModel)}
        <button class="row-btn" data-auto-run>立即整理</button>
        <div class="switch" data-auto-on title="开启/关闭定期整理"></div>
      </div>
      <div class="set-row">
        <div class="set-icon">🕙</div>
        <div class="set-label">整理时间<div class="set-sub" data-auto-next></div></div>
        ${buildCustomSelect('mem-auto-dow', [
          { value: '1', label: '每周一' }, { value: '2', label: '每周二' }, { value: '3', label: '每周三' },
          { value: '4', label: '每周四' }, { value: '5', label: '每周五' }, { value: '6', label: '每周六' },
          { value: '0', label: '每周日' }, { value: '*', label: '每天' },
        ], '1')}
        ${buildCustomSelect('mem-auto-time', timeOpts, '10:00')}
      </div>
    </div>
    <div class="mem-toolbar">
      <span class="dp-count" data-count></span>
      <div class="mem-toolbar-btns">
        <button class="mem-btn" data-mem-index>查看索引</button>
      </div>
    </div>
    <div class="set-panel dp-list" data-list></div>
  `;

  // ── 定期自动整理:本质是一个 builtin 标记的普通定时任务,在定时任务列表里同样可见/可管 ──
  //   开关=创建或启停;周几+时间=改 cron;「立即整理」=没有任务就先建一个(不启用),然后手动跑一次。
  const CONSOLIDATE_BUILTIN = 'memory-consolidate';
  const CONSOLIDATE_PROMPT =
    '你的本次任务:整理你的长期记忆库(位置与当前索引见文末[长期记忆]段)。步骤:\n' +
    '1. 用 Read 通读记忆库目录下全部 .md 文件(MEMORY.md 索引除外)。\n' +
    '2. 合并同主题:多个文件讲同一件事时,把增量信息并入信息量最大的那个文件(用 Write 覆写),然后删除其余文件。\n' +
    '3. 清理过期:已被证伪、明确过期、或只对当时那次对话有意义的条目,删除对应 .md 文件。\n' +
    '4. 保守原则:拿不准是否还有用的,一律保留,不要删。\n' +
    '5. 审计要求:最后输出一份整理报告,列出 (a)合并了哪些文件 (b)删除了哪些文件及其内容要点——被删内容必须在报告里留痕,便于人工追回 (c)保留不动的条目数。没有可整理的就报告「记忆库无需整理,共 N 条」。\n' +
    '注意:不要创建或编辑 MEMORY.md(索引由系统自动重建);删除文件用 Bash 工具(rm)。';
  const autoOn = q('[data-auto-on]'), autoNext = q('[data-auto-next]'), autoRun = q('[data-auto-run]');
  const autoToggle = q('[data-mem-auto-toggle]'), autoPanel = q('[data-mem-auto-panel]');
  if (autoToggle && autoPanel) autoToggle.addEventListener('click', () => {
    const open = autoPanel.hidden;
    autoPanel.hidden = !open;
    autoToggle.classList.toggle('open', open);
    autoToggle.setAttribute('aria-expanded', String(open));
  });
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

  const renderList = (items) => {
    const list = q('[data-list]');
    const count = q('[data-count]');
    if (count) count.textContent = items && items.length ? `共 ${items.length} 条记忆` : '';
    if (!items || !items.length) {
      list.innerHTML = `<div class="dp-empty">还没有记忆。随着你和助手对话,它会自动把值得长期记住的事记在这里。</div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'set-row dp-item';
      const badge = TYPE_LABEL[it.type] ? `<span class="mem-badge">${TYPE_LABEL[it.type]}</span>` : '';
      row.innerHTML = `
        <div class="set-icon ico-mem">🧠</div>
        <div class="dp-item-main">
          <div class="dp-item-name"></div>
          <div class="dp-item-desc"></div>
        </div>
        <div class="dp-item-actions dp-menu-wrap">
          ${badge}
          <button class="dp-more" type="button" aria-label="更多操作">···</button>
          <div class="dp-menu">
            <button type="button" data-action="detail">详情</button>
            <button type="button" class="danger" data-action="delete">删除</button>
          </div>
        </div>
      `;
      row.querySelector('.dp-item-name').textContent = it.name || it.file;
      row.querySelector('.dp-item-desc').textContent = it.description || '(无摘要)';
      row.querySelector('[data-action="detail"]').addEventListener('click', () => renderMemoryEditor(it.file, it.name || it.file));
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const ok = await customConfirm({
          title: '删除记忆',
          message: `确定删除「${it.name || it.file}」？删除后助手将不再记得这条。\n（索引 MEMORY.md 里对应的那行可在「查看索引」中一并清理。）`,
          confirmText: '删除', cancelText: '取消', danger: true,
        });
        if (!ok) return;
        const r = await window.api.memory.remove(it.file);
        if (r && r.ok) { showToast('已删除'); load(); }
        else showToast((r && r.message) || '删除失败');
      });
      bindDpMenu(row);
      list.appendChild(row);
    });
  };

  q('[data-mem-index]').addEventListener('click', () => renderMemoryEditor('MEMORY.md', '记忆索引 (MEMORY.md)'));

  const load = async () => {
    const res = await window.api.memory.list();
    renderList(res && res.items);
  };
  await load();
}

// 用量面板:本地聚合 history + 定时任务 runs + Claude Code transcript
//   的统计可视化(只读,无「保存」)。Token 全部取 CLI 原始字段,不做估算。
async function renderStatsPanel(mount) {
  const DAY_OPTS = [{ value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }, { value: '90', label: '近 90 天' }];
  let days = 30;

  // 骨架:顶部时间范围下拉 + 内容容器(下拉切换时只重渲染容器)
  mount.innerHTML = `
    <div class="stats-toolbar">
      ${buildCustomSelect('stats-days', DAY_OPTS, String(days))}
    </div>
    <div class="stats-body" data-body><div class="stats-loading">加载中…</div></div>
  `;
  bindCustomSelects(mount);
  const body = mount.querySelector('[data-body]');
  const daysRoot = mount.querySelector('#stats-days');

  const fmtMs = (ms) => {
    if (!ms || ms < 1000) return (ms || 0) + 'ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    if (s < 3600) {
      const m = Math.floor(s / 60), rs = Math.round(s % 60);
      return rs ? `${m}分${rs}秒` : `${m}分`;
    }
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `${h}小时${m}分` : `${h}小时`;
  };
  // token 数 → 紧凑可读(1.2K / 3.4M / 1.9B)
  const fmtTok = (n) => {
    n = n || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
    return (n / 1e9).toFixed(1) + 'B';
  };
  // 'YYYY-MM-DD' → 'M/D'(柱状图 x 轴标签,省空间)
  const shortDate = (iso) => { const p = (iso || '').split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : iso; };
  const fmtAt = (iso) => {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const M = d.getMonth() + 1, D = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return `${M}/${D} ${hh}:${mm}`;
  };

  // 一个统计卡片
  const card = (value, label, accent = '') => `
    <div class="stat-card${accent ? ' ' + accent : ''}">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>`;

  // 排行条(模型/Agent):name + 计数 + 占比条
  const rankRows = (items, total, emptyText, formatValue = (value) => String(value)) => {
    if (!items || !items.length) return `<div class="stats-empty">${escapeHtml(emptyText)}</div>`;
    const max = items[0].count || 1;
    return items.slice(0, 4).map((it) => {
      const pct = total ? Math.round((it.count / total) * 100) : 0;
      const w = Math.max(4, Math.round((it.count / max) * 100));
      return `
        <div class="rank-row">
          <div class="rank-name" title="${escapeAttr(it.key)}">${escapeHtml(it.key)}</div>
          <div class="rank-bar-wrap"><div class="rank-bar" style="width:${w}%"></div></div>
          <div class="rank-num">${escapeHtml(formatValue(it.count))}<span class="rank-pct">${pct}%</span></div>
        </div>`;
    }).join('');
  };

  const render = (d) => {
    if (!d || !d.ok) { body.innerHTML = `<div class="stats-empty">暂无数据</div>`; return; }
    const t = d.totals, sc = d.scheduler;

    // 每日活跃柱状图
    const peak = d.daily.reduce((m, x) => Math.max(m, x.count), 0);
    const bars = d.daily.map((x) => {
      const h = peak ? Math.round((x.count / peak) * 100) : 0;
      return `<div class="bar-col" title="${x.date}　${x.count} 次">
        <div class="bar-fill" style="height:${x.count ? Math.max(6, h) : 0}%"></div>
      </div>`;
    }).join('');
    // x 轴稀疏标签:首、中、尾,避免 90 天挤成一团
    const lab = (i) => shortDate(d.daily[i] ? d.daily[i].date : '');
    const axis = d.daily.length
      ? `<div class="bar-axis"><span>${lab(0)}</span><span>${lab(Math.floor(d.daily.length / 2))}</span><span>${lab(d.daily.length - 1)}</span></div>`
      : '';

    // Token 用量(读 Claude Code transcript;仅 Relay 会话)。无数据时整块不渲染。
    //   只给四个汇总卡片;「按模型」维度交给下方「模型用量(按会话)」,避免重复。
    const tk = d.tokens || {};
    let tokenBlock = '';
    if (tk.available) {
      const totalIn = (tk.inputTokens || 0) + (tk.cacheReadTokens || 0) + (tk.cacheCreationTokens || 0);
      const hitRate = totalIn ? Math.round((tk.cacheReadTokens / totalIn) * 100) : 0;
      tokenBlock = `
        <div class="stats-block">
          <div class="stats-block-title">Token 用量<span class="stats-block-sub">仅 Relay 会话 · ${tk.matchedSessions || 0} 个会话 · 缓存写入 ${fmtTok(tk.cacheCreationTokens)}</span></div>
          <div class="stat-cards centered">
            ${card(fmtTok(tk.inputTokens), '输入 token')}
            ${card(fmtTok(tk.outputTokens), '输出 token')}
            ${card(fmtTok(tk.cacheReadTokens), '缓存读取')}
            ${card(hitRate + '%', '缓存命中', hitRate >= 50 ? 'good' : '')}
          </div>
        </div>`;
    }

    // transcript 中按模型聚合总 token，使用环形图展示占比。
    // 最多单列 4 个模型，其余合并为“其他”，避免图例把双列卡片撑高。
    const modelTokenSource = (tk.byModel || []).filter((item) => (item.count || 0) > 0);
    const modelTokenTotal = modelTokenSource.reduce((sum, item) => sum + (item.count || 0), 0);
    const modelTokenItems = modelTokenSource.slice(0, 4).map((item) => ({ ...item }));
    const modelTokenOther = modelTokenSource.slice(4).reduce((sum, item) => sum + (item.count || 0), 0);
    if (modelTokenOther) modelTokenItems.push({ key: '其他', count: modelTokenOther });
    const modelTokenColors = ['#2878e8', '#7c5cff', '#1d9e75', '#f59e0b', '#94a3b8'];
    let modelTokenCursor = 0;
    const modelTokenSlices = modelTokenItems.map((item, index) => {
      const start = modelTokenTotal ? (modelTokenCursor / modelTokenTotal) * 360 : 0;
      modelTokenCursor += item.count || 0;
      const end = modelTokenTotal ? (modelTokenCursor / modelTokenTotal) * 360 : 0;
      return `${modelTokenColors[index]} ${start}deg ${end}deg`;
    });
    const modelTokenPieStyle = modelTokenTotal
      ? `background:conic-gradient(${modelTokenSlices.join(',')})`
      : 'background:var(--bg-elevated)';
    const modelTokenLegend = modelTokenItems.map((item, index) => {
      const pct = modelTokenTotal ? Math.round(((item.count || 0) / modelTokenTotal) * 100) : 0;
      return `
        <div class="model-token-legend-row" title="${escapeAttr(item.key)}">
          <i style="background:${modelTokenColors[index]}"></i>
          <span class="model-token-name">${escapeHtml(item.key)}</span>
          <span class="model-token-value">${fmtTok(item.count)}<small>${pct}%</small></span>
        </div>`;
    }).join('');
    const modelTokenBlock = `
      <div class="stats-block model-token-block">
        <div class="stats-block-title">模型 Token</div>
        <div class="model-token-chart">
          <div class="model-token-donut" style="${modelTokenPieStyle}">
            <div class="model-token-center"><strong>${fmtTok(modelTokenTotal)}</strong><span>总计</span></div>
          </div>
          <div class="model-token-legend">
            ${tk.available && modelTokenLegend
              ? modelTokenLegend
              : '<div class="model-token-empty">暂无数据</div>'}
          </div>
        </div>
      </div>`;

    // 定时任务最近执行
    const recent = (sc.recent || []).map((r) => `
      <div class="run-row">
        <span class="run-dot ${r.status === 'ok' ? 'ok' : 'err'}"></span>
        <span class="run-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span>
        <span class="run-meta">${fmtAt(r.at)}　${fmtMs(r.ms)}</span>
      </div>`).join('') || `<div class="stats-empty">还没有定时任务执行记录</div>`;

    body.innerHTML = `
      <div class="stat-cards centered">
        ${card(t.conversations, '总会话')}
        ${card(t.messages, '对话轮次')}
        ${card(t.images, 'AI 创作图片')}
        ${card(t.scheduledConvs, '定时产出会话')}
      </div>

      <div class="stats-block">
        <div class="stats-block-title">每日活跃<span class="stats-block-sub">近 ${d.days} 天 · 共 ${d.daily.reduce((s, x) => s + x.count, 0)} 次</span></div>
        <div class="bar-chart">${bars || '<div class="stats-empty">窗口内暂无活跃</div>'}</div>
        ${axis}
      </div>

      ${tokenBlock}

      <div class="stats-2col">
        ${modelTokenBlock}
        <div class="stats-block">
          <div class="stats-block-title">Agent 排行<span class="stats-block-sub">按会话</span></div>
          ${rankRows(d.byAgent, (d.byAgent || []).reduce((s, it) => s + (it.count || 0), 0), '还没有用过 Agent 对话')}
        </div>
      </div>

      <div class="stats-block">
        <div class="stats-block-title">定时任务<span class="stats-block-sub">${sc.tasksEnabled}/${sc.tasksTotal} 启用中</span></div>
        <div class="stat-cards small centered">
          ${card(sc.runsTotal, '累计执行')}
          ${card(sc.successRate == null ? '—' : sc.successRate + '%', '成功率', sc.error ? 'warn' : 'good')}
          ${card(sc.error, '失败次数', sc.error ? 'warn' : '')}
          ${card(sc.avgMs ? fmtMs(sc.avgMs) : '—', '平均耗时')}
        </div>
        <div class="run-list">${recent}</div>
      </div>
    `;
  };

  const load = async () => {
    body.innerHTML = `<div class="stats-loading">加载中…</div>`;
    let d = null;
    try { d = await window.api.stats.overview(days); } catch (e) { d = null; }
    render(d);
  };

  // 时间范围切换 → 重新拉取(bindCustomSelects 已绑点击,这里监听值变化)
  if (daysRoot) {
    daysRoot.querySelectorAll('.cs-option').forEach((o) => {
      o.addEventListener('click', () => {
        const v = parseInt(o.dataset.value, 10);
        if (Number.isFinite(v) && v !== days) { days = v; load(); }
      });
    });
  }

  await load();
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
  preserveSettingsView();
  modalHint.textContent = '';
  activeSaveHandler = null;
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = 'none';
  const isArchivedSkill = kind === 'archivedSkill';
  const typeLabel = kind === 'agent' ? 'Agent' : '技能';
  const fileLabel = kind === 'agent' ? key : 'SKILL.md';
  modalBody.innerHTML = `
    <div class="data-panel-head">
      <div class="dp-title">${escapeHtml(title || key)}</div>
      <span class="dp-head-spacer"></span>
      <div class="detail-head-actions">
        <button class="mem-view-toggle" id="memOpenLocal" type="button">在本地打开</button>
        ${isArchivedSkill ? '' : '<button class="mem-view-toggle" id="memViewToggle" type="button">编辑</button>'}
      </div>
    </div>
    <div class="memory-markdown-view" id="dpMemoryPreview"><div class="memory-preview-loading">加载中…</div></div>
    <div class="memory-edit-workspace hidden" id="dpMemorySource">
      <section class="memory-edit-pane">
        <div class="memory-pane-head"><span>Markdown</span><code>${escapeHtml(fileLabel)}</code></div>
        <textarea class="data-editor" id="dpEditor" spellcheck="false" wrap="soft" placeholder="加载中…"></textarea>
      </section>
      <section class="memory-edit-pane memory-preview-pane">
        <div class="memory-pane-head"><span>实时预览</span></div>
        <div class="memory-markdown-view memory-live-preview" id="dpMemoryLivePreview"></div>
      </section>
    </div>
  `;
  const returnToList = () => {
    backToSettings();
  };

  const editor = $('dpEditor');
  const preview = $('dpMemoryPreview');
  const source = $('dpMemorySource');
  const livePreview = $('dpMemoryLivePreview');
  const toggle = $('memViewToggle');
  const openLocal = $('memOpenLocal');
  openLocal.addEventListener('click', async () => {
    const r = await window.api.data.revealItem(kind, key);
    if (!r || !r.ok) showToast((r && r.message) || '打开失败');
  });
  setSettingsBackAction(returnToList);
  const res = await window.api.data.readItem(kind, key);
  if (!res || !res.ok) showToast((res && res.message) || '详情加载失败');
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
    setSettingsBackAction(editing ? () => setEditing(false) : returnToList);
    if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = editing && !isArchivedSkill ? '' : 'none';
    if (editing) {
      renderPreview(livePreview);
      requestAnimationFrame(() => editor.focus());
    }
    else renderPreview();
  };
  if (toggle) toggle.addEventListener('click', () => setEditing(true));
  setEditing(false);
  if (!isArchivedSkill) {
    activeSaveHandler = async () => {
      const r = await window.api.data.writeItem(kind, key, editor.value);
      if (r && r.ok) {
        modalHint.textContent = '✓ 已保存';
        showToast('已保存');
        setEditing(false);
      } else {
        modalHint.textContent = '';
        showToast((r && r.message) || '保存失败');
      }
    };
  }
}

// 单条记忆默认以 Markdown 阅读视图打开；普通记忆可切换到源码编辑。
// file='MEMORY.md' 时是系统索引，只提供阅读视图。
async function renderMemoryEditor(file, title) {
  preserveSettingsView();
  modalHint.textContent = '';
  const isIndex = String(file).toLowerCase() === 'memory.md';
  if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = 'none';
  if (isIndex) activeSaveHandler = null;
  modalBody.innerHTML = `
    <div class="data-panel-head">
      <div class="dp-title">${escapeHtml(title || file)}</div>
      <span class="dp-head-spacer"></span>
      <div class="detail-head-actions">
        <button class="mem-view-toggle" id="memOpenLocal" type="button">在本地打开</button>
        ${isIndex ? '' : '<button class="mem-view-toggle" id="memViewToggle" type="button">编辑</button>'}
      </div>
    </div>
    <div class="memory-markdown-view" id="dpMemoryPreview" data-memory-file="${escapeAttr(file)}"><div class="memory-preview-loading">加载中…</div></div>
    <div class="memory-edit-workspace hidden" id="dpMemorySource">
      <section class="memory-edit-pane">
        <div class="memory-pane-head"><span>Markdown</span><code>${escapeHtml(file)}</code></div>
        <textarea class="data-editor" id="dpEditor" spellcheck="false" wrap="soft" placeholder="加载中…" ${isIndex ? 'readonly' : ''}></textarea>
      </section>
      <section class="memory-edit-pane memory-preview-pane">
        <div class="memory-pane-head"><span>实时预览</span></div>
        <div class="memory-markdown-view memory-live-preview" id="dpMemoryLivePreview" data-memory-file="${escapeAttr(file)}"></div>
      </section>
    </div>
  `;
  // 详情态的底部「返回」回到记忆列表。
  const returnToList = () => {
    backToSettings();
  };
  const editor = $('dpEditor');
  const preview = $('dpMemoryPreview');
  const source = $('dpMemorySource');
  const livePreview = $('dpMemoryLivePreview');
  const toggle = $('memViewToggle');
  const openLocal = $('memOpenLocal');
  openLocal.addEventListener('click', async () => {
    const r = await window.api.memory.revealFile(file);
    if (!r || !r.ok) showToast((r && r.message) || '打开失败');
  });
  setSettingsBackAction(returnToList);
  const res = await window.api.memory.read(file);
  editor.value = (res && res.ok) ? res.content : '';
  const renderPreview = (target = preview) => {
    const body = memoryMarkdownBody(editor.value);
    target.innerHTML = body.trim()
      ? renderMarkdown(body)
      : '<div class="memory-preview-empty">这条记忆暂无正文。</div>';
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
    setSettingsBackAction(editing ? () => setEditing(false) : returnToList);
    if (btnSettingsSaveEl) btnSettingsSaveEl.style.display = editing && !isIndex ? '' : 'none';
    if (editing) {
      renderPreview(livePreview);
      requestAnimationFrame(() => editor.focus());
    }
    else renderPreview();
  };
  if (toggle) toggle.addEventListener('click', () => setEditing(true));
  setEditing(false);
  if (!isIndex) {
    activeSaveHandler = async () => {
      const r = await window.api.memory.write(file, editor.value);
      if (r && r.ok) {
        modalHint.textContent = '✓ 已保存';
        showToast('已保存');
        setEditing(false);
      }
      else { modalHint.textContent = ''; showToast((r && r.message) || '保存失败'); }
    };
  }
}


function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── 给 markdown 渲染出的 <pre> 加右上角复制按钮 ──
const COPY_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const RUN_ICON_SVG  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const CHEV_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
// 超过这么多行的代码块,默认折叠
const CODE_COLLAPSE_LINES = 16;

// 判断一段代码是不是「可在浏览器直接运行的完整网页」(用于决定要不要加运行按钮)
function isRunnableHtml(codeEl, codeText) {
  const lang = (codeEl && codeEl.className || '').toLowerCase();
  if (/language-(html|xml|svg)/.test(lang)) return true;
  const t = (codeText || '').trim().toLowerCase();
  return /<!doctype html|<html[\s>]|<body[\s>]|<svg[\s>]/.test(t);
}

function enhanceCodeBlocks(container) {
  if (!container) return;
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.classList.contains('md-fallback')) return;   // 解析失败的纯文本回退块,不是代码块,不加按钮/折叠
    if (pre.querySelector('.code-actions')) return;
    const codeEl = pre.querySelector('code');
    const codeText = codeEl?.textContent ?? pre.textContent ?? '';

    const actions = document.createElement('div');
    actions.className = 'code-actions';

    // 运行按钮(仅完整网页代码)
    if (isRunnableHtml(codeEl, codeText)) {
      const run = document.createElement('button');
      run.className = 'code-run';
      run.title = '运行预览';
      run.innerHTML = `${RUN_ICON_SVG}<span>运行</span>`;
      run.addEventListener('click', (e) => {
        e.stopPropagation();
        openCodePreview(codeText);
      });
      actions.appendChild(run);
    }

    // 折叠/展开按钮(代码较长时才提供,并默认折叠)
    const lineCount = (codeText.match(/\n/g) || []).length + 1;
    if (lineCount > CODE_COLLAPSE_LINES) {
      const toggle = document.createElement('button');
      toggle.className = 'code-toggle';
      const setLabel = () => {
        const collapsed = pre.classList.contains('collapsed');
        toggle.innerHTML = `${CHEV_ICON_SVG}<span>${collapsed ? '展开' : '折叠'}</span>`;
        toggle.title = collapsed ? '展开代码' : '折叠代码';
      };
      pre.classList.add('collapsed');   // 默认折叠
      setLabel();
      // 底部渐隐遮罩(仅折叠态可见,由 CSS 控制显隐)
      const fade = document.createElement('div');
      fade.className = 'code-fade';
      pre.appendChild(fade);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        pre.classList.toggle('collapsed');
        setLabel();
      });
      actions.appendChild(toggle);
    }

    // 复制按钮
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.title = '复制代码';
    btn.innerHTML = COPY_ICON_SVG;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(codeText);
        btn.classList.add('copied');
        btn.innerHTML = '✓';
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON_SVG; }, 1200);
      } catch {
        showToast('复制失败');
      }
    });
    actions.appendChild(btn);

    pre.appendChild(actions);

    // 折叠态点击代码区任意处也可展开(整块当“展开”热区,更易点)
    pre.addEventListener('click', (e) => {
      if (pre.classList.contains('collapsed') && !e.target.closest('.code-actions')) {
        pre.classList.remove('collapsed');
        const t = actions.querySelector('.code-toggle');
        if (t) { t.innerHTML = `${CHEV_ICON_SVG}<span>折叠</span>`; t.title = '折叠代码'; }
      }
    });
  });
}

// 给预览内容注入一点基础样式,保证内容能自适应、溢出可滚动(永不被裁切),
//   但不破坏页面自身布局。整段代码已存在 <head> 就插进去,否则当作 HTML 片段包一层。
function wrapPreviewHtml(html) {
  const base = `<style>
    html,body{margin:0;min-width:0;max-width:100%;overflow:auto !important;box-sizing:border-box;}
    img,video,canvas,svg,table{max-width:100%;height:auto;}
  </style>`;
  const t = String(html || '');
  if (/<head[\s>]/i.test(t)) {
    return t.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }
  if (/<html[\s>]/i.test(t)) {
    return t.replace(/<html([^>]*)>/i, `<html$1><head>${base}</head>`);
  }
  // 纯片段(没有完整文档结构)→ 包一个最小文档
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${base}</head><body>${t}</body></html>`;
}

// ── 代码运行预览:应用内弹层 + 沙箱 iframe(代码/预览可切换)──
let codePreviewEl = null;
function openCodePreview(html) {
  if (!codePreviewEl) {
    codePreviewEl = document.createElement('div');
    codePreviewEl.className = 'preview-overlay';
    codePreviewEl.innerHTML = `
      <div class="preview-box">
        <div class="preview-head">
          <div class="preview-title">运行预览</div>
          <div class="preview-tabs">
            <button class="pv-tab active" data-tab="preview">预览</button>
            <button class="pv-tab" data-tab="code">代码</button>
          </div>
          <button class="preview-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="preview-body">
          <iframe class="pv-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerpolicy="no-referrer"></iframe>
          <pre class="pv-code hidden"><code></code></pre>
        </div>
      </div>
    `;
    document.body.appendChild(codePreviewEl);
    // 点遮罩 / 关闭按钮 / Esc 关闭
    codePreviewEl.addEventListener('click', (e) => { if (e.target === codePreviewEl) closeCodePreview(); });
    codePreviewEl.querySelector('.preview-close').addEventListener('click', closeCodePreview);
    // 代码/预览切换
    codePreviewEl.querySelectorAll('.pv-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        codePreviewEl.querySelectorAll('.pv-tab').forEach((t) => t.classList.toggle('active', t === tab));
        const showCode = tab.dataset.tab === 'code';
        codePreviewEl.querySelector('.pv-frame').classList.toggle('hidden', showCode);
        codePreviewEl.querySelector('.pv-code').classList.toggle('hidden', !showCode);
      });
    });
  }
  // 填充内容
  const pvCode = codePreviewEl.querySelector('.pv-code code');
  if (typeof hljs !== 'undefined') {
    try { pvCode.innerHTML = hljs.highlight(html, { language: 'xml', ignoreIllegals: true }).value; pvCode.className = 'hljs language-xml'; }
    catch { pvCode.textContent = html; }
  } else {
    pvCode.textContent = html;
  }
  const frame = codePreviewEl.querySelector('.pv-frame');
  frame.srcdoc = wrapPreviewHtml(html);      // 沙箱渲染,脚本可跑但无法访问本应用
  // 默认回到「预览」标签
  codePreviewEl.querySelectorAll('.pv-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'preview'));
  frame.classList.remove('hidden');
  codePreviewEl.querySelector('.pv-code').classList.add('hidden');
  codePreviewEl.classList.add('show');
}
function closeCodePreview() {
  if (codePreviewEl) {
    codePreviewEl.classList.remove('show');
    codePreviewEl.querySelector('.pv-frame').srcdoc = 'about:blank';  // 卸载,停止脚本
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && codePreviewEl && codePreviewEl.classList.contains('show')) closeCodePreview();
});

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
        aria-checked="${active}" data-value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</button>
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
      if (!button || button.classList.contains('active')) return;
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
      const current = Math.max(0, buttons.indexOf(document.activeElement));
      let next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
      if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      event.preventDefault();
      selectButton(buttons[next], true);
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

function bindCustomSelects(rootEl) {
  rootEl.querySelectorAll('.custom-select').forEach((root) => {
    const trigger = root.querySelector('.cs-trigger');
    const popup   = root.querySelector('.cs-popup');
    const text    = root.querySelector('.cs-text');
    const opts    = root.querySelectorAll('.cs-option');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      // 关掉其他打开的
      document.querySelectorAll('.custom-select .cs-popup').forEach((p) => {
        if (p !== popup) p.hidden = true;
      });
      if (popup.hidden) {
        // 用 fixed 定位脱离设置滚动区裁剪；根据触发器上下剩余空间自动选择展开方向。
        const r = trigger.getBoundingClientRect();
        const gap = 4;
        const edge = 10;
        popup.style.position = 'fixed';
        popup.style.right    = `${window.innerWidth - r.right}px`;
        const requestedWidth = Number(root.dataset.popupWidth) || 0;
        popup.style.minWidth = `${Math.max(r.width, requestedWidth)}px`;
        popup.style.zIndex   = '1100';
        const requestedHeight = Math.max(120, Number(root.dataset.popupHeight) || 264);
        popup.style.maxHeight = `${requestedHeight}px`;
        popup.style.visibility = 'hidden';
        popup.hidden = false;

        const desiredHeight = Math.min(requestedHeight, popup.scrollHeight);
        const belowSpace = Math.max(0, window.innerHeight - r.bottom - gap - edge);
        const aboveSpace = Math.max(0, r.top - gap - edge);
        const openAbove = belowSpace < desiredHeight && aboveSpace > belowSpace;
        const available = Math.max(48, Math.floor(openAbove ? aboveSpace : belowSpace));
        popup.style.maxHeight = `${Math.min(requestedHeight, available)}px`;
        popup.classList.toggle('open-up', openAbove);
        if (openAbove) {
          popup.style.top = 'auto';
          popup.style.bottom = `${window.innerHeight - r.top + gap}px`;
        } else {
          popup.style.top = `${r.bottom + gap}px`;
          popup.style.bottom = 'auto';
        }
        popup.style.visibility = '';

        const selected = popup.querySelector('.cs-option.selected');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
      } else {
        popup.hidden = true;
      }
    });

    opts.forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        root.dataset.value = val;
        text.textContent = opt.textContent.trim();
        opts.forEach((o) => o.classList.toggle('selected', o === opt));
        popup.hidden = true;
      });
    });
  });
}

// 全局:点击空白处关下拉
document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select .cs-popup').forEach((p) => (p.hidden = true));
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
  if (!$('set-apiKey')) return;   // 主表单未挂载,忽略
  const payload = {
    claude: {
      apiKey:              $('set-apiKey').value.trim(),
      baseUrl:             $('set-baseUrl').value.trim(),
      opusModel:           $('set-opusModel').value.trim(),
      sonnetModel:         $('set-sonnetModel').value.trim(),
      haikuModel:          $('set-haikuModel').value.trim(),
      defaultModel:        $('set-defaultModel').dataset.value,
      alwaysThinking:      $('sw-alwaysThinking').classList.contains('on'),
      skipDangerousPrompt: $('sw-skipDangerous').classList.contains('on'),
    },
    app: {
      permissionMode:      $('set-permMode').dataset.value,
      allowCommandTasks:   $('sw-allowCommand') ? $('sw-allowCommand').classList.contains('on') : false,
      miniInputEnabled:    $('sw-miniInput') ? $('sw-miniInput').classList.contains('on') : true,
      conversationIndex:   $('sw-conversationIndex') ? $('sw-conversationIndex').classList.contains('on') : true,
      theme:               $('set-theme') ? $('set-theme').dataset.value : undefined,
    },
    imageApi: {
      apiKey:  $('set-imgKey') ? $('set-imgKey').value.trim() : undefined,
      baseUrl: $('set-imgBaseUrl') ? $('set-imgBaseUrl').value.trim() : undefined,
    },
  };
  await window.api.settings.write(payload);
  // 主题即时切换
  if (payload.app && payload.app.theme) {
    _themeSetting = payload.app.theme;
    applyThemeToDOM(_themeSetting);
  }
  setConversationIndexEnabled(payload.app.conversationIndex);
  // 同步「默认档」缓存
  if (payload.claude && payload.claude.defaultModel) defaultModel = payload.claude.defaultModel;
  imageConfigLoaded = false;   // 图像配置可能改了,下次进创作页重载模型
  // 应用名称(品牌)单独存到 app-settings,并即时刷新侧边栏
  if ($('set-brandName')) {
    await window.api.brand.setName($('set-brandName').value);
    applyBrand();
  }
  // PM 名称单独存(头像在选图时已即时存);失效群聊 PM 缓存,下次重新取
  if ($('set-pmName')) {
    await window.api.pm.setName($('set-pmName').value);
    pmBrandCache = null;
  }
  modalHint.textContent = '✓ 已保存';
  setTimeout(() => { modalHint.textContent = ''; }, 1500);
}

// ─────────────────────────────────────────
// 定时任务视图
// ─────────────────────────────────────────
(function initScheduleView() {
  const sched = (window.api && window.api.scheduler) || null;
  const scheduleModalEl = $('scheduleModal');   // 弹出式模态（仿「库」）
  if (!sched || !scheduleModalEl) return;

  const btnNavs     = ['btnSchedule', 'cvBtnSchedule'].map((id) => $(id)).filter(Boolean);   // 聊天/创作两个头部入口
  const modalTitle  = $('svModalTitle');
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
  let editingTask = null;
  let creatingTask = false;
  let scheduleItems = [];
  bindTransientScrollbar(listPane);
  bindTransientScrollbar(editorPane);

  // ── 弹出/关闭模态（沿用设置模态：.modal-backdrop 用 .hidden 控制显隐）──
  const isModalOpen = () => !scheduleModalEl.classList.contains('hidden');
  function showScheduleList() {
    editingTask = null;
    creatingTask = false;
    if (modalTitle) modalTitle.textContent = '定时任务';
    if (addBtn) addBtn.classList.remove('hidden');
    if (listPane) listPane.classList.remove('hidden');
    if (editorPane) {
      editorPane.classList.add('hidden');
      editorPane.innerHTML = '';
    }
    if (editorFooter) editorFooter.classList.add('hidden');
    if (editorSave) {
      editorSave.onclick = null;
      editorSave.disabled = false;
    }
    if (editorHint) editorHint.textContent = '';
  }
  function showScheduleView() {
    showScheduleList();
    if (searchInput) searchInput.value = '';
    scheduleModalEl.classList.remove('hidden');
    refresh();
  }
  function closeScheduleModal() {
    scheduleModalEl.classList.add('hidden');
    showScheduleList();
  }
  btnNavs.forEach((b) => b.addEventListener('click', showScheduleView));
  // 关闭：右上角 ×、点背景遮罩、Esc
  const closeBtn = $('svModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeScheduleModal);
  scheduleModalEl.addEventListener('click', (e) => { if (e.target === scheduleModalEl) closeScheduleModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isModalOpen()) return;
    if (editingTask || creatingTask) showScheduleList();
    else closeScheduleModal();
  });
  if (editorBack) editorBack.addEventListener('click', showScheduleList);
  if (addBtn) addBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    openTaskEditor(null);
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
    let items = [];
    try { const r = await sched.list(); if (r && r.ok) items = r.items || []; } catch (_) {}
    scheduleItems = items;
    renderFilteredList();
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
      repeat: 'custom',
      time: '09:00',
      weekDay: '1',
      monthDay: '1',
      customRepeat: 'monthly',
      customInterval: '1',
      cron: String(s.cron || '0 9 * * *'),
    };
    if (s.kind === 'at') {
      const date = new Date(Date.parse(s.at || ''));
      state.repeat = 'custom';
      state.customRepeat = 'monthly';
      state.customInterval = '1';
      if (!isNaN(date)) {
        state.monthDay = String(date.getDate());
        state.time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
      return state;
    }
    if (s.kind === 'every') {
      const ms = Math.max(1000, Number(s.everyMs) || 3600000);
      state.repeat = 'custom';
      state.customRepeat = 'daily';
      state.customInterval = String(Math.min(12, Math.max(1, Math.round(ms / 86400000))));
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
      state.repeat = 'custom';
      const monthStep = month.match(/^\*\/(\d{1,2})$/);
      const dayStep = dom.match(/^\*\/(\d{1,2})$/);
      if (dow === '*' && /^(?:[1-9]|[12]\d|3[01])$/.test(dom) && monthStep) {
        state.customRepeat = 'monthly';
        state.customInterval = String(Math.min(12, Number(monthStep[1])));
        state.monthDay = dom;
      } else if (month === '*' && dow === '*' && dayStep) {
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

  function openTaskEditor(task) {
    if (!editorPane || !editorFooter || !editorSave) return;
    const isNew = !task;
    creatingTask = isNew;
    task = task || {
      name: '',
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { type: 'chat', prompt: '', model: 'haiku', memory: 'read' },
      delivery: { notify: true, saveToHistory: true },
    };
    editingTask = isNew ? null : task;
    const action = task.action || {};
    const scheduleState = parseScheduleForEditor(task.schedule);
    const taskType = ['chat', 'image', 'command'].includes(action.type) ? action.type : 'chat';
    const model = ['haiku', 'sonnet', 'opus'].includes(action.model) ? action.model : 'haiku';
    const memory = ['off', 'read', 'readwrite'].includes(action.memory) ? action.memory : 'read';
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

    if (modalTitle) modalTitle.textContent = isNew ? '新建定时任务' : '编辑定时任务';
    if (addBtn) addBtn.classList.add('hidden');
    if (listPane) listPane.classList.add('hidden');
    editorPane.classList.remove('hidden');
    editorFooter.classList.remove('hidden');
    if (editorHint) editorHint.textContent = '';
    editorPane.innerHTML = `
      <div class="sv-editor">
        <section class="sv-edit-primary">
          <input class="sv-edit-name" id="svEditName" maxlength="80" autocomplete="off"
            aria-label="任务名称" placeholder="${isNew ? '已安排任务标题' : '任务名称'}">
          <textarea class="sv-edit-prompt" id="svEditPrompt" spellcheck="false"
            aria-label="任务内容" placeholder="${isNew ? '描述 Relay 应该做什么' : '任务内容'}"></textarea>
        </section>

        <section class="sv-edit-section">
          <div class="sv-edit-section-title">详情</div>
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
          </div>
        </section>
      </div>
    `;

    const nameInput = editorPane.querySelector('#svEditName');
    const promptInput = editorPane.querySelector('#svEditPrompt');
    const typeRoot = editorPane.querySelector('#svEditType');
    const modelRoot = editorPane.querySelector('#svEditModel');
    const memoryRoot = editorPane.querySelector('#svEditMemory');
    const repeatRoot = editorPane.querySelector('#svEditRepeat');
    const customRepeatRoot = editorPane.querySelector('#svEditCustomRepeat');
    const customIntervalInput = editorPane.querySelector('#svEditCustomInterval');
    const weekRoot = editorPane.querySelector('#svEditWeekDay');
    const timeRoot = editorPane.querySelector('#svEditTime');
    const monthDayRoot = editorPane.querySelector('#svEditMonthDay');

    nameInput.value = task.name || '';
    promptInput.value = promptText;

    const resizePromptInput = () => {
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
      root.dataset.popupWidth = '150';
      root.dataset.popupHeight = '360';
    });
    bindCustomSelects(editorPane);
    bindSettingsSegmented(editorPane);
    bindTransientScrollbar(promptInput);

    const updateTypeRows = () => {
      const chat = typeRoot.dataset.value === 'chat';
      editorPane.querySelectorAll('[data-sv-chat-only]').forEach((row) => row.classList.toggle('hidden', !chat));
      const command = typeRoot.dataset.value === 'command';
      promptInput.placeholder = command ? '执行命令' : (isNew ? '描述 Relay 应该做什么' : '任务内容');
      promptInput.setAttribute('aria-label', command ? '执行命令' : '任务内容');
      promptInput.classList.toggle('sv-mono', command);
    };
    const updateScheduleRows = () => {
      const repeat = repeatRoot.dataset.value;
      const custom = repeat === 'custom';
      const customRepeat = customRepeatRoot.dataset.value;
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
    repeatRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateScheduleRows));
    customRepeatRoot.querySelectorAll('.cs-option').forEach((option) => option.addEventListener('click', updateScheduleRows));
    updateTypeRows();
    updateScheduleRows();

    const buildEditedSchedule = () => {
      const repeat = repeatRoot.dataset.value;
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

    editorSave.onclick = async () => {
      const name = nameInput.value.trim();
      const text = promptInput.value.trim();
      if (!name) { editorHint.textContent = '请输入任务名称'; nameInput.focus(); return; }
      if (!text) { editorHint.textContent = typeRoot.dataset.value === 'command' ? '请输入执行命令' : '请输入任务内容'; promptInput.focus(); return; }
      editorSave.disabled = true;
      editorHint.textContent = '正在保存…';
      try {
        const enabled = task.enabled !== false;
        const schedule = buildEditedSchedule();
        const preview = await sched.preview(schedule);
        const completedOnce = !enabled && schedule.kind === 'at';
        if (!preview || !preview.ok || (!(preview.times || []).length && !completedOnce)) {
          throw new Error('调度设置无效，无法计算下次运行时间');
        }
        const type = typeRoot.dataset.value;
        const editedAction = {
          ...(task.action || {}),
          type,
        };
        if (type === 'command') editedAction.command = text;
        else editedAction.prompt = text;
        if (type === 'chat') {
          editedAction.model = modelRoot.dataset.value;
          editedAction.memory = memoryRoot.dataset.value;
        }
        const payload = {
          name,
          enabled: task.enabled !== false,
          schedule,
          action: editedAction,
          delivery: {
            ...(task.delivery || {}),
            notify: true,
            saveToHistory: true,
          },
        };
        const result = isNew
          ? await sched.create(payload)
          : await sched.update(task.id, payload);
        if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
        showToast(isNew ? '定时任务已创建' : '定时任务已保存');
        if (isNew && searchInput) searchInput.value = '';
        showScheduleList();
        refresh();
      } catch (e) {
        editorHint.textContent = (e && e.message) || '保存失败';
      } finally {
        editorSave.disabled = false;
      }
    };
    requestAnimationFrame(() => nameInput.focus());
  }

  function showTaskContextMenu(e, task) {
    e.preventDefault();
    e.stopPropagation();
    const pop = ensureCopyPopover();
    const editBtn = pop.querySelector('.cp-btn:not(.cp-del)');
    const delBtn = pop.querySelector('.cp-del');
    const editLabel = editBtn.querySelector('span');
    const editKbd = editBtn.querySelector('kbd');
    if (editLabel) editLabel.textContent = '编辑';
    if (editKbd) editKbd.style.display = 'none';
    editBtn.onclick = () => {
      hideCopyPopover();
      openTaskEditor(task);
    };
    delBtn.hidden = false;
    delBtn.querySelector('span').textContent = '删除';
    delBtn.onclick = async () => {
      hideCopyPopover();
      const yes = await customConfirm({
        title: '删除定时任务',
        message: `确定删除「${task.name || '未命名任务'}」？此操作无法撤销。`,
        confirmText: '删除',
        danger: true,
      });
      if (!yes) return;
      await sched.remove(task.id);
      refresh();
    };
    const menuWidth = 112;
    const menuHeight = 78;
    let x = e.clientX;
    let y = e.clientY + 6;
    if (x + menuWidth > window.innerWidth - 8) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight - 8) y = e.clientY - menuHeight - 6;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    pop.classList.add('show');
  }

  function renderList(items, { query = '', total = items.length } = {}) {
    // 清掉旧卡片（保留 emptyEl）
    Array.from(listEl.querySelectorAll('.sv-card')).forEach((c) => c.remove());
    if (!items.length) {
      const emptyTitle = emptyEl.querySelector('h2');
      const emptyText = emptyEl.querySelector('p:not(.sv-note)');
      const emptyNote = emptyEl.querySelector('.sv-note');
      if (query && total > 0) {
        if (emptyTitle) emptyTitle.textContent = '没有找到相关任务';
        if (emptyText) emptyText.textContent = '试试搜索其他任务标题';
        if (emptyNote) emptyNote.style.display = 'none';
      } else {
        if (emptyTitle) emptyTitle.textContent = '⏰ 还没有定时任务';
        if (emptyText) emptyText.innerHTML = '点击左上角“＋”创建任务，也可以在对话框里直接告诉 Relay。';
        if (emptyNote) emptyNote.style.display = '';
      }
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';

    for (const task of items) {
      const card = document.createElement('div');
      card.className = 'sv-card' + (task.enabled ? '' : ' paused');

      const badge = task.lastStatus === 'ok' ? '<span class="sv-badge ok">上次成功</span>'
        : task.lastStatus === 'error' ? '<span class="sv-badge error">上次失败</span>'
        : '<span class="sv-badge idle">未运行</span>';

      const top = document.createElement('div');
      top.className = 'sv-card-top';
      top.innerHTML =
        `<button class="sv-card-run" type="button" title="立即运行" aria-label="立即运行">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.8v10.4c0 .7.8 1.1 1.4.7l7.4-5.2a.85.85 0 0 0 0-1.4L5.4 2.1c-.6-.4-1.4 0-1.4.7Z"/></svg>
        </button><span class="sv-card-name"></span>` + badge +
        `<label class="sv-switch" title="${task.enabled ? '点击暂停' : '点击启用'}"><input type="checkbox" ${task.enabled ? 'checked' : ''}/><span class="sv-slider"></span></label>`;
      top.querySelector('.sv-card-name').textContent = task.name || '未命名任务';
      const runBtn = top.querySelector('.sv-card-run');
      runBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (runBtn.disabled) return;
        runBtn.disabled = true;
        runBtn.classList.add('running');
        try {
          const result = await sched.runNow(task.id);
          showToast(result && result.ok === false ? (result.error || '运行失败') : '任务已开始运行');
        } catch (_) {
          showToast('运行失败');
        } finally {
          runBtn.disabled = false;
          runBtn.classList.remove('running');
          refresh();
        }
      });
      top.querySelector('input').addEventListener('change', async (e) => {
        await sched.toggle(task.id, e.target.checked); refresh();
      });

      const atype = (task.action && task.action.type) || 'chat';
      const typeTag = atype === 'image' ? '<span class="sv-type-tag">出图</span>'
        : atype === 'command' ? '<span class="sv-type-tag cmd">命令</span>' : '';
      const meta = document.createElement('div');
      meta.className = 'sv-card-meta';
      meta.innerHTML =
        typeTag +
        `<span>${schedDesc(task)}</span>` +
        `<span>下次：<b>${task.enabled ? fmtNext(task.nextRunAt) : '已暂停'}</b></span>` +
        (task.runCount > 0 ? `<span>已运行 ${task.runCount} 次</span>` : '');

      const prompt = document.createElement('div');
      prompt.className = 'sv-card-prompt';
      // 命令任务显示脚本（等宽），其余显示 prompt
      if (atype === 'command') { prompt.classList.add('mono'); prompt.textContent = (task.action && task.action.command) || ''; }
      else prompt.textContent = (task.action && task.action.prompt) || '';

      card.title = '右键编辑或删除';
      card.addEventListener('contextmenu', (e) => showTaskContextMenu(e, task));
      card.append(top, meta, prompt);
      listEl.appendChild(card);
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

$('btnSettingsSave').addEventListener('click', () => { if (activeSaveHandler) activeSaveHandler(); });
