'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { Marked } = require('../renderer/vendor/marked.umd.js');
const { create } = require('../renderer/stream-markdown');
const activityPath = path.join(__dirname, '../renderer/activity-stream.js');
function activityFixture() {
  const counts = { parses: 0, parsedChars: 0, stringifies: 0 };
  const context = { window: {}, require: createRequire(activityPath), module: { exports: {} }, JSON: {
    parse(text, ...args) { counts.parses++; counts.parsedChars += text.length; return JSON.parse(text, ...args); },
    stringify(...args) { counts.stringifies++; return JSON.stringify(...args); },
  } };
  vm.runInNewContext(fs.readFileSync(activityPath, 'utf8'), context, { filename: activityPath });
  return { activity: context.window.RelayActivity, counts };
}
const stream = event => ({ type: 'stream_event', event });
function startTool(activity, state, id) {
  activity.ingest(state, stream({ type: 'message_start', message: { id: 'message-' + id } }));
  activity.ingest(state, stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Write', input: {} } }));
}
function delta(activity, state, text) {
  activity.ingest(state, stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } }));
}
test('one megabyte of tool arguments in small deltas is parsed once, with no lost bytes', t => {
  const { activity, counts } = activityFixture(), state = activity.createState();
  const input = { file_path: 'large.txt', content: 'quotation \\" brackets {[]} 中文 '.repeat(35000) };
  const json = JSON.stringify(input); startTool(activity, state, 'large');
  counts.parses = counts.parsedChars = 0;
  const started = performance.now();
  for (let offset = 0; offset < json.length; offset += 37) delta(activity, state, json.slice(offset, offset + 37));
  activity.ingest(state, stream({ type: 'content_block_stop', index: 0 }));
  assert.equal(counts.parses, 1); assert.equal(counts.parsedChars, json.length);
  assert.deepEqual(state.items[0].input, input);
  assert.equal(state.items[0].status, 'running');
  assert.equal(state.items[0].inputJson, undefined);
  t.diagnostic(JSON.stringify({ inputChars: json.length, deltas: Math.ceil(json.length / 37), parses: counts.parses,
    parsedChars: counts.parsedChars, durationMs: Math.round(performance.now() - started) }));
});

test('resuming inside a JSON escape retains parser state and malformed input keeps its error marker', () => {
  const { activity, counts } = activityFixture(); let state = activity.createState();
  const input = { file_path: 'x', content: 'quote " brace } and slash \\ then 中文' }, json = JSON.stringify(input);
  startTool(activity, state, 'resume');
  const split = json.indexOf('\\"') + 1;
  delta(activity, state, json.slice(0, split));
  state = activity.hydrate(activity.serialize(state)); counts.parses = 0;
  for (const char of json.slice(split)) delta(activity, state, char);
  activity.ingest(state, stream({ type: 'content_block_stop', index: 0 }));
  assert.deepEqual(state.items[0].input, input); assert.equal(counts.parses, 1);
  startTool(activity, state, 'bad'); delta(activity, state, '{"key": invalid}');
  activity.ingest(state, stream({ type: 'content_block_stop', index: 0 }));
  assert.equal(state.items.at(-1).inputParseError, true);
});

test('new messages retain all activities while dropping previous message parser buffers', () => {
  const { activity } = activityFixture(), state = activity.createState();
  for (let index = 0; index < 400; index++) {
    startTool(activity, state, 'call-' + index);
    delta(activity, state, JSON.stringify({ file_path: index + '.txt', content: 'original-' + index }));
    activity.ingest(state, stream({ type: 'content_block_stop', index: 0 }));
    assert.equal(state._blocks.size, 1);
  }
  assert.equal(state.items.length, 400);
  assert.equal(state.items[0].input.content, 'original-0');
  assert.equal(state.items.at(-1).input.content, 'original-399');
  assert.equal(activity.serialize(state).streamCursor.blocks.length, 1);
});

test('activity lookup reads historical IDs once instead of scanning the long list for every append', t => {
  const { activity } = activityFixture(), state = activity.createState(); let reads = 0;
  state.items = Array.from({ length: 4000 }, (_, index) => ({ get id() { reads++; return 'old-' + index; }, type: 'status', status: 'success' }));
  const started = performance.now();
  for (let index = 0; index < 2000; index++) activity.ingest(state, { type: 'system', subtype: 'informational', uuid: 'new-' + index, content: 'next' });
  assert.equal(state.items.length, 6000); assert.ok(reads <= 4100, 'historical ID reads: ' + reads);
  const historicalIdReads = reads;
  state.items = state.items.filter(item => item.id !== 'sdk-informational:new-0');
  activity.ingest(state, { type: 'system', subtype: 'informational', uuid: 'new-0', content: 'replacement' });
  assert.equal(state.items.at(-1).detail, 'replacement');
  t.diagnostic(JSON.stringify({ oldActivities: 4000, appended: 2000, historicalIdReads, durationMs: Math.round(performance.now() - started) }));
});

