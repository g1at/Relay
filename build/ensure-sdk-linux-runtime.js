'use strict';
// Build-only preparation of the pinned Linux CLI. Never install global Node/WSL tools.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const PACKAGE = '@anthropic-ai/claude-agent-sdk-linux-x64';
const MAX_ARCHIVE = 256 * 1024 * 1024, MAX_ENTRY = 512 * 1024 * 1024;
function descriptor(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Claude Agent SDK 必须锁定精确稳定版本。');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const sdk = lock.packages?.['node_modules/@anthropic-ai/claude-agent-sdk'];
  const native = lock.packages?.['node_modules/' + PACKAGE];
  if (sdk?.version !== version || sdk.optionalDependencies?.[PACKAGE] !== version || native?.version !== version) throw Error('SDK 与 Linux 运行时锁文件版本不一致，请先安装依赖。');
  const url = new URL(native.resolved || '');
  if (url.protocol !== 'https:' || url.host !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== `/${PACKAGE}/-/claude-agent-sdk-linux-x64-${version}.tgz`) throw Error('Linux 运行时必须来自锁文件中的官方 npm registry。');
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(native.integrity || '')) throw Error('Linux 运行时缺少有效 SHA-512 完整性校验。');
  return { version, url: url.href, integrity: native.integrity };
}
function regular(file) { try { return fs.lstatSync(file).isFile(); } catch (_) { return false; } }
function installed(target, version) {
  const metadata = path.join(target, 'package.json'), binary = path.join(target, 'claude');
  if (!regular(metadata) || !regular(binary)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (pkg.name !== PACKAGE || pkg.version !== version || !pkg.os?.includes('linux') || !pkg.cpu?.includes('x64')) return false;
    const handle = fs.openSync(binary, 'r'), magic = Buffer.alloc(4);
    try { fs.readSync(handle, magic, 0, 4, 0); } finally { fs.closeSync(handle); }
    return magic.equals(Buffer.from([127, 69, 76, 70]));
  } catch (_) { return false; }
}
async function downloadArchive(url, destination) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw Error('官方下载失败（HTTP ' + response.status + '）。');
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE) throw Error('Linux 运行时压缩包超出大小限制。');
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length; callback(bytes > MAX_ARCHIVE ? Error('Linux 运行时压缩包超出大小限制。') : null, chunk);
  } }), fs.createWriteStream(destination, { flags: 'wx' }));
}
async function ensureRuntime({ rootDir = path.resolve(__dirname, '..'), download = downloadArchive } = {}) {
  const root = fs.realpathSync(rootDir), spec = descriptor(root), parent = path.join(root, 'node_modules', '@anthropic-ai');
  // Reject symlinked dependency directories before writing any staging files.
  for (const part of [path.join(root, 'node_modules'), parent]) {
    if (fs.existsSync(part)) {
      const real = fs.realpathSync(part);
      if (real !== part) throw Error('运行时安装目录不能重定向到其它位置。');
    } else fs.mkdirSync(part);
  }
  const target = path.join(parent, 'claude-agent-sdk-linux-x64');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('Linux 运行时目录不能是符号链接。');
  if (installed(target, spec.version)) return { changed: false, version: spec.version };
  const work = fs.mkdtempSync(path.join(parent, '.relay-linux-runtime-')), archive = path.join(work, 'runtime.tgz'), stage = path.join(work, 'package'), backup = path.join(work, 'previous');
  let moved = false;
  try {
    await download(spec.url, archive);
    if (!regular(archive) || fs.statSync(archive).size > MAX_ARCHIVE) throw Error('Linux 运行时压缩包无效。');
    const hash = crypto.createHash('sha512'); for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (!crypto.timingSafeEqual(hash.digest(), Buffer.from(spec.integrity.slice(7), 'base64'))) throw Error('Linux 运行时 SHA-512 校验失败。');
    const tar = require('tar'), seen = new Set(); let unsafe = false;
    await tar.t({ file: archive, strict: true, onentry(entry) {
      if (entry.path === 'package/' && entry.type === 'Directory') return;
      if (!/^package\/(?:claude|package\.json|README\.md|LICENSE\.md)$/.test(entry.path)
          || entry.type !== 'File' || entry.size > MAX_ENTRY || seen.has(entry.path)) unsafe = true;
      seen.add(entry.path);
    } });
    if (unsafe) throw Error('Linux 运行时包含不安全或未知压缩包条目。');
    fs.mkdirSync(stage);
    await tar.x({ file: archive, cwd: stage, strip: 1, strict: true, preservePaths: false });
    if (!installed(stage, spec.version)) throw Error('压缩包中的 Linux 运行时版本或文件类型不正确。');
    fs.chmodSync(path.join(stage, 'claude'), 0o755);
    if (fs.existsSync(target)) { fs.renameSync(target, backup); moved = true; }
    try { fs.renameSync(stage, target); }
    catch (error) { if (moved) fs.renameSync(backup, target); throw error; }
    return { changed: true, version: spec.version };
  } catch (error) {
    throw new Error('无法准备 WSL 智能体运行时，已停止打包。请检查网络后重试 npm run prepare:sdk-runtime。' + (error.message ? '\n' + error.message : ''), { cause: error });
  } finally { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
module.exports = { ensureRuntime, descriptor, installed };
if (require.main === module) ensureRuntime().then(result => console.log(`Linux SDK ${result.version} ${result.changed ? '已准备' : '已存在，离线复用'}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
