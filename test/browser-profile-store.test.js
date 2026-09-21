'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createBrowserProfileStore } = require('../browser-profile-store');
function temporary(t) { const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-profile-')); t.after(() => fs.rmSync(rootDir, { recursive: true, force: true })); return rootDir; }

test('settings, history, bookmarks and permission rules survive reopening an isolated browser profile', t => {
  const rootDir = temporary(t), store = createBrowserProfileStore({ rootDir, downloadDirectory: rootDir });
  store.updateSettings({ webLinkTarget: 'external', showFullUrl: true, searchEngine: 'duckduckgo' });
  const visit = store.visit({ url: 'https://example.test/page', title: 'Original' });
  store.visit({ id: visit.id, url: visit.url, title: 'Loaded title' });
  store.bookmark({ url: visit.url, title: 'Saved' }); store.bookmark({ url: visit.url, title: 'Updated' });
  store.setPermission({ origin: 'https://example.test/path', permission: 'camera', decision: 'block' });
  const reopened = createBrowserProfileStore({ rootDir });
  assert.equal(reopened.settings().webLinkTarget, 'external'); assert.equal(reopened.settings().showFullUrl, true);
  assert.equal(reopened.list('history').total, 1); assert.equal(reopened.list('history').items[0].title, 'Loaded title');
  assert.equal(reopened.list('history').items[0].visitedAt, visit.visitedAt);
  assert.equal(reopened.list('bookmarks').total, 1); assert.equal(reopened.list('bookmarks').items[0].title, 'Updated');
  assert.equal(reopened.permission('https://example.test', 'camera'), 'block');
  assert.equal(reopened.sessionPath, path.join(rootDir, 'session'));
});

test('search pagination applies to all matching history and returns the full filtered count', () => {
  let id = 0; const store = createBrowserProfileStore({ idFactory: () => String(++id) });
  for (let n = 0; n < 7; n++) store.visit({ url: 'https://example.test/' + n, title: n % 2 ? 'match' : 'other' });
  const result = store.list('history', { query: 'match', offset: 1, limit: 1 });
  assert.equal(result.total, 3); assert.equal(result.items.length, 1); assert.equal(result.items[0].url, 'https://example.test/3');
});

test('profile updates validate paths, schemes and known permissions without partially committing', t => {
  const store = createBrowserProfileStore({ rootDir: temporary(t) });
  for (const patch of [{ webLinkTarget: 'shell' }, { showFullUrl: 1 }, { searchEngine: 'custom' }, { downloadDirectory: '../relative' }, { secret: 'unknown' }]) assert.throws(() => store.updateSettings(patch));
  assert.throws(() => store.updateSettings({ webLinkTarget: 'external', searchEngine: 'bad' }));
  assert.equal(store.settings().webLinkTarget, 'internal');
  for (const url of ['file:///private', 'javascript:alert(1)', 'https://user:password@example.test/']) assert.throws(() => store.bookmark({ url }));
  assert.throws(() => store.setPermission({ origin: 'https://example.test', permission: 'shell', decision: 'allow' }));
  assert.equal(store.list('bookmarks').total, 0); assert.equal(store.list('permissions').total, 0);
});

test('clearing history and site rules never deletes bookmarks, downloaded files or download records', t => {
  const rootDir = temporary(t), store = createBrowserProfileStore({ rootDir }), file = path.join(rootDir, 'delivered.txt'); fs.writeFileSync(file, 'synthetic');
  store.visit({ url: 'https://example.test/' }); store.bookmark({ url: 'https://example.test/' });
  store.download({ id: 'one', url: 'https://example.test/file', filename: 'delivered.txt', path: file, state: 'completed' });
  store.setPermission({ origin: 'https://example.test', permission: 'location', decision: 'allow' });
  store.clear('history'); store.clear('permissions');
  assert.equal(store.list('history').total, 0); assert.equal(store.list('permissions').total, 0);
  assert.equal(store.list('bookmarks').total, 1); assert.equal(store.list('downloads').total, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic');
  store.remove('downloads', 'one'); assert.equal(fs.existsSync(file), true);
});

test('reopened in-flight downloads are accurately interrupted and never claim that resumable native jobs survived restart', t => {
  const rootDir = temporary(t), store = createBrowserProfileStore({ rootDir });
  store.download({ id: 'one', url: 'https://example.test/file', state: 'paused', receivedBytes: 23, totalBytes: 100, canResume: true });
  const reopened = createBrowserProfileStore({ rootDir });
  assert.equal(reopened.getDownload('one').state, 'interrupted'); assert.equal(reopened.getDownload('one').receivedBytes, 23); assert.equal(reopened.getDownload('one').canResume, false);
});

test('a malformed saved profile fails closed and preserves its original bytes', t => {
  const rootDir = temporary(t), file = path.join(rootDir, 'profile.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => createBrowserProfileStore({ rootDir }), { code: 'BROWSER_PROFILE_INVALID' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('failed writes leave the previous in-memory settings intact', t => {
  const rootDir = temporary(t), store = createBrowserProfileStore({ rootDir }); store.updateSettings({ searchEngine: 'google' });
  fs.unlinkSync(path.join(rootDir, 'profile.json')); fs.mkdirSync(path.join(rootDir, 'profile.json'));
  assert.throws(() => store.updateSettings({ searchEngine: 'bing' }), { code: 'BROWSER_PROFILE_WRITE_FAILED' });
  assert.equal(store.settings().searchEngine, 'google');
});
