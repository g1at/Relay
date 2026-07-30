# Relay 能否做成「Claude Code 桌面端 / Codex 桌面端」级别的应用？

> 分析日期：2026-06-22
> 对标参考：`ClaudeCodeCLI`(Claude Code CLI 源码)、`codex-rust-v0.141.0`(OpenAI Codex)、`hermes-agent-2026.6.5`(Nous Research)、`openclaw-2026.6.5`、`MiMo-Code-0.1.1`(小米,基于 opencode)
> 一句话结论:**能,而且 Relay 已经走在正确的赛道上**——但要达到「Codex / Claude Code 桌面端」那一档,核心要把「**每轮 spawn 一次 `claude` CLI**」的集成方式,升级成「**常驻 agent 服务 + 协议化前后端**」。技术栈不必换语言,Electron + TypeScript 完全够;真正的差距在**架构分层**和**会话/进程模型**,不在语言。

---

## 一、先把五个参照物的真实形态看清楚

不同项目代表了「桌面 AI agent」的不同架构档位。看清它们,才知道 Relay 该往哪一档走。

| 项目 | agent 核心语言 | 核心架构 | 桌面端形态 | 前后端如何通信 |
|---|---|---|---|---|
| **Claude Code CLI** | TypeScript(React Ink TUI) | 单体 CLI,但内含 `QueryEngine` / `server`(directConnect)/ `remote`(WebSocket session)/ SDK(`entrypoints/sdk`) | 官方桌面端/IDE 扩展是**独立前端**,通过 **Agent SDK + `stream-json`** 或 directConnect server 接核心 | stdio `stream-json`(JSON-RPC 式)/ 本地 server / 远程 WS |
| **Codex** | **Rust**(`codex-rs` 工作区,~80 个 crate) | `core` agent + **`app-server` 守护进程**(JSON-RPC 2.0,stdio / ws / unix-socket 三种 transport) | `codex app` 桌面体验 + VS Code 扩展,都是**薄前端**接 `app-server` | **JSON-RPC over stdio/ws/unix**;官方还提供 TS / Python SDK |
| **MiMo Code**(小米) | TypeScript(基于 `opencode`) | `@mimo-ai/app` = **HTTP 服务**(带 `openapi.json` + SDK);agent 逻辑在 server 里 | **Electron**(`electron-vite` + `electron-builder`),renderer 接本地 server | Electron 主进程 **spawn 本地 server sidecar**(`spawnLocalServer`),renderer 走 HTTP / 本地端口 |
| **Hermes** | Python(gateway 守护进程) | 常驻 **Gateway** + SQLite 持久化 + cron + 多渠道(Telegram/Slack/…) | **Electron**(`apps/desktop`,Vite + React),探测/连接 gateway | desktop 主进程探测并连接 gateway 的 **WebSocket** |
| **OpenClaw** | TypeScript(monorepo,`agent-core`/`gateway-client`/`gateway-protocol` 分包) | 常驻 **Gateway**(控制面)+ 多渠道;agent 核心独立成包 | 原生:macOS/iOS = **Swift**,Android = Kotlin;Windows Hub companion | `gateway-protocol` 定义协议,`gateway-client` 连接 |

**三条可总结的规律:**

1. **凡是「桌面端 / IDE / 多渠道」做得好的,agent 核心都被抽成了「可被多个前端复用的服务或 SDK」**,而不是绑死在某个 UI 进程里。Codex 的 `app-server`、MiMo 的 `@mimo-ai/app` HTTP server、Hermes/OpenClaw 的 Gateway 都是同一个思想:**核心是 headless 的、长驻的、协议化的;UI 只是众多客户端之一。**
2. **语言不是门槛。** 五个里有 3 个 agent 核心是 TypeScript(Claude Code、MiMo、OpenClaw),1 个 Python(Hermes),只有 Codex 用 Rust。**桌面壳几乎都是 Electron**(MiMo、Hermes 明确 Electron;Codex/OpenClaw 才上原生)。所以「要不要换 Rust / Swift」这个问题的答案是:**短期完全不需要**。
3. **通信都收敛到一套显式协议**:JSON-RPC(Codex)、OpenAPI/HTTP(MiMo)、WebSocket(Hermes/Claude remote)、自定义 protocol 包(OpenClaw)。**没有人是「每轮重新拉起一个 CLI 进程、靠 stdout 行解析」的**——而这恰恰是 Relay 现在的做法。

