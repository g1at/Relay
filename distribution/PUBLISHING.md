# 命令行安装渠道发布

终端用户只需要公开 README 中的 PowerShell 命令。以下工具仅供 Relay 发布维护者使用，不是用户的安装依赖。

## 发布顺序

1. 按原流程构建、验证并发布正式 GitHub Release，上传 EXE、blockmap、latest.yml 和 SHA-256 文件。
2. 将该 Release 的完整 REST JSON 保存为本地文件，保留 `tag_name`、`html_url`、`draft`、`prerelease`、`published_at` 和 `assets`。不要使用删减字段的验证摘要。
3. 对本地最终 EXE 生成清单：

```sh
node distribution/create-install-manifest.cjs --release-json release.json --installer dist/Relay-3.0.0-Setup.exe --output distribution/releases/v3.0.0.json
```

4. 生成器核对已公开正式版状态、官方 URL、文件名、上传状态、大小及 SHA-256。通过后，将生成的版本清单复制为 `distribution/latest.json`。
5. 向 **g1at/relay-updates** 的同一个提交写入根目录 `install.ps1`、`README.md`、`latest.json` 和 `releases/vX.Y.Z.json`，保留已有其他版本清单。不要向更新仓库上传源项目或凭据。
6. 读取公开文件核对内容，执行公开命令的 `-DownloadOnly` 路径并核验哈希。全新安装和实际旧版本升级需在独立 Windows 测试环境完成。

更新说明、应用内 `latest.yml` 和命令行 `latest.json` 应指向同一正式版本。不要先更新清单再上传 EXE，也不要覆盖已发布版本的 EXE 来悄悄改变哈希。不要在清单校验失败时上传旧清单充当新版本。

## 安装器能力

`installer.closeRunningAppGuard` 默认 `false`。已发布的 3.0.0 安装包没有新 NSIS 保护，必须保持 `false`。

新源码在收到 `--relay-no-close` 时检查 Relay 进程，发现占用返回错误，不进入原生强退流程；通过当前进程环境将策略传给同样支持该能力的卸载器。仅当新安装器已构建并验证后，才可对该版本生成器添加 `--close-running-app-guard`。

旧安装的卸载器可能仍不认识该策略，所以能力位不代表升级任意旧版都没有进程竞态。升级期间仍要求 Relay 保持关闭。不能仅凭脚本传了参数或版本号变大便开启能力位。

## 验证命令

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/cli-installer.test.ps1
node --test test/create-install-manifest.test.js
```

这些行为测试隔离网络、进程启动和注册表，不会执行真实 Relay 安装器；不能据此替代干净系统安装、旧版升级及用户数据迁移验收。
