'use strict';

// A sandbox preload with no API exposed to the remote page. Inserting a user stylesheet synchronously
// before parsing prevents a native scrollbar from painting while HTML, scripts
// or stylesheets are still loading. Nothing is exposed to the remote page.
const PAGE_CSS = `
    :where(html, body, body *) { scrollbar-width:auto!important; scrollbar-color:auto!important; }
    :where(html, body, body *)::-webkit-scrollbar { width:9px!important; height:9px!important; background:transparent!important; }
    :where(html, body, body *)::-webkit-scrollbar-track,
    :where(html, body, body *)::-webkit-scrollbar-corner { background:transparent!important; }
    :where(html, body, body *)::-webkit-scrollbar-thumb { background:transparent!important; border:1px solid transparent!important; border-radius:999px!important; background-clip:padding-box!important; }
    [data-relay-scroll-visible]::-webkit-scrollbar-thumb { background-color:#b5b8be!important; }
    [data-relay-scroll-visible][data-relay-scroll-tone="dark"]::-webkit-scrollbar-thumb { background-color:#666c76!important; }
    [data-relay-scroll-visible]::-webkit-scrollbar-thumb:hover { background-color:#858a93!important; }
    [data-relay-scroll-visible][data-relay-scroll-tone="dark"]::-webkit-scrollbar-thumb:hover { background-color:#939aa5!important; }
    :where(html, body, body *)::-webkit-scrollbar-button { display:none!important; width:0!important; height:0!important; }
    @media(forced-colors:active) { [data-relay-scroll-visible]::-webkit-scrollbar-thumb { background-color:GrayText!important; } [data-relay-scroll-visible]::-webkit-scrollbar-thumb:hover { background-color:CanvasText!important; } }
  `;


