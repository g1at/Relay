'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, downloadActions, routeLink } = require('../renderer/browser-settings-page.js');
test('missing download sizes remain unknown while actual zero bytes remain zero', () => {
  assert.equal(formatBytes(undefined), '—'); assert.equal(formatBytes(NaN), '—'); assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(1536), '1.5 KB'); assert.equal(formatBytes(1048576), '1 MB');
});
test('download controls allow pausing active transfers and deletion only after transfer has stopped', () => {
  assert.deepEqual(downloadActions({ state: 'progressing' }), { pause: true, resume: false, cancel: true, open: false, showInFolder: false, delete: false });
  const paused = downloadActions({ state: 'paused', canResume: true }); assert.equal(paused.resume, true); assert.equal(paused.cancel, true); assert.equal(paused.delete, false);
  const interrupted = downloadActions({ state: 'interrupted', canResume: false }); assert.equal(interrupted.cancel, false); assert.equal(interrupted.delete, true); assert.equal(interrupted.open, false);
  const done = downloadActions({ state: 'completed' }); assert.equal(done.open, true); assert.equal(done.showInFolder, true); assert.equal(done.cancel, false);
});
test('an internal routed link shows exactly the browser tab returned by the backend', async () => {
  const calls = [], tab = { id: 'browser-fixture', url: 'http://localhost:3000' };
  const api = { browser: { invoke: async value => { calls.push(value); return { ok: true, tab }; } }, openExternal: () => assert.fail('external route must not run') };
  await routeLink({ api, workspace: { showBrowserTab: value => calls.push(value) }, url: ' http://localhost:3000 ' });
  assert.deepEqual(calls, [{ action: 'openLink', url: 'http://localhost:3000' }, tab]);
});
test('a backend-opened external route is never opened a second time', async () => {
  let shown = 0;
  await routeLink({ api: { browser: { invoke: async () => ({ ok: true, external: true }) }, openExternal: () => assert.fail('duplicate external opening') }, workspace: { showBrowserTab: () => shown++ }, url: 'https://example.com' });
  assert.equal(shown, 0);
});
test('mail links use the system handler without creating a Relay browser tab', async () => {
  const calls = [];
  await routeLink({ api: { openExternal: value => calls.push(value), browser: { invoke: () => assert.fail('not a web route') } }, url: 'mailto:test@example.invalid' });
  assert.deepEqual(calls, ['mailto:test@example.invalid']);
});
test('failed link routing never falls back to a different destination', async () => {
  await assert.rejects(routeLink({ api: { browser: { invoke: async () => ({ ok: false, error: '无法打开此地址' }) }, openExternal: () => assert.fail('unsafe fallback') }, workspace: { showBrowserTab: () => assert.fail('failed tab') }, url: 'javascript:invalid' }), /无法打开此地址/);
});
