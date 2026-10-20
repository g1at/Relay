'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { createBrowserAutomationAdapter } = require('../src/main/browser/browser-automation-adapter');

function fixture() {
  const wc = new EventEmitter(), debug = new EventEmitter(), calls = [];
  wc.url = 'http://127.0.0.1/fixture'; wc.getURL = () => wc.url; wc.isDestroyed = () => false;
  debug.attached = false; debug.isAttached = () => debug.attached;
  debug.attach = protocol => { assert.equal(protocol, '1.3'); debug.attached = true; };
  debug.detach = () => { debug.attached = false; debug.emit('detach'); };
  debug.sendCommand = async (method, params = {}) => {
    calls.push({ method, params });
    if (wc.beforeCommand) await wc.beforeCommand(method, params);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, ...(wc.withFrame ? { childFrames: [{ frame: { id: 'child', parentId: 'main', url: 'https://frame.example.test' } }] } : {}) } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'child' ? 43 : 42 };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 123 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: wc.frameOccluded ? { error: { code: 'BROWSER_FRAME_OBSCURED', message: 'Parent overlay' } } : { x: 50, y: 80 } } };
    if (method === 'Runtime.evaluate') {
      assert.ok([42, 43].includes(params.contextId));
      const operation = /"operation":"([^"]+)"/.exec(params.expression)[1];
      if (operation === 'initialize') return { result: { value: true } };
      if (wc.pageError && operation !== 'observe') return { result: { value: { error: { code: wc.pageError, message: 'Blocked fixture' } } } };
      if (operation === 'observe') return { result: { value: { observationId: /"observationId":"([^"]+)"/.exec(params.expression)[1], url: wc.url, title: 'Fixture', text: 'Saved', elements: [{ ref: 'e1', role: 'textbox', name: 'Name' }] } } };
      if (operation === 'viewport') return { result: { value: { width: 300, height: 150 } } };
      if (operation === 'query-state') return { result: { value: { count: 1, attached: true, visible: true, enabled: true, value: wc.fieldValue ?? 'Ada', text: wc.fieldValue ?? 'Ada' } } };
      if (operation === 'verify-element') return { result: { value: { value: wc.fieldValue ?? 'Ada', text: wc.fieldValue ?? 'Ada' } } };
      if (operation === 'read-page') return { result: { value: { url: wc.url, title: 'Fixture', text: wc.pageText ?? 'Saved' } } };
      if (operation === 'file-node') return { result: { type: 'object', subtype: 'node', objectId: 'observed-file-node' } };
      if (operation === 'select') return { result: { value: { selectedValues: ['blue'], inputMode: 'dom-events' } } };
      return { result: { value: { x: 20, y: 30, valid: true } } };
    }
    if (method === 'Page.captureScreenshot') return { data: 'cG5n' };
    return {};
  };
  wc.debugger = debug;
  const adapter = createBrowserAutomationAdapter({ webContents: wc, commandTimeoutMs: 500 });
  return { wc, debug, adapter, calls, inputCalls: () => calls.filter(call => call.method.startsWith('Input.')) };
}

test('background input uses targeted CDP pairs and wheel without native focus or synthetic visible gestures', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  f.wc.sendInputEvent = () => { throw Error('background input cannot use the foreground native input path'); };
  f.wc.focus = () => { throw Error('background input must not move OS focus'); };
  const observed = await f.adapter.observe();
  const clicked = await f.adapter.act({ kind: 'click', ref: 'e1', observationId: observed.observationId }, { isBackground: () => true });
  assert.equal(clicked.executed, true);
  assert.deepEqual(f.inputCalls().map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  const scrolled = await f.adapter.act({ kind: 'scroll', x: 20, y: 30, deltaY: 300, observationId: clicked.observation.observationId }, { background: true });
  assert.equal(scrolled.inputMode, 'cdp-wheel');
  assert.equal(f.inputCalls().at(-1).params.deltaY, 300);
});

