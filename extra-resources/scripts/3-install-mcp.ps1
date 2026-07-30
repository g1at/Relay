# 3-install-mcp.ps1 — 飞书 MCP setup
# 跑 npx -y @mi/feishu-mcp-pro@latest setup,5 分钟超时
# 不触发飞书 OAuth(留给首次启动 Claude Code 时弹浏览器)

[CmdletBinding()]
param()

. "$PSScriptRoot\_common.ps1"

Write-Step 'Step 3: 飞书 MCP 安装与配置'

try {
    Refresh-Path

    # 设置 registry(npx 也会用)
    $env:NPM_CONFIG_REGISTRY = $global:XIAOMI_NPM_REGISTRY

    # 输出文件
    $stdoutLog = Join-Path $env:TEMP 'mcp-setup.log'
    $stderrLog = Join-Path $env:TEMP 'mcp-setup-err.log'
    Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

    Write-Log -Message '运行 feishu-mcp-pro setup(预计 1-3 分钟,首次较慢)...'
    # 同样改用 cmd /c,避免 Start-Process ExitCode 同步坑
    & cmd /c "npx -y --registry=$($global:XIAOMI_NPM_REGISTRY) @mi/feishu-mcp-pro@latest setup > `"$stdoutLog`" 2> `"$stderrLog`""
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $err = Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue
        $hint = Translate-Error -Message $err
        if (-not $hint) { $hint = "详见日志: $stderrLog" }
        Report-Error -Step 'install-mcp' `
                     -Error "setup 失败(退出码 $code)" `
                     -Hint $hint
        exit 1
    }

    # ---- 验证 MCP 注册到 Claude Code ----
    $claudeJson = Join-Path $env:USERPROFILE '.claude.json'
    if (Test-Path $claudeJson) {
        try {
            $cfg = Get-Content $claudeJson -Raw | ConvertFrom-Json
            $hasFeishu = $false
            if ($cfg.PSObject.Properties.Match('mcpServers').Count) {
                $hasFeishu = $cfg.mcpServers.PSObject.Properties.Name -contains 'feishu-mcp-pro'
            }
            if ($hasFeishu) {
                Write-Log -Level OK -Message 'feishu-mcp-pro 已注册到 Claude Code'
            } else {
                Write-Log -Level WARN -Message '在 .claude.json 中未找到 feishu-mcp-pro 配置,可能 setup 未完整成功'
            }
        } catch {
            Write-Log -Level WARN -Message "无法解析 ~/.claude.json: $($_.Exception.Message)"
        }
    } else {
        Write-Log -Level WARN -Message '~/.claude.json 不存在,可能 setup 没写入配置'
    }

    Write-Log -Level OK -Message '飞书 MCP 配置完成(首次启动 Claude Code 时会弹浏览器完成飞书授权)'
    exit 0

} catch {
    $hint = Translate-Error -Message $_.Exception.Message
    Report-Error -Step 'install-mcp' -Error $_.Exception.Message -Hint $hint -Stacktrace $_.ScriptStackTrace
    exit 1
}
