'use strict';

// The native fixture has no payload, registry operations or shortcuts. Its
// uniquely named sleep helper is the only process it starts and cleans up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'build/installer.nsh'), 'utf8');
const preflight = source.match(/  Function \$\{RELAY_UI_PREFIX\}RelayNoClosePreflight\b([\s\S]*?)  FunctionEnd/);
assert.ok(preflight, 'production CLI preflight is defined');
const macro = name => {
  const match = source.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`, 'i'));
  assert.ok(match, `${name} exists`);
  return match[1];
};

test('CLI policy guards initialization, process check and new uninstaller while preserving the regular updater', () => {
  assert.match(macro('customInit'), /Call RelayNoClosePreflight/);
  assert.match(macro('customUnInit'), /Call un\.RelayNoClosePreflight/);
  assert.match(macro('customCheckAppRunning'), /Call \$\{RELAY_UI_PREFIX\}RelayNoClosePreflight[\s\S]*\$RelayNoCloseMode != "1"[\s\S]*!insertmacro _CHECK_APP_RUNNING/);
  assert.match(preflight[1], /TestParameter\} \$R8 "relay-no-close"/);
  assert.match(preflight[1], /ReadEnvStr \$R9 "RELAY_INSTALL_NO_CLOSE"\s+ClearErrors/);
  assert.match(preflight[1], /SetEnvironmentVariableW/);
  assert.doesNotMatch(preflight[1].replace(/^\s*;.*$/gm, ''), /(?:taskkill|KillProcess|CloseProcess|WriteReg)/i);
  assert.match(source, /!include "getProcessInfo\.nsh"\s+Var pid/);
});

test('native NSIS CLI guard refuses live fixture processes without closing them and fails closed on detection error', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const output = path.join(repo, '.codex-tmp/cli-installer-audit/native-guard');
  fs.mkdirSync(output, { recursive: true });
  const nsisHome = process.env.RELAY_TEST_NSIS_HOME || path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-3.0.4.1');
  const compiler = path.join(nsisHome, 'Bin/makensis.exe');
  const plugins = path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-resources-3.4.1/plugins/x86-unicode');
  const include = path.join(repo, 'node_modules/app-builder-lib/templates/nsis/include');
  assert.ok(fs.existsSync(compiler), 'cached NSIS compiler is required; no download');
  assert.ok(fs.existsSync(path.join(plugins, 'nsProcess.dll')));
  const q = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
  const helperName = `RelayGuardProbe-${crypto.randomBytes(5).toString('hex')}.exe`;
  const helperFile = path.join(output, helperName);
  const cleanEnv = { ...process.env };
  delete cleanEnv.RELAY_INSTALL_NO_CLOSE;
  const evidence = { checks: [], installerOrUserDataTouched: false };
  let helper;

  function compile(name, body) {
    const script = path.join(output, name + '.nsi');
    const executable = path.join(output, name + '.exe');
    fs.writeFileSync(script, '\uFEFF' + `Unicode true\nName "Relay CLI no-install fixture"\nOutFile "${q(executable)}"\nRequestExecutionLevel user\nSilentInstall silent\n` + body);
    const result = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return executable;
  }
  function guardFixture(name, { lookupError = false } = {}) {
    const log = path.join(output, name + '.txt');
    const probe = lookupError
      ? '!define nsProcess::FindProcess `!insertmacro SyntheticLookupError`\n!macro SyntheticLookupError NAME RESULT\nStrCpy ${RESULT} "601"\n!macroend\n'
      : `!include "${q(path.join(include, 'nsProcess.nsh'))}"\n`;
    const executable = compile(name, `
!include "LogicLib.nsh"
!include "${q(path.join(include, 'StdUtils.nsh'))}"
!addplugindir /x86-unicode "${q(plugins)}"
${probe}
; Only the process guard is exercised here; the migration macro has its own integration test.
!define BUILD_RESOURCES_DIR "${q(path.join(repo, 'build'))}"
!define RELAY_LEGACY_UPGRADE_WRAPPED
!define RELAY_UI_PREFIX ""
!define APP_EXECUTABLE_FILENAME "${helperName}"
Var RelayNoCloseMode
Var RelayStockFallback
!macro _CHECK_APP_RUNNING
  StrCpy $RelayStockFallback "1"
!macroend
!macro customCheckAppRunning
${macro('customCheckAppRunning')}
!macroend
Function RelayNoClosePreflight
${preflight[1]}
FunctionEnd
Section
  StrCpy $RelayStockFallback "0"
  !insertmacro customCheckAppRunning
  ReadEnvStr $R9 "RELAY_INSTALL_NO_CLOSE"
  FileOpen $0 "${q(log)}" w
  FileWrite $0 "$RelayNoCloseMode|$RelayStockFallback|$R9"
  FileClose $0
  SetErrorLevel 0
SectionEnd
`);
    return { executable, log };
  }
  function invoke(fixture, args, expected, env = cleanEnv) {
    fs.rmSync(fixture.log, { force: true });
    const result = spawnSync(fixture.executable, ['/S', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, `${path.basename(fixture.executable)}: ${result.stdout} ${result.stderr}`);
    // NSIS FileWrite defaults to ANSI even in Unicode builds unless UTF16 is
    // requested. The fields here are deliberately ASCII.
    const fields = fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, 'utf8') : null;
    evidence.checks.push({ fixture: path.basename(fixture.executable), args, expectedExit: expected, actualExit: result.status, fields });
    return fields;
  }
  try {
    const guard = guardFixture('guard');
    const error = guardFixture('lookup-error', { lookupError: true });
    const sleepFixture = compile(path.basename(helperName, '.exe'), 'Section\n  Sleep 45000\nSectionEnd\n');
    assert.equal(sleepFixture, helperFile);
    assert.equal(invoke(guard, ['--relay-no-close'], 0), '1|0|1', 'absent process is allowed, native lookup returns 603, inherited policy is set');
    assert.equal(invoke(guard, [], 0), '0|1|', 'normal installs delegate to the existing updater check');
    assert.equal(invoke(guard, ['--relay-no-close-extra'], 0), '0|1|', 'only the exact opt-in flag changes behavior');
    assert.equal(invoke(error, ['--relay-no-close'], 5), null, 'unknown detection state never proceeds');
    helper = spawn(helperFile, ['/S'], { stdio: 'ignore', env: cleanEnv, windowsHide: true });
    await new Promise((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', reject); });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(invoke(guard, ['--relay-no-close'], 32), null, 'CLI exits before installation actions');
    assert.doesNotThrow(() => process.kill(helper.pid, 0), 'the running fixture process was not terminated');
    assert.equal(invoke(guard, [], 32, { ...cleanEnv, RELAY_INSTALL_NO_CLOSE: '1' }), null, 'new uninstallers also honor inherited policy without explicit argv');
    assert.doesNotThrow(() => process.kill(helper.pid, 0), 'inherited policy did not terminate the fixture process');
    assert.equal(invoke(error, [], 0), '0|1|', 'regular updater path does not consult CLI-only process lookup');
  } finally {
    if (helper && helper.exitCode === null) {
      const exited = new Promise(resolve => helper.once('exit', resolve));
      helper.kill(); // Only our uniquely named, synthetic sleep helper.
      await exited;
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  }
});
