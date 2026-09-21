'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { toWslPath } = require('./agent-environment');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function snapshotAttachments(files) {
  return (Array.isArray(files) ? files : []).slice(0, 32).filter(file => file
    && typeof file.path === 'string' && file.path.length < 32768 && !/[\0\r\n]/.test(file.path)
    && (path.win32.isAbsolute(file.path) || path.posix.isAbsolute(file.path)))
    .map(file => ({ path: file.path, isDirectory: !!(file.isDirectory || file.ext === 'folder') }));
}

function imageMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function prepareAttachmentContent(prompt, files, { environment = 'native', fileSystem = fs.promises } = {}) {
  const attachments = snapshotAttachments(files);
  const content = [{ type: 'text', text: String(prompt || (attachments.length ? '请查看我上传的文件。' : '')) }];
  if (!attachments.length) return content;
  const lines = [], images = [];
  let totalBytes = 0;
  for (const file of attachments) {
    let agentPath = file.path, hostOnly = false;
    if (environment === 'wsl') {
      try { agentPath = toWslPath(file.path); } catch (_) { hostOnly = true; }
    }
    let embedded = false, imageIssue = '';
    if (!file.isDirectory && IMAGE_EXTENSIONS.has(path.extname(file.path).toLowerCase())) {
      try {
        // Read on the host before crossing the SDK/WSL boundary. A mounted
        // Windows drive can fail even while Electron can read the attachment.
        const stat = await fileSystem.stat(file.path);
        imageIssue = '图片超过本轮直接附图限制或不是可读取的普通文件，请按路径读取';
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_IMAGE_BYTES && totalBytes + stat.size <= MAX_TOTAL_IMAGE_BYTES) {
          const bytes = await fileSystem.readFile(file.path);
          const mediaType = imageMediaType(bytes);
          imageIssue = '图片格式无效或读取期间大小发生变化，请按路径核对';
          if (mediaType && bytes.length <= MAX_IMAGE_BYTES && totalBytes + bytes.length <= MAX_TOTAL_IMAGE_BYTES) {
            images.push({ type: 'text', text: `用户上传的图片：${agentPath}` },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
            totalBytes += bytes.length;
            embedded = true;
            imageIssue = '';
          }
        }
      } catch (_) { imageIssue = '宿主未能读取图片内容，请按路径核对文件是否存在及可读'; }
    }
    lines.push(`- ${agentPath}${embedded ? '（图片内容已随本条消息附上，请直接查看）' : ''}${imageIssue ? `（${imageIssue}）` : ''}${hostOnly ? '（Windows 宿主路径，当前 WSL 不支持直接访问此路径）' : ''}`);
  }
  content[0].text += '\n\n---\n用户添加了以下文件或文件夹（绝对路径，不改变当前工作目录）。' +
    '已随消息附上的图片请直接查看，无需再次 Read；其余文件用 Read 读取，文件夹先用 Glob/Grep 按需查找后读取：\n' + lines.join('\n');
  return content.concat(images);
}

function stripAttachmentImageData(event) {
  const blocks = event && event.message && event.message.content;
  if (!Array.isArray(blocks)) return event;
  let changed = false;
  function strip(block) {
    if (block && block.type === 'image' && block.source && block.source.type === 'base64') {
      changed = true;
      return { type: 'text', text: '[用户图片附件内容已省略]' };
    }
    if (block && block.type === 'tool_result' && Array.isArray(block.content)) {
      const content = block.content.map(strip);
      if (content.some((item, index) => item !== block.content[index])) return { ...block, content };
    }
    return block;
  }
  const content = blocks.map(strip);
  return changed ? { ...event, message: { ...event.message, content } } : event;
}

module.exports = { snapshotAttachments, prepareAttachmentContent, stripAttachmentImageData, imageMediaType, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };
