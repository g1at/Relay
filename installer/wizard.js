// wizard.js — 首次设置向导前端

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

let currentStep = 1;
let probeResult = null;

// ──────── 步骤切换 ────────
function goto(step) {
  currentStep = step;
  $$('.page').forEach(p => p.classList.toggle('active', +p.dataset.page === step));
  $$('.step').forEach(s => {
    const n = +s.dataset.step;
    s.classList.remove('active', 'done');
    if (n === step) s.classList.add('active');
    else if (n < step) s.classList.add('done');
  });
  updateFooter();
}

function updateFooter() {
  const prev = $('btnPrev');
  const next = $('btnNext');
  prev.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
  if (currentStep === 1) {
    next.textContent = '下一步';
    next.disabled = false;
  } else if (currentStep === 2) {
    next.textContent = '开始安装';
    next.disabled = $('apiKey').value.trim().length === 0;
  } else if (currentStep === 3) {
    next.textContent = '安装中…';
    next.disabled = true;
    prev.style.visibility = 'hidden';
  } else if (currentStep === 4) {
    next.textContent = '进入聊天';
    next.disabled = false;
    prev.style.visibility = 'hidden';
  }
}

// ──────── 启动:探测环境 ────────
(async () => {
  probeResult = await window.api.installer.probe();
  const map = {
    git:    probeResult.claudeOk,
    node:   probeResult.claudeOk,
    claude: probeResult.claudeOk,
    mcp:    probeResult.claudeOk,
  };
  for (const li of $$('#probeList li')) {
    const k = li.dataset.key;
    li.classList.add(map[k] ? 'ok' : 'missing');
  }
  if (probeResult.existingKey) $('apiKey').value = probeResult.existingKey;
  updateFooter();
})();

// ──────── 安装步骤清单(主视觉)────────
// 清单里的步骤号:1=基础环境 2=Claude Code 3=飞书 MCP 5=收尾(与脚本 Step 编号对齐;
//   脚本里没有 Step 4,4 段是 1-install-deps 内部的子步,统一并到「基础环境」)。
const STEP_ORDER = [1, 2, 3, 5];
const STEP_LABEL = {
  1: '安装基础环境(Git / Node.js)…',
  2: '安装 Claude Code…',
  3: '配置飞书 MCP…',
  5: '收尾检查…',
};
let curStepNum = 0;

function stepLi(n) { return document.querySelector(`#installSteps li[data-step="${n}"]`); }

// 进入某一步:把它标记为进行中,并把它之前的所有步标记为完成。
function enterStep(n) {
  if (!STEP_ORDER.includes(n)) return;   // 忽略 Step 0(环境体检)等清单外的编号
  if (n === curStepNum) return;
  curStepNum = n;
  for (const s of STEP_ORDER) {
    const li = stepLi(s);
    if (!li) continue;
    li.classList.remove('running', 'done', 'pending');
    if (s < n)       li.classList.add('done');
    else if (s === n) li.classList.add('running');
    else              li.classList.add('pending');
  }
  // 进度条:按清单里第几个步推进(均分),收尾步给到 ~92%,全部完成时外部置 100%
  const idx = STEP_ORDER.indexOf(n);
  const pct = idx < 0 ? 0 : Math.round(((idx + 1) / STEP_ORDER.length) * 92);
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = STEP_LABEL[n] || '安装中…';
}

// 全部完成:清单全勾,进度满
function markAllStepsDone() {
  for (const s of STEP_ORDER) {
    const li = stepLi(s);
    if (li) { li.classList.remove('running', 'pending'); li.classList.add('done'); }
  }
  $('progressFill').style.width = '100%';
}

// 把一行原始日志清洗成「干净文本 + 级别」,不适合展示的返回 null(过滤掉)。
function cleanLogLine(raw) {
  let s = raw.replace(/\r$/, '');
  // 去掉 ASCII 边框 / 横幅盒子(║ ═ ╔ 之类,以及横线分隔)
  if (/^[\s║╔╗╚╝═╠╣╦╩╬|+\-=_~]*$/.test(s)) return null;
  if (/Relay\s*[—\-]\s*一键安装|取决于网络/.test(s)) return null;
  // 解析级别 + 去掉时间戳/[LEVEL] 前缀:形如 "[2026-.. ..:..:..] [OK] xxx"
  let level = 'info';
  const m = s.match(/^\[[\d\-: ]+\]\s*\[(OK|WARN|ERROR|INFO)\]\s*(.*)$/i);
  if (m) { level = m[1].toLowerCase(); s = m[2]; }
  else {
    // 没时间戳但带 [LEVEL]
    const m2 = s.match(/^\[(OK|WARN|ERROR|INFO)\]\s*(.*)$/i);
    if (m2) { level = m2[1].toLowerCase(); s = m2[2]; }
  }
  // Step 标题行:"========== Step 2: xxx ==========" → 提取标题(单独走步骤清单,不进 feed)
  const stepTitle = s.match(/=*\s*(Step\s*\d[:：][^=]*?)\s*=*$/i);
  if (stepTitle) return { kind: 'step-title', text: stepTitle[1].trim() };
  s = s.replace(/^=+\s*|\s*=+$/g, '').trim();   // 去残留等号
  if (!s) return null;
  return { kind: 'log', level, text: s };
}

