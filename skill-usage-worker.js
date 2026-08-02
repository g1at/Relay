'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 2;
const MEMORY_ROOT = workerData.memoryDir ? path.resolve(String(workerData.memoryDir)) : '';
const CORRECTION_RE = /(不对|不是(?:这个|这样|我的意思)|我说的是|你理解错|搞错了|别再|不要再|怎么又|应该改成|应该是|重新来|并没有|仍然不对|还是不对|that'?s not what i meant|you misunderstood|not like that)/i;
const POSITIVE_RE = /(可以了|这次对了|这样就对了|很好|搞定了|谢谢|正是这样|works now|that works|perfect)/i;

function emptySkillStats() {
  return {
    useCount: 0, lastUsedAt: null,
    feedbackOpportunities: 0, correctionCount: 0, retryCount: 0,
    toolErrorCount: 0, positiveCount: 0, lastNegativeAt: null,
  };
}

function statsArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    const value = emptySkillStats();
    for (const key of ['useCount', 'feedbackOpportunities', 'correctionCount', 'retryCount', 'toolErrorCount', 'positiveCount']) {
      value[key] = Math.max(0, Number(item[key]) || 0);
    }
    value.lastUsedAt = typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null;
    value.lastNegativeAt = typeof item.lastNegativeAt === 'string' ? item.lastNegativeAt : null;
    map.set(item.name, value);
  }
  return map;
}

function statsMapToArray(map) {
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      ...emptySkillStats(),
      ...value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bumpSkillUse(map, name, timestamp) {
  const current = map.get(name) || emptySkillStats();
  current.useCount += 1;
  if (timestamp && (!current.lastUsedAt || timestamp > current.lastUsedAt)) {
    current.lastUsedAt = timestamp;
  }
  map.set(name, current);
}

function bumpSkillSignal(map, names, field, timestamp) {
  for (const name of new Set(Array.isArray(names) ? names : [])) {
    if (!name) continue;
    const current = map.get(name) || emptySkillStats();
    current[field] = Math.max(0, Number(current[field]) || 0) + 1;
    if (field === 'correctionCount' || field === 'retryCount' || field === 'toolErrorCount') {
      if (timestamp && (!current.lastNegativeAt || timestamp > current.lastNegativeAt)) current.lastNegativeAt = timestamp;
    }
    map.set(name, current);
  }
}

function statsMemoryArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    map.set(item.name, {
      readCount: Math.max(0, Number(item.readCount) || 0),
      lastReadAt: typeof item.lastReadAt === 'string' ? item.lastReadAt : null,
    });
  }
  return map;
}

function memoryMapToArray(map) {
  return [...map.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => a.name.localeCompare(b.name));
}

function bumpMemoryRead(map, name, timestamp) {
  const current = map.get(name) || { readCount: 0, lastReadAt: null };
  current.readCount += 1;
  if (timestamp && (!current.lastReadAt || timestamp > current.lastReadAt)) current.lastReadAt = timestamp;
  map.set(name, current);
}

function memoryFileFromInput(input) {
  if (!MEMORY_ROOT) return null;
  const candidate = input && (input.file_path || input.path);
  if (typeof candidate !== 'string' || !candidate) return null;
  let abs;
  try { abs = path.resolve(candidate); } catch (_) { return null; }
  const rel = path.relative(MEMORY_ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !rel.toLowerCase().endsWith('.md')) return null;
  const base = path.basename(rel);
  return base.toLowerCase() === 'memory.md' ? null : base;
}

