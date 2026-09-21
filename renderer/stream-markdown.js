(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayStreamMarkdown = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  // Keep lexing the complete document: the next characters can close a fence,
  // alter list/table boundaries, or define a reference used much earlier. Only
  // parsing/highlighting and DOM creation are incremental, at lexer boundaries.
  function create({ marked, normalize = text => String(text || ''), fallback, prepareFragment }) {
    const states = new WeakMap();
    const escape = text => String(text).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
    const full = text => fallback ? fallback(text) : `<pre>${escape(text)}</pre>`;
    function fragment(body, html) {
      const template = body.ownerDocument.createElement('template');
      template.innerHTML = html;
      // Read-only surfaces sanitize each newly parsed token while the template
      // is still inert. Reused nodes have already passed the same policy.
      if (prepareFragment) prepareFragment(template.content);
      return template.content;
    }
    function replaceFull(body, text, plain = false) {
      states.delete(body);
      try {
        const content = fragment(body, plain ? `<pre>${escape(text)}</pre>` : full(text));
        for (const node of Array.from(body.childNodes)) node.remove();
        for (const node of Array.from(content.childNodes)) body.insertBefore(node, null);
      } catch (_) {
        // A parser or sanitizer failure must never expose an unprepared
        // fragment. This fallback contains only our own tag and escaped text.
        body.innerHTML = `<pre>${escape(text)}</pre>`;
      }
    }
    function render(body, text) {
      try {
        const options = marked.defaults;
        // Preserve an extended application's complete pipeline if hooks ever
        // become part of its safety policy, instead of silently bypassing them.
        if (options?.async) {
          // This renderer is deliberately synchronous. Do not stringify a
          // Promise into the conversation if an async parser is installed.
          replaceFull(body, text, true); return;
        }
        if (options?.hooks || options?.walkTokens || options?.extensions) {
          replaceFull(body, text); return;
        }
        const tokens = marked.lexer(normalize(text), options);
        const links = JSON.stringify(Object.entries(tokens.links || {}).sort(([a], [b]) => a.localeCompare(b)));
        const previous = states.get(body);
        const reusable = new Map();
        if (previous && previous.options === options && previous.links === links) {
          for (const entry of previous.entries) {
            // Code-block enhancement or another owner may have wrapped nodes.
            // Such nodes must never be moved out of their external wrapper.
            if (entry.nodes.some(node => node.parentNode !== body)) continue;
            let queue = reusable.get(entry.signature);
            if (!queue) reusable.set(entry.signature, queue = { entries: [], next: 0 });
            queue.entries.push(entry);
          }
        }
        const entries = [];
        for (const token of tokens) {
          // Include parsed inline structure, list looseness, and other token
          // metadata. Equal raw source alone is not a sufficient cache key.
          const signature = JSON.stringify(token);
          const queue = reusable.get(signature);
          let entry = queue?.entries[queue.next++];
          if (!entry) {
            const part = [token]; part.links = tokens.links;
            const html = marked.parser(part, options);
            if (typeof html !== 'string') throw new Error('Streaming Markdown requires synchronous rendering');
            entry = { signature, nodes: Array.from(fragment(body, html).childNodes) };
          }
          entries.push(entry);
        }
        // Prepare the whole replacement before touching the live DOM, so any
        // malformed token or parser error takes the safe full-render fallback.
        const retained = new Set(entries.flatMap(entry => entry.nodes));
        for (const node of Array.from(body.childNodes)) if (!retained.has(node)) node.remove();
        let cursor = body.firstChild;
        for (const entry of entries) for (const node of entry.nodes) {
          if (node === cursor) cursor = cursor.nextSibling;
          else body.insertBefore(node, cursor);
        }
        states.set(body, { entries, links, options });
      } catch (_) {
        replaceFull(body, text);
      }
    }
    // Final code controls keep their current DOM; no parsed copy is retained.
    function release(body) { states.delete(body); }
    return { render, release };
  }
  return { create };
});
