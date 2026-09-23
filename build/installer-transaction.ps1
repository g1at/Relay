# Windows PowerShell 5.1. This helper is embedded in the installer, never loaded
# from an existing installation. All identity parameters come from the NSIS build.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Begin','Remove','Commit','Rollback','Verify')][string]$Action,
  [Parameter(Mandatory=$true)][string]$StatePath,
  [string]$InstallDir,
  [ValidateSet('CurrentUser','AllUsers')][string]$Scope = 'CurrentUser',
  [string]$ProductName,
  [string]$InstallKey,
  [string]$UninstallKey,
  [string]$Version,
  [string]$ShortcutPaths = '',
  [string]$ManifestPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:state = $null
$script:registry = $null
# NSIS loads its native System.dll in PLUGINSDIR. PowerShell's C# compiler
# resolves relative framework references against the process working directory;
# never compile beside that native DLL (it shadows managed System.dll).
$runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
Set-Location -LiteralPath $runtimeDirectory
[Environment]::CurrentDirectory = $runtimeDirectory
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RelayInstallerFiles {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
'@
function Save-Json([string]$Path, $Value) {
  $temp = $Path + '.new'
  [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 32), $utf8)
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, ($Path + '.previous'), $true) }
  else { [IO.File]::Move($temp, $Path) }
}
function Save-State {
  Save-Json $script:state.Journal $script:state
  Save-Json $StatePath @{ Journal = $script:state.Journal }
  Save-Json (Join-Path $script:state.Recovery 'recover.json') @{ Journal = $script:state.Journal }
}
function Open-Registry([string]$Owner) {
  $hive = if ($Owner -eq 'AllUsers') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
  return [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
}
function Read-Value([string]$Key, [string]$Name) {
  $opened = $script:registry.OpenSubKey($Key)
  if ($null -eq $opened) { return '' }
  try { return [string]$opened.GetValue($Name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $opened.Dispose() }
}
function Snapshot-Key([string]$Key) {
  $opened = $script:registry.OpenSubKey($Key)
  if ($null -eq $opened) { return @{ Exists = $false; Values = @(); Children = @() } }
  try {
    $values = @($opened.GetValueNames() | ForEach-Object {
      @{ Name = $_; Kind = $opened.GetValueKind($_).ToString(); Value = $opened.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    })
    $children = @($opened.GetSubKeyNames() | ForEach-Object { @{ Name = $_; Snapshot = (Snapshot-Key ($Key + '\' + $_)) } })
    return @{ Exists = $true; Values = $values; Children = $children }
  } finally { $opened.Dispose() }
}
function Restore-Key([string]$Key, $Snapshot) {
  $script:registry.DeleteSubKeyTree($Key, $false)
  if (-not $Snapshot.Exists) { return }
  $opened = $script:registry.CreateSubKey($Key)
  try {
    foreach ($entry in $Snapshot.Values) {
      $kind = [Microsoft.Win32.RegistryValueKind]::$($entry.Kind)
      $value = $entry.Value
      switch ($entry.Kind) {
        'Binary' { $value = [byte[]]$value }
        'DWord' { $value = [int]$value }
        'QWord' { $value = [long]$value }
        'MultiString' { $value = [string[]]$value }
      }
      $opened.SetValue([string]$entry.Name, $value, $kind)
    }
  } finally { $opened.Dispose() }
  foreach ($child in $Snapshot.Children) { Restore-Key ($Key + '\' + $child.Name) $child.Snapshot }
}
function Normalize-Path([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('..')) { throw "Unsafe installation path: $Path" }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Assert-PlainPath([string]$Path) {
  $cursor = $Path
  while (-not [string]::IsNullOrEmpty($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point rejected: $cursor" }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Assert-AppPath([string]$Path, [string]$Name) {
  $normal = Normalize-Path $Path
  if ([IO.Path]::GetFileName($normal) -ine $Name) { throw "Unexpected installation directory name: $normal" }
  $parent = [IO.Path]::GetDirectoryName($normal)
  if ($parent.Length -le 3) { throw "Refusing installation directly below a drive root: $normal" }
  foreach ($protected in @($env:APPDATA, $env:USERPROFILE, $env:WINDIR)) {
    if (-not [string]::IsNullOrEmpty($protected)) {
      $p = [IO.Path]::GetFullPath($protected).TrimEnd('\')
      if ($normal -ieq $p -or $p.StartsWith($normal + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Protected path rejected: $normal" }
    }
  }
  $appData = [IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\')
  if ($normal.StartsWith($appData + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Roaming user data cannot be an installation target: $normal" }
  Assert-PlainPath $normal
  return $normal
}
function Assert-CanMoveTree([string]$Path) {
  if (-not [IO.Directory]::Exists($Path)) { return }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $attrs = [IO.File]::GetAttributes($current)
    if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point rejected: $current" }
    # DELETE access with all sharing detects a real deny-delete lock and ACL
    # rejection without deleting, truncating, or modifying any application file.
    $handle = [RelayInstallerFiles]::CreateFile($current, 0x10000, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($handle.IsInvalid) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $handle.Dispose()
      throw "Application file is locked or inaccessible ($code): $current"
    }
    $handle.Dispose()
    if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) { $pending.Push($entry) }
    }
  }
}
function Assert-NoPendingRecovery([string]$Directory, [string]$Owner) {
  $parent = [IO.Path]::GetDirectoryName($Directory)
  if (-not [IO.Directory]::Exists($parent)) { return }
  # Keep interrupted recoveries visible and recoverable, instead of treating a
  # half-written application as the only remaining copy on a subsequent run.
  foreach ($prior in [IO.Directory]::EnumerateDirectories($parent, '.relay-recovery-*')) {
    Assert-PlainPath $prior
    $priorJournal = Join-Path $prior 'transaction.json'
    if ([IO.File]::Exists($priorJournal)) {
      $priorState = [IO.File]::ReadAllText($priorJournal) | ConvertFrom-Json
      if ($priorState.Original -ieq $Directory -and $priorState.Scope -eq $Owner -and $priorState.Phase -notin @('Committed','RolledBack')) {
        throw "An interrupted transaction is preserved at $prior. Run its recover.cmd before retrying."
      }
    }
  }
}
function Load-State {
  $pointer = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  $script:state = [IO.File]::ReadAllText($pointer.Journal) | ConvertFrom-Json
  # This file is generated by Begin inside a freshly-created random sibling.
  Assert-PlainPath $script:state.Journal
  $script:registry = Open-Registry $script:state.Scope
}
function Rollback-State {
  if ($script:state.Phase -in @('Committed','RolledBack')) { return }
  Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($script:state.Recovery))
  # Prepared + no backup means the atomic move never happened.
  if ($script:state.Phase -eq 'Prepared' -and -not [IO.Directory]::Exists($script:state.Backup)) {
    $script:state.Phase = 'RolledBack'
    Save-State
    return
  }
  if ($script:state.Phase -ne 'FilesRestored') {
    if ($script:state.HadOriginal -and -not [IO.Directory]::Exists($script:state.Backup)) { throw 'The original backup is missing; rollback stopped before moving the installed application.' }
    # Never delete the failed new payload. Preserve it next to the old copy.
    if ([IO.Directory]::Exists($script:state.Original)) {
      Assert-CanMoveTree $script:state.Original
      [IO.Directory]::Move($script:state.Original, (Join-Path $script:state.Recovery ('failed-install-' + [guid]::NewGuid().ToString('N'))))
    }
    if ([IO.Directory]::Exists($script:state.Backup)) {
      [IO.Directory]::Move($script:state.Backup, $script:state.Original)
    }
    $script:state.Phase = 'FilesRestored'
    Save-State
  }
  Restore-Key $script:state.InstallKey $script:state.InstallRegistry
  Restore-Key $script:state.UninstallKey $script:state.UninstallRegistry
  foreach ($shortcut in $script:state.Shortcuts) {
    if ($shortcut.Exists) {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($shortcut.Path))
      [IO.File]::WriteAllBytes($shortcut.Path, [Convert]::FromBase64String($shortcut.Bytes))
    } elseif ([IO.File]::Exists($shortcut.Path)) { [IO.File]::Delete($shortcut.Path) }
  }
  $script:state.Phase = 'RolledBack'
  Save-State
}
try {
  if ($Action -eq 'Verify') {
    $target = Assert-AppPath $InstallDir $ProductName
    $manifest = [IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -ne $Version -or $manifest.productName -ne $ProductName -or $manifest.files.Count -lt 2) { throw 'Unexpected payload manifest identity.' }
    $names = @{}
    foreach ($entry in $manifest.files) {
      if ($entry.path -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))') { throw 'Unsafe payload manifest path.' }
      $file = [IO.Path]::GetFullPath((Join-Path $target $entry.path))
      if (-not $file.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload manifest escapes the application directory.' }
      if ($names.ContainsKey($file)) { throw 'Duplicate payload manifest entry.' }
      $names[$file] = $true
      Assert-PlainPath $file
      if (-not [IO.File]::Exists($file) -or (Get-Item -LiteralPath $file).Length -ne $entry.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.sha256) { throw "Application payload failed verification: $($entry.path)" }
    }
    foreach ($required in @(($ProductName + '.exe'), 'resources\app.asar')) {
      if (-not $names.ContainsKey((Join-Path $target $required))) { throw 'Required executable or app.asar missing from payload manifest.' }
    }
    $script:registry = Open-Registry $Scope
    if ((Read-Value $UninstallKey 'DisplayVersion') -ne $Version) { throw 'Installation version registration failed.' }
    if ((Read-Value $InstallKey 'InstallLocation') -ine $target) { throw 'Installation directory registration failed.' }
    $expectedUninstaller = Join-Path $target ('Uninstall ' + $ProductName + '.exe')
    if (-not [IO.File]::Exists($expectedUninstaller) -or (Read-Value $UninstallKey 'UninstallString') -notmatch ('^"' + [regex]::Escape($expectedUninstaller) + '"(?:\s|$)')) { throw 'Uninstaller registration failed.' }
    exit 0
  }
  if ($Action -in @('Commit','Rollback')) {
    if (-not [IO.File]::Exists($StatePath)) { exit 0 }
    Load-State
    if ($Action -eq 'Rollback') { Rollback-State; exit 0 }
    if ($script:state.Mode -eq 'Install') {
      foreach ($relative in @(($script:state.ProductName + '.exe'), 'resources\app.asar', ('Uninstall ' + $script:state.ProductName + '.exe'))) {
        if (-not [IO.File]::Exists((Join-Path $script:state.Target $relative))) { throw "Installation postflight failed: $relative" }
      }
      if ((Read-Value $script:state.UninstallKey 'DisplayVersion') -ne $script:state.Version) { throw 'Installation version registration failed.' }
      if ((Read-Value $script:state.InstallKey 'InstallLocation') -ine $script:state.Target) { throw 'Installation directory registration failed.' }
      $expectedUninstaller = Join-Path $script:state.Target ('Uninstall ' + $script:state.ProductName + '.exe')
      if ((Read-Value $script:state.UninstallKey 'UninstallString') -notmatch ('^"' + [regex]::Escape($expectedUninstaller) + '"(?:\s|$)')) { throw 'Uninstaller registration failed.' }
    } else {
      if ([IO.Directory]::Exists($script:state.Original)) { throw 'Application directory remains after uninstall.' }
      foreach ($key in @($script:state.InstallKey, $script:state.UninstallKey)) {
        $left = $script:registry.OpenSubKey($key)
        if ($null -ne $left) { $left.Dispose(); throw "Registration remains after uninstall: $key" }
      }
    }
    # Commit first. An antivirus race while removing the backup must never
    # turn a valid new installation into a partial rollback of deleted files.
    $script:state.Phase = 'Committed'
    Save-State
    if ([IO.Directory]::Exists($script:state.Backup)) {
      try { Assert-CanMoveTree $script:state.Backup; [IO.Directory]::Delete($script:state.Backup, $true) }
      catch { [IO.File]::WriteAllText((Join-Path $script:state.Recovery 'cleanup-warning.txt'), $_.Exception.Message, $utf8) }
    }
    exit 0
  }
  if ($InstallKey -notmatch '^Software\\[a-fA-F0-9-]{36}$' -or $UninstallKey -ne ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $InstallKey.Substring(9))) { throw 'Unexpected product registry identity.' }
  if ($ProductName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}$') { throw 'Unexpected product name.' }
  $target = Assert-AppPath $InstallDir $ProductName
  $script:registry = Open-Registry $Scope
  $registered = Read-Value $InstallKey 'InstallLocation'
  $oldVersion = Read-Value $UninstallKey 'DisplayVersion'
  $uninstall = Read-Value $UninstallKey 'UninstallString'
  # A terminated installer may have already written the new DisplayVersion.
  # Check recovery journals before version/hash dispatch can select upstream.
  Assert-NoPendingRecovery $target $Scope
  if (-not [string]::IsNullOrEmpty($registered)) {
    $registeredPath = Assert-AppPath $registered $ProductName
    if ($registeredPath -ine $target) { Assert-NoPendingRecovery $registeredPath $Scope }
  }
  if ($Action -eq 'Begin') {
    if ($oldVersion -notin @('3.0.0','3.0.1','3.0.2')) { exit 10 }
    if ((Read-Value $UninstallKey 'DisplayName') -notin @($ProductName, ($ProductName + ' ' + $oldVersion))) { throw 'Registered product name does not match.' }
  }
  if ([string]::IsNullOrEmpty($registered)) {
    if ($uninstall -match '^"([^"\r\n]+)"(?:\s|$)') { $registered = [IO.Path]::GetDirectoryName($matches[1]) }
    elseif ($Action -eq 'Remove') { $registered = $target }
    else { throw 'Cannot establish the registered application directory.' }
  }
  $original = Assert-AppPath $registered $ProductName
  if ($original -ine $target) { throw 'Changing the installation directory or scope during legacy recovery is not supported. Repair in the registered directory first.' }
  $uninstaller = Join-Path $original ('Uninstall ' + $ProductName + '.exe')
  if (-not [string]::IsNullOrEmpty($uninstall) -and $uninstall -notmatch ('^"' + [regex]::Escape($uninstaller) + '"(?:\s|$)')) { throw 'The registered uninstaller does not belong to the application directory.' }
  if ($Action -eq 'Begin' -and [IO.File]::Exists($uninstaller)) {
    $digest = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    # Published 3.0.0 / 3.0.1 plus the initial local 3.0.2 candidate whose
    # uninstaller showed a console for each transaction. Other local Repair
    # builds keep the normal uninstaller path unless their exact hash is known.
    if ($digest -notin @('ecec3c06013ec5e4dce3e396af41ea0c8c4029883d7b84026dc4331f9169fde2', '73b8e77aec6a55cf5458bc04783490432d8f5012f1845d9f1e82ba431ec99e3a', '44baed86633ebfb1d92c2246edc78c9e1c284eee8ac245e667c78bfad22a1bdb')) { exit 10 }
  }
  if ($Action -eq 'Remove' -and $original -ine $target) { throw 'Uninstaller target differs from its registered application directory.' }
  Assert-CanMoveTree $original
  $parent = [IO.Path]::GetDirectoryName($original)
  [void][IO.Directory]::CreateDirectory($parent)
  $recovery = Join-Path $parent ('.relay-recovery-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($recovery)
  [IO.File]::Copy($PSCommandPath, (Join-Path $recovery 'recover.ps1'))
  [IO.File]::WriteAllText((Join-Path $recovery 'recover.cmd'), '@echo off' + "`r`n" + 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0recover.ps1" -Action Rollback -StatePath "%~dp0recover.json"' + "`r`n" + 'set "RELAY_RECOVERY_EXIT=%ERRORLEVEL%"' + "`r`n" + 'pause' + "`r`n" + 'exit /b %RELAY_RECOVERY_EXIT%' + "`r`n", [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $recovery 'RECOVERY.txt'), 'Run recover.cmd to restore this interrupted installation. For an all-users installation, run recover.cmd as administrator. Keep this folder until recovery succeeds.', $utf8)
  $shortcuts = @($ShortcutPaths.Split('|') | Where-Object { $_ -ne '' } | Select-Object -Unique | ForEach-Object {
    Assert-PlainPath $_
    $exists = [IO.File]::Exists($_)
    @{ Path = $_; Exists = $exists; Bytes = $(if ($exists) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($_)) } else { '' }) }
  })
  $script:state = [ordered]@{
    Schema = 1; Phase = 'Prepared'; Mode = $(if ($Action -eq 'Remove') { 'Uninstall' } else { 'Install' });
    Scope = $Scope; ProductName = $ProductName; Version = $Version;
    Original = $original; Target = $target; Recovery = $recovery;
    Backup = (Join-Path $recovery 'application'); Journal = (Join-Path $recovery 'transaction.json');
    HadOriginal = [IO.Directory]::Exists($original); InstallKey = $InstallKey; UninstallKey = $UninstallKey;
    InstallRegistry = (Snapshot-Key $InstallKey); UninstallRegistry = (Snapshot-Key $UninstallKey);
    Shortcuts = $shortcuts
  }
  Save-State
  # The transaction always stays beside the application, even when TEMP is
  # on another volume. No files in Roaming or external workspaces are traversed.
  Set-Location -LiteralPath $parent
  if ($script:state.HadOriginal) { [IO.Directory]::Move($original, $script:state.Backup) }
  $script:state.Phase = 'Moved'
  Save-State
  exit 0
} catch {
  $message = $_.Exception.Message
  try { [IO.File]::WriteAllText($StatePath + '.error.txt', $message, $utf8) } catch {}
  try {
    $errorRecovery = $null
    if ($null -ne $script:state) { $errorRecovery = $script:state.Recovery }
    elseif ([IO.File]::Exists($StatePath)) {
      # Verify is also used for fresh installs, so it does not Load-State.
      # Locate an existing migration journal without replacing its registry
      # handle or changing the original error / transaction state.
      $errorPointer = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
      $errorJournal = [IO.File]::ReadAllText($errorPointer.Journal) | ConvertFrom-Json
      $errorRecovery = $errorJournal.Recovery
    }
    if (-not [string]::IsNullOrEmpty($errorRecovery)) {
      Assert-PlainPath $errorRecovery
      [IO.File]::WriteAllText((Join-Path $errorRecovery 'last-error.txt'), $message, $utf8)
    }
  } catch {}
  [Console]::Error.WriteLine($message)
  exit 2
} finally {
  if ($null -ne $script:registry) { $script:registry.Dispose() }
}