const LEVEL_ICON = { ok: '✓', warn: '⚠', error: '✕', info: '·' };

// ──────── 监听 PowerShell 日志 ────────
window.api.installer.onLog(({ stream, text }) => {
  const box = $('logBox');

  // 先按整块文本抓 Step 编号,推进清单(一块里可能含多行)
  let mStep;
  const reStep = /Step\s*(\d)/g;
  while ((mStep = reStep.exec(text))) enterStep(parseInt(mStep[1], 10));
  // 也识别 1-install-deps 里的 [1/4]…[4/4] 子步 → 归入「基础环境」(Step 1)
  if (/\[[1-4]\/4\]/.test(text) && curStepNum < 1) enterStep(1);

  // 逐行清洗后渲染到精简日志
  for (const rawLn of text.split('\n')) {
    if (!rawLn.trim()) continue;
    const parsed = cleanLogLine(rawLn);
    if (!parsed) continue;
    if (parsed.kind === 'step-title') {
      const div = document.createElement('div');
      div.className = 'lf-step';
      div.textContent = parsed.text;
      box.appendChild(div);
      continue;
    }
    const div = document.createElement('div');
    div.className = `lf-line lf-${parsed.level}`;
    const ic = document.createElement('span');
    ic.className = 'lf-ico';
    ic.textContent = LEVEL_ICON[parsed.level] || '·';
    const tx = document.createElement('span');
    tx.className = 'lf-text';
    tx.textContent = parsed.text;
    div.appendChild(ic);
    div.appendChild(tx);
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
});

// 往精简日志里推一条错误行(用统一的 feed 样式,不再用裸 [启动失败])
function pushErrorLine(text) {
  const box = $('logBox');
  const div = document.createElement('div');
  div.className = 'lf-line lf-error';
  const ic = document.createElement('span'); ic.className = 'lf-ico'; ic.textContent = '✕';
  const tx = document.createElement('span'); tx.className = 'lf-text'; tx.textContent = text;
  div.appendChild(ic); div.appendChild(tx);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function markInstallFailed() {
  // 把进行中的那步标红
  const li = stepLi(curStepNum);
  if (li) { li.classList.remove('running'); li.classList.add('failed'); }
  $('progressText').textContent = '安装失败，请查看下方日志';
  $('btnNext').disabled = false;
  $('btnNext').textContent = '重试';
  $('btnPrev').style.visibility = 'visible';
}

// ──────── 按钮事件 ────────
$('btnPrev').addEventListener('click', () => {
  if (currentStep > 1) goto(currentStep - 1);
});

$('btnNext').addEventListener('click', async () => {
  if (currentStep === 1) {
    goto(2);
  } else if (currentStep === 2) {
    const key = $('apiKey').value.trim();
    if (!key) return;
    goto(3);
    // 进入安装页:清单先全部置为「待办」,等首条日志推进到具体步骤
    for (const s of STEP_ORDER) {
      const li = stepLi(s);
      if (li) { li.classList.remove('running', 'done', 'failed'); li.classList.add('pending'); }
    }
    curStepNum = 0;
    const result = await window.api.installer.run(key);
    if (result.error) {
      pushErrorLine('启动失败：' + result.error);
      markInstallFailed();
      return;
    }
    if (result.exitCode !== 0) {
      pushErrorLine(`安装未完成(退出码 ${result.exitCode})，请查看日志`);
      markInstallFailed();
      return;
    }
    markAllStepsDone();
    $('progressText').textContent = '✓ 全部安装完成';
    goto(4);
  } else if (currentStep === 4) {
    await window.api.installer.complete();
  }
});

$('apiKey').addEventListener('input', updateFooter);
$('btnShowKey').addEventListener('click', () => {
  const el = $('apiKey');
  const showing = el.type === 'text';
  el.type = showing ? 'password' : 'text';
  $('btnShowKey').textContent = showing ? '显示' : '隐藏';
});
$('lnkGetKey').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.installer.openMifyKey();
});

// 飞书 MCP 授权已从向导移除:首次安装时新建的 cmd 窗口 PATH 上没有 npx,授权必失败。
//   改为在聊天里直接粘飞书链接触发授权(由 claude.exe 启动的 MCP server 拉起浏览器,稳定可靠)。
