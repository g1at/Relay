'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RUN_STATES,
  canTransition,
  assertTransition,
  selectTaskSnapshotRuns,
} = require('../task-protocol');
const { TaskLedger } = require('../task-ledger');

function makeLedger(t, overrides = {}) {
  let rootDir;
  try {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-ledger-'));
  } catch (_) {
    // Some sandboxed WSL runs inherit a Windows TEMP that is readable but not writable.
    const fallback = path.join(__dirname, '.task-ledger-tmp');
    fs.mkdirSync(fallback, { recursive: true });
    rootDir = fs.mkdtempSync(path.join(fallback, 'ledger-'));
  }
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let tick = 0;
  const events = [];
  const ledger = new TaskLedger({
    rootDir,
    now: () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++)),
    idFactory: () => `generated-${tick}`,
    onChange: (event) => events.push(event),
    logger: { warn() {} },
    ...overrides,
  });
  return { ledger, rootDir, events };
}

test('协议仅允许合法状态迁移，并容忍 starting 直接完成', () => {
  assert.equal(canTransition(RUN_STATES.QUEUED, RUN_STATES.STARTING), true);
  assert.equal(canTransition(RUN_STATES.STARTING, RUN_STATES.SUCCEEDED), true);
  assert.equal(canTransition(RUN_STATES.QUEUED, RUN_STATES.SUCCEEDED), false);
  assert.equal(canTransition(RUN_STATES.SUCCEEDED, RUN_STATES.RUNNING), false);
  assert.throws(
    () => assertTransition(RUN_STATES.WAITING_USER, RUN_STATES.SUCCEEDED),
    (error) => error.code === 'INVALID_RUN_TRANSITION',
  );
});

test('任务快照截断历史终态时仍完整保留所有非终态任务', () => {
  const terminal = Array.from({ length: 205 }, (_, index) => ({
    runId: `done-${index}`,
    state: RUN_STATES.SUCCEEDED,
  }));
  const active = [
    { runId: 'old-running', state: RUN_STATES.RUNNING },
    { runId: 'old-waiting', state: RUN_STATES.WAITING_USER },
  ];
  const selected = selectTaskSnapshotRuns([...terminal, ...active], { limit: 200 });
  assert.equal(selected.filter((run) => run.state === RUN_STATES.SUCCEEDED).length, 200);
  assert.deepEqual(
    selected.filter((run) => run.state !== RUN_STATES.SUCCEEDED).map((run) => run.runId),
    ['old-running', 'old-waiting'],
  );
});

