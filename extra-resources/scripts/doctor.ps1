# doctor.ps1 — 独立诊断工具
# 安装后用户随时可跑(桌面有快捷方式),报告各组件状态 + 修复建议

[CmdletBinding()]
param([switch]$Export)

. "$PSScriptRoot\_common.ps1"

# 关闭脚本默认的 stop-on-error,doctor 要把所有项都跑完
$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '╔═══════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║       Relay  -  环境诊断工具                           ║' -ForegroundColor Cyan
Write-Host '╚═══════════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''

$results = @()

function Diagnose {
    param(
        [string]$Name,
        [scriptblock]$Check,
        [string]$FixHint = ''
    )
    Write-Host -NoNewline ("  {0,-30}" -f $Name)
    try {
        $r = & $Check
        if ($r -is [bool] -and $r) {
            Write-Host '✓ OK' -ForegroundColor Green
            $global:results += [pscustomobject]@{ Name=$Name; Status='OK'; Detail='' }
        } elseif ($r -is [string]) {
            Write-Host "✓ $r" -ForegroundColor Green
            $global:results += [pscustomobject]@{ Name=$Name; Status='OK'; Detail=$r }
        } else {
            Write-Host '✗ FAIL' -ForegroundColor Red
            if ($FixHint) { Write-Host "    → $FixHint" -ForegroundColor Yellow }
            $global:results += [pscustomobject]@{ Name=$Name; Status='FAIL'; Detail=$FixHint }
        }
    } catch {
        Write-Host "✗ ERROR: $($_.Exception.Message)" -ForegroundColor Red
        if ($FixHint) { Write-Host "    → $FixHint" -ForegroundColor Yellow }
        $global:results += [pscustomobject]@{ Name=$Name; Status='ERROR'; Detail=$_.Exception.Message }
    }
}

Refresh-Path

# === 基础环境 ===
Write-Host '【基础环境】' -ForegroundColor Cyan

Diagnose -Name 'Git' -FixHint '重跑安装器或手动从 git-scm.com 装' -Check {
    if (Test-GitInstalled) { return (& git --version) }
    return $false
}

Diagnose -Name 'Git Bash 路径' -FixHint 'Git 安装异常,bin\bash.exe 缺失' -Check {
    $bash = Get-GitBashPath
    if ($bash) { return $bash }
    return $false
}

Diagnose -Name 'Node.js v20+' -FixHint '重跑安装器' -Check {
    $v = Get-NodeMajorVersion
    if ($v -ge $global:MIN_NODE_MAJOR) { return "v$v" }
    return $false
}

Diagnose -Name 'npm registry (npmmirror)' -FixHint "运行: npm config set registry $global:NPM_REGISTRY" -Check {
    $r = & npm config get registry 2>$null
    if ($r -like '*npmmirror*') { return $r.Trim() }
    return $false
}

# === Claude Code ===
Write-Host ''
Write-Host '【Claude Code】' -ForegroundColor Cyan

Diagnose -Name 'claude 命令可用' -FixHint '重启终端;或重跑安装器' -Check {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        $v = & claude --version 2>$null
        if ($LASTEXITCODE -eq 0) { return $v }
    }
    return $false
}

Diagnose -Name '~/.claude/settings.json' -FixHint '重跑安装器修复 settings' -Check {
    if (-not (Test-Path $global:CLAUDE_SETTINGS)) { return $false }
    try {
        $cfg = Get-Content $global:CLAUDE_SETTINGS -Raw | ConvertFrom-Json
        if ($cfg.env.ANTHROPIC_API_KEY -and $cfg.env.ANTHROPIC_API_KEY -notmatch '{{|^$') {
            return 'mify Key 已配置'
        }
        return $false
    } catch { return $false }
}

