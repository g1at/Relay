'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppSettingsCache, MAX_CACHE_BYTES } = require('../src/main/app/app-settings-cache');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const counts = { read: 0, stat: 0 };
  const fileSystem = {
    statSync(...args) { counts.stat++; return fs.statSync(...args); },
    readFileSync(...args) { counts.read++; return fs.readFileSync(...args); },
  };
  const cache = createAppSettingsCache({ fileSystem });
  return { file, dir, counts, cache, fileSystem,
    write: value => fs.writeFileSync(file, JSON.stringify(value), 'utf8') };
}

test('unchanged reads stat each time but read and parse the JSON only once', t => {
  const h = fixture(t); h.write({ theme: 'light', nested: { list: [1, { selected: true }] } });
  for (let i = 0; i < 29; i++) assert.equal(h.cache.read(h.file).theme, 'light');
  assert.equal(h.counts.read, 1);
  assert.equal(h.counts.stat, 30, 'one stat per call and one validation stat after the initial read');
});

test('every returned object is a deep copy and a failed migration cannot contaminate disk state', t => {
  const h = fixture(t); h.write({ version: 0, imageApi: { key: 'synthetic', models: [{ id: 'old' }] } });
  const first = h.cache.read(h.file);
  first.version = 1; first.imageApi.models[0].id = 'new'; delete first.imageApi.key;
  const second = h.cache.read(h.file);
  assert.deepEqual(second, { version: 0, imageApi: { key: 'synthetic', models: [{ id: 'old' }] } });
  second.imageApi.models.push({ id: 'extra' });
  assert.equal(h.cache.read(h.file).imageApi.models.length, 1);
  assert.equal(h.counts.read, 1, 'a migration whose write fails is retried from raw disk data');
});

test('external atomic replacement is detected even when size and modification time match', t => {
  const h = fixture(t); h.write({ name: 'first' });
  assert.equal(h.cache.read(h.file).name, 'first');
  const previous = fs.statSync(h.file), tmp = path.join(h.dir, 'replacement.json');
  fs.writeFileSync(tmp, JSON.stringify({ name: 'other' }));
  fs.utimesSync(tmp, previous.atime, previous.mtime);
  fs.renameSync(tmp, h.file);
  assert.equal(h.cache.read(h.file).name, 'other'); assert.equal(h.counts.read, 2);
  assert.equal(h.cache.read(h.file).name, 'other'); assert.equal(h.counts.read, 2);
});

test('in-place edits are detected while explicit invalidation also forces a disk read', t => {
  const h = fixture(t); h.write({ theme: 'light' }); h.cache.read(h.file);
  const before = fs.statSync(h.file);
  h.write({ theme: 'night' });
  fs.utimesSync(h.file, before.atime, new Date(before.mtimeMs + 2000));
  assert.equal(h.cache.read(h.file).theme, 'night'); assert.equal(h.counts.read, 2);
  h.cache.invalidate(); assert.equal(h.cache.read(h.file).theme, 'night');
  assert.equal(h.counts.read, 3);
});

test('deletion and malformed JSON invalidate stale data and recover after a valid rewrite', t => {
  const h = fixture(t); h.write({ flag: true }); h.cache.read(h.file);
  fs.unlinkSync(h.file); assert.throws(() => h.cache.read(h.file), { code: 'ENOENT' });
  fs.writeFileSync(h.file, '{broken'); assert.throws(() => h.cache.read(h.file), SyntaxError);
  assert.throws(() => h.cache.read(h.file), SyntaxError, 'parse errors are not cached');
  h.write({ flag: false }); assert.equal(h.cache.read(h.file).flag, false);
  assert.equal(h.counts.read, 4);
  h.cache.read(h.file); assert.equal(h.counts.read, 4);
});

test('the cache retains at most one file', t => {
  const h = fixture(t), other = path.join(h.dir, 'other.json');
  h.write({ file: 1 }); fs.writeFileSync(other, JSON.stringify({ file: 2 }));
  assert.equal(h.cache.read(h.file).file, 1); assert.equal(h.cache.read(other).file, 2);
  assert.equal(h.cache.read(h.file).file, 1); assert.equal(h.counts.read, 3);
});

test('valid JSON above the byte limit remains readable without retaining its object', t => {
  const h = fixture(t);
  const large = { text: '中'.repeat(Math.ceil(MAX_CACHE_BYTES / 3)) };
  h.write(large); assert.ok(fs.statSync(h.file).size > MAX_CACHE_BYTES);
  assert.deepEqual(h.cache.read(h.file), large); assert.deepEqual(h.cache.read(h.file), large);
  assert.equal(h.counts.read, 2);
  h.write({ text: 'small' }); h.cache.read(h.file); h.cache.read(h.file);
  assert.equal(h.counts.read, 3, 'a later small configuration can be cached again');
});

test('a file changed during reading is returned as a snapshot but is not cached', t => {
  const h = fixture(t); h.write({ name: 'initial' });
  const read = h.fileSystem.readFileSync;
  let replace = true;
  h.fileSystem.readFileSync = (...args) => {
    const text = read(...args);
    if (replace) { replace = false; h.write({ name: 'a larger replacement' }); }
    return text;
  };
  assert.equal(h.cache.read(h.file).name, 'initial');
  assert.equal(h.cache.read(h.file).name, 'a larger replacement');
  assert.equal(h.counts.read, 2); h.cache.read(h.file); assert.equal(h.counts.read, 2);
});

test('ctime, inode, size and nanosecond mtime each invalidate an otherwise identical fingerprint', () => {
  let stats = { dev: 1n, ino: 1n, size: 2n, mtimeNs: 100n, ctimeNs: 100n };
  let reads = 0;
  const cache = createAppSettingsCache({ fileSystem: {
    statSync(_file, options) { assert.equal(options.bigint, true); return { ...stats }; },
    readFileSync() { reads++; return '{}'; },
  } });
  cache.read('synthetic.json'); cache.read('synthetic.json'); assert.equal(reads, 1);
  for (const key of ['ctimeNs', 'ino', 'size', 'mtimeNs', 'dev']) {
    stats = { ...stats, [key]: stats[key] + 1n };
    const count = reads; cache.read('synthetic.json'); cache.read('synthetic.json');
    assert.equal(reads, count + 1, `${key} alone must invalidate the cached settings`);
  }
});

test('a read error drops the cache even if the original fingerprint is restored', () => {
  let size = 2n, fail = false, reads = 0;
  const cache = createAppSettingsCache({ fileSystem: {
    statSync() { return { dev: 1n, ino: 1n, size, mtimeNs: 1n, ctimeNs: 1n }; },
    readFileSync() { reads++; if (fail) throw Object.assign(new Error('Synthetic denied read'), { code: 'EACCES' }); return '{}'; },
  } });
  cache.read('synthetic.json'); size = 3n; fail = true;
  assert.throws(() => cache.read('synthetic.json'), { code: 'EACCES' });
  size = 2n; fail = false; cache.read('synthetic.json'); assert.equal(reads, 3);
});
