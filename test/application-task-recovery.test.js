'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const { RUN_STATES } = require('../src/main/tasks/task-protocol');
const { TaskClock } = require('../src/main/tasks/task-clock');
const { registerApplicationLifecycle } = require('../src/main/app/application-lifecycle');
const { ownsMediaRecovery } = require('../src/main/media/media-task-bridge');
const bootstrapRequire = require('node:module').createRequire(path.join(__dirname, '../src/main/bootstrap.js'));

// Run only the production shutdown adapter with an isolated ledger. Loading
// bootstrap itself would launch Electron and resolve the real user-data path.
const bootstrap = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const interruptSource = bootstrap.match(/function interruptActiveShadowRuns\(reason\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(interruptSource, 'production exit adapter is present');
const bindInterrupt = new Function('taskLedger', 'flushShadowTaskEvents', 'RUN_STATES', 'console', 'require', 'app',
  `let mediaShuttingDown = false;\n${interruptSource}\nreturn interruptActiveShadowRuns;`);

function bindEventForwarder(ledger, runId) {
  const from = bootstrap.indexOf('  const onEvent = (evt) => {', bootstrap.indexOf('async function runClaudeRequest('));
  const to = bootstrap.indexOf('\n\n  let safeSessionId', from);
  assert.ok(from >= 0 && to > from, 'production main/mini/live/one-shot event wrapper is present');
  const forwarded = [], journaled = [], observed = [], continuity = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const variables = {
    taskLedger: ledger, runId, RUN_STATES, TaskClock,
    taskClock: new TaskClock({ startedAt: 1000, now: () => 2000 }),
    turnDeliveryService: null, taskContinuityHost: { observe: (_id, evt) => continuity.push(clone(evt)) },
    getConversationWorkspaces: () => ({ markContextCarried() {} }), resolvedWorkspace: { conversationId: 'synthetic' },
    journalClaudeEvent: (_id, evt) => journaled.push(clone(evt)),
    enqueueShadowClaudeEvent: (_id, evt) => observed.push(clone(evt)),
    flushShadowTaskEvents() {}, releaseTaskResource() {}, console,
    event: { sender: { send: (_channel, evt) => forwarded.push(clone(evt)) } },
  };
  const emit = new Function(...Object.keys(variables), `${bootstrap.slice(from, to)}\nreturn onEvent;`)(...Object.values(variables));
  return { emit, forwarded, journaled, observed, continuity };
}

for (const trigger of ['before-quit', 'window-all-closed']) {
  test(`${trigger} preserves APP_EXIT for running and queued work before teardown cancellation`, t => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-exit-recovery-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    const createdAt = '2026-08-24T10:00:00.000Z', exitAt = '2026-08-24T10:05:00.000Z';
    const ledger = new TaskLedger({ rootDir, now: () => new Date(exitAt), logger: { warn() {} } });
    ledger.create({ runId: 'running', state: RUN_STATES.RUNNING, createdAt });
    ledger.create({ runId: 'queued', createdAt });
    ledger.create({ runId: 'already-finished', state: RUN_STATES.RUNNING, createdAt });
    ledger.create({ runId: 'media-running', kind: 'video', state: RUN_STATES.RUNNING, createdAt });
    fs.mkdirSync(path.join(rootDir, 'media-tasks'));
    fs.writeFileSync(path.join(rootDir, 'media-tasks', 'media-running.json'), JSON.stringify({
      task: { id: 'media-running', runId: 'media-running', state: 'accepted', handle: { taskId: 'remote-video-job' } },
    }));
    const calls = [];
    const interrupt = bindInterrupt(ledger, () => {
      calls.push('shadow-events-flushed');
      ledger.terminal('already-finished', RUN_STATES.SUCCEEDED, { result: { summary: 'saved final answer' } });
    }, RUN_STATES, { warn: message => assert.fail(message) }, bootstrapRequire, { getPath: () => rootDir });
    const cancelFromTeardown = () => {
      calls.push('teardown-cancel');
      ledger.terminal('running', RUN_STATES.CANCELED);
      ledger.terminal('queued', RUN_STATES.CANCELED);
    };
    const app = new EventEmitter();
    app.whenReady = () => new Promise(() => {});
    app.quit = () => app.emit('before-quit', { preventDefault() {} });
    const jobs = new Map([['running', { kill: cancelFromTeardown }]]);
    registerApplicationLifecycle({
      app, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {},
      powerMonitor: { removeListener() {} }, globalShortcut: { unregisterAll() {} },
      windows: { isQuitting: true, markQuitting() {}, destroyTray() {} },
      scheduler: { shutdown: cancelFromTeardown }, settings: {}, history: {},
      getSkillDraftService: () => null, getExistingUsageStatsService: () => null,
      taskRuntime: {
        jobs, liveSessions: new Map(), resourceLeases: new Map(),
        interactions: { close: cancelFromTeardown }, getProgressStore: () => null,
        getOrchestrator: () => ({ shutdown: cancelFromTeardown }), getLedger: () => ledger,
        flushStreams: () => calls.push('streams-flushed'), flushEvents: () => calls.push('events-flushed'),
        interruptActiveRuns: reason => { calls.push('interrupt'); interrupt(reason); }, killLiveSession() {},
      },
      mini: { getChat: () => null, getHost: () => null }, memory: { hasPendingUsage: () => false },
      integrations: { attachmentDialog: { dispose() {} }, browserPanelTools: { dispose() {} }, workspaceTools: { dispose() {} } },
    });
    app.emit(trigger, { preventDefault() {} });
    assert.ok(calls.indexOf('events-flushed') < calls.indexOf('interrupt'));
    assert.ok(calls.indexOf('interrupt') < calls.indexOf('teardown-cancel'));
    for (const runId of ['running', 'queued']) {
      const run = ledger.get(runId);
      assert.equal(run.state, RUN_STATES.INTERRUPTED);
      assert.equal(run.result.error.code, 'APP_EXIT');
      assert.equal(run.recovery.lastActiveAt, runId === 'running' ? exitAt : createdAt);
    }
    assert.equal(ledger.get('media-running').state, RUN_STATES.RUNNING, 'remote media recovery retains ownership at exit');
    assert.equal(ledger.get('already-finished').state, RUN_STATES.SUCCEEDED);
    assert.equal(ledger.get('already-finished').result.summary, 'saved final answer');
    const restarted = new TaskLedger({ rootDir, logger: { warn() {} } });
    assert.equal(restarted.recover({
      at: '2026-08-25T12:00:00Z', retainQueued: false, shouldRetain: run => ownsMediaRecovery(run, rootDir),
    }).interrupted.length, 0);
    assert.equal(restarted.get('media-running').state, RUN_STATES.RUNNING, 'the same remote job remains recoverable after restart');
    assert.equal(restarted.get('running').recovery.lastActiveAt, exitAt);
    assert.equal(restarted.get('queued').result.error.code, 'APP_EXIT');
  });
}

test('late live/one-shot close carries APP_EXIT to every consumer only after the host committed it', t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-exit-event-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ledger = new TaskLedger({ rootDir, logger: { warn() {} } });
  for (const runId of ['app-exit', 'user-cancel', 'provider-error']) ledger.create({ runId, state: RUN_STATES.RUNNING });
  ledger.terminal('app-exit', RUN_STATES.INTERRUPTED, { result: { error: { code: 'APP_EXIT', message: 'Relay exited' } } });
  ledger.terminal('user-cancel', RUN_STATES.CANCELED);
  ledger.terminal('provider-error', RUN_STATES.FAILED, { result: { error: 'provider failed' } });
  for (const runId of ['app-exit', 'user-cancel', 'provider-error']) {
    const fixture = bindEventForwarder(ledger, runId);
    const raw = { jobId: runId, type: 'job-done', exitCode: -1,
      error: runId === 'provider-error' ? 'provider failed' : 'Claude 会话在返回本轮最终结果前结束',
      ...(runId === 'user-cancel' ? { aborted: true } : {}) };
    fixture.emit(raw);
    for (const collection of [fixture.forwarded, fixture.journaled, fixture.observed, fixture.continuity]) {
      assert.equal(collection.length, 1);
      const event = collection[0];
      assert.equal(event.relay_app_interruption, runId === 'app-exit' ? 'APP_EXIT' : undefined);
      assert.equal(event.interrupted, runId === 'app-exit' ? true : undefined);
      assert.equal(event.aborted, raw.aborted, 'explicit user abort semantics are preserved');
      assert.equal(event.error, raw.error, 'cause tagging does not rewrite diagnostics');
      assert.equal(event.relay_task_finished_at, 2000);
    }
    assert.equal(raw.relay_app_interruption, undefined, 'the SDK input object is not changed');
  }
  const untrusted = bindEventForwarder(ledger, 'user-cancel');
  untrusted.emit({ jobId: 'user-cancel', type: 'job-done', exitCode: -1, relay_app_interruption: 'APP_EXIT' });
  assert.equal(untrusted.forwarded[0].relay_app_interruption, undefined, 'the cause can only come from the host ledger');
  const child = bindEventForwarder(ledger, 'app-exit');
  child.emit({ jobId: 'app-exit', type: 'job-done', parent_tool_use_id: 'child-task', exitCode: -1 });
  assert.equal(child.forwarded[0].relay_app_interruption, undefined, 'child terminal events cannot pause the root task');
});
