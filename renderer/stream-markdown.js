(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayStreamMarkdown = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  // Re-lex the unsettled tail of an append-only stream. Keep two complete
  // non-space blocks in that tail: lists, tables, fences and setext headings can
  // still change at its end. Reference definitions have document-wide meaning;
  // any definition or non-append edit deliberately takes the complete lexer.
  function create({ marked, normalize = text => String(text || ''), fallback, prepareFragment }) {
    const states = new WeakMap();
    // Callers may edit marked.defaults in place. Identity alone must not reuse
    // a frozen prefix after breaks/gfm or a renderer method changes. Keep a
    // small shallow snapshot of options and the configurable parser helpers.
    const optionSnapshot = options => {
      const fields = [marked.lexer, marked.parser];
      for (const key of Object.keys(options || {}).sort()) {
        const value = options[key]; fields.push(key, value);
        if ((key === 'renderer' || key === 'tokenizer') && value && typeof value === 'object') {
          for (const child of Object.keys(value).sort()) {
            // Marked writes a fresh parser/lexer and generated rules here on
            // every invocation; these are runtime cursors, not configuration.
            if (['options', 'parser', 'lexer', 'rules'].includes(child)) continue;
            fields.push(child, value[child]);
          }
        }
      }
      return fields;
    };
    const sameOptions = (previous, next) => previous?.length === next.length
      && next.every((value, index) => previous[index] === value);
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
        const source = normalize(text).replace(/\r\n|\r/g, '\n');
        const previous = states.get(body);
        const optionsMatch = previous && previous.options === options && sameOptions(previous.optionSnapshot, optionSnapshot(options));
        const customTokenizer = options?.tokenizer && (options.tokenizer.constructor !== marked.Tokenizer
          || Object.keys(options.tokenizer).some(key => typeof options.tokenizer[key] === 'function'));
        let prefixCount = 0, prefixLength = 0;
        if (optionsMatch && !customTokenizer && previous.boundary > 0
            && !previous.hasLinks && source.startsWith(previous.source)) {
          prefixCount = previous.prefixCount; prefixLength = previous.boundary;
        }
        let tail = marked.lexer(source.slice(prefixLength), options);
        if (prefixCount && Object.keys(tail.links || {}).length) {
          prefixCount = 0; prefixLength = 0; tail = marked.lexer(source, options);
        }
        const tokens = prefixCount ? previous.tokens.slice(0, prefixCount).concat(tail) : tail;
        tokens.links = tail.links;
        // Lexer preprocessing/extension changes must never invalidate offsets.
        // A definition consumes raw source without a visible token, for example.
        const exactTail = tail.map(token => token.raw || '').join('') === source.slice(prefixLength);
        let boundary = 0, nextPrefixCount = 0;
        if (exactTail && !Object.keys(tokens.links || {}).length) {
          let unsettledLength = 0, blocks = 0;
          for (let index = tokens.length - 1; index >= 0; index -= 1) {
            unsettledLength += tokens[index].raw.length;
            if (tokens[index].type !== 'space') blocks += 1;
            if (blocks === 2) { boundary = source.length - unsettledLength; nextPrefixCount = index; break; }
          }
        }
        const links = JSON.stringify(Object.entries(tokens.links || {}).sort(([a], [b]) => a.localeCompare(b)));
        const reusable = new Map();
        if (optionsMatch && previous.links === links) {
          for (const entry of previous.entries.slice(prefixCount)) {
            // Code-block enhancement or another owner may have wrapped nodes.
            // Such nodes must never be moved out of their external wrapper.
            if (entry.nodes.some(node => node.parentNode !== body)) continue;
            let queue = reusable.get(entry.signature);
            if (!queue) reusable.set(entry.signature, queue = { entries: [], next: 0 });
            queue.entries.push(entry);
          }
        }
        const entries = prefixCount ? previous.entries.slice(0, prefixCount) : [];
        // If another owner wrapped a frozen node, rebuilding is safer than
        // moving it out of that owner's DOM (for example final code controls).
        if (entries.some(entry => entry.nodes.some(node => node.parentNode !== body))) {
          states.delete(body); render(body, text); return;
        }
        for (const token of tokens.slice(prefixCount)) {
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
        states.set(body, { entries, links, options, optionSnapshot: optionSnapshot(options), source, tokens, boundary, prefixCount: nextPrefixCount,
          hasLinks: Object.keys(tokens.links || {}).length > 0 });
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
