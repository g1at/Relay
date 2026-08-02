// claude-sdk.js — Relay 与 @anthropic-ai/claude-agent-sdk 的唯一接触面
//
// 为什么要有这一层：
//   历史上 Relay 直接 spawn 用户机器上的 claude.exe，再手工按行 JSON.parse stdout。
//   那套代码要处理「找不到 exe / exe 损坏 / npm shim 解析 / 中文经 GBK 二次转码」等一堆
//   与业务无关的杂事。改用官方 SDK 后这些统统消失 —— SDK 自带平台专属的 claude.exe
//   （@anthropic-ai/claude-agent-sdk-win32-x64），不再依赖用户是否装过 Claude Code。
//
// 关键设计：事件契约保持不变
//   实测确认 SDK 吐出的消息结构与 CLI 的 stream-json 逐字段一致
//   （type:'system' + subtype:'task_started' + task_id/tool_use_id …），
//   所以这里【原样】把消息交给调用方的 onEvent，main.js 与 renderer 的事件处理一行不用改。
//   这是让这次迁移可控的前提，别在这一层做「翻译」或「归一化」，那会引入不必要的偏差。
//
// 为什么自己接管 spawn（spawnClaudeCodeProcess）：
//   常驻会话的 MCP watchdog 需要 claude 进程的 pid 去枚举它的直接子进程（见 main.js
//   snapshotMcpChildren 的三个坑）。SDK 默认自己 spawn、不暴露 pid，所以这里提供自定义
//   spawn 把真实 ChildProcess 截下来。ChildProcess 天然满足 SDK 的 SpawnedProcess 接口。
//
// ESM/CJS：SDK 是 ESM-only，Relay 主进程是 CommonJS —— 实测动态 import() 即可，
//   不必把 main.js 改造成 ESM。加载结果缓存，避免每轮重复解析 1.2MB 的 sdk.mjs。

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

let sdkPromise = null;

// 懒加载 + 缓存。第一次调用会解析 sdk.mjs（~1.2MB），之后直接命中缓存。
function loadSdk() {
  if (!sdkPromise) {
    const entry = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
    sdkPromise = import(pathToFileURL(entry).href).catch((e) => {
      sdkPromise = null;   // 失败不缓存，下次还能重试
      throw new Error(`claude-agent-sdk 加载失败：${e.message}`);
    });
  }
  return sdkPromise;
}

// 自带运行时的绝对路径。
//   三个坑叠在一起，必须小心处理，不能写死一条路径：
//   ① 位置不同：开发环境 npm 会把平台包提升到顶层 node_modules；electron-builder 打包后
//      它却嵌在 claude-agent-sdk/node_modules/ 里（实测打包产物如此）。
//   ② asar：253MB 的 exe 不能进 asar（进了就无法 spawn），package.json 里用 asarUnpack
//      把它排出去，真实文件落在 app.asar.unpacked 下。
//   ③ ⚠️ Electron 给 fs 打了补丁，**asar 内的路径 existsSync 也返回 true**。所以绝不能把
//      asar 路径本身当候选去 existsSync —— 它会「存在」但 spawn 必失败，而且 SDK 报的错是
//      「binary exists but failed to launch ... libc 不匹配」，完全指错方向（实测踩过）。
//      因此：路径一旦落在 app.asar 内，就【只】保留 .unpacked 变体，不保留原路径。
//   返回第一个真实存在的候选；全都不存在时返回 null，交由 SDK 用它自己的解析逻辑兜底。
const RUNTIME_PKG = `claude-agent-sdk-${process.platform}-${process.arch}`;
const RUNTIME_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';
let cachedExecutable;

function bundledExecutable() {
  if (cachedExecutable !== undefined) return cachedExecutable;
  const rels = [
    // 开发环境：npm 提升到顶层
    path.join('node_modules', '@anthropic-ai', RUNTIME_PKG, RUNTIME_BIN),
    // 打包产物：嵌在 SDK 自己的 node_modules 下
    path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', RUNTIME_PKG, RUNTIME_BIN),
  ];
  const candidates = rels.map((rel) => {
    const p = path.join(__dirname, rel);
    // 坑③：asar 内的路径不可执行，直接换成 unpacked，不保留原路径
    return p.includes(`app.asar${path.sep}`)
      ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      : p;
  });
  cachedExecutable = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
  if (!cachedExecutable) {
    console.warn('[sdk] 未找到内置运行时，已尝试：\n  %s', candidates.join('\n  '));
  }
  return cachedExecutable;
}

