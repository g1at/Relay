'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = source.indexOf('const wizardHandoffs = new WeakMap();');
const end = source.indexOf('// ─', start);

function fixture() {
  const events = [], attempts = [];
  const wizard = { dead: false, isDestroyed() { return this.dead; }, close() { this.dead = true; events.push('close-wizard'); },
    show() { events.push('show-wizard'); }, focus() {} };
  const state = { createError: null, writeError: null, saved: null, url: pathToFileURL(path.join(__dirname, '../installer/wizard.html')).href };
  const sender = { getURL: () => state.url };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    WeakMap, Promise, Error, path, pathToFileURL, __dirname: path.join(__dirname, '..'),
    FIRST_RUN_SETUP_VERSION: 1,
    BrowserWindow: { fromWebContents: value => value === sender ? wizard : null },
    ipcMain: { handle: (name, fn) => { assert.equal(name, 'wizard:complete'); handler = fn; } },
    readAppSettings: () => ({ theme: 'dark' }),
    writeAppSettings(value) { if (state.writeError) throw state.writeError; state.saved = value; events.push('write-settings'); },
    createMainWindow(options) {
      assert.equal(options.showOnReady, false);
      if (state.createError) throw state.createError;
      let resolve, reject;
      const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
      const win = { dead: false, relayContentReady: ready, isDestroyed() { return this.dead; },
        destroy() { this.dead = true; events.push('destroy-main'); }, show() { events.push('show-main'); }, focus() {} };
      attempts.push({ win, resolve, reject }); events.push('create-main'); return win;
    },
  });
  return { events, attempts, state, wizard, send: () => handler({ sender }), foreign: () => handler({ sender: {} }) };
}

test('first-run handoff waits for page loading before committing and closes only its own welcome window', async () => {
  const f = fixture(), pending = f.send();
  await Promise.resolve();
  assert.deepEqual(f.events, ['create-main']);
  assert.equal(f.state.saved, null);
  f.attempts[0].resolve();
  assert.equal((await pending).ok, true);
  assert.deepEqual(f.events, ['create-main', 'write-settings', 'close-wizard', 'show-main']);
  assert.equal(f.state.saved.theme, 'dark');
  assert.equal(f.state.saved.firstRunSetupVersion, 1);
});

test('double submission shares a single main window and transaction', async () => {
  const f = fixture(), a = f.send(), b = f.send();
  assert.equal(a, b); await Promise.resolve();
  assert.equal(f.attempts.length, 1); f.attempts[0].resolve();
  assert.equal((await a).ok, true);
});

for (const failure of ['create', 'load', 'save']) test(`${failure} failure leaves onboarding retryable without marking setup complete`, async () => {
  const f = fixture();
  if (failure === 'create') f.state.createError = Error('create failed');
  if (failure === 'save') f.state.writeError = Error('save failed');
  let result = f.send(); await Promise.resolve();
  if (failure === 'load') f.attempts[0].reject(Error('load failed'));
  else if (failure === 'save') f.attempts[0].resolve();
  assert.equal((await result).ok, false);
  assert.equal(f.state.saved, null); assert.equal(f.wizard.dead, false);
  if (failure !== 'create') assert.equal(f.attempts[0].win.dead, true);
  f.state.createError = f.state.writeError = null;
  result = f.send(); await Promise.resolve(); f.attempts.at(-1).resolve();
  assert.equal((await result).ok, true);
});

test('other renderers cannot complete onboarding or create windows', () => {
  const f = fixture();
  assert.equal(f.foreign().ok, false);
  f.state.url = 'https://example.com/installer/wizard.html';
  assert.equal(f.send().ok, false); assert.equal(f.attempts.length, 0);
});

test('closing welcome during handoff does not mark setup complete or open a late main window', async () => {
  const f = fixture(), pending = f.send(); await Promise.resolve();
  f.wizard.dead = true; f.attempts[0].resolve();
  assert.equal((await pending).ok, false);
  assert.equal(f.state.saved, null); assert.equal(f.attempts[0].win.dead, true);
  assert.ok(!f.events.includes('show-main'));
});
