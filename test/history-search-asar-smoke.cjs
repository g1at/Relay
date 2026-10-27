'use strict';
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const asar = require('@electron/asar');
const minimatch = require('minimatch');
const match = typeof minimatch === 'function' ? minimatch : minimatch.minimatch;
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/history-search-asar');
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(out, 'run-')), archive = path.join(fixture, 'app.asar');
const historyDir = path.join(fixture, 'history'); fs.mkdirSync(historyDir);
app.setPath('userData', path.join(fixture, 'profile'));
const report = { checks: [], failures: [], runtime: process.versions }; let client;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
function check(name, value, detail) { report.checks.push({ name, ok: !!value, ...(detail === undefined ? {} : { detail }) }); save(); if (!value) throw Error(name); }
const timeout = setTimeout(() => { report.failures.push('timeout'); save(); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = ['src/main/app/history-search-client.js', 'src/main/app/history-search-worker.js', 'src/main/app/history-search-core.js', 'src/main/app/paths.js',
    'renderer/history-search-text.js', 'renderer/assistant-output.js', 'renderer/supplement-timeline.js',
    'renderer/task-continuity.js', 'renderer/vendor/marked.umd.js', 'src/main/projects/legacy-output-recovery.js',
    'src/main/tasks/task-event-journal.js', 'src/main/tasks/task-protocol.js'];
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
  const Output = require(path.join(archive, 'renderer/assistant-output.js'));
  const { createLegacyOutputRecovery } = require(path.join(archive, 'src/main/projects/legacy-output-recovery.js'));
  const recoverSnapshot = createLegacyOutputRecovery({ fileSystem: {
    readFileSync() { throw Error('Snapshot fixture must not read a journal'); },
    statSync() { throw Error('Snapshot fixture must not stat a journal'); },
  } });
  const items = []; let legacyFixtureBytes;
  for (let i = 0; i < 64; i++) {
    const c = { id: 'conversation-' + i, title: '合成历史 ' + i, updatedAt: new Date(1800000000000 - i * 1000).toISOString(),
      turns: [{ id: 'turn-' + i, user: '大历史中的准确定位 ' + i, assistant: '可见答案 keyword ' + i,
        activity: { toolOutput: 'tool-log-only-marker irrelevant execution detail '.repeat(14000) } }] };
    if (i === 0) {
      c.turns[0].supplements = [{ id: 'supplement-0', text: '补充内容唯一码', status: 'applied' }];
      c.turns.push({ id: 'markdown-turn', user: '展示连续正文',
        assistant: '请检查**跨段**[连续正文](https://example.invalid/hidden-link-target)并确认。' });
      c.turns.push({ id: 'withdrawn-turn', assistant: 'withdrawn-draft-only-marker',
        output: { status: 'canceled', final: 'withdrawn-draft-only-marker' } });
      const runId = '22222222-2222-4222-8222-222222222222', state = Output.createState();
      Output.ingest(state, { type: 'assistant', uuid: 'legacy-final-frame', message: { id: 'legacy-final-message',
        content: [{ type: 'thinking', thinking: 'hidden-snapshot-reasoning-marker' }, { type: 'text', text: '旧快照安全恢复唯一正文' }], stop_reason: 'end_turn' } });
      Output.ingest(state, { type: 'result', subtype: 'success', jobId: runId, uuid: 'legacy-final-result',
        session_id: 'synthetic-session', user_message_uuid: runId, user_message_uuids: [runId], num_turns: 1,
        result: '', terminal_reason: 'completed', queued_turn_count: 0, origin: { kind: 'task-notification' } });
      const output = Output.serialize(state);
      Object.assign(output, { status: 'complete', final: '', finalMessageId: null, answers: [] });
      c.turns.push({ id: 'legacy-empty-final', runId, status: 'complete', assistant: '', output });
      const withdrawn = JSON.parse(JSON.stringify(c.turns.at(-1)));
      withdrawn.id = 'legacy-retracted-final'; withdrawn.output.retractedMessageUuids = ['legacy-final-frame'];
      withdrawn.output.messages[0].blocks = [{ type: 'text', text: 'legacy-retracted-fragment-only-marker' }];
      c.turns.push(withdrawn);
      check('LegacyFixtureHasStrictlyRecoverableSavedAnswer', recoverSnapshot(c).turns[3].assistant === '旧快照安全恢复唯一正文'
        && recoverSnapshot(c).turns[4].assistant === '' && c.turns[3].assistant === '' && c.turns[3].output.final === '');
    }
    const raw = JSON.stringify(c); if (i === 0) legacyFixtureBytes = raw;
    fs.writeFileSync(path.join(historyDir, c.id + '.json'), raw); items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
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
  const page1 = await client.search('keyword', 50, 'a', 0), page2 = await client.search('keyword', 50, 'a', page1.nextOffset);
  check('PackagedWorkerPaginatesBeyondFiftyMatches', page1.ok && page1.items.length === 50 && page1.hasMore === true && page1.nextOffset === 50
    && page2.ok && page2.items.length === 14 && page2.hasMore === false && page2.nextOffset === null
    && new Set([...page1.items, ...page2.items].map(item => item.id)).size === 64
    && [...page1.items, ...page2.items].every((item, index) => item.id === items[index].id));
  const warmStarted = performance.now(), warm = await client.search('准确定位', 50, 'a');
  check('WarmQueryUsesOtherFields', warm.ok && warm.items.length === 50 && warm.items.every(item => item.matchSide === 'user'), { elapsedMs: performance.now() - warmStarted });
  const supplement = await client.search('补充内容唯一码', 50, 'a');
  check('PackagedWorkerFindsSupplementWithExactMessageTarget', supplement.ok && supplement.items.length === 1
    && supplement.items[0].id === 'conversation-0' && supplement.items[0].turnIndex === 0
    && supplement.items[0].turnId === 'turn-0' && supplement.items[0].matchSide === 'user'
    && supplement.items[0].messageKey === 'supplement:supplement-0');
  const markdown = await client.search('检查跨段连续正文并确认', 50, 'a');
  check('PackagedWorkerFindsVisibleTextAcrossMarkdownNodes', markdown.ok && markdown.items.length === 1
    && markdown.items[0].turnIndex === 1 && markdown.items[0].turnId === 'markdown-turn'
    && markdown.items[0].matchSide === 'assistant' && markdown.items[0].snippet.includes('\x00检查跨段连续正文并确认\x01'));
  const legacy = await client.search('旧快照安全恢复唯一正文', 50, 'a');
  check('PackagedWorkerMatchesStrictlyRecoveredEmptyFinal', legacy.ok && legacy.items.length === 1
    && legacy.items[0].id === 'conversation-0' && legacy.items[0].turnIndex === 3
    && legacy.items[0].turnId === 'legacy-empty-final' && legacy.items[0].matchSide === 'assistant');
  check('PackagedWorkerLegacyRecoveryLeavesOriginalHistoryUnchanged', fs.readFileSync(path.join(historyDir, 'conversation-0.json'), 'utf8') === legacyFixtureBytes);
  for (const query of ['hidden-link-target', 'tool-log-only-marker', 'withdrawn-draft-only-marker',
    'hidden-snapshot-reasoning-marker', 'legacy-retracted-fragment-only-marker']) {
    const result = await client.search(query, 50, 'a');
    check('PackagedWorkerExcludesNonVisibleText:' + query, result.ok && result.items.length === 0);
  }
  const projectionDir = path.join(historyDir, '.search-index');
  const projections = fs.readdirSync(projectionDir).filter(file => file.endsWith('.json'));
  check('PackagedWorkerPersistsOnlyCompactProjections', projections.length === 64
    && projections.every(file => !fs.readFileSync(path.join(projectionDir, file), 'utf8').includes('tool-log-only-marker')),
    { files: projections.length, bytes: projections.reduce((sum, file) => sum + fs.statSync(path.join(projectionDir, file)).size, 0) });
  await client.close(); client = null;
  let blockedBodyReads = 0;
  class ProjectionOnlyWorker {
    constructor(file, options) {
      const worker = new Worker(`
        const fs = require('node:fs'), path = require('node:path');
        const { parentPort, workerData } = require('node:worker_threads');
        const originalRead = fs.promises.readFile;
        fs.promises.readFile = function(file, ...args) {
          const target = path.resolve(String(file));
          if (path.dirname(target) === workerData.historyDir && path.basename(target) !== 'index.json') {
            parentPort.postMessage({ syntheticProbe: 'blockedBodyRead' });
            return Promise.reject(Error('Synthetic restart probe forbids raw history body reads'));
          }
          return originalRead.call(fs.promises, file, ...args);
        };
        require(${JSON.stringify(file)});
      `, { ...options, eval: true });
      worker.on('message', message => { if (message?.syntheticProbe === 'blockedBodyRead') blockedBodyReads++; });
      return worker;
    }
  }
  client = new HistorySearchClient({ historyDir, WorkerClass: ProjectionOnlyWorker });
  const restarted = await client.search('keyword', 200, 'restarted');
  check('NewPackagedWorkerReusesIndexWithoutReadingBodies', restarted.ok && !restarted.partial
    && restarted.items.length === 64 && blockedBodyReads === 0, { blockedBodyReads });
  const restartedLegacy = await client.search('旧快照安全恢复唯一正文', 50, 'restarted');
  check('RestartedPackagedWorkerReusesRecoveredLegacyProjection', restartedLegacy.ok && !restartedLegacy.partial
    && restartedLegacy.items.length === 1 && restartedLegacy.items[0].turnId === 'legacy-empty-final' && blockedBodyReads === 0);
  await client.close(); client = new HistorySearchClient({ historyDir });
  const obsolete = client.search('keyword', 200, 'a'), newest = client.search('合成历史 3', 50, 'a');
  check('RapidInputSupersedesOldQuery', (await obsolete).canceled === true && (await newest).items.length > 0);
  const gone = client.search('keyword', 200, 'closed-window'); client.cancel('closed-window');
  check('ClosingSearchSettlesPendingRequest', (await gone).canceled === true);
  const firstFile = path.join(historyDir, items[0].id + '.json'); const c = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
  const firstProjection = path.join(projectionDir, c.id + '.json');
  const originalProjection = fs.readFileSync(firstProjection, 'utf8');
  c.turns[0].assistant = '更新后的独有匹配'; fs.writeFileSync(firstFile, JSON.stringify(c));
  check('SavedEditInvalidatesCacheWithoutActivityTimeChange', (await client.search('更新后的独有匹配', 50, 'a')).items[0]?.id === c.id);
  check('SavedEditReplacesPersistedProjection', fs.readFileSync(firstProjection, 'utf8') !== originalProjection
    && !(await client.search('keyword', 200, 'a')).items.some(item => item.id === c.id));
  fs.writeFileSync(index, JSON.stringify({ version: 2, items: items.slice(1) })); fs.unlinkSync(firstFile);
  check('DeletedConversationDoesNotReturnFromCache', (await client.search('更新后的独有匹配', 50, 'a')).items.length === 0);
  check('DeletedConversationProjectionIsPruned', !fs.existsSync(firstProjection));
  fs.writeFileSync(index, '{ broken index');
  check('IndexFailureIsNotReportedAsNoMatches', (await client.search('keyword', 50, 'a')).ok === false);
  fs.writeFileSync(index, JSON.stringify({ version: 2, items: items.slice(1) }));
  check('SearchRecoversAfterIndexRepair', (await client.search('keyword', 50, 'a')).ok === true);
  await client.close(); client = null;
  check('FixtureAvoidsRelayStartupAndSdk', !require.cache[path.join(root, 'main.js')] && !Object.keys(require.cache).some(file => file.includes('@anthropic-ai')));
}).catch(error => { report.failures.push(String(error.stack || error)); }).finally(async () => {
  if (client) await client.close(); clearTimeout(timeout); save(); console.log(JSON.stringify({ passed: report.checks.filter(c => c.ok).length, failures: report.failures })); app.exit(report.failures.length ? 1 : 0);
});
