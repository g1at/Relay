'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { mount } = require('../renderer/browser-form-manager');
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

function fixture(section = 'passwords') {
  const listeners = new Map(), calls = [], copied = [];
  const record = section === 'passwords'
    ? { recordId: 'record-1', origin: 'https://example.test', username: 'Synthetic account' }
    : { recordId: 'record-1', name: 'Synthetic contact', email: 'test@example.test', phone: '000', address: 'Synthetic address' };
  let items = [record], fail = null, heldReveal = null;
  const api = { async invoke(input) {
    calls.push(input);
    if (fail) return { ok: false, code: fail, error: fail === 'ENCRYPTION_UNAVAILABLE' ? '系统加密不可用，不会以明文保存' : '合成操作失败' };
    if (input.action.endsWith('.list')) return { ok: true, items: items.map(item => ({ ...item })) };
    if (input.action === 'passwords.reveal') { if (heldReveal) return heldReveal; return { ok: true, password: 'Synthetic test secret' }; }
    if (input.action.endsWith('.save')) { items = [{ ...record, ...input }]; delete items[0].password; delete items[0].action; return { ok: true }; }
    if (input.action.endsWith('.delete')) { items = []; return { ok: true }; }
    return { ok: false };
  } };
  const win = { api: { browser: api }, navigator: { clipboard: { writeText: async value => copied.push(value) } },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const doc = { defaultView: win, createElement: tag => new Node(tag) };
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.events = new Map(); this.attrs = new Map(); this.parentNode = null; this.value = ''; this.hidden = false; this.disabled = false; this._text = '';
      const classes = new Set(); this.classList = { add: value => classes.add(value), toggle: (value, present) => { if (present) classes.add(value); else classes.delete(value); } }; }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key); }
    addEventListener(name, callback) { this.events.set(name, callback); }
    focus() { doc.activeElement = this; }
    reportValidity() { return true; }
    async emit(name) { return this.events.get(name)?.({ preventDefault() {} }); }
  }
  const container = new Node('div'), controller = mount(container, section);
  const walk = function* (node = container) { yield node; for (const child of node.children) yield* walk(child); };
  const find = predicate => [...walk()].find(predicate);
  const action = name => find(node => node.dataset.formAction === name);
  return { container, controller, calls, copied, action, field: name => find(node => node.dataset.formField === name),
    secret: () => find(node => Object.hasOwn(node.dataset, 'formSecret')),
    submit: () => find(node => node.tagName === 'FORM').emit('submit'),
    setError(value) { fail = value; }, holdReveal(promise) { heldReveal = promise; }, blur() { listeners.get('blur')?.(); }, listeners };
}

test('opening and searching password management never request or insert a secret', async t => {
  const f = fixture(); t.after(() => f.controller.destroy()); await settle();
  assert.deepEqual(f.calls.map(call => call.action), ['passwords.list']);
  assert.equal(f.secret().hidden, true); assert.equal(f.container.textContent.includes('Synthetic test secret'), false);
  assert.equal(f.action('add').disabled, false);
});

test('only explicit show/copy reveals a password, hiding and blur remove plaintext DOM', async t => {
  const f = fixture(); t.after(() => f.controller.destroy()); await settle();
  await f.action('reveal').emit('click'); await settle();
  assert.equal(f.calls.at(-1).action, 'passwords.reveal'); assert.equal(f.secret().hidden, false); assert.ok(f.secret().textContent === 'Synthetic test secret');
  await f.action('reveal').emit('click'); await settle(); assert.equal(f.secret().hidden, true); assert.equal(f.container.textContent.includes('Synthetic test secret'), false);
  await f.action('copy').emit('click'); await settle(); assert.equal(f.copied.length, 1); assert.ok(f.copied[0] === 'Synthetic test secret'); assert.equal(f.secret().hidden, true);
  await f.action('reveal').emit('click'); await settle(); f.blur(); assert.equal(f.secret().hidden, true); assert.equal(f.container.textContent.includes('Synthetic test secret'), false);
});

test('a reveal response arriving after navigation cannot restore plaintext or copy it', async () => {
  const f = fixture(); await settle(); let resolve;
  f.holdReveal(new Promise(done => { resolve = done; })); await f.action('copy').emit('click');
  const editorPassword = f.field('password'); editorPassword.value = 'Synthetic draft';
  f.controller.destroy(); resolve({ ok: true, password: 'Synthetic test secret' }); await settle();
  assert.equal(f.container.children.length, 0); assert.equal(editorPassword.value, ''); assert.equal(f.copied.length, 0); assert.equal(f.listeners.size, 0);
});

test('password edits do not fetch the old secret and omit an untouched password field', async t => {
  const f = fixture(); t.after(() => f.controller.destroy()); await settle();
  await f.action('edit').emit('click'); assert.equal(f.field('password').value, '');
  f.field('username').value = 'Renamed account'; await f.submit(); await settle();
  const saved = f.calls.find(call => call.action === 'passwords.save');
  assert.equal(saved.recordId, 'record-1'); assert.equal(saved.username, 'Renamed account'); assert.equal(Object.hasOwn(saved, 'password'), false);
  assert.equal(f.calls.some(call => call.action === 'passwords.reveal'), false);
});

test('encryption unavailable explains the limitation and disables saving without deleting records', async t => {
  const f = fixture(); t.after(() => f.controller.destroy()); await settle(); f.setError('ENCRYPTION_UNAVAILABLE'); await f.controller.refresh();
  assert.equal(f.action('add').disabled, true); assert.equal(f.action('save').disabled, true); assert.match(f.container.textContent, /不会以明文/);
  assert.equal(f.calls.some(call => /save|delete/.test(call.action)), false);
});

test('contact edit and deletion require explicit actions and a failed save keeps the draft', async t => {
  const f = fixture('contacts'); t.after(() => f.controller.destroy()); await settle();
  await f.action('edit').emit('click'); f.field('name').value = 'Updated contact'; f.setError('SAVE_FAILED'); await f.submit(); await settle();
  assert.equal(f.field('name').value, 'Updated contact'); assert.match(f.container.textContent, /合成操作失败/);
  f.setError(null); await f.submit(); await settle(); assert.equal(f.field('name').value, '');
  await f.action('delete').emit('click'); assert.equal(f.calls.some(call => call.action === 'contacts.delete'), false);
  await f.action('confirm-delete').emit('click'); await settle(); assert.equal(f.calls.at(-2).action, 'contacts.delete');
  assert.match(f.container.textContent, /还没有保存联系人/); assert.equal(f.calls.some(call => call.action === 'passwords.reveal'), false);
});
