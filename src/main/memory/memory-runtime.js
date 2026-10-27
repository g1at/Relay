'use strict';
const path = require('node:path');
const { guardMemoryToolInput } = require('./memory-store');
const { MEMORY_TYPES, VALID_TYPES, MEMORY_TYPE_GUIDANCE } = require('./memory-schema');
const { createMemoryRetriever } = require('./memory-retrieval');
const READ_TOOLS = new Set(['mcp__relay-memory__list', 'mcp__relay-memory__read']);
const MEMORY_CONSOLIDATION_PROMPT = '整理当前作用域的 Relay 长期记忆。通过 relay-memory 的 list/read 工具核对条目；只对重复、过时或冲突内容提出精炼的替代候选，使用 propose，并携带刚读取的 revision。已确认内容在用户批准替代前保持有效；不得直接覆写、删除、移动记忆文件或修改 MEMORY.md。核心条目只报告问题。保留每条有效事实与来源，不把低读取次数当作无用。无需改动时简短说明，不制造候选。' + MEMORY_TYPE_GUIDANCE;

function isStaticPowerShellSourceSearch(name, command, { memoryDir, cwd }) {
  // A narrow exception for a literal search term, not a PowerShell parser or a
  // general shell allow-list. Script blocks, expansion, extra statements and
  // redirection keep the existing deny behavior, even inside quoted strings.
  if (name !== 'PowerShell' || command.length > 4096
      // PowerShell also treats curly quotation marks as string delimiters.
      || /[\u0000-\u001f\u007f\u0085\u2018-\u201f\u2028\u2029$`{};<>&]/.test(command)) return false;
  const match = command.match(/^\s*Select-String\s+-(?:LiteralPath|Path)\s+(?:'([^']+)'|"([^"]+)")\s+-Pattern\s+(?:'([^']*)'|"([^"]*)")(?:\s+-(?:AllMatches|SimpleMatch))?(?:\s*\|\s*Select-Object\s+-(?:First|Last)\s+([1-9]\d{0,2}|1000))?\s*$/i);
  if (!match) return false;
  const file = match[1] || match[2], pattern = match[3] ?? match[4];
  if (!/relay-(?:sdk-)?memory/i.test(pattern) || /[*?\[\]]/.test(file)) return false;
  const portable = file.replace(/\\/g, '/');
  // Only an absolute, single source file is covered. Reject providers, remote
  // shares, alternate streams, directory globs and the SDK's memory tree.
  const drive = /^[a-z]:\//i.test(portable);
  const windowsPaths = /^[a-z]:[\\/]|^\\\\/i.test(memoryDir);
  // Do not reinterpret a WSL spelling as a native PowerShell drive path (or
  // vice versa): the shell and the path guard must validate the same file.
  if (!(windowsPaths ? drive : /^\/(?!\/)/.test(portable))
      || (drive ? portable.slice(2) : portable).includes(':')
      || !/\.(?:js|cjs|mjs)$/i.test(file)
      || /(?:^|\/)\.claude\/(?:projects\/[^/]+\/)?memory(?:\/|$)/i.test(portable)) return false;
  // This is path validation only. The stricter write-path check also excludes
  // SDK memory resolved through aliases/symlinks, even though this search reads.
  return !guardMemoryToolInput('Write', { file_path: file }, { memoryDir, cwd });
}

function createMemoryRuntime({ store, context = () => ({}), onChanged = () => {}, onRead = () => {}, isCore = () => false, retriever = createMemoryRetriever({ store }) }) {
  const current = () => {
    const ctx = typeof context === 'function' ? context() : context;
    return { ...(ctx || {}), mode: ctx?.mode || 'read' };
  };
  const writeAllowed = ctx => ['full', 'maintenance', 'readwrite'].includes(ctx.mode) && !ctx.plan;
  const checked = () => {
    const ctx = current();
    if (ctx.mode === 'off') throw new Error('此任务未启用记忆。');
    return ctx;
  };
  function list({ query = '', limit = 30, offset = 0 } = {}) {
    return retriever.search(query, { context: checked(), limit, offset });
  }
  function read({ file } = {}) {
    const result = store.read(file, { actor: 'model', context: checked() });
    onRead(result.file);
    return result;
  }
  function propose({ file, content, type, expectedRevision } = {}) {
    const ctx = checked();
    if (!writeAllowed(ctx)) throw new Error('当前任务只允许读取记忆。');
    if (expectedRevision === undefined) throw new Error('必须提供 expectedRevision：新记忆传 null，已有记忆先读取 revision。');
    if (!VALID_TYPES.has(type)) throw new Error('必须明确选择记忆 type：user、feedback、project 或 reference。');
    if (ctx.mode === 'maintenance' && expectedRevision !== null) {
      const previous = store.read(file, { actor: 'model', context: ctx });
      if (previous.meta.core || isCore(file)) throw new Error('核心记忆只报告问题，由用户决定是否修改。');
    }
    const result = store.write(file, content, { actor: 'model', context: ctx, expectedRevision, memoryType: type,
      userConfirmed: ctx.userConfirmed === true && ctx.mode !== 'maintenance' });
    onChanged(result);
    return { ...result, message: result.meta.status === 'draft' ? '候选已保存，等待用户确认后生效。' : '已记住。' };
  }
  async function hook(input) {
    const ctx = current(), name = input?.tool_name || '';
    let message;
    if (name.startsWith('mcp__relay-memory__')) {
      if (ctx.mode === 'off') message = '此任务未启用记忆。';
      else if (!READ_TOOLS.has(name) && !writeAllowed(ctx)) message = '当前任务只允许读取记忆。';
    } else {
      const hookCwd = typeof input?.cwd === 'string' && (path.win32.isAbsolute(input.cwd) || path.posix.isAbsolute(input.cwd)) ? input.cwd : ctx.cwd;
      const denied = guardMemoryToolInput(name, input?.tool_input || {}, { memoryDir: store.dir, cwd: hookCwd });
      if (denied?.behavior === 'deny') message = denied.message;
      // This guards known paths, not arbitrary shell programs or OS file access.
      if (!message && /Bash|PowerShell|Shell|terminal|execute/i.test(name)) {
        const command = String(input?.tool_input?.command || input?.tool_input?.code || '');
        const normalized = command.replace(/\\/g, '/').toLowerCase();
        if (/relay-(?:sdk-)?memory/.test(normalized)
            && !isStaticPowerShellSourceSearch(name, command, { memoryDir: store.dir, cwd: hookCwd })) {
          message = '请通过 relay-memory 工具管理记忆，保留作用域、审核和可恢复记录。';
        }
      }
    }
    return message ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } } : {};
  }
  function factory(sdk) {
    const z = require('zod').z;
    const run = fn => async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(fn(args)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    };
    return { 'relay-memory': sdk.createSdkMcpServer({ name: 'relay-memory', version: '1.0.0', tools: [
      sdk.tool('list', '检索当前项目及全局已确认的 Relay 记忆，匹配标题、摘要和正文，返回相关片段；完整内容用 read 读取。空 query 列出可用记忆，可用 offset 按页继续，直到返回不足 limit 条。', { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, run(list)),
      sdk.tool('read', '读取一条已生效记忆及 revision；修改前必须先读取。', { file: z.string() }, run(read)),
      sdk.tool('propose', '保存记忆候选；对已有事实的更新必须携带读取的 revision，不能伪造用户确认或核心状态。' + MEMORY_TYPE_GUIDANCE, {
        file: z.string(), content: z.string().max(65536), type: z.enum(MEMORY_TYPES), expectedRevision: z.string().nullable()
      }, run(propose)),
    ] }) };
  }
  return { list, read, propose, hook, factory };
}
module.exports = { createMemoryRuntime, MEMORY_CONSOLIDATION_PROMPT, READ_TOOLS };