test('switching away during click preparation selects background dispatch before the press', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  let hidden = false;
  const observed = await f.adapter.observe();
  f.wc.beforeCommand = async (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') hidden = true; };
  await f.adapter.act({ kind: 'click', ref: 'e1', observationId: observed.observationId }, { isBackground: () => hidden });
  assert.equal(f.inputCalls().some(item => item.method === 'Input.synthesizeTapGesture'), false);
  assert.deepEqual(f.inputCalls().map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('a currently presented task still uses CDP because presentation can change during input preparation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  f.wc.sendInputEvent = () => { throw Error('native wheel is presentation dependent'); };
  const observed = await f.adapter.observe();
  const clicked = await f.adapter.act({ kind: 'click', ref: 'e1', observationId: observed.observationId }, { isBackground: () => false });
  assert.equal(f.inputCalls().some(item => item.method === 'Input.synthesizeTapGesture'), false);
  const scrolled = await f.adapter.act({ kind: 'scroll', x: 20, y: 30, deltaY: 300, observationId: clicked.observation.observationId }, { isBackground: () => false });
  assert.equal(scrolled.inputMode, 'cdp-wheel');
});

test('task document activation is debugger-scoped and reinitialized after detach without calling native focus', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  f.wc.focus = () => { throw Error('document emulation cannot focus the native view'); };
  await f.adapter.observe();
  assert.equal(f.calls.some(item => item.method === 'Emulation.setFocusEmulationEnabled'), false);
  await f.adapter.observe({ isBackground: () => true });
  await f.adapter.observe({ isBackground: () => false });
  assert.deepEqual(f.calls.filter(item => item.method === 'Emulation.setFocusEmulationEnabled').map(item => item.params), [{ enabled: true }]);
  f.debug.detach();
  await f.adapter.observe({ isBackground: () => true });
  assert.equal(f.calls.filter(item => item.method === 'Emulation.setFocusEmulationEnabled').length, 2);
  f.adapter.dispose(); assert.equal(f.debug.isAttached(), false);
});

test('background initialization completes before DOM observation and its wait remains cancellable and bounded', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  let release, waiting;
  const entered = new Promise(resolve => { waiting = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const observed = f.adapter.observe({ isBackground: () => true, waitForBackgroundReady: () => { waiting(); return ready; } });
  await entered;
  assert.equal(f.calls.some(item => item.method === 'Runtime.evaluate'), false);
  assert.equal(f.calls.some(item => item.method === 'Emulation.setFocusEmulationEnabled'), true);
  release(); await observed;
  await assert.rejects(f.adapter.observe({ deadline: Date.now() + 25, waitForBackgroundReady: () => new Promise(() => {}) }), { code: 'BROWSER_COMMAND_TIMEOUT' });
  const controller = new AbortController();
  await assert.rejects(f.adapter.observe({ signal: controller.signal, waitForBackgroundReady: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } }), { code: 'BROWSER_CANCELLED' });
  await assert.rejects(f.adapter.observe({ waitForBackgroundReady: () => Promise.reject(Object.assign(Error('surface unavailable'), { code: 'BROWSER_BACKGROUND_UNAVAILABLE' })) }), { code: 'BROWSER_BACKGROUND_UNAVAILABLE' });
  assert.equal(f.inputCalls().length, 0);
});

test('CDP wheel preserves requested CSS deltas under zoom and rejects zoom changes during its input handshake', async t => {
  const f=fixture();t.after(()=>f.adapter.dispose());let zoom=1.25;f.wc.getZoomFactor=()=>zoom;
  let observed=await f.adapter.observe();
  await f.adapter.act({kind:'scroll',x:20,y:30,deltaX:16,deltaY:80,observationId:observed.observationId},{background:true});
  const { type,x,y,deltaX,deltaY }=f.inputCalls().at(-1).params;
  assert.deepEqual({type,x,y,deltaX,deltaY},{type:'mouseWheel',x:20,y:30,deltaX:20,deltaY:100});
  observed=await f.adapter.observe();const count=f.inputCalls().length;
  await assert.rejects(f.adapter.act({kind:'scroll',x:20,y:30,deltaY:80,observationId:observed.observationId},{background:true,onInput:()=>{zoom=1.5;}}),{code:'BROWSER_ELEMENT_UNSTABLE'});
  assert.equal(f.inputCalls().length,count,'a changed zoom never dispatches a mis-scaled wheel');
});

test('observation uses an isolated world and real input returns a new observation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const first = await f.adapter.observe();
  assert.ok(f.calls.find(call => call.method === 'Page.createIsolatedWorld'));
  let guards = 0;
  const action = await f.adapter.act({ observationId: first.observationId, ref: 'e1', kind: 'fill', text: 'Ada' }, { check: () => guards++ });
  assert.equal(action.executed, true); assert.notEqual(action.observation.observationId, first.observationId);
  assert.deepEqual(f.inputCalls().map(call => call.method), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  assert.ok(guards > f.inputCalls().length);
  assert.equal((await f.adapter.verify({ observationId: action.observation.observationId, ref: 'e1', value: 'Ada' })).verified, true);
});

test('an initialized blank document can be observed without being mistaken for an uncreated renderer', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.url = 'about:blank';
  assert.equal((await f.adapter.observe()).url, 'about:blank');
  f.wc.url = ''; await assert.rejects(f.adapter.observe(), { code: 'BROWSER_DOCUMENT_NOT_READY' });
});

