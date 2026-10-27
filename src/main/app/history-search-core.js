'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SearchText = require('../../../renderer/history-search-text');
const { createLegacyOutputRecovery } = require('../projects/legacy-output-recovery');
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const INDEX_TEMP = /^\.([a-z0-9][a-z0-9_-]{0,127})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const SEARCH_INDEX_VERSION = 2;
const SCAN_CONCURRENCY = 4;
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
const savedAssistant = SearchText.savedAssistant;
const makeSnippet = SearchText.snippet;
function createHistorySearchCore({ historyDir, cacheMaxBytes = DEFAULT_CACHE_BYTES, fileSystem = fs } = {}) {
  if (typeof historyDir !== 'string' || !path.isAbsolute(historyDir)) throw new TypeError('搜索历史目录必须是绝对路径');
  const io = fileSystem.promises, cache = new Map(), indexDir = path.join(historyDir, '.search-index');
  // Reuse the load-time evidence checks for saved empty finals. No rootDir is
  // supplied: search never opens task journals or promotes process/tool text.
  const recoverSnapshot = createLegacyOutputRecovery({ fileSystem });
  const budget = Number.isFinite(cacheMaxBytes) ? Math.max(0, cacheMaxBytes) : DEFAULT_CACHE_BYTES;
  let cacheBytes = 0;
  const stats = { bodyReads: 0, bodyBytes: 0, cacheHits: 0, projections: 0, evictions: 0,
    indexReads: 0, indexHits: 0, indexWrites: 0, indexWriteFailures: 0 };
  function forget(file) { const old = cache.get(file); if (old) { cacheBytes -= old.bytes; cache.delete(file); } }
  async function fileStamp(file) {
    const stat = await io.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('HISTORY_SEARCH_NOT_FILE', '历史不是普通文件');
    return identity(stat);
  }
  async function indexDirectory(create = false) {
    if (create) await io.mkdir(indexDir, { recursive: true });
    const stat = await io.lstat(indexDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('HISTORY_SEARCH_INDEX_UNSAFE', '搜索缓存目录不可用');
  }
  async function pruneIndexes(ids) {
    try {
      await indexDirectory();
      const names = await io.readdir(indexDir, { withFileTypes: true });
      await Promise.all(names.filter(entry => {
        if (!entry.isFile()) return false;
        const owner = INDEX_TEMP.exec(entry.name)?.[1]
          || (entry.name.endsWith('.json') && VALID_ID.test(entry.name.slice(0, -5)) ? entry.name.slice(0, -5) : null);
        return owner && !ids.has(owner);
      })
        .map(entry => io.unlink(path.join(indexDir, entry.name)).catch(() => {})));
    } catch (_) { /* A missing or unwritable derived cache cannot disable search. */ }
  }
  function validProjection(value) {
    if (!value || typeof value.title !== 'string' || typeof value.titleText !== 'string' || typeof value.titleNormalized !== 'string'
      || typeof value.kind !== 'string' || typeof value.mode !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.turns)
      || !Object.hasOwn(value, 'fromScheduled') || JSON.stringify(compactSchedule(value.fromScheduled)) !== JSON.stringify(value.fromScheduled)) return false;
    return value.turns.every(turn => Number.isSafeInteger(turn.index) && turn.index >= 0
      && (turn.turnId === null || typeof turn.turnId === 'string') && Array.isArray(turn.fields)
      && turn.fields.every(field => ['user', 'assistant', 'prompt'].includes(field.side)
        && typeof field.text === 'string' && typeof field.normalized === 'string'
        && (field.messageKey === null || typeof field.messageKey === 'string')));
  }
  function projectionBytes(value, id) {
    let bytes = 2048 + 2 * JSON.stringify(value.fromScheduled).length
      + 2 * (id.length + value.title.length + value.titleText.length + value.titleNormalized.length + value.kind.length + value.mode.length + value.updatedAt.length);
    for (const turn of value.turns) {
      bytes += 64 + 2 * (turn.turnId?.length || 0);
      for (const field of turn.fields) bytes += 96 + 2 * (field.text.length + field.normalized.length + (field.messageKey?.length || 0));
    }
    return bytes;
  }
  function remember(file, value, stamp, id) {
    const bytes = projectionBytes(value, id);
    if (bytes > budget) return;
    forget(file);
    while (cache.size && cacheBytes + bytes > budget) { forget(cache.keys().next().value); stats.evictions++; }
    cache.set(file, { value, stamp, bytes }); cacheBytes += bytes;
  }
  async function readProjection(id, stamp) {
    try {
      await indexDirectory();
      const file = path.join(indexDir, id + '.json');
      await fileStamp(file);
      const raw = await io.readFile(file, 'utf8'); stats.indexReads++;
      const saved = JSON.parse(raw);
      if (saved.version !== SEARCH_INDEX_VERSION || saved.id !== id || saved.sourceStamp !== stamp || !validProjection(saved.projection)) return null;
      stats.indexHits++;
      return saved.projection;
    } catch (_) { return null; }
  }
  async function writeProjection(file, id, stamp, value, isCanceled) {
    const target = path.join(indexDir, id + '.json'), temporary = path.join(indexDir, '.' + id + '.' + crypto.randomUUID() + '.tmp');
    let installed = false;
    try {
      if (isCanceled()) return;
      await indexDirectory(true);
      await io.writeFile(temporary, JSON.stringify({ version: SEARCH_INDEX_VERSION, id, sourceStamp: stamp, projection: value }), { encoding: 'utf8', flag: 'wx' });
      if (isCanceled() || await fileStamp(file) !== stamp) return;
      await io.rename(temporary, target); installed = true;
      // Deletion writes index membership first. The final indexSnapshot also
      // prunes membership, while this check prevents a late write after unlink.
      if (await fileStamp(file) !== stamp) { await io.unlink(target).catch(() => {}); return; }
      stats.indexWrites++;
    } catch (_) {
      stats.indexWriteFailures++;
      if (installed) await io.unlink(target).catch(() => {});
    } finally { await io.unlink(temporary).catch(() => {}); }
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
      await pruneIndexes(ids);
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
      const indexed = await readProjection(id, stamp);
      if (isCanceled()) return null;
      if (indexed && await fileStamp(file) === stamp) {
        remember(file, indexed, stamp, id);
        return { value: indexed, stamp };
      }
      const raw = await io.readFile(file, 'utf8'); stats.bodyReads++; stats.bodyBytes += Buffer.byteLength(raw, 'utf8');
      if (isCanceled()) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.id !== id || parsed.turns != null && !Array.isArray(parsed.turns)) throw failure('HISTORY_SEARCH_DOCUMENT_INVALID', '历史内容与索引不一致');
      let document = parsed;
      try { document = recoverSnapshot(parsed); } catch (_) { /* Match optional load-time recovery fallback. */ }
      const value = { title: detached(document.title), kind: detached(text(document.kind || 'chat').slice(0, 32)), mode: detached(text(document.mode || 'plain').slice(0, 32)),
        fromScheduled: compactSchedule(document.fromScheduled), updatedAt: detached(text(document.updatedAt || document.createdAt).slice(0, 64)), turns: [] };
      value.titleText = SearchText.displayText(value.title, { markdown: false });
      value.titleNormalized = SearchText.normalize(value.titleText);
      for (let index = 0; index < (document.turns || []).length; index++) {
        if (index % 64 === 0) { await yieldTurn(); if (isCanceled()) return null; }
        const turn = document.turns[index];
        const fields = SearchText.fieldsForTurn(turn, value.kind);
        const saved = [];
        for (const field of fields) {
          const fieldText = detached(SearchText.displayText(field.text, { markdown: field.side === 'assistant' }));
          if (fieldText) saved.push({ side: field.side, text: fieldText, normalized: SearchText.normalize(fieldText), messageKey: field.messageKey == null ? null : detached(field.messageKey) });
        }
        const turnId = [turn?.id, turn?.userMessageId, turn?.runId].find(id => typeof id === 'string' && id);
        if (saved.length) value.turns.push({ index, turnId: turnId ? detached(turnId) : null, fields: saved });
      }
      const after = await fileStamp(file); if (stamp !== after) continue;
      stats.projections++;
      await writeProjection(file, id, stamp, value, isCanceled);
      if (isCanceled()) return null;
      remember(file, value, stamp, id);
      return { value, stamp };
    }
    throw failure('HISTORY_SEARCH_DOCUMENT_CHANGED', '历史内容正在更新');
  }
  async function match(value, meta, query, normalized, isCanceled) {
    const title = value.title;
    let snippet = value.titleNormalized.includes(normalized) ? makeSnippet(value.titleText, query) : null;
    let matchField = snippet ? 'title' : null, turnIndex = null, turnId = null, matchSide = null, messageKey = null;
    if (!snippet) {
      let visited = 0;
      for (const turn of value.turns) {
        if (++visited % 64 === 0) { await yieldTurn(); if (isCanceled()) return null; }
        for (const field of turn.fields) {
          if (!field.normalized.includes(normalized)) continue;
          snippet = makeSnippet(field.text, query);
          if (snippet) { matchField = 'body'; turnIndex = turn.index; turnId = turn.turnId; matchSide = field.side; messageKey = field.messageKey; break; }
        }
        if (snippet) break;
      }
    }
    return snippet ? { id: meta.id, title: (title || '未命名').slice(0, 256), kind: value.kind, mode: value.mode,
      fromScheduled: value.fromScheduled, updatedAt: text(meta.updatedAt || value.updatedAt).slice(0, 64),
      snippet, matchField, turnIndex, turnId, matchSide, messageKey } : null;
  }
  async function search({ query, limit, offset = 0, isCanceled = () => false } = {}) {
    const q = text(query).trim(), cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    if (isCanceled()) return canceledResult();
    if (!q) return { ok: true, items: [] };
    if (q.length > 512) return { ok: false, items: [], code: 'HISTORY_SEARCH_QUERY_TOO_LONG', error: '搜索内容过长，请缩短后重试。' };
    const normalized = SearchText.normalize(q), parsedOffset = Number(offset);
    const start = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    if (!normalized) return { ok: true, items: [] };
    try {
      for (let pass = 0; pass < 2; pass++) {
        const index = await indexSnapshot(), matches = []; let skipped = index.skipped, scanned = 0;
        for (let position = 0; position < index.items.length; position += SCAN_CONCURRENCY) {
          await yieldTurn(); if (isCanceled()) return canceledResult();
          const batch = index.items.slice(position, position + SCAN_CONCURRENCY); scanned += batch.length;
          const found = await Promise.all(batch.map(async meta => {
            const file = path.join(historyDir, meta.id + '.json');
            try {
              if (isCanceled()) return null;
              const projected = await projection(file, meta.id, isCanceled);
              if (!projected || isCanceled()) return null;
              const item = await match(projected.value, meta, q, normalized, isCanceled);
              return item ? { item, file, stamp: projected.stamp } : null;
            } catch (_) { forget(file); skipped++; return null; }
          }));
          matches.push(...found.filter(Boolean));
          if (matches.length > start + cap) break;
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
        const items = verified.slice(start, start + cap), hasMore = verified.length > start + cap;
        return { ok: true, items, hasMore, nextOffset: hasMore ? start + items.length : null, ...(skipped || incomplete ? { partial: true, skipped,
          warning: incomplete ? '搜索期间历史仍在更新，结果可能不完整。' : '部分历史暂时无法读取，结果可能不完整。' } : {}) };

      }
    } catch (_) {
      if (isCanceled()) return canceledResult();
      return { ok: false, items: [], code: 'HISTORY_SEARCH_INDEX_UNAVAILABLE', error: '无法读取历史索引，请稍后重试。' };
    }
  }
  return { search, diagnostics: () => ({ ...stats, cacheEntries: cache.size, cacheBytes, cacheMaxBytes: budget }) };
}
module.exports = { createHistorySearchCore, makeSnippet, savedAssistant, DEFAULT_CACHE_BYTES, SEARCH_INDEX_VERSION };
