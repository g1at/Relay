'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserAutomationAdapter } = require('../src/main/browser/browser-automation-adapter');

function fixture() {
  const wc = new EventEmitter(), debug = new EventEmitter(), calls = [], operations = [];
  wc.url = 'https://fixture.test/form'; wc.getURL = () => wc.url; wc.isDestroyed = () => false;
  debug.attached = false; debug.isAttached = () => debug.attached;
  debug.attach = () => { debug.attached = true; }; debug.detach = () => { debug.attached = false; debug.emit('detach'); };
  wc.debugger = debug;
  let resolutions = 0;
  debug.sendCommand = async (method, params = {}) => {
    calls.push({ method, params });
    if (wc.command) { const result = await wc.command(method, params); if (result !== undefined) return result; }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader1', url: wc.url }, ...(wc.child ? { childFrames: [{ frame: { id: 'child', parentId: 'main', url: 'https://child.test/' } }] } : {}) } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'child' ? 43 : 42 };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 1 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: wc.parentCheck ? wc.parentCheck() : { x: 20, y: 30 } } };
    if (method === 'Runtime.evaluate') {
      if (params.expression.includes('"operation":"initialize"')) return { result: { value: true } };
      const request = JSON.parse(params.expression.slice(params.expression.lastIndexOf(')(') + 2, -1));
      operations.push(request);
      if (wc.operation) { const result = await wc.operation(request, params); if (result !== undefined) return { result: { value: result } }; }
      if (request.operation === 'initialize') return { result: { value: true } };
      if (request.operation === 'observe') return { result: { value: { observationId: request.observationId, url: wc.url, text: 'Form', elements: [{ ref: 'e1' }] } } };
      if (request.operation === 'read-page') return { result: { value: { url: wc.url, text: 'Form', readyState: 'complete' } } };
      if (request.operation === 'resolve-locator') return { result: { value: { ref: 'e' + (++resolutions) } } };
      if (request.operation === 'viewport') return { result: { value: { width: 300, height: 200 } } };
      return { result: { value: { x: 20, y: 30, valid: true } } };
    }
    return {};
  };
  const adapter = createBrowserAutomationAdapter({ webContents: wc, commandTimeoutMs: 500 });
  return { wc, debug, adapter, calls, operations, input: () => calls.filter(call => call.method.startsWith('Input.')), resolutions: () => resolutions };
}
const error = code => ({ error: { code, message: code } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const kind of ['click', 'fill', 'select']) test(`locator ${kind} recovers a replacement only before any side effect`, async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.operation = request => request.operation === 'prepare-stable' && request.ref === 'e1' ? error('BROWSER_ELEMENT_STALE') : undefined;
  const result = await f.adapter.act({ observationId: observed.observationId, locator: { role: 'button', name: 'Save' }, kind, text: 'Ada', values: ['blue'] });
  assert.equal(result.executed, true); assert.equal(f.resolutions(), 2);
  assert.ok(f.operations.filter(request => request.operation === 'prepare-stable').every(request => ['e1', 'e2'].includes(request.ref)));
  assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, kind === 'click' ? 1 : 0);
});

test('explicit references remain stale even if a locator is also supplied', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.operation = request => request.operation === 'prepare-stable' ? error('BROWSER_ELEMENT_STALE') : undefined;
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', locator: { role: 'button' }, kind: 'click' }), e => e.code === 'BROWSER_ELEMENT_STALE' && !e.inputDispatched);
  assert.equal(f.resolutions(), 0); assert.equal(f.input().length, 0);
});