class Node {
  constructor(markup) { this.markup = markup; this.parentNode = null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
}
class Container {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get innerHTML() { return this.childNodes.map(node => node.markup).join(''); }
  set innerHTML(html) { for (const child of [...this.childNodes]) child.remove(); for (const part of String(html).split(/(?<=\n)/).filter(Boolean)) this.insertBefore(new Node(part), null); }
  insertBefore(node, reference) { if (node === reference) return; node.remove(); const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    assert.ok(index >= 0); this.childNodes.splice(index, 0, node); node.parentNode = this; }
}
function markdownFixture() {
  const counts = { lexedChars: 0, lexes: 0, parses: 0, fallback: 0 }, marked = new Marked();
  const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const context = { marked, window: {}, console, escapeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.runInNewContext(app.slice(0, app.indexOf('// Activity stream is loaded')), context);
  const lexer = marked.lexer.bind(marked), parser = marked.parser.bind(marked);
  marked.lexer = (text, ...args) => { counts.lexes++; counts.lexedChars += text.length; return lexer(text, ...args); };
  marked.parser = (...args) => { counts.parses++; return parser(...args); };
  const doc = { createElement(name) { assert.equal(name, 'template'); const content = new Container(doc); return { content, set innerHTML(html) { content.innerHTML = html; } }; } };
  const body = new Container(doc), renderer = create({ marked, normalize: context.normalizeFences, fallback(text) { counts.fallback++; return context.renderMarkdown(text); } });
  return { counts, body, renderer, marked, html: text => context.renderMarkdown(text) };
}

test('large settled Markdown only re-lexes its small changing tail', t => {
  const f = markdownFixture();
  const settled = Array.from({ length: 160 }, (_, index) => '# Section ' + index + '\n\n' + '\x60\x60\x60js\n' + ('const value = "' + 'x'.repeat(90) + '";\n').repeat(60) + '\x60\x60\x60\n\n').join('');
  let text = settled + 'tail paragraph\n\nstream';
  const started = performance.now(); f.renderer.render(f.body, text);
  const first = f.body.firstChild, initial = { ...f.counts };
  for (let index = 0; index < 120; index++) { text += ' word'; f.renderer.render(f.body, text); }
  assert.equal(f.body.innerHTML, f.html(text)); assert.equal(f.body.firstChild, first);
  assert.equal(f.counts.fallback, 0);
  assert.ok(f.counts.lexedChars - initial.lexedChars < 100000, JSON.stringify(f.counts));
  assert.equal(f.counts.parses - initial.parses, 120);
  t.diagnostic(JSON.stringify({ settledChars: settled.length, streamUpdates: 120, additionalLexedChars: f.counts.lexedChars - initial.lexedChars,
    equivalentFullLexerChars: settled.length * 120, durationMs: Math.round(performance.now() - started) }));
});

test('frozen-prefix rendering stays equivalent across lists, fences, references, whitespace and non-append edits', () => {
  const f = markdownFixture();
  const prefix = '# Settled\n\n[earlier][late]\n\n' + '\x60\x60\x60js\nconst stable = 1;\n\x60\x60\x60\n\n';
  const bodies = [
    '- a\n\n- b\n\n  paragraph\n\n  > nested\n  > quote\n\noutside\n',
    'a | b\n-- | --\nx | y\n\nparagraph\n---\n\nend',
    '> a\n>\n> - list\n>\n>   nested\n\nlater\n',
    '[late]: https://example.invalid "title"\n\nresolved [late]\n',
    '- [late]: https://example.invalid\n\n[late]\n',
    '~~~\nraw [late]: https://example.invalid\n~~~\n\nnext',
    '\tindented\n\nnext\r\n\r\nend\r',
    'paragraph\n\n<div>\nraw\n</div>\n\nend',
    '[incomplete\n\nnext\n\n[late]:\n  /destination\n',
    'text\n\n\x60\x60\x60js\nconst s = "<script>";\n\x60\x60\x60\n\nnext',
  ];
  for (const body of bodies) for (let end = 0; end <= body.length; end++) {
    const text = prefix + body.slice(0, end); f.renderer.render(f.body, text);
    assert.equal(f.body.innerHTML, f.html(text), JSON.stringify(text));
  }
  f.renderer.render(f.body, 'replacement'); assert.equal(f.body.innerHTML, f.html('replacement'));
  assert.equal(f.counts.fallback, 0);
});

test('deterministic mixed Markdown streams agree with a full render at every chunk boundary', () => {
  let seed = 9027;
  const random = size => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % size; };
  const pieces = ['word', '\n', '\n\n', '# heading\n', '---\n', '  continuation\n', '- item\n', '1. item\n', '> quote\n',
    '\x60\x60\x60js\n', '\x60\x60\x60\n', '~~~\n', '| a | b |\n', '| - | - |\n', '[label][ref]', '[ref]: /destination\n',
    '<div>\n', '</div>\n', '    code\n', '\tmore\n', '**strong**', '[inline](https://example.invalid)', '![](/image.png)', '<!-- comment -->\n'];
  for (let document = 0; document < 80; document++) {
    const f = markdownFixture(); let text = '';
    for (let chunk = 0; chunk < 70; chunk++) {
      text += pieces[random(pieces.length)]; f.renderer.render(f.body, text);
      assert.equal(f.body.innerHTML, f.html(text), 'seeded document ' + document + ', chunk ' + chunk + ': ' + JSON.stringify(text));
    }
    assert.equal(f.counts.fallback, 0);
  }
});

test('custom tokenizer grammars keep full-document lexing while unchanged DOM remains reusable', () => {
  const f = markdownFixture(); f.marked.use({ tokenizer: { paragraph() { return false; } } });
  const text = '# old\n\nparagraph\n\n# next\n\nstream';
  f.renderer.render(f.body, text); const before = f.counts.lexedChars, first = f.body.firstChild;
  f.renderer.render(f.body, text + ' more');
  assert.equal(f.counts.lexedChars - before, text.length + 5);
  assert.equal(f.body.firstChild, first); assert.equal(f.body.innerHTML, f.html(text + ' more'));
});

test('trailing whitespace never repeatedly reparses large complete or malformed tool input', () => {
  for (const malformed of [false, true]) {
    const { activity, counts } = activityFixture(), state = activity.createState(); startTool(activity, state, 'whitespace');
    counts.parses = 0;
    delta(activity, state, malformed ? '{"value": invalid}' : '{"value":"complete"}');
    for (let index = 0; index < 500; index++) delta(activity, state, ' ');
    assert.equal(counts.parses, 1);
    activity.ingest(state, stream({ type: 'content_block_stop', index: 0 }));
    assert.equal(counts.parses, malformed ? 2 : 1);
    assert.equal(Boolean(state.items[0].inputParseError), malformed);
  }
});

test('in-place Markdown option and renderer edits invalidate frozen prefix DOM', () => {
  const f = markdownFixture(), text = '# title\n\nline one\nline two\n\n# next\n\nlast paragraph\n\ntail';
  f.renderer.render(f.body, text); let first = f.body.firstChild;
  f.marked.defaults.breaks = false;
  f.renderer.render(f.body, text + ' update');
  assert.equal(f.body.innerHTML, f.html(text + ' update'));
  assert.notEqual(f.body.firstChild, first); first = f.body.firstChild;
  f.marked.defaults.renderer.heading = () => '<h2>changed renderer</h2>\n';
  f.renderer.render(f.body, text + ' update again');
  assert.equal(f.body.innerHTML, f.html(text + ' update again'));
  assert.notEqual(f.body.firstChild, first);
});

test('replacing the parser function invalidates cached completed blocks', () => {
  const f = markdownFixture(), text = '# heading\n\nfirst\n\nsecond\n\ntail';
  f.renderer.render(f.body, text); const old = f.body.firstChild, parser = f.marked.parser;
  f.marked.parser = (...args) => parser(...args).replace(/heading/g, 'changed');
  f.renderer.render(f.body, text + ' more');
  assert.notEqual(f.body.firstChild, old); assert.match(f.body.innerHTML, /changed/);
  assert.doesNotMatch(f.body.innerHTML, /heading/);
});

test('hydrated and merged activity states update the replacement record rather than a stale indexed item', () => {
  const { activity } = activityFixture(); let state = activity.createState();
  const notice = { type: 'system', subtype: 'informational', uuid: 'id', content: 'first' };
  activity.ingest(state, notice); const first = state.items[0];
  state.items = [{ ...first, detail: 'merged' }];
  activity.ingest(state, { ...notice, content: 'second' });
  assert.equal(first.detail, 'first'); assert.equal(state.items[0].detail, 'second');
  state = activity.hydrate(activity.serialize(state));
  activity.ingest(state, { ...notice, content: 'third' });
  assert.equal(state.items.length, 1); assert.equal(state.items[0].detail, 'third');
});
