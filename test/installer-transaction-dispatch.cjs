'use strict';
// Compiles the production NSIS transaction macros with an inert PowerShell
// helper. No application payload, registry access or real product identity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') throw new Error('Native Windows Node is required for transaction dispatch acceptance.');
const repo = path.resolve(__dirname, '..');
const nsisHome = process.env.RELAY_TEST_NSIS_HOME || path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-3.0.4.1');
const compiler = path.join(nsisHome, 'Bin/makensis.exe');
assert.ok(fs.existsSync(compiler), 'Prepare the pinned NSIS compiler with build/test-installer-regression.cjs first.');
const source = path.join(repo, 'build/installer-transaction.nsh');
fs.mkdirSync(path.join(repo, '.codex-tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, '.codex-tmp', 'transaction-dispatch-'));
const resources = path.join(root, '中文 空格 resources');
fs.mkdirSync(resources);
const guid = crypto.randomUUID();
const q = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mock = String.raw`param([string]$Action,[string]$StatePath,[string]$InstallDir,[string]$Scope,[string]$ProductName,[string]$InstallKey,[string]$UninstallKey,[string]$Version,[string]$ShortcutPaths,[string]$ManifestPath)
$ErrorActionPreference='Stop'
if($ProductName -ne 'Relay Transaction Dispatch Fixture'){throw 'Unexpected fixture identity'}
if($Action -notin @('Verify','VerifyAndCommit','Commit','Rollback')){throw 'Unexpected action'}
$parent=[IO.Path]::GetDirectoryName($StatePath)
$current=[IO.File]::Exists((Join-Path $parent 'relay-transaction-CurrentUser.json'))
$all=[IO.File]::Exists((Join-Path $parent 'relay-transaction-AllUsers.json'))
$exists=[IO.File]::Exists($StatePath)
if($exists -and [IO.File]::ReadAllText($StatePath) -ne ('fixture-pointer-'+$Scope)){throw 'Pointer contents changed unexpectedly'}
$code=0
if(($Action+'|'+$Scope) -eq $env:RELAY_DISPATCH_FAIL){$code=2}
$row=@{action=$Action;scope=$Scope;current=$current;all=$all;stateExists=$exists;exitCode=$code;registryAccess=$false}
[IO.File]::AppendAllText($env:RELAY_DISPATCH_LOG,($row|ConvertTo-Json -Compress)+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
[Console]::Out.WriteLine('mock output must not remain on the NSIS stack')
exit $code
`;
fs.writeFileSync(path.join(resources, 'installer-transaction.ps1'), '\uFEFF' + mock);
fs.writeFileSync(path.join(resources, 'installer-payload-manifest.json'), '{}');
const cases = [
  { name: 'single-current', current: true, all: false, mode: 'CurrentUser' },
  { name: 'single-all', current: false, all: true, mode: 'all' },
  { name: 'dual-current', current: true, all: true, mode: 'CurrentUser' },
  { name: 'dual-all', current: true, all: true, mode: 'all' },
  { name: 'failed-combined-current', current: true, all: false, mode: 'CurrentUser', failure: ['VerifyAndCommit', 'CurrentUser'] },
  { name: 'failed-combined-all', current: false, all: true, mode: 'all', failure: ['VerifyAndCommit', 'AllUsers'] },
  { name: 'failed-commit-dual', current: true, all: true, mode: 'all', failure: ['Commit', 'CurrentUser'] },
  { name: 'failed-verify-dual', current: true, all: true, mode: 'all', failure: ['Verify', 'AllUsers'] },
];
const report = { passed: false, root, productionIncludeSha256: sha(source), cases: [],
  boundary: 'Production RelayRunTransaction, RelayVerifyPayload and RelayCommitTransactions compiled unchanged. Inert PowerShell records dispatch only; no registry or payload. Failure cases invoke RunTransaction directly then explicit Rollback to inspect pointer retention before rollback.' };
const save = () => fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, env });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function compileCase(test) {
  const directory = path.join(root, test.name);
  fs.mkdirSync(directory);
  const executable = path.join(directory, 'fixture.exe');
  const filename = path.join(directory, 'fixture.nsi');
  const seed = owner => `FileOpen $0 "$PLUGINSDIR\\relay-transaction-${owner}.json" w\nFileWrite $0 "fixture-pointer-${owner}"\nFileClose $0\n`;
  const operation = test.failure ? `StrCpy $RelayTransactionAction "${test.failure[0]}"
StrCpy $RelayTransactionScope "${test.failure[1]}"
Call RelayRunTransaction
!insertmacro Checkpoint "after-failure"
Call RelayRollbackTransactions
!insertmacro Checkpoint "after-rollback"
` : `!insertmacro RelayVerifyPayload
!insertmacro Checkpoint "after-verify"
!insertmacro RelayCommitTransactions ""
!insertmacro Checkpoint "after-commit"
`;
  const script = `Unicode true
Name "Relay Transaction Dispatch Fixture"
OutFile "${q(executable)}"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!define BUILD_RESOURCES_DIR "${q(resources)}"
!define PRODUCT_FILENAME "Relay Transaction Dispatch Fixture"
!define INSTALL_REGISTRY_KEY "Software\\${guid}"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}"
!define VERSION "3.0.2"
Var installMode
Var oldStartMenuLink
Var newStartMenuLink
Var oldDesktopLink
Var newDesktopLink
!include "${q(source)}"
!insertmacro RelayTransactionFunctions ""
Function RelayUIFailure
FunctionEnd
!macro Checkpoint LABEL
 StrCpy $R6 0
 StrCpy $R7 0
 IfFileExists "$PLUGINSDIR\\relay-transaction-CurrentUser.json" 0 +2
  StrCpy $R6 1
 IfFileExists "$PLUGINSDIR\\relay-transaction-AllUsers.json" 0 +2
  StrCpy $R7 1
 FileOpen $R8 "$EXEDIR\\checkpoints.txt" a
 FileSeek $R8 0 END
 FileWrite $R8 "\${LABEL}|$R6|$R7|$RelayTransactionCode$\\r$\\n"
 FileClose $R8
!macroend
Section
 InitPluginsDir
 StrCpy $RelayMigrationHandled "fixture"
 StrCpy $installMode "${test.mode}"
 StrCpy $INSTDIR "$EXEDIR\\No-Payload"
 StrCpy $oldStartMenuLink ""
 StrCpy $newStartMenuLink ""
 StrCpy $oldDesktopLink ""
 StrCpy $newDesktopLink ""
 GetFunctionAddress $R0 RelayUIFailure
 ${test.current ? seed('CurrentUser') : ''}
 ${test.all ? seed('AllUsers') : ''}
 Push "RELAY_DISPATCH_STACK_SENTINEL"
 ${operation}
 Pop $R3
 FileOpen $R4 "$EXEDIR\\stack.txt" w
 FileWrite $R4 "$R3"
 FileClose $R4
 SetErrorLevel 0
SectionEnd
`;
  fs.writeFileSync(filename, '\uFEFF' + script);
  run(compiler, ['/WX', '/V2', filename]);
  return { directory, executable };
}
try {
  for (const test of cases) {
    const { directory, executable } = compileCase(test);
    const log = path.join(directory, 'calls.jsonl');
    run(executable, ['/S'], { ...process.env, RELAY_DISPATCH_LOG: log, RELAY_DISPATCH_FAIL: test.failure ? test.failure.join('|') : '' });
    const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const checkpoints = Object.fromEntries(fs.readFileSync(path.join(directory, 'checkpoints.txt'), 'utf8').trim().split(/\r?\n/).map(line => {
      const [label, current, all, code] = line.split('|');
      return [label, { current: current === '1', all: all === '1', code: Number(code) }];
    }));
    const callNames = calls.map(call => call.action + '|' + call.scope);
    const activeScope = test.mode === 'CurrentUser' ? 'CurrentUser' : 'AllUsers';
    if (test.failure) {
      assert.deepEqual(checkpoints['after-failure'], { current: test.current, all: test.all, code: 2 }, 'A failed action must preserve its pointer and exit code');
      const expected = [test.failure.join('|')];
      if (test.current) expected.push('Rollback|CurrentUser');
      if (test.all) expected.push('Rollback|AllUsers');
      assert.deepEqual(callNames, expected);
      assert.ok(calls.slice(1).every(call => call.stateExists), 'Rollback did not receive the retained pointer');
    } else if (test.current && test.all) {
      assert.deepEqual(callNames, ['Verify|' + activeScope, 'Commit|CurrentUser', 'Commit|AllUsers']);
      assert.deepEqual(checkpoints['after-verify'], { current: true, all: true, code: 0 });
      assert.equal(calls[1].current, true);
      assert.equal(calls[1].all, true);
      assert.equal(calls[2].current, false, 'CurrentUser must commit before AllUsers');
      assert.equal(calls[2].all, true);
      assert.deepEqual(checkpoints['after-commit'], { current: false, all: false, code: 0 });
    } else {
      assert.deepEqual(callNames, ['VerifyAndCommit|' + activeScope]);
      assert.deepEqual(checkpoints['after-verify'], { current: false, all: false, code: 0 });
      assert.deepEqual(checkpoints['after-commit'], { current: false, all: false, code: 0 });
    }
    assert.ok(calls.every(call => call.registryAccess === false));
    assert.equal(fs.readFileSync(path.join(directory, 'stack.txt'), 'utf8'), 'RELAY_DISPATCH_STACK_SENTINEL');
    report.cases.push({ ...test, calls, checkpoints, passed: true });
    save();
    console.log('PASS ' + test.name);
  }
  assert.equal(sha(source), report.productionIncludeSha256, 'Production source changed during dispatch test');
  report.passed = true;
  save();
  console.log(JSON.stringify({ passed: true, cases: report.cases.length, report: path.join(root, 'result.json') }, null, 2));
} catch (error) {
  report.failure = error.stack || String(error);
  save();
  throw error;
}
