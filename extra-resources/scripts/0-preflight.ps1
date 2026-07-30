# 0-preflight.ps1 — 环境体检
# 输出 JSON 报告到 $PREFLIGHT_FILE,Inno 读取后在欢迎页展示
# 任一硬性项失败则 exit 1

. "$PSScriptRoot\_common.ps1"

Write-Step 'Step 0: 环境体检'

$report = [ordered]@{
    timestamp        = (Get-Date -Format 'o')
    os               = $null
    isAdmin          = $null
    diskFreeMB       = $null
    networkNpmmirror = $null
    networkNpm       = $null
    antivirus        = @()
    hardFails        = @()
    warnings         = @()
}

# ---- Windows 版本 ----
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $report.os = "$($os.Caption) ($($os.Version))"
    Write-Log -Level OK -Message "OS: $($report.os)"

    $build = [int]($os.Version.Split('.')[2])
    if ($build -lt 17763) {
        $report.hardFails += 'Windows 版本过低(需 Win10 1809 / build 17763 及以上)'
        Write-Log -Level ERROR -Message $report.hardFails[-1]
    }
} catch {
    $report.warnings += "无法读取系统版本: $($_.Exception.Message)"
}

# ---- 管理员检查 ----
$report.isAdmin = Test-IsAdmin
if ($report.isAdmin) {
    Write-Log -Level OK -Message '当前已具备管理员权限'
} else {
    $report.warnings += '未以管理员身份运行,npm 全局安装可能弹 UAC'
    Write-Log -Level WARN -Message $report.warnings[-1]
}

# ---- 磁盘空间(C 盘) ----
try {
    $drive = Get-PSDrive -Name C
    $freeMB = [int]($drive.Free / 1MB)
    $report.diskFreeMB = $freeMB
    if ($freeMB -lt $global:MIN_DISK_MB) {
        $report.hardFails += "C 盘可用空间不足(当前 ${freeMB}MB,需至少 $($global:MIN_DISK_MB)MB)"
        Write-Log -Level ERROR -Message $report.hardFails[-1]
    } else {
        Write-Log -Level OK -Message "C 盘可用 ${freeMB}MB"
    }
} catch {
    $report.warnings += "无法读取磁盘空间: $($_.Exception.Message)"
}

# ---- 网络连通性 ----
# 只检"下载依赖"所需的两个源:
#  - npmmirror    Aliyun 镜像(下 Claude Code / Node / Git)
#  - xiaomi-npm   小米内网(下 @mi/feishu-mcp-pro)
# mify / 飞书 是运行时才用,装的时候不查
Write-Log -Message '检测网络连通性(各 5s 超时)...'

$report.networkNpmmirror = Test-Connectivity -Url $global:URL_NPMMIRROR
$report.networkNpm       = Test-Connectivity -Url $global:URL_XIAOMI_NPM

if ($report.networkNpmmirror) { Write-Log -Level OK    -Message "Aliyun npm 镜像 可达" }
else                          { Write-Log -Level ERROR -Message "Aliyun npm 镜像 不可达 ($global:URL_NPMMIRROR)" }

if ($report.networkNpm)       { Write-Log -Level OK    -Message "小米内网 npm 可达" }
else                          { Write-Log -Level ERROR -Message "小米内网 npm 不可达 ($global:URL_XIAOMI_NPM)" }

if (-not $report.networkNpmmirror) {
    $report.hardFails += 'Aliyun npm 镜像不可达,无法下载 Claude Code'
} elseif (-not $report.networkNpm) {
    $report.warnings  += '小米内网不可达,飞书 MCP 安装会失败(其他步骤可继续)'
}

# ---- 杀软进程检测(只警告) ----
$avProcs = @('HipsTray','HipsDaemon','360tray','QQPCRtp','KSafeTray','KvMonXP')
foreach ($name in $avProcs) {
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
        $report.antivirus += $name
    }
}
if ($report.antivirus.Count -gt 0) {
    $report.warnings += "检测到杀软进程: $($report.antivirus -join ', '),安装中如有拦截请放行"
    Write-Log -Level WARN -Message $report.warnings[-1]
}

# ---- 写报告 ----
$report | ConvertTo-Json -Depth 5 | Out-File -FilePath $global:PREFLIGHT_FILE -Encoding utf8
Write-Log -Message "体检报告写入: $global:PREFLIGHT_FILE"

# ---- 退出码 ----
if ($report.hardFails.Count -gt 0) {
    Report-Error -Step 'preflight' -Error ($report.hardFails -join '; ') `
                 -Hint '请先解决以上问题再重新安装。详见欢迎页提示。'
    exit 1
}

Write-Log -Level OK -Message '环境体检通过'
exit 0
