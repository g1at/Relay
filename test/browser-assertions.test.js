'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserAutomationAdapter } = require('../src/main/browser/browser-automation-adapter');
function fixture() {
  const wc = new EventEmitter(), debug = new EventEmitter(), requests = [];
  wc.url = 'https://fixture.test/'; wc.getURL = () => wc.url; wc.isDestroyed = () => false;
  wc.state = { count: 1, attached: true, visible: true, enabled: true, editable: true, checked: false, selected: true, text: 'Saved', value: 'Ada', attribute: 'current' };
  debug.attached = false; debug.isAttached = () => debug.attached; debug.attach = () => { debug.attached = true; }; debug.detach = () => { debug.attached = false; debug.emit('detach'); };
  debug.sendCommand = async (method, params = {}) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader1', url: wc.url } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') {
      if (params.expression.includes('"operation":"initialize"')) return { result: { value: true } };
      const request = JSON.parse(params.expression.slice(params.expression.lastIndexOf(')(') + 2, -1)); requests.push(request);
      if (wc.operation) { const value = await wc.operation(request); if (value !== undefined) return { result: { value } }; }
      if (request.operation === 'observe') return { result: { value: { observationId: request.observationId, url: wc.url, text: 'Saved', elements: [{ ref: 'e1' }] } } };
      if (request.operation === 'read-page') return { result: { value: { url: wc.url, text: 'Saved', readyState: 'complete' } } };
      return { result: { value: wc.state } };
    }
    assert.ok(!method.startsWith('Input.'), 'assertions never dispatch input'); return {};
  };
  wc.debugger = debug;
  return { wc, debug, requests, adapter: createBrowserAutomationAdapter({ webContents: wc, commandTimeoutMs: 200 }) };
}

test('verification reads all supported unique-node assertions without rotating references', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  const result = await f.adapter.verify({ observationId: observation.observationId, ref: 'e1', text: 'Saved', value: 'Ada', checked: false, enabled: true, editable: true, selected: true, attribute: { name: 'aria-current', value: 'current' }, url: f.wc.url });
  assert.equal(result.verified, true); assert.equal(result.satisfied, true); assert.equal(result.checks.length, 8); assert.equal(result.observation, null); assert.equal(result.requiresObservation, false);
  assert.equal((await f.adapter.verify({ observationId: observation.observationId, ref: 'e1', value: 'Ada' })).verified, true);
  assert.equal(f.requests.filter(r => r.operation === 'observe').length, 1);
});

test('count zero does not accidentally require visibility, and missing nodes never satisfy false properties', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.state = { count: 0, attached: false, visible: false, enabled: false };
  assert.equal((await f.adapter.verify({ locator: { role: 'button' }, count: 0 })).verified, true);
  assert.equal((await f.adapter.verify({ locator: { role: 'button' }, enabled: false })).verified, false);
  assert.equal((await f.adapter.verify({ locator: { role: 'button' }, state: 'detached' })).verified, true);
  assert.equal((await f.adapter.verify({ locator: { role: 'button' } })).verified, false);
});

test('checked and selected false require an applicable node state', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); delete f.wc.state.checked; delete f.wc.state.selected;
  const result = await f.adapter.verify({ locator: { role: 'button' }, checked: false, selected: false });
  assert.equal(result.verified, false); assert.deepEqual(result.checks.map(c => c.actual), [null, null]);
});

test('state, count and named attribute query flags are forwarded without refreshing observation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const result = await f.adapter.verify({ locator: { role: 'option' }, count: 1, state: 'visible', checked: false, enabled: true, editable: true, selected: true, attribute: { name: 'aria-current', value: 'current' } });
  assert.equal(result.verified, true);
  const query = f.requests.find(r => r.operation === 'query-state');
  assert.equal(query.wantEnabled, true); assert.equal(query.wantChecked, true); assert.equal(query.wantSelected, true); assert.equal(query.wantEditable, true); assert.equal(query.attributeName, 'aria-current');
  assert.equal(f.requests.some(r => r.operation === 'observe'), false);
});

test('attribute absence is explicit null and does not equal an empty string', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); f.wc.state.attribute = null;
  assert.equal((await f.adapter.verify({ locator: { role: 'button' }, attribute: { name: 'disabled', value: null } })).verified, true);
  assert.equal((await f.adapter.verify({ locator: { role: 'button' }, attribute: { name: 'disabled', value: '' } })).verified, false);
});

test('wait polls boolean assertions and retains the same valid element references', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe(); f.wc.state.checked = false;
  let reads = 0; f.wc.operation = r => { if (r.operation === 'verify-element' && ++reads === 2) f.wc.state.checked = true; };
  const result = await f.adapter.wait({ ref: 'e1', observationId: observation.observationId, checked: true, timeoutMs: 300, pollIntervalMs: 50 });
  assert.equal(result.satisfied, true); assert.equal(result.verified, true); assert.equal(result.observation, null); assert.equal(result.requiresObservation, false);
  assert.equal((await f.adapter.verify({ ref: 'e1', observationId: observation.observationId, checked: true })).verified, true);
  assert.equal(f.requests.filter(r => r.operation === 'observe').length, 1);
});

test('invalid, mixed and ambiguous assertions fail explicitly before any page read', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  for (const input of [{}, { count: 0 }, { ref: 'e1', observationId: 'o1', state: 'detached' }, { enabled: 'false', locator: { role: 'button' } }, { editable: true }, { locator: { role: 'button' }, ref: 'e1', count: 1 }, { locator: { role: 'button' }, attribute: { name: 'x\u0001', value: '' } }]) await assert.rejects(f.adapter.verify(input));
  assert.equal(f.requests.length, 0);
  f.wc.operation = r => r.operation === 'query-state' ? { error: { code: 'BROWSER_LOCATOR_AMBIGUOUS', message: 'Multiple nodes' } } : undefined;
  await assert.rejects(f.adapter.verify({ locator: { role: 'button' }, checked: true }), { code: 'BROWSER_LOCATOR_AMBIGUOUS' });
});

test('ref assertions preserve stale and password-read failures', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); const observation = await f.adapter.observe();
  f.wc.operation = r => r.operation === 'verify-element' ? { error: { code: r.value !== undefined ? 'BROWSER_PASSWORD_READ_BLOCKED' : 'BROWSER_ELEMENT_STALE', message: 'Blocked' } } : undefined;
  await assert.rejects(f.adapter.verify({ ref: 'e1', observationId: observation.observationId, value: 'secret' }), { code: 'BROWSER_PASSWORD_READ_BLOCKED' });
  await assert.rejects(f.adapter.wait({ ref: 'e1', observationId: observation.observationId, checked: false, timeoutMs: 100 }), { code: 'BROWSER_ELEMENT_STALE' });
});

test('event wait can read current load state, rejects mixed assertions, and needs no observation', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose());
  const result = await f.adapter.wait({ event: 'load', waitUntil: 'load', timeoutMs: 100 });
  assert.equal(result.satisfied, true); assert.equal(result.verified, true); assert.equal(result.observation, null);
  await assert.rejects(f.adapter.wait({ event: 'response', text: 'Saved' }), { code: 'BROWSER_INVALID_EVENT_WAIT' });
});
