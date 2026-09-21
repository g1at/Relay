'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { StringDecoder } = require('node:string_decoder');
const { createWorkspaceReview } = require('./workspace-review');
const { parse: parseLocalFileLink } = require('./renderer/local-file-links');

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 2000;
const TERMINAL_LIMIT = 8;
const INPUT_LIMIT = 64 * 1024;
const CHANNELS = ['resolve', 'list', 'read', 'open', 'resolveLink', 'readLink', 'openLink', 'review', 'reviewDiff', 'terminalStart', 'terminalInput', 'terminalResize', 'terminalClose'];
const LANGUAGES = { js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', json: 'json', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', xml: 'xml', svg: 'xml', toml: 'toml', ini: 'ini', txt: 'text', log: 'text' };

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function relativePath(value) {
  const input = value == null ? '' : value;
  if (typeof input !== 'string' || input.includes('\0') || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)
      || /^[a-z]:/i.test(input)) throw failure('INVALID_PATH', '只能访问当前工作目录内的文件。');
  const parts = input.split(/[\\/]/).filter((part) => part && part !== '.');
  if (parts.includes('..')) throw failure('INVALID_PATH', '文件路径不能离开当前工作目录。');
  return parts.join(path.sep);
}
function dimensions(cols, rows) {
  const columnCount = cols == null ? 80 : Number(cols);
  const rowCount = rows == null ? 24 : Number(rows);
  if (!Number.isSafeInteger(columnCount) || !Number.isSafeInteger(rowCount) || columnCount < 2 || columnCount > 500 || rowCount < 1 || rowCount > 200) {
    throw failure('INVALID_SIZE', '终端尺寸无效。');
  }
  return { cols: columnCount, rows: rowCount };
}
function bitmapMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function decodeText(buffer, truncated) {
  if (buffer.length >= 2 && ((buffer[0] === 255 && buffer[1] === 254) || (buffer[0] === 254 && buffer[1] === 255))) {
    const body = Buffer.from(buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2)));
    if (buffer[0] === 254) body.swap16();
    return { content: body.toString('utf16le'), binary: false };
  }
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return { binary: true };
  const controls = [...sample].filter((byte) => byte < 32 && ![9, 10, 12, 13, 27].includes(byte)).length;
  if (controls > Math.max(4, sample.length / 20)) return { binary: true };
  const decoder = new StringDecoder('utf8');
  const content = decoder.write(buffer) + (truncated ? '' : decoder.end());
  return { content: content.replace(/^\uFEFF/, ''), binary: false };
}

