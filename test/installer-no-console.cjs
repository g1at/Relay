'use strict';
// Native visibility and process-return acceptance. The NSIS production macro is
// used unchanged, with an inert helper: no registry or application is installed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP: native Windows NSIS console visibility test'); process.exit(0); }
const repo = path.resolve(__dirname, '..');
const parent = path.join(repo, '.codex-tmp');
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'no-console-'));
const resources = path.join(root, '中文 空格 resources');
fs.mkdirSync(resources);
const nsisHome = path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-3.0.4.1');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quoteNSIS = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const writePS = (file, source) => fs.writeFileSync(file, '\uFEFF' + source);
const production = path.join(repo, 'build/installer-transaction.nsh');
const productionText = fs.readFileSync(production, 'utf8');
assert.match(productionText, /nsExec::ExecToStack/);
assert.doesNotMatch(productionText, /nsExec::ExecToStack\s+\/TIMEOUT/i);
const resultBranch = productionText.match(/    Pop \$RelayTransactionCode\r?\n    Pop \$RelayTransactionOutput[\s\S]*?    \$\{EndIf\}/)[0];
const mock = String.raw`
param([string]$Action,[string]$StatePath,[string]$InstallDir,[string]$Scope,[string]$ProductName,[string]$InstallKey,[string]$UninstallKey,[string]$Version,[string]$ShortcutPaths,[string]$ManifestPath)
$ErrorActionPreference='Stop'
$runtime=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
Set-Location -LiteralPath $runtime
[Environment]::CurrentDirectory=$runtime
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayConsoleProbe {
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool SetConsoleTitle(string title);
}
'@
$marker=$env:RELAY_CONSOLE_MARKER
$window=[RelayConsoleProbe]::GetConsoleWindow()
if($window -ne [IntPtr]::Zero){[void][RelayConsoleProbe]::SetConsoleTitle($marker)}
$samples=New-Object 'System.Collections.Generic.List[object]'
$timer=[Diagnostics.Stopwatch]::StartNew()
while($timer.ElapsedMilliseconds -lt 250){
 $window=[RelayConsoleProbe]::GetConsoleWindow()
 $samples.Add(@{elapsedMs=$timer.ElapsedMilliseconds;handle=$window.ToInt64();visible=($window -ne [IntPtr]::Zero -and [RelayConsoleProbe]::IsWindowVisible($window))})
 Start-Sleep -Milliseconds 10
}
$code=[int]$env:RELAY_CONSOLE_EXIT
$r=@{marker=$marker;pid=$PID;exitCode=$code;durationMs=$timer.ElapsedMilliseconds;samples=$samples.ToArray();registryAccess=$false;applicationInstalled=$false}
[IO.File]::WriteAllText($env:RELAY_CONSOLE_REPORT,($r|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
[Console]::Out.WriteLine('mock stdout must not leak onto the NSIS stack')
exit $code
`;
writePS(path.join(resources, 'installer-transaction.ps1'), mock);
fs.writeFileSync(path.join(resources, 'installer-payload-manifest.json'), '{}');
const observer = path.join(root, 'observer.ps1');
writePS(observer, String.raw`
param([string]$Ready,[string]$Stop,[string]$Output)
$ErrorActionPreference='Stop'
$runtime=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
Set-Location -LiteralPath $runtime
[Environment]::CurrentDirectory=$runtime
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class RelayConsoleEvent {
 public string time; public uint eventId; public long handle; public uint pid;
 public string className; public string title; public bool visible;
}
public static class RelayConsoleObserver {
 delegate void Callback(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
 [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wp; public IntPtr lp; public uint time; public int x,y; }
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,Callback cb,uint pid,uint thread,uint flags);
 [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg,IntPtr hwnd,uint min,uint max,uint flags);
 [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
 public static List<RelayConsoleEvent> Watch(string ready,string stop) {
  var events=new List<RelayConsoleEvent>();
  Callback callback=(hook,evt,hwnd,obj,child,thread,time)=>{
   if(hwnd==IntPtr.Zero || obj!=0 || child!=0)return;
   var cls=new StringBuilder(256);GetClassName(hwnd,cls,cls.Capacity);
   string name=cls.ToString();
   if(name!="ConsoleWindowClass" && name!="CASCADIA_HOSTING_WINDOW_CLASS" && name!="PseudoConsoleWindow")return;
   var title=new StringBuilder(256);GetWindowText(hwnd,title,title.Capacity);
   uint pid;GetWindowThreadProcessId(hwnd,out pid);
   events.Add(new RelayConsoleEvent{time=DateTime.UtcNow.ToString("o"),eventId=evt,handle=hwnd.ToInt64(),pid=pid,className=name,title=title.ToString(),visible=IsWindowVisible(hwnd)});
  };
  // SHOW catches a startup flash even if Hidden takes effect before the helper
  // itself begins. NAMECHANGE/FOREGROUND also detect a reused Terminal window.
  var hooks=new[]{SetWinEventHook(0x8002,0x8002,IntPtr.Zero,callback,0,0,2),SetWinEventHook(0x800c,0x800c,IntPtr.Zero,callback,0,0,2),SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,2)};
  foreach(var h in hooks)if(h==IntPtr.Zero)throw new Exception("SetWinEventHook failed");
  File.WriteAllText(ready,"ready");
  try {
   var watch=System.Diagnostics.Stopwatch.StartNew();
   while(!File.Exists(stop) && watch.ElapsedMilliseconds<180000){
    MSG message;while(PeekMessage(out message,IntPtr.Zero,0,0,1)){TranslateMessage(ref message);DispatchMessage(ref message);}
    Thread.Sleep(5);
   }
  } finally {foreach(var h in hooks)UnhookWinEvent(h);GC.KeepAlive(callback);}
  return events;
 }
}
'@
$events=[RelayConsoleObserver]::Watch($Ready,$Stop)
[IO.File]::WriteAllText($Output,(@($events.ToArray())|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
`);
const common = `Unicode true\nName "Relay no-console fixture"\nRequestExecutionLevel user\nSilentInstall silent\n!include LogicLib.nsh\n!define BUILD_RESOURCES_DIR "${quoteNSIS(resources)}"\n!define PRODUCT_FILENAME "Relay Console Fixture"\n!define INSTALL_REGISTRY_KEY "Software\\00000000-0000-4000-8000-000000000001"\n!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\00000000-0000-4000-8000-000000000001"\n!define VERSION "3.0.2"\nVar oldStartMenuLink\nVar newStartMenuLink\nVar oldDesktopLink\nVar newDesktopLink\n!include "${quoteNSIS(production)}"\n!insertmacro RelayTransactionFunctions ""\n`;
function compile(mode) {
  const isUninstaller = mode === 'production-uninstaller';
  const prefix = isUninstaller ? 'un.' : '';
  const executable = path.join(root, mode + '.exe');
  const source = path.join(root, mode + '.nsi');
  let operation;
  if (mode.startsWith('production')) operation = `Call ${prefix}RelayRunTransaction`;
  else if (mode === 'positive-control') operation = `ExecWait '\"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${quoteNSIS(path.join(resources, 'installer-transaction.ps1'))}\"' $RelayTransactionCode`;
  else operation = `nsExec::ExecToStack '\"$EXEDIR\\does-not-exist.exe\"'\n${resultBranch}`;
  // Referencing both functions retains the unchanged production declarations
  // under -WX; only the specified operation actually runs.
  const generator = path.join(root, mode + '-generator.exe');
  const header = isUninstaller ? '!define BUILD_UNINSTALLER\n' + common.replace('!insertmacro RelayTransactionFunctions ""', '!insertmacro RelayTransactionFunctions "un."') : common;
  const begin = isUninstaller ? `OutFile "${quoteNSIS(generator)}"\nSection\nWriteUninstaller "${quoteNSIS(executable)}"\nSetErrorLevel 0\nQuit\nSectionEnd\nSection "un.install"\n` : `OutFile "${quoteNSIS(executable)}"\nSection\nStrCpy $RelayMigrationHandled "fixture"\n`;
  const script = header + begin + `StrCpy $RelayTransactionOutput ""\nStrCpy $RelayTransactionAction "${isUninstaller ? 'Remove' : 'Begin'}"\nStrCpy $RelayTransactionScope "CurrentUser"\nStrCpy $INSTDIR "$EXEDIR\\中文 空格 No-Install"\nStrCpy $oldStartMenuLink ""\nStrCpy $newStartMenuLink ""\nStrCpy $oldDesktopLink ""\nStrCpy $newDesktopLink ""\nGetFunctionAddress $R0 ${prefix}RelayRollbackTransactions\nGetFunctionAddress $R0 ${prefix}RelayRunTransaction\nPush "RELAY_STACK_SENTINEL"\n${operation}\nPop $R3\nFileOpen $R4 "$EXEDIR\\${mode}-stack.txt" w\nFileWrite $R4 "$R3"\nFileClose $R4\nSetErrorLevel $RelayTransactionCode\nQuit\nSectionEnd\n`;
  fs.writeFileSync(source, '\uFEFF' + script);
  const result = spawnSync(path.join(nsisHome, 'Bin/makensis.exe'), ['/WX', '/V2', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  if (isUninstaller) {
    const generated = spawnSync(generator, ['/S'], { windowsHide: true, timeout: 10000 });
    assert.equal(generated.status, 0);
    assert.ok(fs.existsSync(executable));
  }
  return executable;
}
const productionExe = compile('production');
const uninstallExe = compile('production-uninstaller');
const controlExe = compile('positive-control');
const errorExe = compile('startup-error');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function observeRun(mode, executable, code, index) {
  const ready = path.join(root, `${mode}-${index}-ready`);
  const stop = path.join(root, `${mode}-${index}-stop`);
  const eventLog = path.join(root, `${mode}-${index}-events.json`);
  const helperLog = path.join(root, `${mode}-${index}-helper.json`);
  let observerError = '';
  const watcher = spawn(ps, ['-WindowStyle', 'Hidden', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', observer, '-Ready', ready, '-Stop', stop, '-Output', eventLog], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  watcher.stderr.on('data', bytes => { observerError += bytes.toString(); });
  const watcherDone = new Promise(resolve => watcher.once('exit', resolve));
  try {
    for (let i = 0; !fs.existsSync(ready) && i < 300; i++) { if (watcher.exitCode !== null) break; await delay(50); }
    assert.ok(fs.existsSync(ready), `Observer did not initialize: ${observerError}`);
    const start = Date.now();
    const args = mode === 'production-uninstaller' ? ['/S', '_?=' + root] : ['/S'];
    const result = spawnSync(executable, args, { windowsHide: false, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 45000, env: { ...process.env, RELAY_CONSOLE_EXIT: String(code), RELAY_CONSOLE_REPORT: helperLog, RELAY_CONSOLE_MARKER: `Relay console fixture ${mode} ${index}` } });
    const durationMs = Date.now() - start;
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, code, `${mode} exit code lost: ${result.stdout} ${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(root, `${mode}-stack.txt`), 'utf8'), 'RELAY_STACK_SENTINEL', 'nsExec result/output was left on the NSIS stack');
    await delay(150);
    fs.writeFileSync(stop, 'stop');
    assert.equal(await watcherDone, 0, observerError);
    const eventText = fs.readFileSync(eventLog, 'utf8').trim();
    const value = eventText ? JSON.parse(eventText) : [];
    const events = Array.isArray(value) ? value : [value];
    const visibleEvents = events.filter(event => event.eventId === 0x8002 || event.visible);
    const helper = fs.existsSync(helperLog) ? JSON.parse(fs.readFileSync(helperLog, 'utf8')) : null;
    if (mode !== 'startup-error') {
      assert.ok(helper, 'NSIS returned before the helper completed');
      assert.ok(helper.durationMs >= 250 && durationMs >= helper.durationMs, 'The helper was not awaited');
      assert.equal(helper.exitCode, code);
    }
    return { mode, code, durationMs, helper, visibleEvents, allEvents: events, stackPreserved: true };
  } finally {
    if (!fs.existsSync(stop)) fs.writeFileSync(stop, 'stop');
    if (watcher.exitCode === null) await watcherDone;
  }
}
(async () => {
  const results = [];
  const positive = await observeRun('positive-control', controlExe, 0, 0);
  assert.ok(positive.visibleEvents.length > 0 || positive.helper.samples.some(sample => sample.visible), 'Positive ExecWait control was not observed; visibility monitoring is inconclusive');
  results.push(positive);
  for (const [mode, executable] of [['production', productionExe], ['production-uninstaller', uninstallExe]]) {
  for (const [index, code] of [0, 10, 2, 0, 10, 2].entries()) {
    const run = await observeRun(mode, executable, code, index);
    assert.ok(run.helper.samples.every(sample => !sample.visible), 'Production helper exposed a visible console');
    assert.deepEqual(run.visibleEvents, [], 'A console SHOW/foreground event occurred during production execution');
    results.push(run);
  }
  }
  const failed = await observeRun('startup-error', errorExe, 2, 0);
  assert.equal(failed.helper, null);
  assert.deepEqual(failed.visibleEvents, []);
  results.push(failed);
  const report = { passed: true, root, productionIncludeSha256: sha(production), results, boundary: 'Actual production installer and BUILD_UNINSTALLER/un. RelayTransactionFunctions compiled unchanged with an inert helper. No registry calls or payload installation. Startup error uses the exact production Pop/error-normalization block with an absent executable. The visible ExecWait control validates the monitor.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, root, runs: results.length, positiveVisibleEvents: positive.visibleEvents.length, productionHandles: [...new Set(results.filter(run => run.mode.startsWith('production')).flatMap(run => run.helper.samples.map(sample => sample.handle)))], report: path.join(root, 'result.json') }, null, 2));
})().catch(error => { fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); console.error(error); process.exitCode = 1; });
