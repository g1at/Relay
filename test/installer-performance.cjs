'use strict';
// Real packaged bytes, isolated identity. Never runs an app, Setup or uninstaller.
// Usage (Windows Node): node test/installer-performance.cjs --payload <win-unpacked>
//   --before <baseline-helper.ps1> [--after <candidate-helper.ps1>] [--runs 3]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

if (process.platform !== 'win32') throw new Error('Run this benchmark with Windows Node; no Linux skip counts as acceptance.');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--payload', '--before', '--after', '--runs'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Usage: node test/installer-performance.cjs --payload <win-unpacked> --before <helper.ps1> [--after <helper.ps1>] [--runs 3]');
  }
  if (options[args[i]]) throw new Error('Duplicate option: ' + args[i]);
  options[args[i]] = args[i + 1];
}
if (!options['--payload'] || !options['--before']) throw new Error('--payload and --before are required.');
const runs = Number(options['--runs'] || 3);
assert.ok(Number.isInteger(runs) && runs >= 3 && runs <= 15, '--runs must be 3 through 15');
const repo = path.resolve(__dirname, '..');
const payload = path.resolve(options['--payload']);
for (const required of ['Relay.exe', 'resources/app.asar']) assert.ok(fs.statSync(path.join(payload, required)).isFile(), 'Missing packaged ' + required);
const guid = crypto.randomUUID();
const product = 'Relay Performance Probe ' + guid.replaceAll('-', '').slice(0, 12);
const version = '3.0.2';
fs.mkdirSync(path.join(repo, '.codex-tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, '.codex-tmp', 'installer-performance-'));
const install = path.join(root, '路径 空格', product);
const manifestPath = path.join(root, 'manifest.json');
const installKey = 'Software\\' + guid;
const uninstallKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid;
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const env = { ...process.env, PATHEXT: '.COM;.EXE;.BAT;.CMD;' + (process.env.PATHEXT || '') };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { schema: 1, startedAt: new Date().toISOString(), root, sourcePayload: payload,
  product, guid, install, runsPerVariant: runs, variants: {}, samples: [], mediansMs: {},
  measurement: 'Wall time includes a new hidden PowerShell process per action. Copy and manifest creation excluded. No cache flush; setup reads all payload bytes. Alternating variant order per repetition.',
  limits: 'Measures helper Verify and non-whitelisted Begin exit 10; excludes NSIS decompression/copy, old uninstaller, application launch and network download.',
  registryCleanup: false, passed: false };
const reportPath = path.join(root, 'result.json');
const saveReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const registryScript = path.join(root, 'fixture-registry.ps1');
// Hardcode this run's random keys/paths: this script cannot accept production identity.
fs.writeFileSync(registryScript, '\uFEFF' + `param([ValidateSet('seed','clean')][string]$Action)
$ErrorActionPreference='Stop'
$guid=${psQuote(guid)}
$product=${psQuote(product)}
$install=${psQuote(install)}
if($guid -notmatch '^[a-f0-9-]{36}$' -or $product -notlike 'Relay Performance Probe *'){throw 'Invalid fixture identity'}
$a='Software\\'+$guid
$b='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$guid
$r=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try {
 if($Action -eq 'seed') {
  foreach($key in @($a,$b)){$old=$r.OpenSubKey($key);if($null -ne $old){$old.Dispose();throw 'Random fixture key already exists'}}
  $k=$r.CreateSubKey($a);try{$k.SetValue('InstallLocation',$install)}finally{$k.Dispose()}
  $k=$r.CreateSubKey($b);try{$k.SetValue('DisplayName',$product+' ${version}');$k.SetValue('DisplayVersion','${version}');$k.SetValue('UninstallString','"'+$install+'\\Uninstall '+$product+'.exe" /currentuser')}finally{$k.Dispose()}
 } else {
  $k=$r.OpenSubKey($a);if($null -ne $k){try{if($k.GetValue('InstallLocation') -ne $install){throw 'Refusing to clean an unrelated installation key'}}finally{$k.Dispose()}}
  $k=$r.OpenSubKey($b);if($null -ne $k){try{if($k.GetValue('DisplayName') -ne ($product+' ${version}')){throw 'Refusing to clean an unrelated uninstall key'}}finally{$k.Dispose()}}
  $r.DeleteSubKeyTree($a,$false);$r.DeleteSubKeyTree($b,$false)
  foreach($key in @($a,$b)){$left=$r.OpenSubKey($key);if($null -ne $left){$left.Dispose();throw 'Fixture registry cleanup failed'}}
 }
}finally{$r.Dispose()}
`);
function invoke(script, parameters, timeout = 180000) {
  const start = performance.now();
  const result = spawnSync(powershell, ['-WindowStyle', 'Hidden', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...parameters],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  return { durationMs: +(performance.now() - start).toFixed(2), exitCode: result.status,
    stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message || null };
}
function assertProcess(result, expected) {
  assert.equal(result.error, null, result.error || 'Unexpected process error');
  assert.equal(result.exitCode, expected, JSON.stringify(result));
}
function snapshotVariant(name, source) {
  const sourcePath = path.resolve(source);
  const snapshot = path.join(root, name + '-helper.ps1');
  fs.copyFileSync(sourcePath, snapshot);
  report.variants[name] = { source: sourcePath, snapshot, sha256: sha256(snapshot) };
}
let cleanupNeeded = false;
try {
  snapshotVariant('before', options['--before']);
  if (options['--after']) snapshotVariant('after', options['--after']);
  console.log('Preparing one disposable payload copy at ' + install);
  fs.cpSync(payload, install, { recursive: true, dereference: false, filter(source) {
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false, 'Reparse/symlink payload is unsupported: ' + source);
    return true;
  } });
  fs.renameSync(path.join(install, 'Relay.exe'), path.join(install, product + '.exe'));
  // Valid registration target but intentionally unknown bytes. Never executed.
  fs.writeFileSync(path.join(install, 'Uninstall ' + product + '.exe'), 'INERT UNKNOWN UNINSTALLER; DO NOT EXECUTE; ' + guid);
  const manifest = require('../build/generate-installer-manifest.cjs').writeManifest(install, manifestPath, version, product);
  report.payload = { files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), manifestSha256: sha256(manifestPath) };
  cleanupNeeded = true;
  assertProcess(invoke(registryScript, ['-Action', 'seed']), 0);
  for (let repetition = 0; repetition < runs; repetition++) {
    const order = Object.keys(report.variants);
    if (repetition % 2) order.reverse();
    for (const action of ['Verify', 'Begin']) {
      for (const variant of order) {
        const state = path.join(root, `state-${variant}-${action}-${repetition}.json`);
        const result = invoke(report.variants[variant].snapshot, ['-Action', action, '-StatePath', state,
          '-InstallDir', install, '-Scope', 'CurrentUser', '-ProductName', product,
          '-InstallKey', installKey, '-UninstallKey', uninstallKey, '-Version', version, '-ManifestPath', manifestPath]);
        const expectedExitCode = action === 'Begin' ? 10 : 0;
        report.samples.push({ variant, action, repetition: repetition + 1, expectedExitCode, ...result });
        saveReport();
        assertProcess(result, expectedExitCode);
        assert.equal(fs.existsSync(state), false, 'Non-mutating benchmark action unexpectedly prepared a transaction');
        console.log(`${variant} ${action} #${repetition + 1}: ${result.durationMs} ms (exit ${result.exitCode})`);
      }
    }
  }
  for (const variant of Object.keys(report.variants)) {
    report.mediansMs[variant] = {};
    for (const action of ['Verify', 'Begin']) {
      const values = report.samples.filter(sample => sample.variant === variant && sample.action === action).map(sample => sample.durationMs).sort((a, b) => a - b);
      const midpoint = Math.floor(values.length / 2);
      report.mediansMs[variant][action] = +(values.length % 2 ? values[midpoint] : (values[midpoint - 1] + values[midpoint]) / 2).toFixed(2);
    }
  }
  if (report.mediansMs.after) {
    report.improvementPercent = Object.fromEntries(['Verify', 'Begin'].map(action => [action,
      +(100 * (1 - report.mediansMs.after[action] / report.mediansMs.before[action])).toFixed(2)]));
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error);
  throw error;
} finally {
  try {
    if (cleanupNeeded) assertProcess(invoke(registryScript, ['-Action', 'clean']), 0);
    report.registryCleanup = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    saveReport();
    console.log(JSON.stringify({ report: reportPath, passed: report.passed, registryCleanup: report.registryCleanup, mediansMs: report.mediansMs, improvementPercent: report.improvementPercent }, null, 2));
  }
}
