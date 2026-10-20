'use strict';
const fs = require('node:fs');
const path = require('node:path');
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
function canceledResult() { return { ok: true, items: [], canceled: true }; }
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(':'); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function text(value) { return value ? String(value) : ''; }
function detached(value) { const source = text(value); return source ? Buffer.from(source, 'utf16le').toString('utf16le') : ''; }
function compactSchedule(value) {
  if (typeof value === 'string') return detached(value.slice(0, 256));
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['id', 'scheduleId', 'taskId', 'title', 'name', 'type']) if (typeof value[key] === 'string') result[key] = detached(value[key].slice(0, 256));
  return result;
}
function savedAssistant(turn) {
  if (turn?.output && typeof turn.output === 'object' && Object.prototype.hasOwnProperty.call(turn.output, 'final')) {
    return turn.output.status === 'complete' && typeof turn.output.final === 'string' ? turn.output.final : '';
  }
  if (!turn?.output && Array.isArray(turn?.chat) && turn.chat.length) return '';
  return turn?.assistant;
}
function makeSnippet(value, query) {
  const source = text(value), index = source.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 30), end = Math.min(source.length, index + query.length + 30);
  const pattern = new RegExp(query.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'), 'gi');
  return (start ? '…' : '') + source.slice(start, end).replace(pattern, match => '\x00' + match + '\x01') + (end < source.length ? '…' : '');
}
function createHistorySearchCore({ historyDir, cacheMaxBytes = DEFAULT_CACHE_BYTES, fileSystem = fs } = {}) {
  if (typeof historyDir !== 'string' || !path.isAbsolute(historyDir)) throw new TypeError('搜索历史目录必须是绝对路径');
  const io = fileSystem.promises, cache = new Map();
  const budget = Number.isFinite(cacheMaxBytes) ? Math.max(0, cacheMaxBytes) : DEFAULT_CACHE_BYTES;
  let cacheBytes = 0;
  const stats = { bodyReads: 0, bodyBytes: 0, cacheHits: 0, projections: 0, evictions: 0 };
  function forget(file) { const old = cache.get(file); if (old) { cacheBytes -= old.bytes; cache.delete(file); } }
  async function fileStamp(file) {
    const stat = await io.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('HISTORY_SEARCH_NOT_FILE', '历史不是普通文件');
    return identity(stat);
  }
  async function indexSnapshot() {
    const file = path.join(historyDir, 'index.json');
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await fileStamp(file), raw = await io.readFile(file, 'utf8'), after = await fileStamp(file);
      if (before !== after) continue;
      const saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.items)) throw failure('HISTORY_SEARCH_INDEX_INVALID', '历史索引格式无效');
      const ids = new Set(), items = []; let skipped = 0;
      for (const item of saved.items) {
        if (!item || typeof item.id !== 'string' || !VALID_ID.test(item.id) || item.id.toLowerCase() === 'index' || ids.has(item.id)) { skipped++; continue; }
        ids.add(item.id); items.push(item);
      }
      items.sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
      const activeFiles = new Set(items.map(item => path.join(historyDir, item.id + '.json')));
      for (const file of cache.keys()) if (!activeFiles.has(file)) forget(file);
      const contentSignature = JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id,
        typeof item.title === 'string' ? item.title : '', text(item.kind), text(item.mode), compactSchedule(item.fromScheduled)]));
      const orderSignature = JSON.stringify(items.map(item => item.id));
      return { stamp: after, items, skipped, contentSignature, orderSignature };
    }
    throw failure('HISTORY_SEARCH_INDEX_CHANGED', '历史索引正在更新，请重试');
  }
  async function projection(file, id, isCanceled) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stamp = await fileStamp(file), hit = cache.get(file);
      if (hit?.stamp === stamp) { cache.delete(file); cache.set(file, hit); stats.cacheHits++; return { value: hit.value, stamp }; }
      forget(file); if (isCanceled()) return null;
      const raw = await io.readFile(file, 'utf8'); stats.bodyReads++; stats.bodyBytes += Buffer.byteLength(raw, 'utf8');
      if (isCanceled()) return null;
      const document = JSON.parse(raw);
      if (!document || document.id !== id || document.turns != null && !Array.isArray(document.turns)) throw failure('HISTORY_SEARCH_DOCUMENT_INVALID', '历史内容与索引不一致');
      const value = { title: detached(document.title), kind: detached(text(document.kind || 'chat').slice(0, 32)), mode: detached(text(document.mode || 'plain').slice(0, 32)),
        fromScheduled: compactSchedule(document.fromScheduled), updatedAt: detached(text(document.updatedAt || document.createdAt).slice(0, 64)), turns: [] };
      let bytes = 2048 + 2 * JSON.stringify(value.fromScheduled).length + 2 * (id.length + value.title.length + value.kind.length + value.mode.length + value.updatedAt.length);
      for (let index = 0; index < (document.turns || []).length; index++) {
        if (index % 64 === 0) { await yieldTurn(); if (isCanceled()) return null; }
        const turn = document.turns[index];
        const fields = value.kind === 'create' ? [['prompt', turn?.prompt]] : [['user', turn?.user], ['assistant', savedAssistant(turn)]];
        const saved = [];
        for (const [side, field] of fields) { const fieldText = detached(field); if (fieldText) { saved.push({ side, text: fieldText }); bytes += 96 + fieldText.length * 2; } }
        if (saved.length) { value.turns.push({ index, fields: saved }); bytes += 64; }
      }
      const after = await fileStamp(file); if (stamp !== after) continue;
      stats.projections++;
      if (bytes <= budget) {
        while (cache.size && cacheBytes + bytes > budget) { forget(cache.keys().next().value); stats.evictions++; }
        cache.set(file, { value, stamp, bytes }); cacheBytes += bytes;
      }
      return { value, stamp };
    }
    throw failure('HISTORY_SEARCH_DOCUMENT_CHANGED', '历史内容正在更新');
  }
  async function match(value, meta, query, isCanceled) {
    const title = value.title;
    let snippet = makeSnippet(title, query), matchField = snippet ? 'title' : null, turnIndex = null, matchSide = null;
    if (!snippet) {
      let visited = 0;
      for (const turn of value.turns) {
        if (++visited % 64 === 0) { await yieldTurn(); if (isCanceled()) return null; }
        for (const field of turn.fields) {
          snippet = makeSnippet(field.text, query);
          if (snippet) { matchField = 'body'; turnIndex = turn.index; matchSide = field.side; break; }
        }
        if (snippet) break;
      }
    }
    return snippet ? { id: meta.id, title: (title || '未命名').slice(0, 256), kind: value.kind, mode: value.mode,
      fromScheduled: value.fromScheduled, updatedAt: text(meta.updatedAt || value.updatedAt).slice(0, 64),
      snippet, matchField, turnIndex, matchSide } : null;
  }
  async function search({ query, limit, isCanceled = () => false } = {}) {
    const q = text(query).trim(), cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    if (isCanceled()) return canceledResult();
    if (!q) return { ok: true, items: [] };
    if (q.length > 512) return { ok: false, items: [], code: 'HISTORY_SEARCH_QUERY_TOO_LONG', error: '搜索内容过长，请缩短后重试。' };
    try {
      for (let pass = 0; pass < 2; pass++) {
        const index = await indexSnapshot(), matches = []; let skipped = index.skipped, scanned = 0;
        for (const meta of index.items) {
          await yieldTurn(); if (isCanceled()) return canceledResult();
          scanned++;
          const file = path.join(historyDir, meta.id + '.json');
          try {
            const projected = await projection(file, meta.id, isCanceled);
            if (isCanceled()) return canceledResult();
            const item = await match(projected.value, meta, q, isCanceled);
            if (item) matches.push({ item, file, stamp: projected.stamp });
          } catch (_) { forget(file); skipped++; }
          if (matches.length >= cap) break;
        }
        if (isCanceled()) return canceledResult();
        const fresh = await indexSnapshot();
        const metadataChanged = fresh.contentSignature !== index.contentSignature;
        const orderChanged = fresh.orderSignature !== index.orderSignature;
        let changed = metadataChanged;
        const current = new Map(fresh.items.map((item, index) => [item.id, { item, index }])), verified = [];
        for (const found of matches) {
          if (!current.has(found.item.id)) { changed = true; continue; }
          try { if (await fileStamp(found.file) !== found.stamp) { changed = true; forget(found.file); continue; } }
          catch (_) { changed = true; forget(found.file); continue; }
          // Title/body matching came from the verified saved projection. Index
          // rewrites cannot invent a title hit or restore a withdrawn draft.
          verified.push({ ...found.item, updatedAt: text(current.get(found.item.id).item.updatedAt || found.item.updatedAt).slice(0, 64) });
        }
        if (isCanceled()) return canceledResult();
        if (changed && pass === 0) continue;
        verified.sort((a, b) => current.get(a.id).index - current.get(b.id).index);
        const incomplete = changed || orderChanged && scanned < index.items.length;
        return { ok: true, items: verified, ...(skipped || incomplete ? { partial: true, skipped,
          warning: incomplete ? '搜索期间历史仍在更新，结果可能不完整。' : '部分历史暂时无法读取，结果可能不完整。' } : {}) };

      }
    } catch (_) {
      if (isCanceled()) return canceledResult();
      return { ok: false, items: [], code: 'HISTORY_SEARCH_INDEX_UNAVAILABLE', error: '无法读取历史索引，请稍后重试。' };
    }
  }
  return { search, diagnostics: () => ({ ...stats, cacheEntries: cache.size, cacheBytes, cacheMaxBytes: budget }) };
}
module.exports = { createHistorySearchCore, makeSnippet, savedAssistant, DEFAULT_CACHE_BYTES };
