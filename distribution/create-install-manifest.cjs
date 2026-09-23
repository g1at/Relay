#!/usr/bin/env node
'use strict';

// Offline release tooling. Input is the raw GitHub Releases REST JSON, saved
// locally after publication; this script never downloads or publishes files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_REPOSITORY = 'g1at/Relay';
const LEGACY_REPOSITORY = 'g1at/relay-updates';
const USAGE = `Usage:
  node distribution/create-install-manifest.cjs --release-json <release.json> --installer <Relay-X.Y.Z-Setup.exe> --output <manifest.json> [--repository g1at/Relay|g1at/relay-updates] [--close-running-app-guard]

The release JSON must contain the GitHub REST fields tag_name, html_url,
draft, prerelease, published_at, and assets with name, state, size, digest,
and browser_download_url. Only published stable releases are accepted.
The default repository is g1at/Relay. Explicit --repository g1at/relay-updates
is supported only for legacy versions through 3.0.2. Both release and installer
URLs must belong to the selected repository.

Generate releases/vX.Y.Z.json first, then update latest.json after checking it.
The installer guard is false unless --close-running-app-guard is explicitly
specified for an installer built with that protection. Metadata cannot enable it.
No network requests or remote publication are performed.
`;

function validateRepository(repository) {
  if (repository !== DEFAULT_REPOSITORY && repository !== LEGACY_REPOSITORY) {
    throw new Error('Repository must be g1at/Relay or g1at/relay-updates.');
  }
  return repository;
}

function validateReleaseMetadata(release, { repository = DEFAULT_REPOSITORY } = {}) {
  validateRepository(repository);
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Release JSON must be an object from the GitHub Releases REST API.');
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error('Release must explicitly be published and stable: draft=false and prerelease=false.');
  }
  if (typeof release.published_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(release.published_at)
    || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('Release must have a valid published_at timestamp.');
  }
  const match = typeof release.tag_name === 'string'
    && /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name);
  if (!match) throw new Error('Release tag must be a stable vX.Y.Z version.');
  const version = match[1], tag = release.tag_name;
  if (repository === LEGACY_REPOSITORY) {
    const [major, minor, patch] = version.split('.').map(value => BigInt(value));
    if (major > 3n || major === 3n && (minor > 0n || patch > 2n)) {
      throw new Error('Legacy repository g1at/relay-updates supports versions through 3.0.2 only.');
    }
  }
  const repositoryUrl = `https://github.com/${repository}`;
  if (release.html_url !== `${repositoryUrl}/releases/tag/${tag}`) {
    throw new Error(`Release URL must belong to the expected ${repository} tag.`);
  }
  const name = `Relay-${version}-Setup.exe`;
  const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset && asset.name === name) : [];
  if (assets.length !== 1) throw new Error(`Release must contain exactly one ${name} asset.`);
  const asset = assets[0], url = `${repositoryUrl}/releases/download/${tag}/${name}`;
  if (asset.state !== 'uploaded') throw new Error('Installer asset must have state=uploaded.');
  if (asset.browser_download_url !== url) throw new Error('Installer download URL does not match the official release asset.');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('Installer asset size must be a positive safe integer.');
  const digest = typeof asset.digest === 'string' && /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest);
  if (!digest) throw new Error('Installer asset must include a SHA-256 digest.');
  return { version, tag, name, url, size: asset.size, sha256: digest[1].toLowerCase() };
}

async function createInstallManifest({ release, installerPath, closeRunningAppGuard = false, repository = DEFAULT_REPOSITORY }) {
  if (typeof closeRunningAppGuard !== 'boolean') throw new Error('Installer guard must be an explicit boolean.');
  const expected = validateReleaseMetadata(release, { repository });
  if (typeof installerPath !== 'string' || path.basename(installerPath) !== expected.name) {
    throw new Error(`Local installer must be named ${expected.name}.`);
  }
  const handle = await fs.open(installerPath, 'r');
  let sha256;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Local installer must be a regular file.');
    if (before.size !== expected.size) throw new Error('Local installer size does not match the release asset.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== expected.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Local installer changed while calculating SHA-256.');
    }
    sha256 = hash.digest('hex');
    if (sha256 !== expected.sha256) throw new Error('Local installer SHA-256 does not match the release asset.');
  } finally {
    await handle.close();
  }
  return {
    schemaVersion: 1, version: expected.version, tag: expected.tag, platform: 'win32', arch: 'x64',
    installer: { name: expected.name, url: expected.url, size: expected.size, sha256, closeRunningAppGuard },
  };
}

function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = { closeRunningAppGuard: false, repository: DEFAULT_REPOSITORY };
  const flags = new Map([['--release-json', 'releaseJson'], ['--installer', 'installerPath'], ['--output', 'outputPath'], ['--repository', 'repository']]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--close-running-app-guard') { options.closeRunningAppGuard = true; continue; }
    const key = flags.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    options[key] = value;
  }
  for (const [flag, key] of flags) if (!options[key]) throw new Error(`Required option missing: ${flag}`);
  validateRepository(options.repository);
  return options;
}

async function resolveExisting(file) {
  try { return await fs.realpath(file); }
  catch (error) { if (error.code === 'ENOENT') return path.resolve(file); throw error; }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { process.stdout.write(USAGE); return; }
  const outputPath = await resolveExisting(options.outputPath);
  for (const input of [options.releaseJson, options.installerPath]) {
    if (outputPath === await resolveExisting(input)) throw new Error('Output must not overwrite the release JSON or installer.');
  }
  const json = await fs.readFile(options.releaseJson, 'utf8');
  const release = JSON.parse(json.replace(/^\uFEFF/, ''));
  const manifest = await createInstallManifest({ ...options, release });
  // Validate everything before replacing output, so a bad new release leaves
  // an existing manifest usable. Rename also avoids publishing partial JSON.
  const destination = path.resolve(options.outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  process.stdout.write(`Created ${destination} for Relay ${manifest.version}.\n`);
  return manifest;
}

module.exports = { createInstallManifest, validateReleaseMetadata, parseArguments, main };
if (require.main === module) main().catch(error => {
  process.stderr.write(`Cannot create install manifest: ${error.message}\n`);
  process.exitCode = 1;
});