test('re-observation and navigation invalidate old references before dispatch', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const old = await f.adapter.observe(), latest = await f.adapter.observe();
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: old.observationId }), { code: 'BROWSER_OBSERVATION_STALE' });
  f.wc.emit('did-start-navigation', {}, f.wc.url, false, true);
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: latest.observationId }), { code: 'BROWSER_OBSERVATION_STALE' });
  assert.equal(f.inputCalls().length, 0);
});

test('cancelled and withdrawn ownership checks stop all future input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const observation = await f.adapter.observe(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }, { signal: controller.signal }), { code: 'BROWSER_CANCELLED' });
  assert.equal(f.inputCalls().length, 0);
  let revoked = false;
  f.wc.beforeCommand = async method => { if (method.startsWith('Input.')) revoked = true; };
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }, { check: () => { if (revoked) throw Object.assign(Error('Taken over'), { code: 'CONTROL_REVOKED' }); } }), { code: 'CONTROL_REVOKED' });
  assert.equal(f.inputCalls().length, 1); assert.equal(f.inputCalls()[0].params.type, 'mouseMoved');
});

test('Chromium visibility rejection precedes the first mouse command and reports no dispatched input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const observation = await f.adapter.observe();
  const prepared = [];
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }, {
    onInput: async descriptor => {
      prepared.push(descriptor.method);
      throw Object.assign(Error('Chromium document is hidden'), { code: 'BROWSER_NOT_VISIBLE' });
    },
  }), error => error.code === 'BROWSER_NOT_VISIBLE' && error.inputDispatched === false);
  assert.deepEqual(prepared, ['Input.dispatchMouseEvent']);
  assert.equal(f.inputCalls().length, 0);
});

test('obscured targets and unsupported operations never send input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const observation = await f.adapter.observe(); f.wc.pageError = 'BROWSER_ELEMENT_OBSCURED';
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }), { code: 'BROWSER_ELEMENT_OBSCURED' });
  await assert.rejects(f.adapter.act({ kind: 'evaluate', expression: 'alert(1)', observationId: observation.observationId }), { code: 'BROWSER_ACTION_UNSUPPORTED' });
  await assert.rejects(f.adapter.act({ kind: 'click', x: 20, y: 30, observationId: observation.observationId }), { code: 'BROWSER_ELEMENT_OBSCURED' });
  assert.equal(f.inputCalls().length, 0);
});

test('mouse preflight rechecks the exact dispatch coordinates', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const action = await f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId });
  assert.equal(action.executed, true);
  for (const input of f.inputCalls()) {
    const index = f.calls.indexOf(input), evaluation = f.calls.slice(0, index).findLast(call => call.method === 'Runtime.evaluate');
    assert.match(evaluation.params.expression, /"x":20,"y":30/);
  }
});

test('verification reports failed assertions and rejects password comparisons', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  assert.equal((await f.adapter.verify({ text: 'Not present' })).verified, false);
  const observation = await f.adapter.observe(); f.wc.pageError = 'BROWSER_PASSWORD_READ_BLOCKED';
  await assert.rejects(f.adapter.verify({ ref: 'e1', value: 'secret', observationId: observation.observationId }), { code: 'BROWSER_PASSWORD_READ_BLOCKED' });
});

test('screenshot refuses a changed page and otherwise returns native PNG data', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  assert.deepEqual(await f.adapter.screenshot(), { data: 'cG5n', mimeType: 'image/png', url: f.wc.url });
  f.wc.beforeCommand = async method => { if (method === 'Page.captureScreenshot') f.wc.emit('did-start-navigation', {}, f.wc.url, false, true); };
  await assert.rejects(f.adapter.screenshot(), { code: 'BROWSER_OBSERVATION_STALE' });
});

