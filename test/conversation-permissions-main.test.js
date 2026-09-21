'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const permissions = require('../conversation-permissions');
const { InteractionBroker } = require('../interaction-broker');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function extract(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function fixture(t) {
  const makeWindow = () => ({ isDestroyed: () => false, webContents: { mainFrame: {}, send: (...args) => events.push(args) } });
  const events = [], controls = [], kills = [], records = new Map(), handlers = new Map(), liveSessions = new Map(), ledger = new Map(), jobs = new Map();
  const main = makeWindow(), mini = makeWindow(), orb = makeWindow(); let settings = { permissionMode: 'acceptEdits' };
  const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => broker.close());
  const context = { ...permissions, conversationPermissions: null, mainWindow: main,
    miniHost: { getOrbWindow: () => orb }, BrowserWindow: { getAllWindows: () => [main, mini, orb] },
    miniPanelCaller: event => event.sender === mini.webContents && event.senderFrame === mini.webContents.mainFrame,
    interactionBroker: broker, jobs, taskLedger: { get: id => ledger.get(id) }, liveSessions,
    readAppSettings: () => copy(settings), writeAppSettings: value => { settings = copy(value); },
    loadConversation: id => records.has(id) ? copy(records.get(id)) : null,
    persistConversationRecord: value => { if (context.failSave) throw Error('disk full'); records.set(value.id, copy(value)); },
    fs: { existsSync: id => records.has(id) }, convFilePath: id => id,
    withLiveControlTimeout: async promise => promise,
    killLiveSession: session => { kills.push(session.convId); session.dead = true; liveSessions.delete(session.convId); },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  };
  vm.createContext(context);
  vm.runInContext(extract('function getConversationPermissions()', 'function saveConversation('), context);
  vm.runInContext(extract('function permissionCaller(', "ipcMain.handle('settings:read'"), context);
  const call = (name, input, window = main, frame = window.webContents.mainFrame) => handlers.get('permissions:' + name)({ sender: window.webContents, senderFrame: frame }, input);
  const add = (id, options = {}) => {
    const record = { id, permissionMode: 'acceptEdits', permissionRevision: 1, permissionLegacyPlan: false,
      executionMode: { kind: 'default' }, updatedAt: '2020-01-01', pinned: true, turns: [] };
    records.set(id, record);
    const session = { convId: id, jobId: 'run-' + id, launchSpec: { cwd: process.cwd() }, dead: false, busy: !!options.busy, child: {
      async setPermissionMode(value) { controls.push([id, value]); if (options.control) await options.control(); },
      async prepareExecutionMode(value, input) { controls.push([id, value.kind]); return { executionMode: value, permissionMode: input.permissionMode }; },
    } };
    liveSessions.set(id, session); return session;
  };
  return { context, call, add, records, controls, kills, events, main, mini, orb, broker, liveSessions, jobs, ledger };
}

