(function (root) {
  'use strict';

  const bound = new WeakSet();
  const fileLinks = new WeakMap();
  let incremental, incrementalMarked, incrementalNormalize, incrementalFallback;
  const allowedTags = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'STRONG', 'EM', 'DEL', 'S',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'TABLE', 'THEAD', 'TBODY',
    'TFOOT', 'TR', 'TH', 'TD', 'SPAN', 'A', 'INPUT',
  ]);

  function externalHref(value) {
    const href = String(value || '').trim();
    if (!/^(?:https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return '';
    try {
      const url = new URL(href);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : '';
    } catch (_) { return ''; }
  }

  function bindLinks(container) {
    if (bound.has(container)) return;
    const onLink = event => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      const link = event.target && event.target.closest && event.target.closest('a');
      if (!link || !container.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
      const href = externalHref(link.getAttribute('href'));
      if (!href || !root.api || typeof root.api.openExternal !== 'function') return;
      try { Promise.resolve(root.relayBrowserSettings?.openLink ? root.relayBrowserSettings.openLink(href) : root.api.openExternal(href)).catch(() => {}); } catch (_) {}
    };
    container.addEventListener('click', onLink);
    container.addEventListener('auxclick', onLink);
    bound.add(container);
  }

  function sanitize(fragment, allowLocalFiles, allowLocalImages) {
    for (const node of [...fragment.querySelectorAll('*')]) {
      // Images are deliberately not mounted: even a detached <img> can send a
      // request. The template remains inert until this pass has finished.
      if (node.tagName === 'IMG') {
        const replacement = fragment.ownerDocument.createElement('span');
        replacement.className = 'readonly-image-label';
        replacement.textContent = node.getAttribute('alt') || '图片';
        node.replaceWith(replacement);
        continue;
      }
      if (!allowedTags.has(node.tagName)) {
        node.replaceWith(fragment.ownerDocument.createTextNode(node.textContent || ''));
        continue;
      }
      const originalHref = node.tagName === 'A' ? node.getAttribute('href') : '';
      // Only the explicit conversation-image opt-in can retain an inert local
      // placeholder. Arbitrary IMG/src/raw HTML remain disallowed everywhere.
      const localImage = node.tagName === 'SPAN' && node.getAttribute('data-relay-local-image');
      const imageAlt = node.getAttribute('data-image-alt');
      if (localImage && (!allowLocalImages || !root.RelayLocalFileLinks?.parse(localImage))) {
        node.textContent = imageAlt || '图片';
      }
      const href = externalHref(originalHref) || (allowLocalFiles && root.RelayLocalFileLinks?.parse(originalHref) ? originalHref : '');
      const title = node.getAttribute('title');
      const classes = [...node.classList].filter(value => /^(?:hljs(?:-[\w-]+)?|language-[\w-]+)$/.test(value));
      const checked = node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox' && node.hasAttribute('checked');
      const checkbox = node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox';
      const start = node.tagName === 'OL' ? node.getAttribute('start') : null;
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
      if (localImage && allowLocalImages && root.RelayLocalFileLinks?.parse(localImage)) {
        node.setAttribute('data-relay-local-image', localImage);
        node.setAttribute('data-image-alt', (imageAlt || '图片').slice(0, 4000));
        node.className = 'relay-local-image';
        node.setAttribute('aria-busy', 'true');
      }
      if (classes.length) node.className = classes.join(' ');
      if (title) node.setAttribute('title', title.slice(0, 1000));
      if (href) { node.setAttribute('href', href); node.setAttribute('rel', 'noopener noreferrer'); }
      if (start && /^\d{1,6}$/.test(start)) node.setAttribute('start', start);
      if (node.tagName === 'INPUT') {
        if (!checkbox) { node.remove(); continue; }
        node.type = 'checkbox'; node.disabled = true; node.checked = checked; node.tabIndex = -1;
      }
    }
  }

  function incrementalRenderer() {
    if (!root.RelayStreamMarkdown || !root.marked || typeof root.normalizeFences !== 'function') return null;
    // Use the main renderer's exact normalization and configured parser. Mini
    // and standalone readers without that pipeline retain their full renderer.
    if (!incremental || incrementalMarked !== root.marked || incrementalNormalize !== root.normalizeFences
        || incrementalFallback !== root.relayRenderMarkdown) {
      incrementalMarked = root.marked; incrementalNormalize = root.normalizeFences;
      incrementalFallback = root.relayRenderMarkdown;
      incremental = root.RelayStreamMarkdown.create({ marked: incrementalMarked,
        normalize: incrementalNormalize, fallback: incrementalFallback,
        prepareFragment: fragment => sanitize(fragment, false, false) });
    }
    return incremental;
  }

  root.relayRenderReadOnlyMarkdown = function renderReadOnlyMarkdown(container, text, options = {}) {
    if (!container || !container.ownerDocument) return;
    container.classList.add('relay-readonly-markdown');
    container.classList.remove('is-plain-text');
    bindLinks(container);
    const allowLocalFiles = !!(options.context || options.preview || options.fileLinks === true);
    if (!allowLocalFiles) { fileLinks.get(container)?.destroy(); fileLinks.delete(container); }
    const value = String(text == null ? '' : text);
    const previousCode = root.RelayCodeBlocks?.snapshot(container) || [];
    try {
      if (typeof root.relayRenderMarkdown !== 'function') throw new Error('Markdown renderer unavailable');
      // Only the narration stream opts in. File/image-enabled readers keep the
      // existing policy-specific full pass and link binding lifecycle.
      const stream = options.incremental === true && !allowLocalFiles && options.localImages !== true
        ? incrementalRenderer() : null;
      if (stream) stream.render(container, value);
      else {
        incremental?.release(container);
        const template = container.ownerDocument.createElement('template');
        template.innerHTML = root.relayRenderMarkdown(value);
        sanitize(template.content, allowLocalFiles, options.localImages === true);
        container.replaceChildren(template.content);
      }
      // Controls are trusted UI added only after sanitizing model Markdown.
      // A runnable preview is available in the main window via its injected
      // handler; compact/standalone readers still get copy and collapse.
      const enhance = root.relayEnhanceCodeBlocks || root.RelayCodeBlocks?.enhance;
      enhance?.(container, { collapse: false, previous: previousCode });
      if (allowLocalFiles && root.RelayLocalFileLinks) fileLinks.set(container, root.RelayLocalFileLinks.install(container, options));
    } catch (_) {
      incremental?.release(container);
      container.textContent = value;
      container.classList.add('is-plain-text');
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
