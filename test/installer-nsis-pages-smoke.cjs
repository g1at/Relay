'use strict';

// Isolated native page-navigation fixtures. No Relay process, install location,
// registry key, shortcut, network request or user data is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
if (process.platform !== 'win32') {
  console.log('SKIP: native installer page checks require Windows Node.');
  process.exit(0);
}
const repo = path.resolve(__dirname, '..');
const fallback = process.env.RELAY_TEST_SKIN_FAILURE === '1';
const chromeClose = process.argv.includes('--chrome-close') || process.env.RELAY_TEST_FINISH_CLOSE === 'chrome';
const closeResults = [];
const root = path.join(repo, '.codex-tmp', fallback ? 'installer-nsis-pages-fallback' : 'installer-nsis-pages');
fs.mkdirSync(root, { recursive: true });
const nsis = process.env.RELAY_TEST_NSIS_HOME || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis', 'nsis-3.0.4.1');
const compiler = path.join(nsis, 'Bin', 'makensis.exe');
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const q = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
const invalidSkin = path.join(root, 'invalid-skin.dll');
if (fallback) fs.writeFileSync(invalidSkin, 'Deliberately invalid DLL for the isolated load-failure fixture.');
const probe = path.join(root, 'probe.ps1');
fs.writeFileSync(probe, `param([int]$TargetPid,[string]$Output,[switch]$Next,[switch]$Animate,[switch]$ChromeClose)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing,System -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RelayFixtureWin {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
 public class FrameSample { public int n,ms,width,height,left,right,blue,border,contrast; }
 public static FrameSample[] SampleAnimation(IntPtr hwnd,string directory) {
  System.IO.Directory.CreateDirectory(directory);
  var frames=new System.Collections.Generic.List<FrameSample>();
  var total=System.Diagnostics.Stopwatch.StartNew();
  for(int n=0;n<64;n++) {
   var frameClock=System.Diagnostics.Stopwatch.StartNew();
   Rect r; GetWindowRect(hwnd,out r); int w=r.Right-r.Left,h=r.Bottom-r.Top;
   if(w<=0||h<=0||!IsWindowVisible(hwnd))break;
   var sample=new FrameSample {n=n,ms=(int)total.ElapsedMilliseconds,width=w,height=h,left=-1,right=-1};
   using(var bmp=new System.Drawing.Bitmap(w,h)) {
    // Print the parent before cropping: standalone PrintWindow(child) ignores
    // its window region and writes a black excluded bottom scanline. Parent
    // composition applies the actual rounded clip, matching what users see.
    IntPtr owner=GetAncestor(hwnd,2);Rect outer;GetWindowRect(owner,out outer);
    using(var whole=new System.Drawing.Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top)) {
     using(var g=System.Drawing.Graphics.FromImage(whole)){var dc=g.GetHdc();try{PrintWindow(owner,dc,0);}finally{g.ReleaseHdc(dc);}}
     using(var g=System.Drawing.Graphics.FromImage(bmp)){g.DrawImageUnscaled(whole,outer.Left-r.Left,outer.Top-r.Top);}
    }
    for(int x=0;x<w;x++) {
     var c=bmp.GetPixel(x,h/2);sample.contrast=Math.Max(sample.contrast,c.B-c.R);
     if(c.B-c.R>25&&c.B-c.G>20){if(sample.left<0)sample.left=x;sample.right=x;sample.blue++;}
     foreach(int y in new int[]{0,h-1}) {var edge=bmp.GetPixel(x,y);int max=Math.Max(edge.R,Math.Max(edge.G,edge.B)),min=Math.Min(edge.R,Math.Min(edge.G,edge.B));if(x>=h&&x<w-h&&max-min<25&&max<210)sample.border++;}
    }
    if(n%8==0)bmp.Save(System.IO.Path.Combine(directory,"frame-"+n.ToString("D2")+".png"),System.Drawing.Imaging.ImageFormat.Png);
   }
   frames.Add(sample);System.Threading.Thread.Sleep(Math.Max(1,80-(int)frameClock.ElapsedMilliseconds));
  }
  return frames.ToArray();
 }
 public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,EnumProc cb,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd,int index);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wParam,IntPtr lParam);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr wParam,IntPtr lParam);
}
'@
[void][RelayFixtureWin]::SetProcessDPIAware()
$script:found=[IntPtr]::Zero
[RelayFixtureWin]::EnumWindows({param($h,$d) [uint32]$p=0; [void][RelayFixtureWin]::GetWindowThreadProcessId($h,[ref]$p); if($p -eq $TargetPid -and [RelayFixtureWin]::IsWindowVisible($h)){$script:found=$h; return $false}; return $true},[IntPtr]::Zero)|Out-Null
if($script:found -eq [IntPtr]::Zero){throw "Fixture window not ready for pid $TargetPid"}
$script:progress=[IntPtr]::Zero
$script:close=[IntPtr]::Zero
$script:rows=New-Object System.Collections.Generic.List[object]
[RelayFixtureWin]::EnumChildWindows($script:found,{param($h,$d)
 $t=New-Object System.Text.StringBuilder 2048; $c=New-Object System.Text.StringBuilder 128; $r=New-Object RelayFixtureWin+Rect
 [void][RelayFixtureWin]::GetWindowText($h,$t,2048); [void][RelayFixtureWin]::GetClassName($h,$c,128); [void][RelayFixtureWin]::GetWindowRect($h,[ref]$r)
 if($c.ToString() -eq "msctls_progress32" -and [RelayFixtureWin]::GetDlgCtrlID($h) -ne 1004 -and [RelayFixtureWin]::IsWindowVisible($h)){$script:progress=$h}
 if([RelayFixtureWin]::GetDlgCtrlID($h) -eq 6201){$script:close=$h}
 $script:rows.Add([pscustomobject]@{id=[RelayFixtureWin]::GetDlgCtrlID($h); text=$t.ToString(); class=$c.ToString(); visible=[RelayFixtureWin]::IsWindowVisible($h); enabled=[RelayFixtureWin]::IsWindowEnabled($h); x=$r.Left; y=$r.Top; width=$r.Right-$r.Left; height=$r.Bottom-$r.Top; image=[RelayFixtureWin]::SendMessage($h,0x173,[IntPtr]1,[IntPtr]::Zero).ToInt64()})
 return $true
},[IntPtr]::Zero)|Out-Null
$r=New-Object RelayFixtureWin+Rect; [void][RelayFixtureWin]::GetWindowRect($script:found,[ref]$r)
if($Output){
 $bmp=New-Object System.Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
 $g=[System.Drawing.Graphics]::FromImage($bmp); $dc=$g.GetHdc()
 try{[void][RelayFixtureWin]::PrintWindow($script:found,$dc,0)}finally{$g.ReleaseHdc($dc); $g.Dispose()}
 $bmp.Save($Output,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$samples=@();if($Animate -and $script:progress -ne [IntPtr]::Zero){$samples=@([RelayFixtureWin]::SampleAnimation($script:progress,($Output+"-frames")))}
@{animation=$samples;window=@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top;style=[RelayFixtureWin]::GetWindowLong($script:found,-16)};controls=@($script:rows.ToArray())}|ConvertTo-Json -Depth 4 -Compress
if($ChromeClose){
 if($script:close -eq [IntPtr]::Zero -or -not [RelayFixtureWin]::IsWindowVisible($script:close) -or -not [RelayFixtureWin]::IsWindowEnabled($script:close)){throw "Fixture finish X is not available"}
 [void][RelayFixtureWin]::SendMessage($script:close,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
}
if($Next){[void][RelayFixtureWin]::PostMessage($script:found,0x111,[IntPtr]1,[IntPtr]::Zero)}
`, 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function exec(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function inspect(pid, name, next, animate = false, closeChrome = false) {
  if (chromeClose) name += '-final-close';
  const raw = exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, '-TargetPid', String(pid), '-Output', path.join(root, `${name}.png`), ...(next ? ['-Next'] : []), ...(animate ? ['-Animate'] : []), ...(closeChrome ? ['-ChromeClose'] : [])]);
  fs.writeFileSync(path.join(root, `${name}.json`), raw);
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
(async () => {
 for (const uninstall of [false, true]) {
  const name = uninstall ? 'uninstall' : 'install';
  const prefix = uninstall ? 'un.' : '';
  const exe = path.join(root, `${name}.exe`);
  const unexe = path.join(root, `${name}-un.exe`);
  const marker = path.join(root, `${name}-stage.txt`);
  const source = path.join(root, `${name}.nsi`);
  try { fs.unlinkSync(marker); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(source, '\ufeff' + `Unicode true
RequestExecutionLevel user
Name "Relay page layout fixture"
Icon "${q(path.join(repo, 'build', 'icon.ico'))}"
UninstallIcon "${q(path.join(repo, 'build', 'icon.ico'))}"
OutFile "${q(exe)}"
InstallDir "${q(root)}"
!include "MUI2.nsh"
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!define RELAY_UI_ICON "${q(path.join(repo, 'build', 'icon.ico'))}"
${fallback ? `!define RELAY_UI_SKIN "${q(invalidSkin)}"` : ''}
!include "${q(path.join(repo, 'build', 'installer-ui.nsh'))}"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ${prefix}RelayStyleWelcomePage
!insertmacro ${uninstall ? 'MUI_UNPAGE_WELCOME' : 'MUI_PAGE_WELCOME'}
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ${prefix}RelayStyleInstallPage
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ${prefix}FixtureDone
!insertmacro ${uninstall ? 'MUI_UNPAGE_INSTFILES' : 'MUI_PAGE_INSTFILES'}
${uninstall ? '' : '!define MUI_FINISHPAGE_RUN\n!define MUI_FINISHPAGE_RUN_TEXT "打开 Relay（仅演示，不会启动）"\n!define MUI_FINISHPAGE_RUN_FUNCTION FixtureNoop'}
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ${prefix}RelayStyleFinishPage
!insertmacro ${uninstall ? 'MUI_UNPAGE_FINISH' : 'MUI_PAGE_FINISH'}
!insertmacro MUI_LANGUAGE "SimpChinese"
${uninstall ? `Function .onInit
 WriteUninstaller "${q(unexe)}"
 SetErrorLevel 0
 Quit
FunctionEnd
Section "Generator"
SectionEnd` : 'Function FixtureNoop\nFunctionEnd'}
Function ${uninstall ? 'un.onGUIEnd' : '.onGUIEnd'}
 Call ${prefix}RelayUIDestroy
FunctionEnd
Function ${prefix}FixtureDone
 IfAbort failed
 Call ${prefix}RelayUISuccess
 Return
 failed:
 Call ${prefix}RelayUIFailure
FunctionEnd
Section ${uninstall ? '"Uninstall"' : '"Synthetic fixture"'}
 Push "正在处理测试组件…"
 Call ${prefix}RelayUISetStage
 FileOpen $0 "${q(marker)}" w
 FileWrite $0 "working"
 FileClose $0
 DetailPrint "This fixture performs no installation, cleanup or registry writes."
 Sleep ${chromeClose ? 3000 : !uninstall && !fallback ? 17000 : 9000}
SectionEnd
`);
  fs.writeFileSync(path.join(root, `${name}-compile.log`), exec(compiler, ['/V3', source]));
  assert.ok(fs.existsSync(exe), `${name}: compiled fixture disappeared; stopping without retry`);
  if(uninstall) exec(exe, ['/S']);
  assert.ok(fs.existsSync(uninstall ? unexe : exe), `${name}: fixture disappeared before launch; stopping without retry`);
  const child = spawn(uninstall ? unexe : exe, uninstall ? [`_?=${root}`] : [], { cwd: root, stdio: 'ignore', windowsHide: false });
  const exited = new Promise(resolve => {
   child.once('exit', (code, signal) => resolve({code, signal}));
   child.once('error', error => resolve({code: null, error: error.message}));
  });
  try {
   await pause(1700);
   const welcome = inspect(child.pid, `${name}-welcome`, true);
   const visible = view => view.controls.filter(c => c.visible);
   check(((welcome.window.style & 0x00c00000) !== 0) === fallback, `${name}: ${fallback ? 'DLL load failure preserves usable native title bar' : 'custom skin removes the native NSIS title bar'}`);
   check(visible(welcome).some(c => c.text === `${uninstall ? '卸载' : '安装'} Relay`), `${name}: styled welcome title is visible`);
   check(visible(welcome).some(c => c.class === 'Static' && c.image), `${name}: high-resolution logo image is loaded`);
   check(visible(welcome).some(c => c.id === 1 && c.text === (uninstall ? '卸载' : '安装')), `${name}: welcome action uses concise Relay wording`);
   check(visible(welcome).some(c => c.id === 1 && c.enabled), `${name}: welcome next action is usable`);
   check(!visible(welcome).some(c => c.class === 'Static' && [1037,1038,1039].includes(c.id)), `${name}: old MUI header is hidden`);
   for(let i=0; i<30 && !fs.existsSync(marker); i++) await pause(100);
   check(fs.existsSync(marker), `${name}: next navigates into actual NSIS section`);
   const working = inspect(child.pid, `${name}-working`, false, !uninstall && !fallback && !chromeClose);
   check(visible(working).some(c => c.text === '正在处理测试组件…'), `${name}: working stage replaces welcome`);
   check(visible(working).some(c => c.class === 'msctls_progress32' && c.id !== 1004), `${name}: visible progress belongs to Relay`);
   if (!uninstall && !fallback && !chromeClose) {
    const frames = working.animation;
    check(frames.length === 64 && frames.at(-1).ms >= 4000, 'animation: real progress control sampled across more than two cycles');
    const width = frames[0].width;
    check(frames.every(frame => frame.border <= width * 0.02), 'animation: no neutral dark native border remains on track edges');
    const widest = Math.max(...frames.map(frame => frame.blue));
    check(widest >= width * 0.15 && widest <= width * 0.21, 'animation: activity segment occupies approximately 18 percent of track');
    const visibleFrames = frames.filter(frame => frame.blue > 2);
    check(Math.max(...visibleFrames.map(frame => frame.left)) - Math.min(...visibleFrames.map(frame => frame.left)) > width * 0.65, 'animation: marker visibly moves across the track');
    let wraps = 0;
    for (let i = 1; i < visibleFrames.length; i++) {
     const previous = visibleFrames[i - 1], current = visibleFrames[i];
     if (current.left < previous.left - 3) {
      wraps++;
      check(current.n - previous.n > 1 && previous.left > width * 0.7 && current.left < width * 0.15, 'animation: leftward reset occurs through an invisible gap rather than a reverse bounce');
     }
    }
    check(wraps >= 1, 'animation: at least one complete animated cycle was observed');
    check(frames.some(frame => frame.contrast > 25 && frame.contrast < 150), 'animation: edge phase visibly fades rather than abruptly resetting');
   }
   await pause(chromeClose ? 3100 : 8500);
   const finish = inspect(child.pid, `${name}-finish`, !chromeClose, false, chromeClose);
   check(visible(finish).some(c => c.text === `${uninstall ? '卸载' : '安装'}完成`), `${name}: completed page title is visible`);
   check(visible(finish).some(c => c.id === 1 && c.text === '完成'), `${name}: finish action uses concise Relay wording`);
   check(visible(finish).some(c => c.id === 1 && c.enabled), `${name}: finish action is usable`);
   check(!visible(finish).some(c => c.class === 'Static' && [1200,1201,1202].includes(c.id)), `${name}: old MUI bitmap and text cannot cover the Relay completion page`);
   check(!visible(finish).some(c => c.class === 'msctls_progress32'), `${name}: running progress does not leak into completion page`);
   if(!uninstall) check(visible(finish).some(c => c.class === 'Button' && c.text.includes('仅演示')), 'install: native optional launch checkbox is retained');
   const end = await Promise.race([exited, pause(5000).then(()=>null)]);
   if (chromeClose) closeResults.push({mode:name,controlId:6201,message:'BM_CLICK',exit:end});
   check(end && end.code === 0, `${name}: ${chromeClose ? 'finish X' : 'finish'} actually closes the fixture successfully`);
  } finally {
   if(child.exitCode === null && child.signalCode === null) child.kill();
  }
 }
 const crypto = require('node:crypto');
 const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 fs.writeFileSync(path.join(root, chromeClose ? 'final-close-result.json' : 'result.json'), JSON.stringify({closeResults:chromeClose?closeResults:undefined,createdAt:new Date().toISOString(),assertions:checks,syntheticOnly:true,fallback,skinSha256:hash(fallback?invalidSkin:path.join(repo,'build','installer-skin','relay-installer-skin.dll')),uiSha256:hash(path.join(repo,'build','installer-ui.nsh'))},null,2));
 console.log(`PASS: ${checks} native page navigation assertions; screenshots in ${root}`);
})().catch(error => { console.error(error); process.exitCode=1; });
