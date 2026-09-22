'use strict';

// Validate an already-built application without starting Relay, installing it,
// contacting a model, or opening the user's profile. Usage:
// electron test/packaged-application-smoke.cjs --archive <resources/app.asar>
// Add --wsl-distribution <installed-name> to exercise the real Windows→WSL bridge.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const originalFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const archiveIndex = process.argv.indexOf('--archive');
const distributionIndex = process.argv.indexOf('--wsl-distribution');
const wslDistribution = distributionIndex >= 0 ? process.argv[distributionIndex + 1] : null;
const archive = path.resolve(archiveIndex >= 0 ? process.argv[archiveIndex + 1] : path.join(root, 'dist/win-unpacked/resources/app.asar'));
if (!fs.existsSync(archive)) throw Error('Build an isolated Windows package first and pass --archive <resources/app.asar>.');
const external = archive + '.unpacked';
const outputRoot = path.join(root, '.codex-tmp/packaged-application-smoke');
fs.mkdirSync(outputRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(outputRoot, 'run-'));
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
const report = { archive, fixture, checks: [], failures: [],
  scope: 'Actual built ASAR and unpacked workers, isolated synthetic data; no Relay main, installation or model calls.' };
const resources = path.dirname(archive);
const sourceManifest = require('../package.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => asar.extractFile(archive, path.normalize(file));
const normalize = file => file.replace(/\\/g, '/').replace(/^\//, '');
const makeDirectory = name => { const directory = path.join(fixture, name); fs.mkdirSync(directory, { recursive: true }); return directory; };
const cleanup = [];
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw Error(name);
}
function save() {
  report.counts = { passed: report.checks.filter(item => item.ok).length, failed: report.failures.length };
  const text = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(path.join(fixture, 'result.json'), text);
  fs.writeFileSync(path.join(outputRoot, 'latest.json'), text);
}
function runWorker(file, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData });
    cleanup.push(() => worker.terminate());
    let result, received = false;
    const timeout = setTimeout(() => { worker.terminate(); reject(Error('Worker timeout: ' + path.basename(file))); }, 15000);
    worker.once('message', value => { result = value; received = true; });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && received) resolve(result);
      else reject(Error('Worker did not finish successfully: ' + path.basename(file) + ' (' + code + ')'));
    });
  });
}

function verifyArchive() {
  const files = asar.listPackage(archive).map(normalize).filter(file => !asar.statFile(archive, path.normalize(file)).files);
  const manifest = JSON.parse(read('package.json'));
  check('ManifestIdentityAndDependenciesPreserved', manifest.name === sourceManifest.name && manifest.version === sourceManifest.version
    && manifest.main === 'main.js' && manifest.license === sourceManifest.license
    && JSON.stringify(manifest.dependencies) === JSON.stringify(sourceManifest.dependencies));
  check('OnlyThreeRootScriptEntrypoints', JSON.stringify(files.filter(file => !file.includes('/') && /\.(?:c?js)$/.test(file)).sort())
    === JSON.stringify(['browser-page-preload.js', 'main.js', 'preload.js']));
  check('PrivateAndDevelopmentDirectoriesExcluded', !files.some(file => /^(?:docs|design|build|test|\.git|\.codex-tmp|website)(?:\/|$)/.test(file)));
  const own = files.filter(file => !file.startsWith('node_modules/') && file !== 'package.json');
  check('AllPackagedApplicationFilesMatchCurrentSource', own.every(file => fs.existsSync(path.join(root, file))
    && hash(read(file)) === hash(fs.readFileSync(path.join(root, file)))), { files: own.length });
  for (const file of sourceManifest.build.asarUnpack.filter(file => !file.includes('*') && /\.(?:c?js)$/.test(file))) {
    check('UnpackedRuntime_' + file, asar.statFile(archive, path.normalize(file)).unpacked === true
      && fs.existsSync(path.join(external, file)) && hash(read(file)) === hash(fs.readFileSync(path.join(external, file))));
  }
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    check('LegalResource_' + name, hash(fs.readFileSync(path.join(resources, 'legal', name))) === hash(fs.readFileSync(path.join(root, name))));
  }
  const feed = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  check('UpdateFeedPreserved', feed.provider === 'github' && feed.owner === sourceManifest.build.publish.owner && feed.repo === sourceManifest.build.publish.repo);
  const binaries = files.filter(file => /claude-agent-sdk-[^/]+\/claude(?:\.exe)?$/.test(file)).sort();
  check('ExactlyTwoSupportedSdkRuntimes', JSON.stringify(binaries) === JSON.stringify([
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ]));
  for (const file of binaries) {
    const metadata = JSON.parse(read(path.posix.join(path.posix.dirname(file), 'package.json')));
    check('SdkVersionAndPhysicalBinary_' + path.posix.basename(file), metadata.version === sourceManifest.dependencies['@anthropic-ai/claude-agent-sdk']
      && asar.statFile(archive, path.normalize(file)).unpacked === true && hash(fs.readFileSync(path.join(external, file))) === hash(fs.readFileSync(path.join(root, file))));
  }
  const cli = spawnSync(path.join(external, binaries.find(file => file.endsWith('.exe'))), ['--version'], {
    cwd: fixture, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: fixture, TMP: fixture, USERPROFILE: fixture,
      CLAUDE_CONFIG_DIR: makeDirectory('claude-config') },
  });
  check('PackagedNativeSdkCliStarts', cli.status === 0 && /\d+\.\d+\.\d+.*Claude Code/.test(cli.stdout), cli.stdout.trim());
  report.archiveSha256 = hash(originalFs.readFileSync(archive));
}

