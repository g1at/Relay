# 1-install-deps.ps1 — 安装 Git + Node.js
# 对齐官方 install-windows.bat:
#   - Git for Windows 2.47.1  (从 npmmirror 下载)
#   - Node.js LTS 20.19.6     (从 npmmirror 下载)
# Bundled MSI 作为离线兜底

[CmdletBinding()]
param(
    [switch]$AssumeUpgrade,
    [string]$BundledNodeMsi
)

# $PSScriptRoot 在 param 默认值里有时是空,统一放到 body 里求值
if (-not $BundledNodeMsi) {
    $BundledNodeMsi = Join-Path $PSScriptRoot '..\resources\nodejs-lts.msi'
}

. "$PSScriptRoot\_common.ps1"

# ─────────────────────────────────────────────
# 工具:下载文件(TLS 1.2 强制 + 重试一次)
# ─────────────────────────────────────────────
function Invoke-Download {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile
    )
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
        return $true
    } catch {
        Write-Log -Level WARN -Message "下载失败,1 次重试: $($_.Exception.Message)"
        try {
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
            return $true
        } catch {
            Write-Log -Level ERROR -Message "下载最终失败: $($_.Exception.Message)"
            return $false
        }
    }
}

# ════════════════════════════════════════════════════════════════
# Step 1a:Git for Windows
# ════════════════════════════════════════════════════════════════
Write-Step 'Step 1a: Git for Windows'

try {
    if (Test-GitInstalled) {
        $v = & git --version
        Write-Log -Level OK -Message "Git 已安装: $v,跳过"
    } else {
        Write-Log -Message "Git 未安装,从 npmmirror 下载 v$($global:GIT_VERSION)..."
        $gitExe = Join-Path $env:TEMP 'Git-installer.exe'
        if (-not (Invoke-Download -Url $global:URL_GIT_MSI -OutFile $gitExe)) {
            Report-Error -Step 'install-git' `
                         -Error 'Git 安装包下载失败' `
                         -Hint '检查网络或 VPN,或手动到 https://git-scm.com 下载安装'
            exit 1
        }
        Write-Log -Message 'Git 下载完成,静默安装...'
        # 对齐 install-windows.bat 第 26 行
        $proc = Start-Process -FilePath $gitExe -ArgumentList `
            '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/CLOSEAPPLICATIONS','/RESTARTAPPLICATIONS',`
            '/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh' `
            -Wait -PassThru
        Remove-Item $gitExe -Force -ErrorAction SilentlyContinue
        if ($proc.ExitCode -ne 0) {
            Report-Error -Step 'install-git' `
                         -Error "Git 安装失败(退出码 $($proc.ExitCode))" `
                         -Hint '可能需要管理员权限,请右键以管理员身份重新运行'
            exit 1
        }
        Refresh-Path
        if (-not (Test-GitInstalled)) {
            Report-Error -Step 'install-git' `
                         -Error 'Git 装完但当前进程找不到' `
                         -Hint '请关闭安装器,重启终端,重新运行'
            exit 1
        }
        Write-Log -Level OK -Message 'Git 安装成功'
    }

    # 探测 git bash 路径(后面 settings.json 要用),写到临时文件供下个脚本读取
    $bash = Get-GitBashPath
    $bashCacheFile = Join-Path $env:TEMP 'relay-gitbash.txt'
    if ($bash) {
        Write-Log -Level OK -Message "Git Bash 路径: $bash"
        $bash | Out-File -FilePath $bashCacheFile -Encoding utf8 -NoNewline
    } else {
        Write-Log -Level WARN -Message 'Git bash.exe 未找到,settings.json 将不写 CLAUDE_CODE_GIT_BASH_PATH'
        Remove-Item $bashCacheFile -ErrorAction SilentlyContinue
    }

} catch {
    $hint = Translate-Error -Message $_.Exception.Message
    Report-Error -Step 'install-git' -Error $_.Exception.Message -Hint $hint -Stacktrace $_.ScriptStackTrace
    exit 1
}

# ════════════════════════════════════════════════════════════════
# Step 1b:Node.js LTS
# ════════════════════════════════════════════════════════════════
Write-Step 'Step 1b: Node.js'

try {
    $current = Get-NodeMajorVersion
    if ($current -ge $global:MIN_NODE_MAJOR) {
        Write-Log -Level OK -Message "Node.js 已安装且版本满足要求(v$current),跳过"
        exit 0
    }

    if ($current -gt 0) {
        Write-Log -Level WARN -Message "Node.js 当前 v$current,需升级到 v$($global:MIN_NODE_MAJOR)+"
        if (-not $AssumeUpgrade) {
            $ans = Read-Host '是否升级 Node.js?(可能影响其他依赖该版本的项目)[Y/n]'
            if ($ans -match '^(n|N)') {
                Report-Error -Step 'install-node' `
                             -Error 'Node 版本不满足且用户拒绝升级' `
                             -Hint '手动升级 Node 到 v20+ 后重新运行安装器'
                exit 1
            }
        }
    } else {
        Write-Log -Message 'Node.js 未安装,准备安装'
    }

    # 主路径:npmmirror 下载(对齐 install-windows.bat 第 64 行)
    $nodeMsi = Join-Path $env:TEMP 'node-installer.msi'
    $downloaded = $false

    Write-Log -Message "从 npmmirror 下载 Node.js v$($global:NODE_VERSION)..."
    if (Invoke-Download -Url $global:URL_NODE_MSI -OutFile $nodeMsi) {
        $downloaded = $true
    } else {
        Write-Log -Level WARN -Message '在线下载失败,尝试使用内嵌 MSI 兜底'
        if (Test-Path $BundledNodeMsi) {
            Copy-Item $BundledNodeMsi $nodeMsi -Force
            $downloaded = $true
            Write-Log -Message "已切到内嵌 MSI: $BundledNodeMsi"
        }
    }

    if (-not $downloaded) {
        Report-Error -Step 'install-node' `
                     -Error 'Node.js 安装包下载失败且无内嵌兜底' `
                     -Hint '检查网络或手动放置 nodejs-lts.msi 到 resources/'
        exit 1
    }

    Write-Log -Message 'Node.js 下载完成,静默安装...'
    $proc = Start-Process msiexec.exe -ArgumentList '/i',"`"$nodeMsi`"",'/passive','/norestart' -Wait -PassThru
    Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Report-Error -Step 'install-node' `
                     -Error "Node.js 安装失败(退出码 $($proc.ExitCode))" `
                     -Hint '可能需要管理员权限,请右键以管理员身份重新运行'
        exit 1
    }

    Refresh-Path
    $newVer = Get-NodeMajorVersion
    if ($newVer -lt $global:MIN_NODE_MAJOR) {
        Report-Error -Step 'install-node' `
                     -Error "安装后 Node 版本仍为 v$newVer" `
                     -Hint '请关闭安装器,重启终端,重新运行让 PATH 生效'
        exit 1
    }
    Write-Log -Level OK -Message "Node.js 安装成功: v$newVer"
    exit 0

} catch {
    $hint = Translate-Error -Message $_.Exception.Message
    Report-Error -Step 'install-node' -Error $_.Exception.Message -Hint $hint -Stacktrace $_.ScriptStackTrace
    exit 1
}
