(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./local-file-links') : root?.RelayLocalFileLinks);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayLocalMarkdownImages = api;
})(typeof window === 'undefined' ? null : window, function (root, fileLinks) {
  'use strict';
  const IMAGE_LIMIT = 8 * 1024 * 1024;
  const CACHE_LIMIT = 16 * 1024 * 1024;
  const SELECTOR = 'span[data-relay-local-image]';
  const installed = new WeakMap();
  const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function bitmapDataUrl(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(IMAGE_LIMIT / 3) * 4 + 64) return false;
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[1].length % 4) return false;
    const bytes = match[1].length / 4 * 3 - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0);
    return bytes > 0 && bytes <= IMAGE_LIMIT;
  }

  // A local image never receives src until the privileged workspace reader has
  // checked its scope and bitmap bytes. This also prevents broken c:%5C requests
  // during the gap between streaming DOM insertion and observer hydration.
  function image(token, title, text) {
    const href = typeof token === 'object' ? token.href : token;
    const alt = String(typeof token === 'object' ? token.text || '' : text || '').slice(0, 4000);
    if (fileLinks?.parse(href)) return `<span class="relay-local-image" data-relay-local-image="${escape(href)}" data-image-alt="${escape(alt)}" aria-busy="true">${escape(alt || '图片')}</span>`;
    // Preserve existing web/inline bitmap rendering; other URI schemes never
    // become browser image requests. Read-only surfaces still omit web images.
    if (/^https?:\/\//i.test(String(href || '')) || bitmapDataUrl(href)) return false;
    return `<span class="relay-local-image is-unavailable">${escape(alt || '图片')} · 无法预览图片</span>`;
  }

  function install(container, options = {}) {
    if (!container?.ownerDocument) return null;
    if (installed.has(container)) return installed.get(container);
    const document = container.ownerDocument;
    const ownerWindow = document.defaultView || root;
    const nodes = new WeakMap(), cache = new Map(), queue = [];
    let epoch = 0, disposed = false, running = 0, cachedBytes = 0;
    const context = () => typeof options.context === 'function' ? options.context() : options.context;
    const basePath = () => typeof options.basePath === 'function' ? options.basePath() : options.basePath;
    const scope = (value, source = basePath()) => JSON.stringify([value?.conversationId || '', value?.workingDir || '', value?.projectId || '', source || '']);
    let currentScope = scope(context());
    const read = input => options.read ? options.read(input) : root?.api?.workspace?.readLink(input);

    function reset() {
      const nextScope = scope(context());
      if (!disposed && nextScope === currentScope) return;
      epoch += 1;
      currentScope = nextScope;
      cache.clear(); cachedBytes = 0;
      // Do not rescan old DOM under the newly selected conversation's authority.
      // Its replacement nodes will be hydrated by their own insertion events.
      pump();
    }
    function pump() {
      while (running < 2 && queue.length) {
        const task = queue.shift();
        if (disposed || task.epoch !== epoch) { task.resolve(null); continue; }
        running += 1;
        Promise.resolve().then(() => !disposed && task.epoch === epoch && scope(task.input.context, task.input.basePath) === scope(context()) ? read(task.input) : null).then(value => {
          task.resolve(value?.ok && bitmapDataUrl(value.dataUrl) ? value.dataUrl : null);
        }, () => task.resolve(null)).finally(() => { running -= 1; pump(); });
      }
    }
    function load(href, captured) {
      const key = href;
      if (cache.has(key)) return cache.get(key).promise;
      let resolve;
      const entry = { size: 0, promise: new Promise(done => { resolve = done; }) };
      cache.set(key, entry);
      const requestedEpoch = epoch;
      const source = basePath();
      queue.push({ epoch, input: { href, context: { ...captured }, ...(source ? { basePath: source } : {}) }, resolve });
      pump();
      entry.promise.then(dataUrl => {
        if (requestedEpoch !== epoch || cache.get(key) !== entry) return;
        entry.size = dataUrl?.length || 0; cachedBytes += entry.size;
        while (cache.size > 32 || cachedBytes > CACHE_LIMIT) {
          const firstKey = cache.keys().next().value, first = cache.get(firstKey);
          cache.delete(firstKey); cachedBytes -= first.size;
        }
      });
      return entry.promise;
    }
    function hydrate(node) {
      if (!container.contains(node) || nodes.has(node)) return;
      const captured = context();
      if (scope(captured) !== currentScope) reset();
      const href = node.getAttribute('data-relay-local-image');
      const alt = node.getAttribute('data-image-alt') || node.textContent || '图片';
      const state = { epoch, scope: currentScope };
      nodes.set(node, state);
      const valid = () => !disposed && state.epoch === epoch && state.scope === scope(context()) && container.contains(node) && nodes.get(node) === state;
      const unavailable = () => {
        node.removeAttribute('aria-busy'); node.classList.add('is-unavailable');
        node.textContent = `${alt} · 无法预览图片`;
        options.onChange?.();
      };
      if (!captured?.conversationId || !fileLinks?.parse(href)) { unavailable(); return; }
      node.classList.add('relay-local-image');
      load(href, captured).then(dataUrl => {
        if (!valid()) return;
        if (!dataUrl) { unavailable(); return; }
        const image = document.createElement('img');
        image.alt = alt; image.decoding = 'async';
        image.addEventListener('load', () => { if (valid()) options.onChange?.(); }, { once: true });
        image.addEventListener('error', () => { if (valid()) unavailable(); }, { once: true });
        image.src = dataUrl;
        node.removeAttribute('aria-busy'); node.classList.add('is-loaded');
        node.replaceChildren(image);
        options.onChange?.();
      });
    }
    function scan(node) {
      if (disposed || node.nodeType !== 1 || !container.contains(node)) return;
      if (node.matches(SELECTOR)) hydrate(node);
      for (const child of node.querySelectorAll(SELECTOR)) hydrate(child);
    }
    const observer = new ownerWindow.MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) scan(node);
    });
    observer.observe(container, { subtree: true, childList: true });
    ownerWindow.addEventListener('relay:conversation-changed', reset);
    const api = { decorate() { scan(container); }, destroy() {
      disposed = true; reset(); observer.disconnect();
      ownerWindow.removeEventListener('relay:conversation-changed', reset);
      installed.delete(container);
    } };
    installed.set(container, api); scan(container);
    return api;
  }
  return Object.freeze({ image, install, bitmapDataUrl, IMAGE_LIMIT });
});
