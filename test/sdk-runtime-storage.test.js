'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSdkRuntimeStorage } = require('../src/main/sdk/sdk-runtime-storage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-storage-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return root;
}

test('runtime cache paths are lazy, deterministic and independent of the project cwd', t => {
  const root = fixture(t), dataDir = path.join(root, 'user data');
  const storage = createSdkRuntimeStorage({dataDir});
  assert.equal(fs.existsSync(dataDir), false);
  const dirs = storage.prepare();
  assert.equal(dirs.root, path.join(dataDir, 'sdk-runtime'));
  assert.equal(fs.statSync(dirs.tmpDir).isDirectory(), true);
  assert.equal(fs.statSync(dirs.cacheDir).isDirectory(), true);
  assert.deepEqual(createSdkRuntimeStorage({dataDir}).prepare(), dirs);
});

test('cache overlay preserves resource home, credentials and conversation scratch without mutation', t => {
  const storage = createSdkRuntimeStorage({dataDir:fixture(t)});
  const before = Object.freeze({CLAUDE_CONFIG_DIR:'existing-resources', HOME:'user-home', USERPROFILE:'native-home',
    TEMP:'conversation-scratch',TMP:'conversation-scratch',TMPDIR:'conversation-scratch',
    ANTHROPIC_AUTH_TOKEN:'synthetic-fixture',CLAUDE_CODE_TMPDIR:'inherited-cache',xdg_cache_home:'old-cache'});
  const after = storage.apply(before);
  for (const key of ['CLAUDE_CONFIG_DIR','HOME','USERPROFILE','TEMP','TMP','TMPDIR','ANTHROPIC_AUTH_TOKEN']) assert.equal(after[key], before[key]);
  assert.equal(after.CLAUDE_CODE_TMPDIR,storage.tmpDir);
  assert.equal(after.XDG_CACHE_HOME,storage.cacheDir);
  assert.equal(after.CLAUDE_CODE_DEBUG_LOGS_DIR,storage.debugDir);
  assert.equal(after.xdg_cache_home,undefined);
  assert.equal(before.CLAUDE_CODE_TMPDIR,'inherited-cache');
});

test('runtime preparation preserves existing cache and historical configuration files', t => {
  const dataDir = fixture(t), storage = createSdkRuntimeStorage({dataDir});
  storage.prepare();
  const artifact = path.join(storage.cacheDir,'keep.txt');fs.writeFileSync(artifact,'unchanged');
  const legacy = path.join(dataDir,'old-session.json');fs.writeFileSync(legacy,'historical');
  storage.apply({});storage.apply({});
  assert.equal(fs.readFileSync(artifact,'utf8'),'unchanged');
  assert.equal(fs.readFileSync(legacy,'utf8'),'historical');
});

test('runtime storage rejects relative, null-byte and missing data roots', () => {
  for(const dataDir of [undefined,'','relative','bad\0path']) assert.throws(()=>createSdkRuntimeStorage({dataDir}),/绝对路径/);
});

test('a symlink cannot redirect SDK runtime writes outside Relay data', t => {
  const root=fixture(t),dataDir=path.join(root,'relay'),outside=path.join(root,'outside');
  fs.mkdirSync(dataDir);fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(dataDir,'sdk-runtime'),process.platform==='win32'?'junction':'dir');
  const storage=createSdkRuntimeStorage({dataDir});
  assert.throws(()=>storage.prepare(),/不能链接/);
  assert.deepEqual(fs.readdirSync(outside),[]);
});