test('another debugger is not reused or detached', async () => {
  const f = fixture(); f.debug.attached = true;
  await assert.rejects(f.adapter.observe(), { code: 'BROWSER_DEBUGGER_BUSY' });
  f.adapter.dispose(); assert.equal(f.debug.attached, true);
});

test('dispose aborts pending commands, removes listeners and rejects concurrent operation', async () => {
  const f = fixture(); let release;
  f.wc.beforeCommand = method => method === 'Page.enable' ? new Promise(resolve => { release = resolve; }) : undefined;
  const pending = f.adapter.observe();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.adapter.observe(), { code: 'BROWSER_OPERATION_BUSY' });
  f.adapter.dispose();
  await assert.rejects(pending, { code: 'BROWSER_TARGET_CLOSED' });
  release();
  assert.equal(f.wc.listenerCount('did-start-navigation'), 0); assert.equal(f.debug.listenerCount('message'), 0); assert.equal(f.debug.attached, false);
});

test('native clicks are one complete gesture instead of an interruptible down/up pair', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  await f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId });
  assert.deepEqual(f.inputCalls().map(call => call.method), ['Input.dispatchMouseEvent', 'Input.synthesizeTapGesture']);
  assert.equal(f.inputCalls()[1].params.gestureSourceType, 'mouse');
});

test('key down and up share a visibility lease and release it before subsequent text input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const observation = await f.adapter.observe();
  let active = false, leases = 0, releases = 0;
  const result = await f.adapter.act({ kind: 'fill', ref: 'e1', text: 'Ada', observationId: observation.observationId }, {
    onInput: async () => {
      assert.equal(active, false, 'one host input handshake at a time');
      active = true; leases++;
      await new Promise(resolve => setImmediate(resolve));
      return () => { active = false; releases++; };
    },
  });
  assert.equal(result.executed, true); assert.equal(leases, 2); assert.equal(releases, 2);
  assert.deepEqual(f.inputCalls().map(call => call.params.type || call.method), ['keyDown', 'keyUp', 'Input.insertText']);
});

test('key release is queued without waiting for key-down acknowledgement or navigation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe(); let release;
  f.wc.beforeCommand = async (method, params) => {
    if (method !== 'Input.dispatchKeyEvent') return;
    if (params.type === 'keyDown') await new Promise(resolve => { release = resolve; });
    else { assert.ok(release, 'down is queued first'); release(); f.wc.emit('did-start-navigation', {}, f.wc.url, false, true); }
  };
  const action = await f.adapter.act({ kind: 'press', key: 'Enter', ref: 'e1', observationId: observation.observationId });
  assert.equal(action.executed, true);
  assert.deepEqual(f.inputCalls().map(call => call.params.type), ['keyDown', 'keyUp']);
});

test('action failures distinguish preflight rejection from already dispatched input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  f.wc.pageError = 'BROWSER_ELEMENT_OBSCURED';
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }), error => error.inputDispatched === false);
  f.wc.pageError = null;
  f.wc.beforeCommand = method => { if (method.startsWith('Input.')) throw Error('Native input failed'); };
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }), error => error.inputDispatched === true);
});

test('an uncreated renderer cannot be silently observed as the target page', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.url = '';
  await assert.rejects(f.adapter.observe(), { code: 'BROWSER_DOCUMENT_NOT_READY' });
  assert.equal(f.calls.length, 0);
});

test('empty assertions and inherited key names cannot masquerade as supported operations', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  await assert.rejects(f.adapter.verify({ text: '' }), { code: 'BROWSER_VERIFICATION_REQUIRED' });
  const observation = await f.adapter.observe();
  await assert.rejects(f.adapter.act({ kind: 'press', key: '__proto__', ref: 'e1', observationId: observation.observationId }), { code: 'BROWSER_KEY_UNSUPPORTED' });
  assert.equal(f.inputCalls().length, 0);
});

