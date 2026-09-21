(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayCodeBlocks = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
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

function enhance(container, { collapse = true, preview, clipboard, onError, previous = [] } = {}) {
  if (!container) return;
  const document = container.ownerDocument;
  container.querySelectorAll('pre').forEach((pre, index) => {
    if (pre.classList.contains('md-fallback')) return;   // 解析失败的纯文本回退块,不是代码块,不加按钮/折叠
    if (pre.querySelector('.code-actions')) return;
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const codeText = codeEl.textContent || '';
    pre.classList.add('relay-code-block');
    const saved = previous[index];
    const keep = saved && (codeText.startsWith(saved.text) || saved.text.startsWith(codeText));

    const actions = document.createElement('div');
    actions.className = 'code-actions';

    // 运行按钮(仅完整网页代码)
    if (typeof preview === 'function' && isRunnableHtml(codeEl, codeText)) {
      const run = document.createElement('button');
      run.type = 'button'; run.className = 'code-run';
      run.title = '运行预览';
      run.innerHTML = `${RUN_ICON_SVG}<span>运行</span>`;
      run.addEventListener('click', (e) => {
        e.stopPropagation();
        try { Promise.resolve(preview(codeText)).catch(error => onError?.(error?.message || '无法打开预览')); }
        catch (error) { onError?.(error?.message || '无法打开预览'); }
      });
      actions.appendChild(run);
    }

    // 折叠/展开按钮(代码较长时才提供,并默认折叠)
    const lineCount = (codeText.match(/\n/g) || []).length + 1;
    if (lineCount > CODE_COLLAPSE_LINES) {
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'code-toggle';
      const setLabel = () => {
        const collapsed = pre.classList.contains('collapsed');
        toggle.innerHTML = `${CHEV_ICON_SVG}<span>${collapsed ? '展开' : '折叠'}</span>`;
        toggle.title = collapsed ? '展开代码' : '折叠代码';
      };
      if (keep && saved.toggled ? saved.collapsed : collapse) pre.classList.add('collapsed');
      if (keep && saved.toggled) pre.dataset.codeToggled = 'true';
      setLabel();
      // 底部渐隐遮罩(仅折叠态可见,由 CSS 控制显隐)
      const fade = document.createElement('div');
      fade.className = 'code-fade';
      pre.appendChild(fade);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        pre.dataset.codeToggled = 'true';
        pre.classList.toggle('collapsed');
        setLabel();
      });
      actions.appendChild(toggle);
    }

    // 复制按钮
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'code-copy';
    btn.title = '复制代码';
    btn.innerHTML = COPY_ICON_SVG;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // Process rows are enhanced inside an inert template before adoption.
        // Read the live owner document at click time, not the template document.
        await (clipboard || pre.ownerDocument.defaultView.navigator.clipboard).writeText(codeText);
        btn.classList.add('copied');
        btn.innerHTML = '✓';
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON_SVG; }, 1200);
      } catch {
        onError?.('复制失败');
      }
    });
    actions.appendChild(btn);

    pre.appendChild(actions);
    if (keep) { codeEl.scrollLeft = saved.scrollLeft; codeEl.scrollTop = saved.scrollTop; }

    // 折叠态点击代码区任意处也可展开(整块当“展开”热区,更易点)
    pre.addEventListener('click', (e) => {
      if (pre.classList.contains('collapsed') && !e.target.closest('.code-actions')) {
        pre.dataset.codeToggled = 'true';
        pre.classList.remove('collapsed');
        const t = actions.querySelector('.code-toggle');
        if (t) { t.innerHTML = `${CHEV_ICON_SVG}<span>折叠</span>`; t.title = '折叠代码'; }
      }
    });
  });
}

function snapshot(container) {
  return [...container.querySelectorAll('pre')].map(pre => ({ text: pre.querySelector('code')?.textContent || '',
    collapsed: pre.classList.contains('collapsed'), toggled: pre.dataset.codeToggled === 'true',
    scrollLeft: pre.querySelector('code')?.scrollLeft || 0, scrollTop: pre.querySelector('code')?.scrollTop || 0 }));
}
  return Object.freeze({ enhance, snapshot, isRunnableHtml });
});
