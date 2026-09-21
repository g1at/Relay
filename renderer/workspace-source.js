(function (root) {
  'use strict';
  function render(host, { path = '', content = '' } = {}) {
    const text = typeof content === 'string' ? content : '';
    const type = root.relayWorkspaceFileTypes?.describe(path);
    const name = type?.name || path.replace(/\\/g, '/').split('/').pop() || '文件';
    const card = document.createElement('div'); card.className = 'workspace-source-card';
    const head = document.createElement('div'); head.className = 'workspace-source-head';
    const lights = document.createElement('span'); lights.className = 'workspace-source-lights'; lights.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) lights.append(document.createElement('i'));
    const title = document.createElement('span'); title.className = 'workspace-source-name'; title.textContent = name; title.title = path;
    const label = document.createElement('span'); label.className = 'workspace-source-language'; label.textContent = type?.label || '文本';
    head.append(lights, title, label);
    const pre = document.createElement('pre'); pre.className = 'workspace-source'; pre.tabIndex = 0; pre.setAttribute('aria-label', '只读源码：' + name);
    const code = document.createElement('code'); code.className = 'workspace-source-code'; code.textContent = text;
    // Keep a single text/highlight tree: no per-line HTML splitting that could
    // break multiline tokens, and no HTML execution or remote syntax grammars.
    const language = type?.language;
    if (language && text.length < 100000 && root.hljs?.getLanguage(language)) {
      try {
        const highlighted = root.hljs.highlight(text, { language, ignoreIllegals: true });
        code.innerHTML = highlighted.value;
        code.classList.add('hljs', 'language-' + language);
      } catch (_) { code.textContent = text; }
    }
    const count = text.split(/\r\n|\r|\n/).length;
    const lines = document.createElement('span'); lines.className = 'workspace-source-lines'; lines.setAttribute('aria-hidden', 'true');
    lines.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
    // DOM order keeps the source first; CSS places the unselectable gutter left.
    pre.append(code, lines); card.append(head, pre); host.replaceChildren(card);
    host.classList.add('is-source'); host.tabIndex = -1;
    return { scrollElement: pre, lineCount: count };
  }
  root.relayRenderWorkspaceSource = render;
})(window);
