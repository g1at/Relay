'use strict';
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const asar = require('@electron/asar');
const minimatch = require('minimatch');
const match = typeof minimatch === 'function' ? minimatch : minimatch.minimatch;
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/history-search-2026-10-14/asar');
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(out, 'run-')), archive = path.join(fixture, 'app.asar');
const historyDir = path.join(fixture, 'history'); fs.mkdirSync(historyDir);
app.setPath('userData', path.join(fixture, 'profile'));
const report = { checks: [], failures: [], runtime: process.versions }; let client;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
function check(name, value, detail) { report.checks.push({ name, ok: !!value, ...(detail === undefined ? {} : { detail }) }); save(); if (!value) throw Error(name); }
const timeout = setTimeout(() => { report.failures.push('timeout'); save(); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = ['src/main/app/history-search-client.js', 'src/main/app/history-search-worker.js', 'src/main/app/history-search-core.js', 'src/main/app/paths.js'];
  const patterns = manifest.build.files.filter(value => typeof value === 'string');
  const included = file => patterns.some(pattern => !pattern.startsWith('!') && match(file, pattern)) && !patterns.some(pattern => pattern.startsWith('!') && match(file, pattern.slice(1)));
  const unpacked = file => manifest.build.asarUnpack.some(pattern => match(file, pattern));
  check('ReleaseIncludesSearchRuntime', entries.every(included));
  check('ReleaseUnpacksWorkerDependencies', entries.slice(1).every(unpacked));
  const dirs = new Set(); for (const file of entries) for (let d = path.posix.dirname(file); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  await asar.createPackageFromStreams(archive, [
    ...[...dirs].sort().map(d => ({ path: d, type: 'directory', unpacked: false })),
    ...entries.map(file => ({ path: file, type: 'file', unpacked: unpacked(file), stat: fs.statSync(path.join(root, file)), streamGenerator: () => fs.createReadStream(path.join(root, file)) })),
  ]);
  const items = [];
  for (let i = 0; i < 64; i++) {
    const c = { id: 'conversation-' + i, title: '合成历史 ' + i, updatedAt: new Date(1800000000000 - i * 1000).toISOString(),
      turns: [{ user: '大历史中的准确定位 ' + i, assistant: '可见答案 keyword ' + i, activity: { toolOutput: 'irrelevant execution detail '.repeat(14000) } }] };
    fs.writeFileSync(path.join(historyDir, c.id + '.json'), JSON.stringify(c)); items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
  }
  const index = path.join(historyDir, 'index.json'); fs.writeFileSync(index, JSON.stringify({ version: 2, items }));
  const { HistorySearchClient } = require(path.join(archive, entries[0]));
  client = new HistorySearchClient({ historyDir });
  let ticks = 0, mainBodyReads = 0; const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) { if (String(file).startsWith(historyDir)) { mainBodyReads++; throw Error('Main process must not read history'); } return originalRead.call(fs, file, ...args); };
  const timer = setInterval(() => ticks++, 5), started = performance.now(); let cold;
  try { cold = await client.search('keyword', 200, 'a'); } finally { clearInterval(timer); fs.readFileSync = originalRead; }
  check('ColdPackagedSearchPreservesInputEventLoop', cold.ok && cold.items.length === 64 && ticks > 0 && mainBodyReads === 0, { elapsedMs: performance.now() - started, ticks, mainBodyReads });
  check('ResultKeepsExactTurnNavigation', cold.items.every(item => item.turnIndex === 0 && item.matchSide === 'assistant'));
  const warmStarted = performance.now(), warm = await client.search('准确定位', 50, 'a');
  check('WarmQueryUsesOtherFields', warm.ok && warm.items.length === 50 && warm.items.every(item => item.matchSide === 'user'), { elapsedMs: performance.now() - warmStarted });
  const obsolete = client.search('keyword', 200, 'a'), newest = client.search('合成历史 3', 50, 'a');
  check('RapidInputSupersedesOldQuery', (await obsolete).canceled === true && (await newest).items.length > 0);
  const gone = client.search('keyword', 200, 'closed-window'); client.cancel('closed-window');
  check('ClosingSearchSettlesPendingRequest', (await gone).canceled === true);
  const firstFile = path.join(historyDir, items[0].id + '.json'); const c = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
  c.turns[0].assistant = '更新后的独有匹配'; fs.writeFileSync(firstFile, JSON.stringify(c));
  check('SavedEditInvalidatesCacheWithoutActivityTimeChange', (await client.search('更新后的独有匹配', 50, 'a')).items[0]?.id === c.id);
  fs.writeFileSync(index, JSON.stringify({ version: 2, items: items.slice(1) })); fs.unlinkSync(firstFile);
  check('DeletedConversationDoesNotReturnFromCache', (await client.search('更新后的独有匹配', 50, 'a')).items.length === 0);
  fs.writeFileSync(index, '{ broken index');
  check('IndexFailureIsNotReportedAsNoMatches', (await client.search('keyword', 50, 'a')).ok === false);
  fs.writeFileSync(index, JSON.stringify({ version: 2, items: items.slice(1) }));
  check('SearchRecoversAfterIndexRepair', (await client.search('keyword', 50, 'a')).ok === true);
  await client.close(); client = null;
  check('FixtureAvoidsRelayStartupAndSdk', !require.cache[path.join(root, 'main.js')] && !Object.keys(require.cache).some(file => file.includes('@anthropic-ai')));
}).catch(error => { report.failures.push(String(error.stack || error)); }).finally(async () => {
  if (client) await client.close(); clearTimeout(timeout); save(); console.log(JSON.stringify({ passed: report.checks.filter(c => c.ok).length, failures: report.failures })); app.exit(report.failures.length ? 1 : 0);
});
