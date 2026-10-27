'use strict';
// Real Windows sharing violations, using isolated temporary fixture files only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProviderStore } = require('../src/main/providers/provider-store');
const { retryProviderWrite } = require('../src/main/providers/provider-write-retry');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-winlock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProviderStore({ userDataDir: dir, logger: { warn() {} }, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('synthetic-only:' + value),
    decryptString: value => value.toString().replace(/^synthetic-only:/, ''),
  } });
  const profile = store.createProfile({ name: 'Original', apiKey: 'synthetic-key',
    baseUrl: 'https://fixture.invalid', models: { sonnet: 'synthetic-model' } }).profile;
  return { dir, store, profile, file: store.paths().profiles };
}
async function lockFile(t, file) {
  const script = "$ErrorActionPreference='Stop'; $stream=[System.IO.File]::Open($env:RELAY_PROVIDER_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, RELAY_PROVIDER_LOCK_FILE: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', released = false;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const release = async () => {
    if (released) return exited;
    released = true;
    if (child.exitCode === null) child.stdin.end('release\n');
    return exited;
  };
  t.after(release);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Lock fixture startup timed out: ' + stderr)); }, 10000);
    let stdout = '';
    child.stdout.on('data', text => { stdout += text; if (stdout.includes('LOCKED')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!stdout.includes('LOCKED')) reject(Error('Lock fixture exited ' + code + ': ' + stderr)); });
  });
  return release;
}
const windows = { skip: process.platform !== 'win32', timeout: 20000 };

test('Windows: releasing a real delete-denying handle allows a later bounded retry to commit', windows, async t => {
  const f = setup(t), before = fs.readFileSync(f.file);
  const release = await lockFile(t, f.file);
  let attempts = 0, responsive = false;
  const tick = setImmediate(() => { responsive = true; }); t.after(() => clearImmediate(tick));
  const timer = setTimeout(() => { void release(); }, 200); t.after(() => clearTimeout(timer));
  try {
    const result = await retryProviderWrite(() => { attempts += 1; return f.store.updateProfile(f.profile.id, { name: 'Saved after unlock' }); });
    assert.equal(result.profile.name, 'Saved after unlock');
    assert.ok(attempts > 1 && attempts <= 5);
    assert.equal(responsive, true, 'Backoff must yield the main event loop');
    assert.deepEqual(fs.readFileSync(f.file + '.bak'), before);
    assert.equal(f.store.getProfile(f.profile.id).name, 'Saved after unlock');
  } finally { await release(); }
});

test('Windows: persistent real lock stops after five attempts, preserving original; manual retry succeeds', windows, async t => {
  const f = setup(t), before = fs.readFileSync(f.file), vault = fs.readFileSync(f.store.paths().secrets);
  const release = await lockFile(t, f.file); let attempts = 0;
  try {
    await assert.rejects(retryProviderWrite(() => { attempts += 1; return f.store.updateProfile(f.profile.id, { name: 'Same draft' }); }), error => {
      assert.equal(error.code, 'PROVIDER_STORAGE_WRITE_FAILED'); assert.equal(error.attempts, 5);
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.storageCode)); return true;
    });
    assert.equal(attempts, 5); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readFileSync(f.store.paths().secrets), vault);
    assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.includes('.tmp-')), []);
  } finally { await release(); }
  const result = await retryProviderWrite(() => f.store.updateProfile(f.profile.id, { name: 'Same draft' }));
  assert.equal(result.profile.name, 'Same draft');
});
