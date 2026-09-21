'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('../renderer/vendor/marked.umd.js');
const { create } = require('../renderer/stream-markdown');
const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const setup = app.slice(0, app.indexOf('// Activity stream is loaded'));
const esc = text => String(text).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));

// Minimal DOM ownership/movement adapter; uses the real bundled Marked lexer,
// parser and the app's safe render configuration. Browser layout is smoke-tested.
class Node {
  constructor(markup) { this.markup = markup; this.parentNode = null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
}
class Container {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get innerHTML() { return this.childNodes.map(node => node.markup).join(''); }
  set innerHTML(html) {
    for (const child of [...this.childNodes]) child.remove();
    // A token can produce several root nodes, including trailing whitespace.
    for (const part of String(html).split(/(?<=\n)/).filter(Boolean)) this.insertBefore(new Node(part), null);
  }
  insertBefore(node, reference) {
    if (node === reference) return;
    node.remove();
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    assert.ok(index >= 0); this.childNodes.splice(index, 0, node); node.parentNode = this;
  }
}
function fixture({ prepareFragment } = {}) {
  const marked = new Marked(), counts = { templates: 0, highlights: 0, parsed: 0, full: 0 };
  const context = { marked, console, window: { RelayLocalMarkdownImages: require('../renderer/local-markdown-images') }, escapeHtml: esc, hljs: {
    getLanguage: () => true,
    highlight(code) { counts.highlights++; return { value: `<span>${esc(code)}</span>` }; },
    highlightAuto(code) { counts.highlights++; return { value: `<span>${esc(code)}</span>` }; },
  } };
  vm.runInNewContext(setup, context);
  const parser = marked.parser.bind(marked);
  marked.parser = (...args) => { counts.parsed++; return parser(...args); };
  const doc = { createElement(name) {
    assert.equal(name, 'template'); counts.templates++;
    const content = new Container(doc);
    return { content, set innerHTML(html) { content.innerHTML = html; } };
  } };
  const body = new Container(doc);
  const renderer = create({ marked, normalize: context.normalizeFences, prepareFragment, fallback(text) { counts.full++; return context.renderMarkdown(text); } });
  return { body, renderer, marked, counts, html: text => context.renderMarkdown(text) };
}

test('every streamed prefix matches the full safe Markdown renderer across structural boundaries', () => {
  const f = fixture();
  const documents = [
    '# Title\n\nParagraph with **strong** and *emphasis*.\n\nMore text.\n',
    'Example:```js\nconst html = "<script>bad()</script>";\n```\n\nDone',
    'before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter',
    '| A | B |\n| -- | -- |\n| x | y |\n| z | q |\n',
    '- first\n- second\n\n  loose paragraph\n\n  - nested\n\n- [x] checked\n',
    '> quote\n>\n> - item\n>\n> after\n\nnormal\n',
    '[earlier][later]\n\n![image][later]\n\n[later]: https://example.invalid "title"\n',
    '<div onclick="bad()">\n<script>bad()</script>\n<style>body{display:none}</style>\n</div>\n\nend',
    'Inline <img src=x onerror="bad()"> and <https://example.invalid>\n\n<!-- hidden -->\n',
    'setext\n---\n\n    indented\n    code\n\nnormal\n',
    '[a]: /first\n\n[a]\n\n[a]: /second\n',
    '![image](https://example.invalid/a.png "quote") and `inline code`\n',
  ];
  for (const document of documents) for (let end = 0; end <= document.length; end++) {
    const text = document.slice(0, end);
    f.renderer.render(f.body, text);
    assert.equal(f.body.innerHTML, f.html(text), JSON.stringify(text));
  }
  assert.equal(f.counts.full, 0, 'normal incremental parsing never falls back');
});

test('long completed code fences are highlighted and parsed once while only the final paragraph grows', () => {
  const f = fixture();
  const fences = Array.from({ length: 42 }, (_, index) => `\n\n\`\`\`js\n${Array.from({ length: 80 }, (_, line) => `const value_${index}_${line} = "${'x'.repeat(55)}";`).join('\n')}\n\`\`\``).join('');
  f.renderer.render(f.body, fences + '\n\ntail');
  const finished = [...f.body.childNodes].slice(0, -1), initial = { ...f.counts };
  for (let index = 0; index < 12; index++) f.renderer.render(f.body, fences + '\n\ntail ' + ' grows'.repeat(index + 1));
  assert.equal(f.counts.highlights, 42);
  assert.equal(f.counts.parsed - initial.parsed, 12);
  assert.equal(f.counts.templates - initial.templates, 12);
  assert.equal(f.counts.full, 0);
  assert.ok(finished.every(node => node.parentNode === f.body), 'all completed code DOM stays attached');
});

test('late reference definitions invalidate earlier inline meaning even when raw source is identical', () => {
  const f = fixture(), source = '[label][destination]\n\nbody';
  f.renderer.render(f.body, source); const old = f.body.firstChild;
  f.renderer.render(f.body, source + '\n\n[destination]: https://example.invalid "Resolved"\n');
  assert.notEqual(f.body.firstChild, old);
  assert.equal(f.body.innerHTML, f.html(source + '\n\n[destination]: https://example.invalid "Resolved"\n'));
  assert.match(f.body.innerHTML, /href="https:\/\/example\.invalid"/);
});

test('reordered and duplicate blocks retain distinct node ownership without stale tail content', () => {
  const f = fixture();
  f.renderer.render(f.body, 'one\n\ntwo\n\none\n\nthree');
  const original = [...f.body.childNodes];
  f.renderer.render(f.body, 'three\n\none\n\ntwo\n\none');
  assert.equal(f.body.innerHTML, f.html('three\n\none\n\ntwo\n\none'));
  assert.ok(original.every(node => node.parentNode === f.body));
  assert.equal(new Set(f.body.childNodes).size, f.body.childNodes.length);
  f.renderer.render(f.body, 'one');
  assert.equal(f.body.innerHTML, f.html('one'));
  assert.ok(original.some(node => node.parentNode === null));
});

test('configuration changes rerender equal source and safe HTML never becomes a live raw tag', () => {
  const f = fixture(), source = 'one\ntwo\n\n<img src=x onerror="alert(1)">';
  f.renderer.render(f.body, source);
  assert.doesNotMatch(f.body.innerHTML, /<img|<script|onerror="/);
  assert.match(f.body.innerHTML, /&lt;img/);
  const first = f.body.firstChild;
  f.marked.use({ breaks: false });
  f.renderer.render(f.body, source);
  assert.notEqual(f.body.firstChild, first);
  assert.equal(f.body.innerHTML, f.html(source));
});

test('parser errors fall back safely and the next normal stream rebuilds without stale ownership', () => {
  const f = fixture();
  f.renderer.render(f.body, 'old');
  const normal = f.marked.parser;
  f.marked.parser = () => { throw Error('fixture parser failure'); };
  f.renderer.render(f.body, '<script>bad()</script>');
  assert.equal(f.counts.full, 1);
  assert.doesNotMatch(f.body.innerHTML, /<script>/);
  f.marked.parser = normal;
  f.renderer.render(f.body, 'recovered');
  assert.equal(f.body.innerHTML, '<p>recovered</p>\n');
});

test('final release keeps final nodes and drops reuse before an external code wrapper changes ownership', () => {
  const f = fixture();
  f.renderer.render(f.body, 'completed\n\n```js\nx=1\n```');
  const nodes = [...f.body.childNodes];
  f.renderer.release(f.body);
  assert.deepEqual(f.body.childNodes, nodes);
  f.body.innerHTML = '<section>final controls</section>';
  f.renderer.render(f.body, 'new answer');
  assert.equal(f.body.innerHTML, '<p>new answer</p>\n');
});

test('security hooks use the complete renderer pipeline instead of being bypassed by token caching', () => {
  const f = fixture();
  f.marked.use({ hooks: { postprocess(html) { return html.replace(/secret/g, 'redacted'); } } });
  f.renderer.render(f.body, 'secret');
  assert.equal(f.body.innerHTML, '<p>redacted</p>\n');
  assert.equal(f.counts.full, 1);
  assert.equal(f.counts.parsed, 0);
});

test('an async parser cannot leak a Promise string or raw HTML into the synchronous stream', () => {
  const f = fixture();
  f.marked.use({ async: true });
  f.renderer.render(f.body, '<script>bad()</script>');
  assert.equal(f.body.innerHTML, '<pre>&lt;script&gt;bad()&lt;/script&gt;</pre>');
  assert.equal(f.counts.parsed, 0);
  assert.equal(f.counts.full, 0);
});

test('fragment preparation runs only on new inert tokens and leaves prepared completed nodes attached', () => {
  let prepared = 0;
  const f = fixture({ prepareFragment(fragment) {
    prepared++;
    assert.ok(fragment.childNodes.every(node => node.parentNode === fragment));
    fragment.innerHTML = fragment.innerHTML.replace(/secret/g, 'redacted');
  } });
  f.renderer.render(f.body, 'secret\n\ntail');
  const first = f.body.firstChild, previous = prepared;
  f.renderer.render(f.body, 'secret\n\ntail grows');
  assert.equal(f.body.firstChild, first);
  assert.match(f.body.innerHTML, /redacted/);
  assert.doesNotMatch(f.body.innerHTML, /secret/);
  assert.equal(prepared - previous, 1, 'the unchanged prepared paragraph is never processed again');
});

test('full pipeline fallback is also prepared before adoption', () => {
  let prepared = 0;
  const f = fixture({ prepareFragment(fragment) {
    prepared++;
    fragment.innerHTML = fragment.innerHTML.replace(/unsafe/g, 'filtered');
  } });
  f.marked.use({ hooks: { postprocess(html) { return html.replace(/source/g, 'unsafe'); } } });
  f.renderer.render(f.body, 'source');
  assert.equal(f.body.innerHTML, '<p>filtered</p>\n');
  assert.equal(prepared, 1);
  assert.equal(f.counts.full, 1);
});

test('a rejected fragment and rejected fallback expose only escaped original text', () => {
  const f = fixture({ prepareFragment() { throw Error('synthetic policy rejection'); } });
  f.renderer.render(f.body, '<img src=x onerror=alert(1)>');
  assert.equal(f.body.innerHTML, '<pre>&lt;img src=x onerror=alert(1)&gt;</pre>');
  assert.doesNotMatch(f.body.innerHTML, /<img/);
});
