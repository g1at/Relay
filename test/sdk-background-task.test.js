'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { SdkSessionObserver, backgroundOwnedTask } = require('../sdk-session-observer');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8'), context);
const Activity = context.window.RelayActivity;
const tool = (id = 'tool', name = 'Bash') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const completed = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(operation = async () => true) {
  const calls = [], observer = new SdkSessionObserver(); observer.beginTurn(); observer.observe(tool());
  const session = { convId: 'conv', jobId: 'job', busy: true, observer, turnRouter: { toolIds: new Set(['tool']) },
    child: { backgroundTasks: async id => { calls.push(id); return operation(id); } } };
  const args = { session, convId: 'conv', jobId: 'job', toolUseId: 'tool', isCurrent: value => value === session };
  return { session, observer, args, calls };
}
test('foreground registry learns only parent Bash/Agent tools and native completion cannot be resurrected by replay', () => {
  const h = fixture();
  h.observer.observe(tool('read', 'Read')); h.observer.observe({ ...tool('child'), parent_tool_use_id: 'parent' });
  h.observer.observe(tool('agent', 'Agent'));
  assert.deepEqual([...h.observer.foregroundTools.keys()], ['tool', 'agent']);
  h.observer.observe(completed('tool')); h.observer.observe(tool());
  assert.equal(h.observer.foregroundTools.has('tool'), false);
  h.observer.observe({ type: 'system', subtype: 'task_started', task_id: 't', tool_use_id: 'agent', is_backgrounded: true });
  assert.equal(h.observer.foregroundTools.get('agent').isBackgrounded, true);
  h.observer.observe({ type: 'system', subtype: 'task_notification', task_id: 't', status: 'completed' });
  assert.equal(h.observer.foregroundTools.size, 0);
  h.observer.beginTurn(); h.observer.observe(tool());
  h.observer.observe({ type: 'conversation_reset', new_conversation_id: 'new' }); assert.equal(h.observer.foregroundTools.size, 0);
});
test('one exact tool is backgrounded once while SDK notifications remain authoritative', async () => {
  const gate = deferred(), h = fixture(() => gate.promise);
  const first = backgroundOwnedTask(h.args), repeat = backgroundOwnedTask(h.args);
  await Promise.resolve(); assert.deepEqual(h.calls, ['tool']);
  gate.resolve(true); assert.deepEqual(await first, { ok: true, requested: true }); assert.equal((await repeat).ok, true);
  assert.equal(h.observer.foregroundTools.get('tool').isBackgrounded, false, 'control receipt never fabricates a task event');
  assert.equal((await backgroundOwnedTask(h.args)).ok, true); assert.equal(h.calls.length, 1);
});
test('cross-conversation, stale run, missing ID, finished, Read and already background tasks cannot be sent', async () => {
  const h = fixture();
  for (const patch of [{ convId: 'other' }, { jobId: 'other' }, { toolUseId: undefined }, { toolUseId: 'unknown' }]) {
    assert.equal((await backgroundOwnedTask({ ...h.args, ...patch })).ok, false);
  }
  h.session.turnRouter.toolIds.clear(); assert.equal((await backgroundOwnedTask(h.args)).ok, false);
  h.session.turnRouter.toolIds.add('tool'); h.observer.foregroundTools.get('tool').toolName = 'Read';
  assert.equal((await backgroundOwnedTask(h.args)).ok, false);
  h.observer.foregroundTools.get('tool').toolName = 'Bash'; h.observer.foregroundTools.get('tool').isBackgrounded = true;
  assert.equal((await backgroundOwnedTask(h.args)).code, 'ALREADY_BACKGROUND');
  h.observer.observe(completed('tool')); assert.equal((await backgroundOwnedTask(h.args)).code, 'TASK_NOT_ACTIVE');
  assert.deepEqual(h.calls, []);
});
test('unsupported SDK, disabled background tasks and false responses are explicit failures', async () => {
  const absent = fixture(); delete absent.session.child.backgroundTasks;
  assert.equal((await backgroundOwnedTask(absent.args)).code, 'BACKGROUND_UNAVAILABLE');
  const disabled = fixture(async () => { throw Error('background tasks disabled'); });
  assert.match((await backgroundOwnedTask(disabled.args)).message, /disabled/);
  const missing = fixture(async () => false); assert.equal((await backgroundOwnedTask(missing.args)).code, 'NO_FOREGROUND_TASK');
});
test('late background acknowledgements cannot apply to a reset or replacement turn', async () => {
  for (const mutate of [h => h.observer.epoch++, h => h.session.jobId = 'next', h => h.session.dead = true]) {
    const gate = deferred(), h = fixture(() => gate.promise), pending = backgroundOwnedTask(h.args);
    await Promise.resolve(); mutate(h); gate.resolve(true); assert.equal((await pending).stale, true);
  }
});
test('a UI timeout keeps the real background control reserved to prevent duplicate requests', async () => {
  const gate = deferred(), h = fixture(() => gate.promise);
  const result = await backgroundOwnedTask({ ...h.args, timeoutMs: 5 }); assert.equal(result.pending, true);
  assert.equal((await backgroundOwnedTask(h.args)).pending, true); assert.equal(h.calls.length, 1);
  gate.resolve(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await backgroundOwnedTask(h.args)).ok, true); assert.equal(h.calls.length, 1);
});
test('a late rejection is stale after reset and cannot replace the new context error', async () => {
  let reject; const h = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = backgroundOwnedTask(h.args); await Promise.resolve(); h.observer.epoch++;
  reject(Error('old runtime closed')); assert.deepEqual(await pending, { ok: false, stale: true });
});

