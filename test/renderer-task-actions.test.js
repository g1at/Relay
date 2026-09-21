'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { declaration, source } = require('./renderer-activity-harness.cjs');
const activityContext = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8'), activityContext);
const activity = activityContext.window.RelayActivity;
const output = require('../renderer/assistant-output');
const timeline = require('../renderer/supplement-timeline');
const clone = value => JSON.parse(JSON.stringify(value));
function node(dataset = {}) {
  const classes = new Set();
  return { dataset, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) }, isConnected: true, remove() { this.isConnected = false; } };
}
function harness() {
  const listeners = new Map(), runs = new Map(), calls = [], notices = [], created = [], updates = [];
  const context = vm.createContext({
    currentConv: { id: 'another-viewed-conversation' }, currentAssistantBubble: null,
    document: { addEventListener: (name, callback) => listeners.set(name, callback), createComment: () => node() },
    messagesEl: { append() {}, insertBefore() {} },
    window: {
      RelayActivity: { updateElement: (...args) => updates.push(args), syncTaskSummary() {} },
      RelayTaskContinuity: require('../renderer/task-continuity'), RelayAssistantOutput: output, RelaySupplementTimeline: timeline,
      relayWorkspacePanel: { openUrl: async url => { calls.push(['url', url]); } },
      api: {
        stopClaudeTask: async request => { calls.push(['stop', clone(request)]); return { ok: true }; },
        backgroundClaudeTask: async request => { calls.push(['background', clone(request)]); return { ok: true }; },
        openClaudeTaskResource: async request => { calls.push(['resource', clone(request)]); return { ok: true, kind: 'url', url: request.uri }; },
      },
    },
    navigator: { clipboard: { writeText: async text => { calls.push(['copy', text]); } } },
    appendActivityState(state) { const el = node({ conversationId: context.currentConv.id }); created.push(el); return el; },
    newActivityState: () => activity.createState(), scrollToBottom() {}, removeThinking() {},
    runForJob: id => runs.get(id), showToast: message => notices.push(message),
  });
  for (const name of ['taskSegmentForTurn', 'taskSummaryKeyForTurn', 'outputStateForRun', 'hasSupplementTimeline', 'renderSupplementTimeline', 'syncSubagentHistoryEntry', 'updateRunActivity']) {
    vm.runInContext(declaration(name), context, { filename: `app.js:${name}` });
  }
  const bindingStart = source.indexOf('// Activity actions retain');
  assert.ok(bindingStart > 0, 'actual application event bindings exist');
  const bindingEnd = source.indexOf('// Native branches preserve', bindingStart);
  vm.runInContext(source.slice(bindingStart, bindingEnd < 0 ? undefined : bindingEnd), context, { filename: 'app.js:task-actions' });
  function event(type, element, detail = { taskId: 'task-one', uri: 'https://example.com/result' }) {
    return listeners.get(`relay:task-${type}`)({ detail, target: { closest(selector) {
      assert.equal(selector, '[data-conversation-id][data-job-id]'); return element;
    } } });
  }
  return { context, calls, notices, created, updates, runs, event };
}
function run(overrides = {}) {
  return { convId: 'origin', jobId: 'origin-job', turn: { runId: 'origin-job' }, activityState: activity.createState(), ...overrides };
}

test('precreated live activity gains job identity after launch even without forced rerender', () => {
  const h = harness(), active = run({ activityEl: node({ conversationId: 'origin' }) });
  h.context.updateRunActivity(active, true);
  assert.deepEqual(active.activityEl.dataset, { conversationId: 'origin', jobId: 'origin-job' });
  assert.equal(h.created.length, 0);
  assert.equal(h.updates.length, 0, 'identity binding does not rebuild the activity tree');
});

test('both remounted and rebuilt live rows retain origin instead of the current conversation', () => {
  for (const connected of [true, false]) {
    const h = harness(), old = node({ conversationId: 'stale', jobId: 'stale-job' }); old.isConnected = connected;
    const active = run({ activityEl: old });
    h.context.updateRunActivity(active, true, true);
    assert.deepEqual(active.activityEl.dataset, { conversationId: 'origin', jobId: 'origin-job' });
    assert.equal(h.created.length, connected ? 0 : 1);
    assert.equal(h.updates.length, connected ? 1 : 0);
  }
});

test('off-view updates never create activity in a different conversation', () => {
  const h = harness(), active = run();
  h.context.updateRunActivity(active, false, true);
  assert.equal(active.activityEl, undefined); assert.equal(h.created.length, 0);
});

test('actual supplement timeline render binds historical run identity on each process segment', () => {
  const h = harness(), active = run({ jobId: null, turnIndex: 4 });
  active.outputState = output.createState();
  activity.ingest(active.activityState, { type: 'system', subtype: 'task_started', task_id: 'task-one', tool_use_id: 'call-one', description: 'Fixture' });
  h.context.renderSupplementTimeline(active, null, true);
  assert.ok(h.created.length > 0);
  for (const el of h.created) {
    assert.deepEqual(el.dataset, { conversationId: 'origin', jobId: 'origin-job', turn: '4' });
  }
});

