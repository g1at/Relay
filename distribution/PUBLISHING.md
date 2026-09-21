# 更新源迁移与发布

## 版本与仓库

| 版本 | 安装包发布位置 | 安装后的更新源 |
| --- | --- | --- |
| 已发布的 3.0.0 及更早版本 | 保留在 `g1at/relay-updates` | 旧仓库，可升级至 3.0.1 |
| 3.0.1 迁移版 | `g1at/Relay` 和 `g1at/relay-updates`，同一份安装包 | `g1at/Relay` |
| 高于 3.0.1 的正式版本 | 仅 `g1at/Relay` | `g1at/Relay` |

`build/release-policy.cjs` 固定迁移版本为 3.0.1。后续升级 `package.json` 和锁文件的版本即可，不要移动这个分界点。旧仓库保留历史安装包、迁移版及兼容安装入口；最后可归档，不删除旧资源。

`package.json` 的 `build.publish` 始终只指向新仓库，它决定安装包内的 `app-update.yml`。双仓发布由发布工具上传同一组文件实现，不为旧仓库再构建一个仍指向旧源的安装包。

## 1. 准备并核验本地产物

在 Windows x64 的开发环境执行。先提交本次版本源码，再准备计划，保证正式版标签能对应构建所用的源码提交。

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/cli-installer.test.ps1
npm run release
```

`npm run release` 只执行本地构建：核验安装器皮肤、准备 SDK 运行时，然后以 `--publish never` 构建到新的 `dist/release-3.0.1-<随机后缀>/`。它不会创建 GitHub Release，也不会改变仓库可见性。

目录包含安装包、blockmap、`latest.yml`、`SHA256SUMS.txt`、`release-plan.json` 及供核验的 unpacked 应用。计划记录固定的发布目标和文件哈希。工具验证内置更新源、版本、文件名、大小和更新清单的 SHA-512；不要手工编辑计划或用另一份安装包替换其中的文件。

```powershell
# 将下方目录替换为准备步骤实际输出的目录
node build/release.cjs --verify dist/release-3.0.1-ABC123
node build/release.cjs --check dist/release-3.0.1-ABC123
```

`--verify` 只检查本地文件；`--check` 另外只读检查 GitHub。正式发布要求新仓库已经 PUBLIC，目标版本高于已发布正式版本、没有同名标签或 Release，并且构建对应的源码已提交。网络或认证失败会终止检查，不会被当成“版本不存在”。

迁移实现落地时，新仓库仍处于私有阶段；因此 `--check` 应明确阻止正式发布。公开源码与正式发版是后续操作，不由准备命令自动执行。

## 2. 发布已核验的同一组文件

完成安装、升级和用户数据保留验收后，再执行：

```powershell
npm run release:publish -- dist/release-3.0.1-ABC123
```

此命令不重新构建。它复核计划及文件，在所有目标仓库完成只读预检后，创建草稿 Release 并上传相同的安装包、blockmap、`latest.yml` 和校验文件；核对上传后的大小及 SHA-256 后，先公开新仓库 Release，再公开旧仓库的最后一个 Release。高于 3.0.1 的版本只处理新仓库。

同名 Release、标签或资产不会被覆盖。中途失败时保留现场，先检查实际草稿和已发布状态；不要删除已有正式版、使用 `--clobber` 或盲目重试。若两个仓库均已成功发布，仅后续材料生成失败，可通过以下只读命令补齐材料：

```powershell
node build/release.cjs --finalize dist/release-3.0.1-ABC123
```

## 3. 提交安装入口和静态版本清单

发布工具读取每个仓库的真实、已公开 Release 元数据，并校验本地 EXE 与远端的大小和 SHA-256，分别生成清单。两份清单指向各自仓库同一内容的安装包，不能仅修改 URL 冒充验证。

产物目录中的 `static-files/NEXT-STEPS.md` 给出本次版本的提交步骤：

| 生成材料 | 提交位置 |
| --- | --- |
| `static-files/g1at-Relay/distribution/` 内的 `install.ps1`、`latest.json`、`releases/v3.0.1.json` | 新仓库的 `distribution/`，保留源码仓库根 README |
| `static-files/g1at-relay-updates/` 内的 `install.ps1`、`latest.json`、`releases/v3.0.1.json`、`README.md` | 旧仓库根目录，保留旧版本清单 |

这是维护者需要完成的文件提交，发布工具不会自动改写 Git 仓库内容。`release-response.json` 仅为本地证据，不随材料提交。

新仓库的公开安装入口为：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/g1at/Relay/main/distribution/install.ps1')))
```

旧仓库根目录使用同一份新版安装脚本，所以已有旧命令仍然有效。脚本默认选择新仓库；只有显式指定低于 3.0.1 的版本才读取旧仓库的历史清单。新版静态清单尚未提交时，会查询同一仓库的 Releases API；新仓库故障不会回退到旧仓库的 latest。

旧 3.0.0 的清单继续保留在旧仓库。源码仓库不预填未发布版本的清单，也不保留指向旧源的 `distribution/latest.json`。

提交材料后，读取公开文件核对内容，验证新旧两个安装命令的 `-DownloadOnly` 路径及哈希，再考虑归档旧仓库。应用内更新的 `latest.yml` 与命令行的 `latest.json` 必须指向相同正式版本。

## 验收边界与安装器能力

- 真实 `electron-updater` 配合隔离 HTTP 夹具，可验证旧客户端发现迁移版、新客户端只查新源以及手动下载/安装行为；这不等于真实用户已完成升级。
- PowerShell 测试隔离网络、注册表、进程启动和安装器；正式发布前仍需在独立 Windows 环境验收全新安装及 3.0.0 原地升级，确认会话、设置和项目数据保留。
- `installer.closeRunningAppGuard` 默认保守为 `false`。已发布的 3.0.0 没有新保护，不能修改其声明。仅实际验收新安装器能力后才为对应版本启用，不能由版本号推断；旧卸载器也可能不认识新策略。

独立生成清单时可运行 `node distribution/create-install-manifest.cjs --help`。默认目标是 `g1at/Relay`；只有历史或迁移版才显式使用 `--repository g1at/relay-updates`，且版本上限为 3.0.1。