function annotationRect(rect, width, height) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const x = Math.max(0, Math.min(width, rect.x)), y = Math.max(0, Math.min(height, rect.y));
  const right = Math.max(x, Math.min(width, rect.x + rect.width)), bottom = Math.max(y, Math.min(height, rect.y + rect.height));
  return right - x >= 2 && bottom - y >= 2 ? { x, y, width: right - x, height: bottom - y } : null;
}
function annotationElement(node) {
  if (!node || node.nodeType !== 1) return { text: '', tagName: '', selector: '' };
  const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const tagName = clean(node.tagName, 40).toLowerCase();
  // Never read form values, password contents or storage into annotation data.
  const label = node.getAttribute?.('aria-label') || node.getAttribute?.('title') || (/^(?:input|textarea|select)$/.test(tagName) ? '' : node.innerText || '');
  const escape = value => typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, char => '\\' + char);
  let selector = '';
  if (node.id) selector = '#' + escape(node.id);
  else {
    let current = node; const parts = [];
    for (let depth = 0; current?.nodeType === 1 && depth < 5; depth++, current = current.parentElement) {
      const tag = clean(current.tagName, 40).toLowerCase(); if (!tag) break;
      const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.tagName === current.tagName) : [];
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''));
      if (current.parentElement?.id) { parts.unshift('#' + escape(current.parentElement.id)); break; }
    }
    selector = parts.join(' > ');
  }
  return { text: clean(label, 2000), tagName, selector: clean(selector, 1000) };
}
function installAnnotationPicker(ipcRenderer, view, doc) {
  let active = null;
  const listen = (node, name, fn, options) => { node.addEventListener(name, fn, options); return () => node.removeEventListener(name, fn, options); };
  function end(send = false, reason = '') {
    const selection = active; if (!selection) return;
    active = null; selection.cleanups.forEach(cleanup => cleanup()); selection.host.remove();
    if (send) ipcRenderer.send('browser:page-event', { type: 'annotation-cancel', requestId: selection.requestId, revision: selection.revision, reason });
  }
  function start(_event, request) {
    if (!request || typeof request.requestId !== 'string' || request.requestId.length > 200 || !['element', 'region'].includes(request.mode) || !doc.documentElement
      || !Number.isInteger(request.revision) || request.revision < 0 || !request.viewport
      || !['width', 'height'].every(key => Number.isFinite(request.viewport[key]) && request.viewport[key] > 0 && request.viewport[key] <= 16384)) return;
    const maximum = request.viewportMax || request.viewport;
    if (!['width', 'height'].every(key => Number.isInteger(maximum[key]) && maximum[key] >= request.viewport[key]
      && maximum[key] - request.viewport[key] <= 1 && maximum[key] <= 16384)) return;
    if (active?.requestId === request.requestId && active.revision >= request.revision) return;
    end();
    const host = doc.createElement('div'); host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:auto!important;touch-action:none!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style'); style.textContent = ':host{all:initial} .frame{position:fixed;box-sizing:border-box;border:2px solid #3684ff;border-radius:3px;background:#3684ff18;pointer-events:none}.hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 16px;border-radius:10px;background:#172030;color:white;font:13px/1.4 system-ui;box-shadow:0 4px 20px #0003;pointer-events:none}';
    const frame = doc.createElement('div'), hint = doc.createElement('div'); frame.className = 'frame'; frame.hidden = true; hint.className = 'hint';
    hint.textContent = '正在准备网页选择 · Esc 取消';
    shadow.append(style, frame, hint); doc.documentElement.append(host);
    const selection = active = { ...request, host, cleanups: [], origin: null, target: null, rect: null, finishing: false,
      viewport: null, ready: false };
    let previousViewport = '', stableFrames = 0;
    const changedViewport = () => view.innerWidth !== selection.viewport?.width || view.innerHeight !== selection.viewport?.height;
    const settle = () => {
      if (active !== selection) return;
      if (doc.visibilityState === 'hidden') { end(true, 'hidden'); return; }
      const viewport = { width: view.innerWidth, height: view.innerHeight }, signature = JSON.stringify(viewport);
      const matches = ['width', 'height'].every(key => viewport[key] >= request.viewport[key] && viewport[key] <= maximum[key]);
      stableFrames = matches && signature === previousViewport ? stableFrames + 1 : 0; previousViewport = signature;
      if (stableFrames < 2) { view.requestAnimationFrame(settle); return; }
      selection.viewport = viewport; selection.ready = true;
      hint.textContent = request.mode === 'region' ? '拖动框选要反馈的区域 · Esc 取消' : '点击要反馈的页面元素 · Esc 取消';
      ipcRenderer.send('browser:page-event', { type: 'annotation-ready', requestId: selection.requestId, revision: selection.revision, viewport });
    };
    view.requestAnimationFrame(settle);
    const paint = rect => { selection.rect = rect; frame.hidden = !rect; if (rect) Object.assign(frame.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' }); };
    function targetAt(event) {
      // The transparent capture layer also receives gestures over child frames.
      // Temporarily exclude only our overlay from hit testing; iframe contents
      // remain opaque and are represented by the iframe element itself.
      host.style.setProperty('pointer-events', 'none', 'important');
      let node; try { node = doc.elementFromPoint(event.clientX, event.clientY); }
      finally { host.style.setProperty('pointer-events', 'auto', 'important'); }
      for (let n = 0; node?.shadowRoot && n < 8; n++) { const next = node.shadowRoot.elementFromPoint?.(event.clientX, event.clientY); if (!next || next === node) break; node = next; }
      return node;
    }
    const suppress = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const move = event => {
      if (active !== selection || !selection.ready || !event.isTrusted || selection.finishing) return;
      if (request.mode === 'region') {
        if (selection.origin) paint(annotationRect({ x: Math.min(selection.origin.x, event.clientX), y: Math.min(selection.origin.y, event.clientY), width: Math.abs(selection.origin.x - event.clientX), height: Math.abs(selection.origin.y - event.clientY) }, view.innerWidth, view.innerHeight));
      } else {
        selection.target = targetAt(event); const rect = selection.target?.getBoundingClientRect();
        paint(rect && annotationRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, view.innerWidth, view.innerHeight));
      }
    };
    const finish = () => {
      if (!selection.ready || !selection.rect || active !== selection || selection.finishing) return;
      if (changedViewport()) { end(true, 'viewport-changed'); return; }
      selection.finishing = true;
      const metadata = request.mode === 'element' ? annotationElement(selection.target) : { text: '', tagName: '', selector: '' };
      const payload = { type: 'annotation', requestId: selection.requestId, revision: selection.revision, selection: { kind: request.mode, rect: selection.rect, ...metadata }, viewport: { width: view.innerWidth, height: view.innerHeight } };
      // Remove the highlight before the trusted host captures the viewport.
      host.style.display = 'none';
      view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
        if (active !== selection) return;
        if (changedViewport()) { end(true, 'viewport-changed'); return; }
        end(); ipcRenderer.send('browser:page-event', payload);
      }));
    };
    selection.cleanups.push(listen(doc, 'pointermove', move, true));
    selection.cleanups.push(listen(doc, 'pointerdown', event => {
      if (!event.isTrusted || active !== selection) return; suppress(event);
      if (event.button !== 0 || !selection.ready) return;
      if (request.mode === 'region') { selection.origin = { x: event.clientX, y: event.clientY }; paint(null); }
      else move(event);
    }, true));
    selection.cleanups.push(listen(doc, 'pointerup', event => { if (!event.isTrusted || active !== selection) return; suppress(event); if (event.button === 0) { move(event); finish(); } }, true));
    for (const name of ['click', 'dblclick', 'contextmenu']) selection.cleanups.push(listen(doc, name, event => { if (event.isTrusted && active === selection) suppress(event); }, true));
    selection.cleanups.push(listen(doc, 'keydown', event => { if (!event.isTrusted || active !== selection) return; suppress(event); if (event.key === 'Escape') end(true, 'escape'); else if (event.key === 'Enter' && request.mode === 'element') finish(); }, true));
    selection.cleanups.push(listen(view, 'resize', () => {
      // setBounds/show acknowledgements precede Chromium's queued DOM events.
      // A resize belonging to the preceding menu/dialog must not cancel a new
      // picker if its viewport already matches the geometry used by selection.
      if (active !== selection) return;
      if (selection.ready && changedViewport()) end(true, 'viewport-changed');
      else if (!selection.ready) { previousViewport = ''; stableFrames = 0; }
    }), listen(view, 'pagehide', () => end(true, 'pagehide')), listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') end(true, 'hidden'); }));
  }
  const cancel = (_event, request) => { if (!request?.requestId || active?.requestId === request.requestId) end(); };
  ipcRenderer.on('relay:browser-annotation-start', start); ipcRenderer.on('relay:browser-annotation-cancel', cancel);
  return () => { end(); ipcRenderer.removeListener('relay:browser-annotation-start', start); ipcRenderer.removeListener('relay:browser-annotation-cancel', cancel); };
}
function installInputTakeover(ipcRenderer, view, doc, { visibilityTimeoutMs = 300 } = {}) {
  let intent = null, documentToken = null, visibilityWait = null;
  const cancelVisibilityWait = () => {
    if (!visibilityWait) return;
    clearTimeout(visibilityWait.timer); doc.removeEventListener('visibilitychange', visibilityWait.changed);
    visibilityWait = null;
  };
  const clear = (_event, request) => {
    if (!request?.token || intent?.token === request.token) intent = null;
    if (!request?.token || visibilityWait?.token === request.token) cancelVisibilityWait();
  };
  const context = (_event, request) => { cancelVisibilityWait(); documentToken = request?.documentToken || null; intent = null; };
  const prepare = (_event, request) => {
    const expected = request?.expected;
    if (!request?.token || !request.documentToken || !expected || !['pointerdown', 'wheel', 'visibility'].includes(expected.type)
      || expected.type !== 'visibility' && (![expected.x, expected.y].every(Number.isFinite) || ![1, 2].includes(expected.count))) return;
    cancelVisibilityWait(); documentToken = request.documentToken; intent = null;
    const acknowledge = () => {
      if (expected.type !== 'visibility') intent = { token: request.token, expected: { ...expected }, remaining: expected.count };
      const visible = doc.visibilityState === 'visible';
      ipcRenderer.send('browser:page-event', { type: 'input-ready', token: request.token, visible,
        ...(!visible && request.allowBackground === true ? { background: true } : {}) });
    };
    // This permission only arrives over the isolated main-process channel after
    // task lease validation. Hidden execution retains the same exact one-shot
    // pointer intent; it cannot mask unrelated input when the view reappears.
    if (request.allowBackground === true) { acknowledge(); return; }
    // Host layout can precede Chromium's visibility transition. Wait briefly
    // for that transition, without letting an old/cancelled request grant input.
    if (doc.visibilityState === 'visible') { acknowledge(); return; }
    const pending = { token: request.token, timer: null, changed: null };
    pending.changed = () => {
      if (visibilityWait !== pending || doc.visibilityState !== 'visible') return;
      cancelVisibilityWait(); acknowledge();
    };
    visibilityWait = pending; doc.addEventListener('visibilitychange', pending.changed);
    pending.timer = setTimeout(() => {
      if (visibilityWait !== pending) return;
      cancelVisibilityWait(); ipcRenderer.send('browser:page-event', { type: 'input-not-visible', token: request.token });
    }, Math.max(0, Math.min(300, visibilityTimeoutMs)));
  };
  const pointer = event => {
    if (!event.isTrusted || !documentToken) return;
    const expected = intent?.expected, modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
      | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const matches = expected && event.type === expected.type && Math.abs(event.clientX - expected.x) <= 1
      && Math.abs(event.clientY - expected.y) <= 1 && modifiers === expected.modifiers
      && (event.type === 'pointerdown' ? event.button === expected.button
        : event.deltaMode === 0 && Math.abs(event.deltaX - expected.deltaX) <= 0.01 && Math.abs(event.deltaY - expected.deltaY) <= 0.01);
    if (matches) {
      if (--intent.remaining === 0) { const token = intent.token; intent = null; ipcRenderer.send('browser:page-event', { type: 'input-consumed', token }); }
      return;
    }
    // No blanket suppression interval: any nonmatching native input takes over,
    // including input arriving while a model command is in flight.
    cancelVisibilityWait(); intent = null;
    ipcRenderer.send('browser:page-event', { type: 'manual-pointer', documentToken, url: view.location.href });
  };
  const pagehide = () => { cancelVisibilityWait(); intent = null; documentToken = null; };
  ipcRenderer.on('relay:browser-input-prepare', prepare); ipcRenderer.on('relay:browser-input-cancel', clear);
  ipcRenderer.on('relay:browser-input-context', context);
  doc.addEventListener('pointerdown', pointer, true); doc.addEventListener('wheel', pointer, { capture: true, passive: true });
  view.addEventListener('pagehide', pagehide);
  return () => {
    pagehide();
    ipcRenderer.removeListener('relay:browser-input-prepare', prepare); ipcRenderer.removeListener('relay:browser-input-cancel', clear);
    ipcRenderer.removeListener('relay:browser-input-context', context);
    doc.removeEventListener('pointerdown', pointer, true); doc.removeEventListener('wheel', pointer, true);
    view.removeEventListener('pagehide', pagehide);
  };
}
if (typeof process !== 'undefined' && process.type === 'renderer') {
  const { webFrame, ipcRenderer } = require('electron');
  webFrame.insertCSS(PAGE_CSS, { cssOrigin: 'user' });
  if (ipcRenderer?.on && typeof window !== 'undefined' && typeof document !== 'undefined' && window.top === window) {
    installAnnotationPicker(ipcRenderer, window, document); installInputTakeover(ipcRenderer, window, document);
  }
}
module.exports = { PAGE_CSS, annotationRect, annotationElement, installAnnotationPicker, installInputTakeover };
