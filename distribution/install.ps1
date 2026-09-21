#Requires -Version 5.1
<#
.SYNOPSIS
Downloads, verifies and installs Relay from its official GitHub releases.
.EXAMPLE
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1)))
.EXAMPLE
.\install.ps1 -Version 3.0.0 -DownloadOnly
#>
[CmdletBinding()]
param(
    [ValidatePattern('^v?\d+\.\d+\.\d+$')][string]$Version,
    [switch]$DownloadOnly,
    [switch]$Interactive,
    [string]$DownloadDirectory
)

function Test-RelayEnvironment {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This installer supports Windows x64 only.'
    }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') { throw 'A Windows x64 system is required for this release.' }
}

function Assert-RelayClosed {
    if (@(Get-Process -Name Relay -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Relay is running. Exit Relay (including the tray) and run this command again, or use -DownloadOnly.'
    }
}

function Read-RelayRegistryInstallations {
    # electron-builder UUID v5 for the stable appId com.relay.app.
    $guid = 'a5c32cb2-ebce-5411-8f64-015aaacf27f0'
    foreach ($scope in @('CurrentUser', 'LocalMachine')) {
      foreach ($view in @('Registry64', 'Registry32')) {
        $base = $null; $install = $null; $uninstall = $null
        try {
            $hive = [Microsoft.Win32.RegistryHive]::$scope
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::$view)
            $install = $base.OpenSubKey("Software\$guid")
            $uninstall = $base.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
            if ($install -or $uninstall) {
                $location = ''; $displayVersion = ''
                if ($install) { $location = [string]$install.GetValue('InstallLocation', '') }
                $hasPrimaryLocation = -not [string]::IsNullOrWhiteSpace($location)
                if ($uninstall) {
                    $displayVersion = [string]$uninstall.GetValue('DisplayVersion', '')
                    $uninstallLocation = [string]$uninstall.GetValue('InstallLocation', '')
                    if (-not $location) { $location = $uninstallLocation }
                    if ($location -and $uninstallLocation -and $location.TrimEnd('\') -ine $uninstallLocation.TrimEnd('\')) {
                        throw 'Relay installation paths disagree. Use the interactive installer to repair the registration.'
                    }
                }
                [pscustomobject]@{ Scope = $scope; Location = $location; Version = $displayVersion; Recognized = $true; RegistryView = $view; InstallLocationRegistered = $hasPrimaryLocation }
            }
            # Detect older/foreign product identities without guessing where to migrate them.
            $root = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
            if ($root) {
                try {
                    foreach ($keyName in $root.GetSubKeyNames()) {
                        if ($keyName -eq $guid) { continue }
                        try { $entry = $root.OpenSubKey($keyName) }
                        catch [UnauthorizedAccessException] { continue }
                        catch [Security.SecurityException] { continue }
                        if (-not $entry) { continue }
                        try {
                            if ([string]$entry.GetValue('DisplayName', '') -match '^Relay(?:\s+\d[\d.]*|\s*\(.*\))?$') {
                                [pscustomobject]@{ Scope = $scope; Location = [string]$entry.GetValue('InstallLocation', ''); Version = [string]$entry.GetValue('DisplayVersion', ''); Recognized = $false; RegistryView = $view }
                            }
                        } finally { $entry.Dispose() }
                    }
                } finally { $root.Dispose() }
            }
        } finally {
            if ($uninstall) { $uninstall.Dispose() }
            if ($install) { $install.Dispose() }
            if ($base) { $base.Dispose() }
        }
      }
    }
}

function Get-RelayVersionNumber {
    param([string]$Value)
    if ($Value -match '^v?(\d+\.\d+\.\d+)(?:\.0)?$') { return $Matches[1] }
    return ''
}

function Get-RelayInstallations {
    $seen = @{}
    foreach ($record in @(Read-RelayRegistryInstallations)) {
        $location = ([string]$record.Location).TrimEnd('\')
        $version = Get-RelayVersionNumber $record.Version
        # Some HKCU keys are shared between registry views. Do not report the
        # same registration twice as a conflicting second installation.
        $key = "$($record.Scope)|$location|$version|$($record.Recognized)"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [pscustomobject]@{
            Scope = $record.Scope; Location = $location
            Version = $version
            Recognized = $record.Recognized; RegistryView = $record.RegistryView
            InstallLocationRegistered = $record.InstallLocationRegistered
        }
    }
}

function Get-RelayExecutableVersion {
    param([string]$Path)
    return Get-RelayVersionNumber ([Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion)
}

function Assert-RelayInstallScope {
    param([object[]]$Installations, [string]$TargetVersion)
    if (@($Installations).Count -gt 1) {
        throw 'Multiple Relay installations are registered. Use -DownloadOnly and manage them with the installer manually.'
    }
    foreach ($item in $Installations) {
        if ($item.Recognized -eq $false -or $item.RegistryView -eq 'Registry32' -or $item.InstallLocationRegistered -eq $false -or -not $item.Version -or -not [IO.Path]::IsPathRooted($item.Location)) {
            throw 'The existing Relay installation cannot be upgraded automatically. Use -DownloadOnly and the installer manually; no data has been moved.'
        }
        $installed = $null
        if ([version]::TryParse($item.Version, [ref]$installed) -and $installed -gt [version]$TargetVersion) {
            throw "A newer Relay version ($($item.Version)) is already installed. Automatic downgrade is not supported."
        }
        $exe = Join-Path $item.Location 'Relay.exe'
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            $actualVersion = Get-RelayExecutableVersion $exe
            if ($actualVersion -and [version]$actualVersion -gt [version]$TargetVersion) {
                throw "A newer Relay executable ($actualVersion) is already installed. Automatic downgrade is not supported."
            }
        }
    }
}

function Get-RelayReleaseAsset {
    param([object]$Release, [string]$RequestedVersion)
    if ($Release.draft -or $Release.prerelease) { throw 'Only published stable Relay releases are supported.' }
    if ([string]$Release.tag_name -notmatch '^v?(\d+\.\d+\.\d+)$') { throw 'The release tag is invalid.' }
    $number = $Matches[1]
    if ($RequestedVersion -and $number -ne $RequestedVersion.TrimStart('v')) { throw 'The returned release does not match the requested version.' }
    $name = "Relay-$number-Setup.exe"
    $assets = @($Release.assets | Where-Object { $_.name -ceq $name })
    if ($assets.Count -ne 1) { throw "The release must contain exactly one $name asset." }
    $asset = $assets[0]
    $expectedUrl = "https://github.com/g1at/relay-updates/releases/download/$($Release.tag_name)/$name"
    if ($asset.state -ne 'uploaded' -or [long]$asset.size -le 0 -or $asset.browser_download_url -cne $expectedUrl) {
        throw 'The installer asset is incomplete or its download URL is unexpected.'
    }
    if ([string]$asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
        throw 'GitHub did not provide a SHA-256 digest. The installer will not be executed without verification.'
    }
    [pscustomobject]@{ Version = $number; Name = $name; Url = $expectedUrl; Size = [long]$asset.size; Hash = $Matches[1].ToLowerInvariant(); CloseRunningAppGuard = $false }
}

function Get-RelayManifestAsset {
    param([object]$Manifest, [string]$RequestedVersion)
    if ($Manifest.schemaVersion -ne 1 -or $Manifest.platform -cne 'win32' -or $Manifest.arch -cne 'x64') {
        throw 'The Relay install manifest schema or platform is invalid.'
    }
    $number = Get-RelayVersionNumber $Manifest.version
    if (-not $number -or $Manifest.version -cne $number -or $Manifest.tag -cne "v$number") { throw 'The manifest version is invalid.' }
    $installer = $Manifest.installer
    $asset = Get-RelayReleaseAsset ([pscustomobject]@{
        draft = $false; prerelease = $false; tag_name = $Manifest.tag
        assets = @([pscustomobject]@{ name = $installer.name; state = 'uploaded'; size = $installer.size; browser_download_url = $installer.url; digest = 'sha256:' + $installer.sha256 })
    }) $RequestedVersion
    $asset.CloseRunningAppGuard = $installer.closeRunningAppGuard -is [bool] -and $installer.closeRunningAppGuard
    return $asset
}

function Invoke-RelayJson {
    param([string]$Uri, [hashtable]$Headers = @{})
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try { return Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec 15 -ErrorAction Stop }
        catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($attempt -eq 3 -or $status -eq 404 -or $status -eq 401) { throw }
            Write-Warning "Release lookup attempt $attempt failed. Retrying..."
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

function Get-RelayAsset {
    param([string]$Version)
    $manifestUrl = 'https://raw.githubusercontent.com/g1at/relay-updates/main/latest.json'
    $apiUrl = 'https://api.github.com/repos/g1at/relay-updates/releases/latest'
    if ($Version) {
        $number = $Version.TrimStart('v')
        $manifestUrl = "https://raw.githubusercontent.com/g1at/relay-updates/main/releases/v$number.json"
        $apiUrl = "https://api.github.com/repos/g1at/relay-updates/releases/tags/v$number"
    }
    try { $manifest = Invoke-RelayJson $manifestUrl }
    catch {
        Write-Warning 'The static release manifest is unavailable. Checking GitHub Releases...'
        try { $release = Invoke-RelayJson $apiUrl @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Relay-Installer'; 'X-GitHub-Api-Version' = '2022-11-28' } }
        catch { throw 'Cannot retrieve the Relay release. Check your connection/proxy and retry, or download from https://github.com/g1at/relay-updates/releases/latest.' }
        return Get-RelayReleaseAsset $release $Version
    }
    # A retrieved but invalid manifest must not silently bypass verification.
    return Get-RelayManifestAsset $manifest $Version
}

function Test-RelayDownload {
    param([string]$Path, [object]$Asset)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne $Asset.Size) { return $false }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Asset.Hash
}

function Get-RelayDownloadResponse {
    param([string]$Url, [long]$Offset)
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.UserAgent = 'Relay-Installer'
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $request.AutomaticDecompression = [Net.DecompressionMethods]::None
    if ($Offset -gt 0) { $request.AddRange($Offset) }
    try { return $request.GetResponse() }
    catch {
        if ($_.Exception.Response) { $_.Exception.Response.Close() }
        throw
    }
}

function Save-RelayDownload {
    param([object]$Asset, [string]$Directory)
    $null = New-Item -ItemType Directory -Path $Directory -Force
    $target = Join-Path $Directory $Asset.Name
    if (Test-RelayDownload $target $Asset) {
        Write-Host 'Using the verified cached installer.'
        return $target
    }
    # The hash binds resumable bytes to one immutable release asset.
    $partial = Join-Path $Directory ($Asset.Name + '.' + $Asset.Hash.Substring(0, 16) + '.part')
    $lock = $null
    try {
        try { $lock = [IO.File]::Open($partial + '.lock', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Another Relay download is using this cache. Wait for it to finish or choose a different -DownloadDirectory.' }
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $response = $null; $inputStream = $null; $outputStream = $null
            try {
                if (Test-RelayDownload $partial $Asset) {
                    Move-Item -LiteralPath $partial -Destination $target -Force
                    return $target
                }
                $offset = 0L
                if (Test-Path -LiteralPath $partial) {
                    $offset = (Get-Item -LiteralPath $partial).Length
                    if ($offset -ge $Asset.Size) { Remove-Item -LiteralPath $partial -Force; $offset = 0L }
                }
                $response = Get-RelayDownloadResponse $Asset.Url $offset
                $status = [int]$response.StatusCode
                if ($status -eq 206) {
                    $range = [string]$response.Headers['Content-Range']
                    if ($range -notmatch '^bytes (\d+)-(\d+)/(\d+)$') { throw 'The download Content-Range is invalid.' }
                    $rangeStart = [long]$Matches[1]; $rangeEnd = [long]$Matches[2]; $rangeTotal = [long]$Matches[3]
                    if ($rangeStart -ne $offset -or $rangeTotal -ne $Asset.Size -or $rangeEnd -lt $rangeStart -or $rangeEnd -ge $rangeTotal) { throw 'The download Content-Range does not match this installer.' }
                    if ($response.ContentLength -ge 0 -and $response.ContentLength -ne ($rangeEnd - $rangeStart + 1)) { throw 'The ranged download length is invalid.' }
                } elseif ($status -eq 200) {
                    $offset = 0L # Servers without range support must replace, never append.
                    if ($response.ContentLength -ge 0 -and $response.ContentLength -ne $Asset.Size) { throw 'The download length does not match the release.' }
                } else { throw "Unexpected download HTTP status $status." }
                $mode = [IO.FileMode]::Create
                if ($offset -gt 0) { $mode = [IO.FileMode]::Append }
                $outputStream = [IO.File]::Open($partial, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $inputStream = $response.GetResponseStream()
                $buffer = New-Object byte[] 131072
                $total = $offset
                $progressClock = [Diagnostics.Stopwatch]::StartNew()
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($total + $count -gt $Asset.Size) { throw 'The server sent more bytes than the release size.' }
                    $outputStream.Write($buffer, 0, $count); $total += $count
                    if ($progressClock.ElapsedMilliseconds -ge 250) {
                        Write-Progress -Activity "Downloading Relay $($Asset.Version)" -Status ("{0:N1} / {1:N1} MiB" -f ($total / 1MB), ($Asset.Size / 1MB)) -PercentComplete ([int](100 * $total / $Asset.Size))
                        $progressClock.Restart()
                    }
                }
                $outputStream.Dispose(); $outputStream = $null
                if ($total -lt $Asset.Size) { throw 'The download was interrupted; partial bytes have been saved for resume.' }
                if (-not (Test-RelayDownload $partial $Asset)) {
                    Remove-Item -LiteralPath $partial -Force
                    throw 'The downloaded installer failed size or SHA-256 verification.'
                }
                Move-Item -LiteralPath $partial -Destination $target -Force
                Write-Host 'SHA-256 verification passed.'
                return $target
            } catch {
                if ($attempt -eq 3) { throw }
                Write-Warning "Download attempt $attempt failed. Retrying..."
                Start-Sleep -Seconds (2 * $attempt)
            } finally {
                if ($inputStream) { $inputStream.Dispose() }
                if ($outputStream) { $outputStream.Dispose() }
                if ($response) { $response.Close() }
            }
        }
    } finally {
        Write-Progress -Activity "Downloading Relay $($Asset.Version)" -Completed
        if ($lock) { $lock.Dispose() }
    }
}

function Confirm-RelayInstallation {
    param([string]$ExpectedVersion, [string]$ExpectedScope, [string]$ExpectedLocation)
    $items = @(Get-RelayInstallations | Where-Object { $_.Scope -eq $ExpectedScope -and $_.Version -eq $ExpectedVersion })
    if ($items.Count -ne 1 -or -not [IO.Path]::IsPathRooted($items[0].Location)) {
        throw 'The installer exited, but the expected Relay registration was not found. Installation may have been canceled.'
    }
    if ($ExpectedLocation -and $items[0].Location.TrimEnd('\') -ine $ExpectedLocation.TrimEnd('\')) { throw 'Relay was not installed in its original directory. Check the installer result manually.' }
    $exe = Join-Path $items[0].Location 'Relay.exe'
    $archive = Join-Path $items[0].Location 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        throw 'The installed Relay files are incomplete.'
    }
    $productVersion = Get-RelayExecutableVersion $exe
    if ($productVersion -ne $ExpectedVersion -and $productVersion -ne "$ExpectedVersion.0") {
        throw 'The installed Relay executable version does not match the requested release.'
    }
    return $items[0].Location
}

function Install-Relay {
    [CmdletBinding()]
    param([string]$Version, [switch]$DownloadOnly, [switch]$Interactive, [string]$DownloadDirectory)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'Continue'
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        Test-RelayEnvironment
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        Write-Host 'Checking the official Relay release...'
        $asset = Get-RelayAsset $Version
        $before = @()
        if (-not $DownloadOnly) {
            $before = @(Get-RelayInstallations)
            Assert-RelayInstallScope $before $asset.Version
            if (-not $Interactive -and $before.Count -eq 1 -and $before[0].Version -eq $asset.Version) {
                try { $location = Confirm-RelayInstallation $asset.Version $before[0].Scope $before[0].Location }
                catch { throw "The registered Relay installation is incomplete. Run with -Interactive to repair it. $($_.Exception.Message)" }
                Write-Host "Relay $($asset.Version) is already up to date at $location."
                return
            }
        }
        if (-not $DownloadDirectory) { $DownloadDirectory = Join-Path $env:LOCALAPPDATA 'Relay\Installers' }
        $DownloadDirectory = [IO.Path]::GetFullPath($DownloadDirectory)
        Write-Host ("Downloading Relay {0} ({1:N1} MiB)..." -f $asset.Version, ($asset.Size / 1MB))
        $installer = Save-RelayDownload $asset $DownloadDirectory
        if ($DownloadOnly) { Write-Host "Download complete: $installer"; return $installer }
        $before = @(Get-RelayInstallations)
        Assert-RelayInstallScope $before $asset.Version
        if (-not $Interactive -and $before.Count -eq 1 -and $before[0].Version -eq $asset.Version) {
            $location = Confirm-RelayInstallation $asset.Version $before[0].Scope $before[0].Location
            Write-Host "Relay $($asset.Version) is already up to date at $location."
            return
        }
        # Recheck the exact file just before execution, including cached files.
        if (-not (Test-RelayDownload $installer $asset)) { throw 'Installer verification changed before execution.' }
        Assert-RelayClosed
        $scope = 'CurrentUser'
        $expectedLocation = ''
        if ($before.Count -eq 1) { $scope = $before[0].Scope; $expectedLocation = $before[0].Location }
        if (-not $asset.CloseRunningAppGuard) { Write-Warning 'This release uses the legacy installer. Keep Relay closed until installation finishes; the installer can otherwise close a running instance.' }
        Write-Host 'Installing Relay. An existing machine-wide installation may require UAC approval...'
        $start = @{ FilePath = $installer; Wait = $true; PassThru = $true }
        $arguments = @()
        if (-not $Interactive) { $arguments += '/S' }
        if ($asset.CloseRunningAppGuard) { $arguments += '--relay-no-close' }
        if ($arguments.Count) { $start.ArgumentList = $arguments }
        $process = Start-Process @start
        if ($process.ExitCode -ne 0) { throw "The Relay installer failed or was canceled (exit code $($process.ExitCode))." }
        $location = Confirm-RelayInstallation $asset.Version $scope $expectedLocation
        Write-Host "Relay $($asset.Version) is installed at $location. Open Relay from the Start menu."
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
    }
}

Install-Relay @PSBoundParameters
