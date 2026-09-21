# 参与 Relay 开发

欢迎提交可复现的问题、界面改进和代码修复。较大的行为调整请先用 Issue 说明使用场景、当前问题和预期结果；小修复可以直接提交 Pull Request。

安全问题请先阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 或 PR 中提交漏洞细节、密钥或未经处理的会话记录。

## 开发环境

当前开发与 CI 基线为 **Windows x64、Node.js 24、Python 3.11 和 Git**。项目使用 Electron、Claude Agent SDK 与 `node-pty`；Windows 的原生行为不能只用 WSL 中的 Node.js 测试代替。

CI 固定使用带 Visual Studio 2022 的 `windows-2022` runner。当前锁定构建链中的 `node-gyp` 9 能识别 VS 2022，尚不识别 VS 2026；因此不使用已切换编译器的 `windows-latest` / `windows-2025`。原生模块仍会完整重编译，目录构建仍会执行。

`node-pty` 优先使用预编译资源。如果安装时需要本地编译，请安装 Visual Studio 2022 Build Tools 的 C++ 桌面开发工具、Windows SDK，以及相应的 MSVC x64/x86 Spectre-mitigated libraries。Python 3.11 需要能被构建工具找到。

```powershell
git clone https://github.com/g1at/Relay.git
cd Relay
npm ci
npm start
```

开发版会启动实际应用。需要使用模型或外部 MCP 时，再自行配置对应服务；请用自己的测试项目和数据。下面的自动化检查不需要真实服务商密钥。

`docs/`、`design/`、`.codex-tmp/` 和独立的 `website/` 不属于公开源码依赖。缺少本地文档或设计母版时，相关比对会明确跳过，运行资源与业务逻辑测试仍会执行。不要为了让这些可选比对通过而上传私人材料。

## 验证修改

先运行与改动相关的测试，再执行完整单测。项目使用 Node.js 内置测试运行器：

```powershell
# 单个模块的示例
node --test --test-timeout=60000 test/assistant-output.test.js

# 完整单测
npm test

# 与 Windows CI 相同的限时、有限并发检查
node --test --test-timeout=60000 --test-concurrency=2 test/*.test.js

# 公开文档链接、截图完整性与许可元数据
node build/check-public-docs.cjs

# 真实 renderer + 隔离内存 API，不请求模型服务
npm run test:ui

# 预编译安装皮肤与源码哈希检查
npm run verify:installer-skin

# 本地目录构建，明确禁止发布
npm run build:dir -- --x64 --publish never
```

`test:ui` 使用 `.codex-tmp/ui-smoke/` 下的隔离配置和合成数据，并阻止页面的 HTTP(S) 请求。更多 UI 或原生模块检查见 `package.json` 中的 `test:*` 脚本；运行其他手动检查前先读脚本说明，确认是否需要特定环境。真实服务商、WSL、外部 MCP、安装升级与数据迁移，需要单独验收，不能从单测或模拟结果推断通过。

目录构建会准备锁定版本的 Linux SDK 运行时，用于打包中的 WSL 支持；首次准备可能访问官方 npm registry。安装依赖、下载 Electron 和构建工具也需要网络。运行这些检查不需要 `GH_TOKEN`、服务商 API Key 或发布权限。

## 修改范围与提交说明

- 一个 PR 尽量解决一个清晰的问题，避免混入无关格式化或文件搬迁。
- 修改任务、会话或工具状态时，补充能区分成功、失败、取消及迟到事件的回归；不要把模型或工具的中间状态当作最终成功。
- 涉及 Windows 路径、终端、托盘、窗口或安装流程时，记录真实 Windows 验证结果。仅做静态检查或合成测试时，请明确说明。
- UI 修改附脱敏截图，说明窗口尺寸、主题和操作路径。
- 依赖变更同步 `package.json` 与 `package-lock.json`。不要提交 `node_modules/`、`dist/`、本地配置、访问令牌或完整用户历史。
- 保持 `.gitattributes` 规定的换行。安装皮肤、vendor 资源等有字节哈希检查，随意转换换行也会改变校验结果。

PR 描述至少包含：问题或触发条件、修改后的行为、执行过的验证及剩余限制。未经执行的命令不要标为通过。

## 图标、原生资源与发布

默认运行和构建使用仓库内已提交的图标、安装皮肤和任务栏资源。手动重新生成图标需要本地设计母版；重新编译安装皮肤需要 LLVM / MinGW，见 [构建说明](build/installer-skin/README.md)。修改预编译资源时，需要同时保留其源码、构建步骤和验证记录。

普通贡献不需要创建 Release。`npm run release` 只准备和验证本地发布包；上传另有显式步骤，见 [发布流程](distribution/PUBLISHING.md)。CI 不执行发布，也不修改仓库可见性。

## 许可与第三方材料

提交前确认你有权贡献所提交的代码、图片、字体和测试数据。保留适用的版权与第三方许可说明；项目许可见 [LICENSE](LICENSE)，相关声明见 [NOTICE](NOTICE)。
