'use strict';
const path = require('node:path');
const { guardMemoryToolInput } = require('./memory-store');
const { MEMORY_TYPES, VALID_TYPES, VALID_STATUS, MEMORY_TYPE_GUIDANCE } = require('./memory-schema');
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

function createMemoryRuntime({ store, context = () => ({}), onChanged = () => {}, onRead = () => {}, isCore = () => false, retriever = createMemoryRetriever({ store }), logger = null }) {
  const current = () => {
    const ctx = typeof context === 'function' ? context() : context;
    return { ...(ctx || {}), mode: ctx?.mode || 'read' };
  };
  const writeAllowed = ctx => ['full', 'maintenance', 'readwrite'].includes(ctx.mode) && !ctx.plan;
  const checked = (ctx = current()) => {
    if (ctx.mode === 'off') throw Object.assign(new Error('此任务未启用记忆。'), { code: 'MEMORY_PERMISSION' });
    return ctx;
  };
  const diagnosticFile = value => typeof value === 'string' && value.length <= 240
    && /^[^<>:"/\\|?*\x00-\x1f]+\.md$/i.test(value) ? value : null;
  const diagnosticId = value => typeof value === 'string' && /^[\w:/.-]{1,256}$/.test(value) ? value : null;
  const diagnosticRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null;
  function diagnose(operation, phase, args, ctx, { result, error, elapsedMs, requestId } = {}) {
    if (!logger) return;
    try {
      const revision = args?.expectedRevision;
      const revisionKind = revision === undefined ? 'missing' : revision === null ? 'null'
        : revision === '' ? 'empty-string' : revision === 'null' ? 'string-null' : typeof revision;
      const record = { operation, phase, file: diagnosticFile(args?.file),
        sourceRef: diagnosticId(ctx.sourceRef), conversationId: diagnosticId(ctx.conversationId),
        runId: diagnosticId(ctx.runId), projectId: diagnosticId(ctx.projectId),
        mode: ['off', 'read', 'full', 'maintenance', 'readwrite'].includes(ctx.mode) ? ctx.mode : null,
        ...(operation === 'propose' ? { expectedRevisionKind: revisionKind,
          expectedRevision: diagnosticRevision(revision),
          ...(revision === 'null' ? { normalizedExpectedRevisionKind: 'null', revisionCompatibility: 'string-null' } : {}),
          memoryType: VALID_TYPES.has(args?.type) ? args.type : null } : {}),
        ...(requestId !== undefined ? { requestId: Number.isSafeInteger(requestId) ? requestId : diagnosticId(requestId) } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      };
      if (result) {
        record.resultFile = diagnosticFile(result.file);
        record.revision = diagnosticRevision(result.revision);
        record.status = VALID_STATUS.has(result.meta?.status) ? result.meta.status : null;
        record.deduplicated = result.deduplicated === true;
      }
      if (error) {
        record.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'MEMORY_TOOL_ERROR';
        if (typeof error.targetExists === 'boolean') record.targetExists = error.targetExists;
        if (VALID_STATUS.has(error.targetStatus)) record.targetStatus = error.targetStatus;
        if (Object.hasOwn(error, 'actualRevision')) record.actualRevision = diagnosticRevision(error.actualRevision);
        if (error.code === 'MCP_INVALID_PARAMS') record.invalidFields = error.invalidFields;
      }
      const method = error ? 'warn' : 'info';
      logger[method]?.('[memory:tool] ' + JSON.stringify(record));
    } catch (_) { /* Diagnostics must never affect a memory operation. */ }
  }
  function traced(operation, args, action, requestId) {
    const started = Date.now(), ctx = current();
    try {
      const result = action(ctx);
      diagnose(operation, 'result', args, ctx, { result, requestId, elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      diagnose(operation, 'result', args, ctx, { error, requestId, elapsedMs: Date.now() - started });
      throw error;
    }
  }
  function list({ query = '', limit = 30, offset = 0 } = {}) {
    return retriever.search(query, { context: checked(), limit, offset });
  }
  function read(args = {}, { requestId } = {}) {
    return traced('read', args, ctx => {
      const result = store.read(args.file, { actor: 'model', context: checked(ctx) });
      onRead(result.file);
      return result;
    }, requestId);
  }
  function propose(args = {}, { requestId } = {}) {
    return traced('propose', args, ctx => {
      const { file, content, type } = args;
      // Some providers emit the JSON null sentinel as a string. Preserve the
      // original arguments for diagnostics and keep the store's revision check.
      const expectedRevision = args.expectedRevision === 'null' ? null : args.expectedRevision;
      checked(ctx);
      if (!writeAllowed(ctx)) throw Object.assign(new Error('当前任务只允许读取记忆。'), { code: 'MEMORY_PERMISSION' });
      if (expectedRevision === undefined) throw Object.assign(new Error('必须提供 expectedRevision：新记忆传 null，已有记忆先读取 revision。'), { code: 'MEMORY_REVISION_REQUIRED' });
      if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
        throw Object.assign(new Error('expectedRevision 无效：新建使用 null，更新使用 read 返回的完整 revision。'), { code: 'MEMORY_INVALID_REVISION' });
      }
      if (!VALID_TYPES.has(type)) throw Object.assign(new Error('必须明确选择记忆 type：user、feedback、project 或 reference。'), { code: 'MEMORY_SCHEMA' });
      if (ctx.mode === 'maintenance' && expectedRevision !== null) {
        const previous = store.read(file, { actor: 'model', context: ctx });
        if (previous.meta.core || isCore(file)) throw Object.assign(new Error('核心记忆只报告问题，由用户决定是否修改。'), { code: 'MEMORY_CORE' });
      }
      const result = store.write(file, content, { actor: 'model', context: ctx, expectedRevision, memoryType: type,
        userConfirmed: ctx.userConfirmed === true && ctx.mode !== 'maintenance' });
      onChanged(result);
      return { ...result, message: result.meta.status === 'draft' ? '候选已保存，等待用户确认后生效。' : '已记住。' };
    }, requestId);
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
    const run = fn => async (args, extra) => {
      try { return { content: [{ type: 'text', text: JSON.stringify(fn(args, { requestId: extra?.requestId })) }] }; }
      catch (error) {
        const details = { code: error.code, message: error.message };
        if (error.code === 'MEMORY_SUPERSEDED') {
          details.file = error.file;
          details.replacementFiles = error.replacementFiles;
        }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }] };
      }
    };
    const readShape = { file: z.string() };
    const proposeShape = {
      file: z.string(), content: z.string().max(65536), type: z.enum(MEMORY_TYPES), expectedRevision: z.string().nullable(),
    };
    const server = sdk.createSdkMcpServer({ name: 'relay-memory', version: '1.0.0', tools: [
      sdk.tool('list', '检索当前项目及全局已确认的 Relay 记忆，匹配标题、摘要和正文，返回相关片段；完整内容用 read 读取。空 query 列出可用记忆，可用 offset 按页继续，直到返回不足 limit 条。', { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() }, run(list)),
      sdk.tool('read', '读取一条已生效记忆及 revision；修改前必须先读取。', readShape, run(read)),
      sdk.tool('propose', '保存记忆候选；对已有事实的更新必须携带读取的 revision，不能伪造用户确认或核心状态。' + MEMORY_TYPE_GUIDANCE, proposeShape, run(propose)),
    ] });
    if (logger && typeof server.instance?.connect === 'function') {
      const schemas = { read: z.object(readShape), propose: z.object(proposeShape) };
      const connect = server.instance.connect.bind(server.instance);
      server.instance.connect = transport => {
        const onmessage = transport.onmessage;
        // Observe before the SDK validates arguments so rejected calls also have diagnostics.
        transport.onmessage = (message, extra) => {
          try {
            const operation = message?.params?.name;
            if (message?.method === 'tools/call' && Object.hasOwn(schemas, operation)) {
              const args = message.params.arguments, ctx = current(), requestId = message.id;
              diagnose(operation, 'attempt', args, ctx, { requestId });
              const parsed = schemas[operation].safeParse(args);
              if (!parsed.success) {
                const invalidFields = [...new Set(parsed.error.issues.map(issue => issue.path[0])
                  .filter(field => ['file', 'content', 'type', 'expectedRevision'].includes(field)))];
                diagnose(operation, 'result', args, ctx,
                  { requestId, elapsedMs: 0, error: { code: 'MCP_INVALID_PARAMS', invalidFields } });
              }
            }
          } catch (_) { /* The SDK owns validation and dispatch. */ }
          return onmessage?.(message, extra);
        };
        return connect(transport);
      };
    }
    return { 'relay-memory': server };
  }
  return { list, read, propose, hook, factory };
}
module.exports = { createMemoryRuntime, MEMORY_CONSOLIDATION_PROMPT, READ_TOOLS };
