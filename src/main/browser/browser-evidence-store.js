'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const queues = new Map();
function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
async function location(context, create = false) {
  if (!context?.conversationId || typeof context.workspaceRoot !== 'string' || !path.isAbsolute(context.workspaceRoot)) throw new Error('任务没有本机证据目录');
  const root = await fs.realpath(context.workspaceRoot);
  const folder = path.join(root, '.relay', 'browser-evidence');
  if (create) {
    // Validate each existing ancestor before creating children below it.
    let parent = root;
    for (const part of ['.relay', 'browser-evidence']) {
      const next = path.join(parent, part);
      try { await fs.mkdir(next); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      parent = await fs.realpath(next);
      if (!within(root, parent)) throw new Error('证据目录不能指向任务目录外');
    }
  }
  const actual = await fs.realpath(folder);
  if (!within(root, actual)) throw new Error('证据目录不能指向任务目录外');
  const key = createHash('sha256').update(context.conversationId).digest('hex').slice(0, 32);
  return { folder: actual, manifest: path.join(actual, key + '.json') };
}
async function readAt(manifest) {
  try {
    const stat = await fs.lstat(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return [];
    const parsed = JSON.parse(await fs.readFile(manifest, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object').slice(-200) : [];
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
}
async function readEvidence(context) {
  try { const { manifest } = await location(context); return await readAt(manifest); }
  catch (_) { return []; }
}
async function appendEvidence(context, record) {
  const { manifest } = await location(context, true);
  const pending = (queues.get(manifest) || Promise.resolve()).catch(() => {}).then(async () => {
    const records = await readAt(manifest);
    records.push(record);
    const temp = manifest + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(records.slice(-200)), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, manifest); }
    finally { await fs.unlink(temp).catch(() => {}); }
  });
  queues.set(manifest, pending);
  try { await pending; } finally { if (queues.get(manifest) === pending) queues.delete(manifest); }
}
async function saveScreenshot(context, result) {
  const { folder } = await location(context, true);
  const bytes = Buffer.from(result.data, 'base64');
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('截图大小超过证据存储限制');
  const id = randomUUID(), filename = `screenshot-${id}.png`, file = path.join(folder, filename);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const artifact = { id, kind: 'screenshot', path: file, filename, mimeType: 'image/png', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), completedAt: new Date().toISOString(), url: result.url || '' };
  try { await appendEvidence(context, artifact); }
  catch (_) { artifact.evidenceWarning = '截图文件已保存，但证据索引写入失败；请保留此文件路径'; }
  return artifact;
}
module.exports = { readEvidence, appendEvidence, saveScreenshot };
