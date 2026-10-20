'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, full, stream, result } = require('./renderer-activity-harness.cjs');

function viewHarness() {
  const h = harness('plain', { mounted: true }), c = h.context;
  const frames = [];
  const pages = Object.fromEntries(['chat', 'settings', 'library'].map(view => [view, {
    dataset: { appView: view }, classList: { toggle() {} }, querySelectorAll: () => [],
  }]));
  Object.assign(c, {
    activeView: 'chat', lastConversationView: 'chat', pageNavigationVersion: 0,
    pageScrollPositions: new WeakMap(), stickToBottom: false, chatWasFollowingOutput: false,
    projectComposer: null, appViewElements: () => pages,
    document: { querySelector: () => ({ dataset: {}, classList: { remove() {} } }) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    hideModelPopup() {}, hideSkillQuickPopup() {}, syncPageNavigation() {},
    emitConversationChanged() {}, scrollToBottom() {}, scheduleConversationIndexUpdate() {}, syncRunningUI() {},
    requestAnimationFrame: callback => frames.push(callback),
  });
  c.window.dispatchEvent = () => {};
  for (const name of ['isMountedChatJob', 'flushVisibleRunPresentation', 'showAppView', 'returnToConversationView']) h.loadFunction(name);
  return Object.assign(h, { frames,
    drainTimers() { for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); } },
    drainFrames() { while (frames.length) frames.shift()(); },
  });
}
const delta = text => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

test('covered chats ingest losslessly without projection; returning catches up once', () => {
  const h = viewHarness(), c = h.context;
  h.send(delta('before'));
  assert.equal(h.timers.size, 1);
  c.showAppView('library');
  h.drainTimers();
  for (let index = 0; index < 300; index++) h.send(delta(' hidden'));
  assert.equal(c.isMountedChatJob('job'), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.run.outputPresentationDirty, true);
  assert.equal(h.output.textFor(h.run.outputState.messages[0]), 'before' + ' hidden'.repeat(300));
  c.showAppView('chat'); h.drainFrames();
  assert.equal(h.updates.length, 1);
  assert.equal(h.run.outputPresentationDirty, false);
  assert.equal(h.run.activityState.items[0].result, 'before' + ' hidden'.repeat(300));
  c.flushVisibleRunPresentation();
  c.showAppView('settings'); c.showAppView('chat'); h.drainFrames();
  assert.equal(h.updates.length, 1, 'returning without new output does not rebuild the transcript');
});

test('complete assistant and message_stop bursts use the same bounded presentation timer', () => {
  const h = viewHarness();
  for (let index = 0; index < 90; index++) {
    h.send(full('frame-' + index, 'complete frame ' + index));
    h.send(stream({ type: 'message_stop' }));
  }
  assert.equal(h.run.outputState.messages.length, 90);
  assert.equal(h.timers.size, 1);
  assert.equal(h.updates.length, 0);
  h.drainTimers();
  assert.equal(h.updates.length, 1);
  assert.equal(h.run.activityState.items.length, 90);
  assert.deepEqual(h.rendered, [], 'complete SDK messages remain provisional');
  h.send(full('last', 'final evidence'));
  h.send(result('final evidence'));
  assert.equal(h.timers.size, 0, 'run result flushes before terminal persistence');
  assert.equal(h.updates.length, 2);
});

test('navigation callbacks never project a previous conversation into the newly selected chat', () => {
  const h = viewHarness(), c = h.context;
  c.showAppView('settings'); h.send(delta('A-only'));
  c.showAppView('chat');
  c.currentConv = { id: 'different', turns: [] };
  h.drainFrames();
  assert.equal(h.updates.length, 0);
  assert.equal(h.run.outputPresentationDirty, true);
  c.currentConv = h.conv; c.flushVisibleRunPresentation();
  assert.equal(h.updates.length, 1);
  assert.equal(h.run.activityState.items[0].result, 'A-only');
});

test('completion while covered saves the final answer and requests one history refresh on return', async () => {
  const h = viewHarness(), c = h.context, reloads = [];
  c.showAppView('library');
  h.send(full('answer', 'saved while hidden'));
  await c.finishRunUnsafe('job', { exitCode: 0, finalResult: result('saved while hidden') });
  assert.equal(h.persisted.turns[0].assistant, 'saved while hidden');
  assert.equal(h.updates.some(update => update.onView), false);
  assert.deepEqual(h.rendered, []);
  assert.equal(c.pendingConversationViewReloads.has('chat:conv'), true);
  c.loadConversation = async (...args) => { reloads.push(args); c.pendingConversationViewReloads.delete('chat:conv'); };
  c.returnToConversationView();
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0][0], 'conv'); assert.equal(reloads[0][2].forceReload, true);
});

test('leaving during asynchronous terminal save also preserves a return refresh', async () => {
  const h = viewHarness(), c = h.context;
  const originalLoad = c.window.api.history.load;
  let release;
  c.window.api.history.load = id => new Promise(resolve => { release = async () => resolve(await originalLoad(id)); });
  h.send(full('answer', 'before navigation'));
  const finishing = c.finishRunUnsafe('job', { exitCode: 0, finalResult: result('before navigation') });
  c.showAppView('settings'); await release(); await finishing;
  assert.equal(h.persisted.turns[0].assistant, 'before navigation');
  assert.equal(c.pendingConversationViewReloads.has('chat:conv'), true);
});

test('a hidden terminal save failure retains the answer and error in its selected chat', async () => {
  const h = viewHarness(), c = h.context;
  c.console = { ...console, error() {} };
  c.showAppView('settings');
  h.send(full('answer', 'unsaved answer remains available'));
  c.window.api.history.completeTurn = async () => { throw new Error('synthetic disk full'); };
  h.loadFunction('finishRun');
  await c.finishRun('job', { exitCode: 0, finalResult: result('unsaved answer remains available') });
  assert.equal(c.runs.size, 0); assert.equal(c.jobToConv.size, 0);
  assert.deepEqual(h.rendered, ['unsaved answer remains available']);
  assert.equal(h.notices.filter(notice => notice.role === 'error' && /synthetic disk full/.test(notice.text)).length, 1);
  assert.equal(c.pendingConversationViewReloads.has('chat:conv'), false, 'stale disk history cannot replace the unsaved answer');
  const rendered = h.rendered.length;
  c.returnToConversationView(); h.drainFrames();
  assert.equal(h.rendered.length, rendered, 'returning keeps the exceptional projection without duplicating it');
});

test('reselecting the same chat before its first return frame still catches up exactly once', () => {
  const h = viewHarness(), c = h.context;
  c.showAppView('library'); h.send(delta('pending on return'));
  c.showAppView('chat');
  c.showAppView('chat'); // A second navigation invalidates the first queued frame.
  h.drainFrames();
  assert.equal(h.updates.length, 1);
  assert.equal(h.run.outputPresentationDirty, false);
  assert.equal(h.run.activityState.items[0].result, 'pending on return');
});
