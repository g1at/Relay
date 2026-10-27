'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadCommonJs = require('./helpers/load-commonjs.cjs');
const { retryProviderWrite, providerWriteFailure, RETRY_DELAYS_MS } = require('../src/main/providers/provider-write-retry');

function storageError(code = 'EPERM') {
  return Object.assign(new Error('rename C:/private/profile.tmp -> C:/private/profile.json'), {
    code: 'PROVIDER_STORAGE_WRITE_FAILED', storageCode: code,
    retryable: ['EPERM', 'EACCES', 'EBUSY'].includes(code),
  });
}
for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`${code} storage failure retries with bounded backoff`, async () => {
    let attempts = 0;
    const waits = [];
    const result = await retryProviderWrite(() => {
      if (++attempts < 3) throw storageError(code);
      return { committed: true };
    }, { sleep: async ms => waits.push(ms) });
    assert.deepEqual(result, { committed: true });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [50, 150]);
  });
}
test('persistent storage failure stops after five attempts without exposing paths', async () => {
  let attempts = 0;
  const waits = [];
  await assert.rejects(retryProviderWrite(() => { attempts++; throw storageError(); }, { sleep: async ms => waits.push(ms) }), error => {
    const result = providerWriteFailure(error);
    assert.equal(result.code, 'PROVIDER_STORAGE_WRITE_FAILED');
    assert.equal(result.attempts, 5);
    assert.equal(result.retryable, true);
    assert.match(result.message, /未保存/);
    assert.equal(JSON.stringify(result).includes('private'), false);
    return true;
  });
  assert.equal(attempts, 5);
  assert.deepEqual(waits, RETRY_DELAYS_MS);
});
test('validation, untagged EPERM and permanent storage errors are not retried', async () => {
  for (const error of [new Error('请填写模型 ID'), Object.assign(new Error('network'), { code: 'EPERM' }), storageError('ENOSPC'), storageError('EIO')]) {
    let attempts = 0;
    const waits = [];
    await assert.rejects(retryProviderWrite(() => { attempts++; throw error; }, { sleep: async ms => waits.push(ms) }), caught => caught === error);
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
  }
});
test('default backoff yields the event loop', async () => {
  let attempts = 0, eventLoopRan = false;
  const timer = setImmediate(() => { eventLoopRan = true; });
  try {
    await retryProviderWrite(() => {
      if (++attempts === 1) throw storageError();
      assert.equal(eventLoopRan, true);
    });
  } finally { clearImmediate(timer); }
});
test('friendly errors distinguish permissions and disk space without raw details', () => {
  assert.match(providerWriteFailure(storageError('EACCES')).message, /权限/);
  assert.match(providerWriteFailure(storageError('EROFS')).message, /权限/);
  assert.match(providerWriteFailure(storageError('ENOSPC')).message, /空间不足/);
  assert.match(providerWriteFailure(storageError('EDQUOT')).message, /空间不足/);
  assert.match(providerWriteFailure(storageError('EBUSY')).message, /占用/);
  assert.deepEqual(providerWriteFailure(new Error('模型 ID 不合法')), { ok: false, message: '模型 ID 不合法' });
});

function context(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-write-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { reject: null, writes: 0, waits: [], notices: [], network: [], logs: [] };
  const injectedFs = { ...fs, renameSync(source, target) {
    if (target === path.join(dir, 'provider-profiles.json')) {
      state.writes++;
      const code = state.reject?.(source, target);
      if (code) throw Object.assign(new Error(`synthetic ${code} rename ${source} -> ${target}`), { code, syscall: 'rename', path: source, dest: target });
    }
    return fs.renameSync(source, target);
  } };
  const { ProviderStore } = loadCommonJs('src/main/providers/provider-store.js', { modules: { fs: injectedFs } });
  const store = new ProviderStore({ userDataDir: dir, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from('encrypted:' + value),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  }, logger: { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) } });
  store.ensureInitialized();
  const { profile } = store.createProfile({ name: 'Original', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-old-key', models: { haiku: 'fixture/chat' }, routeTiers: ['haiku'] });
  state.writes = 0;
  const handlers = {};
  const connectivity = {
    createProviderDraftRuntime: value => value,
    testProviderConnection: async () => { state.network.push('test'); return { ok: true, authMode: 'auth-token' }; },
    discoverProviderModels: async () => { state.network.push('discover'); return { ok: true, models: ['fixture/chat'], imageModels: [], modelCatalog: [], totalModels: 1, authMode: 'auth-token' }; },
    ...options.connectivity,
  };
  const { registerProviderIpc } = loadCommonJs('src/main/providers/provider-ipc.js', { modules: { './provider-connectivity': connectivity } });
  registerProviderIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, providerStore: store,
    publishProviderChange: (...args) => { state.notices.push(args); options.publish?.(...args); },
    writeRetrySleep: async ms => { state.waits.push(ms); await options.onWait?.(state, store); },
  });
  return { dir, state, store, profile, handlers };
}
const mediaModels = [{ modelId: 'fixture/video', protocol: 'ark-video', modality: 'video', enabled: true,
  capabilities: { operations: ['text_to_video'], parameters: { duration: { integer: true, min: 2, max: 8 } }, defaults: { duration: 4 }, references: { max: 0 } } }];
