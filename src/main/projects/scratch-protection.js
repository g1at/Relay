'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { localFileLinks, locationKey, isWithinLocation } = require('../tasks/task-file-links');

const MAX_CLEANUP_HISTORY_BYTES = 32 * 1024 * 1024;
async function readConversationForCleanup(file, { maxBytes = MAX_CLEANUP_HISTORY_BYTES } = {}) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('会话历史不是普通文件，暂不能检查成果引用'), { code: 'CLEANUP_HISTORY_INVALID' });
    if (stat.size > maxBytes) throw Object.assign(new Error('会话历史过大，暂不能完整检查成果引用，已保留临时文件'), { code: 'CLEANUP_HISTORY_TOO_LARGE' });
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read > stat.size) throw Object.assign(new Error('检查时会话历史发生变化，请稍后重试'), { code: 'CLEANUP_HISTORY_CHANGED' });
    const conversation = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)
      || conversation.turns != null && !Array.isArray(conversation.turns)) {
      throw Object.assign(new Error('会话历史格式无效，暂不能检查成果引用'), { code: 'CLEANUP_HISTORY_INVALID' });
    }
    return conversation;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (handle) await handle.close(); }
}

function protectedCleanup(reason, message, details = {}, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'SCRATCH_CLEANUP_PROTECTED', protectionReason: reason, ...details,
  });
}
function nativeLocation(value) {
  if (process.platform === 'win32') {
    const mounted = /^\/mnt\/([a-z])(?:\/|$)/i.exec(value);
    if (mounted) return mounted[1] + ':\\' + value.slice(mounted[0].length).replace(/\//g, '\\');
    return /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value) && path.win32.isAbsolute(value) ? value : null;
  }
  const drive = /^([a-z]):[\\/]/i.exec(value);
  if (drive) return '/mnt/' + drive[1].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/');
  return path.posix.isAbsolute(value) && !value.startsWith('//') ? value : null;
}
function locationVariants(value) {
  const found = [value], native = nativeLocation(value);
  if (!native) return found;
  // Resolve the nearest existing ancestor too: an output may reference a child
  // not yet present below a directory alias, without requiring that file to exist.
  let current = path.resolve(native);
  const suffix = [];
  while (true) {
    try { found.push(path.join(fs.realpathSync(current), ...suffix)); break; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
  return [...new Map(found.map(item => [locationKey(item), item])).values()];
}
function finalText(turn) {
  if (!turn || typeof turn !== 'object') return '';
  if (turn.running || turn.streaming || turn.isStreaming || turn.status && !['complete', 'completed', 'success'].includes(turn.status)) return '';
  if (turn.output && typeof turn.output === 'object') {
    // A modern empty final is authoritative. Its assistant field can still be
    // an interrupted draft, so never fall back to it.
    if (turn.output.status && !['complete', 'completed', 'success'].includes(turn.output.status)) return '';
    return typeof turn.output.final === 'string' ? turn.output.final : '';
  }
  return typeof turn.assistant === 'string' ? turn.assistant : '';
}

function finalFileMessages(conversation) {
  return Array.isArray(conversation?.turns) ? conversation.turns.map(finalText).filter(Boolean) : [];
}
function existingLinkTarget(value) {
  const native = nativeLocation(value);
  if (!native) throw new Error('无法访问交付文件所在路径');
  try { fs.lstatSync(native); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function assertScratchCleanupAllowed({ id, directories, records, loadConversation }) {
  let owner = id;
  try {
    const roots = directories.filter(value => typeof value === 'string' && value).flatMap(locationVariants);
    if (!roots.length) return;
    const entries = Object.entries(records);
    if (!Object.prototype.hasOwnProperty.call(records, id)) entries.push([id, {}]);
    let scanned = 0;
    for (const [conversationId, item] of entries) {
      // Even injected in-memory readers must not make a large registry scan one
      // uninterrupted UI-blocking task. No old results are cached.
      if (++scanned % 16 === 0) await new Promise(resolve => setImmediate(resolve));
      owner = conversationId;
      if (typeof item.outputDir === 'string' && item.outputDir) {
        // Project output roots can contain an intentionally nested scratch. Only
        // a scratch that would remove the registered root itself is forbidden.
        const output = locationVariants(item.outputDir);
        if (output.some(file => roots.some(root => isWithinLocation(file, root)))) {
          throw protectedCleanup('output_directory', '临时目录覆盖了已登记的成果目录，已保留文件和历史。请先调整成果目录后重试。', { conversationId, protectedPath: item.outputDir });
        }
      }
      const conversation = await loadConversation(conversationId);
      if (!conversation) continue;
      const cwd = item.cwd || (typeof conversation.workingDir === 'string' ? conversation.workingDir : conversation.workingDir?.path);
      for (const message of finalFileMessages(conversation)) {
        for (const file of localFileLinks(message, cwd)) {
          if (locationVariants(file).some(candidate => roots.some(root => isWithinLocation(candidate, root) || isWithinLocation(root, candidate))) && existingLinkTarget(file)) {
            throw protectedCleanup('final_output_reference', '临时目录仍被已交付文件链接引用，已保留文件和历史。请先检查该路径，将成果移出临时目录并更新交付链接，再重试：' + file, { conversationId, protectedPath: file });
          }
        }
      }
    }
  } catch (error) {
    if (error.code === 'SCRATCH_CLEANUP_PROTECTED') throw error;
    throw protectedCleanup('check_unavailable', error.code === 'CLEANUP_HISTORY_TOO_LARGE'
      ? '会话历史超过32 MiB，暂不能完整检查成果引用，已保留文件和历史。请先检查相关会话文件。'
      : '无法完整检查成果引用，已保留文件和历史。请检查相关会话和目录后重试。', { conversationId: owner }, error);
  }
}

module.exports = { assertScratchCleanupAllowed, finalFileMessages, finalText, locationVariants, readConversationForCleanup, MAX_CLEANUP_HISTORY_BYTES };
