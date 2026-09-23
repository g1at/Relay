# Relay 3.0.2 安装修复包

本版本从正式 3.0.1 源码 `09d8924af1b290883e0c4dc7fd215b876a1fdf5c` 建立独立分支 `codex/hotfix-3.0.2`。它只包含安装、卸载、更新器和发布渠道修复。原开发目录中的浏览器自动化功能不进入此版本。

## 修复行为

- 已识别的正式 3.0.0 / 3.0.1 升级时，安装器直接接管旧应用目录，不调用存在缺陷的旧卸载器。旧版登记、应用文件和快捷方式先保存到安装目录旁的同卷恢复目录。最初本地交付的 3.0.2 候选包也按其卸载器精确散列接管，避免替换该包时仍由旧卸载器弹出 PowerShell 窗口。
- 旧版主程序、卸载器、整个安装目录丢失时，只要登记足以安全识别原位置，仍可恢复安装。目录或安装范围发生变化时停止，避免误操作其他位置。
- 安装器验证打包文件的大小、SHA-256，以及新版本登记、安装位置和卸载器指向，再提交。新卸载器先移出应用目录、清理登记，并在验证结果后删除恢复副本。
- 已知安装失败路径显式执行回滚。进程被终止、断电或异常直接退出时，保留 `.relay-recovery-*` 内的旧应用与恢复记录；下次安装拒绝覆盖未完成事务。
- 修正 Windows 已知文件夹读取和含空格、中文的 `/D=` 目录解析。
- 安装与卸载的 PowerShell 事务通过 NSIS 隐藏执行插件运行，等待完成并保留退出码，不再为每个步骤弹出控制台窗口。手动运行 `recover.cmd` 仍保留可见诊断。
- 已下载更新仍可手动重新检查；只有用户确认替换后才开始新下载。下载失败回到可重试状态。

## 数据与异常恢复

安装过程不删除会话、配置或外部项目目录，也不清理 `conversation-scratch`。应用文件被占用时安装失败并保留原文件，不强行删除。

如因异常中断留下未完成事务，请先关闭 Relay，再运行原安装目录旁对应 `.relay-recovery-*/recover.cmd`。该目录含 `transaction.json`、恢复脚本及旧文件副本；不要手工删除。全用户安装的恢复脚本需要右键“以管理员身份运行”。恢复成功后重新运行完整 3.0.2 安装包。若恢复脚本失败，保留整个目录并查看 `last-error.txt`。

未知版本或未知卸载器散列使用正常上游升级路径，不把任意本地修改版当作已确认的受影响版本。异常直接退出不承诺自动回滚。

## 构建

使用 Windows Node.js 和 Git，在独立 hotfix 工作树执行；不要从仍有未完成开发的工作目录打包：

```powershell
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;' + $env:PATHEXT
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm ci --prefer-offline --no-audit --no-fund
# 若 npm 的脚本策略阻止安装脚本，显式准备现有锁定依赖：
node node_modules/electron/install.js
node node_modules/node-pty/scripts/prebuild.js
# 本机无 Visual Studio 构建工具时，显式验证并采用现有 node-pty 预编译模块：
$env:RELAY_USE_PREBUILT_NATIVE = '1'
npm run release
Remove-Item Env:RELAY_USE_PREBUILT_NATIVE
node build/release.cjs --verify '<生成的 dist/release-3.0.2-* 目录>'
```

默认 `npm run release` 保留 electron-builder 的原生依赖重编译行为。仅在明确设置 `RELAY_USE_PREBUILT_NATIVE=1` 时，发布脚本先启动锁定的真实 Windows x64 Electron，在临时独立 home、userData、AppData 环境中运行 `build/verify-native-runtime.cjs`：核对 node-pty 1.1.0、加载文件与随包 win32-x64 预编译文件的 SHA-256 一致，并通过真实 PTY 启动 cmd、收到随机标记且退出码为 0。全部通过后才给 electron-builder 传入 `--config.npmRebuild=false`；缺失模块、ABI 错误、超时或校验失败都会阻断构建，不作无条件跳过。验证报告保存为产物目录内的 `native-runtime-verification.json`。

`npm run release` 只在本机构建，使用 `--publish never`。源码须先提交，最终 `release-plan.json` 应记录该提交且 `sourceDirty: false`。`SHA256SUMS.txt`、`latest.yml` 和安装包必须一起保存。

发布策略允许 3.0.2 向 `g1at/Relay` 与 `g1at/relay-updates` 各发布同一组已验证产物，使旧更新渠道能够到达修复版；3.0.3 及后续版本只发新渠道。正式发布是独立操作。旧客户端若卡在已缓存旧包，应手工下载完整 3.0.2 Setup.exe。

## 验证范围

针对安装事务、原生 NSIS 生命周期、命令行目录、打包清单、更新缓存及发布策略运行测试。原生升级集成测试使用不同的产品名和 GUID；旧卸载器采用只记录调用且返回失败的惰性程序，正式旧卸载器的散列识别另由真实文件样本验证。

集成测试覆盖：3.0.0 / 3.0.1 完整或损坏安装、跨卷临时目录、中文空格路径、占用文件、注入失败后的文件与登记回滚、异常退出的持久恢复、重试保护，以及新安装器和新卸载器串行执行。它不等同于在干净虚拟机中运行原始旧安装包，也不代替全用户 UAC 安装、断电故障或所有杀毒软件环境验收。

具体产物哈希、测试结果和打包程序启动验收记录随本次本地构建保存。未经实际验证的能力不写入发布清单。
