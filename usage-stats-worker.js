'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { normalizeUsageRecord, VERSION, TOKEN_FIELDS } = require('./usage-stats-service');

// Rebuild only the background aggregation index after counter semantics change.
// Keep the small display snapshot compatible so reopening still renders instantly.
const USAGE_AGGREGATION_VERSION = 2;
const clone = value => JSON.parse(JSON.stringify(value));
const dateKey = value => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const timeOf = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; };
const stamp = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: String(stat.ino) });
const sameStamp = (a, b) => a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
const emptyIndex = configKey => ({ version: VERSION, configKey, history: {}, usage: freshUsage() });
const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const modelCounters = value => dictionary(value) && Object.values(value).every(counters => dictionary(counters) && TOKEN_FIELDS.every(field => nonnegative(counters[field])));
function usableIndex(value, configKey) {
  return value && value.version === VERSION && value.configKey === configKey
    && dictionary(value.history) && Object.values(value.history).every(record => record && typeof record.id === 'string'
      && dictionary(record.stamp) && dictionary(record.days) && Object.values(record.days).every(nonnegative))
    && dictionary(value.usage) && value.usage.aggregationVersion === USAGE_AGGREGATION_VERSION && nonnegative(value.usage.offset) && dictionary(value.usage.seen)
    && dictionary(value.usage.epochs) && Object.values(value.usage.epochs).every(epoch => epoch && modelCounters(epoch.models))
    && dictionary(value.usage.days) && Object.values(value.usage.days).every(day => day && nonnegative(day.results) && modelCounters(day.models));
}

async function atomicJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const previous = temp + '.previous';
  try {
    await fsp.writeFile(temp, JSON.stringify(data), { flag: 'wx' });
    try { await fsp.rename(temp, file); }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await fsp.rename(file, previous);
      try { await fsp.rename(temp, file); }
      catch (replacementError) { await fsp.rename(previous, file); throw replacementError; }
      await fsp.rm(previous, { force: true });
    }
  } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}

function summarizeConversation(conversation) {
  if (!conversation || typeof conversation !== 'object' || typeof conversation.id !== 'string') throw new Error('INVALID_HISTORY');
  const days = Object.create(null);
  let unknownTimes = 0;
  const seenInputs = new Set();
  const add = (input, fallbackId) => {
    if (!input || !(typeof input.user === 'string' && input.user.trim() || typeof input.text === 'string' && input.text.trim() || Array.isArray(input.files) && input.files.length)) return;
    const key = typeof input.id === 'string' ? input.id : fallbackId;
    if (seenInputs.has(key)) return;
    seenInputs.add(key);
    const at = timeOf(input.ts);
    if (at == null) { unknownTimes += 1; return; }
    const day = dateKey(at);
    days[day] = (days[day] || 0) + 1;
  };
  for (const [i, turn] of (Array.isArray(conversation.turns) ? conversation.turns : []).entries()) {
    add(turn, `turn:${i}`);
    for (const [j, supplement] of (Array.isArray(turn && turn.supplements) ? turn.supplements : []).entries()) add(supplement, `turn:${i}:supplement:${j}`);
  }
  return { id: conversation.id, days, unknownTimes };
}

async function scanHistory(historyDir, previous = {}) {
  const next = Object.create(null);
  const warnings = new Set();
  let entries;
  try { entries = await fsp.readdir(historyDir, { withFileTypes: true }); }
  catch (_) { return { files: previous, available: Object.keys(previous).length > 0, complete: false, warnings: ['HISTORY_UNAVAILABLE'], scannedFiles: 0 }; }
  let scannedFiles = 0;
  let validFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue;
    const file = path.join(historyDir, entry.name);
    const old = previous[entry.name];
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('UNREADABLE_HISTORY');
      const currentStamp = stamp(stat);
      if (old && sameStamp(old.stamp, currentStamp)) next[entry.name] = old;
      else {
        scannedFiles += 1;
        const summary = summarizeConversation(JSON.parse(await fsp.readFile(file, 'utf8')));
        // A save can replace a history JSON while it is being read. Keep the
        // previous summary until the next pass instead of caching mixed input.
        if (!sameStamp(currentStamp, stamp(await fsp.lstat(file)))) throw new Error('HISTORY_CHANGED');
        next[entry.name] = { stamp: currentStamp, ...summary };
      }
      validFiles += 1;
      if (next[entry.name].unknownTimes) warnings.add('HISTORY_TIMESTAMPS_MISSING');
    } catch (_) {
      warnings.add('HISTORY_PARTIAL');
      if (old) { next[entry.name] = old; validFiles += 1; }
    }
  }
  return { files: next, available: validFiles > 0 || warnings.size === 0, complete: warnings.size === 0, warnings: [...warnings], scannedFiles };
}

function freshUsage() { return { aggregationVersion: USAGE_AGGREGATION_VERSION, offset: 0, seen: {}, epochs: {}, days: {}, recordingStartedAt: null }; }

