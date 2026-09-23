'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const rules = require('../build/release-policy.cjs');
const release = require('../build/release.cjs');
const SOURCE_COMMIT = '1a'.repeat(20);

async function fixture(t, version = '3.0.1') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-release-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version, build: { publish: rules.UPDATE_FEED } }));
  await fs.mkdir(path.join(root, 'distribution'));
  const installerScript = '# Synthetic new-channel installer\n# https://raw.githubusercontent.com/g1at/Relay/main/distribution/latest.json\n';
  await fs.writeFile(path.join(root, 'distribution/install.ps1'), installerScript);
  return { root, version, installerScript };
}

async function buildFiles(directory, version, { feed = rules.UPDATE_FEED } = {}) {
  const file = `Relay-${version}-Setup.exe`, bytes = Buffer.from(`MZ Synthetic installer ${version}; never execute.`);
  await fs.mkdir(path.join(directory, 'win-unpacked/resources'), { recursive: true });
  await fs.writeFile(path.join(directory, release.FEED_PATH), yaml.dump(feed));
  await fs.writeFile(path.join(directory, file), bytes);
  await fs.writeFile(path.join(directory, file + '.blockmap'), 'Synthetic blockmap, never use for installation.');
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  await fs.writeFile(path.join(directory, 'latest.yml'), yaml.dump({ version,
    files: [{ url: file, sha512, size: bytes.length }], path: file, sha512 }));
}

async function prepared(t, version = '3.0.1') {
  const f = await fixture(t, version), calls = [];
  const result = await release.prepareRelease({ root: f.root, run: async (command, args) => {
    calls.push({ command, args });
    if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT + '\n' : '';
    const output = args.find(arg => arg.startsWith('--config.directories.output='));
    if (output) await buildFiles(output.slice('--config.directories.output='.length), version);
    return '';
  } });
  return { ...f, ...result, buildCalls: calls };
}

function fakeGithub(f, options = {}) {
  const calls = [], releases = new Map();
  const run = async (command, args, runOptions = {}) => {
    calls.push({ command, args: [...args], options: runOptions });
    assert.equal(command, 'gh');
    if (options.before) await options.before(args, { calls, releases });
    if (args[0] === 'api') {
      const endpoint = args[1], match = /^repos\/(g1at\/(?:Relay|relay-updates))(.*)$/.exec(endpoint);
      assert.ok(match, endpoint);
      const [, repository, suffix] = match;
      if (!suffix) return JSON.stringify(options.metadata?.[repository] || {
        full_name: repository, private: false, visibility: 'public', archived: false, disabled: false });
      if (suffix.startsWith('/commits/')) return JSON.stringify({ sha: options.commit || SOURCE_COMMIT });
      if (suffix.startsWith('/releases?')) {
        const items = [...(options.existing?.[repository] || [])];
        if (releases.has(repository)) {
          const data = structuredClone(releases.get(repository));
          if (options.remoteRelease) options.remoteRelease(data, repository);
          items.push(data);
        }
        return JSON.stringify([items]);
      }
      if (suffix.startsWith('/git/matching-refs/')) return JSON.stringify([options.refs?.[repository] || []]);
      if (suffix.startsWith('/releases/tags/')) {
        assert.ok(releases.has(repository), `Release was never created: ${repository}`);
        const data = structuredClone(releases.get(repository));
        if (options.remoteRelease) options.remoteRelease(data, repository);
        return JSON.stringify(data);
      }
      assert.fail(endpoint);
    }
    const repository = args[args.indexOf('--repo') + 1];
    if (args[1] === 'create') {
      assert.equal(releases.has(repository), false, 'Never overwrite a release');
      assert.ok(args.includes('--draft')); assert.ok(!args.includes('--clobber'));
      const assets = [];
      for (const file of args.slice(3, args.indexOf('--repo'))) {
        const bytes = await fs.readFile(file), name = path.basename(file);
        assets.push({ name, state: 'uploaded', size: bytes.length,
          digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
          browser_download_url: `https://github.com/${repository}/releases/download/${f.plan.tag}/${name}` });
      }
      releases.set(repository, { tag_name: f.plan.tag, draft: true, prerelease: false, published_at: null,
        html_url: `https://github.com/${repository}/releases/tag/${f.plan.tag}`, assets });
      return '';
    }
    if (args[1] === 'edit') {
      assert.ok(releases.has(repository)); assert.ok(args.includes('--draft=false'));
      Object.assign(releases.get(repository), { draft: false, published_at: '2026-09-21T12:00:00Z' });
      return '';
    }
    assert.fail(args.join(' '));
  };
  return { run, calls, releases, writes: () => calls.filter(call => call.args[0] === 'release') };
}

