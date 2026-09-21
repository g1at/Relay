'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = source.indexOf('function loadConversation(id) {');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start);

function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-history-load-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const warnings = [];
  const context = {
    fs: options.fs || fs, path,
    app: { getPath: () => directory },
    convFilePath: id => path.join(directory, id + '.json'),
    recoverLegacyOutput: options.recover || (value => value),
    console: { warn: (...args) => warnings.push(args) },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { directory, warnings, load: context.loadConversation };
}

test('missing history is a quiet null and can be loaded after it is saved', t => {
  const h = harness(t);
  for (let i = 0; i < 5; i++) assert.equal(h.load('new-or-deleted'), null);
  assert.equal(h.warnings.length, 0);
  const record = { id: 'new-or-deleted', updatedAt: '2020-01-01T00:00:00Z', turns: [] };
  const file = path.join(h.directory, record.id + '.json');
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(JSON.stringify(h.load(record.id)), JSON.stringify(record));
  fs.unlinkSync(file);
  assert.equal(h.load(record.id), null);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(fs.readdirSync(h.directory), [], 'reads must not recreate deleted history');
});

test('corrupt history and real I/O errors still produce diagnostics', t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.directory, 'corrupt.json'), '{broken');
  assert.equal(h.load('corrupt'), null);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][2], 'corrupt');
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const failed = harness(t, { fs: { readFileSync() { throw Object.assign(new Error(code), { code }); } } });
    assert.equal(failed.load('unreadable'), null);
    assert.equal(failed.warnings.length, 1);
    assert.equal(failed.warnings[0][1], code);
  }
});

test('existing history still uses legacy output recovery without changing its activity time', t => {
  let recoveries = 0;
  const h = harness(t, { recover: (record, options) => {
    recoveries++;
    assert.equal(options.rootDir, path.join(h.directory, 'task-ledger'));
    return { ...record, recovered: true };
  } });
  const record = { id: 'existing', updatedAt: '2020-01-01T00:00:00Z' };
  const file = path.join(h.directory, 'existing.json');
  const raw = JSON.stringify(record);
  fs.writeFileSync(file, raw);
  const loaded = h.load('existing');
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.updatedAt, record.updatedAt);
  assert.equal(recoveries, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.equal(h.warnings.length, 0);
});
