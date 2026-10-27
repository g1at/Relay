'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const { _execTool: execTool } = require('../src/main/scheduling/cron-mcp');
const schedulerPath = require.resolve('../src/main/scheduling/scheduler');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function freshScheduler(spawn = () => { throw new Error('Unexpected native command execution'); }) {
  const savedSpawn = childProcess.spawn;
  childProcess.spawn = spawn;
  delete require.cache[schedulerPath];
  try { return require(schedulerPath); }
  finally { childProcess.spawn = savedSpawn; }
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cron-service-'));
  const file = path.join(root, 'schedules.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [], runs: [] }));
  const scheduler = freshScheduler(overrides.spawn);
  const notifications = [];
  const finished = [];
  const deps = {
    userDataDir: root,
    runClaudeJob() { throw new Error('Unexpected model execution'); },
    buildMemoryHint: () => '',
    saveConversation: () => {},
    loadConversation: () => null,
    readAppSettings: () => ({ allowCommandTasks: true }),
    notify: () => {}, refreshTray: () => {},
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel) => notifications.push(channel) } }),
    taskRunStart: ({ runId }) => runId,
    taskRunFinish: (runId, result) => finished.push({ runId, result }),
    ...overrides,
  };
  // CRUD must reschedule synchronously through the service, not depend on fs.watch.
  const savedWatch = fs.watch;
  fs.watch = () => ({ close() {} });
  try { scheduler.init(deps); }
  finally { fs.watch = savedWatch; }
  t.after(() => {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    delete require.cache[schedulerPath];
  });
  return { scheduler, root, file, notifications, finished };
}
function text(result) { return result.content.map((part) => part.text || '').join('\n'); }
async function ok(scheduler, name, args) {
  const result = await execTool(scheduler, name, args);
  assert.notEqual(result.isError, true, text(result));
  return result;
}
async function waitFor(read, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

// Uses a captured fake spawn and a held resource lease: no shell or model is run.
test('MCP and scheduler share a durable runId from queued receipt through duplicate rejection and completion', async (t) => {
  const lease = deferred();
  let child = null;
  let released = 0;
  const { scheduler, root, file, finished } = fixture(t, {
    taskRunAcquire: () => lease.promise,
    taskRunRelease: () => { released += 1; },
    spawn(command, args, options) {
      assert.equal(command, 'powershell.exe');
      assert.equal(options.cwd, root);
      child = new EventEmitter();
      child.pid = 123456;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    },
  });
  const created = await ok(scheduler, 'cron_add', {
    name: 'fixture command', type: 'command', command: 'Write-Output fixture',
    workingDir: root, everyMs: 3600000,
  });
  const id = created.structuredContent.task.id;
  const originalNextRunAt = scheduler.get(id).nextRunAt;
  const received = await ok(scheduler, 'cron_run', { query: id });
  const receipt = received.structuredContent;
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.taskId, id);
  assert.ok(receipt.runId);
  assert.equal(child, null, 'queued receipt must precede executor launch');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.runs.length, 1);
  assert.equal(stored.runs[0].runId, receipt.runId);
  assert.equal(stored.runs[0].status, 'queued');
  assert.equal(stored.tasks[0].nextRunAt, originalNextRunAt);
  assert.equal(Object.hasOwn(stored.tasks[0], 'runNowAt'), false);

  const duplicate = await execTool(scheduler, 'cron_run', { query: id });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.status, 'already_running');
  assert.equal(duplicate.structuredContent.runId, receipt.runId);
  assert.equal(scheduler.runs(id).length, 1, 'manual duplicate is not a new execution');

  lease.resolve({});
  await waitFor(() => child, 'fake command did not start');
  assert.equal(scheduler.runs(id)[0].status, 'running');
  child.stdout.end('fixture complete\n');
  child.exitCode = 0;
  child.emit('close', 0);
  await waitFor(() => scheduler.runs(id).find((run) => run.runId === receipt.runId && run.status === 'ok'), 'terminal row not persisted');
  const history = JSON.parse(text(await ok(scheduler, 'cron_runs', { query: id })));
  assert.equal(history.length, 1);
  assert.equal(history[0].runId, receipt.runId);
  assert.equal(history[0].status, 'ok');
  assert.equal(history[0].summary, 'fixture complete');
  assert.ok(history[0].startedAt);
  assert.ok(history[0].endedAt);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].runId, receipt.runId);
  await waitFor(() => released === 1, 'resource lease not released');
});

