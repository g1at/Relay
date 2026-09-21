'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8');

function fixture({ packaged = true, loadError = null, delay = '' } = {}) {
  const calls = { require: 0, check: 0, download: 0, quit: [], marked: 0 };
  const timers = [], intervals = [], immediates = [], events = [], notifications = [];
  const engine = new EventEmitter();
  engine.checkForUpdates = () => {
    calls.check++;
    engine.emit('checking-for-update');
    return Promise.resolve(null);
  };
  engine.downloadUpdate = () => { calls.download++; return Promise.resolve([]); };
  engine.quitAndInstall = (...args) => calls.quit.push(args);
  const context = vm.createContext({
    module: { exports: {} },
    process: { env: { RELAY_UPDATE_CHECK_DELAY_MS: delay } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      assert.equal(name, 'electron-updater'); calls.require++;
      if (loadError) throw loadError;
      return { autoUpdater: engine };
    },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    setImmediate(fn) { immediates.push(fn); },
  });
  vm.runInContext(source, context, { filename: 'updater.js' });
  const updater = context.module.exports;
  const deps = {
    isPackaged: packaged, appVersion: '3.0.0',
    markQuitting: () => { calls.marked++; },
    notify: data => notifications.push(data),
    getMainWindow: () => ({ isDestroyed: () => false,
      webContents: { send: (channel, state) => events.push({ channel, state }) } }),
  };
  return { updater, engine, calls, timers, intervals, immediates, events, notifications,
    init: () => updater.init(deps) };
}

test('packaged startup and status reads do not load updater dependencies', () => {
  const h = fixture(); h.init();
  assert.equal(h.calls.require, 0);
  assert.equal(h.updater.getStatus().state, 'idle');
  assert.equal(h.updater.getStatus().current, '3.0.0');
  assert.equal(h.updater.download().ok, false);
  assert.match(h.updater.download().error, /没有可下载/);
  assert.equal(h.updater.quitAndInstall().ok, false);
  assert.equal(h.calls.require, 0, 'non-check actions cannot accidentally load the dependency');
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 3 * 60 * 1000);
  assert.equal(h.intervals.length, 0);
  assert.equal(h.engine.eventNames().length, 0);
});

test('manual check initializes immediately, subscribes once, and never auto downloads or installs', () => {
  const h = fixture(); h.init(); h.updater.check();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 1);
  assert.equal(h.updater.getStatus().state, 'checking');
  assert.equal(h.engine.autoDownload, false); assert.equal(h.engine.autoInstallOnAppQuit, false);
  h.updater.check(); assert.equal(h.calls.check, 1, 'overlapping checks are ignored');
  h.engine.emit('update-not-available'); h.updater.check();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 2);
  for (const event of ['checking-for-update', 'update-available', 'update-not-available',
    'download-progress', 'update-downloaded', 'error']) assert.equal(h.engine.listenerCount(event), 1);
  h.engine.emit('update-available', { version: '3.0.1' });
  assert.equal(h.updater.getStatus().state, 'available');
  assert.equal(h.calls.download, 0); assert.equal(h.calls.quit.length, 0);
  assert.equal(h.calls.marked, 0); assert.equal(h.notifications.length, 0);
});

test('first automatic check stays at three minutes and later checks stay six hours apart', () => {
  const h = fixture(); h.init();
  assert.equal(h.calls.check, 0); assert.equal(h.calls.require, 0);
  h.timers[0].fn();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 1);
  assert.equal(h.intervals.length, 1); assert.equal(h.intervals[0].ms, 6 * 60 * 60 * 1000);
  h.engine.emit('update-not-available'); h.intervals[0].fn();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 2);
  const override = fixture({ delay: '1500' }); override.init();
  assert.equal(override.timers[0].ms, 1500, 'existing debug delay override remains supported');
});

test('early manual checks do not change or duplicate the existing automatic schedule', () => {
  const h = fixture(); h.init(); h.updater.check(); h.engine.emit('update-not-available');
  assert.equal(h.timers.length, 1); assert.equal(h.intervals.length, 0);
  assert.equal(h.timers[0].ms, 180000); h.timers[0].fn();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 2);
  assert.equal(h.intervals.length, 1);
});

test('explicit download, dismissal and restart retain their existing lifecycle', () => {
  const h = fixture(); h.init(); h.updater.check();
  h.engine.emit('update-available', { version: '3.0.1' });
  assert.equal(h.updater.dismiss().ok, true); assert.equal(h.updater.getStatus().dismissed, true);
  assert.equal(h.updater.download().ok, true); assert.equal(h.calls.download, 1);
  assert.equal(h.updater.getStatus().dismissed, false);
  h.updater.download(); h.updater.check(); assert.equal(h.calls.download, 1); assert.equal(h.calls.check, 1);
  h.engine.emit('download-progress', { percent: 45.7 });
  assert.equal(h.updater.getStatus().progress, 46);
  h.engine.emit('update-downloaded', { version: '3.0.1' });
  assert.equal(h.updater.getStatus().state, 'ready'); assert.equal(h.updater.getStatus().progress, 100);
  assert.equal(h.notifications.length, 1); h.engine.emit('update-downloaded', { version: '3.0.1' });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.updater.quitAndInstall().ok, true); assert.equal(h.calls.marked, 1);
  assert.equal(h.calls.quit.length, 0, 'markQuitting runs before deferred installation');
  h.immediates[0](); assert.deepEqual(h.calls.quit, [[true, true]]);
  assert.ok(h.events.every(event => event.channel === 'relay:update-event'));
});

test('download failure remains retryable without reloading or resubscribing', async () => {
  const h = fixture(); h.init(); h.updater.check();
  h.engine.emit('update-available', { version: '3.0.1' });
  h.engine.downloadUpdate = () => { h.calls.download++; return Promise.reject(new Error('Synthetic network error')); };
  h.updater.download(); await Promise.resolve();
  assert.equal(h.updater.getStatus().state, 'available');
  assert.equal(h.updater.getStatus().error, 'Synthetic network error');
  h.updater.download(); await Promise.resolve();
  assert.equal(h.calls.download, 2); assert.equal(h.calls.require, 1);
  assert.equal(h.engine.listenerCount('error'), 1);
});

test('development mode never loads dependencies or schedules checks', () => {
  const h = fixture({ packaged: false }); h.init(); h.updater.check();
  assert.equal(h.updater.getStatus().state, 'disabled'); assert.equal(h.calls.require, 0);
  assert.equal(h.timers.length, 0); assert.equal(h.intervals.length, 0);
  assert.equal(h.updater.download().ok, false); assert.equal(h.updater.quitAndInstall().ok, false);
});

test('deferred dependency failure disables and reports state without repeated load attempts', () => {
  const h = fixture({ loadError: new Error('Synthetic missing updater') }); h.init();
  assert.equal(h.calls.require, 0); assert.equal(h.updater.getStatus().state, 'idle');
  assert.doesNotThrow(() => h.updater.check());
  assert.equal(h.updater.getStatus().state, 'disabled');
  assert.equal(h.events.at(-1).state.state, 'disabled');
  h.updater.check(); h.timers[0].fn(); h.intervals[0].fn();
  assert.equal(h.calls.require, 1); assert.equal(h.calls.check, 0);
});