for (const boundary of ['hover', 'focus']) test(`${boundary} side effect locks the original node and prevents a retry`, async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(); let effected = false;
  f.wc.command = method => { if (method.startsWith('Input.')) effected = true; };
  f.wc.operation = request => {
    if (request.operation === 'focus') { effected = true; return { focused: true }; }
    if (effected && ['prepare-stable', 'prepare', 'focused'].includes(request.operation)) return error('BROWSER_ELEMENT_STALE');
  };
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, locator: { role: 'button' }, kind: boundary === 'hover' ? 'click' : 'fill', text: 'Ada' }), e => e.code === 'BROWSER_ELEMENT_STALE' && e.inputDispatched);
  assert.equal(f.resolutions(), 1); assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture' || call.method === 'Input.insertText').length, 0);
});

for (const revoke of ['navigation', 'takeover', 'cancel']) test(`stale locator preparation cannot recover through ${revoke}`, async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(), abort = new AbortController(); let revoked = false;
  f.wc.operation = request => {
    if (request.operation !== 'prepare-stable') return;
    revoked = true;
    if (revoke === 'navigation') f.wc.emit('did-start-navigation', {}, f.wc.url, false, true);
    if (revoke === 'cancel') abort.abort();
    return error('BROWSER_ELEMENT_STALE');
  };
  const check = () => { if (revoked && revoke === 'takeover') throw Object.assign(Error('Taken over'), { code: 'CONTROL_REVOKED' }); };
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, locator: { role: 'button' }, kind: 'click' }, { signal: abort.signal, check }), { code: { navigation: 'BROWSER_OBSERVATION_STALE', takeover: 'CONTROL_REVOKED', cancel: 'BROWSER_CANCELLED' }[revoke] });
  assert.equal(f.resolutions(), 1); assert.equal(f.input().length, 0);
});

test('stable preparation is awaited, and transient parent-frame occlusion retries before input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.child = true;
  const observed = await f.adapter.observe({}, { frameId: 'child' }); let parentChecks = 0, pending = false;
  f.wc.parentCheck = () => ++parentChecks === 1 ? error('BROWSER_FRAME_OBSCURED') : { x: 20, y: 30 };
  f.wc.operation = async (request, params) => {
    if (request.operation !== 'prepare-stable') return;
    assert.equal(params.awaitPromise, true); pending = true; await sleep(10); pending = false;
  };
  f.wc.command = method => { if (method.startsWith('Input.')) assert.equal(pending, false); };
  assert.equal((await f.adapter.act({ observationId: observed.observationId, frameId: 'child', ref: 'e1', kind: 'click' })).executed, true);
  assert.ok(parentChecks > 1); assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, 1);
});

test('one action deadline covers resolving and stability; expired preparation never dispatches input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.operation = async request => { if (request.operation === 'resolve-locator') await sleep(90); if (request.operation === 'prepare-stable') await sleep(160); };
  const started = Date.now();
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, locator: { role: 'button' }, kind: 'click', timeoutMs: 160 }), e => e.code === 'BROWSER_COMMAND_TIMEOUT' && !e.inputDispatched);
  assert.ok(Date.now() - started < 260); assert.equal(f.input().length, 0);
});

test('act arms response tracking before immediate dispatch and never loses a synchronous response', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.command = method => {
    if (method !== 'Input.synthesizeTapGesture') return;
    f.debug.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'submit', frameId: 'main', loaderId: 'loader1', type: 'Fetch', request: { url: 'https://fixture.test/api?secret=hidden', method: 'POST' } });
    f.debug.emit('message', {}, 'Network.responseReceived', { requestId: 'submit', frameId: 'main', loaderId: 'loader1', response: { url: 'https://fixture.test/api?secret=hidden', status: 201 } });
  };
  const result = await f.adapter.act({ observationId: observed.observationId, ref: 'e1', kind: 'click', waitFor: { event: 'response', method: 'POST', status: 201, timeoutMs: 200 } });
  assert.equal(result.executed, true); assert.equal(result.waitResult.satisfied, true);
  assert.equal(JSON.stringify(result.waitResult).includes('secret'), false);
  assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, 1);
});

