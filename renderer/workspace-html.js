(function (root) {
  'use strict';
  const POLICY = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const SCROLLBARS = 'html{color-scheme:light}*{scrollbar-width:auto!important;scrollbar-color:auto!important}::-webkit-scrollbar{width:9px;height:9px;background:transparent}::-webkit-scrollbar-thumb{background:#c5c6ca;border:2px solid transparent;background-clip:padding-box;border-radius:9px}::-webkit-scrollbar-thumb:hover{background-color:#999ba1}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}';

  // Files run in an opaque sandbox: scripts can operate their own document but
  // cannot access Relay's DOM, preload or local storage. CSP blocks external
  // resources and fetch requests; this is not an operating-system sandbox.
  // Direct local assets are read by the same workspace-scoped bridge as links.
  async function mount(body, preview, options = {}) {
    const frame = document.createElement('iframe');
    frame.className = 'workspace-html-frame'; frame.name = 'relay-local-html';
    frame.title = 'HTML 预览'; frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    body.classList.add('is-html-preview'); body.setAttribute('aria-busy', 'true'); body.append(frame);
    const current = () => frame.isConnected && frame.parentElement === body;
    // Detached documents never execute scripts. The final CSP precedes every
    // supplied element and cannot be relaxed by another policy in the file.
    const doc = new DOMParser().parseFromString('<meta http-equiv="Content-Security-Policy" content="' + POLICY + '">' + String(preview.content || ''), 'text/html');
    doc.querySelectorAll('base,meta[http-equiv],iframe,frame,object,embed').forEach(node => node.remove());
    let omitted = doc.querySelectorAll('[srcset]').length, total = 0;
    const unresolvedCss = text => /@import\b|url\(\s*["']?(?!data:|blob:|#)[^\s"')]/i.test(text);
    if ([...doc.querySelectorAll('style,[style]')].some(node => unresolvedCss(node.textContent + (node.getAttribute('style') || '')))) omitted++;
    if ([...doc.querySelectorAll('script[type="module"]')].some(node => /\b(?:import|export)\b/.test(node.textContent))) omitted++;
    const nodes = [...doc.querySelectorAll('script[src],link[rel="stylesheet"][href],img[src]')];
    for (const [index, node] of nodes.entries()) {
      const attr = node.tagName === 'LINK' ? 'href' : 'src', href = node.getAttribute(attr);
      if (node.tagName === 'IMG' && /^data:image\//i.test(href)) continue;
      node.removeAttribute(attr);
      if (!current()) return;
      const parsed = root.RelayLocalFileLinks?.parse(href);
      if (!parsed || !options.readLink || total >= 16 * 1024 * 1024 || index >= 40) { omitted++; continue; }
      try {
        const result = await options.readLink({ href, context: options.context, basePath: preview.absolutePath || preview.path });
        if (!current()) return;
        if (!result?.ok || result.binary || result.truncated) throw Error('Asset unavailable');
        total += result.size || (result.content || result.dataUrl || '').length;
        if (total > 16 * 1024 * 1024) throw Error('Preview too large');
        if (node.tagName === 'IMG') {
          if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(result.dataUrl || '')) throw Error('Unsupported image');
          node.setAttribute('src', result.dataUrl);
        } else if (typeof result.content === 'string') {
          if (node.tagName === 'LINK' && unresolvedCss(result.content)
            || node.getAttribute('type') === 'module' && /\b(?:import|export)\b/.test(result.content)) omitted++;
          // A data URL preserves external-script defer/module ordering and
          // avoids serializing literal </script> or </style> inside HTML.
          node.setAttribute(attr, 'data:' + (node.tagName === 'LINK' ? 'text/css' : 'text/javascript')
            + ';charset=utf-8,' + encodeURIComponent(result.content));
        } else throw Error('Unsupported asset');
      } catch (_) { omitted++; }
    }
    if (!current()) return;
    const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = POLICY;
    const style = doc.createElement('style'); style.textContent = SCROLLBARS; doc.head.prepend(policy); doc.head.append(style);
    frame.addEventListener('load', () => { if (current()) body.removeAttribute('aria-busy'); }, { once: true });
    frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
    options.onReady?.(omitted ? '交互预览 · 部分依赖未加载，可在本地浏览器查看完整页面' : '交互预览');
  }
  root.RelayWorkspaceHtml = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
