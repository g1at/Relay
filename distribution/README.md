# Relay 下载与更新

Relay 是 Windows 本地 AI 助手。[g1at/Relay](https://github.com/g1at/Relay) 提供源码、官方安装包、应用内更新文件和命令行安装入口。

## 一条命令安装或升级

在 **Windows x64 的 PowerShell 5.1 或 PowerShell 7** 中执行。新用户和老用户使用同一条命令，无需 GitHub 账号，也无需预装 Git、Node.js、Python 或 Claude Code：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1')))
```

| 当前状态 | 命令会做什么 |
| --- | --- |
| 从未安装 | 下载最新正式版，默认安装到当前用户目录 |
| 已安装旧版 | 沿用已登记的目录和安装范围升级 |
| 已是最新版 | 验证安装文件后提示已是最新版，不重复下载安装 |
| 本地版本更高 | 拒绝自动降级 |
| Relay 正在运行 | 可先完成下载；执行安装前提示退出，安装包保留供下次复用 |

安装成功后，从开始菜单打开 Relay。首次使用仍需配置服务商；脚本不安装 WSL，也不会替用户填写密钥。

## 更新源迁移与 3.0.2 安装修复

3.0.1 是双源迁移版；3.0.2 安装修复版也计划同步发布到 `g1at/Relay` 和 `g1at/relay-updates`，帮助仍在旧源的用户升级。安装这些迁移版本后，后续应用内更新使用 `g1at/Relay`。3.0.3 及后续版本只发布到新仓库。

旧客户端若停留在“已下载，重启安装”且无法重新检查，需要在 3.0.2 正式发布后手动下载完整安装包升级；新版本的重新检查修复无法提前作用于旧客户端。保存工作并退出托盘实例后运行完整包，不删除会话和配置。维护者交付路径及校验步骤见 [发布说明](PUBLISHING.md#已下载旧安装包的客户端)。

新版安装脚本默认从 `g1at/Relay` 下载最新正式版；显式指定低于 3.0.1 的稳定版本（包括 3.0.0 和 2.x）时，使用旧仓库的精确版本，指定 3.0.1 或更高版本时使用新仓库。发布迁移版时会把新版脚本同步到旧仓库根目录，因此已有的旧安装命令仍能使用，并会按同一规则选择下载源。新命令的脚本路径是 `g1at/Relay/main/distribution/install.ps1`。

## 下载、版本与安装向导

```powershell
# 只下载，不安装，不影响正在运行的 Relay
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1'))) -DownloadOnly

# 指定历史正式版本；精确使用旧仓库，不会自动降级
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1'))) -Version 3.0.0

# 仅下载到指定目录（不是修改应用安装目录）
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1'))) -DownloadOnly -DownloadDirectory 'D:\Downloads\Relay'

# 显示安装向导，也可用于修复文件不完整的同版本安装
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1'))) -Interactive
```

默认下载目录是 `%LOCALAPPDATA%\Relay\Installers`。中断后重新执行同一命令，会复用已下载的部分继续下载；如果服务端不支持续传，会重新下载。安装前始终验证文件大小和 SHA-256，校验失败不会执行。

也可以先保存并查看脚本，再执行：

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1' -OutFile '.\relay-install.ps1'
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

脚本优先读取所选仓库的静态版本清单，正常情况下不依赖 GitHub API 配额；清单无法获取时会重试并查询同一仓库的公开 Releases API。新仓库故障不会自动改用旧仓库的最新版；已获取但校验失败的清单也不会触发 API 回退。需要能够访问 GitHub Raw 和 Release 下载服务，失败时请检查网络或系统代理后重试。

网络不可用时，可在另一台电脑下载官方 EXE 和校验文件后带到目标电脑手动安装；在线命令本身需要查询版本，不能当作离线安装命令。当前渠道提供 Windows x64 安装包，尚未提供 ARM64、macOS 或 Linux 安装包。

SHA-256 用于校验下载内容，不替代 Windows 代码签名。当前 3.0.0 安装包未配置签名证书；Windows 的安全提示仍由系统处理。

## 手动下载

- [最新正式版本](https://github.com/g1at/Relay/releases/latest)
- [Relay 3.0.0 Windows 安装包](https://github.com/g1at/relay-updates/releases/download/v3.0.0/Relay-3.0.0-Setup.exe)

命令行安装与应用内更新使用同一份官方 EXE。Release 资产中的 `latest.yml` 和 `.blockmap` 供应用内更新使用；新仓库的 `distribution/latest.json` 和 `distribution/releases/vX.Y.Z.json` 供命令行安装使用。旧仓库保留根目录下的 `latest.json` 和 `releases/vX.Y.Z.json`。

### 维护者生成清单

生成器读取真实 GitHub Release 元数据，并核对本地安装包名称、大小与 SHA-256。默认仅接受 `g1at/Relay` 的 Release 和下载地址：

```powershell
node distribution/create-install-manifest.cjs --release-json release.json --installer Relay-3.0.1-Setup.exe --output distribution/releases/v3.0.1.json
```

仅在为旧仓库生成历史或桥接清单时显式添加 `--repository g1at/relay-updates`，版本不得高于 3.0.2。桥接发布的两份清单使用各自仓库的真实 Release 元数据；不能仅替换 URL。`--close-running-app-guard` 只在确认该安装包包含关闭应用保护后使用，不根据版本号推定。

3.0.2 的独立构建、安装事务和异常中断恢复说明见 [HOTFIX-3.0.2.md](HOTFIX-3.0.2.md)。
