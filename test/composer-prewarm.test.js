'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { create } = require('../renderer/composer-prewarm');
const app = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
function fixture() {
  const timers = new Map(), calls = []; let next = 0, intent = null;
  const controller = create({ readIntent: () => intent,
    dispatch: item => { calls.push(item); return { ok: true }; },
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { controller, calls, timers, set: value => { intent = value; },
    fire() { for (const [id, item] of [...timers]) { timers.delete(id); item.callback(); } } };
}
test('viewing or restoring an empty draft never starts a prewarm', () => {
  const h = fixture(); h.controller.schedule(); h.fire(); assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});
test('a burst of input produces one prewarm at its first 800ms deadline and reuses that intent', () => {
  const h = fixture(); h.set({ key: 'chat:model:route' });
  for (let i = 0; i < 8; i++) h.controller.schedule();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 800);
  assert.equal(h.calls.length, 0); h.fire(); assert.equal(h.calls.length, 1);
  h.controller.schedule(); h.fire(); assert.equal(h.calls.length, 1);
});
function clockFixture() {
  const timers = new Map(), calls = []; let now = 0, next = 0, intent = null;
  const controller = create({ readIntent: () => intent,
    dispatch: item => { calls.push({ at: now, item }); return { ok: true }; },
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { controller, calls, timers, set: value => { intent = value; },
    advance(to) {
      for (;;) {
        const due = [...timers].filter(([, item]) => item.due <= to).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        now = due[1].due; timers.delete(due[0]); due[1].callback();
      }
      now = to;
    } };
}
test('continuous typing starts prewarm after 800ms from first input without waiting for a pause', () => {
  const h = clockFixture(); h.set({ key: 'chat:model:route', text: 'first' }); h.controller.schedule();
  for (let time = 100; time < 800; time += 100) {
    h.advance(time); h.set({ key: 'chat:model:route', text: 'draft at ' + time }); h.controller.schedule();
  }
  h.advance(799); assert.equal(h.calls.length, 0);
  h.advance(800); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].at, 800);
  assert.equal(h.calls[0].item.text, 'draft at 700');
  h.advance(900); h.controller.schedule(); h.advance(2000); assert.equal(h.calls.length, 1);
});
test('changed ownership or launch contract gets its own full deadline', () => {
  for (const key of ['new-chat', 'new-model', 'new-provider', 'new-navigation']) {
    const h = clockFixture(); h.set({ key: 'old' }); h.controller.schedule(); h.advance(400);
    h.set({ key }); h.controller.schedule(); h.advance(800); assert.equal(h.calls.length, 0);
    h.advance(1199); assert.equal(h.calls.length, 0); h.advance(1200);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].item.key, key);
  }
});
test('emptying the draft clears its original deadline and permits a later new draft', () => {
  const h = clockFixture(); h.set({ key: 'chat' }); h.controller.schedule(); h.advance(400);
  h.set(null); h.controller.schedule(); h.advance(800); assert.equal(h.calls.length, 0);
  h.set({ key: 'chat' }); h.controller.schedule(); h.advance(1600); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].at, 1600);
});
test('a queued stale timer cannot erase the active timer for a newer contract', () => {
  const h = clockFixture(); h.set({ key: 'old' }); h.controller.schedule();
  const stale = [...h.timers.values()][0].callback;
  h.advance(400); h.set({ key: 'new' }); h.controller.schedule(); stale();
  h.advance(500); h.controller.schedule(); h.advance(1200);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].at, 1200); assert.equal(h.calls[0].item.key, 'new');
});
test('navigation and sending cancel pending prewarm without dispatching the old conversation', () => {
  const h = fixture(); h.set({ key: 'old' }); h.controller.schedule(); h.controller.cancel(); h.fire();
  assert.equal(h.calls.length, 0); h.set({ key: 'new' }); h.controller.schedule(); h.fire();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].key, 'new');
});
test('a changed route, view, navigation generation or emptied draft invalidates a pending intent', () => {
  for (const changed of [null, { key: 'new-route' }, { key: 'new-navigation' }]) {
    const h = fixture(); h.set({ key: 'old' }); h.controller.schedule(); h.set(changed); h.fire();
    assert.equal(h.calls.length, 0);
  }
});
test('a stale timer already queued before cancellation cannot dispatch', () => {
  const h = fixture(); h.set({ key: 'chat' }); h.controller.schedule();
  const stale = [...h.timers.values()][0].callback; h.controller.cancel(); stale(); assert.equal(h.calls.length, 0);
});
test('failed prewarm can retry on later input without an unhandled rejection', async () => {
  let calls = 0, callback;
  const controller = create({ readIntent: () => ({ key: 'chat' }),
    dispatch: () => { calls++; return Promise.reject(new Error('fixture failure')); },
    setTimer: fn => { callback = fn; return 1; }, clearTimer() {},
  });
  controller.schedule(); callback(); await Promise.resolve(); controller.schedule(); callback();
  await Promise.resolve(); assert.equal(calls, 2);
});
test('canceling after dispatch does not kill or wait for the existing executor', () => {
  let resolve, calls = 0, callback;
  const controller = create({ readIntent: () => ({ key: 'chat' }),
    dispatch: () => { calls++; return new Promise(done => { resolve = done; }); },
    setTimer: fn => { callback = fn; return 1; }, clearTimer() {},
  });
  controller.schedule(); callback(); controller.cancel(); assert.equal(calls, 1); resolve({ ok: true });
});
function appIntent() {
  const start = app.indexOf('function composerPrewarmIntent()');
  const end = app.indexOf('\n}', start) + 2;
  const ctx = vm.createContext({ activeView: 'chat', providerRoutingLoaded: true,
    currentConv: { id: 'chat' }, inputEl: { value: 'hello' }, currentMode: 'plain', isConvRunning: () => false,
    pendingConversationSends: new Set(), conversationControls: new Map(), sessionRouteSnapshot: route => route,
    configuredChatRoute: () => ({ providerId: 'fixture', revision: 1 }), currentModel: 'model', currentSessionId: 'session',
    currentEffort: 'medium', currentAgent: null, currentWorkingDir: { path: '/fixture' }, runtimeModelForValue: value => value,
    pageNavigationVersion: 4, composerDraftOwner: {},
  });
  vm.runInContext(app.slice(start, end), ctx); return ctx;
}
test('actual composer intent excludes view-only, unsaved, empty, busy, controlled and agent states', () => {
  const changes = [ctx => { ctx.activeView = 'library'; }, ctx => { ctx.providerRoutingLoaded = false; },
    ctx => { ctx.currentConv = null; }, ctx => { ctx.inputEl.value = '  '; }, ctx => { ctx.isConvRunning = () => true; },
    ctx => { ctx.currentMode = 'agent'; }, ctx => { ctx.currentMode = 'orchestrate'; },
    ctx => { ctx.pendingConversationSends.add('chat'); }, ctx => { ctx.conversationControls.set('chat', {}); },
    ctx => { ctx.sessionRouteSnapshot = () => null; }];
  for (const change of changes) { const ctx = appIntent(); change(ctx); assert.equal(ctx.composerPrewarmIntent(), null); }
});
test('actual intent captures current conversation routing and changes with navigation or model', () => {
  const ctx = appIntent(), first = ctx.composerPrewarmIntent();
  assert.equal(first.args[0], 'chat'); assert.equal(first.args[3], 'model'); assert.equal(first.args[6], '/fixture');
  assert.equal(first.conversation, ctx.currentConv); assert.equal(first.draft, ctx.composerDraftOwner);
  ctx.pageNavigationVersion++; assert.notEqual(ctx.composerPrewarmIntent().key, first.key);
  ctx.currentModel = 'changed-model'; assert.equal(ctx.composerPrewarmIntent().args[3], 'changed-model');
});