test('create/get/update/list 持久化 revision，并默认按更新时间倒序', (t) => {
  const { ledger, rootDir, events } = makeLedger(t);
  const first = ledger.create({ runId: 'run-one', title: 'First', kind: 'chat' });
  const second = ledger.create({ runId: 'run-two', title: 'Second', kind: 'image' });
  const started = ledger.update(first.runId, {
    state: RUN_STATES.STARTING,
    phase: 'booting',
  }, { expectedRevision: 1 });

  assert.equal(first.revision, 1);
  assert.equal(started.revision, 2);
  assert.equal(started.startedAt, started.updatedAt);
  assert.equal(ledger.get('run-one').phase, 'booting');
  assert.deepEqual(ledger.list().map((run) => run.runId), ['run-one', 'run-two']);
  assert.deepEqual(ledger.list({ kind: 'image' }).map((run) => run.runId), ['run-two']);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'run.upsert');
  assert.equal(events[0].previous, null);
  assert.equal(events[2].previous.revision, 1);
  assert.equal(fs.existsSync(path.join(rootDir, 'runs', 'run-one.json')), true);
  assert.equal(fs.existsSync(path.join(rootDir, 'index.json')), true);
  assert.equal(fs.readdirSync(path.join(rootDir, 'runs')).some((name) => name.endsWith('.tmp')), false);

  assert.throws(
    () => ledger.update('run-one', { phase: 'stale' }, { expectedRevision: 1 }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
});

test('空更新不增加 revision 或发送事件，非法迁移和 update 终态被拒绝', (t) => {
  const { ledger, events } = makeLedger(t);
  const created = ledger.create({ runId: 'run-state' });
  const unchanged = ledger.update(created.runId, {});
  assert.equal(unchanged.revision, 1);
  assert.equal(events.length, 1);

  assert.throws(
    () => ledger.update(created.runId, { state: RUN_STATES.RUNNING }),
    (error) => error.code === 'INVALID_RUN_TRANSITION',
  );
  assert.throws(
    () => ledger.update(created.runId, { state: RUN_STATES.FAILED }),
    (error) => error.code === 'USE_TERMINAL_API',
  );
});

test('terminal 首次写入获胜，重复或冲突终态幂等且不再次发事件', (t) => {
  const { ledger, events } = makeLedger(t);
  ledger.create({ runId: 'run-terminal' });
  const starting = ledger.update('run-terminal', { state: RUN_STATES.STARTING });
  const completed = ledger.terminal('run-terminal', RUN_STATES.SUCCEEDED, {
    result: { summary: 'done' },
    executorState: 'draining',
  }, { expectedRevision: starting.revision });
  const duplicate = ledger.terminal('run-terminal', RUN_STATES.FAILED, {
    result: { error: 'late failure' },
  }, { expectedRevision: starting.revision });

  assert.equal(completed.state, RUN_STATES.SUCCEEDED);
  assert.equal(completed.revision, 3);
  assert.equal(completed.result.summary, 'done');
  assert.equal(completed.executorState, 'draining');
  assert.deepEqual(duplicate, completed);
  assert.equal(events.length, 3);
  assert.throws(
    () => ledger.update('run-terminal', { phase: 'late' }),
    (error) => error.code === 'RUN_TERMINAL',
  );
});

test('recover 保留从未启动的队列项，其余非终态统一中断', (t) => {
  const { ledger, events } = makeLedger(t);
  const queued = ledger.create({ runId: 'queued-safe' });
  ledger.create({ runId: 'was-starting', state: RUN_STATES.STARTING });
  ledger.create({ runId: 'was-running', state: RUN_STATES.RUNNING });
  ledger.create({ runId: 'was-waiting', state: RUN_STATES.WAITING_USER });
  ledger.create({ runId: 'was-stopping', state: RUN_STATES.STOPPING });
  const failed = ledger.create({ runId: 'already-failed' });
  ledger.terminal(failed.runId, RUN_STATES.FAILED);
  const beforeRecoveryEvents = events.length;

  const recovered = ledger.recover({ reason: 'test restart', at: '2026-08-25T01:02:03Z' });
  assert.deepEqual(recovered.retainedQueued.map((run) => run.runId), [queued.runId]);
  assert.equal(recovered.interrupted.length, 4);
  assert.equal(recovered.unchangedTerminal.length, 1);
  for (const run of recovered.interrupted) {
    assert.equal(run.state, RUN_STATES.INTERRUPTED);
    assert.equal(run.result.error.code, 'APP_RESTART');
    assert.equal(run.endedAt, '2026-08-25T01:02:03.000Z');
  }
  assert.equal(ledger.get(queued.runId).revision, queued.revision);
  assert.equal(events.length - beforeRecoveryEvents, 4);
});

test('recover 可在内存队列丢失时中断从未启动的队列项', (t) => {
  const { ledger } = makeLedger(t);
  ledger.create({ runId: 'orphaned-queued' });
  const recovered = ledger.recover({ retainQueued: false, reason: 'queue lost' });
  assert.equal(recovered.retainedQueued.length, 0);
  assert.deepEqual(recovered.interrupted.map((run) => run.runId), ['orphaned-queued']);
  assert.equal(ledger.get('orphaned-queued').state, RUN_STATES.INTERRUPTED);
});

test('启动恢复可不复制终态正文，仍完整中断活跃与丢失队列任务', (t) => {
  const { ledger, rootDir } = makeLedger(t);
  ledger.create({ runId: 'finished', state: RUN_STATES.STARTING });
  ledger.terminal('finished', RUN_STATES.SUCCEEDED, { result: { summary: 'retained result' } });
  ledger.create({ runId: 'active', state: RUN_STATES.RUNNING });
  ledger.create({ runId: 'queued' });
  const file = path.join(rootDir, 'runs', 'finished.json');
  const completed = fs.readFileSync(file, 'utf8');
  Object.defineProperty(ledger._runs.get('finished'), 'result', {
    get() { throw new Error('Active-only recovery must not read completed result bodies'); },
  });
  const recovered = ledger.recover({ includeTerminal: false, retainQueued: false });
  assert.deepEqual(recovered.unchangedTerminal, []);
  assert.deepEqual(recovered.interrupted.map(run => run.runId).sort(), ['active', 'queued']);
  assert.ok(recovered.interrupted.every(run => run.state === RUN_STATES.INTERRUPTED));
  assert.equal(fs.readFileSync(file, 'utf8'), completed);
});

test('prune 永远保留非终态任务，并限制终态记录数量', (t) => {
  const { ledger, rootDir } = makeLedger(t);
  ledger.create({ runId: 'active-old', state: RUN_STATES.RUNNING });
  for (const id of ['done-one', 'done-two', 'done-three']) {
    ledger.create({ runId: id, state: RUN_STATES.STARTING });
    ledger.terminal(id, RUN_STATES.SUCCEEDED);
  }

  const pruned = ledger.prune({ maxTerminalRuns: 2, maxAgeMs: Number.MAX_SAFE_INTEGER });
  assert.equal(pruned.removed.length, 1);
  assert.equal(ledger.get('active-old').state, RUN_STATES.RUNNING);
  assert.equal(ledger.list({ terminal: true }).length, 2);
  assert.equal(fs.existsSync(path.join(rootDir, 'runs', `${pruned.removed[0]}.json`)), false);
});

test('无淘汰时保留原始索引，已有待写进展仍会刷新索引', (t) => {
  const { ledger, rootDir } = makeLedger(t);
  ledger.create({ runId: 'running', state: RUN_STATES.RUNNING });
  const file = path.join(rootDir, 'index.json');
  const original = fs.readFileSync(file, 'utf8');
  const oldTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, oldTime, oldTime);
  // Account for the external metadata-only touch before measuring no-op prune.
  ledger.list();
  const before = fs.statSync(file);
  assert.deepEqual(ledger.prune(), { removed: [], retained: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  ledger.update('running', { title: 'progress remains durable' });
  assert.equal(ledger._indexDirty, true);
  ledger.prune();
  assert.equal(ledger._indexDirty, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].title, 'progress remains durable');
});

test('索引损坏可从权威 run 文件重建，onChange 异常不影响落盘', (t) => {
  const { ledger, rootDir } = makeLedger(t, {
    onChange() { throw new Error('renderer closed'); },
  });
  ledger.create({ runId: 'durable-run' });
  fs.writeFileSync(path.join(rootDir, 'index.json'), '{broken', 'utf8');

  assert.deepEqual(ledger.list().map((run) => run.runId), ['durable-run']);
  const index = JSON.parse(fs.readFileSync(path.join(rootDir, 'index.json'), 'utf8'));
  assert.equal(index.items[0].runId, 'durable-run');
});

test('runId 拒绝路径字符，运行记录不能写到账本目录之外', (t) => {
  const { ledger } = makeLedger(t);
  assert.throws(
    () => ledger.create({ runId: '../escape' }),
    (error) => error.code === 'INVALID_RUN_ID',
  );
  assert.throws(
    () => ledger.get('C:\\escape'),
    (error) => error.code === 'INVALID_RUN_ID',
  );
});