test('MCP CRUD immediately reschedules and notifies the UI without a file watcher', async (t) => {
  const { scheduler, notifications } = fixture(t);
  const firstAt = new Date(Date.now() + 3600000).toISOString();
  const secondAt = new Date(Date.now() + 7200000).toISOString();
  const created = await ok(scheduler, 'cron_add', { name: 'future fixture', prompt: 'no execution', at: firstAt });
  const id = created.structuredContent.task.id;
  assert.equal(scheduler.get(id).nextRunAt, firstAt);
  assert.equal(scheduler.nextTaskHint().at, Date.parse(firstAt));
  const afterCreate = notifications.length;
  await ok(scheduler, 'cron_update', { query: id, at: secondAt });
  assert.equal(scheduler.get(id).nextRunAt, secondAt);
  assert.equal(scheduler.nextTaskHint().at, Date.parse(secondAt));
  assert.ok(notifications.length > afterCreate);
  await ok(scheduler, 'cron_toggle', { query: id, enabled: false });
  assert.equal(scheduler.get(id).enabled, false);
  assert.equal(scheduler.nextTaskHint(), null);
  await ok(scheduler, 'cron_toggle', { query: id, enabled: true });
  assert.equal(scheduler.nextTaskHint().at, Date.parse(secondAt));
  await ok(scheduler, 'cron_remove', { query: id });
  assert.deepEqual(scheduler.list(), []);
  assert.equal(scheduler.nextTaskHint(), null);
});

test('MCP forwards shared-store corruption as errors and never overwrites corrupted data', async (t) => {
  const { scheduler, file } = fixture(t);
  await ok(scheduler, 'cron_add', { name: 'fixture', prompt: 'no execution', everyMs: 3600000 });
  const corrupted = '{ invalid scheduled store';
  fs.writeFileSync(file, corrupted);
  for (const [name, args] of [
    ['cron_list', {}], ['cron_get', { query: 'fixture' }],
    ['cron_run', { query: 'fixture' }], ['cron_remove', { query: 'fixture' }],
    ['cron_add', { name: 'another', prompt: 'x', everyMs: 3600000 }],
  ]) {
    const result = await execTool(scheduler, name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.ok, false, name);
    assert.doesNotMatch(text(result), /已创建|已删除|已触发|当前没有任何/);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupted, name);
  }
});

test('MCP returns unavailable errors for an uninitialized or stopped scheduler', async (t) => {
  const scheduler = freshScheduler();
  t.after(() => delete require.cache[schedulerPath]);
  for (const [name, args] of [
    ['cron_list', {}], ['cron_run', { query: 'anything' }],
    ['cron_add', { name: 'anything', prompt: 'x', everyMs: 3600000 }],
  ]) {
    const result = await execTool(scheduler, name, args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'SCHEDULER_UNAVAILABLE', text(result));
  }
  const initialized = fixture(t);
  initialized.scheduler.shutdown();
  const stopped = await execTool(initialized.scheduler, 'cron_list', {});
  assert.equal(stopped.isError, true);
  assert.equal(stopped.structuredContent.code, 'SCHEDULER_UNAVAILABLE');
});

test('MCP overlap policies and schedule validation match the real scheduler without partial edits', async (t) => {
  const { scheduler, file } = fixture(t);
  const created = await ok(scheduler, 'cron_add', {
    name: 'policy fixture', prompt: 'no execution', cron: '0 9 * * *', tz: 'America/New_York', overlapPolicy: 'queueLatest',
  });
  const id = created.structuredContent.task.id;
  assert.equal(created.structuredContent.task.overlapPolicy, 'queueLatest');
  assert.equal(scheduler.get(id).overlapPolicy, 'queueLatest');
  await ok(scheduler, 'cron_update', { query: id, overlapPolicy: 'skip' });
  assert.equal(scheduler.get(id).overlapPolicy, 'skip');
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [
    { overlapPolicy: 'parallel' }, { tz: 'Not/A_Timezone' }, { cron: '99 9 * * *' },
  ]) {
    const result = await execTool(scheduler, 'cron_update', { query: id, name: 'must not persist', ...args });
    assert.equal(result.isError, true, text(result));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
