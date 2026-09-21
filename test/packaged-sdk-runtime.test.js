'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { CancellationToken } = require('builder-util-runtime');
const { Platform } = require('app-builder-lib/out/core');
const { getMainFileMatchers, getNodeModuleFileMatcher, getFileMatchers } = require('app-builder-lib/out/fileMatcher');
const { computeFileSets, computeNodeModuleFileSets, getDestinationPath } = require('app-builder-lib/out/util/appFileCopier');
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil');
const verifySdkPackaging = require('../build/verify-sdk-packaging.cjs');
const { runtimePath } = require('../agent-environment');

const project = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const sdk = require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json');
const platformNames = Object.keys(sdk.optionalDependencies);
const wanted = ['@anthropic-ai/claude-agent-sdk-win32-x64', '@anthropic-ai/claude-agent-sdk-linux-x64'];
const binName = name => name.includes('-win32-') ? 'claude.exe' : 'claude';
const nativeBytes = name => name.includes('-win32-') ? Buffer.from('MZ-isolated-native-fixture') : Buffer.from('\x7fELF-isolated-native-fixture');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

function fixture(t, nested = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'relay', version: manifest.version, dependencies: manifest.dependencies }));
  write(path.join(root, 'main.js'), '// Packaging fixture only. Never launch this as an application.');
  const sdkDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  write(path.join(sdkDir, 'package.json'), JSON.stringify({ name: sdk.name, version: sdk.version }));
  write(path.join(sdkDir, 'sdk.mjs'), 'export const packagingFixture = true;');
  const conflicts = platformNames.map(name => {
    const dir = path.join(nested ? sdkDir : root, 'node_modules', name);
    const platform = name.includes('-win32-') ? 'win32' : name.includes('-linux-') ? 'linux' : 'darwin';
    const metadata = { name, version: sdk.version, os: [platform], cpu: [name.includes('arm64') ? 'arm64' : 'x64'] };
    write(path.join(dir, 'package.json'), JSON.stringify(metadata)); write(path.join(dir, binName(name)), nativeBytes(name));
    // The build preparation places the two supported binaries at fixed roots,
    // even if npm's collector reports optional dependencies under their parent.
    if (nested && wanted.includes(name)) {
      const prepared = path.join(root, 'node_modules', name);
      write(path.join(prepared, 'package.json'), JSON.stringify(metadata)); write(path.join(prepared, binName(name)), nativeBytes(name));
    }
    return { name, version: sdk.version, dir, optional: true };
  });
  const config = JSON.parse(JSON.stringify(manifest.build));
  const resources = path.join(root, 'fixture-output', 'resources'), destination = path.join(resources, 'app');
  const info = { appDir: root, projectDir: root, buildResourcesDir: path.join(root, 'build'), config,
    appInfo: { type: 'commonjs' }, debugLogger: { isEnabled: false }, cancellationToken: new CancellationToken(),
    getNodeDependencyInfo: () => ({ value: Promise.resolve([{ name: sdk.name, version: sdk.version, dir: sdkDir, conflictDependency: conflicts }]) }) };
  const packager = { info, config, platform: Platform.WINDOWS };
  const macro = value => value;
  const mainMatchers = getMainFileMatchers(root, destination, macro, config.win, packager, path.join(root, 'fixture-output'), false);
  const moduleMatcher = getNodeModuleFileMatcher(root, destination, macro, config.win, info);
  const [unpackMatcher] = getFileMatchers(config, 'asarUnpack', destination, { macroExpander: macro, customBuildOptions: config.win, globalOutDir: path.join(root, 'fixture-output'), defaultSrc: root });
  return { root, resources, destination, info, packager, mainMatchers, moduleMatcher, unpackMatcher,
    async collect() {
      const app = await computeFileSets(mainMatchers, null, packager, false);
      const modules = await computeNodeModuleFileSets(packager, moduleMatcher);
      // PlatformPackager removes empty dependency sets before AsarPackager.
      return [...app, ...modules].filter(set => set.files.length > 0);
    } };
}

for (const nested of [false, true]) test(`actual builder file collection keeps exactly two fixed runtime copies (${nested ? 'nested' : 'hoisted'} dependency sources)`, async t => {
  const f = fixture(t, nested);
  verifySdkPackaging({ packager: f.packager });
  const sets = await f.collect();
  const destinations = sets.flatMap(set => set.files.filter(file => set.metadata.get(file)?.isFile()).map(file => path.relative(f.destination, getDestinationPath(file, set)).replace(/\\/g, '/')));
  const binaries = destinations.filter(file => /\/claude(?:\.exe)?$/.test(file)).sort();
  assert.deepEqual(binaries, wanted.map(name => `node_modules/${name}/${binName(name)}`).sort());
  for (const name of platformNames.filter(name => !wanted.includes(name))) assert.equal(destinations.some(file => file.includes(name)), false, `${name} must not ship`);
  for (const name of wanted) {
    assert.ok(destinations.includes(`node_modules/${name}/package.json`));
    assert.equal(destinations.filter(file => file.endsWith(`/${name}/${binName(name)}`)).length, 1);
  }
});