test('both immutable 3.0.1 migration and 3.0.2 repair migration target both repositories; later versions target Relay', () => {
  assert.deepEqual(rules.releasePolicy('3.0.1').repositories, ['g1at/Relay', 'g1at/relay-updates']);
  assert.deepEqual(rules.releasePolicy('3.0.2').repositories, ['g1at/Relay', 'g1at/relay-updates']);
  for (const version of ['3.0.3', '3.1.0', '4.0.0', '10.0.0']) {
    assert.deepEqual(rules.releasePolicy(version).repositories, ['g1at/Relay']);
  }
  for (const version of ['2.1.0', '3.0.0', '03.0.1', '3.0.1-beta.1', '3.0.1+build', 'v3.0.1', '9007199254740992.0.0']) {
    assert.throws(() => rules.releasePolicy(version), /version|immutable|range/i);
  }
});

test('client feed accepts only the new public GitHub target without secrets or alternate endpoints', () => {
  assert.doesNotThrow(() => rules.assertUpdateFeed({ ...rules.UPDATE_FEED, updaterCacheDirName: 'relay-updater' }));
  for (const feed of [null, [rules.UPDATE_FEED], { ...rules.UPDATE_FEED, repo: 'relay-updates' },
    { ...rules.UPDATE_FEED, provider: 'generic' }, { ...rules.UPDATE_FEED, host: 'example.com' },
    { ...rules.UPDATE_FEED, private: true }, { ...rules.UPDATE_FEED, token: 'synthetic' },
    { ...rules.UPDATE_FEED, requestHeaders: {} }]) assert.throws(() => rules.assertUpdateFeed(feed), /feed/);
});

test('preflight rejects existing drafts/tags and compares every stable version numerically', () => {
  const policy = rules.releasePolicy('3.0.2');
  assert.throws(() => rules.assertNewRelease(policy, 'g1at/Relay', [{ tag_name: policy.tag, draft: true }], []), /already exists/);
  assert.throws(() => rules.assertNewRelease(policy, 'g1at/Relay', [], [{ ref: `refs/tags/${policy.tag}` }]), /already exists/);
  assert.throws(() => rules.assertNewRelease(policy, 'g1at/Relay', [{ tag_name: 'v3.0.10', draft: false, prerelease: false }], []), /newer/);
  assert.doesNotThrow(() => rules.assertNewRelease(policy, 'g1at/Relay', [{ tag_name: 'v3.0.1', draft: false, prerelease: false }], []));
  assert.throws(() => rules.assertNewRelease(policy, 'g1at/unknown', [], []), /invalid repository/);
});

test('default preparation uses publish never, checks the feed, and never invokes gh', async t => {
  const f = await prepared(t);
  assert.equal(f.buildCalls.length, 7);
  assert.ok(f.buildCalls.every(call => [process.execPath, 'git'].includes(call.command)));
  const builderIndex = f.buildCalls.findIndex(call => call.args.includes('--publish'));
  const runtimeIndex = f.buildCalls.findIndex(call => call.args[0] === path.join(f.root, 'ensure-sdk-linux-runtime.js'));
  assert.ok(runtimeIndex >= 0 && runtimeIndex < builderIndex, 'prepare the packaged Linux SDK runtime before invoking electron-builder');
  const args = f.buildCalls[builderIndex].args;
  assert.equal(args[args.indexOf('--publish') + 1], 'never');
  assert.ok(args.includes('--x64')); assert.ok(args.includes('nsis'));
  assert.equal(args.includes('--config.npmRebuild=false'), false, 'the normal build retains native rebuilding');
  assert.ok(f.directory.startsWith(path.join(f.root, 'dist', 'release-3.0.1-')));
  assert.deepEqual(await release.loadVerifiedBundle(f.directory), f.plan);
  assert.equal(f.plan.sourceCommit, SOURCE_COMMIT); assert.equal(f.plan.sourceDirty, false);
  assert.deepEqual(f.plan.artifacts.map(item => item.name), [
    'Relay-3.0.1-Setup.exe', 'Relay-3.0.1-Setup.exe.blockmap', 'latest.yml', 'SHA256SUMS.txt']);
});