test('host and preload expose one owned background command and deny untrusted senders', async () => {
  const h = fixture(), handlers = new Map();
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const begin = main.indexOf("ipcMain.handle('claude:backgroundTask'");
  const end = main.indexOf('\nipcMain.handle(', begin + 1);
  vm.runInNewContext(main.slice(begin, end), { ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    backgroundOwnedTask, liveSessions: new Map([['conv', h.session]]), permissionCaller: event => event.trusted === true });
  const handler = handlers.get('claude:backgroundTask');
  assert.equal((await handler({}, h.args)).code, 'FORBIDDEN'); assert.equal(h.calls.length, 0);
  assert.equal((await handler({ trusted: true }, null)).code, 'TASK_NOT_ACTIVE');
  assert.equal((await handler({ trusted: true }, { convId: 'conv', jobId: 'wrong', toolUseId: 'tool' })).ok, false);
  const payload = { convId: 'conv', jobId: 'job', toolUseId: 'tool' };
  assert.equal((await handler({ trusted: true }, payload)).ok, true); assert.deepEqual(h.calls, ['tool']);
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'win32', argv: [] }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => calls.push(args), on() {}, removeListener() {} }, webUtils: {} }),
  });
  api.backgroundClaudeTask(payload); assert.deepEqual(calls, [['claude:backgroundTask', payload]]);
});
test('activity buttons are restricted to live foreground Bash/Agent and disappear on native background receipt', () => {
  for (const name of ['Bash', 'Agent', 'Task', 'Read', 'mcp__fixture__run']) {
    const state = Activity.createState(); Activity.ingest(state, tool('tool', name));
    assert.equal(Activity.renderItem(state.items[0], false).includes('process-task-background'), ['Bash', 'Agent', 'Task'].includes(name));
    Activity.ingest(state, { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'tool', is_backgrounded: true });
    assert.equal(Activity.renderItem(state.items[0], false).includes('process-task-background'), false);
    assert.equal(state.items[0].status, 'running');
  }
  const shell = Activity.createState(); Activity.ingest(shell, tool());
  Activity.ingest(shell, { ...completed('tool'), tool_use_result: { backgroundTaskId: 'shell-task', stdout: '' } });
  assert.equal(shell.items[0].isBackgrounded, true); assert.equal(shell.items[0].status, 'running');
  assert.equal(shell.items[0].taskId, 'shell-task');
  Activity.ingest(shell, { type: 'system', subtype: 'task_notification', task_id: 'shell-task', status: 'completed' });
  assert.equal(shell.items[0].status, 'success');
});