function applyUsageRecord(usage, input) {
  const record = normalizeUsageRecord(input);
  if (!record || Object.prototype.hasOwnProperty.call(usage.seen, record.id)) return false;
  usage.seen[record.id] = true;
  const epochId = crypto.createHash('sha256').update(`${record.queryId}\0${record.sessionId}`).digest('hex');
  const epoch = usage.epochs[epochId] || { models: Object.create(null) };
  // Only a fresh query or explicit conversation reset (new sessionId) starts
  // new counters. A lower/late snapshot is not a reset: retain each field's
  // high-water mark, including models temporarily absent from a result.
  const day = dateKey(record.at);
  const bucket = usage.days[day] || { results: 0, models: Object.create(null) };
  bucket.results += 1;
  for (const [model, value] of Object.entries(record.modelUsage)) {
    const previous = own(epoch.models, model);
    const total = own(bucket.models, model) || Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0]));
    const next = {};
    for (const field of TOKEN_FIELDS) {
      const baseline = previous ? previous[field] : 0;
      next[field] = Math.max(baseline, value[field]);
      total[field] += next[field] - baseline;
    }
    put(bucket.models, model, total);
    put(epoch.models, model, next);
  }
  usage.epochs[epochId] = epoch;
  usage.days[day] = bucket;
  if (!usage.recordingStartedAt || record.startedAt < usage.recordingStartedAt) usage.recordingStartedAt = record.startedAt;
  return true;
}

async function scanUsageJournal(file, previous) {
  let stat;
  try { stat = await fsp.stat(file); }
  catch (error) {
    if (error.code === 'ENOENT' && !(previous && previous.offset)) return { usage: freshUsage(), complete: true, scannedBytes: 0 };
    return { usage: previous || freshUsage(), complete: false, scannedBytes: 0 };
  }
  let usage = previous && previous.offset <= stat.size ? clone(previous) : freshUsage();
  // Rewrites/truncation invalidate the append cache. inode and the committed
  // prefix boundary guard against replacing a journal with a different file.
  const handle = await fsp.open(file, 'r');
  let scannedBytes = 0;
  let complete = true;
  try {
    if (usage.offset && usage.boundaryHash) {
      const check = Buffer.alloc(Math.min(4096, usage.offset));
      await handle.read(check, 0, check.length, usage.offset - check.length);
      if (crypto.createHash('sha256').update(check).digest('hex') !== usage.boundaryHash) usage = freshUsage();
    }
    let position = usage.offset;
    let pending = Buffer.alloc(0);
    let committed = usage.offset;
    while (position < stat.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead; scannedBytes += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        committed += newline + 1;
        pending = pending.subarray(newline + 1);
        if (!line.length) continue;
        try {
          const value = JSON.parse(line.toString('utf8'));
          if (!normalizeUsageRecord(value)) complete = false;
          else applyUsageRecord(usage, value);
        } catch (_) { complete = false; }
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error('USAGE_LINE_TOO_LARGE');
    }
    usage.offset = committed;
    if (committed) {
      const boundary = Buffer.alloc(Math.min(4096, committed));
      await handle.read(boundary, 0, boundary.length, committed - boundary.length);
      usage.boundaryHash = crypto.createHash('sha256').update(boundary).digest('hex');
    }
    usage.invalidRows = !!usage.invalidRows || !complete;
    return { usage, complete: !usage.invalidRows, scannedBytes };
  } finally { await handle.close(); }
}