test('old package publication configuration fails before building or launching anything', async t => {
  const f = await fixture(t); let calls = 0;
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ version: '3.0.1', build: {
    publish: { ...rules.UPDATE_FEED, repo: 'relay-updates' } } }));
  await assert.rejects(release.prepareRelease({ root: f.root, run: async () => { calls++; } }), /update feed/);
  assert.equal(calls, 0);
});

test('a builder that embeds the legacy feed cannot produce a publishable plan', async t => {
  const f = await fixture(t); let directory;
  await assert.rejects(release.prepareRelease({ root: f.root, run: async (command, args) => {
    if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT : '';
    const output = args.find(arg => arg.startsWith('--config.directories.output='));
    if (output) { directory = output.split('=').slice(1).join('=');
      await buildFiles(directory, f.version, { feed: { ...rules.UPDATE_FEED, repo: 'relay-updates' } }); }
  } }), /update feed/);
  await assert.rejects(fs.stat(path.join(directory, release.PLAN_FILE)), { code: 'ENOENT' });
});

test('latest.yml cannot substitute another version, installer URL, digest, or size', async t => {
  const f = await prepared(t), file = path.join(f.directory, 'latest.yml'), original = await fs.readFile(file, 'utf8');
  const data = yaml.load(original);
  for (const change of [d => { d.version = '3.0.0'; }, d => { d.path = 'https://example.com/installer.exe'; },
    d => { d.sha512 = 'wrong'; }, d => { d.files[0].url = '../installer.exe'; }, d => { d.files[0].size++; }]) {
    const changed = structuredClone(data); change(changed); await fs.writeFile(file, yaml.dump(changed));
    await assert.rejects(release.loadVerifiedBundle(f.directory), /latest.yml/);
  }
});

test('an edited installer, checksums, or repository plan is rejected before any GitHub call', async t => {
  for (const kind of ['installer', 'checksum', 'plan']) {
    const f = await prepared(t), github = fakeGithub(f);
    if (kind === 'installer') await fs.appendFile(path.join(f.directory, 'Relay-3.0.1-Setup.exe'), 'changed');
    if (kind === 'checksum') await fs.appendFile(path.join(f.directory, release.CHECKSUM_FILE), 'changed');
    if (kind === 'plan') await fs.writeFile(path.join(f.directory, release.PLAN_FILE), JSON.stringify({ ...f.plan, repositories: ['g1at/relay-updates'] }));
    await assert.rejects(release.publishRelease({ ...f, run: github.run }), /latest.yml|SHA256SUMS|plan/);
    assert.equal(github.calls.length, 0);
  }
});

test('private new source repository blocks publication before any remote mutation', async t => {
  const f = await prepared(t), github = fakeGithub(f, { metadata: {
    'g1at/Relay': { full_name: 'g1at/Relay', private: true, visibility: 'private' } } });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /PUBLIC/);
  assert.equal(github.calls.length, 1); assert.equal(github.writes().length, 0);
});

test('an unavailable or failed metadata request is fatal, never treated as release absence', async t => {
  const f = await prepared(t), github = fakeGithub(f, { before: async args => {
    if (args[1].includes('/releases?')) throw new Error('Synthetic HTTP 401 / unavailable API');
  } });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /401/);
  assert.equal(github.writes().length, 0);
});

test('a conflict in the second repository prevents creating a draft in either repository', async t => {
  const f = await prepared(t), github = fakeGithub(f, { existing: {
    'g1at/relay-updates': [{ tag_name: 'v3.0.1', draft: true, prerelease: false }] } });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /already exists/);
  assert.equal(github.writes().length, 0);
});

test('read-only preflight queries all targets without creating or editing a release', async t => {
  const f = await prepared(t), github = fakeGithub(f);
  await release.preflight(f.plan, { root: f.root, run: github.run });
  assert.equal(github.calls.length, 7); assert.equal(github.writes().length, 0);
});

