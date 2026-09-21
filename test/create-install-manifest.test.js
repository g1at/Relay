'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createInstallManifest, validateReleaseMetadata, parseArguments } = require('../distribution/create-install-manifest.cjs');
const cli = path.resolve(__dirname, '../distribution/create-install-manifest.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-install-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('MZ\x00Relay installer fixture; never execute this file.');
  const name = 'Relay-3.0.0-Setup.exe', installerPath = path.join(directory, name);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const release = {
    tag_name: 'v3.0.0', draft: false, prerelease: false, published_at: '2026-09-15T04:24:16Z',
    html_url: 'https://github.com/g1at/relay-updates/releases/tag/v3.0.0',
    assets: [{ name, state: 'uploaded', size: content.length, digest: 'sha256:' + sha256,
      browser_download_url: 'https://github.com/g1at/relay-updates/releases/download/v3.0.0/' + name }],
  };
  const releaseJson = path.join(directory, 'release.json'), outputPath = path.join(directory, 'releases', 'v3.0.0.json');
  await fs.writeFile(installerPath, content);
  await fs.writeFile(releaseJson, JSON.stringify(release));
  return { directory, content, sha256, release, installerPath, releaseJson, outputPath };
}

function runCli(f, extra = []) {
  return spawnSync(process.execPath, [cli, '--release-json', f.releaseJson, '--installer', f.installerPath, '--output', f.outputPath, ...extra], { encoding: 'utf8' });
}

test('verified local bytes produce the complete win32 x64 schema with guard disabled', async t => {
  const f = await fixture(t);
  f.release.closeRunningAppGuard = true;
  f.release.assets[0].closeRunningAppGuard = true;
  assert.deepEqual(await createInstallManifest(f), {
    schemaVersion: 1, version: '3.0.0', tag: 'v3.0.0', platform: 'win32', arch: 'x64',
    installer: { name: 'Relay-3.0.0-Setup.exe', url: f.release.assets[0].browser_download_url,
      size: f.content.length, sha256: f.sha256, closeRunningAppGuard: false },
  });
});

test('rejects draft, prerelease, missing status, and unconfirmed publication', async t => {
  const f = await fixture(t);
  for (const patch of [{ draft: true }, { draft: undefined }, { draft: 'false' }, { prerelease: true },
    { prerelease: undefined }, { prerelease: 0 }, { published_at: null }, { published_at: 'invalid' }]) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, ...patch }), /published|stable|published_at/);
  }
});

test('rejects noncanonical tags and URLs outside the exact official release', async t => {
  const f = await fixture(t);
  for (const tag_name of ['3.0.0', 'v3.0.0-beta', 'v03.0.0', 'v3.0.0/other', 'v3.0.0?x']) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, tag_name }), /tag/);
  }
  for (const html_url of [f.release.html_url.replace('g1at', 'other'), f.release.html_url + '?x=1',
    f.release.html_url.replace('v3.0.0', 'v2.1.0'), f.release.html_url.replace('https:', 'http:')]) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, html_url }), /Release URL/);
  }
  for (const browser_download_url of [f.release.assets[0].browser_download_url.replace('g1at', 'other'),
    f.release.assets[0].browser_download_url + '?x=1', 'https://github.com.evil.invalid/g1at/relay-updates/installer.exe']) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, assets: [{ ...f.release.assets[0], browser_download_url }] }), /download URL/);
  }
});

test('requires one complete installer asset and SHA-256 metadata', async t => {
  const f = await fixture(t), asset = f.release.assets[0];
  for (const assets of [[], undefined, [asset, asset], [{ ...asset, name: 'Relay-2.1.0-Setup.exe' }]]) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, assets }), /exactly one/);
  }
  for (const patch of [{ state: 'new' }, { state: undefined }, { size: 0 }, { size: -1 }, { size: '50' },
    { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { digest: null }, { digest: 'sha512:' + f.sha256 }, { digest: 'sha256:bad' }]) {
    assert.throws(() => validateReleaseMetadata({ ...f.release, assets: [{ ...asset, ...patch }] }), /state|size|SHA-256/);
  }
});

test('rejects a wrong filename, truncated file, and same-size corrupted installer', async t => {
  const f = await fixture(t);
  await assert.rejects(createInstallManifest({ ...f, installerPath: path.join(f.directory, 'other.exe') }), /must be named/);
  await fs.writeFile(f.installerPath, f.content.subarray(1));
  await assert.rejects(createInstallManifest(f), /size/);
  await fs.writeFile(f.installerPath, Buffer.alloc(f.content.length, 42));
  await assert.rejects(createInstallManifest(f), /SHA-256/);
});

test('a directory named like the installer is never accepted', async t => {
  const f = await fixture(t);
  await fs.unlink(f.installerPath);
  await fs.mkdir(f.installerPath);
  await assert.rejects(createInstallManifest(f), /regular file|EISDIR|EACCES|EPERM/);
});

test('CLI writes only the requested manifest and the guard requires its explicit flag', async t => {
  const f = await fixture(t);
  f.release.closeRunningAppGuard = true;
  f.release.assets[0].closeRunningAppGuard = true;
  await fs.writeFile(f.releaseJson, '\uFEFF' + JSON.stringify(f.release));
  let result = runCli(f);
  assert.equal(result.status, 0, result.stderr);
  let manifest = JSON.parse(await fs.readFile(f.outputPath, 'utf8'));
  assert.equal(manifest.installer.closeRunningAppGuard, false);
  assert.deepEqual(await fs.readdir(path.dirname(f.outputPath)), ['v3.0.0.json']);
  await assert.rejects(fs.stat(path.join(f.directory, 'latest.json')), { code: 'ENOENT' });
  result = runCli(f, ['--close-running-app-guard']);
  assert.equal(result.status, 0, result.stderr);
  manifest = JSON.parse(await fs.readFile(f.outputPath, 'utf8'));
  assert.equal(manifest.installer.closeRunningAppGuard, true);
});

test('CLI verification failure preserves an existing manifest and leaves no temporary output', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.outputPath));
  const previous = '{"keep":"previous verified release"}\n';
  await fs.writeFile(f.outputPath, previous);
  await fs.writeFile(f.installerPath, Buffer.alloc(f.content.length, 42));
  const result = runCli(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(await fs.readFile(f.outputPath, 'utf8'), previous);
  assert.deepEqual(await fs.readdir(path.dirname(f.outputPath)), ['v3.0.0.json']);
});

test('CLI never overwrites input files or accepts incomplete or ambiguous arguments', async t => {
  const f = await fixture(t);
  for (const outputPath of [f.releaseJson, f.installerPath]) {
    const before = await fs.readFile(outputPath), result = runCli({ ...f, outputPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not overwrite/);
    assert.deepEqual(await fs.readFile(outputPath), before);
  }
  for (const args of [[], ['--release-json'], ['--release-json', '--installer'], ['--unknown'],
    ['--output', 'a', '--output', 'b'], ['--close-running-app-guard=true'], ['--close-running-app-guard', '--close-running-app-guard']]) {
    assert.throws(() => parseArguments(args), /option|value/i);
  }
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--release-json/);
});
