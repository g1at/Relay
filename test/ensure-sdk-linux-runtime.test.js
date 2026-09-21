'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), tar = require('tar');
const { ensureRuntime, descriptor } = require('../ensure-sdk-linux-runtime');
const name = '@anthropic-ai/claude-agent-sdk-linux-x64', version = '0.3.266';
async function fixture(t, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-install-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), pkg = path.join(source, 'package'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version, os: ['linux'], cpu: ['x64'] }));
  fs.writeFileSync(path.join(pkg, 'claude'), Buffer.from([127, 69, 76, 70, 1, 2, 3, 4]));
  if (mutate) mutate(pkg);
  const archive = path.join(root, 'fixture.tgz'); await tar.c({ cwd: source, file: archive, gzip: true }, ['package']);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
  const lock = { packages: { 'node_modules/@anthropic-ai/claude-agent-sdk': { version, optionalDependencies: { [name]: version } }, ['node_modules/' + name]: { version, integrity, resolved: `https://registry.npmjs.org/${name}/-/claude-agent-sdk-linux-x64-${version}.tgz` } } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': version } }));
  const saveLock = () => fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock)); saveLock();
  const target = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64');
  let downloads = 0;
  return { rootDir: root, archive, lock, saveLock, target, downloads: () => downloads, async download(url, file) { downloads++; assert.equal(url, lock.packages['node_modules/' + name].resolved); fs.copyFileSync(archive, file); } };
}
test('pinned official archive installs locally and subsequent correct-version preparation stays offline', async t => {
  const f = await fixture(t); assert.deepEqual(await ensureRuntime(f), { version, changed: true });
  assert.equal(fs.readFileSync(path.join(f.target, 'claude'))[0], 127);
  assert.deepEqual(await ensureRuntime(f), { version, changed: false }); assert.equal(f.downloads(), 1);
  assert.equal(fs.readdirSync(path.dirname(f.target)).some(name => name.startsWith('.relay-linux-runtime-')), false);
});
test('integrity failure leaves the prior runtime intact', async t => {
  const f = await fixture(t); fs.mkdirSync(f.target, { recursive: true }); fs.writeFileSync(path.join(f.target, 'prior.txt'), 'keep');
  f.lock.packages['node_modules/' + name].integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); f.saveLock();
  await assert.rejects(ensureRuntime(f), /SHA-512/); assert.equal(fs.readFileSync(path.join(f.target, 'prior.txt'), 'utf8'), 'keep');
});
test('mismatched SDK locks and non-official download origins fail before network access', async t => {
  const f = await fixture(t); f.lock.packages['node_modules/' + name].version = '0.3.250'; f.saveLock();
  await assert.rejects(ensureRuntime(f), /版本不一致/); assert.equal(f.downloads(), 0);
  f.lock.packages['node_modules/' + name].version = version; f.lock.packages['node_modules/' + name].resolved = 'https://untrusted.invalid/runtime.tgz'; f.saveLock();
  assert.throws(() => descriptor(f.rootDir), /官方 npm/); assert.equal(f.downloads(), 0);
});
test('network failure stops packaging with a useful retry message and no partial installation', async t => {
  const f = await fixture(t); await assert.rejects(ensureRuntime({ ...f, async download() { throw Error('Synthetic offline'); } }), /已停止打包.*[\s\S]*prepare:sdk-runtime/);
  assert.equal(fs.existsSync(f.target), false);
});
test('archive symlinks are rejected even when their bytes match the lock integrity', async t => {
  const f = await fixture(t), header = Buffer.alloc(512);
  // Encode a malicious archive member directly; Windows need not grant symlink privileges.
  new tar.Header({ path: 'package/claude', type: 'SymbolicLink', linkpath: '../../outside', mode: 0o777, size: 0, mtime: new Date(0) }).encode(header);
  fs.writeFileSync(f.archive, require('node:zlib').gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
  f.lock.packages['node_modules/' + name].integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(f.archive)).digest('base64'); f.saveLock();
  await assert.rejects(ensureRuntime(f), /不安全|未知/); assert.equal(fs.existsSync(f.target), false);
});
test('wrong ELF type or package identity cannot be installed after integrity validation', async t => {
  const f = await fixture(t, pkg => fs.writeFileSync(path.join(pkg, 'claude'), 'Windows executable is not Linux'));
  await assert.rejects(ensureRuntime(f), /版本或文件类型/); assert.equal(fs.existsSync(f.target), false);
});
test('a redirected dependency directory cannot write outside the project', async t => {
  const f = await fixture(t), elsewhere = path.join(f.rootDir, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.rootDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureRuntime(f), /重定向/); assert.deepEqual(fs.readdirSync(elsewhere), []); assert.equal(f.downloads(), 0);
});
test('every distributable build prepares and unpacks the exact Linux runtime', () => {
  const pkg = require('../package.json');
  for (const script of ['build', 'build:dir', 'release']) {
    const steps = pkg.scripts[script].split('&&').map(step => step.trim());
    const preparation = steps.indexOf('npm run prepare:sdk-runtime');
    const packaging = steps.findIndex(step => step.startsWith('electron-builder '));
    assert.ok(preparation >= 0 && packaging > preparation, `${script} must prepare the runtime before packaging`);
  }
  const directory = 'node_modules/' + name;
  assert.ok(pkg.build.files.some(entry => entry && entry.from === directory && entry.to === directory && entry.filter.includes('**/*')));
  assert.ok(pkg.build.asarUnpack.includes('**/' + directory + '/**'));
});