---

## 二、Relay 现状的精确画像

> 基于源码实读(`main.js` 3807 行、`preload.js` 201 行、`scheduler.js` 869 行、`renderer/app.js` 5416 行、`renderer/styles.css` 2672 行)。

**架构(三层 Electron):**

- **主进程 `main.js`**:窗口/托盘/IPC 中枢。核心执行函数 `runClaudeJob()` —— 每次对话 **`spawn(CLAUDE_EXE, ['-p', prompt, '--output-format','stream-json','--verbose','--include-partial-messages','--setting-sources','user', …])`**,逐行解析 stdout 的 JSON 事件,经 `onEvent` 回调发给渲染层或调度器。
- **预加载 `preload.js`**:`contextBridge` 暴露 ~40 个 IPC 通道(`claude:run`/`claude:abort`/`history:*`/`image:*`/`mcp:*`/`pm:*`/`stats:*`…)。
- **渲染层 `renderer/app.js`**:单文件 5400 行,纯 `<script>`(无打包器)、手写 DOM、`marked` 渲染 markdown。会话历史、协奏群聊、用量统计、图片创作都在这里。

**它已经做对的事(底子很好):**

- ✅ 完整的会话历史持久化 + 搜索 + 置顶
- ✅ `--resume` 维持多轮上下文;跨模型档位自动开新线程(避免 thinking 签名失效)
- ✅ 模型档位(快速/思考/专家)映射到 settings.json
- ✅ 内置 cron MCP server,支持「对话内管理定时任务」+ 独立 `scheduler.js` 调度器
- ✅ 多 Agent 协奏(单进程 PM + 原生 subagent 委派)
- ✅ 图片生成、MCP 管理、记忆库、托盘/mini 窗、首次安装向导、日志系统
- ✅ 自带 NSIS 打包、版本化 release notes

**它的架构性短板(决定上限的地方):**

| # | 短板 | 后果 | 参照物怎么做的 |
|---|---|---|---|
| 1 | **每轮 spawn 一次 CLI** | 进程启动开销(headless 每轮新进程,飞书 stdio MCP 要 ~5s 冷启);无法持有长驻会话状态;并发受 `MAX_PARALLEL_JOBS` 限 | MiMo/Codex/Hermes 都是**一个长驻 agent 服务**,会话是服务内的对象 |
| 2 | **靠 stdout 行解析 stream-json** | 协议是「单向事件流」,缺**双向控制**(权限审批、AskUserQuestion、中途改方向都得绕开/禁用) | Codex `app-server` 是**双向 JSON-RPC**,审批/问询是协议一等公民 |
| 3 | **渲染层 5400 行单文件、无打包、手写 DOM** | 难维护、难测试、难做复杂交互(diff 视图、终端、文件树);样式 2672 行 CSS 易冲突 | MiMo/Hermes 用 **Vite + 组件框架**;Claude Code 用 React |
| 4 | **UI 与核心绑死在 Electron 进程** | 无法复用核心做 IDE 扩展 / CLI / 远程;桌面端就是唯一前端 | 核心是**协议化服务**,前端可多个 |
| 5 | **绕过了 CLI 的交互能力** | `--disallowed-tools AskUserQuestion`、`bypassPermissions` —— 把权限审批、用户追问这些**桌面端最该做好的交互**给禁掉了 | Codex/Claude SDK 把权限审批做成**可视化弹窗 + 协议回传** |

**结论:Relay ≈「Electron 壳 + CLI 包装器」,处于架构最初级的一档。** 它能用、功能甚至比某些对标项目还全(协奏、图片、记忆),但**集成方式是最原始的**,这就是它和「Codex / Claude Code 桌面端」之间的真实差距——不是功能差距,是**架构层级**差距。

---

## 三、Relay 能不能做成同级应用?——能,分三档走

桌面化不是「重写」,是**沿着同一条路把集成方式逐级升级**。我把它拆成三个可独立交付的演进档(Tier),每一档都能单独发版、各有明确收益。

### Tier 1 —— 用「Agent SDK」替换「spawn CLI」(改集成方式,不动架构)

**这是性价比最高、风险最低的一步,也是和对标项目拉平的第一步。**