function registerWorkspaceTools(options) {
  const { ipcMain, getWindow, resolveWorkspace, shell } = options;
  if (!ipcMain || typeof getWindow !== 'function' || typeof resolveWorkspace !== 'function') throw new TypeError('Workspace registration requires ipcMain, getWindow and resolveWorkspace.');
  const sessions = new Map();
  const watched = new Map();
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  let ptyModule = options.ptyModule || null;
  let disposed = false;
  const review = createWorkspaceReview(options.reviewOptions);
  const expectedURL = options.rendererURL || pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const canonicalURL = (value) => {
    try { const url = new URL(value); url.search = ''; url.hash = ''; return platform === 'win32' ? url.href.toLowerCase() : url.href; }
    catch (_) { return ''; }
  };
  function authorize(event) {
    const window = getWindow();
    const sender = event && event.sender;
    if (disposed || !window || (window.isDestroyed && window.isDestroyed()) || sender !== window.webContents
        || !sender || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame
        || canonicalURL(event.senderFrame.url) !== canonicalURL(expectedURL)) {
      throw failure('UNTRUSTED_SENDER', '此窗口不能访问工作目录或终端。');
    }
    return sender;
  }
  async function workspace(context) {
    const resolved = await resolveWorkspace(context || {});
    if (!resolved || resolved.ok === false || typeof resolved.root !== 'string') throw failure('WORKSPACE_UNAVAILABLE', resolved && (resolved.error || resolved.message) || '工作目录暂时不可用。');
    const root = await fs.promises.realpath(resolved.root);
    if (!(await fs.promises.stat(root)).isDirectory()) throw failure('NOT_DIRECTORY', '工作目录不是文件夹。');
    return { root, conversationId: resolved.conversationId || null, managed: !!resolved.managed };
  }
  async function target(context, requestedPath) {
    return targetWithin(await workspace(context), requestedPath);
  }
  async function targetWithin(resolved, requestedPath) {
    const requested = relativePath(requestedPath);
    const candidate = path.resolve(resolved.root, requested);
    if (!isWithin(resolved.root, candidate)) throw failure('OUTSIDE_WORKSPACE', '文件不在当前工作目录内。');
    const actual = await fs.promises.realpath(candidate);
    if (!isWithin(resolved.root, actual)) throw failure('OUTSIDE_WORKSPACE', '此链接指向工作目录以外，无法访问。');
    return { ...resolved, actual, path: requested.split(path.sep).join('/') };
  }
  function assertLocalLinkPath(value, scope) {
    const normalized = String(value).replace(/\\/g, '/');
    if (normalized.startsWith('//')) {
      // WSL's local redirector is not an arbitrary SMB server. Only retain the
      // distribution already identified by this conversation's host runtime.
      const localWsl = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(?:\/|$)/i.exec(normalized);
      if (platform === 'win32' && localWsl && typeof scope?.wslDistribution === 'string'
          && localWsl[1].toLowerCase() === scope.wslDistribution.toLowerCase()) return;
      throw failure('REMOTE_FILE_LINK', '此链接不是本机文件路径，无法在本地打开。');
    }
    if (/^[a-z]:(?![\\/])/i.test(value) || /^\\(?!\\)/.test(value)) throw failure('INVALID_FILE_LINK', '本地链接需要明确的文件路径。');
  }
  function sourceFilePath(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw failure('INVALID_PATH', '预览文件的路径无效。');
    }
    // The renderer sends the raw absolutePath returned by this backend, not a
    // Markdown href. Keep literal #, percent escapes and colon suffixes intact.
    if (/^file:/i.test(value)) {
      const parsed = parseLocalFileLink(value);
      if (!parsed) throw failure('INVALID_PATH', '预览文件的路径无效。');
      return parsed.path;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
      throw failure('INVALID_PATH', '预览文件的来源必须是本地文件路径。');
    }
    return value;
  }
  async function linkTarget(input = {}, { allowExternal = false } = {}) {
    const parsed = parseLocalFileLink(input.href);
    if (!parsed) throw failure('INVALID_FILE_LINK', '此链接不是可预览的本地文件。');
    const resolve = options.resolveLinkWorkspace || resolveWorkspace;
    const scope = await resolve(input.context || {});
    if (!scope || scope.ok === false || typeof scope.root !== 'string') throw failure('WORKSPACE_UNAVAILABLE', '文件所属工作目录暂时不可用。');
    assertLocalLinkPath(parsed.path, scope);
    const basePath = input.basePath != null ? sourceFilePath(input.basePath) : null;
    if (basePath !== null) assertLocalLinkPath(basePath, scope);
    const roots = [];
    for (const candidate of [scope.root, ...(Array.isArray(scope.roots) ? scope.roots : [])]) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      try {
        assertLocalLinkPath(candidate, scope);
        const actual = await fs.promises.realpath(candidate);
        assertLocalLinkPath(actual, scope);
        if ((await fs.promises.stat(actual)).isDirectory() && !roots.includes(actual)) roots.push(actual);
      } catch (_) { /* A scratch root may not exist until the first task uses it. */ }
    }
    if (!roots.length) throw failure('WORKSPACE_UNAVAILABLE', '文件所属工作目录暂时不可用。');
    const mapPath = value => {
      if (platform !== 'win32') return value;
      const mounted = /^\/mnt\/([a-z])(?:\/|$)/i.exec(value);
      if (mounted) return `${mounted[1].toUpperCase()}:\\${value.slice(mounted[0].length).replace(/\//g, '\\')}`;
      if (/^\/(?!\/)/.test(value)) {
        const distribution = scope.wslDistribution;
        if (typeof distribution !== 'string' || !/^[\w. -]+$/.test(distribution)) throw failure('UNKNOWN_WSL_PATH', '无法确定此文件所属的 WSL 环境。');
        return `\\\\wsl.localhost\\${distribution}${value.replace(/\//g, '\\')}`;
      }
      return value;
    };
    let base = roots[0];
    if (basePath !== null) {
      const parent = path.resolve(roots[0], mapPath(basePath));
      assertLocalLinkPath(parent, scope);
      if (!roots.some(root => isWithin(root, parent))) {
        if (!allowExternal) throw failure('OUTSIDE_WORKSPACE', '此链接的来源文件已不属于当前会话工作目录。');
        const actualParent = await fs.promises.realpath(path.dirname(parent));
        assertLocalLinkPath(actualParent, scope);
        const actualBase = await fs.promises.realpath(parent);
        assertLocalLinkPath(actualBase, scope);
        if (!isWithin(actualParent, actualBase)) throw failure('OUTSIDE_WORKSPACE', '来源文件的链接指向其所在目录以外，请打开实际文件。');
        if (!(await fs.promises.stat(actualBase)).isFile()) throw failure('NOT_FILE', '链接的来源路径不是文件。');
        base = path.dirname(actualBase);
      } else base = path.dirname(parent);
    }
    const candidate = path.resolve(base, mapPath(parsed.path));
    assertLocalLinkPath(candidate, scope);
    const workspaceRoot = roots.find(root => isWithin(root, candidate));
    if (!workspaceRoot && !allowExternal) throw failure('OUTSIDE_WORKSPACE', '此文件不在当前会话的工作目录或临时目录内。');
    // Explicit file links may refer to another local folder without granting a
    // new workspace root. Pin the target's parent before following its final
    // symlink; a link may not silently redirect outside that selected boundary.
    const boundary = workspaceRoot || await fs.promises.realpath(path.dirname(candidate));
    assertLocalLinkPath(boundary, scope);
    const actual = await fs.promises.realpath(candidate);
    assertLocalLinkPath(actual, scope);
    if (!isWithin(boundary, actual)) throw failure('OUTSIDE_WORKSPACE', '此链接指向其所在目录以外，请打开实际文件。');
    const stat = await fs.promises.stat(actual);
    if (!stat.isFile() && !stat.isDirectory()) throw failure('NOT_FILE', '此链接不是文件或文件夹，无法打开。');
    const kind = stat.isDirectory() ? 'directory' : 'file';
    const root = workspaceRoot || (kind === 'directory' ? actual : boundary);
    return { root, actual, path: actual, kind, relativePath: path.relative(root, actual).split(path.sep).join('/'),
      line: kind === 'file' ? parsed.line : null, conversationId: scope.conversationId || null };
  }
  function linkMetadata(file) {
    return { absolutePath: file.actual, path: file.path, name: path.basename(file.actual),
      kind: file.kind, relativePath: file.relativePath, line: file.line, root: file.root };
  }
  function emit(session, payload) {
    try { if (!session.owner.isDestroyed()) session.owner.send('workspace:terminal-event', { id: session.id, ...payload }); }
    catch (_) { /* The renderer may have disappeared between the PTY callback and delivery. */ }
  }
  function flush(session) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    const data = session.pending; session.pending = '';
    for (let offset = 0; offset < data.length; offset += 65536) emit(session, { type: 'data', data: data.slice(offset, offset + 65536) });
    if (session.paused && !session.closed) { session.paused = false; session.pty.resume(); }
  }
  function end(session, exitCode, kill = false) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    flush(session);
    for (const subscription of session.subscriptions) subscription.dispose();
    if (kill) { try { session.pty.kill(); } catch (_) {} }
    emit(session, { type: 'exit', exitCode: Number.isInteger(exitCode) ? exitCode : null });
  }
  function closeAll(owner = null) {
    for (const session of [...sessions.values()]) if (!owner || session.owner === owner) end(session, null, true);
  }
  function watch(owner) {
    if (watched.has(owner)) return;
    const onDestroy = () => { closeAll(owner); unwatch(owner); };
    const onNavigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) closeAll(owner); };
    const onGone = () => closeAll(owner);
    owner.on('destroyed', onDestroy);
    owner.on('did-start-navigation', onNavigate);
    owner.on('render-process-gone', onGone);
    watched.set(owner, { onDestroy, onNavigate, onGone });
  }
  function unwatch(owner) {
    const handlers = watched.get(owner);
    if (!handlers) return;
    owner.removeListener('destroyed', handlers.onDestroy);
    owner.removeListener('did-start-navigation', handlers.onNavigate);
    owner.removeListener('render-process-gone', handlers.onGone);
    watched.delete(owner);
  }
  function ownedSession(owner, id) {
    const session = typeof id === 'string' && sessions.get(id);
    if (!session || session.owner !== owner || session.closed) throw failure('TERMINAL_NOT_FOUND', '终端已关闭，请新建终端。');
    return session;
  }
  async function readTarget(file) {
      const original = await fs.promises.stat(file.actual);
      if (!original.isFile()) throw failure('NOT_FILE', '请选择文件进行预览。');
      const handle = await fs.promises.open(file.actual, 'r');
      try {
        const stat = await handle.stat();
        const actual = await fs.promises.realpath(file.actual);
        if (actual !== file.actual || !isWithin(file.root, actual) || stat.dev !== original.dev || stat.ino !== original.ino) throw failure('FILE_CHANGED', '文件位置已改变，请重新打开。');
        const header = Buffer.alloc(Math.min(16, stat.size));
        await handle.read(header, 0, header.length, 0);
        const mimeType = bitmapMime(header);
        const limit = mimeType ? IMAGE_LIMIT : TEXT_LIMIT;
        if (mimeType && stat.size > limit) return { ok: true, path: file.path, size: stat.size, binary: true, truncated: true, reason: '图片过大，请在系统应用中打开。' };
        const buffer = Buffer.alloc(Math.min(stat.size, limit));
        let read = 0;
        while (read < buffer.length) {
          const chunk = await handle.read(buffer, read, buffer.length - read, read);
          if (!chunk.bytesRead) break;
          read += chunk.bytesRead;
        }
        const bytes = buffer.subarray(0, read);
        const truncated = stat.size > limit;
        if (mimeType) return { ok: true, path: file.path, size: stat.size, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, binary: false, truncated: false };
        const result = decodeText(bytes, truncated);
        return { ok: true, path: file.path, size: stat.size, language: LANGUAGES[path.extname(file.path).slice(1).toLowerCase()] || 'text', truncated, ...result };
      } finally { await handle.close(); }
  }
  const handlers = {
    async resolve(_event, context) { return { ok: true, ...await workspace(context) }; },
    async resolveLink(event, input = {}) {
      const file = await linkTarget(input, { allowExternal: true }); authorize(event);
      return { ok: true, ...linkMetadata(file) };
    },
    async readLink(event, input = {}) {
      const file = await linkTarget(input, { allowExternal: true }); authorize(event);
      // Directory links navigate the existing file tree. Return only the target
      // inside its authorized root; listing still goes through the normal guard.
      if (file.kind === 'directory') return { ok: true, ...linkMetadata(file) };
      const result = await readTarget(file); authorize(event);
      return { ...result, ...linkMetadata(file) };
    },
    async openLink(event, input = {}) {
      if (!['system', 'reveal'].includes(input.target)) throw failure('INVALID_TARGET', '文件打开方式无效。');
      const file = await linkTarget(input, { allowExternal: true }); authorize(event);
      if (input.target === 'reveal') { shell.showItemInFolder(file.actual); return { ok: true }; }
      if (file.kind === 'file' && /\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|hta|scr|cpl|msi|msp|lnk|url|appref-ms|js|cjs|mjs|jse|py|pyw|rb|sh|bash|zsh|fish|pl|command|desktop)$/i.test(file.actual)) {
        throw failure('EXECUTABLE_FILE', '此文件可能执行程序，请在资源管理器中确认后打开。');
      }
      if (typeof options.openFile === 'function') return options.openFile(file.actual, 'system');
      const error = await shell.openPath(file.actual);
      if (error) throw failure('OPEN_FAILED', error);
      return { ok: true };
    },
    async review(event, context = {}) {
      const resolved = await workspace({ conversationId: context.conversationId, projectId: context.projectId });
      authorize(event);
      const result = await review.overview(resolved);
      authorize(event);
      return { ...result, findings: options.getReviewFindings?.(resolved.conversationId) || null };
    },
    async reviewDiff(event, input = {}) {
      const context = input.context || {};
      const resolved = await workspace({ conversationId: context.conversationId, projectId: context.projectId });
      authorize(event);
      const result = await review.readFileDiff(resolved, { path: input.path, stage: input.stage });
      authorize(event);
      return result;
    },
    async list(event, input = {}) {
      let file;
      if (input.directoryLink != null) {
        const link = input.directoryLink;
        if (!link || typeof link !== 'object' || Array.isArray(link)) throw failure('INVALID_FILE_LINK', '文件夹链接无效。');
        // Explicit directory links get a bounded temporary tree. Every expansion
        // resolves it again; renderer root values cannot broaden this tree.
        const directory = await linkTarget({ href: link.href, basePath: link.basePath, context: input.context }, { allowExternal: true });
        if (directory.kind !== 'directory') throw failure('NOT_DIRECTORY', '此链接不是文件夹。');
        file = await targetWithin({ root: directory.actual, conversationId: directory.conversationId, managed: false }, input.path);
      } else file = await target(input.context, input.path);
      authorize(event);
      if (!(await fs.promises.stat(file.actual)).isDirectory()) throw failure('NOT_DIRECTORY', '此路径不是文件夹。');
      const names = await fs.promises.readdir(file.actual, { withFileTypes: true });
      const entries = [];
      for (const item of names.slice(0, ENTRY_LIMIT)) {
        try {
          const actual = await fs.promises.realpath(path.join(file.actual, item.name));
          if (!isWithin(file.root, actual)) continue;
          const stat = await fs.promises.stat(actual);
          if (!stat.isFile() && !stat.isDirectory()) continue;
          entries.push({ name: item.name, path: [file.path, item.name].filter(Boolean).join('/'), type: stat.isDirectory() ? 'directory' : 'file', size: stat.size });
        } catch (_) { /* Entries removed or made unreadable during enumeration are omitted. */ }
      }
      entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      authorize(event);
      return { ok: true, root: file.root, path: file.path, entries, truncated: names.length > ENTRY_LIMIT };
    },
    async read(_event, input = {}) {
      if (typeof options.readRuntimeFile === 'function') {
        const runtime = await options.readRuntimeFile(input.context, relativePath(input.path));
        if (runtime?.handled) {
          if (!runtime.value || runtime.value.encoding !== 'base64') throw failure('RUNTIME_READ_DENIED', '运行环境未返回文件内容，可能是权限、文件位置或连接问题。');
          // Validate by canonical round-trip instead of a repeated-group regex,
          // which can exhaust V8's regexp stack on multi-megabyte images.
          if (typeof runtime.value.contents !== 'string' || runtime.value.contents.length > IMAGE_LIMIT * 1.4) throw failure('RUNTIME_READ_INVALID', '运行环境返回的文件编码无效');
          const bytes = Buffer.from(runtime.value.contents, 'base64'), mimeType = bitmapMime(bytes);
          if (bytes.toString('base64') !== runtime.value.contents) throw failure('RUNTIME_READ_INVALID', '运行环境返回的文件编码无效');
          if (bytes.length > IMAGE_LIMIT) throw failure('FILE_TOO_LARGE', '文件过大，请在系统应用中打开。');
          const truncated = runtime.value.truncated === true;
          if (mimeType && !truncated) return { ok: true, path: input.path, size: bytes.length, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, binary: false, truncated };
          const result = decodeText(bytes.subarray(0, TEXT_LIMIT), truncated || bytes.length > TEXT_LIMIT);
          return { ok: true, path: input.path, size: bytes.length, language: LANGUAGES[path.extname(input.path || '').slice(1).toLowerCase()] || 'text', ...result, truncated: truncated || bytes.length > TEXT_LIMIT };
        }
      }
      const file = await target(input.context, input.path);
      return readTarget(file);
    },
    async open(event, input = {}) {
      const file = await target(input.context, input.path);
      authorize(event);
      if (typeof options.openFile === 'function') return options.openFile(file.actual, input.target || 'system');
      const error = await shell.openPath(file.actual);
      if (error) throw failure('OPEN_FAILED', error);
      return { ok: true };
    },
    async terminalStart(event, input = {}) {
      const owner = authorize(event);
      if ([...sessions.values()].filter((session) => session.owner === owner).length >= TERMINAL_LIMIT) throw failure('TERMINAL_LIMIT', '最多同时打开 8 个终端，请先关闭一个。');
      const size = dimensions(input.cols, input.rows);
      const resolved = await workspace(input.context);
      const terminal = typeof options.resolveTerminal === 'function' ? await options.resolveTerminal({ cwd: resolved.root }) : null;
      authorize(event);
      if ([...sessions.values()].filter((session) => session.owner === owner).length >= TERMINAL_LIMIT) throw failure('TERMINAL_LIMIT', '最多同时打开 8 个终端，请先关闭一个。');
      if (!ptyModule) {
        try { ptyModule = require('node-pty'); }
        catch (_) { throw failure('PTY_UNAVAILABLE', '终端组件无法加载，请重新安装当前版本的 Relay。'); }
      }
      const shellPath = terminal && terminal.file || options.shellPath || (platform === 'win32'
        ? path.win32.join(environment.SystemRoot || environment.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : environment.SHELL || '/bin/bash');
      const args = terminal && terminal.args || options.shellArgs || (platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['-l']);
      const env = { ...environment, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Relay' };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_CHANNEL_FD']) delete env[key];
      const pty = ptyModule.spawn(shellPath, args, { ...size, cwd: resolved.root, env, name: 'xterm-256color', useConpty: true });
      const session = { id: crypto.randomUUID(), owner, pty, pending: '', timer: null, paused: false, closed: false, subscriptions: [] };
      sessions.set(session.id, session);
      watch(owner);
      session.subscriptions.push(pty.onData((data) => {
        if (session.closed) return;
        session.pending += data;
        if (session.pending.length > 1024 * 1024 && !session.paused && typeof pty.pause === 'function') { session.paused = true; pty.pause(); }
        if (!session.timer) session.timer = setTimeout(() => flush(session), 16);
      }));
      session.subscriptions.push(pty.onExit((event) => end(session, event.exitCode)));
      return { ok: true, id: session.id, ...resolved, ...size, shell: terminal && terminal.label || (platform === 'win32' ? 'PowerShell' : path.basename(shellPath)) };
    },
    terminalInput(event, input = {}) {
      const session = ownedSession(authorize(event), input.id);
      if (typeof input.data !== 'string' || Buffer.byteLength(input.data, 'utf8') > INPUT_LIMIT) throw failure('INVALID_INPUT', '单次终端输入过长。');
      if (input.data) session.pty.write(input.data);
      return { ok: true };
    },
    terminalResize(event, input = {}) {
      const session = ownedSession(authorize(event), input.id);
      const size = dimensions(input.cols, input.rows);
      session.pty.resize(size.cols, size.rows);
      return { ok: true, ...size };
    },
    terminalClose(event, input = {}) {
      const owner = authorize(event);
      const session = sessions.get(input.id);
      if (!session) return { ok: true, closed: false };
      if (session.owner !== owner) throw failure('TERMINAL_NOT_FOUND', '此终端不属于当前窗口。');
      end(session, null, true);
      return { ok: true, closed: true };
    },
  };
  for (const name of CHANNELS) ipcMain.handle(`workspace:${name}`, async (event, input) => {
    authorize(event);
    try { return await handlers[name](event, input); }
    catch (error) {
      const messages = { ENOENT: '文件或工作目录已不存在。', EACCES: '没有权限访问此文件。', EPERM: '没有权限访问此文件。' };
      return { ok: false, code: error.code || 'WORKSPACE_ERROR', error: messages[error.code] || error.message || '操作未完成，请重试。' };
    }
  });
  return {
    closeAll,
    // Host-only helper for the quick-chat bridge. It intentionally exposes no
    // text, directory listing, shell opening or terminal access to that window.
    async readLocalImage(input) {
      const file = await linkTarget(input);
      const result = await readTarget(file);
      if (!result.dataUrl || result.binary || result.truncated) {
        throw failure('NOT_IMAGE', '此文件不是可预览的图片，或图片过大。');
      }
      return { ok: true, dataUrl: result.dataUrl, mimeType: result.mimeType, size: result.size };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      review.dispose();
      closeAll();
      for (const owner of [...watched.keys()]) unwatch(owner);
      for (const name of CHANNELS) ipcMain.removeHandler(`workspace:${name}`);
    },
  };
}

module.exports = { registerWorkspaceTools, isWithin, relativePath, decodeText, bitmapMime, dimensions, TEXT_LIMIT, IMAGE_LIMIT, ENTRY_LIMIT, TERMINAL_LIMIT };