test('migration publishes identical assets as drafts, verifies both, then promotes new before old', async t => {
  const f = await prepared(t), github = fakeGithub(f);
  const result = await release.publishRelease({ ...f, run: github.run });
  const writes = github.writes();
  assert.deepEqual(writes.map(call => [call.args[1], call.args[call.args.indexOf('--repo') + 1]]), [
    ['create', 'g1at/Relay'], ['create', 'g1at/relay-updates'], ['edit', 'g1at/Relay'], ['edit', 'g1at/relay-updates']]);
  assert.deepEqual(writes[0].args.slice(3, writes[0].args.indexOf('--repo')), writes[1].args.slice(3, writes[1].args.indexOf('--repo')));
  assert.equal(writes[0].options.timeoutMs, 30 * 60 * 1000);
  assert.equal(writes[1].options.timeoutMs, 30 * 60 * 1000);
  assert.equal(writes[0].args[writes[0].args.indexOf('--target') + 1], SOURCE_COMMIT);
  assert.equal(writes[1].args.includes('--target'), false);
  const firstEdit = github.calls.findIndex(call => call.args[1] === 'edit');
  const beforePublic = github.calls.slice(0, firstEdit);
  assert.equal(beforePublic.filter(call => call.args[0] === 'api' && call.args[1].includes('/releases?')).length, 4);
  assert.equal(beforePublic.filter(call => call.args[0] === 'api' && call.args[1].includes('/releases/tags/')).length, 0);
  const primary = path.join(result.materialRoot, 'g1at-Relay', 'distribution');
  const legacy = path.join(result.materialRoot, 'g1at-relay-updates');
  for (const [directory, repository] of [[primary, 'g1at/Relay'], [legacy, 'g1at/relay-updates']]) {
    const latest = JSON.parse(await fs.readFile(path.join(directory, 'latest.json'), 'utf8'));
    assert.equal(latest.installer.sha256, f.plan.artifacts[0].sha256);
    assert.equal(latest.installer.url, `https://github.com/${repository}/releases/download/v3.0.1/Relay-3.0.1-Setup.exe`);
    assert.equal(await fs.readFile(path.join(directory, 'install.ps1'), 'utf8'), f.installerScript);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'releases/v3.0.1.json'), 'utf8')), latest);
  }
  await assert.rejects(fs.stat(path.join(result.materialRoot, 'g1at-Relay/latest.json')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(legacy, 'README.md'), 'utf8'), /迁移版 \*\*3\.0\.1.*修复迁移版 \*\*3\.0\.2/);
  assert.match(await fs.readFile(path.join(result.materialRoot, 'NEXT-STEPS.md'), 'utf8'), /g1at-Relay\/distribution\//);
});

test('post-migration publication never queries or writes the legacy repository', async t => {
  const f = await prepared(t, '3.0.3'), github = fakeGithub(f);
  const result = await release.publishRelease({ ...f, run: github.run });
  assert.equal(github.writes().length, 2);
  assert.ok(github.calls.every(call => !call.args.some(arg => arg.includes('relay-updates'))));
  assert.deepEqual((await fs.readdir(result.materialRoot)).sort(), ['NEXT-STEPS.md', 'g1at-Relay']);
});

test('dirty source can be prepared locally but cannot pass publication preflight', async t => {
  const f = await fixture(t);
  const result = await release.prepareRelease({ root: f.root, run: async (command, args) => {
    if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT : ' M main.js\n';
    const output = args.find(arg => arg.startsWith('--config.directories.output='));
    if (output) await buildFiles(output.slice('--config.directories.output='.length), f.version);
    return '';
  } });
  assert.equal(result.plan.sourceDirty, true);
  const github = fakeGithub({ ...f, ...result });
  await assert.rejects(release.preflight(result.plan, { root: f.root, run: github.run }), /Commit the changes and rebuild/);
  await assert.rejects(release.publishRelease({ ...f, ...result, run: github.run }), /dirty/);
  assert.equal(github.calls.length, 0);
});

test('source changes during a build also prevent publication even if it was initially clean', async t => {
  const f = await fixture(t); let statusReads = 0;
  const result = await release.prepareRelease({ root: f.root, run: async (command, args) => {
    if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT : (++statusReads === 1 ? '' : ' M renderer/app.js\n');
    const output = args.find(arg => arg.startsWith('--config.directories.output='));
    if (output) await buildFiles(output.slice('--config.directories.output='.length), f.version);
    return '';
  } });
  assert.equal(result.plan.sourceDirty, true);
});

