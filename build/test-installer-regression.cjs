'use strict';

// One native acceptance gate for Windows CI and release preparation. Every
// executed installer is an inert fixture; no installed Relay identity is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');

// Keep these aligned with the locked app-builder-lib sources. Its downloader
// verifies SHA512 when fetching archives and reuses the builder's normal cache.
const NSIS_TOOLCHAIN = [
  { name: 'nsis', version: '3.0.4.1', sha512: 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==', source: 'app-builder-lib/out/targets/nsis/nsisUtil', required: ['Bin/makensis.exe', 'Plugins/x86-unicode/nsExec.dll'] },
  { name: 'nsis-resources', version: '3.4.1', sha512: 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==', source: 'app-builder-lib/out/targets/nsis/NsisTarget', required: ['plugins/x86-unicode/nsProcess.dll'] },
];
const REGRESSION_STEPS = [
  { name: 'installer unit and CLI guard tests', args: ['--test', '--test-timeout=90000', '--test-concurrency=1', 'test/installer-cli-guard.test.cjs', 'test/installer-manifest.test.cjs', 'test/installer-nsis-lifecycle.test.cjs'] },
  { name: 'quoted and non-ASCII install directory', args: ['test/installer-directory-parameter.cjs'] },
  { name: 'single and dual-scope transaction dispatch', args: ['test/installer-transaction-dispatch.cjs'] },
  { name: 'transaction helper behavior', powershell: true, args: ['test/installer-transaction-behavior.ps1'] },
  { name: 'production NSIS installer and uninstaller compilation', args: ['test/installer-nsis-build.cjs'] },
  { name: 'installer and uninstaller console visibility and exit protocol', args: ['test/installer-no-console.cjs'] },
  { name: 'synthetic upgrade, rollback and uninstall matrix', args: ['test/installer-upgrade-integration.cjs'] },
];

async function prepareToolchain() {
  const { getBinFromUrl } = require('app-builder-lib/out/binDownload');
  const paths = await Promise.all(NSIS_TOOLCHAIN.map(async pin => {
    const upstream = fs.readFileSync(require.resolve(pin.source), 'utf8');
    assert.ok(upstream.includes(`"${pin.name}", "${pin.version}", "${pin.sha512}"`), `${pin.name}: the locked builder toolchain changed; review and update this gate's pins.`);
    const folder = await getBinFromUrl(pin.name, pin.version, pin.sha512);
    for (const file of pin.required) assert.ok(fs.statSync(path.join(folder, file)).isFile(), `${pin.name}: missing ${file}`);
    return folder;
  }));
  return { nsisHome: paths[0], nsisResources: paths[1] };
}

async function runRegression() {
  assert.equal(process.platform, 'win32', 'Installer acceptance requires native Windows Node and an observable desktop. It cannot pass by skipping native fixtures.');
  const parent = path.join(repo, '.codex-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'installer-regression-'));
  const reportFile = path.join(root, 'result.json');
  const report = { passed: false, startedAt: new Date().toISOString(), platform: process.platform, node: process.version, root, steps: [], visibilityPolicy: 'The visible positive control is mandatory. A headless or inconclusive visibility result fails this gate.' };
  try {
    console.log('Preparing pinned NSIS compiler and plugins (SHA512-verified downloads, reusable cache).');
    report.toolchain = await prepareToolchain();
    const env = { ...process.env, PATHEXT: '.COM;.EXE;.BAT;.CMD;' + (process.env.PATHEXT || ''), CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_NSIS_DIR: report.toolchain.nsisHome, RELAY_TEST_NSIS_HOME: report.toolchain.nsisHome, RELAY_TEST_NSIS_RESOURCES: report.toolchain.nsisResources };
    delete env.RELAY_INSTALL_NO_CLOSE;
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // Sequential execution keeps unrelated fixture console events out of the
    // visibility observation and prevents concurrent access to build fixtures.
    for (const step of REGRESSION_STEPS) {
      console.log(`\nInstaller gate: ${step.name}`);
      const started = Date.now();
      const executable = step.powershell ? powershell : process.execPath;
      const args = step.powershell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...step.args] : step.args;
      const result = spawnSync(executable, args, { cwd: repo, env, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000 });
      report.steps.push({ name: step.name, args: step.args, exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, passed: !result.error && result.status === 0 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${step.name} failed (signal ${result.signal || 'none'}). See fixture evidence under .codex-tmp; no native check is optional.`);
    }
    report.passed = true;
    return report;
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`Installer regression ${report.passed ? 'PASSED' : 'FAILED'}: ${reportFile}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nInstaller regression: **${report.passed ? 'PASSED' : 'FAILED'}**. Native visibility requires an observed positive control; there is no headless bypass.\n\nEvidence: \`${path.relative(repo, reportFile)}\`\n`);
  }
}

module.exports = { NSIS_TOOLCHAIN, REGRESSION_STEPS, prepareToolchain, runRegression };
if (require.main === module) runRegression().catch(error => { console.error(error); process.exitCode = 1; });
