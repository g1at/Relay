# Relay 下载与更新

Relay 是 Windows 本地 AI 助手。这个公开仓库提供官方安装包、应用内更新文件和命令行安装入口。

## 一条命令安装或升级

在 **Windows x64 的 PowerShell 5.1 或 PowerShell 7** 中执行。新用户和老用户使用同一条命令，无需 GitHub 账号，也无需预装 Git、Node.js、Python 或 Claude Code：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1')))
```

| 当前状态 | 命令会做什么 |
| --- | --- |
| 从未安装 | 下载最新正式版，默认安装到当前用户目录 |
| 已安装旧版 | 沿用已登记的目录和安装范围升级 |
| 已是最新版 | 验证安装文件后提示已是最新版，不重复下载安装 |
| 本地版本更高 | 拒绝自动降级 |
| Relay 正在运行 | 可先完成下载；执行安装前提示退出，安装包保留供下次复用 |

安装成功后，从开始菜单打开 Relay。首次使用仍需配置服务商；脚本不安装 WSL，也不会替用户填写密钥。

## 下载、版本与安装向导

```powershell
# 只下载，不安装，不影响正在运行的 Relay
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1'))) -DownloadOnly

# 指定正式版本；不会自动降级
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1'))) -Version 3.0.0

# 仅下载到指定目录（不是修改应用安装目录）
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1'))) -DownloadOnly -DownloadDirectory 'D:\Downloads\Relay'

# 显示安装向导，也可用于修复文件不完整的同版本安装
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1'))) -Interactive
```

默认下载目录是 `%LOCALAPPDATA%\Relay\Installers`。中断后重新执行同一命令，会复用已下载的部分继续下载；如果服务端不支持续传，会重新下载。安装前始终验证文件大小和 SHA-256，校验失败不会执行。

也可以先保存并查看脚本，再执行：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/g1at/relay-updates/main/install.ps1' -OutFile '.\relay-install.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\relay-install.ps1'
```

这里的执行策略参数仅影响此次 PowerShell 进程，不修改系统的持久策略。

## 老用户升级

- 沿用安装器的原地升级流程，保留安装目录外的会话、配置、技能、记忆和项目文件，不主动清理个人数据。请勿将自己的文件放在应用安装目录中。
- 当前用户安装一般无需管理员权限；原来是所有用户安装时，升级可能弹出 Windows UAC 授权。
- 同时存在多个安装、安装登记损坏、未知旧产品标识或旧 32 位登记时，不猜测迁移位置。使用 `-DownloadOnly` 获取安装包，再通过安装向导检查处理。未登记的便携副本不承诺自动识别或迁移。
- 升级前退出 Relay，包括托盘实例。下载完成后脚本会检查进程；**3.0.0 及更早安装包仍有原生关闭进程逻辑，安装期间请勿重新打开 Relay**。脚本不会调用强制终止命令，也不会假定旧安装包具备新保护能力。
- 脚本检查安装器退出码、安装登记、原目录、应用文件及版本；无法确认时会报错，不会只凭退出码 0 宣布成功。

## 下载问题

脚本优先读取本仓库的静态版本清单，正常情况下不依赖 GitHub API 配额；清单无法获取时会重试并回退到公开 Releases API。需要能够访问 GitHub Raw 和 Release 下载服务，失败时请检查网络或系统代理后重试。

网络不可用时，可在另一台电脑下载官方 EXE 和校验文件后带到目标电脑手动安装；在线命令本身需要查询版本，不能当作离线安装命令。当前渠道提供 Windows x64 安装包，尚未提供 ARM64、macOS 或 Linux 安装包。

SHA-256 用于校验下载内容，不替代 Windows 代码签名。当前 3.0.0 安装包未配置签名证书；Windows 的安全提示仍由系统处理。

## 手动下载

- [最新正式版本](https://github.com/g1at/relay-updates/releases/latest)
- [Relay 3.0.0 Windows 安装包](https://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe)

命令行安装与应用内更新使用同一份官方 EXE。`latest.yml` 和 `.blockmap` 供应用内更新使用；`latest.json` 和 `releases/vX.Y.Z.json` 供命令行安装使用。
