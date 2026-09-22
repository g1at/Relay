'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createBrowserFormStore } = require('../src/main/browser/browser-form-store');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-forms-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), changed = [];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  const filePath = path.join(root, 'browser', 'forms.enc.json');
  const fresh = () => createBrowserFormStore({ filePath, safeStorage, onChanged: event => changed.push(event) });
  return { filePath, safeStorage, changed, fresh, store: fresh() };
}
const sample = { origin: 'https://example.test/login', username: 'synthetic-user', password: 'Synthetic secret for isolated tests only' };

test('password and contact files contain only an encrypted envelope, including all metadata', async t => {
  const f = await fixture(t);
  const saved = await f.store.invoke({ action: 'passwords.save', ...sample }); assert.equal(saved.ok, true); assert.equal(Object.hasOwn(saved.item, 'password'), false);
  assert.equal((await f.store.invoke({ action: 'contacts.save', name: 'Synthetic Person', email: 'person@example.test', phone: '000-0000', address: 'Synthetic Road' })).ok, true);
  const raw = await fs.readFile(f.filePath, 'utf8'), envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'version']);
  assert.equal([sample.password, sample.username, 'example.test', 'Synthetic Person', 'Synthetic Road'].some(value => raw.includes(value)), false);
  assert.equal((await f.fresh().invoke({ action: 'passwords.list' })).items.length, 1);
  assert.equal((await f.fresh().invoke({ action: 'contacts.list' })).items[0].name, 'Synthetic Person');
});

test('password lists and origin matching never reveal a password and match exact origin only', async t => {
  const f = await fixture(t); await f.store.invoke({ action: 'passwords.save', ...sample });
  await f.store.invoke({ action: 'passwords.save', ...sample, origin: 'https://example.test:444' });
  for (const action of ['passwords.list', 'passwords.forOrigin']) {
    const response = await f.store.invoke({ action, origin: 'https://example.test/other' });
    assert.equal(response.ok, true); assert.equal(response.items.some(item => Object.hasOwn(item, 'password')), false);
    assert.equal(response.items.length, action.endsWith('list') ? 2 : 1);
  }
  assert.equal((await f.store.invoke({ action: 'passwords.forOrigin', origin: 'http://example.test' })).items.length, 0);
  assert.equal((await f.store.invoke({ action: 'passwords.forOrigin', origin: 'https://sub.example.test' })).items.length, 0);
});

test('explicit reveal requires an existing record and optional origin cannot cross sites', async t => {
  const f = await fixture(t); const saved = await f.store.invoke({ action: 'passwords.save', ...sample });
  const recordId = saved.item.recordId;
  const revealed = await f.store.invoke({ action: 'passwords.reveal', recordId, origin: 'https://example.test/page' });
  assert.equal(revealed.ok, true); assert.ok(revealed.password === sample.password);
  assert.equal((await f.store.invoke({ action: 'passwords.reveal', recordId, origin: 'https://other.test' })).code, 'ORIGIN_MISMATCH');
  assert.equal((await f.store.invoke({ action: 'passwords.reveal', recordId: 'missing' })).code, 'RECORD_NOT_FOUND');
});

test('unavailable encryption and basic_text never read or create a plaintext fallback', async t => {
  const f = await fixture(t); f.safeStorage.isEncryptionAvailable = () => false;
  for (const action of ['passwords.list', 'passwords.save', 'contacts.save']) {
    const result = await f.store.invoke({ action, ...sample, name: 'Sample' }); assert.equal(result.code, 'ENCRYPTION_UNAVAILABLE'); assert.match(result.error, /不会以明文/);
  }
  await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
  f.safeStorage.isEncryptionAvailable = () => true; f.safeStorage.getSelectedStorageBackend = () => 'basic_text';
  assert.equal((await f.store.invoke({ action: 'passwords.save', ...sample })).code, 'ENCRYPTION_UNAVAILABLE');
  await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
});

test('failed encryption or unreadable prior data preserves the existing encrypted file', async t => {
  const f = await fixture(t); await f.store.invoke({ action: 'passwords.save', ...sample });
  const previous = await fs.readFile(f.filePath);
  f.safeStorage.encryptString = () => { throw Error('Synthetic native failure'); };
  assert.equal((await f.store.invoke({ action: 'contacts.save', name: 'Sample' })).code, 'ENCRYPTION_FAILED');
  assert.ok((await fs.readFile(f.filePath)).equals(previous));
  f.safeStorage.decryptString = () => { throw Error('Synthetic wrong system key'); };
  assert.equal((await f.store.invoke({ action: 'passwords.list' })).code, 'ENCRYPTED_DATA_UNREADABLE');
  assert.equal((await f.store.invoke({ action: 'contacts.save', name: 'Sample' })).code, 'ENCRYPTED_DATA_UNREADABLE');
  assert.ok((await fs.readFile(f.filePath)).equals(previous));
});

test('editing metadata preserves a password unless the user explicitly replaces it, and deletion survives restart', async t => {
  const f = await fixture(t); const saved = await f.store.invoke({ action: 'passwords.save', ...sample });
  const recordId = saved.item.recordId;
  const edited = await f.store.invoke({ action: 'passwords.save', recordId, origin: 'https://example.test', username: 'renamed' });
  assert.equal(edited.item.recordId, recordId); assert.ok((await f.store.invoke({ action: 'passwords.reveal', recordId })).password === sample.password);
  assert.equal((await f.store.invoke({ action: 'passwords.save', recordId, ...sample, password: '' })).code, 'INVALID_RECORD');
  assert.equal((await f.store.invoke({ action: 'passwords.delete', recordId })).ok, true);
  assert.equal((await f.fresh().invoke({ action: 'passwords.list' })).items.length, 0);
  assert.equal((await f.store.invoke({ action: 'passwords.delete', recordId })).code, 'RECORD_NOT_FOUND');
});

test('contact CRUD and concurrent saves do not lose records or permit arbitrary extra fields', async t => {
  const f = await fixture(t);
  const saved = await f.store.invoke({ action: 'contacts.save', name: 'One', password: 'must-not-be-stored' });
  assert.equal(saved.ok, true); assert.equal(Object.hasOwn(saved.item, 'password'), false);
  await f.store.invoke({ action: 'contacts.save', recordId: saved.item.recordId, name: 'Updated', email: 'test@example.test' });
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => f.store.invoke({ action: 'contacts.save', name: 'Contact ' + i })));
  assert.ok(results.every(value => value.ok)); assert.equal((await f.fresh().invoke({ action: 'contacts.list' })).items.length, 17);
  await f.store.invoke({ action: 'contacts.delete', recordId: saved.item.recordId });
  assert.equal((await f.fresh().invoke({ action: 'contacts.list' })).items.length, 16);
  assert.ok(f.changed.every(event => Object.keys(event).length === 1 && event.section === 'contacts'));
});

test('invalid URLs and records are rejected without creating files', async t => {
  const f = await fixture(t);
  for (const origin of ['javascript:alert(1)', 'file:///tmp/file', 'https://user:pass@example.test', 'about:blank', 'not a url']) {
    assert.equal((await f.store.invoke({ action: 'passwords.save', ...sample, origin })).ok, false);
  }
  assert.equal((await f.store.invoke({ action: 'contacts.save', address: 'Only address' })).code, 'INVALID_RECORD');
  assert.equal((await f.store.invoke({ action: 'passwords.save', ...sample, password: 'x'.repeat(4097) })).code, 'INVALID_RECORD');
  assert.equal((await f.store.invoke({ action: 'constructor' })).code, 'INVALID_ACTION');
  await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
});
