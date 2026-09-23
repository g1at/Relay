'use strict';
// Native NSIS lifecycle test with an isolated product identity. The legacy EXE
// is an inert fixture that only records execution and exits 2. Production hashes
// are extended only in a disposable resource copy, never through a runtime flag.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP: Windows integration test.'); process.exit(0); }
const repo = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(repo, '.codex-tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, '.codex-tmp', 'upgrade-'));
const suffix = crypto.randomBytes(5).toString('hex');
const product = 'Relay Hotfix Probe ' + suffix;
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsisHome = path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-3.0.4.1');
const q = s => String(s).replaceAll('$', '$$').replaceAll('"', '$\\"');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const cleanEnv = { ...process.env, PATHEXT: '.COM;.EXE;.BAT;.CMD;' + process.env.PATHEXT };
delete cleanEnv.RELAY_INSTALL_NO_CLOSE;
const results = [];
function run(file, args, { expected = 0, env = cleanEnv, verbatim = false, timeout = 90000 } = {}) {
  const r = spawnSync(file, args, { cwd: root, env, input: '', encoding: 'utf8', timeout, windowsHide: true, windowsVerbatimArguments: verbatim });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, expected, `${file} ${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function powershell(script, args = []) { return run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]); }
function writePS(name, source) { const f=path.join(root,name+'.ps1'); fs.writeFileSync(f,'\uFEFF'+source); return f; }
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(path.join(root, 'payload/resources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'project'));
  fs.cpSync(path.join(repo, 'build'), path.join(root, 'resources'), { recursive: true });
  const stub = path.join(root, 'inert-old-uninstaller.exe');
  const marker = path.join(root, 'OLD-UNINSTALLER-WAS-RUN');
  const stubScript = path.join(root, 'stub.nsi');
  fs.writeFileSync(stubScript, `Unicode true\nName "Inert old uninstall fixture"\nOutFile "${q(stub)}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nFileOpen $0 "${q(marker)}" w\nFileWrite $0 "Old uninstall was invoked"\nFileClose $0\nSetErrorLevel 2\nQuit\nSectionEnd\n`);
  run(path.join(nsisHome, 'Bin/makensis.exe'), ['/V2', stubScript]);
  const helper = path.join(root, 'resources/installer-transaction.ps1');
  let helperSource=fs.readFileSync(helper,'utf8');
  const known="'ecec3c06013ec5e4dce3e396af41ea0c8c4029883d7b84026dc4331f9169fde2'";
  assert.ok(helperSource.includes(known));
  helperSource=helperSource.replace(known,known+", '"+hash(stub)+"'");
  helperSource=helperSource.replace('$message = $_.Exception.Message', '$message = $_.Exception.Message\n  [IO.File]::WriteAllText(\''+path.join(root,'last-helper-error.txt').replaceAll("'","''")+'\', $message, $utf8)');
  fs.writeFileSync(helper,helperSource);
  const include=path.join(root,'resources/installer.nsh');
  let nsisSource=fs.readFileSync(include,'utf8');
  assert.ok(nsisSource.includes('!macro customInstall\n'));
  nsisSource=nsisSource.replace('!macro customInstall\n',`!macro customInstall\n  ReadEnvStr $R9 "RELAY_FIXTURE_FAIL_POSTINSTALL"\n  \${If} $R9 == "1"\n    SetErrorLevel 2\n    Abort "Injected fixture postflight failure"\n  \${EndIf}\n  \${If} $R9 == "quit"\n    SetErrorLevel 86\n    Quit\n  \${EndIf}\n  \${If} $R9 == "missing-file"\n    Delete "$INSTDIR\\mandatory.dll"\n  \${EndIf}\n  \${If} $R9 == "legacy-result"\n    StrCpy $R0 2\n    ClearErrors\n    !insertmacro handleUninstallResult SHELL_CONTEXT\n  \${EndIf}\n  \${If} $R9 == "legacy-launch"\n    StrCpy $R0 0\n    SetErrors\n    !insertmacro handleUninstallResult SHELL_CONTEXT\n  \${EndIf}\n`);
  fs.writeFileSync(include,nsisSource);
  const extractionInclude=path.join(root,'resources/installer-legacy-upgrade.nsh');
  let extractionSource=fs.readFileSync(extractionInclude,'utf8');
  const copyLine='  CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR';
  assert.ok(extractionSource.includes(copyLine));
  extractionSource=extractionSource.replace(copyLine,'  ReadEnvStr $R9 "RELAY_FIXTURE_FAIL_POSTINSTALL"\n  ClearErrors\n'+copyLine+'\n  ${If} $R9 == "copy-error"\n    SetErrors\n  ${EndIf}');
  fs.writeFileSync(extractionInclude,extractionSource);
  fs.writeFileSync(path.join(root,'payload',product+'.exe'),'Synthetic application; never executed.');
  fs.writeFileSync(path.join(root,'payload/resources/app.asar'),'Synthetic application archive.');
  fs.writeFileSync(path.join(root,'payload/mandatory.dll'),'Synthetic mandatory runtime file.');
  fs.writeFileSync(path.join(root,'project/package.json'),JSON.stringify({name:'relay-hotfix-probe-'+suffix,version:'3.0.2',author:'Relay tests',description:'Isolated installer integration'}));
  require('../build/generate-installer-manifest.cjs').writeManifest(path.join(root,'payload'),path.join(root,'resources/installer-payload-manifest.json'),'3.0.2',product);
  const { build, Platform } = require('electron-builder');
  const { Arch } = require('builder-util');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const original = NsisTarget.prototype.executeMakensis;
  let definitions;
  NsisTarget.prototype.executeMakensis=async function(defines,...args){definitions={...defines};return original.call(this,defines,...args);};
  process.env.ELECTRON_BUILDER_NSIS_DIR=nsisHome;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
  const config=JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).build;
  await build({projectDir:path.join(root,'project'),prepackaged:path.join(root,'payload'),targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{extends:null,appId:'dev.relay.hotfix.probe.'+suffix,productName:product,executableName:product,electronVersion:require('electron/package.json').version,directories:{output:path.join(root,'out'),buildResources:path.join(root,'resources')},artifactName:'probe-setup.exe',forceCodeSigning:false,win:{target:['nsis'],icon:path.join(root,'resources/icon.ico'),signAndEditExecutable:false},nsis:{...config.nsis,include,shortcutName:product,installerIcon:path.join(root,'resources/icon.ico'),uninstallerIcon:path.join(root,'resources/icon.ico'),installerHeaderIcon:path.join(root,'resources/icon.ico'),runAfterFinish:false,differentialPackage:false,warningsAsErrors:true}}});
  NsisTarget.prototype.executeMakensis=original;
  const guid=definitions.APP_GUID;
  assert.notEqual(guid,'a5c32cb2-ebce-5411-8f64-015aaacf27f0');
  const install=path.join(root,'路径 空格',product);
  const setup=path.join(root,'out/probe-setup.exe');
  const data=path.join(root,'external-user-data');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'conversation.txt'),'user conversation must survive');
  const dataHash=hash(path.join(data,'conversation.txt'));
  const registryScript=writePS('registry',`param([string]$Action,[string]$Guid,[string]$Install,[string]$Name,[string]$Version)\n$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\nif($Guid -eq 'a5c32cb2-ebce-5411-8f64-015aaacf27f0' -or $Name -notlike 'Relay Hotfix Probe *'){throw 'Not a fixture identity'}\n$r=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)\n$a='Software\\'+$Guid;$b='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$Guid\ntry{\n if($Action -eq 'seed'){\n $k=$r.CreateSubKey($a);$k.SetValue('InstallLocation',$Install);$k.Dispose()\n $k=$r.CreateSubKey($b);$k.SetValue('DisplayVersion',$Version);$k.SetValue('DisplayName',$Name+' '+$Version);$k.SetValue('UninstallString','"'+$Install+'\\Uninstall '+$Name+'.exe" /currentuser');$k.Dispose()\n } elseif($Action -eq 'read'){\n $k=$r.OpenSubKey($b);if($null -eq $k){'absent'}else{$k.GetValue('DisplayVersion');$k.Dispose()}\n } elseif($Action -eq 'clean'){ $r.DeleteSubKeyTree($a,$false);$r.DeleteSubKeyTree($b,$false) }\n}finally{$r.Dispose()}\n`);
  const reg=(action,version='')=>powershell(registryScript,['-Action',action,'-Guid',guid,'-Install',install,'-Name',product,'-Version',version]).trim();
  function installRun(expected=0,env=cleanEnv){run(setup,['/S','/currentuser','/D="'+install+'"'],{expected,env,verbatim:true});}
  function verify(){assert.equal(reg('read'),'3.0.2');assert.equal(fs.readFileSync(path.join(install,product+'.exe'),'utf8'),'Synthetic application; never executed.');assert.equal(hash(path.join(data,'conversation.txt')),dataHash);assert.ok(!fs.existsSync(marker),'The inert old uninstaller must never run for a known legacy build');}
  function uninstall(){const f=path.join(root,'run-uninstall.exe');fs.copyFileSync(path.join(install,'Uninstall '+product+'.exe'),f);run(f,['/S','/currentuser','_?='+install],{verbatim:true});assert.ok(!fs.existsSync(install));assert.equal(reg('read'),'absent');assert.equal(hash(path.join(data,'conversation.txt')),dataHash);}
  function seed(version,kind){assert.equal(reg('read'),'absent');if(kind!=='missing-directory'){fs.mkdirSync(path.join(install,'resources'),{recursive:true});if(kind!=='empty-directory'){fs.writeFileSync(path.join(install,'legacy-only.txt'),'old payload sentinel');if(kind!=='missing-main')fs.writeFileSync(path.join(install,product+'.exe'),'old executable');fs.writeFileSync(path.join(install,'resources/app.asar'),'old archive');if(kind!=='missing-uninstaller')fs.copyFileSync(stub,path.join(install,'Uninstall '+product+'.exe'));}}reg('seed',version);}
  for(const [version,kind] of [['3.0.0','complete'],['3.0.1','complete'],['3.0.2','complete'],['3.0.1','missing-uninstaller'],['3.0.1','missing-main'],['3.0.1','empty-directory'],['3.0.1','missing-directory']]){seed(version,kind);installRun();verify();assert.ok(!fs.existsSync(path.join(install,'legacy-only.txt')));uninstall();results.push({version,kind,passed:true});console.log('PASS legacy',version,kind);}
  const before=crypto.createHash('sha256').update('old payload sentinel').digest('hex');
  for(const [mode,code] of [['1',2],['missing-file',2],['legacy-result',2],['legacy-launch',2],['copy-error',2]]) {
    seed('3.0.1','complete');installRun(code,{...cleanEnv,RELAY_FIXTURE_FAIL_POSTINSTALL:mode});assert.equal(reg('read'),'3.0.1');assert.equal(hash(path.join(install,'legacy-only.txt')),before);assert.equal(hash(path.join(install,'Uninstall '+product+'.exe')),hash(stub));assert.equal(hash(path.join(data,'conversation.txt')),dataHash);results.push({case:'postflight-'+mode+'-restores-old-files-and-registration',passed:true});installRun();verify();uninstall();
  }
  seed('3.0.1','complete');
  installRun(86,{...cleanEnv,RELAY_FIXTURE_FAIL_POSTINSTALL:'quit'});
  const recoveries=fs.readdirSync(path.dirname(install)).filter(name=>name.startsWith('.relay-recovery-')).map(name=>path.join(path.dirname(install),name));
  const pending=recoveries.filter(dir=>{const j=JSON.parse(fs.readFileSync(path.join(dir,'transaction.json'),'utf8'));return j.Original===install && j.Phase==='Moved';});
  assert.equal(pending.length,1,'Abrupt silent Quit must retain one complete recovery journal');
  const recovery=pending[0];
  assert.equal(hash(path.join(recovery,'application/legacy-only.txt')),before);
  installRun(2); // A new attempt must not discard an interrupted transaction.
  assert.equal(hash(path.join(recovery,'application/legacy-only.txt')),before);
  const recoverCommand=fs.readFileSync(path.join(recovery,'recover.cmd'),'ascii');
  assert.ok(recoverCommand.includes('-Action Rollback -StatePath "%~dp0recover.json"'));
  powershell(path.join(recovery,'recover.ps1'),['-Action','Rollback','-StatePath',path.join(recovery,'recover.json')]);
  assert.equal(reg('read'),'3.0.1');assert.equal(hash(path.join(install,'legacy-only.txt')),before);
  assert.equal(hash(path.join(install,'Uninstall '+product+'.exe')),hash(stub));
  assert.equal(JSON.parse(fs.readFileSync(path.join(recovery,'transaction.json'),'utf8')).Phase,'RolledBack');
  results.push({case:'abrupt-quit-preserves-backup-blocks-retry-and-allows-explicit-recovery',passed:true});
  installRun();verify();uninstall();
  seed('3.0.1','complete');
  const ready=path.join(root,'lock-ready');
  const lockScript=writePS('lock',`param([string]$File,[string]$Ready)\n$h=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry{[IO.File]::WriteAllText($Ready,'ready');Start-Sleep -Seconds 90}finally{$h.Dispose()}\n`);
  const locker=spawn(ps,['-NoProfile','-NonInteractive','-File',lockScript,'-File',path.join(install,'legacy-only.txt'),'-Ready',ready],{windowsHide:true,stdio:'ignore'});
  try{for(let i=0;i<100&&!fs.existsSync(ready);i++)await pause(100);assert.ok(fs.existsSync(ready));installRun(2);assert.equal(reg('read'),'3.0.1');assert.equal(hash(path.join(install,'legacy-only.txt')),before);results.push({case:'locked-file-fails-with-original-intact',passed:true});}finally{locker.kill();await pause(400);}
  installRun();verify();uninstall();
  installRun();verify();uninstall();results.push({case:'fresh-install-uninstall-without-registration',passed:true});
  assert.equal(hash(path.join(data,'conversation.txt')),dataHash);
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({root,product,guid,syntheticIdentity:true,realRelayTouched:false,legacyStubSha256:hash(stub),results},null,2));
  console.log(JSON.stringify({root,results},null,2));
})().catch(error=>{fs.writeFileSync(path.join(root,'failure.txt'),error.stack||String(error));console.error(error);process.exitCode=1;});
