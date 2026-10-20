'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installInputTakeover } = require('../browser-page-preload');
function fixture() {
  class Target extends EventEmitter { addEventListener(name, fn) { this.on(name, fn); } removeEventListener(name, fn) { this.off(name, fn); } }
  const doc = new Target(), view = new Target(), ipc = new EventEmitter(), sent = [];
  doc.visibilityState = 'visible'; view.location = { href: 'https://example.test/' }; ipc.send = (channel, payload) => sent.push({ channel, payload });
  const dispose = installInputTakeover(ipc, view, doc, { visibilityTimeoutMs: 10 });
  const emit = (type, values = {}) => doc.emit(type, { type, isTrusted: true, clientX: 10, clientY: 20, button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...values });
  const prepare = (expected = {}) => ipc.emit('relay:browser-input-prepare', {}, { token: 'input-one', documentToken: 'document-one',
    expected: { type: 'pointerdown', x: 10, y: 20, button: 0, modifiers: 0, count: 1, ...expected } });
  return { doc, view, ipc, sent, dispose, emit, prepare };
}

test('input handshake acknowledges before an exact one-shot event, then treats repetition as human input', () => {
  const f = fixture(); f.prepare();
  assert.deepEqual(f.sent[0].payload, { type: 'input-ready', token: 'input-one', visible: true });
  f.emit('pointerdown', { isTrusted: false }); assert.equal(f.sent.length, 1);
  f.emit('pointerdown'); assert.deepEqual(f.sent[1].payload, { type: 'input-consumed', token: 'input-one' });
  f.emit('pointerdown'); assert.deepEqual(f.sent[2].payload, { type: 'manual-pointer', documentToken: 'document-one', url: 'https://example.test/' });
  f.dispose(); assert.equal(f.doc.listenerCount('pointerdown'), 0); assert.equal(f.ipc.listenerCount('relay:browser-input-prepare'), 0);
});

test('unrelated human input is never masked while an exact model event is pending', () => {
  const f = fixture(); f.prepare(); f.emit('pointerdown', { clientX: 70 });
  assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.emit('pointerdown'); assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.prepare(); f.emit('pointerdown', { ctrlKey: true }); assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.dispose();
});

test('wheel matching includes deltas and mode, and native double taps consume exactly their count', () => {
  const f = fixture(); f.prepare({ type: 'wheel', deltaX: 0, deltaY: 80 });
  f.emit('wheel', { deltaMode: 0, deltaX: 0, deltaY: 80 }); assert.equal(f.sent.at(-1).payload.type, 'input-consumed');
  f.prepare({ type: 'wheel', deltaX: 0, deltaY: 80 }); f.emit('wheel', { deltaMode: 1, deltaX: 0, deltaY: 80 }); assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.prepare({ count: 2 }); const count = f.sent.length;
  f.emit('pointerdown'); assert.equal(f.sent.length, count);
  f.emit('pointerdown'); assert.equal(f.sent.at(-1).payload.type, 'input-consumed'); f.dispose();
});

test('cancellation and document changes retire the model input intent', () => {
  const f = fixture(); f.prepare(); f.ipc.emit('relay:browser-input-cancel', {}, { token: 'input-one' });
  f.emit('pointerdown'); assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.prepare(); f.view.emit('pagehide'); const count = f.sent.length; f.emit('pointerdown'); assert.equal(f.sent.length, count);
  f.ipc.emit('relay:browser-input-context', {}, { documentToken: 'new-document' }); f.emit('pointerdown');
  assert.equal(f.sent.at(-1).payload.documentToken, 'new-document'); f.dispose();
});

test('hidden Chromium documents reject input preparation without granting a model pointer intent', async () => {
  const f = fixture(); f.doc.visibilityState = 'hidden'; f.prepare();
  assert.equal(f.sent.length, 0); await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.sent[0].payload, { type: 'input-not-visible', token: 'input-one' });
  assert.equal(f.sent.some(item => item.payload.type === 'input-ready'), false);
  f.doc.visibilityState = 'visible'; f.emit('pointerdown');
  assert.equal(f.sent.at(-1).payload.type, 'manual-pointer', 'reappearing does not revive a rejected intent');
  f.dispose();
});
test('visibility-only preparation requires a visible document and never masks a later human event', async () => {
  const f = fixture(); f.prepare({ type: 'visibility' });
  assert.deepEqual(f.sent[0].payload, { type: 'input-ready', token: 'input-one', visible: true });
  f.emit('pointerdown'); assert.equal(f.sent.at(-1).payload.type, 'manual-pointer');
  f.doc.visibilityState = 'hidden'; f.prepare({ type: 'visibility' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.at(-1).payload.type, 'input-not-visible'); f.dispose();
});

test('a short hidden-to-visible transition acknowledges only the current document request', async () => {
  const f = fixture(); f.doc.visibilityState = 'hidden'; f.prepare(); assert.equal(f.sent.length, 0);
  f.doc.visibilityState = 'visible'; f.doc.emit('visibilitychange');
  assert.deepEqual(f.sent.map(item => item.payload), [{ type: 'input-ready', token: 'input-one', visible: true }]);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.sent.length, 1); f.dispose();
});
for (const cancellation of ['cancel', 'context', 'pagehide', 'replacement', 'dispose']) test(`hidden document wait cannot acknowledge after ${cancellation}`, async () => {
  const f = fixture(); f.doc.visibilityState = 'hidden'; f.prepare();
  if (cancellation === 'cancel') f.ipc.emit('relay:browser-input-cancel', {}, { token: 'input-one' });
  if (cancellation === 'context') f.ipc.emit('relay:browser-input-context', {}, { documentToken: 'new-document' });
  if (cancellation === 'pagehide') f.view.emit('pagehide');
  if (cancellation === 'replacement') f.ipc.emit('relay:browser-input-prepare', {}, { token: 'new-input', documentToken: 'document-one', expected: { type: 'visibility' } });
  if (cancellation === 'dispose') f.dispose();
  f.doc.visibilityState = 'visible'; f.doc.emit('visibilitychange');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.some(item => item.payload.token === 'input-one'), false);
  if (cancellation === 'replacement') assert.deepEqual(f.sent[0].payload, { type: 'input-ready', token: 'new-input', visible: true });
  f.dispose(); assert.equal(f.doc.listenerCount('visibilitychange'), 0);
});

test('main-authorized hidden input grants only the exact one-shot pointer and preserves user takeover after reveal', () => {
  const f = fixture(); f.doc.visibilityState = 'hidden';
  f.ipc.emit('relay:browser-input-prepare', {}, { token: 'background-one', documentToken: 'document-one', allowBackground: true,
    expected: { type: 'pointerdown', x: 10, y: 20, button: 0, modifiers: 0, count: 1 } });
  assert.deepEqual(f.sent[0].payload, { type: 'input-ready', token: 'background-one', visible: false, background: true });
  f.emit('pointerdown'); assert.equal(f.sent.at(-1).payload.type, 'input-consumed');
  f.doc.visibilityState = 'visible'; f.emit('pointerdown');
  assert.equal(f.sent.at(-1).payload.type, 'manual-pointer'); f.dispose();
});