function normalizeUserText(value) {
  let text = String(value || '');
  const taskMarker = '用户的任务：\n';
  if (text.includes(taskMarker)) text = text.slice(text.lastIndexOf(taskMarker) + taskMarker.length);
  // Relay 会在真实用户输入后追加运行须知、图片规则、飞书提示和长期记忆。
  // 这些固定文本若参与相似度计算，会让两条毫不相关的请求看起来高度相似。
  for (const marker of [
    '\n\n---\n用户上传了以下文件',
    '\n\n---\n[交互须知]',
    '\n\n---\n[图片处理须知]',
    '\n\n---\n[系统提示]',
    '\n\n---\n[长期记忆]',
  ]) {
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(0, at);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

function textSimilarity(a, b) {
  const clean = (value) => String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9\u3400-\u9fff]/g, '');
  const left = clean(a), right = clean(b);
  if (left.length < 12 || right.length < 12) return 0;
  const grams = (value) => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
    return set;
  };
  const x = grams(left), y = grams(right);
  let hit = 0;
  for (const token of x) if (y.has(token)) hit++;
  return hit / Math.max(1, x.size + y.size - hit);
}

function textBlocks(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n');
}

function scanJsonlText(text, skillStats, memoryStats, context) {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let data;
    try { data = JSON.parse(line); } catch (_) { continue; }
    const message = data && data.message;
    const blocks = message && Array.isArray(message.content) ? message.content : null;
    if (!blocks) continue;
    const timestamp = typeof data.timestamp === 'string' ? data.timestamp : null;
    for (const block of blocks) {
      if (block && block.type === 'tool_use' && block.name === 'Skill') {
        const skill = block.input && block.input.skill;
        if (typeof skill === 'string' && skill) {
          bumpSkillUse(skillStats, skill, timestamp);
          if (!context.activeSkills.includes(skill)) context.activeSkills.push(skill);
        }
      }
      if (block && block.type === 'tool_use' && block.name === 'Read') {
        const file = memoryFileFromInput(block.input);
        if (file) bumpMemoryRead(memoryStats, file, timestamp);
      }
    }

    const role = message.role || data.type;
    if (role !== 'user') continue;
    const toolErrors = blocks.filter((block) => block && block.type === 'tool_result' && block.is_error);
    if (toolErrors.length && context.activeSkills.length) {
      for (let i = 0; i < toolErrors.length; i++) bumpSkillSignal(skillStats, context.activeSkills, 'toolErrorCount', timestamp);
    }
    const userText = normalizeUserText(textBlocks(blocks));
    if (!userText) continue; // tool_result 不是新一轮用户反馈
    if (context.activeSkills.length) {
      bumpSkillSignal(skillStats, context.activeSkills, 'feedbackOpportunities', timestamp);
      if (CORRECTION_RE.test(userText)) bumpSkillSignal(skillStats, context.activeSkills, 'correctionCount', timestamp);
      if (textSimilarity(userText, context.lastUserText) >= 0.72) bumpSkillSignal(skillStats, context.activeSkills, 'retryCount', timestamp);
      if (POSITIVE_RE.test(userText)) bumpSkillSignal(skillStats, context.activeSkills, 'positiveCount', timestamp);
    }
    context.activeSkills = [];
    context.lastUserText = userText;
  }
}

async function collectJsonlFiles(root) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  await walk(root);
  files.sort();
  return files;
}

