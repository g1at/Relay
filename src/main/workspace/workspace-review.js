'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const FILE_LIMIT = 600;
const OUTPUT_LIMIT = 512 * 1024;
const FILE_SIZE_LIMIT = 8 * 1024 * 1024;
const TIMEOUT = 8000;
const GIT_NULL = process.platform === 'win32' ? 'NUL' : os.devNull;
const STAGES = new Set(['staged', 'unstaged', 'untracked']);
const fail = (code, message) => Object.assign(new Error(message), { code });
function within(root, value) { const rel = path.relative(root, value); return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); }
function cleanPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) throw fail('INVALID_PATH', '请选择工作目录内的改动文件。');
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw fail('INVALID_PATH', '文件路径不能离开工作目录。');
  return parts.join('/');
}
function decode(buffer, truncated = false) { const decoder = new StringDecoder('utf8'); return decoder.write(buffer) + (truncated ? '' : decoder.end()); }
function tokens(result) { const parts = result.stdout.toString('utf8').split('\0'); parts.pop(); return parts; }
function pathBatches(paths) {
  const batches = []; let batch = [], size = 0;
  for (const file of paths) {
    const bytes = Buffer.byteLength(file) + 1;
    if (batch.length && size + bytes > 22000) { batches.push(batch); batch = []; size = 0; }
    batch.push(file); size += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function commandEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) || /^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  // Preserve normal read-only Git preferences (autocrlf, ignore files and safe
  // directories). Execution-capable settings are disabled per command below.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
}
function parseNumstat(output) {
  const result = new Map(), fields = tokens(output);
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
    if (!match) continue;
    let file = match[3], oldPath;
    if (!file) { oldPath = fields[++index]; file = fields[++index]; }
    if (!file) continue;
    result.set(file, { added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]), binary: match[1] === '-', ...(oldPath ? { oldPath } : {}) });
  }
  return result;
}

