'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { annotationRect, annotationElement, installAnnotationPicker } = require('../browser-page-preload');
test('selection rectangles clamp to visible viewport and reject empty or invalid regions', () => {
  assert.deepEqual(annotationRect({ x: -10, y: 80, width: 60, height: 50 }, 100, 100), { x: 0, y: 80, width: 50, height: 20 });
  for (const rect of [{ x: 0, y: 0, width: 1, height: 30 }, { x: NaN, y: 0, width: 30, height: 30 }, { x: 100, y: 0, width: 30, height: 30 }]) assert.equal(annotationRect(rect, 100, 100), null);
});
test('selected form fields use labels but never read entered values', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const node = { nodeType: 1, tagName, id: 'password', getAttribute: key => key === 'aria-label' ? 'Password' : '', get value() { throw Error('secret value read'); }, get innerText() { throw Error('form contents read'); } };
    assert.deepEqual(annotationElement(node), { text: 'Password', tagName: tagName.toLowerCase(), selector: '#password' });
  }
});
function picker() {
  class Target extends EventEmitter { addEventListener(name, fn) { this.on(name, fn); } removeEventListener(name, fn) { this.off(name, fn); } }
  const element = tag => ({ nodeType: 1, tagName: tag.toUpperCase(), style: { setProperty(key, value) { this[key] = value; } }, children: [], append(...nodes) { this.children.push(...nodes); }, attachShadow() { this.shadow = element('shadow'); return this.shadow; }, remove() { this.removed = true; } });
  const doc = new Target(), view = new Target(), ipc = new EventEmitter(), sent = [], ready = [], frames = [];
  doc.documentElement = element('html'); doc.createElement = element; doc.visibilityState = 'visible';
  const target = { ...element('button'), id: 'save', innerText: 'Save', getAttribute() { return null; }, getBoundingClientRect: () => ({ x: 10, y: 20, width: 40, height: 30 }) }; doc.elementFromPoint = () => target;
  Object.assign(view, { innerWidth: 800, innerHeight: 600, requestAnimationFrame: fn => frames.push(fn) });
  ipc.send = (channel, payload) => (payload.type === 'annotation-ready' ? ready : sent).push({ channel, payload }); const dispose = installAnnotationPicker(ipc, view, doc);
  const emit = (name, extras = {}) => { const event = { isTrusted: true, button: 0, clientX: 20, clientY: 30, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extras }; doc.emit(name, event); return event; };
  const flush = () => frames.splice(0).forEach(fn => fn());
  const begin = (mode = 'element', requestId = 'request-one', revision = 1, viewport = { width: view.innerWidth, height: view.innerHeight }) => ipc.emit('relay:browser-annotation-start', {}, { mode, requestId, revision, viewport });
  return { doc, view, ipc, sent, ready, dispose, emit, begin, start(mode = 'element', requestId = 'request-one') { begin(mode, requestId); flush(); flush(); flush(); }, flush };
}
test('only a trusted user gesture selects, hides overlay before capture and consumes request once', () => {
  const p = picker(); p.start(); p.emit('pointerup', { isTrusted: false }); p.flush(); p.flush(); assert.equal(p.sent.length, 0);
  assert.equal(p.emit('pointerdown').prevented, true); assert.equal(p.emit('pointerup').stopped, true);
  assert.equal(p.doc.documentElement.children[0].style.display, 'none'); assert.equal(p.sent.length, 0);
  p.flush(); assert.equal(p.sent.length, 0); p.flush(); assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].channel, 'browser:page-event'); assert.equal(p.sent[0].payload.requestId, 'request-one'); assert.equal(p.sent[0].payload.selection.selector, '#save');
  assert.equal(p.doc.listenerCount('pointerup'), 0); p.dispose(); assert.equal(p.ipc.listenerCount('relay:browser-annotation-start'), 0);
});
test('region selection supplies geometry without arbitrary page text; Escape and hiding cancel', () => {
  const p = picker(); p.start('region'); p.emit('pointerdown', { clientX: 150, clientY: 180 }); p.emit('pointerup', { clientX: 20, clientY: 30 }); p.flush(); p.flush();
  assert.deepEqual(p.sent[0].payload.selection.rect, { x: 20, y: 30, width: 130, height: 150 }); assert.equal(p.sent[0].payload.selection.text, '');
  p.start(); p.emit('keydown', { key: 'Escape' }); assert.equal(p.sent.at(-1).payload.type, 'annotation-cancel');
  p.start(); p.doc.visibilityState = 'hidden'; p.emit('visibilitychange'); assert.equal(p.sent.at(-1).payload.type, 'annotation-cancel'); p.dispose();
});
test('cancel during the delayed screenshot window suppresses stale annotation delivery', () => {
  const p = picker(); p.start(); p.emit('pointerup'); p.ipc.emit('relay:browser-annotation-cancel', {}, { requestId: 'request-one' }); p.flush(); p.flush(); assert.equal(p.sent.length, 0); p.dispose();
});

test('the transparent picker captures gestures over frames while hit testing without its overlay', () => {
  const p = picker(); p.start(); const overlay = p.doc.documentElement.children[0];
  assert.match(overlay.style.cssText, /pointer-events:auto/);
  p.doc.elementFromPoint = () => { assert.equal(overlay.style['pointer-events'], 'none'); return { nodeType: 1, tagName: 'IFRAME', id: 'embedded', getAttribute: () => null, getBoundingClientRect: () => ({ x: 20, y: 30, width: 250, height: 180 }) }; };
  p.emit('pointerdown'); p.emit('pointerup'); p.flush(); p.flush();
  assert.equal(p.sent[0].payload.selection.tagName, 'iframe'); assert.equal(p.sent[0].payload.selection.selector, '#embedded'); p.dispose();
});

