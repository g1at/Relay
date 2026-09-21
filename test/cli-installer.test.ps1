#Requires -Version 5.1
# Run from the repository root:
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/cli-installer.test.ps1
# No installer is launched, no network request is sent, and no registry is read.
$ErrorActionPreference = 'Stop'

& {
    $repository = Split-Path -Parent $PSScriptRoot
    $source = Join-Path $repository 'distribution\install.ps1'
    $fixtureRoot = Join-Path $repository '.codex-tmp\cli-installer-tests'
    $null = New-Item -ItemType Directory -Path $fixtureRoot -Force
    $runRoot = Join-Path $fixtureRoot ([guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $runRoot

    $tokens = $null; $parseErrors = $null
    $sourceAst = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count) { throw ('Installer parse failed: ' + ($parseErrors -join '; ')) }
    # Do not dot-source the installer: its final Install-Relay invocation must
    # never execute. Direct EndBlock children exclude nested function nodes.
    $definitions = @($sourceAst.EndBlock.Statements | Where-Object {
        $_ -is [Management.Automation.Language.FunctionDefinitionAst]
    })
    foreach ($definition in $definitions) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $realConfirm = ${function:Confirm-RelayInstallation}
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    $fixtureBytes = [byte[]](82, 101, 108, 97, 121, 13, 10, 42)
    $corruptBytes = [byte[]](82, 101, 108, 97, 121, 13, 10, 43)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fixtureHash = ([BitConverter]::ToString($sha.ComputeHash($fixtureBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $results = New-Object 'System.Collections.Generic.List[object]'
    $state = @{}
    $testIndex = 0

    function Assert-True {
        param([bool]$Condition, [string]$Message)
        if (-not $Condition) { throw $Message }
    }
    function Assert-Equal {
        param($Actual, $Expected, [string]$Message)
        if ($Actual -cne $Expected) { throw ("{0}: expected <{1}>, got <{2}>" -f $Message, $Expected, $Actual) }
    }
    function Assert-Throws {
        param([scriptblock]$Action, [string]$Pattern)
        $caught = $null
        try { $null = & $Action } catch { $caught = $_ }
        if (-not $caught) { throw "Expected exception matching <$Pattern>, but the operation succeeded." }
        if ($caught.Exception.Message -notmatch $Pattern) {
            throw ("Expected exception matching <{0}>, got <{1}>" -f $Pattern, $caught.Exception.Message)
        }
    }
    function New-Release {
        [pscustomobject]@{
            draft = $false; prerelease = $false; tag_name = 'v3.0.0'
            assets = @([pscustomobject]@{
                name = 'Relay-3.0.0-Setup.exe'; state = 'uploaded'; size = [long]$fixtureBytes.Length
                browser_download_url = 'https://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe'
                digest = 'sha256:' + $fixtureHash
            })
        }
    }
    function New-Manifest {
        [pscustomobject]@{
            schemaVersion = 1; version = '3.0.0'; tag = 'v3.0.0'; platform = 'win32'; arch = 'x64'
            installer = [pscustomobject]@{
                name = 'Relay-3.0.0-Setup.exe'
                url = 'https://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe'
                size = [long]$fixtureBytes.Length; sha256 = $fixtureHash; closeRunningAppGuard = $false
            }
        }
    }
    function New-Installation {
        param([string]$Version = '2.1.0', [string]$Scope = 'CurrentUser', [switch]$Incomplete)
        $location = Join-Path $state.Directory ('installed-' + $Scope)
        $null = New-Item -ItemType Directory -Path (Join-Path $location 'resources') -Force
        if (-not $Incomplete) {
            $exe = Join-Path $location 'Relay.exe'
            [IO.File]::WriteAllBytes($exe, $fixtureBytes)
            [IO.File]::WriteAllBytes((Join-Path $location 'resources\app.asar'), $fixtureBytes)
            $state.ExecutableVersions[$exe] = $Version
        }
        return [pscustomobject]@{ Scope = $Scope; Location = $location; Version = $Version; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true }
    }
    function New-DownloadResponse {
        param([byte[]]$Bytes, [int]$StatusCode = 200, [string]$ContentRange = '', [long]$ContentLength = -1)
        if ($ContentLength -lt 0) { $ContentLength = $Bytes.Length }
        $response = [pscustomobject]@{
            StatusCode = $StatusCode; ContentLength = $ContentLength
            Headers = @{ 'Content-Range' = $ContentRange }
            Stream = [IO.MemoryStream]::new($Bytes, $false); Closed = $false
        }
        $response | Add-Member -MemberType ScriptMethod -Name GetResponseStream -Value { return $this.Stream }
        $response | Add-Member -MemberType ScriptMethod -Name Close -Value { $this.Closed = $true; $this.Stream.Dispose() }
        return $response
    }
    function Get-PartialPath {
        param($Asset)
        return Join-Path $state.Directory ($Asset.Name + '.' + $Asset.Hash.Substring(0, 16) + '.part')
    }
    function Reset-Fixture {
        param([int]$Index)
        $state.Clear()
        $state.Directory = Join-Path $runRoot ([string]$Index)
        $null = New-Item -ItemType Directory -Path $state.Directory
        $state.Release = New-Release
        $state.Manifest = New-Manifest
        $state.DownloadBytes = $fixtureBytes
        $state.DownloadCalls = 0; $state.ReleaseCalls = 0; $state.ProcessCalls = 0
        $state.ClosedChecks = 0; $state.InstallationReads = 0; $state.EnvironmentChecks = 0
        $state.ConfirmCalls = 0; $state.SleepCalls = 0
        $state.Installations = @(); $state.PostInstallations = @()
        $state.RunningAtChecks = @(); $state.TamperAtCheck = 0
        $state.ExitCode = 0; $state.ConfirmMode = 'stub'
        $state.DownloadFailure = $false
        $state.ManifestCalls = 0; $state.ApiCalls = 0
        $state.ManifestFailures = 0; $state.ApiFailures = 0
        $state.JsonUris = New-Object 'System.Collections.Generic.List[string]'
        $state.DownloadOffsets = New-Object 'System.Collections.Generic.List[long]'
        $state.DownloadResponses = New-Object 'System.Collections.Generic.List[object]'
        $state.ResponsePlan = New-Object 'System.Collections.Generic.Queue[object]'
        $state.InstallationSequence = New-Object 'System.Collections.Generic.Queue[object]'
        $state.ExecutableVersions = @{}
        $state.TamperOnInstallationRead = 0
    }
    function Invoke-Case {
        param([string]$Name, [scriptblock]$Action)
        $script:testIndex++
        Reset-Fixture $script:testIndex
        try {
            & $Action
            Assert-Equal ([Net.ServicePointManager]::SecurityProtocol) $originalTls 'TLS setting must be restored'
            $results.Add([pscustomobject]@{ Name = $Name; Passed = $true })
            Write-Host ('PASS ' + $Name)
        } catch {
            $results.Add([pscustomobject]@{ Name = $Name; Passed = $false; Error = $_.Exception.Message })
            Write-Host ('FAIL ' + $Name + ': ' + $_.Exception.Message)
        }
    }

    # Every external boundary is replaced before any production function runs.
    # Mock HTTP responses expose tiny memory streams; the real downloader does
    # file I/O, locking, partial-file handling, and SHA-256 verification.
    function Test-RelayEnvironment { $state.EnvironmentChecks++ }
    function Read-RelayRegistryInstallations {
        $state.InstallationReads++
        if ($state.TamperOnInstallationRead -eq $state.InstallationReads) {
            [IO.File]::WriteAllBytes((Join-Path $state.Directory 'Relay-3.0.0-Setup.exe'), $corruptBytes)
        }
        if ($state.InstallationSequence.Count -gt 0) { return $state.InstallationSequence.Dequeue() }
        if ($state.ProcessCalls -gt 0) { return $state.PostInstallations }
        return $state.Installations
    }
    function Get-RelayExecutableVersion {
        param([string]$Path)
        return $state.ExecutableVersions[$Path]
    }
    function Get-Process {
        [CmdletBinding()]
        param([string]$Name)
        Assert-Equal $Name 'Relay' 'Only the Relay process may be inspected'
        $state.ClosedChecks++
        if ($state.TamperAtCheck -eq $state.ClosedChecks) {
            [IO.File]::WriteAllBytes((Join-Path $state.Directory 'Relay-3.0.0-Setup.exe'), $corruptBytes)
        }
        if ($state.RunningAtChecks -contains $state.ClosedChecks) { [pscustomobject]@{ Id = 123; Name = 'Relay' } }
    }
    function Invoke-RestMethod {
        [CmdletBinding()]
        param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
        $state.ReleaseCalls++; $state.ReleaseUri = $Uri; $state.ReleaseHeaders = $Headers
        Assert-Equal $TimeoutSec 15 'Metadata request timeout must remain bounded'
        $state.JsonUris.Add($Uri)
        if ($Uri.StartsWith('https://raw.githubusercontent.com/g1at/relay-updates/main/')) {
            $state.ManifestCalls++
            if ($state.ManifestCalls -le $state.ManifestFailures) { throw 'Fixture manifest request failure' }
            return $state.Manifest
        }
        Assert-True ($Uri.StartsWith('https://api.github.com/repos/g1at/relay-updates/releases/')) 'Unexpected metadata endpoint'
        $state.ApiCalls++
        if ($state.ApiCalls -le $state.ApiFailures) { throw 'Fixture API request failure' }
        return $state.Release
    }
    function Get-RelayDownloadResponse {
        param([string]$Url, [long]$Offset)
        $state.DownloadCalls++; $state.DownloadUri = $Url
        $state.DownloadOffsets.Add($Offset)
        if ($state.DownloadFailure) { throw 'Fixture network failure' }
        if ($state.ResponsePlan.Count -gt 0) {
            $planned = $state.ResponsePlan.Dequeue()
            if ($planned -is [scriptblock]) { return (& $planned $Offset) }
            $state.DownloadResponses.Add($planned)
            return $planned
        }
        $bytes = $state.DownloadBytes
        if ($Offset -gt 0) {
            $remaining = [byte[]]$bytes[$Offset..($bytes.Length - 1)]
            $response = New-DownloadResponse -Bytes $remaining -StatusCode 206 -ContentRange ("bytes {0}-{1}/{2}" -f $Offset, ($bytes.Length - 1), $bytes.Length)
        } else { $response = New-DownloadResponse -Bytes $bytes }
        $state.DownloadResponses.Add($response)
        return $response
    }
    function Start-Sleep {
        param([int]$Seconds)
        $state.SleepCalls++
        Assert-True ($Seconds -eq 2 -or $Seconds -eq 4) 'Unexpected retry delay'
    }
    function Start-Process {
        [CmdletBinding()]
        param([string]$FilePath, [switch]$Wait, [switch]$PassThru, [string[]]$ArgumentList)
        $state.ProcessCalls++
        $state.Start = @{ FilePath = $FilePath; Wait = $Wait.IsPresent; PassThru = $PassThru.IsPresent
            HasArguments = $PSBoundParameters.ContainsKey('ArgumentList'); Arguments = @($ArgumentList) }
        return [pscustomobject]@{ ExitCode = $state.ExitCode }
    }
    function Confirm-RelayInstallation {
        param([string]$ExpectedVersion, [string]$ExpectedScope, [string]$ExpectedLocation)
        $state.ConfirmCalls++; $state.ExpectedVersion = $ExpectedVersion; $state.ExpectedScope = $ExpectedScope
        $state.ExpectedLocation = $ExpectedLocation
        if ($state.ConfirmMode -eq 'real') { return (& $realConfirm $ExpectedVersion $ExpectedScope $ExpectedLocation) }
        return $state.Directory
    }

    try {
        Invoke-Case 'documented one-line commands parse without executing them' {
            $readme = Join-Path $repository 'distribution\README.md'
            $commands = @([IO.File]::ReadAllLines($readme) | Where-Object {
                $_ -match '^& \(\[scriptblock\]::Create\(\(irm '
            })
            Assert-True ($commands.Count -gt 0) 'README must contain a copyable one-line installer command'
            foreach ($command in $commands) {
                $commandTokens = $null; $commandErrors = $null
                $commandAst = [Management.Automation.Language.Parser]::ParseInput($command, [ref]$commandTokens, [ref]$commandErrors)
                Assert-Equal @($commandErrors).Count 0 'Documented command must parse in Windows PowerShell 5.1'
                Assert-Equal $commandAst.EndBlock.Statements.Count 1 'Documented command must remain one invocation'
                Assert-Equal $commandAst.EndBlock.Statements[0].PipelineElements[0].InvocationOperator ([Management.Automation.Language.TokenKind]::Ampersand) 'Documented command must invoke its parameterized scriptblock'
            }
            Assert-Equal $state.ReleaseCalls 0 'Parsing must not request a release'
            Assert-Equal $state.DownloadCalls 0 'Parsing must not download anything'
            Assert-Equal $state.ProcessCalls 0 'Parsing must not run an installer'
        }
        Invoke-Case 'valid release and requested version select the exact asset' {
            $asset = Get-RelayReleaseAsset (New-Release) 'v3.0.0'
            Assert-Equal $asset.Version '3.0.0' 'Release version'
            Assert-Equal $asset.Hash $fixtureHash 'SHA-256 digest'
            Assert-Equal $asset.Size $fixtureBytes.Length 'Download length'
            Assert-Equal $asset.Name 'Relay-3.0.0-Setup.exe' 'Exact installer name'
        }
        Invoke-Case 'static manifest validates version platform hash and installer guard' {
            $manifest = New-Manifest
            $manifest.installer.closeRunningAppGuard = $true
            $asset = Get-RelayManifestAsset $manifest 'v3.0.0'
            Assert-Equal $asset.Hash $fixtureHash 'Manifest hash'
            Assert-Equal $asset.Version '3.0.0' 'Manifest version'
            Assert-True $asset.CloseRunningAppGuard 'Explicit boolean guard capability'
            $manifest.installer.closeRunningAppGuard = 'true'
            Assert-True (-not (Get-RelayManifestAsset $manifest).CloseRunningAppGuard) 'A string cannot enable installer guard arguments'
        }
        Invoke-Case 'invalid static manifests fail closed without API fallback' {
            foreach ($change in @(
                { $state.Manifest.schemaVersion = 2 },
                { $state.Manifest.platform = 'linux' },
                { $state.Manifest.arch = 'arm64' },
                { $state.Manifest.version = '3.0.0-rc.1' },
                { $state.Manifest.tag = 'v2.1.0' },
                { $state.Manifest.installer.url = 'https://evil.example/Relay.exe' },
                { $state.Manifest.installer.sha256 = '' },
                { $state.Manifest.installer.size = 0 }
            )) {
                $state.Manifest = New-Manifest
                & $change
                Assert-Throws { Get-RelayAsset } 'manifest|release|SHA-256|incomplete|URL'
            }
            Assert-Equal $state.ApiCalls 0 'Invalid retrieved manifests cannot fall back to less restrictive metadata'
            Assert-Equal $state.DownloadCalls 0 'Invalid metadata must not download'
            Assert-Equal $state.ProcessCalls 0 'Invalid metadata must never execute'
        }
        Invoke-Case 'static latest and pinned manifests avoid GitHub API calls' {
            $null = Get-RelayAsset
            Assert-Equal $state.ReleaseUri 'https://raw.githubusercontent.com/g1at/relay-updates/main/latest.json' 'Static latest endpoint'
            $null = Get-RelayAsset 'v3.0.0'
            Assert-Equal $state.ReleaseUri 'https://raw.githubusercontent.com/g1at/relay-updates/main/releases/v3.0.0.json' 'Static pinned endpoint'
            Assert-Equal $state.ApiCalls 0 'Available static metadata avoids API quota'
        }
        Invoke-Case 'static metadata transient failure retries before success' {
            $state.ManifestFailures = 2
            $asset = Get-RelayAsset
            Assert-Equal $asset.Hash $fixtureHash 'Retried manifest result'
            Assert-Equal $state.ManifestCalls 3 'Static lookup retry count'
            Assert-Equal $state.ApiCalls 0 'Recovered static source must not call API'
            Assert-Equal $state.SleepCalls 2 'Bounded retry delays'
        }
        Invoke-Case 'unavailable static metadata falls back to retried pinned GitHub API' {
            $state.ManifestFailures = 3; $state.ApiFailures = 2
            $asset = Get-RelayAsset 'v3.0.0'
            Assert-Equal $asset.Version '3.0.0' 'API fallback version'
            Assert-Equal $state.ManifestCalls 3 'Static requests exhaust their retry budget'
            Assert-Equal $state.ApiCalls 3 'API retry count'
            Assert-Equal $state.ReleaseUri 'https://api.github.com/repos/g1at/relay-updates/releases/tags/v3.0.0' 'Pinned fallback endpoint'
            Assert-True (-not $asset.CloseRunningAppGuard) 'API fallback cannot assume a custom installer capability'
        }
        Invoke-Case 'both metadata sources failing never downloads or executes' {
            $state.ManifestFailures = 3; $state.ApiFailures = 3
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Cannot retrieve the Relay release'
            Assert-Equal $state.ManifestCalls 3 'Static failure attempts'
            Assert-Equal $state.ApiCalls 3 'API failure attempts'
            Assert-Equal $state.DownloadCalls 0 'No asset means no download'
            Assert-Equal $state.ProcessCalls 0 'No asset means no execution'
        }
        Invoke-Case 'API fallback still rejects an unverified or wrong-version release' {
            $state.ManifestFailures = 99
            $state.Release.assets[0].digest = $null
            Assert-Throws { Get-RelayAsset } 'SHA-256 digest'
            $state.Release = New-Release
            Assert-Throws { Get-RelayAsset '2.1.0' } 'does not match the requested version'
            Assert-Equal $state.DownloadCalls 0 'Invalid fallback metadata must not download'
        }
        Invoke-Case 'malicious and altered URLs are rejected' {
            foreach ($url in @(
                'http://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe',
                'https://github.com.evil.example/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe',
                'https://github.com@evil.example/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe',
                'https://github.com/other/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe',
                'https://github.com/g1at/relay-updates/releases/download/v3.0.0/../Relay-3.0.0-Setup.exe',
                'https://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe?redirect=evil'
            )) {
                $release = New-Release; $release.assets[0].browser_download_url = $url
                Assert-Throws { Get-RelayReleaseAsset $release } 'download URL is unexpected'
            }
        }
        Invoke-Case 'missing or invalid release digest is rejected' {
            foreach ($digest in @($null, '', 'sha256:abc', ('sha512:' + $fixtureHash), ('sha256:' + ('g' * 64)))) {
                $release = New-Release; $release.assets[0].digest = $digest
                Assert-Throws { Get-RelayReleaseAsset $release } 'SHA-256 digest'
            }
        }
        Invoke-Case 'draft and prerelease metadata are rejected' {
            $release = New-Release; $release.prerelease = $true
            Assert-Throws { Get-RelayReleaseAsset $release } 'published stable'
            $release = New-Release; $release.draft = $true
            Assert-Throws { Get-RelayReleaseAsset $release } 'published stable'
        }
        Invoke-Case 'invalid tags and requested-version mismatch are rejected' {
            $release = New-Release; $release.tag_name = 'v3.0.0-rc.1'
            Assert-Throws { Get-RelayReleaseAsset $release } 'tag is invalid'
            Assert-Throws { Get-RelayReleaseAsset (New-Release) '2.1.0' } 'does not match the requested version'
        }
        Invoke-Case 'missing duplicate incomplete and wrong-sized assets are rejected' {
            $release = New-Release; $release.assets = @()
            Assert-Throws { Get-RelayReleaseAsset $release } 'exactly one'
            $release = New-Release; $release.assets = @($release.assets[0], $release.assets[0])
            Assert-Throws { Get-RelayReleaseAsset $release } 'exactly one'
            $release = New-Release; $release.assets[0].state = 'new'
            Assert-Throws { Get-RelayReleaseAsset $release } 'incomplete'
            $release = New-Release; $release.assets[0].size = 0
            Assert-Throws { Get-RelayReleaseAsset $release } 'incomplete'
        }
        Invoke-Case 'real download verification and valid cache reuse' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $path = Save-RelayDownload $asset $state.Directory
            Assert-True (Test-RelayDownload $path $asset) 'Downloaded bytes must pass real file hash validation'
            Assert-Equal $state.DownloadCalls 1 'First request count'
            $cached = Save-RelayDownload $asset $state.Directory
            Assert-Equal $cached $path 'Cache path'
            Assert-Equal $state.DownloadCalls 1 'Verified cache must not redownload'
        }
        Invoke-Case 'same-size corrupt cache is replaced only by verified bytes' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $target = Join-Path $state.Directory $asset.Name
            [IO.File]::WriteAllBytes($target, $corruptBytes)
            Assert-True (-not (Test-RelayDownload $target $asset)) 'Same length cannot bypass the checksum'
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal $state.DownloadCalls 1 'Corrupt cache must redownload'
            Assert-True (Test-RelayDownload $path $asset) 'Replacement must match the real digest'
        }
        Invoke-Case 'complete verified partial file promotes to cache without a request' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $partial = Get-PartialPath $asset
            [IO.File]::WriteAllBytes($partial, $fixtureBytes)
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal $state.DownloadCalls 0 'A complete partial file must be verified before requesting a range'
            Assert-True (Test-RelayDownload $path $asset) 'Promoted cache must match real SHA-256'
            Assert-True (-not (Test-Path -LiteralPath $partial)) 'Promotion must consume the partial file'
        }
        Invoke-Case 'existing partial bytes resume with exact Range offset' {
            $asset = Get-RelayReleaseAsset (New-Release)
            [IO.File]::WriteAllBytes((Get-PartialPath $asset), [byte[]]$fixtureBytes[0..2])
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal $state.DownloadOffsets[0] 3 'Resume offset must equal verified-on-completion partial length'
            Assert-True (Test-RelayDownload $path $asset) 'Resumed byte sequence must match the complete digest'
            Assert-True $state.DownloadResponses[0].Closed 'HTTP response must close after success'
        }
        Invoke-Case 'interrupted response saves bytes and retries from received offset' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $state.ResponsePlan.Enqueue((New-DownloadResponse -Bytes ([byte[]]$fixtureBytes[0..2]) -ContentLength $fixtureBytes.Length))
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal ($state.DownloadOffsets -join ',') '0,3' 'Short response must resume rather than discard received bytes'
            Assert-True (Test-RelayDownload $path $asset) 'Resumed response must match expected bytes'
            Assert-True $state.DownloadResponses[0].Closed 'Interrupted response must be closed before retry'
        }
        Invoke-Case 'exhausted network retries preserve resumable partial bytes' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $partial = Get-PartialPath $asset
            [IO.File]::WriteAllBytes($partial, [byte[]]$fixtureBytes[0..2])
            $state.DownloadFailure = $true
            Assert-Throws { Save-RelayDownload $asset $state.Directory } 'Fixture network failure'
            Assert-Equal ($state.DownloadOffsets -join ',') '3,3,3' 'Every network retry must retain the current offset'
            Assert-Equal ([IO.File]::ReadAllBytes($partial) -join ',') ([byte[]]$fixtureBytes[0..2] -join ',') 'Failed requests must preserve prior partial bytes'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $state.Directory $asset.Name))) 'Partial file must not become a final executable'
        }
        Invoke-Case 'server ignoring Range replaces partial bytes instead of appending' {
            $asset = Get-RelayReleaseAsset (New-Release)
            [IO.File]::WriteAllBytes((Get-PartialPath $asset), [byte[]]$fixtureBytes[0..2])
            $state.ResponsePlan.Enqueue((New-DownloadResponse -Bytes $fixtureBytes -StatusCode 200))
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal $state.DownloadOffsets[0] 3 'Client should initially request a range'
            Assert-Equal $state.DownloadCalls 1 'Full 200 response should complete directly'
            Assert-True (Test-RelayDownload $path $asset) 'Full 200 response must truncate the old partial file'
        }
        Invoke-Case 'wrong Content-Range never appends bytes or executes' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $partial = Get-PartialPath $asset
            [IO.File]::WriteAllBytes($partial, [byte[]]$fixtureBytes[0..2])
            for ($index = 0; $index -lt 3; $index++) {
                $state.ResponsePlan.Enqueue((New-DownloadResponse -Bytes ([byte[]]$fixtureBytes[3..7]) -StatusCode 206 -ContentRange 'bytes 2-6/8'))
            }
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Content-Range'
            Assert-Equal ([IO.File]::ReadAllBytes($partial) -join ',') ([byte[]]$fixtureBytes[0..2] -join ',') 'Invalid ranges must not modify existing bytes'
            Assert-Equal $state.ProcessCalls 0 'Invalid ranges must never execute'
            Assert-True (@($state.DownloadResponses | Where-Object { -not $_.Closed }).Count -eq 0) 'Every rejected HTTP response must close'
        }
        Invoke-Case 'oversized response cannot exceed the declared release size' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $tooLarge = [byte[]]($fixtureBytes + [byte[]](1, 2))
            for ($index = 0; $index -lt 3; $index++) {
                $response = New-DownloadResponse -Bytes $tooLarge
                $response.ContentLength = -1
                $state.ResponsePlan.Enqueue($response)
            }
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'more bytes than the release size'
            Assert-Equal $state.ProcessCalls 0 'Oversized content must never execute'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $state.Directory $asset.Name))) 'Oversized content must not be published to the cache'
        }
        Invoke-Case 'failed checksum deletes partial data before the next attempt' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $state.ResponsePlan.Enqueue((New-DownloadResponse -Bytes $corruptBytes))
            $path = Save-RelayDownload $asset $state.Directory
            Assert-Equal ($state.DownloadOffsets -join ',') '0,0' 'Checksum failure must restart at byte zero'
            Assert-True (Test-RelayDownload $path $asset) 'Only correctly verified retry bytes may be published'
        }
        Invoke-Case 'concurrent download lock blocks cache mutation and network requests' {
            $asset = Get-RelayReleaseAsset (New-Release)
            $lockPath = (Get-PartialPath $asset) + '.lock'
            $held = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            try { Assert-Throws { Save-RelayDownload $asset $state.Directory } 'Another Relay download' }
            finally { $held.Dispose() }
            Assert-Equal $state.DownloadCalls 0 'A locked cache must not start another transfer'
        }
        Invoke-Case 'corrupt download retries and never executes an installer' {
            $state.DownloadBytes = $corruptBytes
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'failed size or SHA-256 verification'
            Assert-Equal $state.DownloadCalls 3 'Corrupt bytes must exhaust three attempts'
            Assert-Equal $state.SleepCalls 2 'Retry delay count'
            Assert-Equal $state.ProcessCalls 0 'Corrupt bytes must never execute'
            Assert-Equal @(Get-ChildItem -LiteralPath $state.Directory -Filter '*.part').Count 0 'Checksum failure must remove partial bytes'
            Assert-Equal @(Get-ChildItem -LiteralPath $state.Directory -Filter '*Setup.exe').Count 0 'Corrupt bytes must not become a final installer'
        }
        Invoke-Case 'network failures leave no partial installer and never execute' {
            $state.DownloadFailure = $true
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Fixture network failure'
            Assert-Equal $state.DownloadCalls 3 'Network retry count'
            Assert-Equal $state.ProcessCalls 0 'Network failure must never execute'
            Assert-Equal @(Get-ChildItem -LiteralPath $state.Directory -Filter '*.part').Count 0 'No received bytes means no partial data'
        }
        Invoke-Case 'installation identity normalizes version and retains scope and original path' {
            $installed = New-Installation -Version '2.1.0'
            $installed.Version = 'v2.1.0.0'; $installed.Location += '\'
            $state.Installations = @($installed)
            $items = @(Get-RelayInstallations)
            Assert-Equal $items.Count 1 'Recognized installation count'
            Assert-Equal $items[0].Version '2.1.0' 'Legacy display version normalization'
            Assert-Equal $items[0].Scope 'CurrentUser' 'Scope must be retained'
            Assert-Equal $items[0].Location $installed.Location.TrimEnd('\') 'Original install path must be retained'
            Assert-Equal $items[0].RegistryView 'Registry64' 'Registry view must be retained'
            Assert-True $items[0].Recognized 'Known installer identity must be retained'
            Assert-True $items[0].InstallLocationRegistered 'Primary installation location evidence must be retained'
        }
        Invoke-Case 'uninstall-only location is preserved as untrusted and blocks automatic upgrade' {
            foreach ($scope in @('CurrentUser', 'LocalMachine')) {
                $installed = New-Installation -Version '2.1.0' -Scope $scope
                $installed.InstallLocationRegistered = $false
                $state.Installations = @($installed)
                $items = @(Get-RelayInstallations)
                Assert-Equal $items[0].InstallLocationRegistered $false 'Normalization must not turn a fallback uninstall path into a primary registration'
                Assert-Equal $items[0].Location $installed.Location 'Original path remains available for manual diagnosis'
                Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'cannot be upgraded automatically'
            }
            Assert-Equal $state.DownloadCalls 0 'Missing primary registration must block automatic installer download'
            Assert-Equal $state.ProcessCalls 0 'Missing primary registration must block installer launch'
            Assert-Equal $state.ConfirmCalls 0 'Untrusted installation path must not reach post-validation'
        }
        Invoke-Case 'same-version uninstall-only registration cannot report a verified latest install' {
            $installed = New-Installation -Version '3.0.0'
            $installed.InstallLocationRegistered = $false
            $state.Installations = @($installed)
            $state.ConfirmMode = 'real'
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'cannot be upgraded automatically'
            Assert-Equal $state.ConfirmCalls 0 'An uninstall-only path must be rejected before the latest-version no-op'
            Assert-Equal $state.DownloadCalls 0 'Missing primary registration must not trigger an implicit repair download'
            Assert-Equal $state.ProcessCalls 0 'Missing primary registration must not trigger an implicit repair install'
        }
        Invoke-Case 'primary registration removed during download blocks installer execution' {
            $installed = New-Installation -Version '2.1.0'
            $state.Installations = @($installed)
            $state.ResponsePlan.Enqueue({
                param($Offset)
                $installed.InstallLocationRegistered = $false
                return New-DownloadResponse -Bytes $fixtureBytes
            })
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'cannot be upgraded automatically'
            Assert-Equal $state.DownloadCalls 1 'Primary location existed when the download began'
            Assert-Equal $state.ProcessCalls 0 'Post-download scope validation must reject the removed primary registration'
            Assert-Equal $state.ConfirmCalls 0 'No installation validation may run after a rejected launch'
        }
        Invoke-Case 'fully installed latest version skips download launch and running-app checks' {
            $state.ConfirmMode = 'real'
            $state.Installations = @(New-Installation -Version '3.0.0')
            $state.RunningAtChecks = @(1)
            Install-Relay -DownloadDirectory $state.Directory
            Assert-Equal $state.ConfirmCalls 1 'Latest-version skip must verify actual installation files'
            Assert-Equal $state.DownloadCalls 0 'Latest-version skip must avoid installer download'
            Assert-Equal $state.ProcessCalls 0 'Latest-version skip must avoid relaunching installer'
            Assert-Equal $state.ClosedChecks 0 'A running latest version must not prevent the no-op result'
        }
        Invoke-Case 'same-version incomplete registration does not silently report latest' {
            $state.ConfirmMode = 'real'
            $state.Installations = @(New-Installation -Version '3.0.0' -Incomplete)
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'incomplete|Interactive'
            Assert-Equal $state.DownloadCalls 0 'Incomplete same-version install requires explicit interactive recovery'
            Assert-Equal $state.ProcessCalls 0 'No implicit reinstall for incomplete registration'
        }
        Invoke-Case 'same-version executable mismatch cannot be mistaken for an intact latest install' {
            $state.ConfirmMode = 'real'
            $installed = New-Installation -Version '3.0.0'
            $state.ExecutableVersions[(Join-Path $installed.Location 'Relay.exe')] = '2.1.0'
            $state.Installations = @($installed)
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'executable version does not match|Interactive'
            Assert-Equal $state.ProcessCalls 0 'Mismatched installed executable must not count as a verified no-op'
        }
        Invoke-Case 'interactive mode can explicitly reinstall the same version' {
            $state.Installations = @(New-Installation -Version '3.0.0')
            Install-Relay -Interactive -DownloadDirectory $state.Directory
            Assert-Equal $state.DownloadCalls 1 'Interactive same-version request must acquire installer'
            Assert-Equal $state.ProcessCalls 1 'Interactive request must not be converted into a latest-version no-op'
            Assert-True (-not $state.Start.HasArguments) 'Legacy interactive reinstall must not be forced silent'
        }
        Invoke-Case 'unknown identity 32-bit registration invalid version and relative path block upgrade' {
            foreach ($change in @(
                { $installed.Recognized = $false },
                { $installed.RegistryView = 'Registry32' },
                { $installed.Version = 'not-a-version' },
                { $installed.Location = 'relative\Relay' }
            )) {
                $installed = New-Installation
                & $change
                $state.Installations = @($installed)
                Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'cannot be upgraded automatically'
            }
            Assert-Equal $state.DownloadCalls 0 'Uncertain installation identity must block automatic download/install'
            Assert-Equal $state.ProcessCalls 0 'Uncertain installation identity must not launch installer'
        }
        Invoke-Case 'newer actual executable prevents downgrade despite older registry version' {
            $installed = New-Installation -Version '2.1.0'
            $state.ExecutableVersions[(Join-Path $installed.Location 'Relay.exe')] = '3.1.0'
            $state.Installations = @($installed)
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'newer Relay executable|Automatic downgrade'
            Assert-Equal $state.DownloadCalls 0 'Actual executable version must participate in downgrade prevention'
            Assert-Equal $state.ProcessCalls 0 'Actual executable must not be downgraded'
        }
        Invoke-Case 'silent installation passes only /S and waits for completion' {
            Install-Relay -Version 'v3.0.0' -DownloadDirectory $state.Directory
            Assert-Equal $state.ProcessCalls 1 'Installer launch count'
            Assert-Equal @($state.Start.Arguments).Count 1 'Only one NSIS argument is allowed'
            Assert-Equal $state.Start.Arguments[0] '/S' 'Only silent NSIS flag'
            Assert-True $state.Start.Wait 'Wait must be set'
            Assert-True $state.Start.PassThru 'PassThru must be set'
            Assert-Equal $state.Start.FilePath (Join-Path $state.Directory 'Relay-3.0.0-Setup.exe') 'Verified installer path'
            Assert-Equal $state.ExpectedScope 'CurrentUser' 'Default install scope'
            Assert-Equal $state.ExpectedVersion '3.0.0' 'Expected post-install version'
            Assert-Equal $state.ReleaseUri 'https://raw.githubusercontent.com/g1at/relay-updates/main/releases/v3.0.0.json' 'Pinned manifest endpoint'
            Assert-Equal $state.ClosedChecks 1 'App state must be checked immediately before execution'
        }
        Invoke-Case 'interactive installation passes no NSIS arguments' {
            Install-Relay -Interactive -DownloadDirectory $state.Directory
            Assert-Equal $state.ProcessCalls 1 'Interactive launch count'
            Assert-True (-not $state.Start.HasArguments) 'Interactive invocation must omit ArgumentList'
            Assert-Equal $state.ReleaseUri 'https://raw.githubusercontent.com/g1at/relay-updates/main/latest.json' 'Latest manifest endpoint'
        }
        Invoke-Case 'existing machine-wide scope is retained without forcing NSIS scope flags' {
            $installed = New-Installation -Scope 'LocalMachine'
            $state.Installations = @($installed)
            Install-Relay -DownloadDirectory $state.Directory
            Assert-Equal $state.ExpectedScope 'LocalMachine' 'Post-check must retain existing machine scope'
            Assert-Equal $state.ExpectedLocation $installed.Location 'Post-check must retain the original install directory'
            Assert-Equal ($state.Start.Arguments -join ' ') '/S' 'No allusers/currentuser switches may be injected'
        }
        Invoke-Case 'advertised installer guard is passed in both silent and interactive modes' {
            $state.Manifest.installer.closeRunningAppGuard = $true
            Install-Relay -DownloadDirectory $state.Directory
            Assert-Equal ($state.Start.Arguments -join ' ') '/S --relay-no-close' 'Silent guarded installer arguments'
            Install-Relay -Interactive -DownloadDirectory $state.Directory
            Assert-Equal ($state.Start.Arguments -join ' ') '--relay-no-close' 'Interactive guarded installer arguments'
        }
        Invoke-Case 'installation appearing during download is rechecked before launch' {
            $installed = New-Installation -Version '3.0.0'
            $state.ConfirmMode = 'real'
            $state.ResponsePlan.Enqueue({
                param($Offset)
                $state.Installations = @($installed)
                return New-DownloadResponse -Bytes $fixtureBytes
            })
            Install-Relay -DownloadDirectory $state.Directory
            Assert-Equal $state.DownloadCalls 1 'Download began before external installation completed'
            Assert-Equal $state.ProcessCalls 0 'Fresh post-download detection must avoid redundant reinstall'
            Assert-Equal $state.ConfirmCalls 1 'Externally completed latest installation must still be validated'
        }
        Invoke-Case 'scope changes during download block execution' {
            $first = New-Installation -Scope 'CurrentUser'
            $second = New-Installation -Scope 'LocalMachine'
            $state.Installations = @($first)
            $state.ResponsePlan.Enqueue({
                param($Offset)
                $state.Installations = @($first, $second)
                return New-DownloadResponse -Bytes $fixtureBytes
            })
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Multiple Relay installations'
            Assert-Equal $state.DownloadCalls 1 'Ambiguity was introduced while downloading'
            Assert-Equal $state.ProcessCalls 0 'Post-download scope recheck must block launch'
        }
        Invoke-Case 'DownloadOnly skips processes registry and installation' {
            $state.RunningAtChecks = @(1, 2)
            $state.Installations = @([pscustomobject]@{ Scope = 'CurrentUser'; Version = '99.0.0'; Location = $state.Directory; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true })
            $path = Install-Relay -DownloadOnly -DownloadDirectory $state.Directory
            Assert-True (Test-RelayDownload $path (Get-RelayReleaseAsset $state.Release)) 'DownloadOnly must return verified bytes'
            Assert-Equal $state.ProcessCalls 0 'DownloadOnly must not launch'
            Assert-Equal $state.ClosedChecks 0 'DownloadOnly does not require closing Relay'
            Assert-Equal $state.InstallationReads 0 'DownloadOnly must not inspect installation registry'
            Assert-Equal $state.ConfirmCalls 0 'DownloadOnly must not post-validate an installation'
        }
        Invoke-Case 'running Relay permits verified download but blocks execution' {
            $state.RunningAtChecks = @(1)
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Relay is running'
            Assert-Equal $state.ReleaseCalls 1 'Running application must not prevent metadata lookup'
            Assert-Equal $state.DownloadCalls 1 'Running application must not prevent a verified download'
            Assert-True (Test-RelayDownload (Join-Path $state.Directory 'Relay-3.0.0-Setup.exe') (Get-RelayManifestAsset $state.Manifest)) 'Running-app rejection must retain verified cache'
            Assert-Equal $state.ProcessCalls 0 'Running application must not be installed over'
        }
        Invoke-Case 'Relay started during download is rejected before execution' {
            $state.ResponsePlan.Enqueue({
                param($Offset)
                $state.RunningAtChecks = @(1)
                return New-DownloadResponse -Bytes $fixtureBytes
            })
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Relay is running'
            Assert-Equal $state.DownloadCalls 1 'Download should complete before final app check'
            Assert-Equal $state.ProcessCalls 0 'Final running-app check must prevent launch'
        }
        Invoke-Case 'dual installation scopes are rejected before download' {
            $state.Installations = @(
                [pscustomobject]@{ Scope = 'CurrentUser'; Version = '2.1.0'; Location = $state.Directory; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true },
                [pscustomobject]@{ Scope = 'LocalMachine'; Version = '2.1.0'; Location = $state.Directory; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true }
            )
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'Multiple Relay installations'
            Assert-Equal $state.DownloadCalls 0 'Ambiguous scope must block download'
            Assert-Equal $state.ProcessCalls 0 'Ambiguous scope must block execution'
        }
        Invoke-Case 'automatic downgrade is rejected before download' {
            $state.Installations = @([pscustomobject]@{ Scope = 'CurrentUser'; Version = '3.1.0'; Location = $state.Directory; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true })
            Assert-Throws { Install-Relay -Version '3.0.0' -DownloadDirectory $state.Directory } 'Automatic downgrade is not supported'
            Assert-Equal $state.DownloadCalls 0 'Downgrade must block download'
            Assert-Equal $state.ProcessCalls 0 'Downgrade must block execution'
        }
        Invoke-Case 'cached bytes are checked again immediately before execution' {
            $asset = Get-RelayReleaseAsset (New-Release)
            [IO.File]::WriteAllBytes((Join-Path $state.Directory $asset.Name), $fixtureBytes)
            $state.TamperOnInstallationRead = 2
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'verification changed before execution'
            Assert-Equal $state.DownloadCalls 0 'Initial verified cache must be reused'
            Assert-Equal $state.ProcessCalls 0 'Tampered cached bytes must not execute'
        }
        Invoke-Case 'zero exit without expected registration is still a failure' {
            $state.ConfirmMode = 'real'
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'expected Relay registration was not found'
            Assert-Equal $state.ProcessCalls 1 'The mocked installer should have returned zero'
            Assert-Equal $state.ConfirmCalls 1 'Real post-validation must run after zero exit'
        }
        Invoke-Case 'zero exit with missing installed files is still a failure' {
            $state.ConfirmMode = 'real'
            $state.PostInstallations = @([pscustomobject]@{ Scope = 'CurrentUser'; Version = '3.0.0'; Location = $state.Directory; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true })
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'installed Relay files are incomplete'
            Assert-Equal $state.ProcessCalls 1 'Zero-exit mock must not imply installed files exist'
        }
        Invoke-Case 'zero exit cannot silently install an upgrade into a different directory' {
            $state.ConfirmMode = 'real'
            $original = New-Installation -Version '2.1.0'
            $state.Installations = @($original)
            $changedLocation = Join-Path $state.Directory 'unexpected-location'
            $state.PostInstallations = @([pscustomobject]@{
                Scope = 'CurrentUser'; Version = '3.0.0'; Location = $changedLocation; Recognized = $true; RegistryView = 'Registry64'; InstallLocationRegistered = $true
            })
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'not installed in its original directory'
            Assert-Equal $state.ProcessCalls 1 'Post-install directory mismatch is checked after mocked zero exit'
            Assert-Equal $state.ExpectedLocation $original.Location 'Upgrade must retain the original path as its expected result'
        }
        Invoke-Case 'nonzero installer exit is rejected before post-validation' {
            $state.ExitCode = 1602
            Assert-Throws { Install-Relay -DownloadDirectory $state.Directory } 'exit code 1602'
            Assert-Equal $state.ProcessCalls 1 'Installer attempted once'
            Assert-Equal $state.ConfirmCalls 0 'Failure exit must bypass success validation'
        }
        $failed = @($results | Where-Object { -not $_.Passed })
        Write-Host ("`nCLI installer behavior: {0}/{1} passed (PowerShell {2})." -f ($results.Count - $failed.Count), $results.Count, $PSVersionTable.PSVersion)
        if ($failed.Count) { throw ($failed.Count.ToString() + ' behavioral test(s) failed.') }
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        if (Test-Path -LiteralPath $runRoot) { Remove-Item -LiteralPath $runRoot -Recurse -Force }
    }
}
