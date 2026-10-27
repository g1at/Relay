'use strict';
// Synthetic-only benchmark. It never opens the application's history directory.
// Native Windows example:
// node test/history-search-benchmark.cjs --baseline-core .codex-tmp/history-search-benchmark/baseline/src/main/app/history-search-core.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/history-search-benchmark');
const args = process.argv.slice(2), options = { conversations: 280, logMiB: 375, keepFixture: false };
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (name === '--baseline-core') options.baselineCore = path.resolve(args[++i]);
  else if (name === '--conversations') options.conversations = Number(args[++i]);
  else if (name === '--log-mib') options.logMiB = Number(args[++i]);
  else if (name === '--keep-fixture') options.keepFixture = true;
  else throw Error('Unknown option: ' + name);
}
assert.ok(Number.isSafeInteger(options.conversations) && options.conversations >= 2, 'conversations must be an integer >= 2');
assert.ok(Number.isFinite(options.logMiB) && options.logMiB > 0, 'log-mib must be positive');
fs.mkdirSync(output, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
const runDir = path.join(output, runId), historyDir = path.join(runDir, 'history');
fs.mkdirSync(historyDir, { recursive: true });
const report = {
  synthetic: true, runId, runtime: { platform: process.platform, arch: process.arch, versions: process.versions },
  methodology: 'Application-cold means a new core with no projection index; generated files may already be in the OS filesystem cache. Restart means a new core instance, not an OS restart. Timings are observations, not pass/fail thresholds.',
  configuration: { conversations: options.conversations, toolLogMiB: options.logMiB, visibleTurnsPerConversation: 8 },
  variants: [], failures: [],
};
const save = () => {
  const json = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(path.join(runDir, 'result.json'), json);
  fs.writeFileSync(path.join(output, 'result.json'), json);
};
const delta = (after, before) => Object.fromEntries(Object.keys(after).filter(key => typeof after[key] === 'number')
  .map(key => [key, after[key] - (typeof before[key] === 'number' ? before[key] : 0)]));

function makeFixture() {
  const items = [], totalLogBytes = Math.floor(options.logMiB * 1024 * 1024), perFile = Math.floor(totalLogBytes / options.conversations);
  const toolLine = 'synthetic-tool-only-marker trace step completed; temporary compiler output and verbose execution log. ';
  const log = toolLine.repeat(Math.ceil((perFile + options.conversations) / toolLine.length));
  const visible = '这是一份合成项目的工作记录。先确认需求和验收条件，再检查改动与测试结果。保存的正文说明设计取舍、处理步骤以及尚未验证的边界；工具日志单独保存，不作为正文搜索。';
  let bytes = 0, visibleBytes = 0;
  for (let i = 0; i < options.conversations; i++) {
    const id = 'synthetic-' + String(i).padStart(4, '0');
    const turns = Array.from({ length: 8 }, (_, turn) => ({
      user: `请检查合成项目 ${i} 的阶段 ${turn}，给出验收方法。 ${visible}`,
      assistant: `阶段 ${turn} 的记录：${visible.repeat(3)} 本次结果需要结合独立测试确认。`,
    }));
    if (i === options.conversations - 1) turns[7].assistant += ' cold-last-match warm-alternate-last-match restart-last-match';
    visibleBytes += Buffer.byteLength(JSON.stringify(turns));
    turns[0].activity = { items: [{ type: 'tool_result', text: log.slice(0, perFile + (i === options.conversations - 1 ? totalLogBytes % options.conversations : 0)) }] };
    const document = { id, title: `合成项目记录 ${i}`, kind: 'chat', mode: 'plain',
      updatedAt: new Date(1800000000000 - i * 1000).toISOString(), turns };
    const raw = JSON.stringify(document); bytes += Buffer.byteLength(raw);
    fs.writeFileSync(path.join(historyDir, id + '.json'), raw);
    items.push({ id, title: document.title, updatedAt: document.updatedAt, kind: document.kind });
  }
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify({ version: 2, items }));
  return { bodyFiles: items.length, bodyBytes: bytes, toolLogBytes: totalLogBytes, visibleBodyBytes: visibleBytes,
    expectedMatch: items.at(-1).id };
}

function countedFileSystem() {
  const counters = { bodyReads: 0, bodyBytes: 0, catalogReads: 0, catalogBytes: 0, projectionReads: 0, projectionBytes: 0,
    projectionWrites: 0, projectionWriteBytes: 0, bodyStats: 0, catalogStats: 0, projectionStats: 0,
    peakConcurrentBodyReads: 0, peakConcurrentBodyStats: 0 };
  let activeReads = 0, activeStats = 0;
  function kind(file) {
    const resolved = path.resolve(String(file));
    if (path.dirname(resolved) === historyDir) return path.basename(resolved) === 'index.json' ? 'catalog' : 'body';
    return resolved.startsWith(path.join(historyDir, '.search-index') + path.sep) ? 'projection' : null;
  }
  const promises = { ...fs.promises,
    async readFile(file, ...rest) {
      const category = kind(file);
      if (category) counters[category + 'Reads']++;
      if (category === 'body') counters.peakConcurrentBodyReads = Math.max(counters.peakConcurrentBodyReads, ++activeReads);
      try {
        const result = await fs.promises.readFile(file, ...rest);
        if (category) counters[category + 'Bytes'] += Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result);
        return result;
      } finally { if (category === 'body') activeReads--; }
    },
    async writeFile(file, data, ...rest) {
      if (kind(file) === 'projection') { counters.projectionWrites++; counters.projectionWriteBytes += Buffer.byteLength(data); }
      return fs.promises.writeFile(file, data, ...rest);
    },
  };
  for (const method of ['stat', 'lstat']) promises[method] = async (file, ...rest) => {
    const category = kind(file);
    if (category) counters[category + 'Stats']++;
    if (category === 'body') counters.peakConcurrentBodyStats = Math.max(counters.peakConcurrentBodyStats, ++activeStats);
    try { return await fs.promises[method](file, ...rest); }
    finally { if (category === 'body') activeStats--; }
  };
  return { fileSystem: { ...fs, promises }, snapshot: () => ({ ...counters }),
    resetPeaks() { counters.peakConcurrentBodyReads = 0; counters.peakConcurrentBodyStats = 0; } };
}

