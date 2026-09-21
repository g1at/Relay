'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Use the production native-view scheduler without Electron. The empty launcher
// must neither schedule frames nor measure the long transcript's layout tree.
function fixture({ viewportRect = { left: 700, right: 1200, y: 100, height: 650 } } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
  const desired = source.slice(source.indexOf('  function nativeDesired()'), source.indexOf('  function renderBrowserSnapshot('));
  const schedule = source.slice(source.indexOf('  function scheduleNative()'), source.indexOf('  function trackGeometry('));
  const frames = [], calls = []; let measurements = 0;
  const cover = { hidden: true, childElementCount: 0, replaceChildren() {} };
  const viewport = { getBoundingClientRect() { measurements++; return viewportRect; } };
  const sandbox = { requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    browserBridge: { async invoke(input) { calls.push(input); return { ok: true }; } },
    $: id => id === 'workspaceBrowserCover' ? cover : viewport,
    app: { dataset: {}, getBoundingClientRect() { measurements++; return { left: 0 }; } },
    document: { hidden: false }, performance: { now: () => 1000 },
    hasOverlay: () => false, renderBrowserSnapshot() {}, scheduleCapture() {}, browserNotice() {},
    assertResult(value) { return value; } };
  vm.createContext(sandbox);
  vm.runInContext(`let item = null, opened = true, tab = null, disposed = false, nativeFrame = null,
    nativeActiveId = null, nativeSignature = '', nativeEpoch = 0, nativeChain = Promise.resolve(), geometryUntil = 0;
    const obscured = new Set(); const activeTab = () => item;
    ${desired}\n${schedule}
    globalThis.control = { nativeDesired, scheduleNative, syncNative,
      setItem(value) { item = value; tab = value?.kind || null; },
      setNative(value) { nativeActiveId = value; },
      active: () => nativeActiveId, done: () => nativeChain };`, sandbox);
  return { c: sandbox.control, calls, frames, measurements: () => measurements,
    async flush() { const work = frames.splice(0); for (const callback of work) callback(); await sandbox.control.done(); } };
}

test('launcher and non-browser tools skip native frames and DOM geometry reads', () => {
  const f = fixture();
  for (const item of [null, { id: 'files', kind: 'files' }, { id: 'terminal', kind: 'terminal' }, { id: 'review', kind: 'review' }]) {
    f.c.setItem(item);
    for (let i = 0; i < 10; i++) f.c.scheduleNative();
    const desired = f.c.nativeDesired();
    assert.equal(desired.id, null); assert.equal(desired.visible, false); assert.equal(desired.cover, false);
  }
  assert.equal(f.frames.length, 0); assert.equal(f.measurements(), 0); assert.equal(f.calls.length, 0);
});

test('leaving a browser still hides its native view without measuring an empty launcher', async () => {
  const f = fixture(); f.c.setNative('previous-browser'); f.c.scheduleNative();
  assert.equal(f.frames.length, 1); await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'visibility');
  assert.equal(f.calls[0].id, 'previous-browser'); assert.equal(f.calls[0].visible, false);
  assert.equal(f.c.active(), null); assert.equal(f.measurements(), 0);
  f.c.scheduleNative(); assert.equal(f.frames.length, 0);
});

test('a real browser keeps bounds and visibility updates after frame coalescing', async () => {
  const f = fixture(); f.c.setItem({ id: 'browser-tab', kind: 'browser', browserId: 'native-browser', browser: { url: 'https://example.test/' } });
  for (let i = 0; i < 8; i++) f.c.scheduleNative();
  assert.equal(f.frames.length, 1); await f.flush();
  assert.deepEqual(f.calls.map(call => call.action), ['setBounds', 'visibility']);
  assert.equal(f.calls[0].rect.width, 500); assert.equal(f.calls[0].rect.height, 650);
  assert.equal(f.calls[1].visible, true); assert.equal(f.c.active(), 'native-browser');
});

test('native browser fills the viewport through full width and intermediate snap positions', async () => {
  for (const left of [0, 1, 4, 8, 240, 700]) {
    const viewportRect = { left, right: 1200, y: 130, height: 650 };
    const f = fixture({ viewportRect });
    f.c.setItem({ id: 'browser-tab', kind: 'browser', browserId: 'native-browser', browser: { url: 'https://example.test/' } });
    f.c.scheduleNative(); await f.flush();
    const bounds = f.calls.find(call => call.action === 'setBounds').rect;
    assert.deepEqual({ ...bounds }, { x: left, y: 130, width: 1200 - left, height: 650 });
    assert.equal(bounds.x + bounds.width, viewportRect.right, 'no permanent resize gutter may shrink or shift the page');
  }
});