test('real permission IPC authenticates top-level main and mini, rejects orb and foreign frames', async t => {
  const h = fixture(t); h.add('a');
  assert.equal(h.call('get', 'a').permissionMode, 'acceptEdits');
  assert.equal(h.call('get', 'a', h.mini).ok, true);
  for (const [window, frame] of [[h.orb, h.orb.webContents.mainFrame], [h.main, {}], [h.mini, {}]]) {
    assert.equal(h.call('get', 'a', window, frame).code, 'FORBIDDEN');
    assert.equal((await h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' }, window, frame)).code, 'FORBIDDEN');
  }
  assert.equal(h.controls.length, 0);
});

test('real main runtime updates just the selected conversation and emits metadata after acknowledgement', async t => {
  const h = fixture(t); h.add('a', { busy: true }); h.add('b', { busy: true });
  const result = await h.call('set', { conversationId: 'a', permissionMode: 'default', expectedRevision: 1 }, h.mini);
  assert.equal(result.ok, true); assert.deepEqual(h.controls, [['a', 'default']]);
  assert.equal(h.records.get('b').permissionMode, 'acceptEdits'); assert.equal(h.records.get('a').updatedAt, '2020-01-01');
  assert.equal(h.events.length, 2); assert.equal(h.events[0][0], 'permissions:changed');
  assert.equal(h.events[0][1].conversationId, 'a'); assert.equal(Object.hasOwn(h.events[0][1], 'turns'), false);
});

test('permission change waits for cold startup before starting its short control deadline', async t => {
  let release; const startup = new Promise(resolve => { release = resolve; });
  const h = fixture(t), session = h.add('cold');
  session.child.whenReady = () => startup;
  let deadlines = 0;
  h.context.withLiveControlTimeout = async promise => { deadlines++; return promise; };
  const update = h.call('set', { conversationId: 'cold', permissionMode: 'default' });
  await new Promise(setImmediate);
  assert.equal(deadlines, 0); assert.equal(h.controls.length, 0);
  release(); assert.equal((await update).ok, true);
  assert.equal(deadlines, 1); assert.deepEqual(h.controls, [['cold', 'default']]);
});

test('a confirmed mode change releases only the selected active run pending tools and keeps questions', async t => {
  const h = fixture(t); h.add('a', { busy: true }); h.add('b', { busy: true });
  const answer = h.broker.registerToolUse({ toolName: 'Write', input: { file_path: 'fixture.txt' }, context: { conversationId: 'a', runId: 'run-a' } });
  const other = h.broker.registerToolUse({ toolName: 'Write', context: { conversationId: 'b', runId: 'run-b' } });
  const question = h.broker.registerToolUse({ toolName: 'AskUserQuestion', input: { questions: [{ header: 'Choice', multiSelect: false, question: 'choose', options: [{label:'one',description:''}, {label:'two',description:''}] }] }, context: { conversationId: 'a', runId: 'run-a' } });
  const result = await h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' });
  assert.equal(result.ok, true); assert.equal((await answer).behavior, 'allow'); assert.deepEqual(h.controls, [['a', 'bypassPermissions']]);
  assert.equal(h.broker.size, 2); assert.equal(h.kills.length, 0);
  h.broker.close(); assert.equal((await other).behavior, 'deny'); assert.equal((await question).behavior, 'deny');
});

test('a prompt arriving while mode ACK is pending waits for the confirmed commit', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = fixture(t); h.add('a', { busy: true, control: () => gate });
  const update = h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' });
  await new Promise(setImmediate);
  let completed = false;
  const answer = h.broker.registerToolUse({ toolName: 'Bash', input: { command: 'fixture' }, context: { conversationId: 'a', runId: 'run-a' } }).then(value => { completed = true; return value; });
  await new Promise(setImmediate); assert.equal(completed, false); assert.equal(h.records.get('a').permissionMode, 'acceptEdits');
  release(); assert.equal((await update).ok, true); assert.equal((await answer).behavior, 'allow'); assert.equal(h.broker.size, 0); assert.equal(h.kills.length, 0);
});

test('a one-shot task cannot report a changed permission it cannot apply, and stays running', async t => {
  const h = fixture(t); h.add('a'); h.liveSessions.delete('a');
  h.jobs.set('job', {}); h.ledger.set('job', { source: { conversationId: 'a' } });
  const result = await h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' });
  assert.equal(result.code, 'PERMISSION_RUNTIME_UNAVAILABLE'); assert.equal(h.records.get('a').permissionMode, 'acceptEdits');
  assert.equal(h.jobs.has('job'), true); assert.equal(h.kills.length, 0);
});

test('explicit execution mode changes cannot alter an active prompt or stop its current task', async t => {
  const h = fixture(t); h.add('a', { busy: true });
  const result = await h.call('set', { conversationId: 'a', permissionMode: 'acceptEdits', executionMode: { kind: 'plan' } });
  assert.equal(result.code, 'MODE_CHANGE_WHILE_RUNNING'); assert.equal(h.kills.length, 0); assert.equal(h.controls.length, 0);
  assert.equal(h.liveSessions.get('a').busy, true);
});

test('runtime replacement during a control acknowledgement cannot update metadata for the new process', async t => {
  let resolve; const gate = new Promise(yes => { resolve = yes; });
  const h = fixture(t); h.add('a', { control: () => gate });
  const update = h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' });
  await new Promise(setImmediate); const replacement = h.add('a'); resolve();
  assert.equal((await update).code, 'PERMISSION_RUNTIME_CHANGED');
  assert.equal(h.records.get('a').permissionMode, 'acceptEdits'); assert.equal(h.liveSessions.get('a'), replacement); assert.equal(h.kills.length, 0);
});

test('main restores the acknowledged SDK mode if persistence fails, preserving its pending request', async t => {
  const h = fixture(t); const sess = h.add('a', { busy: true }); h.context.failSave = true;
  const answer = h.broker.registerToolUse({ toolName: 'Write', input: { file_path: 'fixture.txt' }, context: { conversationId: 'a', runId: 'run-a' } });
  const result = await h.call('set', { conversationId: 'a', permissionMode: 'bypassPermissions' });
  assert.equal(result.ok, false); assert.match(result.error, /disk full/);
  assert.deepEqual(h.controls, [['a', 'bypassPermissions'], ['a', 'acceptEdits']]);
  assert.equal(h.broker.size, 1); assert.equal(h.kills.length, 0); assert.equal(sess.permissionMode, 'acceptEdits'); assert.equal(h.records.get('a').permissionMode, 'acceptEdits');
  h.broker.close(); assert.equal((await answer).behavior, 'deny');
});

test('a downgrade clears broader callback reconciliation before waiting for the SDK acknowledgement', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = fixture(t), sess = h.add('a', {busy:true,control:()=>gate});
  sess.permissionReconciliation = {conversationId:'a',runId:'run-a',revision:2,permissionMode:'bypassPermissions'};
  const update = h.call('set', {conversationId:'a',permissionMode:'default'}); await new Promise(setImmediate);
  assert.equal(sess.permissionReconciliation, null); release(); assert.equal((await update).ok, true);
  assert.equal(sess.permissionReconciliation.permissionMode, 'default');
});
