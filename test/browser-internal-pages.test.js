'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function routes() {
  // Custom URL schemes can be opaque in Electron. Route recognition must not
  // depend on the host's global URL parser or a custom privileged protocol.
  const context = { window: {}, URL: class { constructor() { throw Error('opaque scheme'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/browser-internal-pages.js'), 'utf8'), context);
  return context.window.RelayBrowserInternalPages;
}
test('browser local addresses round-trip for every management page without a custom protocol', () => {
  const { pages, address, parse } = routes();
  for (const section of Object.keys(pages)) assert.equal(parse(address(section)), section);
  assert.equal(parse(' RELAY://BROWSER/HISTORY/ '), 'history');
  assert.equal(parse('relay://browser'), 'general');
});
test('browser management routes cannot accept another authority, embedded credentials, traversal or external URLs', () => {
  const { parse } = routes();
  for (const value of ['https://browser/history', 'relay://browser.example/history', 'relay://browser@evil/history', 'relay://user@browser/history', 'relay://browser:80/history', 'relay://browser/history?next=evil', 'relay://browser/history#evil', 'relay://browser/../settings', 'relay://browser/%68istory', 'relay://browser\\history', 'relay://settings', 'relay://browser/unknown', 'javascript:alert(1)', 'file:///history']) {
    assert.equal(parse(value), null, value);
  }
});