test('real ASAR writer unpacks both runtimes at paths used by Windows and WSL without smart-unpack assistance', async t => {
  const f = fixture(t);
  const sets = await f.collect();
  // Disabling heuristics proves the explicit unpack rule is sufficient for ELF
  // binaries and relocated dependency sources, not just .exe auto-detection.
  await new AsarPackager(f.root, f.resources, { smartUnpack: false }, f.unpackMatcher.createFilter()).pack(sets, f.packager);
  const archive = path.join(f.resources, 'app.asar');
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, manifest.version);
  for (const name of wanted) {
    const relative = path.join('node_modules', name, binName(name));
    assert.equal(asar.statFile(archive, relative).unpacked, true);
    assert.deepEqual(fs.readFileSync(path.join(archive + '.unpacked', relative)), nativeBytes(name));
  }
  assert.equal(runtimePath(archive), path.join(archive + '.unpacked', 'node_modules', wanted[1], 'claude'));
  assert.equal(fs.existsSync(runtimePath(archive)), true);
  const context = nativeResolver(archive);
  assert.equal(context.resolve(), path.join(archive + '.unpacked', 'node_modules', wanted[0], 'claude.exe'));
});

test('standalone unpacked helpers can load their production dependencies without Electron ASAR support', async t => {
  const f = fixture(t);
  // WSL launches these helpers with ordinary Node. Every relative dependency
  // must exist outside ASAR; Electron's virtual filesystem cannot fill gaps.
  const helpers = manifest.build.asarUnpack.filter(file => !file.includes('*')
    && !file.startsWith('node_modules/') && /\.(?:c?js)$/.test(file));
  for (const file of helpers) write(path.join(f.root, file), fs.readFileSync(path.join(project, file)));
  await new AsarPackager(f.root, f.resources, { smartUnpack: false }, f.unpackMatcher.createFilter())
    .pack(await f.collect(), f.packager);
  const unpacked = path.join(f.resources, 'app.asar.unpacked');
  for (const file of ['sdk-settings-probe.cjs', 'sdk-session-history.js', 'usage-stats-service.js']) {
    const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1]);', path.join(unpacked, file)], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${file} failed to load outside ASAR: ${result.stderr || result.error || ''}`);
  }
});

test('packaged draft client resolves and runs the unpacked worker with its complete dependency set', async t => {
  const f = fixture(t);
  const files = ['skill-draft-client.js', 'skill-draft-worker.js', 'skill-draft-service.js', 'sdk-native-events.js'];
  for (const file of files) write(path.join(f.root, file), fs.readFileSync(path.join(project, file)));
  await new AsarPackager(f.root, f.resources, { smartUnpack: false }, f.unpackMatcher.createFilter())
    .pack(await f.collect(), f.packager);
  const archive = path.join(f.resources, 'app.asar');
  for (const file of files.slice(1)) {
    assert.equal(asar.statFile(archive, file).unpacked, true, file);
    assert.deepEqual(fs.readFileSync(path.join(archive + '.unpacked', file)), fs.readFileSync(path.join(project, file)));
  }
  // Load the actual packaged client with Electron's app.asar directory. The
  // Worker runs ordinary Node, so missing unpacked dependencies fail for real.
  const packagedModule = { exports: {} };
  const load = new Function('__dirname', 'require', 'module', asar.extractFile(archive, 'skill-draft-client.js').toString('utf8'));
  load(archive, require, packagedModule);
  const skillsDir = path.join(f.root, 'isolated-skills');
  const client = new packagedModule.exports.SkillDraftClient({ skillsDir, draftsDir: path.join(f.root, 'isolated-drafts') });
  try {
    assert.deepEqual(await client.list(), []);
    const stagingDir = path.join(f.root, 'isolated-staging');
    write(path.join(stagingDir, 'SKILL.md'), '---\nname: packaged-skill\ndescription: Synthetic packaged-worker test.\n---\n# Packaged worker\n');
    const draft = await client.createDraft({ skillName: 'packaged-skill', stagingDir });
    assert.equal(draft.canPublish, true);
    const published = await client.publish(draft.id);
    assert.equal(published.draft.status, 'published');
    assert.match(fs.readFileSync(path.join(skillsDir, 'packaged-skill', 'SKILL.md'), 'utf8'), /Packaged worker/);
    assert.equal((await client.listHistory('packaged-skill')).length, 1);
  } finally { await client.close(); }
});

