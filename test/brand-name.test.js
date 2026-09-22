'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

function declaration(text, name) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `missing ${name}`);
  return text.slice(start, end + 2);
}

function harness(initial = {}) {
  const handlers = new Map();
  let stored = { ...initial };
  let writes = 0;
  const context = vm.createContext({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    readAppSettings: () => ({ ...stored }),
    writeAppSettings: settings => { writes++; stored = { ...settings }; },
    brandLogoDataUrl: () => null,
    registeredMiniAccel: null,
    isQuickChatEnabled: require('../src/main/app/mini-window-host').isQuickChatEnabled,
    miniBrandCache: null, miniHost: null,
    crypto: require('node:crypto'),
  });
  const maximum = source.match(/const BRAND_NAME_MAX = \d+;/);
  assert.ok(maximum);
  vm.runInContext(maximum[0], context);
  for (const name of ['toGraphemes', 'graphemeWidth']) vm.runInContext(declaration(source, name), context);
  for (const name of ['brandProfileRevision', 'brandProfileSnapshot']) vm.runInContext(declaration(source, name), context);
  for (const name of ['brand:get', 'brand:setName', 'mini:brand']) {
    const start = source.indexOf(`ipcMain.handle('${name}',`);
    const end = source.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start, `missing ${name}`);
    vm.runInContext(source.slice(start, end + 4), context);
  }
  return {
    get: () => handlers.get('brand:get')(),
    mini: () => handlers.get('mini:brand')(),
    set: name => handlers.get('brand:setName')(null, name),
    get stored() { return stored; },
    get writes() { return writes; },
  };
}

test('brand API advertises and accepts the same expanded 40-width boundary', () => {
  const h = harness({ theme: 'dark' });
  assert.equal(h.get().nameMax, 40);
  for (const name of ['A'.repeat(40), '助'.repeat(20), '本地助手 '.repeat(4) + 'AI']) {
    assert.equal(h.set(name).ok, true);
    assert.equal(h.get().name, name);
    assert.equal(h.mini().name, name);
    assert.equal(h.stored.theme, 'dark');
  }
});

test('41-width names fail clearly without truncation or a settings write', () => {
  const h = harness({ brandName: '之前的名称', theme: 'light' });
  for (const name of ['A'.repeat(41), '助'.repeat(20) + 'A', '助'.repeat(21)]) {
    const response = h.set(name);
    assert.equal(response.ok, false);
    assert.equal(response.nameMax, 40);
    assert.match(response.error, /20.*40/);
    assert.equal(h.writes, 0);
    assert.equal(h.get().name, '之前的名称');
  }
});

test('normalization precedes validation and empty names restore Relay', () => {
  const h = harness({ brandName: '旧名称', theme: 'dark' });
  const exact = 'A'.repeat(40);
  assert.equal(h.set(` \t${exact}\n `).name, exact);
  assert.equal(h.set('  本地\tAI\n助手\r  ').name, '本地 AI 助手');
  for (const value of ['', ' \t\n\r ', null, undefined]) {
    assert.equal(h.set(value).ok, true);
    assert.equal(h.get().name, '');
    assert.equal(h.mini().name, 'Relay');
    assert.equal(Object.hasOwn(h.stored, 'brandName'), false);
    assert.equal(h.stored.theme, 'dark');
  }
});

test('Unicode graphemes remain intact and match the renderer counter', () => {
  const counter = vm.createContext({});
  for (const name of ['toGraphemes', 'graphemeWidth', 'strWidth']) {
    vm.runInContext(declaration(rendererSource, name), counter);
  }
  const h = harness();
  for (const name of [
    '👨‍👩‍👧'.repeat(20),
    '👍🏽'.repeat(20),
    'e\u0301'.repeat(40),
    '𠮷'.repeat(20),
    '智能👩‍💻'.repeat(6) + 'AI助手',
  ]) {
    const width = counter.strWidth(name);
    const result = h.set(name);
    assert.equal(result.ok, width <= h.get().nameMax, name);
    if (result.ok) assert.equal(h.get().name, name);
  }
  const previous = h.get().name;
  assert.equal(counter.strWidth('👨‍👩‍👧'.repeat(20) + 'A'), 41);
  assert.equal(h.set('👨‍👩‍👧'.repeat(20) + 'A').ok, false);
  assert.equal(h.get().name, previous);
});

test('reading an existing name never silently mutates stored personalization', () => {
  const existing = 'Long name from another version '.repeat(3);
  const h = harness({ brandName: existing, brandLogo: 'brand-logo.png', pmName: 'Legacy PM' });
  assert.equal(h.get().name, existing);
  assert.equal(h.mini().name, existing);
  assert.equal(h.writes, 0);
  assert.equal(h.stored.pmName, 'Legacy PM');
  assert.equal(h.stored.brandLogo, 'brand-logo.png');
});
