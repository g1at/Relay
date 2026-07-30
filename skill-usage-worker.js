'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;

function statsArrayToMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    map.set(item.name, {
      useCount: Math.max(0, Number(item.useCount) || 0),
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
    });
  }
  return map;
}

function statsMapToArray(map) {
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      useCount: value.useCount || 0,
      lastUsedAt: value.lastUsedAt || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bump(map, name, timestamp) {
  const current = map.get(name) || { useCount: 0, lastUsedAt: null };
  current.useCount += 1;
  if (timestamp && (!current.lastUsedAt || timestamp > current.lastUsedAt)) {
    current.lastUsedAt = timestamp;
  }
  map.set(name, current);
}

function scanJsonlText(text, stats) {
  for (const line of String(text || '').split('\n')) {
    if (line.indexOf('"Skill"') < 0) continue;
    let data;
    try { data = JSON.parse(line); } catch (_) { continue; }
    const message = data && data.message;
    const blocks = message && Array.isArray(message.content) ? message.content : null;
    if (!blocks) continue;
    const timestamp = typeof data.timestamp === 'string' ? data.timestamp : null;
    for (const block of blocks) {
      if (block && block.type === 'tool_use' && block.name === 'Skill') {
        const skill = block.input && block.input.skill;
        if (typeof skill === 'string' && skill) bump(stats, skill, timestamp);
      }
    }
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

function parseCompleteBuffer(buffer, stats) {
  if (!buffer.length) return 0;
  const lastNewline = buffer.lastIndexOf(0x0a);
  let consumed = lastNewline >= 0 ? lastNewline + 1 : 0;

  if (consumed > 0) scanJsonlText(buffer.subarray(0, consumed).toString('utf8'), stats);

  // Claude 的 JSONL 通常以换行结束。若最后一行已经是完整 JSON，也立即纳入；
  // 若仍在写入则保留 offset，下一次从这行开头继续读取。
  if (consumed < buffer.length) {
    const tail = buffer.subarray(consumed).toString('utf8');
    try {
      JSON.parse(tail);
      scanJsonlText(tail, stats);
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
    const stats = canAppend ? statsArrayToMap(old.skills) : new Map();
    let buffer;
    try { buffer = await readRange(file, start, stat.size); } catch (_) { continue; }
    scannedBytes += buffer.length;
    const consumed = parseCompleteBuffer(buffer, stats);
    nextFiles[relative] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: start + consumed,
      skills: statsMapToArray(stats),
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
      const current = aggregate.get(item.name) || { useCount: 0, lastUsedAt: null };
      current.useCount += Number(item.useCount) || 0;
      if (item.lastUsedAt && (!current.lastUsedAt || item.lastUsedAt > current.lastUsedAt)) {
        current.lastUsedAt = item.lastUsedAt;
      }
      aggregate.set(item.name, current);
    }
  }

  return {
    index: {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      files: nextFiles,
      skills: statsMapToArray(aggregate),
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
