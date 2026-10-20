'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
const { createConversationDeletion } = require('../src/main/app/conversation-deletion');

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

function fixture(t, { withFiles = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-delete-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, 'conversation-workspaces.json');
  const statePath = path.join(root, 'conversation-deletions.json');
  const scratchRoot = path.join(root, 'scratch');
  const scratchDir = path.join(scratchRoot, ID);
  const outputDir = path.join(root, 'outputs');
  fs.mkdirSync(scratchRoot); fs.mkdirSync(outputDir);
  const history = path.join(root, ID + '.json');
  const otherHistory = path.join(root, OTHER + '.json');
  fs.writeFileSync(history, JSON.stringify({ id: ID, turns: [{ user: '你好' }] }));
  // Deliberately invalid and independent: deleting ID must never try to parse it.
  fs.writeFileSync(otherHistory, '{ unrelated unreadable history fixture');
  const records = {
    [ID]: { cwd: root, outputDir, scratchRoot, scratchDir,
      scratchRootReal: fs.realpathSync(scratchRoot), browseScope: { projectId: null, cwd: root } },
    [OTHER]: { cwd: path.join(root, 'other-workspace'), outputDir: path.join(root, 'other-output'),
      scratchRoot, scratchDir: path.join(scratchRoot, OTHER), scratchRootReal: fs.realpathSync(scratchRoot) },
  };
  const retainedFiles = [];
  if (withFiles) {
    const previousRoot = path.join(root, 'previous');
    const targetRoot = path.join(root, 'migrating');
    const token = '1234567890abcdef1234567890abcdef';
    fs.mkdirSync(previousRoot); fs.mkdirSync(targetRoot);
    const previousDir = path.join(previousRoot, ID);
    const stagingDir = path.join(targetRoot, '.relay-migrate-' + ID + '-' + token);
    const targetDir = path.join(targetRoot, ID);
    records[ID].scratchPrevious = [{ root: previousRoot, dir: previousDir, realRoot: fs.realpathSync(previousRoot) }];
    records[ID].scratchMigration = { token, root: targetRoot, realRoot: fs.realpathSync(targetRoot),
      sourceDir: scratchDir, stagingDir, targetDir };
    for (const dir of [scratchDir, previousDir, stagingDir, targetDir]) {
      fs.mkdirSync(dir);
      const file = path.join(dir, 'retained-result.txt');
      fs.writeFileSync(file, 'preserve this generated result');
      retainedFiles.push(file);
      if ([stagingDir, targetDir].includes(dir)) fs.writeFileSync(path.join(dir, '.relay-migration-' + token + '.json'), JSON.stringify({ conversationId: ID, token, source: scratchDir, target: targetDir }));
    }
  }
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, items: records }));
  let historyReads = 0, preparations = 0, historyRemovals = 0;
  const forbidHistoryRead = () => { historyReads++; throw new Error('Deletion must not inspect conversation bodies'); };
  const workspaces = createConversationWorkspaces({ homeDir: root, registryPath, scratchBaseDir: scratchRoot,
    loadConversation: forbidHistoryRead, loadConversationForCleanup: forbidHistoryRead });
  const options = {
    statePath,
    stopConversation: async () => ({ stopConfirmed: true }),
    removeScratch: id => { preparations++; return workspaces.removeForHistoryDeletion(id); },
    removeHistory: async id => { assert.equal(id, ID); historyRemovals++; await fs.promises.unlink(history); },
  };
  return { root, registryPath, statePath, scratchRoot, scratchDir, history, otherHistory, records,
    retainedFiles, workspaces, options,
    counts: () => ({ historyReads, preparations, historyRemovals }),
    registry: () => JSON.parse(fs.readFileSync(registryPath, 'utf8')).items,
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')).items,
  };
}

test('deleting a greeting with absent scratch inspects no conversation body and changes no other ownership', async t => {
  const f = fixture(t), otherBefore = fs.readFileSync(f.otherHistory, 'utf8');
  let otherPathChecks = 0;
  const otherRoot = f.records[OTHER].scratchDir;
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (...args) => {
    if (String(args[0]).startsWith(otherRoot)) { otherPathChecks++; throw new Error('Other scratch inspected'); }
    return originalLstat(...args);
  });
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.ok, true);
  assert.equal(result.scratchRetained, undefined);
  assert.equal(result.cleanupWarning, undefined);
  assert.equal(fs.existsSync(f.history), false);
  assert.equal(fs.readFileSync(f.otherHistory, 'utf8'), otherBefore);
  assert.deepEqual(f.counts(), { historyReads: 0, preparations: 1, historyRemovals: 1 });
  assert.equal(otherPathChecks, 0);
  const registry = f.registry();
  assert.deepEqual(registry[OTHER], f.records[OTHER]);
  assert.equal(registry[ID].scratchDir, undefined);
  assert.equal(registry[ID].cwd, f.records[ID].cwd);
  assert.equal(registry[ID].outputDir, f.records[ID].outputDir);
  assert.deepEqual(registry[ID].browseScope, f.records[ID].browseScope);
});