function createWorkspaceReview(options = {}) {
  const spawnProcess = options.spawn || spawn;
  const timeout = options.timeoutMs || TIMEOUT, outputLimit = options.outputLimit || OUTPUT_LIMIT;
  const env = commandEnvironment(options.env || process.env), children = new Set();
  let disposed = false;
  const base = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false', '-c', 'core.hooksPath=' + GIT_NULL, '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'diff.external=', '-c', 'core.quotePath=false'];
  function run(cwd, args, extra = [], limit = outputLimit) {
    if (disposed) return Promise.reject(fail('REVIEW_CLOSED', '审查已关闭。'));
    return new Promise((resolve, reject) => {
      let child, timer, finished = false, length = 0, truncated = false, timedOut = false;
      const chunks = [];
      const finish = (error, code) => {
        if (finished) return; finished = true; clearTimeout(timer); children.delete(child);
        if (error) reject(error); else resolve({ code, stdout: Buffer.concat(chunks), truncated });
      };
      try { child = spawnProcess('git', [...base, ...extra, ...args], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { finish(fail(error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED', 'Git 暂时不可用，请检查是否已安装。')); return; }
      children.add(child);
      timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
      child.stdout.on('data', data => {
        const bytes = Buffer.from(data), remaining = Math.max(0, limit - length);
        if (remaining) { chunks.push(bytes.subarray(0, remaining)); length += Math.min(remaining, bytes.length); }
        if (bytes.length > remaining) { truncated = true; child.kill(); }
      });
      // Never echo Git diagnostics: repository configuration can contain private paths.
      child.stderr.on('data', () => {});
      child.on('error', error => finish(fail(error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED', 'Git 暂时不可用，请检查是否已安装。')));
      child.on('close', code => finish(timedOut ? fail('REVIEW_TIMEOUT', '读取改动超时，请缩小项目范围后重试。') : disposed ? fail('REVIEW_CLOSED', '审查已关闭。') : null, code));
    });
  }
  async function checked(repo, args, limit) {
    const value = await run(repo.root, args, repo.flags, limit);
    if (value.code !== 0 && !value.truncated) throw fail('GIT_FAILED', '无法读取 Git 改动，请刷新后重试。');
    return value;
  }
  async function repository(workspace) {
    const root = await fs.promises.realpath(workspace.root);
    const found = await run(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    if (found.code !== 0) return null;
    const [top, gitDir] = decode(found.stdout).trimEnd().split(/\r?\n/);
    if (!top || !gitDir) throw fail('GIT_FAILED', '无法读取 Git 工作目录。');
    const repoRoot = await fs.promises.realpath(top);
    if (!within(repoRoot, root)) throw fail('OUTSIDE_WORKSPACE', 'Git 工作目录与当前项目不匹配。');
    const flags = ['--git-dir=' + gitDir, '--work-tree=' + repoRoot];
    // status/diff can invoke clean/process filters even with --no-ext-diff.
    // Read names only, then override every repository-defined filter for this invocation.
    const filters = await run(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], flags, 64 * 1024);
    if (filters.truncated || ![0, 1].includes(filters.code)) throw fail('GIT_CONFIG_UNAVAILABLE', '无法安全读取此仓库的 Git 配置。');
    for (const key of tokens(filters)) if (/^filter\..*\.(clean|smudge|process|required)$/.test(key) && !/[\r\n\0]/.test(key)) flags.push('-c', key + '=' + (key.endsWith('.required') ? 'false' : ''));
    const branchResult = await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], flags);
    let branch = decode(branchResult.stdout).trim();
    if (!branch) { const head = await run(root, ['rev-parse', '--short', 'HEAD'], flags); branch = head.code === 0 ? decode(head.stdout).trim() + '（分离）' : '尚无提交'; }
    return { root, repoRoot, flags, branch, prefix: path.relative(repoRoot, root).split(path.sep).join('/') };
  }
  async function safeFile(root, file) {
    const relative = cleanPath(file), candidate = path.resolve(root, relative);
    if (!within(root, candidate)) throw fail('OUTSIDE_WORKSPACE', '文件不在当前工作目录内。');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try { const real = await fs.promises.realpath(current); if (!within(root, real)) throw fail('OUTSIDE_WORKSPACE', '此链接指向工作目录以外。'); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return candidate;
  }
  function workspacePath(repo, name) {
    if (repo.prefix) { if (!name.startsWith(repo.prefix + '/')) return null; name = name.slice(repo.prefix.length + 1); }
    try { return cleanPath(name); } catch (_) { return null; }
  }
  async function scan(repo, requested = null) {
    // Restrict every working-tree operation to paths whose real parents stay in
    // the trusted scope, including a project that is a subdirectory of a repo.
    const listing = await checked(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', requested || '.'], 8 * 1024 * 1024);
    // Removed index paths are absent from ls-files. Include the index/HEAD delta
    // so staged deletions and both sides of renames remain in the pathspec.
    const stagedPaths = await checked(repo, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--find-renames', '--relative', '--name-status', '-z', '--', '.'], 8 * 1024 * 1024);
    const changed = [], stageTokens = tokens(stagedPaths);
    for (let index = 0; index < stageTokens.length;) {
      const status = stageTokens[index++], first = stageTokens[index++];
      const second = /^[RC]/.test(status) ? stageTokens[index++] : null;
      if (!requested || first === requested || second === requested) changed.push(...[first, second].filter(Boolean));
    }
    const candidates = [...new Set([...tokens(listing), ...changed])], allowed = [], files = [], seen = new Set();
    let truncated = listing.truncated || stagedPaths.truncated;
    for (const name of candidates) {
      try {
        await safeFile(repo.root, name);
        allowed.push(name);
      } catch (_) { /* Broken or escaping links are never passed to worktree reads. */ }
    }
    if (!allowed.length) return { files, allowed, truncated };
    for (const batch of pathBatches(allowed)) {
      const status = await checked(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--renames', '--', ...batch]);
      truncated ||= status.truncated;
      const entries = tokens(status);
      for (let index = 0; index < entries.length; index++) {
      const record = entries[index], state = record.slice(0, 2), file = workspacePath(repo, record.slice(3));
      const renamed = /[RC]/.test(state), oldPath = renamed ? workspacePath(repo, entries[++index] || '') : null;
      if (!file || (renamed && !oldPath)) continue;
      try { await safeFile(repo.root, file); if (oldPath) await safeFile(repo.root, oldPath); } catch (_) { continue; }
      const push = (stage, status) => {
        const key = stage + '\0' + file; if (seen.has(key)) return; seen.add(key);
        if (files.length >= FILE_LIMIT) { truncated = true; return; }
        files.push({ path: file, ...(oldPath ? { oldPath } : {}), stage, status, added: null, deleted: null, binary: false });
      };
      if (state === '??') push('untracked', '?');
      else {
        if (state[0] !== ' ' && state[0] !== '?') push('staged', state[0]);
        if (state[1] !== ' ' && state[1] !== '?') push('unstaged', state[1]);
      }
      }
      if (files.length >= FILE_LIMIT) { truncated = true; break; }
    }
    return { files, allowed, truncated };
  }
  const diffArgs = (stage, format) => ['diff', ...(stage === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--relative', '--find-renames', ...format];
  async function readUntracked(repo, file) {
    const candidate = await safeFile(repo.root, file), original = await fs.promises.lstat(candidate);
    if (!original.isFile()) return { binary: true, diff: '', added: null, deleted: null, truncated: false, reason: '此条目不是普通文本文件。' };
    const handle = await fs.promises.open(candidate, 'r');
    try {
      const stat = await handle.stat(); await safeFile(repo.root, file);
      if (stat.dev !== original.dev || stat.ino !== original.ino) throw fail('FILE_CHANGED', '文件已变化，请刷新后重试。');
      const buffer = Buffer.alloc(Math.min(stat.size, outputLimit)), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, bytesRead);
      const truncated = stat.size > bytesRead;
      if (bytes.subarray(0, 8192).includes(0)) return { binary: true, diff: '', added: null, deleted: null, truncated, reason: '二进制文件无法显示文本差异。' };
      const content = decode(bytes, truncated), lines = content ? content.split('\n') : [];
      if (content.endsWith('\n')) lines.pop();
      const before = JSON.stringify('a/' + file), after = JSON.stringify('b/' + file), header = `diff --git ${before} ${after}\nnew file mode 100644\n--- /dev/null\n+++ ${after}\n`;
      const body = lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + '\n' + (!content.endsWith('\n') && !truncated ? '\\ No newline at end of file\n' : '') : '';
      const result = Buffer.from(header + body);
      return { binary: false, diff: decode(result.subarray(0, outputLimit), truncated || result.length > outputLimit), added: truncated ? null : lines.length, deleted: 0, truncated: truncated || result.length > outputLimit };
    } finally { await handle.close(); }
  }
  async function overview(workspace) {
    let repo;
    try { repo = await repository(workspace); }
    catch (error) { if (error.code === 'GIT_UNAVAILABLE') return { ok: true, kind: 'unavailable', root: workspace.root, branch: '', files: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: false, message: error.message }; throw error; }
    if (!repo) return { ok: true, kind: 'not-repository', root: workspace.root, branch: '', files: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: false, message: '当前工作目录尚未使用 Git。' };
    const snapshot = await scan(repo);
    for (const stage of ['staged', 'unstaged']) {
      const items = snapshot.files.filter(file => file.stage === stage); if (!items.length) continue;
      const paths = [...new Set(items.flatMap(file => [file.path, file.oldPath].filter(Boolean)))];
      const stats = new Map(); let limited = false;
      for (const batch of pathBatches(paths)) {
        const output = await checked(repo, [...diffArgs(stage, ['--numstat', '-z']), '--', ...batch]);
        for (const [file, stat] of parseNumstat(output)) stats.set(file, stat);
        limited ||= output.truncated;
      }
      snapshot.truncated ||= limited;
      for (const file of items) { const stat = stats.get(file.path); if (stat) Object.assign(file, { added: stat.added, deleted: stat.deleted, binary: stat.binary }); else file.truncated = limited; }
      // With optional index writes disabled, status may still report an old
      // stat-cache mismatch after CRLF normalization. The actual diff is the
      // authority; real mode/rename-only changes have a 0/0 numstat record.
      if (!limited) snapshot.files = snapshot.files.filter(file => file.stage !== stage || stats.has(file.path));
    }
    let untrackedBytes = 0;
    for (const file of snapshot.files.filter(file => file.stage === 'untracked')) {
      if (untrackedBytes >= 2 * outputLimit) { file.truncated = true; snapshot.truncated = true; continue; }
      try { const result = await readUntracked(repo, file.path); untrackedBytes += Buffer.byteLength(result.diff); Object.assign(file, { added: result.added, deleted: result.deleted, binary: result.binary, truncated: result.truncated }); snapshot.truncated ||= result.truncated; } catch (_) { file.truncated = true; }
    }
    return { ok: true, kind: 'ready', root: repo.root, branch: repo.branch, files: snapshot.files, totals: { files: snapshot.files.length, added: snapshot.files.reduce((sum, file) => sum + (file.added || 0), 0), deleted: snapshot.files.reduce((sum, file) => sum + (file.deleted || 0), 0) }, truncated: snapshot.truncated };
  }
  async function readFileDiff(workspace, input = {}) {
    const requested = cleanPath(input.path); if (!STAGES.has(input.stage)) throw fail('INVALID_STAGE', '请选择已暂存、未暂存或未跟踪的改动。');
    const repo = await repository(workspace); if (!repo) throw fail('NOT_REPOSITORY', '当前工作目录尚未使用 Git。');
    await safeFile(repo.root, requested);
    const snapshot = await scan(repo, requested), file = snapshot.files.find(file => file.path === requested && file.stage === input.stage);
    if (!file) throw fail('CHANGE_NOT_FOUND', '该文件的改动已变化或消失，请刷新审查。');
    const common = { ok: true, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), stage: file.stage };
    if (file.stage === 'untracked') return { ...common, ...await readUntracked(repo, file.path) };
    const candidate = await safeFile(repo.root, file.path);
    try { if ((await fs.promises.stat(candidate)).size > FILE_SIZE_LIMIT) return { ...common, diff: '', binary: false, added: null, deleted: null, truncated: true, reason: '文件较大，已限制差异预览。' }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const output = await checked(repo, [...diffArgs(file.stage, ['--unified=3']), '--', file.path, ...(file.oldPath ? [file.oldPath] : [])]);
    await safeFile(repo.root, requested);
    const diff = decode(output.stdout, output.truncated), binary = /^Binary files .* differ$/m.test(diff);
    if (!diff && !output.truncated) throw fail('CHANGE_NOT_FOUND', '该文件的改动已变化或消失，请刷新审查。');
    let added = 0, deleted = 0, inHunk = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) inHunk = false;
      else if (line.startsWith('@@ ')) inHunk = true;
      else if (inHunk && line.startsWith('+')) added++;
      else if (inHunk && line.startsWith('-')) deleted++;
    }
    return { ...common, diff, binary, added: binary || output.truncated ? null : added, deleted: binary || output.truncated ? null : deleted, truncated: output.truncated, ...(binary ? { reason: '二进制文件无法显示文本差异。' } : {}) };
  }
  return { overview, readFileDiff, dispose() { disposed = true; for (const child of children) child.kill(); } };
}

module.exports = { createWorkspaceReview, cleanPath, parseNumstat, commandEnvironment, FILE_LIMIT, OUTPUT_LIMIT, FILE_SIZE_LIMIT, TIMEOUT };