Diagnose -Name '跳过 /login 拦截' -FixHint "运行: 在 ~/.claude.json 加 hasCompletedOnboarding: true" -Check {
    if (-not (Test-Path $global:CLAUDE_JSON)) { return $false }
    try {
        $cfg = Get-Content $global:CLAUDE_JSON -Raw | ConvertFrom-Json
        if ($cfg.hasCompletedOnboarding -eq $true) { return 'onboarding 已跳过' }
        return $false
    } catch { return $false }
}

# === 飞书 MCP ===
Write-Host ''
Write-Host '【飞书 MCP】' -ForegroundColor Cyan

Diagnose -Name 'feishu-mcp-pro 注册' -FixHint "重跑: npx -y --registry=$global:XIAOMI_NPM_REGISTRY @mi/feishu-mcp-pro@latest setup" -Check {
    if (-not (Test-Path $global:CLAUDE_JSON)) { return $false }
    try {
        $cfg = Get-Content $global:CLAUDE_JSON -Raw | ConvertFrom-Json
        if ($cfg.PSObject.Properties.Match('mcpServers').Count -and
            ($cfg.mcpServers.PSObject.Properties.Name -contains 'feishu-mcp-pro')) {
            return $true
        }
        return $false
    } catch { return $false }
}

# === Agent / 快捷方式 ===
Write-Host ''
Write-Host '【Relay】' -ForegroundColor Cyan

Diagnose -Name '用户 Agent 目录' -Check {
    # Agent 已与安装解耦,改由用户在应用内导入到 ~/.claude/agents
    $p = Join-Path $env:USERPROFILE '.claude\agents'
    if (Test-Path $p) {
        $n = (Get-ChildItem $p -Filter '*.md' -ErrorAction SilentlyContinue | Measure-Object).Count
        return "$p ($n 个 Agent)"
    }
    return '未创建(尚未导入任何 Agent)'
} -FixHint '在应用内「设置 → Agent 目录」导入 Agent 包(.zip)'

Diagnose -Name '桌面快捷方式' -Check {
    $p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Relay.lnk'
    return (Test-Path $p)
} -FixHint '重跑安装器创建快捷方式'

# === 网络 ===
Write-Host ''
Write-Host '【网络连通性】' -ForegroundColor Cyan

Diagnose -Name 'Aliyun npm 镜像'   -Check { Test-Connectivity -Url $global:URL_NPMMIRROR } -FixHint '检查公网'
Diagnose -Name '小米内网 npm'      -Check { Test-Connectivity -Url $global:URL_XIAOMI_NPM } -FixHint '检查小米 VPN'

# === 汇总 ===
Write-Host ''
Write-Host '──────────────────────────────────────────' -ForegroundColor Cyan
$fail = ($results | Where-Object { $_.Status -ne 'OK' }).Count
if ($fail -eq 0) {
    Write-Host "  ✓ 全部通过,环境健康" -ForegroundColor Green
} else {
    Write-Host "  ⚠ $fail 项异常,请按提示修复" -ForegroundColor Yellow
}
Write-Host ''

# === 导出报告 ===
if ($Export -or $fail -gt 0) {
    $reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) "relay-doctor-$(Get-Date -Format yyyyMMddHHmmss).txt"
    $lines = @(
        "Relay 诊断报告",
        "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
        "用户: $env:USERNAME",
        "机器: $env:COMPUTERNAME",
        "",
        "─── 诊断结果 ───"
    )
    foreach ($r in $results) {
        $sym = if ($r.Status -eq 'OK') {'✓'} else {'✗'}
        $lines += "$sym  $($r.Name)  [$($r.Status)]  $($r.Detail)"
    }
    $lines += ""
    $lines += "─── 完整日志 ───"
    if (Test-Path $global:LOG_FILE) {
        $lines += Get-Content $global:LOG_FILE -Tail 50
    }
    $lines | Out-File -FilePath $reportPath -Encoding utf8
    Write-Host "诊断报告已导出: $reportPath" -ForegroundColor Cyan
    Write-Host '可发给 Agent 维护人协助排查' -ForegroundColor Cyan
}

Write-Host ''
Write-Host '按任意键退出...' -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