test('wait polls a retained node without invalidating its observation on each attempt', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.fieldValue = 'pending';
  const observation = await f.adapter.observe();
  const timer = setTimeout(() => { f.wc.fieldValue = 'done'; }, 65); t.after(() => clearTimeout(timer));
  const result = await f.adapter.wait({ observationId: observation.observationId, ref: 'e1', value: 'done', timeoutMs: 500, pollIntervalMs: 50 });
  assert.equal(result.satisfied, true); assert.equal(result.timedOut, false);
  assert.equal(result.observation, null); assert.equal(result.requiresObservation, false);
  assert.equal((await f.adapter.verify({ observationId: observation.observationId, ref: 'e1', value: 'done' })).verified, true);
  const evaluations = f.calls.filter(call => call.method === 'Runtime.evaluate').map(call => /"operation":"([^"]+)"/.exec(call.params.expression)[1]);
  assert.equal(evaluations.filter(operation => operation === 'observe').length, 1);
  assert.ok(evaluations.filter(operation => operation === 'verify-element').length > 1);
  assert.equal(f.inputCalls().length, 0);
});

test('wait timeout is an explicit unmet condition and cancellation stops polling', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const result = await f.adapter.wait({ text: 'missing', timeoutMs: 100, pollIntervalMs: 50 });
  assert.equal(result.satisfied, false); assert.equal(result.timedOut, true); assert.equal(result.checks[0].passed, false);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20); t.after(() => clearTimeout(timer));
  await assert.rejects(f.adapter.wait({ text: 'missing', timeoutMs: 500, pollIntervalMs: 50 }, { signal: controller.signal }), { code: 'BROWSER_CANCELLED' });
  assert.equal(f.inputCalls().length, 0);
});

test('wait rejects navigation for refs while URL-only wait follows navigation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  let timer = setTimeout(() => { f.wc.url = 'http://127.0.0.1/next'; f.wc.emit('did-start-navigation', {}, f.wc.url, false, true); }, 25);
  await assert.rejects(f.adapter.wait({ observationId: observation.observationId, ref: 'e1', value: 'missing', timeoutMs: 500, pollIntervalMs: 50 }), { code: 'BROWSER_OBSERVATION_STALE' });
  clearTimeout(timer);
  timer = setTimeout(() => { f.wc.url = 'http://127.0.0.1/final'; f.wc.emit('did-start-navigation', {}, f.wc.url, false, true); }, 25);
  const result = await f.adapter.wait({ url: 'http://127.0.0.1/final', timeoutMs: 500, pollIntervalMs: 50 });
  clearTimeout(timer); assert.equal(result.satisfied, true);
});

test('wait applies its deadline even when a CDP read never responds', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.observe();
  f.wc.beforeCommand = (method, params) => method === 'Runtime.evaluate' && params.expression.includes('"operation":"read-page"') ? new Promise(() => {}) : undefined;
  const started = Date.now(), result = await f.adapter.wait({ text: 'missing', timeoutMs: 100 });
  assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 400);
});

test('select uses only the fixed page operation and reports its DOM event semantics', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const result = await f.adapter.act({ kind: 'select', observationId: observation.observationId, ref: 'e1', values: ['blue'] });
  assert.equal(result.executed, true); assert.equal(result.inputMode, 'dom-events');
  assert.deepEqual(result.selectedValues, ['blue']); assert.equal(f.inputCalls().length, 0);
  await assert.rejects(f.adapter.act({ kind: 'select', observationId: result.observation.observationId, ref: 'e1', values: ['blue', 'blue'] }), error => error.code === 'BROWSER_INVALID_SELECTION' && !error.inputDispatched);
});

test('upload dispatches validated paths only to the observed remote input and releases its handle', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const files = [path.join(os.tmpdir(), 'relay-unit-upload.txt')];
  const result = await f.adapter.upload({ observationId: observation.observationId, ref: 'e1', files });
  assert.equal(result.executed, true); assert.equal(result.fileCount, 1); assert.ok(!JSON.stringify(result).includes(files[0]));
  assert.deepEqual(f.calls.find(call => call.method === 'DOM.setFileInputFiles').params, { objectId: 'observed-file-node', files });
  assert.ok(f.calls.some(call => call.method === 'Runtime.releaseObject'));
  assert.ok(f.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('"operation":"file-check"')).length >= 2);
});

