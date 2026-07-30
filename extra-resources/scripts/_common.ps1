# _common.ps1 — 共享工具函数
# 所有 install 脚本通过 . "$PSScriptRoot\_common.ps1" 加载

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
# 常量
# ============================================================

$global:LOG_FILE     = Join-Path $env:TEMP 'relay-install.log'
$global:ERROR_FILE   = Join-Path $env:TEMP 'relay-install-error.json'
$global:PREFLIGHT_FILE = Join-Path $env:TEMP 'relay-preflight.json'

$global:CLAUDE_HOME  = Join-Path $env:USERPROFILE '.claude'
$global:CLAUDE_SETTINGS = Join-Path $global:CLAUDE_HOME 'settings.json'
$global:CLAUDE_JSON  = Join-Path $env:USERPROFILE '.claude.json'   # 不是 settings.json,是 onboarding flag 那个

$global:MIN_NODE_MAJOR = 20
$global:MIN_DISK_MB = 500

# 软件版本(对齐 install-windows.bat)
$global:GIT_VERSION    = '2.47.1'
$global:NODE_VERSION   = '20.19.6'

# 下载源(全部走阿里云公网镜像 - 对齐 install-windows.bat)
$global:NPM_REGISTRY   = 'https://registry.npmmirror.com'
$global:URL_GIT_MSI    = "https://registry.npmmirror.com/-/binary/git-for-windows/v$($global:GIT_VERSION).windows.1/Git-$($global:GIT_VERSION)-64-bit.exe"
$global:URL_NODE_MSI   = "https://npmmirror.com/mirrors/node/v$($global:NODE_VERSION)/node-v$($global:NODE_VERSION)-x64.msi"

# 飞书 MCP 走小米内网(@mi/* 包仅内网可用)
$global:XIAOMI_NPM_REGISTRY = 'https://pkgs.d.xiaomi.net/artifactory/api/npm/mi-npm/'

# 网络端点(用于 preflight 连通性检测)
$global:URL_MIFY       = 'http://model.mify.ai.srv'
$global:URL_NPMMIRROR  = 'https://registry.npmmirror.com'
$global:URL_XIAOMI_NPM = 'https://pkgs.d.xiaomi.net'
$global:URL_FEISHU     = 'https://mi.feishu.cn'
$global:URL_MIFY_KEY   = 'https://llm.mioffice.cn/apikey'

# ============================================================
# 日志
# ============================================================

function Write-Log {
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('INFO','WARN','ERROR','OK')][string]$Level = 'INFO'
    )
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [$Level] $Message"
    Add-Content -Path $global:LOG_FILE -Value $line -Encoding utf8

    $color = switch ($Level) {
        'INFO'  { 'White' }
        'WARN'  { 'Yellow' }
        'ERROR' { 'Red' }
        'OK'    { 'Green' }
    }
    Write-Host $line -ForegroundColor $color
}

function Write-Step {
    param([string]$Title)
    $line = "`n========== $Title =========="
    Add-Content -Path $global:LOG_FILE -Value $line -Encoding utf8
    Write-Host $line -ForegroundColor Cyan
}

# ============================================================
# 错误上报(供 Inno 读取)
# ============================================================

function Report-Error {
    param(
        [Parameter(Mandatory)][string]$Step,
        [Parameter(Mandatory)][string]$Error,
        [string]$Hint = '',
        [string]$Stacktrace = ''
    )
    $payload = @{
        step       = $Step
        error      = $Error
        hint       = $Hint
        stacktrace = $Stacktrace
        timestamp  = (Get-Date -Format 'o')
    } | ConvertTo-Json -Depth 5
    $payload | Out-File -FilePath $global:ERROR_FILE -Encoding utf8
    Write-Log -Level ERROR -Message "[$Step] $Error"
    if ($Hint) { Write-Log -Level WARN -Message "建议: $Hint" }
}

function Translate-Error {
    param([string]$Message)
    # 把常见英文错误翻译成中文提示
    switch -Regex ($Message) {
        'ECONNREFUSED|ENOTFOUND|getaddrinfo' { return '无法连接服务器,请检查网络或小米 VPN' }
        'EPERM|EACCES|Access is denied|权限被拒绝|operation not permitted' { return 'npm 全局目录无写入权限(常见于 Node.js 曾用管理员装到 Program Files)。本安装器已自动改用用户目录,请直接点「重试」;若仍失败,可右键以管理员身份重新运行。' }
        'winget.*不是.*识别|winget.*not recognized' { return '系统不支持 winget(可能 Win10 旧版),将回退到内嵌安装包' }
        'npm ERR! 404'                       { return 'npm 仓库地址错误,请联系 IT 检查内网' }
        'ETIMEDOUT|timeout'                  { return '网络超时,请检查 VPN 后重试' }
        'EISDIR|EEXIST'                      { return '文件路径冲突,请检查是否有残留安装' }
        default                              { return '' }
    }
}

# ============================================================
# 工具函数
# ============================================================

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-Path {
    # 安装新软件后刷新当前进程 PATH(机器级 + 用户级合并)
    $machine = [System.Environment]::GetEnvironmentVariable('Path','Machine')
    $user    = [System.Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = "$machine;$user"
}

function Write-JsonFile {
    # PS 5.1 的 Out-File -Encoding utf8 会强制加 BOM,某些 JSON 解析器(如 feishu-mcp-pro)会读不动
    # 用 .NET 直接写,UTF-8 无 BOM
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Object,
        [int]$Depth = 10
    )
    $json = $Object | ConvertTo-Json -Depth $Depth
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Get-NodeMajorVersion {
    try {
        $v = & node -v 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return 0 }
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
        return 0
    } catch { return 0 }
}

function Test-GitInstalled {
    try {
        $null = & git --version 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Get-GitBashPath {
    # 返回 git bash.exe 完整路径,找不到则返回空字符串
    # 对齐 install-windows.bat 第 134-151 行的逻辑
    try {
        $gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
        if (-not $gitExe) { return '' }
        # git.exe 通常在 Git\cmd\git.exe,bash.exe 在 Git\bin\bash.exe
        $gitCmdDir = Split-Path $gitExe -Parent
        $bashPath  = Join-Path (Split-Path $gitCmdDir -Parent) 'bin\bash.exe'
        $bashPath  = [System.IO.Path]::GetFullPath($bashPath)
        if (Test-Path $bashPath) { return $bashPath }
        return ''
    } catch { return '' }
}

function Test-Connectivity {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Timeout = $TimeoutSec * 1000
        $req.Method  = 'HEAD'
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        # 4xx/5xx 也算"能通",只要 DNS+TCP 成立
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Invoke-WithTimeout {
    # 跑一个外部命令,超时强杀
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 60,
        [string]$StdoutFile = $null,
        [string]$StderrFile = $null
    )
    $spInfo = @{
        FilePath     = $FilePath
        ArgumentList = $ArgumentList
        NoNewWindow  = $true
        PassThru     = $true
        Wait         = $false
    }
    if ($StdoutFile) { $spInfo.RedirectStandardOutput = $StdoutFile }
    if ($StderrFile) { $spInfo.RedirectStandardError  = $StderrFile }

    $proc = Start-Process @spInfo
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch {}
        throw "命令超时(${TimeoutSec}s): $FilePath $($ArgumentList -join ' ')"
    }
    return $proc.ExitCode
}