test('a queued resize with unchanged viewport does not cancel the next selection', () => {
  const p = picker(); p.start('region');
  p.view.emit('resize'); assert.equal(p.sent.length, 0);
  p.emit('pointerdown', { clientX: 10, clientY: 20 });
  p.view.emit('resize');
  p.emit('pointerup', { clientX: 100, clientY: 120 }); p.flush(); p.flush();
  assert.equal(p.sent.length, 1); assert.equal(p.sent[0].payload.type, 'annotation');
  assert.deepEqual(p.sent[0].payload.selection.rect, { x: 10, y: 20, width: 90, height: 100 }); p.dispose();
});
test('a real viewport resize cancels even while the screenshot is waiting for paint', () => {
  for (const finishing of [false, true]) {
    const p = picker(); p.start(); if (finishing) p.emit('pointerup');
    p.view.innerHeight -= 46; p.view.emit('resize'); p.flush(); p.flush();
    assert.equal(p.sent.length, 1); assert.equal(p.sent[0].payload.type, 'annotation-cancel');
    assert.equal(p.sent[0].payload.reason, 'viewport-changed'); assert.equal(p.sent[0].payload.revision, 1); assert.equal(p.doc.listenerCount('pointerup'), 0); p.dispose();
  }
});

test('preparation blocks page gestures and acknowledges only the expected viewport after stable paints', () => {
  const p = picker(); p.begin('region', 'pending', 4, { width: 379, height: 600 });
  assert.equal(p.emit('pointerdown').prevented, true); p.emit('pointerup'); p.flush(); p.flush(); p.flush();
  assert.equal(p.ready.length, 0); assert.equal(p.sent.length, 0);
  p.view.innerWidth = 378; p.view.emit('resize'); p.flush(); p.flush(); p.flush(); assert.equal(p.ready.length, 0);
  p.view.innerWidth = 379; p.view.emit('resize'); p.flush(); p.flush(); assert.equal(p.ready.length, 0); p.flush();
  assert.deepEqual(p.ready[0].payload, { type: 'annotation-ready', requestId: 'pending', revision: 4, viewport: { width: 379, height: 600 } });
  assert.equal(p.sent.length, 0); p.emit('pointerdown', { clientX: 10, clientY: 10 }); p.emit('pointerup', { clientX: 100, clientY: 100 }); p.flush(); p.flush();
  assert.equal(p.sent.at(-1).payload.type, 'annotation'); assert.equal(p.sent.at(-1).payload.revision, 4); p.dispose();
});
test('a newer layout revision replaces pending readiness and cancellation discards all delayed callbacks', () => {
  const p = picker(); p.begin('element', 'same-request', 1); p.flush(); p.flush();
  p.begin('element', 'same-request', 2, { width: 801, height: 600 }); p.view.innerWidth = 801;
  p.flush(); p.flush(); assert.equal(p.ready.length, 0); p.flush();
  assert.deepEqual(p.ready.map(event => event.payload.revision), [2]);
  p.begin('element', 'cancel-request', 1); p.flush();
  p.ipc.emit('relay:browser-annotation-cancel', {}, { requestId: 'cancel-request' }); p.flush(); p.flush(); p.flush();
  assert.equal(p.ready.length, 1); assert.equal(p.sent.length, 0); p.dispose();
});
test('hiding or Escape during preparation cancels before readiness without leaking a later acknowledgement', () => {
  for (const reason of ['hidden', 'escape']) {
    const p = picker(); p.begin();
    if (reason === 'hidden') { p.doc.visibilityState = 'hidden'; p.emit('visibilitychange'); }
    else p.emit('keydown', { key: 'Escape' });
    p.flush(); p.flush(); p.flush();
    assert.equal(p.ready.length, 0); assert.equal(p.sent[0].payload.type, 'annotation-cancel'); assert.equal(p.sent[0].payload.reason, reason); p.dispose();
  }
});

test('fractional zoom preparation latches a stable measured viewport and still cancels a one-pixel resize', () => {
  const p = picker(); p.view.innerWidth = 303; p.view.innerHeight = 485;
  p.ipc.emit('relay:browser-annotation-start', {}, { mode: 'region', requestId: 'zoomed', revision: 2,
    viewport: { width: 303, height: 484 }, viewportMax: { width: 304, height: 485 } });
  p.flush(); p.flush(); assert.equal(p.ready.length, 0); p.flush();
  assert.deepEqual(p.ready[0].payload.viewport, { width: 303, height: 485 });
  p.view.innerHeight = 484; p.view.emit('resize');
  assert.equal(p.sent[0].payload.reason, 'viewport-changed'); p.dispose();
});
test('fractional zoom preparation rejects invalid ranges and waits outside its native rounding interval', () => {
  for (const maximum of [{ width: 900, height: 600 }, { width: 799, height: 600 }, { width: 800.5, height: 600 }]) {
    const p = picker(); p.ipc.emit('relay:browser-annotation-start', {}, { mode: 'region', requestId: 'invalid', revision: 1,
      viewport: { width: 800, height: 600 }, viewportMax: maximum });
    p.flush(); p.flush(); p.flush(); assert.equal(p.ready.length, 0); assert.equal(p.doc.listenerCount('pointerup'), 0); p.dispose();
  }
  const p = picker(); p.view.innerWidth = 303; p.view.innerHeight = 486;
  p.ipc.emit('relay:browser-annotation-start', {}, { mode: 'region', requestId: 'pending', revision: 1,
    viewport: { width: 303, height: 484 }, viewportMax: { width: 304, height: 485 } });
  p.flush(); p.flush(); p.flush(); assert.equal(p.ready.length, 0); p.dispose();
});
