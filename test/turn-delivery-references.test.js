'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fileKey, stampOwner, ownerOf, create } = require('../renderer/turn-delivery-references');

// A small tree covers ownership, containment and focus/scroll receipts.
// Browser rendering and local-file parsing have their own integration tests.
class Element {
  constructor(tag = 'div', classes = []) {
    this.tagName = tag; this.classes = new Set(classes); this.dataset = {};
    this.children = []; this.parentElement = null; this.scrolls = []; this.focuses = [];
  }
  append(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  matches(selector) {
    if (selector === 'a,button') return this.tagName === 'a' || this.tagName === 'button';
    const negative = [...selector.matchAll(/:not\(\.([\w-]+)\)/g)].map(match => match[1]);
    if (negative.some(name => this.classes.has(name))) return false;
    const positive = selector.replace(/:not\([^)]*\)/g, '').replace(/\[[\s\S]*$/g, '');
    if ([...positive.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
    for (const match of selector.matchAll(/\[data-([\w-]+)="((?:\\.|[^"\\])*)"\]/g)) {
      const key = match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (this.dataset[key] !== match[2].replace(/\\([\\"])/g, '$1')) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView(options) { this.scrolls.push(options); }
  focus(options) { this.focuses.push(options); }
}
function fixture() {
  const owner = { conversationId: 'conversation-a', runId: 'run-a', turnTs: '2026-10-15T08:00:00.000Z' };
  const snapshot = { version: 1, ...owner, status: 'complete', items: [
    { id: 'artifact-a', path: 'D:\\jobs\\one\\outputs\\report.md' },
  ] };
  const turn = { runId: owner.runId, ts: owner.turnTs, deliverables: snapshot };
  const conversation = { id: owner.conversationId, workingDir: 'D:\\jobs\\one', turns: [turn] };
  const container = new Element();
  const bubble = container.append(new Element('div', ['message', 'assistant']));
  stampOwner(bubble, owner.conversationId, turn, 0);
  const body = bubble.append(new Element('div', ['body']));
  const link = body.append(new Element('a'));
  const section = container.append(new Element('section', ['message', 'assistant', 'turn-deliverables']));
  stampOwner(section, owner.conversationId, turn, 0);
  const target = section.append(new Element('article'));
  const action = target.append(new Element('button'));
  const state = { conversation, target };
  const targetRequests = [];
  const controller = create({ container, getConversation: () => state.conversation, getTarget: reference => {
    targetRequests.push(reference);
    return state.target;
  } });
  return { owner, snapshot, turn, conversation, container, bubble, body, link, section, target, action,
    state, targetRequests, controller, parsed: { path: snapshot.items[0].path },
    reference: { ...owner, itemId: 'artifact-a' } };
}
test('Windows full paths normalize slash, case, mounted drives and dot segments', () => {
  for (const value of ['D:\\Jobs\\One\\outputs\\report.md', 'd:/jobs/one/outputs/report.md',
    '/mnt/D/Jobs/One/outputs/report.md', 'D:/jobs/one/./outputs/old/../report.md']) {
    assert.equal(fileKey(value), 'd:/jobs/one/outputs/report.md');
  }
  assert.equal(fileKey('./outputs/report.md', 'D:\\Jobs\\One'), 'd:/jobs/one/outputs/report.md');
  assert.equal(fileKey('../outputs/report.md', '/mnt/d/jobs/one/work'), 'd:/jobs/one/outputs/report.md');
});
test('ordinary UNC paths stay within their share and use Windows case rules', () => {
  assert.equal(fileKey('\\\\SERVER\\Share\\Folder\\..\\Report.md'), '//server/share/report.md');
  assert.equal(fileKey('Report.md', '//SERVER/Share'), '//server/share/report.md');
  for (const value of ['//server', '//server/share/../other/file.md', '//server/share/dir/../../file.md', '//./share/file']) {
    assert.equal(fileKey(value), null, value);
  }
});
test('POSIX and WSL UNC paths preserve case-sensitive directory names', () => {
  assert.notEqual(fileKey('/home/Foo/report.md'), fileKey('/home/foo/report.md'));
  for (const server of ['WSL.LOCALHOST', 'WSL$']) {
    assert.equal(fileKey('//' + server + '/Ubuntu/home/Foo/report.md'), '//' + server.toLowerCase() + '/Ubuntu/home/Foo/report.md');
    assert.notEqual(fileKey('//' + server + '/Ubuntu/home/Foo/report.md'), fileKey('//' + server + '/Ubuntu/home/foo/report.md'));
    assert.equal(fileKey('./report.md', '//' + server + '/Ubuntu/home/Foo'), '//' + server.toLowerCase() + '/Ubuntu/home/Foo/report.md');
  }
});
test('invalid, scheme and drive-relative paths cannot become artifact keys', () => {
  for (const value of [null, '', 'a\0b', 'a\nb', 'D:report.md', 'https://example.invalid/report.md',
    'file:///D:/report.md', 'javascript:alert(1)', 'data:text/plain,report', 'D:/../report.md', '/../../report.md']) {
    assert.equal(fileKey(value, 'D:/jobs/one'), null, String(value));
  }
  assert.equal(fileKey('report.md'), null);
  assert.equal(fileKey('report.md', 'also-relative'), null);
});
test('only the exact normalized full artifact path resolves', () => {
  const f = fixture();
  for (const path of [f.parsed.path, '/mnt/d/jobs/one/outputs/report.md', 'outputs/report.md']) {
    assert.deepEqual(f.controller.resolve(f.link, { path }), { ...f.reference, pending: false });
  }
  for (const path of ['D:/other/outputs/report.md', 'report.md', 'D:/jobs/one/outputs/report.md.backup']) {
    assert.equal(f.controller.resolve(f.link, { path }), null);
  }
  f.snapshot.items.push({ id: 'artifact-copy', path: 'd:/JOBS/one/outputs/report.md' });
  assert.equal(f.controller.resolve(f.link, f.parsed), null);
});
test('relative links use the owning conversation cwd and its stored SDK fallbacks', () => {
  for (const key of ['hostCwd', 'cwd']) {
    const f = fixture(); delete f.conversation.workingDir;
    f.conversation.sdkSessionContext = { [key]: 'D:/jobs/one' };
    assert.deepEqual(f.controller.resolve(f.link, { path: './outputs/report.md' }), { ...f.reference, pending: false });
  }
  const f = fixture(); f.conversation.workingDir = 'D:/other';
  f.conversation.sdkSessionContext = { hostCwd: 'D:/jobs/one' };
  assert.equal(f.controller.resolve(f.link, { path: 'outputs/report.md' }), null);
});
test('bubble, conversation, turn and snapshot must agree on the complete owner identity', () => {
  const mutations = [
    f => { f.state.conversation = { ...f.conversation, id: 'other' }; },
    f => { f.bubble.dataset.conversationId = 'other'; },
    f => { f.bubble.dataset.runId = 'other'; },
    f => { f.bubble.dataset.turnTs = 'other'; },
    f => { delete f.bubble.dataset.runId; },
    f => { f.turn.runId = 'other'; },
    f => { f.turn.ts = 'other'; },
    f => { f.snapshot.conversationId = 'other'; },
    f => { f.snapshot.runId = 'other'; },
    f => { f.snapshot.turnTs = 'other'; },
    f => { f.snapshot.version = 2; },
    f => { f.snapshot.items = null; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(f.controller.resolve(f.link, f.parsed), null);
    if (ownerOf(f.bubble) && JSON.stringify(ownerOf(f.bubble)) === JSON.stringify(f.owner)) {
      assert.equal(f.controller.navigate(f.reference), false);
    }
  }
});
test('same run at another timestamp stays independent while duplicate complete identities are refused', () => {
  const f = fixture();
  f.conversation.turns.push({ ...f.turn, ts: '2026-10-15T08:01:00.000Z' });
  assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: false });
  assert.equal(f.controller.navigate(f.reference), true);
  f.conversation.turns.push({ ...f.turn });
  assert.equal(f.controller.resolve(f.link, f.parsed), null);
  assert.equal(f.controller.navigate(f.reference), false);
});
test('line links, result section links, user text and detached links keep their normal behavior', () => {
  const f = fixture();
  assert.equal(f.controller.resolve(f.link, { ...f.parsed, line: 7 }), null);
  assert.equal(f.controller.resolve(f.target.append(new Element('a')), f.parsed), null);
  const user = f.container.append(new Element('div', ['message', 'user']));
  stampOwner(user, f.owner.conversationId, f.turn, 0);
  assert.equal(f.controller.resolve(user.append(new Element('a')), f.parsed), null);
  f.link.remove(); assert.equal(f.controller.resolve(f.link, f.parsed), null);
});
test('pending snapshots retain links until a terminal artifact is mounted in the same container', () => {
  const f = fixture();
  for (const status of ['running', 'finishing', 'unknown', '']) {
    f.snapshot.status = status;
    assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: true });
    assert.equal(f.controller.navigate(f.reference), false);
  }
  assert.equal(f.targetRequests.length, 0);
  for (const status of ['complete', 'failed', 'canceled', 'interrupted']) {
    f.snapshot.status = status;
    assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: false });
  }
  f.state.target = null;
  assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: true });
  f.state.target = f.target; f.target.remove();
  assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: true });
  assert.equal(f.controller.navigate(f.reference), false);
  f.section.append(f.target);
  assert.deepEqual(f.controller.resolve(f.link, f.parsed), { ...f.reference, pending: false });
});
test('navigation rechecks live ownership and item existence instead of trusting a cached reference', () => {
  for (const invalidate of [
    f => { f.state.conversation = { ...f.conversation, id: 'new-conversation' }; },
    f => { f.turn.ts = 'new-time'; },
    f => { f.turn.runId = 'new-run'; },
    f => { f.snapshot.items = []; },
    f => { f.snapshot.status = 'running'; },
    f => { f.target.remove(); },
  ]) {
    const f = fixture(); const reference = f.controller.resolve(f.link, f.parsed);
    invalidate(f);
    assert.equal(f.controller.navigate(reference), false);
    assert.equal(f.target.scrolls.length, 0); assert.equal(f.action.focuses.length, 0);
  }
});
test('successful navigation scrolls and focuses the artifact action without a second scroll', () => {
  const f = fixture();
  assert.equal(f.controller.navigate(f.reference), true);
  assert.deepEqual(f.target.scrolls, [{ block: 'center', behavior: 'auto' }]);
  assert.deepEqual(f.action.focuses, [{ preventScroll: true }]);
  f.action.remove(); assert.equal(f.controller.navigate(f.reference), true);
  assert.deepEqual(f.target.focuses, [{ preventScroll: true }]);
});
test('refresh decorates only assistant bodies belonging to the exact turn, never result cards', () => {
  const f = fixture(); const touched = [];
  for (const overrides of [{ conversationId: 'other' }, { runId: 'other' }, { turnTs: 'other' }]) {
    const owner = { ...f.owner, ...overrides };
    const other = f.container.append(new Element('div', ['message', 'assistant']));
    stampOwner(other, owner.conversationId, { runId: owner.runId, ts: owner.turnTs }, 1);
    other.append(new Element('div', ['body']));
  }
  const same = f.container.append(new Element('div', ['message', 'assistant']));
  stampOwner(same, f.owner.conversationId, f.turn, 0);
  f.controller.refresh(f.owner, node => touched.push(node));
  assert.deepEqual(touched, [f.body, same]);
  f.controller.refresh({ ...f.owner, runId: '' }, node => touched.push(node));
  f.controller.refresh(null, node => touched.push(node));
  assert.deepEqual(touched, [f.body, same]);
});
test('owner stamping removes stale identity fields and handles escaped selector characters', () => {
  const f = fixture();
  const special = { conversationId: 'conv"\\literal', runId: 'run\\"literal', turnTs: f.owner.turnTs };
  stampOwner(f.bubble, special.conversationId, { runId: special.runId, ts: special.turnTs }, 2);
  assert.deepEqual(ownerOf(f.bubble), special); assert.equal(f.bubble.dataset.turn, '2');
  const touched = []; f.controller.refresh(special, node => touched.push(node));
  assert.deepEqual(touched, [f.body]);
  stampOwner(f.bubble, '', { runId: null, ts: '\n' }, 0);
  assert.equal(ownerOf(f.bubble), null);
  assert.equal(f.bubble.dataset.conversationId, undefined);
  assert.equal(f.bubble.dataset.runId, undefined); assert.equal(f.bubble.dataset.turnTs, undefined);
});
