# Native Windows acceptance of the embedded helper, using unique fixture identities.
$ErrorActionPreference='Stop'
$env:PATHEXT='.COM;.EXE;.BAT;.CMD;'+$env:PATHEXT
$helper = Join-Path $PSScriptRoot '..\build\installer-transaction.ps1'
$fixture = Join-Path (Split-Path $PSScriptRoot -Parent) ('.codex-tmp\transaction-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$results=New-Object 'System.Collections.Generic.List[object]'
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Setup([string]$Name) {
  $script:shortcuts='|'
  $script:name='Relay Transaction '+$Name
  $script:root=Join-Path $fixture $script:name
  $script:key='Software\'+[guid]::NewGuid().ToString()
  $script:unkey='Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$script:key.Substring(9)
  $script:state=Join-Path $env:TEMP ('relay-transaction-test-'+[guid]::NewGuid().ToString('N')+'.json')
  [void][IO.Directory]::CreateDirectory($script:root)
  [IO.File]::WriteAllText((Join-Path $script:root 'original.txt'),'old application sentinel')
  $k=$base.CreateSubKey($script:key);$k.SetValue('InstallLocation',$script:root);$k.Dispose()
  $k=$base.CreateSubKey($script:unkey);$k.SetValue('DisplayName',$script:name+' 3.0.1');$k.SetValue('DisplayVersion','3.0.1');$k.SetValue('UninstallString','"'+(Join-Path $script:root ('Uninstall '+$script:name+'.exe'))+'" /currentuser');$k.Dispose()
}
function Run([string]$Action,[int]$Expected) {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action $Action -StatePath $script:state -InstallDir $script:root -ProductName $script:name -InstallKey $script:key -UninstallKey $script:unkey -Version 3.0.2 -Scope CurrentUser -ManifestPath (Join-Path $fixture 'manifest.json') -ShortcutPaths $script:shortcuts
  Assert ($LASTEXITCODE -eq $Expected) "$Action returned $LASTEXITCODE, expected $Expected"
}
function Journal { $p=Get-Content -Raw -LiteralPath $script:state|ConvertFrom-Json;return (Get-Content -Raw -LiteralPath $p.Journal|ConvertFrom-Json) }
function Cleanup {
  $base.DeleteSubKeyTree($script:key,$false);$base.DeleteSubKeyTree($script:unkey,$false)
  if(Test-Path -LiteralPath $script:state){Remove-Item -LiteralPath $script:state -Force}
  if(Test-Path -LiteralPath ($script:state+'.error.txt')){Remove-Item -LiteralPath ($script:state+'.error.txt') -Force}
}
try {
  Setup 'Rollback'
  try {
    Run Begin 0
    $j=Journal
    Assert (-not [IO.Directory]::Exists($script:root)) 'Legacy directory was not moved'
    Assert ([IO.Path]::GetPathRoot($j.Backup) -eq [IO.Path]::GetPathRoot($script:root)) 'Backup is not on the installation volume'
    [void][IO.Directory]::CreateDirectory($script:root)
    [IO.File]::WriteAllText((Join-Path $script:root 'partial.txt'),'failed new copy')
    Run Rollback 0; Run Rollback 0
    Assert ([IO.File]::ReadAllText((Join-Path $script:root 'original.txt')) -eq 'old application sentinel') 'Rollback lost original bytes'
    Assert (-not [IO.File]::Exists((Join-Path $script:root 'partial.txt'))) 'Partial payload mixed with restored application'
    $results.Add(@{case='partial_install_rollback_idempotent_cross_temp';passed=$true})
  } finally { Cleanup }
  Setup 'Locked'
  try {
    $handle=[IO.File]::Open((Join-Path $script:root 'original.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {Run Begin 2}finally{$handle.Dispose()}
    Assert ([IO.File]::ReadAllText((Join-Path $script:root 'original.txt')) -eq 'old application sentinel') 'Lock failure changed the old application'
    Assert (-not [IO.File]::Exists($script:state)) 'Lock failure prepared a transaction'
    $results.Add(@{case='deny_delete_lock_preserves_original';passed=$true})
  } finally {Cleanup}
  Setup 'Prepared'
  try {
    Run Begin 0;$j=Journal
    [IO.Directory]::Move($j.Backup,$script:root)
    $j.Phase='Prepared';[IO.File]::WriteAllText($j.Journal,($j|ConvertTo-Json -Depth 32))
    Run Rollback 0
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Prepared rollback moved an untouched original'
    $results.Add(@{case='prepared_move_failure_preserves_original';passed=$true})
  } finally {Cleanup}
  Setup 'Unknown'
  try {
    [IO.File]::WriteAllText((Join-Path $script:root ('Uninstall '+$script:name+'.exe')),'unknown uninstaller is never executed by the helper')
    Run Begin 10
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Unknown uninstall hash was moved'
    $results.Add(@{case='unknown_uninstaller_left_to_upstream';passed=$true})
  } finally {Cleanup}
  Setup 'UninstallRegistryFailure'
  try {
    Run Remove 0
    Run Commit 2
    Run Rollback 0
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Uninstall postflight failure lost application'
    $results.Add(@{case='remaining_registration_prevents_uninstall_commit';passed=$true})
  } finally {Cleanup}
  Setup 'UninstallSuccess'
  try {
    Run Remove 0;$j=Journal
    $base.DeleteSubKeyTree($script:key,$false);$base.DeleteSubKeyTree($script:unkey,$false)
    Run Commit 0
    Assert (-not [IO.Directory]::Exists($script:root)) 'Uninstall original remains'
    Assert (-not [IO.Directory]::Exists($j.Backup)) 'Committed backup was not cleaned'
    $results.Add(@{case='uninstall_commit_after_registry_removal';passed=$true})
  } finally {Cleanup}
  Setup 'RecoveryRetry'
  try {
    Run Begin 0;$j=Journal
    [IO.Directory]::Move($j.Backup,$script:root)
    $j.Phase='FilesRestored';[IO.File]::WriteAllText($j.Journal,($j|ConvertTo-Json -Depth 32))
    Run Rollback 0;Run Rollback 0
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Repeated metadata rollback moved restored files'
    $results.Add(@{case='files_restored_metadata_retry';passed=$true})
  } finally {Cleanup}
  Setup 'Interrupted'
  try {
    Run Begin 0
    $k=$base.CreateSubKey($script:unkey);$k.SetValue('DisplayVersion','3.0.2');$k.Dispose()
    Run Begin 2
    Run Rollback 0
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Interrupted transaction was overwritten'
    $results.Add(@{case='interrupted_transaction_blocks_overwrite';passed=$true})
  } finally {Cleanup}
  Setup 'ShortcutRetry'
  try {
    $script:shortcuts=Join-Path $fixture 'menu-folder\sentinel.lnk'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:shortcuts))
    [IO.File]::WriteAllText($script:shortcuts,'old shortcut sentinel')
    Run Begin 0
    $handle=[IO.File]::Open($script:shortcuts,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {Run Rollback 2}finally{$handle.Dispose()}
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Metadata failure moved the already restored files'
    Assert ((Journal).Phase -eq 'FilesRestored') 'Rollback did not persist FilesRestored phase'
    Run Rollback 0;Run Rollback 0
    Assert ([IO.File]::ReadAllText($script:shortcuts) -eq 'old shortcut sentinel') 'Shortcut bytes were not restored on retry'
    $results.Add(@{case='shortcut_restore_failure_and_retry_preserve_original';passed=$true})
  } finally {Cleanup}
  Setup 'Manifest'
  try {
    [void][IO.Directory]::CreateDirectory((Join-Path $script:root 'resources'))
    [IO.File]::WriteAllText((Join-Path $script:root ($script:name+'.exe')),'fixture executable')
    [IO.File]::WriteAllText((Join-Path $script:root 'resources\app.asar'),'fixture asar')
    [IO.File]::WriteAllText((Join-Path $script:root 'required.dll'),'fixture native library')
    $entries=@(($script:name+'.exe'),'resources/app.asar','required.dll')|ForEach-Object {
      $f=Join-Path $script:root $_
      @{path=$_;size=(Get-Item -LiteralPath $f).Length;sha256=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash}
    }
    [IO.File]::WriteAllText((Join-Path $fixture 'manifest.json'),(@{schema=1;version='3.0.2';productName=$script:name;files=@($entries)}|ConvertTo-Json -Depth 8))
    [IO.File]::WriteAllText((Join-Path $script:root ('Uninstall '+$script:name+'.exe')),'fixture uninstaller')
    $k=$base.CreateSubKey($script:unkey);$k.SetValue('DisplayVersion','3.0.2');$k.Dispose()
    Run Verify 0
    [IO.File]::Delete((Join-Path $script:root 'required.dll'))
    Run Verify 2
    $results.Add(@{case='full_manifest_rejects_missing_dll';passed=$true})
  } finally {Cleanup}
  Setup 'Junction'
  try {
    $target=Join-Path $fixture 'external-work';[void][IO.Directory]::CreateDirectory($target)
    [IO.File]::WriteAllText((Join-Path $target 'keep.txt'),'external user data')
    [void](New-Item -ItemType Junction -Path (Join-Path $script:root 'linked') -Target $target)
    Run Begin 2
    Assert ([IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -eq 'external user data') 'Reparse check modified external data'
    Assert ([IO.File]::Exists((Join-Path $script:root 'original.txt'))) 'Reparse check moved original'
    $results.Add(@{case='junction_rejected_before_changes';passed=$true})
  } finally {Cleanup}
  $result=@{fixture=$fixture;passed=$true;cases=$results.ToArray()}
  $result|ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $fixture 'result.json'),($result|ConvertTo-Json -Depth 8))
} finally {$base.Dispose()}
