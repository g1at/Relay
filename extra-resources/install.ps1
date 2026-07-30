# install.ps1 — 总编排(M1 命令行 MVP)
# 按顺序跑 0→5,任一失败则停下来报告
# 用法:
#   .\install.ps1                              (交互模式,提示输入 API Key)
#   .\install.ps1 -ApiKey sk-mify-xxx          (静默 API Key)
#   .\install.ps1 -ApiKey ... -SkipPreflight   (跳过体检,Inno 内已检过)

[CmdletBinding()]
param(
    [string]$ApiKey,
    [switch]$SkipPreflight,
    [switch]$AssumeUpgrade  # Node 升级不询问
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Join-Path $PSScriptRoot 'scripts'
. (Join-Path $scriptDir '_common.ps1')

# ---- 清空旧日志 ----
Remove-Item $global:LOG_FILE, $global:ERROR_FILE -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '╔═══════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '║       Relay  -  一键安装                               ║' -ForegroundColor Cyan
Write-Host '║       预计 3-5 分钟(取决于网络)                       ║' -ForegroundColor Cyan
Write-Host '╚═══════════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''

# ---- 收集 API Key ----
if (-not $ApiKey) {
    Write-Host '需要 mify API Key 才能继续。' -ForegroundColor Yellow
    Write-Host "如果还没有 Key,请打开浏览器: $global:URL_MIFY_KEY" -ForegroundColor Yellow
    Write-Host ''
    $ApiKey = Read-Host '请粘贴 mify API Key'
    if (-not $ApiKey) {
        Write-Host '未输入 API Key,安装中止' -ForegroundColor Red
        exit 1
    }
}
$env:MIFY_KEY = $ApiKey

# ---- 编排 ----
# 注:Agent 已与本安装包解耦,不再自动部署;用户在应用内「设置 → Agent 目录」自行导入。
$steps = @(
    @{ Id='0'; Name='环境体检';                Script='0-preflight.ps1';      Skip=$SkipPreflight }
    @{ Id='1'; Name='Git + Node.js';           Script='1-install-deps.ps1';   Args=@(if ($AssumeUpgrade) {'-AssumeUpgrade'}) }
    @{ Id='2'; Name='Claude Code + settings';  Script='2-install-claude.ps1'; Args=@('-ApiKey',$ApiKey) }
    @{ Id='3'; Name='飞书 MCP';                Script='3-install-mcp.ps1' }
    @{ Id='5'; Name='装完自检';                Script='5-postcheck.ps1' }
)

$start = Get-Date
foreach ($s in $steps) {
    if ($s.Skip) {
        Write-Host "[$($s.Id)] $($s.Name) - 跳过" -ForegroundColor Gray
        continue
    }
    $scriptPath = Join-Path $scriptDir $s.Script
    $stepArgs = if ($s.Args) { $s.Args | Where-Object { $_ } } else { @() }

    Write-Host ''
    Write-Host "──── [$($s.Id)/$($steps.Count - 1)] $($s.Name) ────" -ForegroundColor Magenta

    # 捕获子进程 stdout + stderr。注意:Start-Process + RedirectStandardError 比 & 更可靠
    $childOut = Join-Path $env:TEMP "relay-step-$($s.Id)-out.log"
    $childErr = Join-Path $env:TEMP "relay-step-$($s.Id)-err.log"
    $psArgs = @('-ExecutionPolicy','Bypass','-NoProfile','-File',$scriptPath) + $stepArgs
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $childOut -RedirectStandardError $childErr
    # 把子进程输出转发到当前控制台。子进程的 [Console]::OutputEncoding 是 UTF-8,
    # 必须显式 -Encoding UTF8 读,否则 Get-Content 默认按系统代码页(中文 Windows = GBK)解读 UTF-8 字节 → 中文乱码
    if (Test-Path $childOut) { Get-Content $childOut -Encoding UTF8 | ForEach-Object { Write-Host $_ } }
    if (Test-Path $childErr) {
        $errText = Get-Content $childErr -Raw -Encoding UTF8
        if ($errText) {
            Write-Host '── child stderr ──' -ForegroundColor DarkYellow
            Write-Host $errText -ForegroundColor Yellow
        }
    }
    $code = $proc.ExitCode

    if ($code -ne 0) {
        Write-Host ''
        Write-Host "✗ 第 $($s.Id) 步 [$($s.Name)] 失败(退出码 $code)" -ForegroundColor Red
        if (Test-Path $global:ERROR_FILE) {
            $err = Get-Content $global:ERROR_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
            Write-Host ''
            Write-Host "  错误: $($err.error)" -ForegroundColor Red
            if ($err.hint) {
                Write-Host "  建议: $($err.hint)" -ForegroundColor Yellow
            }
            Write-Host ''
            Write-Host "完整日志: $global:LOG_FILE" -ForegroundColor Gray
        }
        exit $code
    }
}

# ---- 收尾 ----
$dur = ([int]((Get-Date) - $start).TotalSeconds)
Write-Host ''
Write-Host '╔═══════════════════════════════════════════════════════╗' -ForegroundColor Green
Write-Host '║       ✓ 安装完成!(用时 ' + ('{0,3}' -f $dur) + ' 秒)                         ║' -ForegroundColor Green
Write-Host '╚═══════════════════════════════════════════════════════╝' -ForegroundColor Green
Write-Host ''
Write-Host '下一步:' -ForegroundColor Cyan
Write-Host '  1. 双击桌面图标 "Relay" 启动' -ForegroundColor White
Write-Host '  2. 首次启动会弹浏览器完成飞书授权(30 天有效)' -ForegroundColor White
Write-Host '  3. 想用 Good Practice 知识库?去这里申请权限:' -ForegroundColor White
Write-Host "     https://mi.feishu.cn/base/VtQabtymMaoBumsSCCAcmHzJn9b" -ForegroundColor Blue
Write-Host '     (没权限也能用,只是领域知识打折)' -ForegroundColor Gray
Write-Host ''
Write-Host "卡住时,双击桌面 'Agent 诊断' 自检" -ForegroundColor Gray
Write-Host ''
