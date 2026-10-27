'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderStore } = require('../src/main/providers/provider-store');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`synthetic-only:${value}`),
  decryptString: value => value.toString().replace(/^synthetic-only:/, ''),
};
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-persistence-'));
  t.after(() => { t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  const store = new ProviderStore({ userDataDir: dir, safeStorage, logger: { warn: (...args) => logs.push(args) } });
  const profile = store.createProfile({ name: 'Original', apiKey: 'synthetic-original-key',
    baseUrl: 'https://provider.invalid', models: { sonnet: 'original-model' } }).profile;
  return { dir, store, profile, logs, file: store.paths().profiles, vault: store.paths().secrets };
}
function storageError(code) { return Object.assign(new Error(`${code}: synthetic filesystem failure`), { code }); }
function denyRename(t, file, code = 'EPERM') {
  const original = fs.renameSync;
  return t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file) throw storageError(code);
    return original(source, target);
  });
}
function noTemps(dir) { assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp-')), []); }
function originalKey(f) { return f.store.vault.get(f.store.readState().profiles[0].credentialRef); }
for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`${code} replacing a profile preserves committed bytes, credentials and a usable backup`, t => {
    const f = setup(t), before = fs.readFileSync(f.file), vault = fs.readFileSync(f.vault);
    denyRename(t, f.file, code);
    assert.throws(() => f.store.updateProfile(f.profile.id, { name: 'Unsaved' }), error => {
      assert.equal(error.code, 'PROVIDER_STORAGE_WRITE_FAILED');
      assert.equal(error.storageCode, code); assert.equal(error.retryable, true);
      assert.equal(error.cause.code, code); return true;
    });
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
    assert.deepEqual(fs.readFileSync(f.vault), vault);
    assert.equal(f.store.getProfile(f.profile.id).name, 'Original');
    assert.equal(originalKey(f), 'synthetic-original-key');
    assert.equal(f.logs.length, 1); assert.equal(f.logs[0][1], f.file); noTemps(f.dir);
  });
}
test('partial temporary write / disk full preserves primary and backup and removes partial data', t => {
  const f = setup(t), before = fs.readFileSync(f.file), backup = fs.readFileSync(f.file + '.bak');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (typeof target === 'number') { write(target, '{"partial":'); throw storageError('ENOSPC'); }
    return write(target, ...args);
  });
  assert.throws(() => f.store.updateProfile(f.profile.id, { name: 'Unsaved' }), error =>
    error.code === 'PROVIDER_STORAGE_WRITE_FAILED' && error.storageCode === 'ENOSPC' && !error.retryable);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), backup); noTemps(f.dir);
});
test('failure before creating a temporary file is classified without changing configuration', t => {
  const f = setup(t), before = fs.readFileSync(f.file);
  t.mock.method(fs, 'mkdirSync', () => { throw storageError('EACCES'); });
  assert.throws(() => f.store.updateProfile(f.profile.id, { name: 'Unsaved' }), error =>
    error.code === 'PROVIDER_STORAGE_WRITE_FAILED' && error.storageCode === 'EACCES');
  assert.deepEqual(fs.readFileSync(f.file), before); noTemps(f.dir);
});
test('a corrupt primary never overwrites the last valid recovery copy on failed save', t => {
  const f = setup(t), before = fs.readFileSync(f.file);
  fs.copyFileSync(f.file, f.file + '.bak'); fs.writeFileSync(f.file, '{broken'); denyRename(t, f.file);
  assert.throws(() => f.store.updateProfile(f.profile.id, { name: 'Unsaved' }), { code: 'PROVIDER_STORAGE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
  assert.equal(f.store.getProfile(f.profile.id).name, 'Original');
  assert.equal(originalKey(f), 'synthetic-original-key'); noTemps(f.dir);
});
test('partial backup copy and failed replacement leave the previous backup intact', t => {
  const f = setup(t), before = fs.readFileSync(f.file), backup = fs.readFileSync(f.file + '.bak');
  t.mock.method(fs, 'copyFileSync', (_source, target) => { fs.writeFileSync(target, '{partial'); throw storageError('ENOSPC'); });
  denyRename(t, f.file);
  assert.throws(() => f.store.updateProfile(f.profile.id, { name: 'Unsaved' }), { code: 'PROVIDER_STORAGE_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(f.file + '.bak'), backup); noTemps(f.dir);
});
test('failed key rotation keeps the old key and config; a later save commits the same draft', t => {
  const f = setup(t), before = fs.readFileSync(f.file), oldRecords = f.store.vault.readState().records;
  denyRename(t, f.file);
  const draft = { name: 'Saved later', apiKey: 'synthetic-replacement-key', models: { sonnet: 'new-model' } };
  assert.throws(() => f.store.updateProfile(f.profile.id, draft), { code: 'PROVIDER_STORAGE_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(f.store.vault.readState().records, oldRecords);
  assert.equal(originalKey(f), 'synthetic-original-key'); noTemps(f.dir);
  t.mock.restoreAll(); const result = f.store.updateProfile(f.profile.id, draft);
  assert.equal(result.profile.name, draft.name); assert.equal(result.profile.models.sonnet, 'new-model');
  assert.equal(originalKey(f), draft.apiKey);
  assert.equal(Object.keys(f.store.vault.readState().records).length, 1); noTemps(f.dir);
});
test('failed vault replacement preserves both old encrypted records and provider configuration', t => {
  const f = setup(t), before = fs.readFileSync(f.file), vault = fs.readFileSync(f.vault); denyRename(t, f.vault);
  assert.throws(() => f.store.updateProfile(f.profile.id, { apiKey: 'synthetic-replacement-key' }), { code: 'PROVIDER_STORAGE_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readFileSync(f.vault), vault);
  assert.equal(originalKey(f), 'synthetic-original-key'); noTemps(f.dir);
});
test('failed provider creation removes only its new credential and keeps all existing data', t => {
  const f = setup(t), before = fs.readFileSync(f.file), records = f.store.vault.readState().records; denyRename(t, f.file);
  assert.throws(() => f.store.createProfile({ name: 'Unsaved new', apiKey: 'synthetic-new-key',
    baseUrl: 'https://new.invalid', models: { haiku: 'new-model' } }), { code: 'PROVIDER_STORAGE_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(f.store.vault.readState().records, records); noTemps(f.dir);
});

test('credential rollback failure cannot hide validation errors or replace the old usable key', t => {
  const f = setup(t), before = fs.readFileSync(f.file);
  t.mock.method(f.store.vault, 'delete', () => { throw Object.assign(storageError('EPERM'), {
    code: 'PROVIDER_STORAGE_WRITE_FAILED', storageCode: 'EPERM', retryable: true,
  }); });
  assert.throws(() => f.store.updateProfile(f.profile.id, { apiKey: 'synthetic-new-key',
    mediaModels: [{ modelId: 'invalid', protocol: 'not-a-supported-protocol' }] }), error => {
    assert.equal(error.code, undefined); assert.match(error.message, /选择支持的协议/); return true;
  });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(originalKey(f), 'synthetic-original-key'); noTemps(f.dir);
});