// 把 Relay 的调用参数翻译成 SDK Options。一次性与常驻共用，保证两条路行为一致
// （这正是原来 buildClaudeArgs 的职责）。
function buildOptions({
  cwd, validWorkingDir, agentProjectRoot, model, sessionId,
  permissionMode, mcpServers, mcpServersFactory, appendSystemPrompt, memoryDir, onSpawn, abortController,
}, sdk) {
  const additionalDirectories = [];
  if (memoryDir) additionalDirectories.push(memoryDir);
  if (validWorkingDir) additionalDirectories.push(validWorkingDir);
  // Agent 项目根不在 cwd 链上时单独授权（避免与 validWorkingDir 重复）
  if (agentProjectRoot && path.resolve(agentProjectRoot) !== path.resolve(validWorkingDir || '')) {
    additionalDirectories.push(agentProjectRoot);
  }

  const options = {
    cwd,
    additionalDirectories,
    // headless 下 AskUserQuestion 必被拒，禁用它并靠 prompt 引导模型把选项列出来
    disallowedTools: ['AskUserQuestion'],
    // 关键：headless 默认不加载 user scope 配置源（API key / 模型映射 / 用户的 MCP），显式声明
    settingSources: ['user'],
    permissionMode: permissionMode || 'bypassPermissions',
    includePartialMessages: true,   // 打字机效果所需的 stream_event
    pathToClaudeCodeExecutable: bundledExecutable(),
  };
  // 模型档位 haiku/sonnet/opus → settings.json 的 ANTHROPIC_DEFAULT_*_MODEL 映射
  if (['haiku', 'sonnet', 'opus'].includes(model)) options.model = model;
  if (sessionId) options.resume = sessionId;
  // MCP 有两种给法：
  //   · mcpServers        —— 现成的配置对象（如 stdio 型的外部 server）
  //   · mcpServersFactory —— 需要 SDK 本身才能构造的（进程内 server 要用 createSdkMcpServer/tool），
  //     所以延迟到这里、拿到已加载的 sdk 再造。这样 claude-sdk.js 不必知道具体是哪个业务 server。
  const factored = typeof mcpServersFactory === 'function' && sdk ? mcpServersFactory(sdk) : null;
  const allMcp = { ...(mcpServers || {}), ...(factored || {}) };
  if (Object.keys(allMcp).length) options.mcpServers = allMcp;
  if (appendSystemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: appendSystemPrompt };
  if (abortController) options.abortController = abortController;

  // 自定义 spawn：把真实 ChildProcess 截下来交给调用方（常驻会话的 MCP watchdog 要 pid）。
  // ChildProcess 已满足 SDK 的 SpawnedProcess 接口，直接返回即可。
  if (onSpawn) {
    options.spawnClaudeCodeProcess = (spawnOpts) => {
      const child = spawn(spawnOpts.command, spawnOpts.args, {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        signal: spawnOpts.signal,
        shell: false,        // 不走 cmd —— 避免中文 prompt 经 GBK 二次转码乱码
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      try { onSpawn(child); } catch (_) {}
      return child;
    };
  }
  return options;
}

// ── 一次性执行 ──
// 对应原来的 runClaudeJob：跑完即结束，用于定时任务与无 convId 的兼容回退。
// 返回 { handle }，handle 鸭子类型兼容原来的 ChildProcess（jobs map 与 claude:abort 都只用
// 到 .pid / .kill()），所以上层的中止逻辑不用改。
function runOneShot({ prompt, onEvent, ...rest }) {
  const abortController = new AbortController();
  let child = null;
  const emit = (evt) => { try { onEvent(evt); } catch (e) { console.error('[sdk] emit 失败: %s type=%s', e.message, evt && evt.type); } };

  const handle = {
    get pid() { return child ? child.pid : null; },
    kill() { try { abortController.abort(); } catch (_) {} return true; },
  };

  (async () => {
    let exitCode = 0;
    try {
      const sdk = await loadSdk();
      const options = buildOptions({ ...rest, abortController, onSpawn: (c) => { child = c; } }, sdk);
      for await (const msg of sdk.query({ prompt, options })) emit(msg);
    } catch (e) {
      if (!abortController.signal.aborted) {
        console.error('[sdk] 一次性任务出错: %s', e && e.message);
        emit({ type: 'stderr', text: String((e && e.message) || e) });
        exitCode = -1;
      }
    } finally {
      // 显式收尾：result 事件可能因异常退出而缺失，前端只认 job-done
      emit({ type: 'job-done', exitCode: abortController.signal.aborted ? -1 : exitCode });
    }
  })();

  return { handle };
}

// ── 常驻会话 ──
// 对应原来的 spawnLiveSession：一个进程服务多轮，避免每轮重连 MCP。
// SDK 的流式输入要一个 AsyncIterable，这里用一个「推送队列」把它转成命令式的 push(text)。
function createLiveSession({ onMessage, onExit, ...rest }) {
  const abortController = new AbortController();
  let child = null;
  let closed = false;
  const queue = [];              // 已入队待消费的用户消息
  let waiter = null;             // 消费者在等下一条时挂在这里

  async function* inputStream() {
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (closed) return;
      await new Promise((resolve) => { waiter = resolve; });
    }
  }
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  const session = {
    get pid() { return child ? child.pid : null; },
    // 投递一轮用户输入。SDK 侧会把它作为 user 消息喂给常驻进程。
    push(text) {
      if (closed) return false;
      queue.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      });
      wake();
      return true;
    },
    // 中止/回收。先关输入让 SDK 走优雅退出（stdin EOF + ~2s 宽限），再 abort 兜底。
    kill() {
      if (closed) return;
      closed = true;
      wake();
      try { abortController.abort(); } catch (_) {}
    },
  };

  (async () => {
    let exitCode = 0;
    let error;
    try {
      const sdk = await loadSdk();
      const options = buildOptions({ ...rest, abortController, onSpawn: (c) => { child = c; } }, sdk);
      for await (const msg of sdk.query({ prompt: inputStream(), options })) {
        try { onMessage(msg); }
        catch (e) { console.error('[sdk] onMessage 失败: %s type=%s', e.message, msg && msg.type); }
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        error = String((e && e.message) || e);
        console.error('[sdk] 常驻会话出错: %s', error);
        exitCode = -1;
      }
    } finally {
      closed = true;
      try { onExit(exitCode, error); } catch (_) {}
    }
  })();

  return session;
}

// ── 一次性取纯文本 ──
// 给「只要一段文字结果」的轻量调用用（会话标题、技能中文元数据、技能 review）。
// 这些原来是 `claude -p <prompt>` 读 stdout 纯文本；SDK 只吐结构化消息，
// 所以这里把 assistant 的 text block 拼起来，拿不到就退回 result.result。
// 不挂 MCP、不授权额外目录 —— 它们本就不该触发工具或 Agent。
function runText({ prompt, cwd, model, timeoutMs = 30000, permissionMode = 'bypassPermissions', tools, additionalDirectories }) {
  return new Promise((resolve) => {
    const abortController = new AbortController();
    let text = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { abortController.abort(); } catch (_) {}
      finish(text.trim());
    }, timeoutMs);
    if (timer.unref) timer.unref();

    (async () => {
      try {
        const { query } = await loadSdk();
        const options = {
          cwd,
          settingSources: ['user'],
          permissionMode,
          abortController,
          disallowedTools: ['AskUserQuestion'],
          pathToClaudeCodeExecutable: bundledExecutable(),
        };
        // tools: [] 表示「只做文本生成，禁止调用任何工具」（原来的 `--tools ''`）
        if (Array.isArray(tools)) options.tools = tools;
        if (Array.isArray(additionalDirectories) && additionalDirectories.length) {
          options.additionalDirectories = additionalDirectories;
        }
        if (['haiku', 'sonnet', 'opus'].includes(model)) options.model = model;
        for await (const msg of query({ prompt, options })) {
          if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
            for (const b of msg.message.content) if (b && b.type === 'text') text += b.text;
          } else if (msg.type === 'result' && !text && typeof msg.result === 'string') {
            text = msg.result;
          }
        }
      } catch (e) {
        if (!abortController.signal.aborted) console.error('[sdk] runText 出错: %s', e && e.message);
      } finally {
        clearTimeout(timer);
        finish(text.trim());
      }
    })();
  });
}

// 内置运行时的版本。取自 SDK package.json 的 claudeCodeVersion 字段
// （SDK 0.3.220 ↔ CLI 2.1.220 同 commit 发布）。
function bundledClaudeVersion() {
  try {
    return require('@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion || '';
  } catch (_) {
    try {
      const p = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).claudeCodeVersion || '';
    } catch (_) { return ''; }
  }
}

module.exports = { loadSdk, runOneShot, runText, createLiveSession, bundledClaudeVersion, bundledExecutable };
