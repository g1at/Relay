'use strict';

// Exercise the installed electron-updater implementation and Relay's actual
// wrapper. Only HTTP and the Electron app adapter are replaced; no installers
// are downloaded, launched, or written into a real user profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const manifest = require('../package.json');
const source = fs.readFileSync(path.join(__dirname, '../src/main/app/updater.js'), 'utf8');

function client(t, { current, repository, latest, unavailable = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feed-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'app-update.yml');
  fs.writeFileSync(configPath, yaml.dump({
    ...manifest.build.publish, repo: repository, updaterCacheDirName: 'relay-updater',
  }));
  const engine = new NsisUpdater(null, {
    version: current, isPackaged: true, appUpdateConfigPath: configPath,
    userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
    quit() { assert.fail('Checking for a migration update must never quit the app'); },
    onQuit() { assert.fail('Checking for a migration update must never schedule installation'); },
  });
  engine._testOnlyOptions = { platform: 'win32' };
  const requests = [];
  const filename = `Relay-${latest}-Setup.exe`;
  const root = `/g1at/${repository}/releases`;
  const sha512 = Buffer.alloc(64, 42).toString('base64');
  engine.httpExecutor = {
    async request(options) {
      assert.equal(options.hostname, 'github.com');
      requests.push(options.path);
      if (unavailable) throw new Error('Synthetic new repository unavailable');
      if (options.path === `${root}.atom`) return '<feed xmlns="http://www.w3.org/2005/Atom"><entry>'
        + `<title>Relay ${latest}</title><link href="https://github.com${root}/tag/v${latest}"/>`
        + '<content>Isolated migration fixture</content></entry></feed>';
      if (options.path === `${root}/latest`) return JSON.stringify({ tag_name: `v${latest}` });
      if (options.path === `${root}/download/v${latest}/latest.yml`) return yaml.dump({
        version: latest, path: filename, sha512,
        files: [{ url: filename, sha512, size: 128 }],
        releaseDate: '2026-09-21T00:00:00.000Z',
      });
      assert.fail(`Unexpected update request: ${options.path}`);
    },
    download() { assert.fail('Migration checks must preserve manual downloads'); },
  };
  const quiet = { info() {}, log() {}, warn() {}, error() {} };
  const context = vm.createContext({
    module: { exports: {} }, process: { env: {} }, console: quiet,
    require(name) { assert.equal(name, 'electron-updater'); return { autoUpdater: engine }; },
    setTimeout() {}, setInterval() {},
    setImmediate() { assert.fail('Migration checks must not schedule application exit'); },
  });
  vm.runInContext(source, context, { filename: 'updater.js' });
  const relay = context.module.exports;
  relay.init({ isPackaged: true, appVersion: current,
    getMainWindow: () => null,
    markQuitting() { assert.fail('Checking for updates must not start shutdown'); },
    notify() { assert.fail('No installer has been downloaded'); },
  });
  return { engine, relay, requests, async check() {
    relay.check();
    const promise = engine.checkForUpdatesPromise;
    assert.ok(promise, 'the production wrapper must start the actual updater');
    return promise;
  } };
}

test('a legacy client discovers the final bridge release without automatically downloading it', async t => {
  const h = client(t, { current: '3.0.0', repository: 'relay-updates', latest: '3.0.1' });
  const result = await h.check();
  assert.equal(result.isUpdateAvailable, true);
  assert.equal(h.relay.getStatus().latest, '3.0.1');
  assert.equal(h.relay.getStatus().state, 'available');
  assert.equal(result.downloadPromise, null);
  assert.equal(h.engine.autoDownload, false);
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  const provider = await h.engine.clientPromise;
  assert.equal(provider.resolveFiles(result.updateInfo)[0].url.href,
    'https://github.com/g1at/relay-updates/releases/download/v3.0.1/Relay-3.0.1-Setup.exe');
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(value => value.startsWith('/g1at/relay-updates/releases')));
});

test('the installed bridge loads the new feed from disk and finds future releases only in Relay', async t => {
  assert.equal(manifest.build.publish.owner, 'g1at');
  assert.equal(manifest.build.publish.repo, 'Relay');
  const h = client(t, { current: '3.0.1', repository: manifest.build.publish.repo, latest: '3.0.2' });
  const result = await h.check();
  assert.equal(result.isUpdateAvailable, true);
  assert.equal(h.relay.getStatus().latest, '3.0.2');
  assert.equal(result.downloadPromise, null);
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  const provider = await h.engine.clientPromise;
  assert.equal(provider.resolveFiles(result.updateInfo)[0].url.href,
    'https://github.com/g1at/Relay/releases/download/v3.0.2/Relay-3.0.2-Setup.exe');
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(value => value.startsWith('/g1at/Relay/releases')));
});

test('an unavailable new feed reports the failure instead of falling back to the retired repository', async t => {
  const h = client(t, { current: '3.0.1', repository: manifest.build.publish.repo,
    latest: '3.0.2', unavailable: true });
  await assert.rejects(h.check(), /Synthetic new repository unavailable/);
  assert.equal(h.relay.getStatus().state, 'error');
  assert.ok(h.requests.length > 0);
  assert.ok(h.requests.every(value => value.startsWith('/g1at/Relay/releases')));
});