async function readRange(file, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return Buffer.alloc(0);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, start + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

function parseCompleteBuffer(buffer, skillStats, memoryStats, context) {
  if (!buffer.length) return 0;
  const lastNewline = buffer.lastIndexOf(0x0a);
  let consumed = lastNewline >= 0 ? lastNewline + 1 : 0;

  if (consumed > 0) scanJsonlText(buffer.subarray(0, consumed).toString('utf8'), skillStats, memoryStats, context);

  // Claude 的 JSONL 通常以换行结束。若最后一行已经是完整 JSON，也立即纳入；
  // 若仍在写入则保留 offset，下一次从这行开头继续读取。
  if (consumed < buffer.length) {
    const tail = buffer.subarray(consumed).toString('utf8');
    try {
      JSON.parse(tail);
      scanJsonlText(tail, skillStats, memoryStats, context);
      consumed = buffer.length;
    } catch (_) {}
  }
  return consumed;
}

async function scan() {
  const projectsRoot = String(workerData.projectsRoot || '');
  const previous = workerData.previous && workerData.previous.version === INDEX_VERSION
    ? workerData.previous
    : { version: INDEX_VERSION, files: {} };
  const previousFiles = previous.files && typeof previous.files === 'object' ? previous.files : {};
  const nextFiles = Object.create(null);
  const targets = await collectJsonlFiles(projectsRoot);
  let changed = previous.version !== INDEX_VERSION;
  let scannedFiles = 0;
  let scannedBytes = 0;

  for (const file of targets) {
    const relative = path.relative(projectsRoot, file);
    let stat;
    try { stat = await fs.promises.stat(file); } catch (_) { continue; }
    const old = previousFiles[relative];
    const same = old
      && Number(old.size) === stat.size
      && Math.round(Number(old.mtimeMs) || 0) === Math.round(stat.mtimeMs);
    if (same) {
      nextFiles[relative] = old;
      continue;
    }

    changed = true;
    scannedFiles += 1;
    const canAppend = old
      && stat.size > Number(old.size)
      && Number(old.offset) >= 0
      && Number(old.offset) <= Number(old.size);
    const start = canAppend ? Number(old.offset) : 0;
    const skillStats = canAppend ? statsArrayToMap(old.skills) : new Map();
    const memoryStats = canAppend ? statsMemoryArrayToMap(old.memories) : new Map();
    const context = canAppend && old.context && typeof old.context === 'object'
      ? {
          lastUserText: String(old.context.lastUserText || ''),
          activeSkills: Array.isArray(old.context.activeSkills) ? [...old.context.activeSkills] : [],
        }
      : { lastUserText: '', activeSkills: [] };
    let buffer;
    try { buffer = await readRange(file, start, stat.size); } catch (_) { continue; }
    scannedBytes += buffer.length;
    const consumed = parseCompleteBuffer(buffer, skillStats, memoryStats, context);
    nextFiles[relative] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: start + consumed,
      skills: statsMapToArray(skillStats),
      memories: memoryMapToArray(memoryStats),
      context,
    };
  }

  if (!changed) {
    const previousNames = Object.keys(previousFiles);
    changed = previousNames.length !== Object.keys(nextFiles).length
      || previousNames.some((name) => !nextFiles[name]);
  }

  const aggregate = new Map();
  for (const record of Object.values(nextFiles)) {
    for (const item of Array.isArray(record.skills) ? record.skills : []) {
      const current = aggregate.get(item.name) || emptySkillStats();
      for (const key of ['useCount', 'feedbackOpportunities', 'correctionCount', 'retryCount', 'toolErrorCount', 'positiveCount']) {
        current[key] += Number(item[key]) || 0;
      }
      if (item.lastUsedAt && (!current.lastUsedAt || item.lastUsedAt > current.lastUsedAt)) {
        current.lastUsedAt = item.lastUsedAt;
      }
      if (item.lastNegativeAt && (!current.lastNegativeAt || item.lastNegativeAt > current.lastNegativeAt)) {
        current.lastNegativeAt = item.lastNegativeAt;
      }
      aggregate.set(item.name, current);
    }
  }

  const memoryAggregate = new Map();
  for (const record of Object.values(nextFiles)) {
    for (const item of Array.isArray(record.memories) ? record.memories : []) {
      const current = memoryAggregate.get(item.name) || { readCount: 0, lastReadAt: null };
      current.readCount += Number(item.readCount) || 0;
      if (item.lastReadAt && (!current.lastReadAt || item.lastReadAt > current.lastReadAt)) current.lastReadAt = item.lastReadAt;
      memoryAggregate.set(item.name, current);
    }
  }

  return {
    index: {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      files: nextFiles,
      skills: statsMapToArray(aggregate),
      memories: memoryMapToArray(memoryAggregate),
    },
    changed,
    totalFiles: targets.length,
    scannedFiles,
    scannedBytes,
  };
}

scan()
  .then((result) => parentPort.postMessage({ ok: true, ...result }))
  .catch((error) => parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error) }));