test('event timeout reports executed input without replay and has a separate budget', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  const result = await f.adapter.act({ observationId: observed.observationId, ref: 'e1', kind: 'click', timeoutMs: 100, waitFor: { event: 'response', status: 201, timeoutMs: 150 } });
  assert.equal(result.executed, true); assert.equal(result.waitResult.satisfied, false); assert.equal(result.waitResult.timedOut, true);
  assert.equal(result.requiresObservation, true); assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, 1);
});

test('replacement during a tap handshake aborts instead of clicking the new node', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(); let stale = false, released = 0;
  f.wc.operation = request => stale && request.operation === 'prepare' ? error('BROWSER_ELEMENT_STALE') : undefined;
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, locator: { role: 'button' }, kind: 'click' }, {
    onInput: async ({ method }) => { if (method === 'Input.synthesizeTapGesture') stale = true; return () => { released++; }; },
  }), e => e.code === 'BROWSER_ELEMENT_STALE' && e.inputDispatched);
  assert.equal(f.resolutions(), 1); assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, 0); assert.equal(released, 2);
});

test('drag never retries an explicit stale destination even when its source is a locator', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.operation = request => request.operation === 'prepare-stable' && request.ref === 'e9' ? error('BROWSER_ELEMENT_STALE') : undefined;
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, locator: { role: 'button' }, kind: 'drag', toRef: 'e9' }), e => e.code === 'BROWSER_ELEMENT_STALE' && !e.inputDispatched);
  assert.equal(f.resolutions(), 1); assert.equal(f.input().length, 0);
});

test('drag may recover a locator destination while retaining an explicit source before input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe();
  f.wc.operation = request => request.operation === 'prepare-stable' && request.ref === 'e1' ? error('BROWSER_ELEMENT_STALE') : undefined;
  const result = await f.adapter.act({ observationId: observed.observationId, ref: 'e9', toLocator: { role: 'button' }, kind: 'drag' });
  assert.equal(result.executed, true); assert.equal(f.resolutions(), 2);
  assert.equal(f.input().filter(call => call.params.type === 'mousePressed').length, 1);
});

test('cancellation while waiting for an action response does not replay the gesture', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(), controller = new AbortController();
  f.wc.command = method => { if (method === 'Input.synthesizeTapGesture') setImmediate(() => controller.abort()); };
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', kind: 'click', waitFor: { event: 'response', timeoutMs: 300 } }, { signal: controller.signal }), e => e.code === 'BROWSER_CANCELLED' && e.inputDispatched);
  assert.equal(f.input().filter(call => call.method === 'Input.synthesizeTapGesture').length, 1);
});

for (const kind of ['rightClick', 'doubleClick']) test(`${kind} refuses old root coordinates if an iframe moves during its press handshake`, async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.child = true;
  let frameX = 20, cleanups = 0; f.wc.parentCheck = () => ({ x: frameX, y: 30 });
  const observed = await f.adapter.observe({}, { frameId: 'child' });
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', frameId: 'child', kind }, {
    onInput: async ({ params }) => { if (params.type === 'mousePressed') frameX = 220; return () => { cleanups++; }; },
  }), e => e.code === 'BROWSER_ELEMENT_UNSTABLE' && e.inputDispatched);
  assert.equal(f.input().filter(call => ['mousePressed', 'mouseReleased'].includes(call.params.type)).length, 0);
  assert.equal(cleanups, 2);
});

test('native wheel refuses both iframe movement and zoom changes during its handshake', async t => {
  for (const changed of ['frame', 'zoom']) {
    const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.child = true;
    let frameX = 20, zoom = 1, sent = 0, cleaned = 0; f.wc.parentCheck = () => ({ x: frameX, y: 30 });
    f.wc.getZoomFactor = () => zoom; f.wc.sendInputEvent = () => { sent++; };
    const observed = await f.adapter.observe({}, { frameId: 'child' });
    await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', frameId: 'child', kind: 'scroll', deltaY: 100 }, {
      onInput: async () => { if (changed === 'frame') frameX = 220; else zoom = 1.5; return () => { cleaned++; }; },
    }), e => e.code === 'BROWSER_ELEMENT_UNSTABLE' && !e.inputDispatched);
    assert.equal(sent, 0); assert.equal(cleaned, 1);
  }
});