function moduleInventory(moduleFile) {
  const files = new Map();
  function visit(entry) {
    if (!entry || files.has(entry.filename)) return;
    files.set(entry.filename, { file: path.relative(root, entry.filename),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(entry.filename)).digest('hex') });
    for (const child of entry.children) visit(child);
  }
  visit(require.cache[require.resolve(moduleFile)]);
  return [...files.values()];
}

function indexInventory() {
  const dir = path.join(historyDir, '.search-index');
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0, containsToolLog: false };
  let files = 0, bytes = 0, containsToolLog = false;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const content = fs.readFileSync(file); files++; bytes += content.length;
    if (content.includes('synthetic-tool-only-marker')) containsToolLog = true;
  }
  return { files, bytes, containsToolLog };
}

async function benchmark(label, moduleFile, expectPersistent) {
  fs.rmSync(path.join(historyDir, '.search-index'), { recursive: true, force: true });
  const moduleHash = crypto.createHash('sha256').update(fs.readFileSync(moduleFile)).digest('hex');
  const { createHistorySearchCore } = require(moduleFile), counted = countedFileSystem();
  const create = () => createHistorySearchCore({ historyDir, fileSystem: counted.fileSystem });
  let core = create();
  const variant = { label, module: path.relative(root, moduleFile), sha256: moduleHash,
    modules: moduleInventory(moduleFile), phases: [] };
  report.variants.push(variant);
  async function phase(name, query) {
    counted.resetPeaks();
    const before = counted.snapshot(), beforeDiagnostics = core.diagnostics(), started = performance.now();
    const result = await core.search({ query, limit: 50, offset: 0 });
    const elapsedMs = performance.now() - started, after = counted.snapshot(), diagnostics = core.diagnostics();
    const measurement = { name, elapsedMs, ok: result.ok, matches: result.items.length,
      io: delta(after, before), diagnostics, diagnosticDelta: delta(diagnostics, beforeDiagnostics) };
    // Peak concurrency is a per-phase gauge, not a cumulative counter.
    measurement.io.peakConcurrentBodyReads = after.peakConcurrentBodyReads;
    measurement.io.peakConcurrentBodyStats = after.peakConcurrentBodyStats;
    variant.phases.push(measurement); save();
    assert.equal(result.ok, true, label + ' ' + name + ' failed');
    assert.equal(result.partial, undefined, label + ' ' + name + ' was partial');
    assert.deepEqual(result.items.map(item => item.id), [report.fixture.expectedMatch]);
    return measurement;
  }
  console.log('Benchmarking ' + label + ': first search, alternate warm query, new core restart');
  await phase('firstSearch', 'cold-last-match');
  const warm = await phase('alternateWarmSearch', 'warm-alternate-last-match');
  assert.equal(warm.io.bodyReads, 0, 'Warm queries must reuse compact in-memory projections');
  variant.persistedIndex = indexInventory();
  core = create();
  const restarted = await phase('newCoreRestart', 'restart-last-match');
  if (expectPersistent) {
    assert.equal(restarted.io.bodyReads, 0, 'A new core must reuse persisted projections');
    assert.equal(variant.persistedIndex.files, options.conversations);
    assert.equal(variant.persistedIndex.containsToolLog, false);
  }
  variant.ioTotals = counted.snapshot();
}

(async () => {
  console.log(`Generating synthetic fixture: ${options.conversations} conversations, ${options.logMiB} MiB tool logs`);
  report.fixture = makeFixture(); save();
  if (options.baselineCore) await benchmark('before', options.baselineCore, false);
  await benchmark('after', path.join(root, 'src/main/app/history-search-core.js'), true);
})().catch(error => { report.failures.push(String(error.stack || error)); process.exitCode = 1; }).finally(() => {
  if (!options.keepFixture) fs.rmSync(historyDir, { recursive: true, force: true });
  report.fixtureRemoved = !fs.existsSync(historyDir); save();
  console.log(JSON.stringify({ report: path.relative(root, path.join(runDir, 'result.json')), synthetic: true,
    platform: process.platform, fixture: report.fixture, variants: report.variants.map(item => ({ label: item.label,
      phases: item.phases.map(phase => ({ name: phase.name, elapsedMs: phase.elapsedMs, bodyReads: phase.io.bodyReads,
        bodyBytes: phase.io.bodyBytes, projectionReads: phase.io.projectionReads })), persistedIndex: item.persistedIndex })),
    failures: report.failures }, null, 2));
});