Claude Code 官方有 **Agent SDK**(`@anthropic-ai/claude-agent-sdk`,即 `ClaudeCodeCLI/entrypoints/sdk` 暴露的能力)。把 `runClaudeJob()` 里的 `spawn(claude -p …)` 换成 **SDK 的 `query()` 流式 API**:

```js
// 现在(每轮拉起一个进程,解析 stdout)
const child = spawn(CLAUDE_EXE, ['-p', prompt, '--output-format','stream-json', …]);
child.stdout.on('data', parseJsonLines);

// Tier 1(进程内调用 SDK,拿到结构化异步事件流)
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const msg of query({ prompt, options: { resume: sessionId, model, … } })) {
  onEvent(msg);   // msg 已是结构化对象,无需手工 JSON.parse 行
}
```

**收益:**
- 去掉每轮进程冷启;会话可常驻;
- 拿到**双向能力**:`canUseTool` 回调 = 权限审批可做成可视化弹窗;`AskUserQuestion` 不必再禁用,可弹原生选择框(直接补上 Relay 现在缺的交互);
- 结构化消息,不用再靠正则识别 `[调用工具: X]` 这类字符串;
- 多会话天然并发(SDK 是对象,不抢 `MAX_PARALLEL_JOBS`)。

**代价:** 主进程从「spawn 子进程」变成「依赖 SDK 包」;需处理 SDK 与现有 settings.json/网关(mify/ppio 中转)的兼容。`scheduler.js` 同样切到 SDK。

> 📌 **这一档做完,Relay 在「集成深度」上就追平了 MiMo/Hermes 的水平**——核心从 CLI 包装器变成了 SDK 宿主。

### Tier 2 —— 把核心抽成「常驻本地 Agent 服务」(MiMo / Codex app-server 模式)

在 Tier 1 基础上,把「SDK 调用 + 会话管理 + 历史/记忆/cron」从 Electron 主进程里**剥离成一个独立的本地服务进程**(Node 写,`spawnLocalServer` sidecar 模式,完全照搬 MiMo 的做法),对外暴露**本地 HTTP + WebSocket / JSON-RPC** 接口。

```
┌─────────────────┐         WS / HTTP / JSON-RPC        ┌──────────────────────┐
│  Electron 前端   │ ◄─────────────────────────────────► │  Relay Agent Server   │
│ (renderer 重构)  │   sessions / events / approvals      │ (常驻 Node sidecar)   │
└─────────────────┘                                      │  - Agent SDK 宿主      │
        ▲                                                 │  - 会话/历史/记忆      │
        │ 也可被其它前端复用                                │  - cron 调度器         │
        ├── CLI 客户端                                     │  - MCP 管理            │
        ├── IDE 扩展                                       └──────────────────────┘
        └── 远程/手机(可选)
```

**收益:**
- **前后端解耦**:UI 崩溃不影响 agent;agent 重启不丢会话;
- **核心可复用**:同一个服务可被桌面端、未来的 CLI、IDE 扩展、甚至远程手机端连接(这正是 Codex `app-server` 三 transport、Hermes/OpenClaw Gateway 的价值);
- **真正的多会话/后台任务**:cron 任务、长任务在服务里跑,前端随时连/断;
- 协议化后,**桌面端可以「连本地服务」也可以「连远程服务」**——OpenClaw/Hermes「不绑在你的笔记本上」的能力就来自这里。

**代价:** 需要设计一套协议(可直接借鉴 Codex `app-server` 的 JSON-RPC schema,或 MiMo 的 OpenAPI);本地服务的生命周期/端口/鉴权(MiMo 用 password)要处理好。Relay 现有的 cron-mcp-server 已经是个独立 server 雏形,迁移有基础。

### Tier 3 —— 前端工程化重构 + 桌面端体验补齐

把 `renderer/app.js`(5400 行裸 `<script>`)迁到 **Vite + 组件框架**(React 或 Svelte;Hermes/MiMo 都用 Vite),按功能拆组件(会话、协奏群聊、图片、用量、设置、思考卡)。在此之上补桌面端该有的体验:

- 权限审批弹窗、AskUserQuestion 原生选择(Tier 1 已打开协议口子)
- 代码 diff 视图 / 文件树 / 内嵌终端(`node-pty`,MiMo 已用)
- 流式渲染优化、虚拟滚动(长会话)
- 自动更新(`electron-updater`,MiMo/Hermes 都用)、崩溃上报

