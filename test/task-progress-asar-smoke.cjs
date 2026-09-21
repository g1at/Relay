'use strict';
// Minimal packaged-runtime proof. Only synthetic progress is written beneath
// this fixture directory; no Relay main startup, user profile, model, or tools.
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const minimatchPackage = require('minimatch');
const matches = typeof minimatchPackage === 'function' ? minimatchPackage : minimatchPackage.minimatch;
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/task-progress-asar-smoke');
const archive = path.join(out, 'app.asar');
const progressDir = path.join(out, 'progress');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
const report = { checks: [], failures: [], versions: { electron: process.versions.electron, node: process.versions.node } };
let client, step = 'starting';
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, ...report }, null, 2));
function check(name, ok, detail) {
  step = name; report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  save(); console.log(name + ': ' + !!ok); if (!ok) throw Error(name);
}
const timeout = setTimeout(() => { report.failures.push('timeout: ' + step); save(); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  for (const generated of [archive, archive + '.unpacked', progressDir]) fs.rmSync(generated, { recursive: true, force: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = ['task-progress-client.js', 'task-progress-worker.js', 'task-progress-store.js', 'task-protocol.js',
    'renderer/activity-stream.js', 'renderer/assistant-output.js', 'renderer/task-continuity.js'];
  const packagedPatterns = manifest.build.files.filter(value => typeof value === 'string');
  const unpackedPatterns = manifest.build.asarUnpack;
  const included = file => packagedPatterns.some(pattern => !pattern.startsWith('!') && matches(file, pattern))
    && !packagedPatterns.some(pattern => pattern.startsWith('!') && matches(file, pattern.slice(1)));
  const unpacked = file => unpackedPatterns.some(pattern => matches(file, pattern));
  check('ReleaseManifestIncludesAllProgressRuntimeFiles', entries.every(included));
  check('ReleaseManifestUnpacksWorkerAndAllItsDependencies', entries.slice(1).every(unpacked));
  check('ReleaseManifestKeepsTheClientInsideAsar', !unpacked(entries[0]));
  // Explicit per-file unpack flags are resolved from the real release rules.
  // This avoids a fixture-only glob that could hide a missing packaging rule.
  await asar.createPackageFromStreams(archive, [
    { path: 'renderer', type: 'directory', unpacked: false },
    ...entries.map(file => ({ path: file, type: 'file', unpacked: unpacked(file),
      stat: fs.statSync(path.join(root, file)), streamGenerator: () => fs.createReadStream(path.join(root, file)) })),
  ]);
  for (const file of entries) {
    const external = fs.existsSync(path.join(archive + '.unpacked', file));
    check('ArchivePlacement_' + file, !!asar.statFile(archive, file).unpacked === unpacked(file) && external === unpacked(file));
  }
  const packedClientPath = path.join(archive, 'task-progress-client.js');
  const { TaskProgressClient } = require(packedClientPath);
  check('ClientLoadsFromTheRealAsarPath', require.resolve(packedClientPath) === packedClientPath && typeof TaskProgressClient === 'function');
  const warnings = [];
  const create = () => new TaskProgressClient({ rootDir: progressDir, flushIntervalMs: 60000,
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) } });
  const runId = '44444444-4444-4444-8444-444444444444';
  const epoch = 'packaged-progress-fixture';
  const events = [
    { type: 'assistant', uuid: 'packaged-thinking', message: { id: 'packaged-message', content: [{ type: 'thinking', thinking: '合成思考：验证打包后仍能保存任务过程。' }] } },
    { type: 'assistant', uuid: 'packaged-stage', message: { id: 'packaged-message', content: [{ type: 'text', text: '合成阶段输出：正在校验快照。' }] } },
    { type: 'assistant', uuid: 'packaged-tool', message: { id: 'packaged-message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'packaged-read', name: 'Read', input: { file_path: 'synthetic/report.md' } }] } },
    { type: 'user', uuid: 'packaged-tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'packaged-read', content: '合成结果：快照校验数据。' }] } },
  ];
  const envelope = (event, seq) => ({ type: 'claude.event', runId, epoch, seq,
    emittedAt: new Date(1800000000000 + seq * 1000).toISOString(), payload: { event: { ...event, jobId: runId } } });
  client = create();
  client.observe(events.map((event, index) => envelope(event, index + 1)));
  await client.flush();
  const snapshotFile = path.join(progressDir, runId + '.json');
  check('PackagedWorkerFlushCreatesTheCheckpoint', fs.existsSync(snapshotFile));
  await client.close(); client = null;
  const bytesBefore = fs.readFileSync(snapshotFile);
  client = create();
  const saved = await client.load(runId);
  check('NewPackagedClientReadsThePreviousWorkerCheckpoint', saved?.runId === runId && saved.epoch === epoch && saved.seq === 4);
  check('PackagedWorkerPreservesThinkingAndToolResult', saved.activity.items.some(item => item.type === 'thinking'
    && item.title === '合成思考：验证打包后仍能保存任务过程。') && saved.activity.items.some(item => item.toolUseId === 'packaged-read'
      && item.status === 'success' && item.resultConfirmed && item.result === '合成结果：快照校验数据。'));
  check('StageTextIsStoredWithoutInventingAFinalAnswer', saved.output.messages.some(message => message.blocks.some(block => block.text === '合成阶段输出：正在校验快照。'))
    && saved.output.final === '' && saved.output.answers.length === 0 && saved.displayOnly === true && saved.terminal === false);
  check('ReadingTheCheckpointDoesNotRewriteIt', fs.readFileSync(snapshotFile).equals(bytesBefore));
  client.observe([envelope({ type: 'job-done', exitCode: -1, error: '合成任务意外中断' }, 5)]);
  await client.close(); client = null;
  client = create();
  const terminal = await client.load(runId);
  check('PackagedWorkerCloseFlushesTheInterruptedTerminalState', terminal.seq === 5 && terminal.terminal === true
    && terminal.activity.phase === 'error' && terminal.activity.error === '合成任务意外中断' && terminal.output.final === '');
  check('TerminalPersistenceRetainsTheEarlierProcess', terminal.activity.items.filter(item => item.type === 'thinking').length === 1
    && terminal.activity.items.filter(item => item.type === 'tool').length === 1);
  await client.close(); client = null;
  check('WorkersExitCleanlyWithoutPersistenceWarnings', warnings.length === 0, warnings);
  check('FixtureNeverLoadsSdkOrRelayMain', !Object.keys(require.cache).some(file => /[\\/]@anthropic-ai[\\/]|[\\/]claude-sdk\.js$/.test(file))
    && !require.cache[path.join(root, 'main.js')]);
  step = 'completed';
}).catch(error => { report.failures.push(String(error.stack || error)); console.error(error); }).finally(async () => {
  if (client) { try { await client.close(); } catch (error) { report.failures.push(String(error.message || error)); } }
  save(); clearTimeout(timeout); app.exit(report.failures.length ? 1 : 0);
});
