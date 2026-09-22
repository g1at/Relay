'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { attachBrowserPageScrollbars, PAGE_SCRIPT, PAGE_CSS } = require('../src/main/browser/browser-page-scrollbars');
const tick = () => new Promise(setImmediate);

test('browser scrollbar styles reach the main document and loaded web frames without adding a preload or user gesture', async () => {
  const wc = new EventEmitter(), calls = [], styles = [];
  wc.isDestroyed = () => false;
  const frame = (url, id) => ({ url, processId: 1, routingId: id, executeJavaScript: async (source, gesture) => { calls.push({ id, source, gesture }); } });
  const main = frame('https://page.test', 1), child = frame('https://another.test/frame', 2), privileged = frame('chrome://settings', 3);
  wc.mainFrame = main; main.framesInSubtree = [main, child, privileged];
  wc.insertCSS = async (css, options) => { styles.push({ css, options }); return 'style-' + styles.length; };
  wc.removeInsertedCSS = async () => {};
  const binding = attachBrowserPageScrollbars(wc); wc.emit('dom-ready'); await tick();
  assert.deepEqual(calls.map(item => item.id), [1, 2]); assert.ok(calls.every(item => item.gesture === false));
  assert.equal(styles[0].options.cssOrigin, 'user'); assert.equal(styles[0].css, PAGE_CSS);
  assert.doesNotMatch(PAGE_SCRIPT, /ipcRenderer|require\(|fetch\(|XMLHttpRequest|localStorage|\.focus\(|preventDefault\(/);
  child.url = 'https://another.test/new'; wc.emit('did-frame-finish-load', {}, false, 1, 2); await tick();
  assert.deepEqual(calls.map(item => item.id), [1, 2, 2]); binding.dispose();
});

test('navigation retries a detached frame and concurrent load notifications do not multiply in-flight scripts', async () => {
  const wc = new EventEmitter(); wc.isDestroyed = () => false;
  let reject, count = 0;
  const frame = { url: 'https://page.test', processId: 1, routingId: 1, executeJavaScript: () => { count++; return new Promise((_resolve, fail) => { reject = fail; }); } };
  wc.mainFrame = { framesInSubtree: [frame] };
  const binding = attachBrowserPageScrollbars(wc);
  wc.emit('dom-ready'); wc.emit('did-frame-finish-load', {}, true, 1, 1); await tick(); assert.equal(count, 1);
  reject(Error('frame navigated')); await tick(); wc.emit('dom-ready'); await tick(); assert.equal(count, 2);
  reject(Error('frame closed')); await tick(); binding.dispose(); assert.equal(wc.listenerCount('dom-ready'), 0);
});

test('closing a browser removes load listeners and prevents queued page injection', async () => {
  const wc = new EventEmitter(); wc.isDestroyed = () => false;
  let count = 0;
  wc.mainFrame = { framesInSubtree: [{ url: 'about:blank', executeJavaScript: async () => { count++; } }] };
  attachBrowserPageScrollbars(wc); wc.emit('dom-ready'); wc.emit('destroyed'); await tick();
  assert.equal(count, 0); assert.equal(wc.listenerCount('did-frame-finish-load'), 0);
});

function page() {
  class Target extends EventEmitter {
    addEventListener(name, fn) { this.on(name, fn); } removeEventListener(name, fn) { this.off(name, fn); }
  }
  const element = (rect, style = {}) => ({ nodeType: 1, attrs: new Map(), style: { overflowY: 'auto', overflowX: 'auto', backgroundColor: 'rgb(250, 250, 250)', direction: 'ltr', ...style }, parentElement: null, scrollHeight: 1800, scrollWidth: 100, clientHeight: 300, clientWidth: 100,
    getBoundingClientRect: () => rect, setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const document = new Target(), window = new Target(), root = element({ left: 0, top: 0, right: 600, bottom: 500 });
  document.documentElement = document.scrollingElement = root; document.adoptedStyleSheets = []; document.visibilityState = 'visible';
  const timers = new Map(), frames = new Map(); let id = 0;
  const context = vm.createContext({ document, window, CSSStyleSheet: class { replaceSync(css) { this.css = css; } }, Symbol, innerWidth: 600, innerHeight: 500,
    getComputedStyle: node => node.style, matchMedia: () => ({ matches: false }),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id) });
  const install = () => vm.runInContext(PAGE_SCRIPT, context); install();
  const emit = (type, target = root, extras = {}) => document.emit(type, { target, composedPath: () => [target, root], ...extras });
  const flush = () => { const all = [...frames.values()]; frames.clear(); all.forEach(fn => fn()); };
  const expire = () => { const all = [...timers.values()]; timers.clear(); all.forEach(fn => fn()); };
  return { document, window, root, element, install, emit, flush, expire, timers, visible: node => node.attrs.has('data-relay-scroll-visible') };
}

test('native thumb appears only near a scroll edge or during scroll, and hides after leaving', () => {
  const p = page(); assert.equal(p.visible(p.root), false);
  p.emit('pointermove', p.root, { clientX: 300, clientY: 200 }); p.flush(); assert.equal(p.visible(p.root), false);
  p.emit('pointermove', p.root, { clientX: 590, clientY: 200 }); p.flush(); assert.equal(p.visible(p.root), true);
  p.expire(); assert.equal(p.visible(p.root), true);
  p.emit('pointermove', p.root, { clientX: 300, clientY: 200 }); p.flush(); p.expire(); assert.equal(p.visible(p.root), false);
  p.emit('scroll', p.document); assert.equal(p.visible(p.root), true); p.expire(); assert.equal(p.visible(p.root), false);
});

test('nested text areas, horizontal scroll and right-to-left edges retain independent native scrolling', () => {
  const p = page(), dark = p.element({ left: 10, top: 10, right: 210, bottom: 310 }, { backgroundColor: 'rgb(25, 25, 25)' });
  p.emit('pointermove', dark, { clientX: 205, clientY: 50 }); p.flush(); assert.equal(p.visible(dark), true); assert.equal(p.visible(p.root), false);
  assert.equal(dark.attrs.get('data-relay-scroll-tone'), 'dark');
  const horizontal = p.element({ left: 10, top: 10, right: 210, bottom: 110 }); horizontal.scrollHeight = 20; horizontal.scrollWidth = 900;
  p.emit('pointermove', horizontal, { clientX: 100, clientY: 105 }); p.flush(); assert.equal(p.visible(horizontal), true);
  const rtl = p.element({ left: 10, top: 10, right: 210, bottom: 310 }, { direction: 'rtl' });
  p.emit('pointermove', rtl, { clientX: 15, clientY: 50 }); p.flush(); assert.equal(p.visible(rtl), true);
});

test('dragging keeps a thumb visible and hidden documents clear pending state', () => {
  const p = page(); p.emit('pointerdown', p.root, { clientX: 598, clientY: 40 }); p.expire(); assert.equal(p.visible(p.root), true);
  p.emit('pointerup'); p.expire(); assert.equal(p.visible(p.root), false);
  p.emit('scroll', p.document); p.document.visibilityState = 'hidden'; p.emit('visibilitychange');
  assert.equal(p.visible(p.root), false); assert.equal(p.timers.size, 0);
});

test('repeated navigation notifications reuse one sheet and one set of document listeners', () => {
  const p = page(); p.install(); p.install(); assert.equal(p.document.adoptedStyleSheets.length, 1); assert.equal(p.document.listenerCount('scroll'), 1);
  p.document.adoptedStyleSheets = []; p.install(); assert.equal(p.document.adoptedStyleSheets.length, 1);
});

test('presentation preload inserts the same user stylesheet synchronously before the document exists', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../browser-page-preload.js'), 'utf8');
  const calls = [], context = vm.createContext({ process: { type: 'renderer' }, module: { exports: {} },
    require(name) { assert.equal(name, 'electron'); return { webFrame: { insertCSS(css, options) { calls.push({ css, origin: options.cssOrigin }); return 'early'; } } }; } });
  vm.runInContext(source, context);
  assert.deepEqual(calls, [{ css: PAGE_CSS, origin: 'user' }]);
  assert.equal(context.window, undefined); assert.equal(context.document, undefined);
  assert.doesNotMatch(source, /ipcRenderer|contextBridge|executeJavaScript|fetch\(|XMLHttpRequest|addEventListener/);
});

test('loading the shared presentation stylesheet in the browser process does not require renderer APIs', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../browser-page-preload.js'), 'utf8');
  const context = vm.createContext({ process: { type: 'browser' }, module: { exports: {} }, require() { throw Error('renderer API in browser process'); } });
  vm.runInContext(source, context); assert.equal(context.module.exports.PAGE_CSS, PAGE_CSS);
});