function nativeResolver(directory) {
  const source = fs.readFileSync(path.join(project, 'claude-sdk.js'), 'utf8');
  const start = source.indexOf('const RUNTIME_PKG =');
  const end = source.indexOf('\nfunction buildOptions(', start);
  assert.ok(start >= 0 && end > start, 'native runtime resolver source boundaries must exist');
  const code = source.slice(start, end);
  const probes = [];
  const context = vm.createContext({ __dirname: directory, path, process: { platform: 'win32', arch: 'x64' }, console: { warn() {} },
    fs: { existsSync(file) { probes.push(file); return fs.existsSync(file); } } });
  vm.runInContext(code + '\nthis.resolve = bundledExecutable;', context);
  return { resolve: () => context.resolve(), probes };
}

for (const nested of [false, true]) test(`Windows resolver uses the real unpacked ${nested ? 'nested' : 'root'} binary, never an ASAR virtual path`, t => {
  const f = fixture(t), archive = path.join(f.resources, 'app.asar');
  const relative = path.join('node_modules', ...(nested ? ['@anthropic-ai', 'claude-agent-sdk', 'node_modules'] : []), wanted[0], 'claude.exe');
  const target = path.join(archive + '.unpacked', relative);
  write(target, nativeBytes(wanted[0]));
  const context = nativeResolver(archive);
  assert.equal(context.resolve(), target);
  assert.ok(context.probes.every(file => !file.includes('app.asar' + path.sep)));
});

test('beforePack rejects absent, wrong-version and malformed runtime sources instead of silently skipping them', t => {
  const f = fixture(t);
  const hook = require(path.join(project, manifest.build.beforePack));
  for (const name of wanted) {
    const directory = path.join(f.root, 'node_modules', name), executable = path.join(directory, binName(name));
    fs.renameSync(directory, directory + '.held');
    assert.throws(() => hook({ packager: f.packager }), /已停止打包/);
    fs.renameSync(directory + '.held', directory);
    const metadataFile = path.join(directory, 'package.json'), metadata = fs.readFileSync(metadataFile);
    write(metadataFile, JSON.stringify({ name, version: '0.0.0', os: [name.includes('win32') ? 'win32' : 'linux'], cpu: ['x64'] }));
    assert.throws(() => hook({ packager: f.packager }), /已停止打包/);
    write(metadataFile, metadata); write(executable, 'invalid');
    assert.throws(() => hook({ packager: f.packager }), /已停止打包/);
    write(executable, nativeBytes(name));
  }
  assert.doesNotThrow(() => hook({ packager: f.packager }));
});

test('runtime unpack patterns cover root and SDK-nested source layouts', t => {
  const f = fixture(t, true), filter = f.unpackMatcher.createFilter();
  for (const parent of [f.root, path.join(f.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')]) {
    for (const name of wanted) {
      const file = path.join(parent, 'node_modules', name, binName(name));
      assert.equal(filter(file, fs.statSync(file)), true);
    }
  }
});

test('xterm remains vendored for on-demand terminal loading while build tools stay out of runtime dependencies', () => {
  const lock = require('../package-lock.json');
  const index = fs.readFileSync(path.join(project, 'renderer/index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(project, 'renderer/workspace-panel.js'), 'utf8');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex');
  for (const name of ['@xterm/xterm', '@xterm/addon-fit']) {
    assert.equal(manifest.dependencies[name], undefined); assert.ok(manifest.devDependencies[name]);
    assert.equal(lock.packages['node_modules/' + name].dev, true);
  }
  for (const [file, source] of [['xterm.js', '@xterm/xterm/lib/xterm.js'], ['xterm.css', '@xterm/xterm/css/xterm.css'], ['xterm-addon-fit.js', '@xterm/addon-fit/lib/addon-fit.js']]) {
    assert.ok((file.endsWith('.css') ? index : panel).includes(`vendor/${file}`));
    if (file.endsWith('.js')) assert.ok(!index.includes(`src="vendor/${file}"`), 'terminal scripts stay off the chat startup path');
    assert.equal(hash('renderer/vendor/' + file), hash('node_modules/' + source));
  }
  for (const [file, source] of [['xterm-LICENSE', '@xterm/xterm/LICENSE'], ['xterm-addon-fit-LICENSE', '@xterm/addon-fit/LICENSE']]) assert.equal(hash('renderer/vendor/' + file), hash('node_modules/' + source));
  assert.ok(manifest.dependencies['@anthropic-ai/sdk']); assert.ok(sdk.peerDependencies['@anthropic-ai/sdk']);
});
