[CmdletBinding()]
param(
    [ValidateRange(5, 1800)][int]$DurationSeconds = 900,
    [ValidateRange(100, 2000)][int]$IntervalMilliseconds = 250,
    [string]$OutputRoot = '',
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$sampleWriter = $null
$eventWriter = $null
$outputDirectory = $null
$exitCode = 0
$sampleCount = 0
$markerCount = 0
$instances = @{}
$present = @{}
$instanceNumber = 0
$startedUtc = [DateTime]::UtcNow
$endReason = 'duration_limit'
$stopwatch = [Diagnostics.Stopwatch]::StartNew()

function Save-Json($Path, $Value) {
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 12), $utf8)
}
function Write-Event($Kind, $Data) {
    $entry = [ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $stopwatch.ElapsedMilliseconds; kind = $Kind; data = $Data }
    $eventWriter.WriteLine((ConvertTo-Json -InputObject $entry -Depth 12 -Compress))
    $eventWriter.Flush()
}
function Error-Metadata($ErrorRecord) {
    # Deliberately omit exception messages, command text, stack traces and paths.
    return [ordered]@{ type = $ErrorRecord.Exception.GetType().Name; hresult = $ErrorRecord.Exception.HResult; scriptLine = $ErrorRecord.InvocationInfo.ScriptLineNumber }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'PowerShell 5.1 or newer is required.' }
    if (-not $OutputRoot) {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { $desktop = [IO.Path]::GetTempPath() }
        $OutputRoot = Join-Path $desktop 'Relay-Orb-Logs'
    }
    [void][IO.Directory]::CreateDirectory($OutputRoot)
    $captureName = 'Relay-Orb-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $outputDirectory = Join-Path $OutputRoot $captureName
    [void][IO.Directory]::CreateDirectory($outputDirectory)
    $sampleWriter = New-Object IO.StreamWriter((Join-Path $outputDirectory 'samples.jsonl'), $false, $utf8)
    $eventWriter = New-Object IO.StreamWriter((Join-Path $outputDirectory 'events.jsonl'), $false, $utf8)

    Write-Host ''
    Write-Host 'Relay 悬浮球日志采集（仅只读技术指标，无需管理员）' -ForegroundColor Cyan
    Write-Host '不读取聊天、配置、API Key、命令行，也不截取屏幕。'
    Write-Host '保持此窗口运行，在 Relay 中复现拖动异常；按键前请切回此窗口。'
    Write-Host 'B = 正常状态；F = 拖动后被切割；R = 关闭重开后恢复；Q = 结束并打包'
    Write-Host ('最多采集 {0} 秒，输出目录：{1}' -f $DurationSeconds, $outputDirectory)
    Write-Host ''

    Add-Type -Path (Join-Path $PSScriptRoot 'RelayOrbNative.cs')
    $environment = [ordered]@{
        schemaVersion = 1; collectorVersion = '1.0.0'; collectedAtUtc = [DateTime]::UtcNow.ToString('o')
        timezoneOffsetMinutes = [int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes
        powershellVersion = $PSVersionTable.PSVersion.ToString(); is64BitProcess = [Environment]::Is64BitProcess
        intervalMilliseconds = $IntervalMilliseconds; durationLimitSeconds = $DurationSeconds
        windowFilter = 'Exact title Relay 悬浮球 and process name Relay or electron'
        coordinateUnits = 'Physical pixels where physicalCoordinatesRequested is true'
        screenshots = $false; collectionErrors = @()
    }
    try { $environment.os = @(Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10 | Select-Object Caption, Version, BuildNumber, OSArchitecture) }
    catch { $environment.collectionErrors += @{ section = 'os'; error = (Error-Metadata $_) } }
    try { $environment.gpu = @(Get-CimInstance Win32_VideoController -OperationTimeoutSec 10 | Select-Object Name, DriverVersion, DriverDate, VideoProcessor, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate) }
    catch { $environment.collectionErrors += @{ section = 'gpu'; error = (Error-Metadata $_) } }
    $environment.monitors = @([RelayOrbDiagnostics.Native]::Monitors())
    Save-Json (Join-Path $outputDirectory 'environment.json') $environment
    Write-Event 'collector_started' @{ durationLimitSeconds = $DurationSeconds; intervalMilliseconds = $IntervalMilliseconds }
    $previousMonitors = ConvertTo-Json -InputObject $environment.monitors -Depth 8 -Compress
    $nextMonitorCheckMs = 0
    $nextSampleMs = 0
    $lastWindowCount = -1
    $stop = $false
    # Initialization can take a few seconds; the duration limit applies to sampling.
    $samplingStartMs = $stopwatch.ElapsedMilliseconds
    while (-not $stop -and ($stopwatch.ElapsedMilliseconds - $samplingStartMs) -lt ($DurationSeconds * 1000)) {
        if (-not $NonInteractive) {
            try {
                while ([Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true).Key.ToString().ToUpperInvariant()
                    if ($key -eq 'Q') { $endReason = 'user_quit'; $stop = $true; break }
                    if ($key -in @('B', 'F', 'R')) {
                        $labels = @{ B = 'normal_before_drag'; F = 'clipped_after_drag'; R = 'recovered_after_reopen' }
                        Write-Event 'user_marker' @{ marker = $key; label = $labels[$key] }
                        $markerCount++
                        Write-Host ('[{0}] 已记录标记 {1}，继续采集。' -f (Get-Date -Format 'HH:mm:ss'), $key) -ForegroundColor Green
                        $nextSampleMs = 0
                    }
                }
            } catch {
                $NonInteractive = $true
                Write-Event 'console_input_unavailable' (Error-Metadata $_)
                Write-Host '当前终端不支持按键，将按时间上限自动结束。' -ForegroundColor Yellow
            }
        }
        if ($stop) { break }
        if ($stopwatch.ElapsedMilliseconds -ge $nextSampleMs) {
            $windows = @([RelayOrbDiagnostics.Native]::Windows())
            $current = @{}
            foreach ($window in $windows) {
                $key = [string]$window.processId + ':' + [string]$window.processStartedUtc + ':' + [string]$window.handle
                if (-not $present.ContainsKey($key)) {
                    $instanceNumber++
                    $instances[$key] = $instanceNumber
                    Write-Event 'orb_window_appeared' @{ instance = $instanceNumber; processId = $window.processId; handle = $window.handle }
                }
                $window['instance'] = $instances[$key]
                $current[$key] = @{ instance = $instances[$key]; processId = $window.processId; handle = $window.handle }
            }
            foreach ($key in @($present.Keys)) { if (-not $current.ContainsKey($key)) { Write-Event 'orb_window_disappeared' $present[$key] } }
            $present = $current
            $sample = [ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $stopwatch.ElapsedMilliseconds; sequence = $sampleCount; windows = $windows }
            $sampleWriter.WriteLine((ConvertTo-Json -InputObject $sample -Depth 12 -Compress))
            $sampleWriter.Flush()
            $sampleCount++
            if ($windows.Count -ne $lastWindowCount) {
                if ($windows.Count -eq 0) { Write-Host '等待悬浮球窗口……请在 Relay 中开启悬浮球（本工具不会替你操作）。' -ForegroundColor Yellow }
                else { Write-Host ('已检测到 {0} 个悬浮球窗口，正在采集。' -f $windows.Count) -ForegroundColor Cyan }
                $lastWindowCount = $windows.Count
            }
            $nextSampleMs = $stopwatch.ElapsedMilliseconds + $IntervalMilliseconds
        }
        if ($stopwatch.ElapsedMilliseconds -ge $nextMonitorCheckMs) {
            $monitors = @([RelayOrbDiagnostics.Native]::Monitors())
            $serializedMonitors = ConvertTo-Json -InputObject $monitors -Depth 8 -Compress
            if ($serializedMonitors -ne $previousMonitors) {
                Write-Event 'display_layout_changed' @{ monitors = $monitors }
                $previousMonitors = $serializedMonitors
            }
            $nextMonitorCheckMs = $stopwatch.ElapsedMilliseconds + 2000
        }
        Start-Sleep -Milliseconds 40
    }
    Write-Event 'collector_stopped' @{ reason = $endReason; sampleCount = $sampleCount; markerCount = $markerCount }
} catch {
    $exitCode = 1
    $endReason = 'collector_error'
    if ($eventWriter) { try { Write-Event 'collector_error' (Error-Metadata $_) } catch {} }
    Write-Host ('采集失败，错误类型：{0}。已有日志仍会保留。' -f $_.Exception.GetType().Name) -ForegroundColor Red
} finally {
    if ($sampleWriter) { $sampleWriter.Dispose() }
    if ($eventWriter) { $eventWriter.Dispose() }
    if ($outputDirectory) {
        try {
            Save-Json (Join-Path $outputDirectory 'summary.json') ([ordered]@{
                schemaVersion = 1; startedUtc = $startedUtc.ToString('o'); endedUtc = [DateTime]::UtcNow.ToString('o')
                reason = $endReason; sampleCount = $sampleCount; markerCount = $markerCount; observedWindowInstances = $instanceNumber
                limitation = 'Native geometry only; no pixels, renderer DOM, GPU surface, chat, settings, credentials or command lines. Same-handle recreation entirely between samples may be missed.'
            })
            $zipPath = $outputDirectory + '.zip'
            Compress-Archive -LiteralPath $outputDirectory -DestinationPath $zipPath -CompressionLevel Optimal
            Write-Host ''
            Write-Host '采集结束。请发送下面这个 ZIP 文件：' -ForegroundColor Green
            Write-Host $zipPath -ForegroundColor Cyan
            Write-Host '同时说明 Relay 版本、哪一步出现异常；可自行附上只含悬浮球的截图。'
        } catch {
            $exitCode = 1
            Write-Host ('打包未成功，请手动压缩此目录：{0}（{1}）' -f $outputDirectory, $_.Exception.GetType().Name) -ForegroundColor Yellow
        }
    }
}
exit $exitCode
