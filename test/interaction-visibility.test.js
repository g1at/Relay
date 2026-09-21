'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'interaction-surface.js'), 'utf8');
function implementation(name) {
  const begin = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(begin, -1, name);
  const rest = source.slice(begin + 3);
  const end = rest.search(/^  (?:async )?function /m);
  return source.slice(begin, end < 0 ? source.length : begin + 3 + end);
}
function fixture() {
  const state = { items: new Map(), currentId: 'a', currentConversationId: 'A', currentView: 'chat',
    conversationLoading: false, busyIds: new Set(), errors: new Map(), drafts: new Map(), questionPages: new Map(), pendingFocus: null };
  const mount = { hidden: false };
  const effects = { renders: [], statuses: [], responses: [], closes: 0, focused: 0 };
  const controls = { isConnected: true, focus: () => effects.focused++ };
  const ui = { shell: { dataset: {} } };
  const context = vm.createContext({ state, mount, ui, document: { activeElement: controls },
    closePermissionMenu: () => effects.closes++,
    scheduleRender: options => effects.renders.push(options),
    setCurrentBusyState: (item, busy) => effects.statuses.push({ id: item.id, busy }),
    interactionsApi: { respond(id, decision) { return new Promise((resolve, reject) => effects.responses.push({ id, decision, resolve, reject })); } },
  });
  for (const name of ['isPending', 'sameConversation', 'isVisibleInteraction', 'isInteractionBusy', 'sortedItems', 'honorPendingFocus', 'onConversationChanged', 'onViewChanged', 'respond']) {
    vm.runInContext(implementation(name), context);
  }
  const add = (id, conv, extra = {}) => {
    const item = { id, conversationId: conv, kind: 'permission', state: 'pending', createdAt: '2026-09-10T00:00:00Z', ...extra };
    state.items.set(id, item); return item;
  };
  add('a', 'A'); add('b', 'B');
  return { state, mount, effects, context, add,
    navigate(id, options = {}) { context.onConversationChanged({ detail: { conversationId: id, ...options } }); },
    visible() { return Array.from(context.sortedItems(), item => item.id); },
    respond(id) { return context.respond(state.items.get(id), { action: 'allow_once' }); } };
}

test('only pending requests belonging to the exact current conversation are visible', () => {
  const f = fixture(); f.add('unbound', ''); f.add('done', 'A', { state: 'resolved' }); f.add('q', 'A', { kind: 'question' });
  assert.deepEqual(f.visible(), ['a', 'q']);
  f.navigate('B'); assert.deepEqual(f.visible(), ['b']);
  f.navigate(''); assert.deepEqual(f.visible(), []); assert.equal(f.mount.hidden, true);
  f.navigate('C'); assert.deepEqual(f.visible(), []);
});

test('loading and non-chat views synchronously hide decisions without losing question drafts', () => {
  const f = fixture(); f.state.drafts.set('a', { answer: 'retained' });
  f.navigate('A', { loading: true }); assert.equal(f.mount.hidden, true); assert.deepEqual(f.visible(), []);
  f.navigate('A'); assert.deepEqual(f.visible(), ['a']);
  for (const view of ['settings', 'library', 'scheduler', 'plugins']) {
    f.context.onViewChanged({ detail: { view } }); assert.deepEqual(f.visible(), []); assert.equal(f.mount.hidden, true);
  }
  f.context.onViewChanged({ detail: { view: 'chat' } }); assert.deepEqual(f.visible(), ['a']);
  assert.equal(f.state.drafts.get('a').answer, 'retained');
});

test('focus requests cannot expose another conversation before its host navigation completes', () => {
  const f = fixture(); f.state.pendingFocus = { interactionId: 'b', conversationId: 'B' };
  assert.equal(f.context.honorPendingFocus(), false); assert.equal(f.state.currentId, 'a');
  f.navigate('', { loading: true }); assert.notEqual(f.state.pendingFocus, null);
  f.navigate('B'); assert.equal(f.state.currentId, 'b'); assert.equal(f.state.pendingFocus, null);
  assert.equal(f.effects.renders.at(-1).focus, true);
});

test('stale detached controls cannot approve a hidden or different conversation', async () => {
  const f = fixture(); await f.respond('b'); assert.equal(f.effects.responses.length, 0);
  f.navigate('', { loading: true }); await f.respond('a'); assert.equal(f.effects.responses.length, 0);
  f.navigate('A'); f.context.onViewChanged({ detail: { view: 'settings' } });
  await f.respond('a'); assert.equal(f.effects.responses.length, 0);
});

test('submissions are locked per request and an earlier response cannot rerender the next conversation', async () => {
  const f = fixture(); const pendingA = f.respond('a');
  await f.respond('a'); assert.equal(f.effects.responses.length, 1);
  f.navigate('B'); const pendingB = f.respond('b'); assert.equal(f.effects.responses.length, 2);
  assert.deepEqual([...f.state.busyIds], ['a', 'b']);
  const renders = f.effects.renders.length, statuses = f.effects.statuses.length;
  f.effects.responses[0].resolve({ ok: true }); await pendingA;
  assert.equal(f.effects.renders.length, renders); assert.equal(f.effects.statuses.length, statuses);
  assert.equal(f.effects.focused, 0); assert.equal(f.state.currentId, 'b'); assert.equal(f.state.busyIds.has('b'), true);
  f.effects.responses[1].resolve({ ok: true }); await pendingB;
  assert.equal(f.state.busyIds.size, 0); assert.equal(f.state.items.size, 0);
});

test('late submission errors stay with their own request and do not change another card', async () => {
  const f = fixture(); const pending = f.respond('a'); f.navigate('B');
  const renders = f.effects.renders.length, statuses = f.effects.statuses.length;
  f.effects.responses[0].resolve({ ok: false, error: 'retry A' }); await pending;
  assert.equal(f.effects.renders.length, renders); assert.equal(f.effects.statuses.length, statuses); assert.equal(f.effects.focused, 0);
  assert.equal(f.state.errors.get('a'), 'retry A'); assert.equal(f.state.errors.has('b'), false);
  f.navigate('A'); assert.equal(f.state.currentId, 'a'); assert.equal(f.context.isInteractionBusy(), false);
});

test('canceled focus navigation is cleared instead of stealing focus on a later visit', () => {
  const f = fixture(); f.state.pendingFocus = { interactionId: 'b', conversationId: 'B' };
  f.navigate('', { loading: true }); assert.notEqual(f.state.pendingFocus, null);
  f.navigate(''); assert.equal(f.state.pendingFocus, null);
  f.navigate('B'); assert.equal(f.effects.renders.at(-1), undefined);
  f.state.pendingFocus = { interactionId: 'a', conversationId: 'A' };
  f.navigate('B'); assert.equal(f.state.pendingFocus, null);
});
