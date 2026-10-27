'use strict';

const { parseMemoryDocument } = require('./memory-schema');

// A small vocabulary bridges common wording without making semantic claims
// about arbitrary project names. Chinese grams still handle names and phrases
// not present in this vocabulary.
const SYNONYMS = [
  ['记忆', 'memory', 'memories'], ['项目', 'project', 'projects'],
  ['偏好', 'preference', 'preferences'], ['报告', '报表', 'report', 'reports'],
  ['汇总', '总结', 'summary', 'summarize'], ['路径', '目录', 'path', 'paths', 'directory'],
  ['检查', '校验', '验证', 'check', 'verify', 'validation'],
  ['配置', '设置', 'config', 'configuration', 'settings'],
  ['文档', '资料', 'document', 'documentation', 'docs'],
  ['规则', '要求', 'rule', 'rules'], ['错误', '异常', 'error', 'errors'],
  ['工作区', 'workspace'], ['构建', '编译', 'build'], ['测试', 'test', 'tests'],
];
const ALIASES = new Map(SYNONYMS.flatMap((group, index) => group.map(term => [term, `~${index}`])));
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'be', 'with', 'please']);
const FIELD_WEIGHTS = Object.freeze({ name: 5, description: 3, file: 0.7, body: 1 });
const REDACTED = '[已隐藏敏感内容]';
const MAX_DOCUMENT_CHARS = 256 * 1024;
const MAX_QUERY_CHARS = 2048;
const SENSITIVE_LINE = /(?:\b|_)(?:passwords?|passwd|pwd|secrets?|(?:access|refresh|auth|id)[_ -]?tokens?|tokens?|api[_ -]?keys?|authorization|credentials?|private[_ -]?keys?|access[_ -]?keys?|client[_ -]?secrets?)\b|密码|口令|密钥|凭据|\bBearer\s+\S+|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b|https?:\/\/[^\s/@:]+:[^\s/@]+@/iu;

function normalized(value) { return String(value ?? '').normalize('NFKC').toLowerCase(); }

function redactMemoryText(value) {
  let hiddenParagraph = false, privateKey = false;
  const output = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true;
    if (!line.trim() && !privateKey) hiddenParagraph = false;
    if (SENSITIVE_LINE.test(line)) hiddenParagraph = true;
    const hidden = hiddenParagraph || privateKey;
    if (!hidden || output[output.length - 1] !== REDACTED) output.push(hidden ? REDACTED : line);
    if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false;
  }
  return output.join('\n');
}

function tokenizeMemoryQuery(value) {
  const result = [];
  for (const segment of normalized(value).match(/[\p{Script=Han}]+|[a-z0-9]+(?:[_-][a-z0-9]+)*/gu) || []) {
    if (/\p{Script=Han}/u.test(segment)) {
      const chars = [...segment];
      if (chars.length === 1) result.push(segment);
      for (const width of [2, 3]) {
        for (let start = 0; start + width <= chars.length; start++) {
          const term = chars.slice(start, start + width).join('');
          result.push(term);
          if (ALIASES.has(term)) result.push(ALIASES.get(term));
        }
      }
    } else {
      // Paths and identifiers can be searched as a whole or by a component.
      for (const term of new Set([segment, ...segment.split(/[_-]/)])) {
        if (!STOP_WORDS.has(term)) result.push(term);
        if (ALIASES.has(term)) result.push(ALIASES.get(term));
      }
    }
  }
  return result;
}

function termCounts(text) {
  const terms = tokenizeMemoryQuery(text), counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return { counts, length: terms.length };
}

function indexEntry(entry, body) {
  const texts = {
    name: redactMemoryText(entry.meta?.name).replaceAll(REDACTED, ''),
    description: redactMemoryText(entry.meta?.description).replaceAll(REDACTED, ''),
    file: entry.file.replace(/\.md$/i, ''),
    body: redactMemoryText(body.slice(0, MAX_DOCUMENT_CHARS)).replaceAll(REDACTED, ''),
  };
  const fields = Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, termCounts(text)]));
  return { revision: entry.revision, texts, fields,
    bytes: Object.values(texts).reduce((sum, text) => sum + text.length * 2, 0)
      + Object.values(fields).reduce((sum, field) => sum + field.counts.size * 80, 0) };
}

function publicEntry(entry) {
  // Listing is an index, not a second read API. Source quotes and other unknown
  // metadata may contain full chat text; expose provenance only through read.
  const meta = {};
  for (const key of ['type', 'core', 'scope', 'projectId', 'status', 'confidence', 'expiresAt']) {
    if (entry.meta && Object.hasOwn(entry.meta, key)) meta[key] = entry.meta[key];
  }
  return { file: entry.file, meta: { ...meta,
    name: redactMemoryText(entry.meta?.name), description: redactMemoryText(entry.meta?.description),
    sourceCount: Array.isArray(entry.meta?.sources) ? entry.meta.sources.length : (entry.meta?.sourceRef ? 1 : 0) },
  revision: entry.revision, mtime: entry.mtime };
}