test('update IPC retries atomic rename then saves media and key, publishing once', async t => {
  const h = context(t);
  const original = fs.readFileSync(h.store.file, 'utf8');
  h.state.reject = () => h.state.writes <= 2 ? 'EPERM' : null;
  const result = await h.handlers['providers:update']({}, { id: h.profile.id, patch: { name: 'Saved', apiKey: 'synthetic-new-key', mediaModels } });
  assert.equal(result.ok, true);
  assert.equal(h.state.writes, 3);
  assert.deepEqual(h.state.waits, [50, 150]);
  assert.equal(h.state.notices.length, 1);
  assert.equal(h.store.getProfile(h.profile.id).name, 'Saved');
  assert.equal(h.store.getProfile(h.profile.id).mediaModels[0].modelId, 'fixture/video');
  assert.equal(h.store.getConnectionRuntime(h.profile.id).env.ANTHROPIC_API_KEY, 'synthetic-new-key');
  assert.equal(fs.readFileSync(h.store.file + '.bak', 'utf8'), original);
  assert.equal(fs.readdirSync(h.dir).some(file => file.includes('.tmp-')), false);
});
test('exhausted update preserves original bytes, key and input draft; later save succeeds', async t => {
  const h = context(t);
  const original = fs.readFileSync(h.store.file);
  const originalKey = h.store.getConnectionRuntime(h.profile.id).env.ANTHROPIC_API_KEY;
  const patch = { name: 'Retry draft', apiKey: 'synthetic-replacement-key', mediaModels };
  const draft = JSON.stringify(patch);
  h.state.reject = () => 'EPERM';
  const failed = await h.handlers['providers:update']({}, { id: h.profile.id, patch });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PROVIDER_STORAGE_WRITE_FAILED');
  assert.equal(failed.attempts, 5);
  assert.equal(h.state.writes, 5);
  assert.equal(h.state.notices.length, 0);
  assert.deepEqual(fs.readFileSync(h.store.file), original);
  assert.equal(h.store.getConnectionRuntime(h.profile.id).env.ANTHROPIC_API_KEY, originalKey);
  assert.equal(JSON.stringify(patch), draft);
  assert.equal(h.store.listProfiles().length, 1);
  assert.equal(fs.readdirSync(h.dir).some(file => file.includes('.tmp-')), false);
  h.state.reject = null;
  const saved = await h.handlers['providers:update']({}, { id: h.profile.id, patch });
  assert.equal(saved.ok, true);
  assert.equal(h.state.notices.length, 1);
  assert.equal(h.store.getProfile(h.profile.id).name, patch.name);
  assert.equal(h.store.getConnectionRuntime(h.profile.id).env.ANTHROPIC_API_KEY, patch.apiKey);
});
test('create retry never duplicates profiles and terminal failure never publishes success', async t => {
  const h = context(t);
  h.state.reject = () => h.state.writes <= 1 ? 'EBUSY' : null;
  const input = { name: 'New provider', baseUrl: 'https://new.invalid', apiKey: 'synthetic-key', models: { sonnet: 'new/chat' } };
  const result = await h.handlers['providers:create']({}, input);
  assert.equal(result.ok, true);
  assert.equal(h.store.listProfiles().length, 2);
  assert.equal(h.state.notices.length, 1);
  h.state.reject = () => 'ENOSPC';
  const failed = await h.handlers['providers:create']({}, { ...input, name: 'Never saved' });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 1);
  assert.match(failed.message, /空间不足/);
  assert.equal(h.store.listProfiles().length, 2);
  assert.equal(h.state.notices.length, 1);
});
test('notification failure does not replay or report failure after a committed save', async t => {
  const h = context(t, { publish: () => { throw new Error('synthetic notification failure'); } });
  const result = await h.handlers['providers:update']({}, { id: h.profile.id, patch: { name: 'Committed' } });
  assert.equal(result.ok, true);
  assert.equal(h.state.writes, 1);
  assert.equal(h.state.waits.length, 0);
  assert.equal(h.store.getProfile(h.profile.id).name, 'Committed');
});
test('queued saves remain ordered while a failed write backs off', async t => {
  let resume, sleeping;
  const reachedSleep = new Promise(resolve => { sleeping = resolve; });
  const h = context(t, { onWait: async () => { sleeping(); await new Promise(resolve => { resume = resolve; }); } });
  h.state.reject = () => h.state.writes === 1 ? 'EPERM' : null;
  const first = h.handlers['providers:update']({}, { id: h.profile.id, patch: { name: 'Earlier' } });
  await reachedSleep;
  const second = h.handlers['providers:update']({}, { id: h.profile.id, patch: { name: 'Latest' } });
  await Promise.resolve();
  assert.equal(h.state.writes, 1);
  resume();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(h.store.getProfile(h.profile.id).name, 'Latest');
  assert.equal(h.state.notices.length, 2);
});
for (const operation of ['test', 'discoverModels']) {
  test(`${operation} retries persistence without repeating its network request`, async t => {
    const h = context(t);
    h.state.reject = () => h.state.writes === 1 ? 'EPERM' : null;
    const result = await h.handlers['providers:' + operation]({}, h.profile.id);
    assert.equal(result.ok, true);
    assert.equal(h.state.network.length, 1);
    assert.deepEqual(h.state.waits, [50]);
    assert.equal(h.store.getProfile(h.profile.id).authMode, 'auth-token');
    assert.equal(h.state.notices.length, 1);
  });
  test(`${operation} rechecks revision after backoff before touching new credentials`, async t => {
    const h = context(t, { onWait: async (state, store) => {
      state.reject = null;
      store.updateProfile(h.profile.id, { apiKey: 'synthetic-newer-key', baseUrl: 'https://newer.invalid' });
    } });
    h.state.reject = () => h.state.writes === 1 ? 'EPERM' : null;
    const result = await h.handlers['providers:' + operation]({}, h.profile.id);
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.equal(h.state.network.length, 1);
    assert.equal(h.store.getProfile(h.profile.id).baseUrl, 'https://newer.invalid');
    assert.equal(h.store.getProfile(h.profile.id).authMode, 'api-key');
    assert.equal(h.state.notices.length, 0);
  });
}
test('directory follows its own auth revision and checks later write retries for unrelated edits', async t => {
  const h = context(t, { onWait: async (state, store) => {
    state.reject = null;
    store.updateProfile(h.profile.id, { baseUrl: 'https://changed.invalid' });
  } });
  h.state.reject = () => h.state.writes === 2 ? 'EPERM' : null;
  const result = await h.handlers['providers:discoverModels']({}, h.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(h.state.network.length, 1);
  assert.equal(h.store.getProfile(h.profile.id).baseUrl, 'https://changed.invalid');
  assert.equal(h.store.getProfile(h.profile.id).imageDiscovery.status, 'unknown');
  // The earlier auth commit still requires exactly one runtime notification.
  assert.equal(h.state.notices.length, 1);
});

test('directory IPC persists every untyped media candidate without changing model bindings', async t => {
  const candidates = [{ id: 'Same', ownedBy: 'first' }, { id: 'Same', ownedBy: 'second' }];
  const h = context(t, { connectivity: { discoverProviderModels: async () => ({
    ok: true, models: ['Same'], modelCatalog: [candidates[0]], mediaModels: [], mediaCandidates: candidates,
  }) } });
  h.store.updateProfile(h.profile.id, { mediaModels });
  const before = h.store.getProfile(h.profile.id).mediaModels;
  const result = await h.handlers['providers:discoverModels']({}, h.profile.id);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.profile.mediaCatalog, item => [item.id, item.ownedBy]), [['Same', 'first'], ['Same', 'second']]);
  assert.deepEqual(h.store.getProfile(h.profile.id).mediaModels, before);
  assert.deepEqual(h.store.getProfile(h.profile.id).mediaCatalog, result.profile.mediaCatalog);
});
