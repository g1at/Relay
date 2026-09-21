# Third-party notices

核对日期：2026-09-21。适用于此源码中的依赖版本与资源；发布其他版本时应重新核对。

根目录 [LICENSE](LICENSE) 的 Apache-2.0 适用于 Relay 原创源码。第三方代码、字体、平台运行时和安装器组件保留各自条款；本文件不扩大这些条款授予的权利，也不表示第三方为 Relay 背书。源码可用不代表整个安装包的所有组成部分都采用同一个开源许可证。

## 随源码保存的浏览器组件

| 组件 | 当前版本 / 文件 | 许可及保留文本 |
| --- | --- | --- |
| highlight.js | 11.11.1；`renderer/vendor/highlight.min.js` | BSD-3-Clause；[完整许可](renderer/vendor/highlight-LICENSE) |
| GitHub Dark theme | `renderer/vendor/github-dark.min.css`；保留 GitHub / Hirse 头部归属 | 随 highlight.js 分发；[完整许可](renderer/vendor/highlight-LICENSE) |
| Marked | 18.0.4；`renderer/vendor/marked.umd.js` | MIT；[完整上游 LICENSE](renderer/vendor/marked-LICENSE) 同时保留 Markdown / John Gruber 的 BSD 通知 |
| xterm.js | 6.0.0；`renderer/vendor/xterm.js`、`xterm.css` | MIT；[完整许可](renderer/vendor/xterm-LICENSE) |
| xterm addon-fit | 0.11.0；`renderer/vendor/xterm-addon-fit.js` | MIT；[完整许可](renderer/vendor/xterm-addon-fit-LICENSE) |