test('stop action reaches only the active task owned by its row after navigation', async () => {
  const h = harness(), active = run({ activityEl: node() });
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  await h.event('stop', active.activityEl);
  assert.deepEqual(h.calls, [['stop', { convId: 'origin', jobId: 'origin-job', taskId: 'task-one' }]]);
  h.calls.length = 0;
  h.runs.set(active.jobId, run({ convId: 'mismatched' })); await h.event('stop', active.activityEl);
  h.runs.clear(); await h.event('stop', active.activityEl);
  await h.event('stop', node({ conversationId: 'origin' })); await h.event('stop', null);
  assert.deepEqual(h.calls, [], 'stale or unidentified rows cannot stop a different run');
});

test('historical resources keep original conversation and job without requiring a live query', async () => {
  const h = harness(), el = node({ conversationId: 'history-origin', jobId: 'history-job' });
  await h.event('resource', el);
  assert.deepEqual(h.calls, [
    ['resource', { convId: 'history-origin', jobId: 'history-job', taskId: 'task-one', uri: 'https://example.com/result' }],
    ['url', 'https://example.com/result'],
  ]);
  h.calls.length = 0;
  await h.event('resource', node({ conversationId: 'history-origin' })); await h.event('resource', null);
  assert.deepEqual(h.calls, []);
});

test('task IPC and clipboard failures are handled without unhandled rejection or unintended opening', async () => {
  const h = harness(), active = run({ activityEl: node() });
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  h.context.window.api.stopClaudeTask = async () => { throw Error('stop fixture failure'); };
  h.context.window.api.openClaudeTaskResource = async () => { throw Error('resource fixture failure'); };
  await assert.doesNotReject(h.event('stop', active.activityEl));
  await assert.doesNotReject(h.event('resource', active.activityEl));
  h.context.window.api.openClaudeTaskResource = async () => ({ ok: true, kind: 'resource', uri: 'mcp://fixture/result' });
  h.context.navigator.clipboard.writeText = async () => { throw Error('clipboard fixture failure'); };
  await assert.doesNotReject(h.event('resource', active.activityEl));
  assert.deepEqual(h.notices, ['stop fixture failure', 'resource fixture failure', 'clipboard fixture failure']);
  assert.deepEqual(h.calls, []);
});

test('host-denied resources never reach the browser or clipboard and stale stops stay quiet', async () => {
  const h = harness(), active = run({ activityEl: node() });
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  h.context.window.api.openClaudeTaskResource = async () => ({ ok: false, message: 'resource not registered' });
  await h.event('resource', active.activityEl);
  assert.deepEqual(h.notices, ['resource not registered']); assert.deepEqual(h.calls, []);
  h.context.window.api.stopClaudeTask = async () => ({ ok: false, stale: true });
  await h.event('stop', active.activityEl);
  assert.equal(h.notices.length, 1);
});

test('background action keeps the row conversation and tool identity and rejects stale rows', async () => {
  const h = harness(), active = run({ activityEl: node() });
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  await h.event('background', active.activityEl, { toolUseId: 'foreground-bash' });
  assert.deepEqual(h.calls, [['background', { convId: 'origin', jobId: 'origin-job', toolUseId: 'foreground-bash' }]]);
  h.calls.length = 0;
  await h.event('background', active.activityEl, {});
  h.runs.set(active.jobId, run({ convId: 'wrong-origin' })); await h.event('background', active.activityEl, { toolUseId: 'foreground-bash' });
  h.runs.clear(); await h.event('background', active.activityEl, { toolUseId: 'foreground-bash' });
  assert.deepEqual(h.calls, []);
});

test('background pending and unsupported receipts are visible without simulating execution state', async () => {
  const h = harness(), active = run({ activityEl: node() });
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  for (const result of [{ ok: false, pending: true, message: 'native request pending' }, { ok: false, message: 'not supported' }]) {
    h.context.window.api.backgroundClaudeTask = async () => result;
    await h.event('background', active.activityEl, { toolUseId: 'foreground-bash' });
  }
  assert.deepEqual(h.notices, ['native request pending', 'not supported']); assert.equal(h.updates.length, 0);
  h.context.window.api.backgroundClaudeTask = async () => { throw Error('transport closed'); };
  await assert.doesNotReject(h.event('background', active.activityEl, { toolUseId: 'foreground-bash' }));
  assert.equal(h.notices.at(-1), 'transport closed');
});

test('late background receipts do not notify a replacement run', async () => {
  const h = harness(), active = run({ activityEl: node() }); let release;
  h.runs.set(active.jobId, active); h.context.updateRunActivity(active, true);
  h.context.window.api.backgroundClaudeTask = () => new Promise(resolve => { release = resolve; });
  const pending = h.event('background', active.activityEl, { toolUseId: 'foreground-bash' });
  h.runs.set(active.jobId, run()); release({ ok: false, message: 'old request rejected' }); await pending;
  assert.deepEqual(h.notices, []);
});