function tokenView(models, results, recordingStartedAt) {
  const items = Object.entries(models).map(([key, value]) => ({
    key, inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadInputTokens, cacheCreationTokens: value.cacheCreationInputTokens,
    count: TOKEN_FIELDS.reduce((sum, field) => sum + value[field], 0),
  })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const available = results > 0;
  const sum = field => available ? items.reduce((total, item) => total + item[field], 0) : null;
  return { available, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheCreationTokens: sum('cacheCreationTokens'),
    totalTokens: sum('count'), byModel: items.slice(0, 20), recordedResults: results,
    recordingStartedAt, coverage: available ? 'partial' : 'unavailable' };
}

// Reuse the journal's already aggregated day buckets. No files are read here.
function tokenDailyView(dates, usage, complete) {
  const start = usage.recordingStartedAt ? dateKey(usage.recordingStartedAt) : null;
  return dates.map(date => {
    const bucket = own(usage.days, date);
    const recorded = bucket && bucket.results > 0;
    const knownEmpty = !bucket && complete && start && date >= start;
    const value = recorded ? tokenView(bucket.models, bucket.results, usage.recordingStartedAt)
      : Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens'].map(field => [field, knownEmpty ? 0 : null]));
    return { date, inputTokens: value.inputTokens, outputTokens: value.outputTokens,
      cacheReadTokens: value.cacheReadTokens, cacheCreationTokens: value.cacheCreationTokens, totalTokens: value.totalTokens };
  });
}

function buildSnapshot(index, historyState, usageComplete, now) {
  const generatedAt = new Date(now).toISOString();
  const windows = {};
  for (const days of [7, 30, 90]) {
    const daily = [];
    const keys = new Set();
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(now); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - i);
      const key = dateKey(date); keys.add(key); daily.push({ date: key, count: historyState.available ? 0 : null });
    }
    const counts = new Map(daily.map(item => [item.date, item]));
    let conversations = 0; let messages = 0;
    for (const record of Object.values(index.history)) {
      let active = false;
      for (const [day, count] of Object.entries(record.days)) if (keys.has(day)) {
        counts.get(day).count += count; messages += count; active = true;
      }
      if (active) conversations += 1;
    }
    const models = Object.create(null); let results = 0;
    for (const [day, bucket] of Object.entries(index.usage.days)) if (keys.has(day)) {
      results += bucket.results;
      for (const [model, value] of Object.entries(bucket.models)) {
        const total = own(models, model) || Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0]));
        for (const field of TOKEN_FIELDS) total[field] += value[field];
        models[model] = total;
      }
    }
    windows[String(days)] = { ok: true, available: true, days, generatedAt,
      totals: { conversations: historyState.available ? conversations : null, messages: historyState.available ? messages : null }, daily,
      tokens: { ...tokenView(models, results, index.usage.recordingStartedAt),
        daily: results > 0 ? tokenDailyView([...keys], index.usage, usageComplete) : [] },
      coverage: { history: historyState.complete ? 'complete' : historyState.available ? 'partial' : 'unknown',
        warningCodes: [...historyState.warnings, ...(!usageComplete ? ['USAGE_RECORDS_PARTIAL'] : [])] },
    };
  }
  return { version: VERSION, configKey: index.configKey, generatedAt, windows };
}

async function refreshStats(options, previous, now = Date.now()) {
  const index = usableIndex(previous, options.configKey) ? clone(previous) : emptyIndex(options.configKey);
  const history = await scanHistory(options.historyDir, index.history);
  index.history = history.files;
  let journal;
  try { journal = await scanUsageJournal(path.join(options.cacheDir, 'usage-events-v1.jsonl'), index.usage); }
  catch (_) { journal = { usage: index.usage, complete: false, scannedBytes: 0 }; }
  index.usage = journal.usage;
  const snapshot = buildSnapshot(index, history, journal.complete, now);
  await atomicJson(path.join(options.cacheDir, 'usage-index-v1.json'), index);
  await atomicJson(path.join(options.cacheDir, 'usage-snapshot-v1.json'), snapshot);
  return { index, snapshot, diagnostics: { scannedHistoryFiles: history.scannedFiles, scannedUsageBytes: journal.scannedBytes } };
}

if (parentPort) {
  let index = null;
  let queue = fsp.mkdir(workerData.cacheDir, { recursive: true }).then(async () => {
    try {
      const value = JSON.parse(await fsp.readFile(path.join(workerData.cacheDir, 'usage-index-v1.json'), 'utf8'));
      if (usableIndex(value, workerData.configKey)) index = value;
    } catch (_) {}
  });
  const written = new Set();
  let journalBoundaryChecked = false;
  parentPort.on('message', message => {
    queue = queue.then(async () => {
      if (message.type === 'usage') {
        const record = normalizeUsageRecord(message.record);
        if (!record) throw new Error('INVALID_USAGE');
        if (!journalBoundaryChecked) {
          const journal = path.join(workerData.cacheDir, 'usage-events-v1.jsonl');
          try {
            const handle = await fsp.open(journal, 'r');
            try {
              const stat = await handle.stat();
              if (stat.size) {
                const tail = Buffer.alloc(1);
                await handle.read(tail, 0, 1, stat.size - 1);
                if (tail[0] !== 10) await fsp.appendFile(journal, '\n');
              }
            } finally { await handle.close(); }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          journalBoundaryChecked = true;
        }
        if (!written.has(record.id)) {
          await fsp.appendFile(path.join(workerData.cacheDir, 'usage-events-v1.jsonl'), JSON.stringify(record) + '\n');
          written.add(record.id);
        }
        parentPort.postMessage({ type: 'usage-ack', id: record.id, ok: true });
      } else if (message.type === 'refresh') {
        const result = await refreshStats(workerData, index, message.now);
        index = result.index;
        parentPort.postMessage({ requestId: message.requestId, ok: true, snapshot: result.snapshot });
      } else if (message.type === 'flush') parentPort.postMessage({ requestId: message.requestId, ok: true });
    }).catch(() => {
      if (message.type === 'usage') parentPort.postMessage({ type: 'usage-ack', id: message.record && message.record.id, ok: false });
      else parentPort.postMessage({ requestId: message.requestId, ok: false, error: { code: 'STATS_REFRESH_FAILED', message: '统计暂时未能更新，已保留上次结果。' } });
    });
  });
}

module.exports = { summarizeConversation, scanHistory, applyUsageRecord, scanUsageJournal, buildSnapshot, refreshStats, emptyIndex, tokenDailyView };