async function verifyProgress() {
  const { TaskProgressClient } = require(path.join(archive, 'src/main/tasks/task-progress-client.js'));
  const rootDir = makeDirectory('progress'), warnings = [];
  const create = () => new TaskProgressClient({ rootDir, flushIntervalMs: 60000, logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) } });
  let client = create(); cleanup.push(() => client.close());
  check('ProgressWorkerPathIsPhysical', client.workerFile === path.join(external, 'src/main/tasks/task-progress-worker.js'));
  const runId = '77777777-7777-4777-8777-777777777777', epoch = 'packaged-layout-fixture';
  const envelope = (event, seq) => ({ type: 'claude.event', runId, epoch, seq, emittedAt: '2026-09-21T00:00:00Z', payload: { event: { ...event, jobId: runId } } });
  client.observe([envelope({ type: 'assistant', uuid: 'thinking', message: { id: 'message', content: [{ type: 'thinking', thinking: 'Synthetic packaged thinking' }] } }, 1),
    envelope({ type: 'assistant', uuid: 'stage', message: { id: 'message', content: [{ type: 'text', text: 'Synthetic stage output' }] } }, 2)]);
  await client.close(); client = create();
  const saved = await client.load(runId);
  check('ProgressSurvivesWorkerRestart', saved?.seq === 2 && saved.epoch === epoch && saved.activity.items.some(item => item.type === 'thinking')
    && saved.output.messages.some(message => message.blocks.some(block => block.text === 'Synthetic stage output')));
  check('PartialProgressDoesNotInventAFinalAnswer', saved.output.final === '' && saved.terminal === false);
  client.observe([envelope({ type: 'job-done', exitCode: -1, error: 'Synthetic interruption' }, 3)]);
  await client.close(); client = create();
  const interrupted = await client.load(runId);
  check('CloseFlushesInterruptedTask', interrupted?.seq === 3 && interrupted.terminal && interrupted.activity.error === 'Synthetic interruption');
  await client.close(); check('NoProgressWorkerWarnings', warnings.length === 0, warnings);
}

async function verifySkillsAndUsage() {
  const { SkillDraftClient } = require(path.join(archive, 'src/main/skills/skill-draft-client.js'));
  const skillsDir = makeDirectory('skills'), stagingDir = makeDirectory('staging');
  fs.writeFileSync(path.join(stagingDir, 'SKILL.md'), '---\nname: packaged-fixture\ndescription: Isolated package verification.\n---\n# Packaged fixture\n');
  const drafts = new SkillDraftClient({ skillsDir, draftsDir: makeDirectory('drafts') });
  cleanup.push(() => drafts.close());
  const draft = await drafts.createDraft({ skillName: 'packaged-fixture', stagingDir });
  const published = await drafts.publish(draft.id);
  check('DraftWorkerPublishesOnlySyntheticSkill', published.draft.status === 'published' && fs.existsSync(path.join(skillsDir, 'packaged-fixture/SKILL.md')));
  await drafts.close();
  const projectsRoot = makeDirectory('synthetic-sdk-projects');
  fs.writeFileSync(path.join(projectsRoot, 'session.jsonl'), '{"type":"user","message":{"content":"synthetic"}}\n');
  const skillUsage = await runWorker(path.join(external, 'src/main/skills/skill-usage-worker.js'), { projectsRoot });
  check('SkillUsageWorkerCompletes', skillUsage.ok && skillUsage.complete && skillUsage.scannedFiles === 1);
  const { UsageStatsService } = require(path.join(archive, 'src/main/usage/usage-stats-service.js'));
  const cacheDir = makeDirectory('usage-cache');
  const usage = new UsageStatsService({ historyDir: makeDirectory('history'), cacheDir, refreshIntervalMs: 60000 });
  cleanup.push(() => usage.destroy());
  check('UsageWorkerPathIsPhysical', usage.workerFile === path.join(external, 'src/main/usage/usage-stats-worker.js'));
  usage.recordUsage({ queryId: 'synthetic-query', sessionId: 'synthetic-session', resultId: 'synthetic-result', at: new Date().toISOString(),
    modelUsage: { synthetic: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 } } });
  const refreshed = await usage.refresh({ force: true });
  check('UsageWorkerAggregatesSyntheticCounters', refreshed.ok && usage.snapshot.windows['7'].tokens.totalTokens === 17);
  check('UsageWorkerFlushesBeforeClosing', (await usage.destroy()).ok && fs.existsSync(path.join(cacheDir, 'usage-events-v1.jsonl')));
}