function snippetFor(indexed, queryTerms) {
  const source = [indexed.texts.body, indexed.texts.description, indexed.texts.name].filter(Boolean).join('\n');
  if (!source) return '';
  let best = '', bestCount = -1;
  for (const line of source.split(/\n+/)) {
    const clean = line.trim();
    if (!clean) continue;
    const terms = new Set(tokenizeMemoryQuery(clean));
    const count = queryTerms.filter(term => terms.has(term)).length;
    if (count > bestCount) { best = clean; bestCount = count; }
  }
  const normalizedLine = normalized(best);
  const firstMatch = queryTerms.filter(term => !term.startsWith('~'))
    .map(term => normalizedLine.indexOf(term)).filter(position => position >= 0).sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, firstMatch - 50);
  return `${start ? '…' : ''}${best.slice(start, start + 196)}${best.length > start + 196 ? '…' : ''}`.slice(0, 200);
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function createMemoryRetriever({ store, now = Date.now, maxCacheEntries = 256, maxCacheBytes = 16 * 1024 * 1024 } = {}) {
  if (!store || typeof store.list !== 'function' || typeof store.read !== 'function') throw new TypeError('Memory retriever requires a memory store');
  const cache = new Map();
  const capacity = boundedInteger(maxCacheEntries, 256, 0, 4096);
  const byteLimit = boundedInteger(maxCacheBytes, 16 * 1024 * 1024, 0, 128 * 1024 * 1024);
  let cacheBytes = 0;
  function invalidate(file) {
    if (file == null) { cache.clear(); cacheBytes = 0; return; }
    const value = cache.get(file);
    if (value) { cacheBytes -= value.bytes; cache.delete(file); }
  }
  function remember(file, indexed) {
    invalidate(file);
    if (!capacity || indexed.bytes > byteLimit) return;
    cache.set(file, indexed); cacheBytes += indexed.bytes;
    while (cache.size > capacity || cacheBytes > byteLimit) invalidate(cache.keys().next().value);
  }
  function search(query = '', { context = {}, limit = 30, offset = 0, includeCore = true } = {}) {
    const ctx = { ...context, now: context.now ?? now() };
    const entries = store.list(ctx, { actor: 'model', eligibleOnly: true });
    const visible = new Map(entries.map(entry => [entry.file, entry.revision]));
    for (const [file, indexed] of cache) {
      if (visible.get(file) !== indexed.revision) invalidate(file);
    }
    const allowed = includeCore ? entries : entries.filter(entry => !entry.meta?.core);
    const count = boundedInteger(limit, 30, 1, 100), start = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const text = normalized(query).trim().slice(0, MAX_QUERY_CHARS);
    if (!text) return allowed.slice(start, start + count).map(entry => ({ ...publicEntry(entry), score: 0, snippet: '', matchedFields: [] }));
    const terms = [...new Set(tokenizeMemoryQuery(text))];
    if (!terms.length) return [];
    const documents = [];
    for (let entry of allowed) {
      let indexed = cache.get(entry.file);
      if (indexed) { cache.delete(entry.file); cache.set(entry.file, indexed); }
      else {
        try {
          // Recheck access at the point of reading: a memory may have changed
          // project, approval state or revision since list returned.
          const full = store.read(entry.file, { actor: 'model', context: ctx });
          entry = full;
          if (!includeCore && entry.meta?.core) continue;
          indexed = indexEntry(entry, parseMemoryDocument(full.content).body);
          remember(entry.file, indexed);
        } catch (error) {
          if (['MEMORY_NOT_FOUND', 'MEMORY_SCOPE'].includes(error.code)) continue;
          throw error;
        }
      }
      documents.push({ entry, indexed });
    }
    const average = {}, frequencies = new Map(terms.map(term => [term, 0]));
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      average[field] = documents.reduce((sum, doc) => sum + doc.indexed.fields[field].length, 0) / (documents.length || 1) || 1;
    }
    for (const { indexed } of documents) {
      for (const term of terms) if (Object.values(indexed.fields).some(field => field.counts.has(term))) frequencies.set(term, frequencies.get(term) + 1);
    }
    const results = [];
    for (const { entry, indexed } of documents) {
      let score = 0, matched = 0;
      const matchedFields = new Set();
      for (const term of terms) {
        const frequency = frequencies.get(term);
        if (!frequency) continue;
        const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
        let found = false;
        for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
          const data = indexed.fields[field], tf = data.counts.get(term) || 0;
          if (!tf) continue;
          found = true; matchedFields.add(field);
          score += weight * idf * (tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * data.length / average[field])));
        }
        if (found) matched++;
      }
      if (!matched) continue;
      score *= 0.5 + 0.5 * matched / terms.length;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (text.length > 1 && normalized(indexed.texts[field]).includes(text)) score += weight;
      }
      results.push({ ...publicEntry(entry), score: Number(score.toFixed(6)), snippet: snippetFor(indexed, terms), matchedFields: [...matchedFields] });
    }
    results.sort((a, b) => b.score - a.score || b.mtime - a.mtime || a.file.localeCompare(b.file));
    return results.slice(start, start + count);
  }
  return { search, invalidate };
}

module.exports = { createMemoryRetriever, tokenizeMemoryQuery, redactMemoryText };