test('an unavailable source commit blocks every release write before creating a draft', async t => {
  const f = await prepared(t), github = fakeGithub(f, { commit: '2b'.repeat(20) });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /source commit/);
  assert.equal(github.writes().length, 0);
});

test('mismatched remote draft bytes prevent making either release public', async t => {
  const f = await prepared(t), github = fakeGithub(f, { remoteRelease: (data, repository) => {
    if (repository === 'g1at/relay-updates') data.assets[0].digest = 'sha256:' + '0'.repeat(64);
  } });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /uploaded asset/);
  assert.equal(github.writes().filter(call => call.args[1] === 'edit').length, 0);
  assert.ok([...github.releases.values()].every(data => data.draft));
});

test('a failed second upload leaves drafts for inspection and does not auto-delete or overwrite', async t => {
  const f = await prepared(t), github = fakeGithub(f, { before: async args => {
    if (args[1] === 'create' && args.includes('g1at/relay-updates')) throw new Error('Synthetic upload failure');
  } });
  await assert.rejects(release.publishRelease({ ...f, run: github.run }), /upload failure/);
  assert.equal(github.releases.get('g1at/Relay').draft, true);
  assert.ok(github.writes().every(call => call.args[1] === 'create' && !call.args.includes('--clobber')));
});

test('finalize only reads genuinely published releases and can regenerate static materials without publishing', async t => {
  const f = await prepared(t), github = fakeGithub(f);
  const first = await release.publishRelease({ ...f, run: github.run });
  await fs.rm(first.materialRoot, { recursive: true }); github.calls.length = 0;
  await release.finalizeRelease({ ...f, run: github.run });
  assert.equal(github.writes().length, 0); assert.equal(github.calls.length, 4);
  assert.ok((await fs.stat(path.join(first.materialRoot, 'g1at-Relay/distribution/latest.json'))).isFile());
});

test('finalize does not invent static release metadata when a target is still draft', async t => {
  const f = await prepared(t), github = fakeGithub(f);
  const result = await release.publishRelease({ ...f, run: github.run });
  await fs.rm(result.materialRoot, { recursive: true });
  github.releases.get('g1at/relay-updates').draft = true;
  await assert.rejects(release.finalizeRelease({ ...f, run: github.run }), /published stable/);
  await assert.rejects(fs.stat(result.materialRoot), { code: 'ENOENT' });
});

test('CLI requires an explicit verified-bundle path for publishing and offers read-only verification', () => {
  assert.deepEqual(release.parseArguments([]), { operation: 'prepare' });
  for (const option of ['--verify', '--check', '--publish', '--finalize']) {
    assert.equal(release.parseArguments([option, 'bundle']).operation, option.slice(2));
  }
  for (const args of [['--publish'], ['--publish', '--force'], ['--publish', 'bundle', '--clobber'], ['--legacy'], ['--unknown']]) {
    assert.throws(() => release.parseArguments(args), /Usage/);
  }
});


test('3.0.2 repair bridge verifies the new feed and publishes identical bytes to both sources without replacing 3.0.1', async t => {
  const f = await prepared(t, '3.0.2');
  assert.deepEqual(f.plan.repositories, ['g1at/Relay', 'g1at/relay-updates']);
  const previous = [{ tag_name: 'v3.0.1', draft: false, prerelease: false }];
  const github = fakeGithub(f, { existing: { 'g1at/Relay': previous, 'g1at/relay-updates': previous } });
  await release.publishRelease({ ...f, run: github.run });
  const writes = github.writes();
  assert.deepEqual(writes.map(call => call.args[1]), ['create', 'create', 'edit', 'edit']);
  assert.ok(writes.every(call => call.args[2] === 'v3.0.2' && !call.args.includes('--clobber')));
  const assets = [...github.releases.values()].map(item => item.assets.map(asset => [asset.name, asset.digest]));
  assert.deepEqual(assets[0], assets[1]);
  assert.match(await fs.readFile(path.join(f.directory, 'release-notes.md'), 'utf8'), /旧客户端.*手动下载.*完整 Setup/);
});