for (const boundary of ['mousePressed', 'interpolation']) test(`drag stops after ${boundary} handshake replaces a retained node, without a new press`, async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(); let stale = false;
  f.wc.operation = request => stale && request.operation === 'prepare' && request.ref === 'e2' ? error('BROWSER_ELEMENT_STALE') : undefined;
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', toRef: 'e2', kind: 'drag' }, {
    onInput: async ({ params }) => { if (boundary === 'mousePressed' ? params.type === 'mousePressed' : params.type === 'mouseMoved' && params.buttons === 1) stale = true; },
  }), e => e.code === 'BROWSER_ELEMENT_STALE' && e.inputDispatched);
  assert.equal(f.input().filter(call => call.params.type === 'mousePressed').length, boundary === 'mousePressed' ? 0 : 1);
  assert.equal(f.input().filter(call => call.params.type === 'mouseMoved' && call.params.buttons === 1).length, 0);
  const releases = f.input().filter(call => call.params.type === 'mouseReleased');
  assert.equal(releases.length, boundary === 'mousePressed' ? 0 : 1);
  if (releases.length) assert.equal(releases[0].params.clickCount, 0, 'only releases an already held button');
});

test('drag compares both root endpoints after each handshake while preserving normal interpolation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.child = true;
  let moved = false;
  f.wc.parentCheck = () => ({ x: moved ? 220 : 20, y: 30 });
  const observed = await f.adapter.observe({}, { frameId: 'child' });
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', toRef: 'e2', frameId: 'child', kind: 'drag' }, {
    onInput: async ({ params }) => { if (params.type === 'mousePressed') moved = true; },
  }), e => e.code === 'BROWSER_ELEMENT_UNSTABLE' && e.inputDispatched);
  assert.equal(f.input().filter(call => call.params.type === 'mousePressed').length, 0);
});

test('drag permits its original source to move with the pointer after down while retaining identity', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(); let held = false, identityReads = 0;
  f.wc.command = (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') held = true; };
  f.wc.operation = request => {
    if (request.ref !== 'e1' || !held) return;
    if (request.operation === 'verify-element') { identityReads++; return { attached: true }; }
    if (request.operation === 'prepare') return error('BROWSER_ELEMENT_OBSCURED');
  };
  const result = await f.adapter.act({ observationId: observed.observationId, ref: 'e1', toRef: 'e2', kind: 'drag' });
  assert.equal(result.executed, true); assert.equal(identityReads, 11);
  assert.equal(f.input().filter(call => call.params.type === 'mousePressed').length, 1);
  assert.equal(f.input().filter(call => call.params.type === 'mouseMoved' && call.params.buttons === 1).length, 10);
});

test('drag replacement of the moving source stops subsequent moves and releases only its held button', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observed = await f.adapter.observe(); let held = false;
  f.wc.command = (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') held = true; };
  f.wc.operation = request => held && request.ref === 'e1' && request.operation === 'verify-element' ? error('BROWSER_ELEMENT_STALE') : undefined;
  await assert.rejects(f.adapter.act({ observationId: observed.observationId, ref: 'e1', toRef: 'e2', kind: 'drag' }), e => e.code === 'BROWSER_ELEMENT_STALE' && e.inputDispatched);
  assert.equal(f.input().filter(call => call.params.type === 'mousePressed').length, 1);
  assert.equal(f.input().filter(call => call.params.type === 'mouseMoved' && call.params.buttons === 1).length, 0);
  assert.equal(f.input().filter(call => call.params.type === 'mouseReleased' && call.params.clickCount === 0).length, 1);
});