test('upload rejects relative paths, cancelled leases, and changed file input nodes before dispatch', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  await assert.rejects(f.adapter.upload({ observationId: observation.observationId, ref: 'e1', files: ['relative.txt'] }), error => error.code === 'BROWSER_INVALID_UPLOAD_FILES' && !error.inputDispatched);
  await assert.rejects(f.adapter.upload({ observationId: observation.observationId, ref: 'e1', files: Array.from({ length: 17 }, (_, index) => path.join(os.tmpdir(), 'extra-' + index + '.txt')) }), error => error.code === 'BROWSER_INVALID_UPLOAD_FILES' && !error.inputDispatched);
  const files = [path.join(os.tmpdir(), 'relay-unit-upload.txt')]; let checks = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.upload({ observationId: observation.observationId, ref: 'e1', files }, { signal: controller.signal }), error => error.code === 'BROWSER_CANCELLED' && !error.inputDispatched);
  f.wc.beforeCommand = (method, params) => { if (method === 'Runtime.evaluate' && params.expression.includes('"operation":"file-check"') && ++checks === 2) f.wc.pageError = 'BROWSER_ELEMENT_STALE'; };
  await assert.rejects(f.adapter.upload({ observationId: observation.observationId, ref: 'e1', files }), error => error.code === 'BROWSER_ELEMENT_STALE' && !error.inputDispatched);
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0);
  assert.ok(f.calls.some(call => call.method === 'Runtime.releaseObject'));
});

test('diagnostics initializes CDP collection and returns redacted network metadata', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.observe();
  assert.ok(f.calls.some(call => call.method === 'Network.enable'));
  f.debug.emit('message', {}, 'Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { url: 'https://example.test/api?token=do-not-return', status: 503, mimeType: 'text/plain' } });
  const result = await f.adapter.diagnostics({ kind: 'network' });
  assert.ok(result.events.some(event => event.type === 'response' && event.status === 503));
  assert.ok(!JSON.stringify(result).includes('do-not-return'));
});

test('download arming runs synchronously only immediately before the actual click gesture', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); let armed = 0;
  const observation = await f.adapter.observe();
  const beforeClick = () => { armed++; assert.equal(f.calls.at(-1).method, 'Runtime.evaluate'); };
  f.wc.pageError = 'BROWSER_ELEMENT_OBSCURED';
  await assert.rejects(f.adapter.act({ kind: 'click', observationId: observation.observationId, ref: 'e1' }, { beforeClick }), { code: 'BROWSER_ELEMENT_OBSCURED' });
  assert.equal(armed, 0); f.wc.pageError = null;
  const fresh = await f.adapter.observe();
  await assert.rejects(f.adapter.act({ kind: 'click', observationId: observation.observationId, ref: 'e1' }, { beforeClick }), { code: 'BROWSER_OBSERVATION_STALE' });
  assert.equal(armed, 0);
  f.wc.beforeCommand = (method) => { if (method === 'Input.synthesizeTapGesture') assert.equal(armed, 1); };
  await f.adapter.act({ kind: 'click', observationId: fresh.observationId, ref: 'e1' }, { beforeClick });
  assert.equal(armed, 1);
});

test('async input handshake cancellation is checked before dispatch and cleans its intent', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const controller = new AbortController(); let cleaned = 0;
  await assert.rejects(f.adapter.act({ kind: 'click', ref: 'e1', observationId: observation.observationId }, {
    signal: controller.signal, onInput: async () => { await Promise.resolve(); controller.abort(); return () => { cleaned++; }; },
  }), error => error.code === 'BROWSER_CANCELLED' && error.inputDispatched === false);
  assert.equal(cleaned, 1); assert.equal(f.inputCalls().length, 0);
});

test('native wheel avoids a hanging CDP wheel acknowledgement and preserves down direction', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const native = []; let cleaned = 0;
  f.wc.sendInputEvent = event => native.push(event);
  await f.adapter.act({ kind: 'scroll', ref: 'e1', deltaY: 450, observationId: observation.observationId }, { onInput: async event => { assert.equal(event.method, 'webContents.sendInputEvent'); return () => { cleaned++; }; } });
  assert.equal(f.inputCalls().length, 0); assert.equal(native.length, 1); assert.equal(native[0].deltaY, -450); assert.equal(cleaned, 1);
});