test('deletion removes only the selected current, previous and migration scratch, preserving outputs and other history', async t => {
  const f = fixture(t, { withFiles: true });
  const deliverable = path.join(f.records[ID].outputDir, 'report.pdf');
  fs.writeFileSync(deliverable, 'manual cleanup');
  const result = await createConversationDeletion(f.options).delete(ID);
  assert.equal(result.ok, true); assert.equal(result.cleanupWarning, undefined);
  assert.equal(result.fileCleanup.removedPaths.length, 4);
  assert.equal(fs.existsSync(f.history), false);
  for (const file of f.retainedFiles) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(deliverable, 'utf8'), 'manual cleanup');
  assert.equal(fs.existsSync(f.otherHistory), true);
  assert.equal(f.registry()[ID].scratchDir, undefined);
  assert.deepEqual(f.registry()[OTHER], f.records[OTHER]);
  assert.equal(f.state()[ID].status, 'deleted');
  const repeated = await createConversationDeletion(f.options).delete(ID);
  assert.equal(repeated.alreadyDeleted, true);
  assert.deepEqual(repeated.fileCleanup, result.fileCleanup);
  assert.deepEqual(f.counts(), { historyReads: 0, preparations: 1, historyRemovals: 1 });
});

test('persisting cleanup result failure retains the history and retries safely after restart', async t => {
  const f = fixture(t, { withFiles: true });
  let writes = 0;
  const io = Object.create(fs);
  io.renameSync = (...args) => {
    if (++writes === 2) throw Object.assign(new Error('Synthetic cleanup state failure'), { code: 'ENOSPC' });
    return fs.renameSync(...args);
  };
  const options = { ...f.options, fileSystem: io };
  const failed = await createConversationDeletion(options).delete(ID);
  assert.equal(failed.ok, false); assert.equal(fs.existsSync(f.history), true);
  assert.equal(f.counts().historyRemovals, 0); assert.equal(f.counts().historyReads, 0);
  for (const file of f.retainedFiles) assert.equal(fs.existsSync(file), false);
  assert.equal(f.state()[ID].status, 'deleting');
  const restarted = createConversationDeletion(options);
  assert.equal(restarted.canWrite(ID), false);
  const result = await restarted.delete(ID);
  assert.equal(result.ok, true); assert.equal(fs.existsSync(f.history), false);
  assert.equal(f.state()[ID].status, 'deleted');
});



function productionDeletion(f, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
  const start = source.indexOf('function getConversationDeletion() {');
  const end = source.indexOf('\nfunction deleteConversation(id)', start);
  assert.ok(start >= 0 && end > start, 'production deletion factory remains extractable');
  const calls = [];
  const context = {
    require: name => {
      if (name === './app/conversation-deletion') return { createConversationDeletion };
      if (name === './app/conversation-running') return require('../src/main/app/conversation-running');
      throw new Error('Unexpected production dependency: ' + name);
    },
    path, app: { getPath: () => f.root }, conversationDeletionService: null,
    scratchMigrationService: null, miniChat: null,
    liveSessions: new Map(), liveTurnControls: null, jobs: new Map(),
    conversationRuntimes: { stop: async id => { calls.push(['stop', id]); return { stopConfirmed: true }; } },
    getConversationWorkspaces: () => ({
      removeForHistoryDeletion: id => { calls.push(['scratch', id]); return f.workspaces.removeForHistoryDeletion(id); },
    }),
    historyStore: { removeConversationRecord: (id, options) => {
      assert.equal(id, ID); assert.equal(options.loadRecord, false);
      calls.push(['history', id]); fs.unlinkSync(f.history);
    } },
    taskLedger: { list: () => [], get: () => null },
    taskProgressStore: { remove: async id => { calls.push(['progress', id]); } },
    getTurnDeliveryService: () => ({ forgetConversation: async id => { calls.push(['deliveries', id]); } }),
    liveTombstones: new Set(),
    ...overrides,
  };
  const service = require('node:vm').runInNewContext(source.slice(start, end) + '\ngetConversationDeletion()', context);
  return { service, context, calls };
}

test('production deletion wiring reports success when post-delete task ledger cleanup fails', async t => {
  const f = fixture(t);
  let removed = false, cleanupAttempts = 0;
  const { service } = productionDeletion(f, {
    historyStore: { removeConversationRecord: (id, options) => {
      assert.equal(id, ID); assert.equal(options.loadRecord, false);
      fs.unlinkSync(f.history); removed = true;
    } },
    taskLedger: { list: filters => {
      if (filters.terminal === false) return [];
      assert.equal(filters.conversationId, ID);
      assert.equal(removed, true, 'bookkeeping runs only after the selected history was removed');
      cleanupAttempts++;
      throw new Error('Synthetic post-delete ledger read failure');
    }, get: () => null },
  });
  const result = await service.delete(ID);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(f.history), false);
  assert.equal(f.state()[ID].status, 'deleted');
  assert.equal(cleanupAttempts, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'CONVERSATION_DELETE_CLEANUP_FAILED');
  assert.match(result.cleanupWarning, /Synthetic post-delete ledger read failure/);
  assert.equal(service.canWrite(ID), false);
  assert.equal(f.counts().historyReads, 0);
});