test('an existing 3.0.2 tag in either source blocks all publication writes', async t => {
  for (const repository of ['g1at/Relay', 'g1at/relay-updates']) {
    const f = await prepared(t, '3.0.2');
    const github = fakeGithub(f, { refs: { [repository]: [{ ref: 'refs/tags/v3.0.2' }] } });
    await assert.rejects(release.publishRelease({ ...f, run: github.run }), /already exists/);
    assert.equal(github.writes().length, 0);
  }
});


function nativeProbeSuccess(changes = {}) {
  return 'RELAY_NATIVE_RUNTIME_OK ' + JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64',
    electronVersion: require('electron/package.json').version, nodePtyVersion: '1.1.0', exitCode: 0, markerObserved: true,
    nativeFiles: [{ file: 'prebuilds/win32-x64/conpty.node', sha256: 'a'.repeat(64), matchesPrebuild: true }], ...changes }) + '\n';
}

test('explicit prebuilt mode runs real-Electron probe before skipping rebuild and isolates its entire profile', async t => {
  const f = await fixture(t, '3.0.2'), calls = [];
  let probeDirectory;
  const result = await release.prepareRelease({ root: f.root,
    env: { RELAY_USE_PREBUILT_NATIVE: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', NODE_PATH: 'untrusted' },
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT : '';
      if (args[0] === path.join(f.root, 'build/verify-native-runtime.cjs')) {
        assert.equal(command, require('electron'), 'probe must run Electron rather than Node');
        probeDirectory = options.env.RELAY_NATIVE_PROBE_ROOT;
        for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
          assert.ok(options.env[key].startsWith(probeDirectory + path.sep), key);
          assert.ok((await fs.stat(options.env[key])).isDirectory());
        }
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.NODE_PATH, undefined);
        assert.ok(args.some(arg => arg.startsWith('--user-data-dir=' + probeDirectory)));
        assert.equal(options.timeoutMs, 30000);
        return nativeProbeSuccess();
      }
      const output = args.find(arg => arg.startsWith('--config.directories.output='));
      if (output) {
        assert.ok(probeDirectory, 'probe must finish before building');
        assert.ok(args.includes('--config.npmRebuild=false'));
        await buildFiles(output.slice('--config.directories.output='.length), f.version);
      }
      return '';
    } });
  const probeIndex = calls.findIndex(call => call.command === require('electron'));
  const builderIndex = calls.findIndex(call => call.args.includes('--publish'));
  assert.ok(probeIndex >= 0 && probeIndex < builderIndex);
  await assert.rejects(fs.stat(probeDirectory), { code: 'ENOENT' });
  const evidence = JSON.parse(await fs.readFile(path.join(result.directory, 'native-runtime-verification.json'), 'utf8'));
  assert.equal(evidence.markerObserved, true); assert.equal(evidence.exitCode, 0);
  assert.equal((await release.loadVerifiedBundle(result.directory)).version, '3.0.2');
});

test('prebuilt mode aborts before builder on probe failure, wrong ABI, missing marker or unknown binary', async t => {
  for (const response of [new Error('Synthetic native load failed'), '',
    nativeProbeSuccess({ arch: 'arm64' }), nativeProbeSuccess({ nodePtyVersion: '1.0.0' }),
    nativeProbeSuccess({ electronVersion: '0.0.0' }), nativeProbeSuccess({ exitCode: 1 }),
    nativeProbeSuccess({ markerObserved: false }), nativeProbeSuccess({ nativeFiles: [] }),
    nativeProbeSuccess({ nativeFiles: [{ sha256: 'a'.repeat(64), matchesPrebuild: false }] })]) {
    const f = await fixture(t, '3.0.2'); let built = false, probeDirectory;
    await assert.rejects(release.prepareRelease({ root: f.root, env: { RELAY_USE_PREBUILT_NATIVE: '1' },
      run: async (command, args, options) => {
        if (command === 'git') return args[0] === 'rev-parse' ? SOURCE_COMMIT : '';
        if (command === require('electron')) {
          probeDirectory = options.env.RELAY_NATIVE_PROBE_ROOT;
          if (response instanceof Error) throw response;
          return response;
        }
        if (args.includes('--publish')) built = true;
        return '';
      } }), /native|verification/i);
    assert.equal(built, false, 'a failed probe must never reach a build with npmRebuild disabled');
    await assert.rejects(fs.stat(probeDirectory), { code: 'ENOENT' });
  }
});