**代价:** 工作量最大,但可**增量迁移**(新功能用组件写,旧页面逐步替换),不必一次性重写。

---

## 四、语言与技术栈:到底要不要换?

**明确建议:不换语言,继续 TypeScript + Electron。** 理由:

1. **对标项目里 Electron 是主流**:MiMo(小米,和你同档定位)、Hermes 都是 Electron。Electron 不是「低级」选项,是「能最快做出完整桌面体验」的选项。
2. **Claude Code 核心本身就是 TS**,Agent SDK 是 TS/Python——**用 TS 接它阻抗最小**,换 Rust 反而要跨语言桥接,得不偿失。
3. **Rust(Codex 路线)只在两种情况下值得**:① 要做到 Codex 那种「单二进制、极低内存、原生分发」;② 要自己实现 agent 核心(sandbox、execpolicy、apply-patch 都是 Rust 写的重活)。Relay 是**复用 Claude 核心**,不自研 agent,所以 **Rust 的收益用不上**。
4. **原生(Swift/Kotlin,OpenClaw 路线)只在要做 iOS/Android/极致 macOS 原生时才需要**——那是更后面的事。

**唯一值得引入的新技术,是前端框架和构建工具**(Vite + React/Svelte),用来解决 5400 行单文件的可维护性,这在 Tier 3。

**推荐最终技术栈:**

| 层 | 选型 | 对标依据 |
|---|---|---|
| 桌面壳 | Electron + `electron-vite` + `electron-builder` + `electron-updater` | MiMo Code 同款 |
| Agent 核心接入 | `@anthropic-ai/claude-agent-sdk`(替换 spawn CLI) | Claude Code SDK |
| 本地服务 | Node 长驻 sidecar,HTTP + WS/JSON-RPC | MiMo `spawnLocalServer` / Codex `app-server` |
| 协议 | JSON-RPC 2.0(借鉴 Codex app-server schema) | Codex |
| 前端 | Vite + React(或 Svelte)+ 组件化 | Hermes / MiMo |
| 本地存储 | SQLite(`drizzle-orm` 或 better-sqlite3)替代当前 JSON 文件 | MiMo |
| 终端/diff | `node-pty` + Monaco/CodeMirror | MiMo |

---

## 五、落地路线图(建议顺序)

1. **【Tier 1,2–3 周】SDK 化** —— 把 `runClaudeJob` 从 spawn CLI 换成 Agent SDK `query()`;先在普通对话跑通,再切协奏和 scheduler。**立刻拿到**:权限审批弹窗、AskUserQuestion 原生化、去进程冷启。**风险最低,收益最直接,先做这个。**
2. **【Tier 2,1–2 月】服务化** —— 抽出本地 Agent Server sidecar,定义 JSON-RPC 协议,前端改连服务。会话/历史/cron 搬进服务。**拿到**:前后端解耦、核心可复用、为远程/多端铺路。
3. **【Tier 3,持续】前端工程化** —— Vite + 组件化增量迁移;补 diff/终端/文件树/自动更新。**拿到**:可维护性 + 桌面端体验对齐。
4.(可选,远期)做 IDE 扩展 / CLI 客户端 / 远程端 —— 一旦 Tier 2 的协议稳定,这些都是「再写一个客户端」而已,不动核心。

---

## 六、一句话回答你的问题

- **能做成 Codex / Claude Code 桌面端那一档吗?** 能。差距不在功能(Relay 的协奏、记忆、图片、cron 甚至更全),也不在语言,而在**架构层级**:Relay 现在是「CLI 包装器」,对标项目是「协议化的常驻 agent 服务 + 薄前端」。
- **怎么做?** 不重写、不换语言。沿 **SDK 化 → 服务化 → 前端工程化** 三档逐级演进,每档可独立发版。第一档(用 Agent SDK 替换 spawn CLI)就能让 Relay 在集成深度上追平 MiMo/Hermes,且 2–3 周可达。
- **用什么语言?** TypeScript + Electron 继续用,这是对标项目(尤其小米 MiMo)验证过的主流路线;Rust/Swift 在你「复用 Claude 核心而非自研 agent」的定位下用不上。
