'use strict';

const { PAGE_CSS } = require('./browser-page-preload');


// Only presentation code enters remote documents. There is no bridge, IPC,
// user data, network request, or application capability in this script.
function installPageScrollbars(css) {
  const key = Symbol.for('relay.browser.scrollbars.v1');
  if (window[key]) { window[key](); return; }
  if (!document.documentElement || typeof CSSStyleSheet !== 'function') return;
  // Constructed sheets also work on pages with a strict style-src CSP, without
  // changing that policy or adding an unsafe-inline exception.
  const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
  const refresh = () => { if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; };
  refresh(); Object.defineProperty(window, key, { value: refresh, configurable: true });
  const visible = new Map();
  let near = null, dragging = null, frame = null, move = null;
  const root = () => document.scrollingElement || document.documentElement;
  function tone(node) {
    for (let current = node === root() ? document.body || node : node, depth = 0; current && depth < 20; current = current.parentElement, depth++) {
      const value = getComputedStyle(current).backgroundColor;
      const rgba = value.match(/^rgba?\(([^)]+)\)/);
      if (!rgba) continue;
      const channels = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (channels.length < 3 || channels.length > 3 && channels[3] < 0.5) continue;
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < 128 ? 'dark' : 'light';
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function hide(node) { clearTimeout(visible.get(node)); visible.delete(node); node.removeAttribute('data-relay-scroll-visible'); }
  function reveal(node) {
    if (!node || node.nodeType !== 1) return;
    clearTimeout(visible.get(node));
    node.setAttribute('data-relay-scroll-tone', tone(node)); node.setAttribute('data-relay-scroll-visible', '');
    visible.set(node, setTimeout(() => { if (node !== near && node !== dragging) hide(node); }, 750));
  }
  function candidate(path, x, y) {
    for (const node of [...path, root()]) {
      if (!node || node.nodeType !== 1) continue;
      const isRoot = node === root(), style = getComputedStyle(node);
      const vertical = node.scrollHeight > node.clientHeight + 1 && (isRoot || /auto|scroll/.test(style.overflowY));
      const horizontal = node.scrollWidth > node.clientWidth + 1 && (isRoot || /auto|scroll/.test(style.overflowX));
      if (!vertical && !horizontal) continue;
      const rect = isRoot ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : node.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (vertical && (style.direction === 'rtl' ? x - rect.left <= 16 : rect.right - x <= 16) || horizontal && rect.bottom - y <= 16) return node;
    }
    return null;
  }
  function updateNear() {
    frame = null;
    if (!move) return;
    const next = candidate(move.path, move.x, move.y), previous = near; near = next;
    if (previous && previous !== next) reveal(previous);
    if (next) reveal(next);
  }
  const pointerMove = event => {
    move = { x: event.clientX, y: event.clientY, path: event.composedPath() };
    if (frame == null) frame = requestAnimationFrame(updateNear);
  };
  const pointerDown = event => { dragging = candidate(event.composedPath(), event.clientX, event.clientY); if (dragging) reveal(dragging); };
  const pointerUp = () => { const previous = dragging; dragging = null; if (previous) reveal(previous); };
  const pointerLeave = () => { const previous = near; near = null; if (previous) reveal(previous); };
  const scroll = event => reveal(event.target === document ? root() : event.target);
  const reset = () => { near = dragging = null; move = null; if (frame != null) cancelAnimationFrame(frame); frame = null; for (const node of [...visible.keys()]) hide(node); };
  const visibility = () => { if (document.visibilityState !== 'visible') reset(); };
  document.addEventListener('pointermove', pointerMove, { passive: true, capture: true });
  document.addEventListener('pointerdown', pointerDown, { passive: true, capture: true });
  document.addEventListener('pointerup', pointerUp, { passive: true, capture: true });
  document.addEventListener('pointercancel', pointerUp, { passive: true, capture: true });
  document.addEventListener('pointerleave', pointerLeave, { passive: true });
  document.addEventListener('scroll', scroll, { passive: true, capture: true });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', reset);
  window.addEventListener('pagehide', () => {
    reset();
    // A back/forward cache restore keeps the existing listeners and sheet.
    // A replaced document discards this entire unprivileged script context.
  });
}

const PAGE_SCRIPT = '(' + installPageScrollbars.toString() + ')(' + JSON.stringify(PAGE_CSS) + ')';
function attachBrowserPageScrollbars(contents, allowAdditionalUrl = () => false) {
  let disposed = false, mainStyle = null;
  let styleRevision = 0;
  const pending = new WeakSet();
  function allowed(frame) { return /^(https?:|about:(?:blank|srcdoc)$)/i.test(frame.url || '') || allowAdditionalUrl(frame.url || '') === true; }
  function install(frame) {
    if (disposed || !frame || pending.has(frame) || !allowed(frame) || typeof frame.executeJavaScript !== 'function') return;
    pending.add(frame);
    Promise.resolve().then(() => {
      if (!disposed && !contents.isDestroyed()) return frame.executeJavaScript(PAGE_SCRIPT, false);
    }).catch(() => { /* Navigated or detached frames are retried on their next load. */ }).finally(() => pending.delete(frame));
  }
  function styleMain() {
    if (disposed || contents.isDestroyed() || typeof contents.insertCSS !== 'function') return;
    const revision = ++styleRevision;
    try {
      Promise.resolve(contents.insertCSS(PAGE_CSS, { cssOrigin: 'user' })).then(key => {
        if (disposed || contents.isDestroyed()) return;
        if (revision !== styleRevision) { void contents.removeInsertedCSS?.(key).catch(() => {}); return; }
        const previous = mainStyle; mainStyle = key;
        if (previous && previous !== key) void contents.removeInsertedCSS?.(previous).catch(() => {});
      }).catch(() => {});
    } catch (_) {}
  }
  function ready() { styleMain(); all(); }
  function all() {
    if (disposed || contents.isDestroyed()) return;
    try { for (const frame of contents.mainFrame?.framesInSubtree || []) install(frame); } catch (_) {}
  }
  function loaded(_event, _isMainFrame, processId, routingId) {
    if (disposed || contents.isDestroyed()) return;
    try {
      const frames = contents.mainFrame?.framesInSubtree || [];
      const frame = frames.find(value => value.processId === processId && value.routingId === routingId);
      if (frame) install(frame); else all();
    } catch (_) {}
  }
  const dispose = () => { if (disposed) return; disposed = true; contents.removeListener('dom-ready', ready); contents.removeListener('did-frame-finish-load', loaded); contents.removeListener('destroyed', dispose); };
  contents.on('dom-ready', ready); contents.on('did-frame-finish-load', loaded); contents.once('destroyed', dispose);
  return { dispose };
}

module.exports = { attachBrowserPageScrollbars, PAGE_SCRIPT, PAGE_CSS };
