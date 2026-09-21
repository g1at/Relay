#!/usr/bin/env node
'use strict';

// Building never publishes. Publishing accepts only a previously verified bundle.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const yaml = require('js-yaml');
const policyRules = require('./release-policy.cjs');
const { createInstallManifest } = require('../distribution/create-install-manifest.cjs');
const FEED_PATH = 'win-unpacked/resources/app-update.yml';
const PLAN_FILE = 'release-plan.json';
const CHECKSUM_FILE = 'SHA256SUMS.txt';

function runCommand(command, args, { cwd, inherit = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0;
    const timeout = inherit ? null : setTimeout(() => { child.kill(); reject(new Error(`${command} timed out; publication stopped.`)); }, timeoutMs);
    child.stdout?.on('data', value => { bytes += value.length; stdout += value;
      if (bytes > 16 * 1024 * 1024) { child.kill(); reject(new Error(`${command} response exceeded its limit.`)); } });
    child.stderr?.on('data', value => { stderr = (stderr + value).slice(-32768); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr.trim() || 'see command output'}`));
      else resolve(stdout);
    });
  });
}

async function fingerprint(file) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.size === 0) throw new Error(`Expected a nonempty regular release file: ${file}`);
  const sha256 = crypto.createHash('sha256'), sha512 = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; sha256.update(chunk); sha512.update(chunk); }
  const after = await fsp.lstat(file);
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`Release file changed while hashing: ${file}`);
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

async function inspectBundle(directory, version, { createChecksums = false } = {}) {
  const policy = policyRules.releasePolicy(version);
  const installer = `Relay-${version}-Setup.exe`;
  const feedBytes = await fsp.readFile(path.join(directory, FEED_PATH));
  policyRules.assertUpdateFeed(yaml.load(feedBytes.toString('utf8'), { schema: yaml.JSON_SCHEMA }));
  const names = [installer, `${installer}.blockmap`, 'latest.yml'];
  const artifacts = [];
  let installerHash;
  for (const name of names) {
    const hash = await fingerprint(path.join(directory, name));
    if (name === installer) installerHash = hash;
    artifacts.push({ name, size: hash.size, sha256: hash.sha256 });
  }
  const latest = yaml.load(await fsp.readFile(path.join(directory, 'latest.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (latest?.version !== version || latest.path !== installer || latest.sha512 !== installerHash.sha512
      || !Array.isArray(latest.files) || latest.files.length !== 1
      || latest.files[0]?.url !== installer || latest.files[0]?.sha512 !== installerHash.sha512
      || (latest.files[0].size !== undefined && latest.files[0].size !== installerHash.size)) {
    throw new Error('latest.yml does not identify the verified installer version, relative filename and SHA-512.');
  }
  const checksumText = artifacts.map(item => `${item.sha256}  ${item.name}\n`).join('');
  const checksumPath = path.join(directory, CHECKSUM_FILE);
  if (createChecksums) await fsp.writeFile(checksumPath, checksumText, { flag: 'wx' });
  if (await fsp.readFile(checksumPath, 'utf8') !== checksumText) throw new Error('SHA256SUMS.txt does not match the verified release files.');
  const checksumHash = await fingerprint(checksumPath);
  artifacts.push({ name: CHECKSUM_FILE, size: checksumHash.size, sha256: checksumHash.sha256 });
  return { schemaVersion: 1, ...policy, artifacts,
    embeddedFeed: { path: FEED_PATH, sha256: crypto.createHash('sha256').update(feedBytes).digest('hex') },
    // This capability is conservative until actual installer upgrade acceptance.
    closeRunningAppGuard: false };
}

async function loadVerifiedBundle(directory) {
  const plan = JSON.parse(await fsp.readFile(path.join(directory, PLAN_FILE), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(plan.sourceCommit || '') || typeof plan.sourceDirty !== 'boolean') {
    throw new Error('The release plan must record its Git source commit and dirty state.');
  }
  const actual = { ...await inspectBundle(directory, plan.version), sourceCommit: plan.sourceCommit, sourceDirty: plan.sourceDirty };
  if (JSON.stringify(plan) !== JSON.stringify(actual)) throw new Error('The release plan or its verified files have changed; prepare a new release bundle.');
  return actual;
}

function parseArguments(args) {
  if (args.length === 0) return { operation: 'prepare' };
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { operation: 'help' };
  if (args.length === 2 && ['--publish', '--verify', '--check', '--finalize'].includes(args[0]) && !args[1].startsWith('-')) {
    return { operation: args[0].slice(2), directory: path.resolve(args[1]) };
  }
  throw new Error('Usage: node build/release.cjs [--verify <bundle> | --check <bundle> | --publish <bundle> | --finalize <bundle>]');
}

async function prepareRelease({ root, run = runCommand } = {}) {
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const policy = policyRules.assertPackagePolicy(manifest);
  const sourceCommit = (await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Cannot identify the Git commit being built.');
  const beforeStatus = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  await run(process.execPath, [path.join(root, 'build/verify-installer-skin.cjs')], { cwd: root, inherit: true });
  await run(process.execPath, [path.join(root, 'ensure-sdk-linux-runtime.js')], { cwd: root, inherit: true });
  const dist = path.join(root, 'dist');
  await fsp.mkdir(dist, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(dist, `release-${policy.version}-`));
  await run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--win', 'nsis', '--x64',
    '--publish', 'never', `--config.directories.output=${directory}`], { cwd: root, inherit: true });
  const afterCommit = (await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })).trim();
  const afterStatus = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  const plan = { ...await inspectBundle(directory, policy.version, { createChecksums: true }), sourceCommit,
    sourceDirty: !!beforeStatus.trim() || !!afterStatus.trim() || afterCommit !== sourceCommit };
  await fsp.writeFile(path.join(directory, PLAN_FILE), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return { directory, plan };
}

async function ghJson(args, { root, run }) {
  const text = await run('gh', args, { cwd: root });
  try { return JSON.parse(text); }
  catch { throw new Error(`GitHub returned invalid JSON for ${args[1] || 'request'}; publication stopped.`); }
}

async function ghPages(endpoint, deps) {
  const pages = await ghJson(['api', endpoint, '--paginate', '--slurp'], deps);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('GitHub returned invalid paginated release metadata.');
  return pages.flat();
}

async function preflight(plan, deps) {
  if (plan.sourceDirty !== false || !/^[a-f0-9]{40}$/.test(plan.sourceCommit || '')) {
    throw new Error('The bundle was built from a dirty or unidentified source. Commit the changes and rebuild before publishing.');
  }
  // Finish all reads before any write. Authentication/network errors are fatal,
  // never interpreted as an absent repository, release, or tag.
  for (const repository of plan.repositories) {
    const metadata = await ghJson(['api', `repos/${repository}`], deps);
    policyRules.assertRemoteRepository(repository, metadata);
    if (repository === policyRules.PRIMARY_REPOSITORY) {
      const commit = await ghJson(['api', `repos/${repository}/commits/${plan.sourceCommit}`], deps);
      if (commit?.sha !== plan.sourceCommit) throw new Error('The source commit is not available in g1at/Relay; push the built commit before publication.');
    }
    const releases = await ghPages(`repos/${repository}/releases?per_page=100`, deps);
    const refs = await ghPages(`repos/${repository}/git/matching-refs/tags/${plan.tag}`, deps);
    policyRules.assertNewRelease(plan, repository, releases, refs);
  }
}

function migrationReadme(version) {
  return `# Relay 更新渠道已迁移\n\n正式源码、安装包和后续更新统一位于 [g1at/Relay](https://github.com/g1at/Relay)。\n\n` +
    `本仓库最后一个版本是 **${version}**。安装此版本后，应用内更新将改用新仓库；后续版本只发布到新仓库。` +
    `旧版本安装包和版本清单保留。\n\n` +
    `- [下载最新正式版](https://github.com/g1at/Relay/releases/latest)\n` +
    `- [命令行安装与升级说明](https://github.com/g1at/Relay#readme)\n\n` +
    `旧的一键安装地址继续提供兼容脚本，默认从新仓库获取最新正式版。\n`;
}

function assertReleaseAssets(plan, repository, release, { published }) {
  if (release?.draft !== !published || release.prerelease !== false || release.tag_name !== plan.tag) {
    throw new Error(`${repository} ${plan.tag} is not the expected ${published ? 'published stable release' : 'draft'}; publication stopped.`);
  }
  for (const artifact of plan.artifacts) {
    const assets = release.assets?.filter(asset => asset.name === artifact.name) || [];
    if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== artifact.size
        || assets[0].digest?.toLowerCase() !== `sha256:${artifact.sha256}`) {
      throw new Error(`${repository}: uploaded asset ${artifact.name} does not match the prepared bundle.`);
    }
  }
}

async function finalizeRelease({ root, directory, run = runCommand } = {}) {
  const plan = await loadVerifiedBundle(directory), deps = { root, run };
  const releases = [];
  // No local "published" metadata is invented: read every completed release.
  for (const repository of plan.repositories) {
    policyRules.assertRemoteRepository(repository, await ghJson(['api', `repos/${repository}`], deps));
    const release = await ghJson(['api', `repos/${repository}/releases/tags/${plan.tag}`], deps);
    assertReleaseAssets(plan, repository, release, { published: true });
    releases.push({ repository, release });
  }
  const materialRoot = path.join(directory, 'static-files');
  for (const { repository, release } of releases) {
    const manifest = await createInstallManifest({ release, installerPath: path.join(directory, `Relay-${plan.version}-Setup.exe`),
      repository, closeRunningAppGuard: plan.closeRunningAppGuard });
    const repositoryRoot = path.join(materialRoot, repository.replace('/', '-'));
    const target = repository === policyRules.PRIMARY_REPOSITORY ? path.join(repositoryRoot, 'distribution') : repositoryRoot;
    await fsp.mkdir(path.join(target, 'releases'), { recursive: true });
    const text = JSON.stringify(manifest, null, 2) + '\n';
    await fsp.writeFile(path.join(target, 'latest.json'), text);
    await fsp.writeFile(path.join(target, 'releases', `${plan.tag}.json`), text);
    await fsp.copyFile(path.join(root, 'distribution/install.ps1'), path.join(target, 'install.ps1'));
    if (repository === policyRules.LEGACY_REPOSITORY) await fsp.writeFile(path.join(target, 'README.md'), migrationReadme(plan.version));
    await fsp.writeFile(path.join(repositoryRoot, 'release-response.json'), JSON.stringify(release, null, 2) + '\n');
  }
  await fsp.writeFile(path.join(materialRoot, 'NEXT-STEPS.md'),
    '# 发布后静态文件提交\n\n发布渠道使用已核验的安装包；以下文件仍需维护者提交，发布器没有修改仓库内容。\n\n' +
    plan.repositories.map(repository => repository === policyRules.PRIMARY_REPOSITORY
      ? `- ${repository}：将 \`${repository.replace('/', '-')}/distribution/\` 中的 install.ps1、latest.json、releases/${plan.tag}.json 提交到仓库的 \`distribution/\` 目录，保留源码仓库原 README.md 和既有版本清单。`
      : `- ${repository}：将 \`${repository.replace('/', '-')}\` 中的 install.ps1、latest.json、releases/${plan.tag}.json 和迁移 README.md 提交到仓库根目录，保留既有版本清单。`).join('\n') +
    '\n\nrelease-response.json 仅为本地验收证据，不需提交。提交后读取公开文件逐项核对，再验收公开命令的 DownloadOnly 路径。\n');
  return { directory, plan, materialRoot };
}

async function publishRelease({ root, directory, run = runCommand } = {}) {
  const plan = await loadVerifiedBundle(directory), deps = { root, run };
  await preflight(plan, deps);
  // Re-read bytes after preflight, before the first remote mutation.
  await loadVerifiedBundle(directory);
  const notes = path.join(directory, 'release-notes.md');
  await fsp.writeFile(notes, plan.version === policyRules.MIGRATION_VERSION
    ? `Relay ${plan.version}：更新渠道迁移版本。此版本安装后使用 g1at/Relay 获取后续更新；这是 relay-updates 的最后一个版本。\n`
    : `Relay ${plan.version}。正式安装包与后续更新由 g1at/Relay 提供。\n`);
  for (const repository of plan.repositories) {
    await loadVerifiedBundle(directory);
    await run('gh', ['release', 'create', plan.tag, ...plan.artifacts.map(item => path.join(directory, item.name)),
      '--repo', repository, ...(repository === policyRules.PRIMARY_REPOSITORY ? ['--target', plan.sourceCommit] : []),
      '--draft', '--title', `Relay ${plan.version}`, '--notes-file', notes], { cwd: root, timeoutMs: 30 * 60 * 1000 });
  }
  for (const repository of plan.repositories) {
    // Draft tags may not exist as Git refs yet. The authenticated release list
    // includes drafts; do not assume the public tag lookup can resolve them.
    const drafts = (await ghPages(`repos/${repository}/releases?per_page=100`, deps)).filter(item => item.tag_name === plan.tag);
    if (drafts.length !== 1) throw new Error(`${repository}: cannot identify exactly one uploaded draft.`);
    assertReleaseAssets(plan, repository, drafts[0], { published: false });
  }
  // A partial failure leaves a visible draft for manual inspection. Never retry
  // with --clobber, delete an existing release, or silently replace its assets.
  for (const repository of plan.repositories) {
    await run('gh', ['release', 'edit', plan.tag, '--repo', repository, '--draft=false', '--latest'], { cwd: root });
  }
  return finalizeRelease({ root, directory, run });
}

async function main(args = process.argv.slice(2)) {
  const input = parseArguments(args), root = path.resolve(__dirname, '..');
  if (input.operation === 'help') {
    console.log('No arguments: build and verify locally (--publish never).\n--verify <bundle>: check the prepared bundle locally.\n--check <bundle>: verify locally and perform read-only PUBLIC/version/tag preflight.\n--publish <bundle>: check PUBLIC repositories and publish that exact bundle.\n--finalize <bundle>: read already published releases and regenerate static handoff files without publishing.');
    return;
  }
  if (input.operation === 'verify') { await loadVerifiedBundle(input.directory); console.log('Verified release bundle: ' + input.directory); return; }
  if (input.operation === 'check') {
    await preflight(await loadVerifiedBundle(input.directory), { root, run: runCommand });
    console.log('Read-only publication preflight passed: ' + input.directory); return;
  }
  const action = input.operation === 'prepare' ? prepareRelease : input.operation === 'publish' ? publishRelease : finalizeRelease;
  const result = await action({ root, directory: input.directory });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { PLAN_FILE, FEED_PATH, CHECKSUM_FILE, parseArguments, inspectBundle, loadVerifiedBundle,
  prepareRelease, preflight, publishRelease, finalizeRelease, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
