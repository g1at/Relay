'use strict';

// This fixture exercises native NSIS controls, not a Relay installation. All
// generated installers, logs and screenshots remain in .codex-tmp. It never
// writes registry keys, creates shortcuts, starts Relay, or removes user files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('SKIP: run with Windows Node to exercise native NSIS UI controls.');
  process.exit(0);
}
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, '.codex-tmp', 'installer-nsis-ui');
fs.mkdirSync(root, { recursive: true });
const nsisHome = process.env.RELAY_TEST_NSIS_HOME || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'cache', 'nsis', 'nsis-3.0.4.1');
const compiler = [path.join(nsisHome, 'Bin', 'makensis.exe'), path.join(nsisHome, 'makensis.exe')].find(fs.existsSync);
assert.ok(compiler, 'A cached NSIS compiler is required; the test does not download executables.');
const q = (value) => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function artifactState(file) {
  try {
    const contents = fs.readFileSync(file);
    return { exists: true, size: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') };
  } catch (error) { return { exists: false, error: error.code }; }
}
function auditArtifact(phase, file, detail = {}) {
  fs.appendFileSync(path.join(root, 'execution-audit.jsonl'), JSON.stringify({ time: new Date().toISOString(), phase, file, ...detail, artifact: artifactState(file) }) + '\n');
}
function invoke(file, args, logName, expected = 0) {
  if (file.startsWith(root)) auditArtifact('before-run', file);
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = spawnSync(file, args, { cwd: root, encoding: 'utf8', timeout: 25000, windowsHide: true });
    if (!result.error || !['EPERM', 'EBUSY'].includes(result.error.code) || attempt === 3) break;
    // Retry a transient OS file lock without changing the artifact, security
    // settings, or workload. The execution audit retains the result.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  fs.writeFileSync(path.join(root, logName), `${result.stdout || ''}\n${result.stderr || ''}`);
  if (file.startsWith(root)) auditArtifact('after-run', file, { status: result.status, signal: result.signal, error: result.error?.code || null });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${logName}: ${result.stdout}\n${result.stderr}`);
  return result;
}

function fixture({ uninstall, failed, silent, skinFallback }) {
  const name = `${uninstall ? 'uninstall' : 'install'}-${failed ? 'failure' : 'success'}${silent ? '-silent' : ''}${skinFallback ? '-native-fallback' : ''}`;
  const prefix = uninstall ? 'un.' : '';
  const output = path.join(root, `${name}.exe`);
  const generatedUninstaller = path.join(root, `${name}-un.exe`);
  const logPath = path.join(root, `${name}.tsv`);
  const stage = uninstall ? '正在移除测试组件' : '正在释放测试组件';
  const snapshot = `
Function ${prefix}FixtureSnapshot
  Exch $R9
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  GetDlgItem $0 $RelayPage 1004
  System::Call 'user32::IsWindowVisible(p r0) i .r1'
  SendMessage $0 0x408 0 0 $2
  SendMessage $RelayProgress 0x408 0 0 $3
  System::Call 'user32::GetWindowLong(p $RelayProgress, i -16) i .r4'
  IntOp $4 $4 & 8
  StrCmp $RelayUIState "failed" 0 +3
    GetDlgItem $5 $HWNDPARENT 2
    Goto +2
  GetDlgItem $5 $HWNDPARENT 1
  System::Call 'user32::IsWindowVisible(p r5) i .r6'
  System::Call 'user32::IsWindowEnabled(p r5) i .r7'
  GetDlgItem $5 $RelayPage 1016
  System::Call 'user32::IsWindowVisible(p r5) i .r8'
  FileOpen $9 "${q(logPath)}" a
  FileSeek $9 0 END
  FileWrite $9 "$R9$\\t$RelayUIState$\\t$0$\\t$RelayProgress$\\t$1$\\t$2$\\t$3$\\t$4$\\t$6$\\t$7$\\t$8"
  System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -16) i .r0'
  IntOp $0 $0 & 0x00C00000
  FileWrite $9 "$\\t$0"
  System::Call 'kernel32::GetModuleHandle(t "relay-installer-skin.dll") p .r0'
  FileWrite $9 "$\\t$0"
  GetDlgItem $0 $HWNDPARENT 6201
  System::Call 'user32::IsWindowVisible(p r0) i .r1'
  System::Call 'user32::IsWindowEnabled(p r0) i .r2'
  FileWrite $9 "$\\t$1$\\t$2"
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'user32::IsWindowEnabled(p r0) i .r1'
  System::Call 'user32::IsWindowVisible(p r0) i .r2'
  FileWrite $9 "$\\t$1$\\t$2$\\r$\\n"
  FileClose $9
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R9
FunctionEnd
`;
  const body = `
Section ${uninstall ? '"Uninstall"' : '"Fixture"'}
  DetailPrint "Synthetic fixture only: no application or user data is changed."
  Push "${stage}"
  Call ${prefix}RelayUISetStage
  Push "working"
  Call ${prefix}FixtureSnapshot
  GetDlgItem $R8 $RelayPage 1004
  SendMessage $R8 0x406 0 100
  SendMessage $R8 0x402 82 0
  Sleep 80
  Push "native-high"
  Call ${prefix}FixtureSnapshot
  SendMessage $R8 0x406 0 1000
  SendMessage $R8 0x402 7 0
  Sleep 80
  Push "native-reset"
  Call ${prefix}FixtureSnapshot
  SendMessage $R8 0x402 1000 0
  Sleep 80
  Push "native-complete"
  Call ${prefix}FixtureSnapshot
  \${If} \${Silent}
    Call ${prefix}${failed ? 'RelayUIFailure' : 'RelayUISuccess'}
    Push "${failed ? 'failed' : 'success'}"
    Call ${prefix}FixtureSnapshot
    SetErrorLevel ${failed ? 2 : 0}
    Quit
  \${EndIf}
  ${failed ? 'Abort "Expected synthetic extraction failure"' : 'DetailPrint "Synthetic operation completed"'}
SectionEnd
`;
  return {
    name, output, generatedUninstaller, logPath,
    source: `Unicode true
RequestExecutionLevel user
Name "Relay native UI test fixture"
OutFile "${q(output)}"
InstallDir "${q(root)}"
AutoCloseWindow false
!include "MUI2.nsh"
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!define RELAY_UI_ICON "${q(path.join(repo, 'build', 'icon.ico'))}"
${skinFallback ? `!define RELAY_UI_SKIN "${q(path.join(root, 'intentionally-invalid-skin.dll'))}"` : ''}
!include "${q(path.join(repo, 'build', 'installer-ui.nsh'))}"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ${prefix}RelayStyleInstallPage
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ${prefix}FixtureComplete
!insertmacro ${uninstall ? 'MUI_UNPAGE_INSTFILES' : 'MUI_PAGE_INSTFILES'}
!insertmacro MUI_LANGUAGE "SimpChinese"
${uninstall ? `Function .onInit
  WriteUninstaller "${q(generatedUninstaller)}"
  SetErrorLevel 0
  Quit
FunctionEnd
Section "Generator"
SectionEnd
` : ''}
${snapshot}
Function ${uninstall ? 'un.onGUIEnd' : '.onGUIEnd'}
  Call ${prefix}RelayUIDestroy
FunctionEnd
Function ${prefix}FixtureComplete
  IfAbort fixture_failed
  Call ${prefix}RelayUISuccess
  Push "success"
  Call ${prefix}FixtureSnapshot
  SetErrorLevel 0
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::PostMessage(p r0, i 0x00F5, p 0, p 0)'
  Return
fixture_failed:
  Call ${prefix}RelayUIFailure
  Push "failed"
  Call ${prefix}FixtureSnapshot
  SetErrorLevel 2
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'user32::PostMessage(p r0, i 0x00F5, p 0, p 0)'
FunctionEnd
${body}
`,
  };
}

const summary = {
  checks: 0, scenarios: [], exitCodes: {},
  skinSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'build', 'installer-skin', 'relay-installer-skin.dll'))).digest('hex'),
  completed: false,
  // Real welcome / finish navigation and title-bar close live in the pages test.
  chromeCloseCoverage: 'installer-nsis-pages-smoke.cjs',
};
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(summary, null, 2));
function recordCase(name, failed) {
  summary.checks = checks;
  summary.scenarios.push(name);
  summary.exitCodes[name] = failed ? 2 : 0;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(summary, null, 2));
}
fs.writeFileSync(path.join(root, 'intentionally-invalid-skin.dll'), 'NOT A DLL. Exercises the presentation-load fallback only.');
const scenarios = [false, true].flatMap(uninstall => [false, true].flatMap(failed => [
  { uninstall, failed, silent: false, skinFallback: false },
  { uninstall, failed, silent: true, skinFallback: false },
  { uninstall, failed, silent: false, skinFallback: true },
]));
for (const { uninstall, failed, silent, skinFallback } of scenarios) {
  const f = fixture({ uninstall, failed, silent, skinFallback });
  if (process.env.RELAY_TEST_NSIS_CASE && f.name !== process.env.RELAY_TEST_NSIS_CASE) continue;
  try { fs.unlinkSync(f.logPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = path.join(root, `${f.name}.nsi`);
  fs.writeFileSync(source, '\ufeff' + f.source);
  invoke(compiler, ['/V3', source], `${f.name}-compile.log`);
  auditArtifact('after-compile', f.output);
  if (uninstall) invoke(f.output, ['/S'], `${f.name}-generate.log`);
  invoke(uninstall ? f.generatedUninstaller : f.output, [...(silent ? ['/S'] : []), ...(uninstall ? [`_?=${root}`] : [])], `${f.name}-run.log`, failed ? 2 : 0);
  const rows = fs.readFileSync(f.logPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [event, state, native, visible, nativeShown, nativePosition, visiblePosition, marquee, closeShown, closeEnabled, detailsShown, caption, skinLoaded, chromeShown, chromeEnabled, cancelEnabled, cancelVisible] = line.split('\t');
    return { event, state, native, visible, nativeShown: +nativeShown, nativePosition: +nativePosition, visiblePosition: +visiblePosition, marquee: +marquee, closeShown: +closeShown, closeEnabled: +closeEnabled, detailsShown: +detailsShown, caption: +caption, skinLoaded: +skinLoaded, chromeShown: +chromeShown, chromeEnabled: +chromeEnabled, cancelEnabled: +cancelEnabled, cancelVisible: +cancelVisible };
  });
  assert.equal(rows.length, 5, `${f.name}: all checkpoints logged`);
  if (silent) {
    check(rows.every((row) => !Number(row.visible)), `${f.name}: silent mode creates no progress UI`);
    check(rows.every((row) => !row.skinLoaded), `${f.name}: silent mode does not load the presentation DLL`);
    recordCase(f.name, failed);
    continue;
  }
  if (skinFallback) {
    check(rows.every((row) => !row.skinLoaded && row.caption > 0), `${f.name}: a skin load failure keeps a functional native title bar`);
  } else {
    check(rows.every((row) => Number.isFinite(row.skinLoaded) && row.skinLoaded !== 0), `${f.name}: the x86 presentation DLL attached`);
    check(rows.every((row) => row.chromeShown === 1), `${f.name}: frameless windows have a visible close control`);
    check(rows.slice(0, 4).every((row) => row.chromeEnabled === row.cancelEnabled), `${f.name}: running close control follows native cancellation availability`);
    check(rows.every((row) => row.caption === 0), `${f.name}: the OS caption is removed while native exit controls remain functional`);
  }
  check(rows.every((row) => row.native && row.visible && row.native !== row.visible), `${f.name}: the visible progress control is independent of native control 1004`);
  check(rows.every((row) => row.nativeShown === 0), `${f.name}: raw NSIS / extraction progress stays hidden`);
  for (const row of rows.slice(0, 4)) {
    check(row.state === 'working' && row.marquee === 8 && row.visiblePosition < 100, `${f.name}/${row.event}: in-progress work cannot claim completion or copy unstable native percentages`);
  }
  const last = rows.at(-1);
  check(last.state === (failed ? 'failed' : 'success'), `${f.name}: terminal state is explicit`);
  check(last.closeShown && last.closeEnabled, `${f.name}: terminal state has an enabled native close button`);
  if (failed) {
    check(last.visiblePosition < 100, `${f.name}: failed operation never displays 100%`);
    check(last.detailsShown, `${f.name}: error details are available`);
  } else {
    check(last.visiblePosition === 100 && last.marquee === 0, `${f.name}: success alone completes the progress control`);
  }
  recordCase(f.name, failed);
}
summary.completed = true;
summary.selectedCase = process.env.RELAY_TEST_NSIS_CASE || null;
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(summary, null, 2));
console.log(`PASS: ${checks} native NSIS UI assertions; generated fixtures and logs: ${root}`);