test('production deletion rejects active tasks without canceling, pausing or stopping their executor', async t => {
  for (const kind of ['live', 'ledger', 'queued', 'mini', 'background', 'stopping']) {
    const f = fixture(t, { withFiles: true }), dangerousCalls = [];
    const cancel = () => { dangerousCalls.push('cancel'); };
    const pause = () => { dangerousCalls.push('pause'); };
    const liveSessions = new Map();
    if (kind === 'live') liveSessions.set(ID, { busy: true, interrupt: cancel, child: { kill: cancel } });
    if (kind === 'background') liveSessions.set(ID, { busy: false, backgroundTaskTracker: { size: 1 } });
    const activeRun = { runId: 'run-' + kind, state: kind === 'queued' ? 'queued' : 'running',
      source: { type: 'conversation', conversationId: ID } };
    const { service, calls } = productionDeletion(f, {
      liveSessions,
      liveTurnControls: { isStopping: id => kind === 'stopping' && id === ID, pause, stop: cancel },
      taskLedger: {
        list: () => ['ledger', 'queued'].includes(kind) ? [activeRun] : [],
        get: () => activeRun, cancel, terminal: cancel,
      },
      taskOrchestrator: { cancel, cancelTask: cancel, pause },
      miniChat: kind === 'mini' ? {
        getConversationId: () => ID, isRunning: () => true,
        cancel, pause, stop: cancel, forgetConversation: cancel,
      } : null,
    });
    const before = fs.readFileSync(f.history, 'utf8');
    const result = await service.delete(ID);
    assert.equal(result.ok, false, kind);
    assert.equal(result.code, 'CONVERSATION_RUNNING', kind);
    assert.equal(result.retryable, false, kind);
    assert.deepEqual(dangerousCalls, [], kind);
    assert.deepEqual(calls, [], kind);
    assert.equal(fs.existsSync(f.statePath), false, kind);
    assert.equal(fs.readFileSync(f.history, 'utf8'), before, kind);
    for (const file of f.retainedFiles) assert.equal(fs.existsSync(file), true, kind);
    assert.equal(service.canWrite(ID), true, kind);
  }
});

test('production deletion fails closed for missing ledger or active jobs without conversation ownership', async t => {
  for (const condition of ['missing-ledger', 'missing-run', 'missing-source', 'missing-owner']) {
    const f = fixture(t, { withFiles: true });
    const jobs = new Map(condition === 'missing-ledger' ? [] : [['unattributed-job', { kill() { throw Error('Must not kill an unattributed job'); } }]]);
    const taskLedger = condition === 'missing-ledger' ? null : {
      list: () => [],
      get: () => condition === 'missing-run' ? undefined : condition === 'missing-source' ? {} : { source: {} },
    };
    const { service, calls } = productionDeletion(f, { jobs, taskLedger });
    const result = await service.delete(ID);
    assert.equal(result.ok, false, condition);
    assert.equal(result.code, 'CONVERSATION_RUNNING_STATE_UNAVAILABLE', condition);
    assert.deepEqual(calls, [], condition);
    assert.equal(fs.existsSync(f.statePath), false, condition);
    assert.equal(fs.existsSync(f.history), true, condition);
    for (const file of f.retainedFiles) assert.equal(fs.existsSync(file), true, condition);
    assert.equal(service.canWrite(ID), true, condition);
  }
});

test('production deletion allows an idle conversation while a separate owned job continues', async t => {
  const f = fixture(t, { withFiles: true }), activeRun = {
    runId: 'other-job', state: 'running', source: { type: 'conversation', conversationId: OTHER },
  };
  let killed = false;
  const jobs = new Map([['other-job', { kill() { killed = true; } }]]);
  const { service, calls } = productionDeletion(f, {
    jobs,
    taskLedger: { list: filters => filters.terminal === false && filters.conversationId === OTHER ? [activeRun] : [], get: id => id === 'other-job' ? activeRun : undefined },
  });
  const result = await service.delete(ID);
  assert.equal(result.ok, true);
  assert.equal(killed, false);
  assert.equal(jobs.has('other-job'), true);
  assert.equal(fs.existsSync(f.history), false);
  assert.equal(fs.existsSync(f.otherHistory), true);
  assert.deepEqual(calls.map(([name]) => name), ['stop', 'scratch', 'history', 'deliveries']);
});