test('strict locator actions retain the observation gate and reject ambiguity before input', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  f.wc.pageError = 'BROWSER_LOCATOR_AMBIGUOUS';
  await assert.rejects(f.adapter.act({ kind: 'click', observationId: observation.observationId, locator: { role: 'button', name: 'Save' } }), error => error.code === 'BROWSER_LOCATOR_AMBIGUOUS' && !error.inputDispatched);
  await f.adapter.observe();
  await assert.rejects(f.adapter.act({ kind: 'click', observationId: observation.observationId, locator: { role: 'button', name: 'Save' } }), { code: 'BROWSER_OBSERVATION_STALE' });
  assert.equal(f.inputCalls().length, 0);
});

test('screenshot size limits reject giant clips before capture', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  await assert.rejects(f.adapter.screenshot({}, { clip: { x: 0, y: 0, width: 16000, height: 16000 } }), { code: 'BROWSER_SCREENSHOT_TOO_LARGE' });
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot').length, 0);
});

test('modifier key parsing supports chords and rejects inherited names', () => {
  const { parseKey } = require('../src/main/browser/browser-input-contract');
  assert.deepEqual(parseKey('Control+Shift+a'), { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 10 });
  assert.equal(parseKey('Shift+Tab').modifiers, 8);
  assert.throws(() => parseKey('constructor'), { code: 'BROWSER_KEY_UNSUPPORTED' });
  assert.throws(() => parseKey('Hyper+a'), { code: 'BROWSER_KEY_UNSUPPORTED' });
});

test('pointer-down handshake cannot let the release overtake a right click', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  let cleaned = 0;
  await f.adapter.act({ kind: 'rightClick', ref: 'e1', observationId: observation.observationId }, {
    onInput: async descriptor => {
      if (descriptor.params.type !== 'mousePressed') return () => {};
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(f.inputCalls().some(call => call.params.type === 'mouseReleased'), false);
      return () => { cleaned++; };
    },
  });
  assert.deepEqual(f.inputCalls().map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(cleaned, 1);
});

test('double click dispatches actual mouse click counts instead of repeated taps', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  await f.adapter.act({ kind: 'doubleClick', ref: 'e1', observationId: observation.observationId });
  const clicks = f.inputCalls().filter(call => ['mousePressed', 'mouseReleased'].includes(call.params.type));
  assert.deepEqual(clicks.map(call => [call.params.type, call.params.clickCount]), [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]);
  assert.equal(f.inputCalls().some(call => call.method === 'Input.synthesizeTapGesture'), false);
});

test('native wheel converts CSS point and delta to the view zoom without changing CDP units', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const native = []; f.wc.getZoomFactor = () => 1.25; f.wc.sendInputEvent = event => native.push(event);
  await f.adapter.act({ kind: 'scroll', ref: 'e1', deltaY: 80, observationId: observation.observationId });
  assert.equal(native[0].x, 25); assert.equal(native[0].y, 38); assert.equal(native[0].deltaY, -100);
});

test('locator value waits compare field contents instead of accepting visibility alone', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.fieldValue = 'pending';
  const missing = await f.adapter.wait({ locator: { label: 'Status' }, value: 'finished', timeoutMs: 100, pollIntervalMs: 50 });
  assert.equal(missing.satisfied, false); assert.ok(missing.checks.some(check => check.kind === 'value' && !check.passed));
  f.wc.fieldValue = 'finished';
  assert.equal((await f.adapter.wait({ locator: { label: 'Status' }, value: 'finished', timeoutMs: 500 })).satisfied, true);
  f.wc.pageError = 'BROWSER_PASSWORD_READ_BLOCKED';
  await assert.rejects(f.adapter.wait({ locator: { label: 'Password' }, value: 'secret' }), { code: 'BROWSER_PASSWORD_READ_BLOCKED' });
});

test('parent frame obstruction blocks child fill and select before focus or DOM events', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.withFrame = true;
  const observation = await f.adapter.observe({}, { frameId: 'child' }); f.wc.frameOccluded = true;
  for (const action of [{ kind: 'fill', text: 'blocked' }, { kind: 'select', values: ['blue'] }]) {
    await assert.rejects(f.adapter.act({ ...action, ref: 'e1', frameId: 'child', observationId: observation.observationId }), error => error.code === 'BROWSER_FRAME_OBSCURED' && error.inputDispatched === false);
  }
  assert.equal(f.inputCalls().length, 0);
  assert.equal(f.calls.some(call => call.method === 'Runtime.evaluate' && /"operation":"(?:focus|select)"/.test(call.params.expression)), false);
});
