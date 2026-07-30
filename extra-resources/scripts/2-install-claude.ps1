# 2-install-claude.ps1 — 安装 Claude Code + 写两份 JSON
# 对齐官方 install-windows.bat:
#   1. npm registry 切到 npmmirror(公网)
#   2. npm install -g @anthropic-ai/claude-code
#   3. 写 ~/.claude.json {"hasCompletedOnboarding": true}  ← 跳过 /login 拦截
#   4. 写 ~/.claude/settings.json,含 mify env + CLAUDE_CODE_GIT_BASH_PATH

[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$SettingsTemplate
)

# $PSScriptRoot 在 param 默认值里有时是空,统一放到 body 里求值
if (-not $ApiKey)          { $ApiKey = $env:MIFY_KEY }
if (-not $SettingsTemplate){ $SettingsTemplate = Join-Path $PSScriptRoot '..\resources\settings.template.json' }

. "$PSScriptRoot\_common.ps1"

Write-Step 'Step 2: Claude Code 安装与配置'

if (-not $ApiKey) {
    Report-Error -Step 'install-claude' `
                 -Error '未提供 mify API Key' `
                 -Hint "请到 $global:URL_MIFY_KEY 获取后,以 -ApiKey 参数传入"
    exit 1
}

try {
    Refresh-Path

    # ════════════════════════════════════════════
    # ① npm registry → 公网 npmmirror(仅本次安装临时生效,不污染用户全局配置)
    # ════════════════════════════════════════════
    # 注意:这里**故意不再** `npm config set registry --location=user` ——
    #   那会把用户的全局默认源永久改成 npmmirror,影响该用户此后所有 npm 项目
    #   (私服包拉不到、npm publish 误发到只读镜像等),而且 Relay 设置界面管不到、
    #   用户也不知道是 Relay 改的。Relay 装包只需安装期用一下镜像即可:
    #   下面 `npm install` 命令上直接带 `--registry`(命令级覆盖,不写 .npmrc),
    #   飞书 MCP 那步也已在命令里写死 --registry。装完用户全局 registry 保持原样。
    Write-Log -Message "本次安装临时使用 npm registry: $global:NPM_REGISTRY(不改用户全局配置)"

    # ① bis: 把 npm 全局目录指向用户可写位置,避免无管理员权限时 EPERM/拒绝访问
    #   场景:Node.js 被管理员装到 Program Files → 默认全局前缀在系统目录,普通账号写不了。
    #   指到 %LOCALAPPDATA%\npm-global 后,普通用户即可全局安装,无需提权。
    $npmPrefix = Join-Path $env:LOCALAPPDATA 'npm-global'
    if (-not (Test-Path $npmPrefix)) { New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null }
    Write-Log -Message "设置 npm 全局目录(免管理员): $npmPrefix"
    & npm config set prefix $npmPrefix --location=user 2>&1 | Out-Null
    & npm config set cache (Join-Path $env:LOCALAPPDATA 'npm-cache') --location=user 2>&1 | Out-Null
    # 把该前缀加入“用户级 PATH”(持久),并刷进当前进程,确保装完能找到 claude
    $userPath = [System.Environment]::GetEnvironmentVariable('Path','User')
    if ($userPath -notlike "*$npmPrefix*") {
        [System.Environment]::SetEnvironmentVariable('Path', "$npmPrefix;$userPath", 'User')
        Write-Log -Message "已把 $npmPrefix 加入用户 PATH"
    }
    Refresh-Path
    if ($env:Path -notlike "*$npmPrefix*") { $env:Path = "$npmPrefix;$env:Path" }

    # ════════════════════════════════════════════
    # ② 安装 / 检测 Claude Code
    # ════════════════════════════════════════════
    $claudeOk = $false
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        try {
            $v = & claude --version 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Log -Level OK -Message "Claude Code 已安装: $v"
                $claudeOk = $true
            }
        } catch {}
    }

    if (-not $claudeOk) {
        Write-Log -Message 'npm 全局安装 @anthropic-ai/claude-code...'
        # 找到 npm.cmd 全路径(Start-Process 直接调 'npm' 可能找不到)
        $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
        if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
        if (-not $npmCmd) { throw "找不到 npm,请确认 Node.js 已正确安装并在 PATH 中" }

        $outLog = "$env:TEMP\npm-claude.log"
        $errLog = "$env:TEMP\npm-claude-err.log"
        # 在命令上再显式 --prefix,强制装到用户目录(防止系统级 .npmrc 把 prefix 又拉回 Program Files)
        # --registry 也在命令上显式传:本次安装走 npmmirror,但不写进用户 .npmrc(命令级覆盖,临时生效)
        $proc = Start-Process -FilePath $npmCmd `
            -ArgumentList @('install','-g','--prefix',"`"$npmPrefix`"",'--registry',$global:NPM_REGISTRY,'@anthropic-ai/claude-code') `
            -NoNewWindow -PassThru -Wait `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError  $errLog
        $code = $proc.ExitCode
        if ($code -ne 0) {
            # npm 把详细错误同时写 stdout 和 stderr,合并取最后若干行作为原因
            $errTxt = (Get-Content $errLog -Raw -ErrorAction SilentlyContinue)
            $outTxt = (Get-Content $outLog -Raw -ErrorAction SilentlyContinue)
            $detail = (($errTxt, $outTxt) -join "`n").Trim()
            if ($detail.Length -gt 600) { $detail = $detail.Substring($detail.Length - 600) }
            if (-not $detail) { $detail = '(无输出;常见原因:权限/网络)' }
            throw "npm 安装失败(退出码 $code): $detail"
        }
        Refresh-Path
        if ($env:Path -notlike "*$npmPrefix*") { $env:Path = "$npmPrefix;$env:Path" }
        Write-Log -Level OK -Message 'Claude Code 安装完成'
    }

    # ════════════════════════════════════════════
    # ③ 写 ~/.claude.json,跳过 onboarding
    # ════════════════════════════════════════════
    # 对齐 install-windows.bat 第 115-132 行
    Write-Log -Message "设置 $global:CLAUDE_JSON 的 hasCompletedOnboarding: true"
    if (Test-Path $global:CLAUDE_JSON) {
        try {
            $cj = Get-Content $global:CLAUDE_JSON -Raw | ConvertFrom-Json
        } catch {
            Write-Log -Level WARN -Message ".claude.json 解析失败,备份后重写"
            Copy-Item $global:CLAUDE_JSON "$global:CLAUDE_JSON.bak.$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
            $cj = [pscustomobject]@{}
        }
    } else {
        $cj = [pscustomobject]@{}
    }
    $cj | Add-Member -NotePropertyName 'hasCompletedOnboarding' -NotePropertyValue $true -Force
    Write-JsonFile -Path $global:CLAUDE_JSON -Object $cj
    Write-Log -Level OK -Message '.claude.json 已更新(跳过 /login 流程,无 BOM)'

    # ════════════════════════════════════════════
    # ④ 探测 Git Bash 路径(从 step 1 的临时文件读)
    # ════════════════════════════════════════════
    $gitBash = ''
    $bashCache = Join-Path $env:TEMP 'relay-gitbash.txt'
    if (Test-Path $bashCache) {
        $gitBash = (Get-Content $bashCache -Raw -ErrorAction SilentlyContinue).Trim()
    }
    if (-not $gitBash) {
        # 兜底再探测一次
        $gitBash = Get-GitBashPath
    }
    if ($gitBash) {
        Write-Log -Level OK -Message "Git Bash 路径: $gitBash"
    } else {
        Write-Log -Level WARN -Message 'Git Bash 未找到,CLAUDE_CODE_GIT_BASH_PATH 将不写入'
    }

    # ════════════════════════════════════════════
    # ⑤ 渲染并合并 ~/.claude/settings.json
    # ════════════════════════════════════════════
    Write-Log -Message "合并 settings.json: $global:CLAUDE_SETTINGS"
    if (-not (Test-Path $global:CLAUDE_HOME)) {
        New-Item -ItemType Directory -Force -Path $global:CLAUDE_HOME | Out-Null
    }

    if (-not (Test-Path $SettingsTemplate)) {
        throw "settings 模板不存在: $SettingsTemplate"
    }
    $templateRaw = Get-Content $SettingsTemplate -Raw
    $rendered = $templateRaw.Replace('{{API_KEY}}', $ApiKey)
    # GIT_BASH_PATH:JSON 里反斜杠要转义
    $bashForJson = $gitBash.Replace('\','\\')
    $rendered = $rendered.Replace('{{GIT_BASH_PATH}}', $bashForJson)
    $templateObj = $rendered | ConvertFrom-Json

    # 没探测到 git bash → 从模板里把 CLAUDE_CODE_GIT_BASH_PATH 字段移除
    if (-not $gitBash -and $templateObj.env.PSObject.Properties.Match('CLAUDE_CODE_GIT_BASH_PATH').Count) {
        $templateObj.env.PSObject.Properties.Remove('CLAUDE_CODE_GIT_BASH_PATH')
    }

    # 合并:env 字段嵌套合并;顶层 model/alwaysThinkingEnabled/skipDangerousModePermissionPrompt 覆盖
    if (Test-Path $global:CLAUDE_SETTINGS) {
        try {
            $existing = Get-Content $global:CLAUDE_SETTINGS -Raw | ConvertFrom-Json
            Write-Log -Message '检测到现有 settings.json,执行合并'
        } catch {
            Write-Log -Level WARN -Message 'settings.json 解析失败,备份后重写'
            Copy-Item $global:CLAUDE_SETTINGS "$global:CLAUDE_SETTINGS.bak.$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
            $existing = [pscustomobject]@{}
        }
    } else {
        $existing = [pscustomobject]@{}
    }

    if (-not $existing.PSObject.Properties.Match('env').Count) {
        $existing | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    foreach ($p in $templateObj.env.PSObject.Properties) {
        $existing.env | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force
    }
    foreach ($name in @('model','alwaysThinkingEnabled','skipDangerousModePermissionPrompt')) {
        if ($templateObj.PSObject.Properties.Match($name).Count) {
            $val = $templateObj.$name
            $existing | Add-Member -NotePropertyName $name -NotePropertyValue $val -Force
        }
    }

    Write-JsonFile -Path $global:CLAUDE_SETTINGS -Object $existing
    Write-Log -Level OK -Message 'settings.json 已更新'

    # ════════════════════════════════════════════
    # ⑥ 验证
    # ════════════════════════════════════════════
    Refresh-Path
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Report-Error -Step 'install-claude' `
                     -Error 'claude 命令安装后仍找不到' `
                     -Hint '请重启终端或注销重登,让 PATH 生效'
        exit 1
    }
    Write-Log -Level OK -Message 'Claude Code 安装与配置完成'
    exit 0

} catch {
    $hint = Translate-Error -Message $_.Exception.Message
    Report-Error -Step 'install-claude' -Error $_.Exception.Message -Hint $hint -Stacktrace $_.ScriptStackTrace
    exit 1
}
