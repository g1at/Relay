# 5-postcheck.ps1 — 装完自检
# 验证所有组件就位,生成报告

[CmdletBinding()]
param()

. "$PSScriptRoot\_common.ps1"

Write-Step 'Step 5: 装完自检'

$checks = @()

function Add-Check {
    param([string]$Name, [bool]$Pass, [string]$Detail = '')
    $global:checks += [pscustomobject]@{ Name = $Name; Pass = $Pass; Detail = $Detail }
    if ($Pass) { Write-Log -Level OK -Message "$Name $Detail" }
    else       { Write-Log -Level ERROR -Message "$Name $Detail" }
}

Refresh-Path

# 1a. Git
if (Test-GitInstalled) {
    $gv = & git --version
    Add-Check -Name 'Git' -Pass $true -Detail $gv
} else {
    Add-Check -Name 'Git' -Pass $false -Detail '未安装'
}

# 1b. Node
$nodeVer = Get-NodeMajorVersion
Add-Check -Name 'Node.js' -Pass ($nodeVer -ge $global:MIN_NODE_MAJOR) -Detail "v$nodeVer"

# 2. claude 命令
$claudeOk = $false
try {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        $v = & claude --version 2>$null
        $claudeOk = ($LASTEXITCODE -eq 0)
        Add-Check -Name 'Claude Code' -Pass $claudeOk -Detail $v
    } else {
        Add-Check -Name 'Claude Code' -Pass $false -Detail '命令未找到(可能需重启终端)'
    }
} catch {
    Add-Check -Name 'Claude Code' -Pass $false -Detail $_.Exception.Message
}

# 3. settings.json
$settingsOk = $false
if (Test-Path $global:CLAUDE_SETTINGS) {
    try {
        $cfg = Get-Content $global:CLAUDE_SETTINGS -Raw | ConvertFrom-Json
        $hasKey = $cfg.env.ANTHROPIC_API_KEY -and $cfg.env.ANTHROPIC_API_KEY -ne '{{API_KEY}}'
        $hasBase = $cfg.env.ANTHROPIC_BASE_URL -like '*mify*'
        $settingsOk = $hasKey -and $hasBase
        $detail = if ($settingsOk) { '已配置 mify' } else { 'API Key 或 BASE_URL 未填' }
        Add-Check -Name 'settings.json' -Pass $settingsOk -Detail $detail
    } catch {
        Add-Check -Name 'settings.json' -Pass $false -Detail "JSON 解析失败: $($_.Exception.Message)"
    }
} else {
    Add-Check -Name 'settings.json' -Pass $false -Detail '文件不存在'
}

# 3b. ~/.claude.json hasCompletedOnboarding(避免首次启动卡 /login)
$onboardOk = $false
$mcpOk = $false
if (Test-Path $global:CLAUDE_JSON) {
    try {
        $cfg = Get-Content $global:CLAUDE_JSON -Raw | ConvertFrom-Json
        $onboardOk = ($cfg.hasCompletedOnboarding -eq $true)
        if ($cfg.PSObject.Properties.Match('mcpServers').Count) {
            $mcpOk = $cfg.mcpServers.PSObject.Properties.Name -contains 'feishu-mcp-pro'
        }
    } catch {}
}
$onboardDetail = if ($onboardOk) { '.claude.json 已设置' } else { '首次启动会卡在 /login' }
Add-Check -Name '跳过 onboarding' -Pass $onboardOk -Detail $onboardDetail

# 4. feishu MCP 注册
$mcpDetail = if ($mcpOk) { '已注册' } else { '未在 .claude.json 中找到' }
Add-Check -Name 'feishu-mcp-pro' -Pass $mcpOk -Detail $mcpDetail

# 注:Agent 已与安装包解耦,不再随安装部署;用户在应用内「设置 → Agent 目录」自行导入,故此处不再检查。

# 6. 桌面快捷方式
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Relay.lnk'
Add-Check -Name '桌面快捷方式' -Pass (Test-Path $lnk) -Detail $lnk

# ---- 汇总 ----
$failed = $checks | Where-Object { -not $_.Pass }
$report = [pscustomobject]@{
    timestamp = (Get-Date -Format 'o')
    checks    = $checks
    allPass   = ($failed.Count -eq 0)
}
$reportFile = Join-Path $env:TEMP 'relay-postcheck.json'
$report | ConvertTo-Json -Depth 5 | Out-File -FilePath $reportFile -Encoding utf8

Write-Host ''
if ($failed.Count -eq 0) {
    Write-Log -Level OK -Message '所有自检项通过 ✓'
    exit 0
} else {
    Write-Log -Level ERROR -Message "$($failed.Count) 项失败,详见 $reportFile"
    foreach ($f in $failed) {
        Write-Host "  ✗ $($f.Name): $($f.Detail)" -ForegroundColor Red
    }
    exit 1
}
