'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('// Follow the user\'s scrolling intent,');
const end = source.indexOf('// 把已完成的历史轮次拼成文字上下文', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const listeners = new Map(), windowListeners = new Map(), frames = new Map(), timers = new Map();
  let nextId = 0, top = 1500, pendingScroll = false, writes = 0;
  const register = table => (name, callback) => {
    if (!table.has(name)) table.set(name, []);
    table.get(name).push(callback);
  };
  const element = (overrides = {}) => ({ nodeType: 1, parentElement: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0, closest: () => null, ...overrides });
  const messages = element({ scrollHeight: 2000, clientHeight: 500, clientWidth: 900, offsetWidth: 909,
    addEventListener: register(listeners), getBoundingClientRect: () => ({ left: 0, right: 909 }),
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; },
  });
  Object.defineProperty(messages, 'scrollTop', { get: () => top, set: value => {
    const next = Math.max(0, Math.min(value, messages.scrollHeight - messages.clientHeight));
    if (next !== top) { top = next; writes++; pendingScroll = true; }
  } });
  const body = element(), documentElement = element();
  const ctx = vm.createContext({ messagesEl: messages, activeView: 'chat',
    document: { body, documentElement }, window: { addEventListener: register(windowListeners) },
    getComputedStyle: node => ({ overflowY: node.overflowY || 'visible' }),
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    scheduleConversationIndexUpdate() {},
  });
  vm.runInContext(source.slice(start, end), ctx);
  function emit(name, data = {}, windowEvent = false) {
    for (const callback of (windowEvent ? windowListeners : listeners).get(name) || []) callback({ target: messages, ...data });
  }
  function scroll(value) { top = Math.max(0, Math.min(value, messages.scrollHeight - messages.clientHeight)); emit('scroll'); }
  function flush() {
    let count = 0;
    while (frames.size || pendingScroll) {
      assert.ok(count++ < 15, 'following settles without a frame loop');
      if (pendingScroll) { pendingScroll = false; emit('scroll'); }
      const current = [...frames.values()]; frames.clear(); for (const callback of current) callback();
    }
    return count;
  }
  return { ctx, messages, element, body, frames, timers, emit, scroll, flush,
    following: () => vm.runInContext('stickToBottom', ctx),
    expire: () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    grow(height) { messages.scrollHeight = height; emit('contentvisibilityautostatechange'); },
    get top() { return top; }, get writes() { return writes; },
  };
}

test('content-visibility height corrections and program scroll events retain following and settle at the real bottom', () => {
  const h = fixture();
  h.messages.clientHeight = 560; h.messages.scrollHeight = 29774;
  h.scroll(27834); h.emit('contentvisibilityautostatechange'); h.ctx.scrollToBottom();
  assert.equal(h.following(), true); assert.equal(h.frames.size, 1);
  assert.ok(h.flush() <= 3); assert.equal(h.top, 29214); assert.equal(h.following(), true);
  const writes = h.writes;
  h.emit('contentvisibilityautostatechange'); h.flush(); assert.equal(h.writes, writes);
  h.messages.clientHeight = 480; h.ctx.scrollToBottom(); h.flush(); assert.equal(h.top, 29294);
});

test('an upward wheel cancels an already queued follow and later streaming or layout never pulls the reader back', () => {
  const h = fixture(); h.ctx.scrollToBottom();
  h.emit('wheel', { deltaY: -240 }); h.scroll(1260); h.flush();
  assert.equal(h.following(), false); assert.equal(h.top, 1260);
  h.expire(); h.grow(4000); h.ctx.scrollToBottom(); h.emit('load'); h.flush();
  assert.equal(h.top, 1260); assert.equal(h.frames.size, 0);
});

test('programmatically reaching the bottom does not restore following until the user scrolls toward it', () => {
  const h = fixture(); h.emit('wheel', { deltaY: -200 }); h.scroll(1000); h.expire();
  h.scroll(1500); assert.equal(h.following(), false);
  h.emit('wheel', { deltaY: 100 }); assert.equal(h.following(), true);
  h.grow(2500); h.flush(); assert.equal(h.top, 2000);
});

test('scrolling down from an older message restores following only near the bottom', () => {
  const h = fixture(); h.ctx.stopFollowingMessages(); h.scroll(500);
  h.emit('wheel', { deltaY: 500 }); h.scroll(1000); assert.equal(h.following(), false);
  h.scroll(1460); assert.equal(h.following(), true); h.flush(); assert.equal(h.top, 1500);
});

test('wheel scrolling inside a tool output is independent until the inner scroller reaches its edge', () => {
  const h = fixture(), nested = h.element({ parentElement: h.messages, overflowY: 'auto', scrollTop: 100, scrollHeight: 600, clientHeight: 200 });
  h.emit('wheel', { target: nested, deltaY: -50 }); assert.equal(h.following(), true);
  nested.scrollTop = 0; h.emit('wheel', { target: nested, deltaY: -50 }); assert.equal(h.following(), false);
});

test('keyboard page navigation stops following while editing and zoom gestures are ignored', () => {
  const h = fixture(), input = h.element({ parentElement: h.messages, closest: () => ({}) });
  h.emit('keydown', { target: input, key: 'ArrowUp' }, true); assert.equal(h.following(), true);
  h.emit('wheel', { deltaY: -200, ctrlKey: true }); assert.equal(h.following(), true);
  h.emit('keydown', { target: h.body, key: 'PageUp' }, true); h.scroll(500); assert.equal(h.following(), false);
  h.emit('keydown', { target: h.body, key: 'End' }, true); h.scroll(1500); assert.equal(h.following(), true);
});

test('touch scrolling can leave output and resume following without treating an ordinary touch as scroll intent', () => {
  const h = fixture(); h.emit('touchstart', { touches: [{ clientY: 400 }] }); assert.equal(h.following(), true);
  h.emit('touchmove', { touches: [{ clientY: 500 }] }); h.scroll(1300); assert.equal(h.following(), false);
  h.emit('touchmove', { touches: [{ clientY: 100 }] }); h.scroll(1500); h.emit('touchend');
  assert.equal(h.following(), true);
});

test('native scrollbar dragging owns scrolling until the user brings the thumb back to the bottom', () => {
  const h = fixture();
  h.emit('pointerdown', { button: 0, pointerId: 1, clientX: 902 }); h.scroll(800);
  h.emit('pointerup', { pointerId: 1 }, true); assert.equal(h.following(), false);
  h.grow(3000); h.flush(); assert.equal(h.top, 800);
  h.emit('pointerdown', { button: 0, pointerId: 2, clientX: 902 }); h.scroll(2500);
  h.emit('pointerup', { pointerId: 2 }, true); h.flush(); assert.equal(h.following(), true);
});

test('history navigation clears recent wheel intent and cannot be undone by smooth-scroll or CV events', () => {
  const h = fixture(); h.emit('wheel', { deltaY: 30 }); h.ctx.stopFollowingMessages();
  h.scroll(1480); h.emit('contentvisibilityautostatechange'); h.scroll(200); h.flush();
  assert.equal(h.following(), false); assert.equal(h.top, 200);
  h.ctx.scrollToBottom(true); h.flush(); assert.equal(h.following(), true); assert.equal(h.top, 1500);
});

test('layout on an inactive page schedules no scrolling and does not overwrite the remembered reader intent', () => {
  const h = fixture(); h.ctx.activeView = 'settings'; h.grow(3000); h.scroll(1000); h.flush();
  assert.equal(h.following(), true); assert.equal(h.writes, 0); assert.equal(h.frames.size, 0);
});