上游：[highlight.js 11.11.1](https://github.com/highlightjs/highlight.js/tree/11.11.1)、[Marked 18.0.4](https://github.com/markedjs/marked/tree/v18.0.4)、[xterm.js](https://github.com/xtermjs/xterm.js)。版本来自资源头部及锁定的 npm 包；完整许可是上游文本，不能用本表代替。

## MiSans 字体

Relay 使用 MiSans 和 MiSans Latin。`renderer/fonts/Normal/` 与 `renderer/fonts/Latin/` 共 202 个 WOFF2 文件；当前文件合计 4,178,852 bytes。字体名称表保留 `Copyright © 2020-2023 Beijing Xiaomi Mobile Software Co.,Ltd. All Rights Reserved.`，Latin 文件还标识 Hanyi Fonts。Normal 样本版本为 4.003，Latin 样本为 4.002。

字体适用小米的 [MiSans 字体知识产权许可协议原始 PDF](licenses/MiSans-LICENSE.pdf)，官方来源为 [小米下载服务](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)。该协议要求注明使用字体、保留版权及协议，限制改编或二次开发、单独分发字体，并另行规定使用字体创作的应用等作品的分发。不能把它概括为 Apache、OFL 或无条件再分发许可。

现有资源的来源记录指向第三方 [`misans` 4.1.0](https://www.npmjs.com/package/misans/v/4.1.0)，并非小米直接发布的 npm 包。[上游项目](https://github.com/dsrkafuu/misans) 区分字体许可与脚本的 Apache-2.0 许可；其字体许可不会被脚本许可替代。

**待确认的范围：**官方协议未明确列出格式转换或子集切分的豁免；当前 Normal 文件是第三方 Web 子集，现有记录未包含针对该处理的额外授权。这是尚未闭合的来源及授权证据，不能直接据此判定侵权，也不能把补充协议文件视为已取得授权。重新分发字体前应核实适用授权，或评估使用官方未修改字体 / 其他合适授权字体。此次仅补充许可和归属，没有修改、替换或删除现有字体。

## npm 与平台运行时

以下是直接依赖的锁定版本。间接依赖的版本、来源与声明见 `package-lock.json`；安装后的包内 `LICENSE`、`COPYING`、`NOTICE` 等文件仍须保留。本表不是所有间接依赖的统一授权。

| 组件 | 锁定版本 | 包声明的许可 / 说明 |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.266 | `SEE LICENSE IN README.md`；Anthropic 独立条款，见下一节 |
| `@anthropic-ai/claude-agent-sdk-win32-x64` | 0.3.266 | 原生运行时；Anthropic 独立条款 |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | 0.3.266 | WSL 原生运行时；Anthropic 独立条款 |
| `@anthropic-ai/sdk` | 0.115.0 | MIT；这是不同于 Agent SDK 的 API client 包 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `electron-updater` | 6.8.9 | MIT |
| `node-pty` | 1.1.0 | MIT；保留 `deps/winpty/LICENSE` 与相关子组件通知 |
| `zod` | 4.4.3 | MIT |
| `js-yaml` | 4.1.1 | MIT |
| Electron | 32.3.3 | MIT；Chromium、Node.js 及其他内含组件各有许可 |
| `@xterm/xterm` / `@xterm/addon-fit` | 6.0.0 / 0.11.0 | MIT；其浏览器构建随应用分发 |
| electron-builder | 25.1.8 | MIT；构建工具的许可不替代它取得的安装器插件许可 |
| tar | 7.5.22 | BlueOak-1.0.0；构建工具依赖 |

Electron 发布目录中的 `LICENSE` 和 `LICENSES.chromium.html` 应与 Electron 一起保留。Relay 的许可位于应用资源中的 `legal/LICENSE`，不会覆盖 Electron 的根目录许可。现有生产依赖的包内许可继续按原打包规则保留。

### Claude Agent SDK 与 Claude Code 平台包

本仓库保存 0.3.266 的 [SDK 原始 LICENSE](licenses/anthropic/claude-agent-sdk-LICENSE.md)、[SDK 原始 README](licenses/anthropic/claude-agent-sdk-README.md)、[Windows 包 LICENSE](licenses/anthropic/claude-agent-sdk-win32-x64-LICENSE.md) 和 [Linux 包 LICENSE](licenses/anthropic/claude-agent-sdk-linux-x64-LICENSE.md)。这些包声明 Anthropic 保留所有权利，并指向其法律条款，不包含 MIT / Apache-2.0 的通用授权。

[SDK 官方文档](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms) 明确 SDK 受 [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) 约束，具有独立许可的具体组件除外。[Claude Code 法律说明](https://code.claude.com/docs/en/legal-and-compliance) 对产品预装、未修改二进制、内置鉴权方式、凭据和计费等另有条件。使用或分发者应按其实际集成和凭据模式核对条款；Relay 的 Apache 许可不能代为授予服务访问权、转售权或商标权。本次许可补全不是对所有第三方服务商或网关用法的授权判断。

SDK 的 README 可能被 electron-builder 的默认生产依赖过滤排除，因此这里另存原始副本并显式打包；平台包原有许可也继续保留。

## 原生组件和 Windows 安装器

### Relay 自有桥接代码

- `build/installer-skin/relay-installer-skin.c` / `.dll`：Relay 自有界面代码；构建脚本使用 Clang 和 MinGW-w64 头文件，无 CRT，manifest 记录系统 DLL 导入。它不是一份未知来源的第三方皮肤 DLL。
- `build/taskbar-overlay-win.cc` / `renderer/taskbar-badges/native/win32-x64.node`：Relay 自有桥接代码，构建命令使用 MinGW-w64 g++、C++ 标准库和 `-static`；静态运行库的通知不能因源文件属于 Relay 而省略。

保留的相关文本：[MinGW-w64 runtime](licenses/native/MinGW-w64-runtime.txt)、[winpthreads](licenses/native/winpthreads-COPYING.txt)、[GPL-3.0](licenses/native/GCC-GPL-3.0.txt)、[GCC Runtime Library Exception 3.1](licenses/native/GCC-Runtime-Library-Exception-3.1.txt)。[GCC 官方说明](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html) 将运行库例外与 GPL 区分；是否适用取决于组件和构建方式，不是把所有 GCC 相关代码重新许可为 Apache。

### NSIS 与第三方插件

当前 electron-builder 工具链包含 NSIS 3.0.4.1 和 nsis-resources 3.4.1；安装模板会使用第三方插件。它们不是全都由 Electron 的 MIT 许可覆盖。

- [NSIS 原始 COPYING](licenses/native/NSIS-COPYING.txt) 保留 zlib/libpng、bzip2、CPL-1.0 和 LZMA 例外等原文；参见 [NSIS 官方许可说明](https://nsis.sourceforge.io/License)。
- StdUtils：LGPL-2.1-or-later。保留作者的 [版权说明](licenses/native/StdUtils-ReadMe.txt)、[完整 LGPL](licenses/native/StdUtils-LGPL.txt) 和 [针对未修改插件 DLL 的安装器澄清](licenses/native/StdUtils-LGPL_CLARIFICATION.txt)；源码来源为 [lordmulder/stdutils](https://github.com/lordmulder/stdutils)。该澄清不免除插件自身的许可义务。
- [UAC 插件](https://nsis.sourceforge.io/UAC_plug-in)：官方条目标为 zlib；[WinShell](https://nsis.sourceforge.io/WinShell_plug-in) 官方条目仅标为 Freeware；[nsProcess](https://nsis.sourceforge.io/NsProcess_plugin) 条目提供作者和源码下载。这些条目不能被解释为统一的 Apache 授权。

**二进制发布前仍需核对：**缓存中的插件包未提供每个第三方 DLL 的完整许可和可核对的对应源码版本，尤其是 WinShell、nsProcess 及 StdUtils 的精确二进制来源。这里补齐能够核实的通知，不把此源码清单当作最终安装器的完整法律验收。重新构建或发布时，应对实际嵌入插件逐项保留适用通知，并满足适用的源码提供要求；不要仅依赖最新上游主页替代精确版本证据。

## 打包与更新本清单

`package.json` 显式保留根 LICENSE、NOTICE、本文件和 `licenses/`，并将它们及浏览器组件许可复制到安装后的 `resources/legal/`，便于直接查看。文件的来源和校验值见 [licenses/provenance.json](licenses/provenance.json)。没有修改任何第三方许可证原文。

依赖、字体或原生二进制变化时，应更新对应文本、版本和来源记录，再检查最终 EXE 与解包后的资源。此轮完成的是源码归属、许可文件保留与打包规则核对；没有以此替代真实发布包检查或权利人的额外授权。
