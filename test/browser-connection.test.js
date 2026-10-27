'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {}, URL };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/browser-connection.js'), 'utf8'), context);
const describe = context.window.RelayBrowserConnection.describe;

test('HTTP and an unverified HTTPS address never imply a secure connection', () => {
  const http = describe({ url: 'http://intranet.example/' });
  assert.equal(http.state, 'http'); assert.equal(http.icon, 'site'); assert.match(http.title, /未加密/);
  assert.equal(describe({ url: 'https://intranet.example/' }).icon, 'site');
});

test('a secure target is only shown as secure after loading without an error', () => {
  const page = { url: 'https://example.invalid/', connection: { state: 'secure' } };
  assert.equal(describe({ ...page, loading: true }).icon, 'site');
  const failed = describe({ ...page, loading: false, error: 'ERR_CONNECTION_RESET' });
  assert.equal(failed.icon, 'site'); assert.equal(failed.failed, true);
  assert.equal(describe({ ...page, loading: false, error: null }).icon, 'lock');
});

test('certificate failure requires a current approval challenge and exceptions keep their warning', () => {
  const page = { url: 'https://internal.example/', loading: false, connection: { state: 'certificate-error', canContinue: true } };
  assert.equal(describe(page).canContinue, false);
  assert.equal(describe({ ...page, connection: { ...page.connection, challengeId: 'current' } }).canContinue, true);
  const allowed = describe({ ...page, connection: { state: 'certificate-exception' } });
  assert.equal(allowed.icon, 'warning'); assert.equal(allowed.canContinue, false);
  assert.match(allowed.description, /其他标签页/); assert.match(allowed.description, /退出 Relay 后失效/);
});