async function verifyHistoryAndPreloads() {
  const { executeSessionOperation } = require(path.join(archive, 'src/main/sdk/sdk-session-history.js'));
  const sessions = await executeSessionOperation({ cwd: makeDirectory('sdk-workspace'), configDir: makeDirectory('sdk-history-config'), agentEnvironment: 'native' }, 'listSessions');
  check('HistoryWorkerLoadsActualSdkWithIsolatedConfig', Array.isArray(sessions) && sessions.length === 0);
  if (wslDistribution) {
    const cwd = makeDirectory('WSL 空 格/workspace'), configDir = makeDirectory('WSL 空 格/config');
    const history = await executeSessionOperation({ cwd, configDir, agentEnvironment: 'wsl', wslDistribution }, 'listSessions');
    check('WindowsToWslHistoryDispatchUsesPackagedWorker', Array.isArray(history) && history.length === 0);
    const { createAgentEnvironment } = require(path.join(archive, 'src/main/sdk/agent-environment.js'));
    const environment = createAgentEnvironment({ homeDir: fixture, configDir });
    const settings = await environment.inspectSettings({ cwd, settingSources: ['project'], wslDistribution });
    check('WindowsToWslSettingsDispatchUsesPackagedProbe', settings.ok === true);
  }
  for (const file of ['preload.js', 'browser-page-preload.js']) {
    const errors = [];
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(archive, file), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    cleanup.push(() => { if (!window.isDestroyed()) window.destroy(); });
    window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    await window.loadURL('data:text/html,<title>Isolated preload fixture</title><p>Package verification</p>');
    const bridge = await window.webContents.executeJavaScript('typeof window.api === "object" && typeof window.api.runClaude === "function"');
    check('SandboxedPreload_' + file, errors.length === 0 && (file !== 'preload.js' || bridge), errors);
    window.destroy();
  }
}

async function verifyTerminal() {
  const pty = require(path.join(archive, 'node_modules/node-pty'));
  const terminal = pty.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'), ['/d', '/s', '/c', 'echo PACKAGED_LAYOUT_PTY_OK'], {
    cwd: fixture, cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }, useConpty: true,
  });
  cleanup.push(() => { try { terminal.kill(); } catch (_) {} });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Packaged PTY timeout')), 10000);
    terminal.onData(text => { output += text; });
    terminal.onExit(event => { clearTimeout(timer); try { check('PackagedNativeTerminalExecutes', event.exitCode === 0 && output.includes('PACKAGED_LAYOUT_PTY_OK')); resolve(); } catch (error) { reject(error); } });
  });
}

const timeout = setTimeout(() => { report.failures.push('Acceptance timeout'); save(); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  verifyArchive();
  await verifyProgress();
  await verifySkillsAndUsage();
  await verifyHistoryAndPreloads();
  await verifyTerminal();
  check('RelayBootstrapWasNeverLoaded', !require.cache[path.join(archive, 'main.js')] && !require.cache[path.join(archive, 'src/main/bootstrap.js')]);
}).catch(error => { report.failures.push(String(error.stack || error)); }).finally(async () => {
  for (const close of cleanup.reverse()) try { await close(); } catch (error) { report.failures.push(error.message); }
  clearTimeout(timeout); save(); console.log(JSON.stringify({ ...report.counts, report: path.join(fixture, 'result.json'), failures: report.failures }));
  app.exit(report.failures.length ? 1 : 0);
});
